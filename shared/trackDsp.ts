// VTube Pro's own offline track analysis (no model needed): from decoded mono PCM to the beat grid (when no DJ app gave
// one), the sections (intro / groove / build / drop / breakdown / outro), the events a light show hits (risers, impacts,
// the pre-drop gap, snare rolls), the per-bar energy, the overview waveform and the aligner's fingerprint.
// Plus the exact front end + post-processing of the optional Beat This! model (MIT code + weights, user-fetched:
// server/music/library/beatThis.ts runs it), and a robust grid fit over its beats.
//
// Plain DSP written for this project (ideas from the public MIR literature: spectral flux onsets, tempo by folding,
// Foote-style novelty on bar features, rule labels for EDM forms). No third-party code. Pure: tools/djtrack_unit.ts
// tests it on synthetic music generated in memory (nothing is ever played).
import {
  ANALYSIS_VERSION, bytesToB64, constantGrid, msToBeat, phrasesFrom, beatToMs, type TrackAnalysis, type TrackEvent, type TrackGrid, type TrackPhrase, type TrackSrc,
} from './trackAnalysis.ts';
import type { PhraseKind, ShowSection } from './musicClock.ts';
import { encodeLandmarks, landmarksOf, LM } from './landmarks.ts';
import { FEELS, GrooveTracker, grooveToWire } from './groove.ts';

// ---------------------------------------------------------------------------------------------------- FFT
export { fft } from './fft.ts';
import { fft } from './fft.ts';
const hann = (n: number, periodic = true) => { const w = new Float64Array(n); const d = periodic ? n : n - 1; for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / d); return w; };

// ---------------------------------------------------------------------------------------------------- frame features
export const FEAT_HZ = 50;
export interface Features {
  hz: number; n: number;
  /** per frame: band magnitudes (sub < 90 Hz, low 90-250, mid 250-2k, high > 2k), spectral flux, kick-band flux (< 120 Hz), centroid (Hz), rms */
  sub: Float32Array; low: Float32Array; mid: Float32Array; high: Float32Array; flux: Float32Array; lowFlux: Float32Array; cent: Float32Array; rms: Float32Array;
  /** band onsets for the audio matcher: 250 Hz–2 kHz (bass lines, snares, vocals) and > 4 kHz (hats, cymbals) */
  midFlux: Float32Array; highFlux: Float32Array;
}
/** Short-time features at 50 frames a second. */
export function frameFeatures(pcm: Float32Array, sr: number): Features {
  const hop = sr / FEAT_HZ;
  let nfft = 512; while (nfft < sr * 0.045) nfft <<= 1;
  const n = Math.max(0, Math.floor((pcm.length - nfft) / hop) + 1);
  const w = hann(nfft);
  const re = new Float64Array(nfft), im = new Float64Array(nfft);
  const bins = nfft / 2 + 1, df = sr / nfft;
  const prev = new Float64Array(bins);
  const f = (k: number) => new Float32Array(Math.max(0, k));
  const o: Features = { hz: FEAT_HZ, n, sub: f(n), low: f(n), mid: f(n), high: f(n), flux: f(n), lowFlux: f(n), cent: f(n), rms: f(n), midFlux: f(n), highFlux: f(n) };
  const kHi = Math.round(4000 / df);
  const kSub = Math.round(90 / df), kLow = Math.round(250 / df), kMid = Math.round(2000 / df), kKick = Math.max(1, Math.round(120 / df));
  for (let i = 0; i < n; i++) {
    const s = Math.round(i * hop);
    let e = 0;
    for (let j = 0; j < nfft; j++) { const v = pcm[s + j] ?? 0; re[j] = v * w[j]; im[j] = 0; e += v * v; }
    fft(re, im);
    let sub = 0, low = 0, mid = 0, high = 0, flux = 0, lflux = 0, mflux = 0, hflux = 0, cn = 0, cd = 0;
    for (let k = 1; k < bins; k++) {
      const m = Math.hypot(re[k], im[k]);
      const lm = Math.log1p(m * 10);
      const d = lm - prev[k]; prev[k] = lm;
      if (d > 0) { flux += d; if (k <= kKick) lflux += d; else if (k >= kLow && k < kMid) mflux += d; else if (k >= kHi) hflux += d; }
      if (k < kSub) sub += m; else if (k < kLow) low += m; else if (k < kMid) mid += m; else high += m;
      cn += m * k * df; cd += m;
    }
    o.sub[i] = sub; o.low[i] = low; o.mid[i] = mid; o.high[i] = high; o.flux[i] = flux; o.lowFlux[i] = lflux; o.midFlux[i] = mflux; o.highFlux[i] = hflux;
    o.cent[i] = cd > 0 ? cn / cd : 0; o.rms[i] = Math.sqrt(e / nfft);
  }
  return o;
}

// ---------------------------------------------------------------------------------------------------- kick envelope (1 kHz)
/** A 1 kHz onset envelope of the low band (the kick): low-pass (2 × one-pole at ~150 Hz), rectify, smooth, then the
 *  positive slope. Beat times are found on this, so the grid is ms-accurate. Returns its rate too. */
export function kickEnvelope(pcm: Float32Array, sr: number): { env: Float32Array; hz: number } {
  const hz = 1000, step = sr / hz;
  const a = Math.exp(-2 * Math.PI * 150 / sr);
  const n = Math.floor(pcm.length / step);
  const lvl = new Float32Array(n);
  let y1 = 0, y2 = 0, acc = 0, cnt = 0, k = 0, next = step;
  for (let i = 0; i < pcm.length && k < n; i++) {
    y1 = (1 - a) * pcm[i] + a * y1; y2 = (1 - a) * y1 + a * y2;
    acc += y2 * y2; cnt++;
    if (i + 1 >= next) { lvl[k++] = Math.sqrt(acc / Math.max(1, cnt)); acc = 0; cnt = 0; next += step; }
  }
  // log-compress, then the positive first difference over 4 ms
  const env = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) { const v = Math.log1p(lvl[i] * 50); const d = v - prev; prev = v * 0.6 + prev * 0.4; env[i] = d > 0 ? d : 0; }
  return { env, hz };
}

