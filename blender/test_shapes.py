"""Procedural test bodies for the 3D auto-rig, built from capsules. Pure Python (no bpy): blender/test_rigplan.py samples the
vertices as a point cloud, blender/test_autorig_blender.py builds real meshes from the same specs.

Space: Blender world, metres, +Z up, the body faces -Y (a glTF model facing +Z). Every shape has `parts` (capsules:
(a, b, radius)) and `taps` (world points a person would tap).
"""
import math


def capsule_mesh(a, b, r, seg=12, rings=4):
    """(verts, faces) of a capsule from a to b: a tube with hemispherical caps, quads and tris, outward normals."""
    ax = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    L = math.sqrt(sum(c * c for c in ax))
    if L < 1e-9:
        raise ValueError("zero-length capsule")
    d = tuple(c / L for c in ax)
    t = (1.0, 0.0, 0.0) if abs(d[0]) < 0.9 else (0.0, 1.0, 0.0)
    u = (d[1] * t[2] - d[2] * t[1], d[2] * t[0] - d[0] * t[2], d[0] * t[1] - d[1] * t[0])
    un = math.sqrt(sum(c * c for c in u))
    u = tuple(c / un for c in u)
    v = (d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0])
    verts, rows = [], []
    # south pole, rings of the lower hemisphere, the tube, the upper hemisphere, north pole
    levels = []
    for i in range(1, rings + 1):                       # lower cap: angle from -90deg up to 0 (exclusive of the pole)
        ang = -math.pi / 2 + (math.pi / 2) * i / rings
        levels.append((a, math.cos(ang) * r, math.sin(ang) * r))
    n_tube = max(1, int(math.ceil(L / 0.04)))           # rings along the tube so slices find vertices
    for i in range(1, n_tube):
        t = i / n_tube
        levels.append(((a[0] + ax[0] * t, a[1] + ax[1] * t, a[2] + ax[2] * t), r, 0.0))
    for i in range(0, rings):                           # upper cap: 0 .. +90deg (exclusive)
        ang = (math.pi / 2) * i / rings
        levels.append((b, math.cos(ang) * r, math.sin(ang) * r))
    south = (a[0] - d[0] * r, a[1] - d[1] * r, a[2] - d[2] * r)
    north = (b[0] + d[0] * r, b[1] + d[1] * r, b[2] + d[2] * r)
    verts.append(south)
    for base, rad, off in levels:
        row = []
        for k in range(seg):
            th = 2 * math.pi * k / seg
            cx, cy = math.cos(th) * rad, math.sin(th) * rad
            verts.append((base[0] + u[0] * cx + v[0] * cy + d[0] * off,
                          base[1] + u[1] * cx + v[1] * cy + d[1] * off,
                          base[2] + u[2] * cx + v[2] * cy + d[2] * off))
            row.append(len(verts) - 1)
        rows.append(row)
    verts.append(north)
    n_idx = len(verts) - 1
    faces = []
    for k in range(seg):
        faces.append((0, rows[0][(k + 1) % seg], rows[0][k]))
    for i in range(len(rows) - 1):
        for k in range(seg):
            k2 = (k + 1) % seg
            faces.append((rows[i][k], rows[i][k2], rows[i + 1][k2], rows[i + 1][k]))
    for k in range(seg):
        faces.append((rows[-1][k], rows[-1][(k + 1) % seg], n_idx))
    return verts, faces


def mesh_of(parts, seg=12, rings=4):
    """One merged (verts, faces) for a list of capsules (separate shells, like a model made of parts)."""
    V, F = [], []
    for a, b, r in parts:
        vs, fs = capsule_mesh(a, b, r, seg, rings)
        o = len(V)
        V += vs
        F += [tuple(i + o for i in f) for f in fs]
    return V, F


def quadruped():
    parts = [
        ((0.0, 0.45, 0.75), (0.0, -0.45, 0.75), 0.22),     # trunk
        ((0.0, -0.45, 0.80), (0.0, -0.72, 1.15), 0.10),    # neck
        ((0.0, -0.72, 1.15), (0.0, -0.95, 1.12), 0.09),    # head
        ((0.0, 0.50, 0.80), (0.0, 0.85, 0.66), 0.04),      # tail
    ]
    for x in (0.14, -0.14):
        parts.append(((x, -0.35, 0.68), (x, -0.35, 0.06), 0.055))   # front legs
        parts.append(((x, 0.38, 0.68), (x, 0.38, 0.06), 0.055))     # hind legs
    taps = {
        "nose": (0.0, -1.04, 1.12), "tailRoot": (0.0, 0.62, 0.78), "tailTip": (0.0, 0.88, 0.65),
        "pawFR": (-0.14, -0.35, 0.0), "pawHR": (-0.14, 0.38, 0.0), "pawFL": (0.14, -0.35, 0.0), "pawHL": (0.14, 0.38, 0.0),
    }
    return {"name": "quadruped", "template": "quadruped", "parts": parts, "taps": taps}


