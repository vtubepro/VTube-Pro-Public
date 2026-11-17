"""
VRoid (VRM 0.x) model access on top of gltf.GLB: node tree + rest matrices, humanoid bones, the
Face / Body / Hair meshes as numpy vertex arrays (VRoid primitives of one mesh share one vertex
buffer), morph targets by their short Fcl_* name, MToon material properties, spring bones.

Coordinates are raw VRM0 glTF space: +Y up, the character faces -Z, character LEFT = -X.
"""
from __future__ import annotations

import copy
import re

import numpy as np

from .gltf import GLB, node_local, ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER


def short_morph(name: str) -> str:
    """'Face.M_F00_000_00_Fcl_MTH_A' -> 'Fcl_MTH_A'; ARKit / custom names pass through."""
    m = re.search(r'(Fcl_\w+)$', name)
    return m.group(1) if m else name.split('.')[-1]


class MeshData:
    """All primitives of one glTF mesh that share one vertex buffer (VRoid layout)."""

    def __init__(self, P, N, UV, J, W, prims, targets, target_names):
        self.P, self.N, self.UV, self.J, self.W = P, N, UV, J, W
        self.prims = prims                    # [{'material': int, 'indices': np.uint32 array, 'extras'?}]
        self.targets = targets                # [{'POSITION': (n,3), 'NORMAL': (n,3)?}]
        self.target_names = target_names      # full names as stored

    @property
    def n(self):
        return len(self.P)

    def verts_of(self, prim_ids) -> np.ndarray:
        if isinstance(prim_ids, int):
            prim_ids = [prim_ids]
        if not prim_ids:
            return np.zeros(0, np.int64)
        return np.unique(np.concatenate([self.prims[i]['indices'] for i in prim_ids]))

    def morph(self, short: str):
        for i, nm in enumerate(self.target_names):
            if short_morph(nm) == short:
                return i
        return None

    def compact(self):
        """Drop vertices no primitive references (after deleting prims / triangles)."""
        used = self.verts_of(list(range(len(self.prims))))
        remap = -np.ones(self.n, np.int64)
        remap[used] = np.arange(len(used))
        self.P, self.N, self.UV, self.J, self.W = (a[used] for a in (self.P, self.N, self.UV, self.J, self.W))
        for t in self.targets:
            for k in list(t):
                t[k] = t[k][used]
        for p in self.prims:
            p['indices'] = remap[p['indices']].astype(np.uint32)
        return remap


