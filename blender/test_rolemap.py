"""Unit tests for blender/rolemap.py (naming the bones of an ML-made skeleton by position). Pure Python, no Blender.

    python -I blender/test_rolemap.py        (from the repo root)

Round trip: take the planner's skeleton for each test body, scramble every bone name and the bone order (what a learned model's
output looks like), name it again from positions alone, and compare with the planner's own names.
"""
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rigplan as rp  # noqa: E402
import rolemap as rm  # noqa: E402
import test_shapes as shapes  # noqa: E402


def planned(name):
    shape = shapes.ALL[name]()
    v, _ = shapes.mesh_of(shape["parts"])
    cloud = rp.Cloud(v)
    taps = {k: list(cloud.to_uvw(p)) for k, p in shape["taps"].items()}
    soft = {"hips": 0.55, "chest": 0.74, "neck": 0.82, "blend": 0.05} if shape["template"] == "humanoid" else None
    plan = rp.plan(shape["template"], cloud, soft=soft, taps_uvw=taps, body_type=shape.get("bodyType"))
    return shape, cloud, plan


def scramble(bones, seed=3):
    rnd = random.Random(seed)
    ids = list(range(len(bones)))
    rnd.shuffle(ids)
    new = {b[0]: f"Bone.{ids[i]:03d}" for i, b in enumerate(bones)}
    out = [(new[n], h, t, new[p] if p else None) for n, h, t, p in bones]
    rnd.shuffle(out)
    return out, new


class RoundTrip(unittest.TestCase):
    def check(self, name, body_type, hints=None):
        shape, cloud, plan = planned(name)
        scr, new = scramble(plan.bones)
        ren, notes = rm.map_roles(scr, cloud.lo, cloud.hi, body_type, hints)
        self.assertEqual(len(set(ren.values())), len(ren), "no two bones end up with one name")
        return plan, new, ren

    def test_quadruped(self):
        plan, new, ren = self.check("quadruped", "fourLegs", hints={"nose": planned("quadruped")[0]["taps"]["nose"]})
        got = lambda orig: ren.get(new[orig], new[orig])  # noqa: E731
        self.assertEqual(got("hips"), "hips")
        self.assertEqual(got("head"), "head")
        for key in rp.LEG_KEYS:
            for i in (1, 2, 3):
                self.assertEqual(got(f"leg_{key}_{i}"), f"leg_{key}_{i}", f"leg_{key}_{i}")
            self.assertEqual(got(f"leg_{key}_toe"), f"leg_{key}_4")      # the toe continues the chain
        for i in range(1, rp.Q_TAIL_BONES + 1):
            self.assertEqual(got(f"tail_{i}"), f"tail_{i}")
        # the spine path got the humanoid names the runtime needs, once each, in order from the hips
        spine_names = [got(n) for n in ("spine", "chest", "neck", "neck_2")]
        self.assertIn("spine", spine_names)
        self.assertIn("neck", spine_names)

    def test_quadruped_without_hints(self):
        plan, new, ren = self.check("quadruped", "fourLegs")
        self.assertEqual(ren.get(new["head"], new["head"]), "head")
        self.assertEqual(ren.get(new["leg_HR_2"], ""), "leg_HR_2")
        self.assertEqual(ren.get(new["tail_4"], ""), "tail_4")

    def test_bird(self):
        plan, new, ren = self.check("bird", "bird", hints={"nose": planned("bird")[0]["taps"]["nose"]})
        got = lambda orig: ren.get(new[orig], new[orig])  # noqa: E731
        self.assertEqual(got("head"), "head")
        self.assertEqual(got("leg_HL_1"), "leg_HL_1")
        self.assertEqual(got("leg_HR_2"), "leg_HR_2")
        self.assertEqual(got("tail_3"), "tail_3")

    def test_snake(self):
        plan, new, ren = self.check("snake", "tail", hints={"nose": planned("snake")[0]["taps"]["nose"], "tailTip": planned("snake")[0]["taps"]["tailTip"]})
        got = lambda orig: ren.get(new[orig], new[orig])  # noqa: E731
        self.assertEqual(got("head"), "head")
        tail = sorted(n for n in ren.values() if n.startswith("tail_"))
        self.assertTrue(tail, "a tail chain")
        # the tail chain runs from the body toward the far end: tail_1 is the one nearest the hips
        self.assertEqual(ren[new["tail_1"]], "tail_1")

    def test_person(self):
        plan, new, ren = self.check("person", "person")
        got = lambda orig: ren.get(new[orig], new[orig])  # noqa: E731
        self.assertEqual(got("hips"), "hips")
        self.assertEqual(got("head"), "head")
        for n in ("leftUpperLeg", "leftLowerLeg", "leftFoot", "rightUpperLeg", "rightFoot", "leftUpperArm", "leftLowerArm", "leftHand", "rightUpperArm", "rightHand"):
            self.assertEqual(got(n), n, n)


class Edge(unittest.TestCase):
    def test_a_stray_bone_called_head_does_not_collide(self):
        shape, cloud, plan = planned("quadruped")
        scr, new = scramble(plan.bones)
        # one hind-leg bone of the learned rig happens to be called "head"
        victim = new["leg_HL_1"]
        scr = [(("head" if n == victim else n), h, t, ("head" if p == victim else p)) for n, h, t, p in scr]
        ren, _ = rm.map_roles(scr, cloud.lo, cloud.hi, "fourLegs")
        final = [ren.get(b[0], b[0]) for b in scr]
        self.assertEqual(len(set(final)), len(final))
        self.assertEqual(sum(1 for n in final if n == "head"), 1)

    def test_too_small_skeletons_are_refused(self):
        with self.assertRaises(rm.RoleError):
            rm.map_roles([("a", (0, 0, 0), (0, 0, 1), None), ("b", (0, 0, 1), (0, 0, 2), "a")], (0, 0, 0), (1, 1, 2), "person")
        with self.assertRaises(rm.RoleError):
            rm.map_roles([("a", (0, 0, 0), (0, 0, 1), None), ("a", (0, 0, 1), (0, 0, 2), "a")], (0, 0, 0), (1, 1, 2), "person")

    def test_two_trees_pick_the_big_one(self):
        shape, cloud, plan = planned("snake")
        bones = list(plan.bones) + [("junk", (5, 5, 5), (5, 5, 6), None)]
        ren, _ = rm.map_roles(bones, cloud.lo, cloud.hi, "tail", {"nose": shape["taps"]["nose"]})
        self.assertNotIn("junk", ren)


if __name__ == "__main__":
    unittest.main(verbosity=1)
