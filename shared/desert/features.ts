// Seeded desert features, keyed by INTEGER cells / indices (never thresholds on float positions), so every page places
// the same rock at the same spot at any journey distance:
//   near features  256 m cells   outcrops, wrecks (half-buried sand ships), ruins, rock arches, bone fields
//   scatter         48 m cells   small rocks + dry scrub (dense near the camera only)
//   mesas         4 km cells     mesas, buttes, spires (drawn distance-compressed out to 40 km)
//   cities        along the route one every ~11 km, 2.5-6 km to the side (layered skylines, lit windows at night)
// Clearances keep everything off the ship's corridor. Names are placeholders for the owner to approve.
import type { DesertWorldSpec } from './height.ts';
import { hash32, rnd } from './noise.ts';
import type { RoutePoint } from './route.ts';

export const FEATURE_CELL = 256;
export const SCATTER_CELL = 48;
export const MESA_CELL = 4000;
export const CITY_SPACING = 11000;

export type FeatureKind = 'outcrop' | 'wreck' | 'ruin' | 'arch' | 'bones';
export interface Feature { id: number; kind: FeatureKind; x: number; z: number; yaw: number; scale: number; variant: number }

/** Odds per 256 m cell (cumulative order) + clearance from the route (m). */
const FEATURE_ODDS: [FeatureKind, number, number][] = [['outcrop', 0.11, 40], ['wreck', 0.03, 55], ['ruin', 0.025, 45], ['arch', 0.012, 70], ['bones', 0.02, 35]];

export function cellFeature(spec: DesertWorldSpec, cx: number, cz: number): Feature | null {
  const S = spec.seed;
  const r = rnd(S, cx, cz, 91);
  let acc = 0;
  for (const [kind, p, clear] of FEATURE_ODDS) {
    acc += p;
    if (r >= acc) continue;
    const x = (cx + 0.15 + 0.7 * rnd(S, cx, cz, 92)) * FEATURE_CELL, z = (cz + 0.15 + 0.7 * rnd(S, cx, cz, 93)) * FEATURE_CELL;
    const scale = kind === 'arch' ? 0.8 + 0.7 * rnd(S, cx, cz, 94) : kind === 'outcrop' ? 0.6 + 1.6 * rnd(S, cx, cz, 94) ** 1.5 : 0.75 + 0.6 * rnd(S, cx, cz, 94);
    if (spec.route.dist(x, z) < clear * scale + 12) return null;
    return { id: hash32(S, cx, cz, 95), kind, x, z, yaw: rnd(S, cx, cz, 96) * Math.PI * 2, scale, variant: hash32(S, cx, cz, 97) % 4 };
  }
  return null;
}

export interface Scatter { id: number; kind: 'rock' | 'scrub'; x: number; z: number; yaw: number; scale: number; variant: number }
/** Small things in a 48 m cell (0..5 of them). `flatAt` = the hardpan mask at a point (more rocks on hardpan). */
export function cellScatter(spec: DesertWorldSpec, cx: number, cz: number, flatAt: (x: number, z: number) => number, out: Scatter[]) {
  const S = spec.seed;
  const fx = (cx + 0.5) * SCATTER_CELL, fz = (cz + 0.5) * SCATTER_CELL;
  const fl = flatAt(fx, fz);
  const n = Math.floor(rnd(S, cx, cz, 101) * (1.2 + 4.5 * fl));
  for (let i = 0; i < n; i++) {
    const x = (cx + rnd(S, cx, cz, 110 + i)) * SCATTER_CELL, z = (cz + rnd(S, cx, cz, 120 + i)) * SCATTER_CELL;
    if (spec.route.dist(x, z) < 16) continue;
    const scrub = rnd(S, cx, cz, 130 + i) < 0.35 + 0.25 * (1 - fl);
    out.push({ id: hash32(S, cx, cz, 140 + i), kind: scrub ? 'scrub' : 'rock', x, z, yaw: rnd(S, cx, cz, 150 + i) * 6.2832, scale: scrub ? 0.6 + 0.9 * rnd(S, cx, cz, 160 + i) : 0.3 + 1.4 * rnd(S, cx, cz, 160 + i) ** 2, variant: hash32(S, cx, cz, 170 + i) % 4 });
  }
}

export type MesaKind = 'mesa' | 'butte' | 'spire';
export interface Mesa { id: number; kind: MesaKind; x: number; z: number; r: number; h: number; yaw: number; variant: number }

