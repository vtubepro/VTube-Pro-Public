// Voyage ground: the desert height function in pure JS (feet, enemies, cities, the dig site all stand on it) and its GLSL
// twin for the terrain mesh (voyageWorld.ts). Same integer hashes on both sides (uint maths == Math.imul), lattice wrapped
// at 4096 cells, and every large coordinate split into a CPU double offset + a small local part, so the GPU matches the
// CPU to millimetres at any distance walked (S up to millions of metres) - no float32 drift, no fingerprint whorls.
//
// Coordinates: world route frame (s = metres along the route, + forward; d = lateral, + starboard; h = up).
// The world group's local frame (voyageWorld) is x = d, y = h, z = -(s - S): the shader gets local (x, z) + offsets of S.
//
// INTEGRATION: the desert lane's terrain (shared/desert heightAt + CDLOD) replaces this through VoyageGroundProvider -
// see voyageWorld.ts setGroundProvider(); feet / props / cameras only ever call `heightAt(s, d)`.

import { BIOME_IN, BIOME_OUT } from '../../../shared/voyage.ts';

export interface VoyageFlat { s: number; d: number; r: number; h: number }

/** Per-leg terrain flavour: dune amplitude and hill amplitude multipliers. */
export interface GroundBiome { dune: number; hill: number }

const W_ANG = 0.55;                                  // wind frame angle (rad) in the (s, d) plane - FIXED (no whorls)
const WC = Math.cos(W_ANG), WS = Math.sin(W_ANG);
const LAM1 = 140, LAM2 = 46;                         // crest wavelengths (m)
const CELLS = [900, 260, 420, 700] as const;         // noise cells: base hills, small hills, warp, amplitude field
const VCELL = 300;                                   // crest phase noise along the crest line (v)
const SEEDS = [0x1b873593, 0x5bd1e995, 0x68e31da4, 0x2c1b3c6d, 0x297a2d39] as const;

