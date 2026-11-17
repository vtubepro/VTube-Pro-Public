"""
hair_kit.strands — child strands around guides + Blender CURVES HAIR with the Essentials hair node groups.

  children(guides, ...)       numpy interpolation: every child root is scattered on the scalp around its guide's
                              root; its shape is a distance-weighted blend of the 3 nearest guides (true
                              interpolation, like Interpolate Hair Curves), then CLUMPED toward its own guide with
                              a root->tip clump profile, with per-child length variation.
  curves_object(strands)      a Blender Curves (new hair system, 3.3+) object from strands (+ int attribute
                              'clump' = guide index), optionally attached to a scalp surface.
  gn_stack(obj, ...)          appends the bundled Essentials node groups (datafiles/assets/nodes/
                              procedural_hair_node_assets.blend: Frizz / Trim / Smooth / Curl / Hair Curves Noise)
                              as a geometry-nodes modifier stack, evaluates it and reads the strands back.

The strands are the "design" of the hair; hair_kit.locks turns each clump of strands into a real-time lock mesh
(width / orientation measured from the strands' spread) and the thin wild strands into flyaway ribbons.
"""
from __future__ import annotations

import os

import numpy as np

from .core import unit, smoothstep, resample

ASSETS = None


def _asset_path():
    import bpy
    base = os.path.dirname(bpy.app.binary_path)
    v = f'{bpy.app.version[0]}.{bpy.app.version[1]}'
    for p in (os.path.join(base, v, 'datafiles', 'assets', 'nodes', 'procedural_hair_node_assets.blend'),
              os.path.join(base, v, 'datafiles', 'assets', 'geometry_nodes', 'procedural_hair_node_assets.blend')):
        if os.path.exists(p):
            return p
    return None


def transport_frames(G):
    T = unit(np.gradient(G, axis=0))
    n = len(G)
    ref = np.array([0, 0, 1.0]) if abs(T[0][2]) < 0.9 else np.array([1.0, 0, 0])
    U = np.zeros_like(G)
    U[0] = unit(np.cross(T[0], ref))
    for i in range(1, n):
        u = U[i - 1] - T[i] * (U[i - 1] @ T[i])
        U[i] = unit(u) if np.linalg.norm(u) > 1e-8 else U[i - 1]
    V = np.cross(T, U)
    return T, U, V


def children(head, guides, per_guide=12, spread=0.012, clump=0.75, clump_shape=1.6, length_var=0.25, rng=None,
             interp_k=3, tip_spread=0.15):
    """Child strands. guides: list of (n,3) arrays with equal n. Returns (strands (M,n,3), clump index (M,),
    t_len (M,) relative length)."""
    rng = rng or np.random.default_rng(0)
    G = np.stack(guides)                                  # (g, n, 3)
    g, n, _ = G.shape
    roots = G[:, 0]
    frames = [transport_frames(Gi) for Gi in G]
    out, cid, lens = [], [], []
    t = np.linspace(0, 1, n)
    spreads = np.broadcast_to(np.asarray(spread, float), (g,))
    pers = np.broadcast_to(np.asarray(per_guide, int), (g,))
    for i in range(g):
        # root spread = an ellipse on the scalp, long ACROSS the flow (locks are flat, wide ribbons of strands)
        T0 = frames[i][0][0]
        rad = unit(roots[i] - head.c)
        lat0 = unit(np.cross(rad, T0))
        alo = unit(np.cross(lat0, rad))
        for _ in range(int(pers[i])):
            a = rng.uniform(0, 2 * np.pi); r = spreads[i] * np.sqrt(rng.uniform(0.05, 1))
            r0 = roots[i] + (lat0 * np.cos(a) + alo * 0.25 * np.sin(a)) * r
            loc, nrm, dist = head.nearest(r0, head.head_bvh)
            if loc is not None and dist < 0.02:
                r0 = loc + nrm * 0.0015
            # interpolate the shape from the nearest guides (offsets relative to each guide's root)
            d = np.linalg.norm(roots - r0, axis=1)
            nn = np.argsort(d)[:interp_k]
            w = 1 / np.maximum(d[nn], 1e-4) ** 2; w /= w.sum()
            shape = sum(wk * (G[k] - G[k][0]) for wk, k in zip(w, nn))
            S = r0 + shape
            # clump toward the own guide (root free, tip pulled in), tips fan a little
            ck = clump * smoothstep(0.0, 1.0, t) ** (1 / clump_shape)
            off = S - G[i]
            S = G[i] + off * (1 - ck)[:, None] + off * (tip_spread * smoothstep(0.7, 1.0, t))[:, None]
            out.append(S); cid.append(i)
            lens.append(1 - length_var * rng.random() ** 1.5)
    return np.array(out), np.array(cid), np.array(lens)


