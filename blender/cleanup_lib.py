"""
Shared cleanup tools for AI-generated, auto-rigged avatars (see assets/builtin/*/cleanup_*.py).

    import sys; sys.path.insert(0, <VTube Pro>/blender); import cleanup_lib as C
    ctx = C.load(src_glb)                           # armature + main body mesh, animations dropped
    tex = C.Texture(ctx.body); ...; tex.save()      # numpy recolouring helpers (blur, otsu, palette bands)
    C.smooth_body(ctx, exclude=...)                 # guarded Laplacian smoothing (restores NaN/blow-ups)
    C.fix_elbows(ctx)                               # flatten AI elbow spikes, round the joint, blend its weights
    C.replace_hands(ctx, ...)                       # clean hands/gloves + finger bones, wrist band over the cut
    C.lens_disc(ctx, center, normal, radius)        # clean domed glass over an eye lens ('Lens' material)
    C.fix_unweighted(ctx.body); C.export(ctx, out_glb)
Existing bones are never moved (costumes built for the base keep binding).
"""
import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.kdtree import KDTree


class Ctx:
    def __init__(self, arm, body):
        self.arm, self.body, self.extra = arm, body, []
        self.BW = body.matrix_world

    def bone_head(self, n):
        return self.arm.matrix_world @ self.arm.data.bones[n].head_local


def load(src, keep=()):
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.import_scene.gltf(filepath=src)
    for o in bpy.data.objects:
        if o.animation_data: o.animation_data.action = None
    arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    body = max((o for o in bpy.data.objects if o.type == 'MESH'), key=lambda o: len(o.data.vertices))
    for o in [o for o in bpy.data.objects if o.type == 'MESH' and o is not body and o.name not in keep]:
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.context.view_layer.update()
    return Ctx(arm, body)


def srgb(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])


def lin(c):
    c = np.asarray(c, float)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


# ------------------------------------------------------------------ texture
def rgb_to_hsv(a):
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx, mn = a.max(-1), a.min(-1)
    d = mx - mn + 1e-9
    h = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) / 6
    return h, np.where(mx > 0, d / (mx + 1e-9), 0), mx


def blur(a, r):
    out = a.astype(np.float32)
    for ax in (0, 1):
        c = np.cumsum(np.pad(out, [(r + 1, r) if i == ax else (0, 0) for i in range(out.ndim)], mode='edge'), axis=ax)
        hi = np.take(c, np.arange(2 * r + 1, c.shape[ax]), axis=ax)
        lo = np.take(c, np.arange(0, c.shape[ax] - 2 * r - 1), axis=ax)
        out = (hi - lo) / (2 * r + 1)
    return out


