"""Garment generators driven by the drawing (numpy; no Blender):

  hood_collar()   an open / wide hood or collar drawn with a CONTRASTING LINING fanned over the shoulders (Ren's big
                  orange-lined hood): a new collar shell (lining side up, a dark rim band, the jacket colour outside)
                  from the drawn silhouette + colours, sitting on the jacket, replacing the base's own hood.
  drawn_accessory() a neck accessory as drawn (an off-centre knotted scarf, a tie, a ribbon): the drawn shape and art as
                  a thin, slightly puffed shell conforming to the chest -- instead of the base's generic bow.

Both are added as skinned mesh parts with their own MToon material (assemble._add_part / _mat). glTF space: +x =
character's right (viewer's left), -z = front, y up.
"""
import os

import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from scipy.spatial import cKDTree

from .render import render_pose, View


def _hex(c):
    return '#%02x%02x%02x' % tuple(int(np.clip(v, 0, 1) * 255) for v in c[:3])


def _kmeans(px, k=4, iters=15, seed=0):
    px = np.asarray(px, float)[:: max(1, len(px) // 30000)]
    rng = np.random.default_rng(seed)
    cent = px[rng.choice(len(px), k, replace=False)]
    for _ in range(iters):
        lab = ((px[:, None] - cent[None]) ** 2).sum(-1).argmin(1)
        for j in range(k):
            if (lab == j).any():
                cent[j] = np.median(px[lab == j], 0)
    cnt = np.bincount(lab, minlength=k) / len(px)
    return cent, cnt


def _sat(c):
    return float(c.max() - c.min())


def _lum(c):
    return float(np.dot(c[:3], [0.3, 0.59, 0.11]))


def _surface(m, names=('Body',), prefix='Outfit_'):
    P = []
    for n in m.J['nodes']:
        nm = n.get('name', '')
        if 'mesh' in n and (nm in names or nm.startswith(prefix)):
            d = m.read_mesh(n['mesh'])
            used = d.verts_of(list(range(len(d.prims))))
            P.append(d.P[used])
    return np.concatenate(P) if P else np.zeros((0, 3))


def _joint_weights(m, node, d, pred):
    js = m.skin_joints(node['skin'])
    hit = np.array([pred(m.J['nodes'][j].get('name', '')) for j in js])
    W = d.W / np.maximum(d.W.sum(1, keepdims=True), 1e-9)
    return (W * hit[d.J]).sum(1)


def _drop_tris(m, ni, keep_vert):
    """remove the triangles of a node's mesh that touch a vertex with keep_vert == False"""
    node = m.J['nodes'][ni]
    d = m.read_mesh(node['mesh'])
    removed = 0
    for p in d.prims:
        t = p['indices'].reshape(-1, 3)
        ok = keep_vert[t].all(1)
        removed += int((~ok).sum())
        p['indices'] = t[ok].reshape(-1).astype(np.uint32)
    m.write_mesh(node['mesh'], d)
    return removed


def _grid_normals(G):
    """vertex normals of a (n, m, 3) grid surface"""
    du = np.gradient(G, axis=0); dv = np.gradient(G, axis=1)
    N = np.cross(du, dv)
    return N / np.maximum(np.linalg.norm(N, axis=-1, keepdims=True), 1e-12)


def _grid_tris(n, k, off=0, flip=False):
    T = []
    for i in range(n - 1):
        for j in range(k - 1):
            a, b, c, d = off + i * k + j, off + (i + 1) * k + j, off + (i + 1) * k + j + 1, off + i * k + j + 1
            T += [(a, b, c), (a, c, d)] if not flip else [(a, c, b), (a, d, c)]
    return np.array(T, np.int64)


# ------------------------------------------------------------------------------------------------ hood / collar
def drawn_collar(A, R, art, view, log=print):
    """measure an open collar / hood with a contrasting lining in the drawing: None, or its colours and 3D extents"""
    chin2, sh2 = R.ys2[0], R.ys2[1]
    top_c = [c for c in ((getattr(A, 'outfit', {}) or {}).get('top') or {}).get('colors', []) if c != 'skin']
    if not top_c:
        return None
    main = np.array([int(top_c[0][i:i + 2], 16) / 255 for i in (1, 3, 5)])
    y0, y1 = chin2 - 0.1 * (sh2 - chin2), sh2 + 0.8 * (sh2 - chin2)
    r0, r1 = [int(round(v)) for v in view.px([[0, y0], [0, y1]])[:, 1]]
    r0, r1 = max(r0, 0), min(r1, art.shape[0])
    ipd_px = A.ipd * view.scale
    cx = view.px([[A.mid_x, 0]])[0, 0]
    reg = art[r0:r1]
    xs = np.arange(art.shape[1])[None, :] - cx
    ok = (reg[..., 3] > 0.5) & (np.abs(xs) > 0.45 * ipd_px)
    skin = np.asarray(A.skin_rgb, float)
    ok &= np.linalg.norm(reg[..., :3] - skin, axis=-1) > 0.15
    px = reg[..., :3][ok]
    if len(px) < 500:
        return None
    cent, cnt = _kmeans(px, 4)
    # lining: a saturated colour clearly unlike the jacket, covering a good share of the collar region
    cands = [(j, _sat(cent[j])) for j in range(len(cent)) if cnt[j] > 0.12 and _sat(cent[j]) > 0.25
             and np.linalg.norm(cent[j] - main) > 0.3]
    if not cands:
        return None
    li = max(cands, key=lambda t: t[1] * cnt[t[0]])[0]
    lining = cent[li]
    dark = [j for j in range(len(cent)) if j != li and _lum(cent[j]) < 0.3 and cnt[j] > 0.05]
    band = cent[min(dark, key=lambda j: _lum(cent[j]))] if dark else np.clip(main * 0.25, 0, 1)
    lab = ((reg[..., :3][..., None, :] - cent[None, None]) ** 2).sum(-1).argmin(-1)
    lm_ = ok & (lab == li)
    bi = int(np.argmin([np.linalg.norm(cent[j] - band) for j in range(len(cent))]))
    lb_ = ok & ((lab == li) | (lab == bi))          # lining + its dark rim band: the collar's full extent
    rows = np.nonzero(lm_.any(1))[0]
    if len(rows) < 5:
        return None
    # extents (drawn units -> metres with the chest band's scale), sides and top
    xs_l = np.nonzero(lb_[rows.min():rows.max() + 1].any(0))[0]
    half2 = max(abs(xs_l.min() - cx), abs(xs_l.max() - cx)) / view.scale
    s = float(R.scale_at(R.ys3[1] - 0.05))
    top_row = r0 + rows.min()
    top_y2 = view.model([[0, top_row]])[0, 1]
    # fur trim vs a cloth lining: the drawn outline of the colour region -- fur is drawn as spiky tufts (a long,
    # jagged outline for its area), a lining as a smooth band
    import cv2
    big = ndi.binary_opening(lm_, iterations=2)
    lab2, n2 = ndi.label(big)
    spiky = 0.0
    if n2:
        sizes = ndi.sum(big, lab2, range(1, n2 + 1))
        comp = (lab2 == (int(np.argmax(sizes)) + 1)).astype(np.uint8)
        cs, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        if cs:
            c = max(cs, key=cv2.contourArea)
            hull = cv2.convexHull(c)
            per, hper = cv2.arcLength(c, True), cv2.arcLength(hull, True)
            spiky = float(per / max(hper, 1e-6))              # jagged outline >> its convex hull
    spec_fur = spiky > 1.45
    spec = {'lining': lining, 'band': band, 'outer': main, 'half_w': float(half2 * s), 'fur': spec_fur,
            'spiky': spiky,
            'top_y3': float(R.y2_to_y3(top_y2)) if hasattr(R, 'y2_to_y3') else None,
            'share': float(cnt[li])}
    log(f"collar: drawn {'FUR' if spec_fur else 'lining'} {_hex(lining)} (outline / hull {spiky:.2f}; {cnt[li]:.0%} of the collar region), band {_hex(band)}, outer "
        f"{_hex(main)}, half width {spec['half_w']:.3f} m")
    return spec


def hood_collar(m, A, R, art, view, out_dir, add_part, make_mat, log=print):
    spec = drawn_collar(A, R, art, view, log)
    if spec is None:
        return False
    tops = m.byname.get('Outfit_Tops')
    if tops is None or 'mesh' not in m.J['nodes'][tops]:
        return False
    node = m.J['nodes'][tops]
    d = m.read_mesh(node['mesh'])
    hood = _joint_weights(m, node, d, lambda n: 'Hood' in n)
    neck = m.pos('J_Bip_C_Neck'); chest = m.pos('J_Bip_C_UpperChest')
    sh3, chin3 = R.ys3[1], R.ys3[0]
    # the base's hood and everything of the top standing up around the neck goes first (the generated collar replaces
    # it; leftovers would poke through the lining)
    y_cut = sh3 + 0.005
    rr = np.hypot(d.P[:, 0] - neck[0], d.P[:, 2] - neck[2])
    ang = np.degrees(np.arctan2(d.P[:, 0] - neck[0], -(d.P[:, 2] - neck[2])))      # 0 = front
    gone = (hood > 0.3) | ((d.P[:, 1] > y_cut + 0.01) & (rr < 0.72 * min(0.26, spec["half_w"] * 1.2))
                           & ((np.abs(ang) > 50) | (d.P[:, 1] > y_cut + 0.015)))
    removed = _drop_tris(m, tops, ~gone)
    B = _surface(m)
    # the neck: body verts between the shoulders and the chin
    bd = m.read_mesh(m.J['nodes'][m.byname['Body']]['mesh']).P if 'Body' in m.byname else B
    nb = bd[(bd[:, 1] > chin3 - 0.07) & (bd[:, 1] < chin3 - 0.02) & (np.abs(bd[:, 0]) < 0.09)]
    r_neck = float(np.percentile(np.hypot(nb[:, 0] - neck[0], nb[:, 2] - neck[2]), 75)) if len(nb) > 20 else 0.05
    r_neck = float(np.clip(r_neck, 0.04, 0.07))
    r_b = r_neck + 0.022
    y_b = sh3 + 0.005
    # the drawn half width is where the lining + band END in the front picture: the rim lies a bit further out on the
    # shoulder (seen from the front the collar's outer part turns away)
    r_side = float(np.clip(spec['half_w'] * 1.3, r_b + 0.05, 0.28))
    y_side = float(np.clip(spec['top_y3'] if spec['top_y3'] else y_b + 0.05, y_b + 0.02, chin3 - 0.005))
    y_back = float(min(chin3 + 0.06, y_side + 0.09))    # a hood stands higher behind the neck
    r_back = r_b + 0.07
    open_half = np.radians(38.0)
    ths = np.linspace(open_half, 2 * np.pi - open_half, 72)          # 0 = front (-z)
    vs = np.linspace(0, 1, 18)
    tree = cKDTree(B[:, [0, 2]])
    inner = np.zeros((len(ths), len(vs), 3))
    y_sh_top = sh3 + 0.03                              # the top of the shoulders under the jacket
    # a STANDING open hood / collar (the drawing shows its lining up to the jaw on both sides of the neck): a funnel
    # rising from the neck base outward and up to the drawn top, highest behind the neck, open and low at the front
    y_top_side = float(max(y_side, chin3 + 0.02))       # an open hood: its rim reaches past the jaw at the sides,
    y_top_back = float(chin3 + 0.07)                    # stands up behind the head (a straight cone about 40
    r_side = float(np.clip(r_side * 1.1, r_b + 0.08, 0.24))   # degrees off vertical, never a flat plate / ruff)
    fur = bool(spec.get('fur'))
    if not fur:
        return _hood_roll(m, spec, neck, r_b, y_b, chin3, sh3, B, tree, out_dir, add_part, make_mat, removed, log)
    if fur:                                            # a fur trim: a low, thick, jagged ruff over the shoulders
        y_top_side = float(y_b + 0.07); y_top_back = float(y_b + 0.1)
        r_side = float(max(r_side, r_b + 0.1))
    for i, th in enumerate(ths):
        side = abs(np.sin(th)); back = max(0.0, -np.cos(th)); front = max(0.0, np.cos(th))
        wsum = side ** 1.2 + back ** 1.2 + front ** 2
        mixw = lambda a, b_, c: (a * side ** 1.2 + b_ * back ** 1.2 + c * front ** 2) / max(wsum, 1e-6)
        r_rim = max(mixw(r_side, r_back, r_b + 0.04), r_b + 0.03)
        y_rim = mixw(y_top_side, y_top_back, y_b + 0.035)
        dx, dz = np.sin(th), -np.cos(th)
        # the sides lean BACK as they rise: the lining faces forward (the drawing shows it from the front, fanned
        # around the neck like a big turned-out collar), not up the axis of a funnel
        lean = 0.0 if fur else 0.09 * side ** 1.5
        if fur:                                        # tufts: a sawtooth rim, 16 spikes round the neck
            ph_ = (th * 16 / (2 * np.pi)) % 1.0
            r_rim = r_rim * (0.85 + 0.35 * (1 - abs(2 * ph_ - 1)) ** 2)
            y_rim = y_rim + 0.03 * (1 - abs(2 * ph_ - 1)) ** 2
        for j, v in enumerate(vs):
            r = r_b + (r_rim - r_b) * (v ** 1.3 if not fur else v ** 1.8)   # a straight, slightly opening cone
            y = y_b + (y_rim - y_b) * (v ** 0.9 if not fur else (1 - (1 - v) ** 1.7))
            if not fur:                                # behind the neck the lowered hood is a rounded bag: its top
                q = float(np.clip((v - 0.5) / 0.5, 0, 1))  # half curls back in toward the head (no open cone there)
                close = 0.55 * back ** 2 * q * q * (3 - 2 * q)
                r = r - (r - (r_b + 0.02)) * close
            zb = lean * v ** 1.5                            # glTF +z = behind
            x, z = neck[0] + dx * r, neck[2] + dz * r + zb
            # never inside the jacket / body: stay 8 mm above the highest surface point under it
            near = tree.query_ball_point([x, z], 0.015)
            if near:
                ys = B[near, 1]
                ys = ys[ys < y + 0.12]
                if len(ys):
                    y = max(y, float(ys.max()) + 0.008)
            inner[i, j] = (x, y, z)
    # smooth along the ring (the lift above the jacket is bumpy)
    for _ in range(3):
        inner[1:-1] = 0.25 * inner[:-2] + 0.5 * inner[1:-1] + 0.25 * inner[2:]
    Ni = _grid_normals(inner)
    rad = inner - np.array([neck[0], 0, neck[2]])
    rad[..., 1] = 0
    if (Ni * rad).sum(-1).mean() > 0:                   # the lining faces the neck (inward / up)
        Ni = -Ni
    outer = inner - Ni * (0.02 if fur else 0.006)
    No = -Ni
    n, k = inner.shape[:2]
    P = np.concatenate([inner.reshape(-1, 3), outer.reshape(-1, 3)])
    N = np.concatenate([Ni.reshape(-1, 3), No.reshape(-1, 3)])
    vv = np.tile(vs, n)
    UV = np.concatenate([np.stack([np.full(n * k, 0.25), vv], 1), np.stack([np.full(n * k, 0.75), vv], 1)])
    T1 = _grid_tris(n, k, 0)
    T2 = _grid_tris(n, k, n * k, flip=True)
    # orient: inner triangles' geometric normal along Ni
    tri = P[T1]
    gn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    if (gn * N[T1[:, 0]]).sum(1).mean() < 0:
        T1 = T1[:, [0, 2, 1]]; T2 = T2[:, [0, 2, 1]]
    # rim strip joining inner and outer at v = 1
    rim = []
    for i in range(n - 1):
        a, b = i * k + (k - 1), (i + 1) * k + (k - 1)
        rim += [(a, b, n * k + b), (a, n * k + b, n * k + a)]
    T = np.concatenate([T1, T2, np.array(rim, np.int64)])
    # texture: column 0 = lining (inner) -> band near the rim, column 1 = outer colour -> band near the rim
    H = 64
    if fur:                                            # fur: the trim colour both sides, lighter toward the tips
        spec = dict(spec); lin = np.asarray(spec['lining'], float)
        spec['band'] = np.clip(lin + (1 - lin) * 0.45, 0, 1); spec['outer'] = np.clip(lin * 0.85, 0, 1)
    tex = np.zeros((H, 2, 4), np.uint8)
    for rr in range(H):
        v = (rr + 0.5) / H
        tex[rr, 0, :3] = (np.clip(spec['band'] if v > 0.86 else spec['lining'], 0, 1) * 255).astype(np.uint8)
        tex[rr, 1, :3] = (np.clip(spec['outer'] if 0.3 < v < 0.36 else spec['band'], 0, 1) * 255).astype(np.uint8)
    tex[..., 3] = 255
    os.makedirs(out_dir, exist_ok=True)
    png = os.path.join(out_dir, 'collar.png')
    Image.fromarray(np.repeat(np.repeat(tex, 4, 0), 8, 1)).save(png)
    # skin: the chest, the shoulders at the sides
    bones = ['J_Bip_C_UpperChest', 'J_Bip_L_Shoulder', 'J_Bip_R_Shoulder']
    Jn = np.zeros((len(P), 4), np.int32); W = np.zeros((len(P), 4), np.float32)
    for q in range(len(P)):
        x = P[q, 0]; sw = float(np.clip((abs(x) - 0.08) / 0.1, 0, 0.6))
        Jn[q] = [0, 1 if x > 0 else 2, 0, 0]          # +x = character's right = J_Bip_R? (VRM0 L = +x)
        W[q] = [1 - sw, sw, 0, 0]
    # VRM0: J_Bip_L_* sit at +x in glTF space -> left shoulder for +x
    part = {'P': P.astype(np.float32), 'N': N.astype(np.float32), 'UV': UV.astype(np.float32), 'J': Jn, 'W': W,
            'T': T.astype(np.int32), 'M': np.zeros(len(T), np.int32), 'mat_names': np.array(['L2D_Collar']),
            'bones': np.array(bones)}
    lx = m.pos('J_Bip_L_Shoulder')[0]
    if lx < 0:                                        # left shoulder at -x: swap the side mapping
        part['J'][:, 1] = np.where(P[:, 0] > 0, 2, 1)
    add_part(m, part, 'Outfit_Collar', lambda mn: make_mat(png, 'L2D_Collar'), log)
    # the base hood goes (the drawn one replaces it); the jacket's own collar near the neck stays
    log(f'collar: standing open hood (sides to y {y_top_side:.3f}, back to y {y_top_back:.3f}); ' f'open collar generated (neck r {r_neck:.3f}, sides r {r_side:.3f} at y {y_side:.3f}, back y {y_back:.3f});'
        f' base hood removed ({removed} tris)')
    return True


def _hood_roll(m, spec, neck, r_b, y_b, chin3, sh3, B, tree, out_dir, add_part, make_mat, removed, log,
               n_th=80, n_ph=20):
    """a LOWERED HOOD the way a modeller builds one: a fat soft roll swept round the neck (a rounded cross-section on
    a path round the neck base, open at the front where the zip opens), low and slim at the front, big and tall behind
    the neck where the hood's bag bunches up. Its inner face (toward the neck / up) is the drawn LINING, the outer
    face the drawn shell colour, the drawn rim band where they meet on top -- so the front view shows the lining
    framing the jaw and the side / back views a soft hood roll, never a plate."""
    open_half = np.radians(34.0)
    ths = np.linspace(open_half, 2 * np.pi - open_half, n_th)          # 0 = front (-z)
    phs = np.linspace(-np.pi, np.pi, n_ph)                             # 0 = outward, +pi/2 = up, +-pi = toward neck
    G = np.zeros((n_th, n_ph, 3)); Ph = np.zeros((n_th, n_ph))
    h_side = max(chin3 - 0.005 - y_b, 0.05)             # the roll's top at about the jaw beside the neck ...
    h_back = max(chin3 + 0.035 - y_b, h_side + 0.03)    # ... and up behind it (the hood's bag)
    r_side = float(np.clip(spec['half_w'] * 1.12, r_b + 0.06, r_b + 0.13))       # (x1.35 read as a cape in review)
    for i, th in enumerate(ths):
        back = max(0.0, -np.cos(th)); side = abs(np.sin(th)); front = max(0.0, np.cos(th))
        end = float(np.clip((min(th, 2 * np.pi - th) - open_half) / np.radians(22), 0, 1))
        end = end * end * (3 - 2 * end)                 # the sheet tapers shut at its two front ends
        wb = back ** 1.5
        # the section: a thick rounded SHEET from the neck base (inner bottom) up and out to the rim (outer top) --
        # a standing collar that opens outward beside the neck (its lining facing the viewer) and stands taller,
        # thicker and closer to the head behind it (the hood's bag)
        r_rim = (r_side * (1 - wb) + (r_b + 0.05) * wb)
        y_rim = y_b + (h_side * (1 - wb) + h_back * wb) * (0.6 + 0.4 * end) * (1 - 0.3 * front)
        thick = (0.012 + 0.022 * wb) * (0.4 + 0.6 * end)
        dxz = np.array([np.sin(th), -np.cos(th)])
        # behind the neck the hood lies down the upper back (where the base's hood was cut away)
        p0 = np.array([r_b + 0.004 + 0.045 * wb, y_b - 0.06 * wb]); p1 = np.array([r_rim + 0.02 * wb, y_rim])
        # sit on the shoulders / back under the sheet's foot (8 mm clear of the jacket)
        fx, fz = neck[0] + dxz[0] * (r_b + 0.02), neck[2] + dxz[1] * (r_b + 0.02)
        near = tree.query_ball_point([fx, fz], 0.03)
        if near:
            ys = B[near, 1]; ys = ys[ys < y_b + 0.1]
            if len(ys):
                lift = max(0.0, float(ys.max()) + 0.008 - y_b)
                p0[1] += lift; p1[1] += lift * 0.5
        cen = (p0 + p1) / 2; ax = (p1 - p0) / 2
        nrm = np.array([-ax[1], ax[0]]); nrm /= np.linalg.norm(nrm) + 1e-9    # (radial, up) normal of the sheet
        if nrm[1] < 0:
            nrm = -nrm                                   # +nrm = the inner / up side (the lining)
        for j, ph in enumerate(phs):
            q = cen + np.cos(ph) * ax * 1.0 + np.sin(ph) * nrm * thick
            G[i, j] = (neck[0] + dxz[0] * q[0], q[1], neck[2] + dxz[1] * q[0])
            Ph[i, j] = ph
    for _ in range(2):                                  # smooth along the ring (the shoulder lift is bumpy)
        G[1:-1] = 0.25 * G[:-2] + 0.5 * G[1:-1] + 0.25 * G[2:]
    # the base top's pieces standing up UNDER the sheet (collar stands, shoulder seams) would poke through its shell
    # as white shards: everything of the top inside the sheet's footprint and above its foot goes
    try:
        ti = m.byname.get('Outfit_Tops')
        if ti is not None and 'mesh' in m.J['nodes'][ti]:
            TP = m.read_mesh(m.J['nodes'][ti]['mesh']).P
            tth = np.arctan2(TP[:, 0] - neck[0], -(TP[:, 2] - neck[2])) % (2 * np.pi)
            trr = np.hypot(TP[:, 0] - neck[0], TP[:, 2] - neck[2])
            foot = np.interp(tth, ths, G[:, :, 1].min(1))
            rim = np.interp(tth, ths, np.hypot(G[:, :, 0] - neck[0], G[:, :, 2] - neck[2]).max(1))
            inside = (tth > open_half) & (tth < 2 * np.pi - open_half) & (trr < rim - 0.004) & (TP[:, 1] > foot + 0.006)
            n_in = _drop_tris(m, ti, ~inside) if inside.any() else 0
            removed += n_in
    except Exception:
        pass
    N = _grid_normals(G)
    ctr = G.mean(1, keepdims=True)
    if (N * (G - ctr)).sum(-1).mean() < 0:
        N = -N
    P = G.reshape(-1, 3); Nf = N.reshape(-1, 3)
    # texture rows by phi: outer shell (below / outside) -> rim band on top -> lining (toward the neck)
    ph = Ph.reshape(-1)
    v = (ph + np.pi) / (2 * np.pi)                      # 0 .. 1 around the section
    UV = np.stack([np.full(len(P), 0.5), 1 - v], 1)
    T = _grid_tris(n_th, n_ph)
    tri = P[T]; gn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    if (gn * Nf[T[:, 0]]).sum(1).mean() < 0:
        T = T[:, [0, 2, 1]]
    H = 128
    tex = np.zeros((H, 4, 4), np.float32); tex[..., 3] = 1
    lin, band, outer = (np.asarray(spec[k], float) for k in ('lining', 'band', 'outer'))
    for r in range(H):
        vv = 1 - (r + 0.5) / H
        phv = vv * 2 * np.pi - np.pi
        # (drawn_collar: 'band' = the dark shell seen round the lining, 'outer' = the light edge / jacket colour)
        if np.sin(phv) > 0.2:                           # the inner / up side of the sheet: the lining
            c = lin
        else:                                           # the hood's shell (a light rim stripe read as floating
            c = band                                    # white 'decals' at the sheet's ends in review)
        tex[r, :, :3] = c
    os.makedirs(out_dir, exist_ok=True)
    png = os.path.join(out_dir, 'collar.png')
    Image.fromarray((np.repeat(np.repeat(tex, 2, 0), 8, 1) * 255).astype(np.uint8)).save(png)
    bones = ['J_Bip_C_UpperChest', 'J_Bip_L_Shoulder', 'J_Bip_R_Shoulder']
    Jn = np.zeros((len(P), 4), np.int32); W = np.zeros((len(P), 4), np.float32)
    lx = m.pos('J_Bip_L_Shoulder')[0]
    for q in range(len(P)):
        x = P[q, 0]; sw = float(np.clip((abs(x) - 0.08) / 0.1, 0, 0.6))
        Jn[q] = [0, 1 if (x > 0) == (lx > 0) else 2, 0, 0]
        W[q] = [1 - sw, sw, 0, 0]
    part = {'P': P.astype(np.float32), 'N': Nf.astype(np.float32), 'UV': UV.astype(np.float32), 'J': Jn, 'W': W,
            'T': T.astype(np.int32), 'M': np.zeros(len(T), np.int32), 'mat_names': np.array(['L2D_Collar']),
            'bones': np.array(bones)}
    add_part(m, part, 'Outfit_Collar', lambda mn: make_mat(png, 'L2D_Collar'), log)
    log(f'collar: standing hood sheet round the neck (side height {h_side * 1000:.0f} mm, back {h_back * 1000:.0f} mm, '
        f'lining #{"".join(f"{int(x * 255):02x}" for x in lin)}); base hood removed ({removed} tris)')
    return True


# ------------------------------------------------------------------------------------------------ drawn accessory
def drawn_accessory(m, A, R, out_dir, add_part, make_mat, log=print, step_px=3):
    """the drawn neck accessory (scarf / ribbon / tie) as a thin shell conforming to the chest, textured with the
    drawing itself (puffed where the drawn shape is thick: knots, bows); replaces the base's neck accessory"""
    if 'Outfit_Accessory' not in m.byname or 'mesh' not in m.J['nodes'][m.byname['Outfit_Accessory']]:
        return False                                  # only replaces a base neck accessory (bow / tie)
    lm = A.lm; fb = lm['face_bbox']
    head_h = fb[3] - lm.get('crown', fb[1])
    P2 = A.pose.positions
    acc = {a for a, c in enumerate(A.cls) if c == 'accessory' and fb[3] - 0.1 * head_h < P2[a][:, 1].mean() < fb[3] + 0.8 * head_h}
    if not acc:
        return False
    allp = np.concatenate([P2[a] for a in acc])
    x0, y0 = allp.min(0); x1, y1 = allp.max(0)
    pad = 0.05 * (x1 - x0)
    view = View(A.model.moc.canvas, 360, (x0 - pad, y0 - pad, x1 + pad, y1 + pad))
    img, _ = render_pose(A.model, A.pose, view=view, ss=1, only=acc)
    a = img[..., 3]
    mask = a > 0.5
    if mask.sum() < 400:
        return False
    mask = ndi.binary_opening(mask, iterations=1)
    dist = ndi.distance_transform_edt(mask) / (A.ipd * view.scale)          # IPD units from the edge
    # 3D placement: drawn (x, y) -> glTF x / y through the garment register, z on the chest front
    B = _surface(m)
    tree = cKDTree(B[:, :2])
    H, W = mask.shape
    gy, gx = np.mgrid[0:H:step_px, 0:W:step_px]
    inside = ndi.binary_dilation(mask, iterations=step_px)[gy, gx]
    mdl = view.model(np.stack([gx + 0.5, gy + 0.5], -1).reshape(-1, 2))
    y3 = R.y2_to_y3(mdl[:, 1]) if hasattr(R, 'y2_to_y3') else None
    s = R.scale_at(y3)
    x3 = -(mdl[:, 0] - A.mid_x) * s
    # the drawing shows the accessory's full spread flattened onto the picture plane; wrapped round the neck /
    # chest it covers less width
    # the shell sits in FRONT of the body at the bust's scale, where perspective and the wrap make it read wider
    # than the drawing (reviews: "knot oversized, a wide central bib"): compressed about its OWN centre, so an
    # off-centre knot stays off-centre like the drawing
    x3 = x3.mean() + (x3 - x3.mean()) * 0.62
    y3 = y3.max() - (y3.max() - y3) * 0.85             # hangs from its knot: shorter tails, knot kept in place
    z3 = np.zeros(len(x3))
    ok = np.zeros(len(x3), bool)
    for q in range(len(x3)):
        near = tree.query_ball_point([x3[q], y3[q]], 0.012)
        if near:
            z3[q] = float(B[near, 2].min()); ok[q] = True
    if ok.sum() < 20:
        return False
    z3[~ok] = np.interp(np.nonzero(~ok)[0], np.nonzero(ok)[0], z3[ok])
    dd = dist[np.clip(gy.reshape(-1), 0, H - 1), np.clip(gx.reshape(-1), 0, W - 1)]
    puff = 0.004 + 0.008 * np.clip(dd / 0.35, 0, 1)   # a thin silk knot, not a padded bib
    z3 = ndi.gaussian_filter(z3.reshape(gy.shape), 1.2).reshape(-1) - puff
    Pg = np.stack([x3, y3, z3], 1).reshape(gy.shape + (3,))
    Ng = _grid_normals(Pg)
    if Ng[..., 2].mean() > 0:
        Ng = -Ng                                      # facing front (-z)
    n, k = gy.shape
    idx = -np.ones((n, k), np.int64)
    sel = inside.reshape(n, k)
    idx[sel] = np.arange(sel.sum())
    P = Pg[sel]; N = Ng[sel]
    UV = np.stack([(gx[sel] + 0.5) / W, (gy[sel] + 0.5) / H], 1)
    T = []
    for i in range(n - 1):
        for j in range(k - 1):
            q = [idx[i, j], idx[i + 1, j], idx[i + 1, j + 1], idx[i, j + 1]]
            if min(q) < 0:
                continue
            T += [(q[0], q[1], q[2]), (q[0], q[2], q[3])]
    T = np.array(T, np.int64)
    tri = P[T]
    gn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    if (gn * N[T[:, 0]]).sum(1).mean() < 0:
        T = T[:, [0, 2, 1]]
    os.makedirs(out_dir, exist_ok=True)
    png = os.path.join(out_dir, 'accessory.png')
    rgba = np.concatenate([np.clip(img[..., :3] / np.maximum(a[..., None], 1e-3), 0, 1), a[..., None]], -1)
    Image.fromarray((rgba * 255).astype(np.uint8)).save(png)
    Jn = np.zeros((len(P), 4), np.int32); Wt = np.zeros((len(P), 4), np.float32)
    up = np.clip((P[:, 1] - (R.ys3[1] - 0.02)) / 0.06, 0, 1)            # near the neck: follow the neck a little
    Jn[:, 1] = 1; Wt[:, 0] = 1 - 0.4 * up; Wt[:, 1] = 0.4 * up
    part = {'P': P.astype(np.float32), 'N': N.astype(np.float32), 'UV': UV.astype(np.float32), 'J': Jn, 'W': Wt,
            'T': T.astype(np.int32), 'M': np.zeros(len(T), np.int32), 'mat_names': np.array(['L2D_Accessory']),
            'bones': np.array(['J_Bip_C_UpperChest', 'J_Bip_C_Neck'])}
    add_part(m, part, 'Outfit_DrawnAccessory', lambda mn: make_mat(png, 'L2D_Accessory', cutout=True), log)
    log(f'accessory: drawn neck accessory as a {len(P)}-vertex shell (replaces the base bow / tie)')
    return True


# ------------------------------------------------------------------------------------------------ fur trim
def _hexrgb(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])


def fur_puffs(m, A, R, art, view, out_dir, add_part, make_mat, log=print, n_spikes=70, seed=3):
    """a spiky fur trim drawn as tuft balls on the shoulders (a star-burst outline in the colour of the outfit's trim):
    per drawn blob a ball of cone spikes radiating from its centre (lengths jittered, soft tips), radial normals (clean
    cel shading), trim colour at the root -> lighter at the tips; placed on the shoulder surface under the drawn blob"""
    import cv2
    trim = ((getattr(A, 'outfit', {}) or {}).get('trim') or {}).get('colors')
    if not trim:
        return False
    tc = _hexrgb(trim[0])
    art = getattr(A, 'trim_art', art)
    chin2, sh2 = R.ys2[0], R.ys2[1]
    head2 = abs(chin2 - A.lm.get('crown', A.lm['face_bbox'][1]))
    rgb = art[..., :3]
    m2 = (np.linalg.norm(rgb - tc, axis=-1) < 0.3) & (art[..., 3] > 0.5)
    rows = np.arange(m2.shape[0])[:, None]
    y0 = view.px([[0, chin2 - 0.1 * head2]])[0, 1]; y1 = view.px([[0, chin2 + 1.3 * head2]])[0, 1]
    m2 &= (rows > y0) & (rows < y1)
    m2 = ndi.binary_opening(m2, iterations=2)
    lab, n = ndi.label(m2)
    if n == 0:
        return False
    sizes = ndi.sum(m2, lab, range(1, n + 1))
    blobs = [i + 1 for i in np.argsort(-sizes)[:2] if sizes[i] > 0.15 * sizes.max()]
    # spiky outline? (fur, not a smooth lining)
    comp = (lab == blobs[0]).astype(np.uint8)
    cs, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    c = max(cs, key=cv2.contourArea)
    spiky = cv2.arcLength(c, True) / max(cv2.arcLength(cv2.convexHull(c), True), 1e-6)
    if spiky < 1.15:
        log(f'fur: trim region is smooth (outline / hull {spiky:.2f}) -- not fur')
        return False
    s = float(R.scale_at(R.ys3[1]))
    B = _surface(m)
    tree = cKDTree(B[:, [0, 2]])
    neck = m.pos('J_Bip_C_Neck')
    rng = np.random.default_rng(seed)
    P_all, N_all, UV_all, T_all, side_all = [], [], [], [], []
    k = 0
    # spike directions: a fibonacci sphere, flattened a little (tufts spread sideways more than up)
    ii = np.arange(n_spikes) + 0.5
    phi = np.arccos(1 - 2 * ii / n_spikes); th = np.pi * (1 + 5 ** 0.5) * ii
    D = np.stack([np.cos(th) * np.sin(phi), np.cos(phi), np.sin(th) * np.sin(phi)], 1)
    D[:, 1] *= 0.8
    D /= np.linalg.norm(D, axis=1, keepdims=True)
    placed = []
    meas = []
    for b in blobs:
        ys, xs = np.nonzero(lab == b)
        cx, cy = view.model([[xs.mean(), ys.mean()]])[0]
        area = len(xs) / view.scale ** 2
        meas.append((-(cx - A.mid_x) * s, float(np.sqrt(area / np.pi) * s)))
    # a trim is symmetric (the drawing's head tilt / crop makes one side look smaller): mirror the larger tuft
    r_ = float(np.clip(max(r for _, r in meas), 0.07, 0.12))
    # on the shoulders beside the neck (a stole / ruff), whatever the drawing's crop does to the apparent spread
    sh_x = abs(float(m.pos('J_Bip_L_UpperArm')[0]))
    xa = float(np.clip(np.mean([abs(x) for x, _ in meas]), 0.07, sh_x * 0.9))
    # a CONTINUOUS ruff (a fur-trimmed hood / collar goes all round the neck behind the head; the drawing only shows
    # its front ends as the two big tufts): tuft balls along an arc round the neck, open at the front where the
    # jacket opens, the drawn size at the front, a little smaller behind
    za = 0.8 * xa
    spots = []
    for deg in (68, 95, 122, 152, 180):               # (starting past the chin: a tuft at 50 deg hid the jaw)
        for sg in ((1, -1) if deg < 180 else (1,)):
            th_ = np.radians(deg)
            spots.append((sg * xa * np.sin(th_), neck[2] - za * np.cos(th_) + 0.01, r_ * (1.0 if deg <= 95 else 0.82)))
    for x3, z3, r in spots:
        # on top of the shoulder / upper back there: the surface height under it
        near = tree.query_ball_point([x3, z3], 0.04)
        ys_ = B[near, 1] if near else np.zeros(0)
        ys_ = ys_[ys_ < R.ys3[1] + 0.06]                  # the shoulders / upper back, never the head or hair above
        ytop = float(ys_.max()) if len(ys_) else R.ys3[1]
        C = np.array([x3, ytop + 0.1 * r, z3])
        placed.append((C, r))
        for d in D:
            if d[1] < -0.45:                               # fur flames lick outward / up, never down into the coat
                continue
            L = r * rng.uniform(0.6, 1.1)                  # fluffy: shorter, broader blades
            rb = r * rng.uniform(0.36, 0.5)
            u = np.cross(d, [0, 1, 0]); u = u / (np.linalg.norm(u) + 1e-9) if np.linalg.norm(u) > 1e-6 else np.array([1.0, 0, 0])
            v = np.cross(d, u)
            # a FLAME blade, not a cone: flat (wide along u, thin along v), bending up / sideways toward its tip
            # (the drawn fur's licking-flame outline) with a little random curl
            curl = (np.array([0, 1.0, 0]) * 0.3 + u * rng.uniform(-0.5, 0.5))
            flat = rng.uniform(0.3, 0.45)
            ang = np.linspace(0, 2 * np.pi, 7)[:-1]
            base_c = C + d * (0.35 * r)
            ring = [base_c + rb * (np.cos(a) * u + flat * np.sin(a) * v) for a in ang]
            mid_c = C + d * (0.35 * r + 0.55 * L) + curl * 0.12 * L
            mid = [mid_c + 0.5 * rb * (np.cos(a) * u + flat * np.sin(a) * v) for a in ang]
            tip = C + d * (0.35 * r + L) + curl * 0.38 * L
            pts = ring + mid + [tip]
            for q in pts:
                P_all.append(q)
                nrm = q - C; N_all.append(nrm / (np.linalg.norm(nrm) + 1e-9))
            ts = [0.0] * 6 + [0.55] * 6 + [1.0]
            UV_all += [[0.5, 1 - t] for t in ts]
            for j in range(6):
                a0, a1 = k + j, k + (j + 1) % 6
                b0, b1 = k + 6 + j, k + 6 + (j + 1) % 6
                T_all += [(a0, a1, b1), (a0, b1, b0), (b0, b1, k + 12)]
            side_all += [np.sign(x3)] * 13
            k += 13
    P = np.array(P_all); N = np.array(N_all); UV = np.array(UV_all, float); T = np.array(T_all, np.int64)
    tri = P[T]
    gn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    cen = tri.mean(1)
    # outward winding per spike (compare with the radial normal)
    flip = (gn * N[T[:, 0]]).sum(1) < 0
    T[flip] = T[flip][:, [0, 2, 1]]
    # texture: trim colour at the root -> light at the tips
    H = 64
    tex = np.zeros((H, 2, 4), np.uint8)
    import colorsys
    hh, ss, vv = colorsys.rgb_to_hsv(*tc)
    light = np.array(colorsys.hsv_to_rgb((hh + 0.02) % 1, min(1, ss * 1.05), min(1, vv * 1.12)))   # gold tips
    dark = np.array(colorsys.hsv_to_rgb((hh - 0.03) % 1, min(1, ss * 1.15), vv * 0.85))          # orange roots
    # the DRAWN gradient when the drawing has one: the fur blob's inner pixels (far from its outline) = root colour,
    # its outer rim (the flame tips) = tip colour -- Nux's gold fur burns orange-red at the tips
    try:
        allb = np.isin(lab, blobs)
        dtb = ndi.distance_transform_edt(allb)
        dmax = np.percentile(dtb[allb], 95)
        near = np.linalg.norm(rgb - tc, axis=-1) < 0.45
        inner = allb & (dtb > 0.5 * dmax)
        rim = ndi.binary_dilation(allb, iterations=3) & ~ndi.binary_erosion(allb, iterations=2) & near
        if inner.sum() > 30 and rim.sum() > 30:
            ci, cr = np.median(rgb[inner], 0), np.median(rgb[rim], 0)
            if np.linalg.norm(ci - cr) > 0.08:
                dark, light = np.asarray(ci, float), np.clip(np.asarray(cr, float) * np.array([1.0, 0.85, 0.8]), 0, 1)
                log(f'fur: drawn gradient root #{"".join(f"{int(x * 255):02x}" for x in ci)} -> tips '
                    f'#{"".join(f"{int(x * 255):02x}" for x in cr)}')
    except Exception:
        pass
    for rr in range(H):
        t = 1 - (rr + 0.5) / H
        tt = float(np.clip((t - 0.4) / 0.5, 0, 1))        # the drawn tip colour on the outer half of a blade
        col = dark * (1 - tt) + light * tt
        tex[rr, :, :3] = (col * 255).astype(np.uint8)
    tex[..., 3] = 255
    os.makedirs(out_dir, exist_ok=True)
    png = os.path.join(out_dir, 'fur.png')
    Image.fromarray(np.repeat(np.repeat(tex, 4, 0), 8, 1)).save(png)
    lx = m.pos('J_Bip_L_Shoulder')[0]
    sides = np.array(side_all)
    Jn = np.zeros((len(P), 4), np.int32); W = np.zeros((len(P), 4), np.float32)
    Jn[:, 0] = 0; Jn[:, 1] = np.where((sides > 0) == (lx > 0), 1, 2)
    ws = 0.6 * np.clip(np.abs(P[:, 0]) / max(xa, 1e-3), 0, 1)       # the tufts behind the neck ride the chest
    W[:, 0] = 1 - ws; W[:, 1] = ws
    part = {'P': P.astype(np.float32), 'N': N.astype(np.float32), 'UV': UV.astype(np.float32), 'J': Jn, 'W': W,
            'T': T.astype(np.int32), 'M': np.zeros(len(T), np.int32), 'mat_names': np.array(['L2D_Fur']),
            'bones': np.array(['J_Bip_C_UpperChest', 'J_Bip_L_Shoulder', 'J_Bip_R_Shoulder'])}
    add_part(m, part, 'Outfit_Fur', lambda mn: make_mat(png, 'L2D_Fur', shade=tuple(dark * 0.8)), log)
    log(f'fur: {len(placed)} tuft balls (outline / hull {spiky:.2f}) ' + ', '.join(f'r {r:.3f} at x {C_[0]:+.3f}' for C_, r in placed))
    return True


# ------------------------------------------------------------------------------------------------ neck band
def choker(m, A, R, view, out_dir, add_part, make_mat, log=print, n=64):
    """a drawn neck band (image2d A.choker: dark rows across the neck under the chin): a thin band hugging the
    neck at the registered height, the drawn band (buckle, studs) on its front third, its colour all round"""
    ch = getattr(A, 'choker', None)
    if not ch or 'Body' not in m.byname:
        return False
    chin3, sh3 = R.ys3[0], R.ys3[1]
    ya, yb = (float(R.y2_to_y3(view.model([[0.0, ch[k]]])[0, 1])) for k in ('y0', 'y1'))
    y_top, y_bot = max(ya, yb), min(ya, yb)
    h = float(np.clip(y_top - y_bot, 0.012, 0.03))
    # on the neck itself, a little below its middle (a bust drawing's neck length doesn't register reliably; the
    # base's collar sits at the neck's foot)
    ym = float(sh3 + 0.68 * (chin3 - sh3))            # above the shirt's own collar
    neck = m.pos('J_Bip_C_Neck')
    bd = m.read_mesh(m.J['nodes'][m.byname['Body']]['mesh']).P
    sel = (np.abs(bd[:, 1] - ym) < 0.01) & (np.abs(bd[:, 0] - neck[0]) < 0.07) &         (np.hypot(bd[:, 0] - neck[0], bd[:, 2] - neck[2]) < 0.08)
    if sel.sum() < 12:
        return False
    rr = np.hypot(bd[sel, 0] - neck[0], bd[sel, 2] - neck[2])
    r = float(np.percentile(rr, 95)) + 0.006
    th = np.linspace(0, 2 * np.pi, n + 1)                  # 0 = front (-z); closed seam at the back
    prof = [(r - 0.001, ym - h / 2), (r + 0.003, ym - h / 2), (r + 0.003, ym + h / 2), (r - 0.001, ym + h / 2)]
    G = np.array([[[neck[0] + np.sin(t) * rad, y, neck[2] - np.cos(t) * rad] for rad, y in prof] for t in th])
    N = np.zeros_like(G)
    radial = np.stack([np.sin(th), np.zeros_like(th), -np.cos(th)], 1)
    N[:, 0] = [0, -1, 0]; N[:, 1] = radial; N[:, 2] = radial; N[:, 3] = [0, 1, 0]
    N[:, 1] = radial; N[:, 2] = radial
    k = len(prof)
    P = G.reshape(-1, 3); Nf = N.reshape(-1, 3)
    # u: the front +-60 deg shows the drawn band (image x grows toward the character's right = glTF -x)
    deg = np.degrees(np.where(th > np.pi, th - 2 * np.pi, th))
    u = np.where(np.abs(deg) <= 60, 0.5 - deg / 120 * 0.5, np.where(deg > 0, 0.25 - (deg - 60) / 120 * 0.25,
                                                                    0.75 + (-deg - 60) / 120 * 0.25))
    vv = np.array([0.0, 0.05, 0.95, 1.0])
    UV = np.stack([np.repeat(u, k), np.tile(1 - vv, len(th))], 1)
    T = _grid_tris(len(th), k)
    tri = P[T]
    gn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    if (gn * Nf[T[:, 0]]).sum(1).mean() < 0:
        T = T[:, [0, 2, 1]]
    colr = _hexrgb(ch['color'])
    TW, TH = 256, 32
    tex = np.zeros((TH, TW, 4), np.float32); tex[..., :3] = colr; tex[..., 3] = 1
    band = np.asarray(ch['rgb'], np.float32)
    if band.size:
        im = Image.fromarray((np.clip(band, 0, 1) * 255).astype(np.uint8)).resize((TW // 2, TH), Image.LANCZOS)
        tex[:, TW // 4:TW // 4 + TW // 2, :3] = np.asarray(im, np.float32) / 255
        # the drawn band's ends show neck skin / hair beside it: keep only its dark / metal (non-skin) pixels
        sk = _hexrgb((getattr(A, 'colors', {}) or {}).get('skin', '#ffffff'))
        mid = tex[:, TW // 4:TW // 4 + TW // 2, :3]
        skinlike = np.linalg.norm(mid - sk, axis=-1) < 0.2
        sat = mid.max(-1) - mid.min(-1)
        metal = (mid.mean(-1) > 0.45) & (sat < 0.4)
        other = (np.linalg.norm(mid - colr, axis=-1) > 0.35) & ~metal       # the jacket / fur beside the neck
        mid[skinlike | other] = colr
    os.makedirs(out_dir, exist_ok=True)
    png = os.path.join(out_dir, 'choker.png')
    Image.fromarray((tex * 255).astype(np.uint8)).save(png)
    bones = ['J_Bip_C_Neck']
    part = {'P': P.astype(np.float32), 'N': Nf.astype(np.float32), 'UV': UV.astype(np.float32),
            'J': np.zeros((len(P), 4), np.int32), 'W': np.tile(np.array([1, 0, 0, 0], np.float32), (len(P), 1)),
            'T': T.astype(np.int32), 'M': np.zeros(len(T), np.int32), 'mat_names': np.array(['L2D_Choker']),
            'bones': np.array(bones)}
    add_part(m, part, 'Outfit_Choker', lambda mn: make_mat(png, 'L2D_Choker', shade=tuple(colr * 0.7)), log)
    log(f'choker: neck band at y {ym:.3f} (h {h * 1000:.0f} mm, r {r:.3f}), {ch["color"]} with the drawn front')
    return True


# ------------------------------------------------------------------------------------------------ head accessory
def _accessory_solid(m, acc, c, Rh, e3, ipd3, out_dir, add_part, make_mat, log, n=84):
    """SILHOUETTE INFLATION (the Teddy / Monster Mash way of lifting a 2D drawing into a solid): the accessory's
    drawn outline, on a grid, is raised by a rounded height field from its distance transform (a pillow that is
    round at the rim and full in the middle), front surface textured with the drawing, a shallower back surface
    against the hair. The grid is laid over the head sphere at the drawn place, so the solid hugs the head and turns
    outward with it; gaps in the outline (teeth) stay open."""
    tex = np.asarray(acc['rgba'], np.float32)
    H0, W0 = tex.shape[:2]
    sil0 = tex[..., 3] > 0.5
    sc = n / max(H0, W0)
    gh, gw = max(8, int(round(H0 * sc))), max(8, int(round(W0 * sc)))
    sil = np.asarray(Image.fromarray(sil0.astype(np.uint8) * 255).resize((gw, gh), Image.NEAREST)) > 127
    dt = ndi.distance_transform_edt(sil)
    # a FACE PLATE, not a pillow (the hand-built mask's superellipse profile): a rounded rim of fixed width, flat-ish
    # in the middle; thin parts (the jaw's tooth bars) get their own rounded ridge from their own width
    rim = max(2.0, 0.22 * min(gh, gw) / 2)
    r = np.clip((dt - 0.5) / rim, 0, 1)
    hprof = (1 - (1 - r) ** 3.2) ** (1 / 3.2)
    # the jaw: rows in the lower part of the outline that split into several runs (teeth with gaps between them)
    teeth = np.zeros_like(sil)
    rows = np.nonzero(sil.any(1))[0]
    if len(rows):
        y_lo = rows.min() + 0.6 * (rows.max() - rows.min())
        for yy in rows[rows > y_lo]:
            lab1, nrun = ndi.label(sil[yy])
            if nrun >= 2:
                teeth[yy] = sil[yy]
        if teeth.sum() > 6:
            tlab, nt = ndi.label(ndi.binary_closing(teeth, np.ones((3, 1))))
            # each tooth bar: a raised rounded ridge across its own width, rising out of the plate
            for k in range(1, nt + 1):
                mk = tlab == k
                ys_, xs_ = np.nonzero(mk)
                cx_, hw_ = xs_.mean(), max((xs_.max() - xs_.min() + 1) / 2, 1.0)
                prof = np.sqrt(np.clip(1 - ((np.arange(gw) - cx_) / hw_) ** 2, 0, 1))[None, :]
                hprof = np.where(mk, np.maximum(hprof, 0.55 + 0.45 * prof), hprof)
    # half extents (m): a drawing's eye spacing reads narrow against a 3D head (perspective, the head's turn), so the
    # drawn accessory is ~20 % bigger relative to the face than its IPD ratio says
    ax_, ay_ = 1.2 * acc['ax'] * ipd3, 1.2 * acc['ay'] * ipd3
    depth = 0.5 * min(ax_, ay_)                                       # a skull-like shell, not a flat decal
    target = np.array([e3[0] - acc['cx'] * ipd3, e3[1] + acc['cy'] * ipd3, e3[2]])
    dsph = target - c
    dsph[2] = -np.sqrt(max(Rh ** 2 - dsph[0] ** 2 - dsph[1] ** 2, (0.3 * Rh) ** 2))
    dsph /= np.linalg.norm(dsph)
    anchor = c + dsph * Rh
    # the mask's OWN frame (the hand-built mask is a shell of its own, turned outward, not a skin on the skull): its
    # face mostly toward the viewer like in the drawing, a little turned out with the head's curve
    dirc = 0.4 * dsph + 0.6 * np.array([0.0, 0.0, -1.0])
    dirc /= np.linalg.norm(dirc)
    up = np.array([0.0, 1.0, 0.0]); u = np.cross(up, dirc); u /= np.linalg.norm(u) + 1e-9; v = np.cross(dirc, u)
    xs = (np.arange(gw) + 0.5) / gw * 2 - 1; ys = (np.arange(gh) + 0.5) / gh * 2 - 1
    uu, vv = np.meshgrid(xs, ys)
    F = np.zeros((gh, gw, 3)); B = np.zeros((gh, gw, 3))
    for i in range(gh):
        for j in range(gw):
            curve = 0.35 * depth * (uu[i, j] ** 2 + 0.6 * vv[i, j] ** 2)     # the shell curves back at its edges
            base = anchor + uu[i, j] * ax_ * u - vv[i, j] * ay_ * v - dirc * curve
            F[i, j] = base + dirc * depth * hprof[i, j]
            B[i, j] = base - dirc * 0.3 * depth * hprof[i, j]
    idx = -np.ones((gh, gw), np.int64); idx[sil] = np.arange(sil.sum())
    nv = int(sil.sum())
    NF = _grid_normals(F); NB = -_grid_normals(B)
    outward = np.broadcast_to(dirc, F.shape)
    if (NF[sil] * outward[sil]).sum(-1).mean() < 0:
        NF = -NF; NB = -NB
    P = np.concatenate([F[sil], B[sil]]); N = np.concatenate([NF[sil], NB[sil]])
    uvf = np.stack([(np.nonzero(sil)[1] + 0.5) / gw, 1 - (np.nonzero(sil)[0] + 0.5) / gh], 1)
    UV = np.concatenate([uvf, uvf])
    T = []
    from collections import Counter
    edges = Counter()
    for i in range(gh - 1):
        for j in range(gw - 1):
            q = [idx[i, j], idx[i + 1, j], idx[i + 1, j + 1], idx[i, j + 1]]
            if min(q) >= 0:
                T += [(q[0], q[1], q[2]), (q[0], q[2], q[3])]
                T += [(q[0] + nv, q[2] + nv, q[1] + nv), (q[0] + nv, q[3] + nv, q[2] + nv)]
                for k in range(4):
                    edges[tuple(sorted((q[k], q[(k + 1) % 4])))] += 1
    # the rim: every outline edge of the front sheet (used by one quad) joined to the back sheet -> a closed solid
    n_sheet = len(T)
    for (p0, p1), cnt in edges.items():
        if cnt == 1:
            T += [(p0, p1, p1 + nv), (p0, p1 + nv, p0 + nv)]
    T = np.array(T, np.int64)
    tri = P[T]; gn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    ref = N[T[:, 0]].copy()
    ref[n_sheet:] = tri[n_sheet:].mean(1) - P.mean(0)          # rim faces point away from the solid's middle
    flip = (gn * ref).sum(1) < 0
    T[flip] = T[flip][:, [0, 2, 1]]
    os.makedirs(out_dir, exist_ok=True)
    png = os.path.join(out_dir, 'head_accessory.png')
    t8 = (np.clip(tex, 0, 1) * 255).astype(np.uint8)
    # a drawing's crop is soft (compression, scaling): re-inked as flat cel colour -- 2x upscale, median-cut to a
    # few flat colours, speckles removed -- so the solid reads drawn, not like a blurry photo pasted on
    # REDRAWN as clean flat shapes at 4x (not an upscaled blurry crop): the art quantised to its few flat colours,
    # every colour region's outline smoothed as a soft one-hot field at the high resolution (a vector-like redraw:
    # smooth curved edges, no pixel steps, no JPEG mush), the darkest colour re-drawn as the ink outline around it
    up = 4
    q = Image.fromarray(t8[..., :3]).quantize(colors=7, method=Image.Quantize.MEDIANCUT)
    pal = np.array(q.getpalette()[:7 * 3], float).reshape(-1, 3) / 255
    lab = np.asarray(q)
    lab = ndi.median_filter(lab, size=3)                 # speckles out
    Hh, Ww = H0 * up, W0 * up
    best = np.full((Hh, Ww), -1.0); out_lab = np.zeros((Hh, Ww), np.int32)
    for k in range(len(pal)):
        onehot = Image.fromarray(((lab == k) * 255).astype(np.uint8)).resize((Ww, Hh), Image.BICUBIC)
        f = ndi.gaussian_filter(np.asarray(onehot, np.float32), up * 0.9)
        better = f > best
        best = np.where(better, f, best); out_lab = np.where(better, k, out_lab)
    rgb = (pal[out_lab] * 255).astype(np.uint8)
    al_ = Image.fromarray(np.where(ndi.binary_dilation(sil0, iterations=2), 255, 0).astype(np.uint8)).resize(
        (Ww, Hh), Image.BICUBIC)
    al = (ndi.gaussian_filter(np.asarray(al_, np.float32), up * 0.8) > 127).astype(np.uint8) * 255
    Image.fromarray(np.concatenate([rgb, al[..., None]], -1)).save(png)
    part = {'P': P.astype(np.float32), 'N': N.astype(np.float32), 'UV': UV.astype(np.float32),
            'J': np.zeros((len(P), 4), np.int32), 'W': np.tile(np.array([[1, 0, 0, 0]], np.float32), (len(P), 1)),
            'T': T.astype(np.int32), 'M': np.zeros(len(T), np.int32), 'mat_names': np.array(['L2D_HeadAccessory']),
            'bones': np.array(['J_Bip_C_Head'])}
    add_part(m, part, 'Outfit_HeadAccessory', lambda mn: make_mat(png, 'L2D_HeadAccessory', cutout=True), log)
    log(f'head accessory: inflated solid from the drawn outline ({gw}x{gh} grid, {nv} cells, depth {depth * 1000:.0f} mm) '
        f'at ({acc["cx"]:+.2f}, {acc["cy"]:+.2f}) IPD')
    return True


def head_accessory(m, A, out_dir, add_part, make_mat, log=print, n=40):
    """a drawn head accessory (a mask / ornament worn on the head, found by the image route as an oval region with
    its own pair of eyes above the face): an oval shell lying on the hair volume at the drawn place, textured with the
    drawing's crop (it is not a face: projecting its art is the drawn design), rigid on the head"""
    acc = getattr(A, 'head_acc', None)
    if not acc:
        return False
    fi = m.mesh_index('Face')
    d = m.read_mesh(fi)
    iris = [i for i, p in enumerate(d.prims) if 'EyeIris' in m.mat_name(p['material'])]
    P = d.P[d.verts_of(iris)]
    eL, eR = P[P[:, 0] < 0].mean(0), P[P[:, 0] > 0].mean(0)
    ipd3 = float(np.linalg.norm(eL - eR)); e3 = (eL + eR) / 2
    head = m.pos('J_Bip_C_Head')
    skin = [i for i, p in enumerate(d.prims) if 'SKIN' in m.mat_name(p['material'])]
    FP = d.P[d.verts_of(skin)]
    lo, hi = FP.min(0), FP.max(0)
    c = (lo + hi) / 2                                  # the skull's centre (the face mesh wraps the whole head)
    c[0] = head[0]
    Rh = float(np.max(hi - lo) / 2) + 0.06            # on top of the hair volume (dome + lock thickness)
    cx, cy, ax_, ay_ = acc['cx'], acc['cy'], acc['ax'], acc['ay']              # IPD units rel. to the eye midpoint
    tex = acc['rgba']
    if acc.get('solid'):
        # the head's own radius toward the drawn place (the face mesh's bbox over-reads it: the solid floated off
        # the head at the side), plus the hair's thickness there
        tgt = np.array([e3[0] - cx * ipd3, e3[1] + cy * ipd3, e3[2]])
        dd = tgt - c; dd[2] = -np.sqrt(max((0.09) ** 2 - dd[0] ** 2 - dd[1] ** 2, (0.03) ** 2)); dd /= np.linalg.norm(dd)
        rel = FP - c; rn = np.linalg.norm(rel, axis=1) + 1e-9
        cosang = (rel @ dd) / rn
        near = cosang > np.cos(np.radians(25))
        r_dir = float(np.percentile(rel[near] @ dd, 97)) if near.sum() > 20 else float(np.max(hi - lo) / 2)
        # seated INTO the hair volume (its back half sinks into the hair, never floating off the head)
        return _accessory_solid(m, acc, c, r_dir + 0.012, e3, ipd3, out_dir, add_part, make_mat, log)
    # the patch: an oval of drawn size, its centre direction from the head centre toward the drawn place
    target = np.array([e3[0] - cx * ipd3, e3[1] + cy * ipd3, e3[2]])
    dirc = target - c; dirc[2] = -np.sqrt(max(Rh ** 2 - dirc[0] ** 2 - dirc[1] ** 2, (0.3 * Rh) ** 2))
    dirc /= np.linalg.norm(dirc)
    up = np.array([0.0, 1.0, 0.0]); u = np.cross(up, dirc); u /= np.linalg.norm(u) + 1e-9; v = np.cross(dirc, u)
    # u points to the character's right in glTF when facing -z; the drawing's +x (viewer right) = character's left
    uu, vv = np.meshgrid(np.linspace(-1, 1, n), np.linspace(-1, 1, n))
    inside = uu ** 2 + vv ** 2 <= 1.0
    Pg = np.zeros(uu.shape + (3,))
    for i in range(n):
        for j in range(n):
            off = (uu[i, j] * ax_ * u - vv[i, j] * ay_ * v) * ipd3
            q = c + dirc * Rh + off
            puff = 0.012 * max(0.0, 1 - uu[i, j] ** 2 - vv[i, j] ** 2)
            q = c + (q - c) / np.linalg.norm(q - c) * (Rh + puff)
            Pg[i, j] = q
    idx = -np.ones(uu.shape, np.int64); idx[inside] = np.arange(inside.sum())
    Pv = Pg[inside]
    Nv = (Pv - c) / np.linalg.norm(Pv - c, axis=1, keepdims=True)
    UV = np.stack([(uu[inside] + 1) / 2, (vv[inside] + 1) / 2], 1)
    T = []
    for i in range(n - 1):
        for j in range(n - 1):
            q = [idx[i, j], idx[i + 1, j], idx[i + 1, j + 1], idx[i, j + 1]]
            if min(q) >= 0:
                T += [(q[0], q[1], q[2]), (q[0], q[2], q[3])]
    T = np.array(T, np.int64)
    tri = Pv[T]; gn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    if (gn * Nv[T[:, 0]]).sum(1).mean() < 0:
        T = T[:, [0, 2, 1]]
    os.makedirs(out_dir, exist_ok=True)
    png = os.path.join(out_dir, 'head_accessory.png')
    Image.fromarray((np.clip(tex, 0, 1) * 255).astype(np.uint8)).save(png)
    part = {'P': Pv.astype(np.float32), 'N': Nv.astype(np.float32), 'UV': UV.astype(np.float32),
            'J': np.zeros((len(Pv), 4), np.int32), 'W': np.tile(np.array([[1, 0, 0, 0]], np.float32), (len(Pv), 1)),
            'T': T.astype(np.int32), 'M': np.zeros(len(T), np.int32), 'mat_names': np.array(['L2D_HeadAccessory']),
            'bones': np.array(['J_Bip_C_Head'])}
    add_part(m, part, 'Outfit_HeadAccessory', lambda mn: make_mat(png, 'L2D_HeadAccessory', cutout=True), log)
    log(f'head accessory: drawn oval {2 * ax_:.2f} x {2 * ay_:.2f} IPD at ({cx:+.2f}, {cy:+.2f}) IPD, on the hair volume')
    return True
