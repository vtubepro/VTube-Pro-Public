// Audio matching: which analysed track is playing and where, from the sound the studio hears — for setups that report
// no playhead (rekordbox performance mode + a DDJ controller, Traktor / Serato / Mixxx / djay without a mod).
// The live onset envelopes (broadband spectral flux + the kick band's flux, 50 Hz, computed exactly like the tracks'
// fingerprints in shared/trackDsp.ts) are cross-correlated against each candidate track's stored envelopes, the track
// time-scaled by the deck's playback rate r (the clock's tempo ÷ the track's BPM when known, else searched over ±8 %).
// Coarse at 12.5 Hz over the whole track, then refined at 50 Hz to a fraction of a frame (parabolic peak).
// Music repeats (bars, copied drops): a position is accepted only when its peak clearly beats every other lag ≥ 100 ms
// away — else we say "not sure" and the show keeps running on the realtime analysis — and only when two checks in a row
// agree; once locked, later checks look only near where the track should be by now. (The idea follows LightD31's
// artnet-lightshow auto-sync, MIT; written from scratch here.) Plain signal processing, no fingerprint library.
// Pure: tools/djtrack_align.ts measures it on synthetic DJ mixes (two tracks, crossfades, tempo changes, noise).
import { b64ToBytes, type TrackAnalysis } from './trackAnalysis.ts';

export const BANDS = ['onset', 'low', 'mid', 'high'] as const;
export type Band = (typeof BANDS)[number];
export interface RefPrint { id: string; hz: number; onset: Float32Array; low?: Float32Array; mid?: Float32Array; high?: Float32Array; bpm: number }
export function refFromAnalysis(a: TrackAnalysis): RefPrint | null {
  if (!a.fp) return null;
  const f = (s: string) => Float32Array.from(b64ToBytes(s), (v) => v / 255);
  return { id: a.id, hz: a.fp.hz, onset: f(a.fp.onset), ...(a.fp.low ? { low: f(a.fp.low) } : {}), ...(a.fp.mid ? { mid: f(a.fp.mid) } : {}), ...(a.fp.high ? { high: f(a.fp.high) } : {}), bpm: a.bpm || a.grid?.anchors[0].bpm || 0 };
}
/** The live side's envelopes (oldest first). */
export interface LiveEnv { onset: Float32Array; low?: Float32Array; mid?: Float32Array; high?: Float32Array }
export interface AlignHit {
  id: string;
  /** Track position (ms, track time) of the live window's LAST frame (frames are stamped with their start time, the
   *  same convention as the fingerprints), and the playback rate. */
  posMs: number; rate: number;
  /** Correlation at the peak (mean Pearson of the envelopes, −1..1) and how far it stands above the best other place
   *  ≥ 2 beats away, as a dissimilarity ratio (1 − its score) / (1 − ours): near 1 = ambiguous. */
  score: number; ratio: number;
}

function decimate(a: Float32Array, k: number): Float32Array {
  const n = Math.floor(a.length / k), out = new Float32Array(n);
  for (let i = 0; i < n; i++) { let m = 0; for (let j = 0; j < k; j++) m = Math.max(m, a[i * k + j]); out[i] = m; }
  return out;
}
const lerp = (a: Float32Array, x: number) => { const i = Math.floor(x); if (i < 0 || i + 1 >= a.length) return i >= 0 && i < a.length ? a[i] : NaN; const f = x - i; return a[i] * (1 - f) + a[i + 1] * f; };
const stats = (a: Float32Array) => { let s = 0, ss = 0; for (const v of a) { s += v; ss += v * v; } const m = s / a.length; return { m, sd: Math.sqrt(Math.max(1e-12, ss / a.length - m * m)) }; };
/** Pearson correlation of live[i] against ref[p0 + r·i] (−1 when the window runs off the track). */
function corr(live: Float32Array, lm: number, lsd: number, ref: Float32Array, p0: number, r: number): number {
  const n = live.length;
  let sr = 0, srr = 0, slr = 0, m = 0;
  for (let i = 0; i < n; i++) {
    const v = lerp(ref, p0 + r * i);
    if (!Number.isFinite(v)) continue;
    sr += v; srr += v * v; slr += (live[i] - lm) * v; m++;
  }
  if (m < n * 0.9) return -1;
  const vm = sr / m, vsd = Math.sqrt(Math.max(1e-12, srr / m - vm * vm));
  return slr / m / (lsd * vsd);
}
interface Chan { live: Float32Array; ref: Float32Array; m: number; sd: number }

