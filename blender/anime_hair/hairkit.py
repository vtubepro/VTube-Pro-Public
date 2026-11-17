"""
anime_hair.hairkit — procedural anime hair for Blender, built the way AAA anime-game hair is modelled.

Hair is a set of layered CLUMPS (back layer, side layers, crown / quiff, fringe, ahoge). Each clump is a tapered,
slightly flattened tube swept along a guide curve:

  * guide      grown from a root on the scalp (direction, gravity, pull toward a target direction, curl, wave) with
               collision against the real head mesh, or given as explicit control points (Catmull-Rom resampled)
  * profile    8-point cross-section: an outer surface with a soft V ridge down the middle, a flatter inner side, the
               edges curled toward the head ('wrap') so a clump reads as a lock of hair, not a pipe
  * taper      thick root -> pointed tip ('point'), or a flat cut ('blunt' bangs / bob ends); optional belly
  * tips       a clump can split into 2-3 pointed sub-locks at its end (readable grouped tips)
  * frame      the wide side of the ribbon lies along the scalp (radial frame, parallel-transport fallback) + twist

A hidden inner SCALP shell (shrink-wrapped onto the head) fills every gap between clumps.

Clean toon shading (the aVersion-of-Reality custom-normals workflow): the whole hair mass is inflated, voxel-remeshed
and smoothed into a PROXY hull; its smooth normals are transferred onto every clump (Data Transfer -> custom normals),
so cel shadows fall as big clean shapes over the whole hairdo instead of per-strand noise.

Texture: one atlas (4 variants across u) — base colour gradient root -> mid -> tip, soft painted shadow strokes along
the clumps, ink lines along both clump edges (the strand separation lines of anime line art), light tip. UV u = across
the clump (0 / 1 = edges, 0.5 = ridge), v = along the clump (root -> tip).

Physics: clumps are grouped into spring chains (joints along the averaged guide); weights blend head -> chain along
the clump length. Short hair can stay rigid on the head.

Coordinates: Blender world, +Z up, the character faces +Y, character LEFT = -X (VRM import convention).
Head-local coordinates (s, f, u): s = +X (character's right), f = +Y (front), u = +Z (up), in units of the scalp
ellipsoid radii.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def unit(v):
    v = np.asarray(v, float)
    n = np.linalg.norm(v)
    return v / n if n > 1e-12 else v


def smoothstep(e0, e1, x):
    t = np.clip((np.asarray(x, float) - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def rot(axis, ang):
    x, y, z = unit(axis)
    c, s = math.cos(ang), math.sin(ang)
    C = 1 - c
    return np.array([[c + x * x * C, x * y * C - z * s, x * z * C + y * s],
                     [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
                     [z * x * C - y * s, z * y * C + x * s, c + z * z * C]])


# ============================================================================ head frame + collision
import re
# inner / overlay face parts are not collision surfaces (eyeballs, mouth cavity, lashes, brows, highlights)
EXCLUDE_RE = re.compile(r'eye|mouth|mth|brow|brw|lash|teeth|tooth|highlight|tongue', re.I)

class HeadFrame:
    """Scalp ellipsoid (centre, radii along s/f/u) + a BVH of the real head surface for collisions / rooting."""

    def __init__(self, center, radii, verts=None, polys=None):
        self.c = np.asarray(center, float)
        self.r = np.asarray(radii, float)
        self.bvh = BVHTree.FromPolygons([Vector(v) for v in verts], polys) if verts is not None else None
        self.pressers = []          # (centre, 3x3 axes, half extents, depth) boxes hair is pressed under (e.g. a mask)

    # ---- construction from a head mesh
    @classmethod
    def from_objects(cls, objs, neck_z, eye_z, pad=0.004):
        """Fit the cranium ellipsoid to the head vertices above the eyes; BVH over everything above the neck."""
        dg = bpy.context.evaluated_depsgraph_get()
        V, F = [], []
        for o in objs:
            ev = o.evaluated_get(dg)
            me = ev.to_mesh()
            M = np.array(o.matrix_world)
            P = np.zeros(len(me.vertices) * 3)
            me.vertices.foreach_get('co', P)
            P = P.reshape(-1, 3) @ M[:3, :3].T + M[:3, 3]
            keep = P[:, 2] > neck_z
            remap = -np.ones(len(P), int)
            remap[keep] = np.arange(keep.sum()) + len(V)
            V += P[keep].tolist()
            skip = {i for i, m in enumerate(me.materials) if m and EXCLUDE_RE.search(m.name)}
            for p in me.polygons:
                if p.material_index in skip:
                    continue
                ids = [remap[i] for i in p.vertices]
                if min(ids) >= 0:
                    F.append(ids)
            ev.to_mesh_clear()
        V_ = np.array(V)
        band = V_[(V_[:, 2] > eye_z + 0.012) & (V_[:, 2] < eye_z + 0.07)]
        top = V_[:, 2].max()
        cx = 0.0
        ys, yb = band[:, 1].max(), band[:, 1].min()
        a_f = (ys - yb) / 2 + pad
        a_s = (band[:, 0].max() - band[:, 0].min()) / 2 + pad
        a_u = a_f * 0.98
        c = np.array([cx, (ys + yb) / 2, top + pad - a_u])
        return cls(c, (a_s, a_f, a_u), V, F)

    # ---- local <-> world
    def local(self, s, f, u):
        return self.c + np.array([s * self.r[0], f * self.r[1], u * self.r[2]])

    def dir(self, s, f, u):
        return unit([s, f, u])

    def sph(self, theta_deg, phi_deg):
        """Unit direction for azimuth theta (0 = front, +90 = character's right, 180 = back) and elevation phi."""
        th, ph = math.radians(theta_deg), math.radians(phi_deg)
        return np.array([math.sin(th) * math.cos(ph), math.cos(th) * math.cos(ph), math.sin(ph)])

    def normal_at(self, p):
        g = (np.asarray(p) - self.c) / self.r ** 2
        return unit(g)

    def root(self, theta, phi, lift=0.002):
        """Root point on the real scalp at (theta, phi): ray from outside toward the ellipsoid centre."""
        d = self.sph(theta, phi)
        far = self.c + d * self.r * 2.2
        if self.bvh is not None:
            hit = self.bvh.ray_cast(Vector(far), Vector(-d))
            if hit[0] is not None:
                p = np.array(hit[0]); n = np.array(hit[1])
                if np.dot(n, d) < 0:
                    n = -n
                return p + n * lift, unit(n)
        p = self.c + d * self.r
        return p + self.normal_at(p) * lift, self.normal_at(p)

    def push_out(self, p, margin):
        """Keep a point at least `margin` outside the head surface (and under any presser)."""
        p = np.asarray(p, float)
        if self.bvh is not None:
            loc, nrm, _, dist = self.bvh.find_nearest(Vector(p))
            if loc is not None:
                loc = np.array(loc); nrm = np.array(nrm)
                side = np.dot(p - loc, nrm)
                if side < margin:
                    p = loc + nrm * margin if side >= -0.02 or dist < 0.03 else p
        # ellipsoid floor (cheap, catches holes in the head mesh)
        q = (p - self.c) / (self.r * 0.93)
        rr = np.linalg.norm(q)
        if rr < 1.0 and p[2] > self.c[2] - self.r[2] * 0.2:
            p = self.c + q / rr * self.r * 0.93
        for (pc, ax, he, depth) in self.pressers:
            L = ax.T @ (p - pc)
            inside = np.all(np.abs(L[[0, 2]]) < he[[0, 2]])
            if inside:
                r2 = (L[0] / he[0]) ** 2 + (L[2] / he[2]) ** 2
                lim = depth * (1 - 0.8 * min(r2, 1))
                if L[1] > lim:
                    fade = min(1.0, (1 - max(abs(L[0]) / he[0], abs(L[2]) / he[2])) / 0.25)
                    L[1] -= (L[1] - lim) * fade
                    p = pc + ax @ L
        return p


# ============================================================================ clump spec
@dataclass
class Clump:
    guide: np.ndarray                 # (n,3) world control points, root first
    width: float = 0.022              # max half-width... full width of the lock (m)
    thick: float = 0.35               # thickness as a fraction of the width
    taper: float = 1.6                # tip taper exponent (higher = stays wide longer)
    shape: str = 'point'              # 'point' | 'blunt'
    root_w: float = 0.7               # width at the root relative to max
    belly: float = 0.12               # extra width mid-length
    ridge: float = 0.6                # 0 = round outer surface, 1 = sharp V ridge
    wrap: float = 0.18                # edges curl toward the head (fraction of width)
    twist: float = 0.0                # total twist along the clump (radians)
    tips: int = 1                     # sub-locks at the end (1..3)
    tip_spread: float = 0.5           # how far sub-locks fan apart at the very tip (fraction of width)
    split: float = 0.6                # where along the clump the sub-locks start to separate
    tip_len: tuple = (1.0, 0.82, 0.7)
    wave: float = 0.0                 # in-plane wave amplitude (m)
    wave_freq: float = 1.5            # waves along the clump
    wave_phase: float = 0.0
    variant: int = 0                  # texture atlas column
    layer: str = 'crown'
    chain: str | None = None          # physics chain group name (None = rigid on the head)
    flat_normal: object = None        # optional preferred 'outward' direction (default radial from the head)
    tip_start: float = 0.45           # 'flame' shape: where the wedge toward the tip begins (fraction of length)
    tip_curve: float = 1.0            # 'flame' shape: 1 = straight wedge sides, <1 = convex (fuller), >1 = concave
    thick_tip: float = 0.35           # thickness at the tip relative to the width profile (thin, sharp tips)
    center: object = None             # optional frame centre for the radial 'outward' (default: the head centre)
    centers: object = None            # optional (n,3) per-guide-point frame centres (helix coils: the axis point)
    rings: object = None              # optional explicit ring count (long helices need more than the 40 cap)
    width_mul: object = None          # optional width multiplier curve along the clump (root -> tip samples)
    keep_normals: bool = False        # style='drawn': keep this clump's own smooth normals (twisted tubes)
    round_back: bool = False          # a closed ROUND (elliptic) section instead of the lock's flat underside (tubes)
    ring_z: object = None             # optional world height (z) of the angel ring: the lock's texture v is remapped
    ring_v: float = 0.23              # so the palette ring (at v = ring_v) lands where the lock crosses ring_z -- ONE
                                      # coherent ring round the head instead of a band at the same fraction of every lock


def _ring_vmap(c, G, t):
    """texture v along a lock: t itself, or (Clump.ring_z set) piecewise-linear so the palette's angel ring (v =
    ring_v) sits where the lock first crosses the world height ring_z (hanging locks); a lock rooted below that height,
    a rising lock (tied flow locks) or one entirely above it keeps t"""
    t = np.asarray(t, float)
    if c.ring_z is None or len(G) < 3:
        return t
    z = np.asarray(G, float)[:, 2]
    rv = float(c.ring_v)
    if z[0] < c.ring_z or z[-1] >= z[0] or z.min() >= c.ring_z:
        # never crosses the ring height (rooted below it, rising flow locks, short crown locks entirely above): no
        # ring on it at all -- a band at an arbitrary height on these read as grey blotches
        return np.interp(t, [0.0, 0.55, 1.0], [rv + 0.07, 0.55, 1.0])
    below = np.nonzero(z < c.ring_z)[0]
    if not len(below):
        return t
    i = int(below[0])
    f = (z[i - 1] - c.ring_z) / max(z[i - 1] - z[i], 1e-9)
    tr = float(np.clip(t[i - 1] + f * (t[i] - t[i - 1]), 0.03, 0.97))
    # the ring moves; the tip colour range (v >= 0.55) stays where it was along the lock whenever it can
    if tr < 0.5:
        return np.interp(t, [0.0, tr, 0.55, 1.0], [0.0, rv, 0.55, 1.0])
    return np.interp(t, [0.0, tr, 1.0], [0.0, rv, 1.0])


def catmull(pts, n):
    """Arc-length-uniform Catmull-Rom resample of control points to n points."""
    P = np.asarray(pts, float)
    if len(P) == 2:
        t = np.linspace(0, 1, n)[:, None]
        return P[0] * (1 - t) + P[1] * t
    ext = np.vstack([2 * P[0] - P[1], P, 2 * P[-1] - P[-2]])
    dense = []
    for i in range(1, len(ext) - 2):
        p0, p1, p2, p3 = ext[i - 1], ext[i], ext[i + 1], ext[i + 2]
        for t in np.linspace(0, 1, 16, endpoint=False):
            t2, t3 = t * t, t * t * t
            dense.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    dense.append(P[-1])
    D = np.array(dense)
    seg = np.linalg.norm(np.diff(D, axis=0), axis=1)
    cum = np.r_[0, np.cumsum(seg)]
    s = np.linspace(0, cum[-1], n)
    return np.stack([np.interp(s, cum, D[:, k]) for k in range(3)], 1)


def grow(frame: HeadFrame, root, d0, length, n=18, gravity=0.0, target=None, pull=0.0, curl=0.0, curl_axis=None,
         margin=0.003, lift_dir=None):
    """Integrate a guide from `root` along `d0`: gravity (per unit length), pull toward `target` direction, curl
    (total rotation, radians, about curl_axis or the local lateral axis), head collision each step."""
    p = np.asarray(root, float).copy()
    d = unit(d0)
    pts = [p.copy()]
    ds = length / n
    for i in range(n):
        acc = np.zeros(3)
        if gravity:
            acc += gravity * np.array([0, 0, -1.0])
        if target is not None and pull:
            tg = unit(target)
            acc += pull * (tg - d * np.dot(d, tg))
        d = unit(d + acc / n * 1.0)
        if curl:
            ax = curl_axis if curl_axis is not None else np.cross(d, frame.normal_at(p))
            if np.linalg.norm(ax) > 1e-6:
                d = rot(ax, curl / n) @ d
        q = p + d * ds
        # the stand-off ramps in over the first quarter: roots hug the scalp, no risers / arches at the root
        q2 = frame.push_out(q, max(0.003, margin * float(smoothstep(0.0, 0.3, (i + 1) / n))))
        if np.linalg.norm(q2 - q) > 1e-7:
            d = unit(q2 - p) if np.linalg.norm(q2 - p) > 1e-7 else d
        p = q2
        pts.append(p.copy())
    return np.array(pts)


# ============================================================================ mesh building
# cross-section (a curved SHELL, not a pipe): outer x = +1 .. -1 (9 pts, cosine spaced so the silhouette edge is
# round), inner x = -1 .. +1 back (7 pts); u across the lock
_o = np.cos(np.linspace(0, np.pi, 9))
_i = -np.cos(np.linspace(0, np.pi, 9))[1:-1]
PROF_X = np.r_[_o, _i]
PROF_OUT = np.r_[np.ones(9, bool), np.zeros(7, bool)]


def _profile(ridge, thick_abs, wrap_abs):
    x = PROF_X
    round_ = np.sqrt(np.clip(1 - x ** 2, 0, 1))
    vee = 1 - np.abs(x)
    y_out = thick_abs * (0.22 + 0.78 * ((1 - ridge) * round_ + ridge * vee))
    y_in = -thick_abs * 0.28 * (1 - x ** 2)
    y = np.where(PROF_OUT, y_out, y_in)
    y = y - wrap_abs * x ** 2
    return x, y


def _frames(G, frame: HeadFrame, twist, pref=None, center=None):
    n = len(G)
    T = np.gradient(G, axis=0)
    T /= np.linalg.norm(T, axis=1, keepdims=True) + 1e-12
    L = np.zeros_like(G); N = np.zeros_like(G)
    prevL = None
    cc = frame.c if center is None else np.asarray(center, float)
    for i in range(n):
        R = unit(pref) if pref is not None else unit(G[i] - (cc[i] if cc.ndim == 2 else cc))
        l = np.cross(R, T[i])
        ln = np.linalg.norm(l)
        if prevL is not None:
            tr = prevL - T[i] * np.dot(prevL, T[i])
            tr = unit(tr)
            w = np.clip((ln - 0.15) / 0.35, 0, 1)          # radial frame when well defined, else transport
            l = unit(w * (l / (ln + 1e-12)) + (1 - w) * tr) if ln > 1e-6 else tr
            if np.dot(l, prevL) < 0 and w < 0.5:
                l = -l
        else:
            if ln < 1e-6:
                l = np.cross([0, 0, 1.0], T[i])
            l = unit(l)
        prevL = l
        L[i] = l
        N[i] = unit(np.cross(T[i], l))
    # twist
    if twist:
        for i in range(n):
            a = twist * i / max(n - 1, 1)
            Rm = rot(T[i], a)
            L[i] = Rm @ L[i]; N[i] = Rm @ N[i]
    return T, L, N


def _width_profile(t, c: Clump):
    if c.shape == 'blunt':
        s = 1 - smoothstep(0.86, 1.0, t) ** 1.2 * 0.92
    elif c.shape == 'flame':
        # anime lock: stays broad, then a long straight-sided wedge into a needle tip (no rounded 'noodle' end)
        k = c.tip_start
        s = np.where(t < k, 1.0, np.clip(1 - (t - k) / (1 - k), 0, 1) ** c.tip_curve)
    else:
        s = np.clip(1 - t ** c.taper, 0, 1) ** 0.9
    s = s * (c.root_w + (1 - c.root_w) * smoothstep(0.0, 0.18, t))
    s = s * (1 + c.belly * np.sin(np.pi * np.clip(t, 0, 1)))
    return s


class HairBuilder:
    """Accumulates clumps into one bmesh (UV layer 'UVMap', float attributes hair_t / clump)."""

    def __init__(self, frame: HeadFrame, variants=4):
        self.frame = frame
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new('UVMap')
        self.col = self.bm.loops.layers.float_color.new('HairTone')
        self.variants = variants
        self.records = []      # per clump: dict(verts=[bmverts], t=[...], guide=G, chain=..)
        self.nclump = 0
        # face winding: 'recalc' (default, bmesh recalc over the whole mesh) | 'volume' (style='drawn': each clump's
        # closed shell oriented by its own signed volume, so overlapping / twisted clumps never come out inside-out)
        self.orient = 'recalc'

    def add(self, c: Clump, rings=None, rng=None):
        rng = rng or np.random.default_rng(self.nclump + 1)
        G0 = np.asarray(c.guide, float)
        seg = np.linalg.norm(np.diff(G0, axis=0), axis=1).sum()
        n = rings or c.rings or int(np.clip(seg / 0.0055, 10, 40))
        G = catmull(G0, n)
        t = np.linspace(0, 1, n)
        cen = c.center if c.centers is None else catmull(np.asarray(c.centers, float), n)
        T, L, N = _frames(G, self.frame, c.twist, c.flat_normal, cen)
        if c.wave:
            G = G + (c.wave * np.sin(2 * np.pi * c.wave_freq * t + c.wave_phase) * smoothstep(0.0, 0.35, t))[:, None] * L
            T, L, N = _frames(G, self.frame, c.twist, c.flat_normal, cen)
        tips = max(1, int(c.tips))
        recs = []
        wk = c.width * (min(1.0, 1.15 / tips + 0.1) if tips > 1 else 1.0)
        for k in range(tips):
            ln = c.tip_len[k % len(c.tip_len)] if tips > 1 else 1.0
            # sub-lock: together they span the clump's width; they separate only after `split`
            off = (k - (tips - 1) / 2)
            m = max(6, int(n * ln))
            tt = t[:m] / t[m - 1]
            idx = np.arange(m)
            base = off * (c.width - wk) / max(tips - 1, 1)
            lat = base + off * c.tip_spread * c.width * smoothstep(c.split, 1.0, t[:m]) ** 1.5
            up = (0.15 if abs(off) < 0.6 and tips > 1 else 0.0) * c.width * c.thick
            Gk = G[idx] + lat[:, None] * L[idx] + up * N[idx]
            recs.append(self._tube(c, Gk, T[idx], L[idx], N[idx], tt, wk, (k / tips, (k + 1) / tips)))
        self.records.append({'clump': c, 'guide': G, 'parts': recs})
        self.nclump += 1

    def _tube(self, c: Clump, G, T, L, N, t, width, urange=(0.0, 1.0)):
        bm = self.bm
        w_s = _width_profile(t, c)
        if c.width_mul is not None:
            wm = np.asarray(c.width_mul, float)
            w_s = w_s * np.interp(t, np.linspace(0, 1, len(wm)), wm)
        rows = []
        vt = []
        nprof = len(PROF_X)
        for i in range(len(G)):
            if i == len(G) - 1 and c.shape != 'blunt':
                v = bm.verts.new(G[i])
                rows.append([v]); vt.append(1.0)
                continue
            half = width * 0.5 * w_s[i]
            x, y = _profile(c.ridge, width * c.thick * w_s[i] * 0.5 * (1 - (1 - c.thick_tip) * t[i]), c.wrap * half)
            if c.round_back:
                y = np.where(PROF_OUT, 1.0, -1.0) * np.sqrt(np.clip(1 - x ** 2, 0, 1)) *                     (width * c.thick * w_s[i] * 0.5 * (1 - (1 - c.thick_tip) * t[i]))
            ring = []
            for j in range(nprof):
                ring.append(bm.verts.new(G[i] + L[i] * (x[j] * half) + N[i] * y[j]))
            rows.append(ring); vt.append(t[i])
        # root cap
        root_c = bm.verts.new(G[0] - T[0] * width * 0.1)
        faces = []
        u_of = urange[0] + (urange[1] - urange[0]) * (PROF_X + 1) / 2
        var = c.variant % self.variants
        nv = self.variants

        tv = _ring_vmap(c, G, t)

        def uvv(j, i):
            return ((var + 0.03 + 0.94 * u_of[j]) / nv, 1 - tv[i])
        for i in range(len(rows) - 1):
            a, b = rows[i], rows[i + 1]
            for j in range(nprof):
                j2 = (j + 1) % nprof
                if len(b) == 1:
                    f = bm.faces.new((a[j], a[j2], b[0]))
                    cor = [(j, i), (j2, i), (None, i + 1)]
                else:
                    f = bm.faces.new((a[j], a[j2], b[j2], b[j]))
                    cor = [(j, i), (j2, i), (j2, i + 1), (j, i + 1)]
                for lp, (jj, ii) in zip(f.loops, cor):
                    if jj is None:
                        lp[self.uv].uv = ((var + 0.5) / nv, 1 - tv[ii])
                    else:
                        u_, v_ = uvv(jj, ii)
                        # seam: the last segment (j=7 -> 0) wraps u back to the x=+1 edge
                        lp[self.uv].uv = (u_, v_)
                    lp[self.col] = (t[ii], c.variant / 8.0, 0.0, 1.0)
                faces.append(f)
        # blunt end: cap the last ring
        if len(rows[-1]) > 1:
            cen = bm.verts.new(np.mean([np.array(v.co) for v in rows[-1]], 0))
            for j in range(nprof):
                f = bm.faces.new((rows[-1][j], rows[-1][(j + 1) % nprof], cen))
                for lp in f.loops:
                    lp[self.uv].uv = ((var + 0.5) / nv, 1 - tv[-1]); lp[self.col] = (1.0, c.variant / 8.0, 0, 1)
                faces.append(f)
        for j in range(nprof):
            f = bm.faces.new((rows[0][(j + 1) % nprof], rows[0][j], root_c))
            for lp in f.loops:
                lp[self.uv].uv = ((var + 0.5) / nv, 1.0); lp[self.col] = (0.0, c.variant / 8.0, 0, 1)
            faces.append(f)
        verts = [v for r in rows for v in r] + [root_c]
        ts = [vt[i] for i, r in enumerate(rows) for _ in r] + [0.0]
        # per vertex: the guide point of its ring + the lock's outward frame normal (used by drawn_normals)
        cs = [G[i] for i, r in enumerate(rows) for _ in r] + [G[0]]
        ns = [N[i] for i, r in enumerate(rows) for _ in r] + [N[0]]
        return {'verts': verts, 't': ts, 'c': cs, 'n': ns, 'faces': faces}

    def _orient_by_volume(self):
        """style='drawn': flip every clump part whose closed shell has negative signed volume"""
        flip = []
        for rec in self.records:
            for p in rec['parts']:
                vol = 0.0
                for f in p.get('faces', []):
                    vs = [np.array(v.co) for v in f.verts]
                    for k in range(1, len(vs) - 1):
                        vol += float(np.dot(vs[0], np.cross(vs[k], vs[k + 1])))
                if vol < 0:
                    flip += p.get('faces', [])
        if flip:
            bmesh.ops.reverse_faces(self.bm, faces=flip)
        return len(flip)

    def to_object(self, name, collection=None):
        bm = self.bm
        if self.orient == 'volume':
            self._orient_by_volume()
        else:
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        # index verts for later weight painting
        bm.verts.index_update()
        for rec in self.records:
            for p in rec['parts']:
                p['idx'] = [v.index for v in p['verts']]
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        o = bpy.data.objects.new(name, me)
        (collection or bpy.context.scene.collection).objects.link(o)
        for p in me.polygons:
            p.use_smooth = True
        return o


# ============================================================================ scalp shell
def make_scalp(frame: HeadFrame, name='HairScalp', offset=0.0035, hairline=None, segs=(40, 24), collection=None):
    """Hidden inner mass: a sphere cap shrink-wrapped onto the head (+offset), cut at the hairline.
    hairline: dict(front=, side=, back=) elevation (deg) of the hairline at the front / sides / back."""
    hl = {'front': 32.0, 'side': 5.0, 'back': -38.0}
    hl.update(hairline or {})
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs[0], v_segments=segs[1], radius=1.0)
    kill = []
    for v in bm.verts:
        d = unit(np.array(v.co))
        th = math.degrees(math.atan2(d[0], d[1]))
        ph = math.degrees(math.asin(np.clip(d[2], -1, 1)))
        a = abs(th)
        if a < 90:
            lim = hl['front'] + (hl['side'] - hl['front']) * (a / 90) ** 1.5
        else:
            lim = hl['side'] + (hl['back'] - hl['side']) * ((a - 90) / 90) ** 0.8
        if ph < lim:
            kill.append(v)
            continue
        far = frame.c + d * frame.r * 2.2
        hit = frame.bvh.ray_cast(Vector(far), Vector(-d)) if frame.bvh else (None,)
        if hit[0] is not None:
            p = np.array(hit[0]); n = np.array(hit[1])
            if np.dot(n, d) < 0:
                n = -n
            v.co = Vector(p + n * offset)
        else:
            v.co = Vector(frame.c + d * frame.r * 1.02)
    bmesh.ops.delete(bm, geom=kill, context='VERTS')
    bmesh.ops.smooth_vert(bm, verts=bm.verts[:], factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    uv = bm.loops.layers.uv.new('UVMap')
    col = bm.loops.layers.float_color.new('HairTone')
    for f in bm.faces:
        for lp in f.loops:
            lp[uv].uv = (0.5 / 4, 0.55)
            lp[col] = (0.0, 0.0, 0.0, 1.0)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me)
    (collection or bpy.context.scene.collection).objects.link(o)
    for p in me.polygons:
        p.use_smooth = True
    return o


