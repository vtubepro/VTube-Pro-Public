// Retargeting: avatar-space tracking targets → local rotations on VRM-normalized humanoid bones.
//
// three-vrm's normalized humanoid gives every bone an identity rest rotation aligned to the model
// space, whatever the source rig's bone axes are. We solve rotations as "swing the rest direction onto
// the tracked direction", so T-pose, A-pose, and odd creature rigs all work with the same code.

import * as THREE from 'three';
import type { VRMHumanoid, VRMHumanBoneName } from '@pixiv/three-vrm';
import type { ArmTarget, BodyTargets, HandTarget, Side } from '../tracking/bodySolver.ts';
import type { TrackingFrame, TrackingTuning } from '../../shared/types.ts';
import { estimateEmotions } from './expressions.ts';
import { BodyGuard } from './bodyGuard.ts';
import { relaxedArmDirs } from '../../shared/idleArm.ts';
import { armSettings } from '../../shared/armPose.ts';
import type { TorsoSurface } from './torsoSurface.ts';
import { FRONT_FOLLOW, FrontPose, GestureGate, approach, fingerIdle, frontCurl, palmDirection, type FrontSolution } from './armPose.ts';

const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'] as const;
const SEGS: Record<string, [VRMHumanBoneName | string, string, string]> = {};
for (const s of ['left', 'right']) for (const f of FINGERS) {
  SEGS[s + f] = f === 'Thumb'
    ? [`${s}ThumbMetacarpal`, `${s}ThumbProximal`, `${s}ThumbDistal`]
    : [`${s}${f}Proximal`, `${s}${f}Intermediate`, `${s}${f}Distal`];
}

const I = new THREE.Quaternion();
const _m = new THREE.Matrix4();

function swing(from: THREE.Vector3, to: THREE.Vector3) {
  return new THREE.Quaternion().setFromUnitVectors(from, to);
}

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const axisAngle = (axis: THREE.Vector3, a: number) => new THREE.Quaternion().setFromAxisAngle(axis, a);
/** Scale a rotation down so its angle is at most `max` radians. */
function limitAngle(q: THREE.Quaternion, max: number) {
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
  const ang = 2 * Math.acos(Math.min(1, q.w));
  return ang > max ? I.clone().slerp(q, max / ang) : q;
}

// Anatomical joint limits (radians): [min, max] flexion, + = curl toward the palm.
const FLEX_LIMIT: [number, number][] = [[-0.35, 1.65], [-0.05, 1.9], [-0.15, 1.4]]; // MCP, PIP, DIP
const THUMB_LIMIT: [number, number][] = [[0, 0], [-0.25, 1.05], [-0.35, 1.45]]; // (CMC is 2-DOF), MCP, IP
// MCP spread limits per finger (+ = toward the thumb side): index/little spread outward the most
const SPREAD_LIMIT: [number, number][] = [[0, 0], [-0.25, 0.4], [-0.25, 0.25], [-0.3, 0.2], [-0.5, 0.2]];
// A relaxed hand: slightly curled, more so toward the little finger. [finger][MCP,PIP,DIP]
const RELAXED: number[][] = [[0, 0.1, 0.15], [0.15, 0.25, 0.15], [0.2, 0.3, 0.18], [0.26, 0.34, 0.2], [0.32, 0.38, 0.22]];
// A closed grip round a held prop (CostumeDef.grip): [finger][MCP,PIP,DIP] (thumb: -, MCP, IP)
const GRIP: number[][] = [[0, 0.55, 0.7], [1.2, 1.45, 0.9], [1.3, 1.5, 0.95], [1.35, 1.5, 0.95], [1.4, 1.45, 0.9]];
// A relaxed human thumb metacarpal in hand coordinates (forward, side, forward×side), left hand.
// The avatar's rest thumb is taken to be this pose; tracking rotates it by the difference.
const THUMB_NEUTRAL = new THREE.Vector3(0.72, 0.55, 0.42).normalize();
/** Wrist limits: bend (flexion/extension + deviation) cone and pronation/supination twist. */
const WRIST_BEND = 1.25, WRIST_TWIST = 1.6;
/** Share of the wrist twist carried by the forearm (real forearms twist; the hand joint alone candy-wraps). */
const FOREARM_TWIST = 0.45;

/**
 * Easing rate (1/s) of the Hand + finger bones for the hand-result interval (s, HandTarget.interval). 80/s (the fixed
 * rate before 2026-10-04, time constant 12.5 ms) while hand results come at 25 Hz or faster; slower than that the bones
 * ease over half a result interval (2 / interval, 15..80/s; blended in between 25 and 16.7 Hz), so 10 Hz hands glide
 * instead of jumping and then holding. Offline at 10 Hz: on-screen finger motion in bursts 0.88 → 0.53, residual error
 * 7.3° → 4.4°, for about +35 ms of hand lag. localStorage vtp.handEase = '0': always 80/s.
 */
export function handEaseRate(interval: number | undefined): number {
  if (!(interval !== undefined && interval > 0.04)) return 80;
  const slow = Math.min(80, Math.max(15, 2 / interval));
  return 80 + (slow - 80) * Math.min(1, (interval - 0.04) / 0.02);
}

/** The hand display switches (localStorage; every access in try/catch, storage may be off). */
function readHandOpts() {
  let ease = true, up = false;
  try { ease = globalThis.localStorage?.getItem('vtp.handEase') !== '0'; up = globalThis.localStorage?.getItem('vtp.handUpsample') === '1'; } catch { /* defaults */ }
  return { ease, up };
}

// ---- render-rate upsampling of arm / hand targets (opt-in: localStorage vtp.handUpsample = '1') ----
type UpKey = 'armL' | 'armR' | 'handL' | 'handR';
/** One part's last distinct sample: the target object it came in, flattened values, the raw rate of change since the
 *  previous sample (null = none / implausible), the limited velocity actually used (null = hold), when it was first seen
 *  (clock s), the result interval. */
interface UpState { obj: object; t: number; at: number; v: number[]; conf: number; d: number[] | null; vel: number[] | null; iv: number }
/** Minmod limiter: the smaller of two rates when they agree in sign, else 0. Real motion keeps its direction from one
 *  sample to the next; tracking noise mostly reverses — so noise isn't amplified, and a hand that stops dead isn't
 *  carried past where it stopped. */
