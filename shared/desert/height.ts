// THE desert height function: one source of truth for the CPU (feet, footprints, ship tilt, prop placement, tests)
// and its GLSL twin (src/scene/desert/glsl.ts generates the shader from the constants + site table below).
//
// Layers (research: the terrain lane report, section 2):
//   base swell (fbm 1.8 km, +-10 m) + domain warp (22 m @ 420 m) + a FIXED-angle wind frame (u downwind, v across)
//   draa mega-dunes (1.25 km), transverse / barchan crests (asymmetric: 78 % stoss, 22 % slip face, sinuous crest
//   lines, horns where low), two regional wavelengths (110 / 210 m) blended by noise, seif ridges along the wind in
//   other regions, interdune hardpan flats, a calmer corridor along the route, optional flatten discs (stops / towns).
//   Never rotate absolute coordinates by a spatially varying angle (fingerprint whorls): variety = blended fields.
//
// Precision: the GPU evaluates in terrain-local coordinates (world - origin O, |local| < 8 km). Every noise "site" is
// an affine function of world (x, z) or of the rotated (u, v); per octave the CPU computes the lattice offset at O in
// float64, reduced mod 4096 (the hash wraps there), and the GPU adds local * 2.03^i. Periodic dune phases get
// fract(U0 / lambda). heightLocal() is that exact decomposition in float64 (the GLSL's mirror); heightAt() is the plain
// absolute form. Tests assert they agree (< 1e-6 m) up to 5000 km out, and the GPU parity test checks the shader.
import { LATTICE, OCT_ADD_X, OCT_ADD_Z, OCT_MUL, fbm, fbmOff, fract, mod, rnd, sstep, vnoise } from './noise.ts';
import { DesertRoute, ROUTE_STEP, segDist } from './route.ts';

export const DUNE = {
  base: { amp: 10 },
  warp: { amp: 22 },
  field: { lo: -0.15, hi: 0.25 },
  draa: { spacing: 1250, amp: 18, ph: 0.4, top: 0.85, pw: 1.5, ampMix: 0.55 },
  amp: { lo: 0.25, hi: 0.75, min: 0.15 },
  crest: { stoss: 0.78, p1: 1.4, p2: 0.75, horn: 0.35, lam: [110, 210] as const, ph: [0.5, 0.65] as const, h: [16, 26] as const },
  mixL: { lo: -0.3, hi: 0.3 },
  seif: { spacing: 260, amp: 30, ph: 0.35, pw: 2.2 },
  flat: { lo: 0.2, hi: 0.42 },
  corridor: { min: 0.22, r0: 25, r1: 140 },
};

/** Relief (the land under the sand): mesas with stepped cliffs + scree aprons, and ridged ranges, rising only away from
 *  the route (the ship always walks the dune sea: 0 within r0 m, full from r1 m) and taller towards the horizon (far0..far1
 *  m from the route, x (1 + farK)), so the horizon stacks into silhouette layers. Scaled by DesertWorldSpec.relief
 *  (0 = the classic dune sea, 1 = default, max 1.5). Heights (m) at relief 1: mesas 62 + 38 (upper tier) + 14 (talus),
 *  ridges up to 120 * 1.3. */
