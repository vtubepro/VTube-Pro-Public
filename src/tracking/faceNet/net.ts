// "My face model": the network. A tiny CNN + landmark-feature MLP hybrid per region, forward AND backward in plain TS on
// Float32Array (no framework, no WASM), so the same code trains in a worker / Node and runs on the tracking thread.
//
//   crop -> conv3x3(8) -> ReLU -> maxpool2 -> conv3x3(16) -> ReLU -> maxpool2 -> conv3x3(24) -> ReLU -> global avg pool
//   [gap(24) | geometry features], each standardised (fixed mean / std stored with the weights) -> FC(32) -> ReLU -> FC(out) -> sigmoid
//
// Convolutions are 'valid' (no padding) to keep the forward under 2 ms for all three crops. One EYE net serves both eyes
// (the right eye's crop is mirrored onto the left's frame, crops.ts) and predicts that side's eyeBlink / eyeSquint /
// eyeWide / browDown / browOuterUp plus its read of the shared browInnerUp; one MOUTH net predicts the jaw / mouth / cheek
// channels. Everything lives in one flat parameter vector (+ the feature standardisation), serialised as base64 Float32
// (~65 KB for both nets). The forward allocates nothing after construction.
import { ARKIT } from '../../core/arkit.ts';
import { EYE_H, EYE_W, MOUTH_H, MOUTH_W, NF_EYE, NF_MOUTH, type FaceCrops } from './crops.ts';

export const NET_VERSION = 1;
const CLAMP_IN = 8;

export interface NetCfg { inW: number; inH: number; nFeat: number; nOut: number; /** false = landmark-only MLP (the DeNA baseline) */ cnn: boolean; c1: number; c2: number; c3: number; hid: number }

export { EYE_IDX, EYE_OUT, FACENET_CHANNELS, MOUTH_IDX } from './channels.ts';
import { EYE_IDX, FACENET_CHANNELS, MOUTH_IDX } from './channels.ts';

export const eyeCfg = (cnn = true): NetCfg => ({ inW: EYE_W, inH: EYE_H, nFeat: NF_EYE, nOut: EYE_IDX.Left.length, cnn, c1: 8, c2: 16, c3: 24, hid: 32 });
export const mouthCfg = (cnn = true): NetCfg => ({ inW: MOUTH_W, inH: MOUTH_H, nFeat: NF_MOUTH, nOut: MOUTH_IDX.length, cnn, c1: 8, c2: 16, c3: 24, hid: 32 });

/** Deterministic PRNG (mulberry32) + a Gaussian from it. */
export function rng32(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function gauss(r: () => number) { return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()); }

interface Tensor { name: string; off: number; len: number; decay: boolean }
function layout(c: NetCfg) {
  const t: Tensor[] = [];
  let off = 0;
  const add = (name: string, len: number, decay: boolean) => { t.push({ name, off, len, decay }); off += len; };
  const nIn = (c.cnn ? c.c3 : 0) + c.nFeat;
  if (c.cnn) { add('c1w', c.c1 * 9, true); add('c1b', c.c1, false); add('c2w', c.c2 * c.c1 * 9, true); add('c2b', c.c2, false); add('c3w', c.c3 * c.c2 * 9, true); add('c3b', c.c3, false); }
  add('f1w', c.hid * nIn, true); add('f1b', c.hid, false); add('f2w', c.nOut * c.hid, true); add('f2b', c.nOut, false);
  return { tensors: t, nParams: off, nIn };
}

// ---- layers (valid 3x3 conv, fused relu + 2x2 max pool) ----

