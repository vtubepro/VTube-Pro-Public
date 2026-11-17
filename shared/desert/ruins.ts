// World rules for the desert's ruins (src/scene/desert/ruins.ts draws them): burning wrecks near the route and ruined
// towns / industrial skylines on the horizon band. Pure functions of (seed, cell, density): every page, OBS included,
// places the same wreck at the same journey distance, and a page opened late sees the same fires.
//   wrecks  one chance per WRECK_CELL m of route, 165..330 m to either side (clear of the enemy band 88..150 m and of the
//           relief's cliffs), a fallen walker / a broken hull / a toppled tower / an overturned convoy; most of them burn
//   towns   one chance per TOWN_CELL m, sides alternating, 1.15..2.25 km out (on the high ground beyond the dune sea):
//           kit-bashed industrial ruins (works, forts, stack yards) with smoking chimneys, lit windows and red beacons
import { rnd } from './noise.ts';

export const WRECK_CELL = 420;
export const TOWN_CELL = 1700;
/** Nearest a wreck stands to the route (m): clear of the enemy band (regions.ts ENEMY_BAND 88..150). */
export const WRECK_MIN_LAT = 165;
export const WRECK_MAX_LAT = 330;
export const TOWN_MIN_LAT = 1150;
export const TOWN_MAX_LAT = 2250;

export type WreckKind = 'walker' | 'hull' | 'tower' | 'convoy';
export const WRECK_KINDS: readonly WreckKind[] = ['walker', 'hull', 'tower', 'convoy'];
export interface WreckItem { id: number; kind: WreckKind; s: number; lat: number; yaw: number; scale: number; burning: boolean; heat: number }

export type TownKind = 'works' | 'fort' | 'stacks';
export const TOWN_KINDS: readonly TownKind[] = ['works', 'fort', 'stacks'];
export interface TownItem { id: number; kind: TownKind; s: number; lat: number; yaw: number; scale: number; lights: number }

/** A density from a room config: finite, 0..2 (default 1). */
export function cleanDensity(v: unknown, d = 1): number { return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(2, v)) : d; }

/** The wreck of route cell j (or null). density 0..2 (1 = about 60 % of the cells: one per ~700 m). */
export function wreckCell(seed: number, j: number, density = 1): WreckItem | null {
  if (!(density > 0) || rnd(seed, j, 901) > Math.min(0.95, 0.6 * density)) return null;
  const side = rnd(seed, j, 902) < 0.5 ? -1 : 1;
  const lat = side * (WRECK_MIN_LAT + (WRECK_MAX_LAT - WRECK_MIN_LAT) * rnd(seed, j, 903) ** 1.3);
  const u = rnd(seed, j, 904);
  const kind: WreckKind = u < 0.34 ? 'walker' : u < 0.64 ? 'hull' : u < 0.84 ? 'tower' : 'convoy';
  return {
    id: (seed ^ Math.imul(j, 0x2c1b3c6d)) >>> 0, kind, s: (j + 0.15 + 0.7 * rnd(seed, j, 905)) * WRECK_CELL, lat,
    yaw: rnd(seed, j, 906) * Math.PI * 2, scale: 0.8 + 0.5 * rnd(seed, j, 907), burning: rnd(seed, j, 908) < 0.82, heat: 0.7 + 0.6 * rnd(seed, j, 909),
  };
}

/** The town of route cell k (or null). density 0..2 (1 = about 70 % of the cells). */
export function townCell(seed: number, k: number, density = 1): TownItem | null {
  if (!(density > 0) || rnd(seed, k, 921) > Math.min(0.95, 0.7 * density)) return null;
  let side = k % 2 ? 1 : -1;
  if (rnd(seed, k, 922) < 0.25) side = -side;
  const u = rnd(seed, k, 925);
  const kind: TownKind = u < 0.45 ? 'works' : u < 0.75 ? 'fort' : 'stacks';
  return {
    id: (seed ^ Math.imul(k + 7919, 0x45d9f3b)) >>> 0, kind, s: (k + 0.2 + 0.6 * rnd(seed, k, 924)) * TOWN_CELL,
    lat: side * (TOWN_MIN_LAT + (TOWN_MAX_LAT - TOWN_MIN_LAT) * rnd(seed, k, 923)),
    yaw: rnd(seed, k, 926) * Math.PI * 2, scale: 0.85 + 0.45 * rnd(seed, k, 927), lights: 0.5 + 0.5 * rnd(seed, k, 928),
  };
}

/** Wrecks with closest approach in [a, b] (journey m). */
export function wrecksIn(seed: number, a: number, b: number, density = 1): WreckItem[] {
  const out: WreckItem[] = [];
  for (let j = Math.floor(a / WRECK_CELL) - 1; j * WRECK_CELL <= b; j++) { const w = wreckCell(seed, j, density); if (w && w.s >= a && w.s <= b) out.push(w); }
  return out;
}

/** Towns with closest approach in [a, b] (journey m). */
export function townsIn(seed: number, a: number, b: number, density = 1): TownItem[] {
  const out: TownItem[] = [];
  for (let k = Math.floor(a / TOWN_CELL) - 1; k * TOWN_CELL <= b; k++) { const t = townCell(seed, k, density); if (t && t.s >= a && t.s <= b) out.push(t); }
  return out;
}

/** The nearest burning wreck whose closest approach is within [d - behind, d + ahead] (camera shots frame the ship
 *  walking past it), or null. Ahead first: the nearest one still to come, else the nearest one just passed. */
export function burningNear(seed: number, d: number, density = 1, ahead = 1600, behind = 400): WreckItem | null {
  let best: WreckItem | null = null, bk = Infinity;
  for (const w of wrecksIn(seed, d - behind, d + ahead, density)) {
    if (!w.burning) continue;
    const k = w.s >= d ? w.s - d : (d - w.s) * 3;
    if (k < bk) { bk = k; best = w; }
  }
  return best;
}
