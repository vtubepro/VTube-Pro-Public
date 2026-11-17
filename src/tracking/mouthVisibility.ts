// Mouth visibility: can the camera actually SEE the lips right now, or is something in front of them (a mic on a
// boom arm, a pop filter, a mug mid-sip, a hand, fingers)?
//
// Why it matters (measured with the occlusion harness, tools/occlusion/ + tools/eval_occlusion.ts): MediaPipe keeps
// tracking the face behind a mic / mug / hand and HALLUCINATES a calm, closed mouth (jawOpen 0.00 and a zero lip gap
// behind a boom mic, against 0.17 / 0.10 for the real mouth). Downstream that "closed" reading is trusted like a real
// one: the voice-led mouth is held to the camera-tracked gain (talking behind a mic came out ~1/3 too small), the
// viseme engine reads the shut lips as M/B/P, and the snack logic reads a frozen jaw. So the camera's mouth vote must
// fade out while the lips are hidden — the voice then drives the mouth exactly as for a mic-only performer — and fade
// back in when they reappear.
//
// Cues (each 0 = visible … 1 = hidden):
//   colour  the lips are redder than whatever surrounds them (skin, stubble, beard) under any ordinary light; a black
//           foam mic, a white mug, a pop filter mesh or a hand over them is not. Measured on the face worker's 64 x 64
//           mouth patch (mouthImage.ts: ringHi = upper quartile of the lip ring's red chroma, ctxHi = upper quartile of
//           the patch around the lips: the SAME statistic on both sides, so an occluder covering both reads ~0 however
//           noisy or textured its colour is), against the performer's own contrast learned while it is clearly visible
//           (lipstick, pale lips, warm / coloured light). Lips that keep opening while colour calls them covered (dark
//           lipstick, face paint) switch this cue off for that face.
//   hands   the hand model's landmarks: the share of the lip outline inside a hand's hull (a hand over the mouth is
//           skin-coloured, so colour alone can't see it reliably).
//   open    the camera sees the lips clearly APART (MediaPipe never opens a mouth it can't see: 0.004 lip gap behind a
//           mic / mug / hand vs ~0.10 when talking) — proof the mouth is visible, and the moment to learn what this
//           performer's lips look like (pale lips that barely stand out from the skin must not read as covered).
// Pure logic (no DOM): unit-tested in tools/mouthvis_unit.ts, scored in tools/eval_occlusion.ts.

export interface VisPatch { ringRG?: number; ringHi?: number; ringLum?: number; ringN?: number; ctxRG?: number; ctxHi?: number }

/** Lip contrast of one patch: upper quartile of the lips' red chroma − upper quartile of the context's (NaN when the
 *  patch doesn't have it). A stats source from before ctxHi falls back to the old (biased) upper quartile − mean. */
export function lipContrast(p: VisPatch | null | undefined): number {
  if (!p || typeof p.ringHi !== 'number') return NaN;
  if (typeof p.ctxHi === 'number') return p.ringHi - p.ctxHi;
  if (typeof p.ctxRG === 'number') return p.ringHi - p.ctxRG;
  return NaN;
}
export interface Pt2 { x: number; y: number }

const ss = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/**
 * Lip contrast (lipContrast) assumed until this performer's own is learned. On the test clip a clearly visible mouth
 * measures 0.034 / 0.058 / 0.074 (5th / 50th / 95th percentile) and learns ~0.061; the prior sits at ~0.65 of that, like
 * the old 0.05 did against the old (upper quartile − mean) 0.073.
 */
export const VIS_PRIOR = 0.04;
/** Below this learned contrast the lips barely stand out from the skin: the colour test fades out (0.010 … 0.020). */
export const VIS_RELIABLE: [number, number] = [0.01, 0.02];
/** Time constant (s) of the learned contrast, in REAL time between learning updates (patch reads arrive at 7.5–15 Hz). */
export const VIS_LEARN_TAU = 20;
/** A patch older than this (s) means the colour check isn't running right now (tracker busy, setting off, no worker). */
export const VIS_PATCH_STALE = 1;

