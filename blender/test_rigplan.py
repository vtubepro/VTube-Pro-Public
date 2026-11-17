"""Unit tests for the skeleton planners (blender/rigplan.py): pure Python, no Blender.

    python -I blender/test_rigplan.py        (from the repo root)

Each procedural body (test_shapes.py: a quadruped of capsules, a lamp, a bird, a snake, a person) is turned into a point
cloud, the taps a person would make are converted to the [u,v,w] form the client sends, and the plan is checked: the right
bone names, a clean tree, bones where the body is, left/right on the right sides, taps respected, bad input refused.
"""
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rigplan as rp  # noqa: E402
import test_shapes as shapes  # noqa: E402


def cloud_of(shape):
    verts, _ = shapes.mesh_of(shape["parts"])
    return rp.Cloud(verts)


def taps_uvw(cloud, shape, drop=()):
    return {k: list(cloud.to_uvw(v)) for k, v in shape["taps"].items() if k not in drop}


def bone(plan, name):
    for b in plan.bones:
        if b[0] == name:
            return b
    raise AssertionError(f"no bone {name} in {plan.names()}")


def inside_bbox(cloud, p, pad=0.02):
    return all(cloud.lo[i] - pad <= p[i] <= cloud.hi[i] + pad for i in range(3))


class Basics(unittest.TestCase):
    def test_uvw_roundtrip(self):
        c = cloud_of(shapes.quadruped())
        for p in [(0.1, -0.3, 0.5), (0.0, 0.4, 0.9), (-0.14, 0.38, 0.0)]:
            q = c.from_uvw(c.to_uvw(p))
            self.assertLess(rp.dist(p, q), 1e-9)

    def test_validate_rejects_bad_plans(self):
        p = rp.Plan("x", [("hips", (0, 0, 0), (0, 0, 1), None), ("hips", (0, 0, 1), (0, 0, 2), "hips")])
        with self.assertRaises(rp.PlanError):
            rp.validate_plan(p)
        p = rp.Plan("x", [("hips", (0, 0, 0), (0, 0, 0), None)])
        with self.assertRaises(rp.PlanError):
            rp.validate_plan(p)
        p = rp.Plan("x", [("spine", (0, 0, 0), (0, 0, 1), "hips")])
        with self.assertRaises(rp.PlanError):
            rp.validate_plan(p)
        p = rp.Plan("x", [("hips", (0, 0, 0), (0, 0, 1), None), ("spine", (0, 0, 1), (0, 0, 2), "hips")])
        with self.assertRaises(rp.PlanError):  # no head
            rp.validate_plan(p)

    def test_capsule_meshes_are_closed_and_outward(self):
        for sh in shapes.ALL.values():
            for a, b, r in sh()["parts"]:
                v, f = shapes.capsule_mesh(a, b, r)
                edges = {}
                for face in f:
                    for i in range(len(face)):
                        e = (face[i], face[(i + 1) % len(face)])
                        edges[e] = edges.get(e, 0) + 1
                self.assertTrue(all(c == 1 for c in edges.values()), "directed edges are unique")
                self.assertTrue(all((e[1], e[0]) in edges for e in edges), "every edge has its opposite: closed")
                vol = 0.0   # signed volume > 0: normals point out
                for face in f:
                    for i in range(1, len(face) - 1):
                        p0, p1, p2 = v[face[0]], v[face[i]], v[face[i + 1]]
                        vol += rp.dot(p0, rp.cross(p1, p2)) / 6.0
                self.assertGreater(vol, 0)


class Sampling(unittest.TestCase):
    def test_box_comes_from_every_point_and_the_person_gets_all_of_them(self):
        import random
        rnd = random.Random(5)
        pts = [(rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(0, 2)) for _ in range(130000)]
        pts[77777] = (3.0, -4.0, 5.0)                        # an extreme point the stride would very likely skip
        full = rp.Cloud(pts)
        small = rp.Cloud(pts, 60000)
        self.assertEqual(len(full.pts), 130000)              # the default (the person template, old callers) keeps every point
        self.assertEqual(len(small.pts), 60000)
        self.assertEqual((full.lo, full.hi, full.h), (small.lo, small.hi, small.h))   # the tap box is the box of ALL vertices
        self.assertEqual(small.hi[0], 3.0)
        self.assertEqual(small.pts, rp.Cloud(pts, 60000).pts)  # deterministic
        self.assertEqual(small.from_uvw((0.3, 0.4, 0.5)), full.from_uvw((0.3, 0.4, 0.5)))


