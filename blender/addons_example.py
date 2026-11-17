"""Worked example for docs/BLENDER_ADDONS.md: a tiny Trail-style roadside scene built only with add-ons
(A.N.T. Landscape, Building Tools, low-poly tree, Sapling, Extra Mesh Objects, 3D Print Toolbox), exported as one GLB.
Run with the Blender lock (docs/BLENDER_PLAYBOOK.md 3.2):
  tools\\blender_low.cmd -b --factory-startup --python "<repo>\\blender\\addons_example.py" -- <out.glb>
Tested 2026-09-27: 17 objects, 16,686 tris, 15 draw calls, glTF validator 0 errors / 0 warnings."""
import os
import sys

import bmesh
import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import addons_util as au  # noqa: E402

OUT = sys.argv[sys.argv.index('--') + 1]
au.enable('antlandscape', 'building_tools', 'lowpoly_trees', 'sapling', 'extra_mesh', 'print3d')

# 1. terrain: A.N.T. Landscape (hetero terrain), low height so the house can sit on it
bpy.ops.mesh.landscape_add(subdivision_x=64, subdivision_y=64, mesh_size_x=30, mesh_size_y=30, height=0.6,
                           noise_type='hetero_terrain', random_seed=11, refresh=True)
terrain = bpy.context.active_object
terrain.name = 'Terrain'

# 2. building: Building Tools floorplan -> floors -> a window on every wall face of the ground floor
bpy.ops.object.select_all(action='DESELECT')
bpy.ops.btools.add_floorplan()
house = bpy.context.active_object
house.name = 'House'
house.location = (0, 0, 0.6)
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.btools.add_floors()
# select the side faces of the lowest storey
bm = bmesh.from_edit_mesh(house.data)
for f in bm.faces:
    f.select = False
low = min(f.calc_center_median().z for f in bm.faces if abs(f.normal.z) < 0.1)
walls = [f for f in bm.faces if abs(f.normal.z) < 0.1 and abs(f.calc_center_median().z - low) < 0.05]
for f in walls:
    f.select = True
bmesh.update_edit_mesh(house.data)
r_win = bpy.ops.btools.add_window()
bpy.ops.object.mode_set(mode='OBJECT')

# 3. trees: low-poly generator (Trail look) + one Sapling tree, placed around the house
bpy.ops.object.select_all(action='DESELECT')
before = set(bpy.data.objects)
bpy.ops.treegen.generate()
for o in set(bpy.data.objects) - before:
    o.location.x += 7
bpy.ops.object.select_all(action='DESELECT')
before = set(bpy.data.objects)
bpy.ops.curve.tree_add(do_update=True, bevel=True, prune=False, showLeaves=False, levels=2, seed=4)
for o in set(bpy.data.objects) - before:
    o.location = (-7, 3, 0.4)

# 4. a gear-shaped millstone from Extra Mesh Objects
bpy.ops.mesh.primitive_gear(number_of_teeth=14, radius=0.9, width=0.4)
bpy.context.active_object.location = (3.5, -4, 0.9)

# 5. convert curves (Sapling) to meshes for export, run a 3D-print-toolbox sanity check on the house
bpy.ops.object.select_all(action='DESELECT')
for o in bpy.data.objects:
    if o.type == 'CURVE':
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
if bpy.context.selected_objects:
    bpy.ops.object.convert(target='MESH')
bpy.ops.object.select_all(action='DESELECT')
house.select_set(True)
bpy.context.view_layer.objects.active = house
bpy.ops.mesh.print3d_check_solid()
qa = {r.name: r.value for r in au.module('print3d').report.get()}

bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_apply=True)
tris = 0
for o in bpy.data.objects:
    if o.type == 'MESH':
        tris += sum(len(p.vertices) - 2 for p in o.data.polygons)
print('EXAMPLE_OK', {'objects': len(bpy.data.objects), 'windows_op': list(r_win), 'wall_faces': len(walls),
                     'tris': tris, 'house_qa': qa, 'bytes': os.path.getsize(OUT)})
