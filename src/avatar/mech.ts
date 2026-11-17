// MechRig: a pilot seated in a walking machine (AvatarProfile.body = 'mech'). Contract: creations/desert_walker/SPEC.md
// §1.3 / §1.9 / §2.3 (rig names + profile.mech: shared/mech.ts; gait maths: shared/gait.ts). One per loaded runtime, like
// QuadrupedLife; it runs on every page (studio, OBS, party views) from the same inputs, so they all show the same walk.
//
// Each frame AvatarRuntime.update calls two halves:
//   preHumanoid   (after tracking / pose hook / emotes, BEFORE humanoid.update)
//     - every machine bone back to rest: three-vrm places the raw hips against the parent's CURRENT world matrix, so the
//       cab must be at rest while the humanoid writes the pilot (then the pilot rides the cab, see post)
//     - the pilot is strapped in: hips locked, torso lean clamped (torsoLimit); the head is never touched
//     - the sticks: forward with the speed, sideways with the turn, springing back to neutral when parked
//     - while travelling (hands 'auto' / 'grip'): two-bone IK puts the hands on the stick grips (blended by the travel
//       envelope; after the emotes, so the grips win while it walks), the hands turn with the sticks, the fingers close
//   postHumanoid  (after humanoid.update, BEFORE the neck rig and the spring bones)
//     - legs: the gait PHASE IS DISTANCE (shared/gait.ts); every page that agrees on the host-timed move agrees on every
//       step. A foot plants where the mover's pose at its mid-stance distance puts its parking spot (poseAt: exact on
//       curves and turns on the spot; without a mover it extrapolates the current curvature) and stays locked in the
//       world. Swings go LIFT → CARRY (an apex hitch: the servo stutter) → SLAM. Families per walk (walk = one foot at a
//       time; march / hustle = diagonal pairs; tripod / ripple / tetrapod for 6 / 8 legs). After arriving, feet left off
//       their spots step home one at a time; an over-stretched planted leg steps early.
//     - IK: hinge-constrained (shared/gait.ts solveHingeLeg): the coxa only yaws, femur / tibia / foot only turn about
//       their own axes (profile axes, else measured), clamped to their limits; written as restLocal · axisAngle(local axis)
//       so the hubs stay concentric. Then pistons, sticks.
//     - body: hydraulic bob (stand up while travelling, park crouched, drop + lean toward lifted legs, a thump at every
//       plant, a 1-2 mm idle hunt) through second-order springs that overshoot; the cab lags behind (≤ lagMax); the head
//       counters part of the cab's roll / pitch (levelHead). Lamps follow the state. Events: plant / spool / settle / park.
// Inputs (feed(), every frame, from the scene's Locomotion layer): dist (anchor units), gait, stride, back, travel,
// family, poseAt + mount. Without a feeder it follows the model's own displacement; `treadmill` (0..1) walks it on the
// spot (Classic previews, ?mechWalk=1). No sound: plants are events for room FX (src/avatar/mechFx.ts draws dust / exhaust).
import * as THREE from 'three';
import type { VRMHumanoid, VRMHumanBoneName } from '@pixiv/three-vrm';
import { MECH_EXHAUST_RE, MECH_FOOT_RE, MECH_LEG_RE, MECH_PISTON_RE, MECH_TIP_RE, resolveMech, type MechConfig, type MechResolved } from '../../shared/mech.ts';
import { clamp01, familyFor, footPhase, gaitFor, legState, parseLegId, pickFamily, smoothstep, solveHingeLeg, specSpeed, Spring2, swingCurve, hitchShare, type GaitFamily, type GaitSlot, type GaitSpec, type HingeLegModel, type V3 } from '../../shared/gait.ts';
import { solveElbow } from './bodyGuard.ts';
import type { Retargeter } from './retarget.ts';
import { MechFx } from './mechFx.ts';

type Side = 'left' | 'right';
const I = new THREE.Quaternion();
const Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4();
const _e = new THREE.Euler();
const D2R = Math.PI / 180;
/** Skin round each hand point the M4 guard keeps inside the hand box (m: palm width and finger thickness round the
 *  joints, curled fingertips; the real rig's hand skin reaches up to ~4 cm past its joint line). */
const HAND_R = 0.04;
/** A control stick's keep-out radius round its axis (m: the grip and its boot). */
const STICK_R = 0.05;
/** The 26 directions to a cube's faces, edges and corners (unit). */
const CUBE_DIRS: THREE.Vector3[] = [];
for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) CUBE_DIRS.push(new THREE.Vector3(x, y, z).normalize());
const v3 = (v: THREE.Vector3): V3 => [v.x, v.y, v.z];
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clampA = (v: number, m: number) => (v < -m ? -m : v > m ? m : v);
/** A foot plate's samples (unit radius): its centre and four points on its rim. */
const FOOT_RING: readonly [number, number][] = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
/** The state machine's tick rate (Hz) on the mover's clock (see postHumanoid). */
export const TICK_HZ = 120;

/** Room-FX events (newest last): footfalls (world position at the sole), the stand-up, the stop, parked again. */
export interface MechEvent { kind: 'plant' | 'spool' | 'settle' | 'park'; leg?: string; pos?: V3; t: number; seq: number; settle?: boolean }
/** @deprecated name kept for callers of the first version: a plant event. */
export type MechPlant = MechEvent;

export interface MechInputs {
  /** Distance travelled (anchor units; the mover's job distance). Drives the gait phase. */
  dist: number;
  /** 0..1 how much it is walking (the mover's speed ramp). */
  gait: number;
  /** 0..1 foot travel (0 = turning on the spot). */
  stride: number;
  /** Walking backwards (backing out of a parking spot). */
  back: boolean;
  /** 0..1 the travel envelope (hands on the sticks, stood up, legs active): the mover's arm weight. */
  travel: number;
  /** Gait family for this walk segment (pickFamily, chosen by the mover); missing = the profile's / walk. */
  family?: GaitFamily | null;
  /** The WORLD matrix of `mount` at a job distance (anchor units), for exact plants; null = extrapolate. */
  poseAt?: ((d: number) => THREE.Matrix4 | null) | null;
  /** The object poseAt describes (the scene passes actor.lift: the mount + seat offset + scale). */
  mount?: THREE.Object3D | null;
  /** The mover's inputs as a pure function of ITS clock (seconds; dist in anchor units): with `clock` (the mover's time
   *  of these inputs) the state runs on fixed ticks of that clock, the same on every page at any frame rate. */
  at?: ((clock: number) => MechSample | null) | null;
  clock?: number;
  /** The mover's clock now (the late pass catches the state up to the clock the mover moved the body to this frame). */
  clockAt?: (() => number) | null;
  /** The room's walkable height (world y) at a world (x, z) (src/scene/floors.ts); null = flat (the mount's floor). */
  floorAt?: ((x: number, z: number) => number) | null;
}
/** The time-varying inputs at one instant of the mover's clock (MechInputs.at). */
export interface MechSample {
  dist: number; gait: number; stride: number; back: boolean; travel: number; family?: GaitFamily | null;
  /** The mount's world matrix at a distance of THIS instant's walk (a re-target switches walks between two frames). */
  poseAt?: ((d: number) => THREE.Matrix4 | null) | null;
}

interface JointRig {
  bone: THREE.Object3D;
  type: 'yaw' | 'hinge';
  restQ: THREE.Quaternion;
  /** The axis in the bone's own rest frame (rotation = restQ · axisAngle(local, θ)). */
  local: THREE.Vector3;
}
interface LegRig {
  key: string;
  slot: GaitSlot;
  joints: JointRig[];
  model: HingeLegModel;               // pelvis-local rest frame
  level: boolean;
  /** Sole at rest (model space) = the parking spot; the last joint carrying it + the sole in that bone's frame. */
  neutral: THREE.Vector3;
  tipParent: THREE.Object3D;
  tipLocal: THREE.Vector3;
  // ---- state
  mode: 'stance' | 'swing';
  plant: THREE.Vector3;
  from: THREE.Vector3;
  u: number;
  step: number;
  timed: boolean;
  home: boolean;
  h: number;
  reach: number;
  clamped: boolean;
  /** How far the solved sole ended from its target (model units; a joint limit stopped it). */
  err: number;
  pos: THREE.Vector3;
  /** The last solved joint angles (the solver's warm start); null = solve from scratch. */
  angles: number[] | null;
  /** Duration (s) of the current timed swing. */
  T: number;
  /** A lag step that progresses by DISTANCE (deterministic across pages): its start distance + length; 0 = none. */
  d0: number;
  dLen: number;
  /** Fixed landing (job distance of the mid-stance pose it lands at) for lag / early steps; NaN = the gait's own. */
  mid: number;
  /** A reserved off-schedule step (a lagging foot): starts at job distance resAt (NaN = none), resLen long, lands for
   *  resMid. Reserved once, in distance, against every other leg's steps: the same on every page and frame rate. */
  resAt: number;
  resLen: number;
  resMid: number;
  /** The stance (step number) whose lag could not be scheduled: its own regular swing fixes it (no re-search). */
  lagSkip: number;
  /** A getting-ready step: its start on the rig's clock (u = (time - prepAt) / T); -1 = not one. prepDone: taken. */
  prepAt: number;
  prepDone: boolean;
  /** World height of the ground under the foot (a plant's; a swing's, from its lift-off plant to its landing). */
  gy: number;
  /** predict()'s own warm start (ticks only: the frame solve's depends on when the frames fell). */
  pAngles: number[] | null;
  /** The ground height under the foot when its swing began (`from` may be in the air: a re-planned swing). */
  g0: number;
}
interface ArmRig {
  side: Side;
  chain: VRMHumanBoneName[];
  restPos: Record<string, THREE.Vector3>;
  a: number; b: number;
  restU: THREE.Vector3; restL: THREE.Vector3;
  elbowOff: THREE.Vector3;
  wrist: THREE.Vector3;
  pivot: THREE.Vector3 | null;
  fingers: 'bind' | 'curl';
  /** The hand's reach at rest, as offsets from the wrist (the normalized hand frame): the wrist, the knuckles and
   *  joints, the fingertips (SPEC M4 guards all of it, not only the wrist). */
  hand: THREE.Vector3[];
}
interface StickRig { bone: THREE.Object3D; restLocal: THREE.Matrix4; restModel: THREE.Matrix4; parentRestModelInv: THREE.Matrix4; pivot: THREE.Vector3 }
interface PistonRig { a: THREE.Object3D; b: THREE.Object3D; restA: THREE.Quaternion; restB: THREE.Quaternion; dirA: THREE.Vector3; dirB: THREE.Vector3 }
interface BodyBone { bone: THREE.Object3D; restModel: THREE.Matrix4; parentRestModelInv: THREE.Matrix4; pivot: THREE.Vector3; restPos: THREE.Vector3; restQ: THREE.Quaternion; restS: THREE.Vector3 }

export interface FoundLeg {
  key: string; slot: GaitSlot;
  joints: { bone: THREE.Object3D; type: 'yaw' | 'hinge'; axis: V3 | null; min: number; max: number }[];
  foot: THREE.Object3D | null; tip: THREE.Object3D | null; contact: V3 | null; level: boolean; phase?: number;
}

const byNameIn = (model: THREE.Object3D) => {
  const m = new Map<string, THREE.Object3D>();
  model.traverse((o) => { if (o.name && !m.has(o.name)) m.set(o.name, o); });
  return m;
};
const firstOf = (by: Map<string, THREE.Object3D>, names: readonly string[]) => { for (const n of names) { const o = by.get(n); if (o) return o; } return null; };

/** The legs of a model: by profile.mech.legs, else by the naming contract (mleg_<S>_<n>, mfoot_<S>, mtip_<S>). Joint types
 *  for name-found legs: 3 bones (+ foot) = yaw, hinge, hinge (+ hinge); 2 = hinge, hinge (+ foot hinge). Also used by
 *  tools/mech_rigcheck.ts. */
export function findMechLegs(model: THREE.Object3D, cfg: MechResolved): FoundLeg[] {
  const by = byNameIn(model);
  const out: FoundLeg[] = [];
  if (cfg.legs?.length) {
    const slots = new Map<string, GaitSlot>();
    const all = cfg.legs.map((l) => l.side);
    const sl = slotsOf(all);
    all.forEach((s, i) => slots.set(`${s}#${i}`, sl[i]));
    cfg.legs.forEach((l, i) => {
      const joints = l.joints.map((j) => ({ bone: by.get(j.bone) ?? null, type: j.type, axis: j.axis ?? null, min: j.min * D2R, max: j.max * D2R }))
        .filter((j): j is FoundLeg['joints'][number] & { bone: THREE.Object3D } => !!j.bone);
      if (joints.filter((j) => j.type === 'hinge').length < 2) return;
      const foot = l.foot ? by.get(l.foot) ?? null : null;
      // the profile's foot bone is a hinge too when the joint list doesn't already end with it
      if (foot && !joints.some((j) => j.bone === foot)) joints.push({ bone: foot, type: 'hinge', axis: null, min: -Math.PI, max: Math.PI });
      out.push({ key: l.side, slot: slots.get(`${l.side}#${i}`)!, joints, foot, tip: by.get(`mtip_${l.side}`) ?? null, contact: l.contact ?? null, level: l.level !== false, phase: l.phase });
    });
    return out;
  }
  const groups = new Map<string, [number, THREE.Object3D][]>();
  for (const [name, o] of by) {
    const m = MECH_LEG_RE.exec(name);
    if (!m) continue;
    const g = groups.get(m[1]) ?? [];
    g.push([Number(m[2]), o]);
    groups.set(m[1], g);
  }
  const keys = [...groups.keys()];
  const sl = slotsOf(keys);
  keys.forEach((key, i) => {
    const bones = groups.get(key)!.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    if (bones.length < 2) return;
    let foot: THREE.Object3D | null = null, tip: THREE.Object3D | null = null;
    for (const [name, o] of by) {
      const f = MECH_FOOT_RE.exec(name); if (f && f[1] === key) foot = o;
      const t = MECH_TIP_RE.exec(name); if (t && t[1] === key) tip = o;
    }
    const types: ('yaw' | 'hinge')[] = bones.length >= 3 ? ['yaw', ...bones.slice(1).map(() => 'hinge' as const)] : bones.map(() => 'hinge' as const);
    const joints = bones.map((b, k) => ({ bone: b, type: types[k], axis: null, min: -Math.PI, max: Math.PI }));
    if (foot) joints.push({ bone: foot, type: 'hinge', axis: null, min: -Math.PI, max: Math.PI });
    out.push({ key, slot: sl[i], joints, foot, tip, contact: null, level: true });
  });
  return out.sort((a, b) => a.slot.row - b.slot.row || b.slot.side - a.slot.side);
}
/** Side tokens → slots (rows renumbered front → back). */
function slotsOf(tokens: readonly string[]): GaitSlot[] {
  const p = tokens.map((t) => parseLegId(t));
  const ranks = [...new Set(p.map((x) => x.rank))].sort((a, b) => a - b);
  return p.map((x) => ({ side: x.side, row: ranks.indexOf(x.rank) }));
}

