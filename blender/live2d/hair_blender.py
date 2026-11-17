"""Blender stage of the Live2D -> 3D hair: lock guides (hair2d.py locks.json) -> anime_hair clumps on the real head of
the converted VRM -> stage-2 dumps (Hair.npz, Hair_Ink.npz, hair_bones.json) + preview renders.

    blender -b --factory-startup --python blender/live2d/hair_blender.py -- <avatar.vrm> <locks.json>
        <hair_params.json> <out_dir> [views=front,tq,side,back] [seed=7] [ink=0.0012]

How the hair is built (the look of 3D gacha / VTuber hair: one clean mass + a few big locks):
  * DOME  the visible hair mass over the skull: the head surface pushed out by a direction-dependent volume
          (top = the drawn crown above the skull, sides = the drawn hair width at the temples, front = thin),
          cut at the hairline, UV'd so the atlas' angel ring runs around the head. It replaces anime_hair's hidden
          scalp shell, and every lock above the hairline lies ON it, so the cel shading is one big clean shape.
  * LOCKS the Live2D lock guides (fringe, side, back, tails) placed on the dome / face / body: X / Z from the
          picture, Y from the surface they are drawn over (fringe over the forehead, front locks over the chest,
          back hair behind the head), depth from the rig's parallax only where no surface applies (flicks).
  * BACK  the back of the head Live2D never draws: two staggered rows of broad flame locks from the dome to the
          measured back length ('down'), or the dome pulled to the tie with a few flow locks (tied styles).
  * atlas in the model's colours: flat base, one form band, thin ink edges, one interior line, zig-zag ring;
          column 3 is repainted as the dome's (no lock edges, ring around the head).

Blender world: +Z up, the character faces +Y, character's right = +X.
"""
from __future__ import annotations

import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
from mathutils.bvhtree import BVHTree  # noqa: E402

from anime_hair import hairkit as hk, build, fit  # noqa: E402
from anime_hair.hairkit import Clump, Palette, unit, smoothstep  # noqa: E402
from anime_hair.styles import StyleResult, hang, jit  # noqa: E402

NV_LOCK = 3            # lock atlas columns 0..2; column 3 = the dome


def srgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def mix(a, b, t):
    return tuple(x * (1 - t) + y * t for x, y in zip(a, b))


def palette(pp):
    mid = srgb(pp['hair'])
    root = srgb(pp.get('root') or pp['hair'])
    tip = srgb(pp.get('tip') or pp['hair'])
    shade = srgb(pp['shade']) if pp.get('shade') else mix(mid, (0.2, 0.12, 0.3), 0.45)
    ink = srgb(pp['ink']) if pp.get('ink') else mix(shade, (0.06, 0.03, 0.08), 0.55)
    light = srgb(pp['light']) if pp.get('light') else mix(mid, (1, 1, 1), 0.5)
    sm = tuple(float(np.clip(s / max(m, 0.05), 0.4, 0.92)) for s, m in zip(shade, mid))
    # white / silver hair drawn with coloured INK (the lines carry its form): bolder edges + strand lines inside
    inked = bool(pp.get('ink')) and (0.3 * mid[0] + 0.59 * mid[1] + 0.11 * mid[2]) > 0.7
    sl = float(pp.get('strand_lines', 0.0))
    n_lines = 2 if (inked or sl > 0.12) else 1 if sl > 0.04 else 0           # the drawn strand line art density
    if inked:                                        # paper-white hair, its shadows in the ink's hue
        mid = mix(mid, (1, 1, 1), 0.35); tip = mix(tip, (1, 1, 1), 0.35); root = mix(root, mid, 0.5)
        shade = mix(shade, ink, 0.35)
        sm = tuple(float(np.clip(s / max(m, 0.05), 0.4, 0.92)) for s, m in zip(shade, mid))
    # CLEAN CEL: the light / shadow shapes come from the smooth mass normals + the toon ramp (one terminator across the
    # whole head); the texture adds only crisp ink edges, one crisp angel ring and (inked styles) strand lines -- no
    # per-lock shadow band or root darkening (hundreds of overlapping locks turned those into a clay-like mottle)
    return Palette(style='clean', root=root, mid=mid, tip=tip, shade=shade, ink=ink, shade_mul=sm,
                   root_range=(0.0, 0.2), tip_range=tuple(pp.get('tip_range', (0.55, 1.0))), edge_band=0.1,
                   band_alpha=0.35 if inked else 0.0, root_occ=0.0, ink_w=0.05 if inked else 0.028, ring=0.45,
                   # a SUBTLE sheen in the hair's own hue (a whitish band read as grey blotches on dark hair)
                   ring_t=(0.21, 0.25), ring_color=mix(mid, (1, 1, 1), 0.3), inner_lines=n_lines,
                   line_w=0.016 if inked else 0.012)


def smooth01(e0, e1, x):
    return float(smoothstep(e0, e1, x))


class Mapper:
    def __init__(self, F, B, frame, pp):
        if 'eye_L_bl' in pp:           # iris centres on the eye surface (from the VRM face mesh)
            eyeL, eyeR = np.array(pp['eye_L_bl']), np.array(pp['eye_R_bl'])
        else:
            eyeL, eyeR = np.array(B['J_Adj_L_FaceEye']), np.array(B['J_Adj_R_FaceEye'])
        self.eye = (eyeL + eyeR) / 2
        self.ipd = float(abs(eyeR[0] - eyeL[0]))
        self.F = F
        self.y0 = float(F.c[1])
        self.kz = (self.eye[1] - self.y0) / max(frame['d_eye_rel'], 0.1) if frame.get('depth_ok') else None

    def xz(self, a, b):
        return self.eye[0] + a * self.ipd, self.eye[2] + b * self.ipd

    def depth(self, d, layer):
        if self.kz is not None:
            return self.y0 + d * self.kz
        return self.y0 + {'fringe': 1.0, 'side': 0.35, 'ahoge': 0.2, 'back': -0.6, 'tail': -0.6}.get(layer, 0) * self.F.r[1]


EAR_ELEV = [None]      # set per head: the hairline arches over the ears at this elevation (deg)


def hairline_elev(th, back=-38.0, side=0.0):
    """hairline elevation (deg) around the head: front ~34, sides `side`, nape `back` (anime_hair scalp convention),
    arching up over the ear (azimuth ~80-125 deg) when EAR_ELEV is set"""
    a = abs(((th + 180) % 360) - 180)
    h = 34 + (side - 34) * (a / 90) ** 1.5 if a < 90 else side + (back - side) * ((a - 90) / 90) ** 1.5
    if EAR_ELEV[0] is not None:
        w = max(0.0, 1.0 - abs(a - 102.0) / 26.0)
        w = w * w * (3 - 2 * w)
        h = max(h, h + (EAR_ELEV[0] - h) * w)
    return h


