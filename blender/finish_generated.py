"""
Finish an AI-generated, auto-rigged character (Meshy / Tripo / Mixamo-style GLB) into a VTube Pro avatar.

    blender -b --factory-startup --python blender/finish_generated.py -- config.json

config.json:
{
  "src": "in.glb", "out_dir": "assets/builtin/<id>", "model_file": "<id>.glb",
  "delete": ["Icosphere"],                     # stray objects to drop
  "extra_bones": [                             # new bones; nearby vertices move onto them
    {"name": "tail", "parent": "hips", "head": [x,y,z], "tail": [x,y,z],
     "weight": {"center": [x,y,z], "radius": 0.1, "inner": 0.04}}   # Blender world coords (Z up, -Y front)
  ],
  "lens": {"centers": [[x,y,z], ...], "radius": 0.04, "offset": 0.004},   # glass shell over the eyes (optional)
  "markers": {"eyeL": [x, z], "eyeR": [x, z], "mouth": [x, z]},           # front-view points, ray-cast onto the face
  "previews": true
}
Prints MARKERS json (glTF coords) for profile.json. Bones are renamed to the VTube Pro convention (hips, spine,
chest, upperChest, neck, head, leftUpperArm, …) so retargeting never has to guess.
"""
import json
import math
import os
import sys

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

cfg = json.load(open(sys.argv[sys.argv.index('--') + 1], encoding='utf-8'))
ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..'))
out_dir = os.path.join(ROOT, cfg['out_dir'])
os.makedirs(out_dir, exist_ok=True)

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=cfg['src'])
for name in cfg.get('delete', []):
    o = bpy.data.objects.get(name)
    if o: bpy.data.objects.remove(o, do_unlink=True)
for o in bpy.data.objects:
    if o.animation_data: o.animation_data.action = None
for a in list(bpy.data.actions): bpy.data.actions.remove(a)

arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
meshes = [o for o in bpy.data.objects if o.type == 'MESH']

# ---------------------------------------------------------------- 1. apply transforms (cm-scaled rigs)
bpy.ops.object.select_all(action='DESELECT')
for o in [arm] + meshes: o.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

# ---------------------------------------------------------------- 2. rename bones (Meshy / Mixamo → VTube Pro)
MAP = {
    'hips': 'hips', 'spine02': 'spine', 'spine01': 'chest', 'spine': 'upperChest', 'neck': 'neck', 'head': 'head',
    'leftshoulder': 'leftShoulder', 'leftarm': 'leftUpperArm', 'leftforearm': 'leftLowerArm', 'lefthand': 'leftHand',
    'rightshoulder': 'rightShoulder', 'rightarm': 'rightUpperArm', 'rightforearm': 'rightLowerArm', 'righthand': 'rightHand',
    'leftupleg': 'leftUpperLeg', 'leftleg': 'leftLowerLeg', 'leftfoot': 'leftFoot', 'lefttoebase': 'leftToes',
    'rightupleg': 'rightUpperLeg', 'rightleg': 'rightLowerLeg', 'rightfoot': 'rightFoot', 'righttoebase': 'rightToes',
    'head_end': 'headTop', 'headfront': 'headFront',
}
# Mixamo spine order is Spine → Spine1 → Spine2 (bottom up); Meshy uses Spine02 → Spine01 → Spine
names = {b.name.lower().replace('mixamorig:', ''): b.name for b in arm.data.bones}
if 'spine1' in names and 'spine2' in names:
    MAP.update({'spine': 'spine', 'spine1': 'chest', 'spine2': 'upperChest'})
renamed = {}
for key, bname in names.items():
    new = MAP.get(key)
    if new and new != bname:
        arm.data.bones[bname].name = new   # vertex groups follow the bone rename
        renamed[bname] = new
for m in meshes:  # older Blender: keep groups in sync explicitly
    for g in m.vertex_groups:
        if g.name in renamed: g.name = renamed[g.name]
print('RENAMED', json.dumps(renamed))

# ---------------------------------------------------------------- 3. extra bones + weights
def world_bone_head(n):
    return arm.matrix_world @ arm.data.bones[n].head_local

bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
eb = arm.data.edit_bones
inv = arm.matrix_world.inverted()
for xb in cfg.get('extra_bones', []):
    b = eb.new(xb['name'])
    b.head = inv @ Vector(xb['head']); b.tail = inv @ Vector(xb['tail'])
    b.parent = eb[xb['parent']]
    b.use_deform = True
bpy.ops.object.mode_set(mode='OBJECT')

def smooth(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)

for xb in cfg.get('extra_bones', []):
    w = xb.get('weight')
    if not w: continue
    cs = [Vector(c) for c in w.get('centers', [w.get('center')])]; R = w['radius']; inner = w.get('inner', R * 0.4)
    flat = w.get('ignore_y', False)
    zmin = w.get('zmin', -1e9); zmax = w.get('zmax', 1e9); ymin = w.get('ymin', -1e9); ymax = w.get('ymax', 1e9)
    for m in meshes:
        vg = m.vertex_groups.get(xb['name']) or m.vertex_groups.new(name=xb['name'])
        mw = m.matrix_world
        moved = 0
        for v in m.data.vertices:
            p = mw @ v.co
            if not (zmin <= p.z <= zmax and ymin <= p.y <= ymax): continue
            d = min(((Vector((p.x - c.x, 0, p.z - c.z)) if flat else (p - c)).length) for c in cs)
            k = 1 - smooth(inner, R, d)
            if k <= 1e-3: continue
            # scale existing influences down, give k to the new bone
            for g in v.groups:
                g.weight *= (1 - k)
            vg.add([v.index], k, 'REPLACE')
            moved += 1
        print('WEIGHT', xb['name'], m.name, moved, 'verts')

# ---------------------------------------------------------------- 3b. added nubs (tail stubs etc.)
for nb in cfg.get('nubs', []):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=14, radius=1.0, location=nb['center'])
    ob = bpy.context.active_object
    ob.name = nb.get('name', 'Nub')
    ob.scale = nb['radii']
    bpy.ops.object.transform_apply(scale=True)
    mat = bpy.data.materials.new(ob.name)
    mat.use_nodes = True
    h = nb.get('color', '#5aa845').lstrip('#')
    s2l = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    col = tuple(s2l(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4)) + (1,)
    mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = col
    mat.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.8
    ob.data.materials.append(mat)
    for poly in ob.data.polygons: poly.use_smooth = True
    g = ob.vertex_groups.new(name=nb['bone']); g.add(list(range(len(ob.data.vertices))), 1.0, 'REPLACE')
    ob.parent = arm
    mod = ob.modifiers.new('Armature', 'ARMATURE'); mod.object = arm
    meshes.append(ob)

# normalise + limit to 4 influences
for m in meshes:
    for v in m.data.vertices:
        gs = sorted(v.groups, key=lambda g: -g.weight)
        for g in gs[4:]:
            m.vertex_groups[g.group].remove([v.index])
        gs = [g for g in v.groups]
        s = sum(g.weight for g in gs)
        if s > 0:
            for g in gs: g.weight /= s

# ---------------------------------------------------------------- 4. lens glass (eyes show through it)
lens = cfg.get('lens')
if lens:
    import bmesh
    body = meshes[0]
    bm = bmesh.new(); bm.from_mesh(body.data); bm.normal_update()
    keep = set()
    for f in bm.faces:
        cw = body.matrix_world @ f.calc_center_median()
        if any((cw - Vector(cc)).length < lens['radius'] for cc in lens['centers']) and f.normal.y < -0.2:
            keep.add(f.index)
    kill = [f for f in bm.faces if f.index not in keep]
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    for v in bm.verts: v.co = v.co + v.normal * lens['offset']
    me = bpy.data.meshes.new('MaskLens')
    bm.to_mesh(me); bm.free()
    lo = bpy.data.objects.new('MaskLens', me)
    bpy.context.scene.collection.objects.link(lo)
    lo.matrix_world = body.matrix_world
    mat = bpy.data.materials.new('MaskLens')
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (0.55, 0.65, 0.72, 1)
    bsdf.inputs['Alpha'].default_value = 0.28
    bsdf.inputs['Roughness'].default_value = 0.05
    try: mat.surface_render_method = 'BLENDED'
    except Exception: mat.blend_method = 'BLEND'
    me.materials.clear(); me.materials.append(mat)
    # lens rides the head rigidly
    for g in list(lo.vertex_groups): lo.vertex_groups.remove(g)
    hg = lo.vertex_groups.new(name='head'); hg.add(list(range(len(me.vertices))), 1.0, 'REPLACE')
    mod = lo.modifiers.new('Armature', 'ARMATURE'); mod.object = arm
    lo.parent = arm
    meshes.append(lo)
    print('LENS faces', len(me.polygons))

