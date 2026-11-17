"""Headless Blender check of blender/mlrig_stage.py (the low-memory staged mode's two Blender halves) on a synthetic figure.
No model is run, nothing is downloaded:

    tools\\blender_low.cmd --background --factory-startup -noaudio --python-exit-code 1 ^
        --python <abs>\\blender\\test_mlrig_stage_blender.py -- --out <abs scratch dir>

1. build a "T figure" (torso + two arms, three separate tubes, 864 triangles) and save it as the FULL model;
2. `decimate` it to a proxy of about 220 triangles;
3. stand in for the ML model: put a 3-bone skeleton (spine, armL, armR) into the proxy with a hand-made skin (the arm bone ramps from 0 at
   the shoulder to 1 at the hand) AND scale the result 2x and move it, as a model might return it;
4. `transfer` the weights onto the full mesh;
5. re-import the result and check: same vertex count and positions as the full model, every vertex weighted, sums to 1, at most 4 bones,
   the left arm never uses the right arm's bone, hand tips are the arm bone, the torso is the spine bone, the proxy was brought back onto the mesh.
Prints `STAGE_TEST_OK <json>`; anything wrong raises (exit code 1).
"""
import json
import math
import os
import sys

import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

# Target: Blender 5.1, Python 3.13
assert bpy.app.version[:2] == (5, 1), f"built for Blender 5.1, running {bpy.app.version_string}"
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common  # noqa: E402
import mlrig_stage  # noqa: E402

# parameter block (1 Blender unit = 1 metre)
RINGS, SIDES = 13, 12
TORSO = dict(origin=(0.0, 0.0, 0.0), axis="z", length=1.0, radius=0.18)
ARM_L = dict(origin=(0.3, 0.0, 0.8), axis="x", length=0.8, radius=0.06)
ARM_R = dict(origin=(-0.3, 0.0, 0.8), axis="-x", length=0.8, radius=0.06)
PROXY_FACES = 220
MODEL_SCALE = 2.0                 # the stand-in model hands the proxy back at twice the size ...
MODEL_SHIFT = (0.5, 0.25, 0.1)    # ... and somewhere else
POS_TOL = 1.0e-4
TIP_T, ROOT_T = 0.95, 0.05


def tube(origin, axis, length, radius, rings, sides):
    verts = []
    for r in range(rings):
        t = r / (rings - 1)
        for s in range(sides):
            a = 2 * math.pi * s / sides
            u, v = radius * math.cos(a), radius * math.sin(a)
            if axis == "x":
                verts.append((origin[0] + t * length, origin[1] + u, origin[2] + v))
            elif axis == "-x":
                verts.append((origin[0] - t * length, origin[1] + u, origin[2] + v))
            else:
                verts.append((origin[0] + u, origin[1] + v, origin[2] + t * length))
    faces = []
    for r in range(rings - 1):
        for s in range(sides):
            a, b = r * sides + s, r * sides + (s + 1) % sides
            c, d = (r + 1) * sides + s, (r + 1) * sides + (s + 1) % sides
            faces += [(a, b, d), (a, d, c)]
    return verts, faces


def build_full(path):
    common.reset_scene()
    verts, faces = [], []
    for kw in (TORSO, ARM_L, ARM_R):
        v, f = tube(rings=RINGS, sides=SIDES, **kw)
        base = len(verts)
        verts += v
        faces += [tuple(base + i for i in t) for t in f]
    me = bpy.data.meshes.new("Figure")
    me.from_pydata(verts, [], faces)
    me.update()
    ob = bpy.data.objects.new("Figure", me)
    bpy.context.scene.collection.objects.link(ob)
    for o in bpy.context.scene.objects:
        o.select_set(o is ob)
    common.export_glb(path, selected_only=True)
    return len(faces)


def limb_and_t(co):
    """Which limb a point belongs to and how far along it (0 shoulder .. 1 hand), from its position alone."""
    x = co[0]
    if x > 0.25:
        return "armL", min(1.0, max(0.0, (x - 0.3) / 0.8))
    if x < -0.25:
        return "armR", min(1.0, max(0.0, (-0.3 - x) / 0.8))
    return "spine", 0.0


