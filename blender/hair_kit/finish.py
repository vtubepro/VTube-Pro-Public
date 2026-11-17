"""
hair_kit.finish — texture atlas painter, materials, scalp under-shell, clean toon normals, spring chains, LODs, export.

  paint_atlas(mesh, atlas, pal)      per-lock painted strip (numpy): flat base tone per layer + small per-lock tone
                                     jitter, root->tip gradient (darker roots, warmer lighter tips), soft edge
                                     darkening across the lock (reads as separation without stripes), 1-2 tapered
                                     strand lines (few, never full length), optional painted angel-ring segment
  hair_material(...)                 Principled, texture, culled shells (glTF doubleSided false), extras vtpShadeShift
  scalp_shell(head, body_obj, ...)   head skin under the hairline offset 2.5 mm, painted the under-layer colour: no
                                     skin ever shows between locks at the roots
  proxy_normals(objs, ...)           inflate -> voxel remesh -> smooth -> Data Transfer custom normals: one clean
                                     cel terminator over the whole hairdo (no per-lock noise)
  chains(...)                        spring chains: locks grouped by root azimuth -> bone chains along the group's
                                     mean guide, parented to the head bone, smooth weights along hair_t
"""
from __future__ import annotations

import math
import os

import numpy as np

from .core import unit, smoothstep, resample


def hexc(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)], np.float32)


DEFAULT_PAL = {
    'under': '#361a0e', 'mid': '#4a2515', 'top': '#5a2f1a', 'front': '#552c18', 'fly': '#5e321c',
    'root_k': 0.78, 'tip': '#7a4428', 'line_k': 0.45, 'edge_k': 0.68, 'scalp': '#27120a',
    'ring': '#9c6440', 'sheen': '#a86a44',     # painted highlight band on the outer layers (None = rely on the studio shader ring)
    'ring_layers': ('top', 'front', 'mid'),
}


def paint_atlas(mesh, atlas, pal=None, seed=3, lines=(1, 2), path=None, head=None):
    pal = dict(DEFAULT_PAL, **(pal or {}))
    rng = np.random.default_rng(seed)
    S = atlas.size
    sw, sh = S // atlas.cols, S // atlas.rows
    img = np.zeros((S, S, 3), np.float32)
    img[:] = hexc(pal['scalp'])
    yy = (np.arange(sh) + 0.5) / sh
    xx = (np.arange(sw) + 0.5) / sw
    X, Y = np.meshgrid(xx, yy)                     # X across the strip, Y top->bottom of the strip
    # strip coordinates -> (u, t) (inverse of Atlas.uv inset)
    U = np.clip((X - 0.08) / 0.84, 0, 1)
    T = np.clip((Y - 0.015) / 0.97, 0, 1)
    for r in mesh['recs']:
        slot = r['slot']
        c, row = slot % atlas.cols, slot // atlas.cols
        base = hexc(pal.get(r['layer'], pal['mid'])) * (1 + 0.05 * float(r.get('tone', 0)) + rng.normal(0, 0.035))
        col = np.broadcast_to(base, (sh, sw, 3)).copy()
        # root -> tip
        g = pal['root_k'] + (1 - pal['root_k']) * smoothstep(0.0, 0.28, T)
        col *= g[..., None]
        tipc = hexc(pal['tip'])
        col = col + (tipc - col) * (0.45 * smoothstep(0.72, 1.0, T))[..., None]
        # soft edge darkening across the lock
        e = np.abs(2 * U - 1)
        col *= (1 - (1 - pal['edge_k']) * smoothstep(0.55, 1.0, e))[..., None]
        # strand lines: few, tapered, not full length
        nl = rng.integers(lines[0], lines[1] + 1) if r['layer'] != 'fly' else 0
        for _ in range(nl):
            u0 = rng.uniform(0.28, 0.72); ta = rng.uniform(0.08, 0.35); tb = rng.uniform(0.55, 0.9)
            amp = rng.uniform(0.0, 0.06); ph = rng.uniform(0, 6.28)
            uc = u0 + amp * np.sin(ph + T * 5.0)
            w = (0.035 + 0.02 * rng.random()) * np.sin(np.pi * np.clip((T - ta) / (tb - ta), 0, 1)) ** 0.7
            d = np.abs(U - uc)
            px = 1.0 / (0.84 * sw)
            a = np.clip((w - d) / px + 0.5, 0, 1) * ((T > ta) & (T < tb))
            col = col * (1 - a[..., None] * (1 - pal['line_k']))
        # light strand highlights: 1-2 thin tapered LIGHT streaks on the lit middle of the lock (key-art sheen)
        if r['layer'] in ('top', 'mid', 'front'):
            for _ in range(rng.integers(1, 3)):
                u0 = rng.uniform(0.3, 0.7); ta = rng.uniform(0.25, 0.45); tb = ta + rng.uniform(0.2, 0.35)
                w = 0.05 * np.sin(np.pi * np.clip((T - ta) / (tb - ta), 0, 1)) ** 0.8
                px = 1.0 / (0.84 * sw)
                a = np.clip((w - np.abs(U - u0)) / px + 0.5, 0, 1) * ((T > ta) & (T < tb))
                col = col + (hexc(pal['sheen']) - col) * (0.7 * a)[..., None]
        if pal.get('ring') and r['layer'] in pal['ring_layers'] and 'ring_t' in r:
            # a highlight band across the lock with a jagged strand-tip lower edge (anime key-art 'tenshi no wa'),
            # at the same WORLD height on every lock so the bands line up into one ring
            t0, t1 = r['ring_t']; t1 += rng.uniform(-0.004, 0.006)
            zig = (t1 - t0) * 0.6 * np.abs(((U * rng.uniform(3, 5)) % 1.0) - 0.5) * 2
            a = smoothstep(t0 - 0.006, t0 + 0.006, T) * (1 - smoothstep(t1 - zig - 0.005, t1 - zig + 0.005, T))
            a *= 1 - smoothstep(0.7, 0.95, np.abs(2 * U - 1))
            col = col + (hexc(pal['ring']) - col) * (0.85 * a)[..., None]
        y0 = row * sh
        img[y0:y0 + sh, c * sw:(c + 1) * sw] = np.clip(col, 0, 1)
    if path:
        save_png(img, path)
    return img


