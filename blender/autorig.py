"""Build an armature from the person's guided taps and skin the meshes.

params: {
  "input": "<model.glb>",
  "output": "<model_rigged.glb>",
  "template": "humanoid" | "quadruped" | "creature" | "object"   # default humanoid (blender/rigplan.py explains each)
  "bodyType": "person" | "fourLegs" | "bird" | "tail" | "thing"  # picks bird vs snake for "creature"
  "taps": { tapId: [u,v,w] }   # shared/rigTaps.ts; [u,v,w] over the glTF bbox (u=x, v=y(up), w=z)
  "soft": SoftRigConfig   # humanoid only. shared/types.ts — heights normalized over the bbox (0 feet .. 1 top),
                          # hands/shoulders as [u,v,w] over the glTF bbox (u=x, v=y(up), w=z); optional "joints"
                          # (every joint, same [u,v,w]) found by body tracking on a render: used first
}
Existing armatures, armature modifiers, vertex groups and actions are stripped first.
Skinning: bone heat (ARMATURE_AUTO) per mesh; if a mesh ends up with poor coverage
we redo it with ARMATURE_ENVELOPE; any vertex still unweighted is bound to its
nearest bone so nothing is left behind when the rig moves.
VTP_OK {"output", "template", "bones": [...], "meshes": [{name, method, coverage}], "coverage", "legs", "arms", "notes"}
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402
from mathutils.geometry import intersect_point_line  # noqa: E402

import common  # noqa: E402
import rigplan  # noqa: E402

COVERAGE_OK = 0.98
SAMPLE_MAX = 60000      # points the new templates' planners look at (models with more are stride-sampled; the person template never is)
DISTANCE_SIGMA = 0.04   # distance-skin falloff, fraction of the model height (metres = this * height)
# skin quality (new templates only; the person template keeps the old coverage-only rule)
BLEED_W = 0.20          # a bone counts for a vertex from this weight up
BLEED_GAP = 0.05        # ... and it is "on the far side" when it is this much farther (fraction of height) than the nearest bone ...
BLEED_K = 2.0           # ... plus this many times the vertex's own distance to its nearest bone
BLEED_MAX = 0.02        # more than 2 % of a mesh's vertices moving with a far bone: not good enough, skin by distance
SEAM_EPS = 0.01         # vertices of two meshes closer than this (fraction of height) form a seam pair
LIMB_REACH = (0.10, 0.18)  # a limb has no weight at all on vertices farther than the second number from it (fraction of height), fading in from the first
SMOOTH_PASSES = 8       # passes of edge averaging after the distance skin, restricted to the same limb chain plus the trunk (soft limb joins)
KEEP_MIN = 0.02         # a bone below this share of a vertex's strongest weight is dropped (at most 4 bones per vertex, the glTF limit)
POSE_DEG = 35.0         # the posed bleed test turns each limb root this far, about two axes
POSE_MOVED_FRAC = 0.0012  # "moved" = more than this * height (2.4 mm on a 2 m llama: stricter than the 5 mm an outside check uses, so it holds after export)
POSE_BLEED_MAX = 0      # vertices nearest another limb that a turned limb may move: none
SEAM_MAX = 0.25         # mean L1 difference of the two weight sets over the seam pairs that sends every mesh to the distance skin


# ---------------------------------------------------------------- stripping

def strip_rigs():
    arms = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
    for o in common.mesh_objects():
        for m in list(o.modifiers):
            if m.type == "ARMATURE":
                o.modifiers.remove(m)
        if o.parent and o.parent.type == "ARMATURE":
            mw = o.matrix_world.copy()
            o.parent = None
            o.matrix_world = mw
        o.vertex_groups.clear()
    for a in arms:
        bpy.data.objects.remove(a, do_unlink=True)
    n_actions = len(bpy.data.actions)
    for act in list(bpy.data.actions):
        bpy.data.actions.remove(act)
    return len(arms), n_actions


# ---------------------------------------------------------------- joint placement

class Geo:
    def __init__(self, meshes):
        dg = bpy.context.evaluated_depsgraph_get()
        self.verts = [v for o in meshes for v in common.world_vertices(o, dg)]
        self.lo, self.hi = common.scene_bbox(meshes)
        self.h = max(self.hi.z - self.lo.z, 1e-6)
        self.center = (self.lo + self.hi) / 2

    def z(self, t):
        return self.lo.z + t * self.h

    def cloud(self, template="humanoid"):
        """The same vertices as plain tuples for blender/rigplan.py (pure geometry, tested without Blender). The person template
        gets every vertex (old callers keep the old numbers on any size of model); the new templates get a deterministic sample
        of at most SAMPLE_MAX points, with the box taken from all of them."""
        return rigplan.Cloud([(v.x, v.y, v.z) for v in self.verts], None if template == "humanoid" else SAMPLE_MAX)

    def slice_centroid(self, z, tol, xmin=None, xmax=None, min_count=8):
        pts = [v for v in self.verts
               if abs(v.z - z) <= tol
               and (xmin is None or v.x >= xmin)
               and (xmax is None or v.x <= xmax)]
        if len(pts) < min_count:
            return None, len(pts)
        n = len(pts)
        return Vector((sum(p.x for p in pts) / n, sum(p.y for p in pts) / n, z)), n

    def from_uvw(self, uvw):
        """Normalized glTF-bbox coords -> Blender world position."""
        u, v, w = uvw
        g_zmin, g_zmax = -self.hi.y, -self.lo.y  # glTF z range
        gz = g_zmin + w * (g_zmax - g_zmin)
        return Vector((self.lo.x + u * (self.hi.x - self.lo.x), -gz, self.lo.z + v * self.h))


def plan_bones(geo, soft, taps=None, template="humanoid", body_type=None):
    """Return (bones, info). bones: list of (name, head, tail, parent) with mathutils Vectors.
    The geometry lives in blender/rigplan.py (pure Python, unit-tested without Blender): humanoid keeps the original plans
    (joints found on a render first, else the soft-rig heights) and now also uses the chin / elbow / knee / ankle taps;
    quadruped / creature / object are the new templates built from the animal / thing taps."""
    plan = rigplan.plan(template, geo.cloud(template), soft=soft, taps_uvw=taps or {}, body_type=body_type)
    bones = [(n, Vector(h), Vector(t), par) for n, h, t, par in plan.bones]
    info = {"arms": plan.info.get("arms", []), "legs": plan.info.get("legs", []), "notes": plan.notes}
    if template == "quadruped":
        info["legs"] = [k for k in rigplan.LEG_KEYS if any(bn[0] == f"leg_{k}_1" for bn in bones)]
    return bones, info


def build_armature(bones, height, thin=1.0):
    """thin scales the envelope sizes down for slim bodies (a snake, a lamp stem) so the fallback skin stays local."""
    data = bpy.data.armatures.new("Armature")
    arm = bpy.data.objects.new("Armature", data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    arm.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = data.edit_bones
    for name, head, tail, parent in bones:
        b = eb.new(name)
        b.head, b.tail = head, tail
        if (b.tail - b.head).length < 1e-4:
            b.tail = b.head + Vector((0, 0, height * 0.02))
        b.head_radius = b.tail_radius = height * 0.05 * thin
        b.envelope_distance = height * 0.12 * thin
        if parent:
            b.parent = eb[parent]
            b.use_connect = (eb[parent].tail - b.head).length < 1e-5
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm


# ---------------------------------------------------------------- skinning

def weighted_fraction(obj):
    me = obj.data
    if not me.vertices:
        return 1.0
    covered = sum(1 for v in me.vertices if any(g.weight > 1e-4 for g in v.groups))
    return covered / len(me.vertices)


def parent_with(obj, arm, kind):
    for m in list(obj.modifiers):
        if m.type == "ARMATURE":
            obj.modifiers.remove(m)
    obj.vertex_groups.clear()
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type=kind)


def fill_unweighted(obj, arm):
    """Bind every vertex without weights to its nearest bone segment."""
    segs = [(b.name, arm.matrix_world @ b.head_local, arm.matrix_world @ b.tail_local) for b in arm.data.bones]
    mw = obj.matrix_world
    filled = 0
    for v in obj.data.vertices:
        if any(g.weight > 1e-4 for g in v.groups):
            continue
        p = mw @ v.co
        best, best_d = None, float("inf")
        for name, a, b in segs:
            q, t = intersect_point_line(p, a, b)
            q = a if t < 0 else b if t > 1 else q
            d = (p - q).length
            if d < best_d:
                best, best_d = name, d
        vg = obj.vertex_groups.get(best) or obj.vertex_groups.new(name=best)
        vg.add([v.index], 1.0, "REPLACE")
        filled += 1
    return filled


_LEG = re.compile(r"^leg_([FH][LR])_")
_WING = re.compile(r"^wing_([LR])_")
_LIMB_ROOT = re.compile(r"^(leg_[FH][LR]_1|wing_[LR]_1|tail_1)$")


def limb_of(name):
    """(chain id, side) of a bone: 'leg_FL' / 'wing_R' / 'tail' (side +1 = the animal's left, -1 = right, 0 = on the middle line),
    or (None, 0.0) for the trunk (hips spine chest neck head, a thing's bend chain)."""
    m = _LEG.match(name)
    if m:
        return "leg_" + m.group(1), (1.0 if m.group(1)[1] == "L" else -1.0)
    m = _WING.match(name)
    if m:
        return "wing_" + m.group(1), (1.0 if m.group(1) == "L" else -1.0)
    if name.startswith("tail_"):
        return "tail", 0.0
    return None, 0.0


def body_frame(arm):
    """(middle point, the animal's left direction) from hips -> head, or None. Same convention as blender/rigplan.py (left = up x forward)."""
    bones = arm.data.bones
    if "hips" not in bones or "head" not in bones:
        return None
    mw = arm.matrix_world
    h0, h1 = mw @ bones["hips"].head_local, mw @ bones["head"].tail_local
    f = Vector((h1.x - h0.x, h1.y - h0.y, 0.0))
    if f.length < 1e-6:
        return None
    f.normalize()
    return h0, Vector((-f.y, f.x, 0.0))


def distance_skin(obj, arm, sigma, keep=4):
    """Last-resort skin for the new templates when bone heat and envelopes both fail (typical for models made of
    overlapping parts: the heat solver needs one clean volume). Each vertex takes its `keep` nearest bone segments with
    weights falling off by distance, so bends blend instead of tearing. Replaces any existing weights on the object.
    Limbs stay apart: a vertex whose nearest bone is in a limb chain (a leg, a wing, the tail) is influenced by that chain and the
    trunk only, never by another limb; a vertex nearest the trunk may use a limb only on its own side of the middle plane
    (the weights of a leg fade to zero across it). That is what keeps a turned hind leg from dragging the other one.
    The join between a limb and the trunk is soft: SMOOTH_PASSES passes of averaging over the mesh's edges follow, each restricted to
    the same limb chain plus the trunk (so smoothing can never carry a leg's weight to another limb). Without it the hard switch at the
    limb / trunk boundary creased hind legs and tails when turned. Vertices at the same spot (UV seams) share one set of weights."""
    import numpy as np  # bundled with Blender
    bones = list(arm.data.bones)
    nb = len(bones)
    height = sigma / DISTANCE_SIGMA
    a = np.array([tuple(arm.matrix_world @ b.head_local) for b in bones], dtype=np.float64)
    b = np.array([tuple(arm.matrix_world @ b.tail_local) for b in bones], dtype=np.float64)
    ab = b - a
    ab2 = np.maximum((ab * ab).sum(axis=1), 1e-12)
    chains = sorted({limb_of(bn.name)[0] for bn in bones} - {None})
    cid = np.array([chains.index(limb_of(bn.name)[0]) if limb_of(bn.name)[0] else -1 for bn in bones])
    side = np.array([limb_of(bn.name)[1] for bn in bones])
    frame = body_frame(arm)
    mw = obj.matrix_world
    allp = np.array([tuple(mw @ v.co) for v in obj.data.vertices], dtype=np.float64)
    if len(allp) == 0:
        return
    key = np.round(allp * 1e5).astype(np.int64)
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    inv = inv.reshape(-1)
    pts = allp[first]                       # one point per spot
    m = len(pts)
    if frame:
        lat = (pts - np.array(tuple(frame[0]))) @ np.array(tuple(frame[1]))
    else:
        lat = np.zeros(m)
    gate = np.zeros((m, nb))
    G = np.zeros((m, nb))
    near = np.zeros(m, dtype=np.int64)
    for i0 in range(0, m, 4096):
        chunk = pts[i0:i0 + 4096]
        ap = chunk[:, None, :] - a[None, :, :]
        t = np.clip((ap * ab[None, :, :]).sum(axis=2) / ab2[None, :], 0.0, 1.0)
        d = np.linalg.norm(ap - t[:, :, None] * ab[None, :, :], axis=2)
        nr = d.argmin(axis=1)
        dmin = d[np.arange(len(chunk)), nr]
        near[i0:i0 + 4096] = nr
        near_c = cid[nr]
        own = cid[None, :] == near_c[:, None]
        trunk = cid[None, :] == -1
        # side factor for a limb the vertex is not nearest to: 0 on the other side of the middle plane, 1 on its own, a short ramp across
        x = np.clip((lat[i0:i0 + 4096, None] * side[None, :] + 0.01 * height) / (0.02 * height), 0.0, 1.0)
        sidef = np.where(side[None, :] == 0.0, 1.0, x * x * (3.0 - 2.0 * x))
        allowed = trunk | own | ((near_c == -1)[:, None] & (cid[None, :] >= 0))
        # reach: smoothing must never carry a limb's weight far along the body (a few millimetres at 35 degrees is still a crease)
        reach = np.ones_like(d)
        for c in range(len(chains)):
            cols = cid == c
            x = np.clip((LIMB_REACH[1] * height - d[:, cols].min(axis=1)) / ((LIMB_REACH[1] - LIMB_REACH[0]) * height), 0.0, 1.0)
            reach[:, cols] = (x * x * (3.0 - 2.0 * x))[:, None]
        gate[i0:i0 + 4096] = allowed * np.where(own, 1.0, sidef) * reach
        G[i0:i0 + 4096] = np.exp(-((d - dmin[:, None]) ** 2) / (2.0 * sigma * sigma))
    W = G * gate
    W[np.arange(m), near] = np.maximum(W[np.arange(m), near], 1e-3)       # (never empty)
    # smoothing over the edges, restricted by the same gate
    if SMOOTH_PASSES > 0 and len(obj.data.edges):
        e = np.array([(ed.vertices[0], ed.vertices[1]) for ed in obj.data.edges], dtype=np.int64)
        ea, eb = inv[e[:, 0]], inv[e[:, 1]]
        keep_e = ea != eb
        ea, eb = ea[keep_e], eb[keep_e]
        deg = np.bincount(np.concatenate([ea, eb]), minlength=m).astype(np.float64)
        for _ in range(SMOOTH_PASSES):
            S = np.zeros_like(W)
            np.add.at(S, ea, W[eb])
            np.add.at(S, eb, W[ea])
            avg = np.where(deg[:, None] > 0, S / np.maximum(deg[:, None], 1.0), W)
            W = (0.5 * W + 0.5 * avg) * gate
            W[np.arange(m), near] = np.maximum(W[np.arange(m), near], 1e-3)
    obj.vertex_groups.clear()
    groups = [obj.vertex_groups.new(name=bn.name) for bn in bones]
    top = np.argsort(-W, axis=1)[:, :keep]
    for vi in range(len(allp)):
        row = inv[vi]
        idx = top[row]
        ww = W[row, idx]
        ww = np.where(ww < KEEP_MIN * ww.max(), 0.0, ww)
        ww = ww / ww.sum()
        for k, bi in enumerate(idx):
            if ww[k] > 1e-4:
                groups[int(bi)].add([vi], float(ww[k]), "REPLACE")
    # the armature modifier / parent link the bone-heat attempts left behind stays valid; make sure it exists
    if not any(md.type == "ARMATURE" for md in obj.modifiers):
        mod = obj.modifiers.new("Armature", "ARMATURE")
        mod.object = arm
    if obj.parent != arm:
        mwx = obj.matrix_world.copy()
        obj.parent = arm
        obj.matrix_world = mwx


def limb_pose_bleed(meshes, arm, height):
    """The posed test (the one that matters): turn each limb's root bone 35 degrees about two axes and count the vertices that move
    more than POSE_MOVED_FRAC * height although their nearest bone (at rest) is in ANOTHER limb chain. Returns
    ({limb root: count}, {chain: {mesh index: [vertex index, ...]}} of the offenders, total vertices)."""
    import math
    import numpy as np
    from mathutils import Quaternion
    bones = list(arm.data.bones)
    names = [bn.name for bn in bones]
    chains = sorted({limb_of(n)[0] for n in names} - {None})
    cid = np.array([chains.index(limb_of(n)[0]) if limb_of(n)[0] else -1 for n in names])
    a = np.array([tuple(arm.matrix_world @ b.head_local) for b in bones], dtype=np.float64)
    b = np.array([tuple(arm.matrix_world @ b.tail_local) for b in bones], dtype=np.float64)
    ab = b - a
    ab2 = np.maximum((ab * ab).sum(axis=1), 1e-12)

    def world():
        dg = bpy.context.evaluated_depsgraph_get()
        return np.array([tuple(p) for o in meshes for p in common.world_vertices(o, dg)], dtype=np.float64)

    bpy.context.view_layer.update()
    P0 = world()
    near = np.empty(len(P0), dtype=np.int64)
    for i0 in range(0, len(P0), 4096):
        ap = P0[i0:i0 + 4096, None, :] - a[None, :, :]
        t = np.clip((ap * ab[None, :, :]).sum(axis=2) / ab2[None, :], 0.0, 1.0)
        near[i0:i0 + 4096] = np.linalg.norm(ap - t[:, :, None] * ab[None, :, :], axis=2).argmin(axis=1)
    near_c = cid[near]
    offs = np.cumsum([0] + [len(o.data.vertices) for o in meshes])
    counts, offenders = {}, {}
    for r in [n for n in names if _LIMB_ROOT.match(n)]:
        chain = limb_of(r)[0]
        pb = arm.pose.bones[r]
        pb.rotation_mode = "QUATERNION"
        moved = np.zeros(len(P0), dtype=bool)
        for ax in ((1, 0, 0), (0, 0, 1)):
            pb.rotation_quaternion = Quaternion(ax, math.radians(POSE_DEG))
            bpy.context.view_layer.update()
            moved |= np.linalg.norm(world() - P0, axis=1) > POSE_MOVED_FRAC * height
        pb.rotation_quaternion = Quaternion((1, 0, 0, 0))
        bpy.context.view_layer.update()
        bad = np.nonzero(moved & (near_c >= 0) & (near_c != chains.index(chain)))[0]
        counts[r] = int(len(bad))
        if len(bad):
            per = offenders.setdefault(chain, {})
            for gi in bad:
                mi = int(np.searchsorted(offs, gi, side="right") - 1)
                per.setdefault(mi, []).append(int(gi - offs[mi]))
    return counts, offenders, len(P0)


def cut_limb_weights(meshes, arm, offenders):
    """Last step when the posed test still finds a limb dragging a vertex of another limb: those vertices lose the weights of the
    limb that moved them (the rest is re-normalised; a vertex left with nothing goes to its nearest bone). Returns how many."""
    n = 0
    for chain, per in offenders.items():
        chain_bones = {bn.name for bn in arm.data.bones if limb_of(bn.name)[0] == chain}
        for mi, idxs in per.items():
            o = meshes[mi]
            for vg in o.vertex_groups:
                if vg.name in chain_bones:
                    try:
                        vg.remove(idxs)
                    except RuntimeError:
                        pass
            for vi in idxs:
                ws = [(g.group, g.weight) for g in o.data.vertices[vi].groups if g.weight > 1e-6]
                tot = sum(w for _, w in ws)
                if tot > 1e-6:
                    for gi, w in ws:
                        o.vertex_groups[gi].add([vi], w / tot, "REPLACE")
            n += len(idxs)
    return n


def _weights_matrix(obj, bone_index):
    """(N, B) numpy array of the object's vertex weights by bone."""
    import numpy as np
    me = obj.data
    W = np.zeros((len(me.vertices), len(bone_index)), dtype=np.float64)
    names = {g.index: g.name for g in obj.vertex_groups}
    for v in me.vertices:
        for g in v.groups:
            j = bone_index.get(names.get(g.group))
            if j is not None:
                W[v.index, j] = g.weight
    return W


def skin_bleed(obj, arm, height):
    """Share of the object's vertices that move with a bone on the far side of the body: a bone with a real weight (>= BLEED_W)
    that is much farther from the vertex than the vertex's nearest bone (an opposite leg, the tail on a hind leg). 0 = clean."""
    import numpy as np
    bones = list(arm.data.bones)
    bone_index = {b.name: i for i, b in enumerate(bones)}
    a = np.array([tuple(arm.matrix_world @ b.head_local) for b in bones], dtype=np.float64)
    b = np.array([tuple(arm.matrix_world @ b.tail_local) for b in bones], dtype=np.float64)
    ab = b - a
    ab2 = np.maximum((ab * ab).sum(axis=1), 1e-12)
    mw = obj.matrix_world
    pts = np.array([tuple(mw @ v.co) for v in obj.data.vertices], dtype=np.float64)
    if len(pts) == 0:
        return 0.0
    W = _weights_matrix(obj, bone_index)
    bad = 0
    for i0 in range(0, len(pts), 4096):
        ap = pts[i0:i0 + 4096, None, :] - a[None, :, :]
        t = np.clip((ap * ab[None, :, :]).sum(axis=2) / ab2[None, :], 0.0, 1.0)
        d = np.linalg.norm(ap - t[:, :, None] * ab[None, :, :], axis=2)
        dmin = d.min(axis=1)
        far = d > (dmin[:, None] + BLEED_GAP * height + BLEED_K * dmin[:, None])
        bad += int(((W[i0:i0 + 4096] >= BLEED_W) & far).any(axis=1).sum())
    return bad / len(pts)


def seam_error(objs, arm, height):
    """Mean L1 difference between the weights of vertices of DIFFERENT meshes that sit (nearly) on the same spot, e.g. the neck
    seam of a head mesh and a body mesh. Returns (pairs, mean_l1); (0, 0.0) when there is no seam."""
    import numpy as np
    from mathutils import kdtree
    if len(objs) < 2:
        return 0, 0.0
    bone_index = {b.name: i for i, b in enumerate(arm.data.bones)}
    data = []
    for o in objs:
        mw = o.matrix_world
        co = [mw @ v.co for v in o.data.vertices]
        data.append((co, _weights_matrix(o, bone_index)))
    eps = SEAM_EPS * height
    tot, pairs = 0.0, 0
    for i in range(len(objs)):
        kd = kdtree.KDTree(len(data[i][0]))
        for k, c in enumerate(data[i][0]):
            kd.insert(c, k)
        kd.balance()
        for j in range(i + 1, len(objs)):
            for k, c in enumerate(data[j][0]):
                hit = kd.find_n(c, 1)
                if hit and hit[0][2] <= eps:
                    tot += float(np.abs(data[i][1][hit[0][1]] - data[j][1][k]).sum())
                    pairs += 1
    return pairs, (tot / pairs if pairs else 0.0)


def main(p):
    common.reset_scene()
    common.import_model(p["input"])
    removed_arms, removed_actions = strip_rigs()
    # a mesh object named like a bone ("head", "hips") makes three.js rename the bone on load: rename the mesh
    bone_names = {"hips", "spine", "chest", "neck", "head", "leftUpperArm", "leftLowerArm", "leftHand", "rightUpperArm", "rightLowerArm",
                  "rightHand", "leftUpperLeg", "leftLowerLeg", "leftFoot", "rightUpperLeg", "rightLowerLeg", "rightFoot"}
    for o in common.mesh_objects():
        if o.name in bone_names or o.name.split(".")[0] in bone_names:
            o.name = o.name + "_mesh"
    meshes = common.mesh_objects()
    if not meshes:
        raise RuntimeError("Model has no meshes to rig")
    geo = Geo(meshes)
    template = p.get("template") or "humanoid"
    try:
        bones, info = plan_bones(geo, p.get("soft") or {}, p.get("taps") or {}, template, p.get("bodyType"))
    except rigplan.PlanError as e:
        raise RuntimeError(str(e)) from e
    taken = {bn[0] for bn in bones}
    for o in meshes:   # same rule for the new templates' bones (leg_FL_1, tail_1, chain_1 ...)
        if o.name in taken or o.name.split(".")[0] in taken:
            o.name = o.name + "_mesh"
    # slim bodies: the envelope fallback must not reach across the whole model
    thin = 1.0 if template in ("humanoid", "quadruped") else 0.4
    arm = build_armature(bones, geo.h, thin)
    common.log("armature bones:", [b[0] for b in bones])

    report = []
    total_v = total_cov = 0
    for o in meshes:
        method = "heat"
        try:
            parent_with(o, arm, "ARMATURE_AUTO")
            cov = weighted_fraction(o)
        except RuntimeError as e:
            common.log("heat weighting error on", o.name, e)
            cov = 0.0
        if cov < COVERAGE_OK:
            common.log(f"bone heat coverage {cov:.2%} on {o.name}; retrying with envelopes")
            heat_cov = cov
            parent_with(o, arm, "ARMATURE_ENVELOPE")
            cov = weighted_fraction(o)
            method = "envelope"
            if heat_cov > cov:  # heat was better after all
                parent_with(o, arm, "ARMATURE_AUTO")
                cov, method = weighted_fraction(o), "heat"
        bleed = None
        if template != "humanoid":
            # quality, not only coverage: a heat / envelope skin that drags a leg with the opposite leg is no better than a gap
            bleed = skin_bleed(o, arm, geo.h)
            if cov < COVERAGE_OK or bleed > BLEED_MAX:
                common.log(f"{method} skin on {o.name}: coverage {cov:.2%}, far-bone bleed {bleed:.2%}; skinning by distance to the bones")
                distance_skin(o, arm, geo.h * DISTANCE_SIGMA)
                cov, method = weighted_fraction(o), "distance"
        filled = fill_unweighted(o, arm)
        n = len(o.data.vertices)
        row = {"name": o.name, "method": method, "coverage": round(cov, 4), "filled": filled, "vertices": n}
        if bleed is not None:
            row["bleed_before"] = round(bleed, 4)
            row["bleed"] = round(skin_bleed(o, arm, geo.h), 4) if method == "distance" else round(bleed, 4)
        report.append(row)
        total_v += n
        total_cov += cov * n
        common.log(f"skinned {o.name}: {method} coverage {cov:.2%}, nearest-bone filled {filled}")

    seam = None
    if template != "humanoid" and len(meshes) > 1:
        # the seam between meshes skinned in different ways (llama: body by distance, head by heat): a pull at the join
        pairs, err = seam_error(meshes, arm, geo.h)
        seam = {"pairs": pairs, "mean_l1": round(err, 4), "switched": False}
        if pairs and err > SEAM_MAX and len({r["method"] for r in report}) > 1:
            common.log(f"seam between meshes: mean weight difference {err:.2f} over {pairs} vertex pairs; skinning every mesh by distance")
            for o, r in zip(meshes, report):
                if r["method"] != "distance":
                    distance_skin(o, arm, geo.h * DISTANCE_SIGMA)
                    r["method"], r["coverage"] = "distance", round(weighted_fraction(o), 4)
                    r["bleed"] = round(skin_bleed(o, arm, geo.h), 4)
            pairs, err = seam_error(meshes, arm, geo.h)
            seam.update(switched=True, mean_l1_after=round(err, 4))
        common.log("seam:", seam)
    limb = None
    if template != "humanoid":
        # the posed test: turn every limb 35 degrees and see what else moves (the rest-pose numbers above cannot see this)
        counts, offenders, nv = limb_pose_bleed(meshes, arm, geo.h)
        limb = {"before": counts, "vertices": nv, "fixed_by": []}
        if sum(counts.values()) > POSE_BLEED_MAX and any(r["method"] != "distance" for r in report):
            common.log(f"posed test: {sum(counts.values())} vertices follow another limb; skinning every mesh by distance")
            for o, r in zip(meshes, report):
                if r["method"] != "distance":
                    distance_skin(o, arm, geo.h * DISTANCE_SIGMA)
                    r["method"], r["coverage"] = "distance", round(weighted_fraction(o), 4)
            counts, offenders, nv = limb_pose_bleed(meshes, arm, geo.h)
            limb["fixed_by"].append("distance")
        for _ in range(2):
            if sum(counts.values()) <= POSE_BLEED_MAX:
                break
            cut = cut_limb_weights(meshes, arm, offenders)
            common.log(f"posed test: {sum(counts.values())} vertices still follow another limb; cut the weights of {cut}")
            counts, offenders, nv = limb_pose_bleed(meshes, arm, geo.h)
            limb["fixed_by"].append(f"cut {cut}")
        limb["after"] = counts
        limb["total_after"] = sum(counts.values())
        common.log("limb pose test:", limb["total_after"], "vertices follow another limb")
    common.export_glb(p["output"])
    return {
        "output": p["output"],
        "template": template,
        "limb_pose_test": limb,
        "seam": seam,
        "notes": info.get("notes", []),
        "bones": [b[0] for b in bones],
        "meshes": report,
        "coverage": round(total_cov / max(total_v, 1), 4),
        "arms": info["arms"],
        "legs": info["legs"],
        "removed_armatures": removed_arms,
        "removed_actions": removed_actions,
    }


if __name__ == "__main__":
    common.run_main(main)
