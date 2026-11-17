// Pixel operations of the texture tier builder (shared/rig2d/gpu/tiers.ts). Pictures are RGBA8 with PREMULTIPLIED
// alpha in the art's own (gamma, sRGB-encoded) values: the 2D renderer blends exactly that way (renderer.ts), so a
// smaller copy averaged here looks like the full one drawn small. Premultiplied averaging is what keeps edges clean:
// a transparent texel adds nothing, so no dark (or light) fringe creeps in around hair, lashes and soft alpha.
// Downscaling is an exact 2×2 area average (box): it is the right filter for line art (no ringing halos around ink,
// unlike Lanczos), and with power-of-two tiers / mip levels it is exact area averaging.

export interface Img { w: number; h: number; data: Uint8Array }

/** Straight → premultiplied, in place (rounded). */
export function premultiply(d: Uint8Array): Uint8Array {
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 255) continue;
    if (a === 0) { d[i] = d[i + 1] = d[i + 2] = 0; continue; }
    d[i] = (d[i] * a + 127) / 255 | 0; d[i + 1] = (d[i + 1] * a + 127) / 255 | 0; d[i + 2] = (d[i + 2] * a + 127) / 255 | 0;
  }
  return d;
}

/** Premultiplied → straight, in place (for PNG files and for comparisons against the source). */
export function unpremultiply(d: Uint8Array): Uint8Array {
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 255 || a === 0) continue;
    d[i] = Math.min(255, (d[i] * 255 + (a >> 1)) / a | 0); d[i + 1] = Math.min(255, (d[i + 1] * 255 + (a >> 1)) / a | 0); d[i + 2] = Math.min(255, (d[i + 2] * 255 + (a >> 1)) / a | 0);
  }
  return d;
}

/** Half size (ceil), exact 2×2 area average of a premultiplied picture; an odd last row / column averages what exists
 *  (the picture's edge is not padded with transparent pixels, so a page's border never darkens). */
export function half(s: Img): Img {
  const w = Math.max(1, (s.w + 1) >> 1), h = Math.max(1, (s.h + 1) >> 1), d = new Uint8Array(w * h * 4), sd = s.data, sw = s.w;
  for (let y = 0; y < h; y++) {
    const y0 = y * 2, y1 = Math.min(s.h - 1, y0 + 1);
    for (let x = 0; x < w; x++) {
      const x0 = x * 2, x1 = Math.min(s.w - 1, x0 + 1);
      const a = (y0 * sw + x0) * 4, b = (y0 * sw + x1) * 4, c = (y1 * sw + x0) * 4, e = (y1 * sw + x1) * 4, o = (y * w + x) * 4;
      d[o] = (sd[a] + sd[b] + sd[c] + sd[e] + 2) >> 2;
      d[o + 1] = (sd[a + 1] + sd[b + 1] + sd[c + 1] + sd[e + 1] + 2) >> 2;
      d[o + 2] = (sd[a + 2] + sd[b + 2] + sd[c + 2] + sd[e + 2] + 2) >> 2;
      d[o + 3] = (sd[a + 3] + sd[b + 3] + sd[c + 3] + sd[e + 3] + 2) >> 2;
    }
  }
  return { w, h, data: d };
}

/** One mip level down: size max(1, floor(n / 2)) as GPUs and KTX2 define it (not half()'s rounding up), each texel the
 *  exact area average of its footprint (2 × 2 texels for even sizes; for an odd size the footprint is 2 + 1/n texels,
 *  partial texels weighted by their covered fraction). */
