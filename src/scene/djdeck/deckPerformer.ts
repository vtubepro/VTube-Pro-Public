// DJ decks: the performer behind the decks plays them. Each hand gets a world target from the deck engine
// (deckScene.ts: which control, where its cap / platter / pad is right now) and a two-bone IK puts the wrist there:
//   jog = palm flat on the platter, moving with it (scratch / nudge on the rim); fader = fingers on the cap, following
//   it; knob = a pinch from above, twisting with the knob; pad / button = a fingertip tap.
// Between moves the hands go to a groove pose over the decks (or back to the tracked arms), with a head nod on the beat
// and a little bounce. Face, head and expressions stay tracked: this layer runs AFTER the tracking (it wraps the
// runtime's pose hook, like the walk cycle), changes only the arms / hands / fingers + a few degrees of spine and neck,
// and blends every change in and out. The wrist never goes below the gear's top (+ a margin), and it rises over the
// gear while it travels between far-apart controls, so a hand never passes through the decks.
import * as THREE from 'three';
import type { VRMHumanBoneName } from '@pixiv/three-vrm';
import type { AvatarRuntime } from '../../avatar/AvatarRuntime.ts';
import type { SceneActor } from '../actor.ts';
import type { PartKind } from '../../../shared/djDeck/layout.ts';

export type HandSide = 'left' | 'right';
export interface HandTarget {
  /** 0..1 how much the hand is on its control (eased by the engine). */
  w: number;
  kind: PartKind | null;
  /** World contact point (cap top / pad / platter touch point). */
  contact: THREE.Vector3;
  /** Jogs: platter centre (world, top) + radius (world m); the touch point is `contact`. */
  center: THREE.Vector3;
  radius: number;
  /** Nudging on the rim (side of the jog). */
  rim: boolean;
  /** 0..1 a button / pad is being pressed. */
  press: number;
  /** Knob twist (rad, about the finger axis). */
  roll: number;
  /** The groove / rest point for this hand (world). */
  idle: THREE.Vector3;
}
export interface PerformInput {
  /** 0..1: at the decks (the whole layer). */
  on: number;
  /** 1 = the groove pose holds the arms between moves; 0 = the tracked arms come back. */
  idleHold: number;
  hands: Record<HandSide, HandTarget>;
  /** World up of the gear, its top height (world y) and the direction from the DJ toward the gear (horizontal). */
  topY: number;
  fwd: THREE.Vector3;
  /** Gear scale (world metres per reference metre) for margins. */
  s: number;
  /** Beat position (continuous) and whether music is playing (the nod / bounce). */
  beat: number;
  music: number;
}

const v4 = new THREE.Vector3(), v5 = new THREE.Vector3();
const q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion(), q3 = new THREE.Quaternion();
const m1 = new THREE.Matrix4(), m2 = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);
const FINGERS = ['Index', 'Middle', 'Ring', 'Little'] as const;
const SEGS = ['Proximal', 'Intermediate', 'Distal'] as const;

/** Elbow for shoulder S → wrist W with bone lengths, bent toward `pole` (src/tracking/bodySolver.ts twoBoneIK). */
export function twoBoneElbow(S: THREE.Vector3, W: THREE.Vector3, Lu: number, Lf: number, pole: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  const d = v5.copy(W).sub(S);
  let D = d.length();
  if (D < 1e-5) return out.copy(S).addScaledVector(pole, Lu);
  const u = d.divideScalar(D);
  D = Math.min(D, (Lu + Lf) * 0.999); D = Math.max(D, Math.abs(Lu - Lf) + 1e-3);
  const a = (Lu * Lu - Lf * Lf + D * D) / (2 * D);
  const h = Math.sqrt(Math.max(0, Lu * Lu - a * a));
  const p = v4.copy(pole).addScaledVector(u, -pole.dot(u));
  if (p.lengthSq() < 1e-8) p.set(0, -1, 0).addScaledVector(u, u.y);
  p.normalize();
  return out.copy(S).addScaledVector(u, a).addScaledVector(p, h);
}

