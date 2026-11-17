// "My face model": the trainer. Pure (no DOM, no globals): runs in a worker or in Node. Adam with decoupled weight decay,
// mini-batches, crop jitter (shift / scale / brightness / contrast; the right eye's mirroring is implicit because one eye net
// sees both eyes), and early stopping on held-out frames cut in TIME BLOCKS (every 4th block, with a guard gap, as learnMeFit
// does) so neighbouring video frames never leak across the split. The held-out blocks alternate between two DISJOINT sets:
// 'select' (the only held-out frames the trainer reads: it picks each net's best epoch on them) and 'judge' (never read here:
// evaluate.ts alone decides adoption on them, so the choice of epoch cannot have been tuned to the frames that judge it).
// Same seed + same frames => identical weights.
//
// Budget: 6,000 frames x 3 crops in < 90 s on one Node core with the defaults (tools/facenet_unit.ts prints the number).
import { EYE_H, EYE_W, MOUTH_H, MOUTH_W } from './crops.ts';
import { EYE_IDX, FaceNet, MOUTH_IDX, bceLoss, gauss, rng32, type RegionNet } from './net.ts';
import type { FaceFrame } from './types.ts';

export interface TrainOpts {
  seed?: number;
  /** epochs of `perEpoch` frame visits each (each frame feeds the eye net twice, the mouth net once) */
  epochs?: number; perEpoch?: number; batch?: number;
  lr?: number; weightDecay?: number; clip?: number;
  /** early stopping: epochs without a held-out improvement */
  patience?: number;
  /** crop jitter: max shift (px), scale spread, brightness (grey-level std units) and contrast spread; featNoise = noise on standardised features */
  jitter?: boolean; shiftPx?: number; scale?: number; bright?: number; contrast?: number; featNoise?: number;
  /** time-block split; selectCap = at most this many select frames are scored per epoch (strided) */
  blockS?: number; holdEvery?: number; guardS?: number; selectCap?: number;
  /** replaces the time-block split: gets the labelled frames' times, returns index lists into them (the teach routine cuts on its own
   *  segments, teach.ts routineSplit). Overlapping lists are refused: the judge guarantee below depends on disjointness. */
  split?: (t: ArrayLike<number>) => { train: number[]; select: number[]; judge: number[] };
  /** wall-clock stop in ms (0 = none; a stop on time is the one thing that makes a run non-reproducible) */
  maxMs?: number;
  /** false = train the landmark-only MLP baseline instead of the hybrid */
  cnn?: boolean;
  /** continue from this net (personal fine-tune) instead of a fresh init */
  init?: FaceNet;
  log?: (s: string) => void;
  /** called after every epoch (1-based) with the epoch budget: progress bars */
  onEpoch?: (epoch: number, epochs: number) => void;
}
export interface NetReport { best: number; bestEpoch: number; epochs: number; stoppedEarly: boolean; hist: { train: number; val: number }[] }
export interface TrainReport { ms: number; nTrain: number; nSelect: number; nJudge: number; epochs: number; eye: NetReport; mouth: NetReport; stoppedBy: 'epochs' | 'patience' | 'time' }
/** `select` picked the epochs; `judge` is untouched by training and goes to evaluate.ts (the adoption test) and nothing else. */
export interface TrainResult { net: FaceNet; report: TrainReport; train: FaceFrame[]; select: FaceFrame[]; judge: FaceFrame[] }

/** Frames cut into `blockS`-second blocks; every `holdEvery`-th block (offset `phase`) is held out, alternately into `select` (the
 *  1st, 3rd ... held block) and `judge` (the 2nd, 4th ...); `guardS` either side of a held block (and the block before it) is
 *  dropped. `held` = select + judge, sorted. All index lists are disjoint. */
export function splitTimeBlocks(t: ArrayLike<number>, blockS = 15, holdEvery = 4, phase = holdEvery - 1, guardS = 1) {
  const train: number[] = [], select: number[] = [], judge: number[] = [], held: number[] = [];
  if (!t.length) return { train, select, judge, held };
  const t0 = t[0];
  for (let i = 0; i < t.length; i++) {
    const u = (t[i] - t0) / blockS, b = Math.floor(u), frac = (u - b) * blockS;
    const isHeld = b % holdEvery === phase;
    const nearEdge = frac < guardS || frac > blockS - guardS;
    if (nearEdge && (isHeld || (b + 1) % holdEvery === phase || (b - 1 + holdEvery) % holdEvery === phase)) continue;
    if (!isHeld) { train.push(i); continue; }
    held.push(i);
    (Math.floor(b / holdEvery) % 2 ? judge : select).push(i);
  }
  return { train, select, judge, held };
}

