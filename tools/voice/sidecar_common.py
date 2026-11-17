"""Shared bits of the local voice sidecars (whisper_sidecar.py = live captions, kokoro_sidecar.py = alert voice).

Both sidecars are small localhost websocket servers the VTube Pro server starts on demand (server/captions/manager.ts,
server/kokoro.ts). They bind 127.0.0.1 only, refuse any browser Origin that is not this PC, die with the server that
started them, and never touch the network (HF_HUB_OFFLINE is set before anything imports huggingface_hub).
"""
from __future__ import annotations

import io
import os
import struct
import sys
import time
import wave
from http import HTTPStatus

for _s in (sys.stdout, sys.stderr):      # phonemes in a log line must not crash a cp1252 console
    try:
        _s.reconfigure(encoding='utf-8', errors='replace')
    except Exception:  # noqa: BLE001
        pass

# nothing in a sidecar may reach the internet: models are installed by tools/voice/voice_setup.ts and verified there
os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')


def pid_alive(pid: int) -> bool:
    if os.name == 'nt':
        import ctypes
        k = ctypes.windll.kernel32
        h = k.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = ctypes.c_ulong()
        ok = k.GetExitCodeProcess(h, ctypes.byref(code))
        k.CloseHandle(h)
        return bool(ok) and code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def watch_parent(pid: int) -> None:
    """Die with the server that started us (a hard-killed dev server would otherwise leave us running)."""
    if pid <= 0:
        return
    import threading

    def run():
        while True:
            time.sleep(2)
            if not pid_alive(pid):
                os._exit(0)
    threading.Thread(target=run, daemon=True).start()


LOOPBACK_ORIGINS = ('http://localhost', 'http://127.0.0.1', 'http://[::1]', 'https://localhost', 'https://127.0.0.1')


def origin_ok(origin: str | None) -> bool:
    """No Origin = a program (the VTube Pro server). A browser page must be on this PC, not a website."""
    if not origin:
        return True
    return any(origin == o or origin.startswith(o + ':') for o in LOOPBACK_ORIGINS)


def guard(path: str):
    """websockets `process_request` that only lets `path` in, from a loopback page or a program."""
    def check(connection, request):
        if request.path.split('?')[0] != path:
            return connection.respond(HTTPStatus.NOT_FOUND, 'not found\n')
        if not origin_ok(request.headers.get('Origin')):
            return connection.respond(HTTPStatus.FORBIDDEN, 'this page may not use the local voice service\n')
        return None
    return check


def wav_bytes(samples, sample_rate: int) -> bytes:
    """float32 mono in [-1, 1] -> a 16-bit PCM WAV (RIFF) as bytes. `samples` is any numpy-like float array."""
    import numpy as np
    x = np.asarray(samples, dtype=np.float32).reshape(-1)
    x = np.clip(x, -1.0, 1.0)
    pcm = (x * 32767.0).astype('<i2')
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sample_rate))
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def split_request(data: bytes) -> tuple[dict, bytes]:
    """[uint32 LE header length][header JSON utf-8][payload]"""
    import json
    if len(data) < 4:
        raise ValueError('short message')
    (n,) = struct.unpack_from('<I', data, 0)
    if n > 1 << 20 or 4 + n > len(data):
        raise ValueError('bad header length')
    return json.loads(data[4:4 + n].decode('utf-8')), data[4 + n:]


def log(*a) -> None:
    print(*a, flush=True, file=sys.stdout)
