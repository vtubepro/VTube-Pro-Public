// WalkMover: the real entrances / exits / spot changes (replaces the PopMover placeholder).
//
//   enter  DOOR_OUTSIDE → the door opens (0.6 s ease) → walk the PATH_* chain → the spot's approach points →
//          in front of the seat → turn → back up + sit down (0.8 s, blending into the engine's seated pose) /
//          stand spots: turn to the spot's facing and settle into an idle weight shift.
//   exit   stand up → walk to the door (it opens as they get there) → out → the door closes → hidden.
//   move   stand up → walk to the new spot (neighbouring seats directly, else via the room's lanes) → sit.
//
// DETERMINISTIC: every walk is a pure function of (room data, avatar, start spot, target spot, start time).
// The host stamps each change as SceneState.moves[key] = { from, to, at } (src/scene/controller.ts), every page
// (studio preview, OBS, guests' OBS) builds the same timeline from it and samples it at wall-clock time, so
// they all show the same walk and a late-joining page lands mid-walk (or snaps if it is over). Changes with no
// event (older hosts) are animated from "now"; the first time a page sees someone, without an event, it snaps.
// Door arrivals are staggered by the host (1.2 s apart) so a queue walks in single file, and the door stays
// open while the queue passes (the door is open while ANY walker's door window is).
//
// Pose: src/scene/locomotion.ts (the actor's extraPose) — walk cycle / hop, arm swing, head damping.
import * as THREE from 'three';
import type { SceneActor } from './actor.ts';
import type { RoomInfo, SpotInfo } from './contract.ts';
import { Locomotion } from './locomotion.ts';
import { setMoverFactory, type AvatarMover, type MoveEvent, type MoverTrack } from './mover.ts';
import { RoomNav, WalkPath } from './navigation.ts';
import { floorsOf, type RoomFloors } from './floors.ts';
import type { GaitFamily } from '../../shared/gait.ts';
import { MechGrid, staticRaysOf, type StaticRays } from './mechNav.ts';

const DOOR_EASE = 0.6;       // s, hinge open / close
const DOOR_STAGGER = 1.2;    // s between walkers through the door (local fallback; the host schedules it)
const SIT_TIME = 0.8;        // s, stand ↔ sit
const ARM_BLEND = 0.4;       // s, tracked arms back in after arriving
const ACCEL = 0.45, DECEL = 0.55;
const TURN_RATE = 3.4;       // rad/s
const QUEUE_GAP = 1.15;     // m between walkers in a door queue
const TURN_STEP = 0.3;       // m of "stride" per radian turned on the spot (stepping while turning)

const smooth = (v: number) => { const k = v < 0 ? 0 : v > 1 ? 1 : v; return k * k * (3 - 2 * k); };
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const V = () => new THREE.Vector3();

type Seg =
  | { k: 'hold'; dur: number; pos: THREE.Vector3; yaw: number; sit: number; seat: SpotInfo | null }
  | { k: 'turn'; dur: number; pos: THREE.Vector3; y0: number; y1: number }
  | { k: 'walk'; dur: number; path: WalkPath; v: number; ta: number; td: number; gm?: GaitMap; rev?: boolean }
  | { k: 'sit'; dur: number; from: THREE.Vector3; to: THREE.Vector3; yaw: number; s0: number; s1: number; seat: SpotInfo }
  | { k: 'pop'; dur: number; pos: THREE.Vector3; yaw: number; a0: number; a1: number };

interface Sample {
  pos: THREE.Vector3; yaw: number; sit: number; seat: SpotInfo | null; shown: boolean; appear: number;
  dist: number; gait: number; stride: number; back: boolean; outside: boolean; armW: number;
  /** Walking machines: the gait family of this segment (walks: the job's; turns / holds: walk). */
  family?: GaitFamily | null;
}

type Start =
  | { k: 'door' }
  | { k: 'spot'; spot: SpotInfo }
  | { k: 'point'; pos: THREE.Vector3; yaw: number; sit: number; seat: SpotInfo | null; outside: boolean };

/** A leg of a walk (walking machines may have three: straight out of a tight parking place, the route, backing in). */
interface MechLeg { pts: THREE.Vector3[]; rev?: boolean; main?: boolean }

/** Trapezoid speed profile along a walk segment. */
/** Walking machines (src/avatar/mech.ts): distance along a walk as their OUTERMOST foot travels it, tabulated: path length
 *  + turnStep (Locomotion.turnStep: the footprint radius, more for legs with narrow ranges) x the heading change. A walk's
 *  speed profile runs on this distance, so the body slows
 *  through corners while the legs keep their pace, and a planted foot is never dragged further than a straight stride
 *  (the gait's phase is this distance). Pure: every page builds the same table from the same path. */
export class GaitMap {
  readonly s: Float64Array;
  readonly g: Float64Array;
  /** Total gait distance (room metres). */
  readonly G: number;
  constructor(path: WalkPath, turnStep: number) {
    const L = path.length, n = Math.max(2, Math.min(4096, Math.ceil(L / 0.02) + 1));
    this.s = new Float64Array(n); this.g = new Float64Array(n);
    let h0 = path.heading(0);
    for (let i = 1; i < n; i++) {
      const s = (L * i) / (n - 1), h = path.heading(s);
      this.s[i] = s;
      this.g[i] = this.g[i - 1] + (s - this.s[i - 1]) + Math.max(0, turnStep) * Math.abs(wrap(h - h0));
      h0 = h;
    }
    this.G = this.g[n - 1];
  }
  private static lerp(xs: Float64Array, ys: Float64Array, x: number) {
    const n = xs.length;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
    const d = xs[hi] - xs[lo];
    return ys[lo] + (d > 1e-12 ? (x - xs[lo]) / d : 0) * (ys[hi] - ys[lo]);
  }
  /** Gait distance at path arc length s. */
  gOf(s: number) { return GaitMap.lerp(this.s, this.g, s); }
  /** Path arc length at gait distance g. */
  sOf(g: number) { return GaitMap.lerp(this.g, this.s, g); }
}

/** The walk's trapezoid speed profile: travelled distance `g` (path metres; walking machines: gait metres, GaitMap), the
 *  path arc length `s` there, and the speed `v` (same units as g). */
