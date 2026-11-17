// Small, allocation-light linear algebra for multi-camera face capture (no three.js: the tracking harnesses run it
// in Node, and the fusion runs once per face frame). Conventions:
//   • camera frames are COMPUTER-VISION style: x right, y DOWN, z forward (into the scene), metres
//   • image points are NORMALISED pinhole coords (x/z, y/z), made from pixels with the camera's intrinsics
//   • a pose {R, t} maps a point from frame A into frame B: X_B = R·X_A + t   (R row-major 3×3)
//   • MediaPipe's facial transformation matrix is OpenGL style (y up, z toward the viewer): see glToCv().

export type V3 = [number, number, number];
/** Row-major 3×3. */
export type M3 = [number, number, number, number, number, number, number, number, number];
export interface Pose { R: M3; t: V3 }

export const I3 = (): M3 => [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const v3 = (x = 0, y = 0, z = 0): V3 => [x, y, z];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: V3): V3 => { const n = norm(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };

export function mulMV(R: M3, v: V3): V3 {
  return [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
}
export function mulMtV(R: M3, v: V3): V3 {
  return [R[0] * v[0] + R[3] * v[1] + R[6] * v[2], R[1] * v[0] + R[4] * v[1] + R[7] * v[2], R[2] * v[0] + R[5] * v[1] + R[8] * v[2]];
}
export function mulMM(A: M3, B: M3): M3 {
  const o = new Array(9) as M3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
  return o;
}
export const transpose = (R: M3): M3 => [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
export const apply = (p: Pose, X: V3): V3 => add(mulMV(p.R, X), p.t);
export const compose = (b: Pose, a: Pose): Pose => ({ R: mulMM(b.R, a.R), t: add(mulMV(b.R, a.t), b.t) }); // b∘a
export const invert = (p: Pose): Pose => { const Rt = transpose(p.R); return { R: Rt, t: scale(mulMV(Rt, p.t), -1) }; };

/** Rotation vector (axis·angle) → matrix (Rodrigues). */
export function expSO3(w: V3): M3 {
  const th = norm(w);
  if (th < 1e-12) return [1, -w[2], w[1], w[2], 1, -w[0], -w[1], w[0], 1];
  const k = scale(w, 1 / th), c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  const [x, y, z] = k;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}
/** Matrix → rotation vector. */
export function logSO3(R: M3): V3 {
  const c = Math.min(1, Math.max(-1, (R[0] + R[4] + R[8] - 1) / 2));
  const th = Math.acos(c);
  if (th < 1e-9) return [(R[7] - R[5]) / 2, (R[2] - R[6]) / 2, (R[3] - R[1]) / 2];
  if (Math.PI - th < 1e-6) {
    // near 180°: axis from the diagonal
    const x = Math.sqrt(Math.max(0, (R[0] + 1) / 2)), y = Math.sqrt(Math.max(0, (R[4] + 1) / 2)), z = Math.sqrt(Math.max(0, (R[8] + 1) / 2));
    const ax: V3 = [x, R[1] >= 0 ? y : -y, R[2] >= 0 ? z : -z];
    return scale(normalize(ax), th);
  }
  const k = th / (2 * Math.sin(th));
  return [(R[7] - R[5]) * k, (R[2] - R[6]) * k, (R[3] - R[1]) * k];
}
/** Angle between two rotations (radians). */
export const rotAngle = (A: M3, B: M3) => norm(logSO3(mulMM(transpose(A), B)));

/** Quaternion [x, y, z, w] ↔ matrix. */
export function quatFromM(R: M3): [number, number, number, number] {
  const tr = R[0] + R[4] + R[8];
  let x: number, y: number, z: number, w: number;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = 0.25 * s; x = (R[7] - R[5]) / s; y = (R[2] - R[6]) / s; z = (R[3] - R[1]) / s; }
  else if (R[0] > R[4] && R[0] > R[8]) { const s = Math.sqrt(1 + R[0] - R[4] - R[8]) * 2; w = (R[7] - R[5]) / s; x = 0.25 * s; y = (R[1] + R[3]) / s; z = (R[2] + R[6]) / s; }
  else if (R[4] > R[8]) { const s = Math.sqrt(1 + R[4] - R[0] - R[8]) * 2; w = (R[2] - R[6]) / s; x = (R[1] + R[3]) / s; y = 0.25 * s; z = (R[5] + R[7]) / s; }
  else { const s = Math.sqrt(1 + R[8] - R[0] - R[4]) * 2; w = (R[3] - R[1]) / s; x = (R[2] + R[6]) / s; y = (R[5] + R[7]) / s; z = 0.25 * s; }
  return [x, y, z, w];
}
export function mFromQuat(q: [number, number, number, number]): M3 {
  const [x, y, z, w] = q, n = Math.hypot(x, y, z, w) || 1;
  const X = x / n, Y = y / n, Z = z / n, W = w / n;
  return [1 - 2 * (Y * Y + Z * Z), 2 * (X * Y - Z * W), 2 * (X * Z + Y * W), 2 * (X * Y + Z * W), 1 - 2 * (X * X + Z * Z), 2 * (Y * Z - X * W), 2 * (X * Z - Y * W), 2 * (Y * Z + X * W), 1 - 2 * (X * X + Y * Y)];
}

/** Weighted rotation average (Markley: principal eigenvector of Σ w q qᵀ) — robust to the q/−q sign ambiguity. */
export function averageRotations(Rs: M3[], w?: number[]): M3 {
  if (!Rs.length) return I3();
  if (Rs.length === 1) return [...Rs[0]] as M3;
  const A = new Float64Array(16);
  Rs.forEach((R, i) => { const q = quatFromM(R), k = w ? w[i] : 1; for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) A[a * 4 + b] += k * q[a] * q[b]; });
  const { vectors } = eigSym(A, 4);
  return mFromQuat([vectors[0], vectors[4], vectors[8], vectors[12]] as [number, number, number, number]);
}

/** Robust rotation average: L2 mean, then re-weighted by a Cauchy kernel on the residual angle (a few passes). */
export function robustAverageRotations(Rs: M3[], c = 0.05, passes = 4): { R: M3; spread: number } {
  let R = averageRotations(Rs);
  let res: number[] = [];
  for (let p = 0; p < passes; p++) {
    res = Rs.map((x) => rotAngle(R, x));
    R = averageRotations(Rs, res.map((r) => 1 / (1 + (r / c) ** 2)));
  }
  res = Rs.map((x) => rotAngle(R, x)).sort((a, b) => a - b);
  return { R, spread: res[Math.floor(res.length / 2)] ?? 0 };
}

/**
 * Symmetric eigen-decomposition (cyclic Jacobi), n ≤ ~8. Returns eigenvalues DESCENDING and eigenvectors as the
 * COLUMNS of a row-major n×n array (column k ↔ values[k]).
 */
export function eigSym(Ain: ArrayLike<number>, n: number): { values: number[]; vectors: number[] } {
  const A = Array.from(Ain);
  const V = new Array(n * n).fill(0);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i * n + j] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const apq = A[p * n + q];
      if (Math.abs(apq) < 1e-300) continue;
      const th = (A[q * n + q] - A[p * n + p]) / (2 * apq);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) {
        const akp = A[k * n + p], akq = A[k * n + q];
        A[k * n + p] = c * akp - s * akq; A[k * n + q] = s * akp + c * akq;
      }
      for (let k = 0; k < n; k++) {
        const apk = A[p * n + k], aqk = A[q * n + k];
        A[p * n + k] = c * apk - s * aqk; A[q * n + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < n; k++) {
        const vkp = V[k * n + p], vkq = V[k * n + q];
        V[k * n + p] = c * vkp - s * vkq; V[k * n + q] = s * vkp + c * vkq;
      }
    }
  }
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => A[b * n + b] - A[a * n + a]);
  const values = idx.map((i) => A[i * n + i]);
  const vectors = new Array(n * n);
  for (let r = 0; r < n; r++) idx.forEach((c, k) => { vectors[r * n + k] = V[r * n + c]; });
  return { values, vectors };
}

