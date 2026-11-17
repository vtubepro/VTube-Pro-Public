"""Load a Live2D Cubism model folder: model3.json (+ moc3, textures, physics3, pose3, cdi3, exp3, motion3).

Only open JSON/PNG files and the clean-room moc3 reader (moc3.py) are used. No Cubism Core.

    m = L2DModel.load('path/to/Model.model3.json')   # or the folder
    pose = m.pose({'ParamAngleX': 30})
"""
import glob
import json
import os

import numpy as np
from PIL import Image

from . import moc3 as _moc3


def _json(path):
    with open(path, 'rb') as fh:
        raw = fh.read()
    return json.loads(raw.decode('utf-8-sig', 'replace'))


def find_model3(path):
    if os.path.isfile(path):
        return path
    c = sorted(glob.glob(os.path.join(path, '*.model3.json'))) or sorted(glob.glob(os.path.join(path, '**', '*.model3.json'), recursive=True))
    if not c:
        raise FileNotFoundError('no *.model3.json in ' + path)
    return c[0]


class L2DModel:
    def __init__(self, model3_path):
        self.path = model3_path
        self.dir = os.path.dirname(os.path.abspath(model3_path))
        self.name = os.path.basename(model3_path).split('.model3.json')[0]
        j = _json(model3_path)
        self.json = j
        fr = j.get('FileReferences', {})
        self.moc = _moc3.load(os.path.join(self.dir, fr['Moc']))
        self.texture_files = [os.path.join(self.dir, t) for t in fr.get('Textures', [])]
        self.textures = [np.asarray(Image.open(t).convert('RGBA'), np.float32) / 255 for t in self.texture_files]
        from .render import premul
        self.textures_premul = [premul(t) for t in self.textures]
        self.physics = _json(os.path.join(self.dir, fr['Physics'])) if fr.get('Physics') else None
        self.pose3 = _json(os.path.join(self.dir, fr['Pose'])) if fr.get('Pose') else None
        self.cdi = _json(os.path.join(self.dir, fr['DisplayInfo'])) if fr.get('DisplayInfo') else None
        self.expressions = {}
        for e in fr.get('Expressions', []) or []:
            try:
                self.expressions[e.get('Name', e['File'])] = _json(os.path.join(self.dir, e['File']))
            except OSError:
                pass
        self.groups = {g.get('Name'): g.get('Ids', []) for g in j.get('Groups', [])}
        # human-readable names (cdi3)
        self.param_names, self.part_names = {}, {}
        if self.cdi:
            for p in self.cdi.get('Parameters', []):
                self.param_names[p['Id']] = p.get('Name', '')
            for p in self.cdi.get('Parts', []):
                self.part_names[p['Id']] = p.get('Name', '')
        self.default_part_opacity = self._pose_defaults()

    @classmethod
    def load(cls, path):
        return cls(find_model3(path))

    def _pose_defaults(self):
        op = {}
        if not self.pose3:
            return op
        for grp in self.pose3.get('Groups', []):
            for k, item in enumerate(grp):
                v = 1.0 if k == 0 else 0.0
                op[item['Id']] = v
                for l in item.get('Link', []) or []:
                    op[l] = v
        return op

    def pose(self, params=None, part_opacity=None):
        po = dict(self.default_part_opacity)
        po.update(part_opacity or {})
        return self.moc.evaluate(params or {}, po)

    # ---------------------------------------------------------------- helpers
    def param_id(self, *cands):
        """first parameter id present among candidates (standard Cubism ids first)"""
        for c in cands:
            if c in self.moc.param_index:
                return c
        low = {k.lower(): k for k in self.moc.param_ids}
        for c in cands:
            if c.lower() in low:
                return low[c.lower()]
        return None

    def art_part(self, a):
        p = int(self.moc.s.arts.parentPart[a])
        return p

    def part_path(self, p):
        """list of part ids from the root down to part p"""
        s = self.moc.s
        out = []
        while p >= 0:
            out.append(self.moc.part_ids[p])
            p = int(s.parts.parentPart[p])
        return out[::-1]

    def part_label(self, pid):
        return self.part_names.get(pid, '')

    def art_params(self, a):
        """set of parameter ids that move art mesh a (its own keyforms + every deformer above it)"""
        m, s = self.moc, self.moc.s
        ps = {m.param_ids[p] for _, p in m.art_kf[a]['tab']}
        d = int(s.arts.parentDeformer[a])
        while d >= 0:
            spec = int(s.deformers.specific[d])
            tab = m.warp_kf[spec]['tab'] if s.deformers.types[d] == 0 else m.rot_kf[spec]['tab']
            ps |= {m.param_ids[p] for _, p in tab}
            d = int(s.deformers.parentDeformer[d])
        return ps

    def art_own_params(self, a):
        m, s = self.moc, self.moc.s
        ps = {m.param_ids[p] for _, p in m.art_kf[a]['tab']}
        d = int(s.arts.parentDeformer[a])
        # include only the nearest deformers until the first head/body-level one (they carry the "what am I" signal)
        depth = 0
        while d >= 0 and depth < 2:
            spec = int(s.deformers.specific[d])
            tab = m.warp_kf[spec]['tab'] if s.deformers.types[d] == 0 else m.rot_kf[spec]['tab']
            ps |= {m.param_ids[p] for _, p in tab}
            d = int(s.deformers.parentDeformer[d]); depth += 1
        return ps

    def deformer_chain(self, a):
        s = self.moc.s
        out = []
        d = int(s.arts.parentDeformer[a])
        while d >= 0:
            out.append(self.moc.deformer_ids[d])
            d = int(s.deformers.parentDeformer[d])
        return out

    def physics_groups(self):
        """[{name, inputs:[param ids], outputs:[param ids], vertices, normalization}] from physics3.json"""
        if not self.physics:
            return []
        names = {d['Id']: d.get('Name', '') for d in self.physics.get('Meta', {}).get('PhysicsDictionary', [])}
        out = []
        for s in self.physics.get('PhysicsSettings', []):
            out.append(dict(id=s.get('Id'), name=names.get(s.get('Id'), ''),
                            inputs=[i['Source']['Id'] for i in s.get('Input', [])],
                            outputs=[o['Destination']['Id'] for o in s.get('Output', [])],
                            vertices=s.get('Vertices', []), norm=s.get('Normalization', {})))
        return out
