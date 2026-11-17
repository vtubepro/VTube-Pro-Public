"""
Third-party Blender add-ons for VTube Pro build scripts (headless or in a visible window).

Usage inside any Blender script (works with `--factory-startup`, which is how every team build runs):

    import sys, os
    sys.path.insert(0, os.path.join(os.environ.get('VTP_ROOT') or os.path.dirname(os.path.abspath(__file__)), 'blender'))  # VTP_ROOT = the VTube Pro folder
    import addons_util as au
    au.enable('vrm', 'sapling', 'antlandscape')     # raises if one can't be enabled; returns {key: module}
    bpy.ops.import_scene.vrm(filepath=...)          # the add-on's operators are now registered

How it finds the add-ons (first hit wins):
  1. the pinned copies vendored in tools/vendor/blender_addons/ (git-ignored; manifest.json lists version, licence,
     source URL, sha256). Extensions are unpacked to tools/vendor/blender_addons/_repo/ and registered as a
     *session-only* local extension repo "vtp_vendor" (module names bl_ext.vtp_vendor.<id>); legacy add-ons
     (TexTools, Building Tools) are unpacked to _legacy/ and put on sys.path. Nothing is written to any Blender
     preferences, so this is safe with --factory-startup and with private BLENDER_USER_* dirs (see
     human_creator/mpfb_env.py).
  2. the same add-on installed in the running Blender's own profile (bl_ext.user_default.<id> / blender_org / legacy).
  3. built-in core add-ons shipped with Blender (node_wrangler, rigify, io_scene_gltf2, ...).

Command line:
  tools\\blender_low.cmd -b --factory-startup --python blender\\addons_util.py -- --check
      enable every add-on in the table and print one line per add-on + "VTP_OK {...}".
  blender.exe -b --python blender\\addons_util.py -- --install-user [keys...]
      (NO --factory-startup) install the vendored zips into the *current user's* Blender profile, enable them and save
      the user's preferences. This is what the user's own Blender window sees after a restart.

Instant Meshes (standalone field-aligned quad remesher, BSD-3) lives at tools/vendor/instant_meshes/ and is wrapped by
`instant_meshes(obj, faces=...)` below (exports OBJ, runs the exe in batch mode, imports the result).

Licences: every add-on here is GPL / MIT / BSD. They are TOOLS: they run inside Blender while we build; none of their
code is copied into VTube Pro or shipped with it. Our own scripts only call their operators / services.
"""
import hashlib
import importlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..'))
VENDOR = os.path.join(ROOT, 'tools', 'vendor', 'blender_addons')
REPO_DIR = os.path.join(VENDOR, '_repo')
LEGACY_DIR = os.path.join(VENDOR, '_legacy')
REPO_MODULE = 'vtp_vendor'
IM_EXE = os.path.join(ROOT, 'tools', 'vendor', 'instant_meshes', 'Instant Meshes.exe')

