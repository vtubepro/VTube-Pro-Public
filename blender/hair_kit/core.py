"""
hair_kit.core — head frame, scalp root sampling, flow-field guide growth with body collision, guide editing
(waves, flicks, clump-to), reference-silhouette fitting and guides grown over sculpted lock shells.

Coordinates: Blender world (+Z up). The character faces -Y (glTF import convention), character LEFT = +X.
Head-spherical coordinates: azimuth `th` in degrees (0 = front, +90 = character's LEFT, 180 = back, -90 = right),
elevation `ph` in degrees (0 = the head centre's horizontal plane, 90 = crown).
"""
from __future__ import annotations

import math

import numpy as np

try:
    import bpy
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
except ImportError:          # numpy-only use (tests)
    bpy = None


def unit(v):
    v = np.asarray(v, float)
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.maximum(n, 1e-12)


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


def resample(P, n):
    """Arc-length uniform resample of a polyline to n points."""
    P = np.asarray(P, float)
    seg = np.linalg.norm(np.diff(P, axis=0), axis=1)
    cum = np.r_[0, np.cumsum(seg)]
    if cum[-1] < 1e-9:
        return np.repeat(P[:1], n, 0)
    s = np.linspace(0, cum[-1], n)
    return np.stack([np.interp(s, cum, P[:, k]) for k in range(3)], 1)


def smooth_poly(P, it=3, keep_root=True):
    P = np.array(P, float)
    for _ in range(it):
        Q = P.copy()
        Q[1:-1] = 0.25 * P[:-2] + 0.5 * P[1:-1] + 0.25 * P[2:]
        if keep_root:
            Q[0] = P[0]
        P = Q
    return P


