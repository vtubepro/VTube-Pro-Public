"""Plain-Python check of blender/weight_transfer.py on a synthetic figure (no Blender, no numpy, no model):

    python -I blender/test_weight_transfer.py

A "T figure" made of three separate tubes: a torso (bone `spine`, along Z), a left arm (+X) and a right arm (-X). The PROXY is a coarse
copy (4 rings x 6 sides), the FULL mesh a fine one (13 rings x 12 sides) on the same surfaces. The proxy's weights ramp along each arm
(`spine` at the shoulder, the arm bone at the hand). Transferring them to the full mesh must give: weights that sum to 1, no vertex
left unweighted, at most 4 bones each, a limb's weights staying on that limb (the other arm's bone is never used), values close
to the true ramp, and the proxy's own weights back at the proxy's own vertices.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import weight_transfer as wt  # noqa: E402

FAILED = 0


def ok(cond, msg):
    global FAILED
    print(("PASS  " if cond else "FAIL  ") + msg)
    if not cond:
        FAILED += 1


def tube(origin, axis, length, radius, rings, sides):
    """Open-ended tube along `axis` ('x' / '-x' / 'z'): (verts, faces, t per vertex in 0..1 along the length)."""
    verts, ts = [], []
    for r in range(rings):
        t = r / (rings - 1)
        for s in range(sides):
            a = 2 * math.pi * s / sides
            u, v = radius * math.cos(a), radius * math.sin(a)
            if axis == "x":
                p = (origin[0] + t * length, origin[1] + u, origin[2] + v)
            elif axis == "-x":
                p = (origin[0] - t * length, origin[1] + u, origin[2] + v)
            else:
                p = (origin[0] + u, origin[1] + v, origin[2] + t * length)
            verts.append(p)
            ts.append(t)
    faces = []
    for r in range(rings - 1):
        for s in range(sides):
            a, b = r * sides + s, r * sides + (s + 1) % sides
            c, d = (r + 1) * sides + s, (r + 1) * sides + (s + 1) % sides
            faces += [(a, b, d), (a, d, c)]
    return verts, faces, ts


def figure(rings, sides):
    """Whole figure: verts, faces, per-vertex (limb, t) tags."""
    parts = [("spine", tube((0, 0, 0), "z", 1.0, 0.18, rings, sides)),
             ("armL", tube((0.3, 0, 0.8), "x", 0.8, 0.06, rings, sides)),
             ("armR", tube((-0.3, 0, 0.8), "-x", 0.8, 0.06, rings, sides))]
    verts, faces, tags = [], [], []
    for limb, (v, f, ts) in parts:
        base = len(verts)
        verts += v
        faces += [(base + a, base + b, base + c) for a, b, c in f]
        tags += [(limb, t) for t in ts]
    return verts, faces, tags


def ramp(limb, t):
    """The true weights: the arm bone grows from 0 at the shoulder to 1 at the hand, `spine` takes the rest."""
    if limb == "spine":
        return {"spine": 1.0}
    return {limb: t, "spine": 1.0 - t}


def sparse(d):
    return {k: v for k, v in d.items() if v > 0}


pv, pf, ptags = figure(4, 6)
fv, ff, ftags = figure(13, 12)
pw = [sparse(ramp(*t)) for t in ptags]

locate_hits = wt.nearest_on_mesh(fv, pv, pf)
it = iter(locate_hits)
W, stats = wt.transfer_weights(fv, lambda p: next(it), pf, pw, pv)

try:
    wt.check(W)
    good = True
except AssertionError as e:
    print("   ", e)
    good = False
ok(good and len(W) == len(fv), f"{len(W)} full-resolution vertices: every one weighted, sums to 1, at most 4 bones, none negative")
ok(all(abs(sum(w.values()) - 1) < 1e-9 for w in W) and not any(not w for w in W), "no vertex left unweighted, sums are exact to 1e-9")

# a limb's weights stay on that limb
left_idx = [i for i, (l, _) in enumerate(ftags) if l == "armL"]
right_idx = [i for i, (l, _) in enumerate(ftags) if l == "armR"]
spine_idx = [i for i, (l, _) in enumerate(ftags) if l == "spine"]
ok(all("armR" not in W[i] for i in left_idx) and all("armL" not in W[i] for i in right_idx), "the left arm never uses the right arm's bone and vice versa")
ok(all(set(W[i]) == {"spine"} for i in spine_idx), "the torso keeps only the spine bone")
tip = [i for i in left_idx if ftags[i][1] > 0.95]
ok(tip and all(W[i].get("armL", 0) > 0.8 for i in tip), "the left hand tip is almost entirely the arm bone")
root = [i for i in right_idx if ftags[i][1] < 0.05]
ok(root and all(W[i].get("spine", 0) > 0.85 for i in root), "the right shoulder end is almost entirely the spine bone")

# close to the true ramp
worst = 0.0
for i, (limb, t) in enumerate(ftags):
    truth = ramp(limb, t)
    for bone in set(truth) | set(W[i]):
        worst = max(worst, abs(W[i].get(bone, 0.0) - truth.get(bone, 0.0)))
ok(worst < 0.2, f"weights follow the true ramp (largest error {worst:.3f})")

# the proxy's own vertices keep their weights
same = wt.nearest_on_mesh(pv, pv, pf)
it2 = iter(same)
Wp, _ = wt.transfer_weights(pv, lambda p: next(it2), pf, pw, pv)
err = max(abs(Wp[i].get(b, 0) - pw[i].get(b, 0)) for i in range(len(pv)) for b in set(Wp[i]) | set(pw[i]))
ok(err < 1e-9, "a full-mesh vertex that sits on a proxy vertex gets exactly that vertex's weights")

# more than 4 bones on the proxy: the strongest 4 are kept and renormalised
many = [{"a": 0.30, "b": 0.25, "c": 0.20, "d": 0.15, "e": 0.10} for _ in pv]
itm = iter(wt.nearest_on_mesh(fv, pv, pf))
Wm, _ = wt.transfer_weights(fv, lambda p: next(itm), pf, many, pv)
ok(all(set(w) == {"a", "b", "c", "d"} and abs(sum(w.values()) - 1) < 1e-9 for w in Wm), "five influences become the strongest four, renormalised")
ok(abs(Wm[0]["a"] - 0.30 / 0.90) < 1e-9, "the renormalised value is right (0.30 / 0.90)")

# an unskinned piece of the proxy: its full-mesh vertices still get weights (nearest skinned proxy vertex)
holes = [dict(w) for w in pw]
for i, (limb, _) in enumerate(ptags):
    if limb == "armR":
        holes[i] = {}
ith = iter(wt.nearest_on_mesh(fv, pv, pf))
Wh, st = wt.transfer_weights(fv, lambda p: next(ith), pf, holes, pv)
ok(wt.check(Wh) and st["filled_from_nearest_vertex"] >= len(right_idx), f"an unskinned proxy piece: {st['filled_from_nearest_vertex']} vertices filled from the nearest skinned vertex, none left empty")

# a point far from the surface still gets the weights of its nearest point
far = (10.0, 0.0, 0.8)
tri, bary = wt.nearest_on_mesh([far], pv, pf)[0]
Wf, _ = wt.transfer_weights([far], lambda p: (tri, bary), pf, pw, pv)
ok(wt.check(Wf) and "armL" in Wf[0], "a point far outside the mesh takes the weights of the closest part (the left hand)")

# nothing to transfer
try:
    wt.transfer_weights([far], lambda p: (0, (1, 0, 0)), pf, [{} for _ in pv], pv)
    ok(False, "a proxy with no weights is refused")
except ValueError:
    ok(True, "a proxy with no weights at all is refused with a clear error")

print("\nweight_transfer: all checks passed" if not FAILED else f"\nweight_transfer: {FAILED} FAILED")
sys.exit(1 if FAILED else 0)
