// A face whose results come SPARSELY (a game holding the graphics card: 0-4 face results a second while the studio keeps
// publishing ~60 frames a second of the last solved pose) must never look like a statue on stream, and must not snap
// when a late result lands. The RCA (research/tracking_gpu_rca/RCA.md §4 P1) measured why it did: the last frame was
// treated as live (trackLoss phase 'live', voice life weight 0), and the head filters read a 0.9 s gap as 0.2 s, so the
// lead / extrapolation threw the head 36° RMS off with steps up to 147° a frame.
//
// StarveMeter: `w` 0..1, how starved the face is (frame.starve). Stepped on every studio tick:
//   iv     EMA (α 0.35) of the spacing between face results, each spacing clamped to 2 s
//   gap    time since the newest result (s)
//   target max(ss(0.15, 0.40, gap), ss(0.09, 0.25, max(iv, gap)))       (ss = smoothstep)
//   w      rises with τ 0.2 s, falls with τ 0.35 s whenever target < w (a release keyed on the spacing alone latched
//          at <= 15 results a second: research verify_stall_behaviour.md)
// What w does (src/app.ts): the head lead and the render-rate extrapolation scale by (1 - w); the head eases toward the
// measurements through a critically damped follower (τ = clamp(0.35·iv, 0.06, 0.25) s) blended in by w; the mouth goes
// to the mic (camera mouth visibility × (1 - w)); blinks / eye looks fade to the face life, the expression channels
// relax toward 40 % of their held value, the expression presets fade; voice life / idle life act by w whatever the
// tracking-loss mode ("Hold" means a lost face, not a late one). Normal tracking (results 16-70 ms apart) gives w = 0
// and passes through untouched. Pure (tools/gamefps_unit.ts).
import type { TrackingFrame, Vec3 } from '../../shared/types.ts';

const ss = (e0: number, e1: number, x: number) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

export class StarveMeter {
  /** 0..1: how starved the face is right now. */
  w = 0;
  /** EMA of the spacing between face results (s). */
  iv = 0;
  /** A slower copy of w (τ 1 s): how far the held expression channels have relaxed. */
  w1 = 0;
  private lastSample = -1;
  private lastNow = -1;
  /** Face results seen since tracking became active (the value found at activation is not one of them). */
  private seen = 0;

  /** `sampleAt` = when the newest face result arrived (ms; a change = a new one; 0 = none yet), `now` (ms), `active` =
   *  webcam tracking runs (phone / VMC sources, tracking off: 0). Returns w. Nothing is judged until two results arrived
   *  while active (review round 1, G1: the app's first stamp is 0, so the page's age read as a 1-2 s gap and a healthy
   *  camera start began starved — mouth to the mic, expressions relaxed — for about a second). */
  step(sampleAt: number, now: number, active: boolean): number {
    const dt = this.lastNow >= 0 ? Math.min(0.25, Math.max(0, (now - this.lastNow) / 1000)) : 0;
    this.lastNow = now;
    if (!active) { this.w = 0; this.w1 = 0; this.iv = 0; this.lastSample = -1; this.seen = 0; return 0; }
    if (this.lastSample < 0) this.lastSample = Math.max(0, sampleAt);   // (what was there before this run: not counted)
    else if (sampleAt > 0 && sampleAt !== this.lastSample) {
      if (this.seen >= 1 && sampleAt > this.lastSample) {
        const sp = Math.min(2, (sampleAt - this.lastSample) / 1000);
        this.iv = this.iv > 0 ? this.iv + 0.35 * (sp - this.iv) : sp;
      }
      this.seen++;
      this.lastSample = sampleAt;
    }
    if (this.seen < 2) { this.w = 0; this.w1 = 0; return 0; }
    const gap = Math.max(0, (now - sampleAt) / 1000);
    const target = Math.max(ss(0.15, 0.40, gap), ss(0.09, 0.25, Math.max(this.iv, gap)));
    if (dt > 0) {
      this.w += (target - this.w) * (1 - Math.exp(-dt / (target > this.w ? 0.2 : 0.35)));
      this.w1 += (this.w - this.w1) * (1 - Math.exp(-dt / 1));
    }
    if (this.w < 0.005 && target === 0) this.w = 0;
    if (this.w1 < 0.005 && this.w === 0) this.w1 = 0;
    return this.w;
  }

  reset() { this.w = 0; this.w1 = 0; this.iv = 0; this.lastSample = -1; this.lastNow = -1; this.seen = 0; }
}

/** Critically damped follower of the head (angles + position), blended in by w: sparse, late measurements become a
 *  smooth glide instead of a jump; re-seeded on the live pose while w = 0. */
export class HeadFollower {
  private h: Vec3 = [0, 0, 0]; private hv: Vec3 = [0, 0, 0];
  private p: Vec3 = [0, 0, 0]; private pv: Vec3 = [0, 0, 0];
  private seeded = false;

  step(head: Vec3, pos: Vec3, w: number, iv: number, dt: number): { head: Vec3; pos: Vec3 } {
    if (w <= 0 || !this.seeded) {
      this.h = [...head]; this.p = [...pos]; this.hv = [0, 0, 0]; this.pv = [0, 0, 0]; this.seeded = true;
      if (w <= 0) return { head, pos };
    }
    const tau = Math.min(0.25, Math.max(0.06, 0.35 * iv));
    const om = 2 / tau;
    // (sub-steps: stable at any tick length)
    let left = Math.min(0.25, Math.max(0, dt));
    while (left > 1e-6) {
      const s = Math.min(left, 1 / 120);
      left -= s;
      for (let i = 0; i < 3; i++) {
        this.hv[i] += (om * om * (head[i] - this.h[i]) - 2 * om * this.hv[i]) * s; this.h[i] += this.hv[i] * s;
        this.pv[i] += (om * om * (pos[i] - this.p[i]) - 2 * om * this.pv[i]) * s; this.p[i] += this.pv[i] * s;
      }
    }
    const mix = (a: Vec3, b: Vec3): Vec3 => [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
    return { head: mix(head, this.h), pos: mix(pos, this.p) };
  }

  reset() { this.seeded = false; }
}

const BLINK = /^eyeBlink/;
const LOOK = /^eyeLook/;
const RELAX = /^(brow|cheek|eyeSquint|mouthSmile|mouthFrown)/;
/** Who closes the eyes: the camera below this starve weight, the face life (voiceLife.ts) from it, each at full depth (a
 *  crossfade of depths left both half-shut in the middle band: neither closed the eyes — review round 1). */
export const BLINK_OWNER_W = 0.5;

/** The face channels of a starved frame: blinks go to the face life from BLINK_OWNER_W (the camera's are dropped there,
 *  kept whole below it), eye looks fade out (the face life looks instead), brows, cheeks, squints, smiles and frowns relax
 *  toward 40 % of their held value as `w1` grows. `w` = the meter's w. */
export function starveFace(face: Record<string, number>, w: number, w1: number): Record<string, number> {
  if (w <= 0 && w1 <= 0) return face;
  const out: Record<string, number> = { ...face };
  const relax = 1 - 0.6 * Math.min(1, w1);
  for (const k in out) {
    if (BLINK.test(k)) { if (w >= BLINK_OWNER_W) out[k] = 0; }
    else if (LOOK.test(k)) out[k] *= 1 - w;
    else if (RELAX.test(k)) out[k] *= relax;
  }
  return out;
}

/** Publish the meter on the frame (rounded; absent while 0). */
export function withStarve(f: TrackingFrame, w: number): TrackingFrame {
  return w > 0.005 ? { ...f, starve: Math.round(w * 100) / 100 } : f;
}