def save_png(img, path):
    import bpy
    H, W = img.shape[:2]
    im = bpy.data.images.new(os.path.basename(path), W, H, alpha=True)
    px = np.ones((H, W, 4), np.float32); px[..., :3] = img
    im.pixels.foreach_set(px[::-1].ravel())
    im.filepath_raw = path; im.file_format = 'PNG'
    im.save()
    return im


def hair_material(name, tex_path, shade_shift=-0.1, double_sided=False, rough=0.85):
    import bpy
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = bpy.data.images.load(tex_path, check_existing=True)
    nt.links.new(tex.outputs['Color'], b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = 0.0
    m.use_backface_culling = not double_sided
    m['vtpShadeShift'] = float(shade_shift)
    return m


def scalp_shell(head, body_obj, slot_uv, offset=0.0025, hairline=None, margin_deg=-4.0):
    """Head skin triangles above the hairline, offset outward -> an under-shell mesh (numpy dict like locks)."""
    import bpy
    from .core import hairline_ph
    hl = hairline or hairline_ph
    dg = bpy.context.evaluated_depsgraph_get()
    ev = body_obj.evaluated_get(dg); me = ev.to_mesh(); me.calc_loop_triangles()
    M = np.array(body_obj.matrix_world)
    P = np.zeros(len(me.vertices) * 3); me.vertices.foreach_get('co', P); P = P.reshape(-1, 3) @ M[:3, :3].T + M[:3, 3]
    Nv = np.zeros(len(me.vertices) * 3); me.vertices.foreach_get('normal', Nv); Nv = unit(Nv.reshape(-1, 3) @ M[:3, :3].T)
    T = np.zeros(len(me.loop_triangles) * 3, np.int64); me.loop_triangles.foreach_get('vertices', T); T = T.reshape(-1, 3)
    ev.to_mesh_clear()
    c = P[T].mean(1)
    th, ph = head.angles(c)
    near = np.linalg.norm((c - head.c) / head.r, axis=1) < 1.35
    sel = near & (ph > hl(th) - margin_deg) & (c[:, 2] > head.chin_z)
    Ts = T[sel]
    used, inv = np.unique(Ts, return_inverse=True)
    # offset along the direction AWAY from the head centre (the source mesh's normals / winding may be inconsistent)
    radial = unit(P[used] - head.c)
    Nf = np.where(((Nv[used] * radial).sum(1) < 0)[:, None], -Nv[used], Nv[used])
    V = P[used] + unit(Nf + radial * 0.5) * offset
    Fi = inv.reshape(-1, 3)
    fn = np.cross(V[Fi[:, 1]] - V[Fi[:, 0]], V[Fi[:, 2]] - V[Fi[:, 0]])
    flip = (fn * (V[Fi].mean(1) - head.c)).sum(1) < 0
    Fi[flip] = Fi[flip][:, ::-1]
    F = [tuple(f) for f in Fi]
    # a real (small) planar UV inside the scalp slot: glTF tangents need non-degenerate UVs
    th_v, ph_v = head.angles(V)
    u0, v0 = slot_uv
    UV = np.stack([u0 + (th_v / 180.0) * 0.004, v0 + (ph_v / 90.0) * 0.08], 1)
    return {'V': V, 'F': F, 'UV': UV, 't': np.zeros(len(V)), 'lock': np.full(len(V), -999), 'layer': np.zeros(len(V)), 'recs': []}


def _apply_all(o):
    import bpy
    with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o], selected_editable_objects=[o]):
        for md in list(o.modifiers):
            bpy.ops.object.modifier_apply(modifier=md.name)


