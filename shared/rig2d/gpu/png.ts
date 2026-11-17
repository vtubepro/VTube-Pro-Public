// PNG reader / writer for the texture tier builder (shared/rig2d/gpu/tiers.ts): pure TypeScript, no canvas, so it runs
// in the helper (Node), in a browser worker and on phones where a canvas can't hold an 8192 / 16384 picture (iOS caps
// a canvas at 16.7 M pixels). Rows come out one at a time (RGBA8, straight alpha, top row first): a caller that only
// needs a smaller copy never holds the whole picture. Every colour type and bit depth of the PNG spec is read; Adam7
// (interlaced) pictures are read whole first (rare for exported textures).
import { Unzlib, zlibSync } from 'three/examples/jsm/libs/fflate.module.js';
import { IMPORT_LIMITS } from '../limits.ts';

export interface PngHeader { w: number; h: number; depth: number; ctype: number; interlace: number }

const CH: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** The header and the chunks we need, without inflating anything. Throws a plain Error on a broken file. */
export function pngInfo(b: Uint8Array): PngHeader & { idat: [number, number][]; plte: Uint8Array | null; trns: Uint8Array | null } {
  if (b.length < 33 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) throw new Error('not a PNG picture');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 8;
  let hd: PngHeader | null = null, plte: Uint8Array | null = null, trns: Uint8Array | null = null;
  const idat: [number, number][] = [];
  while (p + 12 <= b.length) {
    const len = dv.getUint32(p, false), type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (p + 12 + len > b.length) throw new Error('the PNG picture is cut off');
    const s = p + 8;
    if (type === 'IHDR') hd = { w: dv.getUint32(s, false), h: dv.getUint32(s + 4, false), depth: b[s + 8], ctype: b[s + 9], interlace: b[s + 12] };
    else if (type === 'PLTE') plte = b.subarray(s, s + len);
    else if (type === 'tRNS') trns = b.subarray(s, s + len);
    else if (type === 'IDAT') idat.push([s, s + len]);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!hd || !hd.w || !hd.h || !idat.length || !CH[hd.ctype] || ![1, 2, 4, 8, 16].includes(hd.depth) || hd.interlace > 1) throw new Error('the PNG picture is damaged');
  // (settled from the header, before anything is inflated: shared/rig2d/limits.ts, the import's own rule)
  if (hd.w > IMPORT_LIMITS.textureSide || hd.h > IMPORT_LIMITS.textureSide) throw new Error(`the PNG picture is ${hd.w}×${hd.h} pixels: at most ${IMPORT_LIMITS.textureSide} on a side`);
  return { ...hd, idat, plte, trns };
}

/** Bytes the header promises the inflated image data to be (filter bytes included; Adam7: its seven passes). Nothing
 *  is ever inflated past this: a picture whose data inflates to more is refused (a zlib bomb), as the import's
 *  checkImage does (shared/rig2d/live2d/image.ts). */
export function pngRawSize(h: PngHeader): number {
  const bitsPP = CH[h.ctype] * h.depth;
  const passes = h.interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  let n = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((h.w - x0) / dx), ph = Math.ceil((h.h - y0) / dy);
    if (pw > 0 && ph > 0) n += ph * (1 + Math.ceil(pw * bitsPP / 8));
  }
  return n;
}
const BOMB = 'the PNG picture is damaged (its data unpacks to more than its size)';
/** fflate's streaming inflater fed in small input steps (one step can't unpack to more than ~16 MB), counting what comes
 *  out and stopping the moment it passes `max`. */
function inflateCapped(parts: Uint8Array[], max: number, onData: (d: Uint8Array) => void) {
  let n = 0;
  const u = new Unzlib((d: Uint8Array) => { n += d.length; if (n > max) throw new Error(BOMB); onData(d); });
  parts.forEach((p, k) => {
    for (let s = 0; s < p.length; s += 16384) u.push(p.subarray(s, Math.min(p.length, s + 16384)), k === parts.length - 1 && s + 16384 >= p.length);
    if (!p.length && k === parts.length - 1) u.push(new Uint8Array(0), true);
  });
}

/** A fast content fingerprint of a PNG without decoding it: the CRCs its encoder already wrote for every chunk (any
 *  change to the pixels changes an IDAT CRC), plus its size. Other files: a hash of every byte. */
export function pictureFingerprint(b: Uint8Array): string {
  let h1 = 0x811c9dc5 ^ b.length, h2 = 0x01000193 ^ (b.length >>> 3);
  const mix = (x: number) => { h1 = Math.imul(h1 ^ x, 0x01000193); h2 = Math.imul(h2 ^ (x >>> 7) ^ (h1 >>> 13), 0x5bd1e995); };
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let p = 8;
    while (p + 12 <= b.length) {
      const len = dv.getUint32(p, false);
      if (p + 12 + len > b.length) break;
      mix(len); mix(dv.getUint32(p + 4, false)); mix(dv.getUint32(p + 8 + len, false));
      p += 12 + len;
    }
  } else {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let i = 0;
    for (; i + 4 <= b.length; i += 4) mix(dv.getUint32(i, true));
    for (; i < b.length; i++) mix(b[i]);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0') + b.length.toString(16);
}