class Quadruped(unittest.TestCase):
    def setUp(self):
        self.shape = shapes.quadruped()
        self.cloud = cloud_of(self.shape)
        self.plan = rp.plan("quadruped", self.cloud, taps_uvw=taps_uvw(self.cloud, self.shape))

    def test_bone_names_follow_the_runtime_contract(self):
        names = set(self.plan.names())
        for n in ("hips", "spine", "chest", "neck", "head"):
            self.assertIn(n, names)
        for key in rp.LEG_KEYS:
            for i in (1, 2, 3):
                self.assertIn(f"leg_{key}_{i}", names)
            self.assertNotIn(f"leg_{key}_4", names)          # quadruped.ts walks leg_XX_1.. until one is missing
        for i in range(1, rp.Q_TAIL_BONES + 1):
            self.assertIn(f"tail_{i}", names)
        rp.validate_plan(self.plan)

    def test_head_at_the_nose_tail_at_the_tail(self):
        nose = self.shape["taps"]["nose"]
        self.assertLess(rp.dist(bone(self.plan, "head")[2], nose), 0.02)
        tip = self.shape["taps"]["tailTip"]
        last = bone(self.plan, f"tail_{rp.Q_TAIL_BONES}")
        self.assertLess(rp.dist(last[2], (0.0, tip[1], tip[2])), 0.02)
        # the hips are behind the chest (the back of the animal is +Y here; it faces -Y)
        self.assertGreater(bone(self.plan, "hips")[1][1], bone(self.plan, "chest")[1][1])

    def test_legs_on_the_right_sides_and_feet_on_the_floor(self):
        for key in rp.LEG_KEYS:
            top = bone(self.plan, f"leg_{key}_1")
            foot = bone(self.plan, f"leg_{key}_3")
            # the animal faces -Y so its left is +X
            if key[1] == "L":
                self.assertGreater(top[1][0], 0.05, key)
                self.assertGreater(foot[2][0], 0.05, key)
            else:
                self.assertLess(top[1][0], -0.05, key)
            self.assertAlmostEqual(foot[2][2], 0.0, delta=0.03)
            self.assertGreater(top[1][2], 0.4)
            # front legs hang from the chest, hind legs from the hips
            self.assertEqual(top[3], "chest" if key[0] == "F" else "hips")
        # front legs are in front (-Y) of the hind legs
        self.assertLess(bone(self.plan, "leg_FL_1")[1][1], bone(self.plan, "leg_HL_1")[1][1])

    def test_bones_stay_in_the_body_box(self):
        for n, h, t, _ in self.plan.bones:
            self.assertTrue(inside_bbox(self.cloud, h, 0.08) and inside_bbox(self.cloud, t, 0.08), n)

    def test_chain_is_connected_parent_to_child(self):
        by = {b[0]: b for b in self.plan.bones}
        for name in ("spine", "chest"):
            b = by[name]
            self.assertLess(rp.dist(by[b[3]][2], b[1]), 1e-6, name)
        for key in rp.LEG_KEYS:
            self.assertLess(rp.dist(by[f"leg_{key}_1"][2], by[f"leg_{key}_2"][1]), 1e-6)
            self.assertLess(rp.dist(by[f"leg_{key}_2"][2], by[f"leg_{key}_3"][1]), 1e-6)

    def test_missing_far_paws_copy_the_near_ones(self):
        t = taps_uvw(self.cloud, self.shape, drop=("pawFL", "pawHL"))
        p = rp.plan("quadruped", self.cloud, taps_uvw=t)
        a, b = bone(p, "leg_FL_3")[2], bone(p, "leg_FR_3")[2]
        self.assertAlmostEqual(a[1], b[1], places=6)
        self.assertGreater(a[0], 0.05)
        self.assertLess(b[0], -0.05)

    def test_no_taps_at_all_still_builds_from_the_shape(self):
        p = rp.plan("quadruped", self.cloud, taps_uvw={})
        rp.validate_plan(p)
        self.assertTrue(p.notes)
        # it found the head end: the head bone sits at the front (-Y) and higher than the hips
        self.assertLess(bone(p, "head")[1][1], bone(p, "hips")[1][1])

    def test_rotated_and_shifted_model_gives_the_same_skeleton(self):
        # the same animal turned 90 degrees about Z: facing -X. The plan must follow the animal, not the axes.
        rot = lambda q: (-q[1], q[0], q[2])  # noqa: E731
        sh = shapes.quadruped()
        sh["parts"] = [(rot(a), rot(b), r) for a, b, r in sh["parts"]]
        sh["taps"] = {k: rot(v) for k, v in sh["taps"].items()}
        c = cloud_of(sh)
        p2 = rp.plan("quadruped", c, taps_uvw=taps_uvw(c, sh))
        for n in self.plan.names():
            self.assertIn(n, p2.names())
        h1, h2 = bone(self.plan, "head")[2], bone(p2, "head")[2]
        self.assertLess(rp.dist(rot(h1), h2), 0.03)
        # left stays left: leg_FL of the rotated animal is on the rotated +X side
        self.assertLess(rp.dist(rot(bone(self.plan, "leg_FL_3")[2]), bone(p2, "leg_FL_3")[2]), 0.04)

    def test_refuses_nose_on_the_tail(self):
        t = taps_uvw(self.cloud, self.shape)
        t["nose"] = t["tailRoot"]
        with self.assertRaises(rp.PlanError):
            rp.plan("quadruped", self.cloud, taps_uvw=t)


