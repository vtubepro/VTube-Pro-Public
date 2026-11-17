// Spectral landmark fingerprints: which analysed track is playing and where, from a few seconds of the sound the studio
// hears, across a whole library — for DJ setups that don't say what is playing (rekordbox performance mode + a DDJ,
// Traktor / Serato / Mixxx / djay without a mod).
//
// The classic constellation idea (published in the MIR literature; this is our own implementation for our own index):
//   1. a log-frequency spectrogram (22 050 Hz, 2048-point frames, hop 512 ≈ 23 ms, 300–5000 Hz in third-semitones);
//   2. PEAKS = points that are the loudest in their neighbourhood (±10 frames, ±3 semitones) and well above the frame's
//      median (EQ moves levels, not where the local maxima are);
//   3. LANDMARKS = pairs of peaks (anchor + up to 3 later peaks within ~1 s and an octave): hash = (anchor pitch in
//      half-semitones, pitch difference, time difference in frames), stored with the anchor's time;
//   4. matching: the live pairs are looked up under every deck-speed hypothesis — playback rate r = 0.92…1.08 (time
//      differences × r) with key lock ON (pitch unchanged) or OFF (pitch shifted by 12·log2 r semitones: the anchor's
//      pitch is shifted back; pitch DIFFERENCES are unchanged either way) — and each hit votes for (track, rate, offset
//      = reference time − r · live time). The right track piles its votes on one offset; chance hits scatter.
//   5. acceptance ("never wrong"): many votes that explain a good part of what we hear (a track that merely shares a
//      chord loop or a drum sample explains little), at least twice the best OTHER track, clearly more than the same
//      track at another place (music repeats: exact loops can't be told apart until something changes), matches spread
//      over the window (not a burst that fits at a wrong speed), and (LandmarkMatcher) two checks 2.5–8 s apart agree.
// The SAME PeakStream code runs offline over a decoded file (server analysis) and live, incrementally, over the music
// input (the studio page): their peaks are identical by construction. Pure: tools/djtrack_unit.ts, tools/djtrack_align.ts.
import { fft } from './fft.ts';

export const LM = {
  sr: 22050, nfft: 2048, hop: 512,
  fMin: 300, fMax: 5000, perSemi: 3,
  /** peak neighbourhood: ± frames, ± log bins (3 = one semitone) */
  tNb: 10, fNb: 9,
  /** a peak must stand this far (dB) above the frame's median */
  overMedianDb: 6, floorDb: -70,
  fanout: 3, dtMin: 2, dtMax: 44, dmMax: 12,
  /** hash quantisation: the anchor's pitch in half-semitones (the key-lock-off shift is searched on top), the pitch
   *  difference in quarter-semitones (it never shifts) */
  q: 0.5, qd: 0.25,
} as const;
export const LM_FPS = LM.sr / LM.hop;
export const LM_HOP_MS = LM.hop / LM.sr * 1000;
const midi = (f: number) => 69 + 12 * Math.log2(f / 440);
export const M0 = midi(LM.fMin), M1 = midi(LM.fMax);
const NB = Math.ceil((M1 - M0) * LM.perSemi);
export const HASH_BITS = 20;
/** A hash in more than this share of the tracks (at least 10 tracks) is a stop word. */
/** A tuning override from the environment, honoured ONLY in the benchmark / tests (DJTRACK_TEST=1): a shipped helper
 *  always uses the measured thresholds below. */
export function lmTestEnv(name: string): number {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (env?.DJTRACK_TEST !== '1') return NaN;
  const v = Number(env[name]);
  return Number.isFinite(v) && v > 0 ? v : NaN;
}
export const LM_STOP_FRACTION = lmTestEnv('DJTRACK_STOP') || 0.05;
/** The helper's index holds at most this many landmarks (4 bytes each: 32 MB + 2 MB): ~1000 five-minute tracks. */
export const LM_INDEX_MAX = 8_000_000;
/** One track holds at most this many (a 20-minute track has ~40 000; anything far beyond is not a real analysis). */
export const LM_TRACK_MAX = 200_000;

export interface Peak { f: number; m: number; v: number }

/** Peaks from 22 050 Hz mono samples, fed in any chunk sizes (offline: the whole file; live: as it arrives). Frame k
 *  covers samples [k·512, k·512 + 2048). Emits each peak once its neighbourhood is complete (10 frames later). */
