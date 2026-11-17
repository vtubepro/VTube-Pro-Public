// Warzone effects, immediate-mode and instanced: the whole battle (every explosion, plume, trail and tracer) is redrawn
// each frame from the plan (a pure function of the clock), into five pools = five draw calls whatever happens:
//   · lit smoke   — alpha billboards shaded as soft spheres: sun side / shadow side, the fire glowing from under a fresh
//                   blast, the scene's fog; noise-eroded edges (no textures)
//   · glow        — additive: fireballs, flashes, flare stars, muzzle flashes, sparks, embers, shock rings
//   · streaks     — additive: tracers, rocket motors, jet afterburners, AA fire, with a minimum on-screen width
//   · scorch      — flat dark ground marks under fresh craters (fade over a minute)
//   · debris      — tumbling chunks (instanced low-poly rocks, toon shaded)
// Every pool dims inside the performers' face boxes and vanishes inside the React screen (it may be an OBS hole).
import * as THREE from 'three';

export const GLOW = { soft: 0, flare: 1, fire: 2, ring: 3, spark: 4, core: 5 } as const;
const MAX_HOLD = 8;

const HOLD_GLSL = /* glsl */ `
uniform vec4 uHold[${MAX_HOLD}]; uniform float uHoldK[${MAX_HOLD}]; uniform int uHoldN; uniform vec2 uRes;
float holdK() {
  vec2 p = gl_FragCoord.xy / uRes;
  float k = 1.0;
  for (int i = 0; i < ${MAX_HOLD}; i++) {
    if (i >= uHoldN) break;
    vec4 r = uHold[i];
    vec2 d = abs(p - r.xy) - r.zw;
    float o = 1.0 - smoothstep(0.0, 0.02, max(d.x, d.y));
    k = min(k, 1.0 - o * uHoldK[i]);
  }
  return k;
}`;
const NOISE_GLSL = /* glsl */ `
float wzH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wzN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(wzH(i), wzH(i + vec2(1, 0)), f.x), mix(wzH(i + vec2(0, 1)), wzH(i + vec2(1, 1)), f.x), f.y); }`;
const FOG_GLSL = /* glsl */ `
uniform vec3 uFogCol; uniform vec2 uFog;
vec3 wzFog(vec3 c, float strength) { float f = clamp((vDepth - uFog.x) / max(1.0, uFog.y - uFog.x), 0.0, 1.0); return mix(c, uFogCol, f * strength); }`;

const BB_VS = /* glsl */ `
attribute vec3 iPos; attribute float iSize; attribute vec3 iCol; attribute vec4 iA;
uniform float uPx; uniform float uMinPx;
varying vec2 vUv; varying vec3 vCol; varying vec4 vA; varying float vDepth;
void main() {
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  float wpp = -mv.z * uPx;
  float s = max(iSize, uMinPx * wpp);
  float c = cos(iA.w * 6.2831), sn = sin(iA.w * 6.2831);
  vec2 p = vec2(position.x * c - position.y * sn, position.x * sn + position.y * c);
  mv.xy += p * s;
  gl_Position = projectionMatrix * mv;
  vUv = position.xy * 2.0; vCol = iCol; vA = iA; vDepth = -mv.z;
}`;

