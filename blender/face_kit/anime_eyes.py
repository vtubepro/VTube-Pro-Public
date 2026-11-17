"""Parametric anime eyes: female / male presets with every construction knob exposed (numpy only; cv2 optional for
the preview renderer). Research + rules: docs/FACE_CREATION.md section 2 + "Anime eyes: female vs male".

Eye space: u = 0 at the INNER corner .. 1 at the OUTER corner (one eye width), v = up (in eye widths), origin on
the straight line between the corners at its middle. A preset + overrides -> a *design* (polylines / ellipses /
colours) placed into any pixel frame by its two corner points, so the same eye drives a 2K face texture, a Live2D
layer set, a VRoid iris texture or the lid / gaze / brow rig of an AI mesh.

API (stable, used by (an internal build) and the Live2D -> 3D pipeline):
    from face_kit import anime_eyes as AE
    p = AE.preset('female', iris={'top': '#8c2d86'}, lash={'wing': 0.12})      # dict of knobs (deep-merged)
    p = AE.blend(AE.preset('female'), AE.preset('male'), 0.3)                  # in-between (androgynous / young male)
    d = AE.design(p, inner=(1106, 988), outer=(1316, 970))                      # eye in a pixel frame (y down)
    d = AE.mirror(d, axis_x=999.2)                                              # the other eye
    AE.render(canvas_rgb, d, T=None, ss=2)   # draws it (cv2): sclera, lid shadow, iris gradient, pupil, highlights,
                                              # lash band + edge + spikes, lower lash, crease, (brow)
    AE.preview(p, path)                       # one-eye sheet for review
design dict keys: upper_lid, lower_lid, lash_top, lash_bottom_outer, spikes, sclera, lid_shadow, iris, pupil,
highlights, lower_lash, crease, brow, lash_color, lash_edge_color, lash_edge_px (same schema as
(an internal build) "eye").
"""
import copy
import numpy as np

# ------------------------------------------------------------------ presets
# All lengths in eye widths (corner to corner). Colours sRGB hex.
FEMALE = {
    'opening': {
        'height': 0.78,        # opening height / width (F gacha 0.75-0.95, VTuber 0.7-0.85)
        'tilt': 0.08,          # outer corner above the inner (F raised 0.04-0.1, M 0 .. -0.03)
        'upper_peak': 0.58,    # where the upper lid is highest (u)
        'upper_round': 0.9,    # 1 = round arch, 0 = flat top with angled ends (male)
        'upper_rise': 0.62,    # upper lid height above the corner line (fraction of opening height)
        'lower_round': 1.0,    # lower lid: 1 = deep U, 0 = shallow
        'inner_drop': 0.02,    # inner corner hook (tear duct) below the corner line
    },
    'iris': {
        'width': 0.64, 'aspect': 1.22,        # F tall (1.15-1.3), M 1.0-1.1
        'u': 0.45, 'v': 0.0, 'tuck': 0.1, 'lower_tuck': 0.03, 'fit': True,    # centre u; v = extra offset; tuck = share of the iris hidden by the upper lid
        'top': '#3c2a74', 'mid': '#4e63e0', 'bottom': '#9fe6ff',
        'crescent': '#bff4ff', 'crescent_alpha': 0.55,
        'ring': '#141338', 'ring_px': 0.035,   # limbal ring (fraction of eye width)
        'top_band': 0.3,                       # lid-shadow darkening share of the iris height
    },
    'pupil': {'shape': 'ellipse', 'width': 0.42, 'aspect': 1.35, 'v': 0.02, 'color': '#1a1030', 'ring': None, 'ring_px': 0.05},
    'highlights': [                             # u/v relative to the iris (unit = iris half-width), light from upper left
        {'kind': 'disc', 'u': -0.4, 'v': 0.4, 'w': 0.36, 'h': 0.3, 'color': '#ffffff'},
        {'kind': 'disc', 'u': 0.45, 'v': -0.45, 'w': 0.14, 'h': 0.14, 'color': '#ffffff', 'alpha': 0.95},
        {'kind': 'disc', 'u': 0.2, 'v': 0.62, 'w': 0.09, 'h': 0.09, 'color': '#ffffff', 'alpha': 0.9},
    ],
    'lash': {
        'color': '#2c0d17', 'edge': '#7a2231', 'edge_px': 0.024,
        'inner': 0.035, 'max': 0.17, 'max_at': 0.72,   # thickness profile along u (eye widths)
        'wing': 0.1, 'wing_drop': 0.22,                 # extends past the outer corner, then runs down the outer side
        'spikes_outer': 2, 'spikes_inner': 2, 'spike_len': 0.12,
    },
    'sclera': {'color': '#ffffff', 'shadow': '#c9c1e6', 'shadow_h': 0.115},
    'lower_lash': {'from': 0.34, 'to': 0.66, 'px': 0.02, 'color': '#5a1a22', 'tick': True},
    'crease': {'offset': 0.07, 'from': 0.04, 'to': 0.6, 'px': 0.016, 'color': '#cf8676', 'alpha': 0.85},
    'brow': {'height': 0.62, 'from': 0.07, 'to': 0.72, 'arch': 0.1, 'tilt': 0.0, 'px': 0.022, 'color': '#5a78b8', 'alpha': 0.8},
}

