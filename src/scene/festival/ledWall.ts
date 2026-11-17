// Festival LED walls: every FX_LEDWALL_<group>_<nn> mesh (a plane / disc with 0..1 UVs) shows procedural, beat-synced
// content in LED pixels: tunnel, kaleidoscope, spectrum, plasma, warp, the room's logo, a perspective grid, rings, fire,
// a scanner, a starfield, colour bars, a strobe card - plus an eye (walls with role 'eye': an iris that looks around,
// dilates on the kick and blinks on the phrase), the countdown into a drop, the show title, and the photosensitivity
// warning when the streamer turned flashing lights on. Room-only visuals (never picked by the look generator): a
// heartbeat (a glowing core pulsing on the kick: a throat sac), glyphs (a carved script lighting in a scan), rain on
// stone, a sigil burning in. Eyes can have horizontal SLIT pupils (walls `pupil: 'slit'`, a toad's) and open / close
// (an endshow's eye cue). One material per wall (same program), one small canvas for text (the title, a countdown,
// the warning, a scripted show's carved lore line) redrawn only when it changes; the moving parts are uniforms.
import * as THREE from 'three';
import { WALL_VISUALS } from '../../../shared/festivalLooks.ts';
import { WALL_RATES } from '../../../shared/festivalWall.ts';
import { PACK_WALLS, PACK_WALL_GLSL } from '../../../shared/showPack/walls.ts';

// (the motion rates are written into the shader from shared/festivalWall.ts, the CPU mirror the flash unit measures)
const RT = (x: number) => x.toFixed(4);

// (show-pack patterns from index 19: shared/showPack/walls.ts)
const VIS = [...WALL_VISUALS, 'strobe', 'countdown', 'eye', 'heartbeat', 'glyphs', 'rain', 'sigil', ...PACK_WALLS] as const;
export const visualIndex = (v: string) => Math.max(0, (VIS as readonly string[]).indexOf(v));

const VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uT, uBeat, uKick, uEnergy, uMode, uNext, uMix, uTextAmt, uFlash, uAspect, uPix, uMirror, uLevel, uLogoAmt, uHasLogo, uBlack, uSeed, uDrop, uVUp, uSlit, uOpen, uSwell;
uniform vec3 uIris;
uniform vec3 uA, uB, uC;
uniform sampler2D uText; uniform sampler2D uLogo;
#define PI 3.14159265
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { return 0.5 * n2(p) + 0.25 * n2(p * 2.1) + 0.125 * n2(p * 4.3) + 0.0625 * n2(p * 8.7); }
vec3 pal(float t) { t = fract(t); return t < 0.333 ? mix(uA, uB, t * 3.0) : t < 0.666 ? mix(uB, uC, (t - 0.333) * 3.0) : mix(uC, uA, (t - 0.666) * 3.0); }
vec3 logo(vec2 uv, float k) {
  vec2 c = (uv - 0.5) * vec2(uAspect, 1.0) / (0.78 + 0.06 * k);
  vec2 luv = c + 0.5;
  if (uHasLogo < 0.5 || luv.x < 0.0 || luv.x > 1.0 || luv.y < 0.0 || luv.y > 1.0) return vec3(0.0);
  vec4 l = texture2D(uLogo, vec2(luv.x, 1.0 - luv.y));
  return l.rgb * l.a * (0.8 + 0.6 * k);
}
// room-only visuals: 15 heartbeat, 16 glyphs, 17 rain on stone, 18 sigil
vec3 roomVisual(float m, vec2 uv, vec2 c, float r, float a, float k) {
  if (m < 15.5) {           // heartbeat: a glowing core pulsing on the kick, veins crawling out, swelling with uSwell
    float core = exp(-r * (3.2 - 1.6 * uSwell)) * (0.35 + 0.65 * k + 0.5 * uSwell);
    float veins = smoothstep(0.82, 1.0, fbm(vec2(a * 3.0, r * 6.0 - uT * 0.4))) * smoothstep(0.9, 0.1, r) * (0.4 + 0.6 * k);
    return (uA * core * 1.4 + uB * veins * 0.8 + vec3(1.0, 1.0, 0.8) * pow(core, 3.0) * 0.4) * (0.6 + 0.4 * uEnergy);
  }
  if (m < 16.5) {           // glyphs: cells of a carved script lighting up in a slow scan (a quarter bar per column)
    vec2 g = uv * vec2(14.0 * uAspect / 1.78, 6.0); vec2 id = floor(g), f = fract(g) - 0.5;
    float h = hash(id + 3.1);
    float stroke = max(step(abs(f.x + (h - 0.5) * 0.4), 0.06) * step(abs(f.y), 0.36), step(abs(f.y - (hash(id + 7.7) - 0.5) * 0.5), 0.06) * step(abs(f.x), 0.3 * h + 0.1));
    stroke = max(stroke, step(abs(length(f) - 0.28), 0.05) * step(0.7, h));
    float scan = smoothstep(0.25, 0.0, abs(fract(id.x / 14.0 - uBeat / 16.0) - 0.5) - 0.25);
    return mix(vec3(0.02, 0.018, 0.012), uA * 1.3, stroke * (0.12 + 0.88 * scan)) + vec3(0.9, 0.6, 0.15) * stroke * scan * 0.25 * k;
  }
  if (m < 17.5) {           // rain on stone: falling streaks over a dark slab, the drops catching the palette
    float cols = 60.0 * uAspect / 1.78, col = floor(uv.x * cols);
    float sp = 0.5 + hash(vec2(col, 1.0)) * 0.6;
    float y = fract(uv.y * 1.0 + uT * sp + hash(vec2(col, 2.0)));
    float drop = smoothstep(0.92, 1.0, y) * step(0.45, hash(vec2(col, floor(uT * sp + hash(vec2(col, 2.0))))));
    float stone = 0.04 + 0.05 * fbm(uv * vec2(8.0, 4.0));
    return vec3(stone) * vec3(0.8, 0.9, 1.0) + uA * drop * 0.9 + uB * 0.05 * k;
  }
  // sigil: a ring, two horned eye marks and a mouth line, burning in on the drop (uDrop) and breathing on the kick
  float ring = smoothstep(0.02, 0.0, abs(r - 0.36)) + smoothstep(0.012, 0.0, abs(r - 0.42)) * 0.6;
  vec2 e1 = c - vec2(-0.13, 0.07), e2 = c - vec2(0.13, 0.07);
  float eyes = smoothstep(0.015, 0.0, abs(length(e1 / vec2(1.6, 1.0)) - 0.05)) + smoothstep(0.015, 0.0, abs(length(e2 / vec2(1.6, 1.0)) - 0.05));
  float horns = smoothstep(0.014, 0.0, abs(c.y - 0.18 - abs(c.x) * 0.9)) * step(0.1, abs(c.x)) * step(abs(c.x), 0.24);
  float mouth = smoothstep(0.012, 0.0, abs(c.y + 0.1 + 0.25 * c.x * c.x)) * step(abs(c.x), 0.22);
  float s = clamp(ring + eyes + horns + mouth, 0.0, 1.0);
  float burn = clamp(uDrop * 1.4 + 0.25, 0.0, 1.0) * (0.7 + 0.3 * k);
  return mix(vec3(0.015, 0.012, 0.01), mix(uA, vec3(1.0, 0.75, 0.25), 0.45) * 1.6, s * burn) + uA * 0.03 * smoothstep(0.5, 0.0, r);
}
${PACK_WALL_GLSL}
vec3 visual(float m, vec2 uv) {
  if (m > 18.5) return packVisual(m - 19.0, uv);
  vec2 c = (uv - 0.5) * vec2(uAspect, 1.0);
  float r = length(c), a = atan(c.y, c.x);
  float bp = fract(uBeat), k = uKick;
  if (m < 0.5) {            // tunnel of squares
    float d = max(abs(c.x), abs(c.y));
    float z = fract(log(d + 0.02) * 1.8 - uBeat * 0.5);
    return pal(floor(log(d + 0.02) * 1.8 - uBeat * 0.5) * 0.17) * smoothstep(0.12, 0.0, abs(z - 0.5) - 0.32) * (0.5 + 0.7 * k);
  }
  if (m < 1.5) {            // kaleidoscope
    float s = 6.0; float aa = mod(a + uT * 0.15, 2.0 * PI / s) - PI / s; vec2 p = vec2(cos(aa), abs(sin(aa))) * r;
    float f = fbm(p * 4.0 + vec2(uBeat * 0.25, 0.0));
    return pal(f * 1.5 + r - uBeat * 0.0625) * smoothstep(0.35, 0.75, f + 0.25 * k) * 1.2;
  }
  if (m < 2.5) {            // spectrum
    float n = 40.0, i = floor(uv.x * n), mi = abs(i - n * 0.5) / (n * 0.5);
    float h = 0.08 + 0.75 * uEnergy * (0.45 + 0.55 * n2(vec2(i * 0.37, uBeat * ${RT(WALL_RATES.spectrum)}))) * (1.0 - 0.45 * mi) + 0.3 * k * (1.0 - mi);
    float y = 1.0 - uv.y;
    float bar = smoothstep(h + 0.07, h - 0.07, y) * step(0.18, fract(uv.x * n));          // (a soft top: no hard edge sweeping a patch)
    float cap = smoothstep(0.04, 0.0, abs(y - h - 0.08)) * step(0.18, fract(uv.x * n)) * 0.2;
    return mix(uA, uB, y / max(0.01, h)) * bar * (0.8 + 0.5 * k) + uC * cap;
  }
  if (m < 3.5) {            // plasma
    float v = sin(c.x * 5.0 + uT) + sin(c.y * 4.0 - uT * 1.2) + sin((c.x + c.y) * 3.0 + uBeat * PI * 0.5) + sin(r * 6.0 - uT * 2.0);
    return pal(v * 0.125 + uBeat * 0.03) * (0.5 + 0.3 * k + 0.2 * uEnergy);
  }
  if (m < 4.5) {            // warp streaks
    float s = hash(vec2(floor(a * 40.0), 3.0)); float z = fract(s * 7.0 + uT * ${RT(WALL_RATES.warp)} * (0.3 + 0.7 * uEnergy));
    float st = smoothstep(0.08, 0.0, abs(r - z * 1.6)) * step(0.45, s) * sin(PI * z);   // (streaks fade in and out)
    return pal(s) * st * 2.0 + pal(r) * (0.12 + 0.05 * k);
  }
  if (m < 5.5) {            // logo on a pulsing field
    vec3 bg = pal(r * 0.6 - uBeat * 0.125) * (0.12 + 0.25 * smoothstep(0.1, 0.0, abs(fract(r * 2.0 - uBeat * 0.5) - 0.5) - 0.2) * k);
    vec3 lg = logo(uv, k);
    return uHasLogo > 0.5 ? bg + lg : bg + pal(0.2) * smoothstep(0.32, 0.3, r) * (0.5 + 0.6 * k);
  }
  if (m < 6.5) {            // perspective grid
    float hz = 0.42; vec2 p = uv;
    if (p.y > hz) { float d = 1.0 / max(0.001, p.y - hz); vec2 g = vec2((p.x - 0.5) * d, d + uBeat * ${RT(WALL_RATES.grid)});
      float l = max(smoothstep(0.06, 0.0, abs(fract(g.x * 0.5) - 0.5) - 0.44), smoothstep(0.06, 0.0, abs(fract(g.y * 0.25) - 0.5) - 0.44));
      return pal(g.y * 0.02) * l * min(1.0, (p.y - hz) * 4.0) * (0.7 + 0.5 * k); }
    float sun = smoothstep(0.2, 0.19, length((p - vec2(0.5, 0.3)) * vec2(uAspect, 1.0))) * step(0.5, fract(p.y * 30.0 + uT * 0.5) + (0.42 - p.y) * 3.0);
    return mix(uA, uB, p.y / hz) * sun * (0.8 + 0.4 * k);
  }
  if (m < 7.5) {            // rings on the kick
    float ring = fract(r * 2.5 - uBeat * ${RT(WALL_RATES.rings)});
    return pal(floor(r * 2.5 - uBeat * ${RT(WALL_RATES.rings)}) * 0.21) * smoothstep(0.12, 0.0, abs(ring - 0.5) - 0.3) * (0.4 + 0.9 * k);
  }
  if (m < 8.5) {            // fire
    vec2 p = vec2(uv.x * uAspect * 2.0, (1.0 - uv.y) * 2.0);
    float f = fbm(p * vec2(2.0, 1.0) + vec2(0.0, -uT * ${RT(WALL_RATES.fire)})) * (1.25 - (1.0 - uv.y) * 1.1) + 0.08 * k;
    // a smooth ramp black -> red -> orange -> white-hot (hard bands stepped a patch 0.79 -> 0.54 -> 0.26 as they scrolled)
    float r1 = smoothstep(0.26, 0.44, f), r2 = smoothstep(0.42, 0.6, f), r3 = smoothstep(0.58, 0.76, f);
    vec3 fire = mix(mix(vec3(0.8, 0.12, 0.02) * r1, vec3(1.0, 0.55, 0.08), r2), vec3(1.0, 0.95, 0.7), r3);
    return mix(fire, fire * uA * 1.5, 0.25);
  }
  if (m < 9.5) {            // scanner bar
    float y = 0.5 + 0.45 * sin(uBeat * PI * ${RT(WALL_RATES.scanner)});
    return pal(uv.x * 0.5 + uBeat * 0.05) * (exp(-pow((uv.y - y) / 0.09, 2.0)) * 1.4 + 0.05) + uB * smoothstep(0.01, 0.0, abs(uv.x - fract(uBeat * ${RT(WALL_RATES.scanner * 0.5)}))) * 0.6;
  }
  if (m < 10.5) {           // starfield
    vec2 p = c * 3.0; vec3 col = vec3(0.0);
    for (int i = 0; i < 3; i++) { float z = fract(float(i) * 0.33 + uT * ${RT(WALL_RATES.stars)} * (1.0 + uEnergy)); vec2 q = p / (z * 2.0 + 0.1); vec2 g = floor(q * 4.0); float h = hash(g + float(i) * 7.0);
      col += pal(h) * step(0.93, h) * smoothstep(0.25, 0.0, length(fract(q * 4.0) - 0.5)) * sin(PI * z) * 1.6; }
    return col + uA * 0.03 * k + pal(r * 0.4 + 0.1) * 0.07;   // (a faint nebula: no star lights a black patch)
  }
  if (m < 11.5) {           // colour bars chase
    float n = 8.0, i = floor(uv.x * n);
    float on = smoothstep(0.3, 0.0, abs(fract((i / n) - uBeat * 0.25) - 0.5) - 0.1);
    return pal(i / n + floor(uBeat / 4.0) * 0.25) * (0.15 + 0.85 * on) * (0.7 + 0.4 * k);
  }
  if (m < 12.5) return vec3(1.0) * k;            // strobe card (k is the governed kick)
  if (m < 13.5) return pal(0.0) * 0.08;           // countdown backdrop (the numbers are text)
  if (m > 14.5) return roomVisual(m, uv, c, r, a, k);
  // eye: iris + pupil looking around, dilating on the kick, blinking on the phrase, spiralling on the drop
  vec2 look = vec2(sin(uBeat * 0.37 + uSeed) * 0.13, cos(uBeat * 0.23 + uSeed * 2.0) * 0.08) * (uSlit > 0.5 ? 0.5 : 1.0);
  vec2 e = (uv - 0.5) * vec2(uAspect, 1.0);
  float blink = smoothstep(0.85, 1.0, fract(uBeat / 32.0)) * (1.0 - smoothstep(0.97, 1.0, fract(uBeat / 32.0))) * 4.0;
  float lid = smoothstep(0.0, 0.02, 0.5 * uOpen - abs(e.y) - blink * 0.5);
  vec2 q = e - look; float rq = length(q), aq = atan(q.y, q.x);
  float iris = smoothstep(0.31, 0.29, rq);
  float pupil;
  if (uSlit > 0.5) {
    // a toad's horizontal slit: a lens shape that widens on the kick and opens to a dark oval on the drop
    vec2 sq = q / vec2(0.27 + 0.03 * k, 0.03 + 0.04 * k + 0.12 * uDrop);
    pupil = smoothstep(1.06, 0.94, length(sq));
  } else {
    float pupilR = 0.11 + 0.06 * k + 0.05 * uDrop;
    pupil = smoothstep(pupilR + 0.01, pupilR - 0.01, rq);
  }
  vec3 ir = mix(uA, uB, 0.5 + 0.5 * sin(aq * 9.0 + rq * 30.0)) * (0.7 + 0.5 * smoothstep(0.31, 0.12, rq));
  if (uSlit > 0.5) ir = mix(uIris, uIris * vec3(0.5, 0.45, 0.15), 0.5 + 0.5 * sin(aq * 23.0 + rq * 41.0)) * (0.6 + 0.8 * smoothstep(0.31, 0.06, rq)) + uA * 0.12;
  ir = mix(ir, pal(aq / (2.0 * PI) + rq * 3.0 - uBeat * 0.5), uDrop * (uSlit > 0.5 ? 0.35 : 1.0));
  vec3 white = uSlit > 0.5 ? vec3(0.32, 0.2, 0.04) : vec3(0.92, 1.0, 0.85) * 0.85;
  vec3 col = mix(white, ir, iris);
  col = mix(col, vec3(0.0), pupil);
  col += vec3(1.0) * smoothstep(0.045, 0.0, length(q - vec2(-0.08, 0.09))) * (uSlit > 0.5 ? 0.35 : 0.9);
  // (slit eyes glow: the iris is a light, not a print)
  return col * lid * (0.15 + 0.85 * uOpen) * (uSlit > 0.5 ? 1.8 : 1.0);
}
void main() {
  // vuv: x left → right as the audience sees it, y = 0 at the TOP (the mesh's own UV orientation is measured in JS)
  vec2 vuv = vec2(vUv.x, uVUp > 0.5 ? 1.0 - vUv.y : vUv.y);
  if (uMirror > 0.5) vuv.x = 1.0 - vuv.x;
  vec2 grid = vec2(floor(uPix * uAspect), uPix);
  vec2 cell = floor(vuv * grid); vec2 uv = (cell + 0.5) / grid;
  vec2 f = fract(vuv * grid) - 0.5;
  float led = smoothstep(0.5, 0.3, length(f));
  vec3 col = mix(visual(uMode, uv), visual(uNext, uv), uMix);
  col = mix(col, col * 0.2 + logo(uv, uKick) * 1.2, uLogoAmt * uHasLogo);
  col *= uLevel * (1.0 - uBlack);
  // the text layer (title, countdown, the lore line, the warning) at its own level: readable on a dim wall
  vec4 tx = texture2D(uText, vec2(uv.x, 1.0 - uv.y));
  col = mix(col * (1.0 - 0.8 * uTextAmt * tx.a), tx.rgb * (1.1 + 0.5 * uKick) * max(0.75, uLevel), tx.a * uTextAmt);
  col += vec3(1.0) * uFlash;
  gl_FragColor = vec4(col * led * 1.8 + col * 0.05, 1.0);
}`;

/** How a wall mesh's UVs run as the audience sees it (the side its face normal points to): does u grow to the
 *  viewer's right, does v grow upwards? Measured from the geometry, so any room's walls read right. */
export function uvOrientation(mesh: THREE.Mesh): { flipX: boolean; vUp: boolean } {
  const g = mesh.geometry, pos = g.getAttribute('position'), uv = g.getAttribute('uv'), nor = g.getAttribute('normal');
  if (!pos || !uv) return { flipX: false, vUp: true };
  mesh.updateWorldMatrix(true, false);
  const m = mesh.matrixWorld, nm = new THREE.Matrix3().getNormalMatrix(m);
  const n = new THREE.Vector3();
  if (nor) { for (let i = 0; i < nor.count; i++) n.add(new THREE.Vector3().fromBufferAttribute(nor, i).applyMatrix3(nm)); }
  if (n.lengthSq() < 1e-8) n.set(0, 0, 1);
  n.normalize();
  const up = new THREE.Vector3(0, 1, 0).addScaledVector(n, -n.y);
  if (up.lengthSq() < 1e-4) up.set(0, 0, -1);
  up.normalize();
  const right = new THREE.Vector3().crossVectors(up, n).normalize();
  let su = 0, sv = 0;
  const p = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) c.add(p.fromBufferAttribute(pos, i).applyMatrix4(m));
  c.multiplyScalar(1 / Math.max(1, pos.count));
  for (let i = 0; i < pos.count; i++) { p.fromBufferAttribute(pos, i).applyMatrix4(m).sub(c); su += p.dot(right) * (uv.getX(i) - 0.5); sv += p.dot(up) * (uv.getY(i) - 0.5); }
  return { flipX: su < 0, vUp: sv >= 0 };
}

export interface WallFrame {
  t: number; beat: number; kick: number; energy: number; level: number; black: number; flash: number; drop: number;
  a: THREE.Color; b: THREE.Color; c: THREE.Color;
  mode: number; next: number; mix: number;
  /** logo moment 0..1 (drop hits) */
  logo: number;
  /** the eyes open 0..1 (a scripted show's eye cue; 1 = open) and the swell node 0..1 (the heartbeat grows with it) */
  open?: number; swell?: number;
}
export interface WallText { title: string; count: number | null; warn: 'off' | 'badge' | 'card'; show: string;
  /** a scripted show's lore line (carved serif, gold), shown instead of the title */
  lore?: string }

export class LedWalls {
  readonly walls: { mesh: THREE.Mesh; orig: THREE.Material | THREE.Material[]; mat: THREE.ShaderMaterial; role: 'main' | 'side' | 'eye'; visual: string | null; seed: number }[] = [];
  private canvas = document.createElement('canvas');
  private tex: THREE.CanvasTexture;
  private logoTex: THREE.Texture | null = null;
  private key = '';
  private base: THREE.ShaderMaterial;

  constructor(meshes: { mesh: THREE.Mesh; role: 'main' | 'side' | 'eye'; visual?: string; mirror?: boolean; pupil?: 'round' | 'slit'; iris?: string }[], pixPerMetre = 7.5) {
    this.canvas.width = 1024; this.canvas.height = 512;
    this.tex = new THREE.CanvasTexture(this.canvas); this.tex.colorSpace = THREE.SRGBColorSpace;
    const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1); blank.needsUpdate = true;
    this.base = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, toneMapped: false, fog: false, side: THREE.DoubleSide,
      uniforms: {
        uT: { value: 0 }, uBeat: { value: 0 }, uKick: { value: 0 }, uEnergy: { value: 0 }, uMode: { value: 0 }, uNext: { value: 1 }, uMix: { value: 0 },
        uTextAmt: { value: 0 }, uFlash: { value: 0 }, uAspect: { value: 1.78 }, uPix: { value: 96 }, uMirror: { value: 0 }, uLevel: { value: 1 }, uLogoAmt: { value: 0 }, uHasLogo: { value: 0 },
        uBlack: { value: 0 }, uSeed: { value: 0 }, uDrop: { value: 0 }, uVUp: { value: 1 }, uSlit: { value: 0 }, uOpen: { value: 1 }, uSwell: { value: 0 }, uIris: { value: new THREE.Color(1.0, 0.68, 0.16) },
        uA: { value: new THREE.Color() }, uB: { value: new THREE.Color() }, uC: { value: new THREE.Color() }, uText: { value: this.tex }, uLogo: { value: blank },
      },
    });
    this.base.name = 'festival:ledwall';
    const mainAsp: number[] = [];
    meshes.forEach((w, i) => {
      const mat = this.base.clone();
      mat.uniforms.uText.value = this.tex; mat.uniforms.uLogo.value = blank;
      w.mesh.geometry.computeBoundingBox();
      const bb = w.mesh.geometry.boundingBox!; const s = w.mesh.getWorldScale(new THREE.Vector3());
      const sz = bb.getSize(new THREE.Vector3()).multiply(s);
      const dims = [sz.x, sz.y, sz.z].sort((a, b) => b - a);
      // aspect from the UV-mapped plane: the two big extents, wider one horizontal for walls (eyes: round)
      const aspect = w.role === 'eye' ? 1 : Math.max(0.2, Math.min(8, sz.y > 0.01 ? Math.max(sz.x, sz.z) / sz.y : dims[0] / Math.max(0.01, dims[1])));
      mat.uniforms.uAspect.value = aspect;
      if (w.role === 'main') mainAsp.push(aspect);
      mat.uniforms.uPix.value = Math.max(32, Math.min(200, Math.round((w.role === 'eye' ? dims[0] : Math.min(sz.y || dims[1], dims[1])) * pixPerMetre)));
      const o = uvOrientation(w.mesh);
      mat.uniforms.uMirror.value = (w.mirror ? 1 : 0) ^ (o.flipX ? 1 : 0);
      mat.uniforms.uVUp.value = o.vUp ? 1 : 0;
      mat.uniforms.uSeed.value = i * 1.7;
      mat.uniforms.uSlit.value = w.pupil === 'slit' ? 1 : 0;
      mat.uniforms.uIris.value = w.iris ? new THREE.Color(w.iris) : new THREE.Color(1.0, 0.68, 0.16);
      this.walls.push({ mesh: w.mesh, orig: w.mesh.material, mat, role: w.role, visual: w.visual ?? null, seed: i });
      w.mesh.material = mat;
    });
    if (mainAsp.length && mainAsp[0] > 3) { this.canvas.width = 2048; this.canvas.height = Math.max(96, Math.min(512, Math.round(2048 / mainAsp[0]))); this.tex.dispose(); this.tex = new THREE.CanvasTexture(this.canvas); this.tex.colorSpace = THREE.SRGBColorSpace; for (const w of this.walls) w.mat.uniforms.uText.value = this.tex; }
    this.text({ title: '', count: null, warn: 'off', show: '' });
  }

  setLogo(img: HTMLImageElement | ImageBitmap) {
    // copied through a canvas: a GLB's texture is an ImageBitmap, which WebGL never flips (flipY is ignored for it), so
    // the emblem came out upside down; a canvas uploads the same way as an <img>
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.min(1024, img.width)); cv.height = Math.max(1, Math.round(cv.width * img.height / Math.max(1, img.width)));
    cv.getContext('2d')!.drawImage(img, 0, 0, cv.width, cv.height);
    this.logoTex?.dispose();
    this.logoTex = new THREE.CanvasTexture(cv); this.logoTex.colorSpace = THREE.SRGBColorSpace; this.logoTex.needsUpdate = true;
    for (const w of this.walls) { w.mat.uniforms.uLogo.value = this.logoTex; w.mat.uniforms.uHasLogo.value = 1; }
  }

  /** the text layer (main walls): title / countdown / photosensitivity warning; redrawn only on change */
  text(t: WallText) {
    const key = JSON.stringify(t);
    if (key === this.key) return;
    this.key = key;
    const g = this.canvas.getContext('2d')!;
    const W = this.canvas.width, H = this.canvas.height;
    g.clearRect(0, 0, W, H);
    const glowText = (txt: string, x: number, y: number, px: number, col: string, blur = 24) => {
      g.font = `900 ${px}px Impact, "Arial Black", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.shadowColor = col; g.shadowBlur = blur; g.fillStyle = col; g.fillText(txt, x, y);
      g.shadowBlur = 0; g.fillStyle = '#ffffff'; g.globalAlpha = 0.6; g.fillText(txt, x, y); g.globalAlpha = 1;
    };
    const k = H / 512;                                  // (the canvas follows the main wall's shape)
    if (t.count != null) glowText(String(t.count), W / 2, H * 0.5, Math.round(380 * k), '#ffffff', 40);
    else if (t.lore) {
      let px = Math.round(92 * k * (W / H > 4 ? 1.9 : 1)); const font = (n: number) => `700 ${n}px Georgia, "Times New Roman", serif`;
      g.font = font(px); while (px > 20 && g.measureText(t.lore).width > W * 0.92) { px -= 4; g.font = font(px); }
      g.textAlign = 'center'; g.textBaseline = 'middle';
      const grad = g.createLinearGradient(0, H * 0.4, 0, H * 0.6); grad.addColorStop(0, '#ffe6a0'); grad.addColorStop(0.5, '#e0a43a'); grad.addColorStop(1, '#8a5a12');
      g.shadowColor = '#ffb030'; g.shadowBlur = 26; g.fillStyle = grad; g.fillText(t.lore, W / 2, H * 0.5);
      g.shadowBlur = 0; g.strokeStyle = 'rgba(40,20,0,0.8)'; g.lineWidth = 2; g.strokeText(t.lore, W / 2, H * 0.5);
    }
    else if (t.title) { let px = Math.round(150 * k); g.font = `900 ${px}px Impact`; while (px > 40 && g.measureText(t.title).width > W * 0.9) { px -= 6; g.font = `900 ${px}px Impact`; } glowText(t.title, W / 2, H * 0.48, px, '#ffd84a', 30); }
    if (t.warn !== 'off') {
      const card = t.warn === 'card';
      g.fillStyle = card ? 'rgba(0,0,0,0.82)' : 'rgba(0,0,0,0.65)';
      const bh = card ? H * 0.42 : H * 0.12;
      g.fillRect(0, H - bh, W, bh);
      g.font = `900 ${Math.round((card ? 54 : 40) * Math.max(0.6, k))}px "Segoe UI", Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#ffd400';
      g.fillText('⚠ FLASHING LIGHTS', W / 2, H - bh + (card ? bh * 0.33 : bh / 2));
      if (card) { g.font = `600 ${Math.round(34 * Math.max(0.6, k))}px "Segoe UI", Arial, sans-serif`; g.fillStyle = '#ffffff'; g.fillText('This show uses strobe effects that may affect photosensitive viewers.', W / 2, H - bh * 0.32); }
    }
    this.tex.needsUpdate = true;
  }

  // what the walls SHOW: a visual switch always cross-fades over >= 0.6 s from what is on the wall now (the director's
  // own mix could jump - a section change one frame without its previous look drew the next visual for one frame: a
  // one-frame flash of a 32 x 18 m wall), and the text layer fades in / out over 0.5 s (it used to switch on / off)
  private xf = { from: -1, to: -1, m: 1, t: NaN, text: 0 };

  update(f: WallFrame, wallVisual: Record<string, string | undefined>, textAmt: number) {
    const X = this.xf;
    const dt = Number.isFinite(X.t) ? Math.min(0.25, Math.max(0, f.t - X.t)) : 0; X.t = f.t;
    if (X.to < 0) { X.from = f.next; X.to = f.next; X.m = 1; }
    else if (f.next !== X.to) { X.from = X.m < 0.5 ? X.from : X.to; X.to = f.next; X.m = 0; }
    X.m = Math.min(1, X.m + dt / 0.6);
    X.text += Math.max(-dt / 0.5, Math.min(dt / 0.5, textAmt - X.text));
    const mode = X.from, next = X.to, mix = X.m * X.m * (3 - 2 * X.m);
    textAmt = X.text;
    for (const w of this.walls) {
      const u = w.mat.uniforms;
      u.uT.value = f.t; u.uBeat.value = f.beat; u.uKick.value = f.kick; u.uEnergy.value = f.energy; u.uLevel.value = f.level; u.uBlack.value = f.black; u.uDrop.value = f.drop;
      const own = w.role === 'eye' ? visualIndex('eye') : w.visual ? visualIndex(w.visual) : -1;
      u.uMode.value = own >= 0 ? own : mode; u.uNext.value = own >= 0 ? own : next; u.uMix.value = own >= 0 ? 0 : mix;
      u.uFlash.value = w.role === 'eye' ? f.flash * 0.3 : f.flash;
      u.uOpen.value = f.open ?? 1; u.uSwell.value = f.swell ?? 0;
      u.uLogoAmt.value = w.role === 'main' ? f.logo : w.role === 'side' ? f.logo * 0.5 : 0;
      u.uTextAmt.value = w.role === 'main' ? textAmt : 0;
      (u.uA.value as THREE.Color).copy(f.a); (u.uB.value as THREE.Color).copy(f.b); (u.uC.value as THREE.Color).copy(f.c);
      void wallVisual;
    }
  }

  dispose() {
    for (const w of this.walls) { w.mesh.material = w.orig; w.mat.dispose(); }
    this.base.dispose(); this.tex.dispose(); this.logoTex?.dispose();
  }
}