function walkS(sg: Extract<Seg, { k: 'walk' }>, t: number): { s: number; g: number; v: number } {
  const { v, ta, td, dur } = sg, L = sg.gm ? sg.gm.G : sg.path.length;
  const o = (g: number, vv: number) => ({ s: sg.gm ? sg.gm.sOf(g) : g, g, v: vv });
  if (t <= 0) return o(0, 0);
  if (t >= dur) return o(L, 0);
  if (t < ta) return o((v * t * t) / (2 * ta), (v * t) / ta);
  if (t > dur - td) { const r = dur - t; return o(L - (v * r * r) / (2 * td), (v * r) / td); }
  return o((v * ta) / 2 + v * (t - ta), v);
}
/** Seconds into a walk segment at path arc length `s`. */
function walkT(sg: Extract<Seg, { k: 'walk' }>, sPath: number): number {
  const { v, ta, td, dur } = sg, L = sg.gm ? sg.gm.G : sg.path.length;
  const s = sg.gm ? sg.gm.gOf(sPath) : sPath;
  if (s <= 0) return 0;
  if (s >= L) return dur;
  const s1 = (v * ta) / 2, s2 = L - (v * td) / 2;
  if (s < s1) return Math.sqrt((2 * ta * s) / v);
  if (s > s2) return dur - Math.sqrt((2 * td * (L - s)) / v);
  return ta + (s - s1) / v;
}

class Job {
  readonly starts: number[] = [];
  readonly dist0: number[] = [];
  total = 0;
  /** Door windows, relative seconds: open (starts opening) … close (starts closing). */
  door: { open: number; close: number }[] = [];
  /** Relative times: procedural arms in / out; through the doorway; settled. */
  armIn = 0; armOut = 0; through = 0; arrive = 0;
  /** Seconds (relative) from which the actor is inside the room / leaves it. */
  insideFrom = 0; insideTo = Infinity;
  /** Own top speed, the speed actually used (door queue cap), came in through the door. */
  vmax = 0; vcap = 0; fromDoor = false;
  /** Requested start (before the door queue spaced it out). */
  at0 = 0;
  /** Walking machines: the gait family of the walk segment (null = not a walking machine). */
  family: GaitFamily | null = null;
  /** Walking machines: the walk this one re-targets, which runs on until this one's (host-stamped) start: every page
   *  shows the same walk whenever its copy of the change arrived (null once this one has started). */
  prev: Job | null = null;
  /** A walk that re-targets an unfinished ENTRANCE (a room form changed the spot mid walk-in, SceneRuntime.reconcile's
   *  forms hop): still the entrance for the follow camera (tracks() reports it as 'enter'). */
  entering = false;

  /** `turnStep`: metres of stepping per radian turned on the spot (walking machines: their footprint, Locomotion.turnStep). */
  constructor(readonly actor: SceneActor, readonly kind: 'enter' | 'exit' | 'move', public start: number, readonly segs: Seg[], readonly preShown: boolean,
    readonly authoritative: boolean, readonly target: SpotInfo | null, readonly endShown: boolean, readonly turnStep = TURN_STEP) {
    let t = 0, d = 0;
    for (const s of segs) {
      this.starts.push(t); this.dist0.push(d);
      t += s.dur;
      d += s.k === 'walk' ? (s.gm ? s.gm.G : s.path.length) : s.k === 'turn' ? Math.abs(wrap(s.y1 - s.y0)) * turnStep : s.k === 'sit' ? s.from.distanceTo(s.to) : 0;
    }
    this.total = t;
  }

  /** Relative start time of the i-th segment of a kind (first / last). */
  segTime(k: Seg['k'], last = false): number | null {
    const idx = last ? this.segs.map((s) => s.k).lastIndexOf(k) : this.segs.findIndex((s) => s.k === k);
    return idx < 0 ? null : this.starts[idx];
  }

  /** The mount's pose at job distance `s` (room metres; the same distance sample() reports): pure, so a walking machine
   *  plants each foot where the mover will have it at that foot's mid-stance (exact on curves and turns on the spot). */
  poseAt(s: number, out: { pos: THREE.Vector3; yaw: number; sit?: number; seat?: SpotInfo | null }) {
    const n = this.segs.length;
    let i = 0;
    while (i < n - 1 && s >= this.dist0[i + 1]) i++;
    const sg = this.segs[i], ds = s - this.dist0[i];
    out.sit = 0; out.seat = null;
    switch (sg.k) {
      case 'walk': { const d = sg.gm ? sg.gm.sOf(ds) : Math.max(0, Math.min(ds, sg.path.length)); sg.path.at(d, out.pos); out.yaw = sg.rev ? wrap(sg.path.heading(d) + Math.PI) : sg.path.heading(d); break; }
      case 'turn': { const dy = wrap(sg.y1 - sg.y0), tot = Math.abs(dy) * this.turnStep; out.pos.copy(sg.pos); out.yaw = sg.y0 + dy * (tot > 0 ? clamp01(ds / tot) : 1); break; }
      case 'sit': { const tot = sg.from.distanceTo(sg.to), k = tot > 0 ? clamp01(ds / tot) : 1; out.pos.lerpVectors(sg.from, sg.to, k); out.yaw = sg.yaw; out.sit = sg.s0 + (sg.s1 - sg.s0) * k; out.seat = sg.seat; break; }
      case 'hold': out.pos.copy(sg.pos); out.yaw = sg.yaw; out.sit = sg.sit; out.seat = sg.seat; break;
      default: out.pos.copy(sg.pos); out.yaw = sg.yaw;
    }
    return out;
  }