export class PeakStream {
  private buf = new Float32Array(0);
  private base = 0;                       // sample index of buf[0]
  private frame = 0;                      // next frame to compute
  private rows: Float32Array[] = [];      // log-spectrogram rows (dB), ring of 2·tNb + 1
  private fmax: Float32Array[] = [];      // the same rows max-filtered over frequency
  private meds: number[] = [];
  private w: Float64Array;
  private re = new Float64Array(LM.nfft); private im = new Float64Array(LM.nfft);
  private map: { lo: number; hi: number; fc: number }[] = [];
  constructor() {
    this.w = new Float64Array(LM.nfft);
    for (let i = 0; i < LM.nfft; i++) this.w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / LM.nfft);
    const df = LM.sr / LM.nfft;
    for (let j = 0; j < NB; j++) {
      const fLo = 440 * 2 ** ((M0 + j / LM.perSemi - 69) / 12), fHi = 440 * 2 ** ((M0 + (j + 1) / LM.perSemi - 69) / 12);
      this.map.push({ lo: Math.ceil(fLo / df), hi: Math.floor(fHi / df), fc: Math.sqrt(fLo * fHi) / df });
    }
  }
  get frames() { return this.frame; }
  push(x: Float32Array): Peak[] {
    const nb = new Float32Array(this.buf.length + x.length); nb.set(this.buf); nb.set(x, this.buf.length); this.buf = nb;
    const out: Peak[] = [];
    const mag = new Float64Array(LM.nfft / 2 + 1);
    for (;;) {
      const s0 = this.frame * LM.hop - this.base;
      if (s0 + LM.nfft > this.buf.length) break;
      for (let j = 0; j < LM.nfft; j++) { this.re[j] = this.buf[s0 + j] * this.w[j]; this.im[j] = 0; }
      fft(this.re, this.im);
      for (let k = 0; k <= LM.nfft / 2; k++) mag[k] = Math.hypot(this.re[k], this.im[k]) / (LM.nfft / 4);
      const row = new Float32Array(NB);
      for (let j = 0; j < NB; j++) {
        const m = this.map[j];
        let v = 0;
        if (m.hi >= m.lo) { for (let k = m.lo; k <= m.hi; k++) v = Math.max(v, mag[k]); }
        else { const k = Math.floor(m.fc), f = m.fc - k; v = mag[k] * (1 - f) + mag[k + 1] * f; }
        row[j] = 20 * Math.log10(v + 1e-9);
      }
      const fm = new Float32Array(NB);
      for (let j = 0; j < NB; j++) { let mx = -Infinity; for (let i = Math.max(0, j - LM.fNb); i <= Math.min(NB - 1, j + LM.fNb); i++) if (row[i] > mx) mx = row[i]; fm[j] = mx; }
      const sorted = Array.from(row).sort((a, b) => a - b);
      this.rows.push(row); this.fmax.push(fm); this.meds.push(sorted[NB >> 1]);
      if (this.rows.length > 2 * LM.tNb + 1) { this.rows.shift(); this.fmax.shift(); this.meds.shift(); }
      this.frame++;
      // the frame in the middle of the ring now has its whole neighbourhood (the first frames: what exists of it)
      const c = this.frame - 1 - LM.tNb;
      if (c >= 0) out.push(...this.pick(c, this.rows.length - 1 - LM.tNb));
    }
    // drop samples no future frame needs
    const keep = this.frame * LM.hop - this.base;
    if (keep > 0) { this.buf = this.buf.slice(keep); this.base += keep; }
    return out;
  }
  private pick(f: number, ri: number): Peak[] {
    const row = this.rows[ri], med = this.meds[ri], out: Peak[] = [];
    for (let j = 1; j < NB - 1; j++) {
      const v = row[j];
      if (v < LM.floorDb || v < med + LM.overMedianDb) continue;
      let mx = -Infinity;
      for (const r of this.fmax) if (r[j] > mx) mx = r[j];
      if (v < mx) continue;
      // (a flat top: only its first bin)
      if (row[j - 1] === v) continue;
      const a = row[j - 1], b = row[j + 1], den = a - 2 * v + b;
      const d = den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - b) / den)) : 0;
      out.push({ f, m: M0 + (j + 0.5 + d) / LM.perSemi, v });
    }
    return out;
  }
}
/** Every peak of a whole file (mono 22 050 Hz). */
export function peaksOf(pcm: Float32Array): Peak[] { const p = new PeakStream(); const out = p.push(pcm); out.push(...p.push(new Float32Array(LM.nfft + LM.hop * (LM.tNb + 2)))); return out.filter((x) => x.f * LM.hop < pcm.length); }

