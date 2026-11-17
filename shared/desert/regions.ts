// Desert regions + world rules: WHAT stands along the route and WHERE (pure; no three.js). Everything is keyed by
// integer cells along the route (journey distance d, lateral metres to starboard), never by float thresholds, so every
// page (host, guests, OBS, a page opened an hour late) builds the same world at the same distance.
//
//   biomes      dunes, canyon, ruins, saltflat, seabed (a dried ocean floor: stranded ships), industrial, oasis
//   regions     bands of REGION_LEN m along the route with one biome each (a Markov-ish schedule: never the same biome
//               twice in a row), or the biomes a caller supplies (the voyage maps its chapters' flavours onto them)
//   layers      near   (NEAR_CELL cells, 40..260 m out)    boulders, rock pillars, dead trees, bones, debris, posts,
//                                                            girders, palms, salt mounds: the things that visibly pass
//               lines  (per region)                         telegraph poles every 42 m / lattice pylons every 230 m with
//                                                            wires: an old road running beside the route
//               walls  (WALL_CELL cells, canyon biome)      cliff walls 150..330 m out on both sides, tapering at the
//                                                            region ends
//               marks  (MARK_CELL cells, 160..1400 m out)   one landmark per cell at most (stranded liners, dead walkers,
//                                                            lighthouses, factories, pylons, tank farms, aqueducts,
//                                                            temples, watchtowers, buttes, hoodoos, arches, palm groves)
//                                                            + up to two minor ones (buttes, hoodoos, walls, wrecks)
//               gates   (per region, canyon / ruins / industrial)  a hero landmark the ship walks THROUGH (a rock arch,
//                                                            a colossal ruined gateway, a girder gantry): inner half-width
//                                                            >= GATE_CLEAR m, clear height >= 34 m above the sand
//               far     (FAR_CELL cells, 2.5..9 km out)     horizon megastructures (drawn distance-compressed): ruined
//                                                            megatowers, chimney stacks, stranded liners, colossi, walls
// Rules (all tested in tools/desert_unit.ts): nothing but a gate within 40 m of the route; tall near things stay out of
// the danger side's enemy band; at most one big landmark per MARK_CELL; gates at most one per region, never in the first
// or last 25 % of it; the caller hides anything inside a city / dig-site disc at draw time.
import { hash32, rnd, vnoise } from './noise.ts';

export type Biome = 'dunes' | 'canyon' | 'ruins' | 'saltflat' | 'seabed' | 'industrial' | 'oasis';
export const BIOMES: readonly Biome[] = ['dunes', 'canyon', 'ruins', 'saltflat', 'seabed', 'industrial', 'oasis'];
export type MidKind = 'boulders' | 'crags' | 'scrubs' | 'fence' | 'smallwreck' | 'rubble' | 'pipes' | 'tents' | 'cart' | 'bonepile' | 'stumps' | 'pinnacles' | 'crane' | 'masts';
export type NearKind = 'boulder' | 'pillar' | 'scrub' | 'deadtree' | 'bones' | 'debris' | 'post' | 'girder' | 'palm' | 'saltmound';
export type MarkKind = 'liner' | 'deadwalker' | 'lighthouse' | 'factory' | 'pylon' | 'tanks' | 'aqueduct' | 'temple' | 'watchtower' | 'butte' | 'hoodoos' | 'arch' | 'palms' | 'wreck';
export type GateKind = 'rockarch' | 'gateway' | 'gantry';
export type FarKind = 'megatower' | 'stacks' | 'linerfar' | 'colossus' | 'wallruin' | 'mesa';

export const REGION_LEN = 2600;
export const NEAR_CELL = 30;
export const MID_CELL = 70;
export const WALL_CELL = 45;
export const MARK_CELL = 450;
export const FAR_CELL = 2500;
export const POLE_STEP = 42;
export const PYLON_STEP = 230;
/** Nothing but a gate stands closer to the route than this (the ship's legs reach ~8 m; alongside guests ~18 m). */
export const ROUTE_CLEAR = 40;
/** A gate's inner half-width (an alongside kaiju at 18 m still clears it). */
export const GATE_CLEAR = 44;
/** The danger side's enemy band (enemies prowl 95..130 m out): tall near things keep out of it. */
export const ENEMY_BAND: [number, number] = [88, 150];

