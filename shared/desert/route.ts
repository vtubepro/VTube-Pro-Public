// The voyage route across the desert: a closed-form curve of journey distance d (metres). the walking-ship SPEC D9 +
// section 2.4 ("Route"):
//   - 2 km route segments ("legs" in this file; SPEC D6 calls them route segments). Segment j turns at constant
//     curvature by dpsi_j = clamp(-0.35 (psi_j - psiBar) + 25deg (2 h(seed, j) - 1), +-25deg), mean-reverting towards the
//     base heading psiBar, and psi stays inside psiBar +- 45deg (the MZ0 acceptance bound: the AR(1) step alone leaves it
//     now and then, so psi is clamped there too). Monotone along the base direction (cos >= 0.7): the route never
//     crosses itself and "which route point is near me" is a binary search over cached samples.
//   - Positions are exact arc integrals; segment starts are prefix-cached in float64. d may be negative (the trail behind).
//   - Floating origin O(d) = snap1024(P(segment start)): a PURE function of d (every page holds the same origin at the
//     same d, whatever it showed before), changing once per 2 km segment (SPEC 2.4 "Floating origin").
//   - heading convention: forward f(h) = (sin h, -cos h) in world (x, z); h = 0 walks towards -Z. The room frame has
//     the ship's bow at -Z, so the world group rotation about +Y is exactly the heading (see src/scene/desert/index.ts).
//   - Input guard: d is clamped to +-MAX_ROUTE_D and NaN reads as 0 (a bad distance must never grow the caches without
//     bound or poison the origin).
// Pure + deterministic: every page computes the same route from (seed, d).
import { mod, rnd } from './noise.ts';

export const LEG = 2000;
/** Corridor polyline spacing (m): route samples P(k * ROUTE_STEP), shared by the CPU height and the GPU twin. */
export const ROUTE_STEP = 200;
/** Max deviation of the route heading from the base heading (rad): SPEC MZ0 "psiBar +- 45 deg". */
export const ROUTE_SPREAD = (45 * Math.PI) / 180;
/** Max heading change per 2 km segment (rad): SPEC D9 "+-25 deg". */
export const ROUTE_TURN = (25 * Math.PI) / 180;
/** Floating-origin grid (m). */
export const ORIGIN_SNAP = 1024;
/** Journey distances beyond +-MAX_ROUTE_D (10,000 km) are clamped (a units / epoch mix-up must not stall the tab). */
export const MAX_ROUTE_D = 1e7;
/** Legs kept before d = 0 (128 km of trail). */
const JOFF = 64;
/** Cached corridor samples start at k = -KOFF (the start of leg 0). */
const KOFF = (JOFF * LEG) / ROUTE_STEP;
/** (squared) route distance from which dist() searches the wide window */
const FAR_DIST2 = 500 * 500;

/** A finite journey distance inside +-MAX_ROUTE_D (NaN -> 0). */
export function safeD(d: number): number {
  if (d !== d) return 0;
  return d > MAX_ROUTE_D ? MAX_ROUTE_D : d < -MAX_ROUTE_D ? -MAX_ROUTE_D : d;
}

export interface RoutePoint { x: number; z: number; heading: number; curv: number }

export class DesertRoute {
  readonly seed: number;
  /** Base heading (rad) the route meanders around. */
  readonly base: number;
  readonly maxTurn: number;
  private th: number[] = [];
  private kap: number[] = [];
  private px: number[] = [];
  private pz: number[] = [];
  private ox = 0;
  private oz = 0;
  /** Unit base direction in world (x, z) (the along axis the route is monotone on). */
  private readonly bx: number;
  private readonly bz: number;

  constructor(seed: number, opts?: { base?: number; maxTurnDeg?: number }) {
    this.seed = seed >>> 0;
    this.base = opts?.base ?? rnd(this.seed, 71) * Math.PI * 2;
    this.maxTurn = opts?.maxTurnDeg !== undefined ? (opts.maxTurnDeg * Math.PI) / 180 : ROUTE_TURN;
    this.bx = Math.sin(this.base); this.bz = -Math.cos(this.base);
    this.th.push(this.base); this.px.push(0); this.pz.push(0);
    this.ensure(JOFF + 1);
    this.ox = this.px[JOFF]; this.oz = this.pz[JOFF];
    this.sample(16);
  }

  /** Make legs 0..j available (each leg needs its start heading, curvature and start position). */
  private ensure(j: number) {
    while (this.kap.length <= j) {
      const i = this.kap.length;
      const t0 = this.th[i];
      const raw = -0.35 * (t0 - this.base) + this.maxTurn * (2 * rnd(this.seed, i - JOFF, 72) - 1);
      const want = Math.min(this.maxTurn, Math.max(-this.maxTurn, raw));
      const t1 = Math.min(this.base + ROUTE_SPREAD, Math.max(this.base - ROUTE_SPREAD, t0 + want));
      const k = (t1 - t0) / LEG;
      this.kap.push(k);
      this.th.push(t1);
      arc(t0, k, LEG);
      this.px.push(this.px[i] + AX); this.pz.push(this.pz[i] + AZ);
    }
  }