export function mipDown(s: Img): Img {
  const w = Math.max(1, s.w >> 1), h = Math.max(1, s.h >> 1);
  if (s.w === w * 2 && s.h === h * 2) return half(s);
  // separable area resampling (premultiplied, so alpha stays fringe-free)
  const span = (n: number, m: number) => Array.from({ length: m }, (_, i) => {
    const a = i * n / m, b = (i + 1) * n / m, taps: [number, number][] = [];
    for (let k = Math.floor(a); k < Math.ceil(b) && k < n; k++) taps.push([k, Math.min(b, k + 1) - Math.max(a, k)]);
    const t = taps.reduce((x, y) => x + y[1], 0);
    return taps.map(([k, wt]) => [k, wt / t] as [number, number]);
  });
  const sx = span(s.w, w), sy = span(s.h, h), tmp = new Float32Array(w * s.h * 4), d = new Uint8Array(w * h * 4);
  for (let y = 0; y < s.h; y++) for (let x = 0; x < w; x++) for (const [k, wt] of sx[x]) { const i = (y * s.w + k) * 4, o = (y * w + x) * 4; tmp[o] += s.data[i] * wt; tmp[o + 1] += s.data[i + 1] * wt; tmp[o + 2] += s.data[i + 2] * wt; tmp[o + 3] += s.data[i + 3] * wt; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (const [k, wt] of sy[y]) { const i = (k * w + x) * 4; r += tmp[i] * wt; g += tmp[i + 1] * wt; b += tmp[i + 2] * wt; a += tmp[i + 3] * wt; }
    const o = (y * w + x) * 4;
    d[o + 3] = Math.round(a); d[o] = Math.min(d[o + 3], Math.round(r)); d[o + 1] = Math.min(d[o + 3], Math.round(g)); d[o + 2] = Math.min(d[o + 3], Math.round(b));
  }
  return { w, h, data: d };
}

/** The mip chain (level 0 = the picture itself) down to 1 × 1, with the GPU's level sizes (max(1, floor(n / 2^i))). */
export function mipChain(s: Img): Img[] {
  const out = [s];
  while (out[out.length - 1].w > 1 || out[out.length - 1].h > 1) out.push(mipDown(out[out.length - 1]));
  return out;
}

/** Copy the rectangle (sx, sy, w, h) of `s` into `d` at (dx, dy). Parts of the rectangle outside `s` repeat its
 *  nearest edge pixel (clamp, as the GPU samples a page edge), never transparent black. */
export function blit(s: Img, sx: number, sy: number, w: number, h: number, d: Img, dx: number, dy: number) {
  for (let y = 0; y < h; y++) {
    const yy = Math.min(s.h - 1, Math.max(0, sy + y)), ty = dy + y;
    if (ty < 0 || ty >= d.h) continue;
    const x0 = Math.max(0, sx), x1 = Math.min(s.w, sx + w);
    const row = yy * s.w * 4;
    // the inside run in one copy
    if (x1 > x0) {
      const tx = dx + (x0 - sx);
      d.data.set(s.data.subarray(row + x0 * 4, row + x1 * 4), (ty * d.w + tx) * 4);
    }
    for (let x = 0; x < w; x++) {
      const xx = sx + x;
      if (xx >= 0 && xx < s.w) continue;
      const cx = Math.min(s.w - 1, Math.max(0, xx)), q = row + cx * 4, o = (ty * d.w + dx + x) * 4;
      d.data[o] = s.data[q]; d.data[o + 1] = s.data[q + 1]; d.data[o + 2] = s.data[q + 2]; d.data[o + 3] = s.data[q + 3];
    }
  }
}

/** For n output pixels from `o` on at `scale` (< 1) output px per source px: each output pixel's source pixels and
 *  their area weights (summing to 1), indices clamped to [0, lim). */
function areaTaps(o: number, n: number, scale: number, lim: number): { idx: Int32Array; wt: Float32Array; start: Int32Array } {
  const idx: number[] = [], wt: number[] = [], start = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    start[i] = idx.length;
    const a = o + i / scale, b = o + (i + 1) / scale;
    for (let x = Math.floor(a); x < b; x++) {
      const w = (Math.min(b, x + 1) - Math.max(a, x)) * scale;
      if (w > 0) { idx.push(Math.min(lim - 1, Math.max(0, x))); wt.push(w); }
    }
  }
  start[n] = idx.length;
  return { idx: Int32Array.from(idx), wt: Float32Array.from(wt), start };
}

/** Area-averaged downscale of a region (premultiplied RGBA): output w × h px at (dx, dy) of `d` from source px (sx, sy)
 *  on (fractional), `scale` (< 1) output px per source px; edges clamped. A region too big for a texture page is stored
 *  this way (shared/rig2d/gpu/layout.ts PageRect.s). */
