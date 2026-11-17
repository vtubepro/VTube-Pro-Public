"""
Print a generated rig's bones (world head/tail, Blender Z-up) and render a gridded face close-up so eye /
mouth markers can be placed precisely.

    blender -b --factory-startup --python blender/measure_glb.py -- model.glb out_prefix [head_bone]
"""
import math
import sys

import bpy
from mathutils import Vector

ARGV = sys.argv[sys.argv.index('--') + 1:]
src, out = ARGV[0], ARGV[1]
head_name = ARGV[2] if len(ARGV) > 2 else 'Head'
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=src)
for o in bpy.data.objects:
    if o.animation_data:
        o.animation_data.action = None
bpy.context.view_layer.update()
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
for b in arm.data.bones:
    h, t = arm.matrix_world @ b.head_local, arm.matrix_world @ b.tail_local
    print('BONE %-14s parent=%-12s head=(%.3f %.3f %.3f) tail=(%.3f %.3f %.3f)' % (b.name, b.parent.name if b.parent else '-', *h, *t))
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
for m in meshes:
    print('MESH', m.name, len(m.data.vertices), 'verts', len(m.data.polygons), 'faces', [s.name for s in m.material_slots])
dg = bpy.context.evaluated_depsgraph_get()
pts = [m.matrix_world @ v.co for m in meshes for v in m.data.vertices]
lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
print('MESHBOX', tuple(round(v, 3) for v in lo), tuple(round(v, 3) for v in hi))

hb = arm.data.bones.get(head_name)
hc = arm.matrix_world @ hb.head_local if hb else Vector((0, 0, hi.z - 0.25))
# head region: vertices above the head bone
hv = [p for p in pts if p.z > hc.z - 0.02]
hlo = Vector((min(p.x for p in hv), min(p.y for p in hv), min(p.z for p in hv)))
hhi = Vector((max(p.x for p in hv), max(p.y for p in hv), max(p.z for p in hv)))
print('HEADBOX', tuple(round(v, 3) for v in hlo), tuple(round(v, 3) for v in hhi))

sc = bpy.context.scene
try:
    sc.render.engine = 'BLENDER_EEVEE'
except TypeError:
    sc.render.engine = 'BLENDER_EEVEE_NEXT'
sc.render.film_transparent = False
sc.view_settings.view_transform = 'Standard'
w = bpy.data.worlds.new('W'); sc.world = w
w.use_nodes = True
w.node_tree.nodes['Background'].inputs['Color'].default_value = (1, 1, 1, 1)
sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN'))
sun.data.energy = 2.5
sun.rotation_euler = (math.radians(60), 0, 0)
sc.collection.objects.link(sun)
cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam'))
cam.data.type = 'ORTHO'
span = max(hhi.x - hlo.x, hhi.z - hlo.z) * 1.15
cam.data.ortho_scale = span
cx, cz = (hlo.x + hhi.x) / 2, (hlo.z + hhi.z) / 2
cam.location = (cx, hlo.y - 3, cz)
cam.rotation_euler = (math.radians(90), 0, 0)
sc.collection.objects.link(cam)
sc.camera = cam
sc.render.resolution_x = sc.render.resolution_y = 1000
sc.render.filepath = f'{out}_face.png'
bpy.ops.render.render(write_still=True)
# the image covers x in [cx - span/2, cx + span/2], z in [cz - span/2, cz + span/2]
print('FACEVIEW cx=%.4f cz=%.4f span=%.4f (px = (x-cx)/span*1000+500, py = 500-(z-cz)/span*1000)' % (cx, cz, span))
