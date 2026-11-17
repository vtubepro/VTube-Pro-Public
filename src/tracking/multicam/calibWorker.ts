/// <reference lib="webworker" />
// Runs the stereo self-calibration (stereoCalib.ts solve(): a few hundred ms of Levenberg–Marquardt) off the main
// thread, so tracking and the OBS output never hitch while the "Two cameras" wizard calibrates.
import { StereoCalibrator, type CamInfo, type FaceObs } from './stereoCalib.ts';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
ctx.onmessage = (e: MessageEvent<{ camA: CamInfo; camB: CamInfo; A: FaceObs[]; B: FaceObs[] }>) => {
  const m = e.data;
  try {
    const c = new StereoCalibrator(m.camA, m.camB);
    c.load({ A: m.A, B: m.B });
    const t0 = performance.now();
    const calib = c.solve();
    ctx.postMessage({ ok: true, calib, ms: performance.now() - t0 });
  } catch (err) {
    ctx.postMessage({ ok: false, error: String((err as Error)?.message ?? err) });
  }
};
