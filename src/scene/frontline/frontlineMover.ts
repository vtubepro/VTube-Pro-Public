// Frontline entrances / exits (AvatarMover) for rooms with scene.json `frontline` (+ HF_LZ / PAD_xx anchors).
//
//   JOIN   a drop pod screams down out of the sky onto the LZ (flame trail, impact, dust ring — drawn by the
//          frontline scene from pods()), the door swings open, the performer steps out, looks around and walks the
//          room's lanes (DOOR_OUTSIDE → PATH_* → their spot) → sits / settles.
//   LEAVE  stands up → walks to the nearest dropship that is on standby (PAD_xx_APPROACH → PAD_xx_BOARD) → up the
//          ramp, turns round inside → the ramp closes → the ship lifts off and flies away (drawn by the scene from
//          departures()); a replacement flies in and lands ~26 s later.
// Moves between spots are the regular WalkMover (wrapped). DETERMINISTIC like WalkMover: each job is a pure function
// of (room data, avatar size, spot, the host's move stamp), sampled at wall-clock time on every page.
import * as THREE from 'three';
import type { SceneActor } from '../actor.ts';
import type { RoomInfo, SpotInfo } from '../contract.ts';
import { lookPose, type CamPose } from '../cameraRig.ts';
import { Locomotion } from '../locomotion.ts';
import { currentMoverFactory, setMoverFactory, type AvatarMover, type MoveEvent, type MoverTrack } from '../mover.ts';
import { RoomNav, WalkPath } from '../navigation.ts';
import { WalkMover } from '../walkMover.ts';
import type { SceneInfo, SceneState } from '../../../shared/types.ts';
import { hash32 } from '../raid/rng.ts';
import { frontlineRoomOf, padFree, shipEvents, SHIP, type FrontlineRoom, type ShipEvent } from './frontlineRoom.ts';

const T0 = 1767225600;
const SIT_TIME = 0.8, ACCEL = 0.45, DECEL = 0.55, TURN_RATE = 3.4, TURN_STEP = 0.3;
/** pod timeline (s from the join stamp): falls, slams down, door opens, they step out */
export const POD = { impact: 2.3, door0: 3.1, door1: 3.8, out: 3.6, look: 1.0 } as const;
const STEP_OUT = 1.2, RAMP_STEP = 1.6, TURN_IN = 0.8, TAKEOFF = 2.4;

const smooth = (v: number) => { const k = v < 0 ? 0 : v > 1 ? 1 : v; return k * k * (3 - 2 * k); };
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

type Seg =
  | { k: 'hold'; dur: number; pos: THREE.Vector3; yaw: number; sit: number; seat: SpotInfo | null }
  | { k: 'turn'; dur: number; pos: THREE.Vector3; y0: number; y1: number }
  | { k: 'walk'; dur: number; path: WalkPath; v: number; ta: number; td: number; gait: number }
  | { k: 'step'; dur: number; from: THREE.Vector3; to: THREE.Vector3; y0: number; y1: number; lift: number }
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

class Job {
  starts: number[] = []; dist0: number[] = []; total = 0;
  m: Record<string, number> = {};
  constructor(readonly actor: SceneActor, readonly kind: 'enter' | 'exit', public start: number, readonly segs: Seg[], readonly target: SpotInfo | null,
    readonly pad: number, readonly podAt: THREE.Vector3 | null) {
    let t = 0, d = 0;
    for (const s of segs) {
      this.starts.push(t); this.dist0.push(d); t += s.dur;
      d += s.k === 'walk' ? s.path.length : s.k === 'turn' ? Math.abs(wrap(s.y1 - s.y0)) * TURN_STEP : s.k === 'step' || s.k === 'sit' ? s.from.distanceTo(s.to) : 0;
    }
    this.total = t;
  }
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
      case 'walk': { const w = walkS(sg, lt); sg.path.at(w.s, o.pos); o.yaw = sg.path.heading(w.s); o.dist += w.s; o.gait = (sg.v > 0 ? Math.min(1, w.v / sg.v) : 0) * sg.gait; break; }
      case 'step': { const e = smooth(k); o.pos.lerpVectors(sg.from, sg.to, e); o.yaw = sg.y0 + wrap(sg.y1 - sg.y0) * e; o.dist += sg.from.distanceTo(sg.to) * e; o.gait = 0.55 * Math.sin(Math.PI * k); break; }
      case 'sit': {
        const down = sg.s1 > sg.s0;
        const mk = down ? smooth(k / 0.7) : smooth((k - 0.3) / 0.7), sk = down ? smooth((k - 0.2) / 0.8) : smooth(k / 0.8);
        o.pos.lerpVectors(sg.from, sg.to, mk); o.yaw = sg.yaw; o.seat = sg.seat; o.sit = sg.s0 + (sg.s1 - sg.s0) * sk;
        o.dist += sg.from.distanceTo(sg.to) * mk; o.gait = 0.4 * Math.sin(Math.PI * Math.min(1, Math.max(0, down ? k / 0.7 : (k - 0.3) / 0.7))) * (1 - o.sit); o.back = down; break;
      }
    }
    return o;
  }
}

