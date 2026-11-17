"""Pro2D -> 3D: everything the AI and the compare step read about the 2D model (lane to3d, docs/PRO2D_TO_3D.md).

    python blender/to3d/refs.py <bundle dir> <refs dir>

Writes into <refs dir>:
  head.png, head_turnL.png, head_turnR.png, front.png    the model as drawn (transparent), head crops share one framing
  blink.png, mouth_open.png, expr_<id>.png, layer_<id>.png
  labels_head.png / labels_turnL.png / labels_turnR.png   region map (colour per region, see REGIONS)
  sheet.png                                              all references on one sheet (one picture for the AI)
  parts/<n>.png + parts.json                             each visible mesh cut out, with its role and box
  sections.json                                          the bundle sections (summary, parts, params, deformers,
                                                         physics, expressions, layers, bones, measure, colours, design)
  landmarks.json                                         eye centres (px) per head view, IPD px, the crop
Head crops: x / y of the eye centres are what to3d's compare aligns the 3D renders on.
"""
import json
import os
import sys

import numpy as np  # noqa: F401  (before blender/ joins sys.path: blender/inspect.py shadows the stdlib)
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.append(os.path.dirname(HERE))

from live2d.vtp2 import Vtp2Model  # noqa: E402
from live2d.analyze import analyze  # noqa: E402
from live2d.design import design  # noqa: E402
from user_base import register_builtins  # noqa: E402  (blender/to3d is HERE: on sys.path as the script's folder)
from live2d.render import View, render_pose, render_ids, drawable_layer  # noqa: E402

REGIONS = {'hair': (200, 60, 200), 'face': (250, 200, 160), 'eyes': (40, 120, 250), 'mouth': (220, 40, 60),
           'brows': (90, 50, 30), 'skin': (240, 170, 130), 'top': (40, 170, 90), 'bottom': (30, 90, 60), 'other': (128, 128, 128)}
CLASS_REGION = {'hair_front': 'hair', 'hair_side': 'hair', 'hair_back': 'hair', 'ahoge': 'hair', 'face': 'face', 'ear': 'face',
                'nose': 'face', 'cheek': 'face', 'eye_white': 'eyes', 'iris': 'eyes', 'eye_hl': 'eyes', 'lash': 'eyes', 'eye': 'eyes',
                'brow': 'brows', 'mouth': 'mouth', 'neck': 'skin', 'skin': 'skin', 'arm': 'skin', 'hand': 'skin', 'leg': 'skin',
                'top': 'top', 'hat': 'top', 'accessory': 'top', 'bottom': 'bottom', 'legwear': 'bottom', 'shoes': 'bottom'}
HEAD_PX = 768


def srgb_to_linear(h):
    h = h.lstrip('#')
    c = np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])
    return [round(float(x), 4) for x in np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)]


def save(img, path):
    Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8), 'RGBA').save(path)


def head_crop(A):
    fb = A.lm['face_bbox']
    crown = A.lm.get('crown', fb[1])
    h = fb[3] - crown
    return (A.mid_x - 1.1 * h, crown - 0.15 * h, A.mid_x + 1.1 * h, fb[3] + 0.65 * h)


def eye_px(m, A, pose, view):
    """eye centres in a rendered view: the iris meshes' centroid per side at this pose"""
    out = {}
    for side in ('L', 'R'):
        iris = [a for a in range(len(A.cls)) if A.cls[a] == 'iris' and A.side[a] == side]
        if not iris:
            continue
        P = np.concatenate([pose.positions[a] for a in iris])
        out[side] = [round(float(x), 2) for x in view.px(P.mean(0))]
    if len(out) < 2:              # no sides: the two iris meshes by x
        iris = [a for a in range(len(A.cls)) if A.cls[a] == 'iris']
        if len(iris) >= 2:
            cs = sorted((view.px(pose.positions[a].mean(0)) for a in iris), key=lambda p: p[0])
            out = {'R': [round(float(x), 2) for x in cs[0]], 'L': [round(float(x), 2) for x in cs[-1]]}
    return out


def labels(m, A, pose, view):
    ids = render_ids(m, pose, view)
    L = np.zeros(ids.shape + (3,), np.uint8)
    for a in np.unique(ids):
        if a < 0:
            continue
        L[ids == a] = REGIONS[CLASS_REGION.get(A.cls[a], 'other')]
    return L