/** Read a PNG row by row. `onRow(y, rgba)` gets each row as straight-alpha RGBA8 (the array is reused: copy what you
 *  keep). `inflate` (optional) = a whole-buffer zlib inflater (Node's zlib is ~3× fflate) that must stop at `max` bytes
 *  (Node: { maxOutputLength: max }); without it the stream is inflated in small steps (bounded memory). Either way the
 *  data never unpacks past the size the header promises. */
export function readPngRows(b: Uint8Array, onRow: (y: number, rgba: Uint8Array) => void, inflate?: (z: Uint8Array, max: number) => Uint8Array): PngHeader {
  const info = pngInfo(b);
  const rawMax = pngRawSize(info);
  const inflateAll = (): Uint8Array => {
    if (inflate) {
      let r: Uint8Array;
      try { r = inflate(idatAll(), rawMax); } catch (e) { throw /too large|ERR_BUFFER_TOO_LARGE|maxOutputLength/i.test(String((e as { code?: string }).code ?? (e as Error).message)) ? new Error(BOMB) : e; }
      if (r.length > rawMax) throw new Error(BOMB);
      return r;
    }
    const chunks: Uint8Array[] = [];
    inflateCapped(info.idat.map(([a, e]) => b.subarray(a, e)), rawMax, (d) => chunks.push(d.slice()));
    const n = chunks.reduce((s, c) => s + c.length, 0), o = new Uint8Array(n);
    let k = 0;
    for (const c of chunks) { o.set(c, k); k += c.length; }
    return o;
  };
  const { w, h, depth, ctype, interlace } = info;
  const ch = CH[ctype], bitsPP = ch * depth, bpp = Math.max(1, bitsPP >> 3);
  const out = new Uint8Array(w * 4);
  // palette / transparency lookups
  const pal = new Uint8Array(256 * 4).fill(255);
  if (ctype === 3) {
    if (!info.plte) throw new Error('the PNG picture has no palette');
    for (let i = 0; i < info.plte.length / 3; i++) { pal[i * 4] = info.plte[i * 3]; pal[i * 4 + 1] = info.plte[i * 3 + 1]; pal[i * 4 + 2] = info.plte[i * 3 + 2]; }
    if (info.trns) for (let i = 0; i < info.trns.length; i++) pal[i * 4 + 3] = info.trns[i];
  }
  const tv = info.trns && ctype !== 3 ? Array.from({ length: info.trns.length >> 1 }, (_, i) => (info.trns![i * 2] << 8) | info.trns![i * 2 + 1]) : null;
  const max = (1 << depth) - 1;
  const expand = (row: Uint8Array, rw: number, put: (x: number, r: number, g: number, bl: number, a: number) => void) => {
    for (let x = 0; x < rw; x++) {
      let r: number, g: number, bl: number, a = 255;
      const sample = (c: number): number => {
        if (depth === 8) return row[x * ch + c];
        if (depth === 16) return row[(x * ch + c) * 2];
        const bit = (x * ch + c) * depth, v = (row[bit >> 3] >> (8 - depth - (bit & 7))) & max;
        return v;
      };
      const raw16 = (c: number) => (depth === 16 ? (row[(x * ch + c) * 2] << 8) | row[(x * ch + c) * 2 + 1] : sample(c));
      if (ctype === 3) { const i = sample(0) * 4; r = pal[i]; g = pal[i + 1]; bl = pal[i + 2]; a = pal[i + 3]; }
      else if (ctype === 0 || ctype === 4) {
        const v = depth < 8 ? Math.round(sample(0) * 255 / max) : sample(0);
        r = g = bl = v;
        if (ctype === 4) a = sample(1);
        else if (tv && raw16(0) === tv[0]) a = 0;
      } else {
        r = sample(0); g = sample(1); bl = sample(2);
        if (ctype === 6) a = sample(3);
        else if (tv && raw16(0) === tv[0] && raw16(1) === tv[1] && raw16(2) === tv[2]) a = 0;
      }
      put(x, r, g, bl, a);
    }
  };
  const unfilter = (ft: number, cur: Uint8Array, prev: Uint8Array) => {
    const n = cur.length;
    switch (ft) {
      case 0: break;
      case 1: for (let i = bpp; i < n; i++) cur[i] = (cur[i] + cur[i - bpp]) & 255; break;
      case 2: for (let i = 0; i < n; i++) cur[i] = (cur[i] + prev[i]) & 255; break;
      case 3: for (let i = 0; i < n; i++) cur[i] = (cur[i] + ((i >= bpp ? cur[i - bpp] : 0) + prev[i] >> 1)) & 255; break;
      case 4: for (let i = 0; i < n; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, bb = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + bb - c, pa = Math.abs(p - a), pb = Math.abs(p - bb), pc = Math.abs(p - c);
        cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? bb : c)) & 255;
      } break;
      default: throw new Error('the PNG picture is damaged (bad row filter)');
    }
  };
  const idatAll = () => {
    const tot = info.idat.reduce((s, [a, e]) => s + e - a, 0), z = new Uint8Array(tot);
    let o = 0;
    for (const [a, e] of info.idat) { z.set(b.subarray(a, e), o); o += e - a; }
    return z;
  };
  if (interlace) {
    // Adam7: inflate whole, then rebuild the full picture
    const raw = inflateAll();
    if (raw.length < rawMax) throw new Error('the PNG picture is cut off');
    const full = new Uint8Array(w * h * 4);
    const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
    let o = 0;
    for (const [x0, y0, dx, dy] of passes) {
      const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy);
      if (pw <= 0 || ph <= 0) continue;
      const rb = Math.ceil(pw * bitsPP / 8);
      let prev = new Uint8Array(rb);
      for (let y = 0; y < ph; y++) {
        const cur = raw.slice(o + 1, o + 1 + rb);
        unfilter(raw[o], cur, prev);
        o += 1 + rb;
        expand(cur, pw, (x, r, g, bl, a) => { const q = ((y0 + y * dy) * w + x0 + x * dx) * 4; full[q] = r; full[q + 1] = g; full[q + 2] = bl; full[q + 3] = a; });
        prev = cur;
      }
    }
    for (let y = 0; y < h; y++) onRow(y, full.subarray(y * w * 4, (y + 1) * w * 4));
    return info;
  }
  const rb = Math.ceil(w * bitsPP / 8), stride = rb + 1;
  let prev = new Uint8Array(rb), cur = new Uint8Array(rb), y = 0;
  const pending = new Uint8Array(stride);
  let pl = 0;
  const emitRow = (src: Uint8Array, at: number) => {
    cur.set(src.subarray(at + 1, at + stride));
    unfilter(src[at], cur, prev);
    // (fast paths: 8-bit RGBA / RGB, what painting programs and Live2D export)
    if (depth === 8 && ctype === 6) out.set(cur);
    else if (depth === 8 && ctype === 2 && !tv) for (let x = 0, i = 0, q = 0; x < w; x++, i += 3, q += 4) { out[q] = cur[i]; out[q + 1] = cur[i + 1]; out[q + 2] = cur[i + 2]; out[q + 3] = 255; }
    else expand(cur, w, (x, r, g, bl, a) => { const q = x * 4; out[q] = r; out[q + 1] = g; out[q + 2] = bl; out[q + 3] = a; });
    onRow(y++, out);
    const t = prev; prev = cur; cur = t;
  };
  const feed = (chunk: Uint8Array) => {
    let i = 0;
    if (pl) {
      const take = Math.min(stride - pl, chunk.length);
      pending.set(chunk.subarray(0, take), pl); pl += take; i = take;
      if (pl === stride) { if (y < h) emitRow(pending, 0); pl = 0; }
    }
    for (; i + stride <= chunk.length && y < h; i += stride) emitRow(chunk, i);
    if (i < chunk.length && y < h) { pending.set(chunk.subarray(i), 0); pl = chunk.length - i; }
  };
  if (inflate) feed(inflateAll());
  else inflateCapped(info.idat.map(([a, e]) => b.subarray(a, e)), rawMax, feed);
  if (y < h) throw new Error('the PNG picture is cut off');
  return info;
}