// ---------------------------------------------------------------------------------------------------- tempo + grid (own)
/** Fold the envelope at a tempo: a histogram of where in the beat its energy falls (bins per beat). */
function fold(env: Float32Array, hz: number, bpm: number, bins: number, from = 0, to = env.length): Float64Array {
  const h = new Float64Array(bins);
  const perSample = bpm / 60 / hz;
  for (let i = from; i < to; i++) { const v = env[i]; if (v <= 0) continue; const ph = (i * perSample) % 1; h[Math.floor(ph * bins) % bins] += v; }
  return h;
}
/** How peaked a fold is (the best ~10 % window over the mean): the tempo whose beats line up best is the sharpest. */
function sharp(h: Float64Array): { s: number; at: number } {
  const n = h.length, w = Math.max(1, Math.round(n * 0.03));
  let tot = 0; for (const v of h) tot += v;
  let best = -1, at = 0;
  for (let i = 0; i < n; i++) { let s = 0; for (let j = -w; j <= w; j++) s += h[(i + j + n) % n]; if (s > best) { best = s; at = i; } }
  return { s: tot > 0 ? best / tot * n / (2 * w + 1) : 0, at };
}
/** Coarse tempo candidates from the autocorrelation of a 100 Hz version of the envelope (60..220 BPM). */
function tempoCandidates(env: Float32Array, hz: number): number[] {
  const r = 100, k = hz / r;
  const m = Math.floor(env.length / k);
  const e = new Float64Array(m);
  for (let i = 0; i < m; i++) { let s = 0; for (let j = 0; j < k; j++) s += env[i * k + j]; e[i] = s; }
  let mean = 0; for (const v of e) mean += v; mean /= Math.max(1, m);
  for (let i = 0; i < m; i++) e[i] -= mean;
  const lo = Math.floor(60 * r / 220), hi = Math.ceil(60 * r / 60);
  const ac = new Float64Array(hi + 2);
  for (let lag = lo; lag <= hi + 1; lag++) { let s = 0; for (let i = lag; i < m; i++) s += e[i] * e[i - lag]; ac[lag] = s; }
  const peaks: { bpm: number; v: number }[] = [];
  for (let lag = lo + 1; lag <= hi; lag++) if (ac[lag] > ac[lag - 1] && ac[lag] >= ac[lag + 1] && ac[lag] > 0) {
    // parabolic refinement of the lag
    const d = (ac[lag - 1] - ac[lag + 1]) / (2 * (ac[lag - 1] - 2 * ac[lag] + ac[lag + 1]) || 1);
    peaks.push({ bpm: 60 * r / (lag + (Math.abs(d) < 1 ? d : 0)), v: ac[lag] });
  }
  peaks.sort((a, b) => b.v - a.v);
  return peaks.slice(0, 6).map((p) => p.bpm);
}
export interface OwnGrid { grid: TrackGrid; bpm: number; conf: number }
/** Our own constant-tempo grid from PCM (used when no DJ app analysed the track and the model isn't installed).
 *  Tempo by folding the kick envelope (sharpest fold wins; 0.002 BPM steps), phase = the fold's peak, octave chosen so
 *  the kick lands on every beat (60..220 BPM: hardcore at 200 isn't halved). */
export function ownGrid(pcm: Float32Array, sr: number, f?: Features): OwnGrid | null {
  const { env, hz } = kickEnvelope(pcm, sr);
  if (env.length < hz * 4) return null;
  const cands = tempoCandidates(env, hz);
  if (!cands.length) return null;
  // octave choice: test each candidate and its double / half within range
  const tryB = new Set<number>();
  for (const c of cands) for (const m of [0.5, 1, 2]) { const b = c * m; if (b >= 60 && b <= 225) tryB.add(+b.toFixed(3)); }
  let best = { bpm: 0, s: 0 };
  for (const b0 of tryB) {
    for (let d = -0.015; d <= 0.0151; d += 0.0025) {
      const b = b0 * (1 + d);
      const s = sharp(fold(env, hz, b, 96)).s;
      if (s > best.s) best = { bpm: b, s };
    }
  }
  if (!best.bpm) return null;
  // the octave: the fastest tempo whose fold is nearly as sharp AND has its energy on the beat (kicks on every beat)
  const octaves = [best.bpm / 2, best.bpm, best.bpm * 2].filter((b) => b >= 60 && b <= 225);
  const score = (b: number) => sharp(fold(env, hz, b, 96)).s;
  let bpm = best.bpm;
  for (const b of octaves.sort((a, b2) => b2 - a)) { if (score(b) >= 0.8 * score(best.bpm)) { bpm = b; break; } }
  // fine tempo (0.002 BPM)
  let fine = { bpm, s: score(bpm) };
  for (let step of [0.02, 0.005, 0.001]) {
    const c = fine.bpm;
    for (let b = c - step * 6; b <= c + step * 6 + 1e-9; b += step) { const s = sharp(fold(env, hz, b, 240)).s; if (s > fine.s) fine = { bpm: b, s }; }
    step = step + 0;
  }
  bpm = fine.bpm;
  const h = fold(env, hz, bpm, 240);
  const { at } = sharp(h);
  // the envelope's slope peaks a few ms after a kick's onset: KICK_BIAS_MS (measured on synthetic kicks, see tests)
  const period = 60000 / bpm;
  let firstMs = (at + 0.5) / 240 * period - KICK_BIAS_MS;
  while (firstMs < 0) firstMs += period;
  while (firstMs >= period) firstMs -= period;
  const grid = constantGrid(+firstMs.toFixed(2), +bpm.toFixed(3), 'vtp');
  grid.downbeat = f ? downbeatPhase(grid, f) : 0;
  return { grid, bpm: +bpm.toFixed(3), conf: Math.min(1, fine.s / 6) };
}
/** Delay of the kick envelope's slope peak after the true onset (ms), measured on synthetic kicks (tools/djtrack_unit.ts). */
export const KICK_BIAS_MS = 10;

/** Which beat of the bar is "1": sections change, crashes and impacts land on bar lines. The phase whose bar starts carry
 *  the biggest changes in band energy (and high-band onsets) wins. */
export function downbeatPhase(g: TrackGrid, f: Features): number {
  const per = beatFeatures(g, f);
  const n = per.n;
  if (n < 16) return 0;
  // per beat: normalised band levels + kick; the change between the 4 beats after and the 4 before each beat
  const cols = [per.kick, per.low, per.sub, per.mid, per.high, per.rms].map((a) => { const m = pct(a, 0.95) || 1; return a.map((v) => v / m); });
  const c = new Float64Array(n);
  for (let b = 4; b < n - 4; b++) {
    let d = 0;
    for (const A of cols) { let x = 0, y = 0; for (let k = 0; k < 4; k++) { x += A[b + k]; y += A[b - 1 - k]; } d += Math.abs(x - y) / 4; }
    c[b] = d + 0.3 * (per.hiOn[b] / (pct(per.hiOn, 0.95) || 1));
  }
  // each beat's prominence over its neighbours; the strongest changes vote for their bar phase
  const prom: { b: number; v: number }[] = [];
  for (let b = 5; b < n - 5; b++) { const v = c[b] - Math.max(c[b - 1], c[b + 1]); if (v > 0) prom.push({ b, v: c[b] }); }
  prom.sort((x, y) => y.v - x.v);
  const sc = [0, 0, 0, 0];
  for (const p of prom.slice(0, Math.max(6, Math.round(n / 64)))) sc[(((per.b0 + p.b) % 4) + 4) % 4] += p.v;
  let best = 0; for (let i = 1; i < 4; i++) if (sc[i] > sc[best]) best = i;
  return best;
}

