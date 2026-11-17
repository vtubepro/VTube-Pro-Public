"""
Make a SCULPT the avatar's face: conform an animation-ready head (MakeHuman topology: eye / mouth / jaw loops,
UVs, skin weights, 45 face shapes) onto a dense sculpt surface, densified where the face needs it, then verify
fidelity numerically and visually.

    subdivide_region(d, tri_mask, levels=1)     red-green midpoint refinement (weights, UVs, morph deltas carried)
    SurfaceProj(P_src, T_src)                    project / nearest queries on the sculpt (dense samples + KD tree)
    conform(d, verts_mask, proj, ...)            project along normals (+ nearest fallback), tangential relax,
                                                 displacement shared by every vertex at the same position
    fidelity(d, tris, proj, region)              mean / p95 / max distance both ways (retopo->sculpt, sculpt->retopo)
    relief(P, T, iters)                          per-vertex signed height above a smoothed copy (curvature / cavity)
    clay(P, T, view, ...)                        numpy z-buffer grey-clay render for side-by-side checks
"""
from __future__ import annotations

import numpy as np

from .sculpt_fit import surface_samples
from .raster import zraster


# ---------------------------------------------------------------------------- welded helpers
def weld_keys(P, q=1e5):
    key = np.round(P * q).astype(np.int64)
    _, inv = np.unique(key, axis=0, return_inverse=True)
    return inv.ravel()


def _merge_weights(J1, W1, J2, W2):
    J = np.concatenate([J1, J2], 1); W = np.concatenate([W1, W2], 1) * 0.5
    out_j = np.zeros((len(J), 4), np.int64); out_w = np.zeros((len(J), 4))
    for i in range(len(J)):
        acc = {}
        for j, w in zip(J[i], W[i]):
            if w > 0:
                acc[j] = acc.get(j, 0.0) + w
        top = sorted(acc.items(), key=lambda kv: -kv[1])[:4]
        s = sum(w for _, w in top) or 1.0
        for k, (j, w) in enumerate(top):
            out_j[i, k] = j; out_w[i, k] = w / s
    return out_j, out_w


def subdivide_region(d, sel_tris_per_prim, log=print):
    """Red-green refinement of the selected triangles (per prim boolean masks). Edges are split by WELDED position
    so neighbours across UV seams / prim borders split consistently (no T-junction cracks); each unwelded vertex
    pair gets its own midpoint (attributes stay per-side)."""
    wk = weld_keys(d.P)
    split = set()
    for pi, pr in enumerate(d.prims):
        T = pr['indices'].reshape(-1, 3).astype(np.int64)
        s = sel_tris_per_prim.get(pi)
        if s is None or not s.any():
            continue
        for a, b, c in T[s]:
            for u, v in ((a, b), (b, c), (c, a)):
                split.add((min(wk[u], wk[v]), max(wk[u], wk[v])))
    mids = {}
    pairs = []

    def mid(u, v):
        k = (min(u, v), max(u, v))
        if k not in mids:
            mids[k] = d.n + len(pairs); pairs.append(k)
        return mids[k]
    new_prims = []
    for pi, pr in enumerate(d.prims):
        T = pr['indices'].reshape(-1, 3).astype(np.int64)
        out = []
        for a, b, c in T:
            e = [(min(wk[a], wk[b]), max(wk[a], wk[b])) in split, (min(wk[b], wk[c]), max(wk[b], wk[c])) in split,
                 (min(wk[c], wk[a]), max(wk[c], wk[a])) in split]
            k = sum(e)
            if k == 0:
                out.append((a, b, c)); continue
            if k == 3:
                ab, bc, ca = mid(a, b), mid(b, c), mid(c, a)
                out += [(a, ab, ca), (ab, b, bc), (ca, bc, c), (ab, bc, ca)]; continue
            # rotate so the pattern is canonical
            v = [a, b, c]
            r = 0
            if k == 1:
                r = e.index(True)
            else:
                r = [i for i in range(3) if e[i] and e[(i + 1) % 3]][0]
            v = v[r:] + v[:r]
            a_, b_, c_ = v
            if k == 1:
                m = mid(a_, b_)
                out += [(a_, m, c_), (m, b_, c_)]
            else:
                m1, m2 = mid(a_, b_), mid(b_, c_)
                out += [(m1, b_, m2), (a_, m1, m2), (a_, m2, c_)]
        new_prims.append(np.array(out, np.int64).reshape(-1))
    if pairs:
        pa = np.array(pairs)
        u, v = pa[:, 0], pa[:, 1]
        d.P = np.concatenate([d.P, (d.P[u] + d.P[v]) / 2])
        N = (d.N[u] + d.N[v]) / 2; N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)
        d.N = np.concatenate([d.N, N]); d.UV = np.concatenate([d.UV, (d.UV[u] + d.UV[v]) / 2])
        jj, ww = _merge_weights(d.J[u], d.W[u], d.J[v], d.W[v])
        d.J = np.concatenate([d.J, jj]); d.W = np.concatenate([d.W, ww])
        for t in d.targets:
            for key in list(t):
                t[key] = np.concatenate([t[key], (t[key][u] + t[key][v]) / 2])
    for pr, idx in zip(d.prims, new_prims):
        pr['indices'] = idx.astype(np.uint32)
    log(f'sculpt_retopo: subdivided -> {len(pairs)} new verts, {sum(len(i) // 3 for i in new_prims)} tris')
    return len(pairs)


