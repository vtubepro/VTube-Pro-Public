// Captain's lift (AvatarMover): the performer rises out of the floor on a platform, steps off and walks to their
// spot; leaving, they walk onto the platform and sink out of sight. Selected per role by scene.json
// `"entrance": "lift"` / `"exit": "lift"` or the per-role form `{ "host": "lift", "guests": "cryo" }`
// (shared/arrivals.ts). Everything else — the other role's style, spot changes, rooms without a LIFT_xx — goes to the
// mover this one wraps (the regular WalkMover, or the SpaceMover for cryo / drop-pod rooms), exactly as before.
//
// Room contract (glTF, docs/SCENES.md → "Captain's lift"):
//   LIFT_xx              the platform (a mesh). Authored position = the TOP (floor level); extras `depth` (m, default
//                        1.6) = how far below the floor it starts.
//   LIFT_xx_hatch_L / _R (optional) hatch panels over the shaft; extras `slide` [x,y,z] (glTF offset when open;
//                        default ±0.9 m along the platform's local X). With a hatch the platform rests at the bottom
//                        under the closed hatch; without one it rests at the top (it is the floor).
//   LIFT_xx_out          (optional) step-off point (empty) — default 0.45 m past the platform's +Z edge.
//   CAM_LIFT / CAM_LIFT_xx (optional) the camera for the rise / the descent (else from CAM_WIDE when it sees the lift,
//                        else an automatic shot in front of it). Follows the "Camera follows my entrance" setting.
//   LIFT_xx_lid          (optional) a coffin lid (a child of the platform, or any node): swings open after the rise and
//                        shut before the sink. extras `hinge` ("left" | "right" | "top"), `openAngle` (deg, default 110),
//                        `open` (s one swing takes, default 0.6). A room without a lid is unchanged.
//   EMIT_lift*           (optional) materials that pulse amber while a lift runs (render-time only).
//   The host always uses LIFT_01 (the first); guests the others by seat (all of them share LIFT_01 when it is alone).
//
//   ENTER  hatch slides open (0.7 s, hazard pulse) → the platform rises with the performer standing on it (2.2 s, eased,
//          a small overshoot + settle; a warm column of light and a few sparks at the rim) → [lid swings open] → they
//          step off at _out → walk to their spot (the room's lanes + the spot's approach points) → [lid swings shut] →
//          the platform sinks, the hatch closes.
//   EXIT   stand up → walk to _out (the hatch opens + the platform comes up as they get there; [the lid swings open]) →
//          step on, turn round → [lid swings shut] → sink (2.0 s) → hidden once fully below → the hatch closes.
//   With a lid: dirt / dust puffs on the rise and at each thud (SpaceFx smoke pool) and a creak + thud camera shake of
//   at most 2 cm on the lift shot. No sound.
//
// DETERMINISTIC like WalkMover / SpaceMover: each job is a pure function of (room data, avatar size, spot, the host's
// move stamp), sampled at wall-clock time on every page (studio preview, OBS, party guests' OBS), so a page that loads
// mid-rise lands mid-rise and an old stamp just snaps. One rider per platform at a time: overlapping jobs on the same
// lift queue in (stamp, key) order (the same on every page).
import * as THREE from 'three';
import type { AvatarRuntime } from '../../avatar/AvatarRuntime.ts';
import type { SceneActor } from '../actor.ts';
import type { CameraPreset, RoomInfo, SpotInfo } from '../contract.ts';
import { lookPose, type CamPose } from '../cameraRig.ts';
import { Locomotion } from '../locomotion.ts';
import { currentMoverFactory, setMoverFactory, type AvatarMover, type MoveEvent, type MoverHandover, type MoverTrack } from '../mover.ts';
import { RoomNav, WalkPath } from '../navigation.ts';
import type { SceneInfo, SceneState } from '../../../shared/types.ts';
import { parseRoleStyles, styleFor, usesStyle, type RoleStyles } from '../../../shared/arrivals.ts';
import { hash32, Rng } from '../raid/rng.ts';
import { SPRITE, SpaceFx } from '../space/fx.ts';

// timeline (s)
const T_OPEN = 0.7, T_RISE = 2.2, T_PAUSE = 0.35, T_STEP = 0.8, T_SINK = 1.3, T_CLOSE = 0.7, T_DESC = 2.0, T_TURN_ON = 0.7;
const SIT_TIME = 0.8, ACCEL = 0.45, DECEL = 0.55, TURN_RATE = 3.4, TURN_STEP = 0.3, ARM_BLEND = 0.4;
const DEPTH = 1.6, SLIDE = 0.9, OVERSHOOT = 0.03, HAZARD_HZ = 1.6;
// coffin lid (LIFT_xx_lid): defaults, the pause before the platform sinks / after it is shut, and the camera shake cap
const LID_DEG = 110, LID_OPEN_S = 0.6, LID_GAP = 0.1, SHAKE_M = 0.016, SHAKE_MAX = 0.02, SHAKE_S = 0.45, DUST_S = 1.5;

const smooth = (v: number) => { const k = v < 0 ? 0 : v > 1 ? 1 : v; return k * k * (3 - 2 * k); };
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
// scratch objects for the per-frame coffin lid + dust code (never held across calls)
const PN = new THREE.Vector3(), PO = new THREE.Vector3();   // (placeNode's scratch)
const SQ = new THREE.Quaternion(), SP = new THREE.Vector3(), SW = new THREE.Vector3(), SD = new THREE.Vector3();
const easeInOut = (k: number) => { const x = clamp01(k); return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2; };
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(+v) ? +v : d);
const vec3 = (v: unknown): [number, number, number] | null => (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((x) => Number.isFinite(Number(x))) ? [Number(v[0]), Number(v[1]), Number(v[2])] : null);

/** Platform height (0 = top … -depth) through the rise: eased, a small overshoot above the floor, settling at 0. */
export function riseY(k: number, depth: number) {
  const base = -depth * (1 - easeInOut(k / 0.82));
  const u = (k - 0.7) / 0.3;
  return base + (u > 0 && u < 1 ? OVERSHOOT * Math.sin(Math.PI * u) * (1 - 0.35 * u) : 0);
}
/** …and through the descent (a slow start — the hatch is right there — then down). */
export function descY(k: number, depth: number) { return -depth * easeInOut(k); }
/** Camera shake of a coffin lift at `t` s into the job (camera-space metres [right, up], never more than 2 cm): a short
 *  decaying tremble after each thud. Pure, so every page shakes the same. */
export function liftShake(puffs: readonly Thud[], t: number): [number, number] {
  let x = 0, y = 0;
  puffs.forEach((e, i) => {
    const age = t - e.t;
    if (age < 0 || age > SHAKE_S) return;
    const w = Math.min(1, e.s) * Math.exp(-age * 9);
    x += w * Math.sin(age * 57 + i * 1.7); y += w * Math.cos(age * 71 + i * 2.3);
  });
  const c = (v: number) => Math.max(-SHAKE_MAX, Math.min(SHAKE_MAX, v * SHAKE_M));
  return [c(x), c(y)];
}

// ------------------------------------------------------------------------------------------------ room data
interface Hatch { node: THREE.Object3D; open: THREE.Vector3 }
export type LidHinge = 'left' | 'right' | 'top';
/** LIFT_xx_lid: a lid that turns about one of its edges (the hinge), measured once from the room at rest. */
export interface LidInfo {
  node: THREE.Object3D;
  hinge: LidHinge;
  /** Full open angle (rad; positive = the lid swings OUT, away from the rider) and the time one swing takes (s). */
  angle: number; open: number;
  /** A lid standing in front of the rider (turns about a vertical edge / its top) or lying over them (turns up like a chest lid). */
  lying: boolean;
  /** Hinge pivot + axis in the lid's PARENT space (the axis is signed so +angle swings outward), and the lid's rest transform. */
  pivot: THREE.Vector3; axis: THREE.Vector3;
  restPos: THREE.Vector3; restQuat: THREE.Quaternion;
  /** The lid is a descendant of the platform (rides with it); else the mover lifts it with the platform itself. */
  child: boolean;
  /** The (open fraction, platform lift) the node was last posed for: an idle, unchanged lid costs nothing per frame. */
  last: [number, number];
}
export interface LiftInfo {
  index: number; name: string; node: THREE.Object3D;
  /** World position of the platform's top (authored) and its flat +Z / +X. */
  top: THREE.Vector3; fwd: THREE.Vector3; right: THREE.Vector3;
  depth: number;
  hatches: Hatch[];
  /** Step-off / boarding point on the floor, and the yaw facing out (platform → out). */
  out: THREE.Vector3; yawOut: number;
  /** Half extents of the platform along right / fwd (m). */
  hw: number; hd: number;
  cam: CameraPreset | null;
  /** LIFT_xx_lid (null = no lid: the lift behaves exactly as it always did). */
  lid: LidInfo | null;
}

