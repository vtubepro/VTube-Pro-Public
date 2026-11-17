"""
Comic / semi-real face finishing for MakeHuman (MPFB, blender/human_creator) GLB avatars — numpy only.

    hf = HFace(model)                  # landmarks from geometry: eyeballs, eye openings, nose, mouth, chin, ears
    hf.split_face(size=2048)           # the head front gets its own primitive, material and 2K texture with a
                                       # low-distortion cylindrical UV (MakeHuman's atlas gives a face ~340 px)
    hf.paint(params)                   # comic skin: flat tones, occlusion darks, designed lines, brows, lash lines,
                                       # stubble, beard base, scars, blush, lips (vector shapes, see sdf.py)
    hf.shading_normals(...)            # Laplacian-smoothed normals: big clean cel shapes that still follow planes
    hf.beard_shell(params)             # a jagged-edged beard/moustache shell riding the skin (volume + silhouette)
    hf.paint_eyes(params)              # comic iris on the eyeballs
    hf.finish(); model.save(path)

Coordinates: glTF as exported by human_creator: +Y up, the face looks toward +Z, character LEFT = +X
(= the viewer's right; the stage key light comes from the viewer's upper right, i.e. +X).
Face space for painting: s = R * atan2(x, z - zc) (arc length around the head axis), y = height.
"""
from __future__ import annotations

import copy

import numpy as np

from anime_creator import imgio
from anime_creator.vroid import Model, MeshData

from . import sdf as S
from .raster import posmap, dilate, grow, zraster, read_mesh_merged