def proxy_normals(objs, inflate=0.012, voxel=0.01, smooth_iter=40, smooth_factor=0.9, mix=1.0, keep=False):
    """One smooth proxy over all hair objects; transfer its normals onto each (custom split normals)."""
    import bpy
    import bmesh
    tmp = []
    for o in objs:
        c = o.copy(); c.data = o.data.copy(); bpy.context.scene.collection.objects.link(c); tmp.append(c)
    with bpy.context.temp_override(active_object=tmp[0], selected_editable_objects=tmp, selected_objects=tmp):
        bpy.ops.object.join()
    j = tmp[0]
    bm = bmesh.new(); bm.from_mesh(j.data); bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * inflate
    bm.to_mesh(j.data); bm.free()
    r = j.modifiers.new('R', 'REMESH'); r.mode = 'VOXEL'; r.voxel_size = voxel; r.adaptivity = 0.0
    s = j.modifiers.new('S', 'SMOOTH'); s.factor = smooth_factor; s.iterations = smooth_iter
    _apply_all(j)
    for p in j.data.polygons:
        p.use_smooth = True
    for o in objs:
        md = o.modifiers.new('HKNormals', 'DATA_TRANSFER')
        md.object = j; md.use_loop_data = True; md.data_types_loops = {'CUSTOM_NORMAL'}
        md.loop_mapping = 'POLYINTERP_NEAREST'; md.mix_mode = 'REPLACE'; md.mix_factor = mix
        _apply_all(o)
    if not keep:
        bpy.data.objects.remove(j, do_unlink=True)
        return None
    return j


def group_by_azimuth(head, locks, groups):
    """groups: {name: (th_min, th_max)} on the lock ROOT azimuth. Returns {name: [lock indices]}."""
    out = {k: [] for k in groups}
    for i, sp in enumerate(locks):
        if sp.chain is False:
            continue
        th, _ = head.angles(sp.C[0])
        for k, (a, b) in groups.items():
            if a <= th < b:
                out[k].append(i); break
    return {k: v for k, v in out.items() if v}


def chains(arm, head_bone, head, locks, mesh, hair_obj, groups, joints=4, start_t=0.22, prefix='hk'):
    """Add bone chains to `arm` (one per azimuth group), weight hair_obj by hair_t along each lock.
    Returns physics chain specs for profile.json."""
    import bpy
    G = group_by_azimuth(head, locks, groups)
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    hb = eb[head_bone]
    Mi = np.array(arm.matrix_world.inverted())
    names = {}
    for gname, idx in G.items():
        paths = np.stack([resample(locks[i].C, 32) for i in idx])
        mean = paths.mean(0)
        L = np.linalg.norm(np.diff(mean, axis=0), axis=1)
        cum = np.r_[0, np.cumsum(L)] / max(L.sum(), 1e-9)
        pts = [mean[np.searchsorted(cum, start_t + (1 - start_t) * k / joints)] if k < joints else mean[-1] for k in range(joints + 1)]
        parent = hb
        bl = []
        for k in range(joints):
            b = eb.new(f'{prefix}_{gname}_{k + 1}')
            h = Mi[:3, :3] @ pts[k] + Mi[:3, 3]; tl = Mi[:3, :3] @ pts[k + 1] + Mi[:3, 3]
            b.head = tuple(h); b.tail = tuple(tl)
            b.parent = parent; b.use_connect = k > 0
            parent = b; bl.append(b.name)
        names[gname] = bl
    bpy.ops.object.mode_set(mode='OBJECT')
    # weights
    vg_head = hair_obj.vertex_groups.get(head_bone) or hair_obj.vertex_groups.new(name=head_bone)
    t = mesh['t']; lock = mesh['lock']
    nV = len(t)
    W = {head_bone: np.ones(nV)}
    for gname, idx in G.items():
        bl = names[gname]
        sel = np.isin(lock, idx)
        tt = np.clip((t[sel] - start_t) / (1 - start_t), 0, 1)
        vidx = np.nonzero(sel)[0]
        wh = 1 - smoothstep(0.0, 0.25, tt)
        W[head_bone][vidx] = wh
        pos = tt * joints
        for k, bn in enumerate(bl):
            w = np.clip(1 - np.abs(pos - (k + 0.5)), 0, 1) * (1 - wh)
            W.setdefault(bn, np.zeros(nV))[vidx] = w
    tot = sum(W.values())
    for bn, w in W.items():
        g = hair_obj.vertex_groups.get(bn) or hair_obj.vertex_groups.new(name=bn)
        w = w / np.maximum(tot, 1e-9)
        for i in np.nonzero(w > 0.002)[0]:
            g.add([int(i)], float(w[i]), 'REPLACE')
    md = hair_obj.modifiers.new('Armature', 'ARMATURE'); md.object = arm
    hair_obj.parent = arm
    return [{'rootBone': bl[0], 'stiffness': 0.72 if 'front' in g else 0.6, 'drag': 0.45, 'gravity': 0.35, 'radius': 0.035}
            for g, bl in names.items()]
