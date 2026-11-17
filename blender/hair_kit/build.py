"""
hair_kit.build — one-shot hair build on an existing avatar (headless Blender, low priority):

    tools\\blender_low.cmd -b --factory-startup --python blender/hair_kit/build.py -- <avatar.glb> <out_dir>
        [--style wild_swept_back] [--drop Hair,HairClumps] [--profile in_profile.json] [--seed 7]
        [--ref assets/reference/aosabi/aosabi_v2_turnaround.png --ref-cal back:460,95,420]
        [--eye-z 1.7626] [--chin-z 1.64] [--head-bone head] [--no-gn]

Pipeline: head frame -> style recipe (roots, flow-field guides with body collision, reference-silhouette fit,
waves / flicks) -> child strands (numpy interpolation + clumping) -> Blender CURVES object + Essentials hair node
groups (Frizz / Smooth / Trim) -> clumped LOCK meshes (strand spread -> width + orientation) + flyaway ribbons +
scalp under-shell -> unique-UV atlas painted -> proxy toon normals -> spring chains -> LOD1 / LOD2 -> GLB +
profile.json + stats.json. Review the result with tools/review_character.py --focus hair.
"""
from __future__ import annotations

import json
import math
import os
import sys
import time

import bpy
import numpy as np
from mathutils import Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from hair_kit import core, strands as ST, locks as LK, finish as FN, styles as SY  # noqa: E402

ARGV = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
SRC, OUT = os.path.abspath(ARGV[0]), os.path.abspath(ARGV[1])


def opt(k, d=None):
    return ARGV[ARGV.index(k) + 1] if k in ARGV else d


os.makedirs(OUT, exist_ok=True)
T0 = time.time()


def log(*a):
    print('[hair_kit]', f'{time.time() - T0:6.1f}s', *a, flush=True)


rng = np.random.default_rng(int(opt('--seed', 7)))
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=SRC)
for o in bpy.data.objects:
    if o.animation_data:
        o.animation_data.action = None
drop = set((opt('--drop') or 'Hair,HairClumps').split(','))
for o in list(bpy.data.objects):
    if o.type == 'MESH' and (o.name in drop or o.data.name in drop):
        bpy.data.objects.remove(o, do_unlink=True)
arm = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
if arm:
    arm.data.pose_position = 'REST'
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
bpy.context.view_layer.update()
body = max(meshes, key=lambda o: len(o.data.vertices))
eye_z = float(opt('--eye-z')) if opt('--eye-z') else None
chin_z = float(opt('--chin-z')) if opt('--chin-z') else None
head = core.Head.from_objects(meshes, eye_z=eye_z, chin_z=chin_z)
log('head centre', np.round(head.c, 3), 'radii', np.round(head.r, 3), 'eye', eye_z, 'chin', head.chin_z)

# ---------------------------------------------------------------------------------------------- reference
ref = None
if opt('--ref'):
    import bpy as _b
    im = _b.data.images.load(os.path.abspath(opt('--ref')))
    W, H = im.size
    px = np.empty(W * H * 4, np.float32); im.pixels.foreach_get(px)
    rgb = px.reshape(H, W, 4)[::-1, :, :3]
    # image pixels are linear after load: back to sRGB-ish for the HSV mask
    rgb = np.where(rgb <= 0.0031308, rgb * 12.92, 1.055 * np.power(np.clip(rgb, 0, 1), 1 / 2.4) - 0.055)
    mask = core.hair_mask(rgb)
    view, cal = (opt('--ref-cal') or 'back:460,95,420').split(':')
    ax, tp, cp = [float(x) for x in cal.split(',')]
    x0, x1 = (150, 650) if view == 'back' else (0, W)
    m2 = np.zeros_like(mask); m2[:, x0:x1] = mask[:, x0:x1]
    # keep only the hair mass connected to the top of the head (drop hands / props of the same colour)
    from collections import deque
    seen = np.zeros_like(m2); ys, xs = np.nonzero(m2[: int(tp) + 40, int(ax) - 60:int(ax) + 60])
    q = deque((y, x + int(ax) - 60) for y, x in zip(ys, xs))
    for y, x in q: seen[y, x] = True
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            yy, xx = y + dy, x + dx
            if 0 <= yy < H and 0 <= xx < W and m2[yy, xx] and not seen[yy, xx]:
                seen[yy, xx] = True; q.append((yy, xx))
    m2 = seen
    ref = core.RefView(m2, tp, cp, ax, head, view=view)
    log('reference', opt('--ref'), view, 'px/m %.0f' % ref.k)

