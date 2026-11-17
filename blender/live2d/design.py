"""Analysis of a Live2D model -> a face_kit anime preset (CC0 VRoid base + parameters) that reads as the character.

    pre = design(A, sex='auto')          # A = analyze.analyze(model)
    pre['creator']  -> anime_creator params (base, hair donor, colours, face shape, body, outfit colours)
    pre['face']     -> face_kit VFace params (iris gradient, highlights, lash line, brows, blush, nose, mouth)
    pre['l2d']      -> the measurements behind every number (for the report / debugging)

Everything is measured in the Live2D face frame with the eye-to-eye distance (IPD) as the unit, and compared with the
same measurement on the chosen VRoid base (BASE_METRICS, measured from tools/vendor/vroid with anime_creator.vroid).
"""
import colorsys

import numpy as np

# VRoid CC0 bases, measured once (eye white width / height, eye line -> chin, brow gap; metres; see RESEARCH.md)
BASE_METRICS = {
    'fumiriya': dict(eye_w=0.0425, eye_h=0.0281, ipd=0.0892, eye_chin=0.1017, brow_gap=0.0286,
                     eye_tilt=0.121, iris_ratio=0.588, iris_aspect=1.122, fw_mid=1.587, fw_low=0.854),
    'hairsample_male': dict(eye_w=0.0486, eye_h=0.0278, ipd=0.0944, eye_chin=0.1042, brow_gap=0.0312,
                            eye_tilt=0.217, iris_ratio=0.587, iris_aspect=1.017, fw_mid=1.474, fw_low=0.883),
    'shibu': dict(eye_w=0.0462, eye_h=0.0333, ipd=0.0894, eye_chin=0.0903, brow_gap=0.0386,
                  eye_tilt=0.061, iris_ratio=0.701, iris_aspect=1.052, fw_mid=1.53, fw_low=0.627),
    'shino': dict(eye_w=0.0465, eye_h=0.0357, ipd=0.0893, eye_chin=0.0924, brow_gap=0.0377,
                  eye_tilt=0.153, iris_ratio=0.628, iris_aspect=1.295, fw_mid=1.543, fw_low=0.633),
    'darkness_shibu': dict(eye_w=0.0463, eye_h=0.0314, ipd=0.0896, eye_chin=0.0912, brow_gap=0.0351),
    'hairsample_female': dict(eye_w=0.0462, eye_h=0.0339, ipd=0.0895, eye_chin=0.0903, brow_gap=0.0386),
}



def _lum_hex(h):
    h = h.lstrip('#')
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return 0.299 * r + 0.587 * g + 0.114 * b

def _rgb(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])


def _hex(c):
    c = np.clip(np.asarray(c, float), 0, 1)
    return '#%02x%02x%02x' % tuple(int(round(v * 255)) for v in c)


def _hsv(h):
    return colorsys.rgb_to_hsv(*_rgb(h))


def _mix(a, b, t):
    return _hex(_rgb(a) * (1 - t) + _rgb(b) * t)


def _cdist(a, b):
    return float(np.linalg.norm(_rgb(a) - _rgb(b)))


def metrics(A):
    """face / body measurements in IPD units + sex cues"""
    lm, ipd = A.lm, A.ipd
    out = {'ipd_model': ipd}
    eyes = [lm[k] for k in ('eye_L', 'eye_R') if k in lm]
    if eyes:
        out['eye_w'] = float(np.mean([e['width'] for e in eyes]) / ipd)
        out['eye_h'] = float(np.mean([e['height'] for e in eyes]) / ipd)
        out['eye_aspect'] = out['eye_h'] / max(out['eye_w'], 1e-6)
        ib = [e['iris_bbox'] for e in eyes]
        out['iris_w'] = float(np.mean([b[2] - b[0] for b in ib]) / ipd)
        out['iris_aspect'] = float(np.mean([(b[3] - b[1]) / max(b[2] - b[0], 1e-6) for b in ib]))
        lb = [e.get('lash_bbox') for e in eyes if e.get('lash_bbox')]
        if lb:
            # how far the lash art extends past the eye white (wing) and above it (lash weight)
            out['lash_over_w'] = float(np.mean([(l[2] - l[0]) / e['width'] for l, e in zip(lb, eyes)]))
    fb = lm['face_bbox']
    out['eye_chin'] = float((fb[3] - lm['eye_y']) / ipd)
    brows = [lm[k] for k in ('brow_L', 'brow_R') if k in lm]
    if brows and eyes:
        out['brow_gap'] = float((lm['eye_y'] - np.mean([(b[1] + b[3]) / 2 for b in brows])) / ipd)
        out['brow_thick'] = float(np.mean([b[3] - b[1] for b in brows]) / ipd)
    if 'crown' in lm:
        out['head_h'] = float((fb[3] - lm['crown']) / ipd)
    if 'hair_back_bbox' in lm:
        out['back_len'] = float((lm['hair_back_bbox'][3] - fb[3]) / ipd)      # below the chin, IPD units
    side = lm.get('hair_side_bbox')
    if side:
        out['side_len'] = float((side[3] - fb[3]) / ipd)
    fw = lm.get('face_width', {})
    if 'eye' in fw and 'low' in fw:
        out['jaw_taper'] = fw['low'] / max(fw['eye'], 1e-6)
    fig = lm.get('figure_bbox')
    if fig:
        out['figure_h'] = float((fig[3] - fig[1]) / ipd)
    return out


