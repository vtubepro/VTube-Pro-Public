"""Festival stage dressing kit: the infrastructure that makes a stage read as a main stage, parameterised so any
fs_lib festival room gets it in one call. Original, generic designs (no marks, no recreated stage):

  truss_tower      a square 4-leg lattice tower (box-truss legs, rings, cross bracing)
  line_array       a J-curved speaker hang (cabinets + grille fronts, header bar, motor chains)
  led_plane        an FX_LEDWALL_<GROUP>_NN screen (UV 0..1 plane: the festival engine draws on it)
  led_fins         a skyline of LED blades as ONE FX_LEDWALL mesh (one image mapped across every blade), with dark
                   steel backs so side views read solid
  led_pylon        a wing tower: truss core, a portrait LED face, line arrays both sides, a light strip, a crown
  delay_tower      a field delay tower: truss legs, a deck + roof, line arrays facing the back field, a beacon
  sfx_housings     real hardware under every flame / CO2 / gerb / confetti anchor (and the anchor moved to the nozzle)
  banner_mast      a mast with a long vertical banner (alpha-masked texture) and a lamp
  festoon          a catenary of warm bulbs between two points
  glow_cluster     bioluminescent caps + reeds (swamp / forest rooms)
  halo_ring        a giant LED ring + radiating keyline spokes behind a hero piece (a sun / halo frame)
  lanterns         a sky garland: a catenary cable with lanterns on drop lines
  inflatable       a tethered inflatable body (rooms add faces / hats)
  ferris_wheel     a lit ferris wheel for the far field
  tent_camp        a campsite behind the field: ridge tents, some with a lantern glow
  wing_deck        a deck extension with a facade and an emissive edge line

Everything takes glTF coordinates (metres, +Y up, +Z towards the crowd) like fs_lib. Geometry goes into fs_lib
buckets (joined + baked with the room); a bucket whose name starts with "light_" becomes a LIGHT_<GROUP>_NN emissive
node the room light show drives (call `tag_lights()` after the room's join step). Budgets: everything here is a few
quads per part; truss uses the alpha-masked M_Truss lattice texture when the room defines it.

    import fs_dress as D
    D.ensure_materials()
    D.led_pylon('WINGL', x=-146, z=-14, ...)
    D.sfx_housings()
"""
import math

import bmesh
import bpy
from mathutils import Matrix, Vector

import fs_lib as L

# ------------------------------------------------------------------ materials (flat, only added when a room has none)
DEFAULT_FLAT = {
    'M_DressSteel': ('#15171b', 0.5, 0.7),      # tower legs, frames, headers
    'M_DressCab': ('#0a0a0c', 0.78, 0.05),      # speaker cabinets
    'M_DressNozzle': ('#2b2d31', 0.32, 0.85),   # SFX nozzles, chain hoists
    'M_DressCase': ('#111215', 0.6, 0.2),       # road cases, SFX bases
    'M_DressPole': ('#1a1c20', 0.45, 0.6),      # masts
    'M_DressStem': ('#1a2418', 0.85, 0.0),      # mushroom stems, reeds
}
METALLIC = {'M_DressSteel', 'M_DressNozzle', 'M_DressPole'}


def ensure_materials(extra_flat=None):
    """define the kit's flat materials (never overrides a room's own definition of the same name)"""
    flat = dict(DEFAULT_FLAT)
    flat.update(extra_flat or {})
    L.define(flat={k: v for k, v in flat.items() if k not in L.FLAT and k not in L.TEXD})
    L.METAL.update(METALLIC)


def truss_mat():
    return 'M_Truss' if 'M_Truss' in L.TEXD else 'M_DressSteel'


def grille_mat():
    return 'M_Grille' if 'M_Grille' in L.TEXD else 'M_DressCab'


# ------------------------------------------------------------------ small maths
def rot_yx(yaw, pitch=0.0):
    """glTF rotation: yaw about +Y (0 = facing +Z), then pitch about the local X (positive = front tilts down)"""
    return L.rot_y(yaw) @ L.rot_x(pitch)


def _v(p):
    return Vector((float(p[0]), float(p[1]), float(p[2])))


def to_gltf(vb):
    """Blender space -> glTF (the inverse of fs_lib.G)"""
    return Vector((vb.x, vb.z, -vb.y))


