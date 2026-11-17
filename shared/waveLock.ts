// Finding the place in a KNOWN track from rekordbox's own waveform, for streaming tracks (Beatport, Spotify, …) the
// first time they play: there is no music file to learn from, but rekordbox keeps a 3-band "detail" waveform of every
// analysed track (PWV7, 150 columns a second) next to its grid and phrases. Its band onsets look roughly like the music
// input's band onsets (src/audio/trackFeatures.ts → shared/audioAlign.ts LiveAligner), so a long window of what the
// studio hears can be placed on it.
//
// Only for a track that is ALREADY identified (the DJ picked it in the panel, or a deck / tool named it): the waveform
// is far too coarse to tell tracks apart, and even the place is ambiguous on short windows (measured on real tracks:
// about half the 12–24 s windows land on a wrong, similar-looking bar, with no clear lead). With 45–75 s it is right
// most of the time and the wrong answers have no lead over the second-best place, so a place is used only when
//   · the window is ≥ 45 s and its best place leads the next one (≥ 2 beats away) clearly (`WAVE_ACCEPT`), and
//   · four such checks over ≥ 15 s agree (the place advanced by the elapsed time × the deck's rate, within 50 ms).
// Even then the place is only "placed" (confidence under the show's 0.6: no one-shot fires, nothing is learned): a
// same-track wrong bar (a drop that copies another drop, a loop 2 beats off) can pass those checks. It becomes TRUSTED
// once later windows reaching well across two of the track's phrase changes (rekordbox's phrases; 120 s without them)
// still find it exactly where it should be — the music around a phrase change is what a copy doesn't share; an
// untrusted place that misses once is dropped. Then the show follows it and VTube Pro learns the track's landmarks
// while it plays (server/music/trackSync.ts), so the next time it is found by listening in seconds. The search runs in
// steps (alignOneSteps, 0.5 ms each) on the helper.
// Pure: tools/djtrack_unit.ts (section "stream").
import { alignOneSteps, type LiveEnv, type RefPrint } from './audioAlign.ts';
import { b64ToBytes, bytesToB64, type TrackAnalysis } from './trackAnalysis.ts';

export const WAVE_HZ = 50;
/** rekordbox's detail columns run this much later than our onset frames (measured on real tracks: 13–20 ms). */
export const WAVE_OFFSET_MS = 15;
export const WAVE_ACCEPT = { minWindowS: 45, windowS: 60, minScore: 0.3, minRatio: 1.1, minBeatRatio: 1.08, agree: 4, agreeMs: 50, spanS: 15, everyMs: 5000, lockRangeMs: 1500, lockMinBeatRatio: 1.05 };

/** rekordbox's 3-band detail waveform (150 columns a second, [low, mid, high] heights) → our print: band onsets at 50 Hz
 *  (log-height rises, the strongest of each 20 ms), 0..255 per frame, base64. */
export function wavePrintFromDetail(det: { perSec: number; cols: number; data: Uint8Array }): { hz: number; onset: string; low: string } | null {
  const n = det.cols, k = det.perSec / WAVE_HZ, m = Math.floor(n / k);
  if (!(k >= 1) || m < WAVE_HZ * 30 || det.data.length < n * 3) return null;
  const band = (b: number) => {
    const o = new Float32Array(m);
    let prev = Math.log1p(det.data[b] / 255 * 10);
    for (let i = 1; i < n; i++) {
      const v = Math.log1p(det.data[i * 3 + b] / 255 * 10), d = v - prev; prev = v;
      const j = Math.floor(i / k);
      if (d > 0 && j < m && d > o[j]) o[j] = d;
    }
    return o;
  };
  const lo = band(0), mi = band(1), hi = band(2), on = lo.map((v, i) => v + mi[i] + hi[i]);
  const q = (a: Float32Array) => {
    const s = Float32Array.from(a).sort(), p = s[Math.floor(0.99 * (s.length - 1))] || 1;
    return bytesToB64(Uint8Array.from(a, (v) => Math.round(Math.min(1, v / p) * 255)));
  };
  return { hz: WAVE_HZ, onset: q(on), low: q(lo) };
}
/** The reference the aligner reads (null = no waveform kept for this track). */
export function waveRef(a: TrackAnalysis): RefPrint | null {
  if (!a.wave) return null;
  const f = (s: string) => Float32Array.from(b64ToBytes(s), (v) => v / 255);
  return { id: a.id, hz: a.wave.hz, onset: f(a.wave.onset), low: f(a.wave.low), bpm: a.bpm || a.grid?.anchors[0].bpm || 0 };
}

export interface WavePlace { posMs: number; endAt: number; rate: number; conf: number; trusted: boolean }
/** Confidence of a waveform place: under the show's 0.6 until it is TRUSTED (nothing one-shot fires on it, nothing is
 *  learned from it), then a normal listening confidence. */