export const RELIEF = {
  r0: 220, r1: 520, far0: 1100, far1: 2600, farK: 0.4,
  /** the nearest any relief starts (m from the route: a basin's fall-away) - below it the height is the dune sea's */
  rMin: 130,
  kind: { lo: 0.02, hi: 0.3 },
  mesa: { lo: -0.02, edge: 0.03, h: 150, tier: 0.12, tierEdge: 0.022, h2: 90, talus: 0.11, talusH: 22, rag: 0.09 },
  ridge: { sharp: 2.4, pw: 1.25, h: 230, lift: 0.3 },
  /** broad highlands under both landforms (m): the land beyond the dune sea rises, so the horizon is never flat */
  uplift: { h: 40, lo: -0.5, hi: 0.25 },
  /** canyon stretches (the variety field `rvar` high): walls on BOTH sides from r0..r1 m off the route, h m tall, giving
   *  way to the normal land out0..out1 m out */
  canyon: { lo: 0.66, hi: 0.78, r0: 150, r1: 260, h: 190, out0: 700, out1: 1100 },
  /** ridge-over-a-basin stretches (`rvar` low): the land falls away depth m on both sides (r0..r1 m out), rising again
   *  far0..far1 m out; the relief stays low until open0..open1 m so the basin reads */
  basin: { lo: 0.34, hi: 0.22, r0: 130, r1: 420, depth: 70, far0: 1400, far1: 2400, open0: 900, open1: 1700 },
  /** erosion: ledges every `step` m on the cliffs (a flat shelf then a riser: k of the way to a full terrace, from k0..k1 m
   *  of relief up), and a jagged rim (the `rjag` field moves the mesa edge and the canyon walls' line by up to jag m) */
  terrace: { step: 13, k: 0.62, k0: 12, k1: 32 },
  jag: { mesa: 0.035, wall: 45 },
  amp: { lo: -0.35, hi: 0.3, min: 0.5 },
  /** dunes thin out on the high ground (sand drapes, the rock shows): dune height x (1 - dune * min(1, relief / cover)) */
  dune: 0.7, cover: 35,
  max: 1.5,
};
/** Highest relief (m) at a relief amplitude (bounds for culling and the RGBA8 clipmap fallback). */
export const reliefMax = (amp: number) => Math.max(0, Math.min(RELIEF.max, amp)) * (1 + RELIEF.farK) * (RELIEF.uplift.h + Math.max(RELIEF.mesa.h + RELIEF.mesa.h2 + RELIEF.mesa.talusH, RELIEF.ridge.h * (1 + RELIEF.ridge.lift)));
/** Deepest relief (m, negative: a basin) at a relief amplitude. */
export const reliefMin = (amp: number) => -Math.max(0, Math.min(RELIEF.max, amp)) * RELIEF.basin.depth;

/** Coordinate a noise site reads: world x / z, or the wind frame u (downwind) / v (across) of the warped point. */
type Axis = 'x' | 'z' | 'u' | 'v';
export interface Site { name: string; seed: number; oct: number; ax: Axis; sx: number; bx: number; az: Axis; sz: number; bz: number; warped: boolean }
/** The noise sites in GPU order (base index = cumulative octaves). seed is relative to the world seed. */
export const SITES: Site[] = [
  { name: 'base', seed: 1, oct: 3, ax: 'x', sx: 1800, bx: 0, az: 'z', sz: 1800, bz: 0, warped: false },
  { name: 'warpX', seed: 2, oct: 3, ax: 'x', sx: 420, bx: 0, az: 'z', sz: 420, bz: 0, warped: false },
  { name: 'warpZ', seed: 3, oct: 3, ax: 'x', sx: 420, bx: 17.3, az: 'z', sz: 420, bz: -9.1, warped: false },
  { name: 'field', seed: 5, oct: 2, ax: 'x', sx: 2600, bx: 0, az: 'z', sz: 2600, bz: 0, warped: false },
  { name: 'draa', seed: 10, oct: 2, ax: 'v', sx: 2200, bx: 0, az: 'u', sz: 4000, bz: 0, warped: true },
  { name: 'amp', seed: 6, oct: 1, ax: 'u', sx: 700, bx: 0, az: 'v', sz: 260, bz: 0, warped: true },
  { name: 'crest0', seed: 7, oct: 3, ax: 'v', sx: 380, bx: 0, az: 'u', sz: 900, bz: 0, warped: true },
  { name: 'crest1', seed: 57, oct: 3, ax: 'v', sx: 380, bx: 0, az: 'u', sz: 900, bz: 0, warped: true },
  { name: 'mixL', seed: 11, oct: 2, ax: 'x', sx: 3000, bx: 0, az: 'z', sz: 3000, bz: 0, warped: false },
  { name: 'seif', seed: 8, oct: 3, ax: 'u', sx: 700, bx: 0, az: 'v', sz: 700, bz: 0, warped: true },
  { name: 'seifAmp', seed: 9, oct: 1, ax: 'u', sx: 1200, bx: 0, az: 'v', sz: 500, bz: 0, warped: true },
  { name: 'flat', seed: 12, oct: 3, ax: 'x', sx: 1500, bx: 0, az: 'z', sz: 1500, bz: 0, warped: false },
  // relief (RELIEF): which landform (mesas / ridges), the mesa field, the ridge field, the relief amplitude
  { name: 'rkind', seed: 13, oct: 2, ax: 'x', sx: 3400, bx: 3.1, az: 'z', sz: 3400, bz: -7.7, warped: false },
  { name: 'rmesa', seed: 14, oct: 3, ax: 'x', sx: 1400, bx: -5.3, az: 'z', sz: 1400, bz: 2.9, warped: false },
  { name: 'rridge', seed: 15, oct: 3, ax: 'x', sx: 950, bx: 8.9, az: 'z', sz: 950, bz: 1.3, warped: false },
  { name: 'ramp', seed: 16, oct: 1, ax: 'x', sx: 2600, bx: -1.7, az: 'z', sz: 2600, bz: 6.1, warped: false },
  { name: 'rvar', seed: 17, oct: 1, ax: 'x', sx: 2400, bx: 4.4, az: 'z', sz: 2400, bz: -3.3, warped: false },
  { name: 'rjag', seed: 18, oct: 2, ax: 'x', sx: 140, bx: -2.2, az: 'z', sz: 140, bz: 5.6, warped: false },
];
export const SITE_BASE: Record<string, number> = {};
export const SITE_COUNT = SITES.reduce((n, s) => { SITE_BASE[s.name] = n; return n + s.oct; }, 0);   // 29
/** Periodic phases (GPU uniform vec4): u / 110, u / 210, u / draa spacing, v / seif spacing. */
export const PHASES = [{ axis: 'u' as Axis, lam: DUNE.crest.lam[0] }, { axis: 'u' as Axis, lam: DUNE.crest.lam[1] }, { axis: 'u' as Axis, lam: DUNE.draa.spacing }, { axis: 'v' as Axis, lam: DUNE.seif.spacing }];
/** Corridor polyline points on the GPU (N route samples CORRIDOR_STEP m apart, +-3.2 km around the camera's route point:
 *  the same 200 m chords as DesertRoute.dist). */