/** dst = bilinear resample of src shifted by (dx, dy) px and scaled by `sc` about the centre (replicate border), then * gain + bias. */
function jitterCrop(src: Float32Array, W: number, H: number, dx: number, dy: number, sc: number, gain: number, bias: number, dst: Float32Array) {
  const cx = (W - 1) / 2, cy = (H - 1) / 2;
  for (let y = 0; y < H; y++) {
    let sy = cy + (y - cy) / sc - dy;
    sy = sy < 0 ? 0 : sy > H - 1 ? H - 1 : sy;
    const y0 = Math.min(H - 2, Math.floor(sy)), fy = sy - y0;
    for (let x = 0; x < W; x++) {
      let sx = cx + (x - cx) / sc - dx;
      sx = sx < 0 ? 0 : sx > W - 1 ? W - 1 : sx;
      const x0 = Math.min(W - 2, Math.floor(sx)), fx = sx - x0, i = y0 * W + x0;
      const top = src[i] + (src[i + 1] - src[i]) * fx, bot = src[i + W] + (src[i + W + 1] - src[i + W]) * fx;
      dst[y * W + x] = (top + (bot - top) * fy) * gain + bias;
    }
  }
}

class Learner {
  m: Float32Array; v: Float32Array; t = 0;
  best = Infinity; bestEpoch = -1; bestW: Float32Array; bad = 0; done = false;
  hist: { train: number; val: number }[] = [];
  tl = 0; tn = 0;
  constructor(readonly net: RegionNet) { this.m = new Float32Array(net.nParams); this.v = new Float32Array(net.nParams); this.bestW = net.w.slice(); }
  /** one Adam step on the gradient accumulated over `bs` samples (global-norm clipped), AdamW decay on weight tensors, then clear g */
  step(lr: number, wd: number, bs: number, clip: number) {
    const { w, g } = this.net, n = w.length, b1 = 0.9, b2 = 0.999, inv = 1 / bs;
    let n2 = 0;
    for (let i = 0; i < n; i++) { const q = g[i] * inv; n2 += q * q; }
    const sc = clip > 0 && n2 > clip * clip ? clip / Math.sqrt(n2) : 1, k = inv * sc;
    this.t++;
    lr *= Math.min(1, this.t / 30); // warm-up: a cold net's first coherent steps otherwise kill its first FC layer
    const c1 = 1 - Math.pow(b1, this.t), c2 = 1 - Math.pow(b2, this.t);
    for (let i = 0; i < n; i++) {
      const q = g[i] * k;
      const m = (this.m[i] = b1 * this.m[i] + (1 - b1) * q), v = (this.v[i] = b2 * this.v[i] + (1 - b2) * q * q);
      w[i] -= lr * (m / c1) / (Math.sqrt(v / c2) + 1e-8);
    }
    if (wd > 0) for (const t of this.net.tensors) if (t.decay) for (let i = t.off; i < t.off + t.len; i++) w[i] -= lr * wd * w[i];
    g.fill(0);
  }
}

/**
 * Train the pair of nets on teacher-labelled frames (frames with `teacher === null` are skipped). Only the `select` blocks gate
 * early stopping here; the adopt decision against MediaPipe is evaluate.ts's job, on the returned `judge` frames, which nothing
 * in this function reads (not the weights, the feature standardisation, the output prior nor the epoch choice).
 */
