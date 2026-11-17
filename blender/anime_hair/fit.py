"""anime_hair.fit — fit / preview harness: build a hair style on a REAL character head and review it like the app.

    blender -b --factory-startup --python fit.py -- <character.vrm> <style> <out_prefix> [options as key=value]

options:
  views=front,tq,side,back,bust,top     (see VIEWS)            res=600
  parts=<npz>[;<npz>...]                extra rigid parts to show (stage-2 dumps, glTF space), e.g. a skull mask
  press=<mask_frame.json>               a box the hair is pressed under (HeadFrame.pressers)
  seed=7   only=<layers>                build only these clump layers (debug)
  export=<dir>                          also dump Hair.npz / Hair_Ink.npz / hair_bones.json (stage-2 format)
  geo=1                                 print the head frame (centre, radii, eye) in head-local units and exit

The character's own hair meshes (names starting with 'Hair') are removed. Rendering approximates MToon (2-step
cel ramp x texture, shade colour multiply, key light from the app's KEY_DIR) with inverted-hull outlines; the
hair's own ink hull (build.ink_hull) is rendered exactly as exported."""
from __future__ import annotations

import json
import math
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402

from anime_hair import hairkit as hk, styles, build  # noqa: E402

# the app's key light (src/stage/Stage.ts KEY_DIR, three.js space after rotateVRM0) in Blender space
KEY_DIR_THREE = np.array([1.55, 2.3, 2.35])
KEY_DIR = hk.unit([-KEY_DIR_THREE[0], KEY_DIR_THREE[2], KEY_DIR_THREE[1]])

# name: (yaw deg, pitch deg, span m, centre offset from the head centre (x, y, z))
VIEWS = {
    'front': (0, 0, 0.42, (0, 0, -0.02)), 'tq': (35, 0, 0.42, (0, 0, -0.02)), 'tqr': (-35, 0, 0.42, (0, 0, -0.02)),
    'side': (90, 0, 0.42, (0, 0, -0.02)), 'sider': (-90, 0, 0.42, (0, 0, -0.02)), 'back': (180, 0, 0.42, (0, 0, -0.02)),
    'top': (0, 55, 0.42, (0, 0, 0.0)), 'bust': (15, 3, 0.75, (0, 0, -0.2)), 'face': (0, 0, 0.26, (0, 0, -0.03)),
    'low': (10, -12, 0.42, (0, 0, -0.03)),
}


def parse_opts(args):
    o = {}
    for a in args:
        if '=' in a:
            k, v = a.split('=', 1); o[k] = v
    return o


def clear():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)


def load_vrm(path, drop=('Hair',)):
    clear()
    tmp = os.path.join(tempfile.gettempdir(), 'anime_hair_fit_src.glb')
    shutil.copyfile(path, tmp)
    bpy.ops.import_scene.gltf(filepath=tmp)
    for ob in list(bpy.data.objects):
        if ob.animation_data:
            ob.animation_data.action = None
        if ob.type == 'MESH' and (ob.name.startswith(drop) or ob.name in ('Cube', 'Icosphere')):
            bpy.data.objects.remove(ob, do_unlink=True)
    arm = next(ob for ob in bpy.data.objects if ob.type == 'ARMATURE')
    B = {b.name: np.array(arm.matrix_world @ b.head_local) for b in arm.data.bones}
    return arm, B


def load_npz(path, name=None, material=None):
    """A stage-2 part dump (glTF space, triangles, per-corner normals) as a Blender mesh (custom normals kept)."""
    z = np.load(path, allow_pickle=False)
    P = z['P'].astype(np.float64)
    Pb = np.c_[P[:, 0], -P[:, 2], P[:, 1]]
    N = z['N'].astype(np.float64); Nb = np.c_[N[:, 0], -N[:, 2], N[:, 1]]
    T = z['T'].astype(np.int64)
    me = bpy.data.meshes.new(name or os.path.basename(path)[:-4])
    me.from_pydata(Pb.tolist(), [], T.tolist())
    uv = me.uv_layers.new(name='UVMap')
    UV = z['UV']
    li = np.zeros(len(me.loops), int); me.loops.foreach_get('vertex_index', li)
    uv.data.foreach_set('uv', np.c_[UV[li, 0], 1 - UV[li, 1]].reshape(-1))
    for p in me.polygons:
        p.use_smooth = True
    me.normals_split_custom_set_from_vertices(Nb.tolist())
    ob = bpy.data.objects.new(me.name, me)
    bpy.context.scene.collection.objects.link(ob)
    if material:
        me.materials.append(material)
    return ob, z


