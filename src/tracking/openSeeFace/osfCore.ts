// OpenSeeFace as a low-spec CPU face source: the pure part (no DOM, no onnxruntime import: models are injected as plain
// functions, so tests run it with fakes and the worker runs it on onnxruntime-web's WebAssembly CPU backend).
//
// Derived from OpenSeeFace (https://github.com/emilianavt/OpenSeeFace, tracker.py), BSD 2-Clause:
//   Copyright (c) 2019, Emiliana (https://twitter.com/Emiliana_vt / https://github.com/emilianavt/)
//   All rights reserved. Redistribution and use in source and binary forms, with or without modification, are permitted
//   provided that the conditions of the BSD 2-Clause licence are met (the full text is in THIRD_PARTY_NOTICES.md).
// What is taken from it: the heatmap-regression face detector and landmark models' input / output layout, the decode formula
// (arg-max cell + logit-coded sub-cell offsets), the crop margins, the 66-point 3D reference face (FACE_3D_OSF). Everything
// else (the pose fit, the expression features, the tracker loop, the ExternalTracking mapping) is written here.
//
// Pipeline per camera frame: [detector 224x224 -> face box] (only until a face is held) -> crop around the last landmarks ->
// landmark model (224x224 in, 66 x 3 maps of 28x28 out) -> 66 landmarks -> head pose by a perspective fit of the stable
// points to the reference face -> expression ratios from the landmarks -> an ExternalTracking packet, in the SAME units the
// phone sources use (shared/types.ts ExternalTracking; src/tracking/externalSource.ts header), so ExternalFaceSource turns it
// into a TrackingFrame in exactly FaceSolver's units.
//
// Image coordinates here are the usual ones (x = column, y = row, y down). OpenSeeFace's own arrays are (row, column);
// that swap is undone in decodeLandmarks.
import type { ExternalTracking } from '../../../shared/types.ts';

export const OSF_POINTS = 66;
export const OSF_RES = 224;           // both models take a 224 x 224 RGB picture
export const OSF_OUT = 28;            // landmark maps are 28 x 28 (27 steps + 1)
export const OSF_CHANNELS = 198;      // 66 confidence maps + 66 row offsets + 66 column offsets
const LOGIT_FACTOR = 16;
const IMAGENET_MEAN = [0.485, 0.456, 0.406], IMAGENET_STD = [0.229, 0.224, 0.225];

/** OpenSeeFace's reference face (66 points x, y, z): x + = the performer's RIGHT, y + = up, z + = out of the face. */
export const FACE_3D_OSF = new Float64Array([
  0.45518, 0.3009, -0.76443, 0.449, 0.167, -0.76514, 0.43743, 0.02266, -0.73927, 0.41503, -0.08894, -0.74795,
  0.38912, -0.23238, -0.70479, 0.33463, -0.36127, -0.61559, 0.26373, -0.46001, -0.49148, 0.16242, -0.55804, -0.33945,
  0, -0.62108, -0.28729, -0.16242, -0.55804, -0.33945, -0.26373, -0.46001, -0.49148, -0.33463, -0.36127, -0.61559,
  -0.38912, -0.23238, -0.70479, -0.41503, -0.08894, -0.74795, -0.43743, 0.02266, -0.73927, -0.449, 0.167, -0.76514,
  -0.45518, 0.3009, -0.76443, 0.38553, 0.4028, -0.31003, 0.3222, 0.46444, -0.25056, 0.2541, 0.4642, -0.20818,
  0.18688, 0.44706, -0.1453, 0.12088, 0.42357, -0.11076, -0.12088, 0.42357, -0.11076, -0.18688, 0.44706, -0.1453,
  -0.2541, 0.4642, -0.20818, -0.3222, 0.46444, -0.25056, -0.38553, 0.4028, -0.31003, 0, 0.29333, -0.13758,
  0, 0.19483, -0.06916, 0, 0.10384, -0.00915, 0, 0, 0, 0.08063, -0.04128, -0.13416,
  0.04644, -0.05768, -0.10299, 0, -0.06875, -0.09055, -0.04644, -0.05768, -0.10299, -0.08063, -0.04128, -0.13416,
  0.31591, 0.29834, -0.28511, 0.27525, 0.31272, -0.24456, 0.17639, 0.31191, -0.21921, 0.13123, 0.28445, -0.23424,
  0.18412, 0.26018, -0.22659, 0.27943, 0.26736, -0.24844, -0.13123, 0.28445, -0.23424, -0.17639, 0.31191, -0.21921,
  -0.27525, 0.31272, -0.24456, -0.31591, 0.29834, -0.28511, -0.27943, 0.26736, -0.24844, -0.18412, 0.26018, -0.22659,
  0.12116, -0.20899, -0.16061, 0.04136, -0.19448, -0.09616, 0, -0.20518, -0.0833, -0.04136, -0.19448, -0.09616,
  -0.12116, -0.20899, -0.16061, -0.13233, -0.29086, -0.18707, -0.06414, -0.32538, -0.15892, 0, -0.34374, -0.11393,
  0.06414, -0.32538, -0.15892, 0.13233, -0.29086, -0.18707, 0.18148, -0.24324, -0.23128, 0.084, -0.23972, -0.15526,
  0, -0.25606, -0.09506, -0.084, -0.23972, -0.15526, -0.18148, -0.24324, -0.23128, -0.07404, -0.25069, -0.17735,
  0, -0.26495, -0.11235, 0.07404, -0.25069, -0.17735,
]);
/** The same face in a right-handed frame whose +x is the performer's LEFT (= image right for a face looking at the camera),
 *  +y up, +z out of the face: a face turned to the camera is the identity rotation here. */
