// One-eye tracking — for performers who wear an eye patch or have one eye (Track → Calibration → "Eyes tracked").
//
// With 'left' / 'right' (the performer's OWN visible eye), everything the avatar's eyes do comes from that eye:
// the covered eye's blendshapes (blink, squint, wide, look in / out / up / down) are replaced by the visible eye's
// (in / out swapped: looking to your right = left eye in, right eye out), its eye-aspect ratio too, and gaze reads
// the visible iris only. The solver runs on those copies, so blinks close both avatar eyes, a covered eye never
// fakes a wink, and natural mode + calibration only ever learn from the visible eye. Setting per PERSON (not per
// avatar): localStorage 'vtp.eyesTracked'.
//
// Auto-suggest (OneEyeDetector): with 'both', it watches the raw eye signals and suggests one-eye tracking when one
// eye is consistently hidden — it reads "closed" while the other is open, doesn't follow the other eye's blinks, or
// (what MediaPipe really does behind a patch: it guesses the hidden eye from the rest of the face) follows them at
// only ~half their size. Tuned on the recorded clip re-tracked with a painted eye patch: covered eyes follow the
// visible eye's blinks at 0.3–0.6 of their size (median ~0.47), two open eyes at ~0.85–1.1. A suggestion only.

import type { NormalizedLandmark } from '@mediapipe/tasks-vision';

export type EyesTracked = 'both' | 'left' | 'right';
const KEY = 'vtp.eyesTracked';

export function loadEyesTracked(): EyesTracked {
  try { const v = globalThis.localStorage?.getItem(KEY); return v === 'left' || v === 'right' ? v : 'both'; } catch { return 'both'; }
}

/** Live value for every consumer (camera solver + phone / VMC sources). */
export const eyesTrackedSetting: { value: EyesTracked } = { value: loadEyesTracked() };

export function saveEyesTracked(v: EyesTracked) {
  eyesTrackedSetting.value = v;
  try { globalThis.localStorage?.setItem(KEY, v); } catch { /* storage off */ }
}

const SIDE = { left: 'Left', right: 'Right' } as const;

/** Replace the covered eye's ARKit eye channels with the visible eye's, in place (performer's anatomical sides). */
export function mirrorEyeChannels(bs: Record<string, number>, visible: 'left' | 'right'): Record<string, number> {
  const V = SIDE[visible], C = SIDE[visible === 'left' ? 'right' : 'left'];
  for (const k of ['eyeBlink', 'eyeSquint', 'eyeWide', 'eyeLookUp', 'eyeLookDown']) bs[k + C] = bs[k + V] ?? 0;
  const vin = bs['eyeLookIn' + V] ?? 0, vout = bs['eyeLookOut' + V] ?? 0;
  bs['eyeLookIn' + C] = vout;
  bs['eyeLookOut' + C] = vin;
  return bs;
}

/** Covered-eye channel name → the visible eye's (for neutral / peak / natural-mode lookups); other names unchanged. */
export function visibleKey(name: string, visible: EyesTracked): string {
  if (visible === 'both' || !name.startsWith('eye')) return name;
  const V = SIDE[visible], C = SIDE[visible === 'left' ? 'right' : 'left'];
  if (!name.endsWith(C)) return name;
  const stem = name.slice(0, -C.length);
  return (stem === 'eyeLookIn' ? 'eyeLookOut' : stem === 'eyeLookOut' ? 'eyeLookIn' : stem) + V;
}

// MediaPipe face-mesh eye landmarks (performer's anatomical sides), as in faceSolver.ts
const EYE = {
  left: { outer: 263, inner: 362, up1: 385, up2: 387, lo1: 380, lo2: 373 },
  right: { outer: 33, inner: 133, up1: 160, up2: 158, lo1: 144, lo2: 153 },
};
export function eyeAspect(lm: NormalizedLandmark[], aspect: number, side: 'left' | 'right'): number {
  const E = EYE[side];
  const d = (a: number, b: number) => Math.hypot((lm[a].x - lm[b].x) * aspect, lm[a].y - lm[b].y);
  return (d(E.up1, E.lo1) + d(E.up2, E.lo2)) / (2 * d(E.outer, E.inner) + 1e-6);
}

/** External (phone / VMC / VTS) tracking data: same idea on its blendshapes + per-eye rotations. */
export function oneEyeExternal<T extends { blendshapes?: Record<string, number>; eyeLeft?: [number, number]; eyeRight?: [number, number] }>(d: T, visible: 'left' | 'right'): T {
  const out = { ...d };
  if (d.blendshapes) out.blendshapes = mirrorEyeChannels({ ...d.blendshapes }, visible);
  const e = visible === 'left' ? d.eyeLeft : d.eyeRight;
  if (e) { out.eyeLeft = e; out.eyeRight = e; }
  return out;
}

interface Sample { t: number; b: [number, number]; e: [number, number] }

/**
 * Watches the raw (un-copied) eye signals and suggests one-eye tracking when one eye is consistently hidden.
 * 10 Hz samples over a rolling 40 s window of frontal, tracked frames; judged every 2 s once 20 s are in.
 */