def tex_material(name, tex_path, emit_path=None):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; b = nt.nodes['Principled BSDF']
    tx = nt.nodes.new('ShaderNodeTexImage'); tx.image = bpy.data.images.load(tex_path, check_existing=True)
    nt.links.new(tx.outputs['Color'], b.inputs['Base Color'])
    if emit_path:
        te = nt.nodes.new('ShaderNodeTexImage'); te.image = bpy.data.images.load(emit_path, check_existing=True)
        nt.links.new(te.outputs['Color'], b.inputs['Emission Color']); b.inputs['Emission Strength'].default_value = 1.0
    return m


def head_frame(B, head_objs):
    eye = (B['J_Adj_L_FaceEye'] + B['J_Adj_R_FaceEye']) / 2 if 'J_Adj_L_FaceEye' in B else B['J_Bip_C_Head'] + [0, 0, 0.07]
    F = hk.HeadFrame.from_objects(head_objs, neck_z=B['J_Bip_C_Neck'][2] + 0.02, eye_z=eye[2])
    F.eye = np.array(eye)
    return F


def add_presser(F, mask_json, grow=(1.25, 1.0, 1.2), depth=-0.25):
    fr = json.load(open(mask_json))
    c, R, W, D, H = np.array(fr['origin']), np.array(fr['R']), fr['W'], fr['D'], fr['H']
    F.pressers.append((c, R, np.array([W * grow[0], D * grow[1], H * grow[2]]), D * depth))
    return fr


# ============================================================================ preview shading
SKIN_SHADE = (0.80, 0.76, 0.92)
DEFAULT_SHADE = (0.72, 0.68, 0.80)


def cel(mat, shade=None, toony=0.065, shift=0.2):
    """Principled material -> emission of texture x (lit ? 1 : shade) on a narrow N.L ramp (MToon-like)."""
    if not mat or not mat.use_nodes or mat.get('toon'):
        return
    nt = mat.node_tree
    bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    out = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'), None)
    if not bsdf or not out:
        return
    shade = shade or tuple(mat.get('shade', SKIN_SHADE if 'SKIN' in mat.name else DEFAULT_SHADE))
    col_in = bsdf.inputs['Base Color']; alpha_in = bsdf.inputs['Alpha']
    em_in = bsdf.inputs.get('Emission Color'); ems = bsdf.inputs.get('Emission Strength')
    col_src = col_in.links[0].from_socket if col_in.links else None
    alpha_src = alpha_in.links[0].from_socket if alpha_in.links else None
    em_src = em_in.links[0].from_socket if em_in is not None and em_in.links else None
    # MToon: shading = linearstep(-1 + toony, 1 - toony, dot(N, L) + shift) with the app's key light; N = the
    # SHADING normal (custom normals included), so this previews exactly what the proxy-normal transfer does
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    dot = nt.nodes.new('ShaderNodeVectorMath'); dot.operation = 'DOT_PRODUCT'
    nt.links.new(geo.outputs['Normal'], dot.inputs[0]); dot.inputs[1].default_value = tuple(KEY_DIR)
    mr = nt.nodes.new('ShaderNodeMapRange'); mr.clamp = True
    mr.inputs['From Min'].default_value = -toony - shift; mr.inputs['From Max'].default_value = toony - shift
    nt.links.new(dot.outputs['Value'], mr.inputs['Value'])
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    e0, e1 = ramp.color_ramp.elements
    e0.position = 0.0; e0.color = (*shade[:3], 1)
    e1.position = 1.0; e1.color = (1, 1, 1, 1)
    nt.links.new(mr.outputs['Result'], ramp.inputs[0])
    mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'; mix.inputs[0].default_value = 1
    if col_src:
        nt.links.new(col_src, mix.inputs[6])
    else:
        mix.inputs[6].default_value = tuple(col_in.default_value)
    nt.links.new(ramp.outputs[0], mix.inputs[7])
    add = nt.nodes.new('ShaderNodeMix'); add.data_type = 'RGBA'; add.blend_type = 'ADD'; add.inputs[0].default_value = 1
    nt.links.new(mix.outputs[2], add.inputs[6])
    k = ems.default_value if ems else 0
    if em_src and k > 0:
        em = nt.nodes.new('ShaderNodeMix'); em.data_type = 'RGBA'; em.blend_type = 'MULTIPLY'; em.inputs[0].default_value = 1
        nt.links.new(em_src, em.inputs[6]); em.inputs[7].default_value = (k, k, k, 1)
        nt.links.new(em.outputs[2], add.inputs[7])
    else:
        add.inputs[7].default_value = (0, 0, 0, 1)
    emis = nt.nodes.new('ShaderNodeEmission'); nt.links.new(add.outputs[2], emis.inputs[0])
    if alpha_src or getattr(mat, 'surface_render_method', 'DITHERED') == 'BLENDED' or mat.blend_method != 'OPAQUE':
        tr = nt.nodes.new('ShaderNodeBsdfTransparent'); mx = nt.nodes.new('ShaderNodeMixShader')
        if alpha_src:
            nt.links.new(alpha_src, mx.inputs[0])
        else:
            mx.inputs[0].default_value = alpha_in.default_value
        nt.links.new(tr.outputs[0], mx.inputs[1]); nt.links.new(emis.outputs[0], mx.inputs[2])
        nt.links.new(mx.outputs[0], out.inputs['Surface'])
    else:
        nt.links.new(emis.outputs[0], out.inputs['Surface'])
    mat['toon'] = 1


