// The Trail v2 — the procedural journey (DESIGN_V2.md §4). Pure, deterministic functions of (seed, route, theme):
// every PC (the host's sim worker, each guest's view, the OBS page) regenerates the same world; no terrain crosses the
// network. No three.js here (runs in workers and Node).
//
//   plan = planJourney({ seed, theme, route, biomes })     → nodes, roads (with forks), creeks, clearings, modules
//   heightAt(plan, x, z)                                     → terrain height (exact; the wagon + physics use it)
//   genChunk(plan, cx, cz)                                   → a 64 m chunk: heights, colour masks, water, scatter
//   roadInfo(plan, x, z)                                     → nearest road: distance, path, progress (m), miles
//
// World axes: metres, +Y up; the journey heads roughly +Z (north) with wander. Chunks are CHUNK × CHUNK m, heights at
// 1 m (CHUNK + 1 samples a side), chunk (cx, cz) spans x ∈ [cx·CHUNK, (cx+1)·CHUNK].
import { Rng, hash32 } from './rng.ts';

export const CHUNK = 64;
export const RES = 1;
export const N = CHUNK / RES + 1;          // samples per side
/** One trail mile of road, in metres (a day at a steady pace ≈ 15 mi ≈ 180 m of road). */
export const MILE_M = 9;
export const ROAD_HALF = 2.4, SHOULDER = 5.0;
const STEP = 4;