const SMOKE_FS = /* glsl */ `
uniform vec3 uSunV; uniform vec3 uSunCol; uniform vec3 uAmb; uniform vec3 uHeatCol; uniform float uTime;
varying vec2 vUv; varying vec3 vCol; varying vec4 vA; varying float vDepth;
${HOLD_GLSL}
${NOISE_GLSL}
${FOG_GLSL}
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float sd = vA.w * 37.0;
  float n = wzN(vUv * 2.6 + sd + uTime * 0.05) * 0.62 + wzN(vUv * 5.3 - sd * 1.7) * 0.38;
  float edge = r + (n - 0.5) * 0.7;
  float a = smoothstep(1.0, 0.25, edge) * vA.x;
  if (a < 0.008) discard;
  // a soft sphere: sun side lit, the far side in shadow, rim thinned
  vec3 nrm = normalize(vec3(vUv * 0.9, sqrt(max(0.05, 1.0 - r * r))) + vec3((n - 0.5) * 0.6, (n - 0.5) * 0.6, 0.0));
  float sun = clamp(dot(nrm, uSunV) * 0.5 + 0.5, 0.0, 1.0);
  vec3 lit = vCol * (uAmb + uSunCol * sun * sun * 1.1) * (0.8 + 0.35 * n);
  // fire under a fresh blast / from a burning wreck: glows from inside, strongest at the bottom
  float heat = vA.y * smoothstep(0.9, -0.6, vUv.y + (n - 0.5) * 0.8);
  lit += uHeatCol * heat * (0.6 + 0.8 * n);
  lit = wzFog(lit, 0.85);
  gl_FragColor = vec4(lit, a * holdK());
  #include <colorspace_fragment>
}`;