export const WAVE_CONF = { placed: 0.55, trusted: 0.7 };
/** Trusted once the lock held through this many phrase changes of the track (rekordbox's phrases) — the music on each
 *  side of a change is what a copied section doesn't share — or, for a track without phrases, this long. */
export const WAVE_TRUST = { boundaries: 2, minS: 30, noPhrasesS: 120 };
/**
 * Places one known track on its waveform, every few seconds (`checkSteps`, sliced). `win(s)` = the music input's last s
 * seconds of onset / low-band frames (LiveAligner.window) and the time of the last frame. `boundariesMs` = the track's
 * phrase starts (ms): a lock becomes trusted only after windows that reach well across two of them kept confirming it
 * at the place it should be (a same-track wrong bar — a copied drop, a loop 2 beats off — fails there and is dropped).
 */
export class WaveLocker {
  private hist: { posMs: number; at: number; rate: number }[] = [];
  private lastAt = -Infinity;
  /** The confirmed place (kept while the following checks find it where it should be). */
  lock: { posMs: number; at: number; rate: number; misses: number; since: number; crossed: Set<number>; trusted: boolean } | null = null;
  constructor(readonly ref: RefPrint, readonly boundariesMs: number[] = []) {}
  get id() { return this.ref.id; }
  check(now: number, win: (s: number) => { live: LiveEnv; endAt: number } | null, rates: number[]): WavePlace | null {
    const g = this.checkSteps(now, win, rates);
    for (;;) { const r = g.next(); if (r.done) return r.value; }
  }
  *checkSteps(now: number, win: (s: number) => { live: LiveEnv; endAt: number } | null, rates: number[]): Generator<void, WavePlace | null, void> {
    const A = WAVE_ACCEPT;
    if (now - this.lastAt < A.everyMs) return null;
    this.lastAt = now;
    const w = win(A.windowS) ?? win(A.minWindowS);
    if (!w) return null;
    const live: LiveEnv = { onset: w.live.onset, ...(w.live.low ? { low: w.live.low } : {}) };
    const winMs = live.onset.length / this.ref.hz * 1000;
    const L = this.lock;
    if (L) {
      const expect = L.posMs + (w.endAt - L.at) * L.rate;
      const h = yield* alignOneSteps(live, this.ref, { rates: [L.rate], hintMs: expect + WAVE_OFFSET_MS, rangeMs: A.lockRangeMs });
      if (h && h.score >= A.minScore && h.beatRatio >= A.lockMinBeatRatio && Math.abs(h.posMs - WAVE_OFFSET_MS - expect) <= A.agreeMs) {
        const pos = h.posMs - WAVE_OFFSET_MS;
        // a phrase change well inside this window (not at its edges) that the place held through
        for (const b of this.boundariesMs) if (b > pos - winMs * 0.8 && b < pos - winMs * 0.2) L.crossed.add(b);
        const heldS = (w.endAt - L.since) / 1000;
        L.trusted = L.trusted || (this.boundariesMs.length ? L.crossed.size >= WAVE_TRUST.boundaries && heldS >= WAVE_TRUST.minS : heldS >= WAVE_TRUST.noPhrasesS);
        Object.assign(L, { posMs: pos, at: w.endAt, rate: h.rate, misses: 0 });
        return { posMs: pos, endAt: w.endAt, rate: h.rate, conf: L.trusted ? WAVE_CONF.trusted : WAVE_CONF.placed, trusted: L.trusted };
      }
      if (++L.misses >= (L.trusted ? 3 : 1)) { this.lock = null; this.hist = []; }   // (an untrusted place that misses once: dropped)
      return null;
    }
    const h = yield* alignOneSteps(live, this.ref, { rates });
    if (!h || h.score < A.minScore || h.ratio < A.minRatio || h.beatRatio < A.minBeatRatio) return null;
    const p = { posMs: h.posMs - WAVE_OFFSET_MS, at: w.endAt, rate: h.rate };
    // earlier checks that agree: the same place, moved on by the elapsed time × rate
    this.hist = this.hist.filter((x) => p.at - x.at <= 60000);
    this.hist.push(p);
    const agree = this.hist.filter((x) => Math.abs(x.posMs + (p.at - x.at) * p.rate - p.posMs) <= A.agreeMs);
    if (agree.length < A.agree || p.at - agree[0].at < A.spanS * 1000) return null;
    this.lock = { ...p, misses: 0, since: p.at, crossed: new Set(), trusted: false };
    return { posMs: p.posMs, endAt: p.at, rate: p.rate, conf: WAVE_CONF.placed, trusted: false };
  }
}
