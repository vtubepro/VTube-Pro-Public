"""
Body proportions by re-shaping the REST pose: every bone gets a world-space affine deformation about
its own joint (limb length along the bone, thickness across it, uniform head scale ...); children
follow the moved joint (optionally inheriting the full deformation, e.g. everything on the head);
every skinned vertex is moved by the weight-blended deformations (linear blend, like a pose), morph
deltas and normals by the blended linear parts; bone translations are rewritten and the inverse
bind matrices rebuilt. The result is a new, clean rest pose — no runtime bone scaling needed.
"""
from __future__ import annotations

import numpy as np

from .mathx import T, scale_about, axis_scale
from .vroid import Model


def deform(m: Model, own: dict[int, np.ndarray], inherit: set[int], log=print):
    """own: node -> 4x4 deformation about the node's ORIGINAL joint; inherit: nodes whose descendants
    take over the full deformation instead of only following the moved joint."""
    J = m.J
    W = m.world()
    n = len(J['nodes'])
    D = [None] * n
    roots = [i for i in range(n) if i not in m.parent]

    def visit(i, parentD, parentInherit):
        p = W[i][:3, 3]
        if parentD is None:
            base = np.eye(4)
        elif parentInherit:
            base = parentD
        else:
            q = parentD @ np.r_[p, 1]
            base = T(q[:3] - p)
        D[i] = base @ own.get(i, np.eye(4))
        inh = parentInherit or (i in inherit)
        for c in J['nodes'][i].get('children', []):
            visit(c, D[i], inh)
    for r in roots:
        visit(r, None, False)

    # skinned meshes
    for ni, node in enumerate(J['nodes']):
        if 'mesh' not in node or 'skin' not in node or not J['meshes'][node['mesh']]['primitives']:
            continue
        joints = J['skins'][node['skin']]['joints']
        d = m.read_mesh(node['mesh'])
        Dj = np.stack([D[j] for j in joints])                 # (k,4,4)
        Wt = d.W / np.maximum(d.W.sum(1, keepdims=True), 1e-9)
        M = np.einsum('vk,vkab->vab', Wt, Dj[d.J])           # blended per-vertex 4x4
        d.P = np.einsum('vab,vb->va', M[:, :3, :3], d.P) + M[:, :3, 3]
        L = M[:, :3, :3]
        Linv_T = np.linalg.inv(L).transpose(0, 2, 1)
        d.N = np.einsum('vab,vb->va', Linv_T, d.N)
        for t in d.targets:
            t['POSITION'] = np.einsum('vab,vb->va', L, t['POSITION'])
            if 'NORMAL' in t:
                t['NORMAL'] = np.einsum('vab,vb->va', Linv_T, t['NORMAL'])
        m.write_mesh(node['mesh'], d)
    # joints: new world positions, same rotations
    newW = []
    for i in range(n):
        M = W[i].copy()
        M[:3, 3] = (D[i] @ np.r_[W[i][:3, 3], 1])[:3]
        newW.append(M)
    for i in range(n):
        L = np.linalg.inv(newW[m.parent[i]]) @ newW[i] if i in m.parent else newW[i]
        J['nodes'][i]['translation'] = [float(x) for x in L[:3, 3]]
    # colliders scale with the local deformation
    for cg in m.vrm['secondaryAnimation']['colliderGroups']:
        k = abs(np.linalg.det(D[cg['node']][:3, :3])) ** (1 / 3)
        for c in cg['colliders']:
            c['radius'] *= k
            off = np.array([c['offset']['x'], c['offset']['y'], c['offset']['z']]) * k
            c['offset'] = {'x': float(off[0]), 'y': float(off[1]), 'z': float(off[2])}
    m._world = None


def _bone(m: Model, human: str):
    return m.human(human)


def _axis(m: Model, a: int, b: int):
    return m.pos(b) - m.pos(a)


