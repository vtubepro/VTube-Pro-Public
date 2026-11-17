/// <reference lib="webworker" />
// Tracking worker. One instance per role so face, body and hands run IN PARALLEL in their own contexts,
// off the main thread (rendering never waits on inference):
//   role 'face' — FaceLandmarker on a zoomed full-resolution ROI around the face
//   role 'body' — PoseLandmarker (+ the GestureRecognizer when the studio asks for it: with Body off it is the
//                 hands' worker, and on the 'low' preset it runs both on the same frames, the hand model skipped on a
//                 frame that says runHands: false; otherwise the hands have their own worker and never wait for the pose)
//   role 'hands' — GestureRecognizer only (hands + gesture labels, same model and options), so the hands run at
//                 their own rate (up to 30 Hz) instead of after the pose model on every body frame
//   role 'objects' — (opt-in food & drink feature) EfficientDet-Lite0 object detector on a crop around the
//                 hands, a few times a second. CPU delegate on its OWN thread: ~70 ms per look would stall
//                 the body worker's hand tracking, and on the GPU it would compete with the face model.
// Frames arrive as transferred ImageBitmaps; results go back as plain structured-clone objects.

import './noTelemetry.ts'; // MediaPipe's usage logger never phones home
import {
  FaceLandmarker, FilesetResolver, GestureRecognizer, ObjectDetector, PoseLandmarker,
  type FaceLandmarkerResult, type NormalizedLandmark,
} from '@mediapipe/tasks-vision';
import { PATCH, analyzeMouth, mouthRect, type MouthPatchStats } from './mouthImage.ts';
// "My face model" (faceNet/runtime.ts, docs/FACE_MODEL.md): opt-in; a frame message without `fnet` bits costs nothing here
import { FaceNetRuntime, type FaceNetOut } from './faceNet/runtime.ts';
import type { PlaneReader } from './faceNet/crops.ts';
import { DETECT_CLASSES } from './snacks.ts';

// Where a face run's time goes (beta.13.5, the "split" in each face result; research/tracking_gpu_rca/RCA.md P0): MediaPipe
// tasks-vision 1.0.1 uploads every input with texImage2D and, on the processor (CPU delegate), reads it back with one
// blocking readPixels — on a graphics card a foreground game holds, that readback is where the run waits. Both calls are
// timed around the browser's own WebGL methods (two clock reads per call; the GPU delegate makes ~2700 WebGL calls a run
// but only these two kinds are wrapped). tools/mp_gl_probe.mjs counts every call.
const glMs = { up: 0, rb: 0 };
for (const Ctx of [(self as unknown as { WebGL2RenderingContext?: { prototype: Record<string, unknown> } }).WebGL2RenderingContext,
  (self as unknown as { WebGLRenderingContext?: { prototype: Record<string, unknown> } }).WebGLRenderingContext]) {
  if (!Ctx) continue;
  for (const [k, key] of [['texImage2D', 'up'], ['readPixels', 'rb']] as const) {
    const f = Ctx.prototype[k] as ((...a: unknown[]) => unknown) | undefined;
    if (typeof f !== 'function') continue;
    Ctx.prototype[k] = function (this: unknown, ...a: unknown[]) { const t = performance.now(); try { return f.apply(this, a); } finally { glMs[key] += performance.now() - t; } };
  }
}

const DETECT_SET = new Set(DETECT_CLASSES);

/** Mean RGB of the central half of each box (bitmap pixel coords), from a ≤ 64 px downscale. */
let colCanvas: OffscreenCanvas | null = null;
function boxColours(bmp: ImageBitmap, boxes: { originX: number; originY: number; width: number; height: number }[]): ([number, number, number] | undefined)[] {
  try {
    const k = Math.min(1, 64 / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    if (!colCanvas) colCanvas = new OffscreenCanvas(w, h);
    if (colCanvas.width !== w || colCanvas.height !== h) { colCanvas.width = w; colCanvas.height = h; }
    const c2 = colCanvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
    if (!c2) return boxes.map(() => undefined);
    c2.drawImage(bmp, 0, 0, w, h);
    const px = c2.getImageData(0, 0, w, h).data;
    return boxes.map((b) => {
      const x0 = Math.max(0, Math.floor((b.originX + b.width * 0.25) * k)), x1 = Math.min(w, Math.ceil((b.originX + b.width * 0.75) * k));
      const y0 = Math.max(0, Math.floor((b.originY + b.height * 0.25) * k)), y1 = Math.min(h, Math.ceil((b.originY + b.height * 0.75) * k));
      let R = 0, G = 0, B = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * w + x) * 4; R += px[i]; G += px[i + 1]; B += px[i + 2]; n++; }
      return n ? [Math.round(R / n), Math.round(G / n), Math.round(B / n)] as [number, number, number] : undefined;
    });
  } catch { return boxes.map(() => undefined); }
}