# ------------------------------------------------------------------ structures
def truss_tower(bucket, x, z, h, foot=2.0, y0=0.0, w=0.4, ring=4.0, yaw=0.0, brace=True, top_ring=True):
    """a square lattice tower: 4 box-truss legs on a `foot` square, a ring every `ring` m, X bracing on every face"""
    R = L.rot_y(yaw)
    hf = foot / 2
    corners = [R @ Vector((sx * hf, 0, sz * hf)) for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    base = Vector((x, y0, z))
    for c in corners:
        L.truss(bucket, tuple(base + c), tuple(base + c + Vector((0, h, 0))), w=w, material=truss_mat())
    n = max(1, int(h // ring))
    levels = [y0 + h * k / n for k in range(1, n + 1)] if top_ring else [y0 + h * k / n for k in range(1, n)]
    for i, y in enumerate([y0 + 0.4] + levels):
        for k in range(4):
            a, b = corners[k], corners[(k + 1) % 4]
            L.truss(bucket, (x + a.x, y, z + a.z), (x + b.x, y, z + b.z), w=w * 0.75, material=truss_mat())
            if brace and i < len(levels):
                y1 = levels[i]
                L.truss(bucket, (x + a.x, y, z + a.z), (x + b.x, y1, z + b.z), w=w * 0.5, material=truss_mat())
    return corners


def line_array(bucket, x, y_top, z, n=12, box=(1.3, 0.42, 0.95), yaw=0.0, aim_down=3.0, splay=2.4, chain=6.0):
    """a J-curved line-array hang: the top box at y_top, each box below tilted `splay` degrees more (progressive),
    grille fronts facing +Z rotated by `yaw`, a header bar and two motor chains up to the rigging point"""
    w, hgt, d = box
    top = Vector((x, y_top, z))
    p = top.copy()
    gm = grille_mat()
    for i in range(n):
        pitch = aim_down + splay * (i * i) / max(1, n - 1)
        R = rot_yx(yaw, pitch)
        down = R @ Vector((0, -1, 0)); fwd = R @ Vector((0, 0, 1))
        c = p + down * (hgt / 2)
        L.OB(bucket, 'M_DressCab', (w, hgt * 0.96, d), tuple(c), rot_g=R, seg=4.0)
        f = c + fwd * (d / 2 + 0.012)
        rt = R @ Vector((w * 0.47, 0, 0)); up = R @ Vector((0, hgt * 0.43, 0))
        L.quad(bucket, gm, [tuple(f - rt - up), tuple(f + rt - up), tuple(f + rt + up), tuple(f - rt + up)])
        p = p + down * hgt
    R0 = rot_yx(yaw, aim_down)
    L.OB(bucket, 'M_DressSteel', (w * 1.15, 0.16, d * 0.9), tuple(top + Vector((0, 0.1, 0))), rot_g=R0, seg=4.0)
    for s in (-1, 1):
        a = top + R0 @ Vector((s * w * 0.4, 0.18, 0))
        L.C(bucket, 'M_DressNozzle', a.x, a.y, a.z, 0.025, chain, n=4)
        L.OB(bucket, 'M_DressNozzle', (0.28, 0.4, 0.28), tuple(a + Vector((0, chain * 0.55, 0))), seg=4.0)   # the hoist
    return p


def led_plane(group, w, h, at, yaw=0.0, index=1, material='M_LedOff', frame=0.35, frame_bucket=None):
    """an FX_LEDWALL_<GROUP>_<NN> screen facing +Z rotated by yaw, centred at `at`, + a dark frame + back"""
    name = 'FX_LEDWALL_%s_%02d' % (group.upper(), index)
    ob = L.plane_obj(name, material, w, h, tuple(at), rot_g=L.rot_y(yaw))
    if frame_bucket:
        R = L.rot_y(yaw); c = _v(at)
        back = c - R @ Vector((0, 0, 0.35))
        L.OB(frame_bucket, 'M_DressSteel', (w + frame * 2, h + frame * 2, 0.6), tuple(back), rot_g=R, seg=6.0)
    return ob


def led_fins(group, fins, z, index=1, material='M_LedOff', back_bucket=None, depth=0.8, yaw=0.0, pivot=(0.0, 0.0, 0.0)):
    """a row of LED blades as ONE FX_LEDWALL mesh. fins = [[(x, y) * 4], …] quads in the plane z (counter-clockwise
    seen from the front). UVs span the bounding box, so the engine's one image runs across every blade - a pixel-mapped
    stage skyline. back_bucket gets a dark steel blade behind each fin (side views read solid)."""
    name = 'FX_LEDWALL_%s_%02d' % (group.upper(), index)
    xs = [p[0] for f in fins for p in f]; ys = [p[1] for f in fins for p in f]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    W, H = max(1e-3, x1 - x0), max(1e-3, y1 - y0)
    R = L.rot_y(yaw); P = _v(pivot)
    bm = bmesh.new(); uvl = bm.loops.layers.uv.verify()
    for f in fins:
        vs = [bm.verts.new(L.G(*(P + R @ (Vector((px, py, z)) - P)))) for px, py in f]
        face = bm.faces.new(vs)
        for lp, (px, py) in zip(face.loops, f):
            lp[uvl].uv = ((px - x0) / W, (py - y0) / H)
        if back_bucket:
            pts = [Vector((px, py, z - 0.05)) for px, py in f]
            bk = [Vector((px, py, z - depth)) for px, py in f]
            sm = bmesh.new()
            fa = [sm.verts.new(L.G(*(P + R @ (q - P)))) for q in pts]; ba = [sm.verts.new(L.G(*(P + R @ (q - P)))) for q in bk]
            sm.faces.new(ba[::-1])
            for k in range(4):
                sm.faces.new([ba[k], ba[(k + 1) % 4], fa[(k + 1) % 4], fa[k]])
            bmesh.ops.recalc_face_normals(sm, faces=sm.faces)
            L.add(back_bucket, sm, 'M_DressSteel', 2.0)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); ob.data.materials.append(L.mat(material))
    L.coll('EXPORT').objects.link(ob)
    return ob


def led_pylon(group, x, z, h, led_w, led_h, led_y0, yaw=0.0, foot=6.0, steel='pylon_steel', light_bucket=None,
              arrays=14, array_gap=1.6, crown=None, base_h=0.0, base_mat='M_Stone', base_bucket=None):
    """a wing tower: a lattice truss core (foot × foot), a portrait LED face (led_w × led_h from led_y0) on its front,
    line arrays hung either side of the LED, an emissive strip up both front legs (light_bucket), and a crown
    callback crown(top_xyz) for the room's own design language. Returns the LED object and the useful points."""
    R = L.rot_y(yaw); c = Vector((x, 0, z))
    truss_tower(steel, x, z, h, foot=foot, w=0.76, ring=6.0, yaw=yaw)
    if base_h > 0:
        L.OB(base_bucket or steel, base_mat, (foot + 2.0, base_h, foot + 2.0), tuple(c + Vector((0, base_h / 2, 0))), rot_g=R, tile=4.0, seg=6.0)
    front = c + R @ Vector((0, 0, foot / 2 + 0.9))
    led = led_plane(group, led_w, led_h, tuple(front + Vector((0, led_y0 + led_h / 2, 0))), yaw=yaw, frame_bucket=steel)
    # a header truss across the LED top carrying the arrays
    hy = led_y0 + led_h + 1.2
    span = led_w / 2 + array_gap + 1.0
    a = front + R @ Vector((-span, hy, 0)); b = front + R @ Vector((span, hy, 0))
    L.truss(steel, tuple(a), tuple(b), w=0.76, material=truss_mat())
    tops = []
    if arrays:
        for s in (-1, 1):
            p = front + R @ Vector((s * (led_w / 2 + array_gap), hy - 0.6, 0.4))
            line_array(steel, p.x, p.y, p.z, n=arrays, yaw=yaw + s * 6.0, aim_down=2.0, splay=2.0, chain=0.5)
            tops.append(p)
    if light_bucket:
        for s in (-1, 1):
            q = c + R @ Vector((s * (foot / 2 + 0.45), 0, foot / 2 + 0.45))
            L.B(light_bucket, 'EMIT_' + light_bucket[6:].rsplit('_', 1)[0].lower(), q.x - 0.09, q.x + 0.09, led_y0 * 0.5, h - 1.0, q.z - 0.09, q.z + 0.09, seg=10.0)
    top = c + Vector((0, h, 0))
    if crown:
        crown(top)
    return {'led': led, 'top': top, 'front': front, 'header_y': hy, 'arrays': tops}


def delay_tower(bucket, x, z, h=14.0, foot=2.6, yaw=0.0, light_bucket=None, beacon_bucket=None, arrays=8, roof=True,
                banner_bucket=None, banner_mat=None, banner_h=6.0):
    """a field delay tower: a truss tower, a deck + roof at the top, two line arrays facing +Z (rotated by yaw: away
    from the stage), solid corner posts, an emissive band under the deck (light_bucket), a beacon on the roof
    (beacon_bucket) and optional banners down both side faces"""
    R = L.rot_y(yaw); c = Vector((x, 0, z))
    truss_tower(bucket, x, z, h, foot=foot, w=0.4, ring=3.5, yaw=yaw)
    hf = foot / 2
    for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1)):                     # solid corner posts: the tower reads at distance
        q = c + R @ Vector((sx * (hf + 0.3), 0, sz * (hf + 0.3)))
        L.C(bucket, 'M_DressSteel', q.x, 0.0, q.z, 0.16, h, n=6)
    L.OB(bucket, 'M_DressCase', (foot + 1.6, 0.35, foot + 1.6), tuple(c + Vector((0, h, 0))), rot_g=R, seg=4.0)
    if roof:
        for s in (-1, 1):
            q = c + R @ Vector((s * (hf + 0.6), 0, 0))
            L.C(bucket, 'M_DressPole', q.x, h, q.z, 0.06, 2.0, n=6)
        L.OB(bucket, 'M_DressCab', (foot + 1.8, 0.18, foot + 1.6), tuple(c + Vector((0, h + 2.05, 0))), rot_g=R @ L.rot_x(-6), seg=6.0)
    if banner_mat and banner_bucket:
        for s in (-1, 1):                                                   # banners down both side faces
            o = c + R @ Vector((s * (hf + 0.5), 0, 0)); ry = L.rot_y(yaw + s * 90)
            u = ry @ Vector((foot * 0.42, 0, 0))
            top, bot = h - 0.8, h - 0.8 - banner_h
            L.quad(banner_bucket, banner_mat, [tuple(o - u + Vector((0, bot, 0))), tuple(o + u + Vector((0, bot, 0))), tuple(o + u + Vector((0, top, 0))), tuple(o - u + Vector((0, top, 0)))])
    for s in (-1, 1):
        p = c + R @ Vector((s * 0.75, h - 0.35, foot / 2 + 0.55))
        line_array(bucket, p.x, p.y, p.z, n=arrays, box=(1.0, 0.33, 0.7), yaw=yaw + s * 8.0, aim_down=4.0, splay=1.6, chain=0.3)
    if light_bucket:
        hf = foot / 2 + 0.81
        grp = 'EMIT_' + light_bucket[6:].rsplit('_', 1)[0].lower()
        for k in range(4):
            a = R @ Vector(((-hf, 0, -hf), (hf, 0, -hf), (hf, 0, hf), (-hf, 0, hf))[k]); b = R @ Vector(((hf, 0, -hf), (hf, 0, hf), (-hf, 0, hf), (-hf, 0, -hf))[k])
            mid = c + (a + b) / 2 + Vector((0, h - 0.25, 0)); dv = b - a
            L.OB(light_bucket, grp, (dv.length if abs(dv.x) > abs(dv.z) else 0.12, 0.14, dv.length if abs(dv.z) >= abs(dv.x) else 0.12), tuple(mid), seg=8.0)
    if beacon_bucket:
        grp = 'EMIT_' + beacon_bucket[6:].rsplit('_', 1)[0].lower()
        L.E(beacon_bucket, grp, (x, h + 2.35, z), (0.28, 0.28, 0.28), seg=(8, 5))
    return c + Vector((0, h, 0))