MALE = copy.deepcopy(FEMALE)
MALE['opening'].update(height=0.5, tilt=-0.01, upper_peak=0.46, upper_round=0.25, upper_rise=0.7, lower_round=0.45, inner_drop=0.03)
MALE['iris'].update(width=0.52, aspect=1.06, u=0.47, v=0.0, tuck=0.2, lower_tuck=0.08, top_band=0.38)
MALE['pupil'].update(width=0.36, aspect=1.2)
MALE['highlights'] = [{'kind': 'disc', 'u': -0.38, 'v': 0.38, 'w': 0.3, 'h': 0.26, 'color': '#ffffff'},
                      {'kind': 'disc', 'u': 0.42, 'v': -0.4, 'w': 0.1, 'h': 0.1, 'color': '#ffffff', 'alpha': 0.85}]
MALE['lash'].update(inner=0.03, max=0.075, max_at=0.6, wing=0.03, wing_drop=0.1, spikes_outer=0, spikes_inner=0, edge_px=0.0)
MALE['sclera'].update(shadow_h=0.16)
MALE['lower_lash'].update(**{'from': 0.55, 'to': 0.75, 'px': 0.012, 'tick': False})
MALE['crease'].update(offset=0.05, **{'from': 0.1, 'to': 0.75}, px=0.014, alpha=0.7)
MALE['brow'].update(height=0.26, arch=0.02, tilt=-0.06, px=0.06, **{'from': 0.0, 'to': 0.9}, alpha=1.0)

PRESETS = {'female': FEMALE, 'male': MALE}


def _merge(a, b):
    out = copy.deepcopy(a)
    for k, v in (b or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict): out[k] = _merge(out[k], v)
        else: out[k] = copy.deepcopy(v)
    return out


def preset(name='female', **over):
    """a preset dict with overrides deep-merged: preset('female', iris={'mid': '#d42a3a'})"""
    return _merge(PRESETS[name], over)


def _hex(h):
    h = h.lstrip('#'); return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], float)


def blend(a, b, t):
    """numeric knobs and colours interpolated a -> b (t 0..1); lists / strings from the nearer one"""
    def go(x, y):
        if isinstance(x, dict): return {k: go(x[k], y.get(k, x[k])) if k in y else copy.deepcopy(x[k]) for k in x}
        if isinstance(x, (int, float)) and isinstance(y, (int, float)) and not isinstance(x, bool): return x + (y - x) * t
        if isinstance(x, str) and isinstance(y, str) and x.startswith('#') and y.startswith('#'):
            c = _hex(x) + (_hex(y) - _hex(x)) * t; return '#%02x%02x%02x' % tuple(int(round(v)) for v in c)
        return copy.deepcopy(x if t < 0.5 else y)
    return go(a, b)


