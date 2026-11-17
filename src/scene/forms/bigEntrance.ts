// Big-character entrance (AvatarMover) for rooms with scene.json `bigEntrance` (shared/forms.ts parseBigEntrance):
// large / giant / mech / vehicle performers (shared/occupant.ts; `bigEntrance.classes`) never squeeze through the
// people door. Styles:
//   walk  the big door (hangar leaves slide apart / iris blades spiral open) -> they stand backlit in the opening ->
//         walk the BIG_PATH_* lane (runway chevrons chase towards the room) -> step up onto their spot (a docking
//         cradle) -> turn to face the room -> the door closes behind them. The walk starts late enough that the zone's
//         form (src/scene/forms/formsScene.ts: desk splits, cradle rises) is settled when they arrive.
//   lift  a floor lift at the spot: hatch opens, steam, they rise from below on the platform (also used when a big
//         performer swaps in mid-show: the set transforms around the spot, then the lift brings them up).
//   drop  from above: a retro-burn landing (thrusters under the feet), impact dust ring, sparks, a light hit.
// Exits play the style backwards. Everyone else (and moves between ordinary spots) goes to the wrapped mover (walks).
// DETERMINISTIC like WalkMover: each job is a pure function of (room data, the performer's size, the host's move stamp,
// the zone's form stamp), sampled at wall-clock time on every page; the follow camera follows the job's timeline.
import * as THREE from 'three';
import type { SceneActor } from '../actor.ts';
import type { RoomInfo, SpotInfo } from '../contract.ts';
import { lookPose, type CamPose } from '../cameraRig.ts';
import { Locomotion } from '../locomotion.ts';
import { currentMoverFactory, setMoverFactory, type AvatarMover, type MoveEvent, type MoverTrack } from '../mover.ts';
import { WalkPath } from '../navigation.ts';
import { RoomRays } from '../twoShot.ts';
import { WalkMover } from '../walkMover.ts';
import type { SceneInfo, SceneState } from '../../../shared/types.ts';
import { occupantOf, sanitizeOccupantRules, type Occupant, type OccupantRules } from '../../../shared/occupant.ts';
import { POWERUP_DEFAULT, bigStyleOf, ease, parseBigEntrance, usesBigEntrance, type BigEntranceDef, type BigStyle, type Vec3 } from '../../../shared/forms.ts';
import { bigOfRoom, formsOfRoom, type BigFx, type BigFxSource } from './formsScene.ts';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const smooth = (v: number) => { const k = v < 0 ? 0 : v > 1 ? 1 : v; return k * k * (3 - 2 * k); };
const ACCEL = 0.9, DECEL = 1.1, TURN_RATE = 0.9, SETTLE = 1.4;

type Seg =
  | { k: 'hold'; dur: number; pos: THREE.Vector3; yaw: number }
  | { k: 'turn'; dur: number; pos: THREE.Vector3; y0: number; y1: number }
  | { k: 'walk'; dur: number; path: WalkPath; v: number; ta: number; td: number; yA: number; yB: number; climb: number }
  | { k: 'vert'; dur: number; pos: THREE.Vector3; yaw: number; y0: number; y1: number; ease: 'inOutCubic' | 'outCubic' | 'inCubic' };
interface Sample { pos: THREE.Vector3; yaw: number; dist: number; gait: number; walking: boolean }

/** A big entrance / exit / hop in progress. Times in seconds since `start` (the move stamp, mover clock). */
export class BigJob {
  starts: number[] = []; dist0: number[] = []; total = 0;
  /** Where an exit starts (the tracking camera's lane runs from there to the door). */
  from: THREE.Vector3 | null = null;
  /** walk window, door window, lift window, drop window, shown from, hidden at (exit), through the door */
  m = { w0: -1, w1: -1, open0: -1, open1: -1, close0: Infinity, close1: Infinity, lift0: -1, lift1: -1, drop0: -1, drop1: -1, pow0: -1, pow1: -1, shown: 0, hide: Infinity, through: 0, arrive: 0 };
  /** A crane drop (on the gantry hook: no thrusters, no sway). */
  crane = false;
  constructor(readonly actor: SceneActor, readonly kind: 'enter' | 'exit' | 'hop', readonly style: BigStyle, public start: number, readonly segs: Seg[], readonly spot: SpotInfo | null, readonly height: number) {
    let t = 0, d = 0;
    for (const s of segs) {
      this.starts.push(t); this.dist0.push(d); t += s.dur;
      d += s.k === 'walk' ? s.path.length : s.k === 'turn' ? Math.abs(wrap(s.y1 - s.y0)) * 0.5 : 0;
    }
    this.total = t;
  }
  sample(t: number, o: Sample): Sample {
    const n = this.segs.length;
    let i = 0;
    const tt = Math.max(0, Math.min(t, this.total));
    while (i < n - 1 && tt >= this.starts[i + 1]) i++;
    const sg = this.segs[i], lt = Math.min(sg.dur, tt - this.starts[i]), k = sg.dur > 0 ? lt / sg.dur : 1;
    o.gait = 0; o.dist = this.dist0[i]; o.walking = false;
    switch (sg.k) {
      case 'hold': o.pos.copy(sg.pos); o.yaw = sg.yaw; break;
      case 'turn': { const d = wrap(sg.y1 - sg.y0); o.pos.copy(sg.pos); o.yaw = sg.y0 + d * smooth(k); o.dist += Math.abs(d) * 0.5 * smooth(k); o.gait = 0.5 * Math.sin(Math.PI * k); o.walking = true; break; }
      case 'walk': {
        const { v, ta, td, dur } = sg, L = sg.path.length;
        let s = 0, vel = 0;
        if (lt <= 0) { s = 0; vel = 0; } else if (lt >= dur) { s = L; vel = 0; }
        else if (lt < ta) { s = (v * lt * lt) / (2 * ta); vel = (v * lt) / ta; }
        else if (lt > dur - td) { const r = dur - lt; s = L - (v * r * r) / (2 * td); vel = (v * r) / td; }
        else { s = (v * ta) / 2 + v * (lt - ta); vel = v; }
        sg.path.at(s, o.pos);
        // the last `climb` metres step up / down onto the destination (a cradle deck)
        const u = sg.climb > 0 ? smooth((s - (L - sg.climb)) / sg.climb) : s >= L ? 1 : 0;
        o.pos.y = sg.yA + (sg.yB - sg.yA) * u;
        o.yaw = sg.path.heading(s); o.dist += s; o.gait = v > 0 ? Math.min(1, vel / v) : 0; o.walking = true;
        break;
      }
      case 'vert': o.pos.copy(sg.pos); o.pos.y = sg.y0 + (sg.y1 - sg.y0) * ease(sg.ease, k); o.yaw = sg.yaw; break;
    }
    return o;
  }
}

const freshSample = (): Sample => ({ pos: V(), yaw: 0, dist: 0, gait: 0, walking: false });

/** The live big-entrance mover of the room on this page (tests / debugging). */
export let activeBigMover: BigEntranceMover | null = null;