export const CORRIDOR_N = 32;
export const CORRIDOR_STEP = 200;
export const MAX_FLATS = 8;

/** A flatten disc (stop site, settlement): heights within r blend to h (edge band = 30 % of r). World coordinates. */
export interface Flat { x: number; z: number; r: number; h: number }

/** Valid discs only (finite, r > 0), at most MAX_FLATS, copied (callers may reuse their arrays). */
export function cleanFlats(list: readonly Flat[] | null | undefined): Flat[] {
  const out: Flat[] = [];
  for (const f of list ?? []) {
    if (out.length >= MAX_FLATS) break;
    if (f && [f.x, f.z, f.r, f.h].every(Number.isFinite) && f.r > 0) out.push({ x: f.x, z: f.z, r: f.r, h: f.h });
  }
  return out;
}

/** World description: everything the height function depends on (seed-derived unless overridden). */
export class DesertWorldSpec {
  readonly seed: number;
  /** Dune-forming wind direction (rad): u axis = (cos, sin) in world (x, z). */
  readonly wind: number;
  readonly c: number;
  readonly s: number;
  readonly route: DesertRoute;
  flats: Flat[] = [];
  /** Corridor on/off (the calm band the ship walks). */
  corridor = true;
  /** Relief amplitude (RELIEF): 0 = dunes only, 1 = mesas / cliffs / ridges away from the route, max 1.5. */
  relief = 1;

  constructor(seed: number, opts?: { wind?: number; routeBase?: number; maxTurnDeg?: number; flats?: Flat[]; relief?: number }) {
    this.seed = seed >>> 0;
    this.wind = opts?.wind ?? rnd(this.seed, 31) * Math.PI * 2;
    this.c = Math.cos(this.wind); this.s = Math.sin(this.wind);
    // SPEC D9 / 2.4: mean route direction psiBar = wind + 90 deg +- 20 deg (by seed): the ship walks roughly along the
    // transverse crests and crosses them at a shallow angle (variety without head-on pitching)
    const along = this.wind + Math.PI / 2 + ((20 * Math.PI) / 180) * (2 * rnd(this.seed, 32) - 1);
    // heading h walks along (sin h, -cos h); a direction angle a (cos a, sin a) is h = a + pi/2
    this.route = new DesertRoute(this.seed, { base: opts?.routeBase ?? along + Math.PI / 2, maxTurnDeg: opts?.maxTurnDeg });
    if (opts?.flats) this.flats = cleanFlats(opts.flats);
    if (opts?.relief !== undefined) this.relief = cleanRelief(opts.relief);
  }
}