# ---------------------------------------------------------------------------------------------- style
style = SY.STYLES[opt('--style', 'wild_swept_back')]
PARAMS = json.load(open(opt('--params'), encoding='utf-8')) if opt('--params') else {}
FAST = '--fast' in ARGV            # matcher iterations: no LODs / .blend / chains
designs, fly = style(head, rng, ref=ref, **PARAMS.get('style', {}))
log(len(designs), 'lock designs,', len(fly), 'flyaways')
np.savez(os.path.join(OUT, 'guides.npz'), G=np.stack([core.resample(d['guide'], 30) for d in designs]),
         layer=np.array([d['layer'] for d in designs]), th=np.array([d.get('th', 0) for d in designs]))

# ---------------------------------------------------------------------------------------------- strands (+ GN)
guides = [d['guide'] for d in designs]
S, cid, rel = ST.children(head, guides, per_guide=[d['per_guide'] for d in designs], spread=[d['spread'] for d in designs],
                          clump=0.55, clump_shape=1.4, length_var=0.22, rng=rng)
log('strands', S.shape)
gn_used = False
if '--no-gn' not in ARGV:
    try:
        allS = np.concatenate([S, (np.stack(fly) if len(fly) else np.zeros((0, S.shape[1], 3)))])
        cobj = ST.curves_object(allS, 'HK_Strands', clump=np.r_[cid, -np.ones(len(fly), int)])
        out = ST.gn_stack(cobj, [('Smooth Hair Curves', {'Amount': 0.6, 'Iterations': 6, 'Weight': 0.5, 'Preserve Length': True}),
                                 ('Frizz Hair Curves', {'Distance': 0.0025, 'Shape': 0.8, 'Seed': 3, 'Factor': 1.0})])
        if out.shape == allS.shape:
            S, fly_s = out[:len(S)], out[len(S):]
            gn_used = True
            log('Essentials GN (Smooth + Frizz) applied to', out.shape[0], 'curves')
        bpy.data.objects.remove(cobj, do_unlink=True)
    except Exception as e:  # keep the numpy strands
        log('GN stack skipped:', e)
        fly_s = (np.stack(fly) if len(fly) else np.zeros((0, S.shape[1], 3)))
else:
    fly_s = (np.stack(fly) if len(fly) else np.zeros((0, S.shape[1], 3)))

# ---------------------------------------------------------------------------------------------- locks
specs = []
for i, d in enumerate(designs):
    sel = cid == i
    sp = LK.lock_from_strands(d['guide'], S[sel], head.c, w_min=0.006, w_max=d['width'] * 1.25, w_scale=2.3,
                              th_ratio=0.28, layer=d['layer'], tips=d['tips'], tip_start=d['tip_start'], wrap=d['wrap'],
                              tone=d['tone'], chain=d['chain'], tip_spread=d.get('tip_spread', 0.28))
    # blend the measured width toward the design width (the design sets scale, strands add variation)
    t = np.linspace(0, 1, len(sp.width))
    design_w = d['width'] * (0.62 + 0.38 * core.smoothstep(0, 0.2, t)) * (1 + 0.08 * np.sin(np.pi * t))
    sp.width = 0.2 * sp.width + 0.8 * design_w
    sp.thick = np.clip(sp.width * 0.18, 0.004, 0.012)
    # locks lie like shingles: lateral = horizontal tangent round the body axis (blended from the scalp frame)
    Cc = sp.C
    radial = np.stack([Cc[:, 0] - head.c[0], Cc[:, 1] - head.c[1], np.zeros(len(Cc))], 1)
    tan_h = core.unit(np.cross(np.array([0, 0, 1.0]), core.unit(radial)))
    tan_h *= np.sign((tan_h * sp.lateral).sum(1, keepdims=True) + 1e-9)
    wk = core.smoothstep(0.05, 0.35, t)[:, None]
    lat = core.unit(sp.lateral * (1 - wk) + tan_h * wk)
    _, sp.lateral, sp.outward = LK._frames_from_lateral(sp.C, lat, head.c)
    specs.append(sp)