# ---------------------------------------------------------------- 5. markers (ray-cast from the front)
dg = bpy.context.evaluated_depsgraph_get()
body = meshes[0]
bvh = BVHTree.FromObject(body, dg)
inv_b = body.matrix_world.inverted()
def gl(v): return [round(v.x, 4), round(v.z, 4), round(-v.y, 4)]
out_markers = {}
for key, (x, z) in cfg.get('markers', {}).items():
    o = inv_b @ Vector((x, -5, z)); d = (inv_b.to_3x3() @ Vector((0, 1, 0))).normalized()
    loc, nrm, idx, dist = bvh.ray_cast(o, d)
    if loc is None: print('MARKER MISS', key); continue
    lw = body.matrix_world @ loc
    # average normal over a small disc (smoother than the hit face)
    nw = (body.matrix_world.to_3x3() @ nrm).normalized()
    out_markers[key] = {'position': gl(lw), 'normal': gl(nw)}
print('MARKERS', json.dumps(out_markers))

# ---------------------------------------------------------------- 6. export
bpy.ops.object.select_all(action='DESELECT')
for o in [arm] + meshes: o.select_set(True)
bpy.context.view_layer.objects.active = arm
out_glb = os.path.join(out_dir, cfg['model_file'])
bpy.ops.export_scene.gltf(filepath=out_glb, export_format='GLB', use_selection=True, export_yup=True,
                          export_skins=True, export_animations=False, export_morph=False, export_def_bones=False)
print('WROTE', out_glb, os.path.getsize(out_glb))
print('BONES', json.dumps([b.name for b in arm.data.bones]))

# ---------------------------------------------------------------- 7. previews (+ a posed deformation test)
if cfg.get('previews', True):
    sc = bpy.context.scene
    try: sc.render.engine = 'BLENDER_EEVEE'
    except TypeError: sc.render.engine = 'BLENDER_EEVEE_NEXT'
    sc.render.film_transparent = True
    sc.view_settings.view_transform = 'Standard'
    w = bpy.data.worlds.new('W'); sc.world = w; w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.0
    sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN')); sun.data.energy = 2.5
    sun.rotation_euler = (math.radians(45), 0, math.radians(-30)); sc.collection.objects.link(sun)
    pts = [body.matrix_world @ v.co for v in body.data.vertices]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    ctr = (lo + hi) / 2
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); cam.data.type = 'ORTHO'
    cam.data.ortho_scale = max(hi.z - lo.z, hi.x - lo.x) * 1.08
    sc.collection.objects.link(cam); sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y = 900, 1100
    def shoot(name, yaw):
        a = math.radians(yaw)
        cam.location = (ctr.x + 6 * math.sin(a), ctr.y - 6 * math.cos(a), ctr.z)
        cam.rotation_euler = (math.radians(90), 0, a)
        sc.render.filepath = os.path.join(out_dir, f'preview_{name}.png')
        bpy.ops.render.render(write_still=True)
    shoot('front', 0); shoot('three_quarter', 35); shoot('back', 180)
    # posed: arms up, head turned (checks the weights)
    pb = arm.pose.bones
    from mathutils import Matrix
    def rot(bn, axis, deg):
        if bn in pb: pb[bn].rotation_mode = 'XYZ'; setattr(pb[bn].rotation_euler, axis, math.radians(deg))
    rot('leftUpperArm', 'z', 55); rot('rightUpperArm', 'z', -55); rot('head', 'y', 25); rot('leftLowerArm', 'z', 30)
    bpy.context.view_layer.update()
    shoot('posed', 25)
