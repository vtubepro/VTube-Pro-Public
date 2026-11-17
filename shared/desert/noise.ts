// Desert noise primitives (pure, shared by the CPU height function and its GLSL twin in src/scene/desert/glsl.ts).
// Integer-hash value noise on a 4096-cell lattice wrap: the same 32-bit maths in JS (Math.imul) and GLSL (uint), so
// the CPU and the GPU agree bit-for-bit on every lattice value and to float32 rounding on the interpolation.
// Every value is a pure function of its inputs: no state, no Math.random, identical in every JS engine.

export const WRAP = 4095;
export const LATTICE = 4096;
/** fbm octave step (frequency multiplier and lattice offsets per octave) and the per-octave seed stride. */
export const OCT_MUL = 2.03;
export const OCT_ADD_X = 11.7;
export const OCT_ADD_Z = 5.3;
export const OCT_SEED = 1013;

/** Lattice hash of integer cell (xi, zi) -> [0, 1). */
export function h2(seed: number, xi: number, zi: number): number {
  let h = (seed ^ Math.imul(xi & WRAP, 0x27d4eb2d) ^ Math.imul(zi & WRAP, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth (C1) value noise in [0, 1). */
export function vnoise(seed: number, x: number, z: number): number {
  const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = h2(seed, xi, zi), b = h2(seed, xi + 1, zi), c = h2(seed, xi, zi + 1), d = h2(seed, xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** fbm in [-1, 1] on absolute lattice coordinates (x, z already divided by the feature scale). */
export function fbm(seed: number, x: number, z: number, oct: number): number {
  let s = 0, a = 0.5, n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * (vnoise(seed + i * OCT_SEED, x, z) * 2 - 1); n += a; a *= 0.5;
    x = x * OCT_MUL + OCT_ADD_X; z = z * OCT_MUL + OCT_ADD_Z;
  }
  return s / n;
}

/** fbm with per-octave lattice offsets (the GPU form): octave i samples off[2(base+i)] + lx * 2.03^i. */
export function fbmOff(seed: number, off: ArrayLike<number>, base: number, lx: number, lz: number, oct: number): number {
  let s = 0, a = 0.5, n = 0, m = 1;
  for (let i = 0; i < oct; i++) {
    const k = 2 * (base + i);
    s += a * (vnoise(seed + i * OCT_SEED, off[k] + lx * m, off[k + 1] + lz * m) * 2 - 1); n += a; a *= 0.5; m *= OCT_MUL;
  }
  return s / n;
}

/** Positive modulo. */
export const mod = (a: number, n: number) => ((a % n) + n) % n;
export const fract = (x: number) => x - Math.floor(x);
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const sstep = (e0: number, e1: number, x: number) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/** 32-bit integer hash of up to four ints -> uint32 (feature placement, cell / leg seeds). */
export function hash32(a: number, b = 0, c = 0, d = 0): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35);
  h ^= Math.imul((c | 0) + 0x27d4eb2f, 0x165667b1) ^ Math.imul((d | 0) + 0x7f4a7c15, 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h = Math.imul(h ^ (h >>> 12), 0x297a2d39); h ^= h >>> 15;
  return h >>> 0;
}
/** hash32 -> [0, 1). */
export const rnd = (a: number, b = 0, c = 0, d = 0) => hash32(a, b, c, d) / 4294967296;

/** FNV-1a style digest over numbers rounded to a precision (tests, determinism checks). */
export function digest(vals: ArrayLike<number>, scale = 1000): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < vals.length; i++) {
    const v = Math.round(vals[i] * scale) | 0;
    h = Math.imul(h ^ (v & 0xffff), 0x01000193) >>> 0;
    h = Math.imul(h ^ ((v >>> 16) & 0xffff), 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
