// Portions ported from MediaPipe: Copyright 2023 The MediaPipe Authors, Apache License 2.0 (THIRD_PARTY_NOTICES.md).
// MediaPipe's FaceLandmarker graph (VIDEO mode, one face), on the CPU: a port of face_landmarker_graph.cc,
// face_detector_graph.cc, face_landmarks_detector_graph.cc, face_blendshapes_graph.cc and the calculators they use
// (SsdAnchors, TensorsToDetections, weighted NMS, DetectionsToRects, RectTransformation, TensorsToLandmarks,
// LandmarkProjection, LandmarksSmoothing (one-euro), LandmarksToTensor), Apache-2.0. The three models run through a
// `Runner` (the worker uses onnxruntime-web's WebAssembly backend; tests can use anything), the pixels come from
// imageOps.ts. Nothing here touches a canvas, WebGL or the DOM: it runs in a worker or in Node.
//
// Output = what tasks-vision's FaceLandmarker returns (478 landmarks normalized to the frame, 52 blendshape scores, the
// 4x4 facial transformation matrix), so the face solver and everything after it run unchanged.

import { faceTransform, type GeometryMeta } from './geometry.ts';
import { rectToAffine, warpToTensor, type Affine, type Planes } from './imageOps.ts';

/** Runs one model on a float32 input (NCHW for images) and returns its outputs in model order. */
export type Runner = (input: Float32Array) => Promise<Float32Array[]>;

export interface NormRect { xc: number; yc: number; w: number; h: number; rot: number }

export const BLENDSHAPE_NAMES = ['_neutral', 'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'cheekPuff',
  'cheekSquintLeft', 'cheekSquintRight', 'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookInRight',
  'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight', 'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawOpen', 'jawRight', 'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthFrownLeft', 'mouthFrownRight',
  'mouthFunnel', 'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthPressLeft', 'mouthPressRight', 'mouthPucker', 'mouthRight',
  'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper', 'mouthSmileLeft', 'mouthSmileRight', 'mouthStretchLeft',
  'mouthStretchRight', 'mouthUpperUpLeft', 'mouthUpperUpRight', 'noseSneerLeft', 'noseSneerRight'] as const;

/** face_blendshapes_graph.cc kLandmarksSubsetIdxs */
export const BLENDSHAPE_SUBSET = [0, 1, 4, 5, 6, 7, 8, 10, 13, 14, 17, 21, 33, 37, 39, 40, 46, 52, 53, 54, 55, 58, 61, 63, 65, 66, 67, 70, 78, 80,
  81, 82, 84, 87, 88, 91, 93, 95, 103, 105, 107, 109, 127, 132, 133, 136, 144, 145, 146, 148, 149, 150, 152, 153, 154, 155, 157, 158, 159, 160,
  161, 162, 163, 168, 172, 173, 176, 178, 181, 185, 191, 195, 197, 234, 246, 249, 251, 263, 267, 269, 270, 276, 282, 283, 284, 285, 288, 291, 293, 295,
  296, 297, 300, 308, 310, 311, 312, 314, 317, 318, 321, 323, 324, 332, 334, 336, 338, 356, 361, 362, 365, 373, 374, 375, 377, 378, 379, 380, 381, 382,
  384, 385, 386, 387, 388, 389, 390, 397, 398, 400, 402, 405, 409, 415, 454, 466, 468, 469, 470, 471, 472, 473, 474, 475, 476, 477];

export const LANDMARKS = 478;
const DET_SIZE = 128, LM_SIZE = 256;

// ---- detector (BlazeFace short range): SSD anchors (num_layers 4, strides 8/16/16/16, offset 0.5, fixed size, one
//      aspect ratio + one interpolated scale = 2 anchors per cell) ----
function ssdAnchors(): Float32Array {
  const strides = [8, 16, 16, 16];
  const out: number[] = [];
  let layer = 0;
  while (layer < strides.length) {
    let last = layer, n = 0;
    while (last < strides.length && strides[last] === strides[layer]) { n += 2; last++; }
    const fm = Math.ceil(DET_SIZE / strides[layer]);
    for (let y = 0; y < fm; y++) for (let x = 0; x < fm; x++) for (let k = 0; k < n; k++) out.push((x + 0.5) / fm, (y + 0.5) / fm);
    layer = last;
  }
  return Float32Array.from(out);
}
const ANCHORS = ssdAnchors(); // 896 x (xc, yc)

