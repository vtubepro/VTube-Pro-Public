// Space effects, immediate-mode and instanced (3 draw calls whatever happens): additive sprites (glows, flares,
// fireballs, shockwave rings, sparks — shapes computed in the shader, no textures), alpha smoke puffs, and additive
// streaks (tracers, shells, beams, engine trails, warp lines) with a minimum on-screen width so distant fire stays
// visible. Positions are in AUTHORED space units; the space group applies the viewport compression (uK).
import * as THREE from 'three';
import { FACE_GLSL, faceUniforms } from './ships.ts';

export const SPRITE = { glow: 0, flare: 1, fire: 2, ring: 3, spark: 5, core: 6 } as const;

const SP_VS = /* glsl */ `
attribute vec3 iPos; attribute float iSize; attribute vec3 iCol; attribute vec2 iA; attribute float iSeed;
uniform float uK; uniform float uPx; uniform float uMinPx;
varying vec2 vUv; varying vec3 vCol; varying vec2 vA; varying float vSeed;
void main() {
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  float wpp = -mv.z * uPx;                     // world units per pixel at this depth
  float s = max(iSize * uK, uMinPx * wpp);
  float c = cos(iSeed * 6.2831), sn = sin(iSeed * 6.2831);
  vec2 p = vec2(position.x * c - position.y * sn, position.x * sn + position.y * c);
  mv.xy += p * s;
  gl_Position = projectionMatrix * mv;
  vUv = position.xy * 2.0; vCol = iCol; vA = iA; vSeed = iSeed;
}`;
const SP_FS = /* glsl */ `
uniform float uTime;
varying vec2 vUv; varying vec3 vCol; varying vec2 vA; varying float vSeed;
${FACE_GLSL}
float hsh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(hsh(i), hsh(i + vec2(1, 0)), f.x), mix(hsh(i + vec2(0, 1)), hsh(i + vec2(1, 1)), f.x), f.y); }
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float k = vA.y, a = 0.0;
  vec3 col = vCol;
  if (k < 0.5) a = exp(-r * r * 5.0);                                                  // glow
  else if (k < 1.5) { a = exp(-r * r * 9.0) + 0.5 * exp(-abs(vUv.x) * 40.0) * (1.0 - r) + 0.5 * exp(-abs(vUv.y) * 40.0) * (1.0 - r); }  // flare
  else if (k < 2.5) {                                                                  // fireball
    float n = vn(vUv * 3.5 + vSeed * 17.0 + uTime * 0.6) * 0.6 + vn(vUv * 7.0 - vSeed * 9.0) * 0.4;
    float e = smoothstep(1.0, 0.25, r + (n - 0.5) * 0.55);
    a = e;
    col = mix(vCol * vec3(1.0, 0.35, 0.08), vCol * vec3(1.2, 1.0, 0.75), smoothstep(0.45, 0.95, e * (0.6 + n * 0.6)));
  }
  else if (k < 3.5) { a = exp(-pow((r - 0.82) / 0.07, 2.0)) + 0.25 * exp(-pow((r - 0.7) / 0.2, 2.0)); }   // shockwave ring
  else if (k < 5.5) a = smoothstep(1.0, 0.0, r) * smoothstep(1.0, 0.2, r);          // spark
  else a = exp(-r * r * 16.0) * 1.6 + exp(-r * r * 3.0) * 0.4;                          // hot core
  a *= vA.x * faceHold();
  if (a < 0.003) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;
const SMOKE_FS = /* glsl */ `
uniform float uTime;
varying vec2 vUv; varying vec3 vCol; varying vec2 vA; varying float vSeed;
float hsh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(hsh(i), hsh(i + vec2(1, 0)), f.x), mix(hsh(i + vec2(0, 1)), hsh(i + vec2(1, 1)), f.x), f.y); }
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float n = vn(vUv * 3.0 + vSeed * 13.0) * 0.65 + vn(vUv * 6.0 + vSeed * 5.0) * 0.35;
  float a = smoothstep(1.0, 0.3, r + (n - 0.5) * 0.6) * vA.x;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vCol * (0.75 + 0.5 * n), a);
  #include <colorspace_fragment>
}`;
const ST_VS = /* glsl */ `
attribute vec3 iA; attribute vec3 iB; attribute vec2 iW; attribute vec3 iCol; attribute vec2 iAl;
uniform float uK; uniform float uPx;
varying vec2 vUv; varying vec3 vCol; varying vec2 vAl;
void main() {
  vec4 a = modelViewMatrix * vec4(iA, 1.0);
  vec4 b = modelViewMatrix * vec4(iB, 1.0);
  vec4 mv = mix(a, b, position.y);
  vec3 d = b.xyz - a.xyz;
  vec3 side = cross(normalize(d + vec3(1e-6)), normalize(-mv.xyz));
  float w = max(iW.x * uK, iW.y * (-mv.z) * uPx);
  mv.xyz += normalize(side + vec3(1e-7)) * position.x * w;
  gl_Position = projectionMatrix * mv;
  vUv = position.xy; vCol = iCol; vAl = iAl;
}`;
const ST_FS = /* glsl */ `
varying vec2 vUv; varying vec3 vCol; varying vec2 vAl;
${FACE_GLSL}
void main() {
  float across = 1.0 - abs(vUv.x);
  float along = vAl.y > 0.5 ? 1.0 : smoothstep(0.0, 0.9, vUv.y);     // 1 = beam (even), 0 = tracer / trail (bright head)
  float core = smoothstep(0.55, 1.0, across);
  float a = (across * across * 0.7 + core * 0.8) * along * vAl.x * faceHold();
  if (a < 0.003) discard;
  vec3 col = mix(vCol, vec3(1.0) * max(vCol.r, max(vCol.g, vCol.b)), core * 0.6);
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

class Pool {
  readonly mesh: THREE.Mesh;
  readonly geo: THREE.InstancedBufferGeometry;
  n = 0;
  readonly attrs: Record<string, THREE.InstancedBufferAttribute> = {};
  constructor(readonly max: number, base: THREE.BufferGeometry, layout: Record<string, number>, mat: THREE.ShaderMaterial, name: string) {
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index; g.setAttribute('position', base.getAttribute('position'));
    for (const [k, sz] of Object.entries(layout)) {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(max * sz), sz); a.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(k, a); this.attrs[k] = a;
    }
    g.instanceCount = 0;
    this.geo = g;
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false; this.mesh.name = name;
  }
  end() {
    this.geo.instanceCount = this.n;
    if (this.n) for (const a of Object.values(this.attrs)) { a.clearUpdateRanges(); a.addUpdateRange(0, this.n * a.itemSize); a.needsUpdate = true; }
  }
}