// ---------------------------------------------------------------------------------------------------- beat / bar features
interface BeatFeat { b0: number; n: number; low: Float64Array; mid: Float64Array; high: Float64Array; sub: Float64Array; kick: Float64Array; flux: Float64Array; hiOn: Float64Array; rms: Float64Array; cent: Float64Array }
/** Per beat (from the first whole beat in the file): mean band levels, kick strength at the beat, onset density. */
function beatFeatures(g: TrackGrid, f: Features): BeatFeat {
  const durMs = f.n / f.hz * 1000;
  const b0 = Math.ceil(msToBeat(g, 0) - 1e-6), b1 = Math.floor(msToBeat(g, durMs)) - 1;
  const n = Math.max(0, b1 - b0);
  const z = () => new Float64Array(n);
  const o: BeatFeat = { b0, n, low: z(), mid: z(), high: z(), sub: z(), kick: z(), flux: z(), hiOn: z(), rms: z(), cent: z() };
  const fr = (ms: number) => Math.max(0, Math.min(f.n - 1, Math.round(ms / 1000 * f.hz)));
  for (let i = 0; i < n; i++) {
    const a = fr(beatToMs(g, b0 + i)), b = Math.max(a + 1, fr(beatToMs(g, b0 + i + 1)));
    let lo = 0, mi = 0, hi = 0, su = 0, fl = 0, rm = 0, ce = 0;
    for (let k = a; k < b; k++) { lo += f.low[k]; mi += f.mid[k]; hi += f.high[k]; su += f.sub[k]; fl += f.flux[k]; rm += f.rms[k]; ce += f.cent[k]; }
    const m = b - a;
    o.low[i] = lo / m; o.mid[i] = mi / m; o.high[i] = hi / m; o.sub[i] = su / m; o.flux[i] = fl / m; o.rms[i] = rm / m; o.cent[i] = ce / m;
    // the kick: the sub band JUMPS at the beat (a sustained bass note doesn't; a snare's noise barely reaches it)
    let up = 0, before = Infinity;
    for (let k = Math.max(0, a - 1); k <= Math.min(f.n - 1, a + 2); k++) up = Math.max(up, f.sub[k]);
    for (let k = Math.max(0, a - 4); k <= Math.max(0, a - 2); k++) before = Math.min(before, f.sub[k]);
    o.kick[i] = Math.max(0, up - (Number.isFinite(before) ? before : 0));
    let ho = 0; for (let k = Math.max(0, a - 1); k <= Math.min(f.n - 1, a + 2); k++) ho = Math.max(ho, f.flux[k] - f.lowFlux[k]);
    o.hiOn[i] = ho;
  }
  return o;
}
const norm = (a: Float64Array) => { let m = 0; for (const v of a) m = Math.max(m, v); return m > 0 ? a.map((v) => v / m) : a; };
const pct = (a: ArrayLike<number>, p: number) => { const s = Array.from(a).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };

// ---------------------------------------------------------------------------------------------------- sections
export interface SectionGuess { bar: number; bars: number; sec: ShowSection; kick: number; energy: number }
/**
 * Sections on the bar lattice. Bar features (kick presence, energy, bass, highs, onset density) → a novelty curve
 * (4-bar windows either side of each bar line) → boundaries snapped to the 4-bar lattice → EDM labels by rule:
 * drop = kick + high energy after a kick-less / quieter stretch; build = kick-less (or thinning) with rising highs right
 * before a drop; breakdown = no kick, low energy; intro / outro = the first / last section; groove = the rest.
 */