/** out[o] = b[o] + sum_c in[c] * w[o][c] (valid 3x3). in: ic planes of iw x ih; out: oc planes of (iw-2) x (ih-2). */
function conv3(inp: Float32Array, ic: number, iw: number, ih: number, w: Float32Array, wo: number, b: Float32Array, bo: number, oc: number, out: Float32Array) {
  const ow = iw - 2, oh = ih - 2, on = ow * oh;
  for (let o = 0; o < oc; o++) {
    const ob = o * on, bv = b[bo + o];
    for (let i = 0; i < on; i++) out[ob + i] = bv;
    for (let c = 0; c < ic; c++) {
      const wb = wo + (o * ic + c) * 9, w0 = w[wb], w1 = w[wb + 1], w2 = w[wb + 2], w3 = w[wb + 3], w4 = w[wb + 4], w5 = w[wb + 5], w6 = w[wb + 6], w7 = w[wb + 7], w8 = w[wb + 8];
      const ib = c * iw * ih;
      for (let y = 0; y < oh; y++) {
        const r0 = ib + y * iw, r1 = r0 + iw, r2 = r1 + iw, q = ob + y * ow;
        for (let x = 0; x < ow; x++)
          out[q + x] += w0 * inp[r0 + x] + w1 * inp[r0 + x + 1] + w2 * inp[r0 + x + 2] + w3 * inp[r1 + x] + w4 * inp[r1 + x + 1] + w5 * inp[r1 + x + 2] + w6 * inp[r2 + x] + w7 * inp[r2 + x + 1] + w8 * inp[r2 + x + 2];
      }
    }
  }
}
/** Gradients of conv3: weight / bias into g (accumulated), input into dIn (accumulated; skipped when null). dz = d loss / d conv output. */
function conv3Back(inp: Float32Array, ic: number, iw: number, ih: number, w: Float32Array, wo: number, bo: number, oc: number, dz: Float32Array, g: Float32Array, dIn: Float32Array | null) {
  const ow = iw - 2, oh = ih - 2, on = ow * oh;
  for (let o = 0; o < oc; o++) {
    const ob = o * on;
    let gb = 0;
    for (let i = 0; i < on; i++) gb += dz[ob + i];
    g[bo + o] += gb;
    for (let c = 0; c < ic; c++) {
      const wb = wo + (o * ic + c) * 9, ib = c * iw * ih;
      let g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0, g8 = 0;
      const w0 = w[wb], w1 = w[wb + 1], w2 = w[wb + 2], w3 = w[wb + 3], w4 = w[wb + 4], w5 = w[wb + 5], w6 = w[wb + 6], w7 = w[wb + 7], w8 = w[wb + 8];
      for (let y = 0; y < oh; y++) {
        const r0 = ib + y * iw, r1 = r0 + iw, r2 = r1 + iw, q = ob + y * ow;
        for (let x = 0; x < ow; x++) {
          const d = dz[q + x];
          if (d === 0) continue;
          const a = r0 + x, b = r1 + x, e = r2 + x;
          g0 += d * inp[a]; g1 += d * inp[a + 1]; g2 += d * inp[a + 2]; g3 += d * inp[b]; g4 += d * inp[b + 1]; g5 += d * inp[b + 2]; g6 += d * inp[e]; g7 += d * inp[e + 1]; g8 += d * inp[e + 2];
          if (dIn) {
            dIn[a] += w0 * d; dIn[a + 1] += w1 * d; dIn[a + 2] += w2 * d; dIn[b] += w3 * d; dIn[b + 1] += w4 * d; dIn[b + 2] += w5 * d; dIn[e] += w6 * d; dIn[e + 1] += w7 * d; dIn[e + 2] += w8 * d;
          }
        }
      }
      g[wb] += g0; g[wb + 1] += g1; g[wb + 2] += g2; g[wb + 3] += g3; g[wb + 4] += g4; g[wb + 5] += g5; g[wb + 6] += g6; g[wb + 7] += g7; g[wb + 8] += g8;
    }
  }
}
/** ReLU + 2x2 max pool (odd trailing row / column dropped); idx = the winning conv-output index per pooled cell. */
function poolRelu(z: Float32Array, ch: number, w: number, h: number, out: Float32Array, idx: Int32Array) {
  const pw = w >> 1, ph = h >> 1;
  let k = 0;
  for (let c = 0; c < ch; c++) {
    const cb = c * w * h;
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++, k++) {
      const i0 = cb + 2 * y * w + 2 * x, i1 = i0 + w;
      let bi = i0, bv = z[i0];
      if (z[i0 + 1] > bv) { bv = z[i0 + 1]; bi = i0 + 1; }
      if (z[i1] > bv) { bv = z[i1]; bi = i1; }
      if (z[i1 + 1] > bv) { bv = z[i1 + 1]; bi = i1 + 1; }
      out[k] = bv > 0 ? bv : 0; idx[k] = bi;
    }
  }
}

