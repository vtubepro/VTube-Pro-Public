// Procedural locomotion pose layer (walk cycle, idle weight shift, hop for leg-less avatars).
//
// Works on ANY rig the app supports through the VRM-normalized humanoid (VRM, name-mapped glb humanoids,
// soft rigs): rest joint positions + the avatar→normalized rotation are measured once at load
// (actor.ts measureRest), so the same code drives A-pose, T-pose and creature rigs. Runs as the actor's
// `extraPose` inside AvatarRuntime.poseHook: AFTER the tracking wrote its bones and the engine's seated legs,
// BEFORE the rig update. So face / expressions / mouth are untouched, and tracked bones are blended:
//   - legs: two-bone IK with the feet planted — the stride phase is the distance walked, so no sliding
//   - hips: bob (whatever keeps the stance leg reachable), sway over the stance foot, pelvis twist + roll
//   - torso: slight forward lean, chest counter-twist (tracked torso follow damped while walking)
//   - arms: counter-swing, overriding the tracked arms by `armW` (the mover blends it back after arriving)
//   - head: tracked head rotation scaled down by `headW` (≈50% while walking)
//   - no legs / no humanoid: a hop-bob glide (body offset + tilt on the actor)
// Inputs are written every frame by the mover; the body offset / tilt go to actor.offset / actor.tilt.
import * as THREE from 'three';
import type { VRMHumanBoneName } from '@pixiv/three-vrm';
import type { AvatarRuntime } from '../avatar/AvatarRuntime.ts';
import type { RestMetrics, SceneActor } from './actor.ts';
import type { GaitFamily } from '../../shared/gait.ts';
import type { MechSample } from '../avatar/mech.ts';

const I = new THREE.Quaternion();
const X = new THREE.Vector3(1, 0, 0), Z = new THREE.Vector3(0, 0, 1);
const TAU = Math.PI * 2;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number) => { const k = clamp01(v); return k * k * (3 - 2 * k); };
const frac = (v: number) => v - Math.floor(v);

/** Stance share of a stride (feet planted). */
const STANCE = 0.6;

interface LegGeo { side: 1 | -1; hip: THREE.Vector3; knee: THREE.Vector3; ankle: THREE.Vector3; a: number; b: number; ankleH: number; restThighN: THREE.Vector3; restShinN: THREE.Vector3; hasFoot: boolean }
interface ArmGeo { side: 1 | -1; restUpperN: THREE.Vector3; restLowerN: THREE.Vector3 }

/** Per-rig geometry, measured once per loaded runtime. */
interface Rig {
  rest: RestMetrics;
  toNorm: THREE.Quaternion;
  fromNorm: THREE.Quaternion;
  legs: { l: LegGeo; r: LegGeo; L: number; pivot: THREE.Vector3 } | null;
  arms: ArmGeo[];
  /** Full stride (two steps) in anchor units. */
  cycle: number;
}

