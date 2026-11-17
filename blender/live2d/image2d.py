"""Image-only input route: a single front drawing of a character (no Live2D model) -> the same analysis the Live2D
route produces (landmarks, colours, outfit, hair locks), so the same generators (face_kit base, eye / garment / hair
builders) run on it.

    tools/live2d_to_3d.py path/to/front.png <out> --image [--sex male|female]

Segmentation is automatic and colour / shape based (numpy + OpenCV, no downloads, no AI services):
  figure    GrabCut from a central rectangle (busy backgrounds are common in stream screenshots)
  eyes      the best PAIR of compact, saturated iris blobs (similar size, level, a plausible spacing), preferring
            the pair with a pale face below it (masks / hats with eyes of their own sit above the real face)
  face      the region of the skin colour (sampled under the eyes) connected to the cheeks; chin = its lowest point
  hair      the figure above / beside the face that is not face, clustered to the hair colours
  garments  the figure below the chin, clustered; a saturated collar-area colour unlike the top = collar / fur trim
Everything is expressed like the Live2D analysis: model units = image pixels (y down), IPD = iris distance.
The drawing's own colours are sampled; nothing is projected onto the face (the face stays drawn by face_kit).
"""
import os

import numpy as np
from PIL import Image
from scipy import ndimage as ndi


class ImgView:
    """image pixels (model units, y down) <-> view pixels (scaled so one IPD = PX pixels, like hair2d's views)"""

    def __init__(self, crop, scale):
        self.crop = crop
        self.scale = float(scale)
        x0, y0, x1, y1 = crop
        self.W = int(round((x1 - x0) * self.scale)); self.H = int(round((y1 - y0) * self.scale))

    def px(self, xy):
        xy = np.asarray(xy, np.float64)
        return np.stack([(xy[..., 0] - self.crop[0]) * self.scale, (xy[..., 1] - self.crop[1]) * self.scale], -1)

    def model(self, pxy):
        pxy = np.asarray(pxy, np.float64)
        return np.stack([pxy[..., 0] / self.scale + self.crop[0], pxy[..., 1] / self.scale + self.crop[1]], -1)


def _hex(c):
    if not np.all(np.isfinite(np.asarray(c[:3], float))):   # an empty sample (a flat or unusual drawing): say so, not a NaN crash
        raise ValueError('PICTURE_UNREADABLE a colour (skin, eyes or hair) could not be found in the picture')
    return '#%02x%02x%02x' % tuple(int(np.clip(v, 0, 1) * 255) for v in c[:3])


def _lum(px):
    return np.asarray(px)[..., :3] @ np.array([0.3, 0.59, 0.11])


def _hsv(img):
    import cv2
    h = cv2.cvtColor((np.clip(img, 0, 1) * 255).astype(np.uint8), cv2.COLOR_RGB2HSV).astype(np.float32)
    return h[..., 0] * 2.0, h[..., 1] / 255.0, h[..., 2] / 255.0


