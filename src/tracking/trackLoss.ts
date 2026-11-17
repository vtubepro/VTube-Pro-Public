// "When tracking is lost" (shared/trackLoss.ts settings): what the avatar does while the camera has lost the face,
// the body or a hand, and how it comes back. Runs in the studio at render rate on the solved frame + body targets, so
// the OBS page (which shows the studio's frame + retargeted bones) gets exactly the same motion.
//
// Per part, one timeline:
//   live     pass the measurement through; remember it
//   grace    missing for < graceMs: FREEZE (a dropped frame never moves anything)
//   lost     ease from what was on screen to the hold pose (last trusted pose) or the rest pose over lossS
//            (smootherstep = zero velocity and acceleration at both ends; rotations slerp in quaternion space)
//   probe    found again, but not trusted yet: `rejectFrames` frames are discarded and two consecutive frames must
//            agree (MediaPipe often returns a wrong pose for 1–2 frames after re-acquiring); still showing `lost`
//   recover  ease from what was on screen to the LIVE measurement over recoverS, then live
// Any transition starts from the displayed pose, so the output is continuous whatever happens in between.
import * as THREE from 'three';
import type { TrackingFrame, Vec3 } from '../../shared/types.ts';
import type { ArmTarget, BodyTargets, HandTarget, Side } from './bodySolver.ts';
import { effectiveMode, sanitizeTrackLoss, type TrackLossMode, type TrackLossSettings } from '../../shared/trackLoss.ts';

/** Smootherstep (C2): no velocity / acceleration jump at either end. */
export const ease = (u: number) => { const x = Math.min(1, Math.max(0, u)); return x * x * x * (x * (x * 6 - 15) + 10); };

export type Phase = 'live' | 'grace' | 'lost' | 'recover';

/** Timeline of one tracked part (see header). `consistent(prev, cur, dt)` = do two re-acquired samples agree? */
export class LossTimeline<T> {
  phase: Phase = 'live';
  /** time the current phase began (s) */
  t0 = 0;
  /** probing a re-acquire: samples seen / last sample */
  private probeN = 0; private probePrev: T | null = null; private probeT = 0; private probeLastSeen = 0;
  /** ever measured (a part never seen passes null through) */
  seen = false;
  constructor(private consistent: (a: T, b: T, dt: number) => boolean) {}