export function resampleArea(s: Img, sx: number, sy: number, scale: number, w: number, h: number, d: Img, dx: number, dy: number) {
  const tx = areaTaps(sx, w, scale, s.w), ty = areaTaps(sy, h, scale, s.h);
  let c0 = s.w, c1 = -1;
  for (const x of tx.idx) { if (x < c0) c0 = x; if (x > c1) c1 = x; }
  if (c1 < c0) return;
  const row = new Float32Array((c1 - c0 + 1) * 4);
  for (let y = 0; y < h; y++) {
    const oy = dy + y;
    if (oy < 0 || oy >= d.h) continue;
    row.fill(0);
    for (let t = ty.start[y]; t < ty.start[y + 1]; t++) {
      const wy = ty.wt[t], base = (ty.idx[t] * s.w + c0) * 4, sd = s.data;
      for (let q = 0; q < row.length; q++) row[q] += wy * sd[base + q];
    }
    for (let x = 0; x < w; x++) {
      const ox = dx + x;
      if (ox < 0 || ox >= d.w) continue;
      let r = 0, g = 0, b = 0, a = 0;
      for (let t = tx.start[x]; t < tx.start[x + 1]; t++) { const q = (tx.idx[t] - c0) * 4, wx = tx.wt[t]; r += wx * row[q]; g += wx * row[q + 1]; b += wx * row[q + 2]; a += wx * row[q + 3]; }
      const o = (oy * d.w + ox) * 4;
      // (premultiplied: colour never above alpha after rounding, as mipDown keeps it)
      const A = Math.min(255, Math.round(a));
      d.data[o] = Math.min(A, Math.round(r)); d.data[o + 1] = Math.min(A, Math.round(g)); d.data[o + 2] = Math.min(A, Math.round(b)); d.data[o + 3] = A;
    }
  }
}

/** Streaming area downscale by 2^k of rows arriving one at a time (straight RGBA8 in; premultiplied out): a phone builds
 *  its small pages from an 8192 / 16384 picture holding only (picture width × 4 bytes × a few rows). The exact 2^k × 2^k
 *  area average (k calls of half() round at every step, so they may differ from it by one level). */
export class RowShrinker {
  readonly f: number; readonly w: number; readonly h: number;
  readonly out: Img;
  private acc: Uint32Array;
  private rowsIn = 0;
  constructor(readonly srcW: number, readonly srcH: number, k: number) {
    this.f = 1 << k;
    this.w = Math.max(1, Math.ceil(srcW / this.f)); this.h = Math.max(1, Math.ceil(srcH / this.f));
    this.out = { w: this.w, h: this.h, data: new Uint8Array(this.w * this.h * 4) };
    this.acc = new Uint32Array(this.w * 4);
  }
  push(y: number, rgba: Uint8Array) {
    const f = this.f, acc = this.acc;
    for (let x = 0; x < this.srcW; x++) {
      const i = x * 4, a = rgba[i + 3], o = (x / f | 0) * 4;
      if (a === 0) continue;
      acc[o] += a === 255 ? rgba[i] : (rgba[i] * a + 127) / 255 | 0;
      acc[o + 1] += a === 255 ? rgba[i + 1] : (rgba[i + 1] * a + 127) / 255 | 0;
      acc[o + 2] += a === 255 ? rgba[i + 2] : (rgba[i + 2] * a + 127) / 255 | 0;
      acc[o + 3] += a;
    }
    this.rowsIn++;
    if ((y + 1) % f === 0 || y === this.srcH - 1) {
      const oy = y / f | 0, rows = y - oy * f + 1, d = this.out.data;
      for (let x = 0; x < this.w; x++) {
        const cols = Math.min(f, this.srcW - x * f), n = rows * cols, q = x * 4, o = (oy * this.w + x) * 4;
        d[o] = (acc[q] + (n >> 1)) / n | 0; d[o + 1] = (acc[q + 1] + (n >> 1)) / n | 0; d[o + 2] = (acc[q + 2] + (n >> 1)) / n | 0; d[o + 3] = (acc[q + 3] + (n >> 1)) / n | 0;
      }
      acc.fill(0);
    }
  }
}
