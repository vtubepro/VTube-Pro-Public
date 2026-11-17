"""QA renders inside the build session (EEVEE): expression contact sheets, face / body shots."""
import math
import os

import bpy
import numpy as np
from mathutils import Vector


def setup_scene(res=480):
    sc = bpy.context.scene
    try:
        sc.render.engine = 'BLENDER_EEVEE'
    except TypeError:
        sc.render.engine = 'BLENDER_EEVEE_NEXT'
    sc.render.resolution_x = sc.render.resolution_y = res
    sc.render.film_transparent = False
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = 'None'
    if not sc.world:
        sc.world = bpy.data.worlds.new('W')
    sc.world.use_nodes = True
    bg = sc.world.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (0.2, 0.21, 0.24, 1)
    bg.inputs['Strength'].default_value = 0.9
    for name, energy, rot, col in (('Key', 3.2, (50, 0, -30), (1, 0.97, 0.94)), ('Fill', 1.0, (70, 0, 40), (0.85, 0.9, 1)),
                                   ('Rim', 2.2, (110, 0, 160), (0.9, 0.95, 1))):
        if name in bpy.data.objects:
            continue
        L = bpy.data.objects.new(name, bpy.data.lights.new(name, 'SUN'))
        L.data.energy = energy
        L.data.color = col
        L.data.angle = math.radians(8)
        L.rotation_euler = tuple(math.radians(a) for a in rot)
        sc.collection.objects.link(L)
    if 'QACam' not in bpy.data.objects:
        cam = bpy.data.objects.new('QACam', bpy.data.cameras.new('QACam'))
        sc.collection.objects.link(cam)
    sc.camera = bpy.data.objects['QACam']
    return sc


def aim(target, dist, lens=85, yaw=0.0, pitch=0.0):
    cam = bpy.data.objects['QACam']
    cam.data.lens = lens
    cam.data.clip_start = 0.01
    a, b = math.radians(yaw), math.radians(pitch)
    off = Vector((math.sin(a) * math.cos(b), -math.cos(a) * math.cos(b), math.sin(b))) * dist
    cam.location = Vector(target) + off
    d = Vector(target) - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def shot(path):
    sc = bpy.context.scene
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return path


def sheet(paths, out, cols=6, labels=None):
    imgs = []
    for p in paths:
        im = bpy.data.images.load(p)
        a = np.array(im.pixels[:], dtype=np.float32).reshape(im.size[1], im.size[0], 4)
        bpy.data.images.remove(im)
        imgs.append(a)
    h, w = imgs[0].shape[:2]
    rows = (len(imgs) + cols - 1) // cols
    S = np.ones((rows * h, cols * w, 4), np.float32) * 0.1
    S[..., 3] = 1
    for i, a in enumerate(imgs):
        r, c = divmod(i, cols)
        S[(rows - 1 - r) * h:(rows - r) * h, c * w:(c + 1) * w] = a
    img = bpy.data.images.new(os.path.basename(out), cols * w, rows * h)
    img.pixels.foreach_set(S.ravel())
    img.filepath_raw = out
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)
    return out


def set_keys(meshes, values):
    for ob in meshes:
        sk = ob.data.shape_keys
        if not sk:
            continue
        for kb in sk.key_blocks[1:]:
            kb.value = values.get(kb.name, 0.0)


def expression_sheet(meshes, face_center, out_dir, name, combos, res=360, dist=0.62, yaw=0, cols=6):
    setup_scene(res)
    aim(face_center, dist, 85, yaw, 2)
    paths = []
    for label, vals in combos:
        set_keys(meshes, vals)
        paths.append(shot(os.path.join(out_dir, '_tile_%s.png' % label)))
    set_keys(meshes, {})
    out = sheet(paths, os.path.join(out_dir, name), cols)
    for p in paths:
        try:
            os.remove(p)
        except OSError:
            pass
    return out
