// Show pack: LED wall patterns (festival LED walls + the club's pixel ceiling) - GLSL for the renderers and a CPU
// mirror of the same formulas (the photosensitivity units measure what a patch of the wall DRAWS from it). KEEP THE TWO
// IN STEP: every formula below exists twice (packWallColor / PACK_WALL_GLSL).
// Every pattern moves on the beat the rig passes (half / quarter time with Safe flashes ON) and changes softly: cross-
// fades and travelling bands instead of hard on / off cells, so a patch never turns more than ~1-2 times a second.
// The GLSL uses the LED wall shader's helpers (hash, n2, fbm, pal) and uniforms (uT, uBeat, uKick, uEnergy, uA/uB/uC).
import type { WallInput } from '../festivalWall.ts';

export const PACK_WALLS = ['pk_bars', 'pk_meter', 'pk_rain', 'pk_zoom', 'pk_flash', 'pk_shock', 'pk_halves', 'pk_slabs', 'pk_blocks', 'pk_check', 'pk_eq', 'pk_stripes',
  'pk_aurora', 'pk_gradient', 'pk_horizon', 'pk_nebula', 'pk_sunrise', 'pk_stars', 'pk_ripple', 'pk_matrix'] as const;
export type PackWall = (typeof PACK_WALLS)[number];
export const PACK_WALL_NAMES: Record<PackWall, string> = {
  pk_bars: 'Bars', pk_meter: 'Meter', pk_rain: 'Rain', pk_zoom: 'Zoom', pk_flash: 'Flash', pk_shock: 'Shock', pk_halves: 'Halves', pk_slabs: 'Slabs', pk_blocks: 'Blocks',
  pk_check: 'Check', pk_eq: 'EQ', pk_stripes: 'Stripes', pk_aurora: 'Aurora', pk_gradient: 'Gradient', pk_horizon: 'Horizon', pk_nebula: 'Nebula', pk_sunrise: 'Sunrise',
  pk_stars: 'Stars', pk_ripple: 'Ripple', pk_matrix: 'Matrix',
};
export const isPackWall = (v: string): v is PackWall => (PACK_WALLS as readonly string[]).includes(v);

