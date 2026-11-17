"""
UV-space rasterisation (numpy only): which texels of a texture a mesh part actually samples, and the 3D rest
position of every such texel ("position map"). Everything face_kit paints is evaluated per texel from these maps,
so marks are crisp vector shapes at full texture resolution and stay continuous across UV seams.

    mask, P, N = posmap(P3, N3, UV, tris, W, H)      # (H,W) bool, (H,W,3) position, (H,W,3) normal
    dilate(rgba, mask, px)                           # bleed colours past island edges (no seam lines)

UV convention: glTF (u right, v DOWN from the top-left), i.e. texel (x, y) = (u*W, v*H).
"""
from __future__ import annotations

import numpy as np


def posmap(P3: np.ndarray, N3: np.ndarray | None, UV: np.ndarray, tris: np.ndarray, W: int, H: int,
           wrap: bool = False):
    tris = np.asarray(tris, np.int64).reshape(-1, 3)
    mask = np.zeros((H, W), bool)
    P = np.zeros((H, W, 3), np.float32)
    N = np.zeros((H, W, 3), np.float32)
    uv = UV.astype(np.float64).copy()
    if wrap:
        uv = uv % 1.0
    xy = np.stack([uv[:, 0] * W - 0.5, uv[:, 1] * H - 0.5], 1)
    for t in tris:
        a, b, c = xy[t[0]], xy[t[1]], xy[t[2]]
        x0 = int(np.floor(min(a[0], b[0], c[0]))); x1 = int(np.ceil(max(a[0], b[0], c[0])))
        y0 = int(np.floor(min(a[1], b[1], c[1]))); y1 = int(np.ceil(max(a[1], b[1], c[1])))
        x0 = max(x0, 0); y0 = max(y0, 0); x1 = min(x1, W - 1); y1 = min(y1, H - 1)
        if x1 < x0 or y1 < y0:
            continue
        den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(den) < 1e-12:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        l0 = ((b[1] - c[1]) * (gx - c[0]) + (c[0] - b[0]) * (gy - c[1])) / den
        l1 = ((c[1] - a[1]) * (gx - c[0]) + (a[0] - c[0]) * (gy - c[1])) / den
        l2 = 1 - l0 - l1
        e = -0.02  # a hair of conservative coverage so edge texels count
        ins = (l0 >= e) & (l1 >= e) & (l2 >= e)
        if not ins.any():
            continue
        yy, xx = gy[ins], gx[ins]
        w0, w1, w2 = l0[ins, None], l1[ins, None], l2[ins, None]
        mask[yy, xx] = True
        P[yy, xx] = w0 * P3[t[0]] + w1 * P3[t[1]] + w2 * P3[t[2]]
        if N3 is not None:
            N[yy, xx] = w0 * N3[t[0]] + w1 * N3[t[1]] + w2 * N3[t[2]]
    if N3 is not None:
        N /= np.maximum(np.linalg.norm(N, axis=-1, keepdims=True), 1e-8)
    return mask, P, N


def _shift(a, dy, dx):
    out = np.zeros_like(a)
    H, W = a.shape[:2]
    ys = slice(max(dy, 0), H + min(dy, 0)); yd = slice(max(-dy, 0), H + min(-dy, 0))
    xs = slice(max(dx, 0), W + min(dx, 0)); xd = slice(max(-dx, 0), W + min(-dx, 0))
    out[ys, xs] = a[yd, xd]
    return out


