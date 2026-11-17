"""
2D vector-shape helpers for face painting. Every function takes face-space coordinates (X, Y arrays, metres or
any consistent unit) and returns a signed distance (negative inside) or a 0..1 coverage. `px` = size of one
texel in the same unit, used for analytic anti-aliasing, so shapes are crisp at any texture resolution.
"""
from __future__ import annotations

import numpy as np


def cover(d, px, soft: float = 0.0):
    """Coverage of a shape from its signed distance: 1-texel AA edge, optional extra softness (same unit as d)."""
    w = px + soft
    return np.clip(0.5 - d / w, 0.0, 1.0)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def ellipse(X, Y, cx, cy, rx, ry, rot: float = 0.0):
    """Approximate signed distance to an ellipse (exact on the axes, good enough for painting)."""
    x = X - cx; y = Y - cy
    if rot:
        c, s = np.cos(rot), np.sin(rot)
        x, y = c * x + s * y, -s * x + c * y
    k = np.sqrt((x / rx) ** 2 + (y / ry) ** 2) + 1e-12
    g = np.sqrt((x / rx ** 2) ** 2 + (y / ry ** 2) ** 2) / k + 1e-12   # |grad k|
    return (k - 1.0) / g


def polyline(X, Y, pts: np.ndarray, widths: np.ndarray | float, caps: bool = True):
    """Signed distance to a variable-width stroke along a polyline. widths: per-point FULL width (or scalar).
    Returns (d, t) with t = 0..1 arc-length parameter of the closest point."""
    pts = np.asarray(pts, np.float64)
    wd = np.broadcast_to(np.asarray(widths, np.float64), (len(pts),))
    seg = np.diff(pts, axis=0)
    L = np.linalg.norm(seg, axis=1)
    cum = np.concatenate([[0], np.cumsum(L)]); tot = max(cum[-1], 1e-9)
    best = np.full(np.shape(X), np.inf); tb = np.zeros(np.shape(X))
    for i in range(len(seg)):
        a = pts[i]; v = seg[i]; l2 = max(L[i] ** 2, 1e-18)
        h = np.clip(((X - a[0]) * v[0] + (Y - a[1]) * v[1]) / l2, 0, 1)
        dx = X - (a[0] + h * v[0]); dy = Y - (a[1] + h * v[1])
        w = wd[i] * (1 - h) + wd[i + 1] * h
        d = np.sqrt(dx * dx + dy * dy) - w * 0.5
        if not caps:
            end = ((i == 0) & (h <= 0)) | ((i == len(seg) - 1) & (h >= 1))
            d = np.where(end, np.inf, d)
        sel = d < best
        best = np.where(sel, d, best)
        tb = np.where(sel, (cum[i] + h * L[i]) / tot, tb)
    return best, tb


def bezier(p0, p1, p2, p3=None, n: int = 24) -> np.ndarray:
    """Sample a quadratic (3 pts) or cubic (4 pts) Bezier into a polyline."""
    t = np.linspace(0, 1, n)[:, None]
    p0, p1, p2 = (np.asarray(p, np.float64) for p in (p0, p1, p2))
    if p3 is None:
        return (1 - t) ** 2 * p0 + 2 * (1 - t) * t * p1 + t ** 2 * p2
    p3 = np.asarray(p3, np.float64)
    return (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3


def taper(t, a: float = 0.6, lo: float = 0.0):
    """Stroke width profile: 0 at both ends, 1 in the middle (sin^a), floored at lo."""
    return np.maximum(np.sin(np.pi * np.clip(t, 0, 1)) ** a, lo)


def over(dst: np.ndarray, rgb, alpha):
    """Alpha-over a flat colour (or per-texel rgb) onto an RGBA float image in place."""
    a = np.clip(alpha, 0, 1)[..., None]
    dst[..., :3] = dst[..., :3] * (1 - a) + np.asarray(rgb, np.float32) * a
    dst[..., 3:4] = dst[..., 3:4] + (1 - dst[..., 3:4]) * a
    return dst


def hexc(h: str) -> np.ndarray:
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)], np.float32)


def mix(a, b, t):
    return np.asarray(a, np.float32) * (1 - t) + np.asarray(b, np.float32) * t


def hash2(X, Y, seed: float = 0.0):
    """Deterministic per-position pseudo random 0..1 (for jagged edges / clump variation)."""
    v = np.sin(X * 12.9898 + Y * 78.233 + seed * 37.719) * 43758.5453
    return v - np.floor(v)


def vnoise1(x, seed: float = 0.0):
    """Smooth 1D value noise, 0..1."""
    i = np.floor(x); f = x - i
    a = hash2(i, seed, 1.0); b = hash2(i + 1, seed, 1.0)
    u = f * f * (3 - 2 * f)
    return a * (1 - u) + b * u


def polygon(X, Y, pts):
    """Signed distance to a closed polygon (negative inside), even-odd rule."""
    pts = np.asarray(pts, np.float64)
    d = np.full(np.shape(X), np.inf)
    inside = np.zeros(np.shape(X), bool)
    n = len(pts)
    for i in range(n):
        a = pts[i]; b = pts[(i + 1) % n]
        e = b - a; l2 = max(float(e @ e), 1e-18)
        h = np.clip(((X - a[0]) * e[0] + (Y - a[1]) * e[1]) / l2, 0, 1)
        d = np.minimum(d, np.hypot(X - a[0] - h * e[0], Y - a[1] - h * e[1]))
        cond = ((a[1] > Y) != (b[1] > Y)) & (X < (b[0] - a[0]) * (Y - a[1]) / (b[1] - a[1] + 1e-18) + a[0])
        inside ^= cond
    return np.where(inside, -d, d)
