// MFCC features for audio viseme classification (uLipSync-style profile matching).
// Pure functions over a dB magnitude spectrum so the browser (AnalyserNode.getFloatFrequencyData)
// and offline tooling (tools/build_viseme_profile.ts) compute identical features.

export const MFCC_COUNT = 12;
const MEL_BANDS = 26;
const F_LO = 80;
const F_HI = 7600;

const mel = (f: number) => 2595 * Math.log10(1 + f / 700);
const imel = (m: number) => 700 * (10 ** (m / 2595) - 1);

const bankCache = new Map<string, { lo: number; mid: number; hi: number }[]>();
function filterbank(bins: number, sampleRate: number) {
  const key = `${bins}:${sampleRate}`;
  let fb = bankCache.get(key);
  if (fb) return fb;
  const hz = sampleRate / 2 / (bins - 1);
  const m0 = mel(F_LO), m1 = mel(Math.min(F_HI, sampleRate / 2 - 1));
  const pts = Array.from({ length: MEL_BANDS + 2 }, (_, i) => imel(m0 + ((m1 - m0) * i) / (MEL_BANDS + 1)) / hz);
  fb = Array.from({ length: MEL_BANDS }, (_, b) => ({ lo: pts[b], mid: pts[b + 1], hi: pts[b + 2] }));
  bankCache.set(key, fb);
  return fb;
}

/**
 * dB spectrum (length = fft/2 bins, like AnalyserNode) → MFCC[1..MFCC_COUNT] (c0 dropped, so overall
 * loudness / mic gain doesn't matter), then mean-normalized (cepstral mean removal per frame).
 */
export function mfcc(db: Float32Array | number[], sampleRate: number, out = new Float32Array(MFCC_COUNT)): Float32Array {
  const bins = db.length;
  const fb = filterbank(bins, sampleRate);
  const logMel = new Float32Array(MEL_BANDS);
  for (let b = 0; b < MEL_BANDS; b++) {
    const { lo, mid, hi } = fb[b];
    let e = 0;
    for (let k = Math.max(1, Math.floor(lo)); k <= Math.min(bins - 1, Math.ceil(hi)); k++) {
      const w = k < mid ? (k - lo) / (mid - lo) : (hi - k) / (hi - mid);
      if (w <= 0) continue;
      const p = 10 ** (db[k] / 10); // dB → power
      e += w * p;
    }
    logMel[b] = Math.log(e + 1e-12);
  }
  for (let c = 1; c <= MFCC_COUNT; c++) {
    let s = 0;
    for (let b = 0; b < MEL_BANDS; b++) s += logMel[b] * Math.cos((Math.PI * c * (b + 0.5)) / MEL_BANDS);
    out[c - 1] = s;
  }
  return out;
}

/** Per (bins, rate): each band's non-zero triangle weights, from its first bin on (exactly the weights mfcc() uses). */
const sparseCache = new Map<string, { k0: Int32Array; w: Float64Array[] }>();
function sparseBank(bins: number, sampleRate: number) {
  const key = `${bins}:${sampleRate}`;
  let sb = sparseCache.get(key);
  if (sb) return sb;
  const fb = filterbank(bins, sampleRate);
  const k0 = new Int32Array(MEL_BANDS), w: Float64Array[] = [];
  for (let b = 0; b < MEL_BANDS; b++) {
    const { lo, mid, hi } = fb[b];
    const ks: number[] = [], ws: number[] = [];
    for (let k = Math.max(1, Math.floor(lo)); k <= Math.min(bins - 1, Math.ceil(hi)); k++) {
      const x = k < mid ? (k - lo) / (mid - lo) : (hi - k) / (hi - mid);
      if (x > 0) { ks.push(k); ws.push(x); }
    }
    // the positive weights of a triangle are contiguous; anything else falls back to an explicit zero weight
    const first = ks.length ? ks[0] : 0, row = new Float64Array(ks.length ? ks[ks.length - 1] - first + 1 : 0);
    ks.forEach((k, i) => { row[k - first] = ws[i]; });
    k0[b] = first; w.push(row);
  }
  sb = { k0, w };
  sparseCache.set(key, sb);
  return sb;
}
const DCT = (() => {
  const t = new Float64Array(MFCC_COUNT * MEL_BANDS);
  for (let c = 1; c <= MFCC_COUNT; c++) for (let b = 0; b < MEL_BANDS; b++) t[(c - 1) * MEL_BANDS + b] = Math.cos((Math.PI * c * (b + 0.5)) / MEL_BANDS);
  return t;
})();
const logMelScratch = new Float32Array(MEL_BANDS);

/**
 * mfcc() from the power spectrum instead of dB: P[k] = 10^(db[k] / 10), e.g. shared by everything the live analysis
 * computes per frame (audioFeatures.ts). Same weights, same summation order, same float32 log-mel rounding: the result
 * is bit-identical to mfcc(db), without a pow per bin, per call allocations or cosines.
 */
export function mfccPow(P: Float64Array, sampleRate: number, out = new Float32Array(MFCC_COUNT)): Float32Array {
  const { k0, w } = sparseBank(P.length, sampleRate);
  const logMel = logMelScratch;
  for (let b = 0; b < MEL_BANDS; b++) {
    const row = w[b], a = k0[b];
    let e = 0;
    for (let i = 0; i < row.length; i++) { const x = row[i]; if (x > 0) e += x * P[a + i]; }
    logMel[b] = Math.log(e + 1e-12);
  }
  for (let c = 0; c < MFCC_COUNT; c++) {
    let s = 0;
    for (let b = 0, o = c * MEL_BANDS; b < MEL_BANDS; b++) s += logMel[b] * DCT[o + b];
    out[c] = s;
  }
  return out;
}

export type Vowel = 'A' | 'I' | 'U' | 'E' | 'O';
export const VOWELS: Vowel[] = ['A', 'I', 'U', 'E', 'O'];

export interface VisemeProfile {
  /** Mean MFCC per vowel. */
  means: Partial<Record<Vowel, number[]>>;
  /** Per-coefficient std over all vowel samples (for scaled distance). */
  std: number[];
  sampleRate: number;
  fft: number;
  source: string;
}

/** Soft classification: weights over vowels (sum 1) from scaled Euclidean distance to profile means. */
export function classifyVowel(c: Float32Array, p: VisemeProfile, sharpness = 2.5): Partial<Record<Vowel, number>> {
  const w: Partial<Record<Vowel, number>> = {};
  let sum = 0;
  for (const v of VOWELS) {
    const m = p.means[v];
    if (!m) continue;
    let d = 0;
    for (let i = 0; i < MFCC_COUNT; i++) { const z = (c[i] - m[i]) / (p.std[i] || 1); d += z * z; }
    const x = Math.exp(-sharpness * Math.sqrt(d / MFCC_COUNT));
    w[v] = x; sum += x;
  }
  for (const v in w) w[v as Vowel]! /= sum || 1;
  return w;
}