export function cellMesa(spec: DesertWorldSpec, cx: number, cz: number): Mesa | null {
  const S = spec.seed;
  if (rnd(S, cx, cz, 201) > 0.46) return null;
  const x = (cx + 0.1 + 0.8 * rnd(S, cx, cz, 202)) * MESA_CELL, z = (cz + 0.1 + 0.8 * rnd(S, cx, cz, 203)) * MESA_CELL;
  const t = rnd(S, cx, cz, 204);
  const kind: MesaKind = t < 0.5 ? 'mesa' : t < 0.85 ? 'butte' : 'spire';
  const r = kind === 'mesa' ? 260 + 620 * rnd(S, cx, cz, 205) : kind === 'butte' ? 70 + 120 * rnd(S, cx, cz, 205) : 22 + 30 * rnd(S, cx, cz, 205);
  const h = kind === 'mesa' ? 70 + 190 * rnd(S, cx, cz, 206) : kind === 'butte' ? 90 + 160 * rnd(S, cx, cz, 206) : 70 + 110 * rnd(S, cx, cz, 206);
  if (spec.route.dist(x, z) < r + 650) return null;
  return { id: hash32(S, cx, cz, 207), kind, x, z, r, h, yaw: rnd(S, cx, cz, 208) * Math.PI * 2, variant: hash32(S, cx, cz, 209) % 4 };
}

export type CityArchetype = 'windtower' | 'hulkharbor' | 'cistern' | 'spirebazaar';
export const CITY_ARCHETYPES: CityArchetype[] = ['windtower', 'hulkharbor', 'cistern', 'spirebazaar'];
/** Placeholder names (owner's pun list; owner approves before release). */
export const CITY_NAMES = ['Rustwell Junction', 'Ochre Oasis', 'Cinder Springs', 'Dry Wells', 'Gritfall', 'New Ironside', 'Saltway Crossing', 'Dune Harbor', 'Copper Spires', 'Ember Flats'];

export interface City { id: number; index: number; d: number; x: number; z: number; side: number; lateral: number; radius: number; archetype: CityArchetype; name: string; seed: number; /** voyage-placed (DesertWorld.setCities), not seeded */ placed?: boolean }

/** City i: closest approach at journey distance d, `lateral` m to the side (2.5-6 km). */
export function cityAt(spec: DesertWorldSpec, i: number, rp: RoutePoint = { x: 0, z: 0, heading: 0, curv: 0 }): City {
  const S = spec.seed;
  const d = i * CITY_SPACING + 1500 + rnd(S, i, 301) * 5000;
  const side = rnd(S, i, 302) < 0.5 ? -1 : 1;
  const lateral = 2500 + 3500 * rnd(S, i, 303);
  spec.route.at(d, rp);
  // starboard of heading h: room +X -> world (cos h, sin h)
  const x = rp.x + Math.cos(rp.heading) * lateral * side, z = rp.z + Math.sin(rp.heading) * lateral * side;
  const archetype = CITY_ARCHETYPES[hash32(S, i, 304) % CITY_ARCHETYPES.length];
  return { id: hash32(S, i, 305), index: i, d, x, z, side, lateral, radius: 260 + 360 * rnd(S, i, 306), archetype, name: CITY_NAMES[hash32(S, i, 307) % CITY_NAMES.length], seed: hash32(S, i, 308) };
}

/** Cities whose closest approach is within `range` m of journey distance d. */
export function citiesNear(spec: DesertWorldSpec, d: number, range: number): City[] {
  const out: City[] = [];
  const i0 = Math.floor((d - range) / CITY_SPACING) - 1, i1 = Math.floor((d + range) / CITY_SPACING) + 1;
  for (let i = i0; i <= i1; i++) { const c = cityAt(spec, i); if (Math.abs(c.d - d) <= range) out.push(c); }
  return out;
}

export type PartKind = 'box' | 'dome' | 'tower' | 'spire' | 'windcatcher' | 'wall' | 'hull' | 'crane' | 'tent' | 'windmill' | 'plinth';
/** One skyline primitive in city-local metres (x right, z back, y up; yaw rad). emit = window density 0..1. */
export interface CityPart { kind: PartKind; x: number; z: number; y: number; w: number; h: number; d: number; yaw: number; emit: number; tint: number }

/** Seeded grammar: a dominant landmark at the centre, 2-3 secondary verticals, domes / houses in the middle ring,
 *  tents + windbreak walls on the edge, archetype-specific pieces (wind-catchers, beached hulls + cranes, cistern
 *  domes + windmills, spires + sail canopies). Deterministic from city.seed. */