/** Solve a small dense system (Gaussian elimination, partial pivoting). Returns null when singular. */
export function solve(Ain: ArrayLike<number>, bin: ArrayLike<number>, n: number): number[] | null {
  const A = Array.from(Ain), b = Array.from(bin);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[p * n + c])) p = r;
    if (Math.abs(A[p * n + c]) < 1e-18) return null;
    if (p !== c) { for (let k = 0; k < n; k++) { const t = A[c * n + k]; A[c * n + k] = A[p * n + k]; A[p * n + k] = t; } const t = b[c]; b[c] = b[p]; b[p] = t; }
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] / A[c * n + c];
      if (!f) continue;
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = b[r]; for (let k = r + 1; k < n; k++) s -= A[r * n + k] * x[k]; x[r] = s / A[r * n + r]; }
  return x;
}

// ---------------------------------------------------------------- cameras

/** Pinhole intrinsics in PIXELS (square pixels, principal point at the image centre unless calibrated). */
export interface Intr { f: number; cx: number; cy: number; w: number; h: number }
/** Intrinsics from a DIAGONAL field of view (webcam specs are diagonal). */
export function intrFromFov(w: number, h: number, fovDiagDeg: number): Intr {
  const f = Math.hypot(w, h) / 2 / Math.tan((fovDiagDeg * Math.PI) / 360);
  return { f, cx: w / 2, cy: h / 2, w, h };
}
/** MediaPipe normalised landmark (x of width, y of height) → normalised pinhole ray [x/z, y/z]. */
export const toRay = (K: Intr, nx: number, ny: number): [number, number] => [(nx * K.w - K.cx) / K.f, (ny * K.h - K.cy) / K.f];
/** Normalised pinhole ray → MediaPipe normalised landmark. */
export const fromRay = (K: Intr, x: number, y: number): [number, number] => [(x * K.f + K.cx) / K.w, (y * K.f + K.cy) / K.h];

