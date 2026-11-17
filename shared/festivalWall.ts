// A CPU mirror of the festival LED walls' generator-pickable visuals (src/scene/festival/ledWall.ts, `visual()` for
// WALL_VISUALS): the same formulas, evaluated per LED cell, so tools/festival_gov_unit.ts can measure what a wall DRAWS
// over a patch of its surface (the WCAG "flash area": a 1 m patch from a booth camera, 2 m from the crowd, ~4 m from
// the wide shot) and fail when a pattern flashes a patch more than 3 times a second. KEEP IN STEP with the GLSL: any
// change to a visual there is made here too (the unit is only as good as this copy).
import { isPackWall, packWallColor } from './showPack/walls.ts';

export interface WallInput {
  /** seconds (uT), the beat the walls see (half time above 180 BPM, as the rig passes it), the governed kick 0..1 */
  t: number; beat: number; kick: number; energy: number;
  /** palette, LINEAR rgb 0..1 */
  a: readonly number[]; b: readonly number[]; c: readonly number[];
  aspect: number;
}
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
const lum = (p: readonly number[]) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
function pal(f: WallInput, t: number): V3 {
  t = fract(t);
  return t < 0.333 ? mix3(f.a, f.b, t * 3) : t < 0.666 ? mix3(f.b, f.c, (t - 0.333) * 3) : mix3(f.c, f.a, (t - 0.666) * 3);
}