# ---------------------------------------------------------------------------- the sculpt surface
class SurfaceProj:
    def __init__(self, P, T, per_area=2.5e7, cap=4_000_000):
        from scipy.spatial import cKDTree
        self.P, self.T = P, T
        self.X, self.XN = surface_samples(P, T, per_area=per_area, cap=cap)
        self.tree = cKDTree(self.X)

    def along(self, Q, N, max_d=0.03, width=0.0006, step=0.0004):
        """Signed distance along N to the sculpt: march the line both ways, the crossing nearest to Q wins
        (a sample within `width` of the line point counts as a hit)."""
        ts = np.arange(-max_d, max_d + step, step)
        order = np.argsort(np.abs(ts), kind='stable')
        ts = ts[order]
        res = np.full(len(Q), np.nan)
        todo = np.arange(len(Q))
        for t in ts:
            if not len(todo):
                break
            d, _ = self.tree.query(Q[todo] + N[todo] * t, k=1, distance_upper_bound=width)
            hit = np.isfinite(d)
            res[todo[hit]] = t
            todo = todo[~hit]
        return res

    def nearest(self, Q):
        d, i = self.tree.query(Q, k=1)
        return self.X[i], d


def conform(d, verts, proj, max_d=0.035, relax=4, lam=0.45, weight=None, log=print, nearest_max=0.006, max_move=None):
    """Move the welded positions of `verts` onto the sculpt. weight (per welded pos, 0..1) blends the move (1 = on
    the surface). Returns the per-vertex displacement actually applied to d.P."""
    wk = weld_keys(d.P)
    G = wk.max() + 1
    sel = np.zeros(G, bool); sel[wk[verts]] = True
    Pg = np.zeros((G, 3)); np.add.at(Pg, wk, d.P); Pg /= np.bincount(wk, minlength=G)[:, None]
    Ng = np.zeros((G, 3)); np.add.at(Ng, wk, d.N); Ng /= np.maximum(np.linalg.norm(Ng, axis=1, keepdims=True), 1e-9)
    tris = np.concatenate([p['indices'] for p in d.prims]).reshape(-1, 3).astype(np.int64)
    t3 = wk[tris]
    e = np.concatenate([t3[:, [0, 1]], t3[:, [1, 2]], t3[:, [2, 0]]]); e = np.concatenate([e, e[:, ::-1]])
    deg = np.bincount(e[:, 0], minlength=G)[:, None].astype(float)
    idx = np.where(sel)[0]
    Q0 = Pg[idx].copy()
    t = proj.along(Q0, Ng[idx], max_d)
    tgt = Q0 + Ng[idx] * np.nan_to_num(t)[:, None]
    miss = ~np.isfinite(t)
    hold = np.zeros(len(idx), bool)
    if max_move is not None:
        far = np.isfinite(t) & (np.abs(np.nan_to_num(t)) > max_move[idx])
        hold |= far
    if miss.any():
        near, dn = proj.nearest(Q0[miss])
        ok = dn < nearest_max
        tgt[np.where(miss)[0][ok]] = near[ok]
        hold[np.where(miss)[0][~ok]] = True          # far from anything: left to the harmonic fill
    Q = tgt
    for _ in range(relax):
        cur = Pg.copy(); cur[idx] = Q
        acc = np.zeros_like(cur); np.add.at(acc, e[:, 0], cur[e[:, 1]])
        avg = acc / np.maximum(deg, 1)
        step = (avg[idx] - Q) * lam
        n = Ng[idx]
        step -= (step * n).sum(1, keepdims=True) * n          # tangential only
        Q = Q + step
        near, _ = proj.nearest(Q)
        Q = np.where(hold[:, None], Q, near)
    w = np.ones(len(idx)) if weight is None else weight[idx].copy()
    w[hold] = 0.0
    new = Pg.copy(); new[idx] = Q0 + (Q - Q0) * w[:, None]
    Dg = new - Pg
    D = Dg[wk]
    d.P = d.P + D
    sel[idx[hold]] = False
    log(f'sculpt_retopo: conformed {len(idx)} welded verts ({int(miss.sum())} by nearest), move mean '
        f'{1000 * np.linalg.norm(Dg[idx], axis=1).mean():.1f} mm, max {1000 * np.linalg.norm(Dg[idx], axis=1).max():.1f} mm')
    return D, sel, wk


