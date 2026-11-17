"""Offline Audio2Face-3D pass over a 16 kHz wav: ARKit curves at 60 fps for several future-context budgets.

  python a2f_offline.py clip16k.wav out.npz [--future 0.26,0.15,0.1,0.06] [--fps 60] [--device cuda]

future = how much audio after the frame's instant the model may hear (the rest of its 0.26 s is zero-padded) —
what a live stream with that much lip-sync lookahead can do.
"""
import argparse
import os
import sys
import time
import wave

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from a2f_core import A2F, ARKIT, HALF, SR, WIN, pad_future  # noqa: E402


def load_wav(p):
    w = wave.open(p)
    assert w.getframerate() == SR and w.getsampwidth() == 2
    x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
    if w.getnchannels() > 1:
        x = x.reshape(-1, w.getnchannels()).mean(1)
    return x


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('wav'); ap.add_argument('out')
    ap.add_argument('--future', default='0.26,0.15,0.1,0.06,0.03')
    ap.add_argument('--fps', type=float, default=60)
    ap.add_argument('--device', default='cuda')
    ap.add_argument('--batch', type=int, default=32)
    ap.add_argument('--reg', type=float, default=1.0)
    ap.add_argument('--pad', default='reflect', help='zero | reflect: how the unheard future is filled')
    a = ap.parse_args()
    x = load_wav(a.wav)
    m = A2F(device=a.device, reg_scale=a.reg)
    print('provider', m.provider)
    pad = np.zeros(WIN, np.float32)
    xp = np.concatenate([pad, x, pad])
    ts = np.arange(0, len(x) / SR, 1 / a.fps)
    res = {'t': ts, 'names': np.array(ARKIT)}
    for F in [float(v) for v in a.future.split(',')]:
        fs = int(round(F * SR))
        W = np.zeros((len(ts), WIN), np.float32)
        for i, t in enumerate(ts):
            c = int(round(t * SR)) + WIN
            W[i] = xp[c - HALF:c + HALF]
            if fs < HALF:
                W[i, HALF + fs:] = pad_future(W[i, :HALF + fs], HALF - fs, a.pad)
        t0 = time.perf_counter()
        Y = np.concatenate([m.infer(W[i:i + a.batch]) for i in range(0, len(W), a.batch)])
        t1 = time.perf_counter()
        m.reset()
        BS = np.stack([m.solve(y) for y in Y])
        t2 = time.perf_counter()
        print(f'future {F:.3f}s: {len(ts)} frames, net {1000*(t1-t0)/len(ts):.2f} ms/frame (batched), solve {1000*(t2-t1)/len(ts):.2f} ms/frame')
        res[f'bs_{int(F*1000)}'] = BS.astype(np.float32)
        res[f'raw_{int(F*1000)}'] = Y.astype(np.float32)
    np.savez_compressed(a.out, **res)


if __name__ == '__main__':
    main()