function buildRig(rt: AvatarRuntime, rest: RestMetrics): Rig | null {
  const h = rt.humanoid;
  if (!h || !rest.toNorm) return null;
  const toNorm = rest.toNorm.clone(), fromNorm = toNorm.clone().invert();
  const J = rest.joints;
  const has = (b: string) => !!h.getNormalizedBoneNode(b as VRMHumanBoneName) && !!J[b];
  const leg = (s: 'left' | 'right'): LegGeo | null => {
    const u = `${s}UpperLeg`, l = `${s}LowerLeg`, f = `${s}Foot`;
    if (!has(u) || !has(l)) return null;
    const hip = J[u], knee = J[l];
    const hasFoot = has(f);
    const ankle = hasFoot ? J[f] : knee.clone().add(knee.clone().sub(hip).multiplyScalar(0.9));
    const a = hip.distanceTo(knee), b = knee.distanceTo(ankle);
    if (a < 1e-4 || b < 1e-4) return null;
    return {
      side: s === 'left' ? 1 : -1, hip, knee, ankle, a, b, ankleH: Math.max(0, ankle.y - rest.floorY), hasFoot,
      restThighN: knee.clone().sub(hip).normalize().applyQuaternion(toNorm),
      restShinN: ankle.clone().sub(knee).normalize().applyQuaternion(toNorm),
    };
  };
  const l = leg('left'), r = leg('right');
  // legs need to (nearly) reach the floor, else it's a creature with dangly bits: hop instead
  const legsOk = !!l && !!r && [l, r].every((g) => g.ankleH < 0.25 * (g.a + g.b) + 0.02 * rest.height);
  const legs = legsOk ? { l: l!, r: r!, L: (l!.a + l!.b + r!.a + r!.b) / 2, pivot: J.hips?.clone() ?? l!.hip.clone().add(r!.hip).multiplyScalar(0.5) } : null;
  const arms: ArmGeo[] = [];
  for (const s of ['left', 'right'] as const) {
    const u = `${s}UpperArm`, lo = `${s}LowerArm`, hd = `${s}Hand`;
    if (!has(u) || !has(lo)) continue;
    const e = J[lo], w = has(hd) ? J[hd] : null;
    const du = e.clone().sub(J[u]), dl = w ? w.clone().sub(e) : du.clone();
    if (du.lengthSq() < 1e-10 || dl.lengthSq() < 1e-10) continue;
    arms.push({ side: s === 'left' ? 1 : -1, restUpperN: du.normalize().applyQuaternion(toNorm), restLowerN: dl.normalize().applyQuaternion(toNorm) });
  }
  // short legs (frogs, chibis) take quicker, relatively longer steps: a waddle rather than a crawl
  const cycle = legs ? Math.max(legs.L * 1.45, rest.height * 0.23) : rest.height * 0.42;
  return { rest, toNorm, fromNorm, legs, arms, cycle };
}

const rigs = new WeakMap<AvatarRuntime, Rig | null>();

/** Hop cycle (anchor units) for leg-less avatars. */
const hopCycle = (rest: RestMetrics) => rest.height * 0.42;

export class Locomotion {
  // ---- inputs (the mover writes these every frame)
  /** Distance walked (room metres) — drives the stride phase. */
  dist = 0;
  /** 0..1 stride amplitude (0 = standing still). */
  gait = 0;
  /** 0..1 procedural arm swing over the tracked arms. */
  armW = 0;
  /** 0..1 how much tracked head rotation is taken away (0.5 = half of it while walking). */
  headW = 0;
  /** 0..1 idle weight shift (standing at a stand spot). */
  idle = 0;
  /** Walking backwards (sitting down / standing up steps). */
  back = false;
  /** 0..1 foot travel (0 = stepping on the spot while turning). */
  stride = 1;
  /** Walking machines: the gait family of the current walk segment (the mover's pick; null = the profile's). */
  family: GaitFamily | null = null;
  /** Walking machines: actor.lift's WORLD matrix at a job distance (room metres), so feet plant exactly on any path. */
  poseAt: ((sRoom: number) => THREE.Matrix4 | null) | null = null;
  private poseWrap = (dAnchor: number) => (this.poseAt ? this.poseAt(dAnchor * (this.actor.scale || 1)) : null);
  /** Walking machines: the mover's inputs at any instant of its clock (pure: dist in room metres) and the clock time of
   *  this frame's inputs; the machine runs its steps on fixed ticks of that clock (src/avatar/mech.ts), so every page
   *  shows the same steps at any frame rate. null / NaN = once a frame. */
  sampleAt: ((clock: number) => MechSample | null) | null = null;
  clock = NaN;
  /** Walking machines: the room's walkable height at a world (x, z) (FLOOR_* levels; null = flat). */
  floorAt: ((x: number, z: number) => number) | null = null;
  private clockNow = () => this.clock;
  private sampleWrap = (T: number): MechSample | null => {
    const s = this.sampleAt ? this.sampleAt(T) : null;
    if (!s) return null;
    const k = this.actor.scale || 1, pa = s.poseAt;
    return { ...s, dist: s.dist / k, poseAt: pa ? (d: number) => pa(d * k) : null };
  };

