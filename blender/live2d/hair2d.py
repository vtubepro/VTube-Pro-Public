"""Live2D hair drawables -> 3D lock guides (numpy): the 2D silhouettes give where every lock hangs and where its tip
is; the model's own head-turn deformation (ParamAngleX -30 / +30) gives each point's depth.

Depth from the rig's parallax: a head turn moves a point sideways by roughly  dx = z * 2 sin(turn)  (z = depth in front
of the turning axis), so  d(v) = x(+30) - x(-30)  is a depth estimate for every mesh vertex. Artists under-rotate,
so depths are calibrated on the 3D base afterwards (eyes vs ears, in hair_blender.py). Measured on the official
samples: nose 0.8-1.0 IPD, eyes 0.63-0.74, ears 0.27, fringe 0.4, back hair ~0.

Output (locks.json), all lengths in IPD (eye-to-eye distance) units, a = toward the character's RIGHT (glTF +X),
b = up, d = raw parallax depth (relative to the ears):
  {"frame": {...}, "locks": [{"layer": "fringe|side|back|ahoge", "drawable": id, "pts": [[a, b, d], ...] root->tip,
    "width": [w0 .. wn], "tip": [a, b]}], "silhouette": {...}}
"""
import json

import numpy as np
from scipy import ndimage as ndi

from .render import View, drawable_layer, raster_mesh, render_pose

LAYER = {'hair_front': 'fringe', 'hair_side': 'side', 'hair_back': 'back', 'ahoge': 'ahoge'}
PX = 60.0                      # pixels per IPD for the masks


def parallax(model, A):
    """per art mesh: vertex depth d (IPD units, relative to the ears)"""
    pm = model.pose({'ParamAngleX': -30, 'ParamMouthOpenY': 0})
    pp = model.pose({'ParamAngleX': 30, 'ParamMouthOpenY': 0})
    D = [(pp.positions[a][:, 0] - pm.positions[a][:, 0]) / A.ipd for a in range(len(A.cls))]
    ears = [a for a, c in enumerate(A.cls) if c == 'ear']
    eyes = [a for a, c in enumerate(A.cls) if c in ('eye_white', 'iris')]
    d_ear = float(np.median(np.concatenate([D[a] for a in ears]))) if ears else 0.25
    d_eye = float(np.median(np.concatenate([D[a] for a in eyes]))) if eyes else d_ear + 0.4
    if d_eye - d_ear < 0.08:            # model without a usable head turn: fall back to layer defaults
        return None, d_ear, d_eye
    return [d - d_ear for d in D], d_ear, d_eye


def _smooth(v, k):
    if k <= 1:
        return v
    w = np.hanning(k * 2 + 1); w /= w.sum()
    pad = np.pad(v, k, mode='edge')
    return np.convolve(pad, w, mode='valid')


