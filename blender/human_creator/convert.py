"""
MPFB character -> VTube Pro conventions:
  * helper geometry / clothes delete-masks / subdivision modifiers removed (shape keys kept)
  * game_engine bones renamed to VRM humanoid names (hips, spine, chest, upperChest, neck, head, leftShoulder,
    leftUpperArm, ..., leftIndexProximal ..., leftUpperLeg, leftLowerLeg, leftFoot, leftToes) + leftEye/rightEye
    bones at the eyeball centres, the eyeball proxy rigidly skinned to them (gaze = bone rotation)
  * friendly object names (Body, Eyes, Eyebrows, Eyelashes, Teeth, Tongue, Hair, Outfit_*, Costume_<id>_*)
"""
import os

import bmesh
import bpy
import numpy as np
from mathutils import Vector

from .face import coords, group_weights

BONES = {
    'pelvis': 'hips', 'spine_01': 'spine', 'spine_02': 'chest', 'spine_03': 'upperChest', 'neck_01': 'neck', 'head': 'head',
}
for s, S in (('l', 'left'), ('r', 'right')):
    BONES.update({
        'clavicle_' + s: S + 'Shoulder', 'upperarm_' + s: S + 'UpperArm', 'lowerarm_' + s: S + 'LowerArm', 'hand_' + s: S + 'Hand',
        'thigh_' + s: S + 'UpperLeg', 'calf_' + s: S + 'LowerLeg', 'foot_' + s: S + 'Foot', 'ball_' + s: S + 'Toes',
        'thumb_01_' + s: S + 'ThumbMetacarpal', 'thumb_02_' + s: S + 'ThumbProximal', 'thumb_03_' + s: S + 'ThumbDistal',
    })
    for mh, vrm in (('index', 'Index'), ('middle', 'Middle'), ('ring', 'Ring'), ('pinky', 'Little')):
        for i, seg in enumerate(('Proximal', 'Intermediate', 'Distal')):
            BONES['%s_0%d_%s' % (mh, i + 1, s)] = S + vrm + seg


def select_only(obs, active=None):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or (obs[0] if obs else None)


def strip_modifiers(H):
    bm = H.basemesh
    for md in list(bm.modifiers):
        if md.type == 'MASK':
            bm.modifiers.remove(md)
    for ob in H.rig.children:
        for md in list(ob.modifiers):
            if md.type == 'SUBSURF':
                ob.modifiers.remove(md)


def delete_verts(ob, mask):
    """Delete vertices where mask is True (shape keys survive: bmesh keeps the key layers)."""
    if not mask.any():
        return
    me = ob.data
    bmx = bmesh.new()
    bmx.from_mesh(me)
    bmx.verts.ensure_lookup_table()
    bmesh.ops.delete(bmx, geom=[bmx.verts[i] for i in np.nonzero(mask)[0]], context='VERTS')
    bmx.to_mesh(me)
    bmx.free()
    me.update()


def _delete_group_of(ob):
    """Name of the basemesh 'Delete.*' vertex group MPFB created for a clothes proxy."""
    path = ob.get('vtp_mhclo') or ''
    base = os.path.basename(path).replace('.mhclo', '').replace(' ', '_')
    return 'Delete.' + base


def covered_by_every_outfit(H):
    """Body verts hidden under EVERY outfit (default + all costumes): safe to delete, so skin can never poke
    through there whatever the user wears. Per outfit the coverage is the union of its items' delete groups."""
    bm = H.basemesh
    outfits = [H.clothes] + [objs for objs in H.costumes.values()]
    safe = None
    for objs in outfits:
        if not objs:
            return np.zeros(len(bm.data.vertices), bool)
        cov = np.zeros(len(bm.data.vertices), bool)
        for ob in objs:
            cov |= group_weights(bm, _delete_group_of(ob)) > 0.5
        safe = cov if safe is None else (safe & cov)
    return safe if safe is not None else np.zeros(len(bm.data.vertices), bool)


def delete_faces(ob, face_indices):
    """Delete faces (and verts left loose) — shape keys survive."""
    if not face_indices:
        return
    me = ob.data
    bmx = bmesh.new()
    bmx.from_mesh(me)
    bmx.faces.ensure_lookup_table()
    bmesh.ops.delete(bmx, geom=[bmx.faces[i] for i in face_indices], context='FACES')
    loose = [v for v in bmx.verts if not v.link_faces]
    if loose:
        bmesh.ops.delete(bmx, geom=loose, context='VERTS')
    bmx.to_mesh(me)
    bmx.free()
    me.update()


def remove_helpers(H):
    bm = H.basemesh
    body = group_weights(bm, 'body')
    covered = covered_by_every_outfit(H)
    H.deleted_under_clothes = int(covered.sum())
    delete_verts(bm, (body <= 0.0) | covered)


