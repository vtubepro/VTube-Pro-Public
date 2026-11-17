"""
Replace the body mesh's base-colour texture of a GLB with a new image (same UV layout) and re-export.

    blender -b --factory-startup --python blender/swap_albedo.py -- in.glb albedo.png out.glb
"""
import sys

import bpy
import numpy as np

src, png, out = sys.argv[sys.argv.index('--') + 1:][:3]
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=src)
for o in bpy.data.objects:
    if o.animation_data: o.animation_data.action = None
body = max((o for o in bpy.data.objects if o.type == 'MESH'), key=lambda o: len(o.data.vertices))
img = None
for mat in body.data.materials:
    for n in mat.node_tree.nodes:
        if n.type == 'TEX_IMAGE' and n.image and (img is None or n.image.size[0] > img.size[0]):
            img = n.image
new = bpy.data.images.load(png)
if tuple(new.size) != tuple(img.size):
    new.scale(*img.size)
px = np.empty(img.size[0] * img.size[1] * 4, np.float32)
new.pixels.foreach_get(px)
img.pixels.foreach_set(px)
img.pack()
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_yup=True, export_skins=True,
                          export_morph=True, export_animations=False, export_image_format='AUTO')
print('SWAPPED', img.name, img.size[:], '->', out)
