"""
review_char.render_passes — renders a character GLB the way the VTube Pro studio draws it, from many angles, and
dumps the per-pixel data the failure detectors need.  Runs INSIDE Blender (headless, CPU Cycles, low priority):

    tools\\blender_low.cmd -b --factory-startup --python blender/review_char/render_passes.py -- \\
        <model.glb> <out_dir> [--profile profile.json] [--views bust,head,full] [--res 1024] [--ss 2] [--threads N]

How it stays faithful to the app without a GPU:
  * Cycles renders EMISSION-ONLY data passes (1 sample, point filter, so every pixel is an exact first hit):
    albedo (base colour x texture x vertex colour), shading normal (custom normals included), world position,
    ids (object, material, flags) and emission. Alpha-clip + back-face culling of single-sided materials are
    honoured exactly like three.js (culled back faces are transparent).
  * numpy then evaluates the app's anime cel shader (src/avatar/toon.ts ANIME_FRAG_MAIN: terminator at 0.2 +
    vtpShadeShift, albedo-derived saturated shade tint, warm terminator band, fresnel rim, gloss highlight, the
    hair angel ring) with the stage key light (Stage.ts KEY_DIR, fixed to the camera, like the studio where the
    avatar turns in front of a fixed camera + light), plus a screen-space version of the inverted-hull outline
    (constant ~1.45 px at 1024, coloured lineart), no tone mapping, sRGB out — and supersamples 2x for AA.
  * The same passes give a CLAY render (forms only) and a LIGHT-FLIP render (key from the other side: exposes
    baked lighting in textures).

Outputs per view: <view>.png (toon), <view>_clay.png, <view>.npz (downsampled data maps for the detectors), plus
geom.npz (world-space triangles, object / material ids) and scene.json (materials, views, cameras, light dirs).
"""
from __future__ import annotations

import json
import math
import os
import re
import sys
import time

import bpy
import numpy as np
from mathutils import Matrix, Vector

ARGV = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
SRC, OUT = os.path.abspath(ARGV[0]), os.path.abspath(ARGV[1])


def opt(name, default=None):
    return ARGV[ARGV.index(name) + 1] if name in ARGV else default


RES = int(opt('--res', 1024))
SS = int(opt('--ss', 2))
FRAMINGS = (opt('--views') or 'bust,head,full').split(',')
ONLY = opt('--only')           # comma list of view names
PROFILE = json.load(open(opt('--profile'), encoding='utf-8')) if opt('--profile') else {}
LOOK = PROFILE.get('look', {}) or {}
os.makedirs(OUT, exist_ok=True)
T0 = time.time()


def log(*a):
    print('[review]', f'{time.time() - T0:6.1f}s', *a, flush=True)


# ----------------------------------------------------------------------------------------------- scene
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=SRC)


def _glb_json(path):
    import struct
    with open(path, 'rb') as f:
        head = f.read(20)
        if head[:4] != b'glTF':
            return {}
        n = struct.unpack('<I', head[12:16])[0]
        return json.loads(f.read(n))


_J = _glb_json(SRC)
if 'VRM' in (_J.get('extensionsUsed') or []) or opt('--flip'):
    # VRM 0.x models face glTF -Z: turn them round so every model faces the review cameras like in the studio
    for o in bpy.data.objects:
        if o.parent is None:
            o.matrix_world = Matrix.Rotation(math.pi, 4, 'Z') @ o.matrix_world
    bpy.context.view_layer.update()
for o in bpy.data.objects:
    if o.animation_data:
        o.animation_data.action = None
    if o.type == 'ARMATURE':
        o.data.pose_position = 'REST'
for o in bpy.data.objects:
    if o.type == 'MESH' and o.data.shape_keys:
        for kb in o.data.shape_keys.key_blocks[1:]:
            kb.value = 0.0
bpy.context.view_layer.update()
if opt('--hide'):
    _hx = re.compile(opt('--hide'), re.I)
    for o in list(bpy.data.objects):
        if o.type == 'MESH' and (_hx.search(o.name) or any(sl.material and _hx.search(sl.material.name) for sl in o.material_slots)):
            bpy.data.objects.remove(o, do_unlink=True)
meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o.visible_get() and not o.hide_render]
arm = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
log('imported', len(meshes), 'meshes')