export const FACE_3D = (() => { const m = new Float64Array(FACE_3D_OSF); for (let i = 0; i < OSF_POINTS; i++) m[i * 3] = -m[i * 3]; return m; })();
/** One reference-face unit in metres (the face's width is ~0.91 units ~ 15 cm). */
const UNIT_M = 0.165;

// ---- landmark index groups (the iBUG 68 layout minus the two inner mouth corners; checked against FACE_3D_OSF)
export const LM = {
  contour: [0, 1, 2, 3, 13, 14, 15, 16],
  /** points that barely move with the expression: the pose is fitted to these */
  stable: [0, 1, 2, 3, 13, 14, 15, 16, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 39, 42, 45],
  /** eye corners + lids: performer's RIGHT eye = 36..41 (image left), LEFT eye = 42..47 */
  eyeR: { outer: 36, inner: 39, top: [37, 38], bottom: [41, 40] },
  eyeL: { outer: 45, inner: 42, top: [44, 43], bottom: [46, 47] },
  browR: [17, 18, 19, 20, 21], browL: [26, 25, 24, 23, 22],   // outer -> inner
  mouthCornerR: 58, mouthCornerL: 62,
  innerTop: [59, 60, 61], innerBottom: [65, 64, 63],            // paired by position
} as const;

// ================================================================== image -> network input
export interface Rgba { data: Uint8ClampedArray | Uint8Array; w: number; h: number }
export interface Rect { x: number; y: number; w: number; h: number }

/** OpenSeeFace's crop around a face box: 10 % of the width and 12.5 % of the height as margin, clamped to the picture. */
export function cropOf(box: Rect, W: number, H: number): { x1: number; y1: number; x2: number; y2: number } | null {
  const cl = (v: number, hi: number) => Math.max(0, Math.min(hi - 1, v));
  const x1 = Math.trunc(cl(box.x - Math.trunc(box.w * 0.1), W)), y1 = Math.trunc(cl(box.y - Math.trunc(box.h * 0.125), H)) ;
  const x2 = Math.trunc(cl(box.x + box.w + Math.trunc(box.w * 0.1), W)), y2 = Math.trunc(cl(box.y + box.h + Math.trunc(box.h * 0.125), H));
  if (!(x2 - x1 >= 4 && y2 - y1 >= 4)) return null;
  return { x1, y1, x2, y2 };
}