// ---------------------------------------------------------------------------------------------------- landmarks
export const hashOf = (qf: number, qd: number, dt: number) => (qf << 13) | (qd << 6) | dt;
const QD0 = Math.round(LM.dmMax / LM.qd), QDMAX = 2 * QD0;
const qfOf = (m: number) => Math.floor((m - M0) / LM.q);
/** Anchor + target pairs: [anchor frame, anchor pitch, target pitch, frame difference]. */
export function pairsOf(peaks: Peak[]): { t: number; m1: number; m2: number; dt: number }[] { return drain(pairsOfSteps(peaks)); }
/** pairsOf in steps (a 0.5 ms time budget). Live peaks already come in (frame, pitch) order: then nothing is sorted. */
export function* pairsOfSteps(peaks: Peak[]): Generator<void, { t: number; m1: number; m2: number; dt: number }[], void> {
  let sorted = true;
  for (let i = 1; i < peaks.length && sorted; i++) if (peaks[i].f < peaks[i - 1].f || (peaks[i].f === peaks[i - 1].f && peaks[i].m < peaks[i - 1].m)) sorted = false;
  const p = sorted ? peaks : [...peaks].sort((a, b) => a.f - b.f || a.m - b.m);
  let tY = performance.now();
  const out: { t: number; m1: number; m2: number; dt: number }[] = [];
  for (let i = 0; i < p.length; i++) {
    let n = 0;
    for (let k = i + 1; k < p.length && n < LM.fanout; k++) {
      const dt = p[k].f - p[i].f;
      if (dt < LM.dtMin) continue;
      if (dt > LM.dtMax) break;
      if (Math.abs(p[k].m - p[i].m) > LM.dmMax) continue;
      out.push({ t: p[i].f, m1: p[i].m, m2: p[k].m, dt }); n++;
    }
    if ((i & 255) === 255 && performance.now() - tY > 0.5) { yield; tY = performance.now(); }
  }
  return out;
}
/** A file's landmarks (hash, anchor frame), sorted by time. */
export function landmarksOf(pcm: Float32Array): { h: Uint32Array; t: Uint32Array } { return landmarksFromPeaks(peaksOf(pcm)); }
export function landmarksFromPeaks(peaks: Peak[]): { h: Uint32Array; t: Uint32Array } { return drain(landmarksFromPeaksSteps(peaks)); }
/** landmarksFromPeaks in steps (the helper learns a streaming track's landmarks while it plays: runSliced). */
export function* landmarksFromPeaksSteps(peaks: Peak[]): Generator<void, { h: Uint32Array; t: Uint32Array }, void> {
  const pairs = yield* pairsOfSteps(peaks);
  const h = new Uint32Array(pairs.length), t = new Uint32Array(pairs.length);
  pairs.forEach((x, i) => {
    const qf = Math.max(0, Math.min(127, qfOf(x.m1))), qd = Math.max(0, Math.min(QDMAX, Math.round((x.m2 - x.m1) / LM.qd) + QD0));
    h[i] = hashOf(qf, qd, x.dt); t[i] = x.t;
  });
  return { h, t };
}
/** Compact storage: per landmark varint(Δtime) + 3 bytes of hash. */
export function encodeLandmarks(l: { h: Uint32Array; t: Uint32Array }): Uint8Array {
  const out: number[] = [];
  let last = 0;
  for (let i = 0; i < l.h.length; i++) {
    let d = l.t[i] - last; last = l.t[i];
    while (d >= 0x80) { out.push((d & 0x7f) | 0x80); d >>>= 7; }
    out.push(d);
    out.push(l.h[i] & 0xff, (l.h[i] >>> 8) & 0xff, (l.h[i] >>> 16) & 0xff);   // (20 bits)
  }
  return Uint8Array.from(out);
}
/** Decode stored landmarks; at most `max` of them (a stored blob is never trusted to be small). */
export function decodeLandmarks(b: Uint8Array, max = Infinity): { h: Uint32Array; t: Uint32Array } {
  const h: number[] = [], t: number[] = [];
  let i = 0, last = 0;
  while (i < b.length && h.length < max) {
    let d = 0, s = 0, c: number;
    do { c = b[i++]; d |= (c & 0x7f) << s; s += 7; } while (c & 0x80 && i < b.length && s < 28);
    if (i + 3 > b.length) break;
    last += d; t.push(last); h.push(b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)); i += 3;
  }
  return { h: Uint32Array.from(h), t: Uint32Array.from(t) };
}
/** A stored track's landmarks for the index: decoded up to `room`, and only when the stored count is exactly what the
 *  data holds (a count that lies is rejected: null). */
export function landmarksForIndex(lm: { n: number; b64: string }, bytes: Uint8Array, room: number): { h: Uint32Array; t: Uint32Array } | null {
  if (!(lm.n > 0) || lm.n > Math.min(room, LM_TRACK_MAX) || bytes.length < lm.n * 4 || bytes.length > lm.n * 8) return null;
  const d = decodeLandmarks(bytes, lm.n + 1);
  return d.h.length === lm.n ? d : null;
}

// ---------------------------------------------------------------------------------------------------- the index
/** All tracks' landmarks in one inverted index: offsets[hash]..offsets[hash+1] in `entries` = (track << 20 | frame).
 *  Memory: 4 bytes per landmark + 2 MB. At most 4095 tracks (the most recently used ones when there are more).
 *  "Stop words": a hash that many different tracks share (the same drum sample in the same pattern: sample packs) says
 *  nothing about WHICH track plays, and lets a track that isn't in the library look like one that is — hashes found in
 *  more than max(10, 2 %) of the tracks are left out of the index. */