const minmod = (a: number, b: number) => (a > 0 && b > 0 ? Math.min(a, b) : a < 0 && b < 0 ? Math.max(a, b) : 0);
/** Longest extrapolation (s): one result interval, never more than this. */
const UP_CAP = 0.08;
/** Implausible = a glitch, not motion: direction change (unit-vector chord ≈ rad) per sample / per second, and finger angles (rad). */
const UP_DIR_STEP = 0.6, UP_DIR_SPEED = 10, UP_ANG_STEP = 0.8, UP_ANG_SPEED = 20;
/** Largest offset (rad) a direction / angle is ever pushed ahead: bounds the overshoot when a hand stops dead. */
const UP_MAX_OFFSET = 0.35;
const armConf = (a: ArmTarget) => Math.min(a.confidence, a.lowerConfidence ?? a.confidence);
const flatArm = (a: ArmTarget) => [a.upper.x, a.upper.y, a.upper.z, a.lower.x, a.lower.y, a.lower.z];
const flatHand = (h: HandTarget) => {
  const v = [h.forward.x, h.forward.y, h.forward.z, h.side.x, h.side.y, h.side.z, h.thumbDir.x, h.thumbDir.y, h.thumbDir.z];
  for (let f = 0; f < 5; f++) for (let j = 0; j < 3; j++) v.push(h.curls[f]?.[j] ?? 0);
  for (let f = 0; f < 5; f++) v.push(h.spread[f] ?? 0);
  return v;
};
/** Leading entries that are unit-vector triples (the rest are angles). */
const ARM_DIRS = 2, HAND_DIRS = 3;
/** Two consecutive samples a believable motion apart (`dirs` leading unit-vector triples, then angles)? */
function plausible(a: number[], b: number[], dt: number, dirs: number) {
  for (let i = 0; i < a.length;) {
    if (i < dirs * 3) {
      const d = Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]);
      if (d > UP_DIR_STEP || d / dt > UP_DIR_SPEED) return false;
      i += 3;
    } else {
      const d = Math.abs(a[i] - b[i]);
      if (d > UP_ANG_STEP || d / dt > UP_ANG_SPEED) return false;
      i++;
    }
  }
  return true;
}

interface HandRig {
  /** Rest hand basis in normalized space: forward (wrist→middle knuckle), side (pinky→index), normal = fwd×side. */
  fwd: THREE.Vector3;
  side: THREE.Vector3;
  normal: THREE.Vector3;
  /** Rotation taking hand coordinates (fwd, side, normal) to normalized space. */
  basis: THREE.Quaternion;
  /** Rest forearm axis (lower arm → hand), for the wrist swing/twist split. */
  armAxis: THREE.Vector3;
}

export class Retargeter {
  /** Rotation from avatar space (+Z front, +X left) into the normalized rig's space. */
  private toNorm = new THREE.Quaternion();
  private fromNorm = new THREE.Quaternion();
  private rest = new Map<string, THREE.Vector3>();
  private current = new Map<string, THREE.Quaternion>();
  /** Per finger bone: hinge (curl) axis in rest space; positive rotation curls toward the palm. */
  private fingerAxis = new Map<string, THREE.Vector3>();
  private handRig = new Map<Side, HandRig>();
  /** Minimum finger curl per hand, 0..1 (held props: CostumeDef.grip). */
  grip: Record<Side, number> = { left: 0, right: 0 };
  private time = 0;
  private emo = { sad: 0, angry: 0, surprised: 0, happy: 0 };
  /** Four-legged body (profile.body 'quadruped', src/avatar/quadruped.ts): no arm / hand / leg retargeting, no body
   *  tracking on the torso, a gentle lean on the spine / chest only (the neck and head do the talking). */
  quadruped = false;
  /** A walking machine (profile.body 'mech', src/avatar/mech.ts): its pilot's arms are placed by the machine, so the Arms choice
   *  (shared/armPose.ts) never applies, whatever the profile says. */
  mech = false;
  readonly has: (b: string) => boolean;
  /** Keeps the hands and forearms out of the body when the avatar asks for it (tracking.bodyGuard). null: no hips / arms. */
  private guard: BodyGuard | null = null;
  /** Wall clock (s) for the hand upsampler; offline benches / tests replace it. */
  clock: () => number = () => performance.now() / 1000;
  /** Overrides for the localStorage switches vtp.handEase / vtp.handUpsample (undefined = follow the switch). */
  handEase?: boolean;
  handUpsample?: boolean;
  /** How far ahead (s) each arm / hand target was extrapolated on the last update (0 = not at all) — diagnostics. */
  readonly upsampleLead: Record<UpKey, number> = { armL: 0, armR: 0, handL: 0, handR: 0 };
  private hopts = { ease: true, up: false };
  private hoptsAt = -Infinity;
  private ups = new Map<UpKey, UpState>();
  /** The "In front" arm pose (profile.tracking.armPose = 'front', src/avatar/armPose.ts). null: the skeleton has no hips / two full arms. */
  private front: FrontPose | null = null;
  /** Eased 0..1 blend of the "In front" pose (0 = not in use: the code below then runs exactly as before the Arms choice) and
   *  of the tracking's pull on the arms (1 = Follow my arms, 0 = At my sides). */
  private frontM = 0;
  private trackM = 1;
  private armInit = false;
  /** "In front": per side, the big-gesture gate, how clearly the hand is seen (fingers follow), the smoothed palm correction. */
  private gate: Record<Side, GestureGate> = { left: new GestureGate(), right: new GestureGate() };
  private handSeen: Record<Side, number> = { left: 0, right: 0 };
  private palmTw: Record<Side, number> = { left: 0, right: 0 };
  /** Tracked wrist (torso frame) one update ago and its smoothed speed (arm lengths a second): fast motion is a gesture too. */
  private wristPrev: Record<Side, THREE.Vector3 | null> = { left: null, right: null };
  private wristSpeed: Record<Side, number> = { left: 0, right: 0 };
  /** 1 when the measured torso surface just replaced the skeleton's prism, then 0 over ~1 s: the arms and hands glide to the new pose. */
  private settle = 0;