export class MechRig {
  readonly cfg: MechResolved;
  readonly legs: LegRig[] = [];
  private arms: ArmRig[] = [];
  private sticks: Partial<Record<Side, StickRig>> = {};
  private pistons: PistonRig[] = [];
  private pelvis: BodyBone | null = null;
  private cockpit: BodyBone | null = null;
  private hips: THREE.Object3D | null = null;
  /** Exhaust FX anchors (mexhaust_*). */
  readonly exhaust: THREE.Object3D[] = [];
  private lamps: { m: THREE.Material & { emissiveIntensity: number }; base: number }[] = [];
  private lamp = 0.25;
  /** The cab is docked (the room's dock form sets it): lamps at 0.6. */
  docked = false;
  /** Draw dust / exhaust (src/avatar/mechFx.ts); off in tests. */
  fxEnabled = true;
  private fx: MechFx | null = null;
  /** Current gait spec (the family in use). */
  spec: GaitSpec;
  private specs = new Map<GaitFamily, GaitSpec>();
  readonly slots: GaitSlot[];
  private readonly sideKeys: string[];
  private readonly phases: (number | undefined)[];
  /** Mean hip → sole distance (model units). */
  readonly L: number;
  /** Largest parking-spot distance from the turning pivot (model units): the footprint (turn step, clearance). */
  readonly footprint: number;
  /** Gait distance per radian turned on the spot (model units): the footprint, or more for legs with narrow ranges. */
  readonly turnPer: number;
  /** The share (0..1] of the profile stride's stance sweep every leg holds inside 85 % of its joint ranges with the hull
   *  stood up (1 = it fits; less: the stride in use is shortened to it, never below 35 %). */
  readonly strideFit: number;
  /** How far the hull may rise / sink (model units) and roll / pitch (rad) with every foot planted inside its ranges
   *  (restInside false: the rest pose itself is outside 90 % of a leg's ranges: the defaults stand, rigcheck warns). */
  readonly bodyEnv: { up: number; down: number; roll: number; pitch: number; restInside: boolean };
  /** Model units → anchor units. */
  private readonly sMA: number;
  private readonly center: THREE.Vector3;
  private readonly pivot: THREE.Vector3;
  private readonly stride: number;
  private readonly lift: number;
  // ---- inputs
  private inp: MechInputs = { dist: 0, gait: 0, stride: 1, back: false, travel: 0 };
  private fed = false;
  /** The actor's walking amount (fallback when no Locomotion feeds this runtime). */
  loco = 0;
  /** Walk on the spot at this share of top speed (Classic previews, tests). 0 = off. */
  treadmill = 0;
  private tmDist = 0;
  // ---- state
  private time = 0;
  private init = false;
  private lastDist = 0;
  private lastPos = new THREE.Vector3();
  private lastYaw = 0;
  private lastScale = 1;
  private fbDist = 0;
  private kappa = 0;
  private yawRate = 0;
  private speed = 0;
  private accel = 0;
  private handW = 0;
  private stand = 0;
  private settleWait = 0;
  /** Seconds since the gait last moved (settle steps wait for a real stop, not a turn / walk hand-over). */
  private stillT = 0;
  /** Standing up from parked for a walk (travel rising, not moving yet): feet get ready (postHumanoid step 0), on a
   *  clock from readyAt (this.time when the travel ramp crossed in; -1 = not yet), the legs in `prep` one after another. */
  private readying = false;
  private readyAt = -1;
  /** Ticks on the mover's clock (postHumanoid): the last tick run (k / TICK_HZ s; NaN = none yet), and whether the
   *  state runs on them (else once a frame). */
  private tickN = NaN;
  private tickMode = false;
  /** The room's walkable height at a world (x, z), this frame (inputs.floorAt; null = flat). */
  private floorAt: ((x: number, z: number) => number) | null = null;
  /** The pilot's hands are kept inside this cockpit volume and out of the cage posts when they are tracked
   *  (profile.mech.pilot.handBox, SPEC M4): model space at rest. null = no guard. */
  private handBox: { min: THREE.Vector3; max: THREE.Vector3; posts: { a: THREE.Vector3; b: THREE.Vector3; r: number }[] } | null = null;
  private prep: number[] = [];
  private wasMoving = false;
  private wasTravel = 0;
  private parked = true;
  private stick = { left: { p: new Spring2(), r: new Spring2() }, right: { p: new Spring2(), r: new Spring2() } };
  private res: MechInputs = { dist: 0, gait: 0, stride: 1, back: false, travel: 0 };
  private sp = { y: new Spring2(), roll: new Spring2(), pitch: new Spring2() };
  private sc = { y: new Spring2(), roll: new Spring2(), pitch: new Spring2() };
  /** Recent events (newest last, at most 32). */
  readonly events: MechEvent[] = [];
  private seq = 0;
  onEvent: ((e: MechEvent) => void) | null = null;
  /** Debug: the last frame's numbers. */
  last = { moving: false, swinging: 0, maxReach: 0, pelvisY: 0, handW: 0, family: 'walk' as GaitFamily, clamped: 0 };

  /** null when the model has no machine parts at all (no legs, no sticks, no mpelvis). */
  static create(model: THREE.Object3D, humanoid: VRMHumanoid | null, anchor: THREE.Object3D, cfg: MechConfig | undefined, retarget: Retargeter | null = null): MechRig | null {
    const r = resolveMech(cfg);
    const legs = findMechLegs(model, r);
    const by = byNameIn(model);
    if (!legs.length && !by.has(r.pelvis) && !firstOf(by, r.pilot.sticks.left) && !firstOf(by, r.pilot.sticks.right)) return null;
    return new MechRig(model, humanoid, anchor, r, legs, retarget);
  }

  private constructor(private model: THREE.Object3D, private humanoid: VRMHumanoid | null, anchor: THREE.Object3D, cfg: MechResolved,
    found: FoundLeg[], private retarget: Retargeter | null) {
    this.cfg = cfg;
    model.updateWorldMatrix(true, true);
    const by = byNameIn(model);
    const modelInv = model.matrixWorld.clone().invert();
    const mq = model.getWorldQuaternion(new THREE.Quaternion()), mqi = mq.clone().invert();
    const toModel = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3()).applyMatrix4(modelInv);
    const modelMat = (o: THREE.Object3D) => modelInv.clone().multiply(o.matrixWorld);
    const ms = model.getWorldScale(new THREE.Vector3()).x, as = anchor.getWorldScale(new THREE.Vector3()).x;
    this.sMA = as > 1e-9 ? ms / as : 1;
    const box = new THREE.Box3().setFromObject(model);
    const floorY = Number.isFinite(box.min.y) ? box.min.clone().applyMatrix4(modelInv).y : 0;
    const bodyBone = (name: string): BodyBone | null => {
      const b = by.get(name);
      if (!b || !b.parent) return null;
      return { bone: b, restModel: modelMat(b), parentRestModelInv: modelMat(b.parent).invert(), pivot: toModel(b), restPos: b.position.clone(), restQ: b.quaternion.clone(), restS: b.scale.clone() };
    };
    this.pelvis = bodyBone(cfg.pelvis);
    this.cockpit = bodyBone(cfg.cockpit);
    const bodyObj = this.pelvis?.bone ?? model;
    const bodyInv = bodyObj.matrixWorld.clone().invert();
    const bodyQi = bodyObj.getWorldQuaternion(new THREE.Quaternion()).invert();
    // model-space vectors / points → the body's (pelvis) rest frame
    const pB = (pm: THREE.Vector3): V3 => v3(pm.clone().applyMatrix4(model.matrixWorld).applyMatrix4(bodyInv));
    const dB = (dm: THREE.Vector3): V3 => v3(dm.clone().applyQuaternion(mq).applyQuaternion(bodyQi).normalize());
    this.center = (this.pelvis ? this.pelvis.pivot.clone() : new THREE.Vector3()).setY(floorY);
    this.pivot = anchor.getWorldPosition(new THREE.Vector3()).applyMatrix4(modelInv).setY(floorY);

    // ---- legs: hinge models (axes from the profile, else measured), parking spots, soles
    let Lsum = 0, foot = 0;
    for (const f of found) {
      const J = f.joints;
      const hinges = J.filter((j) => j.type === 'hinge');
      const pm = J.map((j) => toModel(j.bone));
      // sole: tip bone, profile contact, else under the last joint on the floor
      const last = J[J.length - 1].bone;
      const contactM = f.tip ? toModel(f.tip) : f.contact ? new THREE.Vector3(...f.contact) : pm[pm.length - 1].clone().setY(floorY);
      // measured hinge axis: the plane through hip / knee / ankle (+ its sign: right-handed with the leg pointing out)
      const hi = J.indexOf(hinges[0]), ki = J.indexOf(hinges[1]);
      const ankM = hinges[2] ? pm[J.indexOf(hinges[2])] : contactM;
      let nAx = pm[ki].clone().sub(pm[hi]).cross(ankM.clone().sub(pm[ki]));
      if (nAx.lengthSq() < 1e-12) nAx = Y.clone().cross(ankM.clone().sub(pm[hi]));
      if (nAx.lengthSq() < 1e-12) nAx = new THREE.Vector3(1, 0, 0);
      nAx.normalize();
      const joints: JointRig[] = [];
      const model2: HingeLegModel = { joints: [], contact: pB(contactM) };
      J.forEach((j, k) => {
        const axM = j.axis ? new THREE.Vector3(...j.axis).normalize() : j.type === 'yaw' ? Y.clone() : nAx.clone();
        // bone-local axis: the model axis in the bone's own rest frame
        const boneQm = mqi.clone().multiply(j.bone.getWorldQuaternion(new THREE.Quaternion()));
        joints.push({ bone: j.bone, type: j.type, restQ: j.bone.quaternion.clone(), local: axM.clone().applyQuaternion(boneQm.clone().invert()).normalize() });
        model2.joints.push({ type: j.type, pivot: pB(pm[k]), axis: dB(axM), min: j.min, max: j.max });
      });
      const tipLocal = last.worldToLocal(contactM.clone().applyMatrix4(model.matrixWorld));
      this.legs.push({
        key: f.key, slot: f.slot, joints, model: model2, level: f.level, neutral: contactM.clone(), tipParent: last, tipLocal,
        mode: 'stance', plant: new THREE.Vector3(), from: new THREE.Vector3(), u: 0, step: 0, timed: false, home: false, h: 0, reach: 0, clamped: false, err: 0, pos: new THREE.Vector3(),
        angles: null, T: 0, d0: 0, dLen: 0, mid: NaN, resAt: NaN, resLen: 0, resMid: NaN, lagSkip: -Infinity, prepAt: -1, prepDone: false, gy: 0, pAngles: null, g0: 0,
      });
      Lsum += pm[hi].distanceTo(contactM);
      foot = Math.max(foot, Math.hypot(contactM.x - this.pivot.x, contactM.z - this.pivot.z));
    }
    const box2 = box.getSize(new THREE.Vector3());
    this.L = this.legs.length ? Lsum / this.legs.length : Math.max(1e-3, (box2.y / Math.max(ms, 1e-9)) * 0.4);
    this.footprint = foot || this.L;
    this.slots = this.legs.map((l) => l.slot);
    this.sideKeys = this.legs.map((l) => l.key);
    this.phases = found.map((f) => f.phase);
    const rawStride = cfg.gait.stride ?? 0.9 * this.L;
    this.lift = cfg.gait.lift ?? 0.18 * this.L;
    // ---- what the legs' joint ranges allow (probed once at load with the leg models, limits off: is every joint inside
    // a share of its range, reach in bounds?). Pure numbers from the rig + profile: every page gets the same.
    //  1. the body's envelope: how far the hull may rise / sink / roll / pitch (its springs, the stand-up, a landing's
    //     thump) with every foot still on its parking spot inside 90 % of its ranges (reach <= 0.95). The springs'
    //     output is held inside it (poseBody) and the stand-up lift is at most 80 % of the rise, so the hull never pulls
    //     a planted foot off the ground or a leg against its stop.
    //  2. the stride (SPEC R1: the ROM-limited number): the share of the walk's stance sweep every leg holds inside 85 %
    //     of its ranges with the hull stood up (strideFit). A profile stride the legs can't hold is shortened to what
    //     they can (never below 35 %): a slower walk instead of feet dragged against their stops.
    //  3. the turn step (gait distance per radian turned on the spot): the footprint radius (SPEC), or more when a leg
    //     can't hold a whole stance's turn: more, shorter steps per turn instead of a leg pinned at its stop.
    // rigcheck (tools/mech_rigcheck.ts) reports all of it to the asset lane.
    const pv0 = this.pelvis;
    const frees = this.legs.map((l) => ({ ...l.model, joints: l.model.joints.map((j) => ({ ...j, min: -Math.PI, max: Math.PI })) }));
    const A = new THREE.Matrix4(), Ai = new THREE.Matrix4(), Rm = new THREE.Matrix4(), T1 = new THREE.Matrix4(), T2 = new THREE.Matrix4();
    const inside = (l: LegRig, i: number, foot: THREE.Vector3, share: number, maxReach: number, y = 0, roll = 0, pitch = 0) => {
      let p = foot;
      if (pv0 && (y || roll || pitch)) {
        Rm.makeRotationFromEuler(new THREE.Euler(pitch, 0, roll, 'XYZ'));
        A.copy(T1.makeTranslation(pv0.pivot.x, pv0.pivot.y + y, pv0.pivot.z)).multiply(Rm).multiply(T2.makeTranslation(-pv0.pivot.x, -pv0.pivot.y, -pv0.pivot.z));
        p = foot.clone().applyMatrix4(Ai.copy(A).invert());
      }
      const s = solveHingeLeg(frees[i], pB(p), { level: l.level });
      return s.reach <= maxReach && l.model.joints.every((j, k) => {
        const lo = j.min ?? -Math.PI, hi = j.max ?? Math.PI, mid = (lo + hi) / 2, hw = (share * (hi - lo)) / 2;
        return s.angles[k] >= mid - hw - 1e-9 && s.angles[k] <= mid + hw + 1e-9;
      });
    };
    const largest = (ok: (x: number) => boolean, top: number) => {
      if (!ok(0)) return 0;
      if (ok(top)) return top;
      let lo = 0, hi = top;
      for (let k = 0; k < 20; k++) { const m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; }
      return lo;
    };
    const env = { up: 0.06 * this.L, down: 0.06 * this.L, roll: 0.1, pitch: 0.1, restInside: true };
    if (pv0 && this.legs.length) {
      const holds = (y: number, roll: number, pitch: number) => this.legs.every((l, i) => inside(l, i, l.neutral, 0.9, 0.95, y, roll, pitch));
      env.restInside = holds(0, 0, 0);
      if (env.restInside) {
        env.up = largest((x) => holds(x, 0, 0), 0.25 * this.L);
        env.down = largest((x) => holds(-x, 0, 0), 0.25 * this.L);
        env.roll = Math.min(largest((x) => holds(0, x, 0), 0.3), largest((x) => holds(0, -x, 0), 0.3));
        env.pitch = Math.min(largest((x) => holds(0, 0, x), 0.3), largest((x) => holds(0, 0, -x), 0.3));
      }
    }
    this.bodyEnv = env;
    const standY = Math.min(0.06 * this.L, 0.8 * env.up);
    // (the walk family's duty: the profile's, else the family's)
    const walkDuty = gaitFor('walk', this.legs.map((l) => l.key), { ...(cfg.gait.duty ? { duty: cfg.gait.duty } : {}) }).duty;
    let fit = 1;
    for (let i = 0; i < this.legs.length; i++) {
      const l = this.legs[i];
      if (!inside(l, i, l.neutral, 0.95, 0.92, standY)) continue;     // (stood up already outside: nothing to learn here)
      const half = (walkDuty * rawStride) / 2;
      for (const sg of [1, -1]) fit = Math.min(fit, largest((x) => inside(l, i, l.neutral.clone().add(new THREE.Vector3(0, 0, sg * x * half)), 0.95, 0.92, standY), 1));
    }
    this.strideFit = fit;
    this.stride = rawStride * Math.max(0.35, Math.min(1, fit));
    {
      const half = (walkDuty * this.stride) / 2;
      let psiMax = Infinity;
      for (let i = 0; i < this.legs.length; i++) {
        const l = this.legs[i];
        if (!inside(l, i, l.neutral, 0.95, 0.92, standY)) continue;
        const turned = (psi: number) => l.neutral.clone().sub(this.pivot).applyAxisAngle(Y, -psi).add(this.pivot);
        for (const sg of [1, -1]) psiMax = Math.min(psiMax, largest((x) => inside(l, i, turned(sg * x), 0.95, 0.92, standY), 0.6));
      }
      const need = Number.isFinite(psiMax) && psiMax > 1e-4 ? half / psiMax : 0;
      this.turnPer = THREE.MathUtils.clamp(need, this.footprint, 4 * this.footprint);
    }
    this.spec = this.specFor(this.baseFamily());

