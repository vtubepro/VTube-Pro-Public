"""Analysis by synthesis for the drawn hair: render the 3D hair in Blender, compare it with the drawing, and move /
turn / resize / drop the front locks until the two agree.

The drawing is the only ground truth a Live2D model (or a single drawing) gives for the fringe, the side locks and the
crown outline. hair_blender builds its locks from measurements of that drawing, but every step between (depth from
the rig's parallax, lock width from the strip, the solid fringe fill, the coverage repair) adds error the eye reads as
"a bowl cut" or "a lock over the wrong eye". Here the finished locks are checked against the drawing itself:

  * targets = hair2d: visible hair / face skin / eyes on a fixed IPD grid for the front pose AND the model's own
              +-30 head turns (the one partial turnaround a Live2D model has), plus the drawn strand DIRECTION field
              (structure tensor of the hair art: doubled-angle cos / sin + coherence)
  * render  = Blender Workbench, orthographic, flat object colours: every candidate lock its own object (white), the
              rest of the hair one object, the avatar's own meshes as black occluders; one camera per view (front,
              and orbited +-TURN_DEG about the head for the turns); one render per changed lock and view, cached
  * cost    = per view: drawn hair not covered + rendered hair where the drawing shows none (x2 over drawn skin, x6
              over the drawn eyes); + FLOW: each lock's projected spine against the drawn strand direction under it
              (sin^2 of the angle between, weighted by the field's coherence) -- a swept fringe must sweep
  * search  = coordinate descent per lock / tail group, coarse to fine: tip shift left / right / up / down, a turn of
              the lock about its root, width x0.8 / x1.2, and for invented strips / flicks also 'drop it'

Runs inside the hair_blender pipeline (bpy); needs the frame's mask_grid / mask_files (hair2d.save).
"""
import dataclasses
import math
import os
import tempfile

import bpy
import numpy as np

from anime_hair import hairkit as hk

FILL_LAYERS = ('fringe_fill', 'ahoge')                 # invented / generated: may be dropped
M_FRONT = [1.0]                                        # +1 / -1: which way (Blender y) the face looks
TURN_DEG = 20.0                                        # a Live2D ParamAngleX 30 is roughly a 20 degree real turn
W_TURN = 0.5                                           # weight of each turned view against the front
W_FLOW = 0.6                                           # flow cost weight (per grid pixel of lock spine)


def _load_img(path):
    img = bpy.data.images.load(path, check_existing=False)
    W, H = img.size
    a = np.array(img.pixels[:], np.float32).reshape(H, W, 4)[::-1, :, 0]
    bpy.data.images.remove(img)
    return a


def _load_mask(path):
    return _load_img(path) > 0.5


