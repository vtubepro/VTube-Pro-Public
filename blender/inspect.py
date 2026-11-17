"""Print a JSON summary of a model.

params: {"input": "<path>"}
VTP_OK {meshes:[{name, vertices, faces, shape_keys, materials}], bones:[...],
        has_armature, materials:[...], bbox:{min,max} (glTF Y-up), bbox_blender}
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import common  # noqa: E402


def main(p):
    common.reset_scene()
    common.import_model(p["input"])
    meshes = common.mesh_objects()
    out_meshes = []
    for o in meshes:
        me = o.data
        keys = [k.name for k in me.shape_keys.key_blocks] if me.shape_keys else []
        out_meshes.append({
            "name": o.name,
            "vertices": len(me.vertices),
            "faces": len(me.polygons),
            "shape_keys": keys,
            "materials": [m.name for m in me.materials if m],
            "vertex_groups": len(o.vertex_groups),
        })
    arms = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
    bones = [b.name for a in arms for b in a.data.bones]
    result = {
        "meshes": out_meshes,
        "vertex_count": sum(m["vertices"] for m in out_meshes),
        "bones": bones,
        "has_armature": bool(arms),
        "materials": sorted({m.name for m in bpy.data.materials if m.users}),
        "shape_keys": sorted({k for m in out_meshes for k in m["shape_keys"] if k != "Basis"}),
        "animations": [a.name for a in bpy.data.actions],
    }
    if meshes:
        lo, hi = common.scene_bbox(meshes)
        result["bbox"] = common.bbox_gltf(lo, hi)
        result["bbox_blender"] = {"min": list(lo), "max": list(hi)}
    return result


common.run_main(main)
