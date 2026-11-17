// Space-room entrances / exits (AvatarMover), selected per room: scene.json "entrance": "cryo" / "exit": "droppod"
// (or a room with CRYO_POD_xx / DROP_POD_xx anchors). Everything else — spot changes, the door walk when the Scene tab
// switches cryo / drop pods off, other rooms — is the regular WalkMover (src/scene/walkMover.ts), which this wraps.
//
//   JOIN   frozen in a CRYO_POD (frosted glass, icy blue light, frost sparkles) → the pod thaws (lights warm up, frost
//          melts, a steam burst, the door opens) → the performer stumbles out shivering, hugging themselves → a big
//          stretch (legless rigs hop) → walks JOIN_PATH_* to the bridge and on to their spot (RoomNav lanes) → sits /
//          settles.
//   LEAVE  stands up → walks LEAVE_PATH_* to a DROP_POD (the hatch opens as they arrive) → steps in, turns round →
//          the hatch closes → countdown lamps 3-2-1 → the pod fires down its LAUNCH_TUBE; the space scene then shows it
//          from the bridge viewport as a fiery re-entry streak ending in an impact flash on the planet (spaceLaunches()).
//
// DETERMINISTIC like WalkMover: each job is a pure function of (room data, avatar size, spot, event time), sampled at
// wall-clock time on every page (studio preview, OBS, party guests' OBS). Pod choice = spot index mod pod count.
// Camera (state.follow): cut to CAM_CRYO while they thaw, a chase camera down the corridor, CAM_WIDE's operator on the
// bridge; for exits CAM_DROPBAY at the pod, then the viewport camera for the re-entry streak (never in React mode).
//
// CRYO PODS V2 (scene.json `exit` "cryo" for a role and / or `cryo.hold`, shared/arrivals.ts parseCryoConfig):
//   HOLD   members who are in the party but not in the room stand FROZEN in their pod (a still pose, a very slow breath,
//          blue-white frost tint + an ice rim: cryoKit.ts AvatarFrost), seen through the pod's small view window
//          (CRYO_POD_xx_window: an animated frost shader, a frosted rim with the face readable in the middle). Guests
//          waiting to join (the host's join lead) wait there too; the thaw then melts the window, vents steam, opens
//          the door and they walk out as before.
//   CRYO EXIT  stand up → walk back to their pod (the door opens as they get there) → step in, turn to face out → the
//          door closes → the window frosts over, the lights go from amber to icy blue, a cold hiss seals it → they stay
//          frozen behind the window (hold 'frozen') or the window frosts over completely (hold 'sealed').
//   Pods per member: allocatePods() over the host's SceneState.spots (the same on every page; a member keeps their pod).
//   The host keeps their own entrance (e.g. the lift) unless they are frozen in a pod: then they thaw out of it.
import * as THREE from 'three';
import type { VRMHumanBoneName } from '@pixiv/three-vrm';
import type { AvatarRuntime } from '../../avatar/AvatarRuntime.ts';
import type { SceneActor } from '../actor.ts';
import type { RoomInfo, SpotInfo } from '../contract.ts';
import { lookPose, type CamPose } from '../cameraRig.ts';
import { Locomotion } from '../locomotion.ts';
import { setMoverFactory, type AvatarMover, type MoveEvent, type MoverTrack } from '../mover.ts';
import { RoomNav, WalkPath } from '../navigation.ts';
import { WalkMover } from '../walkMover.ts';
import type { SceneInfo, SceneState } from '../../../shared/types.ts';
import { DEFAULT_SPACE_STATE, type SceneSpaceState } from '../../../shared/space.ts';
import { allocatePods, parseCryoConfig, styleFor, usesStyle, type CryoConfig } from '../../../shared/arrivals.ts';
import { hash32, Rng } from '../raid/rng.ts';
import type { PodLaunch } from './director.ts';
import { SPRITE, SpaceFx } from './fx.ts';
import { spaceRoomOf, toAuthored, type CryoPod, type DropPod, type SpaceRoom } from './spaceRoom.ts';
import { AvatarFrost, FrostWindow, PodGlow } from './cryoKit.ts';

const SIT_TIME = 0.8, ACCEL = 0.45, DECEL = 0.55, TURN_RATE = 3.4, TURN_STEP = 0.3, ARM_BLEND = 0.4;
// cryo timeline (s from the join event)
const T_FROZEN = 1.6, T_THAW = 4.2, T_DOOR0 = 3.3, T_DOOR1 = 4.0, T_STUMBLE = 1.9, T_STRETCH = 1.5;
// drop-pod timeline (s after reaching the pod's board point)
const B_STEP = 1.3, B_TURN = 0.8, B_HATCH0 = 2.3, B_HATCH1 = 3.1, B_LAUNCH = 5.6, B_TUBE = 1.3, POD_RELOAD = 9;
// cryo exit (s after reaching the pod's step-in point): step in, turn round, the door closes, the window frosts, sealed
const C_STEP = 1.25, C_TURN = 0.9, C_DOOR = 1.0, C_FROST = 2.6, C_SEAL = 0.9;
/** Window frost while someone is held frozen (the face reads through the middle). */
const HOLD_FROST = 0.42;

const smooth = (v: number) => { const k = v < 0 ? 0 : v > 1 ? 1 : v; return k * k * (3 - 2 * k); };
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const bell = (t: number, a: number, b: number, c: number, d: number) => smooth((t - a) / (b - a)) * (1 - smooth((t - c) / (d - c)));

type Seg =
  | { k: 'hold'; dur: number; pos: THREE.Vector3; yaw: number; sit: number; seat: SpotInfo | null }
  | { k: 'turn'; dur: number; pos: THREE.Vector3; y0: number; y1: number }
  | { k: 'walk'; dur: number; path: WalkPath; v: number; ta: number; td: number; gait: number }
  | { k: 'step'; dur: number; from: THREE.Vector3; to: THREE.Vector3; y0: number; y1: number; lift: number }
  | { k: 'sit'; dur: number; from: THREE.Vector3; to: THREE.Vector3; yaw: number; s0: number; s1: number; seat: SpotInfo };

interface Sample { pos: THREE.Vector3; yaw: number; sit: number; seat: SpotInfo | null; dist: number; gait: number; stride: number; back: boolean; lift: number }

function walkS(sg: Extract<Seg, { k: 'walk' }>, t: number) {
  const { v, ta, td, dur } = sg, L = sg.path.length;
  if (t <= 0) return { s: 0, v: 0 };
  if (t >= dur) return { s: L, v: 0 };
  if (t < ta) return { s: (v * t * t) / (2 * ta), v: (v * t) / ta };
  if (t > dur - td) { const r = dur - t; return { s: L - (v * r * r) / (2 * td), v: (v * r) / td }; }
  return { s: (v * ta) / 2 + v * (t - ta), v };
}

function walkT(sg: Extract<Seg, { k: 'walk' }>, s: number): number {
  const { v, ta, td, dur } = sg, L = sg.path.length;
  if (s <= 0) return 0;
  if (s >= L) return dur;
  const s1 = (v * ta) / 2, s2 = L - (v * td) / 2;
  if (s < s1) return Math.sqrt((2 * ta * s) / v);
  if (s > s2) return dur - Math.sqrt((2 * td * (L - s)) / v);
  return ta + (s - s1) / v;
}

class Job {
  starts: number[] = []; dist0: number[] = []; total = 0;
  /** Named moments (s, relative). */
  m: Record<string, number> = {};
  /** The room's DOOR: open windows (relative s) where the walk passes the doorway. */
  door: { open: number; close: number }[] = [];
  /** Exit variant: the drop pod, or back into a cryo pod. */
  v: 'drop' | 'cryo' = 'drop';
  constructor(readonly actor: SceneActor, readonly kind: 'enter' | 'exit', public start: number, readonly segs: Seg[], readonly target: SpotInfo | null,
    readonly pod: number, readonly seed: number) {
    let t = 0, d = 0;
    for (const s of segs) {
      this.starts.push(t); this.dist0.push(d); t += s.dur;
      d += s.k === 'walk' ? s.path.length : s.k === 'turn' ? Math.abs(wrap(s.y1 - s.y0)) * TURN_STEP : s.k === 'step' ? s.from.distanceTo(s.to) : s.k === 'sit' ? s.from.distanceTo(s.to) : 0;
    }
    this.total = t;
  }
  sample(t: number, o: Sample): Sample {
    const n = this.segs.length;
    let i = 0;
    const tt = Math.max(0, Math.min(t, this.total));
    while (i < n - 1 && tt >= this.starts[i + 1]) i++;
    const sg = this.segs[i], lt = Math.min(sg.dur, tt - this.starts[i]), k = sg.dur > 0 ? lt / sg.dur : 1;
    o.gait = 0; o.stride = 1; o.back = false; o.dist = this.dist0[i]; o.seat = null; o.lift = 0; o.sit = 0;
    switch (sg.k) {
      case 'hold': o.pos.copy(sg.pos); o.yaw = sg.yaw; o.sit = sg.sit; o.seat = sg.seat; break;
      case 'turn': { const d = wrap(sg.y1 - sg.y0); o.pos.copy(sg.pos); o.yaw = sg.y0 + d * smooth(k); o.dist += Math.abs(d) * TURN_STEP * smooth(k); o.gait = 0.6 * Math.sin(Math.PI * k); o.stride = 0; break; }
      case 'walk': { const w = walkS(sg, lt); sg.path.at(w.s, o.pos); o.yaw = sg.path.heading(w.s); o.dist += w.s; o.gait = (sg.v > 0 ? Math.min(1, w.v / sg.v) : 0) * sg.gait; break; }
      case 'step': { const e = smooth(k); o.pos.lerpVectors(sg.from, sg.to, e); o.yaw = sg.y0 + wrap(sg.y1 - sg.y0) * e; o.dist += sg.from.distanceTo(sg.to) * e; o.gait = 0.55 * Math.sin(Math.PI * k); o.lift = sg.lift * Math.sin(Math.PI * Math.min(1, k * 1.4)); break; }
      case 'sit': {
        const down = sg.s1 > sg.s0;
        const mk = down ? smooth(k / 0.7) : smooth((k - 0.3) / 0.7), sk = down ? smooth((k - 0.2) / 0.8) : smooth(k / 0.8);
        o.pos.lerpVectors(sg.from, sg.to, mk); o.yaw = sg.yaw; o.seat = sg.seat; o.sit = sg.s0 + (sg.s1 - sg.s0) * sk;
        o.dist += sg.from.distanceTo(sg.to) * mk; o.gait = 0.4 * Math.sin(Math.PI * clamp01(down ? k / 0.7 : (k - 0.3) / 0.7)) * (1 - o.sit); o.back = down; break;
      }
    }
    return o;
  }
}

