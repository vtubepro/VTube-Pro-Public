// Ambient crowd: the planner. Every background character's pose is a pure function of (room anchors, seed, wall-clock
// seconds, support events) — so the studio preview, every OBS page and party guests' OBS pages show the same show with
// no messages (like the kitchen / raid engines). Activities are small timeline builders; a rotation group gives each of
// its activities a turn (`turn` s), and the frogs hop out of the water to take over / dive back in when the turn ends.
import * as THREE from 'three';
import type { CrowdActivity, CrowdPoint } from './crowdRoom';

// ------------------------------------------------------------------------------------------ deterministic helpers
export function hash32(...parts: (string | number)[]): number {
  let h = 2166136261 >>> 0;
  for (const p of parts) {
    if (typeof p === 'number' && Number.isInteger(p) && p >= -MAX_SAFE && p <= MAX_SAFE) {
      // (the characters String(p) would give, fed one by one: no string per call)
      let n = p < 0 ? -p : p;
      if (p < 0) { h ^= 45; h = Math.imul(h, 16777619) >>> 0; }
      let div = 1;
      while (div * 10 <= n) div *= 10;
      for (; div >= 1; div /= 10) { const d = Math.floor(n / div); n -= d * div; h ^= 48 + d; h = Math.imul(h, 16777619) >>> 0; }
    } else {
      const s = typeof p === 'number' ? (Number.isInteger(p) ? String(p) : p.toFixed(4)) : p;
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    }
    h ^= 0x9e; h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
const MAX_SAFE = 999999999999999;   // (below 1e15 the digit split by division is exact)
/** rng() without the closure: `seed(s)` then `next()` give exactly rng(s)'s sequence (one instance reseeded per use). */
export class Rng32 {
  private a = 1;
  seed(s: number) { this.a = s >>> 0 || 1; }
  next(): number { this.a = (this.a + 0x6d2b79f5) >>> 0; let t = this.a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
}
export function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (x: number) => { const k = clamp01(x); return k * k * (3 - 2 * k); };
const fract = (x: number) => x - Math.floor(x);
const lerpAng = (a: number, b: number, k: number) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * k; };
const yawTo = (a: THREE.Vector3, b: THREE.Vector3) => Math.atan2(b.x - a.x, b.z - a.z);

// ------------------------------------------------------------------------------------------ poses + fx
export const TAG = { NOTES: 1, ZZZ: 2, STARS: 4, SWEAT: 8, BANG: 16, CONFETTI: 32, CARD: 64, HEART: 128 } as const;

export interface Pose {
  pos: THREE.Vector3; yaw: number;
  /** body rotation about its middle (rad): pitch + = tip forward, roll + = lean to its left */
  pitch: number; roll: number;
  clip: string; time: number;
  /** optional second clip blended in with weight w2 */
  clip2?: string; time2?: number; w2?: number;
  hidden: boolean;
  props: string[];
  tags: number;
  /** airborne / underwater / lying: support cheers leave it alone */
  busy: boolean;
  /** standing on something: may cheer / dance on support + party states */
  cheer: boolean;
}
export function newPose(): Pose {
  return { pos: new THREE.Vector3(), yaw: 0, pitch: 0, roll: 0, clip: 'idle', time: 0, hidden: false, props: [], tags: 0, busy: false, cheer: true };
}

export type FxKind = 'splash' | 'bigsplash' | 'ripple' | 'confetti' | 'sparks';
export interface FxOut { kind: FxKind; pos: THREE.Vector3; age: number; size: number }

// ------------------------------------------------------------------------------------------ tracks (timeline segments)
export interface Seg {
  t0: number; t1: number;
  a: THREE.Vector3; b?: THREE.Vector3;
  /** arc height (m) for jumps / hops */
  h?: number;
  clip: string; rate?: number; c0?: number;
  /** yaw: number, or 'path' (face the travel direction) */
  yaw?: number | 'path'; yawTo?: number;
  pitch?: [number, number]; roll?: [number, number];
  hidden?: boolean; tags?: number; busy?: boolean; cheer?: boolean; ease?: boolean;
  /** vertical bob (m) at `bobHz` */
  bob?: number;
}
export type Track = Seg[];

const T0 = new THREE.Vector3();
export function sampleTrack(tr: Track, t: number, out: Pose): boolean {
  if (!tr.length) return false;
  let s = tr[0];
  if (t >= tr[tr.length - 1].t1) s = tr[tr.length - 1];
  else for (const x of tr) { if (t >= x.t0 && t < x.t1) { s = x; break; } }
  const u = clamp01((t - s.t0) / Math.max(1e-3, s.t1 - s.t0));
  const k = s.ease ? smooth(u) : u;
  if (s.b) out.pos.copy(s.a).lerp(s.b, k); else out.pos.copy(s.a);
  if (s.h) out.pos.y += 4 * s.h * u * (1 - u);
  if (s.bob) out.pos.y += s.bob * Math.abs(Math.sin(t * Math.PI * 2));
  if (s.yaw === 'path' && s.b) out.yaw = s.a.distanceToSquared(s.b) > 1e-6 ? Math.atan2(s.b.x - s.a.x, s.b.z - s.a.z) : out.yaw;
  else if (typeof s.yaw === 'number') out.yaw = s.yawTo !== undefined ? lerpAng(s.yaw, s.yawTo, smooth(u)) : s.yaw;
  out.pitch = s.pitch ? s.pitch[0] + (s.pitch[1] - s.pitch[0]) * k : 0;
  out.roll = s.roll ? s.roll[0] + (s.roll[1] - s.roll[0]) * k : 0;
  out.clip = s.clip; out.time = (s.c0 ?? 0) + (t - s.t0) * (s.rate ?? 1);
  out.hidden = !!s.hidden; out.tags = s.tags ?? 0; out.busy = !!s.busy; out.cheer = s.cheer ?? !s.busy;
  return true;
}
const V = (p: THREE.Vector3, dx = 0, dy = 0, dz = 0) => new THREE.Vector3(p.x + dx, p.y + dy, p.z + dz);
/** walk segments along a polyline at `speed` from time t; returns the end time */
function walk(tr: Track, pts: THREE.Vector3[], t: number, speed: number, clip = 'walk', extra: Partial<Seg> = {}) {
  for (let i = 0; i < pts.length - 1; i++) {
    const d = pts[i].distanceTo(pts[i + 1]); if (d < 1e-4) continue;
    const dt = d / speed;
    tr.push({ t0: t, t1: t + dt, a: pts[i], b: pts[i + 1], clip, rate: speed / 0.75, c0: t * 1.33, yaw: 'path', ...extra });
    t += dt;
  }
  return t;
}

// ------------------------------------------------------------------------------------------ the context
export interface Support { at: number; id: string; user: string; usd: number; /** chat finance kind (tip, sub, raid …) when known */ kind?: string }
export interface PlanCtx {
  seed: number;
  /** frog height (m) and native model height → scale for water offsets */
  scale: number;
  water: number;
  /** support events (wall seconds), newest last */
  support: Support[];
  /** the host's lighting state (preshow / outro = party) */
  party: boolean;
  /** room engines' extra inputs (e.g. src/scene/club: bits, beat, financial events) */
  ext?: Record<string, unknown>;
}

/** Offsets (in frog-native metres × scale) for water poses. */
const SWIM_Y = -0.78, SWIMFWD_Y = -0.42, MID = 0.5;

export interface ActivityPlan {
  act: CrowdActivity;
  /** frogs used (roles) */
  n: number;
  /** props / outfits per role */
  outfit(i: number): string;
  /** poses at wall time t (seconds); fx appended to `fx` */
  sample(ctx: PlanCtx, t: number, out: Pose[], fx: FxOut[]): void;
  /** water point to hop in / out when the group turn changes (null = rise / sink in place) */
  water(i: number): THREE.Vector3 | null;
}

const cache = new Map<string, Track[]>();
function cached(key: string, build: () => Track[]): Track[] {
  let v = cache.get(key);
  if (!v) { v = build(); cache.set(key, v); if (cache.size > 160) cache.delete(cache.keys().next().value!); }
  return v;
}
const lastSupport = (ctx: PlanCtx, t: number, win: number) => { for (let i = ctx.support.length - 1; i >= 0; i--) { const e = ctx.support[i]; if (t >= e.at && t - e.at < win) return e; } return null; };
const supportBetween = (ctx: PlanCtx, a: number, b: number) => ctx.support.find((e) => e.at >= a && e.at < b) ?? null;
/** extra clip time gained from tempo boosts (+60 % for 25 s per event) — continuous */
const tempoExtra = (ctx: PlanCtx, t: number) => ctx.support.reduce((s, e) => s + (t > e.at ? 0.6 * Math.min(25, t - e.at) : 0), 0) + (ctx.party ? 0 : 0);

function splash(fx: FxOut[], pos: THREE.Vector3, t: number, at: number, size = 1, kind: FxKind = 'splash') {
  const age = t - at;
  if (age >= 0 && age < 1.6) fx.push({ kind, pos, age, size });
}

// ------------------------------------------------------------------------------------------ activities
function outfitOf(act: CrowdActivity, i: number) { return act.outfits.length ? act.outfits[i % act.outfits.length] : ''; }
const P = (act: CrowdActivity, name: string, fb: CrowdPoint) => act.named.get(name) ?? fb;

function band(act: CrowdActivity): ActivityPlan {
  const roles = [['banjo', 'banjo'], ['washboard', 'washboard'], ['jug', 'jug']];
  const pts = act.pts.length ? act.pts : [act.anchor];
  return {
    act, n: Math.min(3, Math.max(1, pts.length)), outfit: (i) => outfitOf(act, i),
    water: () => act.named.get('WATER')?.pos ?? null,
    sample(ctx, t, out, fx) {
      const SONG = 34;
      const k = Math.floor(t / SONG), u = t - k * SONG;
      const r = rng(hash32(ctx.seed, act.id, k));
      const solo = r() < 0.6 ? Math.floor(r() * this.n) : -1;
      const extra = tempoExtra(ctx, t);
      for (let i = 0; i < this.n; i++) {
        const o = out[i], p = pts[i % pts.length];
        o.pos.copy(p.pos); o.yaw = p.yaw; o.pitch = 0; o.roll = 0; o.hidden = false; o.busy = false; o.cheer = true; o.tags = 0;
        o.props = [roles[i % 3][1]];
        if (u < 30) {
          o.clip = roles[i % 3][0]; o.time = t + extra + i * 0.07; o.tags = TAG.NOTES;
          if (i === solo) {                                  // a solo: steps forward and goes wild
            const f = smooth((u - 12) / 1.2) * (1 - smooth((u - 20) / 1.2));
            o.pos.x += Math.sin(p.yaw) * 0.35 * f; o.pos.z += Math.cos(p.yaw) * 0.35 * f;
            o.time += f * 0.8 * (u - 12);
          }
        } else if (u < 33) { o.clip = u < 31.2 ? 'hop' : 'cheer'; o.time = u < 31.2 ? (u - 30) * 0.66 : u - 31.2; o.pos.y += u < 31.2 ? 0.25 * Math.sin(Math.PI * (u - 30) / 1.2) : 0; o.props = []; }
        else { o.clip = 'idle'; o.time = t; }
      }
      void fx;
    },
  };
}

function dive(act: CrowdActivity): ActivityPlan {
  const start = act.anchor.pos, board = P(act, 'BOARD', act.anchor).pos, spl = P(act, 'SPLASH', act.anchor).pos;
  const ladder = P(act, 'LADDER', act.anchor).pos, top = P(act, 'TOP', act.anchor).pos;
  const C = 14;
  return {
    act, n: 2, outfit: (i) => outfitOf(act, i), water: () => spl,
    sample(ctx, t, out, fx) {
      for (let i = 0; i < 2; i++) {
        const tt = t - i * (C / 2);
        const k = Math.floor(tt / C), u = tt - k * C;
        const jumpAt = k * C + 5.0 + i * (C / 2);
        const mega = !!supportBetween(ctx, jumpAt - 20, jumpAt);
        const tr = cached(`${act.id}:${i}:${k}:${mega ? 1 : 0}`, () => {
          const r = rng(hash32(ctx.seed, act.id, i, k));
          const kind = mega ? 'mega' : r() < 0.22 ? 'flop' : 'ball';
          const s = ctx.scale;
          const onBoard = V(board, 0, 0, 0), boardBase = new THREE.Vector3(board.x, board.y - 0.06, board.z + (start.z > board.z ? 1.1 : -1.1));
          const tr: Track = [];
          let t0 = walk(tr, [start, new THREE.Vector3(start.x, start.y, boardBase.z), boardBase, onBoard], 0, 0.95);
          t0 = Math.min(t0, 3.6);
          tr.push({ t0, t1: 5.0, a: onBoard, clip: 'board_bounce', yaw: yawTo(start, board), bob: 0.08 });
          const land = V(spl, 0, SWIM_Y * s, 0);
          const apex = kind === 'mega' ? 2.6 : 1.5;
          const spins = kind === 'flop' ? [0, Math.PI / 2] as [number, number] : [0, Math.PI * 2 * (kind === 'mega' ? 2 : 1)] as [number, number];
          tr.push({ t0: 5.0, t1: 6.1, a: onBoard, b: land, h: apex, clip: kind === 'flop' ? 'bellyflop' : 'cannonball', yaw: yawTo(start, board), pitch: spins, busy: true });
          tr.push({ t0: 6.1, t1: 7.0, a: land, clip: 'swim', hidden: true, busy: true });
          const sw = V(spl, 0, SWIMFWD_Y * s, 0), ld = V(ladder, 0, SWIMFWD_Y * s, 0);
          tr.push({ t0: 7.0, t1: 7.4, a: V(spl, 0, SWIM_Y * s - 0.3, 0), b: V(spl, 0, SWIM_Y * s, 0), clip: 'swim', yaw: yawTo(spl, ladder), busy: true, tags: kind === 'flop' ? TAG.STARS : kind === 'mega' ? TAG.HEART : TAG.CARD });
          tr.push({ t0: 7.4, t1: 10.2, a: sw, b: ld, clip: 'swimfwd', yaw: 'path', busy: true, tags: kind === 'flop' ? TAG.STARS : 0 });
          const cy = yawTo(ladder, top);
          tr.push({ t0: 10.2, t1: 11.2, a: V(ladder, 0, -0.9 * s, 0), b: V(ladder, (top.x - ladder.x) * 0.35, top.y - ladder.y - 0.05, (top.z - ladder.z) * 0.35), clip: 'climb', yaw: cy, busy: true });
          tr.push({ t0: 11.2, t1: 11.5, a: V(ladder, (top.x - ladder.x) * 0.35, top.y - ladder.y, (top.z - ladder.z) * 0.35), b: top, clip: 'hop', c0: 0.3, yaw: cy });
          const e = walk(tr, [top, start], 11.5, 0.9);
          tr.push({ t0: e, t1: C, a: start, clip: 'idle', yaw: yawTo(start, board) });
          (tr as Track & { kind?: string }).kind = kind;
          return [tr];
        })[0];
        sampleTrack(tr, u, out[i]);
        out[i].props = [];
        if (out[i].hidden === false && u >= 6.1 && u < 11.2) out[i].cheer = false;
        const kind = (tr as Track & { kind?: string }).kind;
        splash(fx, spl, u, 6.1, kind === 'mega' ? 2.4 : kind === 'flop' ? 1.5 : 1.1, kind === 'mega' ? 'bigsplash' : 'splash');
        if (kind === 'mega') splash(fx, V(spl, 0, 1.6, 0), u, 6.1, 1.4, 'confetti');
      }
    },
  };
}

function conga(act: CrowdActivity): ActivityPlan {
  const c = act.anchor.pos, R = Number(act.extras.radius) || 1.3;
  const n = act.frogs;
  return {
    act, n, outfit: (i) => outfitOf(act, i), water: () => act.named.get('WATER')?.pos ?? null,
    sample(ctx, t, out) {
      const CY = 30, k = Math.floor(t / CY), u = t - k * CY;
      // moving time: pauses 22..26 each cycle (the whole line stops, shimmies, then all jump)
      const mv = k * (CY - 4) + Math.min(u, 22) + Math.max(0, u - 26);
      const speed = 0.5, w = speed / R, gap = 0.98 / R;
      const dir = hash32(ctx.seed, act.id, k) % 3 === 0 ? -1 : 1;
      for (let i = 0; i < n; i++) {
        const o = out[i];
        const th = dir * (mv * w) - dir * i * gap;
        o.pos.set(c.x + Math.sin(th) * R, c.y, c.z + Math.cos(th) * R);
        o.yaw = Math.atan2(Math.cos(th), -Math.sin(th)) + (dir < 0 ? Math.PI : 0);
        o.pitch = 0; o.roll = 0; o.hidden = false; o.busy = false; o.cheer = true; o.tags = 0; o.props = [];
        if (u < 22 || u >= 26) { o.clip = 'conga'; o.time = mv * 1.0; }
        else if (u < 24.8) { o.clip = 'dance'; o.time = u + i * 0.1; }
        else { o.clip = 'hop'; o.time = (u - 24.8) * 0.66; o.pos.y += 0.35 * Math.sin(Math.PI * clamp01((u - 24.8) / 1.2)); }
      }
    },
  };
}

function armwrestle(act: CrowdActivity): ActivityPlan {
  const c = act.anchor.pos, fy = act.anchor.yaw;
  const right = new THREE.Vector3(Math.cos(fy), 0, -Math.sin(fy));
  return {
    act, n: 2, outfit: (i) => outfitOf(act, i), water: () => act.named.get('WATER')?.pos ?? null,
    sample(ctx, t, out) {
      const B = 16, k = Math.floor(t / B), u = t - k * B;
      const r = rng(hash32(ctx.seed, act.id, k));
      const win = r() < 0.5 ? 0 : 1;
      const ph = r() * 10;
      for (let i = 0; i < 2; i++) {
        const o = out[i]; const s = i === 0 ? -1 : 1;
        const spot = V(c, right.x * s * 0.52, 0, right.z * s * 0.52);
        const face = Math.atan2(-right.x * s, -right.z * s);
        o.pos.copy(spot); o.yaw = face; o.pitch = 0; o.roll = 0; o.hidden = false; o.busy = false; o.cheer = true; o.tags = 0; o.props = []; o.clip2 = undefined; o.w2 = 0;
        if (u < 1.2) { o.clip = 'idle'; o.time = u; }
        else if (u < 12) {
          // balance: a wobbly tug of war that drifts to the winner near the end
          let b = 0.55 * Math.sin((u + ph) * 1.7) * Math.sin((u + ph) * 0.53) + 0.25 * Math.sin((u + ph) * 5.1);
          b = b * (1 - smooth((u - 9) / 3)) + (win === 0 ? 1 : -1) * smooth((u - 9) / 3);
          const lean = i === 0 ? b : -b;
          o.clip = 'wrestle_l'; o.time = u; o.clip2 = 'wrestle_r'; o.time2 = u; o.w2 = clamp01(0.5 - lean * 0.5);
          o.tags = u > 8 && i !== win ? TAG.SWEAT : 0; o.cheer = false;
        } else if (i === win) { o.clip = 'flex'; o.time = u - 12; o.tags = u < 13.5 ? TAG.BANG : 0; }
        else {
          // the loser is flipped backwards off the barrel, lands on his bum, stars, gets up
          const back = V(spot, right.x * s * 1.1, 0, right.z * s * 1.1);
          if (u < 13) { o.clip = 'fall'; o.time = u - 12; o.pos.lerpVectors(spot, back, u - 12); o.pos.y += 0.7 * Math.sin(Math.PI * (u - 12)); o.pitch = -Math.PI * 2 * (u - 12); o.busy = true; }
          else if (u < 15.2) { o.clip = 'dazed'; o.time = u - 13; o.pos.copy(back); o.tags = TAG.STARS; o.cheer = false; }
          else { o.clip = 'walk'; o.time = u; o.pos.lerpVectors(back, spot, smooth((u - 15.2) / 0.8)); }
        }
      }
    },
  };
}

function swim(act: CrowdActivity): ActivityPlan {
  const c = act.anchor.pos, R = Number(act.extras.radius) || 1.2;
  return {
    act, n: 3, outfit: (i) => outfitOf(act, i), water: () => null,
    sample(ctx, t, out, fx) {
      const SEG = 7, k = Math.floor(t / SEG), u = t - k * SEG;
      const routine = ['sync_a', 'sync_b', 'legs_up', 'circle'][((k % 4) + 4) % 4];
      const s = ctx.scale;
      const oops = rng(hash32(ctx.seed, act.id, k))() < 0.3 ? Math.floor(rng(hash32(ctx.seed, act.id, k, 'w'))() * 3) : -1;
      const base = routine === 'circle' ? t * 0.55 : t * 0.12;
      const dip = u < 0.5 ? 1 - u / 0.5 : u > SEG - 0.5 ? (u - (SEG - 0.5)) / 0.5 : 0;     // dive under between routines
      for (let i = 0; i < 3; i++) {
        const o = out[i];
        const th = base + i * (Math.PI * 2 / 3);
        o.pos.set(c.x + Math.sin(th) * R, c.y + SWIM_Y * s - dip * 0.9 * s, c.z + Math.cos(th) * R);
        o.yaw = th; o.pitch = 0; o.roll = 0; o.hidden = dip > 0.85; o.busy = true; o.cheer = false; o.tags = 0; o.props = [];
        o.time = u;
        if (routine === 'sync_a') { o.clip = 'sync_a'; o.yaw = th + (i === oops && u > 3.5 && u < 5 ? Math.PI : 0); }
        else if (routine === 'sync_b') { o.clip = 'sync_b'; o.yaw = th + u * Math.PI * 2 / 3.5 * (i === oops ? -1 : 1); }
        else if (routine === 'legs_up') {
          const f = smooth((u - 0.6) / 0.6) * (1 - smooth((u - 6.0) / 0.5));
          o.clip = f > 0.5 ? 'legs_up' : 'swim'; o.pitch = Math.PI * f; o.pos.y = c.y + (SWIM_Y * s) * (1 - f) + (-0.85 * s) * f - dip * 0.9 * s;
          if (i === oops && u > 3 && u < 4.2) o.pitch = Math.PI * 0.6;
        } else { o.clip = 'swimfwd'; o.yaw = th + Math.PI / 2; o.pos.y = c.y + SWIMFWD_Y * s - dip * 0.9 * s; }
        if (u < 0.05 || (u > 0.45 && u < 0.5)) fx.push({ kind: 'ripple', pos: V(o.pos, 0, 0, 0).setY(c.y + 0.01), age: 0.2, size: 0.8 });
      }
      for (let i = 0; i < 3; i++) splash(fx, V(out[i].pos).setY(c.y), u, 0.35, 0.5);
    },
  };
}

function hop(act: CrowdActivity): ActivityPlan {
  const pads = act.pts.map((p) => p.pos);
  const water = act.anchor.pos.y;
  return {
    act, n: 2, outfit: (i) => outfitOf(act, i), water: () => null,
    sample(ctx, t, out, fx) {
      const RACE = 18, k = Math.floor(t / RACE), u = t - k * RACE;
      const trs = cached(`${act.id}:${k}`, () => {
        const r = rng(hash32(ctx.seed, act.id, k));
        const missFrog = r() < 0.45 ? Math.floor(r() * 2) : -1, missAt = 1 + Math.floor(r() * (pads.length - 2));
        const out: Track[] = [];
        const side = (p: THREE.Vector3, i: number) => { const d = pads[Math.min(pads.length - 1, 1)].clone().sub(pads[0]); const n = new THREE.Vector3(d.z, 0, -d.x).normalize(); return V(p, n.x * (i ? 0.24 : -0.24), 0, n.z * (i ? 0.24 : -0.24)); };
        const finish: number[] = [];
        for (let i = 0; i < 2; i++) {
          const tr: Track = [];
          const p0 = side(pads[0], i), y0 = yawTo(pads[0], pads[1] ?? pads[0]);
          tr.push({ t0: 0, t1: 0.8, a: V(p0, 0, -0.9 * ctx.scale, 0), b: p0, h: 0.4, clip: 'hop', yaw: y0, busy: true });
          tr.push({ t0: 0.8, t1: 2.4, a: p0, clip: 'idle', yaw: y0 });
          let tt = 2.4;
          for (let j = 1; j < pads.length; j++) {
            const a = side(pads[j - 1], i), b = side(pads[j], i);
            const dur = 0.62 + r() * 0.12;
            if (i === missFrog && j === missAt) {
              const wet = V(a, (b.x - a.x) * 0.6, 0, (b.z - a.z) * 0.6).setY(water + SWIM_Y * ctx.scale);
              tr.push({ t0: tt, t1: tt + dur, a, b: wet, h: 0.5, clip: 'hop', yaw: 'path', busy: true }); tt += dur;
              (tr as Track & { miss?: [number, THREE.Vector3] }).miss = [tt, V(wet).setY(water)];
              tr.push({ t0: tt, t1: tt + 0.5, a: wet, clip: 'swim', hidden: true, busy: true }); tt += 0.5;
              tr.push({ t0: tt, t1: tt + 1.6, a: V(wet), b: V(b, 0, SWIM_Y * ctx.scale, 0), clip: 'swim', yaw: 'path', busy: true, tags: TAG.SWEAT }); tt += 1.6;
              tr.push({ t0: tt, t1: tt + 0.7, a: V(b, 0, SWIM_Y * ctx.scale, 0), b, h: 0.3, clip: 'hop', yaw: yawTo(a, b), busy: true }); tt += 0.7;
            } else {
              tr.push({ t0: tt, t1: tt + dur, a, b, h: 0.55, clip: 'hop', rate: 0.8 / dur, yaw: 'path', busy: true }); tt += dur;
              const rest = 0.12 + r() * 0.35;
              tr.push({ t0: tt, t1: tt + rest, a: b, clip: 'idle', yaw: yawTo(a, b) }); tt += rest;
            }
          }
          finish.push(tt);
          out.push(tr);
        }
        const winner = finish[0] <= finish[1] ? 0 : 1;
        for (let i = 0; i < 2; i++) {
          const tr = out[i], end = tr[tr.length - 1], pe = end.b ?? end.a;
          tr.push({ t0: finish[i], t1: 15.8, a: pe, clip: i === winner ? 'cheer' : 'clap', yaw: yawTo(pads[0], pads[pads.length - 1]) + (i === winner ? 0 : 0.4), tags: i === winner ? TAG.CONFETTI : 0 });
          const wet = V(pe, 0, SWIM_Y * ctx.scale - 0.5, 0);
          tr.push({ t0: 15.8, t1: 16.6, a: pe, b: wet, h: 0.5, clip: 'hop', yaw: 'path', busy: true });
          tr.push({ t0: 16.6, t1: RACE, a: wet, clip: 'swim', hidden: true, busy: true });
          (tr as Track & { end?: THREE.Vector3 }).end = V(pe).setY(water);
        }
        return out;
      });
      for (let i = 0; i < 2; i++) {
        sampleTrack(trs[i], u, out[i]); out[i].props = [];
        const x = trs[i] as Track & { miss?: [number, THREE.Vector3]; end?: THREE.Vector3 };
        if (x.miss) splash(fx, x.miss[1], u, x.miss[0], 1.0);
        if (x.end) splash(fx, x.end, u, 16.6, 0.8);
        splash(fx, V(trs[i][0].b ?? trs[i][0].a).setY(water), u, 0.05, 0.6);
      }
    },
  };
}

function canoe(act: CrowdActivity): ActivityPlan {
  const c = act.anchor.pos, rx = Number(act.extras.rx) || 3, rz = Number(act.extras.rz) || 2;
  return {
    act, n: 1, outfit: (i) => outfitOf(act, i), water: () => null,
    sample(ctx, t, out, fx) {
      const o = out[0];
      const w = 0.8 / ((rx + rz) / 2);
      const th = t * w;
      o.pos.set(c.x + Math.sin(th) * rx, c.y + 0.16, c.z + Math.cos(th) * rz);
      o.yaw = Math.atan2(Math.cos(th) * rx, -Math.sin(th) * rz);
      o.clip = 'paddle'; o.time = t; o.pitch = 0; o.roll = 0.04 * Math.sin(t * 5.2); o.hidden = false; o.busy = false; o.cheer = false; o.tags = 0;
      o.props = ['paddle', 'canoe'];
      // capsize gag: rolls over at 38 s of every 52 s, pops back up at 41 s
      const CY = 52, u = t - Math.floor(t / CY) * CY;
      if (u > 38 && u < 42) {
        const f = u < 38.6 ? smooth((u - 38) / 0.6) : u < 41.4 ? 1 : 1 - smooth((u - 41.4) / 0.6);
        o.roll = Math.PI * f * (u < 41.4 ? 1 : 1) + (u >= 41.4 ? Math.PI * 2 * (1 - f) - Math.PI * 2 * (1 - f) : 0);
        o.busy = true; o.clip = f > 0.5 ? 'fall' : 'paddle';
        o.pos.y -= 0.25 * f;
        splash(fx, V(o.pos).setY(c.y), u, 38.5, 0.9);
        splash(fx, V(o.pos).setY(c.y), u, 41.6, 0.7);
      }
      if (u >= 42 && u < 45) o.tags = TAG.SWEAT;
    },
  };
}

function climb(act: CrowdActivity): ActivityPlan {
  const pts = act.pts.map((p) => p.pos);
  const wat = act.named.get('WATER')?.pos ?? V(act.anchor.pos);
  return {
    act, n: 1, outfit: (i) => outfitOf(act, i), water: () => wat,
    sample(ctx, t, out, fx) {
      const CY = 26, k = Math.floor(t / CY), u = t - k * CY;
      const win = !!supportBetween(ctx, k * CY - 30, k * CY + 10);
      const tr = cached(`${act.id}:${k}:${win ? 1 : 0}`, () => {
        const s = ctx.scale;
        const tr: Track = [];
        const face = act.anchor.yaw;
        const n = pts.length;
        const topI = win ? n - 1 : Math.max(1, n - 2);
        tr.push({ t0: 0, t1: 1.0, a: V(pts[0], 0, SWIM_Y * s - 0.4, 0), b: V(pts[0], 0, SWIM_Y * s, 0), clip: 'swim', yaw: face, busy: true });
        tr.push({ t0: 1.0, t1: 1.8, a: V(pts[0], 0, SWIM_Y * s, 0), b: pts[Math.min(1, n - 1)], h: 0.3, clip: 'hop', yaw: face, busy: true });
        let tt = 1.8;
        const per = 9.2 / Math.max(1, topI - 1);
        for (let j = 2; j <= topI; j++) { tr.push({ t0: tt, t1: tt + per, a: pts[j - 1], b: pts[j], clip: 'climb', yaw: face, busy: true, ease: true }); tt += per; }
        if (win) {
          tr.push({ t0: tt, t1: tt + 7.5, a: pts[topI], clip: 'pose', yaw: face + Math.PI, tags: TAG.CONFETTI }); tt += 7.5;
          const land = V(wat, 0, SWIM_Y * s, 0);
          tr.push({ t0: tt, t1: tt + 1.3, a: pts[topI], b: land, h: 1.2, clip: 'cannonball', yaw: face + Math.PI, pitch: [0, Math.PI * 2], busy: true }); tt += 1.3;
          (tr as Track & { sp?: number }).sp = tt;
          tr.push({ t0: tt, t1: CY, a: land, clip: 'swim', hidden: true, busy: true });
        } else {
          tr.push({ t0: tt, t1: tt + 1.0, a: pts[topI], clip: 'shock', yaw: face, busy: true, tags: TAG.BANG }); tt += 1.0;
          tr.push({ t0: tt, t1: tt + 1.6, a: pts[topI], b: pts[0], clip: 'slide', yaw: face + Math.PI, pitch: [-0.4, -0.4], busy: true, ease: true }); tt += 1.6;
          const land = V(wat, 0, SWIM_Y * s, 0);
          tr.push({ t0: tt, t1: tt + 0.5, a: pts[0], b: land, h: 0.25, clip: 'fall', yaw: face + Math.PI, busy: true }); tt += 0.5;
          (tr as Track & { sp?: number }).sp = tt;
          tr.push({ t0: tt, t1: tt + 0.8, a: land, clip: 'swim', hidden: true, busy: true }); tt += 0.8;
          tr.push({ t0: tt, t1: tt + 3, a: land, clip: 'swim', yaw: face + Math.PI, busy: true, tags: TAG.STARS }); tt += 3;
          tr.push({ t0: tt, t1: CY, a: V(land), b: V(pts[0], 0, SWIM_Y * s - 0.4, 0), clip: 'swimfwd', yaw: 'path', busy: true });
        }
        return [tr];
      })[0];
      sampleTrack(tr, u, out[0]); out[0].props = [];
      const sp = (tr as Track & { sp?: number }).sp;
      if (sp !== undefined) splash(fx, V(wat), u, sp, win ? 1.6 : 1.0);
    },
  };
}

function juggle(act: CrowdActivity): ActivityPlan {
  return {
    act, n: 1, outfit: (i) => outfitOf(act, i), water: () => act.named.get('WATER')?.pos ?? null,
    sample(ctx, t, out) {
      const o = out[0];
      o.pos.copy(act.anchor.pos); o.yaw = act.anchor.yaw; o.pitch = 0; o.roll = 0; o.hidden = false; o.busy = false; o.cheer = false; o.tags = 0; o.props = [];
      const CY = 36, u = t - Math.floor(t / CY) * CY;
      const extra = tempoExtra(ctx, t);
      if (u > 25 && u < 29) { o.clip = 'stomp'; o.time = u; o.tags = u < 26 ? TAG.BANG : TAG.SWEAT; }
      else { o.clip = 'juggle'; o.time = t + extra; }
    },
  };
}

/** torches in the air for a juggler at wall time t (local offsets in the frog's frame: x right, y up) */
export function juggleTorches(ctx: PlanCtx, t: number, out: { x: number; y: number; spin: number; lit: boolean }[]) {
  out.length = 0;
  const CY = 36, u = t - Math.floor(t / CY) * CY;
  const extra = tempoExtra(ctx, t);
  const tt = t + extra;
  const P = 1.35;
  for (let k = 0; k < 3; k++) {
    if (u > 25 && u < 29 && k === 0) {
      const f = clamp01((u - 25) / 0.5);
      out.push({ x: 0.3, y: 0.9 - 0.9 * f * f, spin: f * 5, lit: true });
      continue;
    }
    const ph = fract(tt / P + k / 3);
    const leg = Math.floor(tt / P + k / 3) % 2 === 0 ? 1 : -1;
    const fly = clamp01(ph / 0.7);
    const x = ph < 0.7 ? leg * (0.22 - 0.44 * fly) : -leg * 0.22 * (1 - (ph - 0.7) / 0.3 * 0.4);
    const y = 0.72 + (ph < 0.7 ? 1.1 * 4 * fly * (1 - fly) : 0);
    out.push({ x, y, spin: ph * Math.PI * 2 * 1.5, lit: true });
  }
}

function fish(act: CrowdActivity): ActivityPlan {
  const seat = act.anchor.pos, bob = act.named.get('BOBBER')?.pos ?? V(seat, 0, -1, 1.5);
  const wat = act.named.get('WATER')?.pos ?? bob;
  return {
    act, n: 1, outfit: (i) => outfitOf(act, i), water: () => wat,
    sample(ctx, t, out, fx) {
      const CY = 50, u = t - Math.floor(t / CY) * CY;
      const s = ctx.scale;
      const face = yawTo(seat, bob);
      const tr = cached(`${act.id}`, () => {
        const tr: Track = [];
        tr.push({ t0: 0, t1: 40, a: seat, clip: 'fish', yaw: face });
        tr.push({ t0: 40, t1: 41.6, a: seat, clip: 'fish_tug', yaw: face, tags: TAG.BANG });
        const land = V(bob, 0, SWIM_Y * s, 0);
        tr.push({ t0: 41.6, t1: 42.7, a: seat, b: land, h: 1.3, clip: 'fall', yaw: face, pitch: [0, Math.PI * 1.5], busy: true });
        tr.push({ t0: 42.7, t1: 43.5, a: land, clip: 'swim', hidden: true, busy: true });
        tr.push({ t0: 43.5, t1: 44.5, a: land, clip: 'swim', yaw: face + Math.PI, busy: true, tags: TAG.SWEAT });
        tr.push({ t0: 44.5, t1: 47.5, a: V(bob, 0, SWIMFWD_Y * s, 0), b: V(wat, 0, SWIMFWD_Y * s, 0), clip: 'swimfwd', yaw: 'path', busy: true });
        tr.push({ t0: 47.5, t1: 48.3, a: V(wat, 0, SWIM_Y * s, 0), b: seat, h: 0.5, clip: 'hop', yaw: face, busy: true });
        tr.push({ t0: 48.3, t1: 50, a: seat, clip: 'idle', yaw: face, tags: TAG.SWEAT });
        return [tr];
      })[0];
      sampleTrack(tr, u, out[0]);
      out[0].props = u < 41.6 || u >= 48.3 ? ['rod'] : [];
      out[0].cheer = false;
      splash(fx, V(bob), u, 42.7, 1.1);
    },
  };
}

/** the bobber for a fisher at wall time t (null = no line) */
export function fishBobber(act: CrowdActivity, t: number, out: THREE.Vector3): boolean {
  const bob = act.named.get('BOBBER')?.pos; if (!bob) return false;
  const CY = 50, u = t - Math.floor(t / CY) * CY;
  if (u >= 41.6 && u < 48.3) return false;
  out.copy(bob); out.y += 0.02 * Math.sin(t * 2.3);
  if (u > 38 && u < 41.6) out.y -= 0.08 * Math.max(0, Math.sin(u * 17));
  return true;
}

function dj(act: CrowdActivity): ActivityPlan {
  return {
    act, n: 1, outfit: (i) => outfitOf(act, i), water: () => act.named.get('WATER')?.pos ?? null,
    sample(ctx, t, out, fx) {
      const o = out[0];
      o.pos.copy(act.anchor.pos); o.yaw = act.anchor.yaw; o.pitch = 0; o.roll = 0; o.hidden = false; o.busy = false; o.cheer = false; o.tags = 0;
      o.props = ['glow_L', 'glow_R'];
      const e = lastSupport(ctx, t, 3.5);
      if (e) {                                     // the drop: jumps with his glowsticks up, confetti
        const a = t - e.at;
        o.clip = 'cheer'; o.time = a; o.pos.y += 0.45 * Math.abs(Math.sin(Math.PI * a / 0.9)); o.tags = TAG.CONFETTI;
        splash(fx, V(o.pos, 0, 1.4, 0), t, e.at, 1.2, 'confetti');
      } else { o.clip = 'dj'; o.time = t * (ctx.party ? 1.25 : 1) + tempoExtra(ctx, t); }
    },
  };
}

function sleep(act: CrowdActivity): ActivityPlan {
  const bed = act.anchor.pos, yaw = act.anchor.yaw;
  return {
    act, n: 1, outfit: (i) => outfitOf(act, i), water: () => null,
    sample(ctx, t, out) {
      const o = out[0], s = ctx.scale;
      const mid = MID * s;
      const lying = V(bed, 0, -mid, 0);
      o.pos.copy(lying); o.yaw = yaw; o.pitch = -Math.PI / 2; o.roll = 0.05 * Math.sin(t * 0.9); o.hidden = false; o.busy = true; o.cheer = false;
      o.props = []; o.clip = 'sleep'; o.time = t; o.tags = TAG.ZZZ;
      const e = lastSupport(ctx, t, 7);
      if (e) {                                     // a donation wakes him: startle, falls out of the hammock, dazed, climbs back in
        const a = t - e.at;
        const floor = new THREE.Vector3(bed.x + Math.sin(yaw + Math.PI / 2) * 0.1, 0, bed.z + 0.7);
        if (a < 0.9) { o.clip = 'wake'; o.time = a; o.pitch = -Math.PI / 2 + 0.6 * smooth(a / 0.4); o.tags = TAG.BANG; }
        else if (a < 1.5) { const k = (a - 0.9) / 0.6; o.clip = 'fall'; o.time = a; o.pos.lerpVectors(lying, floor, k); o.pitch = (-Math.PI / 2 + 0.6) * (1 - k); o.roll = k * 0.8; o.tags = 0; }
        else if (a < 4.6) { o.clip = 'dazed'; o.time = a; o.pos.copy(floor); o.pitch = 0; o.roll = 0; o.tags = TAG.STARS; }
        else if (a < 5.6) { const k = (a - 4.6); o.clip = 'hop'; o.time = k * 0.8; o.pos.lerpVectors(floor, lying, smooth(k)); o.pos.y += 0.5 * Math.sin(Math.PI * k); o.pitch = -Math.PI / 2 * smooth(k); o.tags = 0; }
        else { o.tags = 0; }
      }
    },
  };
}

function idleSpot(act: CrowdActivity): ActivityPlan {
  return {
    act, n: act.frogs, outfit: (i) => outfitOf(act, i), water: () => act.named.get('WATER')?.pos ?? null,
    sample(ctx, t, out) {
      for (let i = 0; i < this.n; i++) {
        const o = out[i], p = act.pts[i] ?? act.anchor;
        o.pos.copy(p.pos); o.yaw = p.yaw; o.pitch = 0; o.roll = 0; o.hidden = false; o.busy = false; o.cheer = true; o.tags = 0; o.props = [];
        const r = rng(hash32(ctx.seed, act.id, i, Math.floor(t / 9)))();
        o.clip = r < 0.5 ? 'idle' : r < 0.75 ? 'clap' : r < 0.9 ? 'laugh' : 'dance'; o.time = t + i;
      }
    },
  };
}

/** Activity kinds added by other modules (e.g. src/scene/crowd/crowdClub.ts): kind -> plan builder. */
export const EXTRA_PLANS: Record<string, (act: CrowdActivity) => ActivityPlan> = {};

export function planFor(act: CrowdActivity): ActivityPlan {
  const extra = EXTRA_PLANS[act.kind];
  if (extra) return extra(act);
  switch (act.kind) {
    case 'band': return band(act);
    case 'dive': return dive(act);
    case 'conga': return conga(act);
    case 'armwrestle': return armwrestle(act);
    case 'swim': return swim(act);
    case 'hop': return hop(act);
    case 'canoe': return canoe(act);
    case 'climb': return climb(act);
    case 'juggle': return juggle(act);
    case 'fish': return fish(act);
    case 'dj': return dj(act);
    case 'sleep': return sleep(act);
    default: return idleSpot(act);
  }
}

// ------------------------------------------------------------------------------------------ rotation groups
export interface GroupTurn { active: number; u: number; turn: number; k: number }
export function groupTurn(seed: number, group: string, n: number, t: number, turn: number, force?: number): GroupTurn {
  const off = (hash32(seed, 'grp', group) % 1000) / 1000 * turn;
  const x = t + off, k = Math.floor(x / turn);
  const active = force !== undefined && force >= 0 ? force % n : ((k % n) + n) % n;
  return { active, u: force !== undefined && force >= 0 ? 60 : x - k * turn, turn, k };
}

/** wrap an activity's pose with the group turn's entrance (hop out of the water) / exit (hop in) */
export function turnWrap(o: Pose, i: number, g: GroupTurn, water: THREE.Vector3 | null, waterY: number, scale: number, fx: FxOut[]) {
  const ENTER = 4.5, EXIT = 4.5;
  const te = g.u - 0.45 * i;
  const tx = g.u - (g.turn - EXIT) - 0.45 * i;
  const under = (p: THREE.Vector3) => (water ? new THREE.Vector3(water.x, waterY + SWIM_Y * scale - 0.5, water.z) : new THREE.Vector3(p.x, p.y - 1.1 * scale, p.z));
  if (g.u < ENTER) {
    if (te < 0) { o.hidden = true; return; }
    if (te < 1.0) {
      const a = under(o.pos), b = o.pos.clone();
      o.pos.lerpVectors(a, b, te); o.pos.y += water ? 0.9 * Math.sin(Math.PI * te) : 0;
      o.clip = water ? 'hop' : o.clip; o.time = water ? te * 0.8 : o.time; o.busy = true; o.tags = 0;
      if (water) o.yaw = Math.atan2(b.x - a.x, b.z - a.z);
      if (te < 0.3) fx.push({ kind: 'splash', pos: new THREE.Vector3(water ? water.x : b.x, waterY, water ? water.z : b.z), age: te, size: 0.7 });
    }
  } else if (tx >= 0) {
    if (tx >= 1.0) { o.hidden = true; if (tx < 2.0) fx.push({ kind: 'splash', pos: new THREE.Vector3(water ? water.x : o.pos.x, waterY, water ? water.z : o.pos.z), age: tx - 1.0, size: 0.8 }); return; }
    const a = o.pos.clone(), b = under(a);
    o.pos.lerpVectors(a, b, tx); o.pos.y += water ? 0.9 * Math.sin(Math.PI * tx) : 0;
    o.clip = water ? 'hop' : o.clip; o.time = water ? tx * 0.8 : o.time; o.busy = true; o.tags = 0;
    if (water) o.yaw = Math.atan2(b.x - a.x, b.z - a.z);
  }
}