# ------------------------------------------------------------------ geometry in eye space
def _lids(p, n=9):
    O = p['opening']; H = O['height']
    u = np.linspace(0, 1, n)
    base = O['tilt'] * u                           # the corner line
    # upper: arch between the corners; roundness blends a sine arch and a flat-top trapezoid
    pk = O['upper_peak']
    s = np.where(u < pk, u / pk, (1 - u) / (1 - pk))
    arch = np.sin(np.clip(s, 0, 1) * np.pi / 2)
    flat = np.clip(s * 2.2, 0, 1)
    up = base + H * O['upper_rise'] * (arch * O['upper_round'] + flat * (1 - O['upper_round']))
    lo_s = np.sin(np.pi * u) ** (0.8 + 0.8 * (1 - O['lower_round']))
    lo = base - H * (1 - O['upper_rise']) * lo_s
    up[0] -= O['inner_drop']; lo[0] -= O['inner_drop']
    return u, up, lo


def eye_space(p):
    """all marks in eye space (u inner->outer, v up)"""
    u, up, lo = _lids(p)
    L = p['lash']; O = p['opening']
    # lash band: thickness profile along u, wing past the outer corner, down the outer side
    th = np.interp(u, [0, L['max_at'], 1], [L['inner'], L['max'], L['max'] * 0.85])
    top = up + th
    wing_u = 1 + L['wing']; outer_v = O['tilt']
    lash_top = [(a, b) for a, b in zip(u, top)]
    lash_top += [(wing_u, outer_v + L['max'] * 0.55), (wing_u - L['wing'] * 0.15, outer_v - L['wing_drop'] * 0.55),
                 (1 + L['wing'] * 0.2, outer_v - L['wing_drop'])]
    lash_bottom_outer = [(1 + L['wing'] * 0.2, outer_v - L['wing_drop']), (1.01, outer_v - L['wing_drop'] * 0.5), (1.0, outer_v)]
    spikes = []
    for k in range(int(round(L['spikes_outer']))):
        a = 0.78 + 0.12 * k
        t0 = np.interp(a, u, top)
        spikes.append([(a, t0 - 0.01), (a + 0.05 + 0.02 * k, t0 + L['spike_len'] * (1 - 0.2 * k)), L['max'] * 0.3])
    for k in range(int(round(L['spikes_inner']))):
        a = 0.04 + 0.07 * k
        t0 = np.interp(a, u, top)
        spikes.append([(a, t0 - 0.02), (a - 0.11, t0 - 0.02 - 0.05 * k), L['max'] * 0.25])
    I = p['iris']; H = O['height']
    iw = I['width'] / 2; ih = iw * I['aspect']
    if I.get('fit', True):
        # iris height from the opening at its centre: `tuck` hidden under the upper lid, `lower_tuck` under the lower
        oc = float(np.interp(I['u'], u, up) - np.interp(I['u'], u, lo))
        ih = oc / (2 * max(1 - I.get('tuck', 0.1) - I.get('lower_tuck', 0.03), 0.3))
        iw = min(ih / I['aspect'], I['width'] / 2 * 1.15)
    # the iris hangs from the upper lid: its top `tuck` share is hidden under the lid (F ~0.1, M ~0.2; 0 = shocked)
    ic = (I['u'], float(np.interp(I['u'], u, up)) + 2 * ih * I.get('tuck', 0.1) - ih + I['v'])
    Pp = p['pupil']
    pc = (ic[0], ic[1] + Pp['v'] * ih)
    pw = iw * Pp['width']; ph = pw * Pp['aspect']
    hls = []
    for h in p['highlights']:
        hls.append(dict(h, c=(ic[0] + h['u'] * iw, ic[1] + h['v'] * iw), w=h['w'] * iw * 2, h=h['h'] * iw * 2))
    ll = p['lower_lash']; lu = np.linspace(ll['from'], ll['to'], 5)
    cr = p['crease']; cu = np.linspace(cr['from'], cr['to'], 6)
    br = p['brow']; bu = np.linspace(br['from'], br['to'], 6)
    brow_v = np.interp(bu, u, top) + br['height'] * H + br['arch'] * np.sin(np.pi * (bu - br['from']) / max(br['to'] - br['from'], 1e-6)) + br['tilt'] * (bu - 0.5) * -1
    return {
        'upper_lid': list(zip(u, up)), 'lower_lid': list(zip(u[::-1], lo[::-1])),
        'lash_top': lash_top, 'lash_bottom_outer': lash_bottom_outer, 'spikes': spikes,
        'iris_c': ic, 'iris_ab': (iw, ih), 'pupil_c': pc, 'pupil_ab': (pw, ph), 'highlights': hls,
        'lower_lash': list(zip(lu, np.interp(lu, u, lo) - 0.002)),
        'crease': list(zip(cu, np.interp(cu, u, top) + cr['offset'])),
        'brow': list(zip(bu, brow_v)),
    }