  sample(t: number, o: Sample): Sample {
    const n = this.segs.length;
    let i = 0;
    const tt = Math.max(0, Math.min(t, this.total));
    while (i < n - 1 && tt >= this.starts[i + 1]) i++;
    const sg = this.segs[i], lt = Math.min(sg.dur, tt - this.starts[i]), k = sg.dur > 0 ? lt / sg.dur : 1;
    o.appear = 1; o.gait = 0; o.stride = 1; o.back = false; o.dist = this.dist0[i]; o.seat = null;
    o.family = this.family && sg.k !== 'walk' ? 'walk' : this.family;
    switch (sg.k) {
      case 'hold': o.pos.copy(sg.pos); o.yaw = sg.yaw; o.sit = sg.sit; o.seat = sg.seat; break;
      case 'pop': o.pos.copy(sg.pos); o.yaw = sg.yaw; o.sit = 0; o.appear = sg.a0 + (sg.a1 - sg.a0) * smooth(k); break;
      case 'turn': {
        const d = wrap(sg.y1 - sg.y0);
        o.pos.copy(sg.pos); o.yaw = sg.y0 + d * smooth(k); o.sit = 0;
        o.dist += Math.abs(d) * this.turnStep * smooth(k);
        o.gait = 0.6 * Math.sin(Math.PI * k); o.stride = 0;
        break;
      }
      case 'walk': {
        const w = walkS(sg, lt);
        sg.path.at(w.s, o.pos); o.yaw = sg.path.heading(w.s); o.sit = 0;
        // (a walking machine backing into its parking place: facing against the path)
        if (sg.rev) { o.yaw = wrap(o.yaw + Math.PI); o.back = true; }
        o.dist += w.g;
        o.gait = sg.v > 0 ? Math.min(1, w.v / sg.v) : 0;
        break;
      }
      case 'sit': {
        const down = sg.s1 > sg.s0;
        // sitting: step back first, then lower; standing: rise first, then step forward
        const mk = down ? smooth(k / 0.7) : smooth((k - 0.3) / 0.7);
        const sk = down ? smooth((k - 0.2) / 0.8) : smooth(k / 0.8);
        o.pos.lerpVectors(sg.from, sg.to, mk); o.yaw = sg.yaw; o.seat = sg.seat;
        o.sit = sg.s0 + (sg.s1 - sg.s0) * sk;
        o.dist += sg.from.distanceTo(sg.to) * mk;
        o.gait = 0.4 * Math.sin(Math.PI * clamp01(down ? k / 0.7 : (k - 0.3) / 0.7)) * (1 - o.sit);
        o.back = down;
        break;
      }
    }
    o.shown = t < 0 ? this.preShown : t >= this.total ? this.endShown : true;
    o.outside = t < this.insideFrom || t > this.insideTo;
    o.armW = Math.min(smooth((t - this.armIn + ARM_BLEND) / ARM_BLEND), 1 - smooth((t - this.armOut) / ARM_BLEND));
    return o;
  }
}

export class WalkMover implements AvatarMover {
  readonly nav: RoomNav;
  private jobs = new Map<SceneActor, Job>();
  private layers = new Map<SceneActor, Locomotion>();
  private seen = new WeakSet<SceneActor>();
  private doors: { open: number; close: number; job: Job }[] = [];
  private tmp: Sample = { pos: V(), yaw: 0, sit: 0, seat: null, shown: false, appear: 1, dist: 0, gait: 0, stride: 1, back: false, outside: false, armW: 0 };
  /** Tests: advance time only through update(dt) (hidden tabs driven by vtpOut.step). */
  manual = false;
  private clock = Date.now() / 1000;

  /** walkable heights (FLOOR_* meshes: stages, stairs, balconies — src/scene/floors.ts); none = y 0 as before */
  private floors: RoomFloors | null = null;
  /** The room as it loaded (src/scene/mechNav.ts): walking machines park and route on it, the same on every page. */
  private rays: StaticRays;
  constructor(readonly room: RoomInfo) {
    try { const f = floorsOf(room); if (f.any) this.floors = f; } catch { /* optional */ }
    this.nav = new RoomNav(room);
    this.rays = staticRaysOf(room);
  }

  /** Seconds, on the same clock as SceneState.moves[].at / 1000. */
  now() { return this.manual ? this.clock : Date.now() / 1000; }

  private layer(a: SceneActor): Locomotion {
    let l = this.layers.get(a);
    if (!l) {
      l = new Locomotion(a); this.layers.set(a, l);
      // (walking machines: their feet stand on the room's levels, src/avatar/mech.ts; rooms without levels: flat)
      l.floorAt = this.floors ? (x, z) => this.footFloor(x, z) : null;
    }
    const lay = l;
    a.extraPose = (rt, dt) => lay.apply(rt, dt);
    return l;
  }

  // ---------------------------------------------------------------- AvatarMover
  enter(actor: SceneActor, spot: SpotInfo, ev?: MoveEvent) {
    this.layer(actor);
    const at = typeof ev?.at === 'number' ? ev.at / 1000 : null;
    const job = this.jobs.get(actor);
    const seen = this.seen.has(actor);
    this.seen.add(actor);
    if (!job && !seen) {
      if (at === null) return this.snap(actor, spot);
      const from = ev?.from ?? -1;
      const fs = from >= 0 ? this.room.spots[from] : null;
      return this.start(actor, 'enter', fs && fs !== spot ? { k: 'spot', spot: fs } : fs === spot ? null : { k: 'door' }, spot, at);
    }
    this.start(actor, 'enter', this.current(actor, 'enter'), spot, at);
  }

  exit(actor: SceneActor, ev?: MoveEvent) {
    this.layer(actor);
    this.seen.add(actor);
    const at = typeof ev?.at === 'number' ? ev.at / 1000 : null;
    const st = this.current(actor, 'exit', ev);
    if (!st) { this.drop(actor); actor.shown = false; return; }
    this.start(actor, 'exit', st, null, at);
  }

  move(actor: SceneActor, spot: SpotInfo, ev?: MoveEvent) {
    this.layer(actor);
    const at = typeof ev?.at === 'number' ? ev.at / 1000 : null;
    if (!this.seen.has(actor) && at === null) { this.seen.add(actor); return this.snap(actor, spot); }
    this.seen.add(actor);
    const prev = this.jobs.get(actor) ?? null;
    const entering = !!prev && (prev.kind === 'enter' || prev.entering);
    this.start(actor, 'move', this.current(actor, 'move', ev), spot, at);
    const nj = this.jobs.get(actor);
    if (nj && nj !== prev && entering) nj.entering = true;
  }

  busy(actor: SceneActor) { return this.jobs.has(actor); }
  release(actor: SceneActor) { this.drop(actor); this.seen.add(actor); }
  /** Another mover takes this actor over (src/scene/arrivals/liftMover.ts): forget any walk of it (= release). */
  handOff(actor: SceneActor) { this.release(actor); }
  /** …and gives it back, settled wherever that mover left it: our walk / idle pose layer, "seen" (no snap next time). */
  adopt(actor: SceneActor) { this.drop(actor); this.seen.add(actor); this.layer(actor); }

  /** Floor point of a walker `t` s into their current walk (the follow camera plans its operators ahead with it). */
  samplePath(actor: SceneActor, t: number): THREE.Vector3 | null {
    const j = this.jobs.get(actor);
    if (!j) return null;
    const p = j.sample(t, { pos: V(), yaw: 0, sit: 0, seat: null, shown: false, appear: 1, dist: 0, gait: 0, stride: 1, back: false, outside: false, armW: 0 }).pos.clone();
    if (this.floors) p.y = this.floors.at(p.x, p.z, p.y);
    return p;
  }