export interface AlignOptions {
  /** Rates to try (deck playback rates); default ±8 % in 1 % steps. One rate = the tempo is known exactly. */
  rates?: number[];
  /** Only look near this track position (ms at the window's last frame) ± rangeMs. */
  hintMs?: number; rangeMs?: number;
  /** How many distinct section-shape candidates get the beat-detail pass (default 12). */
  topK?: number;
  /** Only the section-shape pass (identify's quick pre-selection): score = its best correlation. */
  contourOnly?: boolean;
}
const DEFAULT_RATES = Array.from({ length: 17 }, (_, i) => +(0.92 + i * 0.01).toFixed(2));

/** Moving average over `w` frames, then every `d`-th frame: the section-level shape (beats smoothed away). */
function contour(chs: Float32Array[], w: number, d: number): Float32Array {
  const n = chs[0].length, out = new Float32Array(Math.floor(n / d));
  let acc = 0; const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { for (const c of chs) acc += c[i]; pre[i + 1] = acc; }
  for (let k = 0; k < out.length; k++) { const c = k * d + d / 2, lo = Math.max(0, Math.round(c - w / 2)), hi = Math.min(n, Math.round(c + w / 2)); out[k] = (pre[hi] - pre[lo]) / Math.max(1, hi - lo); }
  return out;
}
/**
 * Where in ONE track does the live window fit best? Two stages: (1) the SECTION shape (the envelopes smoothed over half
 * a second, 10 Hz) over the whole track — this is what tells bar 9 of a drop from bar 1 of it, and is unique once the
 * window reaches across a section change; (2) the BEAT detail (the raw envelopes, 50 Hz, ±¾ beat around stage 1),
 * refined to a fraction of a frame. `ratio` = how far stage 1's best stands above any place ≥ 2 beats away;
 * `beatRatio` = how far stage 2's best stands above any place ≥ 100 ms away.
 */
