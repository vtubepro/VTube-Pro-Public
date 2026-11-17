"""Shared helpers for VTube Pro's headless Blender scripts.

Contract (see server/blender.ts):
  blender -b --factory-startup --python <script.py> -- <params.json | json-string>
Every script prints exactly one terminal marker line:
  VTP_OK <json>      on success
  VTP_FAIL <reason>  on failure
The server parses the LAST marker line and ignores Blender's exit code.

Coordinate note: Blender's glTF importer converts glTF Y-up to Blender Z-up
(gltf (x, y, z) -> blender (x, -z, y)). A glTF model facing +Z therefore faces
-Y in Blender. Bounding boxes are always computed from evaluated geometry.
"""
import json
import os
import sys
import traceback

import bpy
from mathutils import Vector


# ---------------------------------------------------------------- markers

def ok(payload=None):
    sys.stdout.write("VTP_OK " + json.dumps(payload if payload is not None else {}) + "\n")
    sys.stdout.flush()


def fail(reason):
    reason = str(reason).replace("\r", " ").replace("\n", " | ")
    sys.stdout.write("VTP_FAIL " + reason + "\n")
    sys.stdout.flush()


def log(*parts):
    sys.stdout.write(" ".join(str(p) for p in parts) + "\n")
    sys.stdout.flush()


def run_main(fn):
    """Run fn(params) and emit exactly one marker line."""
    try:
        result = fn(parse_args())
        ok(result)
    except SystemExit:
        raise
    except BaseException as e:  # noqa: BLE001 - we want every failure reported
        traceback.print_exc()
        sys.stdout.flush()
        fail(f"{type(e).__name__}: {e}")


# ---------------------------------------------------------------- args

def parse_args():
    """Params come after `--` as either a path to a .json file or a JSON string."""
    argv = sys.argv
    rest = argv[argv.index("--") + 1:] if "--" in argv else []
    if not rest:
        return {}
    raw = rest[0]
    if raw.lower().endswith(".json") and os.path.isfile(raw):
        with open(raw, "r", encoding="utf-8") as f:
            return json.load(f)
    return json.loads(raw)


# ---------------------------------------------------------------- scene

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


IMPORTABLE = (".glb", ".gltf", ".vrm", ".fbx", ".obj", ".stl", ".ply", ".blend", ".dae")


def import_model(path):
    """Import any supported format into the current scene. Returns new objects."""
    ext = os.path.splitext(path)[1].lower()
    before = set(bpy.data.objects)
    if ext in (".glb", ".gltf", ".vrm"):
        src = path
        if ext == ".vrm":
            # VRM is a GLB container; the importer is happy with it but some
            # versions filter by extension, so hand it a .glb copy if needed.
            import shutil
            import tempfile
            src = os.path.join(tempfile.mkdtemp(prefix="vtp_vrm_"), "model.glb")
            shutil.copyfile(path, src)
        # disable_bone_shape: otherwise the importer adds an "Icosphere" bone-shape mesh to the scene
        bpy.ops.import_scene.gltf(filepath=src, disable_bone_shape=True)
    elif ext == ".fbx":
        try:
            bpy.ops.import_scene.fbx(filepath=path)
        except Exception:  # fall back to the newer C++ importer
            bpy.ops.wm.fbx_import(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif ext == ".stl":
        bpy.ops.wm.stl_import(filepath=path)
    elif ext == ".ply":
        bpy.ops.wm.ply_import(filepath=path)
    elif ext == ".blend":
        # never run scripts embedded in an imported .blend (the server also passes --disable-autoexec)
        bpy.ops.wm.open_mainfile(filepath=path, use_scripts=False)
        return list(bpy.data.objects)
    elif ext in (".usd", ".usda", ".usdc", ".usdz"):
        bpy.ops.wm.usd_import(filepath=path)
    elif ext == ".abc":
        bpy.ops.wm.alembic_import(filepath=path)
    elif ext == ".dae":
        if "collada_import" in dir(bpy.ops.wm):
            bpy.ops.wm.collada_import(filepath=path)
        else:
            raise RuntimeError("COLLADA (.dae) import was removed in Blender 5.x; export the model as FBX or glTF instead")
    else:
        raise RuntimeError(f"Unsupported model format: {ext}")
    return [o for o in bpy.data.objects if o not in before]


def mesh_objects():
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def world_vertices(obj, depsgraph=None):
    """World-space vertex positions of the evaluated mesh (modifiers + skin applied)."""
    depsgraph = depsgraph or bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(depsgraph)
    mesh = ev.to_mesh()
    try:
        mw = ev.matrix_world
        return [mw @ v.co for v in mesh.vertices]
    finally:
        ev.to_mesh_clear()


def scene_bbox(objs=None):
    """(min, max) Vectors in Blender world space over all mesh geometry."""
    objs = objs if objs is not None else mesh_objects()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    lo = Vector((float("inf"),) * 3)
    hi = Vector((float("-inf"),) * 3)
    any_v = False
    for o in objs:
        for co in world_vertices(o, depsgraph):
            any_v = True
            lo.x, lo.y, lo.z = min(lo.x, co.x), min(lo.y, co.y), min(lo.z, co.z)
            hi.x, hi.y, hi.z = max(hi.x, co.x), max(hi.y, co.y), max(hi.z, co.z)
    if not any_v:
        raise RuntimeError("Scene has no mesh geometry")
    return lo, hi


def blender_to_gltf(v):
    """Blender Z-up world coords -> glTF Y-up coords."""
    return [v[0], v[2], -v[1]]


def bbox_gltf(lo, hi):
    a, b = blender_to_gltf(lo), blender_to_gltf(hi)
    return {"min": [min(a[i], b[i]) for i in range(3)], "max": [max(a[i], b[i]) for i in range(3)]}


# ---------------------------------------------------------------- export

def export_glb(path, apply_modifiers=False, selected_only=False):
    """Export GLB, Y-up, keeping shape keys, skins and animations.

    apply_modifiers=True bakes modifiers but glTF can't then keep shape keys on
    those meshes, so the default leaves modifiers unapplied.
    """
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_yup=True,
        export_apply=apply_modifiers,
        export_morph=True,
        export_skins=True,
        export_animations=True,
        export_materials="EXPORT",
        export_cameras=False,
        use_selection=selected_only,
    )
    if not os.path.isfile(path):
        raise RuntimeError(f"glTF exporter produced no file at {path}")
    return path
