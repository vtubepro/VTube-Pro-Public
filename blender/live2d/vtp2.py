"""A Pro2D (.vtp2) avatar as the Live2D pipeline's model: the same surface as model3.L2DModel.

A Pro2D avatar keeps only its .vtp2 (docs/RIG2D_FORMAT.md: the original Live2D / Inochi2D files are never kept), so
tools/pro2d_bundle.ts evaluates the rig with the runtime's own evaluator and writes a bundle; this class serves it to
analyze / design / eyefit / hair2d / turnaround / render exactly like the moc3 reader does:

    m = Vtp2Model.load('<bundle dir>')        # tools/pro2d_bundle.ts export <in.vtp2> <bundle dir>
    pose = m.pose({'ParamAngleX': 30})        # a precomputed pose, else evaluated once by `pro2d_bundle eval` (cached)

Standard Cubism ids the rig doesn't have (an Inochi2D "Head Yaw", a 2D-maker rig) are answered through the rig's own
tracking bindings (bundle.json stdAliases): ParamAngleX 30 = a 30 deg head turn through that binding's range.
The evaluator command comes from VTP_PRO2D_EVAL (a JSON list, e.g. ["node", ".../dist-helper/pro2d_bundle.mjs"]).
"""
import json
import os
import subprocess

import numpy as np
from PIL import Image

from .render import premul


class _S:
    pass


class _Moc:
    """the parts of moc3.Moc3 the pipeline reads"""

    def __init__(self, b, geom):
        n = len(b['meshes'])
        self.version = 'vtp2'
        self.canvas = dict(b['canvas'])
        self.canvas.setdefault('flags', 0)
        self.param_ids = [p['id'] for p in b['params']]
        self.part_ids = [p['id'] for p in b['parts']]
        self.deformer_ids = [d['id'] for d in b['deformers']]
        self.art_ids = [m['id'] for m in b['meshes']]
        self.counts = {'arts': n, 'params': len(self.param_ids), 'parts': len(self.part_ids), 'deformers': len(self.deformer_ids)}
        self.art_uv, self.art_tri = [], []
        for m in b['meshes']:
            v = m['vertexCount']
            self.art_uv.append(np.frombuffer(geom, np.float32, v * 2, m['uvOffset']).reshape(v, 2).astype(np.float64))
            self.art_tri.append(np.frombuffer(geom, np.int32, m['triCount'] * 3, m['triOffset']).reshape(-1, 3).astype(int))
        s = _S()
        s.arts = _S()
        s.arts.ids = self.art_ids
        s.arts.parentPart = np.array([m['part'] for m in b['meshes']], int)
        s.arts.parentDeformer = np.array([m['deformer'] for m in b['meshes']], int)
        s.arts.textureNo = np.array([m['texture'] for m in b['meshes']], int)
        s.arts.vertexCounts = np.array([m['vertexCount'] for m in b['meshes']], int)
        s.arts.visible = np.array([1 if m.get('visible', True) else 0 for m in b['meshes']], int)
        s.arts.enabled = np.array([1 if m.get('enabled', True) else 0 for m in b['meshes']], int)
        # flags: bits 0-1 blend (0 normal, 1 add, 2 multiply), bit 3 inverted mask (as moc3)
        s.arts.flags = np.array([(m['blend'] & 3) | (8 if m.get('maskInvert') else 0) for m in b['meshes']], int)
        masks, begin, count = [], [], []
        for m in b['meshes']:
            begin.append(len(masks)); count.append(len(m['masks'])); masks += m['masks']
        s.arts.maskBegin = np.array(begin, int)
        s.arts.maskCount = np.array(count, int)
        s.masks = _S()
        s.masks.art = np.array(masks or [-1], int)
        s.parts = _S()
        s.parts.ids = self.part_ids
        s.parts.parentPart = np.array([p['parent'] for p in b['parts']], int)
        s.deformers = _S()
        s.deformers.ids = self.deformer_ids
        s.deformers.parentDeformer = np.array([d['parent'] for d in b['deformers']], int)
        s.params = _S()
        s.params.ids = self.param_ids
        s.params.min = np.array([p['min'] for p in b['params']], float)
        s.params.max = np.array([p['max'] for p in b['params']], float)
        s.params.default = np.array([p['default'] for p in b['params']], float)
        self.s = s
        # standard ids the rig answers through bindings count as parameters (param_id finds them)
        self.param_index = {k: i for i, k in enumerate(self.param_ids)}
        for k in b.get('stdAliases', {}):
            self.param_index.setdefault(k, -1)


class Pose:
    def __init__(self, positions, opacity, enabled, order, params):
        self.positions, self.opacity, self.enabled, self.order, self.params = positions, opacity, enabled, order, params
        self.draw_order = None