# =============================================================================================== head
class Head:
    """Cranium ellipsoid + BVH of the head (rooting) and of the whole body (collision: neck, shoulders, back)."""

    def __init__(self, center, radii, head_bvh, body_bvh, neck_z, chin_z, eye_z):
        self.c = np.asarray(center, float)
        self.r = np.asarray(radii, float)          # (x = side, y = front/back, z = up)
        self.head_bvh = head_bvh
        self.body_bvh = body_bvh
        self.neck_z, self.chin_z, self.eye_z = neck_z, chin_z, eye_z

    @classmethod
    def from_objects(cls, objs, head_top=None, eye_z=None, chin_z=None, exclude=r'eye|lash|brow|teeth|mouth|cavity|tongue|line'):
        """Fit the cranium from mesh objects (world space). eye_z / chin_z default from proportions."""
        import re
        rx = re.compile(exclude, re.I)
        dg = bpy.context.evaluated_depsgraph_get()
        V_all, F_all = [], []
        for o in objs:
            ev = o.evaluated_get(dg)
            me = ev.to_mesh()
            M = np.array(o.matrix_world)
            P = np.zeros(len(me.vertices) * 3); me.vertices.foreach_get('co', P)
            P = P.reshape(-1, 3) @ M[:3, :3].T + M[:3, 3]
            skip = {i for i, m in enumerate(me.materials) if m and rx.search(m.name)}
            base = len(V_all)
            V_all += P.tolist()
            for p in me.polygons:
                if p.material_index not in skip:
                    F_all.append([base + i for i in p.vertices])
            ev.to_mesh_clear()
        V = np.array(V_all)
        top = head_top if head_top is not None else V[np.abs(V[:, 0]) < 0.05, 2].max()
        # head band: 4-9 cm below the top
        band = V[(V[:, 2] < top - 0.04) & (V[:, 2] > top - 0.09) & (np.abs(V[:, 0]) < 0.14)]
        ys, yb = band[:, 1].min(), band[:, 1].max()
        rx_, ry_ = (band[:, 0].max() - band[:, 0].min()) / 2, (yb - ys) / 2
        rz_ = ry_ * 1.02
        c = np.array([0.0, (ys + yb) / 2, top - rz_])
        eye_z = eye_z if eye_z is not None else c[2] - 0.05 * rz_ / 0.095
        chin_z = chin_z if chin_z is not None else c[2] - 1.35 * rz_
        neck_z = chin_z - 0.03
        head_F = [f for f in F_all if V[f, 2].mean() > neck_z]
        hb = BVHTree.FromPolygons([Vector(v) for v in V], head_F)
        bb = BVHTree.FromPolygons([Vector(v) for v in V], F_all)
        h = cls(c, (rx_, ry_, rz_), hb, bb, neck_z, chin_z, eye_z)
        h.body_bvh = collision_hull(objs, below=chin_z + 0.02) or bb
        h.exact_bvh = bb
        h.env = Envelope(V[V[:, 2] < h.chin_z + 0.03], h.c)
        return h

    # ---- spherical helpers
    def sph(self, th, ph):
        th, ph = np.radians(th), np.radians(ph)
        return np.stack([np.sin(th) * np.cos(ph), -np.cos(th) * np.cos(ph), np.sin(ph)], -1)

    def angles(self, p):
        q = (np.asarray(p, float) - self.c) / self.r
        th = np.degrees(np.arctan2(q[..., 0], -q[..., 1]))
        ph = np.degrees(np.arctan2(q[..., 2], np.hypot(q[..., 0], q[..., 1])))
        return th, ph

    def root(self, th, ph, lift=0.0015):
        """Point on the real scalp at (th, ph) (ray toward the ellipsoid centre) + its normal."""
        d = self.sph(th, ph)
        far = self.c + d * self.r * 2.5
        hit = self.head_bvh.ray_cast(Vector(far), Vector(-d))
        if hit[0] is not None:
            p = np.array(hit[0]); n = np.array(hit[1])
            if n @ d < 0:
                n = -n
            return p + n * lift, n
        p = self.c + d * self.r
        return p, unit(d)

    def nearest(self, p, bvh=None):
        loc, nrm, _, dist = (bvh or self.body_bvh).find_nearest(Vector(p))
        return (np.array(loc), np.array(nrm), dist) if loc is not None else (None, None, 1e9)

    def push_out(self, p, margin):
        """Keep p at least `margin` outside the body. Above the neck: the exact head mesh. Below the chin: the smooth
        cylindrical envelope of neck + garments, faded in over 6 cm so there is no collider switch (no kinks)."""
        p = np.asarray(p, float)
        if p[2] > self.neck_z:
            loc, nrm, _, dist = self.head_bvh.find_nearest(Vector(p))
            if loc is not None and dist < 0.08:
                loc, nrm = np.array(loc), np.array(nrm)
                side = (p - loc) @ nrm
                if side < margin:
                    p = loc + nrm * margin
        env = getattr(self, 'env', None)
        if env is not None and p[2] < self.eye_z:
            w = float(smoothstep(self.eye_z, self.chin_z - 0.02, p[2]))
            q = np.array([p[0] - env.c[0], p[1] - env.c[1]])
            r = np.hypot(*q)
            R = env.radius(p)
            rmin = (R + margin) * w
            if R > 0 and r < rmin:
                q = q / max(r, 1e-6) * rmin
                p = np.array([env.c[0] + q[0], env.c[1] + q[1], p[2]])
        elif env is None and p[2] <= self.neck_z:
            loc, nrm, _, dist = self.body_bvh.find_nearest(Vector(p))
            if loc is not None and dist < 0.08:
                loc, nrm = np.array(loc), np.array(nrm)
                if (p - loc) @ nrm < margin:
                    p = loc + nrm * margin
        # ellipsoid floor inside the cranium (holes / thin shells)
        q = (p - self.c) / (self.r * 0.97)
        rr = np.linalg.norm(q)
        if rr < 1.0 and p[2] > self.eye_z:
            return self.c + q / rr * self.r * 0.97
        return p


