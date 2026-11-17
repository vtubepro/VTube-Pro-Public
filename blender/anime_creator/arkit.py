"""
ARKit "perfect sync" shape keys for VRoid faces, derived from the VRoid Fcl_* morphs (split left /
right where ARKit wants sides) plus a few geometric ones VRoid lacks (tongue out, cheek puff, mouth
left/right, jaw side).  Appended to the Face mesh, so the VRoid presets keep working untouched and
the app's ExpressionDriver switches to perfect sync (>= 10 ARKit morphs found).

Recipes are linear combinations: {arkit_name: [(fcl_short_name, weight, side), ...]} where side is
'L' (character left = -X), 'R' or None (both).  `mouth` style tweaks (e.g. a wide shark grin) scale
the mouth deltas sideways.
"""
from __future__ import annotations

import numpy as np

from .vroid import MeshData

# (fcl, weight, side)
RECIPES: dict[str, list[tuple[str, float, str | None]]] = {
    'eyeBlinkLeft': [('Fcl_EYE_Close_L', 1.0, None)],
    'eyeBlinkRight': [('Fcl_EYE_Close_R', 1.0, None)],
    'eyeSquintLeft': [('Fcl_EYE_Joy_L', 0.32, None)],
    'eyeSquintRight': [('Fcl_EYE_Joy_R', 0.32, None)],
    'eyeWideLeft': [('Fcl_EYE_Surprised', 1.0, 'L')],
    'eyeWideRight': [('Fcl_EYE_Surprised', 1.0, 'R')],
    'cheekSquintLeft': [('Fcl_EYE_Joy_L', 0.3, None)],
    'cheekSquintRight': [('Fcl_EYE_Joy_R', 0.3, None)],
    'browDownLeft': [('Fcl_BRW_Angry', 1.0, 'L'), ('Fcl_EYE_Angry', 0.7, 'L')],
    'browDownRight': [('Fcl_BRW_Angry', 1.0, 'R'), ('Fcl_EYE_Angry', 0.7, 'R')],
    'browInnerUp': [('Fcl_BRW_Sorrow', 1.0, None), ('Fcl_EYE_Sorrow', 0.45, None)],
    'browOuterUpLeft': [('Fcl_BRW_Surprised', 1.0, 'L')],
    'browOuterUpRight': [('Fcl_BRW_Surprised', 1.0, 'R')],
    'jawOpen': [('Fcl_MTH_A', 1.0, None)],
    'mouthFunnel': [('Fcl_MTH_O', 1.0, None), ('Fcl_MTH_A', -0.55, None)],
    'mouthPucker': [('Fcl_MTH_U', 1.0, None)],
    'mouthSmileLeft': [('Fcl_MTH_Fun', 1.0, 'L')],
    'mouthSmileRight': [('Fcl_MTH_Fun', 1.0, 'R')],
    'mouthFrownLeft': [('Fcl_MTH_Sorrow', 1.0, 'L'), ('Fcl_MTH_Angry', 0.12, 'L')],
    'mouthFrownRight': [('Fcl_MTH_Sorrow', 1.0, 'R'), ('Fcl_MTH_Angry', 0.12, 'R')],
    'mouthStretchLeft': [('Fcl_MTH_I', 0.9, 'L')],
    'mouthStretchRight': [('Fcl_MTH_I', 0.9, 'R')],
    'mouthPressLeft': [('Fcl_MTH_Close', 1.0, 'L')],
    'mouthPressRight': [('Fcl_MTH_Close', 1.0, 'R')],
    'mouthRollUpper': [('Fcl_MTH_Close', 0.5, None)],
    'mouthRollLower': [('Fcl_MTH_Close', 0.5, None)],
    'mouthClose': [('Fcl_MTH_Close', 0.6, None)],
    'mouthUpperUpLeft': [('Fcl_MTH_E', 0.35, 'L')],
    'mouthUpperUpRight': [('Fcl_MTH_E', 0.35, 'R')],
    'mouthLowerDownLeft': [('Fcl_MTH_E', 0.35, 'L')],
    'mouthLowerDownRight': [('Fcl_MTH_E', 0.35, 'R')],
    'mouthDimpleLeft': [('Fcl_MTH_Fun', 0.25, 'L')],
    'mouthDimpleRight': [('Fcl_MTH_Fun', 0.25, 'R')],
    'mouthShrugUpper': [('Fcl_MTH_Up', 0.4, None)],
    'mouthShrugLower': [('Fcl_MTH_Down', 0.4, None)],
    'noseSneerLeft': [('Fcl_BRW_Angry', 0.15, 'L')],
    'noseSneerRight': [('Fcl_BRW_Angry', 0.15, 'R')],
}
# some VRoid versions name the closed / neutral mouth differently
ALIASES = {'Fcl_MTH_Close': ['Fcl_MTH_Close', 'Fcl_MTH_Neutral', 'Fcl_MTH_Natural'],
           'Fcl_EYE_Close_L': ['Fcl_EYE_Close_L'], 'Fcl_EYE_Close_R': ['Fcl_EYE_Close_R']}


def side_mask(P: np.ndarray, side: str | None, blend: float = 0.006) -> np.ndarray:
    if side is None:
        return np.ones(len(P))
    x = P[:, 0] / blend
    t = np.clip(0.5 - 0.5 * x, 0, 1) if side == 'L' else np.clip(0.5 + 0.5 * x, 0, 1)
    return t * t * (3 - 2 * t)


