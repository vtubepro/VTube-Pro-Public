// Reading values out of a PNGTuber save. The Godot-engine apps (PNGTuber Plus, PNGTuber Remix) write a "save" file either
// as JSON text or as a Godot binary "variant" (store_var). This reads the binary form from Godot's published
// binary-serialization description (type ids differ between Godot 3 and Godot 4; both are tried) and the small text
// forms Godot uses for vectors ("(12, -4)" / "Vector2( 12, -4 )"), plus base64 pictures. Pure, bounded, never throws past
// `readSave`: a damaged file becomes `null`.
//
// [unknown] No sample save was available when this was written: field NAMES live in layers.ts (`F`); the byte layout here follows
// the engine's description of its own serializer.

export type Json = null | boolean | number | string | Uint8Array | Json[] | { [k: string]: Json };

const MAX_NODES = 200_000;
const MAX_DEPTH = 24;

class Reader {
  o = 0; nodes = 0;
  constructor(readonly b: Uint8Array, readonly v4: boolean) { this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  readonly dv: DataView;
  need(n: number) { if (this.o + n > this.b.length || n < 0) throw new Error('short'); }
  u32() { this.need(4); const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  i32() { this.need(4); const v = this.dv.getInt32(this.o, true); this.o += 4; return v; }
  f32() { this.need(4); const v = this.dv.getFloat32(this.o, true); this.o += 4; return v; }
  f64() { this.need(8); const v = this.dv.getFloat64(this.o, true); this.o += 8; return v; }
  i64() { this.need(8); const v = Number(this.dv.getBigInt64(this.o, true)); this.o += 8; return v; }
  pad() { this.o = (this.o + 3) & ~3; }
  str(): string {
    const n = this.u32(); this.need(n);
    const s = new TextDecoder('utf-8').decode(this.b.subarray(this.o, this.o + n));
    this.o += n; this.pad();
    return s;
  }
  floats(n: number, dbl: boolean): number[] { const a: number[] = []; for (let i = 0; i < n; i++) a.push(dbl ? this.f64() : this.f32()); return a; }
}

// type ids (Godot 3 / Godot 4)
const G3 = { nil: 0, bool: 1, int: 2, real: 3, string: 4, v2: 5, rect2: 6, v3: 7, t2d: 8, plane: 9, quat: 10, aabb: 11, basis: 12, xform: 13, color: 14, dict: 18, array: 19, bytes: 20, ints: 21, reals: 22, strings: 23, v2s: 24, v3s: 25, colors: 26 };
const G4 = { nil: 0, bool: 1, int: 2, real: 3, string: 4, v2: 5, v2i: 6, rect2: 7, rect2i: 8, v3: 9, v3i: 10, t2d: 11, v4: 12, v4i: 13, plane: 14, quat: 15, aabb: 16, basis: 17, xform: 18, proj: 19, color: 20, sname: 21, dict: 27, array: 28, bytes: 29, i32s: 30, i64s: 31, f32s: 32, f64s: 33, strings: 34, v2s: 35, v3s: 36, colors: 37, v4s: 38 };

function value(r: Reader, depth: number): Json {
  if (depth > MAX_DEPTH || ++r.nodes > MAX_NODES) throw new Error('too deep');
  const head = r.u32(), t = head & 0xffff, flags = head >>> 16;
  const is64 = (flags & 1) !== 0;
  if (!r.v4) {
    switch (t) {
      case G3.nil: return null;
      case G3.bool: return r.u32() !== 0;
      case G3.int: return is64 ? r.i64() : r.i32();
      case G3.real: return is64 ? r.f64() : r.f32();
      case G3.string: return r.str();
      case G3.v2: return r.floats(2, is64);
      case G3.rect2: case G3.plane: case G3.quat: case G3.color: return r.floats(4, is64);
      case G3.v3: return r.floats(3, is64);
      case G3.t2d: return r.floats(6, is64);
      case G3.aabb: return r.floats(6, is64);
      case G3.basis: return r.floats(9, is64);
      case G3.xform: return r.floats(12, is64);
      case G3.dict: {
        const n = r.u32() & 0x7fffffff;
        if (n > 100_000) throw new Error('big');
        const o: { [k: string]: Json } = {};
        for (let i = 0; i < n; i++) { const k = value(r, depth + 1), v = value(r, depth + 1); o[typeof k === 'string' ? k : String(k)] = v; }
        return o;
      }
      case G3.array: {
        const n = r.u32() & 0x7fffffff;
        if (n > 1_000_000) throw new Error('big');
        const a: Json[] = [];
        for (let i = 0; i < n; i++) a.push(value(r, depth + 1));
        return a;
      }
      case G3.bytes: { const n = r.u32(); r.need(n); const a = r.b.slice(r.o, r.o + n); r.o += n; r.pad(); return a; }
      case G3.ints: { const n = r.u32(); r.need(n * 4); const a: number[] = []; for (let i = 0; i < n; i++) a.push(r.i32()); return a; }
      case G3.reals: { const n = r.u32(); r.need(n * 4); return r.floats(n, false); }
      case G3.strings: { const n = r.u32(); if (n > 100_000) throw new Error('big'); const a: string[] = []; for (let i = 0; i < n; i++) a.push(r.str()); return a; }
      case G3.v2s: { const n = r.u32(); r.need(n * 8); return Array.from({ length: n }, () => r.floats(2, false)); }
      case G3.v3s: { const n = r.u32(); r.need(n * 12); return Array.from({ length: n }, () => r.floats(3, false)); }
      case G3.colors: { const n = r.u32(); r.need(n * 16); return Array.from({ length: n }, () => r.floats(4, false)); }
    }
    throw new Error('type');
  }
  switch (t) {
    case G4.nil: return null;
    case G4.bool: return r.u32() !== 0;
    case G4.int: return is64 ? r.i64() : r.i32();
    case G4.real: return is64 ? r.f64() : r.f32();
    case G4.string: case G4.sname: return r.str();
    case G4.v2: return r.floats(2, is64);
    case G4.v2i: return [r.i32(), r.i32()];
    case G4.rect2: case G4.plane: case G4.quat: case G4.color: case G4.v4: return r.floats(4, is64);
    case G4.rect2i: case G4.v4i: return [r.i32(), r.i32(), r.i32(), r.i32()];
    case G4.v3: return r.floats(3, is64);
    case G4.v3i: return [r.i32(), r.i32(), r.i32()];
    case G4.t2d: return r.floats(6, is64);
    case G4.aabb: return r.floats(6, is64);
    case G4.basis: return r.floats(9, is64);
    case G4.xform: return r.floats(12, is64);
    case G4.proj: return r.floats(16, is64);
    case G4.dict: {
      const n = r.u32() & 0x7fffffff;
      if (n > 100_000) throw new Error('big');
      const o: { [k: string]: Json } = {};
      for (let i = 0; i < n; i++) { const k = value(r, depth + 1), v = value(r, depth + 1); o[typeof k === 'string' ? k : String(k)] = v; }
      return o;
    }
    case G4.array: {
      const n = r.u32() & 0x7fffffff;
      if (n > 1_000_000) throw new Error('big');
      const a: Json[] = [];
      for (let i = 0; i < n; i++) a.push(value(r, depth + 1));
      return a;
    }
    case G4.bytes: { const n = r.u32(); r.need(n); const a = r.b.slice(r.o, r.o + n); r.o += n; r.pad(); return a; }
    case G4.i32s: { const n = r.u32(); r.need(n * 4); const a: number[] = []; for (let i = 0; i < n; i++) a.push(r.i32()); return a; }
    case G4.i64s: { const n = r.u32(); r.need(n * 8); const a: number[] = []; for (let i = 0; i < n; i++) a.push(r.i64()); return a; }
    case G4.f32s: { const n = r.u32(); r.need(n * 4); return r.floats(n, false); }
    case G4.f64s: { const n = r.u32(); r.need(n * 8); return r.floats(n, true); }
    case G4.strings: { const n = r.u32(); if (n > 100_000) throw new Error('big'); const a: string[] = []; for (let i = 0; i < n; i++) a.push(r.str()); return a; }
    case G4.v2s: { const n = r.u32(); r.need(n * 8); return Array.from({ length: n }, () => r.floats(2, false)); }
    case G4.v3s: { const n = r.u32(); r.need(n * 12); return Array.from({ length: n }, () => r.floats(3, false)); }
    case G4.colors: case G4.v4s: { const n = r.u32(); r.need(n * 16); return Array.from({ length: n }, () => r.floats(4, false)); }
  }
  throw new Error('type');
}

/** Decode one Godot binary variant (tries the Godot 3 layout, then Godot 4). null = not one. */
export function readGodotVariant(b: Uint8Array): Json | null {
  for (const v4 of [false, true]) {
    try {
      const r = new Reader(b, v4);
      const v = value(r, 0);
      // a save is a dictionary (or a list of them); a list of plain numbers is the other layout misread
      if (r.o <= b.length && v && typeof v === 'object' && !(v instanceof Uint8Array) && (!Array.isArray(v) || v.some((x) => x && typeof x === 'object'))) return v;
    } catch { /* the other layout */ }
  }
  return null;
}

// ---------------------------------------------------------------- JSON text or binary
import { firstChar } from './detect.ts';
const head = (b: Uint8Array, n = 8) => { let s = ''; for (let i = 0; i < Math.min(n, b.length); i++) s += String.fromCharCode(b[i]); return s; };
/** A save's contents: JSON text (PNGTuber Plus) or a Godot binary variant (Remix). null = unreadable. */
export function readSave(b: Uint8Array): Json | null {
  const c = firstChar(b);
  if (c === '{' || c === '[') {
    try { return JSON.parse(new TextDecoder('utf-8').decode(b).replace(/^﻿/, '')) as Json; } catch { return null; }
  }
  // Godot text: store_line(to_json(...)) can add a trailing line or two; the binary form starts with a small type id
  if (head(b, 4).charCodeAt(0) < 40 && b.length >= 8) return readGodotVariant(b);
  return null;
}

// ---------------------------------------------------------------- small value readers
/** A vector as numbers: [x, y] / {x, y} / "(x, y)" / "Vector2( x, y )" / a single number (both axes). */
export function vec2(v: unknown, d: [number, number] = [0, 0]): [number, number] {
  if (Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number') return [v[0], v[1]];
  if (typeof v === 'number' && Number.isFinite(v)) return [v, v];
  if (typeof v === 'string') {
    const n = v.replace(/^\s*[A-Za-z_]\w*/, '').match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi);
    if (n && n.length >= 2) return [Number(n[0]), Number(n[1])];
    if (n && n.length === 1) return [Number(n[0]), Number(n[0])];
  }
  if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array)) {
    const o = v as Record<string, unknown>;
    if (typeof o.x === 'number' && typeof o.y === 'number') return [o.x, o.y];
  }
  return d;
}
export function num(v: unknown, d = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return d;
}

