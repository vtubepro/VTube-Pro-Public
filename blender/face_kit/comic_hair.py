"""
Hair for face_kit comic heads: builds an anime_hair clump hairstyle on a finished (MakeHuman-based) GLB and dumps it
as a stage-2 part (Hair.npz + hair texture) that human_face.merge_hair() puts into the GLB (rigid on the head bone).

    tools\\blender_low.cmd -b --factory-startup --python blender/face_kit/comic_hair.py -- <glb> <style> <out_dir>
          [base=r,g,b] [seed=7] [preview=1]
"""
import math
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.append(os.path.dirname(HERE))

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix  # noqa: E402

from anime_hair import hairkit as hk, build as HB  # noqa: E402
from anime_hair.hairkit import HeadFrame  # noqa: E402
from face_kit import hair_styles  # noqa: E402


def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    glb, style, out = argv[0], argv[1], os.path.abspath(argv[2])
    opt = dict(a.split('=', 1) for a in argv[3:] if '=' in a)
    os.makedirs(out, exist_ok=True)
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    tmp = os.path.join(tempfile.gettempdir(), 'fk_hair_src.glb')
    shutil.copyfile(glb, tmp)
    bpy.ops.import_scene.gltf(filepath=tmp)
    for ob in list(bpy.data.objects):
        if ob.type == 'MESH' and ob.name.split('.')[0] in ('Hair', 'Beard', 'Eyes', 'Tongue'):
            bpy.data.objects.remove(ob, do_unlink=True)
    # the MakeHuman GLB faces +Z (glTF) = -Y (Blender); anime_hair's head frame expects +Y front, character right = +X:
    # turn the whole import 180 deg about Z for the build, turn the hair back before dumping
    R = Matrix.Rotation(math.pi, 4, 'Z')
    roots = [o for o in bpy.data.objects if o.parent is None]
    for o in roots:
        o.matrix_world = R @ o.matrix_world
    bpy.context.view_layer.update()
    arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    B = {b.name: np.array(arm.matrix_world @ b.head_local) for b in arm.data.bones}
    heads = [o for o in bpy.data.objects if o.type == 'MESH' and o.name.split('.')[0] == 'Body']
    # garments join the collision surface (long hair lies ON the shoulders / back instead of sinking in)
    coll = heads + [o for o in bpy.data.objects if o.type == 'MESH' and o.name.split('.')[0].startswith('Outfit')]
    eye_z = float(opt.get('eye_z', B['head'][2] + 0.075))
    if 'leftEye' in B and 'rightEye' in B:
        eye = (B['leftEye'] + B['rightEye']) / 2
    else:
        eye = B['head'] + np.array([0, 0.08, 0.075])
    lowz = B['upperChest'][2] if 'upperChest' in B else B['neck'][2] - 0.15
    F = HeadFrame.from_objects(coll, neck_z=float(lowz), eye_z=float(eye[2]))
    F.eye = np.array(eye)
    # ring spacing along each lock (the toolkit default 5.5 mm is film density; 9-11 mm keeps a VTuber budget)
    ring = float(opt.get('ring', 0.0055))
    if ring != 0.0055:
        _add = hk.HairBuilder.add

        def add(self, c, rings=None, rng=None):
            G0 = np.asarray(c.guide, float)
            seg = np.linalg.norm(np.diff(G0, axis=0), axis=1).sum()
            return _add(self, c, rings=int(np.clip(seg / ring, 6, int(opt.get('maxrings', 24)))), rng=rng)
        hk.HairBuilder.add = add
    rng = np.random.default_rng(int(opt.get('seed', 7)))
    kw = {}
    if 'length' in opt:
        kw['length'] = float(opt['length'])
    if 'base' in opt:
        kw['base'] = tuple(float(x) for x in opt['base'].split(','))
    res = hair_styles.STYLES[style](F, rng, **kw)
    tex = os.path.join(out, 'hair_tex.png')
    o = HB.build(F, res, 'Hair', tex_path=tex)
    hair, scalp = o['hair'], o['scalp']
    print(f'FK_HAIR {style}: {len(res.clumps)} clumps (+{o["filled"]} fillers), {len(hair.data.vertices)} verts')
    Rinv = R.inverted()
    for ob in (hair, scalp):
        ob.matrix_world = Rinv @ ob.matrix_world
        g = ob.vertex_groups.new(name='head')
        g.add(list(range(len(ob.data.vertices))), 1.0, 'REPLACE')
    bpy.context.view_layer.update()
    with bpy.context.temp_override(active_object=hair, selected_editable_objects=[hair, scalp], selected_objects=[hair, scalp]):
        bpy.ops.object.join()
    HB.dump_npz(hair, os.path.join(out, 'Hair.npz'), {o['material'].name: 'Hair'} if o.get('material') else None)
    print('FK_HAIR_OK', out)


if __name__ == '__main__':
    main()