def _morph(d: MeshData, short: str):
    for nm in ALIASES.get(short, [short]):
        i = d.morph(nm)
        if i is not None:
            return i
    return None


def mouth_center(d: MeshData, mouth_verts: np.ndarray) -> np.ndarray:
    return d.P[mouth_verts].mean(0)


def add_arkit(d: MeshData, mouth_prim: int, tongue_verts: np.ndarray, opts: dict | None = None) -> list[str]:
    """Append ARKit targets to d (in place). Returns the names added."""
    opts = opts or {}
    have_normals = bool(d.targets) and 'NORMAL' in d.targets[0]
    added = []
    existing = {nm for nm in d.target_names}
    grin_w = float(opts.get('grinWidth', 1.0))       # >1 widens smile corners sideways (shark grin)
    jaw_gain = float(opts.get('jawOpen', 1.0))
    mv = d.verts_of(mouth_prim)
    mc = mouth_center(d, mv)

    def push(name, dP, dN=None):
        if name in existing:
            return
        t = {'POSITION': dP}
        if have_normals:
            t['NORMAL'] = dN if dN is not None else np.zeros_like(dP)
        d.targets.append(t); d.target_names.append(name); added.append(name)

    for name, parts in RECIPES.items():
        dP = np.zeros_like(d.P); dN = np.zeros_like(d.P); ok = False
        for fcl, w, side in parts:
            i = _morph(d, fcl)
            if i is None:
                continue
            ok = True
            m = side_mask(d.P, side)[:, None]
            dP += w * m * d.targets[i]['POSITION']
            if have_normals and 'NORMAL' in d.targets[i]:
                dN += w * m * d.targets[i]['NORMAL']
        if not ok:
            dP[:] = 0
        if name.startswith('mouthSmile') and grin_w != 1.0:
            # widen: push the smile's corner motion further outward in x around the mouth centre
            rel = d.P[:, 0] - mc[0]
            near = np.exp(-((d.P[:, 1] - mc[1]) ** 2) / (2 * 0.02 ** 2)) * (np.abs(d.P[:, 2] - mc[2]) < 0.04)
            dP[:, 0] += (grin_w - 1.0) * 0.45 * rel * near * (np.linalg.norm(dP, axis=1) > 1e-6)
            dP[:, 1] *= 1 + (grin_w - 1.0) * 0.5
        if name == 'jawOpen':
            dP *= jaw_gain; dN *= jaw_gain
        push(name, dP, dN)

    # ---------------- geometric shapes ----------------
    P = d.P
    rel = P - mc
    # face-front vertices around the mouth (skin + mouth parts), gaussian falloff
    r_mouth = np.linalg.norm(rel * np.array([1.0, 1.3, 1.0]), axis=1)
    fall = np.exp(-(r_mouth ** 2) / (2 * 0.022 ** 2)) * (P[:, 2] < mc[2] + 0.03)
    for name, sx in (('mouthLeft', -1), ('mouthRight', 1)):
        dP = np.zeros_like(P); dP[:, 0] = sx * 0.009 * fall
        push(name, dP)
    # jaw side: lower face below the mouth shifts
    below = np.clip((mc[1] + 0.004 - P[:, 1]) / 0.02, 0, 1) * np.exp(-(rel[:, 0] ** 2) / (2 * 0.05 ** 2)) \
        * (P[:, 1] > mc[1] - 0.08) * (P[:, 2] < mc[2] + 0.05)
    for name, sx in (('jawLeft', -1), ('jawRight', 1)):
        dP = np.zeros_like(P); dP[:, 0] = sx * 0.008 * below
        push(name, dP)
    jf = _morph(d, 'Fcl_MTH_A')
    push('jawForward', np.zeros_like(P))
    # cheek puff: skin inflates outward on both cheeks
    cheek = np.zeros(len(P))
    for sx in (-1, 1):
        c = mc + np.array([sx * 0.035, 0.012, 0.012])
        cheek += np.exp(-np.sum(((P - c) / np.array([0.022, 0.02, 0.03])) ** 2, 1))
    front = (P[:, 2] < mc[2] + 0.04)
    dP = np.zeros_like(P)
    dP[:, 0] = np.sign(rel[:, 0]) * 0.006 * cheek * front
    dP[:, 2] = -0.004 * cheek * front
    push('cheekPuff', dP)
    # tongue out: tongue vertices slide forward + down out of the open mouth (flat anime tongue)
    dP = np.zeros_like(P)
    if len(tongue_verts):
        tv = tongue_verts
        tp = P[tv]
        back = tp[:, 2].max()   # tongue root (deepest, +Z)
        front_z = tp[:, 2].min()
        depth = np.clip((back - tp[:, 2]) / max(back - front_z, 1e-4), 0, 1)  # 0 root .. 1 tip
        dP[tv, 2] = -(0.010 + 0.014 * depth)
        dP[tv, 1] = -(0.003 + 0.009 * depth)
        # the jaw opens with it a little (flat tongue sits on the lower lip)
        if jf is not None:
            dP += 0.25 * d.targets[jf]['POSITION']
    push('tongueOut', dP)
    return added
