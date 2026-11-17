"""
VTube Pro realistic / semi-realistic HUMAN creator - headless Blender entry point (MakeHuman via MPFB).

    blender -b --factory-startup --python blender/human_creator/build.py -- <params.json | preset-name | json>
            [--out DIR] [--id ID] [--name NAME] [--scratch DIR] [--no-previews] [--checks]

One parameter document -> finished avatar folder: <out>/<id>.glb (body + eyes + brows + lashes + teeth + tongue +
hair + default outfit, VRM humanoid bone names, leftEye/rightEye gaze bones, ARKit-52 face shape keys),
costumes/<costume>.glb (extra outfits on the same armature), profile.json, params.json, previews + thumb.
MPFB runs inside private Blender user dirs (see mpfb_env.py); the script re-launches itself into them if needed.
Prints `VTP_OK {json}` on success, `VTP_FAIL ...` on error (server/blender.ts contract).
"""
import json
import os
import subprocess
import sys
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import bpy  # noqa: E402

from human_creator import mpfb_env as ME  # noqa: E402

ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
T0 = time.time()


def log(*a):
    print('[human %6.1fs]' % (time.time() - T0), *a, flush=True)


def parse():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    opts = {'params': None, 'out': None, 'id': None, 'name': None, 'scratch': None, 'previews': True, 'checks': False}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ('--out', '--id', '--name', '--scratch'):
            opts[a[2:]] = argv[i + 1]
            i += 2
            continue
        if a == '--no-previews':
            opts['previews'] = False
        elif a == '--checks':
            opts['checks'] = True
        elif a == '--quick':
            opts['checks'] = True
            opts['previews'] = False
        else:
            opts['params'] = a
        i += 1
    return opts


def resolve_params(spec):
    if spec is None:
        return {}
    if spec.lower().endswith('.json') and os.path.isfile(spec):
        return spec
    pre = os.path.join(HERE, 'presets', spec + '.json')
    if os.path.isfile(pre):
        return pre
    return json.loads(spec)


CHECKS = [
    ('neutral', {}), ('blink', {'eyeBlinkLeft': 1, 'eyeBlinkRight': 1}), ('winkL', {'eyeBlinkLeft': 1}),
    ('wide', {'eyeWideLeft': 1, 'eyeWideRight': 1}), ('squint', {'eyeSquintLeft': 1, 'eyeSquintRight': 1}),
    ('browDown', {'browDownLeft': 1, 'browDownRight': 1}), ('browInnerUp', {'browInnerUp': 1}),
    ('browOuterUp', {'browOuterUpLeft': 1, 'browOuterUpRight': 1}), ('jawOpen', {'jawOpen': 1}),
    ('jawOpen+close', {'jawOpen': 0.6, 'mouthClose': 0.6}), ('smile', {'mouthSmileLeft': 1, 'mouthSmileRight': 1}),
    ('frown', {'mouthFrownLeft': 1, 'mouthFrownRight': 1}), ('stretch', {'mouthStretchLeft': 1, 'mouthStretchRight': 1}),
    ('press', {'mouthPressLeft': 1, 'mouthPressRight': 1}), ('pucker', {'mouthPucker': 1}), ('funnel', {'mouthFunnel': 1}),
    ('upperUp', {'mouthUpperUpLeft': 1, 'mouthUpperUpRight': 1}), ('lowerDown', {'mouthLowerDownLeft': 1, 'mouthLowerDownRight': 1}),
    ('sneer', {'noseSneerLeft': 1, 'noseSneerRight': 1}), ('cheekPuff', {'cheekPuff': 1}),
    ('cheekSquint', {'cheekSquintLeft': 1, 'cheekSquintRight': 1}), ('mouthLeft', {'mouthLeft': 1}), ('jawLeft', {'jawLeft': 1}),
    ('rollLower', {'mouthRollLower': 1, 'mouthRollUpper': 1}), ('shrug', {'mouthShrugLower': 1, 'mouthShrugUpper': 1}),
    ('dimple', {'mouthDimpleLeft': 1, 'mouthDimpleRight': 1}), ('tongueOut', {'jawOpen': 0.55, 'tongueOut': 1}),
    ('bigGrin', {'mouthSmileLeft': 1, 'mouthSmileRight': 1, 'jawOpen': 0.35, 'cheekSquintLeft': 0.6, 'cheekSquintRight': 0.6,
                 'mouthUpperUpLeft': 0.3, 'mouthUpperUpRight': 0.3, 'eyeSquintLeft': 0.3, 'eyeSquintRight': 0.3}),
    ('surprised', {'jawOpen': 0.55, 'eyeWideLeft': 1, 'eyeWideRight': 1, 'browInnerUp': 0.8, 'browOuterUpLeft': 0.9, 'browOuterUpRight': 0.9, 'mouthFunnel': 0.3}),
    ('angry', {'browDownLeft': 1, 'browDownRight': 1, 'noseSneerLeft': 0.5, 'noseSneerRight': 0.5, 'mouthFrownLeft': 0.5, 'mouthFrownRight': 0.5, 'eyeSquintLeft': 0.4, 'eyeSquintRight': 0.4, 'mouthPressLeft': 0.4, 'mouthPressRight': 0.4}),
    ('sad', {'browInnerUp': 1, 'mouthFrownLeft': 0.8, 'mouthFrownRight': 0.8, 'mouthShrugLower': 0.4, 'eyeSquintLeft': 0.2, 'eyeSquintRight': 0.2}),
    ('oh', {'jawOpen': 0.45, 'mouthFunnel': 0.8, 'mouthPucker': 0.3}),
]


