"""Post-build face adjustments measured from the Live2D art (numpy, on the finished VRM):

  * eye opening: a narrower drawn eye (male / cool / sleepy designs) is made by baking part of the VRoid close morph
    into the rest shape -- the lids come down, the round iris stays round and gets clipped like in the drawing -- and
    shortening every close / blink morph by the same share so a blink still lands exactly closed.

Shared face_kit / anime_creator code is not modified; this runs after them.
"""
import re

import numpy as np

from anime_creator.vroid import Model

# VRoid bases, eye opening height / width (measured with anime_creator.vroid, see design.BASE_METRICS)
BASE_ASPECT = {'fumiriya': 0.66, 'hairsample_male': 0.57, 'shibu': 0.72, 'shino': 0.77, 'darkness_shibu': 0.68,
               'hairsample_female': 0.73}
# every morph that lowers the upper lid: with part of the close baked in, its remaining travel shrinks by the same share
CLOSE_RX = re.compile(r'Fcl_EYE_(Close|Joy|Angry|Sorrow)(_[LR])?$|^eyeBlink(Left|Right)$|^eyeSquint(Left|Right)$')


# the same bases measured like eyefit measures the drawing (tallest column of the opening / corner-to-corner width)
BASE_COL_ASPECT = {'fumiriya': 0.601, 'hairsample_male': 0.513, 'shibu': 0.684, 'shino': 0.729}


def lid_bake_amount(base, l2d_aspect, fitted=False):
    """share of the close morph baked into the rest pose (0 = keep the base's opening).
    fitted=True: l2d_aspect comes from eyefit (column height), compared with BASE_COL_ASPECT"""
    b = (BASE_COL_ASPECT if fitted else BASE_ASPECT).get(base, 0.7)
    # fitted: the close morph moves the upper lid only while the drawn opening narrows from both lids -> x2.4
    return float(np.clip((2.0 if fitted else 1.6) * (b - l2d_aspect) / b, 0.0, 0.4))


def narrow_eyes(vrm_in, vrm_out, k, log=print):
    if k <= 0.01:
        return False
    m = Model(vrm_in)
    fi = m.mesh_index('Face')
    d = m.read_mesh(fi)
    names = list(d.target_names)
    both = next((i for i, n in enumerate(names) if n.endswith('Fcl_EYE_Close')), None)
    if both is None:
        log('faceadj: no Fcl_EYE_Close morph, eye opening unchanged')
        return False
    C = d.targets[both]['POSITION']
    d.P = d.P + k * C
    if 'NORMAL' in d.targets[both]:
        pass                                         # shading normals come from the face proxy; keep them
    scaled = []
    for i, n in enumerate(names):
        if CLOSE_RX.search(n):
            d.targets[i]['POSITION'] = d.targets[i]['POSITION'] * (1 - k)
            scaled.append(n.split('.')[-1])
    m.write_mesh(fi, d)
    m.save(vrm_out)
    log(f'faceadj: eyes narrowed by baking {k:.2f} of the close morph ({len(scaled)} close/blink morphs rescaled)')
    return True