export function sections(g: TrackGrid, f: Features): { bars: SectionGuess[]; barStart: number; energy: number[]; bf: BeatFeat } {
  const bf = beatFeatures(g, f);
  // first bar start at or after the first whole beat
  let first = bf.b0; while ((((first - g.downbeat) % 4) + 4) % 4 !== 0) first++;
  const nb = Math.floor((bf.b0 + bf.n - first) / 4);
  const kick = norm(bf.kick), rms = norm(bf.rms), sub = norm(bf.sub.map((v, i) => v + bf.low[i])), high = norm(bf.high), dens = norm(bf.flux);
  const bar = (arr: Float64Array, i: number) => { let s = 0; for (let k = 0; k < 4; k++) s += arr[first - bf.b0 + i * 4 + k] ?? 0; return s / 4; };
  // kick presence per bar: the kick strength at beats vs between (a sustained bass note isn't a kick)
  const K = new Float64Array(nb), E = new Float64Array(nb), B = new Float64Array(nb), H = new Float64Array(nb), D = new Float64Array(nb);
  for (let i = 0; i < nb; i++) { K[i] = bar(kick, i); E[i] = bar(rms, i); B[i] = bar(sub, i); H[i] = bar(high, i); D[i] = bar(dens, i); }
  const kickRef = pct(K, 0.9) || 1, eRef = pct(E, 0.95) || 1;
  const kOn = (i: number) => K[i] > 0.4 * kickRef;
  // novelty at each bar line
  const W = 4, nov = new Float64Array(nb);
  for (let i = W; i <= nb - 2; i++) {
    let d = 0;
    for (const A of [K, E, B, H, D]) {
      let a = 0, b = 0, na = 0, nb2 = 0;
      for (let k = i - W; k < i; k++) { a += A[k]; na++; }
      for (let k = i; k < Math.min(nb, i + W); k++) { b += A[k]; nb2++; }
      d += Math.abs(a / na - b / nb2) * (A === K ? 2 : 1);
    }
    nov[i] = d;
  }
  // a boundary = a local peak (±2 bars) of the novelty that is clearly there (a fifth of the strongest change)
  const nMax = Math.max(...nov, 0);
  const cuts: number[] = [0];
  for (let i = 2; i < nb - 1; i++) {
    const v = nov[i];
    if (v < Math.max(0.25, 0.18 * nMax)) continue;
    let peak = true; for (let k = i - 2; k <= i + 2; k++) if (k !== i && k >= 0 && k < nb && nov[k] > v) peak = false;
    if (!peak) continue;
    // snap to the 4-bar lattice when close (phrases are 4 / 8 / 16 bars)
    const snapped = Math.abs(i - Math.round(i / 4) * 4) <= 1 ? Math.round(i / 4) * 4 : i;
    if (snapped - cuts[cuts.length - 1] >= 4 && snapped < nb) cuts.push(snapped);
  }
  // a kick that starts / stops is always a boundary (on its own bar line)
  for (let i = 1; i < nb; i++) if (kOn(i) !== kOn(i - 1) && kOn(i) === kOn(Math.min(nb - 1, i + 1)) && !cuts.some((c) => Math.abs(c - i) < 2)) cuts.push(i);
  cuts.sort((a, b) => a - b);
  const segs = cuts.map((c, k) => ({ bar: c, bars: (k + 1 < cuts.length ? cuts[k + 1] : nb) - c })).filter((s) => s.bars > 0);
  const stat = (s: { bar: number; bars: number }, A: Float64Array) => { let x = 0; for (let k = s.bar; k < s.bar + s.bars; k++) x += A[k]; return x / s.bars; };
  const kickFrac = (s: { bar: number; bars: number }) => { let x = 0; for (let k = s.bar; k < s.bar + s.bars; k++) if (kOn(k)) x++; return x / s.bars; };
  const segE = segs.map((s) => stat(s, E) / eRef), segK = segs.map(kickFrac), segH = segs.map((s) => stat(s, H)), segB = segs.map((s) => stat(s, B));
  const maxE = Math.max(...segE.map((e, i) => (segK[i] > 0.5 ? e + segB[i] * 0.3 : 0)), 1e-6);
  const loud = (i: number) => segK[i] > 0.5 && (segE[i] + segB[i] * 0.3) >= 0.85 * maxE;
  const out: SectionGuess[] = segs.map((s, i) => ({ bar: s.bar, bars: s.bars, sec: 'groove' as ShowSection, kick: +segK[i].toFixed(2), energy: +segE[i].toFixed(2) }));
  for (let i = 0; i < out.length; i++) {
    const kickless = segK[i] <= 0.5;
    if (loud(i)) {
      const prev = i > 0 ? i - 1 : -1;
      const prevQuiet = prev >= 0 && (segK[prev] <= 0.5 || (segE[prev] + segB[prev] * 0.3) < 0.75 * maxE);
      out[i].sec = prevQuiet || (prev >= 0 && out[prev].sec === 'drop') ? 'drop' : i === 0 ? 'intro' : 'groove';
      continue;
    }
    if (kickless) {
      const nextLoud = i + 1 < out.length && loud(i + 1);
      // rising highs inside the section = a build (risers, rolls)
      const s = segs[i];
      const half = Math.max(1, Math.floor(s.bars / 2));
      let h1 = 0, h2 = 0; for (let k = 0; k < half; k++) { h1 += H[s.bar + k] + D[s.bar + k]; h2 += H[s.bar + s.bars - 1 - k] + D[s.bar + s.bars - 1 - k]; }
      const rising = h2 > h1 * 1.15;
      out[i].sec = i === 0 ? 'intro' : nextLoud && (rising || s.bars <= 8) ? 'build' : 'breakdown';
      continue;
    }
    out[i].sec = i === 0 ? 'intro' : 'groove';
  }
  // the last section, when it's not a drop, is the outro
  if (out.length > 1 && out[out.length - 1].sec !== 'drop') out[out.length - 1].sec = 'outro';
  // a long breakdown that ends in rising highs before a drop: its last 8 bars are the build
  for (let i = out.length - 2; i >= 0; i--) {
    if (out[i].sec !== 'breakdown' || out[i + 1].sec !== 'drop' || out[i].bars < 16) continue;
    const s = out[i], tail = 8;
    let h1 = 0, h2 = 0; for (let k = 0; k < tail; k++) { h1 += H[s.bar + s.bars - 2 * tail + k] ?? 0; h2 += H[s.bar + s.bars - tail + k] ?? 0; }
    if (h2 > h1 * 1.15) out.splice(i + 1, 0, { bar: s.bar + s.bars - tail, bars: tail, sec: 'build', kick: s.kick, energy: s.energy }), s.bars -= tail;
  }
  // merge neighbours with the same label
  const merged: SectionGuess[] = [];
  for (const s of out) { const p = merged[merged.length - 1]; if (p && p.sec === s.sec) p.bars += s.bars; else merged.push({ ...s }); }
  const energy = Array.from(E, (v) => Math.round(Math.max(0, Math.min(1, v / eRef)) * 255));
  return { bars: merged, barStart: first, energy, bf };
}
const KIND_OF: Record<ShowSection, PhraseKind> = { intro: 'intro', groove: 'groove', build: 'build', drop: 'drop', breakdown: 'breakdown', outro: 'outro' };

// ---------------------------------------------------------------------------------------------------- events
export function findEvents(g: TrackGrid, secs: SectionGuess[], barStart: number, bf: BeatFeat, f: Features): TrackEvent[] {
  const ev: TrackEvent[] = [];
  const hi = norm(bf.high), dens = norm(bf.flux), rms = norm(bf.rms);
  const at = (b: number) => b - bf.b0;
  for (let i = 0; i < secs.length; i++) {
    const s = secs[i], b0 = barStart + s.bar * 4, len = s.bars * 4;
    if (s.sec === 'build') {
      // riser: the highs / centroid climb through the build
      let a = 0, z = 0; const q = Math.max(1, Math.floor(len / 4));
      for (let k = 0; k < q; k++) { a += (hi[at(b0 + k)] ?? 0) + (bf.cent[at(b0 + k)] ?? 0) / 4000; z += (hi[at(b0 + len - 1 - k)] ?? 0) + (bf.cent[at(b0 + len - 1 - k)] ?? 0) / 4000; }
      if (z > a * 1.2 && len >= 8) ev.push({ beat: b0, kind: 'riser', len, v: +Math.min(1, (z - a) / Math.max(1e-6, z)).toFixed(2) });
      // snare roll: onset density per bar at least doubles
      const d1 = (dens[at(b0)] ?? 0) + (dens[at(b0 + 1)] ?? 0), d2 = (dens[at(b0 + len - 2)] ?? 0) + (dens[at(b0 + len - 1)] ?? 0);
      if (d2 > 1.4 * d1 && d2 > 0.2) ev.push({ beat: b0, kind: 'roll', len });
    }
    if (s.sec === 'drop' && i > 0 && secs[i - 1].sec !== 'drop') {
      // pre-drop gap: the last half beat before the drop is near-silent
      const fr = (ms: number) => Math.max(0, Math.min(f.n - 1, Math.round(ms / 1000 * f.hz)));
      const dMs = beatToMs(g, b0), half = 60000 / (g.anchors[0].bpm || 120) / 2;
      let gap = 0, ref = 0, ng = 0, nr = 0;
      for (let k = fr(dMs - half); k <= fr(dMs - 50); k++) { gap += f.rms[k]; ng++; }   // (a frame spans ~46 ms from its start)
      for (let k = fr(dMs - half * 9); k < fr(dMs - half * 2); k++) { ref += f.rms[k]; nr++; }
      if (ng && nr && gap / ng < 0.3 * (ref / nr)) ev.push({ beat: b0 - 0.5, kind: 'gap', len: 0.5 });
    }
  }
  // impacts: a broadband hit on a downbeat that stands far above its surroundings (at most one per 8 bars)
  const fl = Array.from(bf.flux), mean = fl.reduce((s, v) => s + v, 0) / Math.max(1, fl.length);
  const sd = Math.sqrt(fl.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, fl.length));
  let last = -1e9;
  for (let i = 1; i < bf.n; i++) {
    const b = bf.b0 + i;
    if ((((b - g.downbeat) % 4) + 4) % 4 !== 0) continue;
    if (bf.flux[i] > mean + 2.5 * sd && rms[i] > 0.5 && b - last >= 32) { ev.push({ beat: b, kind: 'impact', v: +Math.min(1, (bf.flux[i] - mean) / (4 * sd || 1)).toFixed(2) }); last = b; }
  }
  return ev.sort((a, b) => a.beat - b.beat);
}