HAIR_RE = re.compile(r'hair|bang|fringe|ponytail|twintail', re.I)
CAVITY_RE = re.compile(r'mouth|tongue|interior|cavity|throat|gum', re.I)
HAIR_LIST = set(LOOK.get('hairMeshes') or [])


def strip_idx(n):
    return re.sub(r'(\.\d{3}|_\d+)$', '', n)


# ----------------------------------------------------------------------------------------------- materials
MATS = []               # global material table (index = id pass value)
MAT_ID = {}


def principled(m):
    return next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None) if m and m.use_nodes else None


def src_of(sock):
    return sock.links[0].from_socket if sock is not None and sock.is_linked else None


for oi, o in enumerate(meshes):
    o.pass_index = oi + 1
    for sl in o.material_slots:
        m = sl.material
        if m is None or m.name in MAT_ID:
            continue
        b = principled(m)
        info = {'name': m.name, 'culled': bool(getattr(m, 'use_backface_culling', False)),
                'shadeShift': float(m.get('vtpShadeShift', 0.0)) if isinstance(m.get('vtpShadeShift'), (int, float)) else 0.0,
                'rimK': None, 'roughness': 1.0, 'metallic': 1.0, 'textured': False, 'unlit': b is None}
        if isinstance(m.get('vtpRim'), (int, float)):
            info['rimK'] = max(0.0, min(2.0, float(m['vtpRim'])))
        if b is not None:
            r, mt = b.inputs['Roughness'], b.inputs['Metallic']
            info['roughness'] = float(r.default_value) if not r.is_linked else -1.0
            info['metallic'] = float(mt.default_value) if not mt.is_linked else 0.0
            info['textured'] = b.inputs['Base Color'].is_linked
        MAT_ID[m.name] = len(MATS) + 1
        MATS.append(info)
OBJS = []
for o in meshes:
    names = {o.name, o.data.name, strip_idx(o.name), strip_idx(o.data.name)}
    mats = [sl.material.name for sl in o.material_slots if sl.material]
    # like the app's isHair(): three.js splits a glTF mesh into one primitive per material and tests the MESH name or
    # the MATERIAL name of each primitive, so hair is decided per material (+ hair-named objects)
    hair = bool(HAIR_LIST & names) if HAIR_LIST else any(HAIR_RE.search(n) for n in names)
    OBJS.append({'name': o.name, 'mesh': o.data.name, 'hair': hair, 'materials': mats})
for info in MATS:
    by_name = (info['name'] in HAIR_LIST) if HAIR_LIST else bool(HAIR_RE.search(info['name']))
    info['hairAny'] = by_name or any(info['name'] in ob['materials'] and ob['hair'] for ob in OBJS)
    if info['rimK'] is None:
        info['rimK'] = 0.1 if CAVITY_RE.search(info['name']) else 1.0