  private lj = 0;
  private ls = 0;
  /** Leg index + distance into it (written to lj / ls: no allocation on the hot path). */
  private leg(d: number) {
    d = safeD(d);
    let j = Math.floor(d / LEG) + JOFF;
    let s = d - (j - JOFF) * LEG;
    if (j < 0) { s += j * LEG; j = 0; }           // before the first leg: extend leg 0 backwards
    if (j + 1 >= this.kap.length) this.ensure(j + 1);
    this.lj = j; this.ls = s;
  }

  /** Position (world, float64), heading and curvature at journey distance d. */
  at(d: number, out: RoutePoint = { x: 0, z: 0, heading: 0, curv: 0 }): RoutePoint {
    this.leg(d);
    const j = this.lj, s = this.ls;
    const t0 = this.th[j], k = this.kap[j];
    arc(t0, k, s);
    out.x = this.px[j] + AX - this.ox; out.z = this.pz[j] + AZ - this.oz;
    out.heading = t0 + k * s; out.curv = k;
    return out;
  }

  heading(d: number): number { this.leg(d); return this.th[this.lj] + this.kap[this.lj] * this.ls; }

  /** Floating origin O(d) = snap1024(P(start of the 2 km segment holding d)): pure in d (SPEC 2.4). */
  originAt(d: number, out: { x: number; z: number } = { x: 0, z: 0 }): { x: number; z: number } {
    const s0 = Math.floor(safeD(d) / LEG) * LEG;
    const p = this.at(s0, this.tmpO);
    out.x = Math.round(p.x / ORIGIN_SNAP) * ORIGIN_SNAP; out.z = Math.round(p.z / ORIGIN_SNAP) * ORIGIN_SNAP;
    return out;
  }
  private tmpO: RoutePoint = { x: 0, z: 0, heading: 0, curv: 0 };

  // ---- corridor samples P(k * ROUTE_STEP), k >= -KOFF: x, z and the coordinate along the base direction (monotone)
  private sx = new Float64Array(1024);
  private sz = new Float64Array(1024);
  private sa = new Float64Array(1024);
  private sn = 0;
  private sample(k: number): void {
    const i = k + KOFF;
    while (this.sn <= i) {
      if (this.sn >= this.sx.length) {
        const g = (a: Float64Array) => { const b = new Float64Array(a.length * 2); b.set(a); return b; };
        this.sx = g(this.sx); this.sz = g(this.sz); this.sa = g(this.sa);
      }
      const p = this.at((this.sn - KOFF) * ROUTE_STEP, this.tmpS);
      this.sx[this.sn] = p.x; this.sz[this.sn] = p.z; this.sa[this.sn] = p.x * this.bx + p.z * this.bz;
      this.sn++;
    }
  }
  private tmpS: RoutePoint = { x: 0, z: 0, heading: 0, curv: 0 };

  /** Journey distance of the route point nearest-ish to world (x, z): solves along(d) = along(x, z) on the base axis. */
  param(x: number, z: number): number {
    const bx = this.bx, bz = this.bz;
    const target = x * bx + z * bz;
    if (target !== target) return 0;
    let d = target;
    const p = this.tmpA;
    for (let it = 0; it < 8; it++) {
      this.at(d, p);
      const a = p.x * bx + p.z * bz;
      const step = (target - a) / Math.max(0.5, Math.cos(p.heading - this.base));
      d += step;
      if (Math.abs(step) < 1e-3) break;
    }
    return d;
  }
  private tmpA: RoutePoint = { x: 0, z: 0, heading: 0, curv: 0 };
  private tmpB: RoutePoint = { x: 0, z: 0, heading: 0, curv: 0 };