/** The whole picture, straight-alpha RGBA8. */
export function decodePng(b: Uint8Array, inflate?: (z: Uint8Array, max: number) => Uint8Array): { w: number; h: number; data: Uint8Array } {
  const { w, h } = pngInfo(b);
  const data = new Uint8Array(w * h * 4);
  readPngRows(b, (y, row) => data.set(row, y * w * 4), inflate);
  return { w, h, data };
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(parts: Uint8Array[]) { let c = -1; for (const b of parts) for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }

/** RGBA8 → PNG (filter: none for speed; `level` = zlib level, 1 = fast). `deflate` (optional) = Node's zlib. */
export function encodePng(rgba: Uint8Array, w: number, h: number, level = 1, deflate?: (raw: Uint8Array) => Uint8Array): Uint8Array {
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1); }
  const z = deflate ? deflate(raw) : zlibSync(raw, { level: level as 1 });
  const chunk = (type: string, data: Uint8Array) => {
    const t = new Uint8Array([...type].map((c) => c.charCodeAt(0)));
    const o = new Uint8Array(12 + data.length), dv = new DataView(o.buffer);
    dv.setUint32(0, data.length, false); o.set(t, 4); o.set(data, 8); dv.setUint32(8 + data.length, crc32([t, data]), false);
    return o;
  };
  const ih = new Uint8Array(13), dv = new DataView(ih.buffer);
  dv.setUint32(0, w, false); dv.setUint32(4, h, false); ih[8] = 8; ih[9] = 6;
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ih), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))];
  const o = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let k = 0;
  for (const p of parts) { o.set(p, k); k += p.length; }
  return o;
}