    // ---- sticks, pistons, exhaust, lamps
    for (const s of ['left', 'right'] as Side[]) {
      const b = firstOf(by, cfg.pilot.sticks[s]);
      if (!b?.parent) continue;
      this.sticks[s] = { bone: b, restLocal: b.matrix.clone(), restModel: modelMat(b), parentRestModelInv: modelMat(b.parent).invert(), pivot: toModel(b) };
    }
    const pairs = new Map<string, { a?: THREE.Object3D; b?: THREE.Object3D }>();
    for (const [name, o] of by) { const m = MECH_PISTON_RE.exec(name); if (m) { const p = pairs.get(m[1]) ?? {}; p[m[2] as 'a' | 'b'] = o; pairs.set(m[1], p); } }
    const pl: [THREE.Object3D, THREE.Object3D][] = [...pairs.values()].filter((p) => p.a && p.b).map((p) => [p.a!, p.b!]);
    for (const [na, nb] of cfg.pistons) { const a = by.get(na), b = by.get(nb); if (a && b && !pl.some((x) => x[0] === a)) pl.push([a, b]); }
    for (const [a, b] of pl) {
      if (!a.parent || !b.parent) continue;
      const aw = a.getWorldPosition(new THREE.Vector3()), bw = b.getWorldPosition(new THREE.Vector3());
      if (aw.distanceToSquared(bw) < 1e-12) continue;
      const dirA = bw.clone().sub(aw).normalize().applyQuaternion(a.getWorldQuaternion(new THREE.Quaternion()).invert());
      const dirB = aw.clone().sub(bw).normalize().applyQuaternion(b.getWorldQuaternion(new THREE.Quaternion()).invert());
      this.pistons.push({ a, b, restA: a.quaternion.clone(), restB: b.quaternion.clone(), dirA, dirB });
    }
    for (const [name, o] of by) if (cfg.exhaust ? cfg.exhaust.includes(name) : MECH_EXHAUST_RE.test(name)) this.exhaust.push(o);
    const seen = new Set<THREE.Material>();
    model.traverse((o) => {
      const mats = (o as THREE.Mesh).isMesh ? ([] as THREE.Material[]).concat((o as THREE.Mesh).material) : [];
      for (const m of mats) {
        const sm = m as THREE.Material & { emissiveIntensity?: number };
        if (seen.has(m) || typeof sm.emissiveIntensity !== 'number' || !cfg.lamps.some((n) => m.name === n || m.name.startsWith(n))) continue;
        seen.add(m);
        this.lamps.push({ m: sm as THREE.Material & { emissiveIntensity: number }, base: sm.emissiveIntensity || 1 });
      }
    });

