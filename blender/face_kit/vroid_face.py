"""
Parametric anime face painter for VRoid (VRM 0.x) faces — numpy only, no Blender.

VRoid faces are a stack of parts that each sample their own texture: skin (`Face_00_SKIN`), `EyeWhite`, `EyeIris`,
`EyeHighlight`, `FaceEyeline` (upper lash line), `FaceEyelash` (lash spikes), `FaceBrow`, `FaceMouth`. Their
geometry (and all VRoid Fcl_* / derived ARKit morphs) stays; face_kit REPAINTS every texture from vector shapes
evaluated in face space (see raster.posmap), at 2x the VRoid resolution, and replaces the shading normals of the
skin with normals of a fitted head ellipsoid (clean cel terminators, section 4 of docs/FACE_CREATION.md).

    from face_kit.vroid_face import VFace
    vf = VFace(model)            # landmarks: eye openings, irises, brows, nose tip, mouth
    vf.paint(params)             # params: see DEFAULTS
    vf.proxy_normals(amount=1)   # clean shading normals on the skin
    vf.mtoon(params['mtoon'])    # MToon settings for crisp cel faces
    vf.flush()

Coordinates: raw VRM0 glTF (+Y up, the face looks toward -Z, character LEFT = -X). The app renders VRM0 rotated
180 deg, so the viewer's RIGHT is raw -X; the stage's key light comes from the viewer's upper right.
"""
from __future__ import annotations

import copy
from collections import defaultdict

import numpy as np

from anime_creator import imgio
from anime_creator.vroid import Model

from . import sdf as S
from .raster import posmap, dilate, grow

PARTS = {
    'skin': 'Face_00_SKIN', 'white': 'EyeWhite', 'iris': 'EyeIris', 'hl': 'EyeHighlight',
    'line': 'FaceEyeline', 'lash': 'FaceEyelash', 'brow': 'FaceBrow', 'mouth': 'FaceMouth',
}

DEFAULTS = {
    'scale': 2,                       # texture resolution multiplier over the VRoid originals (1024 -> 2048)
    'toLight': -1.0,                  # raw-x direction of the key light (viewer's right = -1)
    'skin': {'base': None, 'shade': None, 'blush': '#f08a8a', 'blushAlpha': 0.32, 'blushSize': 1.0,
             'blushHatch': 0, 'blushY': -1.55, 'blushX': 1.05,
             'nose': 'tick', 'noseColor': None, 'noseSize': 1.0, 'eraseNose': True,
             'crease': 0.55, 'creaseAlpha': 0.55, 'creaseSpan': [-0.25, 0.92], 'lowerLash': 0.5,
             'lowerLashSpan': [0.25, 0.98], 'lidPink': 0.35, 'freckles': 0, 'fringeShadow': None,
             'flatten': 0.85, 'mouthLine': '#b5605a', 'mouthW': 1.0, 'mouthThick': 0.07, 'mouthCurve': 0.0,
             'shadeMul': '#eeb8b4'},
    'eye': {'white': '#fbf8f8', 'whiteShadow': '#c9c3dc', 'whiteShadowH': 0.28,
            'line': '#2b1a22', 'line2': '#6a3a3c', 'lineIn': 0.05, 'lineMax': 0.22, 'lineOverlap': 0.10,
            'wing': 0.28, 'wingDrop': -0.05, 'wingThick': 0.9, 'spikes': 3, 'spikeLen': 0.45, 'spikeW': 0.13,
            'innerCut': -1.02},
    'iris': {'color': '#4a7bd8', 'top': None, 'bottom': None, 'glow': None, 'glowAlpha': 0.75, 'ring': '#1a1830',
             'ringW': 0.07, 'pupil': 0.36, 'pupilColor': None, 'pupilRing': 0.35, 'topBand': 0.30,
             'streaks': 0.12, 'scale': 1.0, 'scaleY': 1.0, 'dy': 0.0},
    'hl': {'main': [0.36, 0.44, 0.30, 0.22], 'mainRot': -0.5, 'dot': [-0.34, -0.50, 0.10], 'sparkles': 0,
           'bar': 0.0, 'color': '#ffffff'},
    'brow': {'color': None, 'height': 2.25, 'arch': 0.35, 'width': 0.14, 'inner': -0.85, 'outer': 1.12,
             'tilt': 0.0, 'innerWidth': 0.8, 'shape': 'female'},
    'mtoon': {'skinShadeShift': -0.35, 'skinToony': 0.92, 'partsShadeShift': -0.9, 'partsToony': 0.9,
              'rim': 0.0},
}


def deep_merge(a, b):
    out = copy.deepcopy(a)
    for k, v in (b or {}).items():
        out[k] = deep_merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else copy.deepcopy(v)
    return out


class Eye:
    """One eye opening in face space (from the skin's eye-hole boundary loop)."""

    def __init__(self, loop: np.ndarray):
        self.loop = loop
        x, y = loop[:, 0], loop[:, 1]
        i0, i1 = int(np.argmin(x)), int(np.argmax(x))
        self.cx = float((x[i0] + x[i1]) / 2)
        self.sgn = 1.0 if self.cx > 0 else -1.0          # +u points to the OUTER corner
        self.ew = float((x[i1] - x[i0]) / 2)
        a, b = loop[i0, :2], loop[i1, :2]
        side = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])
        up = loop[side >= -1e-9]; lo = loop[side <= 1e-9]
        self.up = up[np.argsort(up[:, 0])][:, :2]
        self.lo = lo[np.argsort(lo[:, 0])][:, :2]
        self.top = float(self.up[:, 1].max()); self.bot = float(self.lo[:, 1].min())
        self.cy = (self.top + self.bot) / 2
        self.eh = (self.top - self.bot) / 2
        self.corner_in = loop[i1 if self.sgn < 0 else i0, :2]
        self.corner_out = loop[i0 if self.sgn < 0 else i1, :2]

    def ytop(self, X):
        return np.interp(X, self.up[:, 0], self.up[:, 1])

    def ylow(self, X):
        return np.interp(X, self.lo[:, 0], self.lo[:, 1])

    def u(self, X):
        return (X - self.cx) * self.sgn / self.ew

    def x_of(self, u):
        return self.cx + u * self.ew * self.sgn


