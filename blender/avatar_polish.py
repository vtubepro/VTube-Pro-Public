"""
One-shot quality pass for AI-generated (Meshy / Tripo) rigged avatars — every step is automatic and
parameterised, so a new model only needs its reference views + a few numbers (see
assets/builtin/frogsuit/cleanup_uncle.py for a complete run).

    import sys; sys.path.insert(0, <VTube Pro>/blender); import cleanup_lib as C, avatar_polish as P
    ctx = C.load(src)
    P.rebuild_body(ctx, voxel=0.006, iters=40)          # watertight voxel remesh + Taubin fairing, weights carried over
    P.cut_and_cap(ctx, ...)                             # (cleanup_lib.replace_hands does the cut; P.cap_holes closes it)
    P.smart_uv(ctx.body, faces)                         # fresh, clean UV atlas
    P.Painter(...)                                      # flat anime repaint from reference views (class fields)
    P.carve_mouth(ctx, ...)                             # real mouth opening + cavity + jaw bone + ARKit shape keys
    P.export(ctx, out)                                  # glTF with morph targets

Generalises (no per-model code): rebuild_body, weight transfer, smart_uv, the class-field painter (views,
palette, lines, ink), eye-bulb painter, relief_from_mask, carve_mouth (+ shape keys, jaw rig), export.
Per-model inputs: palette + reference views (+ their fit), the face opening / mouth marker, bulb centres.
Everything works in Blender world space (z up, the avatar faces -y).
"""
import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree


# ------------------------------------------------------------------ small helpers
def smoothstep(a, b, x):
    t = np.clip((np.asarray(x, float) - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def hexrgb(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)], np.float32)


