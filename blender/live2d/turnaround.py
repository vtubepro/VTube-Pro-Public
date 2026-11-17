"""Optional turnaround stage: side / back views of the character that a Live2D model cannot show (it only turns ~30 deg).

    tools/live2d_to_3d.py <model> <out> --turnaround <dir>    # use turnaround views you already have
    tools/live2d_to_3d.py <model> <out> --turnaround auto      # generate them with the configured generator (below)

Views: `front`, `three_quarter`, `side`, `back` (png / jpg / webp, any size, plain or transparent background), or one
wide sheet `sheet.*` split into 4 equal columns in that order. Without `--turnaround` the pipeline is unchanged.

Generation (`auto`) runs an EXTERNAL generator command so the user's own image-generation account / tool does the
work: env `VTP_TURNAROUND_GEN` = a command template with `{ref}` (the drawn front render, PNG), `{refL}` / `{refR}` (the
Live2D +-30 deg head turns) and `{out}` (the folder that must receive front / three_quarter / side / back images), e.g.
a Higgsfield CLI wrapper script. Nothing is uploaded unless the user configured that command. The pipeline itself never
sends the model anywhere. Results are cached per model (hash of the moc3 + textures) in `<out>/l2d/turnaround/`, so a
re-conversion never pays twice.

What the views feed (measured on hair / garment silhouettes, never projected onto the face -- the face stays drawn, the
eyes stay the moc3 eye fit):
  side  -> hair depth behind the skull (dome back volume), back hair length, crown height above the drawn crown
  back  -> back hair width per height (side volume) and length, number of tips along the back hem (back row density)
  both  -> back / side hair colour (root / tip), garment back colour, jacket / skirt length at the back
All measurements are in IPD units relative to the eye line (`b`, up positive) like hair2d's frame, using the front
view's crown row and skin (chin) row for the scale; the views are assumed to share one framing (a turnaround sheet).
"""
import glob
import hashlib
import json
import os
import shlex
import subprocess

import numpy as np

VIEWS = ('front', 'three_quarter', 'side', 'back')
ALIASES = {'front': ('front', 'f', '0'), 'three_quarter': ('three_quarter', '34', 'tq', '3q', 'quarter'),
           'side': ('side', 's', 'profile', '90'), 'back': ('back', 'b', '180')}
EXTS = ('.png', '.jpg', '.jpeg', '.webp')


def model_key(model):
    """hash of the moc3 + textures: the cache key of a model's turnaround views"""
    h = hashlib.sha1()
    moc = os.path.join(model.dir, model.json.get('FileReferences', {}).get('Moc', '')) if hasattr(model, 'json') else ''
    for p in [moc] + list(getattr(model, 'texture_files', [])):
        try:
            with open(p, 'rb') as f:
                h.update(f.read())
        except OSError:
            h.update(str(p).encode())
    return h.hexdigest()[:16]


def _load(path):
    from PIL import Image
    im = Image.open(path).convert('RGBA')
    return np.asarray(im, np.float32) / 255.0


def _find(folder):
    out = {}
    files = [f for f in glob.glob(os.path.join(folder, '*')) if f.lower().endswith(EXTS)]
    for v in VIEWS:
        for f in files:
            stem = os.path.splitext(os.path.basename(f))[0].lower()
            if stem in ALIASES[v]:
                out[v] = f
                break
    if not out:
        sheet = [f for f in files if os.path.splitext(os.path.basename(f))[0].lower() in ('sheet', 'turnaround')]
        if sheet:
            img = _load(sheet[0])
            W = img.shape[1] // 4
            return {v: img[:, i * W:(i + 1) * W] for i, v in enumerate(VIEWS)}
    return {v: _load(p) for v, p in out.items()}


