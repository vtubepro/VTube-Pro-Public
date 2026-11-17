"""Validate AI creation packages and rooms for VTube Pro (docs/AI_CONNECT.md). Standard library only.

    python tools/aiconnect_package.py package <package.json>     schema + ids + scene.json + build-script policy
    python tools/aiconnect_package.py room <assets/scenes/<id>>    room folder vs the contract + budgets
    python tools/aiconnect_package.py stage <package.json> <dir>   write build.py / scene.json / inline assets into <dir>

Prints one JSON object {ok, errors[], warnings[], stats}; every issue carries a `fix`. Exit 0 when ok.
The build-script policy is best-effort: the approval click is the real boundary.
"""
import ast, base64, json, os, re, struct, sys

FORMAT = 'vtube-pro.creation/1'
ID_RE = re.compile(r'^[a-z0-9][a-z0-9_]{1,47}$')
MAX_TRIS, MAX_MB, MAX_TEX = 80_000, 25, 2048
BANNED_MODULES = {'subprocess', 'socket', 'urllib', 'requests', 'http', 'ctypes', 'importlib', 'shutil', 'multiprocessing', 'ftplib', 'smtplib', 'webbrowser', 'winreg', 'asyncio'}
BANNED_CALLS = {'exec', 'eval', 'compile', '__import__', 'system', 'popen', 'spawnl', 'spawnv', 'startfile', 'remove', 'unlink', 'rmdir', 'removedirs', 'rename', 'replace'}
BANNED_ATTRS = {'addon_install', 'addon_enable', 'save_userpref', 'preferences'}


def issue(lst, msg, fix):
    lst.append({'msg': msg, 'fix': fix})


def check_policy(src, errors, warnings):
    try:
        tree = ast.parse(src)
    except SyntaxError as e:
        issue(errors, f'build script has a syntax error at line {e.lineno}: {e.msg}', 'Fix the Python syntax.'); return
    for n in ast.walk(tree):
        if isinstance(n, (ast.Import, ast.ImportFrom)):
            mods = [a.name for a in n.names] if isinstance(n, ast.Import) else [n.module or '']
            for m in mods:
                if m.split('.')[0] in BANNED_MODULES:
                    issue(errors, f'line {n.lineno}: import of "{m}" is not allowed in build scripts', 'Use only bpy, bmesh, mathutils, math, random, json, os.path / os.environ.')
        elif isinstance(n, ast.Call):
            f = n.func
            name = f.id if isinstance(f, ast.Name) else f.attr if isinstance(f, ast.Attribute) else ''
            if name in BANNED_CALLS:
                issue(errors, f'line {n.lineno}: call to "{name}()" is not allowed', 'Build geometry with bpy only; write files only with the glTF exporter / image.save into VTP_OUT.')
            if name == 'open' and len(n.args) > 1 and isinstance(n.args[1], ast.Constant) and any(c in str(n.args[1].value) for c in 'wax+'):
                issue(warnings, f'line {n.lineno}: open() for writing', 'Only write inside os.environ["VTP_OUT"].')
        elif isinstance(n, ast.Attribute) and n.attr in BANNED_ATTRS:
            issue(errors, f'line {n.lineno}: "{n.attr}" (add-ons / preferences) is not allowed', 'Build scripts must not install add-ons or change preferences.')
    if 'VTP_OUT' not in src:
        issue(errors, 'build script never reads os.environ["VTP_OUT"]', 'Export to os.path.join(os.environ["VTP_OUT"], "scene.glb").')
    if 'export_scene.gltf' not in src:
        issue(errors, 'build script never exports glTF', 'End with bpy.ops.export_scene.gltf(filepath=..., export_format="GLB", export_yup=True, export_extras=True, export_cameras=True, export_lights=False, export_apply=True).')
    elif 'export_extras' not in src:
        issue(warnings, 'glTF export without export_extras=True', 'Pass export_extras=True or SPOT pose / seatHeight / LIGHT group extras are lost.')


