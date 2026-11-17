// Deterministic background-combat simulation. planSkirmish() turns (room data, seed, factions, intensity) into a
// COMPLETE episode timeline — every NPC's position / facing / animation state per 0.1 s tick, every shot, death,
// loot pick-up, grenade and body drag — before anything is shown. Pages (studio preview, OBS, party guests) only
// SAMPLE that timeline at the shared clock, so they all show the same fight and a page that loads late simply
// samples the middle of it. Pure: integer-seeded RNG, fixed tick, no clocks, no scene graph, no camera.
//
// The fight: two squads enter off-screen (BG_SPAWN_xx), run to cover (BG_COVER_xx facing the threat), then cycle
// hide → expose (peek / rise) → burst → hide, reload when dry, sometimes reposition or throw a grenade; hits flinch,
// enough hits kill (death direction from the shooter). A stalemate slowly raises accuracy so someone always dies.
// Winners loot bodies (kneel + rummage, pick up the weapon) and BG_LOOT_xx spots, drag a body by the vest to the
// nearest BG_EXIT_xx where both are "garbage collected", then leave. Leftover bodies fade at the end.
import { RAID_PACING, type RaidFaction, type RaidIntensity } from '../../../shared/raid.ts';
import { Rng } from './rng.ts';
import type { P3, PatrolPause, SimRoom } from './raidRoom.ts';

export const TICK = 0.1;
/** Floats per actor per tick: x, y, z, yaw, state, since (ticks in state), aimPitch, dist (m walked), aux, alpha. */
export const NF = 10;

export const S = {
  HIDDEN: 0, IDLE: 1, WALK: 2, RUN: 3, CROUCH_IDLE: 4, CROUCH_WALK: 5, AIM: 6, AIM_CROUCH: 7, PEEK_L: 8, PEEK_R: 9,
  RELOAD: 10, HIT: 11, DEATH_BACK: 12, DEATH_FWD: 13, DEATH_SPIN: 14, DEAD: 15, LOOT: 16, DRAG: 17, DRAGGED: 18,
  THROW: 19, T_IDLE: 20, T_SPRINT: 21, T_SMASH: 22, T_TAUNT: 23, T_WALK: 24, GC: 25, SCAN: 26, WARM: 27,
} as const;
export const CLIP_OF: Record<number, string> = {
  1: 'idle', 2: 'walk', 3: 'run', 4: 'crouch_idle', 5: 'crouch_walk', 6: 'aim', 7: 'aim_crouch', 8: 'peek_L', 9: 'peek_R',
  10: 'reload', 11: 'hit', 12: 'death_back', 13: 'death_fwd', 14: 'death_spin', 16: 'loot', 17: 'drag', 18: 'dragged',
  19: 'throw', 20: 't_idle', 21: 't_sprint', 22: 't_smash', 23: 't_taunt', 24: 't_walk', 26: 'scan', 27: 'warm',
};
const DEATH_TICKS: Record<number, number> = { 12: 13, 13: 15, 14: 12 };
/** Where the chest of a lying body is, relative to its root (model metres; local x, local z with +z = forward). */
export const CHEST_OF: Record<number, [number, number]> = { 12: [0, -0.84], 13: [0.01, 0.68], 14: [-0.6, -0.66] };   // (v4 skeleton, measured by build_anims.py)

export const UNITS: Record<string, string[]> = {
  usec: ['usec_a', 'usec_b', 'usec_c'], bear: ['bear_a', 'bear_b', 'bear_c'], scav: ['scav_a', 'scav_b', 'scav_c', 'scav_d'],
  raider: ['raider_a', 'raider_b'], boss: ['tagilla'], reshala: ['reshala'], guard: ['guard_a', 'guard_b', 'guard_c', 'guard_d'],
  // the warzone pack (assets/raid/packs/warzone): heroic frog soldiers vs a generic masked militia. Riflemen twice in the
  // list = picked twice as often; the RPG gunner shoots rockets (the page draws them, see raidScene registerWeaponFx).
  frog: ['frog_rifle', 'frog_rifle', 'frog_cqb', 'frog_mg', 'frog_officer'], militia: ['militia_rifle', 'militia_rifle', 'militia_wrap', 'militia_mg', 'militia_rpg'],
};
export const LOADOUT: Record<string, string> = {
  usec_a: 'm4', usec_b: 'm4_tan', usec_c: 'm4', bear_a: 'ak_poly', bear_b: 'ak', bear_c: 'ak_poly', scav_a: 'ak', scav_b: 'shotgun',
  scav_c: 'sks', scav_d: 'ak', raider_a: 'm4', raider_b: 'ak_poly', tagilla: 'sledge',
  reshala: 'tt_gold', guard_a: 'ak_poly', guard_b: 'svd', guard_c: 'saiga', guard_d: 'pkm',
  frog_rifle: 'm4_tan', frog_mg: 'saw', frog_cqb: 'm4', frog_nvg: 'm4_tan', frog_sniper: 'barrett', frog_officer: 'm4_tan',
  militia_rifle: 'ak', militia_wrap: 'ak_poly', militia_mg: 'pkm', militia_rpg: 'rpg',
};
const ALT_WEAPON: Record<RaidFaction, string[]> = { usec: ['m4', 'm4_tan'], bear: ['ak', 'ak_poly'], scav: ['ak', 'sks', 'shotgun'], raider: ['m4', 'ak_poly'], frog: ['m4', 'm4_tan'], militia: ['ak', 'ak_poly'] };
/** Units whose weapon never swaps (the loadout is the character). */
const FIXED_WEAPON = new Set(['frog_mg', 'frog_sniper', 'militia_mg', 'militia_rpg'])
interface Gun { rate: number; burst: [number, number]; mag: number; dmg: [number, number]; range: number }
const GUNS: Record<string, Gun> = {
  m4: { rate: 0.09, burst: [3, 7], mag: 30, dmg: [26, 38], range: 45 }, m4_tan: { rate: 0.09, burst: [3, 7], mag: 30, dmg: [26, 38], range: 45 },
  ak: { rate: 0.1, burst: [3, 6], mag: 30, dmg: [28, 42], range: 40 }, ak_poly: { rate: 0.1, burst: [3, 6], mag: 30, dmg: [28, 42], range: 40 },
  sks: { rate: 0.32, burst: [2, 4], mag: 10, dmg: [42, 58], range: 45 }, shotgun: { rate: 0.85, burst: [1, 2], mag: 6, dmg: [55, 80], range: 18 },
  sledge: { rate: 1, burst: [1, 1], mag: 1, dmg: [0, 0], range: 1 },
  tt_gold: { rate: 0.28, burst: [2, 4], mag: 8, dmg: [30, 45], range: 30 }, svd: { rate: 0.5, burst: [1, 3], mag: 10, dmg: [55, 75], range: 60 },
  saiga: { rate: 0.3, burst: [2, 4], mag: 8, dmg: [50, 70], range: 22 }, pkm: { rate: 0.075, burst: [6, 12], mag: 100, dmg: [30, 42], range: 55 },
  saw: { rate: 0.075, burst: [6, 12], mag: 100, dmg: [26, 36], range: 50 }, barrett: { rate: 1.4, burst: [1, 2], mag: 10, dmg: [95, 120], range: 90 },
  // one rocket, then a reload (the launcher is re-loaded from the pack)
  rpg: { rate: 3, burst: [1, 1], mag: 1, dmg: [60, 110], range: 60 },
};
const SKILL: Record<string, number> = { usec: 1, bear: 1, scav: 0.72, raider: 1.15, boss: 1.2, reshala: 1.3, guard: 1.35, frog: 1.6, militia: 0.66 };
/** Pistol wielders use the p_* clip set (the rifle states map onto it). */
export const PISTOL_CLIP: Record<string, string> = { idle: 'p_idle', walk: 'p_walk', run: 'p_run', aim: 'p_aim', peek_L: 'p_aim', peek_R: 'p_aim', aim_crouch: 'p_aim_crouch', crouch_idle: 'p_crouch', crouch_walk: 'p_walk', reload: 'p_crouch', throw: 'p_idle', scan: 'p_scan', warm: 'p_warm' };
export const PISTOLS = new Set(['tt_gold']);

export interface SimActor {
  id: number; team: number; faction: string; unit: string; weapon: string;
  /** NF floats per tick. */
  data: Float32Array;
}
export interface SimShot { tick: number; frac: number; from: number; to: number; hit: boolean; kind: 'body' | 'cover' | 'miss'; seed: number }
export interface SimNote {
  tick: number; frac?: number;
  kind: 'spawn' | 'death' | 'pickup' | 'loot' | 'grab' | 'gc' | 'throw' | 'boom' | 'smash' | 'flee' | 'kick' | 'gone';
  a: number; b?: number; p?: P3; q?: P3; n?: number;
}
export interface Episode {
  kind: string; seed: number; ticks: number; actors: SimActor[]; shots: SimShot[]; notes: SimNote[];
  teams: string[]; stats: { planMs: number; deaths: number; shots: number; dragged: number; looted: number };
  /** Tagilla: the smashed prop index + the supporter shown on his sign. */
  prop?: number; sign?: { user: string; amount: string } | null;
}

