// RaidScene: background combat + raid events for the current room (SceneState.raid — host-owned, so the studio
// preview, every OBS page and party guests show the SAME fight). Attached to the SceneRuntime by the page (output.ts),
// like ChatScene. Costs nothing unless the room has BG_* anchors AND raid is on (or an event is pending).
//
// Timeline: the clock since `raid.epoch` is cut into slots (RAID_PACING[intensity].slot / freq seconds). Slot k may
// hold one skirmish, planned deterministically from hash(seed, k) by sim.ts, placed at a seeded offset inside the
// slot. Timed events (raid.events: test skirmish, Tagilla, 'donation' → the room's donation event) queue per kind and
// suppress regular skirmishes they overlap. Every page samples the same plans at the same wall-clock time, so a page
// that opens mid-fight shows mid-fight (weapons already dropped, bodies already looted …).
//
// Rendering: pooled NPC instances (units.ts), instanced FX (fx.ts), the room's SMASH_xx props break into their
// pre-fractured pieces (physics-lite debris), camera shake + light cue on the hammer hit. NPCs fade out ("hold")
// whenever the current camera would show them over a performer's face or the react screen.
import * as THREE from 'three';
import { DEFAULT_RAID_STATE, RAID_PACING, type RaidEventStamp, type RaidFaction, type SceneRaidState } from '../../../shared/raid.ts';
import type { SceneRuntime } from '../SceneRuntime.ts';
import { lookPose, type CamPose } from '../cameraRig.ts';
import { RaidFx } from './fx.ts';
import { parseRaidRoom, losJob, RaidRays, type P3, type RaidRoom } from './raidRoom.ts';
import { hash32, Rng } from './rng.ts';
import { CLIP_OF, LOADOUT, NF, PISTOL_CLIP, PISTOLS, S, TICK, planSkirmish, planSkirmishSteps, planTagilla, type Episode, type PatrolOpts, type SimNote, type SimShot } from './sim.ts';
import { CYCLE, MODEL_H, Npc, packOfFaction, RaidAssets } from './units.ts';

// ------------------------------------------------------------------------------------------------ events hook
export interface RaidEventContext {
  room: RaidRoom;
  state: SceneRaidState;
  factions: RaidFaction[];
  /** Plain-number helpers for custom planners. */
  planSkirmish: typeof planSkirmish;
  planSkirmishSteps: typeof planSkirmishSteps;
  planTagilla: typeof planTagilla;
  /** Tagilla: the prop index with the clearest sightline from the camera the host had when the event was stamped. */
  pickSmash?: (ev: RaidEventStamp) => number | null;
  /** The boss squad's route options (rooms with PATROL_PATH_xx). */
  patrolOpts?: (ambush: boolean) => PatrolOpts | null;
}
export interface RaidEventHandler {
  /** Whether this room can play it. */
  available(ctx: RaidEventContext): boolean;
  /** Plan the event (deterministic from ev.id / ev.at / state.seed). null = skip. A generator is run a millisecond
   *  per frame (heavy planners — the page never hitches). */
  plan(ctx: RaidEventContext, ev: RaidEventStamp): Episode | null | Generator<void, Episode | null, void>;
  /** Suppresses regular background skirmishes while it plays. */
  exclusive?: boolean;
}
const HANDLERS = new Map<string, RaidEventHandler>();
/** Other rooms / engines can add their own raid events (e.g. 'killa', 'airdrop'): stamp { k: name } in raid.events. */
export function registerRaidEvent(kind: string, h: RaidEventHandler) { HANDLERS.set(kind, h); }
/** Fired on every page when a raid moment happens (smash, death, grenade …) — hook lights / props here. */
export type RaidMomentListener = (m: { kind: SimNote['kind']; episode: string; at: THREE.Vector3 | null }) => void;
const MOMENTS = new Set<RaidMomentListener>();
export function onRaidMoment(fn: RaidMomentListener) { MOMENTS.add(fn); return () => MOMENTS.delete(fn); }
/** A weapon that doesn't fire tracers (e.g. the warzone militia's RPG: a rocket with a smoke trail and a blast) draws its
 *  own shot. Called on every page for every visible shot of that weapon; return true = handled (no default tracer). */
export interface RaidShotFx { muzzle: THREE.Vector3; dir: THREE.Vector3; end: THREE.Vector3; hit: boolean; target: THREE.Vector3 | null; seed: number; scale: number; t: number }
const WEAPON_FX = new Map<string, (s: RaidShotFx) => boolean>();
export function registerWeaponFx(weapon: string, fn: (s: RaidShotFx) => boolean) { WEAPON_FX.set(weapon, fn); return () => { if (WEAPON_FX.get(weapon) === fn) WEAPON_FX.delete(weapon); }; }
/** Page-side unit swap (render only, e.g. the warzone's night-vision frogs after dark): same skeleton + clips. */
let UNIT_ALIAS: ((unit: string) => string) | null = null;
export function setRaidUnitAlias(fn: ((unit: string) => string) | null) { UNIT_ALIAS = fn; }

registerRaidEvent('skirmish', {
  available: (c) => c.room.canFight && !!c.room.sim.los,
  plan: (c, ev) => c.planSkirmishSteps(c.room.sim, { factions: c.factions, intensity: c.state.intensity === 'chill' ? 'normal' : c.state.intensity, seed: hash32(c.state.seed, ev.id, 'ev'), maxSecs: 170, kind: 'skirmish' }),
  exclusive: true,
});
registerRaidEvent('tagilla', {
  available: (c) => c.room.canTagilla,
  plan: (c, ev) => {
    const r = c.room;
    if (!r.enter || !r.smash.length) return null;
    // a prop the room's main camera sees (when there is one), picked from the event id — the same on every page
    const seen = r.smash.map((x, i) => i).filter((i) => r.smash[i].inWide);
    const pool = seen.length ? seen : r.smash.map((x, i) => i);
    const picked = c.pickSmash?.(ev);
    const pi = picked !== null && picked !== undefined ? picked : pool[hash32(ev.id, 'prop') % pool.length];
    const sp = r.smash[pi];
    const exit = r.exit ?? r.enter;
    const P = (v: THREE.Vector3): P3 => ({ x: v.x, y: v.y, z: v.z });
    return c.planTagilla({ enter: P(r.enter.p), exit: P(exit.p), stand: P(sp.stand), standYaw: sp.yaw, scale: r.sim.scale, route: r.tagPath.length ? undefined : (a, b) => navRoute(r, a, b),
      path: r.tagPath.map((w) => ({ p: P(w.p), kick: w.kick && r.kickDoor })), roar: r.roar ? { p: P(r.roar.p), yaw: r.roar.yaw } : null }, hash32(ev.id), pi, ev.user ? { user: ev.user, amount: ev.amount ?? '' } : null);
  },
});

for (const kind of ['patrol', 'ambush']) registerRaidEvent(kind, {
  available: (c) => c.room.canPatrol && !!c.room.sim.los,
  plan: (c, ev) => {
    const po = c.patrolOpts?.(kind === 'ambush');
    if (!po) return null;
    return c.planSkirmishSteps(c.room.sim, { factions: c.factions, intensity: 'normal', seed: hash32(c.state.seed, ev.id, kind), maxSecs: 200, kind, patrol: po });
  },
  exclusive: true,
});

/** Straight line unless both ends sit on the nav graph (then Dijkstra through it). */
function navRoute(r: RaidRoom, a: P3, b: P3): P3[] {
  const s = r.sim;
  if (s.nav < 2) return [b];
  const near = (p: P3) => { let bi = -1, bd = 2.6; for (let i = 0; i < s.nav; i++) { const q = s.pts[i]; const d = Math.hypot(q.x - p.x, (q.y - p.y) * 2, q.z - p.z); if (d < bd) { bd = d; bi = i; } } return bi; };
  const na = near(a), nb = near(b);
  if (na < 0 || nb < 0) return [b];
  const dist = new Array(s.nav).fill(Infinity), prev = new Array(s.nav).fill(-1), done = new Array(s.nav).fill(false);
  dist[na] = 0;
  for (;;) {
    let u = -1, ud = Infinity;
    for (let i = 0; i < s.nav; i++) if (!done[i] && dist[i] < ud) { ud = dist[i]; u = i; }
    if (u < 0 || u === nb) break;
    done[u] = true;
    for (const [v, w] of s.adj[u]) if (ud + w < dist[v]) { dist[v] = ud + w; prev[v] = u; }
  }
  if (na !== nb && prev[nb] < 0) return [b];
  const out: P3[] = [];
  for (let v = nb; v >= 0; v = prev[v]) { out.push(s.pts[v]); if (v === na) break; }
  return [...out.reverse(), b];
}

/** Lower-body (hips + spine + legs) clip under an authored upper-body clip: motion capture from the clip library
 *  (docs/ANIMATION_LIBRARY.md) — PMCs / guards walk the UAL walk, scavs a neutral 100STYLE walk, Reshala struts, the
 *  brute walks heavy. States that need their own stance (aim, peek, crouch, loot, drag, deaths) keep the authored legs. */