// ---------------------------------------------------------------- noise (value noise + fBm), seeded
function h2(seed: number, x: number, z: number): number {
  let h = (seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(z, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function vnoise(seed: number, x: number, z: number): number {
  const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = h2(seed, xi, zi), b = h2(seed, xi + 1, zi), c = h2(seed, xi, zi + 1), d = h2(seed, xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;   // 0..1
}
function fbm(seed: number, x: number, z: number, oct: number): number {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { s += a * (vnoise(seed + i * 1013, x * f, z * f) * 2 - 1); n += a; a *= 0.5; f *= 2.03; }
  return s / n;   // −1..1
}
const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------- biomes
export interface BiomeParams {
  id: string;
  /** Height amplitude (m), feature size (m), ridge-ness 0..1, pool / mud frequency. */
  amp: number; scale: number; ridge: number; mud: number; pools: number;
  /** Floating islands over a cloud sea (Skyisles): ground outside the island mask drops away. */
  islands: boolean;
  /** Vertex colours (hex): ground, grass, mud, rock, road, shoulder. */
  colors: { ground: string; grass: string; mud: string; rock: string; road: string; shoulder: string; water: string };
  /** Scatter roles: role → density (per 100 m²) and whether it's solid (tree trunk / rock / ruin). */
  scatter: { role: ScatterRole; density: number; solid: boolean; r: number; min: number; max: number; nearRoad?: number }[];
}
export type ScatterRole = 'tree' | 'tree_small' | 'bush' | 'rock' | 'reed' | 'flower' | 'ruin' | 'junk' | 'fence' | 'crystal' | 'cloud';

const SC = (role: ScatterRole, density: number, solid: boolean, r: number, min = 0.8, max = 1.3, nearRoad?: number) => ({ role, density, solid, r, min, max, nearRoad });
function biomeParams(theme: string, idx: number, id: string): BiomeParams {
  const bong = theme === 'bayou', leaf = theme === 'skyisles';
  if (bong) return [
    { id, amp: 2.2, scale: 70, ridge: 0.1, mud: 0.35, pools: 0.4, islands: false, colors: { ground: '#4a5d2c', grass: '#5d7a33', mud: '#4b3a26', rock: '#6a665a', road: '#6e5a3c', shoulder: '#5b5230', water: '#3f6b3a' },
      scatter: [SC('tree', 0.55, true, 0.6, 0.8, 1.4), SC('tree_small', 0.5, true, 0.35), SC('reed', 2.2, false, 0), SC('bush', 1.2, false, 0), SC('rock', 0.25, true, 0.8, 0.6, 1.5), SC('junk', 0.08, true, 0.6, 1, 1, 14), SC('fence', 0.06, true, 0.3, 1, 1, 9)] },
    { id, amp: 1.2, scale: 90, ridge: 0, mud: 0.7, pools: 0.25, islands: false, colors: { ground: '#6b5b3c', grass: '#77734a', mud: '#4a3824', rock: '#7a7266', road: '#7d6848', shoulder: '#6a5b3c', water: '#56603a' },
      scatter: [SC('tree', 0.12, true, 0.6), SC('bush', 0.6, false, 0), SC('rock', 0.4, true, 0.8, 0.6, 1.6), SC('junk', 0.15, true, 0.6, 1, 1, 16), SC('reed', 0.6, false, 0), SC('fence', 0.08, true, 0.3, 1, 1, 9)] },
    { id, amp: 9, scale: 110, ridge: 0.45, mud: 0.15, pools: 0.1, islands: false, colors: { ground: '#3d5a3a', grass: '#4f7a3d', mud: '#44372a', rock: '#69647a', road: '#6e5d4a', shoulder: '#4f5638', water: '#3a6a5a' },
      scatter: [SC('tree', 0.35, true, 0.6), SC('crystal', 0.3, true, 0.5, 0.7, 2.0), SC('bush', 0.9, false, 0), SC('rock', 0.4, true, 0.9, 0.6, 1.8), SC('flower', 1.5, false, 0), SC('junk', 0.05, true, 0.6, 1, 1, 14)] },
  ][Math.min(2, idx)] as BiomeParams;
  if (leaf) return [
    { id, amp: 3.5, scale: 80, ridge: 0.15, mud: 0.05, pools: 0.05, islands: true, colors: { ground: '#9fd08a', grass: '#b8e39a', mud: '#a8b08a', rock: '#d8d2c8', road: '#e8dcb8', shoulder: '#c8d8a0', water: '#e8eeff' },
      scatter: [SC('tree', 0.35, true, 0.6), SC('flower', 2.5, false, 0), SC('bush', 0.8, false, 0), SC('ruin', 0.08, true, 0.6, 0.8, 1.4, 10), SC('rock', 0.2, true, 0.8), SC('crystal', 0.1, true, 0.5)] },
    { id, amp: 1.5, scale: 60, ridge: 0, mud: 0, pools: 0, islands: true, colors: { ground: '#c8d8e8', grass: '#d8e8f0', mud: '#b8c0d0', rock: '#e0e0ea', road: '#f0e6c8', shoulder: '#dde6ee', water: '#eef2ff' },
      scatter: [SC('cloud', 0.35, false, 0, 0.8, 2.0), SC('ruin', 0.12, true, 0.6, 0.8, 1.4, 10), SC('rock', 0.15, true, 0.8), SC('flower', 0.8, false, 0)] },
    { id, amp: 8, scale: 100, ridge: 0.5, mud: 0, pools: 0, islands: true, colors: { ground: '#6a78a8', grass: '#8a98c8', mud: '#707090', rock: '#b8b8d8', road: '#e8d8a0', shoulder: '#8088b0', water: '#cfc8f2' },
      scatter: [SC('crystal', 0.45, true, 0.5, 0.6, 1.8), SC('tree', 0.2, true, 0.6), SC('ruin', 0.15, true, 0.6), SC('rock', 0.35, true, 0.9), SC('flower', 0.8, false, 0)] },
  ][Math.min(2, idx)] as BiomeParams;
  return [
    { id, amp: 2.5, scale: 90, ridge: 0.05, mud: 0.2, pools: 0.1, islands: false, colors: { ground: '#8b7a55', grass: '#9aa35a', mud: '#5a4a33', rock: '#8a8378', road: '#9c8457', shoulder: '#8e8050', water: '#4a7fa0' },
      scatter: [SC('bush', 0.5, false, 0), SC('rock', 0.25, true, 0.8), SC('tree', 0.08, true, 0.6), SC('flower', 1.2, false, 0), SC('fence', 0.08, true, 0.3, 1, 1, 9)] },
    { id, amp: 7, scale: 110, ridge: 0.2, mud: 0.1, pools: 0.05, islands: false, colors: { ground: '#6d7a45', grass: '#7f9a4a', mud: '#524230', rock: '#7d776c', road: '#8c7650', shoulder: '#6f7040', water: '#3f6f8f' },
      scatter: [SC('tree', 0.4, true, 0.6), SC('bush', 0.8, false, 0), SC('rock', 0.35, true, 0.9), SC('flower', 0.8, false, 0)] },
    { id, amp: 16, scale: 140, ridge: 0.6, mud: 0.05, pools: 0.02, islands: false, colors: { ground: '#6a6a6a', grass: '#6d7d58', mud: '#4a4038', rock: '#8a8a90', road: '#7a6a55', shoulder: '#6a6a60', water: '#4a6f8a' },
      scatter: [SC('tree', 0.5, true, 0.6), SC('rock', 0.6, true, 1.0, 0.6, 2.2), SC('bush', 0.4, false, 0)] },
  ][Math.min(2, idx)] as BiomeParams;
}

// ---------------------------------------------------------------- the plan
export interface RouteNodeIn { id: string; kind: string; name: string; miles: number }
export interface PlanNode extends RouteNodeIn { x: number; z: number; /** road distance from the start (m) along the main road */ }
export interface RoadPath {
  id: string; leg: number; kind: 'main' | 'alt';
  /** xz points every ~4 m, cumulative length (m), road-surface heights */
  xs: Float32Array; zs: Float32Array; cum: Float32Array; hs: Float32Array;
  /** Miles at the first / last point (both branches of a fork map onto the same miles). */
  m0: number; m1: number;
  /** alt (fork) branches: what the signpost says + a risk multiplier for event rolls. */
  label?: string; risk?: number;
}
export interface Fork { leg: number; x: number; z: number; /** where the branches split / rejoin (miles) */ m0: number; m1: number; main: string; alt: string; labels: [string, string]; risk: [number, number] }
export interface Creek { xs: Float32Array; zs: Float32Array; half: number; depth: number; ford: number; level: number; bridge: boolean; roadX: number; roadZ: number; miles: number }
export interface Clearing { x: number; z: number; r: number; h: number; kind: 'camp' | 'fork' | 'node' | 'event'; id: string; miles: number;
  /** camp spots: the road point the driveway leaves from (no trees on the driveway) */
  rx?: number; rz?: number }
export interface WorldPlan {
  seed: string; theme: string; seedN: number;
  nodes: PlanNode[]; paths: RoadPath[]; forks: Fork[]; creeks: Creek[]; clearings: Clearing[];
  legBiome: number[]; biomes: BiomeParams[];
  /** total miles */ total: number;
  /** spatial index: cell key → segment refs [pathIndex, pointIndex] */
  segIndex: Map<number, number[]>;
  clearIndex: Map<number, number[]>;
  creekIndex: Map<number, number[]>;
}
const CELL = 32;
const ck = (x: number, z: number) => ((Math.floor(x / CELL) + 32768) << 16) | (Math.floor(z / CELL) + 32768);

export interface PlanIn { seed: string; theme: string; route: RouteNodeIn[]; biomes: { id: string; from: number }[] }

export function planJourney(o: PlanIn): WorldPlan {
  const rng = new Rng(`${o.seed}:world`);
  const seedN = hash32(`${o.seed}:terrain`);
  const route = o.route.length >= 2 ? o.route : [{ id: 'start', kind: 'start', name: 'Start', miles: 0 }, { id: 'end', kind: 'end', name: 'End', miles: 100 }];
  const total = route[route.length - 1].miles || 100;
  const biomes = (o.biomes.length ? o.biomes : [{ id: 'plains', from: 0 }]).map((b, i) => biomeParams(o.theme, i, b.id));
  const biomeAt = (mi: number) => { let k = 0; for (let i = 0; i < o.biomes.length; i++) if (mi / total >= o.biomes[i].from) k = i; return k; };
  // nodes: a chain heading +Z with lateral wander
  const nodes: PlanNode[] = [];
  let x = 0, z = 0, heading = 0;
  for (let i = 0; i < route.length; i++) {
    if (i > 0) {
      const d = Math.max(60, (route[i].miles - route[i - 1].miles) * MILE_M * 0.82);   // (the road wanders: straight-line < road length)
      heading = Math.max(-0.7, Math.min(0.7, heading * 0.4 + rng.range(-0.55, 0.55)));
      x += Math.sin(heading) * d; z += Math.cos(heading) * d;
    }
    nodes.push({ ...route[i], x, z });
  }
  const plan: WorldPlan = { seed: o.seed, theme: o.theme, seedN, nodes, paths: [], forks: [], creeks: [], clearings: [], legBiome: [], biomes, total, segIndex: new Map(), clearIndex: new Map(), creekIndex: new Map() };
  // roads, leg by leg
  for (let leg = 0; leg < nodes.length - 1; leg++) {
    const a = nodes[leg], b = nodes[leg + 1];
    const bi = biomeAt((a.miles + b.miles) / 2);
    plan.legBiome.push(bi);
    const main = walkRoad(rng, a.x, a.z, b.x, b.z, 0.9, `leg${leg}`);
    const mainPath = finishPath(plan, main, `leg${leg}`, leg, 'main', a.miles, b.miles);
    plan.paths.push(mainPath);
    // a fork on most legs longer than ~60 miles (1–2 per leg on the full route)
    const legMiles = b.miles - a.miles;
    if (legMiles >= 50 && rng.chance(0.85)) {
      const i0 = Math.floor(main.length * rng.range(0.22, 0.32)), i1 = Math.floor(main.length * rng.range(0.66, 0.78));
      const p0 = main[i0], p1 = main[i1];
      const alt = walkRoad(rng, p0[0], p0[1], p1[0], p1[1], 0.35, `alt${leg}`);   // straighter: a shortcut
      const m0 = mainPath.m0 + (mainPath.m1 - mainPath.m0) * (mainPath.cum[i0] / mainPath.cum[mainPath.cum.length - 1]);
      const m1 = mainPath.m0 + (mainPath.m1 - mainPath.m0) * (mainPath.cum[i1] / mainPath.cum[mainPath.cum.length - 1]);
      const t = FORK_LABELS[o.theme] ?? FORK_LABELS.frontier;
      const pick = t[rng.int(0, t.length - 1)];
      const altPath = finishPath(plan, alt, `alt${leg}`, leg, 'alt', m0, m1);
      const e = altPath.hs.length - 1, B = Math.min(20, Math.floor(e / 3));
      for (let k = 0; k <= B; k++) {
        const w = 1 - k / B;
        altPath.hs[k] = altPath.hs[k] * (1 - w) + mainPath.hs[i0] * w;
        altPath.hs[e - k] = altPath.hs[e - k] * (1 - w) + mainPath.hs[i1] * w;
      }
      altPath.label = pick[1]; altPath.risk = 1.6; mainPath.label = pick[0]; mainPath.risk = 1;
      plan.paths.push(altPath);
      plan.forks.push({ leg, x: p0[0], z: p0[1], m0, m1, main: mainPath.id, alt: altPath.id, labels: [pick[0], pick[1]], risk: [1, 1.6] });
      plan.clearings.push({ x: p0[0], z: p0[1], r: 9, h: mainPath.hs[i0], kind: 'fork', id: `fork${leg}`, miles: m0 });
    }
    // creeks crossing the road (fords; some get a bridge), not on river legs (the river stop is the crossing there)
    const nCreek = b.kind === 'river' || a.kind === 'river' ? 0 : rng.int(0, legMiles > 80 ? 2 : 1);
    for (let c = 0; c < nCreek; c++) {
      const i = Math.floor(main.length * rng.range(0.15, 0.85));
      const [cx, cz] = main[i];
      const j = Math.min(main.length - 1, i + 1);
      const dx = main[j][0] - cx, dz = main[j][1] - cz, dl = Math.hypot(dx, dz) || 1;
      const nx = -dz / dl, nz = dx / dl;   // across the road
      const pts: [number, number][] = [];
      let wx = cx - nx * 160, wz = cz - nz * 160, wa = rng.range(-0.3, 0.3);
      for (let s = 0; s <= 80; s++) { pts.push([wx, wz]); wa += rng.range(-0.08, 0.08); wx += (nx * Math.cos(wa) - nz * Math.sin(wa)) * 4; wz += (nz * Math.cos(wa) + nx * Math.sin(wa)) * 4; }
      const depth = rng.range(0.9, 1.6), ford = rng.range(0.35, 0.95);
      const miles = mainPath.m0 + (mainPath.m1 - mainPath.m0) * (mainPath.cum[i] / mainPath.cum[mainPath.cum.length - 1]);
      plan.creeks.push({ xs: Float32Array.from(pts.map((p) => p[0])), zs: Float32Array.from(pts.map((p) => p[1])), half: rng.range(2.2, 4.5), depth, ford, level: mainPath.hs[i] - 0.15, bridge: rng.chance(0.3), roadX: cx, roadZ: cz, miles });
    }
    // camp clearings every ~300 m beside the road, alternating sides
    const L = mainPath.cum[mainPath.cum.length - 1];
    for (let d = 150, side = 1; d < L - 60; d += rng.range(240, 360), side = -side) {
      const i = indexAt(mainPath, d);
      const j = Math.min(mainPath.xs.length - 1, i + 1);
      const dx = mainPath.xs[j] - mainPath.xs[i], dz = mainPath.zs[j] - mainPath.zs[i], dl = Math.hypot(dx, dz) || 1;
      const off = 22 + rng.range(0, 8);
      const miles = mainPath.m0 + (mainPath.m1 - mainPath.m0) * (d / L);
      const cx0 = mainPath.xs[i] + (-dz / dl) * off * side, cz0 = mainPath.zs[i] + (dx / dl) * off * side;
      if (plan.clearings.some((c) => Math.hypot(c.x - cx0, c.z - cz0) < c.r + 16 + 10) || nodes.some((nn) => Math.hypot(nn.x - cx0, nn.z - cz0) < 14 + 16 + 10)) continue;
      plan.clearings.push({ x: mainPath.xs[i] + (-dz / dl) * off * side, z: mainPath.zs[i] + (dx / dl) * off * side, r: 16, h: mainPath.hs[i], kind: 'camp', id: `camp${leg}_${Math.round(d)}`, miles, rx: mainPath.xs[i], rz: mainPath.zs[i] });
    }
  }
  // stitch consecutive legs: both road ends at a node meet at one height (blended over ~80 m each side)
  const mains = plan.paths.filter((p) => p.kind === 'main').sort((p, q) => p.leg - q.leg);
  for (let k = 0; k < mains.length - 1; k++) {
    const A = mains[k], Bp = mains[k + 1], ea = A.hs.length - 1;
    const hMid = (A.hs[ea] + Bp.hs[0]) / 2, L = Math.min(20, Math.floor(ea / 3), Math.floor((Bp.hs.length - 1) / 3));
    const a0 = A.hs[ea], b0 = Bp.hs[0];
    for (let j = 0; j <= L; j++) { const w = 1 - j / L; A.hs[ea - j] += (hMid - a0) * w; Bp.hs[j] += (hMid - b0) * w; }
  }
  // the stitched main road as one chain: ≤ 10 % everywhere (the stitching made steps); alt branches pinned at both ends
  const chain = mains.flatMap((p, k) => [...p.hs].map((_, i) => ({ p, i, first: k > 0 && i === 0 })));
  for (let pass = 0; pass < 3; pass++) for (const dir of [1, -1]) {
    for (let n = dir > 0 ? 1 : chain.length - 2; dir > 0 ? n < chain.length : n >= 0; n += dir) {
      const a = chain[n - dir], b = chain[n];
      if (b.first && dir > 0) { b.p.hs[b.i] = a.p.hs[a.i]; continue; }
      const dist = a.p === b.p ? Math.abs(b.p.cum[b.i] - a.p.cum[a.i]) : 0.01;
      const lim = Math.max(0.01, dist * 0.1), ha = a.p.hs[a.i];
      b.p.hs[b.i] = Math.max(ha - lim, Math.min(ha + lim, b.p.hs[b.i]));
    }
  }
  for (let k = 0; k < mains.length - 1; k++) mains[k + 1].hs[0] = mains[k].hs[mains[k].hs.length - 1];
  for (const f of plan.forks) {
    const alt = plan.paths.find((p) => p.id === f.alt)!, e = alt.hs.length - 1, L = alt.cum[e] || 1;
    const h0 = heightOnPath(plan.paths.find((p) => p.id === f.main)!, alt.xs[0], alt.zs[0]), h1 = heightOnPath(plan.paths.find((p) => p.id === f.main)!, alt.xs[e], alt.zs[e]);
    const g = Math.max(0.1, Math.abs(h1 - h0) / L + 0.01);
    for (let i = 0; i <= e; i++) { const sI = alt.cum[i]; alt.hs[i] = Math.max(h0 - g * sI, h1 - g * (L - sI), Math.min(h0 + g * sI, h1 + g * (L - sI), alt.hs[i])); }
    for (let pass = 0; pass < 2; pass++) { for (let i = 1; i <= e; i++) { const lim = (alt.cum[i] - alt.cum[i - 1]) * g; alt.hs[i] = Math.max(alt.hs[i - 1] - lim, Math.min(alt.hs[i - 1] + lim, alt.hs[i])); } for (let i = e - 1; i >= 0; i--) { const lim = (alt.cum[i + 1] - alt.cum[i]) * g; alt.hs[i] = Math.max(alt.hs[i + 1] - lim, Math.min(alt.hs[i + 1] + lim, alt.hs[i])); } }
    alt.hs[0] = h0; alt.hs[e] = h1;
  }
  // a camp pad with another road (a fork branch, the next leg) running through it is no camp spot
  plan.clearings = plan.clearings.filter((c) => c.kind !== 'camp' || !roadInfo(plan, c.x, c.z, c.r + 5));
  for (const c of plan.clearings) { const r = roadInfo(plan, c.rx ?? c.x, c.rz ?? c.z, 40); if (r) c.h = r.h; }   // pads at the (final) road height
  // route nodes: flat pads (the stop modules park here)
  for (const n of nodes) plan.clearings.push({ x: n.x, z: n.z, r: 14, h: roadHeightNear(plan, n.x, n.z), kind: 'node', id: n.id, miles: n.miles });
  // indexes
  plan.clearings.forEach((c, i) => {
    const R = c.r + 9;
    for (let gx = Math.floor((c.x - R) / CELL); gx <= Math.floor((c.x + R) / CELL); gx++) for (let gz = Math.floor((c.z - R) / CELL); gz <= Math.floor((c.z + R) / CELL); gz++) push(plan.clearIndex, ((gx + 32768) << 16) | (gz + 32768), i);
    // the driveway (road → camp spot) is indexed too: no trees on it
    if (c.rx !== undefined && c.rz !== undefined) for (let k = 0; k <= 8; k++) { const x = c.rx + (c.x - c.rx) * k / 8, z = c.rz + (c.z - c.rz) * k / 8; for (const [ox, oz] of AROUND) push(plan.clearIndex, ck(x + ox * 5, z + oz * 5), i); }
  });
  plan.creeks.forEach((c, i) => { for (let k = 0; k < c.xs.length; k++) for (const [ox, oz] of AROUND) push(plan.creekIndex, ck(c.xs[k] + ox * 12, c.zs[k] + oz * 12), i); });
  return plan;
}
const AROUND: [number, number][] = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
function push(m: Map<number, number[]>, k: number, v: number) { const a = m.get(k); if (!a) m.set(k, [v]); else if (a[a.length - 1] !== v && !a.includes(v)) a.push(v); }

const FORK_LABELS: Record<string, [string, string][]> = {
  frontier: [['The wagon road (long, safe)', 'Shortcut over the ridge (risky)'], ['Valley road (easy)', 'Canyon cutoff (fast, bandits)']],
  bayou: [['The long way (boring, safe)', 'Shortcut thru Gator Alley (lol)'], ['Swamp road (wet)', 'Hotbox cutoff (sketchy vibes)'], ['Main drag', 'Sketchy detour (trust me bro)']],
  skyisles: [['The pilgrim road (blessed, long)', 'Wyvern pass (fast, cursed)'], ['Cloud bridge road', 'Storm shortcut (brave only)']],
};

/** A road from (ax, az) to (bx, bz): steering toward the target + smooth wander. `wander` 0..1. */
function walkRoad(rng: Rng, ax: number, az: number, bx: number, bz: number, wander: number, key: string): [number, number][] {
  const pts: [number, number][] = [[ax, az]];
  let x = ax, z = az;
  let h = Math.atan2(bx - ax, bz - az);
  const ph = rng.range(0, 100), f1 = rng.range(0.004, 0.009), f2 = rng.range(0.013, 0.025);
  void key;
  for (let s = 0; s < 20000; s++) {
    const dx = bx - x, dz = bz - z, d = Math.hypot(dx, dz);
    if (d < STEP * 1.5) break;
    const target = Math.atan2(dx, dz);
    const wig = (Math.sin(s * STEP * f1 + ph) * 0.9 + Math.sin(s * STEP * f2 + ph * 1.7) * 0.35) * wander;
    let want = target + wig * Math.min(1, d / 150);   // straighten out on arrival
    let dh = Math.atan2(Math.sin(want - h), Math.cos(want - h));
    dh = Math.max(-0.06, Math.min(0.06, dh));        // max curvature
    h += dh;
    x += Math.sin(h) * STEP; z += Math.cos(h) * STEP;
    pts.push([x, z]);
    void want;
  }
  pts.push([bx, bz]);
  return pts;
}
function finishPath(plan: WorldPlan, pts: [number, number][], id: string, leg: number, kind: 'main' | 'alt', m0: number, m1: number): RoadPath {
  const n = pts.length;
  const xs = new Float32Array(n), zs = new Float32Array(n), cum = new Float32Array(n), raw = new Float32Array(n), hs = new Float32Array(n);
  for (let i = 0; i < n; i++) { xs[i] = pts[i][0]; zs[i] = pts[i][1]; if (i) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]); }
  const bp = plan.biomes[plan.legBiome[leg] ?? 0];
  for (let i = 0; i < n; i++) raw[i] = blendedBase(plan, xs[i], zs[i]);
  // road elevation: a wide moving average of the ground, slope limited (≤ 10 %)
  for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let k = -8; k <= 8; k++) { const j = Math.min(n - 1, Math.max(0, i + k)); s += raw[j]; c++; } hs[i] = s / c; }
  for (let pass = 0; pass < 2; pass++) for (let i = 1; i < n; i++) { const d = cum[i] - cum[i - 1], lim = d * 0.1; hs[i] = Math.max(hs[i - 1] - lim, Math.min(hs[i - 1] + lim, hs[i])); }
  if (bp.islands) for (let i = 0; i < n; i++) hs[i] = Math.max(hs[i], 0.5);   // the road is always on land
  const path: RoadPath = { id, leg, kind, xs, zs, cum, hs, m0, m1 };
  const pi = plan.paths.length;
  for (let i = 0; i < n - 1; i++) {
    const x0 = Math.min(xs[i], xs[i + 1]) - SHOULDER - ROAD_HALF, x1 = Math.max(xs[i], xs[i + 1]) + SHOULDER + ROAD_HALF;
    const z0 = Math.min(zs[i], zs[i + 1]) - SHOULDER - ROAD_HALF, z1 = Math.max(zs[i], zs[i + 1]) + SHOULDER + ROAD_HALF;
    for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) for (let gz = Math.floor(z0 / CELL); gz <= Math.floor(z1 / CELL); gz++) {
      const k = ((gx + 32768) << 16) | (gz + 32768);
      const a = plan.segIndex.get(k); const ref = pi * 65536 + i;   // (the path's index is where it WILL be pushed)
      if (!a) plan.segIndex.set(k, [ref]); else a.push(ref);
    }
  }
  return path;
}
function indexAt(p: RoadPath, d: number): number { let lo = 0, hi = p.cum.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (p.cum[m] < d) lo = m + 1; else hi = m; } return lo; }

