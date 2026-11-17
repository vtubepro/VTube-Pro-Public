"""
costume_kit - build costumes (outfits + props) fitted to ANY humanoid-ish skinned base avatar.

Costumes are separate GLBs that the VTube Pro web runtime binds onto the base avatar's skeleton BY
BONE NAME, reusing the costume's inverse bind matrices. This kit guarantees that contract: it
imports the base GLB, builds garments grown from / measured on the body surface, skins them from
the body's own weights, adds extra bones (springs / props) WITHOUT touching existing bones, and
exports ONLY the costume meshes + the base armature (all bones, identical rest pose).

Run headless:  blender -b --factory-startup --python my_costume.py -- [args]
Import:        sys.path.insert(0, <VTube Pro>/blender); import costume_kit as kit

COORDINATES (Blender world space, metres): +Z up, character faces -Y (front), character LEFT = +X
(= screen RIGHT when you look at the character). Azimuths: 0 = front, 90 = character left,
180 = back, 270 (or -90) = character right. The glTF export maps this to Y-up, +Z front.
"L"/"R" in landmark keys and `side` args always mean the CHARACTER's left / right.
Colours are sRGB hex strings ('#f2c94c'). Everything returns plain bpy objects unless noted.

WORKED EXAMPLE (the whole script; ~40 lines is enough for a decent outfit)
------------------------------------------------------------------------
    import os, sys
    sys.path.insert(0, r'C:/path/to/VTube Pro/blender')        # server: already on sys.path
    import costume_kit as kit

    kit.load_base(r'C:/.../frog/frog.glb')                    # or kit.load_base(None) if pre-imported
    m = kit.measure()                                          # landmarks, see measure() docs
    print(kit.describe())                                      # human-readable landmark summary

    # textures + materials (real images, packed into the GLB)
    camo = kit.material('Camo', image=kit.tex_camo(seed=3), roughness=0.9)
    olive = kit.material('Olive', '#56613a')
    black = kit.material('Black', '#1b1b1f', roughness=0.5)

    # garments grown from the body
    shirt = kit.shell(z=(m['hips'].z + 0.02, m['neck'].z + 0.03), offset=0.018, thickness=0.01,
                      material=camo, name='Shirt')
    for side in 'LR':
        kit.sleeve(side, end=0.95, radius_scale=1.15, offset=0.02, material=camo)
    kit.pants(length=0.85, offset=0.014, material=camo)
    belt, buckle = kit.belt(m['belly'].z - 0.12, width=0.07, material=olive, buckle_material=black)
    kit.strap(kit.surface_point(m['belly'].z - 0.1, 25, 0.03),
              kit.surface_point(m['neck'].z, 35, 0.03), width=0.045, material=olive)
    kit.pouch(kit.surface_point(m['belly'].z - 0.12, 40, 0.05), (0.09, 0.05, 0.10), material=olive,
              facing=kit.surface_normal(m['belly'].z - 0.12, 40))

    # hat seated on the head (auto size / height, clears the eyes), label on its band
    hat = kit.hat_helmet(material=olive)
    kit.label_face(hat.parts['band'], 'HelmetLabel', hat.band_rect(width=0.2), text='FROG ACTUAL',
                   color='#1a1a1a', background='#6b7446')

    # a dangling spring chain (names containing feather/tail/ribbon/sash/tie/chain/pendant/antenna/
    # hat/tassel/strap become springs at runtime) and a rigid prop on the LEFT hand
    kit.add_bone_chain(['antenna_1', 'antenna_2'], 'head', [hat.top, hat.top + kit.V(0, 0, .1),
                                                             hat.top + kit.V(0, 0, .2)])
    ant = kit.tube([hat.top, hat.top + kit.V(0, 0, .2)], 0.008, material=black)
    kit.skin_along(ant, ['antenna_1', 'antenna_2'], root='head')
    h = m['hand_L']                                            # character's LEFT hand = screen right
    kit.add_prop_bone('baton', 'leftHand', h, h + kit.V(0, -0.03, -0.3))
    kit.skin_rigid(kit.tube([h, h + kit.V(0, -0.03, -0.3)], 0.012, material=black, name='Baton'), 'baton')

    out = os.environ.get('VTP_OUT', '.')
    kit.export_costume(os.path.join(out, 'costume.glb'))       # all kit-made objects, auto-skinned
    kit.render_preview(os.path.join(out, 'costume_preview.png'))
    kit.render_thumb(os.path.join(out, 'costume_thumb.png'))
    cdef = kit.write_costume_def('army', 'Army Grunt', 'costumes/army.glb', labels=kit.labels())

RULES OF THUMB
    * Never cover the face: kit.face_box() gives the front-view rect (x0, x1, z0, z1) that must stay
      clear (eyes + mouth are procedural at runtime). export_costume warns if geometry lands there.
    * Offsets are measured from the body surface. Layering: body < shell (0.012-0.02) < vest/robe
      (0.03-0.05) < straps/belts (+0.01 over what they sit on) < pouches.
    * Hats: hat_* auto-seat on the head (`fit='auto'`), clear the eye bulbs, and are rigid on the
      `hat` bone if the base has one (else `head`). Pass radius= to override the auto size.
    * Every builder registers its object; export_costume() exports all registered objects that
      still exist (or pass objects=[...]). Unskinned objects are auto-skinned: garments from the
      body weights, props rigidly following the nearest body point. Keep a costume < 35k tris.
    * Crisp edges: shell(cuts=[(point, normal), ...]) slices the body copy before selecting faces
      (V-necks, hems); robe(open_front=fn) and sleeve/pants ends are already clean. Fur / fluffy
      looks: hem_noise (ragged edges) + fluff (lumpy surface) + tube(..., fluff=0.2) trims.
    * Mascot bases (huge head = upper body, like the frog; m['mascot'] True): hats are small and
      perched on top between the eye lobes; garments start below the face (belly oval stays clear
      above ~ m['face_box'][2]).
    * Bone chains: 2-4 bones per dangling thing, parented to an existing bone, then
      skin_along(obj, chain, root=parent). Rigid held props: add_prop_bone(name, 'leftHand', ...)
      + skin_rigid(obj, name).
    * Labels (runtime-editable text): label_face()/label_panel() create a material whose UVs span
      0..1 over the label; kit.labels() returns the CostumeLabel list for write_costume_def().
    * Clipping is handled for you - don't hand-tune offsets to fight it. export_costume() runs
      fit_to_body() on every mesh (pushes cloth out of the body to a 0.6 %-of-height margin, keeps
      layer order, leaves rigid props / hats and parts tucked under other layers alone) and prints a
      CLIP_REPORT (body poke-through in head-yaw / arms-up / elbow / lean poses). The web runtime then
      repeats the push for any costume and HIDES body skin the costume fully covers, so tight
      garments are fine. Do: skin garments to the body part they cover (auto-skin does), tuck sleeve
      and trouser tops under the shirt / coat instead of butting them edge to edge. If CLIP_REPORT
      shows hundreds for a pose, that garment is too tight there or follows the wrong bones (e.g. a
      robe sleeve skinned to the torso while the arm lifts out of it) - loosen it or skin_to_body it.

API (one line each; see the docstrings for every parameter)
  scene / measuring
    load_base(glb|None, body_meshes, profile) import base (or adopt pre-imported scene), record rest pose
    measure() -> dict      landmarks (see its docstring), cached;  describe() -> printable summary
    bone(role)             VRM role / alias -> bone name ('leftHand', 'head', 'hat', ...) or None
    radius_at(z, az)       body radius from the centre line (torso+head only)
    surface_point(z, az, offset) / surface_normal(z, az)     point / normal on the body at height z
    front_point(x, z, offset, target)   point on the FRONT surface at front-view (x, z)
    head_height(x, y)      top-of-head height incl. eye bulbs;   face_box() -> (x0, x1, z0, z1) keep clear
  garments (all grown / measured on the body; skinned automatically)
    shell(z=(lo, hi), offset, thickness, region, cuts, open_front, front_only, hem_noise, fluff, bones)
    robe(z_top, z_hem, offset, flare, open_front, hem_noise, fluff)    coats, robes, dresses, skirts
    sleeve(side, start, end, radius_scale, offset, flare, hem_noise)   t: 0 shoulder .. 1 wrist .. 1.1 hand
    pants(length, waist_z, offset, leg_scale) / shorts(length)        seat shell + measured leg tubes
    collar(z, height, offset, flare, open_front)   belt(z, width, offset, buckle) -> (belt, buckle)
    strap(p0, p1, width, via=[...])   flat strap wrapped over the body (suspenders, bandoliers, sashes)
    panel(x0, x1, zlo, zhi, offset)   UV-0..1 patch on the body (prints, pockets, shirt fronts)
    decal(poly_xz, offset, thickness) flat shape projected on the body (lapels, collar points, patches)
  hats (auto-sized from m['hat_radius'], auto-seated, clear the eyes, rigid on 'hat'/'head') -> Hat
    hat_top, hat_fedora, hat_cowboy, hat_helmet, hat_cap (.front_rect()), hat_beanie
    Hat: .parts{'crown','brim','band',...} .objects .base .top .radius .point(az, h, out) .band_rect(w)
  props
    box_part(center, size, bevel, rotation|facing, uv='face')   pouch(center, size, facing)
    tube(points, radius|fn(t), fluff)   ring(center, axis, radius)   sphere(center, r|radii)
    cylinder(center, axis, radius, length)   chain(points, link_len, twist)   dish(center, normal, radius)
    feather(base, tip, width, curl, droop) -> (obj, spine points)
  bones (added in EDIT mode, existing bones verified untouched)
    add_prop_bone(name, parent, head, tail)   add_bone_chain(names, parent, points)
  textures (numpy -> packed images; as_array=True returns the array for compositing)
    tex_stripes, tex_camo(palette, seed), tex_zebra, tex_flag_stars, tex_flag_stripes,
    tex_cardboard(seed, tape_strips, labels, marks), tex_sparkle_gold, tex_fur_noise, tex_text(text, w, h, font)
    image(name, array)   material(name, color, image, roughness, metallic)   label_material(...)
    uv_cylinder(obj, tile) uv_planar(obj, direction, tile) uv_rect(obj, rect) uv_box(obj, tile|None)
  labels (runtime-editable text; UVs span 0..1 over the label)
    label_face(obj, material, rect, text, color, background, font) -> aspect   (cuts obj along rect)
    label_panel(material, x0, x1, z0, z1, text, ...) -> obj                    (new patch on the body)
    labels() -> CostumeLabel list for write_costume_def
  skinning
    skin_to_body(obj, exclude, only, smooth)  nearest-face weights from the body
    skin_rigid(obj, bone)   skin_follow(obj, point)   skin_along(obj, chain, root)   skin_blend(obj, fn)
    clean_weights(obj, limit=4)
  output
    export_costume(out_glb, objects=None, fit=True, clip=True) -> report (tris, materials, extra
                           bones, face overlap, fit {pushed, tucked, max_push}, clip CLIP_REPORT)
    fit_to_body(obj, margin=None)   push cloth out of the body (export does it; call earlier to preview)
    clip_report(objs=None)          poke-through counts per test pose; prints CLIP_REPORT {json}
    render_preview(png, base_visible, views=(0, 35))   render_thumb(png, 512)   pose(...) / reset_pose()
    write_costume_def(id, name, file, thumbnail, hides, eyes, labels, prompt)  add_to_profile(json, def)
    wear(costume_glb)  show another costume on the base (previews only; call after export)
  mesh utils
    join, delete, mirror_x, solidify, decimate, displace, fluff, fluff_edges, apply_modifiers,
    set_material, shade_smooth, transform, tri_count, register, smoothstep, hex2lin, V, log

MORE EXAMPLES: (an internal build) (fur coat, fedora + feather chain, gold
chains, cane prop bone) and build_frog.py (hand-built suit). CLI previews of any costume GLB:
    blender -b --factory-startup --python blender/costume_preview.py -- base.glb costume.glb out_prefix
Verify a costume against its base: python tools/check_costume.py base.glb costume.glb
"""
import bpy
import bmesh
import json
import math
import os
import sys
import time

import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

__all__ = []  # star-import discouraged; use `import costume_kit as kit`

_T0 = time.time()
_S = {}           # module state (see _reset_state)


def _reset_state():
    _S.clear()
    _S.update(arm=None, bodies=[], rest={}, base_path=None, profile=None, created=[], extra=[],
              m=None, labels=[], roles={}, bone_cls={}, data=None, bvh={}, kit_mats={})


_reset_state()


def log(*a):
    print('[kit %6.1fs]' % (time.time() - _T0), *a, flush=True)


def V(x=0.0, y=0.0, z=0.0):
    """Vector shortcut: V(x, y, z) or V((x, y, z))."""
    if hasattr(x, '__len__'):
        return Vector(tuple(x))
    return Vector((float(x), float(y), float(z)))


# ============================================================================ colour helpers
def hex2srgb(h):
    if isinstance(h, (tuple, list)):
        return tuple(float(c) for c in h[:3])
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


