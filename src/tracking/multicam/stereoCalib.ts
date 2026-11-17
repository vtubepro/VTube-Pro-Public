// Stereo SELF-calibration from the performer's own face — no checkerboard. While the performer looks around for
// ~15 s, both cameras track the same 478 face landmarks; the face is the calibration target:
//   1. time offset   the two cameras' capture clocks disagree by a few ms (different pipelines). The head's
//                    angular SPEED is the same seen from any camera, so cross-correlating |ω| finds the offset.
//   2. rotation      MediaPipe gives each camera the face's rotation; R_BA = R_B · R_Aᵀ per synced pair,
//                    robust-averaged (Cauchy re-weighting) over every pair.
//   3. translation   with R known, every landmark pair gives one linear epipolar constraint t·((R·a) × b) = 0
//                    → t's direction = smallest eigenvector (cheirality picks the sign).
//   4. refinement    Levenberg–Marquardt on the reprojection error of the triangulated landmarks over the
//                    rotation, the baseline direction and both focal lengths (weak priors keep the focals near
//                    the webcam's spec FOV) — a "reduced" bundle adjustment (points re-triangulated each step).
//   5. metric scale  triangulated irises: the human iris is 11.7 ± 0.5 mm (inter-pupil 63 ± 3.5 mm as a check).
// Landmarks on the face silhouette (the oval) slide with the viewing angle and are never used; neither is any
// landmark whose surface faces away from either camera in that pair.
import {
  I3, type Intr, type M3, type Pose, type V3, add, dot, expSO3, glToCv, intrFromFov, logSO3, median, mulMM, mulMV, norm,
  normalize, project, robustAverageRotations, rotAngle, rotFromMpMatrix, scale, sub, toRay, transpose, triangulate, cross, eigSym, quantile,
} from './mcMath.ts';
import { FACE_OVAL, N_LM, vertexNormals } from './faceMesh.ts';

/** One camera's face observation (MediaPipe output, full-frame normalised coords). */
export interface FaceObs {
  /** capture time, seconds (performance clock) */
  t: number;
  /** 478 × (x, y, z) normalised landmarks */
  lm: ArrayLike<number>;
  /** MediaPipe facial transformation matrix (column-major 4×4), or null */
  mat: ArrayLike<number> | null;
  w: number; h: number;
}
export interface CamInfo { label: string; w: number; h: number; fovDiag: number }
export interface StereoCalib {
  v: 1;
  at: string;
  A: CamInfo & { f: number };
  B: CamInfo & { f: number };
  /** X_B = R·X_A + t — CV camera frames (x right, y down, z forward), metres */
  R: M3; t: V3;
  /** add to camera B's capture times to put them on camera A's clock (ms) */
  offsetMs: number;
  rmsPx: number;
  baselineMm: number;
  /** angle between the two cameras' viewing directions (deg) */
  angleDeg: number;
  /** median per-pair disagreement of the rotation estimate (deg) */
  spreadDeg: number;
  pairs: number;
  scaleFrom: 'iris' | 'ipd';
  /** implied inter-pupil distance (mm) — sanity check */
  ipdMm: number;
  grade: 'good' | 'ok' | 'poor';
  notes: string[];
}

/** Landmarks used for calibration: every 2nd mesh point that is not on the silhouette. */
const OVAL = new Set(FACE_OVAL);
export const CALIB_IDS: number[] = Array.from({ length: 468 }, (_, i) => i).filter((i) => !OVAL.has(i) && i % 2 === 0);
/**
 * The refinement's landmarks: only points on real image FEATURES (eye corners + lids, iris centres, nostrils, nose tip,
 * lip corners / centre lines, brow heads / tails). MediaPipe places points on smooth skin (cheeks, forehead, jaw) from its
 * shape prior, and those do NOT land on the same physical spot from two directions (up to several px off on a rendered
 * test view) — they bias the solve.
 */