// ------------------------------------------------------------------------------------------------ cryo pose layer
interface ArmRig { side: 1 | -1; upperN: THREE.Vector3; lowerN: THREE.Vector3 }
const armRigs = new WeakMap<AvatarRuntime, { toNorm: THREE.Quaternion; fromNorm: THREE.Quaternion; arms: ArmRig[]; legs: boolean } | null>();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _e = new THREE.Euler();
const _a = V(), _b = V(), _c = V();
function worldQ(n: THREE.Object3D | null, stop: THREE.Object3D | null, out: THREE.Quaternion) { out.identity(); for (let o = n; o && o !== stop; o = o.parent) out.premultiply(o.quaternion); return out; }

/** Frozen stiffness, shiver + self-hug, the big stretch — on any humanoid (legless rigs: body offset / tilt). */
export class CryoPose {
  frozen = 0; shiver = 0; hug = 0; stretch = 0; t = 0;
  /** Cryo v2: the whole upper body held still while frozen (no tracked lean), and a slow breath (0..1). */
  still = false; breathe = 0;
  constructor(readonly actor: SceneActor) {}
  private rig(rt: AvatarRuntime) {
    if (armRigs.has(rt)) return armRigs.get(rt)!;
    const rest = this.actor.rest, h = rt.humanoid;
    let r: ReturnType<typeof armRigs.get> = null;
    if (h && rest?.toNorm) {
      const J = rest.joints, toNorm = rest.toNorm.clone();
      const arms: ArmRig[] = [];
      for (const s of ['left', 'right'] as const) {
        const u = J[`${s}UpperArm`], l = J[`${s}LowerArm`], hd = J[`${s}Hand`];
        if (!u || !l || !h.getNormalizedBoneNode(`${s}UpperArm` as VRMHumanBoneName)) continue;
        const du = l.clone().sub(u), dl = hd ? hd.clone().sub(l) : du.clone();
        if (du.lengthSq() < 1e-10 || dl.lengthSq() < 1e-10) continue;
        arms.push({ side: s === 'left' ? 1 : -1, upperN: du.normalize().applyQuaternion(toNorm), lowerN: dl.normalize().applyQuaternion(toNorm) });
      }
      r = { toNorm, fromNorm: toNorm.clone().invert(), arms, legs: !!J.leftUpperLeg && !!J.rightUpperLeg };
    }
    armRigs.set(rt, r);
    return r;
  }
  apply(rt: AvatarRuntime, dt: number) {
    this.t += dt;
    const w = Math.max(this.frozen, this.shiver, this.hug, this.stretch);
    if (w < 1e-3) return;
    const a = this.actor, t = this.t;
    const sh = this.shiver * (1 - this.stretch * 0.8);
    const h = rt.humanoid, rig = this.rig(rt);
    const H = (a.rest?.height ?? 1.6);
    if (!h || !rig) {
      // blobs / creatures: tremble, then a happy double hop for the stretch
      a.tilt.multiply(_q1.setFromEuler(_e.set(0.04 * sh * Math.sin(t * 43) - 0.05 * this.frozen, 0, 0.05 * sh * Math.sin(t * 37), 'YXZ')));
      a.offset.x += 0.01 * H * sh * Math.sin(t * 51) * a.scale;
      a.offset.y += H * a.scale * 0.09 * Math.abs(Math.sin(Math.PI * 2 * this.stretch)) * (this.stretch > 0.02 ? 1 : 0);
      return;
    }
    const N = (b: string) => h.getNormalizedBoneNode(b as VRMHumanBoneName);
    const qn = (q: THREE.Quaternion, out: THREE.Quaternion) => out.copy(rig.toNorm).multiply(q).multiply(rig.fromNorm);
    const pre = (bone: string, q: THREE.Quaternion) => { const n = N(bone); if (n) n.quaternion.premultiply(qn(q, _q3)); };
    // cryo v2: frozen = the tracked torso held still too (not just the head), breathing very slowly
    if (this.still && this.frozen > 0) for (const b of ['hips', 'spine', 'chest', 'upperChest']) { const n = N(b); if (n) n.quaternion.slerp(new THREE.Quaternion(), this.frozen * 0.9); }
    const br = this.still ? this.breathe * this.frozen * Math.sin(t * Math.PI * 2 / 5.2) : 0;
    // head: frozen = still, chin down; shivering = chattering jitter; stretch = head back
    for (const b of ['neck', 'head']) { const n = N(b); if (n) n.quaternion.slerp(new THREE.Quaternion(), Math.max(this.frozen, this.stretch * 0.6)); }
    pre('head', _q1.setFromEuler(_e.set((this.still ? 0.1 : 0.28) * this.frozen - 0.25 * this.stretch + 0.05 * sh * Math.sin(t * 29), 0.04 * sh * Math.sin(t * 23), 0.04 * sh * Math.sin(t * 31), 'YXZ')));
    // torso: hunched + trembling; the stretch arches back
    pre('spine', _q1.setFromEuler(_e.set(0.12 * this.hug + 0.06 * this.frozen - 0.12 * this.stretch + 0.03 * sh * Math.sin(t * 41), 0.03 * sh * Math.sin(t * 47), 0.03 * sh * Math.sin(t * 39), 'YXZ')));
    const top = N('upperChest') ? 'upperChest' : N('chest') ? 'chest' : null;
    if (top) pre(top, _q1.setFromEuler(_e.set(0.08 * this.hug - 0.08 * this.stretch - 0.022 * br, 0.02 * sh * Math.sin(t * 53), 0, 'YXZ')));
    if (br) pre('head', _q1.setFromEuler(_e.set(0.012 * br, 0, 0, 'YXZ')));
    // arms: stiff at the sides (frozen) → hugging (shiver) → up overhead (stretch)
    const normParent = h.normalizedHumanBonesRoot.parent;
    for (const arm of rig.arms) {
      const s = arm.side === 1 ? 'left' : 'right';
      const ua = N(`${s}UpperArm`), la = N(`${s}LowerArm`);
      if (!ua || !la) continue;
      const side = arm.side;
      const jit = 0.06 * sh * Math.sin(t * 45 + side);
      const du = _a.set(0.1 * side, -1, 0.04);
      const dl = _b.set(0.04 * side, -1, 0.12);
      if (this.hug > 0) { du.lerp(_c.set(0.28 * side, -0.55 + jit, 0.78), this.hug); dl.lerp(_c.set(-0.92 * side, 0.18 + jit, 0.28), this.hug); }
      if (this.stretch > 0) { du.lerp(_c.set(0.35 * side, 0.94, 0.02), this.stretch); dl.lerp(_c.set(0.12 * side, 1, -0.05), this.stretch); }
      du.normalize().applyQuaternion(rig.toNorm); dl.normalize().applyQuaternion(rig.toNorm);
      const aw = Math.max(this.frozen * 0.9, this.hug, this.stretch);
      const parentW = worldQ(ua.parent, normParent, _q1);
      const upW = _q2.setFromUnitVectors(_c.copy(arm.upperN).applyQuaternion(parentW), du).multiply(parentW);
      ua.quaternion.slerp(_q3.copy(parentW).invert().multiply(upW), aw);
      const upWb = _q2.copy(parentW).multiply(ua.quaternion);
      const loW = new THREE.Quaternion().setFromUnitVectors(_c.copy(arm.lowerN).applyQuaternion(upWb), dl).multiply(upWb);
      la.quaternion.slerp(_q3.copy(upWb).invert().multiply(loW), aw);
    }
    // the whole body trembles a little (any rig)
    a.offset.x += 0.004 * H * sh * Math.sin(t * 57) * a.scale;
  }
}

// ------------------------------------------------------------------------------------------------ the mover
interface PodView { frost: number; door: number; warm: number }
const FROST_IDLE = 0.35;
/** v2: empty pods' windows (a touch more frost: the interior light strip must not read as an eye). */
const FROST_EMPTY = 0.48;

export class SpaceMover implements AvatarMover {
  readonly inner: WalkMover;
  readonly R: SpaceRoom;
  readonly nav: RoomNav;
  private jobs = new Map<SceneActor, Job>();
  private layers = new Map<SceneActor, { loco: Locomotion; pose: CryoPose; fn: (rt: AvatarRuntime, dt: number) => void }>();
  private seen = new WeakSet<SceneActor>();
  /** Launch times (s, mover clock) per drop pod — the pod animation + the space streak. */
  private launches: { pod: number; at: number; id: string; key: string }[] = [];
  private tmp: Sample = { pos: V(), yaw: 0, sit: 0, seat: null, dist: 0, gait: 0, stride: 1, back: false, lift: 0 };
  /** Set by the space scene: the host's cryo / drop-pod toggles, and the scene mode (no exit cams in React). */
  spaceState: (() => SceneSpaceState) | null = null;
  sceneMode = 'talk';
  manual = false;
  private clock = Date.now() / 1000;
  private fx = new SpaceFx({ sprites: 260, smoke: 120, streaks: 16 }, false);
  private frost: (THREE.Mesh | null)[] = [];
  private rest = new Map<THREE.Object3D, { p: THREE.Vector3; q: THREE.Quaternion; vis: boolean }>();
  private ray = new THREE.Raycaster();
  // ---- cryo pods v2 (scene.json exit "cryo" / cryo.hold)
  readonly cryo: CryoConfig;
  /** This room uses the v2 pods (a cryo exit or a frozen hold); every other room behaves exactly as before. */
  readonly v2: boolean;
  private scene: SceneState | null = null;
  private actorsFn: (() => Iterable<SceneActor>) | null = null;
  /** Pod (index into R.cryoPods) per member key, from the host's state (allocatePods). */
  private alloc = new Map<string, number>();
  private allocKey = '';
  /** Absent members held in their pod right now (frozen, or sealed away): actor → pod. */
  private held = new Map<SceneActor, number>();
  private windows: (FrostWindow | null)[] = [];
  private avFrost: AvatarFrost | null = null;
  private glow: PodGlow | null = null;
  private frostK = new Map<SceneActor, number>();