class Vtp2Model:
    def __init__(self, bundle_dir):
        self.dir = os.path.abspath(bundle_dir)
        with open(os.path.join(self.dir, 'bundle.json'), encoding='utf-8') as f:
            b = json.load(f)
        if b.get('format') != 'vtp.pro2d-bundle':
            raise ValueError('not a Pro2D bundle: ' + bundle_dir)
        self.bundle = b
        self.json = {}
        self.name = b.get('name') or 'pro2d_avatar'
        with open(os.path.join(self.dir, 'geom.bin'), 'rb') as f:
            geom = f.read()
        self.moc = _Moc(b, geom)
        self.texture_files = [os.path.join(self.dir, t['file']) for t in b['textures']]
        self.textures = [np.asarray(Image.open(t).convert('RGBA'), np.float32) / 255 for t in self.texture_files]
        self.textures_premul = [premul(t) for t in self.textures]
        self.physics = None
        self.pose3 = None
        self.cdi = None
        self.expressions = {e['name'] or e['id']: e for e in b.get('expressions', [])}
        self.groups = {}
        self.param_names = {p['id']: p.get('name', '') for p in b['params']}
        self.part_names = {p['id']: p.get('name', '') for p in b['parts']}
        # mesh names are the meaningful ones in a Pro2D rig (Live2D's ids are ArtMeshNN): give analyze both
        self.art_names = [m.get('name', '') for m in b['meshes']]
        self.aliases = b.get('stdAliases', {})
        self.default_part_opacity = {}
        self._poses = {}
        self._index = {}
        for e in b.get('poses', []):
            self._index[self._req_key(e['req'])] = e
        self._cache = os.path.join(self.dir, 'poses')

    @classmethod
    def load(cls, path):
        return cls(path)

    # ---------------------------------------------------------------- poses
    def _split(self, params):
        """pipeline params -> (rig params, standard sources)"""
        raw, std = {}, {}
        for k, v in (params or {}).items():
            if k in self.moc.param_ids:
                raw[k] = float(v)
            elif k in self.aliases:
                std[self.aliases[k]['source']] = float(v)
        return raw, std

    @staticmethod
    def _req_key(req):
        p = sorted((k, round(float(v), 4)) for k, v in (req.get('params') or {}).items())
        s = sorted((k, round(float(v), 4)) for k, v in (req.get('std') or {}).items())
        return json.dumps({'p': p, 's': s, 'e': req.get('expression'), 'l': req.get('layers')})

    def _load(self, e):
        flat = np.fromfile(os.path.join(self.dir, e['file']), np.float32)
        pos, o = [], 0
        for v in self.moc.s.arts.vertexCounts:
            n = int(v) * 2
            pos.append(flat[o:o + n].reshape(-1, 2).astype(np.float32)); o += n
        return Pose(pos, np.array(e['opacity'], np.float32), np.array(e['enabled'], bool), [int(a) for a in e['order']], e.get('values', {}))

    def _eval(self, reqs):
        cmd = os.environ.get('VTP_PRO2D_EVAL')
        if not cmd:
            raise RuntimeError('this pose was not precomputed and VTP_PRO2D_EVAL is not set')
        r = subprocess.run(json.loads(cmd) + ['eval', self.dir], input=json.dumps(reqs), capture_output=True, text=True,
                           encoding='utf-8', timeout=300)
        if r.returncode != 0:
            raise RuntimeError('pro2d pose evaluation failed: ' + (r.stderr or '')[-800:])
        for e in json.loads(r.stdout.strip().splitlines()[-1]):
            self._index[self._req_key(e['req'])] = e

    def pose(self, params=None, part_opacity=None, expression=None, layers=None):
        raw, std = self._split(params)
        req = {'params': raw, 'std': std, 'expression': expression, 'layers': layers}
        k = self._req_key(req)
        if k not in self._poses:
            if k not in self._index:
                self._eval([req])
            self._poses[k] = self._load(self._index[k])
        return self._poses[k]

    def named_pose(self, key):
        for e in self.bundle.get('poses', []):
            if e['key'] == key:
                return self._load(e)
        return None

    # ---------------------------------------------------------------- helpers (as L2DModel)
    def param_id(self, *cands):
        for c in cands:
            if c in self.moc.param_index:
                return c
        low = {k.lower(): k for k in self.moc.param_index}
        for c in cands:
            if c.lower() in low:
                return low[c.lower()]
        return None

    def art_part(self, a):
        return int(self.moc.s.arts.parentPart[a])

    def part_path(self, p):
        s, out = self.moc.s, []
        while 0 <= p < len(self.moc.part_ids) and len(out) < 64:
            out.append(self.moc.part_ids[p])
            p = int(s.parts.parentPart[p])
        return out[::-1]

    def part_label(self, pid):
        return self.part_names.get(pid, '')

    def art_params(self, a):
        return set(self.bundle['meshes'][a]['allParams'])

    def art_own_params(self, a):
        return set(self.bundle['meshes'][a]['ownParams'])

    def deformer_chain(self, a):
        return list(self.bundle['meshes'][a]['deformerChain'])

    def physics_groups(self):
        return [dict(id=p['id'], name=p['id'], inputs=[i for i in p['inputs'] if i], outputs=[o for o in p['outputs'] if o],
                     vertices=[], norm={}) for p in self.bundle.get('physics', [])]
