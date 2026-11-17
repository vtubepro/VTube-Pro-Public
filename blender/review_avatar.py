"""
Review renders of a finished avatar GLB that look like the studio (cel shading + inverted-hull outline), plus
a clay pass that exposes geometry lumps, and optional posed shots of the model's own shape keys / jaw bone.

    blender -b --factory-startup --python blender/review_avatar.py -- model.glb out_prefix [--views a,b,c]
        [--keys "name=val,name=val"] [--jaw deg] [--jawbone jaw] [--tag suffix]

views (default all): front back 34 side face face34 faceside mouth hands feet clay clayface clayface34
Every path must be absolute (Blender resolves bare relative render paths against the drive root).
"""
import math
import os
import sys

import bpy
from mathutils import Euler, Vector

ARGV = sys.argv[sys.argv.index('--') + 1:]
src, out = ARGV[0], os.path.abspath(ARGV[1])


def opt(name, default=None):
    return ARGV[ARGV.index(name) + 1] if name in ARGV else default


VIEWS = (opt('--views') or 'front,back,34,side,face,face34,faceside,mouth,hands,feet,clay,clayface,clayface34').split(',')
TAG = opt('--tag', '')
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=src)
for o in bpy.data.objects:
    if o.animation_data: o.animation_data.action = None
bpy.context.view_layer.update()
arm = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o.visible_get()]

# ---- pose: shape keys + jaw
for m in meshes:          # the glTF importer can leave morph weights at 1 — start from the neutral face
    if m.data.shape_keys:
        for kb in m.data.shape_keys.key_blocks[1:]: kb.value = 0.0
keys = opt('--keys')
if keys:
    for kv in keys.split(','):
        k, v = kv.split('=')
        for m in meshes:
            sk = m.data.shape_keys
            if sk and k in sk.key_blocks: sk.key_blocks[k].value = float(v)
jaw = opt('--jaw')
if jaw and arm:
    pb = arm.pose.bones.get(opt('--jawbone', 'jaw'))
    if pb:
        pb.rotation_mode = 'XYZ'
        pb.rotation_euler = Euler((math.radians(float(jaw)), 0, 0))   # bone x = avatar left-right hinge
bpy.context.view_layer.update()


def bone(n):
    b = arm.data.bones.get(n) if arm else None
    return arm.matrix_world @ b.head_local if b else None


sc = bpy.context.scene
try: sc.render.engine = 'BLENDER_EEVEE'
except TypeError: sc.render.engine = 'BLENDER_EEVEE_NEXT'
sc.render.film_transparent = False
sc.view_settings.view_transform = 'Standard'
w = bpy.data.worlds.new('W'); sc.world = w; w.use_nodes = True
w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.16, 0.17, 0.2, 1)
w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.0
sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN')); sun.data.energy = 3.0
sun.rotation_euler = (math.radians(40), 0, math.radians(-30)); sc.collection.objects.link(sun)
cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); cam.data.type = 'ORTHO'
sc.collection.objects.link(cam); sc.camera = cam
sc.render.resolution_x = sc.render.resolution_y = 1000


def toonify(mat):
    """base colour × two-step light ramp (like src/avatar/toon.ts), emission so exposure stays true"""
    if not mat or not mat.use_nodes or mat.get('_toon'): return
    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    outn = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'), None)
    if not bsdf or not outn: return
    base = bsdf.inputs['Base Color']
    src_sock = base.links[0].from_socket if base.links else None
    dif = nt.nodes.new('ShaderNodeBsdfDiffuse')
    s2r = nt.nodes.new('ShaderNodeShaderToRGB')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.interpolation = 'CONSTANT'
    ramp.color_ramp.elements[0].color = (0.66, 0.62, 0.68, 1)
    ramp.color_ramp.elements[1].position = 0.18
    mul = nt.nodes.new('ShaderNodeMix'); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'
    mul.inputs['Factor'].default_value = 1.0
    em = nt.nodes.new('ShaderNodeEmission')
    nt.links.new(dif.outputs[0], s2r.inputs[0]); nt.links.new(s2r.outputs[0], ramp.inputs[0])
    if src_sock: nt.links.new(src_sock, mul.inputs['A'])
    else: mul.inputs['A'].default_value = base.default_value
    nt.links.new(ramp.outputs[0], mul.inputs['B'])
    nt.links.new(mul.outputs['Result'], em.inputs[0])
    for l in list(outn.inputs['Surface'].links): nt.links.remove(l)
    nt.links.new(em.outputs[0], outn.inputs['Surface'])
    mat['_toon'] = True


