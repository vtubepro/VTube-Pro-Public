"""
VTube Pro anime character creator — builds a finished VRM avatar from pixiv's CC0 VRoid sample
models + a parameter JSON (see params.py for the schema and presets/ for examples).

    <python with numpy> blender/anime_creator/build.py <params.json> <out_dir> [--id ID]
    (Blender's bundled interpreter works: "<Blender>/5.1/python/bin/python.exe")

Writes <out_dir>/<id>.vrm + profile.json (+ costumes/*.glb when the params define costumes).
Previews / thumbnail: blender/anime_creator/render.py (Blender) renders from the finished VRM.
"""
from __future__ import annotations

import datetime
import json
import os
import sys

if __package__ in (None, ''):
    sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))   # append: blender/inspect.py shadows stdlib
    __package__ = 'anime_creator'

import numpy as np  # noqa: E402

from anime_creator import arkit, structure, params as P  # noqa: E402
from anime_creator.vroid import Model  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
# the CC0 VRoid bases: the source checkout's tools/vendor/vroid, or where the helper's 3D toolkit downloaded them
VENDOR = os.environ.get('VTP_VROID_DIR') or os.path.join(ROOT, 'tools', 'vendor', 'vroid')


def base_path(name: str) -> str:
    # a 'file' may be absolute: the performer's own base (Pro2D -> 3D "Use my own base", blender/to3d/user_base.py)
    return os.path.join(VENDOR, P.BASES[name]['file'])


def build(prm: dict, out_dir: str, log=print) -> dict:
    from anime_creator import hair, colors, body, face, outfit, props, costumes  # noqa: F401
    prm = P.normalize(prm)
    os.makedirs(out_dir, exist_ok=True)
    m = Model(base_path(prm['base']))
    ctx = {'log': log, 'out_dir': out_dir, 'params': prm, 'donors': {}}

    def donor(name):
        if name not in ctx['donors']:
            dm = Model(base_path(name))
            structure.split_body(dm)
            ctx['donors'][name] = dm
        return ctx['donors'][name]
    ctx['donor'] = donor

    structure.split_body(m)
    # 1) outfit selection (garments from the base or donors), before hair so hair sits on top
    outfit.apply(m, prm['outfit'], ctx)
    # 2) hairstyle transplant
    hair.apply(m, prm['hair'], ctx)
    # 3) body proportions (rest-pose re-shape, affects everything skinned) + face shape
    body.apply(m, prm['body'], ctx)
    face.apply(m, prm['face'], ctx)
    # 4) colours / textures
    colors.apply(m, prm, ctx)
    if 'tex' in ctx:
        ctx['tex'].flush()
    # 5) accessories baked into the model (rigid props on bones)
    props.apply(m, prm.get('props', []), ctx)
    # 6) ARKit perfect-sync shapes + expression setup
    fi = m.mesh_index('Face')
    d = m.read_mesh(fi)
    mouth_prim = next(i for i, p in enumerate(d.prims) if 'FaceMouth' in m.mat_name(p['material']))
    tongue = face.tongue_verts(m, d, mouth_prim)
    added = arkit.add_arkit(d, mouth_prim, tongue, prm['face'].get('mouth', {}))
    m.write_mesh(fi, d)
    log(f'arkit: +{len(added)} shapes')
    structure.drop_empty_meshes(m)
    m.rebuild_ibms()
    _meta(m, prm)
    vid = prm['id']
    vrm_path = os.path.join(out_dir, f'{vid}.vrm')
    # 7) costumes (separate GLBs bound onto this skeleton at runtime)
    cdefs = costumes.build_all(m, prm.get('costumes', []), ctx)
    m.save(vrm_path)
    prof = profile(prm, cdefs)
    with open(os.path.join(out_dir, 'profile.json'), 'w', encoding='utf-8') as f:
        json.dump(prof, f, indent=1)
    with open(os.path.join(out_dir, 'params.json'), 'w', encoding='utf-8') as f:
        json.dump(prm, f, indent=1)
    log(f'wrote {vrm_path} ({os.path.getsize(vrm_path) / 1e6:.1f} MB)')
    return prof


def _meta(m: Model, prm: dict):
    meta = m.vrm['meta']
    meta['title'] = prm['name']
    meta['author'] = 'VTube Pro anime creator (base: pixiv VRoid sample models, CC0)'
    meta['version'] = '1.0'
    meta['contactInformation'] = ''
    meta['reference'] = 'VRoid sample models by pixiv Inc. (CC0)'


def profile(prm: dict, cdefs: list) -> dict:
    vid = prm['id']
    return {
        'version': 1, 'id': vid, 'name': prm['name'], 'modelFile': f'{vid}.vrm', 'thumbnail': 'thumb.png',
        'source': prm.get('source', 'import'),
        'createdAt': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z'),
        'prompt': prm.get('prompt', ''),
        'transform': {'scale': 1, 'offset': [0, 0, 0], 'yaw': 0},
        'eyes': {'mode': 'model', 'style': 'anime', 'left': None, 'right': None, 'size': 0.02, 'protrusion': 0,
                 'scleraColor': '#ffffff', 'irisColor': prm['colors']['eyes'], 'irisSize': 0.5, 'pupilSize': 0.4,
                 'lidColor': None, 'outline': False, 'gazeRange': 20, 'restOpen': 1, 'highlight': True},
        'mouth': {'mode': 'model', 'style': 'toon', 'center': None, 'width': 0.02, 'openHeight': 0.015,
                  'influence': 0.04, 'lipColor': '#c46a6e', 'interiorColor': '#4a1c22', 'tongueColor': '#d77a7e',
                  'teethColor': '#ffffff', 'showTeeth': True, 'showTongue': True, 'lineWidth': 0.0015, 'restCurve': 0},
        'brows': {'enabled': False, 'color': '#333333', 'thickness': 0.006},
        'look': {'shading': 'anime', 'rim': 0.2, 'shadowTint': '#c98f86', 'softness': 0.5, 'hairShine': 0,
                 'vrmExposure': prm.get('look', {}).get('exposure', 0.62)},
        'blush': {'enabled': False, 'color': '#e88a8a', 'rest': 0, 'hatch': False},
        'rig': {'kind': 'vrm'},
        'physics': {'enabled': True, 'jiggle': [], 'chains': [], 'autoChains': False, 'wind': 0},
        'tracking': {'expressiveness': 1.0, 'gains': {}, 'smoothing': 0.4, 'headRotationScale': 1, 'bodyFollow': 0.6,
                     'mirror': True, 'trackHands': True, 'trackBody': True, 'audioLipSync': False, 'facialHair': 0,
                     'translate': [1, 0.7, 1.2], 'armExaggeration': 1.0, 'armBounce': 0.25, 'gestureFx': True,
                     'gestureReactions': True, 'expressionBoost': 1, 'cartoon': 0.0, 'enunciation': 1.1},
        'costumes': cdefs,
        'costume': None,
        'creator': {'params': 'params.json', 'kind': 'anime', 'version': 2},
    }


if __name__ == '__main__':
    a = sys.argv[1:]
    with open(a[0], encoding='utf-8') as f:
        prm = json.load(f)
    if '--id' in a:
        prm['id'] = a[a.index('--id') + 1]
    build(prm, os.path.abspath(a[1]))
