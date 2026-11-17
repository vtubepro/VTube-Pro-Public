"""
Outfit slots on the split VRoid body: keep / remove / swap garments (Outfit_Tops, Outfit_Bottoms,
Outfit_Shoes, Outfit_Accessory) and recolour / pattern them.  Swapped garments come from another
VRoid model: their vertices are carried over by the per-bone rest offset between the two skeletons
(same VRoid bone names), missing secondary bones (hood, skirt, sleeves) are grafted with their spring
groups.  Works best between bases of the same gender (the body shells match).
"""
from __future__ import annotations

import numpy as np

from . import structure, colors
from .vroid import Model, deepcopy

SLOTS = {'tops': 'Outfit_Tops', 'bottoms': 'Outfit_Bottoms', 'shoes': 'Outfit_Shoes', 'accessory': 'Outfit_Accessory'}


def graft_missing_bones(m: Model, donor: Model, names: set[str]) -> dict[int, int]:
    """Copy donor bones (by name) missing on m, parented to the same-named parent, positioned by the
    parent's rest offset. Returns donor node -> target node for every name in `names`."""
    out = {}
    WD = donor.world()
    order = [i for i in range(len(donor.J['nodes'])) if donor.J['nodes'][i].get('name') in names]
    # parents first
    depth = {}

    def dep(i):
        if i not in depth:
            depth[i] = 0 if i not in donor.parent else dep(donor.parent[i]) + 1
        return depth[i]
    order.sort(key=dep)
    for i in order:
        nm = donor.J['nodes'][i]['name']
        if nm in m.byname:
            out[i] = m.byname[nm]
            continue
        par = donor.parent[i]
        pn = out.get(par) if par in out else m.byname.get(donor.J['nodes'][par]['name'])
        if pn is None:
            raise KeyError(f'no parent for {nm}')
        L = np.linalg.inv(WD[par]) @ WD[i]
        node = {'name': nm, 'translation': [float(x) for x in L[:3, 3]], 'rotation': donor.J['nodes'][i].get('rotation', [0, 0, 0, 1]),
                'scale': [1, 1, 1]}
        m.J['nodes'].append(node)
        ni = len(m.J['nodes']) - 1
        m.J['nodes'][pn].setdefault('children', []).append(ni)
        m.refresh()
        out[i] = ni
    # spring groups whose bones are all newly grafted
    new = {i: t for i, t in out.items()}
    sa_t, sa_d = m.vrm['secondaryAnimation'], donor.vrm['secondaryAnimation']
    existing = {tuple(g['bones']) for g in sa_t['boneGroups']}
    for bg in sa_d['boneGroups']:
        if bg['bones'] and all(b in new for b in bg['bones']):
            b2 = deepcopy(bg); b2['bones'] = [new[b] for b in bg['bones']]
            cgs = []
            for c in bg['colliderGroups']:
                nm = donor.J['nodes'][sa_d['colliderGroups'][c]['node']]['name']
                hit = next((k for k, cg in enumerate(sa_t['colliderGroups']) if m.J['nodes'][cg['node']]['name'] == nm), None)
                if hit is not None:
                    cgs.append(hit)
            b2['colliderGroups'] = cgs
            from .hair import remap_center
            b2['center'] = remap_center(m, donor, bg.get('center', -1))
            if tuple(b2['bones']) not in existing:
                sa_t['boneGroups'].append(b2)
    return out


