// The stable-prefix ("local agreement") policy for streaming captions.
//
// A Whisper-style recogniser can't stream: you re-run it on a growing window of audio and every run may word the same
// stretch differently. Showing each run's text flickers. The fix is the LocalAgreement policy (Macháček, Dabre, Bojar:
// "Turning Whisper into Real-Time Transcription System", 2023). The SimulStreaming project (ufal, MIT licence) builds
// on it with an attention-based policy (AlignAtt) that needs Whisper's cross-attention, which faster-whisper /
// CTranslate2 does not expose; VTube Pro implements the LocalAgreement idea itself, from the paper, and copies no code:
//
//   • keep the words of the previous run that are not committed yet (the "tail");
//   • when a new run arrives, COMMIT the longest common prefix of the tail and the new run (two runs in a row agree);
//   • committed words are final: never changed, removed or re-timed. The rest of the newest run is only "tentative";
//   • bounded lag: a tentative word older than `maxHoldSec` is committed anyway (as the newest run worded it), so one
//     word the model keeps flip-flopping on can't hold the whole caption back. Still never a rewrite.
//
// Words are compared by their text only (case and edge punctuation ignored); the committed copy is the newer run's.
// Times are on the session's audio clock (seconds).
import { wordKey, type CapWord } from '../../shared/captions.ts';

/** Slow-machine rule: commit a word after ONE run when the recogniser is sure of it (`minP`) and has heard `settleSec` of
 *  audio after it, instead of waiting for a second agreeing run (which costs a whole extra run time of lag). */
export interface EarlyCommit { minP: number; settleSec: number; coveredEnd: number }

/** Right after an unconfirmed word a run's window starts behind it. The SAME word starting within 0.05 s of the window start,
 *  or a word that reads like it starting within 0.12 s, is that word heard again (s). */
export const UNCONFIRMED_EDGE = 0.05;
export const UNCONFIRMED_EDGE_LIKE = 0.12;

