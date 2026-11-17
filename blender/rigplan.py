"""Skeleton plans from guided taps. PURE GEOMETRY: no bpy, no mathutils, so the unit tests (blender/test_rigplan.py) run
under plain Python and the same code runs inside Blender (blender/autorig.py calls plan()).

Space: Blender world, metres, +Z up, a glTF model that faces +Z faces -Y here (blender/common.py). Points are (x, y, z)
tuples. Taps arrive as [u, v, w] over the model's glTF box (shared/rigTaps.ts) and are mapped with Cloud.from_uvw.

Templates (the bone names are the contract with the runtime, see src/avatar/quadruped.ts and docs/ARTIST_AVATARS.md):
  humanoid   hips spine chest neck head, left/right UpperArm LowerArm Hand, UpperLeg LowerLeg Foot   (VRM names)
  quadruped  hips spine chest neck [neck_2] head, leg_FL_1..3 (+ leg_FL_toe) / FR / HL / HR, tail_1..4
  creature   bird or snake: hips spine chest neck [neck_2] head, tail_1..n, bird: leg_HL_1..2 / leg_HR_1..2, wing_L_1..3 / wing_R_1..3
  object     hips (holds still), spine chest neck head (the bend chain), chain_1..3 (springs on the loose end)
Every plan starts with hips, then spine ... head, so the humanoid matcher accepts it and face tracking drives the head,
neck and spine; extra parts follow the quadruped / spring naming the runtime already understands.
"""
import math

# ---------------------------------------------------------------- tiny vector helpers (tuples)

UP = (0.0, 0.0, 1.0)


def add(a, b): return (a[0] + b[0], a[1] + b[1], a[2] + b[2])
def sub(a, b): return (a[0] - b[0], a[1] - b[1], a[2] - b[2])
def mul(a, k): return (a[0] * k, a[1] * k, a[2] * k)
def dot(a, b): return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
def cross(a, b): return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
def length(a): return math.sqrt(dot(a, a))
def dist(a, b): return length(sub(a, b))
def lerp(a, b, t): return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)


def norm(a, fallback=(0.0, 1.0, 0.0)):
    n = length(a)
    return (a[0] / n, a[1] / n, a[2] / n) if n > 1e-12 else fallback


def horiz(a): return (a[0], a[1], 0.0)


def percentile(xs, q):
    if not xs:
        raise ValueError("percentile of nothing")
    s = sorted(xs)
    i = min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))
    return s[i]


def median(xs): return percentile(xs, 0.5)


class PlanError(ValueError):
    """The taps / mesh cannot make this skeleton. The message is shown to the person: plain words."""


# ---------------------------------------------------------------- the mesh as a point cloud

class Cloud:
    """World-space vertices of everything that will be skinned.

    max_points=None (the default, and always for the person template: old callers must get the old numbers) keeps every point.
    With a limit, the points are a deterministic stride sample, but the box (lo / hi / h / center) is ALWAYS taken from every
    point: it is the box the tap coordinates were made in (the UI's box over the whole model), so a sample never moves a tap."""

    def __init__(self, pts, max_points=None):
        pts = [(float(p[0]), float(p[1]), float(p[2])) for p in pts]
        if not pts:
            raise PlanError("The model has no points to build a skeleton on.")
        self.n_all = len(pts)
        self.lo = (min(p[0] for p in pts), min(p[1] for p in pts), min(p[2] for p in pts))
        self.hi = (max(p[0] for p in pts), max(p[1] for p in pts), max(p[2] for p in pts))
        if max_points and len(pts) > max_points:  # a stride is plenty for slices and centroids of the new templates
            step = len(pts) / float(max_points)
            pts = [pts[int(i * step)] for i in range(max_points)]
        self.pts = pts
        self.h = max(self.hi[2] - self.lo[2], 1e-6)
        self.center = lerp(self.lo, self.hi, 0.5)

    def z(self, t):
        return self.lo[2] + t * self.h

    def from_uvw(self, uvw):
        """Normalized glTF-box coords -> Blender world (the same maths as autorig.Geo.from_uvw)."""
        u, v, w = uvw
        g_zmin, g_zmax = -self.hi[1], -self.lo[1]  # glTF z range
        gz = g_zmin + w * (g_zmax - g_zmin)
        return (self.lo[0] + u * (self.hi[0] - self.lo[0]), -gz, self.lo[2] + v * self.h)

    def to_uvw(self, p):
        """The inverse of from_uvw (tests and the Blender census use it to place taps)."""
        dx, dy = self.hi[0] - self.lo[0], self.hi[1] - self.lo[1]
        return ((p[0] - self.lo[0]) / (dx or 1.0), (p[2] - self.lo[2]) / self.h, (self.hi[1] - p[1]) / (dy or 1.0))

    def slice_centroid(self, z, tol, xmin=None, xmax=None, min_count=8):
        sel = [p for p in self.pts if abs(p[2] - z) <= tol and (xmin is None or p[0] >= xmin) and (xmax is None or p[0] <= xmax)]
        if len(sel) < min_count:
            return None, len(sel)
        n = len(sel)
        return (sum(p[0] for p in sel) / n, sum(p[1] for p in sel) / n, z), n

    def where(self, pred):
        return [p for p in self.pts if pred(p)]