/** Outer lip contour (MediaPipe face mesh): right corner → lower lip → left corner → upper lip. */
export const LIP_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];

function inPoly(px: number, py: number, P: Pt2[]) {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const a = P[i], b = P[j];
    if ((a.y > py) !== (b.y > py) && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y + 1e-9) + a.x) inside = !inside;
  }
  return inside;
}
/** Convex hull (Andrew's monotone chain), counter-clockwise. */
export function hull(pts: Pt2[]): Pt2[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Pt2, a: Pt2, b: Pt2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo: Pt2[] = [], hi: Pt2[] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

/**
 * Share (0..1) of the lip outline covered by hands. `lips` = the outer lip contour, `hands` = 21-point hand landmark
 * sets, all in the same image units (x scaled by the aspect so distances are isotropic). The hand hull is padded a
 * little (fingers are thicker than their joint landmarks).
 */
export function handCover(lips: Pt2[], hands: Pt2[][]): number {
  if (lips.length < 3 || !hands.length) return 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of lips) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const hulls = hands.filter((h) => h.length >= 5).map((h) => {
    // finger width ≈ 1/5 of the palm (wrist → middle knuckle); push every hull vertex out by half of it
    const palm = h.length >= 10 ? Math.hypot(h[9].x - h[0].x, h[9].y - h[0].y) : 0;
    const H = hull(h), c = H.reduce((a, q) => ({ x: a.x + q.x / H.length, y: a.y + q.y / H.length }), { x: 0, y: 0 });
    const pad = palm * 0.12;
    return H.map((q) => { const d = Math.hypot(q.x - c.x, q.y - c.y) || 1; return { x: q.x + ((q.x - c.x) / d) * pad, y: q.y + ((q.y - c.y) / d) * pad }; });
  });
  let n = 0, hit = 0;
  for (let j = 0; j < 6; j++) for (let i = 0; i < 12; i++) {
    const x = x0 + ((i + 0.5) / 12) * (x1 - x0), y = y0 + ((j + 0.5) / 6) * (y1 - y0);
    if (!inPoly(x, y, lips)) continue;
    n++;
    if (hulls.some((h) => inPoly(x, y, h))) hit++;
  }
  return n ? hit / n : 0;
}

/**
 * The hand landmarks the lip test may use: the MAIN camera's own hand result (`main` = the main tracker's frame BEFORE
 * the second camera is merged in). In the multicam Body role the merged frame carries camera 2's hands, normalised to
 * camera 2's picture: compared with camera 1's lips they could "cover" the mouth from anywhere in the room.
 * `handsOn` = the Hands switch is on AND the main tracker's hand model runs (Tracker.models().hands): the switch alone
 * isn't hand tracking (the model may have failed to load, or the hands worker isn't up yet).
 * Returns null = no hand tracking (the hands cue is unavailable), [] = tracked, no fresh hand seen.
 */
export function lipTestHands<P>(main: { t: number; bodyT?: number; hands?: { landmarks?: P[][] } | null } | null, handsOn: boolean): P[][] | null {
  if (!handsOn) return null;
  const hl = main?.hands?.landmarks;
  const fresh = !!main && (main.bodyT === undefined || Math.abs(main.t - main.bodyT) < 0.25);
  return hl?.length && fresh ? hl : [];
}

