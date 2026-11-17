"""
face_kit hair styles for the comic / semi-real (MakeHuman) heads, built with the anime_hair toolkit
(layered tapered clumps + proxy normals + cel texture). Head-frame conventions as in anime_hair.styles
(theta 0 = front, +90 = character's right; phi = elevation; F.eye = eye level).
"""
from __future__ import annotations

import numpy as np

from anime_hair import styles as st
from anime_hair.hairkit import Palette
from anime_hair.styles import StyleResult, hang, jit


def _palette(base, shade_k=0.62, ring=0.0, clean=True):
    b = np.asarray(base, float)
    return Palette(root=tuple(b * 0.8), mid=tuple(b), tip=tuple(np.clip(b * 1.12, 0, 1)), shade=tuple(b * shade_k),
                   ink=tuple(b * 0.3), shine=tuple(np.clip(b * 1.18 + 0.02, 0, 1)), shade_mul=(0.66, 0.56, 0.58),
                   strokes=4, stroke_alpha=0.7, style='clean' if clean else 'painted', ring=ring, inner_lines=2,
                   line_w=0.02, edge_band=0.22, band_alpha=0.85)


def long_wavy_male(F, rng, base=(0.36, 0.21, 0.13), z_end=None):
    """Shoulder-length, wavy, swept back from a loose centre part; full sides over the ears, a few locks over the
    temples (the rugged-soldier look of the Aosabi reference)."""
    C = []
    z_end = z_end if z_end is not None else F.eye[2] - 0.20
    # back + sides: 4 rows of wavy locks hanging to the shoulders
    for ph, margin, ln, step in ((-10, 0.008, 0.42, 14), (18, 0.014, 0.44, 15), (45, 0.02, 0.46, 18)):
        for th in np.arange(80, 281, step):
            C.append(hang(F, th + jit(rng, 5), ph + jit(rng, 4), ln + jit(rng, 0.03), rng.uniform(0.05, 0.065),
                          gravity=8.0, out=0.35, margin=margin, z_end=z_end + jit(rng, 0.03), tips=int(rng.choice([2, 3])),
                          tip_spread=0.8, taper=2.2, wave=0.012, wave_freq=1.7, wave_phase=rng.uniform(0, 6),
                          variant=int(rng.integers(0, 4)), layer='back', chain='back', thick=0.3, ridge=0.5, shape='flame'))
    # swept-back top: roots along the front hairline, flowing BACK over the crown then down the back
    for sg in (-1, 1):
        for th in (6, 24, 44, 64):
            C.append(hang(F, sg * (th + jit(rng, 4)), 62 + jit(rng, 3), 0.42, 0.07, gravity=3.0, out=0.06, margin=0.018,
                          flow=[sg * 0.25, -1.0, 0.15], z_end=z_end + 0.04, tips=2, tip_spread=0.7, taper=2.2,
                          wave=0.01, wave_freq=1.4, wave_phase=rng.uniform(0, 6), variant=int(rng.integers(0, 4)),
                          layer='crown', thick=0.3, ridge=0.5, shape='flame'))
    # top of the head (covers the crown roots)
    for th in np.arange(0, 360, 45):
        C.append(hang(F, th + jit(rng, 8), 80, 0.3, 0.075, gravity=3.0, out=0.0, margin=0.03,
                      flow=[0.0, -1.0, 0.0], z_end=z_end + 0.08, tips=2, tip_spread=0.6, taper=2.2, wave=0.008,
                      wave_freq=1.2, variant=int(rng.integers(0, 4)), layer='crown', thick=0.3, ridge=0.5, shape='flame'))
    # side curtains framing the face (in front of the ears)
    for sg in (-1, 1):
        for th, ph in ((72, 28), (60, 40), (85, 12)):
            C.append(hang(F, sg * (th + jit(rng, 3)), ph, 0.36, 0.055, gravity=8.0, out=0.3, margin=0.014,
                          flow=[sg * 0.4, -0.15, -1], z_end=z_end + 0.02 + jit(rng, 0.02), tips=2, tip_spread=0.8,
                          taper=2.2, wave=0.012, wave_freq=1.6, wave_phase=rng.uniform(0, 6), variant=int(rng.integers(0, 4)),
                          layer='side', chain='side_L' if sg < 0 else 'side_R', thick=0.3, ridge=0.5, shape='flame'))
    # two loose locks falling over the temples (asymmetric)
    for th, ln, fl in ((-32, 0.15, [-0.6, 0.3, -1]), (26, 0.13, [0.55, 0.3, -1])):
        C.append(hang(F, th, 58, ln, 0.028, gravity=4.0, out=0.45, margin=0.01, flow=fl, z_end=F.eye[2] + 0.01,
                      tips=2, tip_spread=0.9, taper=1.8, curl=0.3, variant=int(rng.integers(0, 4)), layer='fringe',
                      chain='fringe', thick=0.3, ridge=0.5, shape='flame'))
    pal = _palette(base)
    return StyleResult(C, {'front': 38.0, 'side': 5.0, 'back': -40.0}, pal,
                       {k: [i for i, c in enumerate(C) if c.chain == k] for k in {c.chain for c in C if c.chain}})


