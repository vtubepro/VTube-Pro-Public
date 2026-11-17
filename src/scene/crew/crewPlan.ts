// Ship crew: the DETERMINISTIC planner. Behaviour is decided at plan time and only sampled per frame:
//   * cruise: one closed loop per crew member (period P_i, phase from the seed), sampled from the wall clock modulo P_i,
//     so a page opened mid-voyage lands mid-chore (stoking, polishing the guns, swabbing, the lookout's spyglass, a
//     sit-down on the deck);
//   * episodes (a battle with its victory / the enemy fleeing, a treasure stop) are planned once from (seed, the
//     episode input, the deck, every crew member's sampled state at the episode start) into per-crew tracks + loose
//     items (chests, bags), ropes (the rope ladder, the hoist), FX moments (dust, sparks, coins), speech bubbles and
//     repair windows; every crew member walks home afterwards and rejoins its cruise loop at its next loop boundary.
// Jobs are picked with a small utility selector (game-ai-behavior-architect): score = P(job, phase) x 1/(1 + navDist/6)
// x affinity(role, job) x 1.5 if already on it x hash noise 0.9..1.1, greedy in priority order (ties -> lower index).
// Randomness only from hash32 / rng (integer maths: identical in Chrome, Edge and OBS's CEF); clip lengths only from the
// static table (crewClips.ts); nothing here reads the camera, the frame rate or Math.random.
import * as THREE from 'three';
import { CREW_LINES, CREW_ROLES, type CrewBattleIn, type CrewEpisodeIn, type CrewLineKey, type CrewRole, type CrewStopIn, type RoomCrewConfig } from '../../../shared/shipCrew';
import { type CrewDeck, type DeckGun, type DeckSpot, gunSpotDeck, navDist, route, shorePath, standFor } from './crewDeck';
import { TB, STEP_DY, type Track, type FrameFn, type Sample, sampleTrack, trackEnd } from './crewTrack';
import { CREW_SPEED, clipDur, clipEvent, clipMeta } from './crewClips';

type V3 = THREE.Vector3;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// ------------------------------------------------------------------------------------------------ rng (kitchenPlan.ts algorithm)
export function hash32(...xs: (number | string)[]): number {
  let h = 2166136261 >>> 0;
  for (const x of xs) {
    const s = String(x);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    h ^= 0x9e3779b9; h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  }
  return h >>> 0;
}
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const h01 = (...xs: (number | string)[]) => hash32(...xs) / 4294967296;
/** 1 cm / 1 ms quantisation before any comparison that picks a branch (last-ulp safety across browsers) */
const qm = (x: number) => Math.round(x * 100) / 100;
const qt = (x: number) => Math.round(x * 1000) / 1000;
const yawTo = (a: V3, b: V3) => Math.atan2(b.x - a.x, b.z - a.z);
const fwdOf = (yaw: number) => V(Math.sin(yaw), 0, Math.cos(yaw));

// ------------------------------------------------------------------------------------------------ plan types
export interface ItemSeg {
  t0: number; t1: number;
  /** hidden | at a (yaw) | rise from a (buried) to b | between two crew (their hands) | arc a->b (thrown, peak h) | line a->b (hoisted) */
  mode: 'hidden' | 'at' | 'rise' | 'between' | 'arc' | 'line';
  a?: V3; b?: V3; h?: number; yaw?: number; crew?: [number, number];
}
export interface ItemTrack { id: string; kind: 'bigchest' | 'chest' | 'coinbag'; segs: ItemSeg[] }
/** `ship`: the ship's own rope ladder (a GANGWAY_ node the voyage shows): the crew climbs it and draws no rope. */
export interface RopeEv { kind: 'ladder' | 'hoist'; t0: number; t1: number; top: V3; bottom: V3; unroll: number; ship?: boolean }
export interface FxEv { t: number; kind: 'dust' | 'sparks' | 'coins' | 'sand'; pos: V3; size: number }
export interface Bubble { crew: number; t0: number; t1: number; text: string; loud?: boolean }
export interface Repair { hit: string; crew: number; t0: number; t1: number; pos: V3 }
export interface JobLog { crew: number; t0: number; t1: number; job: string; score?: number }

export interface CrewEpisode {
  id: string; kind: 'battle' | 'treasure';
  /** wall clock ms the episode's local time 0 maps to */
  start: number;
  tracks: Track[];
  /** per crew: local s at which it is back in its cruise loop (the episode no longer drives it); cut short when a later
   *  episode starts first. resume0 = the uncut plan. */
  resume: number[];
  resume0: number[];
  items: ItemTrack[]; ropes: RopeEv[]; fx: FxEv[]; bubbles: Bubble[]; repairs: Repair[]; jobs: JobLog[];
  phases: [number, string][];
  /** the salvo the crew played to (s; given or planned) */
  shots: { gun: string; t: number }[];
  /** treasure: s at which the last crew member is back on deck */
  allAboard?: number;
  /** treasure: the variant that fit the stop window */
  variant?: string;
  /** treasure: the flat stop plane the shore party was planned on (the scene lifts it onto feed.groundAt) */
  ground?: number;
}

export interface CruiseLoop { track: Track; period: number; offset: number; home: DeckSpot; homeFrame?: string; homeClip: string; homeDyn?: 'helm' | 'gunlay' }

export interface PlanCtx {
  deck: CrewDeck;
  cfg: RoomCrewConfig;
  seed: number;
  /** turret yaw (room space, rad) at wall ms: the combat engine's closed form, or the rest yaw */
  gunYaw: (gun: string, ms: number) => number;
}

/** Roster slot -> role (the Cap'n becomes a deckhand when the performer takes the helm). */
export function roleOf(i: number, cfg: RoomCrewConfig): CrewRole {
  const r = CREW_ROLES[i] ?? 'deckhand';
  return r === 'captain' && cfg.helm === 'performer' ? 'deckhand' : r;
}
export const crewCount = (cfg: RoomCrewConfig) => Math.max(1, Math.min(9, Math.round(cfg.count ?? 9)));

export function lineFor(cfg: RoomCrewConfig, key: CrewLineKey, ...salt: (string | number)[]): string {
  const l = cfg.lines?.[key]?.length ? cfg.lines[key]! : CREW_LINES[key];
  return l[hash32(key, ...salt) % l.length];
}

// ------------------------------------------------------------------------------------------------ frames
export function gunOf(deck: CrewDeck, id: string): DeckGun | null { return deck.guns.find((g) => g.id === id) ?? null; }
/** The `GUN_<id>` frame matrix at turret yaw `yaw` (pivot * rotY(yaw)). */
export function gunFrame(g: DeckGun, yaw: number, out = new THREE.Matrix4()) {
  return out.makeRotationY(yaw).setPosition(g.pivot);
}
export function framesFor(ctx: PlanCtx, startMs: number): FrameFn {
  const m = new THREE.Matrix4();
  return (id: string, t: number) => {
    const g = id.startsWith('GUN_') ? gunOf(ctx.deck, id.slice(4)) : null;
    return g ? gunFrame(g, ctx.gunYaw(g.id, startMs + t * 1000), m) : null;
  };
}

// ================================================================================================ cruise loops
interface RoleHome { spot: DeckSpot; frame?: string; clip: string; dyn?: 'helm' | 'gunlay'; dynArg?: string }

export function homeOf(ctx: PlanCtx, i: number): RoleHome {
  const d = ctx.deck, role = roleOf(i, ctx.cfg);
  const sp = (n: string, fb: DeckSpot) => d.spots.get(n) ?? fb;
  const fallback = d.homes[i] ?? d.homes[d.homes.length - 1] ?? { name: 'HOME', pos: d.nav[0].clone(), yaw: 0 };
  switch (role) {
    case 'captain': return { spot: sp('CREW_HELM', fallback), clip: 'helm_hold', dyn: 'helm' };
    case 'gunner_f': case 'gunner_a': {
      const g = gunOf(d, role === 'gunner_f' ? 'F' : 'A') ?? d.guns[0];
      if (!g) return { spot: fallback, clip: 'idle' };
      return { spot: g.seat, frame: `GUN_${g.id}`, clip: 'gun_lay_mid', dyn: 'gunlay', dynArg: g.id };
    }
    case 'loader_f': case 'loader_a': {
      const g = gunOf(d, role === 'loader_f' ? 'F' : 'A') ?? d.guns[0];
      return { spot: g ? g.rack : fallback, clip: 'idle_arms' };
    }
    case 'stoker': return { spot: sp('CREW_STOKER', fallback), clip: 'shovel_scoop' };
    case 'lookout': return { spot: sp('CREW_LOOKOUT', fallback), clip: 'spyglass_look' };
    default: {
      // deckhands: their own home (CREW_HOME_07 / 08); the Cap'n-turned-deckhand borrows a rail spot
      const s = i === 0 ? sp('RAIL_04', fallback) : (d.homes[i] ?? fallback);
      return { spot: s, clip: 'idle_arms' };
    }
  }
}

/** The deck-space pose of a home (turret homes at yaw `gy`). */
function homeDeck(ctx: PlanCtx, h: RoleHome, ms: number): DeckSpot {
  if (!h.frame) return h.spot;
  const g = gunOf(ctx.deck, h.frame.slice(4))!;
  return gunSpotDeck(g, h.spot, ctx.gunYaw(g.id, ms));
}