# ============================================================================ clean toon normals
def _apply_all(o):
    with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o], selected_editable_objects=[o]):
        for md in list(o.modifiers):
            bpy.ops.object.modifier_apply(modifier=md.name)


def smooth_proxy(src, inflate=0.009, voxel=0.009, smooth_iter=30, smooth_factor=0.9, name='HairProxy'):
    """Inflated, voxel-remeshed, heavily smoothed hull of the hair mass (the normal source)."""
    me = src.data.copy()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    o.matrix_world = src.matrix_world.copy()
    bm = bmesh.new(); bm.from_mesh(me)
    bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * inflate
    bm.to_mesh(me); bm.free()
    r = o.modifiers.new('R', 'REMESH'); r.mode = 'VOXEL'; r.voxel_size = voxel; r.adaptivity = 0.0
    s = o.modifiers.new('S', 'SMOOTH'); s.factor = smooth_factor; s.iterations = smooth_iter
    _apply_all(o)
    for p in o.data.polygons:
        p.use_smooth = True
    return o


def transfer_normals(dst, proxy, mix=1.0, mapping='POLYINTERP_NEAREST'):
    """Data Transfer custom normals proxy -> dst (applied)."""
    for p in dst.data.polygons:
        p.use_smooth = True
    md = dst.modifiers.new('HairNormals', 'DATA_TRANSFER')
    md.object = proxy
    md.use_loop_data = True
    md.data_types_loops = {'CUSTOM_NORMAL'}
    md.loop_mapping = mapping
    md.mix_mode = 'REPLACE'
    md.mix_factor = mix
    _apply_all(dst)


