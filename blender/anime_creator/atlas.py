"""
Draw-call consolidation for VRM0 / VRM-materialProperties GLBs (numpy only).

three-vrm renders every glTF PRIMITIVE as its own mesh, and every MToon material with an outline twice (surface +
outline pass). Avatars built from many parts / materials therefore cost hundreds of draw calls. This module merges
the primitives of a mesh node into as few as possible WITHOUT changing the look:

  * primitives whose MToon settings match (alpha mode, cull, render queue, outline mode / width / colour, rim, matcap,
    keywords; optionally ignoring small ShadeToony / ShadeShift differences = `soft`) form one group
  * a group with several materials gets ONE texture atlas: every source texture is copied into its own padded cell
    (tiled when its UVs wrap past 0..1), per-material colour factors (_Color, _ShadeColor, _EmissionColor) are baked
    into the atlas cells in LINEAR space (exact for the MToon multiply), the merged material gets neutral factors
  * vertices shared between materials are duplicated (morph targets, skin weights and normals follow)
  * a group that only shares one material is simply concatenated

Node names never change (costume `hides` and attachment look nodes up by name).

    consolidate(model, ['Outfit_Jacket', ...], soft=True, log=print)   ->  {node: (prims_before, prims_after)}
    prune(model)                                                        drop unused materials / textures / images
"""
from __future__ import annotations

import math

import numpy as np

from . import imgio
from .vroid import Model, MeshData, deepcopy

SOFT_KEYS = ('_ShadeToony', '_ShadeShift', '_ReceiveShadowRate', '_ShadingGradeRate', '_LightColorAttenuation',
             '_IndirectLightIntensity')
FACTOR_VECS = ('_Color', '_ShadeColor', '_EmissionColor')
PAD = 8