# key -> (extension id or None, legacy / core module name or None, one-line purpose)
ADDONS = {
    'vrm':             ('vrm', None, 'VRM 0.x/1.0 import/export, humanoid bones, spring bones, expressions, MToon'),
    'textools':        (None, 'TexTools', 'UV tools, texel density, bake of ID/AO/curvature/etc. maps'),
    'sapling':         ('sapling_tree_gen', None, 'parametric trees (curve.tree_add)'),
    'antlandscape':    ('antlandscape', None, 'noise terrain / displace (mesh.landscape_add)'),
    'building_tools':  (None, 'building_tools', 'procedural buildings: floorplan, floors, windows, doors, roofs'),
    'looptools':       ('looptools', None, 'relax / circle / space / bridge / flatten edge loops'),
    'extra_mesh':      ('extra_mesh_objects', None, 'extra primitives: gears, pipes, stairs, round cube, ...'),
    'extra_curve':     ('extra_curve_objectes', None, 'extra curves: spirals, torus knots, profiles, braids'),
    'print3d':         ('print3d_toolbox', None, 'mesh checks: non-manifold, intersections, thin, overhang'),
    'cell_fracture':   ('cell_fracture', None, 'voronoi shatter of meshes (rubble, debris, broken props)'),
    'magic_uv':        ('magic_uv', None, 'UV copy/paste, pack by island similarity, world-scale UV, align'),
    'ivygen':          ('ivygen', None, 'ivy growth over a mesh from the 3D cursor'),
    'archimesh':       ('archimesh', None, 'parametric rooms, doors, windows, stairs, shelves, kitchen'),
    'skkeeper':        ('shapekey_keeper', None, 'apply modifiers to meshes WITH shape keys (SKkeeper)'),
    'arkit_tools':     ('arkit_blendshape_tools', None, 'the 52 ARKit shape-key names: add / sort / mirror'),
    'expr_retarget':   ('mesh_expression_retargeter', None, 'transfer shape keys between different meshes'),
    'hair_bones':      ('hair_bone_generator', None, 'bone chain along a hair strand (for spring bones)'),
    'lowpoly_trees':   ('generate_tree_plugin', None, 'procedural low-poly trees + pines (treegen.generate)'),
    'mpfb':            ('mpfb', None, 'MakeHuman human generator (headless builds: use human_creator/mpfb_env.py)'),
    'faceit':          (None, 'faceit', 'FACEIT: face landmarks -> face rig -> bake 52 ARKit shape keys (PAID, user-supplied; never ship)'),
    # built into Blender (no download)
    'node_wrangler':   (None, 'node_wrangler', 'node editor helpers (core add-on)'),
    'rigify':          (None, 'rigify', 'meta-rig -> control rig generator (core add-on)'),
    'gltf':            (None, 'io_scene_gltf2', 'glTF 2.0 import/export (core, enabled by default)'),
}
ALIASES = {
    'sapling_tree_gen': 'sapling', 'ant': 'antlandscape', 'ant_landscape': 'antlandscape', 'btools': 'building_tools',
    'extra_mesh_objects': 'extra_mesh', 'extra_curve_objects': 'extra_curve', 'print3d_toolbox': 'print3d',
    'shapekey_keeper': 'skkeeper', 'arkit_blendshape_tools': 'arkit_tools',
    'mesh_expression_retargeter': 'expr_retarget', 'hair_bone_generator': 'hair_bones',
    'generate_tree_plugin': 'lowpoly_trees', 'io_scene_gltf2': 'gltf', 'TexTools': 'textools',
}

_enabled = {}


def _manifest():
    p = os.path.join(VENDOR, 'manifest.json')
    if not os.path.isfile(p):
        return {}
    with open(p, encoding='utf-8') as f:
        return {a['key']: a for a in json.load(f)['addons']}


def _unpack(zip_path, dest, strip_top=False):
    """Unpack a zip once (stamp = sha256 of the zip)."""
    digest = hashlib.sha256(open(zip_path, 'rb').read()).hexdigest()
    stamp = os.path.join(dest, '.vtp_stamp')
    if os.path.isfile(stamp) and open(stamp).read().strip() == digest:
        return dest
    os.makedirs(dest, exist_ok=True)
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            name = info.filename
            if strip_top:
                name = name.split('/', 1)[1] if '/' in name else ''
            if not name or info.is_dir():
                continue
            out = os.path.normpath(os.path.join(dest, name))
            if not out.startswith(os.path.normpath(dest)):
                continue  # zip-slip guard
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with open(out, 'wb') as f:
                f.write(z.read(info))
    with open(stamp, 'w') as f:
        f.write(digest)
    return dest


def _ensure_vendor_repo():
    """Register tools/vendor/blender_addons/_repo as a session-only local extension repo."""
    import bpy
    repos = bpy.context.preferences.extensions.repos
    for r in repos:
        if r.module == REPO_MODULE:
            return True
    os.makedirs(REPO_DIR, exist_ok=True)
    repos.new(name='VTube Pro vendored', module=REPO_MODULE, custom_directory=REPO_DIR, source='USER')
    return any(r.module == REPO_MODULE for r in repos)


def _vendored_candidate(key):
    ext_id, legacy, _ = ADDONS[key]
    man = _manifest()
    m = man.get(ext_id) if ext_id else man.get(key)
    if m is None:
        return None
    zp = os.path.join(VENDOR, m['file'])
    if not os.path.isfile(zp):
        return None
    if m['kind'] == 'extension':
        _unpack(zp, os.path.join(REPO_DIR, ext_id))
        if not _ensure_vendor_repo():
            return None
        return 'bl_ext.%s.%s' % (REPO_MODULE, ext_id)
    _unpack(zp, LEGACY_DIR)
    if LEGACY_DIR not in sys.path:
        sys.path.append(LEGACY_DIR)
    return legacy