    // ---- the pilot: grip IK / hand guard rest data, hips
    const h = humanoid;
    this.hips = h?.getNormalizedBoneNode('hips') ?? null;
    const hb = cfg.pilot.handBox;
    if (hb && this.cockpit) {
      // (cockpit space = glTF axes from the cab's pivot at rest)
      const o = this.cockpit.pivot;
      this.handBox = {
        min: new THREE.Vector3(...hb.min).add(o), max: new THREE.Vector3(...hb.max).add(o),
        posts: hb.posts.map((q) => ({ a: new THREE.Vector3(...q.a).add(o), b: new THREE.Vector3(...q.b).add(o), r: q.r })),
      };
    }
    if (h) {
      for (const side of ['left', 'right'] as Side[]) {
        const S = side;
        const names = (['hips', 'spine', 'chest', 'upperChest', `${S}Shoulder`, `${S}UpperArm`] as VRMHumanBoneName[]).filter((n) => !!h.getRawBoneNode(n) && !!h.getNormalizedBoneNode(n));
        const ua = h.getRawBoneNode(`${S}UpperArm` as VRMHumanBoneName), la = h.getRawBoneNode(`${S}LowerArm` as VRMHumanBoneName), hd = h.getRawBoneNode(`${S}Hand` as VRMHumanBoneName);
        if (!ua || !la || !hd || names[0] !== 'hips' || names[names.length - 1] !== `${S}UpperArm`) continue;
        const restPos: Record<string, THREE.Vector3> = {};
        for (const n of names) restPos[n] = toModel(h.getRawBoneNode(n)!);
        const pU = toModel(ua), pL = toModel(la), pH = toModel(hd);
        const a = pU.distanceTo(pL), b = pL.distanceTo(pH);
        if (a < 1e-5 || b < 1e-5) continue;
        const st = this.sticks[side];
        const gripB = firstOf(by, cfg.pilot.grips[side]);
        // (the console: a free hand stays out of the control stick too, a post from its pivot past the grip to its top
        // (SPEC M4 / L1: no hand inside the cage or the console))
        if (this.handBox && st && gripB) {
          const g = toModel(gripB);
          if (g.distanceTo(st.pivot) > 1e-3) this.handBox.posts.push({ a: st.pivot.clone(), b: st.pivot.clone().addScaledVector(g.clone().sub(st.pivot), 2.2), r: STICK_R });
        }
        // the wrist target: its rest place when the bind pose holds the grip (or there's no grip frame), else in front of
        // the grip frame's palm centre along the hand's rest direction (fitted; fingers curl)
        let wrist = pH.clone();
        let fingers: 'bind' | 'curl' = 'bind';
        if (gripB) {
          const g = toModel(gripB);
          if (g.distanceTo(pH) > 0.35 * b) {
            const mid = h.getRawBoneNode(`${S}MiddleProximal` as VRMHumanBoneName);
            const fwd = (mid ? toModel(mid) : pH.clone().add(pH.clone().sub(pL))).sub(pH);
            const palm = Math.max(0.3 * fwd.length(), 0.25 * b);
            wrist = g.clone().addScaledVector(fwd.normalize(), -palm);
            fingers = 'curl';
          }
        }
        // the hand's reach: every finger joint at rest and its tip (past the last joint by that joint's own length; a
        // finger with only its knuckle: as far again as the knuckle is from the wrist), as offsets from the wrist; a
        // rig without fingers: a hand three quarters of the forearm long
        const hand: THREE.Vector3[] = [new THREE.Vector3()];
        for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
          const parts = f === 'Thumb' ? ['Metacarpal', 'Proximal', 'Intermediate', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
          const js = parts.map((k) => h.getRawBoneNode(`${S}${f}${k}` as VRMHumanBoneName)).filter((n): n is THREE.Object3D => !!n).map((n) => toModel(n));
          if (!js.length) continue;
          for (const q of js) hand.push(q.clone().sub(pH));
          const last = js[js.length - 1], prev = js.length > 1 ? js[js.length - 2] : pH;
          hand.push(last.clone().addScaledVector(last.clone().sub(prev), js.length > 1 ? 0.9 : 1.1).sub(pH));
        }
        if (hand.length === 1) hand.push(pH.clone().sub(pL).normalize().multiplyScalar(0.75 * b));
        this.arms.push({ side, chain: names, restPos, a, b, restU: pL.clone().sub(pU).normalize(), restL: pH.clone().sub(pL).normalize(), elbowOff: pL.clone().sub(pU), wrist, pivot: st ? st.pivot.clone() : null, fingers, hand });
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ gait specs
  private baseFamily(): GaitFamily {
    const f = this.cfg.gait.family;
    return familyFor(f === 'auto' ? (this.legs.length === 4 ? 'walk' : 'auto') : f, this.legs.length);
  }
  /** The spec for a family (cached): the profile's stride / lift / periods / hitch, the legs' explicit phases. */
  specFor(f: GaitFamily): GaitSpec {
    const fam = familyFor(f, this.legs.length);
    let s = this.specs.get(fam);
    if (!s) {
      const per = this.cfg.gait.period;
      const period = fam === 'walk' ? per.walk : fam === 'march' ? per.march : fam === 'hustle' ? per.hustle : undefined;
      s = gaitFor(fam, this.sideKeys, { sides: this.slots, stride: this.stride, lift: this.lift, ...(period ? { period } : {}), ...(this.cfg.gait.duty ? { duty: this.cfg.gait.duty } : {}), swing: { lift: 0.25, carry: 0.55, slam: 0.2, hitch: this.cfg.gait.hitch }, offsets: this.phases });
      this.specs.set(fam, s);
    }
    return s;
  }
  /** The fastest family's speed (model units / s): SPEC vmax = stride / period.hustle (4 legs). */
  private vmaxModel() {
    const n = this.legs.length;
    const fast: GaitFamily = n === 4 ? 'hustle' : n === 6 ? 'tripod' : n === 2 ? 'biped' : n === 8 ? 'tetrapod' : 'ripple';
    return specSpeed(this.specFor(fast));
  }

  // ------------------------------------------------------------------------------------------------ inputs + limits
  /** Inputs for this frame (the Locomotion layer, every frame). */
  feed(i: Partial<MechInputs>) { Object.assign(this.inp, i); this.fed = true; }
  /** Top speed (room m/s) at an actor scale (room metres per anchor unit). */
  maxSpeed(actorScale = 1) { return this.vmaxModel() * this.sMA * actorScale; }
  /** The walk a mover should plan for a path (room metres): short trips walk (one foot at a time), medium ones march,
   *  long ones hustle; the family follows the speed (pickFamily). Deterministic per walk. */
  planFor(lenRoom: number, actorScale = 1, vcap = Infinity): { v: number; family: GaitFamily } {
    const k = this.sMA * actorScale;
    const strideRoom = this.stride * k;
    // (SPEC pickFamily: < 45 % of vmax walks, < 75 % marches, else hustles: plan just inside each band)
    const vmax = this.maxSpeed(actorScale);
    const share = this.legs.length !== 4 ? 1 : lenRoom < 4 * strideRoom ? 0.42 : lenRoom < 10 * strideRoom ? 0.68 : 1;
    const v = Math.min(vcap, share * vmax);
    void specSpeed;
    return { v, family: pickFamily(v, vmax, this.legs.length) };
  }
  /** In-place turn rate (rad/s, the mover's average over an eased turn): the profile's (SPEC: turnRate / sqrt(heroScale)),
   *  but never faster than the legs can step it. A turn on the spot is stepped like a walk (turnPer of gait distance a
   *  radian, one gait cycle per stride): at the quickest cadence this machine has (its fastest family's period) the
   *  eased turn's peak (1.5 x its average) still gives every foot a real swing, not a flicker. A short stride or a
   *  narrow coxa (a big turnPer) makes a slow, honest turn. */
  get turnRate() {
    const cfg = this.cfg.turnRate / Math.sqrt(Math.max(1, this.cfg.heroScale));
    const n = this.legs.length;
    const fast = this.specFor(n === 4 ? 'hustle' : n === 6 ? 'tripod' : n === 2 ? 'biped' : n === 8 ? 'tetrapod' : 'ripple').period;
    const legs = this.stride / (fast * this.turnPer * 1.5);
    return Math.min(cfg, legs > 0 && Number.isFinite(legs) ? legs : cfg);
  }
  /** Metres of "stride" per radian turned on the spot (the feet's arc; more for narrow coxa yaw ranges). */
  turnStep(actorScale = 1) { return this.turnPer * this.sMA * actorScale; }
  get spool() { return this.cfg.spool; }
  get settle() { return this.cfg.settle; }
  /** Footprint radius in room metres (clearance checks). */
  footprintRoom(actorScale = 1) { return this.footprint * this.sMA * actorScale; }
  /** Leg count (gait families). */
  get legCount() { return this.legs.length; }
  /** Model units / s at the current family's pace. */
  private topSpeed() { return specSpeed(this.spec); }

  // ------------------------------------------------------------------------------------------------ frame: pre
  /** After the tracking + pose hook + emotes, before humanoid.update(). */
  preHumanoid(dt: number, resting = false) {
    this.restBody();
    if (resting) { this.init = false; return; }
    const src = this.treadmill > 0 ? { gait: Math.min(1, this.treadmill * 3), travel: 1, back: false } : this.fed ? this.inp : this.res;
    const hands = this.cfg.pilot.hands;
    const target = hands === 'free' ? 0 : hands === 'grip' ? 1 : clamp01(src.travel);
    this.handW += (target - this.handW) * (dt > 0 ? 1 - Math.exp(-dt / 0.09) : 1);
    if (Math.abs(target - this.handW) < 1e-4) this.handW = target;
    const w = smoothstep(this.handW);
    // sticks (SPEC): pitch 12° × speed, roll ±10° × turn while travelling; a spring (ω 8) back to neutral when parked
    const tr = clamp01(src.travel);
    const turn = THREE.MathUtils.clamp(this.yawRate / Math.max(0.2, this.cfg.turnRate), -1, 1);
    const fwd = clamp01(src.gait) * (src.back ? -1 : 1);
    for (const s of ['left', 'right'] as Side[]) {
      this.stick[s].p.step(12 * D2R * fwd * tr, 8, 0.8, dt);
      this.stick[s].r.step(-10 * D2R * turn * tr, 8, 0.8, dt);
    }
    const h = this.humanoid;
    if (!h) return;
    // a strapped-in pilot: legs (if any) at rest, hips locked, the torso lean clamped to the seat's give
    for (const n of ['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'] as VRMHumanBoneName[]) h.getNormalizedBoneNode(n)?.quaternion.copy(I);
    if (this.cfg.pilot.lockHips && this.hips) this.hips.quaternion.copy(I);
    this.limitTorso(h);
    this.levelHead(h);
    // tracked hands (parked, or blending onto the sticks) stay inside the cockpit and out of the cage posts (SPEC M4)
    if (this.handBox && w < 1 - 1e-4) for (const arm of this.arms) this.guardHand(arm);
    if (w < 1e-4 || !this.arms.length || this.cfg.pilot.hands === 'free') return;
    // the reach: the tracked torso lean halved while the hands are on the controls
    for (const n of ['spine', 'chest', 'upperChest'] as VRMHumanBoneName[]) h.getNormalizedBoneNode(n)?.quaternion.slerp(I, 0.5 * w);
    for (const arm of this.arms) this.gripArm(arm, w);
  }

  /** The pilot's eyes stay level-ish (SPEC C14): the NORMALIZED neck counters `levelHead` of the cab's roll / pitch (last
   *  frame's springs: a 1-frame lag nobody sees), before humanoid.update, so the neck rig spreads it like any head turn
   *  instead of overwriting it. (Head: when the rig has no neck.) */
  private levelHead(h: VRMHumanoid) {
    const lv = this.cfg.pilot.levelHead;
    if (!(lv > 0) || !this.cockpit) return;
    const n = h.getNormalizedBoneNode('neck') ?? h.getNormalizedBoneNode('head');
    if (!n) return;
    // (nothing rewrote the bone since last frame (no tracking frame): take last frame's counter-tilt off first, so it
    // never builds up)
    const f = this.neckFix;
    if (f && f.bone === n && n.quaternion.equals(f.wrote)) n.quaternion.premultiply(f.q.clone().invert());
    this.neckFix = null;
    const cp = this.sc.pitch.x + this.gTilt.pitch, cr = this.sc.roll.x + this.gTilt.roll;
    if (Math.abs(cp) + Math.abs(cr) < 1e-7) return;
    const cq = _q.setFromEuler(_e.set(cp, 0, cr, 'XYZ')).invert();
    const k = _q3.identity().slerp(cq, lv);
    const pw = worldQ(n.parent, h.normalizedHumanBonesRoot.parent, _q2);
    const F = pw.clone().invert().multiply(k).multiply(pw);
    n.quaternion.premultiply(F);
    this.neckFix = { bone: n, q: F, wrote: n.quaternion.clone() };
  }
  private neckFix: { bone: THREE.Object3D; q: THREE.Quaternion; wrote: THREE.Quaternion } | null = null;

  /** The tracked arm's chain in model space (rest skeleton + the normalized rotations): shoulder, elbow, wrist. */
  private armNow(arm: ArmRig) {
    const h = this.humanoid!;
    const stop = h.normalizedHumanBonesRoot.parent;
    const p = arm.restPos[arm.chain[0]].clone();
    for (let i = 1; i < arm.chain.length; i++) {
      const parent = h.getNormalizedBoneNode(arm.chain[i - 1])!;
      p.add(_v.copy(arm.restPos[arm.chain[i]]).sub(arm.restPos[arm.chain[i - 1]]).applyQuaternion(worldQ(parent, stop, _q)));
    }
    const ua = h.getNormalizedBoneNode(`${arm.side}UpperArm` as VRMHumanBoneName)!, la = h.getNormalizedBoneNode(`${arm.side}LowerArm` as VRMHumanBoneName)!;
    const elbow = p.clone().addScaledVector(_v.copy(arm.restU).applyQuaternion(worldQ(ua, stop, _q)), arm.a);
    const wrist = elbow.clone().addScaledVector(_v.copy(arm.restL).applyQuaternion(worldQ(la, stop, _q)), arm.b);
    return { shoulder: p, elbow, wrist, stop, ua, la };
  }

  /** Where a tracked wrist may be (model space): inside the hand box, outside every post capsule; null = it already is. */
  clampWrist(w: THREE.Vector3): THREE.Vector3 | null {
    const hb = this.handBox;
    if (!hb) return null;
    const t = w.clone();
    const e = 0.002;
    const inBox = (q: THREE.Vector3) => q.x >= hb.min.x && q.x <= hb.max.x && q.y >= hb.min.y && q.y <= hb.max.y && q.z >= hb.min.z && q.z <= hb.max.z;
    const post = (q: THREE.Vector3) => {
      for (const c of hb.posts) {
        const ab = _v2.copy(c.b).sub(c.a), k = THREE.MathUtils.clamp(_v3.copy(q).sub(c.a).dot(ab) / Math.max(1e-12, ab.lengthSq()), 0, 1);
        const cp = c.a.clone().addScaledVector(ab, k), d = q.distanceTo(cp);
        if (d < c.r) return { c, cp, d };
      }
      return null;
    };
    if (inBox(t) && !post(t)) return null;
    for (let it = 0; it < 4; it++) {
      t.set(THREE.MathUtils.clamp(t.x, hb.min.x + e, hb.max.x - e), THREE.MathUtils.clamp(t.y, hb.min.y + e, hb.max.y - e), THREE.MathUtils.clamp(t.z, hb.min.z + e, hb.max.z - e));
      const hit = post(t);
      if (!hit) break;
      // out of the post, radially (straight in toward the box's middle when the point is on the post's axis)
      const dir = hit.d > 1e-6 ? t.clone().sub(hit.cp).normalize() : hb.min.clone().add(hb.max).multiplyScalar(0.5).sub(hit.cp).setY(0).normalize();
      t.copy(hit.cp).addScaledVector(dir, hit.c.r + e);
    }
    return t;
  }

  /** Where a tracked wrist must go so the WHOLE hand (the points `offs` from the wrist, turned by the hand's tracked
   *  orientation `q`, each with HAND_R of skin round it) is inside the hand box and out of every cage post (model
   *  space); null = it already is. The hand only moves, it never turns. */
  clampHandAt(w: THREE.Vector3, q: THREE.Quaternion, offs: THREE.Vector3[], reach?: { s: THREE.Vector3; min: number; max: number }): THREE.Vector3 | null {
    const hb = this.handBox;
    if (!hb) return null;
    const r = HAND_R, e = 0.002;
    const P = offs.map((o) => o.clone().applyQuaternion(q));
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const p of P) { lo.min(p); hi.max(p); }
    const x = new THREE.Vector3(), ab = new THREE.Vector3(), cp = new THREE.Vector3();
    const mid = hb.min.clone().add(hb.max).multiplyScalar(0.5);
    // the deepest post penetration of the hand moved by d (pen <= 0: none), the post, and the way straight out of it
    const deepest = (d: THREE.Vector3) => {
      let pen = 0, post: (typeof hb.posts)[number] | null = null;
      const dir = new THREE.Vector3();
      for (const p of P) {
        x.copy(w).add(d).add(p);
        for (const c of hb.posts) {
          ab.copy(c.b).sub(c.a);
          const k = THREE.MathUtils.clamp(_v3.copy(x).sub(c.a).dot(ab) / Math.max(1e-12, ab.lengthSq()), 0, 1);
          cp.copy(c.a).addScaledVector(ab, k);
          const dist = x.distanceTo(cp), pn = c.r + r - dist;
          if (pn <= pen) continue;
          pen = pn; post = c;
          if (dist > 1e-6) dir.copy(x).sub(cp).divideScalar(dist); else dir.copy(mid).sub(cp).setY(0).normalize();
        }
      }
      return { pen, post, dir };
    };
    const boxOut = (d: THREE.Vector3) => Math.max(hb.min.x + r - (w.x + d.x + lo.x), w.x + d.x + hi.x - (hb.max.x - r), hb.min.y + r - (w.y + d.y + lo.y), w.y + d.y + hi.y - (hb.max.y - r), hb.min.z + r - (w.z + d.z + lo.z), w.z + d.z + hi.z - (hb.max.z - r));
    // (where the arm can put the wrist: between a folded and a straight arm from the shoulder)
    const reachOut = (d: THREE.Vector3) => { if (!reach) return 0; const L = x.copy(w).add(d).distanceTo(reach.s); return Math.max(reach.min - L, L - reach.max); };
    const viol = (d: THREE.Vector3) => Math.max(boxOut(d), deepest(d).pen, reachOut(d));
    const zero = new THREE.Vector3();
    if (viol(zero) <= 1e-6) return null;
    // box first (per axis: the wrist positions that keep every point inside; a hand too big for it: centred), then the
    // deepest point straight out of its post, until both hold
    const solve = (d0: THREE.Vector3) => {
      const d = d0.clone();
      for (let it = 0; it < 10; it++) {
        for (const ax of ['x', 'y', 'z'] as const) {
          const a = hb.min[ax] + r + e - lo[ax], b = hb.max[ax] - r - e - hi[ax], cur = w[ax] + d[ax];
          d[ax] += (a <= b ? THREE.MathUtils.clamp(cur, a, b) : (a + b) / 2) - cur;
        }
        if (reach) {
          const v = x.copy(w).add(d).sub(reach.s), L = v.length();
          const Lc = THREE.MathUtils.clamp(L, reach.min, reach.max);
          if (Math.abs(Lc - L) > 1e-9 && L > 1e-9) d.addScaledVector(v, Lc / L - 1);
        }
        const t = deepest(d);
        if (t.pen <= 1e-6) break;
        d.addScaledVector(t.dir, t.pen + e);
      }
      return d;
    };
    // (a post near the box's side, a stick: straight out of it can be out of the box, and the box pushes it back in.
    // Then the hand goes round it: 26 ways (the faces, edges and corners of a cube), 2 cm further each round, and the
    // first round with a place that fits gives the smallest such move)
    const d0 = solve(zero);
    let best = d0, bv = viol(d0);
    const okV = 5e-4;
    if (bv <= okV) return w.clone().add(d0);
    for (let n = 1; n <= 10; n++) {
      let fit: THREE.Vector3 | null = null;
      for (const u of CUBE_DIRS) {
        const d = solve(u.clone().multiplyScalar(n * 0.02).add(d0)), vv = viol(d);
        if (vv <= okV) { if (!fit || d.lengthSq() < fit.lengthSq()) fit = d; }
        else if (vv < bv) { bv = vv; best = d; }
      }
      if (fit) return w.clone().add(fit);
    }
    return w.clone().add(best);
  }

  /** A tracked hand reaching out of the cockpit or into a cage post: the wrist goes to the nearest place where the whole
   *  hand fits (its fingers too, at their tracked orientation) and the arm is re-solved (two-bone IK, the tracked elbow
   *  as the pole); the hand keeps its tracked orientation. */
  private guardHand(arm: ArmRig) {
    const h = this.humanoid!;
    const now = this.armNow(arm);
    const { ua, la, stop } = now;
    const hd = h.getNormalizedBoneNode(`${arm.side}Hand` as VRMHumanBoneName);
    const handW = hd ? worldQ(hd, stop, new THREE.Quaternion()) : null;
    const reach = { s: now.shoulder, min: Math.abs(arm.a - arm.b) + 2e-4, max: arm.a + arm.b - 2e-4 };
    const fit = (w: THREE.Vector3) => (handW && arm.hand.length > 1 ? this.clampHandAt(w, handW, arm.hand, reach) : this.clampWrist(w));
    let T = fit(now.wrist);
    if (!T) return;
    // (a place the arm can't reach (past full stretch, or closer to the shoulder than a folded arm): the nearest one it
    // can, fitted again)
    for (let k = 0; k < 3; k++) {
      const st = T.clone().sub(now.shoulder), dd = st.length();
      const lim = THREE.MathUtils.clamp(dd, Math.abs(arm.a - arm.b) + 2e-4, arm.a + arm.b - 2e-4);
      if (Math.abs(lim - dd) < 1e-6) break;
      const R = now.shoulder.clone().addScaledVector(st.divideScalar(Math.max(dd, 1e-9)), lim);
      T = fit(R) ?? R;
    }
    const { elbow, wrist } = solveElbow(now.shoulder, T, arm.a, arm.b, now.elbow);
    const parentW = worldQ(ua.parent, stop, new THREE.Quaternion());
    const du = elbow.clone().sub(now.shoulder).normalize(), dl = wrist.clone().sub(elbow).normalize();
    const upW = _q2.setFromUnitVectors(_v3.copy(arm.restU).applyQuaternion(worldQ(ua, stop, _q)), du).multiply(worldQ(ua, stop, _q));
    ua.quaternion.copy(parentW.clone().invert().multiply(upW));
    const upWb = parentW.clone().multiply(ua.quaternion);
    const loNow = upWb.clone().multiply(la.quaternion);
    const loW = _q2.setFromUnitVectors(_v3.copy(arm.restL).applyQuaternion(loNow), dl).multiply(loNow);
    la.quaternion.copy(upWb.clone().invert().multiply(loW));
    if (hd && handW) hd.quaternion.copy(upWb.clone().multiply(la.quaternion).invert().multiply(handW));
  }

  /** Clamp the torso top's lean (its rotation over the hips) to torsoLimit [pitch, yaw, roll] degrees. */
  private limitTorso(h: VRMHumanoid) {
    const top = (['upperChest', 'chest', 'spine'] as VRMHumanBoneName[]).map((n) => h.getNormalizedBoneNode(n)).find((n) => !!n);
    const hips = h.getNormalizedBoneNode('hips');
    if (!top || !hips || !top.parent) return;
    const lim = this.cfg.pilot.torsoLimit;
    const rel = worldQ(top, hips, _q);                     // spine … top, relative to the hips
    _e.setFromQuaternion(rel, 'YXZ');
    const x = clampA(_e.x, lim[0] * D2R), y = clampA(_e.y, lim[1] * D2R), z = clampA(_e.z, lim[2] * D2R);
    if (x === _e.x && y === _e.y && z === _e.z) return;
    const want = _q2.setFromEuler(_e.set(x, y, z, 'YXZ'));
    const parentRel = worldQ(top.parent, hips, _q3);
    top.quaternion.copy(parentRel.invert().multiply(want));
  }

  /** Stick tilt rotation (model space) for a side this frame. */
  private stickRot(side: Side, out: THREE.Quaternion) {
    return out.setFromEuler(_e.set(this.stick[side].p.x, 0, this.stick[side].r.x, 'XYZ'));
  }

  private gripArm(arm: ArmRig, w: number) {
    const h = this.humanoid!;
    const S = arm.side;
    const ua = h.getNormalizedBoneNode(`${S}UpperArm` as VRMHumanBoneName), la = h.getNormalizedBoneNode(`${S}LowerArm` as VRMHumanBoneName);
    const hd = h.getNormalizedBoneNode(`${S}Hand` as VRMHumanBoneName);
    if (!ua || !la) return;
    const stop = h.normalizedHumanBonesRoot.parent;
    // shoulder by forward kinematics over the raw rest skeleton + the normalized (tracked) rotations: model space
    const p = arm.restPos[arm.chain[0]].clone();
    for (let i = 1; i < arm.chain.length; i++) {
      const parent = h.getNormalizedBoneNode(arm.chain[i - 1])!;
      p.add(_v.copy(arm.restPos[arm.chain[i]]).sub(arm.restPos[arm.chain[i - 1]]).applyQuaternion(worldQ(parent, stop, _q)));
    }
    const parentW = worldQ(ua.parent, stop, new THREE.Quaternion());
    const pole = p.clone().add(_v2.copy(arm.elbowOff).applyQuaternion(parentW));
    const tilt = this.stickRot(S, new THREE.Quaternion());
    const T = arm.pivot ? arm.wrist.clone().sub(arm.pivot).applyQuaternion(tilt).add(arm.pivot) : arm.wrist.clone();
    const { elbow, wrist } = solveElbow(p, T, arm.a, arm.b, pole);
    const du = elbow.clone().sub(p).normalize(), dl = wrist.clone().sub(elbow).normalize();
    const upW = _q2.setFromUnitVectors(_v3.copy(arm.restU).applyQuaternion(parentW), du).multiply(parentW);
    ua.quaternion.slerp(_q3.copy(parentW).invert().multiply(upW), w);
    const upWb = parentW.clone().multiply(ua.quaternion);
    const loW = _q2.setFromUnitVectors(_v3.copy(arm.restL).applyQuaternion(upWb), dl).multiply(upWb);
    la.quaternion.slerp(_q3.copy(upWb).invert().multiply(loW), w);
    if (hd) {
      // the hand turns with its stick (rest = holding it)
      const loNow = upWb.clone().multiply(la.quaternion);
      hd.quaternion.slerp(loNow.invert().multiply(tilt), w);
    }
    if (this.retarget) this.retarget.holdGrip(S, w, arm.fingers);
    else if (arm.fingers === 'bind') for (const n of FINGER_BONES[S]) h.getNormalizedBoneNode(n)?.quaternion.slerp(I, w);
  }

  // ------------------------------------------------------------------------------------------------ frame: post
  /**
   * After humanoid.update(), before the neck rig and the spring bones. Two layers:
   *  - the STATE (which feet lift, where they land, the body's springs): `logic`. When the scene's mover gives its inputs
   *    as a pure function of its own clock (WalkMover: inputs.at + inputs.clock), the state runs on fixed ticks of that
   *    clock (TICK_HZ, at k / TICK_HZ s): every page (the studio at 144 fps, OBS at 30 / 60, guests) runs the same ticks
   *    with the same inputs, so the same feet lift at the same distances and land at the same places, and the springs
   *    move the same way (SPEC §2.8, R2). Otherwise (Classic, the treadmill, other movers): once a frame, as before.
   *  - the POSE (the hull over its feet, IK, sticks, pistons): every frame, from that state.
   */
  postHumanoid(dt: number, resting = false) {
    if (resting) { this.restBody(); this.init = false; this.fed = false; this.tickN = NaN; return; }
    const model = this.model;
    // matrices: the model's ancestors (the mount moved), then the chain down to the hull; poseBody refreshes the hull's
    // subtree (legs, cab, pilot). No hull bone: everything.
    if (this.pelvis?.bone.parent) this.pelvis.bone.parent.updateWorldMatrix(true, false);
    else model.updateWorldMatrix(true, true);
    const G = model.matrixWorld;
    const Gq = new THREE.Quaternion(), Gs = new THREE.Vector3();
    G.decompose(_v3, Gq, Gs);
    const sW = Gs.x || 1;
    const posW = new THREE.Vector3().setFromMatrixPosition(G);
    const fwdW = Z.clone().applyQuaternion(Gq);
    const r = this.res, inp = this.inp;
    const fedNow = this.fed && this.treadmill <= 0;
    this.floorAt = fedNow ? inp.floorAt ?? null : null;
    // where the model will be at a job distance (model units): the mover's own pose there, carried through the current
    // mount → model offset (seat offsets, scale)
    const poseAt = fedNow ? inp.poseAt ?? null : null, mount = fedNow ? inp.mount ?? null : null;
    const toModel = mount ? new THREE.Matrix4().copy(mount.matrixWorld).invert().multiply(G) : null;
    const modelOf = (pa: ((d: number) => THREE.Matrix4 | null) | null | undefined) => (pa && toModel ? (d: number) => { const M = pa(d * this.sMA); return M ? M.clone().multiply(toModel) : null; } : null);
    const modelAt = modelOf(poseAt);
    const at = fedNow ? inp.at ?? null : null, clock = inp.clock ?? NaN;
    const ticking = !!at && Number.isFinite(clock);
    if (ticking !== this.tickMode) { this.tickMode = ticking; this.readying = false; this.readyAt = -1; this.tickN = NaN; }
    if (ticking) this.runTicks(clock, G, modelAt, modelOf);
    else {
      this.time += dt;
      let family: GaitFamily | null = null;
      if (this.treadmill > 0) {
        const step = this.treadmill * this.topSpeed() * dt;
        this.tmDist += step;
        r.dist = this.tmDist; r.gait = Math.min(1, r.gait + dt / 0.6); r.stride = 1; r.back = false; r.travel = 1;
        const back = fwdW.clone().multiplyScalar(-step * sW);              // the ground slides back under the feet
        for (const l of this.legs) { l.plant.add(back); l.from.add(back); }
      } else if (this.fed) {
        r.dist = inp.dist / this.sMA; r.gait = clamp01(inp.gait); r.stride = clamp01(inp.stride); r.back = inp.back; r.travel = clamp01(inp.travel);
        family = inp.family ?? null;
      } else {
        const d = this.init ? Math.hypot(posW.x - this.lastPos.x, posW.z - this.lastPos.z) / sW : 0;
        if (d < this.L * 2) this.fbDist += d;
        r.dist = this.fbDist; r.stride = 1; r.back = false;
        r.gait = clamp01(this.loco || this.speed / Math.max(1e-6, this.topSpeed()));
        r.travel = r.gait > 0.05 ? 1 : Math.max(0, r.travel - dt / 0.8);
      }
      this.logic(dt, G, modelAt, family, false);
    }
    this.fed = false;

    // ---- the pose: the hull (springs + over its feet), IK: every leg to its foot target (hinge-constrained), sticks, pistons
    this.poseBody(G);
    const { maxReach, clamped } = this.solveLegs(Gq);
    this.poseSticks();
    this.posePistons();

    // ---- lamps + FX
    const spoolOn = r.travel > 0.02 && r.travel < 0.98 && !this.wasMoving;
    let lt = this.docked ? 0.6 : 0.25 + 0.75 * smoothstep(r.travel);
    if (spoolOn) lt *= 0.55 + 0.45 * (Math.sin(this.time * 47) > -0.2 ? 1 : 0.15);  // a flicker while it powers up
    this.lamp += (lt - this.lamp) * (dt > 0 ? 1 - Math.exp(-dt / (lt < this.lamp ? 0.6 : 0.05)) : 1);
    for (const x of this.lamps) x.m.emissiveIntensity = x.base * this.lamp;
    if (this.fxEnabled) {
      try { this.fx ??= new MechFx(this); this.fx.update(dt); } catch (e) { console.warn('mech fx', e); this.fxEnabled = false; this.fx?.dispose(); this.fx = null; }
    }
    this.last = { moving: this.wasMoving, swinging: this.legs.filter((l) => l.mode === 'swing').length, maxReach, pelvisY: this.sp.y.x / this.L, handW: this.handW, family: this.spec.family, clamped };
  }

  /** The ticks up to the mover's `clock` (k / TICK_HZ, each once): every page runs the same ones. */
  private runTicks(clock: number, G: THREE.Matrix4, modelAt: ((d: number) => THREE.Matrix4 | null) | null, modelOf: (pa: ((d: number) => THREE.Matrix4 | null) | null | undefined) => ((d: number) => THREE.Matrix4 | null) | null) {
    const at = this.inp.at;
    if (!at) return false;
    const r = this.res;
    const k1 = Math.floor(clock * TICK_HZ + 1e-4);
    // (the first tick, a clock that went back, or a page that slept: from now on; the gap shows up as a jump / a new
    // phase, exactly like a late join)
    if (!Number.isFinite(this.tickN) || k1 < this.tickN || k1 - this.tickN > TICK_HZ) this.tickN = k1 - 1;
    const ran = k1 > this.tickN;
    for (let k = this.tickN + 1; k <= k1; k++) {
      const s = at(k / TICK_HZ);
      if (!s) continue;
      this.time = k / TICK_HZ;
      r.dist = s.dist / this.sMA; r.gait = clamp01(s.gait); r.stride = clamp01(s.stride); r.back = !!s.back; r.travel = clamp01(s.travel);
      // (the instant's own walk: a re-target can fall between two frames)
      this.logic(1 / TICK_HZ, G, s.poseAt === undefined ? modelAt : modelOf(s.poseAt), s.family ?? null, true);
    }
    this.tickN = k1;
    return ran;
  }

  /**
   * One step of the state (a tick, or a frame): inputs in this.res. `Gf` = the model's world matrix this frame; on a tick
   * with the mover's poses, the model's matrix at the tick's own distance (pure) stands in for it, so nothing here
   * depends on when the frames fell.
   */
  private logic(dt: number, Gf: THREE.Matrix4, modelAt: ((d: number) => THREE.Matrix4 | null) | null, family: GaitFamily | null, ticking: boolean) {
    const r = this.res;
    const G = (ticking && modelAt ? modelAt(r.dist) : null) ?? Gf;
    const Gq = new THREE.Quaternion(), Gs = new THREE.Vector3();
    G.decompose(_v3, Gq, Gs);
    const sW = Gs.x || 1;
    const posW = new THREE.Vector3().setFromMatrixPosition(G);
    const fwdW = Z.clone().applyQuaternion(Gq);
    const yaw = Math.atan2(fwdW.x, fwdW.z);
    const moving = r.gait > 0.02;
    // the family for this walk (the mover's pick, else the profile's)
    const fam = familyFor(family ?? this.baseFamily(), this.legs.length);
    // (the swap waits until every foot is down: the old pattern's steps land first, then the new one starts; a foot of
    // the old pattern still in the air on top of the new one's would put more than half the legs up)
    if (fam !== this.spec.family && !this.legs.some((l) => l.mode === 'swing')) {
      this.spec = this.specFor(fam);
      this.rephase(r.dist, false);
    }
    const spec = this.spec, D = spec.duty, c = spec.stride;

    // ---- discontinuities: first frame, a snap / teleport, a new walk (its distance restarts), a scale change
    const dd = r.dist - this.lastDist;
    const jumpPos = this.init && posW.distanceTo(this.lastPos) > Math.max(0.6 * this.L * sW, Math.abs(dd) * sW * 4 + 0.02 * this.L * sW);
    const jumpScale = this.init && Math.abs(sW / this.lastScale - 1) > 0.01;
    if (!this.init || jumpPos || jumpScale) this.resetLegs(moving, G, modelAt);
    else if (dd < -1e-9 || dd > c) this.rephase(r.dist, true);
    if (this.init && dt > 0) {
      const v = Math.max(0, Math.min(dd, c)) / dt;
      const a0 = (v - this.speed) / dt;
      this.speed += (v - this.speed) * (1 - Math.exp(-8 * dt));
      this.accel += (a0 - this.accel) * (1 - Math.exp(-4 * dt));
      const dy = wrap(yaw - this.lastYaw);
      this.yawRate += (dy / dt - this.yawRate) * (1 - Math.exp(-8 * dt));
      if (dd > 1e-6 && dd <= c) this.kappa += (THREE.MathUtils.clamp(dy / dd, -4 / this.footprint, 4 / this.footprint) - this.kappa) * (1 - Math.exp(-12 * dt));
      else if (!moving) this.kappa *= Math.exp(-4 * dt);
    }
    const prevDist = this.lastDist;
    this.lastDist = r.dist; this.lastPos.copy(posW); this.lastYaw = yaw; this.lastScale = sW; this.init = true;

    // ---- legs: phase → stance / swing, landings, settle steps
    const up = Y.clone().applyQuaternion(Gq);
    const swingT = Math.max(0.3, spec.period * (1 - D) * 1.25);
    const homeT = Math.max(0.7, this.specFor('walk').period * (1 - this.specFor('walk').duty) * 2);
    const hold = hitchShare(spec);
    const ahead = smoothstep(r.gait / 0.25);
    // feet allowed in the air at once with an off-schedule step in the mix: half the legs (4 legs: 2), so at least
    // half always stand; the gait's own pattern may already use some of them (walk 1, march / hustle 2 ...)
    const budget = this.upBudget();
    let swinging = this.legs.filter((l) => l.mode === 'swing').length;
    const Ginv = new THREE.Matrix4().copy(G).invert();
    const sgn = r.back ? -1 : 1;
    // a planted foot against its parking spot under the model whose INVERSE world matrix is Minv (model units): along
    // the travel direction (negative = behind), sideways, and in total on the ground
    const offOf = (l: LegRig, Minv: THREE.Matrix4, at: THREE.Vector3 = l.plant) => {
      _v.copy(at).applyMatrix4(Minv);
      const ex = _v.x - l.neutral.x, ez = (_v.z - l.neutral.z) * sgn;
      return { along: ez, side: Math.abs(ex), off: Math.hypot(ex, ez) };
    };
    this.settleWait = Math.max(0, this.settleWait - dt);
    this.stillT = moving ? 0 : this.stillT + dt;
    if (!moving) for (const l of this.legs) l.resAt = NaN;
    // (standing up for a walk from parked: see step 0)
    if (moving || r.travel < 0.02) { this.readying = false; this.readyAt = -1; }
    else if (this.parked && r.travel > 0.02) this.readying = true;
    // a planted foot's lag (see 2.): the job distance it crosses the gait's own lift-off excursion, when it will still
    // be out there at this stance's lift-off; null = it won't (or it has no stance left to worry about)
    const sw = r.stride > 0.2 ? r.stride : 1;
    const thr = ((D * c) / 2) * sw * 1.02;
    const lagAt = (l: LegRig, i: number, ls: ReturnType<typeof legState>): number | null => {
      const lo = ls.tdDist + D * c;
      if (modelAt) {
        const offAt = (d: number, at?: THREE.Vector3) => { const M = modelAt(d); return M ? offOf(l, M.invert(), at).off : offOf(l, Ginv, at).off; };
        // (where the foot is against the body NOW: the mover's pose at this distance, so a tick never depends on when
        // the frames fell)
        const nowOff = offAt(r.dist);
        // the envelope: the gait's own lift-off excursion, or this stance's regular plant's when the path makes that
        // larger (a curve without a turn-aware mover): a foot only lags when it does worse than its own gait would
        const W = this.landing(l, i, ls.tdDist + (D * c) / 2, 1, 0, r, G, modelAt).clone();
        const T = Math.max(thr, offAt(lo, W) + 0.02 * D * c);
        if (!(offAt(lo) > T)) return null;                 // (out in front now is fine: it comes back under the body)
        if (nowOff > T) {
          // already out and staying out: from where it crossed in this step (or now)
          if (dd > 1e-9 && dd <= c) { const prev = offAt(prevDist); if (prev < T && nowOff > prev) return prevDist + ((T - prev) / (nowOff - prev)) * dd; }
          return r.dist;
        }
        let x0 = r.dist, x1 = lo;
        for (let k = 0; k < 18; k++) { const m = (x0 + x1) / 2; if (offAt(m) > T) x1 = m; else x0 = m; }
        return x1;
      }
      // (no mover pose: straight-line travel; the frame's own crossing)
      const now = offOf(l, Ginv);
      if (now.off > thr && (now.along < 0 || now.side > thr) && Math.abs(now.along - ((D * c) / 2 - ls.p * c) * r.stride) > 0.2 * D * c * sw) {
        if (dd > 1e-9 && dd <= c) { const prev = now.off - dd * sw; if (prev < thr) return prevDist + ((thr - prev) / Math.max(1e-9, now.off - prev)) * dd; }
        return r.dist;
      }
      return null;
    };
    // swing progress (the gait's: by its phase; off-schedule: by distance; re-based / settle: by time; getting ready: by
    // the stand-up's own clock) and the landing
    const progress = (i: number) => {
      const l = this.legs[i];
      const ls = legState(spec, i, r.dist);
      if (l.mode === 'swing') {
        let late = 0;                                    // how long ago the step really ended (the thump is placed there)
        if (l.prepAt >= 0) { l.u = (this.time - l.prepAt) / l.T; late = Math.max(0, (l.u - 1) * l.T); }
        else if (l.dLen > 0 && moving) { l.u = Math.max(l.u, (r.dist - l.d0) / l.dLen); late = this.speed > 1e-6 ? Math.min(dt, Math.max(0, (r.dist - l.d0 - l.dLen) / this.speed)) : 0; }
        else if (l.timed || l.dLen > 0 || !moving) { const T = l.home ? homeT : l.T > 0 ? l.T : swingT; l.u += dt / T; late = Math.max(0, (l.u - 1) * T); }
        else {
          if (ls.stance) late = this.speed > 1e-6 ? Math.min(dt, (ls.p * c) / this.speed) : 0;
          l.u = ls.stance ? 1 : Math.max(l.u, ls.u);
        }
        // landing: the parking spot at the mid-stance pose of this foot's cycle (off-schedule steps: their own, planMid;
        // settle steps: the parking spot now); on the room's floor there (SPEC M1)
        const mid = Number.isNaN(l.mid) ? ls.tdDist + (D * c) / 2 : l.mid;
        const offs = l.dLen > 0 || l.timed;
        const B = l.home ? this.ground(l.neutral.clone().applyMatrix4(G)) : this.landing(l, i, mid, ahead, (ls.stance && !offs) || l.dLen > 0 ? (D * c) / 2 - ls.p * c : (D * c) / 2, r, G, modelAt);
        const sc = swingCurve(Math.min(1, l.u), spec.style ?? 'mech', spec.swing, offs ? 0 : hold);
        const dy = l.from.clone().sub(B).dot(up);
        // (the apex clears a step between the two plants by 6 cm: SPEC M1)
        const liftW = Math.max(spec.lift * sW * (l.home ? 0.6 : 1), this.floorAt ? Math.abs(dy) + 0.06 : 0);
        l.pos.copy(l.from).addScaledVector(up, -dy).lerp(B, sc.s).addScaledVector(up, (1 - sc.s) * dy + sc.h * liftW);
        l.gy = B.y + (1 - sc.s) * (l.g0 - B.y);
        l.h = sc.h;
        // (a step's own count: the cycle of the distance it ended at, so a step that lands just before its leg's next
        // window opens still takes that window, whichever frame or tick the two fell in)
        if (l.u >= 1) { const dl = l.dLen > 0 ? Math.min(r.dist, l.d0 + l.dLen) : r.dist; this.land(l, B, Math.min(late, dt)); l.step = Math.max(l.step, legState(spec, i, dl - 1e-9 * c).step); swinging--; }
      }
      if (l.mode === 'stance') { l.pos.copy(l.plant); l.h = 0; l.gy = l.plant.y; }
    };
    // 4. (first) the feet already in the air move on and land: a foot that touches down this frame frees its place
    //    before any new step is counted against the feet-up budget
    const wasUp = this.legs.map((l) => l.mode === 'swing');
    for (let i = 0; i < this.legs.length; i++) if (wasUp[i]) progress(i);
    // 0. getting ready: while it stands up for a walk (travel rising from parked, not moving yet, the mover's poses
    //    known), the planted feet the coming walk would drag past their envelope step now, one after another, to where
    //    the gait wants them for their stance: the walk then starts with every foot where its own gait puts it. Which
    //    feet is decided once (pure: the mover's poses); the steps run on the stand-up's own clock, from the instant the
    //    travel ramp crossed in (interpolated within its step), so every page shows the same step at the same moment.
    if (this.readying && this.readyAt < 0) {
      const q = this.wasTravel < 0.02 && r.travel > this.wasTravel ? (0.02 - this.wasTravel) / (r.travel - this.wasTravel) : 1;
      this.readyAt = this.time - dt + THREE.MathUtils.clamp(q, 0, 1) * dt;
      this.prep = [];
      for (const l of this.legs) l.prepDone = false;
      if (modelAt) for (let i = 0; i < this.legs.length; i++) {
        const l = this.legs[i];
        const ls = legState(spec, i, r.dist);
        if (l.mode !== 'stance' || !ls.stance || ls.p >= D - 0.06) continue;
        if (lagAt(l, i, ls) !== null) this.prep.push(i);
      }
    }
    if (this.readying && !moving && modelAt) {
      this.prep.forEach((i, k) => {
        const l = this.legs[i];
        const at = this.readyAt + k * swingT;
        if (l.mode !== 'stance' || this.time < at || l.prepDone) return;
        const ls = legState(spec, i, r.dist);
        this.startSwing(l, 0, true, false);
        l.T = swingT; l.mid = ls.tdDist + (D * c) / 2; l.prepAt = at; l.prepDone = true;
        swinging++;
      });
    }
    // 1. the gait's own lift-offs (by distance). A swing window entered late (a re-phased walk: a new job, a pace
    //    change) is caught up by distance from here to its touchdown, never started half-way (no foot jumps)
    for (let i = 0; i < this.legs.length; i++) {
      const l = this.legs[i];
      const ls = legState(spec, i, r.dist);
      if (!(moving && l.mode === 'stance' && !ls.stance && ls.step > l.step)) continue;
      l.resAt = NaN;
      if (ls.u <= 0.3) this.startSwing(l, ls.u, false, false);
      else {
        // (a catch-up is off the gait's own schedule: only when there's room for it, else it waits for the next window
        // and the lag check below looks after the foot)
        const len = Math.max(0.5 * (1 - D) * c, ls.tdDist - r.dist);
        if (!this.roomFor(i, r.dist, len, r.dist, budget)) continue;
        this.offStep(l, i, r.dist, len, r.dist, false, ls.tdDist + (D * c) / 2);
      }
      l.step = ls.step; swinging++;
    }
    // 2. lagging feet: a planted foot that will be further out than the gait's own lift-off excursion before this
    //    stance ends (the first steps out of a parked stance, a turn on the spot, a walk that starts where the last one
    //    was cut short) gets its own step. Predicted, not waited for: with the mover's pose at any distance the excursion
    //    at this stance's lift-off is known now, and the distance it crosses the gait's envelope is found by bisection
    //    (pure). The step is reserved BY DISTANCE against every other leg's steps (feet-up budget: never more than half
    //    the legs in the air): the same steps on every page at any frame rate. No room for it before its own lift-off:
    //    the regular swing fixes it. Each stance is checked once. (Turning on the spot, stride 0: a foot's sweep is its
    //    arc, at most the turn's gait distance: the same envelope.)
    if (moving) {
      let cands: { i: number; a: number }[] | null = null;
      for (let i = 0; i < this.legs.length; i++) {
        const l = this.legs[i];
        if (l.mode !== 'stance' || !Number.isNaN(l.resAt)) continue;
        const ls = legState(spec, i, r.dist);
        if (!ls.stance || ls.p >= D - 0.06 || l.lagSkip === ls.step) continue;
        const a = lagAt(l, i, ls);
        if (a === null) { l.lagSkip = ls.step; continue; }
        (cands ??= []).push({ i, a });
      }
      if (cands) {
        // (by crossing distance; legs that cross together, by symmetry, go in leg order: a bisection's last digits
        // depend on the step it ran in, the order must not)
        cands.sort((x, y) => (Math.abs(x.a - y.a) > 1e-4 * c ? x.a - y.a : x.i - y.i));
        for (const { i, a } of cands) {
          const l = this.legs[i];
          const res = this.reserve(i, a, r.dist, budget);
          if (res) { l.resAt = res.at; l.resLen = res.len; l.resMid = res.mid; }
          else l.lagSkip = legState(spec, i, a).step;
        }
      }
    }
    // 3. reserved steps whose distance has come (they start where they were reserved: at most this step's distance in)
    for (let i = 0; i < this.legs.length; i++) {
      const l = this.legs[i];
      if (Number.isNaN(l.resAt) || r.dist < l.resAt) continue;
      if (l.mode === 'stance') { this.offStep(l, i, l.resAt, l.resLen, r.dist, false, l.resMid); swinging++; }
      l.resAt = NaN;
    }
    // 5. the steps that started this step take their first stretch; planted feet sit on their plants
    for (let i = 0; i < this.legs.length; i++) if (!wasUp[i]) progress(i);
    // parked (really stopped, not a turn handing over to a walk): feet that ended away from their spots step home, one
    // at a time (largest error first)
    if (!swinging && !moving && !this.readying && this.stillT > 0.15 && this.settleWait <= 0) {
      let best: LegRig | null = null, bestE = 0.1 * this.L * sW;
      // (near-equal errors (a symmetric stop) go in leg order: the last digits of a pose must not pick the foot)
      for (const l of this.legs) { const e = l.plant.distanceTo(this.ground(_v.copy(l.neutral).applyMatrix4(G))); if (e > bestE + (best ? 1e-5 * this.L * sW : 0)) { bestE = e; best = l; } }
      if (best) { this.startSwing(best, 0, true, true); swinging++; }
    }
    // the safety net: an over-stretched planted leg (or one a joint limit holds visibly off its plant) steps early toward
    // a plant it can hold until its next lift-off (walking: by distance, like any step; parked: a settle step home),
    // within the feet-up budget; at full stretch regardless of it (a leg is never left pulled out of its socket). A limit
    // that only shaves a millimetre off the solve is not a reason, and a limit alone never breaks the budget (a rig whose
    // ranges are too tight for its gait is the asset's to fix: rigcheck reports it). On a tick, a leg anywhere near that
    // is re-checked against the hull's pose AT the tick (pure), not the last frame's solve.
    for (let i = 0; i < this.legs.length; i++) {
      const l = this.legs[i];
      if (l.mode !== 'stance') continue;
      let reach = l.reach, err = l.err;
      if (ticking) ({ reach, err } = this.predict(l, G));
      if (!(reach > 0.97 || err > 0.01 * this.L)) continue;
      const hard = reach > 0.995;
      if (moving) {
        const len = 0.75 * (1 - D) * c;
        // (room for it over the whole step, the gait's own coming swings included; at full stretch regardless)
        if (!hard && (swinging >= budget || !this.roomFor(i, r.dist, len, r.dist, budget))) continue;
        l.resAt = NaN;
        this.offStep(l, i, r.dist, len, r.dist, true, this.planMid(i, r.dist + len));
      } else {
        if (swinging >= 1 && !hard) continue;
        this.startSwing(l, 0, true, true);
      }
      swinging++;
    }

    // ---- body: stand / park, walk drop, sag + lean toward lifted legs, idle hunt → hydraulic springs
    const b = this.cfg.body, L = this.L;
    this.stand += (smoothstep(r.travel) - this.stand) * (dt > 0 ? 1 - Math.exp(-dt / 0.25) : 1);
    let sum = 0, roll = 0, pitch = 0;
    const rows = this.slots.reduce((m, s) => Math.max(m, s.row), 0) + 1;
    for (const l of this.legs) {
      if (l.mode !== 'swing') continue;
      sum += l.h;
      roll += -l.slot.side * l.h;
      pitch += rows > 1 ? (1 - (2 * l.slot.row) / (rows - 1)) * l.h : 0;
    }
    const n = Math.max(1, this.legs.length);
    const hunt = 0.0012 * L * (Math.sin(this.time * 2.1) + 0.6 * Math.sin(this.time * 5.3 + 1)) * (0.4 + 0.6 * (1 - r.gait));
    const yT = Math.min(0.06 * L, 0.8 * this.bodyEnv.up) * this.stand - b.drop * L * r.gait - 0.02 * L * sum + hunt;
    const rollT = b.roll * D2R * roll * (4 / n), pitchT = b.pitch * D2R * pitch * (4 / n);
    this.sp.y.step(yT, b.omega, b.zeta, dt); this.sp.roll.step(rollT, b.omega, b.zeta, dt); this.sp.pitch.step(pitchT, b.omega, b.zeta, dt);
    const accT = THREE.MathUtils.clamp(this.accel / Math.max(1e-6, this.topSpeed() * 2), -1, 1) * 0.02;
    this.sc.y.step(this.sp.y.x, b.lagOmega, b.lagZeta, dt); this.sc.roll.step(this.sp.roll.x, b.lagOmega, b.lagZeta, dt); this.sc.pitch.step(this.sp.pitch.x - accT, b.lagOmega, b.lagZeta, dt);

    // ---- state events
    if (r.travel > 0.05 && this.wasTravel <= 0.05) { this.emit({ kind: 'spool' }); this.parked = false; }
    if (this.wasMoving && !moving) this.emit({ kind: 'settle' });
    if (!this.parked && r.travel < 0.02 && !swinging && !moving) { this.parked = true; this.emit({ kind: 'park' }); }
    this.wasMoving = moving; this.wasTravel = r.travel;
  }

  /** A world point put on the room's walkable floor under it (SPEC M1; rooms without levels: unchanged). A foot plate
   *  overlapping a step's edge rests on its top (the highest floor within the plate's radius: also where a room's
   *  walk-data floor is a little coarser than the stage you see). */
  private ground(p: THREE.Vector3): THREE.Vector3 {
    if (this.floorAt) {
      const r = 0.1 * this.L * this.lastScale;
      let y = -Infinity;
      for (const [dx, dz] of FOOT_RING) { const v = this.floorAt(p.x + dx * r, p.z + dz * r); if (Number.isFinite(v) && v > y) y = v; }
      if (Number.isFinite(y)) p.y = y;
    }
    return p;
  }

  /** How the hull rides over its feet when they stand at other heights than the mount's floor (SPEC M1): the plane
   *  through their ground heights (least squares over the legs' parking spots, model frame): its height at the hull's
   *  pivot against the mount's floor (model units, up: the mean foot height plus the rest offset) and its slope as a
   *  pitch / roll (a stage edge under the front feet tips the hull nose-down, so each leg only reaches the rest of the
   *  way). The mount's own height steps where the room's floor does (under the body's centre); the hull doesn't: its
   *  feet carry it. All 0 in rooms without levels. */
  private groundPlane(G: THREE.Matrix4): { off: number; pitch: number; roll: number } {
    const g = this.gnd;
    g.off = 0; g.pitch = 0; g.roll = 0;
    if (!this.floorAt || !this.legs.length) return g;
    const e = G.elements, s = Math.hypot(e[0], e[1], e[2]) || 1, n = this.legs.length;
    // h = a + bx·x + bz·z over the parking spots (x, z) with h = the foot's ground height over the mount's floor
    let sx = 0, sz = 0, sh = 0;
    for (const l of this.legs) { sx += l.neutral.x; sz += l.neutral.z; sh += (l.gy - e[13]) / s; }
    const mx = sx / n, mz = sz / n, mh = sh / n;
    let xx = 0, zz = 0, xz = 0, xh = 0, zh = 0;
    for (const l of this.legs) { const x = l.neutral.x - mx, z = l.neutral.z - mz, h = (l.gy - e[13]) / s - mh; xx += x * x; zz += z * z; xz += x * z; xh += x * h; zh += z * h; }
    const det = xx * zz - xz * xz;
    let bx = 0, bz = 0;
    if (n >= 3 && Math.abs(det) > 1e-9 * Math.max(1e-9, xx * zz)) { bx = (xh * zz - zh * xz) / det; bz = (zh * xx - xh * xz) / det; }
    const lim = 15 * D2R;
    g.pitch = THREE.MathUtils.clamp(-Math.atan(bz), -lim, lim);
    g.roll = THREE.MathUtils.clamp(Math.atan(bx), -lim, lim);
    const pv = this.pelvis?.pivot;
    const h = mh + (pv ? bx * (pv.x - mx) + bz * (pv.z - mz) : 0);
    g.off = THREE.MathUtils.clamp(h, -0.5 * this.L, 0.5 * this.L);
    return g;
  }
  private gnd = { off: 0, pitch: 0, roll: 0 };
  /** The ground tilt the hull wears this frame (levelHead counters part of it too). */
  private gTilt = { pitch: 0, roll: 0 };

  /** The hull's (mpelvis) model-space matrix from the spring state (inside the envelope the planted legs can follow:
   *  bodyEnv) on the ground's plane (groundPlane()). */
  private bodyModel(out: THREE.Matrix4, gr: { off: number; pitch: number; roll: number }) {
    const pv = this.pelvis!;
    const e = this.bodyEnv;
    const y = THREE.MathUtils.clamp(this.sp.y.x, -e.down, e.up) + gr.off, pitch = clampA(this.sp.pitch.x, e.pitch) + gr.pitch, roll = clampA(this.sp.roll.x, e.roll) + gr.roll;
    const R = _m.makeRotationFromEuler(_e.set(pitch, 0, roll, 'XYZ'));
    return out.makeTranslation(pv.pivot.x, pv.pivot.y + y, pv.pivot.z).multiply(R).multiply(_m3.makeTranslation(-pv.pivot.x, -pv.pivot.y, -pv.pivot.z)).multiply(pv.restModel);
  }

  /** A planted leg's reach / IK error with the hull where the state puts it under the model matrix G (a tick's own,
   *  pure: no bones are written; its own warm start, so every page runs the same solves). */
  private predict(l: LegRig, G: THREE.Matrix4): { reach: number; err: number } {
    const B = this.pelvis ? _m2.copy(G).multiply(this.bodyModel(new THREE.Matrix4(), this.groundPlane(G))) : _m2.copy(G);
    const q = new THREE.Quaternion();
    B.decompose(_v3, q, _v4);
    const gq = new THREE.Quaternion();
    G.decompose(_v3, gq, _v4);
    const nrm = v3(_v2.copy(Y).applyQuaternion(gq).applyQuaternion(q.invert()).normalize());
    const tgt = v3(_v.copy(l.plant).applyMatrix4(B.invert()));
    const s = solveHingeLeg(l.model, tgt, { level: l.level, normal: nrm, ...(l.pAngles ? { guess: l.pAngles } : {}) });
    l.pAngles = !s.clamped && s.error < 1e-4 * this.L ? s.angles : null;
    return { reach: s.reach, err: Number.isFinite(s.error) ? s.error : this.L };
  }

  /** Every leg to its world target (hinge-constrained IK in the body's frame, the soles level with the ground). */
  private solveLegs(Gq: THREE.Quaternion) {
    let maxReach = 0, clamped = 0;
    const body = this.pelvis?.bone ?? this.model;
    const Pinv = new THREE.Matrix4().copy(body.matrixWorld).invert();
    const bq = new THREE.Quaternion();
    body.matrixWorld.decompose(_v3, bq, _v4);
    const nrm = v3(_v2.copy(Y).applyQuaternion(Gq).applyQuaternion(bq.invert()).normalize());
    for (const l of this.legs) { this.solve(l, Pinv, nrm); maxReach = Math.max(maxReach, l.reach); if (l.clamped) clamped++; }
    return { maxReach, clamped };
  }

  /**
   * The late pass (SceneActor.sync calls it once the room's mover has put the mount where it is THIS frame): the page
   * updates its avatars before the room's movers run, so the legs solved in postHumanoid are for last frame's body pose.
   * World-planted feet would trail the body by one frame of its motion (a centimetre or two of foot swim while it walks
   * or turns). The targets (plants, swing points) are world positions: re-solving them against the body's new place puts
   * every planted sole back exactly on its plant. Legs + pistons only; the body springs, cab, pilot and arms are untouched.
   */
  late() {
    if (!this.init || !this.legs.length) return;
    const body = this.pelvis?.bone ?? this.model;
    // (ticks: the state catches up to the clock the mover just moved the body to, so every page shows the state of its
    // own frame's instant, not the one before: two pages whose frames meet show the same feet)
    let ran = false;
    const c = this.tickMode ? this.inp.clockAt?.() : undefined;
    if (c !== undefined && Number.isFinite(c) && this.inp.at) {
      this.model.updateWorldMatrix(true, false);
      const G = this.model.matrixWorld, mount = this.inp.mount ?? null;
      const toModel = mount ? new THREE.Matrix4().copy(mount.matrixWorld).invert().multiply(G) : null;
      const modelOf = (pa: ((d: number) => THREE.Matrix4 | null) | null | undefined) => (pa && toModel ? (d: number) => { const M = pa(d * this.sMA); return M ? M.clone().multiply(toModel) : null; } : null);
      ran = this.runTicks(c, G, modelOf(this.inp.poseAt), modelOf);
    }
    if (this.floorAt || ran) { this.model.updateWorldMatrix(true, false); this.poseBody(this.model.matrixWorld); }
    body.updateWorldMatrix(true, false);
    const Gq = this.model.getWorldQuaternion(_q3);
    const { maxReach, clamped } = this.solveLegs(Gq.clone());
    this.last.maxReach = maxReach; this.last.clamped = clamped;
    this.posePistons();
  }

  /** Every machine bone back to its rest pose. */
  private restBody() {
    for (const bb of [this.pelvis, this.cockpit]) if (bb) { bb.bone.position.copy(bb.restPos); bb.bone.quaternion.copy(bb.restQ); bb.bone.scale.copy(bb.restS); }
    for (const l of this.legs) for (const j of l.joints) j.bone.quaternion.copy(j.restQ);
    for (const s of Object.values(this.sticks)) if (s) s.restLocal.decompose(s.bone.position, s.bone.quaternion, s.bone.scale);
    for (const p of this.pistons) { p.a.quaternion.copy(p.restA); p.b.quaternion.copy(p.restB); }
  }

  /** Plants from scratch: parked = on the parking spots; mid-walk (a late-joining page) = where the gait says. */
  private resetLegs(moving: boolean, G: THREE.Matrix4, modelAt: ((d: number) => THREE.Matrix4 | null) | null) {
    const r = this.res, spec = this.spec, D = spec.duty, c = spec.stride;
    this.kappa = 0;
    for (let i = 0; i < this.legs.length; i++) {
      const l = this.legs[i];
      const ls = legState(spec, i, r.dist);
      l.step = ls.step; l.timed = false; l.home = false; l.reach = 0; l.clamped = false; l.err = 0; l.angles = null; l.pAngles = null; l.d0 = 0; l.dLen = 0; l.mid = NaN;
      l.resAt = NaN; l.lagSkip = -Infinity;
      if (moving) {
        if (ls.stance) { l.mode = 'stance'; l.plant.copy(this.landing(l, i, ls.tdDist + (D * c) / 2, 1, (D * c) / 2 - ls.p * c, r, G, modelAt)); }
        else { l.mode = 'swing'; l.u = ls.u; l.from.copy(this.landing(l, i, ls.tdDist - c + (D * c) / 2, 1, -(D * c) / 2, r, G, modelAt)); }
      } else {
        // parked on the spots; a foot whose phase is a swing window takes that step as soon as the walk starts
        l.mode = 'stance'; this.ground(l.plant.copy(l.neutral).applyMatrix4(G));
        if (!ls.stance) l.step = ls.step - 1;
      }
      l.pos.copy(l.mode === 'stance' ? l.plant : l.from);
      l.gy = l.pos.y; l.g0 = l.gy;
    }
    const yT = Math.min(0.06 * this.L, 0.8 * this.bodyEnv.up) * smoothstep(r.travel);
    this.stand = smoothstep(r.travel);
    this.sp.y.reset(yT); this.sp.roll.reset(); this.sp.pitch.reset();
    this.sc.y.reset(yT); this.sc.roll.reset(); this.sc.pitch.reset();
    this.speed = 0; this.accel = 0; this.yawRate = 0;
    this.wasTravel = r.travel; this.wasMoving = moving; this.parked = !moving && r.travel < 0.02;
  }

  /** The phases restart: the job's distance jumped (`job`: a new walk, an interrupted one, a re-timed move) or the gait
   *  family changed. Reservations are dropped; a planted foot whose new phase is a swing window takes that swing now (a
   *  catch-up by distance: step 1 in postHumanoid); on a new job a foot in the air finishes its step by time from where it
   *  is now to the new walk's plan, so nothing in the air or on the ground jumps. */
  private rephase(dist: number, job: boolean) {
    const spec = this.spec, D = spec.duty;
    const swingT = Math.max(0.3, spec.period * (1 - D) * 1.25);
    for (let i = 0; i < this.legs.length; i++) {
      const l = this.legs[i];
      const f = footPhase(dist, spec, i);
      l.resAt = NaN; l.lagSkip = -Infinity;
      l.step = l.mode === 'stance' && !f.stance ? f.step - 1 : f.step;
      if (!job || l.mode !== 'swing' || l.home) continue;
      const T = THREE.MathUtils.clamp((1 - Math.min(1, l.u)) * swingT, 0.15, swingT);
      l.from.copy(l.pos); l.g0 = l.gy; l.u = 0; l.timed = true; l.T = T; l.d0 = 0; l.dLen = 0;
      l.mid = this.planMid(i, dist);
    }
  }

  /** An off-schedule step (a lagging foot, a late swing window, an over-stretched foot) that progresses BY DISTANCE from
   *  `d0` over `dLen` (model units), landing for job distance `mid` (default planMid): deterministic across pages and
   *  frame rates. `now` = this frame's distance; it never starts more than half-way (a foot always swings). */
  private offStep(l: LegRig, i: number, d0: number, dLen: number, now: number, timed: boolean, mid?: number) {
    this.startSwing(l, 0, timed, false);
    l.d0 = Math.min(d0, now); l.dLen = Math.max(1e-6, dLen);
    l.u = THREE.MathUtils.clamp((now - l.d0) / l.dLen, 0, 0.5);
    l.T = Math.max(0.25, this.spec.period * (1 - this.spec.duty) * 0.9);
    l.mid = mid !== undefined && Number.isFinite(mid) ? mid : this.planMid(i, l.d0 + l.dLen);
  }

  /** The pose distance an off-schedule foot landing at job distance `dLand` plants for: halfway between the landing and
   *  the lift-off that ends the stance it lands in (this cycle's; the next one's when it lands in its swing phase), so it
   *  is never dragged more than half a stride from its spot. (A regular step lands at tdDist: that gives its own
   *  tdDist + duty * stride / 2.) */
  private planMid(i: number, dLand: number) {
    const ls = legState(this.spec, i, dLand);
    return (dLand + ls.tdDist + this.spec.duty * this.spec.stride) / 2;
  }

  /** Feet allowed in the air at once when an off-schedule step joins the gait's own: half the legs (at least 1). */
  private upBudget() { return Math.max(1, Math.floor(this.legs.length / 2)); }

  /** Is leg `j` (planned to be) in the air at job distance `x`: its gait's swing window, an off-schedule step by distance,
   *  a reserved one; a step by time (re-based, settle) counts until about a swing from `now`. Pure in distance except
   *  for the by-time steps (which only follow a re-based walk). */
  private upAt(j: number, x: number, now: number) {
    const l = this.legs[j], spec = this.spec;
    if (!footPhase(x, spec, j).stance) return true;
    if (!Number.isNaN(l.resAt) && x >= l.resAt && x < l.resAt + l.resLen) return true;
    if (l.mode !== 'swing') return false;
    if (l.dLen > 0) return x >= l.d0 && x < l.d0 + l.dLen;
    return l.timed || l.home ? x < now + (1 - Math.min(1, l.u)) * (1 - spec.duty) * spec.stride : false;
  }

  /** Is there room for leg `i` in the air over job distances [s, s + len): fewer than `budget` OTHER legs (planned to be)
   *  up anywhere in it? `pts` = the distances where that count can change (sorted; default: worked out here). */
  private roomFor(i: number, s: number, len: number, now: number, budget: number, pts?: number[]) {
    const spec = this.spec, D = spec.duty, c = spec.stride, n = this.legs.length;
    if (!pts) {
      pts = [];
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const o = spec.offsets[j] ?? 0;
        for (const at of [0, D]) {
          const k0 = Math.ceil(s / c + o - at), k1 = Math.floor((s + len) / c + o - at);
          for (let k = k0; k <= k1 && k - k0 < 16; k++) pts.push((k - o + at) * c);
        }
        const l = this.legs[j];
        if (l.mode === 'swing' && l.dLen > 0) pts.push(l.d0, l.d0 + l.dLen);
        if (l.mode === 'swing' && l.dLen <= 0 && (l.timed || l.home)) pts.push(now + (1 - Math.min(1, l.u)) * (1 - D) * c);
        if (!Number.isNaN(l.resAt)) pts.push(l.resAt, l.resAt + l.resLen);
      }
      pts.sort((x, y) => x - y);
    }
    const eps = 1e-7 * c;
    const others = (x: number) => { let k = 0; for (let j = 0; j < n; j++) if (j !== i && this.upAt(j, x, now)) k++; return k; };
    if (others(s + eps) >= budget) return false;
    for (const p of pts) { if (p <= s) continue; if (p >= s + len) break; if (others(p + eps) >= budget) return false; }
    return true;
  }