def validate_package(pkg):
    errors, warnings = [], []
    if not isinstance(pkg, dict):
        issue(errors, 'package is not a JSON object', 'Return one JSON object.'); return errors, warnings
    if pkg.get('format') != FORMAT:
        issue(errors, f'format must be "{FORMAT}"', f'Set "format": "{FORMAT}".')
    if pkg.get('kind') != 'room':
        issue(errors, 'kind must be "room" (the only kind this version installs)', 'Set "kind": "room".')
    action = pkg.get('action', 'create')
    if action not in ('create', 'modify'):
        issue(errors, 'action must be "create" or "modify"', 'Use "create" for a new room, "modify" to change an installed one.')
    rid = str(pkg.get('id', ''))
    if not ID_RE.match(rid):
        issue(errors, f'id "{rid}" is not a valid room id', 'Lowercase letters, digits and _ only, 2-48 chars, e.g. "neon_ramen_bar".')
    scene = pkg.get('scene')
    if action == 'create':
        if not isinstance(scene, dict):
            issue(errors, 'scene (the scene.json object) is missing', 'Add "scene": {"name": ..., "model": "scene.glb", "modes": ["talk","react"], "defaultCamera": "CAM_WIDE"}.')
        else:
            if not scene.get('name'): issue(errors, 'scene.name is missing', 'Give the room a display name.')
            if scene.get('model', 'scene.glb') != 'scene.glb': issue(warnings, 'scene.model is not scene.glb', 'Use "scene.glb" (the build exports that file).')
            modes = scene.get('modes', ['talk', 'react'])
            if not isinstance(modes, list) or not set(modes) <= {'talk', 'react'}: issue(errors, 'scene.modes must be a list of "talk" / "react"', 'Use ["talk", "react"].')
            if scene.get('defaultCamera', 'CAM_WIDE') != 'CAM_WIDE' and not str(scene.get('defaultCamera', '')).startswith('CAM_'):
                issue(errors, 'scene.defaultCamera must name a CAM_* node', 'Use "CAM_WIDE".')
    elif scene is not None and not isinstance(scene, dict):
        issue(errors, 'scene (patch) must be an object', 'For modify, "scene" is a partial scene.json deep-merged into the existing one.')
    build = pkg.get('build')
    if not isinstance(build, dict) or not isinstance(build.get('script'), str) or len(build['script']) < 40:
        issue(errors, 'build.script (the Blender Python build script) is missing', 'Add "build": {"script": "<bpy source>"} - see the worked example in docs/AI_CONNECT.md.')
    else:
        if len(build['script']) > 400_000: issue(errors, 'build.script is over 400 KB', 'Generate geometry procedurally instead of embedding data.')
        check_policy(build['script'], errors, warnings)
    for i, a in enumerate(pkg.get('assets') or []):
        p = str(a.get('path', '')) if isinstance(a, dict) else ''
        if not p or p.startswith(('/', '\\')) or '..' in p or ':' in p:
            issue(errors, f'assets[{i}].path "{p}" is not a safe relative path', 'Use a relative path like "textures/wood.png".'); continue
        src = a.get('source')
        if src == 'inline' and not a.get('dataBase64'): issue(errors, f'assets[{i}] inline without dataBase64', 'Add the base64 data or use source "comfy".')
        elif src == 'comfy' and not a.get('prompt'): issue(errors, f'assets[{i}] comfy without prompt', 'Describe the texture in "prompt".')
        elif src not in ('inline', 'comfy'): issue(errors, f'assets[{i}].source must be "inline" or "comfy"', 'Download nothing: embed small files or let ComfyUI paint them locally.')
    return errors, warnings


# ------------------------------------------------------------------ GLB reading (no dependencies)
def read_glb(path):
    with open(path, 'rb') as f:
        data = f.read()
    if data[:4] != b'glTF': raise ValueError('not a GLB file')
    ln, typ = struct.unpack_from('<I4s', data, 12)
    if typ != b'JSON': raise ValueError('first chunk is not JSON')
    return json.loads(data[20:20 + ln]), len(data)


