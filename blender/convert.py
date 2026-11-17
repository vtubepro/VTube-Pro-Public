"""Convert any importable model to a single-file GLB.

params: {"input": "<path>", "output": "<path.glb>", "search": "<folder>" (optional)}

search: a folder (the dropped folder / unzipped .zip) where textures the model points at are looked for when they
aren't where the file says (other folder, other drive, other case). The result lists the ones still missing.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402


def main(p):
    src, dst = p["input"], p["output"]
    if not os.path.isfile(src):
        raise FileNotFoundError(src)
    common.reset_scene()
    common.import_model(src)
    meshes = common.mesh_objects()
    if not meshes:
        raise RuntimeError("Imported file contains no meshes")
    missing = []
    search = p.get("search")
    if search and os.path.isdir(search):
        missing = relink_images(search)
    common.export_glb(dst)
    lo, hi = common.scene_bbox(meshes)
    return {"output": dst, "meshes": len(meshes), "bbox": common.bbox_gltf(lo, hi), "missing": missing}


def relink_images(folder):
    """Point images whose file isn't there at a file of the same name anywhere under `folder` (any case, and the
    same name with another image extension: .tga asked, .png there). Returns the names still missing."""
    import bpy
    found = {}
    for root, _dirs, files in os.walk(folder):
        for f in files:
            found.setdefault(f.lower(), os.path.join(root, f))
            stem, ext = os.path.splitext(f.lower())
            if ext in (".png", ".jpg", ".jpeg", ".tga", ".bmp", ".tif", ".tiff", ".dds", ".webp"):
                found.setdefault(stem + ".*", os.path.join(root, f))
    missing = []
    for img in bpy.data.images:
        if img.source != "FILE" or img.packed_file:
            continue
        cur = bpy.path.abspath(img.filepath or "")
        if cur and os.path.isfile(cur):
            continue
        name = os.path.basename((img.filepath or img.name).replace("\\", "/")).lower()
        hit = found.get(name) or found.get(os.path.splitext(name)[0] + ".*")
        if hit:
            img.filepath = hit
            try:
                img.reload()
            except Exception:
                pass
        else:
            missing.append(img.filepath or img.name)
    return missing


common.run_main(main)