  constructor(readonly room: RoomInfo, readonly info: SceneInfo | undefined, R: SpaceRoom) {
    this.inner = new WalkMover(room);
    this.R = R;
    this.nav = this.inner.nav;
    this.fx.uniforms.uMinPx.value = 0;
    room.root.add(this.fx.group);
    const cryoExit = usesStyle(R.exitBy, 'cryo');
    this.cryo = parseCryoConfig((info as unknown as { cryo?: unknown } | undefined)?.cryo, cryoExit);
    this.v2 = R.cryoPods.length > 0 && (cryoExit || this.cryo.hold !== 'hidden');
    if (this.v2) {
      this.avFrost = new AvatarFrost(this.cryo);
      try { this.glow = new PodGlow(room.root, R.cryoPods, (i) => this.podLight(i, this.now())); } catch (e) { console.warn('cryo: pod lights unavailable', e); }
    }
    // pods with a small view window (CRYO_POD_xx_window) get the frost shader on it; the others the old full-door pane
    for (const p of R.cryoPods) {
      let w: FrostWindow | null = null;
      if (p.window) { try { w = new FrostWindow(p, p.window, room.root, this.cryo.tint); } catch (e) { console.warn('cryo: window frost failed', e); } }
      this.windows.push(w);
      this.frost.push(w ? null : this.makeFrost(p));
    }
    for (const o of [...R.cryoPods.map((p) => p.door), ...R.dropPods.map((p) => p.hatch), ...R.dropPods.map((p) => p.node)]) if (o) this.rest.set(o, { p: o.position.clone(), q: o.quaternion.clone(), vis: o.visible });
  }

  now() { return this.manual ? this.clock : Date.now() / 1000; }
  private get opts(): SceneSpaceState { try { return this.spaceState?.() ?? DEFAULT_SPACE_STATE; } catch { return DEFAULT_SPACE_STATE; } }
  private get cryoOn() { return this.opts.cryo && this.R.entrance === 'cryo' && this.R.cryoPods.length > 0; }
  private get dropOn() { return this.opts.droppod && this.R.exit === 'droppod' && this.R.dropPods.length > 0; }
  /** Per role (scene.json entrance / exit as { host, guests }, shared/arrivals.ts; a plain string = both roles). */
  private cryoFor(a: SceneActor) { return this.cryoOn && styleFor(this.R.entranceBy, a.key) === 'cryo'; }
  private dropFor(a: SceneActor) { return this.dropOn && styleFor(this.R.exitBy, a.key) === 'droppod'; }
  // ---- v2: pods per member, the cryo exit, the frozen hold
  /** The host's cryo toggle (Scene tab → Space: "Cryo-pod join") also switches the v2 pods. */
  private get podsOn() { return this.v2 && this.opts.cryo; }
  private usesPod(key: string) { return styleFor(this.R.exitBy, key) === 'cryo' || styleFor(this.R.entranceBy, key) === 'cryo'; }
  /** This member's pod (index into R.cryoPods; -1 = none: more members than pods). */
  podOf(a: SceneActor | string): number {
    const key = typeof a === 'string' ? a : a.key;
    if (!this.v2) return -1;
    this.refreshAlloc();
    return this.alloc.get(key) ?? -1;
  }
  private refreshAlloc() {
    // the host's spots (every party member has one); a member the host hasn't placed yet counts with the spot this page
    // gave them (test pages' stand-ins)
    const sp: Record<string, number> = { ...(this.scene?.spots ?? {}) };
    if (this.actorsFn) for (const a of this.actorsFn()) if (sp[a.key] === undefined && a.spot) sp[a.key] = a.spot.index;
    const k = JSON.stringify(sp);
    if (k === this.allocKey) return;
    this.allocKey = k;
    const rank = this.podRank().map((p) => p.index);
    this.alloc = allocatePods(sp, rank, (key) => this.usesPod(key));
  }
  /** v2: how far (m) an occupant floats up / down in the closed pod so their face sits in the view window (a stasis
   *  field: invisible behind the door, it settles back to the floor before the door opens). */
  private faceLift(a: SceneActor, pod: CryoPod): number {
    const w = pod.window;
    if (!this.v2 || !w || !a.rest) return 0;
    let wy = this.winY.get(pod.index);
    if (wy === undefined) { wy = new THREE.Box3().setFromObject(w).getCenter(V()).y; this.winY.set(pod.index, wy); }
    const eyes = this.standIn(pod, a).y + (a.rest.face.center.y + a.rest.face.size * 0.22) * a.scale;
    return THREE.MathUtils.clamp(wy - eyes, -0.35, 0.35);
  }
  private winY = new Map<number, number>();
  /** Where an occupant stands in a pod: the anchor, v2 rooms `cryo.forward` m towards the door (close behind the window). */
  private standIn(pod: CryoPod, a?: SceneActor) {
    if (!this.v2) return pod.p.clone();
    let f = this.cryo.forward;
    const face = a?.rest ? a.rest.face.size * a.scale : 0;
    const win = pod.window ? this.winW(pod) : 0;
    if (win > 0 && face > win * 0.85) f = Math.max(-0.15, f - (face - win * 0.85) * 2.5);
    return f !== 0 ? pod.p.clone().addScaledVector(pod.fwd, f) : pod.p.clone();
  }
  private winWs = new Map<number, number>();
  private winW(pod: CryoPod) {
    let w = this.winWs.get(pod.index);
    if (w === undefined) {
      const s = pod.window ? new THREE.Box3().setFromObject(pod.window).getSize(V()) : V();
      w = Math.abs(s.x * pod.fwd.z) + Math.abs(s.z * pod.fwd.x); this.winWs.set(pod.index, w);
    }
    return w;
  }
  private cryoExitFor(a: SceneActor) { return this.podsOn && styleFor(this.R.exitBy, a.key) === 'cryo' && this.podOf(a) >= 0; }
  /** Absent members that stand in their pod (frozen / sealed) — whatever their exit, as long as a role of theirs uses cryo. */
  private holdFor(a: SceneActor) { return this.podsOn && this.cryo.hold !== 'hidden' && this.usesPod(a.key) && this.podOf(a) >= 0; }
  /** A member coming back from outside who was held frozen in a pod thaws out of it — even when their own entrance is
   *  something else (the host's lift). Asked by a wrapping mover (liftMover.ts) before it takes the entrance. */
  claimsEnter(a: SceneActor, ev?: MoveEvent): boolean {
    if (!this.holdFor(a) || styleFor(this.R.exitBy, a.key) !== 'cryo') return false;
    return (ev?.from ?? -1) < 0 && typeof ev?.at === 'number';
  }
  setScene(s: SceneState, actors?: () => Iterable<SceneActor>) {
    this.scene = s;
    if (actors) this.actorsFn = actors;
  }

  private layer(a: SceneActor) {
    let l = this.layers.get(a);
    if (!l) {
      const loco = new Locomotion(a), pose = new CryoPose(a);
      l = { loco, pose, fn: (rt, dt) => { loco.apply(rt, dt); pose.apply(rt, dt); } };
      this.layers.set(a, l);
    }
    a.extraPose = l.fn;
    return l;
  }
  /** Give an actor back to the regular walk mover (its pose layer, its idea of where they are). */
  private handBack(a: SceneActor) {
    const inner = this.inner as unknown as { seen: WeakSet<SceneActor>; layer: (a: SceneActor) => unknown; drop: (a: SceneActor) => void };
    inner.seen.add(a);
    inner.layer(a);
    const l = this.layers.get(a);
    if (l) { l.pose.frozen = l.pose.shiver = l.pose.hug = l.pose.stretch = 0; }
  }
  private innerDrop(a: SceneActor) { (this.inner as unknown as { drop: (a: SceneActor) => void }).drop(a); }

  // ---------------------------------------------------------------- AvatarMover
  enter(actor: SceneActor, spot: SpotInfo, ev?: MoveEvent) {
    const at = typeof ev?.at === 'number' ? ev.at / 1000 : null;
    const mine = this.jobs.get(actor);
    const seen = this.seen.has(actor);
    this.seen.add(actor);
    const fromOutside = (ev?.from ?? -1) < 0;
    const wasHeld = this.held.has(actor);
    this.held.delete(actor);
    const thaw = this.cryoFor(actor) || this.claimsEnter(actor, ev);
    const inPod = !!mine && mine.kind === 'exit' && mine.v === 'cryo' && this.now() - mine.start > mine.m.doorClose0;
    const hidden = wasHeld || inPod || (mine ? !this.sampleShown(mine, this.now() - mine.start) : !actor.shown && !this.inner.busy(actor));
    if (!thaw || !fromOutside || (!seen && at === null) || !hidden) {
      if (mine) { this.jobs.delete(actor); if (seen || at !== null) this.handBack(actor); }
      else if (seen && at !== null) (this.inner as unknown as { seen: WeakSet<SceneActor> }).seen.add(actor);
      return this.inner.enter(actor, spot, ev);
    }
    this.innerDrop(actor);
    this.jobs.set(actor, this.buildEnter(actor, spot, at ?? this.now()));
    this.apply(actor, this.jobs.get(actor)!, this.now() - this.jobs.get(actor)!.start);
  }