def build_data_material(m, mid):
    """Rewire a copy of the material's tree: Emission(<selected data>) mixed with Transparent by alpha-clip and
    back-face culling. Returns a function mode -> relink."""
    nt = m.node_tree
    nodes, links = nt.nodes, nt.links
    b = principled(m)
    out = next((n for n in nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output), None) or \
        next((n for n in nodes if n.type == 'OUTPUT_MATERIAL'), None)
    if out is None:
        out = nodes.new('ShaderNodeOutputMaterial')
    if b is not None:
        base = src_of(b.inputs['Base Color'])
        base_val = tuple(b.inputs['Base Color'].default_value)
        alpha = src_of(b.inputs['Alpha'])
        alpha_val = float(b.inputs['Alpha'].default_value)
        ec = b.inputs.get('Emission Color')
        es = b.inputs.get('Emission Strength')
        em = src_of(ec)
        em_val = tuple(ec.default_value) if ec is not None else (0, 0, 0, 1)
        em_str = float(es.default_value) if es is not None else 0.0
    else:
        tex = next((n for n in nodes if n.type == 'TEX_IMAGE'), None)
        base = tex.outputs['Color'] if tex else None
        base_val = (0.8, 0.8, 0.8, 1)
        alpha = tex.outputs['Alpha'] if tex else None
        alpha_val = 1.0
        em, em_val, em_str = None, (0, 0, 0, 1), 0.0
    geo = nodes.new('ShaderNodeNewGeometry')
    obi = nodes.new('ShaderNodeObjectInfo')
    emit = nodes.new('ShaderNodeEmission'); emit.inputs['Strength'].default_value = 1.0
    transp = nodes.new('ShaderNodeBsdfTransparent')
    mix = nodes.new('ShaderNodeMixShader')
    # visibility = alpha > 0.5 and not (culled and backfacing)
    a_gt = nodes.new('ShaderNodeMath'); a_gt.operation = 'GREATER_THAN'; a_gt.inputs[1].default_value = 0.5
    if alpha is not None:
        links.new(alpha, a_gt.inputs[0])
    else:
        a_gt.inputs[0].default_value = alpha_val
    vis = a_gt
    if MATS[mid - 1]['culled']:
        inv = nodes.new('ShaderNodeMath'); inv.operation = 'SUBTRACT'; inv.inputs[0].default_value = 1.0
        links.new(geo.outputs['Backfacing'], inv.inputs[1])
        mul = nodes.new('ShaderNodeMath'); mul.operation = 'MULTIPLY'
        links.new(a_gt.outputs[0], mul.inputs[0]); links.new(inv.outputs[0], mul.inputs[1])
        vis = mul
    # id-mode visibility: culled back faces stay OPAQUE there (flag 1) so see-through holes can be counted
    links.new(vis.outputs[0], mix.inputs['Fac'])
    links.new(transp.outputs[0], mix.inputs[1])
    links.new(emit.outputs[0], mix.inputs[2])
    for l in list(out.inputs['Surface'].links):
        links.remove(l)
    links.new(mix.outputs[0], out.inputs['Surface'])
    if out.inputs.get('Volume') is not None:
        for l in list(out.inputs['Volume'].links):
            links.remove(l)
    # data sources
    nrm_enc = nodes.new('ShaderNodeVectorMath'); nrm_enc.operation = 'MULTIPLY_ADD'
    links.new(geo.outputs['Normal'], nrm_enc.inputs[0])
    nrm_enc.inputs[1].default_value = (0.5, 0.5, 0.5); nrm_enc.inputs[2].default_value = (0.5, 0.5, 0.5)
    pos_enc = nodes.new('ShaderNodeVectorMath'); pos_enc.operation = 'ADD'
    links.new(geo.outputs['Position'], pos_enc.inputs[0]); pos_enc.inputs[1].default_value = (10.0, 10.0, 10.0)
    ids = nodes.new('ShaderNodeCombineXYZ')
    links.new(obi.outputs['Object Index'], ids.inputs[0])
    ids.inputs[1].default_value = float(mid)
    flag = nodes.new('ShaderNodeMath'); flag.operation = 'MULTIPLY_ADD'
    links.new(geo.outputs['Backfacing'], flag.inputs[0]); flag.inputs[1].default_value = 1.0
    flag.inputs[2].default_value = 2.0 if MATS[mid - 1]['unlit'] else 0.0
    links.new(flag.outputs[0], ids.inputs[2])
    alb = nodes.new('ShaderNodeRGB'); alb.outputs[0].default_value = base_val
    emc = nodes.new('ShaderNodeRGB'); emc.outputs[0].default_value = em_val
    ems = nodes.new('ShaderNodeVectorMath'); ems.operation = 'SCALE'
    links.new(em if em is not None else emc.outputs[0], ems.inputs[0]); ems.inputs['Scale'].default_value = em_str
    srcs = {'albedo': base if base is not None else alb.outputs[0], 'normal': nrm_enc.outputs[0],
            'position': pos_enc.outputs[0], 'ids': ids.outputs[0], 'emission': ems.outputs[0]}

    def relink(mode):
        for l in list(emit.inputs['Color'].links):
            links.remove(l)
        links.new(srcs[mode], emit.inputs['Color'])
        for l in list(mix.inputs['Fac'].links):
            links.remove(l)
        if mode == 'ids':
            links.new(a_gt.outputs[0], mix.inputs['Fac'])     # culled back faces opaque, flagged
        else:
            links.new(vis.outputs[0], mix.inputs['Fac'])
    return relink


RELINK = []
done = set()
for o in meshes:
    for sl in o.material_slots:
        m = sl.material
        if m is None or m.name in done:
            continue
        done.add(m.name)
        RELINK.append(build_data_material(m, MAT_ID[m.name]))