def transfer_part(m: Model, donor: Model, part: str, log=print) -> int | None:
    """Replace m's part node (e.g. Outfit_Tops) by the donor's, fitted to m's skeleton."""
    if part in m.byname and 'mesh' in m.J['nodes'][m.byname[part]]:
        structure.remove_node_mesh(m, part)
    if part not in donor.byname or 'mesh' not in donor.J['nodes'][donor.byname[part]]:
        log(f'outfit: donor has no {part}')
        return None
    dn = donor.byname[part]
    mi = donor.J['nodes'][dn]['mesh']
    dsk = donor.J['nodes'][dn]['skin']
    djoints = donor.skin_joints(dsk)
    d = donor.read_mesh(mi)
    used = np.unique(d.J[d.W > 0])
    names = {donor.J['nodes'][djoints[u]]['name'] for u in used}
    # all ancestors of used joints must exist too
    for u in list(used):
        j = djoints[u]
        while j in donor.parent:
            j = donor.parent[j]; names.add(donor.J['nodes'][j]['name'])
    jm = graft_missing_bones(m, donor, names)
    WT = m.world(); WD = donor.world()
    tj = []
    Dj = []
    for j in djoints:
        nm = donor.J['nodes'][j]['name']
        t = jm.get(j, m.byname.get(nm))
        if t is None:
            t = m.node('J_Bip_C_Hips')
        tj.append(t)
        Dj.append(WT[t] @ np.linalg.inv(WD[j]))
    Dj = np.stack(Dj)
    Wt = d.W / np.maximum(d.W.sum(1, keepdims=True), 1e-9)
    M = np.einsum('vk,vkab->vab', Wt, Dj[d.J])
    d.P = np.einsum('vab,vb->va', M[:, :3, :3], d.P) + M[:, :3, 3]
    cache = {}
    for p in d.prims:
        p['material'] = structure.copy_material(m, donor, p['material'], cache)
    from .vroid import compact_joints
    tj = compact_joints(d, tj)
    m.J['skins'].append({'joints': tj, 'skeleton': m.node('Root')})
    si = len(m.J['skins']) - 1
    tmi = m.write_mesh(None, d, name=part + '.baked')
    ni = m.byname.get(part)
    if ni is not None:
        m.J['nodes'][ni]['mesh'] = tmi; m.J['nodes'][ni]['skin'] = si
    else:
        ni = m.add_node({'name': part, 'mesh': tmi, 'skin': si}, None)
    m.refresh()
    log(f'outfit: {part} from {donor.vrm["meta"]["title"]}')
    return ni


def part_materials(m: Model, part: str) -> list[int]:
    ni = m.byname.get(part)
    if ni is None or 'mesh' not in m.J['nodes'][ni]:
        return []
    return sorted({p['material'] for p in m.J['meshes'][m.J['nodes'][ni]['mesh']]['primitives']})


def recolor_part(m: Model, part: str, spec: dict, ctx):
    tx = ctx.setdefault('tex', colors.Textures(m))
    for mat in part_materials(m, part):
        ii = tx.own_image(mat)
        a = tx.get(ii)
        if spec.get('color'):
            base = colors.hex_rgb(spec['color'])
            shade = colors.hex_rgb(spec['shade']) if spec.get('shade') else None
            tx.put(ii, colors.ramp_recolor(a, base, shade, ref_pct=float(spec.get('refPct', 75)),
                                           contrast=float(spec.get('contrast', 1.0))))
        sh = spec.get('shadeMul')
        colors.set_vec(m, mat, '_ShadeColor', [*(sh or [0.8, 0.78, 0.9]), 1])
        colors.set_vec(m, mat, '_Color', [1, 1, 1, 1])


def apply(m: Model, spec: dict, ctx):
    log = ctx['log']
    for slot, part in SLOTS.items():
        s = spec.get(slot, 'keep')
        if s == 'keep' or s is None and slot not in spec:
            continue
        if s is None or s == 'none':
            if part in m.byname:
                structure.remove_node_mesh(m, part)
            log(f'outfit: removed {part}')
            continue
        src = s.get('from', 'base')
        if src not in ('base', ctx['params']['base']):
            transfer_part(m, ctx['donor'](src), part, log)
        if s.get('hideTris'):
            hide_regions(m, part, s['hideTris'])
        if s.get('color') or s.get('shadeMul'):
            recolor_part(m, part, s, ctx)
    if spec.get('bodyHide'):
        hide_regions(m, 'Body', spec['bodyHide'])


def hide_regions(m: Model, part: str, regions: list[dict]):
    """Delete triangles of a part inside boxes / bone-weighted regions:
    {"bones": ["J_Sec_C_Hood"]} or {"box": [[x0,y0,z0],[x1,y1,z1]]}."""
    ni = m.byname.get(part)
    if ni is None or 'mesh' not in m.J['nodes'][ni]:
        return
    mi = m.J['nodes'][ni]['mesh']
    d = m.read_mesh(mi)
    joints = m.skin_joints(m.J['nodes'][ni]['skin'])
    kill = np.zeros(d.n, bool)
    for r in regions:
        if 'bones' in r:
            ids = [k for k, j in enumerate(joints) if any(m.J['nodes'][j]['name'].startswith(b) for b in r['bones'])]
            w = np.zeros(d.n)
            for k in ids:
                w += (d.W * (d.J == k)).sum(1)
            kill |= w > float(r.get('minWeight', 0.5))
        if 'box' in r:
            lo, hi = np.array(r['box'][0]), np.array(r['box'][1])
            kill |= np.all((d.P >= lo) & (d.P <= hi), 1)
    for pi, p in enumerate(d.prims):
        tri = p['indices'].reshape(-1, 3)
        mode = 'any'
        bad = kill[tri].any(1) if mode == 'any' else kill[tri].all(1)
        structure.delete_triangles(d, pi, bad)
    d.compact()
    m.write_mesh(mi, d)