  private t = Math.random() * 10;
  private q1 = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();
  private q3 = new THREE.Quaternion();
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private v3 = new THREE.Vector3();
  private e = new THREE.Euler();

  constructor(readonly actor: SceneActor) {}

  private rig(rt: AvatarRuntime): Rig | null {
    let r = rigs.get(rt);
    if (r === undefined && this.actor.rest) { r = buildRig(rt, this.actor.rest); rigs.set(rt, r); }
    return r ?? null;
  }

  /** Walking speed cap (room m/s) so short legs don't stride faster than ~4.4 steps / s (walking machines: their gait's
   *  cycle per period, src/avatar/mech.ts). */
  maxSpeed(): number {
    const a = this.actor, rt = a.runtime;
    if (rt?.mech) return rt.mech.maxSpeed(a.scale);
    const r = rt ? this.rig(rt) : null;
    const cycle = r ? r.cycle : a.rest ? hopCycle(a.rest) : 0.6;
    return 2.2 * cycle * a.scale;
  }
  /** Does this avatar walk on legs (else it hops)? */
  walks(): boolean { const rt = this.actor.runtime; return !!rt && (!!rt.mech || !!this.rig(rt)?.legs); }
  /** On-the-spot turn rate (rad/s): a walking machine turns slowly; everyone else `def`. */
  turnRate(def: number): number { return this.actor.runtime?.mech?.turnRate ?? def; }
  /** Room metres of stepping per radian turned on the spot: a walking machine's feet travel its footprint radius. */
  turnStep(def: number): number { const m = this.actor.runtime?.mech; return m ? m.turnStep(this.actor.scale) : def; }
  /** Room metres from a walking machine's turning centre to its farthest foot (0 = everyone else). */
  footprint(): number { const m = this.actor.runtime?.mech; return m ? m.footprintRoom(this.actor.scale) : 0; }
  /** Seconds a walking machine stands up before its first step (0 = everyone else). */
  spool(): number { return this.actor.runtime?.mech?.spool ?? 0; }
  /** Seconds a walking machine settles (feet home, body down) after arriving (0 = everyone else). */
  settle(): number { return this.actor.runtime?.mech?.settle ?? 0; }
  /** The speed (room m/s, at most vcap) and gait family a walk of `len` room metres should use (walking machines: short
   *  trips walk one foot at a time, long ones hustle; everyone else: vcap, no family). */
  plan(len: number, vcap: number): { v: number; family: GaitFamily | null } {
    const m = this.actor.runtime?.mech;
    return m ? m.planFor(len, this.actor.scale, vcap) : { v: vcap, family: null };
  }

