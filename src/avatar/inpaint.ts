// Pure image helpers for replacing eyes painted into a model's texture (src/avatar/bakedEyes.ts): rasterise the
// eye's erase ellipse into texture space, fill the hole from the surrounding skin (push-pull + harmonic smoothing,
// optional grain), and sample the skin colour around the eye. No DOM, no three.js: unit-tested by
// tools/baked_eyes_unit.ts.
//
// Conventions: images are RGBA8 (sRGB-encoded) row-major crops; `dist` holds, per crop pixel, the smallest
// normalised ellipse distance d of the face surface that maps onto that texel (d < 1 inside the erase ellipse,
// Infinity = no face surface near the eye maps there — atlas neighbours, hair, clothes: never read, never written).

export interface Crop { x: number; y: number; w: number; h: number }

/** One triangle in texture pixel space (px, py; y down, pixel centres at +0.5) with the eye-frame coordinates of
 *  its corners, already normalised so the ellipse is the unit circle: d = hypot(ex, ey). */
export interface MaskTri { px: [number, number, number]; py: [number, number, number]; ex: [number, number, number]; ey: [number, number, number] }

/** Grow the mask by `px` texels into uncovered pixels (texture filtering / mip levels reach a little past a UV
 *  island's edge: without this a faint outline of the old eye survives along seams). */
export function dilateMask(dist: Float32Array, w: number, h: number, px = 2) {
  for (let it = 0; it < px; it++) {
    const src = dist.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (src[i] !== Infinity) continue;
      let best = Infinity;
      if (x > 0) best = Math.min(best, src[i - 1]);
      if (x < w - 1) best = Math.min(best, src[i + 1]);
      if (y > 0) best = Math.min(best, src[i - w]);
      if (y < h - 1) best = Math.min(best, src[i + w]);
      if (best !== Infinity) dist[i] = best;
    }
  }
}