export class RegionNet {
  readonly cfg: NetCfg;
  readonly tensors: Tensor[];
  readonly nParams: number;
  /** parameters / gradients (flat) and the standardisation of the FC input [gap | features] (stored with the weights, not
   *  trained by SGD: without it the unbounded pooled conv outputs swamp the features and kill the first FC layer) */
  w: Float32Array; g: Float32Array; fm: Float32Array; fs: Float32Array;
  readonly nIn: number;
  /** result of the last forward: sigmoid outputs (nOut); logits are in `z5` */
  out: Float32Array; z5: Float32Array;
  /** gradient wrt the standardised-then-unstandardised features / the crop, from the last backward */
  dfeat: Float32Array; dx: Float32Array;
  private o: Record<string, number> = {};
  private d: { a1w: number; a1h: number; p1w: number; p1h: number; a2w: number; a2h: number; p2w: number; p2h: number; a3w: number; a3h: number };
  private z1!: Float32Array; private p1!: Float32Array; private i1!: Int32Array;
  private z2!: Float32Array; private p2!: Float32Array; private i2!: Int32Array;
  private z3!: Float32Array; private gap!: Float32Array;
  private fin: Float32Array; private fz: Float32Array; private fh: Float32Array;
  private dz5: Float32Array; private dfin: Float32Array; private dfz: Float32Array; private dgap!: Float32Array;
  private dz3!: Float32Array; private dp2!: Float32Array; private dz2!: Float32Array; private dp1!: Float32Array; private dz1!: Float32Array;
  private lastX: Float32Array | null = null;
  private nrm: Float32Array;

  /** `f64` = float64 storage (the gradient check only; production is Float32). */
  constructor(cfg: NetCfg, seed = 1, f64 = false) {
    this.cfg = { ...cfg };
    const lay = layout(cfg);
    this.tensors = lay.tensors; this.nParams = lay.nParams; this.nIn = lay.nIn;
    for (const t of this.tensors) this.o[t.name] = t.off;
    const A = (n: number) => (f64 ? new Float64Array(n) : new Float32Array(n)) as unknown as Float32Array;
    this.w = A(this.nParams); this.g = A(this.nParams); this.fm = A(this.nIn); this.fs = A(this.nIn).fill(1);
    this.out = A(cfg.nOut); this.z5 = A(cfg.nOut); this.dfeat = A(cfg.nFeat); this.dx = A(cfg.inW * cfg.inH);
    this.nrm = A(this.nIn);
    const aw = (w: number) => w - 2, ah = (h: number) => h - 2, a1w = aw(cfg.inW), a1h = ah(cfg.inH), p1w = a1w >> 1, p1h = a1h >> 1;
    const a2w = aw(p1w), a2h = ah(p1h), p2w = a2w >> 1, p2h = a2h >> 1, a3w = aw(p2w), a3h = ah(p2h);
    this.d = { a1w, a1h, p1w, p1h, a2w, a2h, p2w, p2h, a3w, a3h };
    if (cfg.cnn) {
      this.z1 = A(cfg.c1 * a1w * a1h); this.p1 = A(cfg.c1 * p1w * p1h); this.i1 = new Int32Array(this.p1.length);
      this.z2 = A(cfg.c2 * a2w * a2h); this.p2 = A(cfg.c2 * p2w * p2h); this.i2 = new Int32Array(this.p2.length);
      this.z3 = A(cfg.c3 * a3w * a3h); this.gap = A(cfg.c3); this.dgap = A(cfg.c3);
      this.dz3 = A(this.z3.length); this.dp2 = A(this.p2.length); this.dz2 = A(this.z2.length); this.dp1 = A(this.p1.length); this.dz1 = A(this.z1.length);
    }
    this.fin = A(this.nIn); this.fz = A(cfg.hid); this.fh = A(cfg.hid);
    this.dz5 = A(cfg.nOut); this.dfin = A(this.nIn); this.dfz = A(cfg.hid);
    this.init(seed);
  }