export interface BiomeRules {
  label: string;
  /** near items per NEAR_CELL per side (mean) */
  near: number;
  nearMix: Partial<Record<NearKind, number>>;
  /** mid-range clusters per MID_CELL per side (100..650 m out: the band the deck looks across) */
  mid: number;
  midMix: Partial<Record<MidKind, number>>;
  line: 'poles' | 'pylons' | null;
  /** odds a region of this biome has a line beside the route */
  lineOdds: number;
  /** odds a MARK_CELL holds a landmark, + the mix */
  markOdds: number;
  marks: Partial<Record<MarkKind, number>>;
  /** minor marks per MARK_CELL (mean) */
  minor: number;
  minors: Partial<Record<MarkKind, number>>;
  gate: GateKind | null;
  gateOdds: number;
  /** canyon walls 0..1 */
  walls: number;
  far: Partial<Record<FarKind, number>>;
  /** ground whitening (salt crust on the flats) 0..1 */
  salt: number;
  /** life: bird flocks, dust devils, blowing sand 0..1 */
  birds: number; devils: number; sheets: number;
}

export const BIOME_RULES: Record<Biome, BiomeRules> = {
  dunes: {
    label: 'Deep dunes', mid: 1.1, midMix: { boulders: 2, scrubs: 2, fence: 1.2, smallwreck: 0.8, bonepile: 0.8, stumps: 0.4, pinnacles: 1.2, masts: 0.6 }, near: 0.9, nearMix: { boulder: 2, scrub: 3, bones: 1, debris: 0.6, post: 0.5, pillar: 0.6, deadtree: 0.8 },
    line: 'poles', lineOdds: 0.35, markOdds: 0.8, marks: { liner: 1.2, deadwalker: 1.4, wreck: 2, butte: 1, watchtower: 0.5 },
    minor: 0.8, minors: { wreck: 1, butte: 1, hoodoos: 0.4 }, gate: null, gateOdds: 0, walls: 0,
    far: { megatower: 1, linerfar: 1.2, colossus: 1, mesa: 2 }, salt: 0, birds: 0.5, devils: 0.8, sheets: 1,
  },
  canyon: {
    label: 'Badlands canyon', mid: 1.4, midMix: { boulders: 2, crags: 3, scrubs: 1, stumps: 0.5, pinnacles: 2.5 }, near: 1.1, nearMix: { boulder: 3, pillar: 2.5, scrub: 1, deadtree: 0.6, bones: 0.4, girder: 0.3 },
    line: null, lineOdds: 0, markOdds: 0.75, marks: { arch: 1.2, butte: 2, hoodoos: 2, deadwalker: 0.6, watchtower: 0.4 },
    minor: 1.4, minors: { hoodoos: 1.5, butte: 1 }, gate: 'rockarch', gateOdds: 0.85, walls: 1,
    far: { mesa: 3, megatower: 0.5, colossus: 0.5 }, salt: 0, birds: 0.9, devils: 0.4, sheets: 0.6,
  },
  ruins: {
    label: 'Old ruins', mid: 1.4, midMix: { rubble: 3, stumps: 2, boulders: 1, fence: 0.8, tents: 0.4, crane: 0.8, pinnacles: 0.6 }, near: 1.0, nearMix: { boulder: 1.4, pillar: 0.6, debris: 1.6, post: 0.6, girder: 0.8, scrub: 1.2, bones: 0.4 },
    line: 'poles', lineOdds: 0.55, markOdds: 0.9, marks: { aqueduct: 1.4, temple: 1.4, watchtower: 1.2, deadwalker: 0.8, factory: 0.4 },
    minor: 1.0, minors: { wreck: 0.6, hoodoos: 0.4, butte: 0.6 }, gate: 'gateway', gateOdds: 0.75, walls: 0,
    far: { megatower: 2.5, wallruin: 2, colossus: 0.8 }, salt: 0.1, birds: 0.7, devils: 0.7, sheets: 0.9,
  },
  saltflat: {
    label: 'Salt flats', mid: 0.9, midMix: { boulders: 1, cart: 1, bonepile: 1.2, fence: 0.8, smallwreck: 0.6, masts: 1, pinnacles: 0.6 }, near: 0.55, nearMix: { saltmound: 3, post: 1.2, bones: 1.2, debris: 0.6, boulder: 0.6, girder: 0.4 },
    line: 'poles', lineOdds: 0.6, markOdds: 0.75, marks: { lighthouse: 1.3, liner: 1, deadwalker: 0.8, wreck: 1 },
    minor: 0.5, minors: { wreck: 1 }, gate: null, gateOdds: 0, walls: 0,
    far: { linerfar: 1.5, megatower: 1, colossus: 0.7 }, salt: 1, birds: 0.3, devils: 1.2, sheets: 0.5,
  },
  seabed: {
    label: 'Dried sea floor', mid: 1.3, midMix: { smallwreck: 3, bonepile: 1.4, boulders: 1, pipes: 0.6, masts: 2, crane: 1 }, near: 0.85, nearMix: { boulder: 1, bones: 1.6, debris: 1.6, girder: 0.6, scrub: 1, post: 0.4, saltmound: 0.6 },
    line: null, lineOdds: 0, markOdds: 0.95, marks: { liner: 2.5, wreck: 2.5, lighthouse: 1, deadwalker: 0.6 },
    minor: 1.2, minors: { wreck: 2 }, gate: null, gateOdds: 0, walls: 0,
    far: { linerfar: 3, colossus: 0.6, mesa: 0.6 }, salt: 0.45, birds: 0.6, devils: 0.6, sheets: 0.9,
  },
  industrial: {
    label: 'Rust works', mid: 1.4, midMix: { pipes: 2.5, rubble: 1.2, cart: 1, fence: 1, smallwreck: 0.5, crane: 2 }, near: 1.0, nearMix: { debris: 2, girder: 1.6, post: 0.8, boulder: 0.8, scrub: 0.6, bones: 0.2 },
    line: 'pylons', lineOdds: 0.9, markOdds: 0.95, marks: { factory: 2, pylon: 1.2, tanks: 1.6, deadwalker: 0.8, watchtower: 0.4 },
    minor: 0.9, minors: { wreck: 0.8, butte: 0.4 }, gate: 'gantry', gateOdds: 0.7, walls: 0,
    far: { stacks: 3, megatower: 1, colossus: 0.6 }, salt: 0, birds: 0.35, devils: 0.5, sheets: 0.8,
  },
  oasis: {
    label: 'Oasis road', mid: 1.3, midMix: { scrubs: 2.4, tents: 1.4, boulders: 0.8, fence: 0.6, cart: 0.6, pinnacles: 0.8 }, near: 1.0, nearMix: { palm: 2.4, scrub: 2.4, boulder: 1, post: 0.6, debris: 0.4 },
    line: 'poles', lineOdds: 0.5, markOdds: 0.8, marks: { palms: 2.4, watchtower: 1, temple: 0.6, wreck: 0.4 },
    minor: 0.8, minors: { butte: 0.6, hoodoos: 0.3 }, gate: null, gateOdds: 0, walls: 0,
    far: { megatower: 1, mesa: 1.5 }, salt: 0, birds: 1, devils: 0.3, sheets: 0.6,
  },
};

