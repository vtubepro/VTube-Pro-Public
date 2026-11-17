"""Fit face_kit's parametric anime eye (anime_eyes presets) to the model's own drawn eyes.

The drawn eye is rendered per part (white / iris / highlight / lash layers of one side, clipping masks applied) in a
close crop, measured, and turned into an `anime_eyes` design: the preset (female / male, blended by how sure the sex
guess is) with its knobs overridden by what was measured:

  opening   height / tilt / upper-lid peak, rise and roundness, lower-lid depth   (eye-white silhouette)
  iris      width, aspect, horizontal position, share tucked under the upper lid  (unclipped iris mesh vs white)
  colours   top / mid / bottom gradient, ring, pupil                              (analyze._iris_colors)
  highlights positions / sizes of the drawn catch-lights                          (highlight layers, iris units)
  lash      thickness profile, wing past the outer corner and its drop, spikes    (lash layers above the white)

`vface_params(design, base_ratio)` then maps the design onto the VRoid face painter (face_kit.vroid_face) and the
creator's face warp (eyeTilt / eyeSize), and `opening` feeds faceadj.narrow_eyes. Numpy + cv2 (no bpy).
"""
import numpy as np

from face_kit import anime_eyes as AE
from .render import render_pose, View

LAYERS = ('eye_white', 'iris', 'eye_hl', 'lash')


def _masks(A, sd, px=420):
    """alpha images of one eye's layers in a crop around it + the crop view"""
    m, cls, side = A.model, A.cls, A.side
    e = A.lm.get('eye_' + sd)
    if e is None:
        return None, None
    x0, y0, x1, y1 = e.get('lash_bbox') or e['bbox']
    bx0, by0, bx1, by1 = e['bbox']
    x0, y0, x1, y1 = min(x0, bx0), min(y0, by0), max(x1, bx1), max(y1, by1)
    w = x1 - x0
    crop = (x0 - 0.35 * w, y0 - 0.45 * w, x1 + 0.35 * w, y1 + 0.35 * w)
    view = View(m.moc.canvas, px, crop)
    out = {}
    for c in LAYERS:
        sel = {a for a in range(len(cls)) if cls[a] == c and side[a] == sd}
        if not sel:
            out[c] = np.zeros((view.H, view.W), np.float32)
            continue
        img, _ = render_pose(m, A.pose, view=view, ss=1, only=sel)
        out[c] = img[..., 3]
        out[c + '_rgb'] = img[..., :3]
    # the unclipped iris: the biggest iris mesh without its clipping mask
    ir = [a for a in range(len(cls)) if cls[a] == 'iris' and side[a] == sd]
    if ir:
        from .render import drawable_layer
        big = max(ir, key=lambda a: A.area[a])
        out['iris_full'] = drawable_layer(m, A.pose, big, view, 1, opacity=False)[..., 3]
    return out, view


def _blobs(mask, min_px=6):
    import cv2
    n, lab, st, cen = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    return [(st[i], cen[i]) for i in range(1, n) if st[i][4] >= min_px]


