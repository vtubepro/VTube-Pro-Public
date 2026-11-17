"""Base-head scene helpers for the anime hair toolkit (contact sheets / style previews).

Loads a VRoid VRM (CC0 pixiv sample) as the base head, removes its own hair, returns the HeadFrame + anchors, and
renders small toon previews (cel shading approximating MToon + inverted-hull outlines)."""
from __future__ import annotations

import math
import os
import shutil
import tempfile

import bpy
import numpy as np
from mathutils import Vector

from . import hairkit as hk


def clear():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.armatures, bpy.data.lights,
                 bpy.data.cameras, bpy.data.worlds):
        for d in list(coll):
            coll.remove(d)


def load_base(vrm_path, drop=('Hair',)):
    clear()
    tmp = os.path.join(tempfile.gettempdir(), 'anime_hair_base.glb')
    shutil.copyfile(vrm_path, tmp)
    bpy.ops.import_scene.gltf(filepath=tmp)
    for o in list(bpy.data.objects):
        if o.animation_data:
            o.animation_data.action = None
        if o.type == 'MESH' and (o.name.startswith(drop) or o.name in ('Cube', 'Icosphere')):
            bpy.data.objects.remove(o, do_unlink=True)
    arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    B = {b.name: np.array(arm.matrix_world @ b.head_local) for b in arm.data.bones}
    return arm, B


def head_frame(B, head_objs):
    eye = (B['J_Adj_L_FaceEye'] + B['J_Adj_R_FaceEye']) / 2 if 'J_Adj_L_FaceEye' in B else B['J_Bip_C_Head'] + [0, 0, 0.07]
    neck = B['J_Bip_C_Neck'][2]
    F = hk.HeadFrame.from_objects(head_objs, neck_z=neck + 0.02, eye_z=eye[2])
    F.eye = eye
    return F


def toonify_scene(default_shade=(0.80, 0.74, 0.84)):
    """Cel version of every material (same approach as the anime review renderer): diffuse -> shader-to-RGB ->
    constant ramp (shade colour / white) x base colour (+ emission), alpha kept."""
    for o in bpy.data.objects:
        if o.type != 'MESH':
            continue
        for sl in o.material_slots:
            m = sl.material
            if not m or not m.use_nodes or m.get('toon') or m.name == 'HK_Outline':
                continue
            nt = m.node_tree
            bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
            out = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'), None)
            if not bsdf or not out:
                continue
            col_in = bsdf.inputs['Base Color']; alpha_in = bsdf.inputs['Alpha']
            em_in = bsdf.inputs.get('Emission Color'); ems = bsdf.inputs.get('Emission Strength')
            col_src = col_in.links[0].from_socket if col_in.links else None
            alpha_src = alpha_in.links[0].from_socket if alpha_in.links else None
            em_src = em_in.links[0].from_socket if em_in is not None and em_in.links else None
            base = tuple(col_in.default_value)
            shade = tuple(m.get('shade', default_shade))
            diff = nt.nodes.new('ShaderNodeBsdfDiffuse'); s2r = nt.nodes.new('ShaderNodeShaderToRGB')
            nt.links.new(diff.outputs[0], s2r.inputs[0])
            ramp = nt.nodes.new('ShaderNodeValToRGB'); ramp.color_ramp.interpolation = 'CONSTANT'
            ramp.color_ramp.elements[0].color = (*shade[:3], 1); ramp.color_ramp.elements[1].position = 0.12
            ramp.color_ramp.elements[1].color = (1, 1, 1, 1)
            nt.links.new(s2r.outputs[0], ramp.inputs[0])
            mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'; mix.inputs[0].default_value = 1
            if col_src:
                nt.links.new(col_src, mix.inputs[6])
            else:
                mix.inputs[6].default_value = base
            nt.links.new(ramp.outputs[0], mix.inputs[7])
            add = nt.nodes.new('ShaderNodeMix'); add.data_type = 'RGBA'; add.blend_type = 'ADD'; add.inputs[0].default_value = 1
            nt.links.new(mix.outputs[2], add.inputs[6])
            k = ems.default_value if ems else 0
            if em_src and k > 0:
                em_mul = nt.nodes.new('ShaderNodeMix'); em_mul.data_type = 'RGBA'; em_mul.blend_type = 'MULTIPLY'; em_mul.inputs[0].default_value = 1
                nt.links.new(em_src, em_mul.inputs[6]); em_mul.inputs[7].default_value = (k, k, k, 1)
                nt.links.new(em_mul.outputs[2], add.inputs[7])
            else:
                ec = tuple(em_in.default_value) if em_in is not None else (0, 0, 0, 1)
                add.inputs[7].default_value = tuple(c * k for c in ec[:3]) + (1,)
            emis = nt.nodes.new('ShaderNodeEmission'); nt.links.new(add.outputs[2], emis.inputs[0])
            if alpha_src or m.blend_method != 'OPAQUE':
                tr = nt.nodes.new('ShaderNodeBsdfTransparent'); mx = nt.nodes.new('ShaderNodeMixShader')
                if alpha_src:
                    nt.links.new(alpha_src, mx.inputs[0])
                else:
                    mx.inputs[0].default_value = alpha_in.default_value
                nt.links.new(tr.outputs[0], mx.inputs[1]); nt.links.new(emis.outputs[0], mx.inputs[2])
                nt.links.new(mx.outputs[0], out.inputs['Surface'])
            else:
                nt.links.new(emis.outputs[0], out.inputs['Surface'])
            m['toon'] = 1