  /** He-normal weights (seeded), zero biases, a small output scale and a low output prior. */
  init(seed: number) {
    const r = rng32(seed), c = this.cfg;
    this.w.fill(0); this.g.fill(0);
    for (const t of this.tensors) {
      if (!t.name.endsWith('w')) continue;
      const fanIn = t.name === 'c1w' ? 9 : t.name === 'c2w' ? c.c1 * 9 : t.name === 'c3w' ? c.c2 * 9 : t.name === 'f1w' ? this.nIn : c.hid;
      const sd = Math.sqrt((t.name === 'f2w' ? 1 : 2) / fanIn);
      for (let i = 0; i < t.len; i++) this.w[t.off + i] = gauss(r) * sd;
    }
    this.w.fill(-1.5, this.o.f2b, this.o.f2b + c.nOut);
  }
  /** Start each output at the logit of its training mean (fast convergence, and a sane answer from step 0). */
  setOutputPrior(mean: ArrayLike<number>) {
    for (let k = 0; k < this.cfg.nOut; k++) { const p = Math.min(0.98, Math.max(0.02, mean[k])); this.w[this.o.f2b + k] = Math.log(p / (1 - p)); }
  }
  /** standardisation of the geometry features (the part of the FC input after the pooled conv outputs) */
  setFeatureNorm(mean: ArrayLike<number>, std: ArrayLike<number>) {
    const nc = this.cfg.cnn ? this.cfg.c3 : 0;
    for (let i = 0; i < this.cfg.nFeat; i++) { this.fm[nc + i] = mean[i]; this.fs[nc + i] = std[i] > 1e-6 ? std[i] : 1; }
  }
  /** Data-dependent init: standardise the pooled conv outputs over some sample crops (as the network is right now). */
  calibrateGap(xs: Float32Array[], feats: Float32Array[]) {
    if (!this.cfg.cnn || !xs.length) return;
    const nc = this.cfg.c3, mean = new Float64Array(nc), sd = new Float64Array(nc);
    const gaps = xs.map((x, i) => { this.forward(x, feats[i]); return Float64Array.from(this.gap); });
    for (const g of gaps) for (let j = 0; j < nc; j++) mean[j] += g[j] / gaps.length;
    for (const g of gaps) for (let j = 0; j < nc; j++) sd[j] += (g[j] - mean[j]) ** 2 / gaps.length;
    for (let j = 0; j < nc; j++) { this.fm[j] = mean[j]; this.fs[j] = Math.sqrt(sd[j]) > 1e-3 ? Math.sqrt(sd[j]) : 1; }
  }