# meshes without material: give one
for o in meshes:
    if not o.material_slots or all(sl.material is None for sl in o.material_slots):
        m = bpy.data.materials.new('__none'); m.use_nodes = True
        o.data.materials.append(m)
        MAT_ID[m.name] = len(MATS) + 1
        MATS.append({'name': m.name, 'culled': False, 'shadeShift': 0.0, 'rimK': 1.0, 'roughness': 1.0,
                     'metallic': 1.0, 'textured': False, 'unlit': False, 'hairAny': False})
        RELINK.append(build_data_material(m, MAT_ID[m.name]))


def set_mode(mode):
    for f in RELINK:
        f(mode)


# ----------------------------------------------------------------------------------------------- geometry dump
dg = bpy.context.evaluated_depsgraph_get()
GP, GT, GM, GO = [], [], [], []
base_v = 0
for oi, o in enumerate(meshes):
    ev = o.evaluated_get(dg)
    me = ev.to_mesh()
    me.calc_loop_triangles()
    M = np.array(o.matrix_world)
    P = np.zeros(len(me.vertices) * 3, np.float64); me.vertices.foreach_get('co', P)
    P = P.reshape(-1, 3) @ M[:3, :3].T + M[:3, 3]
    T = np.zeros(len(me.loop_triangles) * 3, np.int64); me.loop_triangles.foreach_get('vertices', T)
    mi = np.zeros(len(me.loop_triangles), np.int64); me.loop_triangles.foreach_get('material_index', mi)
    slot_ids = [MAT_ID.get(sl.material.name, 0) if sl.material else 0 for sl in o.material_slots] or [0]
    gm = np.array(slot_ids)[np.clip(mi, 0, len(slot_ids) - 1)]
    GP.append(P.astype(np.float32)); GT.append(T.reshape(-1, 3) + base_v); GM.append(gm); GO.append(np.full(len(gm), oi + 1))
    base_v += len(P)
    ev.to_mesh_clear()
GP = np.concatenate(GP); GT = np.concatenate(GT); GM = np.concatenate(GM); GO = np.concatenate(GO)
np.savez_compressed(os.path.join(OUT, 'geom.npz'), P=GP, T=GT.astype(np.int32), mat=GM.astype(np.int16), obj=GO.astype(np.int16))
lo, hi = GP.min(0).astype(float), GP.max(0).astype(float)
H = hi[2] - lo[2]
log('geometry', len(GP), 'verts', len(GT), 'tris, height %.3f' % H)


def bone(n):
    if not arm:
        return None
    for b in arm.data.bones:
        if b.name.lower() == n.lower() or b.name.lower().endswith(n.lower()):
            return np.array(arm.matrix_world @ b.head_local)
    return None


head = bone('head')
top = hi[2]
if head is None:
    head = np.array([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, top - 0.12 * H])
cx = float(head[0])
# head centre: middle between the head bone and the top of the head geometry near the axis
near = GP[(np.abs(GP[:, 0] - cx) < 0.12) & (GP[:, 2] > head[2])]
head_top = float(np.percentile(near[:, 2], 99.7)) if len(near) else top
if bone('head') is not None:
    head_top = min(head_top, float(bone('head')[2]) + 0.24)      # a runaway spike must not move the framing
head_c = np.array([cx, float(head[1]), (head[2] + head_top) / 2 - 0.01])
# forward: the character faces -Y (glTF +Z)
FRAMES = {
    'bust': (np.array([cx, head_c[1] + 0.02, head_top + 0.03 - 0.5 * 0.34 * H]), 0.34 * H),
    'head': (np.array([cx, head_c[1], head_c[2] - 0.04]), 0.42),
    'full': (np.array([cx, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]), H * 1.08),
}
VIEWS = []
if 'bust' in FRAMINGS:
    VIEWS += [('bust_front', 'bust', 0, 0), ('bust_34_left', 'bust', 35, 0), ('bust_34_right', 'bust', -35, 0),
              ('bust_profile_left', 'bust', 90, 0), ('bust_profile_right', 'bust', -90, 0),
              ('bust_back', 'bust', 180, 0), ('bust_back34_left', 'bust', 140, 0), ('bust_back34_right', 'bust', -140, 0),
              ('bust_low', 'bust', 25, -22), ('bust_high', 'bust', -25, 28)]
if 'head' in FRAMINGS:
    VIEWS += [('head_front', 'head', 0, 0), ('head_34_left', 'head', 40, 0), ('head_34_right', 'head', -40, 0),
              ('head_profile_left', 'head', 80, 0), ('head_top', 'head', 0, 70)]