export function cruiseLoop(ctx: PlanCtx, i: number): CruiseLoop {
  const d = ctx.deck, role = roleOf(i, ctx.cfg);
  const h = homeOf(ctx, i);
  const r = rng(hash32(ctx.seed, 'cruise', i));
  const tb = new TB(0, h.spot.pos.clone(), h.spot.yaw, h.frame);
  const spot = (n: string) => d.spots.get(n) ?? null;
  const goTo = (s: DeckSpot | null, speed = CREW_SPEED.walk, clip = 'walk') => {
    if (!s) return false;
    tb.route(route(d, tb.p, s.pos, (i % 3 - 1) * 0.22), speed, clip);
    tb.face(s.yaw, 'idle', 0.4);
    return true;
  };
  const backHome = () => {
    if (h.frame) return;
    if (tb.p.distanceTo(h.spot.pos) > 0.05) goTo(h.spot);
    tb.face(h.spot.yaw, h.clip, 0.4);
  };
  switch (role) {
    case 'captain':
      tb.hold(40 + Math.round(r() * 20), h.clip, { dyn: 'helm' });
      break;
    case 'gunner_f': case 'gunner_a': {
      const gArg = h.dynArg;
      tb.hold(10 + Math.round(r() * 4), 'polish');
      tb.hold(5, 'idle_b');
      tb.hold(6, 'gun_lay_mid', { dyn: 'gunlay', dynArg: gArg });
      tb.hold(6 + Math.round(r() * 4), 'idle_arms');
      tb.hold(4, 'polish');
      break;
    }
    case 'loader_f': case 'loader_a': {
      tb.hold(8, 'idle_arms');
      const rail = spot(role === 'loader_f' ? 'RAIL_03' : 'RAIL_04');
      if (goTo(rail)) { tb.hold(9 + Math.round(r() * 4), 'idle_b'); tb.hold(3, 'laugh'); }
      backHome();
      tb.hold(6, 'idle');
      break;
    }
    case 'stoker':
      tb.hold(clipDur('shovel_scoop') * 12, 'shovel_scoop');
      tb.hold(5, 'idle_b', { held: undefined });
      tb.hold(clipDur('shovel_scoop') * 3, 'shovel_scoop');
      break;
    case 'lookout': {
      tb.hold(12, 'spyglass_look');
      const far = d.nav.filter((n) => Math.abs(n.y - h.spot.pos.y) < 0.6 && n.distanceTo(h.spot.pos) > 1.2);
      if (far.length) {
        const p = far[Math.floor(r() * far.length) % far.length];
        tb.go([p], CREW_SPEED.walk, 'walk');
        tb.face(h.spot.yaw + (r() - 0.5) * 2, 'idle_b', 0.5);
        tb.hold(6, 'idle_b');
        tb.hold(9, 'spyglass_look');
        tb.go([h.spot.pos], CREW_SPEED.walk, 'walk');
      }
      tb.face(h.spot.yaw, 'spyglass_look', 0.5);
      tb.hold(6, 'spyglass_look');
      break;
    }
    default: {
      // deckhands: swab a stretch, a sit-down, a look over the rail, back home
      const k = i % 2 ? 0 : 1;          // (7: port side spots, 8: starboard; their homes)
      const swab = spot(k ? 'SWAB_02' : 'SWAB_01');
      if (goTo(swab)) tb.hold(12 + Math.round(r() * 4), 'swab');
      // (the deck's ring seats in name order: deckhand 8 the first, deckhand 7 the second - port / starboard on the preset deck)
      const seats = [...d.spots.keys()].filter((nm) => nm.startsWith('RING_SEAT_')).sort();
      const seat = seats.length ? spot(seats[(k ? 0 : 1) % seats.length]) : null;
      if (goTo(seat)) tb.hold(14 + Math.round(r() * 6), 'sit_deck');
      const rail = spot(k ? 'RAIL_02' : 'RAIL_01');
      if (goTo(rail)) { tb.hold(7, 'idle_b'); tb.hold(2.8, 'laugh'); }
      backHome();
      tb.hold(6 + Math.round(r() * 4), h.clip);
    }
  }
  const natural = trackEnd(tb);
  const period = Math.ceil(natural + 0.5);
  tb.until(period, h.clip, h.dyn ? { dyn: h.dyn, dynArg: h.dynArg } : {});
  const offset = Math.floor(r() * period * 1000) / 1000;
  return { track: { segs: tb.segs, overlays: tb.overlays }, period, offset, home: h.spot, homeFrame: h.frame, homeClip: h.clip, homeDyn: h.dyn };
}

/** Local cruise time (s) of crew i at wall ms. */
export const cruiseTime = (c: CruiseLoop, ms: number) => {
  const t = ms / 1000 - c.offset;
  return ((t % c.period) + c.period) % c.period;
};
/** First cruise loop boundary at or after wall ms (ms). */
export const nextBoundary = (c: CruiseLoop, ms: number) => {
  const t = ms / 1000 - c.offset;
  return (c.offset + Math.ceil(t / c.period - 1e-9) * c.period) * 1000;
};

// ================================================================================================ episode planning
export interface CrewState { pos: V3; yaw: number; frame?: string; clip: string; held?: string }

/** Where everyone is at wall ms `ms` (deck space; frames resolved) given the earlier planned episodes. */
export function stateAt(ctx: PlanCtx, cruise: CruiseLoop[], eps: CrewEpisode[], i: number, ms: number): CrewState {
  const ep = activeEpisode(eps, i, ms);
  let s: Sample | null;
  if (ep) s = sampleTrack(ep.tracks[i], (ms - ep.start) / 1000, framesFor(ctx, ep.start));
  else s = sampleTrack(cruise[i].track, cruiseTime(cruise[i], ms), framesFor(ctx, ms - cruiseTime(cruise[i], ms) * 1000));
  if (!s) { const h = cruise[i].home; return { pos: h.pos.clone(), yaw: h.yaw, clip: 'idle' }; }
  return { pos: V(qm(s.pos.x), qm(s.pos.y), qm(s.pos.z)), yaw: qt(s.yaw), clip: s.clip, ...(s.held ? { held: s.held } : {}) };
}

export function activeEpisode(eps: CrewEpisode[], i: number, ms: number): CrewEpisode | null {
  for (let k = eps.length - 1; k >= 0; k--) {
    const e = eps[k];
    if (ms >= e.start && ms < e.start + e.resume[i] * 1000) return e;
  }
  return null;
}