  /** x: the normalised crop (inW * inH), feat: raw geometry features. Returns the shared `out` (sigmoid, nOut). No allocation. */
  forward(x: Float32Array, feat: Float32Array): Float32Array {
    const c = this.cfg, w = this.w, o = this.o, d = this.d, fin = this.fin;
    this.lastX = x;
    let nc = 0;
    if (c.cnn) {
      conv3(x, 1, c.inW, c.inH, w, o.c1w, w, o.c1b, c.c1, this.z1);
      poolRelu(this.z1, c.c1, d.a1w, d.a1h, this.p1, this.i1);
      conv3(this.p1, c.c1, d.p1w, d.p1h, w, o.c2w, w, o.c2b, c.c2, this.z2);
      poolRelu(this.z2, c.c2, d.a2w, d.a2h, this.p2, this.i2);
      conv3(this.p2, c.c2, d.p2w, d.p2h, w, o.c3w, w, o.c3b, c.c3, this.z3);
      const n3 = d.a3w * d.a3h;
      for (let ch = 0; ch < c.c3; ch++) {
        let s = 0;
        const b = ch * n3;
        for (let i = 0; i < n3; i++) { const v = this.z3[b + i]; if (v > 0) s += v; }
        fin[ch] = this.gap[ch] = s / n3;
      }
      nc = c.c3;
    }
    for (let i = 0; i < c.nFeat; i++) fin[nc + i] = feat[i];
    const nIn = this.nIn;
    for (let i = 0; i < nIn; i++) { const v = (fin[i] - this.fm[i]) / this.fs[i]; this.nrm[i] = v; fin[i] = v > CLAMP_IN ? CLAMP_IN : v < -CLAMP_IN ? -CLAMP_IN : v; }
    for (let j = 0; j < c.hid; j++) {
      let s = w[o.f1b + j];
      const wb = o.f1w + j * nIn;
      for (let i = 0; i < nIn; i++) s += w[wb + i] * fin[i];
      this.fz[j] = s; this.fh[j] = s > 0 ? s : 0;
    }
    for (let k = 0; k < c.nOut; k++) {
      let s = w[o.f2b + k];
      const wb = o.f2w + k * c.hid;
      for (let j = 0; j < c.hid; j++) s += w[wb + j] * this.fh[j];
      this.z5[k] = s; this.out[k] = 1 / (1 + Math.exp(-s));
    }
    return this.out;
  }

  /** Accumulate d loss / d parameters into `g`, given dz = d loss / d logit (nOut) for the sample just run through `forward`.
   *  `wantInput` also computes `dx` (the crop gradient; the first conv layer's data path is otherwise skipped). */
  backward(dz: ArrayLike<number>, wantInput = false) {
    const c = this.cfg, w = this.w, g = this.g, o = this.o, d = this.d, nIn = this.nIn, fin = this.fin;
    this.dfin.fill(0);
    this.dfz.fill(0);
    for (let k = 0; k < c.nOut; k++) {
      const dk = dz[k];
      this.dz5[k] = dk;
      g[o.f2b + k] += dk;
      const wb = o.f2w + k * c.hid;
      for (let j = 0; j < c.hid; j++) { g[wb + j] += dk * this.fh[j]; this.dfz[j] += w[wb + j] * dk; }
    }
    for (let j = 0; j < c.hid; j++) {
      const dj = this.fz[j] > 0 ? this.dfz[j] : 0;
      if (dj === 0) continue;
      g[o.f1b + j] += dj;
      const wb = o.f1w + j * nIn;
      for (let i = 0; i < nIn; i++) { g[wb + i] += dj * fin[i]; this.dfin[i] += w[wb + i] * dj; }
    }
    const nc = c.cnn ? c.c3 : 0;
    // through the (fixed) standardisation: d raw = d input / std, zero where the clamp saturated
    for (let i = 0; i < nIn; i++) { const v = this.nrm[i]; this.dfin[i] = v > CLAMP_IN || v < -CLAMP_IN ? 0 : this.dfin[i] / this.fs[i]; }
    for (let i = 0; i < c.nFeat; i++) this.dfeat[i] = this.dfin[nc + i];
    if (!c.cnn) return;
    const n3 = d.a3w * d.a3h, x = this.lastX!;
    for (let ch = 0; ch < c.c3; ch++) {
      const dg = this.dfin[ch] / n3, b = ch * n3;
      for (let i = 0; i < n3; i++) this.dz3[b + i] = this.z3[b + i] > 0 ? dg : 0;
    }
    this.dp2.fill(0);
    conv3Back(this.p2, c.c2, d.p2w, d.p2h, w, o.c3w, o.c3b, c.c3, this.dz3, g, this.dp2);
    unpool(this.dp2, this.p2, this.i2, this.dz2);
    this.dp1.fill(0);
    conv3Back(this.p1, c.c1, d.p1w, d.p1h, w, o.c2w, o.c2b, c.c2, this.dz2, g, this.dp1);
    unpool(this.dp1, this.p1, this.i1, this.dz1);
    if (wantInput) this.dx.fill(0);
    conv3Back(x, 1, c.inW, c.inH, w, o.c1w, o.c1b, c.c1, this.dz1, g, wantInput ? this.dx : null);
  }
}
function unpool(dp: Float32Array, p: Float32Array, idx: Int32Array, dz: Float32Array) {
  dz.fill(0);
  for (let k = 0; k < p.length; k++) if (p[k] > 0) dz[idx[k]] = dp[k];
}

