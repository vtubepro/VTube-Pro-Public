// Deterministic helpers for the raid simulation: every page (studio preview, OBS, party guests) must draw the SAME
// random numbers in the SAME order from the same seed, so only integer math here (no Math.random, no Date).

/** 32-bit FNV-1a over the parts' string forms. */
export function hash32(...parts: (number | string)[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    const s = typeof p === 'number' ? (Number.isInteger(p) ? String(p) : p.toFixed(6)) : p;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    h ^= 0x7c; h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: fast, good enough, identical in every JS engine. */
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0 || 0x9e3779b9; }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number) { return a + (b - a) * this.next(); }
  int(n: number) { return Math.floor(this.next() * n) % Math.max(1, n); }
  pick<T>(a: readonly T[]): T { return a[this.int(a.length)]; }
  chance(p: number) { return this.next() < p; }
}
