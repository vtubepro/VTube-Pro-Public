// Stereo face fusion: two cameras' MediaPipe results → ONE FaceLandmarker-shaped result in the MAIN camera's image,
// so everything downstream (FaceSolver, speech fusion, expression model) is unchanged and mono is the fallback.
//
// Per main-camera frame (time tA) with the latest secondary frame (tB, on A's clock after the calibrated offset):
//   1. SYNC        A's landmarks are interpolated to tB from A's short history (A runs faster), so the triangulation
//                  uses two views of the SAME instant; the rigid head motion tB → tA (A's own rotation + centroid
//                  history) then carries the triangulated points to tA. Non-rigid motion in that ≤ 1 frame is taken
//                  from A's fresh measurement (step 4), so the mouth never lags.
//   2. WEIGHTS     per landmark and camera: how squarely the surface faces the camera (mesh normals of the last fused
//                  shape), × occlusion (a tracked hand over that part of the face in A), × role (a close-up mouth
//                  cam counts extra on the mouth, less for the head pose). Regions whose two views disagree after
//                  triangulation (reprojection residual far above the calibration's) fall back to the better view.
//   3. TRIANGULATE weighted linear triangulation → true metric 3D (no face-size/FOV assumption for depth).
//   4. BLEND       final ray = weighted mix of A's fresh ray and the stereo point's projection (weight of the stereo
//                  part decays with its age for fast regions: mouth / eyes), depth from the stereo point.
//   5. ROTATION    A's head rotation and B's (rotated into A, motion-compensated), averaged by frontalness.
//   6. BLENDSHAPES per channel from its face region: A and B coefficients weighted like the landmarks; B's values go
//                  through a per-channel linear map learned online while both views are clean (a camera below the
//                  face reads jawOpen differently from one in front).
//   Secondary missing / stale / faceless → A passes through untouched ("mono"). A faceless but B tracking → the
//   face is re-projected from B into A ("B-only": turned far away from the main camera, hand over the whole face).
import {
  type Intr, type M3, type Pose, type V3, add, dot, glToCv, mFromQuat, mulMM, mulMV, norm, normalize, project, quatFromM, averageRotations,
  rotFromMpMatrix, setMpMatrixRot, sub, toRay, fromRay, transpose, triangulate, scale, I3, expSO3, logSO3,
} from './mcMath.ts';
import { N_LM, REGION_OF, REGIONS, type Region, regionOfChannel, vertexNormals, FACE_OVAL } from './faceMesh.ts';
import type { StereoCalib } from './stereoCalib.ts';

export interface MpLandmark { x: number; y: number; z: number; visibility?: number }
export interface MpCategory { categoryName: string; score: number; index?: number; displayName?: string }
/** The subset of MediaPipe's FaceLandmarkerResult the fuser reads/writes. */
export interface MpFace {
  faceLandmarks: MpLandmark[][];
  faceBlendshapes?: { categories: MpCategory[]; headIndex?: number; headName?: string }[];
  facialTransformationMatrixes?: { rows: number; columns: number; data: number[] | Float32Array }[];
  [k: string]: unknown;
}
export type FuseMode = 'mono' | 'stereo' | 'B-only';
export interface FuseInfo {
  mode: FuseMode;
  /** how old the secondary frame was at fusion (ms) */
  ageMs: number;
  /** median triangulation residual (px, main camera) */
  residPx: number;
  /** triangulated head (rigid centroid) distance from camera A (m) */
  zM: number;
  /** A's share of each region (0 = all B, 1 = all A) */
  shareA: Partial<Record<Region, number>>;
  occludedA: Region[];
  inconsistent: Region[];
}
export interface FuseOptions {
  role: 'stereo' | 'mouth';
  /** normalised hand landmarks seen by camera A (occlusion) */
  handsA?: { x: number; y: number }[][] | null;
}

const RIGID = [33, 133, 362, 263, 168, 6, 197, 195, 5, 4, 1, 98, 327, 10, 151, 9, 107, 336, 70, 300];
const OVAL = new Set(FACE_OVAL);
/** Seconds after which the secondary's contribution to a region has decayed to 1/e (non-rigid speed per region). */
const TAU: Record<Region, number> = { mouth: 0.035, eyeL: 0.03, eyeR: 0.03, browL: 0.12, browR: 0.12, nose: 0.6, cheekL: 0.25, cheekR: 0.25, oval: 0.6 };