export class SpaceFx {
  readonly group = new THREE.Group();
  private add: Pool; private smoke: Pool; private streak: Pool;
  readonly uniforms: Record<string, THREE.IUniform> & { uK: { value: number }; uPx: { value: number }; uMinPx: { value: number }; uTime: { value: number } };
  /** 0 = full, 1 = reduced, 2 = minimal (perf governor): fewer smoke puffs / trail segments. */
  level = 0;

  /** faces = dim right behind performers' faces (space); off for effects in the room itself (cryo steam …). */
  constructor(caps = { sprites: 1400, smoke: 320, streaks: 1400 }, faces = true) {
    this.uniforms = { uK: { value: 1 }, uPx: { value: 0.001 }, uMinPx: { value: 1.6 }, uTime: { value: 0 }, ...(faces ? faceUniforms : { uFaces: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) }, uFaceN: { value: 0 }, uFaceDim: { value: 1 } }) };
    this.group.name = 'vtp:space:fx';
    const quad = new THREE.PlaneGeometry(1, 1);
    const addMat = new THREE.ShaderMaterial({ vertexShader: SP_VS, fragmentShader: SP_FS, uniforms: this.uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const smokeMat = new THREE.ShaderMaterial({ vertexShader: SP_VS, fragmentShader: SMOKE_FS, uniforms: this.uniforms, transparent: true, depthWrite: false, fog: false });
    const segGeo = new THREE.BufferGeometry();
    segGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0]), 3));
    segGeo.setIndex([0, 1, 2, 2, 1, 3]);
    const stMat = new THREE.ShaderMaterial({ vertexShader: ST_VS, fragmentShader: ST_FS, uniforms: this.uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide });
    this.smoke = new Pool(caps.smoke, quad, { iPos: 3, iSize: 1, iCol: 3, iA: 2, iSeed: 1 }, smokeMat, 'vtp:space:smoke');
    this.add = new Pool(caps.sprites, quad, { iPos: 3, iSize: 1, iCol: 3, iA: 2, iSeed: 1 }, addMat, 'vtp:space:sprites');
    this.streak = new Pool(caps.streaks, segGeo, { iA: 3, iB: 3, iW: 2, iCol: 3, iAl: 2 }, stMat, 'vtp:space:streaks');
    this.smoke.mesh.renderOrder = 1; this.streak.mesh.renderOrder = 2; this.add.mesh.renderOrder = 3;
    this.group.add(this.smoke.mesh, this.streak.mesh, this.add.mesh);
  }

  begin(t: number) { this.add.n = 0; this.smoke.n = 0; this.streak.n = 0; this.uniforms.uTime.value = t % 3600; }

  /** Additive sprite: size = radius (authored units), col = colour × intensity, kind = SPRITE.*, seed rotates / varies. */
  sprite(p: THREE.Vector3, size: number, r: number, g: number, b: number, alpha = 1, kind = 0, seed = 0) {
    const P = this.add;
    if (P.n >= P.max || alpha <= 0.002) return;
    const i = P.n++;
    P.attrs.iPos.setXYZ(i, p.x, p.y, p.z); P.attrs.iSize.setX(i, size * 2); P.attrs.iCol.setXYZ(i, r, g, b); P.attrs.iA.setXY(i, alpha, kind); P.attrs.iSeed.setX(i, seed);
  }
  puff(p: THREE.Vector3, size: number, r: number, g: number, b: number, alpha: number, seed = 0) {
    const P = this.smoke;
    if (P.n >= P.max || alpha <= 0.01 || (this.level >= 2 && (Math.floor(seed * 1000) & 1) === 1)) return;
    const i = P.n++;
    P.attrs.iPos.setXYZ(i, p.x, p.y, p.z); P.attrs.iSize.setX(i, size * 2); P.attrs.iCol.setXYZ(i, r, g, b); P.attrs.iA.setXY(i, alpha, 0); P.attrs.iSeed.setX(i, seed);
  }
  /** Additive streak a → b: width (authored units, half width) and a minimum width in pixels; beam = even along its length. */
  line(a: THREE.Vector3, b: THREE.Vector3, w: number, minPx: number, r: number, g: number, bl: number, alpha = 1, beam = false) {
    const P = this.streak;
    if (P.n >= P.max || alpha <= 0.002) return;
    const i = P.n++;
    P.attrs.iA.setXYZ(i, a.x, a.y, a.z); P.attrs.iB.setXYZ(i, b.x, b.y, b.z); P.attrs.iW.setXY(i, w, minPx); P.attrs.iCol.setXYZ(i, r, g, bl); P.attrs.iAl.setXY(i, alpha, beam ? 1 : 0);
  }

  end() { this.add.end(); this.smoke.end(); this.streak.end(); }

  counts() { return { sprites: this.add.n, smoke: this.smoke.n, streaks: this.streak.n }; }

  dispose() {
    this.group.removeFromParent();
    for (const p of [this.add, this.smoke, this.streak]) { p.geo.dispose(); (p.mesh.material as THREE.Material).dispose(); }
  }
}
