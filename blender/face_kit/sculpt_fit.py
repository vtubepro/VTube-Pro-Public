"""
Transfer a SCULPTED head (e.g. the user's Tripo / ZBrush bust: one dense triangle soup, no loops, no rig) onto a
rigged, animatable head (MakeHuman topology with face loops + ARKit shapes) — the sculpt becomes the SHAPE, the rig
head keeps the topology, UVs, weights and every morph (deltas are relative, so expressions stay valid).

    fit = SculptFit(hface, P_src, T_src, to_gltf)   # to_gltf: (n,3) source -> glTF space (similarity)
    fit.run(excl_fn)                               # excl_fn(a, b) -> bool mask of face-space regions NOT to copy
                                                   # (beard, hair, eye patch ... = sculpted things that aren't skin)
    fit.beard_thickness(mask_fn)                   # per-vertex sculpt distance outside the new skin (beard shell)

How: every front-head vertex looks along its normal for the sculpt surface (dense surface samples + KD tree,
normal-aligned offsets only), regions that are not skin are unknown, the displacement is filled harmonically,
smoothed and clamped; the eyes and the mouth move RIGIDLY (lids + eyeballs together; upper + lower lip together)
so blinks / visemes stay valid; the neck and the back of the head fade out. Eyes / teeth meshes follow.
"""
from __future__ import annotations

import numpy as np

from . import sdf as S


def surface_samples(P, T, per_area=4.0e6, cap=1_500_000, rng=None):
    """Uniform random points (+ face normals) on a triangle mesh (density per m^2)."""
    rng = rng or np.random.default_rng(3)
    a, b, c = P[T[:, 0]], P[T[:, 1]], P[T[:, 2]]
    n = np.cross(b - a, c - a); ar = np.linalg.norm(n, axis=1) * 0.5
    n /= np.maximum(ar[:, None] * 2, 1e-12)
    k = np.minimum(np.maximum(1, np.round(ar * per_area)).astype(int), 50)
    if k.sum() > cap:
        k = np.maximum(1, (k * cap / k.sum()).astype(int))
    idx = np.repeat(np.arange(len(T)), k)
    u = rng.random(len(idx)); v = rng.random(len(idx))
    f = u + v > 1; u[f] = 1 - u[f]; v[f] = 1 - v[f]
    X = a[idx] + (b[idx] - a[idx]) * u[:, None] + (c[idx] - a[idx]) * v[:, None]
    return X, n[idx]


