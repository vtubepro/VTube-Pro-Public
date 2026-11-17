"""Pro2D -> 3D: the 3D renders against the 2D references at identical framing (lane to3d).

    python blender/to3d/compare.py <refs dir> <renders dir> <out dir> [--route vtp2|image]

renders dir: head_0.png, head_p20.png, head_m20.png (transparent, the app renderer) + eyes.json {view: {L:[x,y], R:[x,y]}}
Each 3D head is scaled + moved so its eye centres land on the drawn ones (the 2D +-30 turns are compared with the 3D at
+-20 deg: a Live2D "30" turns the eyes like a ~20 deg rotation, the same angle silfit fits). Then per view:
  iou      silhouette overlap, whole and per drawn region (coverage of the drawn hair / face / outfit by the 3D)
  dE       colour difference (CIEDE2000) of the mean colour inside each drawn region (skin, hair, eyes, top)
  lm       crown height and head width at the eye row, in IPD units (3D - 2D)
The total (0-100) and the worst region only GUIDE the next round and catch regressions; they are not the acceptance
test (silhouette IoU is not a quality metric: AI_CREATOR_GUIDE 9.3). Writes scores.json and compare_<view>.png sheets.
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

REG = {'hair': (200, 60, 200), 'face': (250, 200, 160), 'eyes': (40, 120, 250), 'mouth': (220, 40, 60), 'brows': (90, 50, 30),
       'skin': (240, 170, 130), 'top': (40, 170, 90), 'bottom': (30, 90, 60)}
# the 2D +30 turn (Cubism: toward the viewer's right) pairs with the 3D shot whose anchor yaw is -20 (measured in the app
# renderer: its +yaw turns the avatar toward the viewer's LEFT)
VIEWS = [('front', 'head.png', 'labels_head.png', 'head', 'head_0.png'),
         ('turnL', 'head_turnL.png', 'labels_turnL.png', 'head_turnL', 'head_m20.png'),
         ('turnR', 'head_turnR.png', 'labels_turnR.png', 'head_turnR', 'head_p20.png')]
LEVER = {
    'hair silhouette': 'hair.backLengthScale / hair.mode, or extra locks built in Blender and grafted',
    'head shape': 'creator.face.faceWidth / creator.face.jaw / creator.face.chin',
    'crown': 'hair.silfit (on) or creator.body.head; a crown lock built in Blender for spiky tops',
    'skin colour': 'creator.colors.skin (warmer), then look.vrmExposure',
    'hair colour': 'creator.colors.hair / creator.colors.hairTip',
    'eye colour': 'face.iris.color / face.iris.top / face.iris.bottom',
    'outfit colour': 'creator.outfit.tops.color / creator.outfit.bottoms.color',
}


def load(p):
    return np.asarray(Image.open(p).convert('RGBA'), np.float32) / 255


def to_lab(rgb):
    c = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    M = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = c @ M.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def de2000(a, b):
    L1, a1, b1 = a; L2, a2, b2 = b
    C1, C2 = np.hypot(a1, b1), np.hypot(a2, b2)
    Cb = (C1 + C2) / 2
    G = 0.5 * (1 - np.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1p, h2p = np.degrees(np.arctan2(b1, a1p)) % 360, np.degrees(np.arctan2(b2, a2p)) % 360
    dL, dC = L2 - L1, C2p - C1p
    dh = h2p - h1p
    dh = dh - 360 if dh > 180 else dh + 360 if dh < -180 else dh
    dH = 2 * np.sqrt(C1p * C2p) * np.sin(np.radians(dh / 2))
    Lb, Cbp = (L1 + L2) / 2, (C1p + C2p) / 2
    hb = (h1p + h2p) / 2 if abs(h1p - h2p) <= 180 else (h1p + h2p + 360) / 2
    T = 1 - 0.17 * np.cos(np.radians(hb - 30)) + 0.24 * np.cos(np.radians(2 * hb)) + 0.32 * np.cos(np.radians(3 * hb + 6)) - 0.2 * np.cos(np.radians(4 * hb - 63))
    SL = 1 + 0.015 * (Lb - 50) ** 2 / np.sqrt(20 + (Lb - 50) ** 2)
    SC, SH = 1 + 0.045 * Cbp, 1 + 0.015 * Cbp * T
    RT = -2 * np.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7)) * np.sin(np.radians(60 * np.exp(-((hb - 275) / 25) ** 2)))
    return float(np.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH)))


def align(img3, e3, e2, size):
    """similarity transform (scale + move) putting the 3D eye centres on the 2D ones; returns the 3D image in 2D space"""
    (l3, r3), (l2, r2) = (np.array(e3['L']), np.array(e3['R'])), (np.array(e2['L']), np.array(e2['R']))
    s = np.linalg.norm(l2 - r2) / max(np.linalg.norm(l3 - r3), 1e-6)
    t = (l2 + r2) / 2 - s * (l3 + r3) / 2
    im = Image.fromarray((np.clip(img3, 0, 1) * 255).astype(np.uint8), 'RGBA')
    # PIL wants the inverse map: src = (dst - t) / s
    out = im.transform(size, Image.AFFINE, (1 / s, 0, -t[0] / s, 0, 1 / s, -t[1] / s), resample=Image.BILINEAR)
    return np.asarray(out, np.float32) / 255, s


def region_masks(lab_img):
    L = np.asarray(lab_img.convert('RGB'))
    m = {k: np.all(np.abs(L.astype(int) - np.array(c)) < 6, -1) for k, c in REG.items()}
    m['faceAll'] = m['face'] | m['eyes'] | m['mouth'] | m['brows'] | m['skin']
    return m


def erode(m, n=2):
    out = m.copy()
    for _ in range(n):
        out = out & np.roll(out, 1, 0) & np.roll(out, -1, 0) & np.roll(out, 1, 1) & np.roll(out, -1, 1)
    return out


def row_width(a, y):
    y = int(np.clip(round(y), 0, a.shape[0] - 1))
    xs = np.nonzero(a[y])[0]
    return float(xs.max() - xs.min()) if len(xs) else 0.0


def view_scores(img2, img3, M, eyes2):
    a2, a3 = img2[..., 3] > 0.5, img3[..., 3] > 0.5
    ipd = abs(eyes2['L'][0] - eyes2['R'][0]) or 1.0
    ey = (eyes2['L'][1] + eyes2['R'][1]) / 2
    inter, union = (a2 & a3).sum(), (a2 | a3).sum()
    iou = {'all': round(float(inter / max(union, 1)), 3)}
    for k in ('hair', 'faceAll', 'top'):
        r = M[k]
        if r.sum() > 200:
            iou[k] = round(float((r & a3).sum() / r.sum()), 3)
    lab2, lab3 = to_lab(img2[..., :3]), to_lab(img3[..., :3])
    dE = {}
    for k, key in (('skin', 'face'), ('hair', 'hair'), ('eyes', 'eyes'), ('top', 'top')):
        r = erode(M[key]) & a3 & a2
        if r.sum() > 60:
            dE[k] = round(de2000(lab2[r].mean(0), lab3[r].mean(0)), 2)
    def top_y(a):
        ys = np.nonzero(a.any(1))[0]
        return float(ys.min()) if len(ys) else ey
    lm = {'crown': round(((ey - top_y(a3)) - (ey - top_y(a2))) / ipd, 3),
          'headWidth': round((row_width(a3, ey) - row_width(a2, ey)) / ipd, 3)}
    extra = (a3 & ~a2).sum() / max(a2.sum(), 1)
    return {'iou': iou, 'dE': dE, 'lm': lm, 'extra': round(float(extra), 3)}


def total(views):
    parts, w = [], []
    for name, v in views.items():
        k = 0.4 if name == 'front' else 0.3
        parts.append(v['iou']['all']); w.append(0.35 * k)
        if v['dE']:
            parts.append(max(0.0, 1 - np.mean(list(v['dE'].values())) / 30)); w.append(0.25 * k)
        parts.append(max(0.0, 1 - (abs(v['lm']['crown']) + abs(v['lm']['headWidth'])) / 0.8)); w.append(0.25 * k)
        parts.append(max(0.0, 1 - v['extra'])); w.append(0.15 * k)
    return round(100 * float(np.dot(parts, w) / max(sum(w), 1e-6)), 1)


def worst(views):
    cands = []
    for vn, v in views.items():
        i = v['iou']
        if 'hair' in i: cands.append((i['hair'], 'hair silhouette', vn, f"the 3D covers {i['hair']:.0%} of the drawn hair"))
        if 'faceAll' in i: cands.append((i['faceAll'], 'head shape', vn, f"the 3D covers {i['faceAll']:.0%} of the drawn face"))
        cands.append((1 - min(1, abs(v['lm']['crown']) * 2), 'crown', vn, f"crown {v['lm']['crown']:+.2f} IPD vs the drawing"))
        for k, lab in (('skin', 'skin colour'), ('hair', 'hair colour'), ('eyes', 'eye colour'), ('top', 'outfit colour')):
            if k in v['dE']: cands.append((1 - min(1, v['dE'][k] / 25), lab, vn, f"{lab} differs by dE {v['dE'][k]:.1f}"))
    if not cands:
        return None
    s, region, vn, why = min(cands, key=lambda c: c[0])
    return {'region': region, 'view': vn, 'why': why, 'lever': LEVER[region]}


def sheet(img2, img3, out, title):
    h, w = img2.shape[:2]
    bg = np.array([0.27, 0.28, 0.31, 1.0], np.float32)
    def over(x):
        o = bg.copy() * np.ones((h, w, 4), np.float32)
        return o * (1 - x[..., 3:]) + np.concatenate([x[..., :3], np.ones((h, w, 1))], -1) * x[..., 3:]
    a2, a3 = img2[..., 3] > 0.5, img3[..., 3] > 0.5
    ov = over(img2) * 0.55
    ov[a3 & ~a2] = [0.95, 0.35, 0.3, 1]            # 3D where nothing is drawn
    ov[a2 & ~a3] = [0.3, 0.6, 0.95, 1]             # drawn where the 3D is missing
    ov[..., 3] = 1
    row = np.concatenate([over(img2), over(img3), ov], 1)
    im = Image.fromarray((np.clip(row, 0, 1) * 255).astype(np.uint8), 'RGBA')
    d = ImageDraw.Draw(im)
    for i, t in enumerate(['2D (drawn)', '3D (app renderer)', 'red: extra 3D   blue: missing']):
        d.text((i * w + 8, 6), t if i else f'{title}: {t}', fill=(240, 240, 240, 255))
    im.save(out)


def main(refs, renders, out, route='vtp2'):
    os.makedirs(out, exist_ok=True)
    L = json.load(open(os.path.join(refs, 'landmarks.json')))
    E = json.load(open(os.path.join(renders, 'eyes.json')))
    views, sheets = {}, []
    for vn, r2, lab, lk, r3 in VIEWS:
        if route == 'image' and vn != 'front':
            continue
        p2, p3 = os.path.join(refs, r2), os.path.join(renders, r3)
        e2 = (L['views'].get(lk) or {}).get('eyes')
        e3 = E.get(r3[:-4])
        if not (os.path.exists(p2) and os.path.exists(p3) and e2 and e3 and len(e2) == 2 and len(e3) == 2):
            continue
        img2 = load(p2)
        img3, s = align(load(p3), e3, e2, (img2.shape[1], img2.shape[0]))
        M = region_masks(Image.open(os.path.join(refs, lab)))
        views[vn] = view_scores(img2, img3, M, e2)
        fn = f'compare_{vn}.png'
        sheet(img2, img3, os.path.join(out, fn), vn)
        sheets.append(fn)
    res = {'total': total(views) if views else 0.0, 'views': views, 'worst': worst(views), 'sheets': sheets}
    json.dump(res, open(os.path.join(out, 'scores.json'), 'w'), indent=1)
    if sheets:   # one picture for the AI: the view sheets stacked
        ims = [Image.open(os.path.join(out, f)) for f in sheets]
        W = max(i.width for i in ims)
        S = Image.new('RGBA', (W, sum(i.height for i in ims)), (40, 42, 48, 255))
        y = 0
        for i in ims:
            S.paste(i, (0, y)); y += i.height
        S.thumbnail((1400, 1400))
        S.save(os.path.join(out, 'compare_sheet.png'))
    print('TO3D_COMPARE_OK', json.dumps({'total': res['total'], 'worst': res['worst']}))


if __name__ == '__main__':
    a = sys.argv[1:]
    route = a[a.index('--route') + 1] if '--route' in a else 'vtp2'
    main(a[0], a[1], a[2], route)
