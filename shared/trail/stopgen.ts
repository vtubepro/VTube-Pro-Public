// The Trail v2 — the seeded STOP generator (DESIGN_V2 §1 pillar 4 "every run is new", §4; workstream trailstops).
// The places the wagon drives into — the general store, a river crossing, the hunting grounds, a landmark, the
// destination — are assembled per (run seed, route node id, theme, biome) instead of loading one fixed map per theme:
//
//   genStop(kind, opts) → LevelDesc      (the same plain data the host physics and every view already consume)
//
// Every anchor / zone the sim reads is kept (store: items, checkout, window, catflap, porch, pen, shopkeeper, nav;
// river: water[0], farbank, nearbank, rapids, catch, paths ford / ferry / caulk, ferryman; hunt: animal spawns with
// kinds (+ air), grass_* zones, pond; landmark: summit, photo, talkers, CAM_SPECT_photo; finish: finish; all: wagon,
// spawns, walls, kill, CAM_SPECT_WIDE / HERO). Zones are axis-aligned boxes (no yaw) on purpose.
// Two optional LevelDesc fields carry the rest:
//   terrain — a heightfield: the host builds a Rapier heightfield from it (world.ts addChunk); views rebuild the very
//             same heights from `spec` (heightAt / terrainGrid below), so no height bytes cross the network;
//   art     — the visual recipe (materials per collider, visual-only parts, theme kit pieces, roads, paint, grass,
//             lights, signs) that the client's stopview.ts renders with the theme pack's art (fallback: placeholders).
// Pure + deterministic, no three.js (runs in the host's sim worker, in Node tests and in the browser).
import { Rng, hash32 } from './rng.ts';
import { PROPS, palette, type ColDesc, type LevelDesc, type Pal, type Q4, type Sky, type SpawnDesc, type Tag, type V3, type ZoneDesc } from './levels.ts';

export type GenKind = 'store' | 'river' | 'hunt' | 'landmark' | 'finish';
export const GEN_KINDS: readonly string[] = ['store', 'river', 'hunt', 'landmark', 'finish'];

// ================================================================ terrain (a pure function of a small spec)
export interface Pad { x: number; z: number; h: number; r?: number; hx?: number; hz?: number; yaw?: number; fall: number;
  /** ramp: height goes h → h2 along the pad's local +Z */ h2?: number }
export interface Chan { xs: number[]; zs: number[]; half: number; bank: number; bed: number }
export interface Isle { x: number; z: number; rx: number; rz: number; h: number }
export interface TerrainSpec {
  seed: number; base: number; amp: number; scale: number; detail: number;
  /** hills rising toward the arena border (frames the arena, hides the walls) */
  rim?: { at: number; w: number; h: number };
  floor?: number;
  mounds: { x: number; z: number; r: number; h: number }[];
  pads: Pad[];
  bowls: { x: number; z: number; r: number; d: number; level: number }[];
  chans: Chan[];
  /** floating islands (Skyisles): ground only inside them, the void (voidH) elsewhere */
  isles?: Isle[]; voidH?: number;
}
export interface TerrainDesc { n: number; size: number; cx: number; cz: number; spec: TerrainSpec }