class Envelope:
    """Cylindrical outer envelope of the body + garments below the chin: R(z, azimuth) = the largest horizontal
    distance from the head axis in that bin, max-filtered UPWARD over 4 cm so hair lifts off before it reaches a
    collar edge and drapes OVER it (no hair can end up between the neck and a stand-up collar)."""

    def __init__(self, V, c, dz=0.01, nth=72, look_up=0.14):
        self.c = np.asarray(c, float); self.dz = dz; self.nth = nth
        self.z0 = V[:, 2].min(); nz = int((V[:, 2].max() - self.z0) / dz) + 2
        q = V[:, :2] - self.c[:2]
        r = np.hypot(q[:, 0], q[:, 1]); a = np.arctan2(q[:, 1], q[:, 0])
        iz = ((V[:, 2] - self.z0) / dz).astype(int); ia = ((a + np.pi) / (2 * np.pi) * nth).astype(int) % nth
        R = np.zeros((nz, nth))
        np.maximum.at(R, (iz, ia), r)
        # fill empty bins from the angular neighbours, smooth a little
        for _ in range(3):
            R = np.maximum(R, 0.9 * np.maximum(np.roll(R, 1, 1), np.roll(R, -1, 1)))
        # slope-limited upward propagation: every obstacle (collar, shoulder) casts an upward cone, so a draped
        # surface over the envelope never has a flat ledge (hair would stall on it)
        Rm = R.copy()
        slope = 0.85 * dz
        for i in range(1, nz):
            Rm[i] = np.maximum(Rm[i], Rm[i - 1] - slope)
        # smooth (z and azimuth) so draped hair follows a gentle surface, no kinks at a collar edge
        for _ in range(4):
            Rm = np.maximum(Rm, 0.25 * (np.roll(Rm, 1, 1) + np.roll(Rm, -1, 1)) + 0.5 * Rm)
            Rm[1:-1] = np.maximum(Rm[1:-1], 0.25 * Rm[:-2] + 0.5 * Rm[1:-1] + 0.25 * Rm[2:])
        self.R = Rm

    def radius(self, p):
        iz = int((p[2] - self.z0) / self.dz)
        if iz < 0 or iz >= len(self.R):
            return 0.0
        a = math.atan2(p[1] - self.c[1], p[0] - self.c[0])
        ia = int((a + math.pi) / (2 * math.pi) * self.nth) % self.nth
        return float(self.R[iz, ia])

    def push(self, p, margin):
        q = np.array([p[0] - self.c[0], p[1] - self.c[1]])
        r = np.hypot(*q)
        R = self.radius(p)
        if R > 0 and r < R + margin:
            q = q / max(r, 1e-6) * (R + margin)
            return np.array([self.c[0] + q[0], self.c[1] + q[1], p[2]])
        return p


def collision_hull(objs, voxel=0.018, smooth_iter=12, below=None):
    """A smooth, closed OUTER hull of the body + garments (voxel remesh fills collars, lapels and gaps), so hair
    drapes OVER a jacket collar instead of being pushed into it by the nearest inner surface."""
    import bmesh
    tmp = []
    for o in objs:
        c = o.copy(); c.data = o.data.copy(); c.modifiers.clear()
        bpy.context.scene.collection.objects.link(c); tmp.append(c)
    with bpy.context.temp_override(active_object=tmp[0], selected_editable_objects=tmp, selected_objects=tmp):
        bpy.ops.object.join()
    j = tmp[0]
    r = j.modifiers.new('R', 'REMESH'); r.mode = 'VOXEL'; r.voxel_size = voxel
    s_ = j.modifiers.new('S', 'SMOOTH'); s_.iterations = smooth_iter; s_.factor = 0.6
    dg = bpy.context.evaluated_depsgraph_get()
    me = j.evaluated_get(dg).to_mesh()
    M = np.array(j.matrix_world)
    P = np.zeros(len(me.vertices) * 3); me.vertices.foreach_get('co', P); P = P.reshape(-1, 3) @ M[:3, :3].T + M[:3, 3]
    F = [list(p.vertices) for p in me.polygons]
    j.evaluated_get(dg).to_mesh_clear()
    bpy.data.objects.remove(j, do_unlink=True)
    if not F:
        return None
    return BVHTree.FromPolygons([Vector(v) for v in P], F)


# =============================================================================================== roots
def hairline_ph(th, front=38.0, temple=18.0, side=-2.0, nape=-52.0):
    """Hairline elevation (deg) as a function of azimuth: forehead -> temples -> above the ears -> nape."""
    a = np.abs(np.asarray(th, float))
    return np.interp(a, [0, 35, 70, 100, 135, 180], [front, front - 4, temple, side, (side + nape) / 2 - 6, nape])


def poisson_roots(head: Head, n, rng, region=None, min_deg=6.0, tries=40):
    """Blue-noise roots on the scalp above the hairline (dart throwing in (th, ph), spacing in degrees of arc)."""
    region = region or (lambda th, ph: ph > hairline_ph(th))
    pts = []
    for _ in range(n * tries):
        if len(pts) >= n:
            break
        th = rng.uniform(-180, 180)
        ph = math.degrees(math.asin(rng.uniform(math.sin(math.radians(-60)), 1)))
        if not region(th, ph):
            continue
        d = head.sph(th, ph)
        if all(np.degrees(np.arccos(np.clip(d @ q, -1, 1))) > min_deg for q in [head.sph(*p) for p in pts[-400:]]):
            pts.append((th, ph))
    return pts


