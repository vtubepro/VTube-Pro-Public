"""Audio2Face-3D GPU sidecar: a localhost websocket that turns the studio's 16 kHz mic stream into ARKit blendshapes.

  python tools/gpu/a2f_sidecar.py [--port 5197] [--device cuda|dml|cpu] [--fps 60]

Started by the server (server/gpuSidecars.ts) when Go Live -> Voice -> "GPU lip sync (Audio2Face)" is on.
Binds 127.0.0.1 only. One studio at a time (a new connection replaces the old one).

Protocol (ws://127.0.0.1:5197/a2f):
  client -> text   {"type":"hello","futureMs":60,"fps":60}     (futureMs: audio after each frame's instant the model
                                                                  may wait for; the rest of its 260 ms is mirrored)
  client -> binary float32 LE mono 16 kHz samples, any chunk size, in order (the stream clock = samples received)
  client -> text   {"type":"reset"}                             (stream restart: clock back to 0)
  server -> text   {"type":"ready","provider":"CUDAExecutionProvider","fps":60,"futureMs":60,"names":[52 ARKit + 8 tongue poses]}
  server -> text   {"type":"f","s":[sample idx of each frame's instant],"w":[[60 weights x1000 ints]...],"ms":net ms}
                   (ARKit tongueOut and eyeLook* are filled from A2F's tongue solve and eye rotation; the 8 extra tongue
                    poses follow the 52. A client that only knows the 52 names ignores the rest.)
  server -> text   {"type":"stat","msPerSec":..,"frames":..}   (every ~2 s)
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from a2f_core import A2F, HALF, NAMES, SR, WIN, pad_future  # noqa: E402
from ws_guard import guard, may_replace, pcm_from_message  # noqa: E402


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


def watch_parent(pid: int):
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


class Stream:
    def __init__(self, model: A2F, fps: float, future_ms: float):
        self.m = model
        self.hop = SR / fps
        self.set_future(future_ms)
        self.reset()

    def set_future(self, ms: float):
        self.fs = int(max(0.0, min(260.0, float(ms))) * SR / 1000)

    def reset(self):
        self.buf = np.zeros(WIN * 4, np.float32)
        self.n = 0              # samples received
        self.next = 0.0         # next frame's instant (sample index)
        self.m.reset()

    def push(self, x: np.ndarray):
        if len(x) >= len(self.buf):
            x = x[-len(self.buf) + 1:]
        self.buf = np.concatenate([self.buf[len(x):], x])
        self.n += len(x)

    def due(self):
        """frames whose instant + future budget has been heard -> (sample idx list, windows)"""
        idx, wins = [], []
        # don't fall behind: after a stall only the newest ~0.25 s are computed
        if self.n - self.fs - self.next > SR * 0.25:
            self.next = self.n - self.fs - SR * 0.25
        while self.next + self.fs <= self.n:
            c = int(round(self.next))
            end = self.n                               # buffer's last sample = stream sample n-1
            lo = c - HALF
            hi = min(c + HALF, end)
            w = np.zeros(WIN, np.float32)
            a = len(self.buf) - (end - lo)
            b = len(self.buf) - (end - hi)
            if a < 0:
                w[-a:hi - lo] = self.buf[0:b]
            else:
                w[:hi - lo] = self.buf[a:b]
            if hi - lo < WIN:
                w[hi - lo:] = pad_future(w[:hi - lo], WIN - (hi - lo))
            idx.append(c)
            wins.append(w)
            self.next += self.hop
        return idx, wins


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=int(os.environ.get('VTP_A2F_PORT', 5197)))
    ap.add_argument('--device', default=os.environ.get('VTP_A2F_DEVICE', 'cuda'))
    ap.add_argument('--fps', type=float, default=60)
    ap.add_argument('--model', default=None)
    ap.add_argument('--parent-pid', type=int, default=0, help='exit when this process (the server) is gone')
    a = ap.parse_args()
    watch_parent(a.parent_pid)
    import websockets
    t0 = time.perf_counter()
    model = A2F(a.model, device=a.device)
    model.infer(np.zeros((2, WIN), np.float32))  # warm-up (cuDNN autotune, allocations)
    print(f'[a2f] ready on {model.provider} in {time.perf_counter() - t0:.1f}s, ws://127.0.0.1:{a.port}/a2f', flush=True)
    current = {'ws': None}
    lock = asyncio.Lock()

    async def handler(ws):
        old = current['ws']
        if old is not None:
            if not may_replace(ws):
                # a program (no Origin) never takes the studio's connection away; only a studio page may replace it
                await ws.close(4001, 'another studio is connected')
                return
            try:
                await old.close(4000, 'replaced by a newer studio')
            except Exception:
                pass
        current['ws'] = ws
        st = Stream(model, a.fps, 60)
        busy_ms, frames, last_stat = 0.0, 0, time.perf_counter()
        await ws.send(json.dumps({'type': 'ready', 'provider': model.provider, 'fps': a.fps, 'futureMs': st.fs * 1000 / SR, 'names': NAMES}))
        loop = asyncio.get_running_loop()
        try:
            async for msg in ws:
                if isinstance(msg, str):
                    try:
                        d = json.loads(msg)
                    except Exception:
                        continue
                    if d.get('type') == 'hello':
                        if 'futureMs' in d:
                            st.set_future(d['futureMs'])
                        if 'fps' in d and 10 <= float(d['fps']) <= 120:
                            st.hop = SR / float(d['fps'])
                        st.reset()
                        await ws.send(json.dumps({'type': 'ready', 'provider': model.provider, 'fps': SR / st.hop, 'futureMs': st.fs * 1000 / SR, 'names': NAMES}))
                    elif d.get('type') == 'reset':
                        st.reset()
                    continue
                x = pcm_from_message(msg)   # (empty / not whole float32 samples: skipped; NaN / inf zeroed)
                if x is None:
                    continue
                st.push(x)
                idx, wins = st.due()
                if not idx:
                    continue
                async with lock:
                    t = time.perf_counter()

                    def work():
                        Y = model.infer(np.stack(wins))
                        return [model.frame(y, 1.0 / max(1.0, SR / st.hop)) for y in Y]
                    W = await loop.run_in_executor(None, work)
                    ms = (time.perf_counter() - t) * 1000
                busy_ms += ms
                frames += len(idx)
                await ws.send(json.dumps({'type': 'f', 's': idx, 'w': [np.round(w * 1000).astype(int).tolist() for w in W], 'ms': round(ms, 2)}))
                now = time.perf_counter()
                if now - last_stat > 2:
                    await ws.send(json.dumps({'type': 'stat', 'msPerSec': round(busy_ms / (now - last_stat), 1), 'frames': frames}))
                    busy_ms, frames, last_stat = 0.0, 0, now
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            if current['ws'] is ws:
                current['ws'] = None

    async with websockets.serve(handler, '127.0.0.1', a.port, max_size=2 ** 20, compression=None, process_request=guard('/a2f')):
        await asyncio.Future()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
