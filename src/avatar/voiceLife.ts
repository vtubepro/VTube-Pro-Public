// Voice life: a believable face for performers the camera can't see — MIC-ONLY users (no webcam), or the
// moments a tracked face is lost (hand over the face, turned away). Replaces the old random idle blink/gaze.
//
// Everything is synthesised from what the frame already carries — the voice envelope (mouth.open / speak /
// gap), the voice's pitch (mouth.pitch, semitones vs the speaker's own median; absent for party guests) —
// plus time, following the statistics of real talking faces:
//   blinks     ~17/min listening, ~24/min talking (gamma-distributed intervals, ≥ 0.8 s apart); deferred off
//              stressed syllables into the next dip; ~45 % of phrase-final pauses and ~30 % of utterance starts get
//              one; big gaze shifts often carry one; 8 % doubles. Fast close (70 ms), short hold, slower open (150 ms).
//   gaze       mostly on the viewer (the camera). Speakers look away at the start of an utterance ("thinking")
//              and come back toward its end / on emphasis; idle glances + returns; fast saccades (main
//              sequence ≈ 20 ms + 2.2 ms/°), tiny micro-saccades, lids follow the eyes down, the head
//              helps on big shifts.
//   head       idle postural sway (< 1°, < 0.25 Hz — smooth, never jitter), breathing; while talking a new
//              relaxed tilt/turn per phrase, a beat nod on each pitch accent / stressed syllable, the head
//              riding the pitch a little (up with rising pitch), a tilt on a question-like final rise.
//   brows      raise on a share of pitch accents (stronger accent → likelier, larger), on final rises.
//   cheeks     a light smile / cheek lift that grows with lively (pitch-varied, energetic) speech.
//   mouth      one-sided corner while talking (the shapes / seals / timing stay the viseme engine's).
// Offsets are ADDED to the frame (camera values win where they exist) and fade in/out with a presence weight,
// so a lost face hands over smoothly and a returning face takes back control in ~150 ms (the head's jump back
// from rest to the re-found pose is eased out too, instead of snapping in one frame).
import type { SpeechMotionConfig, TrackingFrame, Vec3 } from '../../shared/types.ts';

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const ss = (e0: number, e1: number, x: number) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

/** Strength multipliers (1 = default, 0 = off). Shares the per-avatar speechMotion config keys. */
export interface VoiceLifeConfig {
  nod: number; tilt: number; turn: number; brow: number; blink: number; asymmetry: number;
  gaze: number; smile: number; sway: number;
}
export const VOICE_LIFE_DEFAULTS: VoiceLifeConfig = { nod: 1, tilt: 1, turn: 1, brow: 1, blink: 1, asymmetry: 1, gaze: 1, smile: 1, sway: 1 };

/** "Keep learning me" (tracking/learnMe.ts): the performer's own blink pace (mean seconds between blinks, quiet /
 *  talking) and motion multipliers, learned from their own tracked sessions and gated on held-out data. Applies to every
 *  VoiceLife unless an instance sets its own `personal` (the learner's simulations do). null = generic. */
export interface PersonalLife { blinkIdleS?: number; blinkTalkS?: number; mul?: Partial<Pick<VoiceLifeConfig, 'sway' | 'nod' | 'tilt' | 'turn'>> }
export const personalLife: { current: PersonalLife | null } = { current: null };

export type LifeEvent = { t: number; kind: 'blink' | 'accent' | 'brow' | 'saccade' | 'phraseEnd' | 'utterStart' | 'question'; v?: number };

/** Smooth band-limited wander: three incommensurate sines (no high frequencies — can't read as jitter). */
class Wander {
  private ph: number[]; private fr: number[];
  constructor(rand: () => number, f0: number) {
    this.fr = [f0, f0 * 1.618, f0 * 2.414];
    this.ph = this.fr.map(() => rand() * Math.PI * 2);
  }
  at(t: number) { return (Math.sin(this.ph[0] + t * this.fr[0] * 2 * Math.PI) * 0.6 + Math.sin(this.ph[1] + t * this.fr[1] * 2 * Math.PI) * 0.3 + Math.sin(this.ph[2] + t * this.fr[2] * 2 * Math.PI) * 0.1); }
}