const sd = (spec: DesertWorldSpec, k: number) => (spec.seed + k) >>> 0;
/** A relief amplitude from a room config: finite, 0..RELIEF.max (default 1). */
export function cleanRelief(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(RELIEF.max, v)) : 1; }

/** The relief term (m) from its noise fields (shared by every evaluation path; the GLSL twin is in glsl.ts). */
/** Terraced cliffs: a flat ledge, then a riser, every RELIEF.terrace.step m (blended in above k0..k1 m of relief). */
function terrace(h: number): number {
  const T = RELIEF.terrace;
  if (h <= T.k0) return h;
  const t = h / T.step, k = Math.floor(t), s = sstep(0.3, 0.7, t - k);
  return h + ((k + s) * T.step - h) * T.k * sstep(T.k0, T.k1, h);
}
function reliefOf(amp: number, rd: number, kindN: number, mesaN: number, ridgeN: number, ampN: number, varN: number, jagN: number): number {
  const R = RELIEF, M = R.mesa, C = R.canyon, B = R.basin;
  const kind = sstep(R.kind.lo, R.kind.hi, kindN);
  const m = mesaN + M.rag * ridgeN + R.jag.mesa * jagN;
  const mesa = M.h * sstep(M.lo, M.lo + M.edge, m) + M.h2 * sstep(M.lo + M.tier, M.lo + M.tier + M.tierEdge, m) + M.talusH * sstep(M.lo - M.talus, M.lo, m);
  const ridge = R.ridge.h * (Math.pow(Math.max(0, 1 - Math.abs(ridgeN) * R.ridge.sharp), R.ridge.pw) + R.ridge.lift * sstep(-0.3, 0.4, mesaN));
  const a = R.amp.min + (1 - R.amp.min) * sstep(R.amp.lo, R.amp.hi, ampN);
  const up = R.uplift.h * sstep(R.uplift.lo, R.uplift.hi, mesaN);
  const cy = sstep(C.lo, C.hi, varN), bs = sstep(B.lo, B.hi, varN);
  const far = 1 + R.farK * sstep(R.far0, R.far1, rd);
  let rel = sstep(R.r0, R.r1, rd) * far * a * (up + mesa * (1 - kind) + ridge * kind);
  rel *= 1 - bs * (1 - sstep(B.open0, B.open1, rd));
  const rj = rd + R.jag.wall * jagN;
  const wall = cy * C.h * sstep(C.r0, C.r1, rj) * (1 - sstep(C.out0, C.out1, rd)) * (0.78 + 0.22 * sstep(-0.4, 0.4, ridgeN));
  const dip = bs * B.depth * sstep(B.r0, B.r1, rd) * (1 - sstep(B.far0, B.far1, rd));
  return amp * (terrace(Math.max(rel, wall)) - dip);
}

function crestProfile(t: number): number {
  const C = DUNE.crest;
  return t < C.stoss ? Math.pow(Math.max(0, Math.sin((0.5 * Math.PI * t) / C.stoss)), C.p1) : Math.pow(Math.max(0, (1 - t) / (1 - C.stoss)), C.p2);
}

/** Intermediate fields (colouring and tests want some of them). */
export interface DuneSample { h: number; flat: number; field: number; corridor: number; dunes: number }

/** Noise accessors for one evaluation: fbm / single-octave value noise of site k at the current (warped) point, the
 *  periodic phase i, and the distance to the route corridor. */
interface Access { fbm(k: number): number; one(k: number): number; phase(i: number): number; route(): number }

/** Absolute evaluation through the generic site table (the reference the fast path is tested against). */
export function heightAtRef(spec: DesertWorldSpec, x: number, z: number, out?: DuneSample): number {
  let u = 0, v = 0;
  const co = (a: Axis) => (a === 'x' ? x : a === 'z' ? z : a === 'u' ? u : v);
  const A: Access = {
    fbm: (k) => { const s = SITES[k]; return fbm(sd(spec, s.seed), co(s.ax) / s.sx + s.bx, co(s.az) / s.sz + s.bz, s.oct); },
    one: (k) => { const s = SITES[k]; return vnoise(sd(spec, s.seed), co(s.ax) / s.sx + s.bx, co(s.az) / s.sz + s.bz); },
    phase: (i) => (PHASES[i].axis === 'u' ? u : v) / PHASES[i].lam,
    route: () => (spec.corridor ? spec.route.dist(x, z) : 1e9),
  };
  const wx = A.fbm(1), wz = A.fbm(2);
  const qx = x + DUNE.warp.amp * wx, qz = z + DUNE.warp.amp * wz;
  u = qx * spec.c + qz * spec.s; v = -qx * spec.s + qz * spec.c;
  return combine(A, x, z, spec.flats, out, spec.relief);
}

