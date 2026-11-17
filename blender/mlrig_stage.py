"""The two Blender halves of the ML rig pack's LOW-MEMORY STAGED MODE (server/rigMlStaged.ts runs them around the model):

  mode "decimate"   the model's input: a decimated copy ("proxy") of the mesh, static geometry only (no skin, no materials)
      params: { "mode": "decimate", "input": "<model>", "output": "<proxy.glb>", "targetFaces": 30000 }
      VTP_OK  { "output", "facesBefore", "facesAfter", "meshes" }

  mode "transfer"   after the model rigged the proxy: copy its skin weights onto the FULL-resolution mesh
      params: { "mode": "transfer", "full": "<the original model>", "rigged": "<the model's rigged proxy .glb>", "output": "<rigged full .glb>" }
      Every vertex of the full mesh gets the weights of the nearest point on the proxy's surface (barycentric blend of the triangle's
      three corners), the strongest 4 bones kept and renormalised to 1 (blender/weight_transfer.py). The armature comes from the rigged
      file; if the model returned the proxy at another scale / position it is brought onto the full mesh by bounding box first.
      VTP_OK  { "output", "bones", "vertices", "filledFromNearestVertex", "scale", "aligned" }

Data API only (bpy.data, mathutils); the only operators are the glTF importer / exporter. Target: Blender 5.1, Python 3.13.
1 Blender unit = 1 metre; the decimate target is a face count, so no length constants here.
UNVERIFIED on real model output: tested on a synthetic figure only (blender/test_mlrig_stage_blender.py); no model is run here.
"""
import os
import sys

import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402

# Target: Blender 5.1, Python 3.13
assert bpy.app.version[:2] == (5, 1), f"built for Blender 5.1, running {bpy.app.version_string}"
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402
import weight_transfer as wt  # noqa: E402

MIN_RATIO = 0.001           # never ask the decimator for less than 0.1 % of a mesh
ALIGN_TOLERANCE = 1.0e-3    # relative bounding-box difference above which the rigged proxy is moved onto the full mesh
MAX_INFLUENCES = wt.MAX_INFLUENCES


def tri_count(mesh):
    return sum(max(0, len(p.vertices) - 2) for p in mesh.polygons)


# ---------------------------------------------------------------- decimate

def decimate(p):
    common.reset_scene()
    common.import_model(p["input"])
    meshes = common.mesh_objects()
    if not meshes:
        raise RuntimeError("The file has no mesh to rig.")
    target = max(1, int(p["targetFaces"]))
    before = sum(tri_count(o.data) for o in meshes)
    ratio = min(1.0, max(MIN_RATIO, target / max(1, before)))
    for o in meshes:
        for m in list(o.modifiers):
            if m.type == "ARMATURE":                      # an old skin would pose the copy: the model needs the rest shape
                o.modifiers.remove(m)
        if ratio < 1.0:
            d = o.modifiers.new("Proxy", "DECIMATE")
            d.decimate_type = "COLLAPSE"
            d.ratio = ratio
    dg = bpy.context.evaluated_depsgraph_get()
    out_objs, after = [], 0
    coll = bpy.context.scene.collection
    for o in meshes:
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
        me.materials.clear()
        no = bpy.data.objects.new(o.name + "_proxy", me)
        no.matrix_world = o.matrix_world.copy()
        coll.objects.link(no)
        out_objs.append(no)
        after += tri_count(me)
    for o in meshes:
        bpy.data.objects.remove(o, do_unlink=True)
    for o in list(bpy.context.scene.objects):
        if o not in out_objs:
            bpy.data.objects.remove(o, do_unlink=True)       # empties / armatures of an old rig: the proxy is geometry only
    for o in bpy.context.scene.objects:
        o.select_set(o in out_objs)
    common.export_glb(p["output"], selected_only=True)
    if after < 1:
        raise RuntimeError("The smaller copy came out empty.")
    return {"output": p["output"], "facesBefore": before, "facesAfter": after, "meshes": len(out_objs)}


# ---------------------------------------------------------------- transfer

def _world_bbox(objs):
    lo = Vector((float("inf"),) * 3)
    hi = Vector((float("-inf"),) * 3)
    for o in objs:
        mw = o.matrix_world
        for v in o.data.vertices:
            c = mw @ v.co
            lo.x, lo.y, lo.z = min(lo.x, c.x), min(lo.y, c.y), min(lo.z, c.z)
            hi.x, hi.y, hi.z = max(hi.x, c.x), max(hi.y, c.y), max(hi.z, c.z)
    return lo, hi


def _roots(objs):
    s = set(objs)
    return [o for o in objs if o.parent is None or o.parent not in s]