def wing_deck(bucket, x0, x1, z0, z1, y=3.0, deck_mat='M_Deck', face_mat='M_Stone', edge_bucket=None, tile=4.0):
    """a stage deck extension (x0..x1, z0..z1, top at y) with a facade on its front edge and an emissive edge line"""
    L.B(bucket, deck_mat, x0, x1, y - 0.3, y, z0, z1, tile=tile, seg=10)
    L.B(bucket, face_mat, x0, x1, 0, y - 0.3, z1 - 0.6, z1, tile=5, seg=8)
    if edge_bucket:
        grp = 'EMIT_' + edge_bucket[6:].rsplit('_', 1)[0].lower()
        L.B(edge_bucket, grp, x0, x1, y - 0.06, y + 0.04, z1 - 0.06, z1 + 0.04, seg=10.0)


# ------------------------------------------------------------------ SFX hardware at the room's anchors
def fx_anchors(kinds=None, groups=None):
    """the FX_ empties already in EXPORT: [(object, kind, group, glTF position)]"""
    out = []
    for o in L.coll('EXPORT').objects:
        a = o.name.split('_')
        if o.type != 'EMPTY' or len(a) < 4 or a[0] != 'FX':
            continue
        kind, group = a[1].lower(), a[2]
        if kinds and kind not in kinds:
            continue
        if groups and group not in groups:
            continue
        out.append((o, kind, group, to_gltf(o.location)))
    return out