interface AFrame { t: number; lm: Float64Array; R: M3; u: number; v: number; s: number }
interface BFrame { t: number; lm: Float64Array; R: M3; bs: Record<string, number> }

export class StereoFuser {
  /** Max age (s) of the secondary frame before falling back to mono. */
  maxAge = 0.2;
  /** Use the B-only re-projection when A loses the face. */
  bOnly = true;
  /** Learn the per-channel B→A blendshape map online. */
  learnMap = true;
  info: FuseInfo = { mode: 'mono', ageMs: 0, residPx: 0, zM: 0, shareA: {}, occludedA: [], inconsistent: [] };
  private KA: Intr; private KB: Intr;
  private P: Pose; private PA: Pose = { R: I3(), t: [0, 0, 0] };
  private hist: AFrame[] = [];
  private lastB: BFrame | null = null;
  /** last fused 3D shape (A camera frame) + its normals */
  private X: Float64Array | null = null;
  private nrm: Float64Array | null = null;
  private speed = { w: 0, v: 0 };
  /** 'robust' (default): A's landmarks + rotation, B takes over only what A can't see. 'blend': average everywhere (experimental). */
  style: 'robust' | 'blend' = 'robust';
  private take: Partial<Record<Region, number>> = {};
  private lastTA = 0;
  private bias = new Float64Array(N_LM * 2);
  private rotBias: M3 = I3();
  private track: { t: number; R: M3; c: V3 }[] = [];
  private ctrack: { t: number; c: V3 }[] = [];
  private map = new Map<string, { n: number; mx: number; my: number; sxx: number; sxy: number }>();
  private visA = new Float64Array(N_LM); private visB = new Float64Array(N_LM);

  constructor(public calib: StereoCalib, liveA?: { w: number; h: number }, liveB?: { w: number; h: number }) {
    this.KA = scaleIntr(calib.A, liveA); this.KB = scaleIntr(calib.B, liveB);
    this.P = { R: calib.R, t: calib.t };
  }
  /** Live resolutions changed (e.g. the camera fell back to 720p): rescale the intrinsics. Returns false if the aspect differs. */
  setResolution(liveA: { w: number; h: number }, liveB: { w: number; h: number }): boolean {
    const okA = Math.abs(liveA.w / liveA.h - this.calib.A.w / this.calib.A.h) < 0.02, okB = Math.abs(liveB.w / liveB.h - this.calib.B.w / this.calib.B.h) < 0.02;
    this.KA = scaleIntr(this.calib.A, liveA); this.KB = scaleIntr(this.calib.B, liveB);
    return okA && okB;
  }

  /** Feed every secondary result as it arrives (capture time on B's clock, seconds). */
  pushB(res: MpFace | null, tB: number) {
    const lm = res?.faceLandmarks?.[0], mat = res?.facialTransformationMatrixes?.[0]?.data;
    if (!lm || !mat) { this.lastB = null; return; }
    const bs: Record<string, number> = {};
    for (const c of res!.faceBlendshapes?.[0]?.categories ?? []) bs[c.categoryName] = c.score;
    this.lastB = { t: tB + this.calib.offsetMs / 1000, lm: flat(lm), R: glToCv(rotFromMpMatrix(mat)), bs };
  }
  /** Secondary camera gone (unplugged / stopped): mono until it returns. */
  dropB() { this.lastB = null; }

