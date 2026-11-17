"""
Minimal, dependency-light GLB (glTF 2.0 binary) reader/writer for editing VRM files in place.

Everything VRM-specific (extensions, extras) is kept verbatim in `self.json`; this module only knows
how to read/write accessors (as numpy arrays), images and to repack the binary chunk so that data
orphaned by edits is dropped.  numpy is the only requirement (Blender's bundled python has it).
"""
from __future__ import annotations

import json
import struct

import numpy as np

COMP = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
COMP_OF = {np.dtype(v): k for k, v in COMP.items()}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT2': 4, 'MAT3': 9, 'MAT4': 16}
ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER = 34962, 34963


class GLB:
    def __init__(self, path: str | None = None):
        self.json: dict = {}
        self.bin = bytearray()
        if path:
            self.load(path)

    # ------------------------------------------------------------------ io
    def load(self, path: str):
        b = open(path, 'rb').read()
        magic, _ver, _ln = struct.unpack('<III', b[:12])
        if magic != 0x46546C67:
            raise ValueError(f'{path}: not a GLB')
        off = 12
        while off < len(b):
            cl, ct = struct.unpack('<II', b[off:off + 8])
            data = b[off + 8: off + 8 + cl]
            if ct == 0x4E4F534A:
                self.json = json.loads(data.decode('utf-8'))
            elif ct == 0x004E4942:
                self.bin = bytearray(data)
            off += 8 + cl
        return self

    def save(self, path: str, repack: bool = True):
        if repack:
            self.repack()
        self.json['buffers'] = [{'byteLength': len(self.bin)}]
        js = json.dumps(self.json, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
        js += b' ' * ((4 - len(js) % 4) % 4)
        bn = bytes(self.bin) + b'\0' * ((4 - len(self.bin) % 4) % 4)
        total = 12 + 8 + len(js) + 8 + len(bn)
        with open(path, 'wb') as f:
            f.write(struct.pack('<III', 0x46546C67, 2, total))
            f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
            f.write(struct.pack('<II', len(bn), 0x004E4942)); f.write(bn)

    # ------------------------------------------------------------------ accessors
    def view_bytes(self, vi: int) -> bytes:
        v = self.json['bufferViews'][vi]
        o = v.get('byteOffset', 0)
        return bytes(self.bin[o:o + v['byteLength']])

    def read(self, ai: int) -> np.ndarray:
        a = self.json['accessors'][ai]
        dt = COMP[a['componentType']]
        n = NCOMP[a['type']]
        cnt = a['count']
        if 'bufferView' in a:
            v = self.json['bufferViews'][a['bufferView']]
            o = v.get('byteOffset', 0) + a.get('byteOffset', 0)
            stride = v.get('byteStride', 0)
            isz = np.dtype(dt).itemsize * n
            if stride and stride != isz:
                raw = np.frombuffer(self.bin, dtype=np.uint8, count=stride * (cnt - 1) + isz, offset=o)
                out = np.empty((cnt, isz), np.uint8)
                for i in range(cnt):
                    out[i] = raw[i * stride:i * stride + isz]
                arr = out.view(dt).reshape(cnt, n)
            else:
                arr = np.frombuffer(self.bin, dtype=dt, count=cnt * n, offset=o).reshape(cnt, n).copy()
        else:
            arr = np.zeros((cnt, n), dt)
        if 'sparse' in a:
            sp = a['sparse']
            ii = sp['indices']; vv = sp['values']
            iv = self.json['bufferViews'][ii['bufferView']]
            idx = np.frombuffer(self.bin, dtype=COMP[ii['componentType']], count=sp['count'],
                                offset=iv.get('byteOffset', 0) + ii.get('byteOffset', 0))
            vw = self.json['bufferViews'][vv['bufferView']]
            val = np.frombuffer(self.bin, dtype=dt, count=sp['count'] * n,
                                offset=vw.get('byteOffset', 0) + vv.get('byteOffset', 0)).reshape(-1, n)
            arr[idx] = val
        if a.get('normalized') and dt != np.float32:
            pass  # callers that need floats convert themselves
        return arr if n > 1 else arr.reshape(cnt)

    def add_view(self, data: bytes, target: int | None = None) -> int:
        while len(self.bin) % 4:
            self.bin.append(0)
        v = {'buffer': 0, 'byteOffset': len(self.bin), 'byteLength': len(data)}
        if target:
            v['target'] = target
        self.bin += data
        self.json.setdefault('bufferViews', []).append(v)
        return len(self.json['bufferViews']) - 1

    def add_accessor(self, arr: np.ndarray, type_: str | None = None, target: int | None = ARRAY_BUFFER,
                     minmax: bool = False, normalized: bool = False) -> int:
        arr = np.ascontiguousarray(arr)
        if arr.dtype == np.float64:
            arr = arr.astype(np.float32)
        if arr.dtype == np.int64:
            arr = arr.astype(np.uint32)
        n = 1 if arr.ndim == 1 else arr.shape[1]
        type_ = type_ or {1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4', 16: 'MAT4'}[n]
        vi = self.add_view(arr.tobytes(), target)
        a = {'bufferView': vi, 'componentType': COMP_OF[arr.dtype], 'count': int(arr.shape[0]), 'type': type_}
        if normalized:
            a['normalized'] = True
        if minmax or type_ == 'VEC3' and target == ARRAY_BUFFER:
            r = arr.reshape(arr.shape[0], -1)
            if len(r):
                a['min'] = [float(x) for x in r.min(0)]
                a['max'] = [float(x) for x in r.max(0)]
        self.json.setdefault('accessors', []).append(a)
        return len(self.json['accessors']) - 1

    def set_accessor(self, ai: int, arr: np.ndarray):
        """Replace an accessor's data (new buffer view; old bytes are dropped by repack)."""
        old = self.json['accessors'][ai]
        tgt = self.json['bufferViews'][old['bufferView']].get('target') if 'bufferView' in old else ARRAY_BUFFER
        arr = np.ascontiguousarray(arr).astype(COMP[old['componentType']])
        ni = self.add_accessor(arr, old['type'], tgt)
        new = self.json['accessors'].pop()
        for k in ('normalized',):
            if k in old:
                new[k] = old[k]
        self.json['accessors'][ai] = new

    # ------------------------------------------------------------------ images
    def image_bytes(self, ii: int) -> bytes:
        return self.view_bytes(self.json['images'][ii]['bufferView'])

    def set_image(self, ii: int, png: bytes, mime: str = 'image/png'):
        im = self.json['images'][ii]
        im['bufferView'] = self.add_view(png)
        im['mimeType'] = mime

    def add_image(self, png: bytes, name: str, mime: str = 'image/png') -> int:
        self.json.setdefault('images', []).append({'name': name, 'bufferView': self.add_view(png), 'mimeType': mime})
        return len(self.json['images']) - 1

    def add_texture(self, image: int, sampler: int = 0) -> int:
        self.json.setdefault('textures', []).append({'sampler': sampler, 'source': image})
        return len(self.json['textures']) - 1

    # ------------------------------------------------------------------ repack
    def repack(self):
        """Rebuild the binary chunk with only the buffer views still referenced (accessors, images,
        sparse data); unreferenced views/accessors are removed and indices remapped."""
        J = self.json
        # drop unreferenced accessors
        used_acc = set()

        def mark_acc(i):
            if i is not None:
                used_acc.add(i)
        for m in J.get('meshes', []):
            for p in m['primitives']:
                for v in p['attributes'].values():
                    mark_acc(v)
                mark_acc(p.get('indices'))
                for t in p.get('targets', []):
                    for v in t.values():
                        mark_acc(v)
        for s in J.get('skins', []):
            mark_acc(s.get('inverseBindMatrices'))
        for an in J.get('animations', []):
            for smp in an['samplers']:
                mark_acc(smp['input']); mark_acc(smp['output'])
        amap = {}
        newacc = []
        for i, a in enumerate(J.get('accessors', [])):
            if i in used_acc:
                amap[i] = len(newacc); newacc.append(a)

        def ra(i):
            return amap[i]
        for m in J.get('meshes', []):
            for p in m['primitives']:
                p['attributes'] = {k: ra(v) for k, v in p['attributes'].items()}
                if 'indices' in p:
                    p['indices'] = ra(p['indices'])
                if 'targets' in p:
                    p['targets'] = [{k: ra(v) for k, v in t.items()} for t in p['targets']]
        for s in J.get('skins', []):
            if 'inverseBindMatrices' in s:
                s['inverseBindMatrices'] = ra(s['inverseBindMatrices'])
        for an in J.get('animations', []):
            for smp in an['samplers']:
                smp['input'] = ra(smp['input']); smp['output'] = ra(smp['output'])
        J['accessors'] = newacc
        # views referenced
        refs = []  # (holder dict, key)
        for a in newacc:
            if 'bufferView' in a:
                refs.append((a, 'bufferView'))
            if 'sparse' in a:
                refs.append((a['sparse']['indices'], 'bufferView')); refs.append((a['sparse']['values'], 'bufferView'))
        for im in J.get('images', []):
            if 'bufferView' in im:
                refs.append((im, 'bufferView'))
        oldviews = J.get('bufferViews', [])
        vmap = {}
        newviews = []
        out = bytearray()
        for holder, key in refs:
            vi = holder[key]
            if vi not in vmap:
                v = dict(oldviews[vi])
                data = self.view_bytes(vi)
                while len(out) % 4:
                    out.append(0)
                v['byteOffset'] = len(out); v['buffer'] = 0
                out += data
                vmap[vi] = len(newviews); newviews.append(v)
            holder[key] = vmap[vi]
        J['bufferViews'] = newviews
        self.bin = out


# ---------------------------------------------------------------------- math helpers
def quat_to_mat(q):
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def node_local(n) -> np.ndarray:
    if 'matrix' in n:
        return np.array(n['matrix'], float).reshape(4, 4).T
    M = np.eye(4)
    s = n.get('scale', [1, 1, 1])
    M[:3, :3] = quat_to_mat(n.get('rotation', [0, 0, 0, 1])) * np.array(s)
    M[:3, 3] = n.get('translation', [0, 0, 0])
    return M
