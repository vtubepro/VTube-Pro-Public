// Lip-sync lookahead (optional, default OFF): the performer delays their mic in OBS by D ms (Audio Mixer → ⚙ →
// Advanced Audio Properties → mic → Sync Offset = +D ms). The mouth pipeline then shows the voice D ms late — in sync
// with the delayed audio the viewers hear — and gets D ms of FUTURE voice to work with, which real mouths need:
// lips round, close and part 50–300 ms before the sound they make (anticipatory coarticulation).
//
// Given the live AudioMouth stream, `step()` returns the frame from D ms ago (minus the ~17 ms the analysis
// envelopes themselves lag, so the shown mouth lands ON the delayed audio), reshaped by what comes next:
//   * bilabial pre-closure  — an M/B/P within the next ≤ 60 ms starts sealing the lips now (dominance-weighted)
//   * anticipatory rounding — an O/U/W within the next ≤ 150 ms pulls rounding into the current sound
//   * pre-opening           — a voice onset from silence within ≤ 90 ms parts the lips slightly first
//                             (not before an M/B/P: those start closed)
//   * blip rejection        — a short (< 60 ms) isolated opening in silence, with silence after it, is damped
// D = 0 returns the input untouched (byte-for-byte today's behaviour). Pure; shared by the app and the tools.
import type { AudioMouth } from './audioFeatures.ts';

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export const LOOKAHEAD_KEY = 'vtp.lipLookahead';
/** Offered settings (ms). */
export const LOOKAHEAD_CHOICES = [0, 60, 80, 100, 120, 150];

/** Stored lookahead (ms, 0 = off). */
export function loadLookahead(): number {
  try { const v = Number(globalThis.localStorage?.getItem(LOOKAHEAD_KEY) ?? 0); return Number.isFinite(v) ? Math.max(0, Math.min(250, v)) : 0; } catch { return 0; }
}

export interface LookaheadDbg { pre: number; round: number; open: number; blip: number }

export class LipLookahead {
  /** lookahead / display delay (ms) */
  delayMs = 0;
  dbg: LookaheadDbg = { pre: 0, round: 0, open: 0, blip: 0 };
  /** the analysis pipeline's own lag (s) that the lookahead also hides: the frame shown is from now − D + comp */
  comp = 0.017;
  /** actual age (s) of the frame returned last (D − comp, quantised to analysis frames) */
  age = 0;
  private q: { t: number; a: AudioMouth }[] = [];

  step(a: AudioMouth, now: number): AudioMouth {
    const D = this.delayMs / 1000;
    if (D <= 0) { this.q.length = 0; this.age = 0; return a; }
    this.q.push({ t: now, a });
    while (this.q.length > 2 && this.q[1].t <= now - D - 0.12) this.q.shift();
    const tc = now - Math.max(0, D - this.comp);
    // current = the newest frame at or before now − D (before the buffer fills: the oldest)
    let ci = 0;
    for (let i = 0; i < this.q.length; i++) if (this.q[i].t <= tc + 1e-6) ci = i;
    const cur = this.q[ci].a;
    this.age = now - this.q[ci].t;
    const out: AudioMouth = { ...cur, vowels: { ...cur.vowels }, visemes: cur.visemes ? { ...cur.visemes } : cur.visemes };
    let pre = 0, round = 0, onset = 0, onsetClosed = false;
    const curSil = cur.level < 0.06 && !cur.voiced;
    for (let i = ci + 1; i < this.q.length; i++) {
      const f = this.q[i].a, d = this.q[i].t - tc;
      const v = f.visemes;
      const pp = Math.max(v?.PP ?? 0, f.closure * (f.voiced || f.level > 0.05 ? 1 : 0.6));
      if (d <= 0.06) pre = Math.max(pre, pp * Math.exp(-d / 0.03));
      if (d <= 0.15) round = Math.max(round, Math.max((v?.U ?? 0) + (v?.W ?? 0), (v?.O ?? 0) * 0.8, f.vowels.U * f.level, f.vowels.O * f.level * 0.8) * Math.exp(-d / 0.08));
      if (curSil && d <= 0.09 && onset === 0 && f.level > 0.2) { onset = Math.exp(-d / 0.05); onsetClosed = pp > 0.3; }
    }
    // M / B / P coming: seal early (never during a clear vowel peak further than ~30 ms away — the exp handles it)
    if (pre > 0.05) {
      out.closure = Math.max(out.closure, clamp01(pre * 0.9));
      if (out.visemes) {
        const k = clamp01(pre * 0.8);
        const add = Math.max(0, k - (out.visemes.PP ?? 0));
        if (add > 0) { for (const key in out.visemes) if (key !== 'PP') (out.visemes as Record<string, number>)[key] *= 1 - add; out.visemes.PP = (out.visemes.PP ?? 0) + add; }
      }
    }
    // O / U / W coming: round into it (the rig's rounding follows the vowel weights + visemes)
    if (round > 0.08 && !(pre > 0.3)) {
      const k = clamp01(round * 0.5);
      out.vowels.U = Math.max(out.vowels.U, out.vowels.U + k * 0.6 * (1 - out.vowels.U));
      out.vowels.O = Math.max(out.vowels.O, out.vowels.O + k * 0.4 * (1 - out.vowels.O));
      out.pucker = Math.max(out.pucker, k * 0.6 * Math.max(out.level, 0.25));
      out.funnel = Math.max(out.funnel, k * 0.4 * Math.max(out.level, 0.25));
    }
    // voice onset from silence (not an M/B/P): part the lips a little first
    if (onset > 0 && !onsetClosed) {
      out.open = Math.max(out.open, 0.07 * onset);
      out.level = Math.max(out.level, 0.06 * onset);
    }
    // isolated blip: opening that started ≤ 60 ms ago in silence and is followed by silence → damp it
    let blip = 0;
    if (cur.level > 0.1) {
      let before = 0, after = 0;
      for (let i = ci - 1; i >= 0 && tc - this.q[i].t <= 0.1; i--) if (this.q[i].a.level > 0.08) before += this.q[i].t > tc - 0.06 ? 1 : 3;
      const fut = this.q.slice(ci + 1).filter((x) => x.t - tc <= 0.06);
      for (const x of fut) if (x.a.level > 0.08) after++;
      if (before <= 3 && fut.length >= 3 && after === 0) blip = 1;
    }
    if (blip) { out.open *= 0.35; out.level *= 0.35; }
    this.dbg = { pre, round, open: onset, blip };
    return out;
  }
}
