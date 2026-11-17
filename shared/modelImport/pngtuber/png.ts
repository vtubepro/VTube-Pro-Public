// A small, dependency-free PNG reader / writer and a layer compositor, so a PNGTuber save (many layered pictures) can be
// flattened into the few pictures a VTube Pro PNGTuber set needs (idle / talk / blink / talk+blink) WITHOUT a canvas: the
// same code runs in the studio, in the helper and in tools/pngtuber_import_unit.ts. Written from the PNG specification
// (ISO/IEC 15948): chunks, the five scanline filters, colour types 0/2/3/4/6, bit depths 1..16, no interlace.
// zlib comes from fflate (shipped inside three.js, like shared/modelImport/files.ts).
import { Unzlib, zlibSync } from 'three/examples/jsm/libs/fflate.module.js';

/** Straight (non-premultiplied) RGBA8, row-major, top row first. */
export interface Raster { w: number; h: number; data: Uint8Array }

/** Most pixels one picture may have (a 4096 x 4096 art board). Bigger saves are refused with a sentence, not a crash. */
export const MAX_PIXELS = 4096 * 4096;

export const isPng = (b: Uint8Array) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a;

const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

/** Width and height from the header only (null = not a PNG). */
export function pngSize(b: Uint8Array): [number, number] | null {
  if (!isPng(b) || b.length < 24) return null;
  return [u32(b, 16), u32(b, 20)];
}

/** Inflate zlib data into about `limit` bytes at most (R3-10). The input goes in small slices (deflate cannot grow more than
 *  about 1032 times, so one slice makes at most ~8 MB), and the output is checked after each, so a crafted "zip bomb"
 *  picture stops at the first slice that passes the size the header promised instead of filling memory. Returns null when
 *  the data is not valid zlib or inflates past `limit`. */
export function inflateBounded(z: Uint8Array, limit: number): Uint8Array | null {
  if (!z.length) return null;
  const cap = limit + 1024; // (a little slack for a picture with a few trailing bytes; anything past it is a bomb)
  const out = new Uint8Array(cap);
  let n = 0, bad = false;
  const u = new Unzlib((chunk) => {
    if (bad) return;
    if (n + chunk.length > cap) { bad = true; return; }
    out.set(chunk, n); n += chunk.length;
  });
  try {
    for (let i = 0; i < z.length && !bad; i += 8192) u.push(z.subarray(i, Math.min(z.length, i + 8192)), i + 8192 >= z.length);
  } catch { return null; }
  return bad ? null : out.subarray(0, n);
}

