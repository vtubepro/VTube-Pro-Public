"""Live2D (Cubism) model -> 3D anime VTube Pro avatar (VRM + profile.json), one command.

    python tools/live2d_to_3d.py <model folder | *.model3.json | model.zip> <out_dir> [--sex auto|female|male]
                                 [--hair-mode auto|down|ponytail|twintails] [--name NAME] [--id ID] [--no-hair]
                                 [--stage-only analyze|design]
    python tools/live2d_to_3d.py <Pro2D bundle dir> <out_dir> --vtp2 [--overrides o.json] [--mode full|hair|springs|profile
                                 --prev <previous out_dir>] [--base <own VRoid base .vrm>] [--progress progress.json]
      (a Pro2D .vtp2 avatar: tools/pro2d_bundle.ts export makes the bundle; docs/PRO2D_TO_3D.md)

Stages (blender/live2d/, see docs/LIVE2D_TO_3D.md):
  1. read      model3.json + clean-room moc3 reader (no Cubism Core), evaluate the default pose + head turns
  2. analyze   classify every art mesh (hair front/side/back, eyes, brows, mouth, face, garments ...), landmarks,
               colours, outfit bands -> out_dir/l2d/analysis.json + reference pictures (front, turns, classes)
  3. design    measurements -> a face_kit anime preset on a CC0 VRoid base (sex, eye size, chin, colours ...)
  4. build     face_kit anime_face (VRoid base + drawn face repaint + proxy normals + MToon + ARKit) -> VRM, then
               the eye opening from the art (faceadj) and the drawn outfit projected onto the garment fronts (garment)
  5. hair      Live2D hair silhouettes -> anime_hair clump locks (Blender, low priority) -> replaces the VRoid hair
  6. profile   profile.json (model eyes / mouth, spring physics from the VRM, source 'import')

The user's own model stays theirs: nothing is uploaded, the output is a normal avatar folder.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time

import numpy as np  # noqa: F401  (import before blender/ joins sys.path: blender/inspect.py shadows the stdlib)
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(os.path.join(ROOT, 'blender'))

from live2d.model3 import L2DModel  # noqa: E402
from live2d.analyze import analyze  # noqa: E402
from live2d.design import design  # noqa: E402
from live2d.render import render_pose  # noqa: E402


def low_priority():
    try:
        if os.name == 'nt':
            import ctypes
            ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x00004000)
        else:
            os.nice(10)
    except Exception:
        pass


def slug(s):
    import re
    s = re.sub(r'[^a-z0-9._-]+', '_', s.lower()).strip('_')
    return s or 'live2d_avatar'


def save_rgba(img, path, bg=None):
    a = img.copy()
    if bg is not None:
        a[..., :3] = a[..., :3] * a[..., 3:] + np.array(bg) * (1 - a[..., 3:])
        a[..., 3] = 1
    Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8), 'RGBA').save(path)


def references(m, A, out, log=print):
    """front picture (full + head crop) and head turns (ParamAngleX -30 / +30, the model's own 2.5D) for review sheets"""
    os.makedirs(out, exist_ok=True)
    save_rgba(A.front, os.path.join(out, 'front.png'))
    fb = A.lm['face_bbox']
    crown = A.lm.get('crown', fb[1])
    hb = A.lm.get('hair_bbox', fb)
    h = (fb[3] - crown)
    crop = (A.mid_x - 1.1 * h, crown - 0.15 * h, A.mid_x + 1.1 * h, fb[3] + 0.65 * h)
    for ax, tag in ((0, 'head'), (-30, 'head_turnR'), (30, 'head_turnL')):
        p = m.pose({'ParamAngleX': ax, 'ParamBodyAngleX': ax / 3, 'ParamMouthOpenY': 0})
        img, _ = render_pose(m, p, height=900, crop=crop, ss=2)
        save_rgba(img, os.path.join(out, f'{tag}.png'))
    log(f'references -> {out}')


def unzip(path, dest):
    """extract a zipped model folder safely (no absolute paths / '..', size cap) and return the folder"""
    import zipfile
    os.makedirs(dest, exist_ok=True)
    total = 0
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            name = info.filename.replace(chr(92), '/')
            if info.is_dir() or name.startswith('/') or '..' in name.split('/'):
                continue
            total += info.file_size
            if total > 1_500_000_000:
                raise ValueError('zip too large')
            target = os.path.join(dest, *name.split('/'))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with z.open(info) as fi, open(target, 'wb') as fo:
                fo.write(fi.read())
    return dest


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('model')
    ap.add_argument('out')
    ap.add_argument('--sex', default='auto', choices=['auto', 'female', 'male'])
    ap.add_argument('--name')
    ap.add_argument('--id')
    ap.add_argument('--hair-mode', default='auto', choices=['auto', 'down', 'ponytail', 'twintails'])
    ap.add_argument('--no-hair', action='store_true', help='keep the VRoid donor hairstyle (skip the Blender hair stage)')
    ap.add_argument('--stage-only', choices=['analyze', 'design'])
    ap.add_argument('--image', action='store_true', help='the input is a single front drawing (png / jpg), not a Live2D model')
    ap.add_argument('--signature-rest', action='store_true',
                    help="rest face = the character's signature grin found in a --ref drawing (default off: the rest "
                         "face follows the main drawing)")
    ap.add_argument('--ref', action='append', default=[], metavar='IMG',
                    help='another drawing of the same character (other expressions / angles): features the main input '
                         'does not show (e.g. pointed teeth in an open mouth) are read from it; repeatable')
    ap.add_argument('--live-blender', action='store_true',
                    help='build the hair in a VISIBLE Blender window (step by step, orbiting the head) instead of headless')
    ap.add_argument('--turnaround', metavar='DIR|auto',
                    help='optional side / back views (front, three_quarter, side, back images or one sheet) that shape '
                         'the hair / garments the Live2D cannot show; "auto" runs the generator configured in '
                         'VTP_TURNAROUND_GEN (see blender/live2d/turnaround.py). Cached per model in <out>/l2d/turnaround')
    ap.add_argument('--vtp2', action='store_true', help='the input is a Pro2D bundle (tools/pro2d_bundle.ts export)')
    ap.add_argument('--overrides', help='design overrides (JSON, flat dotted keys; shared/to3d/overrides.ts)')
    ap.add_argument('--mode', default='full', choices=['full', 'hair', 'springs', 'profile'],
                    help='rebuild scope from --prev: full (everything), hair (hair stage on the previous base), springs '
                         '(re-assemble the previous hair with new spring settings), profile (profile.json only)')
    ap.add_argument('--prev', help="the previous round's out_dir (needed by --mode hair / springs / profile)")
    ap.add_argument('--base', help="the performer's own VRoid base (.vrm, VRM 0.x): used instead of the bundled bases")
    ap.add_argument('--builtin-bases', action='store_true',
                    help="build on VTube Pro's own bundled bases (Mirelle, Kairo: assets/builtin); the default with --vtp2")
    ap.add_argument('--progress', help='write the current stage here as JSON (the helper shows it)')
    a = ap.parse_args(argv)
    if a.live_blender:
        os.environ['VTP_L2D_LIVE'] = '1'
    low_priority()
    t0 = time.time()
    out = os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)
    l2 = os.path.join(out, 'l2d')
    os.makedirs(l2, exist_ok=True)
    progress = Progress(a.progress)
    ov = {}
    if a.overrides:
        sys.path.append(os.path.join(ROOT, 'blender', 'to3d'))
        import overrides as OV
        ov = OV.load(a.overrides)
    K = knobs_of(ov)
    if a.mode != 'full':
        # a partial rebuild starts from the previous round's whole output (its base, hair work, profile)
        if not a.prev or not os.path.isdir(a.prev):
            raise SystemExit('--mode %s needs --prev <the previous out_dir>' % a.mode)
        if os.path.abspath(a.prev) != out:
            shutil.copytree(a.prev, out, dirs_exist_ok=True, ignore=shutil.ignore_patterns('to3d_*'))
    if a.mode == 'profile':
        progress.step('profile', 6)
        finish_profile_only(out, K)
        progress.done(out)
        print(f'[6/6] profile -> {out}  ({time.time() - t0:.0f} s)')
        return 0
    if a.mode == 'springs':
        progress.step('springs', 5)
        from live2d import assemble
        assemble.TUNE = tune_of(assemble.TUNE, K)
        with open(os.path.join(out, 'profile.json'), encoding='utf-8') as f:
            prof = json.load(f)
        vrm = os.path.join(out, prof['modelFile'])
        base = os.path.join(out, 'l2d', 'base_no_hair.vrm')
        tmp = vrm + '.tmp.vrm'
        assemble.assemble(base, os.path.join(out, 'l2d', 'hair'), tmp, exposure_comp=1.0, log=print)
        os.replace(tmp, vrm)
        finish_profile_only(out, K)
        progress.done(out)
        print(f'[6/6] springs -> {out}  ({time.time() - t0:.0f} s)')
        return 0
    src = a.model
    image_route = a.image or src.lower().endswith(('.png', '.jpg', '.jpeg', '.webp'))
    if src.lower().endswith('.zip'):
        src = unzip(src, os.path.join(l2, 'src'))
    progress.step('read', 1)
    if image_route:
        # a single front DRAWING (no Live2D model): segmented into eyes / face / hair / garments (live2d/image2d.py)
        from live2d import image2d
        m = None
        A = image2d.analyze_image(src, log=lambda s: print('   ', s))
        print(f'[1/6] read drawing {os.path.basename(src)} ({A.image.shape[1]}x{A.image.shape[0]})')
        image2d.references(A, l2)
    else:
        if a.vtp2 or os.path.isfile(os.path.join(src, 'bundle.json')):
            from live2d.vtp2 import Vtp2Model
            m = Vtp2Model.load(src)
            print(f'[1/6] read Pro2D {m.name}: {m.moc.counts["arts"]} meshes, {m.moc.counts["params"]} parameters')
        else:
            m = L2DModel.load(src)
            print(f'[1/6] read {m.name}: moc3 v{m.moc.version}, {m.moc.counts["arts"]} art meshes, {m.moc.counts["params"]} parameters')
        progress.step('analyze', 2)
        A = analyze(m, height=2048)
        references(m, A, l2)
    A.turnaround = None
    if a.turnaround:
        from live2d import turnaround as TV
        views = TV.collect(a.turnaround, m, out, refs={'ref': os.path.join(l2, 'front.png'),
                                                       'refL': os.path.join(l2, 'head_turnL.png'),
                                                       'refR': os.path.join(l2, 'head_turnR.png')},
                           log=lambda s: print('   ', s))
        A.turnaround = TV.measure(views, A, log=lambda s: print('   ', s)) if views else None
    from collections import Counter
    print(f'[2/6] analyze: {dict(Counter(A.cls))}')
    name = a.name or (m.name if m else os.path.splitext(os.path.basename(src))[0])
    pid = a.id or slug(name)
    progress.step('design', 3)
    user_metrics = None
    force_base = K['base']
    if a.base:
        sys.path.append(os.path.join(ROOT, 'blender', 'to3d'))
        import user_base as UB
        ub = UB.check(a.base)
        if not ub['ok']:
            raise SystemExit('BASE_REFUSED ' + ' '.join(ub['problems']))
        from anime_creator import params as CP
        if ub['kind'] == 'user':
            CP.BASES['user'] = {'file': os.path.abspath(a.base), 'gender': K['sex'] or (a.sex if a.sex != 'auto' else 'female'),
                                'label': 'your own base'}
            user_metrics = ub['metrics']
            force_base = force_base or 'user'
            from live2d import faceadj as FA
            asp = ub['metrics']['eye_h'] / ub['metrics']['eye_w']
            FA.BASE_ASPECT['user'] = round(asp, 3)
            FA.BASE_COL_ASPECT['user'] = round(0.93 * asp, 3)
        else:                                            # one of the bundled bases, picked as a file
            force_base = force_base or ub['base']
    sex = K['sex'] or a.sex
    avail = register_builtin_bases() if (a.builtin_bases or a.vtp2 or a.base) else available_bases()
    if a.base and not user_metrics and force_base in (None, 'user'):
        force_base = None
    pre = design(A, sex=sex, name=name, pid=pid, force_base=force_base, available=avail, user_metrics=user_metrics)
    if ov:
        OV.apply_design(pre, ov)
    rep = {'model': m.name if m else os.path.basename(src),
           'classes': {m.moc.art_ids[i]: [c, A.side[i]] for i, c in enumerate(A.cls)} if m else {},
           'landmarks': A.lm, 'colors': A.colors, 'outfit': getattr(A, 'outfit', {}), 'design': pre}
    with open(os.path.join(l2, 'analysis.json'), 'w', encoding='utf-8') as f:
        json.dump(rep, f, indent=1, ensure_ascii=False, default=float)
    ef = (pre['l2d'].get('eyes') or {}).get('preset')
    if ef:
        try:
            from face_kit import anime_eyes as AE
            AE.preview(ef, os.path.join(l2, 'eyes_fit.png'))
        except Exception as e:
            print(f'    eyefit preview skipped: {e}')
    print(f'[3/6] design: {pre["l2d"]["sex"]} (auto {pre["l2d"]["sex_auto"]} {pre["l2d"]["sex_score"]}), base '
          f'{pre["creator"]["base"]}, eyeSize {pre["creator"]["face"]["eyeSize"]}, chin {pre["creator"]["face"]["chin"]}')
    if a.stage_only in ('analyze', 'design'):
        progress.done(out)
        return 0
    if a.mode == 'hair':
        progress.step('hair', 5)
        run_hair(A, pre, out, K, a, reuse_base=True)
        progress.step('profile', 6)
        from live2d import finish
        finish.profile(A, pre, out, signature=False)
        finish_profile_only(out, K)
        progress.done(out)
        print(f'[6/6] hair -> {out}  ({time.time() - t0:.0f} s)')
        return 0
    from live2d import faceadj
    try:
        ms0 = faceadj.mouth_shape(A)
        if ms0 is not None:
            # the drawn neutral mouth line painted as drawn: width, stroke, corner lifts, ink colour
            sk = pre['face'].setdefault('skin', {})
            sk['mouthDrawn'] = {k: ms0[k] for k in ('width_ipd', 'thick_ipd', 'left', 'right')}
            if 'face.skin.mouthLine' not in ov:
                sk['mouthLine'] = ms0['color']
            print(f"    mouth: drawn line {ms0['width_ipd']:.2f} IPD wide, stroke {ms0['thick_ipd']:.3f}, {ms0['color']}")
    except Exception as e:
        print(f'    mouth line: skipped ({type(e).__name__}: {e})')
    progress.step('build', 4)
    from face_kit import anime_face
    fk = {k: v for k, v in pre.items() if k != 'l2d'}
    prof = anime_face.build(fk, out, log=lambda s: print('   ', s))
    print(f'[4/6] build: {prof["modelFile"]}')
    Mt = pre['l2d']['metrics']
    if 'eye_aspect_fit' in Mt:
        k = faceadj.lid_bake_amount(pre['creator']['base'], Mt['eye_aspect_fit'], fitted=True)
    else:
        k = faceadj.lid_bake_amount(pre['creator']['base'], Mt.get('eye_aspect', 0.75))
    if K['lid_bake'] is not None:
        k = float(K['lid_bake'])
    vrm = os.path.join(out, prof['modelFile'])
    lid = None
    if Mt.get('eye_curves') and K['drawn_lid'] is not False:
        # the drawn lid LINE shapes the eye (authored design); a uniform narrowing only when it is not measurable
        try:
            lid = faceadj.lid_template(vrm, vrm, Mt['eye_curves'], log=lambda s: print('   ', s))
        except Exception as e:
            print(f'    lid template skipped: {type(e).__name__}: {e}')
    if lid is None:
        faceadj.narrow_eyes(vrm, vrm, k, log=lambda s: print('   ', s))
    elif lid < 0.7 * k:
        # the drawn opening (height / width) is narrower than the lid LINE alone produced (the tuck anchor sits on
        # the painted iris, which the base draws larger than its opening): the rest of the aspect deficit as a
        # uniform narrowing on top -- a sharp, half-lidded drawn eye must not come out round (Ren, review x6)
        faceadj.narrow_eyes(vrm, vrm, k - lid, log=lambda s: print('   ', s))
    faceadj.shrink_ears(vrm, vrm, log=lambda s: print('   ', s))
    faceadj.skin_shading(vrm, vrm, log=lambda s: print('   ', s))
    ms = None
    try:
        ms = faceadj.mouth_shape(A)
    except Exception as e:
        print(f'    mouth: skipped ({type(e).__name__}: {e})')
    if K['rest_smile'] is not None:
        faceadj.rest_smile(vrm, vrm, float(K['rest_smile']), log=lambda s: print('   ', s))
    elif ms is not None:
        sag = ms['sag']
        print(f"    mouth: drawn neutral curve {sag:+.3f} (corners: left {ms['left']:+.3f}, right {ms['right']:+.3f})")
        kc = lambda v: float(np.clip((v - 0.02) * 6.0, 0.0, 0.55))
        # a smirk (one corner clearly higher) lifts that corner only
        if abs(ms['left'] - ms['right']) > 0.05:
            faceadj.rest_smile(vrm, vrm, 0.0, k_left=kc(ms['left']), k_right=kc(ms['right']), log=lambda s: print('   ', s))
        else:
            faceadj.rest_smile(vrm, vrm, kc(sag), log=lambda s: print('   ', s))
    # teeth: pointed teeth drawn in any of the character's drawings (the main one or --ref) -> shark teeth
    teeth = None
    try:
        from live2d import image2d
        cands = ([A] if m is None else []) + [image2d.analyze_image(r, log=lambda s: None) for r in a.ref]
        for Ai in cands:
            got = image2d.teeth_from_drawing(Ai, log=lambda s: print('   ', s))
            if got and got.get('teeth') == 'shark':
                teeth = 'shark'
                break
    except Exception as e:
        print(f'    teeth: skipped ({type(e).__name__}: {e})')
    if K['teeth']:
        teeth = 'shark' if K['teeth'] == 'shark' else None
    if teeth == 'shark':
        faceadj.shark_teeth(vrm, vrm, log=lambda s: print('   ', s))
    if a.signature_rest and teeth:
        faceadj.signature_rest(vrm, vrm, log=lambda s: print('   ', s))
    progress.step('outfit', 4)
    from live2d import garment
    garment.paint(A, vrm, vrm, log=lambda s: print('   ', s))
    if not a.no_hair:
        progress.step('hair', 5)
        run_hair(A, pre, out, K, a, reuse_base=False)
        print('[5/6] hair: done')
    progress.step('profile', 6)
    from live2d import finish
    finish.profile(A, pre, out, signature=bool(a.signature_rest and teeth))
    finish_profile_only(out, K)
    progress.done(out)
    print(f'[6/6] profile -> {out}  ({time.time() - t0:.0f} s)')
    return 0