def measure(A, sd, log=print):
    """one drawn eye -> measurements in anime_eyes units (eye widths, u from the inner corner)"""
    L, view = _masks(A, sd)
    if L is None:
        return None
    white = L['eye_white'] > 0.5
    if white.sum() < 50:
        return None
    ys, xs = np.nonzero(white)
    face_cx = A.mid_x if getattr(A, 'mid_x', None) is not None else 0.0
    cxp = view.px([[face_cx, 0]])[0, 0]
    # corners: extreme columns of the white; inner = toward the face centre line
    xa, xb = xs.min(), xs.max()
    inner_x, outer_x = (xb, xa) if abs(xb - cxp) < abs(xa - cxp) else (xa, xb)
    sgn = 1.0 if outer_x > inner_x else -1.0
    W = float(abs(outer_x - inner_x))

    def col_y(x, k=2):
        c = white[:, max(int(x) - k, 0):int(x) + k + 1]
        yy = np.nonzero(c.any(1))[0]
        return float(yy.mean()) if len(yy) else float(ys.mean())
    yi, yo = col_y(inner_x), col_y(outer_x)
    tilt = (yi - yo) / W                                            # + = outer corner higher (y is down)
    us = np.linspace(0.04, 0.96, 24)
    top, bot = [], []
    for u in us:
        x = int(round(inner_x + sgn * u * W))
        c = np.nonzero(white[:, x])[0]
        top.append(c.min() if len(c) else np.nan); bot.append(c.max() if len(c) else np.nan)
    top, bot = np.array(top, float), np.array(bot, float)
    line = yi + (yo - yi) * us                                      # corner line (y down)
    rise = line - top                                               # upper lid above the corner line (px)
    drop = bot - line
    hgt = np.nanmax(bot - top)
    ok = ~np.isnan(rise)
    j = int(np.nanargmax(rise))
    upper_peak = float(us[j])
    upper_rise = float(np.nanmax(rise) / max(hgt, 1))
    # roundness: share of the lid within 12 % of its peak height (flat top = male)
    flat = np.mean(rise[ok] > np.nanmax(rise) * 0.88)
    upper_round = float(np.clip(1.25 - flat * 2.2, 0.0, 1.0))
    lower_round = float(np.clip((np.nanmax(drop) - np.nanmean(drop[ok][[0, -1]])) / max(np.nanmax(drop), 1) * 1.4, 0, 1))
    # the drawn lid LINES themselves (the authored eye shape, not only its summary knobs): rise of the upper lid /
    # drop of the lower lid over the inner->outer corner line, in eye widths, at 24 columns u (inner corner = 0)
    def _fill(v):
        v = np.asarray(v, float); ok_ = ~np.isnan(v)
        return np.interp(np.arange(len(v)), np.nonzero(ok_)[0], v[ok_]) if ok_.sum() >= 2 else np.zeros_like(v)
    curves = {'u': us.round(3).tolist(), 'upper': (_fill(rise) / W).round(4).tolist(),
              'lower': (_fill(drop) / W).round(4).tolist()}
    M = {'side': sd, 'W_px': W, 'height': float(hgt / W), 'tilt': float(tilt), 'upper_peak': upper_peak, 'curves': curves,
         'upper_rise': float(np.clip(upper_rise, 0.4, 0.85)), 'upper_round': upper_round, 'lower_round': lower_round}
    # iris (unclipped) against the white
    irf = L.get('iris_full')
    if irf is not None and (irf > 0.5).sum() > 30:
        iy, ix = np.nonzero(irf > 0.5)
        iw, ih = ix.max() - ix.min() + 1, iy.max() - iy.min() + 1
        icx = (ix.max() + ix.min()) / 2
        iu = (icx - inner_x) * sgn / W
        top_at = np.interp(iu, us[ok], top[ok])
        bot_at = np.interp(iu, us[ok], bot[ok])
        M['iris'] = {'width': float(iw / W), 'aspect': float(ih / iw), 'u': float(iu),
                     'tuck': float(np.clip((top_at - iy.min()) / ih, 0.0, 0.45)),
                     'lower_tuck': float(np.clip((iy.max() - bot_at) / ih, 0.0, 0.3))}
        # iris gradient + pupil from the clipped iris render (highlights and the pupil excluded from the gradient)
        rgb = L['iris_rgb']; vis = L['iris'] > 0.5
        lum = rgb @ np.array([0.3, 0.59, 0.11])
        mx_, mn_ = rgb.max(-1), rgb.min(-1)
        body = vis & ~((mx_ > 0.88) & (mx_ - mn_ < 0.18))
        if body.sum() > 40:
            med = np.median(lum[body])
            dark = body & (lum < med * 0.55)
            t_ = (np.arange(rgb.shape[0])[:, None] - iy.min()) / max(ih, 1) * np.ones((1, rgb.shape[1]))
            g = {}
            for key, lo, hi in (('top', 0.1, 0.38), ('mid', 0.4, 0.62), ('bottom', 0.66, 0.92)):
                sel = body & ~dark & (t_ >= lo) & (t_ < hi)
                if sel.sum() > 10:
                    g[key] = '#%02x%02x%02x' % tuple((np.median(rgb[sel], 0) * 255).astype(int))
            M['iris']['colors'] = g
            # pupil: the dark blob nearest the iris centre
            bl = [(st, c) for st, c in _blobs(dark, 3) if st[2] < 0.45 * iw and st[3] < 0.6 * ih]
            if bl:
                st, c = min(bl, key=lambda b: np.hypot(b[1][0] - icx, b[1][1] - (iy.min() + iy.max()) / 2))
                if np.hypot(c[0] - icx, c[1] - (iy.min() + iy.max()) / 2) < 0.35 * iw:
                    M['iris']['pupil_w'] = float(np.clip(st[2] / iw, 0.06, 0.6))
                    M['iris']['pupil_aspect'] = float(np.clip(st[3] / max(st[2], 1), 0.8, 3.0))
        # highlights: blobs of the highlight layers (plus near-white blobs painted into the iris itself)
        hl = L['eye_hl'] > 0.5
        hls = []
        R = iw / 2.0; icy = (iy.max() + iy.min()) / 2
        if hl.sum() < 6:
            # no highlight layer: catch-lights painted into the iris texture (near-white, unsaturated)
            rgb = L['iris_rgb']; mx = rgb.max(-1); mn = rgb.min(-1)
            hl = (L['iris'] > 0.5) & (mx > 0.88) & (mx - mn < 0.18)
        for st, c in sorted(_blobs(hl, 3), key=lambda b: -b[0][4])[:4]:
            hls.append({'kind': 'disc', 'u': float((c[0] - icx) * sgn / R), 'v': float((icy - c[1]) / R),
                        'w': float(st[2] / R / 2), 'h': float(st[3] / R / 2), 'color': '#ffffff'})
        # u in iris half-widths toward the OUTER corner (anime_eyes convention: light from the upper left on the
        # viewer's left eye); keep the sign relative to the outer corner so mirroring works
        M['highlights'] = hls
    # lash: thickness above the white along u, wing past the outer corner
    lash = L['lash'] > 0.5
    if lash.sum() > 30:
        th = []
        for k, u in enumerate(us):
            x = int(round(inner_x + sgn * u * W))
            c = np.nonzero(lash[:, x])[0]
            if np.isnan(top[k]) or not len(c):
                th.append(0.0); continue
            # the run of lash pixels sitting ON the lid (crease / double-lid lines higher up are not the lash)
            y = int(top[k]) + 2; n_ = 0; gap = 0
            while y > 0 and gap <= 2:
                if lash[y, x]:
                    n_ += 1 + gap; gap = 0
                elif n_:
                    gap += 1
                elif y < top[k] - 0.06 * W:
                    break
                y -= 1
            th.append(n_ / W)
        th = np.array(th)
        mid = (us > 0.25) & (us < 0.9)
        M['lash'] = {'max': float(np.clip(np.percentile(th[mid], 80), 0.015, 0.25)),
                     'max_at': float(us[mid][int(np.argmax(th[mid]))]),
                     'inner': float(np.clip(np.mean(th[:4]), 0.01, 0.1))}
        # lash colours: the dark ink and (if any) a warm liner (Ren's maroon outer line)
        rgb = L['lash_rgb'][lash]
        lum = rgb @ np.array([0.3, 0.59, 0.11])
        M['lash']['color'] = '#%02x%02x%02x' % tuple((np.median(rgb[lum <= np.percentile(lum, 25)], 0) * 255).astype(int))
        sat = rgb.max(1) - rgb.min(1)
        warm = (sat > 0.18) & (rgb[:, 0] > rgb[:, 2] + 0.08)
        if warm.mean() > 0.12:
            M['lash']['warm'] = '#%02x%02x%02x' % tuple((np.median(rgb[warm], 0) * 255).astype(int))
        ly, lx = np.nonzero(lash)
        lu = (lx - inner_x) * sgn / W
        past = lu > 1.0
        # wing: lash columns continuing the band past the outer corner (stray lower-lash / lid marks don't count)
        wing, miss, lowest = 0.0, 0, yo
        for u in np.arange(1.0, 1.4, 0.01):
            x = int(round(inner_x + sgn * u * W))
            if x < 0 or x >= lash.shape[1]:
                break
            c = np.nonzero(lash[max(int(yo - 0.22 * W), 0):int(yo + 0.12 * W), x])[0]
            if len(c):
                wing = u - 1.0; miss = 0; lowest = max(lowest, c.max() + max(int(yo - 0.22 * W), 0))
            else:
                miss += 1
                if miss > 2:
                    break
        M['lash']['wing'] = float(np.clip(wing, 0.0, 0.3))
        M['lash']['wing_drop'] = float(np.clip((lowest - yo) / W, -0.1, 0.4))
        # spikes: separate lash blobs above the main band
        M['lash']['spikes'] = max(0, len(_blobs(lash, 12)) - 1)
    log(f"eyefit {sd}: h/w {M['height']:.2f} tilt {M['tilt']:+.3f} peak {M['upper_peak']:.2f} round {M['upper_round']:.2f}"
        + (f" iris w {M['iris']['width']:.2f} asp {M['iris']['aspect']:.2f} tuck {M['iris']['tuck']:.2f}"
           f" hl {len(M.get('highlights', []))}" if 'iris' in M else '')
        + (f" lash max {M['lash']['max']:.3f} wing {M['lash']['wing']:.2f}" if 'lash' in M else ''))
    return M


