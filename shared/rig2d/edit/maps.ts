// Lighting maps made from the art, so room lights shade a 2D avatar with no extra painting:
//   normal map  a height field per layer (the layer's 2.5D depth + a soft dome rising from its outline + shallow grooves
//               along drawn lines found by edge detection) → tangent-space normals (+Y up in the image, flat = 128,128,255);
//   rim mask    where room-light rim lighting may appear: a band inside the outline of outer parts (hair, face, body …),
//               none on inner details (eyes, mouth, brows);
//   emission    the parts marked as glowing, at their glow strength (null when nothing glows).
// The maps share the atlas layout (vtp2.ts packAtlas), one of each per atlas page. Pure (no DOM).
import type { EdDoc, EdTexture } from './doc.ts';
import type { Role } from './classify.ts';

export interface MapPage { w: number; h: number; rgba: Uint8ClampedArray }
export interface LightMaps { normal: MapPage[]; rim: MapPage[]; emission: MapPage[] | null }

const INNER: ReadonlySet<Role> = new Set<Role>(['eyeWhite', 'iris', 'highlight', 'lashUpper', 'lashLower', 'eyeClosed', 'eyeWhole', 'brow', 'mouthUpper', 'mouthLower', 'mouthInner', 'teeth', 'tongue', 'mouth', 'nose', 'blush']);

/** Chamfer (3-4) distance to the nearest outside pixel, in px. */
export function insideDistance(alpha: Uint8ClampedArray | Uint8Array, w: number, h: number, stride = 4, off = 3, thr = 127): Float32Array {
  const INF = 1e9, d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = alpha[i * stride + off] > thr ? INF : 0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!d[i]) continue;
    d[i] = Math.min(d[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + 1.4142, at(x + 1, y - 1) + 1.4142);
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (!d[i]) continue;
    d[i] = Math.min(d[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + 1.4142, at(x - 1, y + 1) + 1.4142);
  }
  return d;
}

/** One layer's height field (0..~1.5) from its depth, outline and drawn lines. */
export function layerHeight(t: EdTexture, depth: number, inner: boolean): Float32Array {
  const { w, h, rgba } = t;
  const dist = insideDistance(rgba, w, h);
  const r = Math.max(3, Math.min(48, Math.min(w, h) * (inner ? 0.25 : 0.18)));
  const H = new Float32Array(w * h);
  const base = 0.5 + Math.max(-0.5, Math.min(0.5, depth)) * 0.6;
  for (let i = 0; i < w * h; i++) {
    if (rgba[i * 4 + 3] < 8) { H[i] = 0; continue; }
    const t1 = Math.min(1, dist[i] / r);
    const dome = Math.sin((t1 * Math.PI) / 2); // rounded edge, flat top
    // drawn lines (dark, strong local contrast) sit a little lower: the light catches the strokes
    const lum = (0.3 * rgba[i * 4] + 0.59 * rgba[i * 4 + 1] + 0.11 * rgba[i * 4 + 2]) / 255;
    const groove = lum < 0.32 ? (0.32 - lum) * 0.5 : 0;
    H[i] = base * (inner ? 0.5 : 1) + dome * (inner ? 0.15 : 0.45) - groove;
  }
  return H;
}

/** Normals from a height field (Sobel), packed as RGB (alpha 255). */
export function normalsFrom(H: Float32Array, w: number, h: number, strength: number, out: Uint8ClampedArray, stride: number, ox: number, oy: number, alpha?: Uint8ClampedArray) {
  const at = (x: number, y: number) => H[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (alpha && alpha[(y * w + x) * 4 + 3] < 8) continue;
    const gx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)) / 8;
    const gy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)) / 8;
    let nx = -gx * strength, ny = gy * strength, nz = 1; // +Y up: an image-down slope tilts the normal up
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const o = ((oy + y) * stride + ox + x) * 4;
    out[o] = (nx * 0.5 + 0.5) * 255; out[o + 1] = (ny * 0.5 + 0.5) * 255; out[o + 2] = (nz * 0.5 + 0.5) * 255; out[o + 3] = 255;
  }
}

/** Build the maps for an atlas (`places[i]` = where texture i sits on which page). */
export function buildMaps(doc: EdDoc, textures: EdTexture[], places: { page: number; x: number; y: number }[], sizes: { w: number; h: number }[]): LightMaps {
  const flat = (s: { w: number; h: number }, v: [number, number, number, number]) => { const rgba = new Uint8ClampedArray(s.w * s.h * 4); for (let i = 0; i < s.w * s.h; i++) rgba.set(v, i * 4); return { w: s.w, h: s.h, rgba }; };
  const normal = sizes.map((s) => flat(s, [128, 128, 255, 255]));
  const rim = sizes.map((s) => flat(s, [0, 0, 0, 255]));
  const glows = doc.meshes.some((m) => (m.glow ?? 0) > 0);
  const emission = glows ? sizes.map((s) => flat(s, [0, 0, 0, 0])) : null;
  const rimW = Math.max(1, doc.extras?.lighting?.rimPx ?? 6);
  const byTex = new Map<number, (typeof doc.meshes)[number]>();
  for (const m of doc.meshes) if (!byTex.has(m.tex)) byTex.set(m.tex, m);
  textures.forEach((t, i) => {
    const pl = places[i];
    if (!pl) return;
    const m = byTex.get(i);
    if (!m || doc.textures[i]?.kind === 'sprite') return; // sprites: flat, no rim
    const inner = INNER.has(m.role);
    const H = layerHeight(t, m.depth, inner);
    const pg = normal[pl.page];
    normalsFrom(H, t.w, t.h, Math.max(8, Math.min(t.w, t.h) * 0.06), pg.rgba, pg.w, pl.x, pl.y, t.rgba);
    if (!inner) {
      const dist = insideDistance(t.rgba, t.w, t.h);
      const rp = rim[pl.page];
      for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) {
        const k = y * t.w + x;
        if (t.rgba[k * 4 + 3] < 8) continue;
        const v = Math.max(0, 1 - dist[k] / rimW) * 255;
        const o = ((pl.y + y) * rp.w + pl.x + x) * 4;
        rp.rgba[o] = rp.rgba[o + 1] = rp.rgba[o + 2] = v;
      }
    }
    const g = Math.max(0, Math.min(1, m.glow ?? 0));
    if (emission && g > 0) {
      const ep = emission[pl.page];
      for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) {
        const k = (y * t.w + x) * 4, o = ((pl.y + y) * ep.w + pl.x + x) * 4;
        ep.rgba[o] = t.rgba[k] * g; ep.rgba[o + 1] = t.rgba[k + 1] * g; ep.rgba[o + 2] = t.rgba[k + 2] * g; ep.rgba[o + 3] = t.rgba[k + 3];
      }
    }
  });
  return { normal, rim, emission };
}