  constructor(private humanoid: VRMHumanoid, avatarAnchor: THREE.Object3D) {
    const normRoot = humanoid.normalizedHumanBonesRoot;
    avatarAnchor.updateWorldMatrix(true, true);
    const aq = avatarAnchor.getWorldQuaternion(new THREE.Quaternion());
    const nq = (normRoot.parent ?? normRoot).getWorldQuaternion(new THREE.Quaternion());
    // v_norm = toNorm * v_avatar
    this.toNorm.copy(nq).invert().multiply(aq);
    this.fromNorm.copy(this.toNorm).invert();
    this.has = (b) => !!humanoid.getNormalizedBoneNode(b as VRMHumanBoneName);

    // rest positions in normalized space (all normalized bones are at identity rest)
    const inv = new THREE.Matrix4().copy((normRoot.parent ?? normRoot).matrixWorld).invert();
    for (const [name] of Object.entries(humanoid.humanBones)) {
      const n = humanoid.getNormalizedBoneNode(name as VRMHumanBoneName);
      if (!n) continue;
      this.rest.set(name, n.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv));
    }
    for (const side of ['left', 'right'] as Side[]) this.initHand(side);
    const restAv = (b: string) => { const p = this.rest.get(b); return p ? p.clone().applyQuaternion(this.fromNorm) : undefined; };
    this.guard = BodyGuard.fromRest(restAv);
    this.front = FrontPose.fromRest(restAv);
  }

  /** World -> avatar space: the frame of this retargeter's rest bone positions (units of the rig's parent, axes of the avatar anchor). */
  worldToAvatar(): THREE.Matrix4 {
    const normRoot = this.humanoid.normalizedHumanBonesRoot;
    normRoot.parent?.updateWorldMatrix(true, false);
    return new THREE.Matrix4().makeRotationFromQuaternion(this.fromNorm).multiply(new THREE.Matrix4().copy((normRoot.parent ?? normRoot).matrixWorld).invert());
  }
  /** A rest bone position in avatar space (the frame the arm pose and the torso measurement work in); undefined without that bone. */
  restAvatar(b: string): THREE.Vector3 | undefined { const p = this.rest.get(b); return p ? p.clone().applyQuaternion(this.fromNorm) : undefined; }
  /** The torso's real surface measured from the mesh (src/avatar/torsoSurface.ts, a few ms a frame once "In front" is wanted): the
   *  pose keeps the wrists the right distance off it. null = the skeleton's prism. The arms glide to the new pose. */
  setTorsoSurface(s: TorsoSurface | null) { this.front?.setSurface(s); if (this.frontM > 0) this.settle = 1; }

  /** Diagnostics / tests: how far the "In front" pose is blended in, and each arm's big-gesture weight. */
  armState() { return { front: this.frontM, track: this.trackM, gesture: { left: this.gate.left.w, right: this.gate.right.w }, hasFront: this.front !== null }; }
  /** The solved "In front" pose of a style (tests, the review page); null when the skeleton can't have one. */
  frontSolution(style: Parameters<FrontPose['solution']>[0], depth = 1): FrontSolution | null { return this.front?.solution(style, depth) ?? null; }

  private pos(b: string) { return this.rest.get(b); }
  private dir(a: string, b: string, fallback?: THREE.Vector3) {
    const pa = this.pos(a), pb = this.pos(b);
    if (!pa || !pb || pa.distanceToSquared(pb) < 1e-10) return fallback?.clone() ?? null;
    return pb.clone().sub(pa).normalize();
  }
  /** avatar-space vector → normalized space */
  private n(v: THREE.Vector3) { return v.clone().applyQuaternion(this.toNorm); }
  /** avatar-space rotation → normalized space */
  private nq(q: THREE.Quaternion) { return this.toNorm.clone().multiply(q).multiply(this.fromNorm); }

  private initHand(side: Side) {
    const hand = `${side}Hand`;
    const hp = this.pos(hand);
    if (!hp) return;
    const armDir = this.dir(`${side}LowerArm`, hand) ?? this.n(new THREE.Vector3(side === 'left' ? 1 : -1, 0, 0));
    // forward: toward the middle knuckle (else the mean of whichever knuckles exist, else along the forearm)
    const knuckles = ['Index', 'Middle', 'Ring', 'Little'].map((f) => this.pos(`${side}${f}Proximal`)).filter((v): v is THREE.Vector3 => !!v);
    let fwd = this.dir(hand, `${side}MiddleProximal`);
    if (!fwd && knuckles.length) {
      const c = knuckles.reduce((a, v) => a.add(v), new THREE.Vector3()).multiplyScalar(1 / knuckles.length);
      if (c.distanceToSquared(hp) > 1e-10) fwd = c.sub(hp).normalize();
    }
    fwd ??= armDir.clone();
    const idx = this.pos(`${side}IndexProximal`), lit = this.pos(`${side}LittleProximal`) ?? this.pos(`${side}RingProximal`);
    let sideV = idx && lit && idx.distanceToSquared(lit) > 1e-10 ? idx.clone().sub(lit) : this.n(new THREE.Vector3(0, 0, 1)); // index toward the front
    sideV.sub(fwd.clone().multiplyScalar(sideV.dot(fwd)));
    if (sideV.lengthSq() < 1e-10) sideV = this.n(new THREE.Vector3(0, 1, 0)).cross(fwd);
    sideV.normalize();
    const normal = fwd.clone().cross(sideV).normalize();
    const basis = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(fwd, sideV, normal));
    this.handRig.set(side, { fwd, side: sideV, normal, basis, armAxis: armDir.clone() });
    // volar (palm-out) normal: fwd×side for a left hand, −fwd×side for a right hand
    const volar = side === 'left' ? normal.clone() : normal.clone().negate();
    // palm centre, for the thumb's bending direction
    const pc = [hp, ...knuckles].reduce((a, v) => a.add(v), new THREE.Vector3()).multiplyScalar(1 / (knuckles.length + 1));
    for (const f of FINGERS) {
      const chain = SEGS[side + f];
      chain.forEach((bone, j) => {
        if (!this.has(bone)) return;
        // rest direction of this segment: toward its child, else continuing its parent, else out of the hand
        const child = chain.slice(j + 1).find((b) => this.has(b));
        const prev = j > 0 && this.has(chain[j - 1]) ? chain[j - 1] : hand;
        const d = (child && this.dir(bone, child)) || this.dir(prev, bone) || fwd.clone();
        let axis: THREE.Vector3;
        if (f === 'Thumb') {
          // the thumb curls toward the palm centre, not in the fingers' plane
          const c = pc.clone().sub(this.pos(bone)!);
          c.addScaledVector(d, -c.dot(d));
          axis = c.lengthSq() > 1e-10 ? d.clone().cross(c.normalize()) : d.clone().cross(volar);
        } else axis = d.clone().cross(volar);
        if (axis.lengthSq() < 1e-8) return;
        this.fingerAxis.set(bone, axis.normalize());
      });
    }
  }

  /**
   * Hand + fingers for one side. `lowerW` is the forearm's world rotation (normalized space); returns the
   * (possibly twisted) forearm rotation so the caller can re-set the lower arm.
   */
  private solveHand(side: Side, lowerW: THREE.Quaternion, ht: HandTarget | null, target: Map<string, THREE.Quaternion>, opt?: { rest?: number[][]; wristW?: number }): { lowerW: THREE.Quaternion; handW: THREE.Quaternion } | null {
    const hr = this.handRig.get(side);
    const hd = `${side}Hand`;
    if (!hr || !this.has(hd)) return null;
    const conf = ht ? clamp(ht.confidence, 0, 1) : 0;
    // "In front": the wrist follows the tracked hand only as far as the arm does (a big gesture); the fingers by `conf`
    const wconf = opt?.wristW === undefined ? conf : conf * opt.wristW;
    const REST = opt?.rest ?? RELAXED;
    let lower = lowerW;
    let handLocal = I.clone();
    if (ht && wconf > 0.001) {
      // ---- wrist: tracked palm basis, expressed relative to the forearm, then limited ----
      const tf = this.n(ht.forward).normalize();
      const ts = this.n(ht.side);
      ts.addScaledVector(tf, -ts.dot(tf)).normalize();
      const tq = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(tf, ts, tf.clone().cross(ts)));
      const handAbs = tq.multiply(hr.basis.clone().invert()); // rest hand basis → tracked basis
      const local = lowerW.clone().invert().multiply(handAbs);
      if (local.w < 0) local.set(-local.x, -local.y, -local.z, -local.w);
      // swing-twist split around the forearm axis
      const a = hr.armAxis;
      const d = local.x * a.x + local.y * a.y + local.z * a.z;
      let twistA = 2 * Math.atan2(d, local.w);
      twistA = Math.atan2(Math.sin(twistA), Math.cos(twistA));
      const twistQ = new THREE.Quaternion(a.x * d, a.y * d, a.z * d, local.w).normalize();
      const swingQ = limitAngle(local.clone().multiply(twistQ.clone().invert()), WRIST_BEND);
      twistA = clamp(twistA, -WRIST_TWIST, WRIST_TWIST) * wconf;
      const bend = I.clone().slerp(swingQ, wconf);
      // the forearm takes part of the twist; the hand's local rotation compensates, so the hand ends up
      // exactly where it should while the skin twist is spread over forearm + wrist
      const fa = twistA * FOREARM_TWIST;
      lower = lowerW.clone().multiply(axisAngle(a, fa));
      handLocal = axisAngle(a, -fa).multiply(bend).multiply(axisAngle(a, twistA));
    }
    const handW = lower.clone().multiply(handLocal);

    // ---- fingers ----
    FINGERS.forEach((f, fi) => {
      const chain = SEGS[side + f];
      const lim = f === 'Thumb' ? THUMB_LIMIT : FLEX_LIMIT;
      const flex = [0, 1, 2].map((j) => {
        const tracked = ht ? clamp(ht.curls[fi]?.[j] ?? 0, lim[j][0], lim[j][1]) : REST[fi][j];
        const v = lerp(REST[fi][j], tracked, conf);
        return this.grip[side] > 0 ? Math.max(v, GRIP[fi][j] * this.grip[side]) : v;
      });
      // missing joints: fold their curl into the nearest parent so the finger still reads as curled
      const ok = chain.map((b) => this.fingerAxis.has(b));
      if (!ok[2] && ok[1]) flex[1] += flex[2] * 0.5;
      if (!ok[1] && ok[0]) flex[0] += (flex[1] + (ok[2] ? 0 : flex[2] * 0.5)) * 0.6;
      chain.forEach((bone, j) => {
        const axis = this.fingerAxis.get(bone);
        if (f === 'Thumb' && j === 0) {
          // thumb CMC (2-DOF): rotate the avatar's rest thumb by how the tracked thumb differs from a
          // relaxed human thumb, measured in hand coordinates and mapped through the avatar's hand basis
          if (!this.has(bone)) return;
          let q = I.clone();
          if (ht && conf > 0.001) {
            const neutral = THUMB_NEUTRAL.clone();
            if (side === 'right') neutral.z = -neutral.z; // mirror-image hand
            const delta = limitAngle(swing(neutral, ht.thumbDir.clone().normalize()), 1.1);
            q = hr.basis.clone().multiply(delta).multiply(hr.basis.clone().invert());
            q = I.clone().slerp(q, conf);
          }
          target.set(bone, q);
          return;
        }
        if (!axis) return;
        const hi = (f === 'Thumb' ? THUMB_LIMIT : FLEX_LIMIT)[j][1] * 1.3;
        let q = axisAngle(axis, clamp(flex[j], -0.4, hi));
        if (j === 0 && f !== 'Thumb') {
          // MCP spread: about the palm normal (fwd×side rotates forward toward the thumb side)
          const sp = ht ? clamp(ht.spread[fi] ?? 0, SPREAD_LIMIT[fi][0], SPREAD_LIMIT[fi][1]) * conf : 0;
          if (sp) q = axisAngle(hr.normal, sp).multiply(q);
        }
        target.set(bone, q);
      });
    });
    return { lowerW: lower, handW };
  }

  /**
   * Solve and apply. Returns normalized local rotations (for broadcasting to OBS/output viewers).
   */
  update(frame: TrackingFrame, body: BodyTargets | null, tune: TrackingTuning, dt: number): Record<string, [number, number, number, number]> {
    this.time += dt;
    // hand display switches (re-read at most once a second, so a settings toggle applies live)
    const now = this.clock();
    if (!(now - this.hoptsAt < 1 && now >= this.hoptsAt)) { this.hoptsAt = now; this.hopts = readHandOpts(); }
    const easeOn = this.handEase ?? this.hopts.ease, upOn = this.handUpsample ?? this.hopts.up;
    if (!upOn && this.ups.size) { this.ups.clear(); for (const k in this.upsampleLead) this.upsampleLead[k as UpKey] = 0; }
    /** Hand + finger easing rate per side (handEaseRate: 80/s unless hand results are slower than 25 Hz). */
    const handRate: Record<Side, number> = { left: 80, right: 80 };
    const target = new Map<string, THREE.Quaternion>();
    const world = new Map<string, THREE.Quaternion>(); // normalized-space world rotation per bone
    const W = (b: string) => world.get(b) ?? I;
    const setWorld = (b: string, parent: string | null, q: THREE.Quaternion) => {
      if (!this.has(b)) return;
      world.set(b, q);
      const pw = parent ? W(parent) : I;
      target.set(b, pw.clone().invert().multiply(q));
    };
    const parentOf = (b: string): string | null => {
      const order: Record<string, string[]> = {
        spine: ['hips'], chest: ['spine', 'hips'], upperChest: ['chest', 'spine'], neck: ['upperChest', 'chest', 'spine'],
        head: ['neck', 'upperChest', 'chest', 'spine'],
      };
      for (const p of order[b] ?? []) if (this.has(p)) return p;
      return null;
    };

    // ---- torso ----
    const [yaw, pitch, roll] = frame.head;
    const follow = tune.bodyFollow * (this.quadruped ? 0.4 : 1);
    let torso = new THREE.Quaternion();
    if (body?.torso && tune.trackBody && !this.quadruped) {
      const left = body.torso.left, up = body.torso.up;
      const fwd = left.clone().cross(up).normalize();
      _m.makeBasis(left, up, fwd);
      torso.setFromRotationMatrix(_m);
      torso.slerp(I, 1 - follow * body.torso.confidence);
    } else {
      // No body in view: let the torso follow the head a little, lean with head position, breathe.
      const [px, , pz] = frame.headPos;
      torso.setFromEuler(new THREE.Euler(
        -pz * 0.5 * follow + pitch * 0.08 * follow,
        yaw * 0.22 * follow,
        -px * 0.7 * follow + roll * 0.12 * follow,
        'YXZ',
      ));
    }
    const breathe = Math.sin(this.time * 1.6) * 0.012;
    // emotional body language (smoothed so it reads as posture, not jitter)
    const emo = estimateEmotions(frame.face);
    const k = 1 - Math.exp(-3 * dt);
    this.emo.sad += (emo.sad - this.emo.sad) * k;
    this.emo.angry += (emo.angry - this.emo.angry) * k;
    this.emo.surprised += (emo.surprised - this.emo.surprised) * (1 - Math.exp(-8 * dt));
    this.emo.happy += (emo.happy - this.emo.happy) * k;
    const E = this.emo, B = tune.bodyFollow;
    const bounce = Math.sin(this.time * 7.5) * 0.018 * E.happy;
    torso.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(
      (E.sad * 0.14 + E.angry * 0.09 - E.surprised * 0.1 + bounce) * B, 0, 0, 'YXZ')));
    const torsoN = this.nq(torso);
    setWorld('hips', null, I.clone());
    const spineQ = I.clone().slerp(torsoN, 0.45).multiply(new THREE.Quaternion().setFromAxisAngle(this.n(new THREE.Vector3(1, 0, 0)), breathe));
    setWorld('spine', parentOf('spine'), spineQ);
    setWorld('chest', parentOf('chest'), torsoN.clone());
    if (this.has('upperChest')) setWorld('upperChest', parentOf('upperChest'), torsoN.clone());
    const torsoTop = this.has('upperChest') ? 'upperChest' : this.has('chest') ? 'chest' : 'spine';
    const torsoWorld = W(torsoTop);

    // ---- neck / head ----
    const talkLift = -frame.mouth.open * 0.06; // head tips back a touch as the mouth opens wide
    const headA = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      pitch + (E.sad * 0.16 - E.surprised * 0.07 + E.angry * 0.05) * B + talkLift, yaw, roll, 'YXZ'));
    const headN = this.nq(headA);
    if (this.has('neck')) {
      setWorld('neck', parentOf('neck'), torsoWorld.clone().slerp(headN, 0.4));
    }
    setWorld('head', parentOf('head'), headN);

    // ---- arms ---- (quadrupeds: the front legs are not arms)
    // The Arms choice (shared/armPose.ts). 'follow' (unset) leaves frontM = 0 and trackM = 1: nothing below changes then.
    const arm = this.quadruped || this.mech ? armSettings(undefined) : armSettings(tune); // (no arm choice on a machine or four legs)
    const wantFront = arm.mode === 'front' && this.front !== null && !this.quadruped && !this.mech;
    if (this.settle > 0) this.settle = Math.max(0, this.settle - dt / 1.0);
    const wantTrack = arm.mode === 'sides' ? 0 : 1;
    if (!this.armInit) { this.armInit = true; this.frontM = wantFront ? 1 : 0; this.trackM = wantTrack; } // (an avatar loaded with the choice saved starts there)
    else {
      this.frontM = approach(this.frontM, wantFront ? 1 : 0, 4, dt); // ~0.6 s to blend in or out
      this.trackM = approach(this.trackM, wantTrack, 4, dt);
      if (this.frontM < 1e-3 && !wantFront) this.frontM = 0;
      if (this.frontM > 0.999 && wantFront) this.frontM = 1;
      if (Math.abs(this.trackM - wantTrack) < 1e-3) this.trackM = wantTrack;
    }
    const fm = this.frontM, trk = this.trackM;
    let frontCtx: { sol: FrontSolution; pose: ReturnType<FrontPose['pose']>; toTorso: THREE.Quaternion; back: THREE.Quaternion; palm: Record<Side, THREE.Vector3> } | null = null;
    if (fm > 0 && this.front) {
      const sol = this.front.solution(arm.style, tune.bodyDepth ?? 1);
      if (sol) {
        // the hands keep their place against part of the torso's lean (FRONT_FOLLOW): a rotation about the shoulders, in the torso frame
        const qa = this.fromNorm.clone().multiply(torsoWorld).multiply(this.toNorm);
        const res = I.clone().slerp(qa.clone().invert(), 1 - FRONT_FOLLOW);
        const back = torsoWorld.clone().multiply(this.toNorm);
        frontCtx = {
          sol, pose: this.front.pose(sol, this.time, res, fm), toTorso: this.fromNorm.clone().multiply(torsoWorld.clone().invert()), back,
          palm: { left: palmDirection(arm.style, 'left').applyQuaternion(back), right: palmDirection(arm.style, 'right').applyQuaternion(back) },
        };
      }
    }
    for (const side of (this.quadruped ? [] : ['left', 'right']) as Side[]) {
      const sgn = side === 'left' ? 1 : -1;
      const sh = `${side}Shoulder`, ua = `${side}UpperArm`, la = `${side}LowerArm`, hd = `${side}Hand`;
      if (!this.has(ua)) continue;
      const shoulderParent = this.has(sh) ? sh : null;
      if (shoulderParent) setWorld(sh, torsoTop, torsoWorld.clone());
      const parentW = shoulderParent ? W(sh) : torsoWorld;
      const restU = this.dir(ua, la);
      const restL = this.dir(la, hd);
      if (!restU || !restL) continue;
      const t0 = tune.trackBody ? body?.arms[side] : null;
      // opt-in: between tracker results, carry the arm on along its last measured motion (see upStep)
      const t = upOn ? this.upArm(side === 'left' ? 'armL' : 'armR', t0 ?? null, now) : t0;
      // relaxed arms: hanging down slightly out and forward (in avatar space); profile.tracking.idleArmDown lifts them for
      // wide characters (shared/idleArm.ts; unset = the built-in ~73 degrees below horizontal)
      const rel = relaxedArmDirs(sgn as 1 | -1, tune.idleArmDown);
      const relaxedU = this.n(new THREE.Vector3(rel.u[0], rel.u[1], rel.u[2]));
      const relaxedL = this.n(new THREE.Vector3(rel.l[0], rel.l[1], rel.l[2]));
      let du = relaxedU, dl = relaxedL;
      if (t) {
        // exaggeration pushes the pose further from rest (cartoon energy; great on stubby arms)
        const ex = (tune.armExaggeration ?? 1) * t.confidence * trk;
        du = relaxedU.clone().lerp(this.n(t.upper), ex).normalize();
        // forearm by its own confidence: an unseen wrist fades to the relaxed forearm while the elbow tracks
        dl = relaxedL.clone().lerp(this.n(t.lower), (tune.armExaggeration ?? 1) * (t.lowerConfidence ?? t.confidence) * trk).normalize();
      }
      // "In front": the pose, with the tracked arm taking over for a big gesture
      let g = 0;
      const fs = frontCtx?.pose[side];
      if (frontCtx && fs) {
        const gate = this.gate[side];
        if (arm.react && t && !t.held) {
          // the tracked wrist against the pose's wrist, in the torso frame, in arm lengths
          const rg = this.front!.rig, S = rg.shoulder[side], uL = rg.upper[side], fL = rg.fore[side];
          const tu = this.n(t.upper).applyQuaternion(frontCtx.toTorso), tl = this.n(t.lower).applyQuaternion(frontCtx.toTorso);
          const tw = S.clone().addScaledVector(tu, uL).addScaledVector(tl, fL);
          // how fast it moves (arm lengths a second, smoothed ~0.1 s): a wave or a throw is a gesture even level with the pose
          const prev = this.wristPrev[side];
          if (prev && dt > 0) this.wristSpeed[side] = approach(this.wristSpeed[side], tw.distanceTo(prev) / dt / (uL + fL), 10, dt);
          this.wristPrev[side] = tw;
          g = gate.update(dt, armConf(t), tw.distanceTo(fs.wrist) / (uL + fL), (tw.y - fs.wrist.y) / (uL + fL), this.wristSpeed[side]);
        } else { this.wristPrev[side] = null; this.wristSpeed[side] = 0; g = gate.update(dt, 0, 0, 0); }
        const fu = fs.du.clone().applyQuaternion(frontCtx.back), fl = fs.dl.clone().applyQuaternion(frontCtx.back);
        let pu = fu, pl = fl;
        if (g > 0 && t) {
          const ex = (tune.armExaggeration ?? 1) * t.confidence;
          pu = fu.clone().lerp(relaxedU.clone().lerp(this.n(t.upper), ex).normalize(), g).normalize();
          pl = fl.clone().lerp(relaxedL.clone().lerp(this.n(t.lower), (tune.armExaggeration ?? 1) * (t.lowerConfidence ?? t.confidence)).normalize(), g).normalize();
        }
        du = du.clone().lerp(pu, fm).normalize(); dl = dl.clone().lerp(pl, fm).normalize();
      } else if (fm === 0) this.gate[side].reset();
      // springy follow-through: arms overshoot a touch and settle instead of tracking rigidly (the resting "In front" pose
      // itself is critically damped: it only gets the bounce while a tracked gesture is in)
      const bs = 1 - fm * (1 - g);
      du = this.springDir(`${side}U`, du, dt, (tune.armBounce ?? 0.45) * bs);
      dl = this.springDir(`${side}L`, dl, dt, (tune.armBounce ?? 0.45) * 1.15 * bs);
      // keep the hands and forearms out of the body (tracking.bodyGuard, src/avatar/bodyGuard.ts), worked out in the torso's
      // own frame (avatar axes) so leaning and turning carry the body along. Off: the same directions come back untouched.
      if (this.guard) {
        const toTorso = this.fromNorm.clone().multiply(torsoWorld.clone().invert());
        const g = this.guard.apply(side, du.clone().applyQuaternion(toTorso), dl.clone().applyQuaternion(toTorso), tune.bodyDepth ?? 1, dt, tune.bodyGuard === true);
        if (g.pushed > 0) { const back = torsoWorld.clone().multiply(this.toNorm); du = g.du.applyQuaternion(back); dl = g.dl.applyQuaternion(back); }
      }
      const cur = restU.clone().applyQuaternion(parentW);
      const upperW = swing(cur, du).multiply(parentW);
      setWorld(ua, shoulderParent ?? torsoTop, upperW);
      const curL = restL.clone().applyQuaternion(upperW);
      const lowerW = swing(curL, dl).multiply(upperW);
      setWorld(la, ua, lowerW);

      // hand + fingers (wrist fused with the forearm; part of its twist goes to the forearm)
      const ht0 = tune.trackHands ? body?.hands[side] ?? null : null;
      if (easeOn) handRate[side] = handEaseRate(ht0?.interval);
      let ht = upOn ? this.upHand(side === 'left' ? 'handL' : 'handR', ht0, now) : ht0;
      if (trk < 1 && ht) ht = { ...ht, confidence: ht.confidence * trk }; // At my sides: tracked hands are ignored (eased)
      let hopt: { rest?: number[][]; wristW?: number } | undefined;
      if (frontCtx && fs) {
        // In front: the fingers follow a hand the camera sees clearly (the wrist only with a big gesture), else they rest curled
        const clear = ht ? THREE.MathUtils.smoothstep(ht.confidence, 0.6, 0.85) : 0;
        this.handSeen[side] = approach(this.handSeen[side], clear, clear > this.handSeen[side] ? 6 : 3, dt);
        if (ht) ht = { ...ht, confidence: ht.confidence * (1 - fm + fm * this.handSeen[side]) };
        hopt = { rest: this.frontRest(side, arm.style, fm), wristW: 1 - fm + fm * g };
      } else this.handSeen[side] = 0;
      const hs = this.solveHand(side, lowerW, ht, target, hopt);
      if (hs) {
        let lowerOut = hs.lowerW, handOut = hs.handW;
        if (frontCtx && fs) {
          const o = this.frontHand(side, fs.dl.clone().applyQuaternion(frontCtx.back), fs.dh.clone().applyQuaternion(frontCtx.back), frontCtx.palm[side], lowerOut, handOut, fm * (1 - g), dt);
          if (o) { lowerOut = o.lowerW; handOut = o.handW; }
        }
        if (lowerOut !== lowerW) setWorld(la, ua, lowerOut);
        setWorld(hd, la, handOut);
      }
    }

    // ---- legs ---- (quadrupeds: src/avatar/quadruped.ts owns the legs)
    for (const side of (this.quadruped ? [] : ['left', 'right']) as Side[]) {
      const ul = `${side}UpperLeg`, ll = `${side}LowerLeg`, ft = `${side}Foot`;
      const t = tune.trackBody ? body?.legs[side] : null;
      if (!this.has(ul) || !this.has(ll)) continue;
      if (!t) { target.set(ul, I.clone()); target.set(ll, I.clone()); continue; }
      const restU = this.dir(ul, ll), restL = this.dir(ll, ft);
      if (!restU || !restL) continue;
      const hipsW = W('hips');
      const upperW = swing(restU.clone().applyQuaternion(hipsW), this.n(t.upper)).multiply(hipsW);
      setWorld(ul, 'hips', I.clone().slerp(upperW, t.confidence));
      const lowerW = swing(restL.clone().applyQuaternion(W(ul)), this.n(t.lower)).multiply(W(ul));
      setWorld(ll, ul, I.clone().slerp(lowerW, t.confidence));
    }

    // ---- ease current → target and apply ----
    const out: Record<string, [number, number, number, number]> = {};
    for (const [bone, q] of target) {
      const head = bone === 'head' || bone === 'neck';
      const fast = head || bone.includes('Hand') || FINGERS.some((f) => bone.includes(f));
      // light de-step only: the tracking filters already smooth + predict (heavy easing here added ~40-60 ms lag);
      // hand + finger bones by the hand-result interval (handEaseRate), head / neck always 80/s
      let rate = !fast ? 40 : head ? 80 : handRate[bone.startsWith('left') ? 'left' : 'right'];
      if (this.settle > 0 && /^(left|right)(Shoulder|UpperArm|LowerArm|Hand|Thumb|Index|Middle|Ring|Little)/.test(bone)) rate = Math.min(rate, 3); // a new measured pose: glide
      const k = 1 - Math.exp(-rate * dt);
      let cur = this.current.get(bone);
      if (!cur) { cur = q.clone(); this.current.set(bone, cur); }
      cur.slerp(q, k);
      out[bone] = [cur.x, cur.y, cur.z, cur.w];
    }
    this.applyBones(out);
    return out;
  }

  /**
   * Render-rate upsampling (opt-in, localStorage vtp.handUpsample = '1'). Tracker results arrive at 10-30 Hz but the
   * avatar renders at 60 Hz: between two results a part is carried on along its last measured velocity
   * ((cur - prev) / their time apart, minmod-limited against the pair before: noise that reverses isn't amplified and a
   * hand that stops isn't carried on) for up to one result interval (never more than 80 ms), then held, then eased back
   * onto the last sample if the next result is late. No added latency (it never waits for the next result). The velocity
   * is zeroed — the target shown exactly as measured — for the solver's own holds and anything without a sample time
   * (track-loss blends), below confidence 0.5, for implausible jumps (a glitch is not motion), and for an arm while its
   * confidence falls by more than `drop` (fading out). Hands pass drop = Infinity: their confidence follows MediaPipe's
   * handedness score, which jitters (offline, 2026-10-04: down by > 0.1 between two live samples 14-21 % of the time,
   * p99 0.25), so a confidence guard there switched upsampling off for ~40 % of real hand samples; the arm confidence
   * is a latched, eased state that only falls when the arm is fading out (> 0.02 in ~2 % of samples).
   * Returns the values to show now, or null = show the target as it is.
   */
  private upStep(key: UpKey, target: ArmTarget | HandTarget | null, now: number, flat: () => number[], conf: number, dirs: number, drop: number): number[] | null {
    this.upsampleLead[key] = 0;
    if (!target || target.held || target.t === undefined || !Number.isFinite(target.t)) { this.ups.delete(key); return null; }
    let s = this.ups.get(key);
    // the same sample time in a different target object with other values = the sample re-solved (a mirror switch
    // re-solves the last pose / hands on the other side): start over from it, without a velocity
    if (s && s.t === target.t && s.obj !== target) {
      const v = flat(), sv = s.v;
      if (v.length !== sv.length || v.some((x, i) => x !== sv[i])) { this.ups.delete(key); s = undefined; } else s.obj = target;
    }
    if (!s || s.t !== target.t) {
      const p = s;
      const cur: UpState = { obj: target, t: target.t, at: now, v: flat(), conf, d: null, vel: null, iv: 0 };
      const dtS = p ? cur.t - p.t : 0;
      cur.iv = target.interval && target.interval > 0 ? target.interval : dtS;
      if (p && dtS > 0.002 && dtS <= Math.min(0.25, 3 * cur.iv) && conf >= 0.5 && conf >= p.conf - drop && p.v.length === cur.v.length &&
        plausible(cur.v, p.v, dtS, dirs)) cur.d = cur.v.map((x, i) => (x - p.v[i]) / dtS);
      // the velocity used: limited against the previous sample pair's (three samples in a row that agree)
      const pd = p?.d;
      if (cur.d && pd && pd.length === cur.d.length) {
        const d = cur.d, vel = d.map((x, i) => minmod(x, pd[i]));
        if (vel.some((x) => x !== 0)) cur.vel = vel; // all zero (a locked, still hand): shown exactly as measured
      }
      this.ups.set(key, (s = cur));
    }
    if (!s.vel || s.iv <= 0 || conf < 0.5 || conf < s.conf - drop) return null;
    const age = now - s.at;
    if (!(age > 0)) return null;
    let e = Math.min(age, s.iv, UP_CAP);
    if (age > 1.5 * s.iv) e *= Math.exp(-(age - 1.5 * s.iv) / 0.1); // the next result is late: settle back on this one
    // bound the push (rad): a hand that stops dead overshoots at most UP_MAX_OFFSET
    let sc = 1;
    for (let i = 0; i < s.vel.length;) {
      const d = i < dirs * 3 ? 3 : 1;
      const m = (d === 3 ? Math.hypot(s.vel[i], s.vel[i + 1], s.vel[i + 2]) : Math.abs(s.vel[i])) * e;
      if (m > UP_MAX_OFFSET) sc = Math.min(sc, UP_MAX_OFFSET / m);
      i += d;
    }
    e *= sc;
    if (e < 1e-5) return null;
    this.upsampleLead[key] = e;
    const vel = s.vel;
    return s.v.map((x, i) => x + vel[i] * e);
  }
  private upArm(key: UpKey, a: ArmTarget | null, now: number): ArmTarget | null {
    const v = this.upStep(key, a, now, () => flatArm(a!), a ? armConf(a) : 0, ARM_DIRS, 0.02);
    if (!v || !a) return a;
    return { ...a, upper: new THREE.Vector3(v[0], v[1], v[2]).normalize(), lower: new THREE.Vector3(v[3], v[4], v[5]).normalize() };
  }
  private upHand(key: UpKey, h: HandTarget | null, now: number): HandTarget | null {
    const v = this.upStep(key, h, now, () => flatHand(h!), h ? h.confidence : 0, HAND_DIRS, Infinity);
    if (!v || !h) return h;
    return {
      ...h, forward: new THREE.Vector3(v[0], v[1], v[2]).normalize(), side: new THREE.Vector3(v[3], v[4], v[5]).normalize(), thumbDir: new THREE.Vector3(v[6], v[7], v[8]).normalize(),
      curls: [0, 1, 2, 3, 4].map((f) => [v[9 + f * 3], v[10 + f * 3], v[11 + f * 3]]), spread: [0, 1, 2, 3, 4].map((f) => v[24 + f]),
    };
  }

  /** "In front": the resting finger curl of a style blended over the relaxed hand by `fm`, with a tiny idle drift. */
  private frontRest(side: Side, style: Parameters<typeof frontCurl>[0], fm: number): number[][] {
    const curl = frontCurl(style);
    return RELAXED.map((row, fi) => row.map((v, j) => lerp(v, curl[fi][j] + (fi === 0 && j === 0 ? 0 : fingerIdle(this.time, side, fi, j)), fm)));
  }

  /**
   * "In front": lay the hand along `dh` (the hand lies straighter than the forearm) and turn the palm toward `palm`, both
   * worked out in the torso frame by src/avatar/armPose.ts; `k` (0..1) is how much of it applies (less while a tracked
   * gesture owns the arm). The twist is shared with the forearm like the tracked wrist's is.
   */
  private frontHand(side: Side, dl: THREE.Vector3, dh: THREE.Vector3, palm: THREE.Vector3, lowerW: THREE.Quaternion, handW: THREE.Quaternion, k: number, dt: number): { lowerW: THREE.Quaternion; handW: THREE.Quaternion } | null {
    const hr = this.handRig.get(side);
    if (!hr || k <= 1e-4) { this.palmTw[side] = approach(this.palmTw[side], 0, 10, dt); return null; }
    let hand = handW;
    // aim: swing the hand from where it points now to dh (limited to about 50 degrees)
    const now = hr.fwd.clone().applyQuaternion(hand);
    const aim = limitAngle(swing(now, dh), 0.9);
    hand = I.clone().slerp(aim, k).multiply(hand);
    // palm: turn it about the hand's axis toward the style's palm direction
    const volar = (side === 'left' ? hr.normal.clone() : hr.normal.clone().negate()).applyQuaternion(hand);
    const axis = hr.fwd.clone().applyQuaternion(hand).normalize();
    const pn = volar.addScaledVector(axis, -volar.dot(axis));
    const pd = palm.clone().addScaledVector(axis, -palm.dot(axis));
    let want = this.palmTw[side];
    if (pn.lengthSq() > 1e-4 && pd.lengthSq() > 1e-4) want = clamp(Math.atan2(axis.dot(pn.clone().cross(pd)), pn.dot(pd)), -1.7, 1.7);
    const prev = this.palmTw[side];
    const d = Math.atan2(Math.sin(want - prev), Math.cos(want - prev));
    const tw = (this.palmTw[side] = prev + d * (1 - Math.exp(-10 * Math.max(0, dt)))) * k;
    hand = axisAngle(axis, tw).multiply(hand);
    const lower = axisAngle(dl, tw * FOREARM_TWIST).multiply(lowerW);
    return { lowerW: lower, handW: hand };
  }

  private springs = new Map<string, { x: THREE.Vector3; v: THREE.Vector3 }>();
  /** Damped spring on a direction vector (bounce 0 = critically damped / stiff, 1 = wobbly). */
  private springDir(key: string, target: THREE.Vector3, dt: number, bounce: number) {
    let s = this.springs.get(key);
    if (!s) { s = { x: target.clone(), v: new THREE.Vector3() }; this.springs.set(key, s); }
    if (bounce <= 0.01) { s.x.copy(target); s.v.set(0, 0, 0); return target; }
    const w = 2 * Math.PI * THREE.MathUtils.lerp(5, 2.6, bounce);
    const zeta = THREE.MathUtils.lerp(1, 0.28, bounce);
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = target.clone().sub(s.x).multiplyScalar(w * w).addScaledVector(s.v, -2 * zeta * w);
      s.v.addScaledVector(a, h);
      s.x.addScaledVector(s.v, h);
    }
    return s.x.clone().normalize();
  }

  /** The rest hand basis of a side (normalized space: wrist to middle knuckle, pinky to index, their normal), null when
   *  the rig has no hand there. Mech pilots can align a hand to a grip frame with it (src/avatar/mech.ts). */
  handBasis(side: Side): { fwd: THREE.Vector3; side: THREE.Vector3; normal: THREE.Vector3; basis: THREE.Quaternion } | null {
    const h = this.handRig.get(side);
    return h ? { fwd: h.fwd.clone(), side: h.side.clone(), normal: h.normal.clone(), basis: h.basis.clone() } : null;
  }

  /** Mech pilots (src/avatar/mech.ts): one hand's fingers round a control grip, blended over whatever is there by `w`.
   *  'curl' = the GRIP curl (a held prop); 'bind' = the model's bind pose (authored holding the grip). Page-local: runs
   *  after the tracked / published bones were applied, so every page closes the same hand the same way. */
  holdGrip(side: Side, w: number, mode: 'curl' | 'bind' = 'curl') {
    if (!(w > 1e-4)) return;
    FINGERS.forEach((f, fi) => SEGS[side + f].forEach((bone, j) => {
      const n = this.humanoid.getNormalizedBoneNode(bone as VRMHumanBoneName);
      if (!n) return;
      const axis = this.fingerAxis.get(bone);
      if (mode === 'bind' || (f === 'Thumb' && j === 0) || !axis) { n.quaternion.slerp(I, w); return; }
      n.quaternion.slerp(axisAngle(axis, GRIP[fi][j]), w);
    }));
  }

  /** Apply a set of normalized local rotations (used directly by the OBS output page). */
  applyBones(bones: Record<string, [number, number, number, number]>) {
    for (const name in bones) {
      const n = this.humanoid.getNormalizedBoneNode(name as VRMHumanBoneName);
      if (n) n.quaternion.fromArray(bones[name]);
    }
  }
}