def trim(strands, rel_len):
    """Shorten each strand to rel_len of its length (resampled, same point count)."""
    out = np.empty_like(strands)
    for k, (S, f) in enumerate(zip(strands, rel_len)):
        seg = np.linalg.norm(np.diff(S, axis=0), axis=1)
        cum = np.r_[0, np.cumsum(seg)]
        s = np.linspace(0, cum[-1] * f, len(S))
        out[k] = np.stack([np.interp(s, cum, S[:, j]) for j in range(3)], 1)
    return out


# ============================================================================================ Blender curves hair
def curves_object(strands, name='HK_Strands', clump=None, surface=None):
    import bpy
    cv = bpy.data.hair_curves.new(name)
    n = strands.shape[1]
    cv.add_curves([n] * len(strands))
    cv.attributes['position'].data.foreach_set('vector', strands.reshape(-1).astype(np.float32))
    if clump is not None:
        a = cv.attributes.new('clump', 'INT', 'CURVE')
        a.data.foreach_set('value', np.asarray(clump, np.int32))
    o = bpy.data.objects.new(name, cv)
    bpy.context.scene.collection.objects.link(o)
    if surface is not None:
        cv.surface = surface
        if surface.data.uv_layers:
            cv.surface_uv_map = surface.data.uv_layers[0].name
    return o


def load_groups(names):
    import bpy
    p = _asset_path()
    if p is None:
        raise RuntimeError('procedural_hair_node_assets.blend not found in this Blender install')
    have = [n for n in names if n not in bpy.data.node_groups]
    if have:
        with bpy.data.libraries.load(p, link=False) as (src, dst):
            dst.node_groups = [n for n in have if n in src.node_groups]
    return {n: bpy.data.node_groups[n] for n in names if n in bpy.data.node_groups}


def gn_stack(obj, steps):
    """steps: list of (group name, {input name: value}). Each becomes a Geometry Nodes modifier running the
    Essentials node group. Returns the evaluated strands (M, n, 3)."""
    import bpy
    groups = load_groups([s[0] for s in steps])
    for gname, params in steps:
        if gname not in groups:
            print('[hair_kit] missing node group', gname)
            continue
        md = obj.modifiers.new(gname, 'NODES')
        md.node_group = groups[gname]
        ident = {it.name: it.identifier for it in groups[gname].interface.items_tree
                 if it.item_type == 'SOCKET' and it.in_out == 'INPUT'}
        for k, v in params.items():
            if k in ident:
                try:
                    md[ident[k]] = v
                except (TypeError, KeyError) as e:
                    print('[hair_kit] could not set', gname, k, e)
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    cv = ev.data
    P = np.zeros(len(cv.points) * 3, np.float32)
    cv.attributes['position'].data.foreach_get('vector', P)
    sizes = np.array([c.points_length for c in cv.curves])
    P = P.reshape(-1, 3)
    if (sizes == sizes[0]).all():
        return P.reshape(len(sizes), sizes[0], 3).astype(float)
    # different point counts (e.g. after trimming by points): resample
    out, k = [], 0
    n = int(np.median(sizes))
    for s in sizes:
        out.append(resample(P[k:k + s], n)); k += s
    return np.array(out)