export class BigEntranceMover implements AvatarMover, BigFxSource {
  readonly walker: WalkMover | null;
  private jobs = new Map<SceneActor, BigJob>();
  private layers = new Map<SceneActor, { loco: Locomotion; fn: (rt: Parameters<NonNullable<SceneActor['extraPose']>>[0], dt: number) => void }>();
  private seen = new WeakSet<SceneActor>();
  /** The spot index each performer was last sent to (SceneRuntime.reconcile sets actor.spot BEFORE calling move, so the
   *  actor can't tell a reseat from a form change under them). */
  private dest = new WeakMap<SceneActor, number>();
  private rays: RoomRays | null = null;
  readonly rules: OccupantRules;
  /** door parts: hangar leaves (slide along local X) / iris blades (turn about local Z) */
  private doorParts: { node: THREE.Object3D; rest: THREE.Vector3; restQ: THREE.Quaternion; dir: number; iris: boolean }[] = [];
  private doorAt: { pos: THREE.Vector3; inward: THREE.Vector3; center: THREE.Vector3 } | null = null;
  private lift: { root: THREE.Object3D; platform: THREE.Object3D | null; platRest: THREE.Vector3; hatches: { node: THREE.Object3D; rest: THREE.Vector3; dir: number }[]; radius: number } | null = null;
  private pathPts: THREE.Vector3[] = [];
  /** Per destination zone (SPEC `paths: { host, pad }`). */
  private zonePaths = new Map<string, THREE.Vector3[]>();
  private hook: { node: THREE.Object3D; rest: THREE.Vector3 } | null = null;
  private outside: THREE.Vector3 | null = null;
  manual = false;
  private clock = Date.now() / 1000;
  /** Tests: force a style for new jobs ('walk' | 'iris' | 'lift' | 'drop' | 'crane' | 'powerup' | 'instant'). */
  forceStyle: string | null = null;
  readonly debugLog: string[] = [];

  constructor(readonly room: RoomInfo, readonly info: SceneInfo | undefined, readonly def: BigEntranceDef, readonly inner: AvatarMover) {
    this.walker = inner instanceof WalkMover ? inner : null;
    this.rules = sanitizeOccupantRules((info as unknown as { occupants?: unknown } | undefined)?.occupants);
    // (the inner mover's own API - SpaceMover.spaceState / sceneMode / spaceLaunches ... - stays reachable: forwardInner)
    forwardInner(this, inner);
    this.resolve();
    activeBigMover = this;
    bigOfRoom.set(room, this);
  }

  /** Room nodes the style uses (kit pieces exist once the forms engine attached: resolved again on first use). */
  private resolved = false;
  private resolve() {
    const root = this.room.root, d = this.def;
    const byName = (n: string) => root.getObjectByName(n) ?? null;
    const w = (v: Vec3) => root.localToWorld(V(v[0], v[1], v[2]));
    this.doorParts = []; this.doorAt = null; this.lift = null; this.pathPts = []; this.outside = null;
    if (d.door && d.door.kind !== 'none') {
      const dn = byName(d.door.node);
      if (dn) {
        dn.updateWorldMatrix(true, true);
        const pos = dn.getWorldPosition(V()), q = dn.getWorldQuaternion(new THREE.Quaternion());
        const inward = V(0, 0, 1).applyQuaternion(q).setY(0).normalize();
        this.doorAt = { pos, inward, center: pos.clone() };
        const iris = d.door.kind === 'iris';
        const pre = iris && d.door.leaves === `${d.door.node}_` ? `${d.door.node}_BLADE_` : d.door.leaves;
        root.traverse((o) => {
          if (!o.name.startsWith(pre)) return;
          const rest = o.name.slice(pre.length);
          if (iris ? /^\d{1,2}$/.test(rest) : rest === 'L' || rest === 'R') { const r = restOf(o); this.doorParts.push({ node: o, rest: r.p, restQ: r.q, dir: rest === 'L' ? -1 : 1, iris }); }
        });
        if (iris) { const b = new THREE.Box3().setFromObject(dn); if (!b.isEmpty()) this.doorAt.center = b.getCenter(V()); }
      }
    }
    const prefixPts = (pre: string) => {
      const pts: [number, THREE.Vector3][] = [];
      root.traverse((o) => { const m = o.name.startsWith(pre) ? /^(\d+)$/.exec(o.name.slice(pre.length)) : null; if (m) pts.push([+m[1], o.getWorldPosition(V())]); });
      return pts.sort((a, b) => a[0] - b[0]).map((p) => p[1]);
    };
    if (typeof d.path === 'string') this.pathPts = prefixPts(d.path);
    else if (Array.isArray(d.path)) this.pathPts = d.path.map(w);
    this.zonePaths.clear();
    for (const [z, pre] of Object.entries(d.paths)) { const pts = prefixPts(pre); if (pts.length) this.zonePaths.set(z, pts); }
    if (!this.pathPts.length && this.zonePaths.size) this.pathPts = [...this.zonePaths.values()][0];
    this.hook = null;
    if (d.drop.hook) { const h = byName(d.drop.hook); if (h) this.hook = { node: h, rest: restOf(h).p }; }
    if (typeof d.outside === 'string') { const o = byName(d.outside); if (o) this.outside = o.getWorldPosition(V()); }
    else if (Array.isArray(d.outside)) this.outside = w(d.outside);
    if (!this.outside && this.doorAt) this.outside = this.doorAt.pos.clone().addScaledVector(this.doorAt.inward, -4);
    if (d.lift.node) {
      const ln = byName(d.lift.node);
      if (ln) {
        const platform = byName(`${d.lift.node}_PLATFORM`);
        const hatches: { node: THREE.Object3D; rest: THREE.Vector3; dir: number }[] = [];
        for (const sfx of ['L', 'R']) { const h = byName(`${d.lift.hatch ?? `${d.lift.node}_HATCH_`}${sfx}`); if (h) hatches.push({ node: h, rest: restOf(h).p, dir: sfx === 'L' ? -1 : 1 }); }
        const b = new THREE.Box3().setFromObject(ln);
        this.lift = { root: ln, platform, platRest: platform ? restOf(platform).p : V(), hatches, radius: b.isEmpty() ? 1.6 : Math.max(0.8, (b.max.x - b.min.x) / 2 - 0.2) };
      }
    }
    this.resolved = !!(this.doorAt || this.lift || this.pathPts.length || !d.door);
  }

  /** Seconds, on the same clock as SceneState.moves[].at / 1000 (the wrapped mover's, unless a test froze ours). */
  now() { return this.manual ? this.clock : (this.inner as unknown as { now?: () => number }).now?.() ?? Date.now() / 1000; }
  refresh() { this.resolve(); }