// ---------------------------------------------------------------------------------------------------- drum hits + groove
/** One drum hit at its attack (ms), from the 1 kHz band envelopes below. */
export interface OfflineHit { ms: number; kind: 'kick' | 'snare'; w: number }
/** The positive slope of a band's log level at 1 kHz (2nd-order high-pass `lo` / low-pass `hi`, 3 ms smoothing). */
function slopeEnv(pcm: Float32Array, sr: number, lo: number, hi: number, level?: { out: Float32Array | null }): Float32Array {
  const step = sr / 1000, n = Math.floor(pcm.length / step);
  const coef = (kind: 'lp' | 'hp', f: number) => { const w = 2 * Math.PI * f / sr, al = Math.sin(w) / (2 * 0.707), c = Math.cos(w), a0 = 1 + al;
    return kind === 'lp' ? [(1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, -2 * c / a0, (1 - al) / a0] : [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - al) / a0]; };
  const fs: number[][] = []; if (lo > 0) fs.push(coef('hp', lo)); fs.push(coef('lp', hi), coef('lp', hi));
  const st = fs.map(() => [0, 0, 0, 0]);
  const a = Math.exp(-1 / (0.003 * sr));
  const lvl = new Float32Array(n);
  let env = 0, mx = 0, k = 0, next = step;
  for (let i = 0; i < pcm.length && k < n; i++) {
    let x = pcm[i];
    for (let j = 0; j < fs.length; j++) { const f = fs[j], q = st[j]; const y = f[0] * x + f[1] * q[0] + f[2] * q[1] - f[3] * q[2] - f[4] * q[3]; q[1] = q[0]; q[0] = x; q[3] = q[2]; q[2] = y; x = y; }
    env = Math.max(Math.abs(x), env * a); mx = Math.max(mx, env);
    if (i + 1 >= next) { lvl[k++] = 20 * Math.log10(mx + 1e-7); mx = 0; next += step; }
  }
  const out = new Float32Array(n);
  for (let i = 4; i < n; i++) { const d = lvl[i] - Math.min(lvl[i - 4], lvl[i - 3]); out[i] = d > 0 ? d : 0; }
  if (level) level.out = lvl;
  return out;
}
/** Peaks of a slope envelope: the largest within ±`gap` ms, above an adaptive floor (median + 3 MAD of ±0.5 s) and
 *  a fixed rise; the attack time is where the slope first reaches half of the peak. */
function slopePeaks(e: Float32Array, minRise: number, gap: number): { ms: number; v: number }[] {
  const out: { ms: number; v: number }[] = [];
  const W = 500, buf: number[] = [];
  for (let i = W; i < e.length - W; i++) {
    const v = e[i];
    if (v < minRise) continue;
    let ok = true; for (let j = Math.max(0, i - gap); j <= Math.min(e.length - 1, i + gap); j++) if (e[j] > v || (e[j] === v && j < i)) { ok = false; break; }
    if (!ok) continue;
    buf.length = 0; for (let j = i - W; j < i + W; j += 5) buf.push(e[j]);
    buf.sort((x, y) => x - y);
    const med = buf[buf.length >> 1], mad = buf.map((x) => Math.abs(x - med)).sort((x, y) => x - y)[buf.length >> 1];
    if (v < med + 3 * Math.max(mad, 0.5)) continue;
    let a = i; while (a > i - 30 && e[a - 1] >= v * 0.5) a--;
    out.push({ ms: a, v });
  }
  return out;
}
/** Every kick and snare / clap of a track (offline, ms-accurate): the low band's attacks (< 160 Hz) and the noisy
 *  1.5-7 kHz band's attacks that the low band doesn't share. */
export function drumHits(pcm: Float32Array, sr: number): OfflineHit[] {
  const hiL = { out: null as Float32Array | null };
  const lo = slopeEnv(pcm, sr, 0, 160), hi = slopeEnv(pcm, sr, 1500, 7000, hiL);
  const subL = { out: null as Float32Array | null }, mlL = { out: null as Float32Array | null };
  slopeEnv(pcm, sr, 0, 80, subL); slopeEnv(pcm, sr, 110, 320, mlL);
  const sub = subL.out!, ml = mlL.out!;
  const mx = (e: Float32Array, a: number, b: number) => { let m = -Infinity; for (let i = Math.max(0, a); i <= Math.min(e.length - 1, b); i++) m = Math.max(m, e[i]); return m; };
  const at = (e: Float32Array, i: number) => e[Math.max(0, Math.min(e.length - 1, i))];
  // a kick drum's punch (110-320 Hz) dies faster than its sub (the pitch drop every kick has): a bass note doesn't do that
  const kp = slopePeaks(lo, 4, 60).filter((p) => (mx(ml, p.ms, p.ms + 15) - at(ml, p.ms + 70)) - (mx(sub, p.ms, p.ms + 25) - at(sub, p.ms + 70)) >= 4 || p.v >= 9);
  // a snare / clap RINGS (its noise is still within 18 dB of its peak 40 ms later); a kick's click is gone by then
  const hl = hiL.out!;
  const sp = slopePeaks(hi, 5, 60).filter((p) => at(hl, p.ms + 40) >= mx(hl, p.ms, p.ms + 15) - 18);
  const ref = (p: { v: number }[]) => { const v = p.map((x) => x.v).sort((a, b) => a - b); return v[Math.floor(v.length * 0.97)] || 1; };
  const kr = ref(kp), sref = ref(sp);
  const out: OfflineHit[] = kp.map((p) => ({ ms: p.ms, kind: 'kick' as const, w: Math.min(1, p.v / kr) }));
  for (const p of sp) { if (kp.some((k) => Math.abs(k.ms - p.ms) < 12 && k.v / kr > 1.5 * p.v / sref)) continue; out.push({ ms: p.ms, kind: 'snare', w: Math.min(1, p.v / sref) }); }
  return out.filter((h) => h.w >= 0.4).sort((a, b) => a.ms - b.ms);
}
/** The groove of each span [b, e) on the track's grid (bars from the grid's downbeat): feel, confidence, hits (the
 *  wire form of shared/groove.ts, slots relative to the bar). */