class Ep {
  tbs: TB[] = [];
  ep: CrewEpisode;
  constructor(public ctx: PlanCtx, public cruise: CruiseLoop[], id: string, kind: 'battle' | 'treasure', start: number, init: CrewState[]) {
    this.ep = { id, kind, start, tracks: [], resume: [], resume0: [], items: [], ropes: [], fx: [], bubbles: [], repairs: [], jobs: [], phases: [], shots: [] };
    this.tbs = init.map((s) => { const tb = new TB(0, s.pos.clone(), s.yaw); tb.held = undefined; return tb; });
  }
  get n() { return this.tbs.length; }
  role(i: number) { return roleOf(i, this.ctx.cfg); }
  ms(t: number) { return this.ep.start + t * 1000; }
  /** deck-space pose of a turret-frame spot at local time t */
  gunSpot(gid: string, s: DeckSpot, t: number) { const g = gunOf(this.ctx.deck, gid)!; return gunSpotDeck(g, s, this.ctx.gunYaw(gid, this.ms(t))); }
  lane(i: number) { return ((i % 3) - 1) * 0.22; }
  /** route crew i (deck space) to a deck point */
  goDeck(i: number, to: V3, speed: number, clip: string, held?: string) {
    const tb = this.tbs[i];
    if (tb.p.distanceTo(to) < 0.05) return;
    const o = held !== undefined ? { held } : {};
    if (direct(this.ctx.deck, tb.p, to)) tb.stepTo(to, speed, clip, o);
    else tb.route(route(this.ctx.deck, tb.p, to, this.lane(i)), speed, clip, o);
  }
  /** route crew i to a turret-frame spot: the last hop ends in the frame */
  goGun(i: number, gid: string, s: DeckSpot, speed: number, clip: string, held?: string) {
    const tb = this.tbs[i];
    const est = this.gunSpot(gid, s, tb.t + 2);
    const pts = direct(this.ctx.deck, tb.p, est.pos) ? [{ p: tb.p.clone(), kind: 'walk' as const }, { p: est.pos.clone(), kind: 'walk' as const }] : route(this.ctx.deck, tb.p, est.pos, this.lane(i));
    const last = pts.pop();
    if (pts.length > 1) tb.route(pts, speed, clip, held !== undefined ? { held } : {});
    const ho = held !== undefined ? { held } : {};
    let from = tb.p.clone();
    // a level change onto / off the gun's platform or loading step: hop it (STEP_DY), never a slope through the riser
    const ddx = est.pos.x - from.x, ddz = est.pos.z - from.z, DL = Math.hypot(ddx, ddz), dy = est.pos.y - from.y;
    if (dy > STEP_DY) {
      if (DL > 0.35) { tb.go([V(est.pos.x - (ddx / DL) * 0.3, from.y, est.pos.z - (ddz / DL) * 0.3)], speed, clip, ho); from = tb.p.clone(); }
      tb.push({ ...ho, clip: 'jump_off', dur: 0.24 + Math.min(0.3, dy * 0.3), a: from, b: s.pos.clone(), arc: { h: 0.12 + dy * 0.15 }, endFrame: `GUN_${gid}`, yaw0: tb.yaw, yaw1: s.yaw, off: 0.12, loop: false });
      tb.face(s.yaw, clip === 'carry_shell' ? 'carry_shell' : 'idle', 0.25, { frame: `GUN_${gid}` });
      return;
    }
    if (dy < -STEP_DY && DL > 0.35) {
      const post = V(from.x + (ddx / DL) * 0.3, est.pos.y, from.z + (ddz / DL) * 0.3);
      tb.push({ ...ho, clip: 'fall', dur: 0.24 + Math.min(0.3, -dy * 0.25), a: from, b: post, arc: { h: 0.12 }, yaw0: tb.yaw, yaw1: yawTo(from, post) });
      from = tb.p.clone();
    }
    const L = from.distanceTo(last && dy >= -STEP_DY ? last.p : est.pos);
    tb.push({ clip, dur: Math.max(0.3, L / speed), a: from, b: s.pos.clone(), path: [from, s.pos.clone()], plen: [0, L], endFrame: `GUN_${gid}`, yaw0: tb.yaw, yaw1: s.yaw, ...ho });
    // (distance-locked: the walk keeps its stride; the frame moves the end point)
    const seg = tb.segs[tb.segs.length - 1];
    const cyc = clipMeta(clip)?.cycle;
    if (cyc) { seg.dist0 = tb.walked; seg.cyc = cyc; tb.walked += L; }
    tb.face(s.yaw, clip === 'carry_shell' ? 'carry_shell' : 'idle', 0.25, { frame: `GUN_${gid}` });
  }
  /** leave a turret frame (convert the local pose at the builder's current time) */
  leaveGun(i: number) {
    const tb = this.tbs[i];
    if (!tb.frame) return;
    const gid = tb.frame.slice(4);
    const d = this.gunSpot(gid, { name: '', pos: tb.p, yaw: tb.yaw }, tb.t);
    tb.unframe(d.pos, d.yaw);
  }
  bubble(i: number, t: number, text: string, dur = 2.4, loud = false) {
    if (this.ctx.cfg.bubbles === false) return;
    if (this.ep.bubbles.some((b) => b.crew === i && t < b.t1 && t + dur > b.t0)) return;
    this.ep.bubbles.push({ crew: i, t0: qt(t), t1: qt(t + dur), text, ...(loud ? { loud: true } : {}) });
  }
  job(i: number, t0: number, t1: number, job: string, score?: number) { this.ep.jobs.push({ crew: i, t0: qt(t0), t1: qt(t1), job, ...(score !== undefined ? { score: Math.round(score * 100) / 100 } : {}) }); }
  /** walk home, hold the home clip until the next cruise boundary; returns the resume time */
  homeAndResume(i: number, minT: number) {
    const tb = this.tbs[i];
    const h = homeOf(this.ctx, i);
    tb.until(minT, 'idle');
    if (h.frame) {
      this.leaveGun(i);
      this.goGun(i, h.frame.slice(4), h.spot, CREW_SPEED.walk, 'walk');
      tb.hold(0.3, h.clip, { frame: h.frame, ...(h.dyn ? { dyn: h.dyn, dynArg: h.dynArg } : {}) });
    } else {
      this.goDeck(i, h.spot.pos, CREW_SPEED.walk, 'walk');
      tb.face(h.spot.yaw, h.clip, 0.4, h.dyn ? { dyn: h.dyn, dynArg: h.dynArg } : {});
    }
    const b = nextBoundary(this.cruise[i], this.ms(tb.t));
    tb.until((b - this.ep.start) / 1000, h.clip, { ...(h.frame ? { frame: h.frame } : {}), ...(h.dyn ? { dyn: h.dyn, dynArg: h.dynArg } : {}) });
    return trackEnd(tb);
  }
  finish() {
    this.ep.tracks = this.tbs.map((tb) => ({ segs: tb.segs, overlays: tb.overlays }));
    for (let i = 0; i < this.n; i++) this.ep.resume[i] ??= 0;
    this.ep.resume0 = this.ep.resume.slice();
    return this.ep;
  }
}


/** A short same-level hop with nothing in the way: walk straight (no detour through the nav graph). */
function direct(deck: CrewDeck, a: V3, b: V3) {
  // (same level within 3.5 m, or one step / platform edge away: a hop)
  const dh = Math.hypot(a.x - b.x, a.z - b.z), dy = Math.abs(a.y - b.y);
  if (dy > 0.3 ? dy > 0.85 || dh > 1.6 : dh > 3.5) return false;
  if (deck.keepout) for (let k = 0; k <= 8; k++) if (deck.keepout.containsPoint(a.clone().lerp(b, k / 8))) return false;
  return true;
}

// ------------------------------------------------------------------------------------------------ battle

/** The crew's own salvo rhythm when the combat engine gives no shots (test pages): alternating guns, >= 4.6 s apart per gun. */
export function synthShots(id: string, seed: number, dur: number, guns: string[]): { gun: string; t: number }[] {
  const r = rng(hash32(seed, id, 'salvo'));
  const out: { gun: string; t: number }[] = [];
  const first = Math.max(10, Math.min(20, dur * 0.15));
  guns.forEach((g, k) => {
    let t = first + k * 2.3;
    while (t < dur - 3) { out.push({ gun: g, t: qt(t) }); t += 4.6 + r() * 1.6; }
  });
  return out.sort((a, b) => a.t - b.t);
}