def _proxy_sampler(proxy, reach=0.08):
    """smooth proxy normal seen from inside the mass: cast from q along d to the proxy's outer surface (barycentric
    vertex normals of the hit triangle; nearest surface if the ray misses)"""
    pm = proxy.data
    pm.calc_loop_triangles()
    PV = np.zeros(len(pm.vertices) * 3); pm.vertices.foreach_get('co', PV); PV = PV.reshape(-1, 3)
    Mw = np.array(proxy.matrix_world)
    PV = PV @ Mw[:3, :3].T + Mw[:3, 3]
    VN = np.zeros(len(pm.vertices) * 3); pm.vertices.foreach_get('normal', VN); VN = VN.reshape(-1, 3)
    TRI = np.array([lt.vertices[:] for lt in pm.loop_triangles], int)
    bvh = BVHTree.FromPolygons([Vector(v) for v in PV], TRI.tolist())

    def smooth_n(q, d):
        hit = bvh.ray_cast(Vector(q), Vector(d), reach)
        if hit[0] is None:
            loc, nrm, fi, _ = bvh.find_nearest(Vector(q))
            if loc is None:
                return None
        else:
            loc, nrm, fi, _ = hit
        a, b, c = PV[TRI[fi]]
        p = np.array(loc)
        v0, v1, v2 = b - a, c - a, p - a
        d00, d01, d11 = v0 @ v0, v0 @ v1, v1 @ v1
        d20, d21 = v2 @ v0, v2 @ v1
        den = d00 * d11 - d01 * d01
        if abs(den) < 1e-18:
            n = np.array(nrm)
        else:
            w1 = (d11 * d20 - d01 * d21) / den; w2 = (d00 * d21 - d01 * d20) / den
            n = (1 - w1 - w2) * VN[TRI[fi][0]] + w1 * VN[TRI[fi][1]] + w2 * VN[TRI[fi][2]]
        if np.dot(n, d) < 0:
            n = -n
        return n / (np.linalg.norm(n) + 1e-12)
    return smooth_n