/** What the Voice lip-sync status line needs to know (panels.ts). */
export interface MouthStatusIn {
  /** the mouth check's setting (MouthVisibility.enabled) */
  enabled: boolean;
  /** tracking is on / a face is tracked right now */
  tracking: boolean; tracked: boolean;
  /** a mouth patch arrived lately (MouthVisibility.checking) */
  checking: boolean;
  /** the tracker skips the patch because the PC is busy (Tracker.mouthVisPause === 'busy') */
  busy: boolean;
  /** smoothed visibility (MouthVisibility.vis) */
  vis: number;
  /** the microphone drives the mouth */
  mic: boolean;
  /** a hand model really runs for the lip test (FaceSolver.hands !== null: the Hands switch is on AND the main tracker's
   *  hand model is loaded), so a hand over the mouth is still noticed without the patch */
  hands: boolean;
}
/**
 * The live status line under Tracking → Voice lip-sync, honest about what is checked: off / not running (paused) /
 * the camera sees the mouth / something covers it. Never says "the camera sees your mouth" when nothing looked.
 */
export function mouthStatusText(s: MouthStatusIn): string {
  if (!s.enabled) return 'Mouth check is off.';
  if (!s.tracking || !s.tracked) return '';
  if (s.vis < 0.5) {
    return s.mic ? 'Something is in front of your mouth (a mic or a hand?). Your voice moves it on its own.'
      : 'Something is in front of your mouth (a mic or a hand?). Turn on the microphone so your voice can move it.';
  }
  if (!s.checking) {
    return `${s.busy ? 'Mouth check paused (tracking is busy on this PC)' : 'Mouth check isn’t running right now'}. ${s.hands
      ? 'Only a hand over your mouth is noticed, not a mic or a cup.' : 'A mic, a cup or a hand in front of your mouth isn’t noticed.'}`;
  }
  return 'The camera sees your mouth.';
}

export class MouthVisibility {
  /** Performer's own lip contrast (lipContrast while clearly visible); null until learned. */
  base: number | null = null;
  private seen = 0;
  /** Smoothed visibility 0..1 (1 = the camera sees the lips). */
  vis = 1;
  /** Last cue values (diagnostics). */
  cue = { colour: 0, hands: 0, contrast: NaN };
  private lastPatchT = -1;
  /** time of the last step / of the last baseline update */
  private lastT = -1;
  private learnT = -1;
  /**
   * Is the colour check running right now (a mouth patch arrived within VIS_PATCH_STALE s)? False while the tracker
   * skips the patch (adaptive quality at its lightest level, face inference over budget, the main-thread fallback, an
   * external tracker): then only a hand over the mouth is noticed, and the UI must not claim "the camera sees your mouth".
   */
  get checking() { return this.enabled && this.lastPatchT >= 0 && this.lastT - this.lastPatchT <= VIS_PATCH_STALE; }
  private colourHold = 0;
  /** the colour test clearly saw lips (0..1), held like colourHold */
  private seenLips = 0;
  /** times the lips opened (seen apart) while the colour test called them covered */
  private apartEps: number[] = [];
  private wasApart = false;
  /** the colour test's own verdict (0..1 covered), before the lips-apart override */
  private colourRaw = 0;
  /** Off switch (localStorage 'vtp.mouthVis' = '0'): vis stays 1. */
  enabled = (() => { try { return globalThis.localStorage?.getItem('vtp.mouthVis') !== '0'; } catch { return true; } })();