/** Erase weight of a texel from its ellipse distance: 1 inside, a short smooth feather just outside, 0 beyond. */
export function eraseWeight(d: number, feather = 0.12): number {
  if (d <= 1) return 1;
  if (d >= 1 + feather) return 0;
  const t = (d - 1) / feather;
  return 1 - t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------- colour

const LUT = (() => { const a = new Float32Array(256); for (let i = 0; i < 256; i++) { const c = i / 255; a[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); } return a; })();
export const srgbToLinear8 = (v: number) => LUT[v];
export function linearToSrgb8(v: number): number {
  const c = v <= 0 ? 0 : v >= 1 ? 1 : v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(c * 255);
}

export interface SkinStats {
  /** Average skin colour (linear RGB, 0..1) over the ring, outliers excluded. */
  mean: [number, number, number];
  /** Robust spread (linear RGB distance) of the ring's skin texels. */
  sigma: number;
  /** Texels used / seen. */
  used: number;
  seen: number;
}

/**
 * The skin colour around the eye: texels in the ring dIn ≤ d ≤ dOut (just outside the erased area), averaged in
 * LINEAR light (sRGB-correct), excluding outliers — hair strands, lash tips, brows, the scar line: first the
 * luminance band between the 20th and 80th percentile, then anything farther than 2.5 × MAD from the median colour.
 * null when the ring has no texels.
 */
export function ringSkinStats(rgba: Uint8ClampedArray | Uint8Array, dist: Float32Array, dIn: number, dOut: number): SkinStats | null {
  const idx: number[] = [];
  for (let i = 0; i < dist.length; i++) { const d = dist[i]; if (d >= dIn && d <= dOut && rgba[i * 4 + 3] > 8) idx.push(i); }
  if (!idx.length) return null;
  const lin = (i: number, c: number) => LUT[rgba[i * 4 + c]];
  const lum = (i: number) => 0.2126 * lin(i, 0) + 0.7152 * lin(i, 1) + 0.0722 * lin(i, 2);
  const byL = idx.map((i) => [lum(i), i] as const).sort((a, b) => a[0] - b[0]);
  const band = idx.length < 10 ? byL : byL.slice(Math.floor(byL.length * 0.2), Math.ceil(byL.length * 0.8));
  const med = (vals: number[]) => { const s = vals.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
  const mc: [number, number, number] = [0, 1, 2].map((c) => med(band.map(([, i]) => lin(i, c)))) as [number, number, number];
  const dev = (i: number) => Math.hypot(lin(i, 0) - mc[0], lin(i, 1) - mc[1], lin(i, 2) - mc[2]);
  const mad = med(band.map(([, i]) => dev(i))) || 1e-3;
  const keep = band.filter(([, i]) => dev(i) <= 2.5 * mad + 0.004);
  const use = keep.length ? keep : band;
  const mean: [number, number, number] = [0, 0, 0];
  for (const [, i] of use) for (let c = 0; c < 3; c++) mean[c] += lin(i, c);
  for (let c = 0; c < 3; c++) mean[c] /= use.length;
  return { mean, sigma: Math.max(1.4826 * mad, 0.01), used: use.length, seen: idx.length };
}

export function linearToHex(c: [number, number, number]): string {
  return '#' + c.map((v) => linearToSrgb8(v).toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- fill

export interface FillOptions {
  /** Ellipse distance band used as the source (known skin): ≥ 1 + feather … ≤ dSource. */
  feather: number;
  dSource: number;
  /** Robust skin statistics: source texels far from the skin colour (brows, hair, lash tips) count less. */
  skin: SkinStats | null;
  /** Harmonic smoothing iterations after push-pull (removes the pyramid's blockiness). */
  smooth: number;
  /** 0..1: re-add the skin's own fine grain (high-pass of nearby clean skin) so the patch isn't a smooth smudge. */
  grain: number;
  /** Colour (linear) to fill with when the surroundings hold (almost) no skin-like texel — e.g. a head shell under a
   *  face plate whose atlas island around the eye is all lash paint. */
  fallback?: [number, number, number] | null;
  /** Always fill flat with `fallback` (a hidden head shell under a face plate: its own surroundings are no guide). */
  flat?: boolean;
}

/**
 * Fill the erase region of an RGBA crop in place. Texels with eraseWeight(d) > 0 are replaced by a smooth
 * membrane interpolated from the source ring (push-pull pyramid, then harmonic relaxation), blended by the
 * erase weight; everything else is left bit-identical. Returns the number of texels changed.
 */
export function fillHole(rgba: Uint8ClampedArray | Uint8Array, dist: Float32Array, w: number, h: number, o: FillOptions): number {
  const n = w * h;
  const C = new Float32Array(n * 3), W = new Float32Array(n);
  const hole = new Uint8Array(n);
  let holes = 0;
  const sk = o.skin;
  for (let i = 0; i < n; i++) {
    const d = dist[i];
    if (d === Infinity) continue;
    if (eraseWeight(d, o.feather) > 0) { hole[i] = 1; holes++; continue; }
    if (d > o.dSource || rgba[i * 4 + 3] < 8) continue;
    const r = LUT[rgba[i * 4]], g = LUT[rgba[i * 4 + 1]], b = LUT[rgba[i * 4 + 2]];
    let wt = 1;
    if (sk) { const dv = Math.hypot(r - sk.mean[0], g - sk.mean[1], b - sk.mean[2]) / (1.8 * sk.sigma + 0.006); wt = Math.exp(-dv * dv); }
    wt = Math.max(wt, o.fallback ? 0 : 0.002);
    C[i * 3] = r * wt; C[i * 3 + 1] = g * wt; C[i * 3 + 2] = b * wt; W[i] = wt;
  }
  if (!holes) return 0;
  let wsum = 0;
  for (let i = 0; i < n; i++) wsum += W[i];
  if (o.fallback && (o.flat || wsum < Math.max(8, holes * 0.02))) {
    // no usable skin around: a flat fill of the face's own skin colour
    let changed = 0;
    for (let i = 0; i < n; i++) {
      if (!hole[i]) continue;
      const e = eraseWeight(dist[i], o.feather);
      for (let c = 0; c < 3; c++) { const orig = LUT[rgba[i * 4 + c]]; rgba[i * 4 + c] = linearToSrgb8(orig + (o.fallback[c] - orig) * e); }
      changed++;
    }
    return changed;
  }
  const fill = pushPull(C, W, w, h);
  // harmonic relaxation of the hole interior (Jacobi on the 4-neighbourhood; sources + non-surface stay fixed)
  const cur = fill;
  // (neighbour lists built once: hole texels + clean sources take part, everything else is a free boundary)
  const holeIdx: number[] = [];
  for (let i = 0; i < n; i++) if (hole[i]) holeIdx.push(i);
  const nb = new Int32Array(holeIdx.length * 4).fill(-1);
  holeIdx.forEach((i, k) => {
    const x = i % w, y = (i - x) / w;
    let m = 0;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (j >= 0 && (hole[j] || W[j] > 0.5)) nb[k * 4 + m++] = j;
  });
  for (let it = 0; it < o.smooth; it++) {
    for (let k = 0; k < holeIdx.length; k++) {
      let sr = 0, sg = 0, sb = 0, m = 0;
      for (let t = 0; t < 4; t++) {
        const j = nb[k * 4 + t];
        if (j < 0) break;
        sr += cur[j * 3]; sg += cur[j * 3 + 1]; sb += cur[j * 3 + 2]; m++;
      }
      if (m) { const i = holeIdx[k] * 3; cur[i] = sr / m; cur[i + 1] = sg / m; cur[i + 2] = sb / m; }
    }
  }
  const grain = o.grain > 0 ? grainField(rgba, dist, hole, w, h, o) : null;
  let changed = 0;
  for (let i = 0; i < n; i++) {
    if (!hole[i]) continue;
    const e = eraseWeight(dist[i], o.feather);
    for (let c = 0; c < 3; c++) {
      let v = cur[i * 3 + c];
      if (grain) v += grain[i * 3 + c] * o.grain;
      const orig = LUT[rgba[i * 4 + c]];
      rgba[i * 4 + c] = linearToSrgb8(orig + (v - orig) * e);
    }
    changed++;
  }
  return changed;
}

/**
 * fillHole on each separate region of the crop: texels that matter (d ≤ dSource) are grouped into connected
 * 16-px blocks, and every group with a hole is filled inside its own bounding box. An atlas scatters the face
 * over many small UV islands: filling the crop's whole bounding box would cost a full-texture pass.
 */
export function fillHoleRegions(rgba: Uint8ClampedArray | Uint8Array, dist: Float32Array, w: number, h: number, o: FillOptions): number {
  const S = 16, bw = Math.ceil(w / S), bh = Math.ceil(h / S);
  const used = new Uint8Array(bw * bh), hasHole = new Uint8Array(bw * bh);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = dist[y * w + x];
    if (d > o.dSource) continue;
    const b = Math.floor(y / S) * bw + Math.floor(x / S);
    used[b] = 1;
    if (eraseWeight(d, o.feather) > 0) hasHole[b] = 1;
  }
  const comp = new Int32Array(bw * bh).fill(-1);
  let changed = 0;
  for (let b0 = 0; b0 < bw * bh; b0++) {
    if (!used[b0] || comp[b0] >= 0) continue;
    // flood the group (8-neighbour blocks)
    const stack = [b0]; comp[b0] = b0;
    let x0 = bw, y0 = bh, x1 = -1, y1 = -1, hole = false;
    while (stack.length) {
      const b = stack.pop()!;
      const bx = b % bw, by = Math.floor(b / bw);
      x0 = Math.min(x0, bx); x1 = Math.max(x1, bx); y0 = Math.min(y0, by); y1 = Math.max(y1, by);
      if (hasHole[b]) hole = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = bx + dx, ny = by + dy;
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
        const nb = ny * bw + nx;
        if (used[nb] && comp[nb] < 0) { comp[nb] = b0; stack.push(nb); }
      }
    }
    if (!hole) continue;
    const rx = x0 * S, ry = y0 * S, rw = Math.min(w, (x1 + 1) * S) - rx, rh = Math.min(h, (y1 + 1) * S) - ry;
    const sub = new Uint8Array(rw * rh * 4), sd = new Float32Array(rw * rh);
    for (let y = 0; y < rh; y++) {
      sub.set(rgba.subarray(((ry + y) * w + rx) * 4, ((ry + y) * w + rx + rw) * 4), y * rw * 4);
      sd.set(dist.subarray((ry + y) * w + rx, (ry + y) * w + rx + rw), y * rw);
    }
    changed += fillHole(sub, sd, rw, rh, o);
    for (let y = 0; y < rh; y++) rgba.set(sub.subarray(y * rw * 4, (y + 1) * rw * 4), ((ry + y) * w + rx) * 4);
  }
  return changed;
}

/** Push-pull (pyramid) interpolation of scattered weighted samples: every texel gets a colour from the nearest
 *  known texels, smoothly. C = premultiplied linear RGB (C = colour × W), W = weights 0..1. Returns plain colours. */
export function pushPull(C: Float32Array, W: Float32Array, w: number, h: number): Float32Array {
  if (w <= 1 && h <= 1) {
    const out = new Float32Array(3);
    if (W[0] > 0) for (let c = 0; c < 3; c++) out[c] = C[c] / W[0];
    return out;
  }
  const w2 = Math.max(1, (w + 1) >> 1), h2 = Math.max(1, (h + 1) >> 1);
  const C2 = new Float32Array(w2 * h2 * 3), W2 = new Float32Array(w2 * h2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, j = (y >> 1) * w2 + (x >> 1);
    W2[j] += W[i]; C2[j * 3] += C[i * 3]; C2[j * 3 + 1] += C[i * 3 + 1]; C2[j * 3 + 2] += C[i * 3 + 2];
  }
  // clamp coarse weights to 1 (keeps colours, lets finer levels win where they have data)
  for (let j = 0; j < w2 * h2; j++) if (W2[j] > 1) { const s = 1 / W2[j]; C2[j * 3] *= s; C2[j * 3 + 1] *= s; C2[j * 3 + 2] *= s; W2[j] = 1; }
  const coarse = pushPull(C2, W2, w2, h2);
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    // bilinear sample of the coarse level at this texel's centre
    const fx = Math.min(w2 - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), fy = Math.min(h2 - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(w2 - 1, x0 + 1), y1 = Math.min(h2 - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
    const wt = Math.min(1, W[i]);
    for (let c = 0; c < 3; c++) {
      const a = coarse[(y0 * w2 + x0) * 3 + c] * (1 - tx) + coarse[(y0 * w2 + x1) * 3 + c] * tx;
      const b = coarse[(y1 * w2 + x0) * 3 + c] * (1 - tx) + coarse[(y1 * w2 + x1) * 3 + c] * tx;
      const up = a * (1 - ty) + b * ty;
      const own = W[i] > 0 ? C[i * 3 + c] / W[i] : 0;
      out[i * 3 + c] = own * wt + up * (1 - wt);
    }
  }
  return out;
}

/**
 * Fine skin grain for the hole: the high-pass (texel − its 5×5 blur) of clean skin, copied from a single fixed
 * offset (so the grain stays one continuous piece of the texture: no block seams). The offset is picked among
 * a few candidates (below / above / beside the hole) as the one whose samples land on the most clean source skin.
 */
function grainField(rgba: Uint8ClampedArray | Uint8Array, dist: Float32Array, hole: Uint8Array, w: number, h: number, o: FillOptions): Float32Array | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (hole[y * w + x]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (x1 < 0) return null;
  const hw = x1 - x0 + 1, hh = y1 - y0 + 1;
  const clean = (i: number) => {
    const d = dist[i];
    if (d === Infinity || hole[i] || d > o.dSource * 1.6) return false;
    if (!o.skin) return true;
    const dv = Math.hypot(LUT[rgba[i * 4]] - o.skin.mean[0], LUT[rgba[i * 4 + 1]] - o.skin.mean[1], LUT[rgba[i * 4 + 2]] - o.skin.mean[2]);
    return dv < 2 * o.skin.sigma + 0.01;
  };
  const cands: [number, number][] = [[0, hh + 2], [0, -(hh + 2)], [hw + 2, 0], [-(hw + 2), 0], [0, Math.round(hh * 0.7)], [0, -Math.round(hh * 0.7)]];
  let best: [number, number] | null = null, bestScore = 0;
  let holeN = 0;
  for (let i = 0; i < w * h; i++) holeN += hole[i];
  for (const [dx, dy] of cands) {
    let s = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (!hole[y * w + x]) continue;
      const sx = x + dx, sy = y + dy;
      if (sx < 2 || sy < 2 || sx >= w - 2 || sy >= h - 2) continue;
      if (clean(sy * w + sx)) s++;
    }
    if (s > bestScore) { bestScore = s; best = [dx, dy]; }
  }
  if (!best || bestScore < holeN * 0.6) return null;
  const [bx, by]: [number, number] = best;
  const out = new Float32Array(w * h * 3);
  const L = (i: number, c: number) => LUT[rgba[i * 4 + c]];
  const res: number[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * w + x;
    if (!hole[i]) continue;
    const sx: number = x + bx, sy: number = y + by;
    if (sx < 2 || sy < 2 || sx >= w - 2 || sy >= h - 2) continue;
    const si = sy * w + sx;
    if (!clean(si)) continue;
    for (let c = 0; c < 3; c++) {
      let s = 0, k = 0;
      for (let v = -2; v <= 2; v++) for (let u = -2; u <= 2; u++) { const j = (sy + v) * w + sx + u; if (dist[j] !== Infinity) { s += L(j, c); k++; } }
      out[i * 3 + c] = L(si, c) - s / Math.max(k, 1);
      res.push(Math.abs(out[i * 3 + c]));
    }
  }
  // keep the fine grain only: clamp to 2 × the typical residual, so a scar or a stray hair line in the source
  // area can't be copied into the new skin
  if (!res.length) return null;
  res.sort((a, b) => a - b);
  const lim = 2 * res[res.length >> 1] + 1e-4;
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-lim, Math.min(lim, out[i]));
  return out;
}

// ---------------------------------------------------------------- finding the painted eye

/** Rasterise eye-frame coordinates (in eye sizes) into U / V (crop-local; NaN = no surface). Where triangles
 *  overlap in UV space (mirrored islands), the point nearer the eye wins. */
export function rasterizeCoords(U: Float32Array, V: Float32Array, crop: Crop, tris: Iterable<MaskTri>) {
  // per texel: 0 = set from inside a triangle, 1 = from a triangle's edge margin, 2 = unset (inside beats the margin)
  const d = new Float32Array(U.length).fill(Infinity), q = new Uint8Array(U.length).fill(2);
  const { w, h } = crop;
  for (const t of tris) {
    const [x0, x1, x2] = t.px.map((v) => v - crop.x) as [number, number, number];
    const [y0, y1, y2] = t.py.map((v) => v - crop.y) as [number, number, number];
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-9) continue;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2) - 1)), maxX = Math.min(w - 1, Math.ceil(Math.max(x0, x1, x2) + 1));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2) - 1)), maxY = Math.min(h - 1, Math.ceil(Math.max(y0, y1, y2) + 1));
    const len = (ax: number, ay: number, bx: number, by: number) => Math.hypot(bx - ax, by - ay) || 1;
    const A = Math.abs(area);
    const m0 = (0.75 * len(x1, y1, x2, y2)) / A, m1 = (0.75 * len(x2, y2, x0, y0)) / A, m2 = (0.75 * len(x0, y0, x1, y1)) / A;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      let b0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) / area;
      let b1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) / area;
      let b2 = 1 - b0 - b1;
      if (b0 < -m0 || b1 < -m1 || b2 < -m2) continue;
      const qq = b0 >= 0 && b1 >= 0 && b2 >= 0 ? 0 : 1;
      b0 = Math.max(0, b0); b1 = Math.max(0, b1); b2 = Math.max(0, b2);
      const s = b0 + b1 + b2; b0 /= s; b1 /= s; b2 /= s;
      const u = b0 * t.ex[0] + b1 * t.ex[1] + b2 * t.ex[2], v = b0 * t.ey[0] + b1 * t.ey[1] + b2 * t.ey[2];
      const i = y * w + x, r = Math.hypot(u, v);
      if (qq < q[i] || (qq === q[i] && r < d[i])) { d[i] = r; q[i] = qq; U[i] = u; V[i] = v; }
    }
  }
}