def collect(src, model, out, refs=None, log=print):
    """-> dict view -> RGBA float image (cached per model in <out>/l2d/turnaround/), or {} when unavailable"""
    cache = os.path.join(out, 'l2d', 'turnaround')
    key = model_key(model)
    meta_p = os.path.join(cache, 'views.json')
    if os.path.exists(meta_p):
        try:
            meta = json.load(open(meta_p, encoding='utf-8'))
            if meta.get('key') == key:
                views = _find(cache)
                if views:
                    log(f'turnaround: {len(views)} cached views ({", ".join(views)})')
                    return views
        except (OSError, ValueError):
            pass
    os.makedirs(cache, exist_ok=True)
    if src == 'auto':
        cmd = os.environ.get('VTP_TURNAROUND_GEN')
        if not cmd:
            log('turnaround: no generator configured (VTP_TURNAROUND_GEN) -- skipped, the conversion continues without')
            return {}
        refs = refs or {}
        args = {k: shlex.quote(os.path.abspath(v)) for k, v in refs.items()}
        args['out'] = shlex.quote(os.path.abspath(cache))
        log('turnaround: running the configured generator')
        r = subprocess.run(cmd.format(**{k: args.get(k, '') for k in ('ref', 'refL', 'refR', 'out')}), shell=True)
        if r.returncode != 0:
            log(f'turnaround: generator failed ({r.returncode}) -- skipped')
            return {}
        folder = cache
    else:
        folder = src
    views = _find(folder)
    if not views:
        log(f'turnaround: no front / three_quarter / side / back images in {folder} -- skipped')
        return {}
    if folder != cache:
        from PIL import Image
        for v, img in views.items():
            Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)).save(os.path.join(cache, v + '.png'))
    json.dump({'key': key, 'views': sorted(views)}, open(meta_p, 'w', encoding='utf-8'), indent=1)
    log(f'turnaround: {len(views)} views ({", ".join(sorted(views))}) cached for this model')
    return views


# ------------------------------------------------------------------------------------------------ measuring
def foreground(img):
    """figure mask: alpha if the image has one, else everything not connected to the border background colour"""
    from scipy import ndimage as ndi
    if img.shape[2] == 4 and (img[..., 3] < 0.5).mean() > 0.05:
        return img[..., 3] > 0.5
    rgb = img[..., :3]
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    bg = np.median(border, 0)
    close = np.linalg.norm(rgb - bg, axis=-1) < 0.09
    lab, _ = ndi.label(close)
    edge = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
    mask = ~np.isin(lab, list(edge))
    return ndi.binary_opening(mask, iterations=1)


def _hex(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])


def colour_mask(img, fg, cols, tol=0.16):
    rgb = img[..., :3]
    m = np.zeros(fg.shape, bool)
    for c in cols:
        m |= np.linalg.norm(rgb - c, axis=-1) < tol
    return m & fg


