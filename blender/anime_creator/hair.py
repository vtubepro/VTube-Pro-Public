"""
Hairstyle transplant between VRoid models: the donor's hair mesh(es) + HairJoint bone chains + spring
bone groups are grafted onto the target's head, fitted by the eye-line anchor and face width, and
re-skinned to the target skeleton. Also: hair volume / puff and spring tuning on any hairstyle.
"""
from __future__ import annotations

import numpy as np

from . import structure
from .vroid import Model, MeshData, deepcopy


def hair_joints(m: Model) -> list[int]:
    head = m.node('J_Bip_C_Head')
    return [i for i in m.subtree(head)[1:] if m.J['nodes'][i]['name'].startswith('HairJoint')]


def face_anchor(m: Model):
    """Eye-line midpoint + face width: where a hairstyle is fitted."""
    le, re_ = m.pos(m.human('leftEye')), m.pos(m.human('rightEye'))
    fd = m.read_mesh(m.mesh_index('Face'))
    skin = [i for i, p in enumerate(fd.prims) if 'Face_00_SKIN' in m.mat_name(p['material'])]
    v = fd.verts_of(skin[0]) if skin else np.arange(fd.n)
    w = fd.P[v, 0].max() - fd.P[v, 0].min()
    return (le + re_) / 2, w


def _hair_meshes(m: Model) -> list[tuple[int, list[int] | None]]:
    """[(mesh index, prim ids or None=all)] making up the hair (Hair001 + HairBase part)."""
    out = []
    hi = m.mesh_index('Hair001')
    if hi is not None:
        out.append((hi, None))
    for nm in ('HairBase',):
        ni = m.byname.get(nm)
        if ni is not None and 'mesh' in m.J['nodes'][ni]:
            out.append((m.J['nodes'][ni]['mesh'], None))
    return out


def remap_center(m: Model, donor: Model, c: int) -> int:
    if c is None or c < 0:
        return -1
    return m.byname.get(donor.J['nodes'][c]['name'], -1)


def remove_hair(m: Model):
    joints = set(hair_joints(m))
    for name in ('Hair001', 'HairBase'):
        if name in m.byname:
            structure.remove_node_mesh(m, name)
    sa = m.vrm['secondaryAnimation']
    sa['boneGroups'] = [g for g in sa['boneGroups'] if not set(g['bones']) & joints]
    # detach joint subtrees from the head (nodes stay as orphans; harmless, never in the scene)
    head = m.node('J_Bip_C_Head')
    hn = m.J['nodes'][head]
    hn['children'] = [c for c in hn.get('children', []) if c not in joints]
    m.refresh()


def transplant(m: Model, donor: Model, log=print) -> list[int]:
    """Graft donor hair onto m (whose hair must already be removed). Returns new mesh node indices."""
    aT, wT = face_anchor(m)
    aD, wD = face_anchor(donor)
    s = wT / wD
    X = np.eye(4); X[:3, :3] *= s; X[:3, 3] = aT - s * aD         # donor space -> target space

    WD = donor.world()
    head_t = m.node('J_Bip_C_Head')
    # ---- bones ----
    dj = hair_joints(donor)
    dset = set(dj)
    newidx = {}
    newworld = {}
    for i in dj:   # subtree order: parents first
        dn = donor.J['nodes'][i]
        W = X @ WD[i]
        R = W[:3, :3] / s
        Wn = np.eye(4); Wn[:3, :3] = R; Wn[:3, 3] = W[:3, 3]
        newworld[i] = Wn
        par = donor.parent[i]
        if par in dset:
            P_ = newworld[par]; pn = newidx[par]
        else:
            P_ = m.world()[head_t]; pn = head_t
        L = np.linalg.inv(P_) @ Wn
        node = {'name': dn['name'], 'translation': [float(x) for x in L[:3, 3]],
                'rotation': [0.0, 0.0, 0.0, 1.0], 'scale': [1.0, 1.0, 1.0]}
        if not np.allclose(L[:3, :3], np.eye(3), atol=1e-5):
            from .mathx import mat_to_quat
            node['rotation'] = [float(x) for x in mat_to_quat(L[:3, :3])]
        m.J['nodes'].append(node)
        ni = len(m.J['nodes']) - 1
        m.J['nodes'][pn].setdefault('children', []).append(ni)
        newidx[i] = ni
        m._world = None
    m.refresh()

    # ---- meshes ----
    cache = {}
    made = []
    for mi, _ in _hair_meshes(donor):
        dnode = donor.node_of_mesh(mi)
        dsk = donor.J['nodes'][dnode]['skin']
        djoints = donor.skin_joints(dsk)
        d = donor.read_mesh(mi)
        used = set(np.unique(d.J[d.W > 0]).tolist())
        tj = []
        for k, j in enumerate(djoints):
            if j in newidx:
                tj.append(newidx[j])
            else:
                nm = donor.J['nodes'][j]['name']
                if nm not in m.byname:
                    if k in used:
                        raise KeyError(f'hair skin joint {nm} missing on target')
                    nm = 'J_Bip_C_Head'
                tj.append(m.byname[nm])
        d.P = (np.c_[d.P, np.ones(len(d.P))] @ X.T)[:, :3]
        for t in d.targets:
            t['POSITION'] = t['POSITION'] * s
        for p in d.prims:
            p['material'] = structure.copy_material(m, donor, p['material'], cache)
        from .vroid import compact_joints
        tj = compact_joints(d, tj)
        m.J['skins'].append({'joints': tj, 'skeleton': m.node('Root') if 'Root' in m.byname else tj[0]})
        si = len(m.J['skins']) - 1
        nm = donor.J['nodes'][dnode]['name']
        nm = 'Hair' if nm.startswith('Hair0') else nm
        tmi = m.write_mesh(None, d, name=nm + '.baked')
        made.append(m.add_node({'name': nm if nm not in m.byname else nm + '_t', 'mesh': tmi, 'skin': si}, None))

    # ---- springs ----
    sa_t = m.vrm['secondaryAnimation']
    sa_d = donor.vrm['secondaryAnimation']
    cg_map = {}
    for ci, cg in enumerate(sa_d['colliderGroups']):
        nm = donor.J['nodes'][cg['node']]['name']
        hit = next((k for k, c in enumerate(sa_t['colliderGroups']) if m.J['nodes'][c['node']]['name'] == nm), None)
        if hit is None and nm in m.byname:
            c2 = deepcopy(cg); c2['node'] = m.byname[nm]
            for c in c2['colliders']:
                c['radius'] *= s
            sa_t['colliderGroups'].append(c2); hit = len(sa_t['colliderGroups']) - 1
        if hit is not None:
            cg_map[ci] = hit
    for bg in sa_d['boneGroups']:
        if not set(bg['bones']) <= dset:
            continue
        b2 = deepcopy(bg)
        b2['bones'] = [newidx[b] for b in bg['bones']]
        b2['colliderGroups'] = [cg_map[c] for c in bg['colliderGroups'] if c in cg_map]
        b2['hitRadius'] = bg['hitRadius'] * s
        b2['center'] = remap_center(m, donor, bg.get('center', -1))
        sa_t['boneGroups'].append(b2)
    log(f'hair: transplanted {len(dj)} joints, {len(made)} meshes (scale {s:.3f})')
    return made