  exit(actor: SceneActor, ev?: MoveEvent) {
    this.seen.add(actor);
    const at = typeof ev?.at === 'number' ? ev.at / 1000 : null;
    const mine = this.jobs.get(actor);
    const cryo = this.cryoExitFor(actor);
    // still sealed in their pod (the thaw hadn't opened the door yet): they simply stay in it
    if (cryo && mine && mine.kind === 'enter' && this.now() - mine.start < T_DOOR0) { this.jobs.delete(actor); return; }
    // no host stamp for this change (the page just loaded, a state snap): they are simply in their pod already
    if (cryo && at === null && !mine) { this.innerDrop(actor); return; }
    if (!cryo && !this.dropFor(actor)) { if (mine) { this.jobs.delete(actor); this.handBack(actor); } return this.inner.exit(actor, ev); }
    // where they are right now
    let pos: THREE.Vector3, yaw: number, sit = 0, seat: SpotInfo | null = null;
    if (mine) {
      const t = this.now() - mine.start;
      if (!this.sampleShown(mine, t)) { this.jobs.delete(actor); actor.shown = false; return; }
      const s = mine.sample(t, this.tmp); pos = s.pos.clone(); yaw = s.yaw; sit = s.sit; seat = s.seat;
    } else {
      if (!actor.shown) { this.innerDrop(actor); return; }
      this.innerDrop(actor);
      const from = ev?.from ?? -1;
      const fs = from >= 0 ? this.room.spots[from] : null;
      if (fs && fs.position.distanceTo(actor.mount.position) < 0.05) { pos = fs.position.clone().setY(0); yaw = fs.yaw; sit = fs.pose === 'sit' ? 1 : 0; seat = fs.pose === 'sit' ? fs : null; }
      else { pos = actor.mount.position.clone().setY(0); yaw = actor.mount.rotation.y; sit = actor.sit; seat = actor.spot; }
    }
    if (cryo) {
      const cj = this.buildCryoExit(actor, pos, yaw, sit, seat, this.podOf(actor), at ?? this.now());
      this.jobs.set(actor, cj);
      this.apply(actor, cj, this.now() - cj.start);
      return;
    }
    const pod = (actor.spot?.index ?? hash32(actor.key) % 7) % this.R.dropPods.length;
    const job = this.buildExit(actor, pos, yaw, sit, seat, pod, at ?? this.now());
    this.jobs.set(actor, job);
    this.apply(actor, job, this.now() - job.start);
  }

  move(actor: SceneActor, spot: SpotInfo, ev?: MoveEvent) {
    const mine = this.jobs.get(actor);
    if (mine) { this.jobs.delete(actor); this.handBack(actor); }
    else if (this.seen.has(actor)) (this.inner as unknown as { seen: WeakSet<SceneActor> }).seen.add(actor);
    this.seen.add(actor);
    this.inner.move(actor, spot, ev);
  }

  busy(actor: SceneActor) { return this.jobs.has(actor) || this.held.has(actor) || this.inner.busy(actor); }

  /** Another mover takes this actor over (src/scene/arrivals/liftMover.ts): forget our walk / cinematic of it. */
  handOff(actor: SceneActor) { this.seen.add(actor); this.jobs.delete(actor); this.inner.handOff(actor); }
  /** …and gives it back, settled wherever that mover left it: the walk pose layer, "seen" (no snap next time). */
  adopt(actor: SceneActor) { this.seen.add(actor); this.jobs.delete(actor); this.handBack(actor); }

  tracks(): MoverTrack[] {
    const now = this.now(), out = this.inner.tracks();
    for (const [actor, j] of this.jobs) out.push({ actor, kind: j.kind, t: now - j.start, through: j.m.through ?? 0, arrive: j.total });
    return out;
  }

  finishAll() { this.inner.finishAll(); this.update(0); }

  dispose() {
    this.inner.dispose();
    for (const a of this.layers.keys()) { a.extraPose = null; a.offset.set(0, 0, 0); a.tilt.identity(); a.loco = 0; }
    this.jobs.clear(); this.layers.clear();
    for (const [o, r] of this.rest) { o.position.copy(r.p); o.quaternion.copy(r.q); o.visible = r.vis; }
    for (const f of this.frost) if (f) { f.removeFromParent(); f.geometry.dispose(); const m = f.material as THREE.MeshBasicMaterial; m.map?.dispose(); m.dispose(); }
    for (const w of this.windows) w?.dispose();
    this.avFrost?.dispose(); this.glow?.dispose();
    this.held.clear();
    this.fx.dispose();
  }

  /** Drop-pod launches for the space scene's re-entry streak (epoch ms when the pod leaves the tube). */
  spaceLaunches(): PodLaunch[] {
    const out: PodLaunch[] = [];
    const R = this.R;
    for (const l of this.launches) {
      const p = R.dropPods[l.pod];
      if (!p) continue;
      const start = toAuthored(R, p.tubeEnd);
      const dir0 = p.exitDir ? p.exitDir.clone() : p.tubeEnd.clone().sub(p.tubeStart).normalize().lerp(R.view.normal, 0.6).normalize();
      out.push({ id: l.id, at: (l.at + B_TUBE) * 1000, start, dir0, target: p.target });
    }
    return out;
  }

  // ---------------------------------------------------------------- timelines
  private speed(actor: SceneActor) {
    const l = this.layer(actor).loco;
    const hRoom = (actor.rest?.height ?? 1.6) * actor.scale;
    return Math.max(0.35, Math.min(1.2 * THREE.MathUtils.clamp(hRoom / 1.5, 0.5, 1.8), l.maxSpeed()));
  }
  private walk(pts: THREE.Vector3[], v: number, gait = 1): Extract<Seg, { k: 'walk' }> | null {
    const clean: THREE.Vector3[] = [];
    for (const p of pts) if (!clean.length || clean[clean.length - 1].distanceTo(p) > 0.08) clean.push(p.clone().setY(0));
    if (clean.length < 2) return null;
    const path = new WalkPath(clean);
    if (path.length < 0.05) return null;
    let vv = v;
    if (path.length < (vv * (ACCEL + DECEL)) / 2) vv = (2 * path.length) / (ACCEL + DECEL);
    return { k: 'walk', dur: path.length / vv + (ACCEL + DECEL) / 2, path, v: vv, ta: ACCEL, td: DECEL, gait };
  }
  private turnTo(segs: Seg[], pos: THREE.Vector3, y0: number, y1: number) { if (Math.abs(wrap(y1 - y0)) > 0.05) segs.push({ k: 'turn', dur: 0.2 + Math.abs(wrap(y1 - y0)) / TURN_RATE, pos: pos.clone(), y0, y1 }); }

  private buildEnter(actor: SceneActor, spot: SpotInfo, at: number): Job {
    const R = this.R;
    // the host thaws in the pod the cryo camera sees best; everyone else by seat
    const ranked = this.podRank();
    const mineP = this.podOf(actor);
    const pod: CryoPod = mineP >= 0 ? R.cryoPods[mineP] : actor.key === '@host' ? ranked[0] : ranked[(1 + spot.index) % ranked.length];
    const v = this.speed(actor) * 1.25;          // (reporting for duty: a brisk walk to the bridge)
    const segs: Seg[] = [];
    const inPod = this.standIn(pod, actor);      // (the pod floor may be raised)
    segs.push({ k: 'hold', dur: T_THAW, pos: inPod, yaw: pod.yaw, sit: 0, seat: null });
    // stumble out (slow, unsteady), then the stretch
    const out = pod.out.clone();
    const st = this.walk([inPod, inPod.clone().lerp(out, 0.5).addScaledVector(V(pod.fwd.z, 0, -pod.fwd.x), 0.08), out], Math.min(v, 0.55), 0.7);
    if (st) { st.dur = Math.max(st.dur, T_STUMBLE); segs.push(st); }
    segs.push({ k: 'hold', dur: T_STRETCH, pos: out, yaw: st ? st.path.heading(st.path.length) : pod.yaw, sit: 0, seat: null });
    // JOIN_PATH from its node nearest the pod, then the room's lanes to the spot
    let pts: THREE.Vector3[] = [out];
    const jp = R.joinPath;
    if (jp.length) {
      let j0 = 0, bd = Infinity;
      jp.forEach((p, i) => { const d = p.distanceTo(out); if (d < bd) { bd = d; j0 = i; } });
      pts.push(...jp.slice(j0));
    }
    const last = pts[pts.length - 1];
    const rest = this.nav.fromPoint(last, false, spot);
    pts = [...pts, ...rest.slice(1)];
    const yawOut = (segs[segs.length - 1] as Extract<Seg, { k: 'hold' }>).yaw;
    const w = this.walk(pts, v);
    const through = segs.reduce((s, x) => s + x.dur, 0);
    let yaw = yawOut, pos = out.clone();
    if (w) { this.turnTo(segs, out, yawOut, w.path.heading(0)); segs.push(w); pos = w.path.at(w.path.length); yaw = w.path.heading(w.path.length); }
    this.turnTo(segs, pos, yaw, spot.yaw);
    if (spot.pose === 'sit') segs.push({ k: 'sit', dur: SIT_TIME, from: pos.clone(), to: spot.position.clone().setY(0), yaw: spot.yaw, s0: 0, s1: 1, seat: spot });
    else segs.push({ k: 'hold', dur: 0.5, pos: spot.position.clone().setY(0), yaw: spot.yaw, sit: 0, seat: null });
    const job = this.doorWindows(new Job(actor, 'enter', at, segs, spot, pod.index, hash32(actor.key, Math.round(at * 10))));
    const wi = w ? segs.indexOf(w) : -1;
    job.m = { through: T_THAW + T_STUMBLE + 0.4, walk0: wi >= 0 ? job.starts[wi] : through, walk1: wi >= 0 ? job.starts[wi] + w!.dur : through, stumbleEnd: T_THAW + (st?.dur ?? 0), joinLen: jp.length ? pts.indexOf(jp[jp.length - 1]) : 0 };
    job.m.stretch0 = job.m.stumbleEnd; job.m.stretch1 = job.m.stumbleEnd + T_STRETCH;
    // where the walk reaches the bridge (the last JOIN_PATH point): chase cam before, the room's operator after
    job.m.bridgeS = w && jp.length ? w.path.closest(jp[jp.length - 1]) : 0;
    return job;
  }

