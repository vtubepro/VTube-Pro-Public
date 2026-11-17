// Learning a track WHILE it plays (streaming tracks: Beatport, Spotify, … through rekordbox have no music file, so they
// can't be learned in the background like a file). Once VTube Pro knows which track plays AND where (a deck / tool
// reports it, the DJ picked it and its place was found on rekordbox's waveform, …), the music input's landmark peaks —
// the same numbers the listening matcher uses, never audio — are moved onto the track's own timeline and kept. When
// enough of the track was heard they become the track's landmarks, so the next time it is found by listening within
// seconds, like a file VTube Pro learned.
//
// Only clean stretches are kept: the deck at (about) normal speed, one deck audible, away from the intro and outro
// (where DJs mix), the position trusted (settled). A session is stored once it covers MIN_S seconds of the track.
// Pure: tools/djtrack_unit.ts (section "stream").
import { LM_HOP_MS, LM_TRACK_MAX, encodeLandmarks, landmarksFromPeaksSteps, type Peak } from './landmarks.ts';
import { bytesToB64 } from './trackAnalysis.ts';

export const LEARN = {
  /** Seconds of a track that must be heard cleanly before its landmarks are stored. */
  minS: 60,
  /** Stored early when this share of the learnable part was heard. */
  enoughShare: 0.8,
  /** The deck's speed must be within this of normal (key lock unknown: a pitched deck would shift the landmarks). */
  maxRateDev: 0.02,
  /** Left out at the start / end (mixing zones): at least these seconds, or these shares of the track. */
  introS: 15, introShare: 0.08, outroS: 30, outroShare: 0.12,
  /** At most this many peaks are held (≈ 25 minutes of music): memory stays small. */
  maxPeaks: 120_000,
};
/** The part of a track that may be learned (ms). */
export function learnZone(durMs: number): { from: number; to: number } {
  const from = Math.max(LEARN.introS * 1000, durMs * LEARN.introShare), to = durMs - Math.max(LEARN.outroS * 1000, durMs * LEARN.outroShare);
  return { from, to: Math.max(from, to) };
}

export class PlayLearner {
  id: string | null = null;
  private peaks: Peak[] = [];
  private secs = new Set<number>();
  private zone = { from: 0, to: 0 };
  /** Helper time of the last peak taken. */
  lastAt = 0;
  start(id: string, durMs: number, now: number) { this.id = id; this.peaks = []; this.secs.clear(); this.zone = learnZone(durMs); this.lastAt = now; }
  stop() { this.id = null; this.peaks = []; this.secs.clear(); }
  /** Seconds of the track heard (cleanly). */
  get seconds() { return this.secs.size; }
  /** The learnable part's length (s). */
  get span() { return Math.max(1, (this.zone.to - this.zone.from) / 1000); }
  get enough() { return this.secs.size >= Math.min(LEARN.minS, this.span * 0.9) && this.secs.size >= 20; }
  get done() { return this.enough && this.secs.size >= this.span * LEARN.enoughShare; }
  /**
   * Peaks of the music input (stream frame numbers) with the track position of stream frame `f0` (ms) and the deck's
   * rate: they go onto the track's timeline (track frame = (pos(f0) + (f − f0) · hop · rate) / hop). Peaks outside the
   * learnable part are left out.
   */
  add(peaks: Peak[], f0: number, posMsAtF0: number, rate: number, now: number) {
    if (!this.id || !peaks.length || this.peaks.length >= LEARN.maxPeaks) return;
    for (const p of peaks) {
      const ms = posMsAtF0 + (p.f - f0) * LM_HOP_MS * rate;
      if (ms < this.zone.from || ms > this.zone.to) continue;
      this.peaks.push({ f: Math.round(ms / LM_HOP_MS), m: p.m, v: p.v });
      this.secs.add(Math.floor(ms / 1000));
    }
    this.lastAt = now;
  }
  /** The landmarks of what was heard ({v, n, b64} as stored in a TrackAnalysis), built in steps. */
  *buildSteps(): Generator<void, { v: 1; n: number; b64: string } | null, void> {
    if (!this.enough) return null;
    // the same peak may arrive twice (a re-sent batch): one of each, in (frame, pitch) order
    const ps = [...this.peaks].sort((a, b) => a.f - b.f || a.m - b.m).filter((p, i, a) => i === 0 || p.f !== a[i - 1].f || Math.abs(p.m - a[i - 1].m) > 0.005);
    yield;
    const lm = yield* landmarksFromPeaksSteps(ps);
    if (!lm.h.length) return null;
    const n = Math.min(lm.h.length, LM_TRACK_MAX);
    const bytes = encodeLandmarks({ h: lm.h.subarray(0, n), t: lm.t.subarray(0, n) });
    return { v: 1, n, b64: bytesToB64(bytes) };
  }
}