  /**
   * Advance. `obs` = the measurement this tick (null = missing), `fresh` = it is a new tracker sample (not a repeat).
   * Returns the phase and the phase progress; callers keep the snapshots (see PartMix).
   * Events: 'lost' (entered the loss blend), 'recover' (entered the recovery blend), 'grace' (froze).
   */
  step(obs: T | null, fresh: boolean, t: number, s: TrackLossSettings, iv = 0): { phase: Phase; u: number; ev: 'grace' | 'lost' | 'recover' | null } {
    this.iv = iv;
    let ev: 'grace' | 'lost' | 'recover' | null = null;
    if (obs) this.seen = true;
    switch (this.phase) {
      case 'live':
        if (obs) this.lastLive = obs;
        else if (this.seen) { this.phase = 'grace'; this.t0 = t; ev = 'grace'; this.probeN = 0; this.probePrev = null; }
        break;
      case 'grace':
        // back within the grace and agreeing with the last live pose: a short catch-up; junk → probe like a real loss
        if (obs && fresh && this.probeN === 0 && this.lastLive && this.consistent(this.lastLive, obs, Math.min(t - this.t0 + 1 / 30, 1 / 15))) { this.phase = 'recover'; this.t0 = t; ev = 'recover'; break; }
        if (obs) { if (this.probeOk(obs, fresh, t, s)) { this.phase = 'recover'; this.t0 = t; ev = 'recover'; } break; }
        if (t - this.t0 >= s.graceMs / 1000) { this.phase = 'lost'; this.t0 = t; ev = 'lost'; }
        break;
      case 'lost':
        if (obs) {
          if (this.probeOk(obs, fresh, t, s)) { this.phase = 'recover'; this.t0 = t; ev = 'recover'; }
        } else if (t - this.probeLastSeen > this.probeGap()) { this.probeN = 0; this.probePrev = null; }
        break;
      case 'recover':
        if (!obs) { this.phase = 'grace'; this.t0 = t; ev = 'grace'; this.probeN = 0; this.probePrev = null; }
        else if (t - this.t0 >= this.recoverS(s)) { this.phase = 'live'; this.lastLive = obs; }
        break;
    }
    const dur = this.phase === 'lost' ? s.lossS : this.phase === 'recover' ? this.recoverS(s) : 0;
    const u = this.phase === 'lost' || this.phase === 'recover' ? (dur <= 0 ? 1 : (t - this.t0) / dur) : 0;
    return { phase: this.phase, u: Math.min(1, u), ev };
  }
  private lastLive: T | null = null;
  /** Re-acquire probe: discard `rejectFrames`, then two consecutive fresh samples must agree (or 300 ms of steady detection). */
  /** Results this far apart on average (s: a starved tracker, src/tracking/stallLife.ts) — the probe's gap and junk-frame
   *  rules are about a NORMAL result rate: at 0.3 s or more between results the old 0.25 s gap reset the probe on every
   *  sample and a lost face never came back (research/tracking_gpu_rca/RCA.md RC3, the latent defect). */
  private iv = 0;
  private probeGap() { return Math.max(0.25, 2.5 * this.iv); }
  private probeOk(obs: T, fresh: boolean, t: number, s: TrackLossSettings): boolean {
    if (!fresh) return false;
    if (this.probeN > 0 && t - this.probeLastSeen > this.probeGap()) this.probeN = 0; // a gap: start probing afresh
    const reject = this.iv > 0.12 ? 0 : s.rejectFrames;
    const ok = this.probeN > reject && this.probePrev !== null && this.consistent(this.probePrev, obs, Math.max(1 / 120, t - this.probeT));
    if (this.probeN === 0) this.probeT0 = t;
    this.probeN++; this.probePrev = obs; this.probeT = t; this.probeLastSeen = t;
    // a genuinely fast-moving head can fail the agreement test: after 300 ms of steady detection accept anyway
    if (ok || (this.probeN > reject + 1 && t - this.probeT0 > 0.3)) { this.probeN = 0; this.probePrev = null; return true; }
    return false;
  }
  private probeT0 = 0;
  /** coming back from a mere grace freeze: a short catch-up, else the full recovery transition */
  shortRecover = false;
  private recoverS(s: TrackLossSettings) { return this.shortRecover ? Math.min(0.1, s.recoverS) : s.recoverS; }
}

/** One part's pose snapshots + the mix. `mix(a, b, w)` must be an eased-space interpolation (slerp for rotations). */
export class PartMix<T> {
  tl: LossTimeline<T>;
  /** last displayed value */
  out: T | null = null;
  /** blend start (displayed pose at the event) and the hold target */
  private from: T | null = null;
  private hold: T | null = null;
  /** recent live samples (for the trusted hold pose) */
  private hist: { t: number; v: T }[] = [];
  phase: Phase = 'live';
  /** 0..1 how far into the loss behaviour (for voice life presence) */
  lossW = 0;
  constructor(consistent: (a: T, b: T, dt: number) => boolean, private mix: (a: T, b: T, w: number) => T, private rest: (held: T) => T) {
    this.tl = new LossTimeline(consistent);
  }