def harmonic_fill(d, D, fixed_mask_welded, wk, iters=200, free_mask_welded=None):
    """Spread a displacement from fixed welded positions over the free ones (e.g. the mouth cavity / eye sockets)."""
    G = wk.max() + 1
    Dg = np.zeros((G, 3)); np.add.at(Dg, wk, D); Dg /= np.bincount(wk, minlength=G)[:, None]
    tris = np.concatenate([p['indices'] for p in d.prims]).reshape(-1, 3).astype(np.int64)
    t3 = wk[tris]
    e = np.concatenate([t3[:, [0, 1]], t3[:, [1, 2]], t3[:, [2, 0]]]); e = np.concatenate([e, e[:, ::-1]])
    deg = np.bincount(e[:, 0], minlength=G)[:, None].astype(float)
    free = ~fixed_mask_welded if free_mask_welded is None else free_mask_welded & ~fixed_mask_welded
    for _ in range(iters):
        acc = np.zeros_like(Dg); np.add.at(acc, e[:, 0], Dg[e[:, 1]])
        Dg = np.where(free[:, None], acc / np.maximum(deg, 1), Dg)
    return Dg[wk]


# ---------------------------------------------------------------------------- checks
def fidelity(P, T, proj, region_fn, samples=200000, rng=None):
    """Distances retopo->sculpt and sculpt->retopo over a region (region_fn(points) -> bool)."""
    from scipy.spatial import cKDTree
    X, _ = surface_samples(P, T, per_area=1.5e7, cap=samples)
    X = X[region_fn(X)]
    _, d1 = proj.nearest(X)
    Y = proj.X[region_fn(proj.X)]
    if len(Y) > samples:
        Y = Y[np.random.default_rng(2).choice(len(Y), samples, replace=False)]
    d2, _ = cKDTree(X).query(Y, k=1)
    f = lambda a: {'mean_mm': round(1000 * float(a.mean()), 2), 'p95_mm': round(1000 * float(np.percentile(a, 95)), 2),  # noqa: E731
                   'max_mm': round(1000 * float(a.max()), 2)}
    return {'retopo_to_sculpt': f(d1), 'sculpt_to_retopo': f(d2)}


def relief(P, T, iters=10):
    """Per-vertex signed height above a Laplacian-smoothed copy (negative = crease / cavity)."""
    import scipy.sparse as sp
    n = len(P)
    e = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]]); e = np.concatenate([e, e[:, ::-1]])
    A = sp.coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n)).tocsr()
    A.data[:] = 1
    deg = np.asarray(A.sum(1)).ravel()
    M = sp.diags(1 / np.maximum(deg, 1)) @ A
    Q = P.copy()
    for _ in range(iters):
        Q = 0.5 * Q + 0.5 * (M @ Q)
    fn = np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]])
    N = np.zeros_like(P)
    for k in range(3):
        np.add.at(N, T[:, k], fn)
    N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)
    return ((P - Q) * N).sum(1), N


