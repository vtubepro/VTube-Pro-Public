"""Runtime proof that the caption sidecar never runs with a real PyAV (whose wheels bundle a GPL FFmpeg), without installing
faster-whisper or PyAV: tiny fake packages stand in for them in a temp folder and whisper_sidecar.py is run for real against
them (`--check`, and a real start). Run by tools/voice_sidecars_unit.ts, or directly: python tools/voice/test_av_guard.py"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
HERE = os.path.dirname(os.path.abspath(__file__))
SIDECAR = os.path.join(HERE, 'whisper_sidecar.py')
fails = 0
# a PyAV on THIS machine's Python would make the "clean environment" cases meaningless (the guard would rightly refuse it)
HOST_PYAV = importlib.util.find_spec('av') is not None


def ok(name, cond, extra=''):
    global fails
    print(('PASS  ' if cond else 'FAIL  ') + name + (f'  ({extra})' if extra and not cond else ''))
    if not cond:
        fails += 1


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, 'w', encoding='utf-8').write(text)


def fake_faster_whisper(root, extra_init=''):
    # like the real one: `import av` at import time (audio.py), a version, a WhisperModel
    write(os.path.join(root, 'faster_whisper', '__init__.py'), "import av\n__version__ = '9.9.9'\nfrom . import audio\n" + extra_init + "\nclass WhisperModel:\n    def __init__(self, *a, **k):\n        raise RuntimeError('fake model')\n")
    write(os.path.join(root, 'faster_whisper', 'audio.py'), 'import av\n')
    write(os.path.join(root, 'ctranslate2.py'), "__version__ = '4.0.0'\ndef get_cuda_device_count():\n    return 0\n")


def real_pyav(root):
    write(os.path.join(root, 'av', '__init__.py'), "__version__ = '99'\ndef open(*a, **k):\n    raise RuntimeError('real PyAV')\n")


def run(args, *paths, cwd=None):
    env = dict(os.environ)
    env['PYTHONPATH'] = os.pathsep.join(paths)
    return subprocess.run([sys.executable, SIDECAR, *args], capture_output=True, text=True, env=env, cwd=cwd or tempfile.gettempdir(), timeout=60)


def check_json(r):
    for line in r.stdout.splitlines():
        if line.startswith('{'):
            return json.loads(line)
    return {}


with tempfile.TemporaryDirectory() as tmp:
    good = os.path.join(tmp, 'good'); fake_faster_whisper(good)
    r = run(['--check'], good)
    j = check_json(r)
    if HOST_PYAV:
        print('SKIP  this Python has a real PyAV installed: the clean-environment cases need one without')
    else:
      ok('clean environment: --check passes, av is absent, the stand-in was verified after the import', r.returncode == 0 and j.get('ok') is True and j.get('av') == 'absent' and j.get('av_stub_verified') is True and j.get('faster_whisper') == '9.9.9', r.stdout + r.stderr)

    pyav = os.path.join(tmp, 'pyav'); real_pyav(pyav)
    r = run(['--check'], good, pyav)
    j = check_json(r)
    ok('a real PyAV in the environment: --check fails and says so', r.returncode == 1 and j.get('ok') is False and j.get('av') == 'present' and 'GPL' in j.get('error', ''), r.stdout + r.stderr)

    # the model folder only has to exist for the real start path
    model = os.path.join(tmp, 'model'); write(os.path.join(model, 'model.bin'), 'x')
    r = run(['--model-dir', model, '--port', '5299'], good, pyav)
    ok('a real PyAV in the environment: the sidecar refuses to start (exit 3, with the reason)', r.returncode == 3 and 'refusing to start' in r.stdout and 'GPL' in r.stdout, f'{r.returncode} {r.stdout} {r.stderr[-200:]}')

    # something swaps a real-looking `av` in while faster_whisper imports: caught by the post-import proof
    swapped = os.path.join(tmp, 'swapped')
    fake_faster_whisper(swapped, extra_init="import sys, types\n_m = types.ModuleType('av'); _m.open = lambda *a: None; sys.modules['av'] = _m\n")
    r = run(['--check'], swapped)
    j = check_json(r)
    ok('av replaced by something real during the import: caught by the runtime proof', r.returncode == 1 and j.get('ok') is False and 'real PyAV is loaded' in j.get('error', ''), r.stdout + r.stderr)

    # a real model start with the stand-in verified gets as far as the (fake) model load, i.e. PAST the guard
    r = run(['--model-dir', model, '--port', '5298'], good)
    if not HOST_PYAV:
      ok('clean environment: the start gets past the guard (it only stops at the fake model)', r.returncode not in (0, 3) and 'refusing to start' not in r.stdout, f'{r.returncode} {r.stdout}{r.stderr[-300:]}')

sys.exit(1 if fails else 0)
