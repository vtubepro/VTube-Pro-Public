// Hands / Body switches, studio side (shared/trackParts.ts has the rules and the words):
//   • this browser's saved choice (localStorage vtp.trackParts; every access in try/catch, storage may be off);
//   • composeParts: what the retargeter gets for the switches. A switched-off part keeps the pose that was on screen
//     and eases its confidence to 0 over TRACK_PART_FADE_S, so the arms / hands glide into the retargeter's relaxed rest
//     pose (arms hanging slightly out and forward, fingers loosely curled): never frozen mid-gesture, never a T-pose.
import { TRACK_PARTS_KEY, TRACK_PART_FADE_S, parseTrackParts, serializeTrackParts, type TrackPart, type TrackParts } from '../../shared/trackParts.ts';
import type { ArmTarget, BodyTargets, HandTarget, Side } from './bodySolver.ts';

type Store = Pick<Storage, 'getItem' | 'setItem'> | null | undefined;
const store = (): Store => { try { return globalThis.localStorage; } catch { return null; } };

/** This browser's choice (parts never chosen here stay undefined). */
export function loadTrackParts(s: Store = store()): Partial<TrackParts> {
  try { return parseTrackParts(s?.getItem(TRACK_PARTS_KEY) ?? null); } catch { return {}; }
}
/** Remember the choice in this browser. False when storage is off (the choice then lasts until the page reloads). */
export function saveTrackParts(p: TrackParts, s: Store = store()): boolean {
  try { if (!s) return false; s.setItem(TRACK_PARTS_KEY, serializeTrackParts(p)); return true; } catch { return false; }
}

const SIDES: Side[] = ['left', 'right'];
const scaleArm = (a: ArmTarget | null, w: number): ArmTarget | null => (a ? { ...a, confidence: a.confidence * w, lowerConfidence: (a.lowerConfidence ?? a.confidence) * w } : null);
const scaleHand = (h: HandTarget | null, w: number): HandTarget | null => (h ? { ...h, confidence: h.confidence * w } : null);

/** Per part: 1 = shown, falling to 0 while a switched-off part eases to rest; the pose it eases from. */
export class PartFade {
  w: Record<TrackPart, number> = { hands: 1, body: 1 };
  private from: Record<TrackPart, BodyTargets | null> = { hands: null, body: null };
  /** What the retargeter got last frame (the pose a part eases from when it is switched off). */
  private shown: BodyTargets | null = null;

  /** A switch flipped: off → start easing from what is on screen now; on → show live tracking again. */
  set(part: TrackPart, on: boolean) {
    if (on) { this.w[part] = 1; this.from[part] = null; return; }
    this.from[part] = this.shown;
    if (!this.shown) this.w[part] = 0;
  }
  /** Advance the fades. */
  step(parts: TrackParts, dt: number) {
    for (const p of ['hands', 'body'] as TrackPart[]) {
      if (parts[p]) { this.w[p] = 1; this.from[p] = null; continue; }
      this.w[p] = Math.max(0, this.w[p] - dt / TRACK_PART_FADE_S);
      if (this.w[p] <= 0) this.from[p] = null;
    }
  }
  /** Still drawn (live, or easing to rest)? The retargeter only reads body / hand targets of drawn parts. */
  drawn(part: TrackPart, parts: TrackParts) { return parts[part] || (this.w[part] > 0 && !!this.from[part]); }

  /**
   * The body targets to retarget: live targets for parts that are on; for a part that is off, the pose it had when it
   * was switched off with its confidence eased toward 0 (then nothing). Gestures only while the hands are on.
   */
  compose(live: BodyTargets | null, parts: TrackParts): BodyTargets | null {
    const fb = this.from.body, fh = this.from.hands, wb = ease(this.w.body), wh = ease(this.w.hands);
    const bodySrc = parts.body ? live : fb && this.w.body > 0 ? fb : null;
    const handSrc = parts.hands ? live : fh && this.w.hands > 0 ? fh : null;
    if (!bodySrc && !handSrc) { this.shown = null; return null; }
    const out: BodyTargets = {
      torso: null, arms: { left: null, right: null }, legs: { left: null, right: null }, hands: { left: null, right: null }, gestures: { left: null, right: null },
    };
    if (bodySrc) {
      const k = parts.body ? 1 : wb;
      out.torso = bodySrc.torso ? (k >= 1 ? bodySrc.torso : { ...bodySrc.torso, confidence: bodySrc.torso.confidence * k }) : null;
      if (bodySrc.torsoEuler) out.torsoEuler = bodySrc.torsoEuler;
      for (const s of SIDES) { out.arms[s] = k >= 1 ? bodySrc.arms[s] : scaleArm(bodySrc.arms[s], k); out.legs[s] = k >= 1 ? bodySrc.legs[s] : scaleArm(bodySrc.legs[s], k); }
    }
    if (handSrc) {
      const k = parts.hands ? 1 : wh;
      for (const s of SIDES) out.hands[s] = k >= 1 ? handSrc.hands[s] : scaleHand(handSrc.hands[s], k);
      if (parts.hands) out.gestures = handSrc.gestures;
    }
    this.shown = out;
    return out;
  }
}

/** Smoothstep: no jump at the start or the end of the ease. */
function ease(u: number) { const x = Math.min(1, Math.max(0, u)); return x * x * (3 - 2 * x); }