def lamp():
    parts = [
        ((0.0, 0.0, 0.03), (0.0, 0.0, 0.05), 0.15),        # base
        ((0.0, 0.0, 0.05), (0.05, 0.0, 0.60), 0.025),      # stem
        ((0.05, 0.0, 0.60), (0.30, 0.0, 0.75), 0.025),     # arm
        ((0.30, 0.0, 0.75), (0.40, 0.0, 0.70), 0.12),      # shade
    ]
    taps = {"objStill": (0.0, 0.0, 0.04), "objBendStart": (0.04, 0.0, 0.45), "objBendEnd": (0.42, 0.0, 0.70)}
    return {"name": "lamp", "template": "object", "parts": parts, "taps": taps}


def bird():
    parts = [
        ((0.0, 0.15, 0.50), (0.0, -0.15, 0.55), 0.13),     # body
        ((0.0, -0.15, 0.58), (0.0, -0.22, 0.75), 0.06),    # neck
        ((0.0, -0.22, 0.75), (0.0, -0.30, 0.75), 0.06),    # head
        ((0.0, -0.30, 0.75), (0.0, -0.38, 0.73), 0.02),    # beak
        ((0.0, 0.15, 0.50), (0.0, 0.50, 0.42), 0.04),      # tail
    ]
    for x in (0.06, -0.06):
        parts.append(((x, 0.0, 0.40), (x, 0.0, 0.03), 0.02))      # legs
    for x in (0.13, -0.13):
        sx = 1.0 if x > 0 else -1.0
        parts.append(((x, -0.05, 0.60), (sx * 0.38, 0.15, 0.50), 0.03))   # wings
    taps = {"nose": (0.0, -0.40, 0.73), "tailTip": (0.0, 0.54, 0.40), "wingTipR": (-0.40, 0.15, 0.50), "footR": (-0.06, 0.0, 0.01)}
    return {"name": "bird", "template": "creature", "bodyType": "bird", "parts": parts, "taps": taps}


def snake():
    pts = [(0.0, -0.80, 0.08), (0.12, -0.55, 0.08), (-0.12, -0.25, 0.08), (0.12, 0.05, 0.08), (-0.12, 0.35, 0.08), (0.0, 0.65, 0.08), (0.0, 0.95, 0.05)]
    parts = [(pts[i], pts[i + 1], 0.06 - 0.007 * i) for i in range(len(pts) - 1)]
    taps = {"nose": (0.0, -0.88, 0.08), "tailTip": (0.0, 1.0, 0.05)}
    return {"name": "snake", "template": "creature", "bodyType": "tail", "parts": parts, "taps": taps}


def person():
    parts = [
        ((0.0, 0.0, 0.95), (0.0, 0.0, 1.35), 0.16),       # torso
        ((0.0, 0.0, 1.45), (0.0, 0.0, 1.58), 0.10),       # head
        ((0.0, 0.0, 1.35), (0.0, 0.0, 1.45), 0.05),       # neck
    ]
    for x in (0.10, -0.10):
        parts.append(((x, 0.0, 0.92), (x, 0.0, 0.07), 0.07))      # legs
    for sx in (1.0, -1.0):
        parts.append(((sx * 0.20, 0.0, 1.30), (sx * 0.70, 0.0, 1.30), 0.05))   # arms out (a T)
    taps = {
        "chin": (0.0, -0.05, 1.46),
        "leftShoulder": (0.20, 0.0, 1.30), "leftElbow": (0.45, 0.0, 1.30), "leftHand": (0.70, 0.0, 1.30),
        "rightShoulder": (-0.20, 0.0, 1.30), "rightElbow": (-0.45, 0.0, 1.30), "rightHand": (-0.70, 0.0, 1.30),
        "leftKnee": (0.10, 0.0, 0.50), "leftAnkle": (0.10, 0.0, 0.12), "rightKnee": (-0.10, 0.0, 0.50), "rightAnkle": (-0.10, 0.0, 0.12),
    }
    return {"name": "person", "template": "humanoid", "parts": parts, "taps": taps}


ALL = {"quadruped": quadruped, "lamp": lamp, "bird": bird, "snake": snake, "person": person}
