"""
anime_hair.styles — the style library: parameter presets built on hairkit.

Every style is a function  style(F: HeadFrame, rng) -> StyleResult(clumps, scalp_hairline, palette, chains)
Head-local coordinates (s, f, u) are in scalp-ellipsoid radii: s = +X = character's right (viewer's LEFT in a
front view), f = front, u = up; eye level is about u = -0.35, the chin about u = -1.3.

Styles:
  swept_quiff     soft voluminous wavy hair swept UP and back into a big quiff leaning to his left, fringe locks
                  falling across the forehead, sides tucked
  wild_mop        big spiky mop swept up and to one side, flame-like locks, pointed fringe, layered back (hand-laid)
  messy_spiky     classic shonen messy spiky male hair
  long_straight   long straight hair to mid-back, face-framing side curtains, side-swept bangs
  twin_tails      short layered top, full bangs, two long wavy twin tails
  bob_blunt       chin-length bob curling under, blunt-cut bangs
  ponytail        hair gathered to a high ponytail, side-swept bangs, sideburn locks
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from . import hairkit as hk
from .hairkit import Clump, Palette, unit, smoothstep


@dataclass
class StyleResult:
    clumps: list
    hairline: dict
    palette: Palette
    chains: dict = field(default_factory=dict)       # chain name -> list of clump indices
    ties: list = field(default_factory=list)          # (centre, axis, radius) hair ties
    scalp_offset: float = 0.0035


# ============================================================================ helpers
def surface_flow(F, p, n, mode='down'):
    """Tangent direction at p: 'down' along the scalp (gravity projected), falls back to radial-horizontal."""
    down = np.array([0, 0, -1.0])
    tan = down - n * np.dot(down, n)
    if np.linalg.norm(tan) < 0.25:
        tan = (p - F.c) * np.array([1, 1, 0])
    return unit(tan)


def trim_z(G, z_end):
    """Cut a guide where it first drops below z_end (interpolated)."""
    for i in range(1, len(G)):
        if G[i][2] < z_end <= G[i - 1][2]:
            f = (G[i - 1][2] - z_end) / (G[i - 1][2] - G[i][2] + 1e-12)
            return np.vstack([G[:i], G[i - 1] + (G[i] - G[i - 1]) * f])
    return G


def hang(F, th, ph, length, width, gravity=6.0, out=0.35, flow=None, lift=0.002, margin=0.004, pull_dir=None, pull=0.0,
         curl=0.0, n=18, z_end=None, **kw):
    root, nrm = F.root(th, ph, lift)
    fl = unit(flow) if flow is not None else surface_flow(F, root, nrm)
    d0 = unit(fl + nrm * out)
    G = hk.grow(F, root - nrm * 0.003, d0, length, n=n, gravity=gravity, target=pull_dir, pull=pull, curl=curl,
                margin=margin)
    if z_end is not None:
        G = trim_z(G, z_end)
    return Clump(G, width=width, **kw)


def curve(F, pts_local, margin=0.004, root_lift=-0.003, root_on_scalp=True, **kw):
    """Clump through explicit head-local control points (first = root, projected onto the scalp unless
    root_on_scalp=False, e.g. a lock peeling off the surface of another layer)."""
    P = [F.local(*p) for p in pts_local]
    if not root_on_scalp:
        return Clump(np.array([P[0]] + [F.push_out(q, margin) for q in P[1:]]), **kw)
    d = unit(P[0] - F.c)
    th = math.degrees(math.atan2(d[0], d[1])); ph = math.degrees(math.asin(np.clip(d[2], -1, 1)))
    r0, n0 = F.root(th, ph, 0.0)
    G = [r0 + n0 * root_lift]
    for q in P[1:]:
        G.append(F.push_out(q, margin))
    return Clump(np.array(G), **kw)


def surface_path(F, a_dir, b_dir, n, margin):
    """Points along the scalp from direction a to direction b (slerp), `margin` off the surface."""
    a, b = unit(a_dir), unit(b_dir)
    om = math.acos(np.clip(np.dot(a, b), -1, 1))
    out = []
    for i in range(n):
        t = i / (n - 1)
        d = a if om < 1e-6 else (math.sin((1 - t) * om) * a + math.sin(t * om) * b) / math.sin(om)
        th = math.degrees(math.atan2(d[0], d[1])); ph = math.degrees(math.asin(np.clip(d[2], -1, 1)))
        p, nn = F.root(th, ph, margin)
        out.append(p)
    return np.array(out)


def part_flow(th, back=0.5, down=0.6):
    """Flow for roots on the front half of the head: away from the face (sideways-back from a centre part)."""
    sg = 1.0 if th >= 0 else -1.0
    return [sg, -back, -down]


def jit(rng, a):
    return rng.uniform(-a, a)


# ============================================================================ 1. Swept-up wavy quiff
def dome_point(sc, sr, s, alpha, tilt=0.0, back_blend=(100.0, 178.0), scalp=1.08):
    """Point on a volume shell (centre sc, radii sr, head-local units) at lateral s and sagittal angle alpha
    (0 = front, 90 deg = top, 180 = back). Toward the back the shell converges onto the scalp (radius `scalp` around
    the head centre): volume up front, slicked down behind. `tilt` raises one side (u += tilt * s)."""
    lim = 0.9 * sr[0]
    if abs(s) > lim:                       # past the shell's flank: roll smoothly onto its side instead of collapsing
        s = math.copysign(lim + (1 - math.exp(-(abs(s) - lim) / (0.1 * sr[0]))) * 0.06 * sr[0], s)
    k = math.sqrt(max(0.0, 1 - (s / sr[0]) ** 2))
    a = math.radians(alpha)
    p = np.array((sc[0] + s, sc[1] + sr[1] * k * math.cos(a), sc[2] + sr[2] * k * math.sin(a) + tilt * s))
    w = float(smoothstep(back_blend[0], back_blend[1], alpha))
    if w > 0:
        q = unit(p) * scalp
        p = p * (1 - w) + q * w
    return tuple(p)


def dome_lock(F, sc, sr, s0, a0, a1, lean, root_dir, n=8, flick=0.25, s_curve=0.12, rng=None, margin=0.006, tilt=0.0,
              scalp=1.08, phase=None, lift=0.0, **kw):
    """A lock rooted on the scalp at root_dir, rising onto the volume shell at alpha a0 and running over it to a1,
    drifting sideways by `lean` (head units) with an S-curve, the tip flicking out off the shell."""
    pts = [tuple(unit(root_dir))]
    ph0 = phase if phase is not None else (rng.uniform(0, 1) if rng is not None else 0.0)
    for i in range(n):
        t = i / (n - 1)
        al = a0 + (a1 - a0) * t
        s = s0 + lean * float(smoothstep(0.0, 0.45, t)) + s_curve * math.sin(t * math.pi * 1.6 + ph0)
        p = np.array(dome_point(sc, sr, s, al, tilt, scalp=scalp))
        p = p + unit(p - np.array(sc)) * lift * math.sin(math.pi * min(1.0, t * 1.3))
        if t > 0.75:
            p = p + unit(p) * (t - 0.75) / 0.25 * flick
        pts.append(tuple(p))
    return curve(F, pts, margin=margin, **kw)


def swept_quiff(F, rng, lean=-1.0):
    """A soft, voluminous mass swept UP from the forehead and back over a big rounded quiff that leans to
    his LEFT (-X, viewer's right); wavy S-curved locks, fringe locks falling across the forehead, sides tucked, short
    soft back. lean = -1 leans to his left."""
    C = []
    L = lean
    V = lambda: int(rng.integers(0, 4))
    # ---- back: long locks from the crown down to the nape (one clean row of tips), an under layer for depth
    nape = F.c[2] - F.r[2] * 1.02
    for th in np.arange(112, 250, 23):
        C.append(hang(F, th + jit(rng, 4), 70 + jit(rng, 4), 0.26, 0.07, gravity=3.2, out=0.3, margin=0.009,
                      flow=[L * 0.12, -0.6, -1], z_end=nape + jit(rng, 0.008), tips=2, tip_spread=0.35, split=0.7,
                      taper=2.6, wave=0.005, wave_freq=0.7, wave_phase=rng.uniform(0, 6), variant=V(), layer='back',
                      chain='back', thick=0.36, ridge=0.55, wrap=0.22, curl=-0.3))
    for th in list(np.arange(100, 262, 20)):
        C.append(hang(F, th + jit(rng, 4), 14, 0.13, 0.07, gravity=4.0, out=0.35, margin=0.005,
                      z_end=nape + 0.004 + jit(rng, 0.006), tips=2, tip_spread=0.35, split=0.65, taper=2.4,
                      variant=V(), layer='back', chain='back', thick=0.34, ridge=0.5, wrap=0.2, curl=-0.3))
    # ---- sides tucked: his right (+X, under the mask) to the cheekbone; his left a little longer, flicking out
    for th, ph, ln, fl in ((75, 20, 0.07, 0.0), (95, 30, 0.075, 0.0), (-75, 22, 0.08, 1.0), (-95, 30, 0.085, 0.8)):
        sg = 1 if th > 0 else -1
        C.append(hang(F, th, ph, ln, 0.055, gravity=5.5, out=0.3, margin=0.006, flow=[0, -0.35, -1],
                      pull_dir=[sg * 1.0, 0.4, 0.1] if fl else None, pull=1.8 * fl, tips=2, tip_spread=0.55,
                      split=0.5, taper=2.0, variant=V(), layer='side', thick=0.34, ridge=0.55))
    # ---- the quiff / top volume: locks running over a big shell, front to back, leaning to his left
    sc = (L * 0.3, -0.12, 0.2)
    sr = (1.15, 1.2, 1.22)
    outer = np.linspace(-0.88, 0.88, 8)
    for k, s0 in enumerate(outer):
        root = (s0 * 0.75, 0.92, 0.42 + 0.1 * (1 - abs(s0)))
        a1 = 150 + 18 * (1 - abs(s0)) + jit(rng, 6)
        C.append(dome_lock(F, sc, sr, s0 * 0.95, 26 + 8 * abs(s0), a1, L * (0.6 + 0.08 * rng.random()), root,
                           flick=0.05, s_curve=0.14, tilt=L * 0.25, phase=0.6 * s0, lift=jit(rng, 0.07), rng=rng, width=0.075, thick=0.4, taper=2.6, tips=2,
                           tip_spread=0.5, split=0.62, wave=0.006, wave_freq=1.1, wave_phase=rng.uniform(0, 6),
                           variant=V(), layer='quiff', chain='quiff', ridge=0.7, wrap=0.25, root_w=0.85))
    # inner layer (fills under the outer locks, slightly smaller shell, offset half a step)
    sr2 = (sr[0] * 0.9, sr[1] * 0.9, sr[2] * 0.88)
    for s0 in (outer[:-1] + outer[1:]) / 2:
        root = (s0 * 0.8, 0.55, 0.85)
        C.append(dome_lock(F, sc, sr2, s0 * 0.9, 40, 172 + jit(rng, 6), L * 0.5, root, flick=0.03, s_curve=0.12,
                           phase=0.6 * s0,
                           tilt=L * 0.15,
                           rng=rng, width=0.07, thick=0.4, taper=2.4, tips=2, tip_spread=0.4, split=0.65, wave=0.004,
                           wave_freq=1.0, wave_phase=rng.uniform(0, 6), variant=V(), layer='quiff', chain='quiff',
                           ridge=0.6, wrap=0.25))
    # flanks: from the side part line back and down over the upper sides of the head, ending above the ears
    for sg in (-1, 1):
        for th, ph in ((72, 62), (98, 64), (124, 60)):
            C.append(hang(F, sg * (th + jit(rng, 4)), ph, 0.16, 0.068, gravity=3.0, out=0.45, margin=0.012,
                          flow=[sg * 0.35, -0.8, -0.8], z_end=F.eye[2] + 0.02 + jit(rng, 0.01), tips=2,
                          tip_spread=0.4, split=0.65, taper=2.4, wave=0.004, wave_phase=rng.uniform(0, 6), variant=V(),
                          layer='side', chain='back', thick=0.36, ridge=0.55, wrap=0.22))
    # sideburns: cover the temples in front of the ears
    for sg in (-1, 1):
        C.append(hang(F, sg * 62, 12, 0.07, 0.04, gravity=6.0, out=0.25, margin=0.004, flow=[0, 0.2, -1], tips=2,
                      tip_spread=0.4, split=0.5, taper=2.0, variant=V(), layer='side', thick=0.3, ridge=0.5))
    # ---- fringe: locks peeling off the FRONT of the quiff and falling across the forehead (hides the quiff's base)
    #      (s, end height u, end sideways drift, width)
    fr = [(-0.78, -0.02, -0.34, 0.048), (-0.5, -0.26, -0.34, 0.052), (-0.22, -0.16, -0.2, 0.05), (0.04, -0.42, -0.08, 0.05),
          (0.3, -0.06, 0.05, 0.046), (0.58, 0.04, 0.12, 0.044)]
    for s0, ue, drift, w in fr:
        p0 = np.array(dome_point(sc, sr, s0 + L * 0.12, 42, L * 0.25)) * 0.97
        p1 = np.array(dome_point(sc, sr, s0 + L * 0.08, 22, L * 0.25)) * 1.0
        p2 = np.array([s0 + drift * 0.3, 1.1, 0.22])
        p3 = np.array([s0 + drift * 0.7, 1.1, (0.2 + ue) / 2])
        p4 = np.array([s0 + drift, 1.02, ue])
        C.append(curve(F, [tuple(p) for p in (p0, p1, p2, p3, p4)], margin=0.008, root_on_scalp=False, width=w,
                       thick=0.38, taper=2.0, tips=2, tip_spread=0.4, split=0.6, variant=V(), layer='fringe',
                       chain='fringe', wave=0.002, ridge=0.6, wrap=0.22))
    pal = Palette(mid=(0.97, 0.96, 1.0), tip=(0.86, 0.85, 1.0), shade=(0.50, 0.49, 0.93),
                  ink=(0.16, 0.16, 0.6), shade_mul=(0.6, 0.6, 1.0), strokes=3, stroke_alpha=0.75, hairline=True,
                  tip_range=(0.75, 1.0), root_range=(0.0, 0.12), edge_band=0.07, band_alpha=0.85, root_occ=0.2, ink_w=0.07,
                  root=(0.86, 0.85, 0.98))
    chains = {}
    for i, c in enumerate(C):
        if c.chain:
            chains.setdefault(c.chain, []).append(i)
    return StyleResult(C, {'front': 30.0, 'side': 2.0, 'back': -30.0}, pal, chains)


# ============================================================================ 2. messy spiky male
def messy_spiky(F, rng):
    C = []
    for ph in (8, 34, 58, 80):
        step = 26 if ph < 70 else 45
        for th in np.arange(-180, 180, step):
            th2 = th + jit(rng, 8) + (13 if ph in (34, 80) else 0)
            front = abs(((th2 + 180) % 360) - 180) < 60
            if front and ph < 40:
                continue
            ln = rng.uniform(0.07, 0.09) * (1.1 if ph > 50 else 1.0)
            fl = part_flow(th2, 0.6, 0.2) if front else None
            C.append(hang(F, th2, ph + jit(rng, 4), ln, rng.uniform(0.05, 0.058), gravity=2.5 if ph > 50 else 3.5,
                          out=0.9 if ph > 50 else 0.6, margin=0.008 + 0.008 * (ph > 50), tips=2, flow=fl,
                          tip_spread=0.7, taper=1.8, split=0.55, curl=jit(rng, 0.5), variant=int(rng.integers(0, 4)),
                          layer='crown', chain=None, thick=0.4, ridge=0.8))
    for k, th in enumerate(np.linspace(-40, 40, 6)):
        C.append(hang(F, th + jit(rng, 4), 42, rng.uniform(0.09, 0.11), 0.045, gravity=4.0, out=0.8, margin=0.01,
                      flow=[np.sign(th) * 0.3 + jit(rng, 0.2), 0.6, -1], tips=2, tip_spread=0.7, taper=1.8,
                      variant=int(rng.integers(0, 4)), layer='fringe', thick=0.36, ridge=0.8))
    pal = Palette(root=(0.10, 0.10, 0.18), mid=(0.17, 0.17, 0.28), tip=(0.26, 0.28, 0.45), shade=(0.08, 0.08, 0.14),
                  ink=(0.03, 0.03, 0.06), shade_mul=(0.62, 0.64, 0.86), shine=(0.45, 0.5, 0.75), shine_amt=0.6,
                  strokes=3, stroke_alpha=0.6)
    return StyleResult(C, {'front': 32.0, 'side': 0.0, 'back': -40.0}, pal, {})


# ============================================================================ 3. long straight
def long_straight(F, rng, z_end=1.38):
    C = []
    for ph, margin, ln in ((-15, 0.006, 0.5), (15, 0.012, 0.52), (45, 0.02, 0.56), (70, 0.028, 0.58)):
        step = 13 if ph < 60 else 22
        for th in np.arange(100, 261, step):
            th2 = th + jit(rng, 4)
            C.append(hang(F, th2, ph + jit(rng, 3), ln, rng.uniform(0.05, 0.06), gravity=9.0, out=0.3,
                          margin=margin, z_end=z_end + jit(rng, 0.012), tips=int(rng.choice([1, 2])), tip_spread=0.5,
                          taper=2.6, wave=0.004, wave_freq=0.8, wave_phase=rng.uniform(0, 6),
                          variant=int(rng.integers(0, 4)), layer='back', chain='back', thick=0.3, ridge=0.4))
    for sgn in (-1, 1):
        for th, ph in ((70, 30), (55, 40), (82, 12)):
            C.append(hang(F, sgn * (th + jit(rng, 3)), ph, 0.46, 0.048, gravity=9.0, out=0.25, margin=0.012,
                          flow=[sgn * 0.5, 0.0, -1], z_end=F.c[2] - F.r[2] * 2.3 + jit(rng, 0.01), tips=2, tip_spread=0.5,
                          taper=2.6, wave=0.004, wave_freq=0.8, variant=int(rng.integers(0, 4)), layer='side',
                          chain='side_L' if sgn < 0 else 'side_R', thick=0.3, ridge=0.4))
    # side-swept bangs (toward his right)
    for k, th in enumerate(np.linspace(-45, 30, 6)):
        pts = None
        C.append(hang(F, th, 48 - abs(th) * 0.2, 0.12 + 0.02 * (k % 2), 0.038, gravity=5.0, out=0.6, margin=0.008,
                      flow=[0.7, 0.5, -0.7], z_end=F.eye[2] + 0.012, tips=2, tip_spread=0.6, taper=1.6,
                      variant=int(rng.integers(0, 4)), layer='fringe', chain='fringe', thick=0.3, ridge=0.5))
    # crown: from a centre part, flowing sideways and down over the top (covers the roots of the back rows)
    for sg in (-1, 1):
        for th in (20, 60, 100, 140):
            C.append(hang(F, sg * th, 84, 0.2, 0.06, gravity=6.0, out=0.0, margin=0.03, tips=1, taper=2.4,
                          flow=[sg * 1.0, -0.5 if th > 30 else 0.2, -0.3], z_end=F.eye[2] - 0.02, variant=int(rng.integers(0, 4)),
                          layer='crown', thick=0.3, ridge=0.4))
    pal = Palette(root=(0.93, 0.62, 0.72), mid=(0.99, 0.80, 0.86), tip=(1.0, 0.88, 0.9), shade=(0.83, 0.47, 0.62),
                  ink=(0.47, 0.18, 0.33), shade_mul=(0.82, 0.62, 0.78), shine=(1, 0.97, 0.98), shine_amt=0.7,
                  strokes=4, stroke_alpha=0.65)
    return StyleResult(C, {'front': 34.0, 'side': 0.0, 'back': -45.0}, pal,
                       {k: [i for i, c in enumerate(C) if c.chain == k] for k in {c.chain for c in C if c.chain}})


# ============================================================================ 4. twin tails
def twin_tails(F, rng):
    C = []
    # short layered top + back (to the nape), blunt-ish
    for ph, margin in ((0, 0.006), (30, 0.012), (58, 0.02)):
        for th in np.arange(80 if ph < 50 else -160, 281 if ph < 50 else 161, 18):
            C.append(hang(F, th + jit(rng, 4), ph, 0.15, 0.045, gravity=7.0, out=0.3, margin=margin,
                          z_end=F.c[2] - F.r[2] * 0.95 + jit(rng, 0.01), tips=2, tip_spread=0.5, taper=2.0,
                          variant=int(rng.integers(0, 4)), layer='back', thick=0.32, ridge=0.5))
    # side locks framing the face
    for sgn in (-1, 1):
        C.append(hang(F, sgn * 68, 26, 0.2, 0.04, gravity=8.0, out=0.3, margin=0.008, flow=[sgn * 0.1, 0.4, -1],
                      z_end=F.c[2] - F.r[2] * 1.35, tips=2, tip_spread=0.5, taper=2.2, variant=1, layer='side',
                      thick=0.3))
    # full bangs
    for th in np.linspace(-48, 48, 9):
        C.append(hang(F, th + jit(rng, 2), 44, 0.12, 0.036, gravity=6.0, out=0.6, margin=0.008,
                      flow=[th / 120, 0.6, -1], z_end=F.eye[2] + 0.018 + jit(rng, 0.006), tips=2, tip_spread=0.5,
                      taper=1.7, variant=int(rng.integers(0, 4)), layer='fringe', thick=0.3))
    ties = []
    for sgn in (-1, 1):
        tie = F.local(sgn * 0.78, -0.25, 0.62)
        axis = unit([sgn * 1.0, -0.3, 0.35])
        ties.append((tie, axis, 0.016))
        side = unit(np.cross(axis, [0, 0, 1]))
        up = unit(np.cross(side, axis))
        for k in range(11):
            a = 2 * math.pi * k / 11
            off = (side * math.cos(a) + up * math.sin(a)) * 0.012
            d0 = unit(axis * 1.0 + off / 0.012 * 0.35 + np.array([0, 0, 0.3]))
            G = hk.grow(F, tie - axis * 0.01 + off, d0, rng.uniform(0.44, 0.52), n=24, gravity=7.5,
                        margin=0.005, curl=jit(rng, 0.4))
            C.append(Clump(G, width=rng.uniform(0.042, 0.05), thick=0.35, taper=2.0, tips=2, tip_spread=0.6,
                           wave=0.012, wave_freq=1.4, wave_phase=rng.uniform(0, 6), variant=int(rng.integers(0, 4)),
                           layer='tail', chain=f'tail_{"L" if sgn < 0 else "R"}', ridge=0.5, root_w=1.0))
    pal = Palette(root=(0.12, 0.6, 0.62), mid=(0.3, 0.82, 0.8), tip=(0.55, 0.93, 0.9), shade=(0.08, 0.45, 0.52),
                  ink=(0.03, 0.22, 0.3), shade_mul=(0.6, 0.78, 0.86), shine=(0.85, 1, 1), shine_amt=0.6,
                  strokes=4, stroke_alpha=0.6)
    chains = {k: [i for i, c in enumerate(C) if c.chain == k] for k in ('tail_L', 'tail_R')}
    return StyleResult(C, {'front': 34.0, 'side': 2.0, 'back': -40.0}, pal, chains, ties)


# ============================================================================ 5. bob with blunt bangs
def bob_blunt(F, rng):
    C = []
    z_end = F.c[2] - F.r[2] * 1.28
    for ph, margin in ((-10, 0.005), (20, 0.009), (48, 0.013), (72, 0.017)):
        step = 14 if ph < 60 else 24
        for th in np.arange(-178, 180, step):
            a = abs(((th + 180) % 360) - 180)
            if a < 62 and ph < 60:
                continue
            ze = z_end + (0.012 if a < 90 else -0.004)
            fl = part_flow(th, 0.5, 0.2) if a < 80 else None
            C.append(hang(F, th + jit(rng, 3), ph, 0.25, 0.05, gravity=7.5, out=0.35, margin=margin, z_end=ze,
                          shape='blunt', curl=-0.5, flow=fl, variant=int(rng.integers(0, 4)), layer='back', thick=0.3,
                          ridge=0.35, wrap=0.25, belly=0.05))
    for th in np.linspace(-50, 50, 12):
        C.append(hang(F, th, 46, 0.12, 0.03, gravity=6.0, out=0.6, margin=0.009, flow=[0, 0.5, -1],
                      z_end=F.eye[2] + 0.024, shape='blunt', variant=int(rng.integers(0, 4)), layer='fringe',
                      thick=0.3, ridge=0.35))
    pal = Palette(root=(0.06, 0.06, 0.1), mid=(0.12, 0.12, 0.18), tip=(0.16, 0.16, 0.24), shade=(0.05, 0.05, 0.1),
                  ink=(0.02, 0.02, 0.04), shade_mul=(0.62, 0.62, 0.8), shine=(0.55, 0.6, 0.85), shine_amt=0.75,
                  strokes=3, stroke_alpha=0.5)
    return StyleResult(C, {'front': 36.0, 'side': 0.0, 'back': -42.0}, pal, {})


# ============================================================================ 6. ponytail
def ponytail(F, rng):
    C = []
    tie = F.local(0.0, -0.92, 0.42)
    tie_dir = unit(tie - F.c)
    for ph in (5, 30, 55, 78):
        step = 20 if ph < 70 else 36
        for th in np.arange(-180, 180, step):
            a = abs(((th + 180) % 360) - 180)
            if a > 150 and ph > 20:
                continue
            if a < 60 and ph < 25:
                continue
            G = surface_path(F, F.sph(th + jit(rng, 4), ph), tie_dir, 10, 0.004 + 0.004 * (ph > 50))
            C.append(Clump(G, width=0.045, thick=0.28, taper=4.0, root_w=0.9, variant=int(rng.integers(0, 4)),
                           layer='crown', ridge=0.4, wrap=0.3, belly=0.05))
    ties = [(tie, unit(tie - F.c), 0.018)]
    side = unit(np.cross(tie_dir, [0, 0, 1])); up = unit(np.cross(side, tie_dir))
    for k in range(13):
        a = 2 * math.pi * k / 13
        off = (side * math.cos(a) + up * math.sin(a)) * 0.014
        d0 = unit(tie_dir * 0.6 + np.array([0, -0.4, 0.8]) + off / 0.014 * 0.35)
        G = hk.grow(F, tie + off, d0, rng.uniform(0.38, 0.45), n=24, gravity=7.0, margin=0.006, curl=jit(rng, 0.3))
        C.append(Clump(G, width=rng.uniform(0.045, 0.055), thick=0.35, taper=2.0, tips=2, tip_spread=0.7, wave=0.01,
                       wave_freq=1.2, wave_phase=rng.uniform(0, 6), variant=int(rng.integers(0, 4)), layer='tail',
                       chain='tail', root_w=1.0, ridge=0.5))
    for sgn in (-1, 1):
        C.append(hang(F, sgn * 72, 20, 0.16, 0.03, gravity=7.0, out=0.3, margin=0.006, flow=[sgn * 0.1, 0.3, -1],
                      tips=2, tip_spread=0.6, taper=1.8, variant=2, layer='side', chain=None, thick=0.3))
    for th in np.linspace(-40, 25, 5):
        C.append(hang(F, th, 46, 0.12, 0.036, gravity=5.0, out=0.6, margin=0.009, flow=[-0.6, 0.5, -0.8],
                      z_end=F.eye[2] + 0.005, tips=2, tip_spread=0.7, taper=1.6, variant=int(rng.integers(0, 4)),
                      layer='fringe', thick=0.3))
    pal = Palette(root=(0.85, 0.55, 0.2), mid=(1.0, 0.8, 0.38), tip=(1.0, 0.9, 0.6), shade=(0.84, 0.46, 0.18),
                  ink=(0.45, 0.2, 0.08), shade_mul=(0.9, 0.66, 0.6), shine=(1, 1, 0.9), shine_amt=0.7,
                  strokes=4, stroke_alpha=0.6)
    return StyleResult(C, {'front': 30.0, 'side': 0.0, 'back': -35.0}, pal, {'tail': [i for i, c in enumerate(C) if c.chain == 'tail']}, ties)


# ============================================================================ 7. Wild spiky mop, hand-laid
def locks(F, spec, defaults, rng=None, jitter=0.0, wscale=1.0):
    """Hand-laid clumps: spec = [(layer, [(s, f, u), ...], width, {overrides}), ...] in head-local units (first point
    = root, projected onto the scalp). defaults[layer] = Clump kwargs (+ 'margin', 'center' in head-local units).
    Every clump gets its own spring chain '<layer>_<i>' unless its layer default says chain=None."""
    C = []
    for i, (layer, pts, w, kw) in enumerate(spec):
        d = dict(defaults.get(layer, {}))
        d.update(kw)
        margin = d.pop('margin', 0.006)
        cen = d.pop('center', None)
        chain = d.pop('chain', 'yes')
        vol = d.pop('volume', None)            # (factor, centre): push the lock's body out from a centre (bigger hairdo)
        curl = d.pop('curl', 0.0)              # extra tip point curling UP by this much (head units)
        if vol:
            k, vc = vol
            vc = np.array(vc)
            pts = [pts[0]] + [tuple(vc + (np.array(p) - vc) * (1 + (k - 1) * min(1.0, j / 2))) for j, p in enumerate(pts[1:], 1)]
        if curl:
            a_, b_ = np.array(pts[-2]), np.array(pts[-1])
            dv = b_ - a_
            pts = list(pts) + [tuple(b_ + dv * 0.35 + np.array([0, 0, curl]))]
        if jitter and rng is not None:
            pts = [pts[0]] + [tuple(np.array(p) + rng.uniform(-jitter, jitter, 3) * (k / len(pts))) for k, p in enumerate(pts[1:], 1)]
        c = curve(F, pts, margin=margin, width=w * wscale, layer=layer, **d)
        c.center = F.local(*cen) if cen is not None else None
        c.chain = f'{layer}_{i}' if chain == 'yes' else chain
        C.append(c)
    return C


def wild_mop(F, rng):
    """Big white-lavender mop with wild spiky
    volume swept up and to his LEFT (-s, viewer's right), flame-like locks flicking out on that side, pointed fringe
    locks falling over the forehead and between the eyes (swept toward his right, under the skull mask), locks
    fanning out below the mask on his right, spiky layered back. Broad tapered shell clumps, needle tips."""
    shell = dict(shape='flame', thick=0.42, ridge=0.55, wrap=0.3, root_w=0.8, belly=0.08, tip_curve=0.8,
                 thick_tip=0.3, tips=1)
    VOL = (1.25, (-0.1, 0.0, 0.35))          # the art's hairdo is far bigger than the skull: +25 % crown / his-left side
    WAVE = dict(wave=0.004, wave_freq=0.9)     # gentle S-waves (pass 2's stronger waves read as stacked stripes)
    D = {
        'sweep': dict(shell, **WAVE, tip_start=0.6, margin=0.014, center=(0.1, -0.1, 0.3), volume=VOL, curl=0.1),
        'swback': dict(shell, **WAVE, tip_start=0.55, margin=0.02, center=(0.1, -0.2, 0.3), volume=VOL, curl=0.08),
        'fringe': dict(shell, tip_start=0.45, margin=0.009, thick=0.36),
        'crest': dict(shell, tip_start=0.3, margin=0.02, center=(0.1, -0.1, 0.3), volume=(1.3, (-0.1, 0.0, 0.35)), curl=0.1),
        'under': dict(shell, tip_start=0.5, margin=0.008),
        'side': dict(shell, tip_start=0.45, margin=0.006, thick=0.36),
        'back': dict(shell, tip_start=0.55, margin=0.008),
        'backup': dict(shell, tip_start=0.5, margin=0.016),
    }
    S = [
        # ---- the big swept mass (face_16): broad locks rising off the part into a quiff, arcing over the crown to
        #      his left (-s) and FALLING down the side (staggered front -> back, tips at different heights, curling out)
        ('sweep', [(0.4, 0.62, 0.9), (0.1, 0.98, 1.25), (-0.42, 0.86, 1.48), (-0.9, 0.62, 1.3), (-1.2, 0.5, 0.95), (-1.34, 0.42, 0.62)], 0.07, {}),
        ('sweep', [(0.36, 0.4, 0.95), (0.02, 0.62, 1.38), (-0.55, 0.55, 1.5), (-1.05, 0.32, 1.22), (-1.3, 0.2, 0.8), (-1.42, 0.12, 0.42)], 0.07, {}),
        ('sweep', [(0.3, 0.12, 0.98), (-0.05, 0.26, 1.42), (-0.62, 0.18, 1.46), (-1.1, -0.02, 1.12), (-1.34, -0.12, 0.66), (-1.46, -0.18, 0.24)], 0.068, {}),
        ('sweep', [(0.22, -0.18, 1.0), (-0.1, -0.1, 1.38), (-0.66, -0.18, 1.36), (-1.08, -0.36, 1.0), (-1.3, -0.46, 0.56), (-1.4, -0.52, 0.2)], 0.066, {}),
        ('sweep', [(-0.2, 0.94, 0.56), (-0.64, 1.02, 0.6), (-1.02, 0.8, 0.4), (-1.26, 0.62, 0.12), (-1.36, 0.54, -0.08)], 0.06, {}),
        ('sweep', [(-0.5, 0.86, 0.5), (-0.92, 0.84, 0.3), (-1.16, 0.62, 0.0), (-1.26, 0.5, -0.3), (-1.3, 0.44, -0.45)], 0.055, {}),
        # behind: top-back and back-side locks
        ('swback', [(0.5, -0.36, 0.95), (0.34, -0.7, 1.16), (-0.06, -0.98, 1.02), (-0.46, -1.18, 0.74), (-0.7, -1.3, 0.6), (-0.82, -1.4, 0.68)], 0.066, {}),
        ('swback', [(0.62, 0.3, 0.86), (0.52, 0.36, 1.28), (0.22, 0.08, 1.5), (-0.14, -0.32, 1.5), (-0.36, -0.62, 1.46)], 0.06, {}),
        ('swback', [(-0.62, 0.3, 0.82), (-1.06, 0.2, 0.9), (-1.42, -0.1, 0.86), (-1.62, -0.28, 0.9), (-1.72, -0.36, 1.06)], 0.06, {}),
        ('swback', [(-0.66, -0.26, 0.76), (-1.12, -0.4, 0.62), (-1.44, -0.62, 0.5), (-1.6, -0.74, 0.6)], 0.06, {}),
        # ---- crest: the spiky top silhouette (face_12): short locks standing up out of the sweep, tips up / left
        ('crest', [(-0.1, 0.5, 0.92), (-0.28, 0.5, 1.4), (-0.52, 0.4, 1.74), (-0.7, 0.3, 1.94)], 0.066, {}),
        ('crest', [(0.2, 0.4, 0.95), (0.08, 0.36, 1.46), (-0.08, 0.24, 1.78), (-0.16, 0.14, 1.98)], 0.064, {}),
        ('crest', [(-0.5, 0.4, 0.88), (-0.82, 0.34, 1.34), (-1.12, 0.22, 1.6), (-1.3, 0.14, 1.78)], 0.064, {}),
        ('crest', [(-0.3, 0.05, 1.0), (-0.5, -0.05, 1.46), (-0.78, -0.18, 1.7), (-0.98, -0.26, 1.82)], 0.062, {}),
        # ---- fringe: locks falling out from under the sweep over the forehead, curving toward his right (+s);
        #      the long one ends between the eyes
        ('fringe', [(-0.3, 0.78, 0.88), (-0.24, 1.16, 0.5), (-0.06, 1.2, 0.08), (0.1, 1.14, -0.3), (0.14, 1.08, -0.46)], 0.046, {}),
        ('fringe', [(-0.62, 0.72, 0.84), (-0.6, 1.1, 0.4), (-0.46, 1.14, 0.0), (-0.32, 1.1, -0.3)], 0.046, {}),
        ('fringe', [(0.04, 0.82, 0.86), (0.12, 1.16, 0.44), (0.28, 1.16, 0.1), (0.42, 1.1, -0.1)], 0.044, {}),
        ('fringe', [(-0.9, 0.52, 0.76), (-0.98, 0.94, 0.3), (-0.86, 1.0, -0.06), (-0.72, 0.98, -0.24)], 0.044, {}),
        ('fringe', [(0.32, 0.76, 0.8), (0.46, 1.06, 0.4), (0.62, 1.02, 0.08), (0.74, 0.96, -0.1)], 0.042, {}),
        # ---- his right (+s, mask side): locks fanning out BELOW the mask, one over the ear
        ('under', [(0.6, 0.35, 0.8), (1.08, 0.42, 0.34), (1.26, 0.36, 0.02), (1.36, 0.3, -0.12)], 0.05, {}),
        ('under', [(0.55, 0.6, 0.65), (0.98, 0.74, 0.08), (1.06, 0.66, -0.3), (1.08, 0.6, -0.5)], 0.045, {}),
        ('under', [(0.42, 0.8, 0.56), (0.74, 0.98, 0.08), (0.84, 0.94, -0.22), (0.9, 0.88, -0.38)], 0.04, {}),
        ('under', [(0.66, 0.0, 0.8), (1.14, 0.06, 0.24), (1.22, 0.04, -0.3), (1.26, 0.0, -0.52)], 0.055, {}),
        ('under', [(0.62, -0.35, 0.74), (1.1, -0.38, 0.02), (1.24, -0.42, -0.3), (1.34, -0.48, -0.36)], 0.052, {}),
        # ---- sideburns in front of the ears / his left ear cover
        ('side', [(0.84, 0.36, 0.26), (0.98, 0.48, -0.28), (0.97, 0.52, -0.62), (0.94, 0.52, -0.78)], 0.03, {}),
        ('side', [(-0.84, 0.36, 0.26), (-0.98, 0.48, -0.28), (-0.97, 0.52, -0.62), (-0.94, 0.52, -0.78)], 0.03, {}),
        ('side', [(-0.7, 0.05, 0.6), (-1.12, 0.12, 0.1), (-1.2, 0.08, -0.36), (-1.24, 0.02, -0.56)], 0.055, {}),
        ('side', [(0.86, 0.2, 0.4), (1.1, 0.28, -0.1), (1.12, 0.26, -0.5), (1.1, 0.24, -0.66)], 0.05, {}),
        ('side', [(-0.86, 0.2, 0.4), (-1.1, 0.28, -0.1), (-1.12, 0.26, -0.5), (-1.1, 0.24, -0.66)], 0.05, {}),
        # ---- back: messy layered, swept back-down with a lean to his left, tips flicking out at the nape
        ('backup', [(-0.2, -0.5, 0.88), (-0.5, -1.12, 0.54), (-0.7, -1.3, 0.18), (-0.86, -1.42, 0.12)], 0.064, {}),
        ('backup', [(0.26, -0.55, 0.86), (0.2, -1.2, 0.5), (0.12, -1.36, 0.1), (0.1, -1.48, 0.04)], 0.064, {}),
        ('backup', [(0.7, -0.48, 0.8), (0.9, -1.04, 0.36), (0.96, -1.2, 0.0), (1.06, -1.3, -0.04)], 0.06, {}),
        ('back', [(-0.8, -0.7, 0.5), (-1.04, -1.0, -0.14), (-1.02, -1.0, -0.62), (-1.1, -1.08, -0.8)], 0.06, {}),
        ('back', [(-0.42, -0.8, 0.52), (-0.6, -1.14, -0.1), (-0.6, -1.12, -0.7), (-0.66, -1.2, -0.96)], 0.062, {}),
        ('back', [(0.0, -0.82, 0.52), (-0.06, -1.16, -0.14), (-0.08, -1.12, -0.8), (-0.12, -1.22, -1.06)], 0.062, {}),
        ('back', [(0.42, -0.8, 0.52), (0.52, -1.14, -0.1), (0.52, -1.1, -0.72), (0.58, -1.18, -0.92)], 0.062, {}),
        ('back', [(0.84, -0.66, 0.46), (1.06, -0.96, -0.12), (1.04, -0.96, -0.58), (1.12, -1.04, -0.76)], 0.058, {}),
    ]
    C = locks(F, S, D, rng, wscale=1.3)
    for k, c in enumerate(C):
        c.variant = k % 4
    pal = Palette(style='clean', root=(0.6, 0.64, 1.0), mid=(0.93, 0.93, 1.0), tip=(0.84, 0.86, 1.0),
                  shade=(0.3, 0.38, 1.0), ink=(0.05, 0.08, 0.72), shade_mul=(0.26, 0.33, 1.0),
                  root_range=(0.0, 0.22), tip_range=(0.7, 1.0), edge_band=0.18, band_alpha=0.8, root_occ=0.5,
                  ink_w=0.055, ring=0.9, ring_t=(0.2, 0.28), inner_lines=5, line_w=0.016)
    chains = {}
    for i, c in enumerate(C):
        if c.chain:
            chains.setdefault(c.chain, []).append(i)
    return StyleResult(C, {'front': 40.0, 'side': 5.0, 'back': -40.0}, pal, chains, scalp_offset=0.004)


STYLES = {
    'wild_mop': wild_mop,
    'swept_quiff': swept_quiff,
    'messy_spiky': messy_spiky,
    'long_straight': long_straight,
    'twin_tails': twin_tails,
    'bob_blunt': bob_blunt,
    'ponytail': ponytail,
}