type V3 = [number, number, number];
const fract = (x: number) => x - Math.floor(x);
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smooth = (e0: number, e1: number, x: number) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const step = (e: number, x: number) => (x < e ? 0 : 1);
const hash = (x: number, y: number) => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);
function n2(x: number, y: number) {
  const ix = Math.floor(x), iy = Math.floor(y); let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
}
const fbm = (x: number, y: number) => 0.5 * n2(x, y) + 0.25 * n2(x * 2.1, y * 2.1) + 0.125 * n2(x * 4.3, y * 4.3) + 0.0625 * n2(x * 8.7, y * 8.7);
const mix3 = (p: readonly number[], q: readonly number[], t: number): V3 => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
const mul = (p: readonly number[], k: number): V3 => [p[0] * k, p[1] * k, p[2] * k];
const add = (p: readonly number[], q: readonly number[]): V3 => [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
function pal(f: WallInput, t: number): V3 {
  t = fract(t);
  return t < 0.333 ? mix3(f.a, f.b, t * 3) : t < 0.666 ? mix3(f.b, f.c, (t - 0.333) * 3) : mix3(f.c, f.a, (t - 0.666) * 3);
}

/** the colour (linear rgb) of pack pattern `vis` at LED-cell uv (v = 0 at the top) - as PACK_WALL_GLSL draws it */
export function packWallColor(vis: string, u: number, v: number, f: WallInput): V3 {
  const cx = (u - 0.5) * f.aspect, cy = v - 0.5;
  const r = Math.hypot(cx, cy), k = f.kick, B = f.beat, T = f.t, E = f.energy;
  switch (vis) {
    case 'pk_bars': {
      const n = 16, i = Math.floor(u * n), y = 1 - v;
      const h = 0.15 + 0.7 * n2(i * 0.71, B * 0.25) * (0.55 + 0.45 * E);
      const bar = smooth(h + 0.06, h - 0.06, y) * step(0.15, fract(u * n));
      return mul(mix3(f.a, f.b, clamp(y / Math.max(0.05, h), 0, 1)), bar * (0.75 + 0.35 * k));
    }
    case 'pk_meter': {
      const y = 1 - v, rows = 10, lvl = (Math.floor(y * rows) + 0.5) / rows;
      const fl = fract(B / 4), fill = 0.12 + 0.88 * fl * (0.5 + 0.5 * E);
      const on = smooth(lvl - 0.04, lvl + 0.04, fill) * (1 - smooth(0.88, 1, fl)) * step(0.12, fract(y * rows));
      return mul(pal(f, lvl * 0.5), 0.1 + on * (0.9 + 0.3 * k));
    }
    case 'pk_rain': {
      const cols = 40 * f.aspect / 1.78, col = Math.floor(u * cols), sp = 0.15 + hash(col, 1) * 0.2;
      const y = fract(v * 0.6 - T * sp + hash(col, 2));
      const drop = smooth(0.55, 1, y) * step(0.35, hash(col, 5));
      return add(mul(pal(f, hash(col, 3) * 0.6 + B * 0.03), drop * 1.1), mul(f.a, 0.05 + 0.05 * k));
    }
    case 'pk_zoom': {
      const d = Math.max(Math.abs(cx), Math.abs(cy)), z = d * 3 - B * 0.25;
      const band = smooth(0.18, 0, Math.abs(fract(z) - 0.5) - 0.22);
      return mul(pal(f, Math.floor(z) * 0.2), band * (0.5 + 0.6 * k));
    }
    case 'pk_flash': return mul(pal(f, B * 0.0625), (0.22 + 0.78 * k) * (0.6 + 0.4 * clamp(1 - r, 0, 1)));
    case 'pk_shock': {
      const R = fract(B) * 1.4, ring = Math.exp(-Math.pow((r - R) / 0.07, 2)) * (1 - 0.6 * fract(B));
      return add(mul(pal(f, Math.floor(B) * 0.25), ring * 1.2), mul(f.a, 0.07));
    }
    case 'pk_halves': {
      const w = 0.5 + 0.5 * Math.cos(Math.PI * B), left = u < 0.5;
      const lv = left ? w : 1 - w;
      return mul(left ? f.a : f.b, 0.12 + 0.88 * lv * (0.8 + 0.25 * k));
    }
    case 'pk_slabs': {
      const y = 1 - v, rows = 8, rc = (Math.floor(y * rows) + 0.5), pos = fract(B / 4) * (rows + 2) - 1;
      const lit = smooth(1.7, 0.6, Math.abs(rc - pos)) * step(0.1, fract(y * rows));
      return add(mul(pal(f, rc / rows * 0.6), lit * (0.85 + 0.3 * k)), mul(f.c, 0.05));
    }
    case 'pk_blocks': {
      const blk = Math.floor(u * 4), cur = ((Math.floor(B) % 4) + 4) % 4, w = smooth(0.6, 1, fract(B));
      const lit = blk === cur ? 1 - 0.75 * w : blk === (cur + 1) % 4 ? 0.25 + 0.75 * w : 0.12;
      return mul(pal(f, blk * 0.25), lit * (0.8 + 0.3 * k) * step(0.04, fract(u * 4)));
    }
    case 'pk_check': {
      const par = (Math.floor(u * 4) + Math.floor(v * 2)) % 2, w = 0.5 + 0.5 * Math.cos(Math.PI * B / 2);
      const lit = par ? w : 1 - w;
      return mul(par ? f.a : f.b, 0.1 + 0.9 * lit);
    }
    case 'pk_eq': {
      const n = 24, i = Math.floor(u * n), mi = Math.abs(i + 0.5 - n * 0.5) / (n * 0.5), y = 1 - v;
      const h = 0.1 + 0.6 * E * (0.5 + 0.5 * n2(mi * 3, B * 0.35)) * (1 - 0.5 * mi) + 0.2 * k * (1 - mi);
      const bar = smooth(h + 0.06, h - 0.06, y) * step(0.16, fract(u * n));
      return mul(mix3(f.b, f.a, clamp(y / Math.max(0.05, h), 0, 1)), bar);
    }
    case 'pk_stripes': {
      const z = (u * f.aspect + v) * 3 - B * 0.125, s = fract(z);
      const st = smooth(0.3, 0.16, Math.abs(s - 0.5));
      return mul(pal(f, Math.floor(z) * 0.25), 0.08 + st * (0.8 + 0.3 * k));
    }
    case 'pk_aurora': {
      const y0 = 0.45 + 0.15 * Math.sin(u * 6 + T * 0.3) + 0.08 * n2(u * 3, T * 0.2);
      const band = Math.exp(-Math.pow((v - y0) / 0.12, 2)) * (0.6 + 0.4 * fbm(u * 8, T * 0.1));
      return add(mul(mix3(f.a, f.c, v), band * 1.2), mul(f.b, 0.04 + 0.03 * k));
    }
    case 'pk_gradient': return mul(pal(f, v * 0.6 + B / 64), 0.35 + 0.15 * Math.sin(u * 3 + T * 0.2) + 0.1 * k);
    case 'pk_horizon': {
      const y = 0.32 + 0.05 * Math.sin(B * Math.PI / 8);
      const band = Math.exp(-Math.pow((v - y) / 0.05, 2)) + 0.3 * Math.exp(-Math.pow((v - y) / 0.2, 2));
      return add(mul(mix3(f.a, f.b, clamp(v * 1.4, 0, 1)), 0.12), mul(f.c, band * (0.8 + 0.2 * k)));
    }
    case 'pk_nebula': { const ff = fbm(cx * 2 + T * 0.05, cy * 2 - T * 0.03); return mul(pal(f, ff * 1.2 + B / 64), smooth(0.3, 0.8, ff) * (0.75 + 0.15 * k)); }
    case 'pk_sunrise': {
      const s = fract(B / 32), dy = (v - (1.05 - s * 0.6));
      const disc = smooth(0.27, 0.24, Math.hypot(cx, dy)), glow = Math.exp(-Math.hypot(cx, dy) * 3) * 0.5;
      return add(mul(mix3(f.a, f.b, clamp(v, 0, 1)), 0.08 + 0.25 * s * (1 - v)), mul(f.c, disc * 0.9 + glow));
    }
    case 'pk_stars': {
      const gx = u * 30 * f.aspect / 1.78, gy = v * 12, cxi = Math.floor(gx), cyi = Math.floor(gy), h = hash(cxi, cyi);
      const tw = Math.pow(0.5 + 0.5 * Math.sin(T * 1.2 + h * 40), 6) * step(0.68, h);
      const dot = smooth(0.35, 0.1, Math.hypot(fract(gx) - 0.5, fract(gy) - 0.5));
      return add(mul(pal(f, h), tw * dot * 1.3), mul(pal(f, r * 0.4 + 0.1), 0.06));
    }
    case 'pk_ripple': {
      const R = fract(B / 4) * 1.2, ring = Math.exp(-Math.pow((r - R) / 0.08, 2)) * (1 - 0.7 * fract(B / 4));
      return add(mul(pal(f, Math.floor(B / 4) * 0.3), ring), mul(f.a, 0.06 + 0.04 * k));
    }
    case 'pk_matrix': {
      const gx = Math.floor(u * 16), gy = Math.floor(v * 8), k0 = Math.floor(B / 2), w = smooth(0.7, 1, fract(B / 2));
      const on = (kk: number) => (hash(gx + kk * 17, gy + kk * 5) < 0.3 ? 1 : 0);
      const lit = on(k0) + (on(k0 + 1) - on(k0)) * w;
      return mul(pal(f, hash(gx, gy)), (0.08 + 0.92 * lit) * step(0.1, fract(u * 16)) * step(0.1, fract(v * 8)));
    }
  }
  return [0, 0, 0];
}

/** GLSL: `vec3 packVisual(float m, vec2 uv)` - m = index in PACK_WALLS. Pasted into the LED wall shader after its helpers. */
export const PACK_WALL_GLSL = /* glsl */ `
vec3 packVisual(float m, vec2 uv) {
  vec2 c = (uv - 0.5) * vec2(uAspect, 1.0);
  float r = length(c), k = uKick, B = uBeat, T = uT, E = uEnergy;
  if (m < 0.5) {            // bars
    float n = 16.0, i = floor(uv.x * n), y = 1.0 - uv.y;
    float h = 0.15 + 0.7 * n2(vec2(i * 0.71, B * 0.25)) * (0.55 + 0.45 * E);
    float bar = smoothstep(h + 0.06, h - 0.06, y) * step(0.15, fract(uv.x * n));
    return mix(uA, uB, clamp(y / max(0.05, h), 0.0, 1.0)) * bar * (0.75 + 0.35 * k);
  }
  if (m < 1.5) {            // meter
    float y = 1.0 - uv.y, rows = 10.0, lvl = (floor(y * rows) + 0.5) / rows;
    float fl = fract(B / 4.0), fill = 0.12 + 0.88 * fl * (0.5 + 0.5 * E);
    float on = smoothstep(lvl - 0.04, lvl + 0.04, fill) * (1.0 - smoothstep(0.88, 1.0, fl)) * step(0.12, fract(y * rows));
    return pal(lvl * 0.5) * (0.1 + on * (0.9 + 0.3 * k));
  }
  if (m < 2.5) {            // rain
    float cols = 40.0 * uAspect / 1.78, col = floor(uv.x * cols), sp = 0.15 + hash(vec2(col, 1.0)) * 0.2;
    float y = fract(uv.y * 0.6 - T * sp + hash(vec2(col, 2.0)));
    float drop = smoothstep(0.55, 1.0, y) * step(0.35, hash(vec2(col, 5.0)));
    return pal(hash(vec2(col, 3.0)) * 0.6 + B * 0.03) * drop * 1.1 + uA * (0.05 + 0.05 * k);
  }
  if (m < 3.5) {            // zoom
    float d = max(abs(c.x), abs(c.y)), z = d * 3.0 - B * 0.25;
    float band = smoothstep(0.18, 0.0, abs(fract(z) - 0.5) - 0.22);
    return pal(floor(z) * 0.2) * band * (0.5 + 0.6 * k);
  }
  if (m < 4.5) return pal(B * 0.0625) * (0.22 + 0.78 * k) * (0.6 + 0.4 * clamp(1.0 - r, 0.0, 1.0));   // flash
  if (m < 5.5) {            // shock
    float R = fract(B) * 1.4, ring = exp(-pow((r - R) / 0.07, 2.0)) * (1.0 - 0.6 * fract(B));
    return pal(floor(B) * 0.25) * ring * 1.2 + uA * 0.07;
  }
  if (m < 6.5) {            // halves
    float w = 0.5 + 0.5 * cos(PI * B); bool left = uv.x < 0.5;
    float lv = left ? w : 1.0 - w;
    return (left ? uA : uB) * (0.12 + 0.88 * lv * (0.8 + 0.25 * k));
  }
  if (m < 7.5) {            // slabs
    float y = 1.0 - uv.y, rows = 8.0, rc = floor(y * rows) + 0.5, pos = fract(B / 4.0) * (rows + 2.0) - 1.0;
    float lit = smoothstep(1.7, 0.6, abs(rc - pos)) * step(0.1, fract(y * rows));
    return pal(rc / rows * 0.6) * lit * (0.85 + 0.3 * k) + uC * 0.05;
  }
  if (m < 8.5) {            // blocks
    float blk = floor(uv.x * 4.0), cur = mod(floor(B), 4.0), w = smoothstep(0.6, 1.0, fract(B));
    float lit = abs(blk - cur) < 0.5 ? 1.0 - 0.75 * w : abs(blk - mod(cur + 1.0, 4.0)) < 0.5 ? 0.25 + 0.75 * w : 0.12;
    return pal(blk * 0.25) * lit * (0.8 + 0.3 * k) * step(0.04, fract(uv.x * 4.0));
  }
  if (m < 9.5) {            // check
    float par = mod(floor(uv.x * 4.0) + floor(uv.y * 2.0), 2.0), w = 0.5 + 0.5 * cos(PI * B / 2.0);
    float lit = par > 0.5 ? w : 1.0 - w;
    return (par > 0.5 ? uA : uB) * (0.1 + 0.9 * lit);
  }
  if (m < 10.5) {           // eq (centre-mirrored)
    float n = 24.0, i = floor(uv.x * n), mi = abs(i + 0.5 - n * 0.5) / (n * 0.5), y = 1.0 - uv.y;
    float h = 0.1 + 0.6 * E * (0.5 + 0.5 * n2(vec2(mi * 3.0, B * 0.35))) * (1.0 - 0.5 * mi) + 0.2 * k * (1.0 - mi);
    float bar = smoothstep(h + 0.06, h - 0.06, y) * step(0.16, fract(uv.x * n));
    return mix(uB, uA, clamp(y / max(0.05, h), 0.0, 1.0)) * bar;
  }
  if (m < 11.5) {           // stripes
    float z = (uv.x * uAspect + uv.y) * 3.0 - B * 0.125, s = fract(z);
    float st = smoothstep(0.3, 0.16, abs(s - 0.5));
    return pal(floor(z) * 0.25) * (0.08 + st * (0.8 + 0.3 * k));
  }
  if (m < 12.5) {           // aurora
    float y0 = 0.45 + 0.15 * sin(uv.x * 6.0 + T * 0.3) + 0.08 * n2(vec2(uv.x * 3.0, T * 0.2));
    float band = exp(-pow((uv.y - y0) / 0.12, 2.0)) * (0.6 + 0.4 * fbm(vec2(uv.x * 8.0, T * 0.1)));
    return mix(uA, uC, uv.y) * band * 1.2 + uB * (0.04 + 0.03 * k);
  }
  if (m < 13.5) return pal(uv.y * 0.6 + B / 64.0) * (0.35 + 0.15 * sin(uv.x * 3.0 + T * 0.2) + 0.1 * k);   // gradient
  if (m < 14.5) {           // horizon
    float y = 0.32 + 0.05 * sin(B * PI / 8.0);
    float band = exp(-pow((uv.y - y) / 0.05, 2.0)) + 0.3 * exp(-pow((uv.y - y) / 0.2, 2.0));
    return mix(uA, uB, clamp(uv.y * 1.4, 0.0, 1.0)) * 0.12 + uC * band * (0.8 + 0.2 * k);
  }
  if (m < 15.5) { float ff = fbm(vec2(c.x * 2.0 + T * 0.05, c.y * 2.0 - T * 0.03)); return pal(ff * 1.2 + B / 64.0) * smoothstep(0.3, 0.8, ff) * (0.75 + 0.15 * k); }   // nebula
  if (m < 16.5) {           // sunrise
    float s = fract(B / 32.0), dy = uv.y - (1.05 - s * 0.6);
    float disc = smoothstep(0.27, 0.24, length(vec2(c.x, dy))), glow = exp(-length(vec2(c.x, dy)) * 3.0) * 0.5;
    return mix(uA, uB, clamp(uv.y, 0.0, 1.0)) * (0.08 + 0.25 * s * (1.0 - uv.y)) + uC * (disc * 0.9 + glow);
  }
  if (m < 17.5) {           // stars
    float gx = uv.x * 30.0 * uAspect / 1.78, gy = uv.y * 12.0; float h = hash(vec2(floor(gx), floor(gy)));
    float tw = pow(0.5 + 0.5 * sin(T * 1.2 + h * 40.0), 6.0) * step(0.68, h);
    float dot2 = smoothstep(0.35, 0.1, length(vec2(fract(gx) - 0.5, fract(gy) - 0.5)));
    return pal(h) * tw * dot2 * 1.3 + pal(r * 0.4 + 0.1) * 0.06;
  }
  if (m < 18.5) {           // ripple
    float R = fract(B / 4.0) * 1.2, ring = exp(-pow((r - R) / 0.08, 2.0)) * (1.0 - 0.7 * fract(B / 4.0));
    return pal(floor(B / 4.0) * 0.3) * ring + uA * (0.06 + 0.04 * k);
  }
  // matrix
  float gx = floor(uv.x * 16.0), gy = floor(uv.y * 8.0), k0 = floor(B / 2.0), w = smoothstep(0.7, 1.0, fract(B / 2.0));
  float on0 = hash(vec2(gx + k0 * 17.0, gy + k0 * 5.0)) < 0.3 ? 1.0 : 0.0, on1 = hash(vec2(gx + (k0 + 1.0) * 17.0, gy + (k0 + 1.0) * 5.0)) < 0.3 ? 1.0 : 0.0;
  float lit = on0 + (on1 - on0) * w;
  return pal(hash(vec2(gx, gy))) * (0.08 + 0.92 * lit) * step(0.1, fract(uv.x * 16.0)) * step(0.1, fract(uv.y * 8.0));
}`;