  /** The pose layer (actor.extraPose). */
  apply(rt: AvatarRuntime, dt: number) {
    this.t += dt;
    const a = this.actor;
    const g = this.gait, idle = this.idle * (1 - g);
    a.offset.set(0, 0, 0);
    a.tilt.identity();
    // walking machines (src/avatar/mech.ts) walk their own legs from these inputs: no hop, no arm swing, no head damping
    // (the pilot's head is always tracked; the hands go onto the sticks by the arm weight)
    if (rt.mech) {
      rt.mech.feed({ dist: this.dist / (a.scale || 1), gait: g, stride: this.stride, back: this.back, travel: this.armW, family: this.family, poseAt: this.poseAt ? this.poseWrap : null, mount: a.lift,
        at: this.sampleAt ? this.sampleWrap : null, clock: this.clock, clockAt: this.clockNow, floorAt: this.floorAt });
      return;
    }
    if (g < 1e-3 && this.armW < 1e-3 && this.headW < 1e-3 && idle < 1e-3) return;
    const h = rt.humanoid;
    const rig = this.rig(rt);
    const k = a.scale || 1;
    if (!h || !rig) { this.hop(g, k); return; }
    const { toNorm, fromNorm } = rig;
    const N = (b: string) => h.getNormalizedBoneNode(b as VRMHumanBoneName);
    /** avatar-space rotation → normalized space (into q). */
    const qn = (q: THREE.Quaternion, out: THREE.Quaternion) => out.copy(toNorm).multiply(q).multiply(fromNorm);
    const pre = (bone: string, qa: THREE.Quaternion) => { const n = N(bone); if (n) n.quaternion.premultiply(qn(qa, this.q3)); };

    const cycle = rig.cycle;
    const phi = (this.dist / k) / cycle;                 // stride cycles
    const c = Math.cos(TAU * phi), s = Math.sin(TAU * phi);
    const dir = this.back ? -1 : 1;

    // ---- head: take tracked rotation down while walking (face / eyes / mouth keep tracking)
    if (this.headW > 1e-3) for (const b of ['neck', 'head']) { const n = N(b); if (n) n.quaternion.slerp(I, this.headW); }

    // ---- pelvis + torso
    const L = rig.legs?.L ?? rig.rest.height * 0.45;
    const twist = -0.09 * g * c * dir;                      // swing-side hip goes forward with its leg
    const stanceL = Math.cos(TAU * (phi - STANCE / 2));       // +1 mid left stance … -1 mid right stance
    const roll = 0.045 * g * stanceL + 0.03 * idle * Math.sin(this.t * 1.1);
    const lean = (0.075 * g + 0.02 * g * Math.abs(s)) * dir;
    const pelvis = this.q1.setFromEuler(this.e.set(0, twist, roll, 'YXZ'));
    if (rig.legs) pre('hips', pelvis);
    // tracked torso follow (leaning into the webcam) is mostly taken away while walking
    for (const b of ['spine', 'chest', 'upperChest']) { const n = N(b); if (n && g > 1e-3) n.quaternion.slerp(I, 0.7 * g); }
    pre('spine', this.q2.setFromEuler(this.e.set(lean * 0.6, -twist * 0.6, -roll * 0.5, 'YXZ')));
    const top = N('upperChest') ? 'upperChest' : N('chest') ? 'chest' : null;
    if (top) pre(top, this.q2.setFromEuler(this.e.set(lean * 0.4, -twist * 0.9, -roll * 0.4, 'YXZ')));
    // keep the eyes level-ish against the lean
    if (g > 1e-3 && N('head')) pre('head', this.q2.setFromAxisAngle(X, -lean * 0.7));

    // ---- legs
    if (rig.legs) this.legs(rt, rig, g, idle, phi, pelvis, k, L);
    else this.hop(g, k);

    // ---- arms: counter-swing (left arm forward with the right leg)
    if (this.armW > 1e-3 && rig.arms.length) this.arms(rt, rig, g, c);
  }

  private hop(g: number, k: number) {
    const a = this.actor;
    const rest = a.rest;
    if (!rest || g < 1e-3) return;
    const ph = (this.dist / k) / hopCycle(rest);
    const up = Math.abs(Math.sin(Math.PI * ph));
    a.offset.y = rest.height * 0.07 * g * up * k;
    const lean = (0.1 + 0.08 * (1 - up)) * g * (this.back ? -1 : 1);
    const wob = 0.07 * g * Math.sin(Math.PI * ph);
    a.tilt.setFromEuler(this.e.set(lean, 0, wob, 'YXZ'));
  }