export class LandmarkIndex {
  ids: string[] = [];
  bpm = new Float32Array(0);
  offsets = new Uint32Array(0);
  entries = new Uint32Array(0);
  /** how many hashes were common enough to leave out */
  stop = 0;
  /** per track, landmarks per second (2 bytes a second) */
  dens: Uint16Array[] = [];
  /** landmarks a track holds between two reference frames */
  expected(track: number, from: number, to: number): number {
    const d = this.dens[track]; if (!d) return 0;
    const a = Math.max(0, from / LM_FPS), b = Math.max(a, to / LM_FPS);
    let s = 0;
    for (let k = Math.floor(a); k < Math.ceil(b) && k < d.length; k++) s += d[k] * (Math.min(b, k + 1) - Math.max(a, k));
    return s;
  }
  get bytes() { return this.offsets.byteLength + this.entries.byteLength; }
  get size() { return this.ids.length; }
  build(tracks: { id: string; bpm: number; lm: { h: Uint32Array; t: Uint32Array } }[], maxLandmarks = LM_INDEX_MAX) { drain(this.buildSteps(tracks, maxLandmarks)); }
  /** build() as steps (one track at a time; runSliced). The finished index is assigned at the very end in one go: build a
   *  NEW index and swap it in (server/music/trackSync.ts) — a listening check keeps reading the one it started with. */
  *buildSteps(tracks: { id: string; bpm: number; lm: { h: Uint32Array; t: Uint32Array } }[], maxLandmarks = LM_INDEX_MAX): Generator<void, void, void> {
    // at most 4095 tracks and LM_INDEX_MAX landmarks, counted on what they actually hold
    const T: typeof tracks = [];
    let total = 0;
    for (const tr of tracks) { if (T.length >= 4095 || total + tr.lm.h.length > maxLandmarks) break; total += tr.lm.h.length; T.push(tr); }
    // (every loop below checks a 0.5 ms time budget every 1024 items and yields: no step runs long, whatever the size)
    let tY = performance.now();
    const due = () => { if (performance.now() - tY > 0.5) { tY = performance.now(); return true; } return false; };
    const H = 1 << HASH_BITS;
    // in how many tracks each hash appears (seen = last track index + 1: no 4 MB fill)
    // (the budget is checked every 1024 landmarks counted ACROSS tracks: many short tracks yield as often as one long one)
    let w = 0;
    const df = new Uint16Array(H), seen = new Int32Array(H);
    for (let ti = 0; ti < T.length; ti++) {
      const h0 = T[ti].lm.h;
      for (let i = 0; i < h0.length; i++) { const h = h0[i]; if (seen[h] !== ti + 1) { seen[h] = ti + 1; if (df[h] < 65535) df[h]++; } if ((++w & 1023) === 0 && due()) yield; }
    }
    const maxDf = Math.max(10, Math.ceil(T.length * LM_STOP_FRACTION));
    let stop = 0;
    for (let h = 0; h < H; h++) { if (df[h] > maxDf) stop++; if ((h & 1023) === 1023 && due()) yield; }
    const counts = new Uint32Array(H + 1);
    for (const tr of T) { const h0 = tr.lm.h; for (let i = 0; i < h0.length; i++) { if (df[h0[i]] <= maxDf) counts[h0[i] + 1]++; if ((++w & 1023) === 0 && due()) yield; } }
    for (let i = 1; i < counts.length; i++) { counts[i] += counts[i - 1]; if ((i & 1023) === 1023 && due()) yield; }
    const pos = new Uint32Array(H);
    for (let i = 0; i < H; i++) { pos[i] = counts[i]; if ((i & 1023) === 1023 && due()) yield; }
    const entries = new Uint32Array(counts[H]);
    for (let ti = 0; ti < T.length; ti++) {
      const h0 = T[ti].lm.h, t0 = T[ti].lm.t;
      for (let i = 0; i < h0.length; i++) { const h = h0[i]; if (df[h] <= maxDf) entries[pos[h]++] = ((ti << 20) | Math.min(0xfffff, t0[i])) >>> 0; if ((++w & 1023) === 0 && due()) yield; }
    }
    // per track: how many (kept) landmarks each second holds — what a place SHOULD match if it is the right one
    const dens: Uint16Array[] = [];
    for (const tr of T) {
      const n = Math.ceil(((tr.lm.t[tr.lm.t.length - 1] ?? 0) + 1) / LM_FPS) + 1, d = new Uint16Array(n);
      for (let i = 0; i < tr.lm.h.length; i++) { if (df[tr.lm.h[i]] <= maxDf) { const k = Math.floor(tr.lm.t[i] / LM_FPS); if (d[k] < 65535) d[k]++; } if ((++w & 1023) === 0 && due()) yield; }
      dens.push(d);
      w += 32; if (due()) yield;   // (also an allocation per track)
    }
    this.ids = T.map((x) => x.id); this.bpm = Float32Array.from(T.map((x) => x.bpm || 0)); this.offsets = counts; this.entries = entries; this.dens = dens; this.stop = stop;
  }
}