/** (Super)ellipse distance field from eye-frame coordinates: d = (|Δu / rx|^p + |Δv / ry|^p)^(1/p) (p = 2: an
 *  ellipse; higher p: boxier, so it reaches into the corners of a fitted eye — the lash wing — without growing
 *  taller); Infinity where there is no surface. */
export function ellipseDist(U: Float32Array, V: Float32Array, e: { cx: number; cy: number; rx: number; ry: number; p?: number }): Float32Array {
  const out = new Float32Array(U.length), p = e.p ?? 2;
  for (let i = 0; i < U.length; i++) {
    if (Number.isNaN(U[i])) { out[i] = Infinity; continue; }
    const a = Math.abs(U[i] - e.cx) / e.rx, b = Math.abs(V[i] - e.cy) / e.ry;
    out[i] = p === 2 ? Math.hypot(a, b) : Math.pow(Math.pow(a, p) + Math.pow(b, p), 1 / p);
  }
  return out;
}

export interface EyeFit {
  /** centre of the painted eye, eye-frame (eye sizes) */
  cx: number; cy: number;
  /** half extents of the painted eye (lashes included), eye sizes */
  hx: number; hy: number;
  /** 0..1 how sure (an eye needs both bright white — sclera, highlights — and dark lines close together) */
  confidence: number;
  /** The painted iris colour (linear RGB), when there is one: the most saturated mid-tone inside the eye. */
  iris?: [number, number, number];
}