class Plan:
    """bones: [(name, head, tail, parent)] parents first."""

    def __init__(self, template, bones, info=None, notes=None):
        self.template, self.bones, self.info, self.notes = template, bones, info or {}, notes or []

    def names(self):
        return [b[0] for b in self.bones]

    def add(self, name, head, tail, parent):
        self.bones.append((name, head, tail, parent))


def validate_plan(plan, min_len=1e-4):
    """Raise PlanError unless the plan is a clean tree of real, finite bones with the required roots."""
    seen = set()
    for name, head, tail, parent in plan.bones:
        if name in seen:
            raise PlanError(f"duplicate bone {name}")
        if parent is not None and parent not in seen:
            raise PlanError(f"{name}: parent {parent} must come first")
        for p in (head, tail):
            if not all(math.isfinite(c) for c in p):
                raise PlanError(f"{name}: non-finite position")
        if dist(head, tail) < min_len:
            raise PlanError(f"{name}: zero-length bone")
        seen.add(name)
    for need in ("hips", "spine", "head"):
        if need not in seen:
            raise PlanError(f"missing required bone {need}")
    return True


# ---------------------------------------------------------------- shared helpers

def side_axis(axis):
    """The creature's left, given its forward axis (up x forward). Falls back to world X for a vertical body."""
    s = cross(UP, axis)
    if length(s) < 0.25:
        s = cross((1.0, 0.0, 0.0), axis)
    return norm(s, (1.0, 0.0, 0.0))


def centerline(cloud, a, b, n, band=0.6):
    """n+1 points from a to b following the middle of the mesh (centroid of the vertices in each slab across a->b). The two
    ends are the taps themselves. A slab with nothing in it falls back to the straight line."""
    d = sub(b, a)
    total = length(d)
    if total < 1e-9:
        raise PlanError("The two taps are on the same spot.")
    ax = mul(d, 1.0 / total)
    bins = max(4 * n, 8)
    buckets = [[] for _ in range(bins + 1)]
    for p in cloud.pts:
        r = sub(p, a)
        u = dot(r, ax) / total
        if u < -0.02 or u > 1.02:
            continue
        if length(sub(r, mul(ax, u * total))) > band * total:
            continue
        buckets[min(bins, max(0, int(round(u * bins))))].append(p)
    out = []
    for i in range(n + 1):
        t = i / float(n)
        if i == 0:
            out.append(a)
            continue
        if i == n:
            out.append(b)
            continue
        k = int(round(t * bins))
        sel = []
        for j in range(max(0, k - 2), min(bins, k + 2) + 1):
            sel += buckets[j]
        if len(sel) < 6:
            out.append(lerp(a, b, t))
            continue
        c = (sum(p[0] for p in sel) / len(sel), sum(p[1] for p in sel) / len(sel), sum(p[2] for p in sel) / len(sel))
        # keep the point on its slab (the centroid may drift along the axis); only the cross-section part is wanted
        along = dot(sub(c, a), ax)
        c = add(c, mul(ax, t * total - along))
        out.append(c)
    # one pass of smoothing keeps a noisy slab from kinking the chain
    sm = [out[0]] + [lerp(out[i], lerp(out[i - 1], out[i + 1], 0.5), 0.5) for i in range(1, n)] + [out[n]]
    return sm


def sample(points, t):
    """Point at fraction t (0..1) along a polyline."""
    if t <= 0:
        return points[0]
    if t >= 1:
        return points[-1]
    seg = [dist(points[i], points[i + 1]) for i in range(len(points) - 1)]
    total = sum(seg)
    if total < 1e-12:
        return points[0]
    goal, acc = t * total, 0.0
    for i, s in enumerate(seg):
        if acc + s >= goal:
            return lerp(points[i], points[i + 1], (goal - acc) / s if s > 0 else 0.0)
        acc += s
    return points[-1]


