// Viseme fusion: voice-timed visemes (visemes.ts) confirmed + disambiguated by the camera.
//
// The camera sees the lips ~80 ms late, so it can't TIME a 60 ms consonant — but it can tell which member
// of a family the voice meant, and it is right about anything held:
//   fricatives   FF (lower lip tucked) · TH (tongue tip between the teeth) · CH (lips rounded/protruded) · SS (spread)
//   closures     PP (lips visibly shut) · nn / DD / kk (lips apart, tongue up)
//   approximants L (open + tongue tip up) · RR / W (rounded)
//   vowels       O / U (rounded) · aa (open) · E / I (spread)
// The camera's vote grows with how long the family has been active (a held "fffff" is fully camera-
// confirmed; a quick "f" in running speech stays audio-led). Raw webcam cue channels from the tracker are
// used when present (face._lipTuck, _lipRound, _tongueUp, _teethShow, tongueOut) with ARKit proxies
// otherwise, and everything degrades to audio-only when the face isn't tracked.

import type { TrackingFrame } from '../../shared/types.ts';
import { clamp01, smoothstep as ss } from './filters.ts';
import { VISEMES, normalizeVisemes, zeroVisemes, type Viseme, type VisemeWeights } from './visemes.ts';

export interface CameraCues { tracked: boolean; tuck: number; round: number; tongueUp: number; tongueOut: number; closed: number; open: number; spread: number; teeth: number;
  /** how much the camera actually SEES the mouth (face._mouthVis: a mic / mug / hand in front of it → 0) */
  vis: number }

/** Articulation cues from a camera frame (raw tracker channels when the tracker provides them). */
export function cameraCues(frame: TrackingFrame): CameraCues {
  const f = frame.face, g = (k: string) => f[k] ?? 0;
  const has = (k: string) => typeof f[k] === 'number';
  const m = frame.mouth;
  const round = has('_lipRound') ? g('_lipRound') : clamp01(Math.max(m.pucker, m.funnel * 0.9));
  const tuck = has('_lipTuck') ? g('_lipTuck') : clamp01(g('mouthRollLower') * 1.3 + g('mouthShrugLower') * 0.3 - m.open * 0.8);
  const open = clamp01(m.open);
  // a hidden mouth (mouthVisibility.ts) is MediaPipe's guess of a calm closed mouth: it confirms nothing
  const vis = has('_mouthVis') ? clamp01(g('_mouthVis')) : 1;
  return {
    tracked: frame.tracked && vis > 0.5,
    vis,
    tuck,
    round,
    tongueUp: has('_tongueUp') ? g('_tongueUp') : 0,
    tongueOut: g('tongueOut'),
    closed: clamp01(1 - open * 4) * clamp01(0.4 + g('mouthClose') + g('mouthPressLeft') * 0.5 + g('mouthPressRight') * 0.5),
    open,
    spread: clamp01(Math.max(m.wide, (g('mouthStretchLeft') + g('mouthStretchRight')) / 2) + m.smile * 0.3),
    teeth: has('_teethShow') ? g('_teethShow') : 0,
  };
}

type Family = 'fric' | 'clos' | 'appr' | 'vow';
const FAMILY: Record<Family, Viseme[]> = {
  fric: ['FF', 'TH', 'CH', 'SS'],
  clos: ['PP', 'nn', 'DD', 'kk'],
  appr: ['L', 'RR', 'W'],
  vow: ['aa', 'E', 'I', 'O', 'U'],
};

export class VisemeFusion {
  private active: Record<Family, number> = { fric: 0, clos: 0, appr: 0, vow: 0 };
  out: VisemeWeights = zeroVisemes();
  dbg = { camW: 0, cues: null as CameraCues | null };