def drawn_normals(hair, builder, proxy, frame_mix=0.12, reach=0.08):
    """style='drawn' shading normals (additive; the default path keeps clean_normals' Data-Transfer): EVERY vertex of
    a lock ring -- outer face, sides, underside, tip -- gets the smooth proxy normal found by casting from the ring's
    guide point along the lock's outward frame normal to the proxy's outer surface (vertex normals of the proxy
    triangle, barycentric). A lock's whole cross-section shades as one flat cel tone that follows the smooth mass, so
    undersides / side walls of hanging locks never turn dark (the nearest-surface transfer picks the far side of a
    thin lock's proxy tube there: fragmented cel shading, dark 'back' sides)."""
    smooth_n = _proxy_sampler(proxy, reach)
    me = hair.data
    nv = len(me.vertices)
    VNh = np.zeros(nv * 3); me.vertices.foreach_get('normal', VNh); VNh = VNh.reshape(-1, 3)
    out = VNh.copy()
    cache = {}
    for rec in builder.records:
        if getattr(rec['clump'], 'keep_normals', False):
            continue
        for p in rec['parts']:
            for vi, cpt, npt in zip(p.get('idx', []), p.get('c', []), p.get('n', [])):
                key = (round(float(cpt[0]), 5), round(float(cpt[1]), 5), round(float(cpt[2]), 5))
                n = cache.get(key)
                if n is None:
                    n = smooth_n(np.asarray(cpt, float), unit(np.asarray(npt, float)))
                    n = unit(npt) if n is None else unit((1 - frame_mix) * n + frame_mix * unit(npt))
                    cache[key] = n
                out[vi] = n
    for p in me.polygons:
        p.use_smooth = True
    me.normals_split_custom_set_from_vertices(out.tolist())
    return len(cache)


