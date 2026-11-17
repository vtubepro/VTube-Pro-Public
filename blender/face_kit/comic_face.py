"""
face_kit comic / semi-real face builder: human_creator (MakeHuman via MPFB, headless Blender at low priority)
-> face_kit comic finishing (own 2K face texture, painted comic features, smoothed shading normals, beard / eyepatch
shells, comic eyes, toon hair) -> GLB + profile for the app's anime toon shader.

    python blender/face_kit/comic_face.py <preset.json | preset-name> <out_dir> [--raw <existing human_creator dir>]

Preset: {"id", "name", "human": {<human_creator params>}, "face": {<HFace.DEFAULTS overrides>},
         "hair": {"color": "#..."} , "normals": {"iters": 40}, "profile": {<profile overrides>}}
Without --raw the MakeHuman base is built first (tools/blender_low.cmd + blender/human_creator/build.py).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.append(os.path.dirname(HERE))

from anime_creator.vroid import Model  # noqa: E402
from face_kit.human_face import HFace, deep_merge  # noqa: E402
from face_kit.anime_face import low_priority, load_preset  # noqa: E402


def build_raw(pre: dict, raw_dir: str, log=print):
    hp = dict(pre['human']); hp['id'] = pre['id']; hp['name'] = pre.get('name', pre['id'])
    hp.setdefault('teeth', 'none')                      # house rule: never 3D teeth
    os.makedirs(raw_dir, exist_ok=True)
    pj = os.path.join(raw_dir, 'human_params.json')
    with open(pj, 'w', encoding='utf-8') as f:
        json.dump(hp, f, indent=1)
    cmd = [os.path.join(ROOT, 'tools', 'blender_low.cmd'), '-b', '--factory-startup', '--python',
           os.path.join(ROOT, 'blender', 'human_creator', 'build.py'), '--', pj, '--out', raw_dir,
           '--scratch', os.path.join(raw_dir, '_scratch'), '--no-previews']
    r = subprocess.run(cmd, capture_output=True, text=True, errors='replace')
    if 'VTP_OK' not in r.stdout:
        raise RuntimeError('human_creator failed:\n' + r.stdout[-3000:] + r.stderr[-2000:])
    log('face_kit: MakeHuman base built')


def finish(pre: dict, raw_dir: str, out_dir: str, log=print):
    os.makedirs(out_dir, exist_ok=True)
    glb = os.path.join(raw_dir, pre['id'] + '.glb')
    m = Model(glb)
    h = HFace(m, log=log)
    fp = pre.get('face', {})
    h.split_face(fp.get('size', 2048))
    h.paint(fp)
    p = h.p
    h.shading_normals(**pre.get('normals', {}))
    if p.get('beard'):
        h.beard_shell(p['beard'])
    if p.get('patch'):
        h.patch_cap(p['patch'])
        if p['patch'].get('strap'):
            h.strap_ribbon(p['patch'])
    h.paint_eyes(p['eyes'])
    h.drop_meshes(set(pre.get('drop', ['Eyebrows', 'Eyelashes'])))
    if pre.get('hair', {}).get('color') and not pre.get('hair', {}).get('style'):
        h.hair_toon(pre['hair']['color'], pre['hair'].get('shade', 0.55), pre['hair'].get('contrast', 1.0))
    for pfx, col in pre.get('tint', {}).items():
        h.tint_meshes(pfx, col)
    h.finish()
    m.save(os.path.join(out_dir, pre['id'] + '.glb'))
    with open(os.path.join(raw_dir, 'profile.json'), encoding='utf-8') as f:
        prof = json.load(f)
    prof['look'] = {'shading': 'anime', 'rim': 0.05, 'shadowTint': '#a0706a', 'softness': 0.12, 'hairShine': 0.15,
                    'hairMeshes': ['Hair'], 'noseHighlight': False}
    prof['name'] = pre.get('name', prof['name'])
    prof = deep_merge(prof, pre.get('profile', {}))
    with open(os.path.join(out_dir, 'profile.json'), 'w', encoding='utf-8') as f:
        json.dump(prof, f, indent=1)
    from anime_creator import imgio
    imgio.save(os.path.join(out_dir, 'face_texture.png'), h.face_tex)
    with open(os.path.join(out_dir, 'face_params.json'), 'w', encoding='utf-8') as f:
        json.dump(pre, f, indent=1)
    hs = pre.get('hair', {}).get('style')
    if hs:
        hdir = os.path.join(raw_dir, '_hair')
        cmd = [os.path.join(ROOT, 'tools', 'blender_low.cmd'), '-b', '--factory-startup', '--python',
               os.path.join(HERE, 'comic_hair.py'), '--', os.path.join(out_dir, pre['id'] + '.glb'), hs, hdir]
        if pre['hair'].get('base'):
            cmd.append('base=' + ','.join(str(x) for x in pre['hair']['base']))
        if pre['hair'].get('seed') is not None:
            cmd.append(f"seed={pre['hair']['seed']}")
        r = subprocess.run(cmd, capture_output=True, text=True, errors='replace')
        if 'FK_HAIR_OK' not in r.stdout:
            raise RuntimeError('comic_hair failed: ' + r.stdout[-3000:] + r.stderr[-2000:])
        from face_kit.human_face import merge_hair
        merge_hair(os.path.join(out_dir, pre['id'] + '.glb'), os.path.join(hdir, 'Hair.npz'), os.path.join(hdir, 'hair_tex.png'), log=log)
    log(f"face_kit: wrote {os.path.join(out_dir, pre['id'] + '.glb')}")


if __name__ == '__main__':
    low_priority()
    a = sys.argv[1:]
    pre = load_preset(a[0])
    out = os.path.abspath(a[1])
    raw = os.path.abspath(a[a.index('--raw') + 1]) if '--raw' in a else os.path.join(out, '_raw')
    if '--raw' not in a:
        build_raw(pre, raw)
    finish(pre, raw, out)
