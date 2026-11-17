// Decodes the tiny test picture obs-websocket's GetSourceScreenshot returns (a data URI) into RGBA, only to ask "is it all
// black?" (shared/gamingCapture.ts lumaStat). Asked for 32×18 pixels, so this is a few KB. PNG (8-bit, not interlaced),
// BMP (24/32-bit) and PPM are understood; anything else (JPEG …) answers null, and the caller then judges by size alone.
import zlib from 'node:zlib';

export interface Rgba { w: number; h: number; data: Uint8Array }

function decodePng(b: Buffer): Rgba | null {
  if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47) return null;
  let off = 8, w = 0, h = 0, depth = 0, ctype = -1, inter = 0;
  const idat: Buffer[] = [];
  let plte: Buffer | null = null;
  while (off + 12 <= b.length) {
    const len = b.readUInt32BE(off), type = b.toString('latin1', off + 4, off + 8), body = b.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]; ctype = body[9]; inter = body[12]; }
    else if (type === 'PLTE') plte = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!w || !h || w > 512 || h > 512 || depth !== 8 || inter !== 0 || !idat.length) return null;
  const ch = ctype === 0 ? 1 : ctype === 2 ? 3 : ctype === 3 ? 1 : ctype === 4 ? 2 : ctype === 6 ? 4 : 0;
  if (!ch || (ctype === 3 && !plte)) return null;
  let raw: Buffer;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const stride = w * ch;
  if (raw.length < (stride + 1) * h) return null;
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), cur = px.subarray(y * stride, (y + 1) * stride), prev = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, up = prev ? prev[x] : 0, c = prev && x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      else if (f !== 0) return null;
      cur[x] = v & 255;
    }
  }
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    let r: number, g: number, bl: number, a = 255;
    if (ctype === 0) { r = g = bl = px[i]; }
    else if (ctype === 2) { r = px[i * 3]; g = px[i * 3 + 1]; bl = px[i * 3 + 2]; }
    else if (ctype === 3) { const k = px[i] * 3; r = plte![k] ?? 0; g = plte![k + 1] ?? 0; bl = plte![k + 2] ?? 0; }
    else if (ctype === 4) { r = g = bl = px[i * 2]; a = px[i * 2 + 1]; }
    else { r = px[i * 4]; g = px[i * 4 + 1]; bl = px[i * 4 + 2]; a = px[i * 4 + 3]; }
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = bl; out[i * 4 + 3] = a;
  }
  return { w, h, data: out };
}

function decodeBmp(b: Buffer): Rgba | null {
  if (b.length < 54 || b[0] !== 0x42 || b[1] !== 0x4d) return null;
  const dataOff = b.readUInt32LE(10), w = b.readInt32LE(18), hRaw = b.readInt32LE(22), bpp = b.readUInt16LE(28), comp = b.readUInt32LE(30);
  const h = Math.abs(hRaw);
  if (!w || !h || w > 512 || h > 512 || (bpp !== 24 && bpp !== 32) || (comp !== 0 && comp !== 3)) return null;
  const bytes = bpp / 8, stride = Math.ceil((w * bytes) / 4) * 4;
  if (b.length < dataOff + stride * h) return null;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = hRaw > 0 ? h - 1 - y : y;
    for (let x = 0; x < w; x++) {
      const s = dataOff + sy * stride + x * bytes, o = (y * w + x) * 4;
      out[o] = b[s + 2]; out[o + 1] = b[s + 1]; out[o + 2] = b[s]; out[o + 3] = 255;
    }
  }
  return { w, h, data: out };
}

function decodePpm(b: Buffer): Rgba | null {
  if (b.length < 11 || b.toString('latin1', 0, 2) !== 'P6') return null;
  const head = b.toString('latin1', 0, Math.min(b.length, 64)).replace(/#[^\n]*\n/g, ' ');
  const m = /^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(head);
  if (!m) return null;
  const w = +m[1], h = +m[2];
  if (!w || !h || w > 512 || h > 512 || +m[3] !== 255) return null;
  const start = b.length - w * h * 3;
  if (start < m[0].length) return null;
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { out[i * 4] = b[start + i * 3]; out[i * 4 + 1] = b[start + i * 3 + 1]; out[i * 4 + 2] = b[start + i * 3 + 2]; out[i * 4 + 3] = 255; }
  return { w, h, data: out };
}

/** A GetSourceScreenshot imageData (“data:image/png;base64,…”) → RGBA, or null when it can't be read here. */
export function decodeShot(dataUri: unknown): Rgba | null {
  if (typeof dataUri !== 'string') return null;
  const m = /^data:image\/[\w.+-]+;base64,(.+)$/s.exec(dataUri);
  if (!m || m[1].length > 400_000) return null;
  try {
    const b = Buffer.from(m[1], 'base64');
    return decodePng(b) ?? decodeBmp(b) ?? decodePpm(b);
  } catch { return null; }
}