# =============================================================================================== flow growth
class Flow:
    """Direction field for growing guides. Defaults = long swept-back hair: over the scalp the flow runs from the
    front hairline toward the back (lifted into a quiff at the front), then gravity takes over behind / beside the
    head, with an outward flare that grows toward the tips."""

    def __init__(self, head: Head, sweep=1.0, lift=0.55, lift_front=40.0, gravity=1.0, flare=0.35, part_th=None, back_bias=0.0):
        self.h, self.sweep, self.lift, self.lift_front, self.gravity, self.flare = head, sweep, lift, lift_front, gravity, flare
        self.back_bias = back_bias
        self.part_th = part_th

    def __call__(self, p, d, t, root_th):
        h = self.h
        loc, nrm, dist = h.nearest(p, h.head_bvh)
        radial = unit(p - h.c)
        th_p, ph_p = h.angles(p)
        on_head = p[2] > h.eye_z - 0.02 and dist < 0.018 and ph_p > -5
        back = np.array([0, 1.0, 0])
        if on_head:
            # tangent flow over the scalp toward the back, turning down on the sides
            th, ph = h.angles(p)
            down_w = smoothstep(40, -10, ph) * 0.9
            v = back + np.array([0, 0, -1.0]) * down_w
            if self.part_th is not None:
                v = v + np.array([np.sign(root_th - self.part_th) * 0.4, 0, 0])
            n = nrm if nrm is not None else radial
            v = v - n * (v @ n)
            # quiff: roots near the front hairline rise off the scalp first
            front = smoothstep(self.lift_front + 40, self.lift_front - 10, abs(root_th)) * smoothstep(0.18, 0.0, t)
            v = unit(v) + n * self.lift * front * 2.0
            return unit(0.35 * d + 0.65 * unit(v))
        # off the head: gravity + flare outward from the body axis
        out = np.array([p[0] - h.c[0], p[1] - h.c[1], 0.0])
        out = unit(out) if np.linalg.norm(out) > 1e-6 else np.zeros(3)
        g = np.array([0, 0, -1.0]) * self.gravity
        # swept-back layers keep travelling back behind the ears before they fall
        # below the chin, hair out over the shoulders slides BACK off them (never down the arms)
        lat = abs(p[0] - h.c[0])
        off_sh = smoothstep(0.07, 0.13, lat) * (p[2] < h.chin_z)
        out = out * (1 - 0.8 * off_sh)
        v = g + back * 1.2 * off_sh + out * self.flare * smoothstep(0.3, 1.0, t) + back * self.back_bias * smoothstep(h.eye_z - 0.06, h.eye_z + 0.04, p[2]) * (p[1] < h.c[1] + h.r[1] * 0.9)
        return unit(0.4 * d + 0.6 * unit(v))


def grow(head: Head, root, n0, length, flow, n=28, margin=(0.004, 0.012), root_th=0.0, ramp=0.5):
    """Integrate one guide from a scalp root along a Flow, colliding with the body; margin ramps root -> tip."""
    p = np.asarray(root, float).copy()
    d = unit(flow(p + n0 * 0.002, unit(n0 * 0.3 + np.array([0, 1.0, 0.2])), 0.0, root_th))
    pts = [p.copy()]
    ds = length / (n - 1)
    for i in range(1, n):
        t = i / (n - 1)
        d = flow(p, d, t, root_th)
        q = p + d * ds
        m = margin[0] + (margin[1] - margin[0]) * smoothstep(0.0, ramp, t)
        q2 = head.push_out(q, m)
        if np.linalg.norm(q2 - q) > 1e-7:
            # slide along the collider with a FULL step (never stall on ledges like a jacket collar)
            v = q2 - p
            if np.linalg.norm(v) < 0.4 * ds:
                if q2[2] > head.neck_z:
                    loc, nrm, _ = head.nearest(q2, head.head_bvh)
                else:
                    nrm = unit(np.array([q2[0] - head.c[0], q2[1] - head.c[1], 0.0]))
                out = np.array([q2[0] - head.c[0], q2[1] - head.c[1], 0.0])
                tan = d - nrm * (d @ nrm) if nrm is not None else d
                v = tan + unit(out) * 0.6 + np.array([0, 0, -0.4])
            d = unit(v)
            q2 = head.push_out(p + d * ds, m)
        p = q2
        pts.append(p.copy())
    return np.array(pts)