HOUSING_H = {'flame': 0.62, 'co2': 0.55, 'gerb': 0.3, 'confetti': 0.5}


def sfx_housings(bucket, kinds=('flame', 'co2', 'gerb', 'confetti'), groups=None, min_y=0.5, max_y=6.0, raise_anchor=True, yaw_to=(0.0, 0.0, 200.0)):
    """real hardware under every deck-level SFX anchor (min_y ≤ y ≤ max_y): flame cannons (a steel box + a nozzle
    ring), CO2 jets (a tank + an angled nozzle), sparkular units (low black boxes), confetti blowers (a drum). The
    anchor moves up to the nozzle mouth so the effect starts at the hardware, not inside it."""
    n = 0
    for o, kind, group, p in fx_anchors(kinds, groups):
        if not (min_y <= p.y <= max_y):
            continue
        h = HOUSING_H[kind]
        x, y, z = p.x, p.y - 0.05, p.z
        yaw = math.degrees(math.atan2(yaw_to[0] - x, yaw_to[2] - z))
        R = L.rot_y(yaw)
        if kind == 'flame':
            L.OB(bucket, 'M_DressCase', (0.9, h - 0.12, 0.9), (x, y + (h - 0.12) / 2, z), rot_g=R, seg=4.0)
            L.C(bucket, 'M_DressNozzle', x, y + h - 0.12, z, 0.2, 0.12, n=10)
            L.C(bucket, 'M_DressNozzle', x, y + h - 0.12, z, 0.09, 0.14, n=8)
        elif kind == 'co2':
            L.C(bucket, 'M_DressNozzle', x, y, z, 0.17, h * 0.85, n=10)
            L.OB(bucket, 'M_DressCase', (0.55, 0.12, 0.55), (x, y + 0.06, z), rot_g=R, seg=4.0)
            L.C(bucket, 'M_DressNozzle', x, y + h * 0.85, z, 0.06, 0.3, n=6, rot_g=R @ L.rot_x(-20))
        elif kind == 'gerb':
            L.OB(bucket, 'M_DressCase', (0.42, h, 0.36), (x, y + h / 2, z), rot_g=R, seg=4.0)
        elif kind == 'confetti':
            L.C(bucket, 'M_DressCase', x, y, z, 0.32, h * 0.7, n=10)
            L.C(bucket, 'M_DressNozzle', x, y + h * 0.7, z, 0.12, h * 0.4, n=8, rot_g=R @ L.rot_x(-25))
        if raise_anchor:
            o.location = L.G(p.x, p.y + h - 0.05, p.z)
        n += 1
    return n