def lid_template(vrm_in, vrm_out, curves, log=print, k_min=0.0, k_max=0.85, k_low_max=0.6):
    """the DRAWN upper-lid line as the eye's shape (authored design, not a uniform narrowing): per eye column u the
    share of the VRoid close morph that brings the base's upper lid down (or, a little, up) onto the drawn lid line.

    curves: eyefit's {'u': [...], 'upper': rise of the drawn upper lid over the inner->outer corner line / eye width}.
    The base's lid line comes from the skin's eye-hole loop (face_kit.vroid_face.Eye), its closed line from the same
    loop with the close morph applied; each close-morph vertex gets k(u) at its own column, and every close / blink
    morph is shortened per vertex by the same share so a blink still lands exactly closed. -> the mean k (for logs),
    or None when the face has no close morph / eye loops."""
    from face_kit.vroid_face import VFace
    from scipy.spatial import cKDTree
    m = Model(vrm_in)
    fi = m.mesh_index('Face')
    d = m.read_mesh(fi)
    names = list(d.target_names)
    both = next((i for i, n in enumerate(names) if n.endswith('Fcl_EYE_Close')), None)
    if both is None:
        log('faceadj: no Fcl_EYE_Close morph, lid template skipped')
        return None
    C = np.asarray(d.targets[both]['POSITION'], float)
    try:
        V = VFace(m, log=lambda s: None)
    except Exception as e:
        log(f'faceadj: eye loops not found ({e}), lid template skipped')
        return None
    # never OPENED wider than the base (a negative share extrapolates the close morph backwards and every blink /
    # squint morph then overshoots -- Haru's neutral read closed): k >= 0 for both lids
    us = np.asarray(curves['u'], float); rise = np.asarray(curves['upper'], float)
    moving = np.linalg.norm(C, axis=1) > 1e-6
    sq_idx = [i for i, n in enumerate(names) if n.split('.')[-1] in ('eyeSquintLeft', 'eyeSquintRight')]
    Sq = None
    if len(sq_idx) == 2:
        Sq = np.asarray(d.targets[sq_idx[0]]['POSITION'], float) + np.asarray(d.targets[sq_idx[1]]['POSITION'], float)
        sq_moving = np.linalg.norm(Sq, axis=1) > 1e-6
    K2 = np.zeros(len(d.P))
    ks_low = []
    tree = cKDTree(d.P)
    K = np.zeros(len(d.P))
    ks_log = []
    for e in V.eyes:
        # the eye-hole loop's vertices and their closed positions
        _, li = tree.query(e.loop)
        cl = d.P[li] + C[li]
        cin, cout = e.corner_in, e.corner_out
        W = float(np.linalg.norm(cout - cin))
        uu = np.linspace(0.0, 1.0, 41)
        X = cin[0] + (cout[0] - cin[0]) * uu
        line = cin[1] + (cout[1] - cin[1]) * uu
        base_top = e.ytop(X)
        # closed upper lid: the upper loop verts (above the corner line) after the morph, as a function of x
        up_sel = (e.loop[:, 1] >= np.interp(e.loop[:, 0], [min(cin[0], cout[0]), max(cin[0], cout[0])],
                                            [cin[1], cout[1]] if cin[0] < cout[0] else [cout[1], cin[1]]) - 1e-9)
        cu = cl[up_sel]
        o = np.argsort(cu[:, 0])
        closed_top = np.interp(X, cu[o, 0], cu[o, 1])
        target = line + np.interp(uu, us, rise) * W
        # the lid's HEIGHT from the drawn iris tuck (the share of the iris hidden under the upper lid -- a half-lidded
        # male eye hides a quarter of it, a round female eye almost none): the drawn curve is shifted so that at the
        # iris column it covers that share of the painted iris (at most a quarter eye width either way)
        ir = min(V.irises, key=lambda q: abs(q['cx'] - e.cx))
        if curves.get('tuck') is not None:
            ui = float(np.clip((ir['cx'] - cin[0]) / (cout[0] - cin[0]), 0.05, 0.95))
            want = ir['cy'] + ir['ry'] - 2 * ir['ry'] * float(curves['tuck'])
            shift = float(np.clip(want - np.interp(ui, uu, target), -0.25 * W, 0.25 * W))
            target = target + shift
        travel = base_top - closed_top
        k = np.where(travel > 1e-5, (base_top - target) / np.maximum(travel, 1e-5), 0.0)
        k = np.clip(k, k_min, k_max)
        k = np.convolve(np.pad(k, 3, mode='edge'), np.ones(7) / 7, mode='valid')     # a smooth lid, no kinks
        ks_log.append(k)
        # every close-morph vertex on this side takes k at its own column (clamped past the corners)
        side = moving & (np.sign(d.P[:, 0]) == np.sign(e.cx))
        uv = np.clip((d.P[side, 0] - cin[0]) / (cout[0] - cin[0]), 0, 1)
        K[side] = np.interp(uv, uu, k)
        # the LOWER lid onto the drawn lower line with the squint morph (it raises the lower lid): the drawn eye's
        # lower lid touching / tucking the iris is half of what makes a sharp male eye vs a round one
        if Sq is not None and curves.get('lower') is not None:
            drop = np.asarray(curves['lower'], float)
            t_low = line - np.interp(uu, us, drop) * W
            if curves.get('lower_tuck') is not None:
                want_l = ir['cy'] - ir['ry'] + 2 * ir['ry'] * float(curves['lower_tuck'])
                ui = float(np.clip((ir['cx'] - cin[0]) / (cout[0] - cin[0]), 0.05, 0.95))
                t_low = t_low + float(np.clip(want_l - np.interp(ui, uu, t_low), -0.25 * W, 0.25 * W))
            base_low = e.ylow(X)
            lo_sel = ~up_sel
            sq = d.P[li] + Sq[li]
            cq = sq[lo_sel]
            o2 = np.argsort(cq[:, 0])
            sq_low = np.interp(X, cq[o2, 0], cq[o2, 1])
            trav = sq_low - base_low
            kl = np.where(trav > 1e-5, (t_low - base_low) / np.maximum(trav, 1e-5), 0.0)
            kl = np.clip(kl, 0.0, k_low_max)
            kl = np.convolve(np.pad(kl, 3, mode='edge'), np.ones(7) / 7, mode='valid')
            ks_low.append(kl)
            sside = sq_moving & (np.sign(d.P[:, 0]) == np.sign(e.cx))
            uv2 = np.clip((d.P[sside, 0] - cin[0]) / (cout[0] - cin[0]), 0, 1)
            K2[sside] = np.interp(uv2, uu, kl)
    d.P = d.P + K[:, None] * C
    if Sq is not None:
        d.P = d.P + K2[:, None] * Sq
    scaled = 0
    for i, n in enumerate(names):
        if i in sq_idx:
            # a squint still lands where it did: its remaining travel shrinks by the share baked in
            d.targets[i]['POSITION'] = np.asarray(d.targets[i]['POSITION']) * (1 - K2)[:, None]
            scaled += 1
        elif CLOSE_RX.search(n):
            d.targets[i]['POSITION'] = np.asarray(d.targets[i]['POSITION']) * (1 - K)[:, None]
            scaled += 1
    m.write_mesh(fi, d)
    m.save(vrm_out)
    km = np.mean([k.mean() for k in ks_log])
    log(f'faceadj: drawn lid line applied (close share per column {np.round(ks_log[0][::8], 2).tolist()}, '
        f'mean {km:.2f}' + (f'; lower lid squint share {np.round(ks_low[0][::8], 2).tolist()}' if ks_low else '')
        + f'; {scaled} lid morphs rescaled per vertex)')
    return float(km)