  tracks(): MoverTrack[] {
    const now = this.now(), out: MoverTrack[] = [];
    for (const [actor, j] of this.jobs) out.push({ actor, kind: j.entering ? 'enter' : j.kind, t: now - j.start, through: j.through, arrive: j.arrive });
    return out;
  }

  update(dt: number) {
    if (this.manual) this.clock += dt; else this.clock = Date.now() / 1000;
    const now = this.now();
    for (const [a, l] of this.layers) {
      if (!a.runtime) { this.layers.delete(a); this.jobs.delete(a); a.extraPose = null; continue; }
      const j = this.jobs.get(a);
      if (j) {
        const t = now - j.start;
        if (t >= 0) j.prev = null;
        this.apply(a, l, j, t);
        if (t >= j.total) this.jobs.delete(a);
      } else {
        l.gait = 0; l.armW = 0; l.headW = 0; l.back = false; l.family = null; l.poseAt = null;
        // (walking machines: parked, the same at every instant)
        const d = l.dist;
        l.clock = now; l.sampleAt = () => ({ dist: d, gait: 0, stride: 1, back: false, travel: 0, family: null });
        a.loco = 0;
        const want = a.shown && a.present && a.spot?.pose === 'stand' ? 1 : 0;
        l.idle += (want - l.idle) * (1 - Math.exp(-2.5 * dt));
      }
    }
    // the door: open while anyone's door window is
    let open = 0;
    this.doors = this.doors.filter((d) => now < d.close + DOOR_EASE + 0.1);
    for (const d of this.doors) open = Math.max(open, smooth((now - d.open) / DOOR_EASE) * (1 - smooth((now - d.close) / DOOR_EASE)));
    this.room.door?.setOpen(open);
  }

  finishAll() {
    for (const [a, j] of [...this.jobs]) {
      if (j.authoritative) continue;          // host-timed walks are simply sampled at the wall clock
      this.apply(a, this.layer(a), j, j.total);
      this.jobs.delete(a);
      this.doors = this.doors.filter((d) => d.job !== j);
    }
    this.update(0);
  }

  dispose() {
    for (const a of this.layers.keys()) { a.extraPose = null; a.offset.set(0, 0, 0); a.tilt.identity(); a.loco = 0; }
    this.jobs.clear(); this.layers.clear(); this.doors = [];
  }

  // ---------------------------------------------------------------- internals
  private snap(actor: SceneActor, spot: SpotInfo) {
    this.drop(actor);
    actor.place(actor.placementAt(spot));
    actor.shown = true; actor.appear = 1;
  }

  private drop(actor: SceneActor) {
    const j = this.jobs.get(actor);
    if (!j) return;
    this.jobs.delete(actor);
    const now = this.now();
    // its future door openings are off; an open door starts closing now
    this.doors = this.doors.filter((d) => d.job !== j || d.open <= now);
    for (const d of this.doors) if (d.job === j) d.close = Math.min(d.close, now);
  }

  /** Where a new walk starts: mid-walk (interrupted), at their spot, or (hidden) outside. */
  private current(actor: SceneActor, kind: 'enter' | 'exit' | 'move', ev?: MoveEvent): Start | null {
    const j = this.jobs.get(actor);
    if (j) {
      // (a walking machine re-targeted by a host-stamped change: from where its walk is AT that time, the same point on
      // every page whenever the change reached it; it walks on until then: Job.prev)
      const T = j.family && typeof ev?.at === 'number' ? ev.at / 1000 : this.now();
      const s = this.jobAt(j, T, this.tmp);
      if (!s.shown) return kind === 'exit' ? null : { k: 'door' };
      if (s.outside) return kind === 'exit' ? { k: 'point', pos: s.pos.clone(), yaw: s.yaw, sit: 0, seat: null, outside: true } : { k: 'door' };
      return { k: 'point', pos: s.pos.clone(), yaw: s.yaw, sit: s.sit, seat: s.seat, outside: false };
    }
    if (!actor.shown) return kind === 'exit' ? null : { k: 'door' };
    // settled (runtime-owned): at the event's origin spot if that's where they are, else wherever they stand
    const from = ev?.from ?? -1;
    const fs = from >= 0 ? this.room.spots[from] : null;
    if (fs && fs.position.distanceTo(actor.mount.position) < 0.05) return { k: 'spot', spot: fs };
    for (const s of this.room.spots) if (s && s.position.distanceTo(actor.mount.position) < 0.05 && Math.abs(wrap(s.yaw - actor.mount.rotation.y)) < 0.05) return { k: 'spot', spot: s };
    return { k: 'point', pos: actor.mount.position.clone().setY(0), yaw: actor.mount.rotation.y, sit: actor.sit, seat: null, outside: false };
  }

  /** Build the timeline and start it (at: seconds on the mover clock; null = now). */
  private start(actor: SceneActor, kind: 'enter' | 'exit' | 'move', from: Start | null, to: SpotInfo | null, at: number | null) {
    const old = this.jobs.get(actor) ?? null;
    this.drop(actor);
    if (!from) { if (to) this.snap(actor, to); return; }
    const job = this.build(actor, kind, from, to, at, at !== null, Infinity);
    // (a walking machine's stamped re-target: the old walk runs on until the new one starts)
    if (old && old.family && job.family && at !== null && from.k === 'point' && job.start > old.start) job.prev = old;
    this.register(actor, job);
    if (job.fromDoor) this.requeue();
  }

  private register(actor: SceneActor, job: Job) {
    const old = this.jobs.get(actor);    // a re-timed queue job replaces its old door windows
    if (old) this.doors = this.doors.filter((d) => d.job !== old);
    for (const d of job.door) this.doors.push({ open: job.start + d.open, close: job.start + d.close, job });
    this.jobs.set(actor, job);
    this.apply(actor, this.layer(actor), job, this.now() - job.start);
  }

  /** A door queue walks in single file: nobody walks faster than whoever went in just before them
   *  (order-independent: every page ends up with the same speeds from the same set of arrivals). */
  private requeue() {
    const q = [...this.jobs.values()].filter((j) => j.fromDoor).sort((a, b) => a.at0 - b.at0 || a.actor.key.localeCompare(b.actor.key));
    let cap = Infinity, last = -Infinity;
    for (const j of q) {
      if (j.at0 - last > 8) cap = Infinity;
      const want = Math.min(j.vmax, cap);
      // …and keeps ~1.1 m behind the one in front (big costumes / slow walkers need more than the stagger)
      const start = Math.max(j.at0, last + (cap < Infinity ? Math.max(DOOR_STAGGER, QUEUE_GAP / want) : 0));
      if (Math.abs(want - j.vcap) > 1e-6 || Math.abs(start - j.start) > 1e-6) {
        const nj = this.build(j.actor, j.kind, { k: 'door' }, j.target, start, j.authoritative, want);
        nj.at0 = j.at0;
        this.register(j.actor, nj);
      }
      cap = want; last = start;
    }
  }