def ink_material(name, color):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name); m.use_nodes = True; m.use_backface_culling = True
    nt = m.node_tree; nt.nodes.clear()
    e = nt.nodes.new('ShaderNodeEmission'); e.inputs[0].default_value = (*color, 1)
    o = nt.nodes.new('ShaderNodeOutputMaterial'); nt.links.new(e.outputs[0], o.inputs[0])
    m['toon'] = 1
    return m


def outline_objects(objs, width=0.0012, color=(0.08, 0.06, 0.12)):
    """Inverted hull via a flipped solidify (like MToon world-space outlines) on everything but face / eyes."""
    ol = ink_material('FIT_Outline', color)
    for o in objs:
        nm = o.name.lower()
        if any(k in nm for k in ('face', 'eye')) and 'body' not in nm:
            continue
        if o.get('no_outline'):
            continue
        o.data.materials.append(ol)
        md = o.modifiers.new('OL', 'SOLIDIFY'); md.thickness = -width; md.use_flip_normals = True
        md.material_offset = len(o.data.materials) - 1; md.use_rim = False


def setup_render(res=600, bg=(0.84, 0.84, 0.86)):
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
    sc.collection.objects.link(sun)
    sun.rotation_euler = Vector(-KEY_DIR).to_track_quat('-Z', 'Y').to_euler()
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam')); cam.data.type = 'ORTHO'
    sc.collection.objects.link(cam); sc.camera = cam
    sc.render.resolution_x = sc.render.resolution_y = res
    return cam


def shoot(cam, path, center, span, yaw=0.0, pitch=0.0):
    sc = bpy.context.scene
    a, p, d = math.radians(yaw), math.radians(pitch), 6
    cam.location = (center[0] + d * math.sin(a) * math.cos(p), center[1] + d * math.cos(a) * math.cos(p), center[2] + d * math.sin(p))
    cam.rotation_euler = (math.radians(90) - p, 0, math.radians(180) - a)
    cam.data.ortho_scale = span
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print('WROTE', path)