export function planBattle(ctx: PlanCtx, cruise: CruiseLoop[], b: CrewBattleIn, init: CrewState[]): CrewEpisode {
  const E = new Ep(ctx, cruise, b.id, 'battle', b.alert, init);
  const ep = E.ep, n = E.n, deck = ctx.deck;
  const D = qt((b.end - b.alert) / 1000);
  const guns = deck.guns.map((g) => g.id);
  const shots = b.shots.length || b.synth === false ? b.shots.map((s) => ({ gun: s.gun, t: qt((s.at - b.alert) / 1000) })).filter((s) => s.t > 0 && guns.includes(s.gun)) : synthShots(b.id, ctx.seed, D, guns);
  ep.shots = shots;
  const first = shots.length ? shots[0].t : D;
  ep.phases = [[0, 'ALERT'], [Math.max(0.5, first - 1.5), 'COMBAT'], [D, b.outcome === 'win' ? 'VICTORY' : 'FLEE']];
  const r = rng(hash32(ctx.seed, b.id, 'battle'));
  const busy = new Array(n).fill(0);
  const roles = Array.from({ length: n }, (_, i) => E.role(i));
  // ---- the lookout: point at the threat + shout (>= 1.5 s before the first shot), alarm, then the spyglass on it
  const look = roles.indexOf('lookout');
  if (look >= 0) {
    const tb = E.tbs[look];
    const perch = deck.spots.get('CREW_LOOKOUT');
    if (perch && tb.p.distanceTo(perch.pos) > 0.3) E.goDeck(look, perch.pos, CREW_SPEED.run, 'run');
    tb.face(b.bearing, 'point', 0.3);
    const tp = tb.t;
    tb.hold(Math.max(1.6, Math.min(3, first - tb.t - 1.6)), 'point');
    E.bubble(look, tp + 0.1, lineFor(ctx.cfg, 'alert', b.id), 2.6, true);
    tb.hold(1.6, 'wave_alarm');
    tb.until(D, 'spyglass_look', { yaw0: b.bearing, yaw1: b.bearing });
    busy[look] = D;
    E.job(look, 0, D, 'lookout');
  }
  // ---- the Cap'n at the helm (the wheel follows the voyage feed), shouting stations
  const cap = roles.indexOf('captain');
  if (cap >= 0) {
    const tb = E.tbs[cap];
    const helm = deck.spots.get('CREW_HELM');
    if (helm && tb.p.distanceTo(helm.pos) > 0.3) { E.goDeck(cap, helm.pos, CREW_SPEED.run, 'run'); tb.face(helm.yaw, 'helm_hold', 0.3, { dyn: 'helm' }); }
    E.bubble(cap, Math.max(0.8, tb.t), lineFor(ctx.cfg, 'stations', b.id), 2.4, true);
    tb.until(D, 'helm_hold', { dyn: 'helm' });
    busy[cap] = D;
    E.job(cap, 0, D, 'helm');
  }
  // ---- gunners ride their turrets; ear-flinch on every own shot
  for (const gid of guns) {
    const gi = roles.indexOf(gid === 'F' ? 'gunner_f' : 'gunner_a');
    if (gi < 0) continue;
    const g = gunOf(deck, gid)!;
    const tb = E.tbs[gi];
    if (!tb.frame) E.goGun(gi, gid, g.seat, CREW_SPEED.run, 'run');
    tb.until(D, 'gun_lay_mid', { frame: `GUN_${gid}`, dyn: 'gunlay', dynArg: gid });
    for (const s of shots) if (s.gun === gid) tb.over(s.t - 0.05, 'flinch_ears');
    busy[gi] = D;
    E.job(gi, 0, D, `gunner_${gid}`);
  }
  // ---- loaders: rack -> shell -> breech -> ram (done >= 0.3 s before each shot) -> back
  for (const gid of guns) {
    const li = roles.indexOf(gid === 'F' ? 'loader_f' : 'loader_a');
    if (li < 0) continue;
    const g = gunOf(deck, gid)!;
    const tb = E.tbs[li];
    if (tb.frame) E.leaveGun(li);
    E.goDeck(li, g.rack.pos, CREW_SPEED.run, 'run');
    tb.face(g.rack.yaw, 'idle', 0.25);
    const breechAt = (t: number) => E.gunSpot(gid, g.breech, t);
    const myShots = shots.filter((s) => s.gun === gid);
    for (let k = 0; k < myShots.length; k++) {
      const shotT = myShots[k].t;
      const Lc = g.rack.pos.distanceTo(breechAt(shotT).pos);
      const ramEv = clipEvent('shell_ram', 'ram', 0.55);
      // a loader who reached the rack late (a long way round from his post to a rack the deck reaches only by a detour:
      // the first round of a battle) hurries: a quicker grab and the shell carried at a jog, so the ram is still done
      // >= 0.3 s before the shot (the combat engine keeps one gun's shots >= 4.2 s apart: this only ever bites on round 1)
      const slack = shotT - 0.45 - ramEv - 0.25 - Lc / CREW_SPEED.carryShell - 0.35 - tb.t;
      const hurry = slack < 0;
      const vCarry = hurry ? Math.min(CREW_SPEED.run, CREW_SPEED.carryShell * 1.5) : CREW_SPEED.carryShell;
      const grab = hurry ? 0.2 : 0.35;
      const Tc = Lc / vCarry;
      const wantCarry = shotT - 0.45 - ramEv - 0.25 - Tc;
      const startGrab = Math.max(tb.t, wantCarry - grab);
      if (startGrab > tb.t + 0.05) tb.until(startGrab, 'idle_arms');
      tb.hold(grab, 'carry_idle', { held: 'shell' });
      tb.held = 'shell';
      E.goGun(li, gid, g.breech, vCarry, 'carry_shell', 'shell');
      tb.once('shell_ram', { held: 'shell', frame: `GUN_${gid}` });
      tb.held = undefined;
      tb.over(shotT - 0.05, 'flinch_ears');
      E.job(li, startGrab, tb.t, `load_${gid}#${k}`);
      E.leaveGun(li);
      // (always straight back to the rack and the same wait there, whether or not another shot is known yet: a shot
      // stamped later only changes what happens after it is known - pages that re-plan never jump)
      E.goDeck(li, g.rack.pos, CREW_SPEED.run, 'run'); tb.face(g.rack.yaw, 'idle', 0.2);
    }
    tb.until(D, 'idle_arms');
    busy[li] = D;
  }
  // ---- the stoker shovels faster
  const stk = roles.indexOf('stoker');
  if (stk >= 0) {
    const tb = E.tbs[stk];
    const home = homeOf(ctx, stk).spot;
    if (tb.p.distanceTo(home.pos) > 0.3) { E.goDeck(stk, home.pos, CREW_SPEED.run, 'run'); tb.face(home.yaw, 'shovel_scoop', 0.3); }
    // (his shovelling runs to D after the repair jobs: one may borrow him first)
    busy[stk] = D;
    E.job(stk, 0, D, 'stoke');
  }
  // ---- repair jobs: every hit -> a job 0.8 s later, greedy utility over the free hands
  const hands = Array.from({ length: n }, (_, i) => i).filter((i) => roles[i] === 'deckhand');
  // stand-by stations: amidships, one per side
  for (const i of hands) {
    const tb = E.tbs[i];
    const s = homeOf(ctx, i).spot;
    E.goDeck(i, s.pos, CREW_SPEED.run, 'run');
    tb.face(s.yaw, 'idle_b', 0.3);
  }
  const free = new Array(n).fill(0).map((_, i) => (hands.includes(i) ? E.tbs[i].t : Infinity));
  const stokerBackup = stk >= 0 ? stk : -1;
  // (in time order: a hit stamped later never changes how an earlier one was handled)
  const hitsT = b.hits.map((h, k) => [k, h] as const).sort((x, y) => x[1].at - y[1].at || (String(x[1].id) < String(y[1].id) ? -1 : 1));
  for (const [hk, hit] of hitsT) {
    const ht = qt((hit.at - b.alert) / 1000);
    if (ht <= 0 || ht >= D) continue;
    const pos = V(hit.pos[0], hit.pos[1], hit.pos[2]);
    // flinch: anyone within 4 m
    for (let i = 0; i < n; i++) {
      const st = sampleTrack({ segs: E.tbs[i].segs, overlays: [] }, ht, framesFor(ctx, b.alert));
      if (st && st.pos.distanceTo(pos) < 4) E.tbs[i].over(ht, 'hit');
    }
    const jt = ht + 0.8;
    const work = workSpot(deck, pos);
    const hid = hit.id ?? `h${hk}`;
    // utility
    const cands = [...hands, ...(stokerBackup >= 0 ? [stokerBackup] : [])];
    let best = -1, bestS = -Infinity;
    for (const i of cands) {
      const isHand = hands.includes(i);
      const at = isHand ? Math.max(free[i], jt) : Math.max(E.tbs[i].t, jt);
      if (!isHand && hands.some((h) => free[h] <= jt + 8)) continue;          // the stoker only when every hand is tied up
      const tb = E.tbs[i];
      const st = sampleTrack({ segs: tb.segs, overlays: [] }, Math.min(at, trackEnd(tb)), framesFor(ctx, b.alert));
      const from = st ? st.pos : tb.p;
      const dist = navDist(deck, from, work.pos);
      const P = 80 + 10 * hit.severity;
      const s = P * (1 / (1 + dist / 6)) * (isHand ? 1.3 : 0.6) * (0.9 + 0.2 * h01(ctx.seed, b.id, hk, i)) / (1 + Math.max(0, at - jt) / 4);
      if (s > bestS + 1e-9) { bestS = s; best = i; }
    }
    if (best < 0) continue;
    const i = best, tb = E.tbs[i];
    const start = Math.max(jt, free[i] === Infinity ? tb.t : free[i]);
    tb.until(start, i === stokerBackup ? 'shovel_scoop' : 'idle_b', i === stokerBackup ? { rate: 1.3 } : {});
    E.goDeck(i, work.pos, CREW_SPEED.run, 'run', undefined);
    const high = pos.y - work.pos.y > 0.45 && pos.y - work.pos.y < 1.4;
    tb.face(work.yaw, 'idle', 0.25);
    const dur = 4 + 2 * hit.severity;
    const w0 = tb.t;
    if (hit.severity >= 3) { tb.hold(dur / 2, high ? 'hammer_wall' : 'hammer_low'); tb.hold(dur / 2, high ? 'weld_stand' : 'weld_low'); }
    else tb.hold(dur, hit.severity === 1 ? (high ? 'hammer_wall' : 'hammer_low') : (high ? 'weld_stand' : 'weld_low'));
    ep.repairs.push({ hit: hid, crew: i, t0: qt(w0), t1: qt(tb.t), pos });
    // sparks at the hull site itself while it is worked (exterior shots see the repair; SPEC C15)
    for (let t = w0 + 0.4; t < tb.t - 0.2; t += 1.1) ep.fx.push({ t: qt(t), kind: 'sparks', pos: pos.clone(), size: 0.8 });
    if (h01(ctx.seed, b.id, 'rb', hk) < 0.45) E.bubble(i, w0 + 0.3, lineFor(ctx.cfg, 'repair', b.id, hk), 2.2);
    if (hk === 0) { const near = cands.find((c) => c !== i) ?? i; E.bubble(near, ht + 0.1, lineFor(ctx.cfg, 'hit', b.id), 1.8, true); }
    E.job(i, start, tb.t, `repair:${hid}`, bestS);
    free[i] = tb.t;
    if (i === stokerBackup && stk >= 0) {     // back to the shovel
      const home = homeOf(ctx, stk).spot;
      E.goDeck(stk, home.pos, CREW_SPEED.run, 'run'); tb.face(home.yaw, 'shovel_scoop', 0.3);
    }
  }
  for (const i of hands) E.tbs[i].until(D, 'idle_b');
  if (stk >= 0) E.tbs[stk].until(D, 'shovel_scoop', { rate: 1.3 });
  // ---- victory / the enemy flees
  const win = b.outcome === 'win';
  const said = new Set<number>();
  for (let i = 0; i < n; i++) {
    const tb = E.tbs[i];
    tb.until(D, 'idle');
    const tv = D + 0.3 + h01(ctx.seed, b.id, 'v', i) * 0.6;
    tb.until(tv, tb.segs.length ? tb.segs[tb.segs.length - 1].clip : 'idle', tb.segs.length && tb.segs[tb.segs.length - 1].dyn ? { dyn: tb.segs[tb.segs.length - 1].dyn, dynArg: tb.segs[tb.segs.length - 1].dynArg } : {});
    const role = roles[i];
    const clip = role === 'captain' ? 'wave' : !win ? (h01(ctx.seed, b.id, 'f', i) < 0.5 ? 'laugh' : 'wave') : role === 'lookout' || role === 'deckhand' ? 'jump_cheer' : 'cheer';
    tb.hold(3.5, clip, tb.frame ? { frame: tb.frame } : {});
    if (said.size < 2 && h01(ctx.seed, b.id, 'vb', i) < 0.4) { said.add(i); E.bubble(i, tv + 0.2, lineFor(ctx.cfg, win ? 'victory' : 'flee', b.id, i), 2.6, true); }
  }
  if (!said.size && n) E.bubble(cap >= 0 ? cap : 0, D + 0.5, lineFor(ctx.cfg, win ? 'victory' : 'flee', b.id), 2.6, true);
  ep.phases.push([D + 4.4, 'CRUISE']);
  for (let i = 0; i < n; i++) ep.resume[i] = qt(E.homeAndResume(i, D + 4.4));
  return E.finish();
}

/** Where to stand to fix a hull hit: a known hull site's (DAMAGE_nn) fitted stand, else the walkable point nearest it,
 *  facing it, kept clear of the rail (a hit on the hull below is worked leaning over the rail). */
export function workSpot(deck: CrewDeck, hit: V3): DeckSpot {
  let site: CrewDeck['repairs'][number] | null = null, sd = 0.6;
  for (const r of deck.repairs) { const d = r.pos.distanceTo(hit); if (d < sd) { sd = d; site = r; } }
  if (site) { const s = site.stand; return { name: 'WORK', pos: s.pos.clone(), yaw: Math.atan2(hit.x - s.pos.x, hit.z - s.pos.z) }; }
  return standFor(deck, hit);
}