/** The frontline scene reads the live mover through this (pods to draw, dropship departures). */
export let activeFrontlineMover: FrontlineMover | null = null;

export class FrontlineMover implements AvatarMover {
  readonly inner: AvatarMover;
  readonly walker: WalkMover | null;
  readonly nav: RoomNav;
  private jobs = new Map<SceneActor, Job>();
  private layers = new Map<SceneActor, { loco: Locomotion; fn: (rt: Parameters<NonNullable<SceneActor['extraPose']>>[0], dt: number) => void }>();
  private seen = new WeakSet<SceneActor>();
  /** performer departures (s since T0) and pod landings (s since T0) — kept 90 s */
  private departs: ShipEvent[] = [];
  private landings: { id: string; at: number; pos: THREE.Vector3; yaw: number; key: string }[] = [];
  private tmp: Sample = { pos: V(), yaw: 0, sit: 0, seat: null, dist: 0, gait: 0, stride: 1, back: false };
  sceneMode = 'talk';
  manual = false;
  private clock = Date.now() / 1000;
  /** the frontline scene's on/off switch for the cinematics (default on) */
  enabled = true;
  readonly seed: number;

  constructor(readonly room: RoomInfo, readonly info: SceneInfo | undefined, readonly R: FrontlineRoom, inner: AvatarMover) {
    this.inner = inner;
    this.walker = inner instanceof WalkMover ? inner : null;
    this.nav = this.walker?.nav ?? new RoomNav(room);
    this.seed = ((info as unknown as { frontline?: { seed?: number } })?.frontline?.seed) ?? 23;
    activeFrontlineMover = this;
  }

  now() { return this.manual ? this.clock : Date.now() / 1000; }
  private get podOn() { return this.enabled && !!this.R.lz && !!this.room.doorOutside; }
  private get shipOn() { return this.enabled && this.R.pads.length > 0; }

  private layer(a: SceneActor) {
    let l = this.layers.get(a);
    if (!l) { const loco = new Locomotion(a); l = { loco, fn: (rt, dt) => loco.apply(rt, dt) }; this.layers.set(a, l); }
    a.extraPose = l.fn;
    return l;
  }
  private handBack(a: SceneActor) {
    const w = this.walker as unknown as { seen: WeakSet<SceneActor>; layer: (a: SceneActor) => unknown } | null;
    if (w) { w.seen.add(a); w.layer(a); }
  }
  private innerDrop(a: SceneActor) { (this.walker as unknown as { drop?: (a: SceneActor) => void } | null)?.drop?.(a); }

  // ---------------------------------------------------------------- AvatarMover
  enter(actor: SceneActor, spot: SpotInfo, ev?: MoveEvent) {
    const at = typeof ev?.at === 'number' ? ev.at / 1000 : null;
    const mine = this.jobs.get(actor);
    const seen = this.seen.has(actor);
    this.seen.add(actor);
    const fromOutside = (ev?.from ?? -1) < 0;
    const hidden = mine ? this.now() - mine.start < this.shownFrom(mine) : !actor.shown && !this.inner.busy(actor);
    if (!this.podOn || !fromOutside || (!seen && at === null) || !hidden) {
      if (mine) { this.jobs.delete(actor); if (seen || at !== null) this.handBack(actor); }
      else if (seen && at !== null) (this.walker as unknown as { seen?: WeakSet<SceneActor> } | null)?.seen?.add(actor);
      return this.inner.enter(actor, spot, ev);
    }
    this.innerDrop(actor);
    const job = this.buildEnter(actor, spot, at ?? this.now());
    this.jobs.set(actor, job);
    this.apply(actor, job, this.now() - job.start);
  }