/** The shared body (base swell + dunes + corridor + flats), written once over the accessors. */
function combine(A: Access, x: number, z: number, flats: Flat[], out?: DuneSample, relief = 0): number {
  const D = DUNE;
  const base = D.base.amp * A.fbm(0);
  const field = sstep(D.field.lo, D.field.hi, A.fbm(3));
  const dt = fract(A.phase(2) + D.draa.ph * A.fbm(4));
  const draa = Math.pow(Math.max(0, Math.sin(Math.PI * Math.min(1, dt / D.draa.top))), D.draa.pw);
  const amp = (D.amp.min + (1 - D.amp.min) * sstep(D.amp.lo, D.amp.hi, A.one(5))) * (1 - D.draa.ampMix + D.draa.ampMix * draa);
  const horn = D.crest.horn * (1 - amp);
  const c0 = crestProfile(fract(A.phase(0) + D.crest.ph[0] * A.fbm(6) + horn));
  const c1 = crestProfile(fract(A.phase(1) + D.crest.ph[1] * A.fbm(7) + horn));
  const mixL = sstep(D.mixL.lo, D.mixL.hi, A.fbm(8));
  const trans = amp * (D.crest.h[0] * c0 * (1 - mixL) + D.crest.h[1] * c1 * mixL);
  const r = 1 - Math.abs(2 * fract(A.phase(3) + D.seif.ph * A.fbm(9)) - 1);
  const seif = D.seif.amp * Math.pow(r, D.seif.pw) * (0.55 + 0.45 * A.one(10));
  const flat = sstep(D.flat.lo, D.flat.hi, A.fbm(11));
  const dunes = D.draa.amp * draa * (1 - field) + (trans * (1 - field) + seif * field) * (1 - flat);
  const rd = A.route();
  const corridor = D.corridor.min + (1 - D.corridor.min) * sstep(D.corridor.r0, D.corridor.r1, rd);
  const rel = relief > 0 && rd > RELIEF.rMin ? reliefOf(relief, rd, A.fbm(12), A.fbm(13), A.fbm(14), A.one(15), A.one(16), A.fbm(17)) : 0;
  let h = base + dunes * corridor * (1 - RELIEF.dune * Math.min(1, Math.max(0, rel / RELIEF.cover))) + rel;
  for (const f of flats) {
    const dx = x - f.x, dz = z - f.z;
    h += (f.h - h) * (1 - sstep(f.r * 0.7, f.r, Math.sqrt(dx * dx + dz * dz)));
  }
  if (out) { out.h = h; out.flat = flat; out.field = field; out.corridor = corridor; out.dunes = dunes; }
  return h;
}


// ------------------------------------------------------------------ fast absolute path (hand-inlined; same maths)
const ax = (n: string, x: Axis, z: Axis) => { const s = SITES.find((t) => t.name === n)!; if (s.ax !== x || s.az !== z) throw new Error(`desert: fast path out of date for site ${n}`); return s; };
const F0 = ax('base', 'x', 'z'), F1 = ax('warpX', 'x', 'z'), F2 = ax('warpZ', 'x', 'z'), F3 = ax('field', 'x', 'z'), F4 = ax('draa', 'v', 'u'), F5 = ax('amp', 'u', 'v');
const F6 = ax('crest0', 'v', 'u'), F7 = ax('crest1', 'v', 'u'), F8 = ax('mixL', 'x', 'z'), F9 = ax('seif', 'u', 'v'), F10 = ax('seifAmp', 'u', 'v'), F11 = ax('flat', 'x', 'z');
const F12 = ax('rkind', 'x', 'z'), F13 = ax('rmesa', 'x', 'z'), F14 = ax('rridge', 'x', 'z'), F15 = ax('ramp', 'x', 'z'), F16 = ax('rvar', 'x', 'z'), F17 = ax('rjag', 'x', 'z');