/** Rotation taking the frame (a0, b0) onto (a1, b1) (a = primary axis, b = secondary, both made orthonormal). A
 *  secondary parallel to its primary (no plane) falls back to any perpendicular, never a NaN. */
const af = { x0: new THREE.Vector3(), y0: new THREE.Vector3(), z0: new THREE.Vector3(), x1: new THREE.Vector3(), y1: new THREE.Vector3(), z1: new THREE.Vector3() };
const X_AXIS = new THREE.Vector3(1, 0, 0), Z_AXIS = new THREE.Vector3(0, 0, 1), DOWN = new THREE.Vector3(0, -1, 0);
function basisZ(x: THREE.Vector3, b: THREE.Vector3, out: THREE.Vector3) {
  out.crossVectors(x, b);
  if (out.lengthSq() < 1e-10) out.crossVectors(x, Math.abs(x.y) < 0.9 ? UP : X_AXIS);
  return out.normalize();
}
function alignFrames(a0: THREE.Vector3, b0: THREE.Vector3, a1: THREE.Vector3, b1: THREE.Vector3, out: THREE.Quaternion) {
  const { x0, y0, z0, x1, y1, z1 } = af;
  x0.copy(a0).normalize(); basisZ(x0, b0, z0); y0.crossVectors(z0, x0);
  m1.makeBasis(x0, y0, z0);
  x1.copy(a1).normalize(); basisZ(x1, b1, z1); y1.crossVectors(z1, x1);
  m2.makeBasis(x1, y1, z1);
  return out.setFromRotationMatrix(m2.multiply(m1.transpose()));
}

/** Per-frame scratch (the pose runs every frame: nothing is allocated in it). */
const P = {
  fwd: new THREE.Vector3(), left: new THREE.Vector3(), Sh: new THREE.Vector3(), El: new THREE.Vector3(), Wr: new THREE.Vector3(), Md: new THREE.Vector3(),
  ctl: new THREE.Vector3(), handFwd: new THREE.Vector3(), flat: new THREE.Vector3(), toC: new THREE.Vector3(), target: new THREE.Vector3(), acc: new THREE.Vector3(),
  pole: new THREE.Vector3(), E: new THREE.Vector3(), restU: new THREE.Vector3(), restL: new THREE.Vector3(), restH: new THREE.Vector3(), dU: new THREE.Vector3(), dL: new THREE.Vector3(),
  fdir: new THREE.Vector3(), palmDir: new THREE.Vector3(), a0: new THREE.Vector3(), b0: new THREE.Vector3(), a1: new THREE.Vector3(), b1: new THREE.Vector3(), wristNow: new THREE.Vector3(),
  npQi: new THREE.Quaternion(), parentW: new THREE.Quaternion(), upW: new THREE.Quaternion(), upWb: new THREE.Quaternion(), loW: new THREE.Quaternion(), loWb: new THREE.Quaternion(), rot: new THREE.Quaternion(),
};
/** Bone names per side, built once (no string building per frame). */
const BONES = Object.fromEntries((['left', 'right'] as const).map((sd) => [sd, {
  ua: `${sd}UpperArm`, la: `${sd}LowerArm`, hd: `${sd}Hand`, mid: `${sd}MiddleProximal`,
  fingers: FINGERS.map((f) => SEGS.map((g) => `${sd}${f}${g}`)),
}])) as Record<HandSide, { ua: string; la: string; hd: string; mid: string; fingers: string[][] }>;
const CURL = { jog: [0.12, 0.12, 0.14, 0.16], knob: [0.5, 0.55, 0.75, 0.85], fader: [0.35, 0.4, 0.75, 0.85], tap: [0.08, 0.95, 1.05, 1.1] } as const;

interface HandSim { pos: THREE.Vector3; vel: THREE.Vector3; init: boolean; w: number; reach: number }