/** Weighted binary cross-entropy of sigmoid(z) against soft targets in 0..1, from the LOGITS z (RegionNet.z5): softplus(z) - t z,
 *  computed without a probability clamp, so the loss and its gradient dz = w (sigmoid(z) - t) agree for any logit (a clamp on the
 *  probability flattened the loss beyond |z| ~ 16 while dz kept going, and float32 sigmoids lose 1 - p well before that).
 *  Writes dz (d loss / d logit) and returns the loss. */
export function bceLoss(z: ArrayLike<number>, t: ArrayLike<number>, dz: Float32Array, wt?: ArrayLike<number>): number {
  let l = 0;
  for (let k = 0; k < dz.length; k++) {
    const zk = z[k], wk = wt ? wt[k] : 1;
    l += wk * ((zk > 0 ? zk : 0) + Math.log1p(Math.exp(zk > 0 ? -zk : zk)) - t[k] * zk);
    dz[k] = wk * (1 / (1 + Math.exp(-zk)) - t[k]);
  }
  return l;
}

// ---- serialisation: {version, cfg, shapes, base64 Float32 [weights | feature mean | feature std]} ----

export interface NetJSON { version: number; cfg: NetCfg; shapes: [string, number][]; data: string }
/** `mask` = the held-out judge's per-channel verdict, 52 entries in ARKIT order (1 = the net's value is used, 0 = MediaPipe's stays);
 *  absent = every FACENET_CHANNEL (an ungated net, as the trainer returns it). */
export interface FaceNetJSON { version: number; eye: NetJSON; mouth: NetJSON; mask?: number[] }

function toB64(f: Float32Array): string {
  const u8 = new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
  if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 0x8000)));
  return btoa(s);
}
function fromB64(s: string): Float32Array {
  let u8: Uint8Array;
  if (typeof Buffer !== 'undefined') u8 = new Uint8Array(Buffer.from(s, 'base64'));
  else { const b = atob(s); u8 = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u8[i] = b.charCodeAt(i); }
  if (u8.length % 4) throw new Error('faceNet: weights are not a whole number of floats');
  return new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.length)); // (little-endian hosts, which is every browser / Node target)
}
export function netToJSON(n: RegionNet): NetJSON {
  const all = new Float32Array(n.nParams + 2 * n.nIn);
  all.set(n.w, 0); all.set(n.fm, n.nParams); all.set(n.fs, n.nParams + n.nIn);
  return { version: NET_VERSION, cfg: { ...n.cfg }, shapes: [...n.tensors.map((t) => [t.name, t.len] as [string, number]), ['fm', n.nIn], ['fs', n.nIn]], data: toB64(all) };
}
export function netFromJSON(j: NetJSON): RegionNet {
  if (!j || j.version !== NET_VERSION || !j.cfg || typeof j.data !== 'string') throw new Error('faceNet: unsupported model version');
  const n = new RegionNet(j.cfg, 1);
  const want = [...n.tensors.map((t) => [t.name, t.len]), ['fm', n.nIn], ['fs', n.nIn]];
  if (JSON.stringify(want) !== JSON.stringify(j.shapes)) throw new Error('faceNet: weight shapes do not match the network');
  const all = fromB64(j.data);
  if (all.length !== n.nParams + 2 * n.nIn) throw new Error('faceNet: weight data has the wrong length');
  n.w.set(all.subarray(0, n.nParams)); n.fm.set(all.subarray(n.nParams, n.nParams + n.nIn)); n.fs.set(all.subarray(n.nParams + n.nIn));
  return n;
}