export class VoiceLife {
  cfg: VoiceLifeConfig;
  /** presence 0..1: 1 while the face is untracked, 0 while the camera has it */
  weight = 0;
  /** optional event log (tests / tools); null = off */
  log: LifeEvent[] | null = null;
  /** last synthesised offsets (debug) */
  /** per-instance personal settings (overrides personalLife.current) */
  personal: PersonalLife | null = null;
  last = { yaw: 0, pitch: 0, roll: 0, gx: 0, gy: 0, blink: 0, brow: 0, smile: 0, talk: 0 };

  private t = 0;
  // speech envelopes
  private fast = 0; private slow = 0; private talk = 0; private talkOn = false; private below = 0;
  private quiet = 9; private utterRun = 0; private lastStress = -9;
  // pitch
  private pS = 0; private pB = 0; private pValid = 0; private pPeak = -99; private pRising = false; private pHist: { t: number; p: number }[] = [];
  private pRange = 0; private lively = 0;
  // blinks
  private nextBlink: number; private blinkStart = -9; private blinkAmp = 1; private pendingDouble = -1; private lastBlink = -9;
  // gaze
  private g = [0, 0]; private gFrom = [0, 0]; private gTo = [0, 0]; private sacT0 = -9; private sacDur = 0.04;
  private fixUntil = 0; private averted = false; private micro = [0, 0]; private nextMicro = 0;
  // head
  private swayY: Wander; private swayP: Wander; private swayR: Wander;
  private pose = [0, 0]; private poseTo = [0, 0];      // conversational tilt (roll) / turn (yaw) per phrase
  private nodP = 0; private nodV = 0; private nodOut = 0; private headG = [0, 0]; private pitchHead = 0; private inhale = 0;
  private questionT = -9; private questionSide = 1;
  // brows / smile / asymmetry
  private brow = 0; private browTo = 0; private browHold = 0; private side = 1; private nAcc = 0; private smile = 0;
  private loudNow = false;
  // hand-over: the head's jump when the camera finds the face again (it was eased to rest while lost) fades out
  private lastHead: Vec3 | null = null; private wasTracked: boolean | null = null; private jump: Vec3 = [0, 0, 0];

  constructor(cfg: Partial<VoiceLifeConfig> | SpeechMotionConfig | undefined = undefined, private rand: () => number = Math.random) {
    this.cfg = { ...VOICE_LIFE_DEFAULTS, ...stripUndef(cfg) };
    this.swayY = new Wander(rand, 0.071); this.swayP = new Wander(rand, 0.053); this.swayR = new Wander(rand, 0.062);
    this.nextBlink = 1 + rand() * 2;
    this.fixUntil = 0.5 + rand();
  }

  /** gamma(k=3)-distributed interval with the given mean (s), floored at 0.8 s. */
  private interval(mean: number) {
    const r = this.rand;
    const x = -Math.log((1 - r()) * (1 - r()) * (1 - r()) + 1e-9) / 3;
    return Math.max(0.8, mean * x);
  }
  private ev(kind: LifeEvent['kind'], v?: number) { this.log?.push({ t: this.t, kind, v }); }