  // ---------------------------------------------------------------- who
  occupant(a: SceneActor): Occupant | null {
    const f = formsOfRoom(this.room);
    if (f?.active || f?.big) return f.occupantOf(a);
    return a.runtime ? occupantOf(a.runtime.profile, this.rules, a.rest?.height, this.info?.avatarHeight ?? 1.5) : null;
  }
  /** Big performers this mover plays: the room's `bigEntrance` rules; rooms without one: big mechs / vehicles (power-up). */
  claims(actor: SceneActor, spot?: SpotInfo | null): boolean {
    void spot;
    const o = this.occupant(actor);
    if (!o) return false;
    return this.def.explicit ? usesBigEntrance(this.def, o) : o.big && (o.kind === 'mech' || o.kind === 'vehicle');
  }

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
    const seen = this.seen.has(actor);
    this.seen.add(actor);
    this.dest.set(actor, spot.index);
    if (!this.claims(actor, spot)) {
      if (this.jobs.delete(actor)) this.handBack(actor);
      return this.inner.enter(actor, spot, ev);
    }
    if (!this.resolved) this.resolve();
    this.innerDrop(actor);
    // a page (re)load with no fresh stamp, or a stamp whose entrance is long over: just there
    const start = at ?? (seen ? this.now() : null);
    if (start === null || this.styleFor('enter').style === 'instant') { this.snap(actor, spot); return; }
    const job = this.buildEnter(actor, spot, start, (ev?.from ?? -1) >= 0 ? 'hop' : 'enter');
    if (this.now() - job.start > job.total + 1) { this.snap(actor, spot); return; }
    this.jobs.set(actor, job);
    this.apply(actor, job, this.now() - job.start);
  }

  exit(actor: SceneActor, ev?: MoveEvent) {
    this.seen.add(actor);
    this.dest.delete(actor);
    const at = typeof ev?.at === 'number' ? ev.at / 1000 : null;
    const mine = this.jobs.get(actor);
    if (!mine && !this.claims(actor, actor.spot)) return this.inner.exit(actor, ev);
    if (!this.resolved) this.resolve();
    let pos: THREE.Vector3, yaw: number;
    if (mine) {
      const t = this.now() - mine.start;
      if (mine.kind !== 'exit' && t < mine.m.shown) { this.jobs.delete(actor); actor.shown = false; return; }
      const s = mine.sample(t, freshSample()); pos = s.pos.clone(); yaw = s.yaw;
    } else {
      if (!actor.shown) { this.innerDrop(actor); return; }
      this.innerDrop(actor);
      pos = actor.mount.position.clone(); yaw = actor.mount.rotation.y;
    }
    const start = at ?? this.now();
    if (this.styleFor('exit').style === 'instant') { this.jobs.delete(actor); actor.shown = false; this.handBack(actor); return; }
    const job = this.buildExit(actor, pos, yaw, start);
    if (this.now() - job.start > job.total + 1) { this.jobs.delete(actor); actor.shown = false; return; }
    this.jobs.set(actor, job);
    this.apply(actor, job, this.now() - job.start);
  }

  move(actor: SceneActor, spot: SpotInfo, ev?: MoveEvent) {
    const mine = this.jobs.get(actor);
    const big = this.claims(actor, spot);
    // (where they were headed: our own record, else the host's move stamp; a reseat to another spot is a walk)
    const was = mine?.spot ? mine.spot.index : this.dest.get(actor) ?? (typeof ev?.from === 'number' && ev.from >= 0 ? ev.from : -1);
    this.dest.set(actor, spot.index);
    // a big performer whose zone spot changes form under them (an avatar swap at the desk, a zone hop): the lift
    if (big && was === spot.index) {
      if (!this.resolved) this.resolve();
      if (mine && mine.kind !== 'exit' && mine.spot === spot) return;
      const f = formsOfRoom(this.room);
      const ready = f?.readyAt(spot.index) ?? 0;
      const start = ready > 0 ? Math.min(this.now(), ready / 1000 - 2) : (typeof ev?.at === 'number' && this.now() - ev.at / 1000 < 3 ? ev.at / 1000 : this.now());
      if (mine && mine.kind === 'enter' && this.now() - mine.start < mine.total) {
        // still coming in: same entrance, new destination (re-timed from its own stamp)
        const j = this.buildEnter(actor, spot, mine.start, 'enter');
        this.jobs.set(actor, j); this.apply(actor, j, this.now() - j.start); return;
      }
      this.innerDrop(actor);
      const job = this.buildEnter(actor, spot, start, 'hop');
      this.jobs.set(actor, job); this.apply(actor, job, this.now() - job.start);
      return;
    }
    if (mine) { this.jobs.delete(actor); this.handBack(actor); }
    this.seen.add(actor);
    this.inner.move(actor, spot, ev);
  }

  busy(actor: SceneActor) { return this.jobs.has(actor) || this.inner.busy(actor); }
  release(actor: SceneActor) { if (this.jobs.delete(actor)) this.handBack(actor); this.inner.release?.(actor); }
  tracks(): MoverTrack[] {
    const now = this.now(), out = this.inner.tracks?.() ?? [];
    for (const [actor, j] of this.jobs) out.push({ actor, kind: j.kind === 'hop' ? 'move' : j.kind, t: now - j.start, through: j.m.through, arrive: j.total });
    return out;
  }
  samplePath(actor: SceneActor, t: number): THREE.Vector3 | null {
    const j = this.jobs.get(actor);
    if (!j) return this.inner.samplePath?.(actor, t) ?? null;
    return j.sample(t, freshSample()).pos.clone();
  }
  finishAll() { this.inner.finishAll(); this.update(0); }
  dispose() {
    this.inner.dispose();
    for (const a of this.layers.keys()) { a.extraPose = null; a.loco = 0; }
    this.jobs.clear(); this.layers.clear();
    this.setDoor(0); this.setLift(null, 0);
    if (activeBigMover === this) activeBigMover = null;
    if (bigOfRoom.get(this.room) === this) bigOfRoom.delete(this.room);
  }
  /** Debug: the jobs on this page. */
  jobsInfo() {
    const now = this.now();
    return [...this.jobs.values()].map((j) => ({ key: j.actor.key, kind: j.kind, style: j.style, t: +(now - j.start).toFixed(2), total: +j.total.toFixed(2), m: Object.fromEntries(Object.entries(j.m).map(([k, v]) => [k, Number.isFinite(v) ? +v.toFixed(2) : null])), spot: j.spot?.index ?? null }));
  }

  private snap(actor: SceneActor, spot: SpotInfo) {
    this.jobs.delete(actor);
    actor.place(actor.placementAt(spot));
    actor.shown = true; actor.appear = 1;
    this.handBack(actor);
  }

  // ---------------------------------------------------------------- timelines
  private speed(actor: SceneActor) {
    const l = this.layer(actor).loco;
    const h = (actor.rest?.height ?? 1.6) * actor.scale;
    // a big stride: about 0.42 x the shown height per second, never faster than the gait allows
    return THREE.MathUtils.clamp(Math.min(0.42 * h, l.maxSpeed()) * this.def.speed, 0.45, 3.2);
  }
  /** The style of a new job: a test's force, the host's Live-panel choice (forms bag `entrance`), the room's scene.json;
   *  'auto' = the big door when the room has one, else the lift (rooms without a big entrance: the power-up). */
  private styleFor(kind: 'enter' | 'exit' | 'hop'): { style: BigStyle; crane: boolean } {
    const forced = this.forceStyle ? bigStyleOf(this.forceStyle) : null;
    const host = bigStyleOf(formsOfRoom(this.room)?.bagEntrance() ?? null);
    let want = forced && forced.style !== 'auto' ? forced : host && host.style !== 'auto' ? host : null;
    if (kind === 'hop') return want?.style === 'instant' ? { style: 'instant', crane: false } : want?.style === 'powerup' ? want as { style: BigStyle; crane: boolean } : { style: this.def.explicit ? 'lift' : 'powerup', crane: false };
    if (!want) want = kind === 'exit' && this.def.exit !== 'auto' ? { style: this.def.exit, crane: false } : { style: this.def.style, crane: this.def.crane };
    if (want.style === 'walk' && !this.outside) return { style: this.def.explicit ? 'lift' : 'powerup', crane: false };
    if (want.style !== 'auto') return want as { style: BigStyle; crane: boolean };
    if (!this.def.explicit) return { style: 'powerup', crane: false };
    return { style: this.outside && (this.doorAt || this.pathPts.length) ? 'walk' : 'lift', crane: false };
  }
  private walkSeg(pts: THREE.Vector3[], v: number, yA: number, yB: number): Extract<Seg, { k: 'walk' }> | null {
    const clean: THREE.Vector3[] = [];
    for (const p of pts) if (!clean.length || clean[clean.length - 1].distanceTo(p.clone().setY(clean[clean.length - 1].y)) > 0.1) clean.push(p.clone().setY(0));
    if (clean.length < 2) return null;
    const path = new WalkPath(clean);
    if (path.length < 0.05) return null;
    let vv = v;
    if (path.length < (vv * (ACCEL + DECEL)) / 2) vv = (2 * path.length) / (ACCEL + DECEL);
    return { k: 'walk', dur: path.length / vv + (ACCEL + DECEL) / 2, path, v: vv, ta: ACCEL, td: DECEL, yA, yB, climb: Math.abs(yB - yA) > 0.02 ? Math.min(1.6, path.length * 0.3) : 0 };
  }
  private turn(segs: Seg[], pos: THREE.Vector3, y0: number, y1: number) { if (Math.abs(wrap(y1 - y0)) > 0.05) segs.push({ k: 'turn', dur: 0.4 + Math.abs(wrap(y1 - y0)) / TURN_RATE, pos: pos.clone(), y0, y1 }); }
  /** Seconds after `start` when the destination zone's form is settled (0 = no wait). */
  private readyIn(spot: SpotInfo, start: number): number {
    const r = formsOfRoom(this.room)?.readyAt(spot.index) ?? 0;
    return r > 0 ? Math.max(0, r / 1000 - start) : 0;
  }

  private buildEnter(actor: SceneActor, spot: SpotInfo, at: number, kind: 'enter' | 'hop'): BigJob {
    const { style, crane } = this.styleFor(kind);
    const H = (actor.rest?.height ?? 1.6) * actor.scale;
    const ready = this.readyIn(spot, at);
    const segs: Seg[] = [];
    let job: BigJob;
    if (style === 'walk') {
      const v = this.speed(actor);
      const out = this.outside!;
      const zone = formsOfRoom(this.room)?.zoneForSpot(spot.index) ?? null;
      const lane = (zone && this.zonePaths.get(zone)) || this.pathPts;
      const pts = [out, ...lane, ...spot.approach, spot.position];
      const w = this.walkSeg(pts, v, out.y, spot.position.y);
      const ph = this.def.phases;
      const doorOpen = ph.irisOpen ? Math.max(0.2, ph.irisOpen[1] - ph.irisOpen[0]) : this.def.door ? this.def.door.open : 0;
      const open0 = ph.irisOpen ? ph.irisOpen[0] : 0.4;
      // the walk starts once the door is mostly open (SPEC phases.walkFrom), and late enough to arrive as the zone settles
      const w0 = Math.max(ph.walkFrom ?? open0 + doorOpen * 0.75 + 0.8, w ? ready - w.dur + 0.6 : 0);
      const y0 = w ? w.path.heading(0) : spot.yaw;
      segs.push({ k: 'hold', dur: w0, pos: out.clone(), yaw: y0 });
      let pos = out.clone(), yaw = y0;
      if (w) { segs.push(w); pos = w.path.at(w.path.length).setY(spot.position.y); yaw = w.path.heading(w.path.length); }
      this.turn(segs, pos, yaw, spot.yaw);
      segs.push({ k: 'hold', dur: SETTLE, pos: spot.position.clone(), yaw: spot.yaw });
      job = new BigJob(actor, kind, 'walk', at, segs, spot, H);
      job.m.w0 = w0; job.m.w1 = w0 + (w?.dur ?? 0);
      job.m.open0 = open0; job.m.open1 = open0 + doorOpen;
      // the door closes once they are well through it
      const doorS = this.doorAt && w ? nearestS(w.path, this.doorAt.pos) + Math.max(2, H * 0.6) : 0;
      const tPass = w ? w0 + timeAtS(w, doorS) : w0;
      job.m.through = tPass;
      job.m.close0 = tPass + 0.4; job.m.close1 = job.m.close0 + (this.def.door?.close ?? 2);
      job.m.shown = open0 + 0.2;
      job.m.arrive = job.m.w1;
    } else if (style === 'drop') {
      // (a crane drop hangs on the gantry hook: slower, eased both ways, no thrusters)
      const fall = this.def.drop.dur * (crane ? 1.4 : 1), Hd = this.def.drop.height;
      const d0 = Math.max(0.6, ready - fall + 0.4);
      segs.push({ k: 'hold', dur: d0, pos: spot.position.clone().setY(spot.position.y + Hd), yaw: spot.yaw });
      segs.push({ k: 'vert', dur: fall, pos: spot.position.clone(), yaw: spot.yaw, y0: spot.position.y + Hd, y1: spot.position.y, ease: crane ? 'inOutCubic' : 'outCubic' });
      segs.push({ k: 'hold', dur: SETTLE + 0.6, pos: spot.position.clone(), yaw: spot.yaw });
      job = new BigJob(actor, kind, 'drop', at, segs, spot, H);
      job.crane = crane;
      job.m.drop0 = d0; job.m.drop1 = d0 + fall; job.m.shown = d0; job.m.through = d0 + fall; job.m.arrive = d0 + fall;
    } else if (style === 'powerup') {
      // at the spot: folded low, then the hull rises in hydraulic steps, lamps on, steam (SPEC 2.6 powerup)
      const dur = this.def.powerup.dur, p0 = Math.max(0.3, ready - dur * 0.5);
      segs.push({ k: 'hold', dur: p0 + dur + 0.4, pos: spot.position.clone(), yaw: spot.yaw });
      job = new BigJob(actor, kind, 'powerup', at, segs, spot, H);
      job.m.pow0 = p0; job.m.pow1 = p0 + dur; job.m.shown = p0; job.m.through = p0; job.m.arrive = p0 + dur;
    } else {
      const rise = this.def.lift.dur, open = this.def.lift.open;
      const depth = H + 0.6;
      // (a swap at the spot: the model change happens hidden in the steam - SPEC styles.lift.hide)
      const r0 = Math.max(0.3 + open * 0.8, ready - rise * 0.5, this.def.lift.hide ? this.def.lift.hide[1] : 0);
      segs.push({ k: 'hold', dur: r0, pos: spot.position.clone().setY(spot.position.y - depth), yaw: spot.yaw });
      segs.push({ k: 'vert', dur: rise, pos: spot.position.clone(), yaw: spot.yaw, y0: spot.position.y - depth, y1: spot.position.y, ease: 'inOutCubic' });
      segs.push({ k: 'hold', dur: SETTLE * 0.6, pos: spot.position.clone(), yaw: spot.yaw });
      job = new BigJob(actor, kind, 'lift', at, segs, spot, H);
      job.m.lift0 = r0; job.m.lift1 = r0 + rise; job.m.open0 = r0 - open; job.m.open1 = r0; job.m.shown = r0; job.m.through = r0 + rise * 0.5; job.m.arrive = r0 + rise;
    }
    this.log(`${actor.key} ${kind} ${job.style}${job.crane ? ' (crane)' : ''} total ${job.total.toFixed(1)} s (ready +${ready.toFixed(1)} s)`);
    return job;
  }

  private buildExit(actor: SceneActor, pos: THREE.Vector3, yaw: number, at: number): BigJob {
    const { style, crane } = this.styleFor('exit');
    const H = (actor.rest?.height ?? 1.6) * actor.scale;
    const segs: Seg[] = [];
    let job: BigJob;
    if (style === 'walk') {
      const v = this.speed(actor);
      const out = this.outside!;
      const pts = [pos, ...[...this.pathPts].reverse(), out];
      const w = this.walkSeg(pts, v, pos.y, out.y);
      const open0 = 0.2, doorOpen = this.def.door?.open ?? 0;
      segs.push({ k: 'hold', dur: 0.6, pos: pos.clone(), yaw });
      if (w) { this.turn(segs, pos, yaw, w.path.heading(0)); }
      const w0 = segs.reduce((s, x) => s + x.dur, 0);
      if (w) segs.push(w);
      segs.push({ k: 'hold', dur: 0.8, pos: out.clone(), yaw: w ? w.path.heading(w.path.length) : yaw });
      job = new BigJob(actor, 'exit', 'walk', at, segs, null, H);
      job.from = pos.clone();
      job.m.w0 = w0; job.m.w1 = w0 + (w?.dur ?? 0); job.m.open0 = open0; job.m.open1 = open0 + doorOpen;
      job.m.close0 = job.m.w1 + 0.3; job.m.close1 = job.m.close0 + (this.def.door?.close ?? 2);
      job.m.hide = job.m.w1 + 0.6; job.m.through = job.m.w1;
    } else if (style === 'drop') {
      const fall = this.def.drop.dur, Hd = this.def.drop.height;
      segs.push({ k: 'hold', dur: 0.8, pos: pos.clone(), yaw });
      segs.push({ k: 'vert', dur: fall, pos: pos.clone(), yaw, y0: pos.y, y1: pos.y + Hd, ease: 'inCubic' });
      job = new BigJob(actor, 'exit', 'drop', at, segs, null, H);
      job.crane = crane;
      job.m.drop0 = 0.8; job.m.drop1 = 0.8 + fall; job.m.hide = 0.8 + fall; job.m.through = 0.8 + fall;
    } else if (style === 'powerup') {
      const dur = this.def.powerup.dur;
      segs.push({ k: 'hold', dur: dur + 0.6, pos: pos.clone(), yaw });
      job = new BigJob(actor, 'exit', 'powerup', at, segs, null, H);
      job.m.pow0 = 0.2; job.m.pow1 = 0.2 + dur; job.m.hide = 0.2 + dur; job.m.through = 0.2 + dur;
    } else {
      const rise = this.def.lift.dur, open = this.def.lift.open, depth = H + 0.6;
      segs.push({ k: 'hold', dur: open + 0.3, pos: pos.clone(), yaw });
      segs.push({ k: 'vert', dur: rise, pos: pos.clone(), yaw, y0: pos.y, y1: pos.y - depth, ease: 'inOutCubic' });
      job = new BigJob(actor, 'exit', 'lift', at, segs, null, H);
      job.m.lift0 = open + 0.3; job.m.lift1 = open + 0.3 + rise; job.m.open0 = 0.3; job.m.open1 = 0.3 + open;
      job.m.close0 = job.m.lift1 + 0.2; job.m.close1 = job.m.close0 + open; job.m.hide = job.m.lift1; job.m.through = job.m.lift1;
    }
    this.log(`${actor.key} exit ${job.style} total ${job.total.toFixed(1)} s`);
    return job;
  }
  private log(s: string) { this.debugLog.push(s); if (this.debugLog.length > 30) this.debugLog.shift(); }

  // ---------------------------------------------------------------- per frame
  update(dt: number) {
    // (a frozen test clock reaches the wrapped mover too: WalkMover / FrontlineMover / SpaceMover all have manual + clock
    //  and advance it by dt in their own update - so they get the clock BEFORE this step: handing them the advanced one
    //  put them one frame (1 / fps s) ahead of the stamps, and the same walk differed between frame rates)
    const w = this.inner as unknown as { manual?: boolean; clock?: number };
    if (typeof w.manual === 'boolean') { w.manual = this.manual; if (this.manual) w.clock = this.clock; }
    if (this.manual) this.clock += dt; else this.clock = Date.now() / 1000;
    this.inner.update(dt);
    const now = this.now();
    let door = 0, liftJob: { j: BigJob; t: number } | null = null;
    for (const [a, j] of [...this.jobs]) {
      if (!a.runtime) { this.jobs.delete(a); continue; }
      const t = now - j.start;
      this.apply(a, j, t);
      if (j.style === 'walk' && j.m.open0 >= 0) door = Math.max(door, smooth((t - j.m.open0) / Math.max(0.1, j.m.open1 - j.m.open0)) * (1 - smooth((t - j.m.close0) / Math.max(0.1, j.m.close1 - j.m.close0))));
      if (j.style === 'lift' && t > j.m.open0 - 0.5 && t < (j.kind === 'exit' ? j.m.close1 : j.m.lift1) + 0.5) liftJob = { j, t };
      if (t >= j.total) {
        this.jobs.delete(a);
        if (j.kind === 'exit') { a.shown = false; a.offset.set(0, 0, 0); }
        else this.handBack(a);
      }
    }
    this.setDoor(door);
    this.setLift(liftJob?.j ?? null, liftJob?.t ?? 0);
    this.setHook(now);
  }
  /** A crane drop's gantry hook rides just above the performer's head, then winches back up. */
  private setHook(now: number) {
    const H = this.hook;
    if (!H || !H.node.parent) return;
    let y: number | null = null;
    for (const j of this.jobs.values()) {
      if (!j.crane) continue;
      const t = now - j.start;
      if (t < j.m.drop0 - 0.5 || t > j.m.drop1 + 2.5) continue;
      const top = j.sample(Math.min(t, j.m.drop1), freshSample()).pos.y + j.height * 1.02;
      const up = t > j.m.drop1 ? smooth((t - j.m.drop1) / 2.5) * 3 : 0;
      y = top + up;
    }
    H.node.parent.updateWorldMatrix(true, false);
    if (y === null) { H.node.position.copy(H.rest); return; }
    const w = H.node.parent.localToWorld(H.rest.clone());
    w.y = Math.max(w.y, y);
    H.node.position.copy(H.node.parent.worldToLocal(w));
  }

  private apply(a: SceneActor, j: BigJob, t: number) {
    const L = this.layer(a);
    const s = j.sample(t, freshSample());
    a.mount.position.copy(s.pos);
    a.mount.rotation.set(0, s.yaw, 0);
    a.sit = 0;
    a.shown = t >= j.m.shown && t < j.m.hide;
    a.appear = 1;
    a.perch = 0;
    // the drop: a crouch on impact (and a little sway while the thrusters fight the fall)
    a.offset.set(0, 0, 0);
    if (j.style === 'drop' && j.kind !== 'exit' && j.m.drop1 > 0) {
      const k = (t - j.m.drop1) / 0.6;
      if (k > 0 && k < 1) a.offset.y = -(j.crane ? 0.03 : 0.07) * j.height * Math.sin(Math.PI * k);
      if (!j.crane && t > j.m.drop0 && t < j.m.drop1) a.offset.x = 0.03 * j.height * Math.sin(t * 3.1);
    }
    // the power-up: folded low, the hull rises in hydraulic steps (an exit folds back down)
    if (j.style === 'powerup' && j.m.pow1 > j.m.pow0) {
      const k = ease('stutter', (t - j.m.pow0) / (j.m.pow1 - j.m.pow0));
      a.offset.y = -0.22 * j.height * (j.kind === 'exit' ? k : 1 - k);
    }
    a.updateSeat(j.spot ?? a.spot);
    const l = L.loco;
    l.dist = s.dist; l.gait = s.gait; l.back = false; l.stride = 1; l.idle = 0;
    a.loco = s.gait;
    // hands on the controls (mech pilots: the mech lane's travel envelope) while they travel
    const travel = j.m.w0 >= 0 ? (t > j.m.w0 - 0.6 && t < j.m.w1 + 0.6 ? 1 : 0) : (t > Math.max(j.m.lift0, j.m.drop0, j.m.pow0) - 0.4 && t < Math.max(j.m.lift1, j.m.drop1, j.m.pow1) + 0.4 ? 1 : 0);
    l.armW = travel; l.headW = 0.3 * travel;
  }

  /** Hangar leaves / iris blades at 0..1 open. */
  private setDoor(k: number) {
    const d = this.def.door;
    if (!d) return;
    for (const p of this.doorParts) {
      if (p.iris) p.node.quaternion.copy(p.restQ).multiply(new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), THREE.MathUtils.degToRad(d.turn) * k));
      else p.node.position.copy(p.rest).add(V(p.dir * d.slide * k, 0, 0));
    }
  }
  /** The floor lift: hatches open, the platform under the performer's feet. */
  private setLift(j: BigJob | null, t: number) {
    const L = this.lift;
    if (!L) return;
    const near = !!j?.spot && L.root.getWorldPosition(V()).setY(0).distanceTo(j.spot.position.clone().setY(0)) < L.radius + 0.6;
    const exitNear = !!j && j.kind === 'exit' && L.root.getWorldPosition(V()).setY(0).distanceTo(j.actor.mount.position.clone().setY(0)) < L.radius + 0.6;
    if (!j || (!near && !exitNear)) {
      for (const h of L.hatches) h.node.position.copy(h.rest);
      if (L.platform) L.platform.position.copy(L.platRest);
      return;
    }
    const open = j.kind === 'exit' ? smooth((t - j.m.open0) / Math.max(0.1, j.m.open1 - j.m.open0)) * (1 - smooth((t - j.m.close0) / Math.max(0.1, j.m.close1 - j.m.close0)))
      : smooth((t - j.m.open0) / Math.max(0.1, j.m.open1 - j.m.open0));
    for (const h of L.hatches) h.node.position.copy(h.rest).add(V(h.dir * L.radius * 0.95 * open, -0.05 * open, 0));
    if (L.platform && L.platform.parent) {
      const feet = j.sample(t, freshSample()).pos;
      L.platform.parent.updateWorldMatrix(true, false);
      const local = L.platform.parent.worldToLocal(feet.clone());
      L.platform.position.set(L.platRest.x, Math.min(L.platRest.y, local.y), L.platRest.z);
    }
  }

  // ---------------------------------------------------------------- what the forms engine draws (BigFxSource)
  fx(nowS: number): BigFx[] {
    const out: BigFx[] = [];
    if (!this.def.fx) return out;
    for (const j of this.jobs.values()) {
      const t = nowS - j.start, H = j.height;
      const feet = j.sample(t, freshSample()).pos;
      if (j.style === 'powerup' && t > j.m.pow0 - 0.2 && t < j.m.pow1 + 1.5) {
        const k = THREE.MathUtils.clamp((t - j.m.pow0 + 0.2) / (j.m.pow1 - j.m.pow0 + 1.7), 0, 1);
        const at = (j.spot?.position ?? j.actor.mount.position).clone();
        out.push({ kind: 'steam', pos: at.clone().setY(at.y + 0.05), size: Math.max(0.7, H * 0.28), k, seed: 0.35 });
        out.push({ kind: 'glow', pos: at.clone().setY(at.y + H * 0.45), size: Math.max(0.8, H * 0.4), k: 0.35 * Math.sin(Math.PI * k), color: '#ffcf6a', seed: 0 });
      }
      if (j.style === 'drop' && !j.crane && t > j.m.drop0 - 0.2 && t < j.m.drop1 + 0.1) {
        const k = j.kind === 'exit' ? 1 - smooth((t - j.m.drop0) / (j.m.drop1 - j.m.drop0)) * 0.5 : 0.35 + 0.65 * smooth((t - j.m.drop0) / Math.max(0.1, j.m.drop1 - j.m.drop0));
        for (const sx of [-1, 1]) out.push({ kind: 'thrust', pos: feet.clone().add(V(sx * H * 0.14, -0.05, 0)), size: H * 0.16, k, seed: sx * 0.3 });
      }
      if (j.style === 'drop' && j.kind !== 'exit' && t > j.m.drop1 && t < j.m.drop1 + 2.4) {
        const k = (t - j.m.drop1) / 2.4;
        out.push({ kind: 'dust', pos: j.spot!.position.clone(), size: Math.max(0.8, H * 0.3), k, seed: 0.2 });
        if (k < 0.5) out.push({ kind: 'sparks', pos: j.spot!.position.clone().setY(j.spot!.position.y + 0.1), size: 1, k: k * 2, seed: 0.7 });
        if (k < 0.25 && !j.crane) out.push({ kind: 'flash', pos: j.spot!.position.clone().setY(j.spot!.position.y + 0.3), size: H * 0.4, k: k * 4, seed: 0.1 });
      }
      if (j.style === 'lift' && t > j.m.open0 && t < Math.max(j.m.lift1, j.m.open1) + 2.5) {
        const k = THREE.MathUtils.clamp((t - j.m.open0) / (Math.max(j.m.lift1, j.m.open1) + 2.5 - j.m.open0), 0, 1);
        const at = (j.spot?.position ?? j.actor.mount.position).clone();
        out.push({ kind: 'steam', pos: at.clone().setY(at.y + 0.05), size: Math.max(0.8, H * 0.25), k, seed: 0.4 });
        out.push({ kind: 'glow', pos: at.clone().setY(at.y + 0.08), size: Math.max(1, H * 0.35), k: 0.5 * Math.sin(Math.PI * k), color: '#ffb23a', seed: 0 });
      }
      if (j.style === 'walk' && this.doorAt && t > j.m.open0 && t < j.m.open1 + 3) {
        const k = (t - j.m.open0) / (j.m.open1 + 3 - j.m.open0);
        for (const sx of [-1, 1]) out.push({ kind: 'steam', pos: this.doorAt.pos.clone().add(V(0, 0.2, 0)).addScaledVector(V(-this.doorAt.inward.z, 0, this.doorAt.inward.x), sx * Math.max(1.5, H * 0.45)), size: Math.max(0.8, H * 0.22), k, seed: sx > 0 ? 0.3 : 0.6 });
        out.push({ kind: 'glow', pos: this.doorAt.center.clone(), size: Math.max(2, H * 0.9), k: 0.45 * smooth(k * 3) * (1 - k), color: '#bfe6ff', seed: 0 });
      }
      if (j.style === 'walk' && j.kind !== 'exit' && t > j.total - SETTLE && t < j.total - SETTLE + 1.6 && j.spot) {
        const k = (t - (j.total - SETTLE)) / 1.6;
        out.push({ kind: 'steam', pos: j.spot.position.clone(), size: Math.max(0.8, H * 0.22), k, seed: 0.9 });
        if (k < 0.4) out.push({ kind: 'sparks', pos: j.spot.position.clone().setY(j.spot.position.y + 0.15), size: 1, k: k / 0.4, seed: 0.5 });
      }
    }
    return out;
  }
  runwayOn(nowS: number): boolean {
    for (const j of this.jobs.values()) if (j.style === 'walk') { const t = nowS - j.start; if (t > j.m.open0 && t < j.m.w1 + 0.5) return true; }
    return false;
  }

  // ---------------------------------------------------------------- the entrance cameras
  followCamera(fo: SceneState['follow'], aspect: number, present: (a: SceneActor) => boolean): { key: string; pose: CamPose; secs: number } | null | undefined {
    const now = this.now();
    let best: { j: BigJob; t: number } | null = null;
    for (const j of this.jobs.values()) {
      const t = now - j.start;
      if (!(j.actor.key === '@host' ? fo.host : fo.guests)) continue;
      if (t < 0 || t > j.total + 0.3 || (j.kind !== 'exit' && !present(j.actor))) continue;
      // an exit is followed until they are through the big door / gone below / up and away; then the show's camera
      if (j.kind === 'exit' && t > (j.style === 'walk' ? j.m.through + 0.8 : j.m.hide)) continue;
      if (!best || t > best.t) best = { j, t };
    }
    if (!best) return this.inner.followCamera?.(fo, aspect, present);
    // the entrance never takes the camera from React / Gaming (the screen is the show) - or outside scene.json's modes
    const mode = formsOfRoom(this.room)?.mode() ?? 'talk';
    if (this.def.camModes ? !this.def.camModes.includes(mode) : mode === 'react' || mode === 'gaming') return null;
    const { j, t } = best;
    const root = this.room.root;
    // authored windows first (glTF-space cams with `use: [t0, t1]`)
    for (const [name, c] of Object.entries(this.def.cams)) {
      if (!c.use || j.kind === 'exit' || t < c.use[0] || t >= c.use[1]) continue;
      return { key: `big:${name}`, pose: lookPose(root.localToWorld(V(...c.pos)), root.localToWorld(V(...c.target)), c.fov), secs: 0 };
    }
    // SPEC 3.7 windows: a CAM_* preset or a rail, between time marks of this job
    if (j.kind !== 'exit') for (const [i, c] of this.def.camList.entries()) {
      const a = markAt(c.from, j), b = markAt(c.to, j);
      if (!(t >= a && t < b)) continue;
      const preset = c.cam ? this.room.cameras.get(c.cam) : null;
      if (preset && !c.rail) return { key: `big:${c.cam}`, pose: preset, secs: 0 };
      if (c.rail) {
        const k = b > a ? smooth((t - a) / (b - a)) : 0;
        const pos = root.localToWorld(V(...c.rail[0])).lerp(root.localToWorld(V(...c.rail[1])), k);
        const s = j.sample(t, freshSample());
        return { key: `big:rail${i}`, pose: lookPose(pos, s.pos.clone().add(V(0, j.height * 0.55, 0)), c.fov), secs: 0 };
      }
    }
    return this.autoCam(j, t, aspect);
  }

  private rayCheck() { return (this.rays ??= new RoomRays(this.room)); }
  /** A camera at `pos` aimed at `target`, pulled in front of walls, the lens fitting `fitH` metres at the subject. */
  private shot(key: string, pos: THREE.Vector3, target: THREE.Vector3, fitH: number, aspect: number): { key: string; pose: CamPose; secs: number } {
    const rays = this.rayCheck();
    // far enough that `fitH` fits a lens of at most ~60 degrees (a big walker never fills a too-close camera), then in
    // front of whatever wall is between the subject and the camera
    const fit = Math.max(fitH, fitH * 0.75 / Math.max(0.5, aspect) * (16 / 9));
    const dir = pos.clone().sub(target);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0.2, 1);
    dir.normalize();
    let dist = Math.max(pos.distanceTo(target), fit / 2 / Math.tan(THREE.MathUtils.degToRad(30)));
    const d = rays.hit(target, target.clone().addScaledVector(dir, dist), 0.3);
    if (d < Infinity) dist = Math.max(1.5, d - 0.25);
    pos = target.clone().addScaledVector(dir, dist);
    const fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(fit / 2 / dist)), 22, 80);
    return { key, pose: lookPose(pos, target, fov), secs: 0 };
  }
  private autoCam(j: BigJob, t: number, aspect: number) {
    const H = j.height, s = j.sample(t, freshSample()), a = j.actor;
    const spot = j.spot;
    const chest = s.pos.clone().add(V(0, H * 0.55, 0));
    const roomFwd = spot?.forward ?? V(Math.sin(s.yaw), 0, Math.cos(s.yaw));
    const side = V(roomFwd.z, 0, -roomFwd.x);
    if (j.style === 'walk' && this.doorAt && j.kind !== 'exit' && t < j.m.w0 + 1.2) {
      // the door hero shot: low, inside the room, looking up at the opening
      const D = Math.max(7, H * 2.1);
      const pos = this.doorAt.pos.clone().addScaledVector(this.doorAt.inward, D).addScaledVector(V(-this.doorAt.inward.z, 0, this.doorAt.inward.x), D * 0.28).setY(Math.max(0.5, H * 0.18));
      const target = this.doorAt.pos.clone().setY(H * 0.6);
      return this.shot(`big:door:${a.key}`, pos, target, H * 1.5, aspect);
    }
    if (spot && j.kind !== 'exit' && t > j.total - SETTLE - 0.8) {
      // arrived: the dock / spot hero shot, a little low and off-axis
      const D = Math.max(4.5, H * 1.7);
      const pos = spot.position.clone().addScaledVector(roomFwd, D).addScaledVector(side, D * 0.3).setY(spot.position.y + H * 0.38);
      return this.shot(`big:dock:${a.key}`, pos, spot.position.clone().setY(spot.position.y + H * 0.56), H * 1.3, aspect);
    }
    if (j.style === 'walk') {
      // tracking: a fixed operator beside the lane that pans with the walker
      const from = this.outside ?? s.pos, to = spot?.position ?? j.from ?? s.pos;
      const mid = from.clone().lerp(to, 0.55);
      const lane = to.clone().sub(from).setY(0);
      const n = lane.lengthSq() > 1e-4 ? V(lane.z, 0, -lane.x).normalize() : side;
      // (the operator stands on the audience side of the lane: where the room's wide camera is)
      const aud = this.room.cameras.get('CAM_WIDE')?.position ?? spot?.position.clone().addScaledVector(spot.forward, 6) ?? mid.clone().add(V(0, 0, 6));
      if (n.dot(aud.clone().sub(mid).setY(0)) < 0) n.negate();
      const D = Math.max(6, H * 2.0);
      const pos = mid.clone().addScaledVector(n, D).setY(Math.max(0.6, H * 0.3));
      return this.shot(`big:track:${a.key}`, pos, chest, H * 1.35, aspect);
    }
    if (j.style === 'drop') {
      const D = Math.max(6, H * 2.0);
      const at = spot?.position ?? s.pos;
      const pos = at.clone().addScaledVector(roomFwd, D).addScaledVector(side, D * 0.25).setY(at.y + Math.max(0.6, H * 0.2));
      // before they appear: the landing spot (the set transforming); then the camera tilts up to meet the fall
      const look = j.kind === 'exit' ? 1 : smooth((t - (j.m.drop0 - 1.2)) / 1.2);
      const target = at.clone().add(V(0, H * 0.55, 0)).lerp(s.pos.clone().add(V(0, H * 0.5, 0)).lerp(at.clone().add(V(0, H * 0.55, 0)), 0.35), look);
      return this.shot(`big:drop:${a.key}`, pos, target, H * 1.4 + look * Math.max(0, Math.abs(s.pos.y - at.y) * 0.5 - H * 0.2), aspect);
    }
    // lift: front three-quarter, low, watching them rise
    const at = spot?.position ?? s.pos;
    const D = Math.max(4.5, H * 1.8);
    const pos = at.clone().addScaledVector(roomFwd, D).addScaledVector(side, D * 0.4).setY(at.y + Math.max(0.5, H * 0.25));
    const target = at.clone().setY(Math.max(at.y + H * 0.35, s.pos.y + H * 0.5));
    return this.shot(`big:lift:${a.key}`, pos, target, H * 1.4, aspect);
  }
}

