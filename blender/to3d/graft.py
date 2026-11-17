"""Pro2D -> 3D graft: parts the AI built in the user's Blender (through their Blender MCP) into the round's VRM.

    python blender/to3d/graft.py <in.vrm> <out.vrm> <part.glb> [<part.glb> ...] [--hide <mesh name> ...]

A part is a GLB the AI exported from work/parts/ (Blender glTF exporter, Y-up, from the candidate.blend the helper made
by importing the VRM, so its bone names ARE the VRM's node names). Each mesh comes in as a new skinned node
"TO3D_<part>" (a part re-sent replaces its older copy): skinned meshes keep their joints (mapped by name), a mesh only
parented to a bone is bound 100 % to that bone. Its colour becomes an MToon material in the avatar's toon look; the
VRM's skeleton, spring bones, expressions, face and MToon settings are untouched (glTF level, like live2d/assemble.py).
Refused, with the reason: unknown bones, no bone at all, a "teeth" part with depth (teeth are a flat drawn band),
more than 20,000 triangles in one part, parts far outside the avatar, hiding the Face or the Body.
"""
import json
import os
import re
import sys

import numpy as np  # noqa: F401  (before blender/ joins sys.path)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.append(os.path.dirname(HERE))

from anime_creator.vroid import Model, MeshData, compact_joints  # noqa: E402
from anime_creator import structure  # noqa: E402
from anime_creator.gltf import node_local  # noqa: E402

MAX_TRIS = 20000
MAX_PART_BYTES = 32 * 2 ** 20   # server/to3d/store.ts PART_MAX_BYTES: checked again here, right before a part is read
NEVER_HIDE = re.compile(r'^(face|body)(\.|$|_)', re.I)


class Refused(Exception):
    pass


def _world(m):
    return m.world()


def _bind_matrix(gp, skin, j):
    ib = gp.g.read(skin['inverseBindMatrices']).reshape(-1, 4, 4) if 'inverseBindMatrices' in skin else None
    W = _world(gp)
    jn = skin['joints'][j]
    return W[jn] @ (ib[j].T if ib is not None else np.eye(4))


def _tex_png(gp, mat):
    pbr = (gp.J['materials'][mat] if mat is not None else {}).get('pbrMetallicRoughness', {})
    ti = (pbr.get('baseColorTexture') or {}).get('index')
    if ti is None:
        return None, pbr.get('baseColorFactor', [1, 1, 1, 1])
    ii = gp.J['textures'][ti].get('source')
    return gp.g.image_bytes(ii), pbr.get('baseColorFactor', [1, 1, 1, 1])


def _toon_material(m, tpl, name, png, factor):
    """an MToon material cloned from the avatar's own cloth material: same toon look, the part's colour / texture"""
    mi = m.mat_index(name)
    if mi is None:
        mi = structure.clone_material(m, tpl, name)
    J = m.J['materials'][mi]
    mt = m.mtoon(mi)
    f = [float(x) for x in factor[:3]]
    J['pbrMetallicRoughness']['baseColorFactor'] = [min(1.0, x) for x in f] + [1.0]
    J.pop('normalTexture', None)
    if png:
        ii = m.g.add_image(png, name)
        ti = m.g.add_texture(ii, 0)
        J['pbrMetallicRoughness']['baseColorTexture'] = {'index': ti, 'texCoord': 0}
        mt['textureProperties'] = {'_MainTex': ti, '_ShadeTexture': ti}
    else:
        J['pbrMetallicRoughness'].pop('baseColorTexture', None)
        mt['textureProperties'] = {}
    vp = mt['vectorProperties']
    vp['_Color'] = f + [1]
    vp['_ShadeColor'] = [x * 0.78 for x in f] + [1]     # a warm-ish darker shade of the same colour (never grey)
    return mi


