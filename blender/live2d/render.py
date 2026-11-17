"""Software rasteriser for evaluated Live2D poses (numpy; for extraction and reference sheets, not real time).

    img = render_pose(model, pose, height=1600)            # RGBA float32 (straight alpha), crop = canvas
    ids = render_ids(model, pose, height=800)              # per-pixel top art-mesh index (-1 = none) + alpha
Also returns the canvas->pixel transform so callers can map model coordinates into the picture.
"""
import numpy as np


class View:
    """model units -> pixel coordinates of a rendered picture"""
    def __init__(self, canvas, height, crop=None, pad=0.0):
        ppu, ox, oy, cw, ch = canvas['ppu'], canvas['ox'], canvas['oy'], canvas['w'], canvas['h']
        if crop is None:  # canvas rect in model units (y DOWN like the canvas): x in [-ox, cw-ox]/ppu, y in [-oy, ch-oy]/ppu
            crop = (-ox / ppu, -oy / ppu, (cw - ox) / ppu, (ch - oy) / ppu)
        x0, y0, x1, y1 = crop
        w, h = x1 - x0, y1 - y0
        x0 -= w * pad; x1 += w * pad; y0 -= h * pad; y1 += h * pad
        self.crop = (x0, y0, x1, y1)
        self.scale = height / (y1 - y0)
        self.H = int(round(height))
        self.W = int(round((x1 - x0) * self.scale))

    def px(self, xy):
        xy = np.asarray(xy, np.float64)
        return np.stack([(xy[..., 0] - self.crop[0]) * self.scale, (xy[..., 1] - self.crop[1]) * self.scale], -1)

    def model(self, pxy):
        pxy = np.asarray(pxy, np.float64)
        return np.stack([pxy[..., 0] / self.scale + self.crop[0], pxy[..., 1] / self.scale + self.crop[1]], -1)


def raster_mesh(P, tri, W, H, attrs=None):
    """Rasterise triangles (pixel coords P (V,2)); returns (mask HxW bool, attr images) with barycentric-interpolated
    per-vertex attributes (attrs: (V,K)). Pixel centres at +0.5."""
    cover = np.zeros((H, W), bool)
    K = 0 if attrs is None else attrs.shape[1]
    out = np.zeros((H, W, K), np.float32) if K else None
    for a, b, c in tri:
        pa, pb, pc = P[a], P[b], P[c]
        x0 = max(int(np.floor(min(pa[0], pb[0], pc[0]))), 0); x1 = min(int(np.ceil(max(pa[0], pb[0], pc[0]))), W - 1)
        y0 = max(int(np.floor(min(pa[1], pb[1], pc[1]))), 0); y1 = min(int(np.ceil(max(pa[1], pb[1], pc[1]))), H - 1)
        if x1 < x0 or y1 < y0:
            continue
        d = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pc[0] - pa[0]) * (pb[1] - pa[1])
        if abs(d) < 1e-12:
            continue
        xs = np.arange(x0, x1 + 1) + 0.5
        ys = np.arange(y0, y1 + 1)[:, None] + 0.5
        w1 = ((xs - pa[0]) * (pc[1] - pa[1]) - (pc[0] - pa[0]) * (ys - pa[1])) / d
        w2 = ((pb[0] - pa[0]) * (ys - pa[1]) - (xs - pa[0]) * (pb[1] - pa[1])) / d
        w0 = 1 - w1 - w2
        e = -1e-6
        m = (w0 >= e) & (w1 >= e) & (w2 >= e)
        if not m.any():
            continue
        sub = cover[y0:y1 + 1, x0:x1 + 1]
        sub |= m
        if K:
            val = w0[..., None] * attrs[a] + w1[..., None] * attrs[b] + w2[..., None] * attrs[c]
            o = out[y0:y1 + 1, x0:x1 + 1]
            o[m] = val[m]
    return cover, out


def sample(tex, uv):
    """bilinear texture lookup; tex (h,w,4) float, uv (...,2) in [0,1], v measured from the TOP of the image"""
    h, w = tex.shape[:2]
    x = np.clip(uv[..., 0] * w - 0.5, 0, w - 1)
    y = np.clip(uv[..., 1] * h - 0.5, 0, h - 1)
    x0 = np.floor(x).astype(int); y0 = np.floor(y).astype(int)
    x1 = np.minimum(x0 + 1, w - 1); y1 = np.minimum(y0 + 1, h - 1)
    fx = (x - x0)[..., None]; fy = (y - y0)[..., None]
    # premultiply to avoid dark fringes
    t = tex
    c = (t[y0, x0] * (1 - fx) * (1 - fy) + t[y0, x1] * fx * (1 - fy) + t[y1, x0] * (1 - fx) * fy + t[y1, x1] * fx * fy)
    return c