// ---------------------------------------------------------------- height
/** Terrain without roads / creeks / clearings (biome noise). */
function baseHeight(plan: WorldPlan, x: number, z: number, bp: BiomeParams): number {
  const s = plan.seedN;
  const n = fbm(s, x / bp.scale, z / bp.scale, 4);
  const r = 1 - Math.abs(fbm(s + 77, x / (bp.scale * 1.7), z / (bp.scale * 1.7), 3));
  let h = n * bp.amp * (1 - bp.ridge) + (r * r) * bp.amp * 1.4 * bp.ridge;
  // big low-frequency roll so long drives climb and descend
  h += fbm(s + 991, x / 600, z / 600, 2) * bp.amp * 1.2;
  if (bp.pools > 0) { const p = vnoise(s + 555, x / 38, z / 38); if (p > 1 - bp.pools * 0.5) h -= (p - (1 - bp.pools * 0.5)) * 6; }
  if (bp.islands) {
    const m = fbm(s + 313, x / 90, z / 90, 3);
    if (m < -0.05) h = -28 + m * 4;                    // cloud sea below (void)
    else h = Math.max(h, 0) + smooth(-0.05, 0.12, m) * 1.5;
  }
  return h;
}
/** The two nearest legs (straight node-to-node segments: cheap) + a blend weight for the nearest. */
function legsNear(plan: WorldPlan, x: number, z: number): { a: number; b: number; w: number } {
  let a = 0, b = 0, da = Infinity, db = Infinity;
  const n = plan.nodes;
  for (let i = 0; i < n.length - 1; i++) {
    const ax = n[i].x, az = n[i].z, dx = n[i + 1].x - ax, dz = n[i + 1].z - az, l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    const d = Math.hypot(x - ax - dx * t, z - az - dz * t);
    if (d < da) { db = da; b = a; da = d; a = i; } else if (d < db) { db = d; b = i; }
  }
  return { a, b, w: db === Infinity ? 1 : 0.5 + 0.5 * Math.min(1, (db - da) / 160) };
}
function biomeOfPoint(plan: WorldPlan, x: number, z: number): BiomeParams {
  return plan.biomes[plan.legBiome[legsNear(plan, x, z).a] ?? 0] ?? plan.biomes[0];
}
/** Base terrain blended across leg (biome) borders — no cliffs where the biome changes. */
function blendedBase(plan: WorldPlan, x: number, z: number): number {
  const L = legsNear(plan, x, z);
  const A = plan.biomes[plan.legBiome[L.a] ?? 0] ?? plan.biomes[0], B = plan.biomes[plan.legBiome[L.b] ?? 0] ?? A;
  const ha = baseHeight(plan, x, z, A);
  return A === B || L.w >= 0.999 ? ha : ha * L.w + baseHeight(plan, x, z, B) * (1 - L.w);
}
function heightOnPath(p: RoadPath, x: number, z: number): number {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < p.xs.length; i++) { const d = (p.xs[i] - x) ** 2 + (p.zs[i] - z) ** 2; if (d < bd) { bd = d; bi = i; } }
  return p.hs[bi];
}
function roadHeightNear(plan: WorldPlan, x: number, z: number): number { const r = roadInfo(plan, x, z, 200); return r ? r.h : 0; }

