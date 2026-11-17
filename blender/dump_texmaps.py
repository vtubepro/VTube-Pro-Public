"""
Dump a generated avatar's body texture plus per-texel world position / normal maps (rasterised in UV space)
so texture repaints can be developed in plain numpy outside Blender.

    blender -b --factory-startup --python blender/dump_texmaps.py -- model.glb out_dir

Writes out_dir/albedo.png, out_dir/maps.npz (pos HxWx3, nrm HxWx3, cov HxW bool; Blender world, z up).
"""
import os
import sys

import bpy
import numpy as np

ARGV = sys.argv[sys.argv.index('--') + 1:]
src, out = ARGV[0], os.path.abspath(ARGV[1])
os.makedirs(out, exist_ok=True)
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=src)
body = max((o for o in bpy.data.objects if o.type == 'MESH'), key=lambda o: len(o.data.vertices))
img = None
for mat in body.data.materials:
    for n in mat.node_tree.nodes:
        if n.type == 'TEX_IMAGE' and n.image and (img is None or n.image.size[0] > img.size[0]):
            img = n.image
W, H = img.size
px = np.empty(W * H * 4, np.float32)
img.pixels.foreach_get(px)
px = px.reshape(H, W, 4)
img.filepath_raw = os.path.join(out, 'albedo.png')
img.file_format = 'PNG'
img.save()

me = body.data
me.calc_loop_triangles()
M = body.matrix_world
N3 = M.to_3x3().inverted().transposed()
co = np.array([tuple(M @ v.co) for v in me.vertices], np.float32)
vn = np.array([tuple((N3 @ v.normal).normalized()) for v in me.vertices], np.float32)
uvl = np.empty(len(me.loops) * 2, np.float32)
me.uv_layers.active.data.foreach_get('uv', uvl)
uvl = uvl.reshape(-1, 2)
pos = np.zeros((H, W, 3), np.float32)
nrm = np.zeros((H, W, 3), np.float32)
cov = np.zeros((H, W), bool)
for t in me.loop_triangles:
    L = list(t.loops)
    V = list(t.vertices)
    uv = uvl[L] * (W, H) - 0.5
    x0, y0 = np.floor(uv.min(0)).astype(int) - 1
    x1, y1 = np.ceil(uv.max(0)).astype(int) + 1
    x0, y0 = max(x0, 0), max(y0, 0)
    x1, y1 = min(x1, W - 1), min(y1, H - 1)
    if x1 < x0 or y1 < y0:
        continue
    xs, ys = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
    a, b, c = uv
    den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
    if abs(den) < 1e-12:
        continue
    w0 = ((b[1] - c[1]) * (xs - c[0]) + (c[0] - b[0]) * (ys - c[1])) / den
    w1 = ((c[1] - a[1]) * (xs - c[0]) + (a[0] - c[0]) * (ys - c[1])) / den
    w2 = 1 - w0 - w1
    e = -0.6 / max(abs(den), 1) ** 0.5          # ~half-texel dilation so seams are covered
    m = (w0 >= e) & (w1 >= e) & (w2 >= e)
    if not m.any():
        continue
    P = w0[m, None] * co[V[0]] + w1[m, None] * co[V[1]] + w2[m, None] * co[V[2]]
    Nn = w0[m, None] * vn[V[0]] + w1[m, None] * vn[V[1]] + w2[m, None] * vn[V[2]]
    yy, xx = ys[m], xs[m]
    pos[yy, xx] = P
    nrm[yy, xx] = Nn
    cov[yy, xx] = True
np.savez_compressed(os.path.join(out, 'maps.npz'), pos=pos, nrm=nrm, cov=cov)
print('DUMP', W, H, 'covered', int(cov.sum()), 'tris', len(me.loop_triangles))