class Renderer:
    """orthographic Workbench renders of mask objects laid out like the drawn-mask grid, one camera per view"""

    def __init__(self, F, M, grid, occluders, yaws=(0.0,)):
        self.grid = grid
        g = grid
        self.W = int(round((g['a1'] - g['a0']) * g['px'])); self.H = int(round((g['b1'] - g['b0']) * g['px']))
        sc = bpy.context.scene
        self.scene = sc
        self.saved = (sc.render.engine, sc.camera, sc.render.resolution_x, sc.render.resolution_y,
                      sc.render.resolution_percentage, sc.render.filepath, sc.render.image_settings.file_format,
                      sc.render.film_transparent)
        sc.render.engine = 'BLENDER_WORKBENCH'
        sh = sc.display.shading
        sh.light = 'FLAT'; sh.color_type = 'OBJECT'
        sh.show_shadows = False; sh.show_cavity = False; sh.show_object_outline = False
        sh.show_specular_highlight = False
        sc.display.render_aa = 'OFF'
        if sc.world is None:
            sc.world = bpy.data.worlds.new('SF_World')
        self.world_col = tuple(sc.world.color)
        sc.world.color = (0.0, 0.0, 0.0)
        sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = self.W, self.H, 100
        sc.render.film_transparent = False
        sc.render.image_settings.file_format = 'PNG'
        sc.view_settings.view_transform = 'Standard'
        front = 1.0 if M.eye[1] > F.c[1] else -1.0
        ac, bc = (g['a0'] + g['a1']) / 2, (g['b0'] + g['b1']) / 2
        self.cams = {}
        for yaw in yaws:
            cam_d = bpy.data.cameras.new('SF_Cam'); cam_d.type = 'ORTHO'
            cam_d.ortho_scale = max(g['a1'] - g['a0'], g['b1'] - g['b0']) * M.ipd
            cam_d.clip_start = 0.01; cam_d.clip_end = 10.0
            cam = bpy.data.objects.new('SF_Cam', cam_d)
            sc.collection.objects.link(cam)
            # the head turned by yaw == the camera orbited by -yaw about the head centre; the grid stays centred on
            # the (turned) eye midpoint, in front IPD units, like the drawn turned masks
            th = math.radians(-yaw)
            Rz = np.array([[math.cos(th), -math.sin(th), 0], [math.sin(th), math.cos(th), 0], [0, 0, 1.0]])
            E = np.asarray(M.eye, float)
            back = Rz @ np.array([0, front * 1.0, 0])
            # (the grid is symmetric in a, so its centre column is the eye midpoint in every view)
            cen = E + np.array([0, 0, 1.0]) * bc * M.ipd + (Rz @ np.array([1.0, 0, 0])) * ac * M.ipd
            cam.location = tuple(cen + back * 2.0)
            cam.rotation_euler = (math.pi / 2, 0.0, (0.0 if front < 0 else math.pi) + th)
            self.cams[yaw] = cam
        sc.camera = self.cams[yaws[0]]
        self.front = front
        self.M = M
        self.occ = [o for o in occluders if o.type == 'MESH']
        for o in self.occ:
            o.color = (0.0, 0.0, 0.0, 1.0)
        self.tmp = os.path.join(tempfile.gettempdir(), f'vtp_silfit_{os.getpid()}.png')
        self.n = 0

    def render(self, show, yaw=0.0):
        """visible (white) pixels of the objects in `show` seen from view `yaw`, other hair hidden, occluders black"""
        for o in bpy.data.objects:
            if o.type != 'MESH':
                continue
            if o in self.occ:
                o.hide_render = False
            else:
                o.hide_render = o not in show
        for o in show:
            o.color = (1.0, 1.0, 1.0, 1.0)
        self.scene.camera = self.cams[yaw]
        self.scene.render.filepath = self.tmp
        bpy.ops.render.render(write_still=True)
        self.n += 1
        img = bpy.data.images.load(self.tmp, check_existing=False)
        a = np.array(img.pixels[:], np.float32).reshape(self.H, self.W, 4)[::-1, :, 0] > 0.5
        bpy.data.images.remove(img)
        return a

    def close(self):
        sc = self.scene
        (sc.render.engine, sc.camera, sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage,
         sc.render.filepath, sc.render.image_settings.file_format, sc.render.film_transparent) = self.saved
        if sc.world:
            sc.world.color = self.world_col
        for o in bpy.data.objects:
            o.hide_render = False
        for cam in self.cams.values():
            bpy.data.objects.remove(cam, do_unlink=True)
        try:
            os.remove(self.tmp)
        except OSError:
            pass


def _mesh_obj(F, clumps, name):
    old = bpy.data.objects.get(name)
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    hb = hk.HairBuilder(F)
    for c in clumps:
        hb.add(c)
    return hb.to_object(name)


def _xform(P, p, M, root):
    """points P (n,3) of a lock: tip shifted by (dx, dz) IPD (root anchored, t^0.8), then the whole lock turned by
    rot degrees about its root in the front (x, z) plane"""
    dx, dz, s, rot = p[:4]
    dy = p[4] if len(p) > 4 else 0.0                   # toward the viewer (tails: beside the cheek vs behind the ear)
    P = np.asarray(P, float).copy()
    n = len(P)
    t = (np.arange(n) / max(n - 1, 1)) ** 0.8
    P[:, 0] += t * dx * M.ipd
    P[:, 2] += t * dz * M.ipd
    P[:, 1] += t * dy * M.ipd * M_FRONT[0]
    if rot:
        a = math.radians(rot)
        rx, rz = P[:, 0] - root[0], P[:, 2] - root[2]
        P[:, 0] = root[0] + rx * math.cos(a) - rz * math.sin(a)
        P[:, 2] = root[2] + rx * math.sin(a) + rz * math.cos(a)
    return P