def guess_sex(M):
    """+ = male. Anime cues: narrow eyes (opening aspect), a long lower face, heavier brows, rounder iris."""
    s = 0.0
    if 'eye_aspect' in M:
        s += (0.62 - M['eye_aspect']) * 6          # F 0.7-0.95, M 0.45-0.6
    if 'eye_chin' in M:
        s += (M['eye_chin'] - 1.25) * 3            # eye line -> chin in IPD: F ~1.0-1.15, M ~1.3-1.6
    if 'brow_thick' in M:
        s += (M['brow_thick'] - 0.15) * 4
    if 'iris_aspect' in M:
        s += (1.12 - M['iris_aspect']) * 2
    return ('male' if s > 0 else 'female'), float(s)


def pick_base(sex, long_hair, hoodish, available=None):
    """the preferred base for the drawing, else the nearest one this PC has (available = the keys this run may use)"""
    # VTube Pro's own bundled bases first (Pro2D -> 3D: blender/to3d/user_base.py BUILTIN), then the CC0 VRoid samples
    if sex == 'female':
        order = ['mirelle'] + (['shino', 'darkness_shibu', 'hairsample_female', 'shibu'] if long_hair else ['shibu', 'shino', 'hairsample_female', 'darkness_shibu'])
    else:
        order = ['kairo'] + (['hairsample_male', 'fumiriya'] if hoodish else ['fumiriya', 'hairsample_male'])
    if not available:
        return order[0]
    for b in order:
        if b in available:
            return b
    return sorted(available)[0]