def dilate(rgba: np.ndarray, mask: np.ndarray, px: int = 12) -> np.ndarray:
    """Push the colours of masked texels outward by `px` texels (alpha kept) so bilinear/mip sampling at island
    borders never pulls in the background — the classic cause of seam lines."""
    out = rgba.copy()
    have = mask.copy()
    for _ in range(px):
        acc = np.zeros(out.shape[:2] + (out.shape[2],), np.float32); cnt = np.zeros(out.shape[:2], np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            h = _shift(have, dy, dx)
            acc += _shift(out, dy, dx) * h[..., None]
            cnt += h
        new = (~have) & (cnt > 0)
        if not new.any():
            break
        out[new] = acc[new] / cnt[new, None]
        have |= new
    return out


def grow(mask: np.ndarray, px: int) -> np.ndarray:
    m = mask.copy()
    for _ in range(px):
        m = m | _shift(m, 1, 0) | _shift(m, -1, 0) | _shift(m, 0, 1) | _shift(m, 0, -1)
    return m


def zraster(P3: np.ndarray, tris: np.ndarray, ids: np.ndarray, x0, x1, y0, y1, W: int, H: int,
            zbuf=None, idbuf=None):
    """Orthographic FRONT view (+Z toward the viewer, the largest z wins) of triangles into an id buffer.
    ids: per-triangle integer label. Returns (zbuf, idbuf); pass them back in to composite several meshes."""
    tris = np.asarray(tris, np.int64).reshape(-1, 3)
    if zbuf is None:
        zbuf = np.full((H, W), -np.inf, np.float64); idbuf = np.full((H, W), -1, np.int64)
    X = (P3[:, 0] - x0) / (x1 - x0) * W - 0.5
    Y = (y1 - P3[:, 1]) / (y1 - y0) * H - 0.5
    Z = P3[:, 2]
    for t, lab in zip(tris, ids):
        a, b, c = t
        xa, xb, xc = X[a], X[b], X[c]; ya, yb, yc = Y[a], Y[b], Y[c]
        gx0 = max(int(np.floor(min(xa, xb, xc))), 0); gx1 = min(int(np.ceil(max(xa, xb, xc))), W - 1)
        gy0 = max(int(np.floor(min(ya, yb, yc))), 0); gy1 = min(int(np.ceil(max(ya, yb, yc))), H - 1)
        if gx1 < gx0 or gy1 < gy0:
            continue
        den = (yb - yc) * (xa - xc) + (xc - xb) * (ya - yc)
        if abs(den) < 1e-12:
            continue
        gx, gy = np.meshgrid(np.arange(gx0, gx1 + 1), np.arange(gy0, gy1 + 1))
        l0 = ((yb - yc) * (gx - xc) + (xc - xb) * (gy - yc)) / den
        l1 = ((yc - ya) * (gx - xc) + (xa - xc) * (gy - yc)) / den
        l2 = 1 - l0 - l1
        ins = (l0 >= 0) & (l1 >= 0) & (l2 >= 0)
        if not ins.any():
            continue
        z = l0 * Z[a] + l1 * Z[b] + l2 * Z[c]
        yy, xx = gy[ins], gx[ins]; zz = z[ins]
        better = zz > zbuf[yy, xx]
        zbuf[yy[better], xx[better]] = zz[better]; idbuf[yy[better], xx[better]] = lab
    return zbuf, idbuf


def read_mesh_merged(m, mi):
    """Model.read_mesh for meshes whose primitives do NOT share vertex buffers (Blender exports one buffer per
    material): concatenates every primitive's vertices into one MeshData (indices offset, morphs aligned)."""
    from anime_creator.vroid import MeshData
    try:
        return m.read_mesh(mi)
    except ValueError:
        pass
    me = m.J['meshes'][mi]
    g = m.g
    Ps, Ns, UVs, Js, Ws, prims, tg = [], [], [], [], [], [], None
    off = 0
    names = list(me.get('extras', {}).get('targetNames') or me['primitives'][0].get('extras', {}).get('targetNames') or [])
    for p in me['primitives']:
        a = p['attributes']
        P = g.read(a['POSITION']).astype(np.float64)
        n = len(P)
        Ps.append(P)
        Ns.append(g.read(a['NORMAL']).astype(np.float64) if 'NORMAL' in a else np.zeros((n, 3)))
        UVs.append(g.read(a['TEXCOORD_0']).astype(np.float64) if 'TEXCOORD_0' in a else np.zeros((n, 2)))
        Js.append(g.read(a['JOINTS_0']).astype(np.int64) if 'JOINTS_0' in a else np.zeros((n, 4), np.int64))
        Ws.append(g.read(a['WEIGHTS_0']).astype(np.float64) if 'WEIGHTS_0' in a else np.zeros((n, 4)))
        ts = p.get('targets', [])
        if tg is None:
            tg = [{} for _ in ts]
        for k, t in enumerate(ts):
            for key, acc in t.items():
                tg[k].setdefault(key, []).append(g.read(acc).astype(np.float64))
        for k in range(len(tg)):
            for key in ('POSITION', 'NORMAL'):
                if k >= len(ts) or key not in ts[k]:
                    if key in tg[k] or key == 'POSITION':
                        tg[k].setdefault(key, []).append(np.zeros((n, 3)))
        prims.append({'material': p.get('material'), 'indices': (g.read(p['indices']).astype(np.int64) + off).astype(np.uint32),
                      'mode': p.get('mode', 4)})
        off += n
    targets = [{k: np.concatenate(v) for k, v in t.items() if sum(len(x) for x in v) == off} for t in (tg or [])]
    if len(names) < len(targets):
        names += [f'morph{i}' for i in range(len(names), len(targets))]
    return MeshData(np.concatenate(Ps), np.concatenate(Ns), np.concatenate(UVs), np.concatenate(Js), np.concatenate(Ws),
                    prims, targets, names)