# ------------------------------------------------------------------ field dressing
def banner_mast(bucket, banner_bucket, banner_mat, x, z, h=12.0, bw=1.6, bh=7.0, yaw=0.0, lamp_bucket=None, y0=0.0):
    """a mast with a long vertical banner on a top arm (alpha-masked texture, double sided) and an optional lamp"""
    R = L.rot_y(yaw)
    L.C(bucket, 'M_DressPole', x, y0, z, 0.11, h, n=8, r2=0.07)
    L.OB(bucket, 'M_DressCase', (0.6, 0.35, 0.6), (x, y0 + 0.17, z), rot_g=R, seg=4.0)
    arm_a = Vector((x, y0 + h - 0.3, z)); arm_b = arm_a + R @ Vector((bw + 0.2, 0, 0))
    L.tube(bucket, 'M_DressPole', [tuple(arm_a), tuple(arm_b)], 0.04, n=5)
    p0 = arm_a + R @ Vector((0.15, 0, 0.02)); p1 = arm_a + R @ Vector((0.15 + bw, 0, 0.02))
    L.quad(banner_bucket, banner_mat, [tuple(p0 - Vector((0, bh, 0))), tuple(p1 - Vector((0, bh, 0))), tuple(p1), tuple(p0)])
    if lamp_bucket:
        grp = 'EMIT_' + lamp_bucket[6:].rsplit('_', 1)[0].lower()
        L.E(lamp_bucket, grp, (x, y0 + h + 0.15, z), (0.2, 0.2, 0.2), seg=(8, 5))
    return Vector((x, y0 + h, z))