def graft(vrm_in, vrm_out, parts, hide=(), log=print):
    for path in parts:   # before anything is parsed: a part is a small accessory
        size = os.path.getsize(path)
        if size > MAX_PART_BYTES:
            raise Refused(f'{os.path.basename(path)} is {size // 2 ** 20} MB: a part must be under {MAX_PART_BYTES // 2 ** 20} MB')
    m = Model(vrm_in)
    W0 = _world(m)
    nodes = m.J['nodes']
    # the avatar's extent (rest): parts must sit on it
    allp = []
    for ni, n in enumerate(nodes):
        if n.get('mesh') is not None:
            d = m.read_mesh(n['mesh'])
            allp.append(d.P[:: max(1, len(d.P) // 500)])
    P0 = np.concatenate(allp)
    lo, hi = P0.min(0), P0.max(0)
    pad = (hi - lo) * 0.25
    lo, hi = lo - pad, hi + pad
    for h in hide:
        if NEVER_HIDE.search(h):
            raise Refused(f'"{h}" is the face or the body: it can\'t be hidden')
        structure.remove_node_mesh(m, h)
    tpl = next((i for i, mt in enumerate(m.J['materials']) if 'CLOTH' in mt.get('name', '')), 0)
    report = []
    for path in parts:
        pname = re.sub(r'[^A-Za-z0-9_]+', '_', os.path.splitext(os.path.basename(path))[0])[:40] or 'part'
        gp = Model(path)
        G = gp.J
        Wp = _world(gp)
        # a part re-sent replaces its older copy
        for ni, n in enumerate(nodes):
            if n.get('name', '').startswith(f'TO3D_{pname}'):
                n.pop('mesh', None); n.pop('skin', None)
        tris = 0
        for gi, gn in enumerate(G['nodes']):
            if gn.get('mesh') is None:
                continue
            d = gp.read_mesh(gn['mesh'])
            tris += sum(len(p['indices']) for p in d.prims) // 3
            if tris > MAX_TRIS:
                raise Refused(f'{pname} has more than {MAX_TRIS} triangles: keep parts light (party budget)')
            if 'skin' in gn:
                skin = G['skins'][gn['skin']]
                names = [G['nodes'][j].get('name', '') for j in skin['joints']]
                miss = [n for n in names if n not in m.byname]
                if miss:
                    raise Refused(f'{pname} uses bones the avatar doesn\'t have ({", ".join(miss[:3])}): skin it to the avatar\'s own bones')
                M = _bind_matrix(gp, skin, 0)
                joints = [m.byname[n] for n in names]
                Jn, Wt = d.J, d.W
            else:
                p, bone = gi, None
                parent = {c: i for i, x in enumerate(G['nodes']) for c in x.get('children', [])}
                while p in parent:
                    p = parent[p]
                    if G['nodes'][p].get('name', '') in m.byname:
                        bone = G['nodes'][p]['name']
                        break
                if bone is None:
                    raise Refused(f'{pname} is not skinned and not parented to a bone: parent it to a bone (e.g. J_Bip_C_Head) or skin it')
                M = Wp[gi]
                joints = [m.byname[bone]]
                Jn = np.zeros((len(d.P), 4), np.int64)
                Wt = np.zeros((len(d.P), 4)); Wt[:, 0] = 1
            P = (np.c_[d.P, np.ones(len(d.P))] @ M.T)[:, :3]
            N = d.N @ np.linalg.inv(M[:3, :3])
            if (P.min(0) < lo).any() or (P.max(0) > hi).any():
                raise Refused(f'{pname} sits outside the avatar: build it on the model (Blender: the candidate.blend)')
            if re.search(r'teeth|tooth', pname + ' ' + gn.get('name', ''), re.I) and np.ptp(P[:, 2]) > 0.002 and np.ptp(P[:, 1]) > 0.002 and np.ptp(P[:, 0]) > 0.002:
                raise Refused('teeth are a flat drawn band in the face texture, never 3D geometry')
            prims = []
            for k, pr in enumerate(d.prims):
                png, fac = _tex_png(gp, pr['material'])
                mi = _toon_material(m, tpl, f'TO3D_{pname}_{k}', png, fac)
                prims.append({'material': mi, 'indices': pr['indices'].astype(np.uint32), 'mode': 4})
            nd = MeshData(P, N, d.UV, Jn, Wt, prims, [], [])
            tj = compact_joints(nd, joints)
            m.J['skins'].append({'joints': tj})
            mi = m.write_mesh(None, nd, name=f'TO3D_{pname}.baked')
            m.add_node({'name': f'TO3D_{pname}', 'mesh': mi, 'skin': len(m.J['skins']) - 1}, None)
        report.append({'part': pname, 'triangles': tris})
        log(f'graft: {pname} ({tris} triangles)')
    structure.drop_empty_meshes(m)
    m.rebuild_ibms()
    m.save(vrm_out)
    return report


if __name__ == '__main__':
    a = sys.argv[1:]
    hide = []
    if '--hide' in a:
        i = a.index('--hide')
        hide, a = a[i + 1:], a[:i]
    try:
        rep = graft(a[0], a[1], a[2:], hide)
        print('TO3D_GRAFT_OK ' + json.dumps(rep))
    except Refused as e:
        print('TO3D_GRAFT_REFUSED ' + str(e))
        sys.exit(3)