def main():
    opts = parse()
    ME.ensure_private_env()
    from human_creator import params as PR
    from human_creator import human as HU
    from human_creator import face as FA
    from human_creator import convert as CV
    from human_creator import materials as MT
    from human_creator import hair as HR
    from human_creator import export as EX
    p = PR.load_params(resolve_params(opts['params']))
    if opts['id']:
        p['id'] = opts['id']
    if opts['name']:
        p['name'] = opts['name']
    # (a source checkout writes the shipped avatar into assets/builtin/<id>; in a release that folder is the program folder,
    # which an update replaces and where an avatar would count as a shipped one: build in the temp folder and import it)
    release = os.path.isfile(os.path.join(ROOT, 'release_manifest.json'))
    default_out = os.path.join(__import__('tempfile').gettempdir(), 'vtp_human', p['id'], 'out') if release else os.path.join(ROOT, 'assets', 'builtin', p['id'])
    out = os.path.abspath(opts['out'] or default_out)
    os.makedirs(out, exist_ok=True)
    scratch = os.path.abspath(opts['scratch']) if opts['scratch'] else os.path.join(__import__('tempfile').gettempdir(), 'vtp_human', p['id'])
    os.makedirs(scratch, exist_ok=True)
    log('params', p['id'], '->', out)
    # ---------------- MakeHuman character (MPFB)
    H = HU.create(p, log)
    CV.strip_modifiers(H)
    # ---------------- ARKit face keys on the basemesh, carried onto every proxy
    F = FA.FaceRig(H, p, log)
    F.build()
    riders = list(H.parts.values()) + H.clothes + [o for objs in H.costumes.values() for o in objs]
    F.transfer([o for o in riders if o is not H.parts.get('eyes')])
    F.tongue_out(H.parts.get('tongue'))
    finfo = F.markers()
    # ---------------- materials (needs the helper-free UVs? no: UVs are per-face, helpers are separate islands)
    H.face = F
    MT.build(H, p, os.path.join(scratch, 'tex'), log)
    # ---------------- VTube Pro conventions
    CV.remove_helpers(H)
    log('body verts deleted under every outfit:', H.deleted_under_clothes)
    CV.push_out(H, 0.004, log)
    for objs in list(H.costumes.values()) + [H.clothes]:
        for o in objs:
            o.hide_render = True          # outfits are not worn by default: they must not shadow the skin AO
    MT.bake_ao(H, os.path.join(scratch, 'tex'), log=log)
    for objs in list(H.costumes.values()) + [H.clothes]:
        for o in objs:
            o.hide_render = False
    CV.rename_bones(H)
    CV.add_eye_bones(H)
    CV.name_objects(H)
    chains = HR.add_chains(H, p, log)
    HR.densify(H, p, log)
    CV.clean_vertex_groups(CV.all_objects(H), H.rig)
    finfo.update(F.eye_markers(H))
    # ---------------- QA
    if opts['checks']:
        from human_creator import render as RD
        meshes = [o for o in CV.base_objects(H) if o.type == 'MESH']
        fc = F.face_center()
        for o in H.costumes.get(next(iter(H.costumes), ''), []):
            o.hide_render = True
        for objs in H.costumes.values():
            for o in objs:
                o.hide_render = True
        RD.expression_sheet(meshes, fc, scratch, p['id'] + '_expr.png', CHECKS)
        RD.expression_sheet(meshes, fc, scratch, p['id'] + '_expr34.png', CHECKS[:12], yaw=35)
        mc = tuple(F.mouth_front.tolist())
        mouthy = [c for c in CHECKS if c[0] in ('neutral', 'jawOpen', 'smile', 'bigGrin', 'tongueOut', 'oh', 'funnel',
                                                  'upperUp', 'lowerDown', 'surprised', 'angry', 'pucker')]
        RD.expression_sheet(meshes, mc, scratch, p['id'] + '_mouth.png', mouthy, dist=0.22, cols=4)
        ec = tuple(float(v) for v in H.eye_centers['left'][0])
        eyey = [c for c in CHECKS if c[0] in ('neutral', 'blink', 'wide', 'squint', 'browDown', 'cheekSquint')]
        RD.expression_sheet(meshes, ec, scratch, p['id'] + '_eye.png', eyey, dist=0.16, cols=3)
        log('checks ->', scratch)
    # ---------------- export
    base = [o for o in CV.base_objects(H) if o.type == 'MESH']
    glb = os.path.join(out, p['id'] + '.glb')
    EX.export_glb(glb, H.rig, base)
    log('wrote', glb, os.path.getsize(glb) // 1024, 'KB')
    costumes = []
    for cos in p['outfit']['costumes']:
        objs = H.costumes.get(cos['id']) or []
        if not objs:
            continue
        f = os.path.join(out, 'costumes', cos['id'] + '.glb')
        EX.export_glb(f, H.rig, objs)
        costumes.append({'id': cos['id'], 'name': cos['name'], 'file': 'costumes/%s.glb' % cos['id'],
                         'hides': [o.name for o in H.clothes], 'source': EX.source_for(out),
                         'fit': {'margin': 0.004, 'hideBody': True}})
        log('costume', cos['id'], os.path.getsize(f) // 1024, 'KB')
    EX.write_profile(out, p, H, finfo, chains, costumes)
    with open(os.path.join(out, 'params.json'), 'w', encoding='utf-8') as fh:
        json.dump(p, fh, indent=1)
    if release:
        # (the helper's import_model tool takes the profile + outfits next to the model along: server/avatarFolder.ts)
        log('to add it to VTube Pro: import_model with path', glb, '(its profile.json and costumes/ come along)')
    if opts['checks']:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(scratch, p['id'] + '.blend'))
    # ---------------- previews (separate clean Blender run on the exported GLB)
    if opts['previews']:
        pv = os.path.join(ROOT, 'blender', 'previews.py')
        subprocess.run([bpy.app.binary_path, '-b', '--factory-startup', '--python', pv, '--', glb, out],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        log('previews ->', out)
    return {'id': p['id'], 'glb': glb, 'keys': len(F.keys), 'costumes': [c['id'] for c in costumes],
            'seconds': round(time.time() - T0, 1)}


if __name__ == '__main__':
    try:
        res = main()
        print('VTP_OK ' + json.dumps(res), flush=True)
    except BaseException as e:  # noqa: BLE001
        traceback.print_exc()
        print('VTP_FAIL %s: %s' % (type(e).__name__, str(e).replace('\n', ' | ')), flush=True)