/** GL-style rotation (y up, z toward the viewer) ↔ CV-style: R_cv = G·R_gl·G with G = diag(1, −1, −1). */
export function glToCv(R: M3): M3 { return [R[0], -R[1], -R[2], -R[3], R[4], R[5], -R[6], R[7], R[8]]; }
/** Rotation part of MediaPipe's column-major 4×4 facial transformation matrix (GL camera frame), as a row-major M3. */
export function rotFromMpMatrix(d: ArrayLike<number>): M3 {
  // column-major: element (row r, col c) = d[c*4 + r]; remove the (uniform) scale
  const c0 = Math.hypot(d[0], d[1], d[2]) || 1, c1 = Math.hypot(d[4], d[5], d[6]) || 1, c2 = Math.hypot(d[8], d[9], d[10]) || 1;
  return orthonormalize([d[0] / c0, d[4] / c1, d[8] / c2, d[1] / c0, d[5] / c1, d[9] / c2, d[2] / c0, d[6] / c1, d[10] / c2]);
}
/** Write a row-major rotation back into a column-major MediaPipe matrix (keeps its scale + translation). */
export function setMpMatrixRot(d: number[], R: M3): number[] {
  const out = d.slice();
  const s0 = Math.hypot(d[0], d[1], d[2]) || 1, s1 = Math.hypot(d[4], d[5], d[6]) || 1, s2 = Math.hypot(d[8], d[9], d[10]) || 1;
  out[0] = R[0] * s0; out[1] = R[3] * s0; out[2] = R[6] * s0;
  out[4] = R[1] * s1; out[5] = R[4] * s1; out[6] = R[7] * s1;
  out[8] = R[2] * s2; out[9] = R[5] * s2; out[10] = R[8] * s2;
  return out;
}
export function orthonormalize(R: M3): M3 {
  // nearest rotation via the quaternion round trip (cheap, good for nearly-orthonormal input)
  return mFromQuat(quatFromM(R));
}