function lowerClipFor(clip: string, unit: string): string | null {
  const scav = unit.startsWith('scav') || unit.startsWith('militia');
  switch (clip) {
    case 'walk': return scav ? 'style_neutral_walk' : 'ual_walk';
    case 'run': return 'ual_jog_fwd';
    case 'crouch_walk': return 'ual_crouch_fwd';
    case 'idle': case 'scan': case 'idle_gear': return scav ? 'style_heavyset_idle' : 'style_neutral_idle';
    case 'hit': return 'ual_hit_chest';
    case 'p_walk': return 'style_strutting_walk';
    case 'p_run': return 'ual_jog_fwd';
    case 'p_idle': case 'p_scan': return 'style_proud_idle';
    case 't_walk': return 'style_heavyset_walk';
    case 't_sprint': return 'ual_sprint';
    default: return null;
  }
}

// ------------------------------------------------------------------------------------------------ playback
interface Playback {
  key: string;
  ep: Episode;
  /** epoch ms */
  start: number;
  npcs: (Npc | null)[];
  last: number;
  noteI: number;
  shotI: number;
  retire: number;
  lastShot: number[];
  lastState: number[];
  opacity: number[];
  tagSign?: THREE.Mesh | null;
  grenades: { from: THREE.Vector3; to: THREE.Vector3; t0: number; dur: number; mesh: THREE.Mesh }[];
}

interface Debris { o: THREE.Object3D; p: THREE.Vector3; v: THREE.Vector3; q: THREE.Quaternion; w: THREE.Vector3; half: number; rest: boolean; base: { p: THREE.Vector3; q: THREE.Quaternion } }
interface PropState { broken: boolean; at: number; pieces: Debris[]; until: number }

const SMASH_RESET = 32;                // s until a smashed prop stands again
const tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), tv3 = new THREE.Vector3();
const tq = new THREE.Quaternion();
const frustum = new THREE.Frustum(), projM = new THREE.Matrix4(), sphere = new THREE.Sphere();

export class RaidScene {
  private rt: SceneRuntime | null = null;
  private room: RaidRoom | null = null;
  private roomKey = '';
  private rays: RaidRays | null = null;
  private los: Generator<void, Uint8Array, void> | null = null;
  assets: RaidAssets | null = null;
  private loading = false;
  private loadErr = '';
  private fx: RaidFx | null = null;
  private plays = new Map<string, Playback>();
  private plans = new Map<string, { ep: Episode | null; start: number }>();
  private props = new Map<number, PropState>();
  private shake = 0;
  private shakeSeed = 1;
  private faceT = 0;
  private hidden = new Set<Npc>();
  private warmed = false;
  /** Test pages: time advances only through update(). */
  manual = false;
  clock = Date.now();
  private perf = { avg: 0, peak: 0, dtAvg: 1 / 60, dtBase: 1 / 60, level: 0, slowFor: 0, goodFor: 0, planMs: 0, poses: 0 };
  private frame = 0;
  private created = 0;
  /** The chat monitor / support board should get out of the way (Tagilla visit or a raid-camera shot). */
  stageBusy = false;
  /** Which chat props winch up for him (the room's scene.json raid.tagilla.liftProps; null = both). */
  liftProps: string[] | null = null;
  /** A big-donation Tagilla is interrupting (React's screen up, the camera on him). */
  interrupt = false;
  private intKey = '';
  private intAlarm = 0;
  private dirOn = false;
  private dirKey = '';
  /** Tests: pin the perf level (null = automatic). */
  forceLevel: number | null = null;
  /** Tests: a follow camera on one NPC ({ actor index, distance, height, side angle (rad) }). */
  debugFollow: { actor: number; dist: number; height: number; side: number; kind?: string } | null = null;
  /** Tests: a fixed camera (overrides the room camera after the rig). */
  debugCam: { pos: [number, number, number]; target: [number, number, number]; fov?: number } | null = null;
  private lineup: Npc[] = [];

  now() { return this.manual ? this.clock : Date.now(); }

  attach(rt: SceneRuntime) {
    if (this.rt === rt) return;
    this.detach();
    this.rt = rt;
    const hook = rt as unknown as { cameraOverride?: ((aspect: number) => { key: string; pose: CamPose; secs: number } | null) | null };
    hook.cameraOverride = (aspect) => this.directorShot(aspect);
  }

  detach() {
    if (this.rt) (this.rt as unknown as { cameraOverride?: unknown }).cameraOverride = null;
    this.stageBusy = false; this.dirOn = false;
    for (const p of this.plays.values()) this.disposePlay(p);
    this.plays.clear();
    this.plans.clear();
    for (const [i, ps] of this.props) this.restoreProp(i, ps);
    this.props.clear();
    this.fx?.dispose(); this.fx = null;
    this.room = null; this.roomKey = ''; this.rays = null; this.los = null;
    this.rt = null;
    this.warmed = false;
  }

  private get state(): SceneRaidState { return this.rt?.state.raid ?? DEFAULT_RAID_STATE; }

  private factions(): RaidFaction[] {
    const st = this.state;
    const cfg = this.rt?.info.raid;
    const f = st.factions ?? (cfg?.factions?.length ? cfg.factions : ['usec', 'bear', 'scav']);
    return f.filter((x) => ['usec', 'bear', 'scav', 'raider', 'frog', 'militia'].includes(x)) as RaidFaction[];
  }

  private ensureRoom(): RaidRoom | null {
    const rt = this.rt!;
    const key = rt.info.id;
    if (this.room && this.roomKey === key) return this.room;
    const h = rt.info.raid?.npcHeight ?? (rt.info.avatarHeight ?? 1.5) * 1.08;
    this.room = parseRaidRoom(rt.room, Math.max(1.2, Math.min(2.2, h)), rt.info.defaultCamera ?? 'CAM_WIDE');
    this.roomKey = key;
    this.rays = new RaidRays(this.room.solids);
    this.los = this.room.canFight ? losJob(this.room.sim, this.rays) : null;
    return this.room;
  }

  private ensureAssets() {
    if (this.assets || this.loading || this.loadErr) return;
    this.loading = true;
    RaidAssets.load().then((a) => { this.assets = a; }).catch((e) => { this.loadErr = String((e as Error)?.message ?? e); console.warn('raid assets', e); }).finally(() => { this.loading = false; });
  }
  /** Unit packs the current factions need (loaded once, in the background; their NPCs appear when it's there). */
  private ensurePacks() {
    const A = this.assets;
    if (!A) return;
    for (const f of this.factions()) { const pk = packOfFaction(f); if (pk && !A.packReady(pk.id)) void A.ensurePack(pk.id); }
  }

  // ---------------------------------------------------------------- schedule
  private ctx(room: RaidRoom): RaidEventContext {
    return { room, state: this.state, factions: this.factions(), planSkirmish, planSkirmishSteps, planTagilla,
      pickSmash: (ev) => this.pickSmash(room, ev), patrolOpts: (ambush) => this.patrolOpts(room, ambush) };
  }

  private patrolOpts(room: RaidRoom, ambush: boolean): PatrolOpts | null {
    const pt = room.sim.patrol;
    if (!pt) return null;
    const pmcs = this.factions().filter((f) => f === 'usec' || f === 'bear');
    const cfg = (this.rt?.info.raid?.patrol ?? {}) as { walkSpeed?: unknown; reversible?: unknown };
    const ws = Number(cfg.walkSpeed);
    return {
      path: pt.path, pauses: pt.pauses, form: pt.form, ambush, ambushFactions: pmcs.length ? pmcs : ['usec', 'bear'],
      ...(Number.isFinite(ws) && ws > 0.3 && ws < 3 ? { speed: ws } : {}), reversible: cfg.reversible === true,
    };
  }

  /** The camera a big-donation interrupt cuts to: the room's CAM_TAGILLA, else its main camera. */
  private bigCam(): string {
    const rt = this.rt!;
    return rt.room.cameras.has('CAM_TAGILLA') ? 'CAM_TAGILLA' : rt.info.defaultCamera && rt.room.cameras.has(rt.info.defaultCamera) ? rt.info.defaultCamera : 'wide';
  }
  private setInterrupt(on: boolean, key = '') {
    this.interrupt = on;
    this.intKey = on ? key : '';
    if (this.rt) (this.rt as unknown as { interrupt?: boolean }).interrupt = on;
  }