# ------------------------------------------------------------------------------------------------ dome
class Dome:
    """the hair mass over the skull: head surface + a smooth direction-dependent volume offset"""

    def __init__(self, F, M, frame, sil):
        self.F = F
        self.o_top = float(np.clip(M.eye[2] + frame.get('crown_b', 2.0) * M.ipd - (F.c[2] + F.r[2]), 0.004, 0.08))
        # drawn hair half-width over the temples (between the brows and the top of the forehead), vs the 3D head
        rows = []
        for lay in ('fringe', 'side', 'back'):
            rows += sil.get(lay, [])
        band = [max(abs(r[1]), abs(r[2])) for r in rows if 0.6 <= r[0] <= 1.3]
        head_w = self._head_half_width(M.eye[2] + 0.95 * M.ipd)
        hw2 = float(np.median(band)) * M.ipd if band else head_w + 0.01
        self.o_side = float(np.clip(hw2 - head_w, 0.004, 0.05))
        # each side on its own (a swept cut carries more volume on the side it is swept to), over the temples AND
        # the upper head, where the drawn mass is widest
        top_b = frame.get('crown_b', 2.0)
        up = [r for r in rows if 0.6 <= r[0] <= top_b - 0.2]
        self.o_side_p = self.o_side_n = self.o_side
        if len(up) >= 3:
            rp = float(np.percentile([r[2] for r in up], 70)) * M.ipd
            rn = float(np.percentile([-r[1] for r in up], 70)) * M.ipd
            self.o_side_p = float(np.clip(rp + (M.eye[0] - F.c[0]) - head_w, 0.004, 0.06))
            self.o_side_n = float(np.clip(rn - (M.eye[0] - F.c[0]) - head_w, 0.004, 0.06))
        # the drawn crown's sideways shift (centre of the mass above the temples vs the head): the sweep
        cr = [r for r in rows if top_b - 0.9 <= r[0] <= top_b - 0.12]
        self.shift = float(np.mean([(r[1] + r[2]) / 2 for r in cr])) * M.ipd + (M.eye[0] - F.c[0]) if cr else 0.0
        self.o_front = 0.004
        self.o_back = max(self.o_side, 0.8 * self.o_top)
        # optional turnaround views (blender/live2d/turnaround.py): the side view's head + hair depth sets the back
        # volume (nose tip -> back of the hair vs nose tip -> back of the skull), the back view's hair width over the
        # temples the side volume
        if frame.get('tv_depth'):
            yf = F.bvh.ray_cast(Vector((F.c[0], F.c[1] + 1.0, M.eye[2] - 0.35 * M.ipd)), Vector((0, -1, 0)), 3.0)[0] if F.bvh else None
            yb = F.bvh.ray_cast(Vector((F.c[0], F.c[1] - 1.0, M.eye[2] + 0.8 * M.ipd)), Vector((0, 1, 0)), 3.0)[0] if F.bvh else None
            if yf is not None and yb is not None:
                self.o_back = float(np.clip(frame['tv_depth'] * M.ipd - (yf[1] - yb[1]), 0.004, 0.07))
        if frame.get('tv_back_width'):
            bw = [w for b, w in frame['tv_back_width'] if 0.6 <= b <= 1.3]
            if bw:
                o_s = float(np.clip(np.median(bw) * M.ipd - head_w, 0.004, 0.06))
                self.o_side_p = max(self.o_side_p, o_s) if hasattr(self, 'o_side_p') else o_s
                self.o_side_n = max(self.o_side_n, o_s) if hasattr(self, 'o_side_n') else o_s
                self.o_side = max(self.o_side, o_s)
        self.back_hairline = -38.0
        self.side_hairline = 0.0
        self.bvh = None
        print('DOME top %.4f side %.4f (+x %.4f, -x %.4f) back %.4f crown shift %+.4f (drawn half width %.4f, head %.4f)' % (
            self.o_top, self.o_side, self.o_side_p, self.o_side_n, self.o_back, self.shift, hw2, head_w))

    def _head_half_width(self, z):
        F = self.F
        xs = []
        for sgn in (-1, 1):
            hit = F.bvh.ray_cast(Vector((sgn * 1.0, F.c[1], z)), Vector((-sgn, 0, 0)), 2.0) if F.bvh else (None,)
            xs.append(abs(hit[0][0] - F.c[0]) if hit[0] is not None else F.r[0])
        return float(np.mean(xs))

    def offset(self, d):
        wt = smooth01(0.15, 0.85, d[2])
        h = np.array([d[0], d[1], 0.0]); n = np.linalg.norm(h) + 1e-9
        wf, ws, wb = max(h[1] / n, 0) ** 2, (h[0] / n) ** 2, max(-h[1] / n, 0) ** 2
        o_s = self.o_side_p if h[0] >= 0 else self.o_side_n
        oh = (self.o_front * wf + o_s * ws + self.o_back * wb) / (wf + ws + wb + 1e-9)
        # top_lean: a crown swept to one side stands higher there (fitted by silfit.fit_dome; 0 = symmetric)
        top = max(0.002, self.o_top + getattr(self, 'top_lean', 0.0) * float(d[0]))
        return oh * (1 - wt) + top * wt

    def point(self, th, ph, extra=0.0):
        d = self.F.sph(th, ph)
        p, n = self.F.root(th, ph, 0.0)
        return p + n * (self.offset(d) + extra), n

    def mesh(self, name='HairScalp', collection=None, dth=6.0, rings=22):
        """the dome as an object (UV: atlas column 3, v = 1 - t, t = 0 at the crown .. 1 at the hairline)"""
        bm = bmesh.new()
        uv = bm.loops.layers.uv.new('UVMap')
        col = bm.loops.layers.float_color.new('HairTone')
        ths = np.arange(-180, 180, dth)
        grid = []
        for th in ths:
            hl = hairline_elev(th, self.back_hairline, self.side_hairline)
            ring = []
            for k in range(rings + 1):
                t = k / rings
                ph = 89.0 - (89.0 - hl) * t
                p, _ = self.point(th, ph)
                ring.append((bm.verts.new(p), t))
            grid.append(ring)
        top = bm.verts.new(self.point(0, 90)[0])
        nth = len(ths)
        u = (NV_LOCK + 0.5) / (NV_LOCK + 1)
        for i in range(nth):
            a, b = grid[i], grid[(i + 1) % nth]
            f = bm.faces.new((top, b[0][0], a[0][0]))
            for lp in f.loops:
                lp[uv].uv = (u, 1.0); lp[col] = (0, 0, 0, 1)
            for k in range(rings):
                f = bm.faces.new((a[k][0], b[k][0], b[k + 1][0], a[k + 1][0]))
                for lp, t in zip(f.loops, (a[k][1], b[k][1], b[k + 1][1], a[k + 1][1])):
                    lp[uv].uv = (u, 1 - t); lp[col] = (t, 0, 0, 1)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        # outward normals: flip if the first face points toward the head centre
        f0 = bm.faces[len(bm.faces) // 2]
        if np.dot(np.array(f0.calc_center_median()) - self.F.c, np.array(f0.normal)) < 0:
            bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
        V = [np.array(v.co) for v in bm.verts]
        Fc = [[v.index for v in f.verts] for f in bm.faces]
        bm.verts.index_update()
        Fc = [[v.index for v in f.verts] for f in bm.faces]
        self.bvh = BVHTree.FromPolygons([Vector(v) for v in V], Fc)
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me); bm.free()
        o = bpy.data.objects.new(name, me)
        (collection or bpy.context.scene.collection).objects.link(o)
        for p in me.polygons:
            p.use_smooth = True
        return o

    def ray(self, x, z, front=True):
        if self.bvh is None:
            return None
        y0 = 5.0 if front else -5.0
        hit = self.bvh.ray_cast(Vector((x, y0, z)), Vector((0, -1 if front else 1, 0)), 10.0)
        if hit[0] is None:
            return None
        y = float(hit[0][1])
        # only the near half of the dome counts (a front ray under the front hairline would hit the dome's back)
        if (front and y < self.F.c[1] - 0.005) or (not front and y > self.F.c[1] + 0.005):
            return None
        return y


class Rays:
    """front / back surface depth of the head and of the body + outfit at (X, Z)"""

    def __init__(self, F, body):
        self.head, self.body = F.bvh, body

    @staticmethod
    def _cast(bvh, x, z, front=True):
        if bvh is None:
            return None
        y0 = 5.0 if front else -5.0
        hit = bvh.ray_cast(Vector((x, y0, z)), Vector((0, -1 if front else 1, 0)), 10.0)
        return None if hit[0] is None else float(hit[0][1])

    def front(self, x, z, body=False):
        return self._cast(self.body if body else self.head, x, z, True)

    def side(self, y, z, x_hint):
        """x of the head surface seen from the side of x_hint at depth y, height z"""
        if self.head is None:
            return None
        s = 1.0 if x_hint >= 0 else -1.0
        hit = self.head.ray_cast(Vector((s * 2.0, y, z)), Vector((-s, 0, 0)), 4.0)
        return None if hit[0] is None else float(hit[0][0])

    def back(self, x, z, body=False):
        return self._cast(self.body if body else self.head, x, z, False)


# ------------------------------------------------------------------------------------------------ locks
LAYER_LIFT = {'fringe': 0.0045, 'side': 0.003, 'ahoge': 0.006, 'back': 0.0025, 'tail': 0.003, 'fringe_fill': 0.0015}