/** The pair of nets and the mapping to ARKit channels. */
export class FaceNet {
  eye: RegionNet; mouth: RegionNet;
  /** Per ARKit channel (ARKIT order): 1 = predict() writes the net's value, 0 = leaves the caller's (MediaPipe's) value in place.
   *  A fresh net drives every FACENET_CHANNEL; evaluate.ts narrows it to the channels that individually beat MediaPipe. */
  mask = new Uint8Array(ARKIT.length);
  private scratch = new Float32Array(ARKIT.length);
  constructor(seed = 1, o: { cnn?: boolean } = {}) {
    this.eye = new RegionNet(eyeCfg(o.cnn !== false), seed * 2 + 1);
    this.mouth = new RegionNet(mouthCfg(o.cnn !== false), seed * 2 + 2);
    for (const c of FACENET_CHANNELS) this.mask[c] = 1;
  }
  setMask(m: ArrayLike<number>) {
    if (m.length !== ARKIT.length) throw new Error('faceNet: mask must have ' + ARKIT.length + ' entries');
    this.mask.fill(0);
    for (const c of FACENET_CHANNELS) this.mask[c] = m[c] ? 1 : 0;
  }
  get maskCount() { let n = 0; for (const c of FACENET_CHANNELS) n += this.mask[c]; return n; }
  /** Run all three crops and write EVERY covered channel (FACENET_CHANNELS) into `out52`, ignoring the mask (the judge's view of
   *  the raw net); other entries are untouched. */
  predictAll(c: FaceCrops, out52: Float32Array) {
    const eL = this.eye.forward(c.eyeL, c.fEyeL);
    const L = EYE_IDX.Left;
    for (let k = 0; k < 5; k++) out52[L[k]] = eL[k];
    const inner = eL[5];
    const eR = this.eye.forward(c.eyeR, c.fEyeR);
    const R = EYE_IDX.Right;
    for (let k = 0; k < 5; k++) out52[R[k]] = eR[k];
    out52[L[5]] = (inner + eR[5]) / 2;
    const m = this.mouth.forward(c.mouth, c.fMouth);
    for (let k = 0; k < MOUTH_IDX.length; k++) out52[MOUTH_IDX[k]] = m[k];
  }
  /** What the studio uses: the net's value for the channels the judge adopted (`mask`), `out52` left as it was for the rest
   *  (pre-fill it with MediaPipe's scores). No allocation. */
  predict(c: FaceCrops, out52: Float32Array) {
    const s = this.scratch;
    this.predictAll(c, s);
    for (let i = 0; i < FACENET_CHANNELS.length; i++) { const ch = FACENET_CHANNELS[i]; if (this.mask[ch]) out52[ch] = s[ch]; }
  }
  toJSON(): FaceNetJSON { return { version: NET_VERSION, eye: netToJSON(this.eye), mouth: netToJSON(this.mouth), mask: Array.from(this.mask) }; }
  static fromJSON(j: FaceNetJSON | string): FaceNet {
    const o: FaceNetJSON = typeof j === 'string' ? JSON.parse(j) : j;
    if (!o || o.version !== NET_VERSION) throw new Error('faceNet: unsupported model version');
    const f = new FaceNet(1, { cnn: o.eye.cfg.cnn });
    f.eye = netFromJSON(o.eye); f.mouth = netFromJSON(o.mouth);
    if (o.mask !== undefined) {
      if (!Array.isArray(o.mask) || o.mask.length !== ARKIT.length || o.mask.some((v) => v !== 0 && v !== 1)) throw new Error('faceNet: bad channel mask');
      f.setMask(o.mask);
    }
    return f;
  }
}
export const serializeFaceNet = (n: FaceNet) => JSON.stringify(n.toJSON());
export const parseFaceNet = (s: string) => FaceNet.fromJSON(s);