export function alignOne(liveIn: Float32Array | LiveEnv, ref: RefPrint, o: AlignOptions = {}): (AlignHit & { beatRatio: number }) | null {
  const g = alignOneSteps(liveIn, ref, o);
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}
/** alignOne in steps: it yields whenever 0.5 ms passed (the helper runs it sliced: shared/landmarks.ts runSliced). */
export function* alignOneSteps(liveIn: Float32Array | LiveEnv, ref: RefPrint, o: AlignOptions = {}): Generator<void, (AlignHit & { beatRatio: number }) | null, void> {
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let tY = now();
  const live: LiveEnv = liveIn instanceof Float32Array ? { onset: liveIn } : liveIn;
  const hz = ref.hz, n = live.onset.length;
  if (n < hz * 4 || ref.onset.length < n) return null;
  const rates = o.rates?.length ? o.rates : DEFAULT_RATES;
  const bands = BANDS.filter((b) => live[b]?.length === n && ref[b]);
  const D = Math.max(1, Math.round(hz / 10)), W = Math.round(hz / 2);
  const lc = contour(bands.map((b) => live[b]!), W, D), rc = contour(bands.map((b) => ref[b]!), W, D);
  const ls = stats(lc), l0 = lc.map((v) => v - ls.m), L = lc.length;
  type C = { p0: number; r: number; s: number };
  const coarse: C[] = [];
  const endLo = o.hintMs !== undefined ? (o.hintMs - (o.rangeMs ?? 4000)) / 1000 * hz / D : -Infinity;
  const endHi = o.hintMs !== undefined ? (o.hintMs + (o.rangeMs ?? 4000)) / 1000 * hz / D : Infinity;
  for (const r of rates) {
    const span = r * (L - 1);
    for (let p0 = 0; p0 + span < rc.length - 1; p0 += 0.5) {
      const end = p0 + span;
      if (end < endLo || end > endHi) continue;
      let s = 0, sr = 0, srr = 0;
      for (let i = 0; i < L; i++) { const v = lerp(rc, p0 + r * i); s += l0[i] * v; sr += v; srr += v * v; }
      const vm = sr / L, vsd = Math.sqrt(Math.max(1e-12, srr / L - vm * vm));
      coarse.push({ p0, r, s: s / L / (ls.sd * vsd) });
      if (now() - tY > 0.5) { yield; tY = now(); }
    }
  }
  if (!coarse.length) return null;
  coarse.sort((a, b) => b.s - a.s);
  if (o.contourOnly) return { id: ref.id, posMs: NaN, rate: coarse[0].r, score: +coarse[0].s.toFixed(4), ratio: 1, beatRatio: 1 };
  // the best few DISTINCT places (≥ 2 beats apart): the section shape can't tell a copied drop from its original —
  // the beat detail can
  const beatF = (ref.bpm > 0 ? 60 / ref.bpm : 0.5) * hz;                  // one beat, in reference frames
  const cands: C[] = [];
  for (const c of coarse) { if (cands.length >= (o.topK ?? 12)) break; if (!cands.some((x) => Math.abs(x.p0 - c.p0) * D < 2 * beatF)) cands.push(c); }
  // stage 2: the beat detail around each
  const chans: Chan[] = bands.map((b) => { const st = stats(live[b]!); return { live: live[b]!, ref: ref[b]!, m: st.m, sd: st.sd }; });
  const score = (p0: number, r: number) => chans.reduce((s, c) => s + corr(c.live, c.m, c.sd, c.ref, p0, r), 0) / chans.length;
  const rStep = rates.length > 1 ? 0.0015 : 0;
  const half = Math.max(D, 0.75 * beatF);
  const refinedAll: (C & { second: number })[] = [];
  for (const c of cands) {
    const fine: C[] = [];
    const centre = c.p0 * D;
    for (const r of rStep ? [c.r - rStep, c.r, c.r + rStep] : [c.r]) for (let p0 = Math.max(0, centre - half); p0 <= centre + half; p0 += 0.5) {
      fine.push({ p0, r, s: score(p0, r) });
      if (now() - tY > 0.5) { yield; tY = now(); }
    }
    fine.sort((a, b) => b.s - a.s);
    const b = fine[0];
    const second = b ? fine.find((x) => Math.abs(x.p0 - b.p0) >= 0.1 * hz)?.s ?? -1 : -1;
    if (b) refinedAll.push({ ...b, second });
  }
  const refined = refinedAll.sort((a, b) => b.s - a.s);
  const best = refined[0];
  if (!best) return null;
  const s0 = score(best.p0 - 0.5, best.r), s2 = score(best.p0 + 0.5, best.r);
  const den = s0 - 2 * best.s + s2;
  const dp = den < 0 ? Math.max(-0.5, Math.min(0.5, 0.25 * (s0 - s2) / den)) : 0;
  const p0 = best.p0 + dp;
  // uniqueness as DISSIMILARITY ratios (correlations bunch up near 1): how much worse the next-best place fits
  const other = refined.find((x) => Math.abs(x.p0 - best.p0) >= 2 * beatF)?.s ?? -1;
  const dis = (a: number, b: number) => (1 - b) / Math.max(1e-3, 1 - a);
  const ratio = other > -1 ? dis(best.s, other) : 9;
  const beatRatio = best.second > -1 ? dis(best.s, best.second) : 9;
  return { id: ref.id, posMs: (p0 + best.r * (n - 1)) / hz * 1000, rate: best.r, score: +best.s.toFixed(4), ratio: +Math.min(99, ratio).toFixed(3), beatRatio: +Math.min(99, beatRatio).toFixed(3) };
}

/** Which of several tracks is playing (and where)? The best hit + its margin over the best other track ((1 − its
 *  score) / (1 − ours)). */