class Progress:
    """the current stage as JSON (the helper's to3d job reads it) + one TO3D_STEP line per stage"""
    STAGES = 6

    def __init__(self, path):
        self.path = path

    def _write(self, d):
        print('TO3D_STEP ' + json.dumps(d), flush=True)
        if self.path:
            tmp = self.path + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(d, f)
            os.replace(tmp, self.path)

    def step(self, name, n):
        self._write({'stage': name, 'n': n, 'of': self.STAGES, 'at': time.time()})

    def done(self, out):
        self._write({'stage': 'done', 'n': self.STAGES, 'of': self.STAGES, 'at': time.time(), 'out': out})


def knobs_of(ov):
    if not ov:
        return {'sex': None, 'base': None, 'lid_bake': None, 'drawn_lid': True, 'rest_smile': None, 'teeth': None,
                'hair_mode': None, 'back_scale': None, 'hair_opts': [], 'springs': {}, 'exposure': None}
    import overrides as OV
    return OV.knobs(ov)


def tune_of(tune, K):
    if not K['springs']:
        return tune
    import overrides as OV
    return OV.tune_springs(tune, K['springs'])


def register_builtin_bases():
    """VTube Pro's own bundled bases (blender/to3d/builtin_bases.json, measured by user_base.py builtins --write) as
    anime_creator bases with their measurements; returns their keys (the only bases a Pro2D conversion picks from)"""
    sys.path.append(os.path.join(ROOT, 'blender', 'to3d'))
    import user_base as UB
    keys = UB.register_builtins()
    if not keys:
        raise SystemExit("BASE_REFUSED VTube Pro's base bodies (Mirelle, Kairo) are missing from this install: check that the VTube Pro folder is complete.")
    return keys