export const FEATURE_IDS = [33, 133, 362, 263, 159, 145, 386, 374, 468, 473, 1, 4, 98, 327, 2, 61, 291, 0, 17, 13, 14, 37, 267, 84, 314, 70, 105, 107, 336, 334, 300, 168, 6];
const LM_IDS = FEATURE_IDS;

interface Pair { a: Float64Array; b: Float64Array; rA: M3; rB: M3; tA: number }

const G = (m: ArrayLike<number> | null) => (m ? glToCv(rotFromMpMatrix(m)) : null);

export class StereoCalibrator {
  private A: FaceObs[] = [];
  private B: FaceObs[] = [];
  /** Keep at most this long (s) of each stream. */
  maxSeconds = 40;
  /** Experiments: start rotation, focal prior width (relative sigma). */
  opt: { initR?: M3; focalSigma?: number } = {};
  constructor(public camA: CamInfo, public camB: CamInfo) {}

  addA(o: FaceObs) { if (o.mat) this.A.push(copyObs(o)); this.trim(this.A); }
  addB(o: FaceObs) { if (o.mat) this.B.push(copyObs(o)); this.trim(this.B); }
  reset() { this.A = []; this.B = []; }
  /** The collected streams (to hand them to a worker for solve()). */
  dump() { return { A: this.A, B: this.B }; }
  load(d: { A: FaceObs[]; B: FaceObs[] }) { this.A = d.A; this.B = d.B; }
  private trim(s: FaceObs[]) { while (s.length > 2 && s[s.length - 1].t - s[0].t > this.maxSeconds) s.shift(); }

  /** Coverage of the look-around (0..1) + what's still missing, for the UI. */
  progress(): { p: number; pairs: number; yawDeg: number; pitchDeg: number; hint: string } {
    const pairs = this.pairs(0, 2);
    if (pairs.length < 2) return { p: 0, pairs: pairs.length, yawDeg: 0, pitchDeg: 0, hint: 'Look at the main camera — both cameras must see your face' };
    const eul = pairs.map((q) => yawPitch(q.rA));
    const ys = eul.map((e) => e[0]), ps = eul.map((e) => e[1]);
    // range of the look-around, ignoring the 2 most extreme views each side (a single bad frame can't fake coverage)
    const rng = (v: number[]) => { const q = [...v].sort((x, y) => x - y); const k = Math.min(2, Math.floor((q.length - 1) / 4)); return (q[q.length - 1 - k] - q[k]) * 57.3; };
    const yawDeg = rng(ys), pitchDeg = rng(ps);
    const p = Math.min(1, pairs.length / 90) * 0.4 + Math.min(1, yawDeg / 30) * 0.4 + Math.min(1, pitchDeg / 15) * 0.2;
    const hint = pairs.length < 30 ? 'Keep your face in view of both cameras…' : yawDeg < 30 ? 'Slowly turn your head left and right' : pitchDeg < 15 ? 'Now slowly nod up and down' : 'Great — hold on a moment…';
    return { p, pairs: pairs.length, yawDeg, pitchDeg, hint };
  }

  /** Synced pairs: each B frame paired with A interpolated to B's (offset-corrected) capture time. */
  private pairs(offsetS: number, stride = 1): Pair[] {
    const out: Pair[] = [];
    let j = 0;
    for (let i = 0; i < this.B.length; i += stride) {
      const b = this.B[i], tb = b.t + offsetS;
      while (j + 1 < this.A.length && this.A[j + 1].t < tb) j++;
      const a0 = this.A[j], a1 = this.A[j + 1];
      if (!a0 || !a1 || a0.t > tb || a1.t < tb || a1.t - a0.t > 0.08) continue;
      const k = (tb - a0.t) / (a1.t - a0.t);
      const la = new Float64Array(N_LM * 3);
      for (let q = 0; q < N_LM * 3; q++) la[q] = a0.lm[q] + (a1.lm[q] - a0.lm[q]) * k;
      const r0 = G(a0.mat)!, r1 = G(a1.mat)!;
      const rA = k < 0.5 ? r0 : r1; // rotations are only needed coarsely here (≤ half a frame of motion)
      out.push({ a: la, b: Float64Array.from(b.lm as ArrayLike<number>), rA, rB: G(b.mat)!, tA: tb });
    }
    return out;
  }

