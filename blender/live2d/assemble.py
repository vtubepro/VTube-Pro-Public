"""Put the Live2D-derived toolkit hair (Hair.npz / Hair_Ink.npz / hair_bones.json from hair_blender.py) into the
converted VRM in place of the VRoid donor hair: skinned mesh nodes on the VRM skeleton, MToon materials (hair = proxy
normals, no MToon outline; ink = constant emission hull), one VRM0 spring group per chain (stiff fringe, looser back),
colliding with the VRoid head colliders. Same recipe as the an earlier internal build build (an internal build).
"""
import json
import os

import numpy as np

from anime_creator.vroid import Model, MeshData, compact_joints
from anime_creator import structure, hair as hairmod

# (stiffness, gravity, drag, hit radius) per chain family; Live2D physics3 strength scales stiffness (see tune())
TUNE = {'fringe': (2.8, 0.02, 0.6, 0.01), 'side': (2.3, 0.05, 0.5, 0.01), 'back': (1.6, 0.07, 0.5, 0.012),
        'ahoge': (2.0, 0.02, 0.5, 0.008)}


def _mat(m, tpl, name, tex_png, shade, extra=None, emission=None, color=(1, 1, 1)):
    mi = m.mat_index(name)
    if mi is not None:
        return mi
    mi = structure.clone_material(m, tpl, name)
    J = m.J['materials'][mi]; mt = m.mtoon(mi)
    ii = m.g.add_image(open(tex_png, 'rb').read(), os.path.splitext(os.path.basename(tex_png))[0])
    ti = m.g.add_texture(ii, 0)
    J['pbrMetallicRoughness']['baseColorTexture'] = {'index': ti, 'texCoord': 0}
    J['pbrMetallicRoughness']['baseColorFactor'] = [min(c, 1.0) for c in color] + [1]      # glTF clamps; MToon _Color may exceed 1
    J.pop('normalTexture', None)
    J['alphaMode'] = 'OPAQUE'; J.pop('alphaCutoff', None)
    J['doubleSided'] = False
    mt['textureProperties'] = {'_MainTex': ti, '_ShadeTexture': ti}
    mt['keywordMap'] = {}
    mt['tagMap'] = {'RenderType': 'Opaque'}
    mt['renderQueue'] = 2000
    fp = mt['floatProperties']
    fp.update({'_BlendMode': 0, '_CullMode': 2, '_ZWrite': 1, '_SrcBlend': 1, '_DstBlend': 0, '_ShadeShift': 0.0,
               '_ShadeToony': 0.95, '_ReceiveShadowRate': 1, '_OutlineWidthMode': 0, '_OutlineWidth': 0,
               '_OutlineColorMode': 1, '_OutlineLightingMix': 1, '_RimLightingMix': 0, '_IndirectLightIntensity': 0.1})
    fp.update(extra or {})
    if (extra or {}).get('_CullMode') == 0:
        # double-sided hair: a lock that turns inside-out at a sharp bend would otherwise show the black ink hull
        # through its missing back faces
        J['doubleSided'] = True
    vp = mt['vectorProperties']
    vp['_Color'] = [*color, 1]
    vp['_ShadeColor'] = [*shade, 1]
    vp['_OutlineColor'] = [0.12, 0.08, 0.14, 1]
    if emission is not None:
        vp['_EmissionColor'] = [*emission, 1]
        J['emissiveFactor'] = list(emission)
    else:
        vp['_EmissionColor'] = [0, 0, 0, 1]
        J.pop('emissiveTexture', None); J['emissiveFactor'] = [0, 0, 0]
    mt['textureProperties'].pop('_EmissionMap', None)
    mt['textureProperties'].pop('_SphereAdd', None)
    return mi


def _clean_skin(d, nj):
    """glTF validity: weights normalised in float32, zero-weight slots pointing at distinct unused joints"""
    W = np.clip(d.W, 0, None).astype(np.float64)
    W[W < 1e-5] = 0
    s = W.sum(1, keepdims=True)
    W = np.where(s > 0, W / np.maximum(s, 1e-12), np.array([[1.0, 0, 0, 0]]))
    J = d.J.copy()
    for v in np.nonzero((W == 0).any(1))[0]:
        used = {int(J[v, k]) for k in range(4) if W[v, k] > 0}
        free = [j for j in range(max(nj, 4) + 4) if j not in used]
        for k in range(4):
            if W[v, k] == 0:
                J[v, k] = free.pop(0) % max(nj, 1) if nj >= 4 else free.pop(0) if free[0] < nj else 0
    W32 = W.astype(np.float32)
    W32[:, 0] += (1.0 - W32.sum(1))                  # exact unit sum after the cast
    d.W, d.J = W32, J