type Role = 'face' | 'body' | 'hands' | 'objects';
type Tier = 'low' | 'medium' | 'high' | 'ultra';
interface InitMsg {
  type: 'init'; role: Role; base: string; tier: Tier; body: boolean; hands: boolean;
  /** where to run (default GPU; a GPU that fails to start falls back to the CPU). */
  delegate?: 'GPU' | 'CPU';
  /** warm-up input sizes (the first inference on a size compiles / allocates); default 320 x 240. */
  warm?: [number, number][];
}
interface FrameMsg {
  type: 'frame'; bitmap: ImageBitmap; ts: number; id: number; roi?: Roi | null; fullW?: number; fullH?: number;
  /** face role: also analyse the mouth interior (tongue / teeth / cavity). */
  mouth?: boolean;
  /** body role: optional zoomed crop around the hands (full-res pixels) + where it came from, in video px.
   *  hands role: `bitmap` itself is that crop when handRoi is set (else the whole frame, scaled). */
  handBitmap?: ImageBitmap; handRoi?: HandRoi | null;
  /** body role with the hand model loaded: false = skip it on this frame (the hands are not due: idle back-off / rate
   *  cap, or a hands worker is taking over). Absent = run every loaded model. */
  runHands?: boolean;
  /** objects role: also return a JPEG of the input (diagnostics), at most this many px wide. */
  snap?: number;
  /** face role (beta.13.5 split): epoch ms (performance.timeOrigin + now) the studio posted the frame, and how long its
   *  picture (createImageBitmap crop) took there. */
  postT?: number; acqMs?: number;
  /** face role, "My face model": 1 = run the net on this frame's crops, 2 = hand the crops back (a teach session). Absent = neither. */
  fnet?: number;
}
interface ConfigMsg { type: 'config'; tier: Tier; body: boolean; hands: boolean; roi?: boolean }
/** Tests only (tools/gamefps_e2e.mjs via Tracker.testSlowFace): every face run of THIS worker takes this much longer, as a
 *  run waiting on a graphics card a game holds would. Never sent outside tests. */
interface TestDelayMsg { type: 'testDelay'; ms: number; rb?: boolean }
let testDelayMs = 0;
/** ... counted as readback (the split's rb), as a run that waits on the graphics queue next to a game does. */
let testDelayRb = false;
/** "My face model": the model JSON the studio wants this face worker to hold (null = none). */
interface FaceNetMsg { type: 'facenet'; model: string | null }
const faceNet = new FaceNetRuntime();

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let role: Role = 'face';
let fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
let base = '';
let delegate: 'GPU' | 'CPU' = 'GPU';
/** Why this worker runs on the CPU although the GPU was asked for ('' = it doesn't): reported with 'ready' / 'configured'. */
let fallback = '';
let face: FaceLandmarker | null = null;
let pose: PoseLandmarker | null = null;
let poseModel = '';
let hands: GestureRecognizer | null = null;
let objects: ObjectDetector | null = null;
let lastTs = 0;

const POSE_MODEL: Record<Tier, string> = { low: 'lite', medium: 'lite', high: 'full', ultra: 'full' };
/** The pose model for a tier, on either delegate: the quality preset decides (lite on low / medium, full on high / ultra),
 *  never where it runs. (Lite on the CPU would save ~15 ms a frame, 31 vs 46, but arms track a little less precisely:
 *  a move to the CPU, or a GPU that fails to start, must not change how the body tracks.) */
const poseFor = (tier: Tier, _d: 'GPU' | 'CPU') => POSE_MODEL[tier];

// MediaPipe clears self.ModuleFactory after each task is created, and in a module worker the loader is
// an ES module that only runs once (import cache) — so a 2nd task (pose, then hands) would fail with
// "ModuleFactory not set". Keep the factory and put it back before every create.
let moduleFactory: unknown = null;
const g = self as unknown as { ModuleFactory?: unknown };