# ============================================================================ main
def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    vrm, style, prefix = argv[0], argv[1], os.path.abspath(argv[2])
    opt = parse_opts(argv[3:])
    os.makedirs(os.path.dirname(prefix), exist_ok=True)
    arm, B = load_vrm(vrm)
    heads = [o for o in bpy.data.objects if o.type == 'MESH' and o.name.split('.')[0] in ('Face', 'Body')]
    F = head_frame(B, heads)
    extra = []
    for pth in [p for p in opt.get('parts', '').split(';') if p]:
        ob, z = load_npz(pth)
        mats = [str(x) for x in z['mat_names']]
        tdir = opt.get('texdir')
        if tdir and mats:
            nm = mats[0]
            base = {'Mask': ('mask.png', 'mask_emit.png')}.get(nm)
            if base:
                ob.data.materials.append(tex_material(nm, os.path.join(tdir, base[0]), os.path.join(tdir, base[1])))
        extra.append(ob)
    if opt.get('press'):
        add_presser(F, opt['press'])
    if opt.get('geo'):
        d = {'c': F.c.tolist(), 'r': F.r.tolist(), 'eye': F.eye.tolist(),
             'eye_local': ((F.eye - F.c) / F.r).tolist(), 'head_bone': B['J_Bip_C_Head'].tolist(),
             'neck': B['J_Bip_C_Neck'].tolist()}
        for nm in ('J_Adj_L_FaceEye', 'J_Adj_R_FaceEye'):
            if nm in B:
                d[nm] = ((B[nm] - F.c) / F.r).tolist()
        if F.pressers:
            pc = F.pressers[0][0]
            d['mask_local'] = ((pc - F.c) / F.r).tolist()
        print('GEO', json.dumps(d))
    if style == 'none':                       # bald head (+ parts): reference renders for designing a style
        for o in bpy.data.objects:
            if o.type == 'MESH':
                for s in o.material_slots:
                    cel(s.material)
        outline_objects([o for o in bpy.data.objects if o.type == 'MESH'])
        cam = setup_render(int(opt.get('res', 600)))
        for v in opt.get('views', 'front,side,top,back').split(','):
            yaw, pitch, span, off = VIEWS[v]
            shoot(cam, f'{prefix}_{v}.png', F.c + np.array(off), span, yaw, pitch)
        return
    rng = np.random.default_rng(int(opt.get('seed', 7)))
    res = styles.STYLES[style](F, rng)
    if opt.get('only'):
        res.clumps = [c for c in res.clumps if c.layer in opt['only'].split(',')]
        res.chains = {}
    tex = prefix + '_tex.png'
    out = build.build(F, res, 'Hair', tex_path=tex)
    hair = out['hair']
    print(f'STYLE {style}: {len(res.clumps)} clumps (+{out["filled"]} fillers), {len(hair.data.vertices)} verts, '
          f'{len(hair.data.polygons)} faces')
    ink = build.ink_hull(out, res.palette) if hasattr(build, 'ink_hull') else None
    if opt.get('export'):
        build.export_npz(out, res, opt['export'], head_bone='J_Bip_C_Head')
    if opt.get('texout'):                     # the atlas + a solid ink swatch for the VRM materials
        shutil.copyfile(tex, os.path.join(opt['texout'], 'hair_atlas.png'))
        hk._save_png(np.ones((4, 4, 4), np.float32) * np.array([*res.palette.ink, 1], np.float32),
                     os.path.join(opt['texout'], 'hair_ink_solid.png'))
    for o in bpy.data.objects:
        if o.type == 'MESH':
            for s in o.material_slots:
                if s.material and s.material.name.startswith(out['material'].name):
                    cel(s.material, shade=res.palette.shade_mul, toony=0.05, shift=0.1)
                elif s.material:
                    cel(s.material)
    skip = {hair.name, out['scalp'].name} | ({ink.name} if ink else set())
    outline_objects([o for o in bpy.data.objects if o.type == 'MESH' and o.name not in skip and not o.hide_render])
    if not ink:
        hk.add_outline(hair, 0.0011, res.palette.ink)
    cam = setup_render(int(opt.get('res', 600)))
    for v in opt.get('views', 'front,tq,side,back').split(','):
        yaw, pitch, span, off = VIEWS[v]
        c = F.c + np.array(off)
        if v == 'bust':
            c = np.array([0, B['J_Bip_C_Head'][1], B['J_Bip_C_Head'][2] - 0.12])
        shoot(cam, f'{prefix}_{v}.png', c, span, yaw, pitch)


if __name__ == '__main__':
    main()