  /**
   * Reserve an off-schedule step for lagging leg `i` (in stance) from job distance `a` on: the earliest start s >= a at
   * which, over the whole step, fewer than `budget` OTHER legs are (planned to be) in the air; it must start before this
   * stance's own lift-off (else null: the regular swing fixes the foot). A step that would leave the foot only a moment
   * on the ground before that lift-off becomes one longer step straight to the gait's next plant (no step-pause-step).
   * Pure: the same reservation on every page and at every frame rate.
   */
  private reserve(i: number, a: number, now: number, budget: number): { at: number; len: number; mid: number } | null {
    const spec = this.spec, D = spec.duty, c = spec.stride, n = this.legs.length;
    const lsA = legState(spec, i, a);
    const lo = lsA.tdDist + D * c;                       // this stance's lift-off
    const short = (1 - D) * c;
    if (!(a < lo - 0.25 * short)) return null;
    const horizon = lo + 2 * c;
    // breakpoints: every other leg's swing-window edges + its off-schedule / reserved steps' ends, in [a, horizon]
    const pts: number[] = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const o = spec.offsets[j] ?? 0;
      for (const at of [0, D]) {
        const k0 = Math.ceil(a / c + o - at), k1 = Math.floor(horizon / c + o - at);
        for (let k = k0; k <= k1 && k - k0 < 16; k++) pts.push((k - o + at) * c);
      }
      const l = this.legs[j];
      if (l.mode === 'swing' && l.dLen > 0) pts.push(l.d0, l.d0 + l.dLen);
      if (l.mode === 'swing' && l.dLen <= 0 && (l.timed || l.home)) pts.push(now + (1 - Math.min(1, l.u)) * (1 - D) * c);
      if (!Number.isNaN(l.resAt)) pts.push(l.resAt, l.resAt + l.resLen);
    }
    pts.sort((x, y) => x - y);
    const free = (s: number, len: number) => this.roomFor(i, s, len, now, budget, pts);
    let s: number | null = free(a, short) ? a : null;
    if (s === null) for (const p of pts) { if (p <= a) continue; if (p >= lo - 0.25 * short) break; if (free(p, short)) { s = p; break; } }
    if (s === null) return null;
    // a short hold before the lift-off: one longer step to the next plant instead (when there is room for it)
    const ntd = lo + short;
    if (lo - (s + short) < 0.5 * short && free(s, ntd - s)) return { at: s, len: ntd - s, mid: ntd + (D * c) / 2 };
    return { at: s, len: short, mid: this.planMid(i, s + short) };
  }

  private startSwing(l: LegRig, u: number, timed: boolean, home: boolean) {
    l.mode = 'swing'; l.u = u; l.timed = timed; l.home = home; l.from.copy(l.plant); l.g0 = l.plant.y; l.T = 0; l.d0 = 0; l.dLen = 0; l.mid = NaN; l.prepAt = -1;
  }

  private land(l: LegRig, B: THREE.Vector3, late = 0) {
    const settle = l.home;
    l.mode = 'stance'; l.plant.copy(B); l.pos.copy(B); l.gy = B.y; l.u = 0; l.timed = false; l.home = false; l.h = 0; l.d0 = 0; l.dLen = 0; l.mid = NaN; l.prepAt = -1;
    if (settle) this.settleWait = 0.12;
    // the thump: a downward kick on the body (a settle step is lighter), placed at the instant the foot really landed
    const dv = -this.cfg.body.impact * this.L * (settle ? 0.5 : Math.max(0.35, this.res.gait));
    this.sp.y.kick(dv);
    this.sp.y.x += dv * late;
    this.emit({ kind: 'plant', leg: l.key, pos: [B.x, B.y, B.z], settle });
  }

  private emit(e: Omit<MechEvent, 't' | 'seq'>) {
    const ev: MechEvent = { ...e, t: this.time, seq: ++this.seq };
    this.events.push(ev);
    if (this.events.length > 32) this.events.splice(0, this.events.length - 32);
    try { this.onEvent?.(ev); } catch (err) { console.warn('mech event', err); }
  }

  /**
   * Where a foot plants (world): its parking spot at the model's pose `mid` job-distance along (the mover's own pose there
   * when it gives one: exact for any path). Without one: the current pose moved `along` (model units) along an arc of
   * the current curvature (exact for straight lines, circles and turns on the spot). `ahead` 0 = the spot right here.
   */
  private landing(l: LegRig, i: number, mid: number, ahead: number, along: number, r: MechInputs, G: THREE.Matrix4, modelAt: ((d: number) => THREE.Matrix4 | null) | null): THREE.Vector3 {
    void i;
    if (modelAt) { const M = modelAt(mid); if (M) return this.ground(l.neutral.clone().applyMatrix4(M)); }
    const p = _v4.copy(l.neutral);
    if (ahead > 0) {
      const a = along * ahead;
      const th = THREE.MathUtils.clamp(this.kappa * a, -0.6, 0.6);
      const k = Math.abs(this.kappa) > 1e-6 ? th / a : 0;
      const sgn = r.back ? -1 : 1;
      const dx = k ? (1 - Math.cos(th)) / k : 0, dz = k ? Math.sin(th) / k : a;
      p.sub(this.pivot).applyAxisAngle(Y, th).add(this.pivot);
      p.x += dx * r.stride * sgn; p.z += dz * r.stride * sgn;
    }
    return this.ground(p.clone().applyMatrix4(G));
  }

  /** The body (mpelvis) and the cab (mcockpit) from the spring states; the cab's lag clamped to lagMax / 1.5°. The hull
   *  stands over its feet (groundPlane()) under the model's world matrix G. */
  private poseBody(G: THREE.Matrix4) {
    const pv = this.pelvis;
    if (pv) {
      const gr = this.groundPlane(G);
      this.gTilt.pitch = gr.pitch; this.gTilt.roll = gr.roll;
      const M = this.bodyModel(_m2, gr);
      _m.copy(pv.parentRestModelInv).multiply(M).decompose(pv.bone.position, pv.bone.quaternion, pv.bone.scale);
    }
    const ck = this.cockpit;
    if (ck) {
      const lm = this.cfg.body.lagMax, la = 1.5 * D2R;
      const dp = clampA(this.sc.pitch.x - (pv ? this.sp.pitch.x : 0), la), dr = clampA(this.sc.roll.x - (pv ? this.sp.roll.x : 0), la);
      const dy = clampA(this.sc.y.x - (pv ? this.sp.y.x : 0), lm);
      const R = _m.makeRotationFromEuler(_e.set(dp, 0, dr, 'XYZ'));
      const M = _m2.makeTranslation(ck.pivot.x, ck.pivot.y + dy, ck.pivot.z).multiply(R).multiply(_m3.makeTranslation(-ck.pivot.x, -ck.pivot.y, -ck.pivot.z)).multiply(ck.restModel);
      _m.copy(ck.parentRestModelInv).multiply(M).decompose(ck.bone.position, ck.bone.quaternion, ck.bone.scale);
    }
    (pv?.bone ?? ck?.bone)?.updateMatrixWorld(true);
  }

  /** One leg: foot target (world) → hinge angles (gait.ts solveHingeLeg in the body's frame) → bone rotations. */
  /** `Pinv` = the body's inverse world matrix, `nrm` = the ground's up in the body frame (the sole stays level with the
   *  ground, not with the rolling hull). */
  private solve(l: LegRig, Pinv: THREE.Matrix4, nrm: V3) {
    const tgt = v3(_v.copy(l.pos).applyMatrix4(Pinv));
    // (warm start from last frame's answer when it was a clean solve: one or two Newton steps)
    const s = solveHingeLeg(l.model, tgt, { level: l.level, normal: nrm, ...(l.angles ? { guess: l.angles } : {}) });
    l.reach = s.reach; l.clamped = s.clamped; l.err = Number.isFinite(s.error) ? s.error : this.L;
    l.angles = !s.clamped && s.error < 1e-4 * this.L ? s.angles : null;
    l.joints.forEach((j, k) => { j.bone.quaternion.copy(j.restQ).multiply(_q.setFromAxisAngle(j.local, s.angles[k] ?? 0)); });
    l.joints[0].bone.updateMatrixWorld(true);
  }

  private poseSticks() {
    for (const side of ['left', 'right'] as Side[]) {
      const st = this.sticks[side];
      if (!st) continue;
      const R = _m.makeRotationFromQuaternion(this.stickRot(side, _q));
      const M = _m2.makeTranslation(st.pivot.x, st.pivot.y, st.pivot.z).multiply(R).multiply(_m3.makeTranslation(-st.pivot.x, -st.pivot.y, -st.pivot.z)).multiply(st.restModel);
      _m.copy(st.parentRestModelInv).multiply(M).decompose(st.bone.position, st.bone.quaternion, st.bone.scale);
      st.bone.updateMatrixWorld(true);
    }
  }

  /** Each cylinder aims at its rod and the rod back at it (their legs' matrices are fresh from solve()). */
  private posePistons() {
    const aw = _v, bw = _v2, qa = _q2;
    for (const p of this.pistons) {
      aw.setFromMatrixPosition(p.a.matrixWorld); bw.setFromMatrixPosition(p.b.matrixWorld);
      const d = _v3.copy(bw).sub(aw);
      if (d.lengthSq() < 1e-12) continue;
      p.a.matrixWorld.decompose(_v4, qa, _v4);
      rotWorldFast(p.a, _q.setFromUnitVectors(_v4.copy(p.dirA).applyQuaternion(qa).normalize(), d.normalize()));
      aw.setFromMatrixPosition(p.a.matrixWorld);
      d.copy(aw).sub(bw).normalize();
      p.b.matrixWorld.decompose(_v4, qa, _v4);
      rotWorldFast(p.b, _q.setFromUnitVectors(_v4.copy(p.dirB).applyQuaternion(qa).normalize(), d));
    }
  }

  /** Debug / QA numbers (vtpOut.runtime.mech.info()). */
  info() {
    return {
      legs: this.legs.map((l) => ({ key: l.key, mode: l.mode, u: +l.u.toFixed(3), reach: +l.reach.toFixed(3), clamped: l.clamped, err: +l.err.toFixed(4), timed: l.timed, home: l.home, joints: l.joints.map((j) => j.type).join('+') })),
      duty: this.spec.duty, stride: this.spec.stride, period: this.spec.period, L: this.L, footprint: this.footprint, turnPer: this.turnPer, strideFit: this.strideFit, bodyEnv: this.bodyEnv,
      arms: this.arms.map((a) => ({ side: a.side, stick: !!a.pivot, fingers: a.fingers })), sticks: Object.keys(this.sticks), pistons: this.pistons.length,
      exhaust: this.exhaust.length, lamps: this.lamps.length, pelvis: !!this.pelvis, cockpit: !!this.cockpit, inputs: { dist: this.res.dist, gait: this.res.gait, stride: this.res.stride, back: this.res.back, travel: this.res.travel },
      ...this.last, events: this.events.length,
    };
  }

  /** Forget the plants (the next frame re-derives them). */
  reset() { this.init = false; }
  dispose() { this.fx?.dispose(); this.fx = null; }
}