const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));
const normRad = (a: number) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));

interface Det { xmin: number; ymin: number; w: number; h: number; score: number; kp: number[] }

/** TensorsToDetections (reverse_output_order: x, y, w, h; 6 keypoints; scale 128; sigmoid, clip 100) + weighted NMS
 *  (IoU 0.3): the highest-scoring merged detection, in tensor-normalized coords (null = none over `minScore`). */
export function decodeBestFace(boxes: Float32Array, scores: Float32Array, minScore: number): Det | null {
  const cand: { i: number; s: number }[] = [];
  for (let i = 0; i < 896; i++) {
    const s = sigmoid(Math.max(-100, Math.min(100, scores[i])));
    if (s >= minScore) cand.push({ i, s });
  }
  if (!cand.length) return null;
  cand.sort((a, b) => b.s - a.s);
  const box = (i: number) => {
    const o = i * 16, ax = ANCHORS[i * 2], ay = ANCHORS[i * 2 + 1];
    const xc = (boxes[o] / DET_SIZE) + ax, yc = (boxes[o + 1] / DET_SIZE) + ay, w = boxes[o + 2] / DET_SIZE, h = boxes[o + 3] / DET_SIZE;
    const kp: number[] = [];
    for (let k = 0; k < 6; k++) kp.push(boxes[o + 4 + k * 2] / DET_SIZE + ax, boxes[o + 5 + k * 2] / DET_SIZE + ay);
    return { xmin: xc - w / 2, ymin: yc - h / 2, w, h, kp };
  };
  const top = box(cand[0].i);
  const iou = (a: { xmin: number; ymin: number; w: number; h: number }, b: typeof a) => {
    const ix = Math.max(0, Math.min(a.xmin + a.w, b.xmin + b.w) - Math.max(a.xmin, b.xmin));
    const iy = Math.max(0, Math.min(a.ymin + a.h, b.ymin + b.h) - Math.max(a.ymin, b.ymin));
    const inter = ix * iy, uni = a.w * a.h + b.w * b.h - inter;
    return uni > 0 ? inter / uni : 0;
  };
  // the first weighted-NMS cluster: every candidate overlapping the top box by more than 0.3, score-weighted
  let tw = 0, x0 = 0, y0 = 0, x1 = 0, y1 = 0;
  const kp = new Array(12).fill(0);
  for (const c of cand) {
    const b = box(c.i);
    if (iou(top, b) <= 0.3) continue;
    tw += c.s; x0 += b.xmin * c.s; y0 += b.ymin * c.s; x1 += (b.xmin + b.w) * c.s; y1 += (b.ymin + b.h) * c.s;
    for (let k = 0; k < 12; k++) kp[k] += b.kp[k] * c.s;
  }
  return { xmin: x0 / tw, ymin: y0 / tw, w: (x1 - x0) / tw, h: (y1 - y0) / tw, score: cand[0].s, kp: kp.map((v) => v / tw) };
}

// ---- one-euro landmark smoothing (LandmarksSmoothingCalculator: min_cutoff 0.05, beta 80, derivate_cutoff 1, value
//      scale 1 / object size in pixels; reset when the face is lost or the frame size changes) ----
class OneEuro {
  private x = 0; private raw = 0; private dx = 0; private init = false; private dInit = false;
  private last = -1; private freq = 30;
  constructor(private minCut: number, private beta: number, private dCut: number) {}
  private alpha(cut: number) { const te = 1 / this.freq, tau = 1 / (2 * Math.PI * cut); return 1 / (1 + tau / te); }
  apply(tNs: number, v: number, scale: number): number {
    if (this.last >= tNs) return v;
    if (this.last !== 0 && tNs !== 0) this.freq = 1 / ((tNs - this.last) * 1e-9);
    this.last = tNs;
    const dv = this.init ? (v - this.raw) * scale * this.freq : 0;
    const ad = this.alpha(this.dCut);
    this.dx = this.dInit ? ad * dv + (1 - ad) * this.dx : dv;
    this.dInit = true;
    const cut = this.minCut + this.beta * Math.abs(this.dx);
    const a = this.alpha(cut);
    this.x = this.init ? a * v + (1 - a) * this.x : v;
    this.raw = v; this.init = true;
    return this.x;
  }
}