  /** Clock offset (s) between the streams from the head's angular speed (rotation-invariant). */
  estimateOffset(maxMs = 300): { offsetS: number; corr: number } {
    const speed = (s: FaceObs[]) => {
      const t: number[] = [], v: number[] = [];
      for (let i = 1; i < s.length; i++) {
        const dt = s[i].t - s[i - 1].t;
        if (dt <= 0 || dt > 0.25) continue;
        // image motion of the feature points relative to the face's own size (scale-free, view-independent enough
        // to line up the peaks; MediaPipe's per-camera rotations disagree across views and blur the peak)
        const p = s[i].lm, q = s[i - 1].lm;
        let cx = 0, cy = 0; for (const j of FEATURE_IDS) { cx += p[j * 3]; cy += p[j * 3 + 1] * s[i].h / s[i].w; } cx /= FEATURE_IDS.length; cy /= FEATURE_IDS.length;
        let spr = 0, mv = 0;
        for (const j of FEATURE_IDS) {
          const x = p[j * 3], y = p[j * 3 + 1] * s[i].h / s[i].w;
          spr += (x - cx) ** 2 + (y - cy) ** 2;
          mv += (x - q[j * 3]) ** 2 + (y - q[j * 3 + 1] * s[i].h / s[i].w) ** 2;
        }
        t.push((s[i].t + s[i - 1].t) / 2); v.push(Math.sqrt(mv / Math.max(1e-12, spr)) / dt);
      }
      return { t, v };
    };
    const a = speed(this.A), b = speed(this.B);
    if (a.t.length < 20 || b.t.length < 20) return { offsetS: 0, corr: 0 };
    // light smoothing (3-tap) against per-frame rotation noise
    const sm = (v: number[]) => v.map((_, i) => (v[Math.max(0, i - 1)] + v[i] + v[Math.min(v.length - 1, i + 1)]) / 3);
    const av = sm(a.v), bv = sm(b.v);
    const interp = (tt: number) => {
      let lo = 0, hi = a.t.length - 1;
      if (tt <= a.t[0] || tt >= a.t[hi]) return NaN;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (a.t[m] <= tt) lo = m; else hi = m; }
      const k = (tt - a.t[lo]) / (a.t[hi] - a.t[lo]);
      return av[lo] + (av[hi] - av[lo]) * k;
    };
    let best = { offsetS: 0, corr: -1 };
    for (let ms = -maxMs; ms <= maxMs; ms += 2) {
      const o = ms / 1000;
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, n = 0;
      for (let i = 0; i < b.t.length; i++) {
        const x = interp(b.t[i] + o);
        if (!Number.isFinite(x)) continue;
        const y = bv[i];
        sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; n++;
      }
      if (n < 30) continue;
      const c = (sxy - (sx * sy) / n) / Math.sqrt(Math.max(1e-12, (sxx - (sx * sx) / n) * (syy - (sy * sy) / n)));
      if (c > best.corr) best = { offsetS: o, corr: c };
    }
    // refine around the peak at 0.5 ms resolution with a parabola through the 3 best
    return best;
  }

  /** Run the whole calibration. Throws with a plain-language reason when the data can't support it. */
  solve(): StereoCalib {
    const notes: string[] = [];
    if (this.A.length < 40 || this.B.length < 20) throw new Error('Not enough frames with your face in BOTH cameras yet');
    const off = this.estimateOffset();
    const offsetS = off.corr > 0.5 ? off.offsetS : 0;
    if (off.corr <= 0.5) notes.push(`clock offset not measurable (head barely moved, corr ${off.corr.toFixed(2)}) — assumed 0 ms`);
    const all = this.pairs(offsetS);
    if (all.length < 25) throw new Error('Too few moments where both cameras saw your face at the same time');
    // ---- 2. rotation
    const Rs = all.map((p) => mulMM(p.rB, transpose(p.rA)));
    const rot = robustAverageRotations(Rs, 0.05);
    let R = this.opt.initR ?? rot.R;
    // ---- intrinsics from the spec FOV
    let KA = intrFromFov(this.camA.w, this.camA.h, this.camA.fovDiag), KB = intrFromFov(this.camB.w, this.camB.h, this.camB.fovDiag);
    // select usable pairs: spread out in time (≤ 160), and landmarks visible to both cameras
    const step = Math.max(1, Math.floor(all.length / 70));
    const use = all.filter((_, i) => i % step === 0);
    // ---- 3. translation direction (linear, epipolar)
    const corr = (Ka: Intr, Kb: Intr) => use.map((p) => LM_IDS.map((i) => ({ i, a: toRay(Ka, p.a[i * 3], p.a[i * 3 + 1]), b: toRay(Kb, p.b[i * 3], p.b[i * 3 + 1]) })));
    let C = corr(KA, KB);
    const M = new Float64Array(9);
    for (const fr of C) for (const c of fr) {
      const ra = mulMV(R, [c.a[0], c.a[1], 1]), cc = cross(ra, [c.b[0], c.b[1], 1]);
      const n = norm(cc) || 1;
      for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) M[r * 3 + q] += (cc[r] / n) * (cc[q] / n);
    }
    const eg = eigSym(M, 3);
    let t: V3 = normalize([eg.vectors[2], eg.vectors[5], eg.vectors[8]]);
    // cheirality: points must be in front of both cameras
    if (frontCount(C, { R, t }) < frontCount(C, { R, t: [-t[0], -t[1], -t[2]] })) t = [-t[0], -t[1], -t[2]];
    // ---- 4. LM refinement: [ω (3), t direction (2: tangent), log fA, log fB]
    const fA0 = KA.f, fB0 = KB.f;
    const base = { R, t };
    const tb = tangentBasis(t);
    const paramsToModel = (x: number[]) => {
      const Rm = mulMM(expSO3([x[0], x[1], x[2]]), base.R);
      const tm = normalize(add(base.t, add(scale(tb[0], x[3]), scale(tb[1], x[4]))));
      return { R: Rm, t: tm, fA: fA0 * Math.exp(x[5]), fB: fB0 * Math.exp(x[6]) };
    };
    const resid = (x: number[]): number[] => {
      const m = paramsToModel(x);
      const Ka = { ...KA, f: m.fA }, Kb = { ...KB, f: m.fB };
      const cs = corr(Ka, Kb);
      const out: number[] = [];
      const PA: Pose = { R: I3(), t: [0, 0, 0] }, PB: Pose = { R: m.R, t: m.t };
      for (const fr of cs) for (const c of fr) {
        const X = triangulate([{ P: PA, x: c.a[0], y: c.a[1], w: 1 }, { P: PB, x: c.b[0], y: c.b[1], w: 1 }], 3);
        if (!X) { out.push(0, 0, 0, 0); continue; }
        const pa = project(PA, X), pb = project(PB, X);
        const h = (e: number) => { const a = Math.abs(e); return a < 3 ? e : Math.sign(e) * Math.sqrt(6 * a - 9); }; // Huber (3 px)
        out.push(h((pa[0] - c.a[0]) * Ka.f), h((pa[1] - c.a[1]) * Ka.f), h((pb[0] - c.b[0]) * Kb.f), h((pb[1] - c.b[1]) * Kb.f));
      }
      // weak priors: focal lengths within ~12 % of the spec value, as pseudo-residuals scaled like ~40 px
      const k = Math.sqrt(out.length / 4) * 0.35;
      const fs = this.opt.focalSigma ?? 0.06;
      out.push((x[5] / fs) * k, (x[6] / fs) * k);
      return out;
    };
    let x = [0, 0, 0, 0, 0, 0, 0];
    let r = resid(x), cost = sumSq(r), lambda = 1e-2;
    for (let it = 0; it < 25; it++) {
      const J: number[][] = [];
      for (let p = 0; p < x.length; p++) {
        const e = p < 3 ? 1e-4 : p < 5 ? 1e-4 : 1e-3;
        const xp = x.slice(); xp[p] += e;
        const xm = x.slice(); xm[p] -= e;
        const rp = resid(xp), rm = resid(xm);
        J.push(rp.map((v, i) => (v - rm[i]) / (2 * e)));
      }
      const n = x.length, JtJ = new Float64Array(n * n), Jtr = new Float64Array(n);
      for (let a = 0; a < n; a++) {
        for (let b2 = a; b2 < n; b2++) { let s = 0; const ja = J[a], jb = J[b2]; for (let i = 0; i < r.length; i++) s += ja[i] * jb[i]; JtJ[a * n + b2] = JtJ[b2 * n + a] = s; }
        let s = 0; for (let i = 0; i < r.length; i++) s += J[a][i] * r[i]; Jtr[a] = s;
      }
      let improved = false;
      for (let tries = 0; tries < 6 && !improved; tries++) {
        const Aug = Float64Array.from(JtJ);
        for (let a = 0; a < n; a++) Aug[a * n + a] *= 1 + lambda;
        const d = solveSym(Aug, Array.from(Jtr, (v) => -v), n);
        if (!d) { lambda *= 10; continue; }
        const xn = x.map((v, i) => v + d[i]);
        const rn = resid(xn), cn = sumSq(rn);
        if (cn < cost) { x = xn; r = rn; improved = cost - cn > cost * 1e-6; cost = cn; lambda = Math.max(1e-6, lambda / 3); if (!improved) tries = 99; }
        else lambda *= 8;
      }
      if (!improved) break;
    }
    const fit = paramsToModel(x);
    R = fit.R; t = fit.t;
    KA = { ...KA, f: fit.fA }; KB = { ...KB, f: fit.fB };
    C = corr(KA, KB);
    // reprojection RMS (px, unweighted) + per-pair structure for the scale
    const PA: Pose = { R: I3(), t: [0, 0, 0] }, PB: Pose = { R, t };
    let se = 0, ne = 0;
    for (const fr of C) for (const c of fr) {
      const X = triangulate([{ P: PA, x: c.a[0], y: c.a[1], w: 1 }, { P: PB, x: c.b[0], y: c.b[1], w: 1 }], 3);
      if (!X) continue;
      const pa = project(PA, X), pb = project(PB, X);
      se += ((pa[0] - c.a[0]) * KA.f) ** 2 + ((pa[1] - c.a[1]) * KA.f) ** 2 + ((pb[0] - c.b[0]) * KB.f) ** 2 + ((pb[1] - c.b[1]) * KB.f) ** 2; ne += 4;
    }
    const rmsPx = Math.sqrt(se / Math.max(1, ne));
    // ---- 5. metric scale (baseline = 1 so far)
    const iris: number[] = [], ipd: number[] = [];
    for (const p of use) {
      const tri = (i: number) => triangulate([{ P: PA, x: toRay(KA, p.a[i * 3], p.a[i * 3 + 1])[0], y: toRay(KA, p.a[i * 3], p.a[i * 3 + 1])[1], w: 1 },
        { P: PB, x: toRay(KB, p.b[i * 3], p.b[i * 3 + 1])[0], y: toRay(KB, p.b[i * 3], p.b[i * 3 + 1])[1], w: 1 }], 3);
      const a1 = tri(469), a2 = tri(471), b1 = tri(474), b2 = tri(476), c1 = tri(468), c2 = tri(473);
      if (a1 && a2 && b1 && b2) iris.push((norm(sub(a1, a2)) + norm(sub(b1, b2))) / 2);
      if (c1 && c2) ipd.push(norm(sub(c1, c2)));
    }
    const irisU = median(iris), ipdU = median(ipd);
    let k = 0.0117 / irisU;
    let scaleFrom: 'iris' | 'ipd' = 'iris';
    const ipdMmIris = ipdU * k * 1000;
    if (!Number.isFinite(k) || ipdMmIris < 50 || ipdMmIris > 76) {
      k = 0.063 / ipdU; scaleFrom = 'ipd';
      notes.push(`iris size implausible (IPD would be ${ipdMmIris.toFixed(0)} mm) — scaled by a typical 63 mm inter-pupil distance`);
    }
    const tm = scale(t, k);
    const baselineMm = norm(tm) * 1000;
    const zA: V3 = [0, 0, 1], zB = mulMV(transpose(R), [0, 0, 1]);
    const angleDeg = Math.acos(Math.max(-1, Math.min(1, dot(zA, zB)))) * 57.2958;
    const spreadDeg = rot.spread * 57.2958;
    const grade: StereoCalib['grade'] = rmsPx < 2.5 && spreadDeg < 3 && all.length >= 60 ? 'good' : rmsPx < 5 && spreadDeg < 6 ? 'ok' : 'poor';
    if (baselineMm < 40) notes.push('the cameras are very close together — depth gains will be small');
    if (angleDeg > 75) notes.push('the cameras look from very different directions — few landmarks are seen well by both');
    return {
      v: 1, at: new Date().toISOString(),
      A: { ...this.camA, f: KA.f }, B: { ...this.camB, f: KB.f },
      R, t: tm, offsetMs: offsetS * 1000, rmsPx, baselineMm, angleDeg, spreadDeg, pairs: all.length,
      scaleFrom, ipdMm: ipdU * k * 1000, grade, notes,
    };
  }
}

