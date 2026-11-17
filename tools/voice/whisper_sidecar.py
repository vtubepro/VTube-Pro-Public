"""Live-caption recogniser sidecar: faster-whisper (MIT) behind a localhost websocket.

  python tools/voice/whisper_sidecar.py --model-dir <folder> [--port 5200] [--device auto|cpu|cuda] [--parent-pid N]
  python tools/voice/whisper_sidecar.py --fake                         (tests: no model, no faster-whisper)

Started by the server (server/captions/manager.ts) when live captions are on. Binds 127.0.0.1 only. It is STATELESS: the
server (server/captions/session.ts) owns the audio window and the stable-prefix policy; this process only turns one
window of audio into words with times. One run at a time (a lock), the rest queue.

Protocol (ws://127.0.0.1:5200/whisper):
  server -> text    {"type":"ready","model":"base.en","device":"cpu","compute":"int8","fallback":"","version":"1.2.1"}
  client -> binary  [uint32 LE header length][header JSON][float32 LE mono 16 kHz samples]
                    header = {"id":7,"lang":"en"|"auto","prompt":"recent caption text"}
  server -> text    {"type":"result","id":7,"words":[{"w":"Hello","t0":0.12,"t1":0.50,"p":0.97}],"ms":312,"audioSec":4.2}
                    {"type":"error","id":7,"error":"..."}
Word times are seconds from the start of the audio sent. A client may send "ping" (text) and gets "pong".

Licence notes: faster-whisper (MIT), CTranslate2 (MIT), the Whisper models (MIT), tokenizers (Apache-2.0). faster-whisper
lists PyAV ("av") as a dependency; PyAV's wheels bundle an FFmpeg built WITH x264 / x265 (GPL), which VTube Pro must not
ship. voice_setup.ts installs faster-whisper with --no-deps (so PyAV is never installed) and this file puts an empty
`av` module in place: faster-whisper only uses PyAV to decode audio FILES, and we pass it arrays.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import importlib.util
import math
import os
import sys
import time
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sidecar_common import guard, log, split_request, watch_parent  # noqa: E402

SR = 16000


def add_cuda_dll_dirs() -> None:
    """The NVIDIA pip wheels (cuBLAS, cuDNN) keep their DLLs under site-packages/nvidia/*/bin; Windows only finds them
    when told. A no-op when they are not installed (the CPU is used)."""
    if os.name != 'nt':
        return
    for base in sys.path:
        nv = os.path.join(base, 'nvidia')
        if os.path.isdir(nv):
            for sub in os.listdir(nv):
                b = os.path.join(nv, sub, 'bin')
                if os.path.isdir(b):
                    try:
                        os.add_dll_directory(b)
                    except OSError:
                        pass
                    os.environ['PATH'] = b + os.pathsep + os.environ.get('PATH', '')


class PyAVError(RuntimeError):
    """A real PyAV is present. Its wheels bundle an FFmpeg built with x264 / x265 (GPL): not allowed in VTube Pro."""


# The one stand-in object. verify_av_stub() checks that THIS is what faster_whisper ended up with.
AV_STUB = types.ModuleType('av')


def is_av_stub(mod) -> bool:
    """True for an empty stand-in. Real PyAV has a file, a version and av.open()."""
    return (mod is not None and getattr(mod, '__file__', None) is None and not hasattr(mod, 'open')
            and not hasattr(mod, '__version__') and not hasattr(mod, 'audio'))


def pyav_installed() -> bool:
    """Is a real PyAV importable (or already loaded)? Looked up WITHOUT importing it."""
    if 'av' in sys.modules:
        return not is_av_stub(sys.modules['av'])
    try:
        return importlib.util.find_spec('av') is not None
    except (ImportError, ValueError):
        return False


def shim_av() -> bool:
    """Put the empty `av` stand-in in place. Returns True (and puts nothing) when a REAL PyAV is installed."""
    if pyav_installed():
        return True
    sys.modules['av'] = AV_STUB
    return False


def verify_av_stub(faster_whisper_module=None) -> None:
    """Runtime proof, after faster_whisper has been imported: `av` is still our stand-in (nothing replaced it with a real
    PyAV), and faster_whisper's own `av` name is it too. Raises PyAVError otherwise."""
    av = sys.modules.get('av')
    if av is not AV_STUB or not is_av_stub(av):
        raise PyAVError('a real PyAV is loaded (its wheels bundle a GPL FFmpeg); uninstall it from the voice environment')
    fw_audio = sys.modules.get('faster_whisper.audio')
    if fw_audio is not None and getattr(fw_audio, 'av', AV_STUB) is not AV_STUB:
        raise PyAVError('faster_whisper holds a real PyAV')


def import_faster_whisper():
    """The only way this process imports faster_whisper: stand-in first, real-PyAV refusal, then proof."""
    if shim_av():
        raise PyAVError('a real PyAV is installed in this environment (its wheels bundle a GPL FFmpeg); uninstall it')
    import faster_whisper
    verify_av_stub(faster_whisper)
    return faster_whisper


def check() -> int:
    """Used by voice_setup.ts after the install: do the packages import, is PyAV really absent, is CUDA visible."""
    out = {'ok': False}
    try:
        add_cuda_dll_dirs()
        out['av'] = 'present' if pyav_installed() else 'absent'
        if out['av'] == 'present':
            raise PyAVError('a real PyAV is installed in this environment (its wheels bundle a GPL FFmpeg); uninstall it')
        import ctranslate2
        faster_whisper = import_faster_whisper()
        out['av_stub_verified'] = True
        out['faster_whisper'] = getattr(faster_whisper, '__version__', '?')
        out['ctranslate2'] = ctranslate2.__version__
        try:
            out['cuda_devices'] = ctranslate2.get_cuda_device_count()
        except Exception as e:  # noqa: BLE001
            out['cuda_devices'] = 0
            out['cuda_error'] = str(e)[:120]
        out['ok'] = out['av'] == 'absent'
    except Exception as e:  # noqa: BLE001
        out['error'] = str(e)[:300]
    print(json.dumps(out), flush=True)
    return 0 if out['ok'] else 1


class FakeModel:
    """Test double: one word per voiced 0.3 s of audio (RMS > 0.02). Deterministic; no model."""
    name = 'fake'
    device = 'cpu'
    compute = 'none'
    fallback = ''
    version = 'fake'

    def transcribe(self, audio, lang: str, prompt: str):
        import numpy as np
        hop = int(0.1 * SR)
        voiced = [float(np.sqrt(np.mean(audio[i:i + hop] ** 2))) > 0.02 for i in range(0, len(audio) - hop + 1, hop)]
        words, i, n = [], 0, 0
        while i < len(voiced):
            if voiced[i]:
                j = i
                while j < len(voiced) and voiced[j] and j - i < 3:
                    j += 1
                words.append({'w': f'w{n}', 't0': round(i * 0.1, 3), 't1': round(j * 0.1, 3)})
                n += 1
                i = j
            else:
                i += 1
        return words


class RealModel:
    def __init__(self, model_dir: str, device: str, compute: str | None, threads: int):
        add_cuda_dll_dirs()
        faster_whisper = import_faster_whisper()   # (PyAV is not installed on purpose, see the module docstring)
        import ctranslate2
        self.version = getattr(faster_whisper, '__version__', '?')
        self.name = os.path.basename(os.path.normpath(model_dir))
        self.fallback = ''
        want = device
        if want == 'auto':
            try:
                want = 'cuda' if ctranslate2.get_cuda_device_count() > 0 else 'cpu'
            except Exception:
                want = 'cpu'
        tries = []
        if want == 'cuda':
            tries.append(('cuda', compute or 'float16'))
        tries.append(('cpu', compute if (compute and want == 'cpu') else 'int8'))
        last = None
        for dev, comp in tries:
            try:
                self.model = faster_whisper.WhisperModel(model_dir, device=dev, compute_type=comp, cpu_threads=threads, num_workers=1, local_files_only=True)
                self.device, self.compute = dev, comp
                break
            except Exception as e:  # noqa: BLE001  (CUDA libraries missing, out of memory, ...)
                last = e
                if dev == 'cuda':
                    self.fallback = f'GPU not usable ({str(e)[:120]}); using the CPU'
        else:
            raise RuntimeError(f'could not load the model: {last}')
        # warm-up: the first run pays for allocations
        import numpy as np
        self.transcribe(np.zeros(SR, np.float32), 'en', '')

    def transcribe(self, audio, lang: str, prompt: str):
        segments, _info = self.model.transcribe(
            audio, language=None if lang in ('', 'auto') else lang, beam_size=1, best_of=1, temperature=0.0,
            condition_on_previous_text=False, initial_prompt=prompt or None, word_timestamps=True, vad_filter=False,
            no_speech_threshold=0.6, log_prob_threshold=-1.0, compression_ratio_threshold=2.4, suppress_blank=True)
        words = []
        for seg in segments:
            # a segment the model itself thinks is not speech (Whisper's habit of "Thank you." on silence)
            if getattr(seg, 'no_speech_prob', 0) > 0.6 and getattr(seg, 'avg_logprob', 0) < -1.0:
                continue
            for w in (seg.words or []):
                t = (w.word or '').strip()
                if t and math.isfinite(w.start) and math.isfinite(w.end):
                    word = {'w': t, 't0': round(float(w.start), 3), 't1': round(max(float(w.end), float(w.start)), 3)}
                    pr = getattr(w, 'probability', None)
                    if isinstance(pr, (int, float)) and math.isfinite(pr):
                        word['p'] = round(min(1.0, max(0.0, float(pr))), 3)      # the model's own confidence (slow machines commit sure words one run early)
                    words.append(word)
        return words


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=int(os.environ.get('VTP_WHISPER_PORT', 5200)))
    ap.add_argument('--model-dir', default=os.environ.get('VTP_WHISPER_MODEL', ''))
    ap.add_argument('--device', default=os.environ.get('VTP_WHISPER_DEVICE', 'auto'))
    ap.add_argument('--compute', default=os.environ.get('VTP_WHISPER_COMPUTE', ''))
    ap.add_argument('--threads', type=int, default=0, help='CPU threads (default: half the cores, 2..8)')
    ap.add_argument('--parent-pid', type=int, default=0, help='exit when this process (the server) is gone')
    ap.add_argument('--fake', action='store_true', help='tests: no model')
    ap.add_argument('--check', action='store_true', help='import the packages and report (setup)')
    a = ap.parse_args()
    if a.check:
        sys.exit(check())
    watch_parent(a.parent_pid)
    import websockets
    from websockets.asyncio.server import serve

    t0 = time.perf_counter()
    if a.fake:
        model = FakeModel()
    else:
        if not a.model_dir or not os.path.isfile(os.path.join(a.model_dir, 'model.bin')):
            log(f'[whisper] no model at {a.model_dir!r} (install it from the captions card)')
            sys.exit(2)
        threads = a.threads or max(2, min(8, (os.cpu_count() or 4) // 2))
        try:
            model = RealModel(a.model_dir, a.device, a.compute or None, threads)
        except PyAVError as e:
            log(f'[whisper] refusing to start: {e}')
            sys.exit(3)
    lock = asyncio.Lock()
    loop = asyncio.get_running_loop()

    async def handler(ws):
        await ws.send(json.dumps({'type': 'ready', 'model': model.name, 'device': model.device, 'compute': model.compute, 'fallback': model.fallback, 'version': model.version}))
        async for msg in ws:
            if isinstance(msg, str):
                if msg == 'ping':
                    await ws.send('pong')
                continue
            rid = -1
            try:
                head, payload = split_request(msg)
                rid = int(head.get('id', -1))
                if len(payload) % 4:
                    raise ValueError('audio is not float32')
                import numpy as np
                audio = np.frombuffer(payload, dtype='<f4').astype(np.float32, copy=False)
                if len(audio) > 40 * SR:
                    raise ValueError('window longer than 40 s')
                async with lock:
                    t = time.perf_counter()
                    words = await loop.run_in_executor(None, model.transcribe, audio, str(head.get('lang', 'en')), str(head.get('prompt', ''))[:400])
                    ms = (time.perf_counter() - t) * 1000
                await ws.send(json.dumps({'type': 'result', 'id': rid, 'words': words, 'ms': round(ms, 1), 'audioSec': round(len(audio) / SR, 3)}))
            except Exception as e:  # noqa: BLE001
                await ws.send(json.dumps({'type': 'error', 'id': rid, 'error': str(e)[:200]}))

    async with serve(handler, '127.0.0.1', a.port, max_size=1 << 25, process_request=guard('/whisper'), ping_interval=None):
        log(f'[whisper] ready ({model.name} on {model.device}/{model.compute}) in {time.perf_counter() - t0:.1f}s, ws://127.0.0.1:{a.port}/whisper')
        await asyncio.get_running_loop().create_future()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
