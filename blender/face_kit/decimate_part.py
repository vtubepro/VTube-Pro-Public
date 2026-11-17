"""
Decimate one mesh of a GLB (weights + UVs kept) and dump it as a stage-2 part npz (glTF space, bone-name weights)
that face_kit splices back into the GLB with numpy (everything else in the GLB stays byte-exact).

    tools\\blender_low.cmd -b --factory-startup --python blender/face_kit/decimate_part.py -- <glb> <mesh name> <out.npz> <target tris>
"""
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.append(os.path.dirname(HERE))

import bpy  # noqa: E402

from anime_hair import build as HB  # noqa: E402


def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    glb, name, out, target = argv[0], argv[1], argv[2], int(argv[3])
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    tmp = os.path.join(tempfile.gettempdir(), 'fk_dec_src.glb')
    shutil.copyfile(glb, tmp)
    bpy.ops.import_scene.gltf(filepath=tmp)
    ob = next(o for o in bpy.data.objects if o.type == 'MESH' and o.name.split('.')[0] == name)
    for m in list(ob.modifiers):
        if m.type == 'ARMATURE':
            ob.modifiers.remove(m)
    n0 = sum(len(p.vertices) - 2 for p in ob.data.polygons)
    ratio = min(1.0, target / max(n0, 1))
    if ratio < 1.0:
        bpy.context.view_layer.objects.active = ob
        md = ob.modifiers.new('dec', 'DECIMATE')
        md.decimate_type = 'COLLAPSE'
        md.ratio = ratio
        md.use_collapse_triangulate = True
        with bpy.context.temp_override(object=ob, active_object=ob):
            bpy.ops.object.modifier_apply(modifier=md.name)
    for p in ob.data.polygons:
        p.use_smooth = True
    HB.dump_npz(ob, out)
    print(f'FK_DECIMATE_OK {name}: {n0} -> {sum(len(p.vertices) - 2 for p in ob.data.polygons)} tris')


if __name__ == '__main__':
    main()