/** Terrain height at (x, z) including the carved road, creeks and flat clearings. Deterministic. */
export function heightAt(plan: WorldPlan, x: number, z: number): number {
  const road = roadInfo(plan, x, z, SHOULDER + ROAD_HALF + 1);
  let h = blendedBase(plan, x, z);
  // clearings: flat pads (camp spots, forks, nodes) blending out over 8 m
  const cl = plan.clearIndex.get(ck(x, z));
  if (cl) {
    let bw = 0, bh = 0;
    for (const i of cl) {
      const c = plan.clearings[i]; const d = Math.hypot(x - c.x, z - c.z);
      let w = d < c.r + 8 ? smooth(c.r + 8, c.r, d) : 0;
      if (c.rx !== undefined) { const e = segDist(x, z, c.rx, c.rz!, c.x, c.z); if (e < 7) w = Math.max(w, smooth(7, 3.5, e)); }   // the driveway
      if (w > bw) { bw = w; bh = c.h; }
    }
    if (bw > 0) h = h + (bh - h) * bw;
  }
  // creeks: a channel (and the road dips to ford depth where it crosses)
  const cr = plan.creekIndex.get(ck(x, z));
  if (cr) for (const i of cr) {
    const c = plan.creeks[i];
    const d = polyDist(c.xs, c.zs, x, z);
    if (d < c.half + 4) h = Math.min(h, h + (c.level - c.depth - h) * smooth(c.half + 4, c.half * 0.6, d));
  }
  // the road: flattened band + shoulders
  if (road) {
    const w = smooth(ROAD_HALF + SHOULDER, ROAD_HALF, road.d);
    let rh = road.h;
    if (cr) for (const i of cr) { const c = plan.creeks[i]; if (c.bridge) continue; const dc = polyDist(c.xs, c.zs, x, z); if (dc < c.half + 6) rh = Math.min(rh, rh + (c.level - c.ford - rh) * smooth(c.half + 6, c.half * 0.5, dc)); }
    h = h + (rh - h) * w;
  }
  return h;
}
function segDist(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
  return Math.hypot(x - ax - dx * t, z - az - dz * t);
}
export function polyDist(xs: Float32Array, zs: Float32Array, x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < xs.length - 1; i++) {
    const ax = xs[i], az = zs[i], bx = xs[i + 1], bz = zs[i + 1];
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
    if (d < best) best = d;
  }
  return best;
}