def candidates(key):
    key = ALIASES.get(key, key)
    if key not in ADDONS:
        raise KeyError('unknown add-on %r (known: %s)' % (key, ', '.join(sorted(ADDONS))))
    ext_id, legacy, _ = ADDONS[key]
    out = []
    try:
        v = _vendored_candidate(key)
        if v:
            out.append(v)
    except Exception as ex:  # vendored copy missing / broken: fall back to the profile
        print('[addons_util] vendored %s unavailable: %s' % (key, ex))
    if ext_id:
        out += ['bl_ext.user_default.' + ext_id, 'bl_ext.blender_org.' + ext_id]
    if legacy and legacy not in out:
        out.append(legacy)
    return out


def _is_loaded(module_name):
    import addon_utils
    try:
        return addon_utils.check(module_name)[1]
    except Exception:
        return False


def enable(*keys, strict=True):
    """Enable add-ons by key (see ADDONS). Returns {key: module_name}. Raises RuntimeError if strict and one fails."""
    import addon_utils
    result, errors = {}, {}
    for key in keys:
        k = ALIASES.get(key, key)
        if k in _enabled and _is_loaded(_enabled[k]):
            result[k] = _enabled[k]
            continue
        errs = []
        for mod_name in candidates(k):
            if mod_name.startswith('bl_ext.'):
                pkg = mod_name.rsplit('.', 1)[0]
                try:
                    importlib.import_module(pkg)
                except Exception:
                    errs.append('%s: repo not present' % mod_name)
                    continue
            else:
                try:
                    if importlib.util.find_spec(mod_name) is None:
                        errs.append('%s: not found' % mod_name)
                        continue
                except Exception as ex:
                    errs.append('%s: %s' % (mod_name, ex))
                    continue
            err = []
            # default_set=True adds the add-on to preferences.addons FOR THIS SESSION ONLY (several add-ons, e.g.
            # VRM / Magic UV / Rigify, read their AddonPreferences and fail without it). Background Blender never
            # auto-saves preferences, so nothing reaches userpref.blend unless a script calls wm.save_userpref.
            mod = addon_utils.enable(mod_name, default_set=True, persistent=True,
                                     handle_error=lambda ex: err.append(repr(ex)))
            if mod is not None and not err:
                result[k] = _enabled[k] = mod_name
                break
            errs.append('%s: %s' % (mod_name, '; '.join(err) or 'enable returned None'))
        else:
            errors[k] = errs
    if errors and strict:
        raise RuntimeError('could not enable add-ons: ' + json.dumps(errors, indent=1))
    return result


def module(key):
    """The imported Python module of an enabled add-on (e.g. to call MPFB services)."""
    k = ALIASES.get(key, key)
    name = _enabled.get(k) or enable(k)[k]
    return importlib.import_module(name)


def uv_editor_context():
    """Context override that satisfies operators whose poll() wants a UV editor (TexTools, some Magic UV ops) even in
    background mode, where there is no window: borrows the IMAGE_EDITOR area of the factory 'UV Editing' screen.
        with au.uv_editor_context():
            bpy.ops.uv.textools_texel_density_get()
    Put the mesh in EDIT mode with faces selected first."""
    import bpy
    scr = bpy.data.screens.get('UV Editing')
    area = next((a for a in scr.areas if a.type == 'IMAGE_EDITOR'), None) if scr else None
    if area is None:
        for scr in bpy.data.screens:
            area = next((a for a in scr.areas if a.type == 'IMAGE_EDITOR'), None)
            if area:
                break
    if area is None:
        raise RuntimeError('no IMAGE_EDITOR area in this file (load the factory startup file)')
    area.ui_type = 'UV'
    region = next(r for r in area.regions if r.type == 'WINDOW')
    return bpy.context.temp_override(screen=scr, area=area, region=region)


# ------------------------------------------------------------------------------------------------ Instant Meshes

def run_instant_meshes(src, dst, faces=None, vertices=None, scale=None, crease=None, rosy=4, posy=4,
                       smooth=2, dominant=False, boundaries=True, deterministic=True, threads=None, timeout=600):
    """Batch-run Instant Meshes on an OBJ/PLY file. rosy=4, posy=4 -> quads; rosy=6, posy=6 -> triangles."""
    if not os.path.isfile(IM_EXE):
        raise FileNotFoundError('Instant Meshes not found at %s (see docs/BLENDER_ADDONS.md)' % IM_EXE)
    cmd = [IM_EXE, src, '-o', dst, '-r', str(rosy), '-p', str(posy), '-S', str(smooth)]
    if faces:
        # Instant Meshes' -f sizes the quad-DOMINANT mesh; pure-quad output (no -D) splits every face into 4,
        # so ask for a quarter to land near the requested count (checked: -f 600 pure quads -> 2482 faces).
        cmd += ['-f', str(max(8, int(faces if dominant else faces / 4)))]
    if vertices:
        cmd += ['-v', str(int(vertices))]
    if scale:
        cmd += ['-s', str(scale)]
    if crease is not None:
        cmd += ['-c', str(crease)]
    if dominant:
        cmd.append('-D')
    if boundaries:
        cmd.append('-b')
    if deterministic:
        cmd.append('-d')
    if threads:
        cmd += ['-t', str(int(threads))]
    flags = 0x00004000 if os.name == 'nt' else 0  # BELOW_NORMAL_PRIORITY_CLASS: never starve live tracking
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, creationflags=flags)
    if r.returncode != 0 or not os.path.isfile(dst):
        raise RuntimeError('Instant Meshes failed (%s): %s' % (r.returncode, (r.stdout + r.stderr)[-2000:]))
    return dst


