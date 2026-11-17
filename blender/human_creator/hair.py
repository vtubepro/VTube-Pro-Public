"""
Hair rigging. MPFB skins hair proxies by interpolating the body weights under them (hair lying on the back
follows the spine, bangs follow the head) — right for hair that RESTS on the body. Free-hanging parts
(ponytail / braid tails) additionally get a spring-bone chain `hair_tail_1..N` parented to the head, so the
app's physics (profile.physics.chains) swings them.
"""
import bpy
import numpy as np
from mathutils import Vector

from .convert import select_only
from .face import coords
from .params import LONG_HAIR


def densify(H, p, log=print, layers=(0.0022, 0.0045)):
    """MakeHuman hair proxies are a single sparse layer of cards: add offset shells (same cards pushed outward
    from the head centre, shape keys + skin weights carried along) so the hair reads dense and volumetric."""
    import bmesh
    hair = H.parts.get('hair')
    if hair is None:
        return
    arm = H.rig
    head = arm.data.bones['head']
    center = Vector(((head.head_local + head.tail_local) / 2)[:]) + Vector((0, 0.01, 0.02))
    me = hair.data
    bmx = bmesh.new()
    bmx.from_mesh(me)
    shapes = list(bmx.verts.layers.shape.values())
    orig = list(bmx.verts) + list(bmx.edges) + list(bmx.faces)
    for d in layers:
        ret = bmesh.ops.duplicate(bmx, geom=orig)
        for v in (e for e in ret['geom'] if isinstance(e, bmesh.types.BMVert)):
            off = (v.co - center).normalized() * d
            v.co += off
            for lay in shapes:
                v[lay] = v[lay] + off
    bmx.to_mesh(me)
    bmx.free()
    me.update()
    log('hair densified x%d -> %d verts' % (len(layers) + 1, len(me.vertices)))


def _tail_verts(C, head, top):
    """Free-hanging tail: behind the head's back plane and below the occiput."""
    behind = C[:, 1] > head[1] + 0.06
    low = C[:, 2] < head[2] + 0.02
    return behind & low


def add_chains(H, p, log=print):
    hair = H.parts.get('hair')
    kind = LONG_HAIR.get(p['hair']['style'])
    if hair is None or not p['hair'].get('physics', True) or kind not in ('ponytail', 'braid'):
        return []
    arm = H.rig
    C = coords(hair)
    hb = arm.data.bones['head']
    head = np.array(hb.head_local[:])
    top = C[:, 2].max()
    sel = _tail_verts(C, head, top)
    if sel.sum() < 30:
        log('hair: no free tail found')
        return []
    T = C[sel]
    z0, z1 = T[:, 2].max(), T[:, 2].min()
    n = 4
    levels = np.linspace(z0, z1, n + 1)
    joints = []
    for zl in levels:
        band = T[np.abs(T[:, 2] - zl) < max((z0 - z1) / n * 0.6, 0.01)]
        c = band.mean(0) if len(band) else T.mean(0)
        joints.append(Vector((float(c[0]), float(c[1]), float(zl))))
    # the chain root starts where the tail leaves the head (a little forward/up of the first joint)
    select_only([arm], arm)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    parent = eb['head']
    names = []
    for i in range(n):
        b = eb.new('hair_tail_%d' % (i + 1))
        b.head, b.tail = joints[i], joints[i + 1]
        b.parent = parent
        b.use_connect = i > 0
        parent = b
        names.append(b.name)
    bpy.ops.object.mode_set(mode='OBJECT')
    # weights: along-chain linear blend; the top of the tail blends from the MPFB weights into the chain
    z = C[:, 2]
    t = np.clip((z0 - z) / max(z0 - z1, 1e-6), 0, 1) * n          # 0..n along the chain
    blend_in = np.clip((z0 - z) / 0.04, 0, 1) * sel                # 4 cm fade from the root
    groups = {nm: hair.vertex_groups.get(nm) or hair.vertex_groups.new(name=nm) for nm in names}
    idx = np.nonzero(sel)[0]
    for vi in idx:
        k = blend_in[vi]
        if k <= 0:
            continue
        v = hair.data.vertices[int(vi)]
        for g in v.groups:
            g.weight *= (1 - k)
        f = t[vi]
        i0 = int(min(np.floor(f), n - 1))
        a = f - i0
        groups[names[i0]].add([int(vi)], k * (1 - a) if i0 + 1 < n else k, 'ADD')
        if i0 + 1 < n and a > 0:
            groups[names[i0 + 1]].add([int(vi)], k * a, 'ADD')
    log('hair chain', names, 'verts', int(sel.sum()))
    stiff = 1.4 if kind == 'ponytail' else 1.8
    return [{'rootBone': names[0], 'stiffness': stiff, 'drag': 0.5, 'gravity': 0.35, 'radius': 0.025}]
