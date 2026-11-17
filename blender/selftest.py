"""The "Set up AI creation" Blender self-test (server/aiSetup.ts, lane toolsetup beta.12).

A tiny headless job that proves this Blender can do what VTube Pro needs: start in the background, run our Python,
build a mesh with a material, and save it as glTF (the format every import / convert job uses) into VTube Pro's own
cache folder (a Flatpak Blender that cannot reach it fails here, with a clear message in the helper).

params: {"out": "<absolute path of the .glb to write>"}
VTP_OK {"version": "5.1.0", "objects": 1, "gltf": true, "bytes": 1234}
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bmesh  # noqa: E402
import bpy  # noqa: E402
import common  # noqa: E402


def main(p):
    out = p["out"]
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    me = bpy.data.meshes.new("vtp_selftest")
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bm.to_mesh(me)
    bm.free()
    mat = bpy.data.materials.new("vtp_selftest")
    me.materials.append(mat)
    ob = bpy.data.objects.new("vtp_selftest", me)
    bpy.context.scene.collection.objects.link(ob)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=False)
    size = os.path.getsize(out) if os.path.exists(out) else 0
    if not size:
        raise RuntimeError("the glTF exporter did not write the test model")
    return {"version": bpy.app.version_string.split(" ")[0], "objects": len(bpy.data.objects), "gltf": True, "bytes": size}


common.run_main(main)