/**
 * Find the painted eye near the marker, in eye-frame coordinates (units = eye size; search radius `reach`).
 * Binned at 0.1 eye sizes: per bin the share of "eye white" texels (brighter and less saturated than the skin),
 * of "ink" texels (far darker than the skin: lash line, pupil, iris) and of anything unlike the skin. The eye is
 * where white and ink crowd together (brows, hair and scars have ink but no white); its extent is the connected
 * unlike-skin blob around that point, clipped to a sensible eye shape. null = nothing eye-like (the marker's
 * ellipse is used as is).
 */
export function fitPaintedEye(rgba: Uint8ClampedArray | Uint8Array, U: Float32Array, V: Float32Array, reach = 3.2, side?: { outward: number; minOut: number }, socket?: { u0: number; u1: number; v0: number; v1: number } | null): EyeFit | null {
  // (two eyes: never look past `minOut` toward the face's midline — that's the mouth / the other eye)
  const onSide = (u: number) => !side || side.outward === 0 || u * side.outward >= side.minOut;
  const B = 0.1, N = Math.ceil((2 * reach) / B);
  const at = (u: number, v: number) => { const bx = Math.floor((u + reach) / B), by = Math.floor((v + reach) / B); return bx < 0 || by < 0 || bx >= N || by >= N ? -1 : by * N + bx; };
  // an eyeball set into a socket: the paint to erase is the lash frame hugging the hole — the hole says where
  if (socket) {
    const hw = (socket.u1 - socket.u0) / 2, hh = (socket.v1 - socket.v0) / 2;
    return { cx: (socket.u0 + socket.u1) / 2, cy: (socket.v0 + socket.v1) / 2 + hh * 0.08, hx: hw * 1.28 + 0.1, hy: hh * 1.3 + 0.06, confidence: 0.6 };
  }
  const idx: number[] = [];
  // (a big crop — a face texture where the eye is huge — is sampled every other texel: the bins stay well filled)
  const stride = U.length > 400000 ? 2 : 1;
  for (let i = 0; i < U.length; i += stride) if (!Number.isNaN(U[i]) && Math.hypot(U[i], V[i]) <= reach && rgba[i * 4 + 3] > 8) idx.push(i);
  if (idx.length < 50) return null;
  const lin = (i: number, c: number) => LUT[rgba[i * 4 + c]];
  const lum = (i: number) => 0.2126 * lin(i, 0) + 0.7152 * lin(i, 1) + 0.0722 * lin(i, 2);
  const med = (vals: number[]) => { const s = vals.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
  // skin reference: the search disc's median (skin covers most of it)
  const sample = idx.length > 20000 ? idx.filter((_, k) => k % Math.ceil(idx.length / 20000) === 0) : idx;
  const mc = [0, 1, 2].map((c) => med(sample.map((i) => lin(i, c))));
  const mL = 0.2126 * mc[0] + 0.7152 * mc[1] + 0.0722 * mc[2];
  const chroma = (r: number, g: number, b: number) => (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(Math.max(r, g, b), 1e-3);
  const mChroma = chroma(mc[0], mc[1], mc[2]);
  const devs = idx.map((i) => Math.hypot(lin(i, 0) - mc[0], lin(i, 1) - mc[1], lin(i, 2) - mc[2]));
  const sigma = Math.max(1.4826 * med(devs.length > 20000 ? devs.filter((_, k) => k % Math.ceil(devs.length / 20000) === 0) : devs), 0.01);
  const cnt = new Float32Array(N * N), white = new Float32Array(N * N), ink = new Float32Array(N * N), odd = new Float32Array(N * N), faint = new Float32Array(N * N);
  const whiteUV: [number, number][] = [];
  idx.forEach((i, k) => {
    const b = at(U[i], V[i]);
    if (b < 0) return;
    cnt[b]++;
    const L = lum(i), ch = chroma(lin(i, 0), lin(i, 1), lin(i, 2));
    const isWhite = L > Math.max(mL * 1.25, mL + 0.08) && ch < Math.max(0.5 * mChroma, 0.18);
    if (isWhite) { white[b]++; whiteUV.push([U[i], V[i]]); }
    if (L < mL * 0.35) ink[b]++;
    if (devs[k] > 4 * sigma) odd[b]++;
    if (isWhite || devs[k] > 2.5 * sigma || L < mL * 0.6) faint[b]++;
  });
  const blur = (a: Float32Array, r: number) => {
    const t = new Float32Array(N * N), o = new Float32Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { let s = 0; for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < N) s += a[y * N + xx]; } t[y * N + x] = s; }
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { let s = 0; for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < N) s += t[yy * N + x]; } o[y * N + x] = s; }
    return o;
  };
  const binU = (b: number) => (b % N + 0.5) * B - reach, binV = (b: number) => (Math.floor(b / N) + 0.5) * B - reach;
  const C = blur(cnt, 4), Wh = blur(white, 4), In = blur(ink, 4);
  let best = -1, bestS = 0;
  for (let b = 0; b < N * N; b++) {
    if (C[b] < 4) continue;
    const bu = binU(b), bv = binV(b);
    // the eye sits beside the marker, not far above / below it (white teeth + the mouth line below, a white hair
    // clip above are not an eye)
    if (Math.abs(bu) > 2.8 || Math.abs(bv) > 2.6 || !onSide(bu)) continue;
    const s = Math.sqrt((Wh[b] / C[b]) * (In[b] / C[b])) * Math.exp(-(bu * bu) / (2 * 2.2 * 2.2) - (bv * bv) / (2 * 1.2 * 1.2));
    if (s > bestS) { bestS = s; best = b; }
  }
  const O = blur(faint, 1), Cn = blur(cnt, 1);
  const on = (b: number) => Cn[b] > 0 && O[b] / Cn[b] > 0.15;
  let cx: number, cy: number, confidence: number;
  let seeds: number[];
  // the connected unlike-skin bins (lightly blurred so a lash line with gaps stays one piece) grown from the seeds,
  // kept inside an eye-shaped box so a brow, a scar or the mouth can't drag the extent away
  let bu0: number, bu1: number, bv0: number, bv1: number;
  let coreBox: [number, number, number, number] | null = null;
  if (best >= 0 && bestS > 0.04) {
    cx = binU(best); cy = binV(best);
    confidence = Math.min(1, bestS / 0.1);
    seeds = [best];
    bu0 = cx - 2.4; bu1 = cx + 2.4; bv0 = cy - 1.2; bv1 = cy + 1.4;
    // around the eye white: lashes reach a little above it, the wing well past the outer corner
    const core = whiteUV.filter(([u, v]) => Math.abs(u - cx) < 1.8 && Math.abs(v - cy) < 1.2);
    if (core.length >= 12) {
      const cu = core.map((p) => p[0]).sort((x, y) => x - y), cv = core.map((p) => p[1]).sort((x, y) => x - y);
      const qq = (arr: number[], f: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * f))];
      coreBox = [qq(cu, 0.02), qq(cu, 0.98), qq(cv, 0.02), qq(cv, 0.98)];
      bu0 = coreBox[0] - 0.9; bu1 = coreBox[1] + 0.9; bv0 = coreBox[2] - 0.3; bv1 = coreBox[3] + 0.32;
    }
  } else {
    // no eye white (lash-only paint, a dark sclera, or a painted lash frame around a socket): the unlike-skin marks
    // right around the marker — weak evidence, so only near it (never a mouth or a brow far off)
    seeds = [];
    bu0 = -3.0; bu1 = 3.0; bv0 = -1.6; bv1 = 1.5;   // (brows sit higher: they stay)
    for (let b = 0; b < N * N; b++) if (on(b) && Math.hypot(binU(b), binV(b)) <= 2.0 && binV(b) <= 1.5 && onSide(binU(b))) seeds.push(b);
    if (seeds.length < 8) return null;
    cx = 0; cy = 0; confidence = 0.4;
  }
  const seen = new Uint8Array(N * N), isSeed = new Uint8Array(N * N);
  const q = seeds.slice();
  for (const b of seeds) { seen[b] = 1; isSeed[b] = 1; }
  const us: number[] = [], vs: number[] = [];
  while (q.length) {
    const b = q.pop()!;
    const x = b % N, y = Math.floor(b / N);
    const u = binU(b), v = binV(b);
    if (u < bu0 || u > bu1 || v < bv0 || v > bv1 || !onSide(u)) continue;
    if (!on(b) && !isSeed[b]) continue;
    us.push(u); vs.push(v);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
      const nb = yy * N + xx;
      if (!seen[nb]) { seen[nb] = 1; q.push(nb); }
    }
  }
  if (us.length < 6) return { cx, cy, hx: 1, hy: 0.7, confidence: confidence * 0.5 };
  // lash-only evidence that floods most of its box is shading / hair / beard, not an eye: don't trust it
  if (seeds.length > 1 && us.length > 0.6 * ((bu1 - bu0) / B) * ((bv1 - bv0) / B)) return null;
  us.sort((a, b) => a - b); vs.sort((a, b) => a - b);
  const pct = (a: number[], f: number) => a[Math.min(a.length - 1, Math.max(0, Math.floor(a.length * f)))];
  const u0 = pct(us, 0.02), u1 = pct(us, 0.98), v0 = pct(vs, 0.02), v1 = pct(vs, 0.98);
  if (Math.abs((u0 + u1) / 2) > 2.8 || Math.abs((v0 + v1) / 2) > (seeds.length > 1 ? 1.6 : 2.8)) return null;
  // the iris: saturated mid-tones inside the eye (not the white, not the black pupil / lash line, not skin)
  let iris: [number, number, number] | undefined;
  if (coreBox) {
    // (inside the eye white's box only: the iris sits between the whites — skin shadow around the eye doesn't count)
    const [c0u, c1u, c0v, c1v] = coreBox;
    const cand: { ch: number; c: [number, number, number] }[] = [];
    idx.forEach((i, k) => {
      if (U[i] < c0u || U[i] > c1u || V[i] < c0v || V[i] > c1v || devs[k] < 3 * sigma) return;
      const r = lin(i, 0), g = lin(i, 1), b = lin(i, 2), L = lum(i), ch = chroma(r, g, b);
      if (L < mL * 0.1 || L > Math.max(mL * 1.25, mL + 0.08) || ch < 0.12) return;
      cand.push({ ch, c: [r, g, b] });
    });
    if (cand.length >= 12) {
      cand.sort((a, b) => b.ch - a.ch);
      const top = cand.slice(0, Math.max(6, cand.length >> 1));
      iris = [0, 1, 2].map((c) => med(top.map((x) => x.c[c]))) as [number, number, number];
    }
  }
  return { cx: (u0 + u1) / 2, cy: (v0 + v1) / 2, hx: Math.max(0.4, (u1 - u0) / 2 + B), hy: Math.max(0.3, (v1 - v0) / 2 + B), confidence, ...(iris ? { iris } : {}) };
}