class Model:
    def __init__(self, path: str):
        self.path = path
        self.g = GLB(path)
        self.refresh()

    # ------------------------------------------------------------------ structure
    @property
    def J(self):
        return self.g.json

    @property
    def vrm(self):
        return self.J['extensions']['VRM']

    def refresh(self):
        J = self.J
        self.parent = {}
        for i, n in enumerate(J['nodes']):
            for c in n.get('children', []):
                self.parent[c] = i
        self.byname = {}
        for i, n in enumerate(J['nodes']):
            self.byname.setdefault(n.get('name', f'node{i}'), i)
        self._world = None

    def world(self) -> list[np.ndarray]:
        if self._world is None:
            nodes = self.J['nodes']
            W = [None] * len(nodes)

            def w(i):
                if W[i] is None:
                    L = node_local(nodes[i])
                    W[i] = (w(self.parent[i]) @ L) if i in self.parent else L
                return W[i]
            for i in range(len(nodes)):
                w(i)
            self._world = W
        return self._world

    def node(self, name: str) -> int:
        return self.byname[name]

    def pos(self, name_or_idx) -> np.ndarray:
        i = self.byname[name_or_idx] if isinstance(name_or_idx, str) else name_or_idx
        return self.world()[i][:3, 3].copy()

    def human(self, bone: str) -> int | None:
        for b in self.vrm['humanoid']['humanBones']:
            if b['bone'] == bone:
                return b['node']
        return None

    def subtree(self, i: int) -> list[int]:
        out = [i]
        for c in self.J['nodes'][i].get('children', []):
            out += self.subtree(c)
        return out

    def mesh_index(self, name_prefix: str) -> int | None:
        for i, m in enumerate(self.J['meshes']):
            if m.get('name', '').split('.')[0] == name_prefix:
                return i
        return None

    def node_of_mesh(self, mi: int) -> int | None:
        for i, n in enumerate(self.J['nodes']):
            if n.get('mesh') == mi:
                return i
        return None

    def mat_name(self, mi: int) -> str:
        return self.J['materials'][mi]['name']

    def mat_index(self, name: str) -> int | None:
        for i, m in enumerate(self.J['materials']):
            if m['name'] == name:
                return i
        return None

    def mtoon(self, mat: int) -> dict:
        return self.vrm['materialProperties'][mat]

    # ------------------------------------------------------------------ mesh io
    def read_mesh(self, mi: int) -> MeshData:
        m = self.J['meshes'][mi]
        p0 = m['primitives'][0]
        a = p0['attributes']
        for p in m['primitives'][1:]:
            if p['attributes'] != a:
                raise ValueError(f"mesh {m.get('name')}: primitives don't share vertex attributes")
        g = self.g
        P = g.read(a['POSITION']).astype(np.float64)
        N = g.read(a['NORMAL']).astype(np.float64) if 'NORMAL' in a else np.zeros_like(P)
        UV = g.read(a['TEXCOORD_0']).astype(np.float64) if 'TEXCOORD_0' in a else np.zeros((len(P), 2))
        Jn = g.read(a['JOINTS_0']).astype(np.int64) if 'JOINTS_0' in a else np.zeros((len(P), 4), np.int64)
        Wt = g.read(a['WEIGHTS_0']).astype(np.float64) if 'WEIGHTS_0' in a else np.zeros((len(P), 4))
        targets = []
        for t in p0.get('targets', []):
            targets.append({k: g.read(v).astype(np.float64) for k, v in t.items()})
        names = list(m.get('extras', {}).get('targetNames') or p0.get('extras', {}).get('targetNames') or
                     [f'morph{i}' for i in range(len(targets))])
        prims = [{'material': p.get('material'), 'indices': g.read(p['indices']).astype(np.uint32),
                  'mode': p.get('mode', 4)} for p in m['primitives']]
        return MeshData(P, N, UV, Jn, Wt, prims, targets, names)

    def write_mesh(self, mi: int, d: MeshData, name: str | None = None):
        g = self.g
        attrs = {
            'POSITION': g.add_accessor(d.P.astype(np.float32), 'VEC3', ARRAY_BUFFER, minmax=True),
            'NORMAL': g.add_accessor(_unit(d.N).astype(np.float32), 'VEC3', ARRAY_BUFFER),
            'TEXCOORD_0': g.add_accessor(d.UV.astype(np.float32), 'VEC2', ARRAY_BUFFER),
            'JOINTS_0': g.add_accessor(d.J.astype(np.uint16), 'VEC4', ARRAY_BUFFER),
            'WEIGHTS_0': g.add_accessor(d.W.astype(np.float32), 'VEC4', ARRAY_BUFFER),
        }
        tg = []
        for t in d.targets:
            e = {'POSITION': g.add_accessor(t['POSITION'].astype(np.float32), 'VEC3', ARRAY_BUFFER, minmax=True)}
            if 'NORMAL' in t:
                e['NORMAL'] = g.add_accessor(t['NORMAL'].astype(np.float32), 'VEC3', ARRAY_BUFFER, minmax=True)
            tg.append(e)
        prims = []
        for p in d.prims:
            if len(p['indices']) == 0:
                continue
            q = {'attributes': dict(attrs), 'indices': g.add_accessor(p['indices'].astype(np.uint32), 'SCALAR',
                                                                     ELEMENT_ARRAY_BUFFER),
                 'material': p['material'], 'mode': p.get('mode', 4)}
            if tg:
                q['targets'] = [dict(t) for t in tg]
                q['extras'] = {'targetNames': list(d.target_names)}
            prims.append(q)
        if mi is None:
            self.J['meshes'].append({'name': name or 'mesh', 'primitives': prims})
            mi = len(self.J['meshes']) - 1
        else:
            m = self.J['meshes'][mi]
            m['primitives'] = prims
            if name:
                m['name'] = name
        if tg:
            self.J['meshes'][mi].setdefault('extras', {})['targetNames'] = list(d.target_names)
        return mi

    # ------------------------------------------------------------------ skins
    def skin_of_mesh(self, mi: int) -> int | None:
        n = self.node_of_mesh(mi)
        return self.J['nodes'][n].get('skin') if n is not None else None

    def skin_joints(self, si: int) -> list[int]:
        return list(self.J['skins'][si]['joints'])

    def rebuild_ibms(self):
        """Inverse bind matrices = inverse(rest world) for every skin (after moving bones)."""
        self._world = None
        W = self.world()
        for s in self.J['skins']:
            ib = np.stack([np.linalg.inv(W[j]).T.reshape(16) for j in s['joints']]).astype(np.float32)
            s['inverseBindMatrices'] = self.g.add_accessor(ib, 'MAT4', None)

    def add_node(self, node: dict, parent: int | None) -> int:
        self.J['nodes'].append(node)
        i = len(self.J['nodes']) - 1
        if parent is None:
            self.J['scenes'][self.J.get('scene', 0)]['nodes'].append(i)
        else:
            self.J['nodes'][parent].setdefault('children', []).append(i)
        self.refresh()
        return i

    def save(self, path: str):
        self.g.save(path)


def compact_joints(d: MeshData, joints: list[int]) -> list[int]:
    """Keep only the skin joints that carry weight (no duplicate bones: three-vrm's combineSkeletons
    mis-remaps skins that list one bone twice). Rewrites d.J in place; returns the new joint list."""
    out, idx = [], {}
    newJ = np.zeros_like(d.J)
    for k in range(4):
        for v in np.unique(d.J[:, k]):
            node = joints[int(v)]
            sel = d.J[:, k] == v
            if not (d.W[sel, k] > 0).any():
                node = None
            if node is None:
                newJ[sel, k] = 0 if not out else 0
                continue
            if node not in idx:
                idx[node] = len(out); out.append(node)
            newJ[sel, k] = idx[node]
    if not out:
        out = [joints[0]]
    d.J = newJ
    d.W[d.W < 0] = 0
    return out


def _unit(v):
    n = np.linalg.norm(v, axis=1, keepdims=True)
    n[n < 1e-12] = 1
    return v / n


def deepcopy(x):
    return copy.deepcopy(x)