/** The voyage's chapter flavours (shared/voyage.ts Flavour) -> [primary, secondary] biome (the secondary takes the last
 *  part of some chapters). Unknown flavours fall back to dunes. */
export const FLAVOUR_BIOMES: Record<string, [Biome, Biome]> = {
  dunes: ['dunes', 'seabed'], canyon: ['canyon', 'canyon'], ruins: ['ruins', 'industrial'], saltflat: ['saltflat', 'seabed'],
  oasis: ['oasis', 'dunes'], bazaar: ['industrial', 'ruins'],
};

/** A biome provider: the biome at journey distance d (pure, stable for a given d). */
export type BiomeAt = (d: number) => Biome;

function pickW<T extends string>(mix: Partial<Record<T, number>>, u: number): T | null {
  let tot = 0;
  for (const k in mix) tot += mix[k] ?? 0;
  if (tot <= 0) return null;
  let acc = 0;
  for (const k in mix) { acc += (mix[k] ?? 0) / tot; if (u < acc) return k; }
  for (const k in mix) if ((mix[k] ?? 0) > 0) return k;   // (u ~ 1: the first non-zero)
  return null;
}

const REGION_W: Record<Biome, number> = { dunes: 3, canyon: 1.6, ruins: 1.6, saltflat: 1.1, seabed: 1.3, industrial: 1.2, oasis: 0.9 };
/** The desert's own region schedule (no voyage): region r = floor(d / REGION_LEN); never the same biome twice in a row. */
export function regionBiome(seed: number, r: number): Biome {
  // even regions pick freely; an odd region picks anything but its two even neighbours (pure, O(1), never a repeat)
  const cand = (k: number, alt = 0) => pickW(REGION_W, rnd(seed, k, 811, alt)) ?? 'dunes';
  if (((r % 2) + 2) % 2 === 0) return cand(r);
  const a = cand(r - 1), b = cand(r + 1);
  for (let i = 0; i < 8; i++) { const c = cand(r, i); if (c !== a && c !== b) return c; }
  return BIOMES.find((x) => x !== a && x !== b)!;
}
export function defaultBiomeAt(seed: number): BiomeAt { return (d) => regionBiome(seed, Math.floor(d / REGION_LEN)); }