/** Decode a PNG to RGBA8. Throws an Error with one plain sentence when it can't (interlaced, damaged, too big). */
export function decodePng(b: Uint8Array): Raster {
  if (!isPng(b)) throw new Error('not a PNG picture');
  let w = 0, h = 0, depth = 8, ctype = 6, interlace = 0;
  let plte: Uint8Array | null = null, trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let o = 8;
  while (o + 12 <= b.length) {
    const len = u32(b, o), type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    const d = b.subarray(o + 8, Math.min(b.length, o + 8 + len));
    if (type === 'IHDR') { w = u32(d, 0); h = u32(d, 4); depth = d[8]; ctype = d[9]; interlace = d[12]; }
    else if (type === 'PLTE') plte = d;
    else if (type === 'tRNS') trns = d;
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (!w || !h) throw new Error('a picture in the save is damaged');
  if (w * h > MAX_PIXELS) throw new Error('a picture in the save is bigger than 4096 x 4096');
  if (interlace) throw new Error('a picture in the save is interlaced, which VTube Pro can’t read');
  const chans = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ctype];
  if (!chans || ![1, 2, 4, 8, 16].includes(depth)) throw new Error('a picture in the save uses a PNG type VTube Pro can’t read');
  let total = 0;
  for (const c of idat) total += c.length;
  const z = new Uint8Array(total);
  let p = 0;
  for (const c of idat) { z.set(c, p); p += c.length; }
  const bpp = Math.max(1, (chans * depth) >> 3), stride = (w * chans * depth + 7) >> 3;
  // inflate no further than the header says the picture can be (a few bytes of slack for a trailing filler)
  const raw = inflateBounded(z, (stride + 1) * h);
  if (!raw) throw new Error('a picture in the save is damaged');
  if (raw.length < (stride + 1) * h) throw new Error('a picture in the save is cut off');
  // undo the scanline filters in place
  const px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0, bb = y ? px[up + x] : 0, c = x >= bpp && y ? px[up + x - bpp] : 0;
      const r = raw[src + x];
      let v: number;
      switch (f) {
        case 0: v = r; break;
        case 1: v = r + a; break;
        case 2: v = r + bb; break;
        case 3: v = r + ((a + bb) >> 1); break;
        case 4: { const pp = a + bb - c, pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - c); v = r + (pa <= pb && pa <= pc ? a : pb <= pc ? bb : c); break; }
        default: throw new Error('a picture in the save is damaged');
      }
      px[dst + x] = v & 255;
    }
  }
  const out = new Uint8Array(w * h * 4);
  const max = (1 << Math.min(depth, 8)) - 1;
  const sample = (y: number, i: number): number => { // i-th sample of row y (any depth), scaled to 0..255 (palette: the raw index)
    if (depth === 8) return px[y * stride + i];
    if (depth === 16) return px[y * stride + i * 2];
    const bit = i * depth, v = (px[y * stride + (bit >> 3)] >> (8 - depth - (bit & 7))) & max;
    return ctype === 3 ? v : Math.round((v * 255) / max);
  };
  const tr16 = trns && ctype === 0 && trns.length >= 2 ? (trns[0] << 8) | trns[1] : -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const q = (y * w + x) * 4;
      if (ctype === 6) { for (let k = 0; k < 4; k++) out[q + k] = sample(y, x * 4 + k); }
      else if (ctype === 2) {
        for (let k = 0; k < 3; k++) out[q + k] = sample(y, x * 3 + k);
        out[q + 3] = 255;
        if (trns && trns.length >= 6 && depth === 8 && out[q] === trns[1] && out[q + 1] === trns[3] && out[q + 2] === trns[5]) out[q + 3] = 0;
      } else if (ctype === 4) { const g = sample(y, x * 2); out[q] = out[q + 1] = out[q + 2] = g; out[q + 3] = sample(y, x * 2 + 1); }
      else if (ctype === 0) {
        const g = sample(y, x);
        out[q] = out[q + 1] = out[q + 2] = g; out[q + 3] = 255;
        if (tr16 >= 0 && depth === 8 && g === (tr16 & 255)) out[q + 3] = 0;
      } else {
        const i = sample(y, x);
        if (!plte || i * 3 + 2 >= plte.length) throw new Error('a picture in the save is damaged');
        out[q] = plte[i * 3]; out[q + 1] = plte[i * 3 + 1]; out[q + 2] = plte[i * 3 + 2];
        out[q + 3] = trns && i < trns.length ? trns[i] : 255;
      }
    }
  }
  return { w, h, data: out };
}

// ---------------------------------------------------------------- writing
let crcTable: Uint32Array | null = null;
function crc32(b: Uint8Array, from: number, to: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const put32 = (b: Uint8Array, o: number, v: number) => { b[o] = v >>> 24; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; };

/** Encode RGBA8 as a PNG (colour type 6, Sub filter: small for flat art, fast). */
export function encodePng(r: Raster): Uint8Array {
  const { w, h, data } = r, stride = w * 4;
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1);
    raw[o] = 1;
    for (let x = 0; x < stride; x++) raw[o + 1 + x] = (data[y * stride + x] - (x >= 4 ? data[y * stride + x - 4] : 0)) & 255;
  }
  const z = zlibSync(raw, { level: 6 });
  const out = new Uint8Array(8 + 25 + 12 + z.length + 12);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const chunk = (o: number, type: string, body: Uint8Array): number => {
    put32(out, o, body.length);
    for (let i = 0; i < 4; i++) out[o + 4 + i] = type.charCodeAt(i);
    out.set(body, o + 8);
    put32(out, o + 8 + body.length, crc32(out, o + 4, o + 8 + body.length));
    return o + 12 + body.length;
  };
  const ihdr = new Uint8Array(13);
  put32(ihdr, 0, w); put32(ihdr, 4, h); ihdr[8] = 8; ihdr[9] = 6;
  let o = chunk(8, 'IHDR', ihdr);
  o = chunk(o, 'IDAT', z);
  chunk(o, 'IEND', new Uint8Array(0));
  return out;
}