export interface RoadHit { path: number; i: number; t: number; d: number; h: number; /** metres along the path */ s: number; miles: number; /** unit tangent */ tx: number; tz: number; /** + = left of travel */ side: number }
/** The nearest road point within `maxD` (null if none). Uses the segment grid (+ the neighbours when maxD > a cell). */
export function roadInfo(plan: WorldPlan, x: number, z: number, maxD = 12): RoadHit | null {
  let best: RoadHit | null = null;
  const r = Math.ceil(maxD / CELL);
  const gx0 = Math.floor(x / CELL), gz0 = Math.floor(z / CELL);
  for (let gx = gx0 - r; gx <= gx0 + r; gx++) for (let gz = gz0 - r; gz <= gz0 + r; gz++) {
    const refs = plan.segIndex.get(((gx + 32768) << 16) | (gz + 32768));
    if (!refs) continue;
    for (const ref of refs) {
      const pi = Math.floor(ref / 65536), i = ref % 65536;
      const p = plan.paths[pi];
      if (!p || i >= p.xs.length - 1) continue;
      const ax = p.xs[i], az = p.zs[i], dx = p.xs[i + 1] - ax, dz = p.zs[i + 1] - az, l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(x - px, z - pz);
      if (d > maxD || (best && d >= best.d)) continue;
      const l = Math.sqrt(l2), s = p.cum[i] + l * t, L = p.cum[p.cum.length - 1] || 1;
      best = { path: pi, i, t, d, h: p.hs[i] + (p.hs[i + 1] - p.hs[i]) * t, s, miles: p.m0 + (p.m1 - p.m0) * (s / L), tx: dx / l, tz: dz / l, side: Math.sign((x - px) * (-dz) + (z - pz) * dx) || 1 };
    }
  }
  return best;
}
/** A point on a path at `s` metres (+ heading). */
export function pathPoint(p: RoadPath, s: number): { x: number; z: number; h: number; yaw: number } {
  const i = Math.min(p.xs.length - 2, Math.max(0, indexAt(p, s) - 1));
  const l = (p.cum[i + 1] - p.cum[i]) || 1, t = Math.max(0, Math.min(1, (s - p.cum[i]) / l));
  const x = p.xs[i] + (p.xs[i + 1] - p.xs[i]) * t, z = p.zs[i] + (p.zs[i + 1] - p.zs[i]) * t;
  return { x, z, h: p.hs[i] + (p.hs[i + 1] - p.hs[i]) * t, yaw: Math.atan2(p.xs[i + 1] - p.xs[i], p.zs[i + 1] - p.zs[i]) };
}
/** The main road of a leg. */
export function legPath(plan: WorldPlan, leg: number): RoadPath | undefined { return plan.paths.find((p) => p.leg === leg && p.kind === 'main'); }