for m in meshes:
    for s in m.material_slots: toonify(s.material)
# inverted-hull outline (constant world width, close enough to the studio's pixel-width hull at these spans)
ol = bpy.data.materials.new('Outline'); ol.use_nodes = True
nt = ol.node_tree; nt.nodes.clear()
e = nt.nodes.new('ShaderNodeEmission'); e.inputs[0].default_value = (0.05, 0.04, 0.04, 1)
o_ = nt.nodes.new('ShaderNodeOutputMaterial'); nt.links.new(e.outputs[0], o_.inputs[0])
ol.use_backface_culling = True
for m in meshes:
    m.data.materials.append(ol)
    sol = m.modifiers.new('outline', 'SOLIDIFY'); sol.thickness = -0.0035; sol.use_flip_normals = True
    sol.material_offset = len(m.data.materials) - 1; sol.use_rim = False

pts = [m.matrix_world @ v.co for m in meshes for v in m.data.vertices]
lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
ctr = (lo + hi) / 2
H = hi.z - lo.z
head = bone('head') or Vector((0, 0, hi.z - 0.25))
FACE = Vector((0, 0, head.z + 0.08))
MOUTH = Vector((0, 0, head.z + 0.0))


def shoot(name, center, span, yaw=0, pitch=0, res=1000):
    if name not in VIEWS: return
    a, p = math.radians(yaw), math.radians(pitch)
    d = Vector((math.sin(a) * math.cos(p), -math.cos(a) * math.cos(p), math.sin(p)))
    cam.location = Vector(center) + d * 6
    cam.rotation_euler = (math.radians(90) - p, 0, a)
    cam.data.ortho_scale = span
    sc.render.resolution_x = sc.render.resolution_y = res
    sc.render.filepath = f'{out}_{name}{TAG}.png'
    bpy.ops.render.render(write_still=True)


shoot('front', ctr, H * 1.05)
shoot('back', ctr, H * 1.05, yaw=180)
shoot('34', ctr, H * 1.05, yaw=35)
shoot('side', ctr, H * 1.05, yaw=90)
shoot('face', FACE, 0.5)
shoot('face34', FACE, 0.5, yaw=35)
shoot('faceside', FACE, 0.5, yaw=80)
shoot('mouth', MOUTH + Vector((0, 0, 0.0)), 0.2, yaw=10, pitch=5)
if 'hands' in VIEWS:
    for side in ('left', 'right'):
        h = bone(side + 'Hand'); t = bone(side + 'MiddleDistal')
        if h: VIEWS.append(side + 'hand'); shoot(side + 'hand', (h + t) / 2 if t else h, 0.3, yaw=35 if side == 'right' else -35)
f = bone('leftFoot')
if f and 'feet' in VIEWS: shoot('feet', Vector((0, f.y, f.z + 0.05)), 0.9, yaw=20, pitch=20)
clay = bpy.data.materials.new('Clay'); clay.use_nodes = True
clay.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.6, 0.6, 0.62, 1)
clay.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.6
if any(v.startswith('clay') for v in VIEWS):
    sun.data.energy = 2.2
    w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.35
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (1, 1, 1, 1)
    for m in meshes:
        for md in list(m.modifiers):
            if md.type == 'SOLIDIFY': m.modifiers.remove(md)
        m.data.materials.clear(); m.data.materials.append(clay)
    shoot('clay', ctr, H * 1.05, yaw=25)
    shoot('clayface', FACE, 0.5)
    shoot('clayface34', FACE, 0.5, yaw=40)
    shoot('claymouth', MOUTH, 0.2, yaw=10, pitch=5)
    shoot('claymouth34', MOUTH, 0.2, yaw=45, pitch=5)
    shoot('clayback', ctr, H * 1.05, yaw=160)
print('REVIEW written', out)