# =============================================================================================== guide edits
def add_wave(G, amp, freq, phase, axis_fn, start=0.35):
    """Lateral S-waves growing toward the tip (amp in m, freq = waves along the guide)."""
    n = len(G)
    t = np.linspace(0, 1, n)
    T = unit(np.gradient(G, axis=0))
    A = axis_fn(G, T)
    w = amp * np.sin(2 * np.pi * freq * t + phase) * smoothstep(start, 1.0, t)
    return G + w[:, None] * A


def flick(G, head: Head, amount, start=0.72, up=0.0):
    """Tip flick: rotate the end of the guide outward (away from the body axis) and slightly up."""
    G = G.copy()
    n = len(G)
    k0 = int(start * (n - 1))
    for i in range(k0 + 1, n):
        a = amount * smoothstep(start, 1.0, i / (n - 1))
        out = np.array([G[i, 0] - head.c[0], G[i, 1] - head.c[1], 0]); out = unit(out)
        seg = G[i] - G[i - 1]
        L = np.linalg.norm(seg)
        dirn = unit(seg + (out + np.array([0, 0, up])) * L * a * 1.2)
        G[i] = G[i - 1] + dirn * L
    return G


def collide(head: Head, G, margin=(0.004, 0.012)):
    G = G.copy()
    n = len(G)
    for i in range(1, n):
        t = i / (n - 1)
        G[i] = head.push_out(G[i], margin[0] + (margin[1] - margin[0]) * smoothstep(0, 0.5, t))
    return G


def restore_lengths(G, L0):
    """Keep the segment lengths of G equal to L0 (after edits), root fixed."""
    G = G.copy()
    for i in range(1, len(G)):
        G[i] = G[i - 1] + unit(G[i] - G[i - 1]) * L0[i - 1]
    return G


# =============================================================================================== reference silhouettes
def hair_mask(img_rgb, hue=(0.0, 0.11), sat=(0.25, 1.0), val=(0.06, 0.62)):
    """Reddish/dark-brown hair pixels of a reference drawing (HSV box). img_rgb float [0,1] HxWx3."""
    r, g, b = img_rgb[..., 0], img_rgb[..., 1], img_rgb[..., 2]
    mx, mn = img_rgb.max(-1), img_rgb.min(-1)
    v = mx; s = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0)
    h = np.zeros_like(mx)
    d = np.maximum(mx - mn, 1e-6)
    h = np.where(mx == r, ((g - b) / d) % 6, h)
    h = np.where(mx == g, (b - r) / d + 2, h)
    h = np.where(mx == b, (r - g) / d + 4, h)
    h = h / 6
    return (h >= hue[0]) & (h <= hue[1]) & (s >= sat[0]) & (s <= sat[1]) & (v >= val[0]) & (v <= val[1])


class RefView:
    """A reference drawing of one view, calibrated by two image rows: the top of the skull (under the hair) and the
    chin, plus the column of the head's vertical axis. Maps world (x or y, z) <-> pixels."""

    def __init__(self, mask, top_px, chin_px, axis_px, head: Head, view='back'):
        self.m, self.view, self.h = mask, view, head
        self.k = (chin_px - top_px) / ((head.c[2] + head.r[2]) - head.chin_z)      # px per m
        self.top_px, self.axis_px = top_px, axis_px

    def to_px(self, P):
        P = np.atleast_2d(P)
        h = self.h
        if self.view == 'back':          # looking from behind: character's left (+X) is on the image LEFT
            x = self.axis_px - (P[:, 0] - h.c[0]) * self.k
        elif self.view == 'front':
            x = self.axis_px + (P[:, 0] - h.c[0]) * self.k
        else:                            # side view, character facing image right: back (+Y) is image left
            x = self.axis_px - (P[:, 1] - h.c[1]) * self.k
        y = self.top_px + ((h.c[2] + h.r[2]) - P[:, 2]) * self.k
        return np.stack([x, y], 1)

    def bottom_at(self, x_px):
        """Lowest hair pixel row in a column band around x_px (-1 if none)."""
        H, W = self.m.shape
        x0, x1 = int(max(0, x_px - 6)), int(min(W, x_px + 7))
        col = self.m[:, x0:x1].any(1)
        ys = np.nonzero(col)[0]
        return ys.max() if len(ys) else -1

    def width_at(self, y_px):
        H, W = self.m.shape
        y = int(np.clip(y_px, 0, H - 1))
        xs = np.nonzero(self.m[max(0, y - 3):y + 4].any(0))[0]
        return (xs.min(), xs.max()) if len(xs) else None