def glb_stats(gltf):
    acc = gltf.get('accessors', [])
    meshes = gltf.get('meshes', [])
    mesh_tris, color0 = [], 0
    for m in meshes:
        t = 0
        for p in m.get('primitives', []):
            if p.get('mode', 4) != 4: continue
            if 'indices' in p: t += acc[p['indices']]['count'] // 3
            elif 'POSITION' in p.get('attributes', {}): t += acc[p['attributes']['POSITION']]['count'] // 3
            if 'COLOR_0' in p.get('attributes', {}): color0 += 1
        mesh_tris.append(t)
    nodes = gltf.get('nodes', [])
    tris = sum(mesh_tris[n['mesh']] for n in nodes if 'mesh' in n and not re.match(r'^(COLLIDE_|FLOOR_)', n.get('name', '')))
    return {'triangles': tris, 'nodes': len(nodes), 'meshes': len(meshes), 'materials': len(gltf.get('materials', [])),
            'images': len(gltf.get('images', [])), 'primitivesWithColor0': color0,
            'drawCallsApprox': sum(len(meshes[n['mesh']].get('primitives', [])) for n in nodes if 'mesh' in n)}


def png_size(path):
    with open(path, 'rb') as f:
        h = f.read(24)
    return struct.unpack('>II', h[16:24]) if h[:8] == b'\x89PNG\r\n\x1a\n' else None