def lock_guide(F, M, R, D, L, chin_z):
    """guide points of one Live2D lock (root -> tip), lying on what it is drawn over"""
    layer = L['layer']
    pts = np.array(L['pts'], float)
    n = len(pts)
    # the rig's parallax depth along the lock, as a straight fit (no zig-zag)
    t = np.linspace(0, 1, n)
    dfit = np.polyval(np.polyfit(t, pts[:, 2], 1), t) if n >= 3 else pts[:, 2]
    front_side = layer in ('fringe', 'side', 'ahoge', 'fringe_fill') or float(np.mean(pts[:, 2])) > 0.12
    lift = LAYER_LIFT.get(layer, 0.003)
    G = []
    for i, (a, b, _) in enumerate(pts):
        x, z = M.xz(a, b)
        ti = t[i]
        y = None
        yd = D.ray(x, z, front=front_side)
        if yd is not None:                                    # above the hairline: ON the dome
            # a drawn fringe rises off the forehead near its root (the swoop / volume at the parting)
            sw = 0.012 * max(0.0, 1.0 - 1.6 * ti) if layer == 'fringe' else 0.0
            y = yd + (lift + sw if front_side else -lift)
        elif L.get('front_hang') and z < chin_z + 0.03:        # over the chest in the picture
            yb = R.front(x, z, body=True)
            yh = R.front(x, z)
            y = max(v for v in (yb, yh, M.depth(dfit[i], layer)) if v is not None) + 0.012
        elif layer == 'side' and abs(a) < frame_face_half_w[0] - 0.04 and R.front(x, z) is not None:
            # drawn ACROSS the face outline (a face-framing lock over the cheek edge, Haru): in front of the cheek
            # there, as drawn
            y = R.front(x, z) + 0.004 + 0.003 * ti
        elif layer == 'side':
            # a side lock / sideburn hangs in front of the ear, beside the cheek: at the depth of the head's side
            # silhouette (where the face outline is in the front view), cleared sideways -- never across the cheek
            best = None
            for yy in np.linspace(F.c[1] - 0.01, F.c[1] + 0.85 * F.r[1], 14):
                sx = R.side(float(yy), z, x)
                if sx is not None and (best is None or abs(sx) > abs(best[0])):
                    best = (sx, float(yy))
            if best is not None:
                G.append(np.array([math.copysign(max(abs(x), abs(best[0]) + 0.006 + 0.004 * ti), x), best[1], z]))
            else:
                G.append(np.array([x, G[-1][1] if G else M.depth(dfit[i], layer), z]))
            continue
        elif front_side:                                      # over the face / temples
            yf = R.front(x, z)
            if yf is not None:
                y = yf + 0.005 + 0.006 * ti
            else:                                             # past the face outline: keep the lock's own depth
                y = G[-1][1] if G else M.depth(dfit[i], layer)
        else:                                                 # hanging beside / behind the head: the rig's depth
            y = M.depth(dfit[i], layer)
            if z < chin_z:
                ybb = R.back(x, z, body=True)
                if ybb is not None and abs(x) < 0.09:
                    y = min(y, ybb - 0.012)
        q = np.array([x, y, z])
        if front_side and yd is None and R.front(x, z) is None:
            # beside the face outline (a fringe / side lock sweeping out): clear the head SIDEWAYS, keeping its depth
            # (a nearest-surface push would fold it backwards around the cheek)
            sx = R.side(q[1], z, x)
            if sx is not None and abs(sx) + 0.006 + 0.004 * ti > abs(x):
                q[0] = math.copysign(abs(sx) + 0.006 + 0.004 * ti, x)
            G.append(q)
            continue
        # drawn side / back locks lie ON TOP of the invented rows (dome offset + a layer), never inside them
        vol = D.offset(unit(q - F.c)) + 0.006 if not front_side else 0.0
        G.append(F.push_out(q, 0.004 + 0.004 * ti + vol))
    G = np.array(G)
    if L.get('front_hang'):
        # over the chest: never step back into the collar on the way down (running max of the depth), smoothed
        G[:, 1] = np.maximum.accumulate(G[:, 1])
        G[1:-1, 1] = (G[:-2, 1] + 2 * G[1:-1, 1] + G[2:, 1]) / 4
    # the root: extend the lock backwards along its own direction and tuck the start under the dome surface, so it
    # grows out of the mass without a visible root cap or a hairpin bend
    d0 = unit(G[0] - G[min(2, len(G) - 1)])
    p1 = G[0] + d0 * 0.012
    p2 = G[0] + d0 * 0.024
    tuck = []
    for p in (p2, p1):
        dr = unit(p - F.c)
        th = math.degrees(math.atan2(dr[0], dr[1])); ph = math.degrees(math.asin(np.clip(dr[2], -1, 1)))
        s, _ = D.point(th, min(ph, 88.0), -0.003)
        tuck.append(s if np.linalg.norm(p - F.c) > np.linalg.norm(s - F.c) else p)
    return fair(F, np.vstack([np.array(tuck), G]))


def fair(F, G, max_turn=50.0, iters=3):
    """a fair guide: drop points that make a sharp turn (the ink hull shows a black wedge inside any hairpin), then
    a few Laplacian passes (ends fixed), then keep it off the head"""
    G = [np.asarray(p, float) for p in G]
    changed = True
    while changed and len(G) > 3:
        changed = False
        for i in range(1, len(G) - 1):
            a, b = unit(G[i] - G[i - 1]), unit(G[i + 1] - G[i])
            if math.degrees(math.acos(float(np.clip(np.dot(a, b), -1, 1)))) > max_turn:
                del G[i]; changed = True; break
    G = np.array(G)
    for _ in range(iters):
        G[1:-1] = 0.25 * G[:-2] + 0.5 * G[1:-1] + 0.25 * G[2:]
    return np.array([G[0]] + [F.push_out(p, 0.003) for p in G[1:]])