class Texture:
    def __init__(self, body):
        self.body = body
        img = None
        for mat in body.data.materials:
            for n in mat.node_tree.nodes:
                if n.type == 'TEX_IMAGE' and n.image and (img is None or n.image.size[0] > img.size[0]):
                    img = n.image
        self.img = img
        self.W, self.H = img.size
        px = np.empty(self.W * self.H * 4, np.float32)
        img.pixels.foreach_get(px)
        self.px = px.reshape(self.H, self.W, 4)
        self.rgb = self.px[..., :3].copy()
        self.h, self.s, self.v = rgb_to_hsv(self.rgb)
        rb = blur(self.rgb, 2)
        self.bh, self.bs, self.bv = rgb_to_hsv(rb)

    def region_mask(self, pred):
        """texels covered by faces whose WORLD centre satisfies pred(Vector) (bbox fill, generous)"""
        BW = self.body.matrix_world
        return self.faces_mask([p.index for p in self.body.data.polygons if pred(BW @ p.center)])

    def faces_mask(self, polys, exact=False, grow=2):
        """texels covered by the given polygon indices (bbox fill, generous; exact=True rasterises the actual
        triangles, grown by `grow` texels, so nothing from neighbouring UV islands gets caught)"""
        me = self.body.data
        uv = np.empty(len(me.loops) * 2, np.float32); me.uv_layers.active.data.foreach_get('uv', uv); uv = uv.reshape(-1, 2)
        m = np.zeros((self.H, self.W), bool)
        if exact:
            for pi in polys:
                li = list(me.polygons[pi].loop_indices)
                P = uv[li] * (self.W, self.H) - 0.5
                for k in range(1, len(li) - 1):
                    a, b, c = P[0], P[k], P[k + 1]
                    x0, y0 = np.floor(np.minimum(np.minimum(a, b), c) - grow).astype(int)
                    x1, y1 = np.ceil(np.maximum(np.maximum(a, b), c) + grow).astype(int)
                    x0, y0 = max(x0, 0), max(y0, 0); x1, y1 = min(x1, self.W - 1), min(y1, self.H - 1)
                    if x1 < x0 or y1 < y0: continue
                    X, Y = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
                    pts = np.stack([X, Y], -1).astype(np.float64)
                    # distance to the triangle <= grow  (inside test via edge functions, else edge distance)
                    def edge(p0, p1):
                        e = p1 - p0; L = max(np.hypot(*e), 1e-9)
                        return ((pts[..., 0] - p0[0]) * e[1] - (pts[..., 1] - p0[1]) * e[0]) / L
                    area = (b - a)[0] * (c - a)[1] - (b - a)[1] * (c - a)[0]
                    sg = 1 if area > 0 else -1
                    d = np.minimum(np.minimum(-sg * edge(a, b), -sg * edge(b, c)), -sg * edge(c, a))
                    m[y0:y1 + 1, x0:x1 + 1] |= d >= -grow
            return m
        for pi in polys:
            poly = me.polygons[pi]
            li = list(poly.loop_indices)
            u = uv[li, 0] * self.W; v = uv[li, 1] * self.H
            m[int(max(0, v.min() - 1)):int(min(self.H - 1, v.max() + 1)) + 1, int(max(0, u.min() - 1)):int(min(self.W - 1, u.max() + 1)) + 1] = True
        return m

    def remap(self, mask, target, shade_r=10, amp=0.35):
        """flat target colour, keeping only smooth (blurred) relative shading"""
        if not mask.any(): return
        t = srgb(target)
        shade = blur(self.v[..., None], shade_r)[..., 0] if shade_r else self.v
        ref = np.median(shade[mask])
        k = 1 + np.clip(shade[mask] / max(ref, 1e-3) - 1, -0.45, 0.35) * amp
        self.rgb[mask] = np.clip(t[None, :] * k[:, None], 0, 1)

    def soften(self, mask, r=6, feather=3, flat=0.0):
        """blur painted detail inside mask (normalised, so nothing bleeds in from other UV islands), feathered edge;
        flat>0 also pulls it toward the mask's median colour (evens out baked shading split over many UV islands)"""
        if not mask.any(): return
        mf = mask.astype(np.float32)[..., None]
        bl = blur(self.rgb * mf, r) / np.maximum(blur(mf, r), 1e-4)
        if flat:
            bl = bl * (1 - flat) + np.median(self.rgb[mask], axis=0)[None, None, :] * flat
        k = np.clip(blur(mf, feather), 0, 1) * mf
        self.rgb = self.rgb * (1 - k) + bl * k

    def bands(self, mask, palette, shade_r=6, amp=0.2):
        """quantise a region into N tones by blurred lightness (camo): palette dark → light"""
        if not mask.any(): return
        lv = blur(self.v[..., None], 3)[..., 0]
        qs = np.percentile(lv[mask], np.linspace(0, 100, len(palette) + 1)[1:-1])
        idx = np.digitize(lv, qs)
        for i, col in enumerate(palette):
            self.remap(mask & (idx == i), col, shade_r=shade_r, amp=amp)

    def save(self):
        self.px[..., :3] = self.rgb
        self.img.pixels.foreach_set(self.px.ravel())
        self.img.pack()


# ------------------------------------------------------------------ geometry
def smooth_body(ctx, include, iters=4, factor=0.35, max_move=0.03):
    me = ctx.body.data; BW = ctx.BW
    bm = bmesh.new(); bm.from_mesh(me)
    vs = [v for v in bm.verts if include(BW @ v.co)]
    orig = {v: v.co.copy() for v in vs}
    for _ in range(iters):
        bmesh.ops.smooth_laplacian_vert(bm, verts=vs, lambda_factor=factor, lambda_border=0.0,
                                        use_x=True, use_y=True, use_z=True, preserve_volume=True)
    bad = 0
    for v, c0 in orig.items():       # degenerate AI triangles can blow up / NaN — put those back
        if not all(math.isfinite(x) for x in v.co) or (v.co - c0).length > max_move:
            v.co = c0; bad += 1
    bm.to_mesh(me); bm.free(); me.update()
    print('SMOOTH', len(vs), 'verts, restored', bad)