/** Bilinear resample of a region to size x size, RGB, ImageNet-normalised, NCHW float32 (cv2.resize INTER_LINEAR's pixel centres). */
export function sampleCrop(img: Rgba, x1: number, y1: number, x2: number, y2: number, size = OSF_RES, out?: Float32Array): Float32Array {
  const o = out && out.length >= 3 * size * size ? out : new Float32Array(3 * size * size);
  const sx = (x2 - x1) / size, sy = (y2 - y1) / size, plane = size * size, W = img.w, H = img.h, d = img.data;
  const k = [1 / (255 * IMAGENET_STD[0]), 1 / (255 * IMAGENET_STD[1]), 1 / (255 * IMAGENET_STD[2])];
  const b = [-IMAGENET_MEAN[0] / IMAGENET_STD[0], -IMAGENET_MEAN[1] / IMAGENET_STD[1], -IMAGENET_MEAN[2] / IMAGENET_STD[2]];
  for (let j = 0; j < size; j++) {
    const fy = Math.min(H - 1, Math.max(0, y1 + (j + 0.5) * sy - 0.5)), y0 = Math.floor(fy), y1i = Math.min(H - 1, y0 + 1), wy = fy - y0;
    for (let i = 0; i < size; i++) {
      const fx = Math.min(W - 1, Math.max(0, x1 + (i + 0.5) * sx - 0.5)), x0 = Math.floor(fx), x1i = Math.min(W - 1, x0 + 1), wx = fx - x0;
      const p00 = (y0 * W + x0) * 4, p01 = (y0 * W + x1i) * 4, p10 = (y1i * W + x0) * 4, p11 = (y1i * W + x1i) * 4;
      const idx = j * size + i;
      for (let c = 0; c < 3; c++) {
        const v = (d[p00 + c] * (1 - wx) + d[p01 + c] * wx) * (1 - wy) + (d[p10 + c] * (1 - wx) + d[p11 + c] * wx) * wy;
        o[c * plane + idx] = v * k[c] + b[c];
      }
    }
  }
  return o;
}

// ================================================================== detector
export interface FaceBox extends Rect { conf: number }
/**
 * The heatmap detector's two outputs (1 x 2 x 56 x 56 each: confidence + radius, and their 3x3 max-pool) -> the best face
 * box in picture pixels. The detector looked at the whole picture squashed to 224 x 224.
 */
export function decodeDetection(outputs: Float32Array, maxpool: Float32Array, W: number, H: number, threshold = 0.6): FaceBox | null {
  const n = Math.round(Math.sqrt(outputs.length / 2));
  if (n < 4 || n * n * 2 !== outputs.length || maxpool.length < n * n) return null;
  let best = -1, bi = -1;
  for (let i = 0; i < n * n; i++) {
    const c = outputs[i];
    if (c === maxpool[i] && c > best) { best = c; bi = i; }       // a local maximum only
  }
  if (bi < 0 || !(best >= threshold)) return null;
  const y = Math.floor(bi / n), x = bi % n, cell = OSF_RES / n;
  const r = outputs[n * n + bi] * (OSF_RES / 2);
  const bx = x * cell - r, by = y * cell - r, bw = 2 * r;
  if (!(bw > 4)) return null;
  const fx = W / OSF_RES, fy = H / OSF_RES;
  return { x: bx * fx, y: by * fy, w: bw * fx, h: bw * fy, conf: best };
}

// ================================================================== landmarks
const logitOf = (p: number) => { const q = Math.min(0.9999999, Math.max(0.0000001, p)); return Math.log(q / (1 - q)) / LOGIT_FACTOR; };
export interface CropInfo { x1: number; y1: number; x2: number; y2: number }
/** The landmark model's 198 x 28 x 28 output -> 66 x (x, y, confidence) in picture pixels, and the mean confidence. */
export function decodeLandmarks(t: Float32Array, crop: CropInfo, lms?: Float32Array): { lms: Float32Array; conf: number } {
  const cells = OSF_OUT * OSF_OUT;
  if (t.length < OSF_CHANNELS * cells) throw new Error(`landmark model output has ${t.length} values, expected ${OSF_CHANNELS * cells}`);
  const out = lms ?? new Float32Array(OSF_POINTS * 3);
  const res = OSF_RES - 1, outRes = OSF_OUT - 1;
  const sx = (crop.x2 - crop.x1) / OSF_RES, sy = (crop.y2 - crop.y1) / OSF_RES;
  let sum = 0;
  for (let p = 0; p < OSF_POINTS; p++) {
    const o0 = p * cells;
    let m = 0, c = t[o0];
    for (let i = 1; i < cells; i++) if (t[o0 + i] > c) { c = t[o0 + i]; m = i; }
    const offRow = res * logitOf(t[(OSF_POINTS + p) * cells + m]);            // channel block 2: the row offset
    const offCol = res * logitOf(t[(2 * OSF_POINTS + p) * cells + m]);        // channel block 3: the column offset
    const row = crop.y1 + sy * (res * Math.floor(m / OSF_OUT) / outRes + offRow);
    const col = crop.x1 + sx * (res * (m % OSF_OUT) / outRes + offCol);
    out[p * 3] = Number.isFinite(col) ? col : 0; out[p * 3 + 1] = Number.isFinite(row) ? row : 0; out[p * 3 + 2] = Number.isFinite(c) ? c : 0;
    sum += out[p * 3 + 2];
  }
  return { lms: out, conf: sum / OSF_POINTS };
}

