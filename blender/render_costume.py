"""Render a costume worn on its base avatar (both at rest pose) — wardrobe thumbnails + AI refine renders.

params: {
  "base": "<base model path>",
  "costume": "<costume .glb path>",
  "hides": ["<base mesh name>", ...],   # base meshes the costume hides while worn
  "out_dir": "<dir>",
  "views": ["front"], "size": 512, "camera": "ortho", "prefix": "costume"
}
VTP_OK {"images": [{"view": ..., "path": ...}], "bbox": {...}}
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402

import common  # noqa: E402
import render_preview  # noqa: E402


def main(p):
    common.reset_scene()
    base_objs = common.import_model(p["base"])
    hides = set(p.get("hides") or [])
    for o in base_objs:
        if o.type == "MESH" and (o.name in hides or (o.data and o.data.name in hides)):
            bpy.data.objects.remove(o, do_unlink=True)
    if p.get("costume"):
        common.import_model(p["costume"])
    return render_preview.render_views(
        p["out_dir"],
        p.get("views") or ["front"],
        int(p.get("size") or 512),
        p.get("camera") or "ortho",
        p.get("prefix") or "costume",
    )


if __name__ == "__main__":
    common.run_main(main)