  /** The pose to show. `fresh` = obs is a new tracker sample. */
  step(obs: T | null, fresh: boolean, t: number, s: TrackLossSettings, mode: TrackLossMode, iv = 0): T | null {
    const wasGrace = this.tl.phase === 'grace';
    const r = this.tl.step(obs, fresh, t, s, iv);
    this.phase = r.phase;
    if (r.ev === 'recover') { this.tl.shortRecover = wasGrace; this.from = this.out; }
    if (r.ev === 'grace') this.from = this.out;
    if (r.ev === 'lost') { this.from = this.out; this.hold = this.trusted(t) ?? this.out; }
    this.lossW = r.phase === 'lost' ? ease(r.u) : r.phase === 'recover' && this.lossW > 0 ? Math.min(this.lossW, 1 - ease(r.u)) : r.phase === 'live' ? 0 : this.lossW;
    let out: T | null;
    switch (r.phase) {
      case 'live':
        out = obs;
        if (obs && fresh) { this.hist.push({ t, v: obs }); while (this.hist.length > 12 || (this.hist.length && this.hist[0].t < t - 0.5)) this.hist.shift(); }
        break;
      case 'grace': out = this.out ?? obs; break;
      case 'lost': {
        const base = this.hold ?? this.from;
        if (!base || !this.from) { out = this.out; break; }
        const target = mode === 'hold' ? base : this.rest(base);
        out = this.mix(this.from, target, ease(r.u));
        break;
      }
      case 'recover':
        out = this.from && obs ? this.mix(this.from, obs, ease(r.u)) : obs;
        if (r.u >= 1) this.hist = [];
        break;
    }
    this.out = out;
    return out;
  }

  /** The hold pose: the live sample from ~70 ms before the loss (the last frames as the face leaves are often junk). */
  private trusted(t: number): T | null {
    if (!this.hist.length) return null;
    const last = this.hist[this.hist.length - 1];
    for (let i = this.hist.length - 1; i >= 0; i--) if (last.t - this.hist[i].t >= 0.066) return this.hist[i].v;
    return this.hist[0].v;
  }
}

// ---------------------------------------------------------------- pose types + their mixes
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _e = new THREE.Euler();
const lerp = (a: number, b: number, w: number) => a + (b - a) * w;
const RAD = 180 / Math.PI;

/** head [yaw, pitch, roll] (the retargeter's Euler(pitch, yaw, roll, 'YXZ')) → quaternion */
function headQ(h: Vec3, q: THREE.Quaternion) { return q.setFromEuler(_e.set(h[1], h[0], h[2], 'YXZ')); }
export function headSlerp(a: Vec3, b: Vec3, w: number): Vec3 {
  headQ(a, _qa); headQ(b, _qb);
  _qa.slerp(_qb, w);
  _e.setFromQuaternion(_qa, 'YXZ');
  return [_e.y, _e.x, _e.z];
}
/** angle between two head rotations, degrees */
export function headAngle(a: Vec3, b: Vec3): number { headQ(a, _qa); headQ(b, _qb); return _qa.angleTo(_qb) * RAD; }

export interface HeadPose { head: Vec3; pos: Vec3 }
const vlerp = (a: Vec3, b: Vec3, w: number): Vec3 => [lerp(a[0], b[0], w), lerp(a[1], b[1], w), lerp(a[2], b[2], w)];
export const headMix = (a: HeadPose, b: HeadPose, w: number): HeadPose => ({ head: headSlerp(a.head, b.head, w), pos: vlerp(a.pos, b.pos, w) });
/** re-acquire agreement: ≤ 8° + 240°/s between consecutive samples (faster heads are accepted after 300 ms of steady detection) */
export const headConsistent = (a: HeadPose, b: HeadPose, dt: number) => headAngle(a.head, b.head) <= 8 + 240 * dt;

type Mouth = TrackingFrame['mouth'];
export interface FacePose { face: Record<string, number>; mouth: Mouth; gaze: [number, number] }
const EYE = /^eye(Blink|Look|Squint|Wide)/;
/** Mouth channels that OPEN the mouth: relaxed while lost even in hold mode, so voice lip sync drives the mouth. */
const OPENING = /^(jawOpen|mouthLowerDown|mouthUpperUp|mouthClose|tongueOut|mouthFunnel|mouthPucker|_lipGap|_geoGap)/;
function mixRec(a: Record<string, number>, b: Record<string, number>, w: number, pick: (k: string) => boolean): Record<string, number> {
  const o: Record<string, number> = {};
  for (const k in a) if (pick(k)) o[k] = lerp(a[k], b[k] ?? 0, w);
  for (const k in b) if (pick(k) && !(k in o)) o[k] = lerp(0, b[k], w);
  return o;
}
export const faceMix = (a: FacePose, b: FacePose, w: number): FacePose => ({
  face: mixRec(a.face, b.face, w, () => true),
  mouth: { ...b.mouth, open: lerp(a.mouth.open, b.mouth.open, w), wide: lerp(a.mouth.wide, b.mouth.wide, w), smile: lerp(a.mouth.smile, b.mouth.smile, w), frown: lerp(a.mouth.frown, b.mouth.frown, w),
    pucker: lerp(a.mouth.pucker, b.mouth.pucker, w), funnel: lerp(a.mouth.funnel, b.mouth.funnel, w), tongue: lerp(a.mouth.tongue, b.mouth.tongue, w) },
  gaze: [lerp(a.gaze[0], b.gaze[0], w), lerp(a.gaze[1], b.gaze[1], w)],
});
const ZERO_MOUTH: Mouth = { open: 0, wide: 0, smile: 0, frown: 0, pucker: 0, funnel: 0, tongue: 0 };

