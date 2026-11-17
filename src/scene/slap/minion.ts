// The slapper: an NPC avatar for the "Slap!" gag (slapScene.ts). Loaded like the chat buddy / the interview sidekick —
// from THIS page's own library (model custody: avatars never cross the party link), no costume / accessories (a profile
// copy, never saved), never a party member, never on a spot. Missing / broken model → the default slapper (SLAPPER_DEFAULT).
//
// Pose: the walk / run cycle comes from locomotion.ts (legs planted by distance, arm swing); on top of it this file
// poses what the gag needs, per frame from a `MinionDrive` the choreography writes: crouch / jump lift, body lean, spine
// bow + twist, two-bone arm IK to hand targets (the wind-up, the slap through the cheek, the bow's hand on the belly,
// clapping the dust off), and the face (angry wind-up, cheeky grin, smug bow) through a synthetic tracking frame.
// Any humanoid rig works (VRM / name-mapped glb): rest joints are measured at load (actor.ts measureRest). A rig
// without arms still hops, leans and bows — it just slaps with its whole body (a head-butt, honestly).
import * as THREE from 'three';
import type { VRMHumanBoneName } from '@pixiv/three-vrm';
import type { AvatarProfile, TrackingFrame } from '../../../shared/types.ts';
import { normalizeProfile } from '../../../shared/defaults.ts';
import { api } from '../../api.ts';
import { AvatarRuntime } from '../../avatar/AvatarRuntime.ts';
import { emptyFrame } from '../../tracking/faceSolver.ts';
import { SceneActor, measureRest } from '../actor.ts';
import { Locomotion } from '../locomotion.ts';
import { tunedBuddy } from '../chatBuddyPlace.ts';

export const SLAPPER_DEFAULT = 'robot';
const I = new THREE.Quaternion();
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0);

/** What the choreography asks of the minion this frame (anchor = the avatar's own space: +X its left, +Z its front). */
export interface MinionDrive {
  /** 0..1 run cycle amplitude; `speed` room m/s (the stride follows the distance). */
  gait: number;
  speed: number;
  /** Forward lean of the whole body (rad; negative = leaning back: a skid). */
  lean: number;
  /** 0..1 knees bent (anticipation, landing). */
  crouch: number;
  /** Lift above the floor (room metres): the jump. */
  jump: number;
  /** Upper-body bow (rad, forward) and twist (rad about the up axis, + = towards its left). */
  bow: number;
  twist: number;
  /** Hand targets in anchor space (null = leave that arm to the run cycle / rest) + blend weight. */
  hands: { left: THREE.Vector3 | null; right: THREE.Vector3 | null; w: number };
  /** Look target in anchor space (null = straight ahead). */
  look: THREE.Vector3 | null;
  /** Face: 0..1 each. */
  angry: number;
  grin: number;
  blink: number;
  jaw: number;
}

export const restDrive = (): MinionDrive => ({ gait: 0, speed: 0, lean: 0, crouch: 0, jump: 0, bow: 0, twist: 0, hands: { left: null, right: null, w: 0 }, look: null, angry: 0, grin: 0, blink: 0, jaw: 0 });

interface ArmRig { side: 1 | -1; S: THREE.Vector3; a: number; b: number; restU: THREE.Vector3; restL: THREE.Vector3 }

export class Minion {
  readonly actor = new SceneActor('npc:slapper', 'Slapper');
  rt: AvatarRuntime | null = null;
  private anchor = new THREE.Group();
  private loading: Promise<void> | null = null;
  private loco: Locomotion | null = null;
  private frame: TrackingFrame = emptyFrame();
  private arms: ArmRig[] = [];
  private toNorm = new THREE.Quaternion();
  private fromNorm = new THREE.Quaternion();
  private head = new THREE.Vector3();
  /** Rest height (anchor units) and the model's own proportions. */
  restH = 1;
  /** Shoulder height as a fraction of the standing height (the slap reaches from there). */
  shoulder = 0.62;
  /** Hand reach (fraction of the height). */
  reach = 0.35;
  /** Buddy-size factor (mascots / chibis smaller than human-proportioned models) — the same rule as the chat buddy. */
  heightK = 0.72;
  loadedId = '';
  fallback = false;
  failed = false;
  disposed = false;
  drive: MinionDrive = restDrive();
  private t = 0;

  constructor(readonly modelId: string) {
    this.actor.mount.name = 'vtp:slap:minion';
  }

