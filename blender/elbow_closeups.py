"""
Elbow close-ups of a finished avatar GLB (cleanup review of the upperArm/lowerArm joint).
Writes two contact sheets: <out>_rest.png and <out>_bent.png (forearm bent ~90 deg in pose mode).
Each sheet: rows = left textured, left clay, right textured, right clay; columns = front, back, outer side, rear-outer.

    blender -b --factory-startup --python blender/elbow_closeups.py -- model.glb out_prefix [bend_deg]
"""
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Quaternion, Vector

ARGV = sys.argv[sys.argv.index('--') + 1:]
src, out = ARGV[0], ARGV[1]
BEND = float(ARGV[2]) if len(ARGV) > 2 else 90.0
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=src)
for o in bpy.data.objects:
    if o.animation_data: o.animation_data.action = None
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
bpy.context.view_layer.update()

sc = bpy.context.scene
try: sc.render.engine = 'BLENDER_EEVEE'
except TypeError: sc.render.engine = 'BLENDER_EEVEE_NEXT'
sc.view_settings.view_transform = 'Standard'
w = bpy.data.worlds.new('W'); sc.world = w; w.use_nodes = True
w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.3, 0.3, 0.3, 1)
sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN')); sun.data.energy = 2.2
sc.collection.objects.link(sun)
cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); cam.data.type = 'ORTHO'
sc.collection.objects.link(cam); sc.camera = cam
T = 480
sc.render.resolution_x = sc.render.resolution_y = T
TMP = out + '_tmp.png'


def shoot(center, span, yaw=0, pitch=0):
    a, p = math.radians(yaw), math.radians(pitch)
    d = Vector((math.sin(a) * math.cos(p), -math.cos(a) * math.cos(p), math.sin(p)))
    cam.location = Vector(center) + d * 6
    cam.rotation_euler = (math.radians(90) - p, 0, a)
    cam.data.ortho_scale = span
    sun.rotation_euler = (math.radians(55), 0, a + math.radians(-30))   # key light follows the camera
    sc.render.filepath = TMP
    bpy.ops.render.render(write_still=True)
    im = bpy.data.images.load(TMP)
    px = np.array(im.pixels[:], np.float32).reshape(T, T, 4)
    bpy.data.images.remove(im)
    return px


def elbow(side):
    b = arm.pose.bones[side + 'LowerArm']
    return arm.matrix_world @ b.head


def sheet(name):
    rows = []
    for side, s in (('left', 1), ('right', -1)):
        row = []
        for yaw in (0, 180, s * 90, s * 135):
            row.append(shoot(elbow(side), 0.34, yaw=yaw))
        rows.append(row)
    return rows


def pose_bend(deg):
    """bend both forearms ~deg forward (toward the camera, -Y) about the axis perpendicular to arm + forward"""
    for side in ('left', 'right'):
        ua = arm.data.bones[side + 'UpperArm']; la = arm.data.bones[side + 'LowerArm']
        u = (la.tail_local - la.head_local).normalized()
        f = Vector((0, -1, 0))
        ax = u.cross(f).normalized()
        loc = (la.matrix_local.to_3x3().inverted() @ ax).normalized()
        pb = arm.pose.bones[side + 'LowerArm']; pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = Quaternion(loc, math.radians(deg))
    bpy.context.view_layer.update()


clay = bpy.data.materials.new('Clay'); clay.use_nodes = True
clay.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.7, 0.7, 0.7, 1)
orig = {m: list(m.data.materials) for m in meshes}


def set_clay(on):
    for m in meshes:
        m.data.materials.clear()
        for mt in ([clay] if on else orig[m]): m.data.materials.append(mt)


def save(rows_tex, rows_clay, path):
    grid = [r for pair in zip(rows_tex, rows_clay) for r in pair]   # rows: left tex, left clay, right tex, right clay
    img = np.concatenate([np.concatenate(r, axis=1) for r in grid[::-1]], axis=0)  # blender images are bottom-up
    H, W = img.shape[:2]
    im = bpy.data.images.new('sheet', W, H)
    im.pixels.foreach_set(img.ravel())
    im.filepath_raw = path; im.file_format = 'PNG'; im.save()
    print('WROTE', path)


for name, deg in (('rest', 0.0), ('bent', BEND)):
    if deg: pose_bend(deg)
    set_clay(False); t = sheet(name)
    set_clay(True); c = sheet(name)
    save(t, c, f'{out}_{name}.png')
os.remove(TMP)