  private buildExit(actor: SceneActor, pos: THREE.Vector3, yaw: number, sit: number, seat: SpotInfo | null, podI: number, at: number): Job {
    const R = this.R;
    const pod: DropPod = R.dropPods[podI];
    const v = this.speed(actor) * 1.25;
    const segs: Seg[] = [];
    let p = pos.clone();
    if (sit > 0.01 && seat) {
      const T = this.nav.standPoint(seat);
      const to = p.clone().lerp(T, sit);
      segs.push({ k: 'sit', dur: SIT_TIME * sit, from: p, to, yaw, s0: sit, s1: 0, seat });
      p = to;
    }
    // to the start of LEAVE_PATH over the room's lanes, then LEAVE_PATH to the node nearest the pod, then the board point
    let pts: THREE.Vector3[] = [p];
    const lp = R.leavePath;
    if (lp.length) {
      const back = this.nav.fromPoint(lp[0], false, seat ?? actor.spot).reverse();
      // (a route from the path start to their spot, walked backwards: start at their feet)
      const route = back.length > 1 ? [p, ...back.slice(1)] : [p, lp[0]];
      pts = route;
      let j1 = lp.length - 1, bd = Infinity;
      lp.forEach((q, i) => { const d = q.distanceTo(pod.board); if (d < bd) { bd = d; j1 = i; } });
      pts.push(...lp.slice(0, j1 + 1));
    }
    pts.push(pod.board.clone());
    const w = this.walk(pts, v);
    if (w) { this.turnTo(segs, p, yaw, w.path.heading(0)); segs.push(w); yaw = w.path.heading(w.path.length); p = w.path.at(w.path.length); }
    const faceIn = Math.atan2(-pod.fwd.x, -pod.fwd.z);
    this.turnTo(segs, p, yaw, faceIn);
    const inside = pod.p.clone();
    const t0 = segs.reduce((s, x) => s + x.dur, 0);
    segs.push({ k: 'step', dur: B_STEP, from: p.clone(), to: inside, y0: faceIn, y1: faceIn, lift: 0.12 });
    segs.push({ k: 'turn', dur: B_TURN, pos: inside, y0: faceIn, y1: pod.yaw });
    segs.push({ k: 'hold', dur: B_LAUNCH + B_TUBE - B_STEP - B_TURN, pos: inside, yaw: pod.yaw, sit: 0, seat: null });
    const job = this.doorWindows(new Job(actor, 'exit', at, segs, null, pod.index, hash32(actor.key, Math.round(at * 10), 'exit')));
    const wi = w ? segs.indexOf(w) : -1;
    job.m = { walk0: wi >= 0 ? job.starts[wi] : 0, leaveS: w && lp.length ? w.path.closest(lp[0]) : 0, board: t0, hatch0: Math.max(0, t0 - 1.1), hatchOpen: t0 - 0.3, hatchClose0: t0 + B_HATCH0, hatchClose1: t0 + B_HATCH1, launch: t0 + B_LAUNCH, through: t0 };
    return job;
  }

  /** Back into a cryo pod: stand up → the room's lanes + JOIN_PATH (walked backwards) to the pod → step in, turn round →
   *  the door closes → the window frosts over, the pod seals. */
  private buildCryoExit(actor: SceneActor, pos: THREE.Vector3, yaw: number, sit: number, seat: SpotInfo | null, podI: number, at: number): Job {
    const R = this.R;
    const pod: CryoPod = R.cryoPods[podI];
    const v = this.speed(actor) * 1.1;
    const segs: Seg[] = [];
    let p = pos.clone();
    if (sit > 0.01 && seat) {
      const T = this.nav.standPoint(seat);
      const to = p.clone().lerp(T, sit);
      segs.push({ k: 'sit', dur: SIT_TIME * sit, from: p, to, yaw, s0: sit, s1: 0, seat });
      p = to;
    }
    let pts: THREE.Vector3[] = [p];
    const jp = R.joinPath;
    if (jp.length) {
      let j0 = 0, bd = Infinity;
      jp.forEach((q, i) => { const d = q.distanceTo(pod.out); if (d < bd) { bd = d; j0 = i; } });
      const last = jp[jp.length - 1];
      const back = this.nav.fromPoint(last, false, seat ?? actor.spot).reverse();
      pts = back.length > 1 ? [p, ...back.slice(1)] : [p, last];
      pts.push(...jp.slice(j0).reverse());
    } else {
      const back = this.nav.fromPoint(pod.out, false, seat ?? actor.spot).reverse();
      if (back.length > 1) pts = [p, ...back.slice(1)];
    }
    pts.push(pod.out.clone());
    const w = this.walk(pts, v);
    if (w) { this.turnTo(segs, p, yaw, w.path.heading(0)); segs.push(w); yaw = w.path.heading(w.path.length); p = w.path.at(w.path.length); }
    const inside = this.standIn(pod, actor);
    const d = inside.clone().sub(p).setY(0);
    const faceIn = d.lengthSq() > 1e-4 ? Math.atan2(d.x, d.z) : wrap(pod.yaw + Math.PI);
    this.turnTo(segs, p, yaw, faceIn);
    const t0 = segs.reduce((s, x) => s + x.dur, 0);
    segs.push({ k: 'step', dur: C_STEP, from: p.clone(), to: inside, y0: faceIn, y1: faceIn, lift: 0.1 });
    segs.push({ k: 'turn', dur: C_TURN, pos: inside, y0: faceIn, y1: pod.yaw });
    const close0 = t0 + C_STEP + C_TURN + 0.15, close1 = close0 + C_DOOR, frost1 = close1 - 0.1 + C_FROST;
    segs.push({ k: 'hold', dur: frost1 + C_SEAL - (t0 + C_STEP + C_TURN), pos: inside, yaw: pod.yaw, sit: 0, seat: null });
    const job = this.doorWindows(new Job(actor, 'exit', at, segs, null, pod.index, hash32(actor.key, Math.round(at * 10), 'cryox')));
    job.v = 'cryo';
    const wi = w ? segs.indexOf(w) : -1;
    job.m = { walk0: wi >= 0 ? job.starts[wi] : 0, walk1: wi >= 0 ? job.starts[wi] + w!.dur : t0, board: t0, door0: Math.max(0, t0 - 1.3), doorOpen: Math.max(0.3, t0 - 0.25),
      doorClose0: close0, doorClose1: close1, frost0: close1 - 0.1, frost1, seal: frost1, through: t0, leaveS: w && jp.length ? w.path.closest(jp[jp.length - 1]) : 0 };
    return job;
  }

  /** Walks through the room's DOOR open it (like the regular walk-in) — the cryo bay / drop bay are usually outside. */
  private doorWindows(job: Job) {
    const dw = this.nav.doorway;
    if (!dw || !this.room.door) return job;
    job.segs.forEach((sg, i) => {
      if (sg.k !== 'walk') return;
      const s = sg.path.closest(dw);
      const p = sg.path.at(s);
      if (p.distanceTo(dw) > 1.2) return;
      const tPass = job.starts[i] + walkT(sg, s);
      job.door.push({ open: Math.max(0, tPass - 1.3), close: tPass + walkT(sg, Math.min(sg.path.length, s + 0.9)) - walkT(sg, s) });
    });
    return job;
  }

  private ranked: CryoPod[] | null = null;
  /** Cryo pods by how centred CAM_CRYO sees them (all pods in file order when there's no cryo camera). */
  private podRank(): CryoPod[] {
    if (this.ranked) return this.ranked;
    const c = this.R.cams.cryo, pods = [...this.R.cryoPods];
    if (c) {
      const f = V(0, 0, -1).applyQuaternion(c.quaternion);
      const score = (p: CryoPod) => p.p.clone().add(V(0, 1.1, 0)).sub(c.position).normalize().dot(f);
      pods.sort((a, b) => score(b) - score(a) || a.index - b.index);
    }
    return (this.ranked = pods);
  }

  private sampleShown(j: Job, t: number) {
    // (v2: a guest waiting to join stands frozen in their pod until the thaw starts)
    if (t < 0) return j.kind === 'exit' || (this.podsOn && this.cryo.hold === 'frozen' && this.podOf(j.actor) === j.pod);
    if (j.kind === 'exit') return j.v === 'cryo' ? t < j.total || this.cryo.hold === 'frozen' : t < j.m.hatchClose1;
    return true;
  }

  // ---------------------------------------------------------------- per frame
  update(dt: number) {
    if (this.manual) this.clock += dt; else this.clock = Date.now() / 1000;
    (this.inner as unknown as { manual: boolean }).manual = this.manual;
    if (this.manual) (this.inner as unknown as { clock: number }).clock = this.clock;
    this.inner.update(dt);
    const now = this.now();
    for (const [a, j] of [...this.jobs]) {
      if (!a.runtime) { this.jobs.delete(a); continue; }
      const t = now - j.start;
      // exits register their launch once (the pod animation + the streak are driven by it on every page)
      if (j.kind === 'exit' && !this.launches.some((l) => l.id === `${a.key}:${j.start.toFixed(2)}`)) this.launches.push({ pod: j.pod, at: j.start + j.m.launch, id: `${a.key}:${j.start.toFixed(2)}`, key: a.key });
      this.apply(a, j, t);
      if (t >= j.total) {
        this.jobs.delete(a);
        if (j.kind === 'enter') this.handBack(a);
        else { a.shown = false; a.offset.set(0, 0, 0); a.tilt.identity(); }
      }
    }
    if (this.v2) this.updateHold(now);
    this.launches = this.launches.filter((l) => now - l.at < 60);
    // the room's DOOR: open while any of our walks passes it (never closes one the regular walker holds open)
    const door = this.room.door;
    if (door) {
      let v = 0;
      for (const j of this.jobs.values()) for (const w of j.door) { const t = now - j.start; v = Math.max(v, smooth((t - w.open) / 0.6) * (1 - smooth((t - w.close) / 0.6))); }
      if (v > 0.001) {
        const cur = (2 * Math.acos(Math.min(1, Math.abs(door.node.quaternion.dot(door.rest))))) / THREE.MathUtils.degToRad(Math.abs(door.openAngle) || 95);
        if (v > cur) door.setOpen(v);
      }
    }
    this.drawPods(now);
  }