def reshape(m: Model, hp: dict, log=print):
    """Hair volume about the head (mesh + joints), strand messiness, spring tuning."""
    scale = float(hp.get('scale', 1.0))
    vol = np.array(hp.get('volume', [1, 1, 1]), float) * scale
    joints = hair_joints(m)
    a, _w = face_anchor(m)
    head = m.pos('J_Bip_C_Head')
    c = np.array([a[0], (a[1] + head[1]) / 2 + 0.02, head[2] + 0.01])
    if not np.allclose(vol, 1):
        W = m.world()
        newpos = {i: c + (W[i][:3, 3] - c) * vol for i in joints}
        _set_world_positions(m, joints, newpos)
        for name in ('Hair', 'Hair_t', 'HairBase'):
            ni = m.byname.get(name)
            if ni is None or 'mesh' not in m.J['nodes'][ni]:
                continue
            d = m.read_mesh(m.J['nodes'][ni]['mesh'])
            d.P = c + (d.P - c) * vol
            m.write_mesh(m.J['nodes'][ni]['mesh'], d)
    sp = hp.get('springs') or {}
    js = set(joints)
    for bg in m.vrm['secondaryAnimation']['boneGroups']:
        if set(bg['bones']) & js:
            bg['stiffiness'] = bg['stiffiness'] * float(sp.get('stiffness', 1))
            bg['gravityPower'] = bg['gravityPower'] * float(sp.get('gravity', 1)) + float(sp.get('gravityAdd', 0))
            if sp.get('gravityAdd'):
                bg['gravityDir'] = {'x': 0, 'y': -1, 'z': 0}
            bg['dragForce'] = min(1.0, bg['dragForce'] * float(sp.get('drag', 1)))


def _set_world_positions(m: Model, nodes: list[int], newpos: dict):
    """Move nodes to new world positions (identity-rotation VRoid bones), keeping untouched children in place."""
    W = m.world()
    newW = {}
    for i in nodes:
        M = W[i].copy(); M[:3, 3] = newpos[i]; newW[i] = M
    for i in nodes:
        par = m.parent[i]
        PW = newW.get(par, W[par])
        L = np.linalg.inv(PW) @ newW[i]
        m.J['nodes'][i]['translation'] = [float(x) for x in L[:3, 3]]
    m._world = None


def apply(m: Model, hp: dict, ctx):
    style = hp.get('style')
    base = ctx['params']['base']
    if style and style != base:
        remove_hair(m)
        transplant(m, ctx['donor'](style), ctx['log'])
    else:
        # keep own hair: rename the mesh node for consistent names
        if 'Hair001' in m.byname:
            m.J['nodes'][m.byname['Hair001']]['name'] = 'Hair'
            m.refresh()
    reshape(m, hp, ctx['log'])