def chain_along(plan, prefix, parent, points_fn, count, fracs):
    """Add `count` bones <prefix>1.. between successive fractions along points_fn(t)."""
    last = parent
    for i in range(count):
        a, b = points_fn(fracs[i]), points_fn(fracs[i + 1])
        name = f"{prefix}{i + 1}"
        plan.add(name, a, b, last)
        last = name
    return last


# ---------------------------------------------------------------- QUADRUPED

LEG_KEYS = ("FL", "FR", "HL", "HR")

# parameter block (fractions of the body length L = tail root .. nose, unless noted)
Q_HIPS_T, Q_SPINE_T, Q_CHEST_T, Q_WITHERS_T = 0.16, 0.38, 0.60, 0.70
Q_HEAD_LEN = 0.17          # head bone length / L when the nose is far from the neck
Q_TAIL_BONES = 4
Q_TAIL_DEFAULT = 0.09      # tail length / L when there is no tail tap
Q_TOE = 0.05               # toe bone length / L
Q_KNEE_BEND = (0.02, -0.05)  # front / hind knee offset along forward, fraction of L


def guess_forward(cloud):
    """Without a nose tap: the longer horizontal side of the box; the head end is the end whose top 10% sits higher."""
    dx, dy = cloud.hi[0] - cloud.lo[0], cloud.hi[1] - cloud.lo[1]
    axis = (1.0, 0.0, 0.0) if dx >= dy else (0.0, 1.0, 0.0)
    ss = [dot(p, axis) for p in cloud.pts]
    s_lo, s_hi = min(ss), max(ss)
    span = max(s_hi - s_lo, 1e-9)
    lo_end = [p[2] for p, s in zip(cloud.pts, ss) if s < s_lo + 0.12 * span]
    hi_end = [p[2] for p, s in zip(cloud.pts, ss) if s > s_hi - 0.12 * span]
    top_lo = percentile(lo_end, 0.9) if lo_end else cloud.lo[2]
    top_hi = percentile(hi_end, 0.9) if hi_end else cloud.lo[2]
    return axis if top_hi >= top_lo else mul(axis, -1.0)