  private startBlink(amp = 1) {
    if (this.t - this.blinkStart < 0.35) return false;
    this.blinkStart = this.t; this.blinkAmp = amp; this.lastBlink = this.t;
    if (this.rand() < 0.08) this.pendingDouble = this.t + 0.28;
    const P = this.personal ?? personalLife.current;
    this.nextBlink = this.t + this.interval(this.talk > 0.5 ? P?.blinkTalkS ?? 3.2 : P?.blinkIdleS ?? 3.5);
    this.ev('blink', amp);
    return true;
  }
  /** blink lid curve: 70 ms close (ease-in), 30 ms hold, 150 ms open (ease-out) */
  private blinkLid() {
    const u = this.t - this.blinkStart;
    if (u < 0 || u > 0.25) return 0;
    if (u < 0.07) { const x = u / 0.07; return x * x * this.blinkAmp; }
    if (u < 0.1) return this.blinkAmp;
    const x = (u - 0.1) / 0.15; return (1 - x) * (1 - x) * (1 - 0.5 * x) * this.blinkAmp / 1;
  }

  private saccade(to: [number, number]) {
    const d = Math.hypot(to[0] - this.g[0], to[1] - this.g[1]);
    if (d < 0.004) return;
    this.gFrom = [this.g[0], this.g[1]]; this.gTo = to; this.sacT0 = this.t;
    const deg = d * 20;                                   // ≈ 20° per gaze unit (VRM lookAt range)
    this.sacDur = (20 + 2.2 * deg) / 1000;
    // gaze-evoked blinks: likelier the bigger the shift (near-certain past ~25°, i.e. > 1.2 units)
    if (d > 0.3) { this.ev('saccade', d); if (!this.loudNow && this.rand() < 0.5 * ss(0.3, 1.2, d) * this.cfg.blink) this.startBlink(); }
  }
  private pickFixation(talking: boolean) {
    const r = this.rand, g = this.cfg.gaze;
    // at the viewer most of the time; glances away are brief
    const away = talking ? r() < 0.25 : r() < 0.22;
    if (away && g > 0) {
      const sx = r() < 0.5 ? -1 : 1;
      this.saccade([sx * (0.18 + r() * 0.3) * g, (talking ? -0.1 - r() * 0.2 : (r() - 0.35) * 0.3) * g]);
      this.averted = true;
      this.fixUntil = this.t + 0.4 + r() * 0.9;
    } else {
      this.saccade([(r() - 0.5) * 0.08 * g, (r() - 0.5) * 0.05 * g]);
      this.averted = false;
      this.fixUntil = this.t + Math.exp(Math.log(0.7) + (r() - 0.5) * 1.1) + 0.25; // log-normal-ish, median ≈ 0.95 s
    }
  }

