"""
ARKit-52 face shape keys for the MakeHuman basemesh, synthesised from MakeHuman's facial expression units
(targets/expression/units/<race>/*.target.gz, blended by the character's ethnicity weights) plus procedural
deformers for the channels MakeHuman has no unit for (cheek puff/squint, jaw/mouth sideways, lip roll/shrug,
mouth close, tongue out). The keys are then carried onto every proxy that rides the face (eyebrows, eyelashes,
teeth, tongue, hair, clothes) through the proxies' MHCLO vertex bindings, so lashes close with the lids, the
lower teeth + tongue drop with the jaw and brows move with the brow keys.

Coordinates here are MPFB's: metres, Z up, -Y = front, +X = the character's LEFT.
"""
import os

import bpy
import numpy as np

from . import mpfb_env as ME

UNITS = ['eye-left-closure', 'eye-left-opened-up', 'eye-left-slit', 'eye-right-closure', 'eye-right-opened-up',
         'eye-right-slit', 'eyebrows-left-down', 'eyebrows-left-extern-up', 'eyebrows-left-inner-up', 'eyebrows-left-up',
         'eyebrows-right-down', 'eyebrows-right-extern-up', 'eyebrows-right-inner-up', 'eyebrows-right-up',
         'mouth-compression', 'mouth-corner-puller', 'mouth-depression', 'mouth-depression-retraction',
         'mouth-elevation', 'mouth-eversion', 'mouth-open', 'mouth-parling', 'mouth-part-later', 'mouth-protusion',
         'mouth-pursing', 'mouth-retraction', 'mouth-upward-retraction', 'neck-platysma', 'nose-compression',
         'nose-depression', 'nose-left-dilatation', 'nose-left-elevation', 'nose-right-dilatation',
         'nose-right-elevation']


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def coords(ob, key=None):
    n = len(ob.data.vertices)
    a = np.empty(n * 3, dtype=np.float64)
    (key.data if key is not None else ob.data.vertices).foreach_get('co', a)
    return a.reshape(n, 3)


def group_weights(ob, name):
    n = len(ob.data.vertices)
    w = np.zeros(n)
    g = ob.vertex_groups.get(name)
    if g is None:
        return w
    gi = g.index
    for v in ob.data.vertices:
        for e in v.groups:
            if e.group == gi:
                w[v.index] = e.weight
    return w


def group_center(ob, name, B):
    w = group_weights(ob, name)
    if w.sum() <= 0:
        return None
    return (B * w[:, None]).sum(0) / w.sum()


def load_units(bm, race):
    """Race-blended unit deltas {unit: (n,3)}, read through MPFB's target loader."""
    ns = ME.enable()
    TS = ns.TargetService
    B = coords(bm)
    out = {}
    for u in UNITS:
        acc = np.zeros_like(B)
        for r, w in race.items():
            if w <= 1e-3:
                continue
            path = os.path.join(ME.target_dir('expression', 'units', r), u + '.target.gz')
            if not os.path.isfile(path):
                continue
            TS.load_target(bm, path, weight=1.0, name='tmp_unit')
            kb = bm.data.shape_keys.key_blocks['tmp_unit']
            acc += (coords(bm, kb) - B) * w
            bm.shape_key_remove(kb)
        out[u] = acc
    return out