  /** v2: absent members stand frozen in their pod (or sealed away) — a pure function of the host's state, so every page
   *  (and a page that loads later) shows the same pods occupied. Runs right after the jobs (no one-frame gap at a job's end). */
  private updateHold(now: number) {
    const was = new Map(this.held);
    this.held.clear();
    const st = this.scene;
    if (st && this.actorsFn && this.podsOn && this.cryo.hold !== 'hidden') {
      for (const a of this.actorsFn()) {
        if (!a.runtime || this.jobs.has(a) || this.inner.busy(a)) continue;
        if (st.present[a.key] !== false || (st.spots[a.key] === undefined && !a.spot) || !this.holdFor(a)) continue;
        this.held.set(a, this.podOf(a));
      }
    }
    for (const [a, pi] of this.held) {
      const pod = this.R.cryoPods[pi];
      if (!was.has(a)) { this.innerDrop(a); a.offset.set(0, 0, 0); a.tilt.identity(); }
      const L = this.layer(a);
      a.mount.position.copy(this.standIn(pod, a));
      a.mount.position.y += this.faceLift(a, pod);
      a.mount.rotation.set(0, pod.yaw, 0);
      a.sit = 0; a.perch = 0; a.appear = 1;
      a.shown = this.cryo.hold === 'frozen';
      a.updateSeat(null);
      const l = L.loco;
      l.gait = 0; l.armW = 0; l.headW = 0; l.idle = 0; a.loco = 0;
      const P = L.pose;
      P.still = true; P.breathe = this.cryo.breathe;
      P.frozen = 1; P.hug = 0; P.shiver = 0; P.stretch = 0;
      this.frostK.set(a, 1);
    }
    // someone left the hold without a job taking them (a spot change, the pods switched off): give them back
    for (const a of was.keys()) if (!this.held.has(a) && !this.jobs.has(a)) { this.handBack(a); this.frostK.set(a, 0); }
    // the frost look, for everyone this mover ever froze (0 = the hook does nothing)
    if (this.avFrost) for (const [a, k] of this.frostK) { this.avFrost.set(a, k, now); if (k <= 0) this.frostK.delete(a); }
  }

  private apply(a: SceneActor, j: Job, t: number) {
    const L = this.layer(a);
    const s = j.sample(t, this.tmp);
    a.mount.position.copy(s.pos);
    a.mount.position.y += s.lift * (a.rest?.height ?? 1.6) * a.scale * 0.5;
    a.mount.rotation.set(0, s.yaw, 0);
    a.sit = s.sit;
    a.shown = this.sampleShown(j, t);
    a.appear = 1;
    a.updateSeat(s.seat ?? (s.sit > 0 ? j.target : null) ?? a.spot);
    if (t >= j.total) a.updateSeat();
    const l = L.loco;
    l.dist = s.dist; l.gait = s.gait; l.back = s.back; l.stride = s.stride; l.idle = 0;
    a.loco = s.gait;
    const P = L.pose;
    P.still = this.v2; P.breathe = this.v2 ? this.cryo.breathe : 0;
    if (j.kind === 'exit' && j.v === 'cryo') {
      const pod = this.R.cryoPods[j.pod];
      if (pod) a.mount.position.y += this.faceLift(a, pod) * smooth((t - j.m.doorClose1) / 1.0);
      P.hug = 0; P.stretch = 0; P.shiver = 0;
      P.frozen = this.cryo.hold === 'frozen' || t < j.total ? smooth((t - j.m.frost0) / (j.m.frost1 - j.m.frost0)) : 0;
      const walking = t < j.m.board + C_STEP ? 1 : 0;
      l.armW = walking * smooth(t / ARM_BLEND) * (1 - smooth((t - j.m.board - C_STEP * 0.6) / ARM_BLEND)); l.headW = 0.5 * l.armW;
      if (this.v2) this.frostK.set(a, smooth((t - j.m.frost0 - 0.3) / (j.m.frost1 - j.m.frost0)));
      return;
    }
    if (j.kind === 'enter' && this.v2) {
      this.frostK.set(a, t < 0 ? 1 : 1 - smooth((t - T_FROZEN - 0.2) / 2.4));
      const pod = this.R.cryoPods[j.pod];
      if (pod && this.podOf(a) === j.pod) a.mount.position.y += this.faceLift(a, pod) * (1 - smooth((t - (T_DOOR0 - 1.0)) / 0.8));
    }
    if (j.kind === 'enter') {
      P.frozen = 1 - smooth((t - 2.4) / 1.0);
      P.hug = bell(t, 3.0, 3.6, j.m.stumbleEnd - 0.1, j.m.stumbleEnd + 0.4);
      P.shiver = bell(t, 2.4, 3.2, j.m.stumbleEnd + 0.6, j.m.stretch1 + 0.2);
      P.stretch = bell(t, j.m.stretch0, j.m.stretch0 + 0.6, j.m.stretch1 - 0.5, j.m.stretch1);
      const armOn = smooth((t - j.m.walk0 + ARM_BLEND) / ARM_BLEND) * (1 - smooth((t - j.m.walk1) / ARM_BLEND));
      l.armW = armOn * (1 - P.hug) * (1 - P.stretch); l.headW = 0.5 * l.armW;
    } else {
      P.frozen = 0; P.hug = 0; P.stretch = 0; P.shiver = 0;
      const walking = t < j.m.board + B_STEP ? 1 : 0;
      l.armW = walking * smooth(t / ARM_BLEND); l.headW = 0.5 * l.armW;
    }
  }

  // ---------------------------------------------------------------- pods: frost, doors, steam, countdown, launch
  /** v2 pods: window frost (0..1), melt, door, warmth, light level and whether someone is inside, at a moment. */
  private podV2(i: number, now: number): PodView & { melt: number; level: number; lit: number } {
    const HF = this.cryo.hold === 'sealed' ? 1 : HOLD_FROST;
    let frost = FROST_EMPTY, door = 0, warm = 0, melt = 0, level = 0.55, lit = 0.28;
    for (const pi of this.held.values()) if (pi === i) { frost = HF; level = 1; lit = 1; }
    for (const j of this.jobs.values()) {
      if (j.pod !== i || (j.kind === 'exit' && j.v !== 'cryo')) continue;
      const t = now - j.start;
      if (j.kind === 'enter') {
        const held = this.cryo.hold !== 'hidden';
        if (t < 0) { if (held) { frost = HF; level = 1; lit = 1; } else frost = 1; continue; }
        const f0 = held ? HF : 1;
        frost = t < T_FROZEN ? f0 : Math.max(FROST_IDLE * smooth((t - j.m.stumbleEnd - 1) / 2), f0 * (1 - smooth((t - T_FROZEN) / 2.0)));
        melt = smooth((t - T_FROZEN) / 0.7) * (1 - smooth((t - T_FROZEN - 2.6) / 1.2));
        door = smooth((t - T_DOOR0) / (T_DOOR1 - T_DOOR0)) * (1 - smooth((t - Math.max(j.m.stumbleEnd + 1.0, j.m.walk0 + 1.6)) / 0.9));
        warm = smooth((t - T_FROZEN) / 2.2) * (1 - smooth((t - j.m.stretch1 - 2) / 2));
        level = 1 - 0.3 * smooth((t - T_DOOR1) / 1.5); lit = Math.max(0.28, 1 - smooth((t - T_DOOR1) / 1.2));
      } else {
        const m = j.m;
        if (t < m.door0) continue;
        door = smooth((t - m.door0) / Math.max(0.2, m.doorOpen - m.door0)) * (1 - smooth((t - m.doorClose0) / (m.doorClose1 - m.doorClose0)));
        const fEnd = this.cryo.hold === 'frozen' ? HF : 1;
        frost = t < m.door0 + 0.6 ? FROST_IDLE * (1 - smooth((t - m.door0) / 0.6)) : t < m.frost0 ? 0 : fEnd * smooth((t - m.frost0) / (m.frost1 - m.frost0));
        if (this.cryo.hold === 'hidden' && t > m.seal + 1) frost = Math.max(FROST_IDLE, frost * (1 - smooth((t - m.seal - 1) / 2)));
        // amber "ready" while the door is open, back to icy blue as it seals; a bright pulse at the seal
        warm = smooth((t - m.door0) / 0.8) * (1 - smooth((t - m.frost0) / 1.4));
        level = 0.75 + 0.25 * smooth((t - m.frost0) / 1.0) + 0.45 * Math.exp(-(((t - m.seal) / 0.35) ** 2));
        lit = Math.max(0.28, smooth((t - m.board) / 0.8));
      }
    }
    return { frost, door, warm, melt, level, lit };
  }
  private podLight(i: number, now: number) { const v = this.podV2(i, now); return { warm: v.warm, level: v.level }; }

  private podView(i: number, now: number): PodView {
    if (this.v2) return this.podV2(i, now);
    let frost = FROST_IDLE, door = 0, warm = 0;
    for (const j of this.jobs.values()) {
      if (j.kind !== 'enter' || j.pod !== i) continue;
      const t = now - j.start;
      if (t < 0) { frost = 1; continue; }
      frost = t < T_FROZEN ? 1 : Math.max(FROST_IDLE * smooth((t - j.m.stumbleEnd - 1) / 2), 1 - smooth((t - T_FROZEN) / 2.0));
      door = smooth((t - T_DOOR0) / (T_DOOR1 - T_DOOR0)) * (1 - smooth((t - j.m.stumbleEnd - 1.0) / 0.9));
      warm = smooth((t - T_FROZEN) / 2.2) * (1 - smooth((t - j.m.stretch1 - 2) / 2));
    }
    return { frost, door, warm };
  }