def festoon(wire_bucket, bulb_bucket, a, b, sag=1.5, bulbs=14, wire_r=0.02, bulb_r=0.11):
    """a catenary between glTF points a and b (sag m at the middle) with evenly spaced bulbs (bulb_bucket: emissive)"""
    a, b = _v(a), _v(b)
    pts = []
    for k in range(13):
        t = k / 12
        q = a.lerp(b, t); q.y -= sag * 4 * t * (1 - t)
        pts.append(tuple(q))
    L.tube(wire_bucket, 'M_DressSteel', pts, wire_r, n=4)
    grp = 'EMIT_' + bulb_bucket[6:].rsplit('_', 1)[0].lower()
    for k in range(bulbs):
        t = (k + 0.5) / bulbs
        q = a.lerp(b, t); q.y -= sag * 4 * t * (1 - t) + bulb_r
        L.E(bulb_bucket, grp, tuple(q), (bulb_r, bulb_r * 1.2, bulb_r), seg=(6, 4))


def glow_cluster(stem_bucket, cap_bucket, x, z, rng, n=7, r=3.0, size=1.0, reeds=6, y0=0.0):
    """bioluminescent caps on stems + a few dark reeds around (cap_bucket: emissive), seeded by rng"""
    grp = 'EMIT_' + cap_bucket[6:].rsplit('_', 1)[0].lower()
    for k in range(n):
        a = rng.uniform(0, 2 * math.pi); d = rng.uniform(0, r)
        px, pz = x + math.cos(a) * d, z + math.sin(a) * d
        s = size * rng.uniform(0.5, 1.4); hh = s * rng.uniform(0.8, 1.8)
        lean = L.rot_z(rng.uniform(-10, 10)) @ L.rot_x(rng.uniform(-10, 10))
        L.C(stem_bucket, 'M_DressStem', px, y0, pz, 0.09 * s, hh, n=6, r2=0.06 * s, rot_g=lean)
        top = Vector((px, y0, pz)) + lean @ Vector((0, hh, 0))
        L.lathe(cap_bucket, grp, tuple(top), [(0.55 * s, -0.05 * s), (0.5 * s, 0.12 * s), (0.3 * s, 0.3 * s), (0.0, 0.36 * s)], n=10, rot_g=lean)
    for k in range(reeds):
        a = rng.uniform(0, 2 * math.pi); d = rng.uniform(r * 0.5, r * 1.5)
        px, pz = x + math.cos(a) * d, z + math.sin(a) * d
        hh = size * rng.uniform(2.0, 4.5)
        L.C(stem_bucket, 'M_DressStem', px, y0, pz, 0.05 * size, hh, n=4, r2=0.005, rot_g=L.rot_z(rng.uniform(-8, 8)) @ L.rot_x(rng.uniform(-8, 8)))


def tint_bucket(bucket, rgb):
    """multiply the bake of every part in a bucket so far (fs_lib's per-vertex 'tint'): darker / warmer stone, decks"""
    for ob in L.BUCKETS.get(bucket, []):
        t = ob.data.attributes.get('tint')
        if t:
            t.data.foreach_set('color', [*rgb, 1.0] * len(ob.data.vertices))


def _emit(light_bucket):
    """'light_<group>_01' -> 'EMIT_<group>'"""
    return 'EMIT_' + light_bucket[6:].rsplit('_', 1)[0].lower()