/** Tests: the inverse of decodeLandmarks, a network output that decodes to exactly these (x, y) points. */
export function encodeLandmarks(xy: ArrayLike<number>, crop: CropInfo, conf = 0.95): Float32Array {
  const cells = OSF_OUT * OSF_OUT, t = new Float32Array(OSF_CHANNELS * cells).fill(0.01);
  const res = OSF_RES - 1, outRes = OSF_OUT - 1, sx = (crop.x2 - crop.x1) / OSF_RES, sy = (crop.y2 - crop.y1) / OSF_RES;
  const sig = (v: number) => 1 / (1 + Math.exp(-v * LOGIT_FACTOR));
  for (let p = 0; p < OSF_POINTS; p++) {
    const gx = (xy[p * 2] - crop.x1) / sx, gy = (xy[p * 2 + 1] - crop.y1) / sy;        // crop pixels (0..223)
    const cx = Math.min(outRes, Math.max(0, Math.round((gx / res) * outRes))), cy = Math.min(outRes, Math.max(0, Math.round((gy / res) * outRes)));
    const m = cy * OSF_OUT + cx;
    t[p * cells + m] = conf;
    t[(OSF_POINTS + p) * cells + m] = sig((gy - (res * cy) / outRes) / res);
    t[(2 * OSF_POINTS + p) * cells + m] = sig((gx - (res * cx) / outRes) / res);
  }
  return t;
}

// ================================================================== head pose
type V3 = [number, number, number];
type M3 = [number, number, number, number, number, number, number, number, number];
const mul = (a: M3, b: M3): M3 => [
  a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
  a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
  a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8]];
function expSo3(w: V3): M3 {
  const th = Math.hypot(w[0], w[1], w[2]);
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const x = w[0] / th, y = w[1] / th, z = w[2] / th, c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}
/** Euler angles of a head rotation R (identity = facing the camera), three.js 'YXZ' order (the order FaceSolver decomposes in). */
export function eulerYXZ(m: M3): { x: number; y: number; z: number } {
  const x = Math.asin(-Math.max(-1, Math.min(1, m[5])));
  if (Math.abs(m[5]) < 0.9999999) return { x, y: Math.atan2(m[2], m[8]), z: Math.atan2(m[3], m[4]) };
  return { x, y: Math.atan2(-m[6], m[0]), z: 0 };
}
/** Tests: R = Ry(yaw) Rx(pitch) Rz(roll). */
export function composeYXZ(x: number, y: number, z: number): M3 {
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  const Ry: M3 = [cy, 0, sy, 0, 1, 0, -sy, 0, cy], Rx: M3 = [1, 0, 0, 0, cx, -sx, 0, sx, cx], Rz: M3 = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return mul(mul(Ry, Rx), Rz);
}
/** The picture is seen from the camera (x right, y DOWN, z forward); a head turned to it is the identity head rotation. */
const A_FLIP = [1, -1, -1] as const;

export interface Pose { R: M3; t: V3; rms: number; scale: number }
/**
 * Perspective-n-point by Levenberg-Marquardt on the stable landmarks: the head rotation R (identity = facing the camera) and
 * the translation t (camera frame, metres per model unit = 1) that put FACE_3D where the landmarks are, for a pinhole camera
 * with focal length f = picture width and the principal point at the centre (OpenSeeFace's assumption too). `prev` seeds
 * the next frame's fit. rms = reprojection error in pixels.
 */