def clay(P, T, yaw_deg=0.0, center=None, span=0.3, size=700, light=(0.45, 0.55, 0.7), smooth=False):
    """Orthographic grey-clay render (numpy): per-pixel face normal shading + a little rim, like a sculpt viewport."""
    c = np.asarray(center if center is not None else P.mean(0))
    a = np.radians(yaw_deg)
    R = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
    Q = (P - c) @ R.T
    x0, x1, y0, y1 = -span / 2, span / 2, -span / 2, span / 2
    fn = np.cross(Q[T[:, 1]] - Q[T[:, 0]], Q[T[:, 2]] - Q[T[:, 0]])
    fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-12)
    front = fn[:, 2] > -0.05
    zb, ib = zraster(Q, T[front], np.where(front)[0], x0, x1, y0, y1, size, size)
    img = np.full((size, size, 3), 0.18)
    ok = ib >= 0
    n = fn[ib[ok]]
    if smooth:
        # Gouraud-style: per-pixel barycentric blend of area-weighted vertex normals
        vn = np.zeros_like(Q)
        for k in range(3):
            np.add.at(vn, T[:, k], np.cross(Q[T[:, 1]] - Q[T[:, 0]], Q[T[:, 2]] - Q[T[:, 0]]))
        vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)
        yy, xx = np.nonzero(ok)
        px = x0 + (xx + 0.5) / size * (x1 - x0); py = y1 - (yy + 0.5) / size * (y1 - y0)
        tt = T[ib[ok]]
        A_, B_, C_ = Q[tt[:, 0]], Q[tt[:, 1]], Q[tt[:, 2]]
        den = (B_[:, 1] - C_[:, 1]) * (A_[:, 0] - C_[:, 0]) + (C_[:, 0] - B_[:, 0]) * (A_[:, 1] - C_[:, 1])
        den = np.where(np.abs(den) < 1e-15, 1e-15, den)
        l0 = ((B_[:, 1] - C_[:, 1]) * (px - C_[:, 0]) + (C_[:, 0] - B_[:, 0]) * (py - C_[:, 1])) / den
        l1 = ((C_[:, 1] - A_[:, 1]) * (px - C_[:, 0]) + (A_[:, 0] - C_[:, 0]) * (py - C_[:, 1])) / den
        l2 = 1 - l0 - l1
        n = vn[tt[:, 0]] * l0[:, None] + vn[tt[:, 1]] * l1[:, None] + vn[tt[:, 2]] * l2[:, None]
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    L = np.asarray(light); L = L / np.linalg.norm(L)
    s = np.clip(n @ L, 0, 1) * 0.75 + 0.22 + 0.15 * (1 - np.abs(n[:, 2])) ** 2
    img[ok] = np.clip(np.stack([s * 0.86, s * 0.8, s * 0.74], 1), 0, 1)
    return img


def smooth_mesh(P, T, iters=30, mask=None):
    """Laplacian-smoothed copy (optionally only moving `mask` vertices)."""
    import scipy.sparse as sp
    n = len(P)
    e = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]]); e = np.concatenate([e, e[:, ::-1]])
    A = sp.coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n)).tocsr(); A.data[:] = 1
    M = sp.diags(1 / np.maximum(np.asarray(A.sum(1)).ravel(), 1)) @ A
    Q = P.copy()
    for _ in range(iters):
        Qn = 0.5 * Q + 0.5 * (M @ Q)
        Q = Qn if mask is None else np.where(mask[:, None], Qn, Q)
    return Q


def roughness(P, T, rel, iters=8):
    """Neighbourhood mean of |relief| (hair / beard = rough, skin = smooth)."""
    import scipy.sparse as sp
    n = len(P)
    e = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]]); e = np.concatenate([e, e[:, ::-1]])
    A = sp.coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n)).tocsr(); A.data[:] = 1
    M = sp.diags(1 / np.maximum(np.asarray(A.sum(1)).ravel(), 1)) @ A
    r = np.abs(rel)
    for _ in range(iters):
        r = 0.5 * r + 0.5 * (M @ r)
    return r