// ------------------------------------------------------------------------------------------------ treasure stops
export interface StopVariant { name: string; party: number; dig: number; haul: ('bigchest' | 'chest' | 'bag')[]; cheer: boolean; near?: boolean; sprint?: number }
/** The near edge of the SPEC C14 dig sector (x +10..+22, z -22..-40 on the party's side): the default dig site, and
 *  the short-window variants' site when it is nearer than the room's own. */
export const NEAR_DIG: [number, number] = [10.5, -22.5];
// (longest first; a window fit takes the first that fits. 'quick' digs at the near edge of the sector and hauls the same
// loot, 'dash' sends two for a coin bag and both run back: a ~60 s window on the SPEC ship still sends a party ashore)
const VARIANTS = (haul: ('bigchest' | 'chest' | 'bag')[]): StopVariant[] => [
  { name: 'full', party: 3, dig: 3.6, haul, cheer: true },
  { name: 'quick', party: 3, dig: 2.4, haul, cheer: false, near: true },
  { name: 'dash', party: 2, dig: 1.6, haul: ['bag'], cheer: false, near: true, sprint: 1.3 },
  { name: 'wave', party: 0, dig: 0, haul: [], cheer: true },
];

export function planTreasure(ctx: PlanCtx, cruise: CruiseLoop[], s: CrewStopIn, init: CrewState[]): CrewEpisode {
  // (the same 1.5 s margin crewStopDuration adds: a stop stamped with until = at + stopDuration fits the full plan)
  const window = s.until ? (s.until - s.at) / 1000 - 1.5 + 1e-3 : Infinity;
  const haul = s.haul?.length ? s.haul : ['bigchest', 'bag'] as ('bigchest' | 'chest' | 'bag')[];
  let last: CrewEpisode | null = null;
  for (const v of VARIANTS(haul)) {
    const ep = planTreasureVariant(ctx, cruise, s, init, v);
    last = ep;
    if ((ep.allAboard ?? 0) <= window) return ep;
  }
  return last!;
}

/** How long the ship must stay halted for this stop (s, the voyage holds the halt for it): the planned last-aboard
 *  time + 1.5 s. Pure: `prior` = the episodes (battles, earlier stops) known before it, exactly as the pages plan
 *  them (a battle that ended just before the stop leaves the crew elsewhere: the stop takes longer). */
export function crewStopDuration(ctx: PlanCtx, cruise: CruiseLoop[], s: CrewStopIn, prior: CrewEpisodeIn[] = [], cache?: Map<string, CrewEpisode>): number {
  const before = prior.filter((e) => e.id !== s.id && startOf(e) < s.at);
  const eps = planEpisodes(ctx, cruise, [...before, { ...s, until: undefined }], cache);
  const ep = eps.find((e) => e.id === s.id);
  return qt((ep?.allAboard ?? 0) + 1.5);
}