export function grooveSpans(g: TrackGrid, hits: OfflineHit[], spans: { b: number; e: number }[]): NonNullable<TrackAnalysis['groove']> {
  const out: NonNullable<TrackAnalysis['groove']> = [];
  for (const sp of spans) {
    if (sp.e - sp.b < 8) continue;
    const gt = new GrooveTracker({ decay: 1, fixedBar: true });
    const a = beatToMs(g, sp.b), z = beatToMs(g, sp.e);
    gt.tick(sp.b - g.downbeat);
    for (const h of hits) if (h.ms >= a - 60 && h.ms < z - 60) gt.hit(h.kind, msToBeat(g, h.ms) - g.downbeat, Math.max(0.5, h.w));
    gt.tick(sp.e - g.downbeat - 0.2); gt.flush();
    const st = gt.state, w = grooveToWire(st);
    out.push({ b: sp.b, e: sp.e, f: w.gf, c: w.gc, h: w.gh });
  }
  return out;
}
/** Per bar (from bar start `from`): where its downbeat really hits, in 1/1000 beat from the grid line (the strongest
 *  kick / snare within ±0.2 beat; −9999 = none) — drops, impacts and phrase cues land on the hit, not the grid line. */
export function downbeatHits(g: TrackGrid, hits: OfflineHit[], from: number, bars: number): number[] {
  const out: number[] = [];
  let j = 0;
  for (let i = 0; i < bars; i++) {
    const b = from + i * 4, ms = beatToMs(g, b), per = 60000 / (g.anchors[0].bpm || 120);
    while (j < hits.length && hits[j].ms < ms - 0.2 * per) j++;
    let best: OfflineHit | null = null;
    for (let k = j; k < hits.length && hits[k].ms <= ms + 0.2 * per; k++) if (!best || hits[k].w * (hits[k].kind === 'kick' ? 1.2 : 1) > best.w * (best.kind === 'kick' ? 1.2 : 1)) best = hits[k];
    out.push(best && best.w >= 0.4 ? Math.round((msToBeat(g, best.ms) - b) * 1000) : -9999);
  }
  return out;
}
void FEELS;

// ---------------------------------------------------------------------------------------------------- waveform + fingerprint
/** Overview waveform: `cols` columns of [low, mid, high] peaks (0..255). */
export function overviewBands(f: Features, cols = 1200): Uint8Array {
  const out = new Uint8Array(cols * 3);
  const lo = Float64Array.from(f.sub, (v, i) => v + f.low[i]);
  const mx = [pct(lo, 0.995) || 1, pct(f.mid, 0.995) || 1, pct(f.high, 0.995) || 1];
  for (let c = 0; c < cols; c++) {
    const a = Math.floor(c * f.n / cols), b = Math.max(a + 1, Math.floor((c + 1) * f.n / cols));
    let l = 0, m = 0, h = 0;
    for (let k = a; k < b && k < f.n; k++) { l = Math.max(l, lo[k]); m = Math.max(m, f.mid[k]); h = Math.max(h, f.high[k]); }
    out[c * 3] = Math.min(255, Math.round(l / mx[0] * 255)); out[c * 3 + 1] = Math.min(255, Math.round(m / mx[1] * 255)); out[c * 3 + 2] = Math.min(255, Math.round(h / mx[2] * 255));
  }
  return out;
}
/** The aligner's live / reference features: onset + low-band flux at 50 Hz, as 0..1 floats. */
export function printEnvelopes(f: Features): { onset: Float32Array; low: Float32Array; mid: Float32Array; high: Float32Array } {
  const q = (a: Float32Array) => { const m = pct(a, 0.99) || 1; return a.map((v) => Math.min(1, v / m)); };
  return { onset: q(f.flux), low: q(f.lowFlux), mid: q(f.midFlux), high: q(f.highFlux) };
}
export function quantPrint(a: Float32Array): Uint8Array { return Uint8Array.from(a, (v) => Math.round(Math.max(0, Math.min(1, v)) * 255)); }

// ---------------------------------------------------------------------------------------------------- the whole analysis
export interface AnalyseOptions {
  /** The DJ app's grid (wins over our own beat tracking). */
  grid?: TrackGrid | null;
  /** Beat This! output (beat / downbeat times, ms) when the model ran. */
  beatThis?: { beats: number[]; downbeats: number[] } | null;
  /** Keep the fingerprint (needed for audio matching). */
  print?: boolean;
}
/** Decoded mono PCM → our part of a TrackAnalysis (merge it over the DJ app's with mergeAnalysis). */
export function analysePcm(pcm: Float32Array, sr: number, id: string, o: AnalyseOptions = {}): TrackAnalysis {
  const f = frameFeatures(pcm, sr);
  const durMs = pcm.length / sr * 1000;
  let grid: TrackGrid | null = o.grid ?? null, beats: 'beatthis' | 'dsp' | 'grid' = 'grid';
  if (!grid && o.beatThis && o.beatThis.beats.length > 8) { grid = fitGrid(o.beatThis.beats, o.beatThis.downbeats); beats = 'beatthis'; }
  if (!grid) { const own = ownGrid(pcm, sr, f); grid = own?.grid ?? null; beats = 'dsp'; }
  const a: TrackAnalysis = { v: 1, id, durMs: Math.round(durMs), bpm: grid ? grid.anchors[0].bpm : 0, grid, phrases: [], events: [], cues: [], srcs: ['vtp'], ours: { at: Date.now(), beats, v: ANALYSIS_VERSION } };
  if (grid) {
    const sx = sections(grid, f);
    const endBeat = Math.floor(msToBeat(grid, durMs));
    const starts = sx.bars.map((s) => ({ beat: sx.barStart + s.bar * 4, kind: KIND_OF[s.sec] }));
    a.phrases = phrasesFrom(starts, endBeat, 'vtp') as TrackPhrase[];
    a.energy = sx.energy;
    a.events = findEvents(grid, sx.bars, sx.barStart, sx.bf, f);
    // the drums at ms accuracy: the groove per phrase (the show's per-hit accents) and where each downbeat really hits
    const hits = drumHits(pcm, sr);
    a.groove = grooveSpans(grid, hits, a.phrases.flatMap((p) => { const out: { b: number; e: number }[] = []; for (let b = p.beat; b < p.end; b += 32) out.push({ b, e: Math.min(p.end, b + 32) }); return out; }));
    const nBars = Math.max(0, Math.floor((endBeat - sx.barStart) / 4));
    a.downHits = { from: sx.barStart, off: downbeatHits(grid, hits, sx.barStart, nBars) };
    // impacts / gaps on their real hit (findEvents works in whole beats)
    for (const e of a.events) if (e.kind === 'impact') { const k = Math.round((e.beat - sx.barStart) / 4); const o = a.downHits.off[k]; if (o !== undefined && o > -9999 && Math.abs(sx.barStart + k * 4 - e.beat) < 0.01) e.beat = +(e.beat + o / 1000).toFixed(3); }
  }
  a.bands = { cols: 1200, b64: bytesToB64(overviewBands(f, 1200)), src: 'vtp' };
  // spectral landmarks: which track plays, from a few seconds of the music input (shared/landmarks.ts)
  if (o.print !== false && sr === LM.sr) { const lm = landmarksOf(pcm); a.lm = { v: 1, n: lm.h.length, b64: bytesToB64(encodeLandmarks(lm)) }; }
  if (o.print !== false) { const p = printEnvelopes(f); a.fp = { hz: FEAT_HZ, onset: bytesToB64(quantPrint(p.onset)), low: bytesToB64(quantPrint(p.low)) }; }   // (onset + kick band: they only sharpen a place the landmarks found; the library stays small)
  return a;
}