class VFace:
    def __init__(self, m: Model, log=print):
        self.m = m; self.log = log
        self.fi = m.mesh_index('Face')
        self.d = m.read_mesh(self.fi)
        self.cache: dict[int, np.ndarray] = {}
        self.dirty: set[int] = set()
        self.prims = {k: [i for i, p in enumerate(self.d.prims) if v in m.mat_name(p['material'])] for k, v in PARTS.items()}
        self.mats = {k: sorted({self.d.prims[i]['material'] for i in v}) for k, v in self.prims.items()}
        self._landmarks()

    # ------------------------------------------------------------------ images
    def _img_index(self, mat: int) -> int:
        tp = self.m.mtoon(mat)['textureProperties']
        return self.m.J['textures'][tp['_MainTex']]['source']

    def image(self, key: str) -> np.ndarray:
        ii = self._own(key)
        if ii not in self.cache:
            self.cache[ii] = imgio.decode(self.m.g.image_bytes(ii))
        return self.cache[ii]

    def _own(self, key: str) -> int:
        """Give the part's materials their own image (VRoid shares some images between parts)."""
        m = self.m
        mats = self.mats[key]
        ii = self._img_index(mats[0])
        users = [k for k, mp in enumerate(m.vrm['materialProperties'])
                 if any(m.J['textures'][t]['source'] == ii for t in mp.get('textureProperties', {}).values())]
        if set(users) <= set(mats):
            return ii
        a = imgio.decode(m.g.image_bytes(ii))
        ni = m.g.add_image(imgio.encode(a), m.J['images'][ii].get('name', 'img') + f'_{key}')
        nt = m.g.add_texture(ni, 0)
        for mat in mats:
            tp = m.mtoon(mat)['textureProperties']
            old = tp['_MainTex']
            for k2 in ('_MainTex', '_ShadeTexture'):
                if tp.get(k2) == old:
                    tp[k2] = nt
            pbr = m.J['materials'][mat].setdefault('pbrMetallicRoughness', {})
            if 'baseColorTexture' in pbr:
                pbr['baseColorTexture']['index'] = nt
        self.cache[ni] = a
        return ni

    def put(self, key: str, a: np.ndarray):
        ii = self._own(key)
        self.cache[ii] = a; self.dirty.add(ii)

    def flush(self):
        for ii in sorted(self.dirty):
            self.m.g.set_image(ii, imgio.encode(self.cache[ii]))
        self.dirty.clear()

    def pmap(self, key: str, W: int, H: int):
        prims = self.prims[key]
        tris = np.concatenate([self.d.prims[i]['indices'] for i in prims])
        mask, P, N = posmap(self.d.P, self.d.N, self.d.UV, tris, W, H)
        # texel size in face space (for AA): median distance between horizontally adjacent covered texels
        dx = np.linalg.norm(P[:, 1:] - P[:, :-1], axis=-1)[mask[:, 1:] & mask[:, :-1]]
        px = float(np.median(dx)) if dx.size else 1e-4
        return mask, P, N, px

    # ------------------------------------------------------------------ landmarks
    def _landmarks(self):
        d = self.d
        skin = self.prims['skin']
        key = np.round(d.P * 1e5).astype(np.int64)
        _, inv = np.unique(key, axis=0, return_inverse=True); inv = inv.ravel()
        rep = {}
        for i, g in enumerate(inv):
            rep.setdefault(int(g), i)
        E = defaultdict(int)
        for pi in skin:
            for a, b, c in d.prims[pi]['indices'].reshape(-1, 3):
                for u, v in ((a, b), (b, c), (c, a)):
                    e = (min(inv[u], inv[v]), max(inv[u], inv[v])); E[e] += 1
        adj = defaultdict(list)
        for (u, v), n in E.items():
            if n == 1:
                adj[u].append(v); adj[v].append(u)
        seen = set(); loops = []
        for s in adj:
            if s in seen:
                continue
            comp = []; st = [s]
            while st:
                q = st.pop()
                if q in seen:
                    continue
                seen.add(q); comp.append(q); st.extend(adj[q])
            loops.append(np.array([d.P[rep[q]] for q in comp]))
        self.boundary = np.concatenate(loops)
        self.boundary_idx = np.array([rep[q] for q in seen])
        iris_v = d.verts_of(self.prims['iris'])
        iy = float(np.median(d.P[iris_v, 1]))
        cand = [lp for lp in loops if len(lp) >= 6 and abs(lp[:, 1].mean() - iy) < 0.03 and abs(lp[:, 0].mean()) > 0.01
                and np.ptp(lp[:, 0]) < 0.08]
        cand.sort(key=lambda lp: lp[:, 0].mean())
        if len(cand) < 2:
            raise RuntimeError(f'face_kit: eye openings not found ({len(cand)} loops)')
        # order each loop by angle so interp works
        eyes = []
        for lp in (cand[0], cand[-1]):
            c = lp.mean(0)
            ang = np.arctan2(lp[:, 1] - c[1], lp[:, 0] - c[0])
            eyes.append(Eye(lp[np.argsort(ang)]))
        self.eyes = eyes
        self.eh = float(np.mean([e.eh for e in eyes])); self.ew = float(np.mean([e.ew for e in eyes]))
        self.eye_y = float(np.mean([e.cy for e in eyes]))
        # irises: the ORIGINAL painted iris (alpha) mapped to face space, per eye
        a = self.image('iris'); H, W = a.shape[:2]
        mask, P, _, _ = self.pmap('iris', W, H)
        sel = mask & (a[..., 3] > 0.5)
        self.irises = []
        for e in eyes:
            q = P[sel & (np.sign(P[..., 0]) == np.sign(e.cx))]
            if len(q) < 10:
                raise RuntimeError('face_kit: iris not found')
            lo, hi = np.percentile(q[:, :2], 1, axis=0), np.percentile(q[:, :2], 99, axis=0)
            self.irises.append({'cx': float((lo[0] + hi[0]) / 2), 'cy': float((lo[1] + hi[1]) / 2),
                                'rx': float((hi[0] - lo[0]) / 2), 'ry': float((hi[1] - lo[1]) / 2),
                                'z': float(np.median(q[:, 2]))})
        # nose tip / mouth / chin on the skin
        sv = d.verts_of(skin); SP = d.P[sv]
        mid = SP[(np.abs(SP[:, 0]) < 0.006) & (SP[:, 1] < self.eye_y - self.eh) & (SP[:, 1] > self.eye_y - 6 * self.eh)]
        self.nose = mid[np.argmin(mid[:, 2])] if len(mid) else np.array([0, self.eye_y - 3 * self.eh, SP[:, 2].min()])
        mv = d.verts_of(self.prims['mouth'])
        self.mouth_c = d.P[mv].mean(0)
        bm = self.boundary[(np.abs(self.boundary[:, 0]) < 0.025) & (np.abs(self.boundary[:, 1] - self.mouth_c[1]) < 0.012)]
        self.mouth_y = float(np.median(bm[:, 1])) if len(bm) else float(self.mouth_c[1])
        self.mouth_w = float(np.ptp(bm[:, 0]) / 2) if len(bm) else 0.01
        front = SP[(np.abs(SP[:, 0]) < 0.004) & (SP[:, 2] < self.mouth_c[2] + 0.03)]
        self.chin_y = float(front[:, 1].min())
        self.log(f"face_kit: eyes at y={self.eye_y:.4f} ew={self.ew:.4f} eh={self.eh:.4f}, iris r=({self.irises[0]['rx']:.4f},"
                 f"{self.irises[0]['ry']:.4f}), nose y={self.nose[1]:.4f}, mouth y={self.mouth_c[1]:.4f}, chin y={self.chin_y:.4f}")

    # ------------------------------------------------------------------ painting
    def paint(self, prm: dict):
        p = deep_merge(DEFAULTS, prm)
        self.p = p
        self.paint_iris(p)
        self.paint_highlight(p)
        self.paint_white(p)
        self.paint_line(p)
        self.paint_lash(p)
        self.paint_brow(p)
        self.paint_skin(p)
        return p

    def _canvas(self, key, scale, clear=True):
        src = self.image(key)
        H, W = src.shape[0] * scale, src.shape[1] * scale
        mask, P, N, px = self.pmap(key, W, H)
        out = np.zeros((H, W, 4), np.float32) if clear else imgio.resize(src, W, H)
        return out, mask, P, N, px

    def _finish(self, key, out, mask, alpha_bg=0.0):
        m2 = grow(mask, 2)
        out[..., 3] = np.where(m2, out[..., 3], alpha_bg)
        out = dilate(out, out[..., 3] > 0.004, 6)
        # keep premultiplied-free edges: colour everywhere (dilated), alpha where painted
        self.put(key, out)

    def paint_iris(self, p):
        q = p['iris']; sc = p['scale']
        out, mask, P, N, px = self._canvas('iris', sc)
        X, Y = P[..., 0], P[..., 1]
        base = S.hexc(q['color'])
        top = S.hexc(q['top']) if q['top'] else np.clip(base * 0.32, 0, 1)
        bot = S.hexc(q['bottom']) if q['bottom'] else np.clip(base + (1 - base) * 0.45, 0, 1)
        glow = S.hexc(q['glow']) if q['glow'] else None
        ring = S.hexc(q['ring']); pc = S.hexc(q['pupilColor']) if q['pupilColor'] else np.clip(base * 0.18, 0, 1)
        for ir in self.irises:
            rx = ir['rx'] * q['scale']; ry = ir['ry'] * q['scale'] * q['scaleY']
            cx = ir['cx']; cy = ir['cy'] + q['dy'] * ir['ry']
            side = mask & (np.sign(X) == np.sign(cx))
            xn = (X - cx) / rx; yn = (Y - cy) / ry
            r = np.sqrt(xn ** 2 + yn ** 2)
            d = S.ellipse(X, Y, cx, cy, rx, ry)
            cov = S.cover(d, px) * side
            # vertical gradient: top dark -> base -> bottom light
            t = np.clip((yn + 1) / 2, 0, 1)                           # 0 bottom .. 1 top
            col = np.where((t > 0.5)[..., None], S.mix(base, top, S.smoothstep(0.5, 1.0, t)[..., None]),
                           S.mix(bot, base, S.smoothstep(0.0, 0.5, t)[..., None]))
            # lid shadow band: hard-edged darker cap following a slight curve
            edge = 1 - 2 * q['topBand'] + 0.18 * xn ** 2
            band = S.cover((edge - yn) * ry, px)
            col = S.mix(col, S.mix(top, ring, 0.35), band[..., None] * 0.85)
            # lower caustic crescent (gacha)
            if glow is not None:
                dg = S.ellipse(X, Y, cx, cy - 0.52 * ry, 0.66 * rx, 0.40 * ry)
                g = S.cover(dg, px, soft=0.25 * ry) * (1 - band)
                col = S.mix(col, glow, (g * q['glowAlpha'])[..., None])
            # radial streaks
            if q['streaks'] > 0:
                ang = np.arctan2(yn, xn)
                st = 0.5 + 0.5 * np.sin(ang * 23 + np.sin(ang * 7) * 1.7)
                k = q['streaks'] * S.smoothstep(0.3, 0.55, r) * (1 - S.smoothstep(0.85, 1.0, r)) * (1 - band * 0.7)
                col = col * (1 - k[..., None] * (st[..., None] - 0.5) * 0.9)
            # pupil (+ lighter ring around it)
            pr = q['pupil']
            dp = S.ellipse(X, Y, cx, cy + 0.06 * ry, pr * rx, pr * 1.12 * ry)
            if q['pupilRing'] > 0:
                dr_ = S.ellipse(X, Y, cx, cy + 0.06 * ry, pr * rx * 1.35, pr * 1.12 * ry * 1.35)
                col = S.mix(col, np.clip(base * 1.25 + 0.05, 0, 1), (S.cover(dr_, px, 0.1 * rx * pr) * (1 - S.cover(dp, px)) * q['pupilRing'] * (1 - band))[..., None])
            col = S.mix(col, pc, S.cover(dp, px)[..., None])
            # limbal ring
            rw = q['ringW'] * min(rx, ry)
            col = S.mix(col, ring, (1 - S.cover(d + rw, px))[..., None] * 0.92)
            S.over(out, np.clip(col, 0, 1), cov)
        self._finish('iris', out, mask)

    def paint_highlight(self, p):
        q = p['hl']; sc = p['scale']; L = p['toLight']
        out, mask, P, N, px = self._canvas('hl', sc)
        X, Y = P[..., 0], P[..., 1]
        wc = S.hexc(q['color'])
        for ir in self.irises:
            rx, ry, cx, cy = ir['rx'] * p['iris']['scale'], ir['ry'] * p['iris']['scale'], ir['cx'], ir['cy']
            side = mask & (np.sign(X) == np.sign(cx))
            hx, hy, hw, hh = q['main']
            d = S.ellipse(X, Y, cx + L * hx * rx, cy + hy * ry, hw * rx, hh * ry,
                          rot=q['mainRot'] * (1 if L > 0 else -1))
            S.over(out, wc, S.cover(d, px) * side)
            dx, dy, dr = q['dot']
            d2 = S.ellipse(X, Y, cx + L * dx * rx, cy + dy * ry, dr * rx, dr * ry * 1.1)
            S.over(out, wc, S.cover(d2, px) * side * 0.95)
            for k in range(int(q['sparkles'])):
                a = 2.2 + k * 1.3
                sx = cx + L * np.cos(a) * 0.55 * rx; sy = cy + np.sin(a) * 0.55 * ry - 0.1 * ry
                ds = S.ellipse(X, Y, sx, sy, 0.05 * rx, 0.05 * rx)
                S.over(out, wc, S.cover(ds, px) * side * 0.9)
            if q['bar'] > 0:
                db = S.ellipse(X, Y, cx, cy - 0.72 * ry, 0.45 * rx, 0.07 * ry)
                S.over(out, wc, S.cover(db, px, 0.05 * ry) * side * q['bar'])
        self._finish('hl', out, mask)

    def paint_white(self, p):
        q = p['eye']; sc = p['scale']
        out, mask, P, N, px = self._canvas('white', sc)
        X, Y = P[..., 0], P[..., 1]
        out[..., :3] = S.hexc(q['white']); out[..., 3] = mask
        for e in self.eyes:
            side = mask & (np.sign(X) == np.sign(e.cx))
            yt = e.ytop(np.clip(X, e.up[0, 0], e.up[-1, 0]))
            hsh = q['whiteShadowH'] * e.eh * 2
            # shadow cast by the upper lid: curved band, hard lower edge
            u = e.u(X)
            yb = yt - hsh * (1 - 0.35 * u ** 2)
            sh = S.cover(yb - Y, px * 1.5) * side
            S.over(out, S.hexc(q['whiteShadow']), sh)
            # corners slightly cooler
            k = S.smoothstep(0.55, 1.1, np.abs(u)) * 0.35 * side
            S.over(out, S.mix(S.hexc(q['white']), S.hexc(q['whiteShadow']), 0.7), k)
        out[..., 3] = mask.astype(np.float32)
        self._finish('white', out, mask, alpha_bg=0)

    def paint_line(self, p):
        q = p['eye']; sc = p['scale']
        out, mask, P, N, px = self._canvas('line', sc)
        X, Y = P[..., 0], P[..., 1]
        c1, c2 = S.hexc(q['line']), S.hexc(q['line2'])
        for e in self.eyes:
            side = mask & (np.sign(X) == np.sign(e.cx))
            u = e.u(X)
            xc = np.clip(X, e.up[0, 0], e.up[-1, 0])
            yt = e.ytop(xc)
            t = np.clip((u + 1) / 2, 0, 1)
            w = e.eh * (q['lineIn'] + (q['lineMax'] - q['lineIn']) * S.smoothstep(0.0, 0.8, t))
            w = w * S.smoothstep(q['innerCut'], -0.72, u)          # thin taper into the inner corner
            lo = yt - q['lineOverlap'] * e.eh
            hi = yt + w
            dd = np.maximum(lo - Y, Y - hi)
            dd = np.maximum(dd, (q['innerCut'] - u) * e.ew)
            main = S.cover(dd, px) * (u <= 1.0)
            # wing past the outer corner: a tapered wedge continuing the line
            wing = np.zeros_like(main)
            if q['wing'] > 0:
                oc = e.corner_out
                w1 = e.eh * q['lineMax'] * q['wingThick']
                tip = np.array([e.x_of(1 + q['wing']), oc[1] + q['wingDrop'] * e.eh * 2 + w1 * 0.3])
                s_ = np.clip((u - 1) / q['wing'], 0, 1)
                top_ = (oc[1] + w1) * (1 - s_) + tip[1] * s_
                bot_ = (oc[1] - q['lineOverlap'] * e.eh) * (1 - s_) + tip[1] * s_
                dw = np.maximum(np.maximum(bot_ - Y, Y - top_), (u - (1 + q['wing'])) * e.ew)
                wing = S.cover(dw, px) * (u > 0.9)
            a = np.maximum(main, wing) * side
            # colour: darker at the top edge, warmer toward the eye
            k = np.clip((Y - lo) / np.maximum(hi - lo, 1e-6), 0, 1)
            col = S.mix(c2, c1, S.smoothstep(0.1, 0.7, k)[..., None])
            S.over(out, col, a)
        self._finish('line', out, mask)

    def paint_lash(self, p):
        q = p['eye']; sc = p['scale']
        out, mask, P, N, px = self._canvas('lash', sc)
        X, Y = P[..., 0], P[..., 1]
        c1 = S.hexc(q['line'])
        n = int(q['spikes'])
        for e in self.eyes:
            side = mask & (np.sign(X) == np.sign(e.cx))
            for k in range(n):
                t = 0.62 + 0.38 * (k + 0.5) / max(n, 1)          # outer part of the lid
                uu = 2 * t - 1
                x0 = e.x_of(min(uu, 0.98)); y0 = float(e.ytop(np.clip(x0, e.up[0, 0], e.up[-1, 0])))
                w0 = e.eh * (q['lineIn'] + (q['lineMax'] - q['lineIn']) * S.smoothstep(0.0, 0.8, t))
                L = q['spikeLen'] * e.eh * (0.75 + 0.45 * (k + 1) / n)
                ang = np.radians(62 - 38 * (k + 1) / n)            # outer spikes lie flatter
                dirv = np.array([e.sgn * np.cos(ang), np.sin(ang)])
                perp = np.array([dirv[1] * e.sgn, -dirv[0] * e.sgn]) * e.sgn   # bends the tip outward/down
                base = np.array([x0, y0 + w0 * 0.5])
                tip = base + dirv * L + perp * L * 0.18
                mid = base + dirv * L * 0.55
                pts = S.bezier(base, mid, tip, n=12)
                wd = q['spikeW'] * e.eh * np.linspace(1, 0, len(pts)) ** 0.9
                d, _ = S.polyline(X, Y, pts, wd)
                S.over(out, c1, S.cover(d, px) * side)
        self._finish('lash', out, mask)

    def paint_brow(self, p):
        q = p['brow']; sc = p['scale']
        out, mask, P, N, px = self._canvas('brow', sc)
        X, Y = P[..., 0], P[..., 1]
        col = S.hexc(q['color'] or '#4a3040')
        for e in self.eyes:
            side = mask & (np.sign(X) == np.sign(e.cx))
            h = q['height'] * e.eh
            a = np.array([e.x_of(q['inner']), e.cy + h + q['tilt'] * e.eh])
            b = np.array([e.x_of(0.35), e.cy + h + q['arch'] * e.eh + 0.5 * q['tilt'] * e.eh * 0])
            c = np.array([e.x_of(q['outer']), e.cy + h - 0.25 * e.eh - q['tilt'] * e.eh * 0.3])
            pts = S.bezier(a, b, c, n=28)
            tt = np.linspace(0, 1, len(pts))
            if q['shape'] == 'male':
                prof = q['innerWidth'] + (1 - q['innerWidth']) * np.sin(np.pi * np.clip(tt * 0.9 + 0.1, 0, 1)) ** 0.5
                prof = prof * (1 - S.smoothstep(0.75, 1.0, tt) * 0.85)
            else:
                prof = np.sin(np.pi * np.clip(tt * 0.92 + 0.06, 0, 1)) ** 0.7 * (0.55 + 0.45 * (1 - tt))
            wd = q['width'] * e.eh * 2 * prof
            d, _ = S.polyline(X, Y, pts, wd)
            S.over(out, col, S.cover(d, px) * side)
        self._finish('brow', out, mask)

    def paint_skin(self, p):
        q = p['skin']; sc = p['scale']; L = p['toLight']
        src = self.image('skin')
        H, W = src.shape[0] * sc, src.shape[1] * sc
        mask, P, N, px = self.pmap('skin', W, H)
        out = imgio.resize(src, W, H).astype(np.float32)
        X, Y, Z = P[..., 0], P[..., 1], P[..., 2]
        front = mask & (N[..., 2] < 0.2)            # front-facing texels only (the face looks toward -Z)
        base = np.median(out[front & (np.abs(X) < 0.03) & (Y > self.eye_y + self.eh * 2)][:, :3], axis=0) if front.any() else np.array([0.97, 0.87, 0.8])
        shade = S.hexc(q['shade']) if q['shade'] else np.clip(base * np.array([0.88, 0.68, 0.66]), 0, 1)
        def erase(cx, cy, r0, r1, sy=1.0):
            r = np.sqrt((X - cx) ** 2 + ((Y - cy) * sy) ** 2)
            ring = front & (r > r1) & (r < r1 * 1.35)
            if not ring.any():
                return
            col = np.median(out[ring][:, :3], axis=0)
            S.over(out, col, (1 - S.smoothstep(r0, r1, r)) * front)
        if q.get('flatten', 0) > 0:
            # clean flat base on the front of the face: VRoid skins carry soft painted gradients that read as
            # grey mud under cel lighting. Keeps the edges (ears, neck, scalp border) of the original.
            fl = q.get('flattenFade', (2.9, 3.6))            # (optional wider fade: no visible edge on the cheek)
            fw = q['flatten'] * front * (1 - S.smoothstep(fl[0] * self.ew, fl[1] * self.ew, np.abs(X)))
            fw = fw * S.smoothstep(self.chin_y - 0.004, self.chin_y + 0.01, Y)
            S.over(out, base, fw)
        if q['eraseNose']:
            erase(self.nose[0], self.nose[1], self.eh * 0.6, self.eh * 1.0, 0.8)
        if q.get('eraseMouthDot', True):
            # VRoid skins carry a tiny white fang dot under the mouth line
            erase(0.0, self.mouth_y - self.eh * 0.36, self.eh * 0.16, self.eh * 0.3, 1.0)
        # dark eye sockets (optional, 'socket' > 0: a demon / possessed / sleepless look drawn as a soft dark ring of
        # shadow around the whole eye -- colour 'socketColor', default the lash line colour)
        if q.get('socket', 0) > 0:
            scol = S.hexc(q.get('socketColor') or p['eye']['line'])
            for e in self.eyes:
                side = front & (np.sign(X) == np.sign(e.cx))
                r = np.sqrt(((X - e.cx) / (1.45 * e.ew)) ** 2 + ((Y - e.cy) / (2.3 * e.eh)) ** 2)
                S.over(out, scol, (1 - S.smoothstep(0.7, 1.0, r)) * side * q['socket'])
        # double-eyelid crease + lower lash hint + inner lower lid pink
        for e in self.eyes:
            side = front & (np.sign(X) == np.sign(e.cx))
            u = e.u(X)
            xc = np.clip(X, e.up[0, 0], e.up[-1, 0])
            if q['crease'] > 0:
                s0, s1 = q['creaseSpan']
                xs = np.linspace(s0, s1, 20)
                pts = np.stack([e.x_of(xs), e.ytop(np.clip(e.x_of(xs), e.up[0, 0], e.up[-1, 0])) + q['crease'] * e.eh * (1 - 0.25 * xs ** 2)], 1)
                wd = 0.05 * e.eh * S.taper(np.linspace(0, 1, 20), 0.8)
                d, _ = S.polyline(X, Y, pts, wd)
                S.over(out, np.clip(shade * 0.82, 0, 1), S.cover(d, px) * side * q['creaseAlpha'])
            if q['lowerLash'] > 0:
                s0, s1 = q['lowerLashSpan']
                xs = np.linspace(s0, s1, 16)
                xx = e.x_of(xs)
                pts = np.stack([xx, e.ylow(np.clip(xx, e.lo[0, 0], e.lo[-1, 0])) - 0.04 * e.eh], 1)
                wd = 0.06 * e.eh * S.taper(np.linspace(0, 1, 16), 0.9)
                d, _ = S.polyline(X, Y, pts, wd)
                S.over(out, S.hexc(p['eye']['line2']), S.cover(d, px) * side * q['lowerLash'])
            if q['lidPink'] > 0:
                xs = np.linspace(-0.95, 0.2, 12); xx = e.x_of(xs)
                pts = np.stack([xx, e.ylow(np.clip(xx, e.lo[0, 0], e.lo[-1, 0])) - 0.05 * e.eh], 1)
                d, _ = S.polyline(X, Y, pts, 0.07 * e.eh * S.taper(np.linspace(0, 1, 12), 0.7))
                S.over(out, np.array([0.93, 0.62, 0.62]), S.cover(d, px) * side * q['lidPink'])
        # blush
        if q['blushAlpha'] > 0:
            bc = S.hexc(q['blush'])
            for e in self.eyes:
                side = front & (np.sign(X) == np.sign(e.cx))
                bx = e.x_of(0.15) * q['blushX']; by = e.cy + q['blushY'] * e.eh
                rx = e.ew * 1.15 * q['blushSize']; ry = e.eh * 0.55 * q['blushSize']
                db = S.ellipse(X, Y, bx, by, rx, ry)
                k = (1 - S.smoothstep(-ry * 0.9, ry * 0.15, db)) * side
                S.over(out, bc, k * q['blushAlpha'])
                for h in range(int(q['blushHatch'])):
                    hx = bx + (h - (q['blushHatch'] - 1) / 2) * rx * 0.35
                    pts = np.array([[hx + e.sgn * 0.12 * ry, by + ry * 0.55], [hx - e.sgn * 0.12 * ry, by - ry * 0.55]])
                    d, _ = S.polyline(X, Y, pts, 0.09 * ry)
                    S.over(out, np.clip(bc * 0.8, 0, 1), S.cover(d, px) * side * 0.7)
        if q.get('mouthLine'):
            # the closed-mouth line, drawn along the carved slit (thicker middle, soft upturned corners)
            hw = self.mouth_w * q['mouthW']
            xs = np.linspace(-1, 1, 25)
            pts = np.stack([xs * hw, self.mouth_y + q['mouthCurve'] * self.eh * xs ** 2 - 0.004 * 0], 1)
            wd = q['mouthThick'] * self.eh * (0.35 + 0.65 * np.cos(xs * np.pi / 2) ** 0.7)
            if q.get('mouthDrawn'):
                # the DRAWN neutral mouth (optional): width / stroke in eye-distance units, each corner's lift as a
                # share of the width (character's left = -X), a crisp line tapering to fine corners
                md = q['mouthDrawn']
                ipd3 = abs(self.eyes[0].cx - self.eyes[1].cx)
                hw = float(np.clip(md['width_ipd'] / 2 * ipd3, 0.4 * self.mouth_w, 1.6 * self.mouth_w))
                W3 = 2 * hw
                lift = np.where(xs < 0, md.get('left', 0.0), md.get('right', 0.0)) * W3
                pts = np.stack([xs * hw, self.mouth_y + lift * np.abs(xs) ** 1.8], 1)
                th = float(np.clip(md.get('thick_ipd', 0.02) * ipd3, 0.25 * q['mouthThick'] * self.eh,
                                   1.4 * q['mouthThick'] * self.eh))
                wd = th * (0.25 + 0.75 * np.cos(xs * np.pi / 2) ** 0.6)
            d, _ = S.polyline(X, Y, pts, wd)
            S.over(out, S.hexc(q['mouthLine']), S.cover(d, px) * front)
        # nose: a small shadow tick on the side away from the light (+ optional tiny highlight)
        if q['nose'] and q['nose'] != 'none':
            nc = S.hexc(q['noseColor']) if q['noseColor'] else np.clip(shade * 0.9, 0, 1)
            nx, ny = self.nose[0], self.nose[1]
            s = q['noseSize'] * self.eh
            if q['nose'] == 'tick':
                pts = np.array([[nx - L * 0.10 * s, ny + 0.55 * s], [nx - L * 0.30 * s, ny - 0.05 * s], [nx - L * 0.05 * s, ny - 0.22 * s]])
                wd = np.array([0.02, 0.12, 0.03]) * s * 1.2
                d, _ = S.polyline(X, Y, pts, wd)
            elif q['nose'] == 'dot':
                d = S.ellipse(X, Y, nx - L * 0.1 * s, ny - 0.1 * s, 0.09 * s, 0.07 * s)
            else:  # 'wedge' (boys / older): shadow on the far side of the bridge + under-tip
                pts = np.array([[nx - L * 0.12 * s, ny + 1.3 * s], [nx - L * 0.22 * s, ny + 0.4 * s], [nx - L * 0.28 * s, ny - 0.02 * s], [nx + L * 0.05 * s, ny - 0.25 * s]])
                wd = np.array([0.02, 0.08, 0.14, 0.03]) * s * 1.2
                d, _ = S.polyline(X, Y, pts, wd)
            S.over(out, nc, S.cover(d, px) * front)
        if q['freckles'] > 0:
            rng = np.random.default_rng(7)
            for _ in range(int(q['freckles'])):
                fx = rng.uniform(-2.3, 2.3) * self.ew; fy = self.nose[1] + rng.uniform(0.2, 1.6) * self.eh
                if abs(fx) < 0.3 * self.ew and fy > self.nose[1] + 1.2 * self.eh:
                    continue
                rr = rng.uniform(0.035, 0.07) * self.eh
                d = S.ellipse(X, Y, fx, fy, rr, rr * rng.uniform(0.7, 1.0))
                S.over(out, np.clip(shade * 0.85, 0, 1), S.cover(d, px) * front * 0.55)
        if q.get('fringeShadow'):
            self._fringe(out, X, Y, Z, front, px, q['fringeShadow'], shade)
        out[..., 3] = np.maximum(out[..., 3], 0)
        self.put('skin', out)

    def _fringe(self, out, X, Y, Z, front, px, f, shade):
        """Hard fringe-shadow band on the forehead: jagged lower edge (clump tips), shade colour."""
        y0 = self.eye_y + f.get('y', 2.9) * self.eh
        amp = f.get('amp', 0.45) * self.eh; n = f.get('clumps', 7)
        ph = np.clip(X / (2.6 * self.ew), -1, 1) * n * np.pi
        tri = np.abs(((ph / np.pi) % 2) - 1)               # 0..1 zigzag across the forehead
        edge = y0 - amp * (1 - tri) ** 1.6 - f.get('sag', 0.4) * self.eh * (X / (2.6 * self.ew)) ** 2
        k = S.cover(edge - Y, px * 1.5) * front * (np.abs(X) < 2.7 * self.ew)
        S.over(out, np.clip(shade * 0.98, 0, 1), k * f.get('alpha', 0.9))

    # ------------------------------------------------------------------ shading
    def proxy_normals(self, amount: float = 1.0, nose_keep: float = 0.25):
        """Replace the skin's shading normals with a fitted head ellipsoid's (blended back to the original at
        the mesh border so the face-to-neck / scalp seams stay invisible), zero the morphs' normal deltas there."""
        d = self.d
        sv = d.verts_of(self.prims['skin'])
        Pv = d.P[sv]
        fr = Pv[(Pv[:, 1] > self.chin_y) & (Pv[:, 2] < np.median(Pv[:, 2]))]
        # axis-aligned ellipsoid, symmetric in x, centre (0, cy, cz) by grid search (the face alone can't pin it)
        best = None
        zf = float(fr[:, 2].min())
        for cy in self.eye_y + np.linspace(-0.07, 0.03, 21):
            for cz in zf + np.linspace(0.03, 0.14, 23):
                M = np.stack([fr[:, 0] ** 2, (fr[:, 1] - cy) ** 2, (fr[:, 2] - cz) ** 2], 1)
                co, *_ = np.linalg.lstsq(M, np.ones(len(fr)), rcond=None)
                if (co <= 0).any():
                    continue
                k = np.sqrt(M @ co)
                err = float(np.mean(((k - 1) / np.sqrt(co.mean())) ** 2))
                if best is None or err < best[0]:
                    best = (err, cy, cz, co)
        _, cy, cz, (A, B, C) = best
        n = np.stack([A * Pv[:, 0], B * (Pv[:, 1] - cy), C * (Pv[:, 2] - cz)], 1)
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
        orig = d.N[sv] / np.maximum(np.linalg.norm(d.N[sv], axis=1, keepdims=True), 1e-9)
        # distance to the skin border -> blend weight
        B_ = d.P[self.boundary_idx]
        eye_keys = {tuple(k) for k in np.round(np.concatenate([e.loop for e in self.eyes]) * 1e5).astype(np.int64)}
        outer = np.array([b for b in B_ if tuple(np.round(b * 1e5).astype(np.int64)) not in eye_keys])
        dist = np.min(np.linalg.norm(Pv[:, None, :] - outer[None, :, :], axis=-1), axis=1) if len(outer) else np.ones(len(Pv))
        w = S.smoothstep(0.004, 0.03, dist) * amount
        # keep a little of the nose's own shape (a small nose shadow), fully proxy elsewhere
        rn = np.sqrt((Pv[:, 0] - self.nose[0]) ** 2 + (Pv[:, 1] - self.nose[1]) ** 2)
        w = w * (1 - nose_keep * (1 - S.smoothstep(self.eh * 0.5, self.eh * 1.4, rn)))
        # only the front of the head: behind the ears keep the original
        w = w * (1 - S.smoothstep(cz - 0.01, cz + 0.02, Pv[:, 2]))
        newn = orig * (1 - w[:, None]) + n * w[:, None]
        newn /= np.maximum(np.linalg.norm(newn, axis=1, keepdims=True), 1e-9)
        d.N[sv] = newn
        for t in d.targets:
            if 'NORMAL' in t:
                t['NORMAL'][sv] *= (1 - w[:, None])
        self.m.write_mesh(self.fi, d)
        self.log(f'face_kit: proxy normals on {len(sv)} skin verts (ellipsoid a={1/np.sqrt(A):.3f} b={1/np.sqrt(B):.3f} c={1/np.sqrt(C):.3f} centre y={cy:.3f} z={cz:.3f})')

    def mtoon(self, q: dict, shade_rgb=None):
        m = self.m
        for key in ('skin',):
            for mat in self.mats[key]:
                mp = m.mtoon(mat); fp = mp.setdefault('floatProperties', {})
                fp['_ShadeShift'] = float(q['skinShadeShift']); fp['_ShadeToony'] = float(q['skinToony'])
                fp['_RimLightingMix'] = 0.0
                tp = mp.get('textureProperties', {})
                tp.pop('_BumpMap', None)                                     # the VRoid face normal map fights the proxy
                tp.pop('_SphereAdd', None)                                   # matcap rim = plastic sheen on a cel face
                mp.get('keywordMap', {}).pop('_NORMALMAP', None)
                m.J['materials'][mat].pop('normalTexture', None)
                if shade_rgb is not None:
                    mp.setdefault('vectorProperties', {})['_ShadeColor'] = [*map(float, shade_rgb), 1.0]
        # body skin (neck, hands) must match the face: same matcap removal + shade colour
        for i, mt in enumerate(m.J['materials']):
            if 'Body' in mt['name'] and 'SKIN' in mt['name']:
                mp = m.mtoon(i)
                mp.get('textureProperties', {}).pop('_SphereAdd', None)
                if shade_rgb is not None:
                    mp.setdefault('vectorProperties', {})['_ShadeColor'] = [*map(float, shade_rgb), 1.0]
        for key in ('white', 'iris', 'hl', 'line', 'lash', 'brow'):
            for mat in self.mats[key]:
                mp = m.mtoon(mat); fp = mp.setdefault('floatProperties', {})
                fp['_ShadeShift'] = float(q['partsShadeShift']); fp['_ShadeToony'] = float(q['partsToony'])
                vp = mp.setdefault('vectorProperties', {})
                vp['_Color'] = [1.0, 1.0, 1.0, 1.0]; vp['_ShadeColor'] = [1.0, 1.0, 1.0, 1.0]
                fp['_ReceiveShadowRate'] = 0.0
                mp.get('textureProperties', {}).pop('_BumpMap', None)
                mp.get('textureProperties', {}).pop('_SphereAdd', None)
                pbr = m.J['materials'][mat].setdefault('pbrMetallicRoughness', {})
                pbr['baseColorFactor'] = [1.0, 1.0, 1.0, 1.0]
            if key == 'hl':
                for mat in self.mats[key]:
                    mp = m.mtoon(mat)
                    mp['textureProperties']['_EmissionMap'] = mp['textureProperties']['_MainTex']
                    mp['vectorProperties']['_EmissionColor'] = [0.6, 0.6, 0.6, 1.0]

    # ------------------------------------------------------------------ design view
    def design_view(self, path: str, size: int = 800):
        """Flat frontal composite of all painted parts (no lighting) — quick look at the face design."""
        from PIL import Image
        order = ['white', 'iris', 'hl', 'skin', 'line', 'lash', 'brow']
        x0, x1 = -4.3 * self.ew, 4.3 * self.ew
        y1 = self.eye_y + 4.5 * self.eh; y0 = self.chin_y - 0.3 * self.eh
        Hh = int(size * (y1 - y0) / (x1 - x0))
        canvas = np.zeros((Hh, size, 3), np.float32) + 0.8
        zbuf = np.full((Hh, size), -1.0)
        for li, key in enumerate(order):
            a = self.cache.get(self._own(key))
            if a is None:
                a = self.image(key)
            H, W = a.shape[:2]
            mask, P, Nm, _ = self.pmap(key, W, H)
            sel = mask & (a[..., 3] > 0.02)
            if key == 'skin':
                sel = mask & (Nm[..., 2] < 0.3)
            pts = P[sel]; col = a[sel]
            ix = ((-(pts[:, 0]) - x0) / (x1 - x0) * size).astype(int)    # viewer's right = -x
            iy = ((y1 - pts[:, 1]) / (y1 - y0) * Hh).astype(int)
            ok = (ix >= 0) & (ix < size) & (iy >= 0) & (iy < Hh)
            ix, iy, col = ix[ok], iy[ok], col[ok]
            al = col[:, 3:4] if key != 'skin' else np.ones((len(col), 1))
            for oy in (0, 1):
                for ox in (0, 1):
                    jy = np.clip(iy + oy, 0, Hh - 1); jx = np.clip(ix + ox, 0, size - 1)
                    canvas[jy, jx] = canvas[jy, jx] * (1 - al) + col[:, :3] * al
        Image.fromarray((np.clip(canvas, 0, 1) * 255).astype(np.uint8)).save(path)
