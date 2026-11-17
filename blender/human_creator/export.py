"""GLB export (base avatar + one GLB per costume, same armature) and the AvatarProfile writer."""
import json
import os
import time

import bpy

from .convert import select_only


def gl(v):
    """Blender (x, y, z) Z-up/-Y front -> glTF (x, z, -y) Y-up/+Z front."""
    return [round(float(v[0]), 5), round(float(v[2]), 5), round(float(-v[1]), 5)]


def _rest(arm, meshes):
    for pb in arm.pose.bones:
        pb.matrix_basis.identity()
    for ob in meshes:
        if ob.data.shape_keys:
            for kb in ob.data.shape_keys.key_blocks:
                kb.value = 0.0


def export_glb(path, arm, meshes, morph_normals=True):
    _rest(arm, meshes)
    select_only(meshes + [arm], arm)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
              export_skins=True, export_animations=False, export_morph=True, export_materials='EXPORT',
              export_cameras=False, export_lights=False, export_def_bones=False)
    try:
        bpy.ops.export_scene.gltf(export_image_format='AUTO', export_morph_normal=morph_normals, **kw)
    except TypeError:
        bpy.ops.export_scene.gltf(**kw)
    if not os.path.isfile(path):
        raise RuntimeError('glTF exporter wrote nothing at ' + path)
    return path


ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))


def source_for(out):
    """'builtin' (comes with VTube Pro, cannot be deleted) only for a source checkout's own assets/builtin folder; every other
    avatar is the user's own ('import'), whatever folder it is built in."""
    inside = '/assets/builtin/' in os.path.abspath(out).replace('\\', '/').lower() + '/'
    return 'builtin' if inside and not os.path.isfile(os.path.join(ROOT, 'release_manifest.json')) else 'import'


def describe(p):
    b = p['body']
    race = max(b['race'], key=b['race'].get)
    hair = p['hair']['style'].rstrip('0123456789')
    return ('realistic human (VTube Pro human creator / MakeHuman): %d-year-old %s %s, %s hair, %s eyes, stylisation %.2f'
            % (round(b['age']), {'african': 'African', 'asian': 'Asian', 'caucasian': 'Caucasian'}[race], p['sex'],
               hair, p['eyes']['color'], p['stylization']))


def write_profile(out, p, H, face_info, chains, costumes):
    path = os.path.join(out, 'profile.json')
    created = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
    if os.path.isfile(path):
        try:
            with open(path, encoding='utf-8') as f:
                created = json.load(f).get('createdAt', created)
        except Exception:
            pass
    s = p['stylization']
    eyes = {
        'mode': 'model', 'style': 'inset',
        'left': face_info.get('eyeL'), 'right': face_info.get('eyeR'),
        'size': round(face_info.get('eyeRadius', 0.012), 4), 'protrusion': 0,
        'scleraColor': '#f4f1ec', 'irisColor': '#5a3b24', 'irisSize': 0.45, 'pupilSize': 0.4, 'lidColor': None,
        'outline': False, 'gazeRange': 22, 'restOpen': 1.0, 'highlight': False,
    }
    mouth = {
        'mode': 'model', 'style': 'toon', 'center': face_info.get('mouth'),
        'width': round(face_info.get('mouthWidth', 0.025), 4), 'openHeight': 0.02, 'influence': 0.04,
        'lipColor': '#b8656a', 'interiorColor': '#4a1c22', 'tongueColor': '#c46a6e', 'teethColor': '#f2eee6',
        'showTeeth': True, 'showTongue': True, 'lineWidth': 0.0015, 'restCurve': 0,
    }
    prof = {
        'version': 1,
        'id': p['id'],
        'name': p['name'],
        'modelFile': p['id'] + '.glb',
        'thumbnail': 'thumb.png',
        'source': source_for(out),
        'createdAt': created,
        'prompt': describe(p),
        'transform': {'scale': 1, 'offset': [0, 0, 0], 'yaw': 0},
        'eyes': eyes,
        'mouth': mouth,
        'brows': {'enabled': False, 'color': p['hair'].get('color') or '#3a2a20', 'thickness': 0.006},
        'look': {
            'shading': 'realistic', 'rim': round(0.18 + 0.2 * s, 3), 'shadowTint': '#c98f86', 'softness': round(0.5 + 0.3 * s, 3),
            'hairShine': 0.8, 'hairMeshes': ['Hair'], 'noseHighlight': False, 'stylize': round(s, 3),
        },
        'blush': {'enabled': False, 'color': '#e88a8a', 'rest': 0, 'hatch': False},
        'rig': {'kind': 'humanoid'},
        'physics': {'enabled': True, 'jiggle': [], 'chains': chains, 'autoChains': True, 'wind': 0},
        'tracking': {
            'expressiveness': 1.0, 'gains': {}, 'smoothing': 0.45, 'headRotationScale': 1, 'bodyFollow': 0.6,
            'mirror': True, 'trackHands': True, 'trackBody': True, 'audioLipSync': False, 'facialHair': 0,
            'translate': [1, 0.7, 1.2], 'armExaggeration': 1.0, 'armBounce': 0.25, 'gestureFx': True,
            'gestureReactions': True, 'expressionBoost': 1, 'cartoon': round(0.25 * s, 3), 'enunciation': 1.1,
        },
        'costumes': costumes,
        'costume': None,
        'creator': {'params': 'params.json', 'kind': 'human', 'version': 1},
    }
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(prof, f, indent=1)
    return prof