  /** Tagilla: score every SMASH prop by what the event's camera (16:9, the same on every page) can see of it and of
   *  his strike point — room geometry, the performers (rough capsules) and the chat props all block. */
  private pickSmash(room: RaidRoom, ev: RaidEventStamp): number | null {
    const rt = this.rt;
    if (!rt || !room.smash.length || (rt.info.raid?.tagillaSightline === true && !ev.big)) return null;
    let pose: CamPose;
    const camName = ev.big ? this.bigCam() : ev.cam ?? rt.state.camera;
    try { pose = rt.resolveCamera(camName, 16 / 9).pose; } catch { return null; }
    // scene.json raid.tagilla.preferPropsByCamera (CAM_x names; talk / wide / react map to CAM_TALK / CAM_WIDE / CAM_REACT)
    const pref = (rt.info.raid?.tagilla as { preferPropsByCamera?: Record<string, unknown> } | undefined)?.preferPropsByCamera;
    const alias: Record<string, string> = { talk: 'CAM_TALK', wide: 'CAM_WIDE', react: 'CAM_REACT' };
    const list = pref && typeof pref === 'object' ? pref[camName] ?? pref[alias[camName] ?? ''] : null;
    const allowed = Array.isArray(list) ? new Set(list.filter((x): x is string => typeof x === 'string')) : null;
    const cam = new THREE.PerspectiveCamera(pose.fov, 16 / 9, 0.05, 300);
    cam.position.copy(pose.position); cam.quaternion.copy(pose.quaternion); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    const rays = this.rays ?? new RaidRays(room.solids);
    const bodies: [THREE.Vector3, THREE.Vector3][] = [];
    for (const a of rt.actors.values()) {
      if (!a.spot || rt.state.present[a.key] === false) continue;
      const f = a.faceAt(a.spot);
      bodies.push([a.spot.position.clone().setY(a.spot.position.y + 0.3), f ? f.center.clone() : a.spot.position.clone().setY(a.spot.position.y + 1.3)]);
    }
    const seg = new THREE.Vector3(), cp = new THREE.Vector3(), cq = new THREE.Vector3();
    const clear = (p: THREE.Vector3) => {
      const v = p.clone().project(cam);
      if (v.z >= 1 || Math.abs(v.x) > 0.95 || Math.abs(v.y) > 0.95) return false;
      const d = p.clone().sub(cam.position); const len = d.length(); d.divideScalar(len);
      const h = rays.cast(cam.position, d, len);
      if (h.d < len - 0.35) return false;
      const ray = new THREE.Ray(cam.position, d);
      for (const [a, b] of bodies) { const dist2 = ray.distanceSqToSegment(a, b, cp, cq); if (dist2 < 0.3 * 0.3 && cp.distanceTo(cam.position) < len - 0.2) return false; }
      return true;
    };
    const s = room.sim.scale;
    let best = -1, bs = -1;
    room.smash.forEach((sp, i) => {
      if (allowed && allowed.size && !allowed.has(sp.name)) return;
      let sc = (clear(sp.center) ? 2 : 0) + (clear(seg.copy(sp.stand).setY(sp.stand.y + 1.45 * s)) ? 2 : 0) + (clear(sp.stand.clone().setY(sp.stand.y + 0.8 * s)) ? 1 : 0) + (sp.inWide ? 0.5 : 0);
      sc += (hash32(ev.id, i) % 100) / 1000;     // deterministic tie-break
      if (sc > bs) { bs = sc; best = i; }
    });
    return bs >= 2 ? best : null;
  }

  private slotSecs() { const st = this.state; return RAID_PACING[st.intensity].slot / st.freq; }

  /** Regular skirmish of slot k (memoised; planned a millisecond per frame — null while in progress). */
  private slotPlan(room: RaidRoom, k: number, now = false): { ep: Episode | null; start: number } | null {
    const st = this.state;
    const key = `slot:${st.seed}:${st.epoch}:${st.intensity}:${st.freq}:${this.factions().join(',')}:${k}`;
    const p = this.plans.get(key);
    if (p) return p;
    const P = this.slotSecs();
    let job = this.jobs.get(key);
    if (!job) {
      const rng = new Rng(hash32(st.seed, k, 'slot'));
      const go = k >= 0 && rng.next() < RAID_PACING[st.intensity].chance;
      // rooms with a boss route: some slots are the squad's patrol (sometimes ambushed by PMCs)
      let patrol: PatrolOpts | null = null;
      if (go && room.canPatrol) {
        const pc = (this.rt?.info.raid?.patrol ?? {}) as { chance?: number; ambush?: number };
        if (rng.next() < (typeof pc.chance === 'number' ? pc.chance : 0.5)) patrol = this.patrolOpts(room, rng.next() < (typeof pc.ambush === 'number' ? pc.ambush : 0.45));
      }
      const kind = patrol ? (patrol.ambush ? 'ambush' : 'patrol') : 'skirmish';
      job = { gen: go ? planSkirmishSteps(room.sim, { factions: this.factions(), intensity: st.intensity, seed: hash32(st.seed, k), maxSecs: P - 8, ...(patrol ? { patrol } : {}) }) : null, done: (ep) => {
        const dur = ep ? ep.ticks * TICK : 0;
        const off = 3 + rng.next() * Math.max(0, P - dur - 6);
        if (ep) { ep.kind = kind; this.perf.planMs = ep.stats.planMs; }
        this.plans.set(key, { ep, start: st.epoch + (k * P + off) * 1000 });
        if (this.plans.size > 24) this.plans.delete(this.plans.keys().next().value!);
      } };
      this.jobs.set(key, job);
    }
    if (now) this.runJob(key, Infinity);
    return this.plans.get(key) ?? null;
  }
  private jobs = new Map<string, { gen: Generator<void, Episode | null, void> | null; done: (ep: Episode | null) => void }>();
  private runJob(key: string, budget: number) {
    const job = this.jobs.get(key);
    if (!job) return;
    const t0 = performance.now();
    if (!job.gen) { this.jobs.delete(key); job.done(null); return; }
    for (;;) {
      const r = job.gen.next();
      if (r.done) { this.jobs.delete(key); job.done(r.value); return; }
      if (performance.now() - t0 > budget) return;
    }
  }
  /** Advance planning jobs within ~1 ms per frame. */
  private runJobs() {
    const t0 = performance.now();
    for (const key of [...this.jobs.keys()]) {
      const left = 1.0 - (performance.now() - t0);
      if (left <= 0) return;
      this.runJob(key, left);
    }
  }

