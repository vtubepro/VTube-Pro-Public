/// <reference lib="webworker" />
// The OpenSeeFace face worker (low-spec CPU source, src/tracking/openSeeFace/): the camera picture is drawn small on a 2D canvas
// in the worker, the two OpenSeeFace networks run on onnxruntime-web's single-threaded WebAssembly backend (no WebGL, no WebGPU,
// no Python), and every result is one ExternalTracking packet (osfCore.ts) for the studio's ExternalFaceSource.
//
// Messages in:  {type:'init', models:{detector:url, landmarks:url}, ortBase}   {type:'frame', bitmap, id}   {type:'reset'}
// Messages out: {type:'ready', loadMs}   {type:'result', id, ms, d, timing}   {type:'error', message, fatal?}
import type * as OrtNS from 'onnxruntime-web';
import { OsfTracker, type OsfModels } from './osfCore.ts';
import { createOsfModels } from './osfOrt.ts';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
/** The picture the networks see is at most this wide: the detector squashes to 224 anyway and a 480-wide face crop is plenty. */
const WORK_W = 480;

let tracker: OsfTracker | null = null;
let models: (OsfModels & { close(): Promise<void> }) | null = null;
let canvas: OffscreenCanvas | null = null;
let c2d: OffscreenCanvasRenderingContext2D | null = null;
let running = false;

async function loadOrt(ortBase: string): Promise<typeof OrtNS> {
  const ort = (await import(/* @vite-ignore */ `${ortBase}ort.wasm.min.mjs`)) as typeof OrtNS;
  ort.env.wasm.numThreads = 1;     // the studio pages are not cross-origin isolated (no SharedArrayBuffer)
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = ortBase;
  ort.env.logLevel = 'error';
  return ort;
}
async function bytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`model file: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
const rnd = (v: number) => +v.toFixed(2);

ctx.onmessage = (e: MessageEvent<{ type: string; [k: string]: unknown }>) => {
  const m = e.data;
  if (m.type === 'frame') {
    const bmp = m.bitmap as VideoFrame | ImageBitmap;
    if (running || !tracker) { try { bmp.close(); } catch { /* closed */ } return; }
    running = true;
    void frame(m.id as number, bmp).finally(() => { running = false; });
    return;
  }
  void handle(m);
};

async function handle(m: { type: string; [k: string]: unknown }) {
  try {
    if (m.type === 'init') {
      const t0 = performance.now();
      const urls = m.models as { detector: string; landmarks: string };
      const [ort, det, lm] = await Promise.all([loadOrt(String(m.ortBase)), bytes(urls.detector), bytes(urls.landmarks)]);
      models = await createOsfModels(ort, det, lm);
      tracker = new OsfTracker(models);
      // warm-up: the first run of each network allocates
      await models.detect(new Float32Array(3 * 224 * 224));
      await models.landmarks(new Float32Array(3 * 224 * 224));
      ctx.postMessage({ type: 'ready', loadMs: Math.round(performance.now() - t0) });
    } else if (m.type === 'reset') tracker?.reset();
    else if (m.type === 'close') { await models?.close(); models = null; tracker = null; ctx.close(); }
  } catch (err) {
    ctx.postMessage({ type: 'error', fatal: true, message: String((err as Error)?.message ?? err) });
  }
}

async function frame(id: number, bmp: VideoFrame | ImageBitmap) {
  const t0 = performance.now();
  try {
    const sw = (bmp as ImageBitmap).width ?? (bmp as VideoFrame).displayWidth, sh = (bmp as ImageBitmap).height ?? (bmp as VideoFrame).displayHeight;
    const w = Math.min(WORK_W, sw), h = Math.max(2, Math.round((sh * w) / sw));
    if (!canvas || canvas.width !== w || canvas.height !== h) {
      canvas = new OffscreenCanvas(w, h);
      c2d = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
    }
    c2d!.drawImage(bmp as CanvasImageSource, 0, 0, w, h);
    const img = c2d!.getImageData(0, 0, w, h);
    const t1 = performance.now();
    const d = await tracker!.process({ data: img.data, w, h });
    const tm = tracker!.timing;
    ctx.postMessage({ type: 'result', id, ms: rnd(performance.now() - t0), d, timing: { read: rnd(t1 - t0), det: rnd(tm.det), lm: rnd(tm.lm), post: rnd(tm.post) }, detected: tracker!.lastDetected });
  } catch (err) {
    ctx.postMessage({ type: 'error', id, message: String((err as Error)?.message ?? err) });
  } finally {
    try { bmp.close(); } catch { /* closed */ }
  }
}