def premul(tex):
    t = tex.astype(np.float32).copy()
    t[..., :3] *= t[..., 3:4]
    return t


def drawable_layer(model, pose, a, view, ss=1, opacity=True):
    """premultiplied RGBA layer (H,W,4) of one art mesh (no mask applied) + its bbox"""
    W, H = view.W * ss, view.H * ss
    P = view.px(pose.positions[a]) * ss
    uv = model.moc.art_uv[a].astype(np.float64)
    cover, att = raster_mesh(P, model.moc.art_tri[a], W, H, uv)
    tex = model.textures_premul[int(model.moc.s.arts.textureNo[a])]
    col = np.zeros((H, W, 4), np.float32)
    if cover.any():
        col[cover] = sample(tex, att[cover])
    if opacity:
        col *= float(np.clip(pose.opacity[a], 0, 1))
    return col


def render_pose(model, pose, height=1600, crop=None, pad=0.0, ss=2, only=None, exclude=None, bg=None, view=None):
    """Composite the pose. only/exclude: sets of art-mesh indices. Returns (RGBA straight-alpha float32, view)."""
    view = view or View(model.moc.canvas, height, crop, pad)
    W, H = view.W * ss, view.H * ss
    acc = np.zeros((H, W, 4), np.float32)
    cache, mcache = {}, {}
    flags = model.moc.s.arts.flags

    def layer(a):
        if a not in cache:
            cache[a] = drawable_layer(model, pose, a, view, ss)
        return cache[a]

    def mask_alpha(a):  # masks use the shape + texture alpha, not the mask mesh's own opacity
        if a not in mcache:
            mcache[a] = drawable_layer(model, pose, a, view, ss, opacity=False)[..., 3]
        return mcache[a]

    s = model.moc.s
    for a in pose.order:
        if only is not None and a not in only:
            continue
        if exclude is not None and a in exclude:
            continue
        L = layer(a).copy()
        mb, mc = int(s.arts.maskBegin[a]), int(s.arts.maskCount[a])
        if mc:
            m = np.zeros((H, W), np.float32)
            for k in range(mb, mb + mc):
                mi = int(s.masks.art[k])
                if mi >= 0:
                    m = np.maximum(m, mask_alpha(mi))
            if flags[a] >> 3 & 1:
                m = 1 - m
            L *= m[..., None]
        mode = int(flags[a]) & 3
        if mode == 0:
            acc = L + acc * (1 - L[..., 3:4])
        elif mode == 1:  # additive
            acc[..., :3] += L[..., :3]
        else:  # multiplicative
            acc[..., :3] = acc[..., :3] * (1 - L[..., 3:4]) + acc[..., :3] * L[..., :3]
    if ss > 1:
        acc = acc.reshape(view.H, ss, view.W, ss, 4).mean((1, 3))
    out = acc.copy()
    a = out[..., 3:4]
    out[..., :3] = np.where(a > 1e-5, out[..., :3] / np.maximum(a, 1e-5), 0)
    out = np.clip(out, 0, 1)
    if bg is not None:
        b = np.array(bg, np.float32)
        out[..., :3] = out[..., :3] * a + b[:3] * (1 - a)
        out[..., 3] = 1
    return out, view


def render_ids(model, pose, view, alpha_min=0.35):
    """per-pixel index of the top-most (normal blend) art mesh with alpha >= alpha_min, masks honoured; -1 = none"""
    W, H = view.W, view.H
    ids = np.full((H, W), -1, np.int32)
    s = model.moc.s
    cache, mcache = {}, {}

    def alpha(a):
        if a not in cache:
            cache[a] = drawable_layer(model, pose, a, view, 1)[..., 3]
        return cache[a]

    def mask_alpha(a):
        if a not in mcache:
            mcache[a] = drawable_layer(model, pose, a, view, 1, opacity=False)[..., 3]
        return mcache[a]

    for a in pose.order:
        if int(s.arts.flags[a]) & 3:
            continue
        al = alpha(a)
        mb, mc = int(s.arts.maskBegin[a]), int(s.arts.maskCount[a])
        if mc:
            m = np.zeros((H, W), np.float32)
            for k in range(mb, mb + mc):
                mi = int(s.masks.art[k])
                if mi >= 0:
                    m = np.maximum(m, mask_alpha(mi))
            if s.arts.flags[a] >> 3 & 1:
                m = 1 - m
            al = al * m
        ids[al >= alpha_min] = a
    return ids