  private build(actor: SceneActor, kind: 'enter' | 'exit' | 'move', from: Start, to: SpotInfo | null, at: number | null, auth: boolean, vcap: number): Job {
    const l = this.layer(actor);
    const nav = this.nav;
    const hRoom = (actor.rest?.height ?? 1.6) * actor.scale;
    const vown = Math.max(0.35, Math.min(1.2 * THREE.MathUtils.clamp(hRoom / 1.5, 0.5, 1.8), l.maxSpeed()));
    const vmax = Math.min(vown, vcap);
    // walking machines (src/avatar/mech.ts): their own turn rate / turn stepping, a stand-up before the first step and a
    // settle after arriving (everyone else: 0, exactly as before)
    const turnRate = l.turnRate(TURN_RATE), turnStep = l.turnStep(TURN_STEP), spool = l.spool(), settle = l.settle();
    // walking machines never sit: at every spot (a seat or a stand spot) they PARK where the actor's park offset puts
    // them (actor.parkAt: clear of the furniture). The route leaves from / ends at that point, and a 1-frame hold swaps
    // "mount at the spot, parked (sit 1)" for "mount at the park point, walking" (the body doesn't move; only the
    // bookkeeping does), so its legs walk exactly what the body travels
    const parks = !!actor.runtime?.mech;
    const parkTo = parks && to ? actor.parkAt(to) : null;
    const segs: Seg[] = [];
    const door = !!nav.doorOutside;
    let pos: THREE.Vector3, yaw: number;
    let fromSpot: SpotInfo | null = null;
    let preShown = true;
    let startsOutside = false;

    // ---- origin
    if (from.k === 'door') {
      preShown = false;
      startsOutside = true;
      if (!door) {
        // no door in this room: pop in at the spot's stand point (a walking machine: its park point)
        const p = parkTo ? parkTo.clone() : to ? nav.standPoint(to) : V();
        segs.push({ k: 'pop', dur: 0.35, pos: p, yaw: to ? to.yaw : 0, a0: 0, a1: 1 });
        pos = p; yaw = to ? to.yaw : 0;
      } else { pos = nav.doorOutside!.clone(); yaw = 0; }
    } else if (from.k === 'spot') {
      fromSpot = from.spot;
      pos = from.spot.position.clone().setY(0); yaw = from.spot.yaw;
      const P = parks ? actor.parkAt(from.spot) : null;
      if (P) { segs.push({ k: 'hold', dur: 1 / 60, pos: pos.clone(), yaw, sit: 1, seat: from.spot }); pos = P; }
      else if (from.spot.pose === 'sit') {
        const T = nav.standPoint(from.spot);
        segs.push({ k: 'sit', dur: SIT_TIME, from: pos, to: T, yaw, s0: 1, s1: 0, seat: from.spot });
        pos = T;
      }
    } else {
      pos = from.pos.clone(); yaw = from.yaw;
      startsOutside = from.outside;
      const P = parks && from.sit > 0.01 && from.seat ? actor.parkAt(from.seat) : null;
      if (P) { segs.push({ k: 'hold', dur: 1 / 60, pos: pos.clone(), yaw, sit: from.sit, seat: from.seat }); pos = pos.clone().lerp(P.clone().sub(from.seat!.position.clone().setY(0)).add(pos), from.sit); }
      else if (from.sit > 0.01 && from.seat) {
        const T = pos.clone().addScaledVector(new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), nav.standPoint(from.seat).distanceTo(from.seat.position.clone().setY(0)) * from.sit);
        segs.push({ k: 'sit', dur: SIT_TIME * from.sit, from: pos, to: T, yaw, s0: from.sit, s1: 0, seat: from.seat });
        pos = T;
      }
    }

    // ---- route
    let legs: MechLeg[] = [];
    if (door || from.k !== 'door') {
      // (a parking walker never takes a seat's own approach: that leads to the human stand point, behind a desk or
      // between the chairs; its route runs from where it really stands to where it will park, around the furniture:
      // the clearance grid (mechLegs), else the inflated nav graph (mechRoute))
      if (parks && (to ? !!parkTo : true)) {
        const a = from.k === 'door' ? null : pos, b = to ? parkTo : null;
        legs = this.mechLegs(actor, l, a, yaw, b, to ? to.yaw : null, startsOutside) ?? [{ pts: this.mechRoute(l.footprint(), a, b, startsOutside), main: true }];
      } else {
        let pts: THREE.Vector3[] = [];
        if (to) pts = from.k === 'door' ? (door ? nav.fromDoor(to) : []) : fromSpot ? nav.between(fromSpot, to) : nav.fromPoint(pos, startsOutside, to);
        else if (door) pts = fromSpot ? nav.toDoor(fromSpot) : nav.fromPoint(pos, startsOutside, null);
        legs = [{ pts, main: true }];
      }
    }
    if (legs.length && legs[0].pts.length) legs[0].pts[0] = pos.clone();
    // (a parking walker ends at its park point, not the spot's stand point)
    const endLeg = legs[legs.length - 1];
    if (parkTo && endLeg && endLeg.pts.length >= 2) endLeg.pts[endLeg.pts.length - 1] = parkTo;
    // walking machines walk by gait distance (GaitMap: corners count as the outer feet travel them); the pace for the
    // trip and its gait family come from its main leg (everyone else: one leg at vmax)
    const built = legs.map((g) => {
      const path = g.pts.length >= 2 ? new WalkPath(g.pts) : null;
      return path && path.length > 0.05 ? { g, path, gm: parks ? new GaitMap(path, turnStep) : undefined } : null;
    }).filter((x): x is { g: MechLeg; path: WalkPath; gm: GaitMap | undefined } => !!x);
    const mainB = built.find((x) => x.g.main) ?? built[0];
    const pl = mainB ? l.plan(mainB.gm ? mainB.gm.G : mainB.path.length, vmax) : null;
    let walk: Extract<Seg, { k: 'walk' }> | null = null;
    let family: GaitFamily | null = null;
    for (const { g, path, gm } of built) {
      const first = !segs.some((x) => x.k === 'walk');
      const h0 = g.rev ? wrap(path.heading(0) + Math.PI) : path.heading(0);
      if (from.k === 'door' && first) yaw = h0;
      // (a walking machine turns on the spot for any heading change: its body never snaps round under planted feet)
      else if (Math.abs(wrap(h0 - yaw)) > (parks ? 0.01 : 0.2)) { segs.push({ k: 'turn', dur: 0.2 + Math.abs(wrap(h0 - yaw)) / turnRate, pos: pos.clone(), y0: yaw, y1: h0 }); }
      yaw = h0;
      const L = path.length;
      const G = gm ? gm.G : L;
      // (walking machines: the pace for this trip + its gait family; everyone else: vmax)
      let v = pl!.v;
      family = pl!.family;
      if (G < (v * (ACCEL + DECEL)) / 2) v = (2 * G) / (ACCEL + DECEL);
      const w: Extract<Seg, { k: 'walk' }> = { k: 'walk', dur: G / v + (ACCEL + DECEL) / 2, path, v, ta: ACCEL, td: DECEL, ...(gm ? { gm } : {}), ...(g.rev ? { rev: true } : {}) };
      if (from.k === 'door' && door && first) segs.unshift({ k: 'hold', dur: 0.45, pos: pos.clone(), yaw, sit: 0, seat: null });
      segs.push(w);
      if (g === mainB.g) walk = w;
      pos = path.at(L); yaw = g.rev ? wrap(path.heading(L) + Math.PI) : path.heading(L);
    }