def _moved(c, p, M):
    """clump c with the lock transform p = (dx, dz, width scale, rot deg) applied"""
    p = list(p) + [0.0] * (5 - len(p))
    G0 = np.asarray(c.guide, float)
    G = _xform(G0, p, M, G0[0])
    kw = {}
    if getattr(c, 'centers', None) is not None:          # a helix's frame axis moves with it
        kw['centers'] = _xform(np.asarray(c.centers, float), p, M, G0[0])
    return dataclasses.replace(c, guide=G, width=float(c.width * p[2]), **kw)


class Flow:
    """the drawn strand direction field on the grid and the flow cost of a set of lock spines (front projection)"""

    def __init__(self, files, grid, M, flip):
        self.ok = all(os.path.exists(files.get(k, '') or '') for k in ('flow_c', 'flow_s', 'flow_w'))
        if not self.ok:
            return
        self.c2 = _load_img(files['flow_c']) * 2 - 1
        self.s2 = _load_img(files['flow_s']) * 2 - 1
        self.w = _load_img(files['flow_w'])
        self.g = grid; self.M = M; self.flip = flip
        self.H, self.W = self.w.shape

    def cost(self, spines):
        """sum over spines of sin^2(angle to the field) * coherence * length (grid px)"""
        if not self.ok:
            return 0.0
        g, M = self.g, self.M
        tot = 0.0
        for G in spines:
            G = np.asarray(G, float)
            a = (G[:, 0] - M.eye[0]) / M.ipd; b = (G[:, 2] - M.eye[2]) / M.ipd
            col = (g['a1'] - a) * g['px']; row = (g['b1'] - b) * g['px']
            if self.flip:
                col = self.W - col
            d = np.stack([np.diff(col), np.diff(row)], 1)
            L = np.linalg.norm(d, axis=1) + 1e-9
            mc = ((col[1:] + col[:-1]) / 2).astype(int); mr = ((row[1:] + row[:-1]) / 2).astype(int)
            ok = (mc >= 0) & (mc < self.W) & (mr >= 0) & (mr < self.H)
            if not ok.any():
                continue
            ux, uy = d[ok, 0] / L[ok], d[ok, 1] / L[ok]
            c2l, s2l = ux * ux - uy * uy, 2 * ux * uy          # the lock's doubled angle
            cos2d = c2l * self.c2[mr[ok], mc[ok]] + s2l * self.s2[mr[ok], mc[ok]]
            mis = (1 - cos2d) / 2                              # = sin^2 of the angle between
            tot += float((mis * self.w[mr[ok], mc[ok]] * L[ok]).sum())
        return tot