/** Parse LIFT_xx_lid: the hinge edge from the lid's oriented extents along the platform's right / up / forward. A lid whose
 *  thinnest side faces up lies over the rider (hinge left / right = its side edges, top = its far edge); otherwise it
 *  stands in front of them (left / right = its vertical side edges, top = its upper edge). */
export function parseLid(node: THREE.Object3D, platform: THREE.Object3D, right: THREE.Vector3, fwd: THREE.Vector3): LidInfo | null {
  const parent = node.parent;
  if (!parent) return null;
  const x = (node.userData ?? {}) as Record<string, unknown>;
  const h = String(x.hinge ?? '').trim().toLowerCase();
  const hinge: LidHinge = h === 'right' || h === 'top' ? h : 'left';
  const up = V(0, 1, 0), basis = [right, up, fwd];
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  const p = V();
  const take = (w: THREE.Vector3) => basis.forEach((b, i) => { const d = w.dot(b); if (d < mn[i]) mn[i] = d; if (d > mx[i]) mx[i] = d; });
  node.traverse((o) => {
    const m = o as THREE.Mesh;
    const pos = m.isMesh ? m.geometry?.getAttribute?.('position') : null;
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) take(p.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld));
  });
  if (!Number.isFinite(mn[0])) take(node.getWorldPosition(V()));           // no geometry: the node's origin is the hinge
  const c = mn.map((v, i) => (v + mx[i]) / 2), ext = mn.map((v, i) => mx[i] - v);
  const lying = ext[1] > 0 && ext[1] < ext[0] && ext[1] < ext[2];
  // the hinge edge (r, u, f along right / up / forward) and its axis
  let edge: [number, number, number], axisDir: THREE.Vector3;
  if (hinge === 'top') { edge = lying ? [c[0], c[1], mn[2]] : [c[0], mx[1], c[2]]; axisDir = right; }
  else { edge = [hinge === 'left' ? mn[0] : mx[0], c[1], c[2]]; axisDir = lying ? fwd : up; }
  const at = (r: number, u: number, f: number) => V().addScaledVector(right, r).addScaledVector(up, u).addScaledVector(fwd, f);
  const pivotW = at(...edge), centreW = at(c[0], c[1], c[2]);
  const axisW = axisDir.clone().normalize();
  // positive angle = the lid's middle moves outward (away from the rider: forward for a standing lid, up for a lying one)
  if (axisW.clone().cross(centreW.clone().sub(pivotW)).dot(lying ? up : fwd) < 0) axisW.negate();
  const inv = parent.matrixWorld.clone().invert();
  const deg = Math.min(175, Math.max(5, Math.abs(num(x.openAngle, LID_DEG))));
  return {
    node, hinge, angle: THREE.MathUtils.degToRad(deg), open: Math.min(3, Math.max(0.2, num(x.open, LID_OPEN_S))), lying,
    pivot: pivotW.applyMatrix4(inv), axis: axisW.transformDirection(inv),
    restPos: node.position.clone(), restQuat: node.quaternion.clone(),
    child: (() => { for (let o: THREE.Object3D | null = node; o; o = o.parent) if (o === platform) return true; return false; })(),
    last: [NaN, NaN],
  };
}

