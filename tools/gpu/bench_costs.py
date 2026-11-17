"""Measure what the GPU sidecars cost on this PC: GPU utilisation, VRAM, extra latency, CPU cores, at 30 / 60 fps.

  python tools/gpu/bench_costs.py --wav <16 kHz wav> --video <clip> [--secs 15] [--out costs.json]

Starts its own sidecars on test ports 5297 / 5298 / 5299 (never the studio's), streams the recorded clip to them in
real time like the studio does, samples nvidia-smi + the processes' CPU time, and stops only the processes it started.
GPU utilisation is the delta over an idle baseline taken first (other apps keep running).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
import wave

import numpy as np
import psutil

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable


def smi():
    o = subprocess.run(['nvidia-smi', '--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader,nounits'], capture_output=True, text=True).stdout
    u, m = [float(x) for x in o.strip().split('\n')[0].split(',')]
    return u, m


def proc_mem():
    o = subprocess.run(['nvidia-smi', '--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'], capture_output=True, text=True).stdout
    out = {}
    for line in o.strip().split('\n'):
        if ',' in line:
            p, m = line.split(',')
            try:
                out[int(p)] = float(m)
            except ValueError:
                pass
    return out


def start(feature, port):
    script = 'a2f_sidecar.py' if feature == 'a2f' else 'vision_sidecar.py'
    args = [PY, '-u', os.path.join(HERE, script), '--port', str(port)] + ([] if feature == 'a2f' else ['--feature', feature])
    p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=0x08000000 if os.name == 'nt' else 0)
    t0 = time.time()
    while time.time() - t0 < 60:
        line = p.stdout.readline().decode('utf8', 'replace')
        if 'ready' in line:
            return p
        if p.poll() is not None:
            raise RuntimeError(f'{feature} exited')
    raise RuntimeError(f'{feature} not ready')


async def a2f_client(port, x, fps, secs, lat):
    import websockets
    async with websockets.connect(f'ws://127.0.0.1:{port}/a2f', max_size=2 ** 22) as ws:
        await ws.recv()
        fut = 60
        await ws.send(json.dumps({'type': 'hello', 'futureMs': fut, 'fps': fps})); await ws.recv()
        sent = {}

        async def rx():
            async for m in ws:
                d = json.loads(m)
                if d['type'] == 'f':
                    now = time.perf_counter()
                    for s in d['s']:
                        k = ((s + fut * 16) // 160 + 1) * 160
                        if k in sent:
                            lat.append((now - sent[k]) * 1000)
        task = asyncio.create_task(rx())
        t0 = time.perf_counter()
        n = int(secs * 16000)
        for i in range(0, n, 160):
            await ws.send(x[i % (len(x) - 160):i % (len(x) - 160) + 160].tobytes()); sent[i + 160] = time.perf_counter()
            dl = t0 + (i + 160) / 16000 - time.perf_counter()
            if dl > 0:
                await asyncio.sleep(dl)
        await asyncio.sleep(0.3); task.cancel()


async def vision_client(port, feature, jpgs, fps, secs, lat):
    import websockets
    async with websockets.connect(f'ws://127.0.0.1:{port}/{feature}', max_size=2 ** 22) as ws:
        await ws.recv()
        sent = {}

        async def rx():
            async for m in ws:
                d = json.loads(m)
                if d.get('type') == 'r' and d['t'] in sent:
                    lat.append((time.perf_counter() - sent[d['t']]) * 1000)
        task = asyncio.create_task(rx())
        t0 = time.perf_counter()
        for i in range(int(secs * fps)):
            t = float(i)
            sent[t] = time.perf_counter()
            await ws.send(np.float64(t).tobytes() + jpgs[i % len(jpgs)])
            dl = t0 + (i + 1) / fps - time.perf_counter()
            if dl > 0:
                await asyncio.sleep(dl)
        await asyncio.sleep(0.3); task.cancel()


async def run_case(feats, fps, secs, x, jpgs):
    ports = {'a2f': 5297, 'rtmw': 5298, 'maxine': 5299}
    procs = {f: start(f, ports[f]) for f in feats}
    try:
        time.sleep(2)
        # a venv's python.exe is a launcher: the real interpreter is its child
        fam = {f: [psutil.Process(p.pid)] + psutil.Process(p.pid).children(recursive=True) for f, p in procs.items()}
        cput = lambda f: sum(sum(q.cpu_times()[:2]) for q in fam[f])  # noqa: E731
        cpu0 = {f: cput(f) for f in feats}
        lats = {f: [] for f in feats}
        samples = []
        stop = False

        async def sampler():
            while not stop:
                samples.append(smi()); await asyncio.sleep(0.5)
        st = asyncio.create_task(sampler())
        t0 = time.time()
        await asyncio.gather(*[a2f_client(ports[f], x, fps, secs, lats[f]) if f == 'a2f' else vision_client(ports[f], f, jpgs, fps, secs, lats[f]) for f in feats])
        wall = time.time() - t0
        stop = True; await st
        mem = proc_mem()
        res = {}
        for f in feats:
            cores = (cput(f) - cpu0[f]) / wall
            L = np.array(lats[f]) if lats[f] else np.array([np.nan])
            res[f] = {'cpu_cores': round(cores, 3), 'vram_mb': max([mem.get(q.pid, 0) for q in fam[f]] or [0]) or None, 'lat_ms_median': round(float(np.median(L)), 1), 'lat_ms_p95': round(float(np.percentile(L, 95)), 1)}
        u = np.array([s[0] for s in samples])
        return res, float(np.mean(u)), float(np.max([s[1] for s in samples]))
    finally:
        for p in procs.values():
            p.kill()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--wav', required=True); ap.add_argument('--video', required=True)
    ap.add_argument('--secs', type=float, default=15); ap.add_argument('--out', default='costs.json')
    ap.add_argument('--cases', default='a2f,maxine,rtmw,a2f+maxine+rtmw')
    a = ap.parse_args()
    import cv2
    w = wave.open(a.wav); x = (np.frombuffer(w.readframes(w.getnframes()), np.int16) / 32768).astype(np.float32)[3 * 16000:34 * 16000]
    cap = cv2.VideoCapture(a.video); jpgs = []
    cap.set(cv2.CAP_PROP_POS_MSEC, 3000)
    while len(jpgs) < 240:
        ok, f = cap.read()
        if not ok:
            break
        jpgs.append(cv2.imencode('.jpg', cv2.resize(f, (640, 360), interpolation=cv2.INTER_AREA), [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes())
    base = [smi() for _ in range(8) if not time.sleep(0.5)]
    base_u = float(np.mean([b[0] for b in base])); base_m = float(np.mean([b[1] for b in base]))
    print(f'idle baseline: GPU {base_u:.1f} %, VRAM used {base_m:.0f} MB', flush=True)
    out = {'baseline': {'gpu_util': base_u, 'vram_mb': base_m}, 'cases': {}}
    for case in a.cases.split(','):
        feats = case.split('+')
        for fps in (30, 60):
            res, u, m = asyncio.run(run_case(feats, fps, a.secs, x, jpgs))
            key = f'{case}@{fps}'
            out['cases'][key] = {'gpu_util_delta': round(u - base_u, 1), 'vram_total_delta_mb': round(m - base_m), 'per': res}
            print(key, json.dumps(out['cases'][key]), flush=True)
    json.dump(out, open(a.out, 'w'), indent=1)


if __name__ == '__main__':
    main()
