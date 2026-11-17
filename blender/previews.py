"""
Library previews for a finished avatar GLB: preview_front / preview_three_quarter / preview_back (full body)
and thumb.png (bust), transparent EEVEE renders — re-run after any cleanup/retexture pass.

    blender -b --factory-startup --python blender/previews.py -- model.glb out_dir
"""
import math
import os
import sys

import bpy
from mathutils import Vector

src, out_dir = sys.argv[sys.argv.index('--') + 1:][:2]
out_dir = os.path.abspath(out_dir)   # Blender resolves bare relative render paths against the drive root
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=src)
for o in bpy.data.objects:
    if o.animation_data: o.animation_data.action = None
bpy.context.view_layer.update()
arm = next((o for o in bpy.data.objects if o.type == 'ARMATURE'), None)
meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o.visible_get()]   # skips the importer's bone-shape Icosphere
sc = bpy.context.scene
try: sc.render.engine = 'BLENDER_EEVEE'
except TypeError: sc.render.engine = 'BLENDER_EEVEE_NEXT'
sc.render.film_transparent = True
sc.view_settings.view_transform = 'Standard'
w = bpy.data.worlds.new('W'); sc.world = w; w.use_nodes = True
bg = w.node_tree.nodes['Background']
bg.inputs['Color'].default_value = (1, 1, 1, 1); bg.inputs['Strength'].default_value = 0.45   # soft fill
sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN')); sun.data.energy = 1.25   # keeps albedo colours true
sun.rotation_euler = (math.radians(45), 0, math.radians(-30)); sc.collection.objects.link(sun)
pts = [m.matrix_world @ v.co for m in meshes for v in m.data.vertices]
lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
ctr = (lo + hi) / 2
cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); cam.data.type = 'ORTHO'
sc.collection.objects.link(cam); sc.camera = cam


def shoot(path, center, span, yaw, rx, ry):
    a = math.radians(yaw)
    cam.location = (center.x + 6 * math.sin(a), center.y - 6 * math.cos(a), center.z)
    cam.rotation_euler = (math.radians(90), 0, a)
    cam.data.ortho_scale = span
    sc.render.resolution_x, sc.render.resolution_y = rx, ry
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)


span = max(hi.z - lo.z, hi.x - lo.x) * 1.08
for name, yaw in (('front', 0), ('three_quarter', 35), ('back', 180)):
    shoot(os.path.join(out_dir, f'preview_{name}.png'), ctr, span, yaw, 900, 1100)
head = arm.matrix_world @ arm.data.bones['head'].head_local if arm and 'head' in arm.data.bones else Vector((0, 0, hi.z - 0.3))
bust = Vector((0, 0, (head.z + hi.z) / 2 - 0.12))
shoot(os.path.join(out_dir, 'thumb.png'), Vector((0, 0, hi.z - (hi.z - lo.z) * 0.3)), (hi.z - lo.z) * 0.62, 15, 512, 512)   # head + chest
print('PREVIEWS written to', out_dir)
