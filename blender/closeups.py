"""
Detail close-ups of a finished avatar GLB for cleanup review: full front/back plus face, hands, feet
and a flat-shaded (clay) pass that exposes geometry lumps the texture hides.

    blender -b --factory-startup --python blender/closeups.py -- model.glb out_prefix
"""
import math
import sys

import bpy
from mathutils import Vector

ARGV = sys.argv[sys.argv.index('--') + 1:]
src, out = ARGV[0], ARGV[1]
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=src)
for o in bpy.data.objects:
    if o.animation_data: o.animation_data.action = None
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
bpy.context.view_layer.update()
def bone(n):
    b = arm.data.bones.get(n)
    return arm.matrix_world @ b.head_local if b else None

sc = bpy.context.scene
try: sc.render.engine = 'BLENDER_EEVEE'
except TypeError: sc.render.engine = 'BLENDER_EEVEE_NEXT'
sc.render.film_transparent = False
sc.view_settings.view_transform = 'Standard'
w = bpy.data.worlds.new('W'); sc.world = w; w.use_nodes = True
w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.85, 0.85, 0.85, 1)
sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN')); sun.data.energy = 3
sun.rotation_euler = (math.radians(50), 0, math.radians(-25)); sc.collection.objects.link(sun)
cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); cam.data.type = 'ORTHO'
sc.collection.objects.link(cam); sc.camera = cam
sc.render.resolution_x = sc.render.resolution_y = 900

def shoot(name, center, span, yaw=0, pitch=0):
    a, p = math.radians(yaw), math.radians(pitch)
    d = Vector((math.sin(a) * math.cos(p), -math.cos(a) * math.cos(p), math.sin(p)))
    cam.location = Vector(center) + d * 6
    cam.rotation_euler = (math.radians(90) - p, 0, a)
    cam.data.ortho_scale = span
    sc.render.filepath = f'{out}_{name}.png'
    bpy.ops.render.render(write_still=True)

pts = [m.matrix_world @ v.co for m in meshes for v in m.data.vertices]
lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
ctr = (lo + hi) / 2
H = hi.z - lo.z
head = bone('head') or Vector((0, 0, hi.z - 0.2))
shoot('front', ctr, H * 1.05)
shoot('back', ctr, H * 1.05, yaw=180)
shoot('face', (0, 0, head.z + 0.1), 0.45)
shoot('face34', (0, 0, head.z + 0.1), 0.45, yaw=35)
for side in ('left', 'right'):
    h = bone(side + 'Hand')
    if h: shoot(side + 'hand', h + Vector((0, 0, -0.06)), 0.3, yaw=0)
f = bone('leftFoot')
if f: shoot('feet', Vector((0, f.y, f.z - 0.03)), 0.9, yaw=20, pitch=20)
# clay pass: same views without the texture
clay = bpy.data.materials.new('Clay'); clay.use_nodes = True
clay.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.7, 0.7, 0.7, 1)
for m in meshes:
    m.data.materials.clear(); m.data.materials.append(clay)
shoot('clay_front', ctr, H * 1.05)
shoot('clay_face', (0, 0, head.z + 0.1), 0.45, yaw=25)
shoot('clay_face0', (0, 0, head.z + 0.1), 0.45)
shoot('clay_back', ctr, H * 1.05, yaw=160)
