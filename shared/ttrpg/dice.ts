// Dice notation + evaluation (system-agnostic): "d20+5", "2d20kh1+3" (advantage), "d20 adv +4", "4d6kh3", "8d6",
// "3d8+2d6-1", "d100" / "d%", "2d6+stat". Results come from an injected RNG: the host uses cryptoDie (unbiased, from
// crypto.getRandomValues); tests use a seeded sfc32. Every page then throws the dice with physics from the roll's
// seed and forces the faces to these values (src/ttrpg/dice), so what the audience sees IS the result.
import type { TtrpgDie } from './state.ts';

export interface DiceTerm { n: number; s: number; keep?: { hi: boolean; n: number }; sign: 1 | -1 }
export interface DiceExpr { terms: DiceTerm[]; mod: number; text: string }
export interface DiceResult { dice: TtrpgDie[]; mod: number; total: number; crit: 'hi' | 'lo' | null; detail: string }

const MAX_DICE = 40;
const SIDES = new Set([2, 3, 4, 6, 8, 10, 12, 20, 100]);

/** Parse dice notation. Throws Error with a readable message on bad input. `vars` resolves words like "str" / "dex". */
export function parseDice(input: string, vars: Record<string, number> = {}): DiceExpr {
  let src = String(input ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!src) throw new Error('Empty roll');
  let adv = 0;
  src = src.replace(/\b(adv|advantage)\b/g, () => { adv = 1; return ''; }).replace(/\b(dis|disadvantage)\b/g, () => { adv = -1; return ''; }).replace(/d%/g, 'd100');
  const terms: DiceTerm[] = [];
  let mod = 0;
  const re = /([+-]?)\s*(?:(\d{0,2})d(\d{1,3})(?:(kh|kl|k|dh|dl)(\d{1,2})?)?|(\d{1,4})|([a-z][a-z_]{0,15}))/gy;
  let pos = 0;
  src = src.replace(/\s/g, '');
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m || m[0] === '') throw new Error(`Can't read “${src.slice(pos, pos + 8)}” in the roll`);
    pos = re.lastIndex;
    const sign: 1 | -1 = m[1] === '-' ? -1 : 1;
    if (m[3]) {
      const n = m[2] ? parseInt(m[2], 10) : 1, s = parseInt(m[3], 10);
      if (!SIDES.has(s)) throw new Error(`No d${s} here: use d2, d3, d4, d6, d8, d10, d12, d20 or d100`);
      if (n < 1 || n > MAX_DICE) throw new Error(`1–${MAX_DICE} dice per group`);
      let keep: DiceTerm['keep'];
      if (m[4]) {
        const k = m[5] ? parseInt(m[5], 10) : 1;
        if (m[4] === 'kh' || m[4] === 'k') keep = { hi: true, n: k };
        else if (m[4] === 'kl') keep = { hi: false, n: k };
        else if (m[4] === 'dh') keep = { hi: false, n: n - k };
        else keep = { hi: true, n: n - k };
        if (keep.n < 1 || keep.n > n) throw new Error('Keep count out of range');
      }
      terms.push({ n, s, keep, sign });
    } else if (m[6]) mod += sign * parseInt(m[6], 10);
    else if (m[7]) {
      if (!(m[7] in vars)) throw new Error(`Unknown “${m[7]}” (try a number)`);
      mod += sign * Math.round(vars[m[7]]);
    }
  }
  if (!terms.length) throw new Error('No dice in the roll (e.g. d20+3)');
  if (terms.reduce((a, t) => a + t.n, 0) > MAX_DICE) throw new Error(`At most ${MAX_DICE} dice`);
  if (adv) {
    const t = terms.find((x) => x.s === 20 && x.n === 1 && !x.keep);
    if (!t) throw new Error('Advantage / disadvantage needs a single d20');
    t.n = 2; t.keep = { hi: adv > 0, n: 1 };
  }
  return { terms, mod, text: formatDice({ terms, mod, text: '' }) };
}

export function formatDice(e: DiceExpr): string {
  let out = '';
  for (const t of e.terms) {
    const k = t.keep ? (t.keep.n === 1 && t.n === 2 && t.s === 20 ? (t.keep.hi ? ' adv' : ' dis') : `${t.keep.hi ? 'kh' : 'kl'}${t.keep.n}`) : '';
    const core = k === ' adv' || k === ' dis' ? `d20` : `${t.n}d${t.s}${k}`;
    out += (out ? (t.sign < 0 ? '-' : '+') : t.sign < 0 ? '-' : '') + core + (k === ' adv' || k === ' dis' ? k : '');
  }
  if (e.mod) out += (e.mod > 0 ? '+' : '') + e.mod;
  return out;
}

/** Unbiased 1..s from crypto.getRandomValues (browser + Node 20+). */
export function cryptoDie(s: number): number {
  const lim = Math.floor(0x100000000 / s) * s;
  const buf = new Uint32Array(1);
  for (;;) { globalThis.crypto.getRandomValues(buf); if (buf[0] < lim) return (buf[0] % s) + 1; }
}
export function cryptoSeed(): number { const b = new Uint32Array(1); globalThis.crypto.getRandomValues(b); return b[0] >>> 0; }

export function evalDice(e: DiceExpr, die: (s: number) => number = cryptoDie): DiceResult {
  const dice: TtrpgDie[] = [];
  let total = e.mod;
  let crit: DiceResult['crit'] = null;
  const parts: string[] = [];
  for (const t of e.terms) {
    const vals = Array.from({ length: t.n }, () => die(t.s));
    let kept = vals.map(() => true);
    if (t.keep) {
      const order = vals.map((v, i) => [v, i] as const).sort((a, b) => (t.keep!.hi ? b[0] - a[0] : a[0] - b[0]) || a[1] - b[1]);
      kept = vals.map(() => false);
      for (const [, i] of order.slice(0, t.keep.n)) kept[i] = true;
    }
    let sum = 0;
    vals.forEach((v, i) => { dice.push({ s: t.s, v, ...(kept[i] ? {} : { k: false }) }); if (kept[i]) sum += v; });
    total += t.sign * sum;
    parts.push(`${t.sign < 0 ? '−' : ''}[${vals.map((v, i) => (kept[i] ? `${v}` : `~${v}~`)).join(', ')}]`);
    // natural 20 / 1 on a single (kept) d20
    if (t.s === 20 && (t.keep ? t.keep.n === 1 : t.n === 1) && e.terms.filter((x) => x.s === 20).length === 1) {
      const nat = vals.find((_, i) => kept[i])!;
      crit = nat === 20 ? 'hi' : nat === 1 ? 'lo' : null;
    }
  }
  return { dice, mod: e.mod, total, crit, detail: `${parts.join(' + ')}${e.mod ? ` ${e.mod > 0 ? '+' : '−'} ${Math.abs(e.mod)}` : ''} = ${total}` };
}

/** Roll with fixed die values (replaying / tests). */
export function evalWith(e: DiceExpr, values: number[]): DiceResult {
  let i = 0;
  return evalDice(e, (s) => { const v = values[i++]; return Number.isInteger(v) && v >= 1 && v <= s ? v : 1; });
}

// ---------------------------------------------------------------- deterministic RNG (maps, throws, tests)
export function hash32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
/** sfc32: small, fast, good enough; identical in every JS engine. */
export function sfc32(seed: number): () => number {
  let a = 0x9e3779b9, b = 0x243f6a88, c = 0xb7e15162, d = seed >>> 0;
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0; t = (t + d) | 0; c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) next();
  return next;
}