  exit(actor: SceneActor, ev?: MoveEvent) {
    this.seen.add(actor);
    const at = typeof ev?.at === 'number' ? ev.at / 1000 : null;
    const mine = this.jobs.get(actor);
    if (!this.shipOn) { if (mine) { this.jobs.delete(actor); this.handBack(actor); } return this.inner.exit(actor, ev); }
    let pos: THREE.Vector3, yaw: number, sit = 0, seat: SpotInfo | null = null;
    if (mine) {
      const t = this.now() - mine.start;
      if (t < this.shownFrom(mine)) { this.jobs.delete(actor); actor.shown = false; return; }
      const s = mine.sample(t, this.tmp); pos = s.pos.clone(); yaw = s.yaw; sit = s.sit; seat = s.seat;
    } else {
      if (!actor.shown) { this.innerDrop(actor); return; }
      this.innerDrop(actor);
      const from = ev?.from ?? -1;
      const fs = from >= 0 ? this.room.spots[from] : null;
      if (fs && fs.position.distanceTo(actor.mount.position) < 0.05) { pos = fs.position.clone().setY(0); yaw = fs.yaw; sit = fs.pose === 'sit' ? 1 : 0; seat = fs.pose === 'sit' ? fs : null; }
      else { pos = actor.mount.position.clone().setY(0); yaw = actor.mount.rotation.y; sit = actor.sit; seat = actor.spot; }
    }
    const job = this.buildExit(actor, pos, yaw, sit, seat, at ?? this.now());
    if (!job) { if (mine) this.jobs.delete(actor); return this.inner.exit(actor, ev); }
    this.jobs.set(actor, job);
    this.apply(actor, job, this.now() - job.start);
  }

  move(actor: SceneActor, spot: SpotInfo, ev?: MoveEvent) {
    const mine = this.jobs.get(actor);
    if (mine) { this.jobs.delete(actor); this.handBack(actor); }
    else if (this.seen.has(actor)) (this.walker as unknown as { seen?: WeakSet<SceneActor> } | null)?.seen?.add(actor);
    this.seen.add(actor);
    this.inner.move(actor, spot, ev);
  }

  busy(actor: SceneActor) { return this.jobs.has(actor) || this.inner.busy(actor); }
  tracks(): MoverTrack[] {
    const now = this.now(), out = this.inner.tracks?.() ?? [];
    for (const [actor, j] of this.jobs) out.push({ actor, kind: j.kind, t: now - j.start, through: j.m.through ?? 0, arrive: j.total });
    return out;
  }
  samplePath(actor: SceneActor, t: number): THREE.Vector3 | null {
    const j = this.jobs.get(actor);
    if (!j) return this.inner.samplePath?.(actor, t) ?? null;
    return j.sample(t, { pos: V(), yaw: 0, sit: 0, seat: null, dist: 0, gait: 0, stride: 1, back: false }).pos.clone();
  }
  finishAll() { this.inner.finishAll(); this.update(0); }
  dispose() {
    this.inner.dispose();
    for (const a of this.layers.keys()) { a.extraPose = null; a.loco = 0; }
    this.jobs.clear(); this.layers.clear();
    if (activeFrontlineMover === this) activeFrontlineMover = null;
  }