  private legs(rt: AvatarRuntime, rig: Rig, g: number, idle: number, phi: number, pelvis: THREE.Quaternion, k: number, L: number) {
    const h = rt.humanoid!;
    const { toNorm } = rig;
    const legs = rig.legs!;
    const a = this.actor;
    const floor = rig.rest.floorY;
    const R = STANCE * rig.cycle * 0.5 * g * this.stride;                  // foot travel either side of the hip while planted
    const lift = L * (0.11 * g);
    const dir = this.back ? -1 : 1;
    // targets (anchor space, before the body offset)
    const tgt = [this.v1, this.v2];
    const pitch = [0, 0];
    const sides = [legs.l, legs.r];
    const relax = [0, 0];
    const shift = idle * Math.sin(this.t * 0.9);               // idle: weight over one foot, then the other
    for (let i = 0; i < 2; i++) {
      const lg = sides[i];
      const p = frac(phi + (i === 0 ? 0 : 0.5));
      let z: number, y = 0;
      if (p < STANCE) z = R * (1 - (2 * p) / STANCE);
      else {
        const u = (p - STANCE) / (1 - STANCE);
        z = -R + 2 * R * smooth(u);
        y = lift * Math.sin(Math.PI * u);
        pitch[i] = g * (u < 0.5 ? 0.35 * Math.sin(Math.PI * u * 2) : -0.2 * Math.sin(Math.PI * (u - 0.5) * 2));
      }
      if (p < STANCE && p > STANCE * 0.7) pitch[i] = 0.25 * g * ((p - STANCE * 0.7) / (STANCE * 0.3)); // heel lifts (toe-off)
      // idle: the unloaded leg relaxes (knee forward, heel a touch up)
      relax[i] = idle * clamp01((i === 0 ? -shift : shift) * 1.4);
      tgt[i].set(lg.ankle.x - lg.side * 0.12 * (lg.ankle.x - lg.hip.x) * g, floor + lg.ankleH + y + relax[i] * L * 0.035, lg.ankle.z + z * dir + relax[i] * L * 0.05);
    }
    // body offset: sway over the stance foot + drop so the stance leg can reach (the bob comes out of that)
    const swayX = (0.035 * L * g * Math.cos(Math.PI * 2 * (phi - STANCE / 2))) + 0.03 * L * shift;
    let drop = 0.02 * L * g + 0.012 * L * idle;
    for (let i = 0; i < 2; i++) {
      const lg = sides[i];
      const dx = tgt[i].x - swayX - lg.hip.x, dz = tgt[i].z - lg.hip.z;
      const reach = (lg.a + lg.b) * 0.985;
      const vy = Math.sqrt(Math.max(0, reach * reach - dx * dx - dz * dz));
      drop = Math.max(drop, lg.hip.y - (tgt[i].y) - vy);
    }
    drop = Math.min(drop, L * 0.25);
    a.offset.set(swayX * k, -drop * k, 0);
    // pelvis rotation (avatar space) for the hip joints + knee direction
    const hipsNode = h.getNormalizedBoneNode('hips');
    const hipsN = hipsNode ? worldQ(hipsNode, h.normalizedHumanBonesRoot.parent, this.q2) : this.q2.copy(toNorm).multiply(pelvis).multiply(rig.fromNorm);
    const fwd = this.v3.copy(Z).applyQuaternion(pelvis);
    const lw = Math.max(g, idle);
    for (let i = 0; i < 2; i++) {
      const lg = sides[i];
      const T = tgt[i].sub(_tmpA.set(swayX, -drop, 0));      // floor moves with the body offset
      const H = _tmpB.copy(lg.hip).sub(legs.pivot).applyQuaternion(pelvis).add(legs.pivot);
      const D = _tmpC.copy(T).sub(H);
      let d = D.length();
      if (d < 1e-6) continue;
      D.multiplyScalar(1 / d);
      d = THREE.MathUtils.clamp(d, Math.abs(lg.a - lg.b) + 1e-4, (lg.a + lg.b) * 0.9999);
      const cosA = THREE.MathUtils.clamp((lg.a * lg.a + d * d - lg.b * lg.b) / (2 * lg.a * d), -1, 1);
      const perp = _tmpD.copy(fwd).addScaledVector(D, -fwd.dot(D));
      if (perp.lengthSq() < 1e-8) perp.copy(Z); else perp.normalize();
      const sinA = Math.sqrt(1 - cosA * cosA);
      const thigh = _tmpE.copy(D).multiplyScalar(cosA).addScaledVector(perp, sinA);          // avatar space
      const kneeP = _tmpF.copy(H).addScaledVector(thigh, lg.a);
      const shin = _tmpG.copy(H).addScaledVector(D, d).sub(kneeP).normalize();
      thigh.applyQuaternion(toNorm); shin.applyQuaternion(toNorm);
      const s = lg.side === 1 ? 'left' : 'right';
      const ul = h.getNormalizedBoneNode(`${s}UpperLeg` as VRMHumanBoneName)!, ll = h.getNormalizedBoneNode(`${s}LowerLeg` as VRMHumanBoneName)!;
      const ft = lg.hasFoot ? h.getNormalizedBoneNode(`${s}Foot` as VRMHumanBoneName) : null;
      // world (normalized-root) rotations → locals
      const upW = _q1.setFromUnitVectors(_tmpH.copy(lg.restThighN).applyQuaternion(hipsN), thigh).multiply(hipsN);
      const loW = _q2.setFromUnitVectors(_tmpH.copy(lg.restShinN).applyQuaternion(upW), shin).multiply(upW);
      const upL = _q3.copy(hipsN).invert().multiply(upW);
      ul.quaternion.slerp(upL, lw);
      const loL = _q4.copy(upW).invert().multiply(loW);
      ll.quaternion.slerp(loL, lw);
      if (ft) {
        // foot level with the floor (+ toe-off / swing pitch), in the walking direction
        const fW = _q5.setFromAxisAngle(X, pitch[i] * (this.back ? -1 : 1));
        const fN = _q6.copy(toNorm).multiply(fW).multiply(rig.fromNorm);
        ft.quaternion.slerp(_q7.copy(loW).invert().multiply(fN), lw);
      }
    }
  }

