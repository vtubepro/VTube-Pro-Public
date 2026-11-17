"""A2F's tongue / eye / upper-face extras on a recorded 16 kHz wav (offline): ranges, relation to the jaw, and a check that
the skin channels are exactly what the plain solve gives.

  python a2f_extras_eval.py clip16k.wav [--from 3] [--to 20] [--fps 30] [--device cpu|cuda]

Numbers from this script are quoted in docs/GPU_TRACKING.md (recorded clip of the author's voice, CPU run).
"""
import argparse
import os
import sys
import wave

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from a2f_core import A2F, ARKIT, HALF, NAMES, SR, WIN  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('wav'); ap.add_argument('--from', dest='t0', type=float, default=3.0); ap.add_argument('--to', dest='t1', type=float, default=20.0)
    ap.add_argument('--fps', type=float, default=30); ap.add_argument('--device', default='cpu')
    a = ap.parse_args()
    w = wave.open(a.wav)
    assert w.getframerate() == SR and w.getsampwidth() == 2
    x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
    xp = np.concatenate([np.zeros(WIN, np.float32), x, np.zeros(WIN, np.float32)])
    ts = np.arange(a.t0, min(a.t1, len(x) / SR), 1 / a.fps)
    win = np.stack([xp[int(round(t * SR)) + WIN - HALF:int(round(t * SR)) + WIN + HALF] for t in ts])
    m = A2F(device=a.device)
    Y = np.concatenate([m.infer(win[i:i + 8]) for i in range(0, len(win), 8)])
    m.reset()
    plain = np.stack([m.solve(y) for y in Y])
    m2 = A2F(device=a.device); m2.reset()
    rows = np.stack([m2.frame(y, 1 / a.fps) for y in Y])
    skin = [n for n in ARKIT if n != 'tongueOut' and not n.startswith('eyeLook')]
    diff = max(float(np.abs(rows[:, NAMES.index(n)] - plain[:, ARKIT.index(n)]).max()) for n in skin)
    print(f'{len(ts)} frames, row width {rows.shape[1]}; skin channels differ from the plain solve by at most {diff:g}')
    jaw = rows[:, NAMES.index('jawOpen')]
    print('channel            mean   std    max    p95   corr(jawOpen)')
    for n in ['tongueOut'] + NAMES[52:] + [n for n in ARKIT if n.startswith('eyeLook')] + ['browInnerUp', 'browOuterUpLeft', 'eyeWideLeft', 'cheekSquintLeft', 'noseSneerLeft']:
        c = rows[:, NAMES.index(n)]
        cc = np.corrcoef(c, jaw)[0, 1] if c.std() > 1e-6 else float('nan')
        print(f'{n:18s} {c.mean():.3f} {c.std():.3f} {c.max():.3f} {np.percentile(c, 95):.3f} {cc:+.2f}')


if __name__ == '__main__':
    main()