  /** Fuse the main camera's result (capture time tA, seconds). Returns a NEW result object (the input is not modified). */
  fuse(a: MpFace | null, tA: number, opt: FuseOptions): MpFace | null {
    const info: FuseInfo = { mode: 'mono', ageMs: 0, residPx: 0, zM: this.info.zM, shareA: {}, occludedA: [], inconsistent: [] };
    this.info = info;
    const b = this.lastB;
    const lmA0 = a?.faceLandmarks?.[0], matA = a?.facialTransformationMatrixes?.[0]?.data;
    if (!lmA0 || !matA) {
      // A lost the face: B-only re-projection (needs a known shape to take the depth from)
      if (!this.bOnly || !b || !this.X || tA - b.t > this.maxAge) return a;
      return this.fromB(b, tA, info);
    }
    const lmA = flat(lmA0);
    const RA = glToCv(rotFromMpMatrix(matA));
    const m = rigidMeasure(lmA, this.KA);
    this.hist.push({ t: tA, lm: lmA, R: RA, ...m });
    while (this.hist.length > 8 || (this.hist.length > 2 && tA - this.hist[0].t > 0.25)) this.hist.shift();
    if (!b || tA - b.t > this.maxAge || b.t - tA > 0.05) return a;
    const age = Math.max(0, tA - b.t);
    info.ageMs = age * 1000;

    // ---- 1. A at B's instant (interpolated) + rigid motion tB → tA
    const at = this.aAt(b.t) ?? this.hist[this.hist.length - 1];
    // ---- 2. weights
    this.updateVisibility();
    const occ = occludedRegions(lmA, opt.handsA ?? null);
    info.occludedA = [...occ];
    const role = opt.role;
    // ---- 3. triangulate every landmark at tB
    const Xs = new Float64Array(N_LM * 3);
    const wA = new Float64Array(N_LM), wB = new Float64Array(N_LM);
    const zHint = this.info.zM || 0.6;
    const residA: number[][] = REGIONS.map(() => []), residB: number[][] = REGIONS.map(() => []);
    for (let j = 0; j < N_LM; j++) {
      const g = REGION_OF[j];
      let va = this.X ? Math.max(0.03, this.visA[j]) ** 2 : 1, vb = this.X ? Math.max(0.03, this.visB[j]) ** 2 : 1;
      if (occ.has(g)) va *= 0.02;
      if (role === 'mouth') vb *= g === 'mouth' ? 2.5 : 0.6;
      wA[j] = va; wB[j] = vb;
      const ra = toRay(this.KA, at.lm[j * 3], at.lm[j * 3 + 1]), rb = toRay(this.KB, b.lm[j * 3], b.lm[j * 3 + 1]);
      const X = triangulate([{ P: this.PA, x: ra[0], y: ra[1], w: va }, { P: this.P, x: rb[0], y: rb[1], w: vb }], zHint);
      if (!X || X[2] < 0.05 || X[2] > 5) { Xs[j * 3] = NaN; continue; }
      Xs[j * 3] = X[0]; Xs[j * 3 + 1] = X[1]; Xs[j * 3 + 2] = X[2];
      const pa = project(this.PA, X), pb = project(this.P, X);
      const ri = REGIONS.indexOf(g);
      residA[ri].push(Math.hypot(pa[0] - ra[0], pa[1] - ra[1]) * this.KA.f);
      residB[ri].push(Math.hypot(pb[0] - rb[0], pb[1] - rb[1]) * this.KB.f);
    }
    // region consistency: a region whose views disagree keeps only its better view
    const lim = Math.max(4, (this.calib.rmsPx || 2) * 3);
    const allRes: number[] = [];
    REGIONS.forEach((g, ri) => {
      const ea = med(residA[ri]), eb = med(residB[ri]);
      allRes.push(...residA[ri]);
      if (g === 'oval' || !(ea + eb > 2 * lim)) return;
      info.inconsistent.push(g);
      const aBetter = !occ.has(g) && meanOver(this.visA, g) >= meanOver(this.visB, g);
      for (let j = 0; j < N_LM; j++) if (REGION_OF[j] === g) {
        const ra = toRay(this.KA, at.lm[j * 3], at.lm[j * 3 + 1]), rb = toRay(this.KB, b.lm[j * 3], b.lm[j * 3 + 1]);
        if (aBetter) wB[j] *= 0.01; else wA[j] *= 0.01;
        const X = triangulate([{ P: this.PA, x: ra[0], y: ra[1], w: wA[j] }, { P: this.P, x: rb[0], y: rb[1], w: wB[j] }], zHint);
        if (X) { Xs[j * 3] = X[0]; Xs[j * 3 + 1] = X[1]; Xs[j * 3 + 2] = X[2]; }
      }
    });
    info.residPx = med(allRes);
    // rigid motion tB → tA from A's rotation + centroid history, applied to the triangulated points
    const M = this.smoothMotion(age, Xs);
    // ---- 4. blend into A's image at tA
    const out = new Float64Array(N_LM * 3);
    let zRef = 0, nz = 0, zMeanA = 0;
    for (const i of RIGID) { if (Number.isFinite(Xs[i * 3])) { const q = apply3(M, Xs, i); zRef += q[2]; nz++; } zMeanA += lmA[i * 3 + 2]; }
    zRef = nz ? zRef / nz : zHint; zMeanA /= RIGID.length;
    info.zM = zRef;
    const share: Record<string, [number, number]> = {};
    // robust style: how much each region is taken over from camera 2 (ramps over ~80 ms, no pops)
    const dtA = Math.min(0.1, Math.max(0.001, tA - this.lastTA)); this.lastTA = tA;
    for (const g of REGIONS) { const want = occ.has(g) ? 1 : 0; this.take[g] = (this.take[g] ?? 0) + (want - (this.take[g] ?? 0)) * Math.min(1, dtA / 0.08); }
    const Rt = transpose(this.P.R);
    for (let j = 0; j < N_LM; j++) {
      const g = REGION_OF[j];
      const fa = toRay(this.KA, lmA[j * 3], lmA[j * 3 + 1]);
      if (!Number.isFinite(Xs[j * 3]) || OVAL.has(j)) {
        // silhouette / failed: A as measured
        out[j * 3] = lmA[j * 3]; out[j * 3 + 1] = lmA[j * 3 + 1]; out[j * 3 + 2] = lmA[j * 3 + 2];
        continue;
      }
      const q = apply3(M, Xs, j);
      if (this.style === 'robust') {
        // camera B's own ray at the shape's depth, into A (moved to tA) + a per-landmark bias learned while both are clean:
        // MediaPipe's points don't land on the same physical spot from two directions, so B-derived points are only
        // used where A can't see (with the offset that makes them line up with what A showed a moment ago)
        const xs = [Xs[j * 3], Xs[j * 3 + 1], Xs[j * 3 + 2]] as V3;
        const zb = add(mulMV(this.P.R, xs), this.P.t)[2];
        const rb = toRay(this.KB, b.lm[j * 3], b.lm[j * 3 + 1]);
        const xa = add(mulMV(M.R, mulMV(Rt, sub([rb[0] * zb, rb[1] * zb, zb], this.P.t))), M.t);
        const bx = xa[0] / xa[2], by = xa[1] / xa[2];
        const k = this.take[g] ?? 0;
        if (k < 0.02 && !info.inconsistent.includes(g)) { this.bias[j * 2] += (fa[0] - bx - this.bias[j * 2]) * 0.05; this.bias[j * 2 + 1] += (fa[1] - by - this.bias[j * 2 + 1]) * 0.05; }
        const x = fa[0] * (1 - k) + (bx + this.bias[j * 2]) * k, y = fa[1] * (1 - k) + (by + this.bias[j * 2 + 1]) * k;
        const p = fromRay(this.KA, x, y);
        out[j * 3] = p[0]; out[j * 3 + 1] = p[1];
        out[j * 3 + 2] = k < 0.02 ? lmA[j * 3 + 2] : lmA[j * 3 + 2] * (1 - k) + (zMeanA + ((q[2] - zRef) * this.KA.f) / (this.KA.w * zRef)) * k;
        const s2 = (share[g] ??= [0, 0]); s2[0] += 1 - k; s2[1]++;
        continue;
      }
      const sx = q[0] / q[2], sy = q[1] / q[2];
      // 'blend' style (experimental): fresh A vs stereo (A at tB + B), the stereo part fading with its age for fast
      // regions and with how far the head moved since B's frame (motion compensation is only ~65 % accurate)
      const movePx = 0.35 * age * this.KA.f * (this.speed.w * 0.08 + this.speed.v) / zRef;
      const decay = Math.exp(-age / TAU[g]) * (0.64 / (0.64 + movePx * movePx));
      const kS = wB[j] * decay, kA = wA[j];
      const alpha = kA / (kA + kS + 1e-9) * 0.5 + (occ.has(g) ? 0 : 0.5 * (1 - decay));
      const x = fa[0] * alpha + sx * (1 - alpha), y = fa[1] * alpha + sy * (1 - alpha);
      const p = fromRay(this.KA, x, y);
      out[j * 3] = p[0]; out[j * 3 + 1] = p[1];
      out[j * 3 + 2] = zMeanA + ((q[2] - zRef) * this.KA.f) / (this.KA.w * zRef);
      const s = (share[g] ??= [0, 0]); s[0] += alpha; s[1]++;
    }
    for (const g in share) info.shareA[g as Region] = +(share[g][0] / share[g][1]).toFixed(2);
    // keep the fused shape (A frame, at tA) for next frame's normals / depths
    this.X = new Float64Array(N_LM * 3);
    for (let j = 0; j < N_LM; j++) {
      const p = [out[j * 3], out[j * 3 + 1]] as const;
      const r = toRay(this.KA, p[0], p[1]);
      const z = Number.isFinite(Xs[j * 3]) ? apply3(M, Xs, j)[2] : zRef;
      this.X[j * 3] = r[0] * z; this.X[j * 3 + 1] = r[1] * z; this.X[j * 3 + 2] = z;
    }
    this.nrm = vertexNormals(this.X);
    // ---- 5. rotation
    const RB_inA = mulMM(M.R, mulMM(transpose(this.P.R), b.R)); // B's head rotation in A's frame, moved to tA
    const fa = frontal(RA, this.X, this.PA), fb = frontal(mulMM(this.P.R, RB_inA), this.X, this.P);
    let kb = Math.max(0.02, fb) ** 4, ka = Math.max(0.02, fa) ** 4;
    { const e = 0.35 * this.speed.w * age / 0.0035; kb *= 1 / (1 + e * e); } // ~0.2° rotation noise vs stale-motion error
    if (role === 'mouth') kb *= 0.4;
    if (occ.size >= 3) ka *= 0.2;
    // B's rotation carries a per-view bias (MediaPipe's rotations disagree across views by degrees): learn it while
    // both are clean, and in the robust style only lean on B when A is mostly covered
    if (occ.size === 0 && info.inconsistent.length === 0) this.rotBias = slerpM(this.rotBias, mulMM(RA, transpose(RB_inA)), 0.03);
    const RBc = mulMM(this.rotBias, RB_inA);
    if (this.style === 'robust') { kb *= occ.size >= 3 ? 1 : 0; }
    const Rf = averageRotations([RA, RBc], [ka, kb]);
    {
      // measurement tracks only (no feedback from the motion compensation itself): rotation at tA, the triangulated
      // centroid at B's capture time (once per B frame)
      this.track.push({ t: tA, R: Rf, c: [0, 0, 0] });
      while (this.track.length > 12 || (this.track.length > 2 && tA - this.track[0].t > 0.25)) this.track.shift();
      let c: V3 = [0, 0, 0], n = 0;
      for (const i of RIGID) if (Number.isFinite(Xs[i * 3])) { c = add(c, [Xs[i * 3], Xs[i * 3 + 1], Xs[i * 3 + 2]]); n++; }
      const ct = this.ctrack;
      if (n && (!ct.length || b.t > ct[ct.length - 1].t + 1e-4)) ct.push({ t: b.t, c: scale(c, 1 / n) });
      while (ct.length > 8 || (ct.length > 2 && b.t - ct[0].t > 0.4)) ct.shift();
    }
    // ---- 6. blendshapes
    const bsA = a!.faceBlendshapes?.[0]?.categories ?? [];
    const regionW = (vis: Float64Array, g: Region) => meanOver(vis, g);
    const cats = bsA.map((c) => {
      const regs = regionOfChannel(c.categoryName);
      let va = 0, vb = 0;
      for (const g of regs) {
        va += (occ.has(g) ? 0.02 : 1) * Math.max(0.03, regionW(this.visA, g)) ** 2;
        vb += Math.max(0.03, regionW(this.visB, g)) ** 2 * Math.exp(-age / TAU[g]) * (role === 'mouth' ? (g === 'mouth' ? 2.5 : 0.6) : 1) * (this.style === 'robust' && !occ.has(g) ? (role === 'mouth' && g === 'mouth' ? 0.6 : 0.3) : 1);
      }
      if (info.inconsistent.some((g) => regs.includes(g))) { if (va >= vb) vb *= 0.01; else va *= 0.01; }
      const bRaw = b.bs[c.categoryName];
      if (bRaw === undefined) return { ...c };
      const bMapped = this.mapB(c.categoryName, bRaw, c.score, va, vb, occ.size === 0 && info.inconsistent.length === 0);
      return { ...c, score: clamp01((c.score * va + bMapped * vb) / (va + vb + 1e-9)) };
    });
    info.mode = 'stereo';
    return makeResult(a!, out, setMpMatrixRot(Array.from(matA), cvToGl(Rf)), cats);
  }