def _avg(ms, path):
    vals = []
    for m in ms:
        v = m
        for k in path:
            v = v.get(k) if isinstance(v, dict) else None
            if v is None:
                break
        if isinstance(v, (int, float)):
            vals.append(float(v))
    return float(np.mean(vals)) if vals else None


def fit(A, sex, sex_score, colors, log=print):
    """-> (anime_eyes preset dict fitted to the drawing, averaged measurements)"""
    ms = [m for m in (measure(A, 'L', log), measure(A, 'R', log)) if m]
    # preset: pure female / male when the guess is clear, blended toward the other when it is borderline
    t = float(np.clip(0.5 + 0.5 * np.tanh(sex_score), 0, 1)) if sex == 'auto' else (1.0 if sex == 'male' else 0.0)
    if sex == 'male':
        t = max(t, 0.75)
    elif sex == 'female':
        t = min(t, 0.25)
    p = AE.blend(AE.preset('female'), AE.preset('male'), t)
    if not ms:
        return p, {}
    avg = {}
    for path in (('height',), ('tilt',), ('upper_peak',), ('upper_rise',), ('upper_round',), ('lower_round',)):
        avg[path[0]] = _avg(ms, path)
    o = p['opening']
    for k in ('height', 'tilt', 'upper_peak', 'upper_rise', 'upper_round', 'lower_round'):
        if avg.get(k) is not None:
            o[k] = round(avg[k], 3)
    I = p['iris']
    for k in ('width', 'aspect', 'u', 'tuck', 'lower_tuck'):
        v = _avg(ms, ('iris', k))
        if v is not None:
            I[k] = round(v, 3)
            avg['iris_' + k] = v
    iris = colors.get('iris_L') or colors.get('iris_R') or {}
    g = next((m['iris'].get('colors') for m in ms if m.get('iris') and m['iris'].get('colors')), None) or {}
    for k in ('top', 'mid', 'bottom'):
        if g.get(k) or iris.get(k):
            I[k] = g.get(k) or iris[k]
    pw = _avg(ms, ('iris', 'pupil_w'))
    if pw is not None:
        p['pupil']['width'] = round(pw, 3)
        p['pupil']['aspect'] = round(_avg(ms, ('iris', 'pupil_aspect')) or 1.2, 3)
        avg['pupil_w'] = pw
    if iris.get('dark'):
        I['ring'] = iris['dark']
    if iris.get('light'):
        I['crescent'] = iris['light']
    hl = next((m.get('highlights') for m in ms if m.get('highlights')), None)
    if hl:
        p['highlights'] = hl
        avg['highlights'] = hl
    Lh = p['lash']
    for k in ('max', 'max_at', 'inner', 'wing', 'wing_drop'):
        v = _avg(ms, ('lash', k))
        if v is not None:
            Lh[k] = round(v, 3)
            avg['lash_' + k] = v
    sp = _avg(ms, ('lash', 'spikes'))
    if sp is not None:
        Lh['spikes_outer'] = int(min(3, round(sp)))
        avg['lash_spikes'] = sp
    lc = next((m['lash'].get('color') for m in ms if m.get('lash')), None) or colors.get('lash')
    if lc:
        Lh['color'] = lc
    wc = next((m['lash'].get('warm') for m in ms if m.get('lash') and m['lash'].get('warm')), None)
    if wc:
        Lh['edge'] = wc
        avg['lash_warm'] = wc
    cv = [m['curves'] for m in ms if m.get('curves')]
    if cv:
        avg['curves'] = {'u': cv[0]['u'], 'upper': np.mean([c['upper'] for c in cv], 0).round(4).tolist(),
                         'lower': np.mean([c['lower'] for c in cv], 0).round(4).tolist()}
        if avg.get('iris_tuck') is not None:
            avg['curves']['tuck'] = round(float(avg['iris_tuck']), 3)
            avg['curves']['iris_u'] = round(float(avg.get('iris_u', 0.5)), 3)
        if avg.get('iris_lower_tuck') is not None:
            avg['curves']['lower_tuck'] = round(float(avg['iris_lower_tuck']), 3)
    avg['preset_t'] = t
    return p, avg


