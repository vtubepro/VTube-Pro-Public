"""Camera-frame GPU sidecars: NVIDIA Maxine AR face expressions, or RTMW whole-body pose.

  python tools/gpu/vision_sidecar.py --feature maxine [--port 5199]
  python tools/gpu/vision_sidecar.py --feature rtmw   [--port 5198]

The studio already owns the webcam (never opened here: no fighting over the Elgato). It sends downscaled frames
(src/tracking/gpuVision.ts) over ws://127.0.0.1:<port>/<feature>:
  client -> binary  8-byte little-endian float64 capture time (ms, performance clock of the page) + JPEG bytes
  server -> text    {"type":"ready","feature":..,"provider":..,"names":[..]}
  server -> text    {"type":"r","t":capture ms,"ms":inference ms,"face":{"w":[53],"pose":[x,y,z,w],"conf":c} | null}
                    {"type":"r","t":..,"ms":..,"kp":[[x/W, y/H, conf] x 133]}          (rtmw)
Frames that queue up are dropped (only the newest is processed). One studio at a time. Binds 127.0.0.1 only.
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
from a2f_sidecar import watch_parent  # noqa: E402
from ws_guard import guard, may_replace  # noqa: E402


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--feature', choices=['maxine', 'rtmw'], required=True)
    ap.add_argument('--port', type=int, default=0)
    ap.add_argument('--parent-pid', type=int, default=0)
    ap.add_argument('--model', default=None)
    a = ap.parse_args()
    watch_parent(a.parent_pid)
    port = a.port or (5199 if a.feature == 'maxine' else 5198)
    import cv2
    import websockets
    state = {'eng': None, 'size': None, 'ws': None}
    names: list[str] = []
    provider = ''
    if a.feature == 'rtmw':
        from rtmw_core import RTMW
        state['eng'] = RTMW(a.model)
        provider = state['eng'].provider
        state['eng'].run(np.zeros((360, 640, 3), np.uint8))
    else:
        from maxine_core import ARKIT_OUT, MaxineError, sdk_dir
        if not sdk_dir():
            print('[maxine] NVIDIA AR SDK not installed: https://www.nvidia.com/broadcast-sdk-resources', flush=True)
            sys.exit(3)
        names = ARKIT_OUT
        provider = 'NVIDIA AR SDK'
    print(f'[{a.feature}] ready ({provider}) ws://127.0.0.1:{port}/{a.feature}', flush=True)
    busy = asyncio.Lock()
    loop = asyncio.get_running_loop()

    def process(buf: bytes):
        t = float(np.frombuffer(buf[:8], '<f8')[0])
        img = cv2.imdecode(np.frombuffer(buf[8:], np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            return None
        H, W = img.shape[:2]
        t0 = time.perf_counter()
        if a.feature == 'rtmw':
            k = state['eng'].run(img)
            k[:, 0] /= W; k[:, 1] /= H
            return {'type': 'r', 't': t, 'ms': round((time.perf_counter() - t0) * 1000, 2), 'kp': np.round(k, 4).tolist()}
        if state['size'] != (W, H):
            from maxine_core import MaxineFace
            if state['eng']:
                state['eng'].close()
            state['eng'] = MaxineFace(W, H)
            state['size'] = (W, H)
        r = state['eng'].run(img)
        face = None if r is None else {'w': np.round(r['w'], 4).tolist(), 'pose': [round(v, 5) for v in r['pose']], 'conf': round(r['conf'], 3)}
        return {'type': 'r', 't': t, 'ms': round((time.perf_counter() - t0) * 1000, 2), 'face': face}

    async def handler(ws):
        old = state['ws']
        if old is not None:
            if not may_replace(ws):
                await ws.close(4001, 'another studio is connected')   # (a program never takes the studio's connection; a studio page may)
                return
            try:
                await old.close(4000, 'replaced by a newer studio')
            except Exception:
                pass
        state['ws'] = ws
        await ws.send(json.dumps({'type': 'ready', 'feature': a.feature, 'provider': provider, 'names': names}))
        latest = {'buf': None}
        ev = asyncio.Event()

        async def worker():
            while True:
                await ev.wait(); ev.clear()
                buf, latest['buf'] = latest['buf'], None
                if buf is None:
                    continue
                async with busy:
                    try:
                        out = await loop.run_in_executor(None, process, buf)
                    except Exception as e:  # keep serving; report once per failure
                        out = {'type': 'error', 'error': str(e)[:300]}
                if out:
                    try:
                        await ws.send(json.dumps(out))
                    except Exception:
                        return
        task = asyncio.create_task(worker())
        try:
            async for msg in ws:
                if isinstance(msg, (bytes, bytearray)) and len(msg) > 8:
                    latest['buf'] = bytes(msg)   # newest wins: a slow frame never builds a queue
                    ev.set()
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            task.cancel()
            if state['ws'] is ws:
                state['ws'] = None

    async with websockets.serve(handler, '127.0.0.1', port, max_size=2 ** 22, compression=None, process_request=guard('/' + a.feature)):
        await asyncio.Future()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