function planTreasureVariant(ctx: PlanCtx, cruise: CruiseLoop[], s: CrewStopIn, init: CrewState[], v: StopVariant): CrewEpisode {
  const E = new Ep(ctx, cruise, s.id, 'treasure', s.at, init);
  E.ep.variant = v.name;
  const ep = E.ep, n = E.n, deck = ctx.deck, cfg = ctx.cfg;
  const roles = Array.from({ length: n }, (_, i) => E.role(i));
  const ground = s.groundY ?? cfg.ground ?? deck.ground;
  ep.ground = ground;
  // (SPEC 4.3 / C14: the shore party goes over the starboard side, the catcher at CREW_CATCH_S; `side` overrides)
  const side: 'port' | 'starboard' = s.side ?? 'starboard';
  const ladder = deck.ladders[side] ?? deck.ladders.port ?? deck.ladders.starboard;
  const catchSp = deck.catches[side] ?? ladder;
  const allJumps = deck.jumps[side].length ? deck.jumps[side] : deck.jumps.port;
  if (!ladder || !catchSp || !allJumps.length) { for (let i = 0; i < n; i++) ep.resume[i] = 0; ep.allAboard = 0; return E.finish(); }
  const out = fwdOf(ladder.yaw);
  const ladderTop = ladder.pos.clone();
  // the ship's own rope ladder (GANGWAY_<side>): climbed where it hangs, drawn by the voyage, not by us
  const gw = deck.gangways[side];
  // the rail top (geometry fit, else ~0.95 m up just outboard) and how far out the hull bulges below it: ropes hang
  // from the rail and their feet stand clear of the hull
  const lr = ladder.rail;
  const railTop = gw ? gw.pos.clone() : lr ? ladderTop.clone().addScaledVector(out, lr.d).setY(lr.y) : ladderTop.clone().add(V(0, 0.95, 0)).addScaledVector(out, 0.15);
  const ladderBase = gw ? V(gw.pos.x, ground, gw.pos.z) : V(ladderTop.x, ground, ladderTop.z).addScaledVector(out, lr ? Math.max(0.6, lr.d + lr.out + 0.25) : 1.1);
  const cr = catchSp.rail;
  const hoistTop = cr ? catchSp.pos.clone().addScaledVector(out, cr.d + 0.1).setY(cr.y + 0.1) : catchSp.pos.clone().add(V(0, 1.05, 0)).addScaledVector(out, 0.35);
  const hoistBase = V(hoistTop.x, ground, hoistTop.z).addScaledVector(out, cr ? Math.max(0.5, cr.out + 0.3) : 1.0);
  // obstacles on the sand: the walker's planted feet (r 2 m) and the alongside size spots (SPEC C14)
  const feet = [...(s.feet ? s.feet.map(([x, z]) => ({ pos: V(x, ground, z), r: 2.0 })) : deck.feet.map((f) => ({ pos: V(f.pos.x, ground, f.pos.z), r: f.r }))),
    ...deck.avoid.map((a) => ({ pos: V(a.pos.x, ground, a.pos.z), r: a.r }))];
  // jump points whose landing is clear of the leg feet (and of the hull bulge)
  const landOf = (j: DeckSpot, k: number) => {
    const f = fwdOf(j.yaw);
    const rail = j.rail ? j.pos.clone().addScaledVector(f, j.rail.d).setY(j.rail.y) : j.pos.clone().add(V(0, 0.95, 0)).addScaledVector(f, 0.25);
    const land = V(rail.x, ground, rail.z).addScaledVector(f, Math.max(2.6, (j.rail?.out ?? 0) + 1.6) + 0.3 * k);
    return { rail, land };
  };
  const jumps = allJumps.filter((j) => feet.every((ft) => Math.hypot(landOf(j, 1).land.x - ft.pos.x, landOf(j, 1).land.z - ft.pos.z) > ft.r + 0.8));
  const mid = (jumps.length ? jumps : allJumps).reduce((a, j) => a.add(j.pos), V()).multiplyScalar(1 / (jumps.length || allJumps.length));
  const r = rng(hash32(ctx.seed, s.id, 'loot'));
  // the dig site: the stop's own, else the config's / SPEC C14 sector (forward of the jump points on the party's side),
  // nudged clear of every obstacle on the sand
  const own = cfg.digSite ?? (deck.digSite ? [Math.abs(deck.digSite.x), deck.digSite.z] : NEAR_DIG);
  const ax = Math.abs(mid.x);
  const ds = v.near && Math.hypot(NEAR_DIG[0] - ax, NEAR_DIG[1] - mid.z) < Math.hypot(Math.abs(own[0]) - ax, own[1] - mid.z) ? NEAR_DIG : own;
  const jit = ds === own ? 2 : 1;
  const sgn = side === 'port' ? -1 : 1;
  const loot = s.loot ? V(s.loot[0], s.loot[1], s.loot[2]) : V(sgn * (Math.abs(ds[0]) + r() * jit), ground, ds[1] - r() * jit);
  loot.y = ground;
  for (let it = 0; it < 4; it++) for (const o of feet) {
    const dx = loot.x - o.pos.x, dz = loot.z - o.pos.z, d = Math.hypot(dx, dz), need = o.r + 1.6;
    if (d < need) { const ux = d > 1e-3 ? dx / d : sgn, uz = d > 1e-3 ? dz / d : 0; loot.x = o.pos.x + ux * need; loot.z = o.pos.z + uz * need; }
  }
  const drop = (jumps[0] ?? allJumps[0]).pos.y - ground;
  const jumpMax = cfg.jumpMax ?? 9;
  ep.phases = [[0, 'TREASURE']];
  // ---- lookout: point at the loot + shout
  const look = roles.indexOf('lookout');
  if (look >= 0) {
    const tb = E.tbs[look];
    tb.face(yawTo(tb.p, loot), 'point', 0.4);
    E.bubble(look, 0.3, lineFor(cfg, 'treasure', s.id), 2.6, true);
    tb.hold(3.2, 'point');
  }
  // ---- the Cap'n holds the (stopped) wheel
  const cap = roles.indexOf('captain');
  // ---- shore party (utility: P(shore) = 75, deckhands 1.3, loaders 1.0; never the Cap'n / stoker / lookout / gunners)
  const pick = (P: number, aff: (role: CrewRole) => number, exclude: Set<number>, near: V3, k: number) => {
    const scored: { i: number; s: number }[] = [];
    for (let i = 0; i < n; i++) {
      if (exclude.has(i)) continue;
      const a = aff(roles[i]);
      if (a <= 0) continue;
      const dist = navDist(deck, E.tbs[i].p, near);
      scored.push({ i, s: P * (1 / (1 + dist / 6)) * a * (0.9 + 0.2 * h01(ctx.seed, s.id, P, i)) });
    }
    scored.sort((x, y) => y.s - x.s || x.i - y.i);
    return scored.slice(0, k);
  };
  const used = new Set<number>([look, cap].filter((x) => x >= 0));
  const party = pick(75, (rl) => (rl === 'deckhand' ? 1.3 : rl === 'loader_f' || rl === 'loader_a' ? 1.0 : 0), used, (jumps[0] ?? ladder).pos, v.party);
  party.forEach((p) => { used.add(p.i); E.job(p.i, 0, 0, 'shore', p.s); });
  const catcherP = pick(70, (rl) => (rl === 'gunner_f' || rl === 'gunner_a' || rl === 'loader_f' || rl === 'loader_a' || rl === 'deckhand' ? 1.0 : rl === 'stoker' ? 0.3 : 0), used, catchSp.pos, 1)[0];
  const catcher = party.length && catcherP ? catcherP.i : -1;
  if (catcher >= 0) { used.add(catcher); E.job(catcher, 0, 0, 'catcher', catcherP.s); }
  // ---- the rope ladder drops
  const tLadder = 3.5;
  // ---- the shore party goes over the side
  const P = party.map((p) => p.i);
  const landAt: number[] = [];
  let ladderFree = tLadder + 1.3;
  // SPEC D13: two jump from the rail, the third goes down the rope ladder (all of them when the drop is too high). Who
  // takes which rail point / the ladder: the assignment that gets the last of them to the X soonest (pure: nav
  // distances only; ties keep the party order)
  const nJump = drop <= jumpMax && jumps.length ? (P.length >= 3 ? P.length - 1 : P.length) : 0;
  // (a dash sprints on the sand: the run clip keeps its stride, the cadence rises)
  const sandRun = CREW_SPEED.run * (v.sprint ?? 1);
  const reach = (i: number, j: DeckSpot | null, k: number) => {
    const p = E.tbs[i].p;
    if (!j) return Math.max(tLadder + 1.3, navDist(deck, p, ladderTop) / CREW_SPEED.run) + 3 + ladderBase.distanceTo(loot) / sandRun;
    return Math.max(4.3 + 0.7 * k, navDist(deck, p, j.pos) / CREW_SPEED.run) + 2.5 + landOf(j, k).land.distanceTo(loot) / sandRun;
  };
  const perms = (a: number[]): number[][] => (a.length <= 1 ? [a] : a.flatMap((x, k) => perms([...a.slice(0, k), ...a.slice(k + 1)]).map((q) => [x, ...q])));
  let slots: { i: number; j: DeckSpot | null }[] = [];
  let bestCost = Infinity;
  for (const order of perms(P)) {
    const free = jumps.slice(), sl: { i: number; j: DeckSpot | null }[] = [];
    let cost = 0;
    order.forEach((i, k) => {
      let j: DeckSpot | null = null;
      if (k < nJump) {
        let bj = -1, bt = Infinity;
        free.forEach((c, ci) => { const t = reach(i, c, k); if (t < bt - 1e-9) { bt = t; bj = ci; } });
        j = bj >= 0 ? free.splice(bj, 1)[0] : jumps[k % jumps.length];
      }
      sl.push({ i, j });
      cost = Math.max(cost, reach(i, j, k));
    });
    if (cost < bestCost - 1e-6) { bestCost = cost; slots = sl; }
  }
  slots.forEach(({ i, j }, k) => {
    const tb = E.tbs[i];
    if (tb.frame) E.leaveGun(i);
    if (j) {
      E.goDeck(i, j.pos, CREW_SPEED.run, 'run');
      tb.face(j.yaw, 'idle_b', 0.3);
      tb.until(4.8 + 0.7 * k - 0.5, 'idle_b');
      if (k === 0) E.bubble(i, tb.t - 0.2, lineFor(cfg, 'shore', s.id), 1.8, true);
      tb.once('jump_off');
      const { rail, land } = landOf(j, k);
      tb.fly(rail, 0.3, 0.25, 'jump_off', { off: clipEvent('jump_off', 'leave', 0.32) });
      const T = Math.sqrt((2 * Math.max(0.5, rail.y - ground)) / 9.81) * 1.08;
      tb.fly(land, qt(T), 1.2, 'fall');
      ep.fx.push({ t: qt(tb.t), kind: 'dust', pos: land.clone(), size: 1.2 });
      tb.once('land');
    } else {
      E.goDeck(i, ladderTop, CREW_SPEED.run, 'run');
      tb.face(ladder.yaw + Math.PI, 'idle_b', 0.3);
      tb.until(Math.max(ladderFree, tb.t), 'idle_b');
      tb.fly(railTop, 0.45, Math.max(0.2, Math.max(railTop.y, lr ? lr.y : railTop.y) + 0.1 - (tb.p.y + railTop.y) / 2), 'jump_off');
      tb.ladder(ladderBase.clone().addScaledVector(out, -0.12));
      ladderFree = tb.t - 1.2;
      ep.fx.push({ t: qt(tb.t), kind: 'sand', pos: tb.p.clone(), size: 0.6 });
      tb.go([tb.p.clone().addScaledVector(out, 0.9)], CREW_SPEED.walk, 'walk');
    }
    landAt[k] = tb.t;
  });
  // ---- run to the X, dig (the loot rises), haul it back
  const items: ItemTrack[] = [];
  const toLoot = (i: number, k: number) => {
    const tb = E.tbs[i];
    const ang = (k / Math.max(1, P.length)) * Math.PI * 2 + 0.6;
    const dest = loot.clone().add(V(Math.sin(ang) * 0.75, 0, Math.cos(ang) * 0.75));
    tb.go(shorePath(tb.p, dest, feet).slice(1), sandRun, 'run');
    tb.face(yawTo(tb.p, loot), 'idle_b', 0.3);
  };
  P.forEach((i, k) => toLoot(i, k));
  // (the first two at the X carry the big chest: the pair's slow walk back is the long pole; the last one takes the bag)
  const arrived = new Map(P.map((i) => [i, E.tbs[i].t] as [number, number]));
  const PA = P.slice().sort((a, b2) => arrived.get(a)! - arrived.get(b2)! || a - b2);
  const hookers = new Set<number>();
  let digEnd = 0;
  if (P.length) {
    // (the first one there starts digging; the rest join as they come)
    const digger = P.slice().sort((a, b2) => E.tbs[a].t - E.tbs[b2].t || a - b2)[0];
    const tb = E.tbs[digger];
    const d0 = tb.t;
    tb.hold(v.dig, 'dig');
    digEnd = tb.t;
    for (let t = d0 + 0.5; t < digEnd; t += clipDur('dig', 1.6)) ep.fx.push({ t: qt(t), kind: 'sand', pos: loot.clone(), size: 0.5 });
    for (const i of P) if (i !== digger) E.tbs[i].until(digEnd, 'idle_b');
  }
  // what comes back
  const aboard: number[] = [];
  const hoists: { item: ItemTrack; ready: number }[] = [];
  let carriersFree = digEnd;
  const haulList = v.haul.slice();
  let pi = 0;
  const shoreToBase = (i: number, speed: number, clip: string, held?: string, lane = 0) => {
    const tb = E.tbs[i];
    const dest = hoistBase.clone().addScaledVector(out, 0.9).add(V(lane * fwdOf(ladder.yaw + Math.PI / 2).x, 0, lane * fwdOf(ladder.yaw + Math.PI / 2).z));
    tb.go(shorePath(tb.p, dest, feet).slice(1), speed, clip, held !== undefined ? { held } : {});
  };
  for (const h of haulList) {
    if (h === 'bigchest' && pi + 1 < PA.length) {
      const a = PA[pi], b2 = PA[pi + 1]; pi += 2;
      hookers.add(a); hookers.add(b2);
      const item: ItemTrack = { id: `${s.id}:big`, kind: 'bigchest', segs: [{ t0: 0, t1: qt(digEnd - v.dig), mode: 'hidden' }, { t0: qt(digEnd - v.dig), t1: qt(digEnd), mode: 'rise', a: loot.clone().add(V(0, -0.55, 0)), b: loot.clone(), yaw: yawTo(loot, hoistBase) + Math.PI / 2 }] };
      // the pair takes position on either side of the chest, lift, carry it between them
      const across = fwdOf(yawTo(loot, hoistBase) + Math.PI / 2);
      const ta = E.tbs[a], tb2 = E.tbs[b2];
      ta.go([loot.clone().addScaledVector(across, 0.55)], CREW_SPEED.walk, 'walk'); tb2.go([loot.clone().addScaledVector(across, -0.55)], CREW_SPEED.walk, 'walk');
      const t0 = Math.max(ta.t, tb2.t);
      ta.face(yawTo(ta.p, loot), 'idle', 0.3); tb2.face(yawTo(tb2.p, loot), 'idle', 0.3);
      ta.until(t0 + 0.3, 'carry_pair'); tb2.until(t0 + 0.3, 'carry_pair');
      item.segs.push({ t0: qt(digEnd), t1: qt(t0 + 0.3), mode: 'at', a: loot.clone(), yaw: yawTo(loot, hoistBase) + Math.PI / 2 });
      // both walk the same centre path, offset sideways, same duration
      // (the pair walks 0.55 m either side of this line: it keeps that much more clear of the feet)
      const centre = shorePath(loot, hoistBase.clone().addScaledVector(out, 1.4), feet, 1.8);
      const plen = centre.reduce((acc, p, k) => acc + (k ? p.distanceTo(centre[k - 1]) : 0), 0);
      const dur = plen / CREW_SPEED.carryPair;
      const off = (pts: V3[], o: number) => pts.map((p, k) => { const q = pts[Math.min(pts.length - 1, k + 1)], pp = pts[Math.max(0, k - 1)]; const d = V(q.x - pp.x, 0, q.z - pp.z).normalize(); return p.clone().add(V(-d.z * o, 0, d.x * o)); });
      const c0 = Math.max(ta.t, tb2.t);
      ta.until(c0, 'carry_pair'); tb2.until(c0, 'carry_pair');
      ta.go(off(centre, -0.55).slice(1), plen / dur, 'carry_pair'); tb2.go(off(centre, 0.55).slice(1), plen / dur, 'carry_pair');
      const c1 = Math.max(ta.t, tb2.t);
      item.segs.push({ t0: qt(c0), t1: qt(c1), mode: 'between', crew: [a, b2] });
      ta.until(c1, 'carry_pair'); tb2.until(c1, 'carry_pair');
      const setDown = hoistBase.clone().addScaledVector(out, 1.0);
      hoists.push({ item, ready: c1 + 0.4 });
      item.segs.push({ t0: qt(c1), t1: qt(c1 + 0.4), mode: 'line', a: setDown.clone().add(V(0, 0.3, 0)), b: setDown.clone() });
      ta.once('lift', { held: undefined, loop: false, rate: -1, off: clipDur('lift') }); tb2.once('lift', { held: undefined, loop: false, rate: -1, off: clipDur('lift') });
      carriersFree = Math.max(carriersFree, ta.t, tb2.t);
    } else if ((h === 'chest' || h === 'bigchest') && pi < PA.length) {
      const a = PA[pi++];
      hookers.add(a);
      const item: ItemTrack = { id: `${s.id}:chest${pi}`, kind: 'chest', segs: [{ t0: 0, t1: qt(digEnd - v.dig), mode: 'hidden' }, { t0: qt(digEnd - v.dig), t1: qt(digEnd), mode: 'rise', a: loot.clone().add(V(0, -0.4, 0)), b: loot.clone(), yaw: 0 }] };
      const ta = E.tbs[a];
      ta.go([loot.clone().addScaledVector(fwdOf(yawTo(loot, hoistBase)), -0.45)], CREW_SPEED.walk, 'walk');
      ta.face(yawTo(ta.p, loot), 'idle', 0.25);
      item.segs.push({ t0: qt(digEnd), t1: qt(ta.t + clipEvent('lift', 'grab', 0.35)), mode: 'at', a: loot.clone(), yaw: 0 });
      ta.once('lift', { held: 'chest' });
      item.segs.push({ t0: qt(ta.t - clipDur('lift') + clipEvent('lift', 'grab', 0.35)), t1: qt(ta.t), mode: 'hidden' });
      shoreToBase(a, CREW_SPEED.carry, 'carry', 'chest', 0.6);
      const setDown = ta.p.clone().addScaledVector(fwdOf(ta.yaw), 0.35);
      ta.once('lift', { held: 'chest', rate: -1, off: clipDur('lift') });
      const tDown = ta.t;
      item.segs.push({ t0: qt(tDown - clipDur('lift')), t1: qt(tDown), mode: 'hidden' });
      hoists.push({ item, ready: tDown });
      item.segs.push({ t0: qt(tDown), t1: qt(tDown + 0.01), mode: 'at', a: V(setDown.x, ground, setDown.z), yaw: ta.yaw });
      carriersFree = Math.max(carriersFree, ta.t);
    } else if (h === 'bag' && pi < PA.length) {
      const a = PA[pi++];
      const ta = E.tbs[a];
      ta.go([loot.clone().addScaledVector(fwdOf(yawTo(loot, hoistBase)), -0.4)], CREW_SPEED.walk, 'walk');
      ta.face(yawTo(ta.p, loot), 'idle', 0.25);
      ta.hold(0.9, 'ual_interact', { held: 'coinbag' });
      ta.held = 'coinbag';
      const dest = ladderBase.clone().addScaledVector(out, 1.1);
      ta.go(shorePath(ta.p, dest, feet).slice(1), sandRun, 'run', { held: 'coinbag' });
      ta.face(ladder.yaw + Math.PI, 'idle', 0.3, { held: 'coinbag' });
      ta.held = undefined;
      const item: ItemTrack = { id: `${s.id}:bag`, kind: 'coinbag', segs: [{ t0: 0, t1: 0.01, mode: 'hidden' }] };
      items.push(item);
      // the catcher must be at the rail; the throw waits for him
      const tThrow = Math.max(ta.t, 0);
      ta.until(tThrow, 'idle', { held: 'coinbag' });
      const relT = clipEvent('throw_up', 'release', 0.5);
      const rel = ta.t + relT;
      ta.hold(relT, 'throw_up', { held: 'coinbag', loop: false });
      ta.hold(clipDur('throw_up') - relT, 'throw_up', { held: '', loop: false, off: relT });
      const from = ta.p.clone().add(V(0, 0.85, 0)).addScaledVector(fwdOf(ta.yaw), 0.15);
      const catchTo = catchSp.pos.clone().add(V(0, 0.85, 0)).addScaledVector(fwdOf(catchSp.yaw), 0.1);
      const flight = 1.15;
      item.segs.push({ t0: qt(rel), t1: qt(rel + flight), mode: 'arc', a: from, b: catchTo, h: 1.6 });
      item.segs.push({ t0: qt(rel + flight), t1: qt(rel + flight + 0.01), mode: 'hidden' });
      (item as ItemTrack & { catchAt?: number }).catchAt = rel + flight;
      carriersFree = Math.max(carriersFree, ta.t);
    }
  }
  items.push(...hoists.map((h) => h.item));
  // ---- the catcher: to the rail, catch thrown bags, haul hoisted chests
  let catcherT = 0;
  if (catcher >= 0) {
    const tb = E.tbs[catcher];
    if (tb.frame) E.leaveGun(catcher);
    E.goDeck(catcher, catchSp.pos, CREW_SPEED.run, 'run');
    tb.face(catchSp.yaw, 'idle_b', 0.3);
    tb.until(tLadder - 0.4, 'idle_b');
    tb.hold(0.8, 'ual_interact');               // (lets the rope ladder go)
    catcherT = tb.t;
    const bag = items.find((it) => it.kind === 'coinbag') as (ItemTrack & { catchAt?: number }) | undefined;
    if (bag?.catchAt !== undefined) {
      const tc = bag.catchAt - clipEvent('catch', 'catch', 0.35);
      tb.until(Math.max(tb.t, tc), 'idle_b');
      tb.once('catch');
      E.bubble(catcher, bag.catchAt, lineFor(cfg, 'catch', s.id), 1.8, true);
      ep.fx.push({ t: qt(bag.catchAt), kind: 'coins', pos: catchSp.pos.clone().add(V(0, 0.8, 0)), size: 0.6 });
      tb.hold(1.0, 'cheer');
    }
    for (const h of hoists) {
      const it = h.item;
      // drop the hoist rope, the shore crew hooks it on (1.8 s), haul it up hand over hand (1 m/s), swing it inboard
      const t0 = Math.max(tb.t, h.ready - 1.0);
      tb.until(t0, 'idle_b');
      const ropeT0 = t0;
      tb.hold(0.8, 'ual_interact');
      const hookDone = Math.max(tb.t, h.ready) + 1.8;
      tb.until(hookDone, 'idle_b');
      const up = hoistTop.y - ground;
      const T = Math.max(3, up / 1.0);
      const last = it.segs[it.segs.length - 1];
      const startPos = (last.a ?? hoistBase).clone();
      last.t1 = qt(hookDone);
      if (last.mode === 'line') { it.segs.push({ t0: qt(last.t1), t1: qt(hookDone), mode: 'at', a: last.b!.clone(), yaw: 0 }); }
      tb.hold(T, 'haul');
      it.segs.push({ t0: qt(hookDone), t1: qt(hookDone + T), mode: 'line', a: (last.b ?? startPos).clone(), b: hoistTop.clone() });
      const deckDrop = catchSp.pos.clone().addScaledVector(fwdOf(catchSp.yaw), -0.6);
      it.segs.push({ t0: qt(hookDone + T), t1: qt(hookDone + T + 0.7), mode: 'arc', a: hoistTop.clone(), b: deckDrop, h: 0.3 });
      it.segs.push({ t0: qt(hookDone + T + 0.7), t1: qt(hookDone + T + 3.2), mode: 'at', a: deckDrop, yaw: catchSp.yaw });
      it.segs.push({ t0: qt(hookDone + T + 3.2), t1: qt(hookDone + T + 3.21), mode: 'hidden' });
      ep.fx.push({ t: qt(hookDone + T + 3.2), kind: 'coins', pos: deckDrop.clone().add(V(0, 0.4, 0)), size: 1.0 });
      // (the rope runs from the davit at the rail down to where the load was set down: the load rides up along it)
      ep.ropes.push({ kind: 'hoist', t0: qt(ropeT0 + 0.3), t1: qt(hookDone + T + 0.7), top: hoistTop.clone(), bottom: (last.b ?? startPos).clone().add(V(0, 0.3, 0)), unroll: 0.9 });
      E.bubble(catcher, hookDone + T + 0.8, lineFor(cfg, 'catch', s.id, 'h'), 2.0, true);
      tb.face(catchSp.yaw + Math.PI, 'cheer', 0.3);
      tb.hold(1.6, 'cheer');
      h.ready = hookDone;            // the shore crew may climb once the load is hooked on
    }
    catcherT = tb.t;
  }
  // ---- everyone climbs back up the rope ladder, one after another: each waits on their own spot near the foot (never
  // on top of each other) and starts once the one above is a third of the way up (~2 m clear: never two at the same
  // rungs). In order of arrival at the foot: one with nothing to carry runs back from the X and climbs at once; those
  // who hooked a load on wait for that
  const backAt = (i: number) => { const tb = E.tbs[i], L = tb.p.distanceTo(ladderBase); return tb.t + L / (L > 4 ? sandRun : CREW_SPEED.walk); };
  const climbOrder = P.slice().sort((a, b2) => backAt(a) - backAt(b2) || a - b2);
  let nextOn = tLadder + 1.4;
  const hookedBy = hoists.length ? Math.max(...hoists.map((h) => h.ready)) : 0;
  const sideV = fwdOf(ladder.yaw + Math.PI / 2);
  const climbTo = V(railTop.x, railTop.y - 0.25, railTop.z).addScaledVector(out, 0.12);
  const climbH = Math.max(0.5, climbTo.y - ground);
  // (the hop from the ladder top back aboard clears the rail / bulwark cap)
  const railY = Math.max(railTop.y, lr ? lr.y : railTop.y);
  climbOrder.forEach((i, q) => {
    const tb = E.tbs[i];
    const wait = ladderBase.clone().addScaledVector(out, 0.55 + 0.45 * q).addScaledVector(sideV, q ? (q % 2 ? 0.6 : -0.6) : 0);
    const far = tb.p.distanceTo(wait) > 4;
    tb.go(shorePath(tb.p, wait, feet).slice(1), far ? sandRun : CREW_SPEED.walk, far ? 'run' : 'walk');
    tb.face(ladder.yaw + Math.PI, 'idle_b', 0.3);
    tb.until(Math.max(nextOn, hookers.has(i) ? hookedBy : 0), 'idle_b');
    tb.go([ladderBase.clone().addScaledVector(out, 0.12)], CREW_SPEED.walk, 'walk');
    tb.yaw = ladder.yaw + Math.PI;
    const c0 = tb.t;
    tb.ladder(climbTo);
    nextOn = c0 + (tb.t - c0) / 3;
    const land = ladderTop.clone().addScaledVector(out, -0.6);
    tb.fly(land, 0.5, Math.max(0.35, railY + 0.1 - (tb.p.y + land.y) / 2), 'jump_off', { off: 0.3 });
    tb.once('land');
    aboard.push(tb.t);
    if (v.cheer) tb.hold(1.6, 'jump_cheer');
  });
  const allAboard = aboard.length ? Math.max(...aboard) : Math.max(4, catcherT);
  ep.allAboard = qt(allAboard);
  if (P.length) E.bubble(climbOrder[climbOrder.length - 1], allAboard - 0.2, lineFor(cfg, 'aboard', s.id), 2.4, true);
  if (P.length) ep.ropes.push({ kind: 'ladder', t0: tLadder, t1: qt(allAboard + 1.5), top: railTop.clone(), bottom: ladderBase.clone(), unroll: 1.2, ...(gw ? { ship: true } : {}) });
  ep.items = items;
  // ---- the rest: line the rail and cheer the loot in (the Cap'n waves from the helm)
  const railSpots = [...deck.spots.values()].filter((sp) => /^RAIL_/.test(sp.name));
  for (let i = 0; i < n; i++) {
    if (used.has(i) && i !== cap) continue;
    const tb = E.tbs[i];
    if (roles[i] === 'stoker') { tb.until(allAboard, 'shovel_scoop', { rate: 0.6 }); continue; }
    if (i === cap) {
      const helm = deck.spots.get('CREW_HELM');
      if (helm && tb.p.distanceTo(helm.pos) > 0.3) { E.goDeck(i, helm.pos, CREW_SPEED.walk, 'walk'); tb.face(helm.yaw, 'helm_hold', 0.3, { dyn: 'helm' }); }
      tb.until(Math.max(tb.t, allAboard - 1), 'helm_hold', { dyn: 'helm' });
      tb.hold(3, 'wave');
      continue;
    }
    if (tb.frame) E.leaveGun(i);
    const near = railSpots.length ? railSpots.slice().sort((a, b2) => a.pos.distanceTo(ladderTop) - b2.pos.distanceTo(ladderTop))[i % Math.min(2, railSpots.length)] : null;
    const spot = near && near.pos.distanceTo(ladderTop) < 12 ? near.pos.clone() : ladderTop.clone().addScaledVector(out, -1.2).add(V((i % 3 - 1) * 0.8, 0, (i % 2) * 0.9));
    E.goDeck(i, spot, CREW_SPEED.walk, 'walk');
    tb.face(yawTo(tb.p, loot), 'idle_b', 0.4);
    const firstLoot = Math.min(allAboard, ...ep.fx.filter((f) => f.kind === 'coins').map((f) => f.t));
    tb.until(Math.max(tb.t, firstLoot), 'idle_b');
    tb.hold(2.2, 'cheer');
    tb.until(allAboard, 'idle_b');
  }
  if (look >= 0) { const tb = E.tbs[look]; tb.until(allAboard, 'spyglass_look'); tb.hold(2.5, 'jump_cheer'); }
  ep.phases.push([allAboard, 'DEPART']);
  for (let i = 0; i < n; i++) ep.resume[i] = qt(E.homeAndResume(i, allAboard + 1));
  return E.finish();
}

