"""
Clean cel repaint of a garment atlas (any UV layout — everything is evaluated per texel in 3D via raster.posmap):

  * texel classes from the existing colours (light cloth / dark cloth / skin / other) -> flat class colours
  * ink lines where two classes meet in 3D (lapels, shirt V, cuffs, collar, belt, shoes), constant width in mm
  * designed tailoring marks from body landmarks: buttons, flap + chest pockets, back seam + vent, sleeve buttons,
    trouser creases
  * fold shadows: one hard shade tone where the cloth creases (relief = distance below a smoothed copy of the
    surface), island-cleaned so mesh noise never becomes dirt

    suit_paint.paint(model, 'Outfit', spec=None)
"""
from __future__ import annotations

import numpy as np

from anime_creator import imgio

from . import sdf as S
from .raster import posmap, dilate, read_mesh_merged

SPEC = {
    'size': 2048,
    'light': '#c6c6c4', 'lightFold': '#9d9ca6', 'dark': '#1f1c1e', 'darkFold': '#0f0d0f',
    'ink': '#2b2a30', 'inkW': 0.0018, 'inkDark': '#060506',
    'button': '#2a2a2e', 'buttonR': 0.0075,
    'fold': 0.14,                       # fraction of cloth texels that get the fold shade (the deepest creases)
    'relaxIters': 40,
}


def _hsv(rgb):
    mx = rgb.max(-1); mn = rgb.min(-1)
    s = np.where(mx > 1e-4, (mx - mn) / np.maximum(mx, 1e-4), 0)
    return mx, s


def _relief(d, tris, iters):
    """Per-vertex signed distance of the surface to a Laplacian-smoothed copy (negative = in a crease)."""
    P = d.P
    key = np.round(P * 1e5).astype(np.int64)
    _, inv = np.unique(key, axis=0, return_inverse=True); inv = inv.ravel()
    G = inv.max() + 1
    Pg = np.zeros((G, 3)); np.add.at(Pg, inv, P); Pg /= np.bincount(inv, minlength=G)[:, None]
    t = inv[tris.reshape(-1, 3)]
    e = np.concatenate([t[:, [0, 1]], t[:, [1, 2]], t[:, [2, 0]]]); e = np.concatenate([e, e[:, ::-1]])
    deg = np.bincount(e[:, 0], minlength=G)[:, None].astype(np.float64)
    Q = Pg.copy()
    for _ in range(iters):
        acc = np.zeros_like(Q); np.add.at(acc, e[:, 0], Q[e[:, 1]])
        Q = 0.5 * Q + 0.5 * acc / np.maximum(deg, 1)
    Ng = np.zeros((G, 3)); np.add.at(Ng, inv, d.N); Ng /= np.maximum(np.linalg.norm(Ng, axis=1, keepdims=True), 1e-9)
    r = ((Pg - Q) * Ng).sum(1)
    return r[inv]


def _islands(mask, min_px):
    """Remove connected islands smaller than min_px (4-neighbour flood labelling via scipy)."""
    from scipy import ndimage
    lab, n = ndimage.label(mask)
    if n == 0:
        return mask
    sizes = ndimage.sum(mask, lab, index=np.arange(1, n + 1))
    keep = np.zeros(n + 1, bool); keep[1:] = sizes >= min_px
    return keep[lab]


def transfer_bake(src_img, ref, P, mask, per_area=7.0e5):
    """Colour every texel of a (decimated / re-UV'd) mesh from the ORIGINAL mesh's texture at the same 3D point:
    ref = (P_orig, UV_orig, T_orig). Decimation collapses edges across UV seams; sampling the old UVs then pulls in
    the atlas background (dark blotches). Baking by 3D position never does."""
    from scipy.spatial import cKDTree
    Po, UVo, To = ref
    rng = np.random.default_rng(5)
    a, b, c = Po[To[:, 0]], Po[To[:, 1]], Po[To[:, 2]]
    ar = np.linalg.norm(np.cross(b - a, c - a), axis=1) * 0.5
    k = np.minimum(np.maximum(1, np.round(ar * per_area)).astype(int), 30)
    idx = np.repeat(np.arange(len(To)), k)
    u = rng.random(len(idx)); v = rng.random(len(idx)); f = u + v > 1; u[f] = 1 - u[f]; v[f] = 1 - v[f]
    w0 = 1 - u - v
    X = a[idx] * w0[:, None] + b[idx] * u[:, None] + c[idx] * v[:, None]
    UV = UVo[To[idx, 0]] * w0[:, None] + UVo[To[idx, 1]] * u[:, None] + UVo[To[idx, 2]] * v[:, None]
    H, W = src_img.shape[:2]
    px = np.clip((UV[:, 0] * W).astype(int), 0, W - 1); py = np.clip((UV[:, 1] * H).astype(int), 0, H - 1)
    col = src_img[py, px, :3]
    _, nn = cKDTree(X).query(P[mask], k=1)
    out = src_img.copy()
    out[mask, :3] = col[nn]
    return out