const B64 = new Uint8Array(256).fill(255);
'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('').forEach((c, i) => { B64[c.charCodeAt(0)] = i; });
B64['-'.charCodeAt(0)] = 62; B64['_'.charCodeAt(0)] = 63;
/** base64 (or a data: URI, URL-safe too) -> bytes. Null when it isn't base64. */
export function fromBase64(s: string): Uint8Array | null {
  const t = s.replace(/^data:[^,]*,/, '');
  const out = new Uint8Array(Math.floor((t.length * 3) / 4));
  let acc = 0, bits = 0, n = 0, seen = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 61 || c === 10 || c === 13 || c === 32 || c === 9) continue;
    const v = c < 256 ? B64[c] : 255;
    if (v === 255) return null;
    acc = (acc << 6) | v; bits += 6; seen++;
    if (bits >= 8) { bits -= 8; out[n++] = (acc >> bits) & 255; acc &= (1 << bits) - 1; }
  }
  return seen ? out.subarray(0, n) : null;
}
/** Bytes of a picture value: base64 text, a byte array, or a JSON array of byte values. */
export function bytesOf(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') return v.length >= 16 ? fromBase64(v) : null;
  if (Array.isArray(v) && v.length >= 16 && v.every((x) => typeof x === 'number' && x >= 0 && x < 256)) return Uint8Array.from(v as number[]);
  return null;
}
/** Lower-case a key and drop punctuation so imageData, image_data and "Image Data" are one name. */
export const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');
