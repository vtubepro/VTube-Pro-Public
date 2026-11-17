"""
hair_kit.locks — turn clumps of strands into REAL-TIME hair meshes.

  lock_from_strands(guide, strands)   measures a clump: centreline, lateral axis (PCA of the strands' spread in the
                                      plane across the lock), width + thickness per ring (smoothed), used by
  LockSpec                            one lock: centreline, frames, width/thickness profiles, tip shape, sub-tips
  build_mesh(locks, atlas)            numpy mesh: crescent SHELL cross-section (outer arc + flatter inner side, edges
                                      curled toward the head, so a lock never reads as a flat ribbon or a pipe and has
                                      no edge-on sliver), tapered 'flame' tips (needle point, optional 2-3 forked sub-
                                      tips), root caps pushed into the scalp, UNIQUE UVs per lock in an atlas (u across,
                                      v root -> tip) so every lock gets its own painted gradient / strand lines / ring
                                      segment, per-vertex attributes hair_t / lock / layer.
  ribbons(strands)                    thin tapered two-sided ribbons for flyaway strands (the "wild" layer)
  cards(locks)                        LOD2: flat double-sided cards (4 verts across) with the same UVs

Tangent convention for anisotropic / angel-ring shading: UV u runs ACROSS the lock and v ALONG it, so the glTF
TANGENT (dP/du) is across-strand and the BITANGENT is the strand direction (export with export_tangents=True).
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .core import unit, smoothstep, resample, smooth_poly

# crescent profile: outer arc x = +1..-1 (9 pts), inner side x = -1..+1 (7 pts)
_o = np.cos(np.linspace(0, np.pi, 9))
_i = -np.cos(np.linspace(0, np.pi, 9))[1:-1]
PX = np.r_[_o, _i]
POUT = np.r_[np.ones(9, bool), np.zeros(7, bool)]
PU = np.r_[(1 - _o) / 2, (1 - _i) / 2]          # u across (outer 0->1, inner mirrored back)
# LOD1 profile (6 outer + 4 inner)
_o1 = np.cos(np.linspace(0, np.pi, 6)); _i1 = -np.cos(np.linspace(0, np.pi, 6))[1:-1]
PX1 = np.r_[_o1, _i1]; POUT1 = np.r_[np.ones(6, bool), np.zeros(4, bool)]; PU1 = np.r_[(1 - _o1) / 2, (1 - _i1) / 2]


@dataclass
class LockSpec:
    C: np.ndarray                    # (n,3) centreline, root first
    width: np.ndarray                # (n,) full width (m)
    thick: np.ndarray                # (n,) thickness (m)
    lateral: np.ndarray              # (n,3) unit lateral axis
    outward: np.ndarray              # (n,3) unit outward (away from the head)
    layer: str = 'mid'
    tips: int = 1
    tip_len: tuple = (1.0, 0.8, 0.66)
    tip_spread: float = 0.28
    split: float = 0.55
    tip_start: float = 0.55          # flame wedge start (fraction of length)
    wrap: float = 0.22               # edge curl toward the head (fraction of half width)
    ridge: float = 0.35              # 0 round outer arc .. 1 sharp V ridge
    tone: float = 0.0                # -1 darker .. +1 lighter (painter)
    chain: str | None = None
    meta: dict = field(default_factory=dict)


def _frames_from_lateral(C, lat_hint, head_c):
    T = unit(np.gradient(C, axis=0))
    L = lat_hint - T * (lat_hint * T).sum(1, keepdims=True)
    L = unit(L)
    for i in range(1, len(L)):
        if L[i] @ L[i - 1] < 0:
            L[i] = -L[i]
    N = unit(np.cross(T, L))
    out = unit(C - head_c)
    flip = (N * out).sum(1) < 0
    if flip.mean() > 0.5:
        L, N = -L, -N
    return T, L, N


def lock_from_strands(G, S, head_c, w_min=0.006, w_max=0.07, w_scale=2.3, th_ratio=0.3, smooth_it=6, **kw):
    """Measure a clump: G guide (n,3), S strands (m,n,3) of this clump (pre-trim). Returns a LockSpec."""
    n = len(G)
    T = unit(np.gradient(G, axis=0))
    off = S - G[None]
    off = off - T[None] * (off * T[None]).sum(-1, keepdims=True)
    lat = np.zeros((n, 3)); lam1 = np.zeros(n); lam2 = np.zeros(n)
    prev = None
    for i in range(n):
        X = off[:, i]
        Cm = X.T @ X / max(len(X), 1)
        w, v = np.linalg.eigh(Cm)
        a = v[:, 2]
        if prev is not None and a @ prev < 0:
            a = -a
        lat[i] = a; lam1[i] = w[2]; lam2[i] = w[1]; prev = a
    # the root lateral: along the scalp, across the flow (radial x tangent) when the spread is ~isotropic there
    rad = unit(G[0] - head_c)
    lat0 = unit(np.cross(rad, T[0]))
    k = smoothstep(0.0, 0.25, np.linspace(0, 1, n))[:, None]
    if (lat0 @ lat[min(3, n - 1)]) < 0:
        lat0 = -lat0
    lat = unit(lat * k + lat0 * (1 - k))
    for _ in range(smooth_it):
        lat[1:-1] = unit(0.25 * lat[:-2] + 0.5 * lat[1:-1] + 0.25 * lat[2:])
    wid = np.clip(w_scale * np.sqrt(np.maximum(lam1, 1e-10)), w_min, w_max)
    th = np.maximum(th_ratio * wid, np.clip(1.6 * np.sqrt(np.maximum(lam2, 1e-10)), 0.0015, 0.02))
    for _ in range(smooth_it):
        wid[1:-1] = 0.25 * wid[:-2] + 0.5 * wid[1:-1] + 0.25 * wid[2:]
        th[1:-1] = 0.25 * th[:-2] + 0.5 * th[1:-1] + 0.25 * th[2:]
    Tn, L, N = _frames_from_lateral(G, lat, head_c)
    return LockSpec(C=G.copy(), width=wid, thick=th, lateral=L, outward=N, **kw)


def lock_parametric(G, head_c, width, thick_ratio=0.3, root_w=0.7, belly=0.1, **kw):
    """A lock from a guide + a single width (no strands): root narrower, slight belly, lateral along the scalp."""
    n = len(G)
    t = np.linspace(0, 1, n)
    T = unit(np.gradient(G, axis=0))
    rad = unit(G - head_c)
    lat = unit(np.cross(rad, T))
    for _ in range(4):
        lat[1:-1] = unit(0.25 * lat[:-2] + 0.5 * lat[1:-1] + 0.25 * lat[2:])
    w = width * (root_w + (1 - root_w) * smoothstep(0, 0.2, t)) * (1 + belly * np.sin(np.pi * t))
    Tn, L, N = _frames_from_lateral(G, lat, head_c)
    return LockSpec(C=np.asarray(G, float), width=w, thick=w * thick_ratio, lateral=L, outward=N, **kw)


def _taper(t, spec: LockSpec):
    k = spec.tip_start
    return np.where(t < k, 1.0, np.clip(1 - (t - k) / (1 - k), 0, 1) ** 0.7)      # convex wedge: broad clump, short point


class Atlas:
    """Unique-UV atlas: slot i -> column strip (cols x rows)."""

    def __init__(self, cols=64, rows=4, size=2048):
        self.cols, self.rows, self.size = cols, rows, size
        self.n = 0

    def slot(self):
        s = self.n
        self.n += 1
        if self.n > self.cols * self.rows:
            raise RuntimeError('atlas full')
        return s

    def uv(self, slot, u, t):
        c, r = slot % self.cols, slot // self.cols
        U = (c + 0.08 + 0.84 * u) / self.cols
        V = 1 - (r + 0.015 + 0.97 * t) / self.rows          # v flipped (Blender UV origin bottom-left)
        return U, V


def _ring(Ci, Li, Ni, half, thick, wrap, ridge, prof=(PX, POUT)):
    X, OUT = prof
    rnd = np.sqrt(np.clip(1 - X ** 2, 0, 1)); vee = 1 - np.abs(X)
    y_out = thick * (0.22 + 0.78 * ((1 - ridge) * rnd + ridge * vee))
    y_in = -thick * 0.25 * (1 - X ** 2)
    y = np.where(OUT, y_out, y_in) - wrap * half * X ** 2
    return Ci[None] + Li[None] * (X * half)[:, None] + Ni[None] * y[:, None]


def build_mesh(locks, atlas: Atlas, lod=0, rings_per_m=180, min_rings=10, max_rings=48):
    """Returns dict(V, F (list of tuples), UV (per vertex), attrs: t, lock, layer, slot) and records per lock."""
    prof = (PX, POUT, PU) if lod == 0 else (PX1, POUT1, PU1)
    X, OUT, U = prof
    npf = len(X)
    V, F, UV, At, Al, Ay = [], [], [], [], [], []
    recs = []
    layer_ids = {'under': 0, 'mid': 1, 'top': 2, 'front': 3, 'fly': 4}
    for li, sp in enumerate(locks):
        L0 = np.linalg.norm(np.diff(sp.C, axis=0), axis=1).sum()
        nr = int(np.clip(L0 * rings_per_m * (1 if lod == 0 else 0.55), min_rings, max_rings))
        tq = np.linspace(0, 1, len(sp.C))
        tr = np.linspace(0, 1, nr)
        Cr = resample(sp.C, nr)
        itp = lambda a: np.stack([np.interp(tr, tq, a[:, k]) for k in range(a.shape[1])], 1) if a.ndim == 2 else np.interp(tr, tq, a)
        Wr, Hr = itp(sp.width), itp(sp.thick)
        Lr, Nr = unit(itp(sp.lateral)), unit(itp(sp.outward))
        tips = max(1, sp.tips)
        parts = []
        for k in range(tips):
            ln = sp.tip_len[k % len(sp.tip_len)] if tips > 1 else 1.0
            m = max(6, int(round(nr * ln)))
            tt = tr[:m] / tr[m - 1]
            off = k - (tips - 1) / 2
            wk = 1.0 / tips * (1.25 if tips > 1 else 1.0)
            lat = off * (1.0 / tips) * Wr[:m] + off * sp.tip_spread * Wr[:m] * smoothstep(sp.split, 1.0, tr[:m]) ** 1.5
            up = (0.0006 * (tips - 1 - abs(off))) if tips > 1 else 0.0
            Ck = Cr[:m] + lat[:, None] * Lr[:m] + up * Nr[:m]
            Wk = Wr[:m] * wk * _taper(tt, sp)
            Hk = Hr[:m] * (0.35 + 0.65 * (1 - tt)) * _taper(tt, sp) ** 0.5
            slot = atlas.slot()
            parts.append((Ck, Lr[:m], Nr[:m], Wk, Hk, tt, slot))
        for (Ck, Lk, Nk, Wk, Hk, tt, slot) in parts:
            base = len(V)
            m = len(Ck)
            # anti-fold: where the lock bends tighter than its half width, consecutive rings cross and the shell
            # turns inside-out (visible back faces = holes in the studio). Narrow the lock locally until no ring
            # vertex moves backwards along the centreline.
            Tk = unit(np.gradient(Ck, axis=0))
            Wk = Wk.copy()
            for _ in range(8):
                Rs = [_ring(Ck[i], Lk[i], Nk[i], Wk[i] / 2, Hk[i], sp.wrap, sp.ridge, (X, OUT)) for i in range(m - 1)]
                bad = np.zeros(m, bool)
                for i in range(m - 2):
                    adv = ((Rs[i + 1] - Rs[i]) @ Tk[i])
                    ds = np.linalg.norm(Ck[i + 1] - Ck[i])
                    if adv.min() < 0.15 * ds:
                        bad[i] = bad[i + 1] = True
                if not bad.any():
                    break
                k = np.convolve(bad.astype(float), [0.5, 1, 0.5], 'same') > 0
                Wk[k] *= 0.8
            rows = []
            for i in range(m):
                if i == m - 1:
                    rows.append([len(V)])
                    V.append(Ck[i] + Nk[i] * Hk[i] * 0.3)
                    UV.append(atlas.uv(slot, 0.5, 1.0)); At.append(1.0); Al.append(li); Ay.append(layer_ids.get(sp.layer, 1))
                    continue
                R = _ring(Ck[i], Lk[i], Nk[i], Wk[i] / 2, Hk[i], sp.wrap, sp.ridge, (X, OUT))
                idx = list(range(len(V), len(V) + npf))
                V.extend(R)
                for j in range(npf):
                    UV.append(atlas.uv(slot, U[j], tt[i])); At.append(tt[i]); Al.append(li); Ay.append(layer_ids.get(sp.layer, 1))
                rows.append(idx)
            # root cap: pushed a little toward the scalp
            rc = len(V)
            V.append(Ck[0] - Nk[0] * Hk[0] * 0.8 - unit(Ck[1] - Ck[0]) * Wk[0] * 0.1)
            UV.append(atlas.uv(slot, 0.5, -0.012)); At.append(0.0); Al.append(li); Ay.append(layer_ids.get(sp.layer, 1))   # off-row: no zero-area UV fan
            for i in range(m - 1):
                a, b = rows[i], rows[i + 1]
                for j in range(npf):
                    j2 = (j + 1) % npf
                    if len(b) == 1:
                        F.append((a[j], a[j2], b[0]))
                    else:
                        F.append((a[j], a[j2], b[j2], b[j]))
            for j in range(npf):
                F.append((rows[0][(j + 1) % npf], rows[0][j], rc))
            recs.append({'lock': li, 'slot': slot, 'range': (base, len(V)), 'layer': sp.layer, 'tone': sp.tone, 'chain': sp.chain})
    return {'V': np.array(V), 'F': F, 'UV': np.array(UV), 't': np.array(At), 'lock': np.array(Al), 'layer': np.array(Ay),
            'recs': recs}


def ribbons(strands, atlas: Atlas, head_c, width=0.004, layer='fly'):
    """Flyaway strands as thin tapered ribbons (3 verts across: a slight V so they are never edge-on invisible)."""
    V, F, UV, At, Al, Ay, recs = [], [], [], [], [], [], []
    for si, S in enumerate(strands):
        n = len(S)
        t = np.linspace(0, 1, n)
        T = unit(np.gradient(S, axis=0))
        rad = unit(S - head_c)
        L = unit(np.cross(rad, T))
        N = unit(np.cross(T, L))
        w = width * (1 - t ** 1.5) * smoothstep(0, 0.1, t + 0.05)
        slot = atlas.slot()
        base = len(V)
        for i in range(n):
            for u, x, y in ((0.0, -1, 0), (0.5, 0, 0.35), (1.0, 1, 0)):
                V.append(S[i] + L[i] * x * w[i] / 2 + N[i] * y * w[i] / 2)
                UV.append(atlas.uv(slot, u, t[i])); At.append(t[i]); Al.append(-1 - si); Ay.append(4)
        for i in range(n - 1):
            a = base + 3 * i; b = a + 3
            F.append((a, a + 1, b + 1, b)); F.append((a + 1, a + 2, b + 2, b + 1))
        recs.append({'lock': -1 - si, 'slot': slot, 'range': (base, len(V)), 'layer': layer, 'tone': 0.2, 'chain': None})
    return {'V': np.array(V).reshape(-1, 3), 'F': F, 'UV': np.array(UV).reshape(-1, 2), 't': np.array(At),
            'lock': np.array(Al), 'layer': np.array(Ay), 'recs': recs}


def cards(locks, atlas_slots, atlas: Atlas, rings=8):
    """LOD2: one flat card per lock (4 verts across, double-sided in the material), reusing each lock's atlas slot."""
    V, F, UV = [], [], []
    for sp, slot in zip(locks, atlas_slots):
        C = resample(sp.C, rings)
        tq = np.linspace(0, 1, len(sp.C)); tr = np.linspace(0, 1, rings)
        W = np.interp(tr, tq, sp.width) * _taper(tr, sp)
        Lr = unit(np.stack([np.interp(tr, tq, sp.lateral[:, k]) for k in range(3)], 1))
        Nr = unit(np.stack([np.interp(tr, tq, sp.outward[:, k]) for k in range(3)], 1))
        base = len(V)
        for i in range(rings):
            for u in (0.0, 0.33, 0.67, 1.0):
                x = u * 2 - 1
                V.append(C[i] + Lr[i] * x * W[i] / 2 - Nr[i] * (x * x) * W[i] * 0.12)
                UV.append(atlas.uv(slot, u, tr[i]))
        for i in range(rings - 1):
            for j in range(3):
                a = base + 4 * i + j
                F.append((a, a + 1, a + 5, a + 4))
    return {'V': np.array(V), 'F': F, 'UV': np.array(UV)}