def fake_model_output(proxy_path, out_path):
    """Skeleton + hand-made skin on the proxy, handed back scaled and moved: what a model's merged output might look like."""
    common.reset_scene()
    new = common.import_model(proxy_path)
    ob = next(o for o in new if o.type == "MESH")
    arm_data = bpy.data.armatures.new("Rig")
    arm = bpy.data.objects.new("Rig", arm_data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    for name, head, tail in (("spine", (0, 0, 0), (0, 0, 1)), ("armL", (0.3, 0, 0.8), (1.1, 0, 0.8)), ("armR", (-0.3, 0, 0.8), (-1.1, 0, 0.8))):
        b = arm_data.edit_bones.new(name)
        b.head, b.tail = head, tail
    bpy.ops.object.mode_set(mode="OBJECT")
    for n in ("spine", "armL", "armR"):
        ob.vertex_groups.new(name=n)
    for v in ob.data.vertices:
        limb, t = limb_and_t(v.co)
        if limb == "spine":
            ob.vertex_groups["spine"].add([v.index], 1.0, "REPLACE")
        else:
            ob.vertex_groups[limb].add([v.index], max(t, 1e-3), "REPLACE")
            ob.vertex_groups["spine"].add([v.index], max(1.0 - t, 1e-3), "REPLACE")
    m = ob.modifiers.new("Armature", "ARMATURE")
    m.object = arm
    ob.parent = arm
    arm.scale = (MODEL_SCALE,) * 3
    arm.location = MODEL_SHIFT
    bpy.context.view_layer.update()
    for o in bpy.context.scene.objects:
        o.select_set(o in (ob, arm))
    common.export_glb(out_path, selected_only=True)


def main(out):
    full, proxy, rigged, result = (os.path.join(out, n) for n in ("full.glb", "proxy.glb", "rigged_proxy.glb", "rigged_full.glb"))
    tris = build_full(full)
    d = mlrig_stage.decimate({"input": full, "output": proxy, "targetFaces": PROXY_FACES})
    assert d["facesBefore"] == tris, d
    assert PROXY_FACES * 0.5 <= d["facesAfter"] <= PROXY_FACES * 1.6, f"proxy has {d['facesAfter']} faces for a target of {PROXY_FACES}"
    assert d["facesAfter"] < tris
    fake_model_output(proxy, rigged)
    t = mlrig_stage.transfer({"full": full, "rigged": rigged, "output": result})
    assert t["aligned"] and abs(t["scale"] - 1.0 / MODEL_SCALE) < 0.01, f"the 2x proxy should be scaled back by 0.5: {t}"
    # ---- re-import and census (against the full model as the importer sees it: the glTF round trip may split vertices, that is not ours)
    common.reset_scene()
    ref_obj = next(o for o in common.import_model(full) if o.type == "MESH")
    want = [tuple(ref_obj.matrix_world @ v.co) for v in ref_obj.data.vertices]
    common.reset_scene()
    new = common.import_model(result)
    meshes = [o for o in new if o.type == "MESH"]
    arms = [o for o in new if o.type == "ARMATURE"]
    assert len(meshes) == 1 and len(arms) == 1, (len(meshes), len(arms))
    o = meshes[0]
    assert {b.name for b in arms[0].data.bones} == {"spine", "armL", "armR"}
    assert len(o.data.vertices) == len(want), f"vertex count changed: {len(o.data.vertices)} vs {len(want)}"
    mw = o.matrix_world
    worst = max((mw @ v.co - Vector(w)).length for v, w in zip(o.data.vertices, want))
    assert worst < POS_TOL, f"geometry moved by {worst}"
    names = {i: g.name for i, g in enumerate(o.vertex_groups)}
    bad_sum = bad_n = left_on_right = right_on_left = 0
    tip_ok = root_ok = spine_ok = 0
    tips = roots = spines = 0
    for v in o.data.vertices:
        w = {names[g.group]: g.weight for g in v.groups if g.weight > 0}
        if abs(sum(w.values()) - 1.0) > 1e-3:
            bad_sum += 1
        if not w or len(w) > 4:
            bad_n += 1
        limb, tt = limb_and_t(want[v.index])
        if limb == "armR" and w.get("armL", 0) > 1e-4:
            left_on_right += 1
        if limb == "armL" and w.get("armR", 0) > 1e-4:
            right_on_left += 1
        if limb == "armL" and tt > TIP_T:
            tips += 1
            tip_ok += w.get("armL", 0) > 0.8
        if limb == "armR" and tt < ROOT_T:
            roots += 1
            root_ok += w.get("spine", 0) > 0.85
        if limb == "spine":
            spines += 1
            spine_ok += set(w) == {"spine"}
    assert bad_sum == 0, f"{bad_sum} vertices whose weights do not sum to 1"
    assert bad_n == 0, f"{bad_n} vertices unweighted or with more than 4 bones"
    assert left_on_right == 0 and right_on_left == 0, "an arm's weights leaked onto the other arm"
    assert tips and tip_ok == tips, f"hand tips: {tip_ok}/{tips}"
    assert roots and root_ok == roots, f"shoulder ends: {root_ok}/{roots}"
    assert spines and spine_ok == spines, f"torso: {spine_ok}/{spines}"
    print("STAGE_TEST_OK " + json.dumps({"facesBefore": d["facesBefore"], "facesAfter": d["facesAfter"], "transfer": t, "tips": tips, "roots": roots, "torso": spines}))


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out = os.path.abspath(argv[argv.index("--out") + 1]) if "--out" in argv else None
    assert out, "give --out <absolute scratch folder>"
    os.makedirs(out, exist_ok=True)
    main(out)