def long_side_female(F, rng, base=(0.55, 0.22, 0.13)):
    """anime_hair long_straight (side-swept bangs, face-framing curtains) recoloured."""
    res = st.long_straight(F, rng, z_end=F.eye[2] - 0.30)
    res.palette = _palette(base, shade_k=0.66, ring=0.15)
    return res


def wild_swept_male(F, rng, base=(0.36, 0.19, 0.12), length=1.0):
    """Aosabi (v2 turnaround): long, WILD, layered hair swept back off the forehead with volume and flicked
    spiky tips, falling in waves to the shoulder blades; the sides go BEHIND the ears (ears visible); two loose
    strands drop over the forehead on his right (over the eyepatch side)."""
    C = []
    z_end = F.eye[2] - 0.40 * length
    fl = dict(shape='flame', thick=0.32, ridge=0.55, tip_curve=0.8, thick_tip=0.25)
    # back mass: 3 rows, long waves, tips flicking out
    for ph, margin, ln, step in ((-12, 0.008, 0.82 * length, 15), (16, 0.014, 0.84 * length, 16), (44, 0.022, 0.8 * length, 20)):
        for th in np.arange(100, 261, step):
            C.append(hang(F, th + jit(rng, 5), ph + jit(rng, 4), ln + jit(rng, 0.05), rng.uniform(0.055, 0.07),
                          gravity=14.0, out=0.1, margin=margin, z_end=z_end + jit(rng, 0.05), tips=int(rng.choice([2, 3])),
                          tip_spread=1.0, taper=2.0, wave=0.016, wave_freq=1.8, wave_phase=rng.uniform(0, 6),
                          variant=int(rng.integers(0, 4)), layer='back', chain='back', **fl))
    # swept-back top with volume: roots along the hairline, rising a little, then back and down
    for sg in (-1, 1):
        for th in (5, 22, 40, 58):
            C.append(hang(F, sg * (th + jit(rng, 4)), 60 + jit(rng, 3), 0.44 + jit(rng, 0.04), 0.072, gravity=2.4, out=0.2,
                          margin=0.024, flow=[sg * 0.3, -1.0, 0.35], z_end=z_end + 0.06, tips=3, tip_spread=0.9,
                          taper=2.0, wave=0.012, wave_freq=1.5, wave_phase=rng.uniform(0, 6), variant=int(rng.integers(0, 4)),
                          layer='crown', **fl))
    for th in np.arange(0, 360, 45):
        C.append(hang(F, th + jit(rng, 8), 80, 0.32, 0.08, gravity=3.0, out=0.05, margin=0.032, flow=[0.0, -1.0, 0.1],
                      z_end=z_end + 0.1, tips=2, tip_spread=0.8, taper=2.0, wave=0.01, wave_freq=1.2,
                      variant=int(rng.integers(0, 4)), layer='crown', **fl))
    # sides: from above the temples, swept back over the top of the ear, falling BEHIND it
    for sg in (-1, 1):
        for th, ph in ((78, 42), (92, 30), (104, 18)):
            C.append(hang(F, sg * (th + jit(rng, 3)), ph, 0.7, 0.06, gravity=12.0, out=0.08, margin=0.016,
                          flow=[sg * 0.1, -0.6, -1.0], z_end=z_end + 0.03 + jit(rng, 0.03), tips=2, tip_spread=0.9,
                          taper=2.0, wave=0.014, wave_freq=1.7, wave_phase=rng.uniform(0, 6),
                          variant=int(rng.integers(0, 4)), layer='side', chain='side_L' if sg < 0 else 'side_R', **fl))
    # loose strands over the forehead on his right (+theta)
    for th, ln, fw in ((22, 0.15, [0.6, 0.35, -1]), (34, 0.12, [0.7, 0.3, -1])):
        C.append(hang(F, th, 62, ln, 0.026, gravity=4.0, out=0.5, margin=0.01, flow=fw, z_end=F.eye[2] + 0.004,
                      tips=2, tip_spread=1.0, taper=1.8, curl=0.3, variant=int(rng.integers(0, 4)), layer='fringe',
                      chain='fringe', **fl))
    pal = _palette(base, shade_k=0.6)
    return StyleResult(C, {'front': 40.0, 'side': 8.0, 'back': -42.0}, pal,
                       {k: [i for i, c in enumerate(C) if c.chain == k] for k in {c.chain for c in C if c.chain}})


STYLES = {'wild_swept_male': wild_swept_male, 'long_wavy_male': long_wavy_male, 'long_side_female': long_side_female}