// ---------------------------------------------------------------- body parts
const _v = new THREE.Vector3();
/** slerp between unit vectors (great-circle), never a linear snap */
export function vslerp(a: THREE.Vector3, b: THREE.Vector3, w: number): THREE.Vector3 {
  _qa.setFromUnitVectors(a, b);
  _qb.identity().slerp(_qa, w);
  return _v.copy(a).applyQuaternion(_qb).normalize().clone();
}
const vang = (a: THREE.Vector3, b: THREE.Vector3) => a.angleTo(b) * RAD;
export const armMix = (a: ArmTarget, b: ArmTarget, w: number): ArmTarget => ({
  upper: vslerp(a.upper, b.upper, w), lower: vslerp(a.lower, b.lower, w),
  confidence: lerp(a.confidence, b.confidence, w), lowerConfidence: lerp(a.lowerConfidence ?? a.confidence, b.lowerConfidence ?? b.confidence, w),
});
export const armConsistent = (a: ArmTarget, b: ArmTarget, dt: number) => Math.max(vang(a.upper, b.upper), vang(a.lower, b.lower)) <= 20 + 720 * dt;
export const handMix = (a: HandTarget, b: HandTarget, w: number): HandTarget => {
  const fwd = vslerp(a.forward, b.forward, w);
  const side = vslerp(a.side, b.side, w);
  side.addScaledVector(fwd, -side.dot(fwd)).normalize(); // keep the basis orthonormal
  const out: HandTarget = {
    forward: fwd, side, thumbDir: vslerp(a.thumbDir, b.thumbDir, w),
    curls: a.curls.map((f, i) => f.map((c, j) => lerp(c, b.curls[i]?.[j] ?? c, w))),
    spread: a.spread.map((c, i) => lerp(c, b.spread[i] ?? c, w)),
    confidence: lerp(a.confidence, b.confidence, w),
  };
  // the result interval (the retarget's hand easing) carries over; the sample time doesn't: a blend is no measurement
  const iv = b.interval ?? a.interval;
  if (iv !== undefined) out.interval = iv;
  return out;
};
export const handConsistent = (a: HandTarget, b: HandTarget, dt: number) => vang(a.forward, b.forward) <= 25 + 900 * dt;
type Torso = NonNullable<BodyTargets['torso']>;
const _m = new THREE.Matrix4();
function torsoQ(t: Torso, q: THREE.Quaternion) { _m.makeBasis(t.left, t.up, t.left.clone().cross(t.up).normalize()); return q.setFromRotationMatrix(_m); }
export const torsoMix = (a: Torso, b: Torso, w: number): Torso => {
  torsoQ(a, _qa); torsoQ(b, _qb); _qa.slerp(_qb, w);
  return { left: new THREE.Vector3(1, 0, 0).applyQuaternion(_qa), up: new THREE.Vector3(0, 1, 0).applyQuaternion(_qa), hipsVisible: w < 0.5 ? a.hipsVisible : b.hipsVisible, confidence: lerp(a.confidence, b.confidence, w) };
};
export const torsoConsistent = (a: Torso, b: Torso, dt: number) => { torsoQ(a, _qa); torsoQ(b, _qb); return _qa.angleTo(_qb) * RAD <= 10 + 240 * dt; };