export class OneEyeDetector {
  private s: Sample[] = [];
  private lastS = -1;
  private lastEval = -1;
  private streak: { side: 'left' | 'right' | null; n: number } = { side: null, n: 0 };
  /** Suggested VISIBLE eye, or null. */
  suggestion: 'left' | 'right' | null = null;
  private offered = false;
  /** diagnostics: last evaluation */
  last: { closedFrac: [number, number]; events: [number, number]; matched: [number, number]; follow: [number, number]; n: number } | null = null;

  /** raw blendshape blinks + eye-aspect ratios [left, right]; `frontal` = head roughly facing the camera. */
  observe(blink: [number, number], ear: [number, number], frontal: boolean, t: number) {
    if (!frontal || t - this.lastS < 0.1) return;
    this.lastS = t;
    this.s.push({ t, b: blink, e: ear });
    while (this.s.length && this.s[0].t < t - 40) this.s.shift();
    if (t - this.lastEval < 2 || this.s.length < 200) return;
    this.lastEval = t;
    const side = this.judge();
    this.streak = side && side === this.streak.side ? { side, n: this.streak.n + 1 } : { side, n: side ? 1 : 0 };
    // the same verdict 3 evaluations running (~6 s) → suggest (the visible eye)
    this.suggestion = this.streak.n >= 3 ? (this.streak.side === 'left' ? 'right' : 'left') : null;
    if (!this.suggestion) this.offered = false;
  }

  /** The suggestion, once per hidden-eye episode (for a toast). */
  takeSuggestion(): 'left' | 'right' | null {
    if (!this.suggestion || this.offered) return null;
    this.offered = true;
    return this.suggestion;
  }

  reset() { this.s = []; this.streak = { side: null, n: 0 }; this.suggestion = null; this.offered = false; this.last = null; }

  /** Which eye looks COVERED right now (null = both fine). */
  private judge(): 'left' | 'right' | null {
    const S = this.s, n = S.length;
    const med = (f: (x: Sample) => number) => { const v = S.map(f).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
    const eMed: [number, number] = [med((x) => x.e[0]), med((x) => x.e[1])];
    // closure 0..1 per side: blendshape + eye-aspect drop vs the other eye's typical openness
    const eRef = Math.max(eMed[0], eMed[1], 1e-3);
    const cl = (x: Sample, i: 0 | 1) => 0.5 * x.b[i] + 0.5 * Math.min(1, Math.max(0, 1 - x.e[i] / eRef) * 1.6);
    // A) one eye reads "closed" while the other is open, most of the time
    const closedFrac: [number, number] = [0, 0];
    for (const x of S) {
      const c0 = cl(x, 0), c1 = cl(x, 1);
      if (c0 - c1 > 0.3 && c1 < 0.45) closedFrac[0]++;
      if (c1 - c0 > 0.3 && c0 < 0.45) closedFrac[1]++;
    }
    closedFrac[0] /= n; closedFrac[1] /= n;
    // B) blink events on one eye that the other doesn't follow
    const cMed: [number, number] = [med((x) => cl(x, 0)), med((x) => cl(x, 1))];
    const events: [number, number] = [0, 0], matched: [number, number] = [0, 0], follow: [number, number] = [1, 1];
    for (const i of [0, 1] as const) {
      const o = (1 - i) as 0 | 1;
      let armed = true;
      const ratios: number[] = [];
      for (let k = 0; k < n; k++) {
        const c = cl(S[k], i);
        if (armed && c > Math.max(0.5, cMed[i] + 0.3)) {
          armed = false; events[i]++;
          // how far did each eye close within ±0.3 s? (the other one: not at all / partly / fully)
          let mi = 0, mo = 0;
          for (let j = k; j >= 0 && S[j].t >= S[k].t - 0.3; j--) { mi = Math.max(mi, cl(S[j], i)); mo = Math.max(mo, cl(S[j], o)); }
          for (let j = k; j < n && S[j].t <= S[k].t + 0.3; j++) { mi = Math.max(mi, cl(S[j], i)); mo = Math.max(mo, cl(S[j], o)); }
          const r = (mo - cMed[o]) / Math.max(1e-3, mi - cMed[i]);
          ratios.push(r);
          if (r > 0.25) matched[i]++;
        } else if (!armed && c < cMed[i] + 0.15) armed = true;
      }
      if (ratios.length) { ratios.sort((a, b) => a - b); follow[i] = ratios[Math.floor(ratios.length / 2)]; }
    }
    this.last = { closedFrac: [+closedFrac[0].toFixed(2), +closedFrac[1].toFixed(2)], events, matched, follow: [+follow[0].toFixed(2), +follow[1].toFixed(2)], n };
    if (closedFrac[0] > 0.7) return 'left';
    if (closedFrac[1] > 0.7) return 'right';
    for (const i of [0, 1] as const) {
      const o = (1 - i) as 0 | 1;
      // eye i blinks (≥ 4 times) and the other eye follows under 25 % of them: the other one is covered
      if (events[i] >= 4 && matched[i] / events[i] < 0.25 && events[o] <= Math.max(1, events[i] * 0.3)) return o === 0 ? 'left' : 'right';
      // C) eye i blinks (≥ 5 times) and the other eye follows at only about half the size (a guessed, covered eye)
      if (events[i] >= 5 && follow[i] < 0.62 && follow[o] >= 1.2 * follow[i]) return o === 0 ? 'left' : 'right';
    }
    return null;
  }

  summary() {
    return { suggestion: this.suggestion, ...(this.last ?? {}) };
  }
}
