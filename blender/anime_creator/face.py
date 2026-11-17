"""
Face shape tuning on the VRoid Face mesh: smooth local warps (eye size / height, face width, chin
length, jaw narrowing) applied to the rest geometry AND every morph delta, so all VRoid expressions
and the derived ARKit shapes stay consistent with the new face.
"""
from __future__ import annotations

import numpy as np

from .mathx import smoothstep
from .vroid import Model, MeshData


def prim_of(m: Model, d: MeshData, key: str) -> list[int]:
    return [i for i, p in enumerate(d.prims) if key in m.mat_name(p['material'])]


def tongue_verts(m: Model, d: MeshData, mouth_prim: int) -> np.ndarray:
    v = d.verts_of(mouth_prim)
    uv = d.UV[v]
    return v[(uv[:, 0] >= 0.5) & (uv[:, 1] < 0.5)]


def teeth_verts(m: Model, d: MeshData, mouth_prim: int) -> np.ndarray:
    v = d.verts_of(mouth_prim)
    uv = d.UV[v]
    return v[(uv[:, 0] < 0.5) & (uv[:, 1] < 0.5)]


def eye_centers(m: Model, d: MeshData):
    ew = d.verts_of(prim_of(m, d, 'EyeWhite'))
    P = d.P[ew]
    L = P[P[:, 0] < 0].mean(0); R = P[P[:, 0] > 0].mean(0)
    return L, R


def mouth_center(m: Model, d: MeshData):
    return d.P[d.verts_of(prim_of(m, d, 'FaceMouth'))].mean(0)


def _warp(d: MeshData, fn):
    """fn(P) -> (newP, J) with J the per-vertex 3x3 linear part used for morph deltas."""
    P2, Jm = fn(d.P)
    d.P = P2
    for t in d.targets:
        t['POSITION'] = np.einsum('vab,vb->va', Jm, t['POSITION'])


def apply(m: Model, fp: dict, ctx):
    fi = m.mesh_index('Face')
    d = m.read_mesh(fi)
    L, R = eye_centers(m, d)
    mc = mouth_center(m, d)
    changed = []
    es = float(fp.get('eyeSize', 1.0)); eh = float(fp.get('eyeHeight', 0.0)); tilt = float(fp.get('eyeTilt', 0.0))
    if es != 1 or eh or tilt:
        def f(P):
            P2 = P.copy(); Jm = np.tile(np.eye(3), (len(P), 1, 1))
            for c, sgn in ((L, -1), (R, 1)):
                rel = P - c
                r = np.sqrt((rel[:, 0] / 1.15) ** 2 + (rel[:, 1] * 1.25) ** 2)
                w = 1 - smoothstep(0.022, 0.040, r)
                w *= (P[:, 2] < c[2] + 0.035)
                k = 1 + (es - 1) * w
                ang = np.radians(tilt) * sgn * w * -1
                ca, sa = np.cos(ang), np.sin(ang)
                x = rel[:, 0] * k; y = rel[:, 1] * k
                P2[:, 0] += (ca * x - sa * y) - rel[:, 0]
                P2[:, 1] += (sa * x + ca * y) - rel[:, 1] + eh * 0.01 * w
                Jm[:, 0, 0] *= k; Jm[:, 1, 1] *= k
            return P2, Jm
        _warp(d, f); changed.append('eyes')
    fw = float(fp.get('faceWidth', 1.0)); chin = float(fp.get('chin', 0.0)); jaw = float(fp.get('jaw', 1.0))
    if fw != 1 or chin or jaw != 1:
        cx = 0.0
        eye_y = (L[1] + R[1]) / 2

        def f(P):
            P2 = P.copy(); Jm = np.tile(np.eye(3), (len(P), 1, 1))
            low = smoothstep(eye_y + 0.02, mc[1] - 0.01, P[:, 1])      # 0 above eyes .. 1 at mouth and below
            front = 1 - smoothstep(-0.02, 0.06, P[:, 2] - mc[2])       # fade out towards the back of the head
            kx = 1 + (fw - 1) * (0.5 + 0.5 * low) * front
            under = smoothstep(mc[1] + 0.005, mc[1] - 0.045, P[:, 1])   # chin area
            kx = kx * (1 + (jaw - 1) * under * front)
            P2[:, 0] = cx + (P[:, 0] - cx) * kx
            P2[:, 1] -= chin * 0.012 * under * front
            Jm[:, 0, 0] = kx
            return P2, Jm
        _warp(d, f); changed.append('shape')
    if changed:
        m.write_mesh(fi, d)
        ctx['log'](f"face: {', '.join(changed)}")
