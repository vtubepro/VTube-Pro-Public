"""Skin-weight transfer from a coarse PROXY mesh to the full-resolution mesh (the low-memory staged mode of the ML rig pack).

The ML model rigs a decimated copy of the mesh; the weights then travel to every vertex of the real mesh:
    nearest point on the proxy's SURFACE  ->  barycentric weights of that triangle's three corners  ->  interpolate the corner
    weights  ->  keep the strongest `max_influences` bones  ->  renormalise to 1.

Pure Python (no bpy, no numpy), so the same code runs inside Blender (blender/mlrig_stage.py hands it a BVH-tree locator), in the
pack's own environment, and in a plain `python -I` test (blender/test_weight_transfer.py). Weights are SPARSE: a dict {bone: weight}
per vertex, so a 100 000-vertex mesh with 4 influences each costs a few hundred thousand floats, not a dense bones x vertices table.

Guarantees (tested): every output vertex has weights summing to 1 (never unweighted), at most `max_influences` bones, no negative
weights, and a vertex whose nearest proxy triangle is wholly on one limb gets only that limb's bones.
"""
import math

MAX_INFLUENCES = 4
EPS = 1e-12


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def closest_point_on_triangle(p, a, b, c):
    """(closest point, (u, v, w)) with closest = u*a + v*b + w*c, u+v+w = 1, all >= 0 (Ericson, Real-Time Collision Detection 5.1.5)."""
    ab, ac, ap = _sub(b, a), _sub(c, a), _sub(p, a)
    d1, d2 = _dot(ab, ap), _dot(ac, ap)
    if d1 <= 0 and d2 <= 0:
        return a, (1.0, 0.0, 0.0)
    bp = _sub(p, b)
    d3, d4 = _dot(ab, bp), _dot(ac, bp)
    if d3 >= 0 and d4 <= d3:
        return b, (0.0, 1.0, 0.0)
    vc = d1 * d4 - d3 * d2
    if vc <= 0 and d1 >= 0 and d3 <= 0:
        v = d1 / (d1 - d3)
        return (a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]), (1.0 - v, v, 0.0)
    cp = _sub(p, c)
    d5, d6 = _dot(ab, cp), _dot(ac, cp)
    if d6 >= 0 and d5 <= d6:
        return c, (0.0, 0.0, 1.0)
    vb = d5 * d2 - d1 * d6
    if vb <= 0 and d2 >= 0 and d6 <= 0:
        w = d2 / (d2 - d6)
        return (a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]), (1.0 - w, 0.0, w)
    va = d3 * d6 - d5 * d4
    if va <= 0 and (d4 - d3) >= 0 and (d5 - d6) >= 0:
        w = (d4 - d3) / ((d4 - d3) + (d5 - d6))
        bc = _sub(c, b)
        return (b[0] + w * bc[0], b[1] + w * bc[1], b[2] + w * bc[2]), (0.0, 1.0 - w, w)
    denom = 1.0 / (va + vb + vc)
    v, w = vb * denom, vc * denom
    pt = (a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w)
    return pt, (1.0 - v - w, v, w)


def barycentric(p, a, b, c):
    """Barycentric coordinates of p's projection on the triangle plane (clamped into the triangle and renormalised)."""
    _, (u, v, w) = closest_point_on_triangle(p, a, b, c)
    return (u, v, w)


def nearest_on_mesh(points, verts, faces):
    """Brute force: for each point the (triangle index, (u, v, w)) of the nearest point on the surface. O(points x triangles):
    for tests and tiny proxies. Blender uses a BVH tree instead (blender/mlrig_stage.py), which returns the same thing."""
    out = []
    for p in points:
        best, hit = float("inf"), (0, (1.0, 0.0, 0.0))
        for ti, f in enumerate(faces):
            q, bc = closest_point_on_triangle(p, verts[f[0]], verts[f[1]], verts[f[2]])
            d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2
            if d < best:
                best, hit = d, (ti, bc)
        out.append(hit)
    return out


def limit_and_normalise(w, max_influences=MAX_INFLUENCES):
    """Keep the strongest `max_influences` bones of {bone: weight}, drop non-positive ones, renormalise to sum 1. Empty -> {}."""
    items = sorted(((b, x) for b, x in w.items() if x > EPS and math.isfinite(x)), key=lambda t: (-t[1], str(t[0])))[:max_influences]
    s = sum(x for _, x in items)
    if s <= EPS:
        return {}
    return {b: x / s for b, x in items}


def interpolate(tri, bary, faces, proxy_weights):
    """Weights at a point of triangle `tri` with barycentric `bary`: the corner weights blended (sparse dicts)."""
    acc = {}
    for corner, k in zip(faces[tri], bary):
        if k <= 0:
            continue
        for bone, x in proxy_weights[corner].items():
            acc[bone] = acc.get(bone, 0.0) + k * x
    return acc


def transfer_weights(points, locate, faces, proxy_weights, proxy_verts=None, max_influences=MAX_INFLUENCES):
    """Weights for every point (a full-resolution mesh's vertices).

    locate(point) -> (triangle index, (u, v, w)) on the proxy surface. proxy_weights[i] is the sparse {bone: weight} of proxy vertex i.
    A point whose triangle corners carry no weight at all (a loose proxy piece the model left unskinned) takes the weights of the
    nearest proxy vertex that has any, so no vertex is ever left unweighted. Returns (list of {bone: weight}, stats).
    """
    weighted = [i for i, w in enumerate(proxy_weights) if sum(w.values()) > EPS]
    if not weighted:
        raise ValueError("The proxy has no skin weights at all: nothing to transfer.")
    out, filled = [], 0
    for p in points:
        tri, bary = locate(p)
        w = limit_and_normalise(interpolate(tri, bary, faces, proxy_weights), max_influences)
        if not w:
            filled += 1
            ref = proxy_verts if proxy_verts is not None else None
            if ref is not None:
                j = min(weighted, key=lambda i: (ref[i][0] - p[0]) ** 2 + (ref[i][1] - p[1]) ** 2 + (ref[i][2] - p[2]) ** 2)
            else:
                j = weighted[0]
            w = limit_and_normalise(dict(proxy_weights[j]), max_influences)
        out.append(w)
    return out, {"points": len(out), "filled_from_nearest_vertex": filled}


def check(weights, max_influences=MAX_INFLUENCES, tol=1e-6):
    """Raise unless every vertex is weighted, sums to 1, has at most `max_influences` bones and no negative weight."""
    for i, w in enumerate(weights):
        if not w:
            raise AssertionError(f"vertex {i} has no weights")
        if len(w) > max_influences:
            raise AssertionError(f"vertex {i} has {len(w)} influences (max {max_influences})")
        if any(x < 0 for x in w.values()):
            raise AssertionError(f"vertex {i} has a negative weight")
        if abs(sum(w.values()) - 1.0) > tol:
            raise AssertionError(f"vertex {i} weights sum to {sum(w.values())}")
    return True