# ------------------------------------------------------------------ sky + back layer
def halo_ring(group, center, r_in, r_out, segs=48, index=1, material='M_LedOff', frame_bucket=None, spoke_bucket=None,
              spokes=24, spoke_len=(10.0, 18.0), spoke_r=0.35, yaw=0.0):
    """a giant LED ring (an FX_LEDWALL mesh: planar UVs over its bounding square, so the engine's image shows through
    the ring) facing +Z at `center`, a dark steel back ring (frame_bucket) and radiating keyline spokes (spoke_bucket,
    alternating long / short): a sun / halo frame behind a hero piece. Returns the spoke tips (sunburst launch points)."""
    name = 'FX_LEDWALL_%s_%02d' % (group.upper(), index)
    c = _v(center); R = L.rot_y(yaw)

    def ring(r, k):
        a = 2 * math.pi * k / segs
        return c + R @ Vector((r * math.cos(a), r * math.sin(a), 0))
    bm = bmesh.new(); uvl = bm.loops.layers.uv.verify()
    for k in range(segs):
        q = [ring(r_in, k), ring(r_out, k), ring(r_out, k + 1), ring(r_in, k + 1)]
        f = bm.faces.new([bm.verts.new(L.G(*p)) for p in q])
        for lp, p in zip(f.loops, q):
            d = R.transposed() @ (p - c)
            lp[uvl].uv = (0.5 + d.x / (2 * r_out), 0.5 + d.y / (2 * r_out))
    bm.normal_update()
    bm.faces.ensure_lookup_table()
    if bm.faces and (R.transposed() @ to_gltf(bm.faces[0].normal)).z < 0:   # (face +Z)
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); ob.data.materials.append(L.mat(material))
    L.coll('EXPORT').objects.link(ob)
    if frame_bucket:
        back = R @ Vector((0, 0, -0.7))
        for k in range(segs):
            a = ring((r_in + r_out) / 2, k) + back; b = ring((r_in + r_out) / 2, k + 1) + back
            d = R.transposed() @ (b - a)
            L.OB(frame_bucket, 'M_DressSteel', (d.length + 0.05, r_out - r_in + 0.6, 0.9), tuple((a + b) / 2), rot_g=R @ L.rot_z(math.degrees(math.atan2(d.y, d.x))), seg=20.0)
    tips = []
    if spoke_bucket:
        for k in range(spokes):
            a = 2 * math.pi * (k + 0.5) / spokes; ln = spoke_len[k % 2]
            p0 = c + R @ Vector(((r_out + 1.0) * math.cos(a), (r_out + 1.0) * math.sin(a), 0.1))
            p1 = c + R @ Vector(((r_out + 1.0 + ln) * math.cos(a), (r_out + 1.0 + ln) * math.sin(a), 0.1))
            if p1.y < 1.0:
                continue
            L.tube(spoke_bucket, _emit(spoke_bucket), [tuple(p0), tuple(p1)], spoke_r, n=5)
            tips.append(p1)
    return tips


def lanterns(wire_bucket, lamp_bucket, a, b, sag=4.0, n=10, size=0.9, drop=(1.5, 4.0), rng=None):
    """a catenary cable between a and b with lanterns hanging on drop lines (lamp_bucket: emissive) - a sky garland"""
    a, b = _v(a), _v(b)
    pts = []
    for k in range(17):
        t = k / 16; q = a.lerp(b, t); q.y -= sag * 4 * t * (1 - t); pts.append(tuple(q))
    L.tube(wire_bucket, 'M_DressSteel', pts, 0.05, n=4)
    for k in range(n):
        t = (k + 0.5) / n; q = a.lerp(b, t); q.y -= sag * 4 * t * (1 - t)
        dl = drop[0] + (drop[1] - drop[0]) * (rng.random() if rng else (0.5 + 0.5 * math.sin(k * 2.3)))
        L.tube(wire_bucket, 'M_DressSteel', [tuple(q), tuple(q - Vector((0, dl, 0)))], 0.02, n=3)
        L.OB(lamp_bucket, _emit(lamp_bucket), (size, size * 1.4, size), tuple(q - Vector((0, dl + size * 0.7, 0))), rot_g=L.rot_y(k * 37.0), seg=8.0)


