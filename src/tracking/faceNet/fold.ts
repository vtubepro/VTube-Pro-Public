// "My face model" stage 2, using it: the net's channels are folded into MediaPipe's 52 blendshape scores BEFORE the solvers, the
// way gpuVision folds in Maxine (docs/GPU_TRACKING.md): each net value is first mapped into MediaPipe's own range per channel
// (gpuVision's RangeMap: running 10th / 95th percentiles of both on the same frames, identity on a channel neither moves on),
// then mixed in by `share`. Until ~5 s of paired frames exist only 30 % of the share is used. Only the channels the judge
// adopted (FaceNet.mask) are touched; the rest keep MediaPipe's score. share 0 returns before touching anything: the scores
// stay bit-identical.
import { ARKIT } from '../../core/arkit.ts';
import { RangeMap } from '../gpuVision.ts';

export interface Cat { categoryName: string; score: number }
const IX = new Map<string, number>(ARKIT.map((n, i) => [n, i]));
/** Seconds a full-scale weight change takes (adopt / revert / share / range map ready / the gate pausing): no pop on a live face. */
export const FOLD_FADE_S = 0.75;
export interface FoldOpts {
  /** the clock (ms) of this call: with it the effective weight slews toward its target at 1 / FOLD_FADE_S per second; without it the weight is instant */
  nowMs?: number;
  /** 1 = fold in (default), 0 = fade out (the net is not running: paused gate, reverted, switched off) */
  gain?: number;
  /** false = do not feed the range map from this call (the values are stale or a gate probe) */
  feed?: boolean;
}

export class FaceNetFold {
  private range = new RangeMap();
  /** channels folded on the last call, and the weight used (diagnostics / the panel) */
  used = 0; weight = 0;
  /** the smoothed weight actually used (0..1 of the share), and the clock of the last call */
  private cur = 0; private curT = -1;
  /** is there still a folded-in contribution that must fade out? */
  get fading() { return this.cur > 0; }
  get rangeSamples() { return this.range.samples; }
  get rangeReady() { return this.range.ready; }
  reset() { this.range = new RangeMap(); this.used = 0; this.weight = 0; this.cur = 0; this.curT = -1; }
  /** A different model is in use: relearn the range map but keep the smoothed weight, so the change fades instead of popping. */
  resetRange() { this.range = new RangeMap(); }
  /**
   * cats: MediaPipe's blendshape categories for this frame (changed in place; may already hold Maxine's mix: the face model wins
   * its channels). vals: the net's 52 raw outputs (ARKIT order). mask: 52 entries, 1 = adopted. mp: MediaPipe's own scores for
   * this frame (52, ARKIT order, taken before Maxine's mix) for the range pairing; absent = the cats' current scores.
   * Call once per new net result (each pair feeds the percentiles once).
   */
  apply(cats: Cat[], vals: ArrayLike<number>, mask: ArrayLike<number>, share: number, mp?: ArrayLike<number>, o: FoldOpts = {}): boolean {
    this.used = 0; this.weight = 0;
    if (!(share > 0) || !cats.length || vals.length < ARKIT.length) return false;
    const gain = o.gain ?? 1;
    if (!(gain > 0) && this.cur <= 0) return false;
    const idx: number[] = [], a: number[] = [], b: number[] = [];
    for (let i = 0; i < cats.length; i++) {
      const k = IX.get(cats[i].categoryName);
      if (k === undefined || !mask[k] || !Number.isFinite(vals[k])) continue;
      idx.push(i); a.push(vals[k]); b.push(mp ? mp[k] : cats[i].score);
    }
    if (!idx.length) return false;
    if (o.feed !== false) this.range.push(a, b);
    const target = Math.min(1, share) * (this.range.ready ? 1 : 0.3) * gain;
    let m = target;
    if (o.nowMs !== undefined) {
      const dt = this.curT < 0 ? 0 : Math.min(0.1, Math.max(0, (o.nowMs - this.curT) / 1000)), step = dt / FOLD_FADE_S;
      m = this.cur + Math.max(-step, Math.min(step, target - this.cur));
      this.curT = o.nowMs;
    }
    if (m < 0.001 && target === 0) { m = 0; this.curT = -1; } // (at rest: the next fade-in starts from a fresh clock, not a stale gap)
    this.cur = m;
    if (m <= 0) return false;
    for (let j = 0; j < idx.length; j++) { const c = cats[idx[j]]; c.score = c.score * (1 - m) + this.range.apply(j, a[j]) * m; }
    this.used = idx.length; this.weight = m;
    return true;
  }
}

/** The 52 MediaPipe scores of a frame in ARKIT order (0 where a category is missing). */
export function scores52(cats: readonly Cat[], out = new Float32Array(ARKIT.length)): Float32Array {
  out.fill(0);
  for (const c of cats) { const k = IX.get(c.categoryName); if (k !== undefined) out[k] = c.score; }
  return out;
}