export function parseLifts(room: RoomInfo): LiftInfo[] {
  const nodes = new Map<string, THREE.Object3D>();
  room.root.updateWorldMatrix(true, true);
  room.root.traverse((o) => { if (o.name && !nodes.has(o.name)) nodes.set(o.name, o); });
  const get = (n: string) => nodes.get(n) ?? nodes.get(n.replace(/_(hatch|out)(_[LR])?$/, (m) => m.toUpperCase())) ?? null;
  const names = [...nodes.keys()].filter((n) => /^LIFT_\d+$/.test(n)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const rootO = room.root.localToWorld(V());
  return names.map((name, index) => {
    const node = nodes.get(name)!;
    const x = (node.userData ?? {}) as Record<string, unknown>;
    const top = node.getWorldPosition(V());
    const q = node.getWorldQuaternion(new THREE.Quaternion());
    let fwd = V(0, 0, 1).applyQuaternion(q).setY(0);
    if (fwd.lengthSq() < 1e-6) fwd = V(0, 0, 1);
    fwd.normalize();
    const right = V(fwd.z, 0, -fwd.x);                 // local +X for a Y-up node (+Z × +Y)
    const box = new THREE.Box3().setFromObject(node);
    let hw = 0.6, hd = 0.6;
    if (!box.isEmpty()) {
      const c = box.getCenter(V()), s = box.getSize(V());
      const corners = [V(box.min.x, 0, box.min.z), V(box.max.x, 0, box.min.z), V(box.min.x, 0, box.max.z), V(box.max.x, 0, box.max.z)];
      hw = Math.max(...corners.map((p) => Math.abs(p.clone().sub(c).dot(right)))) || 0.6;
      hd = Math.max(...corners.map((p) => Math.abs(p.clone().sub(c).dot(fwd)))) || 0.6;
      if (s.x < 0.05 && s.z < 0.05) { hw = 0.6; hd = 0.6; }
    }
    const hatches: Hatch[] = [];
    for (const [suf, sign] of [['_hatch_L', -1], ['_hatch_R', 1], ['_hatch', 1]] as const) {
      const h = get(`${name}${suf}`);
      if (!h || hatches.some((x) => x.node === h)) continue;
      const hx = (h.userData ?? {}) as Record<string, unknown>;
      const sl = vec3(hx.slide);
      const open = sl ? room.root.localToWorld(V(...sl)).sub(rootO) : right.clone().multiplyScalar(sign * SLIDE);
      hatches.push({ node: h, open });
    }
    const on = get(`${name}_out`);
    const out = on ? on.getWorldPosition(V()).setY(0) : top.clone().setY(0).addScaledVector(fwd, hd + 0.45);
    const d = out.clone().sub(top.clone().setY(0));
    const yawOut = d.lengthSq() > 1e-4 ? Math.atan2(d.x, d.z) : Math.atan2(fwd.x, fwd.z);
    const cam = room.cameras.get(`CAM_${name}`) ?? room.cameras.get('CAM_LIFT') ?? null;
    const lidNode = get(`${name}_lid`);
    const lid = lidNode && lidNode !== node ? parseLid(lidNode, node, right, fwd) : null;
    return { index, name, node, top, fwd, right, depth: Math.max(0.3, num(x.depth, DEPTH)), hatches, out, yawOut, hw, hd, cam, lid };
  });
}

// ------------------------------------------------------------------------------------------------ jobs
type Seg =
  | { k: 'hold'; dur: number; pos: THREE.Vector3; yaw: number; sit: number; seat: SpotInfo | null }
  | { k: 'turn'; dur: number; pos: THREE.Vector3; y0: number; y1: number }
  | { k: 'walk'; dur: number; path: WalkPath; v: number; ta: number; td: number }
  | { k: 'step'; dur: number; from: THREE.Vector3; to: THREE.Vector3; yaw: number }
  | { k: 'ride'; dur: number; pos: THREE.Vector3; yaw: number; up: boolean; wait: number; depth: number }
  | { k: 'sit'; dur: number; from: THREE.Vector3; to: THREE.Vector3; yaw: number; s0: number; s1: number; seat: SpotInfo };

interface Sample { pos: THREE.Vector3; yaw: number; sit: number; seat: SpotInfo | null; dist: number; gait: number; stride: number; back: boolean }

function walkS(sg: Extract<Seg, { k: 'walk' }>, t: number) {
  const { v, ta, td, dur } = sg, L = sg.path.length;
  if (t <= 0) return { s: 0, v: 0 };
  if (t >= dur) return { s: L, v: 0 };
  if (t < ta) return { s: (v * t * t) / (2 * ta), v: (v * t) / ta };
  if (t > dur - td) { const r = dur - t; return { s: L - (v * r * r) / (2 * td), v: (v * r) / td }; }
  return { s: (v * ta) / 2 + v * (t - ta), v };
}

/** Where an exit starts (kept so a queued exit can be re-timed with the same origin). */
interface Origin { pos: THREE.Vector3; yaw: number; sit: number; seat: SpotInfo | null; onLift: number | null }

class Job {
  starts: number[] = []; dist0: number[] = []; total = 0;
  /** Relative moments: platform window (busy from … to), step off / board, down, walk span. With a lid: `lid` = one swing (s,
   *  0 = no lid), `lid0` / `lid1` = when it starts to open / to shut, `puffs` = the thuds (dust + camera shake). */
  m: Moments = { win0: 0, win1: 0, off: 0, board: 0, down: 0, walk0: 0, walk1: 0, shown0: 0, hatch: true, ...NO_LID };
  at0 = 0;
  /** The queue gate it was built for (absolute s; -Infinity = the platform was free). */
  gate = -Infinity;
  constructor(readonly actor: SceneActor, readonly kind: 'enter' | 'exit', public start: number, readonly segs: Seg[], readonly target: SpotInfo | null,
    readonly lift: number, readonly seed: number, readonly origin: Origin | null, readonly depth: number) {
    let t = 0, d = 0;
    for (const s of segs) {
      this.starts.push(t); this.dist0.push(d); t += s.dur;
      d += s.k === 'walk' ? s.path.length : s.k === 'turn' ? Math.abs(wrap(s.y1 - s.y0)) * TURN_STEP : s.k === 'step' || s.k === 'sit' ? s.from.distanceTo(s.to) : 0;
    }
    this.total = t;
  }
  /** Kept until both the walk and the platform are done. */
  get end() { return Math.max(this.total, this.m.win1); }
  sample(t: number, o: Sample): Sample {
    const n = this.segs.length;
    let i = 0;
    const tt = Math.max(0, Math.min(t, this.total));
    while (i < n - 1 && tt >= this.starts[i + 1]) i++;
    const sg = this.segs[i], lt = Math.min(sg.dur, tt - this.starts[i]), k = sg.dur > 0 ? lt / sg.dur : 1;
    o.gait = 0; o.stride = 1; o.back = false; o.dist = this.dist0[i]; o.seat = null; o.sit = 0;
    switch (sg.k) {
      case 'hold': o.pos.copy(sg.pos); o.yaw = sg.yaw; o.sit = sg.sit; o.seat = sg.seat; break;
      case 'turn': { const d = wrap(sg.y1 - sg.y0); o.pos.copy(sg.pos); o.yaw = sg.y0 + d * smooth(k); o.dist += Math.abs(d) * TURN_STEP * smooth(k); o.gait = 0.6 * Math.sin(Math.PI * k); o.stride = 0; break; }
      case 'walk': { const w = walkS(sg, lt); sg.path.at(w.s, o.pos); o.yaw = sg.path.heading(w.s); o.dist += w.s; o.gait = sg.v > 0 ? Math.min(1, w.v / sg.v) : 0; break; }
      case 'step': { const e = smooth(k); o.pos.lerpVectors(sg.from, sg.to, e); o.yaw = sg.yaw; o.dist += sg.from.distanceTo(sg.to) * e; o.gait = 0.55 * Math.sin(Math.PI * k); break; }
      case 'ride': {
        o.pos.copy(sg.pos); o.yaw = sg.yaw;
        const r = Math.max(0, lt - sg.wait), rd = sg.dur - sg.wait;
        const kk = rd > 0 ? r / rd : 1;
        o.pos.y = sg.pos.y + (sg.up ? riseY(kk, sg.depth) : descY(kk, sg.depth));
        break;
      }
      case 'sit': {
        const down = sg.s1 > sg.s0;
        const mk = down ? smooth(k / 0.7) : smooth((k - 0.3) / 0.7), sk = down ? smooth((k - 0.2) / 0.8) : smooth(k / 0.8);
        o.pos.lerpVectors(sg.from, sg.to, mk); o.yaw = sg.yaw; o.seat = sg.seat; o.sit = sg.s0 + (sg.s1 - sg.s0) * sk;
        o.dist += sg.from.distanceTo(sg.to) * mk; o.gait = 0.4 * Math.sin(Math.PI * clamp01(down ? k / 0.7 : (k - 0.3) / 0.7)) * (1 - o.sit); o.back = down;
        break;
      }
    }
    return o;
  }
  shownAt(t: number) {
    if (this.kind === 'enter') return t >= this.m.shown0;
    return t < this.m.down;
  }
}

/** A thud of a coffin lift: when (s from the job's start) and how hard (0 … 1). */
export interface Thud { t: number; s: number }
interface Moments { win0: number; win1: number; off: number; board: number; down: number; walk0: number; walk1: number; shown0: number; hatch: boolean; lid: number; lid0: number; lid1: number; puffs: Thud[] }
const NO_LID = { lid: 0, lid0: 0, lid1: 0, puffs: [] as Thud[] };

/** What a platform shows at a moment (from the job that owns it). */
interface LiftView { y: number; hatch: number; column: number; hazard: number; /** lid open fraction 0 … 1 */ lid: number; job: Job | null; t: number }

// ------------------------------------------------------------------------------------------------ the mover
type Inner = AvatarMover & Partial<MoverHandover> & { manual?: boolean; clock?: number; spaceState?: unknown; sceneMode?: string; spaceLaunches?: () => unknown[]; now?: () => number;
  /** The space mover's cryo pods v2: a member frozen in a pod thaws out of it, whatever their own entrance. */
  claimsEnter?: (a: SceneActor, ev?: MoveEvent) => boolean; cryoDebug?: () => unknown };

export class LiftMover implements AvatarMover {
  readonly lifts: LiftInfo[];
  readonly nav: RoomNav;
  readonly entranceBy: RoleStyles;
  readonly exitBy: RoleStyles;
  private jobs = new Map<SceneActor, Job>();
  /** Finished rides whose platform is still moving (sinking back, the hatch closing): the platform's, not the actor's. */
  private tails: Job[] = [];
  private layers = new Map<SceneActor, { loco: Locomotion; fn: (rt: AvatarRuntime, dt: number) => void }>();
  private seen = new WeakSet<SceneActor>();
  private tmp: Sample = { pos: V(), yaw: 0, sit: 0, seat: null, dist: 0, gait: 0, stride: 1, back: false };
  private rest = new Map<THREE.Object3D, { p: THREE.Vector3; vis: boolean }>();
  private fx: SpaceFx | null = null;
  private hazardMats: THREE.MeshStandardMaterial[] = [];
  private hooked: { mesh: THREE.Mesh; before: THREE.Mesh['onBeforeRender']; after: THREE.Mesh['onAfterRender'] }[] = [];
  private hazardNow = 0;
  private ray = new THREE.Raycaster();
  private camCache = new Map<number, CamPose>();
  private mode = 'talk';
  manualOwn = false;
  private clock = Date.now() / 1000;

  constructor(readonly room: RoomInfo, readonly info: SceneInfo | undefined, readonly inner: Inner) {
    this.lifts = parseLifts(room);
    this.nav = ((inner as unknown as { nav?: RoomNav }).nav) ?? new RoomNav(room);
    const X = (info ?? {}) as unknown as Record<string, unknown>;
    this.entranceBy = parseRoleStyles(X.entrance, null);
    this.exitBy = parseRoleStyles(X.exit, null);
    for (const L of this.lifts) for (const o of [L.node, ...L.hatches.map((h) => h.node)]) this.rest.set(o, { p: o.position.clone(), vis: o.visible });
    try {
      this.fx = new SpaceFx({ sprites: 96, smoke: this.lifts.some((L) => L.lid) ? 56 : 8, streaks: 12 }, false);   // (a lid's dust + dirt use the smoke pool)
      this.fx.uniforms.uMinPx.value = 0;
      this.fx.group.name = 'vtp:lift:fx';
      room.root.add(this.fx.group);
    } catch (e) { console.warn('lift: effects unavailable', e); this.fx = null; }
    this.hookHazard();
    this.drawLifts(this.now());
  }

  // ---------------------------------------------------------------- forwarding (space rooms: the wrapped SpaceMover)
  get manual() { return this.manualOwn; }
  set manual(v: boolean) { this.manualOwn = v; this.inner.manual = v; }
  get spaceState() { return this.inner.spaceState; }
  set spaceState(v: unknown) { this.inner.spaceState = v; }
  get sceneMode() { return this.mode; }
  set sceneMode(v: string) { this.mode = v; if ('sceneMode' in this.inner) this.inner.sceneMode = v; }
  spaceLaunches() { return this.inner.spaceLaunches?.() ?? []; }
  setMode(m: string) { this.mode = m; this.inner.setMode?.(m); }
  setScene(s: SceneState, actors?: () => Iterable<SceneActor>) { this.inner.setScene?.(s, actors); }
  cryoDebug() { return this.inner.cryoDebug?.() ?? null; }
  now() { return this.manualOwn ? this.clock : Date.now() / 1000; }

  // (walking machines — src/avatar/mech.ts — park instead of sitting and never ride a platform: the wrapped mover takes them)
  private styleIn(a: SceneActor) { return styleFor(this.entranceBy, a.key) === 'lift' && this.lifts.length > 0 && !a.isMech; }
  private styleOut(a: SceneActor) { return styleFor(this.exitBy, a.key) === 'lift' && this.lifts.length > 0 && !a.isMech; }
  /** LIFT_01 for the host; guests the others by seat (LIFT_01 when it is the only one). */
  private liftFor(a: SceneActor, spot: SpotInfo | null): number {
    const n = this.lifts.length;
    if (n <= 1 || a.key === '@host') return 0;
    return 1 + ((spot?.index ?? hash32(a.key) % 97) % (n - 1));
  }

  private layer(a: SceneActor) {
    let l = this.layers.get(a);
    if (!l) { const loco = new Locomotion(a); l = { loco, fn: (rt, dt) => loco.apply(rt, dt) }; this.layers.set(a, l); }
    a.extraPose = l.fn;
    return l;
  }
  private giveBack(a: SceneActor) { this.drop(a); this.inner.adopt?.(a); }
  /** Forget an actor's ride; a platform that was already on its way back (the rider stepped off) keeps going. */
  private drop(a: SceneActor) {
    const j = this.jobs.get(a);
    if (!j) return;
    this.jobs.delete(a);
    const t = this.now() - j.start;
    if (j.kind === 'enter' && t >= j.m.off && t < j.m.win1) this.tails.push(j);
    this.requeue(j.lift);
  }

  // ---------------------------------------------------------------- AvatarMover
  enter(actor: SceneActor, spot: SpotInfo, ev?: MoveEvent) {
    const at = typeof ev?.at === 'number' ? ev.at / 1000 : null;
    const mine = this.jobs.get(actor);
    const seen = this.seen.has(actor);
    this.seen.add(actor);
    const fromOutside = (ev?.from ?? -1) < 0;
    const hidden = mine ? !mine.shownAt(this.now() - mine.start) : !actor.shown && !this.inner.busy(actor);
    // frozen in a cryo pod (they went back into one): they thaw out of it instead of riding the lift
    const frozen = !mine && !!this.inner.claimsEnter?.(actor, ev);
    if (frozen || !this.styleIn(actor) || !fromOutside || (!seen && at === null) || !hidden) {
      if (mine) this.giveBack(actor);
      return this.inner.enter(actor, spot, ev);
    }
    this.inner.handOff?.(actor);
    const job = this.buildEnter(actor, spot, at ?? this.now(), -Infinity);
    job.at0 = at ?? this.now();
    this.register(job);
  }

  exit(actor: SceneActor, ev?: MoveEvent) {
    this.seen.add(actor);
    const at = typeof ev?.at === 'number' ? ev.at / 1000 : null;
    const mine = this.jobs.get(actor);
    if (!this.styleOut(actor)) { if (mine) this.giveBack(actor); return this.inner.exit(actor, ev); }
    let o: Origin;
    if (mine) {
      const t = this.now() - mine.start;
      if (!mine.shownAt(t)) { this.jobs.delete(actor); if (t < mine.m.win1) this.tails.push(mine); actor.shown = false; this.requeue(mine.lift); return; }
      const s = mine.sample(t, this.tmp);
      // still on the platform (rising, or already riding down): straight down from where it is
      const onLift = (mine.kind === 'enter' && t < mine.m.off - T_STEP) || (mine.kind === 'exit' && t >= mine.m.board + T_STEP) ? mine.lift : null;
      o = { pos: s.pos.clone(), yaw: s.yaw, sit: s.sit, seat: s.seat, onLift };
      this.drop(actor);
    } else {
      if (!actor.shown) { this.inner.handOff?.(actor); actor.shown = false; return; }
      this.inner.handOff?.(actor);
      const from = ev?.from ?? -1;
      const fs = from >= 0 ? this.room.spots[from] : null;
      if (fs && fs.position.distanceTo(actor.mount.position) < 0.05) o = { pos: fs.position.clone().setY(0), yaw: fs.yaw, sit: fs.pose === 'sit' ? 1 : 0, seat: fs.pose === 'sit' ? fs : null, onLift: null };
      else o = { pos: actor.mount.position.clone().setY(0), yaw: actor.mount.rotation.y, sit: actor.sit, seat: actor.spot, onLift: null };
    }
    const lift = o.onLift ?? this.liftFor(actor, actor.spot);
    const job = this.buildExit(actor, o, lift, at ?? this.now(), -Infinity);
    job.at0 = at ?? this.now();
    this.register(job);
  }

  move(actor: SceneActor, spot: SpotInfo, ev?: MoveEvent) {
    if (this.jobs.has(actor)) this.giveBack(actor);
    this.seen.add(actor);
    this.inner.move(actor, spot, ev);
  }

  busy(actor: SceneActor) { return this.jobs.has(actor) || this.inner.busy(actor); }
  release(actor: SceneActor) { this.drop(actor); this.inner.release?.(actor); }
  handOff(actor: SceneActor) { this.drop(actor); this.seen.add(actor); this.inner.handOff?.(actor); }
  adopt(actor: SceneActor) { this.giveBack(actor); this.seen.add(actor); }

  tracks(): MoverTrack[] {
    const now = this.now(), out = this.inner.tracks?.() ?? [];
    for (const [actor, j] of this.jobs) out.push({ actor, kind: j.kind, t: now - j.start, through: j.kind === 'enter' ? j.m.off : j.m.board, arrive: j.total });
    return out;
  }

  samplePath(actor: SceneActor, t: number): THREE.Vector3 | null {
    const j = this.jobs.get(actor);
    if (!j) return this.inner.samplePath?.(actor, t) ?? null;
    const p = j.sample(t, { pos: V(), yaw: 0, sit: 0, seat: null, dist: 0, gait: 0, stride: 1, back: false }).pos.clone();
    return p.setY(Math.max(0, p.y));
  }

  finishAll() { this.inner.finishAll(); this.step(); }

  dispose() {
    this.inner.dispose();
    for (const [a, l] of this.layers) if (a.extraPose === l.fn) { a.extraPose = null; a.loco = 0; }
    this.jobs.clear(); this.layers.clear(); this.tails = [];
    for (const [o, r] of this.rest) { o.position.copy(r.p); o.visible = r.vis; }
    for (const L of this.lifts) if (L.lid) { L.lid.node.position.copy(L.lid.restPos); L.lid.node.quaternion.copy(L.lid.restQuat); L.lid.last = [NaN, NaN]; }
    for (const h of this.hooked) { h.mesh.onBeforeRender = h.before; h.mesh.onAfterRender = h.after; }
    this.hooked = [];
    this.fx?.dispose();
    this.fx = null;
  }

  // ---------------------------------------------------------------- timelines
  private speed(actor: SceneActor) {
    const l = this.layer(actor).loco;
    const hRoom = (actor.rest?.height ?? 1.6) * actor.scale;
    return Math.max(0.35, Math.min(1.2 * THREE.MathUtils.clamp(hRoom / 1.5, 0.5, 1.8), l.maxSpeed()));
  }
  private walk(pts: THREE.Vector3[], v: number): Extract<Seg, { k: 'walk' }> | null {
    const clean: THREE.Vector3[] = [];
    for (const p of pts) if (!clean.length || clean[clean.length - 1].distanceTo(p) > 0.08) clean.push(p.clone().setY(0));
    if (clean.length < 2) return null;
    const path = new WalkPath(clean);
    if (path.length < 0.05) return null;
    let vv = v;
    if (path.length < (vv * (ACCEL + DECEL)) / 2) vv = (2 * path.length) / (ACCEL + DECEL);
    return { k: 'walk', dur: path.length / vv + (ACCEL + DECEL) / 2, path, v: vv, ta: ACCEL, td: DECEL };
  }
  /** Travel depth for a rider: the authored depth, deeper for a tall avatar (never pokes through the closed hatch). */
  private depthFor(actor: SceneActor, L: LiftInfo) { return Math.max(L.depth, (actor.rest?.height ?? 1.6) * actor.scale + 0.12); }
  private turnTo(segs: Seg[], pos: THREE.Vector3, y0: number, y1: number, min = 0.2) { if (Math.abs(wrap(y1 - y0)) > 0.05) segs.push({ k: 'turn', dur: min + Math.abs(wrap(y1 - y0)) / TURN_RATE, pos: pos.clone(), y0, y1 }); }

  /** gate = absolute time the platform may be used from (the rider before on this lift is done). */
  private buildEnter(actor: SceneActor, spot: SpotInfo, at: number, gate: number): Job {
    const li = this.liftFor(actor, spot), L = this.lifts[li];
    const start = Math.max(at, gate);
    const hatch = L.hatches.length > 0;
    const depth = this.depthFor(actor, L);
    const lidT = L.lid ? L.lid.open : 0;                 // (a coffin lid: opens after the rise, shuts after they step off)
    const segs: Seg[] = [];
    const topP = L.top.clone();
    // below the floor (hatch opening / the empty platform dropping), then the rise
    segs.push({ k: 'ride', dur: T_OPEN + T_RISE, pos: topP, yaw: L.yawOut, up: true, wait: T_OPEN, depth });
    segs.push({ k: 'hold', dur: lidT + T_PAUSE, pos: topP.clone(), yaw: L.yawOut, sit: 0, seat: null });
    const out = L.out.clone();
    segs.push({ k: 'step', dur: T_STEP, from: topP.clone(), to: out, yaw: L.yawOut });
    const off = T_OPEN + T_RISE + lidT + T_PAUSE + T_STEP;
    // to the spot over the room's lanes (+ the spot's approach points)
    const route = this.nav.fromPoint(out, false, spot);
    const w = this.walk([out, ...route.slice(1)], this.speed(actor));
    let pos = out.clone(), yaw = L.yawOut;
    if (w) { this.turnTo(segs, out, yaw, w.path.heading(0)); segs.push(w); pos = w.path.at(w.path.length); yaw = w.path.heading(w.path.length); }
    this.turnTo(segs, pos, yaw, spot.yaw, 0.25);
    if (spot.pose === 'sit') segs.push({ k: 'sit', dur: SIT_TIME, from: pos.clone(), to: spot.position.clone().setY(0), yaw: spot.yaw, s0: 0, s1: 1, seat: spot });
    else segs.push({ k: 'hold', dur: 0.5, pos: spot.position.clone().setY(0), yaw: spot.yaw, sit: 0, seat: null });
    const job = new Job(actor, 'enter', start, segs, spot, li, hash32(actor.key, Math.round(start * 10), 'lift'), null, depth);
    job.gate = gate;
    const wi = w ? segs.indexOf(w) : -1;
    job.m = {
      win0: 0, win1: hatch ? off + 0.2 + lidT + T_SINK + T_CLOSE : off + (lidT ? LID_GAP + lidT : 0), off, board: 0, down: 0,
      walk0: wi >= 0 ? job.starts[wi] : off, walk1: wi >= 0 ? job.starts[wi] + w!.dur : off,
      shown0: hatch ? 0 : T_OPEN * 0.9, hatch,
      lid: lidT, lid0: T_OPEN + T_RISE, lid1: off + LID_GAP,
      puffs: lidT ? [{ t: T_OPEN + 0.05, s: 0.7 }, { t: T_OPEN + T_RISE * 0.9, s: 1 }, { t: T_OPEN + T_RISE + lidT, s: 0.4 }, { t: off + LID_GAP + lidT, s: 0.8 }] : [],
    };
    return job;
  }

  private buildExit(actor: SceneActor, o: Origin, li: number, at: number, gate: number): Job {
    const L = this.lifts[li];
    const hatch = L.hatches.length > 0;
    const depth = this.depthFor(actor, L);
    const lidT = L.lid ? L.lid.open : 0;
    const segs: Seg[] = [];
    const topP = L.top.clone();
    const prep = (hatch ? T_OPEN + T_SINK : 0) + lidT;       // hatch open + the empty platform up (+ the lid open), before they can board
    if (o.onLift === li) {
      // still on the platform (their entrance was cut short): straight back down from where it is
      const below = Math.max(0, topP.y - o.pos.y);
      const left = Math.max(0.05, depth - below);
      const p0 = o.pos.clone();
      segs.push({ k: 'hold', dur: 0.2, pos: p0, yaw: o.yaw, sit: 0, seat: null });
      segs.push({ k: 'ride', dur: T_DESC * Math.max(0.25, left / depth), pos: p0.clone(), yaw: o.yaw, up: false, wait: 0, depth: left });
      const job = new Job(actor, 'exit', at, segs, null, li, hash32(actor.key, Math.round(at * 10), 'liftx'), o, depth);
      job.gate = gate;
      job.m = { win0: 0, win1: job.total + (hatch ? T_CLOSE : 1 + T_SINK), off: 0, board: 0, down: job.total, walk0: 0, walk1: 0, shown0: 0, hatch, ...NO_LID };   // (a cut-short entrance: the lid is shut again at once)
      return job;
    }
    let p = o.pos.clone(), yaw = o.yaw;
    if (o.sit > 0.01 && o.seat) {
      const T = this.nav.standPoint(o.seat);
      const to = p.clone().lerp(T, o.sit);
      segs.push({ k: 'sit', dur: SIT_TIME * o.sit, from: p, to, yaw, s0: o.sit, s1: 0, seat: o.seat });
      p = to;
    }
    // the room's lanes from the lift to where they are, walked backwards (starting at their feet)
    const back = this.nav.fromPoint(L.out, false, o.seat ?? actor.spot).reverse();
    const pts = back.length > 1 ? [p, ...back.slice(1, -1), L.out.clone()] : [p, L.out.clone()];
    const w = this.walk(pts, this.speed(actor));
    if (w) { this.turnTo(segs, p, yaw, w.path.heading(0)); segs.push(w); yaw = w.path.heading(w.path.length); p = w.path.at(w.path.length); }
    const faceIn = wrap(L.yawOut + Math.PI);
    this.turnTo(segs, p, yaw, faceIn);
    let arrive = segs.reduce((s, x) => s + x.dur, 0);
    // wait at the lift until the platform is up (and the rider before them is done)
    const need = Math.max(prep, gate - at + prep);
    if (arrive < need) { segs.push({ k: 'hold', dur: need - arrive, pos: p.clone(), yaw: faceIn, sit: 0, seat: null }); arrive = need; }
    const board = arrive;
    segs.push({ k: 'step', dur: T_STEP, from: p.clone(), to: topP.clone(), yaw: faceIn });
    segs.push({ k: 'turn', dur: T_TURN_ON, pos: topP.clone(), y0: faceIn, y1: L.yawOut });
    segs.push({ k: 'ride', dur: T_DESC + 0.2 + lidT, pos: topP.clone(), yaw: L.yawOut, up: false, wait: 0.2 + lidT, depth });   // (the lid shuts in the wait)
    const job = new Job(actor, 'exit', at, segs, null, li, hash32(actor.key, Math.round(at * 10), 'liftx'), o, depth);
    job.gate = gate;
    const wi = w ? segs.indexOf(w) : -1;
    const down = job.total;
    const shut = board + T_STEP + T_TURN_ON;
    job.m = {
      win0: board - prep, win1: down + (hatch ? T_CLOSE : 1 + T_SINK), off: 0, board, down, walk0: wi >= 0 ? job.starts[wi] : 0, walk1: wi >= 0 ? job.starts[wi] + w!.dur : 0, shown0: 0, hatch,
      lid: lidT, lid0: board - lidT, lid1: shut,
      puffs: lidT ? [...(hatch ? [{ t: board - lidT, s: 0.8 }] : []), { t: board, s: 0.4 }, { t: shut + lidT, s: 0.8 }] : [],
    };
    return job;
  }

  /** Add a job and re-time the queue on its platform. */
  private register(job: Job) {
    this.jobs.set(job.actor, job);
    this.requeue(job.lift);
    const j = this.jobs.get(job.actor);
    if (j) this.apply(j.actor, j, this.now() - j.start);
  }

  /** One rider per platform: jobs on a lift in (stamp, key) order, each platform window after the one before (a finished
   *  ride whose platform is still sinking counts too). The same set of stamps gives the same timings on every page. */
  private requeue(li: number) {
    let free = -Infinity;
    for (const t of this.tails) if (t.lift === li) free = Math.max(free, t.start + t.m.win1);
    const q = [...this.jobs.values()].filter((j) => j.lift === li).sort((a, b) => a.at0 - b.at0 || a.actor.key.localeCompare(b.actor.key));
    for (const j of q) {
      let nj = j;
      if (j.gate !== free) {
        const b = j.kind === 'enter' && j.target ? this.buildEnter(j.actor, j.target, j.at0, free) : j.origin ? this.buildExit(j.actor, j.origin, li, j.at0, free) : null;
        if (b) { b.at0 = j.at0; this.jobs.set(j.actor, b); nj = b; }
      }
      free = Math.max(free, nj.start + nj.m.win1);
    }
  }

  // ---------------------------------------------------------------- per frame
  update(dt: number) {
    if (this.manualOwn) {
      this.clock += dt;
      // (the wrapped mover advances its own manual clock by dt in its update: keep them together)
      if (typeof this.inner.clock === 'number') this.inner.clock = this.clock - dt;
    } else this.clock = Date.now() / 1000;
    this.inner.update(dt);
    this.step();
  }

  private step() {
    const now = this.now();
    this.tails = this.tails.filter((j) => now - j.start < j.m.win1 + 0.1);
    for (const [a, j] of [...this.jobs]) {
      if (!a.runtime) { this.jobs.delete(a); continue; }
      const t = now - j.start;
      this.apply(a, j, Math.min(t, j.total));
      if (t >= j.total) {
        // the rider is done (seated / gone); the platform may still be sinking back: that part is the lift's
        this.jobs.delete(a);
        if (t < j.m.win1) this.tails.push(j);
        if (j.kind === 'enter') this.inner.adopt?.(a);
        else { a.shown = false; a.loco = 0; }
      }
    }
    this.drawLifts(now);
  }

  private apply(a: SceneActor, j: Job, t: number) {
    const l = this.layer(a).loco;
    const s = j.sample(t, this.tmp);
    a.mount.position.copy(s.pos);
    a.mount.rotation.set(0, s.yaw, 0);
    a.sit = s.sit;
    a.shown = j.shownAt(t);
    a.appear = 1;
    a.updateSeat(s.seat ?? (s.sit > 0 ? j.target : null) ?? a.spot);
    if (t >= j.total) a.updateSeat();
    l.dist = s.dist; l.gait = s.gait; l.back = s.back; l.stride = s.stride; l.idle = 0;
    a.loco = s.gait;
    const walking = t >= j.m.walk0 - ARM_BLEND && t <= j.m.walk1 + ARM_BLEND && j.m.walk1 > j.m.walk0;
    l.armW = walking ? Math.min(smooth((t - j.m.walk0 + ARM_BLEND) / ARM_BLEND), 1 - smooth((t - j.m.walk1) / ARM_BLEND)) : 0;
    l.headW = 0.5 * l.armW;
  }

  /** The platform / hatch / light of one lift right now. */
  private view(li: number, now: number): LiftView {
    const L = this.lifts[li];
    const hatch = L.hatches.length > 0;
    const restY = hatch ? -L.depth : 0;
    let best: Job | null = null;
    for (const j of [...this.jobs.values(), ...this.tails]) {
      if (j.lift !== li) continue;
      const t = now - j.start;
      if (t < j.m.win0 - 1e-3 || t > j.m.win1 + 0.05) continue;
      if (!best || j.start + j.m.win0 > best.start + best.m.win0) best = j;
    }
    if (!best) return { y: restY, hatch: 0, column: 0, hazard: 0, lid: 0, job: null, t: 0 };
    const j = best, t = now - j.start, m = j.m, D = j.depth;
    let y = restY, h = 0, column = 0;
    if (j.kind === 'enter') {
      const riseT = t - T_OPEN;
      if (hatch) {
        const sink0 = m.off + 0.2 + m.lid;                      // (with a lid: it is shut first)
        h = smooth(t / T_OPEN) * (1 - smooth((t - (sink0 + T_SINK)) / T_CLOSE));
        y = riseT <= 0 ? -D : riseT < T_RISE ? riseY(riseT / T_RISE, D) : t > sink0 ? -L.depth * easeInOut((t - sink0) / T_SINK) : 0;
      } else {
        y = riseT <= 0 ? -D * easeInOut(t / T_OPEN) : riseT < T_RISE ? riseY(riseT / T_RISE, D) : 0;
      }
      column = smooth((riseT + 0.3) / 0.5) * (1 - smooth((riseT - T_RISE + 0.1) / 0.6));
    } else {
      const ride = j.segs[j.segs.length - 1] as Extract<Seg, { k: 'ride' }>;
      const d0 = m.down - (ride.dur - ride.wait);             // descent start
      const onLift = j.origin?.onLift === li;
      // riding down: the platform is under their feet
      const riding = t >= d0 ? j.sample(Math.min(t, m.down), this.tmp).pos.y - L.top.y : 0;
      if (hatch) {
        const up0 = m.board - m.lid - T_SINK;                  // the empty platform comes up for them (then the lid opens)
        h = (onLift ? 1 : smooth((t - m.win0) / T_OPEN)) * (1 - smooth((t - m.down) / T_CLOSE));
        y = onLift ? (t < m.down ? j.sample(t, this.tmp).pos.y - L.top.y : -L.depth)
          : t < up0 ? -L.depth : t < m.board - m.lid ? -L.depth * (1 - easeInOut((t - up0) / T_SINK)) : t < d0 ? 0 : t < m.down ? riding : -L.depth;
      } else {
        const back0 = m.down + 1;
        y = onLift && t < m.down ? j.sample(t, this.tmp).pos.y - L.top.y
          : t < d0 ? 0 : t < m.down ? riding : t < back0 ? -D : -D * (1 - easeInOut((t - back0) / T_SINK));
      }
      column = smooth((t - d0 + 0.2) / 0.4) * (1 - smooth((t - m.down) / 0.5));
    }
    const hazard = t >= m.win0 - 0.2 && t <= m.win1 ? 1 - smooth((t - m.win1 + 0.4) / 0.4) : 0;
    // the coffin lid: swings open at lid0, shut again from lid1 (one `lid` seconds each)
    const lid = m.lid > 0 ? smooth((t - m.lid0) / m.lid) * (1 - smooth((t - m.lid1) / m.lid)) : 0;
    return { y, hatch: h, column, hazard, lid, job: j, t };
  }

  private drawLifts(now: number) {
    const fx = this.fx;
    fx?.begin(now);
    let hz = 0;
    this.lifts.forEach((L, i) => {
      const v = this.view(i, now);
      hz = Math.max(hz, v.hazard);
      this.placeNode(L.node, V(0, v.y, 0));
      for (const hch of L.hatches) this.placeNode(hch.node, PO.copy(hch.open).multiplyScalar(v.hatch));
      if (L.lid) this.placeLid(L.lid, v.lid, v.y);
      if (!fx) return;
      const top = L.top;
      const r = Math.max(L.hw, L.hd);
      // a warm column of light out of the shaft while someone rides
      if (v.column > 0.01) {
        const y0 = top.y + v.y - 0.2, y1 = top.y + 2.6;
        const a = v.column * (L.hatches.length ? Math.max(0.35, v.hatch) : 1);
        const c = top.clone();
        fx.line(c.clone().setY(y1), c.clone().setY(y0), r * 0.95, 0, 1.0, 0.45, 0.08, 0.34 * a, false);
        fx.line(c.clone().setY(top.y + 1.7), c.clone().setY(y0), r * 0.55, 0, 1.15, 0.6, 0.16, 0.42 * a, false);
        fx.line(c.clone().setY(top.y + 0.9), c.clone().setY(y0), r * 0.22, 0, 1.3, 0.88, 0.45, 0.45 * a, false);
        fx.sprite(c.clone().setY(top.y + 0.04), r * 1.25, 1.0, 0.48, 0.1, 0.4 * a, SPRITE.glow, 0.2);
      }
      // hazard beacons at the hatch corners (rooms without EMIT_lift materials)
      if (v.hazard > 0.01 && !this.hazardMats.length) {
        const pulse = 0.5 + 0.5 * Math.sin(now * Math.PI * 2 * HAZARD_HZ);
        for (const s of [-1, 1]) {
          const p = top.clone().addScaledVector(L.right, s * (L.hw + 0.12)).addScaledVector(L.fwd, L.hd + 0.12).setY(top.y + 0.06);
          fx.sprite(p, 0.1 + 0.08 * pulse, 1.4, 0.62, 0.08, v.hazard * (0.35 + 0.65 * pulse), SPRITE.flare, s);
          fx.sprite(p, 0.35, 1.0, 0.45, 0.05, v.hazard * 0.25 * pulse, SPRITE.glow, s + 2);
        }
      }
      // sparks off the hatch rim while the platform grinds up / down
      const j = v.job;
      if (j && v.column > 0.05) {
        const rnd = new Rng(j.seed);
        const rs = j.segs[j.kind === 'enter' ? 0 : j.segs.length - 1] as Extract<Seg, { k: 'ride' }>;
        const t0 = j.kind === 'enter' ? T_OPEN : j.m.down - (rs.dur - rs.wait);
        const tt = v.t - t0;
        for (let s = 0; s < 26; s++) {
          const born = rnd.range(0, T_RISE * 0.9), life = rnd.range(0.45, 1.0);
          const edge = rnd.next() * 4, u = rnd.range(-1, 1);
          const side = Math.floor(edge);
          const vx = rnd.range(0.4, 1.3), vy = rnd.range(1.1, 2.4), seed = rnd.next();
          const age = tt - born;
          if (age < 0 || age > life) continue;
          const lx = side === 0 ? -L.hw : side === 1 ? L.hw : u * L.hw, lz = side === 2 ? -L.hd : side === 3 ? L.hd : u * L.hd;
          const outDir = V(side === 0 ? -1 : side === 1 ? 1 : 0, 0, side === 2 ? -1 : side === 3 ? 1 : 0);
          const p = top.clone().addScaledVector(L.right, lx + outDir.x * vx * age).addScaledVector(L.fwd, lz + outDir.z * vx * age);
          p.y = top.y + 0.02 + vy * age - 4.9 * age * age;
          if (p.y < top.y - 0.05) continue;
          fx.sprite(p, 0.034, 1.8, 1.05, 0.4, (1 - age / life), SPRITE.spark, seed);
          fx.sprite(p, 0.09, 1.2, 0.55, 0.12, (1 - age / life) * 0.3, SPRITE.glow, seed + 1);
        }
      }
      if (j && L.lid) this.dust(fx, L, j, v.t);
    });
    this.hazardNow = hz;
    if (fx) { fx.end(); fx.group.visible = fx.counts().sprites + fx.counts().streaks > 0; }
  }

  /** Turn a coffin lid about its hinge edge: `k` = 0 shut … 1 open; `lift` = how far the platform is below its top (only a lid
   *  that is not a child of the platform has to follow it by hand). */
  private placeLid(lid: LidInfo, k: number, lift: number) {
    if (lid.last[0] === k && lid.last[1] === lift) return;          // idle and unchanged (the views are exact at rest)
    lid.last[0] = k; lid.last[1] = lift;
    const o = lid.node;
    const q = SQ.setFromAxisAngle(lid.axis, lid.angle * k);
    const pos = SP.copy(lid.restPos).sub(lid.pivot).applyQuaternion(q).add(lid.pivot);
    if (!lid.child && Math.abs(lift) > 1e-9 && o.parent) {
      o.parent.updateWorldMatrix(true, false);
      const w = o.parent.localToWorld(SW.copy(pos));
      w.y += lift;
      pos.copy(o.parent.worldToLocal(w));
    }
    o.position.copy(pos);
    o.quaternion.copy(q).multiply(lid.restQuat);
  }

  /** Dirt clods + dust (the smoke pool) round the platform's rim at each thud of a coffin lift; deterministic from the job. */
  private dust(fx: SpaceFx, L: LiftInfo, j: Job, t: number) {
    const top = L.top;
    j.m.puffs.forEach((e, i) => {
      const age = t - e.t;
      if (age < 0 || age > DUST_S) return;
      const rnd = new Rng(hash32(j.seed, i, 'dust'));
      const ramp = Math.min(1, age / 0.1), fade = 1 - age / DUST_S;
      const n = Math.round(4 + 6 * e.s);
      for (let k = 0; k < n; k++) {
        const a = rnd.range(0, Math.PI * 2), r = rnd.range(0.55, 1), sp = rnd.range(0.25, 0.75), sz = rnd.range(0.7, 1.3), seed = rnd.next();
        const ca = Math.cos(a), sa = Math.sin(a);
        SD.copy(L.right).multiplyScalar(ca).addScaledVector(L.fwd, sa);
        const p = SP.copy(top).addScaledVector(SD, (L.hw * ca * ca + L.hd * sa * sa) * r + sp * age).setY(top.y + 0.04 + 0.28 * age * (0.5 + seed));
        fx.puff(p, (0.1 + 0.2 * age) * sz * (0.6 + 0.5 * e.s), 0.34, 0.29, 0.25, 0.42 * ramp * fade * Math.min(1, 0.4 + e.s), seed);
      }
      // dirt clods thrown up off the rim (ballistic), the harder the thud the more
      for (let k = 0, m = Math.round(2 + 5 * e.s); k < m; k++) {
        const a = rnd.range(0, Math.PI * 2), vx = rnd.range(0.4, 1.4), vy = rnd.range(1.3, 2.6), seed = rnd.next();
        SD.copy(L.right).multiplyScalar(Math.cos(a)).addScaledVector(L.fwd, Math.sin(a));
        const p = SP.copy(top).addScaledVector(SD, Math.max(L.hw, L.hd) * 0.85 + vx * age).setY(top.y + 0.03 + vy * age - 4.9 * age * age);
        if (p.y < top.y) continue;
        fx.puff(p, rnd.range(0.025, 0.05), 0.16, 0.11, 0.08, 0.95 * fade, seed);
      }
    });
  }

  /** Move a node by a world-space offset from where it rests (authored), whatever its parent. */
  private placeNode(o: THREE.Object3D, off: THREE.Vector3) {
    const r = this.rest.get(o);
    if (!r) return;
    if (off.lengthSq() < 1e-10 || !o.parent) { o.position.copy(r.p); return; }
    o.parent.updateWorldMatrix(true, false);
    const wp = o.parent.localToWorld(PN.copy(r.p)).add(off);
    o.position.copy(o.parent.worldToLocal(wp));
  }

  /** EMIT_lift* materials pulse amber while a lift runs — only while those meshes draw, restored right after, so the
   *  light engine never sees it. */
  private hookHazard() {
    const self = this;
    this.room.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).filter((m): m is THREE.MeshStandardMaterial => !!m && /^EMIT_lift/i.test(m.name) && (m as THREE.MeshStandardMaterial).isMeshStandardMaterial);
      if (!mats.length) return;
      for (const m of mats) if (!this.hazardMats.includes(m)) this.hazardMats.push(m);
      const before = mesh.onBeforeRender, after = mesh.onAfterRender;
      let undo: (() => void) | null = null;
      mesh.onBeforeRender = function (...args) {
        before.apply(this, args);
        const k = self.hazardNow;
        if (k < 0.01) return;
        const pulse = 0.5 + 0.5 * Math.sin(self.now() * Math.PI * 2 * HAZARD_HZ);
        const saved = mats.map((m) => ({ m, e: m.emissive.clone(), i: m.emissiveIntensity }));
        for (const m of mats) { m.emissive.lerp(new THREE.Color(1, 0.55, 0.05), k); m.emissiveIntensity = Math.max(m.emissiveIntensity * (1 - k), (0.25 + 3.2 * pulse) * k); }
        undo = () => { for (const s of saved) { s.m.emissive.copy(s.e); s.m.emissiveIntensity = s.i; } };
      };
      mesh.onAfterRender = function (...args) { undo?.(); undo = null; after.apply(this, args); };
      this.hooked.push({ mesh, before, after });
    });
  }

  // ---------------------------------------------------------------- camera
  followCamera(fo: SceneState['follow'], aspect: number, present: (a: SceneActor) => boolean): { key: string; pose: CamPose; secs: number } | null | undefined {
    const now = this.now();
    let best: { j: Job; t: number } | null = null;
    for (const j of this.jobs.values()) {
      const t = now - j.start;
      if (!(j.actor.key === '@host' ? fo.host : fo.guests)) continue;
      if (j.kind === 'enter' && (t < 0 || t > j.m.off + 0.3 || !present(j.actor))) continue;
      if (j.kind === 'exit' && (this.mode === 'react' || t < j.m.board - 0.6 || t > j.m.down + 0.6)) continue;
      if (!best || t > best.t) best = { j, t };
    }
    if (best) {
      const pose = this.liftCam(best.j.lift), [sx, sy] = liftShake(best.j.m.puffs, best.t);
      // (a coffin lift: a creak + thud shake on the shot, at most 2 cm; the cached pose itself is never touched)
      if (!sx && !sy) return { key: `lift:${this.lifts[best.j.lift].name}`, pose, secs: 0 };
      const shaken: CamPose = { position: pose.position.clone().addScaledVector(V(1, 0, 0).applyQuaternion(pose.quaternion), sx).addScaledVector(V(0, 1, 0).applyQuaternion(pose.quaternion), sy), quaternion: pose.quaternion, fov: pose.fov };
      return { key: `lift:${this.lifts[best.j.lift].name}`, pose: shaken, secs: 0 };
    }
    return this.inner.followCamera?.(fo, aspect, present);
  }

  /** CAM_LIFT(_xx), else CAM_WIDE's position when it sees the lift, else a shot in front of it (pulled in off walls). */
  liftCam(li: number): CamPose {
    const hit = this.camCache.get(li);
    if (hit) return hit;
    const L = this.lifts[li];
    let pose: CamPose;
    const target = L.top.clone().add(V(0, 1.05, 0));
    const skip = new Set<THREE.Object3D>([L.node, ...L.hatches.map((h) => h.node)]);
    const occ = this.room.occluders.filter((m) => { for (let o: THREE.Object3D | null = m; o; o = o.parent) if (skip.has(o)) return false; return true; });
    const clear = (a: THREE.Vector3, b: THREE.Vector3) => {
      const d = b.clone().sub(a), len = d.length();
      if (len < 1e-3) return true;
      this.ray.set(a, d.normalize()); this.ray.far = len - 0.3;
      return !this.ray.intersectObjects(occ, false).length;
    };
    if (L.cam) pose = { position: L.cam.position.clone(), quaternion: L.cam.quaternion.clone(), fov: L.cam.fov };
    else {
      const wide = this.room.cameras.get(String(this.info?.defaultCamera ?? 'CAM_WIDE')) ?? this.room.cameras.get('CAM_WIDE') ?? null;
      const dw = wide ? wide.position.distanceTo(target) : Infinity;
      if (wide && dw < 14 && dw > 1.5 && clear(wide.position, target)) {
        pose = lookPose(wide.position, target, THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(1.5 / dw)), 18, 55));
      } else {
        let pos = L.top.clone().addScaledVector(L.fwd, 3.4).setY(L.top.y + 1.6);
        const d = pos.clone().sub(target), len = d.length();
        this.ray.set(target, d.normalize()); this.ray.far = len;
        const h = this.ray.intersectObjects(occ, false).find((x) => x.distance > 0.3);
        if (h) pos = target.clone().addScaledVector(d, Math.max(0.9, h.distance - 0.2));
        const dist = pos.distanceTo(target);
        pose = lookPose(pos, target, THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(1.5 / dist)), 30, 70));
      }
    }
    this.camCache.set(li, pose);
    return pose;
  }

  /** Debug (test pages): lifts, jobs, what each platform shows. */
  debug() {
    const now = this.now();
    return {
      lifts: this.lifts.map((L, i) => ({ name: L.name, depth: L.depth, hatches: L.hatches.map((h) => h.node.name), out: L.out.toArray().map((x) => +x.toFixed(2)), cam: L.cam?.name ?? null, lid: L.lid ? { node: L.lid.node.name, hinge: L.lid.hinge, lying: L.lid.lying, deg: +THREE.MathUtils.radToDeg(L.lid.angle).toFixed(1), open: L.lid.open, child: L.lid.child } : null, view: (({ job, ...v }) => ({ ...v, rider: job?.actor.key ?? null }))(this.view(i, now)) })),
      jobs: [...this.jobs.values()].map((j) => ({ key: j.actor.key, kind: j.kind, lift: j.lift, t: +(now - j.start).toFixed(2), total: +j.total.toFixed(2), m: j.m })),
      entrance: this.entranceBy, exit: this.exitBy,
    };
  }
}

/** Rooms whose scene.json uses the lift for a role and that have a LIFT_xx node. */
export function roomWantsLift(room: RoomInfo, info: SceneInfo | null | undefined): boolean {
  const X = (info ?? {}) as unknown as Record<string, unknown>;
  if (!usesStyle(parseRoleStyles(X.entrance), 'lift') && !usesStyle(parseRoleStyles(X.exit), 'lift')) return false;
  let found = false;
  room.root.traverse((o) => { if (!found && /^LIFT_\d+$/.test(o.name)) found = true; });
  return found;
}

// ------------------------------------------------------------------------------------------------ install
// Wraps whatever mover the room gets today (WalkMover / SpaceMover) — only in rooms that use the lift, so every other
// room keeps exactly the mover it had. Import AFTER src/scene/space/spaceMover.ts (output.ts).
const prev = currentMoverFactory();
setMoverFactory((room, info) => {
  const inner = prev(room, info);
  try { if (roomWantsLift(room, info)) return new LiftMover(room, info, inner as Inner); } catch (e) { console.warn('lift mover failed, regular entrances', e); }
  return inner;
});
