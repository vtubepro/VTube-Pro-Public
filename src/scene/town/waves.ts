// Town engine — the sea surface as a sum of Gerstner waves, evaluated identically on the CPU (boats riding the
// swell, spray timing) and in the water shader (GLSL generated from the same table). World space (three.js / glTF:
// +Y up). `storm` 0..1 scales amplitude + steepness (weather), `calm` 0..1 damps everything near the quay.

export interface Wave { dir: [number, number]; len: number; amp: number; steep: number; speed: number }

/** Harbour swell rolling in from the open sea (−Z world = +Y Blender = out to sea) + chop. */
export const WAVES: Wave[] = [
  { dir: [0.18, 1.0], len: 22, amp: 0.16, steep: 0.35, speed: 1.0 },
  { dir: [-0.45, 1.0], len: 11, amp: 0.09, steep: 0.45, speed: 1.0 },
  { dir: [0.8, 0.6], len: 6.3, amp: 0.045, steep: 0.5, speed: 1.0 },
  { dir: [-0.9, 0.35], len: 3.1, amp: 0.02, steep: 0.55, speed: 1.0 },
];

const G = 9.81;
const norm = (d: [number, number]) => { const l = Math.hypot(d[0], d[1]) || 1; return [d[0] / l, d[1] / l] as [number, number]; };
const W = WAVES.map((w) => {
  const k = (2 * Math.PI) / w.len;
  return { d: norm(w.dir), k, c: Math.sqrt(G / k) * w.speed, amp: w.amp, steep: w.steep, len: w.len };
});

export interface SeaSample { y: number; dx: number; dz: number; nx: number; nz: number }

/** Height (relative to the still level) + horizontal displacement + surface slope at world (x, z), time t (s).
 *  The storm factor multiplies amplitudes ×(1 + 2.2·storm). */
export function seaAt(x: number, z: number, t: number, storm = 0, out: SeaSample = { y: 0, dx: 0, dz: 0, nx: 0, nz: 0 }): SeaSample {
  let y = 0, dx = 0, dz = 0, sx = 0, sz = 0;
  const ampK = 1 + 2.2 * storm;
  for (const w of W) {
    // waves travel towards the shore: +Z world (the harbour side is +Z = towards the camera / quay)
    const f = w.k * (w.d[0] * x + w.d[1] * z) - w.k * w.c * t;
    const a = w.amp * ampK;
    const q = w.steep / (w.k * a * W.length + 1e-6) * Math.min(1, 0.6 + storm);
    const c = Math.cos(f), s = Math.sin(f);
    y += a * s;
    dx += q * a * w.d[0] * c;
    dz += q * a * w.d[1] * c;
    sx += w.k * a * w.d[0] * c;
    sz += w.k * a * w.d[1] * c;
  }
  out.y = y; out.dx = dx; out.dz = dz; out.nx = -sx; out.nz = -sz;
  return out;
}

/** GLSL: vec3 seaDisp(vec2 xz, float t, float storm, out vec3 n) — same waves as seaAt. */
export function seaGLSL(): string {
  const lines = W.map((w, i) => `
    { vec2 d = vec2(${w.d[0].toFixed(5)}, ${w.d[1].toFixed(5)}); float k = ${w.k.toFixed(5)}; float c = ${w.c.toFixed(5)};
      float a = ${w.amp.toFixed(5)} * ampK * fade${i < 2 ? 'L' : 'H'};
      float q = ${w.steep.toFixed(5)} / (k * a * ${W.length.toFixed(1)} + 1e-6) * min(1.0, 0.6 + storm);
      float f = k * dot(d, xz) - k * c * t; float cs = cos(f); float sn = sin(f);
      p.y += a * sn; p.x += q * a * d.x * cs; p.z += q * a * d.y * cs; sl += k * a * d * cs; }`).join('');
  return `
  vec3 seaDisp(vec2 xz, float t, float storm, float fadeL, float fadeH, out vec2 sl) {
    float ampK = 1.0 + 2.2 * storm;
    vec3 p = vec3(0.0); sl = vec2(0.0);
    ${lines}
    return p;
  }`;
}
