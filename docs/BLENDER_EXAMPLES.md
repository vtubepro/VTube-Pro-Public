# VTube Pro — tested Blender examples (prop, room, costume, test harness, install script)

Companion to [BLENDER_PLAYBOOK.md](BLENDER_PLAYBOOK.md). Every script below was run on this machine on 2026-09-26
(Blender 5.1.2, Python 3.14, Node 24) and its output checked; the results are listed under each example. Copy a script
into your own staging folder or next to the asset it builds (`assets/scenes/<id>/blender/`), then run it through the
Blender lock routine (playbook section 3.2). Nothing here is imported by the app.

Contents
- [Example A — a stand-alone prop](#example-a--a-stand-alone-prop)
- [Example B — a small room (headless or live window)](#example-b--a-small-room-headless-or-live-window)
- [Example C — a costume for Sprocket](#example-c--a-costume-for-sprocket)
- [Checking a GLB](#checking-a-glb)
- [Private test tree: vite.config.ts](#private-test-tree-viteconfigts)
- [Read-only mock API (mock.py)](#read-only-mock-api-mockpy)
- [Install script (code changes)](#install-script-code-changes)

---

## Example A — a stand-alone prop

A desk lamp: two lathe profiles, a metal base with baked AO in `COLOR_0`, an `EMIT_lamps` shade on a `LIGHT_DESK_01`
node with light extras, origin at the base, exported as its own GLB.

```text
tools\blender_low.cmd -b --factory-startup --python C:\...\build_prop_lamp.py -- C:\...\stage\prop
```

Verified: `PROP ...\prop_lamp.glb 384 tris 10876 bytes`; `node tools/gltf_validate.mjs prop_lamp.glb` gives 0 errors,
0 warnings, 2 draw calls.

```python
"""A stand-alone room prop (a desk lamp) as its own GLB: origin at the base centre, front = glTF +Z, metres, linear
colours, an EMIT_<group> shade the light engine can drive, a LIGHT_* node with extras, baked AO in COLOR_0.
(docs/BLENDER_PLAYBOOK.md section 5)

    tools\\blender_low.cmd -b --factory-startup --python <abs path>\\build_prop_lamp.py -- <out_dir>
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector
from mathutils.bvhtree import BVHTree

ARGV = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(ARGV[0] if ARGV else '.')
bpy.ops.wm.read_factory_settings(use_empty=True)


def G(x, y, z):                                  # glTF -> Blender
    return Vector((x, -z, y))


def lin(h):
    h = h.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)


def material(name, hex_, rough=0.7, emit=None, strength=2.0):
    m = bpy.data.materials.new(name); m.use_nodes = True; b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*lin(hex_), 1); b.inputs['Roughness'].default_value = rough
    if emit:
        b.inputs['Emission Color'].default_value = (*lin(emit), 1); b.inputs['Emission Strength'].default_value = strength
    return m


def lathe(profile, n=24):
    """revolve [(radius, height)] (glTF metres, bottom -> top) about the vertical axis"""
    bm = bmesh.new()
    rings = [[bm.verts.new(G(r * math.cos(a), y, r * math.sin(a))) for r, y in profile]
             for a in (i / n * math.tau for i in range(n))]
    for i in range(n):
        A, Bq = rings[i], rings[(i + 1) % n]
        for j in range(len(profile) - 1):
            bm.faces.new((A[j], A[j + 1], Bq[j + 1], Bq[j]))
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def obj(name, bm, mat):
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    for p in me.polygons:
        p.use_smooth = True
    o = bpy.data.objects.new(name, me); me.materials.append(mat); bpy.context.scene.collection.objects.link(o)
    return o


metal = material('M_LampMetal', '#2e3440', 0.4)
shade = material('EMIT_lamps', '#ffd28a', 0.8, emit='#ffd28a', strength=2.4)
base = obj('LampBase', lathe([(0.0, 0.0), (0.09, 0.0), (0.09, 0.015), (0.05, 0.03), (0.012, 0.035), (0.012, 0.42), (0.0, 0.42)]), metal)
lamp = obj('LIGHT_DESK_01', lathe([(0.03, 0.40), (0.07, 0.40), (0.12, 0.52), (0.035, 0.52)]), shade)
lamp['group'], lamp['color'], lamp['kind'], lamp['range'] = 'lamps', '#ffd28a', 'point', 3.0

# AO into COLOR_0 (rooms have no runtime shadows): hemisphere rays against the prop itself
bvh = BVHTree.FromObject(base, bpy.context.evaluated_depsgraph_get())
me = base.data; col = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER'); vals = []
for li, lp in enumerate(me.loops):
    v = me.vertices[lp.vertex_index]; n = v.normal; hits = 0
    for k in range(12):
        a = k * 2.399963; r = math.sqrt((k + 0.5) / 12)
        t = n.orthogonal().normalized(); bt = n.cross(t)
        d = t * (r * math.cos(a)) + bt * (r * math.sin(a)) + n * math.sqrt(1 - r * r)
        hits += bvh.ray_cast(v.co + n * 0.002, d, 0.15)[0] is not None
    ao = 1.0 - 0.6 * hits / 12
    vals += [ao, ao, ao, 1.0]
col.data.foreach_set('color', vals); me.color_attributes.active_color = col

os.makedirs(OUT, exist_ok=True)
path = os.path.join(OUT, 'prop_lamp.glb')
bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_yup=True, export_apply=True, export_extras=True,
                          export_lights=False, export_cameras=False, export_vertex_color='ACTIVE')
tris = sum(len(p.vertices) - 2 for o in (base, lamp) for p in o.data.polygons)
print('PROP', path, tris, 'tris', os.path.getsize(path), 'bytes')
```

---

## Example B — a small room (headless or live window)

Self-contained (no project imports): shell with a door hole, couch with three sit spots (+ `approach`,
`leavePathAt`), two stand spots, `DOOR` hinged at its origin, `DOOR_OUTSIDE`, `PATH_01..03`, a 16:9 `SCREEN` with
0..1 UVs and `restOffsetY`, `SCREEN_SOLO`, a neon strip (`EMIT_neon`, `LIGHT_NEON_01` kind emissive) and a floor lamp
(`EMIT_lamps`, `LIGHT_LAMP_01` kind point), two `COLLIDE_*` boxes, `CAM_WIDE` / `CAM_REACT` / `CAM_DOOR` /
`SPOT_02_CAM`, the vertex-colour bake (AO + key + fill + pools + per-part tint, with both tint pitfalls fixed), GLB
post-processing (`EMIT_*` emissive strength + extras, hidden collider material), and a scene.json that keeps
hand-added keys. Distilled from `assets/scenes/my_kitchen_room/blender/mk_room.py` + `mk_lib.py`.

```text
headless:  tools\blender_low.cmd -b --factory-startup --python C:\...\build_small_room.py -- --out C:\...\stage\my_room
```

```powershell
# live window (user off air): a normal Blender at below-normal priority
$blender = Join-Path $env:ProgramFiles 'Blender Foundation\Blender 5.1\blender.exe'
$script  = 'C:\...\build_small_room.py'; $out = 'C:\...\stage\my_room'
$p = Start-Process $blender -ArgumentList "--factory-startup --python `"$script`" -- --live --out `"$out`"" -PassThru
$p.PriorityClass = 'BelowNormal'
```

`--out` defaults to the folder above the script, so a copy at `assets/scenes/<id>/blender/build_<id>.py` writes
`assets/scenes/<id>/scene.glb` + `scene.json` (the folder name becomes the room id).

Verified:
- headless and live-window runs both end with `scene.glb 4422 tris` (the live run takes about 14 s: six steps with the
  header text and the view easing onto each part, dollhouse cut-away of the ceiling);
- `gltf_validate.mjs`: 0 errors, 0 warnings, 13 draw calls, 10 materials;
- `COLOR_0` on every baked mesh (FLOOR, WALLS, CEILING, FURNITURE, DOOR), none on lights / colliders / screen;
- in the app (private tree + mock, `output.html?sceneTest=aidocs_small_room&cam=wide&extra=frog,robot&screen=placeholder`):
  the room parsed 5 spots, 3 cameras, 2 fixtures, emissive groups `neon` + `lamps`, 2 colliders, path
  `PATH_01..03`; three avatars sat on the couch; the lamp pool and AO read in the render; `preview.png` / `thumb.png`
  were captured with the playbook's section 11.4 snippet.

Change these first when you grow it: the `EMIT` / `FLAT` tables (your palette), the steps (your landmarks), the
spots / cameras, `pools` in the bake step (one per light source), `info` in `export()` (name, ambience, lights).

```python
"""Small VTube Pro room, complete: shell, door + walk-in path, couch + stand spots, react + solo screen, neon + lamp
fixtures, colliders, cameras, vertex-colour light bake, GLB post-processing, scene.json. Blender 5.1, no add-ons.
(docs/BLENDER_PLAYBOOK.md section 6 - distilled from assets/scenes/my_kitchen_room/blender/mk_room.py + mk_lib.py)

    headless : tools\\blender_low.cmd -b --factory-startup --python <abs path>\\build_small_room.py -- [--out DIR]
    live     : "C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe" --factory-startup
                   --python <abs path>\\build_small_room.py -- --live [--out DIR]

--out defaults to the folder above this script (assets/scenes/<id>/ when the script sits in <id>/blender/).
Coordinates below are glTF: metres, x right, y up, z towards the camera (stage front). G() converts to Blender.
"""
import bpy, bmesh, math, os, sys, json, struct, time
from mathutils import Vector, Matrix, Euler
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))
ARGV = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
LIVE = '--live' in ARGV
OUT = os.path.abspath(ARGV[ARGV.index('--out') + 1]) if '--out' in ARGV else os.path.dirname(HERE)
ROOM_ID = os.path.basename(OUT.rstrip('\\/'))
rad = math.radians
T0 = time.time()


def log(*a):
    print('[room %5.1fs]' % (time.time() - T0), *a, flush=True)


def G(x, y, z):                      # glTF (x, y up, z front) -> Blender (x, y back, z up)
    return Vector((x, -z, y))


def lin(h):                          # sRGB hex -> linear (glTF colour factors are LINEAR)
    h = h.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)


# ------------------------------------------------------------------ materials (one per look; EMIT_<group> = light engine)
EMIT = {'neon': ('#ff3a8c', 3.0), 'lamps': ('#ffd28a', 2.4)}
FLAT = {'M_Wall': ('#5d6b7a', 0.9), 'M_Floor': ('#8a6b4e', 0.7), 'M_Ceiling': ('#9aa3ad', 0.95), 'M_Couch': ('#3f7f5a', 0.9),
        'M_Wood': ('#7a4a2a', 0.7), 'M_Dark': ('#202226', 0.8), 'M_Hidden': ('#000000', 1.0), 'SCREEN': ('#050505', 0.3)}
MATS = {}


def mat(name):
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    if name.startswith('EMIT_'):
        col, s = EMIT[name[5:]]
        b.inputs['Base Color'].default_value = (*[c * 0.05 for c in lin(col)], 1)
        b.inputs['Emission Color'].default_value = (*lin(col), 1)
        b.inputs['Emission Strength'].default_value = s
    else:
        col, r = FLAT[name]
        b.inputs['Base Color'].default_value = (*lin(col), 1); b.inputs['Roughness'].default_value = r
    m.diffuse_color = (*lin(col), 1)          # solid-mode colour, so the live window reads right
    MATS[name] = m
    return m


# ------------------------------------------------------------------ parts: bmesh -> object in WORK, joined per bucket later
BUCKETS = {}


def coll(name):
    c = bpy.data.collections.get(name)
    if not c:
        c = bpy.data.collections.new(name); bpy.context.scene.collection.children.link(c)
    return c


def add(bucket, bm, material, tile=1.0, tint=(1.0, 1.0, 1.0), name='part'):
    """box-projected UVs (tile metres per texture repeat). EVERY part gets a `tint` (white = untinted): joining a tinted
    part with untinted ones gives the untinted ones tint 0 = baked black (the tint-join pitfall)."""
    uvl = bm.loops.layers.uv.verify()
    bm.normal_update()
    for f in bm.faces:
        n = f.normal; ax = max(range(3), key=lambda i: abs(n[i]))
        for lp in f.loops:
            co = lp.vert.co
            u, v = (co.x, co.y) if ax == 2 else (co.y, co.z) if ax == 0 else (co.x, co.z)
            lp[uvl].uv = (u / tile, v / tile)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    a = me.attributes.new('tint', 'FLOAT_COLOR', 'POINT')
    a.data.foreach_set('color', [*tint, 1.0] * len(me.vertices))
    ob = bpy.data.objects.new(name, me); ob.data.materials.append(mat(material))
    coll('WORK').objects.link(ob)
    BUCKETS.setdefault(bucket, []).append(ob)
    return ob


def join(bucket, name):
    obs = BUCKETS.pop(bucket, [])
    if not obs:
        return None
    for o in bpy.context.scene.objects:
        o.select_set(False)
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    if len(obs) > 1:
        bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name; ob.data.name = name
    for c in list(ob.users_collection):
        c.objects.unlink(ob)
    coll('EXPORT').objects.link(ob)
    return ob


def set_origin(ob, loc_b):
    """move the object origin to loc (Blender space) without moving the geometry (door hinges, rotating props)"""
    d = Vector(loc_b) - ob.location
    ob.data.transform(Matrix.Translation(-d)); ob.location = Vector(loc_b)


def gbox(size, center, seg=0.5):
    """box (Blender-space size / centre) whose faces are quad grids <= seg m: the per-vertex bake needs resolution"""
    bm = bmesh.new(); h = Vector(size) / 2
    for ax in range(3):
        ua, va = [a for a in range(3) if a != ax]
        nu = max(1, math.ceil(size[ua] / seg)); nv = max(1, math.ceil(size[va] / seg))
        for sgn in (-1, 1):
            rows = []
            for j in range(nv + 1):
                row = []
                for i in range(nu + 1):
                    co = [0.0, 0.0, 0.0]
                    co[ax] = sgn * h[ax]; co[ua] = -h[ua] + size[ua] * i / nu; co[va] = -h[va] + size[va] * j / nv
                    row.append(bm.verts.new(co))
                rows.append(row)
            for j in range(nv):
                for i in range(nu):
                    q = [rows[j][i], rows[j][i + 1], rows[j + 1][i + 1], rows[j + 1][i]]
                    bm.faces.new(q if sgn > 0 else q[::-1])
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    return bm


def B(bucket, material, x0, x1, y0, y1, z0, z1, tile=1.0, tint=(1.0, 1.0, 1.0)):
    """axis-aligned box from glTF extents"""
    size = (abs(x1 - x0), abs(z1 - z0), abs(y1 - y0))
    return add(bucket, gbox(size, G((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)), material, tile, tint)


def C(bucket, material, x, y, z, r, h, n=16, tint=(1.0, 1.0, 1.0)):
    """cylinder standing on glTF (x, y, z)"""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=n, radius1=r, radius2=r, depth=h)
    bmesh.ops.translate(bm, vec=G(x, y + h / 2, z), verts=bm.verts)
    return add(bucket, bm, material, 1.0, tint)


def empty(name, x, y, z, yaw=0.0, **extras):
    """engine anchor. yaw 0 = faces stage front (glTF +Z); + = turned towards +X. extras -> glTF extras (userData)"""
    e = bpy.data.objects.new(name, None); e.empty_display_type = 'SINGLE_ARROW'; e.empty_display_size = 0.4
    e.location = G(x, y, z); e.rotation_euler = Euler((0, 0, rad(yaw)))
    for k, v in extras.items():
        e[k] = v
    coll('EXPORT').objects.link(e)
    return e


CAMS = {}


def cam(name, pos, target, fov=38.0):
    """glTF camera looking from pos to target (glTF points), vertical fov in degrees"""
    cd = bpy.data.cameras.new(name); cd.sensor_fit = 'VERTICAL'; cd.angle_y = rad(fov); cd.clip_start = 0.05; cd.clip_end = 200
    o = bpy.data.objects.new(name, cd); o.location = G(*pos)
    o.rotation_euler = (G(*target) - G(*pos)).to_track_quat('-Z', 'Y').to_euler()
    coll('EXPORT').objects.link(o); CAMS[name] = (pos, target, fov)
    return o


# ------------------------------------------------------------------ the build, as steps (the live window shows each one)
STEPS = []


def step(title, focus=(0, 1.2, 0), dist=12.0, yaw=20.0, pitch=62.0):
    def deco(fn):
        STEPS.append((title, fn, focus, dist, yaw, pitch))
        return fn
    return deco


XW, ZB, ZF, YC = 4.0, -3.0, 3.0, 3.4          # half width, back wall, open front edge, ceiling
DOOR_Z0, DOOR_Z1, DOOR_H = 0.6, 1.6, 2.1       # door hole in the left wall (towards the front)


@step('Shell: floor, walls with a door hole, ceiling', (0, 1.0, 0), 14, 25, 60)
def shell():
    B('floor', 'M_Floor', -XW, XW, -0.1, 0, ZB, ZF, tile=1.2)
    B('floor', 'M_Floor', -XW - 2.0, -XW, -0.1, 0, DOOR_Z0 - 0.3, DOOR_Z1 + 0.3, tile=1.2)          # hallway outside the door
    B('walls', 'M_Wall', -XW, XW, 0, YC, ZB - 0.12, ZB)
    B('walls', 'M_Wall', XW, XW + 0.12, 0, YC, ZB, ZF)
    B('walls', 'M_Wall', -XW - 0.12, -XW, 0, YC, ZB, DOOR_Z0)
    B('walls', 'M_Wall', -XW - 0.12, -XW, 0, YC, DOOR_Z1, ZF)
    B('walls', 'M_Wall', -XW - 0.12, -XW, DOOR_H, YC, DOOR_Z0, DOOR_Z1)
    B('walls', 'M_Wood', -XW, XW, 0, 0.12, ZB, ZB + 0.03, tint=(0.8, 0.75, 0.7))                  # skirting board (tinted)
    B('ceiling', 'M_Ceiling', -XW, XW, YC, YC + 0.1, ZB, ZF)


@step('Furniture: couch against the back wall, coffee table', (0, 0.6, -2.0), 7, 15, 65)
def furniture():
    B('furn', 'M_Couch', -1.7, 1.7, 0, 0.42, -2.75, -1.95)          # seat block (seat surface 0.42 + cushion)
    B('furn', 'M_Couch', -1.7, 1.7, 0.42, 0.47, -2.7, -1.95, tint=(1.1, 1.1, 1.1))
    B('furn', 'M_Couch', -1.7, 1.7, 0, 1.05, -2.95, -2.72)          # back rest
    for sx in (-1, 1):
        B('furn', 'M_Couch', sx * 1.7 - 0.12, sx * 1.7 + 0.12, 0, 0.65, -2.95, -1.95)          # arms
    B('furn', 'M_Wood', -0.7, 0.7, 0.36, 0.42, -1.3, -0.8)
    for x in (-0.62, 0.62):
        for z in (-1.22, -0.88):
            B('furn', 'M_Wood', x - 0.03, x + 0.03, 0, 0.36, z - 0.03, z + 0.03)


@step('Light fixtures: neon strip (EMIT_neon), floor lamp (point light)', (1.5, 1.8, -2.5), 7, -20, 70)
def fixtures():
    B('neon', 'EMIT_neon', -2.6, 2.6, 2.9, 2.95, ZB + 0.02, ZB + 0.06)
    ob = join('neon', 'LIGHT_NEON_01'); ob['group'] = 'neon'; ob['color'] = EMIT['neon'][0]; ob['kind'] = 'emissive'
    C('lamp', 'M_Dark', 3.2, 0, -2.4, 0.16, 0.03, 16)
    C('lamp', 'M_Dark', 3.2, 0.03, -2.4, 0.015, 1.45, 8)
    C('lamp', 'EMIT_lamps', 3.2, 1.48, -2.4, 0.2, 0.3, 16)
    ob = join('lamp', 'LIGHT_LAMP_01'); set_origin(ob, G(3.2, 1.63, -2.4))
    ob['group'] = 'lamps'; ob['color'] = EMIT['lamps'][0]; ob['kind'] = 'point'; ob['range'] = 5.0


@step('Anchors: spots, door, walk path, screens, colliders, cameras', (0, 1.2, 0), 14, 30, 58)
def anchors():
    for i, x in enumerate((-1.0, 0.0, 1.0)):
        empty('SPOT_%02d' % (i + 1), x, 0, -2.3, 0, pose='sit', seatHeight=0.47, seatDepth=0.5,
              label=['Couch left', 'Couch middle (host)', 'Couch right'][i],
              approach=[x, 0.0, -1.55], leavePathAt='PATH_03')                  # flat [x,y,z,...] glTF points
    empty('SPOT_04', -2.2, 0, 0.2, 20, pose='stand', label='Stand left')
    empty('SPOT_05', 2.2, 0, 0.2, -20, pose='stand', label='Stand right')
    # DOOR: origin = hinge, rotates about its local +Y (glTF); the leaf spans +Z from the hinge
    B('door', 'M_Wood', -XW - 0.1, -XW - 0.05, 0, DOOR_H - 0.02, DOOR_Z0 + 0.02, DOOR_Z1 - 0.02)
    ob = join('door', 'DOOR'); set_origin(ob, G(-XW - 0.075, 0, DOOR_Z0 + 0.02)); ob['openAngle'] = -95.0
    empty('DOOR_OUTSIDE', -XW - 1.2, 0, (DOOR_Z0 + DOOR_Z1) / 2, 90)
    for i, (x, z) in enumerate(((-XW + 0.6, 1.1), (-2.0, 0.6), (0.0, 0.0))):
        empty('PATH_%02d' % (i + 1), x, 0, z)
    # react SCREEN: 16:9 plane, UVs 0..1, facing +Z; drops from 1.6 m above its shown position
    sw, sh, sy, sz = 2.6, 2.6 * 9 / 16, 1.95, ZB + 0.08
    bm = bmesh.new()
    vs = [bm.verts.new(G(x, y, sz)) for x, y in ((-sw / 2, sy - sh / 2), (sw / 2, sy - sh / 2), (sw / 2, sy + sh / 2), (-sw / 2, sy + sh / 2))]
    f = bm.faces.new(vs); uvl = bm.loops.layers.uv.verify()
    for lp, uv in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
        lp[uvl].uv = uv
    me = bpy.data.meshes.new('SCREEN'); bm.to_mesh(me); bm.free()
    scr = bpy.data.objects.new('SCREEN', me); me.materials.append(mat('SCREEN')); coll('EXPORT').objects.link(scr)
    set_origin(scr, G(0, sy, sz)); scr['restOffsetY'] = 1.6
    empty('SCREEN_SOLO', 2.7, 1.7, -1.2, -30, width=1.8)
    # colliders: walkers route around these boxes (hidden at runtime; boxes taller than 0.9 m are ignored)
    B('col1', 'M_Hidden', -1.85, 1.85, 0, 0.8, -2.95, -1.9); join('col1', 'COLLIDE_01')
    B('col2', 'M_Hidden', -0.75, 0.75, 0, 0.8, -1.35, -0.75); join('col2', 'COLLIDE_02')
    # cameras (look down their -Z). CAM_REACT frames the screen at ~80 % of the width
    cam('CAM_WIDE', (0, 1.75, 6.2), (0, 1.0, -1.0), 38)
    cam('CAM_REACT', (0, sy, sz + 3.0), (0, sy, sz), 35)
    cam('CAM_DOOR', (-1.5, 1.7, 2.6), (-XW, 1.1, 1.1), 42)
    cam('SPOT_02_CAM', (0.2, 1.25, 0.2), (0, 0.95, -2.3), 30)


@step('Baking light into vertex colours: key, fill, lamp + neon pools, AO', (0, 1.2, 0), 13, 30, 60)
def bake_step():
    for bk, nm in (('floor', 'FLOOR'), ('walls', 'WALLS'), ('ceiling', 'CEILING'), ('furn', 'FURNITURE')):
        join(bk, nm)
    objs = [o for o in coll('EXPORT').objects if o.type == 'MESH' and not o.name.startswith(('COLLIDE_', 'SCREEN', 'LIGHT_'))]
    bvh = build_bvh([o for o in objs if o.name != 'CEILING'])   # the key light is the ceiling itself: don't let it shadow

    pools = [(G(3.2, 1.63, -2.4), lin('#ffd28a'), 3.0, 0.6),            # lamp spill (position, colour, radius, strength)
             (G(0, 2.9, ZB + 0.1), lin('#ff3a8c'), 2.5, 0.5)]           # neon spill on the back wall
    bake(objs, bvh, key_dir=G(0.3, 1.0, 0.6), key_col=(0.55, 0.53, 0.5), fill_col=(0.10, 0.10, 0.13),
         amb_col=(0.42, 0.43, 0.47), pools=pools)


NRAY = 14
DIRS = [Vector(((((i + .5) / NRAY) ** .5) * math.cos(i * 2.399963), (((i + .5) / NRAY) ** .5) * math.sin(i * 2.399963),
                math.sqrt(max(0.0, 1 - (i + .5) / NRAY)))) for i in range(NRAY)]


def build_bvh(objs):
    verts, polys = [], []
    for ob in objs:
        mw = ob.matrix_world; base = len(verts)
        verts += [mw @ v.co for v in ob.data.vertices]
        polys += [[base + i for i in p.vertices] for p in ob.data.polygons]
    return BVHTree.FromPolygons(verts, polys, all_triangles=False, epsilon=0.0)


def bake(objs, bvh, key_dir, key_col, fill_col, amb_col, pools, ao_len=1.0):
    """COLOR_0 per face corner = (ambient + key with a cast shadow + wrap + fill + light pools) x AO x tint.
    key_dir = direction TO the key light (Blender space). The engine multiplies COLOR_0 into the material colour."""
    kd = Vector(key_dir).normalized()
    for ob in objs:
        me = ob.data; mw = ob.matrix_world; nm = mw.to_3x3().inverted().transposed()
        tint = me.attributes.get('tint')
        tints = [tuple(d.color[:3]) for d in tint.data] if tint else None
        if tint:        # remove it BEFORE adding Col: removing it afterwards leaves no render colour -> no COLOR_0 exported
            me.attributes.remove(tint)
        attr = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
        cols = [1.0] * (len(me.loops) * 4)
        vco = [mw @ v.co for v in me.vertices]
        cache = {}
        for p in me.polygons:
            n = (nm @ p.normal).normalized(); t = n.orthogonal().normalized(); bt = n.cross(t)
            for li in p.loop_indices:
                vi = me.loops[li].vertex_index
                key = (vi, round(n.x, 1), round(n.y, 1), round(n.z, 1))
                c = cache.get(key)
                if c is None:
                    pos = vco[vi]; o = pos + n * 0.01; occ = 0.0
                    for d in DIRS:
                        hit = bvh.ray_cast(o, t * d.x + bt * d.y + n * d.z, ao_len)
                        if hit[0] is not None:
                            occ += 1.0 - (hit[3] / ao_len) ** 0.6
                    ao = 1.0 - 0.75 * occ / NRAY
                    ndl = n.dot(kd)
                    sh = 0.25 if ndl > 0 and bvh.ray_cast(pos + n * 0.03, kd, 40.0)[0] is not None else 1.0
                    cc = Vector(amb_col) * (0.55 + 0.45 * max(0.0, n.z)) + Vector(key_col) * (max(0.0, ndl) + max(0.0, (ndl + 0.35) / 1.35) * 0.25) * sh
                    cc += Vector(fill_col) * (max(0.0, -n.z) * 0.6 + max(0.0, 0.3 - abs(n.z)) * 0.4)
                    for lp, lc, lr, ls in pools:
                        dv = lp - pos; dist = dv.length
                        if dist < lr:
                            cc += Vector(lc) * (ls * (1 - (dist / lr) ** 2) ** 2 * max(0.15, n.dot(dv / max(dist, 1e-4))))
                    cc *= ao
                    if tints:
                        tv = tints[vi]
                        cc = Vector((cc.x * tv[0], cc.y * tv[1], cc.z * tv[2]))
                    c = tuple(min(1.0, max(0.0, x)) for x in cc)
                    cache[key] = c
                cols[li * 4:li * 4 + 4] = (*c, 1.0)
        attr.data.foreach_set('color', cols)
        me.color_attributes.active_color = attr
        me.color_attributes.render_color_index = me.color_attributes.active_color_index   # what the exporter writes
    log('baked', len(objs), 'objects')


# ------------------------------------------------------------------ export + GLB post-processing + scene.json
def read_glb(path):
    data = open(path, 'rb').read(); _, _, length = struct.unpack_from('<III', data, 0); off = 12; chunks = []
    while off < length:
        clen, ctype = struct.unpack_from('<II', data, off); chunks.append([ctype, data[off + 8:off + 8 + clen]]); off += 8 + clen
    return json.loads(chunks[0][1].decode('utf8')), chunks


def write_glb(path, js, chunks):
    jb = json.dumps(js, separators=(',', ':')).encode('utf8'); jb += b' ' * ((4 - len(jb) % 4) % 4); chunks[0][1] = jb
    body = b''.join(struct.pack('<II', len(c[1]), c[0]) + c[1] for c in chunks)
    open(path, 'wb').write(struct.pack('<III', 0x46546C67, 2, 12 + len(body)) + body)


@step('Export scene.glb + scene.json', (0, 1.2, 0), 14, 40, 60)
def export():
    for o in bpy.context.scene.objects:
        o.hide_set(False); o.select_set(False)
    for o in coll('EXPORT').all_objects:
        o.select_set(True)
        if o.type == 'MESH' and 'tint' in o.data.attributes:          # unbaked parts (lights, colliders): no stray COLOR_0
            o.data.attributes.remove(o.data.attributes['tint'])
    os.makedirs(OUT, exist_ok=True)
    glb = os.path.join(OUT, 'scene.glb')
    kw = dict(filepath=glb, export_format='GLB', use_selection=True, export_yup=True, export_apply=True, export_cameras=True,
              export_lights=False, export_extras=True, export_vertex_color='ACTIVE', export_all_vertex_colors=False,
              export_materials='EXPORT', export_texcoord=True, export_normals=True, export_tangents=False,
              export_animations=False, export_skins=False, export_morph=False)
    ok = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()          # tolerate exporter option renames
    bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in ok or k == 'filepath'})
    js, chunks = read_glb(glb)
    used = set(js.get('extensionsUsed', []))
    for m in js.get('materials', []):
        n = m['name'].split('.')[0]; pbr = m.setdefault('pbrMetallicRoughness', {})
        pbr['metallicFactor'] = 0.0
        if n.startswith('EMIT_'):                    # exact emissive colour + strength the light engine modulates
            col, s = EMIT[n[5:]]
            m['emissiveFactor'] = [round(c, 4) for c in lin(col)]
            m.setdefault('extensions', {})['KHR_materials_emissive_strength'] = {'emissiveStrength': s}
            used.add('KHR_materials_emissive_strength')
            m['extras'] = {'group': n[5:], 'color': col}
        elif n == 'M_Hidden':
            m['alphaMode'] = 'BLEND'; pbr['baseColorFactor'] = [0, 0, 0, 0]
    js['extensionsUsed'] = sorted(used)
    write_glb(glb, js, chunks)
    acc = js['accessors']
    tris = sum(acc[p['indices']]['count'] // 3 for me in js['meshes'] for p in me['primitives'] if 'indices' in p)
    log('scene.glb', tris, 'tris', os.path.getsize(glb), 'bytes')
    sj = os.path.join(OUT, 'scene.json')
    old = json.load(open(sj, encoding='utf8')) if os.path.exists(sj) else {}
    info = {'id': ROOM_ID, 'name': 'Small Room', 'model': 'scene.glb', 'preview': 'preview.png', 'thumbnail': 'thumb.png',
            'modes': ['talk', 'react'], 'defaultCamera': 'CAM_WIDE', 'reactCamera': 'CAM_REACT', 'avatarHeight': 1.5,
            'hostSpot': 'SPOT_02',
            'ambience': {'background': '#15171c', 'fog': '#15171c', 'fogNear': 9, 'fogFar': 26, 'exposure': 0.9},
            'lights': {'programs': ['steady', 'beatPulse', 'party'], 'groups': {k: v[0] for k, v in EMIT.items()}}}
    for k, v in old.items():                         # keep hand-added keys (gfx, environment, screenSkin, cameraOverrides ...)
        if k not in info or k in ('name', 'ambience', 'lights', 'gfx', 'screenSkin', 'soloScreens'):
            info[k] = v
    json.dump(info, open(sj, 'w', encoding='utf8'), indent=2, ensure_ascii=False)
    log('scene.json written ->', OUT)


# ------------------------------------------------------------------ runner: headless, or step by step in a visible window
def view3d():
    for win in bpy.context.window_manager.windows:
        for area in win.screen.areas:
            if area.type == 'VIEW_3D':
                return area
    return None


VIEW = {'t': 0.0, 'target': None, 'cur': None}
STATE = {'i': 0, 'pending': None}


def orbit_tick():                                    # eases the view onto the current step's focus + a slow sway
    area = view3d()
    if area and VIEW['target']:
        r3 = area.spaces[0].region_3d
        tgt, dist, yaw, pitch = VIEW['target']; VIEW['t'] += 0.25
        loc, d = VIEW['cur'] or (r3.view_location.copy(), r3.view_distance)
        loc = loc.lerp(tgt, 0.06); d += (dist - d) * 0.06; VIEW['cur'] = (loc, d)
        r3.view_location = loc; r3.view_distance = d
        r3.view_rotation = Euler((rad(pitch), 0, rad(-yaw + 14 * math.sin(rad(VIEW['t'])))), 'XYZ').to_quaternion()
    return 0.04


def live_setup():
    area = view3d()
    if area:
        sp = area.spaces[0]; sp.shading.type = 'SOLID'; sp.shading.color_type = 'MATERIAL'
        sp.shading.show_cavity = True; sp.overlay.show_floor = False; sp.clip_end = 500
        sp.region_3d.view_perspective = 'PERSP'


def cutaway():                                       # dollhouse view: hide the ceiling so the orbit sees in
    o = bpy.data.objects.get('CEILING')
    for ob in ([o] if o else []) + BUCKETS.get('ceiling', []):
        ob.hide_set(True)


def live_step():
    area = view3d(); i = STATE['i']
    if i >= len(STEPS):
        if area:
            area.header_text_set('Small room: DONE - scene.glb exported. Orbit freely (middle mouse).')
        cutaway()
        return None
    title, fn, focus, dist, yaw, pitch = STEPS[i]
    if area:
        area.header_text_set('Building %d/%d: %s' % (i + 1, len(STEPS), title))
        VIEW['target'] = (G(*focus), dist, yaw, pitch)
    if STATE['pending'] != i:                        # show the header first, build on the next tick
        STATE['pending'] = i
        return 0.6
    log('step', i + 1, title)
    try:
        fn()
    except Exception as e:
        import traceback; traceback.print_exc()
        if area:
            area.header_text_set('FAILED at %s: %s' % (title, e))
        return None
    STATE['i'] = i + 1
    cutaway()
    if title.startswith('Baking') and area:
        area.spaces[0].shading.color_type = 'VERTEX'
    return 1.6


def main():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    coll('EXPORT'); coll('WORK')
    if LIVE and not bpy.app.background:
        bpy.app.timers.register(live_setup, first_interval=0.5)
        bpy.app.timers.register(orbit_tick, first_interval=1.0, persistent=True)
        bpy.app.timers.register(live_step, first_interval=2.0)
    else:
        for title, fn, *_ in STEPS:
            log('step', title); fn()


main()
```

---

## Example C — a costume for Sprocket

Built only with `blender/costume_kit.py` against `(an internal build)`, written to a staging folder (the
real `(an internal build)` scripts write into the builtin avatar's `profile.json`; don't).

```text
tools\blender_low.cmd -b --factory-startup --python C:\...\build_costume_example.py -- C:\...\stage\costume
python tools/check_costume.py (an internal build) C:\...\stage\costume\scout.glb
```

Verified: `exported scout.glb tris=12428 extra bones=[] mats=3 rest drift=0.0e+00`, `CLIP_REPORT` total 54 (arms up
21, combo 25: fine for a shirt), `face_overlap_verts` 0; `check_costume.py` prints "OK: rest pose + inverse bind
matrices identical for all shared bones" and exits 0. `--preview` adds `kit.render_preview()` (Eevee = GPU: only when
the user is off air).

```python
"""A small costume for Sprocket (assets/builtin/frog) built only with blender/costume_kit.py, written to a STAGING
folder (never into assets/builtin/*/costumes or the profile). (docs/BLENDER_PLAYBOOK.md section 8)

    tools\\blender_low.cmd -b --factory-startup --python <abs path>\\build_costume_example.py -- <out_dir>
    python tools/check_costume.py (an internal build) <out_dir>/scout.glb
"""
import os, sys

ARGV = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(ARGV[0] if ARGV else '.')
REPO = os.environ.get('VTP_ROOT', r'<VTube Pro folder>')
sys.path.insert(0, os.path.join(REPO, 'blender'))
import costume_kit as kit  # noqa: E402

kit.load_base(os.path.join(REPO, 'assets', 'builtin', 'frog', 'frog.glb'))
m = kit.measure()
print(kit.describe())

khaki = kit.material('ScoutKhaki', '#b59a64', roughness=0.9)          # sRGB hex in, the kit linearises
olive = kit.material('ScoutOlive', '#56613a', roughness=0.85)
brass = kit.material('Brass', '#c9a24a', roughness=0.35, metallic=0.8)

kit.shell(z=(m['hips'].z + 0.02, m['neck'].z + 0.03), offset=0.018, thickness=0.01, material=khaki, name='ScoutShirt')
for side in 'LR':
    kit.sleeve(side, end=0.55, radius_scale=1.15, offset=0.02, material=khaki)
kit.belt(m['belly'].z - 0.12, width=0.06, material=olive, buckle_material=brass)
kit.hat_helmet(material=olive)                                          # auto-seated, clears the eyes, rigid on hat/head

os.makedirs(OUT, exist_ok=True)
kit.export_costume(os.path.join(OUT, 'scout.glb'), max_tris=35000)       # prints CLIP_REPORT + face-box warnings
if '--preview' in ARGV:            # Eevee = GPU: only when the user is off air (python tools/live_ok.py says IDLE)
    kit.render_preview(os.path.join(OUT, 'scout_preview.png'))
cdef = kit.write_costume_def('scout', 'Scout', 'costumes/scout.glb')
print('COSTUME_DEF', cdef)
```

To add it to an avatar (the user's call): copy `scout.glb` into the avatar's `costumes/` folder and add the printed
`CostumeDef` to `profile.json` `costumes`, or let the user import it in the studio (Wardrobe).

---

## Checking a GLB

`node tools/gltf_validate.mjs <file.glb>` validates. This prints what the engine will actually get per mesh
(triangles, whether the bake reached `COLOR_0`) and every node's extras (spots, lights, doors):

```python
"""python glbinfo.py <file.glb>  ->  per mesh: primitives, triangles, COLOR_0 yes / partial / no; nodes with extras."""
import json, struct, sys
data = open(sys.argv[1], 'rb').read()
n = struct.unpack_from('<I', data, 12)[0]; js = json.loads(data[20:20 + n])
acc = js['accessors']
for m in js['meshes']:
    prims = m['primitives']; tris = sum(acc[p['indices']]['count'] // 3 for p in prims if 'indices' in p)
    c = sum('COLOR_0' in p['attributes'] for p in prims)
    print('%-24s prims %2d  tris %6d  COLOR_0 %s' % (m['name'], len(prims), tris, 'yes' if c == len(prims) else 'partial' if c else 'NO'))
for nd in js['nodes']:
    if nd.get('extras'):
        print('node %-20s %s' % (nd['name'], json.dumps(nd['extras'])))
```

On the shipped kitchen it shows `LOUNGE ... tris 18818 COLOR_0 NO` and `KITCHEN_DOOR_FREEZER ... COLOR_0 NO`: the tint
pitfall of playbook section 7.3.

---

## Private test tree: vite.config.ts

Put this in your private tree (a copy of `src`, `shared`, `server`, `index.html`, `output.html`, `dj.html`,
`tsconfig.json`, `package.json`, with `node_modules`, `public`, `assets` junctioned to the repo). Change the ports if
another agent already uses them (`strictPort` makes Vite fail instead of silently moving).

```ts
import { defineConfig } from 'vite';
// PRIVATE test tree (never the live studio): own ports, own cache, API = the read-only mock on 5793
const SERVER = 'http://127.0.0.1:5793';
export default defineConfig({
  cacheDir: '.vite_private',
  server: { port: 5790, strictPort: true, host: '127.0.0.1', hmr: { port: 5794 },
    proxy: { '/api': SERVER, '/library': SERVER },
    fs: { allow: ['.', '<VTube Pro folder>'] } },
});
```

Start: `python mock.py --port 5793 --stage <staged rooms folder>` in one shell, `npx vite` inside the tree in another.
Stop both (and close the tab) when you're done.

---

## Read-only mock API (mock.py)

Serves `/api/scenes`, `/api/scenes/<id>/file/*`, `/api/avatars`, `/api/avatars/<id>`, `/library/<id>/*` from
`assets/scenes` + `assets/builtin` and your staging folders (staged ones win), answers `/api/scene` with "no
scene", refuses every PUT / DELETE, and allows exactly one write: `POST /save?name=x.png` (a data-URL screenshot into
`./shots`). Tested with the room above and `curl` (staged rooms and builtin avatars found, `PUT /api/scene` gives 403).

```python
"""Read-only mock of the VTube Pro API for a private test tree (docs/BLENDER_PLAYBOOK.md section 10).
Serves rooms from assets/scenes and builtin avatars from assets/builtin, plus staged ones (--stage: a folder of room
folders, --stage-avatars: a folder of avatar folders; staged wins). Never writes the live tree.
POST /save?name=x.png stores a data-URL screenshot in ./shots.

    python mock.py [--port 5793] [--stage <folder of staged rooms>] [--stage-avatars <folder of staged avatars>]
"""
import http.server, json, os, sys, mimetypes, urllib.parse, base64, re

ROOT = os.environ.get('VTP_ROOT', r'<VTube Pro folder>')
A = sys.argv[1:]
PORT = int(A[A.index('--port') + 1]) if '--port' in A else 5793
STAGE = os.path.abspath(A[A.index('--stage') + 1]) if '--stage' in A else None
SCENE_DIRS = ([STAGE] if STAGE else []) + [os.path.join(ROOT, 'assets', 'scenes')]
AV_STAGE = os.path.abspath(A[A.index('--stage-avatars') + 1]) if '--stage-avatars' in A else None
AVATAR_DIRS = ([AV_STAGE] if AV_STAGE else []) + [os.path.join(ROOT, 'assets', 'builtin')]
SHOTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'shots')
for t, e in (('model/gltf-binary', '.glb'), ('application/javascript', '.js'), ('application/wasm', '.wasm'), ('application/json', '.json')):
    mimetypes.add_type(t, e)


def avatar_dir(aid):
    for d in AVATAR_DIRS:
        p = os.path.join(d, aid)
        if os.path.isfile(os.path.join(p, 'profile.json')):
            return p
    return None


def scene_dir(sid):
    for d in SCENE_DIRS:
        p = os.path.join(d, sid)
        if os.path.isfile(os.path.join(p, 'scene.json')):
            return p
    return None


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send_file(self, path):
        if not os.path.isfile(path):
            return self.send_error(404)
        data = open(path, 'rb').read(); self.send_response(200)
        self.send_header('Content-Type', mimetypes.guess_type(path)[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(len(data))); self.send_header('Cache-Control', 'no-store'); self.end_headers()
        self.wfile.write(data)

    def send_json(self, obj, code=200):
        data = json.dumps(obj).encode(); self.send_response(code); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)

    def do_GET(self):
        p = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        if p == '/api/scenes':
            out, seen = [], set()
            for d in SCENE_DIRS:
                for sid in sorted(os.listdir(d)):
                    f = os.path.join(d, sid, 'scene.json')
                    if sid in seen or not os.path.isfile(f):
                        continue
                    seen.add(sid); j = json.load(open(f, encoding='utf8'))
                    j.update(id=sid, name=j.get('name', sid), model=j.get('model', 'scene.glb'), ready=True,
                             thumb='/api/scenes/%s/file/thumb.png' % sid)
                    out.append(j)
            return self.send_json(out)
        if p.startswith('/api/scenes/') and '/file/' in p:
            sid, rel = p[len('/api/scenes/'):].split('/file/', 1)
            base = scene_dir(sid)
            if not base:
                return self.send_error(404)
            full = os.path.normpath(os.path.join(base, rel))
            return self.send_file(full) if full.startswith(base) else self.send_error(400)
        if p == '/api/scene':
            return self.send_json({'sceneId': None})
        if p == '/api/avatars':
            out, seen = [], set()
            for d in AVATAR_DIRS:
                for aid in sorted(os.listdir(d)):
                    f = os.path.join(d, aid, 'profile.json')
                    if aid in seen or not os.path.isfile(f):
                        continue
                    try:
                        out.append(json.load(open(f, encoding='utf8'))); seen.add(aid)
                    except Exception:
                        pass
            return self.send_json(out)
        m = re.match(r'^/api/avatars/([\w.-]+)$', p)
        if m:
            base = avatar_dir(m.group(1))
            return self.send_json(json.load(open(os.path.join(base, 'profile.json'), encoding='utf8'))) if base else self.send_error(404)
        if p.startswith('/library/'):
            aid, _, rel = p[len('/library/'):].partition('/')
            base = avatar_dir(aid)
            if not base:
                return self.send_error(404)
            full = os.path.normpath(os.path.join(base, rel))
            return self.send_file(full) if full.startswith(base) else self.send_error(400)
        return self.send_error(404)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == '/save':
            name = re.sub(r'[^\w.-]', '_', urllib.parse.parse_qs(u.query).get('name', ['shot.png'])[0])
            body = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()
            os.makedirs(SHOTS, exist_ok=True)
            open(os.path.join(SHOTS, name), 'wb').write(base64.b64decode(body.split(',', 1)[1]))
            return self.send_json({'ok': True})
        return self.send_error(403)                  # everything else that writes is refused

    do_PUT = do_POST

    def do_DELETE(self):
        return self.send_error(403)


print('mock API on 127.0.0.1:%d, scenes from %s' % (PORT, SCENE_DIRS), flush=True)
http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
```

---

## Install script (code changes)

For changes under `src/`, `server/`, `shared/`: you worked in `<ws>/tree/`, snapshotted every live file you changed
into `<ws>/base/` when you started, and ship this next to them. Modelled on the kitchen installer. Tested:
`--check` on a one-line change printed "typecheck clean" and "check only: would write src/scene/contract.ts"; with a
deliberate type error it printed "ABORT: typecheck failed ... Nothing written." (exit 1); with no change, "Nothing to
do". Run `--check` yourself; the user runs the real install.

```python
"""Install <workstream> into the live VTube Pro tree - atomically, and only when the user says so.

    python install_<ws>.py --check    # dry run: 3-way merge + typecheck in a staging copy, writes nothing
    python install_<ws>.py            # refuses while the live studio is tracking (the user may be streaming)
    python install_<ws>.py --now      # install anyway (the studio reloads once, the server restarts ~1 s)

Layout next to this script:  base/ = untouched snapshot of every live file you changed (taken when you started),
tree/ = your private working tree. For each MODIFIED file: 3-way `git merge-file` (live now, base, yours) - other agents
may have edited it since; any conflict aborts with nothing written. NEW files must not exist live (or be identical).
The merged set is typechecked (npx tsc --noEmit -p .) in a temp copy; only then is each file written via temp + os.replace.
Byte-exact reads / writes keep CRLF files CRLF.
"""
import os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
LIVE = os.environ.get('VTP_ROOT', r'<VTube Pro folder>')
BASE, OURS = os.path.join(HERE, 'base'), os.path.join(HERE, 'tree')
MODIFIED = []      # edit: every live file you changed, e.g. ['shared/types.ts', 'src/scene/contract.ts'] (repo-relative)
NEW = []           # edit: every file you added, e.g. ['src/scene/myEngine/myScene.ts']
ORDER = lambda f: (0 if f.startswith('shared/') else 1 if f.startswith('server/') else 2, f)    # shared -> server -> src


def rd(p):
    with open(p, 'rb') as fh:
        return fh.read()


def main():
    now, check = '--now' in sys.argv, '--check' in sys.argv
    lo = subprocess.run([sys.executable, os.path.join(LIVE, 'tools', 'live_ok.py')], capture_output=True, text=True)
    print(lo.stdout.strip())
    if 'IDLE' not in lo.stdout and not now and not check:
        print('HOLD: the live studio is tracking (the user may be streaming). Run again with --now when they say so.')
        return 2
    out = {}
    for f in MODIFIED:
        base, ours, theirs = (os.path.join(d, f) for d in (BASE, OURS, LIVE))
        b, o, t = rd(base), rd(ours), rd(theirs)
        if t == o:
            continue                          # already installed
        if t == b:
            out[f] = o; continue              # nobody else touched it
        r = subprocess.run(['git', 'merge-file', '-p', theirs, base, ours], capture_output=True)
        if r.returncode != 0:
            print(f'ABORT: {f} changed live since the snapshot and the merge has conflicts. Nothing written.'); return 1
        out[f] = r.stdout; print('merged with live edits:', f)
    for f in NEW:
        live, ours = os.path.join(LIVE, f), os.path.join(OURS, f)
        if os.path.exists(live) and rd(live) != rd(ours):
            print(f'ABORT: {f} already exists live with other content. Nothing written.'); return 1
        if not os.path.exists(live):
            out[f] = rd(ours)
    if not out:
        print('Nothing to do: already installed.'); return 0
    stage = tempfile.mkdtemp(prefix='vtp_install_stage_')
    try:
        for d in ('src', 'server', 'shared'):
            shutil.copytree(os.path.join(LIVE, d), os.path.join(stage, d))
        for fn in ('tsconfig.json', 'package.json'):
            shutil.copy2(os.path.join(LIVE, fn), stage)
        for j in ('node_modules', 'assets'):
            subprocess.run(['cmd', '/c', 'mklink', '/J', os.path.join(stage, j), os.path.join(LIVE, j)], capture_output=True, check=True)
        for f, data in out.items():
            os.makedirs(os.path.dirname(os.path.join(stage, f)), exist_ok=True)
            with open(os.path.join(stage, f), 'wb') as fh:
                fh.write(data)
        tsc = subprocess.run('npx tsc --noEmit -p .', cwd=stage, shell=True, capture_output=True, text=True)
        if tsc.returncode != 0:
            print('ABORT: typecheck failed on the merged tree. Nothing written.\n' + (tsc.stdout + tsc.stderr)[-3000:]); return 1
        print('typecheck clean')
    finally:
        for j in ('node_modules', 'assets'):              # remove the junctions FIRST (rmtree would follow them)
            p = os.path.join(stage, j)
            if os.path.exists(p):
                subprocess.run(['cmd', '/c', 'rmdir', p], capture_output=True)
        shutil.rmtree(stage, ignore_errors=True)
    if check:
        print('check only: would write', ', '.join(sorted(out, key=ORDER))); return 0
    for f in sorted(out, key=ORDER):
        dst = os.path.join(LIVE, f); os.makedirs(os.path.dirname(dst), exist_ok=True)
        tmp = dst + '.vtp_tmp'
        with open(tmp, 'wb') as fh:
            fh.write(out[f])
        os.replace(tmp, dst); print('installed', f)
    print('Done. OBS keeps the old page until: npx vite build --emptyOutDir false (only when the user asks), then refresh OBS.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
```