  /**
   * One camera frame. `patch` = the face worker's mouth-patch stats (null when it didn't run this frame — it may run at
   * a reduced rate), `handCov` = handCover() of this frame (−1 = hand tracking unavailable), `open` = the per-performer
   * normalised raw lip gap (face._lipOpen: 0 closed … 1 wide open).
   */
  step(t: number, dt: number, patch: VisPatch | null, handCov = -1, open = 0): number {
    this.lastT = t;
    if (!this.enabled) { this.vis = 1; return 1; }
    // ---- colour: lip contrast vs the performer's own
    const c = lipContrast(patch);
    if (patch && Number.isFinite(c) && (patch.ringN ?? 0) >= 12) {
      this.cue.contrast = c;
      // prior until learned: the lips' reddest quarter stands ~0.035–0.075 above the reddest quarter of its surroundings
      // (skin / beard); learn the performer's own from frames that are clearly visible by the same test (a covered mouth
      // never becomes normal)
      const ref = this.base ?? VIS_PRIOR;
      const rel = c / Math.max(VIS_RELIABLE[0], ref);
      // (lips apart only teach a contrast that is there at all: an occluder never becomes this face's normal)
      const apart = open > 0.3 && c > 0.004;
      if ((rel > 0.6 || apart) && this.cue.hands < 0.2) {
        // the time constant runs in real time between updates: they come only with a patch (7.5–15 a second), not with
        // every camera frame (a camera-frame dt made 20 s act like 40–160 s); a long gap counts as at most 1 s
        const gap = this.learnT >= 0 ? Math.min(1, Math.max(0, t - this.learnT)) : dt;
        const k = this.seen < 60 ? 1 / (this.seen + 1) : 1 - Math.exp(-gap / VIS_LEARN_TAU);
        this.base = this.base === null ? c : this.base + (c - this.base) * k;
        this.seen++;
        this.learnT = t;
      }
      // hidden below ~20 % of the usual contrast, seen above ~45 % (test clip: every visible frame — wide 'aa', puffed
      // cheeks, head turns — stays above ~55 %; a mic / mug / hand gives < 10 %); a very low learned contrast means this
      // face's lips barely stand out → colour can't tell, stay neutral
      const reliable = ss(VIS_RELIABLE[0], VIS_RELIABLE[1], ref);
      // lips seen apart: whatever the colour says, the camera sees this mouth
      this.colourRaw = (1 - ss(0.2, 0.45, rel)) * reliable;
      this.colourHold = this.colourRaw * (1 - ss(0.2, 0.4, open));
      this.seenLips = Math.max(ss(0.55, 0.85, rel) * reliable, ss(0.2, 0.4, open));
      this.lastPatchT = t;
    } else if (t - this.lastPatchT > 0.3) { this.colourHold = Math.max(0, this.colourHold - dt / 0.3); this.seenLips = Math.max(0, this.seenLips - dt / 0.3); } // stale: let go
    // lips seen apart again and again while the colour test calls them covered (dark / blue lipstick, face paint): the
    // colour test is wrong for this face — take its contrast as this face's normal, which switches the colour cue off
    // (never learned from an occluder: MediaPipe doesn't open a mouth it can't see)
    const apartNow = open > 0.3;
    if (apartNow && !this.wasApart && this.colourRaw > 0.5) this.apartEps.push(t);
    this.wasApart = apartNow;
    while (this.apartEps.length && t - this.apartEps[0] > 20) this.apartEps.shift();
    if (this.apartEps.length >= 3 && Number.isFinite(this.cue.contrast)) {
      this.base = Math.min(this.base ?? VIS_PRIOR, Math.max(0, this.cue.contrast));
      this.seen = Math.max(this.seen, 60);
      this.apartEps = [];
      this.colourHold = 0; this.colourRaw = 0;
    }
    this.cue.colour = this.colourHold;
    // a hand's landmark hull is only roughly the hand (fingers resting at the chin can graze the lip outline): when the
    // patch plainly shows lips, the colour test wins
    this.cue.hands = handCov >= 0 ? ss(0.15, 0.6, handCov) * (1 - this.seenLips) : 0;
    const hidden = Math.max(this.cue.colour, this.cue.hands);
    const target = 1 - hidden;
    // hide fast (~50 ms: the next syllable already plays by the voice), come back a bit slower (~150 ms, no flicker)
    const tau = target < this.vis ? 0.05 : 0.15;
    this.vis += (target - this.vis) * (1 - Math.exp(-dt / tau));
    return this.vis;
  }

  reset() { this.base = null; this.seen = 0; this.vis = 1; this.colourHold = 0; this.seenLips = 0; this.apartEps = []; this.wasApart = false; this.colourRaw = 0; this.lastPatchT = -1; this.lastT = -1; this.learnT = -1; this.cue = { colour: 0, hands: 0, contrast: NaN }; }
}