def instant_meshes(obj, faces=5000, keep_original=True, **kw):
    """Quad-remesh a Blender mesh object with Instant Meshes; returns the new object (named <obj>_im).
    Loses UVs / shape keys / weights (it is a retopology): re-project or transfer them afterwards
    (Data Transfer modifier, or bpy.ops.object.data_transfer)."""
    import bpy
    tmp = tempfile.mkdtemp(prefix='vtp_im_')
    src, dst = os.path.join(tmp, 'in.obj'), os.path.join(tmp, 'out.obj')
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.wm.obj_export(filepath=src, export_selected_objects=True, apply_modifiers=True,
                          export_uv=False, export_normals=False, export_materials=False,
                          forward_axis='Y', up_axis='Z')
    try:
        run_instant_meshes(src, dst, faces=faces, **kw)
        before = set(bpy.data.objects)
        bpy.ops.wm.obj_import(filepath=dst, forward_axis='Y', up_axis='Z')
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    new = [o for o in bpy.data.objects if o not in before]
    if not new:
        raise RuntimeError('Instant Meshes output could not be imported')
    out = new[0]
    out.name = obj.name + '_im'
    out.matrix_world = obj.matrix_world.copy()
    if not keep_original:
        bpy.data.objects.remove(obj, do_unlink=True)
    return out


# ------------------------------------------------------------------------------------------------ command line

def _cli_check(keys):
    rows, ok = [], True
    for k in keys or list(ADDONS):
        try:
            m = enable(k)[ALIASES.get(k, k)]
            rows.append({'key': k, 'ok': True, 'module': m})
        except Exception as ex:
            ok = False
            rows.append({'key': k, 'ok': False, 'error': str(ex)[:400]})
    for r in rows:
        print('ADDON %-15s %s %s' % (r['key'], 'OK  ' if r['ok'] else 'FAIL', r.get('module') or r.get('error')))
    print('VTP_OK ' + json.dumps({'all_ok': ok, 'rows': rows}) if ok else 'VTP_FAIL ' + json.dumps(rows))


def _cli_install_user(keys):
    """Install vendored zips into the running Blender's user profile and enable them (saves user preferences)."""
    import bpy
    import addon_utils
    if bpy.app.factory_startup:
        raise SystemExit('--install-user must run WITHOUT --factory-startup (it writes the user profile)')
    man = _manifest()
    report = []
    for key, a in man.items():
        k = ALIASES.get(key, key)
        if keys and k not in keys and key not in keys:
            continue
        zp = os.path.join(VENDOR, a['file'])
        try:
            if a['kind'] == 'extension':
                bpy.ops.extensions.package_install_files(filepath=zp, repo='user_default', enable_on_install=True,
                                                         overwrite=True)
                name = 'bl_ext.user_default.' + key
            else:
                bpy.ops.preferences.addon_install(filepath=zp, overwrite=True)
                addon_utils.modules_refresh()
                name = a['module']
                addon_utils.enable(name, default_set=True, persistent=True)
            loaded = addon_utils.check(name)[1]
            report.append((key, a['version'], 'enabled' if loaded else 'INSTALLED BUT NOT ENABLED'))
        except Exception as ex:
            report.append((key, a['version'], 'FAILED: %s' % ex))
    ok = 'FINISHED' in bpy.ops.wm.save_userpref()
    for r in report:
        print('INSTALL %-28s %-22s %s' % r)
    print(('VTP_OK ' if ok else 'VTP_FAIL ') + json.dumps({'prefs_saved': ok, 'report': report}))


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    rest = [a for a in argv if not a.startswith('--')]
    if '--install-user' in argv:
        _cli_install_user(rest)
    else:
        _cli_check(rest)
