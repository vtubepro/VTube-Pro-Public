/// <reference lib="webworker" />
// The processor-only face worker (the face on the processor, src/tracking/cpuFace/index.ts): the same face models as the tasks-vision face worker
// (face_landmarker.task), run by onnxruntime-web's single-threaded WebAssembly backend on pixels copied out of the camera
// frame on the CPU. No canvas, no WebGL, no WebGPU (glGuard.ts refuses and counts them), so a game that holds the
// graphics card cannot make it wait. It speaks the face role of trackWorker.ts's protocol ('init' -> 'ready',
// 'frame' -> 'result' with a FaceLandmarkerResult-shaped `face`), so Tracker.ts treats it like any face worker.
//
// Frames: a VideoFrame (`new VideoFrame(video)` on the studio's camera frame, transferred) read with copyTo: only the
// region around the tracked face while it is tracked, the whole frame while the detector looks; or, where VideoFrame is
// missing (Firefox before 130), an ImageBitmap read through a 2D canvas (software in Firefox).

import { glStats, installGlGuard } from './glGuard.ts';
installGlGuard(); // before anything else can create a context

import type * as OrtNS from 'onnxruntime-web';
import { FaceGraph, BLENDSHAPE_NAMES, LANDMARKS, type NormRect, type Runner } from './faceGraph.ts';
import { parseGeometryMeta } from './geometry.ts';
import { setChromaMode, warpToRgba, type PixelFormat, type Planes } from './imageOps.ts';
import { tfliteToOnnx } from './onnx.ts';
import { readTaskBundle } from './taskBundle.ts';
import { parseTflite } from './tflite.ts';
import { PATCH, analyzeMouth, mouthRect, type MouthPatchStats } from '../mouthImage.ts';
// "My face model" (faceNet/runtime.ts, docs/FACE_MODEL.md): opt-in; a frame message without `fnet` bits costs nothing here
import { FaceNetRuntime, type FaceNetOut } from '../faceNet/runtime.ts';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

interface InitMsg { type: 'init'; role: 'face'; base: string; ortBase?: string; minDetection?: number; minPresence?: number; /** tests: tools/cpuface parity */ imageMode?: boolean; chroma?: 'nearest' | 'linear'; /** tests: the fallback reads */ forceRead?: 'rgba' | 'canvas' }
interface FrameMsg { type: 'frame'; bitmap: VideoFrame | ImageBitmap; ts: number; id: number; fullW?: number; fullH?: number; mouth?: boolean; postT?: number; acqMs?: number; /** "My face model": 1 = run the net, 2 = hand the crops back */ fnet?: number }
const faceNet = new FaceNetRuntime();

let graph: FaceGraph | null = null;
let lastTs = 0;
/** per-frame stats of the last ~60 frames (diagnostics): copy (frame read), pre (sampling), det / lm / bs (models), post */
const NATIVE = new Set<string>(['I420', 'I420A', 'NV12', 'RGBA', 'RGBX', 'BGRA', 'BGRX']);
let buf = new Uint8Array(0);
let readMode = '';

async function loadOrt(ortBase: string): Promise<typeof OrtNS> {
  const ort = (await import(/* @vite-ignore */ `${ortBase}ort.wasm.min.mjs`)) as typeof OrtNS;
  ort.env.wasm.numThreads = 1; // single-threaded: the studio pages are not cross-origin isolated (no SharedArrayBuffer)
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = ortBase;
  ort.env.logLevel = 'error';
  return ort;
}