class Creature(unittest.TestCase):
    def test_snake(self):
        sh = shapes.snake()
        c = cloud_of(sh)
        p = rp.plan("creature", c, taps_uvw=taps_uvw(c, sh), body_type="tail")
        rp.validate_plan(p)
        names = set(p.names())
        self.assertTrue({"hips", "spine", "chest", "neck", "neck_2", "head"} <= names)
        self.assertEqual(sum(1 for n in names if n.startswith("tail_")), rp.C_SNAKE["tail_bones"])
        self.assertFalse(any(n.startswith(("leg_", "wing_")) for n in names))
        # the head end is where the nose was tapped (y = -0.88), the tail end at y = +1.0
        self.assertLess(rp.dist(bone(p, "head")[2], sh["taps"]["nose"]), 0.02)
        self.assertLess(rp.dist(bone(p, f"tail_{rp.C_SNAKE['tail_bones']}")[2], sh["taps"]["tailTip"]), 0.02)
        # the chain follows the S-bend: a middle tail bone is off the straight line by a visible amount at some point
        xs = [bone(p, n)[1][0] for n in p.names() if n.startswith("tail_")]
        self.assertGreater(max(xs) - min(xs), 0.02)

    def test_bird(self):
        sh = shapes.bird()
        c = cloud_of(sh)
        p = rp.plan("creature", c, taps_uvw=taps_uvw(c, sh), body_type="bird")
        rp.validate_plan(p)
        names = set(p.names())
        for n in ("leg_HL_1", "leg_HL_2", "leg_HR_1", "leg_HR_2", "wing_L_1", "wing_L_3", "wing_R_1", "wing_R_3"):
            self.assertIn(n, names)
        # one foot and one wing tapped on the near (right, -X) side: the other side mirrors it to +X
        self.assertGreater(bone(p, "wing_L_3")[2][0], 0.2)
        self.assertLess(bone(p, "wing_R_3")[2][0], -0.2)
        self.assertGreater(bone(p, "leg_HL_2")[2][0], 0.0)
        self.assertLess(bone(p, "leg_HR_2")[2][0], 0.0)
        self.assertAlmostEqual(bone(p, "leg_HR_2")[2][2], sh["taps"]["footR"][2], delta=0.03)
        for n in ("wing_L_1", "wing_R_1"):
            self.assertEqual(bone(p, n)[3], "chest")

    def test_bird_without_feet_or_wings_still_builds(self):
        sh = shapes.bird()
        c = cloud_of(sh)
        p = rp.plan("creature", c, taps_uvw=taps_uvw(c, sh, drop=("wingTipR", "footR")), body_type="bird")
        rp.validate_plan(p)
        self.assertTrue(p.notes)

    def test_needs_the_two_ends(self):
        sh = shapes.snake()
        c = cloud_of(sh)
        with self.assertRaises(rp.PlanError):
            rp.plan("creature", c, taps_uvw=taps_uvw(c, sh, drop=("tailTip",)), body_type="tail")
        t = taps_uvw(c, sh)
        t["tailTip"] = t["nose"]
        with self.assertRaises(rp.PlanError):
            rp.plan("creature", c, taps_uvw=t, body_type="tail")