export class LandmarkSmoother {
  private f: OneEuro[] = [];
  private size = '';
  reset() { this.f = []; }
  /** lm: normalized x, y, z per landmark (z in x units), in place. */
  apply(lm: Float32Array, tMs: number, W: number, H: number) {
    const key = `${W}x${H}`;
    if (key !== this.size) { this.size = key; this.f = []; }
    const n = lm.length / 3;
    if (!this.f.length) for (let i = 0; i < n * 3; i++) this.f.push(new OneEuro(0.05, 80, 1));
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) { const x = lm[i * 3] * W, y = lm[i * 3 + 1] * H; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const obj = (x1 - x0 + (y1 - y0)) / 2;
    if (!(obj >= 1e-6)) return;
    const scale = 1 / obj, tNs = Math.round(tMs * 1e6);
    for (let i = 0; i < n; i++) {
      lm[i * 3] = this.f[i * 3].apply(tNs, lm[i * 3] * W, scale) / W;
      lm[i * 3 + 1] = this.f[i * 3 + 1].apply(tNs, lm[i * 3 + 1] * H, scale) / H;
      lm[i * 3 + 2] = this.f[i * 3 + 2].apply(tNs, lm[i * 3 + 2] * W, scale) / W;
    }
  }
}

/** DetectionsToRects (bounding box, rotation from keypoint a -> b, target 0) + RectTransformation (scale, square_long). */
function rectFrom(xmin: number, ymin: number, w: number, h: number, ax: number, ay: number, bx: number, by: number, W: number, H: number, scale: number, squareLong: boolean): NormRect {
  const rot = normRad(0 - Math.atan2(-(by * H - ay * H), bx * W - ax * W));
  let rw = w, rh = h;
  if (squareLong) { const long = Math.max(w * W, h * H); rw = long / W; rh = long / H; }
  return { xc: xmin + w / 2, yc: ymin + h / 2, w: rw * scale, h: rh * scale, rot };
}

