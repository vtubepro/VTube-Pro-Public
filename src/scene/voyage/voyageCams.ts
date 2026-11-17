// Voyage cameras: the exterior program for PRESHOW / BRB / OUTRO (when the host's ambient cameras are on) and the
// Talk-only cutaways (battle open, the enemy's defeat, the treasure sortie) - art lane section 6:
//   CAM_EXT_CRANE  crane-shot   from the sand up to 22 m over the deck, 45 -> 35 mm
//   CAM_EXT_DOLLY  dolly-rotate 90 deg orbit pulling in 60 -> 35 m, 40 -> 50 mm
//   CAM_EXT_PUSH   slow-zoom    35 -> 65 mm onto the canopy (then the show opens on CAM_WIDE)
//   CAM_EXT_LOOP   perfect-loop linear 360 deg orbit, radius 55 m (24 s = whole gait cycles)
//   CAM_EXT_DRIVEBY             fixed in the WORLD ahead of the ship: it walks past the lens
//   CAM_EXT_BATTLE              opposite the danger side: warm ship in front, hazed enemy behind (5 s)
// Every pose is a pure function of (move, shot index, u, the voyage state) -> every OBS page cuts the same shot.
// Moves are authored in the ship's SMOOTHED frame (terrain height + slope, no gait bob): the ship heaves in the shot like a
// real walker; world-fixed cameras go through the full inverse body pose. Every pose is validated: above the sand
// (+1.2 m), outside the hull box (+1.5 m), never closer than 2.5 m to an effect.
import * as THREE from 'three';
import type { CamPose } from '../cameraRig.ts';
import { lookPose } from '../cameraRig.ts';
import { voyageHash, voyageRand } from '../../../shared/voyage.ts';

export type ExtMove = 'CRANE' | 'DOLLY' | 'PUSH' | 'LOOP' | 'DRIVEBY' | 'BATTLE' | 'DEFEAT' | 'SORTIE' | 'CITY' | 'STORM'
  // the Preshow exterior show (voyage.preshow): night cinematography under the show sky
  | 'RISE' | 'ORBIT' | 'TRACK' | 'HERO' | 'SKYWARD' | 'FLYBY' | 'FEET'
  // the director's moves (music-timed cuts): a high wide establishing track, low under the legs, the ship walking past
  // a burning wreck, and two performer shots on the deck (voyageDeckCam.ts: the horizon behind them)
  | 'ESTAB' | 'UNDER' | 'WRECK' | 'DECK' | 'PUSHIN'
  // a close HERO: low beside the walker looking up its searchlights and lasers into the show sky
  | 'LASERS'
  // the safe high view: a plan whose every candidate still meets the land falls back to it (never planned by name)
  | 'HOLD';
export const SHOW_MOVES: ExtMove[] = ['RISE', 'ORBIT', 'TRACK', 'HERO', 'SKYWARD', 'FLYBY', 'FEET'];
/** Every move the director may cut to (voyage.preshow.moves / voyage.broll.moves pick from these). */
export const DIRECTOR_MOVES: ExtMove[] = [...SHOW_MOVES, 'ESTAB', 'UNDER', 'WRECK', 'DECK', 'PUSHIN', 'LASERS'];
/** Composition rules for the ship shots (compose()): the walker's height as a share of the frame [min, max], placed on
 *  a third with room ahead of its bow, the horizon on a third (low lens: the lower third, looking slightly up). */
export const COMPOSE: Partial<Record<ExtMove, [number, number]>> = {
  ESTAB: [0.36, 0.46], TRACK: [0.42, 0.55], FLYBY: [0.32, 0.5], WRECK: [0.3, 0.46], CRANE: [0.3, 0.5], DOLLY: [0.32, 0.5],
  LASERS: [0.28, 0.4],
};
/** Moves that frame the show sky (its planets, beams and lasers): only while a show sky is up. */
export const SKY_MOVES: ExtMove[] = ['HERO', 'SKYWARD', 'LASERS'];
/** Moves that frame a performer (room frame, voyageDeckCam.ts) rather than the ship from outside. */
export const PERFORMER_MOVES: ExtMove[] = ['DECK', 'PUSHIN'];
export type MusicSection = 'groove' | 'breakdown' | 'build' | 'drop';
/** Bars per shot by the music's section: fast cuts on a drop / build, long ones in a breakdown (the slow orbit). */
export const DIRECTOR_BARS: Record<MusicSection, number> = { drop: 2, build: 2, groove: 4, breakdown: 8 };
/** What the director cuts to, by section (in order of preference; the bar hash picks, never the same move twice running). */
export const DIRECTOR_LISTS: Record<MusicSection, ExtMove[]> = {
  breakdown: ['ORBIT', 'HERO', 'ESTAB', 'SKYWARD', 'LASERS'],
  groove: ['TRACK', 'ESTAB', 'DECK', 'UNDER', 'WRECK', 'RISE', 'FLYBY', 'FEET'],
  build: ['UNDER', 'FEET', 'PUSHIN', 'TRACK'],
  drop: ['DECK', 'FLYBY', 'UNDER', 'LASERS', 'TRACK', 'ESTAB'],
};
/** Show b-roll (voyage.broll): short exterior cutaways while the performer is quiet. */
export const BROLL_MOVES: ExtMove[] = ['ESTAB', 'TRACK', 'UNDER', 'WRECK', 'FLYBY', 'FEET'];