// ---------------------------------------------------------------- compositing
/** Affine map, source pixel (x, y) -> destination (a*x + c*y + e, b*x + d*y + f). */
export type Mat = [a: number, b: number, c: number, d: number, e: number, f: number];
export const IDENT: Mat = [1, 0, 0, 1, 0, 0];
/** parent * child (child applied first). */
export const mul = (p: Mat, c: Mat): Mat => [
  p[0] * c[0] + p[2] * c[1], p[1] * c[0] + p[3] * c[1],
  p[0] * c[2] + p[2] * c[3], p[1] * c[2] + p[3] * c[3],
  p[0] * c[4] + p[2] * c[5] + p[4], p[1] * c[4] + p[3] * c[5] + p[5],
];
export const apply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

export function blank(w: number, h: number): Raster { return { w, h, data: new Uint8Array(w * h * 4) }; }

/** Draw `src` over `dst` through `m` (alpha-over). A pure shift by whole pixels copies exactly (pixel art stays crisp);
 *  anything else is sampled bilinearly. */
export function drawOver(dst: Raster, src: Raster, m: Mat): void {
  const corners = [apply(m, 0, 0), apply(m, src.w, 0), apply(m, 0, src.h), apply(m, src.w, src.h)];
  const x0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0])))), x1 = Math.min(dst.w, Math.ceil(Math.max(...corners.map((c) => c[0]))));
  const y0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1])))), y1 = Math.min(dst.h, Math.ceil(Math.max(...corners.map((c) => c[1]))));
  if (x1 <= x0 || y1 <= y0) return;
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-9) return;
  const ia = m[3] / det, ib = -m[1] / det, ic = -m[2] / det, id = m[0] / det;
  const ie = -(ia * m[4] + ic * m[5]), iff = -(ib * m[4] + id * m[5]);
  const shift = Math.abs(m[0] - 1) < 1e-6 && Math.abs(m[3] - 1) < 1e-6 && Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6;
  const S = src.data, D = dst.data;
  const blend = (q: number, r: number, g: number, bl: number, a: number) => {
    if (a <= 0) return;
    const da = D[q + 3] / 255, sa = a / 255, oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    D[q] = Math.round((r * sa + D[q] * da * (1 - sa)) / oa);
    D[q + 1] = Math.round((g * sa + D[q + 1] * da * (1 - sa)) / oa);
    D[q + 2] = Math.round((bl * sa + D[q + 2] * da * (1 - sa)) / oa);
    D[q + 3] = Math.round(oa * 255);
  };
  const sx = Math.round(m[4]), sy = Math.round(m[5]);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const q = (y * dst.w + x) * 4;
      if (shift) {
        const u = x - sx, v = y - sy;
        if (u < 0 || v < 0 || u >= src.w || v >= src.h) continue;
        const s = (v * src.w + u) * 4;
        blend(q, S[s], S[s + 1], S[s + 2], S[s + 3]);
        continue;
      }
      const u = ia * (x + 0.5) + ic * (y + 0.5) + ie - 0.5, v = ib * (x + 0.5) + id * (y + 0.5) + iff - 0.5;
      if (u < -0.5 || v < -0.5 || u > src.w - 0.5 || v > src.h - 0.5) continue; // (outside the picture's own box)
      const iu = Math.floor(u), iv = Math.floor(v), fu = u - iu, fv = v - iv;
      let r = 0, g = 0, bl = 0, a = 0;
      for (let k = 0; k < 4; k++) {
        const xx = Math.min(src.w - 1, Math.max(0, iu + (k & 1))), yy = Math.min(src.h - 1, Math.max(0, iv + (k >> 1))); // (edges repeat, so the border stays solid)
        const wgt = (k & 1 ? fu : 1 - fu) * (k >> 1 ? fv : 1 - fv), s = (yy * src.w + xx) * 4, pa = S[s + 3] * wgt;
        r += S[s] * pa; g += S[s + 1] * pa; bl += S[s + 2] * pa; a += pa;
      }
      if (a > 0.5) blend(q, r / a, g / a, bl / a, a);
    }
  }
}

/** Crop a horizontal strip of `frames` equal frames to its first frame (an animated layer: one still is enough). */
export function firstFrame(r: Raster, frames: number): Raster {
  if (frames <= 1 || r.w < frames) return r;
  const fw = Math.floor(r.w / frames), out = blank(fw, r.h);
  for (let y = 0; y < r.h; y++) out.data.set(r.data.subarray(y * r.w * 4, (y * r.w + fw) * 4), y * fw * 4);
  return out;
}

/** True when any pixel is not fully transparent (an empty picture is not worth a file). */
export function hasInk(r: Raster): boolean {
  for (let i = 3; i < r.data.length; i += 4) if (r.data[i] > 8) return true;
  return false;
}