# ------------------------------------------------------------------ world space (4x4 column-major, like glTF)
# A SPOT's height is where the studio puts it: its parents' translation / rotation / scale count (an exporter that
# parents everything under a moved or 0.01-scaled root used to get false "off the floor" warnings, or none).
def _local_matrix(n):
    m = n.get('matrix')
    if isinstance(m, list) and len(m) == 16:
        return [float(v) for v in m]
    t = n.get('translation') or [0, 0, 0]
    x, y, z, w = n.get('rotation') or [0, 0, 0, 1]
    s = n.get('scale') or [1, 1, 1]
    x2, y2, z2 = x + x, y + y, z + z
    xx, xy, xz, yy, yz, zz, wx, wy, wz = x * x2, x * y2, x * z2, y * y2, y * z2, z * z2, w * x2, w * y2, w * z2
    return [(1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
            (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
            (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
            float(t[0]), float(t[1]), float(t[2]), 1]


def _mul(a, b):
    return [sum(a[k * 4 + r] * b[c * 4 + k] for k in range(4)) for c in range(4) for r in range(4)]


def world_positions(gltf):
    """World-space origin of every node, walking scene `scene` (default 0) like shared/roomGlb.ts worldMatrices.
    A node the scene never reaches keeps its own transform (as if it were a root)."""
    nodes = gltf.get('nodes', [])
    scenes = gltf.get('scenes') or []
    si = gltf.get('scene', 0)
    if isinstance(si, int) and 0 <= si < len(scenes):
        roots = scenes[si].get('nodes', [])
    else:
        kids = {c for n in nodes for c in _kids(n)}
        roots = [i for i in range(len(nodes)) if i not in kids]
    world = [None] * len(nodes)
    stack = [(i, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) for i in roots]
    guard = 0
    while stack and guard < 200_000:
        guard += 1
        i, pm = stack.pop()
        if not isinstance(i, int) or not 0 <= i < len(nodes) or world[i] is not None: continue
        world[i] = _mul(pm, _local_matrix(nodes[i]))
        stack.extend((c, world[i]) for c in _kids(nodes[i]))
    return [tuple((w if w is not None else _local_matrix(nodes[i]))[12:15]) for i, w in enumerate(world)]


AREA_KEY = re.compile(r'^[a-z0-9][a-z0-9_-]{0,23}$')


def _only_areas(n):
    v = (n.get('extras') or {}).get('areas') if isinstance(n.get('extras'), dict) else None
    if isinstance(v, list): return [str(x).strip().lower() for x in v]
    if isinstance(v, str) and v.strip(): return [x.strip().lower() for x in v.split(',') if x.strip()]
    return None


def _kids(n):
    """A node's children; anything but a list of node indices is malformed glTF and counts as none (it used to crash
    the whole check of a room with areas: `children: 3`)."""
    c = n.get('children') if isinstance(n, dict) else None
    return [x for x in c if isinstance(x, int) and not isinstance(x, bool)] if isinstance(c, list) else []


def _name(n):
    v = n.get('name') if isinstance(n, dict) else None
    return v if isinstance(v, str) else ''


def area_views(nodes, scene):
    """[(area key, [(node index, contract name)])]: one view per scene.json area, the nodes the studio keeps when it
    loads that area (src/scene/areas.ts applyArea: its own <AREA>__ nodes renamed, the unprefixed shared ones; another
    area's nodes, nodes whose extras `areas` leave this one out, and their children are dropped), or one plain view ('')
    for a room without areas."""
    areas = scene.get('areas') if isinstance(scene.get('areas'), dict) else {}
    keys = [k for k in areas if isinstance(k, str) and AREA_KEY.match(k)]
    if not keys:
        return [('', [(i, _name(n)) for i, n in enumerate(nodes)])]
    parent = {}
    for i, n in enumerate(nodes):
        for c in _kids(n): parent.setdefault(c, i)
    out = []
    for k in keys:
        mine, others = k.upper() + '__', tuple(o.upper() + '__' for o in keys if o != k)
        drop = set()
        for i, n in enumerate(nodes):
            only = _only_areas(n)
            if (others and _name(n).startswith(others)) or (only is not None and k not in only): drop.add(i)
        view = []
        for i, n in enumerate(nodes):
            j, depth = i, 0
            while j is not None and j not in drop and depth < 512: j, depth = parent.get(j), depth + 1
            if j is not None and j in drop: continue
            nm = _name(n)
            view.append((i, nm[len(mine):] if nm.startswith(mine) and len(nm) > len(mine) else nm))
        out.append((k, view))
    return out


def view_cost(gltf, view):
    """(visible triangles, draw calls) of the nodes one area keeps (glb_stats rules: COLLIDE_ / FLOOR_ not drawn)."""
    acc, meshes, nodes = gltf.get('accessors', []), gltf.get('meshes', []), gltf.get('nodes', [])
    tris = calls = 0
    for i, b in view:
        m = nodes[i].get('mesh')
        if not isinstance(m, int) or not 0 <= m < len(meshes): continue
        prims = meshes[m].get('primitives', [])
        calls += len(prims)
        if re.match(r'^(COLLIDE_|FLOOR_)', b): continue
        for p in prims:
            if p.get('mode', 4) != 4: continue
            if 'indices' in p: tris += acc[p['indices']]['count'] // 3
            elif 'POSITION' in p.get('attributes', {}): tris += acc[p['attributes']['POSITION']]['count'] // 3
    return tris, calls


def validate_room(folder):
    errors, warnings, stats = [], [], {}
    sj = os.path.join(folder, 'scene.json')
    if not os.path.isfile(sj):
        issue(errors, 'scene.json is missing', 'Write scene.json next to scene.glb (see docs/AI_CONNECT.md).'); return errors, warnings, stats
    try:
        scene = json.load(open(sj, encoding='utf-8'))
    except Exception as e:
        issue(errors, f'scene.json is not valid JSON ({e})', 'Fix the JSON.'); return errors, warnings, stats
    glb = os.path.join(folder, scene.get('model', 'scene.glb'))
    if not os.path.isfile(glb):
        issue(errors, f'{os.path.basename(glb)} is missing', 'Run the build script; it must export scene.glb.'); return errors, warnings, stats
    try:
        gltf, size = read_glb(glb)
    except Exception as e:
        issue(errors, f'scene.glb could not be read ({e})', 'Export as GLB (export_format="GLB").'); return errors, warnings, stats
    stats = glb_stats(gltf); stats['mb'] = round(size / 1048576, 2)
    nodes = gltf.get('nodes', [])
    cams = {n.get('name', '') for n in nodes if 'camera' in n}
    try:
        pos = world_positions(gltf)
    except (TypeError, ValueError, IndexError, AttributeError):   # a malformed transform: the local one, as before
        pos = [tuple((n.get('translation') or [0, 0, 0])[:3]) for n in nodes]
    views = area_views(nodes, scene)   # one view per area (rooms with areas), else one plain view: same checks as before
    spot_total, heights, seen = 0, {}, set()
    for key, view in views:
        tag = f'area "{key}": ' if key else ''
        area = scene['areas'][key] if key and isinstance(scene['areas'][key], dict) else {}
        names = {b for _i, b in view}
        vcams = {b for i, b in view if 'camera' in nodes[i]}
        spots = sorted(b for b in names if re.fullmatch(r'SPOT_\d\d', b))
        spot_total += len(spots)
        if not spots: issue(errors, f'{tag}no SPOT_01..SPOT_12 nodes', 'Add empties SPOT_01... at floor level; +Z (Blender -Y) = the way the avatar faces.')
        if len(spots) > 12: issue(errors, f'{tag}{len(spots)} spots (max 12)', 'Keep SPOT_01..SPOT_12.')
        for i, b in view:
            if not re.fullmatch(r'SPOT_\d\d', b) or i in seen: continue
            seen.add(i)   # (a spot shared by several areas is checked once)
            n, nm = nodes[i], nodes[i].get('name', '')
            ex = n.get('extras', {})
            if ex.get('pose') not in ('sit', 'stand'): issue(warnings, f'{nm} has no pose extra', f'Set custom property pose = "sit" or "stand" on {nm} and export with export_extras=True.')
            if ex.get('pose') == 'sit' and not 0.15 <= float(ex.get('seatHeight', 0.45)) <= 1.4: issue(errors, f'{nm} seatHeight out of 0.15-1.4', 'Seat surface height above the node origin in metres.')
            y = pos[i][1]   # world height: the parents' translation / rotation / scale count
            heights[nm] = round(y, 3) + 0.0   # (+ 0.0: never "-0.0")
            if abs(y) > 3: issue(warnings, f'{nm} is {y:.1f} m off the floor', 'Spot origins sit on the floor (y = 0) unless on a FLOOR_* stage.')
        default_cam = area.get('defaultCamera', scene.get('defaultCamera', 'CAM_WIDE'))
        if default_cam not in vcams: issue(errors, f'{tag}default camera {default_cam} is not a camera in scene.glb', 'Add a camera object named CAM_WIDE and export with export_cameras=True.')
        if 'react' in area.get('modes', scene.get('modes', ['talk', 'react'])):
            if 'SCREEN' not in names: issue(errors, f'{tag}react mode but no SCREEN node', 'Add a 16:9 plane named SCREEN (UVs 0..1, facing the camera) or drop "react" from modes.')
            if 'CAM_REACT' not in vcams: issue(warnings, f'{tag}no CAM_REACT camera', 'Add CAM_REACT framing the screen at ~80% of the width.')
        for req, fix in (('DOOR', 'Add the door leaf DOOR (origin = hinge) so entrances play.'), ('DOOR_OUTSIDE', 'Add an empty DOOR_OUTSIDE just outside the door, facing in.'), ('PATH_01', 'Add PATH_01... waypoints from the door to the room centre.')):
            if req not in names: issue(warnings, f'{tag}no {req} node (avatars pop in instead of walking in)', fix)
    stats['spots'], stats['cameras'], stats['spotHeights'] = spot_total, sorted(cams), heights
    if views[0][0]: stats['areas'] = [k for k, _v in views]
    if not any(b.startswith('LIGHT_') for _k, view in views for _i, b in view): issue(warnings, 'no LIGHT_* fixtures', 'Mark lamps / neon with LIGHT_* empties (extras group, color, kind) so lighting states can drive them.')
    mats = [m.get('name', '') for m in gltf.get('materials', [])]
    if not any(m.startswith('EMIT_') for m in mats): issue(warnings, 'no EMIT_<group> materials', 'Name glowing materials EMIT_neon / EMIT_sign so the light engine animates them.')
    # a room with areas draws one area at a time: triangles + draw calls count per area (the file size counts whole)
    budgets = [(f'area "{k}": ', *view_cost(gltf, v)) for k, v in views] if views[0][0] else [('', stats['triangles'], stats['drawCallsApprox'])]
    if views[0][0]: stats['areaTriangles'] = {k: b[1] for (k, _v), b in zip(views, budgets)}
    for tag, tris, _calls in budgets:
        if tris > MAX_TRIS: issue(errors, f"{tag}{tris:,} visible triangles (budget {MAX_TRIS:,})", 'Decimate far / hidden geometry, use LOD siblings, drop unseen faces.')
    if stats['mb'] > MAX_MB: issue(errors, f"scene.glb is {stats['mb']} MB (budget {MAX_MB} MB)", 'Use 2048 atlases / 1024 tiling textures, JPEG for colour maps, fewer unique images.')
    for tag, _tris, calls in budgets:
        if calls > 180: issue(warnings, f"{tag}~{calls} draw calls (aim 170-180 max)", 'Join static meshes that share a material.')
    if stats['meshes'] and not stats['primitivesWithColor0']: issue(warnings, 'no baked vertex colours (COLOR_0)', 'Bake AO / light gradients into a colour attribute - the engine turns room shadows off.')
    for fn, want in (('preview.png', (1280, 720)), ('thumb.png', (480, 270))):
        p = os.path.join(folder, fn)
        if not os.path.isfile(p): issue(warnings, f'{fn} missing', f'Render {want[0]}x{want[1]} from CAM_WIDE in the app (docs/BLENDER_PLAYBOOK.md 11.4), or render it from the build script into VTP_OUT.')
    tex = os.path.join(folder, 'textures')
    if os.path.isdir(tex):
        for fn in os.listdir(tex):
            s = png_size(os.path.join(tex, fn)) if fn.lower().endswith('.png') else None
            if s and max(s) > MAX_TEX: issue(warnings, f'textures/{fn} is {s[0]}x{s[1]}', f'Keep textures at or below {MAX_TEX}x{MAX_TEX}.')
    return errors, warnings, stats


def stage(pkg, out):
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, 'build.py'), 'w', encoding='utf-8', newline='\n') as f: f.write(pkg['build']['script'])
    if isinstance(pkg.get('scene'), dict):
        with open(os.path.join(out, 'scene.patch.json'), 'w', encoding='utf-8') as f: json.dump(pkg['scene'], f, indent=2)
    for a in pkg.get('assets') or []:
        if a.get('source') == 'inline':
            dst = os.path.join(out, 'assets', a['path']); os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, 'wb') as f: f.write(base64.b64decode(a['dataBase64']))


def main(argv):
    if len(argv) < 3 or argv[1] not in ('package', 'room', 'stage'):
        print(__doc__); return 2
    if argv[1] == 'room':
        e, w, s = validate_room(argv[2])
    else:
        pkg = json.load(open(argv[2], encoding='utf-8'))
        e, w = validate_package(pkg); s = {'id': pkg.get('id') if isinstance(pkg, dict) else None}
        if argv[1] == 'stage' and not e: stage(pkg, argv[3])
    print(json.dumps({'ok': not e, 'errors': e, 'warnings': w, 'stats': s}, indent=1))
    return 0 if not e else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