/** The next frame's face rect from this frame's (unsmoothed) landmarks: bbox, eyes 33 -> 263, x1.5, square. */
export function rectFromLandmarks(lm: Float32Array, W: number, H: number): NormRect {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < lm.length / 3; i++) { const x = lm[i * 3], y = lm[i * 3 + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return rectFrom(x0, y0, x1 - x0, y1 - y0, lm[33 * 3], lm[33 * 3 + 1], lm[263 * 3], lm[263 * 3 + 1], W, H, 1.5, true);
}

export interface FaceGraphOptions {
  /** minFaceDetectionConfidence (the app: 0.4) */
  minDetection: number;
  /** minFacePresenceConfidence (0.4) */
  minPresence: number;
  blendshapes: boolean;
  matrix: boolean;
  /** tests (port parity with tasks-vision's IMAGE mode): the detector on every frame, no smoothing, the matrix in the
   *  frame itself instead of the studio's virtual face crop */
  imageMode?: boolean;
}

export interface FaceGraphResult {
  /** 478 x (x, y, z), normalized to the frame (smoothed: what tasks-vision returns) */
  landmarks: Float32Array;
  /** 52 scores in BLENDSHAPE_NAMES order (null = off) */
  blendshapes: Float32Array | null;
  /** 4x4 column-major (null = off / degenerate) */
  matrix: number[] | null;
  presence: number;
  /** the detector ran on this frame */
  detected: boolean;
}

export interface FaceGraphTiming { pre: number; det: number; lm: number; bs: number; post: number }

/**
 * The face tracker state machine. `process` is called once per frame with increasing timestamps (ms); it runs the
 * detector only while no face is tracked (VIDEO mode: the previous frame's landmarks give this frame's face rect).
 */
export class FaceGraph {
  private prev: NormRect | null = null;
  /** where the face was when it was lost: the next detector looks get a zoomed square around it first (the full frame
   *  letterboxed to 128 px leaves a small face ~20 px tall; the app's GPU path re-detects inside its face crop too) */
  private lostNear: NormRect | null = null;
  private lostLooks = 0;
  private smooth = new LandmarkSmoother();
  private detIn = new Float32Array(3 * DET_SIZE * DET_SIZE);
  private lmIn = new Float32Array(3 * LM_SIZE * LM_SIZE);
  private bsIn = new Float32Array(146 * 2);
  timing: FaceGraphTiming = { pre: 0, det: 0, lm: 0, bs: 0, post: 0 };

  constructor(private run: { detector: Runner; landmarks: Runner; blendshapes: Runner }, private geo: GeometryMeta | null, public opts: FaceGraphOptions) {}

  /** The rect the next frame will be read in (pixels needed), or null when the detector must look at the whole frame. */
  get nextRect(): NormRect | null { return this.opts.imageMode ? null : this.prev; }

  reset() { this.prev = null; this.lostNear = null; this.lostLooks = 0; this.smooth.reset(); }

  private async detect(p: Planes, near: NormRect | null): Promise<NormRect | null> {
    const W = p.frameW, H = p.frameH;
    const t0 = performance.now();
    // the detector's view: the whole frame letterboxed (keep_aspect_ratio, BORDER_ZERO), or a square around `near`
    let cx: number, cy: number, side: number;
    if (near) { cx = near.xc * W; cy = near.yc * H; side = Math.max(near.w * W, near.h * H) * 1.6; }
    else { cx = W / 2; cy = H / 2; side = Math.max(W, H); }
    const M = rectToAffine(cx, cy, side, side, 0, DET_SIZE, DET_SIZE);
    warpToTensor(p, M, DET_SIZE, DET_SIZE, this.detIn, 2 / 255, -1, 'zero');
    const t1 = performance.now();
    const [boxes, scores] = await this.run.detector(this.detIn);
    const t2 = performance.now();
    this.timing.pre += t1 - t0; this.timing.det += t2 - t1;
    const d = decodeBestFace(boxes, scores, this.opts.minDetection);
    if (!d) return null;
    // tensor-normalized -> frame-normalized (DetectionProjection with the letterbox matrix)
    const toX = (x: number) => (cx + (x - 0.5) * side) / W, toY = (y: number) => (cy + (y - 0.5) * side) / H;
    const xmin = toX(d.xmin), ymin = toY(d.ymin), w = (d.w * side) / W, h = (d.h * side) / H;
    return rectFrom(xmin, ymin, w, h, toX(d.kp[0]), toY(d.kp[1]), toX(d.kp[2]), toY(d.kp[3]), W, H, 1.5, false);
  }

  async process(p: Planes, tMs: number): Promise<FaceGraphResult | null> {
    const W = p.frameW, H = p.frameH;
    this.timing = { pre: 0, det: 0, lm: 0, bs: 0, post: 0 };
    let rect = this.opts.imageMode ? null : this.prev, detected = false;
    if (!rect) {
      detected = true;
      // (around where the face was lost first, then the whole frame)
      if (this.lostNear && this.lostLooks > 0 && !this.opts.imageMode) { this.lostLooks--; rect = await this.detect(p, this.lostNear); }
      if (!rect) rect = await this.detect(p, null);
      if (!rect) { this.smooth.reset(); return null; }
    }
    // landmarks: the rotated rect -> 256 x 256, [0, 1], border replicate
    const t0 = performance.now();
    const M: Affine = rectToAffine(rect.xc * W, rect.yc * H, rect.w * W, rect.h * H, rect.rot, LM_SIZE, LM_SIZE);
    warpToTensor(p, M, LM_SIZE, LM_SIZE, this.lmIn, 1 / 255, 0, 'replicate');
    const t1 = performance.now();
    const [raw, flag] = await this.run.landmarks(this.lmIn);
    const t2 = performance.now();
    this.timing.pre += t1 - t0; this.timing.lm += t2 - t1;
    const presence = sigmoid(flag[0]);
    if (presence < this.opts.minPresence) {
      if (this.prev) { this.lostNear = this.prev; this.lostLooks = 3; }
      this.prev = null; this.smooth.reset();
      return null;
    }
    const lm = projectLandmarks(raw, rect, W, H, !!this.opts.imageMode);
    this.prev = rectFromLandmarks(lm, W, H);
    this.lostNear = null;
    // smoothing (what the graph outputs and what blendshapes + geometry use)
    if (!this.opts.imageMode) this.smooth.apply(lm, tMs, W, H);
    let bs: Float32Array | null = null;
    if (this.opts.blendshapes) {
      for (let k = 0; k < 146; k++) { const i = BLENDSHAPE_SUBSET[k]; this.bsIn[k * 2] = lm[i * 3] * W; this.bsIn[k * 2 + 1] = lm[i * 3 + 1] * H; }
      const t3 = performance.now();
      bs = (await this.run.blendshapes(this.bsIn))[0];
      this.timing.bs += performance.now() - t3;
    }
    const t4 = performance.now();
    const matrix = !this.opts.matrix || !this.geo ? null : this.opts.imageMode ? frameMatrix(this.geo, lm, W, H) : faceMatrix(this.geo, lm, W, H);
    this.timing.post += performance.now() - t4;
    return { landmarks: lm, blendshapes: bs, matrix, presence, detected };
  }
}

/**
 * TensorsToLandmarks (/ 256) + LandmarkProjection: tensor landmarks of the rotated face rect -> frame-normalized x, y
 * (GetRotatedSubRectToRectTransformMatrix, as MediaPipe projects with image dimensions) and z in frame-width units.
 * z = z / 256 x the rect's width in frame widths: the studio's GPU path gets exactly that (MediaPipe on its square crop,
 * then p.z x crop / frame width), and it does not change with head roll. MediaPipe on a whole NON-square frame scales z
 * by the length of the projected unit x vector instead (hypot(m0, m4)), which grows with roll there: `imageMode` (the
 * port-parity check against tasks-vision on whole frames) keeps that.
 */
export function projectLandmarks(raw: ArrayLike<number>, rect: NormRect, W: number, H: number, imageMode = false): Float32Array {
  const a = rect.w * W, b = rect.h * H, c = Math.cos(rect.rot), d = Math.sin(rect.rot), e = rect.xc * W, f = rect.yc * H;
  const m0 = (a * c) / W, m1 = (-b * d) / W, m3 = (-0.5 * a * c + 0.5 * b * d + e) / W;
  const m4 = (a * d) / H, m5 = (b * c) / H, m7 = (-0.5 * b * c - 0.5 * a * d + f) / H;
  const zs = imageMode ? Math.hypot(m0, m4) : a / W;
  const lm = new Float32Array(LANDMARKS * 3);
  for (let i = 0; i < LANDMARKS; i++) {
    const x = raw[i * 3] / LM_SIZE, y = raw[i * 3 + 1] / LM_SIZE, z = raw[i * 3 + 2] / LM_SIZE;
    lm[i * 3] = m0 * x + m1 * y + m3;
    lm[i * 3 + 1] = m4 * x + m5 * y + m7;
    lm[i * 3 + 2] = z * zs;
  }
  return lm;
}

/** The facial transformation matrix in the frame itself (tasks-vision on a whole frame). */
export function frameMatrix(geo: GeometryMeta, lm: Float32Array, W: number, H: number): number[] | null {
  const m = faceTransform(geo, lm.subarray(0, geo.weights.length * 3), W, H);
  return m ? Array.from(m) : null;
}

/**
 * The facial transformation matrix in the frame the GPU path computes it in: tasks-vision there sees the studio's square
 * face crop (Tracker.updateRoi: 1.7 x the landmarks' box, at least 96 px, at most the frame's short side, kept inside
 * the frame, resized to 512 px), and its 63° virtual camera looks at that crop. The same crop here (without the
 * studio's hysteresis and motion lead) keeps head rotations, and the calibrations made with them, the same whether the
 * face runs on the graphics card or on this tracker (a big face near the frame's edge: ~2° of pitch otherwise).
 */
export function faceMatrix(geo: GeometryMeta, lm: Float32Array, W: number, H: number): number[] | null {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < LANDMARKS; i++) { const x = lm[i * 3] * W, y = lm[i * 3 + 1] * H; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const s = Math.min(Math.max(Math.max(x1 - x0, y1 - y0) * 1.7, 96), Math.min(W, H));
  if (!(s > 1)) return null;
  const ox = Math.min(Math.max((x0 + x1) / 2 - s / 2, 0), W - s), oy = Math.min(Math.max((y0 + y1) / 2 - s / 2, 0), H - s);
  const n = geo.weights.length;
  const crop = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    crop[i * 3] = (lm[i * 3] * W - ox) / s;
    crop[i * 3 + 1] = (lm[i * 3 + 1] * H - oy) / s;
    crop[i * 3 + 2] = (lm[i * 3 + 2] * W) / s;
  }
  const m = faceTransform(geo, crop, 512, 512);
  return m ? Array.from(m) : null;
}
