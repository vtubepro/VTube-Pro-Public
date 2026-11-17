"""
Structural edits on a VRoid model: split the baked Body mesh into named parts (skin / tops / bottoms /
shoes / accessories / hair base) so costumes can hide garments by node name, delete primitives or
triangles, and graft whole meshes (hair, garments) from a donor VRoid model onto this skeleton.
"""
from __future__ import annotations

import re

import numpy as np

from .vroid import Model, MeshData, deepcopy

PART_RULES = [  # material-name regex -> part node name
    (r'_Body_\d+_SKIN', 'Body'),
    (r'HairBack', 'HairBase'),
    (r'_Tops_', 'Outfit_Tops'),
    (r'_Onepiece_', 'Outfit_Tops'),
    (r'_Bottoms_', 'Outfit_Bottoms'),
    (r'_Shoes_', 'Outfit_Shoes'),
    (r'_Accessory', 'Outfit_Accessory'),
]


def part_of(mat_name: str) -> str:
    for rx, part in PART_RULES:
        if re.search(rx, mat_name):
            return part
    return 'Outfit_Other'


def split_body(m: Model) -> dict[str, int]:
    """Split mesh 'Body' into one mesh + node per part. Returns {part: node index}."""
    bi = m.mesh_index('Body')
    bn = m.node_of_mesh(bi)
    d = m.read_mesh(bi)
    skin = m.J['nodes'][bn]['skin']
    groups: dict[str, list[int]] = {}
    for pi, p in enumerate(d.prims):
        groups.setdefault(part_of(m.mat_name(p['material'])), []).append(pi)
    out = {}
    first = True
    for part, pis in groups.items():
        sub = MeshData(d.P, d.N, d.UV, d.J, d.W, [d.prims[i] for i in pis], [], [])
        sub = _copy_md(sub)
        sub.compact()
        if first:
            m.write_mesh(bi, sub, name=part + '.baked')
            m.J['nodes'][bn]['name'] = part
            out[part] = bn; first = False
        else:
            mi = m.write_mesh(None, sub, name=part + '.baked')
            ni = m.add_node({'name': part, 'mesh': mi, 'skin': skin}, None)
            out[part] = ni
    m.refresh()
    return out


def _copy_md(d: MeshData) -> MeshData:
    return MeshData(d.P.copy(), d.N.copy(), d.UV.copy(), d.J.copy(), d.W.copy(),
                    [{**p, 'indices': p['indices'].copy()} for p in d.prims],
                    [{k: v.copy() for k, v in t.items()} for t in d.targets], list(d.target_names))


def part_nodes(m: Model) -> dict[str, int]:
    return {m.J['nodes'][i]['name']: i for i in m.J['scenes'][0]['nodes'] if 'mesh' in m.J['nodes'][i]}


def remove_node_mesh(m: Model, node_name: str):
    """Detach a mesh node from the scene (mesh data is dropped at save by repack)."""
    ni = m.byname.get(node_name)
    if ni is None:
        return
    mi = m.J['nodes'][ni].pop('mesh', None)
    m.J['nodes'][ni].pop('skin', None)
    if mi is not None:
        m.J['meshes'][mi]['primitives'] = []
    # firstPerson annotations pointing at it
    fp = m.vrm['firstPerson']
    fp['meshAnnotations'] = [a for a in fp.get('meshAnnotations', []) if a.get('mesh') != mi]


def drop_empty_meshes(m: Model):
    """Remove meshes with no primitives + remap mesh indices everywhere (nodes, VRM binds/annotations)."""
    J = m.J
    keep = [i for i, me in enumerate(J['meshes']) if me['primitives']]
    remap = {o: n for n, o in enumerate(keep)}
    J['meshes'] = [J['meshes'][i] for i in keep]
    for n in J['nodes']:
        if 'mesh' in n:
            if n['mesh'] in remap:
                n['mesh'] = remap[n['mesh']]
            else:
                n.pop('mesh'); n.pop('skin', None)
    for bg in m.vrm['blendShapeMaster']['blendShapeGroups']:
        bg['binds'] = [dict(b, mesh=remap[b['mesh']]) for b in bg['binds'] if b['mesh'] in remap]
    fp = m.vrm['firstPerson']
    fp['meshAnnotations'] = [dict(a, mesh=remap[a['mesh']]) for a in fp.get('meshAnnotations', []) if a.get('mesh') in remap]


def delete_triangles(d: MeshData, prim: int, tri_mask: np.ndarray):
    """Remove triangles (bool mask over the prim's triangles) from one primitive."""
    idx = d.prims[prim]['indices'].reshape(-1, 3)
    d.prims[prim]['indices'] = idx[~tri_mask].reshape(-1).astype(np.uint32)


# ---------------------------------------------------------------------- materials / textures copy
def copy_material(dst: Model, src: Model, mat: int, tex_cache: dict, rename: str | None = None) -> int:
    """Copy a material (+ its textures/images + MToon properties) from src into dst. Returns new index."""
    key = ('mat', id(src), mat)
    if key in tex_cache:
        return tex_cache[key]

    def tex(ti):
        k = ('tex', id(src), ti)
        if k not in tex_cache:
            t = src.J['textures'][ti]
            ii = t['source']
            ki = ('img', id(src), ii)
            if ki not in tex_cache:
                im = src.J['images'][ii]
                tex_cache[ki] = dst.g.add_image(src.g.image_bytes(ii), im.get('name', 'img'), im.get('mimeType', 'image/png'))
            samp = src.J['samplers'][t.get('sampler', 0)] if 'samplers' in src.J else {}
            dst.J.setdefault('samplers', [])
            try:
                si = dst.J['samplers'].index(samp)
            except ValueError:
                dst.J['samplers'].append(samp); si = len(dst.J['samplers']) - 1
            tex_cache[k] = dst.g.add_texture(tex_cache[ki], si)
        return tex_cache[k]

    md = deepcopy(src.J['materials'][mat])
    for k, v in list(md.items()):
        _retex(v, tex)
    mp = deepcopy(src.vrm['materialProperties'][mat])
    mp['textureProperties'] = {k: tex(v) for k, v in mp.get('textureProperties', {}).items()}
    if rename:
        md['name'] = rename; mp['name'] = rename
    # keep names unique in dst
    names = {x['name'] for x in dst.J['materials']}
    base = md['name']; k = 1
    while md['name'] in names:
        md['name'] = f'{base}_{k}'; k += 1
    mp['name'] = md['name']
    dst.J['materials'].append(md)
    dst.vrm['materialProperties'].append(mp)
    ni = len(dst.J['materials']) - 1
    tex_cache[key] = ni
    return ni


def _retex(v, tex):
    if isinstance(v, dict):
        if 'index' in v and isinstance(v['index'], int) and set(v) <= {'index', 'texCoord', 'scale', 'strength', 'extensions', 'extras'}:
            v['index'] = tex(v['index'])
        for x in v.values():
            _retex(x, tex)
    elif isinstance(v, list):
        for x in v:
            _retex(x, tex)


def clone_material(m: Model, mat: int, name: str) -> int:
    """Duplicate a material within the same model (shares textures until recoloured)."""
    md = deepcopy(m.J['materials'][mat]); mp = deepcopy(m.vrm['materialProperties'][mat])
    md['name'] = name; mp['name'] = name
    m.J['materials'].append(md); m.vrm['materialProperties'].append(mp)
    return len(m.J['materials']) - 1