export interface LmHit {
  id: string; track: number;
  /** deck rate and key lock; reference frame = off + r · (live frame) */
  r: number; keylock: boolean; off: number;
  /** votes for this (track, rate, offset ±1 frame), the best other track's, the same track's best elsewhere (≥ 2 beats) */
  votes: number; other: number; elsewhere: number;
  /** the live frame span the query covered, and the span the matched landmarks of the winner cover (a burst that fits
   *  at a wrong speed covers little of the window) */
  from: number; to: number; span: number;
  /** live landmark pairs in the window (votes / pairs = how much of what we hear this track explains) */
  pairs: number;
  /** where the runner-up place of the same track is, relative to this one (live frames) */
  elseFrames: number;
  /** how far this place leads the runner-up place of the same track (votes; × up to 2 when the runner-up's part is busier) */
  placeLead: number;
  /** frames: how far the matches scatter around the fitted speed + place */
  fitRms: number;
}
/** Deck-speed hypotheses: 0.92 … 1.08 in 1 % steps (time differences ≤ 44 frames: a 0.5 % error moves them < ¼ frame;
 *  the near-boundary lookups and the final least-squares fit take care of the rest). */
export const LM_RATES = Array.from({ length: 17 }, (_, i) => +(0.92 + i * 0.01).toFixed(3));
export interface LmQueryOptions {
  /** the music clock's tempo, when a DJ source sets it: only tracks the decks could be playing at that tempo vote */
  clockBpm?: number;
  rates?: number[];
}
/** Sort an Int32Array ascending in steps (≤ 8192 elements per native sort, then merges on a 0.5 ms time budget):
 *  the same result as `a.sort()`. */
export function* sortSteps(a: Int32Array): Generator<void, void, void> {
  const n = a.length, R = 8192;
  if (n <= R) { a.sort(); return; }
  let tY = performance.now();
  for (let i = 0; i < n; i += R) { a.subarray(i, Math.min(n, i + R)).sort(); if (performance.now() - tY > 0.5) { yield; tY = performance.now(); } }
  let src: Int32Array = a, dst: Int32Array = new Int32Array(n);
  for (let w = R; w < n; w *= 2) {
    for (let lo = 0; lo < n; lo += 2 * w) {
      const mid = Math.min(n, lo + w), hi = Math.min(n, lo + 2 * w);
      let i = lo, j = mid, o = lo;
      while (i < mid && j < hi) { dst[o++] = src[i] <= src[j] ? src[i++] : src[j++]; if ((o & 4095) === 0 && performance.now() - tY > 0.5) { yield; tY = performance.now(); } }
      while (i < mid) dst[o++] = src[i++];
      while (j < hi) dst[o++] = src[j++];
    }
    const t = src; src = dst; dst = t;
    yield; tY = performance.now();
  }
  if (src !== a) a.set(src);
}
const SCRATCH: { trs: Uint16Array; offs: Int32Array; grp: Int32Array }[] = [];
/** Run a stepwise computation to the end (synchronously). */
export function drain<T>(g: Generator<void, T, void>): T { for (;;) { const r = g.next(); if (r.done) return r.value; } }
/**
 * Run a stepwise computation in slices of at most ~`sliceMs` of CPU, giving the event loop back between slices (the
 * helper's 30 Hz music clock keeps ticking while a listening check runs). Reports the total CPU time and the longest
 * single block.
 */