def outline_all(width=0.0011, skip=('Face', 'Eye')):
    for o in list(bpy.data.objects):
        if o.type == 'MESH' and not o.hide_render and not any(k in o.name for k in skip) and not o.get('no_outline'):
            hk.add_outline(o, width)


def setup_render(res=(420, 420), bg=(0.86, 0.86, 0.88)):
    sc = bpy.context.scene
    try:
        sc.render.engine = 'BLENDER_EEVEE'
    except TypeError:
        sc.render.engine = 'BLENDER_EEVEE_NEXT'
    sc.eevee.taa_render_samples = 8
    sc.view_settings.view_transform = 'Standard'
    w = bpy.data.worlds.new('W'); sc.world = w; w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (*bg, 1)
    sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN')); sun.data.energy = 3.0
    sun.rotation_euler = (math.radians(40), 0, math.radians(-30)); sc.collection.objects.link(sun)
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); cam.data.type = 'ORTHO'
    sc.collection.objects.link(cam); sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y = res
    return cam


def shoot(cam, path, center, span, yaw=0.0, pitch=0.0, res=None):
    sc = bpy.context.scene
    if res:
        sc.render.resolution_x, sc.render.resolution_y = res
    a = math.radians(yaw); p = math.radians(pitch); d = 6
    # the character faces +Y: a camera at yaw 0 sits in front (+Y) looking back (-Y)
    cam.location = (center[0] + d * math.sin(a) * math.cos(p), center[1] + d * math.cos(a) * math.cos(p), center[2] + d * math.sin(p))
    cam.rotation_euler = (math.radians(90) - p, 0, math.radians(180) - a)
    cam.data.ortho_scale = span
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print('WROTE', path)


def sheet(paths, out, cols, labels=None, cell=None):
    """Tile rendered PNGs into one image (Blender images, numpy)."""
    imgs = []
    for p in paths:
        im = bpy.data.images.load(p)
        w, h = im.size
        a = np.array(im.pixels[:], np.float32).reshape(h, w, 4)
        imgs.append(a); bpy.data.images.remove(im)
    h, w = imgs[0].shape[:2]
    rows = (len(imgs) + cols - 1) // cols
    S = np.ones((rows * h, cols * w, 4), np.float32)
    for i, a in enumerate(imgs):
        r, c = divmod(i, cols)
        S[(rows - 1 - r) * h:(rows - r) * h, c * w:(c + 1) * w] = a
    img = bpy.data.images.new('sheet', cols * w, rows * h, alpha=True)
    img.pixels.foreach_set(S.reshape(-1))
    img.filepath_raw = out; img.file_format = 'PNG'; img.save()
    print('SHEET', out)