if 'full' in FRAMINGS:
    VIEWS += [('full_front', 'full', 0, 0), ('full_34_left', 'full', 35, 0)]
if opt('--custom'):
    # name:framing:yaw:pitch,...  (reference matching: exact camera per reference view)
    VIEWS = []
    for spec in opt('--custom').split(','):
        n_, fr_, y_, p_ = spec.split(':')
        VIEWS.append((n_, fr_, float(y_), float(p_)))
if ONLY:
    keep = set(ONLY.split(','))
    VIEWS = [v for v in VIEWS if v[0] in keep]

sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.device = 'CPU'
sc.cycles.samples = 1
sc.cycles.use_adaptive_sampling = False
sc.cycles.use_denoising = False
sc.cycles.filter_width = 0.01
sc.cycles.max_bounces = 0
sc.cycles.transparent_max_bounces = 64
sc.cycles.use_light_tree = False
sc.render.use_persistent_data = True
sc.render.film_transparent = True
sc.view_settings.view_transform = 'Standard'
sc.render.resolution_x = sc.render.resolution_y = RES * SS
sc.render.resolution_percentage = 100
sc.render.image_settings.file_format = 'OPEN_EXR'
sc.render.image_settings.color_depth = '32'
sc.render.image_settings.color_mode = 'RGBA'
ncpu = os.cpu_count() or 4
sc.render.threads_mode = 'FIXED'
sc.render.threads = int(opt('--threads', max(2, ncpu - 4)))
w = bpy.data.worlds.new('W'); sc.world = w; w.use_nodes = True
w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.0
cam = bpy.data.objects.new('ReviewCam', bpy.data.cameras.new('ReviewCam'))
sc.collection.objects.link(cam); sc.camera = cam
cam.data.sensor_fit = 'VERTICAL'
cam.data.angle = math.radians(28.0)          # the studio camera's vertical FOV
cam.data.clip_start = 0.01; cam.data.clip_end = 100

KEY_CAM = np.array([1.55, 2.3, 2.35]); KEY_CAM /= np.linalg.norm(KEY_CAM)   # Stage.ts KEY_DIR, camera frame


def place(center, span, yaw, pitch):
    a, p = math.radians(yaw), math.radians(pitch)
    d = np.array([math.sin(a) * math.cos(p), -math.cos(a) * math.cos(p), math.sin(p)])
    dist = (span / 2) / math.tan(math.radians(14.0)) + 0.15
    pos = center + d * dist
    fwd = -d
    right = np.cross(fwd, [0, 0, 1.0]); right /= np.linalg.norm(right) if np.linalg.norm(right) > 1e-6 else 1
    up = np.cross(right, fwd)
    R = np.stack([right, up, -fwd], 1)
    cam.matrix_world = Matrix(((R[0, 0], R[0, 1], R[0, 2], pos[0]), (R[1, 0], R[1, 1], R[1, 2], pos[1]),
                               (R[2, 0], R[2, 1], R[2, 2], pos[2]), (0, 0, 0, 1)))
    L = R @ KEY_CAM
    return pos, fwd, right, up, L


def render_mode(path):
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path)
    W_, H_ = img.size
    a = np.empty(W_ * H_ * 4, np.float32)
    img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    os.remove(path)
    return a.reshape(H_, W_, 4)[::-1]