class SculptFit:
    def __init__(self, hf, P_src, T_src, log=print):
        self.h = hf; self.log = log
        from scipy.spatial import cKDTree
        d = hf.d
        lo = d.P[d.prims[0]['indices']].min(0) - 0.05; hi = d.P[d.prims[0]['indices']].max(0) + 0.05
        keep = ((P_src > lo) & (P_src < hi)).all(1)
        T = T_src[keep[T_src].all(1)]
        self.X, self.XN = surface_samples(P_src, T)
        self.tree = cKDTree(self.X)
        self.log(f'sculpt_fit: {len(T)} source tris near the head, {len(self.X)} surface samples')

    def _welded(self, verts, tris):
        d = self.h.d
        key = np.round(d.P[verts] * 1e5).astype(np.int64)
        _, inv = np.unique(key, axis=0, return_inverse=True); inv = inv.ravel()
        loc = -np.ones(d.n, np.int64); loc[verts] = inv
        t = loc[tris.reshape(-1, 3)]; t = t[(t >= 0).all(1)]
        e = np.concatenate([t[:, [0, 1]], t[:, [1, 2]], t[:, [2, 0]]]); e = np.concatenate([e, e[:, ::-1]])
        return inv, inv.max() + 1, e

    def normal_hit(self, Pv, Nv, max_d):
        """Signed distance along the normal to the sculpt (nearest sample within a thin cylinder around the normal)."""
        k = 24
        dd, ii = self.tree.query(Pv, k=k, distance_upper_bound=max_d * 1.5)
        ok = np.isfinite(dd)
        ii = np.where(ok, ii, 0)
        Q = self.X[ii] - Pv[:, None, :]
        along = (Q * Nv[:, None, :]).sum(-1)
        perp = np.linalg.norm(Q - along[..., None] * Nv[:, None, :], axis=-1)
        score = np.where(ok & (perp < max_d * 0.35), perp + np.abs(along) * 0.15, np.inf)
        j = np.argmin(score, 1)
        best = score[np.arange(len(Pv)), j]
        t = along[np.arange(len(Pv)), j]
        return np.where(np.isfinite(best), t, np.nan)

    def run(self, excl_fn, max_d=0.02, iters=300, smooth=12, smooth2=20, clamp=0.01, eye_r=0.021, fade=(0.03, 0.07),
            mouth_r=(0.045, 0.03), strength=1.0, max_known=0.008, outlier=0.003):
        h = self.h; d = h.d
        tris = np.concatenate([p['indices'] for p in d.prims])
        verts = np.unique(d.prims[0]['indices'])
        inv, G, e = self._welded(verts, tris)
        Pg = np.zeros((G, 3)); np.add.at(Pg, inv, d.P[verts]); Pg /= np.bincount(inv, minlength=G)[:, None]
        Ng = np.zeros((G, 3)); np.add.at(Ng, inv, d.N[verts]); Ng /= np.maximum(np.linalg.norm(Ng, axis=1, keepdims=True), 1e-9)
        a, b = h._ab(Pg)
        front = (Pg[:, 2] > h.zc - 0.01) & (Pg[:, 1] > h.chin[1] - 0.04)
        ex = excl_fn(a, b)
        for c, r in h.eyeballs:
            ex |= np.linalg.norm((Pg - c) * np.array([1.0, 1.0, 1.3]), axis=1) < eye_r
        mc = np.array([0.0, h.mouth_y, h.mouth[2]])
        rm = np.linalg.norm((Pg - mc) / np.array([mouth_r[0], mouth_r[1], 0.03]), axis=1)
        ex |= rm < 1.0
        t = np.full(G, np.nan)
        sel = front & ~ex
        t[sel] = self.normal_hit(Pg[sel], Ng[sel], max_d)
        known = np.isfinite(t) & (np.abs(np.nan_to_num(t)) <= max_known)
        t = np.where(known, t, np.nan)
        # robust: drop targets that disagree with their neighbourhood (hits on beard spikes / hair tips)
        tt = np.where(known, t, 0.0); ww = known.astype(float)
        for _ in range(6):
            a1 = np.zeros(G); w1 = np.zeros(G)
            np.add.at(a1, e[:, 0], tt[e[:, 1]]); np.add.at(w1, e[:, 0], ww[e[:, 1]])
            tt = np.where(known, tt, 0.0); nb_mean = a1 / np.maximum(w1, 1e-9)
        bad = known & (w1 > 2) & (np.abs(t - nb_mean) > outlier)
        known &= ~bad
        D = np.zeros((G, 3)); D[known] = Ng[known] * np.nan_to_num(t[known, None])
        self.log(f'sculpt_fit: dropped {int(bad.sum())} outlier targets')
        self.log(f'sculpt_fit: {int(known.sum())} known of {int(front.sum())} front verts, mean |d| {1000 * np.nanmean(np.abs(t)):.1f} mm')
        deg = np.bincount(e[:, 0], minlength=G)[:, None].astype(np.float64)

        def relax(D, mask, n):
            for _ in range(n):
                acc = np.zeros_like(D); np.add.at(acc, e[:, 0], D[e[:, 1]])
                D = np.where(mask[:, None], acc / np.maximum(deg, 1), D)
            return D

        def smooth_(D, n):
            for _ in range(n):
                acc = np.zeros_like(D); np.add.at(acc, e[:, 0], D[e[:, 1]])
                D = 0.5 * D + 0.5 * acc / np.maximum(deg, 1)
            return D
        # outside the front of the face the displacement decays to zero (back of head, neck)
        edge = ~front
        D[edge] = 0
        D = relax(D, ~known & ~edge, iters)
        D = smooth_(D, smooth)
        # rigid eyes + mouth
        self.eye_move = []
        for c, r in h.eyeballs:
            rr = np.linalg.norm((Pg - c) * np.array([1.0, 1.0, 1.3]), axis=1)
            rim = (rr > eye_r) & (rr < eye_r * 1.7)
            m_ = D[rim].mean(0) if rim.any() else np.zeros(3)
            w_ = 1 - S.smoothstep(eye_r * 0.9, eye_r * 1.5, rr)
            D = D * (1 - w_[:, None]) + m_[None] * w_[:, None]
            self.eye_move.append(m_)
        ring = (rm > 1.0) & (rm < 1.6)
        self.mouth_move = D[ring].mean(0) if ring.any() else np.zeros(3)
        w_ = 1 - S.smoothstep(0.9, 1.5, rm)
        D = D * (1 - w_[:, None]) + self.mouth_move[None] * w_[:, None]
        D = smooth_(D, smooth2)
        mag = np.linalg.norm(D, axis=1)
        D *= np.minimum(1, clamp / np.maximum(mag, 1e-9))[:, None]
        # fade toward the back / neck
        f = S.smoothstep(h.zc - fade[1], h.zc - fade[0] + 0.03, Pg[:, 2]) * S.smoothstep(h.chin[1] - 0.06, h.chin[1] - 0.01, Pg[:, 1])
        D *= (f * strength)[:, None]
        # apply to every vertex that shares a position with the head (all prims), morph deltas unchanged
        Dv = np.zeros((d.n, 3))
        key_all = np.round(d.P * 1e5).astype(np.int64)
        lut = {tuple(k): i for k, i in zip(np.round(Pg * 1e5).astype(np.int64), range(G))}
        for vi in range(d.n):
            g = lut.get(tuple(key_all[vi]))
            if g is not None:
                Dv[vi] = D[g]
        d.P = d.P + Dv
        self.D = Dv
        self.log(f'sculpt_fit: displacement mean {1000 * np.linalg.norm(D[front], axis=1).mean():.1f} mm, max '
                 f'{1000 * np.linalg.norm(D, axis=1).max():.1f} mm; mouth moved {(1000 * self.mouth_move).round(1)} mm, '
                 f'eyes {[list((1000 * v).round(1)) for v in self.eye_move]} mm')
        return Dv

    def move_mesh_rigid(self, m, mesh_name, disp):
        from .raster import read_mesh_merged
        mi = m.mesh_index(mesh_name)
        if mi is None:
            return
        dm = read_mesh_merged(m, mi)
        dm.P = dm.P + disp
        m.write_mesh(mi, dm)

    def thickness(self, verts_P, verts_N, max_d=0.03):
        """Outward distance from (new) skin points to the sculpt surface along their normals (beard / moustache)."""
        t = self.normal_hit(verts_P + verts_N * 0.0005, verts_N, max_d)
        return np.where(np.isfinite(t), np.clip(t, 0, max_d), 0.0)
