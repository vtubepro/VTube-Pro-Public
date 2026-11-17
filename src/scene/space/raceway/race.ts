// Raceway — the endless race, closed-form in wall-clock time (every page draws the same race: no simulation state).
//
// All racers share one mean speed; each rides two slow, seeded speed waves on top (amplitude ≤ 45 % of the mean, so
// they never stop or reverse): positions reshuffle all the time (real overtakes, never lapped for good). A heat is a
// fixed slice of the clock (HEAT s): whoever leads at its end wins it (the board + PA call it). Crashes are seeded per
// slot: a racer veers off the line into a RACE_CRASH rock, explodes, and rejoins later (a small quantum flash).
// A victory lap (support event) sends a showboat racer slowly past the glass with a banner.
import * as THREE from 'three';
import { hash32, Rng } from '../../raid/rng.ts';
import type { RacewayRoom, Anchor } from './racewayRoom.ts';

type V3 = THREE.Vector3;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number) => { const k = clamp01(v); return k * k * (3 - 2 * k); };
export const HEAT = 150;                // s per heat
const RACER_KINDS = ['RACER_A', 'RACER_B', 'RACER_C'];
const LIVERIES: [string, string][] = [['#e8402a', '#f2f2f2'], ['#2a7ae8', '#f2c230'], ['#f2c230', '#1a1a1a'], ['#34d07a', '#1a1a1a'], ['#e83ac0', '#ffffff'],
  ['#f28a2a', '#2a2a3a'], ['#ffffff', '#e8402a'], ['#8a4ae8', '#3ae6ff'], ['#1a1a1a', '#f2c230'], ['#3ae6ff', '#1a2a4a']];

export interface Racer { i: number; pilot: string; kind: string; c1: THREE.Color; c2: THREE.Color; v: number; a1: number; w1: number; p1: number; a2: number; w2: number; p2: number; off: number; odds: string }
export interface CrashPlan { racer: number; t0: number; tc: number; rejoin: number; hit: V3; n: V3; sHit: number }
export interface RacerState { pos: V3; quat: THREE.Quaternion; s: number; lap: number; frac: number; alive: boolean; fade: number; heat: number; crash: CrashPlan | null }

const _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _x = V(), _y = V(), _z = V();
export function orient(fwd: V3, up: V3, out = new THREE.Quaternion()) {
  _z.copy(fwd).normalize(); _x.crossVectors(up, _z);
  if (_x.lengthSq() < 1e-8) _x.crossVectors(Math.abs(_z.x) < 0.9 ? V(1, 0, 0) : V(0, 0, 1), _z);
  _x.normalize(); _y.crossVectors(_z, _x);
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}

/** the racing line: a closed centripetal spline, arc-length sampled into a table (fast lookups, banking). */
export class Course {
  readonly L: number;
  private N = 2400;
  private P: Float32Array; private T: Float32Array; private U: Float32Array;
  readonly gateS: { g: number; s: number }[] = [];
  constructor(readonly R: RacewayRoom) {
    const curve = new THREE.CatmullRomCurve3(R.path, true, 'centripetal');
    curve.arcLengthDivisions = 800;
    this.L = curve.getLength();
    const N = this.N;
    this.P = new Float32Array(N * 3); this.T = new Float32Array(N * 3); this.U = new Float32Array(N * 3);
    const p = V(), t = V(), tp = V(), tn = V();
    for (let i = 0; i < N; i++) {
      const u = i / N;
      curve.getPointAt(u, p); curve.getTangentAt(u, t);
      curve.getTangentAt((u + 1 - 0.004) % 1, tp); curve.getTangentAt((u + 0.004) % 1, tn);
      const lat = tn.sub(tp); lat.addScaledVector(t, -lat.dot(t));
      const up = V(0, 1, 0).addScaledVector(lat, 5.5).normalize();
      this.P.set([p.x, p.y, p.z], i * 3); this.T.set([t.x, t.y, t.z], i * 3); this.U.set([up.x, up.y, up.z], i * 3);
    }
    for (const g of R.gates) this.gateS.push({ g: g.g, s: this.nearestS(g.pos) });
    this.gateS.sort((a, b) => a.s - b.s);
  }
  private idx(s: number) { const u = (((s / this.L) % 1) + 1) % 1 * this.N; const i = Math.floor(u); return [i % this.N, (i + 1) % this.N, u - i] as const; }
  at(s: number, out = V()) { const [a, b, f] = this.idx(s); const P = this.P; return out.set(P[a * 3] + (P[b * 3] - P[a * 3]) * f, P[a * 3 + 1] + (P[b * 3 + 1] - P[a * 3 + 1]) * f, P[a * 3 + 2] + (P[b * 3 + 2] - P[a * 3 + 2]) * f); }
  tan(s: number, out = V()) { const [a, b, f] = this.idx(s); const T = this.T; return out.set(T[a * 3] + (T[b * 3] - T[a * 3]) * f, T[a * 3 + 1] + (T[b * 3 + 1] - T[a * 3 + 1]) * f, T[a * 3 + 2] + (T[b * 3 + 2] - T[a * 3 + 2]) * f).normalize(); }
  up(s: number, out = V()) { const [a, b, f] = this.idx(s); const U = this.U; return out.set(U[a * 3] + (U[b * 3] - U[a * 3]) * f, U[a * 3 + 1] + (U[b * 3 + 1] - U[a * 3 + 1]) * f, U[a * 3 + 2] + (U[b * 3 + 2] - U[a * 3 + 2]) * f).normalize(); }
  nearestS(p: V3) {
    let best = 0, bd = Infinity; const q = V();
    for (let i = 0; i < this.N; i += 2) { q.set(this.P[i * 3], this.P[i * 3 + 1], this.P[i * 3 + 2]); const d = q.distanceToSquared(p); if (d < bd) { bd = d; best = i; } }
    return best / this.N * this.L;
  }
}