def merge(*parts):
    V, F, UV, At, Al, Ay, recs = [], [], [], [], [], [], []
    off = 0
    for p in parts:
        if p is None or len(p['V']) == 0:
            continue
        V.append(p['V']); UV.append(p['UV'])
        F += [tuple(i + off for i in f) for f in p['F']]
        At.append(p.get('t', np.zeros(len(p['V'])))); Al.append(p.get('lock', np.zeros(len(p['V']), int)))
        Ay.append(p.get('layer', np.zeros(len(p['V']), int)))
        for r in p.get('recs', []):
            r = dict(r); r['range'] = (r['range'][0] + off, r['range'][1] + off); recs.append(r)
        off += len(p['V'])
    return {'V': np.concatenate(V), 'F': F, 'UV': np.concatenate(UV), 't': np.concatenate(At), 'lock': np.concatenate(Al),
            'layer': np.concatenate(Ay), 'recs': recs}


def to_object(mesh, name, material=None, fix_normals=True):
    import bpy
    me = bpy.data.meshes.new(name)
    me.from_pydata(mesh['V'].tolist(), [], mesh['F'])
    me.update()
    uv = me.uv_layers.new(name='UVMap')
    loops_v = np.zeros(len(me.loops), np.int64); me.loops.foreach_get('vertex_index', loops_v)
    uv.data.foreach_set('uv', mesh['UV'][loops_v].astype(np.float32).ravel())
    for key in ('t', 'lock', 'layer'):
        if key in mesh:
            a = me.attributes.new('hair_' + key, 'FLOAT', 'POINT')
            a.data.foreach_set('value', np.asarray(mesh[key], np.float32))
    if fix_normals:
        import bmesh
        bm = bmesh.new(); bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        bm.to_mesh(me); bm.free()
    for p in me.polygons:
        p.use_smooth = True
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    if material is not None:
        me.materials.append(material)
    return o