class Thing(unittest.TestCase):
    def setUp(self):
        self.shape = shapes.lamp()
        self.cloud = cloud_of(self.shape)

    def test_lamp(self):
        p = rp.plan("object", self.cloud, taps_uvw=taps_uvw(self.cloud, self.shape))
        rp.validate_plan(p)
        self.assertEqual(p.names(), ["hips", "spine", "chest", "neck", "head", "chain_1", "chain_2", "chain_3"])
        # the root holds still at the base; the springs end at the tapped tip
        self.assertLess(rp.dist(bone(p, "hips")[1], self.shape["taps"]["objStill"]), 1e-6)
        self.assertLess(rp.dist(bone(p, "chain_3")[2], self.shape["taps"]["objBendEnd"]), 1e-6)
        # the chain climbs: each bone starts higher than the base and the bend starts near the tapped spot
        self.assertGreater(bone(p, "spine")[1][2], 0.3)
        self.assertLess(abs(bone(p, "spine")[1][2] - self.shape["taps"]["objBendStart"][2]), 0.12)
        # springs hang below `head`; the auto-spring matcher (src/avatar/physics.ts AUTO_CHAIN) sees them as "chain"
        self.assertEqual(bone(p, "chain_1")[3], "head")
        self.assertEqual(bone(p, "chain_2")[3], "chain_1")

    def test_bend_start_is_optional(self):
        p = rp.plan("object", self.cloud, taps_uvw=taps_uvw(self.cloud, self.shape, drop=("objBendStart",)))
        rp.validate_plan(p)
        self.assertAlmostEqual(p.info["bendStart"], rp.O_DEFAULT_BEND_START)

    def test_needs_still_and_tip(self):
        with self.assertRaises(rp.PlanError):
            rp.plan("object", self.cloud, taps_uvw=taps_uvw(self.cloud, self.shape, drop=("objStill",)))
        with self.assertRaises(rp.PlanError):
            rp.plan("object", self.cloud, taps_uvw=taps_uvw(self.cloud, self.shape, drop=("objBendEnd",)))