def lock_clump(F, M, R, D, L, rng, chin_z):
    layer = L['layer']
    G = lock_guide(F, M, R, D, L, chin_z)
    w = np.array(L['width'], float) * M.ipd
    # the lock's own width: the lower half of the drawn strip (the upper half merges into the mass)
    width = float(np.clip(np.median(w[len(w) // 2:]) * (1.35 if layer == 'fringe' else 2.0 if L.get('front_hang') else 1.25),
                          0.022 if layer in ('side', 'back') else 0.016, 0.075))
    seg = np.linalg.norm(np.diff(G, axis=0), axis=1).sum()
    chain = None
    if layer in ('fringe', 'fringe_fill'):
        chain = 'fringe'
    elif layer == 'side' or (layer == 'back' and L.get('front_hang')):
        chain = 'side_R' if L['tip'][0] > 0 else 'side_L'
    elif layer in ('back', 'tail') and seg > 0.08:
        chain = ('tail' if layer == 'tail' else 'back') + ('_R' if L['tip'][0] > 0.4 else '_L' if L['tip'][0] < -0.4 else '')
    if L.get('contour') is not None and len(w) >= 5 and layer in ('fringe', 'side', 'back', 'ahoge'):
        # the lock's OWN drawn contour (hair2d: its region between the drawn ink lines, widths across the spine):
        # the 3D width follows the drawn profile point by point -- broad body, the drawn taper, the drawn tip
        # robust profile: the body = the median of the lock's middle (the drawn strip there is clean), the TIP = the
        # measured widths of its last 40 % made monotone (running minimum toward the tip: a lock never widens again
        # at its end), the root = the body (roots merge into the mass; the spine's first point is often outside)
        n_ = len(w)
        body = float(np.median(w[int(0.25 * n_):max(int(0.65 * n_), int(0.25 * n_) + 1)]))
        fac = 1.2 if layer == 'fringe' else 1.9 if L.get('front_hang') else 1.2
        width_c = float(np.clip(body * fac, 0.016 if layer == 'fringe' else 0.022, 0.08))
        prof = np.minimum(w / max(body, 1e-6), 1.0)
        k0 = int(0.6 * n_)
        prof[:k0] = 1.0
        tail = np.minimum.accumulate(prof[k0:])
        tail[-1] = min(tail[-1], 0.08)                           # a point at the tip
        prof[k0:] = tail
        wm = np.clip(prof, 0.06, 1.0)
        nt = int(L.get('tips_n', 1) or 1)
        return Clump(G, width=width_c, thick=0.24, shape='flame', tip_start=0.9, tip_curve=1.0,
                     root_w=0.9, belly=0.0, ridge=0.35, wrap=0.18, tips=nt, tip_spread=0.35 if nt > 1 else 0.5,
                     split=0.72, twist=float(rng.uniform(-0.2, 0.2)), wave=width_c * 0.06, wave_freq=0.7,
                     wave_phase=float(rng.uniform(0, 6.28)), variant=int(rng.integers(0, NV_LOCK - 1)), layer=layer,
                     chain=chain, thick_tip=0.3, width_mul=wm)
    # a tapered, pointed ribbon with thickness: broad root, long straight-to-concave wedge into a needle tip, a gentle
    # S (in-plane wave) and a little twist -- not a slab
    # drawn fringes are SOLID masses ending in points: broad body, pointed tip (no forehead between the strands until
    # the tips); other drawn locks taper earlier
    return Clump(G, width=width, thick=0.24, shape='flame', tip_start=0.6 if layer in ('fringe', 'fringe_fill') else 0.35,
                 tip_curve=0.95 if layer == 'fringe' else 1.2,        # fringe: straight-sided pointed strand tips (a fuller
                 # convex tip read as a heavy blunt bowl hanging over the eyes)
                 root_w=0.85, belly=0.08, ridge=0.35, wrap=0.18, tips=1,
                 twist=float(rng.uniform(-0.25, 0.25)), wave=width * 0.1, wave_freq=0.7,
                 wave_phase=float(rng.uniform(0, 6.28)),
                 variant=int(rng.integers(0, NV_LOCK - 1)), layer=layer,
                 chain=chain, thick_tip=0.3)


def drill_coils(G, w, curls, chain, rng, bulge=None):
    """drill / ringlet curls as an anime artist draws them and a Blender artist would model them: ONE clean round tube
    (closed elliptic section, anime_hair Clump.round_back) down the drawn tail axis, smooth taper from the tie to a
    soft point, a rounded swell per drawn curl with a waist between two, the axis smoothed (the drawn axis zig-zags
    with the curls; a tube bent that tightly folds into knots) and wound as one gentle coil, the round section
    twisted once per curl so its two ink edges wind round it as the drawn spiral lines -- no helix of separate coils,
    no cone stack."""
    G = hk.catmull(np.asarray(G, float), 48)
    # the drawn tail axis zig-zags with the drawn curls (their tips / valleys): a tube bent that tightly folds into
    # knots, so the axis is smoothed first (the curls are the tube's swell, not the axis' kinks); ends kept
    kx = np.exp(-0.5 * (np.arange(-15, 16) / 5.0) ** 2); kx /= kx.sum()     # Gaussian (sigma 5), edges padded
    Gp = np.concatenate([np.repeat(G[:1], 15, 0), G, np.repeat(G[-1:], 15, 0)])
    Gs = np.stack([np.convolve(Gp[:, k], kx, mode='valid') for k in range(3)], 1)
    Gs[0] = G[0]                                          # the tie stays where it is
    G = Gs
    turns = max(1.0, float(curls))
    n = int(np.clip(34 * turns, 70, 200))
    A = hk.catmull(G, n)
    t = np.linspace(0, 1, n)
    T = np.gradient(A, axis=0)
    T /= np.linalg.norm(T, axis=1, keepdims=True) + 1e-9
    s0 = np.cross(T[0], [0, 0, 1.0])
    if np.linalg.norm(s0) < 1e-3:
        s0 = np.array([1.0, 0, 0])
    S = np.zeros_like(A); U = np.zeros_like(A)
    s = s0 / np.linalg.norm(s0)
    for i in range(n):                                    # parallel transport: no flips along a bent tail
        s = s - T[i] * float(np.dot(s, T[i])); s /= np.linalg.norm(s) + 1e-9
        S[i] = s; U[i] = np.cross(T[i], s)
    ease = np.clip((t - 0.05) / 0.2, 0, 1); ease = ease * ease * (3 - 2 * ease)
    ph = 2 * math.pi * turns * np.clip((t - 0.1) / 0.9, 0, 1)
    rh = float(np.clip(w * 0.16, 0.004, 0.014)) * ease * (1 - 0.5 * t)     # the axis' own coil (the ringlet's wind)
    A = A + (np.cos(ph)[:, None] * S + np.sin(ph)[:, None] * U) * rh[:, None]
    # each drawn curl a rounded swell with a clear waist between two (the stacked-curl silhouette), smooth -- sin^4
    swell = 0.78 + 0.5 * ease * np.sin(np.clip((t - 0.1) / 0.9, 0, 1) * math.pi * turns) ** 4
    wm = (0.62 + 0.38 * ease) * (1.0 - 0.35 * t) * swell
    width = float(np.clip(w * 1.05, 0.03, 0.095))
    return [Clump(A, width=width, thick=1.0, shape='flame', tip_start=0.82, tip_curve=0.8, root_w=0.8, belly=0.0,
                  ridge=0.0, wrap=0.0, twist=2 * math.pi * turns, variant=NOTIP_VARIANT, layer='tail', chain=chain,
                  rings=int(np.clip(n * 1.4, 110, 280)), width_mul=wm, keep_normals=True, round_back=True,
                  thick_tip=0.6)]


def tail_bundle(F, M, R, D, L, rng, chin_z, n=5):
    """a gathered tail: the Live2D tail guide + clumps around it. Drawn drill / ringlet curls become wide ribbon locks
    TWISTED along the tail (one turn per drawn bulge): a spiral band, not a bundle of wires"""
    base = lock_clump(F, M, R, D, L, rng, chin_z)
    G = base.guide
    curls = int(L.get('curls') or 0)
    if curls:
        G = hk.catmull(G, 40)
        w = float(np.clip(np.percentile(np.array(L['width'], float) * M.ipd, 60), 0.03, 0.09))
        # a side tail drawn beside the face (its outer edge past the face outline in the front picture) must peek out
        # beside the neck / cheek from the front in 3D too: its axis at least at the head's half width there
        P2 = np.array(L['pts'], float)
        w2 = np.array(L['width'], float)
        outer = float(np.max(np.abs(P2[:, 0]) + 0.5 * w2[:len(P2)])) if len(w2) >= len(P2) else float(np.max(np.abs(P2[:, 0])))
        if outer > frame_face_half_w[0]:
            G = G.copy()
            for i in range(len(G)):
                if G[i][2] > F.c[2] + 0.02:
                    continue
                hw = D._head_half_width(float(G[i][2])) if G[i][2] > chin_z else 0.06
                need = hw + 0.35 * w
                dx = G[i][0] - F.c[0]
                if abs(dx) < need:
                    k = float(np.clip((F.c[2] + 0.02 - G[i][2]) / 0.05, 0, 1))       # ease in below the tie
                    k = k * k * (3 - 2 * k)                                          # (a kink would crumple the ribbon)
                    G[i][0] = F.c[0] + math.copysign(abs(dx) + (need - abs(dx)) * k, dx if abs(dx) > 1e-4 else 1.0)
        return drill_coils(G, w, curls, base.chain, rng)
    C = [base]
    T = np.gradient(G, axis=0)
    T /= np.linalg.norm(T, axis=1, keepdims=True) + 1e-9
    for k in range(n):
        ang = 2 * math.pi * k / n
        off = []
        for i in range(len(G)):
            t = i / (len(G) - 1)
            s = unit(np.cross(T[i], [0, 0, 1.0])) if abs(T[i][2]) < 0.95 else np.array([1.0, 0, 0])
            u = unit(np.cross(s, T[i]))
            r = base.width * 0.35 * math.sin(math.pi * min(1.0, t * 1.2 + 0.1))
            off.append(G[i] + (s * math.cos(ang) + u * math.sin(ang)) * r)
        C.append(Clump(np.array(off), width=base.width * rng.uniform(0.75, 0.9), thick=0.32, shape='flame',
                       tip_start=0.5, root_w=0.9, ridge=0.45, wrap=0.22, variant=int(rng.integers(0, NV_LOCK)),
                       layer='tail', chain=base.chain, wave=0.004, wave_freq=1.0, wave_phase=rng.uniform(0, 6)))
    return C


def settle_radial(P, c, start):
    """the part of a lock hanging below the dome: its horizontal distance from the head axis never shrinks going down
    and has no bumps (ears/collars pushing single points out made folded, dark-shaded kinks at the temples)"""
    P = np.array(P, float)
    if len(P) - start < 2:
        return P
    h = P[:, :2] - c[:2]
    r = np.linalg.norm(h, axis=1) + 1e-9
    d = h / r[:, None]
    rs = r.copy()
    for _ in range(3):
        rs[start:-1] = 0.25 * rs[start - 1:-2] + 0.5 * rs[start:-1] + 0.25 * rs[start + 1:]
        rs[-1] = 0.5 * rs[-1] + 0.5 * rs[-2]
        rs[start - 1:] = np.maximum.accumulate(rs[start - 1:])
        rs = np.maximum(rs, np.minimum(r, rs + 0.004))  # never sink more than 4 mm into what push_out asked for
    # directions: smooth too (constant azimuth below the dome)
    d[start:] = d[start - 1]
    P[:, :2] = c[:2] + d * rs[:, None]
    return P


UNDER_VARIANT = 2       # atlas column painted a shade darker: inner / under-layer locks
TIP_VARIANT, NOTIP_VARIANT = 0, 1   # column 1 is repainted without the tip colour (locks ending above the chin)


def back_rows(F, M, D, frame, rng, covered, sweep=0.0, R=None, sil_rows=None):
    """'down' hair: the crown, back and the sides not drawn in Live2D, as FOUR staggered depth rows of tapered pointed
    locks: the top rows are swept in the drawn direction (`sweep`, deg of azimuth drift at the front, read from the
    drawn fringe tangents) and lifted off the dome for volume, the lowest row is the darker under-layer that shows
    between the tips. `covered` = azimuth ranges (deg) already covered by drawn side locks."""
    C = []
    z_end = M.eye[2] + frame.get('back_len', frame['chin_b'] - 0.2) * M.ipd
    z_end = float(np.clip(z_end, F.c[2] - F.r[2] * 3.4, F.c[2] - F.r[2] * 0.95))
    long_ = z_end < F.c[2] - F.r[2] * 1.6
    # (start elevation, azimuth step, width, lift at mid-length, shorten, sweep share)
    rows = ((80.0, 30.0, 0.075, 0.011, 0.07, 1.0), (60.0, 24.0, 0.072, 0.008, 0.045, 0.8),
            (38.0, 20.0, 0.068, 0.005, 0.02, 0.5), (16.0, 17.0, 0.055, 0.002, -0.01, 0.2))
    tips = frame.get('tv_back_tips')                 # turnaround back view: tips along the back hem
    for row, (ph0, dth, wd, lift, shorten, sw) in enumerate(rows):
        if tips and row >= 2:
            dth = float(np.clip(180.0 / max(tips, 1), 12.0, 30.0))
            wd = wd * dth / 18.0
        for th in np.arange(58.0 + (row % 2) * dth / 2, 303.0, dth):
            th2 = th + jit(rng, 2.5)
            a = abs(((th2 + 180) % 360) - 180)
            if row >= 2 and any(lo <= a <= hi for lo, hi in covered):
                continue
            ze = z_end + shorten + jit(rng, 0.012) + (0.02 if a < 105 else 0.0)
            pts = []
            phs = np.linspace(ph0 + 6, max(ph0 - 34, -5), 7)
            for k, ph in enumerate(phs):
                s_ = k / (len(phs) - 1)
                # sweep: azimuth drift along the lock (world-x drift: + at the front, - at the back)
                thk = th2 + sweep * sw * s_ * math.cos(math.radians(th2))
                # lifted off the dome in the middle (volume, visible layers), roots tucked under it
                ex = -0.003 if ph >= ph0 + 3 else lift * math.sin(math.pi * min(1.0, s_ * 1.1))
                pts.append(D.point(thk, float(ph), ex)[0])
            last = pts[-1]
            steps = 6
            for k in range(1, steps + 1):
                zz = last[2] + (ze - last[2]) * k / steps
                if zz >= last[2]:
                    continue
                p = F.push_out(np.array([last[0], last[1], zz]), 0.006 + D.offset(unit(last - F.c)) * 0.7 + 0.002 * (3 - row))
                if R is not None and p[1] < F.c[1]:
                    # lie ON the hood / collar / back, never through it
                    yb = R.back(float(p[0]), float(p[2]), body=True)
                    if yb is not None and yb < F.c[1] and p[1] > yb - 0.008 - 0.002 * (3 - row):
                        p[1] = yb - 0.008 - 0.002 * (3 - row)
                pts.append(p)
            if len(pts) < 4:
                continue
            pts = settle_radial(np.array(pts), F.c, 7)
            if sil_rows and abs(math.sin(math.radians(th2))) > 0.35:
                # at the sides the hanging hair reaches the drawn silhouette (the mass framing the face), per height
                sgn = 1.0 if math.sin(math.radians(th2)) > 0 else -1.0
                for k in range(len(pts)):
                    b = (pts[k][2] - M.eye[2]) / M.ipd
                    near = [r for r in sil_rows if abs(r[0] - b) < 0.2]
                    if not near:
                        continue
                    hw = float(np.median([(r[2] if sgn > 0 else -r[1]) for r in near])) * M.ipd - 0.008
                    xw = M.eye[0] + sgn * hw
                    reach = abs(math.sin(math.radians(th2))) ** 2          # full at 90 deg, fading toward front / back
                    if sgn * (xw - pts[k][0]) > 0:
                        pts[k][0] += (xw - pts[k][0]) * reach
            under = row == 3
            C.append(Clump(pts, width=wd * rng.uniform(0.9, 1.1), thick=0.22, shape='flame', tip_start=0.3,
                           tip_curve=1.25, root_w=0.8, belly=0.08, ridge=0.35, wrap=0.2,
                           twist=float(rng.uniform(-0.35, 0.35)), wave=wd * 0.12, wave_freq=0.8,
                           wave_phase=float(rng.uniform(0, 6.28)),
                           variant=UNDER_VARIANT if under else int(rng.integers(0, NV_LOCK - 1)), layer='back',
                           chain='back' if long_ and row >= 2 else None))
    return C


def flow_locks(F, D, rng, ties):
    """tied styles: a few flat locks drawing the flow lines over the dome toward the tie(s)"""
    from anime_hair.styles import surface_path
    C = []
    for th in np.arange(-150, 180, 42):
        a = abs(((th + 180) % 360) - 180)
        ph = hairline_elev(th, D.back_hairline, D.side_hairline) + 14
        if a < 50:
            continue
        d = F.sph(th + jit(rng, 2), ph)
        tie = min(ties, key=lambda tp: np.linalg.norm(unit(tp - F.c) - d))
        if np.linalg.norm(unit(tie - F.c) - d) < 0.3:
            continue
        G = surface_path(F, d, unit(tie - F.c), 12, 0.0)
        G = np.array([p + unit(p - F.c) * (D.offset(unit(p - F.c)) + 0.002) for p in G])
        C.append(Clump(G, width=0.06, thick=0.1, shape='blunt', root_w=0.3, variant=int(rng.integers(0, NV_LOCK)),
                       layer='crown', ridge=0.2, wrap=0.3, belly=0.02))
    return C


def _resample(P, n):
    P = np.asarray(P, float)
    seg = np.linalg.norm(np.diff(P[:, :2], axis=0), axis=1)
    cum = np.r_[0, np.cumsum(seg)]
    if cum[-1] <= 1e-9:
        return np.repeat(P[:1], n, 0)
    s_ = np.linspace(0, cum[-1], n)
    return np.stack([np.interp(s_, cum, P[:, k]) for k in range(P.shape[1])], 1)


def fringe_fill(F, M, R, D, locks, rng, chin_z, spacing=0.22, env=None):
    """the SOLID mass of a drawn fringe under its pointed locks: strips every `spacing` IPD across the whole fringe,
    each following the two drawn locks around it (interpolated), down to the drawn fringe's solid line between the
    tips (`env`, hair2d.fringe_envelope) -- the forehead only shows where the drawing shows it"""
    fr = sorted([L for L in locks if L['layer'] == 'fringe' and len(L['pts']) >= 3], key=lambda L: L['tip'][0])
    if len(fr) < 2:
        return []
    n = 16
    polys = [_resample(L['pts'], n) for L in fr]
    tx = np.array([L['tip'][0] for L in fr])
    ea = np.array([e[0] for e in env]) if env else None
    eb = np.array([e[1] for e in env]) if env else None
    if ea is not None:
        o = np.argsort(ea); ea, eb = ea[o], eb[o]
    C = []
    for x in np.arange(tx.min() + spacing * 0.5, tx.max(), spacing):
        j = int(np.clip(np.searchsorted(tx, x), 1, len(fr) - 1))
        if tx[j] - tx[j - 1] > 1.4:                   # a real gap in the drawing (parting): keep it open
            continue
        w = (x - tx[j - 1]) / max(tx[j] - tx[j - 1], 1e-6)
        mid = polys[j - 1] * (1 - w) + polys[j] * w
        if ea is not None and ea[0] - 0.1 <= x <= ea[-1] + 0.1:
            tb = float(np.interp(x, tx, [L['tip'][1] for L in fr]))
            e_ = float(np.interp(x, ea, eb))
            # past the valley line, part way toward the neighbouring tips (a centre parting stays a small notch, not a V)
            bv = min(e_, e_ + 0.25 * (tb - e_)) - 0.05
            below = np.nonzero(mid[:, 1] < bv)[0]
            k = int(below[0]) + 1 if len(below) else n
            k = max(3, min(n, k))
        else:
            k = max(3, int(n * 0.8))
        L = {'layer': 'fringe_fill', 'pts': mid[:k].tolist(), 'width': [spacing * 1.35] * k, 'tip': mid[k - 1, :2].tolist()}
        c = lock_clump(F, M, R, D, L, rng, chin_z)
        c.layer = 'fringe_fill'
        # the fill is the mass BETWEEN the drawn locks: it ends in a soft point just past the valley line (a blunt end
        # read as a straight-cut bowl fringe in every review), the drawn locks' tips hang below it
        c.shape = 'flame'; c.tip_start = 0.72; c.tip_curve = 0.7; c.width_mul = None
        # (was blunt: the solid mass ended ON the valley line with no extra teeth; a
        c.wave = 0.0                                 # zig-zag of fill points read as a sawtooth cut in review)
        C.append(c)
    return C


def forehead_cover(F, M, R, D, C, locks, rng, chin_z, env, step=0.1):
    """coverage repair: the drawing hides the forehead above the fringe's valley line (`env`), so every point of the
    front view between that line and the hairline must lie under some lock. Project every front clump (guide + half
    width) into the drawing's IPD frame, find the columns still showing skin, and close each with a blunt fill strip
    from above the hairline down to the valley line (depth taken from the nearest drawn fringe point)"""
    if not env:
        return []
    ea = np.array([e[0] for e in env]); eb = np.array([e[1] for e in env])
    o = np.argsort(ea); ea, eb = ea[o], eb[o]
    segs = []
    for c in C:
        G = np.asarray(c.guide, float)
        if G[:, 1].min() > F.c[1] - 0.45 * F.r[1]:          # not in front of the face
            continue
        fr = G[:, 1] < F.c[1] - 0.2 * F.r[1]
        a_ = (G[:, 0] - M.eye[0]) / M.ipd; b_ = (G[:, 2] - M.eye[2]) / M.ipd
        hw = 0.42 * c.width / M.ipd
        for i in range(len(G) - 1):
            if fr[i] or fr[i + 1]:
                # a ribbon lies on the head: its width runs along the surface across the guide, so a lock at the
                # temple is seen edge-on from the front -- its projected half width shrinks with that direction's
                # front-view (x, z) share
                n_ = G[i] - np.asarray(F.c, float); n_ /= np.linalg.norm(n_) + 1e-9
                lat = np.cross(n_, G[i + 1] - G[i]); lat /= np.linalg.norm(lat) + 1e-9
                segs.append((a_[i], b_[i], a_[i + 1], b_[i + 1], hw * float(np.hypot(lat[0], lat[2]))))
    if not segs:
        return []
    S = np.array(segs)
    fpts = np.array([p for L in locks if L['layer'] == 'fringe' for p in L['pts']], float)
    out = []
    for a in np.arange(ea[0] + step / 2, ea[-1], step):
        e = float(np.interp(a, ea, eb))
        bs = np.arange(e + 0.12, 1.15, step)
        if not len(bs):
            continue
        P = np.stack([np.full_like(bs, a), bs], 1)
        A0 = S[:, None, 0:2]; A1 = S[:, None, 2:4]
        d = A1 - A0
        tt = np.clip(((P[None] - A0) * d).sum(-1) / np.maximum((d * d).sum(-1), 1e-9), 0, 1)
        dist = np.linalg.norm(P[None] - (A0 + tt[..., None] * d), axis=-1)
        cov = (dist < S[:, 4:5]).any(0)
        if (~cov).sum() >= 2:
            out.append((a, e))
    C2 = []
    for a, e in out:
        if len(fpts):
            k = np.argmin(np.hypot(fpts[:, 0] - a, fpts[:, 1] - (e + 0.5)))
            dd = float(fpts[k, 2])
        else:
            dd = 0.0
        pts = [[a, b_, dd] for b_ in np.linspace(1.5, e, 6)]
        L = {'layer': 'fringe_fill', 'pts': pts, 'width': [0.34] * 6, 'tip': [a, e]}
        c = lock_clump(F, M, R, D, L, rng, chin_z)
        c.layer = 'fringe_fill'; c.shape = 'flame'; c.tip_start = 0.72; c.tip_curve = 0.7; c.wave = 0.0; c.width_mul = None
        C2.append(c)
    if out:
        print('COVER forehead: %d fill strips at a = %s' % (len(out), [round(a, 2) for a, _ in out]))
    return C2


def fit_dome_to_turns(F, M, D, frame, lock_margin=0.006):
    """The Live2D model's own +-30 deg head turns are the only turnaround a Live2D model has: on the far side of the
    turned silhouette the artist drew the side / back of the hair mass. Fit the dome's far-side volume (o_side of that
    side, and the shared o_back) so the 3D hair mass, turned the same way, has the drawn far-side extent (least
    squares over the height bands between the eyes and the crown); the front width keeps a say (the fitted side
    volume is blended half-and-half with the front-view value)."""
    T = frame.get('turns') or {}
    crown_b = frame.get('crown_b', 2.2)
    obs = {'p': [], 'n': []}
    for key in ('30', '-30'):
        t = T.get(key)
        if not t or not t.get('bands') or abs(t['shift']) < 0.05:
            continue
        shift = t['shift']
        side = 'n' if shift > 0 else 'p'           # the far side swings toward -x when the eyes move +x
        for b, lo, hi in t['bands']:
            if 0.4 <= b <= crown_b - 0.35:
                obs[side].append((shift, b, lo if shift > 0 else hi))
    if len(obs['p']) + len(obs['n']) < 3:
        return None
    ths = np.arange(-180, 180, 5.0)
    phs = np.arange(-40, 89, 4.0)
    grid = [(float(th), float(ph)) for th in ths for ph in phs if ph >= hairline_elev(th, D.back_hairline, D.side_hairline)]

    def errs(side):
        P = np.array([D.point(th, ph)[0] for th, ph in grid])
        e = []
        for shift, b, far in obs[side]:
            ye = M.eye[1] - F.c[1]
            # a Live2D 'AngleX 30' is a cheated 2.5D turn: the effective rotation is the one that moves the eyes as far
            # as the drawing does (eye depth in front of the rotation centre)
            a_eff = math.asin(float(np.clip(abs(shift) * M.ipd / max(abs(ye), 1e-3), 0.05, 0.9)))
            a = a_eff * (-1.0 if shift > 0 else 1.0) * (1.0 if ye > 0 else -1.0)
            ca, sa = math.cos(a), math.sin(a)
            X = F.c[0] + (P[:, 0] - F.c[0]) * ca - (P[:, 1] - F.c[1]) * sa
            ex = F.c[0] + (M.eye[0] - F.c[0]) * ca - (M.eye[1] - F.c[1]) * sa
            sel = np.abs(P[:, 2] - (M.eye[2] + b * M.ipd)) < 0.12 * M.ipd
            if sel.sum() < 3:
                continue
            pred = ((X[sel].min() - lock_margin) - ex) / M.ipd if shift > 0 else ((X[sel].max() + lock_margin) - ex) / M.ipd
            e.append(pred - far)
        return e
    before = {k: errs(k) for k in ('p', 'n')}
    o_front = {'p': D.o_side_p, 'n': D.o_side_n}
    best = None
    for ob in (D.o_back,):                       # the back is barely visible at a ~20 deg turn: keep it
        D.o_back = float(ob)
        tot, fit = 0.0, {}
        for side in ('p', 'n'):
            if not obs[side]:
                fit[side] = o_front[side]
                continue
            cands = []
            for os_ in np.arange(0.004, 0.0801, 0.004):
                setattr(D, 'o_side_' + side, float(os_))
                e = errs(side)
                cands.append((float(np.mean(np.square(e))) if e else 1e9, float(os_)))
            m_, os_best = min(cands)
            tot += m_; fit[side] = os_best
            setattr(D, 'o_side_' + side, o_front[side])
        if best is None or tot < best[0]:
            best = (tot, float(ob), fit)
    _, D.o_back, fit = best
    for side in ('p', 'n'):
        # the turns may add volume the front width can't show, never take it away (a Live2D turn compresses its far
        # side; narrowing to it made the 3D mass read smaller than the drawing from the front)
        setattr(D, 'o_side_' + side, max(o_front[side], 0.5 * o_front[side] + 0.5 * fit[side]))
    after = {k: errs(k) for k in ('p', 'n')}
    fmt = lambda E: ', '.join(f"{k} {np.mean(v):+.2f}" for k, v in E.items() if v)
    print('TURNFIT o_back %.4f, side +x %.4f -x %.4f (front %.4f / %.4f); far-side signed error before [%s] after [%s] IPD'
          % (D.o_back, D.o_side_p, D.o_side_n, o_front['p'], o_front['n'], fmt(before), fmt(after)))
    return D.o_back


def drawn_sweep(F, M, locks):
    """the drawn hair's sweep: median sideways drift (deg) of the fringe locks between their root and 40 % down"""
    ang = []
    for L in locks:
        if L['layer'] != 'fringe' or len(L['pts']) < 4:
            continue
        P = np.array(L['pts'], float)
        k = max(1, int(len(P) * 0.4))
        x0, z0 = M.xz(P[0][0], P[0][1]); x1, z1 = M.xz(P[k][0], P[k][1])
        if z0 - z1 > 1e-4:
            ang.append(math.degrees(math.atan2(x1 - x0, z0 - z1)))
    sw_f = float(np.median(ang)) if ang else 0.0
    # the crown's drawn sideways shift says more than the fringe tangents (fringes splay both ways)
    sh = getattr(D_REF[0], 'shift', 0.0) if D_REF[0] is not None else 0.0
    sw_s = math.degrees(math.asin(float(np.clip(sh / max(F.r[0], 1e-3), -0.9, 0.9)))) * 2.2
    sw = float(np.clip(sw_s + 0.5 * sw_f, -40, 40))
    print('SWEEP %.1f deg (crown shift %.1f, fringe %.1f from %d locks)' % (sw, sw_s, sw_f, len(ang)))
    return sw


D_REF = [None]
frame_face_half_w = [9.0]


def body_bvh():
    dg = bpy.context.evaluated_depsgraph_get()
    objs = [o for o in bpy.data.objects if o.type == 'MESH' and (o.name.split('.')[0] == 'Body' or o.name.startswith('Outfit'))]
    if not objs:
        return None
    V, Fc = [], []
    for o in objs:
        ev = o.evaluated_get(dg); me = ev.to_mesh()
        Mw = np.array(o.matrix_world)
        P = np.zeros(len(me.vertices) * 3); me.vertices.foreach_get('co', P)
        P = P.reshape(-1, 3) @ Mw[:3, :3].T + Mw[:3, 3]
        base = len(V); V += P.tolist()
        Fc += [[base + i for i in p.vertices] for p in me.polygons]
        ev.to_mesh_clear()
    return BVHTree.FromPolygons([Vector(v) for v in V], Fc)


def repaint_notip_column(tex_path, pal):
    """atlas column NOTIP_VARIANT = the same lock art (same seed: same lines / band) without the tip colour"""
    import copy
    p2 = copy.copy(pal)
    p2.tip = pal.mid
    p2.root = pal.mid                                # no dark root band (each drill coil starts a new clump)
    p2.root_occ = 0.0
    img = bpy.data.images.load(tex_path, check_existing=False)
    W, H = img.size
    im = np.array(img.pixels[:], np.float32).reshape(H, W, 4)
    alt = hk.hair_texture_clean(p2, None, size=W)
    u0, u1 = int(W * NOTIP_VARIANT / (NV_LOCK + 1)), int(W * (NOTIP_VARIANT + 1) / (NV_LOCK + 1))
    im[:, u0:u1] = alt[:, u0:u1]
    img.pixels.foreach_set(im.reshape(-1))
    img.filepath_raw = tex_path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)


def paint_dome_column(tex_path, pal):
    """atlas column 3 = the dome: the lock gradient without edge ink / form band, the ring around the head"""
    img = bpy.data.images.load(tex_path, check_existing=False)
    W, H = img.size
    im = np.array(img.pixels[:], np.float32).reshape(H, W, 4)      # Blender rows bottom-up
    x0 = int(W * NV_LOCK / (NV_LOCK + 1))
    t = 1 - (np.arange(H) + 0.5) / H                                 # t = 0 (root) at the top of the image
    C = lambda c: np.array(c, np.float32)[None, :]
    # the dome is the mass UNDER the locks (it shows in the gaps between lifted / swept locks): one flat tone a shade
    # under the lock colour, no dark root blotches
    col = np.repeat(C(pal.mid) * 0.86, len(t), 0)
    xs = (np.arange(W - x0) + 0.5) / (W - x0)
    out = np.repeat(col[:, None, :], W - x0, 1)
    if pal.ring_color is not None:
        pal_ring = 0.0                               # a hint only: bright bands on the dome read as a bald stripe
        zz = 0.012 * np.abs(((xs * 9.0) % 2.0) - 1.0)[None, :]
        r0, r1 = 0.3, 0.37
        band = (np.abs(t[:, None] - (r0 + r1) / 2 - zz) < (r1 - r0) / 2).astype(np.float32)
        out = out * (1 - band[..., None] * pal_ring) + C(pal.ring_color)[None] * band[..., None] * pal_ring
    im[:, x0:, :3] = out
    im[:, x0:, 3] = 1
    # the under-layer column: the same lock art a shade darker and cooler (inner rows read as depth)
    u0, u1 = int(W * UNDER_VARIANT / (NV_LOCK + 1)), int(W * (UNDER_VARIANT + 1) / (NV_LOCK + 1))
    im[:, u0:u1, :3] = im[:, u0:u1, :3] * np.array([0.86, 0.86, 0.9], np.float32)
    img.pixels.foreach_set(im.reshape(-1))
    img.filepath_raw = tex_path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)