def contact(paths_titles, out, cell=320):
    ims = [(Image.open(p).convert('RGBA'), t) for p, t in paths_titles if os.path.exists(p)]
    cols = min(4, max(1, len(ims)))
    rows = (len(ims) + cols - 1) // cols
    S = Image.new('RGBA', (cols * cell, rows * (cell + 22)), (40, 42, 48, 255))
    d = ImageDraw.Draw(S)
    for i, (im, t) in enumerate(ims):
        im.thumbnail((cell, cell))
        x, y = (i % cols) * cell, (i // cols) * (cell + 22)
        bg = Image.new('RGBA', (cell, cell), (70, 72, 80, 255))
        bg.alpha_composite(im, ((cell - im.width) // 2, (cell - im.height) // 2))
        S.paste(bg, (x, y + 22))
        d.text((x + 6, y + 5), t, fill=(235, 235, 235, 255))
    S.save(out)


def main(bundle, out):
    os.makedirs(os.path.join(out, 'parts'), exist_ok=True)
    m = Vtp2Model.load(bundle)
    A = analyze(m, height=1536, log=lambda s: None)
    pre = design(A, log=lambda s: None, available=register_builtins() or None)
    crop = head_crop(A)
    hv = View(m.moc.canvas, HEAD_PX, crop)
    lm = {'crop_model': [round(float(x), 3) for x in crop], 'size': [hv.W, hv.H], 'views': {}}
    yaw = m.param_id('ParamAngleX', 'PARAM_ANGLE_X')
    poses = {'head': m.pose({'ParamMouthOpenY': 0, 'ParamEyeLOpen': 1, 'ParamEyeROpen': 1})}
    if yaw:
        poses['head_turnL'] = m.pose({'ParamAngleX': 30, 'ParamBodyAngleX': 10, 'ParamMouthOpenY': 0})
        poses['head_turnR'] = m.pose({'ParamAngleX': -30, 'ParamBodyAngleX': -10, 'ParamMouthOpenY': 0})
    for name, pose in poses.items():
        img, _ = render_pose(m, pose, view=hv, ss=2)
        save(img, os.path.join(out, f'{name}.png'))
        Image.fromarray(labels(m, A, pose, hv)).save(os.path.join(out, 'labels_' + (name[5:] or 'head') + '.png'))
        eyes = eye_px(m, A, pose, hv)
        lm['views'][name] = {'eyes': eyes, 'ipd_px': round(float(abs(eyes['L'][0] - eyes['R'][0])), 2) if len(eyes) == 2 else None}
    front, fv = render_pose(m, poses['head'], height=1024, ss=2)
    save(front, os.path.join(out, 'front.png'))
    extra = [('blink', {'ParamMouthOpenY': 0, 'ParamEyeLOpen': 0, 'ParamEyeROpen': 0}, None),
             ('mouth_open', {'ParamMouthOpenY': 1, 'ParamEyeLOpen': 1, 'ParamEyeROpen': 1}, None)]
    for nm, prm, _ in extra:
        img, _ = render_pose(m, m.pose(prm), view=hv, ss=2)
        save(img, os.path.join(out, f'{nm}.png'))
    exprs = []
    for e in m.bundle.get('expressions', []):
        try:
            img, _ = render_pose(m, m.pose({'ParamMouthOpenY': 0}, expression=e['id']), view=hv, ss=1)
            key = 'expr_' + ''.join(c if c.isalnum() else '_' for c in e['id'])[:40]
            save(img, os.path.join(out, key + '.png'))
            exprs.append((key, e))
        except Exception as ex:
            print('expression', e['id'], 'skipped:', ex)
    for l in m.bundle.get('layers', []):
        try:
            img, _ = render_pose(m, m.pose({'ParamMouthOpenY': 0}, layers=[l['id']]), height=768, ss=1)
            save(img, os.path.join(out, 'layer_' + ''.join(c if c.isalnum() else '_' for c in l['id'])[:40] + '.png'))
        except Exception as ex:
            print('layer', l['id'], 'skipped:', ex)
    contact([(os.path.join(out, f), t) for f, t in [('front.png', 'front'), ('head.png', 'head'), ('head_turnL.png', 'turn L (+30)'),
             ('head_turnR.png', 'turn R (-30)'), ('blink.png', 'blink'), ('mouth_open.png', 'mouth open')] + [(k + '.png', 'expr ' + e['name']) for k, e in exprs]],
            os.path.join(out, 'sheet.png'))
    # ---------------------------------------------------------------- parts (cut-outs) and the sections
    pose = poses['head']
    ipd = float(A.ipd)
    parts = []
    for i, a in enumerate(pose.order):
        if A.cls[a] in ('hidden',):
            continue
        L = drawable_layer(m, pose, a, fv, 1)
        al = L[..., 3]
        ys, xs = np.nonzero(al > 0.02)
        if len(xs) < 20:
            continue
        x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
        rgba = L[y0:y1, x0:x1].copy()
        rgba[..., :3] = np.where(rgba[..., 3:] > 1e-5, rgba[..., :3] / np.maximum(rgba[..., 3:], 1e-5), 0)
        fn = f'parts/{len(parts):03d}.png'
        save(rgba, os.path.join(out, fn))
        P = pose.positions[a]
        bb = [(P[:, 0].min() - A.mid_x) / ipd, (P[:, 1].min() - A.lm['eye_y']) / ipd, (P[:, 0].max() - A.mid_x) / ipd, (P[:, 1].max() - A.lm['eye_y']) / ipd]
        px = rgba[..., :3][rgba[..., 3] > 0.5]
        parts.append({'file': fn, 'mesh': m.moc.art_ids[a], 'name': m.art_names[a], 'role': A.cls[a], 'side': A.side[a], 'drawRank': i,
                      'boxIpd': [round(float(x), 3) for x in bb], 'colour': '#%02x%02x%02x' % tuple(int(v * 255) for v in np.median(px, 0)) if len(px) else None})
    json.dump(parts, open(os.path.join(out, 'parts.json'), 'w'), indent=1)
    B = m.bundle
    role_of = {}
    for a, c in enumerate(A.cls):
        for p in B['meshes'][a]['allParams']:
            role_of.setdefault(p, set()).add(c)
    tracked = {b['param'] for b in B.get('bindings', [])}
    phys = []
    for g in B.get('physics', []):
        roles = sorted({c for o in g['outputs'] if o for c in role_of.get(o, set())} - {'hidden', 'other'})
        hairy = any(r.startswith('hair') or r == 'ahoge' for r in roles)
        mob = g.get('mobility') or 0.9
        phys.append({**g, 'moves': roles, 'suggest': {'family': 'back' if 'hair_back' in roles else 'side' if 'hair_side' in roles else 'fringe' if 'hair_front' in roles else None,
                                                      'stiffness': round(float(np.clip(3.2 - 2.4 * mob, 0.6, 3.0)), 2) if hairy else None}})
    words = {'ParamEyeLOpen': 'left eye open', 'ParamEyeROpen': 'right eye open', 'ParamEyeLSmile': 'left eye smile', 'ParamEyeRSmile': 'right eye smile',
             'ParamMouthForm': 'mouth smile (+) / frown (-)', 'ParamMouthOpenY': 'mouth open', 'ParamCheek': 'blush', 'ParamBrowLY': 'left brow up',
             'ParamBrowRY': 'right brow up', 'ParamBrowLAngle': 'left brow angle', 'ParamBrowRAngle': 'right brow angle'}
    expr_out = []
    for e in B.get('expressions', []):
        said = [f"{words.get(p['param'], p['param'])} {p['blend']} {p['value']:+g}" for p in e['params']]
        arkit = {}
        for p in e['params']:
            v = p['value'] if p['blend'] != 'multiply' else p['value'] - 1
            if p['param'] in ('ParamEyeLOpen', 'ParamEyeROpen') and v < 0:
                arkit['eyeBlink' + ('Left' if p['param'] == 'ParamEyeLOpen' else 'Right')] = round(min(1.0, -v), 2)
            if p['param'] == 'ParamMouthForm':
                arkit['mouthSmileLeft' if v > 0 else 'mouthFrownLeft'] = arkit['mouthSmileRight' if v > 0 else 'mouthFrownRight'] = round(min(1.0, abs(v)), 2)
            if p['param'] == 'ParamCheek' and v > 0:
                arkit['cheekSquintLeft'] = arkit['cheekSquintRight'] = round(min(1.0, v * 0.4), 2)
        n = e['name'].lower()
        preset = 'happy' if any(k in n for k in ('happy', 'smile', 'joy', '笑', 'fun')) else 'angry' if any(k in n for k in ('angry', 'mad', '怒')) else \
            'sad' if any(k in n for k in ('sad', 'cry', '泣', '悲')) else 'surprised' if any(k in n for k in ('surpris', 'shock', '驚')) else \
            'relaxed' if any(k in n for k in ('relax', 'calm', 'sleep', 'squint')) else None
        expr_out.append({'id': e['id'], 'name': e['name'], 'key': e.get('key'), 'does': said, 'vrmPreset': preset, 'arkitMix': arkit, 'picture': next((k + '.png' for k, x in exprs if x['id'] == e['id']), None)})
    fb = A.lm['face_bbox']
    measure = {k: v for k, v in pre['l2d']['metrics'].items() if isinstance(v, (int, float))}
    measure.update({'faceWidthIpd': round(float((fb[2] - fb[0]) / ipd), 3), 'crownAboveEyeIpd': round(float((A.lm['eye_y'] - A.lm.get('crown', fb[1])) / ipd), 3),
                    'chinBelowEyeIpd': round(float((fb[3] - A.lm['eye_y']) / ipd), 3)})
    cols = {}
    for k, v in A.colors.items():
        if isinstance(v, str) and v.startswith('#'):
            cols[k] = {'srgb': v, 'linear': srgb_to_linear(v)}
        elif isinstance(v, dict):
            cols[k] = {kk: {'srgb': vv, 'linear': srgb_to_linear(vv)} for kk, vv in v.items() if isinstance(vv, str) and vv.startswith('#')}
    from collections import Counter
    sections = {
        'summary': {'name': m.name, 'source': (B['meta'].get('source') or {}).get('kind'), 'canvas': B['canvas'], 'meshes': len(B['meshes']),
                    'params': len(B['params']), 'route': 'vtp2', 'ipdPx': round(ipd * float(B['canvas']['ppu']), 2),
                    'sex': pre['l2d']['sex'], 'sexScore': pre['l2d']['sex_score'], 'longHair': pre['l2d']['long_hair'], 'base': pre['creator']['base'],
                    'roles': dict(Counter(c for c in A.cls if c != 'hidden')), 'headTurn': bool(yaw),
                    'rights': B['meta'].get('rights'), 'expressions': len(B.get('expressions', [])), 'layers': len(B.get('layers', []))},
        'parts': parts,
        'params': [{'id': p['id'], 'name': p['name'], 'range': [p['min'], p['max']], 'default': p['default'], 'moves': sorted(role_of.get(p['id'], set()) - {'hidden'}),
                    'tracked': p['id'] in tracked} for p in B['params']],
        'deformers': [{'id': d['id'], 'name': d['name'], 'kind': d['kind'], 'parent': d['parent']} for d in B['deformers']],
        'physics': phys,
        'expressions': expr_out,
        'layers': B.get('layers', []),
        'bones': B.get('bones', []),
        'measure': measure,
        'colours': cols,
        'design': {k: v for k, v in pre.items() if k != 'l2d'},
    }
    json.dump(sections, open(os.path.join(out, 'sections.json'), 'w', encoding='utf-8'), indent=1, ensure_ascii=False, default=float)
    json.dump(lm, open(os.path.join(out, 'landmarks.json'), 'w'), indent=1)
    print('TO3D_REFS_OK', len(parts), 'parts', len(exprs), 'expressions')


def front_only(bundle, out):
    """a rig that can't be read as a character (no eyes / head turn found): just the drawing, for the picture route"""
    os.makedirs(out, exist_ok=True)
    m = Vtp2Model.load(bundle)
    img, _ = render_pose(m, m.pose({}), height=1024, ss=2)
    save(img, os.path.join(out, 'front.png'))
    bg = Image.new('RGBA', Image.open(os.path.join(out, 'front.png')).size, (255, 255, 255, 255))
    bg.alpha_composite(Image.open(os.path.join(out, 'front.png')))
    bg.convert('RGB').save(os.path.join(out, 'front_flat.png'))
    contact([(os.path.join(out, 'front.png'), 'front')], os.path.join(out, 'sheet.png'))
    B = m.bundle
    json.dump({'summary': {'name': m.name, 'route': 'image', 'meshes': len(B['meshes']), 'params': len(B['params']), 'headTurn': False,
                           'source': (B['meta'].get('source') or {}).get('kind'), 'rights': B['meta'].get('rights'),
                           'note': 'The rig could not be read as a character (eyes or head turn not found): the 3D comes from the front picture.'},
               'parts': [], 'params': [{'id': p['id'], 'name': p['name']} for p in B['params']], 'deformers': [], 'physics': [], 'expressions': [],
               'layers': B.get('layers', []), 'bones': B.get('bones', []), 'measure': {}, 'colours': {}, 'design': {}},
              open(os.path.join(out, 'sections.json'), 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    json.dump({'views': {}}, open(os.path.join(out, 'landmarks.json'), 'w'))
    print('TO3D_REFS_OK front-only')


if __name__ == '__main__':
    if '--front-only' in sys.argv:
        front_only(sys.argv[1], sys.argv[2])
    else:
        main(sys.argv[1], sys.argv[2])