export function fitPose(lms: ArrayLike<number>, W: number, H: number, prev?: { R: M3; t: V3 }): Pose | null {
  const idx = LM.stable, n = idx.length, f = W, cx = W / 2, cy = H / 2;
  const obs = new Float64Array(n * 2), mdl = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) { const p = idx[i]; obs[i * 2] = lms[p * 3]; obs[i * 2 + 1] = lms[p * 3 + 1]; mdl[i * 3] = FACE_3D[p * 3]; mdl[i * 3 + 1] = FACE_3D[p * 3 + 1]; mdl[i * 3 + 2] = FACE_3D[p * 3 + 2]; }
  // seed: facing the camera, depth from the face width, centred on the points
  let R: M3 = prev?.R ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let t: V3;
  if (prev) t = [...prev.t] as V3;
  else {
    let minx = Infinity, maxx = -Infinity, ox = 0, oy = 0, mx = 0, my = 0;
    for (let i = 0; i < n; i++) { minx = Math.min(minx, obs[i * 2]); maxx = Math.max(maxx, obs[i * 2]); ox += obs[i * 2]; oy += obs[i * 2 + 1]; mx += mdl[i * 3]; my += mdl[i * 3 + 1]; }
    const wpx = maxx - minx;
    if (!(wpx > 8)) return null;
    const z0 = (f * 0.91) / wpx;
    t = [((ox / n - cx) * z0) / f - mx / n, ((oy / n - cy) * z0) / f + my / n, z0];
  }
  const project = (Rm: M3, tv: V3, out: Float64Array) => {
    let e = 0;
    for (let i = 0; i < n; i++) {
      const X = mdl[i * 3], Y = mdl[i * 3 + 1], Z = mdl[i * 3 + 2];
      const wx = Rm[0] * X + Rm[1] * Y + Rm[2] * Z, wy = Rm[3] * X + Rm[4] * Y + Rm[5] * Z, wz = Rm[6] * X + Rm[7] * Y + Rm[8] * Z;
      const xc = A_FLIP[0] * wx + tv[0], yc = A_FLIP[1] * wy + tv[1], zc = Math.max(0.05, A_FLIP[2] * wz + tv[2]);
      const u = (f * xc) / zc + cx, v = (f * yc) / zc + cy;
      out[i * 2] = u - obs[i * 2]; out[i * 2 + 1] = v - obs[i * 2 + 1];
      e += out[i * 2] ** 2 + out[i * 2 + 1] ** 2;
    }
    return e;
  };
  const r0 = new Float64Array(n * 2), r1 = new Float64Array(n * 2), J = new Float64Array(n * 2 * 6);
  let cost = project(R, t, r0), lambda = 1e-3;
  for (let it = 0; it < 25; it++) {
    // numeric Jacobian (rotation increments on the left, translation additive)
    const eps = 1e-5;
    for (let k = 0; k < 6; k++) {
      let R2 = R; const t2: V3 = [...t] as V3;
      if (k < 3) { const w: V3 = [0, 0, 0]; w[k] = eps; R2 = mul(expSo3(w), R); } else t2[k - 3] += eps;
      project(R2, t2, r1);
      for (let i = 0; i < n * 2; i++) J[i * 6 + k] = (r1[i] - r0[i]) / eps;
    }
    const H6 = new Float64Array(36), g = new Float64Array(6);
    for (let i = 0; i < n * 2; i++) for (let a = 0; a < 6; a++) { g[a] += J[i * 6 + a] * r0[i]; for (let b = 0; b < 6; b++) H6[a * 6 + b] += J[i * 6 + a] * J[i * 6 + b]; }
    let improved = false;
    for (let tries = 0; tries < 6 && !improved; tries++) {
      const A = new Float64Array(H6); for (let a = 0; a < 6; a++) A[a * 7] += lambda * (H6[a * 7] + 1e-9);
      const d = solve6(A, g);
      if (!d) { lambda *= 10; continue; }
      const R2 = mul(expSo3([-d[0], -d[1], -d[2]]), R), t2: V3 = [t[0] - d[3], t[1] - d[4], t[2] - d[5]];
      const c2 = project(R2, t2, r1);
      if (c2 < cost) { R = R2; t = t2; cost = c2; r0.set(r1); lambda = Math.max(1e-7, lambda / 4); improved = true; if (Math.hypot(d[0], d[1], d[2], d[3], d[4], d[5]) < 1e-7) it = 99; }
      else lambda *= 8;
    }
    if (!improved) break;
  }
  const rms = Math.sqrt(cost / n);
  if (!Number.isFinite(rms) || t[2] <= 0.05) return null;
  return { R, t, rms, scale: t[2] };
}
function solve6(Ain: Float64Array, b: Float64Array): Float64Array | null {
  const A = new Float64Array(Ain), x = new Float64Array(b);
  for (let c = 0; c < 6; c++) {
    let p = c;
    for (let r = c + 1; r < 6; r++) if (Math.abs(A[r * 6 + c]) > Math.abs(A[p * 6 + c])) p = r;
    if (Math.abs(A[p * 6 + c]) < 1e-14) return null;
    if (p !== c) { for (let k = 0; k < 6; k++) { const tmp = A[c * 6 + k]; A[c * 6 + k] = A[p * 6 + k]; A[p * 6 + k] = tmp; } const tb = x[c]; x[c] = x[p]; x[p] = tb; }
    for (let r = c + 1; r < 6; r++) { const m = A[r * 6 + c] / A[c * 6 + c]; for (let k = c; k < 6; k++) A[r * 6 + k] -= m * A[c * 6 + k]; x[r] -= m * x[c]; }
  }
  for (let r = 5; r >= 0; r--) { let s = x[r]; for (let k = r + 1; k < 6; k++) s -= A[r * 6 + k] * x[k]; x[r] = s / A[r * 6 + r]; }
  return x;
}