# ------------------------------------------------------------------ placement into a pixel frame
def design(p, inner, outer):
    """place the eye by its two corners in a pixel frame (y down). Returns the design dict (pixels)."""
    E = eye_space(p)
    a, b = np.array(inner, float), np.array(outer, float)
    ax = b - a; w = np.linalg.norm(ax); ex = ax / w; ey = np.array([ex[1], -ex[0]])     # ey = screen "up"
    # the corner line in eye space is tilted by opening.tilt: remove it (the corners are given)
    tilt = p['opening']['tilt']
    def T(uv):
        uv = np.atleast_2d(np.asarray(uv, float))
        uu, vv = uv[:, 0], uv[:, 1] - tilt * uv[:, 0]
        return (a + np.outer(uu * w, ex) + np.outer(vv * w, ey)).tolist()
    def pts(lst): return [list(map(float, q)) for q in T(lst)]
    s = w
    I, Pp, L = p['iris'], p['pupil'], p['lash']
    ic = T([E['iris_c']])[0]; pc = T([E['pupil_c']])[0]
    d = {
        'upper_lid': pts(E['upper_lid']), 'lower_lid': pts(E['lower_lid']), 'lash_top': pts(E['lash_top']),
        'lash_bottom_outer': pts(E['lash_bottom_outer']),
        'spikes': [[T([s0])[0], T([s1])[0], float(wd * s)] for s0, s1, wd in E['spikes']],
        'lash_color': L['color'], 'lash_edge_color': L['edge'], 'lash_edge_px': float(L['edge_px'] * s),
        'sclera': p['sclera']['color'], 'lid_shadow': {'color': p['sclera']['shadow'], 'px': float(p['sclera']['shadow_h'] * s)},
        'iris': {'c': ic, 'a': float(E['iris_ab'][0] * s), 'b': float(E['iris_ab'][1] * s), 'ring': I['ring'], 'ring_px': float(I['ring_px'] * s),
                 'top': I['top'], 'mid': I['mid'], 'bottom': I['bottom'], 'crescent': I['crescent'], 'crescent_alpha': I['crescent_alpha'],
                 'top_band': I.get('top_band', 0.3)},
        'pupil': {'c': pc, 'a': float(E['pupil_ab'][0] * s), 'b': float(E['pupil_ab'][1] * s), 'ring': Pp.get('ring') or Pp['color'],
                  'ring_px': float((Pp['ring_px'] * s) if Pp.get('ring') else E['pupil_ab'][0] * s), 'fill': Pp.get('fill', Pp['color'])},
        'highlights': [dict({k: v for k, v in h.items() if k not in ('u', 'v')}, c=T([h['c']])[0], w=float(h['w'] * s), h=float(h['h'] * s),
                            r=float(h['w'] * s / 2)) for h in E['highlights']],
        'lower_lash': [{'pts': pts(E['lower_lash']), 'px': float(p['lower_lash']['px'] * s), 'color': p['lower_lash']['color']}],
        'crease': {'pts': pts(E['crease']), 'px': float(p['crease']['px'] * s), 'color': p['crease']['color'], 'alpha': p['crease']['alpha']},
        'brow': {'pts': pts(E['brow']), 'px': float(p['brow']['px'] * s), 'color': p['brow']['color'], 'alpha': p['brow']['alpha']},
    }
    return d