  apply(f: TrackingFrame, dt: number): TrackingFrame {
    dt = Math.min(0.1, Math.max(1e-3, dt));
    this.t += dt;
    if (this.wasTracked !== null && this.wasTracked !== f.tracked && this.lastHead) {
      // a tracked ↔ untracked switch: carry the displayed head over and ease the difference out (~120 ms)
      this.jump = [this.lastHead[0] - f.head[0], this.lastHead[1] - f.head[1], this.lastHead[2] - f.head[2]];
    }
    this.wasTracked = f.tracked;
    const jk = Math.exp(-dt / 0.12);
    this.jump = [this.jump[0] * jk, this.jump[1] * jk, this.jump[2] * jk];
    // (tracking-loss layer: hold / rest keep voice life out; voice-life mode fades it in with the loss transition)
    // (a tracked face whose results come sparse / late — stallLife.ts `starve` — gets the life too, whatever the tracking-
    //  loss mode: it is late, not lost; so it never looks like a statue)
    const target = f.tracked ? Math.max(0, Math.min(1, f.starve ?? 0)) : Math.max(0, Math.min(1, f.lifeGain ?? 1));
    this.weight += (target - this.weight) * (1 - Math.exp(-dt / (f.tracked ? 0.15 : 0.35)));
    const w = this.weight;
    const P = this.personal ?? personalLife.current, pm = P?.mul;
    const c = pm ? { ...this.cfg, sway: this.cfg.sway * (pm.sway ?? 1), nod: this.cfg.nod * (pm.nod ?? 1), tilt: this.cfg.tilt * (pm.tilt ?? 1), turn: this.cfg.turn * (pm.turn ?? 1) } : this.cfg;

    // ---- speech envelopes (what the voice is doing) ----
    const m = f.mouth;
    const speak = clamp01(m.speak ?? 0);
    const e = clamp01(m.open) * (0.3 + 0.7 * speak);
    this.fast += (e - this.fast) * (1 - Math.exp(-dt * 25));
    this.slow += (e - this.slow) * (1 - Math.exp(-dt * 3));
    // talking with hysteresis: on at 0.2, off after 150 ms under 0.1 (stop gaps don't end a phrase)
    if (speak > 0.2) { this.below = 0; if (!this.talkOn) { if (this.quiet > 0.8) { this.ev('utterStart'); this.onUtterStart(); } this.talkOn = true; } }
    else if (speak < 0.1) this.below += dt;
    if (this.talkOn && this.below > 0.15) this.talkOn = false;
    this.talk += ((this.talkOn ? 1 : 0) - this.talk) * (1 - Math.exp(-dt * (this.talkOn ? 6 : 1.5)));
    const wasQuiet = this.quiet;
    this.quiet = speak < 0.08 ? this.quiet + dt : 0;
    if (this.talkOn || this.quiet < 0.18) this.utterRun += dt;
    // phrase end: the pause has lasted 180 ms after ≥ 0.6 s of talking
    if (wasQuiet < 0.18 && this.quiet >= 0.18) {
      if (this.utterRun > 0.6) this.onPhraseEnd();
      this.utterRun = 0;
    }

    // ---- pitch (semitones vs the speaker median; only when voiced) ----
    const pv = typeof m.pitch === 'number' && Number.isFinite(m.pitch) && speak > 0.15 ? clamp(m.pitch, -12, 12) : null;
    let accent = 0;
    if (pv !== null) {
      this.pValid++;
      if (this.pValid === 1) { this.pS = pv; if (this.pB === 0) this.pB = pv; }
      this.pS += (pv - this.pS) * (1 - Math.exp(-dt / 0.05));
      this.pB += (this.pS - this.pB) * (1 - Math.exp(-dt / 1.2));
      this.pHist.push({ t: this.t, p: this.pS });
      // pitch accent: a local pitch PEAK clearly above the phrase baseline on a loud-enough syllable
      const rel = this.pS - this.pB;
      if (this.pValid >= 4) {
        if (rel > this.pPeak) { this.pPeak = rel; this.pRising = true; }
        else if (this.pRising && rel < this.pPeak - 0.6) {
          if (this.pPeak > 1.8 && this.fast > 0.2) accent = Math.max(accent, clamp01((this.pPeak - 1) / 5));
          this.pRising = false; this.pPeak = rel;
        } else if (!this.pRising) this.pPeak = Math.min(this.pPeak, rel);
      }
    } else { this.pValid = 0; this.pRising = false; this.pPeak = -99; }
    while (this.pHist.length && this.pHist[0].t < this.t - 2) this.pHist.shift();
    if (this.pHist.length > 8) {
      let lo = 99, hi = -99; for (const h of this.pHist) { lo = Math.min(lo, h.p); hi = Math.max(hi, h.p); }
      this.pRange += (hi - lo - this.pRange) * (1 - Math.exp(-dt / 0.8));
    } else this.pRange *= Math.exp(-dt / 2);
    // energy stress (works without pitch — party guests, whispers): the syllable jumps above the phrase level
    const rise = this.fast - this.slow;
    const eTh = this.pHist.length > 8 ? 0.22 : 0.16;        // with pitch available, energy alone must be clearer
    if (rise > eTh && this.fast > 0.3) accent = Math.max(accent, Math.min(1, rise * 2.4));
    if (accent > 0.05 && this.t - this.lastStress > 0.45) { this.lastStress = this.t; this.onAccent(accent); }

    this.loudNow = this.talkOn && this.fast > 0.3 && this.fast > this.slow;
    // liveliness: pitch-varied, energetic talking (→ cheeks / smile)
    const liveT = this.talk * clamp01(0.35 * ss(1, 6, this.pRange) + 0.65 * ss(0.15, 0.55, this.slow) * (pv !== null || this.pRange > 0 ? 0.7 : 1));
    this.lively += (liveT - this.lively) * (1 - Math.exp(-dt / 0.9));

    // ---- blinks ----
    if (c.blink > 0) {
      if (this.pendingDouble > 0 && this.t >= this.pendingDouble) { this.pendingDouble = -1; this.blinkStart = -9; this.startBlink(0.9); }
      if (this.t >= this.nextBlink) {
        // don't blink ON a stressed / loud syllable: defer (≤ 0.6 s) into the next dip
        if (!this.loudNow || this.t > this.nextBlink + 0.6) this.startBlink(this.rand() < 0.1 ? 0.65 : 1);
      }
    }
    let lid = this.blinkLid() * c.blink;

    // ---- gaze ----
    if (this.t >= this.fixUntil) this.pickFixation(this.talkOn);
    let gx: number, gy: number;
    {
      const u = clamp01((this.t - this.sacT0) / this.sacDur);
      const k = u * u * u * (u * (u * 6 - 15) + 10);       // minimum-jerk-like profile
      this.g = [this.gFrom[0] + (this.gTo[0] - this.gFrom[0]) * k, this.gFrom[1] + (this.gTo[1] - this.gFrom[1]) * k];
      // micro-saccades during fixations (~1/s, ≈ 0.2°)
      if (this.t >= this.nextMicro) { this.nextMicro = this.t + 0.5 + this.rand() * 1.1; this.micro = [(this.rand() - 0.5) * 0.012 * c.gaze, (this.rand() - 0.5) * 0.008 * c.gaze]; }
      gx = this.g[0] + this.micro[0]; gy = this.g[1] + this.micro[1];
    }
    // the head helps on big shifts (≈ 25 % of the eccentricity, slower), the eyes keep the target (VOR)
    const hk = 1 - Math.exp(-dt / 0.2);
    const ecc = (x: number) => Math.sign(x) * Math.max(0, Math.abs(x) - 0.15); // small shifts are eyes only
    this.headG[0] += (ecc(this.gTo[0]) * 0.3 - this.headG[0]) * hk;
    this.headG[1] += (ecc(this.gTo[1]) * 0.25 - this.headG[1]) * hk;
    gx -= this.headG[0] * 0.5; gy -= this.headG[1] * 0.5;
    // upper lids follow the eyes down
    lid = Math.max(lid, 0.28 * ss(0.05, 0.35, gy) * c.gaze);

    // ---- head ----
    // nod spring (~1 Hz, well damped: dips to its peak in ~150 ms, back in ~0.6 s) + a 40 ms output ease so
    // the beat has no kink; beats come from onAccent
    const kk = 40, d = 10;
    this.nodV += (-kk * this.nodP - d * this.nodV) * dt;
    this.nodP += this.nodV * dt;
    this.nodOut += (this.nodP - this.nodOut) * (1 - Math.exp(-dt / 0.04));
    // conversational pose eases to this phrase's tilt / turn while talking, relaxes when silent
    const pk = 1 - Math.exp(-dt / 0.7);
    const talkPose = 0.35 + 0.65 * this.talk;
    this.pose[0] += (this.poseTo[0] * talkPose - this.pose[0]) * pk;
    this.pose[1] += (this.poseTo[1] * talkPose - this.pose[1]) * pk;
    // the head rides the pitch a little (≈ 0.25° per semitone, up with rising pitch)
    const pt = pv !== null ? clamp(this.pS - this.pB, -6, 6) : 0;
    this.pitchHead += (pt - this.pitchHead) * (1 - Math.exp(-dt / 0.15));
    this.inhale *= Math.exp(-dt / 0.45);
    const q = this.t - this.questionT < 1.4 ? Math.sin(Math.PI * clamp01((this.t - this.questionT) / 1.4)) : 0;
    const sw = c.sway * (1 - 0.4 * this.talk);
    const breath = Math.sin(this.t * 2 * Math.PI * 0.23) * 0.0035 * c.sway * (1 - this.talk);
    const yaw = sw * 0.009 * this.swayY.at(this.t) + c.turn * this.pose[1] + this.headG[0] * 0.35 * c.gaze;
    const pitch = sw * 0.006 * this.swayP.at(this.t) + breath + c.nod * (0.7 * this.nodOut - 0.006 * this.pitchHead) - 0.012 * this.inhale + this.headG[1] * 0.25 * c.gaze;
    const roll = sw * 0.005 * this.swayR.at(this.t) + c.tilt * (this.pose[0] + 0.05 * q * this.questionSide);

    // ---- brows ----
    this.browHold -= dt;
    const bT = this.browHold > 0 ? this.browTo : 0;
    this.brow += (bT - this.brow) * (1 - Math.exp(-dt / (bT > this.brow ? 0.07 : 0.28)));
    const browBase = this.talk * 0.05 * clamp01(this.slow * 2) + 0.02 * clamp(this.pitchHead, 0, 4) * this.talk;
    const brow = c.brow * Math.max(this.brow, browBase, q * 0.4);

    // ---- cheeks / smile / asymmetry ----
    this.smile += (c.smile * (0.02 + 0.13 * this.lively) - this.smile) * (1 - Math.exp(-dt / 0.6));
    const asym = c.asymmetry * this.talk * clamp01(this.fast * 1.5);

    // ---- compose (offsets fade with presence; the camera's own values win where larger) ----
    this.last = { yaw, pitch, roll, gx, gy, blink: lid, brow, smile: this.smile, talk: this.talk };
    const jumpOn = Math.abs(this.jump[0]) + Math.abs(this.jump[1]) + Math.abs(this.jump[2]) > 1e-4;
    if (w < 0.005 && !jumpOn) { this.lastHead = f.head; return f; }
    if (w < 0.005) {
      const hj: Vec3 = [f.head[0] + this.jump[0], f.head[1] + this.jump[1], f.head[2] + this.jump[2]];
      this.lastHead = hj;
      return { ...f, head: hj };
    }
    const face = { ...f.face };
    const up = (k2: string, v: number) => { face[k2] = clamp01(Math.max(face[k2] ?? 0, v * w)); };
    const add = (k2: string, v: number) => { face[k2] = clamp01((face[k2] ?? 0) + v * w); };
    // blinks: one owner at full depth (stallLife.ts BLINK_OWNER_W). A starved tracked face from 0.5 on: the life's lid
    // whole (the camera's were dropped); below it the camera blinks and the life adds none. Untracked: as before (× w).
    const lifeEyes = (f.starve ?? 0) >= 0.5;
    const blink = (k2: string) => { face[k2] = clamp01(Math.max(face[k2] ?? 0, f.tracked ? (lifeEyes ? lid : 0) : lid * w)); };
    blink('eyeBlinkLeft'); blink('eyeBlinkRight');
    // emphasis brows lead with the OUTER brow (inner-only raises read as worry / sadness to the emotion layer)
    up('browInnerUp', brow * 0.55); up('browOuterUpLeft', brow * (this.side > 0 ? 1 : 0.85)); up('browOuterUpRight', brow * (this.side > 0 ? 0.85 : 1));
    up('mouthSmileLeft', this.smile); up('mouthSmileRight', this.smile * 0.9);
    up('cheekSquintLeft', this.smile * 0.5); up('cheekSquintRight', this.smile * 0.45);
    up('eyeSquintLeft', this.smile * 0.25); up('eyeSquintRight', this.smile * 0.25);
    const s = this.side > 0 ? 'Left' : 'Right';
    add('mouthStretch' + s, asym * 0.15); add('mouthSmile' + s, asym * 0.06); add('mouthUpperUp' + s, asym * 0.1);
    const head: Vec3 = [f.head[0] + yaw * w + this.jump[0], f.head[1] + pitch * w + this.jump[1], f.head[2] + roll * w + this.jump[2]];
    this.lastHead = head;
    const gaze: [number, number] = [f.gaze[0] * (1 - w) + gx * w, f.gaze[1] * (1 - w) + gy * w];
    const headPos: Vec3 = [f.headPos[0], f.headPos[1] + 0.002 * this.inhale * w, f.headPos[2]];
    // (the mouth itself is left to the viseme engine: its silence gate already keeps it shut — measured: a
    //  closing guard here also clipped breathy vowel onsets)
    let mouth = f.mouth;
    mouth = { ...mouth, smile: Math.max(mouth.smile, this.smile * w) };
    return { ...f, face, head, headPos, gaze, mouth };
  }

