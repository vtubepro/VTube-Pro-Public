"""VTube Pro creation-package build script: a small neon ramen bar (4 stools, a booth for 3, react screen)."""
import math, os
import bpy
from mathutils import Vector

OUT = os.environ['VTP_OUT']                      # the installer reads scene.glb from here
bpy.ops.wm.read_factory_settings(use_empty=True)
scn = bpy.context.scene

def srgb(h):
    h = h.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)

MATS = {}
def mat(name, hex_, rough=0.8, emit=None, strength=1.0):
    if name in MATS: return MATS[name]
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*srgb(hex_), 1); b.inputs['Roughness'].default_value = rough
    if emit:
        b.inputs['Emission Color'].default_value = (*srgb(emit), 1); b.inputs['Emission Strength'].default_value = strength
    MATS[name] = m; return m

def box(name, center, size, material):
    bpy.ops.mesh.primitive_cube_add(size=1, location=center); o = bpy.context.active_object
    o.name = name; o.scale = size; bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(material); return o

def empty(name, loc, yaw_deg=0.0, **props):
    o = bpy.data.objects.new(name, None); o.empty_display_type = 'SINGLE_ARROW'
    o.location = loc; o.rotation_euler = (0, 0, math.radians(yaw_deg))
    for k, v in props.items(): o[k] = v
    scn.collection.objects.link(o); return o

def camera(name, loc, target, fov_deg=35.0):
    cd = bpy.data.cameras.new(name); cd.sensor_fit = 'VERTICAL'; cd.angle_y = math.radians(fov_deg)
    cd.clip_start, cd.clip_end = 0.05, 100
    o = bpy.data.objects.new(name, cd); o.location = loc
    o.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    scn.collection.objects.link(o); return o

print('STEP shell')
W, D, H = 8.0, 6.0, 3.2; X0, X1, YB, YF = -W / 2, W / 2, D / 2, -D / 2
wall, floor = mat('Wall', '#3a2f3f'), mat('Floor', '#5a4636', 0.6)
box('Floor', (0, 0, -0.05), (W, D, 0.1), floor)
box('Ceiling', (0, 0, H + 0.05), (W, D, 0.1), mat('Ceiling', '#2a2430'))
box('WallBack', (0, YB + 0.05, H / 2), (W, 0.1, H), wall)
box('WallRight', (X1 + 0.05, 0, H / 2), (0.1, D, H), wall)
DY, DW, DH = -1.5, 1.0, 2.1; lo, hi = DY - DW / 2, DY + DW / 2
box('WallLeftA', (X0 - 0.05, (YF + lo) / 2, H / 2), (0.1, lo - YF, H), wall)
box('WallLeftB', (X0 - 0.05, (hi + YB) / 2, H / 2), (0.1, YB - hi, H), wall)
box('WallLeftTop', (X0 - 0.05, DY, (DH + H) / 2), (0.1, DW, H - DH), wall)
box('Hallway', (X0 - 1.0, DY, -0.05), (2.0, 1.6, 0.1), floor)

print('STEP door + path')
bpy.ops.mesh.primitive_cube_add(size=1); leaf = bpy.context.active_object
leaf.name = 'DOOR'; leaf.scale = (0.05, DW, DH); bpy.ops.object.transform_apply(scale=True)
for v in leaf.data.vertices: v.co.y -= DW / 2; v.co.z += DH / 2
leaf.location = (X0 - 0.05, hi, 0); leaf.data.materials.append(mat('Door', '#6b3b2a')); leaf['openAngle'] = 95.0
empty('DOOR_OUTSIDE', (X0 - 1.2, DY, 0), yaw_deg=90)
empty('PATH_01', (X0 + 0.7, DY, 0)); empty('PATH_02', (-1.5, -0.6, 0)); empty('PATH_03', (0, -0.4, 0))

print('STEP counter + stools (spots 01-04, facing the camera from behind the counter)')
wood = mat('Counter', '#8a5a3a', 0.5)
box('Counter', (0.8, 1.2, 0.5), (4.0, 0.6, 1.0), wood)
box('COLLIDE_Counter', (0.8, 1.2, 0.5), (4.0, 0.6, 1.0), wood)
for i, x in enumerate((-0.6, 0.3, 1.2, 2.1)):
    box(f'Stool_{i + 1}', (x, 1.95, 0.35), (0.4, 0.4, 0.7), mat('Stool', '#c23b3b', 0.4))
    empty(f'SPOT_{i + 1:02d}', (x, 1.95, 0), pose='sit', seatHeight=0.7, seatDepth=0.4, label=f'Stool {i + 1}',
          approach=[3.3, 0, -0.6, 3.3, 0, -1.95], leavePathAt='PATH_03')  # glTF points: around the counter's right end

print('STEP booth (spots 05-07)')
booth = mat('Booth', '#2f5f7a', 0.9)
box('BoothSeat', (-2.6, 0.3, 0.22), (1.1, 2.4, 0.45), booth)
box('BoothBack', (-3.2, 0.3, 0.75), (0.2, 2.4, 0.9), booth)
box('COLLIDE_Booth', (-2.6, 0.3, 0.3), (1.1, 2.4, 0.6), booth)
for i, y in enumerate((-0.5, 0.3, 1.1)):
    empty(f'SPOT_{i + 5:02d}', (-2.55, y, 0), yaw_deg=60, pose='sit', seatHeight=0.45, seatDepth=0.5, label=f'Booth {i + 1}')

print('STEP react screen')
SW, SH, SZ = 3.2, 1.8, 2.05
bpy.ops.mesh.primitive_plane_add(size=1, location=(0.8, YB - 0.04, SZ), rotation=(math.radians(90), 0, 0))
scr = bpy.context.active_object; scr.name = 'SCREEN'; scr.scale = (SW, SH, 1)
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
scr.data.materials.append(mat('ScreenSurface', '#050505', 0.3)); scr['restOffsetY'] = 1.6

print('STEP lights')
neon = box('LIGHT_NEON_01', (0.8, YB - 0.03, H - 0.25), (6.5, 0.04, 0.04), mat('EMIT_neon', '#ff3fa4', 0.4, emit='#ff3fa4', strength=3.0))
neon['group'], neon['color'], neon['kind'] = 'neon', '#ff3fa4', 'emissive'
sign = box('LIGHT_SIGN_01', (-2.0, YB - 0.05, 2.2), (1.2, 0.05, 0.45), mat('EMIT_sign', '#ffcf3f', 0.4, emit='#ffcf3f', strength=2.5))
sign['group'], sign['color'], sign['kind'] = 'sign', '#ffcf3f', 'emissive'
lamp = box('LIGHT_LAMP_01', (0.8, 1.2, 2.7), (0.3, 0.3, 0.2), mat('EMIT_lamps', '#ffd9a0', emit='#ffd9a0', strength=2.5))
lamp['group'], lamp['color'], lamp['kind'] = 'lamps', '#ffd9a0', 'point'

print('STEP cameras')
camera('CAM_WIDE', (0, -6.0, 1.8), (0, 0.8, 1.0), 40)
camera('CAM_REACT', (0.8, YB - 0.04 - 3.57, SZ), (0.8, YB, SZ), 35)
camera('CAM_DOOR', (X0 + 2.5, -3.2, 1.7), (X0, DY, 1.2), 40)

bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'scene.glb'), export_format='GLB', export_yup=True,
                          export_extras=True, export_cameras=True, export_lights=False, export_apply=True,
                          export_materials='EXPORT', use_selection=False)
print('ROOM_OK')