// ================================================================================================ the whole schedule
/** Plan every episode in order: each starts from where everyone is at its start (an earlier episode still running
 *  is cut there). `inputs` sorted or not; ids must be unique. */
export function planEpisodes(ctx: PlanCtx, cruise: CruiseLoop[], inputs: CrewEpisodeIn[], cache?: Map<string, CrewEpisode>): CrewEpisode[] {
  const sorted = inputs.slice().sort((a, b) => startOf(a) - startOf(b) || (a.id < b.id ? -1 : 1));
  const out: CrewEpisode[] = [];
  // (the cache key chains every earlier episode's CONTENT: a hit / shot / end / outcome added to a running battle, or
  // a changed stop window, re-plans it and everything after it; an unchanged prefix is reused)
  let chainKey = '';
  const cut = (start: number) => {
    for (const prev of out) for (let i = 0; i < prev.resume.length; i++) {
      const local = (start - prev.start) / 1000;
      if (prev.resume[i] > local && local >= 0) prev.resume[i] = qt(local);
    }
  };
  for (const e of sorted) {
    chainKey = hash32(chainKey, episodeSig(e), ctx.seed).toString(36);
    const key = `${e.id}|${chainKey}`;
    let ep = cache?.get(key);
    const start = startOf(e);
    if (!ep) {
      // where everyone is at this start (an earlier episode still running counts), THEN cut that one short
      const init = cruise.map((_, i) => stateAt(ctx, cruise, out, i, start));
      cut(start);
      ep = e.k === 'battle' ? planBattle(ctx, cruise, e, init) : planTreasure(ctx, cruise, e, init);
      if (cache) { cache.set(key, ep); if (cache.size > 48) cache.delete(cache.keys().next().value!); }
    } else cut(start);
    ep.resume = ep.resume0.slice();
    out.push(ep);
  }
  return out;
}
export const startOf = (e: CrewEpisodeIn) => (e.k === 'battle' ? e.alert : e.at);