    // ---- arrival
    if (to) {
      if (Math.abs(wrap(to.yaw - yaw)) > (parks ? 0.01 : 0.05)) segs.push({ k: 'turn', dur: 0.25 + Math.abs(wrap(to.yaw - yaw)) / turnRate, pos: pos.clone(), y0: yaw, y1: to.yaw });
      yaw = to.yaw;
      if (parkTo) segs.push({ k: 'hold', dur: 1 / 60, pos: to.position.clone().setY(0), yaw, sit: 1, seat: to });
      else if (to.pose === 'sit') segs.push({ k: 'sit', dur: SIT_TIME, from: pos.clone(), to: to.position.clone().setY(0), yaw, s0: 0, s1: 1, seat: to });
      else segs.push({ k: 'hold', dur: 0.5, pos: to.position.clone().setY(0), yaw, sit: 0, seat: null });
    } else if (door) {
      segs.push({ k: 'hold', dur: 0.1 + DOOR_EASE + 0.1, pos: pos.clone(), yaw, sit: 0, seat: null });
    } else {
      segs.push({ k: 'pop', dur: 0.3, pos: pos.clone(), yaw, a0: 1, a1: 0 });
    }
    if (!segs.length) segs.push({ k: 'hold', dur: 0.01, pos: pos.clone(), yaw, sit: 0, seat: null });
    // walking machine: stand up (spool) right before it first moves, settle after it arrives
    let spoolAt = -1;
    if (spool > 0) {
      const i = segs.findIndex((s) => s.k === 'walk' || s.k === 'turn' || s.k === 'sit');
      if (i >= 0) {
        const s = segs[i];
        const h: Seg = s.k === 'walk' ? { k: 'hold', dur: spool, pos: s.path.at(0), yaw: s.rev ? wrap(s.path.heading(0) + Math.PI) : s.path.heading(0), sit: 0, seat: null }
          : s.k === 'turn' ? { k: 'hold', dur: spool, pos: s.pos.clone(), yaw: s.y0, sit: 0, seat: null }
          : s.k === 'sit' ? { k: 'hold', dur: spool, pos: s.from.clone(), yaw: s.yaw, sit: s.s0, seat: s.seat }
          : null!;
        segs.splice(i, 0, h);
        spoolAt = i;
      }
    }
    if (settle > 0 && to && spoolAt >= 0) {
      const last = segs[segs.length - 1];
      const sit = to.pose === 'sit' || parkTo ? (last.k === 'sit' ? last.s1 : last.k === 'hold' ? last.sit : 0) : 0;
      segs.push({ k: 'hold', dur: settle, pos: last.k === 'sit' ? last.to.clone() : last.k === 'hold' ? last.pos.clone() : pos.clone(), yaw, sit, seat: sit > 0 ? to : null });
      if (last.k === 'hold' && last.dur > 0.2) last.dur = 0.2;
    }