  private eventPlans(room: RaidRoom, now = this.now()): { key: string; ep: Episode; start: number; exclusive: boolean; big: boolean }[] {
    const st = this.state;
    const out: { key: string; ep: Episode; start: number; exclusive: boolean; big: boolean }[] = [];
    const cfg = this.rt!.info.raid;
    const ends = new Map<string, number>();
    const ctx = this.ctx(room);
    for (const ev of [...st.events].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))) {
      let kind = ev.k;
      if (kind === 'donation') kind = cfg?.donationEvent ?? (room.canTagilla ? 'tagilla' : 'skirmish');
      if (ev.big && ev.k === 'donation' && !(kind === 'tagilla' && room.canTagilla)) kind = typeof cfg?.bigEvent === 'string' ? cfg.bigEvent : cfg?.donationEvent && cfg.donationEvent !== 'tagilla' ? cfg.donationEvent : 'skirmish';
      const h = HANDLERS.get(kind);
      if (!h || !h.available(ctx)) continue;
      const key = `ev:${kind}:${ev.id}:${ev.at}:${st.seed}`;
      let p = this.plans.get(key);
      if (!p && !this.jobs.has(key)) {
        const r = h.plan(ctx, ev);
        if (r && typeof (r as Generator).next === 'function' && !(r as Episode).actors) this.jobs.set(key, { gen: r as Generator<void, Episode | null, void>, done: (ep) => { this.plans.set(key, { ep, start: 0 }); } });
        else { p = { ep: r as Episode | null, start: 0 }; this.plans.set(key, p); }
      }
      if (!p || !p.ep) { if (this.jobs.has(key)) break; continue; }     // (queued events wait for the one being planned)
      const start = Math.max(ev.at, ends.get(kind) ?? 0);
      if (kind === 'tagilla' && !ev.big && this.rt!.state.mode === 'react' && !this.plays.has(key)) continue;   // never starts while React's screen is down (big donations interrupt it)
      ends.set(kind, start + p.ep.ticks * TICK * 1000 + 800);
      out.push({ key, ep: p.ep, start, exclusive: !!h.exclusive, big: !!ev.big && kind === 'tagilla' });
    }
    return out;
  }

  /** What should be playing at `now` (+ the next regular start, for the UI). */
  private wanted(room: RaidRoom, now: number) {
    const st = this.state;
    const want: { key: string; ep: Episode; start: number }[] = [];
    const evs = this.eventPlans(room);
    const excl = evs.filter((e) => e.exclusive).map((e) => [e.start, e.start + e.ep.ticks * TICK * 1000] as const);
    for (const e of evs) if (now >= e.start && now < e.start + e.ep.ticks * TICK * 1000) want.push(e);
    let next: number | null = null;
    if (st.on && room.canFight && room.sim.los && st.epoch > 0) {
      const P = this.slotSecs() * 1000;
      const k = Math.floor((now - st.epoch) / P);
      for (const kk of [k - 1, k, k + 1]) {
        if (kk === k + 1 && this.plays.size && st.epoch + (k + 1) * P - now > 12000) continue;
        const p = this.slotPlan(room, kk);
        if (!p || !p.ep) continue;
        const end = p.start + p.ep.ticks * TICK * 1000;
        if (excl.some(([a, b]) => p.start < b && end > a)) continue;
        if (now >= p.start && now < end) want.push({ key: `slot:${st.seed}:${st.epoch}:${kk}:${st.intensity}:${st.freq}`, ep: p.ep, start: p.start });
        else if (p.start > now && (next === null || p.start < next)) next = p.start;
      }
    }
    return { want, next };
  }

  // ---------------------------------------------------------------- per frame
  update(dt: number) {
    const t0 = performance.now();
    this.step(dt);
    const ms = performance.now() - t0;
    this.perf.avg = this.perf.avg * 0.97 + ms * 0.03;
    this.perf.peak = Math.max(this.perf.peak * 0.995, ms);
  }

  private step(dt: number) {
    const rt = this.rt;
    if (!rt) return;
    if (this.debugCam || this.lineup.length) { this.applyFollow(); }
    if (this.manual) this.clock += dt * 1000;
    const st = rt.state.raid;
    const now = this.now();
    const pending = !!st && st.events.some((e) => e.at + 240_000 > now);
    this.setInterrupt(false);
    const off = (!st || (!st.on && !pending)) && !this.plays.size;
    if (off && !this.props.size) return;     // off: zero cost
    const room = this.ensureRoom();
    // (SMASH_xx props can be broken by an alert reaction in any room, raid on or not: that is just the debris. A raid that is
    // off, or a room without a fight / Tagilla, never loads the raid engine for it - the units, the FX and the shader warm-up)
    if (!room || off || (!room.canFight && !room.canTagilla)) { if (room && this.props.size) this.updateProps(dt, now); return; }
    this.frame++;
    // line of sight (a few ms per frame, once per room)
    if (this.los) {
      const t0 = performance.now();
      for (;;) { const r = this.los.next(); if (r.done) { room.sim.los = r.value; this.los = null; break; } if (performance.now() - t0 > 1.0) break; }
    }
    this.ensureAssets();
    this.governor(dt);
    this.runJobs();
    const { want } = this.wanted(room, now);
    const evp = this.eventPlans(room, now);
    this.stageBusy = this.dirOn || evp.some((e) => e.ep.kind === 'tagilla' && now > e.start - 2500 && now < e.start + e.ep.ticks * TICK * 1000);
    const lp = (rt.info.raid?.tagilla as { liftProps?: unknown } | undefined)?.liftProps;
    this.liftProps = this.dirOn || !Array.isArray(lp) ? null : lp.filter((x): x is string => typeof x === 'string');
    // big donation: the interrupt runs from the stamp to a moment after he has gone
    const big = evp.find((e) => e.big && now >= e.start - 400 && now < e.start + e.ep.ticks * TICK * 1000 + 600);
    this.setInterrupt(!!big, big?.key);
    if (big && this.fx && room.roar && now < big.start + 9000 && (this.intAlarm -= dt) <= 0) { this.intAlarm = 0.45; this.fx.alarm(room.roar.p.clone().setY(room.roar.p.y + 2.2 * room.sim.scale), room.sim.scale); }
    const keys = new Set(want.map((w) => w.key));
    for (const w of want) if (!this.plays.has(w.key)) this.plays.set(w.key, this.newPlay(w.key, w.ep, w.start, now));
    if (!this.assets) { if (this.props.size) this.updateProps(dt, now); return; }      // (a reaction's smash while the NPCs load)
    this.ensurePacks();
    if (!this.fx) { this.fx = new RaidFx(); rt.root.add(this.fx.group); }
    if (!this.warmed) this.warm();
    this.fx.level = this.perf.level;
    const cam = rt.stage.camera;
    projM.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projM);
    const shadows: { x: number; y: number; z: number; r: number; o: number }[] = [];
    this.created = 0;
    for (const [key, p] of [...this.plays]) {
      if (!keys.has(key) && p.retire < 0) p.retire = 0;
      const done = this.play(p, now, dt, shadows);
      if (done) { this.disposePlay(p); this.plays.delete(key); if (!this.plays.size) this.fx.clearDecals(); }
    }
    this.updateProps(dt, now);
    this.driveDoor(now);
    this.fx.shadows.set(this.perf.level >= 2 ? [] : shadows);
    this.fx.update(dt, cam, rt.stage.renderer.domElement.height || 1080);
    this.faceT -= dt;
    if (this.faceT <= 0) { this.faceT = 0.25; this.protectFaces(); }
    this.applyShake(dt);
    this.applyFollow();

  }

  /** Compile the NPC + effect shaders off the critical path (compileAsync) before the first NPC shows. */
  private warm() {
    this.warmed = true;
    const rt = this.rt!, A = this.assets!, fx = this.fx!;
    const w = new Npc(A, 'usec_a', 'm4', rt.root);
    w.root.position.set(0, -500, 0);
    const hidden: THREE.Object3D[] = [];
    fx.group.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
    const r = rt.stage.renderer as THREE.WebGLRenderer & { compileAsync?: (o: THREE.Object3D, c: THREE.Camera, s?: THREE.Scene) => Promise<unknown> };
    let done: Promise<unknown>;
    try { done = r.compileAsync ? r.compileAsync(rt.root, rt.stage.camera, rt.stage.scene) : Promise.resolve(r.compile(rt.root, rt.stage.camera, rt.stage.scene)); } catch { done = Promise.resolve(); }
    for (const o of hidden) o.visible = false;
    void done.catch(() => {}).finally(() => w.dispose());
  }

  private governor(dt: number) {
    const P = this.perf;
    P.dtAvg = P.dtAvg * 0.95 + Math.min(0.2, dt) * 0.05;
    P.dtBase = Math.min(P.dtBase * 1.0005, P.dtAvg);
    const tierLow = (this.rt?.opts.tier ?? 'high') === 'low';
    const slow = P.avg > 1.3 || (this.plays.size > 0 && P.dtAvg > P.dtBase * 1.35 && P.dtAvg > 1 / 45);
    if (slow) { P.slowFor += dt; P.goodFor = 0; } else { P.goodFor += dt; P.slowFor = 0; }
    if (P.slowFor > 2.5 && P.level < 2) { P.level++; P.slowFor = 0; }
    if (P.goodFor > 25 && P.level > (tierLow ? 1 : 0)) { P.level--; P.goodFor = 0; }
    if (tierLow && P.level < 1) P.level = 1;
    if (this.forceLevel !== null) P.level = this.forceLevel;
  }

  private newPlay(key: string, ep: Episode, start: number, now: number): Playback {
    return {
      key, ep, start, npcs: ep.actors.map(() => null), last: Math.min((now - start) / 1000, 0) - 1e-3, noteI: 0, shotI: 0, retire: -1,
      lastShot: ep.actors.map(() => -99), lastState: ep.actors.map(() => -1), opacity: ep.actors.map(() => 1), grenades: [],
    };
  }

  private disposePlay(p: Playback) {
    for (const n of p.npcs) n?.dispose();
    for (const g of p.grenades) g.mesh.removeFromParent();
    p.tagSign?.geometry.dispose();
    ((p.tagSign?.material as THREE.MeshBasicMaterial | undefined)?.map)?.dispose();
    (p.tagSign?.material as THREE.Material | undefined)?.dispose();
    for (const n of p.npcs) if (n) this.hidden.delete(n);
  }

  /** Sample + render one episode. Returns true when it's finished (and faded). */
  private play(p: Playback, now: number, dt: number, shadows: { x: number; y: number; z: number; r: number; o: number }[]): boolean {
    const ep = p.ep, rt = this.rt!, A = this.assets!, room = this.room!;
    const tr = (now - p.start) / 1000;
    const dur = ep.ticks * TICK;
    if (p.retire >= 0) p.retire += dt;
    if (tr >= dur + 0.5 && p.retire < 0) p.retire = 0.6;
    const fadeK = p.retire >= 0 ? Math.max(0, 1 - p.retire / 0.6) : 1;
    if (fadeK <= 0) return true;
    // catching up (page opened / tab resumed mid-episode): persistent effects only
    const catchUp = tr - p.last > 0.6;
    const s = room.sim.scale;
    const f = Math.max(0, Math.min(ep.ticks - 1, tr / TICK));
    const i0 = Math.floor(f), i1 = Math.min(ep.ticks - 1, i0 + 1), a = f - i0;
    const odd = (this.frame & 1) === 1;
    for (let k = 0; k < ep.actors.length; k++) {
      const act = ep.actors[k], d = act.data;
      const o0 = i0 * NF, o1 = i1 * NF;
      const state = d[o0 + 4];
      let npc = p.npcs[k];
      if (state === S.HIDDEN || tr < 0 || tr > dur) {
        if (npc) { npc.visible = false; npc.setOpacity(0); }
        continue;
      }
      if (!npc) {
        if (this.created >= 1 || !A.templates.has(act.unit)) continue;     // (a unit pack still loading: it appears once there)
        this.created++;
        const u = UNIT_ALIAS ? UNIT_ALIAS(act.unit) : act.unit;
        npc = new Npc(A, A.templates.has(u) ? u : act.unit, act.weapon, rt.root);
        const sc = s * (act.unit === 'tagilla' ? 1.12 : 1);
        npc.root.scale.setScalar(sc);
        p.npcs[k] = npc;
        if (ep.sign && act.unit === 'tagilla') p.tagSign = this.makeSign(npc, ep.sign.user, ep.sign.amount);
      }
      npc.visible = true;
      // position / facing (the dragged body blends from where it lay over its first 0.5 s)
      let x = d[o0] + (d[o1] - d[o0]) * a, y = d[o0 + 1] + (d[o1 + 1] - d[o0 + 1]) * a, z = d[o0 + 2] + (d[o1 + 2] - d[o0 + 2]) * a;
      let dy = d[o1 + 3] - d[o0 + 3];
      while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
      let yaw = d[o0 + 3] + dy * a;
      const since = d[o0 + 5] + a;
      if (state === S.DRAGGED && since < 5 && i0 - d[o0 + 5] - 1 >= 0) {
        const g = (i0 - d[o0 + 5] - 1) * NF, k2 = since / 5;
        x = d[g] + (x - d[g]) * k2; z = d[g + 2] + (z - d[g + 2]) * k2;
        let dd = yaw - d[g + 3]; while (dd > Math.PI) dd -= Math.PI * 2; while (dd < -Math.PI) dd += Math.PI * 2;
        yaw = d[g + 3] + dd * k2;
      }
      npc.root.position.set(x, y, z);
      npc.root.rotation.set(0, yaw, 0);
      // animation
      const dead = state === S.DEAD || state === S.GC;
      let clipName = dead ? CLIP_OF[d[o0 + 8]] ?? 'death_back' : CLIP_OF[state] ?? 'idle';
      if (PISTOLS.has(act.weapon) && PISTOL_CLIP[clipName]) clipName = PISTOL_CLIP[clipName];
      // idle variety (rifle idles): now and then look around, or adjust the headset / helmet — on the shared clock
      let vt = -1;
      if (clipName === 'idle' && state === S.IDLE && !act.unit.startsWith('tagilla')) {
        const per = 13 + (hash32(p.key, k, 'iv') % 5);
        const sec = since * TICK + (hash32(p.key, k, 'io') % 7);
        const ph = sec % per, cyc = Math.floor(sec / per);
        if (ph >= 5 && ph < 9) { clipName = (cyc + k) % 2 ? 'idle_gear' : 'scan'; vt = ph - 5; }
      }
      const clip = A.clips.get(clipName) ?? A.clips.get('idle')!;
      let ct: number;
      const cyc = CYCLE[clipName];
      const sc = npc.root.scale.x;
      const walked = d[o0 + 7] + (d[o1 + 7] - d[o0 + 7]) * a;
      if (dead) ct = clip.dur;
      else if (cyc) ct = (walked / (cyc * sc)) * clip.dur;
      else ct = vt >= 0 ? vt : since * TICK;
      // motion-captured legs + hips under the authored upper body (library clips; absent until they've loaded)
      let lower: { clip: typeof clip; t: number } | null = null;
      const ln = dead ? null : lowerClipFor(clipName, act.unit);
      const lc = ln ? A.clips.get(ln) : undefined;
      if (lc) {
        const lcyc = CYCLE[ln!];
        const off = ((hash32(p.key, k) % 1000) / 1000) * lc.dur;           // (idles de-synced per NPC)
        lower = { clip: lc, t: lcyc ? (walked / (lcyc * sc)) * lc.dur : lc.loop ? since * TICK + off : since * TICK };
      }
      if (p.lastState[k] !== state) {
        const toDeath = state >= S.DEATH_BACK && state <= S.DEATH_SPIN;
        npc.play(clip, ct, p.lastState[k] < 0 || catchUp ? 0 : state === S.DRAGGED ? 0.45 : toDeath ? 0.12 : dead ? 0 : state === S.HIT ? 0.08 : state === S.AIM || state === S.PEEK_L || state === S.PEEK_R || state === S.AIM_CROUCH ? 0.2 : 0.3, lower);
        p.lastState[k] = state;
      } else if (npc.cur && npc.cur.clip !== clip) npc.play(clip, ct, 0.4, lower);
      else if (npc.cur) { npc.cur.t = ct; if (npc.lower && lower && npc.lower.clip === lower.clip) npc.lower.t = lower.t; else if (!!npc.lower !== !!lower) npc.play(clip, ct, 0.25, lower); }
      // visibility + LOD
      sphere.center.set(x, y + 0.9 * sc, z); sphere.radius = 1.3 * sc;
      const inView = frustum.intersectsSphere(sphere);
      const far = cam2(rt).distanceTo(sphere.center) > 22;
      const skip = !inView || ((this.perf.level >= 1 || far) && odd);
      if (!skip || npc.prev || !npc.cur) {
        const recoil = Math.max(0, 1 - (tr - p.lastShot[k]) / 0.11);
        npc.pose(dt * (skip ? 1 : 1), d[o0 + 6] + (d[o1 + 6] - d[o0 + 6]) * a, recoil);
        this.perf.poses++;
      }
      npc.updateDrop(dt, catchUp);
      { const cd = cam2(rt).distanceTo(sphere.center); npc.setOutline(inView && cd < 28 && this.perf.level === 0 && (this.rt!.opts.tier ?? 'high') !== 'low', cd); }
      const alpha = (d[o0 + 9] + (d[o1 + 9] - d[o0 + 9]) * a) * fadeK;
      p.opacity[k] = alpha;
      const hold = this.hidden.has(npc) ? 0 : 1;
      npc.setOpacity(Math.min(alpha, npc.opacity < alpha * hold ? Math.min(alpha * hold, npc.opacity + dt * 4) : Math.max(alpha * hold, npc.opacity - dt * 5)));
      if (inView && !dead) shadows.push({ x, y, z, r: 0.42 * sc, o: npc.opacity });
      else if (inView && dead) shadows.push({ x, y, z, r: 0.2 * sc, o: npc.opacity * 0.6 });
    }
    // shots + notes in (last, tr]
    const from = p.last, to = tr;
    while (p.shotI < ep.shots.length) {
      const sh = ep.shots[p.shotI];
      const ts = (sh.tick + sh.frac) * TICK;
      if (ts > to) break;
      p.shotI++;
      if (ts <= from) continue;
      p.lastShot[sh.from] = ts;
      if (!catchUp && !(this.perf.level >= 2 && p.shotI % 2)) this.shotFx(p, sh);
    }
    while (p.noteI < ep.notes.length) {
      const n = ep.notes[p.noteI];
      const tn = (n.tick + (n.frac ?? 0)) * TICK;
      if (tn > to) break;
      p.noteI++;
      if (tn <= from && from > 0) continue;
      this.note(p, n, catchUp, tn, now);
    }
    this.updateGrenades(p, tr);
    p.last = tr;
    return false;
  }

  private makeSign(npc: Npc, user: string, amount: string): THREE.Mesh {
    const c = document.createElement('canvas'); c.width = 512; c.height = 256;
    const g = c.getContext('2d')!;
    g.fillStyle = '#b58b57'; g.fillRect(0, 0, 512, 256);
    g.strokeStyle = '#6d4f2c'; g.lineWidth = 10; g.strokeRect(8, 8, 496, 240);
    g.fillStyle = '#1a1410'; g.textAlign = 'center'; g.textBaseline = 'middle';
    let fs = 88;
    g.font = `900 ${fs}px Impact, 'Arial Black', sans-serif`;
    while (g.measureText(user).width > 460 && fs > 30) { fs -= 4; g.font = `900 ${fs}px Impact, 'Arial Black', sans-serif`; }
    g.fillText(user, 256, amount ? 100 : 128);
    if (amount) { g.fillStyle = '#b3261e'; g.font = `900 70px Impact, 'Arial Black', sans-serif`; g.fillText(amount, 256, 190); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.18), new THREE.MeshBasicMaterial({ map: t, toneMapped: false, transparent: true }));
    const chest = npc.bones[npc.assets.boneNames.indexOf('Chest')];
    m.position.set(0, 0.07, 0.205);
    m.rotation.x = -0.12;
    chest?.add(m);
    m.name = 'vtp:raid:sign';
    return m;
  }

  private shotFx(p: Playback, sh: SimShot) {
    const fx = this.fx!, rays = this.rays!, room = this.room!;
    const a = p.npcs[sh.from], b = p.npcs[sh.to];
    if (!a || !a.visible) return;
    const s = room.sim.scale;
    const mz = a.muzzleWorld(new THREE.Vector3());
    const aim = b ? b.chestWorld(new THREE.Vector3()) : mz.clone().add(new THREE.Vector3(Math.sin(a.root.rotation.y), 0, Math.cos(a.root.rotation.y)).multiplyScalar(20));
    const r = new Rng(sh.seed);
    if (sh.kind === 'miss') aim.add(new THREE.Vector3(r.range(-0.7, 0.7), r.range(-0.35, 0.6), r.range(-0.7, 0.7)).multiplyScalar(s));
    if (sh.kind === 'miss' && room.glass.length && (sh.seed % 100) < 7) {
      // a stray round towards the office glass (only when the glass is roughly in front of the shooter)
      const g = room.glass[sh.seed % room.glass.length];
      const gp = new THREE.Box3().setFromObject(g).getCenter(new THREE.Vector3());
      const fwd = new THREE.Vector3(Math.sin(a.root.rotation.y), 0, Math.cos(a.root.rotation.y));
      const to = gp.clone().sub(mz).setY(0).normalize();
      if (fwd.dot(to) > 0.05) aim.copy(gp).add(new THREE.Vector3(r.range(-0.8, 0.8), r.range(-0.5, 0.5), 0));
    }
    if (sh.kind === 'cover') aim.add(new THREE.Vector3(r.range(-0.25, 0.25), r.range(-0.45, 0.05), r.range(-0.25, 0.25)).multiplyScalar(s));
    const dir = aim.clone().sub(mz);
    const len = dir.length();
    if (len < 0.05) return;
    dir.divideScalar(len);
    const custom = WEAPON_FX.get(a.weaponId);
    if (custom) {
      let end2: THREE.Vector3, hit2 = sh.hit;
      if (sh.hit) end2 = aim.clone();
      else { const h = rays.cast(mz, dir, 70); end2 = h.d < Infinity ? h.p.clone() : mz.clone().addScaledVector(dir, 70); hit2 = h.d < Infinity; }
      try { if (custom({ muzzle: mz, dir, end: end2, hit: hit2, target: b ? b.chestWorld(new THREE.Vector3()) : null, seed: sh.seed, scale: s, t: this.now() })) return; } catch { /* fall back to a tracer */ }
    }
    fx.muzzle(mz, dir, s, sh.seed);
    let end: THREE.Vector3;
    if (sh.hit) {
      end = aim;
      fx.impact(aim, dir.clone().negate(), 'body', sh.seed, s);
    } else {
      const hit = rays.cast(mz, dir, 70);
      end = hit.d < Infinity ? hit.p.clone() : mz.clone().addScaledVector(dir, 70);
      const n = hit.d < Infinity ? hit.n.clone() : dir.clone().negate();
      if (n.dot(dir) > 0) n.negate();
      if (hit.d < Infinity) fx.impact(end, n, Math.abs(n.y) > 0.7 ? 'floor' : 'wall', sh.seed, s);
    }
    // glass between muzzle and end → crack (the bullet goes through)
    if (room.glass.length) {
      const rc = new THREE.Raycaster(mz, dir, 0.05, mz.distanceTo(end));
      const gh = rc.intersectObjects(room.glass, false)[0];
      if (gh) fx.impact(gh.point, gh.face ? gh.face.normal.clone().transformDirection(gh.object.matrixWorld).multiplyScalar(gh.face.normal.clone().transformDirection(gh.object.matrixWorld).dot(dir) > 0 ? -1 : 1) : dir.clone().negate(), 'glass', sh.seed, s);
    }
    fx.tracer(mz.clone().addScaledVector(dir, 0.1), end, s);
  }

  private note(p: Playback, n: SimNote, catchUp: boolean, tn: number, now: number) {
    const rt = this.rt!, room = this.room!, fx = this.fx!;
    const s = room.sim.scale;
    const npc = p.npcs[n.a] ?? null;
    let at: THREE.Vector3 | null = null;
    switch (n.kind) {
      case 'death': {
        if (npc) { npc.drop(npc.root.position.y, npc.root.rotation.y, hash32(p.key, n.a), rt.root); if (catchUp) npc.updateDrop(0, true); at = npc.root.position.clone(); }
        break;
      }
      case 'pickup': { const b = n.b !== undefined ? p.npcs[n.b] : null; b?.hideWeapon(); break; }
      case 'throw': {
        if (catchUp || !n.p || !n.q) break;
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.05 * s, 8, 6), new THREE.MeshToonMaterial({ color: '#3d4a2c' }));
        m.name = 'vtp:raid:grenade';
        rt.root.add(m);
        p.grenades.push({ from: new THREE.Vector3(n.p.x, n.p.y, n.p.z), to: new THREE.Vector3(n.q.x, n.q.y + 0.05 * s, n.q.z), t0: tn, dur: (n.n ?? 12) * TICK, mesh: m });
        break;
      }
      case 'kick': {
        const d = rt.room.door;
        if (!catchUp && d) { const p = d.node.getWorldPosition(new THREE.Vector3()); at = p; fx.burst(p.setY(p.y + 0.9), 0.5 * s, hash32(p.x, 'kick'), false); if (this.state.shake && !this.state.calm && (rt.state.mode !== 'react' || this.interrupt)) { this.shake = 0.3; this.shakeSeed = hash32(p.x, 'kickshake'); } if (this.interrupt) fx.alarm(p.clone().setY(p.y + 1.2), s); }
        break;
      }
      case 'boom': {
        if (catchUp || !n.p) break;
        at = new THREE.Vector3(n.p.x, n.p.y, n.p.z);
        fx.burst(at, 1.1 * s, hash32(p.key, n.tick), true);
        break;
      }
      case 'smash': {
        const idx = n.n ?? 0;
        const sp = room.smash[idx];
        if (!sp) break;
        const hammer = npc ? npc.muzzleWorld(new THREE.Vector3()) : sp.center.clone();
        at = hammer;
        this.breakProp(idx, hammer, (now - (p.start + tn * 1000)) / 1000, hash32(p.key, 'smash'));
        if (!catchUp) {
          fx.burst(new THREE.Vector3(sp.center.x, sp.floorY + 0.1, sp.center.z), 1.2 * s, hash32(p.key, 'dust'), false);
          fx.burst(hammer, 0.6 * s, hash32(p.key, 'hit'), false);
          if (this.state.shake && !this.state.calm && (rt.state.mode !== 'react' || this.interrupt)) { this.shake = 0.5; this.shakeSeed = hash32(p.key, 'shake'); }
          if (this.interrupt) fx.alarm(hammer.clone(), 1.4 * s);
          const L = rt.lights as unknown as { cue?: (w: string) => void; cues?: string[] };
          try { L.cue?.(L.cues?.includes('donation') ? 'donation' : 'screenLand'); } catch { /* optional hook */ }
        }
        break;
      }
      default: break;
    }
    if (!catchUp) for (const l of MOMENTS) try { l({ kind: n.kind, episode: p.ep.kind, at }); } catch { /* listener */ }
  }

  private updateGrenades(p: Playback, tr: number) {
    for (let i = p.grenades.length - 1; i >= 0; i--) {
      const g = p.grenades[i];
      const u = (tr - g.t0) / g.dur;
      if (u < 0) { g.mesh.visible = false; continue; }
      g.mesh.visible = true;
      if (u >= 1) { g.mesh.position.copy(g.to); if (u > 1 + 1.0 / g.dur) { g.mesh.removeFromParent(); p.grenades.splice(i, 1); } continue; }
      g.mesh.position.lerpVectors(g.from, g.to, u);
      g.mesh.position.y += Math.sin(Math.PI * u) * Math.max(1, g.from.distanceTo(g.to) * 0.25);
    }
  }

  /** The brute kicks the room's DOOR open (EVENT_TAGILLA_ENTER extras.door) and it closes after he's gone. The mover
   *  writes the door every frame; we only ever open it further. */
  private driveDoor(now: number) {
    const door = this.rt?.room.door;
    if (!door) return;
    let v = 0;
    for (const p of this.plays.values()) {
      const kick = p.ep.notes.find((n) => n.kind === 'kick');
      if (!kick) continue;
      const gone = p.ep.notes.find((n) => n.kind === 'gone');
      const tr = (now - p.start) / 1000, tk = kick.tick * TICK, tg = (gone?.tick ?? p.ep.ticks) * TICK;
      const ease = (x: number) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
      v = Math.max(v, ease((tr - tk + 0.05) / 0.18) * (1 - ease((tr - tg - 0.4) / 0.8)));
    }
    if (v <= 0.001) return;
    const cur = (2 * Math.acos(Math.min(1, Math.abs(door.node.quaternion.dot(door.rest))))) / THREE.MathUtils.degToRad(door.openAngle || 95);
    if (v > cur) door.setOpen(v);
  }

  // ---------------------------------------------------------------- smash props (pre-fractured, physics-lite)
  /** Break a SMASH_xx prop without the Tagilla event (room alert reactions, src/scene/reactions.ts). `at` = epoch ms of
   *  the hit on this page's clock: a page that opens later lands mid-fall / already broken, and the prop stands again
   *  SMASH_RESET s after the hit, as after his hammer. false = no such prop here (or the hit is too old / not yet due). */
  smash(name: string, at: number, seed = hash32(name, Math.round(at))): boolean {
    if (!this.rt) return false;
    const room = this.ensureRoom();
    const idx = room ? room.smash.findIndex((p) => p.name === name) : -1;
    if (!room || idx < 0) return false;
    const ago = (this.now() - at) / 1000;
    if (ago < 0 || ago >= SMASH_RESET) return false;
    const sp = room.smash[idx];
    // the blast comes from inside the prop, a little low: the pieces fly outward and up
    const from = sp.center.clone().setY(sp.floorY + (sp.box.max.y - sp.floorY) * 0.3);
    this.breakProp(idx, from, ago, seed);
    if (ago < 0.5) this.fx?.burst(new THREE.Vector3(sp.center.x, sp.floorY + 0.1, sp.center.z), 1.2 * room.sim.scale, hash32(name, 'rxdust'), false);
    return true;
  }

  private breakProp(idx: number, from: THREE.Vector3, ago: number, seed: number) {
    const sp = this.room!.smash[idx];
    const prev = this.props.get(idx);
    if (prev) this.restoreProp(idx, prev);
    const r = new Rng(seed);
    const pieces: Debris[] = sp.pieces.map((o) => {
      o.updateWorldMatrix(true, false);
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
      o.matrixWorld.decompose(p, q, sc);
      const box = new THREE.Box3().setFromObject(o);
      const half = Math.max(0.02, (box.max.y - box.min.y) / 2);
      const out = p.clone().sub(from).setY(0);
      if (out.lengthSq() < 1e-4) out.set(r.range(-1, 1), 0, r.range(-1, 1));
      out.normalize();
      const v = out.multiplyScalar(r.range(1.2, 3.4)).add(new THREE.Vector3(r.range(-0.6, 0.6), r.range(1.0, 3.2), r.range(-0.6, 0.6)));
      const w = new THREE.Vector3(r.range(-9, 9), r.range(-9, 9), r.range(-9, 9));
      return { o, p, v, q, w, half, rest: false, base: { p: o.position.clone(), q: o.quaternion.clone() } };
    });
    for (const m of sp.intact) m.visible = false;
    for (const d of pieces) d.o.visible = true;
    const ps: PropState = { broken: true, at: this.now() - ago * 1000, pieces, until: this.now() - ago * 1000 + SMASH_RESET * 1000 };
    this.props.set(idx, ps);
    // fast-forward (a page that opened after the hit)
    let t = Math.min(4, Math.max(0, ago));
    while (t > 1e-4) { const h = Math.min(1 / 60, t); this.stepDebris(sp.floorY, ps, h); t -= h; }
    this.writeDebris(ps);
  }

  private stepDebris(floorY: number, ps: PropState, h: number) {
    for (const d of ps.pieces) {
      if (d.rest) continue;
      d.v.y -= 9.8 * h;
      d.p.addScaledVector(d.v, h);
      if (d.w.lengthSq() > 1e-6) { tq.setFromAxisAngle(tv.copy(d.w).normalize(), d.w.length() * h); d.q.premultiply(tq); }
      const fy = floorY + d.half * 0.6;
      if (d.p.y < fy) {
        d.p.y = fy;
        if (d.v.y < 0) d.v.y = -d.v.y * 0.28;
        d.v.x *= 0.6; d.v.z *= 0.6; d.w.multiplyScalar(0.55);
        if (Math.abs(d.v.y) < 0.4 && Math.hypot(d.v.x, d.v.z) < 0.15) { d.rest = true; d.v.set(0, 0, 0); }
      }
    }
  }
  private writeDebris(ps: PropState) {
    for (const d of ps.pieces) {
      const parent = d.o.parent;
      if (!parent) continue;
      parent.updateWorldMatrix(true, false);
      tv.copy(d.p); parent.worldToLocal(tv);
      d.o.position.copy(tv);
      parent.getWorldQuaternion(tq);
      d.o.quaternion.copy(tq.invert().multiply(d.q));
    }
  }
  private updateProps(dt: number, now: number) {
    for (const [idx, ps] of [...this.props]) {
      const sp = this.room?.smash[idx];
      if (!sp) continue;
      if (now >= ps.until) {
        this.restoreProp(idx, ps);
        this.props.delete(idx);
        this.fx?.burst(new THREE.Vector3(sp.center.x, sp.floorY + 0.3, sp.center.z), 0.6 * (this.room?.sim.scale ?? 1), idx + 7, false);
        continue;
      }
      if (ps.pieces.some((d) => !d.rest)) { this.stepDebris(sp.floorY, ps, Math.min(dt, 1 / 30)); this.writeDebris(ps); }
    }
  }
  private restoreProp(idx: number, ps: PropState) {
    const sp = this.room?.smash[idx];
    if (!sp) return;
    for (const d of ps.pieces) { d.o.position.copy(d.base.p); d.o.quaternion.copy(d.base.q); d.o.visible = false; }
    for (const m of sp.intact) m.visible = true;
  }

  // ---------------------------------------------------------------- never over a face / the react screen
  /** Tests: switch the face / react-screen protection off to compare. */
  protect = true;
  private protectFaces() {
    const rt = this.rt!;
    if (!this.protect) { this.hidden.clear(); return; }
    const cam = rt.stage.camera;
    cam.updateMatrixWorld();
    const rects: { x0: number; y0: number; x1: number; y1: number; d: number; front: boolean }[] = [];
    const proj = (v: THREE.Vector3) => { tv3.copy(v).project(cam); return { x: (tv3.x + 1) / 2, y: (1 - tv3.y) / 2, ok: tv3.z < 1 }; };
    const camPos = cam.getWorldPosition(new THREE.Vector3());
    const tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    for (const a of rt.actors.values()) {
      if (!a.shown || !a.spot) continue;
      const f = a.faceAt(a.spot);
      if (!f) continue;
      const c = proj(f.center);
      if (!c.ok) continue;
      const dist = camPos.distanceTo(f.center);
      // the face itself plus a small margin (hair / chin): an NPC standing beside the head stays visible
      const r = (f.size * 1.3) / (dist * tanH) / 2;
      rects.push({ x0: c.x - r / cam.aspect, x1: c.x + r / cam.aspect, y0: c.y - r * 1.1, y1: c.y + r * 1.25, d: dist, front: false });
    }
    if (rt.state.mode === 'react' && !this.interrupt) {   // (the interrupt winches the screen up)
      const r = rt.layout() === 'solo' ? rt.solo?.rect(cam) : rt.screen?.rect(cam);
      if (r) rects.push({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h, d: rt.screen ? camPos.distanceTo(rt.screen.frame(camPos).center) : 3, front: true });
    }
    this.hidden.clear();
    if (!rects.length) return;
    for (const p of this.plays.values()) {
      p.ep.actors.forEach((act, k) => {
        const n = p.npcs[k];
        if (!n || !n.visible) return;
        const boss = act.unit === 'tagilla';
        const h = n.headWorld(tv).clone().add(new THREE.Vector3(0, 0.15, 0));
        const feet = n.root.position;
        // silhouette: head top to feet, shoulders wide (the weapon may poke out; that's fine)
        const side = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
        const w = 0.3 * n.root.scale.x;
        const pts = [proj(h), proj(feet), proj(tv2.copy(feet).add(new THREE.Vector3(0, 1.3 * n.root.scale.x, 0)).addScaledVector(side, w)), proj(tv2.copy(feet).add(new THREE.Vector3(0, 1.3 * n.root.scale.x, 0)).addScaledVector(side, -w))];
        const x0 = Math.min(...pts.map((q) => q.x)), x1 = Math.max(...pts.map((q) => q.x)), y0 = Math.min(...pts.map((q) => q.y)), y1 = Math.max(...pts.map((q) => q.y));
        const dn = camPos.distanceTo(n.root.position);
        for (const r of rects) {
          if (x1 < r.x0 || x0 > r.x1 || y1 < r.y0 || y0 > r.y1) continue;
          // the react screen: only NPCs in front of it cover it; faces: background NPCs never overlap them,
          // the brute only matters when he'd walk in front of a face
          if (r.front && dn > r.d) continue;
          if (boss && dn > r.d - 0.2) continue;
          this.hidden.add(n);
          break;
        }
      });
    }
  }

  private applyShake(dt: number) {
    if (this.shake <= 0) return;
    this.shake = Math.max(0, this.shake - dt);
    const cam = this.rt!.stage.camera;
    const k = (this.shake / 0.5) ** 2;
    const r = new Rng(this.shakeSeed + Math.floor(this.shake * 60));
    cam.position.x += r.range(-1, 1) * 0.035 * k;
    cam.position.y += r.range(-1, 1) * 0.03 * k;
    cam.rotation.z += r.range(-1, 1) * 0.006 * k;
    cam.updateMatrixWorld();
  }

  private applyFollow() {
    if (this.debugCam) {
      const cam = this.rt!.stage.camera, d = this.debugCam;
      cam.position.set(...d.pos); cam.lookAt(new THREE.Vector3(...d.target));
      if (d.fov && cam.fov !== d.fov) { cam.fov = d.fov; cam.updateProjectionMatrix(); }
      cam.updateMatrixWorld();
    }
    const f = this.debugFollow;
    if (!f) return;
    for (const p of this.plays.values()) {
      if (f.kind && p.ep.kind !== f.kind) continue;
      const n = p.npcs[f.actor];
      if (!n || !n.visible) continue;
      const cam = this.rt!.stage.camera;
      const c = n.root.position.clone().add(new THREE.Vector3(0, 0.9 * n.root.scale.y, 0));
      const a = n.root.rotation.y + f.side;
      cam.position.set(c.x + Math.sin(a) * f.dist, c.y + f.height, c.z + Math.cos(a) * f.dist);
      cam.lookAt(c);
      cam.updateMatrixWorld();
      return;
    }
  }

  /** Tests: every unit (or a list) in a row playing one clip at time t — lineup sheets / animation strips in the real renderer. */
  debugLineup(o: { units?: string[]; clip: string; t: number; ts?: number[]; at: [number, number, number]; yaw?: number; spacing?: number; weapons?: boolean; lower?: boolean } | null) {
    for (const n of this.lineup) n.dispose();
    this.lineup = [];
    if (!o || !this.assets || !this.rt || !this.room) return 0;
    const A = this.assets;
    const ids = o.units ?? A.unitIds();
    const sp = o.spacing ?? 0.95;
    const s = this.room.sim.scale;
    const right = new THREE.Vector3(1, 0, 0);
    ids.forEach((u, i) => {
      const n = new Npc(A, u, o.weapons === false ? '' : LOADOUT[u] ?? 'ak', this.rt!.root);
      n.root.scale.setScalar(s * (u === 'tagilla' ? 1.12 : 1));
      n.root.position.set(...o.at).addScaledVector(right, (i - (ids.length - 1) / 2) * sp * s);
      n.root.rotation.y = o.yaw ?? 0;
      let cn = o.clip === 'auto' ? (u === 'tagilla' ? 't_idle' : 'idle') : o.clip;
      if (PISTOLS.has(LOADOUT[u] ?? '') && PISTOL_CLIP[cn]) cn = PISTOL_CLIP[cn];
      const clip = A.clips.get(cn) ?? A.clips.get('idle')!;
      const tt = o.ts?.[i] ?? o.t;
      const ln = o.lower === false ? null : lowerClipFor(cn, u);
      const lc = ln ? A.clips.get(ln) : undefined;
      n.play(clip, tt, 0, lc ? { clip: lc, t: (tt / clip.dur) * lc.dur } : null);
      n.pose(0);
      n.setOutline(true, 5);
      this.lineup.push(n);
    });
    return this.lineup.length;
  }

  // ---------------------------------------------------------------- preshow camera director
  /** PRESHOW (and optionally BRB): cut between the normal camera and the raid — the CAM_RAID_xx that frames the most
   *  active NPCs, else an automatic telephoto from the overlook / wide camera. Segments of 5–10 s laid out from the
   *  raid seed on the raid clock, so every page cuts at the same moments to the same shots. */
  private directorShot(_aspect: number): { key: string; pose: CamPose; secs: number } | null {
    this.dirOn = false;
    const rt = this.rt, room = this.room, st = rt?.state.raid;
    if (rt && this.interrupt) {
      try { return { key: `int:${this.intKey}`, pose: rt.resolveCamera(this.bigCam(), 16 / 9).pose, secs: 0 }; } catch { /* fall through */ }
    }
    if (!rt || !room || !st || !st.preshowCam || rt.state.mode === 'react' || !this.plays.size) return null;
    const ls = rt.state.lights?.state;
    if (!(ls === 'preshow' || (st.preshowBrb && ls === 'brb'))) return null;
    const now = this.now();
    const base = st.epoch || 0;
    const BLOCK = 60000;
    const block = Math.floor((now - base) / BLOCK);
    const rng = new Rng(hash32(st.seed, block, 'dir'));
    let t = base + block * BLOCK, j = 0, len = 0;
    for (;; j++) { len = Math.round(rng.range(5, 10) * 1000); if (t + len > now || j > 20) break; t += len; }
    if (j % 3 === 2) return null;                                    // every third shot: back to the show
    // one decision per segment (the same on every page: it only reads the plans + room data)
    const segKey = `${st.seed}:${block}:${j}`;
    if (this.dirCache?.key === segKey) { const r = this.dirCache.res; if (r) { this.dirOn = true; this.dirKey = r.key; } return r; }
    const got = this.activeAt(room, t);
    if (!got) return null;                                           // a plan is still being computed: decide next frame
    const act = got;
    const settled = this.jobs.size === 0;   // (a plan still in the works: decide again next frame)
    if (!act.length) { if (settled) this.dirCache = { key: segKey, res: null }; return null; }
    const rays = this.rays ?? new RaidRays(room.solids);
    const seen = (from: THREE.Vector3, p: THREE.Vector3) => { const d = p.clone().sub(from); const len = d.length(); const h = rays.cast(from, d.divideScalar(len), len); return !(h.d < len - 0.6); };
    // the raid camera that frames the most action
    let best: { name: string; pose: CamPose; score: number } | null = null;
    const cands: { name: string; pose: CamPose; score: number }[] = [];
    for (const name of room.raidCams) {
      const pr = rt.room.cameras.get(name);
      if (!pr) continue;
      const cam = new THREE.PerspectiveCamera(pr.fov, 16 / 9, 0.05, 300);
      cam.position.copy(pr.position); cam.quaternion.copy(pr.quaternion); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
      let sc = 0;
      // how big the action reads in this shot: every framed NPC counts by its apparent size (tight shots win)
      const tanH = Math.tan(THREE.MathUtils.degToRad(pr.fov) / 2);
      for (const a of act) { const v = a.p.clone().project(cam); const dd = a.p.distanceTo(pr.position); if (v.z < 1 && Math.abs(v.x) < 0.9 && Math.abs(v.y) < 0.9 && dd < 90 && seen(pr.position, a.p)) sc += a.w * Math.min(1.5, 3 / (dd * tanH)); }
      if (sc > 0) cands.push({ name, pose: { position: pr.position.clone(), quaternion: pr.quaternion.clone(), fov: pr.fov }, score: sc });
    }
    // variety: any shot within 70 % of the best, picked from the segment (deterministic)
    const top = Math.max(0, ...cands.map((c) => c.score));
    const good = cands.filter((c) => c.score >= top * 0.7);
    if (good.length) best = good[hash32(block, j, 'cam') % good.length];
    let key: string, pose: CamPose;
    if (best) { key = `raid:${block}:${j}:${best.name}`; pose = best.pose; }
    else {
      const org = (rt.room.cameras.get('CAM_OVERLOOK') ?? rt.room.cameras.get('CAM_WIDE'))?.position;
      if (!org) return null;
      const c = new THREE.Vector3(); let w = 0;
      for (const a of act) { c.addScaledVector(a.p, a.w); w += a.w; }
      c.divideScalar(w || 1);
      let r = 1.5;
      for (const a of act) r = Math.max(r, a.p.distanceTo(c) + 1.4);
      const d = c.distanceTo(org);
      const fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan((r * 1.1) / Math.max(1, d))), 9, 55);
      key = `raid:${block}:${j}:auto`;
      pose = lookPose(org.clone(), c, fov);
    }
    this.dirOn = true;
    this.dirKey = key;
    const res = { key, pose, secs: 0 };
    if (settled) this.dirCache = { key: segKey, res };
    return res;
  }
  private dirCache: { key: string; res: { key: string; pose: CamPose; secs: number } | null } | null = null;

  /** Active NPC positions at a moment (from the plans — identical on every page): weight 2 when fighting / running.
   *  null = a plan for that moment is still being computed. */
  private activeAt(room: RaidRoom, ms: number): { p: THREE.Vector3; w: number }[] | null {
    const out: { p: THREE.Vector3; w: number }[] = [];
    for (const pl of this.wanted(room, ms).want) {
      const tr = (ms - pl.start) / 1000;
      if (tr < 0 || tr > pl.ep.ticks * TICK) continue;
      const i = Math.min(pl.ep.ticks - 1, Math.floor(tr / TICK)) * NF;
      for (const a of pl.ep.actors) {
        const stt = a.data[i + 4];
        if (stt === S.HIDDEN || stt === S.DEAD || stt === S.GC || stt === S.DRAGGED) continue;
        const busy = stt === S.AIM || stt === S.AIM_CROUCH || stt === S.PEEK_L || stt === S.PEEK_R || stt === S.RUN || stt === S.T_SMASH || stt === S.DRAG;
        out.push({ p: new THREE.Vector3(a.data[i], a.data[i + 1] + 0.9 * (this.room?.sim.scale ?? 0.9), a.data[i + 2]), w: busy ? 2 : 1 });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- UI / debug
  /** Room support + what's going on (Scene tab via the preview report). */
  info() {
    const rt = this.rt;
    if (!rt) return null;
    const room = this.room ?? (rt.state.raid ? this.ensureRoom() : null);
    if (!room) return { fight: null, tagilla: null, active: 0, next: null, ms: 0 };
    const now = this.now();
    let next: number | null = null;
    try { next = room.sim.los ? this.wanted(room, now).next : null; } catch { next = null; }
    return { fight: room.canFight, tagilla: room.canTagilla, patrol: room.canPatrol, raidCams: room.raidCams.length, director: this.dirOn ? this.dirKey : null, active: [...this.plays.values()].reduce((n, p) => n + p.npcs.filter((x) => x?.visible).length, 0), next: next ? Math.round((next - now) / 1000) : null, ms: +this.perf.avg.toFixed(3) };
  }

  debug() {
    const room = this.room;
    return {
      perf: { avg: +this.perf.avg.toFixed(3), peak: +this.perf.peak.toFixed(2), level: this.perf.level, planMs: +this.perf.planMs.toFixed(2), dtAvg: +(this.perf.dtAvg * 1000).toFixed(1), poses: this.perf.poses },
      director: { on: this.dirOn, key: this.dirKey, stageBusy: this.stageBusy },
      room: room ? { patrol: room.sim.patrol ? { points: room.sim.patrol.path.length, pauses: room.sim.patrol.pauses.length } : null, raidCams: room.raidCams, nav: room.sim.nav, covers: room.sim.covers.length, loot: room.sim.loot.length, spawns: room.sim.spawns.length, exits: room.sim.exits.length, zones: room.zones.length, glass: room.glass.length, smash: room.smash.map((s) => s.name), fight: room.canFight, tagilla: room.canTagilla, los: !!room.sim.los, visPairs: room.sim.los ? room.sim.los.reduce((a, b) => a + b, 0) : 0 } : null,
      assets: this.assets ? { units: this.assets.unitIds().length, clips: this.assets.clips.size } : this.loadErr || (this.loading ? 'loading' : 'idle'),
      plays: [...this.plays.values()].map((p) => ({ key: p.key, kind: p.ep.kind, t: +((this.now() - p.start) / 1000).toFixed(2), dur: +(p.ep.ticks * TICK).toFixed(1), teams: p.ep.teams, stats: p.ep.stats, shown: p.npcs.filter((n) => n?.visible).length, hidden: p.npcs.filter((n) => n && this.hidden.has(n)).length, states: p.ep.actors.map((a, k) => { const f = Math.max(0, Math.min(p.ep.ticks - 1, Math.floor((this.now() - p.start) / 100))); return `${a.unit}:${CLIP_OF[a.data[f * NF + 4]] ?? a.data[f * NF + 4]}${p.npcs[k] ? '' : '(-)'}`; }) })),
      props: [...this.props.entries()].map(([i, p]) => ({ i, until: Math.round((p.until - this.now()) / 1000) })),
      fx: this.fx?.counts() ?? null,
      info: this.info(),
    };
  }

  /** Plan without playing (tests / tools): the regular episode of slot k, or an event. */
  planFor(kind: 'slot' | 'event', arg: number | RaidEventStamp) {
    const room = this.ensureRoom();
    if (!room) return null;
    if (kind === 'slot') return this.slotPlan(room, arg as number, true);
    const ev = arg as RaidEventStamp;
    const h = HANDLERS.get(ev.k === 'donation' ? (this.rt?.info.raid?.donationEvent ?? (room.canTagilla ? 'tagilla' : 'skirmish')) : ev.k);
    const r = h ? h.plan(this.ctx(room), ev) : null;
    if (r && typeof (r as Generator).next === 'function' && !(r as Episode).actors) { const g = r as Generator<void, Episode | null, void>; for (;;) { const x = g.next(); if (x.done) return x.value; } }
    return r as Episode | null;
  }
}

function cam2(rt: SceneRuntime) { return rt.stage.camera.position; }