/** Everything a plan depends on in an episode input (1 ms / 1 mm): two inputs with the same signature plan the same. */
export function episodeSig(e: CrewEpisodeIn): string {
  const r = (x: number) => Math.round(x);
  const m = (x: number) => Math.round(x * 1000);
  if (e.k === 'battle') {
    return ['b', e.id, r(e.alert), r(e.end), e.outcome, m(e.bearing), e.synth === false ? 'n' : '',
      e.shots.map((s) => `${s.gun}${r(s.at)}`).join(','),
      e.hits.map((h) => `${h.id ?? ''}@${r(h.at)}:${h.pos.map(m).join('/')}:${h.severity}`).join(',')].join('|');
  }
  return ['t', e.id, r(e.at), e.until !== undefined ? r(e.until) : '', e.side ?? '', e.loot ? e.loot.map(m).join('/') : '',
    e.groundY !== undefined ? m(e.groundY) : '', (e.haul ?? []).join(','), e.feet ? e.feet.map((f) => f.map(m).join('/')).join(',') : ''].join('|');
}
/** The re-plan key of a whole input list (crewScene re-plans when it changes). */
export const inputsKey = (inputs: CrewEpisodeIn[]) => hash32(...inputs.map(episodeSig)).toString(36) + ':' + inputs.length;

/** Repair progress 0..1 of a hull hit at wall ms (for the voyage's damage decals / fires). */
export function repairProgress(eps: CrewEpisode[], hitId: string, ms: number): number {
  for (const e of eps) {
    const r = e.repairs.find((x) => x.hit === hitId);
    if (!r) continue;
    const t = (ms - e.start) / 1000;
    return Math.max(0, Math.min(1, (t - r.t0) / Math.max(0.1, r.t1 - r.t0)));
  }
  return 0;
}

/** A stable hash of everyone's sampled state (tests: two pages at the same instant must agree). */
export function stateHash(ctx: PlanCtx, cruise: CruiseLoop[], eps: CrewEpisode[], ms: number): number {
  let h = 0;
  for (let i = 0; i < cruise.length; i++) {
    const s = stateAt(ctx, cruise, eps, i, ms);
    h = hash32(h, i, s.pos.x.toFixed(2), s.pos.y.toFixed(2), s.pos.z.toFixed(2), s.yaw.toFixed(2), s.clip, s.held ?? '');
  }
  return h;
}