def measure(views, A, log=print):
    """-> dict of hair / garment measurements in IPD units (b up from the eye line); {} without a usable front view"""
    if 'front' not in views:
        return {}
    C = A.colors
    hair_cols = [_hex(C[k]) for k in ('hair', 'hair_root', 'hair_tip', 'hair_shade', 'hair_light') if C.get(k)]
    hair_cols += [_hex(c) for c in C.get('hair_accents', [])[:2]]
    skin = np.asarray(A.skin_rgb, float)
    fr = views['front']
    fg = foreground(fr)
    rows = np.nonzero(fg.any(1))[0]
    if not len(rows):
        return {}
    top = rows.min()
    sk = colour_mask(fr, fg, [skin], 0.12)
    sk_rows = np.nonzero(sk[top:].sum(1) > 3)[0] + top
    lm = getattr(A, 'lm', {})
    ipd = A.ipd
    crown_b = -(lm.get('crown', 0) - lm['eye_y']) / ipd if 'crown' in lm else 2.2
    chin_b = -(lm['face_bbox'][3] - lm['eye_y']) / ipd
    # chin row: the bottom of the first big skin run below the crown (the face; the neck is narrower)
    if not len(sk_rows):
        return {}
    # the face = the first contiguous run of wide skin rows below the crown; its last row is the chin
    widths = sk.sum(1)
    wide = widths > 0.35 * widths[top:top + int(0.6 * fr.shape[0])].max()
    r0 = int(sk_rows.min())
    while r0 < len(wide) and not wide[r0]:
        r0 += 1
    r1 = r0
    while r1 + 1 < len(wide) and (wide[r1 + 1] or (r1 + 2 < len(wide) and wide[r1 + 2])):
        r1 += 1
    chin_row = r1
    px_per_ipd = (chin_row - top) / max(crown_b - chin_b, 1e-3)
    if px_per_ipd <= 1:
        return {}
    b_of = lambda r: crown_b - (r - top) / px_per_ipd
    M = {'px_per_ipd': float(px_per_ipd)}
    for v in ('side', 'back', 'three_quarter'):
        if v not in views:
            continue
        img = views[v]
        f = foreground(img)
        rr = np.nonzero(f.any(1))[0]
        if not len(rr):
            continue
        t = rr.min()                                 # assume one framing: this view's crown row ~ the front's
        hm = colour_mask(img, f, hair_cols)
        # only the hair mass attached to the head (dark trousers / shoes share hair colours): components touching the
        # crown band, and never lower than 6 IPD under the chin
        from scipy import ndimage as ndi
        hm[int(t + (crown_b - chin_b + 6.0) * px_per_ipd):] = False
        lab, n = ndi.label(ndi.binary_closing(hm, iterations=2) & f)
        keep = set(np.unique(lab[t:int(t + 0.6 * px_per_ipd)])) - {0}
        hm = hm & np.isin(lab, list(keep))
        hr = np.nonzero(hm.sum(1) > 2)[0]
        if not len(hr):
            continue
        lowest = hr.max()
        out = {'hair_bottom_b': float(crown_b - (lowest - t) / px_per_ipd)}
        if v == 'side':
            # depth of the head + hair (front of the face to the back of the hair) at the eye-to-crown band
            # nose tip (the most forward skin pixel around the eye line) to the back of the hair above the eyes
            skv = colour_mask(img, f, [skin], 0.12)
            eye_r = int(t + crown_b * px_per_ipd)
            face = skv[max(eye_r - int(0.3 * px_per_ipd), 0):eye_r + int(0.8 * px_per_ipd)]
            band = hm[int(t + 0.2 * px_per_ipd):eye_r]
            fc, hc = np.nonzero(face.any(0))[0], np.nonzero(band.any(0))[0]
            if len(fc) and len(hc):
                face_right = fc.mean() > hc.mean()
                nose = fc.max() if face_right else fc.min()
                back_x = hc.min() if face_right else hc.max()
                out['depth'] = float(abs(nose - back_x) / px_per_ipd)      # nose tip -> back of the hair
                out['hair_depth'] = float((hc.max() - hc.min()) / px_per_ipd)
        if v == 'back':
            # back hair half width per height + tips along the hem
            prof = []
            for r in range(t, lowest, max(1, int(px_per_ipd * 0.15))):
                xs = np.nonzero(hm[r])[0]
                if len(xs):
                    prof.append([float(crown_b - (r - t) / px_per_ipd), float((xs.max() - xs.min()) / 2 / px_per_ipd)])
            out['width_profile'] = prof
            # tips: local maxima of the hair's lowest row per column along the hem
            low = np.array([np.nonzero(hm[:, x])[0].max() if hm[:, x].any() else -1 for x in range(hm.shape[1])])
            ok = low > 0
            if ok.sum() > 10:
                y = np.convolve(low[ok].astype(float), np.ones(5) / 5, 'same')
                peaks = ((y[1:-1] > y[:-2]) & (y[1:-1] >= y[2:]) & (y[1:-1] > np.percentile(y, 60))).sum()
                out['tips'] = int(peaks)
        # hair / garment colours on this side (for the back textures)
        if hm.any():
            px = img[..., :3][hm]
            lum = px @ np.array([0.3, 0.59, 0.11])
            out['hair_median'] = '#%02x%02x%02x' % tuple((np.median(px, 0) * 255).astype(int))
            out['hair_low'] = '#%02x%02x%02x' % tuple((np.median(px[lum <= np.percentile(lum, 25)], 0) * 255).astype(int))
        M[v] = out
    log('turnaround: ' + ', '.join(f'{v}: ' + ', '.join(f'{k} {val:.2f}' for k, val in M[v].items() if isinstance(val, float))
                                   for v in ('side', 'back', 'three_quarter') if v in M))
    return M