def push_out(H, margin=0.004, log=print):
    """Clothes stay >= margin outside the skin (MakeHuman clothes are authored against delete groups, so they
    sit tight or even inside the body where it is not deleted). Nearest-surface test against the body BVH,
    then a light smoothing of the moved offsets so folds don't crease."""
    from mathutils.bvhtree import BVHTree
    bm = H.basemesh
    dg = bpy.context.evaluated_depsgraph_get()
    tree = BVHTree.FromObject(bm, dg, deform=False)
    for ob in H.clothes + [o for objs in H.costumes.values() for o in objs]:
        C = coords(ob)
        D = np.zeros_like(C)
        for i, co in enumerate(C):
            loc, nrm, _, dist = tree.find_nearest(Vector(co.tolist()))
            if loc is None or dist > 0.05:
                continue
            s = (Vector(co.tolist()) - loc).dot(nrm)
            if s < margin:
                D[i] = np.array(nrm[:]) * (margin - s)
        moved = int((np.abs(D).sum(1) > 0).sum())
        if moved:
            # 2 passes of edge-neighbour averaging on the displacement field
            me = ob.data
            E = np.array([e.vertices[:] for e in me.edges])
            for _ in range(2):
                acc = np.zeros_like(D)
                cnt = np.zeros(len(D))
                np.add.at(acc, E[:, 0], D[E[:, 1]]); np.add.at(acc, E[:, 1], D[E[:, 0]])
                np.add.at(cnt, E[:, 0], 1); np.add.at(cnt, E[:, 1], 1)
                avg = acc / np.maximum(cnt, 1)[:, None]
                D = np.where(np.linalg.norm(D, axis=1)[:, None] >= np.linalg.norm(avg, axis=1)[:, None], D, avg)
            new = C + D
            me.vertices.foreach_set('co', new.ravel())
            if me.shape_keys:
                for kb in me.shape_keys.key_blocks:
                    K = coords(ob, kb)
                    kb.data.foreach_set('co', (K + D).ravel())
            me.update()
        log('  push-out', ob.name, moved, 'verts')


def rename_bones(H):
    arm = H.rig
    for b in arm.data.bones:
        if b.name in BONES:
            b.name = BONES[b.name]   # Blender renames the matching vertex groups on skinned children too
    arm.name = 'Armature'
    arm.data.name = 'Armature'


def add_eye_bones(H):
    """leftEye/rightEye bones at the eyeball centres, pointing forward (-Y); eyeball verts 100% on them."""
    eyes = H.parts.get('eyes')
    arm = H.rig
    if eyes is None:
        return None
    C = coords(eyes)
    mw = eyes.matrix_world
    centers = {}
    for side, sel in (('left', C[:, 0] > 0), ('right', C[:, 0] < 0)):
        P = C[sel]
        # least-squares sphere through the eyeball (+ cornea) verts: |p|^2 = 2 p.c + (r^2 - |c|^2)
        A = np.c_[2 * P, np.ones(len(P))]
        sol, *_ = np.linalg.lstsq(A, (P ** 2).sum(1), rcond=None)
        c = sol[:3]
        r = float(np.sqrt(max(sol[3] + c @ c, 1e-8)))
        r = min(r, float(c[1] - P[:, 1].min()))   # front-most point = cornea apex
        centers[side] = (Vector(c.tolist()), r)
    select_only([arm], arm)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    head = eb['head']
    for side, (c, r) in centers.items():
        cw = arm.matrix_world.inverted() @ (mw @ c)
        b = eb.new(side + 'Eye')
        b.head = cw
        b.tail = cw + Vector((0, -max(r, 0.008), 0))
        b.roll = 0
        b.parent = head
        b.use_deform = True
    bpy.ops.object.mode_set(mode='OBJECT')
    # reskin the eyes: each eyeball rigidly on its bone
    for g in list(eyes.vertex_groups):
        eyes.vertex_groups.remove(g)
    gl = eyes.vertex_groups.new(name='leftEye')
    gr = eyes.vertex_groups.new(name='rightEye')
    li = [i for i in range(len(C)) if C[i, 0] > 0]
    ri = [i for i in range(len(C)) if C[i, 0] <= 0]
    gl.add(li, 1.0, 'REPLACE')
    gr.add(ri, 1.0, 'REPLACE')
    H.eye_centers = {k: (arm.matrix_world.inverted() @ (mw @ v[0]), v[1]) for k, v in centers.items()}
    return H.eye_centers


def clean_vertex_groups(obs, arm):
    names = {b.name for b in arm.data.bones}
    for ob in obs:
        for g in list(ob.vertex_groups):
            if g.name not in names:
                ob.vertex_groups.remove(g)


def name_objects(H):
    bm = H.basemesh
    bm.name = 'Body'
    bm.data.name = 'Body'
    friendly = {'eyes': 'Eyes', 'eyebrows': 'Eyebrows', 'eyelashes': 'Eyelashes', 'teeth': 'Teeth', 'tongue': 'Tongue', 'hair': 'Hair'}
    for role, ob in H.parts.items():
        ob.name = friendly[role]
        ob.data.name = friendly[role]
    for ob in H.clothes:
        ob.name = 'Outfit_' + ob.name.split('.')[-1]
        ob.data.name = ob.name
    for cid, objs in H.costumes.items():
        for ob in objs:
            ob.name = 'Costume_%s_%s' % (cid, ob.name.split('.')[-1])
            ob.data.name = ob.name


def base_objects(H):
    return [H.basemesh] + list(H.parts.values()) + list(H.clothes)


def all_objects(H):
    out = base_objects(H)
    for objs in H.costumes.values():
        out += objs
    return out
