// Neural visemes: a tiny streaming phone recogniser (≈ 150 k parameters, pure TypeScript, no runtime needed)
// trained on LibriSpeech + Montreal-Forced-Aligner phone alignments (CC-BY-4.0; tools/nv/ has the recipe).
//
//   16 kHz mono ─► log-mel (25 ms Hann, 10 ms hop, 40 bands 60–7600 Hz) ─► causal gated per-band mean removal
//              ─► causal conv(k5) ─► causal dilated conv(k5, d2) ─► GRU ─► 40 phone posteriors (39 ARPAbet + sil)
//              ─► 17 viseme posteriors (sil PP FF TH DD kk CH SS nn RR L W aa E I O U)
//
// Every output describes the frame `look` hops (10 ms each) in the past: the model sees that much of the future
// before it commits (a bilabial closure is only unambiguous once the burst or the nasal murmur is heard).
// The front-end MUST stay byte-for-byte equivalent to tools/nv/feats.py (checked by tools/eval_neural_visemes.ts
// --parity). Cost: ≈ 0.15 M multiply-adds per 10 ms hop (≈ 1 % of one core); runs in the voice VAD worker live.

import type { Viseme, VisemeWeights } from './visemes.ts';

export const NV_PHONES = ['sil', 'AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'B', 'CH', 'D', 'DH', 'EH', 'ER', 'EY', 'F', 'G', 'HH', 'IH', 'IY', 'JH', 'K', 'L', 'M', 'N', 'NG', 'OW', 'OY', 'P', 'R', 'S', 'SH', 'T', 'TH', 'UH', 'UW', 'V', 'W', 'Y', 'Z', 'ZH'] as const;
export const PHONE_VISEME: Record<(typeof NV_PHONES)[number], Viseme> = {
  sil: 'sil', AA: 'aa', AE: 'aa', AH: 'aa', AO: 'O', AW: 'aa', AY: 'aa', B: 'PP', CH: 'CH', D: 'DD', DH: 'TH', EH: 'E', ER: 'RR', EY: 'E',
  F: 'FF', G: 'kk', HH: 'kk', IH: 'I', IY: 'I', JH: 'CH', K: 'kk', L: 'L', M: 'PP', N: 'nn', NG: 'nn', OW: 'O', OY: 'O', P: 'PP', R: 'RR',
  S: 'SS', SH: 'CH', T: 'DD', TH: 'TH', UH: 'U', UW: 'U', V: 'FF', W: 'W', Y: 'I', Z: 'SS', ZH: 'CH',
};
const VIS_ORDER: Viseme[] = ['sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'L', 'W', 'aa', 'E', 'I', 'O', 'U'];

export const NV = { SR: 16000, WIN: 400, HOP: 160, NFFT: 512, NMEL: 40, FMIN: 60, FMAX: 7600, GATE: 2.5, RATE: 0.01, FLOOR_UP: 0.002 };
/** Most input frames NeuralVisemes keeps for its catch-up after an idle stretch. */
export const NV_REPLAY_MAX = 32;
/** Idle skip (opt-in): the net keeps running until its newest frame describes the instant this many hops after the voice
 *  gate shut. NeuralMerge still blends the model up to 150 ms after the engine's last activity, and the engine's
 *  activity outlasts the gate (release + smoothing): the longest tail on the test clip was 33 hops (≈ 330 ms,
 *  tools/eval_nv_idle.ts); 45 leaves 120 ms of headroom for a longer release (louder voice, other room / gate mode). */
export const NV_IDLE_REACH = 45;
/** The idle-skip threshold for a model (NeuralVisemes.idleAfter when the idle skip is on): NV_IDLE_REACH + look-ahead. */
export const nvIdleAfter = (m: { look: number }) => NV_IDLE_REACH + m.look;

/** Serialised weights (tools/nv/export.py). Tensors are little-endian float32, base64. */
export interface NvModelJson {
  v: 1; look: number; C: number; H: number; mean0: number[]; phones: string[];
  t: Record<'c1w' | 'c1b' | 'c2w' | 'c2b' | 'wih' | 'whh' | 'bih' | 'bhh' | 'ow' | 'ob', string>;
  info?: Record<string, unknown>;
}

function b64f32(s: string): Float32Array {
  const bin = typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary');
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Float32Array(u.buffer);
}

const melOf = (f: number) => 2595 * Math.log10(1 + f / 700);
const hzOf = (m: number) => 700 * (10 ** (m / 2595) - 1);

/** Streaming log-mel + causal normalisation (the model's input), identical to feats.py. */
export class NvFrontEnd {
  private buf = new Float64Array(NV.WIN);
  private w = 0;                // ring write index (oldest sample when full)
  private count = 0;            // samples pushed
  private fb: Float64Array[] = [];
  /** per band: the bins [fbLo, fbHi) holding its non-zero filter weights (the sum skips zero weights either way) */
  private fbLo: number[] = [];
  private fbHi: number[] = [];
  private L = new Float64Array(NV.NMEL);
  private hann = new Float64Array(NV.WIN);
  private re = new Float64Array(NV.NFFT);
  private im = new Float64Array(NV.NFFT);
  private cos = new Float64Array(NV.NFFT / 2);
  private sin = new Float64Array(NV.NFFT / 2);
  private mu: Float64Array;
  private floor = Number.NaN;
  /** frames produced so far (frame i is centred on sample i*HOP + WIN/2 of the stream) */
  frames = 0;

  constructor(mean0: ArrayLike<number>) {
    this.mu = Float64Array.from(mean0);
    for (let n = 0; n < NV.WIN; n++) this.hann[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / NV.WIN);
    const pts: number[] = [];
    const m0 = melOf(NV.FMIN), m1 = melOf(NV.FMAX);
    for (let i = 0; i < NV.NMEL + 2; i++) pts.push(hzOf(m0 + ((m1 - m0) * i) / (NV.NMEL + 1)));
    const nb = NV.NFFT / 2 + 1;
    for (let m = 0; m < NV.NMEL; m++) {
      const l = pts[m], c = pts[m + 1], r = pts[m + 2];
      const w = new Float64Array(nb);
      for (let k = 0; k < nb; k++) { const hz = (k * NV.SR) / NV.NFFT; w[k] = Math.max(0, Math.min((hz - l) / (c - l), (r - hz) / (r - c))); }
      let lo = 0, hi = 0;
      for (let k = 0; k < nb; k++) if (w[k] > 0) { if (hi === 0) lo = k; hi = k + 1; }
      this.fb.push(w); this.fbLo.push(lo); this.fbHi.push(hi);
    }
    for (let k = 0; k < NV.NFFT / 2; k++) { this.cos[k] = Math.cos((-2 * Math.PI * k) / NV.NFFT); this.sin[k] = Math.sin((-2 * Math.PI * k) / NV.NFFT); }
  }

  /** Push 16 kHz samples; calls `emit` with each new normalised 40-band frame. The frame is a new array, or the one
   *  `into(n)` returns for frame number n (the caller's buffer: no allocation per frame). */
  push(x: ArrayLike<number>, emit: (f: Float32Array) => void, into?: (n: number) => Float32Array) {
    for (let i = 0; i < x.length; i++) {
      this.buf[this.w] = x[i];
      this.w = this.w + 1 === NV.WIN ? 0 : this.w + 1;
      this.count++;
      if (this.count >= NV.WIN && (this.count - NV.WIN) % NV.HOP === 0) emit(this.frame(into ? into(this.frames) : new Float32Array(NV.NMEL)));
    }
  }

  private frame(out: Float32Array): Float32Array {
    const N = NV.NFFT, re = this.re, im = this.im;
    re.fill(0); im.fill(0);
    for (let n = 0, j = this.w; n < NV.WIN; n++, j = j + 1 === NV.WIN ? 0 : j + 1) re[n] = this.buf[j] * this.hann[n];
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const step = N / len, h = len >> 1;
      for (let i = 0; i < N; i += len) for (let k = 0; k < h; k++) {
        const wr = this.cos[k * step], wi = this.sin[k * step];
        const a = i + k, b = a + h;
        const vr = re[b] * wr - im[b] * wi, vi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
      }
    }
    let e = 0;
    const L = this.L;
    for (let m = 0; m < NV.NMEL; m++) {
      const w = this.fb[m], hi = this.fbHi[m];
      let s = 0;
      for (let k = this.fbLo[m]; k < hi; k++) if (w[k] > 0) s += w[k] * (re[k] * re[k] + im[k] * im[k]);
      L[m] = Math.log(s + 1e-6); e += L[m];
    }
    e /= NV.NMEL;
    if (Number.isNaN(this.floor)) this.floor = e;
    this.floor = e < this.floor ? e : this.floor + (e - this.floor) * NV.FLOOR_UP;
    const gate = e > this.floor + NV.GATE;
    for (let m = 0; m < NV.NMEL; m++) {
      if (gate) this.mu[m] += NV.RATE * (L[m] - this.mu[m]);
      out[m] = L[m] - this.mu[m];
    }
    this.frames++;
    return out;
  }
}

/** out[o] = relu(b[o] + Σ_i Σ_k w[(o·n + i)·5 + k] · r_k[i]) for o < nOut, each sum in the plain loop order (i outer,
 *  tap k inner); two outputs per pass share the five input loads. */
function conv5(w: Float32Array, b: Float32Array, r0: Float32Array, r1: Float32Array, r2: Float32Array, r3: Float32Array, r4: Float32Array, n: number, out: Float32Array, nOut: number) {
  const R = n * 5;
  let o = 0;
  for (; o + 1 < nOut; o += 2) {
    let s0 = b[o], s1 = b[o + 1];
    for (let i = 0, p = o * R, q = p + R; i < n; i++, p += 5, q += 5) {
      const v0 = r0[i], v1 = r1[i], v2 = r2[i], v3 = r3[i], v4 = r4[i];
      s0 += w[p] * v0; s1 += w[q] * v0; s0 += w[p + 1] * v1; s1 += w[q + 1] * v1; s0 += w[p + 2] * v2; s1 += w[q + 2] * v2;
      s0 += w[p + 3] * v3; s1 += w[q + 3] * v3; s0 += w[p + 4] * v4; s1 += w[q + 4] * v4;
    }
    out[o] = s0 > 0 ? s0 : 0; out[o + 1] = s1 > 0 ? s1 : 0;
  }
  for (; o < nOut; o++) {
    let s = b[o];
    for (let i = 0, p = o * R; i < n; i++, p += 5) { s += w[p] * r0[i]; s += w[p + 1] * r1[i]; s += w[p + 2] * r2[i]; s += w[p + 3] * r3[i]; s += w[p + 4] * r4[i]; }
    out[o] = s > 0 ? s : 0;
  }
}

/** out[r] = b[r] + Σ_i w[r·n + i] · v[i] for r < rows, each sum in the plain loop order; four rows per pass share v[i]. */
function matvec(w: Float32Array, b: Float32Array, v: Float32Array, n: number, out: Float32Array, rows: number) {
  const n2 = 2 * n, n3 = 3 * n;
  let r = 0;
  for (; r + 3 < rows; r += 4) {
    let s0 = b[r], s1 = b[r + 1], s2 = b[r + 2], s3 = b[r + 3];
    for (let i = 0, p = r * n; i < n; i++, p++) { const x = v[i]; s0 += w[p] * x; s1 += w[p + n] * x; s2 += w[p + n2] * x; s3 += w[p + n3] * x; }
    out[r] = s0; out[r + 1] = s1; out[r + 2] = s2; out[r + 3] = s3;
  }
  for (; r < rows; r++) {
    let s = b[r];
    for (let i = 0, p = r * n; i < n; i++, p++) s += w[p] * v[i];
    out[r] = s;
  }
}

/** conv(k5) → dilated conv(k5,d2) → GRU → linear, one frame at a time (state kept inside). */
export class NvNet {
  readonly C: number; readonly H: number; readonly K: number; readonly look: number;
  private c1w: Float32Array; private c1b: Float32Array; private c2w: Float32Array; private c2b: Float32Array;
  private wih: Float32Array; private whh: Float32Array; private bih: Float32Array; private bhh: Float32Array;
  private ow: Float32Array; private ob: Float32Array;
  private x1: Float32Array[] = [];  // last 5 inputs
  private y1: Float32Array[] = [];  // last 9 conv1 outputs
  /** GRU state after the last step (personal adaptation reads it) */
  h: Float32Array;
  private gi: Float32Array; private gh: Float32Array;
  private z: Float32Array;
  readonly logits: Float32Array;

  constructor(m: NvModelJson) {
    this.C = m.C; this.H = m.H; this.K = m.phones.length; this.look = m.look;
    const t = m.t;
    this.c1w = b64f32(t.c1w); this.c1b = b64f32(t.c1b); this.c2w = b64f32(t.c2w); this.c2b = b64f32(t.c2b);
    this.wih = b64f32(t.wih); this.whh = b64f32(t.whh); this.bih = b64f32(t.bih); this.bhh = b64f32(t.bhh);
    this.ow = b64f32(t.ow); this.ob = b64f32(t.ob);
    this.reset();
    this.h = new Float32Array(this.H);
    this.gi = new Float32Array(3 * this.H); this.gh = new Float32Array(3 * this.H);
    this.z = new Float32Array(this.C);
    this.logits = new Float32Array(this.K);
  }

  reset() {
    this.x1 = Array.from({ length: 5 }, () => new Float32Array(NV.NMEL));
    this.y1 = Array.from({ length: 9 }, () => new Float32Array(this.C));
    if (this.h) this.h.fill(0);
  }

  /** One 10 ms frame in → logits (this.logits) for the frame `look` hops ago.
   *  Hot path (100× a second in the voice worker): every output is summed in exactly the order of the plain loops
   *  (bias, then input by input, tap by tap; bit-identical results), but two conv outputs / four matrix rows are
   *  computed per pass so their independent sums overlap and share each input load (≈ 0.55× the plain loops' time). */
  step(x: Float32Array): Float32Array {
    const C = this.C, H = this.H, I = NV.NMEL;
    // conv1: weight (C, I, 5); taps 0..4 over x[t-4..t]
    const old = this.x1.shift()!; old.set(x); this.x1.push(old);
    const y = this.y1.shift()!;
    const x1 = this.x1;
    conv5(this.c1w, this.c1b, x1[0], x1[1], x1[2], x1[3], x1[4], I, y, C);
    this.y1.push(y);
    // conv2: weight (C, C, 5), dilation 2: taps over y1[t-8], y1[t-6], … y1[t]  (indices 0,2,4,6,8 of the 9-ring)
    const z = this.z, y1 = this.y1;
    conv5(this.c2w, this.c2b, y1[0], y1[2], y1[4], y1[6], y1[8], C, z, C);
    // GRU (PyTorch gate order r, z, n)
    const gi = this.gi, gh = this.gh, h = this.h;
    matvec(this.wih, this.bih, z, C, gi, 3 * H);
    matvec(this.whh, this.bhh, h, H, gh, 3 * H);
    for (let j = 0; j < H; j++) {
      const rg = 1 / (1 + Math.exp(-(gi[j] + gh[j])));
      const zg = 1 / (1 + Math.exp(-(gi[H + j] + gh[H + j])));
      const ng = Math.tanh(gi[2 * H + j] + rg * gh[2 * H + j]);
      h[j] = (1 - zg) * ng + zg * h[j];
    }
    matvec(this.ow, this.ob, h, H, this.logits, this.K);
    return this.logits;
  }
}

export interface NvFrame {
  /** stream time (s) of the frame this output describes (its window centre) */
  t: number;
  visemes: VisemeWeights;
  /** phone posteriors (NV_PHONES order) */
  phones: Float32Array;
  /** GRU state that produced it (only with keepHidden) */
  hidden?: Float32Array;
  /** reuseFrames only: `visemes` as an array in VISEMES order (the same array every frame) */
  vis17?: Float64Array;
}

/** visemes[VIS_ORDER[j]] = v[j], as named stores (a reused record keeps one shape: no boxing per frame) */
function setVis(o: VisemeWeights, v: Float64Array) {
  o.sil = v[0]; o.PP = v[1]; o.FF = v[2]; o.TH = v[3]; o.DD = v[4]; o.kk = v[5]; o.CH = v[6]; o.SS = v[7]; o.nn = v[8];
  o.RR = v[9]; o.L = v[10]; o.W = v[11]; o.aa = v[12]; o.E = v[13]; o.I = v[14]; o.O = v[15]; o.U = v[16];
  return o;
}

/** PCM in (16 kHz), viseme posteriors out — the whole streaming model.
 *
 *  Idle skip (opt-in: `idleAfter` > 0; off by default, so push() always runs the net): push(x, onFrame, active) with
 *  active = false (the voice gate is shut) keeps the front-end running (its normalisation keeps adapting, ≈ 8 µs a hop)
 *  but stops the net once the gate has been shut for more than `idleAfter` hops: no frames come out while idle
 *  (NeuralMerge ignores the model while the voice is silent anyway). The net keeps the state it had when it stopped
 *  (after `idleAfter` hops of gate-shut room sound) and the last `replay` input frames are kept; on wake() (the gate
 *  just opened) or the first active hop it first catches up on them (≈ 2 ms), then streams as before. A pause of up to
 *  `replay` skipped hops gives exactly the always-on output; after a longer one the posteriors differ slightly from an
 *  always-on net (its GRU would have kept listening to the room; median |Δ| ≈ 0.007) -- which is why it is opt-in.
 *  A longer replay drifts less but its burst delays the first frames of the next word (tools/eval_nv_idle.ts). */
export class NeuralVisemes {
  readonly fe: NvFrontEnd;
  readonly net: NvNet;
  /** softmax temperature (>1 = softer posteriors) */
  temperature = 1;
  /** attach a copy of the GRU state to every frame (personal adaptation) */
  keepHidden = false;
  /** Hand onFrame the SAME NvFrame (and visemes record / phones array) every time, valid only during the callback: no
   *  garbage per frame. Off by default (offline tools keep the frames); the voice worker turns it on. */
  reuseFrames = false;
  /** Idle skip, OFF by default (0 = never idle): hops (10 ms) of shut gate (push(…, active = false)) after which the net
   *  stops. It changes the posteriors after every long pause, so only an explicit opt-in sets it (nvIdleAfter(model):
   *  fast model 47, full 51; the voice worker's `idle` option). */
  idleAfter = 0;
  /** Input frames replayed through the net when it wakes (≤ NV_REPLAY_MAX). */
  replay = 9;
  /** true while the net is skipped */
  idle = false;
  /** NvNet.step calls so far */
  steps = 0;
  last: NvFrame | null = null;
  private ring: Float32Array[];
  private quiet = 0;          // consecutive hops with the gate shut
  private stepped = -1;       // the last frame number the net consumed
  private active = true;
  private cb: ((f: NvFrame) => void) | undefined = undefined;
  private readonly slot = (n: number) => this.ring[n % this.ring.length];
  private readonly onFeat = (f: Float32Array) => this.feat(f);
  private readonly ph2v: Uint8Array;
  private readonly v17 = new Float64Array(VIS_ORDER.length);
  private pBuf: Float32Array | null = null;
  private visBuf: VisemeWeights | null = null;
  private frBuf: NvFrame | null = null;

  constructor(readonly model: NvModelJson) {
    this.fe = new NvFrontEnd(model.mean0);
    this.net = new NvNet(model);
    this.ring = Array.from({ length: NV_REPLAY_MAX + 1 }, () => new Float32Array(NV.NMEL));
    this.ph2v = Uint8Array.from(NV_PHONES, (ph) => VIS_ORDER.indexOf(PHONE_VISEME[ph]));
  }
  /** Seconds the output trails the newest sample: window half + look hops. */
  get delay() { return (NV.WIN / 2 + this.net.look * NV.HOP) / NV.SR; }

  /** `active`: the voice gate is open (default; false = may go idle, see the class comment). */
  push(x: ArrayLike<number>, onFrame?: (f: NvFrame) => void, active = true) {
    this.cb = onFrame; this.active = active;
    try { this.fe.push(x, this.onFeat, this.slot); } finally { this.cb = undefined; }
  }

  /** The voice gate has just opened, ahead of the next chunk: if idle, wake now and catch up on the newest frames. */
  wake(onFrame?: (f: NvFrame) => void) {
    this.quiet = 0;
    if (!this.idle) return;
    this.cb = onFrame;
    try { this.resume(this.fe.frames); } finally { this.cb = undefined; }
  }

  private feat(f: Float32Array) {
    const n = this.fe.frames - 1; // f is frame n (it sits in the ring)
    this.quiet = this.active ? 0 : this.quiet + 1;
    if (this.idleAfter > 0 && this.quiet > this.idleAfter) { this.idle = true; return; }
    if (this.idle) this.resume(n);
    this.run(f, n);
  }

  /** Leave idle: run the last `replay` skipped frames before frame n through the net. */
  private resume(n: number) {
    this.idle = false;
    const back = Math.min(Math.max(0, this.replay | 0), NV_REPLAY_MAX);
    for (let k = Math.max(this.stepped + 1, n - back); k < n; k++) this.run(this.ring[k % this.ring.length], k);
  }

  private run(f: Float32Array, n: number) {
    const lg = this.net.step(f);
    this.steps++; this.stepped = n;
    const K = lg.length, reuse = this.reuseFrames;
    let mx = -1e9;
    for (let k = 0; k < K; k++) { const v = lg[k]; if (v > mx) mx = v; }
    const p = reuse ? (this.pBuf && this.pBuf.length === K ? this.pBuf : (this.pBuf = new Float32Array(K))) : new Float32Array(K);
    let s = 0;
    for (let k = 0; k < K; k++) { p[k] = Math.exp((lg[k] - mx) / this.temperature); s += p[k]; }
    const v17 = this.v17, ph2v = this.ph2v;
    v17.fill(0);
    for (let k = 0; k < K; k++) { p[k] /= s; v17[ph2v[k]] += p[k]; }
    const vis = setVis(reuse ? (this.visBuf ??= setVis({} as VisemeWeights, v17)) : ({} as VisemeWeights), v17);
    const t = ((n - this.net.look) * NV.HOP + NV.WIN / 2) / NV.SR;
    const hidden = this.keepHidden ? Float32Array.from(this.net.h) : undefined;
    let fr: NvFrame;
    if (reuse) {
      fr = this.frBuf ??= { t, visemes: vis, phones: p, hidden, vis17: v17 };
      fr.t = t; fr.visemes = vis; fr.phones = p; fr.hidden = hidden; fr.vis17 = v17;
    } else {
      fr = { t, visemes: vis, phones: p };
      if (hidden) fr.hidden = hidden;
    }
    this.last = fr;
    this.cb?.(fr);
  }
}