/** World height (m) at world (x, z): ~1.5 us. Equal to heightAtRef / heightLocal (tools/desert_unit.ts). `flats`
 *  defaults to the spec's discs; pass [] for the raw dunes (the height a new flatten disc should level to). */
const fsite = (S: number, t: Site, a: number, b: number) => fbm((S + t.seed) >>> 0, a / t.sx + t.bx, b / t.sz + t.bz, t.oct);

export function heightAt(spec: DesertWorldSpec, x: number, z: number, out?: DuneSample, flats: Flat[] = spec.flats): number {
  const S = spec.seed, D = DUNE, D2 = RELIEF;
  const base = D.base.amp * fsite(S, F0, x, z);
  const qx = x + D.warp.amp * fsite(S, F1, x, z), qz = z + D.warp.amp * fsite(S, F2, x, z);
  const u = qx * spec.c + qz * spec.s, v = -qx * spec.s + qz * spec.c;
  const field = sstep(D.field.lo, D.field.hi, fsite(S, F3, x, z));
  const dt = fract(u / D.draa.spacing + D.draa.ph * fsite(S, F4, v, u));
  const draa = Math.pow(Math.max(0, Math.sin(Math.PI * Math.min(1, dt / D.draa.top))), D.draa.pw);
  const amp = (D.amp.min + (1 - D.amp.min) * sstep(D.amp.lo, D.amp.hi, vnoise((S + F5.seed) >>> 0, u / F5.sx + F5.bx, v / F5.sz + F5.bz))) * (1 - D.draa.ampMix + D.draa.ampMix * draa);
  const horn = D.crest.horn * (1 - amp);
  const c0 = crestProfile(fract(u / D.crest.lam[0] + D.crest.ph[0] * fsite(S, F6, v, u) + horn));
  const c1 = crestProfile(fract(u / D.crest.lam[1] + D.crest.ph[1] * fsite(S, F7, v, u) + horn));
  const mixL = sstep(D.mixL.lo, D.mixL.hi, fsite(S, F8, x, z));
  const trans = amp * (D.crest.h[0] * c0 * (1 - mixL) + D.crest.h[1] * c1 * mixL);
  const r = 1 - Math.abs(2 * fract(v / D.seif.spacing + D.seif.ph * fsite(S, F9, u, v)) - 1);
  const seif = D.seif.amp * Math.pow(r, D.seif.pw) * (0.55 + 0.45 * vnoise((S + F10.seed) >>> 0, u / F10.sx + F10.bx, v / F10.sz + F10.bz));
  const flat = sstep(D.flat.lo, D.flat.hi, fsite(S, F11, x, z));
  const dunes = D.draa.amp * draa * (1 - field) + (trans * (1 - field) + seif * field) * (1 - flat);
  const rd = spec.corridor ? spec.route.dist(x, z) : 1e9;
  const corridor = spec.corridor ? D.corridor.min + (1 - D.corridor.min) * sstep(D.corridor.r0, D.corridor.r1, rd) : 1;
  const rel = spec.relief > 0 && rd > D2.rMin
    ? reliefOf(spec.relief, rd, fsite(S, F12, x, z), fsite(S, F13, x, z), fsite(S, F14, x, z), vnoise((S + F15.seed) >>> 0, x / F15.sx + F15.bx, z / F15.sz + F15.bz),
      vnoise((S + F16.seed) >>> 0, x / F16.sx + F16.bx, z / F16.sz + F16.bz), fsite(S, F17, x, z)) : 0;
  let h = base + dunes * corridor * (1 - D2.dune * Math.min(1, Math.max(0, rel / D2.cover))) + rel;
  for (const fl of flats) {
    const dx = x - fl.x, dz = z - fl.z;
    h += (fl.h - h) * (1 - sstep(fl.r * 0.7, fl.r, Math.sqrt(dx * dx + dz * dz)));
  }
  if (out) { out.h = h; out.flat = flat; out.field = field; out.corridor = corridor; out.dunes = dunes; }
  return h;
}

// ------------------------------------------------------------------ the offset (GPU) form
/** Everything the GPU needs for terrain origin (ox, oz): per-site per-octave lattice offsets, dune phases, corridor. */
export interface LocalCtx {
  ox: number; oz: number;
  /** 2 * SITE_COUNT floats: lattice offset (x, z) of site octave k at the origin, mod 4096. */
  off: Float64Array;
  /** fract(U0 / lambda) for PHASES. */
  phase: Float64Array;
  /** CORRIDOR_N route samples relative to the origin (x, z interleaved). */
  poly: Float64Array;
  polyK0: number;
  /** flats relative to the origin */
  flats: Flat[];
}