def shell_normals(obj, proxy, reach=0.08):
    """style='drawn' for a smooth under-shell (the scalp / dome): each vertex casts along its own geometric normal to
    the proxy's OUTER surface (the nearest-surface transfer hands the innermost shell the proxy's inner, head-facing
    side: dark seams wherever it shows between locks)"""
    smooth_n = _proxy_sampler(proxy, reach)
    me = obj.data
    Mw = np.array(obj.matrix_world)
    VN = np.zeros(len(me.vertices) * 3); me.vertices.foreach_get('normal', VN); VN = VN.reshape(-1, 3)
    P = np.zeros(len(me.vertices) * 3); me.vertices.foreach_get('co', P); P = P.reshape(-1, 3) @ Mw[:3, :3].T + Mw[:3, 3]
    out = []
    for p, n0 in zip(P, VN):
        n = smooth_n(p, unit(n0))
        out.append(unit(n0) if n is None else n)
    for p in me.polygons:
        p.use_smooth = True
    me.normals_split_custom_set_from_vertices([list(map(float, n)) for n in out])
    return len(out)


def clean_normals(hair_objs, keep_proxy=False, **kw):
    """Build one proxy over all given hair objects (clumps + scalp) and transfer its normals onto each."""
    tmp = []
    for o in hair_objs:
        c = o.copy(); c.data = o.data.copy(); bpy.context.scene.collection.objects.link(c); tmp.append(c)
    with bpy.context.temp_override(active_object=tmp[0], selected_editable_objects=tmp, selected_objects=tmp):
        bpy.ops.object.join()
    joined = tmp[0]
    proxy = smooth_proxy(joined, **kw)
    bpy.data.objects.remove(joined, do_unlink=True)
    for o in hair_objs:
        transfer_normals(o, proxy)
    if not keep_proxy:
        bpy.data.objects.remove(proxy, do_unlink=True)
        return None
    proxy.hide_render = True
    return proxy


