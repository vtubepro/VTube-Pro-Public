"""Headless Blender check of the autorig templates on procedural bodies (capsules): quadruped, lamp, bird, snake, person.

    tools\\blender_low.cmd --background --factory-startup -noaudio --python-exit-code 1 ^
        --python <abs>\\blender\\test_autorig_blender.py -- --shapes quadruped --out <abs scratch dir>

(one Blender run per template: --shapes takes a comma list; bird,snake share the "creature" run.) Never a GPU render.

For each shape: build the capsule mesh from blender/test_shapes.py -> export it as the input GLB -> autorig.main() with the taps
a person would make -> CENSUS on the skinned result (open / skinned mesh rules: scale, loose verts, degenerate faces, group
counts, every vertex weighted, <= 4 influences) -> re-import the exported GLB and check the skeleton and skin survived ->
POSE: turn a bone and check that the right part of the body moves and the rest stays.
Prints one `AUTORIG_TEST_OK <json>` line per run, or raises (exit code 1 with --python-exit-code 1).
"""
import json
import math
import os
import sys

import bpy  # noqa: E402
import bmesh  # noqa: E402
from mathutils import Quaternion, Vector  # noqa: E402

# Target: Blender 5.1, Python 3.13
assert bpy.app.version[:2] == (5, 1), f"built for Blender 5.1, running {bpy.app.version_string}"

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common  # noqa: E402
import autorig  # noqa: E402
import rigplan  # noqa: E402
import test_shapes as shapes  # noqa: E402

# ---------------------------------------------------------------- parameter block (metres; 1 Blender unit = 1 m)
MM = 0.001
BBOX_TOL = 1.0 * MM            # the rigged model has the size the spec says (the skin never changes the mesh)
MIN_FACE_AREA_FRAC = 1e-7      # degenerate face: area < this * height^2 (scaled to the part, never a fixed cm^2)
MAX_INFLUENCES = 4             # glTF JOINTS_0
MIN_COVERAGE = 0.999           # share of vertices with any weight after the nearest-bone fill
WEIGHT_SUM_TOL = 0.02          # exported weights add up to 1
POSE_ANGLE_DEG = 35.0          # how far the test turns a bone
POSE_MOVES_MIN = 0.02 * 1.0    # the turned part's vertices move at least this far (m, scaled by height below)
POSE_STILL_MAX = 1.0 * MM      # parts that must not follow move less than this

# per shape: bones to turn, a probe that must move (world point near the part) and a probe that must stay
POSES = {
    "quadruped": dict(bone="head", axis=(1, 0, 0), moves=lambda t: t["nose"], stays=lambda t: t["pawHR"]),
    "lamp": dict(bone="neck", axis=(1, 0, 0), moves=lambda t: t["objBendEnd"], stays=lambda t: t["objStill"]),
    "bird": dict(bone="head", axis=(1, 0, 0), moves=lambda t: t["nose"], stays=lambda t: t["footR"]),
    "snake": dict(bone="neck", axis=(0, 0, 1), moves=lambda t: t["nose"], stays=lambda t: t["tailTip"]),
    "person": dict(bone="head", axis=(1, 0, 0), moves=lambda t: (0.0, 0.0, 1.66), stays=lambda t: t["rightAnkle"]),
}
EXPECT = {   # bones that must exist per shape
    "quadruped": ["hips", "spine", "chest", "neck", "head", "leg_FL_1", "leg_FR_3", "leg_HL_2", "leg_HR_3", "tail_1", "tail_4"],
    "lamp": ["hips", "spine", "chest", "neck", "head", "chain_1", "chain_3"],
    "bird": ["hips", "head", "tail_1", "leg_HL_1", "leg_HR_2", "wing_L_1", "wing_R_3"],
    "snake": ["hips", "head", "neck_2", "tail_1", "tail_6"],
    "person": ["hips", "spine", "chest", "neck", "head", "leftUpperArm", "rightLowerArm", "leftUpperLeg", "rightFoot"],
}