def plan_quadruped(cloud, taps):
    """taps: tap id -> world point. Needs nose (else it is guessed); tailRoot, tailTip, pawFR/pawHR (+ pawFL/pawHL) improve it."""
    notes = []
    nose = taps.get("nose")
    tail_root = taps.get("tailRoot")
    if nose and tail_root:
        f = norm(horiz(sub(nose, tail_root)))
        if length(horiz(sub(nose, tail_root))) < 0.05 * cloud.h:
            raise PlanError("The nose and the tail start are on the same spot: tap the nose at the front and the tail start at the back.")
    else:
        f = guess_forward(cloud)
        notes.append("No nose / tail start tapped: the front was guessed from the shape.")
    left = norm(cross(UP, f))
    s_of = lambda p: dot(p, f)          # noqa: E731  position along the body
    l_of = lambda p: dot(p, left)       # noqa: E731  position sideways (animal's left is +)

    ss = [s_of(p) for p in cloud.pts]
    if tail_root is None:
        tail_root = _extreme_point(cloud, f, -1)
        notes.append("Tail start guessed at the back of the model.")
    if nose is None:
        nose = _extreme_point(cloud, f, +1)
        notes.append("Nose guessed at the front of the model.")
    s0, s1 = s_of(tail_root), s_of(nose)
    L = s1 - s0
    if L < 0.1 * cloud.h:
        raise PlanError("The body is too short between the tail start and the nose.")
    S = lambda t: s0 + t * L            # noqa: E731

    trunk = [p for p, s in zip(cloud.pts, ss) if S(0.2) <= s <= S(0.6)]
    if len(trunk) < 8:
        trunk = cloud.pts
    paws = [taps[k] for k in ("pawFR", "pawHR", "pawFL", "pawHL") if taps.get(k)]
    z_ground = (sum(p[2] for p in paws) / len(paws)) if paws else cloud.lo[2]
    back_z = percentile([p[2] for p in trunk], 0.93)
    mid_l = median([l_of(p) for p in trunk])
    spine_z = median([p[2] for p in trunk])
    spine_z = min(max(spine_z, z_ground + 0.45 * (back_z - z_ground)), back_z - 0.08 * (back_z - z_ground))

    def world(s, l, z):
        return add(add(mul(f, s), mul(left, l)), (0.0, 0.0, z))

    hips = world(S(Q_HIPS_T), mid_l, spine_z)
    spine = world(S(Q_SPINE_T), mid_l, spine_z)
    chest = world(S(Q_CHEST_T), mid_l, spine_z)
    withers = world(S(Q_WITHERS_T), mid_l, spine_z + 0.06 * (back_z - z_ground))
    head_len = min(Q_HEAD_LEN * L, 0.6 * dist(withers, nose))
    nose_c = world(s1, mid_l, nose[2])
    head_base = sub(nose_c, mul(norm(sub(nose_c, withers)), head_len))
    p = Plan("quadruped", [], {"forward": f, "left": left, "length": L})
    p.add("hips", hips, spine, None)
    p.add("spine", spine, chest, "hips")
    p.add("chest", chest, withers, "spine")
    if dist(withers, head_base) > 0.12 * L:
        mid = lerp(withers, head_base, 0.5)
        p.add("neck", withers, mid, "chest")
        p.add("neck_2", mid, head_base, "neck")
        p.add("head", head_base, nose_c, "neck_2")
    else:
        p.add("neck", withers, head_base, "chest")
        p.add("head", head_base, nose_c, "neck")

    # ---- tail
    tail_tip = taps.get("tailTip")
    t_root = world(s0, mid_l, tail_root[2])
    if tail_tip:
        t_tip = world(s_of(tail_tip), mid_l, tail_tip[2])
    else:
        t_tip = sub(t_root, mul(f, Q_TAIL_DEFAULT * L))
        notes.append("No tail tip tapped: a short tail was added.")
    if dist(t_root, t_tip) < 0.03 * L:
        t_tip = sub(t_root, mul(f, 0.03 * L))
    chain_along(p, "tail_", "hips", lambda t: lerp(t_root, t_tip, t), Q_TAIL_BONES, [i / float(Q_TAIL_BONES) for i in range(Q_TAIL_BONES + 1)])

    # ---- legs
    half = cloud.hi[0] - cloud.lo[0] if abs(f[0]) < 0.5 else cloud.hi[1] - cloud.lo[1]  # width across the body (rough)
    default_lat = max(0.5 * 0.35 * half, 0.04 * L)
    leg_h = max(spine_z - z_ground, 0.05 * L)
    front_s = S(0.64)
    hind_s = S(0.17)
    paw = {k: taps.get("paw" + k) for k in LEG_KEYS}
    # near taps are the right side; a missing far / near one copies its sibling (same stride)
    for a, b in (("FL", "FR"), ("HL", "HR")):
        if paw[a] is None and paw[b] is not None:
            paw[a] = paw[b]
        if paw[b] is None and paw[a] is not None:
            paw[b] = paw[a]
    for key in LEG_KEYS:
        if paw[key] is not None:
            continue
        front = key[0] == "F"
        s_ref = front_s if front else hind_s
        low = [q for q in cloud.pts if abs(s_of(q) - s_ref) < 0.08 * L and q[2] < z_ground + 0.2 * leg_h]
        z_p = min(q[2] for q in low) if low else z_ground
        paw[key] = world(s_ref, mid_l, z_p)
        notes.append(f"Foot {key} guessed under the {'front' if front else 'back'} of the body.")
    for key in LEG_KEYS:
        front = key[0] == "F"
        sign = 1.0 if key[1] == "L" else -1.0
        pw = paw[key]
        s_p = s_of(pw)
        sel = [q for q in cloud.pts if abs(s_of(q) - s_p) < 0.07 * L and q[2] < z_ground + 0.35 * leg_h]
        lat = _lateral(sel, sign, mid_l, left, default_lat)
        g = world(s_p, mid_l + sign * lat, pw[2])
        s_top = 0.5 * (s_p + (s_of(chest) if front else s_of(hips)))
        top = world(s_top, mid_l + sign * lat * 0.9, spine_z - 0.1 * leg_h)
        bend = Q_KNEE_BEND[0 if front else 1] * L
        knee = add(lerp(top, g, 0.5), mul(f, bend))
        ankle = lerp(knee, g, 0.55)
        n = f"leg_{key}_"
        parent = "chest" if front else "hips"
        p.add(n + "1", top, knee, parent)
        p.add(n + "2", knee, ankle, n + "1")
        p.add(n + "3", ankle, g, n + "2")
        p.add(f"leg_{key}_toe", g, add(g, mul(f, Q_TOE * L)), n + "3")
    p.notes = notes
    validate_plan(p)
    return p


