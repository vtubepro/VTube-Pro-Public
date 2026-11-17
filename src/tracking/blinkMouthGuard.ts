// Blinks never open the mouth. MediaPipe's face MESH moves the inner-lip landmarks apart (and raises the upper lip)
// while the eyelids close, although its own jawOpen blendshape stays shut: on drawn / stylised faces the lip gap tripled
// on every blink and the avatar's mouth opened to 0.3-0.7 (beta.12 real-camera QA, tools/realqa_blink_mouth_unit.ts).
// Live2D users saw a mouth flap on every blink.
//
// The guard: while the eyes are closing (and for a short tail after), every landmark-based OPENING reading (lip gap,
// the geometric mouth channels, the upper-lip-raise / lower-lip-drop blendshapes) may fall but not rise above its value
// from just before the blink. It lets go at once when MediaPipe's jawOpen itself confirms an opening (a real "ah" during
// a blink), and after `maxHold` seconds (a long squint, a laugh: not a blink). Blinks last ~0.1-0.4 s, so holding the
// mouth for one is invisible; a mouth that was open before the blink stays as open as it was. Pure, no DOM.

export interface BlinkGuardOptions {
  /** Eye closure (0 open … 1 shut) at which a blink starts / below which it is over. */
  start: number; open: number;
  /** Seconds the hold lasts after the eyes reopen (the mesh relaxes a frame or two after the lids). */
  tail: number;
  /** Longest hold (s): longer closures are squints or smiles, not blinks. */
  maxHold: number;
  /** MediaPipe jawOpen above its rest that counts as a real opening (lets go of the hold). */
  jawConfirm: number;
  /** The pre-blink value is the lowest of this many seconds before the blink started (the mesh starts drifting a frame
   *  before the lids read as closing). */
  lookback: number;
}

export const BLINK_GUARD_DEFAULTS: BlinkGuardOptions = { start: 0.3, open: 0.15, tail: 0.15, maxHold: 0.5, jawConfirm: 0.1, lookback: 0.12 };

export class BlinkMouthGuard {
  private hist = new Map<string, { t: number; v: number }[]>();
  private held = new Map<string, number>();
  private start = -1;
  private until = -1;
  private t = 0;
  /** True while readings are being held (diagnostics / tests). */
  holding = false;
  constructor(public o: BlinkGuardOptions = BLINK_GUARD_DEFAULTS) {}

  /** Once per camera frame, before value(): `shut` = how closed the eyes are (0 … 1, the more closed eye), `jawEx` =
   *  MediaPipe's jawOpen above its closed rest. */
  step(t: number, shut: number, jawEx: number): boolean {
    this.t = t;
    if (shut >= this.o.start) {
      if (this.start < 0) {
        this.start = t;
        // freeze each channel at its lowest value of the moment just before the blink
        for (const [k, h] of this.hist) { let m = Infinity; for (const x of h) if (x.t >= t - this.o.lookback) m = Math.min(m, x.v); if (m < Infinity) this.held.set(k, m); }
      }
      this.until = t + this.o.tail;
    } else if (this.start >= 0 && shut < this.o.open && t > this.until) this.start = -1;
    this.holding = this.start >= 0 && t <= this.until && t - this.start <= this.o.maxHold && jawEx < this.o.jawConfirm;
    return this.holding;
  }

  /** An opening channel (bigger = more open) through the guard. */
  value(name: string, v: number): number {
    if (!Number.isFinite(v)) return v;
    if (this.start < 0) {
      const h = this.hist.get(name) ?? [];
      h.push({ t: this.t, v });
      while (h.length > 1 && h[0].t < this.t - this.o.lookback - 0.05) h.shift();
      if (h.length > 32) h.shift();
      this.hist.set(name, h);
      return v;
    }
    if (!this.holding) return v;
    const held = this.held.get(name);
    return held === undefined ? v : Math.min(v, held);
  }

  reset() { this.hist.clear(); this.held.clear(); this.start = -1; this.until = -1; this.holding = false; }
}