def _add_part(m, part, name, mat_for, log=print):
    bones = [str(b) for b in part['bones']]
    joints = [m.byname[b] for b in bones]
    P = part['P'].astype(np.float64); N = part['N'].astype(np.float64); UV = part['UV'].astype(np.float64)
    # degenerate needle tips can leave a zero normal (glTF: normals must be unit length)
    ln = np.linalg.norm(N, axis=1, keepdims=True)
    N = np.where(ln > 1e-6, N / np.maximum(ln, 1e-12), np.array([[0.0, 1.0, 0.0]]))
    Jn = part['J'].astype(np.int64); W = part['W'].astype(np.float64)
    W = W / np.maximum(W.sum(1, keepdims=True), 1e-9)
    prims = []
    for k, mn in enumerate(str(x) for x in part['mat_names']):
        tri = part['T'][part['M'] == k]
        prims.append({'material': mat_for(mn), 'indices': tri.reshape(-1).astype(np.uint32), 'mode': 4})
    d = MeshData(P, N, UV, Jn, W, prims, [], [])
    tj = compact_joints(d, joints)
    _clean_skin(d, len(tj))
    m.J['skins'].append({'joints': tj})                 # no 'skeleton': must be a common root (validator), optional
    si = len(m.J['skins']) - 1
    mi = m.write_mesh(None, d, name=name + '.baked')
    m.add_node({'name': name, 'mesh': mi, 'skin': si}, None)
    log(f'part {name}: {len(P)} verts, {sum(len(p["indices"]) for p in prims) // 3} tris, {len(tj)} joints')


def _hair_bones(m, specs, strength=None, log=print):
    heads = {}
    for b in specs:
        par = heads.get(b['parent'], m.byname.get(b['parent']))
        W = m.world()
        L = np.linalg.inv(W[par]) @ np.r_[np.array(b['head']), 1]
        heads[b['name']] = m.add_node({'name': b['name'], 'translation': [float(x) for x in L[:3]]}, par)
    sa = m.vrm['secondaryAnimation']
    cgs = list(range(len(sa['colliderGroups'])))
    groups = {}
    for b in specs:
        if b['name'].endswith('_0'):
            chain = b['name'][len('HairLock_'):-2]
            groups.setdefault(chain, []).append(heads[b['name']])
    for chain, bones in groups.items():
        fam = 'fringe' if chain.startswith('fringe') else 'side' if chain.startswith('side') else \
            'ahoge' if chain.startswith('ahoge') else 'back'
        st, gp, dr, hr = TUNE[fam]
        if strength and fam in strength:          # Live2D physics: a softer pendulum there = a looser chain here
            st *= float(np.clip(strength[fam], 0.6, 1.4))
        # fringe / side locks are built lying on the face, inside the VRoid head collider spheres: colliding would
        # shove them off the forehead at the first frame, so they swing free (stiff); back / tail hair collides
        free = fam in ('fringe', 'side', 'ahoge')
        sa['boneGroups'].append({'comment': f'Hair_{chain}', 'stiffiness': st, 'gravityPower': gp,
                                 'gravityDir': {'x': 0, 'y': -1, 'z': 0}, 'dragForce': dr, 'center': -1,
                                 'hitRadius': hr, 'bones': bones, 'colliderGroups': [] if free else cgs})
    log(f'hair bones: {len(specs)} joints, {len(groups)} spring groups')


def assemble(vrm_in, hair_dir, vrm_out, exposure_comp=1.0, strength=None, log=print):
    m = Model(vrm_in)
    hairmod.remove_hair(m)
    # the creator names the transplanted VRoid hair node 'Hair' (and a re-run leaves our own L2D hair): drop every mesh
    # node whose materials are all hair, by node index (names repeat)
    fp = m.vrm['firstPerson']
    for ni, n in enumerate(m.J['nodes']):
        mi = n.get('mesh')
        if mi is None or mi >= len(m.J['meshes']):
            continue
        mats = [m.mat_name(p['material']) for p in m.J['meshes'][mi]['primitives'] if p.get('material') is not None]
        if mats and all('HAIR' in x.upper() for x in mats):
            n.pop('mesh', None); n.pop('skin', None)
            m.J['meshes'][mi]['primitives'] = []
            fp['meshAnnotations'] = [a for a in fp.get('meshAnnotations', []) if a.get('mesh') != mi]
    # spring groups whose bones are earlier L2D hair joints
    old = {i for i, n in enumerate(m.J['nodes']) if n.get('name', '').startswith('HairLock_')}
    sa = m.vrm['secondaryAnimation']
    sa['boneGroups'] = [g for g in sa['boneGroups'] if not set(g['bones']) & old]
    for n in m.J['nodes']:
        if 'children' in n:
            n['children'] = [c for c in n['children'] if c not in old]
    m.refresh()
    specs = json.load(open(os.path.join(hair_dir, 'hair_bones.json')))
    _hair_bones(m, specs, strength, log)
    meta = json.load(open(os.path.join(hair_dir, 'hair_meta.json')))
    tpl = next(i for i, mt in enumerate(m.J['materials']) if 'CLOTH' in mt.get('name', '') or 'Body' in mt.get('name', ''))
    k = exposure_comp

    def mat_for(mn):
        if 'Ink' in mn:
            return _mat(m, tpl, 'L2D_HairInk', os.path.join(hair_dir, 'hair_ink_solid.png'), (0, 0, 0),
                        emission=tuple(meta['ink']), color=(0, 0, 0))
        return _mat(m, tpl, 'L2D_Hair', os.path.join(hair_dir, 'hair_atlas.png'), tuple(meta['shade_mul']),
                    extra={'_ShadeShift': 0.05, '_CullMode': 0}, color=(k, k, k))
    for nm in ('Hair', 'Hair_Ink'):
        p = os.path.join(hair_dir, nm + '.npz')
        if os.path.exists(p):
            z = np.load(p, allow_pickle=False)
            _add_part(m, {k_: z[k_] for k_ in z.files}, nm, mat_for, log)
    structure.drop_empty_meshes(m)
    m.rebuild_ibms()
    m.save(vrm_out)
    log(f'assembled -> {vrm_out} ({os.path.getsize(vrm_out) / 1e6:.1f} MB)')