def mirror(d, axis_x):
    """the other eye: mirror a design about a vertical line x = axis_x"""
    def m(v):
        if isinstance(v, dict): return {k: (m(x) if k not in ('a', 'b', 'w', 'h', 'r', 'px', 'ring_px', 'alpha') else x) for k, x in v.items()}
        if isinstance(v, list) and len(v) == 2 and all(isinstance(x, (int, float)) for x in v): return [2 * axis_x - v[0], v[1]]
        if isinstance(v, list): return [m(x) for x in v]
        return v
    return m(d)


# ------------------------------------------------------------------ preview (cv2)
def preview(p, path, size=(640, 520)):
    """render one eye on skin at a generous size: quick look / regression sheet for a preset"""
    import cv2
    W, H = size
    d = design(p, inner=(W * 0.2, H * 0.55), outer=(W * 0.8, H * 0.55 - p['opening']['tilt'] * W * 0.6))
    img = np.ones((H * 2, W * 2, 3), np.float32) * (_hex('#fdeee6') / 255)
    render(img, d, ss=2)
    cv2.imwrite(path, (cv2.resize(img, (W, H), interpolation=cv2.INTER_AREA)[..., ::-1] * 255).astype(np.uint8))


def render(img, d, ss=2, T=None, brow=True):
    """draw a design into img (float RGB 0..1, already ss-times the design frame unless T maps it)"""
    import cv2
    T = T or (lambda P: np.asarray(P, float) * ss)
    k = np.linalg.norm(T([[100.0, 0.0]])[0] - T([[0.0, 0.0]])[0]) / 100
    H_, W_ = img.shape[:2]
    def poly_mask(P, closed=True):
        m = np.zeros((H_, W_), np.uint8)
        cv2.fillPoly(m, [np.round(np.asarray(T(_catmull(P, closed)), float) * 16).astype(np.int32)], 255, cv2.LINE_AA, 4)
        return m.astype(np.float32) / 255
    def ell(c, a, b):
        m = np.zeros((H_, W_), np.uint8); cc = T([c])[0]
        cv2.ellipse(m, (int(cc[0] * 16), int(cc[1] * 16)), (max(1, int(a * k * 16)), max(1, int(b * k * 16))), 0, 0, 360, 255, -1, cv2.LINE_AA, 4)
        return m.astype(np.float32) / 255
    def stroke(P, w, taper=0.35):
        Q = np.asarray(T(_catmull(P, False) if len(P) > 2 else np.linspace(P[0], P[-1], 12)), float)
        dd = np.gradient(Q, axis=0); dd /= np.maximum(np.linalg.norm(dd, axis=1, keepdims=True), 1e-9)
        nn = np.stack([-dd[:, 1], dd[:, 0]], 1); s = np.linspace(0, 1, len(Q))
        ww = w * k * 0.5 * (taper + (1 - taper) * np.sin(np.pi * s) ** 0.6)
        m = np.zeros((H_, W_), np.uint8)
        cv2.fillPoly(m, [np.round(np.vstack([Q + nn * ww[:, None], (Q - nn * ww[:, None])[::-1]]) * 16).astype(np.int32)], 255, cv2.LINE_AA, 4)
        return m.astype(np.float32) / 255
    def paint(m, c, a=1.0):
        img[:] = img * (1 - m[..., None] * a) + (_hex(c) / 255) * m[..., None] * a
    S = poly_mask(d['upper_lid'] + d['lower_lid'][1:-1])
    paint(S, d['sclera'])
    up = np.array(d['upper_lid'], float)
    paint(poly_mask(np.vstack([up, up[::-1] + [0, d['lid_shadow']['px']]]).tolist()) * S, d['lid_shadow']['color'])
    I = d['iris']; im = ell(I['c'], I['a'], I['b']) * S
    ys = np.arange(H_)[:, None].astype(float)
    y0 = T([[I['c'][0], I['c'][1] - I['b']]])[0][1]; y1 = T([[I['c'][0], I['c'][1] + I['b']]])[0][1]
    t = np.clip((ys - y0) / max(y1 - y0, 1e-6), 0, 1); tb = I.get('top_band', 0.3)
    top, mid, bot = _hex(I['top']) / 255, _hex(I['mid']) / 255, _hex(I['bottom']) / 255
    a1 = np.clip((t - tb * 0.5) / tb, 0, 1)[..., None]; a2 = np.clip((t - 0.45) / 0.4, 0, 1)[..., None]
    col = np.where((t < 0.45)[..., None], top * (1 - a1) + mid * a1, mid * (1 - a2) + bot * a2)
    img[:] = img * (1 - im[..., None]) + col * im[..., None]
    paint(ell([I['c'][0], I['c'][1] + I['b'] * 0.42], I['a'] * 0.78, I['b'] * 0.5) * im, I['crescent'], I['crescent_alpha'])
    paint(np.clip(ell(I['c'], I['a'], I['b']) - ell(I['c'], I['a'] - I['ring_px'], I['b'] - I['ring_px']), 0, 1) * S, I['ring'])
    Pp = d['pupil']
    paint(ell(Pp['c'], Pp['a'], Pp['b']) * S, Pp['ring'])
    if Pp['ring_px'] < min(Pp['a'], Pp['b']): paint(ell(Pp['c'], Pp['a'] - Pp['ring_px'], Pp['b'] - Pp['ring_px']) * S, Pp['fill'])
    for h in d['highlights']:
        m = ell(h['c'], h['w'] / 2, h['h'] / 2) if h['kind'] in ('disc', 'pill') else stroke(h['pts'], h['px'], 0.6)
        paint(m * S, h['color'], h.get('alpha', 1.0))
    lash = poly_mask(d['lash_top'] + d['lash_bottom_outer'][1:] + d['upper_lid'][::-1][1:])
    paint(lash, d['lash_color'])
    if d['lash_edge_px'] > 0: paint(stroke(d['upper_lid'][1:], d['lash_edge_px'] * 2, 0.2) * lash, d['lash_edge_color'], 0.9)
    for s0, s1, wd in d['spikes']:
        s0, s1 = np.array(s0, float), np.array(s1, float); dv = s1 - s0; n = np.array([-dv[1], dv[0]]) / max(np.linalg.norm(dv), 1e-6)
        m = np.zeros((H_, W_), np.uint8)
        cv2.fillPoly(m, [np.round(np.asarray(T([s0 + n * wd / 2, s0 - n * wd / 2, s1]), float) * 16).astype(np.int32)], 255, cv2.LINE_AA, 4)
        paint(m.astype(np.float32) / 255, d['lash_color'])
    for s in d['lower_lash']: paint(stroke(s['pts'], s['px']), s['color'])
    cr = d['crease']; paint(stroke(cr['pts'], cr['px']), cr['color'], cr.get('alpha', 1))
    if brow:
        br = d['brow']; paint(stroke(br['pts'], br['px'], 0.25), br['color'], br.get('alpha', 1))


def _catmull(pts, closed=False, n=12):
    P = np.asarray(pts, float)
    if len(P) < 3: return P
    Q = np.vstack([P[-1], P, P[0], P[1]]) if closed else np.vstack([2 * P[0] - P[1], P, 2 * P[-1] - P[-2]])
    out = []
    for i in range(1, len(Q) - 2):
        p0, p1, p2, p3 = Q[i - 1], Q[i], Q[i + 1], Q[i + 2]
        for t in np.linspace(0, 1, n, endpoint=False):
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    if not closed: out.append(P[-1])
    return np.array(out)


if __name__ == '__main__':
    import sys, os
    out = sys.argv[1] if len(sys.argv) > 1 else '.'
    for n in PRESETS: preview(preset(n), os.path.join(out, 'anime_eye_%s.png' % n))
    for t in (0.33, 0.66): preview(blend(FEMALE, MALE, t), os.path.join(out, 'anime_eye_blend_%02d.png' % int(t * 100)))
