"""
hair_kit.styles — hairstyle recipes. A recipe returns a list of LOCK DESIGNS: dicts with
    guide (n,3), layer, width (m), tips, tip_len, strands (per_guide, clump), wave, flick, tone, chain
built from scalp roots + a Flow + collision (hair_kit.core), optionally fitted to a reference silhouette.

Layer order (inside -> out): under (big dark volume), mid, top (swept), front (face-framing strays), fly (strands).
"""
from __future__ import annotations

import math

import numpy as np

from .core import smooth_poly
from .core import (Flow, grow, add_wave, flick, collide, unit, smoothstep, hairline_ph, resample, restore_lengths,
                   fit_lengths_to_ref, fit_width_to_ref)

N_PTS = 30


def _lat_axis(G, T):
    rad = unit(G - G[0] + np.array([0, 0, 1e-6]))
    L = unit(np.cross(np.array([0, 0, 1.0]), T))
    L[np.linalg.norm(L, axis=1) < 1e-6] = [1, 0, 0]
    return L


def _normal_axis(head):
    def f(G, T):
        out = unit(G - head.c)
        n = out - T * (out * T).sum(1, keepdims=True)
        return unit(n)
    return f


def wild_swept_back(head, rng, ref=None, scale=1.0, n_fly=0, front_strays=False):
    """Long, wild, swept-back layered hair (Aosabi): quiff lifted off the forehead and swept over the crown,
    heavy wavy mass to the shoulder blades flaring out at the shoulders, flicked pointed tips, a few face-framing
    strays at the temples, flyaway strands on top."""
    H = head
    designs = []
    top = H.c[2] + H.r[2]
    L_back = (top - 1.47 + 0.14) * scale   # crown -> shoulder blades (+ the arc over the back of the head)
    lat = _lat_axis
    nrm = _normal_axis(H)

    def add(th, ph, length, width, layer, flow, margin, tips=1, wave=(0.02, 1.1), flk=0.0, per=10, clump=0.6,
            tone=0.0, chain=True, tip_start=0.7, wrap=0.22, lift=0.0015, spread_k=1.0, ramp=0.5, z_end=None):
        root, n0 = H.root(th, ph, lift)
        if z_end is not None:
            # grow long, then cut where the lock reaches its target tip height (layers end together, no tiers)
            Gl = grow(H, root, n0, 1.1, flow, n=110, margin=margin, root_th=th, ramp=ramp * length / 1.1)
            k = np.nonzero(Gl[:, 2] < z_end)[0]
            Gl = Gl[:max(8, (k[0] + 1) if len(k) else len(Gl))]
            G = resample(Gl, N_PTS)
        else:
            G = grow(H, root, n0, length, flow, n=N_PTS, margin=margin, root_th=th, ramp=ramp)
        designs.append(dict(guide=G, th=th, ph=ph, layer=layer, width=width, tips=tips, wave=wave, flick=flk,
                            per_guide=per, clump=clump, tone=tone, chain=chain, tip_start=tip_start, wrap=wrap,
                            spread=width * 0.5 * spread_k, margin=margin, ramp=ramp))

    # ONE coherent flow for every layer (neighbouring locks run parallel -> shingled, never crossing);
    # the layers differ by root position, stand-off (margin) and length only
    z_tip = 1.47 if ref is None else 1.47
    fl = Flow(H, lift=0.45, lift_front=45.0, gravity=1.0, flare=0.38, back_bias=0.7)
    J = lambda s: rng.normal(0, s)
    # under curtain: two shingled rows round the back of the head (the volume, hidden roots)
    for row, (ph, n, w, mg, lk) in enumerate(((-6.0, 12, 0.08, (0.003, 0.008), 0.78), (24.0, 11, 0.078, (0.006, 0.014), 0.86))):
        for th in np.linspace(96, 264, n):
            th = ((th + J(2.5) + 180) % 360) - 180
            add(th, ph + J(2.5), L_back * lk, w * rng.uniform(0.94, 1.06), 'under', fl, mg,
                per=10, tone=-0.7 + 0.35 * row, z_end=z_tip + rng.uniform(-0.03, 0.03) + 0.02 * row)
    # sides behind the ears, flaring over the shoulders
    for side in (-1, 1):
        for th in (64, 80, 96, 112):
            add(side * (th + J(2)), rng.uniform(16, 26), L_back * rng.uniform(0.5, 0.62), rng.uniform(0.062, 0.07),
                'mid', fl, (0.02, 0.042), tips=int(rng.choice([1, 2])), per=10, tone=-0.15, tip_start=0.7, ramp=0.3)
    # top: swept back from the hairline; the root stands off quickly (quiff volume) and stays ~2.5 cm off the scalp
    for th in np.linspace(-62, 62, 13):
        add(th + J(1.5), hairline_ph(th) + rng.uniform(1.5, 3.0), L_back * rng.uniform(0.95, 1.05), rng.uniform(0.054, 0.062),
            'top', fl, (0.004, 0.036), tips=int(rng.choice([1, 2])), per=11, tone=0.25, ramp=0.14,
            z_end=z_tip + 0.03 + rng.uniform(-0.03, 0.04))
    # crown: fills between the swept layer and the back curtain
    for th in np.linspace(-180, 180, 11)[:-1] + 18:
        add(th + J(4), rng.uniform(56, 68), L_back * rng.uniform(0.84, 0.95), rng.uniform(0.058, 0.066), 'top', fl,
            (0.02, 0.04), tips=int(rng.choice([1, 2])), per=10, tone=0.3, ramp=0.25, z_end=z_tip + 0.02 + rng.uniform(-0.03, 0.03))
    # ---- front strays: from the temples falling beside the face (they frame it, never over the eyes)
    fl_front = Flow(H, lift=0.5, lift_front=60.0, gravity=1.6, flare=0.2)
    for side in ((-1, 1) if front_strays else ()):
        for k, th in enumerate((56,)):
            root, n0 = H.root(side * th, hairline_ph(side * th) + 2, 0.0015)
            pts = [root, root + n0 * 0.025 + np.array([side * 0.02, 0.005, 0.01]),
                   root + np.array([side * 0.05, -0.012, -0.05]), root + np.array([side * 0.07, 0.0, -0.13 - 0.03 * k]),
                   root + np.array([side * 0.09, 0.02, -0.2 - 0.04 * k])]
            from .core import resample as rs
            dense = rs(np.array(pts), N_PTS)
            from .core import smooth_poly
            G = collide(H, smooth_poly(dense, 6), (0.006, 0.014))
            designs.append(dict(guide=G, th=side * th, ph=0, layer='front', width=0.032, tips=2, wave=(0.008, 1.2),
                                flick=0.0, per_guide=9, clump=0.65, tone=0.1, chain=True, tip_start=0.45, wrap=0.2,
                                spread=0.016, margin=(0.006, 0.014)))
    # ---- flyaways: thin wild strands from the top (rendered as ribbons)
    fly = []
    for _ in range(int(n_fly)):
        th = rng.uniform(-40, 40) if rng.random() < 0.5 else rng.uniform(130, 230)
        th = ((th + 180) % 360) - 180
        ph = max(hairline_ph(th) + 3, rng.uniform(10, 70))
        root, n0 = H.root(th, ph, 0.002)
        G = grow(H, root, n0, L_back * rng.uniform(0.25, 0.45), fl, n=N_PTS, margin=(0.02, 0.04), root_th=th)  # noqa
        fly.append(G)
    # ---- reference silhouette fit (back view): lengths + widths
    if ref is not None:
        idx = [i for i, d in enumerate(designs) if d['layer'] in ('under', 'mid', 'top')]
        Gs = [designs[i]['guide'] for i in idx]
        Gs = fit_width_to_ref(Gs, ref, H, strength=0.6)
        Gs = fit_lengths_to_ref(Gs, ref, strength=0.85)
        for i, G in zip(idx, Gs):
            designs[i]['guide'] = collide(H, resample(G, N_PTS), designs[i]['margin'])
    # ---- waves + flicks, then collision again (keeps segment lengths)
    for d in designs:
        G = d['guide']
        L0 = np.linalg.norm(np.diff(G, axis=0), axis=1)
        amp, fq = d['wave']
        if amp:
            ph0 = math.radians(d.get('th', 0.0)) * 1.3 + rng.normal(0, 0.35)      # neighbours wave together
            G = add_wave(G, amp, fq, ph0, lat, start=0.4)
        if d['flick']:
            G = flick(G, H, d['flick'])
        G = restore_lengths(G, L0)
        G = collide(H, G, (d['margin'][0], d['margin'][1]))
        # relax kinks left by collisions (a sharp bend folds a wide lock inside-out)
        from .core import smooth_poly
        for _ in range(3):
            G = collide(H, smooth_poly(G, 4), d['margin'])
        d['guide'] = G
    return designs, fly