async function create<T>(make: (d: 'GPU' | 'CPU', canvas?: OffscreenCanvas) => Promise<T>): Promise<T> {
  if (moduleFactory) g.ModuleFactory = moduleFactory;
  if (delegate === 'GPU') {
    try { return await make('GPU', new OffscreenCanvas(1, 1)); } catch (e) {
      if (moduleFactory) g.ModuleFactory = moduleFactory; console.warn('[track worker] GPU delegate failed, using CPU', e); delegate = 'CPU';
      fallback = `GPU failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`; }
  }
  return make('CPU');
}

/** What the studio wants this body worker to run (Hands / Body switches): set the moment a message arrives, so a
 *  frame never runs a model that was just switched off, even while a configure is still loading another one. */
const want = { tier: 'high' as Tier, body: false, hands: false };
let cfgChain: Promise<void> = Promise.resolve();
/** Configure calls run one after another, each for the newest wish (switches flipped quickly end as the last flip). */
function queueConfigure(tier: Tier, wantBody: boolean, wantHands: boolean): Promise<void> {
  want.tier = tier; want.body = wantBody; want.hands = wantHands;
  const run = cfgChain.then(() => configure(want.tier, want.body, want.hands));
  cfgChain = run.catch(() => {});
  return run;
}
const loaded = () => ({ body: !!pose, hands: !!hands });

async function configure(tier: Tier, wantBody: boolean, wantHands: boolean) {
  if ((role !== 'body' && role !== 'hands') || !fileset) return;
  if (role === 'hands') wantBody = false; // the hands' worker never runs the pose model
  if (wantBody && (!pose || poseModel !== poseFor(tier, delegate))) {
    pose?.close(); pose = null; poseModel = '';
    let pm = '';
    const p = await create((d, canvas) => {
      pm = poseFor(tier, d); // (a GPU that fails to start lands on the CPU, with the same model)
      return PoseLandmarker.createFromOptions(fileset!, {
        baseOptions: { modelAssetPath: `${base}/pose_landmarker_${pm}.task`, delegate: d }, canvas,
        runningMode: 'VIDEO', numPoses: 1, minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      });
    });
    if (want.body && poseFor(want.tier, delegate) === pm && !pose) { pose = p; poseModel = pm; } else p.close();
  } else if (!wantBody && pose) { pose.close(); pose = null; poseModel = ''; }
  if (wantHands && !hands) {
    const h = await create((d, canvas) => GestureRecognizer.createFromOptions(fileset!, {
      baseOptions: { modelAssetPath: `${base}/gesture_recognizer.task`, delegate: d }, canvas,
      // detection stays strict (no phantom hands); presence/tracking a bit looser so fast or blurred
      // hands keep tracking instead of dropping out and re-detecting (which costs a frame or two)
      runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.4,
    }));
    if (want.hands && !hands) hands = h; else h.close();
  } else if (!wantHands && hands) { hands.close(); hands = null; }
}

// ---- zoomed face ROI: the main thread crops the face region out of the full-resolution frame on the
// GPU (createImageBitmap with a source rect + resize) and tells us where it came from.
type Roi = { x: number; y: number; s: number };
type HandRoi = { x: number; y: number; w: number; h: number };
let netCtx: OffscreenCanvasRenderingContext2D | null = null;
/** "My face model": pixels on demand from the crop bitmap. The three crop windows' boxes (about a quarter of a face-sized bitmap together) are
 *  drawn one at a time into ONE small canvas that is only ever grown (compositing 'copy', so no clearing), and read back from there. */