  private arms(rt: AvatarRuntime, rig: Rig, g: number, c: number) {
    const h = rt.humanoid!;
    const { toNorm } = rig;
    const normParent = h.normalizedHumanBonesRoot.parent;
    const amp = 0.38 * g * (this.back ? 0.4 : 1);
    for (const arm of rig.arms) {
      const s = arm.side === 1 ? 'left' : 'right';
      const ua = h.getNormalizedBoneNode(`${s}UpperArm` as VRMHumanBoneName)!, la = h.getNormalizedBoneNode(`${s}LowerArm` as VRMHumanBoneName)!;
      const sw = (arm.side === 1 ? -c : c) * amp;             // + = forward
      // relaxed hang (as the retargeter), swung about the avatar's X axis; elbows bend more when forward
      const du = _tmpA.set(0.2 * arm.side, -0.97, 0.03).normalize().applyAxisAngle(X, -sw).applyQuaternion(toNorm);
      const bend = 0.28 + 0.35 * Math.max(0, sw / 0.38);
      const dl = _tmpB.set(0.07 * arm.side, -1, 0).normalize().applyAxisAngle(X, -sw - bend).applyQuaternion(toNorm);
      // du/dl rotate about +X by -angle: for +Z forward swing, rotate (0,-1,0) toward +Z = about -X
      const parentW = worldQ(ua.parent, normParent, _q1);
      const upW = _q2.setFromUnitVectors(_tmpC.copy(arm.restUpperN).applyQuaternion(parentW), du).multiply(parentW);
      ua.quaternion.slerp(_q3.copy(parentW).invert().multiply(upW), this.armW);
      const upWb = _q4.copy(parentW).multiply(ua.quaternion);
      const loW = _q5.setFromUnitVectors(_tmpC.copy(arm.restLowerN).applyQuaternion(upWb), dl).multiply(upWb);
      la.quaternion.slerp(_q6.copy(upWb).invert().multiply(loW), this.armW);
      const hd = h.getNormalizedBoneNode(`${s}Hand` as VRMHumanBoneName);
      if (hd) hd.quaternion.slerp(I, this.armW * 0.6);
    }
  }
}

/** Rotation of a normalized node relative to the normalized root's parent (rest rotations are identity). */
function worldQ(n: THREE.Object3D | null, stop: THREE.Object3D | null, out: THREE.Quaternion) {
  out.identity();
  for (let o = n; o && o !== stop; o = o.parent) out.premultiply(o.quaternion);
  return out;
}

const _tmpA = new THREE.Vector3(), _tmpB = new THREE.Vector3(), _tmpC = new THREE.Vector3(), _tmpD = new THREE.Vector3();
const _tmpE = new THREE.Vector3(), _tmpF = new THREE.Vector3(), _tmpG = new THREE.Vector3(), _tmpH = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _q4 = new THREE.Quaternion();
const _q5 = new THREE.Quaternion(), _q6 = new THREE.Quaternion(), _q7 = new THREE.Quaternion();