type Task = { k: 'lootBody'; b: Act } | { k: 'lootSpot'; l: number } | { k: 'drag'; b: Act; to?: P3 } | { k: 'watch'; n: number } | { k: 'exit' } | { k: 'fleeExit' }
  | { k: 'route' } | { k: 'dragRoute'; b: Act } | { k: 'rejoin' };

interface Act {
  id: number; team: number; fac: string; unit: string; weapon: string; gun: Gun;
  x: number; y: number; z: number; yaw: number; hp: number; alive: boolean; spawnAt: number; born: boolean; gone: boolean;
  state: number; stSince: number; aimPitch: number; dist: number; aux: number; alpha: number;
  mode: 'wait' | 'move' | 'cover' | 'task' | 'dead' | 'gone' | 'patrol' | 'fading';
  pauseUntil: number; pauseIdx: number; bornT: number; fadeStart: number;
  path: P3[]; pi: number; speed: number; moveState: number; back: boolean; arrive: (() => void) | null;
  cover: number; target: Act | null; phase: 'hide' | 'expose' | 'burst' | 'post'; timer: number; ammo: number; burst: number; nextShot: number;
  busy: number; lastExposed: number; noTargetFor: number;
  tasks: Task[]; task: Task | null; dragging: Act | null; draggedBy: Act | null; looted: boolean; claimed: boolean; deathVar: number; fled: boolean;
  data: Float32Array; sta: number; navHint: number;
  /** Boss squad: slot in the formation; ambusher: lying in wait (holds fire until the squad walks into it). */
  fm: number; lurk: boolean;
}