function bitmapReader(bmp: ImageBitmap): PlaneReader {
  return {
    frameW: bmp.width, frameH: bmp.height,
    read(x0, y0, x1, y1) {
      const w = x1 - x0, h = y1 - y0;
      if (!netCtx || netCtx.canvas.width < w || netCtx.canvas.height < h) {
        // (256 x 192 covers an eye or mouth window of a face-filling crop; it only ever grows, in steps of 64)
        netCtx = new OffscreenCanvas(Math.max(256, Math.ceil(w / 64) * 64, netCtx?.canvas.width ?? 0), Math.max(192, Math.ceil(h / 64) * 64, netCtx?.canvas.height ?? 0)).getContext('2d', { willReadFrequently: true });
        if (netCtx) netCtx.globalCompositeOperation = 'copy';
      }
      if (!netCtx) throw new Error('no 2D canvas');
      netCtx.drawImage(bmp, x0, y0, w, h, 0, 0, w, h);
      const img = netCtx.getImageData(0, 0, w, h);
      return { format: 'RGBA', frameW: bmp.width, frameH: bmp.height, x0, y0, w, h, data: new Uint8Array(img.data.buffer), layout: [{ offset: 0, stride: w * 4 }] };
    },
  };
}
function detectFace(bmp: ImageBitmap, ts: number, roi: Roi | null, W: number, H: number, wantMouth: boolean, fnet = 0): { r: FaceLandmarkerResult; mouth: MouthPatchStats | null; mouthMs: number; net: FaceNetOut | null } {
  const r = face!.detectForVideo(bmp, ts);
  // mouth-interior patch (tongue / teeth / cavity / visibility) on the same crop, before the landmarks are remapped, and
  // posted WITH them: the face solver pairs a patch's lip colour with the lip gap / hand cover of the same frame
  // (posting the patch after the landmarks paired it with the next frame's in 57-97 % of reads, for ~1 ms of latency)
  let mouth: MouthPatchStats | null = null, mouthMs = 0;
  if (wantMouth && r.faceLandmarks[0]) {
    const t1 = performance.now();
    try { mouth = mouthPatch(bmp, r.faceLandmarks[0]); } catch { mouth = null; }
    mouthMs = performance.now() - t1;
  }
  // "My face model": crops from the same pixels the landmarks came from, before they are remapped to the full camera frame
  let net: FaceNetOut | null = null;
  if (fnet && r.faceLandmarks[0]) {
    try { net = faceNet.step(fnet, r.faceLandmarks[0], bitmapReader(bmp)); } catch (err) { net = { skip: String((err as Error)?.message ?? err), ms: 0 }; }
  }
  if (roi) for (const lm of r.faceLandmarks) for (const p of lm) { p.x = (roi.x + p.x * roi.s) / W; p.y = (roi.y + p.y * roi.s) / H; p.z = (p.z * roi.s) / W; }
  return { r, mouth, mouthMs, net };
}

let patchCtx: OffscreenCanvasRenderingContext2D | null = null;
function mouthPatch(bmp: ImageBitmap, lm: NormalizedLandmark[]): MouthPatchStats | null {
  const bw = bmp.width, bh = bmp.height;
  const rc = mouthRect(lm, bw, bh);
  if (rc.w < 16) return null; // mouth too small in the image to judge
  patchCtx ??= new OffscreenCanvas(PATCH, PATCH).getContext('2d', { willReadFrequently: true });
  if (!patchCtx) return null;
  patchCtx.drawImage(bmp, rc.x, rc.y, rc.w, rc.h, 0, 0, PATCH, PATCH);
  const img = patchCtx.getImageData(0, 0, PATCH, PATCH).data;
  return analyzeMouth(img, lm, (p) => ({ x: ((p.x * bw - rc.x) / rc.w) * PATCH, y: ((p.y * bh - rc.y) / rc.h) * PATCH }));
}