def _extreme_point(cloud, axis, sign):
    """The model's most forward (+1) or backward (-1) point along `axis`, at the median height of the 3% of points near it."""
    ss = [dot(q, axis) for q in cloud.pts]
    lo, hi = min(ss), max(ss)
    span = max(hi - lo, 1e-9)
    near = [q for q, s in zip(cloud.pts, ss) if (s >= hi - 0.03 * span if sign > 0 else s <= lo + 0.03 * span)]
    c = (sum(q[0] for q in near) / len(near), sum(q[1] for q in near) / len(near), median([q[2] for q in near]))
    return c


def _lateral(sel, side, mid_l, left, fallback, extreme=False):
    """Distance from the middle line to the mesh on one side: the average (a leg) or the far edge (a wing tip)."""
    ls = [dot(q, left) - mid_l for q in sel]
    ls = [x * side for x in ls if x * side > 0.003]
    if len(ls) < 4:
        return fallback
    return percentile(ls, 0.97) if extreme else sum(ls) / len(ls)


# ---------------------------------------------------------------- CREATURE (bird, snake)

# parameter blocks: fractions of the nose..tail axis (0 = tail tip, 1 = nose)
C_SNAKE = dict(hips=0.45, spine=0.55, chest=0.65, neck=0.76, neck2=0.86, head=0.93, tail_bones=6, tail_start=0.45)
C_BIRD = dict(hips=0.36, spine=0.46, chest=0.56, neck=0.67, neck2=0.78, head=0.88, tail_bones=3, tail_start=0.22)


def plan_creature(cloud, taps, body_type):
    """Bird or snake / long-tailed body. Needs nose + tailTip; a bird also takes wingTipR/L and footR/L (mirrored if one side)."""
    nose, tail_tip = taps.get("nose"), taps.get("tailTip")
    if nose is None or tail_tip is None:
        raise PlanError("Tap the nose (or beak) and the tip of the tail.")
    if dist(nose, tail_tip) < 0.15 * cloud.h:
        raise PlanError("The nose and the tail tip are almost on the same spot.")
    P = C_BIRD if body_type == "bird" else C_SNAKE
    n = 24
    line = centerline(cloud, tail_tip, nose, n)         # tail tip -> nose, following the body
    at = lambda t: sample(line, t)                      # noqa: E731
    axis = norm(sub(nose, tail_tip))
    left = side_axis(axis)
    p = Plan("creature", [], {"bodyType": body_type, "axis": axis, "left": left})
    notes = []
    # chain toward the head
    h, s, c, nk, n2, hd = (at(P[k]) for k in ("hips", "spine", "chest", "neck", "neck2", "head"))
    p.add("hips", h, s, None)
    p.add("spine", s, c, "hips")
    p.add("chest", c, nk, "spine")
    p.add("neck", nk, n2, "chest")
    p.add("neck_2", n2, hd, "neck")
    p.add("head", hd, nose, "neck_2")
    # tail (from the body toward the tip)
    tb = P["tail_bones"]
    ts = P["tail_start"]
    fr = [ts * (1.0 - i / float(tb)) for i in range(tb + 1)]   # ts .. 0
    chain_along(p, "tail_", "hips", at, tb, fr)
    if body_type == "bird":
        _bird_limbs(p, cloud, taps, line, at, axis, left, notes)
    p.notes = notes
    validate_plan(p)
    return p