/** the colour (linear rgb) of visual `vis` at LED-cell uv (y = 0 at the top), as ledWall.ts draws it before level / flash */
export function wallColor(vis: string, u: number, v: number, f: WallInput): V3 {
  const cx = (u - 0.5) * f.aspect, cy = v - 0.5;
  const r = Math.hypot(cx, cy), a = Math.atan2(cy, cx), k = f.kick;
  switch (vis) {
    case 'tunnel': {
      const d = Math.max(Math.abs(cx), Math.abs(cy));
      const z = fract(Math.log(d + 0.02) * 1.8 - f.beat * 0.5);
      return mul(pal(f, Math.floor(Math.log(d + 0.02) * 1.8 - f.beat * 0.5) * 0.17), smooth(0.12, 0, Math.abs(z - 0.5) - 0.32) * (0.5 + 0.7 * k));
    }
    case 'kaleido': {
      const s = 6, seg = (2 * Math.PI) / s;
      const aa = (((a + f.t * 0.15) % seg) + seg) % seg - Math.PI / s;
      const px = Math.cos(aa) * r, py = Math.abs(Math.sin(aa)) * r;
      const ff = fbm(px * 4 + f.beat * 0.25, py * 4);
      return mul(pal(f, ff * 1.5 + r - f.beat * 0.0625), smooth(0.35, 0.75, ff + 0.25 * k) * 1.2);
    }
    case 'spectrum': {
      const n = 40, i = Math.floor(u * n), mi = Math.abs(i - n * 0.5) / (n * 0.5);
      const h = 0.08 + 0.75 * f.energy * (0.45 + 0.55 * n2(i * 0.37, f.beat * WALL_RATES.spectrum)) * (1 - 0.45 * mi) + 0.3 * k * (1 - mi);
      const y = 1 - v;
      const col = step(0.18, fract(u * n));
      const bar = smooth(h + 0.07, h - 0.07, y) * col;                                   // (a soft top: no hard edge sweeping a patch)
      const cap = smooth(0.04, 0, Math.abs(y - h - 0.08)) * col * 0.2;
      return add(mul(mix3(f.a, f.b, y / Math.max(0.01, h)), bar * (0.8 + 0.5 * k)), mul(f.c, cap));
    }
    case 'plasma': {
      const vv = Math.sin(cx * 5 + f.t) + Math.sin(cy * 4 - f.t * 1.2) + Math.sin((cx + cy) * 3 + f.beat * Math.PI * 0.5) + Math.sin(r * 6 - f.t * 2);
      return mul(pal(f, vv * 0.125 + f.beat * 0.03), 0.5 + 0.3 * k + 0.2 * f.energy);
    }
    case 'warp': {
      const s = hash(Math.floor(a * 40), 3); const z = fract(s * 7 + f.t * WALL_RATES.warp * (0.3 + 0.7 * f.energy));
      const st = smooth(0.08, 0, Math.abs(r - z * 1.6)) * step(0.45, s) * Math.sin(Math.PI * z);   // (streaks fade in and out)
      return add(mul(pal(f, s), st * 2), mul(pal(f, r), 0.12 + 0.05 * k));
    }
    case 'logo': {        // (no logo texture: the fallback disc on the pulsing field)
      const bg = mul(pal(f, r * 0.6 - f.beat * 0.125), 0.12 + 0.25 * smooth(0.1, 0, Math.abs(fract(r * 2 - f.beat * 0.5) - 0.5) - 0.2) * k);
      return add(bg, mul(pal(f, 0.2), smooth(0.32, 0.3, r) * (0.5 + 0.6 * k)));
    }
    case 'grid': {
      const hz = 0.42, py = v;
      if (py > hz) {
        const d = 1 / Math.max(0.001, py - hz); const gx = (u - 0.5) * d, gy = d + f.beat * WALL_RATES.grid;
        const l = Math.max(smooth(0.06, 0, Math.abs(fract(gx * 0.5) - 0.5) - 0.44), smooth(0.06, 0, Math.abs(fract(gy * 0.25) - 0.5) - 0.44));
        return mul(pal(f, gy * 0.02), l * Math.min(1, (py - hz) * 4) * (0.7 + 0.5 * k));
      }
      const sun = smooth(0.2, 0.19, Math.hypot((u - 0.5) * f.aspect, py - 0.3)) * step(0.5, fract(py * 30 + f.t * 0.5) + (0.42 - py) * 3);
      return mul(mix3(f.a, f.b, py / hz), sun * (0.8 + 0.4 * k));
    }
    case 'rings': {
      const ring = fract(r * 2.5 - f.beat * WALL_RATES.rings);
      return mul(pal(f, Math.floor(r * 2.5 - f.beat * WALL_RATES.rings) * 0.21), smooth(0.12, 0, Math.abs(ring - 0.5) - 0.3) * (0.4 + 0.9 * k));
    }
    case 'fire': {
      const px = u * f.aspect * 2, py = (1 - v) * 2;
      const ff = fbm(px * 2, py - f.t * WALL_RATES.fire) * (1.25 - (1 - v) * 1.1) + 0.08 * k;
      const fire = WALL_RATES.fireSmooth ? fireRamp(ff) : (ff > 0.62 ? [1.0, 0.95, 0.7] : ff > 0.48 ? [1.0, 0.55, 0.08] : ff > 0.36 ? [0.8, 0.12, 0.02] : [0, 0, 0]) as V3;
      return mix3(fire, [fire[0] * f.a[0] * 1.5, fire[1] * f.a[1] * 1.5, fire[2] * f.a[2] * 1.5], 0.25);
    }
    case 'scanner': {
      const y = 0.5 + 0.45 * Math.sin(f.beat * Math.PI * WALL_RATES.scanner);
      return add(mul(pal(f, u * 0.5 + f.beat * 0.05), Math.exp(-Math.pow((v - y) / 0.09, 2)) * 1.4 + 0.05), mul(f.b, smooth(0.01, 0, Math.abs(u - fract(f.beat * WALL_RATES.scanner * 0.5))) * 0.6));
    }
    case 'starfield': {
      let col: V3 = [0, 0, 0];
      const qx0 = cx * 3, qy0 = cy * 3;
      for (let i = 0; i < 3; i++) {
        const z = fract(i * 0.33 + f.t * WALL_RATES.stars * (1 + f.energy)); const qx = qx0 / (z * 2 + 0.1), qy = qy0 / (z * 2 + 0.1);
        const h = hash(Math.floor(qx * 4) + i * 7, Math.floor(qy * 4) + i * 7);
        col = add(col, mul(pal(f, h), step(0.93, h) * smooth(0.25, 0, Math.hypot(fract(qx * 4) - 0.5, fract(qy * 4) - 0.5)) * Math.sin(Math.PI * z) * 1.6));
      }
      return add(add(col, mul(f.a, 0.03 * k)), mul(pal(f, r * 0.4 + 0.1), 0.07));   // (a faint nebula: no star lights a black patch)
    }
    case 'bars': {
      const n = 8, i = Math.floor(u * n);
      const on = smooth(0.3, 0, Math.abs(fract(i / n - f.beat * 0.25) - 0.5) - 0.1);
      return mul(pal(f, i / n + Math.floor(f.beat / 4) * 0.25), (0.15 + 0.85 * on) * (0.7 + 0.4 * k));
    }
    default: return isPackWall(vis) ? packWallColor(vis, u, v, f) : [0, 0, 0];
  }
}