def pipeline(argv):
    """the hair build as a generator: each `yield` is a checkpoint (title) -- the headless run just drains it, the
    live window run (opt live=1) advances it on a timer with the viewport orbiting the head and previews of the locks"""
    vrm, locks_path, params_path, out = argv[:4]
    opt = fit.parse_opts(argv[4:])
    os.makedirs(out, exist_ok=True)
    spec = json.load(open(locks_path, encoding='utf-8'))
    pp = json.load(open(params_path, encoding='utf-8'))
    pp.setdefault('strand_lines', spec.get('frame', {}).get('strand_lines', 0.0))
    arm, B = fit.load_vrm(vrm)
    heads = [o for o in bpy.data.objects if o.type == 'MESH' and o.name.split('.')[0] in ('Face', 'Body')]
    F = fit.head_frame(B, heads)
    LIVE_HEAD[0] = F.c
    yield 'Loaded the converted avatar (face + outfit from the Live2D art)'
    frame = spec['frame']
    M = Mapper(F, B, frame, pp)
    D = Dome(F, M, frame, spec.get('silhouette', {}))
    D_REF[0] = D
    frame_face_half_w[0] = float(frame.get('face_half_w', 9.0))
    fit_dome_to_turns(F, M, D, frame)
    tied = frame.get('style', 'down') != 'down'
    # anatomical hairline: the sideburns reach about eye level, the nape about mouth level (the ellipsoid's
    # equator sits above the ears, so a fixed elevation left the back of the head bald under tied styles)
    chin_z0 = M.eye[2] + frame['chin_b'] * M.ipd
    elev = lambda z: float(np.degrees(np.arcsin(np.clip((z - F.c[2]) / F.r[2], -0.97, 0.97))))
    # (tied styles: the temples are covered down to about the eye line, the ears stay free through EAR_ELEV)
    D.side_hairline = float(np.clip(elev(M.eye[2] + (0.0 if tied else 0.14) * (M.eye[2] - chin_z0)), -30.0, 0.0))
    D.back_hairline = float(np.clip(elev(M.eye[2] - (0.8 if tied else 0.6) * (M.eye[2] - chin_z0)), -82.0, -38.0))
    if tied:
        EAR_ELEV[0] = float(np.clip(elev(M.eye[2] + 0.3 * (M.eye[2] - chin_z0)), -10.0, 20.0))  # ears stay visible
    print('HAIRLINE side %.1f back %.1f ear %s deg' % (D.side_hairline, D.back_hairline, EAR_ELEV[0]))
    if opt.get('silfit', '1') != '0':
        try:
            from live2d import silfit
            silfit.fit_dome(F, M, D, frame, out, log=print)
        except Exception as e:
            print('SILFIT dome failed: %s: %s' % (type(e).__name__, e))
    D.mesh('HairDomeProbe')                                  # BVH for lock placement (the real one is built below)
    probe = bpy.data.objects['HairDomeProbe']
    if LIVE[0]:
        probe.name = 'Preview_Dome'; _preview_mat(probe, pp['hair'])
        yield "Hair volume: dome fitted to the drawn silhouette and the model's own head turns"
    else:
        bpy.data.objects.remove(probe, do_unlink=True)
    print('MAP ipd %.4f kz %s eye %s' % (M.ipd, M.kz, M.eye.round(3).tolist()))
    rng = np.random.default_rng(int(opt.get('seed', 7)))
    R = Rays(F, body_bvh())
    chin_z = M.eye[2] + frame['chin_b'] * M.ipd
    C, ties, covered = [], [], []
    skip = set(filter(None, opt.get('skip', '').split(',')))          # debugging: leave drawables out
    for L in spec['locks']:
        if len(L['pts']) < 3 or L.get('drawable') in skip:
            continue
        if L['layer'] == 'side' and L['pts'][0][1] < 0.6:
            # a face-framing lock drawn only below the fringe (its top hidden under it): it grows out from under the
            # fringe at the temple, so its root is continued up to the hairline
            P0 = np.array(L['pts'], float)
            up = [[P0[0, 0] * (1 - 0.06 * k), P0[0, 1] + 0.25 * k, P0[0, 2]] for k in (3, 2, 1)]
            L = dict(L, pts=up + L['pts'], width=[L['width'][0]] * 3 + list(L['width']))
        if L['layer'] == 'tail':
            tc = tail_bundle(F, M, R, D, L, rng, chin_z)
            ties.append(tc[0].guide[1])
            C += tc
            continue
        c = lock_clump(F, M, R, D, L, rng, chin_z)
        c.src = L.get('drawable', '')
        C.append(c)
        if L['layer'] in ('side', 'back'):
            g = c.guide
            azs = [abs(math.degrees(math.atan2(p[0] - F.c[0], p[1] - F.c[1]))) for p in g[len(g) // 2:]]
            if min(azs) < 115:                               # drawn locks at the sides: no invented locks there
                covered.append((min(azs) - 8, max(azs) + 8))
    if LIVE[0]:
        _preview(F, C, 'Preview_Drawn', pp['hair'])
        yield 'Drawn locks traced from the Live2D hair layers (fringe, side, back, flicks)'
    try:
        from live2d import silfit as _sf
        C += _sf.crown_locks(F, M, D, Clump, NOTIP_VARIANT, log=print)
    except Exception as e:
        print('CROWN skipped: %s: %s' % (type(e).__name__, e))
    C += fringe_fill(F, M, R, D, spec['locks'], rng, chin_z, env=frame.get('fringe_env'))
    C += forehead_cover(F, M, R, D, C, spec['locks'], rng, chin_z, frame.get('fringe_env'))
    if tied and ties:
        C += flow_locks(F, D, rng, ties)
    else:
        C += back_rows(F, M, D, frame, rng, covered, sweep=drawn_sweep(F, M, spec['locks']), R=R,
                       sil_rows=[r for lay in ('back', 'side') for r in spec.get('silhouette', {}).get(lay, []) if -1.6 <= r[0] <= 1.2])
    # analysis by synthesis: render the front locks in Blender and refit them to the drawing's visible-hair mask
    if opt.get('silfit', '1') != '0':
        try:
            from live2d import silfit
            D.mesh('SF_Dome')
            dome = bpy.data.objects.get('SF_Dome')
            if LIVE[0]:
                yield 'Silhouette fit: rendering the front locks against the drawing (analysis by synthesis)'
            C = silfit.fit(F, M, C, frame, dome, out, log=print)
        except Exception as e:
            import traceback
            print('SILFIT failed: %s: %s' % (type(e).__name__, e)); traceback.print_exc()
        for o in [o for o in bpy.data.objects if o.name.startswith('SF_')]:
            bpy.data.objects.remove(o, do_unlink=True)
    # the dyed / tip colour belongs to the long locks (the drawing shows it below the jaw): locks ending above the
    # chin use the atlas column painted without it
    if pp.get('tip_range', [0.7])[0] < 0.6:            # dyed tips (design found a distinct tip colour)
        for c in C:
            if c.variant != UNDER_VARIANT and c.layer != 'tail':
                c.variant = TIP_VARIANT if float(np.asarray(c.guide)[-1][2]) < chin_z + 0.01 else NOTIP_VARIANT
    if LIVE[0]:
        _preview(F, C, 'Preview_All', pp['hair'])
        yield 'Solid fringe fill + the back of the head the drawing never shows'
        for o in [o for o in bpy.data.objects if o.name.startswith('Preview_')]:
            bpy.data.objects.remove(o, do_unlink=True)
        yield 'Final build: smooth mass normals, cel atlas, ink outline (takes a moment)'
    # ONE angel ring round the head at a fixed height (40 % down from the top of the hair to the eyes), not a band at
    # the same fraction of every lock (locks of different lengths / roots scattered it into grey shards)
    top_z = max(float(np.asarray(c.guide)[:, 2].max()) for c in C)
    ring_z = top_z - 0.4 * (top_z - float(M.eye[2]))
    for c in C:
        c.ring_z = ring_z; c.ring_v = 0.23
    print('RING z %.3f (hair top %.3f, eyes %.3f)' % (ring_z, top_z, float(M.eye[2])))
    chains = {}
    for i, c in enumerate(C):
        if c.chain:
            chains.setdefault(c.chain, []).append(i)
    hairline = {'front': 34.0, 'side': D.side_hairline, 'back': D.back_hairline}
    res = StyleResult(C, hairline, palette(pp), chains)
    # the dome replaces anime_hair's hidden scalp shell (same call signature)
    hk.make_scalp = lambda frame, name='HairScalp', offset=0.0035, hairline=None, segs=None, collection=None: D.mesh(name, collection)
    tex = os.path.join(out, 'hair_atlas.png')
    built = build.build(F, res, 'Hair', tex_path=tex, fill=False, style='drawn',
                        proxy_kw={'inflate': 0.012, 'voxel': 0.009, 'smooth_iter': 50, 'smooth_factor': 0.9})
    paint_dome_column(tex, res.palette)
    repaint_notip_column(tex, res.palette)          # root-free (and tip-free) column: short locks, drill coils
    img = bpy.data.images.get(os.path.basename(tex))
    if img:
        img.reload()
    hair = built['hair']
    print(f'HAIR: {len(C)} clumps, {len(hair.data.vertices)} verts, {len(hair.data.polygons)} faces')
    ink = build.ink_hull(built, res.palette, width=float(opt.get('ink', 0.0006)))
    build.export_npz(built, res, out, head_bone='J_Bip_C_Head')
    if LIVE[0]:
        yield 'Exported the hair for the VRM (spring chains, ink hull)'
    hk._save_png(np.ones((4, 4, 4), np.float32) * np.array([*res.palette.ink, 1], np.float32),
                 os.path.join(out, 'hair_ink_solid.png'))
    json.dump({'shade_mul': list(res.palette.shade_mul), 'ink': list(res.palette.ink), 'clumps': len(C),
               'chains': {k: len(v) for k, v in chains.items()},
               'guides': [{'layer': c.layer, 'src': getattr(c, 'src', ''), 'width': c.width, 'guide': np.round(c.guide, 4).tolist()}
                          for c in C]}, open(os.path.join(out, 'hair_meta.json'), 'w'), indent=1)
    if opt.get('views', 'front,tq,side,back') != 'none' and not LIVE[0]:
        for o in bpy.data.objects:
            if o.type == 'MESH':
                for s in o.material_slots:
                    if s.material and s.material.name.startswith(built['material'].name):
                        fit.cel(s.material, shade=res.palette.shade_mul, toony=0.05, shift=0.1)
                    elif s.material:
                        fit.cel(s.material)
        skip = {hair.name, built['scalp'].name} | ({ink.name} if ink else set())
        fit.outline_objects([o for o in bpy.data.objects if o.type == 'MESH' and o.name not in skip and not o.hide_render])
        cam = fit.setup_render(int(opt.get('res', 600)))
        for v in opt.get('views', 'front,tq,side,back').split(','):
            yaw, pitch, span, off = fit.VIEWS[v]
            fit.shoot(cam, os.path.join(out, f'prev_{v}.png'), F.c + np.array(off), span * 1.25, yaw, pitch)


LIVE = [False]
LIVE_HEAD = [None]


def _preview_mat(o, hexcol):
    m = bpy.data.materials.get('PreviewHair') or bpy.data.materials.new('PreviewHair')
    m.diffuse_color = (*srgb(hexcol), 1.0)
    o.data.materials.clear(); o.data.materials.append(m)


def _preview(F, C, name, hexcol):
    old = bpy.data.objects.get(name)
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    hb = hk.HairBuilder(F)
    for c in C:
        hb.add(c)
    o = hb.to_object(name)
    _preview_mat(o, hexcol)
    return o


def _view3d():
    for win in bpy.context.window_manager.windows:
        for area in win.screen.areas:
            if area.type == 'VIEW_3D':
                return area
    return None


ORBIT = {'a': 0.0}


def _orbit():
    area = _view3d()
    if area is None or LIVE_HEAD[0] is None:
        return 0.05
    from mathutils import Euler
    r3 = area.spaces[0].region_3d
    ORBIT['a'] += 0.6
    r3.view_location = Vector(LIVE_HEAD[0])
    r3.view_distance = 0.75
    r3.view_rotation = Euler((math.radians(80), 0, math.radians(ORBIT['a'])), 'XYZ').to_quaternion()
    return 0.04


def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    LIVE[0] = 'live=1' in argv and not bpy.app.background
    gen = pipeline(argv)
    if not LIVE[0]:
        for _ in gen:
            pass
        return
    state = {'title': 'Starting the Live2D -> 3D hair build'}

    def _quit():
        bpy.ops.wm.quit_blender()
        return None

    def setup():
        area = _view3d()
        if area:
            sp = area.spaces[0]
            sp.shading.type = 'SOLID'; sp.shading.light = 'STUDIO'; sp.shading.color_type = 'MATERIAL'
            sp.overlay.show_floor = False; sp.overlay.show_axis_x = False; sp.overlay.show_axis_y = False
            sp.region_3d.view_perspective = 'PERSP'
        return None

    def step():
        area = _view3d()
        try:
            state['title'] = next(gen)
        except StopIteration:
            if area:
                area.header_text_set('Live2D -> 3D hair: DONE (closing in 8 s, the conversion continues)')
            bpy.app.timers.register(_quit, first_interval=8.0)
            return None
        except Exception as e:
            import traceback; traceback.print_exc()
            if area:
                area.header_text_set('FAILED: %s' % e)
            bpy.app.timers.register(_quit, first_interval=10.0)
            return None
        if area:
            area.header_text_set('Live2D -> 3D hair  |  ' + state['title'])
        print('LIVE step: ' + state['title'])
        return 2.5
    bpy.app.timers.register(setup, first_interval=0.3)
    bpy.app.timers.register(_orbit, first_interval=0.5, persistent=True)
    bpy.app.timers.register(step, first_interval=1.5)


if __name__ == '__main__':
    main()
