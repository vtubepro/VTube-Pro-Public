"""
Open a built avatar (plus optional costume GLBs) in the Blender GUI for a look around.

    blender --python blender/show_avatar.py -- assets/builtin/frogsuit/frogsuit.glb [costume.glb ...]

Imports everything, switches the viewport to Material Preview and frames the model.
"""
import sys

import bpy

ARGV = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []

for o in list(bpy.data.objects):          # the default cube / camera / light
    bpy.data.objects.remove(o, do_unlink=True)
for path in ARGV:
    bpy.ops.import_scene.gltf(filepath=path)


def frame_views():
    for win in bpy.context.window_manager.windows:
        for area in win.screen.areas:
            if area.type != 'VIEW_3D':
                continue
            for space in area.spaces:
                if space.type == 'VIEW_3D':
                    space.shading.type = 'MATERIAL'
                    space.overlay.show_bones = True
            region = next((r for r in area.regions if r.type == 'WINDOW'), None)
            if region:
                with bpy.context.temp_override(window=win, area=area, region=region):
                    bpy.ops.view3d.view_all(center=True)
    return None


# the GUI isn't fully up while this script runs; frame once it is
bpy.app.timers.register(frame_views, first_interval=1.0)