def vface_params(p, base_iris_ratio=None, base_aspect=None):
    """anime_eyes design -> (face_kit VFace overrides, creator face overrides).
    base_iris_ratio: the VRoid base's iris width / eye width (so the painted iris lands at the drawn size)."""
    o, I, L, P = p['opening'], p['iris'], p['lash'], p['pupil']
    asp = base_aspect or o['height']
    face = {
        'iris': {'color': I['mid'], 'top': I['top'], 'bottom': I['bottom'], 'ring': I['ring'],
                 'pupil': round(float(P['width']), 3), 'topBand': round(float(I.get('top_band', 0.3)), 3)},
        # VFace line widths are in HALF eye heights; anime_eyes lash widths are in eye widths
        # (x1.6: the drawn lash sits partly OUTSIDE the eye white the width was measured against, and the VRoid
        # lid geometry hides the inner part of the painted line -- the fresh-eye review saw 'thin lids' at x1)
        'eye': {'lineMax': round(float(np.clip(L['max'] * 3.2 / max(asp, 0.3), 0.12, 0.8)), 3),
                'lineIn': round(float(np.clip(L['inner'] * 2.0 / max(asp, 0.3), 0.03, 0.2)), 3),
                'wing': round(float(np.clip(L['wing'] * 2.0, 0.0, 0.5)), 3),
                'wingDrop': round(float(np.clip(L.get('wing_drop', 0.1) - 0.1, -0.2, 0.3)), 3),
                'spikes': int(L.get('spikes_outer', 0)), 'line': L['color'], 'line2': L.get('edge', L['color'])},
    }
    if I.get('crescent') and I.get('crescent_alpha', 0) > 0:
        face['iris']['glow'] = I['crescent']
    hls = p.get('highlights') or []
    if hls:
        # VFace: main = [x, y, w, h] in iris radii (x toward the light), dot = [x, y, r]
        h0 = hls[0]
        face['hl'] = {'main': [round(abs(h0['u']), 3), round(h0['v'], 3), round(max(h0['w'], 0.08), 3),
                               round(max(h0['h'], 0.08), 3)]}
        if len(hls) > 1:
            h1 = hls[1]
            face['hl']['dot'] = [round(-abs(h1['u']), 3), round(h1['v'], 3), round(max(h1['w'], h1['h'], 0.05), 3)]
        else:
            face['hl']['dot'] = [0.0, 0.0, 0.0]
        face['hl']['sparkles'] = max(0, len(hls) - 2)
    creator = {'eyeTilt': round(float(np.clip(np.degrees(np.arctan(o['tilt'])), -12, 12)), 2)}
    if base_iris_ratio:
        face['iris']['scale'] = round(float(np.clip(I['width'] / base_iris_ratio, 0.8, 1.35)), 3)
        face['iris']['scaleY'] = round(float(np.clip(I['aspect'] / 1.15, 0.85, 1.2)), 3)
    return face, creator