class Person(unittest.TestCase):
    def setUp(self):
        self.shape = shapes.person()
        self.cloud = cloud_of(self.shape)
        c = self.cloud
        uvw = lambda p: list(c.to_uvw(p))  # noqa: E731
        t = self.shape["taps"]
        self.soft = {"hips": 0.55, "chest": 0.74, "neck": 0.82, "blend": 0.05,
                     "leftShoulder": uvw(t["leftShoulder"]), "leftHand": uvw(t["leftHand"]),
                     "rightShoulder": uvw(t["rightShoulder"]), "rightHand": uvw(t["rightHand"])}

    def test_legacy_flow_without_the_new_taps(self):
        p = rp.plan("humanoid", self.cloud, soft=self.soft)
        rp.validate_plan(p)
        names = set(p.names())
        self.assertTrue({"hips", "spine", "chest", "neck", "head", "leftUpperArm", "leftHand", "rightUpperArm", "leftUpperLeg", "rightFoot"} <= names)
        self.assertEqual(sorted(p.info["arms"]), ["left", "right"])
        self.assertEqual(sorted(p.info["legs"]), ["left", "right"])

    def test_elbows_knees_ankles_and_chin_are_used(self):
        t = taps_uvw(self.cloud, self.shape)
        # move the tapped elbow and knee off the straight line so the taps are visible in the result
        t["leftElbow"] = list(self.cloud.to_uvw((0.40, 0.0, 1.22)))
        t["leftKnee"] = list(self.cloud.to_uvw((0.12, -0.04, 0.48)))
        p = rp.plan("humanoid", self.cloud, soft=self.soft, taps_uvw=t)
        rp.validate_plan(p)
        self.assertLess(rp.dist(bone(p, "leftLowerArm")[1], (0.40, 0.0, 1.22)), 1e-6)
        self.assertLess(rp.dist(bone(p, "leftLowerLeg")[1], (0.12, -0.04, 0.48)), 1e-6)
        self.assertLess(abs(bone(p, "rightFoot")[1][2] - 0.12), 1e-6)
        self.assertLess(abs(bone(p, "head")[1][2] - 1.46), 0.02)
        self.assertIn("Head placed at the chin.", p.notes)
        # character's left is +X in Blender
        self.assertGreater(bone(p, "leftUpperArm")[1][0], 0.1)
        self.assertLess(bone(p, "rightUpperArm")[1][0], -0.1)

    def _joint_soft(self):
        c = self.cloud
        uvw = lambda p: list(c.to_uvw(p))  # noqa: E731
        soft = dict(self.soft)
        soft["joints"] = {
            "hips": uvw((0.0, 0.0, 0.95)), "chest": uvw((0.0, 0.0, 1.25)), "neck": uvw((0.0, 0.0, 1.38)), "head": uvw((0.0, 0.0, 1.47)),
            "leftUpperArm": uvw((0.2, 0.0, 1.3)), "leftLowerArm": uvw((0.41, 0.0, 1.25)), "leftHand": uvw((0.7, 0.0, 1.3)),
            "leftUpperLeg": uvw((0.1, 0.0, 0.92)), "leftLowerLeg": uvw((0.1, 0.02, 0.5)), "leftFoot": uvw((0.1, 0.0, 0.1)),
        }
        return soft

    def test_pose_joints_from_the_picture_are_used_when_there_are_no_taps(self):
        p = rp.plan("humanoid", self.cloud, soft=self._joint_soft())
        rp.validate_plan(p)
        self.assertLess(rp.dist(bone(p, "leftLowerArm")[1], (0.41, 0.0, 1.25)), 1e-6)
        self.assertLess(rp.dist(bone(p, "leftLowerLeg")[1], (0.1, 0.02, 0.5)), 1e-6)
        self.assertEqual(p.info["arms"], ["left"])      # only the left side was found on the picture
        self.assertEqual(p.info["legs"], ["left"])
        # the original hand tail: past the wrist by 0.35 of the forearm
        h = bone(p, "leftHand")
        self.assertLess(rp.dist(h[2], rp.add(h[1], rp.mul(rp.sub(h[1], bone(p, "leftLowerArm")[1]), 0.35))), 1e-6)

    def test_taps_beat_the_pose_joints(self):
        t = {"leftElbow": list(self.cloud.to_uvw((0.45, 0.0, 1.2))), "leftAnkle": list(self.cloud.to_uvw((0.1, 0.0, 0.14))),
             "chin": list(self.cloud.to_uvw((0.0, -0.05, 1.5)))}
        p = rp.plan("humanoid", self.cloud, soft=self._joint_soft(), taps_uvw=t)
        self.assertLess(rp.dist(bone(p, "leftLowerArm")[1], (0.45, 0.0, 1.2)), 1e-6)
        self.assertLess(rp.dist(bone(p, "leftFoot")[1], (0.1, 0.0, 0.14)), 1e-6)
        self.assertAlmostEqual(bone(p, "head")[1][2], 1.5, delta=1e-6)


class Dispatch(unittest.TestCase):
    def test_unknown_template(self):
        with self.assertRaises(rp.PlanError):
            rp.plan("wombat", cloud_of(shapes.person()))


if __name__ == "__main__":
    unittest.main(verbosity=1)
