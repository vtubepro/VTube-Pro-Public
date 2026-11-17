"""
Mouth-rig review renders for any avatar GLB with a bone-driven mouth (profile mouth.rig: 'jaw' or 'puppet').
Poses the rig exactly like the runtime (src/avatar/jawRig.ts: jaw turns +openAngle about the avatar's
left-right axis = chin down, a puppet's upper bone turns -upperAngle = head tips back) and renders the
face closed / half / full / overshoot (1.2, the runtime's clamp) in three passes:

    lit    EEVEE, textured (what the materials look like)
    albedo unlit base colour only (exposes texture bleeding / UV garbage without lighting)
    clay   grey, flat material (exposes tearing, stretching, geometry poking through)

    blender -b --factory-startup --python blender/rig_review.py -- model.glb out_dir [profile.json]

Writes out_dir/<pass>_<open>_<view>.png plus a contact sheet out_dir/sheet_<pass>.png, and dumps every
material's base-colour texture to out_dir/tex_<material>.png. Also prints a stretch report: per mesh, the
largest edge-length ratio (posed / rest) at full open, so tearing can be caught numerically.
"""
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

ARGV = sys.argv[sys.argv.index('--') + 1:]
src, out = ARGV[0], os.path.abspath(ARGV[1])
prof_path = ARGV[2] if len(ARGV) > 2 else os.path.join(os.path.dirname(os.path.abspath(src)), 'profile.json')
os.makedirs(out, exist_ok=True)
prof = json.load(open(prof_path, encoding='utf-8')) if os.path.isfile(prof_path) else {}
rig = (prof.get('mouth') or {}).get('rig') or {}

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=src)
for o in bpy.data.objects:
    if o.animation_data:
        o.animation_data.action = None
bpy.context.view_layer.update()
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o.visible_get()]
pb = arm.pose.bones


def find(name, pat):
    import re
    if name and name in pb:
        return pb[name]
    for b in pb:
        if re.match(pat, b.name.replace('.', '_'), re.I):
            return b
    return None


jaw = find(rig.get('jawBone'), r'^(jaw|jaw_?lower|lower_?jaw|chin)$')
upper = find(rig.get('upperBone'), r'^(upper_?head|head_?upper|upper_?jaw)$') if rig.get('kind') == 'puppet' else None
JA, UA = float(rig.get('openAngle', 12)), float(rig.get('upperAngle', 20))
print('RIG', rig.get('kind'), 'jaw', jaw and jaw.name, JA, 'upper', upper and upper.name, UA)
REST = {b.name: b.matrix_basis.copy() for b in pb}


def set_open(t):
    for b in pb:
        b.matrix_basis = REST[b.name].copy()
    bpy.context.view_layer.update()
    for b, ang in ((jaw, JA * t), (upper, -UA * t)):
        if b is None:
            continue
        piv = arm.matrix_world @ b.bone.head_local
        R = Matrix.Translation(piv) @ Matrix.Rotation(math.radians(ang), 4, 'X') @ Matrix.Translation(-piv)
        b.matrix = arm.matrix_world.inverted() @ R @ arm.matrix_world @ b.matrix
        bpy.context.view_layer.update()


def eval_verts(o):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = o.evaluated_get(dg)
    me = ev.to_mesh()
    v = np.array([ev.matrix_world @ x.co for x in me.vertices])
    e = np.array([tuple(x.vertices) for x in me.edges]) if len(me.edges) else np.zeros((0, 2), int)
    ev.to_mesh_clear()
    return v, e


# ---- stretch report (rest vs full open)
rest = {o.name: eval_verts(o) for o in meshes}
set_open(1.0)
for o in meshes:
    v0, e = rest[o.name]
    v1, _ = eval_verts(o)
    if not len(e):
        continue
    l0 = np.linalg.norm(v0[e[:, 0]] - v0[e[:, 1]], axis=1)
    l1 = np.linalg.norm(v1[e[:, 0]] - v1[e[:, 1]], axis=1)
    r = l1 / np.maximum(l0, 1e-6)
    k = int(np.argmax(r))
    print('STRETCH %-22s max %.2fx (edge %.4f -> %.4f at %s)  >1.5x: %d edges  >2x: %d' % (
        o.name, r[k], l0[k], l1[k], tuple(np.round(v0[e[k, 0]], 3)), int((r > 1.5).sum()), int((r > 2).sum())))
set_open(0.0)

# ---- texture dump
seen = set()
for o in meshes:
    for m in o.data.materials:
        if not m or m.name in seen or not m.node_tree:
            continue
        seen.add(m.name)
        for n in m.node_tree.nodes:
            if n.type == 'TEX_IMAGE' and n.image:
                try:
                    im = n.image
                    im.filepath_raw = os.path.join(out, 'tex_%s.png' % m.name.replace(' ', '_'))
                    im.file_format = 'PNG'
                    im.save()
                except Exception as ex:
                    print('tex dump failed', m.name, ex)