def available_bases():
    """the CC0 base keys present on this PC (VTP_VROID_DIR or tools/vendor/vroid)"""
    from anime_creator import params as CP
    from anime_creator import build as CB
    have = [k for k, b in CP.BASES.items() if k != 'user' and os.path.isfile(os.path.join(CB.VENDOR, b['file']))]
    return have or None


def run_hair(A, pre, out, K, a, reuse_base):
    from live2d import hair as L2H, assemble
    assemble.TUNE = tune_of(assemble.TUNE, K)
    if K['hair_opts']:
        os.environ['VTP_L2D_HAIR_OPTS'] = ' '.join([os.environ.get('VTP_L2D_HAIR_OPTS', '')] + K['hair_opts']).strip()
    edit = None
    if K['back_scale'] is not None:
        sc = float(K['back_scale'])

        def edit(frame):
            # back length is measured from the eye line (b, IPD units): scale the distance below it
            if frame.get('back_len') is not None:
                frame['back_len'] = float(frame['back_len']) * sc
    L2H.run(A, pre, out, log=print, mode=K['hair_mode'] or a.hair_mode, reuse_base=reuse_base, frame_edit=edit)


def finish_profile_only(out, K):
    """profile-level overrides (look.vrmExposure) on the finished profile.json"""
    if K['exposure'] is None:
        return
    p = os.path.join(out, 'profile.json')
    with open(p, encoding='utf-8') as f:
        prof = json.load(f)
    prof.setdefault('look', {})['vrmExposure'] = float(K['exposure'])
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(prof, f, indent=1)

if __name__ == '__main__':
    sys.exit(main())