def fit(F, M, C, frame, dome, work, log=print, sweeps=2):
    """-> the clump list with the front locks refitted to the drawing (or C unchanged without masks)"""
    files = frame.get('mask_files') or {}
    grid = frame.get('mask_grid')
    if not grid or 'hair' not in files or not os.path.exists(files['hair']):
        log('SILFIT skipped (no drawn masks)')
        return C
    ld = lambda k: _load_mask(files[k]) if os.path.exists(files.get(k, '') or '') else None
    Th0 = ld('hair')
    H, W = Th0.shape
    z = np.zeros((H, W), bool)
    fill = lambda x: x if x is not None else z
    T = {0.0: (Th0, fill(ld('face')), fill(ld('eyes')))}
    turned = {k: (ld('hair' + k), fill(ld('face' + k)), fill(ld('eyes' + k))) for k in ('_p30', '_m30')}
    T_ign = fill(ld('ignore'))
    b = grid['b1'] - (np.arange(H) + 0.5) / grid['px']
    roi = ((b > frame.get('chin_b', -1.5) - 0.3) & (b < grid['b1']))[:, None] * np.ones((1, W), bool)

    def weights(Th, Tf, Te):
        return (np.where(Te, 6.0, np.where(Tf, 2.0, 1.0)) * roi * ~T_ign, np.where(Th, 1.0, 0.0) * roi)

    Wt = {0.0: weights(*T[0.0])}

    def cost_view(R, yaw):
        Th = T[yaw][0]; wfp, wfn = Wt[yaw]
        return float((wfp * (R & ~Th)).sum() + (wfn * (~R)).sum())

    # candidates: the locks in front of the face (fringe, its fill, side locks, flicks) and drawn tails as groups
    front = 1.0 if M.eye[1] > F.c[1] else -1.0
    M_FRONT[0] = front
    cand = []
    members = {}
    tails = {}
    for i, c in enumerate(C):
        G = np.asarray(c.guide, float)
        if c.layer == 'tail':
            tails.setdefault(c.chain or f'tail{i}', []).append(i)
            continue
        if c.layer not in ('fringe', 'fringe_fill', 'side', 'ahoge', 'back'):
            continue
        fr_ = (G[:, 1] - F.c[1]) * front > 0.2 * F.r[1]
        if not fr_.any():
            continue
        if c.layer == 'back' and not (np.abs(G[fr_, 0] - M.eye[0]) < 2.4 * M.ipd).any():
            continue
        cand.append(i); members[i] = [i]
    for ids in tails.values():
        cand.append(ids[0]); members[ids[0]] = ids
    if not cand:
        log('SILFIT skipped (no front locks)')
        return C
    occ = [o for o in bpy.data.objects if o.type == 'MESH' and (o.name.split('.')[0] in ('Face', 'Body')
                                                                or o.name.startswith('Outfit'))]
    have_turns = all(v[0] is not None for v in turned.values())
    yaws = (0.0, TURN_DEG, -TURN_DEG) if have_turns else (0.0,)
    Rr = Renderer(F, M, grid, occ, yaws)
    SHRINK_ONLY = set()
    try:
        # the invented back rows show in the front view only as the head's outline: those sticking out past the
        # drawn outline become candidates too (shrink / lift / shift only -- the back needs them)
        back_c = [i for i, c in enumerate(C) if c.layer == 'back' and i not in cand]
        for i in back_c:
            o = _mesh_obj(F, [C[i]], f'SF_p{i}')
            m_ = Rr.render([o])
            bpy.data.objects.remove(o, do_unlink=True)
            over = int((m_ & ~Th0 & roi).sum() + (m_[:, ::-1] & ~Th0 & roi).sum()) // 2
            if over > 25:
                cand.append(i); members[i] = [i]; SHRINK_ONLY.add(i)
        in_cand = {j for k in cand for j in members[k]}
        key_of = {j: k for k in cand for j in members[k]}
        rest = [c for i, c in enumerate(C) if i not in in_cand]
        static_objs = [dome] if dome is not None else []
        if rest:
            static_objs.append(_mesh_obj(F, rest, 'SF_Static'))
        objs = {i: _mesh_obj(F, [C[j] for j in members[i]], f'SF_{i}') for i in cand}
        # mirror check (front view): which way the render maps onto the drawn grid
        S0 = Rr.render(static_objs, 0.0)
        M0 = {i: Rr.render([objs[i]], 0.0) for i in cand}
        R0 = S0.copy()
        for m_ in M0.values():
            R0 |= m_
        flip = cost_view(R0[:, ::-1], 0.0) < 0.8 * cost_view(R0, 0.0)
        fx = (lambda R_: R_[:, ::-1]) if flip else (lambda R_: R_)
        if flip:
            log('SILFIT note: render mirrored against the drawn grid -- flipping the renders')
        S = {0.0: fx(S0)}
        masks = {0.0: {i: fx(m_) for i, m_ in M0.items()}}
        # the turned views: which drawn turn (+30 / -30) belongs to which orbit sign -- decided by the cost too
        if have_turns:
            Sp = fx(Rr.render(static_objs, TURN_DEG)); Sm = fx(Rr.render(static_objs, -TURN_DEG))
            Mp = {i: fx(Rr.render([objs[i]], TURN_DEG)) for i in cand}
            Mm = {i: fx(Rr.render([objs[i]], -TURN_DEG)) for i in cand}
            Rp = Sp.copy(); Rm = Sm.copy()
            for i in cand:
                Rp |= Mp[i]; Rm |= Mm[i]
            tp, tm = turned['_p30'], turned['_m30']

            def cv(R, Tt):
                wfp, wfn = weights(*Tt)
                return float((wfp * (R & ~Tt[0])).sum() + (wfn * (~R)).sum())
            if cv(Rp, tm) + cv(Rm, tp) < cv(Rp, tp) + cv(Rm, tm):
                tp, tm = tm, tp
            T[TURN_DEG] = tp; T[-TURN_DEG] = tm
            Wt[TURN_DEG] = weights(*tp); Wt[-TURN_DEG] = weights(*tm)
            S[TURN_DEG] = Sp; S[-TURN_DEG] = Sm
            masks[TURN_DEG] = Mp; masks[-TURN_DEG] = Mm
        flow = Flow(files, grid, M, flip)

        def total(ms, yaw):
            R = S[yaw].copy()
            for m_ in ms.values():
                R |= m_
            return R

        def iou(yaw, ms):
            R = total(ms, yaw); Th = T[yaw][0]
            return float((R & Th & roi).sum() / max(((R | Th) & roi).sum(), 1))

        fl_cache = {i: flow.cost([C[j].guide for j in members[i]]) for i in cand}

        def total_cost(ms_by_view, fl):
            c = 0.0
            for yaw in yaws:
                c += (1.0 if yaw == 0.0 else W_TURN) * cost_view(total(ms_by_view[yaw], yaw), yaw)
            return c + W_FLOW * sum(fl.values())

        c0 = cur = total_cost(masks, fl_cache)
        Rf0 = total(masks[0.0], 0.0)
        iou_start = {yaw: iou(yaw, masks[yaw]) for yaw in yaws}
        f0 = sum(fl_cache.values())
        params = {i: [0.0, 0.0, 1.0, 0.0, 0.0] for i in cand}
        is_tail = {i: C[i].layer == 'tail' for i in cand}
        on = {i: True for i in cand}
        steps = [(0.16, 0.22, 0.2, 10.0), (0.08, 0.11, 0.1, 5.0)]
        tried = 0
        for sw in range(sweeps):
            sx, sz, ss, sr = steps[min(sw, len(steps) - 1)]
            order = sorted(cand, key=lambda i: -float((masks[0.0][i] & ~Th0 & roi).sum()) - fl_cache[i])
            for i in order:
                trials = []
                if C[i].layer in FILL_LAYERS and on[i]:
                    trials.append('off')
                p = params[i]
                if i in SHRINK_ONLY:
                    trials += [[p[0], p[1] + sz, p[2], p[3], p[4]], [p[0], p[1], p[2] * (1 - ss), p[3], p[4]],
                               [p[0] + sx, p[1], p[2], p[3], p[4]], [p[0] - sx, p[1], p[2], p[3], p[4]]]
                elif on[i]:
                    trials += [[p[0] + sx, p[1], p[2], p[3], p[4]], [p[0] - sx, p[1], p[2], p[3], p[4]],
                               [p[0], p[1] + sz, p[2], p[3], p[4]], [p[0], p[1] - sz, p[2], p[3], p[4]],
                               [p[0], p[1], p[2], p[3] + sr, p[4]], [p[0], p[1], p[2], p[3] - sr, p[4]]]
                    if sw == 0:
                        trials += [[p[0], p[1], p[2] * (1 - ss), p[3], p[4]], [p[0], p[1], p[2] * (1 + ss), p[3], p[4]]]
                    if is_tail[i]:                     # a tail may hang further forward / back (the turns decide)
                        trials += [[p[0], p[1], p[2], p[3], p[4] + 2 * sx], [p[0], p[1], p[2], p[3], p[4] - 2 * sx]]
                for tr in trials:
                    tried += 1
                    ms = {yaw: dict(masks[yaw]) for yaw in yaws}
                    fl = dict(fl_cache)
                    newobj = None
                    if tr == 'off':
                        for yaw in yaws:
                            ms[yaw][i] = z
                        fl[i] = 0.0
                    else:
                        moved = [_moved(C[j], tr, M) for j in members[i]]
                        newobj = _mesh_obj(F, moved, f'SF_t{i}')
                        # front first: a trial that clearly loses there is not rendered from the turns
                        ms[0.0][i] = fx(Rr.render([newobj], 0.0))
                        fl[i] = flow.cost([c_.guide for c_ in moved])
                        part_new = cost_view(total(ms[0.0], 0.0), 0.0) + W_FLOW * sum(fl.values())
                        part_old = cost_view(total(masks[0.0], 0.0), 0.0) + W_FLOW * sum(fl_cache.values())
                        if part_new > part_old + 40:
                            bpy.data.objects.remove(newobj, do_unlink=True)
                            continue
                        for yaw in yaws[1:]:
                            ms[yaw][i] = fx(Rr.render([newobj], yaw))
                    cc = total_cost(ms, fl)
                    if cc < cur - 0.5:
                        cur = cc
                        masks = ms; fl_cache = fl
                        bpy.data.objects.remove(objs[i], do_unlink=True)
                        if tr == 'off':
                            on[i] = False
                        else:
                            params[i] = tr
                            newobj.name = f'SF_{i}'
                            objs[i] = newobj
                            newobj = None
                    if newobj is not None:
                        bpy.data.objects.remove(newobj, do_unlink=True)
                    if not on[i]:
                        break
        Rf1 = total(masks[0.0], 0.0)
        Te = T[0.0][2]
        eye0 = int((Rf0 & Te).sum()); eye1 = int((Rf1 & Te).sum())
        ious = ', '.join('%+.0f: %.3f -> %.3f' % (yaw, iou_start[yaw], iou(yaw, masks[yaw])) for yaw in yaws)
        out = []
        moved_n = dropped = 0
        for i, c in enumerate(C):
            k = key_of.get(i)
            if k is not None and not on[k]:
                dropped += 1
                continue
            if k is not None and params[k] != [0.0, 0.0, 1.0, 0.0, 0.0]:
                c = _moved(c, params[k], M)
                moved_n += 1
            out.append(c)
        log(f'SILFIT {len(cand)} locks / groups, {len(yaws)} views, {Rr.n} renders ({tried} trials): cost {c0:.0f} -> '
            f'{cur:.0f}; IoU {ious}; flow misfit {f0:.0f} -> {sum(fl_cache.values()):.0f}; hair over the drawn eyes '
            f'{eye0} -> {eye1} px; {moved_n} moved, {dropped} dropped')
        _debug(os.path.join(work, 'silfit.png'), Th0, T[0.0][1], Te, Rf0, Rf1)
        if have_turns:
            for yaw in yaws[1:]:
                _debug(os.path.join(work, 'silfit_%+d.png' % int(yaw)), T[yaw][0], T[yaw][1], T[yaw][2],
                       total(masks[yaw], yaw), total(masks[yaw], yaw))
        return out
    finally:
        Rr.close()
        for o in [o for o in bpy.data.objects if o.name.startswith('SF_')]:
            bpy.data.objects.remove(o, do_unlink=True)