/** Head rotation in ExternalTracking's units: degrees [pitch (+ down), yaw (+ performer's left), roll (+ tilt to the performer's left)]. */
export function headDegrees(R: M3): V3 {
  const e = eulerYXZ(R), D = 180 / Math.PI;
  // yaw about +y (x = the performer's left): + turns the nose toward the performer's left; pitch about +x: + nods down;
  // roll about +z: + tips the top of the head to the performer's RIGHT, so the "tilt left" value is its negative
  return [e.x * D, e.y * D, -e.z * D];
}

// ================================================================== expression features (ARKit-named, 0..1)
const dist = (l: ArrayLike<number>, a: number, b: number) => Math.hypot(l[a * 3] - l[b * 3], l[a * 3 + 1] - l[b * 3 + 1]);
const yOf = (l: ArrayLike<number>, a: number) => l[a * 3 + 1];

/** The raw expression ratios of one set of landmarks, all in units of the eye-corner distance (face scale). */
export interface Ratios { earR: number; earL: number; gap: number; width: number; liftR: number; liftL: number; browR: number; browL: number; browInnerR: number; browInnerL: number }
export function ratios(l: ArrayLike<number>): Ratios {
  const s = dist(l, LM.eyeR.outer, LM.eyeL.outer) || 1;
  const ear = (e: typeof LM.eyeR | typeof LM.eyeL) => (dist(l, e.top[0], e.bottom[0]) + dist(l, e.top[1], e.bottom[1])) / (2 * dist(l, e.outer, e.inner) || 1);
  let gap = 0;
  for (let i = 0; i < 3; i++) gap += dist(l, LM.innerTop[i], LM.innerBottom[i]);
  const midY = (yOf(l, 60) + yOf(l, 64)) / 2;
  const eyeTopY = (e: typeof LM.eyeR | typeof LM.eyeL) => (yOf(l, e.top[0]) + yOf(l, e.top[1])) / 2;
  const browY = (b: readonly number[]) => b.reduce((a, p) => a + yOf(l, p), 0) / b.length;
  return {
    earR: ear(LM.eyeR), earL: ear(LM.eyeL), gap: gap / 3 / s, width: dist(l, LM.mouthCornerR, LM.mouthCornerL) / s,
    liftR: (midY - yOf(l, LM.mouthCornerR)) / s, liftL: (midY - yOf(l, LM.mouthCornerL)) / s,
    browR: (eyeTopY(LM.eyeR) - browY(LM.browR)) / s, browL: (eyeTopY(LM.eyeL) - browY(LM.browL)) / s,
    browInnerR: (eyeTopY(LM.eyeR) - yOf(l, 21)) / s, browInnerL: (eyeTopY(LM.eyeL) - yOf(l, 22)) / s,
  };
}
/** The reference face seen from the front is the neutral expression: its ratios are the zero point. */
export const NEUTRAL: Ratios = (() => {
  const l = new Float64Array(OSF_POINTS * 3);
  for (let i = 0; i < OSF_POINTS; i++) { l[i * 3] = FACE_3D[i * 3]; l[i * 3 + 1] = -FACE_3D[i * 3 + 1]; }   // image: x right, y down
  return ratios(l);
})();

/**
 * The landmarks as seen from the front: each picture point is put back on the fitted reference face's surface depth and turned
 * by the inverse head rotation, so yaw, pitch, roll and the camera's perspective cancel out and the expression ratios below read
 * the same whichever way the head points. Output points are (x right, y DOWN, confidence) in model units, like the reference
 * face seen from the front (which is therefore exactly neutral).
 */
