"""Hair stage orchestration: Live2D silhouettes -> locks.json (numpy) -> Blender clumps (low priority) -> VRM assembly.

Blender (VTP_BLENDER, else the newest Program Files/Blender Foundation/Blender *, else `blender` on PATH) runs at
IDLE priority, like tools/blender_low.cmd. If the environment variable VTP_BLENDER_LOCK names a directory, the run
takes that directory as a mutex (mkdir) first, so parallel builds never run two Blenders at once.
"""
import json
import os
import shutil
import subprocess
import sys
import time

from . import hair2d, assemble

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))


def _blender_exe():
    exe = os.environ.get('VTP_BLENDER')
    if exe:
        return exe
    if os.name == 'nt':
        import glob
        c = sorted(glob.glob(os.path.join(os.environ.get('ProgramFiles', 'C:/Program Files'), 'Blender Foundation', 'Blender *', 'blender.exe')))
        if c:
            return c[-1]
    return shutil.which('blender') or 'blender'


def _blender_cmd(script, args):
    if os.environ.get('VTP_L2D_LIVE') == '1':        # a visible window: the user watches the hair being built
        return [_blender_exe(), '--factory-startup', '--python', script, '--'] + args + ['live=1']
    return [_blender_exe(), '-b', '--factory-startup', '--python', script, '--'] + args


def run_blender(script, args, log=print, timeout=1800):
    lock = os.environ.get('VTP_BLENDER_LOCK')
    held = False
    try:
        if lock:
            while True:
                try:
                    os.mkdir(lock); held = True
                    open(os.path.join(lock, 'owner.txt'), 'w').write('live2d')
                    break
                except FileExistsError:
                    log('blender busy (lock held), waiting 30 s ...'); time.sleep(30)
        # low CPU priority (IDLE class on Windows, nice elsewhere): never starve a live studio's face tracking
        live = os.environ.get('VTP_L2D_LIVE') == '1'
        kw = {'creationflags': 0x00004000 if live else 0x00000040} if os.name == 'nt' else {'preexec_fn': lambda: os.nice(10)}
        r = subprocess.run(_blender_cmd(script, args), capture_output=True, text=True, timeout=timeout,
                           encoding='utf-8', errors='replace', **kw)
        out = (r.stdout or '') + (r.stderr or '')
        for line in out.splitlines():
            if line.startswith(('HAIR', 'MAP', 'VOLUME', 'DOME', 'TURNFIT', 'RING', 'COVER', 'SILFIT', 'CROWN', 'LIVE', 'SWEEP', 'HAIRLINE', 'drawn normals', 'EXPORT', 'DUMP', 'coverage', 'WROTE', 'Traceback', 'Error', '  File')) or 'Error' in line:
                log('   blender: ' + line)
        if r.returncode != 0 or 'Traceback' in out:
            raise RuntimeError('Blender hair stage failed:\n' + out[-3000:])
        return out
    finally:
        if held:
            shutil.rmtree(lock, ignore_errors=True)


def _mix_hex(a, b, t):
    ca = [int(a.lstrip('#')[i:i + 2], 16) for i in (0, 2, 4)]
    cb = [int(b.lstrip('#')[i:i + 2], 16) for i in (0, 2, 4)]
    return '#%02x%02x%02x' % tuple(int(round(x + (y - x) * t)) for x, y in zip(ca, cb))


def _vivid(h, ks=1.7, kv=1.12):
    import colorsys
    r, g, b = [int(h.lstrip('#')[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    hh, ss, vv = colorsys.rgb_to_hsv(r, g, b)
    r, g, b = colorsys.hsv_to_rgb(hh, min(1.0, ss * ks), min(1.0, vv * kv))
    return '#%02x%02x%02x' % (int(r * 255), int(g * 255), int(b * 255))


def hair_params(pre):
    C = pre['l2d']['colors']
    hair = C.get('hair', '#5a4a4a')
    tip = pre['creator']['colors'].get('hairTip')
    # without a dyed tip the drawn root / tip samples are mostly shading: keep the ramp close to the hair colour
    # (a dark 'tip' made Haru's ringlet ends read maroon)
    root = C.get('hair_root', hair) if tip else _mix_hex(C.get('hair_root', hair), hair, 0.5)
    # a dyed tip is drawn as a vivid accent; the median sample of a shaded strip reads dull in 3D
    return {'hair': hair, 'root': root, 'tip': _vivid(tip) if tip else hair,
            'shade': C.get('hair_shade'), 'light': C.get('hair_light'), 'ink': C.get('hair_ink'),
            'tip_range': [0.3, 0.75] if tip else [0.7, 1.0]}


def eye_points(vrm):
    """iris centres of the VRM face (the eye bones sit deep in the head, closer together) in Blender coordinates"""
    import numpy as np
    from anime_creator.vroid import Model
    m = Model(vrm)
    d = m.read_mesh(m.mesh_index('Face'))
    ids = [i for i, p in enumerate(d.prims) if 'EyeIris' in m.mat_name(p['material'])]
    P = d.P[d.verts_of(ids)]
    out = {}
    for side, sel in (('eye_L_bl', P[:, 0] < 0), ('eye_R_bl', P[:, 0] > 0)):   # glTF -X = character's left
        c = P[sel].mean(0)
        front = P[sel][:, 2].min()                                            # VRM0 faces -Z
        out[side] = [float(c[0]), float(-front), float(c[1])]                 # glTF (x, y, z) -> Blender (x, -z, y)
    return out


def run(A, pre, out, log=print, mode=None, reuse_base=False, frame_edit=None):
    """frame_edit(frame): a last change to the measured hair frame (Pro2D -> 3D overrides: back length)"""
    out = os.path.abspath(out)
    work = os.path.join(out, 'l2d', 'hair')
    os.makedirs(work, exist_ok=True)
    if A.model is None:                               # image-only route (live2d/image2d.py)
        from . import image2d
        res = image2d.extract_hair(A, log=log)
    else:
        res = hair2d.extract(A.model, A, log=log, mode=mode)
    try:
        from . import turnaround
        if A.model is not None:
            res['frame']['turns'] = turnaround.turn_profile(A.model, A, log=log)
    except Exception as e:                    # never fail a conversion on the turn fit
        log(f'turns: skipped ({type(e).__name__}: {e})')
    if getattr(A, 'turnaround', None):
        from . import turnaround
        turnaround.apply_to_frame(res['frame'], A.turnaround, log=log)
    if frame_edit:
        frame_edit(res['frame'])
    locks = os.path.join(work, 'locks.json')
    hair2d.save(res, locks)
    pp = os.path.join(work, 'hair_params.json')
    vrm = os.path.join(out, pre['id'] + '.vrm')
    hp = hair_params(pre)
    hp.update(eye_points(vrm))
    json.dump(hp, open(pp, 'w'), indent=1)
    # the face_kit build without hair, kept so hair-only re-runs (reuse_base=True) start clean; a full conversion
    # always refreshes it from the model it just built
    base = os.path.join(out, 'l2d', 'base_no_hair.vrm')
    if not (reuse_base and os.path.exists(base)):
        shutil.copyfile(vrm, base)
    run_blender(os.path.join(HERE, 'hair_blender.py'), [base, locks, pp, work] + os.environ.get('VTP_L2D_HAIR_OPTS', '').split(), log=log)
    tmp = vrm + '.tmp.vrm'
    assemble.assemble(base, work, tmp, exposure_comp=1.0, log=log)
    os.replace(tmp, vrm)