  private drawPods(now: number) {
    const R = this.R, fx = this.fx;
    fx.begin(now);
    // cryo pods
    R.cryoPods.forEach((p, i) => {
      const v = this.podView(i, now);
      const f = this.frost[i];
      if (f) (f.material as THREE.MeshBasicMaterial).opacity = 0.8 * v.frost;
      const vv = v as PodView & { melt?: number; lit?: number };
      this.windows[i]?.set(v.frost, vv.melt ?? 0, vv.lit ?? 0, now % 1000);
      if (p.door) this.openNode(p.door, p.doorMode, v.door, p.doorBox, p.doorAngle);
      if (this.v2) {                            // (v2 pods light themselves: cryoKit.ts PodGlow on their cryoglow materials)
        const vv2 = v as PodView & { lit?: number };
        const lit = vv2.lit ?? 0;
        if (lit > 0.01) {
          const back = this.standIn(p).add(V(0, 1.45, 0)).addScaledVector(p.fwd, -0.42);
          fx.sprite(back, 0.95, 0.35, 0.62, 0.95, 0.55 * lit, SPRITE.glow, i + 0.25);
          fx.sprite(back.clone().add(V(0, 0.55, 0.0)), 0.6, 0.45, 0.75, 1.1, 0.35 * lit, SPRITE.glow, i + 0.75);
        }
        return;
      }
      const top = p.p.clone().add(V(0, 2.05, 0)).addScaledVector(p.fwd, 0.1);
      const cold = [0.45, 0.8, 1.3], hot = [1.3, 0.85, 0.45];
      const c = cold.map((x, k) => x + (hot[k] - x) * v.warm);
      fx.sprite(top, 0.45, c[0], c[1], c[2], 0.55 + 0.4 * v.warm, SPRITE.glow, i);
      fx.sprite(p.p.clone().add(V(0, 1.0, 0)).addScaledVector(p.fwd, 0.15), 0.8, c[0] * 0.5, c[1] * 0.5, c[2] * 0.5, 0.35 * (v.frost > 0.9 ? 1 : 0.6), SPRITE.glow, i + 0.5);
    });
    for (const j of this.jobs.values()) {
      const t = now - j.start;
      if (j.kind === 'exit' && j.v === 'cryo') {
        const p = R.cryoPods[j.pod];
        if (!p || t < j.m.frost0 - 0.2) continue;
        const r = new Rng(j.seed);
        const face = p.window ? new THREE.Box3().setFromObject(p.window).getCenter(V()) : p.p.clone().add(V(0, 1.45, 0)).addScaledVector(p.fwd, 0.6);
        const side = V(p.fwd.z, 0, -p.fwd.x);
        // frost sparkles creeping over the window
        if (t < j.m.frost1 + 0.6) for (let k = 0; k < 16; k++) {
          const ph = (t * r.range(0.25, 0.6) + r.next()) % 1, a = r.range(0, Math.PI * 2), rr = r.range(0.08, 0.3);
          const q = face.clone().addScaledVector(side, Math.cos(a) * rr).add(V(0, Math.sin(a) * rr * 0.7, 0)).addScaledVector(p.fwd, 0.03);
          fx.sprite(q, 0.022, 0.85, 0.97, 1.35, Math.sin(Math.PI * ph) * smooth((t - j.m.frost0) / 0.6) * (1 - smooth((t - j.m.frost1) / 0.6)), SPRITE.flare, r.next());
        }
        // the seal: a cold hiss of vapour out of the door seams
        for (let k = 0; k < 18; k++) {
          const born = j.m.seal - 0.15 + r.range(0, 0.7), age = t - born;
          if (age < 0 || age > 2.4) continue;
          const up = r.range(0.15, 2.1), sd = r.next() < 0.5 ? -1 : 1;
          const q = p.p.clone().add(V(0, up - 0.14, 0)).addScaledVector(p.fwd, 0.64).addScaledVector(side, sd * r.range(0.45, 0.6))
            .addScaledVector(side, sd * age * 0.35).addScaledVector(p.fwd, age * 0.25).add(V(0, -age * 0.12, 0));
          fx.puff(q, 0.12 + age * 0.28, 0.82, 0.9, 1.0, 0.5 * (1 - age / 2.4), r.next());
        }
        continue;
      }
      if (j.kind === 'enter') {
        const p = R.cryoPods[j.pod];
        if (!p || t < 0) continue;
        const r = new Rng(j.seed);
        // frost sparkles while frozen
        if (t < T_THAW) for (let i = 0; i < 14; i++) {
          const ph = (t * r.range(0.2, 0.5) + r.next()) % 1;
          const q = p.p.clone().add(V(r.range(-0.35, 0.35), 0.2 + ph * 1.9, r.range(-0.35, 0.35))).addScaledVector(p.fwd, 0.3);
          fx.sprite(q, 0.025, 0.8, 0.95, 1.3, Math.sin(Math.PI * ph) * (1 - smooth((t - 2.2) / 1.5)), SPRITE.flare, r.next());
        }
        // steam burst as the door opens
        for (let i = 0; i < 22; i++) {
          const born = 3.1 + r.range(0, 1.6), age = t - born;
          if (age < 0 || age > 2.8) continue;
          const dir = p.fwd.clone().multiplyScalar(r.range(0.4, 1.2)).add(V(r.range(-0.5, 0.5), r.range(0.1, 0.6), r.range(-0.5, 0.5)));
          const q = p.p.clone().add(V(0, r.range(0.2, 1.9), 0)).addScaledVector(p.fwd, 0.45).addScaledVector(dir, age * 0.9 * (1 - age / 6));
          fx.puff(q, 0.22 + age * 0.35, 0.9, 0.93, 0.97, 0.55 * (1 - age / 2.8), r.next());
        }
      } else {
        const p = R.dropPods[j.pod];
        if (!p) continue;
        const L = j.m.launch;
        // countdown lamps 3-2-1 above the hatch, then a red flash at launch
        const base = p.p.clone().add(V(0, 2.45, 0)).addScaledVector(p.fwd, 0.7);
        const side = V(p.fwd.z, 0, -p.fwd.x);
        for (let k = 0; k < 3; k++) {
          const lit = t > j.m.hatchClose1 + 0.2 + k * 0.8 && t < L + 0.4;
          const col = t > L - 0.2 ? [1.4, 0.15, 0.1] : k === 2 ? [0.3, 1.3, 0.4] : [1.4, 0.8, 0.15];
          fx.sprite(base.clone().addScaledVector(side, (k - 1) * 0.28), lit ? 0.14 : 0.05, col[0], col[1], col[2], lit ? 1 : 0.3, lit ? SPRITE.flare : SPRITE.glow, k);
        }
      }
    }
    // hatches + launches (pods leave down their tubes, reload a few seconds later)
    R.dropPods.forEach((p, i) => {
      let hatch = 0;
      for (const j of this.jobs.values()) {
        if (j.kind !== 'exit' || j.pod !== i) continue;
        const t = now - j.start;
        hatch = Math.max(hatch, smooth((t - j.m.hatch0) / 0.8) * (1 - smooth((t - j.m.hatchClose0) / (B_HATCH1 - B_HATCH0))));
      }
      if (p.hatch) this.openNode(p.hatch, p.hatchMode, hatch, null, p.hatchAngle);
      const l = this.launches.filter((x) => x.pod === i).sort((a, b) => b.at - a.at)[0];
      const node = p.node, rest = this.rest.get(node);
      if (!rest) return;
      let off = V(), vis = rest.vis;
      if (l) {
        const k = now - l.at;
        const dir = p.tubeEnd.clone().sub(p.tubeStart);
        if (k >= 0 && k < B_TUBE) { const e = (k / B_TUBE) ** 2.2; off = p.tubeStart.clone().sub(p.p).addScaledVector(dir, e); }
        else if (k >= B_TUBE && k < POD_RELOAD) vis = false;
        else if (k >= POD_RELOAD && k < POD_RELOAD + 1.6) off = V(0, -2.6 * (1 - smooth((k - POD_RELOAD) / 1.6)), 0);
        // launch flash + smoke from the tube mouth
        if (k >= -0.1 && k < 3.5) {
          const r = new Rng(hash32(l.id, 'launch'));
          if (k < 0.5) { fx.sprite(p.tubeStart.clone().add(V(0, 0.3, 0)), 1.6 + k * 4, 1.4, 1.0, 0.6, 1 - k / 0.5, SPRITE.flare, 0.3); fx.sprite(p.tubeStart.clone().add(V(0, 0.2, 0)), 1.2, 1.3, 0.6, 0.2, 1 - k / 0.5, SPRITE.fire, 0.1); }
          for (let s = 0; s < 16; s++) {
            const born = r.range(0, 1.2), age = k - born;
            if (age < 0 || age > 2.4) continue;
            const q = p.tubeStart.clone().add(V(r.range(-0.6, 0.6), 0.1 + age * r.range(0.4, 1.2), r.range(-0.6, 0.6)));
            fx.puff(q, 0.35 + age * 0.5, 0.55, 0.55, 0.56, 0.6 * (1 - age / 2.4), r.next());
          }
        }
      }
      node.visible = vis;
      if (off.lengthSq() > 0 && node.parent) {
        node.parent.updateWorldMatrix(true, false);
        const wp = node.parent.localToWorld(rest.p.clone()).add(off);
        node.position.copy(node.parent.worldToLocal(wp));
      } else node.position.copy(rest.p);
    });
    fx.end();
  }

  /** Doors / hatches: slide_up (by their height), slide_side, swing (about local Y at the origin), fade. */
  private openNode(o: THREE.Object3D, mode: string, k: number, box: THREE.Box3 | null, angle = -105) {
    const r = this.rest.get(o);
    if (!r) return;
    o.position.copy(r.p); o.quaternion.copy(r.q); o.visible = r.vis;
    if (k <= 0.001) return;
    if (mode === 'fade') { o.visible = k < 0.5; return; }
    if (mode === 'swing') { o.quaternion.multiply(_q1.setFromAxisAngle(V(0, 1, 0), THREE.MathUtils.degToRad(angle) * k)); return; }
    const b = box ?? new THREE.Box3().setFromObject(o);
    const size = b.getSize(V());
    if (mode === 'slide_side') o.position.x += size.x * 0.95 * k;
    else o.position.y += size.y * 0.97 * k;
  }