def fit_lengths_to_ref(guides, ref: RefView, strength=1.0, min_len=0.05):
    """Trim / extend each guide so its tip ends at the reference hair silhouette's bottom edge in that column."""
    out = []
    for G in guides:
        seg = np.linalg.norm(np.diff(G, axis=0), axis=1)
        L = seg.sum()
        tip_px = ref.to_px(G[-1])[0]
        bot = ref.bottom_at(tip_px[0])
        if bot < 0:
            out.append(G); continue
        dz_px = bot - tip_px[1]                 # + = the reference hair goes lower
        dz = dz_px / ref.k * strength
        # convert the vertical change into length change along the (mostly downward) end direction
        end_dir = unit(G[-1] - G[-4])
        down = max(0.3, -end_dir[2])
        newL = float(np.clip(L + dz / down, max(min_len, 0.97 * L), 1.35 * L))     # extend only (the recipe sets the minimum)
        if newL > L:
            ext = [G[-1] + end_dir * (newL - L) * (k / 4) for k in range(1, 5)]
            G2 = np.vstack([G, ext])
        else:
            G2 = G
        out.append(resample_len(G2, newL, len(G)))
    return out


def resample_len(G, L, n):
    seg = np.linalg.norm(np.diff(G, axis=0), axis=1)
    cum = np.r_[0, np.cumsum(seg)]
    s = np.linspace(0, min(L, cum[-1]), n)
    return np.stack([np.interp(s, cum, G[:, k]) for k in range(3)], 1)


def fit_width_to_ref(guides, ref: RefView, head: Head, strength=0.7, axis=0):
    """Scale the guides' lateral offset (from the head axis) per height so the hair mass matches the reference
    silhouette's width at each row (front / back view: axis 0 = X; side view: axis 1 = Y, back half only)."""
    Z = np.concatenate([G[:, 2] for G in guides])
    X = np.concatenate([G[:, axis] for G in guides])
    zs = np.linspace(Z.min(), Z.max(), 24)
    scale = np.ones_like(zs)
    for i, z in enumerate(zs):
        sel = np.abs(Z - z) < (zs[1] - zs[0])
        if sel.sum() < 4:
            continue
        cur = np.abs(X[sel] - head.c[axis]).max()
        y_px = ref.to_px(np.array([head.c[0], head.c[1], z]))[0, 1]
        wb = ref.width_at(y_px)
        if wb is None or cur < 0.02:
            continue
        tgt = max(abs(wb[0] - ref.axis_px), abs(wb[1] - ref.axis_px)) / ref.k
        scale[i] = np.clip(tgt / cur, 0.7, 1.5)
    out = []
    for G in guides:
        s = np.interp(G[:, 2], zs, scale)
        t = np.linspace(0, 1, len(G))
        w = smoothstep(0.15, 0.6, t) * strength                 # roots stay on the scalp
        G2 = G.copy()
        G2[:, axis] = head.c[axis] + (G[:, axis] - head.c[axis]) * (1 + (s - 1) * w)
        out.append(G2)
    return out


# =============================================================================================== guides over a sculpt
def guides_on_shell(shell_verts, shell_faces, seeds, flow_dir=(0, 0.4, -1.0), step=0.006, max_len=0.6):
    """Trace guides ON a sculpted hair shell / lock mesh: from each seed, walk along the flow direction projected
    onto the shell's tangent plane, snapping back onto the surface each step, until the walk leaves the shell."""
    bvh = BVHTree.FromPolygons([Vector(v) for v in shell_verts], shell_faces)
    fd = unit(np.asarray(flow_dir, float))
    out = []
    for s in seeds:
        loc, nrm, _, _ = bvh.find_nearest(Vector(s))
        if loc is None:
            continue
        p = np.array(loc); d = fd.copy(); pts = [p]
        L = 0.0
        while L < max_len:
            loc, nrm, _, dist = bvh.find_nearest(Vector(p))
            n = np.array(nrm)
            v = fd - n * (fd @ n)
            if np.linalg.norm(v) < 1e-4:
                break
            d = unit(0.6 * d + 0.4 * unit(v))
            q = p + d * step
            loc2, _, _, dist2 = bvh.find_nearest(Vector(q))
            if loc2 is None or dist2 > step * 1.5:
                break
            q = np.array(loc2)
            if np.linalg.norm(q - p) < step * 0.3:
                break
            L += np.linalg.norm(q - p); p = q; pts.append(p)
        if len(pts) > 4:
            out.append(np.array(pts))
    return out