  // ---------------------------------------------------------------- what the scene draws
  /** Drop-pod landings (impact time, s since T0) with their landing point. */
  pods() { return this.landings; }
  /** Performer departures (s since T0). */
  departures(): ShipEvent[] { return this.departs; }

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
    const lz = this.R.lz!, door = this.room.doorOutside!;
    // several arrivals at once: pods land side by side (by performer, stable on every page)
    const side = V(Math.cos(lz.yaw), 0, -Math.sin(lz.yaw));
    const off = ((hash32(actor.key) % 3) - 1) * 2.4;
    const podPos = lz.pos.clone().addScaledVector(side, off).setY(0);
    const outP = door.position.clone().addScaledVector(side, off).setY(0);
    const v = this.speed(actor) * 1.15;
    const segs: Seg[] = [];
    segs.push({ k: 'hold', dur: POD.out, pos: podPos.clone(), yaw: lz.yaw, sit: 0, seat: null });
    segs.push({ k: 'step', dur: STEP_OUT, from: podPos.clone(), to: outP.clone(), y0: lz.yaw, y1: lz.yaw, lift: 0.1 });
    segs.push({ k: 'hold', dur: POD.look, pos: outP.clone(), yaw: lz.yaw, sit: 0, seat: null });
    const rest = this.nav.fromPoint(door.position, false, spot);
    const w = this.walk([outP, ...rest.slice(1)], v);
    let pos = outP.clone(), yaw = lz.yaw;
    if (w) { this.turnTo(segs, outP, lz.yaw, w.path.heading(0)); segs.push(w); pos = w.path.at(w.path.length); yaw = w.path.heading(w.path.length); }
    this.turnTo(segs, pos, yaw, spot.yaw);
    if (spot.pose === 'sit') segs.push({ k: 'sit', dur: SIT_TIME, from: pos.clone(), to: spot.position.clone().setY(0), yaw: spot.yaw, s0: 0, s1: 1, seat: spot });
    else segs.push({ k: 'hold', dur: 0.5, pos: spot.position.clone().setY(0), yaw: spot.yaw, sit: 0, seat: null });
    const job = new Job(actor, 'enter', at, segs, spot, -1, podPos);
    const wi = w ? segs.indexOf(w) : -1;
    job.m = { through: POD.out + STEP_OUT, walk0: wi >= 0 ? job.starts[wi] : POD.out + STEP_OUT, walk1: wi >= 0 ? job.starts[wi] + w!.dur : job.total };
    const id = `${actor.key}:${at.toFixed(2)}`;
    if (!this.landings.some((l) => l.id === id)) this.landings.push({ id, at: at + POD.impact - T0, pos: podPos, yaw: lz.yaw, key: actor.key });
    return job;
  }

  private buildExit(actor: SceneActor, pos: THREE.Vector3, yaw: number, sit: number, seat: SpotInfo | null, at: number): Job | null {
    const R = this.R;
    const v = this.speed(actor) * 1.2;
    // the nearest pad whose ship is on standby from when we reach it until takeoff
    const cands = R.pads.map((p) => ({ p, d: p.approach.distanceTo(pos) })).sort((a, b) => a.d - b.d || a.p.index - b.p.index);
    const tA = at - T0;
    const ev = shipEvents(this.seed, R.pads.length, this.departs, tA - 60, tA + 120);
    let pick: { pad: typeof R.pads[number]; segs: Seg[]; w: Extract<Seg, { k: 'walk' }> | null; t0: number } | null = null;
    for (const { p } of cands) {
      const segs: Seg[] = [];
      let q = pos.clone(), y = yaw;
      if (sit > 0.01 && seat) {
        const T = this.nav.standPoint(seat);
        const to = q.clone().lerp(T, sit);
        segs.push({ k: 'sit', dur: SIT_TIME * sit, from: q, to, yaw: y, s0: sit, s1: 0, seat });
        q = to;
      }
      const back = this.nav.fromPoint(p.approach, false, seat ?? actor.spot).reverse();
      const route = back.length > 1 ? [q, ...back.slice(1)] : [q, p.approach];
      route.push(p.board.clone());
      const w = this.walk(route, v);
      if (w) { this.turnTo(segs, q, y, w.path.heading(0)); segs.push(w); y = w.path.heading(w.path.length); q = w.path.at(w.path.length); }
      const t0 = segs.reduce((s, x) => s + x.dur, 0);
      if (padFree(ev, p.index, tA + t0 - 1, tA + t0 + RAMP_STEP + TURN_IN + TAKEOFF + 0.5)) { pick = { pad: p, segs, w, t0 }; break; }
    }
    if (!pick) return null;
    const { pad, segs } = pick;
    const q = pad.board.clone(), y = pick.w ? pick.w.path.heading(pick.w.path.length) : yaw;
    const faceIn = Math.atan2(pad.fwd.x, pad.fwd.z);
    this.turnTo(segs, q, y, faceIn);
    const inside = pad.pos.clone().addScaledVector(pad.fwd, -2.6).setY(0);
    const tBoard = segs.reduce((s, x) => s + x.dur, 0);
    segs.push({ k: 'step', dur: RAMP_STEP, from: q, to: inside, y0: faceIn, y1: faceIn, lift: 0 });
    segs.push({ k: 'turn', dur: TURN_IN, pos: inside, y0: faceIn, y1: faceIn + Math.PI });
    segs.push({ k: 'hold', dur: TAKEOFF + 0.6, pos: inside, yaw: faceIn + Math.PI, sit: 0, seat: null });
    const job = new Job(actor, 'exit', at, segs, null, pad.index, null);
    const wi = pick.w ? segs.indexOf(pick.w) : -1;
    const tIn = tBoard + RAMP_STEP + TURN_IN;
    job.m = { walk0: wi >= 0 ? job.starts[wi] : 0, board: tBoard, inside: tIn, hide: tIn + 0.9, takeoff: tIn + TAKEOFF, through: tBoard };
    // ramp foot → inside rises with the ramp slope (y lift)
    job.m.rampH = 0.55;
    const id = `${actor.key}:${at.toFixed(2)}`;
    if (!this.departs.some((d) => d.id === id)) this.departs.push({ pad: pad.index, at: at + job.m.takeoff - T0, id, key: actor.key });
    return job;
  }

  private shownFrom(j: Job) { return j.kind === 'enter' ? POD.door0 + 0.25 : -Infinity; }
  private sampleShown(j: Job, t: number) {
    if (j.kind === 'exit') return t < j.m.hide;
    return t >= this.shownFrom(j);
  }

  // ---------------------------------------------------------------- per frame
  update(dt: number) {
    if (this.manual) this.clock += dt; else this.clock = Date.now() / 1000;
    const w = this.walker as unknown as { manual: boolean; clock: number } | null;
    if (w) { w.manual = this.manual; if (this.manual) w.clock = this.clock; }
    this.inner.update(dt);
    const now = this.now();
    for (const [a, j] of [...this.jobs]) {
      if (!a.runtime) { this.jobs.delete(a); continue; }
      const t = now - j.start;
      this.apply(a, j, t);
      if (t >= j.total) {
        this.jobs.delete(a);
        if (j.kind === 'enter') this.handBack(a);
        else { a.shown = false; a.offset.set(0, 0, 0); }
      }
    }
    const lim = now - T0 - 120;
    this.departs = this.departs.filter((d) => d.at > lim);
    this.landings = this.landings.filter((d) => d.at > lim);
  }

  private apply(a: SceneActor, j: Job, t: number) {
    const L = this.layer(a);
    const s = j.sample(t, this.tmp);
    a.mount.position.copy(s.pos);
    if (j.kind === 'exit' && t > j.m.board) a.mount.position.y += j.m.rampH * smooth((t - j.m.board) / RAMP_STEP);
    a.mount.rotation.set(0, s.yaw, 0);
    a.sit = s.sit;
    a.shown = this.sampleShown(j, t);
    a.appear = 1;
    a.updateSeat(s.seat ?? (s.sit > 0 ? j.target : null) ?? a.spot);
    if (t >= j.total) a.updateSeat();
    const l = L.loco;
    l.dist = s.dist; l.gait = s.gait; l.back = s.back; l.stride = s.stride; l.idle = 0;
    a.loco = s.gait;
    const walking = j.kind === 'enter' ? (t > j.m.walk0 - 0.4 && t < j.m.walk1 + 0.4 ? 1 : 0) : (t < j.m.board + RAMP_STEP ? 1 : 0);
    l.armW = walking; l.headW = 0.5 * walking;
  }

  /** The boarding / takeoff shot: from the set side of the pad, low, looking at the ramp; tilts up with the ship. */
  private padCam(pad: number, dt: number): { key: string; pose: CamPose; secs: number } | null {
    const P = this.R.pads[pad];
    if (!P) return null;
    const inward = P.fwd.clone().multiplyScalar(-1);
    const side = new THREE.Vector3(-inward.z, 0, inward.x);
    if (side.z < 0) side.multiplyScalar(-1);                 // (from the camera side of the room)
    const pos = P.pos.clone().addScaledVector(inward, 7.0).addScaledVector(side, 11).setY(5.0);
    const lift = dt < 0 ? 0 : 8 * smooth(dt / 3) + (dt > 3 ? 3.5 * (dt - 3) + 0.5 * (dt - 3) ** 2 : 0);
    const target = P.pos.clone().addScaledVector(P.fwd, dt > 3 ? 2 * (dt - 3) + 1.6 * (dt - 3) ** 2 : -2.4).setY(P.pos.y + 1.6 + lift);
    const d = pos.distanceTo(target);
    const fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan((6.5 + Math.max(0, dt) * 0.8) / d)), 34, 64);
    return { key: `hf:pad:${pad}`, pose: lookPose(pos, target, fov), secs: 0 };
  }

  followCamera(fo: SceneState['follow'], aspect: number, present: (a: SceneActor) => boolean): { key: string; pose: CamPose; secs: number } | null | undefined {
    void aspect;
    if (this.sceneMode === 'react') return undefined;
    const now = this.now();
    let best: { j: Job; t: number } | null = null;
    for (const j of this.jobs.values()) {
      const t = now - j.start;
      if (!(j.actor.key === '@host' ? fo.host : fo.guests)) continue;
      if (t < 0 || t > j.total + 0.4 || (j.kind === 'enter' && !present(j.actor))) continue;
      if (!best || t > best.t) best = { j, t };
    }
    const cam = (n: string) => this.room.cameras.get(n) ?? null;
    if (!best) {
      // a ship just left with someone aboard: watch it climb away for a few seconds
      const d = this.departs.filter((x) => (x.key === '@host' ? fo.host : fo.guests) && now - T0 - x.at > 0 && now - T0 - x.at < 7).sort((x, y) => y.at - x.at)[0];
      return d ? this.padCam(d.pad, now - T0 - d.at) : undefined;
    }
    const { j, t } = best, a = j.actor;
    if (j.kind === 'enter' && t < POD.out + STEP_OUT + POD.look * 0.7) { const c = cam('CAM_LZ'); if (c) return { key: 'hf:lz', pose: c, secs: 0 }; }
    if (j.kind === 'exit' && t > j.m.board - 1.2) return this.padCam(j.pad, t - j.m.takeoff);
    const samp = j.sample(t, { pos: V(), yaw: 0, sit: 0, seat: null, dist: 0, gait: 0, stride: 1, back: false });
    const h = (a.rest?.height ?? 1.6) * a.scale;
    const target = samp.pos.clone().setY(samp.pos.y + h * 0.6);
    const base = cam('CAM_WIDE')?.position ?? target.clone().add(V(0, 0.5, 4));
    const away = base.clone().sub(target);
    const pos = away.length() < 2.2 ? target.clone().addScaledVector(away.normalize(), 2.2) : base.clone();
    const fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan((h * 0.9) / pos.distanceTo(target))), 18, 50);
    return { key: `hf:follow:${a.key}`, pose: lookPose(pos, target, fov), secs: 0 };
  }
}

// ------------------------------------------------------------------------------------------------ install
// Rooms with a scene.json `frontline` key + LZ / pad anchors get the FrontlineMover (wrapping whatever mover the room
// would otherwise get); every other room keeps the previous factory's choice.
const prev = currentMoverFactory();
setMoverFactory((room, info) => {
  const inner = prev(room, info);
  const cfg = (info as unknown as { frontline?: { on?: boolean } } | undefined)?.frontline;
  if (!cfg || cfg.on === false) return inner;
  const R = frontlineRoomOf(room.root);
  if (!R || (!R.lz && !R.pads.length)) return inner;
  return new FrontlineMover(room, info, R, inner);
});