# ---- scene
sc = bpy.context.scene
try:
    sc.render.engine = 'BLENDER_EEVEE'
except TypeError:
    sc.render.engine = 'BLENDER_EEVEE_NEXT'
sc.render.film_transparent = False
sc.view_settings.view_transform = 'Standard'
w = bpy.data.worlds.new('W'); sc.world = w; w.use_nodes = True
w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.82, 0.83, 0.85, 1)
w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.9
sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN')); sun.data.energy = 2.6
sun.rotation_euler = (math.radians(50), 0, math.radians(-25)); sc.collection.objects.link(sun)
cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); cam.data.type = 'ORTHO'
sc.collection.objects.link(cam); sc.camera = cam
sc.render.resolution_x = sc.render.resolution_y = 640

hb = arm.data.bones.get('head')
hinge = arm.matrix_world @ (jaw.bone.head_local if jaw else (hb.head_local if hb else Vector((0, 0, 1))))
C = Vector((0, 0, hinge.z + 0.07))
VIEWS = [('front', 0, 0, 0.66), ('34', 35, 0, 0.66), ('side', 90, 0, 0.70), ('low', 15, -18, 0.50),
         ('back', 180, 0, 0.70), ('top', 20, 35, 0.70)]


def shoot(path, yaw, pitch, span):
    a, p = math.radians(yaw), math.radians(pitch)
    d = Vector((math.sin(a) * math.cos(p), -math.cos(a) * math.cos(p), math.sin(p)))
    cam.location = C + d * 6
    cam.rotation_euler = (math.radians(90) - p, 0, a)
    cam.data.ortho_scale = span
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)


ORIG = {o.name: [m for m in o.data.materials] for o in meshes}


def albedo_mat(m):
    """unlit copy of a material: base colour (texture or constant) straight to emission"""
    nm = m.name + '_ALB'
    if nm in bpy.data.materials:
        return bpy.data.materials[nm]
    a = m.copy(); a.name = nm
    nt = a.node_tree
    bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    outn = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'), None)
    if bsdf is None or outn is None:
        return a
    em = nt.nodes.new('ShaderNodeEmission')
    bc = bsdf.inputs['Base Color']
    if bc.links:
        nt.links.new(bc.links[0].from_socket, em.inputs['Color'])
    else:
        em.inputs['Color'].default_value = bc.default_value
    nt.links.new(em.outputs[0], outn.inputs['Surface'])
    return a


clay = bpy.data.materials.new('Clay'); clay.use_nodes = True
clay.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.72, 0.72, 0.72, 1)
OPENS = [(0.0, 'o0'), (0.5, 'o5'), (1.0, 'o10'), (1.2, 'o12')]
passes = ARGV[3:] or ['lit', 'albedo', 'clay']
shots = {}
MI = {}
for o in meshes:   # materials.clear() resets polygon material indices -> keep them to restore
    a = np.zeros(len(o.data.polygons), np.int32)
    o.data.polygons.foreach_get('material_index', a)
    MI[o.name] = a
for ps in passes:
    for o in meshes:
        o.data.materials.clear()
        for m in ORIG[o.name]:
            o.data.materials.append(m if ps == 'lit' else (albedo_mat(m) if ps == 'albedo' else clay))
        o.data.polygons.foreach_set('material_index', MI[o.name])
        o.data.update()
    sun.data.energy = 1.1 if ps == 'clay' else 2.6
    w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.45 if ps == 'clay' else 0.9
    for t, tag in OPENS:
        set_open(t)
        for vn, yaw, pitch, span in VIEWS:
            if ps != 'lit' and vn in ('top',):
                continue
            p = os.path.join(out, '%s_%s_%s.png' % (ps, tag, vn))
            shoot(p, yaw, pitch, span)
            shots.setdefault(ps, []).append((tag, vn, p))
    set_open(0.0)

# ---- contact sheets (rows = open amount, cols = views)
for ps, lst in shots.items():
    tags = [t for _, t in OPENS]
    views = [v for v, *_ in VIEWS if any(x[1] == v for x in lst)]
    R = sc.render.resolution_x // 2
    sheet = np.ones((R * len(tags), R * len(views), 4), np.float32)
    for tag, vn, p in lst:
        im = bpy.data.images.load(p)
        a = np.array(im.pixels[:], np.float32).reshape(im.size[1], im.size[0], 4)[::2, ::2]
        r, c = tags.index(tag), views.index(vn)
        sheet[(len(tags) - 1 - r) * R:(len(tags) - r) * R, c * R:(c + 1) * R] = a[:R, :R]
        bpy.data.images.remove(im)
    img = bpy.data.images.new('sheet_' + ps, sheet.shape[1], sheet.shape[0])
    img.pixels.foreach_set(sheet.ravel())
    img.filepath_raw = os.path.join(out, 'sheet_%s.png' % ps)
    img.file_format = 'PNG'
    img.save()
print('RIG_REVIEW written to', out)