# ============================================================================ texture
@dataclass
class Palette:
    root: tuple = (0.80, 0.78, 0.92)
    mid: tuple = (0.97, 0.96, 1.0)
    tip: tuple = (0.80, 0.78, 0.98)
    shade: tuple = (0.55, 0.52, 0.90)       # painted shadow strokes
    ink: tuple = (0.22, 0.18, 0.50)         # clump edge lines
    shine: tuple = (1.0, 1.0, 1.0)
    shade_mul: tuple = (0.72, 0.70, 0.95)   # toon shade colour multiply (MToon _ShadeColor)
    ink_w: float = 0.05                     # edge line width (fraction of the clump width)
    strokes: int = 4
    stroke_alpha: float = 0.75
    tip_range: tuple = (0.6, 1.0)
    root_range: tuple = (0.0, 0.3)
    shine_amt: float = 0.0
    hairline: bool = True                   # thin ink strand line inside each clump
    edge_band: float = 0.2                  # cel shadow band along the clump edges (fraction of the width)
    band_alpha: float = 0.8
    root_occ: float = 0.5                   # darkening right at the root (under the layer above)
    style: str = 'painted'                  # 'painted' (strokes) | 'clean' (cel: flat colour, one form band, ink)
    ring: float = 0.0                       # angel-ring highlight strength ('clean')
    ring_t: tuple = (0.2, 0.3)              # where along the lock the ring sits (t range)
    ring_color: tuple = (1.0, 1.0, 1.0)
    inner_lines: int = 1                    # 'clean': interior ink lines per lock (hatching along the flow)
    line_w: float = 0.022                   # 'clean': max width of an interior line (fraction of the lock width)


def hair_texture_clean(pal: Palette, path=None, size=1024, variants=4, seed=3):
    """Cel-style hair atlas: flat light colour with a soft root->tip gradient, ONE crisp form-shadow band along one
    edge (the painted 'core shadow' of anime locks, tapering toward the tip), crisp ink lines along both edges that
    thin toward the tip, 0..2 bold interior ink lines (strand separation, as in line art), and a zig-zag angel-ring
    band. Big light / shadow shapes come from the toon ramp + proxy normals; the texture only adds the drawn lines."""
    rng = np.random.default_rng(seed)
    H = W = size
    y, x = np.mgrid[0:H, 0:W]
    t = 1 - (y + 0.5) / H
    uu = (x + 0.5) / W * variants
    var = np.floor(uu).astype(int)
    u = (uu - var - 0.03) / 0.94
    C = lambda c: np.array(c, float)[None, None, :]
    px = variants / W
    a = smoothstep(pal.root_range[0], pal.root_range[1], t)[..., None]
    b = smoothstep(pal.tip_range[0], pal.tip_range[1], t)[..., None]
    col = C(pal.root) * (1 - a) + C(pal.mid) * a
    col = col * (1 - b) + C(pal.tip) * b
    aa = lambda d, w: 1 - smoothstep(w - px * 0.8, w + px * 0.8, d)      # anti-aliased 'inside' test
    # angel ring: a zig-zag band across the lock (brighter than the base, fades at the lock edges)
    if pal.ring:
        zz = 0.018 * np.abs(((u * 7.0) % 2.0) - 1.0)
        r0, r1 = pal.ring_t
        ring = aa(np.abs(t - (r0 + r1) / 2 - zz), (r1 - r0) / 2) * smoothstep(0.08, 0.2, u) * smoothstep(0.08, 0.2, 1 - u)
        col = col * (1 - ring[..., None] * pal.ring) + C(pal.ring_color) * ring[..., None] * pal.ring
    # form band: along the u=0 edge (per-variant width), crisp, tapering to the tip
    for vi in range(variants):
        m = var == vi
        bw = pal.edge_band * rng.uniform(0.8, 1.25) * (1 - 0.55 * t)
        band = aa(u, bw) * smoothstep(0.03, 0.12, t) * m * pal.band_alpha
        col = col * (1 - band[..., None]) + C(pal.shade) * band[..., None]
        # interior ink lines: start a little after the root, tapered at both ends, gently curved
        for k in range(pal.inner_lines if vi % 2 == 0 else max(1, pal.inner_lines - 1)):
            uc = rng.uniform(0.12, 0.88) if pal.inner_lines > 2 else rng.uniform(0.3, 0.72)
            t0, t1 = rng.uniform(0.04, 0.35), rng.uniform(0.55, 0.95)
            tt = np.clip((t - t0) / (t1 - t0), 0, 1)
            wu = pal.line_w * rng.uniform(0.55, 1.0) * np.sin(np.pi * tt) ** 0.5 * ((t > t0) & (t < t1))
            d = np.abs(u - uc - 0.08 * (tt - 0.5) ** 2)
            al = aa(d, wu) * m
            col = col * (1 - al[..., None]) + C(pal.ink) * al[..., None]
    # root occlusion (under the layer above)
    ro = (1 - smoothstep(0.0, 0.06, t)) * pal.root_occ
    col = col * (1 - ro[..., None]) + C(pal.shade) * ro[..., None]
    # ink edges, thinning toward the tip
    e = np.minimum(u, 1 - u)
    iw = pal.ink_w * (0.4 + 0.6 * (1 - t) ** 0.7)
    ink = aa(e, iw) * smoothstep(0.015, 0.06, t)
    col = col * (1 - ink[..., None]) + C(pal.ink) * ink[..., None]
    out = np.concatenate([np.clip(col, 0, 1), np.ones((H, W, 1))], 2).astype(np.float32)
    if path:
        _save_png(out, path)
    return out


