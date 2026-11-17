// The processor-only face tracker (the face on "Processor" / "Processor (for games)" / Auto's moves), studio side: one
// small interface Tracker.ts selects
// (research: vtp-b12/research/tracking_gpu_rca/RCA.md; docs/PERFORMANCE.md "Face tracking without the graphics card").
//
// Why: tasks-vision 1.0.1 uploads every frame into WebGL and reads it back even on its CPU delegate, so a game holding
// the graphics card at 95 %+ makes today's "Processor" face wait behind the game (measured next to a UE5 game: 31 ms /
// 20 Hz, 50-80 ms with the body models left on the card). This engine runs the same face models on onnxruntime-web's
// WebAssembly CPU backend with pixels copied out of the camera frame on the CPU: no WebGL at all in its worker.
//
// When it is used (cpuFaceFor): whenever the FACE runs on the processor — the 'nogpu' setting ("Processor (for games)":
// pose and hands at most 10 a second, bodyCapFor), Auto moving the face off
// a busy graphics card (its slow rule and game mode: both start a face worker on 'CPU'), and the 'cpu' setting — unless
// localStorage vtp.cpuFace = 'off' (then the face uses tasks-vision's CPU delegate as before), or the browser lacks
// WebAssembly SIMD / module workers. A worker that fails to start falls back to tasks-vision's CPU face (Tracker.spawn).

import type { DelegatePolicy } from '../delegatePolicy.ts';

export const CPU_FACE_KEY = 'vtp.cpuFace';
export type CpuFaceMode = 'auto' | 'on' | 'off';

export function readCpuFaceMode(): CpuFaceMode {
  try { const v = localStorage.getItem(CPU_FACE_KEY); return v === 'on' || v === 'off' ? v : 'auto'; } catch { return 'auto'; }
}

let simd: boolean | null = null;
/** WebAssembly SIMD (onnxruntime-web's wasm build needs it): a 1-instruction module that uses v128. */
export function wasmSimd(): boolean {
  if (simd !== null) return simd;
  try {
    simd = typeof WebAssembly === 'object' && WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch { simd = false; }
  return simd;
}

let broken = '';
/** The engine failed to start in this session (its worker reported an error): tasks-vision's CPU face from now on. */
export function markCpuFaceBroken(why: string) { broken = why || 'failed'; console.warn('[tracker] processor-only face tracker unavailable, using the standard processor tracker:', broken); }
export const cpuFaceBroken = () => broken;
/** Tests only. */
export function resetCpuFaceForTests() { broken = ''; frameFails = 0; }

export function cpuFaceSupported(): boolean {
  return !broken && typeof Worker !== 'undefined' && wasmSimd() && (typeof VideoFrame !== 'undefined' || typeof OffscreenCanvas !== 'undefined');
}

/** Does a face worker on the processor use this engine? (see the header) */
export function cpuFaceFor(policy: DelegatePolicy | string, mode: CpuFaceMode = readCpuFaceMode()): boolean {
  if (mode === 'off' || !cpuFaceSupported()) return false;
  if (mode === 'on') return true;
  return policy === 'nogpu' || policy === 'auto' || policy === 'cpu';
}

/** Pose / hand-model runs per second at most for a policy ('nogpu': they still use tasks-vision, which uploads each
 *  frame to the graphics card; 10 a second keeps that small while the face never waits for them). */
export function bodyCapFor(policy: DelegatePolicy | string): number { return policy === 'nogpu' ? 10 : Infinity; }

const workers = new WeakSet<Worker>();
export function spawnCpuFaceWorker(name: string): Worker {
  const w = new Worker(new URL('./cpuFaceWorker.ts', import.meta.url), { type: 'module', name });
  workers.add(w);
  return w;
}
export const isCpuFace = (w: Worker | null | undefined): boolean => !!w && workers.has(w);

const BASE_URL = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
/** Extra fields of the face worker's 'init' message (onnxruntime-web is the voice filter's copy: public/vendor/voice). */
export function cpuFaceInit() { return { ortBase: `${location.origin}${BASE_URL}vendor/voice/` }; }

/**
 * The camera frame for the processor-only face worker: a VideoFrame of what the video shows now (no copy, no GPU work
 * here: the worker copies the pixels it needs), or where VideoFrame is missing (Firefox before 130) an ImageBitmap,
 * which Firefox keeps in memory on the CPU. `tMs`: the frame's time (its VideoFrame timestamp, microseconds).
 */
let frameFails = 0;
export function grabCpuFrame(video: HTMLVideoElement, tMs: number): Promise<VideoFrame | ImageBitmap> {
  // (a browser whose VideoFrame cannot wrap the video three times in a row: an ImageBitmap from then on, which works
  //  everywhere; in Chrome that one is made on the graphics card, so it is only the last resort)
  if (typeof VideoFrame !== 'undefined' && frameFails < 3) {
    try { const f = new VideoFrame(video, { timestamp: Math.round(tMs * 1000) }); frameFails = 0; return Promise.resolve(f); } catch (e) {
      if (++frameFails === 3) console.warn('[tracker] VideoFrame from the camera video failed 3 times; the processor-only face reads ImageBitmaps instead', e);
      if (frameFails < 3) return Promise.reject(e);
    }
  }
  return createImageBitmap(video);
}

/** Per-frame figures the worker reports with each result (diagnostics, tools/cpuface_bench.mjs). */
export interface CpuFaceStats {
  /** ms: reading the frame's pixels (VideoFrame.copyTo), sampling the model inputs, the detector (0 while tracking),
   *  the landmark model, the blendshape model, the rest (geometry, packing) */
  copy: number; pre: number; det: number; lm: number; bs: number; post: number;
  detected: boolean;
  /** how the frame was read: its pixel format ('I420', 'NV12', ...), 'X->RGBA' (converted by the browser), 'bitmap' */
  read: string;
  /** pixels read */
  px: number;
  /** WebGL contexts + WebGL calls + WebGPU requests seen in the worker so far (glGuard.ts): always 0 */
  gl: number;
}