def paint(m, mesh_name='Outfit', spec=None, log=print, ref=None):
    from scipy.spatial import cKDTree
    sp = {**SPEC, **(spec or {})}
    mi = m.mesh_index(mesh_name)
    d = read_mesh_merged(m, mi)
    tris = np.concatenate([p['indices'] for p in d.prims])
    J = m.J
    mat = d.prims[0]['material']
    ti = J['materials'][mat]['pbrMetallicRoughness']['baseColorTexture']['index']
    src = imgio.decode(m.g.image_bytes(J['textures'][ti]['source']))
    N_ = sp['size']
    src = imgio.resize(src, N_, N_) if src.shape[0] != N_ else src
    mask, P, Nrm = posmap(d.P, d.N, d.UV, tris, N_, N_)
    if ref is not None:
        src = transfer_bake(src, ref, P, mask)
        log('face_kit: suit colours baked from the original mesh by 3D position')
    rel = _relief(d, tris, sp['relaxIters'])
    A = np.zeros((d.n, 3)); A[:, 0] = rel
    _, R, _ = posmap(A, None, d.UV, tris, N_, N_)
    rel_t = R[..., 0]
    # classes per VERTEX (colour at its UV), cleaned by neighbour voting, interpolated per texel -> clean borders
    H_, W_ = src.shape[:2]
    uv = d.UV
    px_ = np.clip((uv[:, 0] % 1.0) * W_, 0, W_ - 1).astype(int); py_ = np.clip((uv[:, 1] % 1.0) * H_, 0, H_ - 1).astype(int)
    vc = src[py_, px_, :3]
    v, s = _hsv(vc)
    c_skin = (s > 0.28) & (v > 0.35) & (vc[:, 0] > vc[:, 2] * 1.25)
    c_light = ~c_skin & (v > 0.42)
    oh = np.stack([c_light, ~c_skin & ~c_light, c_skin], 1).astype(np.float64)
    key = np.round(d.P * 1e5).astype(np.int64)
    _, inv = np.unique(key, axis=0, return_inverse=True); inv = inv.ravel()
    G = inv.max() + 1
    t3 = inv[tris.reshape(-1, 3)]
    e = np.concatenate([t3[:, [0, 1]], t3[:, [1, 2]], t3[:, [2, 0]]]); e = np.concatenate([e, e[:, ::-1]])
    og = np.zeros((G, 3)); np.add.at(og, inv, oh)
    for _ in range(sp.get('vote', 2)):
        acc = og.copy(); np.add.at(acc, e[:, 0], og[e[:, 1]])
        og = acc / np.maximum(acc.sum(1, keepdims=True), 1e-9)
    # texel classes from the original texture, denoised by a 3D majority vote (k nearest texels in SPACE, so UV
    # islands / seams don't matter); the base colours stay the original flat colours (no repaint = no new noise)
    from scipy.spatial import cKDTree as _KD
    tv, ts = _hsv(src[..., :3])
    t_skin = mask & (ts > 0.25) & (tv > 0.62) & (src[..., 0] > src[..., 2] * 1.25)
    t_light = mask & ~t_skin & (tv > 0.3) & ~((tv < 0.42) & (ts < 0.2))
    cls0 = np.where(t_light, 0, np.where(t_skin, 2, 1))[mask]
    pts_all = P[mask]
    rng = np.random.default_rng(1)
    sub = rng.choice(len(pts_all), size=min(len(pts_all), 350000), replace=False)
    tree = _KD(pts_all[sub])
    _, nn = tree.query(pts_all, k=sp.get('voteK', 25))
    votes = np.stack([(cls0[sub][nn] == c).sum(1) for c in range(3)], 1)
    cls = np.argmax(votes, 1)
    light = np.zeros(mask.shape, bool); dark = np.zeros(mask.shape, bool); skin = np.zeros(mask.shape, bool)
    light[mask] = cls == 0; dark[mask] = cls == 1; skin[mask] = cls == 2
    out = src.copy()
    flip_l = mask & light & ~t_light          # stray dark specks inside cloth -> cloth colour
    out[flip_l, :3] = S.hexc(sp['light'])
    flip_d = mask & dark & t_light
    out[flip_d, :3] = S.hexc(sp['dark'])
    # dark blocks the old texture painted where the pockets are -> cloth (the pockets are drawn as ink below)
    try:
        hy = float(m.pos('hips')[1]); cy = float(m.pos('upperChest')[1])
    except Exception:  # noqa: BLE001
        hy, cy = 1.0, 1.35
    X_, Y_ = P[..., 0], P[..., 1]
    frontal = Nrm[..., 2] > 0.2
    pk = frontal & ~t_skin & (((Y_ > hy - 0.06) & (Y_ < hy + 0.07) & (np.abs(X_) > 0.07) & (np.abs(X_) < 0.22)) |
                              ((Y_ > cy - 0.02) & (Y_ < cy + 0.07) & (X_ > 0.06) & (X_ < 0.2)))
    pk &= dark & ~_islands(dark, 20000)
    # regions that are jacket by construction (spec['jacketOnly'](P, N) -> bool): old texture marks there are noise
    if sp.get('jacketOnly') is not None:
        pk |= dark & sp['jacketOnly'](P, Nrm)
    out[pk, :3] = S.hexc(sp['light']); light |= pk; dark &= ~pk
    # fold shadows: deepest creases of each cloth class, hard edged, island-cleaned
    for cls, col in ((light, sp['lightFold']), (dark, sp['darkFold'])):
        if cls.sum() < 100:
            continue
        thr = np.percentile(rel_t[cls], sp['fold'] * 100)
        f = cls & (rel_t < min(thr, -0.0006))
        f = _islands(f, 90)
        out[f, :3] = S.hexc(col)
    # ink where classes meet (in 3D, constant width)
    pts = P[mask]; cl = np.where(light[mask], 0, np.where(dark[mask], 1, 2))
    ink = np.zeros(mask.shape, bool)
    for c0 in (0, 1):
        others = pts[cl != c0]
        if len(others) == 0:
            continue
        tree = cKDTree(others[:: max(1, len(others) // 400000)])
        sel = np.where(mask.ravel())[0][cl == c0]
        dd, _ = tree.query(pts[cl == c0], k=1, distance_upper_bound=sp['inkW'])
        hit = sel[np.isfinite(dd)]
        ink.ravel()[hit] = True
    ink &= light                                  # the line sits on the light cloth side (reads as the edge)
    out[ink, :3] = S.hexc(sp['ink'])
    # tailoring marks (front: +z faces the viewer in this glTF)
    X, Y, Z = P[..., 0], P[..., 1], P[..., 2]
    front = mask & (Nrm[..., 2] > 0.25); back = mask & (Nrm[..., 2] < -0.25)

    def node_y(name, default):
        try:
            return float(m.pos(name)[1])
        except Exception:  # noqa: BLE001
            return default
    hips = node_y('hips', 1.0); chest = node_y('upperChest', 1.35)
    pw = sp['inkW'] * 0.8

    def line(x0, y0, x1, y1, region, col=sp['ink'], w=pw):
        dd, _ = S.polyline(X, Y, np.array([[x0, y0], [x1, y1]]), w)
        k = (S.cover(dd, 0.0007) > 0.5) & region & light
        out[k, :3] = S.hexc(col)

    # jacket buttons (2) on the wearer's left panel edge, waist height
    for yb in (hips + 0.10, hips + 0.19):
        dd = S.ellipse(X, Y, 0.012, yb, sp['buttonR'], sp['buttonR'])
        k = (dd < 0) & front & (Y > hips) & (np.abs(X) < 0.06)
        out[k, :3] = S.hexc(sp['button'])
    # flap pockets (both hips) + chest pocket (wearer's left = +x)
    for sg in (-1, 1):
        cx = sg * 0.13; y0 = hips + 0.02
        line(cx - 0.075, y0, cx + 0.075, y0, front & (np.abs(X - cx) < 0.09))
        line(cx - 0.075, y0 - 0.045, cx + 0.075, y0 - 0.045, front & (np.abs(X - cx) < 0.09))
        for xe in (cx - 0.075, cx + 0.075):
            line(xe, y0, xe, y0 - 0.045, front & (np.abs(X - cx) < 0.09))
    line(0.08, chest + 0.03, 0.17, chest + 0.035, front & (X > 0.05))
    # back seam + vent
    line(0.0, chest + 0.2, 0.0, hips - 0.12, back)
    # trouser creases (front of each leg)
    for sg in (-1, 1):
        lx = sg * 0.095
        line(lx, hips - 0.12, lx, 0.1, front & (np.abs(X - lx) < 0.04) & (Y < hips - 0.08))
    out = dilate(out, mask, 6)
    ii = m.g.add_image(imgio.encode(out), 'outfit_cel')
    J['textures'][ti] = {'source': ii, 'sampler': J['textures'][ti].get('sampler', 0)}
    pbr = J['materials'][mat]['pbrMetallicRoughness']; pbr['roughnessFactor'] = 1.0; pbr['metallicFactor'] = 0.0
    pbr.pop('metallicRoughnessTexture', None); J['materials'][mat].pop('normalTexture', None)
    log(f'face_kit: suit repainted ({int(light.sum())} light / {int(dark.sum())} dark / {int(skin.sum())} skin texels, '
        f'{int(ink.sum())} ink)')
    return out