/** the pulse the walls breathe on with Safe flashes ON: a smooth cosine with its peaks and troughs on the stage gate's
 *  windows (every beat up to 180 BPM, every 2nd beat above; src/scene/festival/gov.ts), one pulse per FOUR windows
 *  (<= 0.75 a second): slow by construction, so the rig does not pass it through the governor (that would hold it at
 *  the peak and step it at the next window). With the limit off the walls take the governed kick. */
export function wallPulse(beat: number, bpm: number): number {
  const P = 60000 / bpm, n = P >= 666 ? 2 : P >= 333 ? 1 : P >= 166 ? 0.5 : 0.25;   // windows per beat (as gov.ts)
  const ph = (beat * n) / 4;                                                                // one pulse per 4 windows
  return 0.5 + 0.5 * Math.cos(2 * Math.PI * (ph - Math.floor(ph)));
}

/** Safe flashes ON: the walls run at this fraction of the beat (up to 180 BPM / above) and of the clock */
export const WALL_CALM = { slow: 0.5, fast: 0.25, t: 0.5 };

// the motion rates the GLSL uses (ledWall.ts writes the same numbers into its shader source)
export const WALL_RATES = {
  /** fire scrolls this many noise units a second (was 2.5: its blobs flickered a patch 5-7 times a second) */
  fire: 0.35,
  /** rings: one ring passes a point every 1 / rings beats */
  rings: 0.35,
  /** scanner: the bar's sine runs this many half-cycles a beat (a full sweep up + down every 4 / scanner beats); the
   *  vertical line crosses once per 2 / scanner beats */
  scanner: 0.25,
  /** spectrum: the bars' height noise steps this many cells a beat */
  spectrum: 0.35,
  /** grid: the floor lines run this many units a beat */
  grid: 1.0,
  /** warp: streak speed factor (was 1); starfield: depth drift a second (was 0.12) */
  warp: 0.25,
  stars: 0.05,
  /** 1 = fire's smooth ramp, 0 = the old four hard bands (for comparison only) */
  fireSmooth: 1,
};

/** fire's colour for a heat value: a smooth ramp black -> red -> orange -> white-hot (no hard bands: a band edge sweeping
 *  over a patch is a luminance step) */
export function fireRamp(h: number): V3 {
  const r1 = smooth(0.26, 0.44, h), r2 = smooth(0.42, 0.6, h), r3 = smooth(0.58, 0.76, h);
  const c1: V3 = [0.8 * r1, 0.12 * r1, 0.02 * r1];
  const c2 = mix3(c1, [1.0, 0.55, 0.08], r2);
  return mix3(c2, [1.0, 0.95, 0.7], r3);
}

/** the relative luminance a patch of the wall shows: the mean over the LED cells inside the patch (cell centres), times
 *  the wall's level, plus the white flash (as ledWall.ts composes them; the dot mask is a constant factor) */
export function patchLum(vis: string, f: WallInput, pu: number, pv: number, pw: number, ph: number, level: number, flash: number, cells = 8): number {
  let s = 0;
  for (let i = 0; i < cells; i++) for (let j = 0; j < cells; j++) s += lum(wallColor(vis, pu + ((i + 0.5) / cells - 0.5) * pw, pv + ((j + 0.5) / cells - 0.5) * ph, f));
  return (s / (cells * cells)) * level + flash;
}