# =============================================================================================== hair mass + streamlines
class HairMass:
    """The hair's outer SHAPE as an implicit surface (how artists block hair before laying locks): the cranium
    ellipsoid grown by `off` (+ extra volume on top), unioned with a CURTAIN behind the ears that falls from the
    widest part of the head, never closer than `off` to the neck / collar / shoulder envelope. Nested masses (one
    per layer offset) give non-crossing layers; guides are streamlines ON a mass (no collision fights)."""

    def __init__(self, head: Head, off, top_volume=0.0, curtain_front=-0.25, z_bottom=1.3, flare=0.0):
        self.h, self.off, self.tv, self.cf, self.zb, self.flare = head, off, top_volume, curtain_front, z_bottom, flare

    def sdf(self, p):
        h = self.h
        r = h.r + self.off
        q = (p - h.c)
        rr = r * np.array([1.0, 1.0, 1.0 + (self.tv if q[2] > 0 else 0.0)])    # extra volume on top only
        d_head = (np.linalg.norm(q / rr) - 1.0) * rr.min()
        # the real head (ears, sideburns, beard edge) must stay INSIDE the mass: union with its offset surface
        if p[2] > h.chin_z - 0.01 and p[1] > h.c[1] - 0.5 * h.r[1]:
            loc, nrm, _, dist = h.head_bvh.find_nearest(Vector(p))
            if loc is not None and dist < 0.05:
                sd = dist if (np.asarray(p) - np.array(loc)) @ np.array(nrm) > 0 else -dist
                d_head = min(d_head, sd - self.off)
        # curtain: elliptic cylinder of the head's horizontal section, behind the ears, below the head centre
        yb = h.c[1] - self.cf * h.r[1]
        if p[2] < h.c[2] and p[2] > self.zb:
            ex, ey = r[0], r[1]
            R_ell = 1.0 / max(np.hypot(q[0] / ex, q[1] / ey) / max(np.hypot(q[0], q[1]), 1e-9), 1e-9)
            env = getattr(h, 'env', None)
            R_env = (env.radius(p) + self.off) if env is not None else 0.0
            rad = np.hypot(q[0], q[1])
            d_cur = rad - max(R_ell, R_env) - self.flare * max(0.0, h.c[2] - p[2])   # curtain widens downward
            if p[1] < yb:                       # in front of the ears: no curtain (the face)
                d_cur = max(d_cur, (yb - p[1]))
            k = 0.02                            # smooth union: no crease where the head meets the curtain
            m = min(d_head, d_cur)
            return m - k * math.log(math.exp(-(d_head - m) / k) + math.exp(-(d_cur - m) / k))
        return d_head

    def grad(self, p, e=0.002):
        g = np.array([self.sdf(p + np.array(v) * e) - self.sdf(p - np.array(v) * e) for v in ((1, 0, 0), (0, 1, 0), (0, 0, 1))])
        return unit(g)

    def project(self, p, it=4):
        for _ in range(it):
            d = self.sdf(p)
            if abs(d) < 2e-4:
                break
            p = p - self.grad(p) * d
        return p