def inflatable(bucket, material, center, radius, profile=None, tether_bucket=None, ground_y=0.0, n=14):
    """a tethered inflatable: a lathe body (profile [(r, y)] in units of radius, default a squashed dome) at `center`,
    a tether line to the ground. Rooms add their own features (faces, hats) on top. Returns the body's top point."""
    c = _v(center)
    prof = profile or [(0.0, -0.75), (0.7, -0.62), (1.0, -0.15), (0.96, 0.3), (0.72, 0.68), (0.0, 0.82)]
    L.lathe(bucket, material, tuple(c), [(r * radius, y * radius) for r, y in prof], n=n)
    if tether_bucket:
        L.tube(tether_bucket, 'M_DressSteel', [tuple(c - Vector((0, radius * 0.7, 0))), (c.x + radius * 0.3, ground_y, c.z + radius * 0.2)], 0.04, n=3)
    return c + Vector((0, radius * 0.82, 0))


# ------------------------------------------------------------------ the far field
def ferris_wheel(steel_bucket, light_bucket, x, z, r=22.0, yaw=0.0, cars=16, width=3.0, spokes=16):
    """a ferris wheel facing +Z (rotated by yaw): two rims, spokes, an A-frame on each side, gondolas, an emissive
    rim ring and spoke lights (light_bucket) - a far-field silhouette that reads at night"""
    R = L.rot_y(yaw); hub = Vector((x, r + 4.0, z))

    def P(a, rr, s):
        return hub + R @ Vector((rr * math.cos(a), rr * math.sin(a), s * width / 2))
    for s in (-1, 1):
        L.tube(steel_bucket, 'M_DressSteel', [tuple(P(2 * math.pi * k / 40, r, s)) for k in range(41)], 0.28, n=5)
        L.tube(light_bucket, _emit(light_bucket), [tuple(P(2 * math.pi * k / 40, r + 0.35, s)) for k in range(41)], 0.12, n=4)
        for k in range(spokes):
            a = 2 * math.pi * k / spokes
            L.tube(steel_bucket, 'M_DressSteel', [tuple(hub + R @ Vector((0, 0, s * width / 2))), tuple(P(a, r, s))], 0.12, n=4)
            if k % 2 == 0:
                L.tube(light_bucket, _emit(light_bucket), [tuple(P(a, r * 0.25, s * 1.08)), tuple(P(a, r * 0.95, s * 1.08))], 0.06, n=3)
        for e in (-1, 1):                                                          # the A-frame legs
            foot = hub + R @ Vector((e * r * 0.55, -(r + 4.0), s * (width / 2 + 2.5)))
            L.tube(steel_bucket, 'M_DressSteel', [tuple(foot), tuple(hub + R @ Vector((0, 0, s * (width / 2 + 0.4))))], 0.45, n=6)
    for k in range(cars):
        a = 2 * math.pi * (k + 0.5) / cars
        q = P(a, r, 0) - Vector((0, 1.6, 0))
        L.OB(steel_bucket, 'M_DressCase', (1.8, 1.6, width * 0.7), tuple(q), rot_g=R, seg=4.0)
    return hub


def tent_camp(bucket, glow_bucket, x0, x1, z0, z1, rng, n=60, glow_share=0.35, size=(2.2, 4.0)):
    """a campsite behind the field: little ridge tents (4-sided cones) in loose rows, some with a warm lantern glow"""
    for k in range(n):
        x = rng.uniform(x0, x1); z = rng.uniform(z0, z1); s = rng.uniform(*size)
        L.C(bucket, 'M_DressCase', x, 0.0, z, s * 0.75, s * 0.7, n=4, r2=0.0, rot_g=L.rot_y(rng.uniform(0, 90)))
        if glow_bucket and rng.random() < glow_share:
            L.E(glow_bucket, _emit(glow_bucket), (x + s * 0.5, 0.35, z + s * 0.5), (0.22, 0.22, 0.22), seg=(6, 4))


# ------------------------------------------------------------------ light groups
def tag_lights(prefix='LIGHT_'):
    """after the room's join step: every LIGHT_<GROUP>_NN object the kit made gets the engine's emissive tags"""
    n = 0
    for o in L.coll('EXPORT').objects:
        if o.type != 'MESH' or not o.name.startswith(prefix) or 'group' in o.keys():
            continue
        grp = o.name[len(prefix):].rsplit('_', 1)[0].lower()
        if grp in L.EMIT:
            o['group'] = grp; o['color'] = L.EMIT[grp][0]; o['kind'] = 'emissive'
            n += 1
    return n
