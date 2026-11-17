"""Take a rigged GLB made by the optional ML pack (SkinTokens / UniRig: arbitrary bone names) and give its bones the names the
studio understands, from where they are (blender/rolemap.py). The skin weights are kept: renaming a bone renames its vertex
group with it. Writes the result as a new GLB. Pure data API (no operators except the importer / exporter).

params: {
  "input": "<ml_rigged.glb>", "output": "<adopted.glb>",
  "bodyType": "person" | "fourLegs" | "bird" | "tail" | "thing"   # optional
  "taps": { "nose": [u,v,w], "tailTip": [u,v,w] }                 # optional, same space as blender/autorig.py taps
}
VTP_OK {"output", "bones": [...], "renamed": {old: new}, "notes": [...], "template"}
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402

import common  # noqa: E402
import rigplan  # noqa: E402
import rolemap  # noqa: E402

TEMPLATE_OF = {"person": "humanoid", "fourLegs": "quadruped", "bird": "creature", "tail": "creature", "thing": "object"}


def main(p):
    common.reset_scene()
    common.import_model(p["input"])
    arms = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
    meshes = common.mesh_objects()
    if not arms:
        raise RuntimeError("The file has no skeleton to name.")
    if not meshes:
        raise RuntimeError("The file has no mesh.")
    arm = max(arms, key=lambda a: len(a.data.bones))
    lo, hi = common.scene_bbox(meshes)
    mw = arm.matrix_world
    bones = [(b.name, tuple(mw @ b.head_local), tuple(mw @ b.tail_local), b.parent.name if b.parent else None) for b in arm.data.bones]
    cloud = rigplan.Cloud([tuple(lo), tuple(hi)])            # only its box is used, to map the tap coordinates
    hints = {k: cloud.from_uvw(v) for k, v in (p.get("taps") or {}).items() if k in ("nose", "tailTip") and isinstance(v, (list, tuple)) and len(v) == 3}
    try:
        renames, notes = rolemap.map_roles(bones, tuple(lo), tuple(hi), p.get("bodyType"), hints)
    except rolemap.RoleError as e:
        raise RuntimeError(str(e)) from e
    # rename in two passes so a new name never lands on a bone that still has it
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    try:
        eb = arm.data.edit_bones
        tmp = {}
        for old, new in renames.items():
            if old != new:
                tmp[old] = f"__vtp_{len(tmp)}"
                eb[old].name = tmp[old]
        for old, new in renames.items():
            if old != new:
                eb[tmp[old]].name = new
    finally:
        bpy.ops.object.mode_set(mode="OBJECT")
    names = {b.name for b in arm.data.bones}
    for o in meshes:   # vertex groups follow the bones; one that did not is a bug worth stopping for
        stray = [g.name for g in o.vertex_groups if g.name not in names]
        if stray:
            raise RuntimeError(f"vertex groups lost their bones: {stray[:5]}")
        if o.name in names:
            o.name = o.name + "_mesh"
    common.export_glb(p["output"])
    return {
        "output": p["output"],
        "template": TEMPLATE_OF.get(p.get("bodyType") or "", "humanoid"),
        "bones": sorted(names),
        "renamed": {k: v for k, v in renames.items() if k != v},
        "notes": notes,
    }


if __name__ == "__main__":
    common.run_main(main)