export class Race {
  readonly racers: Racer[] = [];
  readonly v: number;
  private crashCache = new Map<number, CrashPlan | null>();
  constructor(readonly course: Course, readonly seed: number, count: number, speed: number, pilots: string[], readonly crashEvery: [number, number]) {
    this.v = speed;
    const r = new Rng(hash32(seed, 'racers'));
    const names = [...pilots];
    for (let i = names.length - 1; i > 0; i--) { const j = r.int(i + 1); [names[i], names[j]] = [names[j], names[i]]; }
    const n = Math.max(2, Math.min(10, count));
    for (let i = 0; i < n; i++) {
      const [a, b] = LIVERIES[(i + r.int(3)) % LIVERIES.length];
      // two seeded speed waves; their peak speed deltas (a·w) add up to at most ~40 % of the mean: never stops, never reverses
      const w1 = 2 * Math.PI / r.range(80, 115), w2 = 2 * Math.PI / r.range(26, 41);
      const a1 = r.range(0.14, 0.26) * speed / w1, a2 = r.range(0.05, 0.12) * speed / w2;
      const k = Math.min(1, (0.4 * speed) / (a1 * w1 + a2 * w2));
      this.racers.push({ i, pilot: names[i % names.length] ?? `RACER ${i + 1}`, kind: RACER_KINDS[(i + r.int(2)) % RACER_KINDS.length],
        c1: new THREE.Color(a), c2: new THREE.Color(b), v: speed, a1: a1 * k, w1, p1: r.next() * 6.283, a2: a2 * k, w2, p2: r.next() * 6.283,
        off: -i * r.range(55, 80), odds: ['2:1', '5:2', '3:1', '4:1', '6:1', '7:2', '9:1', '12:1', '20:1', '40:1'][(i * 3 + r.int(4)) % 10] });
    }
  }