/** Biome inside a chapter of a flavour: the primary, with the secondary over the last 30..45 % of some chapters. */
export function chapterBiome(flavour: string, ch: number, u: number, seed: number): Biome {
  const fb = FLAVOUR_BIOMES[flavour] ?? FLAVOUR_BIOMES.dunes;
  if (fb[0] === fb[1] || rnd(seed, ch, 821) < 0.45) return fb[0];
  return u < 0.55 + 0.15 * rnd(seed, ch, 822) ? fb[0] : fb[1];
}

/** 0..1: how far inside a run of the same biome d is (0 at a change, 1 from `ramp` m on) - walls taper with it. */
export function biomeDepth(biomeAt: BiomeAt, d: number, ramp = 300): number {
  const b = biomeAt(d), step = ramp / 6;
  for (let o = step; o <= ramp + 1e-6; o += step) if (biomeAt(d - o) !== b || biomeAt(d + o) !== b) return (o - step) / ramp;
  return 1;
}

// ------------------------------------------------------------------ placements (route frame: s along, lat starboard)
export interface NearItem { id: number; kind: NearKind; s: number; lat: number; yaw: number; scale: number; variant: number; biome: Biome }
export interface MarkItem { id: number; kind: MarkKind; s: number; lat: number; yaw: number; scale: number; variant: number; minor: boolean; biome: Biome }
export interface GateItem { id: number; kind: GateKind; s: number; yaw: number; scale: number; variant: number; region: number }
export interface FarItem { id: number; kind: FarKind; s: number; lat: number; yaw: number; scale: number; variant: number }
export interface LineItem { id: number; kind: 'pole' | 'pylon'; s: number; lat: number; yaw: number; fallen: boolean; lean: number; region: number }
export interface WallItem { id: number; s: number; lat: number; h: number; w: number; yaw: number; variant: number }

const TALL: ReadonlySet<NearKind> = new Set(['pillar', 'deadtree', 'palm', 'girder']);