def design(A, sex='auto', name=None, pid='live2d_avatar', log=print, force_base=None, available=None, user_metrics=None):
    """force_base: a base key (an override, or 'user' = the performer's own VRoid base measured as user_metrics);
    available: the base keys on this PC (None = all)"""
    C, lm = A.colors, A.lm
    M = metrics(A)
    auto, score = guess_sex(M)
    sex = auto if sex in (None, 'auto') else sex
    back_len = M.get('back_len', 0.0)
    long_hair = back_len > 2.2 or M.get('side_len', 0) > 2.2
    outfit = getattr(A, 'outfit', {}) or {}
    hoodish = sex != 'female' and any(k in ' '.join(sum((n[:6] for n, c in zip(A.names, A.cls) if c in ('top', 'hat')), [])).lower()
                                      for k in ('hood', 'パーカー', 'フード', 'jacket', 'ジャケット'))
    base = force_base or pick_base(sex, long_hair, hoodish, available)
    if base == 'user':
        if not user_metrics:
            raise ValueError('the user base was not measured')
        BASE_METRICS['user'] = {k: v for k, v in user_metrics.items() if v is not None}
    if base not in BASE_METRICS:
        raise ValueError(f'base {base} was not measured (blender/to3d/user_base.py)')
    B = BASE_METRICS[base]
    bw = B['eye_w'] / B['ipd']
    eye_size = float(np.clip(M.get('eye_w', bw) / bw, 0.85, 1.35))
    # eyes relative to the FACE width too (IPD alone under-reads wide-set big anime eyes): the larger of the two
    fwm = ((lm.get('face_width') or {}).get('mid'))
    if fwm and M.get('ipd_model') and B.get('fw_mid'):
        rel = (M.get('eye_w', bw) / (fwm / M['ipd_model'])) / (bw / B['fw_mid'])
        eye_size = float(np.clip(max(eye_size, rel), 0.85, 1.35))
    chin_d = (M.get('eye_chin', B['eye_chin'] / B['ipd']) - B['eye_chin'] / B['ipd']) * B['ipd']
    # the eye-to-chin distance in IPD over-reads (narrow-set drawn eyes, bbox chin): half weight, and anime girls'
    # faces stay short and round
    chin = float(np.clip(0.5 * chin_d / 0.012, -1.0, 1.0))
    if sex == 'female':
        chin = min(chin, 0.4)
    else:
        chin = min(chin, 0.3)                          # anime men: a firm jaw, never a long neck-and-face (review x4)
    # ------------------------------------------------------------------ colours
    hair = C.get('hair', '#5a4a4a')
    root, tip = C.get('hair_root', hair), C.get('hair_tip', hair)
    # a dyed tip is a colour region, not the drawn shading / line art at the lock ends (dark, often maroon in Live2D
    # line art): a tip much darker than the hair is shading
    hair_tip = tip if _cdist(root, tip) > 0.09 and _lum_hex(tip) >= 0.6 * _lum_hex(hair) else None
    acc = C.get('hair_accents', [])
    if hair_tip is None and acc and _cdist(acc[0], hair) > 0.18 and _lum_hex(acc[0]) >= 0.6 * _lum_hex(hair):
        hair_tip = acc[0]                     # dyed inner / tip colour (Ren's blue ends)
    iris = C.get('iris_L') or C.get('iris_R') or {}
    eye_mid = iris.get('mid', '#4a7bd8')
    # the iris art usually gets lighter toward the bottom; make sure the gradient reads (VRoid irises are small)
    top = iris.get('top') or _mix(eye_mid, '#000000', 0.55)
    bottom = iris.get('bottom') or _mix(eye_mid, '#ffffff', 0.4)
    light = iris.get('light')
    if _cdist(top, bottom) < 0.15 and light:
        bottom = _mix(eye_mid, light, 0.75)
        eye_mid = _mix(eye_mid, light, 0.35)
    brows = C.get('brow') or _mix(hair, '#000000', 0.35)
    skin = C.get('skin')
    if skin:
        # MToon + the app's exposure desaturate pale skin toward grey: push the drawn tone warmer so it reads the same
        h, s, v = _hsv(skin)
        warm = s <= 0.02 or h < 0.16 or h > 0.9
        # a cool / fantasy skin (pale blue, lavender, green) keeps its drawn hue and is not pushed more saturated
        skin = _hex(colorsys.hsv_to_rgb(h if s > 0.02 else 0.07, min(0.3, max(s * 1.5, 0.13)) if warm else s * 0.7, v))
    colors = {'hair': hair, 'hairTip': hair_tip, 'hairTipRange': [0.45, 1.0], 'eyes': eye_mid, 'brows': brows}
    if skin:
        colors['skin'] = skin
    creator = {'base': base, 'hair': {'style': base}, 'colors': colors,
               'face': {'eyeSize': round(eye_size, 3), 'chin': round(chin, 2)}, 'body': {}, 'outfit': {}}
    # face shape from the drawn contour: cheek width halfway eye -> chin, jaw width at 80 % (both in IPD, measured the
    # same way on the bases: skin width at those heights). faceWidth scales cheeks + jaw, jaw scales below the mouth.
    fwd = (lm.get('face_width') or {})
    ipd_m = M.get('ipd_model')
    if ipd_m and 'mid' in fwd and B.get('fw_mid'):
        fw = float(np.clip(fwd['mid'] / ipd_m / B['fw_mid'], 0.9, 1.1))
        if sex == 'female':
            fw = max(fw, 1.0)                        # side locks hide the drawn cheek edge: never narrow a girl's face
        creator['face']['faceWidth'] = round(fw, 3)
        if 'low' in fwd and B.get('fw_low'):
            creator['face']['jaw'] = round(float(np.clip(fwd['low'] / ipd_m / B['fw_low'] / fw,
                                                         1.1 if sex == 'female' else 0.85, 1.3 if sex == 'female' else 1.15)), 3)
    # outfit colours (garment shapes come from the base; see RESEARCH.md for what is and isn't transferred)
    top_c = (outfit.get('top') or {}).get('colors') or []
    top_c = [c for c in top_c if c != 'skin']
    if top_c:
        creator['outfit']['tops'] = {'color': top_c[0]}
    bot = outfit.get('bottom') or {}
    bc = [c for c in (bot.get('colors') or []) if c != 'skin']
    if bc:
        creator['outfit']['bottoms'] = {'color': bc[0]}
    sh = (outfit.get('shoes') or {}).get('colors') or []
    if sh:
        creator['outfit']['shoes'] = {'color': sh[0]}
    # ------------------------------------------------------------------ face_kit (VFace) parameters
    female = sex == 'female'
    lash = C.get('lash', '#2a1a22')
    line = _mix(lash, '#2a1a22', 0.3)
    sclera = C.get('sclera', '#fbf8f8')
    dark_eye = _lum_hex(sclera) < 0.35
    if dark_eye:
        # dark / black sclera (a demon / possessed look): the white goes near black, its lid shadow darker still (a
        # pale default shadow band would read as a white eye), and the iris glows so it pops out of the dark
        sclera = _mix(sclera, '#000000', 0.8)
        # the iris of a dark eye GLOWS: brighter and cyan-shifted, like the drawn light in the dark
        eye_mid = _mix(eye_mid, '#5fe6ff', 0.55)
        top = _mix(top, '#1a8fd0', 0.4)
        bottom = _mix(bottom, '#c8fbff', 0.5)
    face = {
        'iris': {'color': eye_mid, 'top': top, 'bottom': bottom, 'ring': _mix(iris.get('dark', top), '#000000', 0.3),
                 'glow': (_mix(eye_mid, '#bff6ff', 0.55) if dark_eye else light if light and female else None),
                 'glowAlpha': 0.85 if dark_eye else 0.55,
                 'pupil': 0.34 if female else 0.3, 'pupilColor': _mix(iris.get('dark', top), '#000000', 0.25),
                 'streaks': 0.12, 'topBand': 0.3 if female else 0.36},
        'eye': {'line': line, 'line2': _mix(line, skin or '#f3d5c0', 0.35),
                'lineMax': 0.24 if female else 0.15, 'wing': 0.26 if female else 0.07,
                'spikes': 3 if female else 0,
                'whiteShadow': _mix(sclera, '#000000', 0.5) if dark_eye else '#c9c3dc',
                'white': sclera},
        'brow': {'color': brows, 'shape': 'female' if female else 'male',
                 'height': 2.25 if female else 1.75, 'width': 0.13 if female else 0.22,
                 'tilt': 0.0 if female else -0.2},
        'skin': {'blush': C.get('blush', '#f08a8a'), 'blushAlpha': 0.28 if female else 0.1,
                 'nose': 'tick' if female else 'wedge', 'mouthLine': C.get('mouth_line', '#b5605a'),
                 'lowerLash': 0.5 if female else 0.0,
                 # one clean flat skin across the whole face and round to the ears: the base's painted gradients
                 # left a lighter band down the cheek where the flat base faded out (review: 'cheek seam')
                 'flatten': 1.0, 'flattenFade': [4.2, 6.0],
                 'socket': 0.95 if dark_eye else 0.0, 'socketColor': _mix(sclera, '#0a0620', 0.5) if dark_eye else None},
    }
    # ------------------------------------------------------------------ eyes: anime_eyes preset fitted to the drawing
    eyes_fit = None
    try:
        from . import eyefit
        ep, eavg = eyefit.fit(A, sex, score, C, log=log)
        fv, fc = eyefit.vface_params(ep, base_iris_ratio=B.get('iris_ratio'), base_aspect=B['eye_h'] / B['eye_w'])
        if B.get('iris_aspect'):
            fv['iris']['scaleY'] = round(float(np.clip(ep['iris']['aspect'] / B['iris_aspect'], 0.85, 1.2)), 3)
        for k, v in fv.items():
            face.setdefault(k, {}).update(v)
        # the creator's eye warp rotates relative to the base's own corner tilt
        d_tilt = float(np.degrees(np.arctan(ep['opening']['tilt'])) - np.degrees(np.arctan(B.get('eye_tilt', 0.0))))
        creator['face']['eyeTilt'] = round(float(np.clip(d_tilt, -8.0, 8.0)), 2)
        M['eye_aspect_fit'] = float(ep['opening']['height'])
        if eavg.get('curves'):
            M['eye_curves'] = eavg['curves']
        eyes_fit = {'preset': ep, 'measured': eavg}
    except Exception as e:                      # never fail a conversion on the eye fit; the defaults above stand
        log(f'eyefit: skipped ({type(e).__name__}: {e})')
    if 'brow_gap' in M:
        # VFace brow height is in eye heights above the eye centre
        eh = M.get('eye_h', 0.4)
        face['brow']['height'] = round(float(np.clip(M['brow_gap'] / max(eh, 0.1), 1.2, 3.0)), 2)
    pre = {'id': pid, 'name': name or pid, 'creator': creator, 'face': face, 'proxy': 1.0,
           'profile': {'source': 'import'},
           'l2d': {'sex': sex, 'sex_auto': auto, 'sex_score': round(score, 2), 'metrics': M, 'colors': C,
                   'outfit': outfit, 'long_hair': bool(long_hair), 'eyes': eyes_fit}}
    return pre