def apply_to_frame(frame, M, log=print):
    """hair2d frame += what only the turnaround shows (hair_blender reads the 'tv_*' keys)"""
    if not M:
        return frame
    side, back = M.get('side', {}), M.get('back', {})
    # the back view says how long the BACK is (side / 3-4 views also see the locks hanging in front)
    lows = [back['hair_bottom_b']] if 'hair_bottom_b' in back else ([side['hair_bottom_b']] if 'hair_bottom_b' in side else [])
    if lows and frame.get('style', 'down') == 'down':
        tb = float(np.median(lows))
        frame['tv_back_len_drawn'] = float(frame.get('back_len', tb))
        frame['back_len'] = tb                       # the back length the drawing could only guess
        frame['tv_back_len'] = tb
    if 'hair_depth' in side:
        frame['tv_hair_depth'] = side['hair_depth']
    if 'depth' in side:
        frame['tv_depth'] = side['depth']
    if back.get('width_profile'):
        frame['tv_back_width'] = back['width_profile']
    if back.get('tips'):
        frame['tv_back_tips'] = back['tips']
    log('turnaround -> frame: ' + ', '.join(f'{k} {v:.2f}' if isinstance(v, float) else f'{k} {v}'
                                          for k, v in frame.items() if k.startswith('tv_') and not isinstance(v, list)))
    return frame


# ------------------------------------------------------------------------------------------------ the model's own turns
def turn_profile(model, A, angles=(-30.0, 0.0, 30.0), log=print):
    """The Live2D model's own head turns as a (partial) turnaround: for each ParamAngleX the hair silhouette's left /
    right extent per height band, relative to the eye midpoint of that pose, in front-view IPD units (b up from the
    eye line). At +-30 the far side of the silhouette is the back of the head as the artist drew it -- the one place
    a Live2D model shows how deep the hair mass is behind the skull. hair_blender fits the dome's back volume to it."""
    from .render import render_pose, View
    from .analyze import HAIR
    lm, ipd = A.lm, A.ipd
    fb = lm['face_bbox']
    crown = lm.get('crown', fb[1])
    h = fb[3] - crown
    crop = (A.mid_x - 1.6 * h, crown - 0.25 * h, A.mid_x + 1.6 * h, fb[3] + 0.4 * h)
    view = View(model.moc.canvas, 700, crop)
    hair = {a for a in range(len(A.cls)) if A.cls[a] in HAIR}
    iris = [a for a in range(len(A.cls)) if A.cls[a] == 'iris']
    pid = model.param_id('ParamAngleX', 'PARAM_ANGLE_X')
    bid = model.param_id('ParamBodyAngleX', 'PARAM_BODY_ANGLE_X')
    if pid is None or not hair:
        return {}
    out = {}
    for ang in angles:
        prm = {pid: ang}
        if bid:
            prm[bid] = 0.0
        pose = model.pose(prm)
        img, _ = render_pose(model, pose, view=view, ss=1, only=hair)
        mask = img[..., 3] > 0.5
        if iris:
            P = np.concatenate([pose.positions[a] for a in iris])
            ex, ey = float(P[:, 0].mean()), float(P[:, 1].mean())
        else:
            ex, ey = A.mid_x, lm['eye_y']
        bands = []
        for b in np.arange(0.0, 3.2, 0.2):
            y = ey - b * ipd
            r = int(round(view.px([[0, y]])[0, 1]))
            if r < 0 or r >= mask.shape[0]:
                continue
            xs = np.nonzero(mask[r])[0]
            if len(xs) < 2:
                continue
            x0, x1 = view.model([[xs.min(), r], [xs.max() + 1, r]])[:, 0]
            bands.append([round(float(b), 2), round(float((x0 - ex) / ipd), 3), round(float((x1 - ex) / ipd), 3)])
        out[str(int(ang))] = {'shift': round(float((ex - A.mid_x) / ipd), 3), 'bands': bands}
    if out:
        log('turns: ' + ', '.join(f"{k}: eye shift {v['shift']:+.2f}, {len(v['bands'])} bands" for k, v in out.items()))
    return out
