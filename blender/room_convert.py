"""Room files -> one GLB VTube Pro can open ("Add my room", server/routes/roomImport.ts).

params: {"input": "<path .fbx/.blend/.obj/.glb>", "output": "<path .glb>"}

Unlike convert.py (avatars) this keeps what a ROOM needs (docs/ARTIST_ENVIRONMENTS.md §0): custom properties as glTF
extras (SPOT pose / seatHeight, LIGHT group ...), cameras (CAM_*), modifiers applied, NO punctual lights (the engine
builds its own from LIGHT_* nodes) and no Draco / KTX2 (VTube Pro's room loader does not decode them). Y-up, metres.
Prints VTP_OK {"output", "meshes", "cameras", "empties", "bbox"}.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import common  # noqa: E402


def main(p):
    src, dst = p["input"], p["output"]
    if not os.path.isfile(src):
        raise FileNotFoundError(src)
    common.reset_scene()
    common.import_model(src)
    meshes = common.mesh_objects()
    if not meshes:
        raise RuntimeError("This file has no 3D shapes in it")
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=dst,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_extras=True,
        export_cameras=True,
        export_lights=False,
        export_materials="EXPORT",
        export_animations=True,
        export_draco_mesh_compression_enable=False,
        export_image_format="AUTO",
        use_selection=False,
    )
    lo, hi = common.scene_bbox(meshes)
    objs = list(bpy.context.scene.objects)
    return {
        "output": dst,
        "meshes": len(meshes),
        "cameras": sum(1 for o in objs if o.type == "CAMERA"),
        "empties": sum(1 for o in objs if o.type == "EMPTY"),
        "bbox": common.bbox_gltf(lo, hi),
    }


common.run_main(main)