// ---------------------------------------------------------------- triangulation

export interface View { P: Pose; x: number; y: number; w: number }
/**
 * Weighted linear triangulation of one point from ≥ 2 normalised rays (X in the reference frame of the poses).
 * Each view contributes (x·P3 − P1)·X = 0, (y·P3 − P2)·X = 0, weighted by w / (predicted depth) so the weight is in
 * image units. Returns null when the rays are (nearly) parallel.
 */
export function triangulate(views: View[], depthHint = 1): V3 | null {
  const A = new Float64Array(9), b = new Float64Array(3);
  for (const v of views) {
    if (v.w <= 0) continue;
    const R = v.P.R, t = v.P.t;
    const k = v.w / Math.max(0.05, depthHint);
    for (const [c, row] of [[v.x, 0], [v.y, 1]] as const) {
      const a0 = c * R[6] - R[row * 3], a1 = c * R[7] - R[row * 3 + 1], a2 = c * R[8] - R[row * 3 + 2];
      const bb = -(c * t[2] - t[row]);
      const kk = k * k;
      A[0] += kk * a0 * a0; A[1] += kk * a0 * a1; A[2] += kk * a0 * a2;
      A[4] += kk * a1 * a1; A[5] += kk * a1 * a2; A[8] += kk * a2 * a2;
      b[0] += kk * a0 * bb; b[1] += kk * a1 * bb; b[2] += kk * a2 * bb;
    }
  }
  A[3] = A[1]; A[6] = A[2]; A[7] = A[5];
  // conditioning check (parallel rays → tiny smallest eigenvalue)
  const x = solve(A, b, 3);
  if (!x || !x.every(Number.isFinite)) return null;
  return x as V3;
}

/** Project a point (reference frame) through a pose into normalised coords. */
export function project(P: Pose, X: V3): [number, number, number] {
  const c = apply(P, X);
  return [c[0] / c[2], c[1] / c[2], c[2]];
}

/** Rigid alignment (Kabsch, weighted): the pose that maps points `a` onto points `b` (b ≈ R·a + t). */
export function kabsch(a: V3[], b: V3[], w?: number[]): Pose {
  let W = 0; const ca: V3 = [0, 0, 0], cb: V3 = [0, 0, 0];
  for (let i = 0; i < a.length; i++) { const k = w ? w[i] : 1; W += k; for (let j = 0; j < 3; j++) { ca[j] += k * a[i][j]; cb[j] += k * b[i][j]; } }
  for (let j = 0; j < 3; j++) { ca[j] /= W || 1; cb[j] /= W || 1; }
  // H = Σ w (a−ca)(b−cb)ᵀ ; R from the quaternion method (Horn) — no SVD needed
  const H = new Float64Array(9);
  for (let i = 0; i < a.length; i++) {
    const k = w ? w[i] : 1, p = sub(a[i], ca), q = sub(b[i], cb);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) H[r * 3 + c] += k * p[r] * q[c];
  }
  const [Sxx, Sxy, Sxz, Syx, Syy, Syz, Szx, Szy, Szz] = H;
  const N = [
    Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx,
    Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz,
    Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy,
    Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz,
  ];
  const { vectors } = eigSym(N, 4);
  const q = [vectors[4], vectors[8], vectors[12], vectors[0]] as [number, number, number, number]; // (x,y,z,w)
  const R = mFromQuat(q);
  return { R, t: sub(cb, mulMV(R, ca)) };
}

/** Median of a numeric list (copy). */
export function median(a: number[]): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function quantile(a: number[], q: number): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}
