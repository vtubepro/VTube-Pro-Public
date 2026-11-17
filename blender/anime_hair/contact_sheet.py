"""Render the anime hair style library on the base head (CC0 VRoid 'Sakurada Fumiriya', own hair removed).

  blender -b --factory-startup --python contact_sheet.py -- <out_dir> [styles comma list] [views comma list] [res]

Writes <out_dir>/<style>_<view>.png and <out_dir>/contact_sheet.png (front + three-quarter of every style)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import bpy  # noqa: E402
import numpy as np  # noqa: E402

from anime_hair import scene, styles, build  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
BASE = os.path.join(ROOT, 'tools', 'vendor', 'vroid', 'Sakurada_Fumiriya.vrm')

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(argv[0]) if argv else os.path.join(ROOT, 'cache', 'hair_sheet')
names = argv[1].split(',') if len(argv) > 1 and argv[1] else list(styles.STYLES)
views = argv[2].split(',') if len(argv) > 2 and argv[2] else ['front', 'tq']
RES = int(argv[3]) if len(argv) > 3 else 400
os.makedirs(OUT, exist_ok=True)
VIEWS = {'front': (0, 0), 'tq': (35, 5), 'side': (90, 0), 'back': (180, 5), 'tql': (-35, 5), 'top': (20, 55)}

paths = []
for nm in names:
    arm, B = scene.load_base(BASE)
    heads = [o for o in bpy.data.objects if o.type == 'MESH']
    F = scene.head_frame(B, heads)
    res = styles.STYLES[nm](F, np.random.default_rng(7))
    only = os.environ.get('HAIR_ONLY')
    if only:
        res.clumps = [c for c in res.clumps if c.layer in only.split(',')]
    out = build.build(F, res, 'Hair', tex_path=os.path.join(OUT, f'tex_{nm}.png'))
    print(f'STYLE {nm}: {len(res.clumps)} clumps, {len(out["hair"].data.vertices)} verts')
    scene.toonify_scene()
    scene.outline_all(0.0011)
    cam = scene.setup_render((RES, RES))
    long_ = nm in ('long_straight', 'twin_tails', 'ponytail')
    ctr = F.c + np.array([0, 0, -0.1 if long_ else -0.03])
    span = 0.62 if long_ else 0.36
    for v in views:
        yaw, pitch = VIEWS[v]
        p = os.path.join(OUT, f'{nm}_{v}.png')
        scene.shoot(cam, p, ctr, span, yaw, pitch)
        paths.append(p)
scene.sheet(paths, os.path.join(OUT, 'contact_sheet.png'), cols=len(views) * (2 if len(names) > 1 else 1))