const angTo = (from: number, to: number) => { let d = to - from; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
const d2 = (ax: number, az: number, bx: number, bz: number) => Math.hypot(ax - bx, az - bz);

/** A boss squad walking an authored route (PATROL_PATH_xx) with look-around pauses (PATROL_PAUSE_xx); with `ambush`,
 *  PMCs jump them part-way (and lose), then a guard drags a body along the rest of the route. */
export interface PatrolOpts {
  path: P3[]; pauses: PatrolPause[]; ambush: boolean; ambushFactions: RaidFaction[]; squad?: string[];
  /** Per route point: the formation on the segment that starts there + the free width (PATROL_PATH_xx extras). */
  form?: { f: 'file' | 'column' | 'wedge'; w: number }[];
  /** Walking speed (m/s, scene.json raid.patrol.walkSpeed); walk the route backwards half the time when reversible. */
  speed?: number; reversible?: boolean;
}
export interface SkirmishOpts { factions: RaidFaction[]; intensity: RaidIntensity; seed: number; maxSecs: number; kind?: string; patrol?: PatrolOpts }

// ================================================================================================ skirmish
export function planSkirmish(room: SimRoom, o: SkirmishOpts): Episode | null {
  const g = planSkirmishSteps(room, o);
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}

/** The planner as resumable steps (yields every 16 ticks) so a page can spread it over frames (~1 ms each). */
export function* planSkirmishSteps(room: SimRoom, o: SkirmishOpts): Generator<void, Episode | null, void> {
  let planMs = 0;
  let t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  if (!room.los || room.nav < 2 || !room.spawns.length || !room.exits.length) return null;
  const rng = new Rng(o.seed);
  const s = room.scale;
  const maxT = Math.max(200, Math.floor(o.maxSecs / TICK));
  const pts = room.pts;
  const N = pts.length;
  const los = room.los;

  // ---- teams
  const facs = o.factions.length ? o.factions : (['usec', 'scav'] as RaidFaction[]);
  const fa = rng.pick(facs);
  const others = facs.filter((f) => f !== fa);
  const fb = others.length ? rng.pick(others) : fa;
  const sizes = rng.pick(RAID_PACING[o.intensity].sizes);
  // spawns tagged with a faction (BG_SPAWN_xx extras `faction`) belong to it: frogs come from their end of the street
  const ownA = room.spawns.map((sp, i) => i).filter((i) => room.spawns[i].fac === fa);
  const spA = ownA.length ? ownA[rng.int(ownA.length)] : rng.int(room.spawns.length);
  let spB = spA, far = -1;
  const ownB = room.spawns.map((sp, i) => i).filter((i) => room.spawns[i].fac === fb && i !== spA);
  if (ownB.length) spB = ownB[rng.int(ownB.length)];
  else room.spawns.forEach((sp, i) => { const dd = d2(sp.p.x, sp.p.z, room.spawns[spA].p.x, room.spawns[spA].p.z); if (i !== spA && dd > far) { far = dd; spB = i; } });
  const acts: Act[] = [];
  const mk = (team: number, fac: RaidFaction, k: number, sp: number, at: number) => {
    const unit = rng.pick(UNITS[fac]);
    const weapon = !FIXED_WEAPON.has(unit) && rng.chance(0.25) ? rng.pick(ALT_WEAPON[fac]) : LOADOUT[unit];
    const p = room.spawns[sp].p;
    const a: Act = {
      id: acts.length, team, fac, unit, weapon, gun: GUNS[weapon] ?? GUNS.ak, x: p.x + (k % 2 ? 0.4 : -0.4) * s, y: p.y, z: p.z, yaw: Math.atan2(room.spawns[sp].dx, room.spawns[sp].dz),
      hp: 100, alive: true, spawnAt: at, born: false, gone: false, state: S.HIDDEN, stSince: 0, aimPitch: 0, dist: 0, aux: 0, alpha: 1,
      mode: 'wait', path: [], pi: 0, speed: 0, moveState: S.RUN, back: false, arrive: null, cover: -1, target: null, phase: 'hide', timer: 0,
      ammo: 0, burst: 0, nextShot: 0, busy: 0, lastExposed: -99, noTargetFor: 0, tasks: [], task: null, dragging: null, draggedBy: null,
      looted: false, claimed: false, deathVar: 0, fled: false, data: new Float32Array(maxT * NF), sta: 0, navHint: room.spawns[sp].nav,
      pauseUntil: -1, pauseIdx: -1, bornT: -1, fadeStart: -1, fm: -1, lurk: false,
    };
    a.ammo = a.gun.mag;
    acts.push(a);
    return a;
  };
  let PT = o.patrol ?? null;
  if (PT && PT.reversible && rng.chance(0.5)) {
    const n = PT.path.length;
    PT = { ...PT, path: [...PT.path].reverse(), form: PT.form ? [...PT.form.slice(0, n - 1)].reverse().concat(PT.form[n - 1] ? [PT.form[n - 1]] : []) : undefined, pauses: PT.pauses.map((q) => ({ ...q, i: n - 1 - q.i })).sort((a, b) => a.i - b.i) };
  }
  if (!PT) {
    let at = Math.round(rng.range(5, 15));
    for (let k = 0; k < sizes[0]; k++) { mk(0, fa, k, spA, at); at += Math.round(rng.range(6, 14)); }
    at = Math.round(rng.range(15, 45));
    for (let k = 0; k < sizes[1]; k++) { mk(1, fb, k, spB, at); at += Math.round(rng.range(6, 14)); }
  } else {
    // the boss squad walks in along the route, 1.4 s apart; ambushers wait (spawnAt = never) until triggered
    const squad = PT.squad ?? ['guard_a', 'reshala', 'guard_b', 'guard_c', 'guard_d'];
    const p0 = PT.path[0], p1 = PT.path[1] ?? PT.path[0];
    squad.forEach((u, k) => {
      const a = mk(0, 'usec', 0, spA, 1e9);    // born by the formation (stepSquad) when its slot reaches the route start
      a.unit = u; a.fac = u === 'reshala' ? 'reshala' : 'guard'; a.weapon = LOADOUT[u] ?? 'ak'; a.gun = GUNS[a.weapon] ?? GUNS.ak; a.ammo = a.gun.mag;
      a.hp = u === 'reshala' ? 260 : 230; a.fm = k;
      a.x = p0.x; a.y = p0.y; a.z = p0.z; a.yaw = Math.atan2(p1.x - p0.x, p1.z - p0.z); a.navHint = -1;
    });
    if (PT.ambush) {
      const n = 2 + (rng.chance(0.5) ? 1 : 0);
      const af = PT.ambushFactions.length ? PT.ambushFactions : (['usec'] as RaidFaction[]);
      const fac = rng.pick(af);
      for (let k = 0; k < n; k++) { const a = mk(1, fac, k, spB, 1e9); a.hp = 100; }
    }
  }
  const shots: SimShot[] = [];
  const notes: SimNote[] = [];

  // ---- navigation
  const nearestNav = (x: number, y: number, z: number) => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < room.nav; i++) { const p = pts[i]; const dd = Math.hypot(p.x - x, (p.y - y) * 2, p.z - z); if (dd < bd) { bd = dd; bi = i; } }
    return bi;
  };
  const dijkstra = (a: number, b: number): number[] => {
    const dist = new Array(room.nav).fill(Infinity), prev = new Array(room.nav).fill(-1), done = new Array(room.nav).fill(false);
    dist[a] = 0;
    for (;;) {
      let u = -1, ud = Infinity;
      for (let i = 0; i < room.nav; i++) if (!done[i] && dist[i] < ud) { ud = dist[i]; u = i; }
      if (u < 0 || u === b) break;
      done[u] = true;
      for (const [v, w] of room.adj[u]) if (ud + w < dist[v]) { dist[v] = ud + w; prev[v] = u; }
    }
    if (a !== b && prev[b] < 0) return [a];
    const out: number[] = [];
    for (let v = b; v >= 0; v = prev[v]) { out.push(v); if (v === a) break; }
    return out.reverse();
  };
  const exitNav = new Map<P3, number>(room.exits.map((e) => [e.p, e.nav]));
  const route = (fx: number, fy: number, fz: number, to: P3, fromNav = -1): P3[] => {
    const toNav = exitNav.get(to) ?? -1;
    if (d2(fx, fz, to.x, to.z) < 2.5 && fromNav < 0 && toNav < 0) return [to];
    const na = fromNav >= 0 ? fromNav : nearestNav(fx, fy, fz), nb = toNav >= 0 ? toNav : nearestNav(to.x, to.y, to.z);
    const nodes = dijkstra(na, nb);
    const P = (i: number) => pts[i];
    while (fromNav < 0 && nodes.length >= 2 && d2(fx, fz, P(nodes[1]).x, P(nodes[1]).z) <= d2(P(nodes[0]).x, P(nodes[0]).z, P(nodes[1]).x, P(nodes[1]).z)) nodes.shift();
    while (toNav < 0 && nodes.length >= 2 && d2(to.x, to.z, P(nodes[nodes.length - 2]).x, P(nodes[nodes.length - 2]).z) <= d2(P(nodes[nodes.length - 1]).x, P(nodes[nodes.length - 1]).z, P(nodes[nodes.length - 2]).x, P(nodes[nodes.length - 2]).z)) nodes.pop();
    return [...nodes.map(P), to];
  };
  const station = (a: Act) => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < N; i++) { const p = pts[i]; const dd = Math.hypot(p.x - a.x, (p.y - a.y) * 3, p.z - a.z); if (dd < bd) { bd = dd; bi = i; } }
    return bi;
  };
  const sees = (a: Act, b: Act) => los[a.sta * N + b.sta] === 1 && d2(a.x, a.z, b.x, b.z) < 42;

  // ---- state helpers
  let t = 0;
  const setState = (a: Act, st: number) => { if (a.state !== st) { a.state = st; a.stSince = t; } };
  const face = (a: Act, x: number, z: number, rate = 0.9) => {
    const want = Math.atan2(x - a.x, z - a.z);
    const d = angTo(a.yaw, want);
    a.yaw += Math.max(-rate, Math.min(rate, d));
  };
  const moveTo = (a: Act, dest: P3, st: number, speed: number, arrive: (() => void) | null, back = false) => {
    a.path = route(a.x, a.y, a.z, dest, a.navHint);
    a.navHint = -1;
    a.pi = 0; a.moveState = st; a.speed = speed * s; a.back = back; a.arrive = arrive; a.mode = 'move';
    setState(a, st);
  };
  const moveAlong = (a: Act, path: P3[], st: number, speed: number, arrive: (() => void) | null, back = false) => {
    a.path = path.length ? path : [{ x: a.x, y: a.y, z: a.z }];
    a.pi = 0; a.moveState = st; a.speed = speed * s; a.back = back; a.arrive = arrive; a.mode = 'move';
    setState(a, st);
  };
  const routeFrom = (x: number, z: number) => {
    if (!PT) return [] as P3[];
    let bi = 0, bd = Infinity;
    PT.path.forEach((p, i) => { const dd = d2(x, z, p.x, p.z); if (dd < bd) { bd = dd; bi = i; } });
    return PT.path.slice(Math.min(PT.path.length - 1, bi + 1));
  };
  const fadeOut = (a: Act) => { a.mode = 'fading'; a.fadeStart = t; setState(a, a.unit === 'reshala' ? S.IDLE : S.SCAN); };
  const EXPOSED = new Set<number>([S.IDLE, S.WALK, S.RUN, S.CROUCH_WALK, S.AIM, S.AIM_CROUCH, S.PEEK_L, S.PEEK_R, S.HIT, S.THROW, S.LOOT, S.DRAG]);
  const exposed = (b: Act) => {
    if (b.cover >= 0 && b.mode === 'cover' && (b.state === S.CROUCH_IDLE || b.state === S.IDLE || b.state === S.RELOAD)) return false;
    return EXPOSED.has(b.state) || b.state === S.RELOAD;
  };
  const coverTaken = (c: number, self: Act) => acts.some((x) => x !== self && x.alive && !x.gone && x.cover === c);
  const enemies = (a: Act) => acts.filter((x) => x.team !== a.team && x.alive && x.born && !x.gone && !x.fled);
  const alliesAlive = (team: number) => acts.filter((x) => x.team === team && x.alive && !x.gone && !x.fled);
  // nearest exit by walking distance (through its nav node when it has one)
  const exitNear = (x: number, z: number) => {
    let b = room.exits[0].p, bd = Infinity;
    for (const e of room.exits) { const q = e.nav >= 0 ? pts[e.nav] : e.p; const dd = d2(x, z, q.x, q.z) + d2(q.x, q.z, e.p.x, e.p.z); if (dd < bd) { bd = dd; b = e.p; } }
    return b;
  };
  const spawnOf = (team: number) => room.spawns[team === 0 ? spA : spB].p;
  const enemySpawn = (team: number) => spawnOf(1 - team);
  const chestOf = (b: Act) => {
    const [lx, lz] = CHEST_OF[b.deathVar] ?? [0, 0];
    const c = Math.cos(b.yaw), sn = Math.sin(b.yaw);
    return { x: b.x + (lx * c + lz * sn) * s, y: b.y, z: b.z + (-lx * sn + lz * c) * s };
  };

  // cover choice: facing the threat, partway between the spawns, free
  const pickCover = (a: Act, near?: { x: number; z: number }, needLos?: Act) => {
    const own = spawnOf(a.team), en = enemySpawn(a.team);
    const vx = en.x - own.x, vz = en.z - own.z, vl = Math.hypot(vx, vz) || 1;
    let best = -1, bs = -Infinity;
    for (const c of room.covers) {
      if (coverTaken(c.i, a)) continue;
      const p = pts[c.i];
      const tx = en.x - p.x, tz = en.z - p.z, tl = Math.hypot(tx, tz) || 1;
      const facing = (c.dx * tx + c.dz * tz) / tl;
      if (facing < 0.15 && !needLos) continue;
      const along = ((p.x - own.x) * vx + (p.z - own.z) * vz) / (vl * vl);
      let sc = facing * 2 - Math.abs(along - 0.38) * 3 + rng.next() * 0.6;
      if (near) sc -= d2(p.x, p.z, near.x, near.z) * 0.08;
      if (needLos) { if (los[c.i * N + needLos.sta] !== 1) continue; sc += 1; }
      if (sc > bs) { bs = sc; best = c.i; }
    }
    return best;
  };
  const coverInfo = (i: number) => room.covers.find((c) => c.i === i) ?? null;

  const goToCover = (a: Act, c: number) => {
    a.cover = c;
    moveTo(a, pts[c], a.mode === 'wait' || !a.born ? S.RUN : S.RUN, 3.3, () => { a.mode = 'cover'; a.phase = 'hide'; a.timer = Math.round(rng.range(4, 14)); const ci = coverInfo(c); if (ci) a.yaw = Math.atan2(ci.dx, ci.dz); });
  };
  const advance = (a: Act) => {
    // no line of sight from here: a free cover that sees the nearest enemy, else walk towards them
    const es = enemies(a);
    if (!es.length) return;
    const e = es.reduce((m, x) => (d2(a.x, a.z, x.x, x.z) < d2(a.x, a.z, m.x, m.z) ? x : m));
    const c = pickCover(a, { x: a.x, z: a.z }, e);
    if (c >= 0) { a.cover = -1; goToCover(a, c); return; }
    a.cover = -1;
    const mid = pts[nearestNav((a.x + e.x) / 2, e.y, (a.z + e.z) / 2)];
    moveTo(a, mid, S.CROUCH_WALK, 0.8, () => { a.mode = 'cover'; a.phase = 'hide'; a.timer = 5; });
  };

  // ---- combat
  let firstShot = -1;
  let fightOver = -1;
  const boost = () => (firstShot < 0 ? 1 : 1 + Math.max(0, (t - firstShot) * TICK - 22) / 9);
  const die = (b: Act, killer: Act | null) => {
    b.alive = false; b.hp = 0; b.mode = 'dead'; b.busy = 0; b.cover = -1; b.target = null;
    let v: number = S.DEATH_SPIN;
    if (killer) {
      const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
      const kx = killer.x - b.x, kz = killer.z - b.z, kl = Math.hypot(kx, kz) || 1;
      const dot = (fx * kx + fz * kz) / kl;
      v = dot > 0.35 ? S.DEATH_BACK : dot < -0.35 ? S.DEATH_FWD : rng.chance(0.5) ? S.DEATH_SPIN : S.DEATH_BACK;
    }
    b.deathVar = v;
    b.aux = v;
    setState(b, v);
    notes.push({ tick: t, kind: 'death', a: b.id, b: killer?.id });
  };
  const fire = (a: Act, b: Act, frac: number) => {
    const dd = d2(a.x, a.z, b.x, b.z);
    const ex = exposed(b) || t - b.lastExposed < 4;
    let hit = false;
    let kind: SimShot['kind'] = 'cover';
    if (ex && exposed(b)) {
      const base = b.state === S.RUN ? 0.1 : b.state === S.WALK || b.state === S.CROUCH_WALK ? 0.14 : b.state === S.AIM || b.state === S.AIM_CROUCH || b.state === S.PEEK_L || b.state === S.PEEK_R ? 0.17 : 0.24;
      const range = Math.max(0.3, Math.min(1.15, 1.25 - dd / a.gun.range));
      const p = Math.min(0.85, base * (SKILL[a.fac] ?? 1) * range * boost() * (t - firstShot > 700 ? 4 : 1));
      hit = rng.next() < p;
      kind = hit ? 'body' : 'miss';
    }
    shots.push({ tick: t, frac, from: a.id, to: b.id, hit, kind, seed: (rng.next() * 1e9) >>> 0 });
    if (firstShot < 0) firstShot = t;
    a.ammo--;
    if (hit) {
      let dmg = rng.range(a.gun.dmg[0], a.gun.dmg[1]);
      if (a.weapon === 'shotgun' && dd > 12) dmg *= 0.5;
      b.hp -= dmg;
      if (b.hp <= 0) die(b, a);
      else if (b.busy <= t && b.mode !== 'move') { setState(b, S.HIT); b.busy = t + 5; if (b.phase === 'burst' || b.phase === 'expose') { b.phase = 'post'; b.timer = 3; } }
    }
  };
  const grenades: { t: number; x: number; y: number; z: number; by: Act }[] = [];

  const thinkCover = (a: Act) => {
    if (a.busy > t) return;
    const ci = coverInfo(a.cover);
    const crouch = ci ? ci.crouch : false;
    const hideState = a.cover >= 0 ? (crouch ? S.CROUCH_IDLE : S.IDLE) : S.CROUCH_IDLE;
    if (a.lurk) { setState(a, crouch || !ci ? S.CROUCH_IDLE : S.IDLE); if (ci) a.yaw += angTo(a.yaw, Math.atan2(ci.dx, ci.dz)) * 0.3; return; }
    // target: keep the current one while visible, else the nearest visible
    const es = enemies(a).filter((e) => sees(a, e));
    if (!a.target || !a.target.alive || !es.includes(a.target)) a.target = es.length ? es.reduce((m, x) => (d2(a.x, a.z, x.x, x.z) < d2(a.x, a.z, m.x, m.z) ? x : m)) : null;
    const tg = a.target;
    if (!tg) {
      setState(a, a.ammo < a.gun.mag * 0.5 ? S.RELOAD : hideState);
      if (a.state === S.RELOAD && t - a.stSince >= 24) { a.ammo = a.gun.mag; setState(a, hideState); }
      if (ci) a.yaw += angTo(a.yaw, Math.atan2(ci.dx, ci.dz)) * 0.3;
      if (++a.noTargetFor > 45 && enemies(a).length) { a.noTargetFor = 0; advance(a); }
      return;
    }
    a.noTargetFor = 0;
    switch (a.phase) {
      case 'hide': {
        setState(a, hideState);
        if (ci) a.yaw += angTo(a.yaw, Math.atan2(ci.dx, ci.dz)) * 0.3;
        if (--a.timer > 0) return;
        if (a.ammo <= 0) { setState(a, S.RELOAD); a.busy = t + 24; a.ammo = a.gun.mag; a.timer = 3; return; }
        const dd = d2(a.x, a.z, tg.x, tg.z);
        if (o.intensity !== 'chill' && firstShot >= 0 && dd > 6 && dd < 24 && rng.chance(0.07)) {
          face(a, tg.x, tg.z, 3);
          setState(a, S.THROW); a.busy = t + 14; a.timer = 6;
          const land = { x: tg.x + rng.range(-1.2, 1.2) * s, y: tg.y, z: tg.z + rng.range(-1.2, 1.2) * s };
          notes.push({ tick: t + 7, kind: 'throw', a: a.id, p: { x: a.x, y: a.y + 1.5 * s, z: a.z }, q: land, n: 12 });
          grenades.push({ t: t + 7 + 12 + 10, ...land, by: a });
          return;
        }
        if (firstShot >= 0 && rng.chance(0.1 + Math.min(0.25, (boost() - 1) * 0.1))) {
          const c = pickCover(a, { x: tg.x, z: tg.z }, tg);
          if (c >= 0 && c !== a.cover) { goToCover(a, c); return; }
        }
        a.phase = 'expose'; a.timer = 4;
        return;
      }
      case 'expose': {
        face(a, tg.x, tg.z, 1.2);
        if (a.cover >= 0 && ci && !ci.crouch) {
          const cr = ci.dx * (tg.z - a.z) - ci.dz * (tg.x - a.x);
          setState(a, cr > 0 ? S.PEEK_R : S.PEEK_L);
        } else setState(a, a.cover >= 0 ? S.AIM_CROUCH : S.AIM);
        a.lastExposed = t;
        if (--a.timer > 0) return;
        a.phase = 'burst';
        a.burst = Math.round(rng.range(a.gun.burst[0], a.gun.burst[1] + 0.99));
        a.nextShot = t * TICK;
        return;
      }
      case 'burst': {
        face(a, tg.x, tg.z, 1.2);
        a.lastExposed = t;
        while (a.burst > 0 && a.ammo > 0 && a.nextShot < (t + 1) * TICK) {
          fire(a, tg, Math.max(0, Math.min(0.999, a.nextShot / TICK - t)));
          a.nextShot += a.gun.rate * rng.range(0.9, 1.25);
          a.burst--;
          if (!tg.alive) break;
        }
        if (a.burst <= 0 || a.ammo <= 0 || !tg.alive) { a.phase = 'post'; a.timer = 3; }
        return;
      }
      case 'post': {
        a.lastExposed = t;
        if (--a.timer > 0) return;
        a.phase = 'hide'; a.timer = Math.round(rng.range(9, 26) / Math.min(2, boost()));
        return;
      }
    }
  };

  // ---- the boss squad: one formation walking the route by arc length (the boss' arc sB), pausing at PATROL_PAUSE_xx
  // (boss at the point facing lookAt, guards on their guardSlots facing outward), born at the route start and
  // faded at its end. Formations per segment (file / column / wedge, the point's free width); the guard ahead of
  // the boss steps onto his slot before the boss reaches a pause (so nobody walks through him in a doorway).
  const R = PT ? PT.path : [];
  const cum: number[] = [0];
  for (let i = 1; i < R.length; i++) cum.push(cum[i - 1] + d2(R[i].x, R[i].z, R[i - 1].x, R[i - 1].z));
  const Ltot = cum[cum.length - 1] ?? 0;
  const along = (sa: number) => {
    const q = Math.max(0, Math.min(Ltot, sa));
    let k = 0;
    while (k < R.length - 2 && cum[k + 1] < q) k++;
    const l = cum[k + 1] - cum[k] || 1, f = Math.max(0, Math.min(1, (q - cum[k]) / l));
    const a = R[k], b = R[k + 1] ?? R[k];
    const tx = (b.x - a.x) / l, tz = (b.z - a.z) / l;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f, tx, tz, k };
  };
  const arcOf = (x: number, z: number) => {
    let best = 0, bd = Infinity;
    for (let k = 0; k + 1 < R.length; k++) {
      const a = R[k], b = R[k + 1];
      const vx = b.x - a.x, vz = b.z - a.z, vl = vx * vx + vz * vz || 1;
      const f = Math.max(0, Math.min(1, ((x - a.x) * vx + (z - a.z) * vz) / vl));
      const dd = d2(x, z, a.x + vx * f, a.z + vz * f);
      if (dd < bd) { bd = dd; best = cum[k] + f * Math.sqrt(vl); }
    }
    return best;
  };
  // along / lateral offsets per formation slot (slot 1 = the boss)
  const FORM: Record<string, [number, number][]> = {
    file: [[1.1, 0], [0, 0], [-1.1, 0], [-2.2, 0], [-3.3, 0]],
    column: [[1.2, 0], [0, -1], [0, 1], [-1.2, -1], [-1.2, 1]],
    wedge: [[1.9, 0], [0, 0], [0, -1], [0, 1], [-1.9, 0]],
  };
  const formAt = (k: number) => PT?.form?.[k] ?? { f: 'file' as const, w: 1.4 };
  const formTarget = (fm: number, k: number): [number, number] => {
    const f = formAt(k);
    const tb = FORM[f.f] ?? FORM.file;
    const [al, la] = tb[fm % tb.length] ?? [-(fm + 1) * 1.1, 0];
    const half = f.f === 'column' ? Math.min(0.55, Math.max(0, f.w / 2 - 0.35)) : f.f === 'wedge' ? Math.min(1.8, Math.max(0.4, f.w / 2 - 0.3)) : 0;
    return [al * s, la * half];
  };
  const speed = PT ? PT.speed ?? 1.05 * s : 0;
  const pausesArc = PT ? PT.pauses.filter((q) => q.i > 0 && q.i < R.length).map((q) => ({ ...q, arc: cum[q.i] })) : [];
  const squadAll = acts.filter((a) => PT && a.team === 0);
  const bossA = squadAll.find((a) => a.unit === 'reshala') ?? squadAll[0] ?? null;
  const offA = squadAll.map((a) => formTarget(a.fm, 0)[0]), offL = squadAll.map((a) => formTarget(a.fm, 0)[1]);
  let sB = -Math.max(0, ...offA) - 0.01;
  let paused = false, pauseEnd = 0, pn = 0;
  let squadMode = 'walk' as 'walk' | 'fight' | 'regroup';
  let squadResume = 0;
  const T0 = 5;
  const slotsOf = new Map<number, Map<Act, P3>>();
  const anchor = () => (bossA && bossA.alive && !bossA.gone ? bossA : squadAll.find((a) => a.alive && !a.gone && !a.dragging) ?? null);
  const slotPoint = (a: Act): P3 => {
    const m = squadAll.indexOf(a);
    const q = along(sB + (m >= 0 ? offA[m] : 0));
    const la = m >= 0 ? offL[m] : 0;
    return { x: q.x - q.tz * la, y: q.y, z: q.z + q.tx * la };
  };
  // guards → guardSlots, least total walk (<= 4! permutations)
  const assignSlots = (P: (typeof pausesArc)[number]) => {
    const gs = squadAll.filter((a) => a !== bossA && a.alive && !a.gone && a.mode === 'patrol');
    const sl = P.slots ?? [];
    const out = new Map<Act, P3>();
    if (!sl.length) return out;
    let best: number[] = [], bs = Infinity;
    const used: boolean[] = sl.map(() => false), cur: number[] = [];
    const rec = (i: number, acc: number) => {
      if (acc >= bs) return;
      if (i === gs.length || i === sl.length) { bs = acc; best = [...cur]; return; }
      for (let j = 0; j < sl.length; j++) if (!used[j]) { used[j] = true; cur.push(j); rec(i + 1, acc + d2(gs[i].x, gs[i].z, sl[j].x, sl[j].z)); cur.pop(); used[j] = false; }
    };
    rec(0, 0);
    best.forEach((j, i) => out.set(gs[i], sl[j]));
    return out;
  };
  const pauseState = (a: Act, P: (typeof pausesArc)[number]) => {
    if (a === bossA) return P.action === 'warm_hands' ? S.WARM : P.action === 'look_around' || P.action === 'check_rear' ? S.SCAN : S.IDLE;
    return P.action === 'look_in' ? S.IDLE : S.SCAN;
  };
  const stepSquad = () => {
    if (squadMode !== 'walk' || t < T0 || !PT) return;
    const P = pausesArc[pn];
    if (paused) { if (t >= pauseEnd) { paused = false; pn++; } }
    else {
      sB += speed * TICK;
      if (P && sB >= P.arc) { sB = P.arc; paused = true; pauseEnd = t + P.ticks + 6; }
    }
    const Pc = pausesArc[pn];
    if (Pc && !slotsOf.has(pn) && sB > Pc.arc - 4.5) slotsOf.set(pn, assignSlots(Pc));
    const slots = Pc ? slotsOf.get(pn) : undefined;
    squadAll.forEach((a, m) => {
      if (a.mode !== 'patrol' && a.born) return;
      if (!a.alive || a.gone) return;
      // formation offsets ease towards the current segment's formation
      const [ta, tl] = formTarget(a.fm < 0 ? m : a.fm, along(sB).k);
      offA[m] += (ta - offA[m]) * 0.06; offL[m] += (tl - offL[m]) * 0.06;
      const arc = sB + offA[m];
      if (!a.born) {
        if (arc < 0) return;
        a.born = true; a.bornT = t; a.spawnAt = t; a.mode = 'patrol'; notes.push({ tick: t, kind: 'spawn', a: a.id });
        a.x = R[0].x; a.y = R[0].y; a.z = R[0].z;
      }
      if (arc >= Ltot - 0.05 && !paused && a.mode === 'patrol') { fadeOut(a); return; }
      let des: P3;
      const sl = slots?.get(a);
      if (Pc && a === bossA && paused) des = R[Pc.i];
      else if (Pc && sl && (paused || (arc > Pc.arc - 0.3 && sB > Pc.arc - 4.5))) des = sl;
      else des = slotPoint(a);
      const dx = des.x - a.x, dz = des.z - a.z, l = Math.hypot(dx, dz);
      // standing still means still (no foot-sliding creep): only walk when the slot is a real step away
      const walking = l > (a.state === S.WALK ? 0.02 : 0.09);
      const step = walking ? Math.min(l, speed * 1.6 * TICK) : 0;
      if (step > 0) { const k = step / l; a.x += dx * k; a.z += dz * k; a.y += (des.y - a.y) * Math.min(1, k * 1.5); }
      a.dist += step;
      if (walking) {
        a.yaw += Math.max(-0.3, Math.min(0.3, angTo(a.yaw, Math.atan2(dx, dz))));
        setState(a, S.WALK);
      } else {
        let want = a.yaw;
        if (paused && Pc) {
          const pp = R[Pc.i];
          if (a === bossA) want = Pc.look ? Math.atan2(Pc.look.x - pp.x, Pc.look.z - pp.z) : Pc.yaw ?? a.yaw;
          else if (sl) want = Math.atan2(sl.x - pp.x, sl.z - pp.z);
          else if (Pc.yaw !== null) want = Pc.yaw;
        }
        const turn = angTo(a.yaw, want) * 0.15;
        a.yaw += turn;
        // turning on the spot: step it round (the walk cycle advances with the turn) instead of pivoting on planted feet
        if (Math.abs(turn) > 0.035) { a.dist += Math.abs(turn) * 0.35; setState(a, S.WALK); }
        else setState(a, paused && Pc ? pauseState(a, Pc) : S.IDLE);
      }
    });
  };
  // boss-squad timeline (for the lurkers' timing): tick at which the boss' arc reaches `sa`
  const tickAt = (sa: number) => {
    let tt = T0 + (sa - sB) / (speed * TICK);
    for (const q of pausesArc) if (q.arc < sa) tt += q.ticks + 6;
    return tt;
  };
  // ambush with pmc_ambush covers: the raiders sneak in early from a PMC spawn to covers along one stretch of the
  // route and wait there; they open up when the squad walks into them
  const guardCovers = new Set(room.covers.filter((c) => c.role === 'guard').map((c) => c.i));
  let lurkPlan: { trig: number; late: number } | null = null;
  let squadReacted = false;
  let lurkFired = false;
  if (PT && PT.ambush) {
    const amb = room.covers.filter((c) => c.role === 'pmc_ambush');
    const spawnsP = room.spawns.map((sp, i) => ({ sp, i })).filter(({ sp }) => !sp.fac || /pmc|any|usec|bear/.test(sp.fac));
    const pathLen = (ps: P3[], from: P3) => { let l = 0, px = from.x, pz = from.z; for (const q of ps) { l += d2(px, pz, q.x, q.z); px = q.x; pz = q.z; } return l; };
    // latest spawn (and which) that still gets a raider into cover `ci` before tick `need`
    const bestSpawn = (ci: number, need: number) => {
      const p = pts[ci];
      let sp = -1, at = -Infinity;
      for (const { sp: q, i } of spawnsP) {
        const len = pathLen(route(q.p.x, q.p.y, q.p.z, p, q.nav), q.p);
        if (len > 60) continue;
        const a = Math.round(need - len / (3.3 * s) / TICK - 10);
        if (a > at) { at = a; sp = i; }
      }
      return { sp, at };
    };
    const cand = amb.map((c) => ({ c: c.i, arc: arcOf(pts[c.i].x, pts[c.i].z) }));
    const needFor = (arc: number) => tickAt(Math.max(0, arc - 11)) - 25;
    const feas = cand.filter((c) => bestSpawn(c.c, needFor(c.arc)).at >= 1);
    const raiders = acts.filter((x) => x.team === 1);
    if (feas.length && raiders.length) {
      const first = feas[rng.int(feas.length)];
      const dd = (a: { c: number }) => d2(pts[a.c].x, pts[a.c].z, pts[first.c].x, pts[first.c].z);
      const group = [first, ...feas.filter((f) => f !== first && dd(f) < 17).sort((a, b) => dd(a) - dd(b))].slice(0, raiders.length);
      // the kill zone starts a little before the first of the group's covers along the route
      const trig = Math.min(...group.map((g) => g.arc)) - 7;
      const need = needFor(trig + 7);
      raiders.forEach((x, k) => {
        const g = group[k % group.length];
        const b = bestSpawn(g.c, need);
        const sp = room.spawns[b.sp >= 0 ? b.sp : 0];
        x.x = sp.p.x + (k % 2 ? 0.4 : -0.4) * s; x.y = sp.p.y; x.z = sp.p.z; x.navHint = sp.nav; x.yaw = Math.atan2(sp.dx, sp.dz);
        x.spawnAt = Math.max(1, b.at - rng.int(20) - k * 6);
        x.lurk = k < group.length; x.cover = x.lurk ? g.c : -1;
      });
      lurkPlan = { trig, late: Math.max(...group.map((g) => g.arc)) + 4 };
    }
  }

  // ---- after the fight: tasks
  const bodies = () => acts.filter((x) => !x.alive && x.born && !x.gone && !x.draggedBy);
  const startTask = (a: Act) => {
    const tk = a.tasks.shift() ?? null;
    a.task = tk;
    if (!tk) { a.mode = 'task'; setState(a, S.IDLE); return; }
    a.mode = 'task';
    if (tk.k === 'lootBody') {
      const b = tk.b;
      if (b.gone || b.draggedBy) return startTask(a);
      const c = chestOf(b);
      const ux = a.x - c.x, uz = a.z - c.z, ul = Math.hypot(ux, uz) || 1;
      const kp = { x: c.x + (ux / ul) * 0.62 * s, y: c.y, z: c.z + (uz / ul) * 0.62 * s };
      moveTo(a, kp, S.WALK, 1.1, () => {
        a.mode = 'task'; a.yaw = Math.atan2(c.x - a.x, c.z - a.z); setState(a, S.LOOT);
        a.timer = Math.round(rng.range(35, 55));
        a.task = { k: 'lootBody', b };
      });
      a.timer = -1;
    } else if (tk.k === 'lootSpot') {
      const l = room.loot[tk.l];
      moveTo(a, pts[l.i], S.WALK, 1.1, () => { a.mode = 'task'; a.yaw = Math.atan2(l.dx, l.dz); setState(a, S.LOOT); a.timer = Math.round(rng.range(40, 70)); });
      a.timer = -1;
    } else if (tk.k === 'drag') {
      const b = tk.b;
      if (b.gone || b.draggedBy) return startTask(a);
      b.claimed = true;
      const c = chestOf(b);
      const ex = tk.to ?? exitNear(c.x, c.z);
      const ux = ex.x - c.x, uz = ex.z - c.z, ul = Math.hypot(ux, uz) || 1;
      const gp = { x: c.x + (ux / ul) * 0.55 * s, y: c.y, z: c.z + (uz / ul) * 0.55 * s };
      moveTo(a, gp, S.WALK, 1.1, () => {
        a.mode = 'task';
        a.yaw = Math.atan2(c.x - a.x, c.z - a.z);
        a.dragging = b; b.draggedBy = a; b.mode = 'dead';
        notes.push({ tick: t, kind: 'grab', a: a.id, b: b.id });
        setState(b, S.DRAGGED);
        moveTo(a, ex, S.DRAG, tk.to ? 0.95 : 0.75, () => {
          notes.push({ tick: t, kind: 'gc', a: a.id, b: b.id });
          a.gone = true; a.mode = 'gone'; b.gone = true; a.dragging = null;
          setState(a, S.HIDDEN); setState(b, S.HIDDEN);
        }, true);
      });
      a.timer = -1;
    } else if (tk.k === 'watch') {
      const en = enemySpawn(a.team);
      a.yaw = Math.atan2(en.x - a.x, en.z - a.z);
      setState(a, rng.chance(0.5) ? S.AIM : S.IDLE);
      a.timer = tk.n;
    } else if (tk.k === 'route') {
      moveAlong(a, routeFrom(a.x, a.z), S.WALK, 1.05, () => fadeOut(a));
    } else if (tk.k === 'rejoin') {
      // back to the formation slot through the nav graph (round the cars), then the squad walks on
      const q = slotPoint(a);
      moveTo(a, q, S.WALK, 1.3, () => { a.mode = 'patrol'; if (a === bossA) squadResume = t + 8; });
    } else if (tk.k === 'dragRoute') {
      const b = tk.b;
      if (b.gone || b.draggedBy) return startTask(a);
      b.claimed = true;
      const c = chestOf(b);
      const rest = routeFrom(c.x, c.z);
      const nx = rest[0] ?? PT!.path[PT!.path.length - 1];
      const ux = nx.x - c.x, uz = nx.z - c.z, ul = Math.hypot(ux, uz) || 1;
      const gp = { x: c.x + (ux / ul) * 0.55 * s, y: c.y, z: c.z + (uz / ul) * 0.55 * s };
      moveTo(a, gp, S.WALK, 1.1, () => {
        a.mode = 'task';
        a.yaw = Math.atan2(c.x - a.x, c.z - a.z);
        a.dragging = b; b.draggedBy = a; b.mode = 'dead';
        notes.push({ tick: t, kind: 'grab', a: a.id, b: b.id });
        setState(b, S.DRAGGED);
        moveAlong(a, rest, S.DRAG, 0.75, () => {
          notes.push({ tick: t, kind: 'gc', a: a.id, b: b.id });
          a.gone = true; a.mode = 'gone'; b.gone = true; a.dragging = null;
          setState(a, S.HIDDEN); setState(b, S.HIDDEN);
        }, true);
      });
      a.timer = -1;
    } else if (tk.k === 'exit' || tk.k === 'fleeExit') {
      const ex = tk.k === 'fleeExit' ? exitNear(spawnOf(a.team).x, spawnOf(a.team).z) : exitNear(a.x, a.z);
      moveTo(a, ex, tk.k === 'fleeExit' ? S.RUN : S.WALK, tk.k === 'fleeExit' ? 3.3 : 1.1, () => { a.gone = true; a.mode = 'gone'; setState(a, S.HIDDEN); });
    }
  };
  const thinkTask = (a: Act) => {
    if (a.mode === 'move') return;
    const tk = a.task;
    if (!tk) return startTask(a);
    if (a.timer > 0) {
      a.timer--;
      if (a.timer === 0) {
        if (tk.k === 'lootBody') { tk.b.looted = true; notes.push({ tick: t, kind: 'pickup', a: a.id, b: tk.b.id }); }
        if (tk.k === 'lootSpot') notes.push({ tick: t, kind: 'loot', a: a.id, n: tk.l });
        startTask(a);
      }
    }
  };
  const afterFight = () => {
    const winners = acts.filter((x) => x.alive && x.born && !x.gone && !x.fled);
    if (PT && winners.length && winners.every((w) => w.team === 0)) {
      // a guard or two search the attackers and haul them off (to the BG_EXIT_xx marked bodyDump, else along the
      // route); the rest watch a moment, regroup into the formation and walk on
      const dump = room.exits.find((e) => e.dump)?.p ?? null;
      const dead = bodies().filter((b) => b.team === 1).sort((p, q) => (dump ? d2(p.x, p.z, dump.x, dump.z) - d2(q.x, q.z, dump.x, dump.z) : 0) || p.id - q.id);
      const guards = winners.filter((w) => w.unit !== 'reshala');
      winners.forEach((w) => { w.mode = 'task'; w.cover = -1; w.target = null; w.busy = 0; w.task = null; w.tasks = []; setState(w, w.unit === 'reshala' ? S.IDLE : S.SCAN); });
      const keep = Math.max(1, guards.length - 1);    // never every guard: someone stays with the boss
      dead.slice(0, Math.min(2, keep)).forEach((b, i) => {
        const g = guards.filter((x) => !x.tasks.length).sort((p, q) => d2(p.x, p.z, b.x, b.z) - d2(q.x, q.z, b.x, b.z))[0];
        if (g) { g.tasks.push({ k: 'lootBody', b }, dump ? { k: 'drag', b, to: dump } : { k: 'dragRoute', b }); b.claimed = true; g.timer = 10 + i * 10; g.fm = -1; }
      });
      // resume the walk from where the boss (or the first survivor) stands
      const anc = winners.find((w) => w.unit === 'reshala') ?? winners.find((w) => !w.tasks.length) ?? winners[0];
      sB = Math.max(sB, arcOf(anc.x, anc.z));
      paused = false;
      pn = pausesArc.findIndex((q) => q.arc > sB + 0.5); if (pn < 0) pn = pausesArc.length;
      squadMode = 'regroup'; squadResume = t + 150;
      winners.forEach((w, k) => { if (!w.tasks.length) { w.tasks.push({ k: 'watch', n: Math.round(rng.range(25, 40)) }, { k: 'rejoin' }); w.timer = 5 + k * 4; } });
      return;
    }
    const dead = bodies().sort((p, q) => p.id - q.id);
    const lootFree = room.loot.map((_, i) => i);
    winners.forEach((w, k) => {
      w.mode = 'task'; w.cover = -1; w.target = null; w.busy = 0;
      const mine = dead.filter((b) => !b.claimed).sort((p, q) => d2(w.x, w.z, p.x, p.z) - d2(w.x, w.z, q.x, q.z));
      // the nearest free loot spot (big halls: no marathon walks)
      const nearLoot = () => { if (!lootFree.length) return -1; let bi = 0; lootFree.forEach((li, i) => { const q = pts[room.loot[li].i], b = pts[room.loot[lootFree[bi]].i]; if (d2(w.x, w.z, q.x, q.z) < d2(w.x, w.z, b.x, b.z)) bi = i; }); return lootFree.splice(bi, 1)[0]; };
      const late = t > maxT * 0.5;
      if (k === 0 && mine.length) { w.tasks.push({ k: 'lootBody', b: mine[0] }, { k: 'drag', b: mine[0] }); mine[0].claimed = true; }
      else if (k === 1) {
        const li = nearLoot();
        if (li >= 0) w.tasks.push({ k: 'lootSpot', l: li });
        const b = mine.find((x) => !x.claimed);
        if (b && !late) { w.tasks.push({ k: 'lootBody', b }, { k: 'drag', b }); b.claimed = true; } else w.tasks.push({ k: 'exit' });
      } else {
        const li = rng.chance(0.5) ? nearLoot() : -1;
        if (li >= 0) w.tasks.push({ k: 'lootSpot', l: li });
        else w.tasks.push({ k: 'watch', n: Math.round(rng.range(50, 100)) });
        w.tasks.push({ k: 'exit' });
      }
      w.task = null;
      w.timer = Math.round(rng.range(5, 20)) + k * 8;    // a beat before moving in
      setState(w, S.IDLE);
    });
  };

  // ---- main loop
  let end = -1;
  for (t = 0; t < maxT; t++) {
    if ((t & 15) === 15) { const t1 = performance.now(); planMs += t1 - t0; yield; t0 = performance.now(); }
    if (PT) stepSquad();
    // rooms without pmc_ambush covers: the attackers come in from the spawn nearest the squad ~40 % down the route
    if (PT && PT.ambush && !lurkPlan && acts.some((x) => x.team === 1 && x.spawnAt > 1e8) && sB >= Ltot * 0.4) {
      const lead = anchor();
      if (lead) {
        let best = -1, bd = Infinity;
        room.spawns.forEach((sp, i) => { const dd = d2(sp.p.x, sp.p.z, lead.x, lead.z); if (dd > 7 && dd < bd) { bd = dd; best = i; } });
        if (best < 0) best = spB;
        spB = best;
        let k = 0;
        for (const x of acts) if (x.team === 1) { const p = room.spawns[best].p; x.x = p.x + (k % 2 ? 0.4 : -0.4) * s; x.y = p.y; x.z = p.z; x.navHint = room.spawns[best].nav; x.spawnAt = t + 3 + k * 5; k++; }
      }
    }
    // lurkers: open fire together once the squad walks into them (or has passed them)
    if (lurkPlan && !lurkFired) {
      const ready = acts.filter((x) => x.team === 1 && x.lurk && x.born && x.alive && x.mode === 'cover');
      const sq = acts.filter((x) => x.team === 0 && x.born && x.alive && !x.gone);
      const near = ready.some((x) => sq.some((g) => { const dd = d2(x.x, x.z, g.x, g.z); return dd < 8.5 || (dd < 17 && los[x.sta * N + g.sta] === 1); }));
      if ((near && sB >= lurkPlan.trig) || sB > lurkPlan.late) {
        lurkFired = true;
        let k = 0;
        for (const x of acts) if (x.team === 1 && x.lurk) { x.lurk = false; x.phase = 'expose'; x.timer = 2 + k * 3; x.noTargetFor = 0; k++; }
      }
    }
    // the squad reacts to the first shot: guard covers close by that see an attacker, else any close cover, else crouch
    if (PT && !squadReacted && firstShot >= 0) {
      squadMode = 'fight'; squadReacted = true;
      const foes = acts.filter((x) => x.team === 1 && x.born && x.alive);
      let k = 0;
      for (const g of acts) {
        if (g.team !== 0 || !g.alive || g.gone) continue;
        if (!g.born) { g.born = true; g.bornT = t; g.spawnAt = t; notes.push({ tick: t, kind: 'spawn', a: g.id }); }
        g.mode = 'cover'; g.phase = 'hide'; g.timer = 3 + k * 2; g.pauseUntil = -1; g.alpha = 1; g.busy = t + 2 + k * 2; g.sta = station(g);
        let c = -1, cd = Infinity;
        for (const cv of room.covers) {
          if (!guardCovers.has(cv.i) || coverTaken(cv.i, g)) continue;
          const dd = d2(pts[cv.i].x, pts[cv.i].z, g.x, g.z);
          if (dd < 12 && dd < cd && foes.some((f) => los[cv.i * N + f.sta] === 1)) { cd = dd; c = cv.i; }
        }
        if (c < 0 && foes.length) { const c2 = pickCover(g, { x: g.x, z: g.z }, foes[0]); if (c2 >= 0 && d2(pts[c2].x, pts[c2].z, g.x, g.z) < 7) c = c2; }
        if (c >= 0) goToCover(g, c); else { g.cover = -1; setState(g, S.CROUCH_IDLE); }
        k++;
      }
    }
    if (PT && squadMode === 'regroup' && t >= squadResume) squadMode = 'walk';
    for (const a of acts) if (!a.born && t >= a.spawnAt && !(PT && a.team === 0)) {
      a.born = true; a.bornT = t; notes.push({ tick: t, kind: 'spawn', a: a.id });
      if (a.lurk && a.cover >= 0) { const c = a.cover; a.cover = -1; goToCover(a, c); continue; }
      const c = pickCover(a); if (c >= 0) goToCover(a, c); else advance(a);
    }
    if ((t & 1) === 0) for (const a of acts) if (a.born && !a.gone) a.sta = station(a);
    // grenades explode
    for (let i = grenades.length - 1; i >= 0; i--) {
      const g = grenades[i];
      if (g.t !== t) continue;
      grenades.splice(i, 1);
      notes.push({ tick: t, kind: 'boom', a: g.by.id, p: { x: g.x, y: g.y, z: g.z } });
      for (const v of acts) {
        if (!v.alive || !v.born || v.gone || v.team === g.by.team) continue;
        const dd = d2(v.x, v.z, g.x, g.z);
        if (dd < 3.2 * s + 0.3) { v.hp -= dd < 1.5 ? 90 : 45; if (v.hp <= 0) die(v, g.by); else if (v.mode === 'cover') { const c = pickCover(v, { x: v.x, z: v.z }); if (c >= 0) goToCover(v, c); } }
      }
    }
    for (const a of acts) {
      if (!a.born || a.gone) continue;
      if (!a.alive) {
        if (a.state >= S.DEATH_BACK && a.state <= S.DEATH_SPIN && t - a.stSince >= DEATH_TICKS[a.state]) setState(a, S.DEAD);
        continue;
      }
      if (fightOver < 0 && (a.mode === 'cover')) thinkCover(a);
      else if (fightOver >= 0 && a.mode !== 'move' && a.mode !== 'patrol' && a.mode !== 'fading') {
        if (a.task === null && a.timer > 0 && a.tasks.length) { a.timer--; continue; }
        thinkTask(a);
      }
    }
    // movement
    for (const a of acts) {
      if (!a.born || a.gone || (a.mode !== 'move' && a.mode !== 'patrol' && a.mode !== 'fading')) continue;
      if (a.mode === 'fading') { if (t - a.fadeStart >= 10) { a.gone = true; a.mode = 'gone'; setState(a, S.HIDDEN); } continue; }
      if (a.mode === 'patrol') continue;
      if (a.busy > t) continue;
      let rem = a.speed * TICK;
      while (rem > 1e-6 && a.pi < a.path.length) {
        const p = a.path[a.pi];
        const dx = p.x - a.x, dz = p.z - a.z, dy = p.y - a.y, l = Math.hypot(dx, dz);
        if (l <= rem) { a.x = p.x; a.z = p.z; a.y = p.y; a.dist += l; rem -= l; a.pi++; continue; }
        const k = rem / l;
        a.x += dx * k; a.z += dz * k; a.y += dy * k; a.dist += rem; rem = 0;
        const want = Math.atan2(dx, dz) + (a.back ? Math.PI : 0);
        a.yaw += Math.max(-0.9, Math.min(0.9, angTo(a.yaw, want)));
      }
      setState(a, a.moveState);
      if (a.pi >= a.path.length) { const f = a.arrive; a.arrive = null; a.mode = 'cover'; if (f) f(); }
    }
    // dragged corpses follow the dragger (head towards them, 1 m in front of their feet)
    for (const a of acts) {
      const b = a.dragging;
      if (!b || a.gone) continue;
      const fx = Math.sin(a.yaw), fz = Math.cos(a.yaw);
      const nx = a.x + fx * 1.0 * s, nz = a.z + fz * 1.0 * s;
      b.dist += Math.hypot(nx - b.x, nz - b.z);
      b.x = nx; b.z = nz; b.y = a.y; b.yaw = a.yaw + Math.PI;
    }
    // aim pitch towards the target
    for (const a of acts) {
      if (a.target && a.alive && (a.state === S.AIM || a.state === S.AIM_CROUCH || a.state === S.PEEK_L || a.state === S.PEEK_R)) {
        const dd = d2(a.x, a.z, a.target.x, a.target.z) || 1;
        a.aimPitch = Math.atan2(a.target.y - a.y + (a.target.state === S.CROUCH_IDLE || a.target.state === S.AIM_CROUCH ? -0.4 : 0), dd);
      } else a.aimPitch *= 0.7;
    }
    // fight over? (one side dead / fled, someone died)
    if (fightOver < 0) {
      const spawnedAll = acts.every((x) => x.born || (PT && x.team === 0)) && (!PT || PT.ambush);
      const aliveA = alliesAlive(0).filter((x) => x.born), aliveB = alliesAlive(1).filter((x) => x.born);
      // a lone badly hurt survivor sometimes runs for it
      for (const side of [aliveA, aliveB]) {
        if (side.length === 1 && side[0].hp < 35 && side[0].mode === 'cover' && acts.some((x) => !x.alive) && rng.chance(0.02) && (side === aliveA ? aliveB : aliveA).length >= 2) {
          const f = side[0]; f.fled = true; f.mode = 'task'; f.tasks = [{ k: 'fleeExit' }]; f.task = null; startTask(f);
          notes.push({ tick: t, kind: 'flee', a: f.id });
        }
      }
      const deaths = acts.some((x) => !x.alive);
      if (spawnedAll && (aliveA.length === 0 || aliveB.length === 0) && (deaths || acts.some((x) => x.fled))) { fightOver = t; afterFight(); }
    }
    if (PT && !PT.ambush && end < 0 && acts.every((x) => x.born && x.gone)) end = t + 2;
    // everything alive has left → fade the leftover bodies
    if (fightOver >= 0 && end < 0 && acts.every((x) => !x.alive || x.gone || x.fled && x.gone)) {
      const left = acts.filter((x) => !x.alive && !x.gone && !x.draggedBy);
      for (const b of left) { setState(b, S.GC); b.mode = 'gone'; }
      end = t + 22;
    }
    // hard cap: fade everyone still here
    if (end < 0 && t >= maxT - 24) {
      for (const a of acts) if (a.born && !a.gone) { setState(a, S.GC); a.mode = 'gone'; a.dragging = null; }
      end = t + 22;
    }
    // record
    for (const a of acts) {
      const o2 = t * NF, d = a.data;
      const visible = a.born && !a.gone;
      if (a.state === S.GC) a.alpha = Math.max(0, 1 - (t - a.stSince) / 20);
      else if (a.mode === 'fading') a.alpha = Math.max(0, 1 - (t - a.fadeStart) / 10);
      else if (PT && a.team === 0 && a.bornT >= 0) a.alpha = Math.min(1, (t - a.bornT + 1) / 10);
      d[o2] = a.x; d[o2 + 1] = a.y; d[o2 + 2] = a.z; d[o2 + 3] = a.yaw;
      d[o2 + 4] = visible ? a.state : S.HIDDEN; d[o2 + 5] = t - a.stSince; d[o2 + 6] = a.aimPitch; d[o2 + 7] = a.dist; d[o2 + 8] = a.aux; d[o2 + 9] = a.alpha;
      if (a.state === S.GC && a.alpha <= 0) a.gone = true;
    }
    if (end >= 0 && t >= end) { t++; break; }
  }
  const ticks = Math.min(t, maxT);
  const out: Episode = {
    kind: o.kind ?? 'skirmish', seed: o.seed, ticks, shots, notes, teams: [fa, fb],
    actors: acts.map((a) => ({ id: a.id, team: a.team, faction: a.fac, unit: a.unit, weapon: a.weapon, data: a.data.subarray(0, ticks * NF) })),
    stats: { planMs: 0, deaths: acts.filter((a) => !a.alive).length, shots: shots.length, dragged: notes.filter((n) => n.kind === 'gc').length, looted: notes.filter((n) => n.kind === 'pickup' || n.kind === 'loot').length },
  };
  out.stats.planMs = planMs + (typeof performance !== 'undefined' ? performance.now() - t0 : 0);
  return out;
}