def _bird_limbs(p, cloud, taps, line, at, axis, left, notes):
    total = sum(dist(line[i], line[i + 1]) for i in range(len(line) - 1))
    ground = cloud.lo[2]
    mid_l = dot(at(0.5), left)
    body_w = max(0.05 * total, 0.5 * (max(dot(q, left) for q in cloud.pts) - min(dot(q, left) for q in cloud.pts)) * 0.25)
    # ---- feet (hind legs: leg_HL_ / leg_HR_, planted by src/avatar/quadruped.ts)
    feet = {"R": taps.get("footR"), "L": taps.get("footL")}
    if feet["L"] is None:
        feet["L"] = feet["R"]
    if feet["R"] is None:
        feet["R"] = feet["L"]
    if feet["R"] is None:
        # the lowest part of the body, a bit behind the middle
        c = at(0.4)
        low = [q for q in cloud.pts if q[2] < ground + 0.12 * cloud.h and abs(dot(sub(q, c), axis)) < 0.15 * total]
        base = (sum(q[0] for q in low) / len(low), sum(q[1] for q in low) / len(low), ground) if len(low) >= 4 else (c[0], c[1], ground)
        feet = {"R": base, "L": base}
        notes.append("No foot tapped: feet were added under the middle of the body.")
    hips = at(P_HIP_T)
    for side_name, sign in (("L", 1.0), ("R", -1.0)):
        ft = feet[side_name]
        s_ref = dot(ft, axis)
        sel = [q for q in cloud.pts if abs(dot(q, axis) - s_ref) < 0.1 * total and q[2] < ground + 0.3 * cloud.h]
        lat = _lateral(sel, sign, mid_l, left, max(body_w * 0.5, 0.02 * total))
        g = add(ft, mul(left, (mid_l + sign * lat) - dot(ft, left)))
        top = add(hips, mul(left, sign * lat * 0.9))
        top = (top[0], top[1], lerp(hips, g, 0.35)[2])
        knee = add(lerp(top, g, 0.55), mul(axis, -0.03 * total))
        n = f"leg_H{side_name}_"
        p.add(n + "1", top, knee, "hips")
        p.add(n + "2", knee, g, n + "1")
        p.add(f"leg_H{side_name}_toe", g, add(g, mul(axis, 0.05 * total)), n + "2")
    # ---- wings (wing_L_n / wing_R_n, fluttered by the rig map's idle motion)
    tips = {"R": taps.get("wingTipR"), "L": taps.get("wingTipL")}
    if tips["L"] is None:
        tips["L"] = tips["R"]
    if tips["R"] is None:
        tips["R"] = tips["L"]
    chest = at(0.56)
    for side_name, sign in (("L", 1.0), ("R", -1.0)):
        tp = tips[side_name]
        if tp is None:
            # a pair of short wings on the sides of the chest
            tp = add(add(chest, mul(axis, -0.18 * total)), mul(left, sign * body_w * 1.1))
            notes.append("No wing tapped: short wings were added.")
        s_ref = dot(tp, axis)
        sel = [q for q in cloud.pts if abs(dot(q, axis) - s_ref) < 0.12 * total and abs(q[2] - tp[2]) < 0.12 * cloud.h]
        lat = _lateral(sel, sign, mid_l, left, body_w * 1.1, extreme=True)
        tip = add(tp, mul(left, (mid_l + sign * lat) - dot(tp, left)))
        root = add(chest, mul(left, sign * body_w * 0.6))
        mid = lerp(root, tip, 0.45)
        wrist = lerp(root, tip, 0.8)
        n = f"wing_{side_name}_"
        p.add(n + "1", root, mid, "chest")
        p.add(n + "2", mid, wrist, n + "1")
        p.add(n + "3", wrist, tip, n + "2")


P_HIP_T = 0.4   # where the legs of a bird hang from, along tail tip (0) .. beak (1)


# ---------------------------------------------------------------- OBJECT

O_DEFAULT_BEND_START = 0.25   # when "where it starts to bend" is skipped (fraction of still..tip)
O_SPRING_FROM = 0.78          # the loose end: springs cover this fraction .. 1
O_SPRING_BONES = 3


def plan_object(cloud, taps):
    """Things: a root that holds still, a bend chain along the axis from objStill to objBendEnd, springs on the loose end."""
    still, end = taps.get("objStill"), taps.get("objBendEnd")
    if still is None or end is None:
        raise PlanError("Tap the part that stays put and the tip that sways.")
    if dist(still, end) < 0.1 * cloud.h:
        raise PlanError("The part that stays put and the tip are almost on the same spot.")
    n = 24
    line = centerline(cloud, still, end, n)
    at = lambda t: sample(line, t)              # noqa: E731
    bend = taps.get("objBendStart")
    ub = O_DEFAULT_BEND_START
    if bend is not None:
        d = sub(end, still)
        ub = min(0.6, max(0.08, dot(sub(bend, still), d) / max(dot(d, d), 1e-12)))
    p = Plan("object", [], {"axis": norm(sub(end, still)), "bendStart": ub})
    # the bend chain: spine, chest, neck, head between ub and the spring zone
    u = [ub + (O_SPRING_FROM - ub) * k for k in (0.0, 0.34, 0.67, 1.0)]
    p.add("hips", still, at(ub), None)
    p.add("spine", at(u[0]), at(u[1]), "hips")
    p.add("chest", at(u[1]), at(u[2]), "spine")
    p.add("neck", at(u[2]), at(u[3]), "chest")
    head_tail = at(O_SPRING_FROM + (1.0 - O_SPRING_FROM) * 0.05)
    p.add("head", at(u[3]), head_tail, "neck")
    fr = [O_SPRING_FROM + (1.0 - O_SPRING_FROM) * 0.05 + (1.0 - O_SPRING_FROM - (1.0 - O_SPRING_FROM) * 0.05) * i / O_SPRING_BONES for i in range(O_SPRING_BONES + 1)]
    chain_along(p, "chain_", "head", at, O_SPRING_BONES, fr)
    validate_plan(p)
    return p