def fit_dome(F, M, D, frame, work, log=print):
    """the hair VOLUME first (before any lock is placed on it): the dome's top / left / right offsets fitted so its
    front silhouette sits inside the drawn hair outline above the eyes (locks then add their own thickness on top)"""
    files = frame.get('mask_files') or {}
    grid = frame.get('mask_grid')
    if not grid or 'hair' not in files or not os.path.exists(files['hair']):
        return False
    T_hair = _load_mask(files['hair'])
    T_face = _load_mask(files['face']) if os.path.exists(files.get('face', '')) else np.zeros_like(T_hair)
    H, W = T_hair.shape
    b = grid['b1'] - (np.arange(H) + 0.5) / grid['px']
    roi = (b > 0.3)[:, None] * np.ones((1, W), bool)
    T_ign = _load_mask(files['ignore']) if os.path.exists(files.get('ignore', '') or '') else np.zeros_like(T_hair)
    w_fp = np.where(T_face, 0.3, 1.0) * roi * ~T_ign
    # the crown's drawn height is the hair VOLUME (a quiff / tall crown): missing it there counts nearly as much as
    # overshooting; lower down the locks fill the outline, so a missed pixel is cheap
    crown = (b > frame.get('crown_b', 2.2) - 0.7)[:, None] * np.ones((1, W), bool)
    w_fn = np.where(T_hair, np.where(crown, 0.85, 0.45), 0.0) * roi

    def cost(R):
        return float((w_fp * (R & ~T_hair)).sum() + (w_fn * (~R)).sum())
    occ = [o for o in bpy.data.objects if o.type == 'MESH' and (o.name.split('.')[0] in ('Face', 'Body')
                                                                or o.name.startswith('Outfit'))]
    Rr = Renderer(F, M, grid, occ)
    keys = ('o_top', 'top_lean', 'o_side_p', 'o_side_n')
    lim = {'o_top': (0.004, 0.1), 'top_lean': (-0.05, 0.05), 'o_side_p': (0.004, 0.08), 'o_side_n': (0.004, 0.08)}
    if not hasattr(D, 'top_lean'):
        D.top_lean = 0.0
    start = {k: getattr(D, k) for k in keys}
    flip = None
    try:
        def rend():
            D.mesh('SF_DomeFit')
            o = bpy.data.objects['SF_DomeFit']
            R = Rr.render([o])
            bpy.data.objects.remove(o, do_unlink=True)
            return R
        R = rend()
        if flip is None:
            flip = cost(R[:, ::-1]) < 0.8 * cost(R)
        fx = (lambda R_: R_[:, ::-1]) if flip else (lambda R_: R_)
        R0 = fx(R)
        cur = c0 = cost(R0)
        for step in (0.012, 0.008, 0.004, 0.002):
            for k in keys:
                for sg in (1, -1):
                    old = getattr(D, k)
                    new = float(np.clip(old + sg * step, *lim[k]))
                    if new == old:
                        continue
                    setattr(D, k, new)
                    cc = cost(fx(rend()))
                    if cc < cur - 0.5:
                        cur = cc
                    else:
                        setattr(D, k, old)
        D.o_side = max(D.o_side_p, D.o_side_n)
        log('SILFIT dome (%d renders): cost %.0f -> %.0f; top %.4f -> %.4f (lean %+.3f), +x %.4f -> %.4f, -x %.4f -> %.4f' % (
            Rr.n, c0, cur, start['o_top'], D.o_top, D.top_lean, start['o_side_p'], D.o_side_p, start['o_side_n'],
            D.o_side_n))
        # where the DRAWN outline rises above the fitted dome (a flame / upswept crown, a tall wavy top): the bumps
        # of excess height per column above the eye line become rising crown locks (crown_locks, below)
        Rf = fx(rend())
        g = grid
        bumps = []
        cols_h = []
        for c_ in range(W):
            th_ = np.nonzero(T_hair[:, c_] & roi[:, c_])[0]
            rd_ = np.nonzero(Rf[:, c_])[0]
            if not len(th_):
                cols_h.append(0.0); continue
            if not len(rd_):                         # beside the dome (the side hair): not a crown bump
                cols_h.append(0.0); continue
            top_d = th_.min(); top_r = rd_.min()
            b_top = g['b1'] - (top_d + 0.5) / g['px']
            cols_h.append(max(0.0, (top_r - top_d) / g['px']) if b_top > 1.0 else 0.0)
        cols_h = np.array(cols_h)
        k = max(3, int(0.3 * g['px']))
        sm = np.convolve(cols_h, np.ones(k) / k, mode='same')
        c_ = 0
        while c_ < W:
            if sm[c_] > 0.18:
                c1 = c_
                while c1 < W and sm[c1] > 0.18:
                    c1 += 1
                seg = np.arange(c_, c1)
                pk = int(seg[np.argmax(cols_h[seg])])
                th_ = np.nonzero(T_hair[:, pk])[0]
                if len(th_) and 0.2 < cols_h[pk] < 2.5:
                    a_tip = g['a1'] - (pk + 0.5) / g['px']
                    b_tip = g['b1'] - (th_.min() + 0.5) / g['px']
                    bumps.append((float(a_tip), float(b_tip), float(cols_h[pk]), float((c1 - c_) / g['px'])))
                c_ = c1
            else:
                c_ += 1
        D.crown_bumps = bumps
        if bumps:
            log('SILFIT crown: %d drawn bumps above the dome: %s' % (len(bumps), ', '.join(
                'a %+.2f b %.2f (+%.2f, %.2f wide)' % bb for bb in bumps)))
        return True
    finally:
        Rr.close()
        for o in [o for o in bpy.data.objects if o.name.startswith('SF_')]:
            bpy.data.objects.remove(o, do_unlink=True)