// ================================================================================================ Tagilla
export interface TagillaRoom {
  enter: P3; exit: P3; stand: P3; standYaw: number;
  /** Entry waypoints (EVENT_TAGILLA_ENTER extras.path); `kick` = the DOOR flies open when he reaches it. */
  path?: { p: P3; kick: boolean }[];
  /** Hero pose on the way in (EVENT_TAGILLA_ROAR). */
  roar?: { p: P3; yaw: number } | null;
  /** Optional routing through the nav graph (enter / exit far from the prop). */
  route?: (a: P3, b: P3) => P3[];
  scale: number;
}

/** The brute's visit: sprint in → turn → overhead smash (impact note) → taunt to the audience (+Z) → walk out. */
export function planTagilla(r: TagillaRoom, seed: number, prop: number, sign: Episode['sign']): Episode {
  const s = r.scale * 1.12;
  const maxT = 1500;
  const data = new Float32Array(maxT * NF);
  const notes: SimNote[] = [{ tick: 0, kind: 'spawn', a: 0 }];
  let x = r.enter.x, y = r.enter.y, z = r.enter.z, yaw = Math.atan2(r.stand.x - x, r.stand.z - z), dist = 0;
  let state: number = S.T_SPRINT, since = 0, t = 0;
  const rec = (st: number) => {
    if (st !== state) { state = st; since = 0; }
    const o = t * NF;
    data[o] = x; data[o + 1] = y; data[o + 2] = z; data[o + 3] = yaw; data[o + 4] = st; data[o + 5] = since; data[o + 6] = 0; data[o + 7] = dist; data[o + 8] = 0; data[o + 9] = 1;
    since++; t++;
  };
  const walk = (path: P3[], speed: number, st: number) => {
    let i = 0;
    while (i < path.length && t < maxT - 60) {
      let rem = speed * s * TICK;
      while (rem > 1e-6 && i < path.length) {
        const p = path[i], dx = p.x - x, dz = p.z - z, l = Math.hypot(dx, dz);
        if (l > 1e-4) yaw += Math.max(-0.7, Math.min(0.7, angTo(yaw, Math.atan2(dx, dz))));
        if (l <= rem) { x = p.x; z = p.z; y = p.y; dist += l; rem -= l; i++; continue; }
        const k = rem / l; x += dx * k; z += dz * k; y += (p.y - y) * k; dist += rem; rem = 0;
      }
      rec(st);
    }
  };
  // in: up the authored path (kicking the door), a hero-pose roar, then the sprint to the prop
  const way = r.path ?? [];
  for (const w of way) { walk([w.p], 4.1, S.T_SPRINT); if (w.kick) notes.push({ tick: t, kind: 'kick', a: 0 }); }
  if (r.roar) {
    walk([r.roar.p], 4.1, S.T_SPRINT);
    for (let k = 0; k < 3; k++) { yaw += angTo(yaw, r.roar.yaw) * 0.55; rec(S.T_IDLE); }
    for (let k = 0; k < 24; k++) { yaw += angTo(yaw, r.roar.yaw) * 0.3; rec(S.T_TAUNT); }
  }
  const from = r.roar ? r.roar.p : way.length ? way[way.length - 1].p : r.enter;
  const inPath = r.route ? r.route(from, r.stand) : [r.stand];
  walk(inPath, 4.1, S.T_SPRINT);
  for (let k = 0; k < 4; k++) { yaw += angTo(yaw, r.standYaw) * 0.5; rec(S.T_IDLE); }
  yaw = r.standYaw;
  const smashAt = t;
  for (let k = 0; k < 19; k++) rec(S.T_SMASH);
  notes.push({ tick: smashAt + 7, frac: 0.4, kind: 'smash', a: 0, n: prop });
  // taunt towards the audience side (room front = +Z)
  for (let k = 0; k < 5; k++) { yaw += angTo(yaw, 0.25) * 0.45; rec(S.T_IDLE); }
  for (let k = 0; k < 24; k++) { yaw += angTo(yaw, 0.25) * 0.2; rec(S.T_TAUNT); }
  // out: back the way he came when there is an authored path (stairwell + door), else straight / nav
  const outPath = way.length ? [...(r.roar ? [r.roar.p] : []), ...[...way].reverse().map((w) => w.p), r.exit] : r.route ? r.route(r.stand, r.exit) : [r.exit];
  walk(outPath, 1.15, S.T_WALK);
  notes.push({ tick: t, kind: 'gone', a: 0 });
  for (let k = 0; k < 2; k++) rec(S.HIDDEN);
  const ticks = t;
  return {
    kind: 'tagilla', seed, ticks, shots: [], notes, teams: ['boss'], prop, sign,
    actors: [{ id: 0, team: 0, faction: 'boss', unit: 'tagilla', weapon: 'sledge', data: data.subarray(0, ticks * NF) }],
    stats: { planMs: 0, deaths: 0, shots: 0, dragged: 0, looted: 0 },
  };
}