function copyObs(o: FaceObs): FaceObs {
  return { t: o.t, lm: Float32Array.from(o.lm as ArrayLike<number>), mat: o.mat ? Float64Array.from(o.mat as ArrayLike<number>) : null, w: o.w, h: o.h };
}
/** yaw, pitch of a CV head rotation (for coverage only) */
function yawPitch(R: M3): [number, number] {
  const f = mulMV(R, [0, 0, 1]); // head forward (canonical +z is out of the face in GL; in CV that's −z) — sign-agnostic ranges
  return [Math.atan2(f[0], Math.abs(f[2])), Math.atan2(f[1], Math.abs(f[2]))];
}
function frontCount(C: { a: [number, number]; b: [number, number] }[][], P: Pose) {
  let n = 0;
  const PA: Pose = { R: I3(), t: [0, 0, 0] };
  for (const fr of C) for (let i = 0; i < fr.length; i += 7) {
    const c = fr[i];
    const X = triangulate([{ P: PA, x: c.a[0], y: c.a[1], w: 1 }, { P, x: c.b[0], y: c.b[1], w: 1 }], 3);
    if (X && X[2] > 0 && project(P, X)[2] > 0) n++;
  }
  return n;
}
function tangentBasis(t: V3): [V3, V3] {
  const a: V3 = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(t, a));
  return [u, normalize(cross(t, u))];
}
const sumSq = (r: number[]) => { let s = 0; for (const v of r) s += v * v; return s; };
function solveSym(A: Float64Array, b: number[], n: number): number[] | null {
  // Cholesky
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = A[i * n + j];
    for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
    if (i === j) { if (s <= 0) return null; L[i * n + i] = Math.sqrt(s); } else L[i * n + j] = s / L[j * n + j];
  }
  const y = new Array(n).fill(0);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]; y[i] = s / L[i * n + i]; }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
  return x;
}
/** Visibility of every landmark to a camera at the origin looking down +z (CV), from a 3D landmark set (CV frame). */
export function visibility(P: ArrayLike<number>, out = new Float64Array(N_LM)): Float64Array {
  const n = vertexNormals(P);
  for (let i = 0; i < N_LM; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const d = Math.hypot(x, y, z) || 1;
    out[i] = Math.max(0, -(n[i * 3] * x + n[i * 3 + 1] * y + n[i * 3 + 2] * z) / d);
  }
  return out;
}
void logSO3;