def lin(c):
    """sRGB 0..1 -> linear (glTF colour factors are linear)."""
    c = np.asarray(c, np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def deep_merge(a, b):
    out = copy.deepcopy(a)
    for k, v in (b or {}).items():
        out[k] = deep_merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else copy.deepcopy(v)
    return out


class EyeOpen:
    """Visible-eyeball outline (front view) of one eye in face space (s, y): upper / lower lid curves."""

    def __init__(self, st, top, sb, bot, center3):
        self.st, self.tops, self.sb, self.bots = st, top, sb, bot
        self.c3 = center3
        self.cx = float((min(st[0], sb[0]) + max(st[-1], sb[-1])) / 2)
        self.ew = float((max(st[-1], sb[-1]) - min(st[0], sb[0])) / 2)
        self.sgn = 1.0 if self.cx > 0 else -1.0
        self.cy = float((top.max() + bot.min()) / 2); self.eh = float((top.max() - bot.min()) / 2)
        self.corner_out = np.array([self.x_of(1.0), float(np.interp(self.x_of(1.0), st, top))])
        self.corner_in = np.array([self.x_of(-1.0), float(np.interp(self.x_of(-1.0), st, top))])

    def ytop(self, X):
        return np.interp(X, self.st, self.tops)

    def ylow(self, X):
        return np.interp(X, self.sb, self.bots)

    def u(self, X):
        return (X - self.cx) * self.sgn / self.ew

    def x_of(self, u):
        return self.cx + np.asarray(u) * self.ew * self.sgn


class HFace:
    def __init__(self, m: Model, log=print, mouth_hint=None):
        self.m = m; self.log = log
        self.mouth_hint = mouth_hint
        self.bi = m.mesh_index('Body')
        self.d = read_mesh_merged(m, self.bi)
        ei = m.mesh_index('Eyes')
        self.de = read_mesh_merged(m, ei) if ei is not None else None
        self.ei = ei
        self.skin_mat = self.d.prims[0]['material']
        self._landmarks()
        D = self.D
        self.eb = (self.eyes[0].cy - self.mouth_y) / D
        self.nb = (self.nose[1] - self.mouth_y) / D
        self.cb = (self.chin[1] - self.mouth_y) / D

    # ------------------------------------------------------------------ landmarks
    def _landmarks(self):
        d = self.d
        P = d.P
        de = self.de
        EP = de.P
        L = EP[EP[:, 0] > 0]; R = EP[EP[:, 0] < 0]
        self.eyeballs = []
        self.virtual_eye = None
        for q in (L, R):
            if len(q) < 10:            # one eyeball removed (e.g. under an eye patch): mirror the other one
                continue
            c = (q.max(0) + q.min(0)) / 2
            r = float((q.max(0) - q.min(0)).max() / 2)
            self.eyeballs.append((c, r))
        if len(self.eyeballs) == 1:
            c, r = self.eyeballs[0]
            self.virtual_eye = 1 if c[0] > 0 else 0
            mc = c * np.array([-1, 1, 1])
            self.eyeballs = [(c, r), (mc, r)] if c[0] > 0 else [(mc, r), (c, r)]
        ey = float(np.mean([c[1] for c, _ in self.eyeballs]))
        ez = float(np.mean([c[2] for c, _ in self.eyeballs]))
        ex = float(np.mean([abs(c[0]) for c, _ in self.eyeballs]))
        self.eye_y = ey
        # head axis: vertical line through the skull centre (behind the eyes)
        cap = P[(P[:, 1] > ey) & (P[:, 1] < ey + 0.08)]
        self.zc = float((cap[:, 2].max() + cap[:, 2].min()) / 2)
        top = P[(np.abs(P[:, 0]) < 0.02) & (P[:, 1] > ey)]
        self.crown_y = float(top[:, 1].max())
        # front raster of skin + eyeballs -> visible eyeball regions = eye openings
        px = 0.00015
        x0, x1 = -ex - 0.035, ex + 0.035
        y0, y1 = ey - 0.03, ey + 0.03
        W = int((x1 - x0) / px); H = int((y1 - y0) / px)
        tris = d.prims[0]['indices'].reshape(-1, 3)
        cen = P[tris].mean(1)
        near = (np.abs(cen[:, 1] - ey) < 0.04) & (cen[:, 2] > ez - 0.03)
        zb, ib = zraster(P, tris[near], np.zeros(near.sum(), np.int64), x0, x1, y0, y1, W, H)
        etris = de.prims[0]['indices'].reshape(-1, 3)
        ecen = EP[etris].mean(1)
        zb, ib = zraster(EP, etris, np.where(ecen[:, 0] > 0, 1, 2), x0, x1, y0, y1, W, H, zb, ib)
        self.eyes = []
        xs_all = x0 + (np.arange(W) + 0.5) * px
        ys_all = y1 - (np.arange(H) + 0.5) * px
        self.R = float(np.median(np.hypot(cap[:, 0], cap[:, 2] - self.zc)))
        for lab, (c, r) in zip((1, 2), self.eyeballs):
            if self.virtual_eye is not None and lab - 1 == self.virtual_eye:
                self.eyes.append(None)
                continue
            vis = ib == lab
            cols = np.where(vis.sum(0) >= 2)[0]
            if len(cols) < 5:
                raise RuntimeError('face_kit: eye opening not found')
            ti = np.array([np.where(vis[:, j])[0].min() for j in cols]); bi = np.array([np.where(vis[:, j])[0].max() for j in cols])
            xs = xs_all[cols]
            # z of the lid just outside the opening (skin) -> face-space s
            zt = np.array([zb[max(i - 3, 0), j] for i, j in zip(ti, cols)]); zbt = np.array([zb[min(i + 3, H - 1), j] for i, j in zip(bi, cols)])
            zt = np.where(np.isfinite(zt), zt, c[2]); zbt = np.where(np.isfinite(zbt), zbt, c[2])
            st = self.R * np.arctan2(xs, zt - self.zc); sb = self.R * np.arctan2(xs, zbt - self.zc)
            o1 = np.argsort(st); o2 = np.argsort(sb)
            self.eyes.append(EyeOpen(st[o1], ys_all[ti][o1], sb[o2], ys_all[bi][o2], c))
        if self.virtual_eye is not None:
            real = next(e for e in self.eyes if e is not None)
            o1 = np.argsort(-real.st); o2 = np.argsort(-real.sb)
            self.eyes[self.virtual_eye] = EyeOpen(-real.st[o1], real.tops[o1], -real.sb[o2], real.bots[o2],
                                                  self.eyeballs[self.virtual_eye][0])
        self.eh = float(np.mean([e.eh for e in self.eyes])); self.ew = float(np.mean([e.ew for e in self.eyes]))
        # nose tip: most forward skin point on the midline between eyes and mouth
        mid = P[(np.abs(P[:, 0]) < 0.004) & (P[:, 1] < ey - 0.01) & (P[:, 1] > ey - 0.09)]
        self.nose = mid[np.argmax(mid[:, 2])]
        # mouth line: on the midline below the nose, the deepest (smallest z) notch between the lips
        ml = P[(np.abs(P[:, 0]) < 0.003) & (P[:, 1] < self.nose[1] - 0.012) & (P[:, 1] > self.nose[1] - 0.06) & (P[:, 2] > self.nose[2] - 0.05)]
        ml = ml[np.argsort(-ml[:, 1])]
        # front-most profile per height, then the notch = local minimum of z between the two lip maxima
        hs = np.round(ml[:, 1] / 0.0008).astype(int)
        prof = {}
        for h, p in zip(hs, ml):
            if h not in prof or p[2] > prof[h][2]:
                prof[h] = p
        pr = np.array([prof[h] for h in sorted(prof, reverse=True)])
        zz = pr[:, 2]
        i_up = int(np.argmax(zz[: len(zz) // 2 + 1]))
        rest = zz[i_up:]
        # lower lip max after the notch
        i_notch = i_up + int(np.argmin(rest[: max(3, len(rest) * 2 // 3)]))
        hint = getattr(self, 'mouth_hint', None)
        if hint is not None:
            # the deepest local notch of the profile close to the hint (a known mouth marker)
            loc = [i for i in range(1, len(zz) - 1) if zz[i] <= zz[i - 1] and zz[i] <= zz[i + 1]]
            loc = [i for i in loc if abs(pr[i, 1] - hint) < 0.005] or [int(np.argmin(np.abs(pr[:, 1] - hint)))]
            i_notch = min(loc, key=lambda i: abs(pr[i, 1] - hint))
        self.mouth = pr[i_notch]
        self.mouth_y = float(self.mouth[1])
        # chin: lowest front midline point
        ch = P[(np.abs(P[:, 0]) < 0.004) & (P[:, 1] < self.mouth_y - 0.01) & (P[:, 1] > self.mouth_y - 0.08) & (P[:, 2] > self.mouth[2] - 0.035)]
        self.chin = ch[np.argmin(ch[:, 1])] if len(ch) else np.array([0, self.mouth_y - 0.05, self.mouth[2]])
        # mouth corners: widest lip vertices near the mouth line (face front)
        band = P[(np.abs(P[:, 1] - self.mouth_y) < 0.004) & (P[:, 2] > self.mouth[2] - 0.03)]
        self.mouth_w = float(np.percentile(np.abs(band[:, 0]), 60)) if len(band) else 0.025
        self.log(f'face_kit: eyes y={ey:.4f} ew={self.ew:.4f} eh={self.eh:.4f}  nose y={self.nose[1]:.4f} mouth y={self.mouth_y:.4f} '
                 f'w={self.mouth_w:.4f} chin y={self.chin[1]:.4f} crown={self.crown_y:.4f} zc={self.zc:.4f} R={self.R:.4f}')

    # face space
    def fs(self, P):
        s = self.R * np.arctan2(P[..., 0], P[..., 2] - self.zc)
        return s, P[..., 1]

    # ------------------------------------------------------------------ own face primitive + UV
    def split_face(self, size: int = 2048, theta_max: float = 1.95, below_chin: float = 0.05):
        d = self.d
        tris = d.prims[0]['indices'].reshape(-1, 3)
        P = d.P
        th = np.arctan2(P[:, 0], P[:, 2] - self.zc)
        y_lo = float(self.chin[1]) - below_chin
        vin = (P[:, 1] > y_lo) & (np.abs(th) < theta_max)
        sel = vin[tris].all(1)
        # triangles hidden behind the face surface along the head's radius (mouth cavity, nostrils, eye sockets,
        # ear backs) would share cylindrical UVs with the surface in front of them: give them flat materials instead
        Q = np.stack([th * self.R, P[:, 1], np.hypot(P[:, 0], P[:, 2] - self.zc)], 1)
        cand = np.where(sel)[0]
        pxr = 0.0006
        gx0, gx1 = -theta_max * self.R, theta_max * self.R
        rb, _ = zraster(Q, tris[cand], np.zeros(len(cand), np.int64), gx0, gx1, y_lo, self.crown_y + 0.005,
                        int((gx1 - gx0) / pxr), int((self.crown_y + 0.005 - y_lo) / pxr))
        cq = Q[tris[cand]].mean(1)
        ci = np.clip(((self.crown_y + 0.005 - cq[:, 1]) / pxr).astype(int), 0, rb.shape[0] - 1)
        cj = np.clip(((cq[:, 0] - gx0) / pxr).astype(int), 0, rb.shape[1] - 1)
        hidden = cq[:, 2] < rb[ci, cj] - 0.0025
        inner = cand[hidden]
        sel[inner] = False
        ft = tris[sel]
        used = np.unique(ft)
        n0 = d.n
        remap = -np.ones(n0, np.int64); remap[used] = n0 + np.arange(len(used))
        d.P = np.concatenate([d.P, d.P[used]]); d.N = np.concatenate([d.N, d.N[used]])
        d.J = np.concatenate([d.J, d.J[used]]); d.W = np.concatenate([d.W, d.W[used]])
        y_hi = self.crown_y + 0.005
        u = (th[used] + theta_max) / (2 * theta_max)
        v = (y_hi - P[used, 1]) / (y_hi - y_lo)
        d.UV = np.concatenate([d.UV, np.stack([u, v], 1)])
        for t in d.targets:
            for k in list(t):
                t[k] = np.concatenate([t[k], t[k][used]])
        body_keep = ~sel
        body_keep[inner] = False
        d.prims[0]['indices'] = tris[body_keep].reshape(-1).astype(np.uint32)
        self._inner_tris = tris[inner]
        # new material + image
        m = self.m
        J = m.J
        mat = copy.deepcopy(J['materials'][self.skin_mat]); mat['name'] = 'FaceSkin'
        for mm in (mat, J['materials'][self.skin_mat]):
            mm.pop('normalTexture', None)
            pbr = mm.setdefault('pbrMetallicRoughness', {})
            pbr.pop('metallicRoughnessTexture', None); pbr['metallicFactor'] = 0.0; pbr['roughnessFactor'] = 1.0
        blank = np.ones((size, size, 4), np.float32)
        ii = m.g.add_image(imgio.encode(blank), 'face_skin')
        ti = m.g.add_texture(ii, 0)
        mat['pbrMetallicRoughness']['baseColorTexture'] = {'index': ti}
        J['materials'].append(mat)
        self.face_mat = len(J['materials']) - 1
        self.face_img = ii
        d.prims.append({'material': self.face_mat, 'indices': remap[ft].reshape(-1).astype(np.uint32), 'mode': 4})
        self.face_prim = len(d.prims) - 1
        self.face_verts = np.arange(n0, n0 + len(used))
        self.face_src = used
        self.size = size
        self.uvmap = (theta_max, y_hi, y_lo)
        self._inner_prims()
        self.log(f'face_kit: face primitive {len(ft)} tris / {len(used)} verts, own {size}px texture')

    def _inner_prims(self, cavity='#4a1c22', teeth='#f2eee6', inner='#9a5a4c'):
        """Hidden triangles -> flat materials: mouth cavity (dark), a FLAT drawn upper-teeth band (house rule:
        never modelled teeth), everything else (nostrils, sockets, ear backs) a dark skin tone."""
        d = self.d
        T = self._inner_tris
        if not len(T):
            return
        c = d.P[T].mean(1)
        nrm = np.cross(d.P[T[:, 1]] - d.P[T[:, 0]], d.P[T[:, 2]] - d.P[T[:, 0]])
        mouth = (np.abs(c[:, 0]) < self.mouth_w * 1.5) & (np.abs(c[:, 1] - self.mouth_y) < 0.03) & (c[:, 2] < self.mouth[2] + 0.005)
        depth = self.mouth[2] - c[:, 2]
        th = mouth & (depth > 0.003) & bool(getattr(self, 'want_teeth', True)) & (depth < 0.016) & (c[:, 1] > self.mouth_y - 0.001) & (c[:, 1] < self.mouth_y + 0.010) & (np.abs(c[:, 0]) < self.mouth_w * 0.95)
        J = self.m.J
        self.inner_mats = {}
        # hidden lid folds roll out on a blink: they must be plain skin, not the dark inner tone
        lid = np.zeros(len(T), bool)
        for c_, r_ in self.eyeballs:
            lid |= np.linalg.norm(c - c_, axis=1) < r_ * 2.6
        lid &= ~mouth
        skin_col = getattr(self, 'lid_skin', '#d8a47e')
        for name, selm, col in (('MouthCavity', mouth & ~th, cavity), ('TeethFlat', th, teeth), ('FaceInner', ~mouth & ~lid, inner),
                                ('LidSkin', lid, skin_col)):
            if not selm.any():
                continue
            J['materials'].append({'name': name, 'extras': {'vtpRim': 0.05}, 'doubleSided': True,
                                   'pbrMetallicRoughness': {'baseColorFactor': [*map(float, lin(S.hexc(col))), 1.0], 'metallicFactor': 0.0, 'roughnessFactor': 1.0}})
            d.prims.append({'material': len(J['materials']) - 1, 'indices': T[selm].reshape(-1).astype(np.uint32), 'mode': 4})
        self.log(f'face_kit: hidden tris -> cavity {int((mouth & ~th).sum())}, teeth {int(th.sum())}, inner {int((~mouth).sum())}')

    def body_image(self):
        J = self.m.J
        return J['textures'][J['materials'][self.skin_mat]['pbrMetallicRoughness']['baseColorTexture']['index']]['source']

    # ------------------------------------------------------------------ painting
    DEFAULTS = {
        'toLight': 1.0, 'shadeShift': 0.0,
        'skin': '#e2ab88', 'skinShade': '#b87466', 'flush': '#d9806c', 'flushAlpha': 0.22, 'lip': '#c98a78',
        'line': '#3a211c', 'lineW': 1.0,
        'hair': '#3a2419', 'hairline': 2.05,
        'brow': {'color': '#3b2419', 'inner': [0.13, 1.25], 'peak': [0.52, 1.36], 'outer': [0.9, 1.25],
                 'w': [0.10, 0.085, 0.02], 'scowl': 0.05, 'jag': 0.25},
        'lids': {'upper': 0.045, 'lower': 0.018, 'crease': 0.30, 'bag': 0.30, 'wing': 0.12},
        'nose': {'bridge': True, 'wings': True, 'nostrils': True, 'under': 0.8},
        'folds': {'naso': 1.0, 'furrow': 1.0, 'cheek': 0.8, 'crow': 0.6, 'forehead': 0.0},
        'socket': 0.55,
        'stubble': {'color': '#8a5a45', 'alpha': 0.0},
        'beard': None,
        'scars': [],
        'patch': None,
        'eyes': {'iris': '#3f9a3a', 'inner': '#e2c33a', 'ring': '#1a2616', 'pupil': 0.3, 'size': 1.0, 'white': '#f4efe6'},
    }

    @property
    def D(self):
        return float(self.eyes[0].cx - self.eyes[1].cx)

    def _ab(self, P):
        s, y = self.fs(P)
        D = self.D
        return s / D, (y - self.mouth_y) / D

    def paint(self, prm: dict):
        p = deep_merge(self.DEFAULTS, prm)
        self.p = p
        d = self.d
        N_ = self.size
        tris = d.prims[self.face_prim]['indices']
        mask, P, Nrm = posmap(d.P, d.N, d.UV, tris, N_, N_)
        a, b = self._ab(P)
        D = self.D
        dx = np.hypot(np.diff(a, axis=1), np.diff(b, axis=1))[mask[:, 1:] & mask[:, :-1]]
        px = float(np.median(dx))
        out = np.zeros((N_, N_, 4), np.float32)
        out[..., :3] = S.hexc(p['skin'])
        out[..., 3] = 1
        self.px = px
        K = dict(a=a, b=b, out=out, px=px, m=mask, L=p['toLight'])
        LC = S.hexc(p['line'])
        SH = S.hexc(p['skinShade'])
        deep = np.clip(SH * 0.72, 0, 1)
        E = [(e.cx / D, (e.cy - self.mouth_y) / D, e) for e in self.eyes]
        nb = (self.nose[1] - self.mouth_y) / D
        cb = (self.chin[1] - self.mouth_y) / D
        eb = E[0][1]
        self.nb, self.cb, self.eb = nb, cb, eb

        tmax, y_hi, y_lo = self.uvmap

        def win(a0, a1, b0, b1):
            """Texel window covering the face-space box (the cylindrical UV is linear in a and b)."""
            c0 = int(((a0 * D / self.R) + tmax) / (2 * tmax) * N_) - 3; c1 = int(((a1 * D / self.R) + tmax) / (2 * tmax) * N_) + 4
            r0 = int((y_hi - (b1 * D + self.mouth_y)) / (y_hi - y_lo) * N_) - 3; r1 = int((y_hi - (b0 * D + self.mouth_y)) / (y_hi - y_lo) * N_) + 4
            return slice(max(r0, 0), min(r1, N_)), slice(max(c0, 0), min(c1, N_))

        def stroke(pts, w, col, alpha=1.0):
            pts = np.asarray(pts, np.float64)
            w = np.broadcast_to(np.asarray(w, np.float64) * p['lineW'], (len(pts),))
            m_ = float(w.max()) + 4 * px
            ys, xs_ = win(pts[:, 0].min() - m_, pts[:, 0].max() + m_, pts[:, 1].min() - m_, pts[:, 1].max() + m_)
            if ys.stop <= ys.start or xs_.stop <= xs_.start:
                return
            dd, _ = S.polyline(a[ys, xs_], b[ys, xs_], pts, w)
            S.over(out[ys, xs_], col, S.cover(dd, px) * mask[ys, xs_] * alpha)

        def curve(ctrl, n=24):
            return S.bezier(*[np.asarray(c, np.float64) for c in ctrl], n=n)

        def region(dist, col, alpha=1.0, soft=0.0):
            S.over(out, col, S.cover(dist, px, soft) * mask * alpha)

        tp = lambda n, e=0.6, lo=0.0: S.taper(np.linspace(0, 1, n), e, lo)  # noqa: E731

        # --- hair colour above the hairline (under the hair mesh, so gaps read as hair)
        A_ = np.abs(a)
        # hairline: rounded forehead curve dropping to the temples + sideburn, small strand jag
        tt = np.clip(A_ / 1.45, 0, 1)
        hl = p['hairline'] - (p['hairline'] - (eb + 0.15)) * tt ** 2.2
        hl = hl - p.get('peak', 0.06) * (1 - S.smoothstep(0.0, 0.18, A_))
        hl = hl - p.get('hairJag', 0.02) * S.vnoise1(a * 22.0, 2.0) - 0.012 * S.vnoise1(a * 61.0, 5.0)
        hl = np.where(A_ > 1.45, eb - 0.25 + 0.3 * S.smoothstep(1.45, 1.75, A_), hl)
        region(hl - b, S.hexc(p['hair']), p.get('hairAlpha', 1.0), soft=0.01)
        # --- warm flush: nose tip, cheeks, ears
        fl = S.hexc(p['flush'])
        region(S.ellipse(a, b, 0, nb, 0.14, 0.12), fl, p['flushAlpha'] * p.get('noseFlush', 1.0), soft=0.12)
        for sg in (-1, 1):
            region(S.ellipse(a, b, sg * 0.72, eb - 0.55, 0.28 * p.get('blushSize', 1.0), 0.16 * p.get('blushSize', 1.0)), fl, p['flushAlpha'] * 0.8, soft=0.2 * p.get('blushSize', 1.0))
            region(S.ellipse(a, b, sg * 2.45, eb - 0.25, 0.35, 0.55), fl, p['flushAlpha'] * 1.3, soft=0.2)
        # --- stubble tone (the shaved parts around the beard)
        st = p['stubble']
        if st['alpha'] > 0 and p['beard']:
            self._beard_mask(K, p['beard'], grow_=0.18, out_col=S.hexc(st['color']), alpha=st['alpha'])
        # --- authored cel plane shadows (comic faces): hard-edged shade shapes describing the planes the smoothed
        #     normals no longer show. Full strength on the shadow side (away from the key light), a lighter echo on
        #     the lit side. Shapes are polygons in (a, b) mirrored by side.
        pl = p.get('planes')
        if pl:
            PS = S.hexc(pl.get('color', p['skinShade']))
            L = p['toLight']
            shapes = {
                # hollow under the cheekbone: a long wedge from the ear toward the mouth corner
                'cheek': [[1.05, eb - 0.48], [0.62, eb - 0.62], [0.38, -0.22], [0.52, -0.3], [0.98, eb - 0.8], [1.2, eb - 0.75]],
                # jaw side plane: from below the ear to the chin
                'jaw': [[1.25, eb - 0.8], [1.05, cb + 0.35], [0.55, cb + 0.02], [0.2, cb - 0.05], [0.35, cb - 0.2], [1.3, cb + 0.2]],
                # brow ridge underside / temple
                'brow': [[0.18, eb + 0.08], [0.55, eb + 0.2], [1.0, eb + 0.16], [1.2, eb + 0.02], [1.15, eb + 0.3], [0.5, eb + 0.34]],
                # nose side plane (shadow side only)
                'nose': [[0.07, eb - 0.05], [0.13, (eb + nb) / 2], [0.19, nb + 0.02], [0.1, nb + 0.06], [0.05, (eb + nb) / 2 + 0.05]],
                # nasolabial fold shadow (outside the fold line)
                'naso': [[0.2, nb + 0.04], [0.36, 0.0], [0.4, -0.3], [0.46, -0.28], [0.44, 0.02], [0.28, nb + 0.06]],
            }
            for nm_, poly in shapes.items():
                st_ = pl.get(nm_, 0.0)
                if st_ <= 0:
                    continue
                for sg in (-1, 1):
                    k = st_ if sg == -L else st_ * pl.get('litSide', 0.35)
                    if nm_ == 'nose' and sg != -L:
                        continue
                    pp = np.array(poly) * np.array([sg, 1.0])
                    ya, yb = win(pp[:, 0].min() - 0.05, pp[:, 0].max() + 0.05, pp[:, 1].min() - 0.05, pp[:, 1].max() + 0.05)
                    S.over(out[ya, yb], PS, S.cover(S.polygon(a[ya, yb], b[ya, yb], pp), px, pl.get('soft', 0.004)) * mask[ya, yb] * k)
        # --- key-light cel shadow shapes baked from a SCULPT's smoothed normals (hard 2-tone, like the drawing)
        ks = p.get('keyShadow')
        if ks and getattr(self, 'normal_fn', None) is not None:
            from scipy import ndimage
            Lk = np.array([1.55 * p['toLight'], 2.3, 2.35]); Lk /= np.linalg.norm(Lk)
            Nt = np.zeros(mask.shape + (3,), np.float32)
            Nt[mask] = self.normal_fn(P[mask])
            ndl = (Nt * Lk).sum(-1)
            sh_ = mask & (ndl < ks['thr']) & (b > cb - 0.35) & (b < p['hairline'] - 0.1) & (np.abs(a) < ks.get('maxA', 1.45)) & ((b < ks.get('maxB', 9.0)) | (np.abs(a) > 0.95))
            sh_ = ndimage.binary_opening(sh_, iterations=ks.get('open', 2))
            sh_ = ndimage.binary_closing(sh_, iterations=ks.get('open', 2))
            lab_, nl_ = ndimage.label(sh_)
            if nl_:
                sz_ = ndimage.sum(sh_, lab_, index=np.arange(1, nl_ + 1))
                keep_ = np.zeros(nl_ + 1, bool); keep_[1:] = sz_ >= ks.get('minIsland', 4000)
                sh_ = keep_[lab_]
            S.over(out, S.hexc(ks['color']), sh_.astype(np.float32) * ks.get('alpha', 1.0))
            dp_ = mask & (ndl < ks.get('deep', -0.25)) & sh_
            dp_ = ndimage.binary_opening(dp_, iterations=2)
            S.over(out, S.hexc(ks.get('deepColor', ks['color'])), dp_.astype(np.float32) * 0.9)
            self.log(f'face_kit: key-light shadow shapes on {int(sh_.sum())} texels')
        # --- eye socket shadow (under the brow ridge, strongest near the nose) + lids
        lid = p['lids']
        for ea, ebb, e in E:
            sg = e.sgn
            if p['socket'] > 0:
                ds = S.ellipse(a, b, ea - sg * 0.12, ebb + 0.10, 0.30, 0.16, rot=-sg * 0.35)
                region(ds, SH, p['socket'] * 0.65, soft=0.05)
            xs = np.linspace(-1.05, 1.08, 40)
            sx = e.x_of(xs)
            pts = np.stack([sx / D, (e.ytop(sx) - self.mouth_y) / D + lid.get('lift', 0.002)], 1)
            w = lid['upper'] * (0.35 + 0.65 * np.sin(np.pi * np.clip((xs + 1.05) / 2.13, 0, 1)) ** 0.6)
            w[-8:] *= np.linspace(1, 1.4, 8)
            stroke(pts, w, LC)
            for k in range(int(lid.get('spikes', 0))):
                t0 = 0.72 + 0.26 * k / max(1, lid.get('spikes', 1) - 1)
                i0 = int(t0 * (len(pts) - 1))
                base = pts[i0]
                ang = np.radians(65 - 35 * t0)
                tip = base + np.array([sg * np.cos(ang), np.sin(ang)]) * lid.get('spikeLen', 0.06)
                stroke([base, (base + tip) / 2 + np.array([sg * 0.008, 0]), tip], [lid['upper'] * 1.2, lid['upper'] * 0.6, 0.002], LC)
            if lid['wing'] > 0:
                oc = pts[-1]
                stroke([oc, oc + np.array([sg * lid['wing'], -0.03])], [lid['upper'] * 1.1, 0.004], LC)
            xs2 = np.linspace(-0.2, 1.0, 20)
            sx2 = e.x_of(xs2)
            pts2 = np.stack([sx2 / D, (e.ylow(sx2) - self.mouth_y) / D - 0.004], 1)
            stroke(pts2, lid['lower'] * tp(20, 0.5), LC, 0.85)
            xs3 = np.linspace(-0.55, 0.95, 20)
            sx3 = e.x_of(xs3)
            pts3 = np.stack([sx3 / D, (e.ytop(sx3) - self.mouth_y) / D + lid['crease'] * 0.18 * (1 - 0.3 * xs3 ** 2)], 1)
            stroke(pts3, 0.014 * tp(20, 0.7), np.clip(SH * 0.75, 0, 1), 0.9)
            if lid['bag'] > 0:
                xs4 = np.linspace(-0.3, 0.75, 16)
                sx4 = e.x_of(xs4)
                pts4 = np.stack([sx4 / D, (e.ylow(sx4) - self.mouth_y) / D - 0.13 - 0.05 * (1 - xs4 ** 2)], 1)
                stroke(pts4, 0.012 * tp(16, 0.7), np.clip(SH * 0.8, 0, 1), lid['bag'])
            if p['folds']['crow'] > 0:
                o = np.array([e.x_of(1.25) / D, (e.cy - self.mouth_y) / D])
                for ang in (0.35, -0.1):
                    q = o + np.array([sg * 0.16 * np.cos(ang), 0.16 * np.sin(ang)])
                    stroke([o, q], [0.012, 0.002], np.clip(SH * 0.8, 0, 1), p['folds']['crow'])
        # --- brows
        br = p['brow']
        BC = S.hexc(br['color'])
        for ea, ebb, e in E:
            sg = e.sgn
            i0 = np.array([sg * br['inner'][0], eb - 1 + br['inner'][1] - br['scowl']])
            pk = np.array([sg * br['peak'][0], eb - 1 + br['peak'][1]])
            o0 = np.array([sg * br['outer'][0], eb - 1 + br['outer'][1]])
            pts = curve([i0, pk, o0], 30)
            tt = np.linspace(0, 1, 30)
            w = np.interp(tt, [0, 0.45, 1], br['w'])
            stroke(pts, w, BC)
            if br['jag'] > 0:
                for k in range(9):
                    t0 = 0.08 + k * 0.1
                    base = pts[int(t0 * 29)]
                    wk = float(np.interp(t0, [0, 0.45, 1], br['w']))
                    tip = base + np.array([sg * 0.05, wk * 0.5 + 0.03 * br['jag']])
                    stroke([base, tip], [wk * 0.55, 0.002], BC)
        # --- nose
        nz = p['nose']
        L = p['toLight']
        if nz['under'] > 0:
            region(S.ellipse(a, b, 0, nb - 0.075, 0.16, 0.05), SH, nz['under'] * 0.85, soft=0.01)
        if nz['nostrils']:
            for sg in (-1, 1):
                region(S.ellipse(a, b, sg * 0.07, nb - 0.075, 0.03, 0.016, rot=sg * 0.4), deep, 0.9)
        if nz['wings']:
            for sg in (-1, 1):
                pts = curve([[sg * 0.10, nb + 0.06], [sg * 0.175, nb + 0.0], [sg * 0.13, nb - 0.075]], 16)
                stroke(pts, 0.016 * nz.get('w', 1.0) * tp(16, 0.5, 0.3), LC, min(1.0, 0.75 * nz.get('w', 1.0)))
        if nz.get('tip', 0) > 0:
            sg = -L
            nw = nz.get('w', 1.0)
            # nose tip + wing outline on the shadow side (the drawing's strongest nose mark)
            pts = curve([[sg * 0.02, nb - 0.05], [sg * 0.13, nb - 0.07], [sg * 0.17, nb + 0.02]], 16)
            stroke(pts, 0.02 * nw * tp(16, 0.5, 0.2), LC, nz['tip'])
            pts = curve([[-sg * 0.06, nb - 0.06], [0, nb - 0.075], [sg * 0.03, nb - 0.06]], 12)
            stroke(pts, 0.014 * nw * tp(12, 0.6), LC, nz['tip'] * 0.8)
        if nz['bridge']:
            sg = -L
            pts = curve([[sg * 0.09, eb - 0.02], [sg * 0.075, (eb + nb) / 2], [sg * 0.05, nb + 0.08]], 20)
            nw = nz.get('w', 1.0)
            stroke(pts, 0.016 * nw * tp(20), LC, min(1.0, 0.8 * nw))
            pts = curve([[-0.05, nb - 0.035], [0, nb - 0.06], [0.05, nb - 0.035]], 12)
            stroke(pts, 0.012 * nw * tp(12), LC, min(1.0, 0.55 * nw))
        # --- folds
        fo = p['folds']
        if fo['naso'] > 0:
            for sg in (-1, 1):
                pts = curve([[sg * 0.2, nb + 0.03], [sg * 0.33, -0.05], [sg * 0.36, -0.32]], 24)
                stroke(pts, 0.02 * tp(24, 0.5), LC, fo['naso'])
        if fo['furrow'] > 0:
            for sg, ln in ((-1, 1.0), (1, 0.7)):
                pts = curve([[sg * 0.05, eb + 0.28], [sg * 0.065, eb + 0.18], [sg * 0.05, eb + 0.08]], 12)
                stroke(pts, 0.016 * tp(12), LC, fo['furrow'] * ln)
        if fo['cheek'] > 0:
            for sg in (-1, 1):
                pts = curve([[sg * 0.80, eb - 0.30], [sg * 0.72, eb - 0.55], [sg * 0.62, eb - 0.78]], 16)
                stroke(pts, 0.016 * tp(16), LC, fo['cheek'])
        if fo['forehead'] > 0:
            for k in range(2):
                yb = eb + 0.55 + k * 0.14
                pts = curve([[-0.45, yb], [0, yb + 0.03], [0.45, yb]], 20)
                stroke(pts, 0.012 * tp(20), np.clip(SH * 0.8, 0, 1), fo['forehead'])
        # --- lips (lower lip colour; the upper lip faces down = shadow plane)
        mw = self.mouth_w / D
        if not p.get('lipsFull'):
            region(S.ellipse(a, b, 0, -0.065, mw * 0.72, 0.055), S.hexc(p['lip']), 0.45, soft=0.03)
            region(S.ellipse(a, b, 0, 0.045, mw * 0.9, 0.05), SH, 0.45, soft=0.02)
            pts = curve([[-mw * 1.02, 0.0], [0, 0.012], [mw * 1.02, 0.0]], 24)
            stroke(pts, 0.022 * tp(24, 0.35, 0.25), LC)
        region(S.ellipse(a, b, 0, -0.19, mw * 0.55, 0.035), SH, 0.6, soft=0.02)
        if p.get('lipsFull'):
            LP = S.hexc(p['lip'])
            w_ = mw * p.get('lipW', 0.85)
            up_h, lo_h = p.get('lipUp', 0.07), p.get('lipLow', 0.1)
            upper = S.bezier([-w_, 0.0], [-0.55 * w_, up_h * 0.9], [-0.18 * w_, up_h * 1.1], n=10).tolist() +                     [[0.0, up_h * 0.82]] + S.bezier([0.18 * w_, up_h * 1.1], [0.55 * w_, up_h * 0.9], [w_, 0.0], n=10).tolist() +                     S.bezier([w_, 0.0], [0, 0.012], [-w_, 0.0], n=12).tolist()
            lower = S.bezier([-w_ * 0.96, -0.004], [0, -lo_h * 1.35], [w_ * 0.96, -0.004], n=24).tolist() +                     S.bezier([w_ * 0.96, -0.004], [0, 0.008], [-w_ * 0.96, -0.004], n=12).tolist()
            ya, yb = win(-w_ * 1.1, w_ * 1.1, -lo_h * 1.5, up_h * 1.5)
            aa, bb = a[ya, yb], b[ya, yb]
            S.over(out[ya, yb], np.clip(LP * 0.8, 0, 1), S.cover(S.polygon(aa, bb, upper), px, 0.004) * mask[ya, yb])
            S.over(out[ya, yb], LP, S.cover(S.polygon(aa, bb, lower), px, 0.004) * mask[ya, yb])
            S.over(out[ya, yb], np.clip(LP + 0.22, 0, 1), S.cover(S.ellipse(aa, bb, w_ * 0.18 * p['toLight'], -lo_h * 0.55, w_ * 0.28, lo_h * 0.18), px, 0.01) * mask[ya, yb] * 0.7)
            pts = curve([[-w_ * 0.9, 0.0], [0, 0.012], [w_ * 0.9, 0.0]], 24)
            stroke(pts, 0.018 * tp(24, 0.6, 0.0), np.clip(LP * 0.4, 0, 1))
        # --- beard from the SCULPT (the beard is geometry: colour it by a mask + its own relief)
        br = p.get('beardRelief')
        if br and getattr(self, 'relief_fn', None) is not None:
            rel = np.zeros(mask.shape, np.float32)
            rel[mask] = self.relief_fn(P[mask])
            from scipy import ndimage
            rough = ndimage.gaussian_filter(np.abs(rel), br.get('blur', 6))
            region_ok = (b < nb - br.get('below', 0.02)) & (np.abs(a) < br.get('width', 2.1)) & (b > cb - 0.8)
            # moustache band just under the nose + the lip hole
            mw = self.mouth_w / D
            lips = S.ellipse(a, b, 0, -0.06, mw * br.get('lipW', 0.75), br.get('lipH', 0.07)) < 0
            bm = mask & region_ok & (rough > br.get('rough', 0.00045)) & ~lips
            bm = ndimage.binary_opening(bm, iterations=2)
            bm = ndimage.binary_closing(bm, iterations=4)
            self.beard_mask_tex = bm
            BC = S.hexc(br['color']); BD = S.hexc(br['dark']); BL = S.hexc(br['light'])
            out[bm, :3] = BC
            dk = bm & (rel < -br.get('crease', 0.0005))
            out[dk, :3] = BD
            lt = bm & (rel > br.get('crest', 0.0007))
            out[lt, :3] = BL
            ink = bm & (rel < -br.get('ink', 0.0012))
            out[ink, :3] = np.clip(BD * 0.6, 0, 1)
        # --- sculpted creases elsewhere on the face become thin ink (wrinkles, lid folds, nostril edges)
        ci = p.get('creaseInk')
        if ci and getattr(self, 'relief_fn', None) is not None:
            rel2 = np.zeros(mask.shape, np.float32)
            rel2[mask] = self.relief_fn(P[mask])
            k = mask & (rel2 < -ci.get('thr', 0.0009)) & ~getattr(self, 'beard_mask_tex', np.zeros(mask.shape, bool))
            k &= (b > cb - 0.1) & (np.abs(a) < 1.6)
            for c_, r_ in self.eyeballs:                     # lids fold on a blink: no ink there
                k &= np.linalg.norm(P - c_, axis=-1) > r_ * 1.9
            S.over(out, LC, k.astype(np.float32) * ci.get('alpha', 0.6))
        # --- beard base (painted under the shell)
        if p['beard']:
            self._beard_mask(K, p['beard'], grow_=p['beard'].get('baseGrow', 0.025), out_col=S.hexc(p['beard'].get('under', p['beard']['color'])), alpha=1.0)
        # --- scars + eyepatch strap
        for sc in p['scars']:
            pts = np.asarray(sc['pts'], np.float64)
            pts = S.bezier(*pts, n=24) if len(pts) in (3, 4) else pts
            ww = sc.get('w', 0.018) * tp(len(pts), 0.5)
            stroke(pts, ww * 1.9, S.hexc(sc.get('edge', '#e7b49a')), 0.8)
            stroke(pts, ww, S.hexc(sc.get('color', '#5a2a24')))
        if p['patch'] and p['patch'].get('paintStrap', False):
            pa = p['patch']
            stroke(np.asarray(pa['strap'], np.float64), pa.get('strapW', 0.045), S.hexc(pa.get('color', '#1d1d20')))
        if p['lids'].get('ribbon'):
            # the upper lash line is a geometry ribbon riding the lid (lash_ribbon); every texel the blink drags
            # across the eye is plain skin, or its paint smears over the closed lid
            nm_ = d.target_names
            mv = np.zeros(d.n)
            for k in ('eyeBlinkLeft', 'eyeBlinkRight'):
                if k in nm_:
                    mv = np.maximum(mv, np.linalg.norm(d.targets[nm_.index(k)]['POSITION'], axis=1))
            Mv = np.zeros((d.n, 3)); Mv[:, 0] = mv
            _, MV, _ = posmap(Mv, None, d.UV, tris, N_, N_)
            for c_, r_ in self.eyeballs:
                near = mask & (np.linalg.norm(P - c_, axis=-1) < r_ * 2.0)
                out[near & (MV[..., 0] > p['lids'].get('blinkErase', 0.0006)), :3] = S.hexc(p['skin'])
        # texels of the lid folds (hidden behind the front surface at rest) unroll on a blink: plain skin there,
        # or the lash line smears into a dark blob over the closed eye
        for c_, r_ in self.eyeballs:
            box = mask & (np.linalg.norm(P - c_, axis=-1) < r_ * 1.9)
            if not box.any():
                continue
            fz = self._front_depth(c_[0] - r_ * 2, c_[0] + r_ * 2, c_[1] - r_ * 2, c_[1] + r_ * 2, px=0.00015, maxf=0.0, eyes=False)
            hid = box & (fz(P[..., 0], P[..., 1]) - P[..., 2] > p.get('lidHidden', 0.0006))
            # the lid margin faces into the eye (edge-on at rest): it becomes the whole lid on a blink
            hid |= box & (np.linalg.norm(P - c_, axis=-1) < r_ * 1.35) & (Nrm[..., 2] < p.get('lidMarginNz', 0.45))
            out[hid, :3] = S.hexc(p['skin'])
        out = dilate(out, mask, 8)
        self.face_tex = out
        self.K = K
        return out

    def _stroke(self, tex, pts, w, col, alpha=1.0):
        """Tapered stroke in face space (a, b) onto a face-UV texture (windowed: fast)."""
        K = self.K; a, b, px, mask = K['a'], K['b'], K['px'], K['m']
        tmax, y_hi, y_lo = self.uvmap; D = self.D; N_ = tex.shape[0]
        pts = np.asarray(pts, np.float64)
        w = np.broadcast_to(np.asarray(w, np.float64), (len(pts),))
        m_ = float(w.max()) + 4 * px
        a0, a1 = pts[:, 0].min() - m_, pts[:, 0].max() + m_; b0, b1 = pts[:, 1].min() - m_, pts[:, 1].max() + m_
        c0 = int(((a0 * D / self.R) + tmax) / (2 * tmax) * N_) - 3; c1 = int(((a1 * D / self.R) + tmax) / (2 * tmax) * N_) + 4
        r0 = int((y_hi - (b1 * D + self.mouth_y)) / (y_hi - y_lo) * N_) - 3; r1 = int((y_hi - (b0 * D + self.mouth_y)) / (y_hi - y_lo) * N_) + 4
        ys, xs = slice(max(r0, 0), min(r1, N_)), slice(max(c0, 0), min(c1, N_))
        if ys.stop <= ys.start or xs.stop <= xs.start:
            return
        dd, _ = S.polyline(a[ys, xs], b[ys, xs], pts, w)
        S.over(tex[ys, xs], col, S.cover(dd, px) * mask[ys, xs] * alpha)

    def _beard_mask(self, K, bd, grow_=0.0, out_col=None, alpha=1.0, want=False):
        """Beard region in (a, b): cheek line from the sideburn to the moustache, jaw + chin mass, mouth hole."""
        a, b, px = K['a'], K['b'], K['px']
        eb, nb, cb = self.eb, self.nb, self.cb
        g = grow_
        A = np.abs(a)
        top = np.interp(A, [0.0, 0.12, 0.26, 0.42, 0.62, 0.95, 1.4, 1.9, 2.6],
                        [nb - 0.09, nb - 0.07, nb - 0.12, nb - 0.18, nb - 0.16, eb - 0.62, eb - 0.40, eb - 0.05, eb + 0.2])
        top = top + bd.get('cheek', 0.0) - bd.get('moustacheDrop', 0.0) * (1 - S.smoothstep(0.5, 0.9, A))
        cl = bd.get('clumps', 11)
        jag = bd.get('jag', 0.05) * (0.5 + 0.5 * np.abs(((A * cl) % 2) - 1)) * (A > 0.3)
        top = top - jag
        ln = bd.get('length', 0.35)
        bot = np.interp(A, [0, 0.6, 1.2, 1.8, 2.6], [cb - ln, cb - ln * 0.85, cb - 0.1, cb + 0.25, eb - 0.2])
        bot = bot + bd.get('jagLow', 0.08) * np.abs(((A * cl * 0.8 + 0.3) % 2) - 1)
        dist = np.maximum(b - (top + g), (bot - g) - b)
        dist = np.maximum(dist, A - (bd.get('width', 2.35) + g))
        mw = self.mouth_w / self.D
        hole = S.ellipse(a, b, 0, -0.07, mw * bd.get('mouthOpen', 0.8), 0.06)
        dist = np.maximum(dist, -(hole - g * 0.2))
        if bd.get('soulPatch', False):
            for sg in (-1, 1):
                gap = S.ellipse(a, b, sg * mw * 0.62, -0.2, mw * 0.34, 0.06, rot=sg * 0.3)
                dist = np.maximum(dist, -(gap - g * 0.2))
        if want:
            return dist
        S.over(K['out'], out_col, S.cover(dist, px, 0.004 if g > 0 else 0) * K['m'] * alpha)

    # ------------------------------------------------------------------ geometry helpers
    def _welded_adjacency(self, idx_tris, verts):
        """Neighbour lists over `verts` (vertex ids) from triangles, welding duplicates by position."""
        P = self.d.P
        key = np.round(P[verts] * 1e5).astype(np.int64)
        _, inv = np.unique(key, axis=0, return_inverse=True)
        inv = inv.ravel()
        loc = -np.ones(self.d.n, np.int64); loc[verts] = inv
        G = inv.max() + 1
        t = loc[idx_tris.reshape(-1, 3)]
        t = t[(t >= 0).all(1)]
        e = np.concatenate([t[:, [0, 1]], t[:, [1, 2]], t[:, [2, 0]]])
        e = np.concatenate([e, e[:, ::-1]])
        return inv, G, e

    def shading_normals(self, iters: int = 40, border: float = 0.02, keep_nose: float = 0.35, proxy: float = 0.0):
        """Laplacian-smoothed normals on the face primitive (welded), blended back to the original toward the
        primitive border (so the face-to-body seam never shows) — clean cel shapes that still follow the big planes."""
        d = self.d
        fv = self.face_verts
        tris = d.prims[self.face_prim]['indices']
        inv, G, e = self._welded_adjacency(tris, fv)
        N0 = np.zeros((G, 3)); np.add.at(N0, inv, d.N[fv])
        N0 /= np.maximum(np.linalg.norm(N0, axis=1, keepdims=True), 1e-9)
        Pg = np.zeros((G, 3)); np.add.at(Pg, inv, d.P[fv]); cnt = np.bincount(inv, minlength=G)[:, None]; Pg /= cnt
        deg = np.bincount(e[:, 0], minlength=G)[:, None].astype(np.float64)
        N = N0.copy()
        for _ in range(iters):
            acc = np.zeros_like(N); np.add.at(acc, e[:, 0], N[e[:, 1]])
            N = 0.5 * N + 0.5 * acc / np.maximum(deg, 1)
            N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)
        # border distance (in welded graph hops, approximated by distance to border vertices in 3D)
        ec = np.sort(e, axis=1)
        _, ecount = np.unique(ec, axis=0, return_counts=True)
        # boundary = vertices of edges used once (each undirected edge appears twice per adjacent tri in e)
        tt = inv[np.searchsorted(fv, tris.reshape(-1, 3))] if False else None
        tl = (-np.ones(d.n, np.int64)); tl[fv] = inv
        t3 = tl[tris.reshape(-1, 3)]
        und = np.sort(np.concatenate([t3[:, [0, 1]], t3[:, [1, 2]], t3[:, [2, 0]]]), axis=1)
        ue, uc = np.unique(und, axis=0, return_counts=True)
        bverts = np.unique(ue[uc == 1])
        # only the OUTER border of the face primitive blends back (holes left by the hidden cavity triangles don't)
        Bp = Pg[bverts]
        inner_hole = (np.abs(Bp[:, 0]) < self.mouth_w * 1.8) & (np.abs(Bp[:, 1] - self.mouth_y) < 0.035)
        inner_hole |= np.linalg.norm((Bp - self.nose)[:, :2], axis=1) < 0.03
        for c_, r_ in self.eyeballs:
            inner_hole |= np.linalg.norm(Bp - c_, axis=1) < r_ * 2.0
        bverts = bverts[~inner_hole]
        if len(bverts):
            dist = np.min(np.linalg.norm(Pg[:, None, :] - Pg[bverts][None, ::3, :], axis=-1), axis=1)
        else:
            dist = np.ones(G)
        w = S.smoothstep(0.002, border, dist)
        # keep some of the nose's own shading (a readable nose shadow), fully smoothed elsewhere
        rn = np.linalg.norm((Pg - self.nose)[:, :2], axis=1)
        w = w * (1 - keep_nose * (1 - S.smoothstep(0.008, 0.025, rn)))
        if proxy > 0:
            # blend toward a fitted head ellipsoid (rounder, softer read: female / young faces)
            fr = Pg[(Pg[:, 1] > self.chin[1]) & (Pg[:, 1] < self.eye_y + 0.06) & (Pg[:, 2] > self.zc)]
            best = None
            for cy in self.eye_y + np.linspace(-0.08, 0.02, 11):
                for cz in self.zc + np.linspace(-0.03, 0.05, 17):
                    M = np.stack([fr[:, 0] ** 2, (fr[:, 1] - cy) ** 2, (fr[:, 2] - cz) ** 2], 1)
                    co, *_ = np.linalg.lstsq(M, np.ones(len(fr)), rcond=None)
                    if (co <= 0).any():
                        continue
                    err = float(np.mean((np.sqrt(M @ co) - 1) ** 2))
                    if best is None or err < best[0]:
                        best = (err, cy, cz, co)
            if best is not None:
                _, cy, cz, (A, B, C) = best
                E_ = np.stack([A * Pg[:, 0], B * (Pg[:, 1] - cy), C * (Pg[:, 2] - cz)], 1)
                E_ /= np.maximum(np.linalg.norm(E_, axis=1, keepdims=True), 1e-9)
                N = N * (1 - proxy) + E_ * proxy
                N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)
        Nn = N0 * (1 - w[:, None]) + N * w[:, None]
        Nn /= np.maximum(np.linalg.norm(Nn, axis=1, keepdims=True), 1e-9)
        d.N[fv] = Nn[inv]
        for t in d.targets:
            if 'NORMAL' in t:
                t['NORMAL'][fv] *= (1 - w[inv])[:, None]
        self.smoothN = Nn[inv]
        self.log(f'face_kit: shading normals smoothed ({iters} iters) on {G} welded face verts')

    def _shell(self, dist_fn, thick_fn, name, tex=None, color=None, alpha_mode='MASK', margin=0.03, zero_morphs=False, lift=(0, 0, 0)):
        """Duplicate the face triangles where dist_fn(a, b) < margin, push them out along the smoothed normals
        by thick_fn(a, b, dist) and give them their own material. Skin weights + morphs ride along."""
        d = self.d
        fv = self.face_verts
        tris = d.prims[self.face_prim]['indices'].reshape(-1, 3)
        a, b = self._ab(d.P)
        dv = dist_fn(a, b)
        sel = (dv[tris] < margin).any(1) & (dv[tris] < margin * 3).all(1)
        st = tris[sel]
        used = np.unique(st)
        n0 = d.n
        remap = -np.ones(n0, np.int64); remap[used] = n0 + np.arange(len(used))
        nrm = d.N[used] / np.maximum(np.linalg.norm(d.N[used], axis=1, keepdims=True), 1e-9)
        try:
            th = thick_fn(a[used], b[used], dv[used], used=used)
        except TypeError:
            th = thick_fn(a[used], b[used], dv[used])
        d.P = np.concatenate([d.P, d.P[used] + nrm * th[:, None]])
        sn = nrm + np.array(lift, np.float64)[None, :]
        sn /= np.maximum(np.linalg.norm(sn, axis=1, keepdims=True), 1e-9)
        d.N = np.concatenate([d.N, sn]); d.UV = np.concatenate([d.UV, d.UV[used]])
        d.J = np.concatenate([d.J, d.J[used]]); d.W = np.concatenate([d.W, d.W[used]])
        for t in d.targets:
            for k in list(t):
                add = t[k][used] * (0 if zero_morphs else 1)
                t[k] = np.concatenate([t[k], add])
        J = self.m.J
        mat = {'name': name, 'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 1], 'metallicFactor': 0.0, 'roughnessFactor': 1.0}}
        if tex is not None:
            ii = self.m.g.add_image(imgio.encode(tex), name.lower())
            mat['pbrMetallicRoughness']['baseColorTexture'] = {'index': self.m.g.add_texture(ii, 0)}
        if color is not None:
            mat['pbrMetallicRoughness']['baseColorFactor'] = [*map(float, lin(S.hexc(color))), 1.0]
        if alpha_mode == 'MASK':
            mat['alphaMode'] = 'MASK'; mat['alphaCutoff'] = 0.5
        J['materials'].append(mat)
        d.prims.append({'material': len(J['materials']) - 1, 'indices': remap[st].reshape(-1).astype(np.uint32), 'mode': 4})
        self.log(f'face_kit: shell {name}: {len(st)} tris')
        return len(d.prims) - 1

    def beard_shell(self, bd: dict):
        """Beard / moustache volume: a shell over the painted beard with a clumped, jagged alpha edge."""
        K = self.K
        N_ = self.size
        dist = self._beard_mask(K, bd, want=True)
        a, b, px, mask = K['a'], K['b'], K['px'], K['m']
        base = S.hexc(bd['color']); hi = S.hexc(bd.get('light', '#6a4230')); dk = S.hexc(bd.get('dark', '#24140e'))
        tex = np.zeros((N_, N_, 4), np.float32)
        tex[..., :3] = base
        # strand clumps: a few tapered darker strand lines flowing down-and-out + lighter flicks near the top
        rng = np.random.default_rng(bd.get('seed', 5))
        inside = dist < -0.02
        A = np.abs(a)
        for k in range(int(bd.get('strands', 46))):
            sa = rng.uniform(-bd.get('width', 2.35) * 0.8, bd.get('width', 2.35) * 0.8)
            col_ = np.clip(np.abs(a[0] - sa), 0, None)
            # start just under the cheek line at this a (sample the mask along b)
            bs = np.linspace(self.eb, self.cb - bd.get('length', 0.35), 60)
            dd = self._beard_dist_verts(np.full(60, sa), bs, bd)
            ins = np.where(dd < -0.03)[0]
            if len(ins) < 4:
                continue
            b0 = bs[ins[0]] - rng.uniform(0.0, 0.25) * (bs[ins[0]] - bs[ins[-1]])
            ln = rng.uniform(0.18, 0.42)
            dirv = np.array([np.sign(sa) * rng.uniform(0.05, 0.35) * min(1, abs(sa) + 0.2), -1.0])
            p0 = np.array([sa, b0]); p2 = p0 + dirv * ln
            p1 = (p0 + p2) / 2 + np.array([np.sign(sa) * 0.04, 0])
            pts = S.bezier(p0, p1, p2, n=10)
            dk_or_hi = dk if rng.uniform() < 0.62 else hi
            self._stroke(tex, pts, bd.get('strandW', 0.022) * S.taper(np.linspace(0, 1, 10), 0.6), dk_or_hi, 0.85)
        # inner darker core under the lip and chin
        core = S.ellipse(a, b, 0, self.cb - 0.05, 0.55, 0.22)
        S.over(tex, dk, S.cover(core, px, 0.08) * 0.35)
        # jagged edge: clumps (triangular teeth) along the boundary, irregular sizes
        cl = bd.get('clumps', 11)
        n1 = S.vnoise1(a * cl * 1.7 + b * 3.0, 3.0)
        teeth = np.abs(((a * cl * 2.2 + b * 4.0 + n1 * 1.3) % 1.0) - 0.5) * 2      # 0 at tooth tips
        mw_ = self.mouth_w / self.D
        near_lip = (1 - S.smoothstep(0.08, 0.2, np.abs(b + 0.02))) * (1 - S.smoothstep(mw_ * 1.1, mw_ * 1.6, np.abs(a)))
        edge = dist - bd.get('fringe', 0.06) * (1 - teeth) * (0.6 + 0.8 * n1) * (1 - 0.7 * near_lip)
        tex[..., 3] = S.cover(edge, px) * mask
        tex = dilate(tex, tex[..., 3] > 0.5, 6)
        tex[..., 3] = S.cover(edge, px) * mask

        th0 = bd.get('thick', 0.010)

        sculpt_T = getattr(self, 'beard_T', None)          # per-vertex thickness from a sculpt (sculpt_fit)

        def thick(aa, bb, dd, used=None):
            if sculpt_T is not None and used is not None:
                t = np.clip(sculpt_T[used] * bd.get('sculptScale', 1.0), bd.get('minThick', 0.0015), bd.get('maxThick', 0.022))
                return t * (0.35 + 0.65 * S.smoothstep(0.0, -0.08, dd))
            chin = 1 - S.smoothstep(0.0, 0.9, np.hypot(aa / 1.2, (bb - self.cb) / 0.6))
            mous = 1 - S.smoothstep(0.0, 0.25, np.hypot(aa / 0.5, (bb - (self.nb - 0.15)) / 0.12))
            t = th0 * (0.35 + 0.65 * chin) + mous * th0 * 0.1
            t = t * (0.3 + 0.7 * S.smoothstep(0.0, -0.12, dd))       # thin at the edge
            return t

        self.beard_prim = self._shell(lambda aa, bb: self._beard_dist_verts(aa, bb, bd), thick, 'Beard', tex=tex, margin=0.06, lift=bd.get('lift', (0, 0.35, 0.45)))
        self.beard_tex = tex

    def _beard_dist_verts(self, aa, bb, bd):
        K = {'a': aa, 'b': bb, 'px': 1.0, 'out': None, 'm': None}
        return self._beard_mask(K, bd, want=True)

    def patch_shell(self, pa: dict):
        side = pa.get('side', -1)   # -1 = character's right eye (x < 0)
        e = self.eyes[0] if (self.eyes[0].sgn > 0) == (side > 0) else self.eyes[1]
        D = self.D
        ca, cb = e.cx / D + side * pa.get('dx', 0.0), (e.cy - self.mouth_y) / D + pa.get('dy', -0.02)
        rx, ry = pa.get('rx', 0.36), pa.get('ry', 0.27)

        def dist(aa, bb):
            return S.ellipse(aa, bb, ca, cb, rx, ry, rot=side * pa.get('rot', 0.25))
        self.patch_prim = self._shell(dist, lambda aa, bb, dd: pa.get('thick', 0.0045) * (0.5 + 0.5 * S.smoothstep(0.0, -0.1, dd)),
                                      'EyePatch', color=pa.get('color', '#1d1d20'), alpha_mode='OPAQUE', margin=0.0, zero_morphs=True)

    def strap_ribbon(self, pa: dict):
        """Eyepatch strap as a rigid ribbon over the forehead (a painted strap would kink with the brows)."""
        D = self.D
        ctrl = np.asarray(pa['strap'], np.float64)
        pts = S.bezier(*ctrl, n=40) if len(ctrl) in (3, 4) else ctrl
        wv = pa.get('strapW', 0.04) * D
        s_ = pts[:, 0] * D; y_ = pts[:, 1] * D + self.mouth_y
        tang = np.gradient(np.stack([s_, y_], 1), axis=0)
        tang /= np.maximum(np.linalg.norm(tang, axis=1, keepdims=True), 1e-9)
        nrm2 = np.stack([-tang[:, 1], tang[:, 0]], 1)
        L_ = np.concatenate([np.stack([s_, y_], 1) + nrm2 * wv / 2, np.stack([s_, y_], 1) - nrm2 * wv / 2])
        x0 = -0.12; x1 = 0.12
        samp = self._front_depth(x0, x1, self.eye_y - 0.03, self.crown_y + 0.01, px=0.0004, maxf=0.0012)
        z = np.full(len(L_), self.zc + self.R)
        for _ in range(5):
            x = (z - self.zc) * np.tan(L_[:, 0] / self.R)
            z = samp(x, L_[:, 1])
        z = z + pa.get('strapLift', 0.0012)
        x = (z - self.zc) * np.tan(L_[:, 0] / self.R)
        V = np.stack([x, L_[:, 1], z], 1)
        n = len(pts)
        tris = []
        for i in range(n - 1):
            tris += [(i, n + i, n + i + 1), (i, n + i + 1, i + 1)]
        tris = np.array(tris, np.int64)
        tn = np.cross(V[tris[:, 1]] - V[tris[:, 0]], V[tris[:, 2]] - V[tris[:, 0]])
        if (tn[:, 2] < 0).mean() > 0.5:
            tris = tris[:, ::-1]
        tn = np.cross(V[tris[:, 1]] - V[tris[:, 0]], V[tris[:, 2]] - V[tris[:, 0]])
        Nv = np.zeros_like(V)
        for k in range(3):
            np.add.at(Nv, tris[:, k], tn)
        Nv /= np.maximum(np.linalg.norm(Nv, axis=1, keepdims=True), 1e-9)
        d = self.d
        fv = self.face_verts
        nn = fv[np.argmin(np.linalg.norm(d.P[fv][None, :, :] - V[:, None, :], axis=-1), axis=1)]
        n0 = d.n
        d.P = np.concatenate([d.P, V]); d.N = np.concatenate([d.N, Nv]); d.UV = np.concatenate([d.UV, np.zeros((len(V), 2))])
        d.J = np.concatenate([d.J, d.J[nn]]); d.W = np.concatenate([d.W, d.W[nn]])
        for t in d.targets:
            for k in list(t):
                t[k] = np.concatenate([t[k], np.zeros((len(V), 3))])
        J = self.m.J
        J['materials'].append({'name': 'EyePatchStrap', 'doubleSided': True, 'extras': {'vtpRim': 0.2},
                               'pbrMetallicRoughness': {'baseColorFactor': [*map(float, lin(S.hexc(pa.get('color', '#161618')))), 1.0], 'metallicFactor': 0.0, 'roughnessFactor': 0.8}})
        d.prims.append({'material': len(J['materials']) - 1, 'indices': (tris + n0).reshape(-1).astype(np.uint32), 'mode': 4})
        self.log(f'face_kit: strap ribbon {len(tris)} tris')

    def lash_ribbon(self, color=None, width=0.0011, wing=0.0028, lift=0.0004, segs=28):
        """Upper lash line as geometry (like VRoid's FaceEyeline): a thin ribbon on the upper lid margin, tapering
        into the inner corner and flicking out at the outer corner, carrying the lid's own skin weights and morph
        deltas (vertex-for-vertex), so it closes WITH the lid instead of smearing across it."""
        d = self.d
        fv = self.face_verts
        col = color or self.p['line']
        J = self.m.J
        for ei_, e in enumerate(self.eyes):
            if ei_ == self.virtual_eye:
                continue
            c_, r_ = self.eyeballs[ei_]
            fz = self._front_depth(c_[0] - r_ * 2.2, c_[0] + r_ * 2.2, c_[1] - r_ * 1.5, c_[1] + r_ * 1.5, px=0.00015, maxf=0.0006, eyes=True)
            u = np.linspace(-1.02, 1.0, segs)
            sv = e.x_of(u); yv = e.ytop(sv)
            prof = np.clip(0.25 + 0.75 * S.smoothstep(-1.0, 0.4, u), 0, 1)
            tip = e.x_of(1.0 + getattr(self, 'lash_tip', 0.35))
            ww = width * prof
            bot = np.stack([sv, yv - 0.0002], 1); top = np.stack([sv, yv + ww], 1)
            wing_pts = np.array([[e.x_of(1.0), yv[-1]], [tip, yv[-1] + wing * 0.25]])
            L2 = np.concatenate([bot, top, wing_pts])
            z = np.full(len(L2), c_[2] + r_)
            for _ in range(4):
                x = (z - self.zc) * np.tan(L2[:, 0] / self.R)
                z = fz(x, L2[:, 1])
            z = z + lift
            x = (z - self.zc) * np.tan(L2[:, 0] / self.R)
            V = np.stack([x, L2[:, 1], z], 1)
            n = segs
            tris = []
            for i in range(n - 1):
                tris += [(i, n + i, n + i + 1), (i, n + i + 1, i + 1)]
            tris += [(n - 1, 2 * n - 1, 2 * n + 1), (2 * n, n - 1, 2 * n + 1)]
            tris = np.array(tris, np.int64)
            tn = np.cross(V[tris[:, 1]] - V[tris[:, 0]], V[tris[:, 2]] - V[tris[:, 0]])
            if (tn[:, 2] < 0).mean() > 0.5:
                tris = tris[:, ::-1]
            # every ribbon vertex follows the nearest lid-MARGIN vertex (bottom row sample), so the ribbon stays rigid
            anchor = np.concatenate([bot, bot, wing_pts[[0, 0]]])
            ax = (np.interp(anchor[:, 0], L2[:len(bot), 0], z[:len(bot)]) - self.zc) * np.tan(anchor[:, 0] / self.R)
            A3 = np.stack([ax, anchor[:, 1], np.interp(anchor[:, 0], L2[:len(bot), 0], z[:len(bot)])], 1)
            nn = fv[np.argmin(np.linalg.norm(d.P[fv][None, :, :] - A3[:, None, :], axis=-1), axis=1)]
            n0 = d.n
            d.P = np.concatenate([d.P, V]); d.N = np.concatenate([d.N, np.tile([0, 0, 1.0], (len(V), 1))])
            d.UV = np.concatenate([d.UV, np.zeros((len(V), 2))])
            d.J = np.concatenate([d.J, d.J[nn]]); d.W = np.concatenate([d.W, d.W[nn]])
            for t in d.targets:
                for k in list(t):
                    t[k] = np.concatenate([t[k], t[k][nn]])
            J['materials'].append({'name': 'LashLine', 'doubleSided': True, 'extras': {'vtpRim': 0.0, 'vtpShadeShift': -1.0},
                                   'pbrMetallicRoughness': {'baseColorFactor': [*map(float, lin(S.hexc(col))), 1.0], 'metallicFactor': 0.0, 'roughnessFactor': 1.0}})
            d.prims.append({'material': len(J['materials']) - 1, 'indices': (tris + n0).reshape(-1).astype(np.uint32), 'mode': 4})
            self.log(f'face_kit: lash ribbon ({len(tris)} tris) on eye {ei_}')

    # ------------------------------------------------------------------ eyes, brows, lashes, hair
    def paint_eyes(self, q: dict):
        m = self.m
        de = self.de
        J = m.J
        mat = de.prims[0]['material']
        ti = J['materials'][mat]['pbrMetallicRoughness']['baseColorTexture']['index']
        N_ = 1024
        mask, P, _ = posmap(de.P, None, de.UV, de.prims[0]['indices'], N_, N_)
        out = np.zeros((N_, N_, 4), np.float32); out[..., :3] = S.hexc(q['white']); out[..., 3] = 1
        px = 0.00004
        for ei_, (c, r) in enumerate(self.eyeballs):
            if ei_ == self.virtual_eye:
                continue
            side = mask & (np.sign(P[..., 0]) == np.sign(c[0]))
            qx = P[..., 0] - c[0]; qy = P[..., 1] - c[1]; qz = P[..., 2] - c[2]
            front = side & (qz > 0)
            ri = 0.0056 * q.get('size', 1.0)
            rr = np.hypot(qx, qy)
            base = S.hexc(q['iris']); inner = S.hexc(q['inner']); ring = S.hexc(q['ring'])
            iris = S.cover(rr - ri, px) * front
            t = np.clip(rr / ri, 0, 1)
            col = S.mix(inner, base, S.smoothstep(0.32, 0.62, t)[..., None])
            col = S.mix(col, np.clip(base * 0.55, 0, 1), S.smoothstep(0.75, 0.95, t)[..., None])
            # top of the iris shadowed by the lid
            col = S.mix(col, np.clip(base * 0.35, 0, 1), (S.smoothstep(ri * 0.25, ri * 0.55, qy) * 0.7)[..., None])
            S.over(out, col, iris)
            S.over(out, ring, S.cover(np.abs(rr - ri * 0.97) - ri * 0.07, px) * front)
            S.over(out, np.array([0.03, 0.03, 0.03]), S.cover(rr - ri * q['pupil'], px) * front)
            # catchlight toward the light (upper, +x = viewer's right)
            hlx = c[0] + ri * 0.35; hly = c[1] + ri * 0.35
            S.over(out, np.array([1, 1, 1]), S.cover(np.hypot(P[..., 0] - hlx, P[..., 1] - hly) - ri * 0.17, px) * front)
            # sclera: lid shadow at the top, cooler corners
            S.over(out, S.hexc(q.get('whiteShadow', '#c9bfb8')), S.smoothstep(-ri * 0.1, ri * 0.35, qy) * (1 - iris) * front * 0.9)
        out = dilate(out, mask, 4)
        ii = m.g.add_image(imgio.encode(out), 'eyes_comic')
        J['textures'][ti] = {'source': ii, 'sampler': J['textures'][ti].get('sampler', 0)}
        pbr = J['materials'][mat]['pbrMetallicRoughness']; pbr['roughnessFactor'] = 1.0; pbr['metallicFactor'] = 0.0

    def drop_meshes(self, names):
        for n in self.m.J['nodes']:
            mi = n.get('mesh')
            if mi is not None and self.m.J['meshes'][mi]['name'] in names:
                n.pop('mesh')
                n.pop('skin', None)

    def hair_toon(self, color: str, shade_k: float = 0.55, contrast: float = 1.0):
        m = self.m
        J = m.J
        hi = m.mesh_index('Hair')
        if hi is None:
            return
        mat = m.read_mesh(hi).prims[0]['material']
        pbr = J['materials'][mat]['pbrMetallicRoughness']
        ti = pbr['baseColorTexture']['index']
        src = J['textures'][ti]['source']
        a = imgio.decode(m.g.image_bytes(src))
        base = S.hexc(color)
        Lm = a[..., :3] @ np.array([0.2126, 0.7152, 0.0722], np.float32)
        sel = a[..., 3] > 0.3
        t1, t0 = np.percentile(Lm[sel], 50), np.percentile(Lm[sel], 12)
        a2 = a.copy()
        a2[..., :3] = base
        S.over(a2, np.clip(base * shade_k, 0, 1), S.smoothstep(t1 + 0.02, t1 - 0.02, Lm) * sel)
        S.over(a2, np.clip(base * shade_k * 0.6, 0, 1), S.smoothstep(t0 + 0.02, t0 - 0.02, Lm) * sel * contrast)
        a2[..., 3] = a[..., 3]
        ii = m.g.add_image(imgio.encode(a2), 'hair_toon')
        J['textures'][ti] = {'source': ii, 'sampler': J['textures'][ti].get('sampler', 0)}
        pbr['roughnessFactor'] = 1.0; pbr['metallicFactor'] = 0.0

    def paint_scalp(self, color: str, is_scalp):
        """Hair colour on the rig's scalp texels (the part of the head prim outside the face texture), so skull
        showing through gaps in the hair reads as hair. is_scalp(P) -> bool per texel position."""
        m = self.m; J = m.J
        mat = self.skin_mat
        ti = J['materials'][mat]['pbrMetallicRoughness']['baseColorTexture']['index']
        src = imgio.decode(m.g.image_bytes(J['textures'][ti]['source']))
        Hh, Ww = src.shape[:2]
        mask, P, _ = posmap(self.d.P, self.d.N, self.d.UV, self.d.prims[0]['indices'], Ww, Hh)
        k = mask & is_scalp(P)
        out = src.copy(); out[k, :3] = S.hexc(color)
        ii = m.g.add_image(imgio.encode(out), 'head_scalp')
        J['textures'][ti] = {'source': ii, 'sampler': J['textures'][ti].get('sampler', 0)}
        self.log(f'face_kit: scalp painted ({int(k.sum())} texels)')

    def tint_meshes(self, prefix: str, color: str):
        J = self.m.J
        for mi, me in enumerate(J['meshes']):
            if me['name'].startswith(prefix):
                for pr in me['primitives']:
                    pbr = J['materials'][pr['material']].setdefault('pbrMetallicRoughness', {})
                    pbr['baseColorFactor'] = [*map(float, lin(S.hexc(color))), 1.0]
                    pbr['roughnessFactor'] = 1.0

    def finish(self):
        m = self.m
        # terminator shift for the engine's anime toon shader (src/avatar/toon.ts, material extras vtpShadeShift):
        # face + body skin share it so the neck seam never shows
        sh = float(self.p.get('shadeShift', 0.0))
        skin_mats = [self.skin_mat, self.face_mat] + list(self.p.get('shadeShiftMats', []))
        for mi in skin_mats + [i for i, mt in enumerate(m.J['materials']) if mt.get('name') == 'Beard']:
            m.J['materials'][mi].setdefault('extras', {})['vtpShadeShift'] = sh if m.J['materials'][mi].get('name') != 'Beard' else float(self.p.get('beardShadeShift', sh))
        ii = m.g.add_image(imgio.encode(self.face_tex), 'face_skin_painted')
        J = m.J
        ti = J['materials'][self.face_mat]['pbrMetallicRoughness']['baseColorTexture']['index']
        J['textures'][ti] = {'source': ii, 'sampler': J['textures'][ti].get('sampler', 0)}
        m.write_mesh(self.bi, self.d)
        if not self.p.get('flatBody', True):
            return
        # body skin: flat base colour too (neck, hands, chest match the face exactly)
        bi = self.body_image()
        a = imgio.decode(m.g.image_bytes(bi))
        H, W = a.shape[:2]
        flat = np.ones((min(H, 1024), min(W, 1024), 4), np.float32); flat[..., :3] = S.hexc(self.p['skin'])
        J['textures'][J['materials'][self.skin_mat]['pbrMetallicRoughness']['baseColorTexture']['index']] = {'source': m.g.add_image(imgio.encode(flat), 'body_skin_flat'), 'sampler': 0}
        m.write_mesh(self.bi, self.d)

    # ------------------------------------------------------------------ rigid caps (eyepatch, badges ...)
    def _front_depth(self, x0, x1, y0, y1, px=0.0003, maxf=0.0024, eyes=True):
        d = self.d
        W = int((x1 - x0) / px); H = int((y1 - y0) / px)
        tris = d.prims[0]['indices'].reshape(-1, 3)
        if hasattr(self, 'face_prim'):
            tris = np.concatenate([tris, d.prims[self.face_prim]['indices'].reshape(-1, 3)])
        cen = d.P[tris].mean(1)
        near = (cen[:, 0] > x0 - 0.01) & (cen[:, 0] < x1 + 0.01) & (cen[:, 1] > y0 - 0.01) & (cen[:, 1] < y1 + 0.01) & (cen[:, 2] > self.zc)
        zb, _ = zraster(d.P, tris[near], np.zeros(near.sum(), np.int64), x0, x1, y0, y1, W, H)
        if self.de is not None and eyes:
            et = self.de.prims[0]['indices'].reshape(-1, 3)
            zb, _ = zraster(self.de.P, et, np.zeros(len(et), np.int64), x0, x1, y0, y1, W, H, zb, np.zeros((H, W), np.int64))
        # fill holes / smooth a little
        ok = np.isfinite(zb)
        zb = np.where(ok, zb, np.nanmin(np.where(ok, zb, np.nan)))
        # max filter (~2.4 mm): a stiff cap must clear every lid / lash / eyeball bump under it
        r = int(maxf / px)
        zm = zb.copy()
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1):
                if dx * dx + dy * dy <= r * r:
                    zm = np.maximum(zm, np.roll(np.roll(zb, dy, 0), dx, 1))
        zb = zm

        def sample(x, y):
            j = np.clip(((x - x0) / px).astype(int), 0, W - 1); i = np.clip(((y1 - y) / px).astype(int), 0, H - 1)
            return zb[i, j]
        return sample

    def patch_cap(self, pa: dict):
        """A smooth rigid cap (eyepatch) over one eye: an elliptical dome that follows the face surface, bound to
        the nearest face vertices' skin weights, no morphs (it doesn't blink). Replaces a skin shell, which would
        have a hole at the eye opening."""
        side = pa.get('side', -1)
        e = self.eyes[0] if (self.eyes[0].sgn > 0) == (side > 0) else self.eyes[1]
        D = self.D
        ca = e.cx / D + side * pa.get('dx', 0.0); cb = (e.cy - self.mouth_y) / D + pa.get('dy', -0.02)
        rx, ry, rot = pa.get('rx', 0.36), pa.get('ry', 0.27), side * pa.get('rot', 0.2)
        nr, ns = 10, 48
        c3 = e.c3
        samp = self._front_depth(c3[0] - 0.04, c3[0] + 0.04, c3[1] - 0.035, c3[1] + 0.035)
        pts = []
        for i in range(nr + 1):
            rr = i / nr
            for j in range(ns if i else 1):
                ang = 2 * np.pi * j / ns
                # a slightly flattened bottom edge (the classic patch shape: rounded top, flatter lower side)
                ex, ey = np.cos(ang), np.sin(ang)
                sh = pa.get('shield', 0.0)
                if ey > 0:
                    ey = ey * (1 - sh * 0.25) + sh * 0.25 * np.sign(ey) * min(1, abs(ey) * 1.6)   # flatter top
                else:
                    ex = ex * (1 - sh * 0.45 * (-ey))                                               # narrower bottom
                ua, ub = ex * rx * rr, ey * ry * rr
                cr, sr = np.cos(rot), np.sin(rot)
                pts.append((ca + cr * ua - sr * ub, cb + sr * ua + cr * ub, rr))
        pts = np.array(pts)
        s = pts[:, 0] * D; y = pts[:, 1] * D + self.mouth_y
        z = np.full(len(s), c3[2] + 0.005)
        for _ in range(4):
            x = (z - self.zc) * np.tan(s / self.R)
            z = samp(x, y)
        # stiff membrane over the eye: repeatedly smooth, but never sink below the (max-filtered) surface
        zreq = z + pa.get('thick', 0.0035)
        ring_prev, ring_next, ring_in = [], [], []
        k = 1
        nb_ = [[] for _ in range(len(z))]
        for i in range(1, nr + 1):
            for j in range(ns):
                v = k + j
                nb_[v] += [k + (j - 1) % ns, k + (j + 1) % ns, (k - ns + j) if i > 1 else 0]
                if i < nr:
                    nb_[v].append(k + ns + j)
            k += ns
        nb_[0] = list(range(1, 1 + ns))
        L_ = max(len(x) for x in nb_)
        nbm = np.array([x + [x[0]] * (L_ - len(x)) for x in nb_])
        zs = zreq.copy()
        for _ in range(pa.get('relax', 400)):
            zs = np.maximum(0.5 * zs + 0.5 * zs[nbm].mean(1), zreq)
        dome = pa.get('dome', 0.004) * (1 - pts[:, 2] ** 2)
        zs = zs + dome
        x = (zs - self.zc) * np.tan(s / self.R)
        V = np.stack([x, y, zs], 1)
        tris = []
        for j in range(ns):
            tris.append((0, 1 + j, 1 + (j + 1) % ns))
        for i in range(1, nr):
            b0 = 1 + (i - 1) * ns; b1 = 1 + i * ns
            for j in range(ns):
                j2 = (j + 1) % ns
                tris += [(b0 + j, b1 + j, b1 + j2), (b0 + j, b1 + j2, b0 + j2)]
        tris = np.array(tris, np.int64)
        # orientation: normals toward +z
        tn = np.cross(V[tris[:, 1]] - V[tris[:, 0]], V[tris[:, 2]] - V[tris[:, 0]])
        if (tn[:, 2] < 0).mean() > 0.5:
            tris = tris[:, ::-1]
        Nv = np.zeros_like(V)
        tn = np.cross(V[tris[:, 1]] - V[tris[:, 0]], V[tris[:, 2]] - V[tris[:, 0]])
        for k in range(3):
            np.add.at(Nv, tris[:, k], tn)
        Nv /= np.maximum(np.linalg.norm(Nv, axis=1, keepdims=True), 1e-9)
        for _ in range(pa.get('normalSmooth', 60)):          # one clean dome terminator, no membrane bumps
            Nv = 0.5 * Nv + 0.5 * Nv[nbm].mean(1)
            Nv /= np.maximum(np.linalg.norm(Nv, axis=1, keepdims=True), 1e-9)
        d = self.d
        fv = self.face_verts
        nn = fv[np.argmin(np.linalg.norm(d.P[fv][None, :, :] - V[:, None, :], axis=-1), axis=1)]
        n0 = d.n
        d.P = np.concatenate([d.P, V]); d.N = np.concatenate([d.N, Nv])
        d.UV = np.concatenate([d.UV, np.zeros((len(V), 2))])
        d.J = np.concatenate([d.J, d.J[nn]]); d.W = np.concatenate([d.W, d.W[nn]])
        for t in d.targets:
            for k in list(t):
                t[k] = np.concatenate([t[k], np.zeros((len(V), 3))])
        J = self.m.J
        J['materials'].append({'name': 'EyePatch', 'extras': {'vtpRim': 0.25}, 'pbrMetallicRoughness': {'baseColorFactor': [*map(float, lin(S.hexc(pa.get('color', '#161618')))), 1.0],
                               'metallicFactor': 0.0, 'roughnessFactor': pa.get('roughness', 0.45)}})
        d.prims.append({'material': len(J['materials']) - 1, 'indices': (tris + n0).reshape(-1).astype(np.uint32), 'mode': 4})
        self.log(f'face_kit: eyepatch cap {len(tris)} tris')
        if pa.get('rivet'):
            ra, rb = pa['rivet']                                   # (u, v) in the patch's own ellipse frame
            k = int(np.argmin((pts[:, 0] - (ca + ra * rx)) ** 2 + (pts[:, 1] - (cb + rb * ry)) ** 2))
            c0 = V[k] + Nv[k] * 0.0006
            rr = pa.get('rivetR', 0.0026)
            n = Nv[k]; t1 = np.cross(n, [0, 1, 0]); t1 /= np.linalg.norm(t1); t2 = np.cross(n, t1)
            ring = [c0 + (np.cos(a) * t1 + np.sin(a) * t2) * rr for a in np.linspace(0, 2 * np.pi, 12, endpoint=False)]
            RV = np.array([c0 + n * rr * 0.6] + ring)
            RT = np.array([(0, 1 + j, 1 + (j + 1) % 12) for j in range(12)], np.int64)
            tn = np.cross(RV[RT[:, 1]] - RV[RT[:, 0]], RV[RT[:, 2]] - RV[RT[:, 0]])
            if (tn @ n).mean() < 0:
                RT = RT[:, ::-1]
            RN = np.vstack([n] + [(q - c0) / rr * 0.6 + n * 0.8 for q in ring]); RN /= np.linalg.norm(RN, axis=1, keepdims=True)
            n1 = d.n
            d.P = np.concatenate([d.P, RV]); d.N = np.concatenate([d.N, RN]); d.UV = np.concatenate([d.UV, np.zeros((len(RV), 2))])
            d.J = np.concatenate([d.J, np.repeat(d.J[nn[k]][None], len(RV), 0)]); d.W = np.concatenate([d.W, np.repeat(d.W[nn[k]][None], len(RV), 0)])
            for t in d.targets:
                for kk in list(t):
                    t[kk] = np.concatenate([t[kk], np.zeros((len(RV), 3))])
            J['materials'].append({'name': 'EyePatchRivet', 'extras': {'vtpRim': 0.6},
                                   'pbrMetallicRoughness': {'baseColorFactor': [*map(float, lin(S.hexc(pa.get('rivetColor', '#3a3a3e')))), 1.0], 'metallicFactor': 0.6, 'roughnessFactor': 0.35}})
            d.prims.append({'material': len(J['materials']) - 1, 'indices': (RT + n1).reshape(-1).astype(np.uint32), 'mode': 4})


def merge_hair(glb_path: str, npz_path: str, tex_path: str, out_path: str | None = None, log=print):
    """Replace the MakeHuman 'Hair' mesh of a GLB with a face_kit / anime_hair clump hairstyle (rigid on the head)."""
    m = Model(glb_path)
    J = m.J
    z = np.load(npz_path, allow_pickle=False)
    hi = m.mesh_index('Hair')
    node = next(i for i, n in enumerate(J['nodes']) if n.get('mesh') == hi)
    skin = J['skins'][J['nodes'][node]['skin']]
    head_node = next(i for i, n in enumerate(J['nodes']) if n.get('name') == 'head')
    jh = skin['joints'].index(head_node)
    P = z['P'].astype(np.float64); N = z['N'].astype(np.float64); UV = z['UV'].astype(np.float64)
    T = z['T'].astype(np.uint32).reshape(-1)
    Jn = np.zeros((len(P), 4), np.int64); Jn[:, 0] = jh
    W = np.zeros((len(P), 4)); W[:, 0] = 1
    ii = m.g.add_image(open(tex_path, 'rb').read(), 'hair_clumps')
    ti = m.g.add_texture(ii, 0)
    J['materials'].append({'name': 'Hair', 'alphaMode': 'MASK', 'alphaCutoff': 0.5, 'doubleSided': True,
                           'pbrMetallicRoughness': {'baseColorTexture': {'index': ti}, 'metallicFactor': 0.0, 'roughnessFactor': 1.0}})
    d = MeshData(P, N, UV, Jn, W, [{'material': len(J['materials']) - 1, 'indices': T, 'mode': 4}], [], [])
    m.write_mesh(hi, d)
    J['meshes'][hi].pop('extras', None)
    m.save(out_path or glb_path)
    log(f'face_kit: hair merged ({len(P)} verts, {len(T) // 3} tris)')


def splice_part(m: Model, mesh_name: str, npz_path: str, material: int, weights_from=None, keep_head=True, log=print):
    """Replace the geometry of GLB mesh `mesh_name` with a stage-2 part npz (decimate_part.py / comic_hair.py dumps).
    Bone-name weights map onto the node's skin joints. weights_from = (P, J, W) of another mesh in the same skin:
    copy weights from its nearest vertex (e.g. keep an old hairdo's spring-chain weights on a new hairdo)."""
    J = m.J
    z = np.load(npz_path, allow_pickle=False)
    mi = m.mesh_index(mesh_name)
    node = next(i for i, n in enumerate(J['nodes']) if n.get('mesh') == mi)
    joints = J['skins'][J['nodes'][node]['skin']]['joints']
    jn = {J['nodes'][j]['name']: k for k, j in enumerate(joints)}
    P = z['P'].astype(np.float64); N = z['N'].astype(np.float64); UV = z['UV'].astype(np.float64)
    T = z['T'].astype(np.uint32).reshape(-1)
    bones = [str(b) for b in z['bones']]
    lut = np.array([jn.get(b, jn.get('head', 0)) for b in bones], np.int64)
    Jn = lut[z['J'].astype(np.int64)]
    W = z['W'].astype(np.float64)
    if weights_from is not None:
        from scipy.spatial import cKDTree
        P2, J2, W2 = weights_from
        _, idx = cKDTree(P2).query(P, k=1)
        Jn, W = J2[idx].copy(), W2[idx].copy()
    W /= np.maximum(W.sum(1, keepdims=True), 1e-9)
    d = MeshData(P, N, UV, Jn, W, [{'material': material, 'indices': T, 'mode': 4}], [], [])
    m.write_mesh(mi, d)
    J['meshes'][mi].pop('extras', None)
    log(f'face_kit: spliced {mesh_name} ({len(P)} verts, {len(T) // 3} tris)')


def prune(m: Model, log=print):
    """GLB-safe prune: meshes no node uses, then materials, textures and images nothing references (saves MBs)."""
    J = m.J
    used_m = sorted({n['mesh'] for n in J['nodes'] if 'mesh' in n})
    mmap = {o: k for k, o in enumerate(used_m)}
    J['meshes'] = [J['meshes'][o] for o in used_m]
    for n in J['nodes']:
        if 'mesh' in n:
            n['mesh'] = mmap[n['mesh']]
    used = sorted({p['material'] for me in J['meshes'] for p in me['primitives'] if p.get('material') is not None})
    remap = {o: k for k, o in enumerate(used)}
    J['materials'] = [J['materials'][o] for o in used]
    for me in J['meshes']:
        for p in me['primitives']:
            if p.get('material') is not None:
                p['material'] = remap[p['material']]
    refs = []

    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if k == 'index' and isinstance(v, int):
                    refs.append((o, k))
                else:
                    walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    for mat in J['materials']:
        walk(mat)
    used_t = sorted({h[k] for h, k in refs})
    tmap = {o: k for k, o in enumerate(used_t)}
    J['textures'] = [J['textures'][o] for o in used_t]
    for h, k in refs:
        h[k] = tmap[h[k]]
    used_i = sorted({t['source'] for t in J['textures']})
    imap = {o: k for k, o in enumerate(used_i)}
    J['images'] = [J['images'][o] for o in used_i]
    for t in J['textures']:
        t['source'] = imap[t['source']]
    m.refresh()
    log(f"face_kit: pruned -> {len(J['meshes'])} meshes, {len(J['materials'])} materials, {len(J['images'])} images")