  /** A has no face: re-project B's landmarks into A using the last known shape's depth + B's own rotation. */
  private fromB(b: BFrame, tA: number, info: FuseInfo): MpFace | null {
    const P = this.P, X0 = this.X!;
    // rigid fit: last fused shape (in B's frame) ↔ B's rays at the depths of that shape → where the head is now
    const Rb0 = transpose(P.R);
    const depthB = new Float64Array(N_LM);
    let zc = 0, n = 0;
    for (const i of RIGID) { const q = add(mulMV(P.R, [X0[i * 3], X0[i * 3 + 1], X0[i * 3 + 2]]), P.t); depthB[i] = q[2]; zc += q[2]; n++; }
    zc /= n || 1;
    // scale the depth by the change of B's apparent face size since the last fused frame
    const mNow = rigidMeasure(b.lm, this.KB);
    const prevB = new Float64Array(N_LM * 3);
    for (let j = 0; j < N_LM; j++) { const q = add(mulMV(P.R, [X0[j * 3], X0[j * 3 + 1], X0[j * 3 + 2]]), P.t); prevB[j * 3] = (q[0] / q[2] * this.KB.f + this.KB.cx) / this.KB.w; prevB[j * 3 + 1] = (q[1] / q[2] * this.KB.f + this.KB.cy) / this.KB.h; }
    const mPrev = rigidMeasure(prevB, this.KB);
    const Z = zc * (mPrev.s / Math.max(1e-6, mNow.s));
    const out = new Float64Array(N_LM * 3);
    for (let j = 0; j < N_LM; j++) {
      const r = toRay(this.KB, b.lm[j * 3], b.lm[j * 3 + 1]);
      const dz = (b.lm[j * 3 + 2] - mNow.zMean) * this.KB.w / this.KB.f * Z; // MediaPipe relative depth → metres
      const XB: V3 = [r[0] * (Z + dz), r[1] * (Z + dz), Z + dz];
      const XA = mulMV(Rb0, sub(XB, P.t));
      const p = fromRay(this.KA, XA[0] / XA[2], XA[1] / XA[2]);
      out[j * 3] = p[0]; out[j * 3 + 1] = p[1]; out[j * 3 + 2] = ((XA[2] - Z) * this.KA.f) / (this.KA.w * Z);
    }
    const RinA = mulMM(this.rotBias, mulMM(transpose(P.R), b.R));
    info.mode = 'B-only';
    info.ageMs = Math.max(0, tA - b.t) * 1000;
    const cats = Object.entries(b.bs).map(([k, v], index) => ({ categoryName: k, displayName: k, index, score: clamp01(this.mapOnly(k, v)) }));
    const matA = new Array(16).fill(0); matA[15] = 1;
    return makeResult(null, out, setMpMatrixRot(matA.map((v, i) => (i % 5 === 0 ? 1 : v)), cvToGl(RinA)), cats);
  }