/** A body / hand target the solver is only carrying over (its own short hold / fade) counts as missing. */
const liveOnly = <T extends { held?: boolean }>(x: T | null | undefined): T | null => (x && !x.held ? x : null);

// ---------------------------------------------------------------- the studio layer
export class TrackLoss {
  settings: TrackLossSettings = sanitizeTrackLoss(undefined);
  /** Mean spacing of face results (s; src/tracking/stallLife.ts StarveMeter.iv, set by the studio each tick): the
   *  re-acquire probe adapts to a starved tracker's sparse samples. */
  iv = 0;
  private head = new PartMix<HeadPose>(headConsistent, headMix, () => ({ head: [0, 0, 0], pos: [0, 0, 0] }));
  private face = new PartMix<FacePose>(() => true, faceMix, (h) => ({ face: {}, mouth: { ...h.mouth, ...ZERO_MOUTH }, gaze: h.gaze }));
  private eyes = new PartMix<FacePose>(() => true, faceMix, (h) => ({ face: {}, mouth: h.mouth, gaze: [0, 0] }));
  private torso = this.torsoPart();
  private arms: Record<Side, PartMix<ArmTarget>> = { left: this.armPart(), right: this.armPart() };
  private hands: Record<Side, PartMix<HandTarget>> = { left: this.handPart(), right: this.handPart() };
  private lastFaceAt = -1; private lastBody: BodyTargets | null = null;
  private torsoPart() { return new PartMix<Torso>(torsoConsistent, torsoMix, (h) => ({ ...h, confidence: 0 })); }
  private armPart() { return new PartMix<ArmTarget>(armConsistent, armMix, (h) => ({ ...h, confidence: 0, lowerConfidence: 0 })); }
  private handPart() { return new PartMix<HandTarget>(handConsistent, handMix, (h) => ({ ...h, confidence: 0 })); }
  /** Hands / Body switches (shared/trackParts.ts): forget a group, so it never holds, or eases back from, a pose that
   *  is no longer tracked. A part switched back on starts fresh: its first measurement shows as live. */
  resetParts(which: { body?: boolean; hands?: boolean }) {
    if (which.body) { this.torso = this.torsoPart(); this.arms = { left: this.armPart(), right: this.armPart() }; }
    if (which.hands) this.hands = { left: this.handPart(), right: this.handPart() };
  }
  /** Face-group phase (diagnostics / UI). */
  get facePhase(): Phase { return this.face.phase; }

  /**
   * The solved face frame → what to show. `headLive` = the head has a live source (face OR the body model's head
   * keypoints while the face is hidden), `sampleAt` = when the current measurement arrived (a change = fresh).
   */
  applyFace(f: TrackingFrame, headLive: boolean, sampleAt: number, t: number): TrackingFrame {
    const s = this.settings;
    const fresh = sampleAt !== this.lastFaceAt; this.lastFaceAt = sampleAt;
    const faceLive = f.tracked;
    const hp = this.head.step(headLive ? { head: f.head, pos: f.headPos } : null, fresh, t, s, effectiveMode(s, 'face'), this.iv);
    // split face channels: eyes vs the rest (mouth + brows + cheeks)
    const eyesObs = faceLive ? { face: pickKeys(f.face, (k) => EYE.test(k)), mouth: f.mouth, gaze: f.gaze } : null;
    const faceObs = faceLive ? { face: pickKeys(f.face, (k) => !EYE.test(k)), mouth: f.mouth, gaze: f.gaze } : null;
    const fm = effectiveMode(s, 'face'), em = effectiveMode(s, 'eyes');
    let fp = this.face.step(faceObs, fresh, t, s, fm, this.iv);
    let ep = this.eyes.step(eyesObs, fresh, t, s, em, this.iv);
    if (this.head.phase === 'live' && this.face.phase === 'live' && this.eyes.phase === 'live') return f; // the common case: untouched
    if (!hp && !fp && !ep) return f;
    // hold never keeps the mouth open (the voice drives it while the face is away) nor the eyes shut
    if (fp && this.face.phase !== 'live' && this.face.phase !== 'recover') fp = { ...fp, face: relax(fp.face, (k) => OPENING.test(k), this.face.lossW), mouth: { ...fp.mouth, open: fp.mouth.open * (1 - this.face.lossW), funnel: fp.mouth.funnel * (1 - this.face.lossW), pucker: fp.mouth.pucker * (1 - this.face.lossW), tongue: fp.mouth.tongue * (1 - this.face.lossW) } };
    if (ep && this.eyes.phase !== 'live' && this.eyes.phase !== 'recover') ep = { ...ep, face: capBlink(ep.face) };
    const lifeGain = Math.max(fm === 'life' ? this.face.lossW : 0, em === 'life' ? this.eyes.lossW : 0);
    const out: TrackingFrame = { ...f, lifeGain };
    if (hp) { out.head = hp.head; out.headPos = hp.pos; if (this.head.phase !== 'live') { out.headVel = undefined; out.posVel = undefined; } }
    const face = { ...f.face };
    if (fp && this.face.phase !== 'live') { for (const k in face) if (!EYE.test(k)) delete face[k]; Object.assign(face, fp.face); out.mouth = { ...f.mouth, ...pickMouth(fp.mouth) }; if (!faceLive) out.lips = undefined; }
    if (ep && this.eyes.phase !== 'live') { for (const k in face) if (EYE.test(k)) delete face[k]; Object.assign(face, ep.face); out.gaze = ep.gaze; }
    out.face = face;
    return out;
  }