export class DeckPerformer {
  private base: ((rt: AvatarRuntime, dt: number) => void) | null = null;
  private rt: AvatarRuntime | null = null;
  private readonly wrap: (rt: AvatarRuntime, dt: number) => void;
  private input: PerformInput | null = null;
  private sim: Record<HandSide, HandSim> = { left: { pos: new THREE.Vector3(), vel: new THREE.Vector3(), init: false, w: 0, reach: 0 }, right: { pos: new THREE.Vector3(), vel: new THREE.Vector3(), init: false, w: 0, reach: 0 } };
  private on = 0;
  /** Debug / tests: last wrist targets and achieved wrist positions (world), the reach ratio. */
  readonly last: Record<HandSide, { target: [number, number, number]; wrist: [number, number, number]; kind: string | null; w: number; err: number }> = {
    left: { target: [0, 0, 0], wrist: [0, 0, 0], kind: null, w: 0, err: 0 }, right: { target: [0, 0, 0], wrist: [0, 0, 0], kind: null, w: 0, err: 0 } };
  lean = 0;

  constructor(readonly actor: SceneActor) {
    this.wrap = (rt, dt) => { this.base?.(rt, dt); try { this.pose(rt, dt); } catch (e) { console.warn('[djdeck] pose', e); } };
  }

  /** Every frame (the engine): the targets; keeps this layer installed on the actor's avatar. */
  update(i: PerformInput) {
    this.input = i;
    const rt = this.actor.runtime;
    if (rt !== this.rt) { this.release(); this.rt = rt; }
    if (rt && rt.poseHook !== this.wrap) { this.base = rt.poseHook; rt.poseHook = this.wrap; }
    (this.actor as unknown as { djDeckOwns?: boolean }).djDeckOwns = i.on > 0.01 && i.idleHold > 0.5;
  }
  release() {
    if (this.rt && this.rt.poseHook === this.wrap) this.rt.poseHook = this.base;
    this.base = null; this.rt = null;
    (this.actor as unknown as { djDeckOwns?: boolean }).djDeckOwns = false;
    this.sim.left.init = this.sim.right.init = false;
  }