/** The wrapped mover's own API stays reachable through the wrapper. Room engines set / read extra members on rt.mover
 *  (space rooms: spaceScene.ts writes `spaceState` (the host's cryo / drop-pod toggles) and `sceneMode` (no exit cams in
 *  React) and reads `spaceLaunches()` (the re-entry streak)). Every member of the inner mover (own fields + class
 *  methods) that the wrapper does not have itself becomes a get / set accessor on the wrapper that reaches the inner
 *  mover, so wrapping never hides a mover's API from the engines that talk to it. */
export function forwardInner(wrapper: object, inner: object) {
  const done = new Set<PropertyKey>();
  for (let o: object | null = inner; o && o !== Object.prototype; o = Object.getPrototypeOf(o) as object | null) {
    for (const k of Reflect.ownKeys(o)) {
      if (k === 'constructor' || done.has(k) || k in wrapper) continue;
      done.add(k);
      Object.defineProperty(wrapper, k, {
        configurable: true, enumerable: false,
        get: () => { const v = (inner as Record<PropertyKey, unknown>)[k]; return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(inner) : v; },
        set: (v: unknown) => { (inner as Record<PropertyKey, unknown>)[k] = v; },
      });
    }
  }
}

/** A node's authored pose, captured once (a mover made again while a door is open must not take "open" as rest). */
function restOf(o: THREE.Object3D): { p: THREE.Vector3; q: THREE.Quaternion } {
  const u = o.userData as { bigRest?: { p: THREE.Vector3; q: THREE.Quaternion } };
  return (u.bigRest ??= { p: o.position.clone(), q: o.quaternion.clone() });
}

