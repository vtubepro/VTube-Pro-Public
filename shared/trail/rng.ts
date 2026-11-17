// The Trail — seeded randomness (reproducible runs: same seed + same choices = same run).
// sfc32 (fast, 128-bit state, good statistical quality) seeded from a string hash; pure TS (studio, worker, Node).

/** 32-bit FNV-1a → then a MurmurHash3 finaliser, as a seed mixer for strings. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

export class Rng {
  private a: number; private b: number; private c: number; private d: number;
  constructor(seed: string | number) {
    const s = String(seed);
    this.a = hash32(s + '#a'); this.b = hash32(s + '#b'); this.c = hash32(s + '#c'); this.d = hash32(s + '#d') | 1;
    for (let i = 0; i < 12; i++) this.u32();
  }
  /** Uniform uint32. */
  u32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }
  /** [0, 1) */
  next(): number { return this.u32() / 4294967296; }
  range(lo: number, hi: number): number { return lo + (hi - lo) * this.next(); }
  int(lo: number, hiIncl: number): number { return lo + Math.floor(this.next() * (hiIncl - lo + 1)); }
  chance(p: number): boolean { return this.next() < p; }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length) % arr.length]; }
  /** Weighted pick (weights ≥ 0); -1 when all weights are 0. */
  weighted(ws: readonly number[]): number {
    let tot = 0;
    for (const w of ws) tot += Math.max(0, w);
    if (!(tot > 0)) return -1;
    let r = this.next() * tot;
    for (let i = 0; i < ws.length; i++) { r -= Math.max(0, ws[i]); if (r < 0) return i; }
    return ws.length - 1;
  }
  /** A child stream (independent sequence per purpose, so e.g. scenery never shifts the event dice). */
  fork(tag: string): Rng { return new Rng(`${this.u32()}:${tag}`); }
  /** Serialisable state (time_loop rewinds). */
  get state(): [number, number, number, number] { return [this.a, this.b, this.c, this.d]; }
  set state(s: [number, number, number, number]) { [this.a, this.b, this.c, this.d] = s; }
}

const WORDS = {
  bayou: ['RIVER', 'REED', 'FERN', 'MOSS', 'MUDDY', 'FOG', 'DAMP', 'NEON'],
  skyisles: ['FEATHER', 'HALO', 'CLOUD', 'WING', 'BERET', 'SKY', 'STAR', 'SERAPH'],
  frontier: ['TRAIL', 'OXEN', 'PRAIRIE', 'WAGON', 'RIVER', 'FORT', 'DUST', 'CANYON'],
} as Record<string, string[]>;

/** Human seed code for a theme: "SWAMP-4821". */
export function seedCode(theme: string, n = Math.floor(Math.random() * 1e9)): string {
  const w = WORDS[theme] ?? WORDS.frontier;
  return `${w[n % w.length]}-${String(Math.floor(n / w.length) % 10000).padStart(4, '0')}`;
}
/** Today's daily seed for a theme (local date). */
export function dailySeed(theme: string, d = new Date()): string {
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `DAILY-${iso}-${theme}`;
}
/** Clean a typed seed (letters, digits, dashes; ≤ 40). */
export function cleanSeed(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const t = s.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 40);
  return t.length >= 3 ? t : null;
}