  /** A's landmarks + pose interpolated to time t (null when t is outside the short history). */
  private aAt(t: number): AFrame | null {
    const h = this.hist;
    for (let i = h.length - 1; i > 0; i--) {
      const a0 = h[i - 1], a1 = h[i];
      if (a0.t <= t && t <= a1.t) {
        const k = (t - a0.t) / Math.max(1e-6, a1.t - a0.t);
        const lm = new Float64Array(N_LM * 3);
        for (let q = 0; q < lm.length; q++) lm[q] = a0.lm[q] + (a1.lm[q] - a0.lm[q]) * k;
        const R = mulMM(expSO3(scale(logSO3(mulMM(a1.R, transpose(a0.R))), k)), a0.R);
        return { t, lm, R, u: a0.u + (a1.u - a0.u) * k, v: a0.v + (a1.v - a0.v) * k, s: a0.s + (a1.s - a0.s) * k };
      }
    }
    return h.length && t < h[0].t ? h[0] : null;
  }

  /**
   * Rigid head motion over `dt` seconds from the FUSED head track's velocity (angular + centroid), about the current
   * triangulated centroid. Deliberately NOT from A's per-frame rotation difference: that would copy A's own
   * measurement noise onto B's contribution. Small velocities (below the measurement noise) count as still.
   */
  private smoothMotion(dt: number, Xs: Float64Array): Pose {
    let c: V3 = [0, 0, 0], n = 0;
    for (const i of RIGID) if (Number.isFinite(Xs[i * 3])) { c = add(c, [Xs[i * 3], Xs[i * 3 + 1], Xs[i * 3 + 2]]); n++; }
    const tr = this.track;
    this.speed = { w: 0, v: 0 };
    if (!n || tr.length < 2 || dt <= 0) return { R: I3(), t: [0, 0, 0] };
    c = scale(c, 1 / n);
    const last = tr[tr.length - 1];
    let old = tr[0];
    for (const x of tr) if (last.t - x.t >= 0.05) old = x;
    const span = last.t - old.t;
    if (span < 0.03) return { R: I3(), t: [0, 0, 0] };
    let w = scale(logSO3(mulMM(last.R, transpose(old.R))), 1 / span);
    const ct = this.ctrack;
    let v: V3 = [0, 0, 0];
    if (ct.length >= 2) { const c1 = ct[ct.length - 1]; let c0 = ct[0]; for (const x of ct) if (c1.t - x.t >= 0.06) c0 = x; if (c1.t - c0.t > 0.02) v = scale(sub(c1.c, c0.c), 1 / (c1.t - c0.t)); }
    const ws = norm(w), vs = norm(v);
    this.speed = { w: ws, v: vs };
    w = scale(w, smooth(ws, 0.06, 0.18)); v = scale(v, smooth(vs, 0.012, 0.04));
    const R = expSO3(scale(w, dt));
    return { R, t: add(sub(c, mulMV(R, c)), scale(v, dt)) };
  }