/** Visit every texel a list of triangles covers (inside + a `margin`-texel rim for filtering), with its interpolated
 *  eye-frame coordinates. Work is proportional to the triangles' area — for sparse atlas islands. */
export function forEachTexel(W: number, H: number, tris: Iterable<MaskTri>, cb: (i: number, u: number, v: number) => void, margin = 1.5) {
  for (const t of tris) {
    const [x0, x1, x2] = t.px, [y0, y1, y2] = t.py;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-9) continue;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2) - margin)), maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2) + margin));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2) - margin)), maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2) + margin));
    const A = Math.abs(area), len = (ax: number, ay: number, bx: number, by: number) => Math.hypot(bx - ax, by - ay) || 1;
    const m0 = (margin * len(x1, y1, x2, y2)) / A, m1 = (margin * len(x2, y2, x0, y0)) / A, m2 = (margin * len(x0, y0, x1, y1)) / A;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      let b0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) / area;
      let b1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) / area;
      let b2 = 1 - b0 - b1;
      if (b0 < -m0 || b1 < -m1 || b2 < -m2) continue;
      b0 = Math.max(0, b0); b1 = Math.max(0, b1); b2 = Math.max(0, b2);
      const s = b0 + b1 + b2;
      cb(y * W + x, (b0 * t.ex[0] + b1 * t.ex[1] + b2 * t.ex[2]) / s, (b0 * t.ey[0] + b1 * t.ey[1] + b2 * t.ey[2]) / s);
    }
  }
}