ctx.onmessage = async (e: MessageEvent<InitMsg | FrameMsg | ConfigMsg | TestDelayMsg | FaceNetMsg>) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      role = m.role; base = m.base;
      if (m.delegate) delegate = m.delegate;
      fileset = await FilesetResolver.forVisionTasks(`${base}/wasm`, true);
      moduleFactory = ((await import(/* @vite-ignore */ fileset.wasmLoaderPath)) as { default: unknown }).default;
      if (role === 'face') {
        face = await create((d, canvas) => FaceLandmarker.createFromOptions(fileset!, {
          baseOptions: { modelAssetPath: `${base}/face_landmarker.task`, delegate: d }, canvas,
          runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
          minFaceDetectionConfidence: 0.4, minFacePresenceConfidence: 0.4, minTrackingConfidence: 0.4,
        }));
      } else if (role === 'objects') {
        g.ModuleFactory = moduleFactory;
        objects = await ObjectDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: `${base}/efficientdet_lite0.tflite`, delegate: 'CPU' },
          // no class allowlist: the model's own (class-agnostic) NMS gives every box ONE label anyway, so
          // the allowlist only hid what a cup was mistaken for ('person' / 'cell phone' / 'toilet' …) —
          // the snack logic filters classes itself, and diagnostics want the full picture
          runningMode: 'IMAGE', scoreThreshold: 0.1, maxResults: 25,
        });
        delegate = 'CPU';
      } else await queueConfigure(m.tier, m.body, m.hands);
      // warm-up: the first GPU inference compiles shaders (and each new input size allocates), so a worker that
      // replaces a running one is ready to serve at full speed the moment it says 'ready'
      lastTs = performance.now();
      for (const [ww, hh] of m.warm?.length ? m.warm : [[320, 240] as [number, number]]) {
        const warm = new OffscreenCanvas(ww, hh);
        warm.getContext('2d')!.fillRect(0, 0, ww, hh);
        lastTs += 1;
        face?.detectForVideo(warm, lastTs);
        pose?.detectForVideo(warm, lastTs);
        hands?.recognizeForVideo(warm, lastTs);
        objects?.detect(warm);
      }
      ctx.postMessage({ type: 'ready', role, delegate, ...(role === 'body' || role === 'hands' ? { models: loaded() } : {}), ...(fallback ? { fallback } : {}) });
    } else if (m.type === 'facenet') {
      faceNet.setModel((m as FaceNetMsg).model);
    } else if (m.type === 'testDelay') {
      testDelayMs = Math.max(0, Math.min(5000, m.ms || 0)); testDelayRb = !!m.rb;
    } else if (m.type === 'config') {
      await queueConfigure(m.tier, m.body, m.hands);
      // (delegate: a model loaded by this configure may have fallen back to the CPU)
      ctx.postMessage({ type: 'configured', role, models: loaded(), delegate, ...(fallback ? { fallback } : {}) });
    } else if (m.type === 'frame') {
      const ts = Math.max(Math.round(m.ts), lastTs + 1);
      lastTs = ts;
      const t0 = performance.now();
      const bmp = m.bitmap;
      if (role === 'objects') {
        // boxes → full-frame normalized coords (the bitmap is a crop at `handRoi`, or the whole frame)
        const W = m.fullW ?? bmp.width, H = m.fullH ?? bmp.height, r = m.handRoi ?? { x: 0, y: 0, w: W, h: H };
        const sx = r.w / bmp.width, sy = r.h / bmp.height;
        let jpg: Promise<Blob> | null = null;
        if (m.snap) {
          const k = Math.min(1, m.snap / bmp.width);
          const cv = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * k)), Math.max(1, Math.round(bmp.height * k)));
          cv.getContext('2d')!.drawImage(bmp, 0, 0, cv.width, cv.height);
          jpg = cv.convertToBlob({ type: 'image/jpeg', quality: 0.62 });
        }
        const all = objects ? objects.detect(bmp).detections.flatMap((d) => {
          const b = d.boundingBox, c = d.categories[0];
          return b && c ? [{ cls: c.categoryName, score: c.score, x: (r.x + b.originX * sx) / W, y: (r.y + b.originY * sy) / H, w: (b.width * sx) / W, h: (b.height * sy) / H, px: b }] : [];
        }) : [];
        const dets: { cls: string; score: number; x: number; y: number; w: number; h: number; rgb?: [number, number, number] }[] = [];
        const keep = all.filter((d) => d.score >= 0.12 && DETECT_SET.has(d.cls)).slice(0, 10);
        // mean colour of the middle of each food / drink box (mug vs paper cup vs can): one tiny downscale
        const cols = keep.length ? boxColours(bmp, keep.map((d) => d.px)) : [];
        keep.forEach((d, i) => dets.push({ cls: d.cls, score: d.score, x: d.x, y: d.y, w: d.w, h: d.h, rgb: cols[i] }));
        bmp.close();
        const ms = performance.now() - t0;
        const raw = all.slice(0, 20).map((d) => ({ cls: d.cls, score: d.score, x: d.x, y: d.y, w: d.w, h: d.h }));
        const blob = jpg ? await jpg.catch(() => null) : null;
        ctx.postMessage({ type: 'objects', role, id: m.id, ms, dets, raw, jpg: blob });
      } else if (role === 'face' && face) {
        const W = m.fullW ?? bmp.width, H = m.fullH ?? bmp.height;
        // (split: the hop from the studio, MediaPipe's upload / readback, the rest = the model; see glMs above)
        const recv = m.postT ? Math.max(0, performance.timeOrigin + t0 - m.postT) : 0;
        glMs.up = glMs.rb = 0;
        let testRb = 0;
        if (testDelayMs) { const t1 = performance.now(); while (performance.now() - t1 < testDelayMs) { /* tests: a starved run */ } if (testDelayRb) testRb = performance.now() - t1; }
        const { r, mouth, mouthMs, net } = detectFace(bmp, ts, m.roi ?? null, W, H, !!m.mouth, m.fnet ?? 0);
        glMs.rb += testRb;
        bmp.close();
        const run = performance.now() - t0;
        ctx.postMessage({
          type: 'result', role, id: m.id, ms: run, width: W, height: H, mouthMs,
          split: { acq: +(m.acqMs ?? 0).toFixed(2), recv: +recv.toFixed(2), up: +glMs.up.toFixed(2), rb: +glMs.rb.toFixed(2), inf: +Math.max(0, run - mouthMs - glMs.up - glMs.rb).toFixed(2) },
          face: r.faceLandmarks.length ? { faceLandmarks: r.faceLandmarks, faceBlendshapes: r.faceBlendshapes, facialTransformationMatrixes: r.facialTransformationMatrixes, mouthImage: mouth } : null,
          ...(net ? { net } : {}),
        });
      } else if (role === 'hands') {
        // the hand model alone: the whole frame (scaled), or the zoomed crop at handRoi (landmarks mapped back)
        const hnd = hands && want.hands ? hands.recognizeForVideo(bmp, ts) : null;
        const hr = m.handRoi;
        if (hnd && hr) {
          const W = m.fullW ?? bmp.width, H = m.fullH ?? bmp.height;
          for (const lm of hnd.landmarks) for (const q of lm) { q.x = (hr.x + q.x * hr.w) / W; q.y = (hr.y + q.y * hr.h) / H; q.z = (q.z * hr.w) / W; }
        }
        bmp.close();
        const ms = performance.now() - t0;
        ctx.postMessage({
          type: 'result', role, id: m.id, ms, handsMs: hnd ? ms : null,
          hands: hnd?.landmarks?.length ? { landmarks: hnd.landmarks, worldLandmarks: hnd.worldLandmarks, handedness: hnd.handedness, handednesses: hnd.handedness, gestures: hnd.gestures } : null,
        });
      } else {
        // (only the models the switches want: one being closed / still arriving never runs)
        const runPose = !!pose && want.body, runHands = !!hands && want.hands && m.runHands !== false;
        const p = runPose ? pose!.detectForVideo(bmp, ts) : null;
        const t1 = performance.now();
        // hands run on the zoomed hand crop when the main thread sent one (sharper fingers, better
        // detection of small/far hands); landmarks are mapped back to full-frame normalized coords
        const hb = m.handBitmap ?? bmp;
        const hnd = runHands ? hands!.recognizeForVideo(hb, ts) : null;
        const t2 = performance.now();
        const hr = m.handBitmap ? m.handRoi : null;
        if (hnd && hr) {
          const W = m.fullW ?? bmp.width, H = m.fullH ?? bmp.height;
          for (const lm of hnd.landmarks) for (const q of lm) { q.x = (hr.x + q.x * hr.w) / W; q.y = (hr.y + q.y * hr.h) / H; q.z = (q.z * hr.w) / W; }
        }
        bmp.close();
        m.handBitmap?.close();
        ctx.postMessage({
          // per model: ms of each (null = that model did not run on this frame)
          type: 'result', role, id: m.id, ms: performance.now() - t0, poseMs: runPose ? t1 - t0 : null, handsMs: runHands ? t2 - t1 : null,
          pose: p?.worldLandmarks?.length ? { landmarks: p.landmarks, worldLandmarks: p.worldLandmarks } : null,
          hands: hnd?.landmarks?.length ? { landmarks: hnd.landmarks, worldLandmarks: hnd.worldLandmarks, handedness: hnd.handedness, handednesses: hnd.handedness, gestures: hnd.gestures } : null,
        });
      }
    }
  } catch (err) {
    // a frame whose run threw skipped its close() calls: close its bitmaps here (a no-op on one already closed), else every
    // failing frame (a lost graphics context fails each one) leaves a GPU-backed picture until the next garbage collection
    if (m.type === 'frame') {
      try { m.bitmap?.close(); } catch { /* closed */ }
      try { m.handBitmap?.close(); } catch { /* closed */ }
    }
    ctx.postMessage({ type: 'error', role, message: String((err as Error)?.message ?? err) });
  }
};