def _debug(path, T, Fm, E, R0, R1):
    """drawn (grey face, blue eyes, white hair outline) vs render before | after: green = both, red = extra hair,
    yellow = missing hair"""
    def panel(R):
        img = np.zeros(T.shape + (3,), np.float32)
        img[Fm] = (0.35, 0.3, 0.28)
        img[E] = (0.2, 0.3, 0.8)
        img[R & T] = (0.2, 0.75, 0.3)
        img[R & ~T] = (0.9, 0.2, 0.15)
        img[~R & T] = (0.95, 0.85, 0.2)
        return img
    out = np.concatenate([panel(R0), np.ones((T.shape[0], 4, 3), np.float32), panel(R1)], 1)
    Hh, Ww = out.shape[:2]
    im = bpy.data.images.new('SF_debug', Ww, Hh, alpha=True)
    px = np.concatenate([out[::-1], np.ones((Hh, Ww, 1), np.float32)], -1)
    im.pixels.foreach_set(px.reshape(-1))
    im.filepath_raw = path; im.file_format = 'PNG'
    im.save()
    bpy.data.images.remove(im)


def crown_locks(F, M, D, Clump, variant, log=print):
    """rising crown locks for the drawn bumps above the dome (fit_dome.crown_bumps): each a broad flame lock rooted on
    the dome inside the bump and rising, curved outward, to the drawn tip -- the upswept / wavy top a hanging lock
    set cannot make"""
    out = []
    for a_tip, b_tip, h, wid in getattr(D, 'crown_bumps', []) or []:
        x_t, z_t = M.xz(a_tip, b_tip)
        tip = np.array([x_t, F.c[1], z_t])
        d = tip - np.asarray(F.c, float); d /= np.linalg.norm(d) + 1e-9
        # the root: on the dome, back toward the head centre along the rise, lower by the bump's height
        x_r, z_r = M.xz(a_tip * 0.7, b_tip - max(0.6, 1.4 * h))
        root = np.array([x_r, F.c[1], z_r])
        rd = root - np.asarray(F.c, float); rd /= np.linalg.norm(rd) + 1e-9
        root = np.asarray(F.c, float) + rd * (np.linalg.norm(root - F.c) * 0.0 + float(np.max(F.r)) * 0.95)
        mid = (root + tip) / 2 + d * 0.25 * np.linalg.norm(tip - root)          # bowed outward
        G = np.array([root, (root + mid) / 2, mid, (mid + tip) / 2, tip])
        w = float(np.clip(0.45 * wid * M.ipd, 0.02, 0.06))
        out.append(Clump(G, width=w, thick=0.3, shape='flame', tip_start=0.45, tip_curve=0.85, root_w=0.9,
                         belly=0.12, ridge=0.35, wrap=0.2, tips=1, variant=variant, layer='ahoge', chain=None,
                         thick_tip=0.3))
    if out:
        log('CROWN %d rising crown locks from the drawn outline' % len(out))
    return out