  /** A frosted pane over the pod's door (child of the door so it opens with it). */
  private makeFrost(p: CryoPod): THREE.Mesh | null {
    const c = document.createElement('canvas'); c.width = 128; c.height = 256;
    const g = c.getContext('2d')!;
    const r = new Rng(hash32(p.name, 'frost'));
    g.fillStyle = 'rgba(210,235,255,0.55)'; g.fillRect(0, 0, 128, 256);
    for (let i = 0; i < 90; i++) { const x = r.range(0, 128), y = r.range(0, 256), rr = r.range(4, 22); const gr = g.createRadialGradient(x, y, 0, x, y, rr); gr.addColorStop(0, 'rgba(255,255,255,0.7)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(x - rr, y - rr, rr * 2, rr * 2); }
    g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 1;
    for (let i = 0; i < 40; i++) { let x = r.range(0, 128), y = r.range(0, 256); g.beginPath(); g.moveTo(x, y); for (let s = 0; s < 5; s++) { x += r.range(-12, 12); y += r.range(-12, 12); g.lineTo(x, y); } g.stroke(); }
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const H = p.doorBox ? p.doorBox.getSize(V()).y : 2.1;
    const W = p.doorBox ? Math.max(p.doorBox.getSize(V()).x, p.doorBox.getSize(V()).z) : 0.9;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.96, H * 0.96), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: FROST_IDLE, fog: false, side: THREE.DoubleSide }));
    m.name = `vtp:space:frost:${p.name}`;
    m.renderOrder = 4;
    const center = p.doorBox ? p.doorBox.getCenter(V()) : p.p.clone().add(V(0, 1.1, 0)).addScaledVector(p.fwd, 0.45);
    m.position.copy(center).addScaledVector(p.fwd, 0.04);
    m.quaternion.setFromUnitVectors(V(0, 0, 1), p.fwd);
    this.room.root.add(m);
    if (p.door) { m.updateMatrixWorld(); p.door.attach(m); }
    return m;
  }

  // ---------------------------------------------------------------- camera
  followCamera(fo: SceneState['follow'], aspect: number, present: (a: SceneActor) => boolean): { key: string; pose: CamPose; secs: number } | null | undefined {
    void aspect;
    const now = this.now();
    const R = this.R;
    let best: { j: Job; t: number } | null = null;
    for (const j of this.jobs.values()) {
      const t = now - j.start;
      if (!(j.actor.key === '@host' ? fo.host : fo.guests)) continue;
      if (j.kind === 'enter' && (t < 0 || t > j.total + 0.4 || !present(j.actor))) continue;
      if (j.kind === 'exit' && (this.sceneMode === 'react' || t < 0)) continue;
      if (!best || t > best.t) best = { j, t };
    }
    if (!best) {
      // the pod is away: watch its re-entry through the viewport
      if (this.sceneMode === 'react') return undefined;
      const l = this.launches.filter((x) => (x.key === '@host' ? fo.host : fo.guests) && now - x.at > B_TUBE && now - x.at < B_TUBE + 11.5).sort((x, y) => y.at - x.at)[0];
      const vc = R.cams.viewport ?? this.room.cameras.get('CAM_WIDE') ?? null;
      return l && vc ? { key: 'space:viewport', pose: vc, secs: 0 } : undefined;
    }
    const { j, t } = best, a = j.actor;
    const samp = j.sample(t, { pos: V(), yaw: 0, sit: 0, seat: null, dist: 0, gait: 0, stride: 1, back: false, lift: 0 });
    const seg = j.segs.find((x) => x.k === 'walk') as Extract<Seg, { k: 'walk' }> | undefined;
    if (j.kind === 'enter') {
      if (t < j.m.stretch1 + 0.3 && R.cams.cryo) return { key: 'space:cryo', pose: R.cams.cryo, secs: 0 };
      const onBridge = !seg || t > j.m.walk1 || (seg.path.closest(samp.pos) >= (j.m.bridgeS ?? 0) - 0.05 && t > j.m.walk0 + 0.3);
      return this.walkCam(a, seg, samp.pos, onBridge, now);
    }
    // cryo exit: follow the walk back to the bay, then CAM_CRYO while the pod closes and frosts over
    if (j.v === 'cryo') {
      if (t < j.m.board - 1.5) {
        if (t < (j.m.walk0 ?? 0)) return undefined;
        const onBridge = !seg || seg.path.closest(samp.pos) < (j.m.leaveS ?? Infinity);
        // through the door and into the bay: the bay camera (the corridor chase would squeeze into the walls)
        if (!onBridge && R.cams.cryo) return { key: 'space:cryo', pose: R.cams.cryo, secs: 0 };
        const wc = this.walkCam(a, seg, samp.pos, onBridge, now);
        const tgt = samp.pos.clone().setY(samp.pos.y + (a.rest?.height ?? 1.6) * a.scale * 0.6);
        if (this.blocked(wc.pose.position, tgt)) {
          const rc = this.roomCamFor(tgt);
          if (rc) return { key: `space:room:${rc.name}:${a.key}`, pose: rc, secs: 0 };
          if (R.cams.cryo) return { key: 'space:cryo', pose: R.cams.cryo, secs: 0 };
        }
        return wc;
      }
      if (t < j.total + 0.6 && R.cams.cryo) return { key: 'space:cryo', pose: R.cams.cryo, secs: 0 };
      return undefined;
    }
    // exit: follow the walk off the bridge, the drop bay at the pod (the viewport afterwards, see above)
    if (t < j.m.board - 1.5) {
      if (t < (j.m.walk0 ?? 0)) return undefined;
      const onBridge = !seg || seg.path.closest(samp.pos) < (j.m.leaveS ?? Infinity);
      return this.walkCam(a, seg, samp.pos, onBridge, now);
    }
    if (t < j.m.launch + B_TUBE + 0.3) return R.cams.dropbay ? { key: 'space:dropbay', pose: R.cams.dropbay, secs: 0 } : undefined;
    const vc = R.cams.viewport ?? this.room.cameras.get('CAM_WIDE') ?? null;
    return vc ? { key: 'space:viewport', pose: vc, secs: 0 } : undefined;
  }

  /** Debug (test pages, vtpOut.cryo()): the v2 pods — who is in which pod, what each pod shows, the jobs. */
  cryoDebug() {
    const now = this.now();
    return {
      v2: this.v2, on: this.podsOn, cfg: this.cryo, alloc: Object.fromEntries(this.alloc),
      held: [...this.held].map(([a, p]) => ({ key: a.key, pod: p, shown: a.shown })),
      pods: this.R.cryoPods.map((p, i) => ({ name: p.name, window: p.window?.name ?? null, ...(this.v2 ? Object.fromEntries(Object.entries(this.podV2(i, now)).map(([k, v]) => [k, +(+v).toFixed(3)])) : {}) })),
      jobs: [...this.jobs.values()].map((j) => ({ key: j.actor.key, kind: j.kind, v: j.v, pod: j.pod, t: +(now - j.start).toFixed(2), total: +j.total.toFixed(2) })),
      glow: this.glow?.count ?? 0,
    };
  }

  /** On the bridge: the room's operator pans + zooms from CAM_WIDE. In corridors / bays: a chase camera, or where the
   *  walls crowd it, the nearest room camera that sees them (held ≥ 1.5 s, no flip-flopping). */
  private walkCam(a: SceneActor, seg: Extract<Seg, { k: 'walk' }> | undefined, pos0: THREE.Vector3, onBridge: boolean, now: number) {
    const h = (a.rest?.height ?? 1.6) * a.scale;
    const target = pos0.clone().setY(pos0.y + h * 0.6);
    if (!onBridge && seg) {
      const sb = Math.max(0, seg.path.closest(pos0) - 2.6);
      const back = seg.path.at(sb, V());
      const chase = this.unblocked(target, back.setY(h * 1.05 + 0.35), 52);
      const room = this.roomCamFor(target);
      const crowded = chase.position.distanceTo(target) < 1.7;
      const hold = this.camHold.get(a);
      const want = crowded && room ? 'room' : 'chase';
      const mode = hold && now - hold.at < 1.5 ? hold.mode : want;
      if (!hold || hold.mode !== mode) this.camHold.set(a, { mode, at: now });
      if (mode === 'room' && room) return { key: `space:room:${room.name}:${a.key}`, pose: room as CamPose, secs: 0 };
      return { key: `space:chase:${a.key}`, pose: chase, secs: 0 };
    }
    const base = this.room.cameras.get('CAM_WIDE')?.position ?? target.clone().add(V(0, 0.5, 4));
    const away = base.clone().sub(target);
    const pos = away.length() < 2.2 ? target.clone().addScaledVector(away.normalize(), 2.2) : base.clone();
    const fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan((h * 0.75) / pos.distanceTo(target))), 18, 50);
    return { key: `space:follow:${a.key}`, pose: lookPose(pos, target, fov), secs: 0 };
  }

  private camHold = new WeakMap<SceneActor, { mode: string; at: number }>();
  /** A wall between a camera and a point (the room's occluders). */
  private blocked(from: THREE.Vector3, to: THREE.Vector3) {
    const d = to.clone().sub(from), len = d.length();
    if (len < 0.5 || !this.room.occluders.length) return false;
    this.ray.set(from, d.normalize()); this.ray.far = len - 0.35;
    return this.ray.intersectObjects(this.room.occluders, false).some((h) => h.distance > 0.3);
  }
  /** The room camera (CAM_*) closest to a point that has a clear line of sight to it. */
  private roomCamFor(target: THREE.Vector3): (CamPose & { name: string }) | null {
    let best: (CamPose & { name: string }) | null = null, bd = Infinity;
    for (const [name, c] of this.room.cameras) {
      if (/^SPOT_|REACT|TALK/.test(name)) continue;
      const d = c.position.distanceTo(target);
      if (d > 14 || d < 1.2 || d > bd) continue;
      const f = V(0, 0, -1).applyQuaternion(c.quaternion);
      if (target.clone().sub(c.position).normalize().dot(f) < 0.55) continue;
      const dir = target.clone().sub(c.position).normalize();
      this.ray.set(c.position, dir); this.ray.far = d - 0.4;
      if (this.ray.intersectObjects(this.room.occluders, false).length) continue;
      bd = d;
      const fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(1.1 / d)), 16, c.fov);
      best = { ...lookPose(c.position, target, fov), name };
    }
    return best;
  }

  private unblocked(target: THREE.Vector3, pos: THREE.Vector3, fov: number): CamPose {
    const dir = pos.clone().sub(target);
    const len = dir.length();
    if (len > 1e-3 && this.room.occluders.length) {
      this.ray.set(target, dir.normalize()); this.ray.far = len;
      const hit = this.ray.intersectObjects(this.room.occluders, false).find((x) => x.distance > 0.25);
      if (hit) pos = target.clone().addScaledVector(dir, Math.max(0.6, hit.distance - 0.15));
    }
    return lookPose(pos, target, fov);
  }
}

// ------------------------------------------------------------------------------------------------ install
// Rooms that declare a cryo entrance / drop-pod exit (scene.json, or the anchors) get the SpaceMover; every other room
// keeps the regular WalkMover.
setMoverFactory((room, info) => {
  const R = spaceRoomOf(room, info ?? null);
  if (R && ((R.entrance === 'cryo' && R.cryoPods.length) || (R.exit === 'droppod' && R.dropPods.length) || (usesStyle(R.exitBy, 'cryo') && R.cryoPods.length))) return new SpaceMover(room, info, R);
  return new WalkMover(room);
});