export function identify(live: Float32Array | LiveEnv, refs: RefPrint[], o: AlignOptions & { rateFor?: (r: RefPrint) => number[] | undefined } = {}): (AlignHit & { margin: number; beatRatio: number }) | null {
  const hits: (AlignHit & { beatRatio: number })[] = [];
  // quick pre-selection by section shape, then the full match for the best few tracks only
  const SL = 8;
  const shortlist = refs.length > SL ? refs.map((ref) => ({ ref, s: alignOne(live, ref, { ...o, rates: o.rateFor?.(ref) ?? o.rates, contourOnly: true })?.score ?? -1 })).sort((a, b) => b.s - a.s).slice(0, SL).map((x) => x.ref) : refs;
  for (const ref of shortlist) { const h = alignOne(live, ref, { ...o, rates: o.rateFor?.(ref) ?? o.rates }); if (h) hits.push(h); }
  if (!hits.length) return null;
  hits.sort((a, b) => b.score - a.score);
  // (dissimilarity, like the ratios: how much worse the best OTHER track fits)
  const margin = hits.length > 1 ? Math.min(99, (1 - hits[1].score) / Math.max(1e-3, 1 - hits[0].score)) : 9;
  return { ...hits[0], margin: +margin.toFixed(3) };
}

/** Acceptance thresholds (tools/djtrack_align.ts measures what they cost). */
export const ALIGN_ACCEPT = { minScore: 0.45, minRatio: 1.5, minBeatRatio: 1.3, minMargin: 1.5, agreeMs: 40, lockRangeMs: 1500, lockMinRatio: 1.15, lockKeep: 0.8 };
/** Window lengths tried in turn for a first answer: inside one section the music repeats bar after bar (ambiguous);
 *  a longer window reaches across a section change and becomes unique. */
export const ALIGN_WINDOWS = [12, 24, 40];
export const accepted = (h: (AlignHit & { margin?: number; beatRatio?: number }) | null, many: boolean) => !!h && h.score >= ALIGN_ACCEPT.minScore && h.ratio >= ALIGN_ACCEPT.minRatio && (h.beatRatio ?? 9) >= ALIGN_ACCEPT.minBeatRatio && (!many || (h.margin ?? 9) >= ALIGN_ACCEPT.minMargin);
/** A first answer must also hold on a longer window (more of the track's structure: repetition fools a short window
 *  far more often than a long one): the same place (± agreeMs) and unambiguous there too. A 40 s answer stands. */
export function confirmLonger(win: (seconds: number) => LiveEnv | null, ref: RefPrint, hit: AlignHit & { seconds: number }, rates?: number[]): boolean {
  const L = ALIGN_WINDOWS.find((w) => w >= hit.seconds * 2) ?? (hit.seconds >= ALIGN_WINDOWS[ALIGN_WINDOWS.length - 1] ? 0 : ALIGN_WINDOWS[ALIGN_WINDOWS.length - 1]);
  if (!L) return true;
  const live = win(L);
  if (!live) return false;
  const h = alignOne(live, ref, { rates: rates ?? [hit.rate] });
  return accepted(h, false) && Math.abs(h!.posMs - hit.posMs) <= ALIGN_ACCEPT.agreeMs;
}
/** Identify with growing windows (12 → 24 → 40 s) until one answer is unambiguous. */
export function identifyProgressive(win: (seconds: number) => LiveEnv | null, refs: RefPrint[], o: AlignOptions & { rateFor?: (r: RefPrint) => number[] | undefined } = {}, lengths = ALIGN_WINDOWS): (AlignHit & { margin: number; beatRatio: number; seconds: number }) | null {
  for (const L of lengths) {
    const live = win(L);
    if (!live) break;
    const h = identify(live, refs, o);
    if (accepted(h, refs.length > 1)) return { ...h!, seconds: L };
  }
  return null;
}

/**
 * The live side: rings of 50 Hz onset frames (with their local times) from the studio's music input, checked every
 * ~1 s against the candidates. A first answer counts only when two checks in a row agree (same track, the position
 * advanced by elapsed × rate within 40 ms) and the peak is unambiguous; then it is LOCKED and followed nearby.
 */
