"""
review_character.py — automated character review for VTube Pro avatars. Renders the model the way the studio does
(anime toon look, 17 views: bust front / 3-4 both sides / profile both sides / back / back 3-4 both sides / low /
high, head close-ups incl. top, full body) and runs FAILURE DETECTORS, so problems are flagged before a human sees them.

    python tools/review_character.py <model.glb> <out_dir> [--profile profile.json] [--focus hair|all]
                                     [--passes <existing passes dir>] [--ref ref.png ...] [--res 1024]

Blender runs headless at low priority on the CPU (tools/blender_low.cmd), never touching the GPU / live studio.

Detectors (G = geometry, R = render, per view, per material region):
  G1 floating islands      mesh islands not connected (gap > 3 mm) to the body through any chain of touching parts
  G2 stand-off             overlay parts (straps, patches, beard shells, collars ...) with a long section > 4 mm off
                           every other surface (a strap bridging air over the temple)
  G3 specks                tiny islands (< 12 tris or < 6 mm^2): debris
  R1 detached pieces       silhouette components separate from the main silhouette
  R2 see-through gaps      small background holes enclosed by the character (gap between a part and the head)
  R3 culled back faces     single-sided surfaces seen from behind -> holes in the studio (three.js culls them)
  R4 flat cards            double-sided hair seen from its back side: flat single-layer ribbons
  R5 stripes / banding     dense, parallel colour edges in the final toon image (edge density x orientation coherence)
  R6 texture noise         high-frequency albedo energy (painted relief / photo noise instead of flat cel tones)
  R7 terminator noise      the cel lit/shade mask broken into speckles (noisy normals)
  R8 smears / blotches     thick irregular dark blobs in a light albedo region (not drawn lines)
  R9 poke-through          small islands of one part enclosed by another part (garment / skin / shirt clipping)
  R10 ragged silhouette    many small spikes on the outline (noisy beard / hair edges)
Every finding carries a view, a bbox and a severity; the annotated sheets mark them in red.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import time

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage as ndi
from scipy.spatial import cKDTree

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

# ------------------------------------------------------------------------------------------ thresholds
# Calibrated on: the v2 reference art (clean anime cel hair / beard), a VRoid sample (clean anime model) and the
# failing Aosabi v5 (see docs/SCULPT_AND_HAIR.md "Review tool calibration").
TH = {
    'gap_attach': 0.003,        # m: parts closer than this touch
    'standoff': 0.004,          # m: overlay part this far from every other surface = standing off
    'standoff_len': 0.015,
    'strap_gap': 0.002,         # m: head straps / bands / cords must wrap tighter than this
    'trim_gap': 0.005,          # m: garment trims / flaps elsewhere
    'hover_max': 0.009,         # m: a piece whose median gap is larger hangs free rather than hovering      # m: ... over at least this length
    'speck_tris': 12, 'speck_area': 6e-6,
    'detached_px': 12,          # R1 min component area (px at 1024)
    'hole_px': (6, 3000),       # R2 hole area range (px)
    'culled_px': 40,            # R3 min cluster
    'card_back_frac': 0.06,     # R4 fraction of hair pixels seen from the back side
    'edge_thr': 0.075,          # R5 sRGB luma step counted as an edge
    'stripe_density': 0.16,     # R5 edge density (edges / px) in the region interior
    'stripe_coherence': 0.35,   # R5 orientation coherence of those edges
    'noise_frac': 0.07,         # R6 fraction of albedo px with local std > noise_std (median over views)
    'stripes_per_kpx': 1.2,     # R5 thin elongated tone bands per 1000 px (median; VRoid hair 0.6-0.7, v5 hair 1.5)
    'fragment_per_kpx': 2.2,    # R7 lit/shade islands (speckles + 2 x mid blobs) per 1000 px (VRoid hair ~1.0, v5 3.2)
    'noise_std': 0.045,
    'speckle_per_kpx': 0.45,    # R7 lit/shade speckles (< 40 px) per 1000 px of region
    'blotch_px': 150, 'blotch_halfw': 5.0,  # R8 (px, half thickness px)
    'poke_px': (6, 1500),       # R9 speckle size range
    'spikes_per_100px': 3.0,    # R10 small spikes per 100 px of outline, per material
    'min_region_px': 3000,      # regions smaller than this are not measured by R5-R8
}
SEV = {'high': 3, 'med': 2, 'low': 1}
import re
FUR_RE = re.compile(r'hair|bang|fringe|ponytail|twintail|beard|fur|mustache|moustache', re.I)
DETAIL_RE = re.compile(r'eye(?!patch)|iris|pupil|lash|brow|line|highlight|teeth|tooth|mouth|cavity|tongue', re.I)


def gltf_validate(path):
    try:
        r = subprocess.run(['node', os.path.join(ROOT, 'tools', 'gltf_validate.mjs'), os.path.abspath(path)],
                           capture_output=True, text=True, cwd=ROOT, timeout=300)
        return json.loads(r.stdout.strip().splitlines()[-1])
    except Exception as e:                                  # node / package missing: note it, don't fail the review
        print('gltf-validator unavailable:', e)
        return None


def pixel_diff(a_png, b_png, out_png):
    try:
        r = subprocess.run(['node', os.path.join(ROOT, 'tools', 'render_diff.mjs'), a_png, b_png, out_png, '0.1'],
                           capture_output=True, text=True, cwd=ROOT, timeout=120)
        return json.loads(r.stdout.strip().splitlines()[-1])
    except Exception as e:
        print('pixelmatch unavailable:', e)
        return None


def reclassify_hair(scene):
    """Hair per material like the app's isHair() (mesh name or material name per primitive); older pass dirs
    classified whole objects."""
    rx = re.compile(r'hair|bang|fringe|ponytail|twintail', re.I)
    lst = set((scene.get('look') or {}).get('hairMeshes') or [])
    strip = lambda n: re.sub(r'(\.\d{3}|_\d+)$', '', n)
    for ob in scene['objects']:
        names = {ob['name'], ob['mesh'], strip(ob['name']), strip(ob['mesh'])}
        ob['hair'] = bool(lst & names) if lst else any(rx.search(n) for n in names)
    for m in scene['materials']:
        by = (m['name'] in lst) if lst else bool(rx.search(m['name']))
        m['hairAny'] = by or any(m['name'] in ob['materials'] and ob['hair'] for ob in scene['objects'])


def _blender_cmd():
    """VTP_BLENDER (the helper passes the Blender it found; any OS) at IDLE priority, else tools/blender_low.cmd"""
    exe = os.environ.get('VTP_BLENDER')
    if exe:
        return [exe], ({'creationflags': 0x00000040} if os.name == 'nt' else {'preexec_fn': lambda: os.nice(10)})
    return [os.path.join(ROOT, 'tools', 'blender_low.cmd')], {}


def run_blender(model, passes, profile, res, only=None):
    exe, kw = _blender_cmd()
    cmd = exe + ['-b', '--factory-startup', '--python',
                 os.path.join(ROOT, 'blender', 'review_char', 'render_passes.py'), '--', model, passes, '--res', str(res)]
    if profile:
        cmd += ['--profile', profile]
    if only:
        cmd += ['--only', only]
    t = time.time()
    lock = os.environ.get('VTP_BLENDER_LOCK')        # one headless Blender at a time (docs/BLENDER_PLAYBOOK.md 3.2)
    held = False
    try:
        while lock:
            try:
                os.mkdir(lock); held = True
                open(os.path.join(lock, 'owner.txt'), 'w').write('review_character')
                break
            except FileExistsError:
                print('blender busy (lock held), waiting 30 s ...'); time.sleep(30)
        r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    finally:
        if held:
            import shutil
            shutil.rmtree(lock, ignore_errors=True)
    if 'REVIEW_PASSES_DONE' not in r.stdout:
        print(r.stdout[-3000:], r.stderr[-3000:])
        raise SystemExit('render_passes failed')
    print(f'passes rendered in {time.time() - t:.0f}s')


# ------------------------------------------------------------------------------------------ geometry
def weld_islands(P, T):
    key = np.round(P / 1e-5).astype(np.int64)
    _, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.ravel()
    Tw = inv[T]
    n = inv.max() + 1
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    e = np.concatenate([Tw[:, [0, 1]], Tw[:, [1, 2]]])
    g = coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n))
    _, lab = connected_components(g, directed=False)
    return lab[Tw[:, 0]]          # island per triangle


def tri_area(P, T):
    return 0.5 * np.linalg.norm(np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]]), axis=1)


def sample_surface(P, T, isl, density=2.5e5, rng=np.random.default_rng(1)):
    """Area-weighted surface samples (+ every vertex so tiny islands are represented); labels = island."""
    A = tri_area(P, T)
    cnt = rng.poisson(A * density)
    idx = np.repeat(np.arange(len(T)), cnt)
    r1, r2 = rng.random(len(idx)), rng.random(len(idx))
    s = np.sqrt(r1)
    a, b, c = P[T[idx, 0]], P[T[idx, 1]], P[T[idx, 2]]
    X = (1 - s)[:, None] * a + (s * (1 - r2))[:, None] * b + (s * r2)[:, None] * c
    X = np.concatenate([X, P[T[:, 0]], (P[T[:, 0]] + P[T[:, 1]] + P[T[:, 2]]) / 3])
    lab = np.concatenate([isl[idx], isl, isl])
    tri = np.concatenate([idx, np.arange(len(T)), np.arange(len(T))])
    return X, lab, tri


def geometry_checks(G, scene, focus):
    P = G['P'].astype(np.float64); T = G['T'].astype(np.int64); M = G['mat'].astype(int); O = G['obj'].astype(int)
    mats = scene['materials']
    hair_mat = np.array([False] + [m['hairAny'] for m in mats] + [False] * 2)
    isl = weld_islands(P, T)
    n_isl = isl.max() + 1
    A = tri_area(P, T)
    area = np.bincount(isl, A, n_isl); ntri = np.bincount(isl, minlength=n_isl)
    # majority material per island
    maj = np.zeros(n_isl, int)
    # vectorised majority: area per (island, material)
    key = isl * 1000 + M
    ks, kinv = np.unique(key, return_inverse=True)
    ka = np.bincount(kinv, A)
    best = {}
    for k, a in zip(ks, ka):
        i, m = divmod(int(k), 1000)
        if a > best.get(i, (0, -1))[0]:
            best[i] = (a, m)
    for i, (a, m) in best.items():
        maj[i] = m
    X, lab, stri = sample_surface(P, T, isl)
    tree = cKDTree(X)
    findings = []
    # --- G1 attachment graph
    K = 40
    d, j = tree.query(X, k=K, distance_upper_bound=TH['gap_attach'])
    valid = np.isfinite(d)
    jj = np.where(valid, j, 0)
    other = valid & (lab[jj] != lab[:, None])
    src = np.repeat(lab[:, None], K, 1)[other]; dst = lab[jj][other]
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    g = coo_matrix((np.ones(len(src)), (src, dst)), shape=(n_isl, n_isl))
    _, comp = connected_components(g, directed=False)
    main = comp[np.argmax(area)]
    comp_area = np.bincount(comp, area)
    main = int(np.argmax(comp_area))
    anchored = comp == main
    mat_name = lambda m: mats[m - 1]['name'] if 0 < m <= len(mats) else '?'
    specks = (ntri < TH['speck_tris']) | (area < TH['speck_area'])
    anc_idx = np.where(anchored[lab])[0]
    tree_anc = cKDTree(X[anc_idx]) if len(anc_idx) else None
    for i in np.where(~anchored & ~specks)[0]:
        if DETAIL_RE.search(mat_name(maj[i])):
            continue
        sel = lab == i
        c = X[sel].mean(0)
        gap = float(tree_anc.query(X[sel], k=1)[0].min()) if tree_anc is not None else float('nan')
        hair = hair_mat[maj[i]]
        if focus == 'hair' and not hair:
            continue
        sev = 'high' if area[i] > 2e-4 or gap > 0.01 else 'med'
        findings.append({'id': 'G1', 'what': 'floating island', 'severity': sev, 'material': mat_name(maj[i]),
                         'pos': c.tolist(), 'extent': (X[sel].max(0) - X[sel].min(0)).tolist(),
                         'detail': f'{ntri[i]} tris, {area[i] * 1e4:.1f} cm2, {gap * 1000:.1f} mm from the attached model'})
    nspeck = int(specks.sum())
    if nspeck:
        sp_mats = {}
        for i in np.where(specks)[0]:
            sp_mats[mat_name(maj[i])] = sp_mats.get(mat_name(maj[i]), 0) + 1
        if focus != 'hair' or any(hair_mat[maj[i]] for i in np.where(specks)[0]):
            findings.append({'id': 'G3', 'what': 'debris specks', 'severity': 'low' if nspeck < 20 else 'med',
                             'detail': f'{nspeck} tiny islands: ' + ', '.join(f'{k} x{v}' for k, v in sorted(sp_mats.items(), key=lambda kv: -kv[1])[:6])})
    # --- G2 stand-off of STRAP-LIKE overlay pieces (per island + material): narrow ribbons (straps, belts,
    # bands, cords) must lie on what they wrap; garments / beards / caps legitimately stand off and are left to R*
    pk = isl * 1000 + M
    pks, pinv = np.unique(pk, return_inverse=True)
    parea = np.bincount(pinv, A)
    body = int(np.argmax(area))
    for pi_, kk in enumerate(pks):
        i, m = divmod(int(kk), 1000)
        if focus == 'hair':
            continue
        if i == body or hair_mat[m] or specks[i] or parea[pi_] < 2e-4 or parea[pi_] > 0.01 * area.sum() or DETAIL_RE.search(mat_name(m)):
            continue
        tsel = np.where(pinv == pi_)[0]
        vs = P[np.unique(T[tsel])]
        ext = float(np.linalg.norm(vs.max(0) - vs.min(0)))
        width = parea[pi_] / max(ext, 1e-6)
        if width > 0.025 or ext < 0.05:
            continue
        ss = np.isin(stri, tsel) & (lab == i)
        Xi = X[ss]
        lo_, hi_ = Xi.min(0) - 0.03, Xi.max(0) + 0.03
        oth = np.where((lab != i) & np.all((X > lo_) & (X < hi_), 1))[0]
        if len(oth) == 0:
            continue
        dd, _ = cKDTree(X[oth]).query(Xi, k=1)
        near_head = np.linalg.norm(Xi.mean(0) - np.array(scene['head_center'])) < 2.2 * max(0.09, scene['head_top'] - scene['head_center'][2])
        gap_lim = TH['strap_gap'] if near_head else TH['trim_gap']
        off = dd > gap_lim
        if off.sum() < 5:
            continue
        Y = Xi[off]
        pairs = cKDTree(Y).query_pairs(0.004, output_type='ndarray')
        gg = coo_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(len(Y), len(Y)))
        _, cl = connected_components(gg, directed=False)
        Z = Y[cl == np.bincount(cl).argmax()]
        length = float(np.linalg.norm(Z.max(0) - Z.min(0)))
        if length < TH['standoff_len']:
            continue
        mx = float(dd[off].max()); md = float(np.median(dd))
        if md > TH['hover_max']:
            continue                   # hangs free (tie ends, tassels): not hovering over a surface
        sev = 'high' if (off.mean() > 0.5 and length > 0.03) or (mx > 0.005 and length > 0.015) else 'med'
        findings.append({'id': 'G2', 'what': 'thin strap / flap standing off the surface', 'severity': sev,
                         'material': mat_name(m), 'pos': Z.mean(0).tolist(), 'extent': (Z.max(0) - Z.min(0)).tolist(),
                         'detail': f'{off.mean() * 100:.0f}% of the {width * 1000:.0f} mm wide piece floats > {gap_lim * 1000:.0f} mm '
                                   f'off every surface (median {md * 1000:.1f} mm, max {mx * 1000:.0f} mm); section {length * 100:.1f} cm long'})
    # --- hair rooting: every hair island must reach the SCALP through a chain of touching hair islands
    head_c = np.array(scene['head_center'])
    hr = max(0.09, scene['head_top'] - head_c[2]) * 1.35
    tri_c = (P[T[:, 0]] + P[T[:, 1]] + P[T[:, 2]]) / 3
    scalp_tri = (~hair_mat[M]) & (np.linalg.norm(tri_c - head_c, axis=1) < hr) & (tri_c[:, 2] > head_c[2] - 1.0 * hr)
    hair_isl = np.zeros(n_isl, bool); hair_isl[isl[hair_mat[M]]] = True
    if hair_isl.any() and scalp_tri.any():
        scalp_s = scalp_tri[stri]
        hs = hair_isl[lab]
        # hair-hair edges from the attachment query
        e_ok = hair_isl[src] & hair_isl[dst]
        hg = coo_matrix((np.ones(e_ok.sum()), (src[e_ok], dst[e_ok])), shape=(n_isl, n_isl))
        _, hcomp = connected_components(hg, directed=False)
        ts = cKDTree(X[scalp_s])
        dh, _ = ts.query(X[hs], k=1, distance_upper_bound=0.004)
        rooted_isl = np.zeros(n_isl, bool)
        rooted_isl[np.unique(lab[hs][np.isfinite(dh)])] = True
        rooted_comp = np.zeros(hcomp.max() + 1, bool); rooted_comp[hcomp[rooted_isl]] = True
        for i in np.where(hair_isl & ~rooted_comp[hcomp] & ~specks)[0]:
            sel = lab == i
            Xi = X[sel]
            if area[i] < 2e-5:
                continue
            findings.append({'id': 'G1', 'what': 'stray hair piece (not rooted on the scalp)', 'severity': 'high' if area[i] > 3e-4 else 'med',
                             'material': mat_name(maj[i]), 'pos': Xi.mean(0).tolist(), 'extent': (Xi.max(0) - Xi.min(0)).tolist(),
                             'detail': f'{ntri[i]} tris, {area[i] * 1e4:.1f} cm2; lowest point {Xi[:, 2].min():.2f} m, '
                                       f'{np.linalg.norm(Xi.mean(0) - head_c) * 100:.0f} cm from the head centre, touches no scalp'})
    # --- G4 runaway hair: locks shooting far away from the head / above the crown
    if hair_mat.any():
        hv = hair_mat[M]
        ctr = (P[T[hv, 0]] + P[T[hv, 1]] + P[T[hv, 2]]) / 3 if hv.any() else np.zeros((0, 3))
        if len(ctr):
            head_c = np.array(scene['head_center']); top = scene['head_top']
            horiz = np.hypot(ctr[:, 0] - head_c[0], ctr[:, 1] - head_c[1])
            far = (horiz > 0.45) | (ctr[:, 2] > top + 0.10)     # long hair may hang to the waist: only sideways / up counts
            if far.sum() > 5:
                Z = ctr[far]
                findings.append({'id': 'G4', 'what': 'runaway hair (far off the head / above the crown)', 'severity': 'high',
                                 'material': 'hair', 'pos': Z.mean(0).tolist(), 'extent': (Z.max(0) - Z.min(0)).tolist(),
                                 'detail': f'{far.sum()} hair triangles; up to {np.hypot(Z[:, 0] - head_c[0], Z[:, 1] - head_c[1]).max():.2f} m sideways from the head axis, '
                                           f'highest {Z[:, 2].max() - top:+.2f} m vs the crown'})
    stats = {'islands': int(n_isl), 'anchored_islands': int(anchored.sum()), 'specks': nspeck,
             'tris': int(len(T)), 'verts': int(len(P))}
    return findings, stats


# ------------------------------------------------------------------------------------------ image helpers
def luma(rgb):
    return (rgb[..., :3].astype(np.float32) / 255) @ np.array([0.2126, 0.7152, 0.0722], np.float32)


def disk(r):
    y, x = np.ogrid[-r:r + 1, -r:r + 1]
    return x * x + y * y <= r * r


def bbox(mask):
    ys, xs = np.nonzero(mask)
    return [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]


def edge_map(L, thr):
    gx = np.abs(np.diff(L, axis=1, append=L[:, -1:])); gy = np.abs(np.diff(L, axis=0, append=L[-1:]))
    return (np.maximum(gx, gy) > thr), gx, gy


def coherence(L, mask, win=24):
    """Mean local orientation coherence of the gradient field inside mask (1 = all edges parallel)."""
    gx = ndi.sobel(L, 1); gy = ndi.sobel(L, 0)
    m = mask.astype(np.float32) * ((gx * gx + gy * gy) > 0.02)
    Jxx = ndi.uniform_filter(gx * gx * m, win); Jyy = ndi.uniform_filter(gy * gy * m, win); Jxy = ndi.uniform_filter(gx * gy * m, win)
    tr = Jxx + Jyy
    c = np.sqrt((Jxx - Jyy) ** 2 + 4 * Jxy ** 2) / np.maximum(tr, 1e-9)
    w = tr * mask
    return float((c * w).sum() / max(w.sum(), 1e-9))


def region_metrics(v, reg, name):
    """R5-R8 metrics on one material region of one view."""
    out = {}
    inner = ndi.binary_erosion(reg, disk(2)) & ~v['outline']
    npx = int(inner.sum())
    out['px'] = npx
    if npx < TH['min_region_px']:
        return out
    L = luma(v['rgb'])
    E, _, _ = edge_map(L, TH['edge_thr'])
    out['edge_density'] = float((E & inner).sum() / npx)
    out['coherence'] = coherence(L, inner)
    La = luma(v['albedo'])
    mu = ndi.uniform_filter(La, 3); mu2 = ndi.uniform_filter(La * La, 3)
    sd = np.sqrt(np.maximum(mu2 - mu * mu, 0))
    out['albedo_noise'] = float((sd[inner] > TH['noise_std']).mean())
    Ea, _, _ = edge_map(La, TH['edge_thr'])
    out['albedo_edges'] = float((Ea & inner).sum() / npx)
    lit = v['lit'].astype(np.float32) > 0.5
    small = 0
    for m in (lit & reg, ~lit & reg):
        lab, n = ndi.label(m)
        if n:
            sz = np.bincount(lab.ravel())[1:]
            small += int(((sz < 40) & (sz >= 2)).sum())
    out['speckles_per_kpx'] = float(small / (npx / 1000))
    mid_ = 0
    for m in (lit & reg, ~lit & reg):
        lab, n = ndi.label(m)
        if n:
            sz = np.bincount(lab.ravel())[1:]
            mid_ += int(((sz >= 40) & (sz < 600)).sum())
    out['fragment_per_kpx'] = float((small + 2 * mid_) / (npx / 1000))
    out['stripes_per_kpx'] = stripe_score(L, inner)
    # blotches: dark thick blobs in light albedo
    med = float(np.median(La[inner]))
    out['albedo_median'] = med
    out['blotches'] = []
    if med > 0.45 and not FUR_RE.search(name):
        dark = (La < 0.4 * med) & (La < 0.22) & inner      # near-black ink / shirt blobs on a light surface
        lab, n = ndi.label(dark)
        if n:
            dt = ndi.distance_transform_edt(dark)
            sz = np.bincount(lab.ravel())
            mxw = ndi.maximum(dt, lab, np.arange(n + 1))
            for k in range(1, n + 1):
                if sz[k] >= TH['blotch_px'] and mxw[k] >= TH['blotch_halfw']:
                    bl = lab == k
                    sm = ndi.binary_closing(ndi.binary_opening(bl, disk(2)), disk(2))
                    per = lambda q: max(1, (q & ~ndi.binary_erosion(q)).sum())
                    rough = per(bl) / per(sm) if sm.any() else 2.0
                    ring = ndi.binary_dilation(bl, disk(3)) & ~ndi.binary_dilation(bl, disk(1))
                    enclosed = (ring & reg & (La > 0.6 * med)).sum() / max(ring.sum(), 1)
                    if rough > 1.25 and enclosed > 0.8:   # ragged AND surrounded by the light surface (not a design region)
                        out['blotches'].append({'bbox': bbox(bl), 'px': int(sz[k]), 'halfw': float(mxw[k]), 'rough': float(rough)})
    return out


def stripe_score(L, inner):
    """Thin elongated tone bands (quartile-quantised final luma) per 1000 px: stripey ribbons / relief banding."""
    lv = np.digitize(L, np.quantile(L[inner], [0.25, 0.5, 0.75]))
    n = 0
    ys, xs = np.indices(L.shape)
    for q in range(4):
        lab, k = ndi.label((lv == q) & inner)
        if not k:
            continue
        idx = np.arange(1, k + 1)
        sz = ndi.sum(np.ones_like(L), lab, idx)
        my = ndi.mean(ys, lab, idx); mx = ndi.mean(xs, lab, idx)
        yy = ndi.mean(ys * ys, lab, idx) - my ** 2; xx = ndi.mean(xs * xs, lab, idx) - mx ** 2
        xy = ndi.mean(xs * ys, lab, idx) - mx * my
        tr = xx + yy; det = xx * yy - xy * xy; sq = np.sqrt(np.maximum(tr * tr / 4 - det, 0))
        l1 = tr / 2 + sq; l2 = np.maximum(tr / 2 - sq, 1e-3)
        n += int(((sz >= 40) & (sz < 3000) & (np.sqrt(l1 / l2) > 5) & (4 * np.sqrt(l2) < 10)).sum())
    return float(n / (inner.sum() / 1000))


def load_view(d, name):
    z = np.load(os.path.join(d, name + '.npz'))
    return {k: z[k] for k in z.files}


def view_checks(v, vi, scene, focus):
    mats = scene['materials']
    hair_mat = np.array([False] + [m['hairAny'] for m in mats] + [False] * 2)
    name = vi['name']
    F = []
    cov = v['cov'].astype(np.float32) > 0.5
    covany = v['cov_any']
    mat = v['mat'].astype(int); obj = v['obj'].astype(int)
    H, W = cov.shape
    mname = lambda m: mats[m - 1]['name'] if 0 < m <= len(mats) else '?'
    hairpx = hair_mat[np.clip(mat, 0, len(hair_mat) - 1)] & cov
    inscope = hairpx if focus == 'hair' else cov

    def in_scope(mask):
        return focus != 'hair' or (mask & ndi.binary_dilation(hairpx, disk(3))).any()
    # R1 detached pieces
    lab, n = ndi.label(ndi.binary_closing(cov, disk(2)), structure=np.ones((3, 3)))   # 1-2 px gaps = touching
    if n > 1:
        sz = np.bincount(lab.ravel()); sz[0] = 0
        mainl = sz.argmax()
        for k in range(1, n + 1):
            if k != mainl and sz[k] >= TH['detached_px']:
                m = lab == k
                if m[0].any() or m[-1].any() or m[:, 0].any() or m[:, -1].any():
                    continue
                if not in_scope(m):
                    continue
                mm = np.bincount(mat[m]).argmax()
                F.append({'id': 'R1', 'what': 'detached piece in silhouette', 'severity': 'high' if sz[k] > 80 else 'med',
                          'view': name, 'bbox': bbox(m), 'material': mname(mm), 'detail': f'{sz[k]} px island off the silhouette'})
    # R2 see-through holes
    bg = ~cov
    lab, n = ndi.label(bg)
    border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])))
    sz = np.bincount(lab.ravel())
    for k in range(1, n + 1):
        if k in border or not (TH['hole_px'][0] <= sz[k] <= TH['hole_px'][1]):
            continue
        m = lab == k
        ring = ndi.binary_dilation(m, disk(2)) & ~m & cov
        if not in_scope(ring):
            continue
        around = np.bincount(mat[ring], minlength=len(mats) + 2)
        if around[hair_mat[:len(around)]].sum() >= 0.9 * around.sum() or sz[k] < 12:
            continue                       # gaps between hair locks are part of a stylised silhouette
        halfw = ndi.distance_transform_edt(np.pad(m, 1))[1:-1, 1:-1].max()
        if halfw > 3.5:
            continue                       # a real opening (arm / body, hair / neck), not a slit between parts
        zr = v['depth'][ring]; zr = zr[np.isfinite(zr)]
        if len(zr) and np.percentile(zr, 90) - np.percentile(zr, 10) > 0.05:
            continue                       # far-apart surfaces overlapping in projection
        names = [mname(i) for i in np.argsort(-around)[:2] if around[i] > 0]
        F.append({'id': 'R2', 'what': 'see-through gap', 'severity': 'med' if sz[k] > 40 else 'low', 'view': name,
                  'bbox': bbox(m), 'material': '/'.join(names), 'detail': f'{sz[k]} px of background enclosed by {" + ".join(names)}'})
    # R3 culled back faces (holes in the studio)
    bc = v['back_culled']
    if focus == 'hair' and not any(m['culled'] and m['hairAny'] for m in mats):
        bc = np.zeros_like(bc)              # only non-hair parts are single-sided: not in scope
    lab, n = ndi.label(bc)
    if n:
        sz = np.bincount(lab.ravel())
        for k in range(1, n + 1):
            if sz[k] >= TH['culled_px']:
                m = lab == k
                if not in_scope(m):
                    continue
                F.append({'id': 'R3', 'what': 'single-sided surface seen from behind (hole in the studio)', 'severity': 'med',
                          'view': name, 'bbox': bbox(m), 'detail': f'{sz[k]} px'})
    # R4 flat cards: hair / beard / fur seen from its back side (paper-thin sheets, flaps)
    import re as _re
    fur = np.array([False] + [bool(m['hairAny'] or _re.search(r'beard|fur|brow|mustache|moustache', m['name'], _re.I)) for m in mats] + [False] * 2)
    for mid in np.unique(mat[cov]):
        if mid <= 0 or not fur[mid] or (focus == 'hair' and not hair_mat[mid]):
            continue
        reg = (mat == mid) & cov
        if reg.sum() < TH['min_region_px'] // 3:
            continue
        bfm = v['backface'] & reg
        bf = bfm.sum() / reg.sum()
        if bf > TH['card_back_frac']:
            lb, nb = ndi.label(bfm)
            big = np.bincount(lb.ravel())[1:].argmax() + 1
            F.append({'id': 'R4', 'what': 'paper-thin sheet / flat cards (back sides visible)', 'severity': 'med' if bf < 0.2 else 'high',
                      'view': name, 'bbox': bbox(lb == big), 'material': mname(mid),
                      'detail': f'{bf * 100:.0f}% of the {mname(mid)} pixels show a back face'})
    # R11 protruding needles: thin silhouette spikes sticking SIDEWAYS / UP out of the hair (hair tips should
    # hang with the flow). Opening with a 5 px disk removes everything thinner than ~10 px; the removed thin parts
    # that are long, attached at one end and point away from 'down' are needles.
    if hairpx.sum() > TH['min_region_px'] and abs(vi.get('pitch', 0)) < 45:
        thin = cov & ~ndi.binary_opening(cov, disk(5)) & ndi.binary_dilation(hairpx, disk(2))
        lab, n = ndi.label(thin, structure=np.ones((3, 3)))
        nd = 0; boxes = []
        up_img = np.array(vi['up']); rt = np.array(vi['right'])
        for k in range(1, n + 1):
            m = lab == k
            npx = m.sum()
            if npx < 25:
                continue
            ys, xs = np.nonzero(m)
            X = np.stack([xs - xs.mean(), ys - ys.mean()], 1)
            w, evec = np.linalg.eigh(X.T @ X / npx)
            length = 4 * np.sqrt(w[1]); width = 4 * np.sqrt(max(w[0], 1e-6))
            if length < 28 or width > 14 or length / max(width, 1) < 3:
                continue
            # direction from the attached end (touching the thick silhouette) to the free end
            core_ = ndi.binary_dilation(m, disk(2)) & ~thin & cov
            if not core_.any():
                continue
            cy, cx = np.nonzero(core_); ax = evec[:, 1]
            base = np.array([cx.mean() - xs.mean(), cy.mean() - ys.mean()])
            if base @ ax > 0:
                ax = -ax                                  # points from the base to the tip (image coords, y down)
            # angle from image-down (the world 'down' projected into this view)
            dw = np.array([0, 0, -1.0])
            down = np.array([dw @ rt, -(dw @ up_img)])    # world down in image coords (x right, y down)
            down = down / max(np.linalg.norm(down), 1e-6)
            ang = np.degrees(np.arccos(np.clip(ax @ down, -1, 1)))
            if ang > 65:
                nd += 1; boxes.append(bbox(m))
        if nd >= 2:
            F.append({'id': 'R11', 'what': 'needle spikes sticking out sideways / up', 'severity': 'high' if nd >= 4 else 'med',
                      'view': name, 'bbox': boxes[0], 'material': 'hair', 'detail': f'{nd} thin spikes > 28 px pointing > 65 deg away from down'})
            for b in boxes[1:4]:
                F.append({'id': 'R11', 'what': 'needle spikes sticking out sideways / up', 'severity': 'high' if nd >= 4 else 'med',
                          'view': name, 'bbox': b, 'material': 'hair', 'detail': f'{nd} thin spikes > 28 px pointing > 65 deg away from down'})
    # R9 poke-through: small components of (obj, mat) enclosed by another (obj, mat) region
    key = np.where(cov, obj * 1000 + mat, -1)
    keys, cnts = np.unique(key[key >= 0], return_counts=True)
    total_by_key = dict(zip(keys.tolist(), cnts.tolist()))
    for kk in keys:
        m = key == kk
        lab, n = ndi.label(m)
        if n < 2:
            continue
        sz = np.bincount(lab.ravel())
        for k in range(1, n + 1):
            if not (TH['poke_px'][0] <= sz[k] <= TH['poke_px'][1]) or total_by_key[kk] < 20 * sz[k]:
                continue
            c = lab == k
            ring = ndi.binary_dilation(c, disk(1)) & ~c
            rk = key[ring]
            if (rk < 0).any():
                continue
            vals, vc = np.unique(rk, return_counts=True)
            dom = vals[vc.argmax()]
            if vc.max() / vc.sum() < 0.85 or dom == kk or dom // 1000 == kk // 1000:
                continue
            if not in_scope(c):
                continue
            # real clipping is depth-continuous with the surface it pokes through (an intersection); skin seen
            # through a gap between hair locks lies well behind it
            dz = abs(float(np.median(v['depth'][c])) - float(np.median(v['depth'][ring & (key == dom)])))
            if dz > 0.006:
                continue
            a_m, b_m = int(kk % 1000), int(dom % 1000)
            sev9 = 'low' if (hair_mat[b_m] or sz[k] <= 60) else 'med'
            F.append({'id': 'R9', 'what': 'poke-through', 'severity': sev9, 'view': name,
                      'bbox': bbox(c), 'material': f'{mname(a_m)} through {mname(b_m)}',
                      'detail': f'{sz[k]} px of {mname(a_m)} (obj {kk // 1000}) inside {mname(b_m)} (obj {dom // 1000})'})
    # R5-R8 per material region, R10 per material outline
    metrics = {}
    op = ndi.binary_opening(cov, disk(3))
    spikes = cov & ~op
    slab, sn = ndi.label(spikes)
    edge_all = cov & ~ndi.binary_erosion(cov, disk(1))
    for mid in np.unique(mat[cov]):
        if mid <= 0:
            continue
        reg = (mat == mid) & cov
        if focus == 'hair' and not hair_mat[mid]:
            continue
        nm = mname(mid)
        if DETAIL_RE.search(nm):
            continue                   # eyes / lashes / brows / lines are designed high-frequency detail
        r = region_metrics(v, reg, nm)
        # R10 ragged silhouette: small spike components owned by this material, per 100 px of its outline
        ol = (edge_all & reg).sum()
        if ol > 150 and sn:
            owner = ndi.maximum(np.where(spikes, mat, 0), slab, np.arange(sn + 1))
            ssz = np.bincount(slab.ravel())
            ns = int(((owner == mid) & (ssz >= 3) & (ssz <= 60)).sum())
            r['spikes_per_100px'] = float(ns / (ol / 100))
        metrics[nm] = r
        if r.get('px', 0) < TH['min_region_px']:
            continue
        r['bbox'] = bbox(reg)
        for b in r.get('blotches', [])[:6]:
            F.append({'id': 'R8', 'what': 'dark smear / blotch', 'severity': 'med' if b['px'] < 300 else 'high', 'view': name,
                      'bbox': b['bbox'], 'material': nm, 'detail': f'{b["px"]} px ragged dark blob, {2 * b["halfw"]:.0f} px thick'})
    return F, metrics


# ------------------------------------------------------------------------------------------ projection + drawing
def project(vi, p, res):
    cam = np.array(vi['cam']); fwd = np.array(vi['fwd']); right = np.array(vi['right']); up = np.array(vi['up'])
    q = np.asarray(p) - cam
    z = q @ fwd
    if z <= 0:
        return None
    f = (res / 2) / math.tan(math.radians(14))
    return (res / 2 + f * (q @ right) / z, res / 2 - f * (q @ up) / z)


def geo_bbox_in_view(vi, f, res, depth=None):
    c = np.array(f['pos']); e = np.array(f.get('extent', [0.01] * 3)) / 2 + 0.004
    pts = [c + np.array([sx, sy, sz]) * e for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
    uv = [project(vi, p, res) for p in pts]
    uv = [u for u in uv if u is not None]
    if not uv:
        return None
    xs, ys = [u[0] for u in uv], [u[1] for u in uv]
    b = [max(0, int(min(xs))), max(0, int(min(ys))), min(res, int(max(xs)) + 1), min(res, int(max(ys)) + 1)]
    if b[2] <= b[0] or b[3] <= b[1]:
        return None
    # visible? the centre must not be hidden far behind other surfaces
    if depth is not None:
        u = project(vi, c, res)
        if u is None:
            return None
        x, y = int(np.clip(u[0], 0, res - 1)), int(np.clip(u[1], 0, res - 1))
        zc = (c - np.array(vi['cam'])) @ np.array(vi['fwd'])
        win = depth[max(0, y - 6):y + 7, max(0, x - 6):x + 7]
        if np.isfinite(win).any() and zc > np.nanmin(np.where(np.isfinite(win), win, np.nan)) + 0.05:
            return None
    return b


def font(sz):
    for f in ('arialbd.ttf', 'arial.ttf', 'DejaVuSans-Bold.ttf'):
        try:
            return ImageFont.truetype(f, sz)
        except OSError:
            pass
    return ImageFont.load_default()


def annotate(img, marks):
    im = img.convert('RGB'); d = ImageDraw.Draw(im)
    fnt = font(18)
    for n, b, sev in marks:
        col = (255, 40, 40) if sev == 'high' else ((255, 150, 0) if sev == 'med' else (255, 230, 0))
        x0, y0, x1, y1 = b
        pad = 4
        d.rectangle([x0 - pad, y0 - pad, x1 + pad, y1 + pad], outline=col, width=3)
        d.rectangle([x0 - pad, y0 - pad - 22, x0 - pad + 12 + 11 * len(str(n)), y0 - pad], fill=col)
        d.text((x0 - pad + 4, y0 - pad - 21), str(n), fill=(0, 0, 0), font=fnt)
    return im


def sheet(images, labels, cols, cell=512, title=None):
    rows = (len(images) + cols - 1) // cols
    top = 40 if title else 0
    S = Image.new('RGB', (cols * cell, rows * (cell + 26) + top), (20, 22, 28))
    d = ImageDraw.Draw(S); fnt = font(18)
    if title:
        d.text((10, 8), title, fill=(240, 240, 240), font=font(22))
    for i, (im, lb) in enumerate(zip(images, labels)):
        r, c = divmod(i, cols)
        S.paste(im.resize((cell, cell), Image.LANCZOS), (c * cell, top + r * (cell + 26) + 26))
        d.text((c * cell + 6, top + r * (cell + 26) + 3), lb, fill=(230, 230, 230), font=fnt)
    return S


# ------------------------------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('model'); ap.add_argument('out')
    ap.add_argument('--profile'); ap.add_argument('--passes'); ap.add_argument('--focus', default='all')
    ap.add_argument('--res', type=int, default=1024); ap.add_argument('--ref', nargs='*', default=[])
    ap.add_argument('--title', default=None)
    ap.add_argument('--only', default=None, help='comma list of view names (quick iterations)')
    ap.add_argument('--before', default=None, help='previous review dir: pixelmatch before/after diffs per view')
    ap.add_argument('--no-validate', action='store_true')
    a = ap.parse_args()
    out = os.path.abspath(a.out); os.makedirs(out, exist_ok=True)
    passes = os.path.abspath(a.passes) if a.passes else os.path.join(out, 'passes')
    if not a.passes or not os.path.exists(os.path.join(passes, 'scene.json')):
        run_blender(os.path.abspath(a.model), passes, a.profile, a.res, a.only)
    scene = json.load(open(os.path.join(passes, 'scene.json')))
    reclassify_hair(scene)
    G = np.load(os.path.join(passes, 'geom.npz'))
    t = time.time()
    findings, gstats = geometry_checks(G, scene, a.focus)
    # glTF-Validator (Khronos): spec errors in the exported file
    vrep = None
    if not a.no_validate and os.path.exists(a.model):
        vrep = gltf_validate(a.model)
        if vrep and vrep.get('errors'):
            codes = {}
            for m in vrep['messages']:
                if m['severity'] == 0:
                    codes[m['code']] = codes.get(m['code'], 0) + 1
            findings.append({'id': 'V1', 'what': 'glTF spec errors (Khronos glTF-Validator)', 'severity': 'med',
                             'detail': f"{vrep['errors']} errors, {vrep['warnings']} warnings: " +
                                       ', '.join(f'{k} x{v}' for k, v in sorted(codes.items(), key=lambda kv: -kv[1])[:5])})
    print(f'geometry checks {time.time() - t:.0f}s: {len(findings)} findings')
    views = {}
    all_metrics = {}
    for vi in scene['views']:
        v = load_view(passes, vi['name'])
        views[vi['name']] = (vi, v)
        F, met = view_checks(v, vi, scene, a.focus)
        findings += F
        all_metrics[vi['name']] = met
    # region metrics: judged on the MEDIAN over the bust + head views where the region is big enough (robust to one
    # odd angle), boxed in the two worst views
    agg = {}
    for vn, met in all_metrics.items():
        if vn.startswith('full'):
            continue
        for mn, r in met.items():
            if r.get('px', 0) >= TH['min_region_px'] and 'fragment_per_kpx' in r:
                agg.setdefault(mn, []).append((vn, r))
    RULES = [('R5', 'stripes / banding (thin tone bands)', 'stripes_per_kpx', TH['stripes_per_kpx']),
             ('R6', 'texture noise', 'albedo_noise', TH['noise_frac']),
             ('R7', 'noisy / fragmented cel shading', 'fragment_per_kpx', TH['fragment_per_kpx']),
             ('R10', 'ragged / noisy silhouette', 'spikes_per_100px', TH['spikes_per_100px'])]
    for mn, lst in agg.items():
        if len(lst) < 2:
            continue
        for rid, what, key, lim in RULES:
            vals = [r.get(key, 0.0) for _, r in lst]
            med = float(np.median(vals))
            if med <= lim:
                continue
            worst = sorted(lst, key=lambda t: -t[1].get(key, 0.0))[:2]
            sev = 'high' if med > 1.6 * lim else 'med'
            for vn, r in worst:
                findings.append({'id': rid, 'what': what, 'severity': sev, 'view': vn, 'bbox': r['bbox'], 'material': mn,
                                 'detail': f'{key} median {med:.2f} over {len(lst)} views (limit {lim}); worst {max(vals):.2f}'})
    # merge repeated render findings: same detector + material -> one finding listing its views
    merged = []
    groups = {}
    for f in findings:
        if f['id'][0] in 'GV':
            merged.append(f); continue
        k = (f['id'], f.get('material'), f['what'])
        if f['id'] in ('R1', 'R2', 'R8', 'R9', 'R3'):
            k = k + (len([g for g in findings if g is f]),)  # keep individual, grouped below by view count
        groups.setdefault((f['id'], f.get('material'), f['what']), []).append(f)
    for k, fs in groups.items():
        sev = max(fs, key=lambda f: SEV[f['severity']])['severity']
        vs = sorted({f['view'] for f in fs})
        if len(vs) >= 4 and SEV[sev] < 3 and k[0] in ('R8', 'R9', 'R1', 'R2'):
            sev = 'high'
        if k[0] == 'R11' and len(vs) < 2:
            sev = 'low'                      # one odd angle (an ahoge, a single flick) is design, not a defect
        merged.append({'id': k[0], 'what': k[2], 'material': k[1], 'severity': sev, 'views': vs, 'n': len(fs),
                       'detail': max(fs, key=lambda f: SEV[f['severity']])['detail'], 'instances': fs})
    for f in merged:
        if 'instances' in f:
            f['mark_views'] = [i['view'] for i in f['instances'][:2]]
    merged.sort(key=lambda f: (-SEV[f['severity']], f['id']))
    for n, f in enumerate(merged, 1):
        f['n_id'] = n
    # annotate views
    ann = {}
    for name, (vi, v) in views.items():
        marks = []
        for f in merged:
            if f['id'][0] in 'GV':
                if 'pos' in f:
                    b = geo_bbox_in_view(vi, f, a.res, v['depth'])
                    if b:
                        marks.append((f['n_id'], b, f['severity']))
            else:
                inst = [i for i in f['instances'] if i['view'] == name and 'bbox' in i]
                if f['id'] in ('R4', 'R5', 'R6', 'R7', 'R10'):
                    if name not in f.get('mark_views', []):
                        continue
                for i in inst[:3]:
                    marks.append((f['n_id'], i['bbox'], f['severity']))
        img = Image.open(os.path.join(passes, name + '.png'))
        ann[name] = annotate(img, marks)
        ann[name].save(os.path.join(out, name + '_marked.png'))
    order = ['bust_front', 'bust_34_left', 'bust_profile_left', 'bust_back34_left', 'bust_back', 'bust_back34_right',
             'bust_profile_right', 'bust_34_right', 'bust_low', 'bust_high']
    order = [o for o in order if o in views]
    title = a.title or os.path.basename(a.model)
    if order:
        sheet([Image.open(os.path.join(passes, o + '.png')) for o in order], order, 5, title=title + ' - studio toon look').save(os.path.join(out, 'sheet_views.png'))
        sheet([ann[o] for o in order], order, 5, title=title + ' - findings').save(os.path.join(out, 'sheet_marked.png'))
    hv = [o for o in views if o.startswith('head_') or o.startswith('full_')]
    if hv:
        sheet([ann[o] for o in hv], hv, 4, title=title + ' - head / full').save(os.path.join(out, 'sheet_head_full.png'))
    clay = [o for o in order if os.path.exists(os.path.join(passes, o + '_clay.png'))]
    if clay:
        sheet([Image.open(os.path.join(passes, o + '_clay.png')) for o in clay], clay, 5, title=title + ' - clay (forms only)').save(os.path.join(out, 'sheet_clay.png'))
    # verdict
    nh = sum(f['severity'] == 'high' for f in merged); nm = sum(f['severity'] == 'med' for f in merged)
    verdict = 'FAIL' if nh or nm >= 3 else ('WARN' if nm else 'PASS')
    rep = {'model': a.model, 'focus': a.focus, 'verdict': verdict, 'high': nh, 'med': nm,
           'low': sum(f['severity'] == 'low' for f in merged), 'geometry': gstats,
           'findings': [{k: v for k, v in f.items() if k != 'instances'} | ({'instances': [
               {kk: vv for kk, vv in i.items() if kk in ('view', 'bbox', 'detail')} for i in f.get('instances', [])]} if 'instances' in f else {})
               for f in merged],
           'metrics': all_metrics, 'thresholds': TH}
    rep['gltf_validator'] = vrep
    diffs = {}
    if a.before:
        bdir = os.path.join(a.before, 'passes') if os.path.isdir(os.path.join(a.before, 'passes')) else a.before
        os.makedirs(os.path.join(out, 'diff'), exist_ok=True)
        for name in views:
            pb = os.path.join(bdir, name + '.png')
            if os.path.exists(pb):
                d = pixel_diff(pb, os.path.join(passes, name + '.png'), os.path.join(out, 'diff', name + '_diff.png'))
                if d:
                    diffs[name] = d
        rep['diff_vs_before'] = diffs
    json.dump(rep, open(os.path.join(out, 'report.json'), 'w'), indent=1, default=float)
    L = [f'# Character review: {title}', '', f'**Verdict: {verdict}** — {nh} high, {nm} medium, {rep["low"]} low '
         f'(focus: {a.focus}). Rendered in the studio toon look (app shader formula, key light fixed to the camera) '
         f'from {len(views)} views; geometry {gstats["tris"]} tris, {gstats["islands"]} islands.', '',
         'Sheets: `sheet_views.png` (clean), `sheet_marked.png` (numbered boxes = findings below), `sheet_head_full.png`, '
         '`sheet_clay.png` (forms only), `<view>_marked.png`.', '', '| # | sev | detector | what | part | where | detail |', '|---|---|---|---|---|---|---|']
    for f in merged:
        where = ', '.join(f.get('views', [])) if f.get('views') else ('3D ' + ', '.join(f'{x:.3f}' for x in f['pos']) if 'pos' in f else '')
        if len(where) > 70:
            where = where[:67] + '...'
        L.append(f'| {f["n_id"]} | {f["severity"]} | {f["id"]} | {f["what"]} | {f.get("material", "")} | {where} | {f["detail"]} |')
    if vrep:
        L += ['', f"glTF-Validator {vrep.get('validator')}: **{vrep['errors']} errors**, {vrep['warnings']} warnings "
              f"({(vrep.get('info') or {}).get('totalTriangleCount')} tris, {(vrep.get('info') or {}).get('drawCalls')} draw calls)."]
    if diffs:
        L += ['', '## Before / after (pixelmatch)', '', '| view | changed px | % |', '|---|---|---|'] +              [f"| {k} | {d['diffPixels']} | {100 * d['ratio']:.2f} |" for k, d in diffs.items()]
    L += ['', '## Per-material metrics (bust views, median over views)', '',
          '| material | px | stripes/kpx (R5) | albedo noise (R6) | fragments/kpx (R7) | spikes/100px (R10) | edge density |', '|---|---|---|---|---|---|---|']
    agg = {}
    for vn, met in all_metrics.items():
        if not vn.startswith('bust'):
            continue
        for mn, r in met.items():
            if r.get('px', 0) >= TH['min_region_px']:
                agg.setdefault(mn, []).append(r)
    for mn, rs in sorted(agg.items(), key=lambda kv: -np.median([r['px'] for r in kv[1]])):
        med = lambda k: np.median([r.get(k, 0) for r in rs])
        L.append(f'| {mn} | {int(med("px"))} | {med("stripes_per_kpx"):.2f} | {med("albedo_noise"):.3f} | {med("fragment_per_kpx"):.2f} | '
                 f'{med("spikes_per_100px"):.1f} | {med("edge_density"):.3f} |')
    L += ['', f'Limits (median over views): stripes > {TH["stripes_per_kpx"]}/kpx; texture noise > {TH["noise_frac"]}; '
          f'fragments > {TH["fragment_per_kpx"]}/kpx; spikes > {TH["spikes_per_100px"]}/100 px.', '',
          'Manual checklist still required (docs/SCULPT_AND_HAIR.md section 6): appeal, likeness to the reference, '
          'expressions / visemes, motion (spring chains) in the studio observer tab.']
    open(os.path.join(out, 'report.md'), 'w', encoding='utf-8').write('\n'.join(L) + '\n')
    print('\n'.join(L[:len(merged) + 9]))
    print('VERDICT', verdict)


if __name__ == '__main__':
    main()