def srgb_to_lin(c):
    c = np.asarray(c, np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def world_co(ob):
    me = ob.data
    co = np.empty(len(me.vertices) * 3); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    M = np.array(ob.matrix_world)
    return co @ M[:3, :3].T + M[:3, 3]


def set_world_co(ob, P):
    Mi = np.array(ob.matrix_world.inverted())
    ob.data.vertices.foreach_set('co', (P @ Mi[:3, :3].T + Mi[:3, 3]).ravel())
    ob.data.update()


def edge_array(me):
    e = np.empty(len(me.edges) * 2, np.int64); me.edges.foreach_get('vertices', e)
    return e.reshape(-1, 2)


def tri_arrays(me):
    me.calc_loop_triangles()
    n = len(me.loop_triangles)
    tv = np.empty(n * 3, np.int64); me.loop_triangles.foreach_get('vertices', tv)
    tl = np.empty(n * 3, np.int64); me.loop_triangles.foreach_get('loops', tl)
    tp = np.empty(n, np.int64); me.loop_triangles.foreach_get('polygon_index', tp)
    return tv.reshape(-1, 3), tl.reshape(-1, 3), tp


def laplacian(P, E, deg):
    S = np.zeros_like(P)
    np.add.at(S, E[:, 0], P[E[:, 1]]); np.add.at(S, E[:, 1], P[E[:, 0]])
    return S / np.maximum(deg, 1)[:, None] - P


def taubin(P, E, w, iters, lam=0.5, mu=-0.53):
    """volume-preserving low-pass fairing (Taubin λ|μ); w = per-vertex strength 0..1"""
    deg = np.bincount(E.ravel(), minlength=len(P)).astype(float)
    w = np.asarray(w, float)[:, None]
    for _ in range(iters):
        P = P + lam * w * laplacian(P, E, deg)
        P = P + mu * w * laplacian(P, E, deg)
    return P


def diffuse(F, E, iters, keep=None, rate=0.5):
    """graph diffusion of per-vertex fields (label clean-up); keep = per-vertex anchor strength 0..1"""
    deg = np.bincount(E.ravel(), minlength=len(F)).astype(float)
    F0 = F.copy()
    for _ in range(iters):
        F = F + rate * laplacian(F, E, deg)
        if keep is not None: F = F + keep[:, None] * (F0 - F)
    return F


def barycentric(p, a, b, c):
    """barycentric coords of points p (N,3) projected into triangles (a, b, c), clipped + renormalised"""
    v0, v1, v2 = b - a, c - a, p - a
    d00 = (v0 * v0).sum(1); d01 = (v0 * v1).sum(1); d11 = (v1 * v1).sum(1)
    d20 = (v2 * v0).sum(1); d21 = (v2 * v1).sum(1)
    den = d00 * d11 - d01 * d01
    den = np.where(np.abs(den) < 1e-20, 1e-20, den)
    v = (d11 * d20 - d01 * d21) / den; w = (d00 * d21 - d01 * d20) / den
    B = np.clip(np.stack([1 - v - w, v, w], 1), 0, 1)
    return B / np.maximum(B.sum(1, keepdims=True), 1e-12)


class Surface:
    """nearest-point queries on a mesh + interpolation of its per-vertex / per-loop data (weights, UVs)"""

    def __init__(self, ob):
        self.ob = ob
        self.co = world_co(ob)
        self.tv, self.tl, self.tp = tri_arrays(ob.data)
        self.bvh = BVHTree.FromPolygons([Vector(c) for c in self.co], self.tv.tolist(), all_triangles=True)

    def nearest(self, P, max_dist=1e9):
        idx = np.zeros(len(P), np.int64); loc = np.array(P, float); dist = np.full(len(P), np.inf)
        for i, p in enumerate(P):
            l, _, j, d = self.bvh.find_nearest(Vector(p), max_dist)
            if j is not None: idx[i], loc[i], dist[i] = j, l, d
        B = barycentric(loc, *(self.co[self.tv[idx, k]] for k in range(3)))
        return idx, B, dist

    def interp_vert(self, attr, idx, B):
        return np.einsum('nk,nk...->n...', B, attr[self.tv[idx]])

    def interp_loop(self, attr, idx, B):
        return np.einsum('nk,nk...->n...', B, attr[self.tl[idx]])


# ------------------------------------------------------------------ weights
def weight_matrix(ob):
    names = [g.name for g in ob.vertex_groups]
    W = np.zeros((len(ob.data.vertices), len(names)), np.float32)
    for v in ob.data.vertices:
        for g in v.groups: W[v.index, g.group] = g.weight
    return names, W


def set_weights(ob, names, W, top=4, min_w=0.004):
    """replace all vertex groups: keep the `top` strongest influences per vertex, renormalised"""
    W = np.array(W, np.float32)
    if W.shape[1] > top:
        cut = -np.sort(-W, axis=1)[:, top - 1:top]
        W[W < cut] = 0
    W[W < min_w] = 0
    W /= np.maximum(W.sum(1, keepdims=True), 1e-9)
    ob.vertex_groups.clear()
    q = np.round(W * 512) / 512
    for gi, n in enumerate(names):
        col = q[:, gi]
        nz = np.nonzero(col)[0]
        if not len(nz): continue
        g = ob.vertex_groups.new(name=n)
        for u in np.unique(col[nz]):
            g.add(nz[col[nz] == u].tolist(), float(u), 'REPLACE')


# ------------------------------------------------------------------ body rebuild
def remesh_copy(ob, voxel, name=None, add=()):
    me = ob.data.copy()
    ob2 = bpy.data.objects.new(name or ob.name + '_rm', me)
    bpy.context.scene.collection.objects.link(ob2)
    ob2.matrix_world = ob.matrix_world.copy()
    if add:                                   # extra shapes fused into the remesh (toes, ears, nubs ...)
        bm = bmesh.new(); bm.from_mesh(me)
        inv = ob2.matrix_world.inverted()
        for a in add:
            m2 = a.data.copy(); m2.transform(inv @ a.matrix_world); bm.from_mesh(m2); bpy.data.meshes.remove(m2)
        bm.to_mesh(me); bm.free()
        for a in add: bpy.data.objects.remove(a, do_unlink=True)
    md = ob2.modifiers.new('rm', 'REMESH'); md.mode = 'VOXEL'; md.voxel_size = voxel; md.adaptivity = 0.0
    dg = bpy.context.evaluated_depsgraph_get()
    newm = bpy.data.meshes.new_from_object(ob2.evaluated_get(dg))
    ob2.modifiers.clear(); ob2.data = newm; bpy.data.meshes.remove(me)
    ob2.vertex_groups.clear()
    return ob2


def rebuild_body(ctx, voxel=0.006, iters=40, strength=None, lam=0.5, mu=-0.53, name=None, add=()):
    """Replace the AI body with a watertight voxel remesh (fuses inner shells, folds, self-intersections),
    faired with Taubin smoothing (kills the AI 'lumps / scales' but keeps the silhouette), skin weights
    interpolated from the original surface. strength(P world (N,3)) -> 0..1 per-vertex fairing strength.
    The original stays available as ctx.src_body / ctx.src_surface (texture + weight source), not exported."""
    src = ctx.body
    ob = remesh_copy(src, voxel, name or src.name, add=add)
    P = world_co(ob)
    E = edge_array(ob.data)
    w = np.ones(len(P)) if strength is None else np.clip(strength(P), 0, 1)
    P2 = taubin(P, E, w, iters, lam, mu)
    bad = ~np.all(np.isfinite(P2), 1)
    P2[bad] = P[bad]
    set_world_co(ob, P2)
    S = Surface(src)
    idx, B, _ = S.nearest(P2)
    names, Ws = weight_matrix(src)
    set_weights(ob, names, S.interp_vert(Ws, idx, B))
    for p in ob.data.polygons: p.use_smooth = True
    ob.data.materials.clear()
    for m in src.data.materials: ob.data.materials.append(m)
    ob.parent = ctx.arm
    ob.matrix_world = src.matrix_world.copy()
    md = ob.modifiers.new('Armature', 'ARMATURE'); md.object = ctx.arm
    src.hide_render = True; src.hide_set(True)
    ctx.src_body, ctx.src_surface = src, S
    ctx.body, ctx.BW = ob, ob.matrix_world
    print('REBUILD body: voxel %.4f -> %d verts / %d faces, fairing %d iters' % (voxel, len(ob.data.vertices), len(ob.data.polygons), iters))
    return ob


def cap_holes(ob, max_len=0.6):
    """close open boundary loops (e.g. after cutting hands off) with a fan-free grid fill; returns new faces"""
    bm = bmesh.new(); bm.from_mesh(ob.data)
    be = [e for e in bm.edges if e.is_boundary]
    res = bmesh.ops.holes_fill(bm, edges=be, sides=0)
    faces = res['faces']
    bmesh.ops.triangulate(bm, faces=faces)
    bm.to_mesh(ob.data); bm.free(); ob.data.update()
    print('CAP', len(faces), 'faces')


# ------------------------------------------------------------------ face opening rebuild (hooded / masked faces)
def rebuild_face_opening(ctx, center, axes, nose=None, nose_r=0.024, chin=None, bumps=(), front_y=-0.05, z_ref=None):
    """AI sculpts put moustaches / curls / brows where the painted art doesn't, and fold the lower face back.
    Inside the face opening ellipse (center (x, z), axes (ax, az), front view) the visible surface is refit
    with a robust cubic height field (points sticking OUT of the fit — sculpted hair — stop counting), then
    every vertex in the opening (inner shells and folds included) is snapped onto it; the nose is kept (it
    may only stand out of the face). chin = ([z...], [extra depth...]) adds a fuller forward chin.
    bumps = [(x, z)] sculpted curls outside the art, relaxed onto their surrounding plane.
    Returns depth(x, z) -> forward depth (-y) of the clean face surface (without the nose)."""
    body, BW = ctx.body, ctx.BW
    me = body.data
    inv = BW.inverted()
    FCX, FCZ = center; FAX, FAZ = axes
    z_ref = FCZ if z_ref is None else z_ref
    def face_e(p): return ((p.x - FCX) / FAX) ** 2 + ((p.z - FCZ) / FAZ) ** 2
    def sst(a, b, x): t = min(1.0, max(0.0, (x - a) / (b - a))); return t * t * (3 - 2 * t)
    R3 = BW.to_3x3()
    dg = bpy.context.evaluated_depsgraph_get()
    bvh = BVHTree.FromObject(body, dg)
    bm = bmesh.new(); bm.from_mesh(me)
    WP = {v: BW @ v.co for v in bm.verts}
    cand = [v for v in bm.verts if face_e(WP[v]) < 1.0 and WP[v].y < front_y]
    vis = []
    for v in cand:
        p = WP[v]
        loc, _, _, _ = bvh.ray_cast(inv @ Vector((p.x, -5, p.z)), (inv.to_3x3() @ Vector((0, 1, 0))).normalized())
        if loc and ((BW @ loc) - p).length < 0.003: vis.append(p)
    X = np.array([p.x for p in vis]); Z = np.array([p.z - z_ref for p in vis]) * 5; Y = np.array([-p.y for p in vis])
    def terms(x, z): return np.stack([np.ones_like(x), x, z, x * x, x * z, z * z, x ** 3, x * x * z, x * z * z, z ** 3], -1)
    A = terms(X, Z); wts = np.ones_like(Y)
    nose_m = np.hypot(X - nose[0], Z / 5 + z_ref - nose[1]) < nose_r if nose else np.zeros(len(X), bool)
    wts[nose_m] = 0
    for _ in range(8):
        coef, *_ = np.linalg.lstsq(A * wts[:, None], Y * wts, rcond=None)
        r = Y - A @ coef
        wts = np.where(r > 0.002, np.exp(-((r - 0.002) / 0.003) ** 2), 1.0); wts[nose_m] = 0
    chin_z, chin_d = chin if chin else ([0, 1], [0, 0])
    def depth(x, z):
        """clean face depth (-y); scalars -> float, arrays -> array"""
        xa, za = np.asarray(x, float), np.asarray(z, float)
        d = terms(np.atleast_1d(xa), np.atleast_1d((za - z_ref) * 5)) @ coef
        d = d + np.interp(np.atleast_1d(za), chin_z, chin_d, left=0, right=0) * (1 - smoothstep(0.05, 0.12, np.abs(np.atleast_1d(xa) - FCX)))
        return float(d[0]) if xa.ndim == 0 else d
    face_set = set()
    for v in bm.verts:
        p = WP[v]
        e = face_e(p)
        if e > 1.0 or p.y > front_y: continue
        tgt = depth(p.x, p.z)
        if -p.y < tgt - 0.06: continue
        nd = math.hypot(p.x - nose[0], p.z - nose[1]) if nose else 1e9
        w = (1 - sst(0.8, 1.0, e)) * sst(nose_r * 0.55, nose_r, nd)
        dd = -p.y + (tgt - (-p.y)) * w
        if nd < nose_r: dd = max(dd, tgt)
        q = p.copy(); q.y = -dd; v.co = inv @ q
        face_set.add(v)
    for bx, bz in bumps:
        ring = [WP[v] for v in bm.verts if WP[v].y < front_y and 0.035 < math.hypot(WP[v].x - bx, WP[v].z - bz) < 0.05]
        ring = [p for p in ring if -p.y > np.percentile([-q.y for q in ring], 40)]
        pc, *_ = np.linalg.lstsq(np.array([[1, p.x, p.z] for p in ring]), np.array([-p.y for p in ring]), rcond=None)
        n = 0
        for v in bm.verts:
            p = WP[v]; r_ = math.hypot(p.x - bx, p.z - bz)
            if p.y > front_y or r_ > 0.035: continue
            tgt = pc[0] + pc[1] * p.x + pc[2] * p.z
            if -p.y < tgt - 0.05: continue
            w = 1 - sst(0.025, 0.035, r_)
            q = p.copy(); q.y = -(-p.y + (tgt - (-p.y)) * w); v.co = inv @ q; n += 1
        print('FACE relaxed curl bump at (%.3f, %.3f): %d verts' % (bx, bz, n))
    bm.to_mesh(me); bm.free(); me.update()
    print('FACE refit: %d visible pts, rms %.4f, %d verts snapped' % (len(vis), float(np.sqrt(np.mean((Y - A @ coef) ** 2))), len(face_set)))
    return depth


# ------------------------------------------------------------------ UVs
def smart_uv(ob, polys=None, angle=66.0, margin=0.003, uv_name='UVMap'):
    """fresh smart-project atlas for the given polygons (bool per polygon; None = all)"""
    me = ob.data
    if uv_name not in me.uv_layers: me.uv_layers.new(name=uv_name)
    me.uv_layers.active = me.uv_layers[uv_name]
    for o in bpy.context.view_layer.objects: o.select_set(False)
    ob.hide_set(False); ob.select_set(True); bpy.context.view_layer.objects.active = ob
    sel = np.ones(len(me.polygons), bool) if polys is None else np.asarray(polys, bool)
    me.polygons.foreach_set('select', sel)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_mode(type='FACE')
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=margin, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    print('UV smart project: %d faces' % sel.sum())


def loop_uv(me, name=None):
    uvl = me.uv_layers[name] if name else me.uv_layers.active
    uv = np.empty(len(me.loops) * 2, np.float32); uvl.data.foreach_get('uv', uv)
    return uv.reshape(-1, 2)


def loop_polys(me):
    lt = np.empty(len(me.polygons), np.int64); me.polygons.foreach_get('loop_total', lt)
    return np.repeat(np.arange(len(me.polygons)), lt)


def set_planar_uv(ob, polys, fn, name=None):
    """UVs of the given polygons from fn(world points (N,3)) -> (N,2)"""
    me = ob.data
    uvl = me.uv_layers[name] if name else me.uv_layers.active
    P = world_co(ob)
    uv = loop_uv(me, name)
    lv = np.empty(len(me.loops), np.int64); me.loops.foreach_get('vertex_index', lv)
    m = np.asarray(polys, bool)[loop_polys(me)]
    uv[m] = fn(P[lv[m]])
    uvl.data.foreach_set('uv', uv.ravel())


# ------------------------------------------------------------------ rasteriser (UV space, vectorised)
def raster_uv(me, W, H, tri_sel=None, uv_name=None):
    """per-texel triangle id (-1 = empty) + barycentrics for the (selected) loop triangles.
    Rows are v-up (Blender pixel order)."""
    tv, tl, tp = tri_arrays(me)
    uv = loop_uv(me, uv_name)
    ids = np.arange(len(tv)) if tri_sel is None else np.nonzero(tri_sel)[0]
    T = uv[tl[ids]].astype(np.float64) * np.array([W, H]) - 0.5
    lo = np.floor(T.min(1)).astype(np.int64); hi = np.ceil(T.max(1)).astype(np.int64)
    S = np.maximum(hi[:, 0] - lo[:, 0], hi[:, 1] - lo[:, 1]) + 1
    tid = np.full((H, W), -1, np.int64); bar = np.zeros((H, W, 3), np.float32)
    done = np.zeros(len(ids), bool)
    for b in (2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 128, 256, 512, 1024, 4096):
        sel = np.nonzero(~done & (S <= b))[0]
        if not len(sel): continue
        done[sel] = True
        gy, gx = np.mgrid[0:b, 0:b]; gx = gx.ravel(); gy = gy.ravel()
        chunk = max(1, 2_000_000 // (b * b))
        for c0 in range(0, len(sel), chunk):
            s = sel[c0:c0 + chunk]
            px = lo[s, 0, None] + gx[None]; py = lo[s, 1, None] + gy[None]
            a, bb, c = T[s, 0], T[s, 1], T[s, 2]
            den = (bb[:, 1] - c[:, 1]) * (a[:, 0] - c[:, 0]) + (c[:, 0] - bb[:, 0]) * (a[:, 1] - c[:, 1])
            ok = np.abs(den) > 1e-12; den = np.where(ok, den, 1.0)
            w0 = ((bb[:, 1, None] - c[:, 1, None]) * (px - c[:, 0, None]) + (c[:, 0, None] - bb[:, 0, None]) * (py - c[:, 1, None])) / den[:, None]
            w1 = ((c[:, 1, None] - a[:, 1, None]) * (px - c[:, 0, None]) + (a[:, 0, None] - c[:, 0, None]) * (py - c[:, 1, None])) / den[:, None]
            w2 = 1 - w0 - w1
            e = -1e-4
            m = (w0 >= e) & (w1 >= e) & (w2 >= e) & ok[:, None] & (px >= 0) & (py >= 0) & (px < W) & (py < H)
            r, k = np.nonzero(m)
            tid[py[r, k], px[r, k]] = ids[s[r]]
            bar[py[r, k], px[r, k]] = np.stack([w0[r, k], w1[r, k], w2[r, k]], 1)
    return tid, bar, tv, tl, uv


def gutter(img, cov, passes=10):
    """bleed island colours outward (mip-mapping never pulls in black seams); img (H,W,C)"""
    known = cov.copy()
    out = img.copy()
    for _ in range(passes):
        acc = np.zeros_like(out); cnt = np.zeros(known.shape, np.float32)
        kf = known.astype(np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0: continue
                acc += np.roll(np.roll(out * kf[..., None], dy, 0), dx, 1)
                cnt += np.roll(np.roll(kf, dy, 0), dx, 1)
        ring = ~known & (cnt > 0)
        if not ring.any(): break
        out[ring] = acc[ring] / cnt[ring][:, None]
        known = known | ring
    return out


def load_image_np(path):
    """image file -> float32 (H,W,4) top-down rows, values as stored (sRGB)"""
    im = bpy.data.images.load(path, check_existing=False)
    w, h = im.size
    px = np.empty(w * h * 4, np.float32); im.pixels.foreach_get(px)
    bpy.data.images.remove(im)
    return px.reshape(h, w, 4)[::-1].copy()


def save_image_np(arr, path, name=None, pack=True):
    """float (H,W,3|4) top-down rows -> PNG file + a (packed) Blender image"""
    h, w = arr.shape[:2]
    if arr.shape[2] == 3: arr = np.concatenate([arr, np.ones((h, w, 1), np.float32)], 2)
    im = bpy.data.images.new(name or os.path.splitext(os.path.basename(path))[0], w, h, alpha=True)
    im.pixels.foreach_set(np.clip(arr[::-1], 0, 1).astype(np.float32).ravel())
    im.filepath_raw = path; im.file_format = 'PNG'; im.save()
    if pack: im.pack()
    return im


def bilinear(img, x, y):
    h, w = img.shape[:2]
    x = np.clip(x, 0, w - 1.001); y = np.clip(y, 0, h - 1.001)
    x0 = x.astype(np.int64); y0 = y.astype(np.int64); fx = (x - x0)[:, None]; fy = (y - y0)[:, None]
    return (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x0 + 1] * fx * (1 - fy)
            + img[y0 + 1, x0] * (1 - fx) * fy + img[y0 + 1, x0 + 1] * fx * fy)


def vertex_normals(ob):
    me = ob.data
    n = np.empty(len(me.vertices) * 3); me.vertices.foreach_get('normal', n); n = n.reshape(-1, 3)
    N3 = np.array(ob.matrix_world.to_3x3().inverted().transposed())
    n = n @ N3.T
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


# ------------------------------------------------------------------ flat anime repaint
class Painter:
    """Flat anime texture for a clean mesh: per-vertex CLASS fields (suit / spot / belly ...) voted from the
    reference views (ray-tested visibility, facing-weighted) + the old AI texture where no view sees, cleaned
    by surface diffusion, then rasterised per texel with analytic anti-aliased edges, world-width outlines
    between chosen classes, optional ink (line art) lifted from the views, and analytic decals (eye bulbs,
    seams, dots). No per-texel paint noise survives, so seams, smears and blotches can't appear."""

    def __init__(self, ob, palette, size=2048, polys=None, uv_name=None):
        self.ob = ob; me = ob.data
        self.names = list(palette)
        self.cols = np.stack([hexrgb(palette[n]['color']) for n in self.names])
        self.match = {n: [np.array(m, np.float32) / 255 for m in palette[n].get('match', [])] + [hexrgb(palette[n]['color'])] for n in self.names}
        self.P = world_co(ob); self.N = vertex_normals(ob); self.E = edge_array(me)
        self.V = np.zeros((len(self.P), len(self.names)), np.float32)
        self.W = self.H = size
        tv, tl, tp = tri_arrays(me)
        sel = None if polys is None else np.asarray(polys, bool)[tp]
        tid, bar, self.tv, self.tl, self.uv = raster_uv(me, size, size, sel, uv_name)
        self.cov = tid >= 0
        self.tt = tid[self.cov]; self.bb = bar[self.cov].astype(np.float64)
        self.tri_v = self.tv[self.tt]
        self.Pt = np.einsum('nk,nkd->nd', self.bb, self.P[self.tri_v])
        Nt = np.einsum('nk,nkd->nd', self.bb, self.N[self.tri_v])
        self.Nt = Nt / np.maximum(np.linalg.norm(Nt, axis=1, keepdims=True), 1e-12)
        Tp = self.uv[self.tl[self.tt]] * size
        a2 = np.abs(np.cross(Tp[:, 1] - Tp[:, 0], Tp[:, 2] - Tp[:, 0]))
        Q = self.P[self.tri_v]
        a3 = np.linalg.norm(np.cross(Q[:, 1] - Q[:, 0], Q[:, 2] - Q[:, 0]), axis=1)
        self.ppm = np.sqrt(a2 / np.maximum(a3, 1e-12))            # texel density (px per metre)
        dg = bpy.context.evaluated_depsgraph_get()
        self.bvh = BVHTree.FromObject(ob, dg)
        self._views = []
        print('PAINT raster %d texels (%.0f%%), %d verts, median %.0f px/m' % (self.cov.sum(), 100 * self.cov.mean(), len(self.P), np.median(self.ppm)))

    def classify(self, rgb, thr=0.2, ink=0.22, bg=0.9):
        """palette class per colour (-1 = ink / background / unknown)"""
        d = np.stack([np.min([np.linalg.norm(rgb - m, axis=1) for m in self.match[n]], axis=0) for n in self.names], 1)
        c = d.argmin(1)
        c[d.min(1) > thr] = -1
        c[rgb.max(1) < ink] = -1
        c[rgb.min(1) > bg] = -1
        return c

    def visible(self, dirv, offset=0.003):
        inv = self.ob.matrix_world.inverted(); d = (inv.to_3x3() @ Vector(dirv)).normalized()
        vis = np.zeros(len(self.P), bool)
        for i, (p, n) in enumerate(zip(self.P, self.N)):
            vis[i] = self.bvh.ray_cast(inv @ Vector(p + n * offset), d)[0] is None
        return vis

    def view(self, path, fit, sign, weight=1.0, facing=(0.15, 0.45), exclude=None, keep=None):
        """vote classes from an orthographic reference view. fit = {'scale','tx','ty'}: pixel col = tx +
        sign*x*scale, row = ty - z*scale (sign +1 front view, -1 back view). exclude(P) -> bool: vertices
        posed unlike the view (A-pose arms vs arms-down art); keep(P) -> bool restricts."""
        img = load_image_np(path)[..., :3]
        col = fit['tx'] + sign * self.P[:, 0] * fit['scale']; row = fit['ty'] - self.P[:, 2] * fit['scale']
        rgb = bilinear(img, col, row)
        cls = self.classify(rgb)
        vis = self.visible((0, -sign, 0))
        fw = smoothstep(facing[0], facing[1], self.N[:, 1] * -sign) * vis
        if exclude is not None: fw = fw * ~exclude(self.P)
        if keep is not None: fw = fw * keep(self.P)
        w = fw * (cls >= 0) * weight
        ok = w > 0
        np.add.at(self.V, (np.nonzero(ok)[0], cls[ok]), w[ok])
        self._views.append((img, fit, sign, fw))
        print('PAINT view %s: %d verts voted' % (os.path.basename(path), ok.sum()))

    def texture_votes(self, surface, image_path, weight=0.35, uv_name=None, thr=0.3):
        """vote from the OLD texture at the nearest point of the old surface (sides / arms no view sees)"""
        img = load_image_np(image_path)[..., :3]
        idx, B, _ = surface.nearest(self.P)
        uv = surface.interp_loop(loop_uv(surface.ob.data, uv_name), idx, B)
        h, w = img.shape[:2]
        rgb = bilinear(img, uv[:, 0] * w - 0.5, (1 - uv[:, 1]) * h - 0.5)
        cls = self.classify(rgb, thr=thr)
        ok = cls >= 0
        np.add.at(self.V, (np.nonzero(ok)[0], cls[ok]), weight)
        print('PAINT old texture: %d verts voted' % ok.sum())

    def remap(self, where, rules):
        """move votes between classes inside a region: where(P) -> bool, rules {from: to}"""
        m = where(self.P)
        for a, b in rules.items():
            ia, ib = self.names.index(a), self.names.index(b)
            self.V[m, ib] += self.V[m, ia]; self.V[m, ia] = 0

    def force(self, where, cls, amount=1.0):
        m = where(self.P); self.V[m] = self.V[m] * (1 - amount); self.V[m, self.names.index(cls)] += amount

    def solve(self, iters=30, anchor=0.25, default='suit'):
        """clean class fields: normalised votes, anchored diffusion over the surface (fills unseen areas,
        removes speckle, rounds blobs)"""
        s = self.V.sum(1, keepdims=True)
        Fn = np.where(s > 0, self.V / np.maximum(s, 1e-9), 0)
        c = np.clip(s[:, 0], 0, 1)
        Fn[s[:, 0] == 0, self.names.index(default)] = 0.05
        F = Fn.copy()
        deg = np.bincount(self.E.ravel(), minlength=len(F)).astype(float)
        for _ in range(iters):
            F = F + 0.5 * laplacian(F, self.E, deg)
            F = F + (c * anchor)[:, None] * (Fn - F)
        self.F = F
        print('PAINT classes', {n: int((F.argmax(1) == i).sum()) for i, n in enumerate(self.names)})

    def render(self, lines=(), line_color='#2b2a22', line_width=0.004):
        F = self.F
        Ft = np.einsum('nk,nkc->nc', self.bb, F[self.tri_v])
        order = np.argsort(-Ft, axis=1)
        a, b = order[:, 0], order[:, 1]
        gv = np.take_along_axis(F[self.tri_v], a[:, None, None], 2)[..., 0] - np.take_along_axis(F[self.tri_v], b[:, None, None], 2)[..., 0]
        g = (self.bb * gv).sum(1)
        Tp = self.uv[self.tl[self.tt]].astype(np.float64) * self.W
        e1, e2 = Tp[:, 1] - Tp[:, 0], Tp[:, 2] - Tp[:, 0]
        det = e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0]
        det = np.where(np.abs(det) < 1e-12, 1e-12, det)
        d1, d2 = gv[:, 1] - gv[:, 0], gv[:, 2] - gv[:, 0]
        gx = (d1 * e2[:, 1] - d2 * e1[:, 1]) / det; gy = (d2 * e1[:, 0] - d1 * e2[:, 0]) / det
        gpx = np.maximum(np.hypot(gx, gy), 1e-9)
        Q = self.P[self.tri_v]; q1, q2 = Q[:, 1] - Q[:, 0], Q[:, 2] - Q[:, 0]
        G11, G12, G22 = (q1 * q1).sum(1), (q1 * q2).sum(1), (q2 * q2).sum(1)
        gd = G11 * G22 - G12 ** 2
        gd = np.where(np.abs(gd) < 1e-20, 1e-20, gd)
        ca = (G22 * d1 - G12 * d2) / gd; cb = (G11 * d2 - G12 * d1) / gd
        gw = np.sqrt(np.maximum(ca * ca * G11 + 2 * ca * cb * G12 + cb * cb * G22, 1e-18))
        dpx = g / gpx; dw = g / gw
        alpha = np.clip(0.5 + dpx, 0, 1)[:, None]
        col = self.cols[a] * alpha + self.cols[b] * (1 - alpha)
        self.cls_t, self.bdist = a, dw
        K = len(self.names)
        pairs = {self.names.index(x) * K + self.names.index(y) for x, y in lines} | {self.names.index(y) * K + self.names.index(x) for x, y in lines}
        if pairs:
            onl = np.isin(a * K + b, list(pairs))
            ppm = gw / gpx
            la = np.clip((line_width / 2 - np.abs(dw)) * ppm + 0.5, 0, 1) * onl
            col = col * (1 - la[:, None]) + hexrgb(line_color)[None] * la[:, None]
        self.col = col
        return col

    def overlay(self, rgb, alpha):
        self.col = self.col * (1 - alpha[:, None]) + np.asarray(rgb, np.float64).reshape(-1, 3) * alpha[:, None]

    def aa(self, dist_m):
        """anti-aliased coverage from a signed world distance (<0 inside)"""
        return np.clip(0.5 - dist_m * self.ppm, 0, 1)

    def ink(self, view_i=0, classes=('belly',), color='#4a3a22', thr=(0.62, 0.42), min_facing=0.55, keep_off=0.012, strength=0.9, where=None):
        """lift the view's line art (dark strokes: belly creases ...) onto texels of `classes`, away from
        class boundaries (those get the procedural outline)"""
        img, fit, sign, vw = self._views[view_i]
        col = fit['tx'] + sign * self.Pt[:, 0] * fit['scale']; row = fit['ty'] - self.Pt[:, 2] * fit['scale']
        rgb = bilinear(img, col, row)
        base = self.cols[self.cls_t]
        lum = rgb.mean(1) / np.maximum(base.mean(1), 1e-3)
        wv = (self.bb * vw[self.tri_v]).sum(1)
        m = np.isin(self.cls_t, [self.names.index(c) for c in classes]) & (wv > min_facing) & (np.abs(self.bdist) > keep_off)
        if where is not None: m &= where(self.Pt)
        a = smoothstep(thr[0], thr[1], lum) * m * strength
        self.overlay(hexrgb(color), a)
        print('PAINT ink from view %d: %d texels' % (view_i, int((a > 0.3).sum())))

    def bulb_eye(self, center, radius, axis, pupil, ring, line=0.12, colors=('#101012', '#e9b93c', '#2a2418', '#ffffff'),
                 highlights=((-0.42, 0.42, 0.34), (0.4, 0.46, 0.14)), up=(0, 0, 1), reach=1.4, on_sphere=None):
        """anime frog / mascot eye painted analytically on a (roughly spherical) bulb: black pupil, gold ring,
        dark outline, white highlights. pupil / ring = angular radii (radians) from the axis; highlights =
        (u, v, r) in pupil-radius units on the eye's tangent plane (u = toward avatar left, v = up)"""
        c = np.array(center, float); a = np.array(axis, float); a /= np.linalg.norm(a)
        rel = self.Pt - c
        dist = np.linalg.norm(rel, axis=1)
        dirs = rel / np.maximum(dist, 1e-9)[:, None]
        k = (dist < radius * reach) & ((self.Nt * dirs).sum(1) > 0.3)
        if on_sphere is not None:       # soft clip to the bulb itself: paint never runs down where it merges into the head
            k = k * self.aa(np.abs(dist - radius) - on_sphere * radius)
        th = np.arccos(np.clip(dirs @ a, -1, 1))
        blk, gold, ink, white = (hexrgb(x) for x in colors)
        lw = line * (ring - pupil)
        self.overlay(gold, self.aa((th - ring) * radius) * k)
        self.overlay(blk, self.aa((th - pupil) * radius) * k)
        self.overlay(ink, self.aa((np.abs(th - ring - lw * 0.3) - lw * 0.5) * radius) * k)
        upv = np.array(up, float); tu = np.cross(upv, a); tu /= np.linalg.norm(tu); tv = np.cross(a, tu)
        sp = math.sin(pupil)
        u = (dirs @ tu) / sp; v = (dirs @ tv) / sp
        for hu, hv, hr in highlights:
            dd = np.hypot(u - hu, v - hv) - hr
            self.overlay(white, self.aa(dd * sp * radius) * k * (th < pupil * 1.05))
        print('PAINT bulb eye at', np.round(c, 3), 'texels', int(((th < ring) & (k > 0.5)).sum()))

    def dots(self, pts, color, facing=0.2):
        """round dots projected from the front view: [(x, z, r)] — nostrils, buttons, freckles"""
        for x, z, r in pts:
            d = np.hypot(self.Pt[:, 0] - x, self.Pt[:, 2] - z) - r
            m = (-self.Nt[:, 1] > facing) & (self.Pt[:, 1] < 0)
            self.overlay(hexrgb(color), self.aa(d) * m)

    def seam(self, x, z0, z1, width, color, back=True):
        m = (self.Pt[:, 1] > 0) if back else (self.Pt[:, 1] < 0)
        m = m & (self.Pt[:, 2] > z0) & (self.Pt[:, 2] < z1)
        fade = smoothstep(z0, z0 + 0.03, self.Pt[:, 2]) * (1 - smoothstep(z1 - 0.03, z1, self.Pt[:, 2]))
        self.overlay(hexrgb(color), self.aa(np.abs(self.Pt[:, 0] - x) - width / 2) * m * fade)

    def finish(self, path, name=None):
        img = np.zeros((self.H, self.W, 3), np.float32)
        img[self.cov] = self.col
        img = gutter(img, self.cov, passes=12)
        im = save_image_np(img[::-1], path, name)
        print('PAINT wrote', path)
        return im


def flat_material(name, image=None, color=None, roughness=0.9):
    mat = bpy.data.materials.new(name); mat.use_nodes = True
    nt = mat.node_tree; p = nt.nodes['Principled BSDF']
    p.inputs['Roughness'].default_value = roughness
    if 'Specular IOR Level' in p.inputs: p.inputs['Specular IOR Level'].default_value = 0.2
    if image is not None:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = image
        nt.links.new(t.outputs['Color'], p.inputs['Base Color'])
    elif color is not None:
        p.inputs['Base Color'].default_value = tuple(srgb_to_lin(hexrgb(color))) + (1,)
    return mat


# ------------------------------------------------------------------ local refinement / snapping / parts
def refine_region(ob, sel, cuts=2, smooth=1.0):
    """subdivide (cuts times, 1 cut each, smooth) every edge whose both ends satisfy sel(world P) -> bool"""
    for _ in range(cuts):
        bm = bmesh.new(); bm.from_mesh(ob.data)
        M = ob.matrix_world
        co = np.array([tuple(M @ v.co) for v in bm.verts])
        m = sel(co)
        bm.verts.ensure_lookup_table()
        edges = [e for e in bm.edges if m[e.verts[0].index] and m[e.verts[1].index]]
        bmesh.ops.subdivide_edges(bm, edges=edges, cuts=1, use_grid_fill=True, smooth=smooth)
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
        bm.to_mesh(ob.data); bm.free(); ob.data.update()
    print('REFINE region: %d verts now' % len(ob.data.vertices))


def snap_to_surface(ob, target, weight, direction=(0, 1, 0), max_dist=0.03, back_off=0.06):
    """move vertices (weight(P) -> 0..1) onto the target mesh's first surface along `direction`
    (e.g. re-snap a remeshed face onto the clean source face, keeping its exact nose / chin)"""
    P = world_co(ob)
    w = np.clip(weight(P), 0, 1)
    S = target if isinstance(target, Surface) else Surface(target)
    d = Vector(direction).normalized()
    moved = 0
    for i in np.nonzero(w > 0)[0]:
        o = Vector(P[i]) - d * back_off
        loc, _, _, dist = S.bvh.ray_cast(o, d, back_off + max_dist)
        if loc is None or abs(dist - back_off) > max_dist: continue
        P[i] = P[i] + (np.array(loc) - P[i]) * w[i]; moved += 1
    set_world_co(ob, P)
    print('SNAP %d verts onto %s' % (moved, S.ob.name))


def fit_sphere(Q):
    A = np.c_[2 * Q, np.ones(len(Q))]
    b = (Q * Q).sum(1)
    s, *_ = np.linalg.lstsq(A, b, rcond=None)
    c = s[:3]
    return c, math.sqrt(max(s[3] + c @ c, 1e-12))


def front_hit(ob, x, z, bvh=None):
    if bvh is None: bvh = BVHTree.FromObject(ob, bpy.context.evaluated_depsgraph_get())
    inv = ob.matrix_world.inverted()
    loc, n, _, _ = bvh.ray_cast(inv @ Vector((x, -5, z)), (inv.to_3x3() @ Vector((0, 1, 0))).normalized())
    if loc is None: return None, None
    return np.array(ob.matrix_world @ loc), np.array((ob.matrix_world.to_3x3() @ n).normalized())


def fit_bulb(ob, x, z, r0=0.045):
    """sphere fit of an eye bulb / dome around the front-view point (x, z): centre, radius, axis (centre →
    that point, i.e. where the art's pupil looks)"""
    h, _ = front_hit(ob, x, z)
    P = world_co(ob)
    m = np.linalg.norm(P - h, axis=1) < r0
    c, R = fit_sphere(P[m])
    for _ in range(3):
        d = np.abs(np.linalg.norm(P - c, axis=1) - R)
        m = (np.linalg.norm(P - h, axis=1) < r0 * 1.2) & (d < R * 0.12)
        c, R = fit_sphere(P[m])
    a = (h - c) / np.linalg.norm(h - c)
    print('BULB fit at (%.3f, %.3f): centre %s r %.3f axis %s (%d pts)' % (x, z, np.round(c, 3), R, np.round(a, 2), m.sum()))
    return c, R, a


def tail_nub(ctx, z=0.66, size=(0.055, 0.075, 0.03), material=None, bone='tail', parent='hips'):
    """egg-shaped tail nub on the back at height z (spring bone `bone`, child of `parent`)"""
    import cleanup_lib as C
    body, arm = ctx.body, ctx.arm
    inv = body.matrix_world.inverted()
    bvh = BVHTree.FromObject(body, bpy.context.evaluated_depsgraph_get())
    loc, n, _, _ = bvh.ray_cast(inv @ Vector((0, 5, z)), (inv.to_3x3() @ Vector((0, -1, 0))).normalized())
    tp, tn = body.matrix_world @ loc, (body.matrix_world.to_3x3() @ n).normalized()
    c = tp + tn * 0.012
    R = Vector((0, 0, 1)).rotation_difference(tn).to_matrix()
    ob = C.new_object('TailNub', lambda bm2: C._ellipsoid(bm2, c, size, R, seg=24, rings=12), '#5c8144')
    C.remesh_smooth(ob, 0.004, iters=3)
    if material: ob.data.materials.clear(); ob.data.materials.append(material)
    g = ob.vertex_groups.new(name=bone); g.add(list(range(len(ob.data.vertices))), 1.0, 'REPLACE')
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    ainv = arm.matrix_world.inverted()
    tb = arm.data.edit_bones.get(bone) or arm.data.edit_bones.new(bone)
    tb.head = ainv @ (c - tn * 0.02); tb.tail = ainv @ (c + tn * 0.06)
    tb.parent = arm.data.edit_bones[parent]; tb.use_deform = True
    bpy.ops.object.mode_set(mode='OBJECT')
    C.attach(ctx, ob)
    return ob


# ------------------------------------------------------------------ export
def export(ctx, out, morph=True, extras=False):
    bpy.ops.object.select_all(action='DESELECT')
    for o in [ctx.arm, ctx.body] + list(ctx.extra):
        o.hide_set(False); o.select_set(True)
    bpy.context.view_layer.objects.active = ctx.arm
    kw = dict(filepath=out, export_format='GLB', use_selection=True, export_yup=True, export_skins=True,
              export_animations=False, export_morph=morph, export_def_bones=False, export_extras=extras)
    try:
        bpy.ops.export_scene.gltf(**kw, export_morph_normal=False, export_try_sparse_sk=True)
    except TypeError:
        bpy.ops.export_scene.gltf(**kw)
    print('WROTE', out, os.path.getsize(out), 'bones', len(ctx.arm.data.bones))


def bump_field(src, depth, center, radius, step=0.002, sigma=0.004):
    """smooth height field of a feature (nose) standing out of the clean face: sampled from the source mesh
    along front rays, blurred (the AI's crumpled micro-detail goes), windowed. Returns h(x, z) arrays."""
    S = src if isinstance(src, Surface) else Surface(src)
    cx, cz = center
    xs = np.arange(cx - radius * 1.6, cx + radius * 1.6 + 1e-9, step)
    zs = np.arange(cz - radius * 1.6, cz + radius * 1.6 + 1e-9, step)
    Hh = np.zeros((len(zs), len(xs)))
    for j, z in enumerate(zs):
        for i, x in enumerate(xs):
            loc, _, _, _ = S.bvh.ray_cast(Vector((x, -5, z)), Vector((0, 1, 0)))
            if loc is not None: Hh[j, i] = -loc.y - depth(x, z)
    Xg, Zg = np.meshgrid(xs, zs)
    r = np.hypot(Xg - cx, Zg - cz)
    Hh = np.clip(Hh, 0, None) * (1 - smoothstep(radius * 0.75, radius * 1.3, r))
    k = int(3 * sigma / step); g = np.exp(-0.5 * (np.arange(-k, k + 1) * step / sigma) ** 2); g /= g.sum()
    Hp = np.pad(Hh, k, mode='edge')
    Hp = np.apply_along_axis(lambda a: np.convolve(a, g, 'valid'), 1, Hp)
    Hh = np.apply_along_axis(lambda a: np.convolve(a, g, 'valid'), 0, Hp)
    Hh *= 1 - smoothstep(radius * 0.9, radius * 1.5, r)
    print('BUMP field at (%.3f, %.3f): max %.4f m' % (cx, cz, Hh.max()))
    def h(x, z):
        x = np.asarray(x, float); z = np.asarray(z, float)
        fx = (x - xs[0]) / step; fz = (z - zs[0]) / step
        inside = (fx >= 0) & (fz >= 0) & (fx <= len(xs) - 1.001) & (fz <= len(zs) - 1.001)
        fx = np.clip(fx, 0, len(xs) - 1.001); fz = np.clip(fz, 0, len(zs) - 1.001)
        x0 = fx.astype(int); z0 = fz.astype(int); ax = fx - x0; az = fz - z0
        v = (Hh[z0, x0] * (1 - ax) * (1 - az) + Hh[z0, x0 + 1] * ax * (1 - az) + Hh[z0 + 1, x0] * (1 - ax) * az + Hh[z0 + 1, x0 + 1] * ax * az)
        return np.where(inside, v, 0.0)
    return h


def snap_depth(ob, target, weight):
    """set each vertex's forward depth (-y) toward target(x, z) with weight(P) 0..1 (front-facing surfaces)"""
    P = world_co(ob)
    w = np.clip(weight(P), 0, 1)
    m = w > 0
    t = target(P[m, 0], P[m, 2])
    P[m, 1] = P[m, 1] + (-t - P[m, 1]) * w[m]
    set_world_co(ob, P)
    print('SNAP depth: %d verts' % m.sum())


def fair_region(ob, weight, iters=6):
    """gentle Taubin pass on a region (weight(P) -> 0..1), e.g. after snapping"""
    P = world_co(ob)
    set_world_co(ob, taubin(P, edge_array(ob.data), np.clip(weight(P), 0, 1), iters))


# ------------------------------------------------------------------ carved anime mouth
def _order_loop(edges):
    adj = {}
    for a, b in edges:
        adj.setdefault(a, []).append(b); adj.setdefault(b, []).append(a)
    start = next(iter(adj)); loop = [start]; prev = None; cur = start
    while True:
        nxt = [v for v in adj[cur] if v != prev]
        if not nxt: break
        n = nxt[0]
        if n == start: break
        loop.append(n); prev, cur = cur, n
        if len(loop) > len(adj): break
    return loop


def carve_mouth(ctx, x, z, half_width, frown=0.003, hole=(1.75, 0.8, 1.0), skin_rings=7, n_seg=64,
                jaw_hinge=(0.085, 0.012), jaw_bone='jaw', head_bone='head', face_mat=1, mouth_mat=None, uv_fn=None,
                jaw_fade=None, arc_pow=0.6, cavity=None, tongue_bulge=0.0045, lip_crease=0.0018, lip_pout=0.0008,
                stitch_relax=6, stitch_grow=1, untangle=0):
    """Cut a REAL anime mouth into a closed face surface (the mouth line is where the front-view point (x, z)
    hits the face; half_width = mouth half-width):
      - the face around the mouth is replaced by a structured ring patch (stitched to the hole boundary) whose
        innermost ring is the lip line: upper and lower lip are separate vertices that coincide at rest (closed,
        slightly frowning by `frown` metres at the corners), with a pressed-in lip crease and a lower-lip pout
      - behind the lips a closed cavity pocket (roof on the head, floor on the jaw, a gentle tongue bulge);
        it gets `mouth_mat` + its own UVs (u = around the lip loop, v = depth) for paint_mouth_texture()
        — teeth are painted flat there, NEVER modelled
      - a `jaw_bone` (child of `head_bone`, hinge behind + above the mouth, x axis = avatar left-right) weighted
        to the lower lip arc, the cavity floor and the chin (jaw_fade(P) -> 0..1 limits the chin area)
    Returns a dict with the mouth frame and per-vertex tags (attributes vtp_ring / vtp_j) for mouth_shape_keys()."""
    import cleanup_lib as C
    body, arm = ctx.body, ctx.arm
    me = body.data
    BW = body.matrix_world; inv = BW.inverted()
    hw = half_width
    dg = bpy.context.evaluated_depsgraph_get()
    bvh = BVHTree.FromObject(body, dg)
    M, _ = front_hit(body, x, z, bvh)
    T0 = front_hit(body, x + 0.012, z, bvh)[0] - front_hit(body, x - 0.012, z, bvh)[0]
    B0 = front_hit(body, x, z + 0.012, bvh)[0] - front_hit(body, x, z - 0.012, bvh)[0]
    N = np.cross(T0, B0); N /= np.linalg.norm(N)
    T = T0 - N * (N @ T0); T /= np.linalg.norm(T); B = np.cross(N, T)
    def W(u, w, n=0.0): return M + u * T + w * B + n * N
    def surf(u, w):
        # front-view ray (the face is a height field in y); a ray along the tilted normal could hit the chin
        p = W(u, w)
        h, _ = front_hit(body, p[0], p[2], bvh)
        return h if h is not None else p
    lipw = lambda u: -frown * (u / hw) ** 2
    VIEW = np.array([0.0, -1.0, 0.0])
    Ru, Rup, Rdn = hole[0] * hw, hole[1] * hw, hole[2] * hw
    def e_of(u, w): return (u / Ru) ** 2 + (w / np.where(w > 0, Rup, Rdn)) ** 2
    phis = 2 * np.pi * np.arange(n_seg) / n_seg
    cph, sph = np.cos(phis), np.sin(phis)
    upper = sph > 1e-9
    # ---- skin rings (world positions, computed on the intact surface)
    K = skin_rings
    skin = []
    for k in range(1, K + 1):
        t = (k - 1) / (K - 1)
        s = 1 - (1 - t) ** 1.6
        Eu, Ew = 0.8 * Ru * cph, 0.8 * np.where(upper, Rup, Rdn) * sph
        Lu = hw * cph; Lw = lipw(Lu)
        uu, ww = Eu + (Lu - Eu) * s, Ew + (Lw - Ew) * s
        ring = []
        for j in range(n_seg):
            p = surf(uu[j], ww[j])
            dw = ww[j] - lipw(uu[j])
            lat = max(0.0, 1 - (uu[j] / (1.3 * hw)) ** 2) ** 1.5
            off = (-lip_crease * math.exp(-(dw / 0.0035) ** 2) + lip_pout * math.exp(-((dw + 0.0075) / 0.006) ** 2)) * lat
            if k == 1: off = 0.0
            ring.append(p + VIEW * off)             # along the view axis: a tilted normal would shift rings vertically
        skin.append(np.array(ring))
    lip = skin[-1]
    # ---- cavity rings relative to the lip ring: (depth, width scale, roof up, floor down, lip-line follow)
    cav = cavity or [(0.0015, 0.97, -0.0032, 0.0015, 1.0), (0.008, 0.95, 0.004, 0.007, 0.8), (0.015, 0.9, 0.010, 0.013, 0.5),
                     (0.022, 0.82, 0.012, 0.015, 0.3), (0.029, 0.68, 0.011, 0.013, 0.2), (0.035, 0.45, 0.007, 0.009, 0.1)]
    cav_rings = []
    for ci, (dep, sc, up, dn, fol) in enumerate(cav):
        ring = []
        for j in range(n_seg):
            u0 = hw * cph[j]
            du = u0 * sc - u0
            w_tgt = (up if upper[j] else dn) * sph[j] + lipw(u0 * sc) * fol - lipw(u0)
            bump = 0.0
            if not upper[j] and 1 <= ci <= 4:
                bump = tongue_bulge * max(0.0, 1 - (cph[j] / 0.62) ** 2) * math.sin(math.pi * ci / 5)
            ring.append(lip[j] + du * T + (w_tgt + bump) * B - dep * N)
        cav_rings.append(np.array(ring))
    pole = lip.mean(0) - (cav[-1][0] + 0.004) * N - 0.002 * B
    # ---- old weights (for the new vertices) before the topology changes
    names, Wold = weight_matrix(body)
    P_old = world_co(body)
    from mathutils.kdtree import KDTree
    kd = KDTree(len(P_old))
    for i, p in enumerate(P_old): kd.insert(Vector(p), i)
    kd.balance()
    # ---- cut the hole
    bm = bmesh.new(); bm.from_mesh(me)
    ring_l = bm.verts.layers.int.get('vtp_ring') or bm.verts.layers.int.new('vtp_ring')
    j_l = bm.verts.layers.int.get('vtp_j') or bm.verts.layers.int.new('vtp_j')
    bm.verts.ensure_lookup_table()
    rel = P_old - M
    uo, wo, no = rel @ T, rel @ B, rel @ N
    inside = (e_of(uo, wo) < 1.0) & (np.abs(no) < 0.03)
    kill = [f for f in bm.faces if any(inside[v.index] for v in f.verts)]
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.verts.ensure_lookup_table(); bm.edges.ensure_lookup_table()
    be = [e for e in bm.edges if e.is_boundary]
    near = lambda v: e_of(*(((np.array(BW @ v.co) - M) @ T), ((np.array(BW @ v.co) - M) @ B))) < 3.0
    be = [e for e in be if near(e.verts[0]) and near(e.verts[1])]
    loop = _order_loop([(e.verts[0], e.verts[1]) for e in be])
    lp = np.array([tuple(BW @ v.co) for v in loop])
    lu, lw = (lp - M) @ T, (lp - M) @ B
    ang = np.arctan2(lw / np.where(lw > 0, Rup, Rdn), lu / Ru) % (2 * np.pi)
    if np.sum(np.sign(((np.diff(np.r_[ang, ang[0]]) + np.pi) % (2 * np.pi)) - np.pi)) < 0:
        loop = loop[::-1]; ang = ang[::-1]
    st = int(np.argmin(ang)); loop = loop[st:] + loop[:st]; ang = np.r_[ang[st:], ang[:st]]
    ang = np.maximum.accumulate(ang)
    ang = ang + np.arange(len(ang)) * 1e-6
    print('MOUTH hole: %d faces removed, boundary loop %d verts' % (len(kill), len(loop)))
    def nv(p, ring, j):
        v = bm.verts.new(inv @ Vector(p)); v[ring_l] = ring; v[j_l] = j
        return v
    rings_v = [[nv(p, k + 1, j) for j, p in enumerate(r)] for k, r in enumerate(skin)]
    rings_v += [[nv(p, K + 1 + ci, j) for j, p in enumerate(r)] for ci, r in enumerate(cav_rings)]
    pole_v = nv(pole, 99, -1)
    skin_faces, mouth_faces = [], []
    def face(vs, lst):
        try: lst.append(bm.faces.new(vs))
        except ValueError: pass
    # hole boundary: laid exactly onto the hole ellipse (on the original surface), then zipped to ring 1 by angle
    for v, a in zip(loop, ang):
        p = surf(Ru * math.cos(a), (Rup if math.sin(a) > 0 else Rdn) * math.sin(a))
        v.co = inv @ Vector(p)
    r1 = rings_v[0]
    ev = sorted([(a, 0, i) for i, a in enumerate(ang)] + [(p, 1, j) for j, p in enumerate(phis)])
    cb = int(np.argmax(ang)); cr = n_seg - 1
    for a, kind, i in ev:
        if kind == 0:
            if i != cb: face((loop[cb], loop[i], r1[cr]), skin_faces)
            cb = i
        else:
            face((loop[cb], r1[i], r1[cr]), skin_faces); cr = i
    zf = [f for f in skin_faces if f.is_valid and len(f.verts) == 3]
    res = bmesh.ops.beautify_fill(bm, faces=zf, edges=list({e for f in zf for e in f.edges}))
    skin_faces = [f for f in skin_faces if f.is_valid] + list(res['geom'][i] for i in range(len(res['geom'])) if isinstance(res['geom'][i], bmesh.types.BMFace))
    # relax the stitch band (boundary loop, its outer neighbours, rings 1-2) and lay it back on the surface
    band = set(loop) | set(rings_v[0]) | set(rings_v[1])
    front_ = set(loop)
    for _ in range(max(1, stitch_grow)):          # stitch_grow rings of the outer mesh join the relaxed band
        nxt = set()
        for v in front_:
            for e in v.link_edges: nxt.add(e.other_vert(v))
        nxt -= band; band |= nxt; front_ = nxt
    band = list(band)
    for _ in range(stitch_relax):
        bmesh.ops.smooth_vert(bm, verts=band, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
        for v in band:
            p = BW @ v.co
            h, _ = front_hit(body, p.x, p.z, bvh)
            if h is not None: v.co = inv @ Vector(h)
    for k in range(len(rings_v) - 1):
        lst = skin_faces if k < K - 1 else mouth_faces
        for j in range(n_seg):
            j2 = (j + 1) % n_seg
            face((rings_v[k][j], rings_v[k][j2], rings_v[k + 1][j2], rings_v[k + 1][j]), lst)
    for j in range(n_seg):
        face((rings_v[-1][j], rings_v[-1][(j + 1) % n_seg], pole_v), mouth_faces)
    if mouth_mat is not None and mouth_mat.name not in [m.name for m in me.materials if m]:
        me.materials.append(mouth_mat)
    mouth_idx = [m.name for m in me.materials].index(mouth_mat.name) if mouth_mat is not None else 0
    for f in skin_faces: f.material_index = face_mat; f.smooth = True
    for f in mouth_faces: f.material_index = mouth_idx; f.smooth = True
    # safety net: any gap the stitching left (skipped duplicate faces) is filled
    gaps = [e for e in bm.edges if e.is_boundary and near(e.verts[0])]
    if gaps:
        res = bmesh.ops.holes_fill(bm, edges=gaps, sides=8)
        for f in res['faces']: skin_faces.append(f)
        print('MOUTH filled %d stitch gap faces' % len(res['faces']))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    Nn = Vector(tuple(N)); M3 = BW.to_3x3()
    structured = set(v for r in rings_v[1:] for v in r)            # lip-side rings keep their exact shape
    for it in range(untangle):                                     # folded stitch faces: relax their verts until flat
        bad = [f for f in skin_faces if f.is_valid and (M3 @ f.normal).dot(Nn) < 0.1]
        if not bad: break
        vs = set()
        for f in bad:
            for v in f.verts:
                vs.add(v)
                for e in v.link_edges: vs.add(e.other_vert(v))
        vs = [v for v in vs if v not in structured]
        bmesh.ops.smooth_vert(bm, verts=vs, factor=0.6, use_axis_x=True, use_axis_y=True, use_axis_z=True)
        for v in vs:
            p = BW @ v.co
            h, _ = front_hit(body, p.x, p.z, bvh)
            if h is not None: v.co = inv @ Vector(h)
        bm.normal_update()
    flips = sum(1 for f in skin_faces if f.is_valid and (M3 @ f.normal).dot(Nn) < 0.1)
    print('MOUTH stitch: %d skin faces, %d folded (normal against the face)' % (len(skin_faces), flips))
    if flips and os.environ.get('VTP_DEBUG'):
        for f in [f for f in skin_faces if f.is_valid and (M3 @ f.normal).dot(Nn) < 0.1][:30]:
            c = np.array(BW @ f.calc_center_median()) - M
            print('   fold u %.4f w %.4f n %.4f area %.2e dot %.2f in_loop %d' % (c @ T, c @ B, c @ N, f.calc_area(), (M3 @ f.normal).dot(Nn), sum(v in set(loop) for v in f.verts)))
    # UVs: skin = planar (face plate), cavity = (around, depth)
    uvl = bm.loops.layers.uv.active
    for f in skin_faces:
        for l in f.loops:
            l[uvl].uv = tuple(uv_fn(np.array([tuple(BW @ l.vert.co)]))[0]) if uv_fn else (0, 0)
    nr = len(cav) + 1
    for f in mouth_faces:
        us = []
        for l in f.loops:
            r, j = l.vert[ring_l], l.vert[j_l]
            v = 1.0 if r == 99 else (r - K) / nr
            us.append([None if j < 0 else j / n_seg, v])
        known = [u for u, _ in us if u is not None]
        if max(known) - min(known) > 0.5: us = [[(u + 1 if u is not None and u < 0.5 else u), v] for u, v in us]
        mu = float(np.mean([u for u, _ in us if u is not None]))
        for l, (u, v) in zip(f.loops, us): l[uvl].uv = (mu if u is None else u, v)
    bm.to_mesh(me); bm.free(); me.update()
    # ---- jaw bone
    bpy.context.view_layer.objects.active = arm
    for o in bpy.context.view_layer.objects: o.select_set(False)
    arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    ainv = arm.matrix_world.inverted()
    # hinge behind the mouth along the VIEW axis and a little above it, so the chin swings DOWN (a hinge
    # placed along a tilted face normal would swing the lip backwards into the head)
    hj = M - VIEW * jaw_hinge[0] + np.array([0, 0, jaw_hinge[1]])
    tj = M + np.array([0, 0, -0.03]) + VIEW * 0.005
    jb = eb.get(jaw_bone) or eb.new(jaw_bone)
    jb.head = ainv @ Vector(hj); jb.tail = ainv @ Vector(tj)
    yv = (tj - hj) / np.linalg.norm(tj - hj); xv = np.array([1.0, 0, 0]); zv = np.cross(xv, yv); zv /= np.linalg.norm(zv)
    jb.align_roll(ainv.to_3x3() @ Vector(zv))
    jb.parent = eb[head_bone]; jb.use_deform = True; jb.use_connect = False
    bpy.ops.object.mode_set(mode='OBJECT')
    # ---- weights
    Pn = world_co(body)
    ring = np.zeros(len(Pn), np.int64); jj = np.zeros(len(Pn), np.int64)
    me.attributes['vtp_ring'].data.foreach_get('value', ring); me.attributes['vtp_j'].data.foreach_get('value', jj)
    names_now = [g.name for g in body.vertex_groups]
    Wn = np.zeros((len(Pn), len(names)), np.float32)
    _, Wcur = weight_matrix(body)
    for gi, n in enumerate(names_now):
        if n in names: Wn[:, names.index(n)] = Wcur[:, gi]
    new = np.nonzero(ring != 0)[0]
    for i in new:
        _, k0, _ = kd.find(Vector(Pn[i])); Wn[i] = Wold[k0]
    r = Pn - M
    u_, w_, n_ = r @ T, r @ B, r @ N
    below = smoothstep(0.002, -0.014, w_ - lipw(np.clip(u_, -hw, hw)))
    lateral = 1 - smoothstep(1.3 * hw, 2.8 * hw, np.abs(u_))
    fj = below * lateral * (n_ > -0.06) * (np.abs(u_) < 0.12)
    if jaw_fade is not None: fj = fj * np.clip(jaw_fade(Pn), 0, 1)
    arc = np.abs(np.sin(2 * np.pi * np.maximum(jj, 0) / n_seg)) ** arc_pow
    is_low = (np.sin(2 * np.pi * np.maximum(jj, 0) / n_seg) < -1e-9)
    sk = (ring >= 1) & (ring <= K)
    t_ = np.clip((ring - 1) / (K - 1), 0, 1); s_ = 1 - (1 - t_) ** 1.6
    fj = np.where(sk, fj * (1 - s_) + np.where(is_low, arc, 0) * s_, fj)
    cv = (ring > K) & (ring < 99)
    q = np.clip((ring - K) / len(cav), 0, 1)
    fj = np.where(cv, np.where(is_low, arc + (1 - arc) * q * 0.7, 0.0), fj)
    fj = np.where(ring == 99, 0.45, fj)
    names2 = names + ([jaw_bone] if jaw_bone not in names else [])
    Wn2 = np.zeros((len(Pn), len(names2)), np.float32); Wn2[:, :len(names)] = Wn
    Wn2 *= (1 - fj)[:, None]; Wn2[:, names2.index(jaw_bone)] += fj
    set_weights(body, names2, Wn2)
    print('MOUTH jaw bone %s: hinge %s, %d verts weighted (max %.2f), %d new verts' % (jaw_bone, np.round(hj, 3), int((fj > 0.01).sum()), fj.max(), len(new)))
    return dict(M=M, T=T, B=B, N=N, hw=hw, frown=frown, K=K, C=len(cav), n_seg=n_seg, cav=cav)


def mouth_shape_keys(ctx, info, scale=1.0):
    """ARKit mouth shapes on the carved mouth (avatar left = +x): mouthSmile/Frown/Stretch/Press Left|Right,
    mouthPucker, mouthFunnel. The cavity follows its lip ring (damped with depth) so nothing tears."""
    body = ctx.body; me = body.data
    M, T, B, N, hw = info['M'], info['T'], info['B'], info['N'], info['hw']
    K, n_seg = info['K'], info['n_seg']
    Pn = world_co(body)
    ring = np.zeros(len(Pn), np.int64); jj = np.zeros(len(Pn), np.int64)
    me.attributes['vtp_ring'].data.foreach_get('value', ring); me.attributes['vtp_j'].data.foreach_get('value', jj)
    lipw = lambda u: -info['frown'] * (u / hw) ** 2
    r = Pn - M
    u, w, n = r @ T, r @ B, r @ N
    ld = w - lipw(np.clip(u, -hw, hw))
    cav = (ring > K)
    # cavity verts take the local coordinates of their lip-ring vertex, damped by depth
    lipring = {}
    for i in np.nonzero(ring == K)[0]: lipring[jj[i]] = i
    src = np.arange(len(Pn))
    damp = np.ones(len(Pn))
    for i in np.nonzero(cav)[0]:
        if ring[i] == 99: src[i] = lipring.get(0, i); damp[i] = 0.1; continue
        src[i] = lipring.get(jj[i], i)
        depth = info['cav'][ring[i] - K - 1][0]
        damp[i] = math.exp(-depth / 0.012)
    us, lds = u[src], ld[src]
    side = np.where(ring[src] >= 1, np.where(np.sin(2 * np.pi * np.maximum(jj[src], 0) / n_seg) > 1e-9, 1.0, -1.0), np.sign(lds + 1e-9))
    region = ((np.abs(u) < 3.2 * hw) & (w > -0.05) & (w < 0.035) & (np.abs(n) < 0.04)) | (ring > 0)
    g = lambda a: np.exp(-a)
    def key(du, dw, dn):
        d = (du[:, None] * T + dw[:, None] * B + dn[:, None] * N) * (damp * region)[:, None] * scale
        return d
    keys = {}
    for s, nm in ((1.0, 'Left'), (-1.0, 'Right')):
        gC = g(((us - s * hw) / (0.95 * hw)) ** 2 + (lds / 0.016) ** 2)
        gL = smoothstep(-0.2 * hw, 0.9 * hw, s * us) * g((lds / 0.012) ** 2)
        keys['mouthSmile' + nm] = key(gC * 0.004 * s, gC * 0.010 + gL * 0.003 * np.clip(us / hw, -1.2, 1.2) ** 2, gC * -0.002)
        keys['mouthFrown' + nm] = key(gC * 0.0012 * s, gC * -0.008, gC * 0.0)
        keys['mouthStretch' + nm] = key(gC * 0.008 * s, gC * -0.003, gC * -0.0015)
        hP = smoothstep(-0.3 * hw, 0.3 * hw, s * us) * g((lds / 0.01) ** 2) * np.clip(1 - (us / (1.3 * hw)) ** 2, 0, 1)
        keys['mouthPress' + nm] = key(hP * 0.0, -0.35 * lds * hP, hP * -0.002)
    gp = g((us / (1.4 * hw)) ** 2 + (lds / 0.016) ** 2)
    keys['mouthPucker'] = key(-0.55 * us * gp, -0.35 * lds * gp, 0.013 * gp)
    op = side * 0.006 * g((us / (0.75 * hw)) ** 2) * g((lds / 0.01) ** 2)
    keys['mouthFunnel'] = key(-0.35 * us * gp, op - 0.2 * lds * gp, 0.007 * gp)
    # tongueOut: the painted tongue (cavity floor centre) slides out over the lower lip — a flat anime ':P'
    cphi = np.cos(2 * np.pi * np.maximum(jj, 0) / n_seg); sphi = np.sin(2 * np.pi * np.maximum(jj, 0) / n_seg)
    dep = np.array([info['cav'][r - K - 1][0] if K < r < 99 else (info['cav'][-1][0] + 0.004 if r == 99 else 0.0) for r in ring])
    tw = np.clip(1 - (cphi / 0.7) ** 2, 0, 1) ** 0.5 * ((ring >= K + 2) & (sphi < 0))
    qd = dep / (info['cav'][-1][0] + 0.004)                 # 0 at the lips .. 1 at the back: becomes base .. tip
    reach = (dep + 0.003 + 0.016 * qd) * tw
    keys['tongueOut'] = (reach[:, None] * N[None] - ((0.004 + 0.008 * qd) * tw)[:, None] * B[None] + (0.15 * u * tw)[:, None] * T[None]) * scale
    if not me.shape_keys: body.shape_key_add(name='Basis', from_mix=False)
    Mi = np.array(body.matrix_world.inverted())
    for nm, d in keys.items():
        kb = body.data.shape_keys.key_blocks.get(nm) or body.shape_key_add(name=nm, from_mix=False)
        Q = Pn + d
        kb.data.foreach_set('co', (Q @ Mi[:3, :3].T + Mi[:3, 3]).ravel())
        kb.value = 0.0; kb.slider_min = 0.0; kb.slider_max = 1.0
    print('MOUTH shape keys:', ', '.join('%s %.1fmm' % (k, 1000 * np.linalg.norm(v, axis=1).max()) for k, v in keys.items()))


def paint_mouth_texture(path, size=(512, 256), lip_band=0.03, teeth=(0.03, 0.15), teeth_width=0.78, tongue=(0.62, 0.4, 0.66),
                        colors=None):
    """flat anime mouth interior in (around-the-lips u, depth v) space: a dark lip-edge band (reads as the
    mouth outline when it opens), a FLAT white upper-teeth band (never geometry), maroon cavity darkening
    toward the throat, a flat pink tongue on the floor. u: 0..0.5 = upper (roof), 0.5..1 = lower (floor)."""
    c = dict(lip='#3b1a14', interior='#5a1a24', throat='#2c0a12', teeth='#fbf7ee', teeth_edge='#c9c2b8',
             tongue='#c9606d', tongue_edge='#8c3242', tongue_hi='#df8a92')
    c.update(colors or {})
    Wd, Hd = size
    uu, vv = np.meshgrid((np.arange(Wd) + 0.5) / Wd, (np.arange(Hd) + 0.5) / Hd)
    phi = uu * 2 * np.pi
    cs, sn = np.cos(phi), np.sin(phi)
    px = 1.0 / Hd
    aa = lambda d: np.clip(0.5 - d / px, 0, 1)
    img = hexrgb(c['interior']) * (1 - smoothstep(0.3, 1.0, vv))[..., None] + hexrgb(c['throat']) * smoothstep(0.3, 1.0, vv)[..., None]
    def put(col, a):
        nonlocal img
        img = img * (1 - a[..., None]) + hexrgb(col) * a[..., None]
    up = sn > 0
    tA = aa(np.maximum(teeth[0] - vv, vv - teeth[1])) * aa(np.abs(cs) - teeth_width) * up
    put(c['teeth'], tA)
    put(c['teeth_edge'], aa(np.abs(vv - teeth[1]) - 0.012) * aa(np.abs(cs) - teeth_width) * up * 0.8)
    q0, qr, cw = tongue
    td = np.sqrt((cs / cw) ** 2 + ((vv - q0) / qr) ** 2) - 1
    low = sn < 0
    put(c['tongue_edge'], aa(td * qr) * low)
    put(c['tongue'], aa(td * qr + 0.02) * low)
    hd = np.sqrt((cs / (cw * 0.35)) ** 2 + ((vv - q0 + 0.05) / (qr * 0.3)) ** 2) - 1
    put(c['tongue_hi'], aa(hd * qr * 0.3) * low * 0.8)
    put(c['lip'], aa(vv - lip_band))
    return save_image_np(img[::-1], path)


def paint_mouth_line(face_img_path, out_path, world_to_px, x, z, half_width, frown, width=0.0017, color='#3b1a14',
                     lower_lip=(0.0085, 0.55, 0.0012), corner_tick=0.0):
    """draw the closed-mouth line (+ a short lower-lip stroke) into the face-plate art where the carved lip line
    is: world_to_px(x, z) -> (col, row) in the face image. The stroke straddles the slit, so when the jaw opens
    both lips keep an anime outline."""
    img = load_image_np(face_img_path)
    Hh, Ww = img.shape[:2]
    (c0, r0), (c1, r1) = world_to_px(x, z), world_to_px(x + 0.01, z)
    ppm = abs(c1 - c0) / 0.01
    cols, rows = np.meshgrid(np.arange(Ww) + 0.5, np.arange(Hh) + 0.5)
    X = x + (cols - c0) / ppm; Z = z - (rows - r0) / ppm
    u = X - x; wv = Z - z
    uc = np.clip(u, -half_width, half_width)
    d_line = np.hypot(u - uc, wv - (-frown * (uc / half_width) ** 2))
    taper = 1 - 0.55 * (np.abs(uc) / half_width) ** 3
    a = np.clip(0.5 - (d_line - width * 0.5 * taper) * ppm, 0, 1)
    ldy, lfrac, lw = lower_lip
    ul = np.clip(u, -half_width * lfrac, half_width * lfrac)
    d_low = np.hypot(u - ul, wv - (-ldy + 0.0015 * (ul / (half_width * lfrac)) ** 2))
    tl = 1 - (np.abs(ul) / (half_width * lfrac)) ** 2
    a2 = np.clip(0.5 - (d_low - lw * 0.5 * tl) * ppm, 0, 1) * 0.55
    col = hexrgb(color)
    out = img.copy()
    for aa_ in (a2, a):
        out[..., :3] = out[..., :3] * (1 - aa_[..., None]) + col * aa_[..., None]
    return save_image_np(out, out_path)


# ------------------------------------------------------------------ relief from painted art (moustache, brows, beards)
def _erode(m, r):
    out = m.copy()
    for _ in range(r):
        o = out.copy()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            o &= np.roll(np.roll(out, dy, 0), dx, 1)
        out = o
    return out


def _dilate(m, r):
    return ~_erode(~m, r)


def relief_from_image(ob, img_path, world_to_px, select, height=0.006, ramp_px=8, open_px=3, weight=None, direction=(0, -1, 0), blur_px=2):
    """Raise painted features (a moustache ...) into real relief so they read in 3/4 views and cast toon
    shading, exactly where the art draws them. select(rgb (H,W,3)) -> bool mask; thin strokes (face line art)
    are removed by an opening of open_px; the height ramps up over ramp_px pixels from the mask edge.
    world_to_px(X, Z arrays) -> (col, row) into the image; displacement along `direction` (toward the viewer)."""
    img = load_image_np(img_path)[..., :3]
    m = select(img)
    m = _dilate(_erode(m, open_px), open_px)
    d = np.zeros(m.shape, np.float32); cur = m.copy()
    for k in range(ramp_px):
        d += cur; cur = _erode(cur, 1)
        if not cur.any(): break
    hmap = (d / ramp_px) ** 0.7
    for _ in range(blur_px):
        hmap = (hmap + np.roll(hmap, 1, 0) + np.roll(hmap, -1, 0) + np.roll(hmap, 1, 1) + np.roll(hmap, -1, 1)) / 5
    P = world_co(ob)
    col, row = world_to_px(P[:, 0], P[:, 2])
    h = bilinear(hmap[..., None], col - 0.5, row - 0.5)[:, 0]
    inside = (col >= 0) & (row >= 0) & (col < img.shape[1]) & (row < img.shape[0])
    w = np.ones(len(P)) if weight is None else np.clip(weight(P), 0, 1)
    disp = height * h * inside * w
    P = P + np.array(direction, float)[None] * disp[:, None]
    set_world_co(ob, P)
    print('RELIEF %s: %d verts raised (max %.1f mm), mask %d px' % (os.path.basename(img_path), int((disp > 1e-4).sum()), 1000 * disp.max(), m.sum()))
    return hmap


def toe_shapes(ctx, sides=('left', 'right'), n=4, length=0.1, radius=0.021, spread=0.55, tip=1.35, sole=None, start_back=0.02):
    """webbed-foot toes (frog / mascot feet) as capsule shapes to fuse into rebuild_body(add=...): n toes fanned
    over `spread` radians from the toes bone, flat on the floor, round pads at the tips"""
    import cleanup_lib as C
    obs = []
    for side in sides:
        th, tt = ctx.bone_head(side + 'Toes'), ctx.arm.matrix_world @ ctx.arm.data.bones[side + 'Toes'].tail_local
        d = Vector((tt.x - th.x, tt.y - th.y, 0)).normalized()
        z = (sole if sole is not None else 0.0) + radius
        base = Vector((th.x, th.y, z)) - d * start_back
        def build(bm2, base=base, d=d):
            for i in range(n):
                a = (i / (n - 1) - 0.5) * spread
                di = (Matrix.Rotation(a, 3, 'Z') @ d).normalized()
                L = length * (1 - 0.18 * abs(i / (n - 1) - 0.5) * 2)
                end = base + di * L
                R = Vector((0, 1, 0)).rotation_difference(di).to_matrix()
                C._ellipsoid(bm2, (base + end) / 2, (radius, L / 2 + radius * 0.5, radius * 0.8), R, seg=16, rings=10)
                C._ellipsoid(bm2, end, (radius * tip, radius * tip, radius * 0.85), R, seg=16, rings=10)
        obs.append(C.new_object('Toes_' + side, build, '#5c8144'))
    return obs


# ------------------------------------------------------------------ analytic design painting (v5 additions)
# Paint a flat anime texture from DESIGNED shapes instead of votes from the reference views: per-vertex
# signed distance fields (metres, < 0 inside) for belly panels / spots / patches go into Painter.F, so the
# Painter's per-triangle gradient renderer draws exact anti-aliased edges and world-width outlines.
def polygon_sd_2d(Q, poly):
    """signed distance of 2-D points Q (N,2) to a closed polygon (M,2), < 0 inside"""
    Q = np.asarray(Q, float); A = np.asarray(poly, float); B = np.roll(A, -1, 0)
    d = np.full(len(Q), np.inf); inside = np.zeros(len(Q), bool)
    for a, b in zip(A, B):
        ab = b - a; t = np.clip(((Q - a) @ ab) / max(ab @ ab, 1e-18), 0, 1)
        d = np.minimum(d, np.linalg.norm(Q - (a + t[:, None] * ab), axis=1))
        c = ((a[1] > Q[:, 1]) != (b[1] > Q[:, 1])) & (Q[:, 0] < (b[0] - a[0]) * (Q[:, 1] - a[1]) / (b[1] - a[1] + 1e-18) + a[0])
        inside ^= c
    return np.where(inside, -d, d)


def spot_sd(P, N, spots, clip=0.06):
    """signed distance field of elliptical spots lying on a surface. spots = [(centre, normal, major_dir, a, b)]
    (world, a/b = semi-axes in metres). A vertex only sees spots its normal agrees with (no bleed through
    thin parts), first-order ellipse distance f / |grad f|."""
    sd = np.full(len(P), clip)
    for c, n, t1, a, b in spots:
        c, n, t1 = (np.asarray(v, float) for v in (c, n, t1))
        t1 = t1 - n * (n @ t1); t1 /= np.linalg.norm(t1); t2 = np.cross(n, t1)
        q = P - c
        u, v, w = q @ t1, q @ t2, q @ n
        f = (u / a) ** 2 + (v / b) ** 2 - 1
        g = 2 * np.hypot(u / a ** 2, v / b ** 2)
        d = f / np.maximum(g, 1e-6)
        ok = ((N @ n) > 0.2) & (np.abs(w) < 0.5 * max(a, b) + 0.015) & (np.abs(u) < 2.5 * a) & (np.abs(v) < 2.5 * b)
        sd = np.where(ok, np.minimum(sd, np.clip(d, -clip, clip)), sd)
    return sd


def surface_hit(ob, origin, direction, bvh=None):
    """first hit of a world ray on ob: (point, normal) or (None, None)"""
    if bvh is None: bvh = BVHTree.FromObject(ob, bpy.context.evaluated_depsgraph_get())
    inv = ob.matrix_world.inverted()
    loc, n, _, _ = bvh.ray_cast(inv @ Vector(origin), (inv.to_3x3() @ Vector(direction)).normalized())
    if loc is None: return None, None
    return np.array(ob.matrix_world @ loc), np.array((ob.matrix_world.to_3x3() @ n).normalized())


def relief_from_map(ob, hmap, world_to_px, weight=None, direction=(0, -1, 0)):
    """displace vertices by a precomputed height map (metres, (H,W) array, row 0 = top) sampled at
    world_to_px(X, Z) -> (col, row); e.g. a moustache relief authored together with its face art"""
    P = world_co(ob)
    col, row = world_to_px(P[:, 0], P[:, 2])
    Hh, Ww = hmap.shape
    inside = (col >= 0) & (row >= 0) & (col < Ww - 1) & (row < Hh - 1)
    h = bilinear(np.asarray(hmap, np.float32)[..., None], col - 0.5, row - 0.5)[:, 0] * inside
    w = np.ones(len(P)) if weight is None else np.clip(weight(P), 0, 1)
    disp = h * w
    set_world_co(ob, P + np.array(direction, float)[None] * disp[:, None])
    print('RELIEF map: %d verts raised (max %.1f mm)' % (int((disp > 1e-4).sum()), 1000 * disp.max()))
    return disp


def _painter_strokes(self, strokes, color, sign=+1, where=None, min_facing=0.2, alpha=1.0):
    """tapered ink strokes drawn in an orthographic view projection (front sign=+1 looks along +y): strokes =
    [[(x, z, width_m), ...], ...] world polylines (densified linearly); only texels facing the view"""
    Q2 = self.Pt[:, [0, 2]]
    m = (-sign * self.Nt[:, 1] > min_facing)
    if where is not None: m &= where(self.Pt)
    idx = np.nonzero(m)[0]
    best = np.full(len(idx), np.inf)
    for s in strokes:
        S = np.asarray(s, float)
        # Catmull-Rom densify
        Pp = np.vstack([2 * S[0] - S[1], S, 2 * S[-1] - S[-2]]); D = []
        for i in range(1, len(Pp) - 2):
            p0, p1, p2, p3 = Pp[i - 1], Pp[i], Pp[i + 1], Pp[i + 2]
            for t in np.linspace(0, 1, 10, endpoint=False):
                D.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
        D.append(S[-1]); D = np.array(D)
        lo, hi = D[:, :2].min(0) - D[:, 2].max(), D[:, :2].max(0) + D[:, 2].max()
        sub = np.nonzero((Q2[idx, 0] > lo[0]) & (Q2[idx, 0] < hi[0]) & (Q2[idx, 1] > lo[1]) & (Q2[idx, 1] < hi[1]))[0]
        q = Q2[idx[sub]]
        for a, b in zip(D[:-1], D[1:]):
            ab = b[:2] - a[:2]; t = np.clip(((q - a[:2]) @ ab) / max(ab @ ab, 1e-18), 0, 1)
            d = np.linalg.norm(q - (a[:2] + t[:, None] * ab), axis=1) - (a[2] + (b[2] - a[2]) * t) / 2
            best[sub] = np.minimum(best[sub], d)
    a_ = np.zeros(len(self.Pt))
    a_[idx] = np.clip(0.5 - best * self.ppm[idx], 0, 1) * alpha
    self.overlay(hexrgb(color), a_)
    print('PAINT strokes: %d texels' % int((a_ > 0.3).sum()))


Painter.strokes = _painter_strokes


def smooth_normals(ob, iters=40, keep=None, lam=0.5, mu=-0.53, strong=None, strong_iters=150):
    """Toon-friendly shading: custom vertex normals taken from a Taubin-faired COPY of the surface (geometry is
    untouched), so cel-shadow terminators run as clean curves instead of following remesh noise.
    keep(P world) -> 0..1 keeps the true normals (faces, reliefs, mouth) where 1."""
    me = ob.data
    P = world_co(ob)
    E = edge_array(me)
    Ps = taubin(P, E, np.ones(len(P)), iters, lam, mu)
    tmp = me.copy()
    Mi = np.array(ob.matrix_world.inverted())
    tmp.vertices.foreach_set('co', (Ps @ Mi[:3, :3].T + Mi[:3, 3]).ravel()); tmp.update()
    ns = np.empty(len(P) * 3); tmp.vertices.foreach_get('normal', ns); ns = ns.reshape(-1, 3)
    if strong is not None:          # creases full of voxel stair-steps: normals from a much smoother copy there
        sw = np.clip(strong(P), 0, 1)
        Ps2 = taubin(Ps, E, np.ones(len(P)), strong_iters, lam, mu)
        tmp.vertices.foreach_set('co', (Ps2 @ Mi[:3, :3].T + Mi[:3, 3]).ravel()); tmp.update()
        n2 = np.empty(len(P) * 3); tmp.vertices.foreach_get('normal', n2); n2 = n2.reshape(-1, 3)
        ns = ns * (1 - sw)[:, None] + n2 * sw[:, None]
    bpy.data.meshes.remove(tmp)
    n0 = np.empty(len(P) * 3); me.vertices.foreach_get('normal', n0); n0 = n0.reshape(-1, 3)
    k = np.zeros(len(P)) if keep is None else np.clip(keep(P), 0, 1)
    n = ns * (1 - k)[:, None] + n0 * k[:, None]
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
    me.normals_split_custom_set_from_vertices([tuple(v) for v in n])
    print('NORMALS smoothed (%d iters), kept on %d verts' % (iters, int((k > 0.5).sum())))


def fix_folds(ob, where=None, rounds=10, thr=0.2, smooth_iters=20):
    """repair folded slivers (faces flipped against the local surface, e.g. voxel stair-steps in tight creases):
    the local surface direction comes from a heavily faired copy; offending faces' vertices are relaxed until
    they agree. where(P world) -> bool limits the region. Returns the number of folds left."""
    me = ob.data
    for r in range(rounds):
        P = world_co(ob)
        Ps = taubin(P, edge_array(me), np.ones(len(P)), smooth_iters)
        tmp = me.copy(); Mi = np.array(ob.matrix_world.inverted())
        tmp.vertices.foreach_set('co', (Ps @ Mi[:3, :3].T + Mi[:3, 3]).ravel()); tmp.update()
        fs = np.empty(len(tmp.polygons) * 3); tmp.polygons.foreach_get('normal', fs); fs = fs.reshape(-1, 3)
        bpy.data.meshes.remove(tmp)
        fn = np.empty(len(me.polygons) * 3); me.polygons.foreach_get('normal', fn); fn = fn.reshape(-1, 3)
        pc = np.empty(len(me.polygons) * 3); me.polygons.foreach_get('center', pc); pc = pc.reshape(-1, 3)
        M = np.array(ob.matrix_world); pcw = pc @ M[:3, :3].T + M[:3, 3]
        bad = (fn * fs).sum(1) < thr
        if where is not None: bad &= where(pcw)
        nb = int(bad.sum())
        if r == 0 or nb == 0: print('FOLDS round %d: %d folded faces' % (r, nb))
        if nb == 0: return 0
        bm = bmesh.new(); bm.from_mesh(me); bm.faces.ensure_lookup_table()
        vs = set()
        for i in np.nonzero(bad)[0]:
            for v in bm.faces[i].verts:
                vs.add(v)
                for e in v.link_edges: vs.add(e.other_vert(v))
        vs = [v for v in vs if not v.is_boundary]
        for _ in range(3):
            bmesh.ops.smooth_vert(bm, verts=vs, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
        bm.to_mesh(me); bm.free(); me.update()
    print('FOLDS left after %d rounds: %d' % (rounds, nb))
    return nb
