"""Headless Blender check of blender/mlrig_adopt.py on a stand-in for the ML pack's output (no model is run, nothing is downloaded).

    tools\\blender_low.cmd --background --factory-startup -noaudio --python-exit-code 1 ^
        --python <abs>\\blender\\test_mlrig_adopt_blender.py -- --out <abs scratch dir>

The stand-in: the capsule quadruped rigged by the planner (so its skin is good), then EVERY bone renamed to "Bone.NNN" in a
shuffled order, exported as the "ML output" GLB. mlrig_adopt must give the bones their studio names back from positions alone
and keep the skin: the vertex groups follow the bones, the model keeps its size, and turning `head` still moves the head.
Prints `ADOPT_TEST_OK <json>`; anything wrong raises (exit code 1).
"""
import json
import os
import random
import sys

import bpy  # noqa: E402

# Target: Blender 5.1, Python 3.13
assert bpy.app.version[:2] == (5, 1), f"built for Blender 5.1, running {bpy.app.version_string}"
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common  # noqa: E402
import autorig  # noqa: E402
import mlrig_adopt  # noqa: E402
import rigplan  # noqa: E402
import test_shapes as shapes  # noqa: E402
import test_autorig_blender as base  # noqa: E402

BBOX_TOL = 1.0e-3
SEED = 7


def scramble_in_scene():
    """Rename every bone of the (only) armature to Bone.NNN in shuffled order, with the data API."""
    arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
    names = [b.name for b in arm.data.bones]
    ids = list(range(len(names)))
    random.Random(SEED).shuffle(ids)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    try:
        for n, i in zip(names, ids):
            arm.data.edit_bones[n].name = f"Bone.{i:03d}"
    finally:
        bpy.ops.object.mode_set(mode="OBJECT")
    return names


def main():
    a = base.args()
    out = a["out"]
    shape = shapes.quadruped()
    common.reset_scene()
    ob = base.build_mesh(shape)
    cloud = rigplan.Cloud([tuple(ob.matrix_world @ v.co) for v in ob.data.vertices])
    taps = {k: list(cloud.to_uvw(v)) for k, v in shape["taps"].items()}
    src = os.path.join(out, "adopt_in.glb")
    ruled = os.path.join(out, "adopt_planned.glb")
    ml_like = os.path.join(out, "adopt_ml_like.glb")
    adopted = os.path.join(out, "adopt_out.glb")
    common.export_glb(src)
    planned = autorig.main({"input": src, "output": ruled, "template": "quadruped", "taps": taps})
    original = set(planned["bones"])
    scramble_in_scene()
    common.export_glb(ml_like)
    lo, hi = common.scene_bbox(common.mesh_objects())
    height = hi.z - lo.z

    res = mlrig_adopt.main({"input": ml_like, "output": adopted, "bodyType": "fourLegs", "taps": {"nose": taps["nose"], "tailTip": taps["tailTip"]}})
    got = set(res["bones"])
    assert len(got) == len(original), f"bone count changed: {len(got)} vs {len(original)}"
    for must in ["hips", "head"] + [f"leg_{k}_{i}" for k in rigplan.LEG_KEYS for i in (1, 2, 3)] + [f"tail_{i}" for i in range(1, rigplan.Q_TAIL_BONES + 1)]:
        assert must in got, f"{must} was not recovered: {sorted(got)}"
    assert not any(n.startswith("Bone.") or n.startswith("__vtp_") for n in got), f"unnamed bones left: {sorted(got)}"

    # the scene holds the adopted rig: census (skinned mesh) + pose
    arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
    meshes = common.mesh_objects()
    assert len(meshes) == 1
    lo2, hi2 = common.scene_bbox(meshes)
    for x, y in zip(list(lo) + list(hi), list(lo2) + list(hi2)):
        assert abs(x - y) <= BBOX_TOL, f"the model changed size: {x} vs {y}"
    cen = base.census_skinned(meshes[0], arm, "adopted", height)
    pose = base.pose_check("quadruped", shape["taps"], height, "adopted")
    # the exported file round-trips with the new names
    rt = base.check_reimport(adopted, ["hips", "head", "leg_FL_1", "tail_1"], len(meshes[0].data.vertices), height, "adopted")
    print("ADOPT_TEST_OK " + json.dumps(dict(renamed=len(res["renamed"]), notes=res["notes"], census=cen, pose=pose, reimport=rt, height_m=round(height, 3))))


main()
