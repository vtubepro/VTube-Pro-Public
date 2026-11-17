// Colour-grading LUTs: a 32³ cube stored as a 1024×32 strip (32 blue slices side by side, sRGB in → sRGB out), built in
// JS from a small grade description (lift / gamma / gain, white balance, split toning, a gentle S-curve, saturation
// by luminance). A room can ship its own strip as `lut.png` in its folder (same layout) — see docs/SCENES.md.
import * as THREE from 'three';

export interface GradeSpec {
  /** Added to the shadows (sRGB, ±0.1 typical). */
  lift?: [number, number, number];
  /** Power on the mids (1 = none, < 1 brightens). */
  gamma?: [number, number, number];
  /** Multiplies the highlights. */
  gain?: [number, number, number];
  /** White balance: + warm / − cool (−1..1), + magenta / − green tint (−1..1). */
  temp?: number;
  tint?: number;
  /** Split toning: colour pushed into the shadows / highlights (hex) and how much (0..1). */
  shadows?: string; shadowAmt?: number;
  highlights?: string; highlightAmt?: number;
  /** S-curve strength (0 = none). */
  curve?: number;
  /** Saturation multiplier (1 = none); `satShadows` extra for the darks (anime shadows stay colourful). */
  sat?: number;
  satShadows?: number;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
function hex(h: string | undefined): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(h ?? '');
  if (!m) return [0.5, 0.5, 0.5];
  const n = parseInt(m[1], 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Grade one sRGB colour (0..1). */
export function gradeColor(r: number, g: number, b: number, s: GradeSpec): [number, number, number] {
  let c = [r, g, b];
  // white balance (simple channel gains around neutral)
  const t = s.temp ?? 0, ti = s.tint ?? 0;
  const wb = [1 + 0.08 * t + 0.02 * ti, 1 - 0.04 * ti, 1 - 0.1 * t + 0.02 * ti];
  c = c.map((v, i) => v * wb[i]);
  // lift / gamma / gain
  const lift = s.lift ?? [0, 0, 0], gam = s.gamma ?? [1, 1, 1], gain = s.gain ?? [1, 1, 1];
  c = c.map((v, i) => Math.pow(clamp01(v * gain[i] + lift[i] * (1 - v)), 1 / Math.max(0.2, gam[i])));
  // S-curve (smoothstep blend around 0.5)
  const k = s.curve ?? 0;
  if (k) c = c.map((v) => { const sm = v * v * (3 - 2 * v); return v + (sm - v) * k; });
  // split toning by luminance
  const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  if (s.shadows && s.shadowAmt) { const col = hex(s.shadows), w = (1 - L) * (1 - L) * s.shadowAmt; c = c.map((v, i) => v + (col[i] - 0.5) * w * 0.6); }
  if (s.highlights && s.highlightAmt) { const col = hex(s.highlights), w = L * L * s.highlightAmt; c = c.map((v, i) => v + (col[i] - 0.5) * w * 0.6); }
  // saturation (more in the shadows if asked)
  const L2 = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const sat = (s.sat ?? 1) + (s.satShadows ?? 0) * (1 - L2);
  c = c.map((v) => L2 + (v - L2) * sat);
  return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
}

/** Build the strip texture. */
export function buildLut(spec: GradeSpec): THREE.DataTexture {
  const N = 32, W = N * N;
  const data = new Uint8Array(W * N * 4);
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
    const o = (g * W + b * N + r) * 4;
    const [R, G, B] = gradeColor(r / (N - 1), g / (N - 1), b / (N - 1), spec);
    data[o] = Math.round(R * 255); data[o + 1] = Math.round(G * 255); data[o + 2] = Math.round(B * 255); data[o + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, W, N, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace;          // values are used as-is (sRGB → sRGB)
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