# ---------------------------------------------------------------- HUMANOID (VRM names)

H_BLEND = 0.05


def plan_humanoid(cloud, soft, taps=None):
    """The person template. Same bones and numbers as the original autorig (joints found on the picture first, else the
    height-slice plan), plus the taps: chin, elbows, knees, ankles, shoulders and hands replace the guesses where they exist.
    taps are [u,v,w] over the glTF box. Returns a Plan with info {"arms": [...], "legs": [...]}."""
    taps = taps or {}
    soft = soft or {}
    joints = soft.get("joints") or {}
    planned = _humanoid_from_joints(cloud, joints, taps) if joints else None
    return planned or _humanoid_from_heights(cloud, soft, taps)


def _tap(cloud, taps, *names):
    for n in names:
        v = taps.get(n)
        if isinstance(v, (list, tuple)) and len(v) == 3:
            return cloud.from_uvw(v)
    return None


def _humanoid_from_joints(cloud, joints, taps):
    """Bones from joints found on the model itself (soft['joints']): None when the torso joints are missing."""
    J = {k: cloud.from_uvw(v) for k, v in joints.items() if isinstance(v, (list, tuple)) and len(v) == 3}
    if not all(k in J for k in ("hips", "chest", "neck", "head")):
        return None
    spine = J.get("spine") or lerp(J["hips"], J["chest"], 0.5)
    top = J.get("headTop") or (J["head"][0], J["head"][1], cloud.hi[2])
    head = J["head"]
    notes = []
    chin = _tap(cloud, taps, "chin")
    if chin:
        z = min(max(chin[2], J["neck"][2] + 0.01 * cloud.h), top[2] - 0.02 * cloud.h)
        head = (head[0], head[1], z)
        notes.append("Head placed at the chin.")
    p = Plan("humanoid", [], {"arms": [], "legs": []}, notes)
    p.add("hips", J["hips"], spine, None)
    p.add("spine", spine, J["chest"], "hips")
    p.add("chest", J["chest"], J["neck"], "spine")
    p.add("neck", J["neck"], head, "chest")
    p.add("head", head, top, "neck")
    for side in ("left", "right"):
        a = _tap(cloud, taps, f"{side}Shoulder") or J.get(f"{side}UpperArm")
        b = _tap(cloud, taps, f"{side}Elbow") or J.get(f"{side}LowerArm")
        c = _tap(cloud, taps, f"{side}Hand") or J.get(f"{side}Hand")
        if a and b and c and dist(c, a) > cloud.h * 0.03:
            p.add(f"{side}UpperArm", a, b, "chest")
            p.add(f"{side}LowerArm", b, c, f"{side}UpperArm")
            p.add(f"{side}Hand", c, add(c, mul(sub(c, b), 0.35)), f"{side}LowerArm")
            p.info["arms"].append(side)
        a = J.get(f"{side}UpperLeg")
        b = _tap(cloud, taps, f"{side}Knee") or J.get(f"{side}LowerLeg")
        c = _tap(cloud, taps, f"{side}Ankle") or J.get(f"{side}Foot")
        if a and b and c and dist(a, c) > cloud.h * 0.08:
            toe = add(c, (0.0, -cloud.h * 0.07, 0.0))
            toe = (toe[0], toe[1], max(cloud.lo[2], c[2] - cloud.h * 0.02))
            p.add(f"{side}UpperLeg", a, b, "hips")
            p.add(f"{side}LowerLeg", b, c, f"{side}UpperLeg")
            p.add(f"{side}Foot", c, toe, f"{side}LowerLeg")
            p.info["legs"].append(side)
    return p