export async function runSliced<T>(g: Generator<void, T, void>, sliceMs = 4, pause: () => Promise<void> = () => new Promise((r) => ((globalThis as { setImmediate?: (f: () => void) => void }).setImmediate ?? ((f: () => void) => setTimeout(f, 0)))(r))): Promise<{ value: T; cpuMs: number; maxBlockMs: number; slices: number }> {
  let cpu = 0, maxBlock = 0, slices = 0;
  for (;;) {
    const t0 = performance.now();
    let r = g.next();
    while (!r.done && performance.now() - t0 < sliceMs) r = g.next();
    const dt = performance.now() - t0;
    cpu += dt; if (dt > maxBlock) maxBlock = dt; slices++;
    if (r.done) return { value: r.value, cpuMs: cpu, maxBlockMs: maxBlock, slices };
    await pause();
  }
}
/** Look a window of live peaks up in the index (every rate / key-lock hypothesis). */
export function queryIndex(idx: LandmarkIndex, peaks: Peak[], o: LmQueryOptions = {}): LmHit | null { return drain(queryIndexSteps(idx, peaks, o)); }
/** queryIndex as steps: one speed / key-lock hypothesis per step (runSliced gives the event loop back between them). */
export function* queryIndexSteps(idx: LandmarkIndex, peaks: Peak[], o: LmQueryOptions = {}): Generator<void, LmHit | null, void> {
  if (!idx.size || peaks.length < 8) return null;
  const pairs = yield* pairsOfSteps(peaks);
  if (!pairs.length) return null;
  const f0 = pairs[0].t;
  const rates = o.rates ?? LM_RATES;
  const NT = idx.size;
  let allowed: Uint8Array | null = null;
  if (o.clockBpm && o.clockBpm > 0) {
    allowed = new Uint8Array(rates.length * NT);
    rates.forEach((r, ri) => { for (let t = 0; t < NT; t++) { const b = idx.bpm[t]; if (!(b > 0)) { allowed![ri * NT + t] = 1; continue; } for (const m of [0.5, 1, 2]) if (Math.abs(b * m * r / o.clockBpm! - 1) <= 0.012) allowed![ri * NT + t] = 1; } });
  }
  // per hypothesis: every hit's key = track · 2²¹ + offset, sorted, counted in runs; candidates (score = the offset ±1)
  // (every step below is small: the voting is grouped by track with a counting sort and each track's offsets sorted on
  // their own, so a sliced run never blocks for long, however many hits a window brings)
  // (scratch buffers come from a small pool: grown once, reused by later checks — no growth copies or garbage per check)
  const sc = SCRATCH.pop() ?? { trs: new Uint16Array(1 << 16), offs: new Int32Array(1 << 16), grp: new Int32Array(1 << 16) };
  let { trs, offs, grp } = sc;
  const start = new Int32Array(NT + 1);
  const cand: { hyp: number; track: number; off: number; s: number }[] = [];
  const perTrack = new Float32Array(NT);
  let best = { hyp: -1, track: -1, off: 0, s: 0 };
  try {
  for (let ri = 0; ri < rates.length; ri++) {
    const r = rates[ri];
    for (const kl of [true, false]) {
      yield;
      const hyp = ri * 2 + (kl ? 0 : 1);
      let n = 0;
      yield* lookupsSteps(idx, pairs, r, kl, (tr, tRef, tLive) => {
        if (allowed && !allowed[ri * NT + tr]) return;
        if (n === trs.length) { const t2 = new Uint16Array(n * 2); t2.set(trs); trs = sc.trs = t2; const o2 = new Int32Array(n * 2); o2.set(offs); offs = sc.offs = o2; }
        trs[n] = tr; offs[n] = Math.round(tRef - (tLive - f0) * r); n++;
      });
      if (!n) continue;
      if (grp.length < n) grp = sc.grp = new Int32Array(trs.length);
      start.fill(0);
      let tY = performance.now();
      for (let i = 0; i < n; i++) { start[trs[i] + 1]++; if ((i & 4095) === 4095 && performance.now() - tY > 0.5) { yield; tY = performance.now(); } }
      for (let t = 0; t < NT; t++) start[t + 1] += start[t];
      const pos = start.slice(0, NT);
      for (let i = 0; i < n; i++) { grp[pos[trs[i]]++] = offs[i]; if ((i & 4095) === 4095 && performance.now() - tY > 0.5) { yield; tY = performance.now(); } }
      yield; tY = performance.now();
      for (let track = 0; track < NT; track++) {
        const a0 = start[track], a1 = start[track + 1];
        if (a1 - a0 < 3) continue;
        const k = grp.subarray(a0, a1);
        yield* sortSteps(k);   // (a big track's hits are sorted in pieces)
        tY = performance.now();
        const m = a1 - a0;
        // runs → (offset, count); a place scores its own count + its neighbours' (±1 frame)
        const keys: number[] = [], cnt: number[] = [];
        for (let i = 0; i < m; i++) {
          if (i === 0 || k[i] !== k[i - 1]) { keys.push(k[i]); cnt.push(1); } else cnt[cnt.length - 1]++;
          if ((i & 4095) === 4095 && performance.now() - tY > 0.5) { yield; tY = performance.now(); }
        }
        for (let i = 0; i < keys.length; i++) {
          if (cnt[i] < 2) continue;
          const sc = cnt[i] + (i > 0 && keys[i - 1] === keys[i] - 1 ? cnt[i - 1] : 0) + (i + 1 < keys.length && keys[i + 1] === keys[i] + 1 ? cnt[i + 1] : 0);
          if (sc < 3) continue;
          cand.push({ hyp, track, off: keys[i], s: sc });
          if (sc > perTrack[track]) perTrack[track] = sc;
          if (sc > best.s) best = { hyp, track, off: keys[i], s: sc };
        }
        if (performance.now() - tY > 0.5) { yield; tY = performance.now(); }
      }
    }
  }
  } finally { if (SCRATCH.length < 2) SCRATCH.push(sc); }
  if (best.hyp < 0) return null;
  yield;
  // the place: the most votes. Its lead over the runner-up place counts double at most when the runner-up's part of the
  // track holds MORE landmarks (a wrong alignment across a change — the window's quiet build mapped onto a busy drop —
  // matches as much but should have matched far more); a sparser runner-up never helps it (noise hides more of a busy
  // part). Identical loops stay tied: then we wait.
  const spanF = pairs[pairs.length - 1].t - f0;
  const expOf = (c: { hyp: number; track: number; off: number }) => idx.expected(c.track, c.off, c.off + rates[Math.floor(c.hyp / 2)] * spanF);
  const { track, off, hyp } = best;
  let other = 0;
  for (let t = 0; t < NT; t++) if (t !== track && perTrack[t] > other) other = perTrack[t];
  // the same track elsewhere: half a beat or more away (music repeats by bars and beats)
  const beatF = (idx.bpm[track] > 0 ? 60 / idx.bpm[track] : 0.5) * LM_FPS;
  const away = Math.max(5, 0.45 * beatF);
  let elsewhere = 0, elseOff = 0, elseC: (typeof cand)[number] | null = null;
  for (const c of cand) if (c.track === track && Math.abs(c.off - off) >= away && c.s > elsewhere) { elsewhere = c.s; elseOff = c.off - off; elseC = c; }
  const denseLead = elseC ? Math.max(1, Math.min(2, expOf(elseC) / Math.max(1, expOf(best)))) : 1;
  // refine: the matched pairs of the winning cluster → least squares tRef = a + b · tLive (the exact rate and place)
  const r0 = rates[Math.floor(hyp / 2)], kl = hyp % 2 === 0;
  const pts: [number, number][] = [];
  yield;
  // (every hypothesis within half a grid step, the drift of a 1 % speed error allowed for)
  for (const rr of [r0 - 0.005, r0, r0 + 0.005]) yield* lookupsSteps(idx, pairs, rr, kl, (tr, tRef, tLive) => { if (tr === track && Math.abs(tRef - (tLive - f0) * r0 - off) <= 2.5 + 0.006 * (tLive - f0)) pts.push([tLive - f0, tRef]); });
  let r = r0, a = off;
  const uniq = [...new Map(pts.map((p) => [`${p[0]}:${p[1]}`, p])).values()];
  let lo = Infinity, hi = -Infinity; for (const [x] of uniq) { if (x < lo) lo = x; if (x > hi) hi = x; }
  const span = uniq.length ? hi - lo : 0;
  let fitRms = 99;
  if (uniq.length >= 6) {
    const n = uniq.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [x, y] of uniq) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
    const den = n * sxx - sx * sx;
    if (den > 0) { const b = (n * sxy - sx * sy) / den; if (Math.abs(b - r0) <= 0.008) { r = b; a = (sy - b * sx) / n; } }
    // how well one straight line explains the matches (a mix of two places / speeds doesn't)
    let e2 = 0; for (const [x, y] of uniq) e2 += (y - (a + r * x)) ** 2;
    fitRms = Math.sqrt(e2 / n);
  }
  // reference frame = off + r · live frame
  return { id: idx.ids[track], track, r: +r.toFixed(5), keylock: kl, off: a - r * f0, votes: best.s, other, elsewhere, from: f0, to: pairs[pairs.length - 1].t, span, pairs: pairs.length, elseFrames: elseOff, fitRms: +fitRms.toFixed(2), placeLead: +(elsewhere > 0 ? best.s / elsewhere * denseLead : 99).toFixed(3) };
}
/** Every index hit of the live pairs under one hypothesis: (track, reference frame, live frame). */
function* lookupsSteps(idx: LandmarkIndex, pairs: { t: number; m1: number; m2: number; dt: number }[], r: number, kl: boolean, hit: (track: number, tRef: number, tLive: number) => void): Generator<void, void, void> {
  const { offsets, entries } = idx;
  let k = 0, tY = performance.now();
  const shift = kl ? 0 : 12 * Math.log2(r);
  for (const p of pairs) {
    // (a time budget, not a count: a busy index brings many hits per pair)
    if ((++k & 7) === 0 && performance.now() - tY > 0.5) { yield; tY = performance.now(); }
    const x = (p.m1 - shift - M0) / LM.q, qf = Math.floor(x), fx = x - qf;
    const y = (p.m2 - p.m1) / LM.qd + QD0, qd = Math.round(y), fy = y - Math.floor(y);
    const dr = p.dt * r, dt = Math.round(dr), fd = dr - Math.floor(dr);
    const qfs = fx < 0.15 ? [qf, qf - 1] : fx > 0.85 ? [qf, qf + 1] : [qf];
    const qds = Math.abs(fy - 0.5) < 0.25 ? [Math.floor(y), Math.floor(y) + 1] : [qd];
    const dts = Math.abs(fd - 0.5) < 0.15 ? [Math.floor(dr), Math.floor(dr) + 1] : [dt];
    for (const a of qfs) for (const b of qds) for (const c of dts) {
      if (a < 0 || a > 127 || b < 0 || b > QDMAX || c < LM.dtMin || c > LM.dtMax) continue;
      const h = hashOf(a, b, c);
      for (let e = offsets[h], end = offsets[h + 1], c2 = 0; e < end; e++) { const v = entries[e]; hit(v >>> 20, v & 0xfffff, p.t); if ((++c2 & 1023) === 0 && performance.now() - tY > 0.5) { yield; tY = performance.now(); } }
    }
  }
}
function lookups(idx: LandmarkIndex, pairs: { t: number; m1: number; m2: number; dt: number }[], r: number, kl: boolean, hit: (track: number, tRef: number, tLive: number) => void) { drain(lookupsSteps(idx, pairs, r, kl, hit)); }