const GLOW_FS = /* glsl */ `
uniform float uTime;
varying vec2 vUv; varying vec3 vCol; varying vec4 vA; varying float vDepth;
${HOLD_GLSL}
${NOISE_GLSL}
${FOG_GLSL}
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float k = vA.y, a = 0.0;
  vec3 col = vCol;
  if (k < 0.5) a = exp(-r * r * 5.0);
  else if (k < 1.5) a = exp(-r * r * 12.0) * 1.3 + 0.35 * exp(-abs(vUv.x) * 38.0) * (1.0 - r) + 0.35 * exp(-abs(vUv.y) * 38.0) * (1.0 - r);
  else if (k < 2.5) {
    float n = wzN(vUv * 3.2 + vA.w * 17.0 + uTime * 0.9) * 0.6 + wzN(vUv * 7.0 - vA.w * 9.0 - uTime * 0.5) * 0.4;
    float e = smoothstep(1.0, 0.2, r + (n - 0.5) * 0.65);
    a = e;
    col = mix(vCol * vec3(0.9, 0.26, 0.05), vCol * vec3(1.15, 0.78, 0.42), smoothstep(0.5, 1.0, e * (0.55 + n * 0.7)));
    col *= 0.55 + 0.6 * n;
  }
  else if (k < 3.5) a = exp(-pow((r - 0.8) / 0.08, 2.0)) * 0.9 + 0.2 * exp(-pow((r - 0.62) / 0.2, 2.0));
  else if (k < 4.5) a = smoothstep(1.0, 0.0, r) * smoothstep(1.0, 0.25, r);
  else a = exp(-r * r * 16.0) * 1.6 + exp(-r * r * 3.0) * 0.4;
  a *= vA.x * holdK();
  if (a < 0.003) discard;
  col = wzFog(col, 0.45);
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

const ST_VS = /* glsl */ `
attribute vec3 iA; attribute vec3 iB; attribute vec2 iW; attribute vec3 iCol; attribute vec2 iAl;
uniform float uPx;
varying vec2 vUv; varying vec3 vCol; varying vec2 vAl; varying float vDepth;
void main() {
  vec4 a = modelViewMatrix * vec4(iA, 1.0);
  vec4 b = modelViewMatrix * vec4(iB, 1.0);
  vec4 mv = mix(a, b, position.y);
  vec3 d = b.xyz - a.xyz;
  vec3 side = cross(normalize(d + vec3(1e-6)), normalize(-mv.xyz));
  float w = max(iW.x, iW.y * (-mv.z) * uPx);
  mv.xyz += normalize(side + vec3(1e-7)) * position.x * w;
  gl_Position = projectionMatrix * mv;
  vUv = position.xy; vCol = iCol; vAl = iAl; vDepth = -mv.z;
}`;
const ST_FS = /* glsl */ `
varying vec2 vUv; varying vec3 vCol; varying vec2 vAl; varying float vDepth;
${HOLD_GLSL}
${FOG_GLSL}
void main() {
  float across = 1.0 - abs(vUv.x);
  float along = vAl.y > 0.5 ? 1.0 : smoothstep(0.0, 0.85, vUv.y);
  float core = smoothstep(0.55, 1.0, across);
  float a = (across * across * 0.7 + core * 0.8) * along * vAl.x * holdK();
  if (a < 0.003) discard;
  vec3 col = mix(vCol, vec3(1.0) * max(vCol.r, max(vCol.g, vCol.b)), core * 0.55);
  gl_FragColor = vec4(wzFog(col, 0.35), a);
  #include <colorspace_fragment>
}`;

const FLAT_VS = /* glsl */ `
attribute vec3 iPos; attribute float iSize; attribute vec4 iA;
varying vec2 vUv; varying vec4 vA; varying float vDepth;
void main() {
  float c = cos(iA.w * 6.2831), s = sin(iA.w * 6.2831);
  vec2 q = vec2(position.x * c - position.y * s, position.x * s + position.y * c) * iSize;
  vec4 mv = modelViewMatrix * vec4(iPos + vec3(q.x, 0.0, q.y), 1.0);
  gl_Position = projectionMatrix * mv;
  vUv = position.xy * 2.0; vA = iA; vDepth = -mv.z;
}`;
const FLAT_FS = /* glsl */ `
varying vec2 vUv; varying vec4 vA; varying float vDepth;
${HOLD_GLSL}
${NOISE_GLSL}
void main() {
  float r = length(vUv);
  float n = wzN(vUv * 3.0 + vA.w * 11.0) * 0.6 + wzN(vUv * 8.0 - vA.w * 7.0) * 0.4;
  float a = smoothstep(1.0, 0.35, r + (n - 0.5) * 0.55) * vA.x;
  float ray = smoothstep(0.35, 0.0, abs(fract(atan(vUv.y, vUv.x) * 1.4 + vA.w * 3.0) - 0.5)) * smoothstep(1.0, 0.5, r) * 0.35;
  a = clamp(a + ray * vA.x, 0.0, 0.92) * holdK();
  if (a < 0.01) discard;
  gl_FragColor = vec4(vec3(0.06, 0.05, 0.045) + vA.y * vec3(0.9, 0.3, 0.05) * smoothstep(0.6, 0.0, r), a);
  #include <colorspace_fragment>
}`;

class Pool {
  readonly mesh: THREE.Mesh;
  readonly geo: THREE.InstancedBufferGeometry;
  n = 0;
  readonly at: Record<string, THREE.InstancedBufferAttribute> = {};
  constructor(readonly max: number, base: THREE.BufferGeometry, layout: Record<string, number>, mat: THREE.Material, name: string) {
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index; g.setAttribute('position', base.getAttribute('position'));
    for (const [k, sz] of Object.entries(layout)) {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(max * sz), sz); a.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(k, a); this.at[k] = a;
    }
    g.instanceCount = 0;
    this.geo = g;
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false; this.mesh.name = name;
  }
  end() {
    this.geo.instanceCount = this.n;
    if (this.n) for (const a of Object.values(this.at)) { a.clearUpdateRanges(); a.addUpdateRange(0, this.n * a.itemSize); a.needsUpdate = true; }
  }
}

export interface FxCaps { smoke: number; glow: number; streaks: number; flat: number; debris: number }
export const FX_CAPS: FxCaps = { smoke: 900, glow: 900, streaks: 700, flat: 48, debris: 220 };

export class WarzoneFx {
  readonly group = new THREE.Group();
  private smoke: Pool; private glow: Pool; private streak: Pool; private flat: Pool;
  private debris: THREE.InstancedMesh; private dn = 0;
  readonly u = {
    uPx: { value: 0.001 }, uMinPx: { value: 1.2 }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1920, 1080) },
    uHold: { value: Array.from({ length: MAX_HOLD }, () => new THREE.Vector4()) }, uHoldK: { value: new Array(MAX_HOLD).fill(0) }, uHoldN: { value: 0 },
    uSunV: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color(1, 0.9, 0.75) }, uAmb: { value: new THREE.Color(0.55, 0.52, 0.5) },
    uHeatCol: { value: new THREE.Color(1.6, 0.55, 0.12) }, uFogCol: { value: new THREE.Color(0.8, 0.7, 0.6) }, uFog: { value: new THREE.Vector2(200, 3000) },
  };
  /** 0 = full, 1 = reduced, 2 = minimal (governor): fewer puffs, no debris. */
  level = 0;
  private dm = new THREE.Matrix4(); private dq = new THREE.Quaternion(); private ds = new THREE.Vector3(); private dc = new THREE.Color();

  constructor(caps: FxCaps = FX_CAPS) {
    this.group.name = 'vtp:warzone:fx';
    const quad = new THREE.PlaneGeometry(1, 1);
    const U = this.u;
    const smokeMat = new THREE.ShaderMaterial({ vertexShader: BB_VS, fragmentShader: SMOKE_FS, uniforms: U, transparent: true, depthWrite: false, fog: false });
    const glowMat = new THREE.ShaderMaterial({ vertexShader: BB_VS, fragmentShader: GLOW_FS, uniforms: U, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const segGeo = new THREE.BufferGeometry();
    segGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0]), 3));
    segGeo.setIndex([0, 1, 2, 2, 1, 3]);
    const stMat = new THREE.ShaderMaterial({ vertexShader: ST_VS, fragmentShader: ST_FS, uniforms: U, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide });
    const flatMat = new THREE.ShaderMaterial({ vertexShader: FLAT_VS, fragmentShader: FLAT_FS, uniforms: U, transparent: true, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const L = { iPos: 3, iSize: 1, iCol: 3, iA: 4 };
    this.flat = new Pool(caps.flat, quad, { iPos: 3, iSize: 1, iA: 4 }, flatMat, 'vtp:warzone:scorch');
    this.smoke = new Pool(caps.smoke, quad, L, smokeMat, 'vtp:warzone:smoke');
    this.streak = new Pool(caps.streaks, segGeo, { iA: 3, iB: 3, iW: 2, iCol: 3, iAl: 2 }, stMat, 'vtp:warzone:streaks');
    this.glow = new Pool(caps.glow, quad, L, glowMat, 'vtp:warzone:glow');
    this.flat.mesh.renderOrder = 0; this.smoke.mesh.renderOrder = 1; this.streak.mesh.renderOrder = 2; this.glow.mesh.renderOrder = 3;
    // debris: a chunky faceted rock, toon shaded, instance colours
    const rock = new THREE.DodecahedronGeometry(0.5, 0);
    const p = rock.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) { const k = 0.75 + ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1 * 0.5; p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.7, p.getZ(i) * k); }
    rock.computeVertexNormals();
    this.debris = new THREE.InstancedMesh(rock, new THREE.MeshToonMaterial({ color: 0xffffff }), caps.debris);
    this.debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debris.count = 0; this.debris.frustumCulled = false; this.debris.name = 'vtp:warzone:debris';
    this.debris.setColorAt(0, new THREE.Color(1, 1, 1));
    this.group.add(this.flat.mesh, this.smoke.mesh, this.streak.mesh, this.glow.mesh, this.debris);
  }

  begin(t: number) { this.smoke.n = 0; this.glow.n = 0; this.streak.n = 0; this.flat.n = 0; this.dn = 0; this.u.uTime.value = t % 3600; }

  /** Lit smoke puff: radius (m), albedo, alpha, heat (0..1 fire glow from inside), seed. */
  puff(p: THREE.Vector3, size: number, r: number, g: number, b: number, alpha: number, heat = 0, seed = 0) {
    const P = this.smoke;
    if (P.n >= P.max || alpha <= 0.01 || size <= 0) return;
    if (this.level >= 2 && (Math.floor(seed * 997) & 1) === 1) return;
    const i = P.n++;
    P.at.iPos.setXYZ(i, p.x, p.y, p.z); P.at.iSize.setX(i, size * 2); P.at.iCol.setXYZ(i, r, g, b); P.at.iA.setXYZW(i, alpha, heat, 0, seed % 1);
  }
  /** Additive sprite (GLOW.*): radius (m), colour × intensity. */
  sprite(p: THREE.Vector3, size: number, r: number, g: number, b: number, alpha = 1, kind = 0, seed = 0) {
    const P = this.glow;
    if (P.n >= P.max || alpha <= 0.003 || size <= 0) return;
    const i = P.n++;
    P.at.iPos.setXYZ(i, p.x, p.y, p.z); P.at.iSize.setX(i, size * 2); P.at.iCol.setXYZ(i, r, g, b); P.at.iA.setXYZW(i, alpha, kind, 0, seed % 1);
  }
  /** Additive streak a → b: half width (m) + a minimum width in pixels; beam = even brightness along it. */
  line(a: THREE.Vector3, b: THREE.Vector3, w: number, minPx: number, r: number, g: number, bl: number, alpha = 1, beam = false) {
    const P = this.streak;
    if (P.n >= P.max || alpha <= 0.003) return;
    const i = P.n++;
    P.at.iA.setXYZ(i, a.x, a.y, a.z); P.at.iB.setXYZ(i, b.x, b.y, b.z); P.at.iW.setXY(i, w, minPx); P.at.iCol.setXYZ(i, r, g, bl); P.at.iAl.setXY(i, alpha, beam ? 1 : 0);
  }
  /** A ground mark (flat, at p.y): radius, alpha, ember glow 0..1. */
  scorch(p: THREE.Vector3, size: number, alpha: number, ember = 0, seed = 0) {
    const P = this.flat;
    if (P.n >= P.max || alpha <= 0.01) return;
    const i = P.n++;
    P.at.iPos.setXYZ(i, p.x, p.y + 0.03, p.z); P.at.iSize.setX(i, size * 2); P.at.iA.setXYZW(i, alpha, ember, 0, seed % 1);
  }
  /** A tumbling chunk: size (m), rotation (axis-angle packed as a quaternion), grey level. */
  chunk(p: THREE.Vector3, size: number, q: THREE.Quaternion, shade: number) {
    if (this.level >= 2 || this.dn >= this.debris.instanceMatrix.count || size <= 0.005) return;
    this.ds.setScalar(size);
    this.dm.compose(p, q, this.ds);
    this.debris.setMatrixAt(this.dn, this.dm);
    this.debris.setColorAt(this.dn, this.dc.setRGB(shade, shade * 0.96, shade * 0.9));
    this.dn++;
  }

  end() {
    this.smoke.end(); this.glow.end(); this.streak.end(); this.flat.end();
    this.debris.count = this.dn;
    if (this.dn) { this.debris.instanceMatrix.needsUpdate = true; if (this.debris.instanceColor) this.debris.instanceColor.needsUpdate = true; }
  }

  /** Face boxes / the React screen (normalised screen rects, y up): k = how much is removed (1 = all). */
  setHolds(rects: { x: number; y: number; w: number; h: number; k: number }[]) {
    const n = Math.min(MAX_HOLD, rects.length);
    for (let i = 0; i < n; i++) { const r = rects[i]; this.u.uHold.value[i].set(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2); this.u.uHoldK.value[i] = r.k; }
    this.u.uHoldN.value = n;
  }

  counts() { return { smoke: this.smoke.n, glow: this.glow.n, streaks: this.streak.n, scorch: this.flat.n, debris: this.dn }; }

  dispose() {
    this.group.removeFromParent();
    for (const p of [this.smoke, this.glow, this.streak, this.flat]) { p.geo.dispose(); (p.mesh.material as THREE.Material).dispose(); }
    this.debris.geometry.dispose(); (this.debris.material as THREE.Material).dispose(); this.debris.dispose();
  }
}