def shark_teeth(vrm_in, vrm_out, n_teeth=7, log=print):
    """teeth drawn POINTED (a shark-tooth grin in the character's drawings): the VRoid mouth texture's drawn teeth
    strip gets a sawtooth biting edge -- flat, drawn teeth (house rule), only their painted outline changes; the
    cut-away part takes the mouth interior's colour, a thin dark line follows the new edge"""
    from anime_creator import colors
    m = Model(vrm_in)
    fi = m.mesh_index('Face')
    d = m.read_mesh(fi)
    mats = [p['material'] for p in d.prims if 'FaceMouth' in m.mat_name(p['material'])]
    if not mats:
        return False
    tx = colors.Textures(m)
    ii = tx.own_image(mats[0])
    a = tx.get(ii).copy()
    H, W = a.shape[:2]
    q = a[:H // 2, :W // 2]                              # the teeth strip (anime_creator.face.teeth_verts: u, v < 0.5)
    lum = q[..., :3].mean(-1)
    white = (lum > 0.72) & ((q[..., :3].max(-1) - q[..., :3].min(-1)) < 0.2)
    rows = np.nonzero(white.any(1))[0]
    if len(rows) < 10:
        log('faceadj: no drawn teeth strip found, shark teeth skipped')
        return False
    edge = np.full(q.shape[0], -1)
    for r in rows:
        edge[r] = np.nonzero(white[r])[0].max()
    e0 = float(np.median(edge[rows]))
    cav = np.median(a[H // 2 + H // 8:H - H // 8, W // 8:W - W // 8].reshape(-1, a.shape[2]), 0)
    ink = np.array([0.22, 0.08, 0.1])
    y0, y1 = rows.min(), rows.max()
    per = (y1 - y0 + 1) / n_teeth
    amp = 0.55 * e0
    for r in rows:
        fr = ((r - y0) / per) % 1.0
        tri = 1 - abs(2 * fr - 1)                        # 1 at the tooth tip, 0 in the notch between two teeth
        new_e = int(e0 - amp * (1 - tri))
        if edge[r] > new_e:
            q[r, new_e + 1:edge[r] + 1, :3] = cav[:3]
        lo = max(0, new_e - 2)
        q[r, lo:new_e + 1, :3] = q[r, lo:new_e + 1, :3] * 0.3 + ink * 0.7
    a[:H // 2, :W // 2] = q
    tx.put(ii, a)
    tx.flush()
    # a GRIN shows its teeth: the teeth planes (still flat, drawn) made taller / wider and brought just behind the
    # lips, so an open mouth shows the pointed rows like the drawing (the hand-built Nux: teeth x1.35-1.45)
    try:
        from anime_creator import face as acf
        mi = next(i for i, p in enumerate(d.prims) if 'FaceMouth' in m.mat_name(p['material']))
        tv = acf.teeth_verts(m, d, mi)
        if len(tv) > 4:
            P = d.P.copy()
            c = P[tv].mean(0)
            P[tv, 0] = c[0] + (P[tv, 0] - c[0]) * 1.3
            P[tv, 1] = c[1] + (P[tv, 1] - c[1]) * 1.45
            P[tv, 2] -= 0.0012                                # (VRM0 faces -Z: toward the lips)
            d.P = P
            m.write_mesh(fi, d)
    except Exception as e:
        log(f'faceadj: teeth planes left as they were ({type(e).__name__}: {e})')
    m.save(vrm_out)
    log(f'faceadj: shark teeth -- the drawn teeth strip re-edged into {n_teeth} points per row (flat, drawn)')
    return True


def signature_rest(vrm_in, vrm_out, k=0.6, log=print):
    """OPTIONAL (converter --signature-rest, default off): the character's signature expression from a reference
    drawing -- a toothy grin -- as the REST face: part of the smile + a small jaw opening + the upper lip raised baked
    into the rest shape (the flat drawn teeth show), each morph shortened by the same share so tracking still reaches
    the full shapes. -> True if baked."""
    m = Model(vrm_in)
    fi = m.mesh_index('Face')
    d = m.read_mesh(fi)
    names = [n.split('.')[-1] for n in d.target_names]
    want = {'mouthSmileLeft': k, 'mouthSmileRight': k, 'jawOpen': 0.22 * k, 'mouthUpperUpLeft': 0.5 * k,
            'mouthUpperUpRight': 0.5 * k, 'mouthStretchLeft': 0.3 * k, 'mouthStretchRight': 0.3 * k}
    done = []
    for i, n in enumerate(names):
        if n in want:
            kk = want[n]
            d.P = d.P + kk * np.asarray(d.targets[i]['POSITION'])
            d.targets[i]['POSITION'] = np.asarray(d.targets[i]['POSITION']) * (1 - kk)
            done.append(n)
    if not done:
        return False
    m.write_mesh(fi, d)
    m.save(vrm_out)
    log(f'faceadj: signature expression baked as the rest face ({", ".join(done)}; k {k:.2f})')
    return True


def skin_shading(vrm_in, vrm_out, shift=-0.5, log=print):
    """anime skin in the app's toon path: the terminator pushed round the form (material extras vtpShadeShift, read
    by src/avatar/toon.ts) on EVERY skin material (face, body, ears: one value, so no step at the neck or down the
    cheek -- the lit / shadow terminator crossing the face read as a 'colour step down the face' in review)"""
    m = Model(vrm_in)
    n = 0
    for mt in m.J['materials']:
        if 'SKIN' in mt.get('name', '').upper():
            mt.setdefault('extras', {})['vtpShadeShift'] = float(shift)
            n += 1
    if not n:
        return False
    m.save(vrm_out)
    log(f'faceadj: anime skin terminator shift {shift:+.2f} on {n} skin materials')
    return True


def shrink_ears(vrm_in, vrm_out, k=0.62, log=print):
    """anime drawings keep the ears small and tucked under the hair; the VRoid bases' ears stick out (and shade
    orange in profile). The ear primitive (the small lateral SKIN primitive of the Face mesh) is pulled toward the
    head: its sideways reach from where it attaches scaled by k, its size around its own centre by (1 + k) / 2."""
    m = Model(vrm_in)
    fi = m.mesh_index('Face')
    d = m.read_mesh(fi)
    skin = [i for i, p in enumerate(d.prims) if 'SKIN' in m.mat_name(p['material'])]
    if len(skin) < 2:
        return False
    cand = []
    for i in skin:
        V = d.verts_of(i)
        cand.append((float(np.abs(d.P[V, 0]).mean()), i, V))
    lat, pi, V = max(cand)
    if lat < 0.06 or len(V) > 0.5 * len(d.verts_of(skin)):
        return False
    P = d.P.copy()
    for sgn in (-1, 1):
        sv = V[np.sign(P[V, 0]) == sgn]
        if not len(sv):
            continue
        ax = np.abs(P[sv, 0])
        r0 = float(np.percentile(ax, 5))
        c = P[sv].mean(0)
        q = P[sv].copy()
        q[:, 0] = sgn * (r0 + (ax - r0) * k)
        s2 = (1 + k) / 2
        q[:, 1] = c[1] + (q[:, 1] - c[1]) * s2
        q[:, 2] = c[2] + (q[:, 2] - c[2]) * s2
        P[sv] = q
    d.P = P
    m.write_mesh(fi, d)
    m.save(vrm_out)
    log(f'faceadj: ears pulled in / shrunk (k {k}, {len(V)} verts)')
    return True


def _mouth_line(img, alpha, skin, min_w=0.12):
    """the widest line component in a mouth crop (line = far from the skin colour): -> (W_px, xs, ys) or None"""
    from scipy import ndimage as ndi
    line = (np.linalg.norm(img[..., :3] - skin, axis=-1) > 0.18) & (alpha > 0.5)
    lab, n = ndi.label(line)
    best = None
    for i in range(1, n + 1):
        ys, xs = np.nonzero(lab == i)
        W = xs.max() - xs.min() + 1; H = ys.max() - ys.min() + 1
        if W < min_w * line.shape[1] or H > 0.6 * W or ys.min() == 0 or ys.max() == line.shape[0] - 1:
            continue                                   # not a mouth line (nose dot, chin / collar outline)
        if best is None or W > best[0]:
            best = (W, xs, ys)
    return best


def mouth_shape(A):
    """the drawn neutral mouth line: {'sag': (centre - corners) / width (+ = corners up, a smile), 'left' / 'right':
    each corner's rise over the line's middle / width (character's left / right: a smirk lifts one)} or None.
    Live2D: the front picture's mouth crop; image route: the drawing itself, searched in the lower face."""
    lm = A.lm
    if 'mouth' not in lm:
        return None
    ipd = A.ipd
    if getattr(A, 'model', None) is not None:
        from .render import render_pose, View
        mb = lm['mouth']['bbox']
        cx, cy = (mb[0] + mb[2]) / 2, (mb[1] + mb[3]) / 2
        view = View(A.model.moc.canvas, 300, (cx - 0.7 * ipd, cy - 0.35 * ipd, cx + 0.7 * ipd, cy + 0.35 * ipd))
        img, _ = render_pose(A.model, A.pose, view=view, ss=1)
        rgb, al = img[..., :3], img[..., 3]
        skin = np.asarray(A.skin_rgb, float)
        flip = False
    else:
        im = getattr(A, 'image', None)
        if im is None:
            return None
        ex, ey = lm['chin'][0], lm['eye_y']
        chin = lm['face_bbox'][3]
        y0, y1 = int(ey + 0.45 * ipd), int(max(ey + 0.8 * ipd, chin - 0.05 * ipd))
        x0, x1 = int(ex - 0.8 * ipd), int(ex + 0.8 * ipd)
        H, W = im.shape[:2]
        y0, y1, x0, x1 = max(0, y0), min(H, y1), max(0, x0), min(W, x1)
        if y1 - y0 < 5 or x1 - x0 < 5:
            return None
        rgb = im[y0:y1, x0:x1, :3]
        fm = getattr(A, 'face_mask', None)
        al = fm[y0:y1, x0:x1].astype(float) if fm is not None else np.ones(rgb.shape[:2])
        from scipy import ndimage as ndi
        al = ndi.binary_fill_holes(ndi.binary_closing(al > 0.5, iterations=4)).astype(float)
        skin = np.asarray(A.skin_rgb, float) if getattr(A, 'skin_rgb', None) is not None else np.median(rgb.reshape(-1, 3), 0)
        flip = True
    best = _mouth_line(rgb, al, skin)
    if best is None:
        return None
    W, xs, ys = best
    x0_, x1_ = xs.min(), xs.max()
    u = (xs - x0_) / max(x1_ - x0_, 1)
    cen = ys[np.abs(u - 0.5) < 0.1].mean()
    lo_c, hi_c = ys[u < 0.1].mean(), ys[u > 0.9].mean()             # picture's left / right corner rows
    # the picture's left is the character's RIGHT
    right, left = (cen - lo_c) / W, (cen - hi_c) / W
    # the drawn line itself: its width / stroke thickness in IPD, its ink colour (for the painted mouth line)
    px_per_ipd = (rgb.shape[1] / 1.4) if getattr(A, 'model', None) is not None else 1.0
    if getattr(A, 'model', None) is None:
        px_per_ipd = A.ipd
    cols = np.unique(xs)
    thick = float(np.median([np.sum(xs == c_) for c_ in cols])) if len(cols) else 2.0
    lp = rgb[ys, xs][:, :3]
    ll = lp.mean(1)
    col = np.median(lp[ll <= np.percentile(ll, 40)], 0)             # the ink core, not its anti-aliased edge
    return {'sag': float((cen - (lo_c + hi_c) / 2) / W), 'left': float(left), 'right': float(right),
            'width_ipd': float(W / px_per_ipd), 'thick_ipd': float(thick / px_per_ipd),
            'color': '#%02x%02x%02x' % tuple(int(np.clip(v, 0, 1) * 255) for v in col)}


def mouth_sag(A):
    """the drawn neutral mouth line's curve: (centre - corners) / width, + = corners up (a smile); None if no line"""
    ms = mouth_shape(A)
    return None if ms is None else ms['sag']


def rest_smile(vrm_in, vrm_out, k, log=print, k_left=None, k_right=None):
    """a drawn neutral that smiles (Haru): bake k of the mouth-smile morphs into the rest shape, shorten them by the
    same share (a full tracked smile still lands where it did). The carved mouth / flat drawn teeth are untouched."""
    kl = k if k_left is None else k_left
    kr = k if k_right is None else k_right
    if max(kl, kr) <= 0.02:
        return False
    m = Model(vrm_in)
    fi = m.mesh_index('Face')
    d = m.read_mesh(fi)
    names = [n.split('.')[-1] for n in d.target_names]
    idx = {n: i for i, n in enumerate(names) if n in ('mouthSmileLeft', 'mouthSmileRight')}
    if len(idx) != 2:
        return False
    for n, i in idx.items():
        kk = kl if n == 'mouthSmileLeft' else kr         # a smirk: one corner (ARKit sides = the character's)
        d.P = d.P + kk * d.targets[i]['POSITION']
        d.targets[i]['POSITION'] = d.targets[i]['POSITION'] * (1 - kk)
    m.write_mesh(fi, d)
    m.save(vrm_out)
    log(f'faceadj: drawn neutral mouth baked into the rest shape -- smile left {kl:.2f}, right {kr:.2f}')
    return True