  private pose(rt: AvatarRuntime, dt: number) {
    const I = this.input, h = rt.humanoid;
    if (!I || !h) return;
    this.on += (I.on - this.on) * Math.min(1, dt / 0.35);
    if (this.on < 0.003) { this.sim.left.init = this.sim.right.init = false; return; }
    const n = (b: string) => h.getNormalizedBoneNode(b as VRMHumanBoneName);
    const normParent = h.normalizedHumanBonesRoot.parent ?? h.normalizedHumanBonesRoot;
    const npQi = normParent.getWorldQuaternion(P.npQi).invert();
    dt = Math.min(0.05, Math.max(1e-4, dt));
    // ---- the groove: a nod on the beat + a small bounce (additive, on top of the tracked head)
    const ph = I.beat - Math.floor(I.beat);
    const pump = Number.isFinite(I.beat) ? Math.exp(-ph * 6) : 0;
    const g = this.on * I.music;
    const neck = n('neck') ?? n('head'), spine = n('spine'), chest = n('chest') ?? n('upperChest');
    // lean in a little when a hand reaches far
    const want = Math.max(this.sim.left.reach * this.sim.left.w, this.sim.right.reach * this.sim.right.w);
    this.lean += ((Math.min(1, Math.max(0, (want - 0.86) / 0.12))) - this.lean) * Math.min(1, dt / 0.25);
    if (spine) spine.quaternion.premultiply(q1.setFromAxisAngle(X_AXIS, this.on * (0.02 * g * pump + 0.16 * this.lean)));
    if (chest) chest.quaternion.premultiply(q1.setFromAxisAngle(X_AXIS, this.on * 0.012 * g * pump));
    if (neck) neck.quaternion.premultiply(q1.setFromAxisAngle(X_AXIS, 0.085 * g * pump - 0.04 * this.on * this.lean));
    // actor basis (world): forward (toward the gear), up, the actor's left
    const fwd = P.fwd.copy(I.fwd).setY(0); if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1); fwd.normalize();
    const left = P.left.crossVectors(UP, fwd).normalize();   // (facing +Z, up +Y → left = +X)
    for (let si = 0; si < 2; si++) {
      const side: HandSide = si === 0 ? 'left' : 'right';
      const T = I.hands[side], S = this.sim[side], B = BONES[side];
      const ua = n(B.ua), la = n(B.la), hd = n(B.hd);
      if (!ua || !la || !hd || la.position.lengthSq() < 1e-10 || hd.position.lengthSq() < 1e-10) continue;
      const mid = n(B.mid);
      const md = mid && mid.position.lengthSq() > 1e-10 ? mid : null;
      (md ?? hd).updateWorldMatrix(true, false);
      const Sh = ua.getWorldPosition(P.Sh), El = la.getWorldPosition(P.El), Wr = hd.getWorldPosition(P.Wr);
      const Lu = Sh.distanceTo(El), Lf = El.distanceTo(Wr);
      if (Lu < 1e-4 || Lf < 1e-4) continue;
      const palm = md ? md.getWorldPosition(P.Md).distanceTo(Wr) : Lf * 0.36;
      const finger = palm * 1.9;
      const sgn = side === 'left' ? 1 : -1;
      // ---- the wrist target for the control
      const ctl = P.ctl.set(0, 0, 0), handFwd = P.handFwd.set(0, 0, 0);   // (handFwd: the finger direction, world)
      const kind = T.kind;
      const flat = P.flat.copy(T.contact).sub(Sh).setY(0);
      if (flat.lengthSq() < 1e-6) flat.copy(fwd);
      flat.normalize();
      let pitch = 0.6;   // finger direction below horizontal (rad)
      if (kind === 'jog') {
        // palm on the platter: the hand's centre on the touch point, fingers toward the platter's far side
        const toC = P.toC.copy(T.center).sub(T.contact).setY(0);
        if (toC.lengthSq() > 1e-8) toC.normalize(); else toC.copy(flat);
        handFwd.copy(toC); pitch = T.rim ? 0.55 : 0.12;
        ctl.copy(T.contact).addScaledVector(toC, -palm * (T.rim ? 0.9 : 0.55)).addScaledVector(UP, palm * (T.rim ? 0.3 : 0.22));
      } else if (kind === 'knob' || kind === 'encoder') {
        handFwd.copy(flat); pitch = 1.05;
        ctl.copy(T.contact).addScaledVector(flat, -finger * 0.42).addScaledVector(UP, finger * 0.8);
      } else if (kind === 'fader' || kind === 'tempo' || kind === 'xfader') {
        handFwd.copy(flat); pitch = 0.75;
        ctl.copy(T.contact).addScaledVector(flat, -finger * 0.62).addScaledVector(UP, finger * 0.6);
      } else if (kind) {
        // a tap: the fingertip comes down on the pad / button
        handFwd.copy(flat); pitch = 0.82;
        ctl.copy(T.contact).addScaledVector(flat, -finger * 0.62).addScaledVector(UP, finger * 0.68 + 0.012 * I.s * (1 - T.press));
      }
      // the groove / rest point → the control
      const wC = kind ? T.w : 0;
      const target = P.target.copy(T.idle).lerp(ctl, wC);
      // ---- the hand travels (a quick spring) and rises over the gear when far from where it is going
      if (!S.init) { S.pos.copy(target); S.vel.set(0, 0, 0); S.init = true; }
      const om = 26, k = om * om, c = 2 * om;
      P.acc.copy(target).sub(S.pos).multiplyScalar(k).addScaledVector(S.vel, -c);
      S.vel.addScaledVector(P.acc, dt); S.pos.addScaledVector(S.vel, dt);
      const away = Math.hypot(target.x - S.pos.x, target.z - S.pos.z);
      const floorY = I.topY + 0.028 * I.s + Math.min(0.09 * I.s, away * 0.6);
      if (S.pos.y < floorY) { S.pos.y = floorY; if (S.vel.y < 0) S.vel.y = 0; }
      const W = S.pos;
      // ---- weight: the control's weight, or the groove's hold (idle mode)
      S.w += ((Math.max(wC, I.idleHold)) - S.w) * Math.min(1, dt / 0.18);
      const w = S.w * this.on;
      S.reach = W.distanceTo(Sh) / Math.max(1e-4, Lu + Lf);
      if (w < 0.002) continue;
      // ---- two-bone IK: elbow out, down and back
      const pole = P.pole.set(0, 0, 0).addScaledVector(left, sgn * 0.38).addScaledVector(UP, -0.85).addScaledVector(fwd, -0.3).normalize();
      const E = twoBoneElbow(Sh, W, Lu, Lf, pole, P.E);
      const parentW = worldQ(ua.parent, normParent, P.parentW);
      const restU = P.restU.copy(la.position).normalize(), restL = P.restL.copy(hd.position).normalize();
      const dU = P.dU.copy(E).sub(Sh).normalize().applyQuaternion(npQi);
      const upW = P.upW.setFromUnitVectors(P.a0.copy(restU).applyQuaternion(parentW), dU).multiply(parentW);
      ua.quaternion.slerp(q2.copy(parentW).invert().multiply(upW), w);
      const upWb = P.upWb.copy(parentW).multiply(ua.quaternion);
      const dL = P.dL.copy(W).sub(E).normalize().applyQuaternion(npQi);
      const loW = P.loW.setFromUnitVectors(P.a0.copy(restL).applyQuaternion(upWb), dL).multiply(upWb);
      la.quaternion.slerp(q2.copy(upWb).invert().multiply(loW), w);
      const loWb = P.loWb.copy(upWb).multiply(la.quaternion);
      // ---- the hand: fingers along handFwd (pitched down), palm facing down (twisted for a knob)
      const restH = md ? P.restH.copy(md.position).normalize() : P.restH.copy(restL);
      if (kind && wC > 0.01) {
        const fdir = P.fdir.copy(handFwd).multiplyScalar(Math.cos(pitch)).addScaledVector(UP, -Math.sin(pitch)).normalize();
        const palmDir = P.palmDir.copy(DOWN).addScaledVector(fdir, fdir.y).normalize();
        if (T.roll) palmDir.applyAxisAngle(fdir, T.roll * sgn);
        P.a1.copy(fdir).applyQuaternion(npQi); P.b1.copy(palmDir).applyQuaternion(npQi);
        P.a0.copy(restH).applyQuaternion(loWb); P.b0.copy(DOWN).applyQuaternion(loWb);   // (VRM T-pose: palms down)
        const handW = alignFrames(P.a0, P.b0, P.a1, P.b1, P.rot).multiply(loWb);
        hd.quaternion.slerp(q3.copy(loWb).invert().multiply(handW), w * wC);
        // ---- fingers: flat on a jog, pinching a knob, resting on a cap, the index finger out for a tap
        const tap = kind === 'button' || kind === 'pad';
        const curl = kind === 'jog' ? CURL.jog : kind === 'knob' || kind === 'encoder' ? CURL.knob : tap ? CURL.tap : CURL.fader;
        for (let fi = 0; fi < 4; fi++) {
          const amt = fi === 0 && tap ? curl[0] + 0.1 * T.press : curl[fi];
          for (let sg = 0; sg < 3; sg++) {
            const b = n(B.fingers[fi][sg]); if (!b) continue;
            q1.setFromAxisAngle(Z_AXIS, -sgn * amt * (sg === 0 ? 0.9 : 0.75));
            b.quaternion.slerp(q1, w * wC);
          }
        }
      }
      // what we asked for vs. where the hand bone really is now (the solved rotations, not the IK's own maths)
      hd.updateWorldMatrix(true, false);
      const wristNow = hd.getWorldPosition(P.wristNow);
      const L = this.last[side];
      L.target[0] = +W.x.toFixed(4); L.target[1] = +W.y.toFixed(4); L.target[2] = +W.z.toFixed(4);
      L.wrist[0] = +wristNow.x.toFixed(4); L.wrist[1] = +wristNow.y.toFixed(4); L.wrist[2] = +wristNow.z.toFixed(4);
      L.kind = kind; L.w = +w.toFixed(3); L.err = +wristNow.distanceTo(W).toFixed(4);
    }
  }
}

function worldQ(node: THREE.Object3D | null, stop: THREE.Object3D | null, out: THREE.Quaternion) {
  out.identity();
  for (let o = node; o && o !== stop; o = o.parent) out.premultiply(o.quaternion);
  return out;
}