/**
 * Flat repaint of the erase area on a texture that isn't the visible face (a head shell under a face plate, an
 * emissive map): every covered texel inside the (super)ellipse is blended toward `color` (linear) by its erase
 * weight. `color` null = the texture's own median colour just outside the area. Returns the texels changed.
 */
export function flatRepaint(full: Uint8Array, W: number, H: number, tris: MaskTri[], e: { cx: number; cy: number; rx: number; ry: number; p?: number }, feather: number, color: [number, number, number] | null): number {
  const p = e.p ?? 2;
  const dOf = (u: number, v: number) => { const a = Math.abs(u - e.cx) / e.rx, b = Math.abs(v - e.cy) / e.ry; return p === 2 ? Math.hypot(a, b) : Math.pow(Math.pow(a, p) + Math.pow(b, p), 1 / p); };
  let c = color;
  if (!c) {
    const rs: number[] = [], gs: number[] = [], bs: number[] = [];
    forEachTexel(W, H, tris, (i, u, v) => { const d = dOf(u, v); if (d >= 1 + feather && d <= 1.6 && rs.length < 20000) { rs.push(LUT[full[i * 4]]); gs.push(LUT[full[i * 4 + 1]]); bs.push(LUT[full[i * 4 + 2]]); } }, 0);
    if (!rs.length) return 0;
    const med = (a: number[]) => a.sort((x, y) => x - y)[a.length >> 1];
    c = [med(rs), med(gs), med(bs)];
  }
  const done = new Map<number, number>();   // texel → the largest erase weight seen (overlapping margins)
  forEachTexel(W, H, tris, (i, u, v) => { const w = eraseWeight(dOf(u, v), feather); if (w > (done.get(i) ?? 0)) done.set(i, w); });
  for (const [i, w] of done) for (let k = 0; k < 3; k++) { const o = LUT[full[i * 4 + k]]; full[i * 4 + k] = linearToSrgb8(o + (c[k] - o) * w); }
  return done.size;
}