def _save_png(arr, path):
    H, W = arr.shape[:2]
    img = bpy.data.images.new('hairtex_tmp', W, H, alpha=True)
    img.pixels.foreach_set(arr.reshape(-1))
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)


def hair_texture(pal: Palette, path=None, size=1024, variants=4, seed=3):
    """Hair atlas (RGBA float, rows bottom-up like Blender pixels). Column k = variant k; u across, v = 1 - t."""
    if pal.style == 'clean':
        return hair_texture_clean(pal, path, size, variants, seed)
    rng = np.random.default_rng(seed)
    H = W = size
    y, x = np.mgrid[0:H, 0:W]
    v = (y + 0.5) / H
    t = 1 - v                                   # root (t=0) at the top of the image
    uu = (x + 0.5) / W * variants
    var = np.floor(uu).astype(int)
    u = (uu - var - 0.03) / 0.94                # 0..1 across the clump (edges 0 / 1)
    C = lambda c: np.array(c, float)[None, None, :]
    root, mid, tip = C(pal.root), C(pal.mid), C(pal.tip)
    a = smoothstep(pal.root_range[0], pal.root_range[1], t)[..., None]
    b = smoothstep(pal.tip_range[0], pal.tip_range[1], t)[..., None]
    col = root * (1 - a) + mid * a
    col = col * (1 - b) + tip * b
    e = np.minimum(u, 1 - u)
    px = variants / W                           # one pixel in u units (per variant)
    shade = C(pal.shade)
    # cel shadow bands along both clump edges (wider on one side: painted form light), tapering to the tip
    bl = pal.edge_band * (1 - 0.45 * t)
    br = pal.edge_band * 0.5 * (1 - 0.45 * t)
    band = np.maximum(1 - smoothstep(bl, bl + px * 2.5, u), 1 - smoothstep(br, br + px * 2.5, 1 - u))
    band = band * smoothstep(0.0, 0.08, t) * pal.band_alpha
    col = col * (1 - band[..., None]) + shade * band[..., None]
    # root occlusion (under the layer above)
    ro = (1 - smoothstep(0.02, 0.07, t)) * pal.root_occ
    col = col * (1 - ro[..., None]) + (shade * 0.85) * ro[..., None]
    # painted shadow strokes along the clump (tapered at both ends)
    for vi in range(variants):
        m = var == vi
        for s in range(pal.strokes):
            uc = rng.uniform(0.25, 0.75)
            t0 = rng.uniform(0.0, 0.3); t1 = rng.uniform(0.55, 0.95)
            wmax = rng.uniform(0.02, 0.045)
            tt = np.clip((t - t0) / (t1 - t0), 0, 1)
            wu = wmax * np.sin(np.pi * tt) ** 0.7 * ((t > t0) & (t < t1))
            bend = 0.04 * np.sin(tt * 3.0 + s)
            d = np.abs(u - uc - bend)
            al = (1 - smoothstep(wu * 0.6, wu + px * 1.5, d)) * m * pal.stroke_alpha
            col = col * (1 - al[..., None]) + shade * al[..., None]
        # a thin ink strand line inside the clump (short)
        if not pal.hairline:
            continue
        uc = rng.uniform(0.3, 0.7)
        t0 = rng.uniform(0.05, 0.3); t1 = rng.uniform(0.6, 0.9)
        tt = np.clip((t - t0) / (t1 - t0), 0, 1)
        wu = 0.012 * np.sin(np.pi * tt) ** 0.5 * ((t > t0) & (t < t1))
        d = np.abs(u - uc - 0.04 * np.sin(tt * 2.5))
        al = (1 - smoothstep(wu * 0.5, wu + px, d)) * m * 0.85
        col = col * (1 - al[..., None]) + C(pal.ink) * al[..., None]
    if pal.shine_amt:
        sh = (1 - smoothstep(0.0, 0.05, np.abs(u - 0.38))) * smoothstep(0.12, 0.2, t) * (1 - smoothstep(0.35, 0.45, t))
        col = col * (1 - sh[..., None] * pal.shine_amt) + C(pal.shine) * sh[..., None] * pal.shine_amt
    # ink edges (thin toward the tip, fade in after the root)
    iw = pal.ink_w * (0.45 + 0.55 * (1 - t) ** 0.6)
    ink = (1 - smoothstep(iw, iw + px * 1.5, e)) * smoothstep(0.02, 0.1, t)
    col = col * (1 - ink[..., None]) + C(pal.ink) * ink[..., None]
    out = np.concatenate([np.clip(col, 0, 1), np.ones((H, W, 1))], 2).astype(np.float32)
    if path:
        img = bpy.data.images.new('hairtex_tmp', W, H, alpha=True)
        img.pixels.foreach_set(out.reshape(-1))
        img.filepath_raw = path
        img.file_format = 'PNG'
        img.save()
        bpy.data.images.remove(img)
    return out