  private onUtterStart() {
    const r = this.rand;
    if (this.cfg.blink > 0 && this.t - this.lastBlink > 1 && r() < 0.2) this.startBlink();
    // speakers often look away as they start ("planning"), then come back
    if (this.cfg.gaze > 0 && r() < 0.55) {
      const sx = r() < 0.5 ? -1 : 1;
      this.saccade([sx * (0.22 + r() * 0.25) * this.cfg.gaze, (-0.08 - r() * 0.18) * this.cfg.gaze]);
      this.averted = true; this.fixUntil = this.t + 0.5 + r() * 0.8;
    }
    this.newPose();
  }
  private onPhraseEnd() {
    this.ev('phraseEnd');
    const r = this.rand;
    if (this.cfg.blink > 0 && this.t - this.lastBlink > 1.2 && r() < 0.45) this.startBlink();
    // look back at the viewer at the end of a phrase
    if (this.averted) { this.saccade([(r() - 0.5) * 0.06, (r() - 0.5) * 0.04]); this.averted = false; this.fixUntil = this.t + 0.8 + r(); }
    // question-like final rise: pitch climbed over the last ~350 ms and ends above the baseline
    const h = this.pHist.filter((x) => x.t > this.t - 0.6);
    if (h.length > 6) {
      const n = Math.max(1, Math.floor(h.length / 3));
      const a = h.slice(0, n).reduce((s, x) => s + x.p, 0) / n, b = h.slice(-n).reduce((s, x) => s + x.p, 0) / n;
      if (b - a > 2.5 && b - this.pB > 1.5) { this.questionT = this.t; this.questionSide = r() < 0.5 ? -1 : 1; this.ev('question', b - a); }
    }
    if (this.utterRun > 1.5) this.inhale = 1;               // breath at the pause after a long phrase
    this.newPose();
  }
  private onAccent(s: number) {
    this.ev('accent', s);
    this.nodV += 1.0 * s;                                   // the beat: head dips on the accent (≈ 2.3° at s = 1), springs back
    if (++this.nAcc % 3 === 0) this.side = -this.side;
    if (s > 0.25 && this.rand() < 0.15 + 0.3 * s) { this.browTo = 0.18 + 0.25 * s; this.browHold = 0.18 + 0.25 * s; this.ev('brow', this.browTo); }
    if (this.averted && this.rand() < 0.4) { this.saccade([(this.rand() - 0.5) * 0.06, 0]); this.averted = false; this.fixUntil = this.t + 0.7 + this.rand(); }
  }
  private newPose() {
    const r = this.rand;
    this.poseTo = [(r() - 0.5) * 0.09, (r() - 0.5) * 0.08];  // roll ±2.6°, yaw ±2.3°
  }
}

function stripUndef(o: object | undefined): Partial<VoiceLifeConfig> {
  const out: Record<string, number> = {};
  if (!o) return out;
  for (const [k, v] of Object.entries(o)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  return out as Partial<VoiceLifeConfig>;
}