# ----------------------------------------------------------------------------------------------- shading (numpy)
def srgb_to_lin(c):
    c = np.asarray(c, np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def hexlin(h):
    h = h.lstrip('#')
    return srgb_to_lin([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])


def smooth(e0, e1, x):
    t = np.clip((x - e0) / np.where(np.abs(e1 - e0) < 1e-9, 1e-9, e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


SHADE = hexlin(LOOK.get('shadowTint') or '#ceb6c2')
SHADE_COOL = hexlin('#b4b8d4')
RIM = float(LOOK.get('rim', 0.5)); SOFT = float(LOOK.get('softness', 0.15)); HAIRSHINE = float(LOOK.get('hairShine', 0.6))
GLOSSK = float(LOOK.get('gloss', 1.0))
BG = srgb_to_lin([27 / 255, 30 / 255, 38 / 255])
MAT_SHIFT = np.zeros(len(MATS) + 2, np.float32); MAT_RIMK = np.ones(len(MATS) + 2, np.float32)
MAT_GLOSS = np.zeros(len(MATS) + 2, np.float32); MAT_HAIR = np.zeros(len(MATS) + 2, bool)
for i, m in enumerate(MATS, 1):
    MAT_SHIFT[i] = m['shadeShift']; MAT_RIMK[i] = m['rimK']; MAT_HAIR[i] = m['hairAny']
    r, mt = m['roughness'], m['metallic']
    if r >= 0 and not (mt >= 0.999 and r >= 0.999) and not CAVITY_RE.search(m['name']):
        MAT_GLOSS[i] = np.clip((0.72 - r) / 0.5, 0, 1) * GLOSSK
# per-object bbox centres for the hair ring
OBJ_C = np.zeros((len(meshes) + 2, 3), np.float32)
for oi in range(len(meshes)):
    sel = GT[GO == oi + 1]
    if len(sel):
        Pv = GP[np.unique(sel)]
        OBJ_C[oi + 1] = (Pv.min(0) + Pv.max(0)) / 2


def shade(A, N, P, mat, obj, cov, cam_pos, L, unlit, clay=False):
    """The app's ANIME_FRAG_MAIN (toon.ts), per pixel. A linear albedo, N world normal, P world position."""
    if clay:
        A = np.broadcast_to(srgb_to_lin([0.72, 0.71, 0.70]), A.shape).astype(np.float32)
    V = cam_pos[None, None] - P
    V /= np.maximum(np.linalg.norm(V, axis=-1, keepdims=True), 1e-9)
    ndl = (N * L[None, None]).sum(-1)
    w2 = 0.015 + (0.22 - 0.015) * SOFT
    sh = MAT_SHIFT[mat] if not clay else 0.0
    lit = smooth(0.2 + sh - w2, 0.2 + sh + w2, ndl)
    la = (A * [0.2126, 0.7152, 0.0722]).sum(-1, keepdims=True)
    sat = np.maximum(la + (A - la) * 1.35, 0)
    mx, mn = A.max(-1, keepdims=True), A.min(-1, keepdims=True)
    chroma = np.clip((mx - mn) / np.maximum(mx, 1e-3) * 2.5, 0, 1)
    shade_c = sat * (SHADE_COOL + (SHADE - SHADE_COOL) * chroma)
    litc = A * (0.96 + 0.08 * smooth(0.25, 0.95, ndl))[..., None]
    col = shade_c + (litc - shade_c) * lit[..., None]
    band = (lit * (1 - lit) * 4)[..., None]
    tgt = sat * (1 + (SHADE - 1) * 0.45)
    col = col + (tgt - col) * band * 0.35 * chroma
    fres = 1 - np.clip((N * V).sum(-1), 0, 1)
    rim = smooth(0.55, 0.92, fres) * (0.45 + 0.55 * lit)
    rk = MAT_RIMK[mat] if not clay else 1.0
    col = col + (A + (1 - A) * 0.55) * (rim * RIM * rk * 0.45)[..., None]
    if not clay:
        g = MAT_GLOSS[mat]
        if (g > 0.02).any():
            Hv = L[None, None] + V; Hv /= np.maximum(np.linalg.norm(Hv, axis=-1, keepdims=True), 1e-9)
            shin = 18 + (140 - 18) * g
            s = np.power(np.maximum((N * Hv).sum(-1), 0), shin) - 0.45
            hl = (s > 0) * lit * (g > 0.02)
            tgt = (A + (1 - A) * 0.75) * 1.02
            col = col + (tgt - col) * (hl * np.clip(g * 1.3, 0, 0.85))[..., None]
        hair = MAT_HAIR[mat]
        if hair.any() and HAIRSHINE > 0:
            up = np.array([0, 0, 1.0], np.float32)
            T = up[None, None] - N * (N * up).sum(-1, keepdims=True) + 1e-5
            T /= np.linalg.norm(T, axis=-1, keepdims=True)
            Ts = T + N * 0.3; Ts /= np.linalg.norm(Ts, axis=-1, keepdims=True)
            Hh = V + L[None, None] * 0.5; Hh /= np.linalg.norm(Hh, axis=-1, keepdims=True)
            D = (Ts * Hh).sum(-1)
            rel = P - OBJ_C[obj]
            # character right = -X in Blender (faces -Y); forward = -Y
            ang = np.arctan2(-rel[..., 0], -rel[..., 1])
            tri = np.abs((ang * 4.5) % 1.0 - 0.5) * 2
            tri2 = np.abs((ang * 11.0 + 0.3) % 1.0 - 0.5) * 2
            half = 0.09
            lo_ = half * (0.6 + 1.6 * tri * tri + 0.5 * tri2)
            e1 = half * 0.8 - D; e2 = D + lo_
            ring = (e1 > 0) * (e2 > 0) * smooth(0.05, 0.35, (N * V).sum(-1))
            ringc = A * 1.9 + 0.06; ringc = ringc + (1 - ringc) * 0.3
            k = (ring * HAIRSHINE * (0.55 + 0.45 * lit) * hair)[..., None]
            col = col + (ringc - col) * k
    col = np.where(unlit[..., None], A, col)
    return col, lit


DISK = [(dy, dx) for dy in range(-4, 5) for dx in range(-4, 5)]


def shift(a, dy, dx, fill):
    out = np.full_like(a, fill)
    H_, W_ = a.shape[:2]
    ys, yd = (slice(0, H_ - dy), slice(dy, H_)) if dy >= 0 else (slice(-dy, H_), slice(0, H_ + dy))
    xs, xd = (slice(0, W_ - dx), slice(dx, W_)) if dx >= 0 else (slice(-dx, W_), slice(0, W_ + dx))
    out[yd, xd] = a[ys, xs]
    return out


def outline(depth, cov, A, eps, rad):
    """Screen-space inverted hull: a pixel is covered by a nearer surface's hull if an occluding-contour pixel of
    that surface lies within `rad` px and is nearer by > eps. Returns mask + the line colour (linear)."""
    D = np.where(cov, depth, np.inf)
    # contour pixels: have a 4-neighbour that is background or deeper by eps
    E = np.zeros_like(cov)
    for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
        E |= cov & (shift(D, dy, dx, np.inf) > D + eps)
    DE = np.where(E, D, np.inf)
    best = np.full(D.shape, np.inf, np.float32)
    bestA = np.zeros_like(A)
    for dy, dx in DISK:
        if dy * dy + dx * dx > rad * rad:
            continue
        s = shift(DE, dy, dx, np.inf)
        upd = s < best
        best = np.where(upd, s, best)
        sa = shift(A, dy, dx, 0.0)
        bestA = np.where(upd[..., None], sa, bestA)
    mask = best < D - eps
    l = (bestA * [0.2126, 0.7152, 0.0722]).sum(-1, keepdims=True)
    deep = np.maximum(l + (bestA - l) * 1.5, 0) * 0.22
    lc = hexlin('#141414') + (np.minimum(deep, 0.09) - hexlin('#141414')) * 0.7
    return mask, lc


def down(a, k):
    if k == 1:
        return a
    H_, W_ = a.shape[:2]
    return a.reshape(H_ // k, k, W_ // k, k, *a.shape[2:]).mean((1, 3))


def pick(a, k):
    return a[::k, ::k] if k > 1 else a


def save_png(path, rgb):
    img = bpy.data.images.new('out', rgb.shape[1], rgb.shape[0], alpha=True)
    px = np.ones((rgb.shape[0], rgb.shape[1], 4), np.float32)
    px[..., :3] = rgb
    img.pixels.foreach_set(px[::-1].ravel())
    img.filepath_raw = path; img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)


# ----------------------------------------------------------------------------------------------- render loop
MODES = ['albedo', 'normal', 'position', 'ids', 'emission']
CAMS = {}
for v, fr, yaw, pitch in VIEWS:
    c, span = FRAMES[fr]
    CAMS[v] = place(c, span, yaw, pitch) + (span,)
tmp = os.path.join(OUT, '_tmp.exr')
DATA = {v: {} for v, *_ in VIEWS}
for mode in MODES:
    set_mode(mode)
    for v, fr, yaw, pitch in VIEWS:
        place(FRAMES[fr][0], FRAMES[fr][1], yaw, pitch)
        DATA[v][mode] = render_mode(tmp).astype(np.float32 if mode in ('position', 'ids') else np.float16)
    log('mode', mode, 'done')

scene_info = {'model': SRC, 'res': RES, 'ss': SS, 'materials': MATS, 'objects': OBJS, 'views': [], 'look': LOOK,
              'height': H, 'lo': lo.tolist(), 'hi': hi.tolist(), 'head_center': head_c.tolist(), 'head_top': head_top}
for v, fr, yaw, pitch in VIEWS:
    pos, fwd, right, up, L, span = CAMS[v]
    d = DATA[v]
    cov = d['ids'][..., 3] > 0.5
    covd = d['albedo'][..., 3].astype(np.float32) > 0.5            # visible surface in the colour passes
    A = np.clip(d['albedo'][..., :3].astype(np.float32), 0, None)
    N = d['normal'][..., :3].astype(np.float32) * 2 - 1
    N /= np.maximum(np.linalg.norm(N, axis=-1, keepdims=True), 1e-6)
    P = d['position'][..., :3] - 10.0
    E = d['emission'][..., :3].astype(np.float32)
    idd = d['ids'][..., :3]
    obj = np.rint(idd[..., 0]).astype(np.int32); mat = np.rint(idd[..., 1]).astype(np.int32)
    flg = np.rint(idd[..., 2]).astype(np.int32)
    obj[~cov] = 0; mat[~cov] = 0
    # colour passes see through culled back faces: take obj/mat for those pixels from ... (unknown) -> mark
    mat_c = np.where(covd, mat, 0)
    culled_tab = np.array([False] + [m['culled'] for m in MATS] + [False])
    back_culled = cov & ((flg & 1) == 1) & culled_tab[np.clip(mat, 0, len(MATS) + 1)]
    # for pixels where the id pass hit a culled back face, the colour passes show what is behind: no id there
    mat_c = np.where(back_culled, 0, mat_c)
    obj_c = np.where(back_culled | ~covd, 0, obj)
    unlit = ((flg & 2) == 2) & covd
    depth = ((P - pos[None, None]) * fwd[None, None]).sum(-1)
    depth = np.where(covd, depth, np.inf).astype(np.float32)
    px_world = 2 * math.tan(math.radians(14)) * np.linalg.norm(pos - FRAMES[fr][0]) / (RES * SS)
    eps = max(0.0025, 6 * px_world)
    rad = max(1.3, 0.0014 * RES) * SS                               # hull width (px at supersampled res)
    results = {}
    for tag, clay, Ld in (('', False, L), ('_clay', True, L), ('_flip', False, L - 2 * right * (L @ right))):
        if tag == '_clay' and '--noclay' in ARGV:
            continue
        if tag == '_flip' and fr != 'bust':
            continue
        if tag == '_flip' and v != 'bust_front':
            continue
        col, lit = shade(A, N, P, mat_c, obj_c, covd, pos, Ld, unlit, clay=clay)
        col = col + (E if not clay else 0)
        col = np.where(covd[..., None], col, BG)
        om, lc = outline(depth, covd, A if not clay else np.full_like(A, 0.5), eps, rad)
        col = np.where(om[..., None], lc, col)
        rgb = lin_to_srgb(down(col, SS))
        save_png(os.path.join(OUT, f'{v}{tag}.png'), rgb)
        results[tag] = (rgb, lit, om)
    rgb, lit, om = results['']
    np.savez_compressed(os.path.join(OUT, f'{v}.npz'),
                        rgb=(rgb * 255 + 0.5).astype(np.uint8),
                        albedo=(lin_to_srgb(down(A, SS)) * 255 + 0.5).astype(np.uint8),
                        cov=down(covd.astype(np.float32), SS).astype(np.float16),
                        cov_any=pick(cov, SS), obj=pick(obj_c, SS).astype(np.int16), mat=pick(mat_c, SS).astype(np.int16),
                        back_culled=pick(back_culled, SS), backface=pick(covd & ((flg & 1) == 1), SS),
                        normal=pick(N, SS).astype(np.float16), depth=pick(depth, SS).astype(np.float32),
                        pos=pick(P, SS).astype(np.float32),
                        lit=down(lit.astype(np.float32), SS).astype(np.float16), outline=pick(om, SS),
                        ndv=pick(((N * (pos[None, None] - P)).sum(-1) / np.maximum(np.linalg.norm(pos[None, None] - P, axis=-1), 1e-9)), SS).astype(np.float16))
    scene_info['views'].append({'name': v, 'framing': fr, 'yaw': yaw, 'pitch': pitch, 'cam': pos.tolist(),
                                'fwd': fwd.tolist(), 'right': right.tolist(), 'up': up.tolist(), 'light': L.tolist(),
                                'span': span, 'px_world': px_world * SS})
    log('view', v)
json.dump(scene_info, open(os.path.join(OUT, 'scene.json'), 'w'), indent=1)
log('REVIEW_PASSES_DONE', OUT)