def _welded(me):
    """uid per vertex (UV-seam duplicates share one) + neighbour lists on the welded topology"""
    co = np.empty(len(me.vertices) * 3); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    key = {}
    uid = np.array([key.setdefault((round(x, 6), round(y, 6), round(z, 6)), len(key)) for x, y, z in co])
    ev = np.empty(len(me.edges) * 2, np.int64); me.edges.foreach_get('vertices', ev); ev = uid[ev.reshape(-1, 2)]
    nb = [set() for _ in range(len(key))]
    for a, b in ev:
        if a != b: nb[a].add(b); nb[b].add(a)
    first = np.zeros(len(key), np.int64); first[uid[::-1]] = np.arange(len(uid))[::-1]
    return uid, [np.fromiter(n, np.int64) for n in nb], first


def _smoothstep(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def fix_elbows(ctx, sides=('left', 'right'), ref_u=(-0.08, -0.04), ref_f=(0.05, 0.09), pct=45, clamp_s=0.07,
               tol=(0.02, 0.25), soft=0.003, core=(0.025, 0.07), smooth_s=(0.03, 0.1), iters=16, weight_band=0.07,
               max_move=0.09):
    """Round the elbows of AI meshes (Meshy loves a horn on the olecranon).

    Per side, around the upperArm→lowerArm joint (bone heads, never moved):
      1. arm-capsule frame: s = signed position along shoulder→elbow→wrist chain (0 at the joint; the convex
         wedge behind the joint maps to s=0, so its reference surface is a sphere cap), r = distance to the chain,
         theta = azimuth around the arm (0 = convex/olecranon side)
      2. reference radius R(theta) measured on clean rings above (ref_u) and below (ref_f) the joint (low
         percentile per azimuth bin), narrowing to the slimmer of the two at the joint; vertices sticking out
         past R*(1+tol) are soft-clamped back (spikes, any azimuth), and on the convex half the joint core is laid
         onto R (the inner crease is left alone) — the olecranon becomes a round sphere cap
      3. guarded Taubin smoothing on the welded topology (UV seams stay closed, UVs untouched), re-projecting the
         core onto the capsule every pass so the collapsed spike relaxes evenly; fades out along the arm so the
         muscles stay as sculpted
      4. normals: the imported custom split normals still describe the spike — in the edited region they are
         replaced by area-weighted normals of the welded vertex (smooth across UV seams), blended out at the edge
      5. skin weights: upperArm/lowerArm ratio rebuilt as a smoothstep over ±weight_band then relaxed, so a
         bend rolls the elbow round instead of pinching it
    Returns the polygon indices of the rebuilt elbow caps (+ faces moved > 3 mm) — the texture still has the old spike's shading
    painted in, soften it with tex.soften(tex.faces_mask(polys)).
    """
    body, BW = ctx.body, ctx.BW
    me = body.data
    uid, nb, first = _welded(me)
    n = len(nb)
    co = np.empty(len(me.vertices) * 3); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    M = np.array(BW); Mi = np.array(BW.inverted())
    P0 = (co @ M[:3, :3].T + M[:3, 3])[first]        # welded world positions
    Pu = P0.copy()
    names = [g.name for g in body.vertex_groups]
    W = np.zeros((len(me.vertices), len(names)))
    for v in me.vertices:
        for g in v.groups: W[v.index, g.group] = g.weight
    Wu = W[first]
    tot = Wu.sum(1) + 1e-9
    moved = np.zeros(n); rebuilt = np.zeros(n, bool)
    NB = 24
    for side in sides:
        gu, gl = names.index(side + 'UpperArm'), names.index(side + 'LowerArm')
        sh, el, wr = [np.array(ctx.bone_head(side + b)) for b in ('UpperArm', 'LowerArm', 'Hand')]
        U, Lu = (el - sh) / np.linalg.norm(el - sh), np.linalg.norm(el - sh)
        F, Lf = (wr - el) / np.linalg.norm(wr - el), np.linalg.norm(wr - el)
        am = (U + F) / np.linalg.norm(U + F)
        e1 = (U - F) - am * (am @ (U - F)); e1 /= np.linalg.norm(e1); e2 = np.cross(am, e1)

        def measure(X):
            d = X - el
            tu = np.clip(d @ U, -Lu, 0); tf = np.clip(d @ F, 0, Lf)
            qu = el + tu[:, None] * U; qf = el + tf[:, None] * F
            du = np.linalg.norm(X - qu, axis=1); df = np.linalg.norm(X - qf, axis=1)
            up = du < df
            s = np.where(up, tu, tf); q = np.where(up[:, None], qu, qf); r = np.maximum(np.minimum(du, df), 1e-9)
            nd = X - q
            th = np.arctan2(nd @ e2, nd @ e1) % (2 * np.pi)
            return s, q, r, nd, th, (th / (2 * np.pi) * NB).astype(int) % NB

        share = (Wu[:, gu] + Wu[:, gl]) / tot
        s_all, _, r_all, _, _, _ = measure(Pu)
        region = (share > 0.5) & (np.abs(s_all) < smooth_s[1] + 0.02) & (r_all < 0.2)
        idx = np.where(region)[0]
        s0, _, r0, _, _, b0 = measure(Pu[idx])

        def ring(lo, hi):
            R = np.full(NB, np.nan)
            m = (s0 >= lo) & (s0 <= hi)
            for k in range(NB):
                mk = m & (b0 == k)
                if mk.sum() >= 2: R[k] = np.percentile(r0[mk], pct)
            ok = ~np.isnan(R)
            if not ok.any(): return None
            xs = np.arange(NB)
            R = np.interp(xs, np.concatenate([xs[ok] - NB, xs[ok], xs[ok] + NB]), np.tile(R[ok], 3))
            for _ in range(2): R = (np.roll(R, 1) + 2 * R + np.roll(R, -1)) / 4
            return R
        Ru, Rf = ring(*ref_u), ring(*ref_f)
        if Ru is None or Rf is None:
            print('ELBOW', side, 'no reference rings, skipped'); continue
        Rj = np.minimum(Ru, Rf)                       # the joint is the slim point between the muscle bellies

        def project(X):
            """spike clamp + convex core rebuild -> new positions, spike mask, core weight, excess"""
            si, q, ri, nd, th, b = measure(X)
            ku = _smoothstep((si - ref_u[1]) / -ref_u[1]); kf = _smoothstep(si / ref_f[0])
            Rref = np.where(si < 0, Ru[b] * (1 - ku) + Rj[b] * ku, Rj[b] * (1 - kf) + Rf[b] * kf)
            lim = Rref * (1 + tol[0] + (tol[1] - tol[0]) * _smoothstep(np.abs(si) / clamp_s))
            ex = ri - lim
            sp = (np.abs(si) < clamp_s) & (ex > 0)
            rn = np.where(sp, lim + soft * (1 - np.exp(-np.maximum(ex, 0) / soft)), ri)
            wc = _smoothstep(np.cos(th) / 0.5) * (1 - _smoothstep((np.abs(si) - core[0]) / (core[1] - core[0])))
            rn = rn + wc * (Rref * (1 + tol[0]) - rn)
            return q + nd * (rn / ri)[:, None], sp, wc, ex

        X, sp, wc, ex = project(Pu[idx])
        print('ELBOW %s ref r upper %.3f..%.3f fore %.3f..%.3f joint %.3f..%.3f, spike verts %d (max excess %.3f)'
              % (side, Ru.min(), Ru.max(), Rf.min(), Rf.max(), Rj.min(), Rj.max(), sp.sum(), ex.max()))
        Pu[idx] = X
        cap = sp | (wc > 0.25)
        # 3. Taubin smoothing (fading along the arm) with the core re-projected onto the capsule each pass
        wgt = np.zeros(n)
        wgt[idx] = 1 - _smoothstep((np.abs(s0) - smooth_s[0]) / (smooth_s[1] - smooth_s[0]))
        wgt[idx[cap]] = 1.0
        act = np.where(wgt > 1e-3)[0]
        for it in range(iters):
            for lam in (0.5, -0.53):
                L = np.array([Pu[nb[i]].mean(0) - Pu[i] if len(nb[i]) else np.zeros(3) for i in act])
                Pu[act] += lam * wgt[act][:, None] * L
            X, sp2, wc2, _ = project(Pu[idx])
            Pu[idx] = X
            cap |= sp2 | (wc2 > 0.25)
        # degenerate AI triangles can blow up / NaN — put those back
        bad = ~np.all(np.isfinite(Pu[act]), axis=1) | (np.linalg.norm(Pu[act] - P0[act], axis=1) > max_move)
        Pu[act[bad]] = P0[act[bad]]
        moved[act] = np.maximum(moved[act], wgt[act])
        rebuilt[idx[cap]] = True
        rebuilt[act[np.linalg.norm(Pu[act] - P0[act], axis=1) > 0.003]] = True   # moved enough to misfit its paint
        # 5. weights: upper/lower ratio -> smoothstep over the band, relaxed on the welded graph
        wi = np.where(region & (share > 0.9) & (np.abs(s_all) < weight_band + 0.03))[0]
        ratio = Wu[:, gl] / np.maximum(Wu[:, gu] + Wu[:, gl], 1e-9)
        ratio[wi] = _smoothstep((s_all[wi] + weight_band) / (2 * weight_band))
        for _ in range(4):
            ratio[wi] = 0.5 * ratio[wi] + 0.5 * np.array([ratio[nb[i]].mean() if len(nb[i]) else ratio[i] for i in wi])
        arm_w = Wu[wi, gu] + Wu[wi, gl]
        Wu[wi, gu] = arm_w * (1 - ratio[wi]); Wu[wi, gl] = arm_w * ratio[wi]
        for vi in np.where(np.isin(uid, wi))[0]:
            body.vertex_groups[gu].add([int(vi)], float(Wu[uid[vi], gu]), 'REPLACE')
            body.vertex_groups[gl].add([int(vi)], float(Wu[uid[vi], gl]), 'REPLACE')
        print('ELBOW %s smoothed %d verts (restored %d), cap %d, reweighted %d'
              % (side, len(act), bad.sum(), cap.sum(), len(wi)))
    mv = moved > 0
    newco = co.copy()
    newco[mv[uid]] = (Pu[uid] @ Mi[:3, :3].T + Mi[:3, 3])[mv[uid]]
    ln = np.empty(len(me.loops) * 3, np.float32); me.corner_normals.foreach_get('vector', ln); ln = ln.reshape(-1, 3)
    me.vertices.foreach_set('co', newco.ravel()); me.update()
    # 4. normals of the edited region from the welded geometry (area-weighted face normals per welded vertex)
    pv = np.empty(len(me.loops), np.int64); me.loops.foreach_get('vertex_index', pv)
    ls = np.empty(len(me.polygons), np.int64); me.polygons.foreach_get('loop_start', ls)
    lt = np.empty(len(me.polygons), np.int64); me.polygons.foreach_get('loop_total', lt)
    fn = np.empty(len(me.polygons) * 3); me.polygons.foreach_get('normal', fn); fn = fn.reshape(-1, 3)
    fa = np.empty(len(me.polygons)); me.polygons.foreach_get('area', fa)
    lpoly = np.repeat(np.arange(len(me.polygons)), lt)
    vn = np.zeros((n, 3)); np.add.at(vn, uid[pv], fn[lpoly] * fa[lpoly, None])
    vn /= np.maximum(np.linalg.norm(vn, axis=1), 1e-12)[:, None]
    f = _smoothstep(moved[uid[pv]] / 0.5)[:, None]
    new_ln = ln * (1 - f) + vn[uid[pv]] * f
    new_ln /= np.maximum(np.linalg.norm(new_ln, axis=1), 1e-12)[:, None]
    me.normals_split_custom_set([tuple(x) for x in new_ln])
    me.update()
    hit = np.add.reduceat(rebuilt[uid[pv]].astype(np.int64), ls)
    return np.where(hit * 2 >= lt)[0].tolist()          # faces of the rebuilt elbow caps (for Texture.faces_mask)


def fix_unweighted(ob):
    me = ob.data
    weighted = [v for v in me.vertices if sum(g.weight for g in v.groups) > 1e-4]
    kd = KDTree(len(weighted))
    for i, v in enumerate(weighted): kd.insert(v.co, i)
    kd.balance()
    n = 0
    for v in me.vertices:
        if sum(g.weight for g in v.groups) > 1e-4: continue
        _, i, _ = kd.find(v.co)
        for g in weighted[i].groups: ob.vertex_groups[g.group].add([v.index], g.weight, 'REPLACE')
        n += 1
    print('WEIGHTS fixed', n)


def _ellipsoid(bm2, c, r, R=None, seg=18, rings=10):
    tmp = bmesh.new(); bmesh.ops.create_uvsphere(tmp, u_segments=seg, v_segments=rings, radius=1)
    M = Matrix.Translation(c) @ (R.to_4x4() if R else Matrix()) @ Matrix.Diagonal((r[0], r[1], r[2], 1))
    for v in tmp.verts: v.co = M @ v.co
    m = bpy.data.meshes.new('_t'); tmp.to_mesh(m); tmp.free(); bm2.from_mesh(m); bpy.data.meshes.remove(m)


def new_object(name, build, color, roughness=0.85, alpha=None, smooth=True):
    bm2 = bmesh.new(); build(bm2)
    m2 = bpy.data.meshes.new(name); bm2.to_mesh(m2); bm2.free()
    ob = bpy.data.objects.new(name, m2); bpy.context.scene.collection.objects.link(ob)
    mat = bpy.data.materials.new(name); mat.use_nodes = True
    p = mat.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = tuple(lin(srgb(color))) + (1,)
    p.inputs['Roughness'].default_value = roughness
    if alpha is not None:
        p.inputs['Alpha'].default_value = alpha
        try: mat.surface_render_method = 'BLENDED'
        except Exception: mat.blend_method = 'BLEND'
    m2.materials.append(mat)
    if smooth:
        for poly in m2.polygons: poly.use_smooth = True
    return ob


def remesh_smooth(ob, voxel, iters=4, ratio=0.35):
    r = ob.modifiers.new('r', 'REMESH'); r.mode = 'VOXEL'; r.voxel_size = voxel
    sm = ob.modifiers.new('s', 'SMOOTH'); sm.factor = 0.6; sm.iterations = iters
    dec = ob.modifiers.new('d', 'DECIMATE'); dec.ratio = ratio
    dg = bpy.context.evaluated_depsgraph_get()
    newm = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    old = ob.data; ob.modifiers.clear(); ob.data = newm; newm.materials.clear()
    for m in old.materials: newm.materials.append(m)
    for p in newm.polygons: p.use_smooth = True


def rigid(ctx, ob, bone):
    g = ob.vertex_groups.new(name=bone); g.add(list(range(len(ob.data.vertices))), 1.0, 'REPLACE')
    attach(ctx, ob)


def attach(ctx, ob):
    ob.parent = ctx.arm
    md = ob.modifiers.new('Armature', 'ARMATURE'); md.object = ctx.arm
    ctx.extra.append(ob)


def _blend_bone_weights(ob, bones, sigma=0.006, top=3):
    """smooth skin weights from distance to bone segments [(name, a, b)] (soft falloff between neighbours, so
    a fused hand mesh bends round at the knuckles instead of creasing)"""
    co = np.array([tuple(v.co) for v in ob.data.vertices])
    D = []
    for _, a, b in bones:
        a, b = np.array(a), np.array(b); ab = b - a
        t = np.clip(((co - a) @ ab) / max(ab @ ab, 1e-12), 0, 1)
        D.append(np.linalg.norm(co - (a + t[:, None] * ab), axis=1))
    D = np.stack(D, 1)
    W = np.exp(-(D - D.min(1, keepdims=True)) / sigma)
    cut = -np.sort(-W, axis=1)[:, top - 1:top]
    W[W < cut] = 0; W[W < 0.02] = 0
    W /= W.sum(1, keepdims=True)
    q = np.round(W * 256) / 256
    for gi, (bn, _, _) in enumerate(bones):
        col = q[:, gi]; nz = np.nonzero(col)[0]
        if not len(nz): continue
        g = ob.vertex_groups.get(bn) or ob.vertex_groups.new(name=bn)
        for u in np.unique(col[nz]): g.add(nz[col[nz] == u].tolist(), float(u), 'REPLACE')


def replace_hands(ctx, color, band_color=None, finger_r=0.0155, palm=(0.036, 0.058, 0.058), finger_len=(0.036, 0.028, 0.024),
                  spread=0.03, curl=(0.2, 0.28, 0.22), cut_radius=0.34, band_len=0.045, band_scale=1.07, knuckles=False, splay=0.0, thumb_r=1.15,
                  fuse=False, fuse_voxel=0.0032, fuse_smooth=8, cap=False, band=True, material=None):
    """Cut the AI hands off at the wrist (clean plane), build new hands (palm + 4 fingers + thumb) scaled to
    the measured wrist, add finger bones, weight the fingers, cover the cut with a wrist band.
    fuse=True: palm + fingers become ONE voxel-remeshed, smoothed glove (no sausage segments) with blended
    bone weights; cap=True closes the cut arm end; band=False skips the wrist band; material = reuse a material."""
    arm, body, BW = ctx.arm, ctx.body, ctx.BW
    me = body.data
    inv = BW.inverted()
    HANDS = {}
    for side, s in (('left', 1), ('right', -1)):
        fa, hd = ctx.bone_head(side + 'LowerArm'), ctx.bone_head(side + 'Hand')
        HANDS[side] = (hd, (hd - fa).normalized(), s)
    bm = bmesh.new(); bm.from_mesh(me)
    ARM = {}
    for side, (hd, d, s) in HANDS.items():
        cut = hd + d * 0.01
        near = lambda p: (p - hd).length < cut_radius and s * (p.x - 0) > 0.25
        geom = [f for f in bm.faces if near(BW @ f.calc_center_median())]
        edges = list({e for f in geom for e in f.edges}); verts = list({v for f in geom for v in f.verts})
        bmesh.ops.bisect_plane(bm, geom=geom + edges + verts, dist=1e-5, plane_co=inv @ cut, plane_no=(inv.to_3x3() @ d).normalized())
        kill = [f for f in bm.faces if near(BW @ f.calc_center_median()) and ((BW @ f.calc_center_median()) - cut).dot(d) > 0]
        bmesh.ops.delete(bm, geom=kill, context='FACES')
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
        ring = [BW @ v.co for v in bm.verts if abs(((BW @ v.co) - cut).dot(d)) < 0.004 and (((BW @ v.co) - cut) - d * ((BW @ v.co) - cut).dot(d)).length < 0.1]
        ctr = sum(ring, Vector()) / max(1, len(ring))
        rr = sorted(((p - ctr) - d * (p - ctr).dot(d)).length for p in ring)
        ARM[side] = (rr[len(rr) // 2] * 1.08 if rr else 0.04, ctr)
        print('HANDS cut', side, len(kill), 'faces, wrist r %.3f' % ARM[side][0])
    if cap:
        be = [e for e in bm.edges if e.is_boundary and any((BW @ v.co - HANDS[sd][0]).length < cut_radius for v in e.verts for sd in HANDS)]
        res = bmesh.ops.holes_fill(bm, edges=be, sides=0)
        bmesh.ops.triangulate(bm, faces=res['faces'])
    bm.to_mesh(me); bm.free(); me.update()
    fix_unweighted(body)

    FINGERS = ['Index', 'Middle', 'Ring', 'Little']
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    ainv = arm.matrix_world.inverted()
    G = {}
    for side, (hd, d, s) in HANDS.items():
        sc = max(0.8, ARM[side][0] / 0.05)
        fwd = Vector((0, -1, 0)); fwd = (fwd - d * fwd.dot(d)).normalized()
        lat = d.cross(fwd).normalized()
        palm_c = hd + d * 0.065 * sc
        segs = {}
        for i, fn in enumerate(FINGERS):
            base = palm_c + d * 0.05 * sc + fwd * ((1.5 - i) * spread * sc)
            L = [x * sc * (0.8 if fn == 'Little' else 1.0) for x in finger_len]
            # fan the fingers: each one swings a little toward the front/back and out of the palm plane
            dirv = (Matrix.Rotation((1.5 - i) * splay, 3, lat) @ Matrix.Rotation(-s * abs(1.5 - i) * splay * 0.5, 3, fwd) @ d).normalized()
            pts = [base]
            for k in range(3):
                dirv = (Matrix.Rotation(-s * curl[k] * 0.6, 3, fwd) @ dirv).normalized()
                pts.append(pts[-1] + dirv * L[k])
            segs[fn] = pts
        tb = palm_c + fwd * 0.045 * sc - d * 0.02 * sc
        tdir = (d * 0.55 + fwd * 0.8).normalized()
        segs['Thumb'] = [tb, tb + tdir * 0.035 * sc, tb + tdir * 0.063 * sc, tb + tdir * 0.085 * sc]
        prev0 = eb[side + 'Hand']
        for fn, pts in segs.items():
            names = ['Metacarpal', 'Proximal', 'Distal'] if fn == 'Thumb' else ['Proximal', 'Intermediate', 'Distal']
            prev = prev0
            for k, nm in enumerate(names):
                b = eb.get(side + fn + nm) or eb.new(side + fn + nm)
                b.head = ainv @ pts[k]; b.tail = ainv @ pts[k + 1]
                b.parent = prev; b.use_connect = k > 0; b.use_deform = True
                prev = b
        G[side] = (hd, d, s, fwd, lat, palm_c, segs, sc)
    bpy.ops.object.mode_set(mode='OBJECT')

    out = []
    for side, (hd, d, s, fwd, lat, palm_c, segs, sc) in G.items():
        R = Matrix((lat, d, fwd)).transposed()
        wr, wc = ARM[side]
        def palm_b(bm2):
            _ellipsoid(bm2, palm_c, (palm[0] * sc, palm[1] * sc, palm[2] * sc), R, seg=24, rings=14)
            if knuckles:
                for i in range(4):
                    _ellipsoid(bm2, palm_c + d * 0.045 * sc + fwd * ((1.5 - i) * spread * sc), (0.016 * sc, 0.014 * sc, 0.014 * sc), R, seg=12, rings=8)
        def fing_b(bm2):
            for fn, pts in segs.items():
                rad = finger_r * sc * (thumb_r if fn == 'Thumb' else 0.88 if fn == 'Little' else 1.0)
                for a, b in zip(pts, pts[1:]):
                    ln = (b - a).length
                    Rf = Vector((0, 1, 0)).rotation_difference((b - a).normalized()).to_matrix()
                    _ellipsoid(bm2, (a + b) / 2, (rad, ln / 2 + rad * 0.85, rad), Rf, seg=14, rings=9)
                _ellipsoid(bm2, pts[-1], (rad,) * 3, None, seg=12, rings=8)
        bones = []
        for fn, pts in segs.items():
            names = ['Metacarpal', 'Proximal', 'Distal'] if fn == 'Thumb' else ['Proximal', 'Intermediate', 'Distal']
            for k, nm in enumerate(names): bones.append((side + fn + nm, pts[k], pts[k + 1]))
        if fuse:
            def hand_b(bm2): palm_b(bm2); fing_b(bm2)
            hob = new_object('Hand_' + side, hand_b, color)
            remesh_smooth(hob, fuse_voxel, iters=fuse_smooth, ratio=0.3)
            if material: hob.data.materials.clear(); hob.data.materials.append(material)
            # the hand bone owns the palm: a segment from the wrist to the knuckle line
            _blend_bone_weights(hob, [(side + 'Hand', hd, palm_c + d * 0.035 * sc)] + bones, sigma=0.005 * sc)
            attach(ctx, hob); out.append(hob)
            parts = []
        else:
            pob = new_object('Hand_' + side, palm_b, color)
            remesh_smooth(pob, 0.004, iters=4)
            fob = new_object('Fingers_' + side, fing_b, color)
            fob.data.materials.clear(); fob.data.materials.append(pob.data.materials[0])
            parts = ((pob, True), (fob, False))
        for o2, palm_only in parts:
            groups = {}
            for v in o2.data.vertices:
                best, bd = side + 'Hand', 1e9
                if not palm_only:
                    for bn, a, b in bones:
                        ab = b - a; t = max(0.0, min(1.0, (v.co - a).dot(ab) / ab.length_squared)); dd = (v.co - (a + ab * t)).length
                        if dd < bd: best, bd = bn, dd
                groups.setdefault(best, []).append(v.index)
            for bn, idx in groups.items():
                g = o2.vertex_groups.new(name=bn); g.add(idx, 1.0, 'REPLACE')
            attach(ctx, o2); out.append(o2)
        if not band: continue
        def band_b(bm2):
            n = max(2, int(band_len / 0.011))
            for k in range(n):
                _ellipsoid(bm2, wc + d * (0.004 + 0.011 * k), (wr * band_scale, 0.016, wr * band_scale), R, seg=28, rings=10)
        bob = new_object('WristBand_' + side, band_b, band_color or color)
        remesh_smooth(bob, 0.004, iters=3, ratio=0.5)
        if material and not band_color: bob.data.materials.clear(); bob.data.materials.append(material)
        g = bob.vertex_groups.new(name=side + 'Hand'); g.add(list(range(len(bob.data.vertices))), 1.0, 'REPLACE')
        attach(ctx, bob); out.append(bob)
    return out


def lens_disc(ctx, center, normal, radius, dome=0.006, color='#9fb3bf', alpha=0.28, bone='head', name='MaskLens', aspect=1.0):
    """clean domed glass disc over an eye lens (material name contains 'Lens' → runtime draws it after the eyes)"""
    n = Vector(normal).normalized()
    R = Vector((0, 0, 1)).rotation_difference(n).to_matrix()
    def build(bm2):
        segs, rings = 40, 8
        vs = [[bm2.verts.new(Vector(center) + R @ Vector((0, 0, dome)))]]
        for j in range(1, rings + 1):
            t = j / rings
            ring = []
            for i in range(segs):
                a = 2 * math.pi * i / segs
                ring.append(bm2.verts.new(Vector(center) + R @ Vector((radius * t * math.cos(a) * aspect, radius * t * math.sin(a), dome * (1 - t * t)))))
            vs.append(ring)
        for i in range(segs):
            bm2.faces.new((vs[0][0], vs[1][i], vs[1][(i + 1) % segs]))
        for j in range(1, rings):
            for i in range(segs):
                bm2.faces.new((vs[j][i], vs[j + 1][i], vs[j + 1][(i + 1) % segs], vs[j][(i + 1) % segs]))
    ob = new_object(name, build, color, roughness=0.05, alpha=alpha)
    rigid(ctx, ob, bone)
    return ob


def export(ctx, out):
    bpy.ops.object.select_all(action='DESELECT')
    for o in [ctx.arm, ctx.body] + ctx.extra: o.select_set(True)
    bpy.context.view_layer.objects.active = ctx.arm
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True, export_yup=True, export_skins=True,
                              export_animations=False, export_morph=False, export_def_bones=False)
    import os
    print('WROTE', out, os.path.getsize(out), 'bones', len(ctx.arm.data.bones))
