"""Alert-voice sidecar: Kokoro-82M (Apache-2.0 weights) on onnxruntime, behind a localhost websocket. It only ever
produces WAV bytes; it never plays anything.

  python tools/voice/kokoro_sidecar.py --model-dir <folder> [--port 5201] [--parent-pid N]
  python tools/voice/kokoro_sidecar.py --fake --data-dir <folder with us_gold.json + us_silver.json>   (tests: no model)

<folder> = what voice_setup.ts installs: onnx/model_quantized.onnx, tokenizer.json, voices/<name>.bin, misaki/us_gold.json,
misaki/us_silver.json. Started on demand by the server (server/kokoro.ts); binds 127.0.0.1 only.

Protocol (ws://127.0.0.1:5201/kokoro), one request at a time per connection:
  server -> text    {"type":"ready","voices":["af_heart",...],"sampleRate":24000,"fake":false}
  client -> text    {"type":"say","id":3,"text":"Thanks for the follow, Marigold!","voice":"af_heart","speed":1.0}
  server -> text    {"type":"audio","id":3,"sampleRate":24000,"seconds":2.1,"ms":640,"spelled":["Marigold"],"skipped":["田中"]}
  server -> binary  the WAV (RIFF, mono, 16-bit, 24 kHz) of that request
                    {"type":"error","id":3,"error":"..."}   a line with nothing speakable: {"type":"error","id":3,"code":"unspeakable",...}
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kokoro_g2p import G2P, chunk  # noqa: E402
from sidecar_common import guard, log, wav_bytes, watch_parent  # noqa: E402

SR = 24000
MAX_TEXT = 600
CONTEXT = 510          # Kokoro's token context (pad ids 0 at both ends are added on top)


class Unspeakable(ValueError):
    """The line has nothing this voice can say (only emoji, Han / Hangul words, symbols ...): skip the LINE, it is not a failure."""


class FakeSession:
    """Test double: a tone whose length follows the token count. No model."""
    def run(self, ids, style, speed):
        import numpy as np
        n = int(SR * 0.04 * max(1, len(ids)) / max(0.1, float(speed)))
        t = np.arange(n, dtype=np.float32) / SR
        return (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


class OnnxSession:
    def __init__(self, path: str, threads: int):
        import onnxruntime as ort
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.log_severity_level = 3
        self.s = ort.InferenceSession(path, so, providers=['CPUExecutionProvider'])

    def run(self, ids, style, speed):
        import numpy as np
        out = self.s.run(None, {
            'input_ids': np.asarray([[0, *ids, 0]], dtype=np.int64),
            'style': style.astype(np.float32).reshape(1, 256),
            'speed': np.asarray([speed], dtype=np.float32),
        })[0]
        return np.asarray(out, dtype=np.float32).reshape(-1)


class Kokoro:
    def __init__(self, model_dir: str, data_dir: str, fake: bool, threads: int):
        self.model_dir = model_dir
        tok = os.path.join(model_dir, 'tokenizer.json')
        if os.path.isfile(tok):
            self.vocab = json.load(open(tok, encoding='utf-8'))['model']['vocab']
        else:
            self.vocab = {c: i for i, c in enumerate(' ;:,.!?—…"()“”ˈˌabcdefhijklmnopqrstuvwxyzAIOWYðŋɑɔəɛɜɡɪɹɾʃʊʌʒʤʧθæᵊᵻ', 1)}
        d = data_dir or os.path.join(model_dir, 'misaki')
        gold = json.load(open(os.path.join(d, 'us_gold.json'), encoding='utf-8'))
        silver = json.load(open(os.path.join(d, 'us_silver.json'), encoding='utf-8'))
        self.g2p = G2P(gold, silver, set(self.vocab))
        self.fake = fake
        self.session = FakeSession() if fake else OnnxSession(os.path.join(model_dir, 'onnx', 'model_quantized.onnx'), threads)
        self._voices: dict[str, object] = {}

    def voices(self) -> list[str]:
        d = os.path.join(self.model_dir, 'voices')
        if not os.path.isdir(d):
            return ['fake'] if self.fake else []
        return sorted(f[:-4] for f in os.listdir(d) if f.endswith('.bin'))

    def style_table(self, name: str):
        import numpy as np
        if not name.replace('_', '').isalnum():
            raise ValueError('bad voice name')
        if name not in self._voices:
            p = os.path.join(self.model_dir, 'voices', name + '.bin')
            if self.fake and not os.path.isfile(p):
                self._voices[name] = np.zeros((CONTEXT, 1, 256), np.float32)
            else:
                if not os.path.isfile(p):
                    raise ValueError(f'unknown voice {name!r}')
                self._voices[name] = np.fromfile(p, dtype='<f4').reshape(-1, 1, 256)
        return self._voices[name]

    def say(self, text: str, voice: str, speed: float):
        import numpy as np
        text = text.strip()[:MAX_TEXT]
        if not text:
            raise ValueError('nothing to say')
        speed = min(1.6, max(0.6, float(speed)))
        ph, unknown, skipped = self.g2p.speak(text)
        pieces = chunk(ph)
        if not pieces:
            raise Unspeakable('nothing the voice can say')
        table = self.style_table(voice)
        out = []
        gap = np.zeros(int(SR * 0.12), np.float32)
        for i, piece in enumerate(pieces):
            ids = [self.vocab[c] for c in piece if c in self.vocab][:CONTEXT - 2]
            style = table[min(len(ids), len(table) - 1)]
            out.append(self.session.run(ids, style, speed))
            if i + 1 < len(pieces):
                out.append(gap)
        return np.concatenate(out), unknown, skipped


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=int(os.environ.get('VTP_KOKORO_PORT', 5201)))
    ap.add_argument('--model-dir', default=os.environ.get('VTP_KOKORO_MODEL', ''))
    ap.add_argument('--data-dir', default='', help='folder with us_gold.json / us_silver.json (default: <model-dir>/misaki)')
    ap.add_argument('--threads', type=int, default=0)
    ap.add_argument('--parent-pid', type=int, default=0)
    ap.add_argument('--fake', action='store_true', help='tests: no model')
    ap.add_argument('--check', action='store_true', help='import the packages and report (setup)')
    a = ap.parse_args()
    if a.check:
        out = {'ok': False}
        try:
            import numpy
            import onnxruntime
            import websockets
            out.update(ok=True, onnxruntime=onnxruntime.__version__, numpy=numpy.__version__, websockets=websockets.__version__)
        except Exception as e:  # noqa: BLE001
            out['error'] = str(e)[:300]
        print(json.dumps(out), flush=True)
        sys.exit(0 if out['ok'] else 1)
    watch_parent(a.parent_pid)
    from websockets.asyncio.server import serve
    t0 = time.perf_counter()
    if not a.fake and not os.path.isfile(os.path.join(a.model_dir, 'onnx', 'model_quantized.onnx')):
        log(f'[kokoro] no model at {a.model_dir!r} (install it from the alert voice card)')
        sys.exit(2)
    k = Kokoro(a.model_dir, a.data_dir, a.fake, a.threads or max(2, min(6, (os.cpu_count() or 4) // 2)))
    lock = asyncio.Lock()
    loop = asyncio.get_running_loop()

    async def handler(ws):
        await ws.send(json.dumps({'type': 'ready', 'voices': k.voices(), 'sampleRate': SR, 'fake': a.fake}))
        async for msg in ws:
            if isinstance(msg, bytes):
                continue
            rid = -1
            try:
                req = json.loads(msg)
                if req.get('type') != 'say':
                    continue
                rid = int(req.get('id', -1))
                async with lock:
                    t = time.perf_counter()
                    audio, unknown, skipped = await loop.run_in_executor(None, k.say, str(req.get('text', '')), str(req.get('voice', 'af_heart')), float(req.get('speed', 1.0)))
                    ms = (time.perf_counter() - t) * 1000
                await ws.send(json.dumps({'type': 'audio', 'id': rid, 'sampleRate': SR, 'seconds': round(len(audio) / SR, 3), 'ms': round(ms, 1), 'spelled': unknown[:12], 'skipped': skipped[:12]}))
                await ws.send(wav_bytes(audio, SR))
            except Unspeakable as e:
                await ws.send(json.dumps({'type': 'error', 'id': rid, 'code': 'unspeakable', 'error': str(e)[:200]}))
            except Exception as e:  # noqa: BLE001
                await ws.send(json.dumps({'type': 'error', 'id': rid, 'error': str(e)[:200]}))

    async with serve(handler, '127.0.0.1', a.port, max_size=1 << 20, process_request=guard('/kokoro'), ping_interval=None):
        log(f'[kokoro] ready in {time.perf_counter() - t0:.1f}s, ws://127.0.0.1:{a.port}/kokoro')
        await asyncio.get_running_loop().create_future()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
