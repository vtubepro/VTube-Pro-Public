// Speech-driven "talking body language" (per-avatar, off unless the profile enables it):
// small head nods on stressed syllables, a slow conversational tilt / turn drift while talking, brow lifts on
// emphasis, blinks at phrase ends, and a one-sided (asymmetric) mouth corner — the things a real speaker does
// that a mouth-only lip sync misses. Driven purely by the speech envelope the viseme engine already produces
// (frame.mouth.open + frame.mouth.speak), so it works with or without the camera; with the camera the offsets
// are added on top of the performer's own head motion (kept small).
import type { SpeechMotionConfig, TrackingFrame } from '../../shared/types.ts';

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export const SPEECH_MOTION_DEFAULTS: Required<Omit<SpeechMotionConfig, 'enabled' | 'gaze' | 'smile' | 'sway' | 'voiceLife'>> = {
  nod: 1, tilt: 1, turn: 1, brow: 1, blink: 1, asymmetry: 1,
};

export class SpeechMotion {
  private fast = 0; private slow = 0; private talk = 0; private talkTime = 0; private quiet = 0;
  private nodP = 0; private nodV = 0;             // nod spring (pitch)
  private stress = 0; private lastStress = 0;
  private drift = 0; private driftT = 0; private side = 1;
  private blinkT = 0; private sinceBlink = 9;
  private t = 0;
  constructor(readonly cfg: SpeechMotionConfig) {}

  apply(f: TrackingFrame, dt: number): TrackingFrame {
    const c = { ...SPEECH_MOTION_DEFAULTS, ...this.cfg };
    dt = Math.min(0.1, Math.max(1e-3, dt));
    this.t += dt;
    const speak = clamp01(f.mouth.speak ?? 0);
    const e = clamp01(f.mouth.open) * (0.3 + 0.7 * speak);
    // envelopes: fast ≈ syllable, slow ≈ phrase level
    this.fast += (e - this.fast) * (1 - Math.exp(-dt * 25));
    this.slow += (e - this.slow) * (1 - Math.exp(-dt * 3));
    this.talk += ((speak > 0.15 ? 1 : 0) - this.talk) * (1 - Math.exp(-dt * (speak > 0.15 ? 6 : 1.5)));
    this.talkTime = speak > 0.15 ? this.talkTime + dt : 0;
    this.quiet = speak < 0.05 ? this.quiet + dt : 0;
    // stressed syllable: the syllable envelope jumps clearly above the phrase level (≥ 250 ms apart)
    const rise = this.fast - this.slow;
    if (rise > 0.16 && this.fast > 0.3 && this.t - this.lastStress > 0.25) {
      this.lastStress = this.t;
      this.stress = Math.min(1, rise * 3);
      this.nodV += 1.6 * this.stress;              // head dips on the stress (pitch down), springs back
      if (++this.nStress % 3 === 0) this.side = -this.side;
    }
    this.stress *= Math.exp(-dt * 5);
    // critically-damped-ish spring for the nod (~5 Hz, settles in ~300 ms)
    const k = 90, d = 14;
    this.nodV += (-k * this.nodP - d * this.nodV) * dt;
    this.nodP += this.nodV * dt;
    // slow conversational drift while talking (tilt + small turn), relaxes back when silent
    this.driftT += dt * (0.35 + 0.25 * this.talk);
    this.drift += ((this.talk * Math.sin(this.driftT)) - this.drift) * (1 - Math.exp(-dt * 1.5));
    const [yaw, pitch, roll] = f.head;
    const head: [number, number, number] = [
      yaw + c.turn * 0.035 * this.drift * this.side,
      pitch + c.nod * 0.6 * this.nodP,               // ~3° dip on a strong stress
      roll + c.tilt * 0.03 * (this.drift * 0.8 + 0.2 * Math.sin(this.driftT * 1.7)) * this.talk,
    ];
    const face = { ...f.face };
    const up = (k2: string, v: number) => { face[k2] = clamp01(Math.max(face[k2] ?? 0, v)); };
    // brow lift on emphasis (inner + outer), a little stays up while talking
    const brow = c.brow * (this.stress * 0.45 + this.talk * 0.08 * clamp01(this.slow * 2));
    up('browInnerUp', brow); up('browOuterUpLeft', brow * 0.8); up('browOuterUpRight', brow * 0.8);
    // blink at the end of a phrase (≥ 0.8 s of talking, then a pause), rate-limited
    this.sinceBlink += dt;
    if (c.blink > 0 && this.quiet > 0.12 && this.quiet < 0.2 && this.sinceBlink > 1.2 && this.lastTalk > 0.8) { this.blinkT = 0.16; this.sinceBlink = 0; }
    if (speak > 0.15) this.lastTalk = this.talkTime; else if (this.quiet > 0.6) this.lastTalk = 0;
    if (this.blinkT > 0) {
      this.blinkT -= dt;
      const b = Math.sin(Math.PI * clamp01(1 - this.blinkT / 0.16)) * c.blink;
      up('eyeBlinkLeft', b); up('eyeBlinkRight', b);
    }
    // one-sided speech: the leading corner pulls a little more (people rarely talk symmetrically)
    const asym = c.asymmetry * this.talk * clamp01(this.fast * 1.5);
    const s = this.side > 0 ? 'Left' : 'Right';
    face['mouthStretch' + s] = clamp01((face['mouthStretch' + s] ?? 0) + asym * 0.18);
    face['mouthSmile' + s] = clamp01((face['mouthSmile' + s] ?? 0) + asym * 0.08);
    face['mouthUpperUp' + s] = clamp01((face['mouthUpperUp' + s] ?? 0) + asym * 0.12);
    this.last = { yaw: head[0] - yaw, pitch: head[1] - pitch, roll: head[2] - roll, brow, asym };
    return { ...f, head, face };
  }
  /** last offsets (radians / 0..1), for debugging and tests */
  last = { yaw: 0, pitch: 0, roll: 0, brow: 0, asym: 0 };
  private lastTalk = 0;
  private nStress = 0;
}
