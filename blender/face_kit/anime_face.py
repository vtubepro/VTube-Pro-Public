"""
face_kit anime face builder: anime_creator (CC0 VRoid bases) -> face_kit repaint + proxy normals + MToon -> VRM.

    python blender/face_kit/anime_face.py <preset.json | preset-name> <out_dir> [--id ID] [--textures]

Preset schema (blender/face_kit/presets/*.json):
  {"id": "...", "name": "...",
   "creator": {<anime_creator params: base, hair, colors, face shape, body, outfit ...>},
   "face":    {<vroid_face.DEFAULTS overrides: skin / eye / iris / hl / brow / mtoon>},
   "proxy": 1.0,                       # proxy-normal amount on the skin (0 = keep VRoid normals)
   "profile": {<profile.json overrides, e.g. look>}}
Writes <out_dir>/<id>.vrm, profile.json, design.png (flat frontal face design) [+ tex_*.png with --textures].
Any python with numpy + Pillow works (Blender's bundled interpreter too). Run it from any directory EXCEPT
blender/ (blender/inspect.py shadows the stdlib module).
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.append(os.path.dirname(HERE))
if __package__ in (None, ''):
    __package__ = 'face_kit'

import numpy as np  # noqa: E402


def low_priority():
    """Builds run beside a live studio: never compete with face tracking for the CPU."""
    try:
        if os.name == 'nt':
            import ctypes
            ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x00004000)  # BELOW_NORMAL
        else:
            os.nice(10)
    except Exception:
        pass

from anime_creator import build as AB, imgio  # noqa: E402
from anime_creator.vroid import Model  # noqa: E402
from face_kit.vroid_face import VFace, deep_merge  # noqa: E402
from face_kit import sdf as S  # noqa: E402

PRESETS = os.path.join(HERE, 'presets')


def load_preset(arg: str) -> dict:
    p = arg if os.path.exists(arg) else os.path.join(PRESETS, arg if arg.endswith('.json') else arg + '.json')
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def build(pre: dict, out_dir: str, textures: bool = False, log=print) -> dict:
    os.makedirs(out_dir, exist_ok=True)
    cp = dict(pre['creator'])
    cp['id'] = pre['id']; cp['name'] = pre.get('name', pre['id'])
    tmp = tempfile.mkdtemp(prefix='fk_')
    try:
        prof = AB.build(cp, tmp, log=log)
        vrm = os.path.join(tmp, prof['modelFile'])
        m = Model(vrm)
        vf = VFace(m, log=log)
        fp = pre.get('face', {})
        # brow colour defaults to the hair's shade, iris colour to the creator's eye colour
        cols = cp.get('colors', {})
        fp = deep_merge({'iris': {'color': cols.get('eyes') or '#4a7bd8'},
                         'brow': {'color': cols.get('brows') or cols.get('hair') or '#4a3040'}}, fp)
        p = vf.paint(fp)
        amt = float(pre.get('proxy', 1.0))
        if amt > 0:
            vf.proxy_normals(amt)
        shade = None
        if p['skin'].get('shadeMul'):
            shade = S.hexc(p['skin']['shadeMul'])
        vf.mtoon(p['mtoon'], shade)
        vf.flush()
        vf.design_view(os.path.join(out_dir, 'design.png'))
        if textures:
            for k in ('skin', 'iris', 'hl', 'white', 'line', 'lash', 'brow'):
                imgio.save(os.path.join(out_dir, f'tex_{k}.png'), vf.cache[vf._own(k)])
        m.save(os.path.join(out_dir, prof['modelFile']))
        prof = deep_merge(prof, pre.get('profile', {}))
        with open(os.path.join(out_dir, 'profile.json'), 'w', encoding='utf-8') as f:
            json.dump(prof, f, indent=1)
        with open(os.path.join(out_dir, 'face_params.json'), 'w', encoding='utf-8') as f:
            json.dump(pre, f, indent=1)
        log(f"face_kit: wrote {os.path.join(out_dir, prof['modelFile'])}")
        return prof
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    low_priority()
    a = sys.argv[1:]
    pre = load_preset(a[0])
    if '--id' in a:
        pre['id'] = a[a.index('--id') + 1]
    build(pre, os.path.abspath(a[1]), textures='--textures' in a)