/** Near items of cell i on one side (+1 starboard, -1 port); dangerSide = the side enemies come from. */
export function nearCell(seed: number, i: number, side: 1 | -1, biomeAt: BiomeAt, dangerSide: 1 | -1 = -1): NearItem[] {
  const s0 = i * NEAR_CELL;
  const b = biomeAt(s0 + NEAR_CELL / 2);
  const R = BIOME_RULES[b];
  const sk = side > 0 ? 1 : 2;
  const n = Math.floor(rnd(seed, i, sk, 401) * R.near * 2 + 0.35);
  const out: NearItem[] = [];
  for (let k = 0; k < n; k++) {
    const kind = pickW(R.nearMix, rnd(seed, i, sk * 16 + k, 402));
    if (!kind) continue;
    const tall = TALL.has(kind);
    // tall things fill the band the deck sees over the rails (40..95 m) or stand well out; small ones anywhere 40..260 m
    let lat = tall ? (rnd(seed, i, sk * 16 + k, 403) < 0.7 ? 42 + 50 * rnd(seed, i, sk * 16 + k, 404) : 150 + 110 * rnd(seed, i, sk * 16 + k, 404))
      : ROUTE_CLEAR + 220 * rnd(seed, i, sk * 16 + k, 404) ** 1.4;
    if (tall && side === dangerSide && lat > ENEMY_BAND[0] && lat < ENEMY_BAND[1]) lat = ENEMY_BAND[0] - 2;
    const sc = kind === 'pillar' ? 0.6 + 1.2 * rnd(seed, i, sk * 16 + k, 405) ** 1.6 : 0.6 + 0.8 * rnd(seed, i, sk * 16 + k, 405);
    out.push({ id: hash32(seed, i, sk * 16 + k, 406), kind, s: s0 + NEAR_CELL * rnd(seed, i, sk * 16 + k, 407), lat: side * lat, yaw: rnd(seed, i, sk * 16 + k, 408) * Math.PI * 2, scale: sc, variant: hash32(seed, i, sk * 16 + k, 409) % 8, biome: b });
  }
  return out;
}

export interface MidItem { id: number; kind: MidKind; s: number; lat: number; yaw: number; scale: number; variant: number; biome: Biome }
/** Mid-range clusters of cell i on one side (100..650 m out). */
export function midCell(seed: number, i: number, side: 1 | -1, biomeAt: BiomeAt, dangerSide: 1 | -1 = -1): MidItem[] {
  const s0 = i * MID_CELL;
  const b = biomeAt(s0 + MID_CELL / 2);
  const R = BIOME_RULES[b];
  const sk = side > 0 ? 1 : 2;
  const n = Math.floor(rnd(seed, i, sk, 411) * R.mid * 2 + 0.3);
  const out: MidItem[] = [];
  for (let k = 0; k < n; k++) {
    const kind = pickW(R.midMix, rnd(seed, i, sk * 16 + k, 412));
    if (!kind) continue;
    let lat = 100 + 550 * rnd(seed, i, sk * 16 + k, 413) ** 1.15;
    if (side === dangerSide && lat > ENEMY_BAND[0] && lat < ENEMY_BAND[1] + 10) lat = ENEMY_BAND[1] + 10 + (lat - ENEMY_BAND[0]);
    out.push({ id: hash32(seed, i, sk * 16 + k, 414), kind, s: s0 + MID_CELL * rnd(seed, i, sk * 16 + k, 415), lat: side * lat, yaw: rnd(seed, i, sk * 16 + k, 416) * Math.PI * 2, scale: 0.7 + 0.7 * rnd(seed, i, sk * 16 + k, 417), variant: hash32(seed, i, sk * 16 + k, 418) % 8, biome: b });
  }
  return out;
}

/** The region's roadside line (telegraph poles or pylons), if it has one: kind, side, lateral offset. Pure per region. */
export function regionLine(seed: number, r: number, biomeAt: BiomeAt): { kind: 'pole' | 'pylon'; side: 1 | -1; lat: number } | null {
  const b = biomeAt((r + 0.5) * REGION_LEN);
  const R = BIOME_RULES[b];
  if (!R.line || rnd(seed, r, 431) >= R.lineOdds) return null;
  const side: 1 | -1 = rnd(seed, r, 432) < 0.6 ? 1 : -1;      // (starboard more often: the port side is the danger side)
  const lat = R.line === 'poles' ? 52 + 30 * rnd(seed, r, 433) : 175 + 90 * rnd(seed, r, 433);
  return { kind: R.line === 'poles' ? 'pole' : 'pylon', side, lat: side * lat };
}