    // ---- start time: host-stamped, else now (+ a local door queue for un-stamped arrivals)
    let t0 = at ?? this.now();
    // un-stamped arrivals queue at the door locally (the host stamps its own queue)
    if (at === null && door && from.k === 'door') for (const [, o] of this.jobs) if (o.kind === 'enter' && o.preShown === false) t0 = Math.max(t0, o.start + DOOR_STAGGER);
    const job = new Job(actor, kind, t0, segs, preShown, auth, to, !!to, turnStep);
    job.family = family ?? (parks ? 'walk' : null);
    job.vmax = vown; job.vcap = vmax; job.fromDoor = from.k === 'door' && door; job.at0 = t0;
    // procedural arms / head while walking + turning
    const mv = segs.map((s, i) => (s.k === 'walk' || s.k === 'turn' ? i : -1)).filter((i) => i >= 0);
    job.armIn = mv.length ? job.starts[mv[0]] : job.total + 1;
    job.armOut = mv.length ? job.starts[mv[mv.length - 1]] + segs[mv[mv.length - 1]].dur : -1;
    // a walking machine's hands go to the sticks as it stands up and stay there until it has settled
    if (spoolAt >= 0) {
      job.armIn = job.starts[spoolAt] + ARM_BLEND;
      job.armOut = Math.max(job.armIn, job.total - ARM_BLEND - 0.05);
    }
    job.arrive = job.total;
    if (walk && door) {
      const wi = segs.indexOf(walk), ws = job.starts[wi];
      const sDoor = nav.doorway ? walk.path.closest(nav.doorway) : walk.path.length * (to ? 0.15 : 0.85);
      if (from.k === 'door' || startsOutside) {
        const tPass = ws + walkT(walk, sDoor);
        job.door.push({ open: 0, close: ws + walkT(walk, Math.min(walk.path.length, sDoor + 0.9)) });
        job.through = tPass; job.insideFrom = tPass;
      }
      if (!to) {
        const tOpen = Math.max(0, ws + walkT(walk, Math.max(0, sDoor - 0.6)) - DOOR_EASE);
        job.door.push({ open: tOpen, close: ws + walk.dur + 0.1 });
        job.insideTo = ws + walkT(walk, sDoor);
        job.through = job.insideTo;
      }
    }
    return job;
  }

  /** Where a walking machine's foot stands at a world (x, z) in a room with levels: the walk-data floor (FLOOR_*; 0
   *  where there is none, like the walk), or a visible surface up to 20 cm above it (a stage's real, finer edge or its
   *  rim, a low step, a rug: what a viewer sees the foot stand on; a table top or a seat is higher and never counts).
   *  Cached on a 1 cm grid (a foot in the air asks for its landing every tick). */
  private footCache = new Map<number, number>();
  private footMeshes: THREE.Object3D[] | null = null;
  /** The Room editor hid / moved room objects in place: the ground under a foot is looked up again. */
  roomChanged() { this.footMeshes = null; this.footCache.clear(); }
  private footRay = new THREE.Raycaster();
  private footFloor(x: number, z: number): number {
    const fl = this.floors;
    if (!fl) return 0;
    const qx = Math.round(x * 100), qz = Math.round(z * 100), key = qx * 1e6 + qz;
    const c = this.footCache.get(key);
    if (c !== undefined) return c;
    const base = fl.at(qx / 100, qz / 100, 0);
    let y = base;
    try {
      if (!this.footMeshes) {
        const ms: THREE.Object3D[] = [];
        this.room.root.updateMatrixWorld(true);
        // (what is drawn: walk-data floors and colliders are hidden; light strips, screens and markers are no ground; a
        // plain floor's split parts, FLOOR_1 / FLOOR_2 (a rug), are)
        const drawn = (o: THREE.Object3D) => { for (let x: THREE.Object3D | null = o; x && x !== this.room.root; x = x.parent) if (!x.visible) return false; return true; };
        this.room.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && drawn(m) && !/^(LIGHT_|SCREEN|CAM_|PATH|SPOT|COLLIDE|DOOR)/.test(m.name) && !/^(LIGHT_|SCREEN)/.test(m.parent?.name ?? '')) ms.push(m); });
        this.footMeshes = ms;
      }
      const r = this.footRay;
      r.set(new THREE.Vector3(qx / 100, base + 0.2, qz / 100), new THREE.Vector3(0, -1, 0)); r.near = 0; r.far = 0.25;
      const up = new THREE.Vector3();
      for (const h of r.intersectObjects(this.footMeshes, false)) {
        if (!h.face) continue;
        up.copy(h.face.normal).transformDirection(h.object.matrixWorld);
        if (up.y > 0.5) { y = Math.max(base, h.point.y); break; }
      }
    } catch { /* the walk-data floor */ }
    if (this.footCache.size > 4096) this.footCache.clear();
    this.footCache.set(key, y);
    return y;
  }

  /** Clearance grids for walking machines (src/scene/mechNav.ts), one per machine height (decimetres). */
  private mechGrids = new Map<number, MechGrid>();
  private gridOf(top: number): MechGrid {
    const key = Math.max(3, Math.min(30, Math.round(top * 10)));
    let g = this.mechGrids.get(key);
    if (!g) {
      const b = this.room.bounds;
      const bounds = b.isEmpty() ? { x0: -40, z0: -40, x1: 40, z1: 40 } : { x0: b.min.x - 0.5, z0: b.min.z - 0.5, x1: b.max.x + 0.5, z1: b.max.z + 0.5 };
      const fl = this.floors;
      g = new MechGrid(this.rays, fl ? (x, z) => fl.at(x, z, 0) : null, { top: key / 10, bounds, floorPts: this.room.spots.filter((s): s is SpotInfo => !!s).map((s) => s.position) });
      this.mechGrids.set(key, g);
    }
    return g;
  }

  /**
   * A walking machine's walk between two floor points (null = the door) on the room's clearance grid: its legs keep
   * their own half-width (+12 cm) clear of every piece of furniture the room's meshes show (chairs too, which the nav's
   * boxes don't know), as tight as it parked only near the two ends. Turning on the spot swings its farthest foot round:
   * where that would reach the furniture, it first walks straight out of its parking place, and arriving it turns out
   * in the open and backs in. A cramped room: the clearance steps down to 60 % of its half-width; still nothing (or no
   * grid: not measured yet, a door to a room without paths): null (the caller's inflated-graph route).
   */
  private mechLegs(actor: SceneActor, l: Locomotion, a: THREE.Vector3 | null, yawA: number, b: THREE.Vector3 | null, yawB: number | null, outsideA: boolean): MechLeg[] | null {
    const dims = actor.mechDims();
    if (!dims || outsideA) return null;
    try {
      const grid = this.gridOf(dims.top);
      const half = dims.half + 0.12, turnR = Math.max(l.footprint(), dims.half) + 0.12;
      // the door: the human nav's way through it, to / from the room's first path point (no machine fits a doorway
      // better than that)
      const inner = this.room.path[0] ? this.room.path[0].clone().setY(0) : null;
      let pre: THREE.Vector3[] = [], post: THREE.Vector3[] = [];
      let A = a, B = b;
      if (!A) { if (!inner) return null; pre = this.nav.pointRoute(null, inner); A = inner; }
      if (!B) { if (!inner) return null; post = this.nav.pointRoute(inner, null); B = inner; }
      const outPt = (p: THREE.Vector3, y: number): THREE.Vector3 | null => {
        const c0 = grid.clearAt(p.x, p.z, turnR);
        if (c0 >= turnR - 1e-6) return null;
        const f = new THREE.Vector3(Math.sin(y), 0, Math.cos(y)), lat0 = Math.min(half, grid.clearAt(p.x, p.z, half));
        let best: THREE.Vector3 | null = null, bc = c0 + 0.15;
        for (let n = 1; n <= 30; n++) {
          const q = p.clone().addScaledVector(f, n * 0.1);
          // (straight out: never into tighter room than it parked in)
          if (grid.clearAt(q.x, q.z, half) < lat0 - 0.06) break;
          if (n < 2) continue;
          const c = grid.clearAt(q.x, q.z, turnR);
          if (c >= turnR - 1e-6) return q;
          if (c > bc) { bc = c; best = q; }
        }
        return best;
      };
      const ex = a ? outPt(a, yawA) : null;
      const en = b && yawB !== null ? outPt(b, yawB) : null;
      const S = ex ?? A, E = en ?? B;
      // (the clearance steps down near the two ends' box (+ 3 m) before a long way round (+ 6 m) is looked for: a walk
      // round the whole set for 12 cm more margin is not worth it)
      let r = null;
      for (const m of [3, 6]) {
        for (const h of [half, dims.half, 0.8 * dims.half, 0.6 * dims.half]) {
          if (h < this.nav.radius) break;
          r = grid.route(S, E, h, m);
          if (r) break;
        }
        if (r) break;
      }
      if (!r) return null;
      // (out of a tight parking place it walks straight out and curves onto the route without stopping: a stop and a
      // turn on the spot there would start with a foot left far behind, at its joint limits)
      const legs: MechLeg[] = [];
      const out: THREE.Vector3[] = [];
      if (ex) { const a0 = A.clone().setY(0), n = Math.max(1, Math.ceil(a0.distanceTo(ex) / 0.3)); for (let k = 0; k < n; k++) out.push(a0.clone().lerp(ex, k / n).setY(0)); }
      legs.push({ pts: [...out, ...pre.slice(0, -1), ...r.pts, ...post.slice(1)], main: true });
      if (en) legs.push({ pts: [en.clone().setY(0), B.clone().setY(0)], rev: true });
      return legs;
    } catch { return null; }
  }

  /** A walking machine's route between two floor points (null = the door): on a graph whose furniture is inflated by
   *  about half its footprint, so its legs swing wide of a desk's end instead of stepping into it (each end still joins
   *  that graph by a human's clearance: it parks closer than that to the furniture behind it). A route that only that
   *  wide graph would push through furniture (a cramped room: no wide way round) falls back to the human-width one. */
  private mechNavs = new Map<number, RoomNav>();
  private mechRoute(footprint: number, a: THREE.Vector3 | null, b: THREE.Vector3 | null, outsideA: boolean): THREE.Vector3[] {
    const human = this.nav.pointRoute(a, b, outsideA);
    const r = Math.round(THREE.MathUtils.clamp(0.55 * footprint, this.nav.radius, 0.7) * 10) / 10;
    if (r <= this.nav.radius + 1e-6) return human;
    let wide = this.mechNavs.get(r);
    if (!wide) { wide = new RoomNav(this.room, r); this.mechNavs.set(r, wide); }
    const pts = wide.pointRoute(a, b, outsideA, this.nav.radius);
    // (every leg of it clear of the furniture itself, the ends' own boxes aside: else the human route)
    for (let i = 1; i < pts.length; i++) if (!this.nav.clear(pts[i - 1], pts[i], 0.05)) return human;
    return pts.length >= 2 ? pts : human;
  }

  /** The job that runs at absolute mover time T (a re-target's previous walk until it starts) and its sample there. */
  private effective(j: Job, T: number): Job { let x = j; while (x.prev && T < x.start) x = x.prev; return x; }
  private jobAt(j: Job, T: number, out: Sample): Sample { const e = this.effective(j, T); return e.sample(T - e.start, out); }

  /** A walking machine's LIFT world matrix at job distance `s` (room metres): the job's pose there on the floor, plus
   *  the seat offset it parks with (× sit) and its scale — exactly what actor.lift will be, so a foot planted for a
   *  distance inside a seat hold (the park switch) lands where the body really is then. */
  private poseTmp: { pos: THREE.Vector3; yaw: number; sit?: number; seat?: SpotInfo | null } = { pos: V(), yaw: 0 };
  private liftAt(a: SceneActor, j: Job, s: number): THREE.Matrix4 {
    const p = j.poseAt(s, this.poseTmp);
    let x = p.pos.x, z = p.pos.z;
    const y = this.floors ? this.floors.at(p.pos.x, p.pos.z, p.pos.y) : p.pos.y;
    if ((p.sit ?? 0) > 0 && p.seat) {
      const P = a.parkAt(p.seat);
      if (P) { x += (P.x - p.seat.position.x) * p.sit!; z += (P.z - p.seat.position.z) * p.sit!; }
    }
    const k = a.scale * Math.max(0.0001, a.appear);
    const m = new THREE.Matrix4().makeRotationY(p.yaw).scale(new THREE.Vector3(k, k, k)).setPosition(x, y, z);
    const parent = a.mount.parent;
    if (parent) { parent.updateWorldMatrix(true, false); m.premultiply(parent.matrixWorld); }
    return m;
  }

  private apply(a: SceneActor, l: Locomotion, j0: Job, t0: number) {
    // (a walking machine's re-target before its stamped start: the walk it replaces, still running)
    const j = j0.prev && t0 < 0 ? this.effective(j0, j0.start + t0) : j0;
    const t = j === j0 ? t0 : j0.start + t0 - j.start;
    const s = j.sample(t, this.tmp);
    a.mount.position.copy(s.pos);
    if (this.floors) a.mount.position.y = this.floors.at(s.pos.x, s.pos.z, s.pos.y);
    a.mount.rotation.set(0, s.yaw, 0);
    a.sit = s.sit;
    a.shown = s.shown;
    a.appear = s.appear;
    // seat geometry of the seat being left / taken (the runtime already points actor.spot at the target)
    const seat = s.seat ?? (s.sit > 0 ? j.target : null) ?? a.spot;
    a.updateSeat(seat);
    if (t >= j.total) a.updateSeat();
    l.dist = s.dist; l.gait = s.gait; l.back = s.back; l.stride = s.stride;
    l.family = s.family ?? null;
    l.poseAt = j.family ? (sRoom) => this.liftAt(a, j, sRoom) : null;
    // walking machines: this job at any instant of the mover clock (pure; `t` may run ahead of the clock: a walk finished
    // at once), so their steps run on fixed ticks of that clock and every page shows the same steps (src/avatar/mech.ts)
    if (j0.family) {
      const now = this.now(), off = Math.max(0, t0 - (now - j0.start)), smp: Sample = { pos: V(), yaw: 0, sit: 0, seat: null, shown: false, appear: 1, dist: 0, gait: 0, stride: 1, back: false, outside: false, armW: 0 };
      const poses = new Map<Job, (sRoom: number) => THREE.Matrix4>();
      l.clock = now;
      l.sampleAt = (T) => {
        const e = this.effective(j0, T + off);
        const x = e.sample(T + off - e.start, smp);
        let pa = poses.get(e);
        if (!pa) { pa = (sRoom: number) => this.liftAt(a, e, sRoom); poses.set(e, pa); }
        return { dist: x.dist, gait: x.gait, stride: x.stride, back: x.back, travel: x.armW, family: x.family ?? null, poseAt: pa };
      };
    } else { l.clock = NaN; l.sampleAt = null; }
    l.armW = s.armW; l.headW = 0.5 * s.armW;
    l.idle = 0;
    a.loco = s.gait;
  }
}

setMoverFactory((room) => new WalkMover(room));
