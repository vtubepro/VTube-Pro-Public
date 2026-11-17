// Is a texture really a picture the runtime can show? A header alone isn't proof: a texture cut off after 24 bytes, or
// a saved error page renamed .png, passed the old size check and only failed later, on stream. This checks each
// format's whole structure with bounded memory (nothing is decoded into pixels):
//   PNG   every chunk inside the file with a correct CRC, IHDR first, IEND present, and the IDAT stream inflates (in
//         small steps, output counted and thrown away) to exactly the size the header promises, with valid row filters;
//   JPEG  the markers up to the scan are well formed, a frame header gives the size, and the image ends with EOI;
//   WebP  the RIFF size matches the file and the image chunk (VP8 / VP8L, or inside VP8X) lies within it.
// Pure (fflate); used by the converter (shared/rig2d/live2d/convert.ts). Tests: tools/live2d_chaos_unit.ts.
import { Unzlib } from 'three/examples/jsm/libs/fflate.module.js';
import { IMPORT_LIMITS } from '../limits.ts';

export interface ImageInfo { w: number; h: number; fmt: 'png' | 'jpg' | 'webp' }
/** too-big: the header asks for a side over IMPORT_LIMITS.textureSide (checked from the header, before any inflating) */
export type ImageCheck = ImageInfo | { error: 'not-a-picture' | 'damaged' } | { error: 'too-big'; w: number; h: number };
const tooBig = (w: number, h: number) => w > IMPORT_LIMITS.textureSide || h > IMPORT_LIMITS.textureSide;

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(b: Uint8Array, s: number, e: number) { let c = -1; for (let i = s; i < e; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }

function checkPng(b: Uint8Array): ImageCheck {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0, sawIhdr = false, sawEnd = false;
  const idat: [number, number][] = [];
  while (p + 12 <= b.length) {
    const len = dv.getUint32(p, false), type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (len > 0x7fffffff || p + 12 + len > b.length) return { error: 'damaged' };
    if (crc32(b, p + 4, p + 8 + len) !== dv.getUint32(p + 8 + len, false)) return { error: 'damaged' };
    if (!sawIhdr && type !== 'IHDR') return { error: 'damaged' };
    if (type === 'IHDR') {
      if (len !== 13) return { error: 'damaged' };
      w = dv.getUint32(p + 8, false); h = dv.getUint32(p + 12, false); depth = b[p + 16]; ctype = b[p + 17]; interlace = b[p + 20]; sawIhdr = true;
      // the size is settled right here, before anything is inflated (an absurd header would inflate for minutes)
      if (!w || !h) return { error: 'damaged' };
      if (tooBig(w, h)) return { error: 'too-big', w, h };
    } else if (type === 'IDAT') idat.push([p + 8, p + 8 + len]);
    else if (type === 'IEND') { sawEnd = true; break; }
    p += 12 + len;
  }
  if (!sawIhdr || !sawEnd || !idat.length || !w || !h) return { error: 'damaged' };
  const ch = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ctype];
  if (!ch || ![1, 2, 4, 8, 16].includes(depth) || interlace > 1) return { error: 'damaged' };
  const bpp = ch * depth;
  // the inflated size the header promises (Adam7: the seven passes' rows)
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  let want = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy);
    if (pw > 0 && ph > 0) want += ph * (1 + Math.ceil(pw * bpp / 8));
  }
  // (at most textureSide² pixels of 16-bit RGBA: anything more is not a picture we take)
  if (want > (IMPORT_LIMITS.textureSide + 1) * (IMPORT_LIMITS.textureSide * 8 + 1)) return { error: 'damaged' };
  const stride = 1 + Math.ceil(w * bpp / 8);
  let n = 0, bad = false;
  const inf = new Unzlib((chunk: Uint8Array) => {
    if (bad) return;
    if (n + chunk.length > want) { bad = true; return; }
    // row filter bytes (0..4) at the start of every row (plain images)
    if (!interlace) for (let r = Math.ceil(n / stride) * stride; r < n + chunk.length; r += stride) if (chunk[r - n] > 4) { bad = true; return; }
    n += chunk.length;
  });
  try {
    for (let k = 0; k < idat.length && !bad; k++) {
      const [s, e] = idat[k];
      for (let q = s; q < e && !bad; q += 16384) inf.push(b.subarray(q, Math.min(e, q + 16384)), k === idat.length - 1 && q + 16384 >= e);
    }
  } catch { return { error: 'damaged' }; }
  if (bad || n !== want) return { error: 'damaged' };
  return { w, h, fmt: 'png' };
}

function checkJpeg(b: Uint8Array): ImageCheck {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 2, w = 0, h = 0, sos = -1;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return { error: 'damaged' };
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (m === 0xd9) return { error: 'damaged' };            // the end before any scan
    const len = dv.getUint16(i + 2, false);
    if (len < 2 || i + 2 + len > b.length) return { error: 'damaged' };
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { if (len < 8) return { error: 'damaged' }; h = dv.getUint16(i + 5, false); w = dv.getUint16(i + 7, false); if (tooBig(w, h)) return { error: 'too-big', w, h }; }
    if (m === 0xda) { sos = i + 2 + len; break; }
    i += 2 + len;
  }
  if (sos < 0 || !w || !h) return { error: 'damaged' };
  // the image must end (EOI) after its scan data: a cut-off download doesn't (a few trailing bytes are allowed)
  let eoi = false;
  for (let j = b.length - 2; j >= Math.max(sos, b.length - 4096); j--) if (b[j] === 0xff && b[j + 1] === 0xd9) { eoi = true; break; }
  return eoi ? { w, h, fmt: 'jpg' } : { error: 'damaged' };
}

function checkWebp(b: Uint8Array): ImageCheck {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const riff = dv.getUint32(4, true) + 8;
  if (riff > b.length || riff < 20) return { error: 'damaged' };
  let p = 12, w = 0, h = 0, image = false;
  while (p + 8 <= riff) {
    const c = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]), len = dv.getUint32(p + 4, true), d = p + 8;
    if (d + len > riff) return { error: 'damaged' };
    if (c === 'VP8X' && len >= 10) { w = 1 + (b[d + 4] | b[d + 5] << 8 | b[d + 6] << 16); h = 1 + (b[d + 7] | b[d + 8] << 8 | b[d + 9] << 16); if (tooBig(w, h)) return { error: 'too-big', w, h }; }
    else if (c === 'VP8 ' && len >= 10) { if (!w) { w = dv.getUint16(d + 6, true) & 0x3fff; h = dv.getUint16(d + 8, true) & 0x3fff; } image = true; }
    else if (c === 'VP8L' && len >= 5) { if (!w) { const v = dv.getUint32(d + 1, true); w = 1 + (v & 0x3fff); h = 1 + ((v >> 14) & 0x3fff); } image = true; }
    p = d + len + (len & 1);
  }
  if (image && w && h && tooBig(w, h)) return { error: 'too-big', w, h };
  return image && w && h ? { w, h, fmt: 'webp' } : { error: 'damaged' };
}

/** The texture's size and format when it is a whole PNG / JPEG / WebP picture; else why not. Bounded memory. */
export function checkImage(b: Uint8Array): ImageCheck {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return checkPng(b);
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return checkJpeg(b);
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return checkWebp(b);
  return { error: 'not-a-picture' };
}