function h2(seed: number, x: number, z: number): number {
  let h = (seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(z, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(seed: number, x: number, z: number): number {
  const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = h2(seed, xi, zi), b = h2(seed, xi + 1, zi), c = h2(seed, xi, zi + 1), d = h2(seed, xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(seed: number, x: number, z: number, oct: number): number {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { s += a * (vnoise(seed + i * 1013, x * f, z * f) * 2 - 1); n += a; a *= 0.5; f *= 2.03; }
  return s / n;
}
export const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
/** Distance from (x, z) to a polyline. */
export function polyDist(xs: number[], zs: number[], x: number, z: number, maxD = Infinity): number {
  let best = Infinity;
  for (let i = 0; i < xs.length - 1; i++) {
    const ax = xs[i], az = zs[i], dx = xs[i + 1] - ax, dz = zs[i + 1] - az, l2 = dx * dx + dz * dz || 1;
    if (maxD < Infinity) { const reach = maxD + Math.abs(dx) + Math.abs(dz); if (Math.abs(x - ax) > reach || Math.abs(z - az) > reach) continue; }
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    const d = Math.hypot(x - ax - dx * t, z - az - dz * t);
    if (d < best) best = d;
  }
  return best;
}
/** 0 = in an island's core … 1 = at its (noisy) rim; > 1 outside. */
export function isleEdge(spec: TerrainSpec, x: number, z: number): { e: number; i: number } {
  let e = Infinity, bi = -1;
  for (let i = 0; i < (spec.isles?.length ?? 0); i++) {
    const s = spec.isles![i];
    const d = Math.hypot((x - s.x) / s.rx, (z - s.z) / s.rz) + (vnoise(spec.seed + 313 + i * 71, x / 7, z / 7) - 0.5) * 0.16;
    if (d < e) { e = d; bi = i; }
  }
  return { e, i: bi };
}
const chanBox = new WeakMap<Chan, [number, number, number, number]>();
/** Terrain height at (x, z). Deterministic; the physics heightfield and every view's mesh sample exactly this. */
export function heightAt(spec: TerrainSpec, x: number, z: number): number {
  let h = spec.base + fbm(spec.seed, x / spec.scale, z / spec.scale, 3) * spec.amp + (vnoise(spec.seed + 9, x / 3.1, z / 3.1) - 0.5) * spec.detail;
  // islands: each lifts / lowers its own ground first (pads, ponds and channels are absolute heights on top)
  const isle = spec.isles?.length ? isleEdge(spec, x, z) : null;
  if (isle) h += spec.isles![isle.i].h;
  if (spec.rim) { const d = Math.max(Math.abs(x), Math.abs(z)) - spec.rim.at; if (d > 0) h += spec.rim.h * smooth(0, spec.rim.w, d) * (0.7 + 0.6 * vnoise(spec.seed + 5, x / 11, z / 11)); }
  for (const m of spec.mounds) { const d = Math.hypot(x - m.x, z - m.z); if (d < m.r) { const t = 1 - (d / m.r) ** 2; h += m.h * t * t; } }
  if (spec.floor !== undefined) h = Math.max(h, spec.floor);
  for (const p of spec.pads) {
    let d: number, along = 0;
    if (p.r !== undefined) d = Math.hypot(x - p.x, z - p.z) - p.r;
    else {
      const c = Math.cos(p.yaw ?? 0), s = Math.sin(p.yaw ?? 0), dx = x - p.x, dz = z - p.z;
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      const ox = Math.abs(lx) - (p.hx ?? 1), oz = Math.abs(lz) - (p.hz ?? 1);
      d = Math.hypot(Math.max(ox, 0), Math.max(oz, 0)) + Math.min(Math.max(ox, oz), 0);
      along = Math.max(0, Math.min(1, (lz + (p.hz ?? 1)) / (2 * (p.hz ?? 1))));
    }
    if (d >= p.fall) continue;
    const w = d <= 0 ? 1 : smooth(p.fall, 0, d);
    const ph = p.h2 !== undefined ? p.h + (p.h2 - p.h) * along : p.h;
    h += (ph - h) * w;
  }
  for (const b of spec.bowls) {
    const d = Math.hypot(x - b.x, z - b.z);
    if (d < b.r + 2.5) { const bed = b.level - b.d * (1 - Math.min(1, d / b.r) ** 2); const w = smooth(b.r + 2.5, b.r * 0.85, d); h = Math.min(h, h + (Math.min(h, bed) - h) * w); }
  }
  for (const c of spec.chans) {
    let bb = chanBox.get(c);
    if (!bb) { const m = c.half + c.bank; bb = [Math.min(...c.xs) - m, Math.max(...c.xs) + m, Math.min(...c.zs) - m, Math.max(...c.zs) + m]; chanBox.set(c, bb); }
    if (x < bb[0] || x > bb[1] || z < bb[2] || z > bb[3]) continue;
    const d = polyDist(c.xs, c.zs, x, z, c.half + c.bank);
    if (d < c.half + c.bank) { const carve = c.bed + (d > c.half ? (h - c.bed) * smooth(c.half, c.half + c.bank, d) : 0); h = Math.min(h, carve); }
  }
  if (isle) {
    if (isle.e > 1) return spec.voidH ?? -30;
    if (isle.e > 0.88) h -= (isle.e - 0.88) * 5;        // a rounded lip at the rim
  }
  return h;
}
/** n × n heights, row-major (z rows): h[iz * n + ix] at (cx - size/2 + ix·step, cz - size/2 + iz·step). */
export function terrainGrid(t: TerrainDesc): Float32Array {
  const n = t.n, step = t.size / (n - 1), out = new Float32Array(n * n);
  const x0 = t.cx - t.size / 2, z0 = t.cz - t.size / 2;
  for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) out[iz * n + ix] = heightAt(t.spec, x0 + ix * step, z0 + iz * step);
  return out;
}

// ================================================================ the visual recipe (read by src/game/trail/client/stopview.ts)
/** Material keys the view knows: plank wall trim roof wood wood_dark rock stone marble gold cloth cloth2 metal neon neon2
 *  glow crystal rope dirt moss cloud paper. '' = not drawn (invisible walls, the kit pieces' trunks). */
export type ArtPart =
  | { t: 'box'; p: V3; he: V3; q?: Q4; m: string }
  | { t: 'cyl'; p: V3; r: number; r2?: number; hh: number; q?: Q4; m: string; seg?: number }
  | { t: 'ball'; p: V3; s: V3; m: string }
  | { t: 'gable'; p: V3; he: V3; yaw: number; m: string }
  | { t: 'rope'; a: V3; b: V3; sag: number; m?: string }
  | { t: 'drum'; p: V3; r0: number; r1: number; h: number; seed: number; m: string }
  | { t: 'ring'; p: V3; yaw: number; R: number; r: number; a0: number; a1: number; m: string }
  | { t: 'sign'; p: V3; yaw: number; w: number; h: number; text: string[]; style: string };
export interface StopArt {
  v: 1; kind: GenKind; theme: string; biome: string; bi: number; A: number;
  /** material key per desc.cols index */
  colMat: string[];
  parts: ArtPart[];
  /** theme kit pieces (SCENERY_<id>; fallback placeholder kinds): [idIndex, x, y, z, yaw·100, scale·100] × n */
  kit: { ids: string[]; fb: string[]; at: number[] };
  /** road ribbons over the terrain: x, z pairs */
  roads: { pts: number[]; w: number; k: 'road' | 'path' }[];
  /** ground paint: [kind (0 mud · 1 rock · 2 shore · 3 lush · 4 bare), x, z, r] × n */
  paint: number[];
  /** tall grass patches: [x, z, hx, hz] × n */
  grass: number[];
  lights: { p: V3; c: string; r: number; i: number; f?: 1; n?: 1 }[];
  /** Skyisles: the cloud sea's height */
  cloudSea?: number;
  /** lily pads / floating bits on water: [x, z, s] × n */
  lily?: number[];
}

// ================================================================ theme kits (the SCENERY_* pieces in levels/trail_road.glb)
interface KitDef { id: string; role: 'tree' | 'tree_s' | 'bush' | 'rock' | 'reed' | 'junk' | 'far' | 'cloud' | 'ruin' | 'crystal' | 'marker'; r: number; solid: boolean; s: [number, number]; b?: number[]; fb: string }
const K = (id: string, role: KitDef['role'], r: number, solid: boolean, s: [number, number], fb: string, b?: number[]): KitDef => ({ id, role, r, solid, s, fb, b });
export const KITS: Record<string, KitDef[]> = {
  bayou: [
    K('cypress', 'tree', 0.7, true, [0.8, 1.3], 'cypress', [0, 1]), K('cypress_small', 'tree_s', 0.45, true, [0.8, 1.2], 'cypress', [0, 1]),
    K('dead_tree', 'tree_s', 0.35, true, [0.8, 1.3], 'stump'), K('reed_clump', 'reed', 0, false, [0.8, 1.4], 'reeds', [0, 1]),
    K('bush', 'bush', 0, false, [0.6, 1.4], 'bush'), K('boulder', 'rock', 0.9, true, [0.6, 1.5], 'rock'),
    K('rock_cluster', 'rock', 0.8, true, [0.8, 1.3], 'rock', [1, 2]), K('wreck', 'junk', 1.1, true, [1, 1], 'stump', [0, 1]),
    K('outhouse', 'junk', 0.8, true, [1, 1], 'stump', [0, 1]), K('billboard', 'far', 0, false, [1, 1], 'sign'),
    K('frog_statue', 'junk', 0.6, true, [1, 1], 'stump'), K('neon_shroom', 'crystal', 0.45, true, [0.7, 1.8], 'mushroom', [2]),
    K('milepost', 'marker', 0.15, true, [1, 1], 'stump'),
  ],
  skyisles: [
    K('sky_tree', 'tree', 0.7, true, [0.8, 1.3], 'flowertree', [0, 2]), K('blossom_tree', 'tree_s', 0.5, true, [0.8, 1.2], 'flowertree', [0, 1]),
    K('cloud_bank', 'cloud', 0, false, [0.8, 2.0], 'cloudpuff'), K('float_rock', 'far', 0, false, [0.7, 1.6], 'cloudpuff'),
    K('wayshrine', 'marker', 0.4, true, [1, 1], 'shrine'), K('broken_column', 'ruin', 0.5, true, [0.8, 1.4], 'shrine'),
    K('crystal_cluster', 'crystal', 0.5, true, [0.6, 1.6], 'crystal', [2, 0]), K('rose_bush', 'bush', 0, false, [0.6, 1.4], 'bush', [0, 1]),
    K('pilgrim_banner', 'marker', 0.12, true, [1, 1], 'featherpost'), K('angel_statue', 'junk', 1.0, true, [1, 1.3], 'shrine'),
    K('rainbow_arch', 'far', 0, false, [0.8, 1.4], 'cloudpuff'), K('star_lamp', 'marker', 0.2, true, [1, 1], 'star', [2]),
    K('feather_marker', 'marker', 0.25, true, [0.8, 1.2], 'featherpost'), K('wreck', 'junk', 1.4, true, [1, 1], 'shrine'),
  ],
  frontier: [
    K('pine', 'tree', 0.5, true, [0.8, 1.4], 'pine'), K('pine', 'tree_s', 0.4, true, [0.6, 0.9], 'pine'), K('rock', 'rock', 0.7, true, [0.7, 1.6], 'rock'),
    K('bush', 'bush', 0, false, [0.6, 1.3], 'bush'), K('cactus', 'crystal', 0.3, true, [0.8, 1.3], 'cactus', [0, 1]), K('stump', 'junk', 0.4, true, [0.8, 1.2], 'stump'),
    K('grasstuft', 'reed', 0, false, [0.8, 1.5], 'grasstuft'),
  ],
};

// ================================================================ the generator
export interface StopGenOpts {
  /** the run's seed code (e.g. SWAMP-4821) */ seed: string;
  /** route node id ('start', 'river_2', …) or a tag ('hunt:12') — stops at different nodes differ, the same run + node repeats */ node: string;
  theme: string;
  /** deck biome id + its index (0..2) */ biome?: string; biomeIdx?: number;
  palette?: Record<string, string>;
  /** the run's river today (feet): width / depth / swift */ river?: { depth: number; width: number; swift: boolean } | null;
  /** deck animals (kinds, counts, danger, grabs) */ animals?: Record<string, { count: number; kg?: number; danger?: number; grabs?: string }>;
  /** the stop's name (signs) */ name?: string; storeName?: string;
  /** this store belongs to a fort (palisade + watchtower) */ fort?: boolean;
}
type V2 = [number, number];
const yawQ = (y: number): Q4 => [0, Math.sin(y / 2), 0, Math.cos(y / 2)];
function qmul(a: Q4, b: Q4): Q4 { return [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]]; }
/** yaw about Y, then a pitch that raises the local +Z end by `rise` radians */
const yawPitch = (yaw: number, rise: number): Q4 => qmul(yawQ(yaw), [Math.sin(-rise / 2), 0, 0, Math.cos(-rise / 2)]);
const r2 = (v: number) => Math.round(v * 100) / 100;
const v3 = (x: number, y: number, z: number): V3 => [r2(x), r2(y), r2(z)];

/** A local frame on the ground: +Z = its "front"; w(lx, lz) → world x, z. */
class Fr {
  readonly c: number; readonly s: number;
  constructor(readonly x: number, readonly z: number, readonly yaw: number, readonly y = 0) { this.c = Math.cos(yaw); this.s = Math.sin(yaw); }
  w(lx: number, lz: number): V2 { return [this.x + this.c * lx + this.s * lz, this.z - this.s * lx + this.c * lz]; }
  p(lx: number, ly: number, lz: number): V3 { const [x, z] = this.w(lx, lz); return v3(x, this.y + ly, z); }
  /** world → local */
  l(x: number, z: number): V2 { const dx = x - this.x, dz = z - this.z; return [dx * this.c - dz * this.s, dx * this.s + dz * this.c]; }
}

const SKIES: Record<string, Sky[]> = {
  bayou: [
    { top: '#2a5a44', bottom: '#9fd67a', fog: '#6f9a6a', fogNear: 34, fogFar: 150, sun: '#fff1c0', sunI: 1.8, amb: '#b9ffcf', ambI: 0.9 },
    { top: '#34506a', bottom: '#ffcf8a', fog: '#a89a70', fogNear: 36, fogFar: 160, sun: '#ffd69a', sunI: 1.75, amb: '#ffe2b8', ambI: 0.85 },
    { top: '#3d6a5c', bottom: '#cfe8c0', fog: '#8fb09a', fogNear: 16, fogFar: 105, sun: '#f4f8e0', sunI: 1.5, amb: '#d8ffe0', ambI: 1.0 },
    { top: '#2c2350', bottom: '#ff8ac0', fog: '#6a5070', fogNear: 30, fogFar: 140, sun: '#ffc0dc', sunI: 1.45, amb: '#c8b0ff', ambI: 0.85 },
  ],
  skyisles: [
    { top: '#4f8fe8', bottom: '#eaf4ff', fog: '#dfeaff', fogNear: 45, fogFar: 190, sun: '#fff6e0', sunI: 2.0, amb: '#e8f0ff', ambI: 1.0 },
    { top: '#8a9ef0', bottom: '#ffe2ea', fog: '#f2e2f0', fogNear: 40, fogFar: 180, sun: '#ffe2c8', sunI: 1.85, amb: '#fff0f4', ambI: 1.0 },
    { top: '#5a5cc0', bottom: '#ffc8dc', fog: '#dccaf0', fogNear: 38, fogFar: 170, sun: '#ffcaa0', sunI: 1.6, amb: '#e4d6ff', ambI: 0.95 },
  ],
  frontier: [
    { top: '#6aa6d8', bottom: '#f2e3c0', fog: '#d9c9a3', fogNear: 45, fogFar: 180, sun: '#fff3d6', sunI: 2.0, amb: '#fff0dd', ambI: 0.9 },
    { top: '#5a7ab0', bottom: '#ffc890', fog: '#d8b890', fogNear: 40, fogFar: 170, sun: '#ffd8a0', sunI: 1.8, amb: '#ffe4c8', ambI: 0.85 },
    { top: '#8a98a8', bottom: '#d8d8d0', fog: '#b8bcb8', fogNear: 30, fogFar: 140, sun: '#f0f0f0', sunI: 1.5, amb: '#e8ecf0', ambI: 1.05 },
  ],
};

/** Builder state for one stop. */
class G {
  readonly d: LevelDesc; readonly art: StopArt; readonly r: Rng; readonly spec: TerrainSpec; readonly pal: Pal;
  readonly th: 'b' | 'l' | 'f'; readonly kits: KitDef[]; readonly bi: number;
  private blocks: { x: number; z: number; r: number }[] = [];
  private kitIdx = new Map<string, number>();
  constructor(readonly kind: GenKind, readonly o: StopGenOpts, readonly A: number, terrainSize: number) {
    this.th = o.theme === 'bayou' ? 'b' : o.theme === 'skyisles' ? 'l' : 'f';
    this.r = new Rng(`${o.seed}:stop:${o.node}:${kind}:${o.theme}`);
    this.pal = palette(o.palette, o.theme);
    this.bi = Math.max(0, Math.min(2, o.biomeIdx ?? 0));
    this.kits = (KITS[o.theme] ?? KITS.frontier).filter((k) => !k.b || k.b.includes(this.bi));
    const skies = SKIES[o.theme] ?? SKIES.frontier;
    const sky = { ...skies[this.r.int(0, skies.length - 1)] };
    this.spec = { seed: hash32(`${o.seed}:${o.node}:${kind}:terrain`), base: 0, amp: 1.2, scale: 26, detail: 0.12, mounds: [], pads: [], bowls: [], chans: [] };
    const n = Math.round(terrainSize) + 1;
    this.d = {
      id: kind, kind, theme: o.theme, size: [A, A], cols: [], zones: [], water: [], spawns: [], wagon: { p: [0, 0, 0], yaw: 0 }, items: [], animals: [], npcs: [], seats: [],
      paths: {}, cams: {}, sky, decor: [], terrain: { n, size: n - 1, cx: 0, cz: 0, spec: this.spec },
    };
    this.art = { v: 1, kind, theme: o.theme, biome: o.biome ?? '', bi: this.bi, A, colMat: [], parts: [], kit: { ids: [], fb: [], at: [] }, roads: [], paint: [], grass: [], lights: [] };
    this.d.art = this.art;
  }
  h(x: number, z: number) { return heightAt(this.spec, x, z); }
  col(c: ColDesc, m: string): ColDesc { this.d.cols.push(c); this.art.colMat.push(m); return c; }
  box(p: V3, he: V3, tag: Tag, m: string, q?: Q4): ColDesc { return this.col({ shape: 'box', p, he: [r2(he[0]), r2(he[1]), r2(he[2])], tag, ...(q ? { q: q.map((v) => Math.round(v * 1e4) / 1e4) as Q4 } : {}) }, m); }
  cyl(p: V3, r: number, hh: number, tag: Tag, m: string): ColDesc { return this.col({ shape: 'cylinder', p, r: r2(r), hh: r2(hh), tag }, m); }
  /** a box in a frame: local centre (lx, ly, lz), half extents, extra local yaw */
  fbox(f: Fr, lx: number, ly: number, lz: number, he: V3, tag: Tag, m: string, yaw = 0): ColDesc { return this.box(f.p(lx, ly, lz), he, tag, m, yawQ(f.yaw + yaw)); }
  part(p: ArtPart) { this.art.parts.push(p); }
  pbox(f: Fr, lx: number, ly: number, lz: number, he: V3, m: string, yaw = 0) { this.part({ t: 'box', p: f.p(lx, ly, lz), he: [r2(he[0]), r2(he[1]), r2(he[2])], q: yawQ(f.yaw + yaw), m }); }
  zone(name: string, p: V3, he: V3, extras?: ZoneDesc['extras']) { this.d.zones.push({ name, p: v3(...p), he: v3(...he), ...(extras ? { extras } : {}) }); }
  light(p: V3, c: string, r: number, i: number, flicker = false, nightOnly = false) { this.art.lights.push({ p, c, r, i, ...(flicker ? { f: 1 as const } : {}), ...(nightOnly ? { n: 1 as const } : {}) }); }
  sign(p: V3, yaw: number, w: number, h: number, text: string[], style = 'board') { this.part({ t: 'sign', p, yaw, w, h, text, style }); }
  paint(kind: number, x: number, z: number, r: number) { this.art.paint.push(kind, r2(x), r2(z), r2(r)); }
  road(pts: V2[], w = 4, k: 'road' | 'path' = 'road') { this.art.roads.push({ pts: pts.flatMap(([x, z]) => [r2(x), r2(z)]), w, k }); }
  block(x: number, z: number, r: number) { this.blocks.push({ x, z, r }); }
  /** keep scatter off a frame's rectangle (local half extents + margin) */
  blockRect(f: Fr, lx: number, lz: number, hx: number, hz: number) {
    const step = 2.2;
    for (let x = -hx; x <= hx + 0.01; x += step) for (let z = -hz; z <= hz + 0.01; z += step) { const [wx, wz] = f.w(lx + x, lz + z); this.block(wx, wz, step * 0.8); }
  }
  blockLine(pts: V2[], r: number) { for (let i = 0; i < pts.length - 1; i++) { const [ax, az] = pts[i], [bx, bz] = pts[i + 1]; const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (r * 0.8))); for (let k = 0; k <= n; k++) this.block(ax + (bx - ax) * k / n, az + (bz - az) * k / n, r); } }
  free(x: number, z: number, r: number, margin = 2): boolean {
    const L = this.A / 2 - margin;
    if (Math.abs(x) > L || Math.abs(z) > L) return false;
    for (const b of this.blocks) if ((x - b.x) ** 2 + (z - b.z) ** 2 < (b.r + r) ** 2) return false;
    return true;
  }
  /** kit entries whose y is set on purpose (floating clouds, plinths): the final ground pass leaves them alone */
  readonly fixedKit = new Set<number>();
  /** landmark: the climb route (ramp centres, bottom → top): paths.climb */
  readonly climb: V3[] = [];
  /** A theme kit piece (the view clones SCENERY_<id>); solid pieces get a trunk collider. `y`: an explicit height. */
  kit(k: KitDef, x: number, z: number, yaw: number, s: number, collide = true, y?: number) {
    let i = this.kitIdx.get(k.id);
    if (i === undefined) { i = this.art.kit.ids.length; this.kitIdx.set(k.id, i); this.art.kit.ids.push(k.id); this.art.kit.fb.push(k.fb); }
    const gy = y ?? this.h(x, z) - 0.04;
    if (y !== undefined) this.fixedKit.add(this.art.kit.at.length);
    this.art.kit.at.push(i, r2(x), r2(gy), r2(z), Math.round(yaw * 100), Math.round(s * 100));
    if (k.solid && collide && k.r > 0) this.cyl(v3(x, gy + 1.45, z), Math.max(0.15, k.r * s), 1.6, k.role === 'rock' || k.role === 'crystal' || k.role === 'ruin' ? 'rock' : 'wood', '');
    this.block(x, z, Math.max(0.6, k.r * s + 0.5));
  }
  /** After every pad / bowl / channel is in: put ground things back on the final ground. */
  settle() {
    const at = this.art.kit.at;
    for (let j = 0; j < at.length; j += 6) if (!this.fixedKit.has(j)) at[j + 2] = r2(this.h(at[j + 1], at[j + 3]) - 0.04);
    for (const s of this.d.spawns) s.p[1] = r2(this.h(s.p[0], s.p[2]) + 0.1);
    for (const a of this.d.animals) a.p[1] = r2(this.h(a.p[0], a.p[2]) + (a.air ? 8 : 0.05));
    for (const n of this.d.npcs) if (n.id !== 'shopkeeper') n.p[1] = r2(this.h(n.p[0], n.p[2]) + 0.02);
    for (const it of this.d.items) if (it.item === 'draft') it.p[1] = r2(this.h(it.p[0], it.p[2]) + 0.7);
    this.d.wagon.p[1] = r2(this.h(this.d.wagon.p[0], this.d.wagon.p[2]));
  }
  kitsOf(...roles: KitDef['role'][]): KitDef[] { return this.kits.filter((k) => roles.includes(k.role)); }
  /** Scatter `n` pieces of the roles inside `where` (rejection sampling, clusters around seeds). */
  scatter(roles: KitDef['role'][], n: number, where: (x: number, z: number) => boolean, o: { cluster?: number; spread?: number; min?: number; collide?: boolean; margin?: number } = {}) {
    const pool = this.kitsOf(...roles);
    if (!pool.length) return 0;
    const margin = o.margin ?? 2, L = this.A / 2 - margin;
    let placed = 0;
    const seeds: V2[] = [];
    for (let tries = 0; placed < n && tries < n * 30; tries++) {
      let x: number, z: number;
      if (o.cluster && seeds.length && this.r.chance(0.7)) { const s = this.r.pick(seeds); const a = this.r.range(0, 6.283), d = this.r.range(1.5, o.spread ?? 6); x = s[0] + Math.cos(a) * d; z = s[1] + Math.sin(a) * d; }
      else { x = this.r.range(-L, L); z = this.r.range(-L, L); }
      if (!where(x, z)) continue;
      const k = this.r.pick(pool), s = this.r.range(k.s[0], k.s[1]);
      if (!this.free(x, z, Math.max(o.min ?? 0.8, k.r * s), margin)) continue;
      if (this.spec.isles?.length && isleEdge(this.spec, x, z).e > 0.92) continue;
      this.kit(k, x, z, this.r.range(0, 6.283), s, o.collide ?? true);
      if (o.cluster && seeds.length < o.cluster) seeds.push([x, z]);
      placed++;
    }
    return placed;
  }
  /** Scenery outside the playable square (framing the view: trees, far pieces, clouds) — visual only. */
  frame(n: number, roles: KitDef['role'][] = ['tree', 'tree_s', 'far', 'rock', 'cloud']) {
    const pool = this.kitsOf(...roles);
    if (!pool.length) return;
    const A = this.A / 2;
    for (let i = 0, tries = 0; i < n && tries < n * 8; tries++) {
      const side = this.r.int(0, 3), t = this.r.range(-A - 8, A + 8), d = A + this.r.range(1.5, 14);
      const x = side === 0 ? t : side === 1 ? t : side === 2 ? d : -d, z = side === 0 ? d : side === 1 ? -d : t;
      if (this.spec.isles?.length && isleEdge(this.spec, x, z).e > 0.95) {
        // islands: clouds + floating rocks drift in the void instead
        const k = this.r.pick(this.kitsOf('cloud', 'far')); if (!k) continue;
        this.kit(k, x, z, this.r.range(0, 6.28), this.r.range(k.s[0], k.s[1]), false, this.r.range(-9, -2));
        i++; continue;
      }
      const k = this.r.pick(pool);
      this.kit(k, x, z, this.r.range(0, 6.283), this.r.range(k.s[0], k.s[1]) * 1.1, false);
      i++;
    }
  }
  walls(y0 = -6, y1 = 10) {
    const A = this.A, h = (y1 - y0) / 2, c = (y0 + y1) / 2;
    this.box([0, c, -A / 2 - 0.5], [A / 2 + 1, h, 0.5], 'invisible', ''); this.box([0, c, A / 2 + 0.5], [A / 2 + 1, h, 0.5], 'invisible', '');
    this.box([-A / 2 - 0.5, c, 0], [0.5, h, A / 2 + 1], 'invisible', ''); this.box([A / 2 + 0.5, c, 0], [0.5, h, A / 2 + 1], 'invisible', '');
  }
  /** 8 spawn points in a loose arc behind / beside a frame's origin (on the ground). */
  spawnsNear(f: Fr, dz = -4.5) {
    for (let i = 0; i < 8; i++) {
      const lx = (i % 4 - 1.5) * 1.35, lz = dz - Math.floor(i / 4) * 1.4;
      const [x, z] = f.w(lx, lz);
      this.d.spawns.push({ p: v3(x, this.h(x, z) + 0.1, z), yaw: r2(f.yaw) } as SpawnDesc);
    }
  }
  cam(name: string, p: V3, look: V3, fov = 50) {
    // never inside a hill: at least 3.5 m over the ground under (and just in front of) the camera
    const dx = look[0] - p[0], dz = look[2] - p[2], l = Math.hypot(dx, dz) || 1;
    const gy = Math.max(this.h(p[0], p[2]), this.h(p[0] + dx / l * 3, p[2] + dz / l * 3), this.h(p[0] + dx / l * 7, p[2] + dz / l * 7) - 1);
    this.d.cams[name] = { p: v3(p[0], Math.max(p[1], gy + (name === 'CAM_SPECT_WIDE' ? 5 : 1.6)), p[2]), look: v3(...look), fov };
  }
  wagonAt(f: Fr) { this.d.wagon = { p: v3(f.x, this.h(f.x, f.z), f.z), yaw: r2(f.yaw) }; }
  /** the flat pad the wagon + its team stand on (animal slots reach ~8 m ahead) */
  wagonPad(f: Fr, h = 0) { this.spec.pads.push({ x: f.w(0, 2.5)[0], z: f.w(0, 2.5)[1], hx: 3.2, hz: 7.5, yaw: f.yaw, h, fall: 5 }); this.blockRect(f, 0, 2.5, 3, 7.5); }
}

// ---------------------------------------------------------------- shared little builders
/** A post-and-rail fence from a to b (colliders: one thin box; visuals: posts + 2 rails). */
function fence(g: G, a: V2, b: V2, h = 1.1, m = 'wood', collide = true) {
  const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
  if (L < 0.3) return;
  const yaw = Math.atan2(dx, dz), mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, y = g.h(mx, mz);
  if (collide) g.box(v3(mx, y + h / 2, mz), [0.08, h / 2, L / 2], 'fence', '', yawQ(yaw));
  const n = Math.max(1, Math.round(L / 2.2));
  for (let i = 0; i <= n; i++) { const x = a[0] + dx * i / n, z = a[1] + dz * i / n; const yy = g.h(x, z); g.part({ t: 'box', p: v3(x, yy + h / 2 + 0.05, z), he: [0.07, h / 2 + 0.08, 0.07], q: yawQ(yaw), m }); }
  for (const k of [0.45, 0.85]) g.part({ t: 'box', p: v3(mx, y + h * k, mz), he: [0.035, 0.06, L / 2], q: yawQ(yaw), m });
}
/** Crates / barrels piles (solid) at a spot. */
function clutter(g: G, x: number, z: number, n: number, yaw: number) {
  const f = new Fr(x, z, yaw, g.h(x, z));
  for (let i = 0; i < n; i++) {
    const lx = (i % 3 - 1) * 0.75, lz = Math.floor(i / 3) * 0.8;
    if (g.r.chance(0.5)) { g.fbox(f, lx, 0.3, lz, [0.33, 0.3, 0.33], 'wood', 'wood', g.r.range(-0.3, 0.3)); if (g.r.chance(0.4)) g.pbox(f, lx, 0.8, lz, [0.25, 0.2, 0.25], 'wood_dark', g.r.range(-0.4, 0.4)); }
    else { const p = f.p(lx, 0.45, lz); g.cyl(p, 0.3, 0.45, 'wood', 'wood_dark'); }
  }
  g.block(x, z, 2);
}
/** A lantern on a post (light + glow part). */
function lanternPost(g: G, x: number, z: number, h = 2.2) {
  const y = g.h(x, z);
  g.part({ t: 'cyl', p: v3(x, y + h / 2, z), r: 0.06, hh: h / 2, m: 'wood_dark', seg: 6 });
  g.part({ t: 'ball', p: v3(x, y + h + 0.12, z), s: [0.14, 0.18, 0.14], m: 'glow' });
  g.light(v3(x, y + h + 0.1, z), g.th === 'l' ? '#ffe8a0' : g.th === 'b' ? '#ffd070' : '#ffc070', 9, 1, true);
  g.cyl(v3(x, y + h / 2, z), 0.1, h / 2, 'wood', '');
}
/** Smooth curve through control points (Catmull-Rom), every ~step m. */
function curve(ctrl: V2[], step = 2.5): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[Math.min(ctrl.length - 1, i + 2)];
    const n = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const c = (a: number, b: number, cc: number, d: number) => 0.5 * (2 * b + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t2 + (-a + 3 * b - 3 * cc + d) * t3);
      out.push([c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(ctrl[ctrl.length - 1]);
  return out;
}
/** A road that crosses the arena through `through` points (and a little beyond the walls). */
function roadThrough(g: G, pts: V2[], w = 4.2) { const c = curve(pts); g.road(c, w, 'road'); g.blockLine(c, w / 2 + 0.9); return c; }

function themeText(g: G, k: 'open' | 'ford' | 'photo' | 'sign' | 'finish'): string[] {
  const b = g.th === 'b', l = g.th === 'l';
  switch (k) {
    case 'open': return [b ? 'OPEN-ISH' : l ? 'BLESSED & OPEN' : 'OPEN'];
    case 'ford': return b ? ['FORD HERE', '(PROBABLY)'] : l ? ['CLOUD FORD', 'wade with faith'] : ['FORD'];
    case 'photo': return b ? ['PHOTO OP', 'say "cheese"'] : l ? ['PILGRIM', 'PORTRAIT'] : ['PHOTO', 'SPOT'];
    case 'sign': return ['SIGN HERE'];
    case 'finish': return [g.o.name ? g.o.name.toUpperCase() : 'FINISH'];
  }
}

// ================================================================ STORE
function genStore(g: G) {
  const { r, th } = g;
  const A = g.A;
  g.spec.amp = th === 'l' ? 0.9 : 1.3; g.spec.scale = 24;
  if (th !== 'l') g.spec.rim = { at: A / 2 - 5, w: 14, h: r.range(2.5, 5) };
  const rot = r.int(0, 3) * Math.PI / 2 + r.range(-0.3, 0.3);
  const L = new Fr(0, 0, rot);                               // layout: the road runs along local X at lz = roadZ
  const W = r.range(9.5, 12.5), D = r.range(7.5, 9.5), H = r.range(3.0, 3.5);
  const roadZ = r.range(5.5, 8.5);
  const bLocal: V2 = [r.range(-4, 4), -D / 2 - r.range(0.6, 2.4)];
  const bw = L.w(bLocal[0], bLocal[1]);
  const B = new Fr(bw[0], bw[1], rot + r.range(-0.1, 0.1));   // the building (+Z = its front, toward the road)
  const pd = r.range(2.0, 3.0);                               // porch depth
  // flat yard: building + porch + the stretch of road in front
  g.spec.pads.push({ x: L.w(0, (bLocal[1] - D / 2 + roadZ + 3) / 2)[0], z: L.w(0, (bLocal[1] - D / 2 + roadZ + 3) / 2)[1], hx: Math.max(W / 2 + 10, 14), hz: (roadZ + 3 - (bLocal[1] - D / 2 - 3)) / 2, yaw: rot, h: 0, fall: 7 });
  // ---- the building
  const t = 0.15, fz = D / 2, bz = -D / 2;
  const doorX = r.pick([-1, 1]) * r.range(0.6, W / 2 - 3.4), winX = doorX > 0 ? -r.range(1.6, W / 2 - 1.8) : r.range(1.6, W / 2 - 1.8);
  const seg = (x0: number, x1: number, y0: number, y1: number, z: number, m = 'wall', tag: Tag = 'wall') => { if (x1 - x0 < 0.05) return; g.fbox(B, (x0 + x1) / 2, (y0 + y1) / 2, z, [(x1 - x0) / 2, (y1 - y0) / 2, t], tag, m); };
  g.fbox(B, 0, 0.05, 0, [W / 2, 0.05, D / 2], 'wood', 'plank');                              // floor
  // front wall: door 1.2 × 2.2, window 2.6 wide (counter below 1.1, wall above 2.2)
  const cuts = [[doorX - 0.6, doorX + 0.6, 'door'], [winX - 1.3, winX + 1.3, 'win']].sort((a, b) => (a[0] as number) - (b[0] as number)) as [number, number, string][];
  let x = -W / 2;
  for (const [c0, c1, k] of cuts) {
    seg(x, c0, 0, H, fz);
    if (k === 'door') seg(c0, c1, 2.2, H, fz);
    else { seg(c0, c1, 0, 1.1, fz, 'wood', 'counter'); seg(c0, c1, 2.2, H, fz); }
    x = c1;
  }
  seg(x, W / 2, 0, H, fz);
  // back wall with the cat flap (0.5 × 0.45)
  const cfx = r.range(-W / 2 + 1.2, W / 2 - 1.2);
  seg(-W / 2, cfx - 0.25, 0, H, bz); seg(cfx - 0.25, cfx + 0.25, 0.45, H, bz); seg(cfx + 0.25, W / 2, 0, H, bz);
  g.fbox(B, -W / 2, H / 2, 0, [t, H / 2, D / 2], 'wall', 'wall'); g.fbox(B, W / 2, H / 2, 0, [t, H / 2, D / 2], 'wall', 'wall');
  g.fbox(B, 0, H + 0.1, 0, [W / 2 + 0.45, 0.1, D / 2 + 0.45], 'roof', 'trim');               // flat roof slab (macros walk on it)
  // gable roof + trim (visual)
  const ridge = r.range(1.1, 1.8);
  g.part({ t: 'gable', p: B.p(0, H + 0.2, 0), he: [W / 2 + 0.6, ridge, D / 2 + 0.6], yaw: B.yaw, m: 'roof' });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.pbox(B, sx * (W / 2 + 0.02), H / 2, sz * (D / 2 + 0.02), [0.14, H / 2 + 0.05, 0.14], 'trim');
  g.pbox(B, 0, 0.12, fz + 0.04, [W / 2 + 0.1, 0.12, 0.06], 'trim'); g.pbox(B, 0, H - 0.05, fz + 0.06, [W / 2 + 0.1, 0.08, 0.06], 'trim');
  g.pbox(B, doorX, 1.1, fz + 0.05, [0.62, 1.12, 0.03], 'wood_dark'); g.pbox(B, doorX - 0.66, 1.15, fz + 0.07, [0.05, 1.15, 0.05], 'trim'); g.pbox(B, doorX + 0.66, 1.15, fz + 0.07, [0.05, 1.15, 0.05], 'trim');
  g.pbox(B, winX, 1.12, fz + 0.12, [1.4, 0.05, 0.25], 'wood');                              // window sill / service counter
  if (th === 'b') { // stilts + skirt boards (a swamp shack on a dock)
    for (let i = 0; i <= 4; i++) for (const sz of [-1, 1]) g.part({ t: 'cyl', p: B.p(-W / 2 + i * W / 4, -0.4, sz * (D / 2 - 0.1)), r: 0.13, hh: 0.55, m: 'wood_dark', seg: 7 });
    g.part({ t: 'cyl', p: B.p(W / 2 - 1.2, H + ridge + 0.4, -D / 4), r: 0.16, hh: 0.8, m: 'metal', seg: 8 });  // stove pipe
  } else if (th === 'l') { // a little bell spire
    g.pbox(B, 0, H + ridge + 0.55, 0, [0.55, 0.55, 0.55], 'wall'); g.part({ t: 'cyl', p: B.p(0, H + ridge + 1.6, 0), r: 0.7, r2: 0.02, hh: 0.6, m: 'roof', seg: 8 });
    g.part({ t: 'ball', p: B.p(0, H + ridge + 2.35, 0), s: [0.13, 0.13, 0.13], m: 'gold' });
    for (const sx of [-1, 1]) g.pbox(B, sx * (W / 2 + 0.04), H * 0.55, fz * 0.2, [0.03, 0.45, 0.3], 'gold');
  } else g.pbox(B, 0, H + 0.7, fz + 0.1, [W / 2, 0.7, 0.08], 'wall');                        // frontier false front
  // shop sign + open sign + lights
  g.sign(B.p(doorX, H - 0.45, fz + 0.2), B.yaw, Math.min(4.2, W * 0.45), 0.7, [g.o.storeName ?? 'GENERAL STORE'], th === 'b' ? 'swamp' : th === 'l' ? 'gold' : 'board');
  g.sign(B.p(winX, 2.55, fz + 0.18), B.yaw, 1.5, 0.45, themeText(g, 'open'), th === 'b' ? 'neon' : th === 'l' ? 'gold' : 'board');
  g.light(B.p(doorX, 2.6, fz + 0.6), th === 'b' ? '#ff6ad8' : '#ffd890', 7, 0.9, th === 'b');
  g.light(B.p(0, H - 0.4, 0), '#ffd49a', 9, 1.1, true);
  // ---- inside: shelves (3 layouts), a counter, the shopkeeper behind it
  type Shelf = { x: number; z: number; len: number; alongX: boolean };
  const shelves: Shelf[] = [];
  const layout = r.pick(['sides', 'aisles', 'u'] as const);
  const iw = W / 2 - 0.6, idp = D / 2 - 0.6;
  if (layout === 'sides') {
    for (const sx of [-1, 1]) { shelves.push({ x: sx * (W / 2 - 0.55), z: -D / 2 + 0.3 + (D - 2.4) * 0.28, len: (D - 2.4) * 0.5, alongX: false }); shelves.push({ x: sx * (W / 2 - 0.55), z: -D / 2 + 0.3 + (D - 2.4) * 0.8, len: (D - 2.4) * 0.38, alongX: false }); }
    shelves.push({ x: 0, z: 0.2, len: Math.min(4.6, W - 5.2), alongX: true });
  } else if (layout === 'aisles') {
    const rows = D > 8.3 ? 2 : 1;
    for (let i = 0; i < rows; i++) shelves.push({ x: r.range(-0.6, 0.6), z: -D / 2 + 2.2 + i * 2.3, len: Math.min(W - 4.8, 6.5), alongX: true });
    for (const sx of [-1, 1]) shelves.push({ x: sx * (W / 2 - 0.55), z: D / 2 - 2.4, len: 1.7, alongX: false });
  } else {
    shelves.push({ x: 0, z: -D / 2 + 0.55, len: W - 4.6, alongX: true });
    for (const sx of [-1, 1]) shelves.push({ x: sx * (W / 2 - 0.55), z: -0.2, len: D - 3.6, alongX: false });
  }
  let csx = cfx > 0 ? -1 : 1;
  // counter candidates: a back corner (either side), the back middle, a front corner away from the door; the first
  // one clear of every shelf wins (else the shelves near it make room)
  const cands: [number, number, number][] = [[csx * (W / 2 - 2.6), -D / 2 + 1.45, -1], [-csx * (W / 2 - 2.6), -D / 2 + 1.45, -1], [0, -D / 2 + 1.45, -1], [(doorX > 0 ? -1 : 1) * (W / 2 - 2.6), D / 2 - 1.5, 1]];
  const clash = (x0: number, z0: number) => shelves.filter((s) => Math.abs(s.x - x0) < (s.alongX ? s.len / 2 + 1.9 : 2.1) && Math.abs(s.z - z0) < (s.alongX ? 1.4 : s.len / 2 + 0.9));
  const pickC = cands.find(([x0, z0]) => !clash(x0, z0).length) ?? cands[0];
  const [cx, counterZ, back] = pickC;
  // shelves in the counter's way get shortened (the longer remaining piece stays), tiny leftovers go
  for (const s of clash(cx, counterZ)) {
    const c0 = s.alongX ? s.x : s.z, h = s.len / 2, f0 = s.alongX ? cx - 1.9 : counterZ - 0.9, f1 = s.alongX ? cx + 1.9 : counterZ + 0.9;
    const a: [number, number] = [c0 - h, Math.min(c0 + h, f0)], b: [number, number] = [Math.max(c0 - h, f1), c0 + h];
    const keep = a[1] - a[0] >= b[1] - b[0] ? a : b;
    if (keep[1] - keep[0] < 1.2) { shelves.splice(shelves.indexOf(s), 1); continue; }
    s.len = keep[1] - keep[0];
    if (s.alongX) s.x = (keep[0] + keep[1]) / 2; else s.z = (keep[0] + keep[1]) / 2;
  }
  // the stock needs ~24 shelf places: a wall shelf beside the door makes up any shortfall
  if (shelves.reduce((a, s) => a + 2 * Math.floor(s.len / 0.66), 0) < 26) {
    const sx = doorX > 0 ? 1 : -1, x0 = doorX + sx * 1.1, x1 = sx * (W / 2 - 0.4);
    if (Math.abs(x1 - x0) > 1.4) shelves.push({ x: (x0 + x1) / 2, z: fz - 0.55, len: Math.abs(x1 - x0), alongX: true });
    const x2 = winX + (winX > doorX ? -1 : 1) * 1.5, x3 = doorX - sx * 0.9;
    if ((x3 - x2) * (x3 > x2 ? 1 : -1) > 1.4 && Math.sign(x3 - x2) === Math.sign(doorX - winX)) shelves.push({ x: (x2 + x3) / 2, z: fz - 0.55, len: Math.abs(x3 - x2), alongX: true });
  }
  csx = cx < 0 ? -1 : 1;
  g.fbox(B, cx, 0.55, counterZ, [1.6, 0.55, 0.42], 'counter', 'wood_dark');
  g.pbox(B, cx, 1.12, counterZ, [1.7, 0.03, 0.5], 'trim');
  const kp = B.p(cx, 0, counterZ + back * 0.95);
  g.d.npcs.push({ id: 'shopkeeper', p: [kp[0], 0.1, kp[2]], yaw: r2(B.yaw + (back > 0 ? Math.PI : 0)), role: 'shopkeeper' });
  for (const s of shelves) {
    const he: V3 = s.alongX ? [s.len / 2, 0.05, 0.4] : [0.4, 0.05, s.len / 2];
    for (const y of [0.45, 1.15]) g.fbox(B, s.x, y, s.z, he, 'shelf', 'wood');
    // uprights + back panel (visual)
    const ends: V2[] = s.alongX ? [[s.x - s.len / 2, s.z], [s.x + s.len / 2, s.z]] : [[s.x, s.z - s.len / 2], [s.x, s.z + s.len / 2]];
    for (const [ex, ez] of ends) g.pbox(B, ex, 0.95, ez, [0.05, 0.95, 0.05], 'wood_dark');
    g.pbox(B, s.x, 1.72, s.z, s.alongX ? [s.len / 2, 0.04, 0.4] : [0.4, 0.04, s.len / 2], 'wood');
  }
  const ck = B.w(cx, counterZ - back * 0.9);
  g.zone('checkout', [ck[0], 1, ck[1]], [1.8, 1, 1.8]);
  const wz = B.w(winX, fz + 0.9);
  g.zone('window', [wz[0], 1.5, wz[1]], [1.4, 1.2, 1.4]);
  const cf = B.w(cfx, bz);
  g.zone('catflap', [cf[0], 0.3, cf[1]], [0.32, 0.3, 0.32]);
  // ---- stock on the shelves (prices come from the deck)
  // (crates lie across the shelf: item yaw = the shelf's depth axis; ~0.66 m apart along it)
  const slots: { p: V3; top: boolean; yaw: number }[] = [];
  for (const s of shelves) {
    const n = Math.max(1, Math.floor(s.len / 0.66));
    for (const [y, top] of [[1.2, true], [0.5, false]] as const) for (let k = 0; k < n; k++) {
      const off = -s.len / 2 + (k + 0.5) * (s.len / n);
      slots.push({ p: B.p(s.alongX ? s.x + off : s.x, y, s.alongX ? s.z : s.z + off), top, yaw: r2(B.yaw + (s.alongX ? Math.PI / 2 : 0)) });
    }
  }
  const food = r.int(8, 10);
  const stock = [...Array(food).fill('crate_food'), 'clothes_bundle', 'clothes_bundle', 'clothes_bundle', 'clothes_bundle', 'ammo_box', 'ammo_box', 'ammo_box', 'ammo_box', 'medicine', 'medicine', 'medicine', 'meme_frog'];
  const low = slots.filter((s) => !s.top), high = slots.filter((s) => s.top);
  for (const item of stock) {
    const pool = high.length ? high : low;
    const s = pool.splice(r.int(0, pool.length - 1), 1)[0];
    if (!s) break;
    g.d.items.push({ item, p: [s.p[0], r2(s.p[1] + (PROPS[item]?.size[1] ?? 0.2) + 0.02), s.p[2]], yaw: s.yaw });
  }
  // heavy stuff on the floor: two wheels stacked inside the door, the axle + tongue along the back wall, a barrel
  const fl = (lx: number, lz: number, item: string, y: number) => { const p = B.p(lx, y, lz); g.d.items.push({ item, p, yaw: r2(B.yaw) }); };
  const wx0 = doorX + (doorX > 0 ? -1.5 : 1.5);
  fl(wx0, fz - 1.6, 'spare_wheel', 0.2); fl(wx0, fz - 1.6, 'spare_wheel', 0.4);
  fl(-csx * (W / 2 - 1.9), -D / 2 + 0.5, 'spare_axle', 0.2); fl(-csx * (W / 2 - 1.9), -D / 2 + 0.5, 'spare_tongue', 0.45);
  fl(csx * (W / 2 - 0.7), fz - 0.8, 'barrel', 0.55);
  // ---- porch (a low deck: catalogue orders drop in front of it, next to the wagon)
  const px = doorX * 0.6;
  const pw = Math.min(W / 2 - 0.3, Math.max(2.8, Math.abs(doorX) + 2.4));
  g.fbox(B, px, 0.06, fz + pd / 2, [pw, 0.06, pd / 2], 'wood', 'plank');
  for (const sx of [-1, 1]) { g.pbox(B, px + sx * (pw - 0.1), 1.25, fz + pd - 0.1, [0.08, 1.25, 0.08], 'wood_dark'); }
  g.part({ t: 'box', p: B.p(px, 2.55, fz + pd / 2), he: [pw + 0.2, 0.05, pd / 2 + 0.25], q: yawPitch(B.yaw, 0.18), m: 'cloth' });   // awning
  if (r.chance(0.7)) g.fbox(B, px + (doorX > px ? -1 : 1) * (pw - 0.5), 0.55, fz + pd - 0.12, [0.5, 0.45, 0.05], 'fence', 'wood');   // a bit of railing
  const porch = B.w(px, fz + pd + 1.3);
  g.zone('porch', [porch[0], 0.55, porch[1]], [1.8, 0.55, 1.3]);
  // ---- nav graph (bots): door out / in, interior lattice, around the building
  const nav: V3[] = [B.p(doorX, 0, fz + 1.5), B.p(doorX, 0, fz - 1.1)];
  for (let ix = -1; ix <= 1; ix++) for (let iz = -1; iz <= 1; iz++) {
    const lx = ix * (iw - 0.6) * 0.8, lz = iz * (idp - 0.4) * 0.75;
    const inShelf = shelves.some((s) => Math.abs(lx - s.x) < (s.alongX ? s.len / 2 + 0.6 : 0.9) && Math.abs(lz - s.z) < (s.alongX ? 0.9 : s.len / 2 + 0.6)) || (Math.abs(lx - cx) < 2.1 && Math.abs(lz - counterZ) < 1.0);
    if (!inShelf) nav.push(B.p(lx, 0, lz));
  }
  // (no nodes round the back: the bots' one-hop detour would walk into those dead ends; the door is the way in)
  nav.push(B.p(doorX, 0, fz + pd + 1.8));
  g.d.paths.nav = nav.map((p) => [p[0], 0, p[2]]);
  g.blockRect(B, 0, pd / 2, W / 2 + 1.2, D / 2 + pd / 2 + 1.4);
  // ---- the road + the wagon
  const bend = r.range(-0.004, 0.004);
  const rz = (lx: number) => roadZ + lx * lx * bend;
  const rdir = r.pick([-1, 1]);
  const wx = L.l(...B.w(doorX, fz))[0] + r.range(-1.5, 1.5);          // the wagon's side faces the shop door
  const WG = new Fr(...L.w(wx, rz(wx)), rot + rdir * Math.PI / 2);
  g.wagonAt(WG); g.wagonPad(WG);
  const ends: V2[] = [];
  for (const lx of [-A * 0.75, -A * 0.35, 0, A * 0.35, A * 0.75]) ends.push(L.w(lx, rz(lx) + (Math.abs(lx) > A * 0.5 ? r.range(-6, 6) : 0)));
  roadThrough(g, ends);
  g.spawnsNear(WG, -4.8);
  // ---- the draft-animal pen beside the store (gate toward the road)
  const side = doorX > 0 ? -1 : 1;
  const PW = r.range(6.5, 8.5), PD = r.range(5.5, 7.5);
  const pc = L.w(bLocal[0] + side * (W / 2 + PW / 2 + r.range(2.5, 4)), bLocal[1] + r.range(-1, 1.5));
  const P = new Fr(pc[0], pc[1], rot + r.range(-0.15, 0.15));
  g.spec.pads.push({ x: pc[0], z: pc[1], hx: PW / 2 + 1.5, hz: PD / 2 + 1.5, yaw: P.yaw, h: 0, fall: 5 });
  const cn = (lx: number, lz: number) => P.w(lx, lz);
  const gate = r.range(-PW / 2 + 1.6, PW / 2 - 1.6);
  fence(g, cn(-PW / 2, -PD / 2), cn(PW / 2, -PD / 2)); fence(g, cn(-PW / 2, -PD / 2), cn(-PW / 2, PD / 2)); fence(g, cn(PW / 2, -PD / 2), cn(PW / 2, PD / 2));
  fence(g, cn(-PW / 2, PD / 2), cn(gate - 1.1, PD / 2)); fence(g, cn(gate + 1.1, PD / 2), cn(PW / 2, PD / 2));
  for (let i = 0; i < 6; i++) { const p = P.p(-PW / 2 + 1.4 + (i % 3) * (PW - 2.8) / 2, 0.7, -PD / 2 + 1.5 + Math.floor(i / 3) * (PD - 3)); g.d.items.push({ item: 'draft', p: [p[0], r2(g.h(p[0], p[2]) + 0.7), p[2]] }); }
  g.zone('pen', [pc[0], 1, pc[1]], [PW / 2 + 0.5, 1, PD / 2 + 0.5]);
  const tr = P.p(PW / 2 - 1.2, 0.28, -PD / 2 + 0.6);
  g.box(tr, [0.9, 0.28, 0.3], 'wood', 'wood', yawQ(P.yaw));
  g.part({ t: 'box', p: v3(tr[0], tr[1] + 0.2, tr[2]), he: [0.8, 0.04, 0.22], q: yawQ(P.yaw), m: th === 'l' ? 'cloud' : 'moss' });
  g.blockRect(P, 0, 0, PW / 2 + 1, PD / 2 + 1);
  // ---- yard clutter: crate piles, barrels, a lantern post, the fort's palisade
  for (let i = 0; i < r.int(2, 4); i++) {
    const a = B.w(r.pick([-1, 1]) * (W / 2 + r.range(0.9, 2.2)), r.range(-D / 2, D / 2));
    if (g.free(a[0], a[1], 1.2)) clutter(g, a[0], a[1], r.int(2, 5), B.yaw + r.range(-0.3, 0.3));
  }
  const lp = L.w(wx + r.pick([-1, 1]) * r.range(5, 8), roadZ - 3.2);
  if (g.free(lp[0], lp[1], 0.6)) lanternPost(g, lp[0], lp[1]);
  if (g.o.fort) fortWalls(g, L, bLocal, W, D);
  // ---- scatter + framing
  const sc = th === 'b' ? ['tree', 'tree_s', 'bush', 'reed', 'rock', 'junk', 'crystal'] as KitDef['role'][] : th === 'l' ? ['tree', 'tree_s', 'bush', 'ruin', 'marker', 'crystal', 'cloud'] as KitDef['role'][] : ['tree', 'tree_s', 'bush', 'rock', 'reed', 'junk', 'crystal'] as KitDef['role'][];
  g.scatter(sc, r.int(22, 34), () => true, { cluster: 5, spread: 7 });
  g.frame(r.int(26, 36));
  if (th === 'b' && g.bi === 0 && r.chance(0.7)) pond(g, 'pond');
  for (let i = 0; i < 5; i++) { const k = g.th === 'l' ? 3 : r.pick([0, 3, 4, 3]); g.paint(k, r.range(-A / 2, A / 2), r.range(-A / 2, A / 2), k === 0 ? r.range(2.5, 4.5) : r.range(3, 8)); }
  // ---- cameras
  const wc = L.w(r.pick([-1, 1]) * r.range(12, 17), roadZ + r.range(9, 14));
  g.cam('CAM_SPECT_WIDE', [wc[0], r.range(7, 10), wc[1]], B.p(0, 1, 0), 50);
  g.cam('CAM_SPECT_HERO', B.p(doorX + (doorX > 0 ? -4.5 : 4.5), 2.6, fz + pd + 6.5), B.p(doorX * 0.6, 1.6, fz - 1), 55);
  if (th === 'l') leafEdge(g);
}
function fortWalls(g: G, L: Fr, b: V2, W: number, D: number) {
  // a palisade behind the store + a watchtower; the gate stays open toward the road
  const back = b[1] - D / 2 - 4.5, xs = [-g.A / 2 + 4, g.A / 2 - 4];
  const a0 = L.w(xs[0], back), a1 = L.w(xs[1], back);
  const n = Math.round(Math.hypot(a1[0] - a0[0], a1[1] - a0[1]) / 0.55);
  for (let i = 0; i <= n; i++) { const x = a0[0] + (a1[0] - a0[0]) * i / n, z = a0[1] + (a1[1] - a0[1]) * i / n; if (g.free(x, z, 0.2, 0)) { const hh = 1.6 + (i % 3) * 0.12; g.part({ t: 'cyl', p: v3(x, g.h(x, z) + hh, z), r: 0.24, r2: 0.2, hh, m: 'wood', seg: 7 }); } }
  const yaw = Math.atan2(a1[0] - a0[0], a1[1] - a0[1]), mid = L.w(0, back);
  g.box(v3(mid[0], g.h(mid[0], mid[1]) + 1.7, mid[1]), [0.25, 1.7, Math.hypot(a1[0] - a0[0], a1[1] - a0[1]) / 2], 'wall', '', yawQ(yaw));
  const tw = L.w(xs[g.r.int(0, 1)] * 0.7, back + 3);
  const T = new Fr(tw[0], tw[1], L.yaw, g.h(tw[0], tw[1]));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.fbox(T, sx * 1.1, 2.4, sz * 1.1, [0.13, 2.4, 0.13], 'wood', 'wood_dark');
  g.fbox(T, 0, 4.8, 0, [1.5, 0.1, 1.5], 'wood', 'plank');
  g.part({ t: 'gable', p: T.p(0, 5.9, 0), he: [1.7, 0.9, 1.7], yaw: T.yaw, m: 'roof' });
  g.part({ t: 'cyl', p: T.p(0, 7.4, 0), r: 0.04, hh: 0.8, m: 'wood_dark', seg: 5 }); g.part({ t: 'box', p: T.p(0.45, 7.9, 0), he: [0.45, 0.28, 0.02], q: yawQ(T.yaw), m: 'cloth' });
  g.block(tw[0], tw[1], 2.5);
}
/** Skyisles: the stop sits on one big island; the ground falls away past the walls (cloud sea below). */
function leafEdge(g: G) {
  const A = g.A;
  g.spec.isles = [{ x: 0, z: 0, rx: A * 0.5 + 9, rz: A * 0.5 + 9, h: 0 }];
  g.spec.voidH = -30; g.art.cloudSea = -16;
  g.zone('kill', [0, -14, 0], [A, 4, A]);
}
function pond(g: G, name: string, at?: V2, rr?: number, where?: (x: number, z: number) => boolean) {
  for (let tries = 0; tries < 60; tries++) {
    const r = rr ?? g.r.range(3.5, 6.5);
    const [x, z] = at ?? [g.r.range(-g.A / 2 + r + 5, g.A / 2 - r - 5), g.r.range(-g.A / 2 + r + 5, g.A / 2 - r - 5)];
    if (!at && (!g.free(x, z, r + 2, 4) || (where && !where(x, z)))) continue;
    const level = r2(g.h(x, z) + 0.05);
    g.spec.pads.push({ x, z, r: (r + 0.8) * 1.45, h: level + 0.4, fall: 3 });   // (covers the water box corners)
    const depth = g.r.range(0.6, 1.2);
    g.spec.bowls.push({ x, z, r, d: depth, level });
    g.d.water.push({ name, p: [x, r2(level - depth / 2), z], he: [r2(r + 0.8), r2(depth / 2 + 0.02), r2(r + 0.8)], level, depth: r2(depth), flow: [0, 0], murk: g.th === 'l' ? 0.25 : 0.6, color: g.th === 'b' ? '#46703e' : g.th === 'l' ? '#8fd8f0' : g.pal.water });
    g.block(x, z, r + 1.2);
    g.paint(2, x, z, r + 0.9);
    const lily: number[] = g.art.lily ?? [];
    if (g.th === 'b') for (let i = 0; i < g.r.int(4, 9); i++) { const a = g.r.range(0, 6.28), d = g.r.range(0, r * 0.8); lily.push(r2(x + Math.cos(a) * d), r2(z + Math.sin(a) * d), r2(g.r.range(0.4, 0.9))); }
    g.art.lily = lily;
    const reeds = g.kitsOf('reed');
    if (reeds.length) for (let i = 0; i < g.r.int(3, 6); i++) { const a = g.r.range(0, 6.28); const k = g.r.pick(reeds); g.kit(k, x + Math.cos(a) * (r + 0.6), z + Math.sin(a) * (r + 0.6), g.r.range(0, 6.28), g.r.range(k.s[0], k.s[1]), false); }
    return { x, z, r, level };
  }
  return null;
}

// ================================================================ RIVER
function genRiver(g: G) {
  const { r, th } = g;
  const A = g.A;
  const rv = g.o.river ?? { depth: 3, width: 500, swift: false };
  const depthM = Math.max(0.3, rv.depth * 0.3048);
  const Wr = Math.max(9, Math.min(24, 9 + (rv.width - 380) / 38 + r.range(-1.5, 1.5)));   // water width (m)
  const nz = r.pick([-1, 1]);           // the near bank's side (-Z or +Z)
  const fx = r.pick([-1, 1]);           // flow direction along X
  const tilt = r.range(-0.11, 0.11), amp = r.range(0.4, 2.4), k1 = r.range(0.05, 0.11), ph = r.range(0, 6.28);
  const zc = (x: number) => x * tilt + Math.sin(x * k1 + ph) * amp;
  const hb = r.range(0.35, 1.2), hf = r.range(0.35, 1.3);       // bank heights (near / far)
  g.spec.amp = 0.5; g.spec.scale = 18; g.spec.base = (hb + hf) / 2; g.spec.detail = 0.1;
  g.spec.floor = 0.22;
  if (th !== 'l') g.spec.rim = { at: A / 2 - 5, w: 14, h: r.range(2, 4) };
  const bank = Math.max(2.2, Math.min(4.5, Wr * 0.22));
  const half = Math.max(2.5, Wr / 2 - bank * 0.45);
  const xs: number[] = [], zs: number[] = [];
  for (let x = -A / 2 - 70; x <= A / 2 + 70.01; x += 3) { xs.push(r2(x)); zs.push(r2(zc(x))); }   // (on past the walls: the view draws it to the horizon)
  g.spec.chans.push({ xs, zs, half, bank, bed: -depthM * 1.12 });
  // near / far banks: gentle slopes toward the channel
  g.spec.mounds.push({ x: r.range(-A / 3, A / 3), z: nz * (A / 2 - 6), r: r.range(14, 22), h: r.range(0.4, 1.4) }, { x: r.range(-A / 3, A / 3), z: -nz * (A / 2 - 6), r: r.range(14, 22), h: r.range(0.4, 1.6) });
  const edge = (x: number, side: number) => zc(x) + side * (Wr / 2);        // ≈ the waterline
  // ---- the ford (the wagon's line), with a cut in each bank
  const xf = r.range(-A / 2 + 16, A / 2 - 16);
  const nearPark: V2 = [xf, edge(xf, nz) + nz * r.range(10, 12.5)], farPark: V2 = [xf + r.range(-3, 3), edge(xf, -nz) - nz * r.range(7, 10)];
  const WG = new Fr(nearPark[0], nearPark[1], nz > 0 ? Math.PI : 0);     // faces the river
  g.spec.pads.push({ x: nearPark[0], z: nearPark[1], r: 6.5, h: hb, fall: 4 }, { x: farPark[0], z: farPark[1], r: 5.5, h: hf, fall: 4 });
  const cut = (park: V2, h0: number, side: number) => {
    const ez = edge(park[0], side) - side * 0.2, mz = (park[1] + ez) / 2, hz = Math.abs(park[1] - ez) / 2;
    // a ramp pad: h0 at the park end → the waterline at the river end (local +Z points toward the river)
    g.spec.pads.push({ x: park[0], z: mz, hx: 2.8, hz, yaw: side > 0 ? Math.PI : 0, h: h0, h2: 0.05, fall: 3 });
  };
  cut(nearPark, hb, nz); cut(farPark, hf, -nz);
  g.wagonAt(WG);
  g.blockRect(WG, 0, 3, 3.5, 9);
  // ford path: sampled over the finished terrain every ~1.5 m (the wagon rides the real ground)
  const ford: V3[] = [];
  const fpts = curve([nearPark, [xf, zc(xf)], farPark], 1.5);
  for (const [x, z] of fpts) ford.push(v3(x, g.h(x, z), z));
  g.d.paths.ford = ford;
  g.road(curve([[nearPark[0] + r.range(-10, 10), nz * (A / 2 + 10)], [nearPark[0], nearPark[1] + nz * 5], nearPark], 2.5), 4, 'road');
  g.road(curve([farPark, [farPark[0], farPark[1] - nz * 5], [farPark[0] + r.range(-10, 10), -nz * (A / 2 + 10)]], 2.5), 4, 'road');
  { let run: V2[] = []; for (const q of [...fpts, [1e9, 1e9] as V2]) { if (q[0] < 1e8 && g.h(q[0], q[1]) > 0.08) run.push(q); else { if (run.length > 1) g.road(run, 3.2, 'path'); run = []; } } }
  // ---- the ferry: up- or downstream of the ford, landings at the water's edge
  let xr = xf + r.pick([-1, 1]) * r.range(12, 17);
  if (Math.abs(xr) > A / 2 - 8) xr = xf - Math.sign(xr - xf) * r.range(12, 16);
  const nL = edge(xr, nz) - nz * 3.0, fL = edge(xr, -nz) + nz * 3.0;
  const nearL: V3 = [r2(xr), -0.1, r2(Math.abs(nL - zc(xr)) < 3.8 ? zc(xr) + nz * 3.8 : nL)], farL: V3 = [r2(xr), -0.1, r2(Math.abs(fL - zc(xr)) < 3.8 ? zc(xr) - nz * 3.8 : fL)];
  g.d.paths.ferry = [nearL, farL];
  // docks: plank piers from the bank to each landing + posts + the ferry rope across
  for (const [land, side, bh] of [[nearL, nz, hb], [farL, -nz, hf]] as const) {
    const z0 = edge(xr, side) + side * 2.2, z1 = land[2] + side * 3.2;
    const zm = (z0 + z1) / 2, hz = Math.abs(z0 - z1) / 2;
    const deck = Math.max(0.25, Math.min(bh, 0.55));
    g.box(v3(xr, deck - 0.08, zm), [1.4, 0.08, hz], 'dock', 'plank');
    for (const sx of [-1, 1]) for (let i = 0; i <= 2; i++) { const pz = z0 + (z1 - z0) * i / 2; g.part({ t: 'cyl', p: v3(xr + sx * 1.35, deck - 1, pz), r: 0.1, hh: 1.15, m: 'wood_dark', seg: 6 }); }
    g.spec.pads.push({ x: xr, z: z0 + side * 1.5, r: 3, h: deck, fall: 3 });
    g.block(xr, zm, 3);
    g.part({ t: 'cyl', p: v3(xr + 1.7, 1.2, z0), r: 0.14, hh: 1.4, m: 'wood_dark', seg: 7 });
  }
  g.part({ t: 'rope', a: [r2(xr + 1.7), 2.4, r2(edge(xr, nz) + nz * 2.2)], b: [r2(xr + 1.7), 2.4, r2(edge(xr, -nz) - nz * 2.2)], sag: 0.6 });
  g.d.npcs.push({ id: 'ferryman', p: v3(xr - 2.2, g.h(xr - 2.2, edge(xr, nz) + nz * 3.2) + 0.02, edge(xr, nz) + nz * 3.2), yaw: nz > 0 ? Math.PI : 0, role: 'ferryman' });
  const shack = new Fr(xr - 5, edge(xr, nz) + nz * 6, nz > 0 ? Math.PI : 0);
  if (g.free(shack.x, shack.z, 2.5)) hut(g, shack, 2.4, 2.0, 'ferry');
  // ---- caulk & float: launch from the water's edge next to the ford
  const cx = xf + (xr > xf ? -1 : 1) * r.range(5, 7);
  // (the raft starts on a gentle slipway 2.5 m up the bank and is paddled off it, like the old flat bank)
  g.spec.pads.push({ x: cx, z: edge(cx, nz) + nz * 3.2, hx: 2.6, hz: 3.4, yaw: nz > 0 ? Math.PI : 0, h: Math.min(hb, 0.45), h2: 0.02, fall: 2.5 });
  g.blockRect(new Fr(cx, edge(cx, nz) + nz * 3.2, 0), 0, 0, 3, 4);
  const cs: V2 = [cx, edge(cx, nz) + nz * 2.5];                    // (on the slipway, like the old flat bank's launch spot)
  g.d.paths.caulk = [v3(cs[0], g.h(cs[0], cs[1]), cs[1]), v3(cx, 0, edge(cx, -nz) + nz * 0.6)];
  // ---- water, banks, zones
  const zmin = Math.min(...zs.filter((_, i) => Math.abs(xs[i]) <= A / 2)), zmax = Math.max(...zs.filter((_, i) => Math.abs(xs[i]) <= A / 2));
  const wz0 = zmin - Wr / 2 - 1.5, wz1 = zmax + Wr / 2 + 1.5;
  const flow = (rv.swift ? 2.8 : 1.6) * (th === 'l' ? 1.1 : 1) * r.range(0.85, 1.15);
  g.d.water.push({ name: 'river', p: [0, r2(-depthM / 2), r2((wz0 + wz1) / 2)], he: [A / 2, r2(depthM / 2 + 0.02), r2((wz1 - wz0) / 2)], level: 0, depth: r2(depthM), flow: [r2(fx * flow), 0], murk: th === 'l' ? 0.2 : th === 'b' ? 0.72 : 0.55, color: th === 'b' ? '#46703e' : th === 'l' ? '#cfc8f2' : g.pal.water });
  // farbank starts 3 m into the water at the crossings (ferry + raft landings count), nearbank likewise
  // (t = distance toward that bank's outside: the zone starts 3.5 m into the water from the nearer crossing's edge)
  const farEdgeZ = -nz * Math.min(-nz * edge(xf, -nz), -nz * edge(xr, -nz)), nearEdgeZ = nz * Math.min(nz * edge(xf, nz), nz * edge(xr, nz));
  const fb0 = farEdgeZ + nz * 3.5, fb1 = -nz * (A / 2);
  g.zone('farbank', [0, 1, (fb0 + fb1) / 2], [A / 2, 3, Math.abs(fb1 - fb0) / 2]);
  const nb0 = nearEdgeZ - nz * 3.5, nb1 = nz * (A / 2);
  g.zone('nearbank', [0, 1, (nb0 + nb1) / 2], [A / 2, 3, Math.abs(nb1 - nb0) / 2]);
  const rx = fx * (A / 2 - 2.5);
  g.zone('rapids', [rx, 0, r2(zc(rx))], [2.5, 3, Wr / 2 + 2], { lost: true });
  const cxz = fx * (A / 2 - 8);
  g.zone('catch', [cxz, 0.5, r2(edge(cxz, nz) + nz * 2.8)], [3, 1, 1.5]);
  // rapids rocks + the catch net (visual)
  for (let i = 0; i < 7; i++) { const x = rx - fx * r.range(0, 4), z = zc(rx) + r.range(-Wr / 2, Wr / 2); g.part({ t: 'drum', p: v3(x, -depthM * 0.6, z), r0: r.range(0.4, 0.9), r1: r.range(0.2, 0.5), h: depthM * 0.6 + r.range(0.2, 0.6), seed: r.int(1, 9999), m: 'rock' }); }
  const cz0 = edge(cxz, nz) + nz * 1.2;
  for (const dx of [-3, 3]) g.part({ t: 'cyl', p: v3(cxz + dx, 0.9, cz0), r: 0.08, hh: 1.1, m: 'wood_dark', seg: 6 });
  g.part({ t: 'rope', a: [r2(cxz - 3), 1.7, r2(cz0)], b: [r2(cxz + 3), 1.7, r2(cz0)], sag: 0.5 }); g.part({ t: 'rope', a: [r2(cxz - 3), 1.1, r2(cz0)], b: [r2(cxz + 3), 1.1, r2(cz0)], sag: 0.3 });
  // stepping stones (micro / small shortcut) on the other side of the ford
  const xs2 = Math.max(-A / 2 + 8, Math.min(A / 2 - 8, xf + (xr > xf ? -1 : 1) * r.range(9, 13)));
  const sn = Math.ceil((Wr + 1) / 2.1);
  for (let i = 0; i <= sn; i++) {
    const z = edge(xs2, nz) + (edge(xs2, -nz) - edge(xs2, nz)) * i / sn, x = xs2 + (i % 2 ? 0.6 : -0.3) + r.range(-0.3, 0.3);
    const bed = g.h(x, z), top = 0.28;
    if (bed > top - 0.05) continue;
    g.cyl(v3(x, (bed + top) / 2, z), r.range(0.5, 0.65), (top - bed) / 2 + 0.05, 'rock', 'rock');
  }
  // depth marker + signs
  const dm: V2 = [xf + 2.4, edge(xf, nz) - nz * 1.2];
  g.part({ t: 'cyl', p: v3(dm[0], -depthM / 2 + 0.5, dm[1]), r: 0.07, hh: depthM / 2 + 1.1, m: 'paper', seg: 6 });
  g.sign(v3(dm[0], 1.6, dm[1]), nz > 0 ? Math.PI : 0, 0.8, 0.35, [`${rv.depth.toFixed(1)} FT`], 'board');
  const sp: V2 = [nearPark[0] + r.pick([-1, 1]) * 4.2, nearPark[1] - nz * 2.5];
  g.part({ t: 'cyl', p: v3(sp[0], g.h(sp[0], sp[1]) + 0.9, sp[1]), r: 0.07, hh: 0.9, m: 'wood_dark', seg: 6 });
  g.sign(v3(sp[0], g.h(sp[0], sp[1]) + 1.75, sp[1]), nz > 0 ? 0 : Math.PI, 1.6, 0.8, g.o.name ? [g.o.name.toUpperCase(), ...themeText(g, 'ford').slice(0, 1)] : themeText(g, 'ford'), th === 'l' ? 'gold' : 'board');
  g.block(sp[0], sp[1], 1);
  // the talker by the wagon
  const tk: V2 = WG.w(r.pick([-1, 1]) * 4.5, -5);
  g.d.npcs.push({ id: 'talker_1', p: v3(tk[0], g.h(tk[0], tk[1]), tk[1]), yaw: r2(WG.yaw + Math.PI), role: 'talker' });
  g.block(tk[0], tk[1], 1.5);
  g.spawnsNear(WG, -5.5);
  // keep scatter out of the water + the crossing corridors
  for (let i = 0; i < xs.length; i++) g.block(xs[i], zs[i], Wr / 2 + 1.2);
  g.blockLine(fpts, 3.5); g.blockLine([[xr, edge(xr, nz) + nz * 4], [xr, edge(xr, -nz) - nz * 4]], 3);
  g.blockLine([[xs2, edge(xs2, nz)], [xs2, edge(xs2, -nz)]], 1.5);
  // banks: reeds along the water, trees + rocks behind
  const reeds = g.kitsOf('reed', 'bush');
  if (reeds.length) for (let i = 0; i < r.int(14, 24); i++) { const x = r.range(-A / 2 + 3, A / 2 - 3), side = r.pick([-1, 1]), z = edge(x, side) + side * r.range(0.3, 2.2); if (g.free(x, z, 0.5, 1)) { const k = r.pick(reeds); g.kit(k, x, z, r.range(0, 6.28), r.range(k.s[0], k.s[1]), false); } }
  g.scatter(['tree', 'tree_s', 'rock', 'junk', 'bush', 'crystal', 'ruin', 'marker'], r.int(20, 30), (x, z) => Math.abs(z - zc(x)) > Wr / 2 + 3, { cluster: 6, spread: 7 });
  g.frame(r.int(24, 34));
  if (th === 'b') { const lily: number[] = g.art.lily ?? []; for (let i = 0; i < r.int(8, 16); i++) { const x = r.range(-A / 2, A / 2), side = r.pick([-1, 1]); lily.push(r2(x), r2(edge(x, side) - side * r.range(0.4, 2)), r2(r.range(0.4, 0.9))); } g.art.lily = lily; }
  for (let i = 0; i < xs.length; i += 2) { g.paint(2, xs[i], zs[i] + Wr / 2 + 0.8, 3.2); g.paint(2, xs[i], zs[i] - Wr / 2 - 0.8, 3.2); }
  if (th === 'l') {
    // the Cloudwash: the banks are island edges over the cloud sea; a broken rainbow bridge hangs over the river
    leafEdge(g);
    const bx = r.range(-A / 3, A / 3);
    g.part({ t: 'ring', p: v3(bx, -2, zc(bx)), yaw: Math.PI / 2 + tilt, R: Wr / 2 + 3, r: 0.55, a0: 0.15, a1: r.range(1.1, 1.7), m: 'gold' });
  }
  const wcx = Math.max(-A / 2 + 6, Math.min(A / 2 - 6, xf - fx * r.range(12, 18)));
  g.cam('CAM_SPECT_WIDE', v3(wcx, r.range(9, 12), Math.max(-A / 2 + 5, Math.min(A / 2 - 5, nearPark[1] + nz * r.range(4, 8)))), v3(xf + fx * 3, 0, zc(xf)), 55);
  g.cam('CAM_SPECT_HERO', v3(xf + fx * r.range(9, 13), 2.4, zc(xf) + nz * (Wr / 2 + 2)), v3(xf, 0.2, zc(xf)), 55);
}
/** A small hut (colliders: 4 walls + roof slab; door on its +Z side). */
function hut(g: G, f: Fr, w: number, d: number, kind = 'hut') {
  const H = 2.4, y = g.h(f.x, f.z);
  const F = new Fr(f.x, f.z, f.yaw, y);
  g.spec.pads.push({ x: f.x, z: f.z, hx: w / 2 + 1, hz: d / 2 + 1, yaw: f.yaw, h: y, fall: 3 });
  g.fbox(F, 0, H / 2, -d / 2, [w / 2, H / 2, 0.1], 'wall', 'wall');
  g.fbox(F, -w / 2, H / 2, 0, [0.1, H / 2, d / 2], 'wall', 'wall'); g.fbox(F, w / 2, H / 2, 0, [0.1, H / 2, d / 2], 'wall', 'wall');
  g.fbox(F, -w / 2 + 0.35, H / 2, d / 2, [0.35, H / 2, 0.1], 'wall', 'wall'); g.fbox(F, w / 2 - 0.35, H / 2, d / 2, [0.35, H / 2, 0.1], 'wall', 'wall');
  g.fbox(F, 0, H - 0.2, d / 2, [w / 2 - 0.7, 0.2, 0.1], 'wall', 'wall');
  g.part({ t: 'gable', p: F.p(0, H, 0), he: [w / 2 + 0.35, 0.95, d / 2 + 0.35], yaw: F.yaw, m: 'roof' });
  g.pbox(F, 0, 0.04, 0, [w / 2, 0.04, d / 2], 'plank');
  if (kind === 'stall') g.part({ t: 'box', p: F.p(0, 2.3, d / 2 + 0.7), he: [w / 2 + 0.2, 0.04, 0.7], q: yawPitch(F.yaw, 0.25), m: g.r.chance(0.5) ? 'cloth' : 'cloth2' });
  g.block(f.x, f.z, Math.max(w, d) / 2 + 1.2);
}

// ================================================================ HUNT
function genHunt(g: G) {
  const { r, th } = g;
  const A = g.A;
  const hot = th === 'b' && g.bi === 2, flats = g.bi === 1;
  g.spec.amp = th === 'l' ? 0.7 : hot ? 3.2 : flats ? 1.0 : 1.8; g.spec.scale = hot ? 20 : 28; g.spec.detail = 0.18;
  if (th !== 'l') g.spec.rim = { at: A / 2 - 4, w: 16, h: r.range(3, 6) };
  const ang = r.int(0, 3) * Math.PI / 2 + r.range(-0.35, 0.35);
  // the wagon at one edge, facing into the grounds
  const wp: V2 = [-Math.sin(ang) * (A / 2 - 11), -Math.cos(ang) * (A / 2 - 11)];
  const WG = new Fr(wp[0], wp[1], ang);
  g.wagonPad(WG);
  g.wagonAt(WG);
  g.spawnsNear(WG, -4.5);
  g.road(curve([WG.w(r.range(-6, 6), -16), WG.w(0, -6), WG.w(0, 2)], 2.5), 3.4, 'path');
  if (th === 'l') { huntIslands(g, WG); return; }
  // ponds (the gator's), mud, cover clusters, logs, tall grass, animals by habitat
  const ponds: { x: number; z: number; r: number }[] = [];
  // (the ponds, and so the gator, sit in the far half: the dangerous kinds are something you go to, not a wagon ambush)
  for (let i = 0, n = r.int(1, 2); i < n; i++) { const p = pond(g, 'pond', undefined, undefined, (x, z) => WG.l(x, z)[1] > A * 0.5); if (p) ponds.push(p); }
  if (g.bi !== 2) for (let i = 0; i < r.int(2, 4); i++) g.paint(0, r.range(-A / 2, A / 2), r.range(-A / 2, A / 2), r.range(3, 7));
  for (let i = 0; i < r.int(4, 7); i++) g.paint(r.pick([3, 4, 3]), r.range(-A / 2, A / 2), r.range(-A / 2, A / 2), r.range(4, 10));
  // tall grass (micro players hide in it)
  const grassN = r.int(7, 11);
  for (let i = 0, tries = 0; i < grassN && tries < 200; tries++) {
    const hx = r.range(2.2, 5), hz = r.range(2.2, 5);
    const x = r.range(-A / 2 + hx + 4, A / 2 - hx - 4), z = r.range(-A / 2 + hz + 4, A / 2 - hz - 4);
    if (!g.free(x, z, Math.min(hx, hz), 3)) continue;
    const y = g.h(x, z);
    g.zone(`grass_${i}`, [x, y + 0.6, z], [hx, 0.9, hz]);
    g.art.grass.push(r2(x), r2(z), r2(hx), r2(hz));
    g.block(x, z, Math.min(hx, hz) * 0.8);
    i++;
  }
  // cover: clusters of trees / rocks / bushes, fallen logs
  g.scatter(hot ? ['tree', 'rock', 'crystal', 'bush'] : flats ? ['rock', 'junk', 'bush', 'tree_s', 'reed'] : ['tree', 'tree_s', 'bush', 'rock', 'reed', 'junk'], r.int(28, 40), () => true, { cluster: r.int(5, 8), spread: 6 });
  for (let i = 0; i < r.int(3, 6); i++) {
    const x = r.range(-A / 2 + 6, A / 2 - 6), z = r.range(-A / 2 + 6, A / 2 - 6), len = r.range(2.4, 4.5), yaw = r.range(0, 3.14);
    if (!g.free(x, z, len / 2, 3)) continue;
    const y = g.h(x, z);
    g.box(v3(x, y + 0.26, z), [0.28, 0.26, len / 2], 'log', '', yawQ(yaw));
    g.part({ t: 'cyl', p: v3(x, y + 0.3, z), r: 0.3, hh: len / 2, q: qmul(yawQ(yaw), [Math.SQRT1_2, 0, 0, Math.SQRT1_2]), m: 'wood', seg: 9 });
    g.block(x, z, len / 2 + 0.5);
  }
  g.frame(r.int(28, 40));
  huntAnimals(g, WG, ponds, []);
  const c = WG.w(0, A * 0.45);
  g.cam('CAM_SPECT_WIDE', WG.p(r.range(-8, 8), r.range(18, 24), -12), v3(c[0], 0, c[1]), 55);
  g.cam('CAM_SPECT_HERO', WG.p(-5, 2, 6), WG.p(0, 1, 30), 50);
}
/** Animal spawn groups by habitat; every deck kind gets at least one spawn (air kinds an air spawn). */
function huntAnimals(g: G, WG: Fr, ponds: { x: number; z: number; r: number }[], isles: Isle[]) {
  const { r } = g;
  const kinds = Object.entries(g.o.animals ?? { deer: { count: 3 } });
  const air = kinds.filter(([k, a]) => !!a.grabs || /wyvern|bird|hawk|heron/.test(k)).map(([k]) => k);
  const water = kinds.filter(([k]) => /gator|duck|goose|frog/.test(k)).map(([k]) => k);
  const ground = kinds.map(([k]) => k).filter((k) => !air.includes(k));
  const fierce = new Set(kinds.filter(([, a]) => (a.danger ?? 0) > 0.5).map(([k]) => k));
  const spots: V2[] = [];
  const pick = (near?: V2, spread = 6): V2 | null => {
    for (let t = 0; t < 60; t++) {
      let x: number, z: number;
      if (near) { const a = r.range(0, 6.28), d = r.range(0, spread); x = near[0] + Math.cos(a) * d; z = near[1] + Math.sin(a) * d; }
      else if (isles.length) { const s = r.chance(0.5) ? isles[0] : r.pick(isles); const a = r.range(0, 6.28), d = r.range(0, 0.7);   // half on the wagon's own island (reachable on foot)
        x = s.x + Math.cos(a) * s.rx * d; z = s.z + Math.sin(a) * s.rz * d; }
      else { x = r.range(-g.A / 2 + 6, g.A / 2 - 6); z = r.range(-g.A / 2 + 6, g.A / 2 - 6); }
      const [, lz] = WG.l(x, z);
      if (lz < 12 || Math.abs(x) > g.A / 2 - 4 || Math.abs(z) > g.A / 2 - 4) continue;       // not on top of the wagon
      if (isles.length && isleEdge(g.spec, x, z).e > 0.8) continue;
      if (ponds.some((p) => Math.hypot(x - p.x, z - p.z) < p.r + 0.5)) continue;
      return [x, z];
    }
    return null;
  };
  const add = (p: V2, ks: string[], radius: number, isAir = false) => { const y = g.h(p[0], p[1]); g.d.animals.push({ p: v3(p[0], isAir ? y + 8 : y + 0.05, p[1]), kinds: ks, radius, ...(isAir ? { air: true } : {}) }); spots.push(p); };
  // pond-side spawns for the water kinds
  for (const pd of ponds) { const [lx, lz] = WG.l(pd.x, pd.z); const a = Math.atan2(lx, lz) + r.range(-0.6, 0.6); const far = WG.w(lx + Math.sin(a) * (pd.r + 1.2), lz + Math.cos(a) * (pd.r + 1.2)); if (water.length) add(far, water, 4); }
  // herds: 3–5 groups of 2–3 nearby spawns with a couple of kinds each
  const herds = r.int(3, 5);
  for (let h = 0; h < herds; h++) {
    const c = pick(); if (!c) continue;
    const tame = ground.filter((k) => !fierce.has(k)), ks = tame.length ? [...new Set([r.pick(tame), r.pick(tame)])] : [];
    for (let i = 0, n = r.int(2, 3); i < n; i++) { const p = pick(c, 7); if (p) add(p, ks, r.range(5, 9)); }
  }
  // every ground / water kind at least once; the rest spread out
  for (const k of [...ground, ...water]) if (!g.d.animals.some((s) => s.kinds.includes(k) && !s.air)) { let p = pick(); for (let t = 0; fierce.has(k) && p && WG.l(p[0], p[1])[1] < g.A * 0.5 && t < 20; t++) p = pick(); if (p) add(p, [k], 7); }
  const tame = ground.filter((k) => !fierce.has(k));
  while (g.d.animals.filter((s) => !s.air).length < 12) { const p = pick(); if (!p) break; add(p, tame.length ? [r.pick(tame)] : ground.length ? [r.pick(ground)] : [], 8); }
  for (const k of air) { const p = pick() ?? [0, 0]; add(p, [k], 10, true); }
}
function huntIslands(g: G, WG: Fr) {
  const { r } = g;
  const A = g.A;
  const main: Isle = { x: WG.w(0, 9)[0], z: WG.w(0, 9)[1], rx: r.range(17, 21), rz: r.range(17, 21), h: 0 };
  const isles: Isle[] = [main];
  const n = r.int(3, 5);
  const bridges: [number, number][] = [];
  for (let i = 0, tries = 0; isles.length < n + 1 && tries < 300; tries++) {
    const from = isles[r.int(0, isles.length - 1)];
    const rr = r.range(9, 15), gap = r.range(2.6, 5.5), jump = r.chance(0.3) ? r.range(1.6, 2.2) : 0;
    const a = r.range(0, 6.28);
    const d = Math.max(from.rx, from.rz) + rr + (jump || gap);
    const s: Isle = { x: from.x + Math.cos(a) * d, z: from.z + Math.sin(a) * d, rx: rr * r.range(0.9, 1.1), rz: rr * r.range(0.9, 1.1), h: r2(r.range(-1.2, 1.4)) };
    if (Math.abs(s.x) + s.rx > A / 2 - 1 || Math.abs(s.z) + s.rz > A / 2 - 1) continue;
    if (isles.some((o) => Math.hypot(o.x - s.x, o.z - s.z) < Math.max(o.rx, o.rz) + Math.max(s.rx, s.rz) + 1.4)) continue;
    const [, lz] = WG.l(s.x, s.z); if (lz < 0) continue;
    isles.push(s);
    if (!jump) bridges.push([isles.indexOf(from), isles.length - 1]);
    else s.h = from.h;          // jump gaps: same height, so the hop is fair
    i++;
  }
  g.spec.isles = isles; g.spec.voidH = -30; g.spec.amp = 0.6; g.spec.base = 0;
  g.art.cloudSea = -16;
  g.zone('kill', [0, -14, 0], [A, 4, A]);
  // bridges: planks from rim to rim, rope rails, abutment pads on both islands
  for (const [ai, bi] of bridges) {
    const a = isles[ai], b = isles[bi];
    const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L;
    const ea: V2 = [a.x + ux * (Math.max(a.rx, a.rz) * 0.86), a.z + uz * (Math.max(a.rx, a.rz) * 0.86)];
    const eb: V2 = [b.x - ux * (Math.max(b.rx, b.rz) * 0.86), b.z - uz * (Math.max(b.rx, b.rz) * 0.86)];
    g.spec.pads.push({ x: ea[0], z: ea[1], r: 2.2, h: a.h, fall: 2.5 }, { x: eb[0], z: eb[1], r: 2.2, h: b.h, fall: 2.5 });
    const len = Math.hypot(eb[0] - ea[0], eb[1] - ea[1]), yaw = Math.atan2(ux, uz), rise = Math.atan2(b.h - a.h, len);
    const mid: V3 = v3((ea[0] + eb[0]) / 2, (a.h + b.h) / 2 - 0.1, (ea[1] + eb[1]) / 2);
    g.box(mid, [1.25, 0.12, Math.hypot(len, b.h - a.h) / 2 + 0.3], 'wood', 'plank', yawPitch(yaw, rise));
    for (const sx of [-1, 1]) {
      const px = -uz * sx * 1.2, pz = ux * sx * 1.2;
      g.part({ t: 'rope', a: [r2(ea[0] + px), a.h + 1.0, r2(ea[1] + pz)], b: [r2(eb[0] + px), b.h + 1.0, r2(eb[1] + pz)], sag: 0.35, m: 'gold' });
      for (const [e, hh] of [[ea, a.h], [eb, b.h]] as const) g.part({ t: 'cyl', p: v3(e[0] + px, hh + 0.55, e[1] + pz), r: 0.07, hh: 0.6, m: 'gold', seg: 6 });
    }
    g.blockLine([ea, eb], 2);
  }
  // island dressing, tall grass on islands, animals
  for (let i = 0, tries = 0; i < r.int(6, 9) && tries < 200; tries++) {
    const s = r.pick(isles), hx = r.range(2, 3.8), hz = r.range(2, 3.8);
    const a = r.range(0, 6.28), d = r.range(0, 0.55);
    const x = s.x + Math.cos(a) * s.rx * d, z = s.z + Math.sin(a) * s.rz * d;
    if (!g.free(x, z, Math.min(hx, hz), 2)) continue;
    const y = g.h(x, z);
    g.zone(`grass_${i}`, [x, y + 0.6, z], [hx, 0.9, hz]); g.art.grass.push(r2(x), r2(z), r2(hx), r2(hz)); g.block(x, z, Math.min(hx, hz) * 0.8); i++;
  }
  g.scatter(['tree', 'tree_s', 'bush', 'ruin', 'crystal', 'marker'], r.int(24, 34), (x, z) => isleEdge(g.spec, x, z).e < 0.8, { cluster: 6, spread: 5 });
  const ponds: { x: number; z: number; r: number }[] = [];
  const big = isles.slice(1).sort((a, b) => b.rx - a.rx)[0];
  if (big && r.chance(0.8)) { const p = pond(g, 'pond', [big.x, big.z], Math.min(4.5, big.rx * 0.35)); if (p) ponds.push(p); }
  g.frame(r.int(20, 30), ['cloud', 'far']);
  huntAnimals(g, WG, ponds, isles);
  const c = WG.w(0, A * 0.45);
  g.cam('CAM_SPECT_WIDE', WG.p(r.range(-10, 10), r.range(20, 26), -14), v3(c[0], -2, c[1]), 55);
  g.cam('CAM_SPECT_HERO', WG.p(-5, 2, 6), WG.p(0, 1, 30), 50);
}

// ================================================================ LANDMARK
type Hero = 'spire' | 'mesa' | 'hoodoo' | 'twin' | 'halo' | 'stairs' | 'colonnade';
function genLandmark(g: G) {
  const { r, th } = g;
  const A = g.A;
  g.spec.amp = th === 'l' ? 0.8 : 1.4; g.spec.scale = 26;
  if (th !== 'l') g.spec.rim = { at: A / 2 - 4, w: 16, h: r.range(3, 6) };
  const ang = r.int(0, 3) * Math.PI / 2 + r.range(-0.3, 0.3);
  const L = new Fr(0, 0, ang);                       // local +Z: from the wagon toward the landmark
  const WG = new Fr(...L.w(r.range(-4, 4), -A / 2 + 10), ang + r.range(-0.2, 0.2));
  g.wagonPad(WG); g.wagonAt(WG); g.spawnsNear(WG, -4.5);
  const hc = L.w(r.range(-6, 6), r.range(9, 15));
  const heroes: Hero[] = th === 'l' ? ['halo', 'stairs', 'colonnade', 'twin'] : ['spire', 'mesa', 'hoodoo', 'twin'];
  const kind = heroes[new Rng(`${g.o.seed}:${g.o.node}:hero`).int(0, heroes.length - 1)];
  const H = new Fr(hc[0], hc[1], ang + r.range(-3.14, 3.14));
  const top = hero(g, kind, H);
  g.d.paths.climb = [...g.climb, v3(top.p[0], top.p[1] + 0.05, top.p[2])];
  // the summit zone + the signing wall
  g.zone('summit', [top.p[0], top.p[1] + 1.2, top.p[2]], [top.r, 1.3, top.r]);
  g.sign(v3(top.p[0], top.p[1] + 1.1, top.p[2]), r2(top.yaw), 1.8, 0.9, themeText(g, 'sign'), 'wall');
  g.part({ t: 'box', p: v3(top.p[0], top.p[1] + 0.6, top.p[2]), he: [1.0, 0.6, 0.08], q: yawQ(top.yaw), m: 'wood_dark' });
  g.light(v3(top.p[0], top.p[1] + 2.4, top.p[2]), th === 'l' ? '#fff0b0' : '#ffd070', 10, 1.2, true);
  // photo spot between the settlement and the landmark (the landmark behind the party); the camera faces it
  const ph = L.w(r.range(-4, 4), r.range(-6, -1));
  const phy = g.h(ph[0], ph[1]);
  g.spec.pads.push({ x: ph[0], z: ph[1], r: 4.5, h: phy, fall: 3 });
  g.zone('photo', [ph[0], phy + 1, ph[1]], [3.6, 1.5, 2.8]);
  const toHero = Math.atan2(hc[0] - ph[0], hc[1] - ph[1]);
  const camAt: V2 = [ph[0] - Math.sin(toHero) * 7, ph[1] - Math.cos(toHero) * 7];
  g.cam('CAM_SPECT_photo', [camAt[0], phy + 2.2, camAt[1]], [ph[0] + Math.sin(toHero) * 3, phy + 2.6, ph[1] + Math.cos(toHero) * 3], 45);
  g.sign(v3(ph[0] + Math.cos(toHero) * 3.9, phy + 1.6, ph[1] - Math.sin(toHero) * 3.9), r2(toHero + Math.PI), 1.3, 0.8, themeText(g, 'photo'), th === 'l' ? 'gold' : 'board');
  g.part({ t: 'cyl', p: v3(ph[0] + Math.cos(toHero) * 3.9, phy + 0.6, ph[1] - Math.sin(toHero) * 3.9), r: 0.06, hh: 0.62, m: 'wood_dark', seg: 6 });
  g.block(ph[0], ph[1], 4.5);
  g.paint(4, ph[0], ph[1], 4);
  // the settlement: 2–4 huts / stalls around a little plaza, 3 talkers, a notice board, lanterns
  const sc = L.w(r.pick([-1, 1]) * r.range(8, 13), r.range(-14, -6));
  g.spec.pads.push({ x: sc[0], z: sc[1], r: 9, h: 0, fall: 5 });
  const nh = r.int(2, 4);
  for (let i = 0; i < nh; i++) {
    const a = ang + Math.PI + (i - (nh - 1) / 2) * 0.9 + r.range(-0.15, 0.15), d = r.range(5.5, 7.5);
    const hp: V2 = [sc[0] + Math.sin(a) * d, sc[1] + Math.cos(a) * d];
    if (!g.free(hp[0], hp[1], 2.4, 3)) continue;
    hut(g, new Fr(hp[0], hp[1], a + Math.PI), r.range(2.6, 3.4), r.range(2.2, 2.8), r.chance(0.5) ? 'stall' : 'hut');
  }
  for (let i = 1; i <= 3; i++) {
    const a = ang + (i - 2) * 1.1 + r.range(-0.2, 0.2), d = r.range(2.2, 3.6);
    const p: V2 = [sc[0] + Math.sin(a) * d, sc[1] + Math.cos(a) * d];
    g.d.npcs.push({ id: `talker_${i}`, p: v3(p[0], g.h(p[0], p[1]), p[1]), yaw: r2(a + Math.PI), role: 'talker' });
    g.block(p[0], p[1], 1.2);
  }
  const nb: V2 = [sc[0] + Math.sin(ang) * 1.5, sc[1] + Math.cos(ang) * 1.5];
  g.box(v3(nb[0], 1.0, nb[1]), [0.9, 0.7, 0.08], 'wood', 'wood_dark', yawQ(ang + Math.PI));
  g.sign(v3(nb[0] - Math.sin(ang) * 0.1, 1.1, nb[1] - Math.cos(ang) * 0.1), r2(ang + Math.PI), 1.6, 1.1, [(g.o.name ?? 'LANDMARK').toUpperCase(), 'rumours inside'], 'paper');
  lanternPost(g, sc[0] + r.range(-2, 2), sc[1] + r.range(-2, 2));
  g.block(sc[0], sc[1], 3);
  // roads: wagon → settlement → photo spot → the landmark's foot
  roadThrough(g, [WG.w(0, -16), WG.w(0, 1), sc, ph, [top.base[0], top.base[1]]], 3.4);
  g.scatter(['tree', 'tree_s', 'bush', 'rock', 'reed', 'junk', 'ruin', 'crystal', 'marker'], r.int(18, 28), () => true, { cluster: 5, spread: 6 });
  g.frame(r.int(24, 34));
  for (let i = 0; i < 4; i++) g.paint(r.pick([3, 4, 3]), r.range(-A / 2, A / 2), r.range(-A / 2, A / 2), r.range(4, 9));
  g.cam('CAM_SPECT_WIDE', WG.p(r.pick([-1, 1]) * r.range(12, 18), r.range(12, 16), -8), v3(hc[0], top.p[1] * 0.45, hc[1]), 55);
  g.cam('CAM_SPECT_HERO', v3(camAt[0], phy + 2.4, camAt[1]), v3(ph[0], phy + 1.3, ph[1]), 45);
  if (th === 'l') leafEdge(g);
}
/** A helical ramp (tilted boxes that overlap into one walkable path, a hop gap now and then). Returns the end. */
function helix(g: G, c: V2, R0: number, a0: number, y0: number, y1: number, dir: number, o: { w?: number; m?: string; slope?: number; gaps?: boolean; rail?: boolean; floating?: boolean; R1?: number } = {}) {
  const w = o.w ?? 1.5, slope = o.slope ?? 0.36, segL = 2.3, R1 = o.R1 ?? R0;
  const rise = y1 - y0, arcLen = rise / Math.tan(slope), n = Math.max(3, Math.ceil(arcLen / segL));
  const dA = (arcLen / ((R0 + R1) / 2)) / n * dir, dy = rise / n;
  let gapLeft = g.r.int(4, 7);
  const Rat = (t: number) => R0 + (R1 - R0) * t;
  let R = R0;
  for (let i = 0; i < n; i++) {
    const am = a0 + dA * (i + 0.5), ym = y0 + dy * (i + 0.5);
    R = Rat((i + 0.5) / n);
    const p = v3(c[0] + Math.sin(am) * R, ym, c[1] + Math.cos(am) * R);
    const yaw = am + dir * Math.PI / 2;                                  // tangent
    const chord = Math.abs(dA) * R;
    g.climb.push(v3(p[0], ym + (o.floating ? 0.16 : 0.14), p[2]));
    gapLeft--;
    const gap = o.gaps && gapLeft <= 0 && i > 1 && i < n - 2;
    if (gap) gapLeft = g.r.int(5, 8);
    const len = gap ? chord * 0.62 : chord + 0.35;
    // (floating = marble slabs with no support underneath; still one walkable slope, a hop gap now and then)
    g.box(p, [w / 2, o.floating ? 0.16 : 0.14, len / 2], 'rock', o.m ?? (o.floating ? 'marble' : 'rock'), yawPitch(yaw, Math.atan2(dy, chord)));
    if (o.rail && !gap && i % 2 === 0) {
      const ox = Math.sin(am) * (w / 2 - 0.08), oz = Math.cos(am) * (w / 2 - 0.08);
      g.part({ t: 'cyl', p: v3(p[0] + ox, ym + 0.55, p[2] + oz), r: 0.05, hh: 0.55, m: 'wood_dark', seg: 5 });
      const an = a0 + dA * (i + 2.5), yn = y0 + dy * (i + 2.5);
      if (i + 2 < n) g.part({ t: 'rope', a: [r2(p[0] + ox), r2(ym + 1.05), r2(p[2] + oz)], b: [r2(c[0] + Math.sin(an) * (R + w / 2 - 0.08)), r2(yn + 1.05), r2(c[1] + Math.cos(an) * (R + w / 2 - 0.08))], sag: 0.12 });
    }
  }
  const ae = a0 + dA * n;
  return { a: ae, p: v3(c[0] + Math.sin(ae) * R1, y1, c[1] + Math.cos(ae) * R1) };
}
function hero(g: G, kind: Hero, H: Fr): { p: V3; r: number; yaw: number; base: V2 } {
  const { r, th } = g;
  const c: V2 = [H.x, H.z];
  const gy = g.h(c[0], c[1]);
  const rockM = th === 'l' ? 'marble' : 'rock';
  g.spec.pads.push({ x: c[0], z: c[1], r: 10, h: gy, fall: 5 });
  const baseY = gy;
  const dir = r.pick([-1, 1]), a0 = r.range(0, 6.28);
  const start: V2 = [c[0] + Math.sin(a0) * 6, c[1] + Math.cos(a0) * 6];
  if (kind === 'spire' || kind === 'colonnade') {
    const Ht = r.range(13, 20), R0 = r.range(3.2, 4.2), taper = r.range(0.55, 0.75), lean = 0;
    const n = r.int(4, 6);
    for (let i = 0; i < n; i++) {
      const y0 = baseY + Ht * i / n, y1 = baseY + Ht * (i + 1) / n, ra = R0 * (1 - (1 - taper) * i / n), rb = R0 * (1 - (1 - taper) * (i + 1) / n);
      const off = lean * (y0 - baseY);
      const cc: V3 = v3(c[0] + off, (y0 + y1) / 2, c[1]);
      g.cyl(cc, (ra + rb) / 2, (y1 - y0) / 2, 'spire', '');
      if (kind === 'colonnade') { g.part({ t: 'cyl', p: cc, r: ra * 0.92, r2: rb * 0.92, hh: (y1 - y0) / 2 - 0.2, m: 'marble', seg: 14 }); g.part({ t: 'cyl', p: v3(cc[0], y1 - 0.12, cc[2]), r: rb * 1.08, hh: 0.14, m: 'gold', seg: 18 }); }
      else g.part({ t: 'drum', p: v3(cc[0], y0, cc[2]), r0: ra, r1: rb, h: y1 - y0, seed: r.int(1, 99999), m: 'rock' });
    }
    const Rt = R0 * taper;
    helix(g, c, R0 + 0.95, a0, baseY + 0.1, baseY + Ht + 0.2, dir, { R1: Rt + 0.95, w: 1.6, m: kind === 'colonnade' ? 'marble' : th === 'b' ? 'plank' : 'rock', gaps: true, rail: th !== 'l', floating: kind === 'colonnade' });
    const topP = v3(c[0] + lean * Ht, baseY + Ht + 0.15, c[1]);
    g.cyl(topP, Rt + 0.9, 0.15, 'rock', kind === 'colonnade' ? 'gold' : th === 'b' ? 'plank' : 'rock');
    if (th === 'b') { g.part({ t: 'cyl', p: v3(topP[0], topP[1] + 1.4, topP[2]), r: 0.9, r2: 1.1, hh: 1.2, m: 'rock', seg: 10 }); g.part({ t: 'ball', p: v3(topP[0], topP[1] + 3.6, topP[2]), s: [1.6, 0.9, 1.6], m: 'cloud' }); }
    if (kind === 'colonnade') for (let i = 0; i < 6; i++) { const a = i / 6 * 6.283; g.part({ t: 'cyl', p: v3(topP[0] + Math.sin(a) * (Rt + 0.6), topP[1] + 0.9, topP[2] + Math.cos(a) * (Rt + 0.6)), r: 0.18, hh: 0.75, m: 'marble', seg: 8 }); }
    return { p: topP, r: Rt + 0.7, yaw: a0, base: start };
  }
  if (kind === 'mesa') {
    const Ht = r.range(8, 11), R = r.range(6.5, 8.5);
    g.cyl(v3(c[0], baseY + Ht / 2, c[1]), R, Ht / 2, 'spire', '');
    const n = 3;
    for (let i = 0; i < n; i++) g.part({ t: 'drum', p: v3(c[0], baseY + Ht * i / n, c[1]), r0: R * (1.04 - i * 0.02), r1: R * (1.02 - i * 0.02), h: Ht / n, seed: r.int(1, 99999), m: 'rock' });
    helix(g, c, R + 1.0, a0, baseY + 0.1, baseY + Ht + 0.05, dir, { w: 1.8, m: th === 'b' ? 'plank' : 'rock', gaps: false, rail: true, slope: 0.4 });
    const topP = v3(c[0], baseY + Ht, c[1]);
    // plateau dressing: a cairn + a few kit pieces
    g.part({ t: 'drum', p: v3(c[0] + 1.5, topP[1], c[1] - 1), r0: 0.9, r1: 0.2, h: 1.8, seed: r.int(1, 999), m: 'stone' });
    const pool = g.kitsOf('bush', 'tree_s', 'crystal');
    for (let i = 0; i < 3 && pool.length; i++) { const a = r.range(0, 6.28), d = r.range(2.5, R - 1.2); const k = r.pick(pool); g.kit(k, c[0] + Math.sin(a) * d, c[1] + Math.cos(a) * d, r.range(0, 6.28), r.range(0.7, 1.1), false, topP[1]); }
    return { p: topP, r: Math.min(R - 0.5, 4.5), yaw: a0, base: start };
  }
  if (kind === 'hoodoo') {
    const Ht = r.range(10, 13), Rs = r.range(2.0, 2.6), Rc = r.range(4.4, 5.6);
    g.cyl(v3(c[0], baseY + (Ht - 1.2) / 2, c[1]), Rs, (Ht - 1.2) / 2, 'spire', '');
    g.part({ t: 'drum', p: v3(c[0], baseY, c[1]), r0: Rs * 1.5, r1: Rs, h: Ht * 0.35, seed: r.int(1, 99999), m: 'rock' });
    g.part({ t: 'drum', p: v3(c[0], baseY + Ht * 0.35, c[1]), r0: Rs, r1: Rs * 0.9, h: Ht * 0.65 - 1.2, seed: r.int(1, 99999), m: 'rock' });
    g.cyl(v3(c[0], baseY + Ht - 0.6, c[1]), Rc, 0.6, 'spire', '');
    g.part({ t: 'drum', p: v3(c[0], baseY + Ht - 1.25, c[1]), r0: Rc * 0.8, r1: Rc, h: 1.3, seed: r.int(1, 99999), m: 'moss' });
    // a scaffold boardwalk spiralling around the stem, out past the cap's rim, onto the cap
    const Rr = Rc + 0.9;
    const e = helix(g, c, Rr, a0, baseY + 0.1, baseY + Ht + 0.05, dir, { w: 1.5, m: 'plank', gaps: true, rail: true, slope: 0.33 });
    // struts under the boardwalk (visual)
    for (let i = 0; i < 10; i++) { const a = a0 + dir * i * 0.7; const y = baseY + (Ht * i) / 12; g.part({ t: 'cyl', p: v3(c[0] + Math.sin(a) * Rr, y / 2 + baseY / 2, c[1] + Math.cos(a) * Rr), r: 0.09, hh: Math.max(0.2, (y - baseY) / 2), m: 'wood_dark', seg: 5 }); }
    const bridge: V3 = v3((e.p[0] + c[0]) / 2 + (e.p[0] - c[0]) * 0.25, baseY + Ht + 0.02, (e.p[2] + c[1]) / 2 + (e.p[2] - c[1]) * 0.25);
    g.box(bridge, [0.8, 0.1, 1.2], 'wood', 'plank', yawQ(Math.atan2(e.p[0] - c[0], e.p[2] - c[1])));
    g.climb.push(v3(bridge[0], bridge[1] + 0.1, bridge[2]));
    return { p: v3(c[0], baseY + Ht, c[1]), r: Rc - 0.6, yaw: a0, base: start };
  }
  if (kind === 'twin') {
    const ha = r.range(9, 12), hb2 = ha + r.range(0.5, 2.5), Ra = r.range(2.6, 3.3), Rb = r.range(2.4, 3.1);
    const gap = r.range(4, 6.5), ay = r.range(0, 6.28);
    const ca: V2 = [c[0] - Math.sin(ay) * (Ra + gap / 2), c[1] - Math.cos(ay) * (Ra + gap / 2)], cb: V2 = [c[0] + Math.sin(ay) * (Rb + gap / 2), c[1] + Math.cos(ay) * (Rb + gap / 2)];
    const tower = (cc: V2, R: number, Ht: number) => {
      g.cyl(v3(cc[0], baseY + Ht / 2, cc[1]), R, Ht / 2, 'spire', '');
      for (let i = 0; i < 3; i++) {
        if (th === 'l') g.part({ t: 'cyl', p: v3(cc[0], baseY + Ht * (i + 0.5) / 3, cc[1]), r: R * (1 - i * 0.05), r2: R * (0.95 - i * 0.05), hh: Ht / 6 - 0.1, m: 'marble', seg: 14 });
        else g.part({ t: 'drum', p: v3(cc[0], baseY + Ht * i / 3, cc[1]), r0: R * (1.1 - i * 0.06), r1: R * (1.04 - i * 0.06), h: Ht / 3, seed: r.int(1, 99999), m: rockM });
      }
      g.cyl(v3(cc[0], baseY + Ht + 0.12, cc[1]), R + 0.5, 0.12, 'rock', th === 'l' ? 'gold' : 'plank');
    };
    tower(ca, Ra, ha); tower(cb, Rb, hb2);
    helix(g, ca, Ra + 0.95, ay + Math.PI, baseY + 0.1, baseY + ha, dir, { w: 1.5, m: th === 'b' ? 'plank' : rockM, gaps: true, rail: th !== 'l', floating: th === 'l' });
    // the bridge between the summits (it climbs a little): the last bit of the race
    const a3: V3 = v3(ca[0] + Math.sin(ay) * Ra, baseY + ha + 0.24, ca[1] + Math.cos(ay) * Ra), b3: V3 = v3(cb[0] - Math.sin(ay) * Rb, baseY + hb2 + 0.24, cb[1] - Math.cos(ay) * Rb);
    const len = Math.hypot(b3[0] - a3[0], b3[2] - a3[2]) + 1.2;
    g.box(v3((a3[0] + b3[0]) / 2, (a3[1] + b3[1]) / 2 - 0.1, (a3[2] + b3[2]) / 2), [0.8, 0.1, len / 2], 'wood', th === 'l' ? 'gold' : 'plank', yawPitch(ay, Math.atan2(b3[1] - a3[1], len)));
    g.climb.push(v3(ca[0], baseY + ha + 0.25, ca[1]), a3, b3);
    for (const sx of [-1, 1]) g.part({ t: 'rope', a: [r2(a3[0] - Math.cos(ay) * sx * 0.8), r2(a3[1] + 1), r2(a3[2] + Math.sin(ay) * sx * 0.8)], b: [r2(b3[0] - Math.cos(ay) * sx * 0.8), r2(b3[1] + 1), r2(b3[2] + Math.sin(ay) * sx * 0.8)], sag: 0.4, m: th === 'l' ? 'gold' : undefined });
    return { p: v3(cb[0], baseY + hb2 + 0.24, cb[1]), r: Rb + 0.3, yaw: ay + Math.PI, base: [ca[0] + Math.sin(ay + Math.PI) * 6, ca[1] + Math.cos(ay + Math.PI) * 6] };
  }
  // Skyisles: the halo (a broken ring standing over a shrine) / floating stairs around a crystal
  const Ht = r.range(12, 17);
  if (kind === 'halo') {
    const R = Ht / 2, yaw = r.range(0, 3.14), cy = baseY + 2.5 + R;
    // the ring (a = 0 at the crown, toward u = (cos yaw, −sin yaw) for a > 0): box segments with two gaps (it's
    // broken), never at the crown (the summit sits there) nor at the very bottom
    const segs = 22, broken = [r.int(3, 8), r.int(13, 18)];
    let run0 = -1;
    for (let i = 0; i <= segs; i++) {
      const on = i < segs && !broken.includes(i);
      if (on && run0 < 0) run0 = i;
      if (!on && run0 >= 0) { g.part({ t: 'ring', p: v3(c[0], cy, c[1]), yaw, R, r: 0.6, a0: run0 / segs * 6.283, a1: i / segs * 6.283, m: 'gold' }); run0 = -1; }
      if (!on) continue;
      const a = (i + 0.5) / segs * 6.283;
      const lx = Math.sin(a) * R, ly = Math.cos(a) * R;
      const p = v3(c[0] + Math.cos(yaw) * lx, cy + ly, c[1] - Math.sin(yaw) * lx);
      g.box(p, [0.55, 0.3, R * 3.2 / segs], 'arch', '', yawPitch(yaw + Math.PI / 2, -a));
    }
    // floating fragments spiral up around the ring to its top; the summit is a platform on the crown
    // the spiral ends on the ring's own plane, so the last span runs straight along the ring onto its crown
    const Rh = R + 2.4, y1 = cy + R + 0.25, ae = Math.atan2(Math.cos(yaw), -Math.sin(yaw)) + (r.chance(0.5) ? Math.PI : 0);
    const e = helix(g, c, Rh, ae - dir * ((y1 - baseY - 0.1) / Math.tan(0.3)) / Rh, baseY + 0.1, y1, dir, { w: 1.7, m: 'marble', floating: true, slope: 0.3, gaps: true });
    const topP = v3(c[0], cy + R + 0.62, c[1]);                      // clear of the crown segments below
    g.box(topP, [1.8, 0.16, 1.4], 'rock', 'marble', yawQ(yaw));
    const lk: V3 = v3((e.p[0] + topP[0]) / 2, (e.p[1] + topP[1]) / 2, (e.p[2] + topP[2]) / 2);
    g.box(lk, [0.8, 0.12, Math.hypot(e.p[0] - topP[0], e.p[2] - topP[2]) / 2 + 0.4], 'rock', 'marble', yawPitch(Math.atan2(topP[0] - e.p[0], topP[2] - e.p[2]), Math.atan2(topP[1] - e.p[1], Math.hypot(e.p[0] - topP[0], e.p[2] - topP[2]))));
    g.box(v3(e.p[0], e.p[1] - 0.1, e.p[2]), [1.5, 0.16, 1.5], 'rock', 'marble', yawQ(yaw));          // a landing where the spiral meets the span
    g.climb.push(v3(e.p[0], e.p[1] + 0.08, e.p[2]), v3(lk[0], lk[1] + 0.12, lk[2]));
    // the shrine under the halo
    g.cyl(v3(c[0], baseY + 0.25, c[1]), 3.2, 0.25, 'rock', 'marble');
    g.part({ t: 'cyl', p: v3(c[0], baseY + 1.2, c[1]), r: 0.35, r2: 0.2, hh: 0.8, m: 'crystal', seg: 6 });
    g.light(v3(c[0], baseY + 2.2, c[1]), '#bfe6ff', 12, 1.4, true);
    return { p: topP, r: 1.8, yaw, base: start };
  }
  // stairs: floating slabs spiral around a crystal pillar
  const Rp = r.range(1.6, 2.4);
  g.cyl(v3(c[0], baseY + Ht / 2, c[1]), Rp, Ht / 2, 'spire', '');
  g.part({ t: 'cyl', p: v3(c[0], baseY + Ht / 2, c[1]), r: Rp, r2: Rp * 0.7, hh: Ht / 2, m: 'crystal', seg: 6 });
  g.light(v3(c[0], baseY + Ht * 0.6, c[1]), '#9fd8ff', 14, 1.3, true);
  helix(g, c, Rp + 2.2, a0, baseY + 0.1, baseY + Ht, dir, { w: 1.8, m: 'marble', floating: true, slope: 0.3, gaps: true });
  const topP = v3(c[0], baseY + Ht + 0.2, c[1]);
  g.cyl(topP, Rp + 1.6, 0.2, 'rock', 'marble');
  g.part({ t: 'ring', p: v3(c[0], topP[1] + 2.4, c[1]), yaw: r.range(0, 3), R: 1.4, r: 0.12, a0: 0, a1: 6.283, m: 'gold' });
  return { p: topP, r: Rp + 1.2, yaw: a0, base: start };
}

// ================================================================ FINISH (the destination)
function genFinish(g: G) {
  const { r, th } = g;
  const A = g.A;
  g.spec.amp = 0.9; g.spec.scale = 24;
  const ang = r.int(0, 3) * Math.PI / 2 + r.range(-0.25, 0.25);
  const L = new Fr(0, 0, ang);
  if (th !== 'l') g.spec.rim = { at: A / 2 - 4, w: 14, h: r.range(2, 4) };
  const WG = new Fr(...L.w(r.range(-5, 5), -A / 2 + 10), ang + r.range(-0.15, 0.15));
  g.wagonPad(WG, 0.2); g.wagonAt(WG); g.spawnsNear(WG, -4.5);
  // the arch + finish line
  const ac = L.w(r.range(-4, 4), r.range(0, 6));
  const F = new Fr(ac[0], ac[1], ang + r.range(-0.2, 0.2));
  g.spec.pads.push({ x: ac[0], z: ac[1], r: 8, h: 0.2, fall: 5 });
  const aw = r.range(4.2, 5.2), ah = r.range(5.5, 7);
  for (const sx of [-1, 1]) { g.fbox(F, sx * aw, ah / 2, 0, [0.45, ah / 2, 0.45], 'arch', th === 'l' ? 'marble' : 'wood'); g.part({ t: 'ball', p: F.p(sx * aw, ah + 0.4, 0), s: [0.6, 0.6, 0.6], m: th === 'l' ? 'gold' : th === 'b' ? 'neon' : 'wood_dark' }); }
  g.fbox(F, 0, ah + 0.35, 0, [aw + 0.5, 0.35, 0.45], 'arch', th === 'l' ? 'gold' : th === 'b' ? 'trim' : 'wood');
  g.sign(F.p(0, ah + 0.35, 0.5), F.yaw, aw * 1.8, 0.62, themeText(g, 'finish'), th === 'b' ? 'neon' : th === 'l' ? 'gold' : 'board');
  if (th === 'l') g.part({ t: 'ring', p: F.p(0, ah * 0.55, -0.2), yaw: F.yaw + Math.PI / 2, R: aw * 0.95, r: 0.22, a0: -1.5708, a1: 1.5708, m: 'gold' });
  const fz = F.w(0, 1.2);
  g.zone('finish', [fz[0], 1.5, fz[1]], [Math.abs(Math.cos(F.yaw)) * aw + Math.abs(Math.sin(F.yaw)) * 1 + 0.2, 1.5, Math.abs(Math.sin(F.yaw)) * aw + Math.abs(Math.cos(F.yaw)) * 1 + 0.2]);
  for (let i = 0; i < 2; i++) g.light(F.p((i ? 1 : -1) * aw, ah + 0.4, 0.6), th === 'b' ? '#ff5ad8' : '#ffe8a0', 10, 1.2, true);
  g.part({ t: 'rope', a: F.p(-aw, ah - 0.4, 0.2), b: F.p(aw, ah - 0.4, 0.2), sag: 0.8, m: 'cloth' });
  g.block(ac[0], ac[1], aw + 1.5);
  // the water (bay / sanctuary pools) beyond the arch
  if (th !== 'l') {
    const bz = A / 2 - r.range(9, 13);
    const xs: number[] = [], zs: number[] = [];
    for (let x = -A / 2 - 14; x <= A / 2 + 14.01; x += 4) { const [wx, wz] = L.w(x, bz + Math.sin(x * 0.08 + r.range(0, 0)) * 2); xs.push(r2(wx)); zs.push(r2(wz)); }
    g.spec.chans.push({ xs, zs, half: 9, bank: 5, bed: -1.2 });
    const [cx, cz] = L.w(0, bz + 1);
    const ca = Math.abs(Math.cos(ang)), sa = Math.abs(Math.sin(ang)), hl = A / 2 + 15, hw = 11;   // (long: the bay runs on past the walls)
    g.d.water.push({ name: 'bay', p: [r2(cx), -0.6, r2(cz)], he: [r2(ca * hl + sa * hw), 0.62, r2(sa * hl + ca * hw)], level: -0.05, depth: 1.2, flow: [0, 0], murk: 0.4, color: th === 'b' ? '#3d7a6a' : g.pal.water });
    g.spec.floor = 0.25;
    for (let i = 0; i < xs.length; i++) g.block(xs[i], zs[i], 10);
    // a boardwalk pier into the bay
    const px = r.range(-A / 3, A / 3);
    const P = new Fr(...L.w(px, bz - 9), ang, 0.45);
    const plen = r.range(8, 12);
    g.fbox(P, 0, 0, plen / 2, [1.3, 0.08, plen / 2 + 0.5], 'dock', 'plank');
    for (let i = 0; i <= 4; i++) for (const sx of [-1, 1]) g.part({ t: 'cyl', p: P.p(sx * 1.25, -0.8, i * plen / 4), r: 0.1, hh: 0.9, m: 'wood_dark', seg: 6 });
    g.spec.pads.push({ x: P.x, z: P.z, r: 2.5, h: 0.4, fall: 3 });
    lanternPost(g, ...P.w(1.6, plen));
    g.blockRect(P, 0, plen / 2, 2, plen / 2 + 1);
    if (th === 'b') { const lily: number[] = []; for (let i = 0; i < r.int(10, 18); i++) { const [x, z] = L.w(r.range(-A / 2, A / 2), bz + r.range(-5, 5)); lily.push(r2(x), r2(z), r2(r.range(0.4, 1))); } g.art.lily = lily; }
  } else {
    // the Sanctuary: an altar dais on the crown of the island, two pools either side
    const D = new Fr(...L.w(r.range(-4, 4), r.range(15, 19)), ang + Math.PI);
    g.spec.pads.push({ x: D.x, z: D.z, r: 7, h: 0, fall: 4 });
    g.cyl(v3(D.x, 0.3, D.z), 4.4, 0.3, 'rock', 'marble'); g.cyl(v3(D.x, 0.75, D.z), 3.0, 0.15, 'rock', 'marble');
    g.fbox(D, 0, 1.35, 0, [1.1, 0.45, 0.6], 'rock', 'marble'); g.pbox(D, 0, 1.84, 0, [1.2, 0.05, 0.7], 'gold');
    g.part({ t: 'box', p: D.p(0, 2.9, 0), he: [0.05, 1.05, 0.05], m: 'crystal' }); g.part({ t: 'box', p: D.p(0, 2.3, 0), he: [0.35, 0.05, 0.06], m: 'gold' });
    g.light(D.p(0, 3.2, 0), '#fff0c0', 12, 1.6, true);
    for (const sx of [-1, 1]) {
      const [x, z] = D.w(sx * r.range(8, 10), r.range(-2, 2));
      pond(g, `pool_${sx > 0 ? 'R' : 'L'}`, [x, z], r.range(3, 4.2));
    }
    g.block(D.x, D.z, 5);
    for (let i = 0; i < 8; i++) { const a = i / 8 * 6.283 + 0.2; const [x, z] = [D.x + Math.sin(a) * 6.5, D.z + Math.cos(a) * 6.5]; if (g.free(x, z, 0.4, 1)) { g.cyl(v3(x, g.h(x, z) + 1.4, z), 0.3, 1.4, 'rock', 'marble'); g.part({ t: 'box', p: v3(x, g.h(x, z) + 2.85, z), he: [0.42, 0.08, 0.42], m: 'gold' }); } }
  }
  // the giant statue: the theme's hero piece, scaled up, on a plinth
  const st = L.w(r.pick([-1, 1]) * r.range(10, 15), r.range(4, 12));
  if (g.free(st[0], st[1], 3, 3)) {
    g.spec.pads.push({ x: st[0], z: st[1], r: 3.5, h: g.h(st[0], st[1]), fall: 3 });
    const sy = g.h(st[0], st[1]);
    g.cyl(v3(st[0], sy + 0.6, st[1]), 2.1, 0.6, 'rock', th === 'l' ? 'marble' : 'stone');
    const k = g.kits.find((x) => x.id === (th === 'b' ? 'frog_statue' : th === 'l' ? 'angel_statue' : 'rock'));
    if (k) g.kit(k, st[0], st[1], Math.atan2(ac[0] - st[0], ac[1] - st[1]), th === 'f' ? 2.2 : 2.6, false, r2(sy + 1.2));
    g.block(st[0], st[1], 3.5);
  }
  // the town: a few huts / stalls along the road, bunting, lanterns
  for (let i = 0, n = r.int(3, 5); i < n; i++) {
    const side = i % 2 ? 1 : -1, lz = -A / 2 + 18 + i * 5 + r.range(-1, 1);
    const [x, z] = L.w(side * r.range(8, 13), lz);
    if (!g.free(x, z, 2.5, 3)) continue;
    hut(g, new Fr(x, z, ang + (side > 0 ? -Math.PI / 2 : Math.PI / 2) + r.range(-0.2, 0.2)), r.range(2.6, 3.4), r.range(2.2, 2.8), r.chance(0.5) ? 'stall' : 'hut');
  }
  roadThrough(g, [WG.w(0, -16), WG.w(0, 1), L.w(r.range(-3, 3), -4), ac, L.w(r.range(-3, 3), 12)], 4);
  for (let i = 0; i < 3; i++) { const [x, z] = L.w(r.pick([-1, 1]) * r.range(4, 7), -A / 2 + 16 + i * 7); if (g.free(x, z, 0.5, 2)) lanternPost(g, x, z); }
  g.scatter(['tree', 'tree_s', 'bush', 'reed', 'rock', 'junk', 'ruin', 'crystal', 'marker'], r.int(16, 24), () => true, { cluster: 5, spread: 6 });
  g.frame(r.int(24, 32));
  g.cam('CAM_SPECT_WIDE', F.p(r.range(-4, 4), r.range(5, 7), r.range(16, 22)), F.p(0, 1.5, -2), 55);
  g.cam('CAM_SPECT_HERO', F.p(r.range(-2, 2), 2, 9), F.p(0, 1.8, 0), 50);
  if (th === 'l') leafEdge(g);
}

// ================================================================ entry
const SIZES: Record<GenKind, number> = { store: 56, river: 64, hunt: 90, landmark: 70, finish: 58 };
/** Generate a stop. Deterministic for (seed, node, kind, theme, biome, river, animals). */
export function genStop(kind: GenKind, o: StopGenOpts): LevelDesc {
  const A = SIZES[kind] + (kind === 'hunt' && o.theme === 'skyisles' ? 8 : 0);
  const g = new G(kind, o, A, A + 28);
  switch (kind) {
    case 'store': genStore(g); break;
    case 'river': genRiver(g); break;
    case 'hunt': genHunt(g); break;
    case 'landmark': genLandmark(g); break;
    case 'finish': genFinish(g); break;
  }
  g.walls(kind === 'river' ? -4 : -40, 12);
  g.settle();          // every spawn / NPC / animal / kit piece stands on the final ground
  return g.d;
}
/** The deck biome (index + id) for a point of the run (fraction of the route's miles). */
export function biomeFor(biomes: { id: string; from: number }[] | undefined, frac: number): { id: string; idx: number } {
  const list = biomes?.length ? biomes : [{ id: 'plains', from: 0 }];
  let idx = 0;
  for (let i = 0; i < list.length; i++) if (frac + 1e-6 >= list[i].from) idx = i;
  return { id: list[idx].id, idx: Math.min(2, idx) };
}