/** Acceptance thresholds (tools/djtrack_align.ts measures what they cost: accepted, WRONG, time to lock). */
export const LM_ACCEPT = { minVotes: 20, minCover: 0.1, overOther: 3, idOverOther: 5, overElsewhere: lmTestEnv('DJTRACK_ELSEWHERE') || 3, minSpan: 0.6, maxFitRms: 1.2, agreeFrames: 3, agreeAfterS: 2.5, agreeWithinS: 8, windows: [6, 12, 20, 32] as number[] };
/** The TRACK is known (its votes stand far above every other track's) even if the place isn't yet (a looped section). */
const lmCandidate = (h: LmHit | null) => !!h && h.votes >= LM_ACCEPT.minVotes && h.votes >= LM_ACCEPT.minCover * h.pairs && h.votes >= LM_ACCEPT.overOther * Math.max(h.other, 3) && h.span >= LM_ACCEPT.minSpan * (h.to - h.from);
/** (identity alone, for the panel: a much clearer lead over every other track — a track that isn't in the library but
 *  shares a loop with one that is gets ~2–3×) */
export const lmIdentified = (h: LmHit | null) => lmCandidate(h) && h!.votes >= LM_ACCEPT.idOverOther * Math.max(h!.other, 3);
export const lmAccepted = (h: LmHit | null) => lmCandidate(h) && !!h && h.votes >= LM_ACCEPT.overOther * Math.max(h.other, 3) && h.placeLead >= LM_ACCEPT.overElsewhere && h.fitRms <= LM_ACCEPT.maxFitRms && h.votes >= 1.5 * Math.max(h.elsewhere, 2) && h.span >= LM_ACCEPT.minSpan * (h.to - h.from);