async function session(ort: typeof OrtNS, tflite: Uint8Array): Promise<Runner> {
  const o = tfliteToOnnx(parseTflite(tflite), true);
  const s = await ort.InferenceSession.create(o.bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  return async (x: Float32Array) => {
    const r = await s.run({ [o.input.name]: new ort.Tensor('float32', x, o.input.shape) });
    return o.outputs.map((q) => r[q.name].data as Float32Array);
  };
}

/** The pixels needed from a W x H frame: around the tracked face (its rect, 1.25x for motion + the mouth patch), or all. */
function region(rect: NormRect | null, W: number, H: number): { x: number; y: number; w: number; h: number } {
  if (!rect) return { x: 0, y: 0, w: W, h: H };
  const hw = (Math.abs(Math.cos(rect.rot)) * rect.w * W + Math.abs(Math.sin(rect.rot)) * rect.h * H) * 0.625 + 4;
  const hh = (Math.abs(Math.sin(rect.rot)) * rect.w * W + Math.abs(Math.cos(rect.rot)) * rect.h * H) * 0.625 + 4;
  let x0 = Math.floor(rect.xc * W - hw) & ~1, y0 = Math.floor(rect.yc * H - hh) & ~1;
  let x1 = Math.ceil(rect.xc * W + hw), y1 = Math.ceil(rect.yc * H + hh);
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1 + (x1 & 1)); y1 = Math.min(H, y1 + (y1 & 1));
  if (x1 - x0 < 16 || y1 - y0 < 16) return { x: 0, y: 0, w: W, h: H };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function grow(n: number) { if (buf.length < n) buf = new Uint8Array(Math.ceil(n * 1.25)); return buf; }

let canvas2d: OffscreenCanvasRenderingContext2D | null = null;
/** Ways of reading a VideoFrame that failed once in this browser (not tried again): its own pixel format, RGBA. */
let nativeFails = 0, rgbaFails = 0;

/** A 2D canvas read (willReadFrequently: a software canvas): an ImageBitmap (no VideoFrame in this browser), or a
 *  VideoFrame neither copyTo form could read. */
function canvasPlanes(src: VideoFrame | ImageBitmap, W: number, H: number, sx: number, sy: number, rect: NormRect | null, mode: string): Planes {
  const r = region(rect, W, H);
  if (!canvas2d || canvas2d.canvas.width < r.w || canvas2d.canvas.height < r.h) canvas2d = new OffscreenCanvas(Math.max(r.w, 16), Math.max(r.h, 16)).getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  if (!canvas2d) throw new Error('no 2D canvas');
  canvas2d.drawImage(src as CanvasImageSource, sx + r.x, sy + r.y, r.w, r.h, 0, 0, r.w, r.h);
  const img = canvas2d.getImageData(0, 0, r.w, r.h);
  readMode = mode;
  return { format: 'RGBA', frameW: W, frameH: H, x0: r.x, y0: r.y, w: r.w, h: r.h, data: new Uint8Array(img.data.buffer), layout: [{ offset: 0, stride: r.w * 4 }] };
}

/** Read the frame's pixels on the CPU (closes the frame): copyTo in its own format (a camera frame in memory: a plain
 *  copy), else copyTo as RGBA (the browser converts; a frame that lives on the graphics card is read back), else a 2D
 *  canvas. A way that throws is not tried again. */
async function readPlanes(src: VideoFrame | ImageBitmap, rect: NormRect | null): Promise<Planes> {
  if (typeof VideoFrame !== 'undefined' && src instanceof VideoFrame) {
    try {
      const vr = src.visibleRect ?? { x: 0, y: 0, width: src.displayWidth || src.codedWidth, height: src.displayHeight || src.codedHeight }, W = vr.width, H = vr.height;
      const r = region(rect, W, H);
      const copyRect = { x: vr.x + r.x, y: vr.y + r.y, width: r.w, height: r.h };
      const fmt = src.format;
      const cs = src.colorSpace;
      if (fmt && NATIVE.has(fmt) && nativeFails < 1) {
        try {
          const n = src.allocationSize({ rect: copyRect });
          const dst = grow(n);
          const layout = await src.copyTo(dst, { rect: copyRect });
          readMode = fmt;
          return { format: fmt as PixelFormat, frameW: W, frameH: H, x0: r.x, y0: r.y, w: r.w, h: r.h, data: dst, layout: layout.map((l) => ({ offset: l.offset, stride: l.stride })),
            fullRange: !!cs?.fullRange, matrix: cs?.matrix === 'bt709' ? 'bt709' : 'bt601' };
        } catch (e) { nativeFails++; console.warn('[cpuface] VideoFrame.copyTo failed, reading RGBA instead', e); }
      }
      if (rgbaFails < 1) {
        try {
          const opts = { rect: copyRect, format: 'RGBA' as VideoPixelFormat };
          const n = src.allocationSize(opts as VideoFrameCopyToOptions);
          const dst = grow(n);
          const layout = await src.copyTo(dst, opts as VideoFrameCopyToOptions);
          readMode = `${fmt ?? 'opaque'}->RGBA`;
          return { format: 'RGBA', frameW: W, frameH: H, x0: r.x, y0: r.y, w: r.w, h: r.h, data: dst, layout: layout.map((l) => ({ offset: l.offset, stride: l.stride })) };
        } catch (e) { rgbaFails++; console.warn('[cpuface] VideoFrame.copyTo (RGBA) failed, reading through a 2D canvas', e); }
      }
      return canvasPlanes(src, W, H, vr.x, vr.y, rect, `${fmt ?? 'opaque'}->canvas`);
    } finally { src.close(); }
  }
  const bmp = src as ImageBitmap;
  try { return canvasPlanes(bmp, bmp.width, bmp.height, 0, 0, rect, 'bitmap'); } finally { bmp.close(); }
}

const rnd = (v: number) => +v.toFixed(2);

/** Frames are handled one at a time (the reads and the models are async). A frame that arrives while one is still being
 *  handled (the studio only sends one while the last went unanswered for seconds: a read stuck behind a busy graphics
 *  card) is closed at once, unanswered: a stuck worker must never hold a second camera buffer (the camera's frame pool
 *  must never run dry), and the frame in flight is closed the moment its pixels are copied. */
let running = false;

ctx.onmessage = (e: MessageEvent<InitMsg | FrameMsg | { type: string }>) => {
  const m = e.data;
  if (m.type === 'frame') {
    if (running) { try { (m as FrameMsg).bitmap.close(); } catch { /* closed */ } return; }
    running = true;
    void handle(m).finally(() => { running = false; });
    return;
  }
  void handle(m);
};

async function handle(m: InitMsg | FrameMsg | { type: string }) {
  try {
    if (m.type === 'facenet') {
      faceNet.setModel((m as unknown as { model: string | null }).model);
    } else if (m.type === 'init') {
      const im = m as InitMsg;
      if (im.chroma) setChromaMode(im.chroma);
      if (im.forceRead) { nativeFails = 1; if (im.forceRead === 'canvas') rgbaFails = 1; }
      const t0 = performance.now();
      const ortBase = im.ortBase ?? `${im.base.replace(/mediapipe\/?$/, '')}vendor/voice/`;
      const [ort, bundle] = await Promise.all([
        loadOrt(ortBase),
        fetch(`${im.base}/face_landmarker.task`).then((r) => { if (!r.ok) throw new Error(`face model: HTTP ${r.status}`); return r.arrayBuffer(); }).then((b) => readTaskBundle(new Uint8Array(b))),
      ]);
      const [detector, landmarks, blendshapes] = await Promise.all([
        session(ort, bundle['face_detector.tflite']), session(ort, bundle['face_landmarks_detector.tflite']), session(ort, bundle['face_blendshapes.tflite']),
      ]);
      const geo = bundle['geometry_pipeline_metadata_landmarks.binarypb'] ? parseGeometryMeta(bundle['geometry_pipeline_metadata_landmarks.binarypb']) : null;
      graph = new FaceGraph({ detector, landmarks, blendshapes }, geo, { minDetection: im.minDetection ?? 0.4, minPresence: im.minPresence ?? 0.4, blendshapes: true, matrix: true, imageMode: !!im.imageMode });
      // warm-up: the first run of each model allocates
      await detector(new Float32Array(3 * 128 * 128)); await landmarks(new Float32Array(3 * 256 * 256)); await blendshapes(new Float32Array(292));
      ctx.postMessage({ type: 'ready', role: 'face', delegate: 'CPU', engine: 'cpuface', loadMs: Math.round(performance.now() - t0), gl: { ...glStats } });
    } else if (m.type === 'frame') {
      const fm = m as FrameMsg;
      const t0 = performance.now();
      const recv = fm.postT ? Math.max(0, performance.timeOrigin + t0 - fm.postT) : 0;
      if (!graph) { fm.bitmap.close(); ctx.postMessage({ type: 'error', role: 'face', message: 'face worker not ready' }); return; }
      const ts = Math.max(Math.round(fm.ts), lastTs + 1);
      lastTs = ts;
      const p = await readPlanes(fm.bitmap, graph.nextRect);
      const t1 = performance.now();
      const r = await graph.process(p, ts);
      const t2 = performance.now();
      const W = fm.fullW ?? p.frameW, H = fm.fullH ?? p.frameH;
      let mouth: MouthPatchStats | null = null, mouthMs = 0;
      let face = null, net: FaceNetOut | null = null;
      if (r) {
        const lm = new Array(LANDMARKS);
        for (let i = 0; i < LANDMARKS; i++) lm[i] = { x: r.landmarks[i * 3], y: r.landmarks[i * 3 + 1], z: r.landmarks[i * 3 + 2], visibility: 0 };
        if (fm.mouth) {
          // the mouth-interior patch (mouthImage.ts) from the same pixels, in frame pixels
          const tm = performance.now();
          try {
            const rc = mouthRect(lm, p.frameW, p.frameH);
            if (rc.w >= 16) {
              const img = new Uint8ClampedArray(PATCH * PATCH * 4);
              const sx = rc.w / PATCH, sy = rc.h / PATCH;
              warpToRgba(p, [sx, 0, rc.x, 0, sy, rc.y], PATCH, PATCH, img);
              mouth = analyzeMouth(img, lm, (q) => ({ x: ((q.x * p.frameW - rc.x) / rc.w) * PATCH, y: ((q.y * p.frameH - rc.y) / rc.h) * PATCH }));
            }
          } catch { mouth = null; }
          mouthMs = performance.now() - tm;
        }
        // "My face model": crops from these pixels (landmarks are normalised to the frame the planes describe)
        if (fm.fnet) { try { net = faceNet.step(fm.fnet, lm, p); } catch (err) { net = { skip: String((err as Error)?.message ?? err), ms: 0 }; } }
        face = {
          faceLandmarks: [lm],
          faceBlendshapes: r.blendshapes ? [{ categories: BLENDSHAPE_NAMES.map((n, i) => ({ index: i, score: r.blendshapes![i], categoryName: n, displayName: '' })), headIndex: -1, headName: '' }] : [],
          facialTransformationMatrixes: r.matrix ? [{ rows: 4, columns: 4, data: r.matrix }] : [],
          mouthImage: mouth,
        };
      }
      const ms = performance.now() - t0;
      const tm = graph.timing;
      ctx.postMessage({
        type: 'result', role: 'face', id: fm.id, ms, width: W, height: H, mouthMs, face,
        // where the time went (beta.13.5's FaceSplit): acq = getting the picture (the studio's VideoFrame + the copy of its
        // pixels here: under a game this is where a GPU-backed camera frame would wait), no upload / readback (up, rb = 0),
        // inf = the rest (sampling, models, geometry)
        split: { acq: rnd((fm.acqMs ?? 0) + (t1 - t0)), recv: rnd(recv), up: 0, rb: 0, inf: rnd(Math.max(0, ms - mouthMs - (t1 - t0))) },
        cpu: { copy: rnd(t1 - t0), pre: rnd(tm.pre), det: rnd(tm.det), lm: rnd(tm.lm), bs: rnd(tm.bs), post: rnd(tm.post + (performance.now() - t2) - mouthMs), detected: !!r?.detected, read: readMode, px: p.w * p.h, gl: glStats.contexts + glStats.calls + glStats.gpu },
        gl: glStats.contexts + glStats.calls + glStats.gpu ? { ...glStats } : undefined,
        ...(net ? { net } : {}),
      });
    } else if (m.type === 'stats') {
      ctx.postMessage({ type: 'stats', role: 'face', gl: { ...glStats }, read: readMode });
    }
  } catch (err) {
    try { (m as FrameMsg).bitmap?.close?.(); } catch { /* closed */ }
    ctx.postMessage({ type: 'error', role: 'face', id: (m as FrameMsg).id, message: String((err as Error)?.message ?? err) });
  }
}