/** "their" / "there", "next" / "nextx": both 4+ letters and at most 40 % of the longer one apart (edit distance). */
export function alike(a: string, b: string): boolean {
  const x = wordKey(a), y = wordKey(b);
  if (x.length < 4 || y.length < 4 || x === y) return false;
  const d: number[] = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= y.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (x[i - 1] === y[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[y.length] <= Math.ceil(0.4 * Math.max(x.length, y.length));
}

export interface InsertOpts {
  early?: EarlyCommit;
  /** Audio-clock start of the window this run heard. A word that begins within 0.15 s of it and overlaps the last committed
   *  word is that word cut by the window's edge (a fragment, or the model's other guess of it): dropped, never committed twice. */
  windowStart?: number;
}

export interface AgreeResult {
  /** Words committed by this run (append to the caption). */
  committed: CapWord[];
  /** The uncommitted tail of this run (may change next run). */
  tentative: CapWord[];
  /** Some word committed by this run was final without a second run agreeing (confidence / lag bound). */
  unconfirmed: boolean;
}

export class LocalAgreement {
  /** Everything committed so far, in order. Append-only. */
  readonly words: CapWord[] = [];
  private tail: CapWord[] = [];       // the previous run's uncommitted words
  private lastEnd = 0;                // end time of the last committed word
  /** The last committed word was final after ONE run (confidence) or by the lag bound: no second run confirmed it, so a later
   *  different word at the same place is the model re-hearing it, not a new word. */
  private lastUnconfirmed = false;

  constructor(public maxHoldSec = 1.6) {}

  get lastCommittedEnd() { return this.lastEnd; }
  get pending(): readonly CapWord[] { return this.tail; }

  /** Drop what this run repeats of the committed text. The window can start before the last committed word's end, and
   *  the recogniser re-words that overlap with its times shifted by a few tens of ms. The tests:
   *   - a word whose MIDDLE lies at or before the committed end is part of the committed stretch (the middle survives
   *     jitter on both ends; a real repeat such as "very very" has its middle after the end, so it is kept);
   *   - the one committed word at the seam can come back with its times shifted past that line: the SAME text that
   *     overlaps it in time (by 40 % of the shorter one) is that word again, and so is ANY text that overlaps it by half
   *     (a window cut through a word returns a fragment or a different guess of it). Same text next to it, not
   *     overlapping, is a genuine repeat;
   *   - an UNCONFIRMED last word (final after ONE run at p 0.9: "their"; or by the lag bound) is followed by a run whose
   *     window starts right behind it (the session cuts there, 0.1 s before its end). A word that begins at that window
   *     start, overlaps it in time AND reads like it ("there" for "their": both 4+ letters, a few letters apart) is that word
   *     heard again, not a new one. Position alone cannot tell them apart (word times are good to ~50 ms, about the same margin), so the
   *     text has to agree too; a different word right after it ("their houses") is kept. */
  private fresh(hyp: readonly CapWord[], windowStart?: number): CapWord[] {
    const h = hyp.filter((x) => (x.t0 + x.t1) / 2 > this.lastEnd && wordKey(x.w) !== '');
    const last = this.words[this.words.length - 1];
    if (last && h.length) {
      const same = wordKey(h[0].w) === wordKey(last.w);
      const ov = Math.min(last.t1, h[0].t1) - Math.max(last.t0, h[0].t0);
      const shorter = Math.min(last.t1 - last.t0, h[0].t1 - h[0].t0);
      const atEdge = this.lastUnconfirmed && windowStart !== undefined && ov > 0.02 && (same ? h[0].t0 < windowStart + UNCONFIRMED_EDGE : h[0].t0 < windowStart + UNCONFIRMED_EDGE_LIKE && alike(h[0].w, last.w));
      const lowConfEdge = windowStart !== undefined && h[0].t0 < windowStart + 0.15 && ov > 0.02 && (h[0].p ?? 1) < 0.6;
      if (same ? ov >= 0.4 * shorter || atEdge : ov >= 0.5 * shorter || atEdge || lowConfEdge) h.shift();
    }
    return h;
  }

  /** One recogniser run. `now` = the audio clock when it covered up to (for the lag bound). */
  insert(hyp: readonly CapWord[], now: number, o: InsertOpts = {}): AgreeResult {
    const early = o.early;
    const h = this.fresh(hyp, o.windowStart);
    const out: CapWord[] = [];
    let i = 0;
    while (i < h.length && i < this.tail.length && wordKey(h[i].w) === wordKey(this.tail[i].w)) { out.push(this.commit(h[i])); i++; }
    this.tail = h.slice(i);
    // slow machine: a confident word that has had time to settle is final now (still strictly in order, still never rewritten)
    if (early) while (this.tail.length && (this.tail[0].p ?? 0) >= early.minP && this.tail[0].t1 <= early.coveredEnd - early.settleSec) out.push(this.commit(this.tail.shift()!, true));
    // bounded lag: one unstable word must not hold everything behind it
    while (this.tail.length && now - this.tail[0].t1 > this.maxHoldSec) out.push(this.commit(this.tail.shift()!, true));
    return { committed: out, tentative: this.tail.slice(), unconfirmed: this.lastUnconfirmed && out.length > 0 };
  }

  /** The speaker stopped: nothing more will agree with the tail, so the newest run's tail is final. */
  finish(): CapWord[] {
    const out = this.tail.map((x) => this.commit(x));
    this.tail = [];
    return out;
  }

  /** The audio window moved on (trimmed): the next run starts fresh. Committed words stay. */
  dropPending() { this.tail = []; }

  private commit(x: CapWord, unconfirmed = false): CapWord {
    this.lastUnconfirmed = unconfirmed;
    const prev = this.words[this.words.length - 1];
    const t0 = Math.max(x.t0, prev ? prev.t0 : 0);       // a committed word never starts before the one ahead of it
    const w: CapWord = { w: x.w.trim(), t0, t1: Math.max(x.t1, t0) };
    this.words.push(w);
    this.lastEnd = Math.max(this.lastEnd, w.t1);
    return w;
  }
}