def _s2l(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex2lin(h):
    return tuple(_s2l(c) for c in hex2srgb(h))


def _smooth(e0, e1, x):
    t = np.clip((np.asarray(x, dtype=float) - e0) / (e1 - e0 + 1e-12), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def smoothstep(e0, e1, x):
    """scalar smoothstep (e0 > e1 allowed: reversed ramp)"""
    return float(_smooth(e0, e1, x))


# ============================================================================ object helpers
def _scene():
    return bpy.context.scene


def _link(ob):
    _scene().collection.objects.link(ob)
    return ob


def register(ob, skin=None):
    """Mark `ob` as part of the costume (exported by export_costume()). skin: default auto-skin mode
    'body' | 'follow' | ('rigid', bone) | None (keep whatever weights it has)."""
    if ob not in _S['created']:
        _S['created'].append(ob)
    if skin is not None:
        ob['kit_skin'] = json.dumps(skin)
    return ob


def _obj_from_bm(name, bm, material=None, skin='follow', smooth=True, sharp=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = _link(bpy.data.objects.new(name, me))
    if material is not None:
        set_material(ob, material)
    if smooth:
        shade_smooth(ob, sharp)
    return register(ob, skin)


def _obj_from_data(name, verts, faces, material=None, skin='follow', smooth=True, sharp=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(map(float, v)) for v in verts], [], [tuple(map(int, f)) for f in faces])
    me.update()
    ob = _link(bpy.data.objects.new(name, me))
    _recalc_normals(ob)
    if material is not None:
        set_material(ob, material)
    if smooth:
        shade_smooth(ob, sharp)
    return register(ob, skin)


def _recalc_normals(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(ob.data)
    bm.free()


def shade_smooth(ob, sharp_angle=None):
    me = ob.data
    me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
    if sharp_angle is not None:
        try:
            me.set_sharp_from_angle(angle=math.radians(sharp_angle))
        except Exception:
            pass
    me.update()


def apply_modifiers(ob, keep_armature=True):
    """Bake all modifiers (except Armature when keep_armature) into the mesh; vertex groups survive."""
    arm_mods = [(m.name, m.object) for m in ob.modifiers if m.type == 'ARMATURE'] if keep_armature else []
    for m in list(ob.modifiers):
        if m.type == 'ARMATURE':
            ob.modifiers.remove(m)
    if not ob.modifiers:
        for n, o in arm_mods:
            ob.modifiers.new(n, 'ARMATURE').object = o
        return ob
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    old = ob.data
    ob.modifiers.clear()
    ob.data = me
    me.name = ob.name
    if old.users == 0:
        bpy.data.meshes.remove(old)
    for n, o in arm_mods:
        ob.modifiers.new(n, 'ARMATURE').object = o
    return ob


def solidify(ob, thickness, offset=1.0, rim=True, even=False):
    """Give a sheet thickness (offset=+1 grows outward along normals, -1 inward)."""
    if abs(thickness) < 1e-6:
        return ob
    md = ob.modifiers.new('solid', 'SOLIDIFY')
    md.thickness = thickness
    md.offset = offset
    md.use_rim = rim
    md.use_even_offset = even
    return apply_modifiers(ob)


def tri_count(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def join(objs, name=None):
    """Join objects (materials + vertex groups merged). Returns the joined object."""
    objs = [o for o in objs if o is not None]
    if len(objs) == 1:
        if name:
            objs[0].name = name
        return objs[0]
    _object_mode()
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    skin = objs[0].get('kit_skin')
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    if name:
        ob.name = name
        ob.data.name = name
    _S['created'] = [o for o in _S['created'] if _alive(o) and o not in objs[1:]]
    if ob not in _S['created']:
        _S['created'].append(ob)
    if skin is not None:
        ob['kit_skin'] = skin
    return ob


def delete(ob):
    if ob in _S['created']:
        _S['created'].remove(ob)
    bpy.data.objects.remove(ob, do_unlink=True)


def _alive(o):
    try:
        o.name
        return True
    except ReferenceError:
        return False


def _object_mode():
    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')


def transform(ob, matrix):
    """Apply a 4x4 world matrix to the mesh data (object stays at identity)."""
    ob.data.transform(matrix)
    ob.data.update()
    return ob


def mirror_x(ob, name=None):
    """Duplicate `ob` mirrored across the character's centre plane (x -> -x). Swaps left/right
    vertex groups (names containing left/right, _L/_R, .L/.R)."""
    me = ob.data.copy()
    nob = _link(bpy.data.objects.new(name or ob.name + '_mirror', me))
    for vg in ob.vertex_groups:
        nob.vertex_groups.new(name=_swap_side(vg.name))
    me.transform(Matrix.Scale(-1, 4, (1, 0, 0)))
    me.flip_normals()
    me.update()
    if ob.get('kit_skin'):
        nob['kit_skin'] = ob['kit_skin']
    return register(nob)


def _swap_side(n):
    for a, b in (('left', 'right'), ('Left', 'Right'), ('_L', '_R'), ('.L', '.R'), ('_l', '_r'), ('.l', '.r')):
        if a in n:
            return n.replace(a, b)
        if b in n:
            return n.replace(b, a)
    return n


# ============================================================================ bones / roles
VRM_ROLES = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
             'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
             'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
             'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
             'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes']
_KEYS = {
    'hips': (['hips', 'pelvis', 'hip'], []), 'spine': (['spine', 'abdomen'], ['2', '3', 'upper']),
    'chest': (['chest', 'spine2', 'spine1', 'thorax'], ['upper']), 'upperChest': (['upperchest', 'spine3'], []),
    'neck': (['neck'], []), 'head': (['head'], ['top', 'end']),
    'Shoulder': (['shoulder', 'clavicle', 'collar'], []),
    'UpperArm': (['upperarm', 'uparm', 'arm'], ['fore', 'lower', 'low']),
    'LowerArm': (['lowerarm', 'forearm', 'elbow'], []), 'Hand': (['hand', 'wrist'], ['index', 'thumb', 'end']),
    'UpperLeg': (['upperleg', 'upleg', 'thigh'], []), 'LowerLeg': (['lowerleg', 'calf', 'shin', 'knee', 'leg'], ['up']),
    'Foot': (['foot', 'ankle'], []), 'Toes': (['toe', 'toes', 'ball'], []),
}


def _side_of(name):
    n = name.lower()
    if 'left' in n or n.startswith(('l_', 'l.', 'j_bip_l')) or n.endswith(('_l', '.l', ' l', '-l')) or '_l_' in n:
        return 'left'
    if 'right' in n or n.startswith(('r_', 'r.', 'j_bip_r')) or n.endswith(('_r', '.r', ' r', '-r')) or '_r_' in n:
        return 'right'
    return None


def _find_roles(arm):
    names = [b.name for b in arm.data.bones]
    roles = {}
    low = {n.lower(): n for n in names}
    for r in VRM_ROLES:
        if r in names:
            roles[r] = r
        elif r.lower() in low:
            roles[r] = low[r.lower()]
    for r in VRM_ROLES:
        if r in roles:
            continue
        side = 'left' if r.startswith('left') else 'right' if r.startswith('right') else None
        core = r[len(side):] if side else r
        keys, bad = _KEYS.get(core, ([core.lower()], []))
        best = None
        for kw in keys:
            for n in names:
                c = n.lower().split(':')[-1]
                c2 = ''.join(ch for ch in c if ch.isalnum())
                if kw not in c2 or any(b in c2 for b in bad):
                    continue
                if _side_of(n) != side:
                    continue
                if n in roles.values():
                    continue
                if best is None or len(n) < len(best):
                    best = n
            if best:
                break
        if best:
            roles[r] = best
    if 'chest' not in roles and 'upperChest' in roles:
        roles['chest'] = roles['upperChest']
    return roles


def bone(role):
    """Bone name for a VRM humanoid role ('head', 'leftHand', 'rightUpperLeg', ...) or an exact bone
    name. Returns None if the base has no such bone."""
    arm = _S['arm']
    if arm is None:
        raise RuntimeError('call kit.load_base() first')
    if role in arm.data.bones:
        return role
    return _S['roles'].get(role)


def _bone_head(role, tail=False):
    b = bone(role)
    if not b:
        return None
    bb = _S['arm'].data.bones[b]
    return _S['arm'].matrix_world @ (bb.tail_local if tail else bb.head_local)


def _classify_bones(arm):
    roles = _S['roles']
    marks = {}
    for side in ('left', 'right'):
        s = side[0].upper()
        for r in ('UpperArm', 'LowerArm', 'Hand'):
            if side + r in roles:
                marks[roles[side + r]] = 'arm_' + s
        for r in ('UpperLeg', 'LowerLeg', 'Foot', 'Toes'):
            if side + r in roles:
                marks[roles[side + r]] = 'leg_' + s
    if 'head' in roles:
        marks[roles['head']] = 'head'
    cls = {}
    for b in arm.data.bones:
        p, c = b, 'torso'
        while p is not None:
            if p.name in marks:
                c = marks[p.name]
                break
            p = p.parent
        cls[b.name] = c
    return cls


_CLASS_ALIASES = {'arms': ('arm_L', 'arm_R'), 'legs': ('leg_L', 'leg_R'), 'limbs': ('arm_L', 'arm_R', 'leg_L', 'leg_R'),
                  'torso': ('torso',), 'head': ('head',), 'arm_L': ('arm_L',), 'arm_R': ('arm_R',),
                  'leg_L': ('leg_L',), 'leg_R': ('leg_R',), 'body': ('torso', 'head')}


def _classes(spec):
    if spec is None:
        return set()
    if isinstance(spec, str):
        spec = [spec]
    out = set()
    for s in spec:
        out.update(_CLASS_ALIASES.get(s, (s,)))
    return out


# ============================================================================ base loading
def load_base(glb_path=None, body_meshes=None, profile=None):
    """Import the base avatar (GLB/glTF/VRM) and make it the fitting target.

    glb_path=None adopts an armature that is already in the scene (e.g. pre-imported by the server).
    body_meshes: optional list of mesh names to fit against (default: every mesh skinned to the
    armature). profile: AvatarProfile json path/dict for eye/mouth markers (default: profile.json
    next to the GLB, if present). Records the rest pose so export can prove it is unchanged.
    Returns (armature, body_meshes)."""
    _object_mode()
    if glb_path:
        _reset_state()
        before = set(bpy.data.objects)
        for o in list(bpy.data.objects):
            bpy.data.objects.remove(o, do_unlink=True)
        kw = dict(filepath=glb_path, bone_heuristic='BLENDER', merge_vertices=True)
        try:
            bpy.ops.import_scene.gltf(disable_bone_shape=True, **kw)
        except TypeError:
            bpy.ops.import_scene.gltf(**kw)
        new = [o for o in bpy.data.objects if o not in before]
        _S['base_path'] = os.path.abspath(glb_path)
    else:
        _reset_state()
        new = list(bpy.data.objects)
    arms = [o for o in new if o.type == 'ARMATURE']
    if not arms:
        raise RuntimeError('base has no armature - costumes need a skinned base avatar')
    arm = max(arms, key=lambda a: len(a.data.bones))
    for pb in arm.pose.bones:
        pb.custom_shape = None
    for o in new:  # stray bone-shape / helper meshes
        if o.type == 'MESH' and o.parent is None and not any(m.type == 'ARMATURE' for m in o.modifiers):
            if o.name.lower().startswith(('icosphere', 'bone_shape')):
                bpy.data.objects.remove(o, do_unlink=True)
    bodies = [o for o in bpy.data.objects if o.type == 'MESH' and
              any(m.type == 'ARMATURE' and m.object == arm for m in o.modifiers)]
    if body_meshes:
        bodies = [o for o in bodies if o.name in body_meshes]
    if not bodies:
        raise RuntimeError('no meshes skinned to the base armature')
    arm.data.pose_position = 'REST'
    _S['arm'], _S['bodies'] = arm, bodies
    _S['base_names'] = [o.name for o in bodies]
    _S['rest'] = {b.name: (arm.matrix_world @ b.matrix_local).copy() for b in arm.data.bones}
    _S['roles'] = _find_roles(arm)
    _S['bone_cls'] = _classify_bones(arm)
    if profile is None and glb_path:
        cand = os.path.join(os.path.dirname(os.path.abspath(glb_path)), 'profile.json')
        profile = cand if os.path.isfile(cand) else None
    if isinstance(profile, str):
        with open(profile, encoding='utf-8') as f:
            profile = json.load(f)
    _S['profile'] = profile
    _build_body_data()
    arm.data.pose_position = 'POSE'
    log('base: %s  armature=%s bones=%d meshes=%s roles=%d' % (
        os.path.basename(glb_path or '(scene)'), arm.name, len(arm.data.bones), [o.name for o in bodies],
        len(_S['roles'])))
    return arm, bodies


def _build_body_data():
    """Gather rest-pose world vertices, polygons, weights and body-part classes of the base meshes."""
    Vs, Ns, W, C, polys, tris = [], [], [], [], [], []
    cls = _S['bone_cls']
    off = 0
    for ob in _S['bodies']:
        me = ob.data
        mw = ob.matrix_world
        nm = mw.to_3x3().inverted_safe().transposed()
        gname = {g.index: g.name for g in ob.vertex_groups}
        for v in me.vertices:
            Vs.append(mw @ v.co)
            Ns.append((nm @ v.normal).normalized())
            w = {}
            for g in v.groups:
                n = gname.get(g.group)
                if n in cls and g.weight > 1e-4:
                    w[n] = w.get(n, 0.0) + g.weight
            W.append(w)
            if w:
                acc = {}
                for n, x in w.items():
                    acc[cls[n]] = acc.get(cls[n], 0) + x
                C.append(max(acc, key=acc.get))
            else:
                C.append('torso')
        for p in me.polygons:
            polys.append(tuple(off + i for i in p.vertices))
        me.calc_loop_triangles()
        for t in me.loop_triangles:
            tris.append(tuple(off + i for i in t.vertices))
        off += len(me.vertices)
    P = np.array([tuple(v) for v in Vs])
    tcls = []
    for t in tris:
        cs = [C[i] for i in t]
        tcls.append(max(set(cs), key=cs.count))
    _S['data'] = dict(V=Vs, P=P, N=Ns, W=W, C=C, polys=polys, tris=tris, tcls=tcls)
    _S['bvh'] = {}


def _bvh(classes=None):
    """BVH over body triangles whose class is in `classes` (None = all). Returns (bvh, tri_index_map)."""
    key = tuple(sorted(classes)) if classes else ('*',)
    if key in _S['bvh']:
        return _S['bvh'][key]
    d = _S['data']
    idx = [i for i, c in enumerate(d['tcls']) if not classes or c in classes]
    bvh = BVHTree.FromPolygons(d['V'], [d['tris'][i] for i in idx]) if idx else None
    _S['bvh'][key] = (bvh, idx)
    return _S['bvh'][key]


def _torso_bvh():
    return _bvh({'torso', 'head'})[0]


# ============================================================================ measuring
def _dir(direction):
    """azimuth degrees / name / vector -> horizontal unit Vector"""
    if isinstance(direction, str):
        direction = {'front': 0, 'left': 90, 'back': 180, 'right': 270}[direction]
    if isinstance(direction, (int, float)):
        a = math.radians(direction)
        return Vector((math.sin(a), -math.cos(a), 0.0))
    d = Vector(direction)
    d.z = 0
    return d.normalized()


def _axis_xy():
    m = _S.get('m')
    if m:
        return m['axis']
    h = _bone_head('hips') or Vector((0, 0, 0))
    sp = _bone_head('spine') or h
    return Vector(((h.x + sp.x) / 2, (h.y + sp.y) / 2))


def radius_at(z, direction=0, classes=('torso', 'head')):
    """Horizontal distance from the body axis to the body surface at height z towards `direction`
    (azimuth deg: 0 front, 90 char-left, 180 back, 270 char-right; or 'front'/'left'/...; or a
    vector). Only torso+head surfaces by default (arms/legs ignored). 0.0 if nothing is hit."""
    bvh = _bvh(set(classes))[0]
    a = _axis_xy()
    o = Vector((a.x, a.y, z))
    d = _dir(direction)
    hit = bvh.ray_cast(o, d, 5.0)
    if hit[0] is None:
        return 0.0
    return (hit[0] - o).length


def surface_point(z, direction=0, offset=0.0, classes=('torso', 'head')):
    """World point on the body surface at height z towards azimuth `direction`, pushed `offset`
    metres out along the surface normal. Falls back to the drape radius if nothing is hit."""
    bvh = _bvh(set(classes))[0]
    a = _axis_xy()
    o = Vector((a.x, a.y, z))
    d = _dir(direction)
    loc, n, _, _ = bvh.ray_cast(o, d, 5.0)
    if loc is None:
        r = _drape_radius(z, direction)
        return o + d * (r + offset)
    if n.dot(d) < 0:
        n = -n
    return loc + n * offset


def surface_normal(z, direction=0, classes=('torso', 'head')):
    """Outward surface normal at surface_point(z, direction)."""
    bvh = _bvh(set(classes))[0]
    a = _axis_xy()
    o = Vector((a.x, a.y, z))
    d = _dir(direction)
    loc, n, _, _ = bvh.ray_cast(o, d, 5.0)
    if loc is None:
        return d
    return n if n.dot(d) >= 0 else -n


def front_point(x, z, offset=0.0, target=None):
    """Point on the FRONT of the body (or of object `target`) seen at front-view coords (x, z), pushed
    `offset` along the normal. Ideal for placing chest emblems, buttons, necklace paths."""
    bvh = _target_bvh(target)
    loc, n, _, _ = bvh.ray_cast(Vector((x, -5.0, z)), Vector((0, 1, 0)), 10.0)
    if loc is None:
        loc, n, _, _ = bvh.find_nearest(Vector((x, -1.0, z)))
    if n.y > 0:
        n = -n
    return loc + n * offset


def _target_bvh(target):
    if target is None:
        return _bvh()[0]
    if isinstance(target, str):
        return _bvh(_classes(target))[0]
    dg = bpy.context.evaluated_depsgraph_get()
    ev = target.evaluated_get(dg)
    me = ev.to_mesh()
    mw = target.matrix_world
    verts = [mw @ v.co for v in me.vertices]
    polys = [tuple(p.vertices) for p in me.polygons]
    ev.to_mesh_clear()
    return BVHTree.FromPolygons(verts, polys)


def _eye_spheres():
    pr = _S.get('profile') or {}
    e = pr.get('eyes') or {}
    out = []
    size = float(e.get('size', 0) or 0)
    for k in ('left', 'right'):
        mk = e.get(k)
        if not mk or not size:
            continue
        p = mk['position']
        n = mk.get('normal', [0, 0, 1])
        P = Vector((p[0], -p[2], p[1]))
        N = Vector((n[0], -n[2], n[1])).normalized()
        prot = float(e.get('protrusion', 0.5))
        out.append((P + N * size * (2 * prot - 1), size * 1.12))
    return out


def head_height(x, y, eyes=True):
    """Top surface height of the body at (x, y) (ray cast straight down), including the procedural
    eye bulbs from the profile when eyes=True. None if the ray misses."""
    bvh = _bvh()[0]
    top = _S['data']['P'][:, 2].max() + 1.0
    loc = bvh.ray_cast(Vector((x, y, top)), Vector((0, 0, -1)), 10.0)[0]
    z = loc.z if loc is not None else None
    if eyes:
        for c, r in _eye_spheres():
            dx, dy = x - c.x, y - c.y
            if dx * dx + dy * dy < r * r:
                ez = c.z + math.sqrt(r * r - dx * dx - dy * dy)
                z = ez if z is None else max(z, ez)
    return z


def measure(force=False):
    """Landmarks of the base in Blender world space (Vectors; floats for sizes). Keys:
    floor, top, height, axis (Vector2 x,y of the body centre line),
    head_top, head_center, head_radius (~half head width), hat_radius (recommended crown radius; on
    mascot heads - head_radius > 15% of body height, flag `mascot` - it is 0.75 x `hat_ring`, the ring
    where the head top has dropped 12% of the head height; else 1.1 x head_radius), head_height,
    neck, chest, belly (front-surface point at belly height), belly_z, hips, waist_z, torso_bottom,
    shoulder_L/R, elbow_L/R, wrist_L/R, hand_L/R (hand centre), knee_L/R, ankle_L/R, foot_L/R
    (foot centre on the floor), plus tuples shoulders/hands/feet = (L, R),
    eye_L/eye_R/eye_radius/mouth (only if the profile has markers), face_box (x0, x1, z0, z1),
    bones (role -> bone name). Use radius_at(z, direction) for the body radius at any height."""
    if _S.get('m') and not force:
        return _S['m']
    d = _S['data']
    P, C = d['P'], np.array(d['C'])
    m = {}
    m['floor'] = float(P[:, 2].min())
    m['top'] = float(P[:, 2].max())
    m['height'] = m['top'] - m['floor']
    hips = _bone_head('hips')
    sp = _bone_head('spine') or hips
    m['axis'] = Vector(((hips.x + sp.x) / 2, (hips.y + sp.y) / 2))
    _S['m'] = m
    m['hips'] = hips
    m['spine'] = sp
    m['chest'] = _bone_head('chest') or sp
    m['neck'] = _bone_head('neck') or _bone_head('head')
    headb = _bone_head('head')
    hv = P[C == 'head'] if (C == 'head').any() else P[P[:, 2] > headb.z]
    m['head_top'] = Vector((float(hv[:, 0].mean()), float(hv[:, 1].mean()), float(hv[:, 2].max())))
    lo, hi = hv.min(0), hv.max(0)
    m['head_center'] = Vector(tuple((lo + hi) / 2))
    m['head_radius'] = float(0.25 * ((hi[0] - lo[0]) + (hi[1] - lo[1])))
    m['head_height'] = float(hi[2] - min(lo[2], m['neck'].z))
    tv = P[C == 'torso']
    m['torso_bottom'] = float(tv[:, 2].min()) if len(tv) else m['floor']
    m['waist_z'] = float(hips.z)
    # belly: widest-front point between hips and chest
    zs = np.linspace(hips.z, m['chest'].z, 9)
    fr = [(radius_at(float(z), 0), float(z)) for z in zs]
    bz = max(fr)[1]
    m['belly_z'] = bz
    m['belly'] = surface_point(bz, 0)
    for side, S in (('left', 'L'), ('right', 'R')):
        m['shoulder_' + S] = _bone_head(side + 'UpperArm')
        m['elbow_' + S] = _bone_head(side + 'LowerArm')
        m['wrist_' + S] = _bone_head(side + 'Hand')
        hc = P[C == 'arm_' + S]
        hand_b = bone(side + 'Hand')
        if hand_b:
            ws = np.array([d['W'][i].get(hand_b, 0) for i in range(len(P))])
            sel = P[ws > 0.5]
            m['hand_' + S] = Vector(tuple(sel.mean(0))) if len(sel) else _bone_head(side + 'Hand', tail=True)
        else:
            m['hand_' + S] = Vector(tuple(hc.mean(0))) if len(hc) else None
        m['knee_' + S] = _bone_head(side + 'LowerLeg')
        m['ankle_' + S] = _bone_head(side + 'Foot')
        lv = P[C == 'leg_' + S]
        if len(lv):
            low = lv[lv[:, 2] < m['floor'] + 0.25 * (m['ankle_' + S].z - m['floor']) + 0.02]
            fc = low.mean(0) if len(low) else lv.mean(0)
            m['foot_' + S] = Vector((float(fc[0]), float(fc[1]), m['floor']))
        else:
            m['foot_' + S] = m['ankle_' + S]
    m['shoulders'] = (m['shoulder_L'], m['shoulder_R'])
    m['hands'] = (m['hand_L'], m['hand_R'])
    m['feet'] = (m['foot_L'], m['foot_R'])
    # recommended crown radius
    drop = 0.12 * m['head_height']
    ht = m['head_top']
    rs = []
    for k in range(16):
        a = 2 * math.pi * k / 16
        r = 0.0
        while r < 1.5 * m['head_radius']:
            r += 0.005
            h = head_height(ht.x + r * math.sin(a), ht.y - r * math.cos(a), eyes=False)
            if h is None or h < ht.z - drop:
                break
        rs.append(r)
    m['hat_ring'] = float(np.median(rs))
    m['mascot'] = m['head_radius'] > 0.15 * m['height']
    # recommended crown radius: mascot heads (head = upper body, e.g. the frog) wear small perched hats
    m['hat_radius'] = 0.75 * m['hat_ring'] if m['mascot'] else 1.1 * m['head_radius']
    eyes = _eye_spheres()
    pr = _S.get('profile') or {}
    if len(eyes) == 2:
        m['eye_L'] = max(eyes, key=lambda e: e[0].x)[0]
        m['eye_R'] = min(eyes, key=lambda e: e[0].x)[0]
        m['eye_radius'] = eyes[0][1] / 1.12
    mo = (pr.get('mouth') or {}).get('center')
    if mo:
        p = mo['position']
        m['mouth'] = Vector((p[0], -p[2], p[1]))
    m['face_box'] = face_box()
    m['bones'] = dict(_S['roles'])
    return m


def face_box():
    """Front-view rect (x0, x1, z0, z1) that must stay clear (eyes + mouth + face). From profile
    markers when available, else estimated from the head bone."""
    m = _S['m']
    pr = _S.get('profile') or {}
    eyes = _eye_spheres()
    mo = (pr.get('mouth') or {}).get('center')
    if len(eyes) == 2 and mo:
        r = eyes[0][1]
        xs = [e[0].x for e in eyes]
        mz = mo['position'][1]
        mw = float((pr.get('mouth') or {}).get('width', r))
        top = max(e[0].z for e in eyes) + r * 1.05
        bot = mz - max(mw, (pr.get('mouth') or {}).get('openHeight', r)) * 1.1
        return (min(xs) - r * 1.1, max(xs) + r * 1.1, bot, top)
    hc, hr = m['head_center'], m['head_radius']
    return (hc.x - hr * 0.8, hc.x + hr * 0.8, hc.z - hr * 0.9, hc.z + hr * 0.6)


def describe():
    """Readable landmark summary (print it; handy for LLM-written scripts)."""
    m = measure()
    lines = ['base landmarks (Blender: +Z up, front -Y, char-left +X):']
    for k in ('floor', 'top', 'height', 'head_radius', 'hat_radius', 'head_height', 'belly_z', 'waist_z',
              'torso_bottom'):
        lines.append('  %-13s %.3f' % (k, m[k]))
    for k in ('head_top', 'head_center', 'neck', 'chest', 'belly', 'hips', 'shoulder_L', 'shoulder_R',
              'elbow_L', 'wrist_L', 'hand_L', 'hand_R', 'knee_L', 'ankle_L', 'foot_L', 'foot_R', 'eye_L', 'mouth'):
        if m.get(k) is not None:
            v = m[k]
            lines.append('  %-13s (%.3f, %.3f, %.3f)' % (k, v.x, v.y, v.z))
    lines.append('  face_box      x %.3f..%.3f  z %.3f..%.3f  (keep clear)' % m['face_box'])
    for z in np.linspace(m['torso_bottom'] + 0.02, m['head_top'].z - 0.02, 7):
        lines.append('  radius z=%.2f  front %.3f  side %.3f  back %.3f' % (
            z, radius_at(z, 0), radius_at(z, 90), radius_at(z, 180)))
    lines.append('  bones: ' + ', '.join(sorted(_S['arm'].data.bones.keys())))
    return '\n'.join(lines)


# ============================================================================ UVs
def _uv_layer(ob):
    me = ob.data
    return (me.uv_layers[0] if me.uv_layers else me.uv_layers.new(name='UVMap')).data


def _uv_by_poly(ob, fn):
    me = ob.data
    uvd = _uv_layer(ob)
    Vv = me.vertices
    mw = ob.matrix_world
    for p in me.polygons:
        cos = [mw @ Vv[i].co for i in p.vertices]
        uvs = fn(mw @ p.center, p.normal, cos)
        for li, uv in zip(p.loop_indices, uvs):
            uvd[li].uv = uv


def _wrap(us, period):
    if max(us) - min(us) > period * 0.5:
        return [u + period if u < period * 0.5 else u for u in us]
    return us


def uv_cylinder(ob, tile=0.35, center=None, tiles_u=None):
    """Cylindrical UVs around a vertical axis (default: body axis). tile = metres per texture repeat
    vertically; around the circumference an integer number of repeats (seamless for tileable
    textures). u runs from the front towards the character's left."""
    c = center or _axis_xy()
    if tiles_u is None:
        rr = [math.hypot(v.co.x - c.x, v.co.y - c.y) for v in ob.data.vertices] or [0.3]
        tiles_u = max(1, round(2 * math.pi * float(np.median(rr)) / tile))

    def fn(cen, n, cos):
        us = [(math.atan2(v.x - c.x, -(v.y - c.y)) / (2 * math.pi)) % 1.0 * tiles_u for v in cos]
        return list(zip(_wrap(us, tiles_u), [v.z / tile for v in cos]))
    _uv_by_poly(ob, fn)
    return ob


def _plane_axes(direction):
    """-> (out, right, up): `out` points from the character towards the viewer standing on that side,
    `right` is the viewer's screen-right (front view: +X = character left), `up` = +Z."""
    out = _dir(direction)
    up = Vector((0, 0, 1))
    right = up.cross(out).normalized()
    return out, right, up


def uv_planar(ob, direction='front', tile=0.35):
    """Planar projection seen from `direction` (the side the viewer stands on). tile = metres/repeat."""
    out, right, up = _plane_axes(direction)
    _uv_by_poly(ob, lambda c, n, cos: [(v.dot(right) / tile, v.dot(up) / tile) for v in cos])
    return ob


def uv_rect(ob, rect, direction='front'):
    """Planar UVs normalised so the front-view rect (a0, a1, z0, z1) maps exactly to 0..1."""
    a0, a1, z0, z1 = rect
    out, right, up = _plane_axes(direction)
    _uv_by_poly(ob, lambda c, n, cos: [((v.dot(right) - a0) / (a1 - a0), (v.dot(up) - z0) / (z1 - z0)) for v in cos])
    return ob


def uv_box(ob, tile=None):
    """Box projection. tile=None -> every face gets the full 0..1 square (cardboard / crate look:
    the texture's border becomes the box edge); tile=metres -> world-scaled repeat."""
    me = ob.data
    lo = Vector([min(v.co[i] for v in me.vertices) for i in range(3)])
    hi = Vector([max(v.co[i] for v in me.vertices) for i in range(3)])
    size = hi - lo

    def fn(c, n, cos):
        ax = max(range(3), key=lambda i: abs(n[i]))
        a, b = [(1, 2), (0, 2), (0, 1)][ax]
        if tile:
            return [(v[a] / tile, v[b] / tile) for v in cos]
        return [((v[a] - lo[a]) / max(size[a], 1e-6), (v[b] - lo[b]) / max(size[b], 1e-6)) for v in cos]
    _uv_by_poly(ob, fn)
    return ob


def _uv_flat(ob):
    _uv_by_poly(ob, lambda c, n, cos: [(0.5, 0.5)] * len(cos))


# ============================================================================ materials / images
def image(name, arr):
    """numpy HxWx3 (or 4) sRGB 0..1 array, row 0 = TOP (like a PNG) -> packed bpy image."""
    arr = np.asarray(arr, dtype=np.float32)
    h, w = arr.shape[:2]
    if arr.shape[2] == 3:
        arr = np.concatenate([arr, np.ones((h, w, 1), np.float32)], 2)
    img = bpy.data.images.new(name, w, h, alpha=arr.shape[2] == 4)
    img.colorspace_settings.name = 'sRGB'
    img.pixels.foreach_set(np.clip(arr[::-1], 0, 1).ravel())
    img.file_format = 'PNG'
    img.pack()
    return img


def material(name, color='#cccccc', image=None, roughness=0.75, metallic=0.0, double_sided=True,
             extension='REPEAT'):
    """Principled material (glTF-exportable: base colour + optional image texture). Re-uses an
    existing material of the same name. `image` = bpy image or a numpy array."""
    if name in bpy.data.materials:
        return bpy.data.materials[name]
    if image is not None and not isinstance(image, bpy.types.Image):
        image = globals()['image'](name + '_tex', image)
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    bsdf = nt.nodes.get('Principled BSDF') or nt.nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.inputs['Base Color'].default_value = hex2lin(color) + (1.0,)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    if 'Specular IOR Level' in bsdf.inputs:
        bsdf.inputs['Specular IOR Level'].default_value = 0.3
    if image is not None:
        tex = nt.nodes.new('ShaderNodeTexImage')
        tex.image = image
        tex.extension = extension
        nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    m.use_backface_culling = not double_sided
    m.diffuse_color = hex2lin(color) + (1.0,)
    _S['kit_mats'][name] = m
    return m


def _mat(mat, default='#cccccc'):
    if mat is None:
        return material('KitDefault', default)
    if isinstance(mat, str):
        return bpy.data.materials[mat] if mat in bpy.data.materials else material(mat, mat if mat.startswith('#') else default)
    return mat


def set_material(ob, mat):
    ob.data.materials.clear()
    ob.data.materials.append(_mat(mat))
    return ob


def label_material(name, text='', color='#111111', background='#ffffff', font=None, aspect=4.0,
                   res=512, bold=True):
    """Material for runtime-editable text. The default text is baked into its image so it also
    looks right in previews / other viewers; the runtime replaces the map with live text."""
    if name in bpy.data.materials:
        return bpy.data.materials[name]
    h = res
    w = int(round(res * max(0.25, aspect)))
    if w > 2048:
        w, h = 2048, int(2048 / aspect)
    arr = tex_text(text, w, h, color=color, background=background, font=font, as_array=True, bold=bold) \
        if text else np.ones((h, w, 3)) * np.array(hex2srgb(background))
    m = material(name, background, image(name + '_tex', arr), roughness=0.8, extension='EXTEND')
    return m


# ============================================================================ textures (numpy)
def _grid(h, w):
    v, u = np.meshgrid((np.arange(h) + 0.5) / h, (np.arange(w) + 0.5) / w, indexing='ij')
    return u, 1.0 - v   # u right, v up (row 0 = top)


def _fnoise(h, w, sigma_px, seed, aniso=(1.0, 1.0)):
    """tileable smooth noise 0..1 (gaussian-filtered white noise via FFT)"""
    rng = np.random.default_rng(seed)
    n = rng.standard_normal((h, w))
    fy = np.fft.fftfreq(h)[:, None] * aniso[1]
    fx = np.fft.fftfreq(w)[None, :] * aniso[0]
    G = np.exp(-2 * (math.pi ** 2) * (sigma_px ** 2) * (fx ** 2 + fy ** 2))
    out = np.real(np.fft.ifft2(np.fft.fft2(n) * G))
    lo, hi = np.percentile(out, 1), np.percentile(out, 99)
    return np.clip((out - lo) / (hi - lo + 1e-9), 0, 1)


def _col(h):
    return np.array(hex2srgb(h))


def _out(name, arr, as_array):
    return arr if as_array else image(name, arr)


def tex_stripes(colors=('#ffffff', '#b22234'), size=512, count=None, widths=None, vertical=False,
                as_array=False, name='stripes'):
    """Tileable bands cycling through `colors` (horizontal = bands stacked along V). count = number of
    bands per tile (default len(colors) * 2), widths = relative widths per colour."""
    n = count or len(colors) * 2
    widths = widths or [1.0] * len(colors)
    seq = [i % len(colors) for i in range(n)]
    ws = np.array([widths[i] for i in seq], float)
    edges = np.concatenate([[0], np.cumsum(ws) / ws.sum()])
    u, v = _grid(size, size)
    t = u if vertical else v
    idx = np.clip(np.searchsorted(edges, t, side='right') - 1, 0, n - 1)
    pal = np.array([_col(colors[i]) for i in seq])
    return _out(name, pal[idx], as_array)


def tex_camo(palette=('#8c7b52', '#5b6b35', '#5a4128', '#1d1d18'), seed=1, size=1024, scale=1.0,
             as_array=False, name='camo'):
    """Woodland-style blob camouflage. palette[0] = base, later colours = layered blobs (smaller +
    rarer). Tileable. scale > 1 = bigger blobs."""
    img = np.zeros((size, size, 3)) + _col(palette[0])
    for i, c in enumerate(palette[1:]):
        nz = _fnoise(size, size, size * 0.035 * scale * (1.0 - 0.18 * i), seed * 31 + i * 7, aniso=(1.0, 1.6))
        thr = 0.52 + 0.06 * i
        a = np.clip((nz - thr) / 0.012, 0, 1)
        img = img * (1 - a[..., None]) + _col(c) * a[..., None]
    return _out(name, img, as_array)


def tex_zebra(bg='#f3f2ec', fg='#1d1d2b', stripes=5, seed=2, size=1024, wobble=0.25, thickness=0.42,
              slant=1, taper=0.3, fur=0.08, as_array=False, name='zebra'):
    """Zebra / tiger fur: bold, slightly slanted, tapering dark bands running along U (around a
    cylinder), tileable. stripes = bands per tile, wobble = waviness, thickness = dark fraction,
    slant = integer diagonal steps per tile (0 = horizontal), taper = how much bands thin out / break,
    fur = streak shading."""
    u, v = _grid(size, size)
    n1 = _fnoise(size, size, size * 0.12, seed)
    n2 = _fnoise(size, size, size * 0.07, seed + 1)
    ph = v * stripes + slant * u + wobble * (n1 - 0.5) * 2.0 + 0.12 * np.sin(2 * math.pi * (u * 3 + n2 * 0.4))
    s = 0.5 + 0.5 * np.cos(2 * math.pi * ph)
    thr = 1.0 - thickness + (n2 - 0.5) * 2 * taper
    aa = 3.0 * stripes / size * 4
    a = np.clip((s - thr) / aa + 0.5, 0, 1)
    img = _col(bg) * (1 - a[..., None]) + _col(fg) * a[..., None]
    if fur:
        st = _fnoise(size, size, 2.0, seed + 5, aniso=(0.12, 1.0))
        img = img * (1 - fur + 2 * fur * st[..., None])
    return _out(name, np.clip(img, 0, 1), as_array)


def _star_mask(X, Y, R, inner=0.382):
    """X, Y: coords relative to star centre (y up). 5-point star, tip up. Even-odd polygon test."""
    pts = []
    for k in range(10):
        a = math.pi / 2 + k * math.pi / 5
        r = R if k % 2 == 0 else R * inner
        pts.append((r * math.cos(a), r * math.sin(a)))
    inside = np.zeros(X.shape, bool)
    for i in range(10):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % 10]
        cond = ((y1 > Y) != (y2 > Y)) & (X < (x2 - x1) * (Y - y1) / (y2 - y1 + 1e-12) + x1)
        inside ^= cond
    return inside


def tex_flag_stars(field='#26336b', star='#ffffff', rows=5, cols=6, size=1024, star_size=0.32,
                   as_array=False, name='stars'):
    """Tileable star field (US-flag canton look): staggered 5-point stars. star_size = radius as a
    fraction of the cell."""
    ss = 2
    H = size * ss
    u, v = _grid(H, H)
    cw, ch = 1.0 / cols, 1.0 / rows
    R = star_size * min(cw, ch)
    acc = np.zeros((H, H), bool)
    for off in (0.5, 0.0):     # two staggered lattices
        X = (((u / cw) + off) % 1.0 - 0.5) * cw
        Y = (((v / ch) + off) % 1.0 - 0.5) * ch
        acc |= _star_mask(X, Y, R)
    acc = acc.astype(float).reshape(size, ss, size, ss).mean((1, 3))
    img = _col(field) * (1 - acc[..., None]) + _col(star) * acc[..., None]
    return _out(name, img, as_array)


def tex_flag_stripes(red='#b22234', white='#f5f5f5', count=6, size=512, as_array=False, name='flagstripes'):
    """Horizontal red/white stripes (count = pairs per tile), tileable."""
    return tex_stripes((red, white), size=size, count=count * 2, as_array=as_array, name=name)


def tex_cardboard(base='#b98a5a', edge='#7a5634', tape='#d9c08f', labels=True, tape_strips=True,
                  marks=True, seed=4, size=1024, border=0.035, as_array=False, name='cardboard'):
    """Kraft cardboard panel for box_part(uv='face'): mottled kraft, faint corrugation, darker border
    (becomes the box edge), packing-tape strips, optional shipping label with lines + barcode,
    'this way up' arrows and scribbled X marks. Vary `seed` per box for variety."""
    rng = np.random.default_rng(seed)
    u, v = _grid(size, size)
    img = np.zeros((size, size, 3)) + _col(base)
    n = _fnoise(size, size, size * 0.02, seed)
    img *= (0.93 + 0.12 * n)[..., None]
    img *= (0.985 + 0.015 * np.sin(2 * math.pi * v * 90))[..., None]
    b = np.minimum.reduce([u, 1 - u, v, 1 - v])
    a = np.clip((border - b) / (border * 0.5), 0, 1)
    img = img * (1 - a[..., None]) + _col(edge) * a[..., None]

    def rect(x0, x1, y0, y1, col, alpha=1.0):
        nonlocal img
        m = ((u > x0) & (u < x1) & (v > y0) & (v < y1)).astype(float) * alpha
        img = img * (1 - m[..., None]) + _col(col) * m[..., None]
    if tape_strips:
        if rng.random() < 0.6:
            c = rng.uniform(0.35, 0.65)
            rect(c - 0.07, c + 0.07, -1, 2, tape, 0.85)
        else:
            c = rng.uniform(0.3, 0.7)
            rect(-1, 2, c - 0.06, c + 0.06, tape, 0.85)
        for _ in range(rng.integers(1, 3)):
            cx, cy = rng.uniform(0.1, 0.9, 2)
            rect(cx - 0.05, cx + 0.05, cy - 0.12, cy + 0.12, tape, 0.8)
    if labels and rng.random() < 0.85:
        x0, y0 = rng.uniform(0.12, 0.45), rng.uniform(0.12, 0.5)
        w, h = rng.uniform(0.26, 0.36), rng.uniform(0.16, 0.24)
        rect(x0 - 0.008, x0 + w + 0.008, y0 - 0.008, y0 + h + 0.008, '#3a3a3a')
        rect(x0, x0 + w, y0, y0 + h, '#f4f2ec')
        for k in range(3):
            yy = y0 + h * (0.72 - 0.22 * k)
            rect(x0 + w * 0.08, x0 + w * (0.9 - 0.2 * rng.random()), yy - 0.006, yy + 0.006, '#454545')
        if rng.random() < 0.6:
            bx = x0 + w + 0.06
            for k in range(14):
                if rng.random() < 0.7:
                    xx = bx + k * 0.009
                    rect(xx, xx + 0.004 + 0.004 * rng.random(), y0, y0 + h * 0.7, '#222222')
    if marks:
        if rng.random() < 0.5:   # this-way-up arrows
            ax, ay = rng.uniform(0.6, 0.8), rng.uniform(0.6, 0.8)
            for dx in (0, 0.05):
                rect(ax + dx - 0.006, ax + dx + 0.006, ay, ay + 0.08, '#2a2a2a')
                tri = (np.abs(u - ax - dx) < (ay + 0.11 - v) * 0.6) & (v > ay + 0.07) & (v < ay + 0.11)
                img[tri] = _col('#2a2a2a')
        if rng.random() < 0.6:   # scribbled X
            cx, cy = rng.uniform(0.25, 0.75, 2)
            for sgn in (1, -1):
                d = np.abs((u - cx) * sgn - (v - cy)) / math.sqrt(2)
                m = (d < 0.006) & (np.abs(u - cx) < 0.07) & (np.abs(v - cy) < 0.07)
                img[m] = _col('#3b2a1c')
    return _out(name, np.clip(img, 0, 1), as_array)


def tex_sparkle_gold(base='#d9a520', seed=5, size=512, cells=24, as_array=False, name='sequins'):
    """Gold sequins: hex lattice of discs with random brightness + a few star glints. Tileable."""
    rng = np.random.default_rng(seed)
    u, v = _grid(size, size)
    img = np.zeros((size, size, 3)) + _col(base) * 0.55
    rows = cells
    for off in (0.0, 0.5):
        cu = u * cells + off
        cv = v * rows + off
        iu, iv = np.floor(cu).astype(int) % cells, np.floor(cv).astype(int) % rows
        fu, fv = cu % 1.0 - 0.5, cv % 1.0 - 0.5
        rnd = rng.uniform(0.55, 1.35, (rows, cells))
        hl = rng.uniform(0, 1, (rows, cells))
        d = np.sqrt(fu ** 2 + fv ** 2)
        disc = np.clip((0.40 - d) / 0.05, 0, 1)
        shade = rnd[iv, iu][..., None] * _col(base) * (1.0 + 0.35 * (hl[iv, iu][..., None] > 0.85))
        spec = np.clip(1 - np.hypot(fu + 0.12, fv - 0.12) / 0.12, 0, 1)[..., None] * 0.5
        img = img * (1 - disc[..., None]) + np.clip(shade + spec, 0, 1) * disc[..., None]
    for _ in range(int(size * size / 9000)):
        cx, cy = rng.uniform(0, 1, 2)
        L = rng.uniform(0.01, 0.03)
        g = np.exp(-((u - cx) / 0.0025) ** 2) * (np.abs(v - cy) < L) + np.exp(-((v - cy) / 0.0025) ** 2) * (np.abs(u - cx) < L)
        img = np.maximum(img, np.clip(g, 0, 1)[..., None] * np.array([1, 0.97, 0.85]))
    return _out(name, np.clip(img, 0, 1), as_array)


def tex_fur_noise(base='#f2f2f2', seed=6, size=512, strength=0.18, streak=6.0, tint=None,
                  as_array=False, name='fur'):
    """Soft fur: base colour with streaky anisotropic brightness noise (streaks run along V)."""
    st = _fnoise(size, size, streak, seed, aniso=(1.0, 0.1))
    lo = _fnoise(size, size, size * 0.06, seed + 1)
    img = _col(base)[None, None, :] * (1 - strength + strength * (1.2 * st + 0.8 * lo)[..., None])
    if tint:
        img = img * (1 - 0.25 * lo[..., None]) + _col(tint) * 0.25 * lo[..., None]
    return _out(name, np.clip(img, 0, 1), as_array)


_FONT_CANDIDATES = {
    'bold': ['C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/segoeuib.ttf',
             '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/Library/Fonts/Arial Bold.ttf'],
    'impact': ['C:/Windows/Fonts/impact.ttf'],
    'marker': ['C:/Windows/Fonts/segoepr.ttf', 'C:/Windows/Fonts/comicbd.ttf'],
    'stencil': ['C:/Windows/Fonts/STENCIL.TTF', 'C:/Windows/Fonts/impact.ttf'],
    'regular': ['C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'],
}


def _font(font, bold):
    path = None
    if font and os.path.isfile(font):
        path = font
    else:
        for p in _FONT_CANDIDATES.get(font or ('bold' if bold else 'regular'), []) + _FONT_CANDIDATES['bold']:
            if os.path.isfile(p):
                path = p
                break
    if path:
        try:
            return bpy.data.fonts.load(path, check_existing=True)
        except Exception:
            pass
    return None   # Blender's built-in font


def tex_text(text, width=1024, height=256, color='#111111', background='#ffffff', font=None, bold=True,
             padding=0.08, as_array=False, name='text', supersample=3):
    """Rasterise text (multi-line with '\\n') centred into a width x height image (real glyph outlines
    via Blender's font engine). font = .ttf path or 'bold' | 'impact' | 'marker' | 'stencil' |
    'regular'. Use for static prints; runtime-editable text should use label_face/label_panel."""
    cu = bpy.data.curves.new('_txt', 'FONT')
    cu.body = text
    cu.align_x, cu.align_y = 'CENTER', 'CENTER'
    f = _font(font, bold)
    if f:
        cu.font = f
    ob = bpy.data.objects.new('_txt', cu)
    _link(ob)
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bpy.data.objects.remove(ob, do_unlink=True)
    bpy.data.curves.remove(cu)
    me.calc_loop_triangles()
    Vt = np.array([v.co[:2] for v in me.vertices]) if len(me.vertices) else np.zeros((0, 2))
    T = [tuple(t.vertices) for t in me.loop_triangles]
    bpy.data.meshes.remove(me)
    W, H = width * supersample, height * supersample
    cov = np.zeros((H, W))
    if len(T):
        lo, hi = Vt.min(0), Vt.max(0)
        sz = hi - lo
        s = min(W * (1 - 2 * padding) / max(sz[0], 1e-6), H * (1 - 2 * padding) / max(sz[1], 1e-6))
        Pp = (Vt - (lo + hi) / 2) * s
        Pp[:, 0] += W / 2
        Pp[:, 1] = H / 2 - Pp[:, 1]
        for a, b, c in T:
            A, B, Cc = Pp[a], Pp[b], Pp[c]
            x0, x1 = int(max(0, math.floor(min(A[0], B[0], Cc[0])))), int(min(W - 1, math.ceil(max(A[0], B[0], Cc[0]))))
            y0, y1 = int(max(0, math.floor(min(A[1], B[1], Cc[1])))), int(min(H - 1, math.ceil(max(A[1], B[1], Cc[1]))))
            if x1 < x0 or y1 < y0:
                continue
            ys, xs = np.mgrid[y0:y1 + 1, x0:x1 + 1] + 0.5
            d = (B[1] - Cc[1]) * (A[0] - Cc[0]) + (Cc[0] - B[0]) * (A[1] - Cc[1])
            if abs(d) < 1e-12:
                continue
            l1 = ((B[1] - Cc[1]) * (xs - Cc[0]) + (Cc[0] - B[0]) * (ys - Cc[1])) / d
            l2 = ((Cc[1] - A[1]) * (xs - Cc[0]) + (A[0] - Cc[0]) * (ys - Cc[1])) / d
            ins = (l1 >= 0) & (l2 >= 0) & (l1 + l2 <= 1)
            cov[y0:y1 + 1, x0:x1 + 1] = np.maximum(cov[y0:y1 + 1, x0:x1 + 1], ins)
    cov = cov.reshape(height, supersample, width, supersample).mean((1, 3))
    img = _col(background) * (1 - cov[..., None]) + _col(color) * cov[..., None]
    return _out(name, img, as_array)


# ============================================================================ geometry primitives
def _revolve(prof, segs, mapper, closed=False):
    """prof: [(t, rx, ry)]; rx==0 -> pole. mapper(t, rx, ry, ang)->xyz. closed: profile loop."""
    verts, rings = [], []
    for (t, rx, ry) in prof:
        if rx < 1e-7:
            rings.append([len(verts)])
            verts.append(mapper(t, 0, 0, 0))
        else:
            ring = []
            for i in range(segs):
                a = 2 * math.pi * i / segs
                ring.append(len(verts))
                verts.append(mapper(t, rx, ry, a))
            rings.append(ring)
    pairs = list(zip(rings, rings[1:])) + ([(rings[-1], rings[0])] if closed else [])
    faces = []
    for A, B in pairs:
        if len(A) == 1 and len(B) == 1:
            continue
        if len(A) == 1:
            faces += [(A[0], B[i], B[(i + 1) % segs]) for i in range(segs)]
        elif len(B) == 1:
            faces += [(A[i], B[0], A[(i + 1) % segs]) for i in range(segs)]
        else:
            faces += [(A[i], B[i], B[(i + 1) % segs], A[(i + 1) % segs]) for i in range(segs)]
    return verts, faces


def _frames(pts):
    """parallel-transport frames along a polyline -> list of (T, N, B)"""
    pts = [Vector(p) for p in pts]
    Ts = []
    for i in range(len(pts)):
        a = pts[max(i - 1, 0)]
        b = pts[min(i + 1, len(pts) - 1)]
        Ts.append((b - a).normalized())
    ref = Vector((0, -1, 0)) if abs(Ts[0].y) < 0.9 else Vector((1, 0, 0))
    N = (ref - Ts[0] * ref.dot(Ts[0])).normalized()
    out = []
    for i, Tt in enumerate(Ts):
        if i > 0:
            N = N - Tt * N.dot(Tt)
            if N.length < 1e-8:
                N = Tt.orthogonal()
            N.normalize()
        out.append((Tt, N, Tt.cross(N)))
    return out


def _resample(pts, n):
    pts = [Vector(p) for p in pts]
    L = [0.0]
    for a, b in zip(pts, pts[1:]):
        L.append(L[-1] + (b - a).length)
    out = []
    for k in range(n):
        s = L[-1] * k / (n - 1)
        i = max(0, min(len(pts) - 2, int(np.searchsorted(L, s, side='right') - 1)))
        seg = L[i + 1] - L[i]
        t = (s - L[i]) / seg if seg > 1e-9 else 0
        out.append(pts[i].lerp(pts[i + 1], t))
    return out


def _smooth_path(pts, n=None, iters=0):
    """Catmull-Rom through pts, resampled to n points."""
    pts = [Vector(p) for p in pts]
    if len(pts) < 3:
        return _resample(pts, n or 16)
    dense = []
    P = [pts[0] * 2 - pts[1]] + pts + [pts[-1] * 2 - pts[-2]]
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        for k in range(12):
            t = k / 12
            dense.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
                                (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    dense.append(pts[-1])
    return _resample(dense, n or max(8, len(pts) * 8))


def tube(points, radius=0.01, segs=12, n=None, caps=True, smooth=True, fluff=0.0, seed=0, material=None,
         name='Tube', uv_tile=0.3, skin='follow', squash=1.0):
    """Tube along a polyline (Catmull-Rom smoothed when smooth=True). radius: float, list (per point),
    or callable(t 0..1) -> r. fluff: random bumps (fur rolls, pipe cleaners). squash scales the
    cross-section along the frame's binormal (flattened straps / lapel rolls)."""
    pts = _smooth_path(points, n) if smooth else _resample(points, n or max(2, len(points)))
    fr = _frames(pts)
    rng = np.random.default_rng(seed)
    ph = rng.uniform(0, 2 * math.pi, 6)
    Vv, Ff = [], []
    N = len(pts)
    for i, (p, (Tt, Nn, Bb)) in enumerate(zip(pts, fr)):
        t = i / max(N - 1, 1)
        r = radius(t) if callable(radius) else (float(np.interp(t, np.linspace(0, 1, len(radius)), radius))
                                                 if isinstance(radius, (list, tuple)) else radius)
        for k in range(segs):
            a = 2 * math.pi * k / segs
            rr = r
            if fluff:
                rr *= 1 + fluff * (0.5 * math.sin(3 * a + ph[0] + 9 * t * 6.28) +
                                   0.35 * math.sin(7 * a + ph[1] - 23 * t) + 0.3 * math.sin(11 * a + ph[2] + 41 * t))
            Vv.append(p + Nn * (rr * math.cos(a)) + Bb * (rr * squash * math.sin(a)))
    for i in range(N - 1):
        for k in range(segs):
            a, b = i * segs + k, i * segs + (k + 1) % segs
            Ff.append((a, b, b + segs, a + segs))
    if caps:
        for end, sgn in ((0, -1), (N - 1, 1)):
            c = len(Vv)
            Vv.append(pts[end] + fr[end][0] * sgn * 0.0)
            for k in range(segs):
                a, b = end * segs + k, end * segs + (k + 1) % segs
                Ff.append((a, b, c) if sgn < 0 else (b, a, c))
    ob = _obj_from_data(name, Vv, Ff, material, skin=skin)
    # u around, v along
    L = [0.0]
    for a, b in zip(pts, pts[1:]):
        L.append(L[-1] + (b - a).length)
    uvd = _uv_layer(ob)
    me = ob.data
    for poly in me.polygons:
        us, vs = [], []
        for vi in poly.vertices:
            if vi >= N * segs:
                us.append(0.5)
                vs.append(0.0)
            else:
                us.append((vi % segs) / segs)
                vs.append(L[vi // segs] / uv_tile)
        if max(us) - min(us) > 0.5:
            us = [u + 1 if u < 0.5 else u for u in us]
        for li, u, v in zip(poly.loop_indices, us, vs):
            uvd[li].uv = (u, v)
    return ob


def sphere(center, radius=0.03, radii=None, segs=16, rings=10, material=None, name='Sphere', skin='follow'):
    """UV sphere / ellipsoid (radii=(rx, ry, rz))."""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=1.0)
    r = radii or (radius, radius, radius)
    for v in bm.verts:
        v.co = Vector((v.co.x * r[0], v.co.y * r[1], v.co.z * r[2])) + Vector(center)
    ob = _obj_from_bm(name, bm, material, skin=skin)
    _uv_flat(ob)
    return ob


def cylinder(center, axis=(0, 0, 1), radius=0.03, length=0.1, segs=20, bevel=0.0, material=None,
             name='Cylinder', skin='follow'):
    """Capped cylinder centred at `center` along `axis`."""
    ax = Vector(axis).normalized()
    c = Vector(center)
    b = bevel
    prof = [(-0.5 * length, 0, 0), (-0.5 * length, radius - b, radius - b)]
    if b:
        prof += [(-0.5 * length + b * 0.3, radius - b * 0.3, radius - b * 0.3), (-0.5 * length + b, radius, radius),
                 (0.5 * length - b, radius, radius), (0.5 * length - b * 0.3, radius - b * 0.3, radius - b * 0.3)]
    else:
        prof += [(-0.5 * length, radius, radius), (0.5 * length, radius, radius)]
    prof += [(0.5 * length, radius - b, radius - b), (0.5 * length, 0, 0)]
    e1 = ax.orthogonal().normalized()
    e2 = ax.cross(e1)
    vs, fs = _revolve(prof, segs, lambda t, rx, ry, a: tuple(c + ax * t + e1 * rx * math.cos(a) + e2 * ry * math.sin(a)))
    ob = _obj_from_data(name, vs, fs, material, skin=skin, sharp=40)
    _uv_flat(ob)
    return ob


def ring(center, axis=(0, 0, 1), radius=0.03, thickness=0.008, segs=24, tsegs=10, flat=1.0,
         material=None, name='Ring', skin='follow'):
    """Torus (finger ring, hat band, link). flat < 1 flattens the tube along the axis (band ring)."""
    ax = Vector(axis).normalized()
    e1 = ax.orthogonal().normalized()
    e2 = ax.cross(e1)
    c = Vector(center)
    Vv, Ff = [], []
    for i in range(segs):
        a = 2 * math.pi * i / segs
        d = e1 * math.cos(a) + e2 * math.sin(a)
        for j in range(tsegs):
            b = 2 * math.pi * j / tsegs
            Vv.append(c + d * (radius + thickness * math.cos(b)) + ax * (thickness * flat * math.sin(b)))
    for i in range(segs):
        for j in range(tsegs):
            a = i * tsegs + j
            b = i * tsegs + (j + 1) % tsegs
            c2 = ((i + 1) % segs) * tsegs + j
            d2 = ((i + 1) % segs) * tsegs + (j + 1) % tsegs
            Ff.append((a, c2, d2, b))
    ob = _obj_from_data(name, Vv, Ff, material, skin=skin)
    _uv_flat(ob)
    return ob


def _orient(facing, up=(0, 0, 1)):
    """rotation matrix whose local -Y points along `facing` (local +Z stays close to `up`)"""
    y = -Vector(facing).normalized()
    upv = Vector(up)
    if abs(y.dot(upv)) > 0.98:
        upv = Vector((0, 1, 0)) if abs(y.y) < 0.9 else Vector((1, 0, 0))
    x = y.cross(upv).normalized()
    z = x.cross(y).normalized()
    return Matrix((x, y, z)).transposed()


def box_part(center, size=(0.1, 0.1, 0.1), bevel=0.008, rotation=(0, 0, 0), facing=None, material=None,
             name='Box', uv='face', skin='follow', segments=2):
    """Bevelled box. size=(x width, y depth, z height). rotation = Euler degrees (XYZ), or facing=
    vector: the box's local front (-Y) turns to face it (use surface_normal() to sit on the body).
    uv='face' maps each face to 0..1 (use with tex_cardboard), uv=<metres> world tiling, None flat."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=bm.edges[:], offset=min(bevel, min(size) * 0.45), segments=segments,
                        affect='EDGES', profile=0.5)
    R = _orient(facing) if facing is not None else \
        (Matrix.Rotation(math.radians(rotation[2]), 3, 'Z') @ Matrix.Rotation(math.radians(rotation[1]), 3, 'Y') @
         Matrix.Rotation(math.radians(rotation[0]), 3, 'X'))
    M = Matrix.Translation(Vector(center)) @ R.to_4x4()
    for v in bm.verts:
        v.co = M @ v.co
    ob = _obj_from_bm(name, bm, material, skin=skin, sharp=35)
    if uv == 'face':
        # map per face in the box's local frame
        Minv = M.inverted()
        me = ob.data
        uvd = _uv_layer(ob)
        hs = [s * 0.5 for s in size]
        for p in me.polygons:
            n = R.transposed() @ p.normal
            ax = max(range(3), key=lambda i: abs(n[i]))
            a, b = [(1, 2), (0, 2), (0, 1)][ax]
            for li, vi in zip(p.loop_indices, p.vertices):
                lc = Minv @ me.vertices[vi].co
                uvd[li].uv = ((lc[a] + hs[a]) / (2 * hs[a]), (lc[b] + hs[b]) / (2 * hs[b]))
    elif isinstance(uv, (int, float)):
        uv_box(ob, float(uv))
    else:
        _uv_flat(ob)
    return ob


def pouch(center, size=(0.09, 0.05, 0.10), facing=None, material=None, flap_material=None, button_material=None,
          name='Pouch', bevel=0.012, skin='follow'):
    """Utility / ammo pouch: rounded box + overhanging lid flap + snap button. center on the surface
    (e.g. surface_point(z, az, offset=size[1]/2 + belt thickness)), facing = outward normal."""
    f = Vector(facing) if facing is not None else _dir(0)
    R = _orient(f)
    c = Vector(center)
    body = box_part(c, size, bevel, facing=f, material=material, name=name, uv=None, skin=skin)
    flap_c = c + R @ Vector((0, -size[1] * 0.08, size[2] * 0.36))
    flap = box_part(flap_c, (size[0] * 1.06, size[1] * 1.08, size[2] * 0.30), bevel * 0.8, facing=f,
                    material=flap_material or material, name=name + '_flap', uv=None, skin=skin)
    btn = sphere(c + R @ Vector((0, -size[1] * 0.6, size[2] * 0.22)), radii=(size[0] * 0.09, size[0] * 0.05, size[0] * 0.07),
                 material=button_material or flap_material or material, name=name + '_btn', skin=skin)
    return join([body, flap, btn], name)


def chain(points, link_len=0.024, link_width=0.016, wire=0.0045, material=None, name='Chain', smooth=True,
          skin='follow', twist=90.0, seg=10, ts=5):
    """Chain of torus links along a (smoothed) polyline; alternate links rotated by `twist` degrees
    (90 = classic chain; ~45 reads like a rope chain). Pair with add_bone_chain + skin_along."""
    path = _smooth_path(points, 200) if smooth else _resample(points, 200)
    L = sum((b - a).length for a, b in zip(path, path[1:]))
    n = max(2, int(L / (link_len * 0.78)))
    pts = _resample(path, n)
    fr = _frames(pts)
    bm = bmesh.new()
    for i, (p, (Tt, Nn, Bb)) in enumerate(zip(pts, fr)):
        ang = math.radians(twist) * (i % 2) + math.radians(12) * i
        d1 = Nn * math.cos(ang) + Bb * math.sin(ang)
        vs = []
        for a in range(seg):
            th = 2 * math.pi * a / seg
            cc = p + Tt * (math.cos(th) * (link_len * 0.5 - wire)) + d1 * (math.sin(th) * (link_width * 0.5 - wire))
            rad = (Tt * math.cos(th) * (link_width / link_len) + d1 * math.sin(th)).normalized()
            ax = Tt.cross(d1)
            for b in range(ts):
                ph = 2 * math.pi * b / ts
                vs.append(bm.verts.new(cc + rad * (wire * math.cos(ph)) + ax * (wire * math.sin(ph))))
        for a in range(seg):
            for b in range(ts):
                q = [vs[a * ts + b], vs[((a + 1) % seg) * ts + b], vs[((a + 1) % seg) * ts + (b + 1) % ts],
                     vs[a * ts + (b + 1) % ts]]
                bm.faces.new(q)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    ob = _obj_from_bm(name, bm, material, skin=skin)
    _uv_flat(ob)
    return ob


def feather(base, tip, width=0.08, curl=0.25, droop=0.0, bend_dir=None, barbs=14, jag=0.35, segments=28,
            thickness=0.004, material=None, shaft_material=None, name='Feather', side_up=None, skin='follow',
            spine_points=4):
    """Curly plume (ostrich-style): a curved vane along a quadratic spine base->tip with ragged barb
    notches and a thin shaft. curl bends the spine sideways (fraction of length) toward bend_dir
    (default: up), droop pulls the tip down. Returns (object, spine) where spine has `spine_points`
    points (default 4) -> add_bone_chain(['feather_1', 'feather_2', 'feather_3'], 'hat', spine)."""
    A, B = Vector(base), Vector(tip)
    L = (B - A).length
    ax = (B - A).normalized()
    bd = Vector(bend_dir) if bend_dir is not None else Vector((0, 0, 1))
    bd = (bd - ax * bd.dot(ax))
    bd = bd.normalized() if bd.length > 1e-6 else ax.orthogonal().normalized()
    ctrl = A.lerp(B, 0.5) + bd * (curl * L)

    def spine(t):
        p = (1 - t) ** 2 * A + 2 * (1 - t) * t * ctrl + t * t * B
        return p - Vector((0, 0, droop * L * max(t, 0.0) ** 2.2))
    sn = Vector(side_up) if side_up is not None else ax.cross(bd)
    sn.normalize()
    rng = np.random.default_rng(7)
    Vv, Ff = [], []
    for i in range(segments + 1):
        t = i / segments
        p = spine(t)
        tan = (spine(min(1, t + 0.01)) - spine(max(0, t - 0.01))).normalized()
        side = tan.cross(sn).normalized()
        w = width * (math.sin(math.pi * min(1, t * 1.05) ** 0.75) * (1 - 0.25 * t) + 0.04)
        for s in (-1, 1):
            notch = 1 - jag * (0.5 + 0.5 * math.sin(t * barbs * math.pi * 2 + (0 if s > 0 else 1.7))) ** 3 \
                * (0.6 + 0.4 * rng.random())
            Vv.append(p + side * (s * w * notch) - tan * (0.18 * w * notch * (1 - t)) +
                      sn * (0.25 * w * (notch ** 2)) * (0.3 + t))
        Vv.append(p + sn * (0.02 * w))
    for i in range(segments):
        a = i * 3
        b = a + 3
        Ff.append((a, a + 2, b + 2, b))
        Ff.append((a + 2, a + 1, b + 1, b + 2))
    vane = _obj_from_data(name, Vv, Ff, material, skin=skin)
    _uv_flat(vane)
    solidify(vane, thickness, offset=0)
    sp = [spine(t) for t in np.linspace(0, 1, spine_points)]
    shaft = tube([spine(t) for t in np.linspace(-0.08, 0.92, 12)], lambda t: 0.006 * (1 - 0.7 * t), segs=8,
                 material=shaft_material or material, name=name + '_shaft', skin=skin)
    ob = join([vane, shaft], name)
    return ob, sp


def dish(center, normal=(0, -1, 0), radius=0.12, depth=0.045, feed=True, segs=28, rings=8, thickness=0.006,
         material=None, feed_material=None, name='Dish', skin='follow'):
    """Satellite dish: parabolic bowl opening towards `normal`, with a 3-strut feed horn."""
    n = Vector(normal).normalized()
    c = Vector(center)
    e1 = n.orthogonal().normalized()
    e2 = n.cross(e1)
    prof = [(depth * (r / radius) ** 2, r, r) for r in np.linspace(0, radius, rings + 1)]
    prof[0] = (0, 0, 0)
    vs, fs = _revolve(prof, segs, lambda t, rx, ry, a: tuple(c + n * t + e1 * rx * math.cos(a) + e2 * ry * math.sin(a)))
    bowl = _obj_from_data(name, vs, fs, material, skin=skin)
    _uv_flat(bowl)
    solidify(bowl, thickness, offset=-1)
    parts = [bowl]
    if feed:
        f = c + n * (radius * 0.9)
        parts.append(sphere(f, radius * 0.08, material=feed_material or material, name=name + '_feed', skin=skin))
        for k in range(3):
            a = 2 * math.pi * k / 3
            rim = c + n * depth + e1 * (radius * 0.95 * math.cos(a)) + e2 * (radius * 0.95 * math.sin(a))
            parts.append(tube([rim, f], radius * 0.02, segs=6, smooth=False, material=feed_material or material,
                              name=name + '_strut', skin=skin))
        parts.append(cylinder(c - n * radius * 0.12, n, radius * 0.12, radius * 0.3,
                              material=feed_material or material, name=name + '_mount', skin=skin))
    return join(parts, name)


# ============================================================================ garments
def _drape_radius(z, direction):
    """max torso radius at or above z (hanging fabric)"""
    m = _S['m'] or measure()
    top = m['neck'].z
    best = 0.0
    for zz in np.linspace(z, max(z, top), 8):
        best = max(best, radius_at(float(zz), direction))
    return best


def _body_submesh(keep_face, classes=('torso', 'head'), subdivide=0):
    """bmesh of body polygons (world space) whose class is in `classes` and keep_face(center, normal)
    is true; carries 'w' weights via a deform layer + source vertex normals."""
    d = _S['data']
    cls = _classes(classes)
    Vw, Nw, C = d['V'], d['N'], d['C']
    bm = bmesh.new()
    dl = bm.verts.layers.deform.verify()
    vmap = {}
    names = sorted({n for w in d['W'] for n in w})
    gidx = {n: i for i, n in enumerate(names)}
    for poly in d['polys']:
        cs = [C[i] for i in poly]
        if max(set(cs), key=cs.count) not in cls:
            continue
        cen = sum((Vw[i] for i in poly), Vector()) / len(poly)
        nrm = sum((Nw[i] for i in poly), Vector()).normalized()
        if not keep_face(cen, nrm):
            continue
        vs = []
        for i in poly:
            if i not in vmap:
                bv = bm.verts.new(Vw[i])
                bv.normal = Nw[i]
                for n, x in d['W'][i].items():
                    bv[dl][gidx[n]] = x
                vmap[i] = bv
            vs.append(vmap[i])
        try:
            bm.faces.new(vs)
        except ValueError:
            pass
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
    if subdivide:
        bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=subdivide, use_grid_fill=True, smooth=0.5)
    return bm, names


def _bm_to_obj(name, bm, names, material, skin):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = _link(bpy.data.objects.new(name, me))
    for n in names:
        ob.vertex_groups.new(name=n)
    set_material(ob, material)
    shade_smooth(ob)
    return register(ob, skin)


def _smooth_normals(bm, iters=3):
    ns = {v: v.normal.copy() for v in bm.verts}
    for _ in range(iters):
        new = {}
        for v in bm.verts:
            acc = ns[v] * 2
            for e in v.link_edges:
                acc = acc + ns[e.other_vert(v)]
            new[v] = acc.normalized()
        ns = new
    return ns


def _gap_fn(g):
    if g is None or g is False:
        return None
    if g is True:
        return lambda z: 0.06
    if callable(g):
        return g
    return lambda z, g=float(g): g


def shell(z=None, offset=0.02, thickness=0.01, open_front=None, hem_noise=0.0, region=None, bones=None,
          classes=('torso',), subdivide=0, material=None, name='Shell', uv_tile=0.35, fluff=0.0, seed=0,
          front_only=False, max_tris=2000, cuts=None):
    """Garment grown from the body surface (shirts, jackets, vests, tops, bodysuits).
    Copies the body faces in the region, pushes them `offset` out along smoothed normals, gives them
    `thickness` (outward) and copies the body's own skin weights (deforms exactly like the body).
      z=(z_min, z_max): height band; region=callable(center, normal)->bool for custom cuts (V-necks:
      lambda c, n: c.z < 0.6 + 0.8 * abs(c.x)); bones=['chest', 'spine']: faces whose weights are
      mostly on these bones; classes: body parts to copy ('torso', 'head', 'arms', 'legs', 'limbs').
      open_front=half-gap (m) or callable(z)->half-gap: cut a front opening (jackets, coats).
      front_only=True keeps only the front half (bibs, aprons, vest fronts).
      offset may be callable(z)->m. hem_noise / fluff (m): ragged edges / furry lumps.
      max_tris: the copied body patch is decimated to about this many triangles per side (weights
      are preserved) - dense bodies would otherwise blow the 35k budget.
      cuts=[(point, normal), ...]: planes the patch is sliced along BEFORE faces are selected, so
      region borders lying on them are perfectly straight (the z band is always cut). V-neck:
      region=lambda c, n: c.z < 0.57 + abs(c.x), cuts=[((0, 0, .57), (-1, 0, 1)), ((0, 0, .57), (1, 0, 1))].
    Returns the object (UVs cylindrical, uv_tile metres per repeat)."""
    ax = _axis_xy()
    gap = _gap_fn(open_front)
    bset = set(bones) if bones else None
    d = _S['data']

    def keep(c, n):
        if z and not (z[0] <= c.z <= z[1]):
            return False
        if region and not region(c, n):
            return False
        if front_only and c.y > ax.y:
            return False
        if gap and c.y < ax.y and abs(c.x - ax.x) < gap(c.z):
            return False
        return True
    pad = 0.06
    bm, names = _body_submesh(lambda c, n: not z or (z[0] - pad <= c.z <= z[1] + pad), classes, subdivide)
    bm = _decimate_bm(bm, names, max_tris * (1.25 if z else 1.0))
    planes = [(Vector(co), Vector(no).normalized()) for co, no in (cuts or [])]
    if z:
        planes += [(Vector((0, 0, z[0])), Vector((0, 0, 1))), (Vector((0, 0, z[1])), Vector((0, 0, 1)))]
    for co, no in planes:
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-5, plane_co=co, plane_no=no)
    bm.normal_update()
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if not keep(f.calc_center_median(), f.normal)], context='FACES')
    if bset:
        dl = bm.verts.layers.deform.verify()
        kill = []
        for f in bm.faces:
            tot = sum(sum(x for gi, x in v[dl].items() if names[gi] in bset) for v in f.verts) / len(f.verts)
            if tot < 0.5:
                kill.append(f)
        bmesh.ops.delete(bm, geom=kill, context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    if not bm.verts:
        raise RuntimeError('shell(): region selected no body faces (check z / region / classes)')
    bm.normal_update()
    ns = _smooth_normals(bm, 3)
    for v in bm.verts:
        o = offset(v.co.z) if callable(offset) else offset
        v.co = v.co + ns[v] * o
    ob = _bm_to_obj(name, bm, names, material, skin=None)
    if hem_noise:
        fluff_edges(ob, hem_noise, seed=seed)
    if fluff:
        displace(ob, fluff, seed=seed)
    solidify(ob, thickness, offset=1.0)
    uv_cylinder(ob, uv_tile)
    return ob


def _decimate_bm(bm, names, max_tris):
    n = sum(len(f.verts) - 2 for f in bm.faces)
    if not max_tris or n <= max_tris:
        return bm
    me = bpy.data.meshes.new('_dec')
    bm.to_mesh(me)
    bm.free()
    ob = _link(bpy.data.objects.new('_dec', me))
    for nm in names:
        ob.vertex_groups.new(name=nm)
    decimate(ob, int(max_tris))
    out = bmesh.new()
    out.from_mesh(ob.data)
    old = ob.data
    bpy.data.objects.remove(ob, do_unlink=True)
    bpy.data.meshes.remove(old)
    return out


def decimate(ob, max_tris):
    """Collapse-decimate `ob` to about max_tris triangles (no-op if already below). Keeps vertex
    groups, UVs and open borders."""
    t = tri_count(ob)
    if not max_tris or t <= max_tris:
        return ob
    md = ob.modifiers.new('dec', 'DECIMATE')
    md.decimate_type = 'COLLAPSE'
    md.ratio = max(0.02, max_tris / t)
    try:
        md.use_collapse_triangulate = False
    except Exception:
        pass
    apply_modifiers(ob)
    return ob


def robe(z_top, z_hem, offset=0.03, flare=0.04, open_front=None, thickness=0.012, hem_noise=0.0, fluff=0.0,
         segs=56, rings=None, top_offset=0.006, material=None, name='Robe', uv_tile=0.35, seed=0, back_slit=0.0):
    """Hanging garment (coats, robes, dresses, ponchos, skirts): rings from z_top down to z_hem whose
    radius per azimuth is the widest body radius at or above that height (fabric drapes straight off
    the belly / bust) + offset, flaring by `flare` (m) at the hem. Near z_top it closes in onto the
    body (top_offset) so the neckline hugs. open_front = half-gap (m) or callable(z) (open coats,
    bathrobes). Skinned from the torso+legs (not arms), smoothed. Below the body it keeps hanging."""
    measure()
    ax = _axis_xy()
    rings = rings or max(12, int((z_top - z_hem) / 0.025))
    zs = np.linspace(z_top, z_hem, rings + 1)
    NA = 96                                   # fixed azimuth grid for the drape radii
    grid = np.array([360.0 * k / NA for k in range(NA + 1)])
    R = np.zeros((len(zs), NA + 1))
    for j in range(NA):
        run = 0.0
        for i, zz in enumerate(zs):
            run = max(run, radius_at(float(zz), float(grid[j])))
            R[i, j] = run
    R[:, NA] = R[:, 0]
    gap = _gap_fn(open_front)
    Vv, Ff = [], []
    nper = segs + 1 if gap else segs
    for i, zz in enumerate(zs):
        t = (z_top - zz) / max(z_top - z_hem, 1e-6)
        hug = smoothstep(0.0, 0.07 / max(z_top - z_hem, 1e-3), t)
        off = top_offset + (offset - top_offset) * hug + flare * t ** 1.6
        if gap:   # open ring whose ends sit exactly on the opening edge x = +-gap(z)
            rf = float(R[i, 0]) + off
            a0 = math.degrees(math.asin(min(0.97, max(0.0, gap(float(zz))) / max(rf, 1e-6))))
            azs = np.linspace(a0, 360.0 - a0, nper)
        else:
            azs = np.linspace(0, 360.0, segs, endpoint=False)
        for a in azs:
            r = float(np.interp(a % 360.0, grid, R[i]))
            Vv.append(Vector((ax.x, ax.y, zz)) + _dir(float(a)) * (r + off))
    for i in range(len(zs) - 1):
        for j in range(segs):
            a, b = i * nper + j, i * nper + (j + 1) % nper
            Ff.append((a, a + nper, b + nper, b))
    ob = _obj_from_data(name, Vv, Ff, material, skin=None)
    if back_slit:
        _delete_faces(ob, lambda c: c.y > ax.y and abs(c.x - ax.x) < 0.012 and c.z < z_hem + back_slit)
    if hem_noise:
        fluff_edges(ob, hem_noise, seed=seed)
    if fluff:
        displace(ob, fluff, seed=seed)
    _recalc_normals(ob)
    _outward_normals(ob)
    solidify(ob, thickness, offset=1.0)
    uv_cylinder(ob, uv_tile)
    ob['kit_skin'] = json.dumps({'mode': 'body', 'exclude': ['arms'], 'smooth': 6})
    return ob


def _outward_normals(ob):
    """flip faces whose normal points toward the body axis"""
    ax = _axis_xy()
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.normal_update()
    flip = 0
    for f in bm.faces:
        c = f.calc_center_median()
        if f.normal.dot(Vector((c.x - ax.x, c.y - ax.y, 0))) < 0:
            flip += 1
    if flip > len(bm.faces) / 2:
        for f in bm.faces:
            f.normal_flip()
    bm.to_mesh(ob.data)
    bm.free()


def _limb_path(side, kind):
    S = side.upper()[0]
    s = 'left' if S == 'L' else 'right'
    if kind == 'arm':
        roles = [s + 'UpperArm', s + 'LowerArm', s + 'Hand']
    else:
        roles = [s + 'UpperLeg', s + 'LowerLeg', s + 'Foot']
    pts = [_bone_head(r) for r in roles]
    end = _bone_head(roles[-1], tail=True)
    if any(p is None for p in pts):
        raise RuntimeError('base has no %s %s bones' % (s, kind))
    return pts, end, [bone(r) for r in roles]


def _path_point(pts, t):
    """t in [0,1] over pts[0]..pts[2] (0.5 = pts[1]); beyond -> extrapolate along first/last segment"""
    L1 = (pts[1] - pts[0]).length
    L2 = (pts[2] - pts[1]).length
    s = t * (L1 + L2)
    if s <= L1:
        return pts[0] + (pts[1] - pts[0]).normalized() * s
    return pts[1] + (pts[2] - pts[1]).normalized() * (s - L1)


def _limb_tube(side, kind, start, end, radius_scale, offset, flare, segs, rings, min_r, name, material,
               thickness, hem_noise, fluff, seed, taper=0.0):
    pts, tip, bnames = _limb_path(side, kind)
    S = side.upper()[0]
    cls = {('arm_' if kind == 'arm' else 'leg_') + S}
    bvh = _bvh(cls)[0]
    ts = np.linspace(start, end, rings + 1)
    Ltot = (pts[1] - pts[0]).length + (pts[2] - pts[1]).length

    def at(t):
        if t <= 1.0:
            return _path_point(pts, float(t))
        return pts[2] + (tip - pts[2]).normalized() * (float(t) - 1.0) * Ltot
    centers = [at(t) for t in ts]
    fr = _frames(centers)
    Vv, Ff = [], []
    meas = np.zeros((len(ts), segs))
    for i, (c, (Tt, Nn, Bb)) in enumerate(zip(centers, fr)):
        for k in range(segs):
            a = 2 * math.pi * k / segs
            dv = Nn * math.cos(a) + Bb * math.sin(a)
            hit = bvh.ray_cast(c, dv, 0.6) if bvh else (None,)
            meas[i, k] = (hit[0] - c).length if hit[0] is not None else np.nan
    # fill gaps (outside the limb mesh, e.g. inside the torso): nearest valid ring, else min_r
    for i in range(len(ts)):
        if np.all(np.isnan(meas[i])):
            continue
        row = meas[i]
        row[np.isnan(row)] = np.nanmedian(row)
    valid = [i for i in range(len(ts)) if not np.all(np.isnan(meas[i]))]
    for i in range(len(ts)):
        if np.all(np.isnan(meas[i])):
            meas[i] = meas[min(valid, key=lambda j: abs(j - i))] if valid else min_r
    # smooth along the tube
    for _ in range(2):
        meas[1:-1] = 0.25 * meas[:-2] + 0.5 * meas[1:-1] + 0.25 * meas[2:]
    for i, (c, (Tt, Nn, Bb)) in enumerate(zip(centers, fr)):
        t = (ts[i] - start) / max(end - start, 1e-6)
        for k in range(segs):
            a = 2 * math.pi * k / segs
            dv = Nn * math.cos(a) + Bb * math.sin(a)
            r = max(meas[i, k], min_r) * radius_scale * (1 - taper * t) + offset + flare * t ** 2
            Vv.append(c + dv * r)
    for i in range(len(ts) - 1):
        for k in range(segs):
            a, b = i * segs + k, i * segs + (k + 1) % segs
            Ff.append((a, b, b + segs, a + segs))
    ob = _obj_from_data(name, Vv, Ff, material, skin=None)
    _outward_tube(ob, centers)
    if hem_noise:
        nend = rings * segs
        fluff_edges(ob, hem_noise, seed=seed, select=lambda v: v.index >= nend)
    if fluff:
        displace(ob, fluff, seed=seed)
    solidify(ob, thickness, offset=1.0)
    # uv: u around, v along
    L = (pts[1] - pts[0]).length + (pts[2] - pts[1]).length
    me = ob.data
    uvd = _uv_layer(ob)
    for p in me.polygons:
        us, vs = [], []
        for vi in p.vertices:
            k = vi % (segs * (len(ts))) if vi < segs * len(ts) else vi - segs * len(ts)
            k = k % (segs * len(ts))
            us.append((k % segs) / segs)
            vs.append(ts[min(k // segs, len(ts) - 1)] * L / 0.3)
        if max(us) - min(us) > 0.5:
            us = [u + 1 if u < 0.5 else u for u in us]
        for li, u, v in zip(p.loop_indices, us, vs):
            uvd[li].uv = (u, v)
    # analytic weights along the limb (robust: no torso bleed when the limb moves)
    root = _S['arm'].data.bones[bnames[0]].parent
    root = root.name if root else bnames[0]
    anchors = [(root, -0.12), (bnames[0], 0.22), (bnames[1], 0.72), (bnames[2], 1.05)]
    if kind == 'leg':
        anchors = [(root, -0.10), (bnames[0], 0.2), (bnames[1], 0.72), (bnames[2], 1.05)]
    Lp = (pts[1] - pts[0]).length + (pts[2] - pts[1]).length
    seg0 = (pts[1] - pts[0]).length / Lp

    def wfn(co):
        # parameter t of the closest point on the limb path
        best, bt = 1e9, 0.0
        for tt in np.linspace(start, end, 60):
            dd = (co - at(tt)).length
            if dd < best:
                best, bt = dd, float(tt)
        # remap so the elbow/knee joint sits at t = seg0
        tj = bt
        w = {}
        if tj <= anchors[0][1]:
            w[anchors[0][0]] = 1.0
        elif tj >= anchors[-1][1]:
            w[anchors[-1][0]] = 1.0
        else:
            for (b0, t0), (b1, t1) in zip(anchors, anchors[1:]):
                if t0 <= tj <= t1:
                    k = smoothstep(t0, t1, tj)
                    w[b0] = w.get(b0, 0) + 1 - k
                    w[b1] = w.get(b1, 0) + k
                    break
        return w
    anchors[1] = (anchors[1][0], seg0 * 0.45)
    anchors[2] = (anchors[2][0], seg0 + (1 - seg0) * 0.45)
    skin_blend(ob, wfn)
    return ob


def _outward_tube(ob, centers):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.normal_update()
    kd = KDTree(len(centers))
    for i, c in enumerate(centers):
        kd.insert(c, i)
    kd.balance()
    bad = 0
    for f in bm.faces:
        c = f.calc_center_median()
        p, _, _ = kd.find(c)
        if f.normal.dot(c - p) < 0:
            bad += 1
    if bad > len(bm.faces) / 2:
        for f in bm.faces:
            f.normal_flip()
    bm.to_mesh(ob.data)
    bm.free()


def sleeve(side, start=-0.12, end=1.0, radius_scale=1.0, offset=0.018, flare=0.0, thickness=0.008,
           hem_noise=0.0, fluff=0.0, segs=20, rings=22, min_r=0.03, material=None, name=None, seed=0, taper=0.0):
    """Sleeve on the character's `side` ('L'/'R'), measured around the base's arm. t: 0 = shoulder
    joint, 0.5-ish = elbow, 1.0 = wrist, >1 = over the hand (1.1 = mid-hand). start<0 begins inside
    the torso/jacket (hides the seam). radius = measured arm radius * radius_scale + offset (+ flare
    at the cuff). Weighted analytically along shoulder/upper/lower arm/hand (no tearing)."""
    return _limb_tube(side, 'arm', start, end, radius_scale, offset, flare, segs, rings, min_r,
                      name or 'Sleeve_' + side.upper()[0], material, thickness, hem_noise, fluff, seed, taper)


def pants(length=1.0, waist_z=None, offset=0.014, leg_scale=1.0, flare=0.0, thickness=0.008, seat=True,
          hem_noise=0.0, segs=22, rings=18, min_r=0.04, material=None, name='Pants', seed=0, seat_offset=None):
    """Trousers: a seat shell (body faces below waist_z, default = hips + 35% of hips->spine) and two
    leg tubes measured on the legs. length: 1.0 = to the ankle, 0.5 = mid-shin/knee, 0.3 = shorts.
    Returns the joined object."""
    m = measure()
    wz = waist_z if waist_z is not None else m['hips'].z + 0.35 * (m['spine'].z - m['hips'].z + 0.1)
    parts = []
    if seat:
        so = offset if seat_offset is None else seat_offset
        try:
            parts.append(shell(z=(-10, wz), offset=so, thickness=thickness, classes=('torso',), material=material,
                               name=name + '_seat', max_tris=1200))
        except RuntimeError:
            pass
    for side in 'LR':
        parts.append(_limb_tube(side, 'leg', -0.18, length, leg_scale, offset, flare, segs, rings, min_r,
                                name + '_' + side, material, thickness, hem_noise, 0.0, seed, 0.0))
    return join(parts, name)


def shorts(length=0.35, **kw):
    """pants() with short legs (0.35 ~ above the knee on a normal leg)."""
    kw.setdefault('name', 'Shorts')
    return pants(length=length, **kw)


def collar(z, height=0.05, offset=0.012, flare=0.02, open_front=None, thickness=0.008, material=None,
           name='Collar', segs=48, tilt_out=0.0, hem_noise=0.0, seed=0):
    """Standing / turtleneck / mandarin collar band from z up by `height`, hugging the body radius at z
    (+offset), flaring outward by `flare` at the top. open_front = half-gap."""
    ax = _axis_xy()
    rows = max(3, int(height / 0.01))
    Vv, Ff = [], []
    for i in range(rows + 1):
        t = i / rows
        zz = z + height * t
        for k in range(segs):
            a = 360.0 * k / segs
            r = radius_at(z, a) or _drape_radius(z, a)
            Vv.append(Vector((ax.x, ax.y, zz - tilt_out * t)) + _dir(a) * (r + offset + flare * t))
    for i in range(rows):
        for k in range(segs):
            a, b = i * segs + k, i * segs + (k + 1) % segs
            Ff.append((a, a + segs, b + segs, b))
    ob = _obj_from_data(name, Vv, Ff, material, skin=None)
    gap = _gap_fn(open_front)
    if gap:
        _delete_faces(ob, lambda c: c.y < ax.y and abs(c.x - ax.x) < gap(c.z))
    if hem_noise:
        fluff_edges(ob, hem_noise, seed=seed)
    _outward_normals(ob)
    solidify(ob, thickness, offset=1.0)
    uv_cylinder(ob, 0.3)
    ob['kit_skin'] = json.dumps({'mode': 'body', 'exclude': ['arms'], 'smooth': 3})
    return ob


def _delete_faces(ob, pred):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    kill = [f for f in bm.faces if pred(f.calc_center_median())]
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.to_mesh(ob.data)
    bm.free()


def belt(z, width=0.06, offset=0.03, thickness=0.012, buckle=(0.075, 0.06), material=None, buckle_material=None,
         name='Belt', segs=64, buckle_depth=0.018, drape=True):
    """Belt band around the body at height z (hugging the widest radius within the band + offset).
    Returns (belt, buckle) - buckle is None when buckle=None. buckle=(w, h) box at the front."""
    ax = _axis_xy()
    Vv, Ff = [], []
    rows = 2
    rad = []
    for k in range(segs):
        a = 360.0 * k / segs
        rr = [radius_at(float(zz), a) for zz in np.linspace(z - width / 2, z + width / 2, 4)]
        r = max(rr) if max(rr) > 0 else _drape_radius(z, a)
        rad.append(r)
    for i in range(rows + 1):
        zz = z - width / 2 + width * i / rows
        for k in range(segs):
            Vv.append(Vector((ax.x, ax.y, zz)) + _dir(360.0 * k / segs) * (rad[k] + offset))
    for i in range(rows):
        for k in range(segs):
            a, b = i * segs + k, i * segs + (k + 1) % segs
            Ff.append((a, a + segs, b + segs, b))
    ob = _obj_from_data(name, Vv, Ff, material, skin=None)
    _outward_normals(ob)
    solidify(ob, thickness, offset=1.0)
    uv_cylinder(ob, 0.3)
    ob['kit_skin'] = json.dumps({'mode': 'body', 'exclude': ['arms', 'legs'], 'smooth': 4})
    bk = None
    if buckle:
        p = Vector((ax.x, ax.y, z)) + _dir(0) * (rad[0] + offset + thickness + buckle_depth * 0.5)
        bk = box_part(p, (buckle[0], buckle_depth, buckle[1]), bevel=0.006, material=buckle_material or material,
                      name=name + '_buckle', uv=None)
    return ob, bk


def strap(p0, p1, width=0.04, thickness=0.008, offset=0.02, via=None, samples=32, target=None, material=None,
          name='Strap', smooth=True):
    """Flat strap lying on the body surface from p0 to p1 (through optional `via` points): every sample
    is projected outward from the body's centre line onto the surface (+offset), so a strap from the
    front belt to the back belt wraps over the shoulder. target: object to lie on instead of the body.
    Returns the object."""
    pts = [Vector(p0)] + [Vector(v) for v in (via or [])] + [Vector(p1)]
    path = _smooth_path(pts, samples) if smooth and len(pts) > 2 else _resample(pts, samples)
    bvh = _target_bvh(target) if target is not None else _torso_bvh()
    m = measure()
    ax = _axis_xy()
    z_lo, z_hi = m['hips'].z, m['neck'].z
    proj = []
    for p in path:
        c = Vector((ax.x, ax.y, min(max(p.z, z_lo), z_hi)))
        dv = p - c
        if dv.length < 1e-6:
            dv = _dir(0)
        loc, n, _, _ = bvh.ray_cast(c, dv.normalized(), 5.0)
        if loc is None:
            loc, n, _, _ = bvh.find_nearest(p)
        if n.dot(dv) < 0:
            n = -n
        proj.append((loc + n * offset, n))
    Vv, Ff = [], []
    for i, (p, n) in enumerate(proj):
        a = proj[max(i - 1, 0)][0]
        b = proj[min(i + 1, len(proj) - 1)][0]
        t = (b - a).normalized()
        s = t.cross(n).normalized()
        Vv += [p - s * width / 2, p + s * width / 2]
    for i in range(len(proj) - 1):
        Ff.append((2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2))
    ob = _obj_from_data(name, Vv, Ff, material, skin=None, smooth=True)
    # outward = away from the body
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.normal_update()
    if sum(f.normal.dot(proj[min(i, len(proj) - 1)][1]) for i, f in enumerate(bm.faces)) < 0:
        for f in bm.faces:
            f.normal_flip()
    bm.to_mesh(ob.data)
    bm.free()
    solidify(ob, thickness, offset=1.0)
    uv_planar(ob, 'front', 0.3)
    ob['kit_skin'] = json.dumps({'mode': 'body', 'exclude': ['arms'], 'smooth': 3})
    return ob


def panel(x0, x1, zlo, zhi, offset=0.004, direction='front', target=None, nx=24, nz=12, thickness=0.0,
          material=None, name='Panel'):
    """Structured quad patch seen from `direction`: columns x0..x1 (screen-right coordinate of that
    view; for 'front' = world x), rows zlo(x)..zhi(x) (floats or callables of x), ray-projected onto
    the body (or `target` object) and pushed `offset` out. UVs span exactly 0..1 (u along x, v up):
    perfect for printed designs, labels, shirt fronts, pockets, patches."""
    out, right, up = _plane_axes(direction)
    bvh = _target_bvh(target)
    lo = zlo if callable(zlo) else (lambda x, v=zlo: v)
    hi = zhi if callable(zhi) else (lambda x, v=zhi: v)
    Vv = []
    for i in range(nx + 1):
        a = x0 + (x1 - x0) * i / nx
        zl, zh = lo(a), hi(a)
        for j in range(nz + 1):
            zz = zl + (zh - zl) * j / nz
            o = right * a + up * zz + out * 5.0
            loc, n, _, _ = bvh.ray_cast(o, -out, 10.0)
            if loc is None:
                loc, n, _, _ = bvh.find_nearest(right * a + up * zz)
            if n.dot(out) < 0:
                n = -n
            Vv.append(loc + n * offset)
    Ff = []
    for i in range(nx):
        for j in range(nz):
            k = i * (nz + 1) + j
            Ff.append((k, k + nz + 1, k + nz + 2, k + 1))
    ob = _obj_from_data(name, Vv, Ff, material, skin=None)
    zmin = min(min(lo(x0 + (x1 - x0) * i / nx) for i in range(nx + 1)), 1e9)
    zmax = max(hi(x0 + (x1 - x0) * i / nx) for i in range(nx + 1))
    me = ob.data
    uvd = _uv_layer(ob)
    for p in me.polygons:
        for li, vi in zip(p.loop_indices, p.vertices):
            i, j = divmod(vi, nz + 1)
            uvd[li].uv = (i / nx, j / nz)          # exact 0..1 (label contract)
    # face the viewer
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.normal_update()
    if sum(f.normal.dot(out) for f in bm.faces) < 0:
        for f in bm.faces:
            f.normal_flip()
    bm.to_mesh(me)
    bm.free()
    if thickness:
        solidify(ob, thickness, offset=-1.0)
    ob['kit_skin'] = json.dumps({'mode': 'body', 'exclude': ['arms'], 'smooth': 2})
    ob['kit_rect'] = [x0, x1, zmin, zmax]
    return ob


def decal(poly, offset=0.004, thickness=0.0, direction='front', target=None, cuts=3, material=None,
          name='Decal', uv_rect_01=True):
    """Flat 2D polygon [(x, z), ...] (as seen from `direction`) projected onto the body or `target`
    (lapels, patches, emblems, pocket flaps, collar points). Keep shapes roughly convex; for long
    curved strips prefer panel(). UVs 0..1 over the polygon's bounding box."""
    out, right, up = _plane_axes(direction)
    bvh = _target_bvh(target)
    bm = bmesh.new()
    vs = [bm.verts.new(right * x + up * z + out * 5.0) for x, z in poly]
    bm.faces.new(vs)
    bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method='BEAUTY', ngon_method='BEAUTY')
    if cuts:
        bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=cuts, use_grid_fill=True)
    for v in bm.verts:
        loc, n, _, _ = bvh.ray_cast(v.co, -out, 10.0)
        if loc is None:
            loc, n, _, _ = bvh.find_nearest(v.co - out * 5.0)
        if n.dot(out) < 0:
            n = -n
        v.co = loc + n * offset
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
    bm.normal_update()
    for f in bm.faces:
        if f.normal.dot(out) < 0:
            f.normal_flip()
    ob = _obj_from_bm(name, bm, material, skin=None)
    xs = [p[0] for p in poly]
    zs = [p[1] for p in poly]
    rect = (min(xs), max(xs), min(zs), max(zs))
    uv_rect(ob, rect, direction) if uv_rect_01 else _uv_flat(ob)
    if thickness:
        solidify(ob, thickness, offset=-1.0)
    ob['kit_skin'] = json.dumps({'mode': 'body', 'exclude': ['arms'], 'smooth': 2})
    ob['kit_rect'] = list(rect)
    return ob


# ============================================================================ surface noise
def _noise3(p, seed=0, freq=30.0):
    s = seed * 1.618
    return (math.sin(freq * p.x + 1.3 + s) * math.sin(freq * 1.17 * p.y + 2.1 - s) * math.sin(freq * 0.93 * p.z + s * 2)
            + 0.5 * math.sin(freq * 2.3 * (p.x + p.z) + s * 3) * math.sin(freq * 2.1 * (p.y - p.z) + 1.0))


def displace(ob, amount=0.006, freq=40.0, seed=0):
    """Lumpy fur/cloth: push every vertex along its normal by amount * noise."""
    me = ob.data
    me.update()
    for v in me.vertices:
        n = v.normal
        v.co = v.co + n * (amount * _noise3(v.co, seed, freq))
    me.update()
    return ob


def fluff(ob, amount=0.01, seed=0):
    """Alias: ragged edges + lumpy surface in one go (fur trims, shaggy coats)."""
    fluff_edges(ob, amount, seed=seed)
    return displace(ob, amount * 0.4, seed=seed)


def fluff_edges(ob, amount=0.02, seed=0, rings=2, freq=55.0, select=None):
    """Ragged / tufted open edges (fur hems, torn cloth): boundary vertices are pushed outward in the
    surface plane by amount * spiky noise; the next ring moves half as much. select(bmvert)->bool
    limits which boundary vertices move (call BEFORE solidify)."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.verts.ensure_lookup_table()
    bm.normal_update()
    bverts = {v for e in bm.edges if e.is_boundary for v in e.verts}
    if select:
        bverts = {v for v in bverts if select(v)}
    moves = {}
    level = {v: 0 for v in bverts}
    frontier = set(bverts)
    for r in range(1, rings):
        nxt = set()
        for v in frontier:
            for e in v.link_edges:
                o = e.other_vert(v)
                if o not in level:
                    level[o] = r
                    nxt.add(o)
        frontier = nxt
    for v, lv in level.items():
        inner = [e.other_vert(v) for e in v.link_edges if level.get(e.other_vert(v), 99) > lv]
        if not inner:
            inner = [e.other_vert(v) for e in v.link_edges]
        c = sum((o.co for o in inner), Vector()) / max(len(inner), 1)
        out = v.co - c
        out = out - v.normal * out.dot(v.normal)
        if out.length < 1e-7:
            continue
        nval = 0.5 + 0.5 * _noise3(v.co, seed, freq)
        spike = nval ** 2 * (0.6 + 0.4 * math.sin(v.co.x * 211 + v.co.z * 173 + seed))
        moves[v] = out.normalized() * (amount * spike * (0.5 ** lv))
    for v, mv in moves.items():
        v.co = v.co + mv
    bm.to_mesh(ob.data)
    bm.free()
    return ob


# ============================================================================ hats
class Hat:
    """Result of a hat_* builder. objects: list; parts: dict name->object ('crown', 'brim', 'band', ...);
    base: centre of the hat's bottom (world); top: highest crown point; radius: crown radius;
    band: (z0, z1) local band heights. point(az, h, out) -> world point on the crown surface at
    azimuth az (0 = front) and local height h (m above the base); band_rect(width) -> front-view
    rect for label_face on the band."""

    def __init__(self, parts, base, M, radius, height, band, rfun, ry=1.0):
        self.parts = parts
        self.objects = list(parts.values())
        self.base = base
        self.M = M
        self.radius = radius
        self.height = height
        self.band = band
        self._r = rfun
        self.ry = ry
        self.top = M @ Vector((0, 0, height))

    def point(self, az=0.0, h=None, out=0.0):
        h = (self.band[0] + self.band[1]) / 2 if h is None else h
        a = math.radians(az)
        r = self._r(h) + out
        return self.M @ Vector((r * math.sin(a), -r * self.ry * math.cos(a), h))

    def band_rect(self, width=None, pad=0.0):
        width = width or self.radius * 1.1
        p0 = self.M @ Vector((0, 0, self.band[0]))
        p1 = self.M @ Vector((0, 0, self.band[1]))
        return (p0.x - width / 2, p0.x + width / 2, min(p0.z, p1.z) + pad, max(p0.z, p1.z) - pad)


def _hat_bone():
    return bone('hat') or bone('head')


def _hat_place(radius, brim_r, ry=1.0, fit='auto', lift=0.004, sink=0.0, offset=(0, 0), tilt=0.0, yaw=0.0):
    """returns (M world matrix of the hat's base frame, base point)"""
    m = measure()
    ht = m['head_top']
    cx, cy = ht.x + offset[0], ht.y + offset[1]

    def ring_h(r, n=24, fn=min):
        hs = []
        for k in range(n):
            a = 2 * math.pi * k / n
            h = head_height(cx + r * math.sin(a), cy - r * ry * math.cos(a))
            if h is not None:
                hs.append(h)
        return fn(hs) if hs else None
    seat = ring_h(radius * 0.97) or (ht.z - 0.02)
    # never sit on / inside the procedural eye bulbs
    eye_top = [c.z + math.sqrt(max(0.0, r * r - (math.hypot(c.x - cx, c.y - cy) - rr) ** 2))
               for c, r in _eye_spheres() for rr in (radius * 0.97, radius * 1.05)
               if abs(math.hypot(c.x - cx, c.y - cy) - rr) < r]
    if eye_top:
        seat = max(seat, max(eye_top) + lift)
    if fit == 'perch':
        z = max(filter(None, [ring_h(r, 24, max) for r in np.linspace(0, max(brim_r, radius), 8)])) + lift
    elif fit == 'seat':
        z = seat - sink
    else:   # auto: crown sits on the ring, the brim must clear everything beneath it (eyes included)
        ann = [ring_h(r, 32, max) for r in np.linspace(radius, max(brim_r, radius * 1.02), 6)]
        ann = [a for a in ann if a is not None]
        z = max([seat - sink] + [a + lift for a in ann]) if brim_r > radius * 1.05 else seat - sink
    base = Vector((cx, cy, z))
    M = Matrix.Translation(base) @ Matrix.Rotation(math.radians(yaw), 4, 'Z') @ Matrix.Rotation(math.radians(tilt), 4, 'X')
    return M, base


def _lathe_obj(name, prof, segs, M, sx=1.0, sy=1.0, deform=None, closed=False, material=None, sharp=None):
    def mp(t, rx, ry, a):
        x, y, z = rx * sx * math.sin(a), -ry * sy * math.cos(a), t
        if deform:
            x, y, z = deform(x, y, z)
        return tuple(M @ Vector((x, y, z)))
    vs, fs = _revolve([(z, r, r) for r, z in prof], segs, mp, closed=closed)
    ob = _obj_from_data(name, vs, fs, material, skin=None, sharp=sharp)
    _uv_flat(ob)
    return ob


def _finish_hat(parts, **kw):
    b = _hat_bone()
    for o in parts.values():
        o['kit_skin'] = json.dumps({'mode': 'rigid', 'bone': b})
    return Hat(parts, **kw)


def _brim_prof(r_in, r_out, t):
    return [(r_in, 0.0), (r_out - t, 0.0), (r_out, t * 0.5), (r_out - t, t), (r_in, t)]


def hat_top(radius=None, height=None, brim=None, material=None, band_material=None, band_height=None,
            curl=0.035, fit='auto', offset=(0, 0), tilt=0.0, segs=48, name='TopHat'):
    """Top hat: tall slightly flared crown, band, brim with curled-up sides. radius default = measured
    hat_radius * 0.6 (dapper small hat); height = 1.9 * radius; brim = 1.6 * radius."""
    m = measure()
    R = radius or m['hat_radius'] * 0.6
    H = height or R * 1.9
    Rb = brim or R * 1.6
    bh = band_height or H * 0.26
    M, base = _hat_place(R, Rb, fit=fit, offset=offset, tilt=tilt)
    crown = [(0.0, H), (R * 1.02, H), (R * 1.11, H * 0.985), (R * 1.14, H * 0.93), (R * 1.08, H * 0.6),
             (R * 1.0, H * 0.2), (R * 0.98, 0.0), (0.0, 0.0)]
    rf = lambda h: float(np.interp(h, [0, H * 0.2, H * 0.6, H * 0.93], [R * 0.98, R, R * 1.08, R * 1.14]))
    parts = {'crown': _lathe_obj(name + '_crown', crown, segs, M, material=_mat(material, '#22242d'), sharp=35)}
    parts['band'] = _lathe_obj(name + '_band', [(R * 0.99, 0.012), (R * 1.03, 0.013), (R * 1.035, bh),
                                                 (R * 1.01, bh + 0.001)], segs, M,
                               material=_mat(band_material, '#3c3f4e'), sharp=35)

    def brim_def(x, y, z):
        r = math.hypot(x, y)
        rr = max(0.0, (r - R) / max(Rb - R, 1e-6))
        ux = abs(x) / max(r, 1e-6)
        return x, y, z + curl * (ux ** 2.5) * (rr ** 1.6) - 0.1 * curl * (1 - ux) ** 2 * rr
    parts['brim'] = _lathe_obj(name + '_brim', _brim_prof(R * 0.9, Rb, 0.012), segs, M, deform=brim_def,
                               closed=True, material=_mat(material, '#22242d'), sharp=40)
    return _finish_hat(parts, base=base, M=M, radius=R, height=H, band=(0.012, bh), rfun=rf)


def hat_fedora(radius=None, height=None, brim=None, material=None, band_material=None, band_height=None,
               pinch=0.18, crease=0.35, snap=0.03, brim_ry=0.92, fit='auto', offset=(0, 0), tilt=0.0,
               segs=64, name='Fedora'):
    """Fedora / wide-brim hat: oval crown with a centre crease and front pinch, band, wide flat brim
    (snap: front droops / back turns up by that many metres; brim_ry < 1 = oval brim). Defaults:
    radius = hat_radius, height = 0.85 * radius, brim = 2.3 * radius (pimp / gangster hat:
    brim ~2.6-2.9 * radius)."""
    m = measure()
    R = radius or m['hat_radius'] * 1.0
    H = height or R * 0.85
    Rb = brim or R * 2.3
    bh = band_height or H * 0.28
    ry = 1.1
    M, base = _hat_place(R, Rb, ry=brim_ry, fit=fit, offset=offset, tilt=tilt)

    def crown_def(x, y, z):
        t = smoothstep(H * 0.45, H, z)
        # crease along the length (front-back) of the top
        z = z - crease * H * 0.35 * math.exp(-(x / (0.38 * R)) ** 2) * t * max(0.0, 1 - (y / (1.1 * R)) ** 2) ** 0.5
        # front pinch: squeeze the front sides
        if y < 0:
            k = pinch * t * min(1.0, -y / R) ** 1.5
            x = x * (1 - k)
        return x, y, z
    crown = [(0.0, 0.0), (R, 0.0), (R * 0.995, H * 0.3), (R * 0.96, H * 0.7), (R * 0.9, H * 0.9),
             (R * 0.78, H * 0.985), (R * 0.45, H), (0.0, H * 0.99)]
    rf = lambda h: float(np.interp(h, [0, H * 0.3, H * 0.7, H * 0.9], [R, R * 0.995, R * 0.96, R * 0.9]))
    parts = {'crown': _lathe_obj(name + '_crown', crown, segs, M, sy=ry, deform=crown_def,
                                 material=_mat(material, '#1d1d24'), sharp=None)}
    parts['band'] = _lathe_obj(name + '_band', [(R * 1.0, 0.008), (R * 1.035, 0.009), (R * 1.03, bh),
                                                 (R * 0.99, bh + 0.002)], segs, M, sy=ry,
                               material=_mat(band_material, '#6b2fa0'), sharp=35)

    def brim_def(x, y, z):
        r = math.hypot(x, y / brim_ry)
        rr = max(0.0, (r - R) / max(Rb - R, 1e-6))
        fy = -y / max(math.hypot(x, y), 1e-6)       # +1 front, -1 back
        return x, y, z - snap * rr ** 2 * max(0.0, fy) + snap * 1.2 * rr ** 2 * max(0.0, -fy) + 0.006 * rr * (abs(x) / max(r, 1e-6))
    parts['brim'] = _lathe_obj(name + '_brim', _brim_prof(R * 0.92, Rb, 0.014), segs, M, sy=brim_ry,
                               deform=brim_def, closed=True, material=_mat(material, '#1d1d24'), sharp=45)
    return _finish_hat(parts, base=base, M=M, radius=R, height=H, band=(0.008, bh), rfun=rf, ry=ry)


def hat_cowboy(radius=None, height=None, brim=None, material=None, band_material=None, band_height=None,
               curl=0.09, dent=0.3, pinch=0.25, fit='auto', offset=(0, 0), tilt=0.0, segs=64, name='CowboyHat'):
    """Cowboy hat: tall creased crown (centre dent + front pinch), band, wide brim with strongly
    upturned sides (curl m). Defaults: radius = hat_radius * 0.95, height = 1.0 * r, brim = 2.3 * r."""
    m = measure()
    R = radius or m['hat_radius'] * 0.95
    H = height or R * 1.0
    Rb = brim or R * 2.3
    bh = band_height or H * 0.2
    ry = 1.12
    M, base = _hat_place(R, Rb, ry=0.95, fit=fit, offset=offset, tilt=tilt)

    def crown_def(x, y, z):
        t = smoothstep(H * 0.4, H, z)
        z = z - dent * H * 0.4 * math.exp(-(x / (0.35 * R)) ** 2) * t * max(0.0, 1 - (y / (1.15 * R)) ** 2) ** 0.5
        if y < 0:
            x = x * (1 - pinch * t * min(1.0, -y / R) ** 1.3)
        return x, y, z
    crown = [(0.0, 0.0), (R, 0.0), (R * 0.99, H * 0.35), (R * 0.93, H * 0.75), (R * 0.85, H * 0.93),
             (R * 0.6, H), (0.0, H * 0.99)]
    rf = lambda h: float(np.interp(h, [0, H * 0.35, H * 0.75], [R, R * 0.99, R * 0.93]))
    parts = {'crown': _lathe_obj(name + '_crown', crown, segs, M, sy=ry, deform=crown_def,
                                 material=_mat(material, '#8a5230'))}
    parts['band'] = _lathe_obj(name + '_band', [(R, 0.008), (R * 1.035, 0.009), (R * 1.03, bh), (R * 0.99, bh + 0.002)],
                               segs, M, sy=ry, material=_mat(band_material, '#4f2c17'), sharp=35)

    def brim_def(x, y, z):
        r = math.hypot(x, y / 0.95)
        rr = max(0.0, (r - R) / max(Rb - R, 1e-6))
        ux = abs(x) / max(math.hypot(x, y), 1e-6)
        fy = -y / max(math.hypot(x, y), 1e-6)
        return x, y, z + curl * (ux ** 2.2) * (rr ** 1.8) - 0.18 * curl * max(0, fy) ** 2 * rr ** 1.5
    parts['brim'] = _lathe_obj(name + '_brim', _brim_prof(R * 0.92, Rb, 0.014), segs, M, sy=0.95, deform=brim_def,
                               closed=True, material=_mat(material, '#8a5230'))
    return _finish_hat(parts, base=base, M=M, radius=R, height=H, band=(0.008, bh), rfun=rf, ry=ry)


def hat_helmet(radius=None, height=None, material=None, band_material=None, rim=0.018, band=True,
               band_height=None, ear_cut=0.0, fit='seat', sink=0.0, offset=(0, 0), tilt=0.0, segs=64,
               name='Helmet', ry=1.08):
    """Helmet dome (steel pot / high-cut / bike): half-ellipsoid shell with an outward rim lip, and an
    optional band ring near the bottom (label area: label_face(hat.parts['band'], ...)). ear_cut (m)
    raises the rim at the sides (modern high-cut). Default radius = hat_radius, height = 0.72 * radius;
    fit='seat' sits the rim on the head ring (never below the eye bulbs)."""
    m = measure()
    R = radius or m['hat_radius']
    H = height or R * 0.72
    bh = band_height or H * 0.3
    M, base = _hat_place(R, R, ry=ry, fit=fit, sink=sink, offset=offset, tilt=tilt)
    prof = [(0.0, 0.0)]
    for k in range(0, 13):
        th = (math.pi / 2) * k / 12
        prof.append((R * math.cos(th), H * math.sin(th)))
    prof[-1] = (0.0, H)
    prof = [(0.0, 0.0), (R * 0.98, 0.0)] + prof[1:]

    def dome_def(x, y, z):
        if ear_cut:
            ux = abs(x) / max(math.hypot(x, y), 1e-6)
            z = z + ear_cut * ux ** 4 * max(0, 1 - z / (H * 0.5))
        return x, y, z
    rf = lambda h: R * math.sqrt(max(0.0, 1 - (h / H) ** 2))
    parts = {'crown': _lathe_obj(name + '_dome', prof, segs, M, sy=ry, deform=dome_def, material=_mat(material, '#5b6536'))}
    if rim:
        parts['rim'] = _lathe_obj(name + '_rim', [(R * 0.97, -0.004), (R + rim, -0.006), (R + rim * 1.05, 0.002),
                                                   (R * 1.0, 0.012)], segs, M, sy=ry, deform=dome_def,
                                  closed=True, material=_mat(material, '#5b6536'), sharp=40)
    if band:
        b0 = 0.012
        parts['band'] = _lathe_obj(name + '_band', [(rf(b0) + 0.001, b0), (rf(b0) + 0.007, b0 + 0.002),
                                                     (rf(bh) + 0.007, bh), (rf(bh) + 0.001, bh + 0.002)], segs, M,
                                   sy=ry, deform=dome_def, material=_mat(band_material or material, '#4c5530'), sharp=35)
    return _finish_hat(parts, base=base, M=M, radius=R, height=H, band=(0.012, bh), rfun=rf, ry=ry)


def hat_cap(radius=None, height=None, brim_length=None, brim_curve=0.35, material=None, brim_material=None,
            button=True, fit='seat', sink=0.0, offset=(0, 0), tilt=-4.0, segs=48, name='Cap', ry=1.08):
    """Baseball cap: six-panel dome, curved brim at the front, top button. Front label: call
    label_face(cap.parts['crown'], 'CapLabel', cap.front_rect(), text=...). Default radius =
    hat_radius * 0.85, height = 0.62 * radius, brim_length = 0.95 * radius."""
    m = measure()
    R = radius or m['hat_radius'] * 0.85
    H = height or R * 0.62
    BL = brim_length or R * 0.95
    M, base = _hat_place(R, R, ry=ry, fit=fit, sink=sink, offset=offset, tilt=tilt)
    prof = [(0.0, 0.0), (R * 0.99, 0.0)]
    for k in range(0, 13):
        th = (math.pi / 2) * k / 12
        prof.append((R * math.cos(th) ** 0.85, H * math.sin(th)))
    prof[-1] = (0.0, H)
    rf = lambda h: R * max(0.0, 1 - (h / H) ** 2) ** (0.85 / 2)
    parts = {'crown': _lathe_obj(name + '_crown', prof, segs, M, sy=ry, material=_mat(material, '#1b1b1f'))}
    # brim: half-annulus in front
    Vv, Ff = [], []
    n = 24
    for i in range(n + 1):
        a = math.radians(-80 + 160 * i / n)
        inner = Vector((R * 0.96 * math.sin(a), -R * ry * 0.96 * math.cos(a), 0.004))
        L = BL * math.cos(a * 0.9) ** 0.6
        outer = Vector((inner.x * (1 + L / R * 0.35), inner.y - L * math.cos(a) * 0.95, 0.004))
        for t in (0.0, 0.5, 1.0):
            p = inner.lerp(outer, t)
            p.z -= brim_curve * 0.12 * R * (abs(math.sin(a)) ** 2) * t + 0.02 * R * t * t
            Vv.append(M @ p)
    for i in range(n):
        for j in range(2):
            a = i * 3 + j
            Ff.append((a, a + 1, a + 4, a + 3))
    br = _obj_from_data(name + '_brim', Vv, Ff, _mat(brim_material or material, '#1b1b1f'), skin=None)
    _uv_flat(br)
    solidify(br, 0.008, offset=0.0)
    shade_smooth(br, 50)
    parts['brim'] = br
    if button:
        parts['button'] = sphere(M @ Vector((0, 0, H + 0.004)), radii=(R * 0.09, R * 0.09, R * 0.05),
                                 material=_mat(material, '#1b1b1f'), name=name + '_button', skin=None)
    hat = _finish_hat(parts, base=base, M=M, radius=R, height=H, band=(0.01, H * 0.5), rfun=rf, ry=ry)

    def front_rect(width=None, z0=None, z1=None):
        w = width or R * 1.25
        p0 = M @ Vector((0, 0, z0 if z0 is not None else H * 0.2))
        p1 = M @ Vector((0, 0, z1 if z1 is not None else H * 0.78))
        return (p0.x - w / 2, p0.x + w / 2, p0.z, p1.z)
    hat.front_rect = front_rect
    return hat


def hat_beanie(radius=None, height=None, cuff=True, pompom=False, material=None, cuff_material=None,
               fit='seat', sink=0.0, offset=(0, 0), tilt=-6.0, segs=48, name='Beanie', ry=1.06, knit=True):
    """Knit beanie: soft tall dome, rolled cuff band, optional pompom. Default radius = hat_radius,
    height = 0.95 * radius."""
    m = measure()
    R = radius or m['hat_radius']
    H = height or R * 0.95
    M, base = _hat_place(R, R, ry=ry, fit=fit, sink=sink, offset=offset, tilt=tilt)
    prof = [(0.0, 0.0), (R * 0.98, 0.0)]
    for k in range(0, 15):
        th = (math.pi / 2) * k / 14
        prof.append((R * math.cos(th) ** 0.7, H * math.sin(th) ** 0.9))
    prof[-1] = (0.0, H)
    rf = lambda h: R * max(0.0, 1 - (h / H) ** 1.8) ** 0.35
    kn = (lambda x, y, z: (x * (1 + 0.012 * math.sin(math.atan2(x, -y) * 40)), y * (1 + 0.012 * math.sin(math.atan2(x, -y) * 40)), z)) if knit else None
    parts = {'crown': _lathe_obj(name + '_crown', prof, segs * 2 if knit else segs, M, sy=ry, deform=kn,
                                 material=_mat(material, '#8b1e2d'))}
    if cuff:
        ch = H * 0.3
        parts['band'] = _lathe_obj(name + '_cuff', [(R * 0.99, -0.004), (R * 1.07, 0.0), (R * 1.09, ch * 0.5),
                                                     (R * 1.05, ch), (rf(ch) * 0.98, ch + 0.004)], segs, M, sy=ry,
                                   closed=False, material=_mat(cuff_material or material, '#8b1e2d'))
    if pompom:
        parts['pompom'] = sphere(M @ Vector((0, 0, H + R * 0.2)), R * 0.3, material=_mat(cuff_material or material),
                                 name=name + '_pompom', skin=None)
        displace(parts['pompom'], R * 0.04, freq=120)
    return _finish_hat(parts, base=base, M=M, radius=R, height=H, band=(0.0, H * 0.3), rfun=rf, ry=ry)


# ============================================================================ bones
def _verify_rest(tol=1e-5):
    arm = _S['arm']
    worst = 0.0
    for n, M0 in _S['rest'].items():
        M1 = arm.matrix_world @ arm.data.bones[n].matrix_local
        d = max(abs(M0[i][j] - M1[i][j]) for i in range(4) for j in range(4))
        worst = max(worst, d)
        if d > tol:
            raise RuntimeError('rest pose of base bone %r changed by %.2e - costumes must not edit base bones' % (n, d))
    return worst


def _edit_bones(fn):
    arm = _S['arm']
    _object_mode()
    bpy.ops.object.select_all(action='DESELECT')
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    try:
        fn(arm.data.edit_bones, arm.matrix_world.inverted())
    finally:
        bpy.ops.object.mode_set(mode='OBJECT')
    _verify_rest()


def add_prop_bone(name, parent_bone, head, tail, roll=0.0):
    """Add ONE extra bone (world head/tail) parented to an existing bone (role or name, e.g.
    'leftHand'). Use for rigid held props (skin_rigid(obj, name)) or stiff single springs.
    Existing bones are never modified (verified). Returns the bone name."""
    pb = bone(parent_bone)
    if pb is None:
        raise RuntimeError('add_prop_bone: parent %r not found' % parent_bone)

    def fn(eb, inv):
        if name in eb:
            raise RuntimeError('bone %r already exists' % name)
        b = eb.new(name)
        b.head, b.tail = inv @ Vector(head), inv @ Vector(tail)
        if (b.tail - b.head).length < 1e-4:
            b.tail = b.head + Vector((0, 0, 0.02))
        b.roll = roll
        b.parent = eb[pb]
        b.use_connect = False
        b.use_deform = True
    _edit_bones(fn)
    _S['extra'].append(name)
    _S['bone_cls'][name] = _S['bone_cls'].get(pb, 'torso')
    return name


def add_bone_chain(names, parent_bone, points):
    """Add a chain of len(names) connected bones through len(names)+1 world points, the first parented
    to `parent_bone`. Name them with a spring keyword (feather/tail/ribbon/sash/tie/chain/pendant/
    antenna/hat/tassel/strap) to get runtime spring physics. Returns the names."""
    if len(points) != len(names) + 1:
        raise ValueError('add_bone_chain: need len(names)+1 points')
    pb = bone(parent_bone)
    if pb is None:
        raise RuntimeError('add_bone_chain: parent %r not found' % parent_bone)

    def fn(eb, inv):
        prev = eb[pb]
        for i, n in enumerate(names):
            if n in eb:
                raise RuntimeError('bone %r already exists' % n)
            b = eb.new(n)
            b.head, b.tail = inv @ Vector(points[i]), inv @ Vector(points[i + 1])
            b.roll = 0.0
            b.parent = prev
            b.use_connect = i > 0
            b.use_deform = True
            prev = b
    _edit_bones(fn)
    for n in names:
        _S['extra'].append(n)
        _S['bone_cls'][n] = _S['bone_cls'].get(pb, 'torso')
    return list(names)


# ============================================================================ skinning
def _ensure_bound(ob):
    arm = _S['arm']
    if ob.parent != arm:
        mw = ob.matrix_world.copy()
        ob.parent = arm
        ob.matrix_parent_inverse = arm.matrix_world.inverted()
        ob.matrix_world = mw
    if not any(m.type == 'ARMATURE' for m in ob.modifiers):
        ob.modifiers.new('Armature', 'ARMATURE').object = arm


def _write_weights(ob, wlist, limit=4):
    for g in list(ob.vertex_groups):
        ob.vertex_groups.remove(g)
    groups = {}
    for i, w in enumerate(wlist):
        items = sorted(((k, x) for k, x in w.items() if x > 1e-4), key=lambda kv: -kv[1])[:limit]
        s = sum(x for _, x in items)
        if s <= 0:
            continue
        for k, x in items:
            groups.setdefault(k, {}).setdefault(round(x / s, 4), []).append(i)
    for k, byw in groups.items():
        vg = ob.vertex_groups.new(name=k)
        for x, idx in byw.items():
            vg.add(idx, x, 'REPLACE')
    _ensure_bound(ob)
    ob['kit_skin'] = json.dumps(None)


def _read_weights(ob):
    names = {g.index: g.name for g in ob.vertex_groups}
    return [{names[g.group]: g.weight for g in v.groups if g.weight > 0} for v in ob.data.vertices]


def _smooth_weights(ob, wl, iters):
    if iters <= 0:
        return wl
    me = ob.data
    nb = [[] for _ in me.vertices]
    for e in me.edges:
        a, b = e.vertices
        nb[a].append(b)
        nb[b].append(a)
    for _ in range(iters):
        new = []
        for i, w in enumerate(wl):
            acc = dict(w)
            for j in nb[i]:
                for k, x in wl[j].items():
                    acc[k] = acc.get(k, 0) + x
            s = sum(acc.values())
            new.append({k: x / s for k, x in acc.items()} if s else w)
        wl = new
    return wl


def skin_to_body(ob, exclude=None, only=None, smooth=0, limit=4):
    """Skin `ob` from the base body: each vertex takes the barycentric-interpolated weights of the
    NEAREST body surface point (nearest-face-interpolated data transfer). exclude / only: body parts
    to ignore / use ('arms', 'legs', 'limbs', 'head', 'torso', 'arm_L', ...). Excluding arms for coats
    and robes stops the torso cloth from following the hands. smooth: weight-blur iterations."""
    d = _S['data']
    cls = {'torso', 'head', 'arm_L', 'arm_R', 'leg_L', 'leg_R'}
    if only:
        cls = _classes(only)
    cls -= _classes(exclude)
    bvh, idx = _bvh(cls)
    if bvh is None:
        raise RuntimeError('skin_to_body: no body faces left after exclude/only')
    mw = ob.matrix_world
    out = []
    for v in ob.data.vertices:
        p = mw @ v.co
        loc, n, ti, dist = bvh.find_nearest(p)
        tri = d['tris'][idx[ti]]
        A, B, C = (d['V'][i] for i in tri)
        l = _bary(loc, A, B, C)
        w = {}
        for lam, vi in zip(l, tri):
            for k, x in d['W'][vi].items():
                w[k] = w.get(k, 0) + lam * x
        out.append(w)
    out = _smooth_weights(ob, out, smooth)
    _write_weights(ob, out, limit)
    return ob


def _bary(p, a, b, c):
    v0, v1, v2 = b - a, c - a, p - a
    d00, d01, d11 = v0.dot(v0), v0.dot(v1), v1.dot(v1)
    d20, d21 = v2.dot(v0), v2.dot(v1)
    den = d00 * d11 - d01 * d01
    if abs(den) < 1e-14:
        return (1 / 3, 1 / 3, 1 / 3)
    v = (d11 * d20 - d01 * d21) / den
    w = (d00 * d21 - d01 * d20) / den
    u = 1 - v - w
    l = [max(0.0, u), max(0.0, v), max(0.0, w)]
    s = sum(l) or 1
    return [x / s for x in l]


def skin_rigid(ob, bone_name):
    """100% weight to one bone (hats -> 'hat'/'head', held props -> their prop bone, rings -> hand)."""
    b = bone(bone_name) or bone_name
    if b not in _S['arm'].data.bones:
        raise RuntimeError('skin_rigid: no bone %r' % bone_name)
    _write_weights(ob, [{b: 1.0}] * len(ob.data.vertices))
    return ob


def skin_follow(ob, point=None, exclude=None):
    """Rigidly follow the body at `point` (default: object centre): every vertex gets the body weights
    of the nearest surface point there. Pouches, badges, buckles: move with the body, never shear."""
    d = _S['data']
    cls = {'torso', 'head', 'arm_L', 'arm_R', 'leg_L', 'leg_R'} - _classes(exclude)
    bvh, idx = _bvh(cls)
    mw = ob.matrix_world
    if point is None:
        cs = [mw @ v.co for v in ob.data.vertices]
        point = sum(cs, Vector()) / max(len(cs), 1)
    loc, n, ti, dist = bvh.find_nearest(Vector(point))
    tri = d['tris'][idx[ti]]
    l = _bary(loc, *(d['V'][i] for i in tri))
    w = {}
    for lam, vi in zip(l, tri):
        for k, x in d['W'][vi].items():
            w[k] = w.get(k, 0) + lam * x
    _write_weights(ob, [w] * len(ob.data.vertices))
    return ob


def skin_blend(ob, fn):
    """Custom weights: fn(world_co: Vector) -> {bone_name: weight}. Normalised, max 4 influences."""
    mw = ob.matrix_world
    _write_weights(ob, [fn(mw @ v.co) for v in ob.data.vertices])
    return ob


def skin_along(ob, chain_bones, root=None, blend=0.35, root_until=None):
    """Weight a dangling object (feather, tail, necklace, sash end, antenna) along a bone chain: each
    vertex is assigned to the chain bone whose segment is closest, blended across joints; vertices
    before the chain's start (or within root_until metres of it) go to `root` (default: the chain's
    parent). Use after add_bone_chain."""
    arm = _S['arm']
    bs = [arm.data.bones[b] for b in chain_bones]
    root = bone(root) if root else (bs[0].parent.name if bs[0].parent else bs[0].name)
    segs = [(arm.matrix_world @ b.head_local, arm.matrix_world @ b.tail_local) for b in bs]

    def fn(p):
        best = []
        for i, (a, b) in enumerate(segs):
            ab = b - a
            t = max(-0.5, min(1.5, (p - a).dot(ab) / max(ab.length_squared, 1e-12)))
            q = a + ab * max(0.0, min(1.0, t))
            best.append(((p - q).length, i, t))
        dist, i, t = min(best)
        w = {}
        if i == 0 and t < 0 or (root_until is not None and i == 0 and t * (segs[0][1] - segs[0][0]).length < root_until):
            k = smoothstep(-0.35, 0.05, t) if root_until is None else 0.0
            w[root] = 1 - k * 0.5
            w[bs[0].name] = k * 0.5
            return w
        w[bs[i].name] = 1.0
        if t > 1 - blend and i + 1 < len(bs):
            k = smoothstep(1 - blend, 1 + blend, t) * 0.5
            w[bs[i].name] = 1 - k
            w[bs[i + 1].name] = k
        elif t < blend:
            prev = bs[i - 1].name if i > 0 else root
            k = smoothstep(blend, -blend, t) * 0.5
            w[bs[i].name] = 1 - k
            w[prev] = k
        return w
    return skin_blend(ob, fn)


def clean_weights(ob, limit=4, threshold=0.01):
    """Normalise, drop tiny weights, keep at most `limit` influences per vertex."""
    wl = _read_weights(ob)
    wl = [{k: x for k, x in w.items() if x >= threshold} or w for w in wl]
    _write_weights(ob, wl, limit)
    return ob


def _auto_skin(ob):
    spec = ob.get('kit_skin')
    spec = json.loads(spec) if isinstance(spec, str) else spec
    has = bool(ob.vertex_groups) and any(len(v.groups) for v in ob.data.vertices)
    if spec is None and has:
        return
    if isinstance(spec, dict):
        mode = spec.get('mode')
        if mode == 'rigid':
            return skin_rigid(ob, spec['bone'])
        if mode == 'body':
            return skin_to_body(ob, exclude=spec.get('exclude'), smooth=spec.get('smooth', 0))
    if spec == 'follow':
        return skin_follow(ob)
    if isinstance(spec, list) and spec and spec[0] == 'rigid':
        return skin_rigid(ob, spec[1])
    if has:
        return
    return skin_to_body(ob, exclude=['arms'], smooth=2)


# ============================================================================ labels
def label_face(ob, material_name, rect, direction='front', text='', color='#111111', background='#ffffff',
               font=None, min_facing=0.25):
    """Turn the part of `ob` inside the front-view rect (a0, a1, z0, z1) into a label: the mesh is cut
    along the rect, the faces inside that face the viewer get a new material `material_name` with UVs
    spanning exactly 0..1 (u left->right in reading direction, v bottom->top), default text baked.
    Registers a CostumeLabel (see labels()). Returns the label aspect (width / height)."""
    a0, a1, z0, z1 = rect
    out, right, up = _plane_axes(direction)
    aspect = (a1 - a0) / max(z1 - z0, 1e-6)
    mat = label_material(material_name, text, color, background, font, aspect)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    mw = ob.matrix_world
    inv = mw.inverted()
    for co, no in ((right * a0, right), (right * a1, right), (up * z0, up), (up * z1, up)):
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], dist=1e-6,
                               plane_co=inv @ co, plane_no=(inv.to_3x3() @ no).normalized())
    bm.normal_update()
    if mat.name not in [m.name for m in ob.data.materials if m]:
        ob.data.materials.append(mat)
    mi = [m.name for m in ob.data.materials].index(mat.name)
    uvl = bm.loops.layers.uv.verify()
    n3 = mw.to_3x3()
    cnt = 0
    for f in bm.faces:
        c = mw @ f.calc_center_median()
        a, z = c.dot(right), c.dot(up)
        nrm = (n3 @ f.normal).normalized()
        if a0 <= a <= a1 and z0 <= z <= z1 and nrm.dot(out) > min_facing:
            f.material_index = mi
            cnt += 1
            for l in f.loops:
                p = mw @ l.vert.co
                l[uvl].uv = ((p.dot(right) - a0) / (a1 - a0), (p.dot(up) - z0) / (z1 - z0))
    bm.to_mesh(ob.data)
    bm.free()
    if not cnt:
        log('WARNING label_face: no faces of %s inside rect %s' % (ob.name, rect))
    _S['labels'] = [l for l in _S['labels'] if l['material'] != mat.name]
    _S['labels'].append(dict(material=mat.name, text=text, color=color, background=background,
                             font=font_css(font), aspect=round(aspect, 3)))
    return aspect


def label_panel(material_name, x0, x1, z0, z1, text='', color='#111111', background='#ffffff', font=None,
                offset=0.004, target=None, direction='front', thickness=0.0, nx=24, nz=8, name=None):
    """New label patch lying on the body / `target` (sign boards, chest prints, name tapes): a panel()
    with a label material, UV 0..1. Returns the object (aspect = (x1-x0)/(z1-z0))."""
    aspect = (x1 - x0) / max(z1 - z0, 1e-6)
    mat = label_material(material_name, text, color, background, font, aspect)
    ob = panel(x0, x1, z0, z1, offset=offset, direction=direction, target=target, nx=nx, nz=nz,
               thickness=thickness, material=mat, name=name or material_name)
    _S['labels'] = [l for l in _S['labels'] if l['material'] != mat.name]
    _S['labels'].append(dict(material=mat.name, text=text, color=color, background=background,
                             font=font_css(font), aspect=round(aspect, 3)))
    return ob


def font_css(font):
    return {'impact': "900 Impact", 'marker': "700 'Permanent Marker', 'Comic Sans MS', cursive",
            'stencil': "900 'Stencil', Impact", 'regular': "400 Arial, sans-serif"}.get(font or 'bold',
                                                                                        "700 Arial, sans-serif")


def labels():
    """CostumeLabel dicts registered by label_face / label_panel (for write_costume_def)."""
    return [dict(l) for l in _S['labels']]


# ============================================================================ wear other costumes (previews)
def wear(glb_path):
    """Import another costume GLB onto the current base (for combined previews / tests): its meshes
    are re-bound to the base armature; its extra bones are recreated. Returns its mesh objects
    (NOT registered for export)."""
    before = set(bpy.data.objects)
    try:
        bpy.ops.import_scene.gltf(filepath=glb_path, bone_heuristic='BLENDER', disable_bone_shape=True)
    except TypeError:
        bpy.ops.import_scene.gltf(filepath=glb_path, bone_heuristic='BLENDER')
    new = [o for o in bpy.data.objects if o not in before]
    carm = [o for o in new if o.type == 'ARMATURE']
    arm = _S['arm']
    if carm:
        ca = carm[0]
        extra = [b for b in ca.data.bones if b.name not in arm.data.bones]
        spec = [(b.name, ca.matrix_world @ b.head_local, ca.matrix_world @ b.tail_local,
                 b.parent.name if b.parent else None) for b in extra]
        if spec:
            def fn(eb, inv):
                for n, h, t, p in spec:
                    b = eb.new(n)
                    b.head, b.tail = inv @ h, inv @ t
                    if p and p in eb:
                        b.parent = eb[p]
            _edit_bones(fn)
    meshes = [o for o in new if o.type == 'MESH']
    for o in meshes:
        for md in o.modifiers:
            if md.type == 'ARMATURE':
                md.object = arm
        mw = o.matrix_world.copy()
        o.parent = arm
        o.matrix_parent_inverse = arm.matrix_world.inverted()
        o.matrix_world = mw
    for o in new:
        if o.type != 'MESH':
            bpy.data.objects.remove(o, do_unlink=True)
    return meshes


# ============================================================================ export
def export_costume(out_glb, objects=None, extra_bones=None, join_meshes=True, name=None, max_tris=35000,
                   fit=True, clip=True):
    """Export ONLY the costume meshes + the base armature (all bones, rest pose verified unchanged)
    to a GLB (Y-up, +Z front). objects=None -> every kit-registered object. Unskinned objects are
    auto-skinned. fit=True runs fit_to_body() on every exported mesh (a float = custom margin in
    metres, False = skip); clip=True prints a CLIP_REPORT (poke-through in test poses) after the fit.
    extra_bones is informational (all armature bones are exported anyway). Returns a report dict
    (tris, materials, extra bones, face-clear warnings, fit, clip)."""
    _object_mode()
    arm = _S['arm']
    objs = [o for o in (objects if objects is not None else _S['created']) if _alive(o) and o.type == 'MESH']
    if not objs:
        raise RuntimeError('export_costume: nothing to export')
    per = []
    for o in objs:
        apply_modifiers(o)
        _auto_skin(o)
        clean_weights(o, limit=4, threshold=0.005)
        _ensure_bound(o)
        per.append((tri_count(o), o.name))
    log('parts: ' + ', '.join('%s=%d' % (n, t) for t, n in sorted(per, reverse=True)))
    stem = name or os.path.splitext(os.path.basename(out_glb))[0]
    if join_meshes and len(objs) > 1:
        ob = join(objs, 'Costume_' + stem)
        objs = [ob]
    fit_rep = None
    if fit is not False:
        fit_rep = dict(pushed=0, tucked=0, max_push=0.0)
        for o in objs:
            r = fit_to_body(o, margin=None if fit is True else float(fit), layers=objs)
            fit_rep['pushed'] += r['pushed']
            fit_rep['tucked'] += r['tucked']
            fit_rep['max_push'] = max(fit_rep['max_push'], r['max_push'])
    clip_rep = clip_report(objs) if clip else None
    worst = _verify_rest()
    tris = sum(tri_count(o) for o in objs)
    face_hits = _face_check(objs)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs + [arm]:
        o.select_set(True)
    bpy.context.view_layer.objects.active = arm
    os.makedirs(os.path.dirname(os.path.abspath(out_glb)), exist_ok=True)
    arm.data.pose_position = 'REST'
    kw = dict(filepath=out_glb, export_format='GLB', use_selection=True, export_yup=True, export_apply=True,
              export_skins=True, export_animations=False, export_morph=False, export_materials='EXPORT',
              export_image_format='AUTO', export_cameras=False, export_lights=False)
    try:
        bpy.ops.export_scene.gltf(export_def_bones=False, **kw)
    except TypeError:
        bpy.ops.export_scene.gltf(**kw)
    arm.data.pose_position = 'POSE'
    mats = sorted({m.name for o in objs for m in o.data.materials if m})
    rep = dict(file=out_glb, tris=tris, meshes=[o.name for o in objs], materials=mats,
               extra_bones=[b for b in _S['extra'] if b in arm.data.bones], rest_worst=worst,
               face_overlap_verts=face_hits, labels=labels(), fit=fit_rep, clip=clip_rep)
    log('exported %s  tris=%d  extra bones=%s  mats=%d  rest drift=%.1e' % (
        os.path.basename(out_glb), tris, rep['extra_bones'], len(mats), worst))
    if tris > max_tris:
        log('WARNING: %d tris > %d budget' % (tris, max_tris))
    if face_hits:
        log('WARNING: %d costume vertices in front of the face box %s' % (face_hits, tuple(round(x, 3) for x in face_box())))
    print('VTP_COSTUME ' + json.dumps({k: v for k, v in rep.items() if k != 'labels'}))
    return rep


def _face_check(objs):
    """count costume vertices hovering in front of the face box (by material, for the warning)"""
    x0, x1, z0, z1 = face_box()
    m = measure()
    if m.get('eye_L') is not None:      # brims / helmets resting just above the eyes are fine
        z1 = min(z1, max(m['eye_L'].z, m['eye_R'].z) + 0.55 * m['eye_radius'])
    bvh = _torso_bvh()
    hits, by = 0, {}
    for o in objs:
        mw = o.matrix_world
        me = o.data
        vmat = {}
        for p in me.polygons:
            for vi in p.vertices:
                vmat[vi] = p.material_index
        for v in me.vertices:
            p = mw @ v.co
            if x0 < p.x < x1 and z0 < p.z < z1:
                loc = bvh.ray_cast(Vector((p.x, -5, p.z)), Vector((0, 1, 0)), 10)[0]
                if loc is not None and p.y < loc.y + 0.002:
                    hits += 1
                    mi = vmat.get(v.index, 0)
                    mn = me.materials[mi].name if mi < len(me.materials) and me.materials[mi] else '?'
                    by[mn] = by.get(mn, 0) + 1
    if hits:
        log('face box overlap by material: %s' % by)
    return hits


# ============================================================================ anti-clip: fit + clip report
def _height():
    P = _S['data']['P']
    return float(P[:, 2].max() - P[:, 2].min()) or 1.0


def _world_co(ob, mesh=None):
    me = mesh or ob.data
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', co)
    M = np.array(ob.matrix_world)
    return co.reshape(-1, 3) @ M[:3, :3].T + M[:3, 3]


def _vertex_classes(ob, cls=None):
    """per-vertex frozenset of body-part classes carrying >= 20 % of its weight (None = unskinned)."""
    cls = cls or _classify_bones(_S['arm'])
    names = {g.index: g.name for g in ob.vertex_groups}
    out = []
    for v in ob.data.vertices:
        acc = {}
        for g in v.groups:
            c = cls.get(names.get(g.group))
            if c and g.weight > 1e-4:
                acc[c] = acc.get(c, 0.0) + g.weight
        s = sum(acc.values())
        out.append(frozenset(k for k, x in acc.items() if x >= 0.2 * s) if s > 0 else None)
    return out


def _rigid_verts(ob):
    """vertex indices of connected components skinned >= 98 % to ONE bone (props, hats, buckles)."""
    me = ob.data
    n = len(me.vertices)
    if not ob.vertex_groups:
        return set(range(n))
    par = list(range(n))

    def find(x):
        while par[x] != x:
            par[x] = par[par[x]]
            x = par[x]
        return x
    for e in me.edges:
        a, b = find(e.vertices[0]), find(e.vertices[1])
        if a != b:
            par[a] = b
    comp = {}
    for v in me.vertices:
        r = find(v.index)
        best = max(v.groups, key=lambda g: g.weight, default=None)
        tot = sum(g.weight for g in v.groups)
        bone = best.group if best is not None and tot > 0 and best.weight >= 0.98 * tot else -2
        prev = comp.get(r)
        comp[r] = bone if prev is None else (prev if prev == bone else -2)
    return {v.index for v in me.vertices if comp.get(find(v.index), -2) >= 0}


def fit_to_body(obj, margin=None, layers=None, smooth=3, max_depth=0.03):
    """Push costume vertices OUT of the body (the web runtime repeats this at load for any costume;
    doing it here makes the GLB itself clean). Every vertex inside the body or closer than `margin`
    (world metres; default 0.6 % of the body height) moves outward along the body normal. The signed
    distance is remapped monotonically ([-max_depth*H, 1.5*margin] -> [margin, 1.5*margin]) so stacked
    layers keep their order, then the displacement is smoothed over mesh neighbours (`smooth` passes,
    pushed minimums re-enforced) so nothing dents. Left alone on purpose: rigid components (props /
    hats / buckles skinned 100 % to one bone), vertices buried deeper than max_depth*H (canes through
    hands), vertices covered by ANOTHER costume layer (`layers`, default every kit-made object:
    sleeve caps tucked under the shirt, trouser tops under a coat), and body parts skinned
    differently (torso cloth crossing a hanging arm is a pose overlap, not a fit error).
    Call it after skinning (export_costume does, for every exported mesh). Returns
    {'pushed', 'tucked', 'max_push'}."""
    _object_mode()
    d = _S['data']
    H = _height()
    margin = 0.006 * H if margin is None else float(margin)
    rep = dict(pushed=0, tucked=0, max_push=0.0)
    if margin <= 0 or obj.type != 'MESH' or not len(obj.data.vertices):
        return rep
    depth, fade, hi = max_depth * H, 0.5 * max_depth * H, 1.5 * margin
    layers = [o for o in (layers if layers is not None else _S['created']) if _alive(o) and o.type == 'MESH']
    if obj not in layers:
        layers = layers + [obj]
    lv, lp = [], []
    for o in layers:
        co = _world_co(o)
        base = len(lv)
        lv.extend(Vector(c) for c in co)
        lp.extend(tuple(base + i for i in p.vertices) for p in o.data.polygons)
    layer_bvh = BVHTree.FromPolygons(lv, lp)
    rigid = _rigid_verts(obj)
    vcls = _vertex_classes(obj)
    N = d['N']
    W = _world_co(obj)
    n = len(W)
    D = np.zeros((n, 3))
    Nd = np.zeros((n, 3))
    req = np.zeros(n)
    cache = {}
    for i in range(n):
        if i in rigid:
            continue
        key = vcls[i]
        if key not in cache:
            cache[key] = _bvh(set(key) if key else None)
        bvh, idx = cache[key]
        if bvh is None:
            continue
        p = Vector(W[i])
        loc, fn, ti, dist = bvh.find_nearest(p, depth + fade)
        if loc is None:
            continue
        tri = d['tris'][idx[ti]]
        A, B, C = (d['V'][k] for k in tri)
        lam = _bary(loc, A, B, C)
        nv = Vector()
        for k, l in zip(tri, lam):
            nv += N[k] * l
        nv = nv.normalized() if nv.length > 1e-9 else fn
        sd = (p - loc).dot(nv)
        if sd >= hi:
            continue
        if sd >= -depth:
            delta = margin + (sd + depth) / (hi + depth) * (hi - margin) - sd
        elif sd >= -depth - fade:
            delta = (margin + depth) * (sd + depth + fade) / fade
        else:
            continue
        if delta <= 1e-7:
            continue
        if layer_bvh.ray_cast(p + nv * 1.5e-3 * H, nv, depth + 0.04 * H)[0] is not None:
            rep['tucked'] += 1
            continue
        Nd[i] = tuple(nv)
        req[i] = delta
        D[i] = Nd[i] * delta
    if not req.any():
        return rep
    nb = [[] for _ in range(n)]
    for e in obj.data.edges:
        a, b = e.vertices
        nb[a].append(b)
        nb[b].append(a)
    active = np.array([i not in rigid for i in range(n)])
    nb = [np.array([j for j in js if active[j]], dtype=int) for js in nb]
    for _ in range(max(0, smooth)):
        new = D.copy()
        for i in range(n):
            if not active[i]:
                continue
            js = nb[i]
            v = (D[i] + D[js].sum(axis=0)) / (1 + len(js)) if len(js) else D[i]
            if req[i] > 0:
                along = v.dot(Nd[i])
                if along < req[i]:
                    v = v + Nd[i] * (req[i] - along)
            new[i] = v
        D = new
    inv = obj.matrix_world.inverted().to_3x3()
    for v in obj.data.vertices:
        dv = D[v.index]
        if abs(dv).sum() > 1e-9:
            v.co += inv @ Vector(tuple(dv))
    obj.data.update()
    rep['pushed'] = int((req > 1e-4 * H).sum())
    rep['max_push'] = round(float(req.max()), 4)
    log('fit_to_body %s: pushed %d verts (max %.1f mm), %d tucked under other layers' % (
        obj.name, rep['pushed'], rep['max_push'] * 1000, rep['tucked']))
    return rep


CLIP_POSES = (
    ('head_yaw_L', dict(head_yaw=25)),
    ('head_yaw_R', dict(head_yaw=-25)),
    ('arms_up', dict(arms_raise=70)),
    ('elbows', dict(elbow_bend=30)),
    ('lean', dict(spine_bend=20)),
    ('combo', dict(head_yaw=25, arms_raise=70, elbow_bend=30, spine_bend=15)),
)


def _evaluated(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = ev.to_mesh()
    co = _world_co(ob, me)
    nr = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('normal', nr)
    nm = np.array(ob.matrix_world.to_3x3().inverted_safe().transposed())
    nr = nr.reshape(-1, 3) @ nm.T
    nr /= np.maximum(np.linalg.norm(nr, axis=1, keepdims=True), 1e-12)
    polys = [tuple(p.vertices) for p in me.polygons]
    ev.to_mesh_clear()
    return co, nr, polys


def clip_report(objs=None, poses=CLIP_POSES, max_dist=0.04, verbose=True):
    """Pose the base through test poses (head yaw +-25, arms raised 70, elbows bent 30, spine lean,
    and a combo) and count POKE-THROUGH: body vertices the costume covers at rest (a ray along the
    body normal hits costume skinned to the same body part within max_dist * height) that are no
    longer covered in the pose. Prints `CLIP_REPORT {json}` and returns
    {'covered': n, 'poses': {name: count}, 'total': n, 'worst': name}. A few dozen per pose is
    normal (hems sliding); hundreds means a garment is too tight or skinned to the wrong part."""
    _object_mode()
    objs = [o for o in (objs if objs is not None else _S['created']) if _alive(o) and o.type == 'MESH']
    H = _height()
    R = max_dist * H
    cls = _classify_bones(_S['arm'])
    ccls = []
    for o in objs:
        ccls.extend(_vertex_classes(o, cls))
    bcls = [frozenset((c,)) for c in _S['data']['C']]

    def snapshot():
        cv, cp, off = [], [], 0
        for o in objs:
            co, _, polys = _evaluated(o)
            cv.extend(Vector(tuple(c)) for c in co)
            cp.extend(tuple(off + i for i in p) for p in polys)
            off += len(co)
        bv, bn = [], []
        for o in _S['bodies']:
            co, nr, _ = _evaluated(o)
            bv.append(co)
            bn.append(nr)
        return BVHTree.FromPolygons(cv, cp), cp, np.concatenate(bv), np.concatenate(bn)

    def covered_by(bvh, cp, p, n, bc):
        loc, _, fi, _ = bvh.ray_cast(Vector(tuple(p)) + Vector(tuple(n)) * 1e-4 * H, Vector(tuple(n)), R)
        if loc is None:
            return False
        if bc is None:
            return True
        return any(ccls[k] is None or (ccls[k] & bc) for k in cp[fi])

    arm = _S['arm']
    was = arm.data.pose_position
    arm.data.pose_position = 'POSE'
    reset_pose()
    bvh, cp, BV, BN = snapshot()
    covered = [i for i in range(len(BV)) if covered_by(bvh, cp, BV[i], BN[i], bcls[i] if i < len(bcls) else None)]
    out = dict(covered=len(covered), poses={})
    for name, kw in poses:
        pose(**kw)
        bvh, cp, BV, BN = snapshot()
        out['poses'][name] = sum(1 for i in covered if not covered_by(bvh, cp, BV[i], BN[i], None))
        reset_pose()
    arm.data.pose_position = was
    out['total'] = sum(out['poses'].values())
    out['worst'] = max(out['poses'], key=out['poses'].get) if out['poses'] else None
    if verbose:
        print('CLIP_REPORT ' + json.dumps(out), flush=True)
    return out


# ============================================================================ posing / preview
def pose(head_yaw=0.0, head_pitch=0.0, arms_raise=0.0, elbow_bend=0.0, spine_bend=0.0, legs_spread=0.0,
         bones=None):
    """Pose the base for deformation tests (degrees). head_yaw turns the head (+ = to the character's
    left), arms_raise lifts both upper arms sideways, elbow_bend bends forearms forward, spine_bend
    leans forward. bones = {name: (axis 'X'|'Y'|'Z', degrees)} for anything else (world axes,
    rotated about the bone head). Call reset_pose() afterwards."""
    arm = _S['arm']
    arm.data.pose_position = 'POSE'
    pb = arm.pose.bones

    def rot(bn, axis, deg):
        b = bone(bn)
        if not b or not deg:
            return
        bpy.context.view_layer.update()
        piv = arm.matrix_world @ pb[b].head
        R = Matrix.Rotation(math.radians(deg), 4, axis)
        Mx = Matrix.Translation(piv) @ R @ Matrix.Translation(-piv)
        pb[b].matrix = arm.matrix_world.inverted() @ Mx @ arm.matrix_world @ pb[b].matrix
        bpy.context.view_layer.update()
    rot('spine', 'X', spine_bend * 0.5)
    rot('chest', 'X', spine_bend * 0.5)
    rot('head', 'Z', head_yaw)
    rot('head', 'X', -head_pitch)
    rot('leftUpperArm', 'Y', -arms_raise)
    rot('rightUpperArm', 'Y', arms_raise)
    rot('leftLowerArm', 'X', elbow_bend)
    rot('rightLowerArm', 'X', elbow_bend)
    rot('leftUpperLeg', 'Y', -legs_spread)
    rot('rightUpperLeg', 'Y', legs_spread)
    for bn, (axis, deg) in (bones or {}).items():
        rot(bn, axis, deg)


def reset_pose():
    for pb in _S['arm'].pose.bones:
        pb.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()


def _preview_rig(eyes=True, sclera=None):
    """temporary eye bulbs (profile markers) so previews show the face like the runtime does"""
    tmp = []
    pr = _S.get('profile') or {}
    e = pr.get('eyes') or {}
    if not eyes:
        return tmp
    sc = sclera or e.get('scleraColor', '#ffffff')
    msc = bpy.data.materials.get('_prev_sclera') or material('_prev_sclera', sc, roughness=0.3)
    msc.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = hex2lin(sc) + (1,)
    mpu = material('_prev_pupil', e.get('irisColor', '#111111'), roughness=0.2)
    hc = measure()['head_center']
    for c, r in _eye_spheres():
        r = r / 1.12
        n = (c - hc).normalized()
        n = Vector((n.x * 0.35, -1, n.z * 0.3)).normalized()
        s = sphere(c, r, material=msc, name='_eye', skin=None)
        p = sphere(c + n * r * 0.72, radii=(r * 0.38, r * 0.3, r * 0.42), material=mpu, name='_pupil', skin=None)
        for o in (s, p):
            _S['created'].remove(o)
            skin_rigid(o, 'head')
            tmp.append(o)
    return tmp


def _outline_on(objs, width=0.0075):
    om = bpy.data.materials.get('_prev_outline')
    if om is None:
        om = bpy.data.materials.new('_prev_outline')
        try:
            om.use_nodes = True
        except Exception:
            pass
        nt = om.node_tree
        nt.nodes.remove(nt.nodes.get('Principled BSDF'))
        em = nt.nodes.new('ShaderNodeEmission')
        em.inputs['Color'].default_value = (0.02, 0.02, 0.025, 1)
        nt.links.new(em.outputs[0], nt.nodes['Material Output'].inputs[0])
        om.use_backface_culling = True
    for o in objs:
        o.data.materials.append(om)
        so = o.modifiers.new('_prev_outline', 'SOLIDIFY')
        so.thickness = width
        so.offset = 1.0
        so.use_flip_normals = True
        so.use_rim = False
        so.material_offset = len(o.data.materials) - 1
        so.material_offset_rim = len(o.data.materials) - 1   # appended after Armature -> follows the pose


def _outline_off(objs):
    for o in objs:
        md = o.modifiers.get('_prev_outline')
        if md:
            o.modifiers.remove(md)
        if o.data.materials and o.data.materials[-1] and o.data.materials[-1].name == '_prev_outline':
            o.data.materials.pop()


def _setup_render(w, h):
    sc = _scene()
    try:
        sc.render.engine = 'BLENDER_EEVEE'
    except TypeError:
        sc.render.engine = 'BLENDER_EEVEE_NEXT'
    try:
        sc.eevee.taa_render_samples = 24
    except Exception:
        pass
    sc.render.film_transparent = True
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGBA'
    sc.view_settings.view_transform = 'Standard'
    sc.render.resolution_x, sc.render.resolution_y = w, h
    sc.render.resolution_percentage = 100
    if sc.world is None:
        sc.world = bpy.data.worlds.new('W')
    try:
        sc.world.use_nodes = True
    except Exception:
        pass
    bg = sc.world.node_tree.nodes.get('Background')
    bg.inputs['Color'].default_value = (1, 1, 1, 1)
    bg.inputs['Strength'].default_value = 0.7
    if '_prev_sun' not in bpy.data.objects:
        sd = bpy.data.lights.new('_prev_sun', 'SUN')
        sd.energy = 1.1
        sun = _link(bpy.data.objects.new('_prev_sun', sd))
        sun.rotation_euler = (math.radians(50), 0, math.radians(-25))
    if '_prev_cam' not in bpy.data.objects:
        cd = bpy.data.cameras.new('_prev_cam')
        cd.type = 'ORTHO'
        _link(bpy.data.objects.new('_prev_cam', cd))
    cam = bpy.data.objects['_prev_cam']
    sc.camera = cam
    return cam


def _visible_bbox(objs):
    dg = bpy.context.evaluated_depsgraph_get()
    lo = Vector((1e9, 1e9, 1e9))
    hi = -lo
    for o in objs:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        for v in me.vertices:
            p = o.matrix_world @ v.co
            lo = Vector(map(min, lo, p))
            hi = Vector(map(max, hi, p))
        ev.to_mesh_clear()
    return lo, hi


def _shoot(path, yaw, w, h, objs, pad=1.08):
    cam = _setup_render(w, h)
    lo, hi = _visible_bbox(objs)
    c = (lo + hi) / 2
    a = math.radians(yaw)
    half_w = max(hi.x - lo.x, hi.y - lo.y) / 2
    ortho = max((hi.z - lo.z) * pad, 2 * half_w * pad * h / w)
    cam.data.ortho_scale = ortho * max(1.0, w / h)
    cam.location = (c.x + 6 * math.sin(a), c.y - 6 * math.cos(a), c.z)
    cam.rotation_euler = (math.radians(90), 0, a)
    _scene().render.filepath = path
    bpy.ops.render.render(write_still=True)


def _load_px(path):
    im = bpy.data.images.load(path, check_existing=False)
    arr = np.array(im.pixels[:], dtype=np.float32).reshape(im.size[1], im.size[0], 4)
    bpy.data.images.remove(im)
    return arr


def _save_px(path, arr):
    h, w = arr.shape[:2]
    im = bpy.data.images.new('_cmp', w, h, alpha=True)
    im.pixels.foreach_set(arr.ravel().astype(np.float32))
    im.filepath_raw = path
    im.file_format = 'PNG'
    im.save()
    bpy.data.images.remove(im)


def _render_objs(base_visible, objects):
    objs = [o for o in (objects or _S['created']) if _alive(o) and o.type == 'MESH']
    bodies = [o for o in _S['bodies'] if _alive(o)]
    worn = [o for o in bpy.data.objects if o.type == 'MESH' and o not in objs and o not in bodies and
            o.parent == _S['arm'] and not o.name.startswith('_')]
    for o in bodies:
        o.hide_render = not base_visible
    return objs + worn + (bodies if base_visible else [])


def render_preview(out_png, base_visible=True, objects=None, views=(0, 35), size=(720, 960), eyes=True,
                   sclera=None, outline=True):
    """Render front + three-quarter (yaw 35) side by side into one transparent PNG (Eevee, toon-ish
    inverted-hull outline, procedural eye bulbs from the profile). objects = what to show besides the
    base (default: all kit objects). views = yaw angles in degrees."""
    out_png = os.path.abspath(out_png)
    objs = _render_objs(base_visible, objects)
    tmp = _preview_rig(eyes, sclera)
    show = objs + tmp
    if outline:
        _outline_on(show)
    paths = []
    for i, yaw in enumerate(views):
        p = os.path.join(os.path.dirname(os.path.abspath(out_png)), '_view%d.png' % i)
        _shoot(p, yaw, size[0], size[1], show)
        paths.append(p)
    if outline:
        _outline_off(show)
    for o in tmp:
        bpy.data.objects.remove(o, do_unlink=True)
    imgs = [_load_px(p) for p in paths]
    for p in paths:
        os.remove(p)
    _save_px(out_png, np.concatenate(imgs, 1))
    for o in _S['bodies']:
        o.hide_render = False
    log('preview', out_png)
    return out_png


def render_thumb(out_png, size=512, base_visible=True, objects=None, yaw=0, eyes=True, sclera=None):
    """Square front thumbnail (library / wardrobe tile)."""
    objs = _render_objs(base_visible, objects)
    tmp = _preview_rig(eyes, sclera)
    show = objs + tmp
    _outline_on(show, 0.009)
    _shoot(os.path.abspath(out_png), yaw, size, size, show, pad=1.04)
    _outline_off(show)
    for o in tmp:
        bpy.data.objects.remove(o, do_unlink=True)
    for o in _S['bodies']:
        o.hide_render = False
    log('thumb', out_png)
    return out_png


# ============================================================================ profile helpers
def write_costume_def(id, name, file, thumbnail=None, hides=None, eyes=None, labels=None, prompt=None,
                      source='builtin'):
    """CostumeDef dict (shared/types.ts): {id, name, file, thumbnail?, hides, eyes?, labels?, prompt?,
    source?}. file/thumbnail are relative to the avatar folder (e.g. 'costumes/pimp.glb')."""
    d = {'id': id, 'name': name, 'file': file}
    if thumbnail:
        d['thumbnail'] = thumbnail
    d['hides'] = list(hides or [])
    if eyes:
        d['eyes'] = dict(eyes)
    if labels:
        d['labels'] = [dict(l) for l in labels]
    if prompt:
        d['prompt'] = prompt
    if source:
        d['source'] = source
    return d


def add_to_profile(profile_path, costume_def, activate=False):
    """Insert / replace a CostumeDef (by id) in an AvatarProfile json; every other field untouched."""
    with open(profile_path, encoding='utf-8') as f:
        pr = json.load(f)
    cs = [c for c in pr.get('costumes', []) if c.get('id') != costume_def['id']]
    cs.append(costume_def)
    pr['costumes'] = cs
    if activate:
        pr['costume'] = costume_def['id']
    pr.setdefault('costume', None)
    with open(profile_path, 'w', encoding='utf-8') as f:
        json.dump(pr, f, indent=2)
    return pr
