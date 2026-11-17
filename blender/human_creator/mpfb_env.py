"""
MPFB (MakeHuman Plugin For Blender, GPL-3) as a private BUILD TOOL: the add-on + the CC0 MakeHuman system assets
live under tools/vendor/mpfb/blender_user/ (git-ignored) and are loaded by a Blender that runs with private user
dirs, so the user's normal Blender setup is never touched:

    BLENDER_USER_RESOURCES / CONFIG / SCRIPTS / EXTENSIONS -> tools/vendor/mpfb/blender_user/...
    add-on          : blender_user/extensions/user_default/mpfb            (extension "bl_ext.user_default.mpfb")
    MPFB user data  : blender_user/extensions/.user/user_default/mpfb/data (clothes, hair, skins, eyes, ...)

`ensure_private_env()` re-launches the current Blender with those env vars when they are not set (so callers such
as server/blender.ts can run `blender -b --factory-startup --python build.py -- ...` without knowing about MPFB).
None of MPFB's code is copied into VTube Pro; we only call its services from Blender to generate GLBs.
"""
import importlib
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
VENDOR = os.path.join(ROOT, 'tools', 'vendor', 'mpfb')
BU = os.path.join(VENDOR, 'blender_user')
ENV = {
    'BLENDER_USER_RESOURCES': os.path.join(BU, 'resources'),
    'BLENDER_USER_CONFIG': os.path.join(BU, 'config'),
    'BLENDER_USER_SCRIPTS': os.path.join(BU, 'scripts'),
    'BLENDER_USER_EXTENSIONS': os.path.join(BU, 'extensions'),
}
ADDON = 'bl_ext.user_default.mpfb'
ADDON_DIR = os.path.join(BU, 'extensions', 'user_default', 'mpfb')
DATA_DIR = os.path.join(BU, 'extensions', '.user', 'user_default', 'mpfb', 'data')


def installed():
    return os.path.isfile(os.path.join(ADDON_DIR, '__init__.py')) and os.path.isdir(os.path.join(DATA_DIR, 'skins'))


def env_ok():
    return all(os.path.normcase(os.path.normpath(os.environ.get(k, ''))) == os.path.normcase(os.path.normpath(v))
               for k, v in ENV.items())


def ensure_private_env():
    """Re-exec this Blender run inside the private MPFB user dirs if needed. Returns only in the right env."""
    if not installed():
        raise RuntimeError('MPFB is not installed. Unpack mpfb2-*-src.zip (src/mpfb) to %s and the MakeHuman system '
                           'assets zip to %s (see blender/human_creator/README.md).' % (ADDON_DIR, DATA_DIR))
    if env_ok():
        return
    import bpy
    for v in ENV.values():
        os.makedirs(v, exist_ok=True)
    env = dict(os.environ)
    env.update(ENV)
    argv = [bpy.app.binary_path] + sys.argv[1:]
    if '--factory-startup' not in argv:
        argv.insert(1, '--factory-startup')
    print('[human_creator] re-launching Blender with private MPFB user dirs', flush=True)
    r = subprocess.run(argv, env=env)
    sys.stdout.flush()
    os._exit(r.returncode)


_S = {}


def enable():
    """Enable MPFB and return a namespace of its services."""
    if _S:
        return _S['ns']
    import addon_utils
    addon_utils.enable(ADDON, default_set=True, handle_error=None)

    def svc(mod, name):
        return getattr(importlib.import_module(ADDON + '.services.' + mod), name)

    class NS:
        HumanService = svc('humanservice', 'HumanService')
        AssetService = svc('assetservice', 'AssetService')
        TargetService = svc('targetservice', 'TargetService')
        LocationService = svc('locationservice', 'LocationService')
        ExportService = svc('exportservice', 'ExportService')
        ObjectService = svc('objectservice', 'ObjectService')
        ClothesService = svc('clothesservice', 'ClothesService')
        Mhclo = getattr(importlib.import_module(ADDON + '.entities.clothes.mhclo'), 'Mhclo')
    _S['ns'] = NS
    return NS


def asset(subdir, filename):
    """Absolute path of an MPFB asset (e.g. ('hair', 'bob01.mhclo')) or None."""
    ns = enable()
    return ns.AssetService.find_asset_absolute_path(filename, asset_subdir=subdir)


def target_dir(*parts):
    return enable().LocationService.get_mpfb_data(os.path.join('targets', *parts))