def streamline(mass: HairMass, root, z_end, sweep=1.0, ds=0.008, max_len=1.2, root_rise=0.0, part_x=None,
               shoulder_back=1.4, allow_front=False):
    """Trace a lock guide from a scalp root: rise off the scalp onto the mass (quiff), then flow over the mass:
    swept BACK over the upper head, DOWN everywhere else, until the tip height z_end."""
    h = mass.h
    p = np.asarray(root, float)
    pts = [p.copy()]
    # rise: from the root to the mass surface along the scalp normal (+ a little back / up for a quiff)
    n = unit(p - h.c)
    target = mass.project(p + n * (mass.off + root_rise))
    k = max(2, int(np.linalg.norm(target - p) / ds))
    for i in range(1, k + 1):
        a = i / k
        q = p + (target - p) * a + np.array([0, 1.0, 0.4]) * root_rise * math.sin(math.pi * a) * 0.5
        pts.append(q)
    p = target
    d = None
    L = 0.0
    yb = h.c[1] - mass.cf * h.r[1]
    while L < max_len and p[2] > z_end:
        if p[2] < h.chin_z + 0.02 and p[1] < yb and not (allow_front and abs(p[0] - h.c[0]) > 0.075):
            break                                # never wrap under the jaw / into the shirt front
        g = mass.grad(p)
        if isinstance(mass, VoxelMass) and g[2] < -0.75 and p[2] < h.c[2] - 0.05:
            break                                   # reached the hull's hem: the reference silhouette ends here
        q = p - h.c
        above = smoothstep(h.c[2] - 0.03, h.c[2] + 0.05, p[2])
        in_front = smoothstep(h.c[1] + 0.6 * h.r[1], h.c[1] - 0.2 * h.r[1], p[1])
        # comb-back direction = the meridian tangent (up the forehead, back over the crown, down the back)
        comb = -np.cross(np.array([1.0, 0, 0]), g)
        if np.linalg.norm(comb) < 0.35:                  # on the sides: back and down behind the ear
            comb = comb + np.array([0, 1.0, -0.6])
        if comb @ np.array([0, 1.0, 0.0]) < -0.2 and p[1] > h.c[1]:
            comb = -comb
        v = unit(comb) * sweep * above + np.array([0, 0, -1.0]) * (1 - above)
        # on the shoulders: slide BACK off them onto the back (swept-back hair never drapes down the chest)
        sh = smoothstep(0.075, 0.13, abs(p[0] - h.c[0])) * (p[2] < h.chin_z)
        v = v + np.array([0, 1.0, 0]) * shoulder_back * sh
        if part_x is not None:
            v = v + np.array([np.sign(p[0] - part_x) * 0.25 * above, 0, 0])
        v = v - g * (v @ g)
        if np.linalg.norm(v) < 1e-4:
            v = np.array([0, 0, -1.0]) - g * (-g[2])
        v = unit(v)
        d = v if d is None else unit(0.5 * d + 0.5 * v)
        p = mass.project(p + d * ds)
        pts.append(p.copy())
        L += ds
    return np.array(pts)



class VoxelMass(HairMass):
    """A hair mass from a reference-carved visual hull (tools/ref_match.py build_hull): signed distance grid,
    inset by `inset` for inner layers, kept outside the body envelope, smoothly united with the scalp-hugging
    head mass so roots attach. Same interface as HairMass (sdf / grad / project) + `bottom` stop test."""

    def __init__(self, head: Head, path, inset=0.0, head_off=0.012, clear=0.012):
        super().__init__(head, head_off)
        z = np.load(path)
        self.G = z['sdf'].astype(np.float32); self.o = z['origin'].astype(float); self.st = float(z['step'])
        self.inset, self.clear = inset, clear
        self.off = head_off
        self._head = HairMass(head, head_off)

    def hull(self, p):
        q = (np.asarray(p, float) - self.o) / self.st
        i0 = np.floor(q).astype(int)
        n = np.array(self.G.shape)
        if np.any(i0 < 0) or np.any(i0 >= n - 1):
            return 0.2
        f = q - i0
        c = self.G[i0[0]:i0[0] + 2, i0[1]:i0[1] + 2, i0[2]:i0[2] + 2]
        c = c[0] * (1 - f[0]) + c[1] * f[0]
        c = c[0] * (1 - f[1]) + c[1] * f[1]
        return float(c[0] * (1 - f[2]) + c[1] * f[2]) + self.inset

    def sdf(self, p):
        p = np.asarray(p, float)
        d = self.hull(p)
        h = self.h
        env = getattr(h, 'env', None)
        if env is not None and p[2] < h.chin_z:
            rad = math.hypot(p[0] - env.c[0], p[1] - env.c[1])
            d = max(d, (env.radius(p) + self.clear) - rad)          # never inside neck / jacket
        dh = self._head.sdf(p)
        k = 0.012
        m = min(d, dh)
        return m - k * math.log(math.exp(-(d - m) / k) + math.exp(-(dh - m) / k))