export function cityLayout(city: City): CityPart[] {
  const P: CityPart[] = [];
  let k = 0;
  const r = (n = 0) => rnd(city.seed, k++, n);
  const R = city.radius;
  const A = city.archetype;
  const push = (p: CityPart) => P.push(p);
  // ground plinth / mesa the town sits on (windtower towns sit on a mesa)
  if (A === 'windtower') push({ kind: 'plinth', x: 0, z: 0, y: 0, w: R * 1.25, h: 40 + 30 * r(), d: R * 1.05, yaw: r() * 6.28, emit: 0, tint: 0.35 });
  const baseY = A === 'windtower' ? P[0].h : 0;
  // windtower towns stand ON the mesa: keep the inner rings inside its cap (its top is ~0.32 R across at the narrowest;
  // seen from a city pass 250-600 m out, houses hanging over the cliff edge read as floating)
  const inner = A === 'windtower' ? 0.4 : 1;
  // landmark
  const lm: Record<CityArchetype, PartKind> = { windtower: 'windcatcher', hulkharbor: 'hull', cistern: 'dome', spirebazaar: 'spire' };
  if (A === 'hulkharbor') {
    for (let i = 0; i < 3; i++) push({ kind: 'hull', x: (r() - 0.5) * R * 0.9, z: (r() - 0.5) * R * 0.6, y: -4, w: 26 + 20 * r(), h: 30 + 18 * r(), d: 150 + 120 * r(), yaw: r() * 6.28, emit: 0.5, tint: 0.6 });
    for (let i = 0; i < 4; i++) push({ kind: 'crane', x: (r() - 0.5) * R * 1.1, z: (r() - 0.5) * R * 0.8, y: 0, w: 6, h: 60 + 40 * r(), d: 50 + 30 * r(), yaw: r() * 6.28, emit: 0, tint: 0.8 });
  } else {
    push({ kind: lm[A], x: 0, z: 0, y: baseY, w: A === 'cistern' ? 70 + 30 * r() : 24 + 10 * r(), h: A === 'cistern' ? 60 + 20 * r() : A === 'spirebazaar' ? 150 + 60 * r() : 90 + 40 * r(), d: 24, yaw: r() * 6.28, emit: 0.3, tint: 0.15 });
  }
  // secondary verticals
  const nSec = 2 + Math.floor(r() * 2);
  for (let i = 0; i < nSec; i++) {
    const a = r() * 6.28, rr = R * (0.2 + 0.25 * r()) * inner;
    const kind: PartKind = A === 'windtower' ? 'windcatcher' : A === 'spirebazaar' ? 'spire' : A === 'cistern' ? 'windmill' : 'tower';
    push({ kind, x: Math.cos(a) * rr, z: Math.sin(a) * rr, y: baseY, w: 12 + 8 * r(), h: 50 + 45 * r(), d: 12, yaw: r() * 6.28, emit: 0.6, tint: 0.25 });
  }
  // middle ring: houses + domes
  const nMid = 26 + Math.floor(r() * 26);
  for (let i = 0; i < nMid; i++) {
    const a = r() * 6.28, rr = R * (0.15 + 0.6 * Math.sqrt(r())) * inner;
    const dome = r() < (A === 'cistern' ? 0.55 : 0.25);
    const h = dome ? 10 + 14 * r() : 8 + 22 * r() * r() + 6;
    push({ kind: dome ? 'dome' : 'box', x: Math.cos(a) * rr, z: Math.sin(a) * rr * 0.75, y: baseY, w: 10 + 16 * r(), h, d: 10 + 14 * r(), yaw: r() * 6.28, emit: 0.85, tint: r() });
  }
  if (A === 'cistern') for (let i = 0; i < 3; i++) { const a = r() * 6.28; push({ kind: 'windmill', x: Math.cos(a) * R * 0.85, z: Math.sin(a) * R * 0.6, y: 0, w: 8, h: 40 + 15 * r(), d: 8, yaw: r() * 6.28, emit: 0, tint: 0.7 }); }
  // edge: tents + windbreak walls
  const nEdge = 10 + Math.floor(r() * 10);
  for (let i = 0; i < nEdge; i++) {
    const a = r() * 6.28, rr = R * (0.8 + 0.3 * r());
    push({ kind: A === 'spirebazaar' || r() < 0.5 ? 'tent' : 'wall', x: Math.cos(a) * rr, z: Math.sin(a) * rr * 0.75, y: 0, w: 12 + 12 * r(), h: 6 + 6 * r(), d: 8 + 10 * r(), yaw: a + Math.PI / 2, emit: 0.2, tint: r() });
  }
  return P;
}
