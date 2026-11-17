"""
Cut the HAIR out of a sculpted bust (aligned to the rig, see sculpt_fit) and turn it into an avatar hair mesh:
  * hair = sculpt triangles standing off the rig's skin (> gap) around the head, minus the face front (beard, patch,
    nose ...) and anything below the shoulders / on the garments
  * clean connected pieces, weld, Laplacian-smoothed shading normals (big clean cel shapes, no clump noise)
  * a tone ramp texture instead of a photo texture: u = strand relief (crease -> ink / shade, crest -> light),
    so the sculpted strand grooves read as drawn hair lines
Writes a stage-2 part npz (P, N, UV, J, W, T, bones) for human_face.splice_part.
"""
from __future__ import annotations

import numpy as np

from . import sdf as S
from .sculpt_fit import surface_samples


def cut(Pg, Tg, rig_P, rig_T, keep_fn, gap=0.003, garments=None, garment_gap=0.012, min_piece=60, anchor_y=None):
    from scipy.spatial import cKDTree
    Xr, _ = surface_samples(rig_P, rig_T, per_area=2.0e6)
    tr = cKDTree(Xr)
    c = Pg[Tg].mean(1)
    sel = keep_fn(c)
    d, _ = tr.query(c[sel], k=1)
    idx = np.where(sel)[0][d > gap]
    if garments is not None:
        Xg, _ = surface_samples(*garments, per_area=1.0e6)
        dg, _ = cKDTree(Xg).query(c[idx], k=1)
        idx = idx[dg > garment_gap]
    T = Tg[idx]
    # connected pieces (by shared vertices)
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    used, inv = np.unique(T, return_inverse=True); inv = inv.reshape(-1, 3)
    n = len(used)
    e = np.concatenate([inv[:, [0, 1]], inv[:, [1, 2]]])
    g = coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n))
    k, lab = connected_components(g, directed=False)
    sizes = np.bincount(lab[inv[:, 0]], minlength=k)
    ok = sizes[lab[inv[:, 0]]] >= min_piece
    if anchor_y is not None:
        # only pieces that reach up onto the head (locks), never loose jacket / collar patches
        top = np.full(k, -np.inf)
        np.maximum.at(top, lab, Pg[used, 1])
        ok &= top[lab[inv[:, 0]]] > anchor_y
    T = inv[ok]
    used2, inv2 = np.unique(T, return_inverse=True)
    P = Pg[used[used2]]
    return P, inv2.reshape(-1, 3)


def shade_normals(P, T, iters=8):
    n = np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]])
    N = np.zeros_like(P)
    for k in range(3):
        np.add.at(N, T[:, k], n)
    N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)
    e = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]]); e = np.concatenate([e, e[:, ::-1]])
    deg = np.bincount(e[:, 0], minlength=len(P))[:, None].astype(float)
    raw = N.copy()
    for _ in range(iters):
        acc = np.zeros_like(N); np.add.at(acc, e[:, 0], N[e[:, 1]])
        N = 0.5 * N + 0.5 * acc / np.maximum(deg, 1)
        N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)
    # relief: position relative to a smoothed copy (grooves between locks < 0)
    Q = P.copy()
    for _ in range(12):
        acc = np.zeros_like(Q); np.add.at(acc, e[:, 0], Q[e[:, 1]])
        Q = 0.5 * Q + 0.5 * acc / np.maximum(deg, 1)
    rel = ((P - Q) * N).sum(1)
    return N, raw, rel


def ramp_texture(base, shade_k=0.62, ink_k=0.32, light_k=1.25, size=256):
    b = S.hexc(base) if isinstance(base, str) else np.asarray(base, np.float32)
    u = (np.arange(size) + 0.5) / size
    col = np.zeros((size, 3), np.float32)
    col[:] = b
    col[u < 0.42] = np.clip(b * shade_k, 0, 1)
    col[u < 0.16] = np.clip(b * ink_k, 0, 1)
    col[u > 0.86] = np.clip(b * light_k + 0.03, 0, 1)
    img = np.ones((16, size, 4), np.float32)
    img[..., :3] = col[None]
    return img


def tone_uv(rel, lo_pct=12, hi_pct=90):
    """Relief -> ramp coordinate (0 = deepest groove, 1 = crest)."""
    a, b = np.percentile(rel, lo_pct), np.percentile(rel, hi_pct)
    t = np.clip((rel - a) / max(b - a, 1e-9), 0, 1)
    return np.stack([0.08 + 0.84 * t, np.full(len(t), 0.5)], 1)