/** The director's shot at a moment of the music: pure in (bar, beat, section, bpm) + the room's choices. */
export interface DirectorPick { move: ExtMove; u: number; cutBar: number; bars: number; secs: number; seed: number; key: string; section: MusicSection }
export interface DirectorIn { bar: number; beat: number; bpm: number; section: MusicSection }
export interface DirectorOpts {
  /** the room's move list (empty = the section lists) */ moves?: ExtMove[];
  /** share of shots that frame a performer (0..1) */ performer?: number;
  /** a performer is on the deck (else performer moves are skipped) */ hasPerformer?: boolean;
  /** a burning wreck is near (else WRECK is skipped) */ hasWreck?: boolean;
  /** a show sky is up (else the sky shots - HERO, SKYWARD, LASERS - are skipped: by day they frame an empty sky) */ hasSky?: boolean;
  /** bars per section override */ bars?: Partial<Record<MusicSection, number>>;
  /** hash salt (the b-roll uses its own) */ salt?: string;
}
export function directorPick(m: DirectorIn, o: DirectorOpts = {}): DirectorPick {
  const sec: MusicSection = (DIRECTOR_BARS as Record<string, number>)[m.section] ? m.section : 'groove';
  const bars = Math.max(1, Math.round(o.bars?.[sec] ?? DIRECTOR_BARS[sec]));
  const cutBar = Math.floor(m.bar / bars) * bars;
  const ok = (mv: ExtMove) => (!PERFORMER_MOVES.includes(mv) || !!o.hasPerformer) && (mv !== 'WRECK' || !!o.hasWreck) && (o.hasSky !== false || !SKY_MOVES.includes(mv));
  const base = (o.moves && o.moves.length ? o.moves : DIRECTOR_LISTS[sec]).filter(ok);
  const list = base.length ? base : ['TRACK' as ExtMove];
  const salt = o.salt ?? 'dir';
  // shot k (in this section's shot length): a class draw (performer / exterior, the room's share), then the class's
  // moves in a shuffled order per block, so consecutive shots never repeat a move (pure in k: no history needed)
  const perf = list.filter((x) => PERFORMER_MOVES.includes(x)), ext = list.filter((x) => !PERFORMER_MOVES.includes(x));
  const share = Math.max(0, Math.min(1, o.performer ?? 0.3));
  const k = Math.floor(cutBar / bars);
  const perfAt = (kk: number) => perf.length > 0 && (!ext.length || voyageRand(voyageHash(salt, 'cls', kk), 1) < share);
  const perm = (arr: ExtMove[], cls: string, block: number) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(voyageRand(voyageHash(salt, cls, block), i) * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  const inClass = (arr: ExtMove[], cls: string, kk: number): ExtMove => {
    const L = arr.length, b = Math.floor(kk / L), i = kk - b * L;
    const p = perm(arr, cls, b);
    if (L > 1 && p[0] === perm(arr, cls, b - 1)[L - 1]) [p[0], p[1]] = [p[1], p[0]];   // (the block's first never repeats the last block's last)
    return p[i];
  };
  // (a performer shot right after a performer shot needs a second performer move, else the exterior takes it)
  let usePerf = perfAt(k);
  if (usePerf && perf.length === 1 && perfAt(k - 1) && ext.length) usePerf = false;
  const move = usePerf ? inClass(perf, 'p', k) : inClass(ext, 'e', k);
  const u = Math.max(0, Math.min(1, (m.beat - cutBar * 4) / (bars * 4)));
  const seed = voyageHash(salt, 'seed', cutBar);
  // (the shot's length is in its key: a section change that keeps the cut bar and the move but changes the bar count
  // is a new shot - a cut on the bar line - never the same shot jumping to another u mid-move)
  return { move, u, cutBar, bars, secs: (bars * 4 * 60) / Math.max(30, m.bpm), seed, key: `voyage:${salt}:${cutBar}:${bars}:${move}`, section: sec };
}
/** The director's next shot (to plan ahead): the pick on the bar line after this shot - with the music's section there
 *  when it is known (`sectionAt`: the auto groove is a pure clock; a live beat feed's next section is a guess) - and the
 *  time from now to that shot's own start (ms; its cut bar can lie before the bar line when a section change re-cuts).
 *  Only a guess about the music, never about what airs: a shot whose plan is not ready when it starts is planned in full
 *  on that frame. */
export function directorNext(pk: DirectorPick, m: DirectorIn, o: DirectorOpts = {}, sectionAt?: (bar: number) => MusicSection): { pick: DirectorPick; inMs: number }[] {
  const bpm = Math.max(30, m.bpm), out: { pick: DirectorPick; inMs: number }[] = [];
  // (the shot after this one, and every pick a section change can re-cut to over the next two bar lines)
  for (const bar of [pk.cutBar + pk.bars, m.bar + 1, m.bar + 2]) {
    const pick = directorPick({ bar, beat: bar * 4, bpm, section: sectionAt ? sectionAt(bar) : m.section }, o);
    if (pick.key !== pk.key && !out.some((x) => x.pick.key === pick.key)) out.push({ pick, inMs: ((pick.cutBar * 4 - m.beat) * 60000) / bpm });
  }
  return out;
}
export const EXT_PROGRAM: Record<'preshow' | 'brb' | 'outro', ExtMove[]> = {
  preshow: ['PUSH', 'CRANE', 'DOLLY', 'LOOP'],
  brb: ['LOOP', 'DRIVEBY', 'DOLLY', 'CRANE'],
  outro: ['CRANE', 'DOLLY', 'LOOP'],
};

const mmFov = (mm: number) => THREE.MathUtils.radToDeg(2 * Math.atan(12 / mm));
const ease = (u: number) => { const c = Math.min(1, Math.max(0, u)); return c * c * (3 - 2 * c); };
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export interface CamCtx {
  /** smoothed ship frame -> ship frame (the gait bob / sway inverted) */ smoothToShip: THREE.Matrix4;
  /** world route coords -> ship frame (full body pose) */ toShip(s: number, d: number, h: number, out: THREE.Vector3): THREE.Vector3;
  toWorld(p: THREE.Vector3): { s: number; d: number; h: number };
  heightAt(s: number, d: number): number;
  /** ship frame -> three world (the room root) */ shipToThree: THREE.Matrix4;
  /** hull box (ship frame) */ hull: THREE.Box3;
  /** danger side: -1 port, +1 starboard */ side: number;
  S: number;
  /** distance walked at an earlier wall time (world-fixed shots anchor at their start) */ distanceAt(ms: number): number;
  /** room overrides: CAM_EXT_* {from, to, target, lens, dur, radius, height, pos} */ tune: Record<string, Record<string, unknown>>;
  /** the show sky's hero body (ship frame, unit): the show's wide shots frame the ship under it */ hero?: THREE.Vector3 | null;
  /** the burning wreck the ship passes (ship frame, its fire), for WRECK shots; null = none near */ wreck?: THREE.Vector3 | null;
  /** the room's own geometry: true = nothing of the (static) ship between a and b (ship frame) - UNDER picks a clear line */
  roomClear?: (a: THREE.Vector3, b: THREE.Vector3) => boolean;
  /** The shot planner's world (the desert; absent = per-frame checks only). Every function is pure in its arguments, so a
   *  plan comes out the same on every page whenever it is made:
   *  - smoothAt(ms, out): the smoothed ship frame -> the world provider's local frame at show time ms (the kneel)
   *  - planBase: the desert wrap the ship is in now; baseOf(S): the wrap of distance S
   *  - worldAt / rootAt: provider-local <-> WORLD (x, height, z) with the ship at distance S, in wrap `base`
   *  - groundW(x, z): the sand's height at WORLD (x, z); routeWorld: route coords -> WORLD
   *  - wreckWorldAt(S, base): the burning wreck a WRECK / ESTAB shot frames when the ship is at S (WORLD), or null
   *  - solidsIn(box): the solid things on the sand over a WORLD box (the same set on every page) as a segment / point
   *    (a = b) test with a pad; null = no set for that box (a non-finite or oversized box: not plannable)
   *  - solidsReady(S0, S1): the layers this page has placed cover the shot's stretch (false on a page's first frame, a seek) */
  smoothAt?(ms: number, out: THREE.Matrix4): THREE.Matrix4;
  planBase?: number;
  baseOf?(S: number): number;
  worldAt?(q: THREE.Vector3, S: number, out: THREE.Vector3, base: number): THREE.Vector3;
  rootAt?(w: THREE.Vector3, S: number, out: THREE.Vector3, base: number): THREE.Vector3;
  groundW?(x: number, z: number): number;
  routeWorld?(s: number, d: number, h: number, base: number, out: THREE.Vector3): THREE.Vector3;
  wreckWorldAt?(S: number, base: number): THREE.Vector3 | null;
  solidsIn?(x0: number, z0: number, x1: number, z1: number): { hit(a: THREE.Vector3, b: THREE.Vector3, pad: number): boolean } | null;
  solidsReady?(S0: number, S1: number): boolean;
  /** the bow's yaw in the ship frame (rad from -Z towards +X; ShipRig.bowYaw). The show moves are authored with the bow
   *  at -Z and turned by it, so a ship modelled facing +X is filmed bow-first too. */
  bowYaw?: number;
  /** the feet's fore-most and aft-most z at rest (bow frame): UNDER rides between them */
  legZ?: [number, number];
}
const UPV = new THREE.Vector3(0, 1, 0);
/** bow frame (bow = -Z) -> ship frame */
const fromBow = (v: THREE.Vector3, b: number) => (b ? v.applyAxisAngle(UPV, -b) : v);
/** the ship's hull box seen in the bow frame (its 8 corners turned) */
function bowBox(box: THREE.Box3, b: number): THREE.Box3 {
  if (!b) return box;
  const out = new THREE.Box3();
  for (let i = 0; i < 8; i++) out.expandByPoint(new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyAxisAngle(UPV, b));
  return out;
}

export interface ExtShot { key: string; pose: CamPose; secs: number; move: ExtMove }

/** A shot's plan (VoyageCams.planFor): the move + variant used (or the safe high view), ONE composition back-off, the lift
 *  the lens needs at each sample (lifted through a smooth envelope that never moves faster than PLAN_RATE m/s, so never a
 *  pop; `rate` = PLAN_RATE x the shot's length = metres per unit of u), the composition's fixed side, and how many sampled
 *  points still meet something (0 = clean; only a clean plan goes on air). */
export interface ShotPlan { move: ExtMove; seed: number; scale: number; need: Float32Array; rate: number; fix: { lead: number; low: boolean }; bad: number; maxLift: number; tried: string[]; start: number; dur: number; wreckW: THREE.Vector3 | null; base: number; safe: boolean }
/** the fewest samples per shot (more on a long path: <= ~6 m apart); the lens over the sand (m); the fastest the lift
 *  changes (m/s: a true bound on the envelope's slope) */
export const PLAN_K = 24, PLAN_CLEAR = 1.4, PLAN_RATE = 4;
/** moves that stay low by design: lifted more than 12 m they are another shot (the next variant / move is tried) */
const LOW_MOVES: ExtMove[] = ['TRACK', 'FEET', 'LASERS', 'SKYWARD', 'ESTAB', 'WRECK', 'UNDER', 'BATTLE', 'DEFEAT', 'CITY', 'STORM', 'SORTIE'];
/** the event cutaways (their framing follows the event: never swapped for another move) */
const CUT_MOVES: ExtMove[] = ['BATTLE', 'DEFEAT', 'SORTIE', 'CITY', 'STORM'];
/** a shot whose every variant meets the land tries these (high moves clear anything) */
const PLAN_FALLBACK: ExtMove[] = ['ORBIT', 'RISE', 'FLYBY', 'CRANE', 'HERO'];
/** The walker's points a shot keeps in sight (ship frame): its middle, deck top, bow and stern - taken in the bow frame
 *  (the hull box turned onto the bow) and turned back, so a ship modelled facing +X has its bow where its bow is. */
export function sightPoints(b: THREE.Box3, bw: number): THREE.Vector3[] {
  const B = bowBox(b, bw), cx = (B.min.x + B.max.x) / 2, cz = (B.min.z + B.max.z) / 2, my = (B.min.y + B.max.y) / 2 + 2;
  return [V(cx, (B.min.y + B.max.y) / 2, cz), V(cx, B.max.y - 1, cz), V(cx, my, B.min.z + 3), V(cx, my, B.max.z - 3)].map((p) => fromBow(p, bw));
}
/** DRIVEBY's lens in route coords: 70 m ahead of where the ship was when the shot began, on the safe side, head height. */
function drivebyRoute(c: CamCtx, startMs: number): { s: number; d: number; h: number } {
  const T = c.tune.CAM_EXT_DRIVEBY ?? c.tune.EXT_DRIVEBY ?? c.tune.EXTCAM_DRIVEBY ?? {};
  const s = c.distanceAt(startMs) + numOr(T.ahead, 70), d = -c.side * numOr(T.off, 26);
  return { s, d, h: c.heightAt(s, d) + 1.7 };
}
/** ... and in the WORLD (pure) */
function drivebyWorld(c: CamCtx, startMs: number, base: number, out: THREE.Vector3): THREE.Vector3 {
  const r = drivebyRoute(c, startMs);
  return c.routeWorld!(r.s, r.d, r.h, base, out);
}
/** Moves that pass the walker: their composition back-off widens the pass, it never lengthens the run. */
const SIDEWAYS: ExtMove[] = ['TRACK', 'FLYBY', 'LASERS'];
/** A shot's composition back-off (ShotPlan.scale) applied to a lens position (ship frame): out from the hull centre,
 *  sideways only for the passing moves. */
function backOff(p: THREE.Vector3, c: CamCtx, move: ExtMove, k: number) {
  if (!(k > 1)) return;
  const C = c.hull.getCenter(new THREE.Vector3());
  if (!SIDEWAYS.includes(move)) { p.x = C.x + (p.x - C.x) * k; p.z = C.z + (p.z - C.z) * k; return; }
  const b = c.bowYaw ?? 0, q = p.clone().sub(C).applyAxisAngle(UPV, b);
  q.x *= k;
  p.copy(q.applyAxisAngle(UPV, -b).add(C));
}
/** The lift envelope at u: every sample's need held for one sample either side, then eased off on a half cosine whose
 *  steepest slope is the plan's rate (n * pi / 2 over the width w = n * pi / (2 * rate)): never faster than PLAN_RATE m/s. */
export function liftAt(pl: { need: Float32Array; rate: number }, u: number): number {
  const K = pl.need.length - 1;
  let L = 0;
  for (let k = 0; k <= K; k++) {
    const n = pl.need[k];
    if (n <= L) continue;
    const x = Math.abs(u - k / K) - 1 / K;
    if (x <= 0) { L = n; continue; }
    const w = (n * Math.PI) / (2 * pl.rate);
    if (x >= w) continue;
    L = Math.max(L, n * (0.5 + 0.5 * Math.cos((Math.PI * x) / w)));
  }
  return L;
}

const arr3 = (v: unknown, d: THREE.Vector3) => (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? V(v[0], v[1], v[2]) : d);
const numOr = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// clearView scratch (runs on every pose)
const CV_D = new THREE.Vector3(), CV_T = new THREE.Vector3(), CV_Q = new THREE.Vector3();
export class VoyageCams {
  /** shots validated this frame (debug) */ last: { move: ExtMove; fixed: string[]; plan?: { move: ExtMove; seed: number; scale: number; lift: number; bad: number; tried: string[] } } | null = null;

  /** The program shot for a lighting state: shot k = floor(elapsed / cycle) since the ambient clock's `at`. */
  program(state: 'preshow' | 'brb' | 'outro', now: number, at: number, cycle: number, c: CamCtx): ExtShot {
    const list = EXT_PROGRAM[state];
    const el = Math.max(0, now - (at || 0)) / 1000;
    const k = Math.floor(el / cycle);
    const u = (el - k * cycle) / cycle;
    const move = list[k % list.length];
    const seed = voyageHash(state, k);
    const startMs = now - u * cycle * 1000;
    const pose = this.pose(move, u, seed, c, null, startMs, cycle);
    this.prefetch(list[(k + 1) % list.length], voyageHash(state, k + 1), c, startMs + cycle * 1000, cycle);
    return { key: `voyage:${state}:${k}:${move}`, pose, secs: 0, move };
  }

  /** The Preshow exterior show: shot k = floor(elapsed / cycle) of `moves`, sides alternating (pure in the clock). */
  show(now: number, at: number, cycle: number, moves: ExtMove[], c: CamCtx): ExtShot {
    const list = moves.length ? moves : SHOW_MOVES;
    const el = Math.max(0, now - (at || 0)) / 1000;
    const k = Math.floor(el / cycle);
    const u = (el - k * cycle) / cycle;
    const move = list[((k % list.length) + list.length) % list.length];
    const pose = this.pose(move, u, voyageHash('show', k), c, null, now - u * cycle * 1000, cycle);
    // (the next shot is known: plan it ahead, a few ms a frame)
    this.prefetch(list[(((k + 1) % list.length) + list.length) % list.length], voyageHash('show', k + 1), c, now + (1 - u) * cycle * 1000, cycle);
    return { key: `voyage:show:${k}:${move}`, pose, secs: 0, move };
  }

  /** A cutaway (battle / defeat / sortie) between from..to (ms). */
  cut(kind: 'battle' | 'defeat' | 'sortie' | 'city' | 'storm', key: string, now: number, from: number, to: number, focusShip: THREE.Vector3, c: CamCtx): ExtShot {
    const u = (now - from) / Math.max(1, to - from);
    const move: ExtMove = kind === 'battle' ? 'BATTLE' : kind === 'defeat' ? 'DEFEAT' : kind === 'sortie' ? 'SORTIE' : kind === 'city' ? 'CITY' : 'STORM';
    return { key: `voyage:cut:${key}`, pose: this.pose(move, u, voyageHash(key), c, focusShip, from, (to - from) / 1000), secs: 0, move };
  }

  /** The move as authored at u (0..1): lens + target in the smoothed ship frame (smooth) or the ship frame. */
  private raw(move: ExtMove, u: number, seed: number, c: CamCtx, focus: THREE.Vector3 | null, startMs: number, durS: number): { pos: THREE.Vector3; tgt: THREE.Vector3; mm: number; smooth: boolean; under: boolean } {
    const T = c.tune[`CAM_EXT_${move}`] ?? c.tune[`EXT_${move}`] ?? c.tune[`EXTCAM_${move}`] ?? {};
    let pos: THREE.Vector3 = new THREE.Vector3(), tgt: THREE.Vector3 = new THREE.Vector3(), mm = 35;
    let smoothFrame = true;
    const side = c.side;
    switch (move) {
      case 'HOLD': {
        // high over anything near the walker, 60 m out on one of 8 bearings (seed 0..7), the whole walker in frame
        const bb = bowBox(c.hull, c.bowYaw ?? 0), L = Math.max(0.4, Math.min(4, (bb.max.z - bb.min.z) / 38));
        const a = ((seed % 8) / 8) * Math.PI * 2 + 0.35;
        pos = fromBow(V(Math.sin(a) * 62 * L, bb.max.y + 30 * L, Math.cos(a) * 62 * L), c.bowYaw ?? 0);
        tgt = c.hull.getCenter(new THREE.Vector3()); mm = 26;
        break;
      }
      case 'CRANE': {
        const e = ease(u);
        const a = arr3(T.from, V(-30, -11.2, -25)), b = arr3(T.to, V(-38, 22, 10));
        const flip = voyageRand(seed, 1) < 0.5 ? 1 : -1;
        a.x *= flip; b.x *= flip;
        pos = a.lerp(b, e); tgt = arr3(T.target, V(0, 1, 0)); mm = 45 + (35 - 45) * e;
        break;
      }
      case 'DOLLY': {
        const e = ease(u);
        const a0 = (voyageRand(seed, 2) * 2 - 1) * Math.PI;
        const ang = a0 + (Math.PI / 2) * e * (voyageRand(seed, 3) < 0.5 ? 1 : -1);
        const dist = numOr(T.from, 60) + (numOr(T.to, 35) - numOr(T.from, 60)) * e;
        const h = 8 + (4 - 8) * e;
        pos = V(Math.sin(ang) * dist, h, Math.cos(ang) * dist); tgt = arr3(T.target, V(0, 1, 0)); mm = 40 + 10 * e;
        break;
      }
      case 'PUSH': {
        const e = ease(u);
        const a = arr3(T.from, V(-60, 8, -110)), b = arr3(T.to, V(-18, 3, -40));
        pos = a.lerp(b, e); tgt = arr3(T.target, V(0, 1.2, 0)); mm = 35 + 30 * e;
        break;
      }
      case 'LOOP': {
        const R = numOr(T.radius, 55), h = numOr(T.height, 6);
        const ang = (voyageRand(seed, 4) * 2 - 1) * Math.PI + u * Math.PI * 2;      // linear: a perfect loop over the shot
        pos = V(Math.sin(ang) * R, h, Math.cos(ang) * R); tgt = V(0, -1, 0); mm = numOr(T.lens, 40);
        break;
      }
      case 'DRIVEBY': {
        // fixed in the world, 70 m ahead of where the ship was when the shot began, on the safe side, at head height
        smoothFrame = false;
        const d = drivebyRoute(c, startMs);
        pos = c.toShip(d.s, d.d, d.h, new THREE.Vector3());
        tgt = V(0, -3, 0); mm = numOr(T.lens, 35);
        break;
      }
      case 'BATTLE': {
        const f = focus ?? V(side * 100, -8, 0);
        const e = ease(u);
        pos = V(-side * (58 + 6 * e), -8.5 + 2 * e, 30 - 6 * e);
        tgt = V(0, -4, 0).lerp(this.toSmooth(f, c), 0.38); mm = 26;
        break;
      }
      case 'DEFEAT': {
        const f = focus ?? V(side * 100, -8, 0);
        const fs = this.toSmooth(f, c);
        const e = ease(u);
        pos = V(side * 22, -6.5 + 3 * e, 40 - 6 * e);
        tgt = fs.clone().add(V(0, 8, 0)); mm = 38;
        break;
      }
      case 'CITY': {
        // city reveal: low on the far side of the ship, the walker in front, the city across the sand behind it
        const f = this.toSmooth(focus ?? V(300, -10, -40), c);
        const away = Math.sign(f.x) || 1, e = ease(u);
        pos = V(-away * (34 + 4 * e), -9.5 + 2 * e, 18 - 10 * e);
        tgt = V(0, -3, 0).lerp(f, 0.3); mm = 30;
        break;
      }
      case 'STORM': {
        // the haboob wall: from the lee side, the ship small against the rolling dust
        const f = this.toSmooth(focus ?? V(-600, 60, -100), c);
        const toward = Math.sign(f.x) || -1, e = ease(u);
        pos = V(-toward * (46 + 6 * e), -8, 34 - 8 * e);
        tgt = V(0, 2, 0).lerp(f, 0.12); mm = 24;
        break;
      }
      case 'SORTIE': {
        const f = focus ?? V(side * 24, -12.7, -4);
        const fs = this.toSmooth(f, c);
        const out = Math.sign(fs.x) || 1;
        const e = ease(u);
        pos = fs.clone().add(V(out * (9 + 3 * e), 1.9, 13 - 2 * e));
        tgt = fs.clone().lerp(V(0, -4, 0), 0.35).add(V(0, 1, 0)); mm = 30;
        break;
      }
    }
    void durS;
    // the show moves (ship-frame numbers for a ~38 m walker, scaled by the hull's length)
    let under = false;
    if (SHOW_MOVES.includes(move) || move === 'ESTAB' || move === 'UNDER' || move === 'WRECK' || move === 'LASERS') {
      const r = this.showPose(move, u, seed, c, startMs);
      // (authored in the bow frame: turned onto the ship's own bow)
      pos = fromBow(r.pos, c.bowYaw ?? 0); tgt = fromBow(r.tgt, c.bowYaw ?? 0); mm = r.mm; smoothFrame = r.smooth; under = move === 'UNDER';
    }
    return { pos, tgt, mm, smooth: smoothFrame, under };
  }

  /** pose of a move at u (0..1). Positions in the smoothed ship frame unless world-fixed.
   *  With a world that can be asked ahead (CamCtx.worldAt: the desert), the whole shot is PLANNED once, at its first
   *  frame, from pure inputs (planFor): the lens path is checked against the sand, the walker's line of sight and the
   *  solid things on the sand at 24 points while the ship walks on, and gets one smooth lift envelope (never a pop);
   *  a path that cannot be cleared tries the other side / variants, then another move. Every frame is then checked
   *  again exactly (a safety net that should never have to act). Without such a world: the per-frame checks only. */
  pose(move: ExtMove, u: number, seed: number, c: CamCtx, focus: THREE.Vector3 | null, startMs: number, durS: number): CamPose {
    this.stale = false;
    if (c.worldAt && c.rootAt && c.groundW && c.smoothAt) return this.planned(move, u, seed, c, focus, startMs, durS);
    const r = this.raw(move, u, seed, c, focus, startMs, durS);
    const pos = r.pos, smoothFrame = r.smooth, under = r.under;
    let tgt = r.tgt, mm = r.mm;
    // into the current ship frame
    if (smoothFrame) { pos.applyMatrix4(c.smoothToShip); tgt.applyMatrix4(c.smoothToShip); }
    const fixed = this.validate(pos, c, under);
    // (a dune between the lens and the ship: rise until the view clears it - the shot keeps its aim)
    // (the lift can carry a low lens up through an overhanging bow: back out of the hull before composing)
    if (!under && this.clearView(pos, tgt, c)) fixed.push('view', ...this.validate(pos, c));
    // composition: the walker sized and placed on a third, the horizon on a third (COMPOSE)
    const rule = COMPOSE[move];
    if (rule) {
      const p0 = pos.clone();
      let k = this.compose(pos, c, rule, move === 'WRECK' ? c.wreck ?? null : null);
      // (backed off: back on the sand, then aimed again from there)
      if (pos.distanceToSquared(p0) > 1e-6) { fixed.push('backed-off', ...this.validate(pos, c)); k = this.compose(pos, c, rule, move === 'WRECK' ? c.wreck ?? null : null, 16 / 9, 2); }
      tgt = k.tgt; mm = k.mm; fixed.push('composed');
    }
    this.last = { move, fixed };
    // ship frame -> three world
    pos.applyMatrix4(c.shipToThree); tgt.applyMatrix4(c.shipToThree);
    return lookPose(pos, tgt, mmFov(mm));
  }

  // ---------------------------------------------------------------------------------------------- the shot plan
  private plans = new Map<string, ShotPlan[]>();
  /** plans made ahead (prefetch: the director's / the show's next shot, a few ms per frame while this one runs) */
  private jobs = new Map<string, { it: Generator<void, ShotPlan, void>; start: number; dur: number }>();
  /** true when this frame's shot cannot go on air planned (nothing clean, the world not placed for it yet, a wrap in the
   *  shot): the caller keeps its own camera (the deck cameras). Pure in the show time on every page. */
  stale = false;
  /** how long one frame may spend planning AHEAD (ms; a prefetch never changes what airs, only when the work is done) */
  planBudgetMs = 2;
  /** shots planned (tests / info): plans, variants / other moves taken, safe views, plans with nothing clean, frames the
   *  room kept its own camera, the per-frame net acting (stays 0: the plan cleared the path), the longest plan finished
   *  on the frame it aired (ms: a prefetch miss) and the longest prefetch slice (ms) */
  planStats = { plans: 0, alt: 0, moved: 0, safe: 0, dirty: 0, staleFrames: 0, net: 0, maxSyncMs: 0, maxSliceMs: 0 };
  /** the wreck a WRECK / ESTAB shot frames: the plan's own (pure in the shot's start), set while a raw pose is made */
  private wreckFix: THREE.Vector3 | null = null;
  private lastFixed: string[] = [];
  private lastPlan = { move: 'TRACK' as ExtMove, seed: 0, scale: 1, lift: 0, bad: 0, tried: [] as string[] };
  private tm = new THREE.Matrix4();

  /** A planned shot at u: the plan's move / variant, its back-off, the lift envelope, the composition's fixed side. The
   *  plan is always complete when it airs (made now if no prefetch made it): the pose is a pure function of the show
   *  time on every page, whatever its frame rate. Nothing clean (or not plannable now) = `stale`: the room's camera. */
  private planned(move: ExtMove, u: number, seed: number, c: CamCtx, focus: THREE.Vector3 | null, startMs: number, durS: number): CamPose {
    this.stale = false;
    const pl = this.planFor(move, seed, c, focus, startMs, durS, true);
    if (!pl || pl.bad > 0) {
      this.stale = true; this.planStats.staleFrames++;
      // (a pose is still returned - the caller drops it for its own camera)
      const r0 = this.raw('HOLD', 0, 0, c, null, startMs, durS);
      r0.pos.applyMatrix4(c.smoothToShip).applyMatrix4(c.shipToThree); r0.tgt.applyMatrix4(c.smoothToShip).applyMatrix4(c.shipToThree);
      return lookPose(r0.pos, r0.tgt, mmFov(r0.mm));
    }
    const ms = startMs + u * durS * 1000;
    this.wreckFix = pl.wreckW ? this.wreckAt(c, pl.wreckW, ms, pl.base, new THREE.Vector3()) : null;
    const r = this.raw(pl.move, u, pl.seed, c, focus, startMs, durS);
    const pos = r.pos;
    let tgt = r.tgt, mm = r.mm;
    backOff(pos, c, pl.move, pl.scale);
    const lift = liftAt(pl, u);
    pos.y += lift; tgt.y += lift * 0.5;
    if (r.smooth) { pos.applyMatrix4(c.smoothToShip); tgt.applyMatrix4(c.smoothToShip); }
    // (the safety net: the exact sand under the lens now. The plan cleared the whole path at <= 3 m spacing with the sand
    // within half a step round each sample, so this never acts; if it ever does it lifts - counted in planStats.net)
    const fixed = this.lastFixed;
    fixed.length = 0;
    if (this.netLift(pos, c)) { fixed.push('net'); this.planStats.net++; }
    if (pl.scale > 1) fixed.push('backed-off');
    if (lift > 0.01) fixed.push('lift');
    if (pl.safe) fixed.push('safe');
    const rule = COMPOSE[pl.move];
    if (rule) { const k = this.compose(pos, c, rule, pl.move === 'WRECK' ? this.wreckOf(c) : null, 16 / 9, 2, pl.fix); tgt = k.tgt; mm = k.mm; fixed.push('composed'); }
    this.wreckFix = null;
    const lp = this.lastPlan;
    lp.move = pl.move; lp.seed = pl.seed; lp.scale = +pl.scale.toFixed(2); lp.lift = +pl.maxLift.toFixed(1); lp.bad = pl.bad; lp.tried = pl.tried;
    this.last = this.last ?? { move: pl.move, fixed, plan: lp };
    this.last.move = pl.move; this.last.fixed = fixed; this.last.plan = lp;
    pos.applyMatrix4(c.shipToThree); tgt.applyMatrix4(c.shipToThree);
    return lookPose(pos, tgt, mmFov(mm));
  }

  /** Plan a shot that has not started yet (the director's / the show's next one), a few ms of it per frame. What airs
   *  never depends on it: a shot whose plan is not ready when it starts is planned in full on that frame. */
  prefetch(move: ExtMove, seed: number, c: CamCtx, startMs: number, durS: number) {
    if (!(c.worldAt && c.rootAt && c.groundW && c.smoothAt) || PERFORMER_MOVES.includes(move)) return;
    this.planFor(move, seed, c, null, startMs, durS, false);
  }

  /** a fresh page (tests): no plans, no plans in progress */
  resetPlans() { this.plans.clear(); this.jobs.clear(); this.stale = false; }
  /** the wreck WRECK / ESTAB frame: the plan's own while a planned shot is evaluated, else the context's */
  private wreckOf(c: CamCtx): THREE.Vector3 | null { return this.wreckFix ?? c.wreck ?? null; }
  /** a WORLD point (the plan's wreck) in the smoothed ship frame at show time ms: pure */
  private wreckAt(c: CamCtx, w: THREE.Vector3, ms: number, base: number, out: THREE.Vector3): THREE.Vector3 {
    c.rootAt!(w, c.distanceAt(ms), out, base);
    return out.applyMatrix4(c.smoothAt!(ms, this.tm).invert());
  }

  /** The per-frame safety net on a planned pose: the exact sand under the lens (ship frame) + 0.5 m, lifted straight up
   *  (never a sideways shove). true = it acted. */
  private netLift(p: THREE.Vector3, c: CamCtx): boolean {
    const w = c.toWorld(p);
    const g = c.heightAt(w.s, w.d) + 0.5;
    if (w.h >= g) return false;
    p.y += g - w.h;
    return true;
  }

  /** The plan of one shot: pure in (move, seed, start, length, the desert wrap) and the world's pure functions, so every
   *  page makes the same plan whenever it makes it. `sync` (the frame it airs): finished now; else (a prefetch) a few ms of
   *  work. null = not plannable now: the world has not placed its things for the shot's stretch yet (a page's first
   *  frame, a seek) or the shot runs over the desert's wrap. The asked-for move first, then its other variants (another
   *  side / start), then high moves, then the safe high views; a plan with anything left (bad > 0) never airs. Event
   *  cut-aways never turn into another move (their framing follows the event): only into the safe view. */
  private planFor(move: ExtMove, seed: number, c: CamCtx, focus: THREE.Vector3 | null, startMs: number, durS: number, sync: boolean): ShotPlan | null {
    const base = c.planBase ?? 0;
    const S0 = c.distanceAt(startMs), S1 = c.distanceAt(startMs + durS * 1000);
    if (c.baseOf && (c.baseOf(S0) !== base || c.baseOf(S1) !== base)) return null;
    // (a live beat clock nudges a shot's start / length by a few ms from frame to frame: the same shot keeps its plan)
    const key = `${move}|${seed}|${base}`;
    const near = (p: { start: number; dur: number }) => Math.abs(p.start - startMs) < 400 && Math.abs(p.dur - durS) <= 0.05 * Math.max(1, durS);
    const list = this.plans.get(key) ?? [];
    const hit = list.find(near);
    if (hit) return hit;
    let job = this.jobs.get(key);
    if (job && !near(job)) { this.jobs.delete(key); job = undefined; }
    if (!job) {
      if (c.solidsReady && !c.solidsReady(Math.min(S0, S1), Math.max(S0, S1))) return null;
      // (a snapshot of what the plan reads: the per-frame scratch of the scene's context never reaches it)
      const snap: CamCtx = { ...c, hull: c.hull.clone(), hero: c.hero ? c.hero.clone() : null, smoothToShip: c.smoothToShip.clone(), planBase: base };
      job = { it: this.planGen(move, seed, snap, focus, startMs, durS), start: startMs, dur: durS };
      if (this.jobs.size > 8) this.jobs.clear();
      this.jobs.set(key, job);
    }
    const t0 = performance.now();
    let r = job.it.next();
    while (!r.done && (sync || performance.now() - t0 < this.planBudgetMs)) r = job.it.next();
    const dt = performance.now() - t0;
    if (sync) this.planStats.maxSyncMs = Math.max(this.planStats.maxSyncMs, dt); else this.planStats.maxSliceMs = Math.max(this.planStats.maxSliceMs, dt);
    if (!r.done) return null;
    this.jobs.delete(key);
    const pl = r.value;
    pl.start = startMs; pl.dur = durS;
    this.planStats.plans++;
    if (pl.bad) this.planStats.dirty++; else if (pl.safe) this.planStats.safe++; else if (pl.move !== move) this.planStats.moved++; else if (pl.seed !== seed) this.planStats.alt++;
    if (this.plans.size > 48) this.plans.clear();
    this.plans.set(key, [...list.slice(-3), pl]);
    return pl;
  }

  /** The candidates of one shot in order, the first clean one wins (a generator: yields between slices of work). */
  private *planGen(move: ExtMove, seed: number, c: CamCtx, focus: THREE.Vector3 | null, startMs: number, durS: number): Generator<void, ShotPlan, void> {
    const tries: [ExtMove, number][] = [[move, seed]];
    if (!CUT_MOVES.includes(move)) {
      if (move !== 'DRIVEBY') for (let i = 1; i <= 3; i++) tries.push([move, voyageHash(seed, 'alt', i)]);
      const sky = !!(c.hero && c.hero.lengthSq() > 0.5);
      for (const m of PLAN_FALLBACK) if (m !== move && (sky || !SKY_MOVES.includes(m))) tries.push([m, voyageHash(seed, 'fb', m)]);
    }
    // the safe high views (8 bearings round the walker, high over anything near it) when nothing else cleared
    for (let i = 0; i < 8; i++) tries.push(['HOLD', (voyageHash(seed, 'hold') + i) % 8]);
    const tried: string[] = [];
    let best: ShotPlan | null = null;
    for (const [m, s] of tries) {
      const p = yield* this.tryPlan(m, s, c, focus, startMs, durS);
      tried.push(`${m}:${p.bad}`);
      if (!best || p.bad < best.bad) best = p;
      if (p.bad === 0) break;
    }
    const pl = best!;
    pl.safe = pl.move === 'HOLD';
    pl.tried = tried.length > 1 ? tried : [];
    return pl;
  }

  /** One candidate: the path sampled (24..64 points, at most ~6 m apart) while the ship walks on (its distance and kneel
   *  at each moment), judged in the world: the sand within half a step round each sample, the lines of sight from the lens
   *  to the walker's middle, deck top, bow and stern (each to where it meets the hull) over the sand, and the solid things
   *  on the sand (points <= 3 m apart with a 1.5 m pad, and every segment between them with the same pad); one back-off
   *  scale, one lift envelope, the hull. Every input is pure: the same candidate scores the same on every page. bad = how
   *  many samples still meet something (0 = clean). */
  private *tryPlan(move: ExtMove, seed: number, c: CamCtx, focus: THREE.Vector3 | null, startMs: number, durS: number): Generator<void, ShotPlan, void> {
    const under = move === 'UNDER', fixedWorld = move === 'DRIVEBY', base = c.planBase ?? 0;
    const b = c.hull, C = b.getCenter(new THREE.Vector3()), bw = c.bowYaw ?? 0;
    const msAt = (u: number) => startMs + u * durS * 1000;
    const Sk = (u: number) => c.distanceAt(msAt(u));
    // (the wreck a WRECK / ESTAB shot frames: the one near the ship at the shot's start, in the world - pure)
    const wreckW = (move === 'WRECK' || move === 'ESTAB') && c.wreckWorldAt ? c.wreckWorldAt(Sk(0), base) : null;
    const WK = new THREE.Vector3();
    const rawAt = (u: number) => {
      this.wreckFix = wreckW ? this.wreckAt(c, wreckW, msAt(u), base, WK) : null;
      const r = this.raw(move, u, seed, c, focus, startMs, durS);
      return r;
    };
    // the path at 24 points first (its length sets the sampling)
    let raws = Array.from({ length: 25 }, (_, k) => rawAt(k / 24));
    let len = 0;
    for (let k = 1; k <= 24; k++) len += raws[k].pos.distanceTo(raws[k - 1].pos);
    const rule = COMPOSE[move], side = SIDEWAYS.includes(move);
    // composition: ONE back-off for the shot (the walker never too big at any point of it); passing moves back off
    // sideways only (a radial back-off would stretch their run and whip the pan)
    let scale = 1;
    if (rule) for (let k = 0; k <= 24; k++) {
      if (k % 6 === 5) yield;
      const r = raws[k], p = r.pos.clone();
      this.wreckFix = wreckW ? this.wreckAt(c, wreckW, msAt(k / 24), base, WK) : null;
      this.compose(p, c, rule, move === 'WRECK' ? this.wreckOf(c) : null);
      const d0 = Math.hypot(r.pos.x - C.x, r.pos.z - C.z), d1 = Math.hypot(p.x - C.x, p.z - C.z);
      if (d0 < 1e-3 || d1 <= d0 + 1e-6) continue;
      if (!side) { scale = Math.max(scale, Math.min(4, d1 / d0)); continue; }
      const q = r.pos.clone().sub(C).applyAxisAngle(UPV, bw);               // (the bow frame: x = beam, z = along)
      if (Math.abs(q.x) > 1e-3) scale = Math.max(scale, Math.min(4, Math.sqrt(Math.max(0, d1 * d1 - q.z * q.z)) / Math.abs(q.x)));
    }
    len *= scale;
    const K = Math.max(PLAN_K, Math.min(64, Math.ceil(len / 6)));
    if (K !== 24) raws = Array.from({ length: K + 1 }, (_, k) => rawAt(k / K));
    for (const r of raws) backOff(r.pos, c, move, scale);
    yield;
    const mid = raws[K >> 1].pos;
    const flat = C.clone().sub(mid), yaw = Math.atan2(flat.x, -flat.z), rt = V(Math.cos(yaw), 0, Math.sin(yaw));
    let lead = -Math.sign(fromBow(V(0, 0, -1), bw).dot(rt)) || 1;
    const wkMid = wreckW && move === 'WRECK' ? this.wreckAt(c, wreckW, msAt(0.5), base, new THREE.Vector3()) : null;
    if (wkMid) lead = -Math.sign(wkMid.clone().sub(mid).dot(rt)) || lead;
    const fix = { lead, low: mid.y < (b.min.y + b.max.y) * 0.5 };
    const step = len / K, disc = Math.max(2.5, step / 2);
    const need = new Float32Array(K + 1);
    const W = new THREE.Vector3(), Q = new THREE.Vector3(), Sw = new THREE.Vector3(), P = new THREE.Vector3(), Wprev = new THREE.Vector3();
    const SM = new THREE.Matrix4();
    // (a world-fixed move - DRIVEBY - stands at one WORLD point, pure in the shot's start)
    const fixedW = fixedWorld ? drivebyWorld(c, startMs, base, new THREE.Vector3()) : null;
    // the lens in the WORLD at show time ms (lifted)
    const lensW = (r: { pos: THREE.Vector3 }, lift: number, u: number, out: THREE.Vector3) => {
      if (fixedW) return out.copy(fixedW).setY(fixedW.y + lift);
      c.worldAt!(Q.copy(r.pos).setY(r.pos.y + lift).applyMatrix4(c.smoothAt!(msAt(u), SM)), Sk(u), out, base);
      return out;
    };
    // the lens in the smoothed ship frame at show time ms (for the hull: the walker does not move in its own frame)
    const lensS = (r: { pos: THREE.Vector3 }, lift: number, u: number, out: THREE.Vector3) => {
      if (!fixedW) return out.copy(r.pos).setY(r.pos.y + lift);
      c.rootAt!(P.copy(fixedW).setY(fixedW.y + lift), Sk(u), out, base);
      return out.applyMatrix4(c.smoothAt!(msAt(u), SM).invert());
    };
    const sightW = (q: number, u: number, out: THREE.Vector3) => c.worldAt!(out.copy(sights[q]).applyMatrix4(c.smoothAt!(msAt(u), SM)), Sk(u), out, base);
    const sights = sightPoints(b, bw);
    // where a ray from the lens (ship frame) to a walker point meets the hull: the fraction of the way to stop at
    const RAY = new THREE.Ray(), HIT = new THREE.Vector3();
    const stopAt = (lens: THREE.Vector3, pt: THREE.Vector3) => {
      const L = lens.distanceTo(pt);
      if (L < 1e-3 || b.containsPoint(lens)) return 0;
      RAY.origin.copy(lens); RAY.direction.copy(pt).sub(lens).divideScalar(L);
      const h = RAY.intersectBox(b, HIT);
      const d = h ? lens.distanceTo(h) - 0.5 : L - 0.5;
      return Math.max(0, Math.min(0.97, d / L));
    };
    const SL = new THREE.Vector3();
    const needL = [0, 0, 0, 0];
    for (let k = 0; k <= K; k++) {
      const u = k / K;
      lensW(raws[k], 0, u, W);
      // the sand: the highest point within half a step round the lens (the frame's lower corners, the path between)
      let g = c.groundW!(W.x, W.z);
      for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; g = Math.max(g, c.groundW!(W.x + Math.cos(a) * disc, W.z + Math.sin(a) * disc)); }
      let n = g + PLAN_CLEAR - W.y;
      // the line of sight to the walker's middle, deck top, bow and stern: the land stays 0.6 m under each (up to the
      // hull); the middle's line, and the second-worst of the four, set the lift (the land may hide one end, never the walker)
      if (!under) {
        lensS(raws[k], 0, u, SL);
        for (let q = 0; q < 4; q++) {
          const tMax = stopAt(SL, sights[q]);
          sightW(q, u, Sw);
          const steps = Math.max(6, Math.min(24, Math.ceil(W.distanceTo(Sw) * tMax / 8)));
          let m = 0;
          for (let i = 1; i <= steps; i++) {
            const t = (i / steps) * tMax;
            P.copy(W).lerp(Sw, t);
            const h = c.groundW!(P.x, P.z) + 0.6 - P.y;
            if (h > 0) m = Math.max(m, h / (1 - t));
          }
          needL[q] = m;
        }
        const s4 = needL.slice().sort((x, y) => x - y);
        n = Math.max(n, needL[0], s4[2]);
      }
      need[k] = Math.max(0, n);
      if (k % 2 === 1) yield;
    }
    const pl: ShotPlan = { move, seed, scale, need, rate: PLAN_RATE * Math.max(0.5, durS), fix, bad: 0, maxLift: 0, tried: [], start: startMs, dur: durS, wreckW: wreckW ? wreckW.clone() : null, base, safe: false };
    fix.low = mid.y + liftAt(pl, 0.5) < (b.min.y + b.max.y) * 0.5;               // (the horizon's third from the lifted lens)
    // what the lifted path meets: the cap (a low move lifted out of its shot), the hull, the solid things (one set for
    // the whole path: the same on every page)
    const cap = under ? 0.9 : move === 'HOLD' ? 200 : LOW_MOVES.includes(move) ? 12 : 60;
    const hullBox = b.clone().expandByScalar(1.5);
    let solids: { hit(a: THREE.Vector3, b: THREE.Vector3, pad: number): boolean } | null = null;
    // (points <= 3 m apart along the path, segments between them with the same 1.5 m pad)
    const J = Math.min(3000, Math.max(K * 2, Math.ceil(len / 3)));
    if (c.solidsIn) {
      const bx = new THREE.Box3();
      raws.forEach((r, k) => bx.expandByPoint(lensW(r, 0, k / K, W)));
      bx.expandByPoint(sightW(0, 0, Sw)).expandByPoint(sightW(0, 1, Sw));
      solids = c.solidsIn(bx.min.x - 40, bx.min.z - 40, bx.max.x + 40, bx.max.z + 40);
      // (no solid set for that box - a bad box: this candidate cannot be cleared)
      if (!solids) { pl.bad = J + 1; return pl; }
      yield;
    }
    for (let j = 0; j <= J; j++) {
      const u = j / J, kf = (u * K);
      const lift = liftAt(pl, u);
      pl.maxLift = Math.max(pl.maxLift, lift);
      const onK = Math.abs(kf - Math.round(kf)) < 1e-9;
      const rr = onK ? raws[Math.round(kf)] : rawAt(u);
      if (!onK) backOff(rr.pos, c, move, scale);
      if (onK && lift > cap) pl.bad++;
      lensS(rr, lift, u, SL);
      if (!under && hullBox.containsPoint(SL)) pl.bad++;
      // (UNDER rides under the hull on purpose: the room's own geometry must stay clear of the lens and 0.3 m over it)
      if (under && c.roomClear && !c.roomClear(SL.clone(), SL.clone().setY(SL.y + 0.3))) pl.bad++;
      if (solids) {
        lensW(rr, lift, u, W);
        if (solids.hit(W, W, 1.5) || (j > 0 && solids.hit(Wprev, W, 1.5))) pl.bad++;
        else if (!under) {
          // (the walker seen through a lattice, a gate's legs or a wreck's ribs is not seen: the middle's line, or two of
          // the four, hidden = bad)
          let hid = 0;
          for (let q = 0; q < 4 && hid < 2; q++) {
            const tq = stopAt(SL, sights[q]);
            sightW(q, u, Sw);
            if (tq > 0 && solids.hit(W, P.copy(W).lerp(Sw, tq), 0)) hid += q === 0 ? 2 : 1;
          }
          if (hid >= 2) pl.bad++;
        }
        Wprev.copy(W);
      }
      if (j % 4 === 3) yield;
    }
    this.wreckFix = null;
    return pl;
  }

  /** Aim + lens from a fixed lens position (ship frame): the walker's height = a share of the frame inside `rule`, its
   *  middle on the third that leaves room ahead of its bow (or away from `other`, e.g. the wreck it passes), the horizon on
   *  the lower third (a low lens looking slightly up) or the upper third (a high one), the whole walker kept in frame.
   *  16:9 framing. Pure. */
  compose(pos: THREE.Vector3, c: CamCtx, rule: [number, number], other: THREE.Vector3 | null = null, aspect = 16 / 9, depth = 0, fix: { lead: number; low: boolean } | null = null): { tgt: THREE.Vector3; mm: number } {
    const b = c.hull;
    const C = b.getCenter(new THREE.Vector3());
    const corners: THREE.Vector3[] = [];
    for (let i = 0; i < 8; i++) corners.push(V(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z));
    const D2 = THREE.MathUtils.degToRad, tMin = Math.tan(D2(8)), tMax = Math.tan(D2(35));
    const fw = new THREE.Vector3(), rt = new THREE.Vector3(), up = new THREE.Vector3(), q = new THREE.Vector3();
    // the walker's box on screen (NDC) for an aim (yaw, pitch) and a lens (tan of the half vertical angle): exact
    const proj = (yaw: number, pitch: number, tanV: number) => {
      fw.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
      rt.crossVectors(fw, UPV).normalize(); up.crossVectors(rt, fw).normalize();
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, behind = false;
      for (const k of corners) {
        q.copy(k).sub(pos);
        const z = q.dot(fw);
        if (z < 0.5) { behind = true; continue; }
        const x = q.dot(rt) / z / (tanV * aspect), y = q.dot(up) / z / tanV;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      return { x0, x1, y0, y1, behind };
    };
    const flat = C.clone().sub(pos);
    let yaw = Math.atan2(flat.x, -flat.z), pitch = Math.atan2(flat.y, Math.hypot(flat.x, flat.z)), tanV = Math.tan(D2(25));
    const want = (rule[0] + rule[1]) / 2;
    const low = fix ? fix.low : pos.y < (b.min.y + b.max.y) * 0.5;
    // room ahead of the bow (or away from `other`): which way is the bow on screen for the first aim
    rt.set(Math.cos(yaw), 0, Math.sin(yaw));
    let lead = -Math.sign(fromBow(V(0, 0, -1), c.bowYaw ?? 0).dot(rt)) || 1;
    if (other) lead = -Math.sign(other.clone().sub(pos).dot(rt)) || lead;
    if (fix) lead = fix.lead;
    const tx = lead / 3;                                               // the walker's middle on this third (NDC x)
    for (let it = 0; it < 10; it++) {
      let P = proj(yaw, pitch, tanV);
      if (P.behind) { yaw = Math.atan2(flat.x, -flat.z); pitch = 0; continue; }
      // the lens: the walker's height = the wanted share of the frame, and at most 2 / 3 of its width (so it can sit on a
      // third with room ahead of its bow)
      let k = ((P.y1 - P.y0) / 2) / want;
      k = Math.max(k, ((P.x1 - P.x0) / 2) / 0.64);
      tanV = Math.min(tMax, Math.max(tMin, tanV * k));
      P = proj(yaw, pitch, tanV);
      // horizon on a third (a low lens looks up a little, a high one down), then the walker kept inside
      const hp = (low ? 1 : -1) * Math.atan(tanV / 3);
      pitch += (hp - pitch) * 0.6;
      P = proj(yaw, pitch, tanV);
      if (P.y1 > 0.9) pitch += Math.atan((P.y1 - 0.9) * tanV);
      if (P.y0 < -0.9) pitch -= Math.atan((-0.9 - P.y0) * tanV);
      P = proj(yaw, pitch, tanV);
      // the third (and never cut at the side)
      let cx = (P.x0 + P.x1) / 2;
      let dx = cx - tx;
      if (P.x1 - dx > 0.94) dx = P.x1 - 0.94; if (P.x0 - dx < -0.94) dx = P.x0 + 0.94;
      yaw += Math.atan(dx * tanV * aspect) * 0.9;
      void cx;
    }
    // too close for the rule even at the widest lens: the lens backs off along its line from the walker (the caller
    // re-checks the ground and aims again)
    const P = proj(yaw, pitch, tanV);
    if (depth < 2 && tanV >= tMax * 0.999 && ((P.y1 - P.y0) / 2 > rule[1] || (P.x1 - P.x0) / 2 > 0.66)) {
      const kk = Math.min(3, Math.max(((P.y1 - P.y0) / 2) / (rule[1] * 0.95), ((P.x1 - P.x0) / 2) / 0.62) ** 1.1);
      pos.set(C.x + (pos.x - C.x) * kk, pos.y, C.z + (pos.z - C.z) * kk);
      return this.compose(pos, c, rule, other, aspect, depth + 1, fix);
    }
    const dir = V(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    return { tgt: pos.clone().addScaledVector(dir, 60), mm: 12 / tanV };
  }

  /** The establishing shot's plan at its first frame (cached): which side the lens stands on - the side that puts the
   *  highest land (mesas, canyon walls) and a burning wreck BEHIND the walker - and a distance where a dune crest stands
   *  just in front of the lens (a foreground layer). Heights from the world at the shot's start: pure. */
  private estab = new Map<string, { side: number; k: number; y: number }>();
  private estabPlan(c: CamCtx, seed: number, startMs: number, D: number, gy: number) {
    const key = `${seed}:${Math.round(startMs / 500)}`;
    const hit = this.estab.get(key);
    if (hit) return hit;
    const S0 = c.distanceAt(startMs);
    const H = (x: number, z: number) => c.heightAt(S0 - z, x);
    const ground0 = H(0, 0);
    let best = { side: voyageRand(seed, 11) < 0.5 ? 1 : -1, score: -Infinity };
    for (const side of [1, -1]) {
      let sum = 0, n = 0;
      for (const lat of [450, 700, 1000, 1400]) for (const dz of [-400, -150, 100]) { sum += H(-side * lat, dz) - ground0; n++; }
      let score = sum / n;
      const wk = this.wreckOf(c);
      if (wk && wk.x * side < 0 && Math.abs(wk.x) < 600) score += 60;
      if (score > best.score) best = { side, score };
    }
    const side = best.side;
    let pick = { k: 1, crest: -Infinity, g: 0, c: 0 };
    for (const k of [0.9, 1, 1.15, 1.3]) {
      const x = side * D * k * Math.cos(0.45), z = -D * k * Math.sin(0.45);
      const g = H(x, z);
      let cr = -Infinity;
      for (const t of [8, 14, 20, 27, 35]) { const f = t / (D * k); cr = Math.max(cr, H(x * (1 - f), z * (1 - f))); }
      const rise = cr - g;
      const sc = rise > 0.4 && rise < 7 ? rise : rise > 7 ? 7 - (rise - 7) : rise * 0.2;
      if (sc > pick.crest) pick = { k, crest: sc, g, c: cr };
    }
    const y = gy + Math.max(pick.g, pick.c) + 1.7 - ground0;
    const out = { side, k: pick.k, y };
    if (this.estab.size > 16) this.estab.clear();
    this.estab.set(key, out);
    return out;
  }

  /** The show's moves. Distances scale with the hull (L = its length / 38 m); y in the ship frame (deck 0, sand below). */
  private showPose(move: ExtMove, u: number, seed: number, c: CamCtx, startMs = 0): { pos: THREE.Vector3; tgt: THREE.Vector3; mm: number; smooth: boolean } {
    const bw = c.bowYaw ?? 0;
    const box = bowBox(c.hull, bw), L = Math.max(0.4, Math.min(4, (box.max.z - box.min.z) / 38));
    const gy = box.min.y;
    const side = voyageRand(seed, 11) < 0.5 ? 1 : -1;
    const e = ease(u);
    const hero = c.hero && c.hero.lengthSq() > 0.5 ? c.hero.clone().normalize().applyAxisAngle(UPV, bw) : V(-0.35, 0.42, -0.84).normalize();
    // aim between the ship point and the hero body so both are in the frame; lens widened to hold both
    const frame = (pos: THREE.Vector3, ship: THREE.Vector3, w: number, mm: number) => {
      const toShip = ship.clone().sub(pos).normalize();
      const dir = toShip.clone().multiplyScalar(1 - w).addScaledVector(hero, w).normalize();
      const need = Math.max(toShip.angleTo(dir), hero.angleTo(dir)) * 2 / 0.78;
      const fov = Math.max(mmFov(mm), THREE.MathUtils.radToDeg(need));
      return { tgt: pos.clone().add(dir.multiplyScalar(50)), mm: Math.max(14, 12 / Math.tan(THREE.MathUtils.degToRad(Math.min(100, fov)) / 2)) };
    };
    const gnd = (x: number, z: number, up: number) => V(x, gy + up, z);
    switch (move) {
      case 'RISE': {
        const pos = V(side * 34 * L, 0, -30 * L).lerp(V(side * 56 * L, 36 * L, 24 * L), e);
        pos.y = Math.max(pos.y, gy + 1.6 + e * 40 * L);
        const ship = V(0, -6, -8).lerp(V(0, 10, 0), e);
        const f = frame(pos, ship, 0.15 + 0.3 * e, 26 - 4 * e);
        return { pos, tgt: f.tgt, mm: f.mm, smooth: true };
      }
      case 'ORBIT': {
        const a0 = Math.atan2(-hero.x, -hero.z) + side * 0.9;
        const ang = a0 + side * 1.1 * u;
        const R = 72 * L;
        const pos = V(Math.sin(ang) * R, -3 + 4 * Math.sin(u * Math.PI), Math.cos(ang) * R);
        const f = frame(pos, V(0, 2, 0), 0.3, 30);
        return { pos, tgt: f.tgt, mm: f.mm, smooth: true };
      }
      case 'TRACK': {
        // low alongside, overtaken by the walker: the whole hull in frame (its middle a third in from the edge), the
        // horizon behind it
        const pos = gnd(side * 30 * L, 2.2, (24 - 30 * e) * L);
        const ship = V(0, (box.min.y + box.max.y) * 0.5, (box.min.z + box.max.z) * 0.5);
        const dir = ship.clone().sub(pos).normalize();
        const right = V(dir.z, 0, -dir.x).normalize();
        return { pos, tgt: pos.clone().add(dir.multiplyScalar(40)).addScaledVector(right, side * 7).add(V(0, 3, 0)), mm: 20, smooth: true };
      }
      case 'HERO': {
        const away = V(-hero.x, 0, -hero.z).normalize();
        const pos = away.multiplyScalar((170 + 25 * e) * L).add(V(side * 30 * L * (1 - e), gy + 6 - 0, 0));
        pos.y = gy + 5 + 3 * e;
        const f = frame(pos, V(0, -2, 0), 0.45, 30);
        // (the smoothed frame like every show move: in the ship frame the lens rode the walker's roll, +-2 m 180 m out)
        return { pos, tgt: f.tgt, mm: f.mm, smooth: true };
      }
      case 'SKYWARD': {
        const pos = gnd(side * 13 * L, 1.2, (16 - 6 * e) * L);
        const tgt = V(-side * 6 * L, 46, -40 * L).lerp(pos.clone().addScaledVector(hero, 60), 0.35);
        return { pos, tgt, mm: 16, smooth: true };
      }
      case 'FLYBY': {
        const pos = V(side * (22 + 8 * e) * L, gy + 6 + 10 * e, (-70 + 140 * e) * L);
        return { pos, tgt: V(0, -2 + 6 * e, (-6 + 12 * e) * L), mm: 28, smooth: true };
      }
      case 'ESTAB': {
        // the key-art shot: low, a little ahead of the bow, the walker a third to a half of the frame on a third, the
        // highest land and a burning wreck behind it, a dune crest in front of the lens; it walks on past (compose aims)
        const Hs = box.max.y - box.min.y;
        const D = THREE.MathUtils.clamp(Hs / (0.41 * 2 * Math.tan(THREE.MathUtils.degToRad(15))), 45, 170);
        const P = this.estabPlan(c, seed, startMs, D, gy);
        const th = 0.55 - 0.4 * e;                                     // from ahead of the bow round towards the beam
        const pos = V(P.side * D * P.k * Math.cos(th), P.y, -D * P.k * Math.sin(th));
        return { pos, tgt: V(0, gy + Hs * 0.5, 0), mm: 40, smooth: true };
      }
      case 'LASERS': {
        // a close HERO: low beside the walker, looking up its searchlights and lasers into the show sky (and the hero
        // planet when it is that way)
        const pos = V(side * (31 - 4 * e) * L, gy + 2.0, (-12 + 22 * e) * L);
        const f = frame(pos, V(0, 26, 0), 0.22, 18);
        return { pos, tgt: f.tgt, mm: Math.min(f.mm, 18), smooth: true };
      }
      case 'UNDER': {
        // low under the belly between the legs, looking forward and up: the legs stride past the lens
        // low between the legs, from amidships towards the front pair: the legs stride past the lens, the sky and the
        // land open beyond the bow (the hull a band across the top of the frame)
        const lz = c.legZ ?? [box.min.z * 0.6, box.max.z * 0.6];
        const z0 = lz[1] * 0.05, z1 = lz[0] * 0.8;
        // (a line under the hull that nothing of the ship crosses - a hatch, a hanging lift, a keel box - with 1 m of
        // headroom all along it; the legs are clear of the centre line by the gait's own geometry)
        const lane = this.underLane(c, side, gy, Math.min(z0, z1), Math.max(z0, z1));
        if (!lane) return this.showPose('FEET', u, seed, c);
        const pos = V(lane.x, gy + lane.h, z0 + (z1 - z0) * e);
        return { pos, tgt: pos.clone().add(V(-side * 2.5, 3.0, -30)), mm: 14, smooth: true };
      }
      case 'WRECK': {
        // the ship walking past a burning wreck: low on the far side of the walker, the wreck's fire and smoke behind it
        const wk = this.wreckOf(c);
        const W = wk && wk.lengthSq() > 1 ? wk.clone() : V(side * 300, gy + 6, -120);
        const away = V(-W.x, 0, -W.z).normalize();
        const pos = away.clone().multiplyScalar(46 * L).add(V(0, gy + 5 + 4 * e, 0)).add(V(away.z, 0, -away.x).multiplyScalar((14 - 28 * e) * L));
        const ship = V(0, -4, 0);
        const toW = W.clone().sub(pos).normalize(), toS = ship.clone().sub(pos).normalize();
        const dir = toS.clone().multiplyScalar(0.62).addScaledVector(toW, 0.38).normalize();
        const need = Math.max(toS.angleTo(dir), toW.angleTo(dir)) * 2 / 0.8 + 0.5;
        return { pos, tgt: pos.clone().add(dir.multiplyScalar(60)), mm: Math.max(14, Math.min(30, 12 / Math.tan(need / 2))), smooth: true };
      }
      default: {          // FEET: the stomping legs, low, with the hull above them (far enough out that the feet's dust
        // never hides the walker: the lens stands clear of the puffs)
        const pos = gnd(side * 25 * L, 2.4, (-4 + 10 * e) * L);
        return { pos, tgt: V(side * 5 * L, gy + 6.5, -8 * L), mm: 24, smooth: true };
      }
    }
  }

  private lanes = new Map<string, { x: number; h: number } | null>();
  /** The UNDER move's lane (x offset, height over the sand) for a side, found once per hull against the room. */
  private underLane(c: CamCtx, side: number, gy: number, z0: number, z1: number): { x: number; h: number } | null {
    const key = `${side}:${c.hull.min.toArray().map((v) => v.toFixed(1)).join(',')}`;
    if (this.lanes.has(key)) return this.lanes.get(key)!;
    let pick: { x: number; h: number } | null = null;
    if (!c.roomClear) pick = { x: side * 0.4, h: 1.5 };
    else for (const [x, h] of [[0.4, 1.5], [0.4, 1.9], [1.4, 1.6], [-0.6, 1.6], [2.4, 1.5], [0, 1.25]]) {
      const a = V(side * x, gy + h, z0), b = V(side * x, gy + h, z1);
      if (!c.roomClear(fromBow(a.clone(), c.bowYaw ?? 0), fromBow(b.clone(), c.bowYaw ?? 0))) continue;
      const up = V(0, 1.0, 0);
      let ok = true;
      for (let t = 0; t <= 1 && ok; t += 0.25) { const p = fromBow(a.clone().lerp(b, t), c.bowYaw ?? 0); ok = c.roomClear(p, p.clone().add(up)); }
      if (ok) { pick = { x: side * x, h }; break; }
    }
    this.lanes.set(key, pick);
    return pick;
  }

  private toSmooth(pShip: THREE.Vector3, c: CamCtx) {
    return pShip.clone().applyMatrix4(new THREE.Matrix4().copy(c.smoothToShip).invert());
  }

  /** Rise (ship frame y) until no terrain stands between the lens and its subject (12 samples along the first 75 % of
   *  the line to the target, at most 300 m of it; +2 m over the sand). true = moved. */
  private clearView(pos: THREE.Vector3, tgt: THREE.Vector3, c: CamCtx): boolean {
    const d = CV_D.copy(tgt).sub(pos);
    const len = d.length();
    if (len < 1) return false;
    const T = CV_T.copy(pos).addScaledVector(d, Math.min(1, 300 / len));
    let lift = 0;
    const q = CV_Q;
    for (let i = 1; i <= 12; i++) {
      const t = (i / 12) * 0.75;
      q.copy(pos).lerp(T, t);
      const w = c.toWorld(q);
      const need = c.heightAt(w.s, w.d) + 2 - w.h;
      if (need > 0) lift = Math.max(lift, need / (1 - t));
    }
    if (lift <= 0.01) return false;
    pos.y += Math.min(80, lift);
    return true;
  }

  /** above the sand, outside the hull (`under`: the lens rides UNDER the hull, between the legs - only the sand counts) */
  private validate(p: THREE.Vector3, c: CamCtx, under = false, clear = 1.2): string[] {
    const fixed: string[] = [];
    const w = c.toWorld(p);
    const g = c.heightAt(w.s, w.d) + clear;
    if (w.h < g) { const lifted = c.toShip(w.s, w.d, g, new THREE.Vector3()); p.copy(lifted); fixed.push('ground'); }
    if (under) return fixed;
    const box = c.hull.clone().expandByScalar(1.5);
    if (box.containsPoint(p)) {
      const dx = p.x >= 0 ? box.max.x - p.x : p.x - box.min.x;
      const dz = p.z >= 0 ? box.max.z - p.z : p.z - box.min.z;
      const dy = box.max.y - p.y;
      if (dy < Math.min(dx, dz)) p.y = box.max.y + 0.1; else if (dx < dz) p.x = p.x >= 0 ? box.max.x + 0.1 : box.min.x - 0.1; else p.z = p.z >= 0 ? box.max.z + 0.1 : box.min.z - 0.1;
      fixed.push('hull');
    }
    return fixed;
  }
}