def hair_material(name, tex_path, pal: Palette):
    """Principled material with the atlas (glTF-exportable); '_ShadeColor' stored as a custom prop."""
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Roughness'].default_value = 0.8
    im = bpy.data.images.load(tex_path, check_existing=True)
    tx = nt.nodes.new('ShaderNodeTexImage'); tx.image = im
    nt.links.new(tx.outputs['Color'], b.inputs['Base Color'])
    m['shade'] = list(pal.shade_mul)
    return m


# ============================================================================ physics chains
def chain_weights(builder: HairBuilder, obj, head_bone, groups: dict, joints=3, rigid_until=0.3, prefix='HairJoint'):
    """groups: chain name -> list of clump indices. Adds bones (returned as specs) + vertex groups on obj.
    Every vertex of a chained clump: weight head (1 - smoothstep(0, rigid_until, t)) and the rest split between the
    two chain joints around t. Unchained clumps + everything else -> head."""
    specs = []
    vg_head = obj.vertex_groups.get(head_bone) or obj.vertex_groups.new(name=head_bone)
    nverts = len(obj.data.vertices)
    Wh = np.ones(nverts)
    per_joint = {}
    for gname, ids in groups.items():
        guides = [builder.records[i]['guide'] for i in ids]
        m = max(len(g) for g in guides)
        avg = np.mean([catmull(g, m) for g in guides], 0)
        pts = catmull(avg, joints + 1)
        names = [f'{prefix}_{gname}_{j}' for j in range(joints + 1)]
        for j in range(joints + 1):
            specs.append({'name': names[j], 'parent': names[j - 1] if j else head_bone, 'head': pts[j].tolist(),
                          'end': j == joints})
        for i in ids:
            for part in builder.records[i]['parts']:
                idx = np.array(part['idx']); t = np.array(part['t'])
                wh = 1 - smoothstep(0.0, rigid_until, t)
                s = t * (joints - 1e-6)
                j0 = np.floor(s).astype(int); f = s - j0
                for vi, tj, jj, ff, whh in zip(idx, t, j0, f, wh):
                    rest = 1 - whh
                    Wh[vi] = whh
                    if jj + 1 < joints:
                        per_joint.setdefault(names[jj], []).append((vi, rest * (1 - ff)))
                        per_joint.setdefault(names[jj + 1], []).append((vi, rest * ff))
                    else:                   # last segment (tips): all on the last weighted joint, never zero weight
                        per_joint.setdefault(names[jj], []).append((vi, rest))
    for i in range(nverts):
        if Wh[i] > 1e-4:
            vg_head.add([i], float(Wh[i]), 'REPLACE')
    for nm, lst in per_joint.items():
        g = obj.vertex_groups.get(nm) or obj.vertex_groups.new(name=nm)
        for vi, w in lst:
            if w > 1e-4:
                g.add([int(vi)], float(w), 'ADD')
    return specs


# ============================================================================ preview (toon) rendering helpers
def toon_material(name, tex_path=None, color=(1, 1, 1), shade=(0.72, 0.7, 0.95), threshold=0.5, emission=None):
    """Preview cel material (approximates MToon): base x (lit ? 1 : shade)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    diff = nt.nodes.new('ShaderNodeBsdfDiffuse')
    s2r = nt.nodes.new('ShaderNodeShaderToRGB'); nt.links.new(diff.outputs[0], s2r.inputs[0])
    bw = nt.nodes.new('ShaderNodeRGBToBW'); nt.links.new(s2r.outputs[0], bw.inputs[0])
    ramp = nt.nodes.new('ShaderNodeValToRGB'); ramp.color_ramp.interpolation = 'CONSTANT'
    ramp.color_ramp.elements[0].color = (*shade, 1)
    ramp.color_ramp.elements[1].position = threshold * 0.3
    ramp.color_ramp.elements[1].color = (1, 1, 1, 1)
    nt.links.new(bw.outputs[0], ramp.inputs[0])
    mul = nt.nodes.new('ShaderNodeMix'); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'; mul.inputs[0].default_value = 1
    if tex_path:
        tx = nt.nodes.new('ShaderNodeTexImage'); tx.image = bpy.data.images.load(tex_path, check_existing=True)
        nt.links.new(tx.outputs['Color'], mul.inputs[6])
    else:
        mul.inputs[6].default_value = (*color, 1)
    nt.links.new(ramp.outputs[0], mul.inputs[7])
    em = nt.nodes.new('ShaderNodeEmission'); nt.links.new(mul.outputs[2], em.inputs[0])
    nt.links.new(em.outputs[0], out.inputs[0])
    return m


def add_outline(o, width=0.0012, color=(0.12, 0.1, 0.25)):
    """Inverted-hull outline like MToon's: a copy of the mesh pushed out along its SHADING normals (custom normals
    when present), faces flipped, front faces culled."""
    ol = bpy.data.materials.get('HK_Outline')
    if ol is None:
        ol = bpy.data.materials.new('HK_Outline'); ol.use_nodes = True; ol.use_backface_culling = True
        nt = ol.node_tree; nt.nodes.clear()
        e = nt.nodes.new('ShaderNodeEmission'); e.inputs[0].default_value = (*color, 1)
        oo = nt.nodes.new('ShaderNodeOutputMaterial'); nt.links.new(e.outputs[0], oo.inputs[0])
    dg = bpy.context.evaluated_depsgraph_get()
    me = o.evaluated_get(dg).to_mesh().copy()
    cn = np.zeros(len(me.loops) * 3); me.corner_normals.foreach_get('vector', cn) if hasattr(me, 'corner_normals') else None
    cn = cn.reshape(-1, 3)
    vi = np.zeros(len(me.loops), int); me.loops.foreach_get('vertex_index', vi)
    vn = np.zeros((len(me.vertices), 3)); np.add.at(vn, vi, cn)
    vn /= np.linalg.norm(vn, axis=1, keepdims=True) + 1e-12
    P = np.zeros(len(me.vertices) * 3); me.vertices.foreach_get('co', P); P = P.reshape(-1, 3)
    me.vertices.foreach_set('co', (P + vn * width).reshape(-1))
    me.flip_normals()
    me.materials.clear(); me.materials.append(ol)
    for p in me.polygons:
        p.material_index = 0
    oo_ = bpy.data.objects.new(o.name + '_OL', me)
    oo_.matrix_world = o.matrix_world.copy()
    bpy.context.scene.collection.objects.link(oo_)
    oo_['no_outline'] = 1
    return oo_