def _lin(c):
    c = np.asarray(c, np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _srgb(c):
    c = np.clip(np.asarray(c, np.float32), 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def signature(m: Model, mat: int, soft: bool) -> str:
    J = m.J['materials'][mat]; mt = m.mtoon(mat)
    fp = {k: round(float(v), 3) for k, v in mt.get('floatProperties', {}).items() if not (soft and k in SOFT_KEYS)}
    vp = {k: [round(float(x), 3) for x in v] for k, v in mt.get('vectorProperties', {}).items()
          if k not in FACTOR_VECS and not k.endswith('_ST')}
    tp = mt.get('textureProperties', {})
    # textures that can't be atlased into one set: matcap / rim / outline-width maps must be identical
    fixed = {k: tp[k] for k in ('_SphereAdd', '_RimTexture', '_OutlineWidthTexture', '_UvAnimMaskTexture', '_BumpMap') if k in tp}
    return repr((J.get('alphaMode', 'OPAQUE'), J.get('alphaCutoff'), J.get('doubleSided', False), mt.get('renderQueue'),
                 mt.get('shader'), sorted(mt.get('keywordMap', {}).items()), sorted(mt.get('tagMap', {}).items()),
                 sorted(fp.items()), sorted(vp.items()), sorted(fixed.items())))


class _Imgs:
    def __init__(self, m: Model):
        self.m, self.cache = m, {}

    def tex(self, ti):
        if ti is None:
            return None
        ii = self.m.J['textures'][ti]['source']
        if ii not in self.cache:
            self.cache[ii] = imgio.decode(self.m.g.image_bytes(ii))
        return self.cache[ii]


def _factor(mt, key, default):
    v = mt.get('vectorProperties', {}).get(key, default)
    return np.array(list(v) + [1.0] * (4 - len(v)), np.float32)[:4]


def _pack(sizes, max_w):
    """Shelf packing: sizes [(w, h)] -> positions [(x, y)], atlas (W, H)."""
    order = sorted(range(len(sizes)), key=lambda i: -sizes[i][1])
    pos = [None] * len(sizes)
    x = y = shelf = 0
    W = 0
    for i in order:
        w, h = sizes[i]
        if x + w > max_w:
            x, y, shelf = 0, y + shelf, 0
        pos[i] = (x, y)
        x += w; shelf = max(shelf, h); W = max(W, x)
    H = y + shelf
    return pos, W, H


def _cell(img, nx, ny, cw, ch):
    """Source texture tiled nx x ny, resized to (cw, ch), padded by PAD with edge pixels."""
    t = np.tile(img, (ny, nx, 1))
    if t.shape[1] != cw or t.shape[0] != ch:
        t = imgio.resize(t, cw, ch)
    return np.pad(t, ((PAD, PAD), (PAD, PAD), (0, 0)), mode='edge')


def _atlas_group(m: Model, d: MeshData, prim_ids, imgs: _Imgs, max_atlas=4096, log=print):
    """Merge d.prims[prim_ids] (several materials, same signature) into one primitive with atlased textures.
    Mutates d (duplicates shared vertices). Returns the new primitive dict, or None if not atlasable."""
    mats = []
    for pi in prim_ids:
        if d.prims[pi]['material'] not in mats:
            mats.append(d.prims[pi]['material'])
    for mat in mats:                       # texture transforms (ST) other than identity: leave alone
        vp = m.mtoon(mat).get('vectorProperties', {})
        if any(list(vp.get(k, [0, 0, 1, 1])) != [0, 0, 1, 1] for k in ('_MainTex', '_ShadeTexture', '_EmissionMap')):
            log(f'  atlas: {m.mat_name(mat)} has a texture transform -> not atlased')
            return None
    # vertices per material (duplicate shared ones)
    owner = -np.ones(d.n, np.int64)
    new_idx = {}
    for mat in mats:
        for pi in prim_ids:
            if d.prims[pi]['material'] != mat:
                continue
            idx = d.prims[pi]['indices'].astype(np.int64)
            vs = np.unique(idx)
            clash = vs[(owner[vs] >= 0) & (owner[vs] != mat)]
            if len(clash):
                base = d.n
                remap = {int(v): base + k for k, v in enumerate(clash)}
                d.P = np.vstack([d.P, d.P[clash]]); d.N = np.vstack([d.N, d.N[clash]]); d.UV = np.vstack([d.UV, d.UV[clash]])
                d.J = np.vstack([d.J, d.J[clash]]); d.W = np.vstack([d.W, d.W[clash]])
                for t in d.targets:
                    for k in list(t):
                        t[k] = np.vstack([t[k], t[k][clash]])
                lut = np.arange(d.n); lut[clash] = [remap[int(v)] for v in clash]
                idx = lut[idx]
                owner = np.r_[owner, np.full(len(clash), mat)]
                vs = np.unique(idx)
            owner[vs] = mat
            new_idx[pi] = idx
    # cells
    cells = []
    for mat in mats:
        mt = m.mtoon(mat); tp = mt.get('textureProperties', {})
        main = imgs.tex(tp.get('_MainTex'))
        if main is None:
            main = np.ones((4, 4, 4), np.float32)
        vs = np.nonzero(owner == mat)[0]
        uv = d.UV[vs]
        u0, v0 = np.floor(uv.min(0) + 1e-4)
        u1, v1 = np.ceil(uv.max(0) - 1e-4)
        nx, ny = int(max(1, u1 - u0)), int(max(1, v1 - v0))
        if nx * ny > 16 and main.shape[0] * main.shape[1] * nx * ny > 2048 * 2048 or nx * ny > 400:
            log(f'  atlas: material {m.mat_name(mat)} tiles {nx}x{ny} -> not atlased')
            return None
        cells.append({'mat': mat, 'vs': vs, 'u0': u0, 'v0': v0, 'nx': nx, 'ny': ny, 'main': main,
                      'shade': imgs.tex(tp.get('_ShadeTexture')), 'emit': imgs.tex(tp.get('_EmissionMap'))})
    # sizes (keep texel density; scale everything down together if the atlas would exceed max_atlas)
    area = sum((c['main'].shape[1] * c['nx'] + 2 * PAD) * (c['main'].shape[0] * c['ny'] + 2 * PAD) for c in cells)
    k = min(1.0, (max_atlas * max_atlas * 0.8 / max(area, 1)) ** 0.5)
    for _ in range(8):
        sizes = [(max(8, int(c['main'].shape[1] * c['nx'] * k)) + 2 * PAD, max(8, int(c['main'].shape[0] * c['ny'] * k)) + 2 * PAD)
                 for c in cells]
        widest = max(s[0] for s in sizes)
        mw = max(widest, min(max_atlas, 2 ** math.ceil(math.log2(max(1, math.sqrt(sum(a * b for a, b in sizes)))))))
        pos, W, H = _pack(sizes, mw)
        if W <= max_atlas and H <= max_atlas:
            break
        k *= 0.85
    A = np.zeros((H, W, 4), np.float32); S = np.zeros((H, W, 4), np.float32); E = np.zeros((H, W, 4), np.float32)
    E[..., 3] = 1
    any_emit = False
    for c, (x, y), (sw, sh) in zip(cells, pos, sizes):
        mt = m.mtoon(c['mat'])
        cw, ch = sw - 2 * PAD, sh - 2 * PAD
        col = _factor(mt, '_Color', [1, 1, 1, 1]); shc = _factor(mt, '_ShadeColor', [1, 1, 1, 1])
        emc = _factor(mt, '_EmissionColor', [0, 0, 0, 1])
        main = c['main']
        a = main.copy(); a[..., :3] = _srgb(_lin(main[..., :3]) * _lin(col[:3])); a[..., 3] = main[..., 3] * col[3]
        sh_src = c['shade'] if c['shade'] is not None else main
        if sh_src.shape[:2] != main.shape[:2]:
            sh_src = imgio.resize(sh_src, main.shape[1], main.shape[0])
        s = sh_src.copy(); s[..., :3] = _srgb(_lin(sh_src[..., :3]) * _lin(shc[:3])); s[..., 3] = 1
        A[y:y + sh, x:x + sw] = _cell(a, c['nx'], c['ny'], cw, ch)
        S[y:y + sh, x:x + sw] = _cell(s, c['nx'], c['ny'], cw, ch)
        if c['emit'] is not None and emc[:3].max() > 0:
            em = c['emit']
            if em.shape[:2] != main.shape[:2]:
                em = imgio.resize(em, main.shape[1], main.shape[0])
            e = em.copy(); e[..., :3] = _srgb(_lin(em[..., :3]) * _lin(np.minimum(emc[:3], 1))); e[..., 3] = 1
            E[y:y + sh, x:x + sw] = _cell(e, c['nx'], c['ny'], cw, ch)
            any_emit = True
        # UVs: glTF v runs down the image, so v maps onto rows directly
        uv = d.UV[c['vs']]
        fu = (uv[:, 0] - c['u0']) / c['nx']; fv = (uv[:, 1] - c['v0']) / c['ny']
        d.UV[c['vs'], 0] = (x + PAD + fu * cw) / W
        d.UV[c['vs'], 1] = (y + PAD + fv * ch) / H
    # material: the dominant (most triangles) source, neutral factors, atlas textures
    tri = {mat: sum(len(new_idx[pi]) for pi in prim_ids if d.prims[pi]['material'] == mat) for mat in mats}
    dom = max(mats, key=lambda q: tri[q])
    name = '+'.join(m.mat_name(q) for q in mats)
    name = m.mat_name(dom) + '_Atlas' if len(name) > 60 else name
    J = deepcopy(m.J['materials'][dom]); mp = deepcopy(m.mtoon(dom))
    J['name'] = name; mp['name'] = name
    g = m.g
    ta = g.add_texture(g.add_image(imgio.encode(A), name + '_main'), 0)
    ts = g.add_texture(g.add_image(imgio.encode(S), name + '_shade'), 0)
    tp = mp.setdefault('textureProperties', {})
    tp['_MainTex'] = ta; tp['_ShadeTexture'] = ts
    J.setdefault('pbrMetallicRoughness', {})['baseColorTexture'] = {'index': ta, 'texCoord': 0}
    J['pbrMetallicRoughness']['baseColorFactor'] = [1, 1, 1, 1]
    vp = mp.setdefault('vectorProperties', {})
    vp['_Color'] = [1, 1, 1, 1]; vp['_ShadeColor'] = [1, 1, 1, 1]
    for key in ('_MainTex', '_ShadeTexture', '_EmissionMap'):
        vp[key] = [0, 0, 1, 1]
    if any_emit:
        te = g.add_texture(g.add_image(imgio.encode(E), name + '_emit'), 0)
        tp['_EmissionMap'] = te; vp['_EmissionColor'] = [1, 1, 1, 1]
        J['emissiveTexture'] = {'index': te, 'texCoord': 0}; J['emissiveFactor'] = [1, 1, 1]
    else:
        tp.pop('_EmissionMap', None); vp['_EmissionColor'] = [0, 0, 0, 1]
        J.pop('emissiveTexture', None); J['emissiveFactor'] = [0, 0, 0]
    m.J['materials'].append(J); m.vrm['materialProperties'].append(mp)
    mi = len(m.J['materials']) - 1
    log(f'  atlas {name}: {len(mats)} materials -> {W}x{H}')
    return {'material': mi, 'indices': np.concatenate([new_idx[pi] for pi in prim_ids]).astype(np.uint32), 'mode': 4}


def consolidate(m: Model, nodes, soft=True, max_atlas=4096, log=print, atlas=True, skip_atlas=()):
    """atlas=False (or node in skip_atlas): only merge primitives that share one material. Blended (alpha BLEND)
    materials are never atlased together: their relative draw order matters."""
    out = {}
    imgs = _Imgs(m)
    for nn in nodes:
        ni = m.byname.get(nn)
        if ni is None or 'mesh' not in m.J['nodes'][ni]:
            continue
        mi = m.J['nodes'][ni]['mesh']
        before = len(m.J['meshes'][mi]['primitives'])
        if before < 2:
            out[nn] = (before, before); continue
        d = m.read_mesh(mi)
        groups = {}
        for pi, p in enumerate(d.prims):
            groups.setdefault(signature(m, p['material'], soft), []).append(pi)
        prims = []
        for sig, ids in groups.items():
            mats = {d.prims[i]['material'] for i in ids}
            if len(ids) == 1:
                prims.append(d.prims[ids[0]]); continue
            if len(mats) == 1:
                prims.append({'material': d.prims[ids[0]]['material'], 'mode': 4,
                              'indices': np.concatenate([d.prims[i]['indices'] for i in ids]).astype(np.uint32)})
                continue
            blend = any(m.J['materials'][q].get('alphaMode') == 'BLEND' for q in mats)
            p = None if (blend or not atlas or nn in skip_atlas) else _atlas_group(m, d, ids, imgs, max_atlas, log)
            if p is None:
                # not atlasable: at least concatenate per material
                for mat in mats:
                    prims.append({'material': mat, 'mode': 4, 'indices': np.concatenate(
                        [d.prims[i]['indices'] for i in ids if d.prims[i]['material'] == mat]).astype(np.uint32)})
            else:
                prims.append(p)
        d.prims = prims
        m.write_mesh(mi, d)
        out[nn] = (before, len(prims))
        log(f'consolidate {nn}: {before} -> {len(prims)} primitives')
    return out


def prune(m: Model):
    """Remove materials no primitive uses (+ their materialProperties), then textures / images nothing references."""
    J = m.J
    used = sorted({p['material'] for me in J['meshes'] for p in me['primitives'] if p.get('material') is not None})
    remap = {o: k for k, o in enumerate(used)}
    J['materials'] = [J['materials'][o] for o in used]
    mps = m.vrm.get('materialProperties', [])
    if mps:
        m.vrm['materialProperties'] = [mps[o] for o in used if o < len(mps)]
    for me in J['meshes']:
        for p in me['primitives']:
            if p.get('material') is not None:
                p['material'] = remap[p['material']]
    # textures
    refs = []

    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if k == 'index' and isinstance(v, int) and ('texCoord' in o or len(o) <= 3):
                    refs.append((o, k))
                else:
                    walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    for mat in J['materials']:
        walk(mat)
    for mp in m.vrm.get('materialProperties', []):
        for k in list(mp.get('textureProperties', {})):
            refs.append((mp['textureProperties'], k))
    meta = m.vrm.get('meta', {})
    if isinstance(meta.get('texture'), int) and meta['texture'] >= 0:
        refs.append((meta, 'texture'))
    used_t = sorted({h[k] for h, k in refs})
    tmap = {o: k for k, o in enumerate(used_t)}
    J['textures'] = [J['textures'][o] for o in used_t]
    for h, k in refs:
        h[k] = tmap[h[k]]
    used_i = sorted({t['source'] for t in J['textures']})
    imap = {o: k for k, o in enumerate(used_i)}
    J['images'] = [J['images'][o] for o in used_i]
    for t in J['textures']:
        t['source'] = imap[t['source']]
    m.refresh()
    return len(J['materials']), len(J['textures'])