export class LiveAligner {
  private ring: Record<Band, Float32Array>;
  private has = new Set<Band>(['onset']);
  private times: Float64Array;
  private n = 0; private w = 0;
  private prev: { hit: AlignHit; at: number } | null = null;
  /** Locked on: the next checks only look near where the track should be by now. */
  lock: { id: string; posMs: number; at: number; rate: number; misses: number; score: number } | null = null;
  constructor(readonly hz = 50, readonly windowS = 12) {
    const L = Math.round(hz * Math.max(windowS, ...ALIGN_WINDOWS) * 1.2);
    this.ring = { onset: new Float32Array(L), low: new Float32Array(L), mid: new Float32Array(L), high: new Float32Array(L) };
    this.times = new Float64Array(L);
  }
  /** Frames from the page (oldest first; onset + the optional band envelopes), the local time of the LAST one's start. */
  push(onset: ArrayLike<number>, lastAt: number, more: Partial<Record<Exclude<Band, 'onset'>, ArrayLike<number>>> = {}) {
    const L = this.times.length;
    for (const b of ['low', 'mid', 'high'] as const) if (more[b]?.length === onset.length) this.has.add(b);
    for (let i = 0; i < onset.length; i++) {
      this.ring.onset[this.w] = onset[i];
      for (const b of ['low', 'mid', 'high'] as const) this.ring[b][this.w] = more[b]?.[i] ?? 0;
      this.times[this.w] = lastAt - (onset.length - 1 - i) * 1000 / this.hz; this.w = (this.w + 1) % L; this.n = Math.min(L, this.n + 1);
    }
  }
  reset() { this.n = 0; this.prev = null; this.lock = null; }
  get filled() { return this.n / this.hz; }
  /** The last `seconds` (default windowS; oldest first) and the time of its last frame. */
  window(seconds = this.windowS): { live: LiveEnv; endAt: number } | null {
    const m = Math.round(this.hz * seconds);
    if (this.n < m) return null;
    const L = this.times.length, live: LiveEnv = { onset: new Float32Array(m) };
    for (const b of this.has) { const a = new Float32Array(m), r = this.ring[b]; for (let i = 0; i < m; i++) a[i] = r[(this.w - m + i + L) % L]; live[b] = a; }
    return { live, endAt: this.times[(this.w - 1 + L) % L] };
  }
  /** One check. Returns a confirmed position: `endAt` = the local time of the window's last frame, `hit.posMs` = the
   *  track position there. */
  check(refs: RefPrint[], o: AlignOptions & { rateFor?: (r: RefPrint) => number[] | undefined } = {}): { hit: AlignHit; endAt: number; conf: number } | null {
    const w = this.window();
    if (!w) return null;
    const A = ALIGN_ACCEPT, L = this.lock;
    if (L) {
      const ref = refs.find((r) => r.id === L.id);
      if (ref) {
        const expect = L.posMs + (w.endAt - L.at) * L.rate;
        const rates = o.rateFor?.(ref) ?? [L.rate];
        const hit = alignOne(w.live, ref, { rates, hintMs: expect, rangeMs: A.lockRangeMs });
        // still the same place (a jump = a loop / hot cue: confirmed by a fresh identification, not followed blindly)
        // and still fitting about as well as when we locked (the track faded out / another one took over → let go)
        if (hit && hit.score >= A.minScore && hit.score >= L.score * A.lockKeep && hit.beatRatio >= A.lockMinRatio && Math.abs(hit.posMs - expect) <= A.agreeMs * 1.5) {
          this.lock = { id: hit.id, posMs: hit.posMs, at: w.endAt, rate: hit.rate, misses: 0, score: Math.max(L.score * 0.98, hit.score) };
          return { hit, endAt: w.endAt, conf: +Math.max(0, Math.min(1, (hit.score - 0.3) * 1.8)).toFixed(3) };
        }
      }
      if (++L.misses >= 2) this.lock = null;
      return null;
    }
    const hit = identifyProgressive((s) => this.window(s)?.live ?? null, refs, o);
    if (!hit) { this.prev = null; return null; }
    const p = this.prev;
    this.prev = { hit, at: w.endAt };
    if (!p || p.hit.id !== hit.id) return null;
    if (Math.abs(p.hit.posMs + (w.endAt - p.at) * hit.rate - hit.posMs) > A.agreeMs) return null;
    const ref = refs.find((r) => r.id === hit.id)!;
    if (!confirmLonger((s) => this.window(s)?.live ?? null, ref, hit, o.rateFor?.(ref))) return null;   // (not yet: keep listening)
    this.lock = { id: hit.id, posMs: hit.posMs, at: w.endAt, rate: hit.rate, misses: 0, score: hit.score };
    return { hit, endAt: w.endAt, conf: +Math.max(0, Math.min(1, (hit.score - 0.3) * 1.6 + (hit.ratio - 1) * 0.2)).toFixed(3) };
  }
}