  /** The part objects of the last body targets: a part is a fresh sample only when its own object changed (with
   *  pose and hands on their own clocks the solver re-issues the other stream's last targets unchanged). */
  private lastParts = new Map<string, object | null>();
  private freshPart(fresh: boolean, key: string, o: object | null | undefined) {
    if (!fresh) return false;
    const f = (o ?? null) !== (this.lastParts.get(key) ?? null);
    this.lastParts.set(key, o ?? null);
    return f;
  }

  /** Body targets → what to retarget. `t` = display time (s). */
  applyBody(b: BodyTargets | null, t: number): BodyTargets | null {
    const s = this.settings;
    const fresh = b !== this.lastBody; this.lastBody = b;
    if (!b && !this.torso.tl.seen && !this.arms.left.tl.seen && !this.hands.left.tl.seen && !this.arms.right.tl.seen && !this.hands.right.tl.seen) return b;
    const bm = effectiveMode(s, 'body'), hm = effectiveMode(s, 'hands');
    const out: BodyTargets = b ? { ...b, arms: { ...b.arms }, hands: { ...b.hands } } : { torso: null, arms: { left: null, right: null }, legs: { left: null, right: null }, hands: { left: null, right: null }, gestures: { left: null, right: null } };
    const tp = this.torso.step(b?.torso ?? null, this.freshPart(fresh, 'torso', b?.torso), t, s, bm, this.iv);
    if (tp) out.torso = tp;
    for (const side of ['left', 'right'] as Side[]) {
      const ao = liveOnly(b?.arms[side]);
      const ap = this.arms[side].step(ao, this.freshPart(fresh, `arm.${side}`, ao), t, s, bm, this.iv);
      if (ap) out.arms[side] = ap;
      const ho = liveOnly(b?.hands[side]);
      const hp = this.hands[side].step(ho, this.freshPart(fresh, `hand.${side}`, ho), t, s, hm, this.iv);
      if (hp) out.hands[side] = hp;
    }
    return out;
  }
}

function pickKeys(o: Record<string, number>, keep: (k: string) => boolean) { const r: Record<string, number> = {}; for (const k in o) if (keep(k)) r[k] = o[k]; return r; }
function relax(o: Record<string, number>, which: (k: string) => boolean, w: number) { const r = { ...o }; for (const k in r) if (which(k)) r[k] *= 1 - w; return r; }
function capBlink(o: Record<string, number>) { const r = { ...o }; for (const k of ['eyeBlinkLeft', 'eyeBlinkRight']) if (k in r) r[k] = Math.min(r[k], 0.3); return r; }
function pickMouth(m: Mouth): Partial<Mouth> { return { open: m.open, wide: m.wide, smile: m.smile, frown: m.frown, pucker: m.pucker, funnel: m.funnel, tongue: m.tongue }; }