def apply(m: Model, bp: dict, ctx):
    g = lambda k: float(bp.get(k, 1.0))  # noqa: E731
    own: dict[int, np.ndarray] = {}
    inherit: set[int] = set()

    def mul(i, M):
        own[i] = own.get(i, np.eye(4)) @ M

    def seg(h0, h1, along, perp=1.0):
        a, b = _bone(m, h0), _bone(m, h1)
        if a is None or b is None:
            return
        mul(a, scale_about(m.pos(a), axis_scale(_axis(m, a, b), along, perp)))

    legs, arms, build = g('legs'), g('arms'), g('build')
    for s in ('left', 'right'):
        seg(f'{s}UpperLeg', f'{s}LowerLeg', legs, build)
        seg(f'{s}LowerLeg', f'{s}Foot', legs, build)
        seg(f'{s}UpperArm', f'{s}LowerArm', arms, build)
        seg(f'{s}LowerArm', f'{s}Hand', arms, build ** 0.5)
    # torso thickness / waist / hips
    for hb, k in (('spine', g('waist') * build), ('chest', build), ('upperChest', build)):
        i = _bone(m, hb)
        if i is not None:
            mul(i, scale_about(m.pos(i), np.diag([k, 1, 1 + (k - 1) * 0.6])))
    hips = _bone(m, 'hips')
    if hips is not None and (g('hips') != 1 or build != 1):
        k = g('hips') * build
        mul(hips, scale_about(m.pos(hips), np.diag([k, 1, 1 + (k - 1) * 0.6])))
    # shoulders: move the shoulder joints outwards
    sh = g('shoulders')
    if sh != 1:
        for s in ('left', 'right'):
            a, b = _bone(m, f'{s}Shoulder'), _bone(m, f'{s}UpperArm')
            if a is None or b is None:
                continue
            ax = _axis(m, a, b)
            mul(a, scale_about(m.pos(a), axis_scale(ax, sh, 1.0)))
            # widen the upper chest to meet them
        uc = _bone(m, 'upperChest')
        if uc is not None:
            mul(uc, scale_about(m.pos(uc), np.diag([1 + (sh - 1) * 0.8, 1, 1])))
    nk = g('neck')
    if nk != 1:
        seg('neck', 'head', nk, 1.0)
    hd = g('head')
    head = _bone(m, 'head')
    if head is not None and hd != 1:
        mul(head, scale_about(m.pos(head), hd))
        inherit.add(head)
    bust = g('bust')
    if bust != 1:
        for s in 'LR':
            bn = m.byname.get(f'J_Sec_{s}_Bust1')
            if bn is not None:
                mul(bn, scale_about(m.pos(bn), bust))
                inherit.add(bn)
    if own:
        deform(m, own, inherit, ctx['log'])
    h = g('height')
    if h != 1:
        scale_all(m, h)
    ctx['log'](f'body: {len(own)} bone deformations, height x{h:.3f}')


def scale_all(m: Model, k: float):
    """Uniform scale of the whole avatar about the floor origin."""
    J = m.J
    for n in J['nodes']:
        if 'translation' in n:
            n['translation'] = [float(x) * k for x in n['translation']]
    for node in J['nodes']:
        if 'mesh' in node and J['meshes'][node['mesh']]['primitives']:
            d = m.read_mesh(node['mesh'])
            d.P *= k
            for t in d.targets:
                t['POSITION'] = t['POSITION'] * k
            m.write_mesh(node['mesh'], d)
    sa = m.vrm['secondaryAnimation']
    for cg in sa['colliderGroups']:
        for c in cg['colliders']:
            c['radius'] *= k
            c['offset'] = {a: float(v) * k for a, v in c['offset'].items()}
    for bg in sa['boneGroups']:
        bg['hitRadius'] *= k
    fp = m.vrm['firstPerson'].get('firstPersonBoneOffset')
    if fp:
        m.vrm['firstPerson']['firstPersonBoneOffset'] = {a: float(v) * k for a, v in fp.items()}
    m._world = None