  private updateVisibility() {
    if (!this.X || !this.nrm) { this.visA.fill(1); this.visB.fill(1); return; }
    const X = this.X, n = this.nrm, P = this.P;
    const RB = P.R;
    for (let j = 0; j < N_LM; j++) {
      const x = X[j * 3], y = X[j * 3 + 1], z = X[j * 3 + 2];
      const d = Math.hypot(x, y, z) || 1;
      this.visA[j] = Math.max(0, -(n[j * 3] * x + n[j * 3 + 1] * y + n[j * 3 + 2] * z) / d);
      const q = add(mulMV(RB, [x, y, z]), P.t), nb = mulMV(RB, [n[j * 3], n[j * 3 + 1], n[j * 3 + 2]]);
      this.visB[j] = Math.max(0, -dot(nb, q) / (norm(q) || 1));
    }
  }

  /** B → A coefficient map for one channel (online least squares, shrunk toward identity). */
  private mapB(name: string, b: number, a: number, va: number, vb: number, clean: boolean): number {
    let s = this.map.get(name);
    if (!s) { s = { n: 0, mx: 0, my: 0, sxx: 0, sxy: 0 }; this.map.set(name, s); }
    if (this.learnMap && clean && va > 0.35 && vb > 0.35) {
      const k = 1 / Math.min(600, ++s.n); // ~20 s memory at 30 Hz once warmed up
      s.mx += (b - s.mx) * k; s.my += (a - s.my) * k;
      s.sxx += ((b - s.mx) ** 2 - s.sxx) * k; s.sxy += ((b - s.mx) * (a - s.my) - s.sxy) * k;
    }
    return this.mapOnly(name, b);
  }
  private mapOnly(name: string, b: number): number {
    const s = this.map.get(name);
    if (!s || s.n < 60 || s.sxx < 1e-4) return b;
    // shrink the slope toward 1 (prior weight ≈ 0.01 variance units) and clamp it to a sane range
    const slope = Math.min(2.5, Math.max(0.4, (s.sxy + 0.01) / (s.sxx + 0.01)));
    return s.my + (b - s.mx) * slope;
  }
}