atlas = LK.Atlas(cols=64, rows=4, size=2048)
mesh = LK.build_mesh(specs, atlas)
fly_m = LK.ribbons(fly_s, atlas, head.c, width=0.005)
scalp_slot = atlas.slot()
scalp = FN.scalp_shell(head, body, atlas.uv(scalp_slot, 0.5, 0.5))
log('lock mesh', len(mesh['V']), 'verts', len(mesh['F']), 'faces; fly', len(fly_m['V']), '; scalp', len(scalp['V']))
tex = os.path.join(OUT, 'hair_atlas.png')
allm = LK.merge(mesh, fly_m)
# angel ring: ONE world height for every lock (a continuous band round the head), found on each centreline
z_ring = head.c[2] + 0.8 * head.r[2]
for r in allm['recs']:
    if r['lock'] < 0:
        continue
    C = specs[r['lock']].C
    tt = np.linspace(0, 1, len(C))
    below = np.nonzero((C[:-1, 2] - z_ring) * (C[1:, 2] - z_ring) <= 0)[0]      # first crossing, either way
    if len(below):
        i = below[0]; f = abs(C[i, 2] - z_ring) / max(abs(C[i, 2] - C[i + 1, 2]), 1e-9)
        t0 = tt[i] + f * (tt[1] - tt[0])
        seg = np.linalg.norm(np.diff(C, axis=0), axis=1).sum()
        r['ring_t'] = (t0, t0 + 0.034 / max(seg, 0.05))      # ~3.4 cm tall band