MATCH_DEFAULTS = {
    'z_tip': 1.48, 'z_tip_side': 1.51, 'off_scale': 1.0, 'top_volume': 0.12, 'width_scale': 1.0, 'flare': 0.0,
    'wave_amp': 0.03, 'wave_freq': 1.0, 'depth_wave': 0.35, 'flick': 0.18, 'fork_p': 0.6, 'tip_spread': 0.28,
    'tip_start': 0.7, 'tip_jag': 0.025, 'quiff_rise': 0.012, 'curtain_front': -0.25,
    'shoulder_back': 1.4, 'side_front': 0.0, 'n_fringe': 0, 'fringe_drop': 0.06, 'fringe_side': -0.05,
    'crown_spike': 0.0, 'hull': '', 'hull_inset': 0.012, 'traced': '', 'traced_wave': 0.0, 'traced_root_max': 0.10, 'traced_mode': 'add',
    'n_top': 15, 'n_crown': 10, 'n_back0': 13, 'n_back1': 12, 'n_side': 4, 'n_wild': 8, 'wild_amp': 0.04,
}


def wild_swept_back_mass(head, rng, ref=None, **kw):
    """Long wild swept-back hair laid on nested hair MASSES (streamlines, no collision fights): layer order
    under -> mid -> top -> crown -> wild accents. Every shape decision is a parameter (MATCH_DEFAULTS) so the
    reference matcher (tools/ref_match.py) can search them."""
    from .core import HairMass, streamline
    P = dict(MATCH_DEFAULTS, **{k: v for k, v in kw.items() if k in MATCH_DEFAULTS})
    H = head
    designs = []
    J = lambda s: rng.normal(0, s)
    o = P['off_scale']; cf = P['curtain_front']; fl = P['flare']
    M = lambda off, tv=0.0: HairMass(H, off * o, top_volume=tv, curtain_front=cf, flare=fl)
    masses = {'under0': M(0.011), 'under1': M(0.017), 'mid': M(0.038, 0.1), 'top': M(0.026, P['top_volume']),
              'crown': M(0.03, P['top_volume'] * 0.8), 'wild': M(0.05, 0.1)}
    if P['hull']:
        from .core import VoxelMass
        hi = P['hull_inset']
        # reference-carved hull: outer layers ON it, inner layers inset (layer order kept, silhouette = reference)
        masses.update({'under0': VoxelMass(H, P['hull'], hi * 3.5), 'under1': VoxelMass(H, P['hull'], hi * 2.5), 'mid': VoxelMass(H, P['hull'], hi * 1.2),
                       'top': VoxelMass(H, P['hull'], hi * 0.5), 'crown': VoxelMass(H, P['hull'], hi * 0.5),
                       'wild': VoxelMass(H, P['hull'], 0.0)})
    ws = P['width_scale']

    def forks():
        return int(rng.choice([2, 3])) if rng.random() < P['fork_p'] else 1

    def add(th, ph, mass, layer, width, z_end, tone, rise=0.0, wave=None, flk=None, front=False):
        root, n0 = H.root(th, ph, 0.0015)
        G = streamline(masses[mass], root, z_end, root_rise=rise, shoulder_back=P['shoulder_back'] * (0 if front else 1),
                       allow_front=front)
        if len(G) < 8:
            return
        designs.append(dict(guide=resample(G, N_PTS), th=th, ph=ph, layer=layer, width=width * ws, tips=forks(),
                            wave=wave or (P['wave_amp'], P['wave_freq']), flick=P['flick'] if flk is None else flk,
                            per_guide=10, clump=0.6, tone=tone, chain=True, tip_start=P['tip_start'], wrap=0.22,
                            tip_spread=P['tip_spread'], spread=width * ws * 0.5,
                            margin=(masses[mass].off * 0.5, masses[mass].off), mass=masses[mass]))
    zt = lambda: P['z_tip'] + J(P['tip_jag'])
    traced = None
    if P['traced']:
        z = np.load(P['traced'], allow_pickle=True)
        traced = list(zip(z['curves'], z['widths']))
    if traced is not None:
        # LOCK TRACING: the drawn locks themselves, lifted onto the reference hull; roots attached to the scalp
        for C, w in traced:
            C = np.asarray(C, float)
            # root = the nearest scalp point ABOVE the hairline; locks whose drawn top is far from any scalp point
            # are mid-lock fragments (the under layers carry them) -> dropped
            d_best, rb = 1e9, None
            for th_ in range(-180, 180, 6):
                for ph_ in range(int(hairline_ph(th_)) + 2, 88, 6):
                    r_, n_ = H.root(float(th_), float(ph_), 0.0015)
                    dd = np.linalg.norm(r_ - C[0])
                    if dd < d_best:
                        d_best, rb, th_b, ph_b = dd, (r_, n_), th_, ph_
            if rb is None or d_best > P['traced_root_max']:
                continue
            root, n0 = rb
            lead = resample(np.array([root, root + n0 * 0.012, C[0]]), 8)
            mm = masses['top']
            for i in range(1, len(lead)):
                if mm.sdf(lead[i]) < 0:
                    lead[i] = mm.project(lead[i])          # the root segment runs OVER the head mass, never the face
            th, ph_r = float(th_b), float(ph_b)
            G = smooth_poly(resample(np.vstack([lead, C[1:]]), N_PTS), 2)
            designs.append(dict(guide=G, th=float(th), ph=ph_r, layer='top', width=float(w) * ws, tips=forks(),
                                wave=(P['traced_wave'], P['wave_freq']), flick=0.0, per_guide=10, clump=0.6, tone=0.2,
                                chain=True, tip_start=P['tip_start'], wrap=0.22, tip_spread=P['tip_spread'],
                                spread=float(w) * ws * 0.5, margin=(0.006, 0.012), mass=None))
        if P['traced_mode'] == 'replace':
            P['n_side'] = P['n_top'] = P['n_crown'] = P['n_fringe'] = P['n_wild'] = 0
        else:                                           # 'add': the style gives coverage, the drawn locks lie on top
            for d in designs:
                d['layer'] = 'front'
                d['margin'] = (0.01, 0.018)
    for row, (ph, n, mass) in enumerate(((-4.0, int(P['n_back0']), 'under0'), (24.0, int(P['n_back1']), 'under1'))):
        for th in np.linspace(98, 262, n):
            th = ((th + J(2) + 180) % 360) - 180
            add(th, ph + J(2), mass, 'under', 0.08 * rng.uniform(0.94, 1.06), zt() + 0.02 * row, -0.7 + 0.35 * row)
    for side in (-1, 1):
        for th in np.linspace(66, 112, int(P['n_side'])):
            front = rng.random() < P['side_front'] and th < 90       # a share of the side locks falls IN FRONT of the shoulder
            add(side * (th + J(2)), rng.uniform(14, 24), 'mid', 'mid', rng.uniform(0.062, 0.07),
                P['z_tip_side'] + J(P['tip_jag']), -0.15, front=front)
    for th in np.linspace(-64, 64, int(P['n_top'])):
        add(th + J(1.5), hairline_ph(th) + rng.uniform(1.5, 3.0), 'top', 'top', rng.uniform(0.052, 0.06), zt() + 0.02,
            0.25, rise=P['quiff_rise'])
    nc = int(P['n_crown'])
    for th in np.linspace(-180, 180, nc + 1)[:-1] + 18:
        add(th + J(4), rng.uniform(56, 68), 'crown', 'top', rng.uniform(0.058, 0.066), zt() + 0.03, 0.3)
    # fringe: locks from the front hairline that fall FORWARD over the forehead and curve to one side
    for k in range(int(P['n_fringe'])):
        th = rng.uniform(-18, 12)
        root, n0 = H.root(th, hairline_ph(th) + 6, 0.0015)
        side = P['fringe_side']
        pts = np.array([root, root + n0 * 0.02 + np.array([side * 0.2, -0.01, 0.015]),
                        root + np.array([side * 0.5, -0.035, -0.02]),
                        root + np.array([side * 0.85, -0.03, -P['fringe_drop']]),
                        root + np.array([side * 1.25, -0.012, -P['fringe_drop'] * 1.5 - 0.01 * k])])
        G = resample(np.vstack([resample(pts, 60)]), N_PTS)
        mm = masses['top']
        for i in range(1, len(G)):
            if mm.sdf(G[i]) < 0:
                G[i] = mm.project(G[i])
        designs.append(dict(guide=G, th=th, ph=0, layer='front', width=0.04 * ws, tips=2, wave=(0.008, 1.0), flick=0.1,
                            per_guide=9, clump=0.6, tone=0.2, chain=True, tip_start=0.55, wrap=0.2, tip_spread=P['tip_spread'],
                            spread=0.02, margin=(0.01, 0.02), mass=None))
    nw = int(P['n_wild'])
    for th in list(rng.uniform(70, 150, nw // 2)) + list(-rng.uniform(70, 150, nw - nw // 2)):
        add(th, rng.uniform(30, 55), 'wild', 'top', rng.uniform(0.035, 0.045), zt() + rng.uniform(0.02, 0.08), 0.35,
            wave=(P['wild_amp'], 1.4), flk=P['flick'] * 1.6)
    if ref is not None:
        Gs = fit_width_to_ref([d['guide'] for d in designs], ref, H, strength=0.5)
        for d, G in zip(designs, Gs):
            d['guide'] = G
    lat = _lat_axis
    for d in designs:
        G = d['guide']
        L0 = np.linalg.norm(np.diff(G, axis=0), axis=1)
        amp, fq = d['wave']
        ph0 = math.radians(d.get('th', 0.0)) * 1.3 + rng.normal(0, 0.3)
        G = add_wave(G, amp, fq, ph0, lat, start=0.35)
        if P['depth_wave']:
            # depth wave bulges OUTWARD only (an inward wave pushed locks into the cheek: skin poke-through)
            n_ax = _normal_axis(H)(G, unit(np.gradient(G, axis=0)))
            tt = np.linspace(0, 1, len(G))
            G = G + (amp * P['depth_wave'] * 0.5 * (1 + np.sin(2 * np.pi * fq * 0.6 * tt + ph0 + 1.3))
                     * smoothstep(0.55, 1.0, tt))[:, None] * n_ax
        G = flick(G, H, d['flick'], start=0.8)
        if P['crown_spike'] and d['layer'] == 'top' and d.get('ph', 0) > 50:
            G = flick(G, H, P['crown_spike'], start=0.55, up=1.0)
        G = restore_lengths(G, L0)
        m = d.get('mass')
        if m is not None:
            for i in range(1, len(G)):
                if m.sdf(G[i]) < -0.001:
                    G[i] = m.project(G[i])
            G = smooth_poly(G, 2)
        d['guide'] = G
    return designs, []


STYLES = {'wild_swept_back': wild_swept_back, 'wild_swept_back_mass': wild_swept_back_mass}