def _humanoid_from_heights(cloud, soft, taps):
    tol = max(float(soft.get("blend") or H_BLEND) * cloud.h * 0.5, cloud.h * 0.02)
    hips_t = float(soft.get("hips", 0.5))
    chest_t = float(soft.get("chest", 0.65))
    neck_t = float(soft.get("neck", 0.8))
    # keep the torso chain ordered even if the client sent odd values
    hips_t = min(max(hips_t, 0.02), 0.9)
    chest_t = min(max(chest_t, hips_t + 0.02), 0.95)
    neck_t = min(max(neck_t, chest_t + 0.02), 0.98)

    def axis_point(t):
        c, _ = cloud.slice_centroid(cloud.z(t), tol)
        return c if c else (cloud.center[0], cloud.center[1], cloud.z(t))

    hips = axis_point(hips_t)
    chest = axis_point(chest_t)
    neck = axis_point(neck_t)
    spine = axis_point((hips_t + chest_t) / 2)
    top = (neck[0], neck[1], cloud.hi[2])
    head = lerp(neck, top, 0.18)
    notes = []
    chin = _tap(cloud, taps, "chin")
    if chin:
        z = min(max(chin[2], neck[2] + 0.01 * cloud.h), top[2] - 0.02 * cloud.h)
        head = (neck[0], neck[1], z)
        notes.append("Head placed at the chin.")
    p = Plan("humanoid", [], {"arms": [], "legs": []}, notes)
    p.add("hips", hips, spine, None)
    p.add("spine", spine, chest, "hips")
    p.add("chest", chest, neck, "spine")
    p.add("neck", neck, head, "chest")
    p.add("head", head, top, "neck")

    # ---- arms (only when the client found shoulders + hands)
    for side in ("left", "right"):
        S = _tap(cloud, taps, f"{side}Shoulder")
        H = _tap(cloud, taps, f"{side}Hand")
        if S is None or H is None:
            s, h = soft.get(f"{side}Shoulder"), soft.get(f"{side}Hand")
            if not s or not h:
                continue
            S, H = cloud.from_uvw(s), cloud.from_uvw(h)
        span = sub(H, S)
        if length(span) < cloud.h * 0.03:
            continue
        elbow = _tap(cloud, taps, f"{side}Elbow") or add(lerp(S, H, 0.5), (0.0, length(span) * 0.03, 0.0))  # slight backward bend hint
        hand_tail = add(H, mul(norm(span), length(span) * 0.22))
        p.add(f"{side}UpperArm", S, elbow, "chest")
        p.add(f"{side}LowerArm", elbow, H, f"{side}UpperArm")
        p.add(f"{side}Hand", H, hand_tail, f"{side}LowerArm")
        p.info["arms"].append(side)

    # ---- legs: split the geometry below the hips at the hips centroid x
    leg_len = hips[2] - cloud.lo[2]
    if leg_len > cloud.h * 0.12:
        cx = hips[0]
        half_w = max(cloud.hi[0] - cx, cx - cloud.lo[0])
        for side, (xmin, xmax), sign in (("left", (cx, None), 1), ("right", (None, cx), -1)):
            knee_z = cloud.lo[2] + leg_len * 0.5
            foot_z = cloud.lo[2] + leg_len * 0.1
            top_z = hips[2] - leg_len * 0.1
            knee = _tap(cloud, taps, f"{side}Knee")
            n_knee = 99
            if knee is None:
                knee, n_knee = cloud.slice_centroid(knee_z, tol, xmin, xmax)
            foot = _tap(cloud, taps, f"{side}Ankle")
            if foot is None:
                foot, _ = cloud.slice_centroid(foot_z, tol, xmin, xmax)
            if knee is None or n_knee < 8:
                continue  # no distinct leg geometry on this side (blob / dress)
            if foot is None:
                foot = (knee[0], knee[1], foot_z)
            upper, _ = cloud.slice_centroid(top_z, tol, xmin, xmax)
            if upper is None:
                upper = (cx + sign * half_w * 0.2, hips[1], top_z)
            toe = (foot[0], foot[1] - leg_len * 0.15, max(cloud.lo[2], foot[2] - leg_len * 0.05))
            p.add(f"{side}UpperLeg", upper, knee, "hips")
            p.add(f"{side}LowerLeg", knee, foot, f"{side}UpperLeg")
            p.add(f"{side}Foot", foot, toe, f"{side}LowerLeg")
            p.info["legs"].append(side)
    return p


# ---------------------------------------------------------------- entry point

def plan(template, cloud, soft=None, taps_uvw=None, body_type=None):
    """template: humanoid | quadruped | creature | object. taps_uvw: tap id -> [u, v, w] over the glTF box."""
    taps_uvw = taps_uvw or {}
    if template == "humanoid":
        # humanoid keeps taps in uvw: plan_humanoid maps them itself through Cloud.from_uvw
        return plan_humanoid(cloud, soft, taps_uvw)
    taps = {k: cloud.from_uvw(v) for k, v in taps_uvw.items()}
    if template == "quadruped":
        return plan_quadruped(cloud, taps)
    if template == "creature":
        return plan_creature(cloud, taps, body_type or "tail")
    if template == "object":
        return plan_object(cloud, taps)
    raise PlanError(f"Unknown rig template {template!r}")