  get ready() { return !!this.rt; }
  /** Does it have arms to slap with? */
  get armed() { return this.arms.length > 0; }

  load(): Promise<void> {
    this.loading ??= (async () => {
      let id = this.modelId || SLAPPER_DEFAULT, raw: AvatarProfile | null = null;
      try { raw = await api.avatar(id) as AvatarProfile; } catch { raw = null; }
      if (!raw && id !== SLAPPER_DEFAULT) { this.fallback = true; id = SLAPPER_DEFAULT; raw = await api.avatar(id) as AvatarProfile; }
      if (!raw) throw new Error('no slapper avatar');
      const clean = (p: AvatarProfile): AvatarProfile => ({ ...(normalizeProfile(p) as AvatarProfile), costume: null, accessories: [] });
      let prof = clean(raw), rt: AvatarRuntime;
      try { rt = await AvatarRuntime.load(prof, api.modelUrl(prof), this.anchor); }
      catch (e) {
        if (id === SLAPPER_DEFAULT) throw e;
        console.warn('slap: model failed, using Sprocket', e);
        this.fallback = true; id = SLAPPER_DEFAULT;
        prof = clean(await api.avatar(id) as AvatarProfile);
        rt = await AvatarRuntime.load(prof, api.modelUrl(prof), this.anchor);
      }
      if (this.disposed) { rt.dispose(); return; }
      this.loadedId = id;
      const rest = measureRest(rt);
      this.restH = rest.height;
      this.rt = rt;
      this.actor.attach(this.anchor, rt);
      this.measure();
      // the light show patches every performer's materials (performerLight.ts, a recompile the first time it sees
      // them): the slapper hangs under a performer's mount during the gag, so its materials are marked as already
      // handled — no mid-gag shader compile (a hitch on a live OBS page). The marker is a valid uniform set.
      rt.model.traverse((o) => {
        const mm = (o as THREE.Mesh).material;
        for (const mat of (Array.isArray(mm) ? mm : mm ? [mm] : []) as THREE.Material[]) mat.userData.vtpShow ??= {
          uVtpShowDir: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
          uVtpShowCol: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
          uVtpShowAmb: { value: new THREE.Vector3() }, uVtpShowRim: { value: new THREE.Vector3() }, uVtpShowSpark: { value: 0 }, uVtpShowT: { value: 0 },
        };
      });
      this.loco = new Locomotion(this.actor);
      this.actor.extraPose = (r, dt) => this.pose(r, dt);
      this.actor.shown = false;
      this.actor.sync();
    })().catch((e) => { console.warn('slap: minion load failed', e); this.failed = true; });
    return this.loading;
  }

  private measure() {
    const rt = this.rt!, rest = this.actor.rest!;
    const h = rt.humanoid;
    const H = Math.max(1e-4, rest.height), fy = rest.floorY, J = rest.joints;
    this.arms = [];
    if (h && rest.toNorm) {
      this.toNorm.copy(rest.toNorm); this.fromNorm.copy(rest.toNorm).invert();
      for (const s of ['left', 'right'] as const) {
        const u = J[`${s}UpperArm`], l = J[`${s}LowerArm`], hd = J[`${s}Hand`];
        if (!u || !l || !hd) continue;
        const a = u.distanceTo(l), b = l.distanceTo(hd);
        if (a < H * 0.02 || b < H * 0.02) continue;
        this.arms.push({ side: s === 'left' ? 1 : -1, S: u.clone(), a, b, restU: l.clone().sub(u).normalize().applyQuaternion(this.toNorm), restL: hd.clone().sub(l).normalize().applyQuaternion(this.toNorm) });
      }
    }
    this.head.copy(J.head ?? J.neck ?? new THREE.Vector3(0, fy + H * 0.85, 0));
    const sh = this.arms.length ? this.arms.reduce((m, a) => m + a.S.y, 0) / this.arms.length : fy + H * 0.62;
    this.shoulder = THREE.MathUtils.clamp((sh - fy) / H, 0.3, 0.85);
    this.reach = this.arms.length ? THREE.MathUtils.clamp(Math.max(...this.arms.map((a) => a.a + a.b)) / H, 0.15, 0.5) : 0.18;
    // a big head for the body (mascots, chibis, frogs) stands smaller than a human-proportioned model
    // (a hand-tuned model keeps its tuned size, wherever it was loaded from: chatBuddyPlace.ts tunedBuddy)
    this.heightK = tunedBuddy(this.loadedId, rt.profile.buddy)?.heightK ?? (this.loadedId === SLAPPER_DEFAULT || rest.face.size / H > 0.17 ? 0.72 : 0.86);
  }