/** Line posts with s in [a, b): the region's line, continuous inside the region (and only where its biome holds). */
export function lineItems(seed: number, a: number, b: number, biomeAt: BiomeAt): LineItem[] {
  const out: LineItem[] = [];
  for (let r = Math.floor(a / REGION_LEN); r <= Math.floor(b / REGION_LEN); r++) {
    const L = regionLine(seed, r, biomeAt);
    if (!L) continue;
    const step = L.kind === 'pole' ? POLE_STEP : PYLON_STEP;
    const lo = Math.max(a, r * REGION_LEN + 60), hi = Math.min(b, (r + 1) * REGION_LEN - 60);
    for (let k = Math.ceil(lo / step); k * step < hi; k++) {
      const s = k * step;
      // the line wanders a little (slow lateral drift) and skips a post now and then (a gap in the line)
      if (rnd(seed, k, r, 441) < 0.04) continue;
      const drift = (vnoise(seed + 443, s / 700, r) - 0.5) * 14;
      out.push({ id: hash32(seed, r, k, 444), kind: L.kind, s, lat: L.lat + drift, yaw: 0, fallen: L.kind === 'pole' && rnd(seed, k, r, 445) < 0.05, lean: (rnd(seed, k, r, 446) - 0.5) * (L.kind === 'pole' ? 0.16 : 0.03), region: r });
    }
  }
  return out;
}

/** Canyon wall segments with s in [a, b) (both sides): only where the biome has walls, tapering at the biome's edges. */
export function wallItems(seed: number, a: number, b: number, biomeAt: BiomeAt): WallItem[] {
  const out: WallItem[] = [];
  for (let i = Math.floor(a / WALL_CELL); i * WALL_CELL < b; i++) {
    const s = (i + 0.5) * WALL_CELL;
    const R = BIOME_RULES[biomeAt(s)];
    if (R.walls <= 0) continue;
    const k = biomeDepth(biomeAt, s, 420) * R.walls;
    if (k <= 0.02) continue;
    for (const side of [1, -1] as const) {
      const sk = side > 0 ? 1 : 2;
      if (rnd(seed, i, sk, 451) < 0.12) continue;                                    // gaps: side canyons
      const lat = side * (165 + 150 * vnoise(seed + 452 + sk, s / 520, 3.7) + 18 * (rnd(seed, i, sk, 453) - 0.5));
      const h = (38 + 62 * vnoise(seed + 454 + sk, s / 340, 1.3) ** 1.3 + 5 * rnd(seed, i, sk, 455)) * (0.25 + 0.75 * k);
      out.push({ id: hash32(seed, i, sk, 456), s: s + (rnd(seed, i, sk, 457) - 0.5) * 12, lat, h, w: 58 + 22 * rnd(seed, i, sk, 458), yaw: (rnd(seed, i, sk, 459) - 0.5) * 0.35, variant: hash32(seed, i, sk, 460) % 4 });
    }
  }
  return out;
}

