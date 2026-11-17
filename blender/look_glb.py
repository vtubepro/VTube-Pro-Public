"""
Quick look at any GLB: import, frame, render front + three-quarter + back (EEVEE, transparent).

    blender -b --factory-startup --python blender/look_glb.py -- model.glb out_prefix
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
for a in bpy.data.actions:          # show the rest pose, not an embedded animation
    for o in bpy.data.objects:
        if o.animation_data:
            o.animation_data.action = None
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
ctr, size = (lo + hi) / 2, hi - lo
print('BBOX', tuple(round(v, 3) for v in lo), tuple(round(v, 3) for v in hi))
sc = bpy.context.scene
try:
    sc.render.engine = 'BLENDER_EEVEE'
except TypeError:
    sc.render.engine = 'BLENDER_EEVEE_NEXT'
sc.render.film_transparent = True
sc.render.resolution_x, sc.render.resolution_y = 900, 1100
sc.view_settings.view_transform = 'Standard'
w = bpy.data.worlds.new('W'); sc.world = w
w.use_nodes = True
w.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.0
sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN'))
sun.data.energy = 2.5
sun.rotation_euler = (math.radians(45), 0, math.radians(-30))
sc.collection.objects.link(sun)
cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam'))
cam.data.type = 'ORTHO'
cam.data.ortho_scale = max(size.z, size.x) * 1.1
sc.collection.objects.link(cam)
sc.camera = cam
for name, yaw in (('front', 0), ('34', 35), ('back', 180)):
    a = math.radians(yaw)
    cam.location = (ctr.x + 6 * math.sin(a), ctr.y - 6 * math.cos(a), ctr.z)
    cam.rotation_euler = (math.radians(90), 0, a)
    sc.render.filepath = f'{out}_{name}.png'
    bpy.ops.render.render(write_still=True)