  /** Room-space height it is shown at (m). */
  get height() { return this.actor.height; }
  private sized = false;
  setHeight(h: number) { if (!this.sized || Math.abs(this.actor.height - h) > 1e-4) { this.actor.setHeight(h); this.sized = true; } }
  /** Anchor-space point of a world point (for hand / look targets). */
  toAnchor(world: THREE.Vector3): THREE.Vector3 { this.anchor.updateWorldMatrix(true, false); return this.anchor.worldToLocal(world.clone()); }
  /** Shoulder of the given side in anchor space (the slap arm's reach is measured from here). */
  shoulderOf(side: 1 | -1): THREE.Vector3 | null { return this.arms.find((a) => a.side === side)?.S.clone() ?? null; }
  armLen(side: 1 | -1) { const a = this.arms.find((x) => x.side === side); return a ? a.a + a.b : 0; }

  /** Per frame, after the choreography set `drive` and placed the mount: the avatar update (face + the pose hook). */
  update(dt: number, aspect: number) {
    const rt = this.rt;
    if (!rt) return;
    this.t += dt;
    const d = this.drive;
    // locomotion inputs (run cycle)
    const lo = this.loco!;
    lo.gait = d.gait; lo.armW = d.gait; lo.headW = 0.4 * d.gait; lo.idle = d.gait > 0.05 ? 0 : 0.3; lo.back = false; lo.stride = 1;
    lo.dist += d.speed * dt;
    this.actor.loco = d.gait;
    // the face (a synthetic frame: no camera behind it)
    const f = this.frame;
    f.tracked = true; f.t = Date.now() / 1000;
    const bph = (this.t % 3.3) / 3.3, idleBlink = bph > 0.95 ? Math.sin(((bph - 0.95) / 0.05) * Math.PI) : 0;
    const blink = Math.max(d.blink, idleBlink * (1 - d.angry));
    f.face = {
      eyeBlinkLeft: blink, eyeBlinkRight: blink,
      browDownLeft: d.angry * 0.9, browDownRight: d.angry * 0.9, browInnerUp: 0.4 * d.grin * (1 - d.angry),
      eyeSquintLeft: 0.6 * d.angry + 0.35 * d.grin, eyeSquintRight: 0.6 * d.angry + 0.35 * d.grin,
      mouthSmileLeft: 0.25 + 0.7 * d.grin, mouthSmileRight: 0.25 + 0.7 * d.grin * (1 - 0.35 * d.angry),
      mouthPressLeft: 0.5 * d.angry, mouthPressRight: 0.5 * d.angry, jawOpen: d.jaw, cheekSquintLeft: 0.5 * d.grin, cheekSquintRight: 0.5 * d.grin,
    };
    f.mouth = { open: d.jaw, wide: 0.35 * d.grin, smile: 0.25 + 0.7 * d.grin, frown: 0.2 * d.angry, pucker: 0, funnel: 0, tongue: 0 };
    // head: towards the look target (anchor space, the sidekick's convention)
    let yaw = 0, pitch = 0;
    if (d.look) {
      const dir = d.look.clone().sub(this.head);
      yaw = THREE.MathUtils.clamp(Math.atan2(dir.x, dir.z), -1.0, 1.0);
      pitch = THREE.MathUtils.clamp(-Math.atan2(dir.y, Math.hypot(dir.x, dir.z)), -0.5, 0.5);
    }
    f.head = [yaw, pitch, 0];
    f.headPos = [0, 0, 0];
    f.gaze = [0, 0];
    rt.update(f, null, rt.profile.tracking, dt, aspect);
    this.actor.sync();
  }

