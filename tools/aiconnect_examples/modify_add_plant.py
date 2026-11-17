"""VTube Pro creation-package MODIFY script: re-open the installed room, add a potted plant + a second neon strip."""
import math, os
import bpy

OUT, BASE = os.environ['VTP_OUT'], os.environ['VTP_BASE_GLB']   # BASE = the installed assets/scenes/<id>/scene.glb
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=BASE)          # names, empties, cameras and extras come back as custom properties
print('STEP imported', len(bpy.data.objects), 'objects')

def mat(name, rgb, emit=None, strength=1.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']; b.inputs['Base Color'].default_value = (*rgb, 1)
    if emit: b.inputs['Emission Color'].default_value = (*emit, 1); b.inputs['Emission Strength'].default_value = strength
    return m

bpy.ops.mesh.primitive_cylinder_add(radius=0.22, depth=0.45, location=(3.4, 2.4, 0.225))
pot = bpy.context.active_object; pot.name = 'PlantPot'; pot.data.materials.append(mat('Pot', (0.35, 0.12, 0.06)))
bpy.ops.mesh.primitive_ico_sphere_add(radius=0.45, subdivisions=2, location=(3.4, 2.4, 0.85))
leaves = bpy.context.active_object; leaves.name = 'PlantLeaves'; leaves.data.materials.append(mat('Leaves', (0.05, 0.3, 0.08)))
bpy.ops.mesh.primitive_cube_add(size=1, location=(3.9, 0.0, 2.6)); n = bpy.context.active_object
n.name = 'LIGHT_NEON_02'; n.scale = (0.04, 4.0, 0.04); bpy.ops.object.transform_apply(scale=True)
n.data.materials.append(mat('EMIT_neon', (1.0, 0.05, 0.4), emit=(1.0, 0.05, 0.4), strength=3.0))
n['group'], n['color'], n['kind'] = 'neon', '#ff3fa4', 'emissive'

bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'scene.glb'), export_format='GLB', export_yup=True,
                          export_extras=True, export_cameras=True, export_lights=False, export_apply=True,
                          export_materials='EXPORT', use_selection=False)
print('ROOM_OK')