// ---------------------------------------------------------------- surface / water queries (the wagon + players)
export type Surface = 'road' | 'grass' | 'mud' | 'water' | 'void';
export function surfaceAt(plan: WorldPlan, x: number, z: number): { s: Surface; water: number; mud: number } {
  const h = heightAt(plan, x, z);
  const cr = plan.creekIndex.get(ck(x, z));
  if (cr) for (const i of cr) { const c = plan.creeks[i]; if (h < c.level && polyDist(c.xs, c.zs, x, z) < c.half + 6) return { s: 'water', water: c.level - h, mud: 0.6 }; }
  const road = roadInfo(plan, x, z, ROAD_HALF + 0.6);
  if (h < -10) return { s: 'void', water: 0, mud: 0 };
  const mud = mudAt(plan, x, z);
  if (road) return { s: mud > 0.85 ? 'mud' : 'road', water: 0, mud: mud > 0.85 ? mud : 0 };
  return { s: mud > 0.6 ? 'mud' : 'grass', water: 0, mud };
}
/** 0..1 mud (biome mud frequency × noise); strongest in low spots. */
export function mudAt(plan: WorldPlan, x: number, z: number): number {
  const bp = biomeOfPoint(plan, x, z);
  if (bp.mud <= 0) return 0;
  // pads (camp spots, forks, stops) + their driveways are firm ground
  const cl = plan.clearIndex.get(ck(x, z));
  if (cl) for (const i of cl) { const c = plan.clearings[i]; if (Math.hypot(x - c.x, z - c.z) < c.r + 3 || (c.rx !== undefined && segDist(x, z, c.rx, c.rz!, c.x, c.z) < 4)) return 0; }
  const n = vnoise(plan.seedN + 4242, x / 26, z / 26);
  return smooth(1 - bp.mud * 0.55, 1 - bp.mud * 0.2, n);
}
/** Creeks overlapping a rect (water planes for a chunk). */
export function creeksNear(plan: WorldPlan, x0: number, z0: number, x1: number, z1: number): Creek[] {
  const out: Creek[] = [];
  for (const c of plan.creeks) {
    let hit = false;
    for (let k = 0; k < c.xs.length && !hit; k++) if (c.xs[k] > x0 - 10 && c.xs[k] < x1 + 10 && c.zs[k] > z0 - 10 && c.zs[k] < z1 + 10) hit = true;
    if (hit) out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------- chunks
export interface ScatterItem { role: ScatterRole; x: number; z: number; y: number; rot: number; scale: number; solid: boolean; r: number; v: number }
export interface Chunk {
  cx: number; cz: number;
  /** N×N heights, row-major: h[iz * N + ix] at (cx·CHUNK + ix, cz·CHUNK + iz) */
  heights: Float32Array;
  /** per sample: road weight 0..1, mud 0..1, rock (slope) 0..1 */
  road: Float32Array; mud: Float32Array; rock: Float32Array;
  scatter: ScatterItem[];
  biome: number;
  minH: number; maxH: number;
}
/** `lite` (the host's physics): heights + scatter only (no road / mud / rock masks: those are for the visuals). */
export function genChunk(plan: WorldPlan, cx: number, cz: number, lite = false): Chunk {
  const x0 = cx * CHUNK, z0 = cz * CHUNK;
  const heights = new Float32Array(N * N), road = new Float32Array(N * N), mud = new Float32Array(N * N), rock = new Float32Array(N * N);
  let minH = Infinity, maxH = -Infinity;
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
    const x = x0 + ix * RES, z = z0 + iz * RES;
    const h = heightAt(plan, x, z);
    heights[iz * N + ix] = h;
    if (h < minH) minH = h; if (h > maxH) maxH = h;
    if (lite) continue;
    const r = roadInfo(plan, x, z, ROAD_HALF + 2);
    road[iz * N + ix] = r ? smooth(ROAD_HALF + 1.5, ROAD_HALF - 0.3, r.d) : 0;
    mud[iz * N + ix] = mudAt(plan, x, z);
  }
  if (!lite) for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
    const a = heights[iz * N + Math.min(N - 1, ix + 1)] - heights[iz * N + Math.max(0, ix - 1)];
    const b = heights[Math.min(N - 1, iz + 1) * N + ix] - heights[Math.max(0, iz - 1) * N + ix];
    rock[iz * N + ix] = smooth(0.9, 1.8, Math.hypot(a, b) / (2 * RES));
  }
  const mid = biomeOfPoint(plan, x0 + CHUNK / 2, z0 + CHUNK / 2);
  const biome = Math.max(0, plan.biomes.indexOf(mid));
  return { cx, cz, heights, road, mud, rock, scatter: scatterChunk(plan, cx, cz, heights, mid), biome, minH, maxH };
}
function scatterChunk(plan: WorldPlan, cx: number, cz: number, heights: Float32Array, bp: BiomeParams): ScatterItem[] {
  const out: ScatterItem[] = [];
  const x0 = cx * CHUNK, z0 = cz * CHUNK, G = 4;   // jittered 4 m grid
  for (const rule of bp.scatter) {
    const perCell = rule.density * (G * G) / 100;
    for (let gz = 0; gz < CHUNK / G; gz++) for (let gx = 0; gx < CHUNK / G; gx++) {
      const wx = x0 + gx * G, wz = z0 + gz * G;
      const salt = hash32(rule.role) ^ plan.seedN;
      // clusters + clearings: a low-frequency density field
      const field = vnoise(salt, wx / 30, wz / 30);
      const p = perCell * (0.2 + field * field * 2.2);
      if (h2(salt, wx, wz) > p) continue;
      const x = wx + h2(salt + 1, wx, wz) * G, z = wz + h2(salt + 2, wx, wz) * G;
      const ix = Math.min(N - 1, Math.max(0, Math.round(x - x0))), iz = Math.min(N - 1, Math.max(0, Math.round(z - z0)));
      const y = heights[iz * N + ix];
      if (y < -8) continue;                                                       // the void (islands)
      const r = roadInfo(plan, x, z, 12);
      const minRoad = rule.solid ? ROAD_HALF + 3.5 : ROAD_HALF + 1.2;
      if (r && r.d < minRoad) continue;
      if (rule.nearRoad && (!r || r.d > rule.nearRoad)) continue;                 // fences / junk hug the road
      const cl = plan.clearIndex.get(ck(x, z));
      if (cl && cl.some((i) => { const c = plan.clearings[i]; return Math.hypot(x - c.x, z - c.z) < c.r + (rule.solid ? 2 : -2) || (rule.solid && c.rx !== undefined && segDist(x, z, c.rx, c.rz!, c.x, c.z) < 4.5); })) continue;
      const cr = plan.creekIndex.get(ck(x, z));
      if (cr && rule.role !== 'reed' && cr.some((i) => polyDist(plan.creeks[i].xs, plan.creeks[i].zs, x, z) < plan.creeks[i].half + 1.5)) continue;
      const sc = rule.min + h2(salt + 3, wx, wz) * (rule.max - rule.min);
      const rot = rule.role === 'fence' && r ? Math.atan2(r.tx, r.tz) : h2(salt + 4, wx, wz) * Math.PI * 2;
      out.push({ role: rule.role, x, z, y, rot, scale: sc, solid: rule.solid, r: rule.r * sc, v: h2(salt + 5, wx, wz) });
    }
  }
  return out;
}