/** A SPEC time mark -> seconds into a job: "3.5", "alert+0.6", "walk@0.35", "dock", "dock+3.8" (NaN = unknown). */
function markAt(m: string, j: BigJob): number {
  const r = /^(\d+(?:\.\d+)?)$/.exec(m);
  if (r) return +r[1];
  const w = /^walk@([\d.]+)$/.exec(m);
  if (w) {
    const [a, b] = j.m.w0 >= 0 ? [j.m.w0, j.m.w1] : j.m.drop0 >= 0 ? [j.m.drop0, j.m.drop1] : j.m.lift0 >= 0 ? [j.m.lift0, j.m.lift1] : [j.m.pow0, j.m.pow1];
    return a + (b - a) * Math.min(1, Math.max(0, +w[1]));
  }
  const e = /^(alert|dock|arrive)([+-][\d.]+)?$/.exec(m);
  if (e) return (e[1] === 'alert' ? 0 : j.m.arrive || j.total - SETTLE) + (e[2] ? +e[2] : 0);
  return NaN;
}

/** Arc length of the path point nearest to p. */
function nearestS(path: WalkPath, p: THREE.Vector3): number {
  let best = 0, bd = Infinity;
  const q = p.clone().setY(0);
  for (let i = 0; i < path.pts.length; i++) { const d = path.pts[i].distanceToSquared(q); if (d < bd) { bd = d; best = path.cum[i]; } }
  return best;
}
/** Time into a walk segment when it reaches arc length s. */
function timeAtS(sg: Extract<Seg, { k: 'walk' }>, s: number): number {
  const L = sg.path.length, { v, ta, td, dur } = sg;
  const s1 = (v * ta) / 2, s2 = L - (v * td) / 2;
  if (s <= 0) return 0;
  if (s >= L) return dur;
  if (s < s1) return Math.sqrt((2 * ta * s) / v);
  if (s <= s2) return ta + (s - s1) / v;
  return dur - Math.sqrt((2 * td * (L - s)) / v);
}

// ------------------------------------------------------------------------------------------------ install
// Every room gets the BigEntranceMover (wrapping whatever mover the room would otherwise get): rooms with a scene.json
// `bigEntrance` use it for their big performers; every other room only for big mechs / vehicles, which power up at their
// spot (SPEC 2.6). Everyone else passes straight through to the wrapped mover (nothing changes for existing avatars).
const prev = currentMoverFactory();
setMoverFactory((room, info) => {
  const inner = prev(room, info);
  return new BigEntranceMover(room, info, parseBigEntrance(info) ?? POWERUP_DEFAULT, inner);
});