def transfer(p):
    common.reset_scene()
    full_new = common.import_model(p["full"])
    full_meshes = [o for o in full_new if o.type == "MESH"]
    if not full_meshes:
        raise RuntimeError("The original file has no mesh.")
    for o in full_meshes:                                   # an old skin would fight the new one
        for m in list(o.modifiers):
            if m.type == "ARMATURE":
                o.modifiers.remove(m)
        o.vertex_groups.clear()
    n_before = {o.name: len(o.data.vertices) for o in full_meshes}
    rig_new = common.import_model(p["rigged"])
    arms = [o for o in rig_new if o.type == "ARMATURE"]
    proxies = [o for o in rig_new if o.type == "MESH"]
    if not arms:
        raise RuntimeError("The model returned no skeleton.")
    if not proxies:
        raise RuntimeError("The model returned no mesh.")
    arm = max(arms, key=lambda a: len(a.data.bones))
    bpy.context.view_layer.update()
    # ---- bring the rigged copy onto the full mesh if the model changed its size or position
    flo, fhi = _world_bbox(full_meshes)
    plo, phi = _world_bbox(proxies)
    fext, pext = max(fhi - flo), max(phi - plo)
    scale, aligned = 1.0, False
    diff = max(abs(fext - pext) / max(fext, 1e-9), ((flo + fhi) / 2 - (plo + phi) / 2).length / max(fext, 1e-9))
    if diff > ALIGN_TOLERANCE:
        scale = fext / max(pext, 1e-9)
        c_p, c_f = (plo + phi) / 2, (flo + fhi) / 2
        for r in _roots(rig_new):
            r.matrix_world = _align_matrix(scale, c_p, c_f) @ r.matrix_world
        bpy.context.view_layer.update()
        aligned = True
    # ---- the proxy's geometry and sparse weights, in world space
    bones = {b.name for b in arm.data.bones}
    pverts, ptris, pweights = [], [], []
    for o in proxies:
        mw, base = o.matrix_world, len(pverts)
        names = {i: g.name for i, g in enumerate(o.vertex_groups)}
        for v in o.data.vertices:
            pverts.append(tuple(mw @ v.co))
            pweights.append({names[g.group]: g.weight for g in v.groups if names.get(g.group) in bones and g.weight > 0})
        o.data.calc_loop_triangles()
        ptris += [tuple(base + i for i in t.vertices) for t in o.data.loop_triangles]
    if not ptris:
        raise RuntimeError("The model's mesh has no faces.")
    bvh = BVHTree.FromPolygons([Vector(v) for v in pverts], ptris)

    def locate(pt):
        loc, _n, idx, _d = bvh.find_nearest(Vector(pt))
        if idx is None:
            raise RuntimeError("Could not find the nearest surface point on the model's mesh.")
        a, b, c = (pverts[i] for i in ptris[idx])
        return idx, wt.barycentric(pt, a, b, c)

    keep = list(full_meshes) + [arm]
    filled = 0
    n_vertices = 0
    for o in full_meshes:
        mw = o.matrix_world.copy()
        pts = [tuple(mw @ v.co) for v in o.data.vertices]
        w, st = wt.transfer_weights(pts, locate, ptris, pweights, pverts, MAX_INFLUENCES)
        wt.check(w, MAX_INFLUENCES)
        filled += st["filled_from_nearest_vertex"]
        n_vertices += len(pts)
        groups = {}
        for i, wi in enumerate(w):
            for bone, x in wi.items():
                vg = groups.get(bone) or groups.setdefault(bone, o.vertex_groups.new(name=bone))
                vg.add([i], x, "REPLACE")
        m = o.modifiers.new("Armature", "ARMATURE")
        m.object = arm
        o.parent = None
        o.matrix_world = mw                                  # (keep the world position after un-parenting)
        o.parent = arm
        o.matrix_parent_inverse = arm.matrix_world.inverted()
    for o in proxies:
        bpy.data.objects.remove(o, do_unlink=True)
    # ---- census (open, skinned meshes: scale, loose verts, counts - not manifold checks)
    for o in full_meshes:
        assert len(o.data.vertices) == n_before[o.name], f"{o.name}: vertex count changed"
        assert o.data.vertices, "empty mesh"
    for o in bpy.context.scene.objects:
        o.select_set(o in keep)
    common.export_glb(p["output"], selected_only=True)
    return {"output": p["output"], "bones": sorted(bones), "vertices": n_vertices, "filledFromNearestVertex": filled, "scale": round(scale, 6), "aligned": aligned}


def _align_matrix(scale, c_from, c_to):
    from mathutils import Matrix
    return Matrix.Translation(c_to) @ Matrix.Scale(scale, 4) @ Matrix.Translation(-c_from)


def main(p):
    mode = p.get("mode")
    if mode == "decimate":
        return decimate(p)
    if mode == "transfer":
        return transfer(p)
    raise RuntimeError(f"unknown mode {mode!r}")


if __name__ == "__main__":
    common.run_main(main)