/** Landmarks of mark cell j: at most one big one (any side) + minor ones further out. */
export function markCell(seed: number, j: number, biomeAt: BiomeAt, dangerSide: 1 | -1 = -1): MarkItem[] {
  const out: MarkItem[] = [];
  const s0 = j * MARK_CELL;
  const b = biomeAt(s0 + MARK_CELL / 2);
  const R = BIOME_RULES[b];
  // up to two big ones: the first on a hashed side, the second (rarer) on the other side, never the same along-route spot
  const side0: 1 | -1 = rnd(seed, j, 473) < 0.5 ? 1 : -1;
  for (let n = 0; n < 2; n++) {
    if (rnd(seed, j, 471 + n * 40) >= R.markOdds * (n ? 0.45 : 1)) continue;
    const kind = pickW(R.marks, rnd(seed, j, 472 + n * 40));
    if (!kind) continue;
    const side = (n ? -side0 : side0) as 1 | -1;
    const big = kind === 'liner' || kind === 'factory' || kind === 'tanks' || kind === 'aqueduct';
    const minLat = (side === dangerSide ? 175 : 115) + (big ? 90 : 0);
    const lat = minLat + (big ? 520 : 420) * rnd(seed, j, 474 + n * 40) ** 1.2;
    const u = n ? (rnd(seed, j, 476) < 0.5 ? 0.6 + 0.3 * rnd(seed, j, 516) : 0.1 + 0.3 * rnd(seed, j, 516)) : 0.15 + 0.7 * rnd(seed, j, 476);
    out.push({ id: hash32(seed, j, 475 + n * 40), kind, s: s0 + MARK_CELL * u, lat: side * lat, yaw: rnd(seed, j, 477 + n * 40) * Math.PI * 2, scale: 0.85 + 0.5 * rnd(seed, j, 478 + n * 40), variant: hash32(seed, j, 479 + n * 40) % 8, minor: false, biome: b });
  }
  const nm = Math.floor(rnd(seed, j, 481) * R.minor * 2 + 0.4);
  for (let k = 0; k < nm; k++) {
    const kind = pickW(R.minors, rnd(seed, j, 482 + k * 7));
    if (!kind) continue;
    const side: 1 | -1 = rnd(seed, j, 483 + k * 7) < 0.5 ? 1 : -1;
    const lat = 260 + 900 * rnd(seed, j, 484 + k * 7);
    out.push({ id: hash32(seed, j, 485 + k * 7), kind, s: s0 + MARK_CELL * rnd(seed, j, 486 + k * 7), lat: side * lat, yaw: rnd(seed, j, 487 + k * 7) * Math.PI * 2, scale: 0.7 + 0.6 * rnd(seed, j, 488 + k * 7), variant: hash32(seed, j, 489 + k * 7) % 8, minor: true, biome: b });
  }
  return out;
}

/** The region's gate (the ship walks through it), if any: in the middle half of the region, square to the route. */
export function regionGate(seed: number, r: number, biomeAt: BiomeAt): GateItem | null {
  const s = (r + 0.25 + 0.5 * rnd(seed, r, 491)) * REGION_LEN;
  const b = biomeAt(s);
  const R = BIOME_RULES[b];
  if (!R.gate || rnd(seed, r, 492) >= R.gateOdds) return null;
  // the whole gate must sit inside its biome (a change within 150 m: no gate)
  if (biomeAt(s - 150) !== b || biomeAt(s + 150) !== b) return null;
  return { id: hash32(seed, r, 493), kind: R.gate, s, yaw: (rnd(seed, r, 494) - 0.5) * 0.25, scale: 0.9 + 0.3 * rnd(seed, r, 495), variant: hash32(seed, r, 496) % 4, region: r };
}

/** Horizon megastructures of far cell k (one per side at most). */
export function farCell(seed: number, k: number, biomeAt: BiomeAt): FarItem[] {
  const out: FarItem[] = [];
  for (const side of [1, -1] as const) for (let n = 0; n < 2; n++) {
    const sk = (side > 0 ? 1 : 2) + n * 4;
    if (rnd(seed, k, sk, 501) > (n ? 0.45 : 0.85)) continue;
    const s = (k + (n ? 0.5 : 0) + 0.45 * rnd(seed, k, sk, 502)) * FAR_CELL;
    const kind = pickW(BIOME_RULES[biomeAt(s)].far, rnd(seed, k, sk, 503));
    if (!kind) continue;
    out.push({ id: hash32(seed, k, sk, 504), kind, s, lat: side * (2200 + 6000 * rnd(seed, k, sk, 505)), yaw: rnd(seed, k, sk, 506) * Math.PI * 2, scale: 0.8 + 0.7 * rnd(seed, k, sk, 507), variant: hash32(seed, k, sk, 508) % 8 });
  }
  return out;
}
