"""Name the bones of a skeleton made by a learned model (the optional ML pack: SkinTokens / UniRig) with the names the studio
understands, from where the bones are. PURE GEOMETRY (no bpy): blender/mlrig_adopt.py applies the result inside Blender and
blender/test_rolemap.py checks it under plain Python.

A learned rig comes with arbitrary bone names and order. The studio's runtime reads roles from names (hips spine chest neck head,
leg_FL_1.., tail_1.., see blender/rigplan.py), so each bone gets its role from its place in the tree and in space:

  hips   the root bone of the biggest tree          head  the end of the spine path (the leaf nearest the nose tap when given,
  spine / chest / neck  the bones on the path        else the highest leaf that is not a foot)
  leg_FL_n ...  chains ending in feet (the lowest leaves): front / hind by where they stand along the body, left / right by side
  tail_n  the chain that ends farthest behind the head       (everything else keeps its own name)

Space: Blender world, +Z up. Bones are (name, head, tail, parent) like rigplan plans.
"""
import math

import rigplan as rp

RESERVED = ("hips", "spine", "chest", "neck", "head")
LEG_MAX = 7
TAIL_MAX = 12
FOOT_BAND = 0.22          # a leaf in the lowest 22 % of the model's height is a foot


class RoleError(ValueError):
    pass


def _tree(bones):
    names = [b[0] for b in bones]
    if len(set(names)) != len(names):
        raise RoleError("duplicate bone names")
    by = {b[0]: b for b in bones}
    kids = {n: [] for n in names}
    roots = []
    for n, h, t, par in bones:
        if par is None or par not in by:
            roots.append(n)
        else:
            kids[par].append(n)
    return by, kids, roots


def _subtree(kids, n, memo):
    if n in memo:
        return memo[n]
    s = 1 + sum(_subtree(kids, c, memo) for c in kids[n])
    memo[n] = s
    return s


def _leaves_under(kids, n):
    out, stack = [], [n]
    while stack:
        x = stack.pop()
        if not kids[x]:
            out.append(x)
        stack.extend(kids[x])
    return out


def _path_to_root(by, n):
    out = [n]
    while by[out[-1]][3] in by:
        out.append(by[out[-1]][3])
    return out[::-1]