def _extrema(prof, valid, prom):
    """tips = local maxima of the lower edge (y down), valleys = the minima between them; prominence in px"""
    xs = np.nonzero(valid)[0]
    if len(xs) < 3:
        return [], []
    p = prof.copy()
    tips = []
    # iterative: highest remaining point that is `prom` deeper than the valleys on both sides
    order = xs[np.argsort(-p[xs])]
    for x in order:
        if any(abs(x - t) < 3 for t in tips):
            continue
        l = [t for t in tips if t < x]; r = [t for t in tips if t > x]
        lo = max(l) if l else xs[0]; hi = min(r) if r else xs[-1]
        left_min = p[lo:x + 1][valid[lo:x + 1]].min() if x > lo else p[x]
        right_min = p[x:hi + 1][valid[x:hi + 1]].min() if hi > x else p[x]
        ok_l = (not l and x - lo < 3) or p[x] - left_min >= prom or (not l)
        ok_r = (not r and hi - x < 3) or p[x] - right_min >= prom or (not r)
        if (l or r) and not (p[x] - left_min >= prom and p[x] - right_min >= prom):
            continue
        if ok_l and ok_r:
            tips.append(int(x))
    tips.sort()
    valleys = []
    for t0, t1 in zip(tips[:-1], tips[1:]):
        seg = np.arange(t0, t1 + 1)
        seg = seg[valid[seg]]
        valleys.append(int(seg[np.argmin(p[seg])]) if len(seg) else (t0 + t1) // 2)
    return tips, valleys


def stroke_field(rgba, sigma):
    """the drawn strands' direction field: structure tensor of the art's luminance (strand lines / shading bands run
    ALONG the locks, so the tangent is perpendicular to the dominant gradient); returns (tx, ty, coherence) images"""
    g = rgba[..., :3] @ np.array([0.3, 0.59, 0.11])
    gx = ndi.sobel(g, 1); gy = ndi.sobel(g, 0)
    j11 = ndi.gaussian_filter(gx * gx, sigma); j22 = ndi.gaussian_filter(gy * gy, sigma)
    j12 = ndi.gaussian_filter(gx * gy, sigma)
    phi = 0.5 * np.arctan2(2 * j12, j11 - j22)              # gradient direction
    tx, ty = -np.sin(phi), np.cos(phi)                     # tangent = gradient rotated 90 deg
    coh = np.sqrt((j11 - j22) ** 2 + 4 * j12 ** 2) / (j11 + j22 + 1e-9)
    return tx, ty, coh


def trace_strand(M, field, tip, top_y, step=2.0, max_n=400):
    """from a lock tip, walk UP along the drawn strand direction (blended with 'straight up' where the field is weak)
    while inside the drawable; returns root-first points"""
    tx, ty, coh = field
    H, W = M.shape
    p = np.array(tip, float); d = np.array([0.0, -1.0]); pts = [p.copy()]
    for _ in range(max_n):
        r, c = int(np.clip(round(p[1]), 0, H - 1)), int(np.clip(round(p[0]), 0, W - 1))
        t = np.array([tx[r, c], ty[r, c]])
        if np.dot(t, d) < 0:
            t = -t
        w = float(np.clip(coh[r, c] * 1.5, 0, 0.85))
        nd = w * t + (1 - w) * np.array([0.0, -1.0]) * 0.6 + (1 - w) * d * 0.4
        nd = nd / (np.linalg.norm(nd) + 1e-9)
        if nd[1] > -0.2:                                 # never walk down / sideways only: strands rise toward the root
            nd = nd + np.array([0, -0.4]); nd /= np.linalg.norm(nd)
        d = 0.6 * d + 0.4 * nd; d /= np.linalg.norm(d)
        q = p + d * step
        rq, cq = int(round(q[1])), int(round(q[0]))
        if not (0 <= rq < H and 0 <= cq < W) or not M[rq, cq] or q[1] < top_y:
            break
        p = q; pts.append(p.copy())
    return np.array(pts[::-1])


def drawable_locks(model, A, a, depth, view, layer, min_prom=0.25, max_locks=6):
    """split one hair drawable into locks along its lower edge; returns [lock dict]"""
    RGBA = drawable_layer(model, A.pose, a, view, 1, opacity=False)
    if (RGBA[..., 3] > 0.45).sum() < 40:
        return []
    # parallax depth image of this drawable (barycentric)
    P = view.px(A.pose.positions[a])
    dd = depth[a][:, None].astype(np.float64) if depth is not None else np.zeros((len(P), 1))
    cov, dimg = raster_mesh(P, model.moc.art_tri[a], view.W, view.H, dd)
    return mask_locks(RGBA, cov, dimg, view, A, layer, model.moc.art_ids[a], min_prom, max_locks)


def _resample_poly(P, n):
    """a polyline resampled to n points evenly along its length"""
    P = np.asarray(P, float)
    seg = np.linalg.norm(np.diff(P, axis=0), axis=1); cum = np.r_[0, np.cumsum(seg)]
    if cum[-1] <= 1e-9:
        return np.repeat(P[:1], n, 0)
    ss = np.linspace(0, cum[-1], n)
    return np.stack([np.interp(ss, cum, P[:, k]) for k in range(P.shape[1])], 1)


def mask_locks(RGBA, cov, dimg, view, A, layer, name, min_prom=0.25, max_locks=6):
    """locks of one hair region (an RGBA layer in `view` pixels): Live2D drawables and the image-only route share it.
    cov / dimg: per-pixel depth (None = no depth)"""
    if cov is None:
        cov = np.zeros(RGBA.shape[:2], bool); dimg = np.zeros(RGBA.shape[:2] + (1,))
    L = RGBA[..., 3] > 0.45
    field = stroke_field(RGBA, 0.08 * PX) if layer in ('fringe', 'side') else None
    if L.sum() < 40:
        return []
    L = ndi.binary_opening(L, iterations=1)
    lab, n = ndi.label(L)
    if n > 1:                                     # keep the biggest pieces (drawables sometimes hold 2 locks)
        sizes = ndi.sum(L, lab, range(1, n + 1))
        keep = [i + 1 for i in np.argsort(-sizes) if sizes[i] > 0.12 * sizes.max()]
    else:
        keep = [1]
    out = []
    # the art's own lock outlines: the ink / dark strand lines drawn inside the hair region cut it into its locks
    lumA = RGBA[..., :3] @ np.array([0.3, 0.59, 0.11])
    for k in keep:
        M = lab == k
        ys, xs = np.nonzero(M)
        lm_ = lumA[M]
        ink = M & (lumA < min(np.percentile(lm_, 12), np.median(lm_) - 0.1))
        regions, _nr = ndi.label(M & ~ndi.binary_dilation(ink, iterations=1))
        x0, x1 = xs.min(), xs.max()
        cols = np.arange(x0, x1 + 1)
        bot = np.full(len(cols), -1.0); top = np.full(len(cols), -1.0)
        for i, x in enumerate(cols):
            c = np.nonzero(M[:, x])[0]
            if len(c):
                bot[i] = c.max(); top[i] = c.min()
        valid = bot >= 0
        prof = _smooth(np.where(valid, bot, np.interp(cols, cols[valid], bot[valid])), max(1, int(0.03 * PX)))
        tips, valleys = _extrema(prof, valid, min_prom * PX)
        if not tips:
            tips = [int(np.argmax(np.where(valid, prof, -1)))]
        if len(tips) > max_locks:                 # keep the longest tips, re-derive valleys
            tips = sorted(sorted(tips, key=lambda t: -prof[t])[:max_locks])
            tips, valleys = tips, [int(tips[i] + np.argmin(prof[tips[i]:tips[i + 1] + 1])) for i in range(len(tips) - 1)]
        if layer == 'back' and len(tips) == 1 and (x1 - x0) / PX > 1.6:
            continue                              # the back 'cap' mass behind the head: volume, not a lock
        bounds = [0] + valleys + [len(cols) - 1]
        if layer in ('fringe', 'side'):
            # a drawn fringe is a SOLID mass: a stretch wider than ~0.42 IPD between two tips is several locks whose
            # tips just line up (blunt / flat bangs) -> split it so the 3D fringe covers the forehead like the art
            nt, nb = [], [0]
            for i, t in enumerate(tips):
                lo, hi = bounds[i], bounds[i + 1]
                k = int(np.ceil((hi - lo) / (0.6 * PX)))
                if k <= 1:
                    nt.append(t); nb.append(hi); continue
                edges = np.linspace(lo, hi, k + 1).astype(int)
                for j in range(k):
                    a0, a1 = edges[j], max(edges[j + 1], edges[j] + 1)
                    nt.append(int(a0 + np.argmax(prof[a0:a1 + 1])))
                    nb.append(int(edges[j + 1]))
            tips, bounds = nt, nb
            bounds[-1] = len(cols) - 1
            # FEWER, LARGER locks: never more locks than the drawing's own (the regions its ink lines cut the hair
            # into, big enough to be a lock) -- the longest tips kept, the strips between them merged
            sizes_r = ndi.sum(np.ones_like(regions), regions, range(1, _nr + 1)) if _nr else []
            n_draw = int(sum(1 for a_ in sizes_r if a_ > 0.06 * PX * PX))
            if n_draw >= 2 and len(tips) > n_draw:
                keep_t = sorted(sorted(range(len(tips)), key=lambda i_: -prof[tips[i_]])[:n_draw])
                tips = [tips[i_] for i_ in keep_t]
                bounds = [0] + [int(tips[i_] + np.argmin(prof[tips[i_]:tips[i_ + 1] + 1]))
                                for i_ in range(len(tips) - 1)] + [len(cols) - 1]
        top_y = float(np.percentile(ys, 2))
        for i, t in enumerate(tips):
            lo, hi = bounds[i], bounds[i + 1]
            tip = np.array([cols[t], prof[t]])
            vy = min(prof[lo], prof[hi]) if len(tips) > 1 else top_y + 0.35 * (prof[t] - top_y)
            # lock strip: columns lo..hi; centre line from the tip up to the drawable's top (roots converge)
            strip_top = top[lo:hi + 1][valid[lo:hi + 1]]
            ty = float(strip_top.min()) if len(strip_top) else top_y
            xc_v = (cols[lo] + cols[hi]) / 2
            root_x = xc_v + (np.mean(xs) - xc_v) * 0.35
            n = 9
            pts = []
            for j in range(n):
                s = j / (n - 1)                                 # 0 = root .. 1 = tip
                y = ty + (tip[1] - ty) * s
                if y <= vy:
                    f = (y - ty) / max(vy - ty, 1e-6)
                    x = root_x + (xc_v - root_x) * f
                else:
                    f = (y - vy) / max(tip[1] - vy, 1e-6)
                    x = xc_v + (tip[0] - xc_v) * f
                # snap into the mask (centre of the run on this row nearest x)
                r = int(np.clip(round(y), 0, M.shape[0] - 1))
                run = np.nonzero(M[r])[0]
                if len(run):
                    x = float(np.clip(x, run.min(), run.max()))
                pts.append((x, y))
            pts = np.array(pts)
            if field is not None:
                # the drawn strands say where the lock really comes from (a swept fringe: diagonal, curved)
                tr = trace_strand(M, field, tip, ty)
                if len(tr) > 4 and (tip[1] - tr[0, 1]) > 0.6 * (tip[1] - ty):
                    seg = np.linalg.norm(np.diff(tr, axis=0), axis=1); cum = np.r_[0, np.cumsum(seg)]
                    ss = np.linspace(0, cum[-1], n)
                    pts = np.stack([np.interp(ss, cum, tr[:, 0]), np.interp(ss, cum, tr[:, 1])], 1)
            # the LOCK'S OWN CONTOUR: its region between the drawn ink lines (found just above the tip); widths are
            # measured across the spine (perpendicular, not along image rows -- a swept lock is diagonal), so the
            # 3D lock takes the drawn width profile: broad body, the drawn taper, pointed / hooked / split tip
            wv = (cols[hi] - cols[lo]) if len(tips) > 1 else float(np.sum(M[int(np.clip(round(vy), 0, M.shape[0] - 1))]))
            q = pts[-1] + (pts[-3] - pts[-1]) * 0.5
            rid = regions[int(np.clip(round(q[1]), 0, M.shape[0] - 1)), int(np.clip(round(q[0]), 0, M.shape[1] - 1))]
            Rg = regions == rid if rid else None
            if Rg is not None and not (0.02 * PX * PX < Rg.sum() < 2.5 * PX * PX):
                Rg = None
            strip = np.zeros_like(M); strip[:, max(cols[lo] - 2, 0):cols[hi] + 3] = True
            area = Rg if Rg is not None else (M & strip)
            pts = _resample_poly(pts, 15)
            T_ = np.gradient(pts, axis=0); T_ /= np.linalg.norm(T_, axis=1, keepdims=True) + 1e-9
            widths = []
            for (x, y), (tx_, ty_) in zip(pts, T_):
                nx_, ny_ = -ty_, tx_
                w = 0.0
                for sgn in (1, -1):
                    d = 0.0
                    while d < 1.5 * PX:
                        xx = int(round(x + sgn * nx_ * (d + 1))); yy = int(round(y + sgn * ny_ * (d + 1)))
                        if not (0 <= xx < M.shape[1] and 0 <= yy < M.shape[0]) or not area[yy, xx]:
                            break
                        d += 1.0
                    w += d
                widths.append(min(w + 1.0, wv * 1.3))
            widths = np.maximum(np.array(widths, float), 0.04 * PX)
            # split tips: the lock region's lower edge has several points of its own
            n_tip = 1
            if Rg is not None:
                rys, rxs = np.nonzero(Rg)
                rc = np.arange(rxs.min(), rxs.max() + 1)
                if len(rc) >= 6:
                    rb = np.array([np.nonzero(Rg[:, c_])[0].max() if Rg[:, c_].any() else -1 for c_ in rc], float)
                    vb = rb >= 0
                    rb = _smooth(np.where(vb, rb, np.interp(rc, rc[vb], rb[vb])), 1)
                    tt_, _ = _extrema(rb, vb, 0.1 * PX)
                    n_tip = int(np.clip(len(tt_), 1, 3))
            # depth along the centre line (median of the drawable's depth around each point)
            dvals = []
            for (x, y) in pts:
                r, c = int(np.clip(round(y), 0, view.H - 1)), int(np.clip(round(x), 0, view.W - 1))
                win = (slice(max(r - 3, 0), r + 4), slice(max(c - 3, 0), c + 4))
                sel = cov[win]
                dvals.append(float(np.median(dimg[win][..., 0][sel])) if sel.any() else np.nan)
            dvals = np.array(dvals)
            if np.isnan(dvals).all():
                dvals[:] = 0.0
            else:
                good = ~np.isnan(dvals)
                dvals = np.interp(np.arange(len(dvals)), np.nonzero(good)[0], dvals[good])
            mdl = view.model(pts)
            ab = np.stack([-(mdl[:, 0] - A.mid_x) / A.ipd, -(mdl[:, 1] - A.lm['eye_y']) / A.ipd, dvals], 1)
            if np.linalg.norm(ab[-1, :2] - ab[0, :2]) < 0.35:
                continue                          # a tiny lock: noise in 3D
            if layer in ('fringe', 'back') and ab[-1, 1] > 1.0 and np.linalg.norm(ab[-1, :2] - ab[0, :2]) < 0.6:
                continue                          # a stub ending on top of the head: only clutter in 3D (the crown covers it)
            lock = {'layer': layer, 'drawable': name, 'pts': ab.round(4).tolist(),
                    'width': (widths / PX).round(4).tolist(), 'tip': ab[-1, :2].round(4).tolist(),
                    'contour': bool(Rg is not None), 'tips_n': n_tip}
            if layer == 'tail':
                lock['curls'] = _curls(M)
            out.append(lock)
    return out


def _curls(M):
    """drill / ringlet curls: the drawn tail's width along its length bulges once per turn -> number of bulges"""
    rows = np.nonzero(M.any(1))[0]
    if len(rows) < 20:
        return 0
    w = np.array([M[r].sum() for r in rows], float)
    w = _smooth(w, max(2, len(w) // 30))
    k = max(3, len(w) // 12)
    peaks = 0
    for i in range(k, len(w) - k):
        seg = w[i - k:i + k + 1]
        if w[i] == seg.max() and w[i] - seg.min() > 0.18 * w.max():
            peaks += 1
    return int(peaks) if peaks >= 2 else 0


def _body_mask(model, A):
    if getattr(A, '_body_mask', None) is None:
        M = np.zeros(A.ids.shape, bool)
        for b in A.pose.order:
            if A.cls[b] not in LAYER and A.cls[b] not in ('effect', 'hidden', 'prop'):
                M |= drawable_layer(model, A.pose, b, A.view, 1, opacity=False)[..., 3] > 0.5
        A._body_mask = M
    return A._body_mask


def _stats(model, A, a, depth):
    P = A.pose.positions[a]
    ab = np.stack([-(P[:, 0] - A.mid_x) / A.ipd, -(P[:, 1] - A.lm['eye_y']) / A.ipd], 1)
    # share of the drawable's pixels below the chin that are visible in the front picture (= hangs in front of the body)
    L = drawable_layer(model, A.pose, a, A.view, 1, opacity=False)[..., 3] > 0.5
    chin_px = int(A.view.px([[0, A.lm['face_bbox'][3]]])[0, 1])
    L[:chin_px] = False
    L &= _body_mask(model, A)                     # only where the neck / body / clothes are behind or in front
    vis = float((A.ids[L] == a).mean()) if L.sum() > 30 else 0.0
    return {'a0': float(ab[:, 0].min()), 'a1': float(ab[:, 0].max()), 'b0': float(ab[:, 1].min()),
            'b1': float(ab[:, 1].max()), 'ac': float(ab[:, 0].mean()), 'vis_below_chin': vis,
            'd': float(np.median(depth[a])) if depth is not None else 0.0}


def hairstyle(A, stats, frame):
    """'down' (hair hangs) | 'ponytail' (one gathered tail, side = sign) | 'twintails'; tail drawables; back length"""
    chin, fw = frame['chin_b'], frame['face_half_w']
    back = {a: s for a, s in stats.items() if A.cls[a] == 'hair_back'}
    caps = {a: s for a, s in back.items() if s['a1'] - s['a0'] > 1.6 * fw}
    cap_bottom = min([s['b0'] for s in caps.values()], default=chin + 0.2)
    hang = {a: s for a, s in back.items() if a not in caps and s['b0'] < cap_bottom - 0.3 and s['vis_below_chin'] < 0.5}
    right = {a: s for a, s in hang.items() if s['ac'] > 0.9 * fw}
    left = {a: s for a, s in hang.items() if s['ac'] < -0.9 * fw}
    mass = lambda d: sum((s['a1'] - s['a0']) * (s['b1'] - s['b0']) for s in d.values())
    mode, tails = 'down', []
    if cap_bottom > chin - 0.4 and (right or left):
        mr, ml = mass(right), mass(left)
        if mr > 3 * ml or ml > 3 * mr:
            mode, tails = 'ponytail', list(right if mr > ml else left)
        elif min(abs(s['ac']) for s in list(right.values()) + list(left.values())) > 1.35 * fw:
            mode, tails = 'twintails', list(right) + list(left)
    # how far the hair hangs at the back: the lowest non-tail back lock hidden behind the body, else the cap
    behind = [s['b0'] for a, s in back.items() if a not in caps and a not in tails and s['vis_below_chin'] < 0.5]
    back_len = min(behind + [cap_bottom]) if mode == 'down' else cap_bottom
    return mode, tails, float(back_len), float(cap_bottom)


def outline_flicks(mask, view, A, ipd, frame, min_prot=0.2, max_n=6):
    """spikes of the drawn hair outline above the eye line (upswept crown locks, side flicks): points where the
    outline sticks out of its own smoothed version by > min_prot IPD. Each becomes a short 'ahoge' lock from a root
    ~0.45 IPD inside the mass to the spike tip -- the 3D crown gets the drawn flicks instead of a smooth cap."""
    import cv2
    from scipy import ndimage as ndi
    m8 = ndi.binary_closing(mask, iterations=2).astype(np.uint8)
    cs, _ = cv2.findContours(m8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cs:
        return []
    C = max(cs, key=len)[:, 0, :].astype(float)
    n = len(C)
    if n < 50:
        return []
    px = ipd * view.scale                                # pixels per IPD
    sig = max(3.0, 0.35 * px)
    Cs = np.stack([ndi.gaussian_filter1d(C[:, k], sig, mode='wrap') for k in range(2)], 1)
    cen = np.array(np.nonzero(mask)[::-1]).mean(1)
    out_dir = Cs - cen
    out_dir /= np.linalg.norm(out_dir, axis=1, keepdims=True) + 1e-9
    prot = ((C - Cs) * out_dir).sum(1) / px              # + = sticking out (IPD)
    eye_row = view.px([[0, A.lm['eye_y']]])[0, 1]
    cand = []
    win = max(3, int(0.3 * px))
    for i in range(n):
        crown_row = eye_row - frame.get('crown_b', 2.2) * px
        if prot[i] < min_prot or C[i, 1] > eye_row - 0.3 * px or C[i, 1] > crown_row + 2.0 * px:
            continue                                      # only the upper head: temple spikes read as shards in 3D
        lo, hi = i - win, i + win + 1
        idx = np.arange(lo, hi) % n
        if prot[i] < prot[idx].max():
            continue
        cand.append((prot[i], i))
    cand.sort(reverse=True)
    locks, used = [], []
    for pr, i in cand:
        if any(min(abs(i - j), n - abs(i - j)) < 2 * win for j in used):
            continue
        used.append(i)
        tip = C[i]
        root = Cs[i] - out_dir[i] * 0.6 * px
        if not mask[int(np.clip(root[1], 0, mask.shape[0] - 1)), int(np.clip(root[0], 0, mask.shape[1] - 1))]:
            continue
        pts = np.array([root + (tip - root) * t for t in np.linspace(0, 1, 7)])
        mdl = view.model(pts)
        ab = np.stack([-(mdl[:, 0] - A.mid_x) / ipd, -(mdl[:, 1] - A.lm['eye_y']) / ipd, np.zeros(len(pts))], 1)
        w = np.linspace(0.24, 0.06, len(pts))          # a flick, not a horn (review: "horn-like spike")
        locks.append({'layer': 'ahoge', 'drawable': 'outline', 'pts': ab.round(4).tolist(), 'width': w.round(4).tolist(),
                      'tip': ab[-1, :2].round(4).tolist(), 'flick': round(float(pr), 3)})
        if len(locks) >= max_n:
            break
    return locks


def fringe_envelope(M, view, A, ipd, tip_w=0.45):
    """the SOLID part of a drawn fringe: per column (a, IPD units) the height b where the hair mass ends between the
    tips -- the lowest hair row per column, morphologically opened with a window about one tip wide (the tips drop
    below it, the valleys between them define it). A fringe fill down to this line leaves forehead only where the
    drawing shows forehead."""
    from scipy import ndimage as ndi
    cols = np.nonzero(M.any(0))[0]
    if len(cols) < 5:
        return []
    low = np.full(M.shape[1], np.nan)
    for x in cols:
        low[x] = np.nonzero(M[:, x])[0].max()
    w = max(3, int(round(tip_w * ipd * view.scale)))
    L = np.where(np.isnan(low), -1e6, low)
    env = ndi.maximum_filter1d(ndi.minimum_filter1d(L, w), w)       # opening from below (y down)
    out = []
    for x in cols[::max(1, len(cols) // 40)]:
        if env[x] < 0:
            continue
        mx, my = view.model([[x + 0.5, env[x]]])[0]
        out.append([round(float(-(mx - A.mid_x) / ipd), 3), round(float(-(my - A.lm['eye_y']) / ipd), 3)])
    return out


def extract(model, A, log=print, mode=None):
    depth, d_ear, d_eye = parallax(model, A)
    ipd = A.ipd
    hb = A.lm.get('hair_bbox', A.lm['face_bbox'])
    crop = (A.mid_x - 6 * ipd, hb[1] - 0.3 * ipd, A.mid_x + 6 * ipd, hb[3] + 0.3 * ipd)
    view = View(model.moc.canvas, PX * (crop[3] - crop[1]) / ipd, crop)
    fb = A.lm['face_bbox']
    frame = {'ipd_model': ipd, 'd_ear': d_ear, 'd_eye_rel': d_eye - d_ear, 'depth_ok': depth is not None,
             'crown_b': -(A.lm.get('crown', fb[1]) - A.lm['eye_y']) / ipd, 'chin_b': -(fb[3] - A.lm['eye_y']) / ipd,
             'face_half_w': (fb[2] - fb[0]) / 2 / ipd}
    stats = {a: _stats(model, A, a, depth) for a in A.pose.order if A.cls[a] in LAYER}
    style, tails, back_len, cap_bottom = hairstyle(A, stats, frame)
    if mode and mode != 'auto':
        style = mode
    frame.update(style=style, back_len=back_len, cap_bottom=cap_bottom)
    locks = []
    for a in A.pose.order:
        c = A.cls[a]
        if c not in LAYER:
            continue
        lay = 'tail' if a in tails and style != 'down' else LAYER[c]
        got = drawable_locks(model, A, a, depth, view, lay)
        for L in got:
            L['front_hang'] = bool(stats[a]['vis_below_chin'] >= 0.5)
        locks += got
    # silhouette summary per layer (for coverage / volume): outer hair width per height row, in IPD units
    sil = {}
    for c, lay in LAYER.items():
        al = np.zeros((view.H, view.W))
        for a in A.pose.order:
            if A.cls[a] == c:
                al = np.maximum(al, drawable_layer(model, A.pose, a, view, 1, opacity=False)[..., 3])
        if al.max() < 0.5:
            continue
        M = al > 0.5
        rows = np.nonzero(M.any(1))[0]
        prof = []
        for r in rows[::3]:
            xs = np.nonzero(M[r])[0]
            y = -(view.model([[0, r]])[0, 1] - A.lm['eye_y']) / ipd
            x0, x1 = view.model([[xs.min(), r], [xs.max() + 1, r]])[:, 0]
            prof.append([round(float(y), 3), round(float(-(x1 - A.mid_x) / ipd), 3), round(float(-(x0 - A.mid_x) / ipd), 3)])
        sil[lay] = prof
        if lay == 'fringe':
            frame['fringe_env'] = fringe_envelope(M, view, A, ipd)
    # upswept crown / side flicks: spikes on the drawn hair outline that no drawable's lower edge describes
    union = np.zeros((view.H, view.W), bool)
    for a in A.pose.order:
        if A.cls[a] in LAYER:
            union |= drawable_layer(model, A.pose, a, view, 1, opacity=False)[..., 3] > 0.5
    # the targets of the silhouette fit: visible hair / face skin / eyes as a label composite in the model's own draw
    # order (back to front), front view + the model's own +-30 head turns (the multi-view cost), and the drawn strand
    # DIRECTION field over the hair (the flow cost)
    try:
        masks = {}
        for key, ang in (('', None), ('_p30', 30.0), ('_m30', -30.0)):
            got = label_masks(model, A, view, ipd, ang)
            if got is None:
                continue
            for k, g in got.items():
                masks[k + key] = g
        rgba_h = render_pose(model, A.pose, view=view, ss=1, only={a for a in A.pose.order if A.cls[a] in LAYER})[0]
        tx, ty, coh = stroke_field(rgba_h, max(1.5, 0.08 * PX))
        # how much strand LINE ART the drawn hair carries (ink / dark strand lines inside the hair): the 3D locks'
        # texture gets as many interior strand lines (hair_blender.palette inner_lines)
        vis_ = rgba_h[..., 3] > 0.5
        if vis_.sum() > 100:
            lum_ = (rgba_h[..., :3] / np.maximum(rgba_h[..., 3:], 1e-3)) @ np.array([0.3, 0.59, 0.11])
            lv = lum_[vis_]
            ink_ = vis_ & (lum_ < np.median(lv) - 0.12)
            thin_ = ink_ & ~ndi.binary_opening(ink_, iterations=2)          # LINES, not shadow areas
            frame['strand_lines'] = round(float(thin_.sum() / vis_.sum()), 4)
        c2, s2 = tx * tx - ty * ty, 2 * tx * ty                 # doubled-angle (orientation, no sign)
        vis = rgba_h[..., 3] > 0.5
        for k, img in (('flow_c', (c2 + 1) / 2), ('flow_s', (s2 + 1) / 2), ('flow_w', np.clip(coh, 0, 1) * vis)):
            g = _grid_sample(view, img, A, ipd)
            masks[k] = (np.clip(g, 0, 1) * 255).astype(np.uint8)
    except Exception as e:
        log(f'hair2d: drawn masks skipped ({type(e).__name__}: {e})')
        masks = masks or None
    fl = outline_flicks(union, view, A, ipd, frame)
    if fl:
        locks += fl
        log(f'hair2d: {len(fl)} outline flicks (upswept crown / side spikes)')
    # see-through duplicates (eyes / hair drawn twice for layering) give identical locks: keep one
    uniq, seen = [], []
    for L in locks:
        P = np.array(L['pts'])[:, :2]
        if any(len(P) == len(Q) and np.abs(P - Q).max() < 0.05 for Q in seen):
            continue
        seen.append(P); uniq.append(L)
    locks = uniq
    log(f'hair2d: style {style} (back to b={back_len:.2f}, cap {cap_bottom:.2f}), {len(locks)} locks '
        f'({", ".join(f"{k}:{sum(1 for l in locks if l['layer'] == k)}" for k in ("fringe", "side", "back", "tail", "ahoge"))})')
    return {'frame': frame, 'locks': locks, 'silhouette': sil, 'masks': masks}


# the front-view target of the silhouette fit (hair_blender -> silfit): masks on a fixed grid in IPD units around the
# eye midpoint, laid out like the drawing (column -> a DEcreasing: the character's right on the picture's left)
GRID = {'a0': -4.0, 'a1': 4.0, 'b0': -5.0, 'b1': 3.5, 'px': 25}


def grid_model_xy(A, ipd, grid=GRID, centre=None):
    """model (drawing) coordinates of every grid pixel centre: (H, W, 2) (centre: the eye midpoint, default the
    front pose's)"""
    g = grid
    W = int(round((g['a1'] - g['a0']) * g['px'])); H = int(round((g['b1'] - g['b0']) * g['px']))
    a = g['a1'] - (np.arange(W) + 0.5) / g['px']
    b = g['b1'] - (np.arange(H) + 0.5) / g['px']
    aa, bb = np.meshgrid(a, b)
    cx, cy = centre if centre is not None else (A.mid_x, A.lm['eye_y'])
    return np.stack([cx - aa * ipd, cy - bb * ipd], -1)


def label_masks(model, A, view, ipd, angle=None):
    """hair / face / eyes of one pose (the front pose, or ParamAngleX = angle) on the fixed grid, centred on that
    pose's own eye midpoint (front IPD units): {'hair', 'face', 'eyes'} uint8, or None"""
    HAIR_C = set(LAYER)
    EYE_C = {'eye_white', 'iris', 'lash'}
    FACE_C = {'face', 'face_patch', 'skin', 'nose', 'mouth', 'ear', 'brow', 'eye_other', 'eye_hl'} | EYE_C
    BODY_C = {'neck', 'top', 'arm', 'hand', 'bottom', 'accessory', 'legwear', 'leg', 'shoes', 'hat'}
    pose = A.pose
    centre = None
    if angle is not None:
        pid = model.param_id('ParamAngleX', 'PARAM_ANGLE_X')
        if pid is None:
            return None
        prm = {pid: angle}
        bid = model.param_id('ParamBodyAngleX', 'PARAM_BODY_ANGLE_X')
        if bid:
            prm[bid] = 0.0
        pose = model.pose(prm)
        iris = [a for a in range(len(A.cls)) if A.cls[a] == 'iris']
        if not iris:
            return None
        P = np.concatenate([pose.positions[a] for a in iris])
        centre = (float(P[:, 0].mean()), float(P[:, 1].mean()))
    s_ = model.moc.s
    lab = np.zeros((view.H, view.W), np.int8)           # 0 none, 1 hair, 2 face, 3 eyes, 4 body
    for a in pose.order:
        c = A.cls[a]
        code = 1 if c in HAIR_C else 3 if c in EYE_C else 2 if c in FACE_C else 4 if c in BODY_C else 0
        if not code:
            continue
        al = drawable_layer(model, pose, a, view, 1)[..., 3]
        mb, mc = int(s_.arts.maskBegin[a]), int(s_.arts.maskCount[a])
        if mc:                                           # clipped drawables (irises, shading): inside their masks
            mk = np.zeros_like(al)
            for k in range(mb, mb + mc):
                mi = int(s_.masks.art[k])
                if mi >= 0:
                    mk = np.maximum(mk, drawable_layer(model, pose, mi, view, 1, opacity=False)[..., 3])
            al = al * mk
        lab[al > 0.5] = code
    return drawn_masks(view, {'hair': lab == 1, 'face': (lab == 2) | (lab == 3), 'eyes': lab == 3}, A, ipd,
                       centre=centre)


def _grid_sample(view, img, A, ipd, grid=None):
    """a float view-pixel image sampled onto the fixed grid (nearest)"""
    xy = grid_model_xy(A, ipd, grid or GRID)
    pxy = view.px(xy)
    x = np.round(pxy[..., 0]).astype(int); y = np.round(pxy[..., 1]).astype(int)
    ok = (x >= 0) & (x < img.shape[1]) & (y >= 0) & (y < img.shape[0])
    g = np.zeros(x.shape, np.float32)
    g[ok] = img[y[ok], x[ok]]
    return g


def drawn_masks(view, masks, A, ipd, grid=GRID, centre=None):
    """view-pixel boolean masks {'hair': visible hair, 'face': visible face skin, 'eyes': visible eyes} -> the same
    on the fixed IPD grid (uint8 0 / 255)"""
    xy = grid_model_xy(A, ipd, grid, centre)
    pxy = view.px(xy)
    out = {}
    for k, M in masks.items():
        if M is None:
            continue
        x = np.round(pxy[..., 0]).astype(int); y = np.round(pxy[..., 1]).astype(int)
        ok = (x >= 0) & (x < M.shape[1]) & (y >= 0) & (y < M.shape[0])
        g = np.zeros(x.shape, np.uint8)
        g[ok] = np.where(M[y[ok], x[ok]], 255, 0)
        out[k] = g
    return out


def save(res, path):
    import os
    masks = res.get('masks')
    body = {k: v for k, v in res.items() if k != 'masks'}
    if masks:
        from PIL import Image
        files = {}
        for k, g in masks.items():
            fn = os.path.join(os.path.dirname(os.path.abspath(path)), f'drawn_{k}.png')
            Image.fromarray(g).save(fn)
            files[k] = fn
        body['frame'] = dict(body['frame'], mask_grid=dict(GRID), mask_files=files)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(body, f, indent=0)