/** Build the local context: origin O (multiple of 1024 m keeps float32 exact) + the route point the corridor centres on. */
export function localCtx(spec: DesertWorldSpec, ox: number, oz: number, routeD: number, out?: LocalCtx): LocalCtx {
  const ctx: LocalCtx = out ?? { ox, oz, off: new Float64Array(2 * SITE_COUNT), phase: new Float64Array(4), poly: new Float64Array(2 * CORRIDOR_N), polyK0: 0, flats: [] };
  ctx.ox = ox; ctx.oz = oz;
  const U0 = ox * spec.c + oz * spec.s, V0 = -ox * spec.s + oz * spec.c;
  const at = (a: Axis) => (a === 'x' ? ox : a === 'z' ? oz : a === 'u' ? U0 : V0);
  let k = 0;
  for (const s of SITES) {
    let X = at(s.ax) / s.sx + s.bx, Z = at(s.az) / s.sz + s.bz;
    for (let i = 0; i < s.oct; i++, k++) {
      ctx.off[2 * k] = mod(X, LATTICE); ctx.off[2 * k + 1] = mod(Z, LATTICE);
      X = X * OCT_MUL + OCT_ADD_X; Z = Z * OCT_MUL + OCT_ADD_Z;
    }
  }
  PHASES.forEach((p, i) => { ctx.phase[i] = fract((p.axis === 'u' ? U0 : V0) / p.lam); });
  ctx.polyK0 = spec.route.polyline(routeD, CORRIDOR_N, ctx.poly, ox, oz, CORRIDOR_STEP);
  ctx.flats = spec.flats.map((f) => ({ x: f.x - ox, z: f.z - oz, r: f.r, h: f.h }));
  return ctx;
}

/** Local evaluation at (xl, zl) = world - O: the float64 mirror of the GLSL (glsl.ts duneHeight). */
export function heightLocal(spec: DesertWorldSpec, ctx: LocalCtx, xl: number, zl: number, out?: DuneSample): number {
  const off = ctx.off;
  let u = 0, v = 0;
  const co = (a: Axis) => (a === 'x' ? xl : a === 'z' ? zl : a === 'u' ? u : v);
  const A: Access = {
    fbm: (k) => { const s = SITES[k]; return fbmOff(sd(spec, s.seed), off, SITE_BASE[s.name], co(s.ax) / s.sx, co(s.az) / s.sz, s.oct); },
    one: (k) => { const s = SITES[k]; const b = 2 * SITE_BASE[s.name]; return vnoise(sd(spec, s.seed), off[b] + co(s.ax) / s.sx, off[b + 1] + co(s.az) / s.sz); },
    phase: (i) => ctx.phase[i] + (PHASES[i].axis === 'u' ? u : v) / PHASES[i].lam,
    route: () => {
      if (!spec.corridor) return 1e9;
      let best = Infinity;
      const p = ctx.poly;
      for (let i = 0; i + 1 < CORRIDOR_N; i++) best = Math.min(best, segDist(xl, zl, p[2 * i], p[2 * i + 1], p[2 * i + 2], p[2 * i + 3]));
      return best;
    },
  };
  const wx = A.fbm(1), wz = A.fbm(2);
  const qx = xl + DUNE.warp.amp * wx, qz = zl + DUNE.warp.amp * wz;
  u = qx * spec.c + qz * spec.s; v = -qx * spec.s + qz * spec.c;
  return combine(A, xl, zl, ctx.flats, out, spec.relief);
}

/** Ground normal (world) by central differences (eps m). */
export function normalAt(spec: DesertWorldSpec, x: number, z: number, eps = 0.35): [number, number, number] {
  const hx = heightAt(spec, x + eps, z) - heightAt(spec, x - eps, z);
  const hz = heightAt(spec, x, z + eps) - heightAt(spec, x, z - eps);
  const nx = -hx / (2 * eps), nz = -hz / (2 * eps), l = Math.hypot(nx, 1, nz);
  return [nx / l, 1 / l, nz / l];
}

export { ROUTE_STEP };