export function frontalLandmarks(l: ArrayLike<number>, pose: Pose, W: number, H: number, out = new Float32Array(OSF_POINTS * 3)): Float32Array {
  const R = pose.R, t = pose.t, f = W, cx = W / 2, cy = H / 2;
  for (let i = 0; i < OSF_POINTS; i++) {
    const X = FACE_3D[i * 3], Y = FACE_3D[i * 3 + 1], Z = FACE_3D[i * 3 + 2];
    const wz = R[6] * X + R[7] * Y + R[8] * Z;
    const zc = Math.max(0.05, -wz + t[2]);                       // the surface depth the reference face has at this point
    const xc = ((l[i * 3] - cx) * zc) / f, yc = ((l[i * 3 + 1] - cy) * zc) / f;
    const wx = xc - t[0], wy = -(yc - t[1]), wzz = -(zc - t[2]);  // camera -> head-turned world (the flip is its own inverse)
    out[i * 3] = R[0] * wx + R[3] * wy + R[6] * wzz;               // R^T
    out[i * 3 + 1] = -(R[1] * wx + R[4] * wy + R[7] * wzz);        // model y is up, the ratios want y down
    out[i * 3 + 2] = l[i * 3 + 2];
  }
  return out;
}

const c01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Adaptive "eyes wide open" levels (the slowly decaying high-water mark of the eye aspect ratio), one per face. */
export class FeatureState {
  openR = NEUTRAL.earR; openL = NEUTRAL.earL;
  update(r: Ratios) {
    const up = (cur: number, v: number) => (v > cur ? cur + 0.3 * (v - cur) : cur + 0.006 * (v - cur));
    this.openR = Math.max(0.12, up(this.openR, r.earR)); this.openL = Math.max(0.12, up(this.openL, r.earL));
  }
}
/**
 * ARKit-named blendshapes from the landmark ratios: both eyes' blink and wide, jaw open, mouth close, smile / frown per side,
 * pucker, stretch, brows up / down / inner up. 17 of the 52: a 2D landmark tracker does not see the rest (cheeks, tongue, the
 * fine mouth shapes) and no gaze: those stay at rest.
 */
export function blendshapes(r: Ratios, st: FeatureState): Record<string, number> {
  st.update(r);
  const N = NEUTRAL;
  const blink = (ear: number, open: number) => c01((open - ear) / (open * 0.6));
  const wide = (ear: number, open: number) => c01((ear - open) / (open * 0.35));
  const jaw = c01((r.gap - N.gap) / 0.5);
  const pucker = c01((N.width - r.width) / (N.width * 0.4)), stretch = c01((r.width - N.width) / (N.width * 0.35));
  const up = (v: number, v0: number) => c01((v - v0) / 0.12), down = (v: number, v0: number) => c01((v0 - v) / 0.08);
  return {
    eyeBlinkRight: blink(r.earR, st.openR), eyeBlinkLeft: blink(r.earL, st.openL),
    eyeWideRight: wide(r.earR, st.openR), eyeWideLeft: wide(r.earL, st.openL),
    jawOpen: jaw,
    mouthSmileRight: c01((r.liftR - N.liftR) / 0.12), mouthSmileLeft: c01((r.liftL - N.liftL) / 0.12),
    mouthFrownRight: c01((N.liftR - r.liftR) / 0.08), mouthFrownLeft: c01((N.liftL - r.liftL) / 0.08),
    mouthPucker: pucker, mouthStretchRight: stretch, mouthStretchLeft: stretch,
    browOuterUpRight: up(r.browR, N.browR), browOuterUpLeft: up(r.browL, N.browL),
    browDownRight: down(r.browR, N.browR), browDownLeft: down(r.browL, N.browL),
    browInnerUp: Math.max(up(r.browInnerR, N.browInnerR), up(r.browInnerL, N.browInnerL)),
  };
}

// ================================================================== the tracker loop
/** Two plain functions: the detector (224x224 picture in; its two outputs) and the landmark model (224x224 in; 198x28x28 out). */
export interface OsfModels {
  detect(input: Float32Array): Promise<[Float32Array, Float32Array]>;
  landmarks(input: Float32Array): Promise<Float32Array>;
}
export interface OsfTiming { det: number; lm: number; post: number }
export interface OsfOptions { threshold?: number; detectThreshold?: number; lostFrames?: number; now?: () => number }