// ---------------------------------------------------------------------------------------------------- Beat This! front end
/** Beat This! input: 22050 Hz mono, n_fft 1024, hop 441 (50 fps), Hann (periodic), centre-padded (reflect), magnitude
 *  normalised by the window's energy ("frame_length"), 128 Slaney mel bands 30..11000 Hz with un-normalised triangles,
 *  log1p(1000 · mel). Output frames × 128 (row-major), the model's `spectrogram` input. */
export const BT = { sr: 22050, nfft: 1024, hop: 441, mels: 128, fmin: 30, fmax: 11000, fps: 50 } as const;
const hzToMel = (f: number) => (f < 1000 ? f / (200 / 3) : 15 + Math.log(f / 1000) / (Math.log(6.4) / 27));
const melToHz = (m: number) => (m < 15 ? m * (200 / 3) : 1000 * Math.exp((m - 15) * (Math.log(6.4) / 27)));
let fbCache: Float64Array[] | null = null;
/** The mel filter bank (128 × 513), torchaudio's melscale_fbanks(norm=None, mel_scale='slaney'). */
export function melBank(): Float64Array[] {
  if (fbCache) return fbCache;
  const nF = BT.nfft / 2 + 1, top = Math.floor(BT.sr / 2);
  const all = Array.from({ length: nF }, (_, i) => top * i / (nF - 1));
  const mMin = hzToMel(BT.fmin), mMax = hzToMel(BT.fmax);
  const fPts = Array.from({ length: BT.mels + 2 }, (_, i) => melToHz(mMin + (mMax - mMin) * i / (BT.mels + 1)));
  const bank: Float64Array[] = [];
  for (let m = 0; m < BT.mels; m++) {
    const row = new Float64Array(nF);
    const d0 = fPts[m + 1] - fPts[m], d1 = fPts[m + 2] - fPts[m + 1];
    for (let k = 0; k < nF; k++) {
      const down = (all[k] - fPts[m]) / d0, up = (fPts[m + 2] - all[k]) / d1;
      row[k] = Math.max(0, Math.min(down, up));
    }
    bank.push(row);
  }
  fbCache = bank;
  return bank;
}
export function beatThisMel(pcm: Float32Array): { data: Float32Array; frames: number } {
  const { nfft, hop, mels } = BT;
  const pad = nfft / 2;
  const n = pcm.length;
  const frames = 1 + Math.floor(n / hop);
  const at = (i: number) => {   // reflect padding (torch.stft center=True, pad_mode='reflect')
    let j = i - pad;
    if (n <= 1) return pcm[0] ?? 0;
    while (j < 0 || j >= n) { if (j < 0) j = -j; if (j >= n) j = 2 * (n - 1) - j; }
    return pcm[j];
  };
  const w = hann(nfft);
  let wn = 0; for (const v of w) wn += v * v; wn = Math.sqrt(wn);
  const bank = melBank();
  const out = new Float32Array(frames * mels);
  const re = new Float64Array(nfft), im = new Float64Array(nfft), mag = new Float64Array(nfft / 2 + 1);
  for (let t = 0; t < frames; t++) {
    for (let j = 0; j < nfft; j++) { re[j] = at(t * hop + j) * w[j]; im[j] = 0; }
    fft(re, im);
    for (let k = 0; k <= nfft / 2; k++) mag[k] = Math.hypot(re[k], im[k]) / wn;
    for (let m = 0; m < mels; m++) {
      const row = bank[m]; let s = 0;
      for (let k = 0; k < row.length; k++) if (row[k]) s += row[k] * mag[k];
      out[t * mels + m] = Math.log1p(1000 * s);
    }
  }
  return { data: out, frames };
}
/** Beat This!'s minimal post-processing: logit peaks (> 0, the max of a 7-frame window), neighbours merged, downbeats
 *  moved onto the nearest beat. Frames → ms. */
export function beatThisPeaks(beat: Float32Array, down: Float32Array, fps = BT.fps): { beats: number[]; downbeats: number[] } {
  const peaks = (x: Float32Array) => {
    const idx: number[] = [];
    for (let i = 0; i < x.length; i++) {
      if (!(x[i] > 0)) continue;
      let mx = -Infinity; for (let k = Math.max(0, i - 3); k <= Math.min(x.length - 1, i + 3); k++) mx = Math.max(mx, x[k]);
      if (x[i] === mx) idx.push(i);
    }
    // merge peaks one frame apart (keep their mean)
    const out: number[] = [];
    for (let i = 0; i < idx.length; i++) {
      if (i + 1 < idx.length && idx[i + 1] - idx[i] <= 1) { out.push((idx[i] + idx[i + 1]) / 2); i++; } else out.push(idx[i]);
    }
    return out;
  };
  const b = peaks(beat).map((i) => i / fps * 1000);
  const d = peaks(down).map((i) => i / fps * 1000).map((t) => b.reduce((best, x) => (Math.abs(x - t) < Math.abs(best - t) ? x : best), b[0] ?? t));
  return { beats: b, downbeats: [...new Set(d)] };
}
/** Run Beat This! over a long spectrogram in chunks (1500 frames, 6-frame borders), the way the reference does. */
export async function beatThisChunks(spec: { data: Float32Array; frames: number }, run: (chunk: Float32Array, frames: number) => Promise<{ beat: Float32Array; downbeat: Float32Array }>, chunk = 1500, border = 6) {
  const { frames } = spec, M = BT.mels;
  const beat = new Float32Array(frames).fill(-10), downbeat = new Float32Array(frames).fill(-10);
  const step = chunk - 2 * border;
  for (let s = -border; s < frames - border; s += step) {
    const a = Math.max(0, s), b = Math.min(frames, s + chunk);
    const r = await run(spec.data.subarray(a * M, b * M), b - a);
    const keepFrom = s <= 0 ? 0 : border, keepTo = b >= frames ? b - a : b - a - border;
    for (let k = keepFrom; k < keepTo; k++) { beat[a + k] = r.beat[k]; downbeat[a + k] = r.downbeat[k]; }
  }
  return { beat, downbeat };
}

// ---------------------------------------------------------------------------------------------------- grid fit
/** Beat times (ms, noisy, with misses / extras) → a constant-tempo grid: the median interval seeds the period, then
 *  repeated least squares over the beats that fit (residual < 35 ms). Downbeats vote for the bar phase. A tempo that
 *  really changes (the fit leaves a long run of large residuals) splits into two segments. */