def _kmeans(px, k, seed=0, iters=15):
    px = np.asarray(px, float)[:: max(1, len(px) // 40000)]
    rng = np.random.default_rng(seed)
    cent = px[rng.choice(len(px), min(k, len(px)), replace=False)].copy()
    for _ in range(iters):
        lab = ((px[:, None] - cent[None]) ** 2).sum(-1).argmin(1)
        for j in range(len(cent)):
            if (lab == j).any():
                cent[j] = np.median(px[lab == j], 0)
    cnt = np.bincount(lab, minlength=len(cent)) / len(px)
    o = np.argsort(-cnt)
    return cent[o], cnt[o]


def figure_mask(img):
    import cv2
    H, W = img.shape[:2]
    u8 = (np.clip(img, 0, 1) * 255).astype(np.uint8)[..., ::-1].copy()
    mask = np.zeros((H, W), np.uint8)
    rect = (int(0.04 * W), int(0.02 * H), int(0.92 * W), int(0.96 * H))
    bg, fg = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
    try:
        cv2.grabCut(u8, mask, rect, bg, fg, 5, cv2.GC_INIT_WITH_RECT)
        m = (mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD)
    except Exception:
        m = np.ones((H, W), bool)
    m = ndi.binary_opening(m, iterations=2)
    lab, n = ndi.label(m)
    if n > 1:
        sizes = ndi.sum(m, lab, range(1, n + 1))
        m = lab == (int(np.argmax(sizes)) + 1)
    return ndi.binary_fill_holes(m)


def _blobs(lab, h, area_img):
    blobs = []
    for i, sl in enumerate(ndi.find_objects(lab), 1):
        if sl is None:
            continue
        mm = lab[sl] == i
        a = int(mm.sum())
        if a < 2e-4 * area_img or a > 1.5e-2 * area_img:
            continue
        hh, ww = mm.shape
        if max(hh, ww) > 3.0 * min(hh, ww):
            continue
        if a / float(hh * ww) < 0.35:
            continue
        ys, xs = np.nonzero(mm)
        cy, cx = ys.mean() + sl[0].start, xs.mean() + sl[1].start
        hue = float(np.median(h[sl][mm]))
        blobs.append(dict(c=(cx, cy), a=a, hue=hue, fill=a / float(hh * ww),
                          box=(sl[1].start, sl[0].start, sl[1].stop, sl[0].stop)))
    return blobs


def teeth_from_drawing(A, log=print):
    """teeth drawn in a (reference) drawing's open mouth: the mouth cavity (a red / dark-red region in the lower face)
    and the white shapes along its edges -> 'shark' when a row just inside the cavity's top or bottom edge crosses
    3+ separate white shapes (a row of pointed teeth), 'flat' for one white band, None without an open mouth"""
    img, lm, ipd = A.image, A.lm, A.ipd
    H, W = img.shape[:2]
    ex, ey = lm['chin'][0], lm['eye_y']
    x0, x1 = int(max(0, ex - 1.0 * ipd)), int(min(W, ex + 1.0 * ipd))
    y0, y1 = int(max(0, ey + 0.5 * ipd)), int(min(H, ey + 2.0 * ipd))
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    c = img[y0:y1, x0:x1]
    lum = c.mean(-1); sat = c.max(-1) - c.min(-1)
    cav = (c[..., 0] > c[..., 1] + 0.12) & (lum < 0.78) & (sat > 0.18)
    # inside the face: its skin region closed and hole-filled (the open mouth is a hole in the skin)
    fm = getattr(A, 'face_mask', None)
    if fm is not None:
        ff = ndi.binary_fill_holes(ndi.binary_closing(fm, iterations=4))[y0:y1, x0:x1]
        cav &= ndi.binary_erosion(ff, iterations=2)
    cav = ndi.binary_opening(cav, iterations=1)
    lab, n = ndi.label(ndi.binary_closing(cav, iterations=3))
    if n == 0:
        return None
    sizes = ndi.sum(np.ones_like(lab), lab, range(1, n + 1))
    k = int(np.argmax(sizes)) + 1
    if sizes[k - 1] < 0.02 * ipd * ipd:
        return None
    ys, xs = np.nonzero(lab == k)
    by0, by1, bx0, bx1 = ys.min(), ys.max(), xs.min(), xs.max()
    white = (lum > 0.8) & (sat < 0.25)
    box = np.zeros_like(white); box[by0:by1 + 1, bx0:bx1 + 1] = True
    white &= ndi.binary_dilation(lab == k, iterations=3) & box
    if white.sum() < 10:
        return {'teeth': None, 'open': float((by1 - by0) / max(bx1 - bx0, 1))}
    runs = 0
    hgt = by1 - by0 + 1
    for yy in list(range(by0, by0 + max(1, int(0.35 * hgt)))) + list(range(by1 - max(1, int(0.35 * hgt)), by1 + 1)):
        _, nr = ndi.label(white[yy, bx0:bx1 + 1])
        runs = max(runs, nr)
    style = 'shark' if runs >= 3 else 'flat'
    log(f'image: open mouth with {style} teeth ({runs} tooth shapes in a row), opening {hgt / max(bx1 - bx0, 1):.2f}')
    return {'teeth': style, 'open': float(hgt / max(bx1 - bx0, 1))}


def accessory_silhouette(img, mx2, my2, d2, tol=0.17):
    """the drawn outline of a head accessory that has its own pair of eyes (a mask worn on the head): its plate
    colour (sampled between / under its eyes) grown as one connected region, closed over the ink marks drawn on it;
    the cranium above the jaw line is convex (hull), the jaw below keeps its gaps (teeth). -> (mask, box) or None"""
    import cv2
    H, W = img.shape[:2]
    x0, x1 = int(max(0, mx2 - 1.5 * d2)), int(min(W, mx2 + 1.5 * d2))
    y0, y1 = int(max(0, my2 - 1.4 * d2)), int(min(H, my2 + 1.8 * d2))
    c = img[y0:y1, x0:x1]
    sx, sy = int(mx2 - x0), int(my2 + 0.45 * d2 - y0)
    if not (0 <= sx < c.shape[1] and 0 <= sy < c.shape[0]):
        return None
    patch = c[max(0, sy - 6):sy + 7, max(0, sx - 6):sx + 7].reshape(-1, 3)
    lum = patch.mean(1)
    base = np.median(patch[lum >= np.percentile(lum, 40)], 0)
    lab, n = ndi.label(np.linalg.norm(c - base, axis=-1) < tol)
    if lab[sy, sx] == 0:
        return None
    m = ndi.binary_closing(lab == lab[sy, sx], iterations=6)
    m = ndi.binary_opening(ndi.binary_fill_holes(m), iterations=4)
    lab, n = ndi.label(m)
    if lab[sy, sx] == 0:
        return None
    m = lab == lab[sy, sx]
    rows = np.arange(m.shape[0])[:, None]
    jaw_y = my2 + 0.6 * d2 - y0
    ys_, xs_ = np.nonzero(m & (rows < jaw_y + 0.1 * d2))
    if len(xs_) < 50:
        return None
    hull = cv2.convexHull(np.stack([xs_, ys_], 1).astype(np.int32))
    big = np.zeros(m.shape, np.uint8)
    cv2.fillPoly(big, [hull[:, 0, :]], 1)
    m = np.where(rows < jaw_y, big.astype(bool), m)
    m = ndi.binary_dilation(m, iterations=3)             # its ink outline
    if m.sum() < 0.5 * d2 * d2:                          # too small to be a worn mask
        return None
    return m, (x0, y0, x1, y1)


def find_eyes(img, fig):
    """the iris pair: compact saturated blobs, similar, level; prefer a pale face below"""
    import cv2
    H, W = img.shape[:2]
    h, s, v = _hsv(img)
    blobs = []
    area_img = H * W
    # several thresholds: saturated hair / ink of the same hue would otherwise swallow the irises
    for st, vt in ((0.4, 0.35), (0.4, 0.6), (0.4, 0.8), (0.5, 0.9), (0.3, 0.95)):
        cand = (s > st) & (v > vt) & fig
        lab, n = ndi.label(ndi.binary_opening(cand, iterations=1))
        blobs += _blobs(lab, h, area_img)
    # (the same iris found at several thresholds stays in the list: its variants can't pair with each other --
    # too close -- and the best-matching variant wins the pairing)
    best = None
    pairs = []
    for i in range(len(blobs)):
        for j in range(i + 1, len(blobs)):
            b1, b2 = blobs[i], blobs[j]
            d = np.hypot(b1['c'][0] - b2['c'][0], b1['c'][1] - b2['c'][1])
            if not (0.05 * W < d < 0.45 * W):
                continue
            if abs(b1['c'][1] - b2['c'][1]) > 0.3 * d:
                continue
            ra = max(b1['a'], b2['a']) / min(b1['a'], b2['a'])
            if ra > 2.5:
                continue
            dh = min(abs(b1['hue'] - b2['hue']), 360 - abs(b1['hue'] - b2['hue']))
            if dh > 40:
                continue
            mx, my = (b1['c'][0] + b2['c'][0]) / 2, (b1['c'][1] + b2['c'][1]) / 2
            # a pale, low-saturation area below the pair (cheeks / nose) = a face
            y0, y1 = int(my + 0.5 * d), int(min(H, my + 1.1 * d))
            x0, x1 = int(max(0, mx - 0.35 * d)), int(min(W, mx + 0.35 * d))
            reg = img[y0:y1, x0:x1]
            pale = float(((_lum(reg) > 0.55) & (reg.max(-1) - reg.min(-1) < 0.35)).mean()) if reg.size else 0.0
            score = (b1['a'] + b2['a']) / area_img * 100 + 2.0 * pale + 0.5 * my / H - 0.3 * (ra - 1)
            pairs.append((score, b1, b2, d))
            if best is None or score > best[0]:
                best = (score, b1, b2, d)
    if best is None:
        raise RuntimeError('image route: no eye pair found (compact coloured irises)')
    _, b1, b2, d = best
    L, R = sorted([b1, b2], key=lambda b: b['c'][0])
    # a second pair ABOVE the face (a mask / ornament with eyes of its own worn on the head)
    my = (b1['c'][1] + b2['c'][1]) / 2
    second = None
    near = lambda c, b: np.hypot(c['c'][0] - b['c'][0], c['c'][1] - b['c'][1]) < 0.3 * d
    for sc_, c1, c2, d2 in pairs:
        if any(near(c, b) for c in (c1, c2) for b in (b1, b2)) or not (0.5 * d < d2 < 1.5 * d):
            continue
        m2 = (c1['c'][1] + c2['c'][1]) / 2
        if m2 < my - 0.8 * d and abs((c1['c'][0] + c2['c'][0]) / 2 - (b1['c'][0] + b2['c'][0]) / 2) < 2.5 * d:
            if second is None or sc_ > second[0]:
                second = (sc_, c1, c2, d2)
    find_eyes.second = second
    return L, R, d


def analyze_image(path, log=print):
    """-> an object with the attributes the pipeline reads from a Live2D analysis (A.lm, A.colors, A.outfit, ...)"""
    img = np.asarray(Image.open(path).convert('RGB'), np.float32) / 255.0
    H, W = img.shape[:2]

    class A_:
        pass
    A = A_()
    A.model = None; A.pose = None; A.image = img; A.image_path = path
    fig = figure_mask(img)
    eL, eR, ipd = find_eyes(img, fig)
    A.ipd = float(ipd)
    ex = (eL['c'][0] + eR['c'][0]) / 2; ey = (eL['c'][1] + eR['c'][1]) / 2
    A.mid_x = float(ex)
    # skin: under the eyes (nose / cheek band), light pixels
    y0, y1 = int(ey + 0.55 * ipd), int(ey + 0.95 * ipd)
    x0, x1 = int(ex - 0.45 * ipd), int(ex + 0.45 * ipd)
    reg = img[max(0, y0):max(0, y1), max(0, x0):max(0, x1)].reshape(-1, 3)
    if len(reg) < 4:   # the eyes found are not a face's (an empty cheek band): say so instead of a NaN skin colour
        raise ValueError('NO_FACE no face found in the picture (eyes with skin under them)')
    reg = reg[_lum(reg) > np.percentile(_lum(reg), 40)]
    skin = np.median(reg, 0)
    A.skin_rgb = skin
    dsk = np.linalg.norm(img - skin, axis=-1)
    face = (dsk < 0.16) & fig
    seed = (int(ey + 0.75 * ipd), int(ex))
    lab, _ = ndi.label(face)
    face = lab == lab[seed] if lab[seed] else face
    # limit to a plausible face box
    yy, xx = np.mgrid[0:H, 0:W]
    face &= (np.abs(xx - ex) < 1.4 * ipd) & (yy > ey - 0.6 * ipd) & (yy < ey + 2.4 * ipd)
    face = ndi.binary_closing(face, iterations=3)
    col = face[:, int(ex - 0.25 * ipd):int(ex + 0.25 * ipd)].any(1)
    rows = np.nonzero(col)[0]
    chin = float(rows.max()) if len(rows) else ey + 1.4 * ipd
    fx = np.nonzero(face[int(ey):int(ey + 0.5 * ipd)].any(0))[0]
    fxl, fxr = (fx.min(), fx.max()) if len(fx) else (ex - 1.1 * ipd, ex + 1.1 * ipd)
    # hair: figure above the chin that isn't face, near the head
    head = fig & (yy < chin + 0.2 * ipd) & (np.abs(xx - ex) < 2.6 * ipd) & (yy > ey - 4.5 * ipd)
    hair_seed = head & (yy < ey - 0.6 * ipd) & ~face
    hp = img[hair_seed]
    if len(hp) < 50:
        raise RuntimeError('image route: no hair above the eyes')
    hc, hn = _kmeans(hp, 4)
    hcols = [hc[j] for j in range(len(hc)) if hn[j] > 0.12]
    dh = np.min(np.stack([np.linalg.norm(img - c, axis=-1) for c in hcols]), 0)
    hair = head & ~face & (dh < 0.22)
    hair = ndi.binary_opening(hair, iterations=1)
    lab, n = ndi.label(hair)
    if n > 1:
        keep = set(np.unique(lab[hair_seed & hair])) - {0}
        hair = np.isin(lab, list(keep))
    # eyes / lash / iris colours
    def blob_px(b):
        bx0, by0, bx1, by1 = b['box']
        return img[by0:by1, bx0:bx1].reshape(-1, 3)
    ip = np.concatenate([blob_px(eL), blob_px(eR)])
    ip = ip[(ip.max(1) - ip.min(1)) > 0.25]
    il = _lum(ip)
    iris = {'mid': _hex(np.median(ip, 0)), 'top': _hex(np.median(ip[il <= np.percentile(il, 30)], 0)),
            'bottom': _hex(np.median(ip[il >= np.percentile(il, 70)], 0)),
            'light': _hex(np.median(ip[il >= np.percentile(il, 90)], 0)),
            'dark': _hex(np.median(ip[il <= np.percentile(il, 10)], 0))}
    # the eye white: an annulus just outside each iris (a drawn dark socket makes it dark -- kept as drawn)
    ann = []
    for b in (eL, eR):
        bx0, by0, bx1, by1 = b['box']; r0 = max(bx1 - bx0, by1 - by0) / 2
        cy_, cx_ = b['c'][1], b['c'][0]
        dd = np.hypot(yy - cy_, xx - cx_)
        ann.append(img[(dd > 1.15 * r0) & (dd < 1.5 * r0) & (np.abs(yy - cy_) < 0.8 * r0)])
    ann = np.concatenate(ann)
    sclera = np.median(ann, 0) if len(ann) > 20 else np.array([0.97, 0.97, 0.98])
    # around-eye darks (lash / socket)
    ring = img[int(ey - 0.4 * ipd):int(ey + 0.3 * ipd), int(ex - 1.0 * ipd):int(ex + 1.0 * ipd)].reshape(-1, 3)
    lash = np.median(ring[_lum(ring) < np.percentile(_lum(ring), 10)], 0)
    hl = _lum(img[hair])
    hpx = img[hair]
    hair_c = np.median(hpx[(hl > np.percentile(hl, 45)) & (hl < np.percentile(hl, 90))], 0)
    sat_ = hpx.max(1) - hpx.min(1)
    inkp = hpx[(hl < np.percentile(hl, 15)) & (sat_ > np.percentile(sat_, 50))]
    hair_ink = np.median(inkp, 0) if len(inkp) > 20 else None
    colors = {'hair': _hex(hair_c), 'hair_root': _hex(np.median(hpx[hl < np.percentile(hl, 35)], 0)),
              'hair_tip': _hex(hair_c), 'hair_shade': _hex(np.median(hpx[hl < np.percentile(hl, 20)], 0)),
              'hair_light': _hex(np.median(hpx[hl > np.percentile(hl, 85)], 0)), 'hair_accents': [],
              'iris_L': iris, 'iris_R': iris, 'skin': _hex(skin), 'lash': _hex(lash),
              'sclera': _hex(sclera) if _lum(sclera) < 0.35 else '#f8f8fa',
              'brow': _hex(np.median(hpx[hl < np.percentile(hl, 10)], 0))}
    if hair_ink is not None:
        colors['hair_ink'] = _hex(hair_ink)
    # garments below the chin: a central box (portrait crops cut the background there; GrabCut often drops the
    # outer clothes when they match a busy background)
    box = (yy > chin + 0.15 * ipd) & (np.abs(xx - ex) < 2.6 * ipd) & ~hair & ~face
    gp = img[box]
    outfit = {'full_body': False}
    garment_mask = np.zeros_like(box)
    if len(gp) > 500:
        gc, gn = _kmeans(gp, 6)
        keep = [j_ for j_ in range(len(gc)) if gn[j_] > 0.05 and np.linalg.norm(gc[j_] - skin) > 0.15]
        dmin = np.min(np.stack([np.linalg.norm(img - gc[j_], axis=-1) for j_ in keep]), 0)
        garment_mask = box & (dmin < 0.2)
        # the outer layer shows on BOTH sides of the body (a background colour usually only on one); the inner layer
        # fills the middle between them
        K = [gc[j_] for j_ in keep]
        labimg = np.full(box.shape, -1)
        bi = np.nonzero(box)
        labimg[bi] = np.argmin(np.stack([np.linalg.norm(img[bi] - c, axis=-1) for c in K]), 0)
        labimg[~garment_mask] = -1
        def cnt(sel, k):
            return int((labimg[sel] == k).sum())
        Lsel = box & (xx < ex - 1.0 * ipd); Rsel = box & (xx > ex + 1.0 * ipd)
        both = [min(cnt(Lsel, k), cnt(Rsel, k)) for k in range(len(K))]
        ti = int(np.argmax(both)); top = K[ti]
        cband = box & (np.abs(xx - ex) < 0.8 * ipd) & (yy > chin + 0.6 * ipd)
        mids = [cnt(cband, k) if k != ti else -1 for k in range(len(K))]
        inner = K[int(np.argmax(mids))]
        outer = [top]
        # the inner layer's drawn area (a patterned shirt: swirls, print, stripes): its box in the centre band, the
        # garment painter mirror-tiles it over the base top's under-layer instead of one flat colour
        ib = cband & (labimg >= 0) & (labimg != ti)
        ib &= np.linalg.norm(img - skin, axis=-1) > 0.15
        iy, ix = np.nonzero(ib)
        A.inner_box = None
        A.inner_base = None
        if len(ix) > 400:
            x0_, x1_ = np.percentile(ix, [8, 92]); y0_, y1_ = np.percentile(iy, [8, 92])
            if x1_ - x0_ > 0.3 * ipd and y1_ - y0_ > 0.3 * ipd:
                A.inner_box = (float(x0_), float(y0_), float(x1_), float(y1_))
                labs_ = labimg[ib]
                cnt_ = np.bincount(labs_[labs_ >= 0], minlength=len(K)).astype(float)
                big_ = [k_ for k_ in range(len(K)) if cnt_[k_] > 0.2 * cnt_.sum()] or [int(cnt_.argmax())]
                # its ground colour: the darkest of its main colours (a print sits on a ground)
                A.inner_base = _hex(K[min(big_, key=lambda k_: float(np.mean(K[k_])))])
                log(f'image garments: inner layer drawn in box x {x0_:.0f}-{x1_:.0f}, y {y0_:.0f}-{y1_:.0f}')
        # a collar / fur trim: a saturated cluster sitting on the shoulders just under the chin, unlike the top
        sh_px = img[box & (yy < chin + 1.2 * ipd) & (np.abs(xx - ex) > 0.7 * ipd)]
        trim = None
        if len(sh_px) > 50:
            tc, tn = _kmeans(sh_px, 4, seed=1)
            for j_ in range(len(tc)):
                c = tc[j_]
                if tn[j_] > 0.2 and (c.max() - c.min()) > 0.3 and np.linalg.norm(c - top) > 0.3 and np.linalg.norm(c - inner) > 0.3:
                    trim = c; break
        log('image garments: clusters ' + ', '.join(f'{_hex(gc[j_])} {gn[j_]:.2f}' for j_ in keep) +
            f'; inner {_hex(inner)}; outer candidates ' + ', '.join(_hex(c) for c in outer))
        outfit['top'] = {'colors': [_hex(top)], 'inner': [_hex(inner)]}
        if trim is not None:
            outfit['trim'] = {'colors': [_hex(trim)]}
        outfit['bottom'] = {'kind': 'pants', 'colors': ['#2a2d3a']}
        outfit['sleeves'] = 'long'; outfit['sleeve_colors'] = [_hex(top)]
    colors['outfit_top'] = outfit.get('top', {}).get('colors', [None])[0]
    A.colors = colors
    A.outfit = outfit
    A.hair_mask = hair; A.face_mask = face; A.fig = fig; A.garment_mask = garment_mask
    hy, hx = np.nonzero(hair)
    hb = [float(hx.min()), float(hy.min()), float(hx.max()), float(hy.max())] if len(hx) else [fxl, ey - 2 * ipd, fxr, ey]
    crown = float(min(hb[1], ey - 1.8 * ipd))
    def eye_d(b):
        bx0, by0, bx1, by1 = b['box']
        w = bx1 - bx0; h = by1 - by0
        return dict(bbox=[bx0 - 0.4 * w, by0 - 0.15 * h, bx1 + 0.4 * w, by1 + 0.1 * h], center=list(b['c']),
                    iris_bbox=[bx0, by0, bx1, by1], width=float(w * 1.8), height=float(h * 1.15))
    lm = {'face_bbox': [float(fxl), float(crown), float(fxr), float(chin)], 'eye_L': eye_d(eL), 'eye_R': eye_d(eR),
          'eye_y': float(ey), 'crown': crown, 'hair_bbox': hb, 'chin': [float(ex), float(chin)],
          'mouth': {'bbox': [ex - 0.25 * ipd, ey + 1.05 * ipd, ex + 0.25 * ipd, ey + 1.2 * ipd],
                    'center': [ex, ey + 1.12 * ipd]},
          'figure_bbox': [0.0, crown, float(W), float(crown + 7.5 * (chin - crown))],   # a bust drawing: 7.5 heads
          'face_width': {}}
    for key, t in (('eye', 0.0), ('mid', 0.5), ('low', 0.8)):
        r = int(ey + t * (chin - ey))
        xs = np.nonzero(face[r])[0]
        if len(xs):
            lm['face_width'][key] = float(xs.max() - xs.min())
    A.lm = lm
    # head accessory with its own eyes (image2d.find_eyes.second): an oval decal around them
    A.head_acc = None
    sec = getattr(find_eyes, 'second', None)
    if sec is not None:
        _, c1, c2, d2 = sec
        mx2 = (c1['c'][0] + c2['c'][0]) / 2; my2 = (c1['c'][1] + c2['c'][1]) / 2
        ccx, ccy = mx2, my2 + 0.25 * d2
        ax, ay = 0.85 * d2, 0.95 * d2
        x0, y0, x1, y1 = int(ccx - ax), int(ccy - ay), int(ccx + ax), int(ccy + ay)
        sil = accessory_silhouette(img, mx2, my2, d2)
        if sil is not None:
            # the accessory's own drawn outline (its plate colour grown from between its eyes, ink bounded; the
            # cranium convex above the jaw, the jaw keeping its gaps between the teeth)
            sm, (x0, y0, x1, y1) = sil
            ys_, xs_ = np.nonzero(sm)
            bx0, bx1, by0, by1 = xs_.min(), xs_.max() + 1, ys_.min(), ys_.max() + 1
            crop = img[y0 + by0:y0 + by1, x0 + bx0:x0 + bx1]
            alpha = sm[by0:by1, bx0:bx1].astype(np.float32)
            ccx, ccy = x0 + (bx0 + bx1) / 2, y0 + (by0 + by1) / 2
            A.head_acc = {'cx': (ccx - ex) / ipd, 'cy': (ey - ccy) / ipd, 'ax': (bx1 - bx0) / 2 / ipd,
                          'ay': (by1 - by0) / 2 / ipd, 'rgba': np.concatenate([crop, alpha[..., None]], -1),
                          'solid': True}
            hm_ = A.hair_mask.copy(); hm_[y0:y1, x0:x1] &= ~sm; A.hair_mask = hm_
            am_ = np.zeros(A.hair_mask.shape, bool); am_[y0:y1, x0:x1] = sm; A.acc_mask = am_
            log(f'image: head accessory with its own eyes: drawn outline {bx1 - bx0} x {by1 - by0} px at '
                f'({ccx:.0f},{ccy:.0f}) -> an inflated solid')
        elif x0 >= 0 and y0 >= 0 and x1 <= W and y1 <= H:
            crop = img[y0:y1, x0:x1]
            gy, gx = np.mgrid[0:y1 - y0, 0:x1 - x0]
            ell = ((gx - (x1 - x0) / 2) / ax) ** 2 + ((gy - (y1 - y0) / 2) / ay) ** 2 <= 1.0
            alpha = (ell & fig[y0:y1, x0:x1]).astype(np.float32)
            A.head_acc = {'cx': (ccx - ex) / ipd, 'cy': (ey - ccy) / ipd, 'ax': ax / ipd, 'ay': ay / ipd,
                          'rgba': np.concatenate([crop, alpha[..., None]], -1)}
            hm_ = A.hair_mask.copy(); hm_[y0:y1, x0:x1] &= ~ell; A.hair_mask = hm_
            log(f'image: head accessory with its own eyes at ({ccx:.0f},{ccy:.0f}), {2 * ax:.0f} x {2 * ay:.0f} px')
    # a neck band (choker / collar strap): a run of dark rows across the neck column between the chin and the
    # shoulders, with skin above it
    A.choker = None
    # the neck's own column: the skin just under the chin (a tilted head puts it off the eyes' mid line)
    nz = (yy > chin + 0.03 * ipd) & (yy < chin + 0.3 * ipd) & (np.abs(xx - ex) < 1.2 * ipd) &         (np.linalg.norm(img - skin, axis=-1) < 0.15)
    nx = float(np.median(xx[nz])) if nz.sum() > 50 else float(ex)
    col = (np.abs(xx - nx) < 0.3 * ipd) & fig
    lum_ = img.mean(-1)
    rows_ = np.arange(int(chin + 0.05 * ipd), int(min(H - 1, chin + 1.0 * ipd)))
    # band pixels: dark strap, or a light metal buckle / studs on it (light, grey, not the skin tone)
    sat_ = img.max(-1) - img.min(-1)
    bandpx = (lum_ < 0.22) | ((lum_ > 0.7) & (sat_ < 0.12) & (np.linalg.norm(img - skin, axis=-1) > 0.12))
    dark = np.array([(bandpx[r] & col[r]).sum() / max(col[r].sum(), 1) for r in rows_]) if len(rows_) else np.zeros(0)
    gap = max(3, int(0.12 * ipd))
    run = []
    for i_, (r, dk) in enumerate(zip(rows_, dark)):
        # a strap row, or a buckle / stud row bridged across it (a strap row follows within `gap`)
        if dk > 0.6 or (run and dk > 0.3 and (dark[i_ + 1:i_ + 1 + gap] > 0.6).any()):
            run.append(r)
        elif run:
            break
    if run and 0.08 * ipd <= len(run) <= 0.65 * ipd:
        y0c, y1c = run[0], run[-1] + 1
        skinabove = np.linalg.norm(img[max(0, y0c - int(0.2 * ipd)):y0c][col[max(0, y0c - int(0.2 * ipd)):y0c]] - skin, axis=-1)
        if len(skinabove) and float(np.median(skinabove)) < 0.25:
            xc0, xc1 = int(max(0, nx - 0.6 * ipd)), int(min(W, nx + 0.6 * ipd))
            band = img[y0c:y1c, xc0:xc1]
            dk_ = band[lum_[y0c:y1c, xc0:xc1] < 0.22]
            A.choker = {'y0': float(y0c), 'y1': float(y1c), 'x0': float(xc0), 'x1': float(xc1),
                        'color': _hex(np.median(dk_, 0)) if len(dk_) else '#15151a', 'rgb': band}
            log(f'image: neck band (choker) rows {y0c}-{y1c} ({(y1c - y0c) / ipd:.2f} IPD), {A.choker["color"]}')
    A.front = np.concatenate([img, fig[..., None].astype(np.float32)], -1)
    # what garment.paint / Register read (the image is its own 'view' at scale 1; one pseudo drawable 'top')
    A.view = ImgView((0.0, 0.0, float(W), float(H)), 1.0)
    A.ids = np.where(garment_mask, 0, -1).astype(np.int32)
    A.cls = ['top']; A.side = ['']; A.names = []; A.area = [float(garment_mask.sum())]
    A.trim_art = np.concatenate([img, garment_mask[..., None].astype(np.float32)], -1)
    gm = garment_mask.copy()
    if outfit.get('trim'):                            # the trim (fur / collar) is generated, not painted on the top
        tcol = np.array([int(outfit['trim']['colors'][0][i:i + 2], 16) / 255 for i in (1, 3, 5)])
        gm &= np.linalg.norm(img - tcol, axis=-1) > 0.3
        A.ids = np.where(gm, 0, -1).astype(np.int32)
    A.garment_art = np.concatenate([img, gm[..., None].astype(np.float32)], -1)
    log(f'image: eyes at ({eL["c"][0]:.0f},{eL["c"][1]:.0f}) / ({eR["c"][0]:.0f},{eR["c"][1]:.0f}), ipd {ipd:.0f} px, '
        f'chin y {chin:.0f}, hair {int(hair.sum())} px, skin {_hex(skin)}, hair {colors["hair"]}, iris {iris["mid"]}, '
        f'top {outfit.get("top", {}).get("colors")}')
    return A


def debug_sheet(A, path):
    img = A.image.copy()
    over = img.copy()
    over[A.hair_mask] = over[A.hair_mask] * 0.4 + np.array([0.2, 0.9, 0.2]) * 0.6
    over[A.face_mask] = over[A.face_mask] * 0.4 + np.array([1.0, 0.6, 0.2]) * 0.6
    gm = A.garment_mask & ~A.hair_mask
    over[gm] = over[gm] * 0.5 + np.array([0.2, 0.4, 1.0]) * 0.5
    over[~A.fig] *= 0.25
    for k in ('eye_L', 'eye_R'):
        x0, y0, x1, y1 = [int(v) for v in A.lm[k]['iris_bbox']]
        over[y0:y1, x0:x0 + 2] = over[y0:y1, x1 - 2:x1] = [1, 0, 1]
        over[y0:y0 + 2, x0:x1] = over[y1 - 2:y1, x0:x1] = [1, 0, 1]
    c = int(A.lm['chin'][1])
    over[max(c - 1, 0):c + 2] = [1, 1, 0]
    Image.fromarray((np.clip(np.concatenate([img, over], 1), 0, 1) * 255).astype(np.uint8)).save(path)


# ------------------------------------------------------------------------------------------------ hair locks
def extract_hair(A, log=print):
    """locks.json content for the image route: the drawn hair region split into a fringe (over the face width) and
    side masses, each traced like a Live2D hair drawable (hair2d.mask_locks: lower-edge tips, strand direction field);
    no depth from the drawing (layer defaults); silhouette + fringe line + outline flicks as in hair2d.extract"""
    from . import hair2d
    PX = hair2d.PX
    ipd = A.ipd
    img = A.image
    lm = A.lm
    ex, ey = A.mid_x, lm['eye_y']
    fb = lm['face_bbox']
    chin = fb[3]
    hb = lm['hair_bbox']
    crop = (ex - 6 * ipd, hb[1] - 0.3 * ipd, ex + 6 * ipd, max(hb[3], chin) + 0.3 * ipd)
    view = ImgView(crop, PX / ipd)
    import cv2
    x0, y0, x1, y1 = [int(round(v)) for v in crop]
    H, W = img.shape[:2]
    canvas = np.zeros((y1 - y0, x1 - x0, 4), np.float32)
    sx0, sy0, sx1, sy1 = max(x0, 0), max(y0, 0), min(x1, W), min(y1, H)
    canvas[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0, :3] = img[sy0:sy1, sx0:sx1]
    canvas[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0, 3] = A.hair_mask[sy0:sy1, sx0:sx1]
    rgba = cv2.resize(canvas, (view.W, view.H), interpolation=cv2.INTER_LINEAR)
    hm = rgba[..., 3] > 0.5
    rgba[..., :3] *= rgba[..., 3:]
    # face-width columns = fringe, outside = side; fringe also limited to below the forehead top
    fx0, fx1 = view.px([[fb[0], 0], [fb[2], 0]])[:, 0]
    cols = np.arange(view.W)[None, :]
    rows = np.arange(view.H)[:, None]
    brow_row = view.px([[0, ey - 1.3 * ipd]])[0, 1]
    fr = hm & (cols > fx0) & (cols < fx1)
    fr = ndi.binary_opening(fr, iterations=1)
    frame = {'ipd_model': ipd, 'd_ear': 0.0, 'd_eye_rel': 0.0, 'depth_ok': False,
             'crown_b': -(lm.get('crown', fb[1]) - ey) / ipd, 'chin_b': -(chin - ey) / ipd,
             'face_half_w': (fb[2] - fb[0]) / 2 / ipd}
    locks = []
    def layer_img(m):
        out = rgba.copy(); out[..., 3] = m.astype(np.float32); out[..., :3] *= out[..., 3:]
        return out
    locks += hair2d.mask_locks(layer_img(fr), None, None, view, A, 'fringe', 'image_fringe', min_prom=0.15, max_locks=9)
    locks += crown_strands(rgba, hm, view, A, ey - 0.9 * ipd)
    for side, sel in (('L', cols <= fx0), ('R', cols >= fx1)):
        m = hm & sel & (rows > brow_row)
        if m.sum() > 200:
            got = hair2d.mask_locks(layer_img(m), None, None, view, A, 'side', 'image_side_' + side, max_locks=5)
            for L in got:
                L['front_hang'] = bool(L['tip'][1] < frame['chin_b'])
            locks += got
    for L in locks:
        L.setdefault('front_hang', False)
    # silhouette + fringe line + flicks
    sil = {}
    for lay, m in (('fringe', fr), ('back', hm)):
        rr = np.nonzero(m.any(1))[0]
        prof = []
        for r in rr[::3]:
            xs = np.nonzero(m[r])[0]
            y = -(view.model([[0, r]])[0, 1] - ey) / ipd
            xa, xb = view.model([[xs.min(), r], [xs.max() + 1, r]])[:, 0]
            prof.append([round(float(y), 3), round(float(-(xb - ex) / ipd), 3), round(float(-(xa - ex) / ipd), 3)])
        sil[lay] = prof
    frame['fringe_env'] = hair2d.fringe_envelope(fr, view, A, ipd)
    # a drawing's spiky outline (its line art speckles the region: closed first) -> upswept crown spikes
    hm_c = ndi.binary_fill_holes(ndi.binary_closing(hm, iterations=4))
    fl = hair2d.outline_flicks(hm_c, view, A, ipd, frame, min_prot=0.15, max_n=8)
    locks += fl
    # hair length: the lowest hair beside the face (short hair ends above the chin)
    side_rows = np.nonzero((hm & ((cols <= fx0) | (cols >= fx1))).any(1))[0]
    low_b = -(view.model([[0, side_rows.max()]])[0, 1] - ey) / ipd if len(side_rows) else frame['chin_b'] + 0.5
    frame.update(style='down', back_len=float(min(low_b, frame['chin_b'] + 0.3)), cap_bottom=float(low_b))
    log(f'image hair: {len(locks)} locks (fringe {sum(1 for l in locks if l["layer"] == "fringe")}, side '
        f'{sum(1 for l in locks if l["layer"] == "side")}, flicks {len(fl)}), back to b={frame["back_len"]:.2f}')
    # the front-view target of the silhouette fit (hair_blender -> silfit)
    masks = None
    try:
        H_, W_ = img.shape[:2]
        eyes = np.zeros((H_, W_), bool)
        for k in ('eye_L', 'eye_R'):
            bx0, by0, bx1, by1 = [int(round(v)) for v in lm[k]['bbox']]
            eyes[max(0, by0):max(0, by1), max(0, bx0):max(0, bx1)] = True
        eyes &= ~A.hair_mask
        # a drawing's hair region is speckled by its own line art / highlights: closed + filled for the target
        hm_t = ndi.binary_fill_holes(ndi.binary_closing(A.hair_mask, iterations=3)) & ~A.face_mask
        ign = getattr(A, 'acc_mask', None)
        ms_ = {'hair': hm_t, 'face': A.face_mask & ~hm_t, 'eyes': eyes}
        if ign is not None:
            ms_['ignore'] = ign                  # the head accessory's own outline: generated, not the hair's business
        iv = ImgView((0.0, 0.0, float(W_), float(H_)), 1.0)
        masks = hair2d.drawn_masks(iv, ms_, A, ipd)
        # the drawn strand direction field over the hair (flow cost of the silhouette fit)
        tx, ty, coh = hair2d.stroke_field(np.concatenate([img, np.ones(img.shape[:2] + (1,))], -1), max(1.5, 0.06 * ipd))
        c2, s2 = tx * tx - ty * ty, 2 * tx * ty
        for k, im_ in (('flow_c', (c2 + 1) / 2), ('flow_s', (s2 + 1) / 2), ('flow_w', np.clip(coh, 0, 1) * hm_t)):
            masks[k] = (np.clip(hair2d._grid_sample(iv, im_, A, ipd), 0, 1) * 255).astype(np.uint8)
    except Exception as e:
        log(f'image hair: drawn masks skipped ({type(e).__name__}: {e})')
    return {'frame': frame, 'locks': locks, 'silhouette': sil, 'masks': masks}


def crown_strands(rgba, hm, view, A, y_max, spacing=0.55, min_len=1.1):
    """the swept crown of a drawing (no layered drawables to trace): strands followed through the drawn strand
    direction field (hair2d.stroke_field) from seeds spread over the hair above y_max, both ways; each long strand
    becomes a lock lying on the hair volume in the drawn direction (root = its upper end)"""
    from . import hair2d
    PX = hair2d.PX
    tx, ty, coh = hair2d.stroke_field(rgba, 0.1 * PX)
    H, W = hm.shape
    ymax = view.px([[0, y_max]])[0, 1]
    step = 2.0
    out, used = [], np.zeros_like(hm)
    for yy in np.arange(PX * 0.3, min(ymax, H - 1), spacing * PX):
        for xx in np.arange(PX * 0.3, W - 1, spacing * PX):
            r, c = int(yy), int(xx)
            if not hm[r, c] or used[r, c] or coh[r, c] < 0.25:
                continue
            segs = {}
            for sgn in (1, -1):
                p = np.array([xx, yy], float); d = None; seg = []
                for _ in range(int(3.5 * PX / step)):
                    rr, cc = int(round(p[1])), int(round(p[0]))
                    if not (0 <= rr < H and 0 <= cc < W) or not hm[rr, cc]:
                        break
                    t = np.array([tx[rr, cc], ty[rr, cc]]) * sgn
                    if d is not None and np.dot(t, d) < 0:
                        t = -t
                    d = t if d is None else (0.7 * d + 0.3 * t)
                    d /= np.linalg.norm(d) + 1e-9
                    p = p + d * step; seg.append(p.copy())
                segs[sgn] = seg
            pts = np.array(segs[-1][::-1] + [np.array([xx, yy], float)] + segs[1])
            if len(pts) < 5:
                continue
            L = np.linalg.norm(np.diff(pts, axis=0), axis=1).sum() / PX
            if L < min_len:
                continue
            if pts[0, 1] > pts[-1, 1]:
                pts = pts[::-1]                      # root = the upper end
            for q in pts[::3]:
                rr, cc = int(q[1]), int(q[0])
                used[max(rr - int(0.25 * PX), 0):rr + int(0.25 * PX), max(cc - int(0.25 * PX), 0):cc + int(0.25 * PX)] = True
            seg_ = np.linalg.norm(np.diff(pts, axis=0), axis=1); cum = np.r_[0, np.cumsum(seg_)]
            ss = np.linspace(0, cum[-1], 9)
            pp = np.stack([np.interp(ss, cum, pts[:, 0]), np.interp(ss, cum, pts[:, 1])], 1)
            mdl = view.model(pp)
            ab = np.stack([-(mdl[:, 0] - A.mid_x) / A.ipd, -(mdl[:, 1] - A.lm['eye_y']) / A.ipd, np.zeros(len(pp))], 1)
            out.append({'layer': 'fringe', 'drawable': 'image_crown', 'pts': ab.round(4).tolist(),
                        'width': [0.35] * 9, 'tip': ab[-1, :2].round(4).tolist(), 'front_hang': False})
    return out


def references(A, out):
    """front.png / head.png crops of the drawing for the review sheets"""
    os.makedirs(out, exist_ok=True)
    img = (np.clip(A.image, 0, 1) * 255).astype(np.uint8)
    Image.fromarray(img).save(os.path.join(out, 'front.png'))
    fb = A.lm['face_bbox']; ex = A.mid_x
    h = fb[3] - fb[1]
    c = (int(max(ex - 1.1 * h, 0)), int(max(fb[1] - 0.15 * h, 0)), int(min(ex + 1.1 * h, img.shape[1])),
         int(min(fb[3] + 0.65 * h, img.shape[0])))
    Image.fromarray(img[c[1]:c[3], c[0]:c[2]]).save(os.path.join(out, 'head.png'))