/**
 * The live matcher: peaks of the music input (stream frame numbers), checked about once a second over the last 6 s
 * (then 12, 20, 32 s when unsure). A track counts once two checks 2.5–8 s apart agree (same track, key lock, speed
 * within 0.6 %, the same place within 3 frames ≈ 70 ms).
 */
export class LandmarkMatcher {
  private peaks: Peak[] = [];
  private hist: { at: number; h: LmHit }[] = [];
  last: LmHit | null = null;
  /** The track it hears, known before its exact place is (two agreeing checks on the identity alone). */
  identity: { id: string; since: number } | null = null;
  private prevId = '';
  push(p: Peak[]) { this.peaks.push(...p); const lim = (this.peaks.at(-1)?.f ?? 0) - LM_FPS * 34; if (this.peaks.length && this.peaks[0].f < lim) this.peaks = this.peaks.filter((x) => x.f >= lim); }
  private gen = 0;
  reset() { this.peaks = []; this.hist = []; this.last = null; this.identity = null; this.prevId = ''; this.gen++; }
  get seconds() { return this.peaks.length ? (this.peaks[this.peaks.length - 1].f - this.peaks[0].f) / LM_FPS : 0; }
  /** One check. A confirmed hit (two agreeing checks) or null. */
  check(idx: LandmarkIndex, o: LmQueryOptions = {}): LmHit | null { return drain(this.checkSteps(idx, o)); }
  /** check() as steps (the helper runs it sliced: runSliced). Peaks pushed meanwhile wait for the next check; a reset
   *  meanwhile discards this one. */
  *checkSteps(idx: LandmarkIndex, o: LmQueryOptions = {}): Generator<void, LmHit | null, void> {
    if (!this.peaks.length) return null;
    const gen = this.gen, peaks = this.peaks.slice();
    const end = peaks[peaks.length - 1].f;
    let hit: LmHit | null = null, idHit: LmHit | null = null;
    for (const s of LM_ACCEPT.windows) {
      if ((end - peaks[0].f) / LM_FPS < s - 0.5) break;
      const from = end - s * LM_FPS;
      const h = yield* queryIndexSteps(idx, peaks.filter((p) => p.f >= from), o);
      if (!idHit && lmIdentified(h)) idHit = h;
      if (lmAccepted(h)) { hit = h; break; }
    }
    if (gen !== this.gen) return null;
    const id = idHit?.id ?? '';
    if (id && id === this.prevId) { if (this.identity?.id !== id) this.identity = { id, since: end }; } else if (!id && this.identity && !hit) { /* keeps the last identity until another one is sure */ }
    this.prevId = id;
    // confirmed when a check from 2.5–8 s earlier (mostly OTHER audio) says the same: same track, key lock, speed within
    // 0.6 %, the same place within 3 frames (a wrong speed drifts apart over those seconds)
    this.hist = this.hist.filter((x) => (end - x.at) / LM_FPS <= LM_ACCEPT.agreeWithinS);
    if (!hit) return null;
    this.hist.push({ at: end, h: hit });
    const ok = this.hist.some(({ at, h: p }) => (end - at) / LM_FPS >= LM_ACCEPT.agreeAfterS && p.id === hit!.id && p.keylock === hit!.keylock && Math.abs(p.r - hit!.r) <= 0.006
      && Math.abs((p.off + p.r * end) - (hit!.off + hit!.r * end)) <= LM_ACCEPT.agreeFrames);
    if (!ok) return null;
    this.last = hit;
    return hit;
  }
}
/** Reference position (ms in the track) of a live stream frame, from a hit. */
export const lmTrackMs = (h: LmHit, liveFrame: number) => (h.off + h.r * liveFrame) * LM_HOP_MS;
