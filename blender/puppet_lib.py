"""
Reusable build steps for procedural (SDF / surface-nets) avatars, first used by a procedural puppet avatar
(an internal build). Pure bpy/bmesh/numpy, no scene assumptions.

Material separation without texture bleeding
    iso_cut(obj, field)            split a TRIANGULATED mesh exactly along field(P) = 0 (new vertices on the
                                   zero crossing of every edge), so a region boundary (mouth interior vs.
                                   fur, lip line, a painted patch...) becomes real geometry: a clean smooth
                                   edge instead of a stair-stepped face selection or a blurred texture mask.
    assign_by_field(obj, field, material_index)
                                   faces on the negative side get their own material slot -> they get their
                                   own UV islands and texture, so colours can never bleed across (texture
                                   filtering / mipmaps only ever mix texels of the same material).
    smart_uv_faces(obj, margin, material_index=None)
                                   smart-UV only the faces of one material slot (each slot fills 0..1 of the
                                   shared UV map; each slot has its own image).
    bake_texture(obj, size, paint, base_rgb, material_index=None)
                                   rasterise the faces of one slot in UV space and evaluate paint(P, N, texel)
                                   at the 3D surface point (seamless across islands because the pattern is 3D);
                                   the empty space is flood-filled from the islands (no base-colour halo at
                                   island borders when mip-mapped).
Seating props
    seat_offset(sdf, pts, direction, gap)
                                   how far to move a rigid prop along `direction` so its contact points `pts`
                                   rest at distance `gap` from an SDF surface (bisection) - masks on foreheads,
                                   hats on heads, badges on chests.
Puppet mouth weights
    puppet_split(P, plane_z, hinge_y, ...)
                                   upper-head / jaw / head weights for a hand-puppet mouth hinged on a
                                   left-right axis, with the fold near the hinge axis blended 50/50 (no tear).
"""
import math
import time

import bmesh
import bpy
import numpy as np