function h2(seed: number, x: number, y: number): number {
  let h = (seed ^ Math.imul(x & 4095, 0x27d4eb2d) ^ Math.imul(y & 4095, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
const U32 = 1 / 4294967296;
function vn(seed: number, px: number, py: number): number {
  const ix = Math.floor(px), iy = Math.floor(py);
  const fx = px - ix, fy = py - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = h2(seed, ix, iy) * U32, b = h2(seed, ix + 1, iy) * U32, c = h2(seed, ix, iy + 1) * U32, e = h2(seed, ix + 1, iy + 1) * U32;
  return (a + (b - a) * ux) + ((c + (e - c) * ux) - (a + (b - a) * ux)) * uy;
}
function crest(t: number): number {
  const f = t - Math.floor(t);
  return f < 0.78 ? Math.pow(Math.sin((1.5707963 * f) / 0.78), 1.4) : Math.pow((1 - f) / 0.22, 0.75);
}
const sstep = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const mod4096 = (x: number) => x - 4096 * Math.floor(x / 4096);
const fract = (x: number) => x - Math.floor(x);

/** Chapter of a distance: index and its start / end (m). */
export interface GroundChapter { ch: number; s0: number; s1: number }

/** The ground. One per voyage scene; biome + flats are updated from the timeline each frame (cheap).
 *  Biomes change one-sidedly AFTER a chapter boundary (shared/voyage.ts BIOME_IN..BIOME_OUT m past it), so a fork vote
 *  stamped before the boundary never changes the ground under or near the ship. */
export class VoyageGround {
  /** chapter length (m) when no chapterAt is set (uniform chapters from s = 0) */
  legDist = 5200;
  /** the chapter that holds s (voyageGroundBinding: pacing changes make chapters non-uniform); null = legDist */
  chapterAt: ((s: number) => GroundChapter) | null = null;
  biomeOf: (leg: number) => GroundBiome = () => ({ dune: 1, hill: 1 });
  flats: VoyageFlat[] = [];
  chapterOf(s: number): GroundChapter {
    if (this.chapterAt) return this.chapterAt(s);
    const L = this.legDist, ch = Math.floor(s / L);
    return { ch, s0: ch * L, s1: (ch + 1) * L };
  }
  /** Raw height without flats (m). */
  raw(s: number, d: number): number {
    const c = this.chapterOf(s);
    const A = this.biomeOf(c.ch - 1), B = this.biomeOf(c.ch);
    const k = sstep(c.s0 + BIOME_IN, c.s0 + BIOME_OUT, s);
    const dune = A.dune + (B.dune - A.dune) * k, hill = A.hill + (B.hill - A.hill) * k;
    // base hills
    const base = (7.0 * (vn(SEEDS[0], s / CELLS[0], d / CELLS[0]) - 0.5) * 2 + 2.4 * (vn(SEEDS[1], s / CELLS[1], d / CELLS[1]) - 0.5) * 2) * hill;
    // domain warp along the wind
    const warp = 18 * (vn(SEEDS[2], s / CELLS[2], d / CELLS[2]) - 0.5) * 2;
    const amp = 0.35 + 0.65 * vn(SEEDS[3], s / CELLS[3], d / CELLS[3]);
    const v = -s * WS + d * WC;
    const pn = 0.35 * vn(SEEDS[4], v / VCELL, 0.5);
    const loc = d * WS + warp;                               // the d / warp part of u = s*WC + d*WS + warp
    const c1 = crest(fract((s * WC) / LAM1) + loc / LAM1 + pn + 0.35 * (1 - amp)) * 9 * amp;
    const c2 = crest(fract((s * WC) / LAM2) + loc / LAM2 + pn * 0.5) * 1.5 * (0.5 + 0.5 * amp);
    const corr = 0.28 + 0.72 * sstep(22, 110, Math.abs(d));
    return base + (c1 + c2) * corr * dune;
  }
  /** Height (m) at world (s, d), flats applied. */
  heightAt(s: number, d: number): number {
    let h = this.raw(s, d);
    for (const f of this.flats) {
      const dist = Math.hypot(s - f.s, d - f.d);
      if (dist < f.r) h += (f.h - h) * sstep(f.r, f.r * 0.55, dist);
    }
    return h;
  }
  /** Ground normal (unit, world route frame: x = d, y = up, z = -s) by central differences. */
  normalAt(s: number, d: number, e = 0.75): [number, number, number] {
    const hx = (this.heightAt(s, d + e) - this.heightAt(s, d - e)) / (2 * e);
    const hs = (this.heightAt(s + e, d) - this.heightAt(s - e, d)) / (2 * e);
    // d/dx = hx, d/dz = -hs (z = -s)
    const nx = -hx, ny = 1, nz = hs;
    const l = Math.hypot(nx, ny, nz);
    return [nx / l, ny / l, nz / l];
  }

  /** Uniform values for the GLSL twin at distance S (doubles reduced on the CPU). */
  uniforms(S: number, out: GroundUniformValues): GroundUniformValues {
    for (let i = 0; i < 4; i++) out.offN[i] = mod4096(S / CELLS[i]);
    out.offV = mod4096((-S * WS) / VCELL);
    out.ph1 = fract((S * WC) / LAM1); out.ph2 = fract((S * WC) / LAM2);
    // the ship's chapter: its start (behind) and end (ahead) boundaries + the biomes before, in and after it. The view
    // (<= 2.6 km) never reaches past the next boundary by a whole chapter (>= 2.7 km); behind the start the previous
    // chapter's own biome (its blend from the one before, > 2.2 km back, is not drawn)
    const c = this.chapterOf(S);
    const A = this.biomeOf(c.ch - 1), B = this.biomeOf(c.ch), N = this.biomeOf(c.ch + 1);
    out.bio[0] = c.s0 - S; out.bio[1] = c.s1 - S;
    out.bio[2] = A.dune; out.bio[3] = B.dune; out.bio[4] = N.dune; out.bio[5] = A.hill; out.bio[6] = B.hill; out.bio[7] = N.hill;
    out.flatN = Math.min(4, this.flats.length);
    for (let i = 0; i < 4; i++) {
      const f = this.flats[i];
      if (f) { out.flats[i * 4] = f.d; out.flats[i * 4 + 1] = -(f.s - S); out.flats[i * 4 + 2] = f.r; out.flats[i * 4 + 3] = f.h; }
      else { out.flats[i * 4] = 0; out.flats[i * 4 + 1] = 1e6; out.flats[i * 4 + 2] = 1; out.flats[i * 4 + 3] = 0; }
    }
    return out;
  }
}

export interface GroundUniformValues { offN: number[]; offV: number; ph1: number; ph2: number; bio: number[]; flatN: number; flats: number[] }
export const newGroundUniformValues = (): GroundUniformValues => ({ offN: [0, 0, 0, 0], offV: 0, ph1: 0, ph2: 0, bio: [-1e6, 1e6, 1, 1, 1, 1, 1, 1], flatN: 0, flats: new Array(16).fill(0) });
/** uVgBio length: [start, end of the ship's chapter (local m), dune before / in / after, hill before / in / after] */
export const GROUND_BIO_N = 8;

/** GLSL twin (GLSL ES 3.00). Declares its uniforms; call vgHeight(vec2(x, z)) with world-group local x (= d), z (= -(s-S)). */
export const GROUND_GLSL = /* glsl */ `
uniform vec4 uVgOffN; uniform float uVgOffV; uniform vec2 uVgPh; uniform float uVgBio[${GROUND_BIO_N}]; uniform int uVgFlatN; uniform vec4 uVgFlat[4];
uint vgH2(uint seed, int x, int y) {
  uint h = seed ^ (uint(x & 4095) * 0x27d4eb2du) ^ (uint(y & 4095) * 0x165667b1u);
  h = (h ^ (h >> 15u)) * 0x85ebca6bu;
  h = (h ^ (h >> 13u)) * 0xc2b2ae35u;
  return h ^ (h >> 16u);
}
float vgVn(uint seed, vec2 p) {
  vec2 i = floor(p), f = p - i; vec2 u = f * f * (3.0 - 2.0 * f);
  ivec2 c = ivec2(i);
  float a = float(vgH2(seed, c.x, c.y)) * 2.3283064e-10, b = float(vgH2(seed, c.x + 1, c.y)) * 2.3283064e-10;
  float d = float(vgH2(seed, c.x, c.y + 1)) * 2.3283064e-10, e = float(vgH2(seed, c.x + 1, c.y + 1)) * 2.3283064e-10;
  return mix(mix(a, b, u.x), mix(d, e, u.x), u.y);
}
float vgCrest(float t) {
  float f = fract(t);
  return f < 0.78 ? pow(sin(1.5707963 * f / 0.78), 1.4) : pow((1.0 - f) / 0.22, 0.75);
}
float vgRaw(vec2 L) {
  float sl = -L.y, d = L.x;                      // s - S, d
  float k0 = smoothstep(uVgBio[0] + ${BIOME_IN}.0, uVgBio[0] + ${BIOME_OUT}.0, sl), k1 = smoothstep(uVgBio[1] + ${BIOME_IN}.0, uVgBio[1] + ${BIOME_OUT}.0, sl);
  float dune = mix(mix(uVgBio[2], uVgBio[3], k0), uVgBio[4], k1), hill = mix(mix(uVgBio[5], uVgBio[6], k0), uVgBio[7], k1);
  float base = (7.0 * (vgVn(${SEEDS[0]}u, vec2(sl / ${CELLS[0]}.0 + uVgOffN.x, d / ${CELLS[0]}.0)) - 0.5) * 2.0
              + 2.4 * (vgVn(${SEEDS[1]}u, vec2(sl / ${CELLS[1]}.0 + uVgOffN.y, d / ${CELLS[1]}.0)) - 0.5) * 2.0) * hill;
  float warp = 18.0 * (vgVn(${SEEDS[2]}u, vec2(sl / ${CELLS[2]}.0 + uVgOffN.z, d / ${CELLS[2]}.0)) - 0.5) * 2.0;
  float amp = 0.35 + 0.65 * vgVn(${SEEDS[3]}u, vec2(sl / ${CELLS[3]}.0 + uVgOffN.w, d / ${CELLS[3]}.0));
  float v = (-sl * ${WS.toFixed(9)} + d * ${WC.toFixed(9)}) / ${VCELL}.0 + uVgOffV;
  float pn = 0.35 * vgVn(${SEEDS[4]}u, vec2(v, 0.5));
  float lc = d * ${WS.toFixed(9)} + warp;
  float c1 = vgCrest(uVgPh.x + (sl * ${WC.toFixed(9)} + lc) / ${LAM1}.0 + pn + 0.35 * (1.0 - amp)) * 9.0 * amp;
  float c2 = vgCrest(uVgPh.y + (sl * ${WC.toFixed(9)} + lc) / ${LAM2}.0 + pn * 0.5) * 1.5 * (0.5 + 0.5 * amp);
  float corr = 0.28 + 0.72 * smoothstep(22.0, 110.0, abs(d));
  return base + (c1 + c2) * corr * dune;
}
float vgHeight(vec2 L) {
  float h = vgRaw(L);
  for (int i = 0; i < 4; i++) {
    if (i >= uVgFlatN) break;
    vec4 f = uVgFlat[i];
    float dist = length(L - f.xy);
    if (dist < f.z) h = mix(h, f.w, smoothstep(f.z, f.z * 0.55, dist));
  }
  return h;
}`;

/** internals for the CPU/GPU parity test (tools/voyage_unit.ts) */
export const GROUND_INTERNALS = { vn, crest, SEEDS, CELLS, VCELL, LAM1, LAM2, WC, WS, BIOME_IN, BIOME_OUT };