def args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out = {"shapes": "quadruped", "out": None}
    for i, a in enumerate(argv):
        if a in ("--shapes", "--out") and i + 1 < len(argv):
            out[a[2:]] = argv[i + 1]
    assert out["out"] and os.path.isabs(out["out"]), "--out needs an absolute folder"
    os.makedirs(out["out"], exist_ok=True)
    return out


def build_mesh(shape):
    """The shape's capsules as one mesh object named Body (data API, no operators)."""
    verts, faces = shapes.mesh_of(shape["parts"])
    me = bpy.data.meshes.new("BodyMesh")
    me.from_pydata(verts, [], faces)
    me.update()
    ob = bpy.data.objects.new("Body", me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def evaluated_world_verts(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = ev.to_mesh()
    try:
        return [ev.matrix_world @ v.co for v in me.vertices]
    finally:
        ev.to_mesh_clear()


def census_skinned(ob, arm, label, height):
    """Open / skinned mesh census: no solid-only checks (capsule shells overlap by design)."""
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    loose = sum(1 for v in bm.verts if not v.link_faces)
    min_area = MIN_FACE_AREA_FRAC * height * height
    degenerate = sum(1 for f in bm.faces if f.calc_area() <= min_area)
    bm.free()
    bone_names = {b.name for b in arm.data.bones}
    groups = {g.name for g in ob.vertex_groups}
    stray = sorted(groups - bone_names)
    unweighted = 0
    over = 0
    for v in me.vertices:
        w = [g.weight for g in v.groups if g.weight > 1e-4]
        if not w:
            unweighted += 1
        if len(w) > MAX_INFLUENCES * 4:   # Blender may keep many; the export keeps the 4 strongest (checked after re-import)
            over += 1
    cov = 1.0 - unweighted / max(1, len(me.vertices))
    res = dict(label=label, verts=len(me.vertices), loose=loose, degenerate=degenerate, stray_groups=stray, coverage=round(cov, 4),
               shape_keys=len(me.shape_keys.key_blocks) if me.shape_keys else 0, uv_layers=len(me.uv_layers))
    assert loose == 0, res
    assert degenerate == 0, res
    assert not stray, res
    assert cov >= MIN_COVERAGE, res
    assert res["shape_keys"] == 0 and res["uv_layers"] == 0, res        # the test body has none; the rig must not add any
    return res


def check_reimport(out_glb, expect_bones, n_verts_expected, height, label):
    """The exported file: the skeleton, the skin (<= 4 joints per vertex, weights add up) survived the round trip."""
    common.reset_scene()
    common.import_model(out_glb)
    arms = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
    assert len(arms) == 1, f"{label}: expected 1 armature after re-import, got {len(arms)}"
    names = {b.name for b in arms[0].data.bones}
    missing = [n for n in expect_bones if n not in names]
    assert not missing, f"{label}: bones lost in the export: {missing}"
    meshes = common.mesh_objects()
    total = 0
    worst_sum = 0.0
    max_inf = 0
    for o in meshes:
        assert any(m.type == "ARMATURE" for m in o.modifiers), f"{label}: {o.name} lost its armature modifier"
        for v in o.data.vertices:
            w = [g.weight for g in v.groups if g.weight > 1e-6]
            max_inf = max(max_inf, len(w))
            worst_sum = max(worst_sum, abs(sum(w) - 1.0))
        total += len(o.data.vertices)
    assert max_inf <= MAX_INFLUENCES, f"{label}: {max_inf} influences on a vertex after export"
    assert worst_sum < WEIGHT_SUM_TOL, f"{label}: weights add up to 1 +- {worst_sum}"
    return dict(bones=len(names), verts=total, max_influences=max_inf, worst_weight_sum_error=round(worst_sum, 5),
                vertex_count_changed=(total != n_verts_expected))


def pose_check(shape_name, taps, height, label):
    """Turn one bone and watch where the mesh moves (through the depsgraph; no operators)."""
    spec = POSES[shape_name]
    arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
    body = next(o for o in common.mesh_objects())
    before = evaluated_world_verts(body)
    pb = arm.pose.bones[spec["bone"]]
    pb.rotation_mode = "QUATERNION"
    pb.rotation_quaternion = Quaternion(spec["axis"], math.radians(POSE_ANGLE_DEG))
    bpy.context.view_layer.update()
    after = evaluated_world_verts(body)
    pb.rotation_quaternion = Quaternion((1, 0, 0, 0))
    bpy.context.view_layer.update()

    def displacement_near(p):
        # the vertex nearest the probe point (in the rest pose) and how far it travelled
        best = min(range(len(before)), key=lambda i: (before[i] - Vector(p)).length)
        return (after[best] - before[best]).length

    moved = displacement_near(spec["moves"](taps))
    still = displacement_near(spec["stays"](taps))
    assert moved >= POSE_MOVES_MIN * height, f"{label}: turning {spec['bone']} moved the part near the probe only {moved:.4f} m"
    assert still <= POSE_STILL_MAX, f"{label}: turning {spec['bone']} dragged a far part {still:.5f} m"
    return dict(bone=spec["bone"], moved_m=round(moved, 4), still_m=round(still, 6))


def run_shape(name, out_dir):
    shape = shapes.ALL[name]()
    label = name
    common.reset_scene()
    ob = build_mesh(shape)
    lo, hi = common.scene_bbox([ob])
    height = hi.z - lo.z
    # taps in the [u,v,w] form the client sends (shared/rigTaps.ts) over the glTF box = the Blender box mapped back
    cloud = rigplan.Cloud([tuple(ob.matrix_world @ v.co) for v in ob.data.vertices])
    taps = {k: list(cloud.to_uvw(v)) for k, v in shape["taps"].items()}
    in_glb = os.path.join(out_dir, f"{name}_in.glb")
    out_glb = os.path.join(out_dir, f"{name}_rigged.glb")
    common.export_glb(in_glb)
    params = {"input": in_glb, "output": out_glb, "template": shape["template"], "bodyType": shape.get("bodyType"), "taps": taps}
    if shape["template"] == "humanoid":
        soft = {"hips": 0.55, "chest": 0.74, "neck": 0.82, "blend": 0.05}
        for k in ("leftShoulder", "leftHand", "rightShoulder", "rightHand"):
            soft[k] = taps[k]
        params["soft"] = soft
    result = autorig.main(params)
    if shape["template"] != "humanoid":     # the posed test of the pipeline: no turned limb drags a vertex that belongs to another limb
        lp = result["limb_pose_test"]
        assert lp is not None and lp["total_after"] == 0, f"{label}: limbs drag each other: {lp}"
    # the scene now holds the rigged result
    arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
    meshes = common.mesh_objects()
    assert len(meshes) == 1, f"{label}: expected one mesh, got {[m.name for m in meshes]}"
    lo2, hi2 = common.scene_bbox(meshes)
    for a, b in zip(list(lo) + list(hi), list(lo2) + list(hi2)):
        assert abs(a - b) <= BBOX_TOL, f"{label}: the model changed size: {a} vs {b}"
    missing = [n for n in EXPECT[name] if n not in result["bones"]]
    assert not missing, f"{label}: bones missing from the plan: {missing}  (have {result['bones']})"
    assert len(set(result["bones"])) == len(result["bones"]), f"{label}: duplicate bones"
    cen = census_skinned(meshes[0], arm, label, height)
    n_verts = len(meshes[0].data.vertices)
    pose = pose_check(name, shape["taps"], height, label)
    rt = check_reimport(out_glb, EXPECT[name], n_verts, height, label)
    return dict(shape=name, template=result["template"], limb_pose=(result["limb_pose_test"] or {}).get("total_after"), bones=len(result["bones"]), skin=result["meshes"], coverage=result["coverage"],
                notes=result["notes"], census=cen, pose=pose, reimport=rt, height_m=round(height, 3))


def main():
    a = args()
    reports = []
    for name in [s for s in a["shapes"].split(",") if s]:
        reports.append(run_shape(name, a["out"]))
    print("AUTORIG_TEST_OK " + json.dumps(reports))


if __name__ == "__main__":
    main()