export function fitGrid(beatsMs: number[], downbeatsMs: number[] = [], src: TrackSrc = 'vtp'): TrackGrid | null {
  const b = beatsMs.filter(Number.isFinite).sort((x, y) => x - y);
  if (b.length < 4) return null;
  const fitSeg = (pts: number[]) => {
    const iv = pts.slice(1).map((v, i) => v - pts[i]).filter((d) => d > 200 && d < 1100).sort((x, y) => x - y);
    let P = iv.length ? iv[Math.floor(iv.length / 2)] : 500, t0 = pts[0];
    let keep = pts;
    for (let it = 0; it < 6; it++) {
      const idx = keep.map((t) => Math.round((t - t0) / P));
      // least squares t = t0 + i·P
      const n = keep.length; let si = 0, st = 0, sii = 0, sit = 0;
      for (let k = 0; k < n; k++) { si += idx[k]; st += keep[k]; sii += idx[k] * idx[k]; sit += idx[k] * keep[k]; }
      const den = n * sii - si * si; if (!den) break;
      P = (n * sit - si * st) / den; t0 = (st - P * si) / n;
      keep = pts.filter((t) => { const r = (t - t0) / P; return Math.abs(r - Math.round(r)) * P < 35; });
      if (keep.length < 4) break;
    }
    return { P, t0, inl: keep.length / pts.length };
  };
  const whole = fitSeg(b);
  let anchors = [{ ms: whole.t0, beat: 0, bpm: 60000 / whole.P }];
  // tempo change: refit halves when the whole fit is poor and the halves are good
  if (whole.inl < 0.8 && b.length > 32) {
    let best: { k: number; s: number; A: ReturnType<typeof fitSeg>; B: ReturnType<typeof fitSeg> } | null = null;
    for (let k = 16; k < b.length - 16; k += 4) {
      const A = fitSeg(b.slice(0, k)), B = fitSeg(b.slice(k));
      const s = (A.inl * k + B.inl * (b.length - k)) / b.length;
      if (!best || s > best.s) best = { k, s, A, B };
    }
    if (best && best.s > whole.inl + 0.1) {
      const A = best.A, B = best.B;
      const splitMs = b[best.k];
      const beatAtSplit = Math.round((splitMs - A.t0) / A.P);
      const bMs = B.t0 + Math.round((splitMs - B.t0) / B.P) * B.P;
      anchors = [{ ms: A.t0, beat: 0, bpm: 60000 / A.P }, { ms: bMs, beat: beatAtSplit, bpm: 60000 / B.P }];
    }
  }
  // move beat 0 to the first beat at or after the file start (keeps beat numbers positive)
  const a0 = anchors[0];
  const per = 60000 / a0.bpm;
  const shift = Math.floor(a0.ms / per);
  if (shift > 0 && anchors.length === 1) { a0.ms -= shift * per; }
  const g: TrackGrid = { anchors: anchors.map((a) => ({ ms: +a.ms.toFixed(2), beat: a.beat + (anchors.length === 1 ? 0 : 0), bpm: +a.bpm.toFixed(4) })), downbeat: 0, src };
  if (anchors.length === 1 && shift > 0) { /* beat numbering starts at the earliest beat */ }
  // downbeat phase by vote
  if (downbeatsMs.length) {
    const votes = [0, 0, 0, 0];
    for (const d of downbeatsMs) { const bt = Math.round(msToBeat(g, d)); votes[((bt % 4) + 4) % 4]++; }
    g.downbeat = votes.indexOf(Math.max(...votes));
  }
  return g;
}

// ---------------------------------------------------------------------------------------------------- live features
/**
 * The audio matcher's live side: the same 50 Hz band onsets as the fingerprints (frameFeatures: 22 050 Hz, 1024-point
 * frames, hop 441), computed incrementally from any input rate (linear resampling to 22 050 Hz first), scaled 0..255
 * by a slowly decaying running peak. `push` returns the finished frames with the input-time of each frame's start.
 */
export class FluxStream {
  private buf: number[] = [];
  private src = 0;            // input samples consumed (resampler position, in input samples)
  private outN = 0;           // 22 050 Hz samples produced so far
  private frame = 0;          // frames emitted
  private prev = new Float64Array(513);
  private peak = [1e-6, 1e-6, 1e-6, 1e-6];
  private w = hann(1024);
  private re = new Float64Array(1024); private im = new Float64Array(1024);
  private last = 0; private haveLast = false;
  /** The 22 050 Hz samples as they are made (the landmark peaks run on them: shared/landmarks.ts PeakStream). */
  onResampled: ((x: Float32Array) => void) | null = null;
  private get sent() { return this.sentN - (this.outN - this.buf.length); }
  private sentN = 0;
  constructor(readonly inRate: number) {}
  /** Input samples (mono) whose first sample is input sample number `startIndex` → frames [{ i: frame index, t: input
   *  sample index of the frame's start, onset, low, mid, high (0..255) }]. */
  push(x: Float32Array): { t: number; v: [number, number, number, number] }[] {
    const ratio = this.inRate / BT.sr;
    // resample: output sample k sits at input position k · ratio
    for (let k = this.outN; ; k++) {
      const pos = k * ratio - this.src;
      if (pos + 1 >= x.length) break;
      const i = Math.floor(pos), f = pos - i;
      const a = i < 0 ? (this.haveLast ? this.last : 0) : x[i], b = x[i + 1];
      this.buf.push(a * (1 - f) + b * f);
      this.outN = k + 1;
    }
    if (x.length) { this.last = x[x.length - 1]; this.haveLast = true; }
    this.src += x.length;
    if (this.onResampled && this.outN > this.sentN) { const from = Math.max(0, this.sent); this.onResampled(Float32Array.from(this.buf.slice(from))); this.sentN = this.outN; }
    const out: { t: number; v: [number, number, number, number] }[] = [];
    const base = this.outN - this.buf.length;            // output index of buf[0]
    const df = BT.sr / 1024, kKick = Math.max(1, Math.round(120 / df)), kLow = Math.round(250 / df), kMid = Math.round(2000 / df), kHi = Math.round(4000 / df);
    for (;;) {
      const s0 = this.frame * 441 - base;
      if (s0 + 1024 > this.buf.length) break;
      for (let j = 0; j < 1024; j++) { this.re[j] = this.buf[s0 + j] * this.w[j]; this.im[j] = 0; }
      fft(this.re, this.im);
      let fl = 0, lf = 0, mf = 0, hf = 0;
      for (let k = 1; k < 513; k++) {
        const lm = Math.log1p(Math.hypot(this.re[k], this.im[k]) * 10);
        const d = lm - this.prev[k]; this.prev[k] = lm;
        if (d > 0) { fl += d; if (k <= kKick) lf += d; else if (k >= kLow && k < kMid) mf += d; else if (k >= kHi) hf += d; }
      }
      const v = [fl, lf, mf, hf].map((y, b) => { this.peak[b] = Math.max(y, this.peak[b] * 0.9995); return Math.min(255, Math.round(y / this.peak[b] * 255)); }) as [number, number, number, number];
      out.push({ t: (this.frame * 441) * ratio, v });
      this.frame++;
    }
    // drop what no future frame needs
    const keep = this.frame * 441 - base;
    if (keep > 4096) this.buf.splice(0, keep);
    return out;
  }
}
