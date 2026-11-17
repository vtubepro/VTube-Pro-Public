"""Pro2D -> 3D: the round's VRM as a .blend the user's Blender (and their AI, through the Blender MCP) opens.

    blender -b --factory-startup --python blender/to3d/make_blend.py -- <in.vrm> <out.blend>

Plain glTF import (no VRM add-on needed): the armature's bone names ARE the VRM's node names, so parts the AI builds
and skins to them graft back onto the VRM (blender/to3d/graft.py). The camera looks at the face; nothing else changes.
"""
import os
import shutil
import sys

import bpy

argv = sys.argv[sys.argv.index('--') + 1:]
src, out = argv[0], argv[1]
bpy.ops.wm.read_factory_settings(use_empty=True)
tmp = out + '.import.glb'
shutil.copyfile(src, tmp)                                  # the importer wants a .glb / .gltf name
bpy.ops.import_scene.gltf(filepath=tmp)
os.remove(tmp)
for ob in bpy.context.scene.objects:
    ob.select_set(False)
cam = bpy.data.objects.new('TO3D_View', bpy.data.cameras.new('TO3D_View'))
bpy.context.scene.collection.objects.link(cam)
cam.location = (0.0, -1.2, 1.38)
cam.rotation_euler = (1.5708, 0.0, 0.0)
bpy.context.scene.camera = cam
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=out, compress=True)
print('TO3D_BLEND_OK', out)