// ---------------------------------------------------------------- helpers
function scaleIntr(c: StereoCalib['A'], live?: { w: number; h: number }): Intr {
  const k = live ? live.w / c.w : 1;
  return { f: c.f * k, cx: (live?.w ?? c.w) / 2, cy: (live?.h ?? c.h) / 2, w: live?.w ?? c.w, h: live?.h ?? c.h };
}
function flat(lm: ArrayLike<MpLandmark> | ArrayLike<number>): Float64Array {
  const o = new Float64Array(N_LM * 3);
  const first = (lm as ArrayLike<unknown>)[0];
  if (typeof first === 'number') { const a = lm as ArrayLike<number>; for (let i = 0; i < Math.min(o.length, a.length); i++) o[i] = a[i]; return o; }
  const L = lm as ArrayLike<MpLandmark>;
  for (let i = 0; i < Math.min(N_LM, L.length); i++) { o[i * 3] = L[i].x; o[i * 3 + 1] = L[i].y; o[i * 3 + 2] = L[i].z; }
  return o;
}
/** Rigid centroid ray (u, v normalised pinhole), rigid spread (ray units) and mean relative z. */
function rigidMeasure(lm: ArrayLike<number>, K: Intr) {
  let u = 0, v = 0, zm = 0;
  const rs: [number, number][] = [];
  for (const i of RIGID) { const r = toRay(K, lm[i * 3], lm[i * 3 + 1]); rs.push(r); u += r[0]; v += r[1]; zm += lm[i * 3 + 2]; }
  u /= RIGID.length; v /= RIGID.length; zm /= RIGID.length;
  let s = 0;
  for (const r of rs) s += (r[0] - u) ** 2 + (r[1] - v) ** 2;
  return { u, v, s: Math.sqrt(s / RIGID.length), zMean: zm };
}
const apply3 = (P: Pose, X: Float64Array, j: number): V3 => add(mulMV(P.R, [X[j * 3], X[j * 3 + 1], X[j * 3 + 2]]), P.t);
function med(a: number[]) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }
function meanOver(v: Float64Array, g: Region) { let s = 0, n = 0; for (let j = 0; j < N_LM; j++) if (REGION_OF[j] === g) { s += v[j]; n++; } return n ? s / n : 0; }
function slerpM(A: M3, B: M3, k: number): M3 { return mulMM(expSO3(scale(logSO3(mulMM(B, transpose(A))), k)), A); }
const smooth = (x: number, a: number, b: number) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
function cvToGl(R: M3): M3 { return glToCv(R); } // the conjugation by diag(1,−1,−1) is its own inverse
/** How squarely the face points at a camera (cos of the angle between the face's forward axis and the camera ray). */
function frontal(Rcam: M3, X: Float64Array, P: Pose): number {
  // MediaPipe canonical face: +z out of the face in GL = −z in CV-canonical after glToCv conjugation → forward = R·(0,0,−1)
  const fwd = normalize(mulMV(Rcam, [0, 0, -1]));
  let c: V3 = [0, 0, 0];
  for (const i of RIGID) c = add(c, [X[i * 3], X[i * 3 + 1], X[i * 3 + 2]]);
  const q = add(mulMV(P.R, scale(c, 1 / RIGID.length)), P.t);
  return Math.max(0, -dot(fwd, normalize(q)));
}
/** Face regions of A covered by a tracked hand (convex-ish hull of the hand's points, dilated). */
function occludedRegions(lm: Float64Array, hands: { x: number; y: number }[][] | null): Set<Region> {
  const out = new Set<Region>();
  if (!hands?.length) return out;
  for (const hand of hands) {
    if (!hand?.length) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of hand) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    const mx = (x1 - x0) * 0.08, my = (y1 - y0) * 0.08;
    const cnt = new Map<Region, [number, number]>();
    for (let j = 0; j < N_LM; j++) {
      const g = REGION_OF[j], c = cnt.get(g) ?? [0, 0];
      c[1]++;
      const x = lm[j * 3], y = lm[j * 3 + 1];
      if (x > x0 - mx && x < x1 + mx && y > y0 - my && y < y1 + my && insideHand(hand, x, y)) c[0]++;
      cnt.set(g, c);
    }
    for (const [g, [k, n]] of cnt) if (k / n > 0.35) out.add(g);
  }
  return out;
}
/** Point inside the hand: within the palm polygon or near a finger bone (21-point MediaPipe hand). */
function insideHand(h: { x: number; y: number }[], x: number, y: number): boolean {
  const palm = [0, 1, 5, 9, 13, 17].map((i) => h[i]).filter(Boolean);
  if (palm.length >= 3 && inPoly(palm, x, y)) return true;
  const w = Math.hypot(h[5].x - h[17].x, h[5].y - h[17].y) * 0.28; // finger half-width ≈ 28 % of the knuckle span
  for (const chain of [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]]) {
    for (let k = 0; k + 1 < chain.length; k++) { const a = h[chain[k]], b = h[chain[k + 1]]; if (a && b && segDist(a, b, x, y) < w) return true; }
  }
  return false;
}
function inPoly(P: { x: number; y: number }[], x: number, y: number) {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) if ((P[i].y > y) !== (P[j].y > y) && x < ((P[j].x - P[i].x) * (y - P[i].y)) / (P[j].y - P[i].y) + P[i].x) inside = !inside;
  return inside;
}
function segDist(a: { x: number; y: number }, b: { x: number; y: number }, x: number, y: number) {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy || 1e-12;
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L));
  return Math.hypot(a.x + dx * t - x, a.y + dy * t - y);
}
function makeResult(a: MpFace | null, lm: Float64Array, mat: number[], cats: MpCategory[]): MpFace {
  const pts: MpLandmark[] = [];
  for (let j = 0; j < N_LM; j++) pts.push({ x: lm[j * 3], y: lm[j * 3 + 1], z: lm[j * 3 + 2], visibility: 1 });
  return {
    ...(a ?? {}),
    faceLandmarks: [pts],
    faceBlendshapes: [{ categories: cats, headIndex: 0, headName: '' }],
    facialTransformationMatrixes: [{ rows: 4, columns: 4, data: mat }],
  };
}
void quatFromM; void mFromQuat;