  /** arc length of racer i at time t (s, wall clock) — monotonic. */
  s(i: number, t: number) { const R = this.racers[i]; return R.v * t + R.a1 * Math.sin(R.w1 * t + R.p1) + R.a2 * Math.sin(R.w2 * t + R.p2) + R.off; }
  speedAt(i: number, t: number) { const R = this.racers[i]; return R.v + R.a1 * R.w1 * Math.cos(R.w1 * t + R.p1) + R.a2 * R.w2 * Math.cos(R.w2 * t + R.p2); }
  /** time (≥ t0) when racer i reaches arc length S (bisection on the monotonic s). */
  timeAt(i: number, S: number, t0: number) {
    let lo = t0, hi = t0 + 1;
    while (this.s(i, hi) < S) hi = lo + (hi - lo) * 2;
    for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (this.s(i, m) < S) lo = m; else hi = m; }
    return hi;
  }
  /** the crash planned in slot k (or null): which racer, when it leaves the line, where it hits. */
  crash(k: number, R: RacewayRoom): CrashPlan | null {
    if (this.crashCache.has(k)) return this.crashCache.get(k)!;
    let plan: CrashPlan | null = null;
    const [a, b] = this.crashEvery;
    const slot = (a + b) / 2;
    const r = new Rng(hash32(this.seed, k, 'crash'));
    if (R.crash.length && r.chance(0.8)) {
      const racer = r.int(this.racers.length);
      const c: Anchor = R.crash[r.int(R.crash.length)];
      const t0 = k * slot + r.range(0, Math.max(1, b - a));
      const sHit0 = this.course.nearestS(c.pos);
      const L = this.course.L;
      // the first time after t0 that the racer passes the crash rock's stretch (3 s before it = where it veers off)
      const cur = this.s(racer, t0);
      const lapBase = Math.floor(cur / L) * L;
      let S = lapBase + sHit0; if (S < cur + this.v * 2) S += L;
      const tc = this.timeAt(racer, S, t0);
      plan = { racer, t0: tc - 1.6, tc, rejoin: tc + 16 + r.range(0, 8), hit: c.pos.clone(), n: c.fwd.clone(), sHit: S };
    }
    this.crashCache.set(k, plan);
    if (this.crashCache.size > 64) this.crashCache.delete(this.crashCache.keys().next().value!);
    return plan;
  }
  crashSlot() { return (this.crashEvery[0] + this.crashEvery[1]) / 2; }

  /** every racer's pose at time t (s). */
  sample(t: number, R: RacewayRoom, out: RacerState[]) {
    const C = this.course, L = C.L;
    const slot = this.crashSlot();
    const k0 = Math.floor(t / slot);
    const crashes = [this.crash(k0 - 2, R), this.crash(k0 - 1, R), this.crash(k0, R)].filter((c): c is CrashPlan => !!c && t >= c.t0 - 0.1 && t < c.rejoin + 1.5);
    for (let i = 0; i < this.racers.length; i++) {
      const o = out[i] ??= { pos: V(), quat: new THREE.Quaternion(), s: 0, lap: 0, frac: 0, alive: true, fade: 1, heat: 0, crash: null };
      const s = this.s(i, t);
      o.s = s; o.lap = Math.floor(s / L); o.frac = (s / L) - o.lap; o.alive = true; o.fade = 1; o.heat = 0; o.crash = null;
      C.at(s, o.pos);
      const fwd = C.tan(s);
      const up = C.up(s);
      // racing wobble: a little lateral weave and a roll into it
      const weave = Math.sin(t * 0.9 + i * 1.7) * 3.2 + Math.sin(t * 2.3 + i) * 0.8;
      const side = V().crossVectors(up, fwd).normalize();
      o.pos.addScaledVector(side, weave).addScaledVector(up, Math.sin(t * 0.7 + i * 2.1) * 1.6);
      orient(fwd, up, o.quat);
      o.quat.multiply(_q.setFromAxisAngle(V(0, 0, 1), Math.cos(t * 0.9 + i * 1.7) * 0.25));
      const c = crashes.find((x) => x.racer === i);
      if (c) {
        o.crash = c;
        if (t < c.tc) {
          // veer off the line into the rock (ease-in), tumbling
          const u = smooth((t - c.t0) / (c.tc - c.t0));
          const onLine = C.at(Math.min(s, c.sHit), V());
          o.pos.copy(onLine).lerp(c.hit, u * u);
          o.quat.multiply(_q.setFromAxisAngle(V(0, 0, 1), u * u * 5.0)).multiply(_q.setFromAxisAngle(V(1, 0, 0), u * 0.6));
          o.heat = u * 0.6;
        } else if (t < c.rejoin) { o.alive = false; o.fade = 0; }
        else { o.fade = smooth((t - c.rejoin) / 1.2); }
      }
    }
    return out;
  }

  /** standings at time t: indices sorted by progress (alive first). */
  standings(t: number, st: RacerState[]) {
    return this.racers.map((r) => r.i).sort((a, b) => (st[b].alive ? 1 : 0) - (st[a].alive ? 1 : 0) || st[b].s - st[a].s);
  }
  /** the last completed lap time of racer i before t (s), or null. */
  lastLap(i: number, t: number) {
    const L = this.course.L;
    const s = this.s(i, t);
    const lap = Math.floor(s / L);
    if (lap < 1) return null;
    const a = this.timeAt(i, lap * L, t - 200), b0 = this.timeAt(i, (lap - 1) * L, t - 400);
    return a - b0;
  }
  /** heat number of the day (1 … 576), from the UTC day's clock */
  heatOf(t: number) { return Math.floor(t / HEAT); }
  heatLabel(h: number) { return (((h % 576) + 576) % 576) + 1; }
  /** the winner of heat h (the leader at its end). */
  winner(h: number, R: RacewayRoom) {
    const t = (h + 1) * HEAT - 0.01;
    const st: RacerState[] = [];
    this.sample(t, R, st);
    return this.standings(t, st)[0];
  }
}