  /** The pose layer (actor.extraPose): run cycle, then the gag's own layer on top. */
  private pose(rt: AvatarRuntime, dt: number) {
    this.loco?.apply(rt, dt);
    const d = this.drive, a = this.actor, k = a.scale || 1, H = this.restH;
    // whole body: crouch (knees are the run cycle's business — the body just drops), jump, lean
    a.offset.y += -0.09 * d.crouch * H * k + d.jump;
    if (Math.abs(d.lean) > 1e-4) a.tilt.premultiply(new THREE.Quaternion().setFromAxisAngle(X, d.lean));
    const h = rt.humanoid;
    if (!h) return;
    const N = (b: string) => h.getNormalizedBoneNode(b as VRMHumanBoneName);
    const pre = (bone: string, q: THREE.Quaternion) => { const n = N(bone); if (n) n.quaternion.premultiply(this.toNorm.clone().multiply(q).multiply(this.fromNorm)); };
    // upper body: bow (forward) + twist, shared over spine / chest
    if (Math.abs(d.bow) > 1e-4 || Math.abs(d.twist) > 1e-4) {
      const e = new THREE.Euler(d.bow * 0.45, d.twist * 0.5, 0, 'YXZ');
      pre('spine', new THREE.Quaternion().setFromEuler(e));
      const top = N('upperChest') ? 'upperChest' : N('chest') ? 'chest' : null;
      if (top) pre(top, new THREE.Quaternion().setFromEuler(new THREE.Euler(d.bow * 0.35, d.twist * 0.5, 0, 'YXZ')));
      // (the head keeps looking where it looks: undo part of the bow on the neck)
      if (N('neck')) pre('neck', new THREE.Quaternion().setFromAxisAngle(X, -d.bow * 0.25));
    }
    // arms: IK to the hand targets
    if (d.hands.w > 1e-3) for (const arm of this.arms) {
      const T = arm.side === 1 ? d.hands.left : d.hands.right;
      if (!T) continue;
      this.ik(rt, arm, T, d.hands.w);
    }
    void Y;
  }

  /** Two-bone arm IK on the normalized humanoid (the chat buddy's solver), blended by w. */
  private ik(rt: AvatarRuntime, arm: ArmRig, T0: THREE.Vector3, w: number) {
    const h = rt.humanoid!;
    const s = arm.side === 1 ? 'left' : 'right';
    const ua = h.getNormalizedBoneNode(`${s}UpperArm` as VRMHumanBoneName), la = h.getNormalizedBoneNode(`${s}LowerArm` as VRMHumanBoneName);
    if (!ua || !la) return;
    const T = T0.clone();
    const D = T.sub(arm.S);
    let d = D.length();
    if (d < 1e-5) return;
    D.multiplyScalar(1 / d);
    d = THREE.MathUtils.clamp(d, Math.abs(arm.a - arm.b) + 1e-4, (arm.a + arm.b) * 0.999);
    const pole = new THREE.Vector3(arm.side * 0.8, -0.6, -0.1).normalize();
    const perp = pole.clone().addScaledVector(D, -pole.dot(D));
    if (perp.lengthSq() < 1e-8) perp.set(0, -1, 0); else perp.normalize();
    const cosA = THREE.MathUtils.clamp((arm.a * arm.a + d * d - arm.b * arm.b) / (2 * arm.a * d), -1, 1);
    const up = D.clone().multiplyScalar(cosA).addScaledVector(perp, Math.sqrt(1 - cosA * cosA));
    const elbow = arm.S.clone().addScaledVector(up, arm.a);
    const lo = arm.S.clone().addScaledVector(D, d).sub(elbow).normalize();
    up.applyQuaternion(this.toNorm); lo.applyQuaternion(this.toNorm);
    const parentW = worldQ(ua.parent, h.normalizedHumanBonesRoot.parent, new THREE.Quaternion());
    const upW = new THREE.Quaternion().setFromUnitVectors(arm.restU.clone().applyQuaternion(parentW), up).multiply(parentW);
    ua.quaternion.slerp(parentW.clone().invert().multiply(upW), w);
    const upWb = parentW.clone().multiply(ua.quaternion);
    const loW = new THREE.Quaternion().setFromUnitVectors(arm.restL.clone().applyQuaternion(upWb), lo).multiply(upWb);
    la.quaternion.slerp(upWb.clone().invert().multiply(loW), w);
    h.getNormalizedBoneNode(`${s}Hand` as VRMHumanBoneName)?.quaternion.slerp(I, w);
  }

  dispose() {
    this.disposed = true;
    this.actor.mount.removeFromParent();
    this.actor.detach();
    this.rt?.dispose();
    this.rt = null;
  }
}

function worldQ(n: THREE.Object3D | null, stop: THREE.Object3D | null, out: THREE.Quaternion) {
  out.identity();
  for (let o = n; o && o !== stop; o = o.parent) out.premultiply(o.quaternion);
  return out;
}