export class OsfTracker {
  private box: Rect | null = null;
  private lost = 0;
  private prevPose: { R: M3; t: V3 } | null = null;
  private feat = new FeatureState();
  private inBuf = new Float32Array(3 * OSF_RES * OSF_RES);
  private lmBuf = new Float32Array(OSF_POINTS * 3);
  private upBuf = new Float32Array(OSF_POINTS * 3);
  /** diagnostics / tests: the crop and landmarks of the last frame, and where the time went */
  lastCrop: CropInfo | null = null;
  lastLandmarks: Float32Array | null = null;
  lastDetected = false;
  timing: OsfTiming = { det: 0, lm: 0, post: 0 };
  /** the pose fit's reprojection error of the last frame (pixels) */
  lastRms = 0;
  readonly threshold: number; readonly detectThreshold: number; readonly lostFrames: number;
  private now: () => number;

  constructor(private models: OsfModels, o: OsfOptions = {}) {
    this.threshold = o.threshold ?? 0.6; this.detectThreshold = o.detectThreshold ?? 0.6; this.lostFrames = o.lostFrames ?? 3;
    this.now = o.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  }
  reset() { this.box = null; this.lost = 0; this.prevPose = null; this.feat = new FeatureState(); }

  /** One camera picture -> one ExternalTracking (found: false when no face is held). */
  async process(img: Rgba): Promise<ExternalTracking> {
    const t0 = this.now();
    let det = 0;
    this.lastDetected = false;
    if (!this.box) {
      const full = sampleCrop(img, 0, 0, img.w, img.h, OSF_RES, this.inBuf);   // the whole picture, squashed
      const [o, mp] = await this.models.detect(full);
      const b = decodeDetection(o, mp, img.w, img.h, this.detectThreshold);
      det = this.now() - t0;
      if (b) { this.box = b; this.lastDetected = true; }
    }
    this.timing = { det, lm: 0, post: 0 };
    if (!this.box) return this.none();
    const crop = cropOf(this.box, img.w, img.h);
    if (!crop) { this.box = null; return this.none(); }
    this.lastCrop = crop;
    const input = sampleCrop(img, crop.x1, crop.y1, crop.x2, crop.y2, OSF_RES, this.inBuf);
    const t1 = this.now();
    const out = await this.models.landmarks(input);
    const t2 = this.now();
    const { lms, conf } = decodeLandmarks(out, crop, this.lmBuf);
    this.timing.lm = t2 - t1;
    if (!(conf > this.threshold)) {
      if (++this.lost >= this.lostFrames) { this.box = null; this.lost = 0; this.prevPose = null; }
      return this.none();
    }
    this.lost = 0;
    this.lastLandmarks = lms;
    // the next crop follows the landmarks
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < OSF_POINTS; i++) { x0 = Math.min(x0, lms[i * 3]); x1 = Math.max(x1, lms[i * 3]); y0 = Math.min(y0, lms[i * 3 + 1]); y1 = Math.max(y1, lms[i * 3 + 1]); }
    this.box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    // pose
    const pose = fitPose(lms, img.w, img.h, this.prevPose ?? undefined) ?? fitPose(lms, img.w, img.h);
    const faceW = Math.max(1, x1 - x0);
    this.lastRms = pose?.rms ?? 0;
    if (!pose || pose.rms > 0.06 * faceW) { this.prevPose = null; this.timing.post = this.now() - t2; return this.none(); }
    this.prevPose = { R: pose.R, t: pose.t };
    const head = headDegrees(pose.R);
    // the expression ratios are read on the face turned back to the camera (pose and perspective cancel out)
    const bs = blendshapes(ratios(frontalLandmarks(lms, pose, img.w, img.h, this.upBuf)), this.feat);
    this.timing.post = this.now() - t2;
    const d: ExternalTracking = {
      source: 'openseeface', t: Date.now() / 1000, found: true, blendshapes: bs, head,
      // metres: x + the performer's left (image right), y up, z toward the camera
      headPos: [pose.t[0] * UNIT_M, -pose.t[1] * UNIT_M, -pose.t[2] * UNIT_M],
    };
    return d;
  }
  private none(): ExternalTracking { return { source: 'openseeface', t: Date.now() / 1000, found: false }; }
}