  /**
   * camClo (0..1): lips seen meeting right now (speechFusion's synced dip detector, only with the lookahead) → M/B/P.
   * (Letting the synced camera re-split the other families immediately was tried: F/V tuck 3/4 → 2/4, PP 11 → 10/11 —
   * the webcam's tuck / round cues are too weak for that; `sync` is accepted but unused.)
   */
  step(frame: TrackingFrame, audio: Partial<Record<Viseme, number>> | undefined, dt: number, _sync = 0, camClo = 0): VisemeWeights {
    const a = audio ? normalizeVisemes(audio) : zeroVisemes();
    const c = cameraCues(frame);
    this.dbg.cues = c;
    const w = { ...a } as Record<Viseme, number>;
    for (const fam of Object.keys(FAMILY) as Family[]) {
      const members = FAMILY[fam];
      const mass = members.reduce((s, v) => s + a[v], 0);
      this.active[fam] = mass > 0.2 ? this.active[fam] + dt : 0;
      if (!c.tracked || mass < 0.03) continue;
      // how much the camera may re-split this family: it needs ~60–150 ms to catch up with the voice
      // (it only starts once the ~80 ms-late camera can actually be showing this sound)
      const camW = ss(0.08, 0.2, this.active[fam]) * (fam === 'vow' ? 0.4 : 0.6) * ss(0.5, 0.9, c.vis);
      if (fam === 'fric') this.dbg.camW = camW;
      if (camW < 0.01) continue;
      const sup = support(fam, c);
      // posterior ∝ audio share × camera support; then mix toward it by camW
      let ps = 0;
      const post: Partial<Record<Viseme, number>> = {};
      for (const v of members) { post[v] = (a[v] / mass + 0.08) * (sup[v] ?? 1); ps += post[v]!; }
      for (const v of members) w[v] = mass * ((1 - camW) * (a[v] / mass) + camW * (post[v]! / (ps || 1)));
    }
    // clearly closed lips while the voice murmurs → a real M/B/P, not an N; clearly open lips during a
    // "closure" → the voice's dip was a quieter vowel, give it back to the vowels
    if (c.tracked) {
      const clos = w.PP + w.nn + w.DD + w.kk;
      if (clos > 0.05 && c.open > 0.35 && this.active.clos > 0.1) {
        const back = clos * 0.5 * ss(0.35, 0.6, c.open) * ss(0.5, 0.9, c.vis);
        const vs = w.aa + w.E + w.I + w.O + w.U;
        for (const v of ['PP', 'nn', 'DD', 'kk'] as Viseme[]) w[v] *= 1 - back / clos;
        if (vs > 0.01) for (const v of ['aa', 'E', 'I', 'O', 'U'] as Viseme[]) w[v] += back * (w[v] / vs);
        else w.aa += back;
      }
    }
    // synced camera saw the lips meet inside speech: that IS a bilabial, whatever family the voice guessed
    // (a P's silent hold reads as silence / a stop to the ear; the eye sees the seal)
    if (c.tracked && camClo > 0.3) {
      const k = ss(0.3, 0.8, camClo) * 0.7 * ss(0.5, 0.9, c.vis);
      const target = Math.max(w.PP, k * (1 - w.sil * 0.5));
      const add = target - w.PP;
      if (add > 0) {
        const rest = 1 - w.PP;
        for (const v of VISEMES) if (v !== 'PP') w[v] *= rest > 1e-6 ? 1 - add / rest : 0;
        w.PP = target;
      }
    }
    this.out = normalizeVisemes(w);
    return this.out;
  }
}

function support(fam: Family, c: CameraCues): Partial<Record<Viseme, number>> {
  const lift = (x: number, k = 3) => 1 + k * clamp01(x);
  switch (fam) {
    case 'fric': return {
      FF: lift(c.tuck, 4) * (1 - 0.6 * c.round) * (1 - 0.7 * clamp01(c.tongueOut * 2)),
      TH: lift(Math.max(c.tongueOut * 2, c.tongueUp * 0.6), 4) * (1 - 0.7 * c.tuck),
      CH: lift(c.round, 2.5) * (1 - 0.6 * c.tuck),
      SS: lift(Math.max(c.spread, c.teeth), 2) * (1 - 0.7 * c.round) * (1 - 0.7 * c.tuck),
    };
    case 'clos': return {
      PP: lift(c.closed, 5),
      nn: lift(clamp01(1 - c.closed) * 0.5 + c.tongueUp, 2),
      DD: lift(clamp01(1 - c.closed) * 0.5 + c.tongueUp * 0.7 + c.teeth * 0.5, 2),
      kk: lift(c.open * 0.8, 2),
    };
    case 'appr': return {
      L: lift(c.tongueUp * 1.2 + (1 - c.round) * c.open * 0.6, 3),
      RR: lift(c.round * 0.8, 2),
      W: lift(c.round * 1.2, 3) * (1 - 0.5 * c.open),
    };
    case 'vow': return {
      aa: lift(c.open * (1 - c.round), 2),
      E: lift(c.spread * 0.8, 1.5),
      I: lift(c.spread, 2) * (1 - 0.5 * c.open),
      O: lift(c.round * c.open * 2, 2),
      U: lift(c.round * (1 - c.open), 3),
    };
  }
}

/**
 * Camera-/shape-only visemes when there's no voice (mic off, external tracking, old frames): a rough
 * reading of the mouth summary so avatars without the mic still map shapes consistently.
 */
export function visemesFromMouth(m: TrackingFrame['mouth']): VisemeWeights {
  const open = clamp01(m.open), round = clamp01(Math.max(m.pucker, m.funnel)), wide = clamp01(m.wide);
  const w: Partial<Record<Viseme, number>> = {};
  w.aa = open * (1 - round) * (1 - wide * 0.5);
  w.E = wide * ss(0.1, 0.35, open) * (1 - round) * 0.7;
  w.I = wide * (1 - open) * (1 - round) * 0.6;
  w.O = m.funnel * ss(0.1, 0.4, open);
  w.U = m.pucker * (1 - open * 0.7);
  w.FF = clamp01(m.fv ?? 0);
  w.SS = clamp01(m.sib ?? 0);
  w.PP = clamp01(m.closure ?? 0);
  const s = VISEMES.reduce((acc, v) => acc + (w[v] ?? 0), 0);
  if (s > 1) for (const v in w) w[v as Viseme]! /= s;
  return normalizeVisemes(w);
}