  /** Distance from world (x, z) to the corridor polyline (route samples every ROUTE_STEP m): the 8 segments around
   *  kc = floor(param(x, z) / ROUTE_STEP), found by a binary search over cached samples (no trig on the hot path). */
  dist(x: number, z: number): number {
    const t = x * this.bx + z * this.bz;
    if (!(t > this.sa[0])) return this.distSlow(x, z);
    if (this.sa[this.sn - 1] <= t) {
      // extend lazily (cos >= 0.7: one sample per <= 200 m of along-distance and >= 140 m)
      const k = Math.ceil(t / (ROUTE_STEP * 0.7)) + 8;
      if (!(k < MAX_ROUTE_D / ROUTE_STEP + 64)) return this.distSlow(x, z);
      this.sample(Math.max(k, this.sn - KOFF + 8));
      if (this.sa[this.sn - 1] <= t || t < this.sa[0]) return this.distSlow(x, z);
    }
    let lo = 0, hi = this.sn - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.sa[m] <= t) lo = m; else hi = m; }
    if (lo < 3) return this.distSlow(x, z);
    this.sample(lo - KOFF + 5);
    const sx = this.sx, sz = this.sz;
    let best = Infinity;
    const seg = (i0: number, i1: number) => {
      for (let i = i0; i <= i1; i++) {
        const ax = sx[i], az = sz[i], ex = sx[i + 1] - ax, ez = sz[i + 1] - az, wx = x - ax, wz = z - az;
        const l2 = ex * ex + ez * ez;
        const u = l2 > 0 ? Math.min(1, Math.max(0, (wx * ex + wz * ez) / l2)) : 0;
        const dx = wx - ex * u, dz = wz - ez * u, q = dx * dx + dz * dz;
        if (q < best) best = q;
      }
    };
    seg(lo - 3, lo + 4);
    // far from the route (the relief's band): the nearest chord can lie well along it - search +-3.2 km like the GPU's
    // corridor window does (near the route nothing changes)
    if (best > FAR_DIST2 && lo >= 17) { this.sample(lo - KOFF + 19); seg(lo - 16, lo - 4); seg(lo + 5, lo + 16); }
    return Math.sqrt(best);
  }

  /** The same distance through param() (Newton on the base axis): behind the cached trail or for absurd inputs. */
  distSlow(x: number, z: number): number {
    const kc = Math.floor(this.param(x, z) / ROUTE_STEP);
    let best = Infinity;
    const a = this.tmpA, b = this.tmpB;
    this.at((kc - 3) * ROUTE_STEP, a);
    for (let k = kc - 3; k <= kc + 4; k++) {
      this.at((k + 1) * ROUTE_STEP, b);
      best = Math.min(best, segDist(x, z, a.x, a.z, b.x, b.z));
      a.x = b.x; a.z = b.z;
    }
    // (the same wide window as dist() far from the route)
    if (best * best > FAR_DIST2) {
      this.at((kc - 16) * ROUTE_STEP, a);
      for (let k = kc - 16; k <= kc + 16; k++) {
        this.at((k + 1) * ROUTE_STEP, b);
        best = Math.min(best, segDist(x, z, a.x, a.z, b.x, b.z));
        a.x = b.x; a.z = b.z;
      }
    }
    return best;
  }

  /** n route samples P(k * ROUTE_STEP) around journey distance dc (the GPU's corridor window), x/z interleaved,
   *  relative to (ox, oz). Returns the first sample index k0. */
  polyline(dc: number, n: number, out: Float64Array | Float32Array, ox = 0, oz = 0, step = ROUTE_STEP): number {
    const k0 = Math.floor(dc / step) - (n >> 1) + 1;
    const p: RoutePoint = { x: 0, z: 0, heading: 0, curv: 0 };
    for (let i = 0; i < n; i++) { this.at((k0 + i) * step, p); out[2 * i] = p.x - ox; out[2 * i + 1] = p.z - oz; }
    return k0;
  }

  /** Room frame (bow -Z, +X starboard) offset -> world offset at heading h. */
  static toWorld(h: number, rx: number, rz: number): [number, number] {
    const c = Math.cos(h), s = Math.sin(h);
    return [rx * c - rz * s, rx * s + rz * c];
  }
  /** World offset -> room frame offset at heading h. */
  static toRoom(h: number, wx: number, wz: number): [number, number] {
    const c = Math.cos(h), s = Math.sin(h);
    return [wx * c + wz * s, -wx * s + wz * c];
  }
}

let AX = 0, AZ = 0;
/** Displacement after walking s metres from heading t0 at curvature k (exact arc integral) -> AX, AZ. */
function arc(t0: number, k: number, s: number) {
  if (Math.abs(k * s) < 1e-7) {
    const tm = t0 + 0.5 * k * s;
    AX = s * Math.sin(tm); AZ = -s * Math.cos(tm);
    return;
  }
  const t1 = t0 + k * s;
  AX = (Math.cos(t0) - Math.cos(t1)) / k; AZ = -(Math.sin(t1) - Math.sin(t0)) / k;
}

export function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const ex = bx - ax, ez = bz - az, wx = px - ax, wz = pz - az;
  const l2 = ex * ex + ez * ez;
  const t = l2 > 0 ? Math.min(1, Math.max(0, (wx * ex + wz * ez) / l2)) : 0;
  const dx = wx - ex * t, dz = wz - ez * t;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Shortest signed angle a - b in (-pi, pi]. */
export const angDiff = (a: number, b: number) => mod(a - b + Math.PI, Math.PI * 2) - Math.PI;