def _smooth(e0, e1, x):
    t = np.clip((np.asarray(x, dtype=float) - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


# ----------------------------------------------------------------------------- iso-contour cut
def iso_cut(obj, field, eps=1e-6):
    """Cut a triangulated mesh along field(P)=0. field: (n,3) numpy -> (n,) signed values.
    Returns the number of vertices inserted. The result is re-triangulated."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    co = np.array([v.co[:] for v in bm.verts], float)
    f = np.asarray(field(co), float)
    f = np.where(np.abs(f) < eps, eps, f)          # nothing exactly on the contour
    val = {v: float(f[i]) for i, v in enumerate(bm.verts)}
    cut_edges = [e for e in bm.edges if (val[e.verts[0]] < 0) != (val[e.verts[1]] < 0)]
    new_verts = set()
    for e in cut_edges:
        a, b = e.verts
        fa, fb = val[a], val[b]
        t = fa / (fa - fb)
        ne, nv = bmesh.utils.edge_split(e, a, t)
        # edge_split interpolates linearly; project the new vertex onto the contour exactly
        nv.co = a.co.lerp(b.co, t)
        val[nv] = 0.0
        new_verts.add(nv)
    for face in list(bm.faces):
        vs = [v for v in face.verts if v in new_verts]
        if len(vs) == 2 and bm.edges.get(vs) is None:
            try:
                bmesh.utils.face_split(face, vs[0], vs[1])
            except Exception:
                pass
    bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method='BEAUTY', ngon_method='BEAUTY')
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return len(new_verts)


def assign_by_field(obj, field, material_index, value_fn=None):
    """Faces whose vertices (ignoring those on the contour) are on the negative side of `field` get
    `material_index`. Use after iso_cut with the same field. Returns the number of faces assigned."""
    me = obj.data
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('co', co)
    f = np.asarray(field(co.reshape(-1, 3).astype(float)), float)
    n = 0
    for p in me.polygons:
        vv = f[list(p.vertices)]
        off = vv[np.abs(vv) > 1e-5]
        s = off.mean() if len(off) else f[list(p.vertices)].mean()
        if s < 0:
            p.material_index = material_index
            n += 1
    me.update()
    return n


# ----------------------------------------------------------------------------- UV + bake
def smart_uv_faces(obj, margin=0.01, material_index=None, angle=60.0):
    """Smart-UV project the faces of one material slot (all faces if None)."""
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_mode(type='FACE')
    bpy.ops.mesh.select_all(action='DESELECT')
    bm = bmesh.from_edit_mesh(obj.data)
    for f in bm.faces:
        if material_index is None or f.material_index == material_index:
            f.select_set(True)
    bmesh.update_edit_mesh(obj.data)
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=margin)
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.object.mode_set(mode='OBJECT')
    obj.select_set(False)


def pull_push(img, filled):
    """Fill every empty texel with a smooth average of the nearest filled ones (mip pyramid pull-push)."""
    levels = [(img * filled[..., None], filled.astype(float))]
    while min(levels[-1][1].shape) > 1:
        c, w = levels[-1]
        h, wd = (c.shape[0] // 2) * 2, (c.shape[1] // 2) * 2
        c, w = c[:h, :wd], w[:h, :wd]
        c2 = c[0::2, 0::2] + c[1::2, 0::2] + c[0::2, 1::2] + c[1::2, 1::2]
        w2 = w[0::2, 0::2] + w[1::2, 0::2] + w[0::2, 1::2] + w[1::2, 1::2]
        levels.append((c2, w2))
    col = levels[-1][0] / np.maximum(levels[-1][1], 1e-9)[..., None]
    for c, w in reversed(levels[:-1]):
        up = np.repeat(np.repeat(col, 2, 0), 2, 1)
        up = np.pad(up, ((0, c.shape[0] - up.shape[0]), (0, c.shape[1] - up.shape[1]), (0, 0)), mode='edge')
        own = c / np.maximum(w, 1e-9)[..., None]
        a = np.clip(w, 0, 1)[..., None]
        col = own * a + up * (1 - a)
    img[~filled] = col[~filled]
    filled[:] = True
    return img


def flood_fill(img, filled, max_iter=12):
    """Grow the filled texels outward (4-neighbour average) for a few texels (crisp island gutters), then
    pull-push the rest, so texture filtering at island borders and in small mip levels never pulls in an
    unrelated colour."""
    it = 0
    while not filled.all() and it < max_iter:
        acc = np.zeros_like(img)
        cnt = np.zeros(filled.shape)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            sh_f = np.roll(filled, (dy, dx), (0, 1))
            acc += np.roll(img, (dy, dx), (0, 1)) * sh_f[..., None]
            cnt += sh_f
        new = (~filled) & (cnt > 0)
        if not new.any():
            break
        img[new] = acc[new] / cnt[new][:, None]
        filled |= new
        it += 1
    if not filled.all():
        pull_push(img, filled)
    return img


def bake_texture(obj, size, paint, base_rgb, material_index=None, log=print):
    """Rasterise every triangle (of one material slot) in UV space and evaluate paint(P, N, texel_size)
    at its 3D surface point. Returns an (size, size, 3) sRGB float image (row 0 = bottom, Blender order)."""
    t0 = time.time()
    me = obj.data
    me.calc_loop_triangles()
    ntri = len(me.loop_triangles)
    tl = np.empty(ntri * 3, np.int32)
    me.loop_triangles.foreach_get('loops', tl)
    tl = tl.reshape(-1, 3)
    if material_index is not None:
        pi = np.empty(ntri, np.int32)
        me.loop_triangles.foreach_get('polygon_index', pi)
        mi = np.empty(len(me.polygons), np.int32)
        me.polygons.foreach_get('material_index', mi)
        tl = tl[mi[pi] == material_index]
    uv = np.empty(len(me.loops) * 2, np.float32)
    me.uv_layers.active.data.foreach_get('uv', uv)
    uv = uv.reshape(-1, 2).astype(float)
    lv = np.empty(len(me.loops), np.int32)
    me.loops.foreach_get('vertex_index', lv)
    co = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3).astype(float)
    vn = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('normal', vn)
    vn = vn.reshape(-1, 3).astype(float)
    Tuv = uv[tl] * size - 0.5
    Tp = co[lv[tl]]
    Tn = vn[lv[tl]]
    a3 = 0.5 * np.linalg.norm(np.cross(Tp[:, 1] - Tp[:, 0], Tp[:, 2] - Tp[:, 0]), axis=1)
    e1, e2 = Tuv[:, 1] - Tuv[:, 0], Tuv[:, 2] - Tuv[:, 0]
    a2 = 0.5 * np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0])
    tsz_tri = np.sqrt(a3 / np.maximum(a2, 1e-9))
    tsz_tri = np.minimum(tsz_tri, 2.0 * np.median(tsz_tri)) if len(tsz_tri) else tsz_tri
    img = np.zeros((size, size, 3)) + np.asarray(base_rgb, float)
    filled = np.zeros((size, size), bool)
    mn = np.floor(Tuv.min(1) - 0.5).astype(int)
    mx = np.ceil(Tuv.max(1) + 0.5).astype(int)
    ext = (mx - mn).max(1) + 1
    B = 2
    while True:
        sel = np.nonzero((ext <= B) & ((ext > B // 2) if B > 2 else (ext <= B)))[0]
        if len(sel):
            oy, ox = np.mgrid[0:B, 0:B]
            ox, oy = ox.ravel(), oy.ravel()
            step = max(1, int(3e6 // (B * B)))
            for c0 in range(0, len(sel), step):
                ss = sel[c0:c0 + step]
                px = mn[ss, 0, None] + ox[None]
                py = mn[ss, 1, None] + oy[None]
                A, Bv, Cv = Tuv[ss, 0], Tuv[ss, 1], Tuv[ss, 2]
                v0 = Bv - A
                v1 = Cv - A
                den = v0[:, 0] * v1[:, 1] - v1[:, 0] * v0[:, 1]
                den = np.where(np.abs(den) < 1e-12, 1e-12, den)
                qx = px - A[:, 0, None]
                qy = py - A[:, 1, None]
                l1 = (qx * v1[:, 1, None] - v1[:, 0, None] * qy) / den[:, None]
                l2 = (v0[:, 0, None] * qy - qx * v0[:, 1, None]) / den[:, None]
                l0 = 1 - l1 - l2
                # conservative: texels whose centre is within ~0.7 px of the triangle are painted too
                # (clamped barycentrics -> the 3D point stays on the triangle), so edges are fully covered
                m = -0.7 / np.maximum(np.sqrt(np.abs(den)), 1.0)[:, None]
                ins = (l0 >= m) & (l1 >= m) & (l2 >= m) & (px >= 0) & (py >= 0) & (px < size) & (py < size)
                ti, ci = np.nonzero(ins)
                if not len(ti):
                    continue
                tri = ss[ti]
                w = np.clip(np.stack([l0[ti, ci], l1[ti, ci], l2[ti, ci]], 1), 0, None)
                w /= w.sum(1, keepdims=True)
                P = Tp[tri, 0] * w[:, 0:1] + Tp[tri, 1] * w[:, 1:2] + Tp[tri, 2] * w[:, 2:3]
                N = Tn[tri, 0] * w[:, 0:1] + Tn[tri, 1] * w[:, 1:2] + Tn[tri, 2] * w[:, 2:3]
                N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)
                inside = np.all(w > 0, 1)   # exact interior texels win over the dilated rim of a neighbour
                col = paint(P, N, tsz_tri[tri])
                yy, xx = py[ti, ci], px[ti, ci]
                rim_ok = ~filled[yy, xx]
                wr = inside | rim_ok
                img[yy[wr], xx[wr]] = col[wr]
                filled[yy[wr], xx[wr]] = True
        if B >= size:
            break
        B *= 2
    n_tex = int(filled.sum())
    flood_fill(img, filled)
    log('  baked %-20s slot=%s %dpx texels=%d (%.1fs)' % (obj.name, material_index, size, n_tex, time.time() - t0))
    return img


# ----------------------------------------------------------------------------- props
def seat_offset(sdf, pts, direction, gap=0.0, lo=-0.3, hi=0.3, iters=48):
    """Offset t along `direction` such that min(sdf(pts + t*direction)) == gap (contact points resting on
    the surface). sdf decreases inward; direction points AWAY from the surface. Returns t."""
    pts = np.asarray(pts, float)
    d = np.asarray(direction, float)
    d = d / np.linalg.norm(d)
    for _ in range(iters):
        t = 0.5 * (lo + hi)
        if sdf(pts + t * d).min() < gap:
            lo = t
        else:
            hi = t
    return 0.5 * (lo + hi)


# ----------------------------------------------------------------------------- puppet weights
def puppet_split(P, plane_z, hinge_y, rest_half_deg=1.5, fold_r=(0.012, 0.055), force=0,
                 back_up=(145.0, 178.0), back_jaw=(-150.0, -105.0)):
    """Hand-puppet mouth weights for points on the head.

    The mouth hinges on the left-right axis through (y=hinge_y, z=plane_z(x)); angle th around it:
    0 = forward along the mouth plane, + = up. Returns (w_upper, w_jaw, w_head).
      * above the mouth plane -> upper head, below -> jaw (crisp split at the mouth gap)
      * within fold_r of the hinge axis the split fades to 50/50 (the corner fold: stays attached, no tear)
      * the back of the skull / the throat blend to 'head' (back_up / back_jaw angle ranges)
    force=+1 / -1 treats the point as above / below the mouth (overlapping sideburn / beard pieces)."""
    y, z = P[:, 1], P[:, 2]
    dz = z - plane_z(P[:, 0])
    dy = -(y - hinge_y)
    th = np.degrees(np.arctan2(dz, dy))
    if force > 0:
        th = np.where(th < 0, np.where(th > -100, 12.0, -th), np.maximum(th, 12.0))
    elif force < 0:
        th = np.where(th > 0, np.where(th < 100, -12.0, -th), np.minimum(th, -12.0))
    a0 = rest_half_deg
    s0 = _smooth(-a0, a0, th)
    if force == 0:
        r = np.hypot(dy, dz)
        near = 1 - _smooth(fold_r[0], fold_r[1], r)
        q = 1 - _smooth(a0, 40.0, np.abs(th))
        m = q * near
        split = s0 * (1 - m) + 0.5 * m
    else:
        split = s0
    up_keep = 1 - _smooth(back_up[0], back_up[1], th)
    jaw_keep = np.where(th < 0, _smooth(back_jaw[0], back_jaw[1], th), 1.0)
    wu = np.where(th >= 0, split * up_keep, split)
    wj = np.where(th < 0, (1 - split) * jaw_keep, (1 - split))
    wu = np.clip(wu, 0, 1)
    wj = np.clip(wj, 0, 1 - wu)
    return wu, wj, 1 - wu - wj
