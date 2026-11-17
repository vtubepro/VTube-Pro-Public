"""
Colour + texture work on the VRoid MToon materials, always preserving the hand-painted shading:

  * ramp recolour (hair, iris, garments): per-texel luminance relative to the texture's own base tone
    drives a shade -> base -> highlight ramp in the new colour (lines stay lines, folds stay folds);
    optional gradient along the hair strand (texture v = root -> tip).
  * ratio tint (skin, sclera, lashes): multiply by target/reference so blush + lines survive.
  * decals / patterns painted in UV space (eye sockets, shark teeth, shirt prints).

Images shared by several materials are edited once (per image index) and re-encoded at the end.
"""
from __future__ import annotations

import colorsys
import re

import numpy as np

from . import imgio
from .vroid import Model


def hex_rgb(h: str) -> np.ndarray:
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)], np.float32)


def to_lin(c):
    c = np.asarray(c, np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def to_srgb(c):
    c = np.clip(np.asarray(c, np.float32), 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def lum(rgb):
    return rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722


def shift(rgb, dh=0.0, ds=1.0, dv=1.0):
    h, s, v = colorsys.rgb_to_hsv(*[float(x) for x in rgb])
    return np.array(colorsys.hsv_to_rgb((h + dh) % 1, min(1, s * ds), min(1, v * dv)), np.float32)


def default_shade(base):
    """Anime shade: darker, a bit more saturated, hue nudged toward blue/purple."""
    h, s, v = colorsys.rgb_to_hsv(*[float(x) for x in base])
    target = 0.72  # purple-blue
    dh = ((target - h + 0.5) % 1 - 0.5) * 0.12
    return np.array(colorsys.hsv_to_rgb((h + dh) % 1, min(1, s * 1.15 + 0.08), v * 0.62), np.float32)


class Textures:
    """Decoded-image cache keyed by glTF image index."""

    def __init__(self, m: Model):
        self.m = m
        self.cache: dict[int, np.ndarray] = {}
        self.dirty: set[int] = set()

    def get(self, ii: int) -> np.ndarray:
        if ii not in self.cache:
            self.cache[ii] = imgio.decode(self.m.g.image_bytes(ii))
        return self.cache[ii]

    def put(self, ii: int, a: np.ndarray):
        self.cache[ii] = a; self.dirty.add(ii)

    def flush(self):
        for ii in sorted(self.dirty):
            self.m.g.set_image(ii, imgio.encode(self.cache[ii]))
        self.dirty.clear()

    def main_image(self, mat: int) -> int | None:
        tp = self.m.mtoon(mat).get('textureProperties', {})
        ti = tp.get('_MainTex')
        return self.m.J['textures'][ti]['source'] if ti is not None else None

    def own_image(self, mat: int, prop: str = '_MainTex') -> int:
        """Give `mat` its own copy of its image (so recolouring doesn't leak to other materials)."""
        m = self.m
        tp = m.mtoon(mat)['textureProperties']
        ti = tp[prop]
        ii = m.J['textures'][ti]['source']
        users = [k for k, mp in enumerate(m.vrm['materialProperties'])
                 if any(m.J['textures'][t]['source'] == ii for t in mp.get('textureProperties', {}).values())]
        if users == [mat]:
            return ii
        a = self.get(ii).copy()
        ni = m.g.add_image(imgio.encode(a), m.J['images'][ii].get('name', 'img') + f'_{mat}')
        nt = m.g.add_texture(ni, m.J['textures'][ti].get('sampler', 0))
        for k in ('_MainTex', '_ShadeTexture'):
            if tp.get(k) == ti:
                tp[k] = nt
        pbr = m.J['materials'][mat].get('pbrMetallicRoughness', {})
        if pbr.get('baseColorTexture', {}).get('index') == ti:
            pbr['baseColorTexture']['index'] = nt
        self.cache[ni] = a
        return ni


# ---------------------------------------------------------------------- core recolour ops
def ramp_recolor(a: np.ndarray, base, shade=None, hi=None, tip=None, tip_range=(0.35, 0.95),
                 mask: np.ndarray | None = None, ref_pct: float = 70, strength: float = 1.0,
                 contrast: float = 1.0) -> np.ndarray:
    base = np.asarray(base, np.float32)
    shade = default_shade(base) if shade is None else np.asarray(shade, np.float32)
    hi = np.clip(base + (1 - base) * 0.55, 0, 1) if hi is None else np.asarray(hi, np.float32)
    rgb = a[..., :3]
    L = lum(to_lin(rgb))
    sel = (a[..., 3] > 0.5) if mask is None else (mask & (a[..., 3] > 0.05))
    if not sel.any():
        return a
    ref = np.percentile(L[sel], ref_pct) + 1e-4
    t = (L / ref) ** (0.6 * contrast)                          # perceptual-ish ratio, 1 = base tone
    H, Wd = a.shape[:2]
    if tip is not None:
        v = (np.arange(H, dtype=np.float32) + 0.5)[:, None] / H
        g = np.clip((v - tip_range[0]) / (tip_range[1] - tip_range[0]), 0, 1)
        g = g * g * (3 - 2 * g)
        g = np.broadcast_to(g, (H, Wd))[..., None]
        tip = np.asarray(tip, np.float32)
        base_px = base * (1 - g) + tip * g
        shade_px = shade * (1 - g) + default_shade(tip) * g
        hi_px = hi * (1 - g) + np.clip(tip + (1 - tip) * 0.55, 0, 1) * g
    else:
        base_px, shade_px, hi_px = base, shade, hi
    tt = np.clip(t, 0, 1)[..., None]
    col = shade_px * (1 - tt) + base_px * tt
    line = np.clip(t / 0.45, 0, 1)[..., None]                   # dark painted lines stay dark
    col = col * (0.35 + 0.65 * line)
    up = np.clip((t - 1) / 0.5, 0, 1)[..., None]
    col = col * (1 - up) + hi_px * up
    out = a.copy()
    w = sel[..., None].astype(np.float32) * strength
    out[..., :3] = rgb * (1 - w) + np.clip(col, 0, 1) * w
    return out


def ratio_tint(a: np.ndarray, target, mask: np.ndarray | None = None, ref=None, amount: float = 1.0) -> np.ndarray:
    rgb = a[..., :3]
    sel = (a[..., 3] > 0.5) if mask is None else mask
    lin = to_lin(rgb)
    if ref is None:
        ref = np.median(lin[sel], axis=0) if sel.any() else np.ones(3)
    else:
        ref = to_lin(ref)
    k = to_lin(target) / np.maximum(ref, 1e-3)
    new = to_srgb(np.clip(lin * k, 0, 1))
    out = a.copy()
    w = sel[..., None].astype(np.float32) * amount
    out[..., :3] = rgb * (1 - w) + new * w
    return out


def soft_disc(shape, center_uv, radius_uv, feather=0.5, aspect=1.0):
    H, W = shape
    y, x = np.mgrid[0:H, 0:W]
    u = (x + 0.5) / W; v = (y + 0.5) / H
    r = np.sqrt(((u - center_uv[0]) / aspect) ** 2 + (v - center_uv[1]) ** 2) / radius_uv
    return np.clip((1 - r) / max(feather, 1e-3), 0, 1)


# ---------------------------------------------------------------------- material roles
def materials_by(m: Model, rx: str) -> list[int]:
    return [i for i, mt in enumerate(m.J['materials']) if re.search(rx, mt['name'])]


def set_vec(m: Model, mat: int, prop: str, rgba):
    m.mtoon(mat).setdefault('vectorProperties', {})[prop] = [float(x) for x in rgba]


def apply(m: Model, prm: dict, ctx):
    C = prm['colors']
    tx = ctx.setdefault('tex', Textures(m))
    log = ctx['log']
    # ---------------- skin ----------------
    if C.get('skin'):
        target = hex_rgb(C['skin'])
        done = set()
        for mat in materials_by(m, r'_(Face|Body)_00_SKIN'):
            ii = tx.main_image(mat)
            if ii is None or ii in done:
                continue
            done.add(ii)
            a = tx.get(ii)
            sel = a[..., 3] > 0.5
            # reference = the typical skin tone of this texture
            tx.put(ii, ratio_tint(a, target, sel))
            sh = m.mtoon(mat)['vectorProperties'].get('_ShadeColor')
            if sh:
                # VRoid skin shade is a warm pink multiply: re-derive it from the new tone
                s = shift(target, 0.0, 1.35, 0.86)
                set_vec(m, mat, '_ShadeColor', [*(s / np.maximum(target, 1e-3)).clip(0, 1), 1])
        log('colors: skin')
    # ---------------- hair ----------------
    if C.get('hair'):
        base = hex_rgb(C['hair'])
        tip = hex_rgb(C['hairTip']) if C.get('hairTip') else None
        shade = hex_rgb(C['hairShade']) if C.get('hairShade') else None
        done = set()
        for mat in materials_by(m, r'HAIR'):
            ii = tx.main_image(mat)
            if ii is not None and ii not in done:
                done.add(ii)
                a = tx.get(ii)
                is_back = 'HairBack' in m.mat_name(mat)
                inner = C.get('hairInner') and re.search(r'HAIR_02', m.mat_name(mat))
                b = hex_rgb(C['hairInner']) if inner else base
                tx.put(ii, ramp_recolor(a, b, shade, tip=None if is_back else tip,
                                        tip_range=tuple(C.get('hairTipRange', (0.35, 0.95))),
                                        contrast=float(C.get('hairContrast', 1.0))))
            mp = m.mtoon(mat)
            set_vec(m, mat, '_Color', [1, 1, 1, 1])
            sc = C.get('hairShadeMul', [0.82, 0.8, 0.95])
            set_vec(m, mat, '_ShadeColor', [*sc, 1])
            oc = default_shade(base) * 0.6
            set_vec(m, mat, '_OutlineColor', [*oc, 1])
            mp.setdefault('floatProperties', {})
        log('colors: hair')
    # ---------------- eyes ----------------
    if C.get('eyes'):
        col = hex_rgb(C['eyes'])
        for mat in materials_by(m, r'EyeIris'):
            ii = tx.own_image(mat)
            a = tx.get(ii)
            tx.put(ii, ramp_recolor(a, col, hi=np.clip(col + (1 - col) * 0.7, 0, 1), ref_pct=85,
                                    contrast=1.2))
            glow = float(C.get('eyeGlow', 0))
            if glow > 0:
                mp = m.mtoon(mat)
                mp['textureProperties']['_EmissionMap'] = mp['textureProperties']['_MainTex']
                set_vec(m, mat, '_EmissionColor', [glow, glow, glow, 1])
                m.J['materials'][mat]['emissiveFactor'] = [glow, glow, glow]
                m.J['materials'][mat]['emissiveTexture'] = {'index': mp['textureProperties']['_MainTex']}
        log('colors: eyes')
    if C.get('sclera'):
        for mat in materials_by(m, r'EyeWhite'):
            ii = tx.own_image(mat)
            a = tx.get(ii)
            tx.put(ii, ratio_tint(a, hex_rgb(C['sclera']), a[..., 3] > 0.02, ref=np.array([1, 1, 1], np.float32)))
    for key, rx in (('brows', r'FaceBrow'), ('lashes', r'FaceEye(lash|line)')):
        if C.get(key):
            for mat in materials_by(m, rx):
                ii = tx.own_image(mat)
                a = tx.get(ii)
                tx.put(ii, ramp_recolor(a, hex_rgb(C[key]), mask=a[..., 3] > 0.05, ref_pct=90, strength=0.9))
    if C.get('lips'):
        pass