class FaceRig:
    def __init__(self, H, p, log=print):
        self.H, self.p, self.log = H, p, log
        bm = H.basemesh
        if not bm.data.shape_keys:
            bm.shape_key_add(name='Basis', from_mix=False)
        self.B = coords(bm)
        B = self.B
        self.x = B[:, 0]
        self.eyeL = group_center(bm, 'joint-l-eye', B)
        self.eyeR = group_center(bm, 'joint-r-eye', B)
        self.mouth = group_center(bm, 'joint-mouth', B)
        self.jaw = group_center(bm, 'joint-jaw', B)
        self.head = group_center(bm, 'joint-head', B)
        self.lips = group_weights(bm, 'lips')
        self.helper = group_weights(bm, 'HelperGeometry') + group_weights(bm, 'JointCubes')
        # face scale: interpupillary distance (~0.063 m on an adult)
        self.ipd = float(np.linalg.norm(self.eyeL - self.eyeR)) if self.eyeL is not None else 0.063
        self.k = self.ipd / 0.063
        self.sideL = smoothstep(-0.004 * self.k, 0.004 * self.k, self.x)   # character's left = +X
        self.sideR = 1.0 - self.sideL
        self.normals = np.array([v.normal[:] for v in bm.data.vertices])

    # ---- helpers
    def radial(self, c, r, power=2.0):
        d = np.linalg.norm(self.B - c, axis=1) / r
        return np.clip(1 - d, 0, 1) ** power

    def build(self):
        H, p = self.H, self.p
        bm = H.basemesh
        U = load_units(bm, p['body']['race'])
        k = self.k
        L, R = self.sideL[:, None], self.sideR[:, None]
        S = {}
        # ---------------- eyes (units are per side already)
        S['eyeBlinkLeft'] = U['eye-left-closure'] * 1.0
        S['eyeBlinkRight'] = U['eye-right-closure'] * 1.0
        S['eyeWideLeft'] = U['eye-left-opened-up'] * 0.9
        S['eyeWideRight'] = U['eye-right-opened-up'] * 0.9
        S['eyeSquintLeft'] = U['eye-left-slit'] * 0.75
        S['eyeSquintRight'] = U['eye-right-slit'] * 0.75
        # ---------------- brows
        S['browDownLeft'] = U['eyebrows-left-down'] * 1.3
        S['browDownRight'] = U['eyebrows-right-down'] * 1.3
        S['browInnerUp'] = (U['eyebrows-left-inner-up'] + U['eyebrows-right-inner-up']) * 1.4
        S['browOuterUpLeft'] = U['eyebrows-left-extern-up'] * 1.2 + U['eyebrows-left-up'] * 0.5
        S['browOuterUpRight'] = U['eyebrows-right-extern-up'] * 1.2 + U['eyebrows-right-up'] * 0.5
        # ---------------- jaw / mouth
        jaw = U['mouth-open']
        S['jawOpen'] = jaw * 1.0 + U['mouth-elevation'] * 0.22      # upper lip lifts a little: upper teeth show
        jawmag = np.linalg.norm(jaw, axis=1)
        jawmask = np.clip(jawmag / (jawmag.max() + 1e-9), 0, 1)
        jawmask = smoothstep(0.05, 0.6, jawmask)[:, None]
        S['jawForward'] = jawmask * np.array([0, -0.007, 0]) * k
        S['jawLeft'] = jawmask * np.array([0.008, 0, 0]) * k
        S['jawRight'] = jawmask * np.array([-0.008, 0, 0]) * k
        S['mouthSmileLeft'] = (U['mouth-corner-puller'] * 0.95 + U['mouth-upward-retraction'] * 0.3) * L
        S['mouthSmileRight'] = (U['mouth-corner-puller'] * 0.95 + U['mouth-upward-retraction'] * 0.3) * R
        S['mouthFrownLeft'] = U['mouth-depression'] * L
        S['mouthFrownRight'] = U['mouth-depression'] * R
        S['mouthStretchLeft'] = U['mouth-retraction'] * L
        S['mouthStretchRight'] = U['mouth-retraction'] * R
        S['mouthPressLeft'] = U['mouth-compression'] * L
        S['mouthPressRight'] = U['mouth-compression'] * R
        S['mouthDimpleLeft'] = (U['mouth-corner-puller'] * 0.25 + U['mouth-retraction'] * 0.35) * L
        S['mouthDimpleRight'] = (U['mouth-corner-puller'] * 0.25 + U['mouth-retraction'] * 0.35) * R
        S['mouthPucker'] = U['mouth-pursing'] * 1.0 + U['mouth-protusion'] * 0.3
        S['mouthFunnel'] = U['mouth-protusion'] * 0.8 + U['mouth-eversion'] * 0.6 + U['mouth-parling'] * 0.5
        S['mouthUpperUpLeft'] = U['mouth-elevation'] * L
        S['mouthUpperUpRight'] = U['mouth-elevation'] * R
        S['mouthLowerDownLeft'] = U['mouth-depression-retraction'] * L * 0.8
        S['mouthLowerDownRight'] = U['mouth-depression-retraction'] * R * 0.8
        S['noseSneerLeft'] = U['nose-left-elevation'] + U['mouth-elevation'] * L * 0.25
        S['noseSneerRight'] = U['nose-right-elevation'] + U['mouth-elevation'] * R * 0.25
        # ---------------- procedural
        B = self.B
        mouth = self.mouth
        lips = self.lips[:, None]
        above = smoothstep(-0.002 * k, 0.002 * k, B[:, 2] - mouth[2])[:, None]      # upper lip side
        below = 1 - above
        mouthzone = self.radial(mouth, 0.045 * k, 1.6)[:, None]
        front = smoothstep(0.0, 0.02 * k, (mouth[1] + 0.03 * k) - B[:, 1])[:, None]  # face surface, not the throat
        # mouth sideways (lips + surrounding skin)
        S['mouthLeft'] = mouthzone * front * np.array([0.007, 0, 0]) * k
        S['mouthRight'] = mouthzone * front * np.array([-0.007, 0, 0]) * k
        # lips close while the jaw is open: cancel the jaw's motion on the lips (lower lip rides up)
        lipsgrow = np.maximum(lips, self.radial(mouth, 0.016 * k, 1.0)[:, None] * front)
        S['mouthClose'] = -jaw * lipsgrow * 0.95
        # lip roll: lips curl inward over the teeth
        S['mouthRollLower'] = lips * below * np.array([0, 0.0045, 0.0015]) * k
        S['mouthRollUpper'] = lips * above * np.array([0, 0.0045, -0.0012]) * k
        # shrug: chin boss + lower lip push up / upper lip up
        chin = self.radial(mouth + np.array([0, 0, -0.03]) * k, 0.03 * k, 1.5)[:, None] * front
        S['mouthShrugLower'] = (lips * below * 0.8 + chin * 0.6) * np.array([0, -0.001, 0.0035]) * k
        S['mouthShrugUpper'] = lips * above * np.array([0, -0.001, 0.0025]) * k
        # cheeks: puff inflates along the normal; squint lifts the cheek under the eye (+ a little lid slit)
        nrm = self.normals
        for side, eye, s in (('Left', self.eyeL, 1), ('Right', self.eyeR, -1)):
            c_puff = mouth + np.array([s * 0.036, 0.012, 0.006]) * k
            m = self.radial(c_puff, 0.034 * k, 1.4)[:, None] * front
            S.setdefault('cheekPuff', np.zeros_like(B))
            S['cheekPuff'] += nrm * m * 0.009 * k
            c_sq = eye + np.array([s * 0.006, -0.004, -0.028]) * k
            m2 = self.radial(c_sq, 0.024 * k, 1.5)[:, None]
            S['cheekSquint' + side] = m2 * np.array([0, -0.0012, 0.0035]) * k + U['eye-%s-slit' % side.lower()] * 0.25
        S['cheekPuff'] += lips * np.array([0, -0.0015, 0]) * k   # lips pressed forward a touch
        # keep helper geometry untouched except where proxies need it (teeth/tongue helpers ride the jaw)
        strength = float(p['expression'].get('strength', 1.0))
        keys = []
        for name, d in S.items():
            kb = bm.shape_key_add(name=name, from_mix=False)
            kb.data.foreach_set('co', (B + d * strength).ravel())
            kb.value = 0.0
            keys.append(name)
        self.keys = keys
        self.log('face keys', len(keys))
        return keys

    # ---- profile markers (glTF space: x, z, -y)
    def markers(self):
        B, lips = self.B, self.lips
        sel = lips > 0.3
        P = B[sel]
        mid = P[np.abs(P[:, 0]) < 0.004 * self.k]
        z = float(np.median(mid[:, 2])) if len(mid) else float(self.mouth[2])
        y = float(mid[:, 1].min()) if len(mid) else float(self.mouth[1])
        self.mouth_front = np.array([0.0, y, z])
        w = float((P[:, 0].max() - P[:, 0].min()) / 2) if len(P) else 0.025
        return {'mouth': {'position': [0.0, round(z, 5), round(-y, 5)], 'normal': [0.0, -0.1, 0.995]},
                'mouthWidth': w}

    def eye_markers(self, H):
        out = {}
        for side, key in (('left', 'eyeL'), ('right', 'eyeR')):
            if side not in H.eye_centers:
                continue
            c, r = H.eye_centers[side]
            f = [c[0], c[1] - r, c[2]]
            out[key] = {'position': [round(f[0], 5), round(f[2], 5), round(-f[1], 5)],
                        'normal': [round(0.12 if side == 'left' else -0.12, 3), 0.0, 0.993]}
            out['eyeRadius'] = float(r)
        return out

    def nose_tip(self):
        B = self.B
        m = (np.abs(B[:, 0]) < 0.004 * self.k) & (B[:, 2] > self.mouth[2]) & (B[:, 2] < (self.eyeL[2] + self.mouth[2]) / 2 + 0.01)
        body = group_weights(self.H.basemesh, 'body') > 0
        m &= body
        i = np.argmin(np.where(m, B[:, 1], 1e9))
        return B[i].copy()

    def tzone(self):
        """Per-vertex weight of the forehead + nose (slightly shinier skin)."""
        k = self.k
        c = (self.eyeL + self.eyeR) / 2
        fore = self.radial(c + np.array([0, -0.01, 0.045]) * k, 0.045 * k, 1.2)
        nose = self.radial(self.nose_tip() + np.array([0, 0.01, 0.015]) * k, 0.028 * k, 1.2)
        return np.maximum(fore, nose)

    def face_center(self):
        c = (self.eyeL + self.eyeR) / 2
        return (float(c[0]), float(c[1]), float(c[2] - 0.035 * self.k))

    # ---- proxies
    def transfer(self, objects):
        """Carry the basemesh ARKit keys onto proxies through their MHCLO bindings."""
        ns = ME.enable()
        bm = self.H.basemesh
        kbs = [bm.data.shape_keys.key_blocks[n] for n in self.keys]
        D = {kb.name: coords(bm, kb) - self.B for kb in kbs}
        for ob in objects:
            path = ob.get('vtp_mhclo')
            if not path:
                continue
            mh = ns.Mhclo()
            mh.load(path)
            n = len(ob.data.vertices)
            idx = np.zeros((n, 3), dtype=np.int64)
            wts = np.zeros((n, 3))
            for vi, m in mh.verts.items():
                if vi < n:
                    idx[vi] = m['verts']
                    wts[vi] = m['weights']
            C = coords(ob)
            added = 0
            for name, d in D.items():
                off = (d[idx] * wts[:, :, None]).sum(1)
                if np.abs(off).max() < 2e-4:
                    continue
                if not ob.data.shape_keys:
                    ob.shape_key_add(name='Basis', from_mix=False)
                kb = ob.shape_key_add(name=name, from_mix=False)
                kb.data.foreach_set('co', (C + off).ravel())
                kb.value = 0.0
                added += 1
            self.log('  keys ->', ob.name, added)

    def tongue_out(self, tongue):
        """tongueOut on the tongue proxy: slide forward + down, tip first."""
        if tongue is None:
            return
        if not tongue.data.shape_keys:
            tongue.shape_key_add(name='Basis', from_mix=False)
        C = coords(tongue)
        y = C[:, 1]
        back, tip = y.max(), y.min()
        t = np.clip((back - y) / max(back - tip, 1e-6), 0, 1)
        k = self.k
        d = np.zeros_like(C)
        d[:, 1] = -(0.012 + 0.03 * t ** 1.3) * k
        d[:, 2] = -(0.004 + 0.01 * t ** 2) * k
        # flatten + widen the protruding tip a touch
        cx = C[:, 0].mean()
        d[:, 0] = (C[:, 0] - cx) * 0.25 * t
        kb = tongue.shape_key_add(name='tongueOut', from_mix=False)
        kb.data.foreach_set('co', (C + d).ravel())
