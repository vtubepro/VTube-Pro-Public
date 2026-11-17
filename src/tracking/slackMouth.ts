// Slack-mouth gate (camera): a performer whose lips rest a little apart — a relaxed jaw, mouth breathing, a beard that
// hides where the lips meet, looking up at a screen — must not drive an avatar's mouth open while they are NOT talking.
//
// The camera alone can tell talking from a resting posture: speech moves the lips 3-8 times a second, a resting mouth
// stays put (measured on the recorded test clip: lip-gap activity, interocular units / s, median 0.48 while talking,
// p10 0.13; 0.03 with the lips resting 0.11 apart while looking at the screen). Even mumbling moves them ≥ ~0.1 /s.
//
// So the opening the avatar shows is measured from a SLACK FLOOR instead of from the fully closed mouth:
//   floor   starts at the closed lips and follows the lip gap down at once (a closure is never lost). While the lips
//           move like speech, and for a ~1 s grace after they stop, it sinks back toward the closed lips (every
//           syllable, mumbled or not, shows its whole opening). Only a mouth that has been still for that long creeps
//           up to its resting opening (~0.3 s), which then reads as closed.
//   cap     the floor never sits more than `max` (0.13 of the eye span; the self-test may offer a performer's own) above
//           the closed lips, and its share fades out between `max` and `max` + 0.06: anything opened wider than a
//           resting mouth — a held "ee" / "ah", a long sung note, a gasp — keeps (nearly) all of its opening. A held
//           ROUNDED shape with the lips apart ("oh", "oo": a resting mouth is never rounded) keeps all of it.
// The result is a gain k (0..1) applied by the face solver to every lip-opening channel (jawOpen, mouthLowerDown,
// mouthUpperUp, the lip contour); the RAW lip gap used by the closure detectors is left untouched.
//
// Pure (no DOM, no allocation per frame): the face solver runs it per camera frame; tools/eval_lipsync.ts and
// tools/slackmouth_unit.ts replay it.

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const ss = (e0: number, e1: number, x: number) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

/** Default: how far above the closed lips a resting mouth may sit and still read as closed (lip gap / eye-corner span). */
export const SLACK_MAX = 0.13;
/** Width of the band above `max` over which the floor's share fades out. */
const FADE = 0.06;
/** Seconds after the talking reading drops (itself ~0.6 s after the last lip movement) before the floor may rise. */
const GRACE = 0.8;

export class SlackMouth {
  /** lip-gap activity (|d gap / dt| smoothed over ~0.2 s), interocular units per second */
  act = 0;
  /** 0..1: the lips are moving like speech (fast attack, ~0.35 s hold) — camera only, never the voice */
  talk = 0;
  /** the slack floor (lip-gap units, absolute) */
  floor = 0;
  /** last gain (diagnostics) */
  k = 1;
  /** how far above the closed lips a resting mouth may sit and still read as closed (SLACK_MAX by default) */
  max = SLACK_MAX;
  /** seconds since the lips last moved like speech */
  stillFor = 99;
  private prev = NaN;
  private hold = 0;
  /** seconds of lip movement banked (a one-frame landmark blip is not talking: it must last ~0.2 s) */
  private ev = 0;
  private seeded = false;

  reset() { this.act = 0; this.talk = 0; this.floor = 0; this.k = 1; this.prev = NaN; this.hold = 0; this.ev = 0; this.seeded = false; this.stillFor = 99; }

  /**
   * One camera frame. `gap` = raw inner-lip gap over the eye-corner span (after the blink guard), `rest` = the closed
   * rest of that gap (calibrated / 10th percentile), `dt` = frame interval (s), `visible` = the camera sees the lips
   * (no mic / hand in front), `held` 0..1 = the lips hold a rounded shape, `headSpeed` = head rotation speed (rad/s:
   * a fast turn distorts the lip landmarks, so it neither starts nor ends "talking"). Returns the opening gain k.
   */
  step(gap: number, rest: number, dt: number, visible = true, held = 0, headSpeed = 0): number {
    dt = Math.min(0.1, Math.max(1e-3, dt));
    if (!this.seeded) { this.floor = rest; this.seeded = true; }
    // a hidden mouth: the guessed landmarks say nothing — and the first frame seen again starts a fresh speed reading
    // (no jump from the guess to the real lips)
    if (!visible) { this.prev = NaN; return this.k = 1; }
    const v = Number.isFinite(this.prev) ? Math.abs(gap - this.prev) / dt : 0;
    this.prev = gap;
    this.act += (Math.min(v, 3) - this.act) * (1 - Math.exp(-dt / 0.2));
    const turning = ss(0.6, 1.5, headSpeed);
    if (turning < 0.5) {
      // lip movement must last: ~0.2 s banked (a syllable, a mumble) before it counts; a landmark blip never does
      const moving = ss(0.06, 0.12, this.act) > 0.5;
      this.ev = moving ? Math.min(0.4, this.ev + dt) : Math.max(0, this.ev - dt * 0.5);
      if (moving && this.ev >= 0.2) this.hold = 0.35; else this.hold -= dt;
    }
    const tt = this.hold > 0 ? 1 : 0;
    this.talk = tt > this.talk ? tt : this.talk + (tt - this.talk) * (1 - Math.exp(-dt / 0.25));
    this.stillFor = this.talk > 0.5 ? 0 : this.stillFor + dt;
    const max = Math.max(0.02, this.max);
    const tgt = Math.min(gap, rest + max);
    if (tgt < this.floor) this.floor += (tgt - this.floor) * (1 - Math.exp(-dt / 0.04));          // closures: at once
    else if (this.stillFor < GRACE) this.floor += (rest - this.floor) * (1 - Math.exp(-dt / 0.6)); // talking: sink
    else this.floor += (tgt - this.floor) * (1 - Math.exp(-dt / 0.25));                            // still: creep up
    if (this.floor < rest) this.floor = rest;
    const open = gap - rest;
    if (open <= 1e-3) return this.k = 1;
    // the floor's share fades out for openings wider than a resting mouth; a held rounded shape with the lips visibly
    // apart keeps all of it (a pucker / puffed cheeks are closed lips)
    const w = (1 - ss(max, max + FADE, open)) * (1 - clamp01(held) * ss(0.04, 0.08, open));
    const above = gap - (rest + (this.floor - rest) * w);
    return this.k = clamp01(above / open);
  }
}