FN.paint_atlas(allm, atlas, path=tex, head=head, pal=PARAMS.get('palette'))
# atlas layout for texture repaint (e.g. the ComfyUI texture agent): one column strip per lock / sub-lock,
# u across the lock (0 / 1 = edges), v root (strip top) -> tip (strip bottom); the scalp slot is flat under-colour
layout = {'atlas': os.path.basename(tex), 'size': atlas.size, 'cols': atlas.cols, 'rows': atlas.rows,
          'strip_px': [atlas.size // atlas.cols, atlas.size // atlas.rows],
          'inset': {'u': [0.08, 0.92], 'v': [0.015, 0.985]}, 'scalp_slot': scalp_slot,
          'slots': [{'slot': r['slot'], 'lock': int(r['lock']), 'layer': r['layer'], 'tone': float(r.get('tone', 0)),
                     'ring_t': r.get('ring_t'), 'rect_px': [(r['slot'] % atlas.cols) * (atlas.size // atlas.cols),
                                                             (r['slot'] // atlas.cols) * (atlas.size // atlas.rows),
                                                             atlas.size // atlas.cols, atlas.size // atlas.rows]}
                    for r in allm['recs']]}
json.dump(layout, open(os.path.join(OUT, 'atlas_layout.json'), 'w'), indent=1, default=float)
for m_ in list(bpy.data.materials):
    if m_.name in ('Hair', 'HairFly') and m_.users == 0:
        bpy.data.materials.remove(m_)
mat = FN.hair_material('HK_Hair', tex, shade_shift=-0.1, double_sided=True)   # like VRoid hair (cull off)
mat_fly = FN.hair_material('HK_HairFly', tex, shade_shift=-0.1, double_sided=True)
hair = LK.to_object(LK.merge(mesh, scalp), 'Hair', mat, fix_normals=False)   # winding is outward by construction
flyo = LK.to_object(fly_m, 'HairFly', mat_fly) if len(fly_m['V']) else None
FN.proxy_normals([o for o in (hair, flyo) if o], inflate=0.012, voxel=0.01, smooth_iter=40, mix=1.0)
log('proxy normals transferred')

# ---------------------------------------------------------------------------------------------- spring chains
phys = []
hb = opt('--head-bone', 'head')
if arm and hb in arm.data.bones and not FAST:
    groups = {'BR': (-180, -120), 'R': (-120, -60), 'FR': (-60, 0), 'FL': (0, 60), 'L': (60, 120), 'BL': (120, 180.01)}
    back = [i for i, s in enumerate(specs) if abs(core.Head.angles(head, s.C[0])[0]) > 150]
    phys = FN.chains(arm, hb, head, specs, LK.merge(mesh, scalp), hair, groups, joints=4)
    hair.matrix_parent_inverse = arm.matrix_world.inverted()
    if flyo:
        flyo.parent = arm; flyo.matrix_parent_inverse = arm.matrix_world.inverted()
        g = flyo.vertex_groups.new(name=hb); g.add(list(range(len(flyo.data.vertices))), 1.0, 'REPLACE')
        md = flyo.modifiers.new('Armature', 'ARMATURE'); md.object = arm
    log('spring chains', [p['rootBone'] for p in phys])

# ---------------------------------------------------------------------------------------------- LODs (hair-only GLBs)
def export(path, objs=None, tangents=True):
    if objs is not None:
        bpy.ops.object.select_all(action='DESELECT')
        for o in objs:
            o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=objs is not None,
                              export_tangents=tangents, export_extras=True, export_yup=True, export_apply=False,
                              export_animations=False)


if not FAST:
    lod1 = LK.build_mesh(specs, LK.Atlas(64, 4, 2048), lod=1)       # same slot order -> same atlas
    lod2 = LK.cards(specs, [next(r['slot'] for r in mesh['recs'] if r['lock'] == i) for i in range(len(specs))], atlas)
    stats = {'locks': len(specs), 'sub_locks': len(mesh['recs']), 'flyaways': len(fly_s), 'gn_essentials': gn_used,
             'lod0_tris': int(sum(2 if len(f) == 4 else 1 for f in mesh['F']) + sum(2 for f in fly_m['F']) + len(scalp['F'])),
             'lod1_tris': int(sum(2 if len(f) == 4 else 1 for f in lod1['F'])), 'lod2_tris': int(2 * len(lod2['F'])),
             'chains': phys, 'head': {'c': head.c.tolist(), 'r': head.r.tolist()}}
    o1 = LK.to_object(lod1, 'Hair_LOD1', mat); o2 = LK.to_object(lod2, 'Hair_LOD2', mat_fly)
    FN.proxy_normals([o1], inflate=0.012, voxel=0.01, smooth_iter=40)
    export(os.path.join(OUT, 'hair_lod1.glb'), [o1]); export(os.path.join(OUT, 'hair_lod2.glb'), [o2])
    bpy.data.objects.remove(o1, do_unlink=True); bpy.data.objects.remove(o2, do_unlink=True)

    # guides as a Blender curves object (kept in the .blend for artists)
    gobj = ST.curves_object(np.stack([core.resample(g, 30) for g in guides]), 'HK_Guides')
    gobj.hide_render = True
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'hair_build.blend'))
    bpy.data.objects.remove(gobj, do_unlink=True)
export(os.path.join(OUT, 'avatar_hair.glb'))
# profile
prof = json.load(open(opt('--profile'), encoding='utf-8')) if opt('--profile') else {'look': {}}
prof.setdefault('look', {})
prof['look']['hairMeshes'] = ['Hair', 'HairFly']
prof['look']['hairShine'] = float(opt('--shine', 0.0))
if phys:
    prof.setdefault('physics', {})['chains'] = phys
    prof['physics']['enabled'] = True
prof['modelFile'] = 'avatar_hair.glb'
json.dump(prof, open(os.path.join(OUT, 'profile.json'), 'w'), indent=1)
if not FAST:
    json.dump(stats, open(os.path.join(OUT, 'stats.json'), 'w'), indent=1)
    log('stats', {k: v for k, v in stats.items() if k != 'chains'})
log('HAIR_KIT_DONE', OUT)