const FINGER_BONES: Record<Side, VRMHumanBoneName[]> = { left: [], right: [] };
for (const s of ['left', 'right'] as Side[]) for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
  const segs = f === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
  for (const g of segs) FINGER_BONES[s].push(`${s}${f}${g}` as VRMHumanBoneName);
}

const _pq = new THREE.Quaternion(), _ps = new THREE.Vector3(), _pp = new THREE.Vector3();
/** rotWorld for a bone whose parent's matrixWorld is already current (no walk up the hierarchy). */
function rotWorldFast(b: THREE.Object3D, rot: THREE.Quaternion) {
  if (!b.parent) return;
  b.parent.matrixWorld.decompose(_pp, _pq, _ps);
  const bw = _pq.clone().multiply(b.quaternion);
  b.quaternion.copy(_pq.invert().multiply(rot.clone().multiply(bw)));
  b.updateMatrixWorld(true);
}

/** Rotate a bone by a WORLD-space rotation (keeps its parent), then refresh its subtree. */
function rotWorld(b: THREE.Object3D, rot: THREE.Quaternion) {
  if (!b.parent) return;
  const pw = b.parent.getWorldQuaternion(new THREE.Quaternion());
  const bw = pw.clone().multiply(b.quaternion);
  b.quaternion.copy(pw.invert().multiply(rot.clone().multiply(bw)));
  b.updateMatrixWorld(true);
}

/** Rotation of a normalized node relative to `stop` (exclusive; the normalized rest rotations are identity). */
function worldQ(n: THREE.Object3D | null, stop: THREE.Object3D | null, out: THREE.Quaternion) {
  out.identity();
  for (let o = n; o && o !== stop; o = o.parent) out.premultiply(o.quaternion);
  return out;
}