def map_roles(bones, lo, hi, body_type=None, hints=None):
    """Return ({old name: new name}, notes). lo / hi = the mesh's bounding box corners. hints: {"nose": pt, "tailTip": pt} (world)."""
    hints = hints or {}
    by, kids, roots = _tree(bones)
    if not roots:
        raise RoleError("the skeleton has no root bone")
    memo = {}
    root = max(roots, key=lambda r: _subtree(kids, r, memo))
    height = max(hi[2] - lo[2], 1e-6)
    notes = []
    tail_of = lambda n: by[n][2]            # noqa: E731
    head_of = lambda n: by[n][1]            # noqa: E731
    leaves = _leaves_under(kids, root)
    if len(leaves) < 1 or _subtree(kids, root, memo) < 3:
        raise RoleError("the skeleton has too few bones to name")
    z_foot = lo[2] + FOOT_BAND * height
    upright = body_type in (None, "person", "thing")
    is_foot = lambda n: tail_of(n)[2] <= z_foot   # noqa: E731

    # ---- head
    nose = hints.get("nose")
    if nose is not None:
        head = min(leaves, key=lambda n: rp.dist(tail_of(n), nose))
        notes.append("Head chosen by the nose tap.")
    else:
        cand = [n for n in leaves if not is_foot(n)] or leaves
        head = max(cand, key=lambda n: tail_of(n)[2])
    spine_path = _path_to_root(by, head)               # root .. head
    if len(spine_path) < 3:
        raise RoleError("the spine is too short to name")
    mapping = {}
    mapping[spine_path[0]] = "hips"
    mapping[spine_path[-1]] = "head"
    interior = spine_path[1:-1]
    n = len(interior)
    neck_count = 0 if n == 1 else max(1, int(round(n * 0.35)))
    neck_bones = interior[n - neck_count:] if neck_count else []
    rest = interior[:n - neck_count] if neck_count else interior
    for i, b in enumerate(neck_bones):
        mapping[b] = "neck" if i == 0 else f"neck_{i + 1}"
    if rest:
        mapping[rest[0]] = "spine"
        if len(rest) >= 2:
            mapping[rest[-1]] = "chest"
        for i, b in enumerate(rest[1:-1]):
            mapping[b] = f"body_{i + 1}"
    on_spine = set(spine_path)

    # ---- directions
    hp = head_of(spine_path[0])
    fwd = rp.norm(rp.horiz(rp.sub(tail_of(head), hp)), (0.0, -1.0, 0.0))
    left = rp.norm(rp.cross(rp.UP, fwd), (1.0, 0.0, 0.0))

    # ---- legs: chains ending at a foot that hang off the spine path
    side_branches = {}
    for leaf in leaves:
        if leaf in on_spine:
            continue
        chain = []
        x = leaf
        while x not in on_spine and by[x][3] in by:
            chain.append(x)
            x = by[x][3]
        chain = chain[::-1]
        if chain:
            side_branches.setdefault(chain[0], []).append(chain + [])
    feet = [(leaf_chain[-1], leaf_chain) for chains in side_branches.values() for leaf_chain in chains if is_foot(leaf_chain[-1])]
    # a leg can fork into toes: keep the longest chain per attachment
    legs = {}
    for foot, chain in feet:
        key = chain[0]
        if key not in legs or len(chain) > len(legs[key]):
            legs[key] = chain
    leg_list = list(legs.values())
    if upright and body_type == "person":
        _person_limbs(mapping, by, kids, leaf_chains=side_branches, legs=leg_list, left=left, fwd=fwd, on_spine=on_spine, hp=hp, notes=notes, is_foot=is_foot)
    else:
        if leg_list:
            s_mid = sorted(rp.dot(tail_of(c[-1]), fwd) for c in leg_list)[len(leg_list) // 2]
            for chain in leg_list:
                foot = tail_of(chain[-1])
                front = len(leg_list) >= 4 and rp.dot(foot, fwd) > s_mid - 1e-9 and rp.dot(foot, fwd) > min(rp.dot(tail_of(c[-1]), fwd) for c in leg_list) + 0.05 * height
                if len(leg_list) < 4:
                    front = False                       # a bird or a two-legged animal: hind legs only (leg_H*)
                side = "L" if rp.dot(rp.sub(foot, hp), left) >= 0 else "R"
                tag = ("F" if front else "H") + side
                for i, b in enumerate(chain[:LEG_MAX]):
                    mapping.setdefault(b, f"leg_{tag}_{i + 1}")
        # ---- tail: the non-foot leaf farthest behind the head
        taken = set(mapping)
        tail_leaves = [l for l in leaves if l not in taken and not is_foot(l) and l not in on_spine]
        tip = hints.get("tailTip")
        if tail_leaves:
            if tip is not None:
                leaf = min(tail_leaves, key=lambda n: rp.dist(tail_of(n), tip))
            else:
                leaf = min(tail_leaves, key=lambda n: rp.dot(tail_of(n), fwd))
            chain = []
            x = leaf
            while x not in on_spine and x not in mapping and by[x][3] in by:
                chain.append(x)
                x = by[x][3]
            for i, b in enumerate(chain[::-1][:TAIL_MAX]):
                mapping[b] = f"tail_{i + 1}"
    # unused names that would collide with a reserved one: keep unique
    targets = set(mapping.values())
    renames = {}
    for old, new in mapping.items():
        renames[old] = new
    for n_ in by:
        if n_ not in renames and (n_ in targets or n_ in RESERVED or n_.startswith(("leg_", "tail_", "wing_"))):
            renames[n_] = "x_" + n_
    if len(set(renames.values())) != len(renames) or any(v in by and v not in renames for v in renames.values()):
        # a rename would land on a name another bone keeps: prefix those untouched bones
        for n_ in list(by):
            if n_ not in renames and n_ in renames.values():
                renames[n_] = "x_" + n_
    return renames, notes


def _person_limbs(mapping, by, kids, leaf_chains, legs, left, fwd, on_spine, hp, notes, is_foot):
    """People: a foot chain gives UpperLeg / LowerLeg / Foot (its first three bones); the two widest hand chains give
    UpperArm / LowerArm / Hand (with a collar bone first, skip it). Best effort: check the shoulders and hips."""
    tail_of = lambda n: by[n][2]    # noqa: E731
    sides = lambda c: "left" if rp.dot(rp.sub(tail_of(c[-1]), hp), left) >= 0 else "right"   # noqa: E731
    seen = set()
    for chain in sorted(legs, key=lambda c: -len(c)):
        side = sides(chain)
        if side in seen or len(chain) < 3:
            continue
        seen.add(side)
        for b, role in zip(chain[:3], ("UpperLeg", "LowerLeg", "Foot")):
            mapping.setdefault(b, f"{side}{role}")
    arms = [c for chains in leaf_chains.values() for c in chains if not is_foot(c[-1]) and c[0] not in mapping]
    arms.sort(key=lambda c: -abs(rp.dot(rp.sub(tail_of(c[-1]), hp), left)))
    seen = set()
    for chain in arms:
        side = sides(chain)
        if side in seen or len(chain) < 3:
            continue
        seen.add(side)
        start = 1 if len(chain) >= 5 else 0           # a collar bone comes first on longer chains
        for b, role in zip(chain[start:start + 3], ("UpperArm", "LowerArm", "Hand")):
            mapping.setdefault(b, f"{side}{role}")
    notes.append("Arms and legs were matched by position; check the shoulders and hips.")
