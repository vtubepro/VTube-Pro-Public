// Forgiving JSON for Live2D side files (model3 / physics3 / motion3 / exp3 / pose3 / cdi3 / VTube Studio's vtube.json).
// Hand-edited and tool-written files in the wild carry a UTF-8 BOM (or are UTF-16), // and /* */ comments and trailing
// commas, and numbers written as strings ("Value": "1"). Strict JSON first; only on failure the text is cleaned (outside
// strings) and parsed again. Prototype keys (__proto__ / constructor / prototype) are dropped. Never throws: null when it
// still isn't JSON.

const POISON = new Set(['__proto__', 'constructor', 'prototype']);

/** Bytes → text: UTF-8 (BOM stripped), or UTF-16 LE / BE with a BOM. */
export function jsonText(b: Uint8Array): string {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  return new TextDecoder('utf-8').decode(b).replace(/^﻿/, '');
}

/** Remove comments and trailing commas outside strings. */
export function stripJsonNoise(s: string): string {
  let out = '', i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '/' && s[i + 1] === '/') { while (i < n && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < n && /\s/.test(s[j])) j++;
      if (s[j] === '}' || s[j] === ']') { i++; continue; }
    }
    out += c; i++;
  }
  return out;
}

const reviver = (k: string, v: unknown) => (POISON.has(k) ? undefined : v);

/** Parse forgiving JSON from bytes or text; null when it isn't JSON. */
export function parseLooseJson(input: Uint8Array | string): unknown {
  const s = typeof input === 'string' ? input.replace(/^﻿/, '') : jsonText(input);
  try { return JSON.parse(s, reviver); } catch { /* try the cleaned text */ }
  try { return JSON.parse(stripJsonNoise(s), reviver); } catch { return null; }
}

/** A finite number from a number or a numeric string ("1", " -0.5 "); `d` otherwise. */
export function looseNum(v: unknown, d = 0): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : d;
  if (typeof v === 'string' && v.trim() !== '' && v.length < 40) { const x = Number(v.trim()); return Number.isFinite(x) ? x : d; }
  return d;
}

/** true / "true" / 1. */
export const looseBool = (v: unknown) => v === true || v === 1 || (typeof v === 'string' && /^(true|1|yes)$/i.test(v.trim()));