export function trainFaceNet(all: FaceFrame[], o: TrainOpts = {}): TrainResult {
  const t0 = performance.now();
  const frames = all.filter((f) => f.teacher);
  const tt = frames.map((f) => f.t);
  const { train: trI, select: seI, judge: juI } = o.split ? o.split(tt) : splitTimeBlocks(tt, o.blockS ?? 15, o.holdEvery ?? 4, undefined, o.guardS ?? 1);
  if (o.split) { const seen = new Set<number>(); for (const i of [...trI, ...seI, ...juI]) { if (seen.has(i) || !(i >= 0 && i < frames.length)) throw new Error('faceNet: the custom split overlaps or is out of range'); seen.add(i); } }
  const train = trI.map((i) => frames[i]), select = seI.map((i) => frames[i]), judge = juI.map((i) => frames[i]);
  if (train.length < 30) throw new Error('faceNet: not enough teacher frames to train (' + train.length + ')');
  const seed = o.seed ?? 1, rnd = rng32(seed * 7919 + 13);
  const net = o.init ?? new FaceNet(seed, { cnn: o.cnn !== false });
  const nE = EYE_IDX.Left.length, nM = MOUTH_IDX.length;
  // feature standardisation + output prior from the training split (a fine-tune keeps the net's own)
  if (!o.init) {
    const stat = (nf: number, rows: Float32Array[]) => {
      const mean = new Float64Array(nf), sd = new Float64Array(nf);
      for (const r of rows) for (let i = 0; i < nf; i++) mean[i] += r[i];
      for (let i = 0; i < nf; i++) mean[i] /= rows.length;
      for (const r of rows) for (let i = 0; i < nf; i++) sd[i] += (r[i] - mean[i]) ** 2;
      for (let i = 0; i < nf; i++) sd[i] = Math.sqrt(sd[i] / rows.length);
      return { mean, sd };
    };
    const eyeRows = train.flatMap((f) => [f.fEyeL, f.fEyeR]);
    const es = stat(net.eye.cfg.nFeat, eyeRows), ms = stat(net.mouth.cfg.nFeat, train.map((f) => f.fMouth));
    net.eye.setFeatureNorm(es.mean, es.sd); net.mouth.setFeatureNorm(ms.mean, ms.sd);
    // standardise the pooled conv outputs too (over a strided sample of the training crops, both eyes for the eye net)
    const st = Math.max(1, Math.floor(train.length / 200)), cal = train.filter((_, i) => i % st === 0);
    net.eye.calibrateGap(cal.flatMap((f) => [f.eyeL, f.eyeR]), cal.flatMap((f) => [f.fEyeL, f.fEyeR]));
    net.mouth.calibrateGap(cal.map((f) => f.mouth), cal.map((f) => f.fMouth));
    const em = new Float64Array(nE), mm = new Float64Array(nM);
    for (const f of train) {
      for (let k = 0; k < nE; k++) em[k] += (f.teacher![EYE_IDX.Left[k]] + f.teacher![EYE_IDX.Right[k]]) / 2;
      for (let k = 0; k < nM; k++) mm[k] += f.teacher![MOUTH_IDX[k]];
    }
    net.eye.setOutputPrior(em.map((v) => v / train.length)); net.mouth.setOutputPrior(mm.map((v) => v / train.length));
  }
  const eyeL = new Learner(net.eye), mouthL = new Learner(net.mouth);
  const epochs = o.epochs ?? 24, perEpoch = Math.min(o.perEpoch ?? 1200, Math.max(train.length, 1)), B = o.batch ?? 24;
  const lr0 = o.lr ?? 0.001, wd = o.weightDecay ?? 0.01, clip = o.clip ?? 5, patience = o.patience ?? 5;
  const jit = o.jitter !== false, shiftPx = o.shiftPx ?? 1.5, scaleSd = o.scale ?? 0.06, brightSd = o.bright ?? 0.12, contrastSd = o.contrast ?? 0.1, fnoise = o.featNoise ?? 0.03;
  const hasSel = select.length >= 20;
  const selStride = hasSel ? Math.max(1, Math.ceil(select.length / (o.selectCap ?? 1200))) : 1;
  const sE = new Float32Array(EYE_W * EYE_H), sM = new Float32Array(MOUTH_W * MOUTH_H);
  const sF = new Float32Array(Math.max(net.eye.cfg.nFeat, net.mouth.cfg.nFeat));
  const tgt = new Float32Array(Math.max(nE, nM)), dz = new Float32Array(Math.max(nE, nM));
  const dzE = dz.subarray(0, nE), dzM = dz.subarray(0, nM), tE = tgt.subarray(0, nE), tM = tgt.subarray(0, nM);
  const eyeT = (f: FaceFrame, side: 'Left' | 'Right') => { for (let k = 0; k < nE; k++) { const v = f.teacher![EYE_IDX[side][k]]; tE[k] = v < 0 ? 0 : v > 1 ? 1 : v; } };
  const mouthT = (f: FaceFrame) => { for (let k = 0; k < nM; k++) { const v = f.teacher![MOUTH_IDX[k]]; tM[k] = v < 0 ? 0 : v > 1 ? 1 : v; } };

  // one training sample through a net: jitter the crop, noise the features, forward, loss, backward (accumulates)
  const sample = (L: Learner, crop: Float32Array, feat: Float32Array, W: number, H: number, buf: Float32Array, t: Float32Array, dzv: Float32Array) => {
    let x = crop;
    if (jit) {
      jitterCrop(crop, W, H, (rnd() * 2 - 1) * shiftPx, (rnd() * 2 - 1) * shiftPx, 1 + gauss(rnd) * scaleSd, 1 + gauss(rnd) * contrastSd, gauss(rnd) * brightSd, buf);
      x = buf;
    }
    let f = feat;
    if (fnoise > 0) {
      const nf = feat.length;
      for (let i = 0; i < nf; i++) sF[i] = feat[i] + gauss(rnd) * fnoise * L.net.fs[i];
      f = sF.subarray(0, nf);
    }
    const out = L.net.forward(x, f);
    L.tl += bceLoss(L.net.z5, t, dzv) / out.length; L.tn++;
    L.net.backward(dzv);
  };
  const selectLoss = (L: Learner, which: 'eye' | 'mouth') => {
    let s = 0, n = 0;
    for (let i = 0; i < select.length; i += selStride) {
      const f = select[i];
      if (which === 'eye') {
        for (const side of ['Left', 'Right'] as const) { eyeT(f, side); L.net.forward(side === 'Left' ? f.eyeL : f.eyeR, side === 'Left' ? f.fEyeL : f.fEyeR); s += bceLoss(L.net.z5, tE, dzE) / nE; n++; }
      } else { mouthT(f); L.net.forward(f.mouth, f.fMouth); s += bceLoss(L.net.z5, tM, dzM) / nM; n++; }
    }
    return s / Math.max(1, n);
  };

  let order = shuffled(train.length, rnd), ptr = 0, stoppedBy: TrainReport['stoppedBy'] = 'epochs', ep = 0;
  for (; ep < epochs; ep++) {
    const lr = lr0 * (0.1 + 0.9 * 0.5 * (1 + Math.cos(Math.PI * ep / epochs)));
    eyeL.tl = eyeL.tn = mouthL.tl = mouthL.tn = 0;
    for (let done = 0; done < perEpoch;) {
      const bs = Math.min(B, perEpoch - done);
      for (let b = 0; b < bs; b++) {
        if (ptr >= order.length) { order = shuffled(train.length, rnd); ptr = 0; }
        const f = train[order[ptr++]];
        if (!eyeL.done) {
          eyeT(f, 'Left'); sample(eyeL, f.eyeL, f.fEyeL, EYE_W, EYE_H, sE, tE, dzE);
          eyeT(f, 'Right'); sample(eyeL, f.eyeR, f.fEyeR, EYE_W, EYE_H, sE, tE, dzE);
        }
        if (!mouthL.done) { mouthT(f); sample(mouthL, f.mouth, f.fMouth, MOUTH_W, MOUTH_H, sM, tM, dzM); }
      }
      if (!eyeL.done) eyeL.step(lr, wd, 2 * bs, clip);
      if (!mouthL.done) mouthL.step(lr, wd, bs, clip);
      done += bs;
    }
    for (const [L, which] of [[eyeL, 'eye'], [mouthL, 'mouth']] as const) {
      if (L.done) continue;
      const val = hasSel ? selectLoss(L, which) : NaN;
      L.hist.push({ train: L.tl / Math.max(1, L.tn), val });
      if (!hasSel) { L.best = L.tl / Math.max(1, L.tn); L.bestEpoch = ep; L.bestW.set(L.net.w); continue; }
      if (val < L.best - 1e-5) { L.best = val; L.bestEpoch = ep; L.bestW.set(L.net.w); L.bad = 0; } else if (++L.bad >= patience) L.done = true;
    }
    o.onEpoch?.(ep + 1, epochs);
    o.log?.(`epoch ${ep + 1}/${epochs}  eye ${fmt(eyeL)}  mouth ${fmt(mouthL)}`);
    if (hasSel && eyeL.done && mouthL.done) { stoppedBy = 'patience'; ep++; break; }
    if (o.maxMs && performance.now() - t0 > o.maxMs) { stoppedBy = 'time'; ep++; break; }
  }
  // each net keeps its best select-epoch's weights
  for (const L of [eyeL, mouthL]) if (L.bestEpoch >= 0) L.net.w.set(L.bestW);
  const rep = (L: Learner): NetReport => ({ best: L.best, bestEpoch: L.bestEpoch, epochs: L.hist.length, stoppedEarly: L.done, hist: L.hist });
  return { net, train, select, judge, report: { ms: performance.now() - t0, nTrain: train.length, nSelect: select.length, nJudge: judge.length, epochs: ep, eye: rep(eyeL), mouth: rep(mouthL), stoppedBy } };
}
const fmt = (L: Learner) => { const h = L.hist[L.hist.length - 1]; return h ? `${h.train.toFixed(4)}/${Number.isNaN(h.val) ? '-' : h.val.toFixed(4)}` : 'done'; };
function shuffled(n: number, rnd: () => number) {
  const a = new Int32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}
