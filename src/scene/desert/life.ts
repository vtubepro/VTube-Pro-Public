// Desert life + air: things that MOVE at every distance, so the world is alive even when the ship stands still.
//   birds      flocks circling thermals over the route (sand gulls), and the odd big glider high up (one draw)
//   devils     dust devils: spiralling sand columns wandering downwind, alive for a minute or two (one draw)
//   sheets     blowing sand: thin sheets skimming the dunes along the wind near the ship (one draw; Medium+)
//   smoke      plumes from chimney tops (factories, horizon stacks) and the distant walkers' stacks (one draw)
//   walkers    other trampers crossing the horizon 1.2..4.5 km out, legs stepping, lit windows at night (kit, ~3 draws)
// Every position is a pure function of (seed, route cell, wall-clock time): host, guests and late pages see the same
// birds / devils / walkers at the same moment. Densities follow the biome rules (shared/desert/regions.ts).
import * as THREE from 'three';
import { BIOME_RULES, type BiomeAt } from '../../../shared/desert/regions.ts';
import { hash32, rnd } from '../../../shared/desert/noise.ts';
import { DesertRoute, type RoutePoint } from '../../../shared/desert/route.ts';
import { heightAt, type DesertWorldSpec } from '../../../shared/desert/height.ts';
import { CLIP_LEVELS, CLIP_RES, type HeightClipmap } from './clipmap.ts';
import { CLIP_DECODE_GLSL, COMPRESS_GLSL, DESERT_UNIFORMS, NOISE_GLSL, SHADE_GLSL } from './glsl.ts';
import { KitLayer, MAT, type KitInstance } from './kit.ts';
import type { DesertUniforms } from './uniforms.ts';
import type { DesertLight } from './light.ts';
import type { DesertFrame, DesertWorld } from './index.ts';

const UPV = new THREE.Vector3(0, 1, 0), SAND_PALE = new THREE.Color(0.9, 0.78, 0.6);
const BIRD_CELL = 600, DEVIL_CELL = 420, WALKER_CELL = 3800;
const MAX_BIRDS = 180, MAX_DEVILS = 6, DEVIL_SPRITES = 44, MAX_SMOKE = 24, SMOKE_SPRITES = 22;
const SHEETS: Record<string, number> = { low: 0, medium: 260, high: 520, ultra: 700 };
const MAX_SHEETS = 700;

// ------------------------------------------------------------------ birds
const BIRD_VS = /* glsl */ `
${DESERT_UNIFORMS}
${COMPRESS_GLSL}
in vec4 aBird;     // flap phase, flap rate (Hz), compressed (0/1), unused
in float aWing;    // 0 body, +-1 wing tip side
varying float vFog;
varying vec3 vPt;
void main() {
  vec3 pos = position;
  float flap = sin(uTime * 6.2832 * aBird.y + aBird.x);
  // wings beat about the body axis (z): the tips swing up / down
  pos.y += abs(aWing) * flap * 0.38 * abs(pos.x);
  vec4 pt = instanceMatrix * vec4(pos, 1.0);
  vPt = pt.xyz;
  vec3 p = pt.xyz;
  vec3 anc = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  if (aBird.z > 0.5) { float D = max(1.0, length(anc.xz - uCamT.xz)); float k = dCompress(D) / D; p = uCamT + (p - uCamT) * k; p.y -= dDrop(D) * k; }
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const BIRD_FS = /* glsl */ `
${DESERT_UNIFORMS}
${SHADE_GLSL}
uniform vec3 uBirdCol;
varying vec3 vPt;
void main() {
  vec3 col = dApplyFog(uBirdCol, uCamT, vPt);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

function birdGeometry(): THREE.BufferGeometry {
  // a body diamond + two swept wings (x = span, z = forward -z), 1 m span
  const P = [
    0, 0, -0.32, 0.05, 0, 0.05, -0.05, 0, 0.05, 0, 0, 0.32, -0.05, 0, 0.05, 0.05, 0, 0.05,          // body
    0.04, 0, -0.06, 0.5, 0.02, 0.12, 0.04, 0, 0.1, -0.04, 0, -0.06, -0.04, 0, 0.1, -0.5, 0.02, 0.12, // wings
  ];
  const W = [0, 0, 0, 0, 0, 0, 0.2, 1, 0.2, -0.2, -0.2, -1];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(W, 1));
  return g;
}

// ------------------------------------------------------------------ billboards (devils, smoke)
const BILL_VS = /* glsl */ `
${DESERT_UNIFORMS}
${COMPRESS_GLSL}
${NOISE_GLSL}
in vec4 aS;                      // group index, k (0..1 along the group), phase, size
uniform vec4 uG[${MAX_SMOKE}];   // per group: base x, y, z (terrain-local), height
uniform vec4 uG2[${MAX_SMOKE}];  // per group: radius bottom, radius top, alpha, compressed (0/1)
uniform float uKind;             // 0 dust devil, 1 smoke plume
uniform float uN;
varying vec2 vUv;
varying float vA;
varying float vSeed;
varying float vK;
void main() {
  vUv = position.xy;
  int gi = int(aS.x + 0.5);
  vec4 G = uG[gi], G2 = uG2[gi];
  float k = aS.y;
  vec3 c;
  float s;
  if (uKind < 0.5) {
    // devil: a spiral column, spinning fastest at the bottom, leaning downwind, flaring at the top
    float h = k * G.w;
    float r = mix(G2.x, G2.y, pow(k, 1.6));
    float ang = aS.z + uTime * (5.5 - 3.5 * k) + k * 9.0;
    vec3 w = normalize(vec3(uWindT.x, 0.0, uWindT.y) + 1e-4);
    c = G.xyz + vec3(cos(ang) * r, h, sin(ang) * r) + w * (k * k * G.w * 0.25 + sin(uTime * 0.7 + aS.z) * 2.0);
    s = aS.w * (0.6 + 1.6 * k);
    vA = G2.z * smoothstep(0.0, 0.08, k) * (1.0 - smoothstep(0.7, 1.0, k)) * 0.55;
  } else {
    // smoke: puffs rise, drift downwind, grow and thin out (a continuous loop: age = fract(t / period + k))
    float age = fract(uTime / 26.0 + k + aS.z * 0.07);
    vec3 w = vec3(uWindT.x, 0.0, uWindT.y);
    c = G.xyz + vec3(0.0, age * G.w, 0.0) + w * age * age * 7.0 + vec3(sin(aS.z * 7.0 + age * 3.0), 0.0, cos(aS.z * 5.0 + age * 2.0)) * G2.x * age * 2.0;
    s = G2.x * (1.2 + 6.0 * age) * aS.w;
    vA = G2.z * smoothstep(0.0, 0.06, age) * (1.0 - smoothstep(0.35, 1.0, age)) * 0.6;
  }
  vK = k;
  vSeed = aS.z;
  if (G2.w > 0.5) { float D = max(1.0, length(G.xz - uCamT.xz)); float kk = dCompress(D) / D; c = uCamT + (c - uCamT) * kk; c.y -= dDrop(D) * kk; s *= kk; }
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  mat3 inv = transpose(mat3(modelMatrix));
  vec3 p = c + (inv * right) * position.x * s + (inv * up) * position.y * s;
  if (aS.x > uN - 0.5) vA = 0.0;
  gl_Position = vA > 0.001 ? projectionMatrix * modelViewMatrix * vec4(p, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}`;
const BILL_FS = /* glsl */ `
${DESERT_UNIFORMS}
${NOISE_GLSL}
uniform vec3 uCol; uniform vec3 uCol2;
varying vec2 vUv;
varying float vA;
varying float vSeed;
varying float vK;
void main() {
  float r = length(vUv) * 2.0;
  float n = vnf(vUv * 3.2 + vSeed * 13.0 + uTime * 0.15);
  float a = (1.0 - smoothstep(0.3 + 0.35 * n, 1.0, r)) * vA;
  if (a < 0.004) discard;
  gl_FragColor = vec4(mix(uCol, uCol2, vK) * (0.8 + 0.35 * n), a);
  #include <colorspace_fragment>
}`;

// ------------------------------------------------------------------ blowing sand sheets
const SHEET_VS = /* glsl */ `
precision highp sampler2DArray;
${DESERT_UNIFORMS}
${NOISE_GLSL}
in vec4 aSeed;
uniform highp sampler2DArray uH;
uniform vec4 uClip[${CLIP_LEVELS}];
uniform float uPack;
uniform float uBox;
uniform float uCount;
uniform float uLevel;
${CLIP_DECODE_GLSL}
float groundH(vec2 p) {
  for (int l = 0; l < ${CLIP_LEVELS}; l++) {
    vec4 c = uClip[l];
    vec2 t = (p - c.xy) * c.w;
    if (all(greaterThan(t, vec2(2.0))) && all(lessThan(t, vec2(${CLIP_RES - 3}.0)))) {
      ivec2 i = ivec2(floor(t)); vec2 f = t - vec2(i);
      float a = clipHd(texelFetch(uH, ivec3(i, l), 0)), b = clipHd(texelFetch(uH, ivec3(i + ivec2(1, 0), l), 0));
      float d = clipHd(texelFetch(uH, ivec3(i + ivec2(0, 1), l), 0)), e = clipHd(texelFetch(uH, ivec3(i + ivec2(1, 1), l), 0));
      return mix(mix(a, b, f.x), mix(d, e, f.x), f.y);
    }
  }
  return uFog.z;
}
varying vec2 vUv;
varying float vA;
void main() {
  vUv = position.xy;
  float id = float(gl_InstanceID);
  vec3 wind = vec3(uWindT.x, 0.0, uWindT.y);
  float sp = length(wind) + 1e-3;
  vec3 w = wind / sp;
  vec3 b = fract(vec3(aSeed.x, 0.0, aSeed.z) + wind * (1.4 + 0.8 * aSeed.w) * uTime / uBox);
  vec2 xz = uCamT.xz + (b.xz - 0.5) * uBox;
  float g = groundH(xz);
  vec3 c = vec3(xz.x, g + 0.15 + 1.4 * aSeed.y * aSeed.y, xz.y);
  vec3 side = normalize(cross(w, vec3(0.0, 1.0, 0.0)));
  float len = 7.0 + 12.0 * aSeed.w, wid = 0.5 + 1.3 * aSeed.y;
  // a ribbon lying along the wind, rippling as it skims the sand
  vec3 p = c + w * position.x * len + side * position.y * wid * 2.5 + vec3(0.0, (position.y + 0.5) * wid * 0.35 + sin(position.x * 3.0 + uTime * 4.0 + id) * 0.12, 0.0);
  float dcam = length(c.xz - uCamT.xz);
  // gusts: sheets come and go in bands that travel with the wind (world-anchored)
  float gust = smoothstep(0.35, 0.75, vnf(vec2(dot(xz + uAnc.xy, w.xz) * 0.012 - uTime * 0.12, dot(xz + uAnc.xy, side.xz) * 0.006)));
  vA = uLevel * gust * smoothstep(12.0, 30.0, dcam) * (1.0 - smoothstep(uBox * 0.36, uBox * 0.5, dcam)) * step(id, uCount - 0.5) * (1.0 - uStorm);
  gl_Position = vA > 0.001 ? projectionMatrix * modelViewMatrix * vec4(p, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}`;
const SHEET_FS = /* glsl */ `
${DESERT_UNIFORMS}
${NOISE_GLSL}
uniform vec3 uSheetCol;
varying vec2 vUv;
varying float vA;
void main() {
  float n = vnf(vec2(vUv.x * 9.0 - uTime * 2.0, vUv.y * 3.0));
  float a = (1.0 - smoothstep(0.25, 0.5, abs(vUv.x))) * (1.0 - smoothstep(0.05, 0.5, abs(vUv.y))) * (0.4 + 0.6 * n) * vA * 0.22;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uSheetCol, a);
  #include <colorspace_fragment>
}`;

const quad = () => {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
};

interface Walker { id: number; x: number; z: number; yaw: number; dist: number; scale: number }

export class DesertLife {
  readonly group = new THREE.Group();
  private birds: THREE.InstancedMesh;
  private birdA: THREE.InstancedBufferAttribute;
  private birdU: Record<string, THREE.IUniform>;
  private devils: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private smokeM: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private sheets: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private walkKit: KitLayer;
  private quality = 'high';
  /** drifting-sand amount (DesertOptions.drift 0..2): the blowing sheets' level (1 = the world rules' own) */
  drift = 1;
  biomeAt: BiomeAt | null = null;
  /** smoke emitters (terrain-local) from the marks layer (chimneys) */
  emitters: { x: number; y: number; z: number; r: number }[] = [];
  stats = { birds: 0, gliders: 0, devils: 0, sheets: 0, smoke: 0, walkers: 0 };
  private rp: RoutePoint = { x: 0, z: 0, heading: 0, curv: 0 };
  private m = new THREE.Matrix4(); private q = new THREE.Quaternion(); private v = new THREE.Vector3(); private sc = new THREE.Vector3(); private eu = new THREE.Euler();
  private litC = new THREE.Color(); private litT = new THREE.Color();
  /** the distant walkers' kit instances, re-used every frame (fill() copies them) */
  private wPool: KitInstance[] = [];
  private wv = Array.from({ length: 8 }, () => new THREE.Vector3());

  constructor(private spec: DesertWorldSpec, du: DesertUniforms, clip: HeightClipmap) {
    this.group.name = 'vtp:desert:life';
    // birds
    const bg = birdGeometry();
    this.birdA = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BIRDS * 4), 4);
    bg.setAttribute('aBird', this.birdA);
    this.birdU = { ...du, uBirdCol: { value: new THREE.Color(0.05, 0.04, 0.035) } };
    const bm = new THREE.ShaderMaterial({ vertexShader: BIRD_VS, fragmentShader: BIRD_FS, uniforms: this.birdU, side: THREE.DoubleSide, fog: false });
    bm.name = 'vtp:desert:birds';
    this.birds = new THREE.InstancedMesh(bg, bm, MAX_BIRDS);
    this.birds.name = 'vtp:desert:birds'; this.birds.frustumCulled = false; this.birds.count = 0; this.birds.renderOrder = 6;
    this.birds.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    // dust devils + smoke: one billboard program, two meshes
    const mk = (n: number, groups: number, kind: number, name: string, col: string, col2: string) => {
      const g = quad();
      const a = new Float32Array(n * groups * 4);
      for (let gi = 0; gi < groups; gi++) for (let i = 0; i < n; i++) { const o = (gi * n + i) * 4; a[o] = gi; a[o + 1] = i / (n - 1); a[o + 2] = rnd(gi, i, 71) * 6.283; a[o + 3] = 0.6 + 0.8 * rnd(gi, i, 72); }
      g.setAttribute('aS', new THREE.InstancedBufferAttribute(a, 4));
      g.instanceCount = n * groups;
      const u = { ...du, uG: { value: Array.from({ length: MAX_SMOKE }, () => new THREE.Vector4()) }, uG2: { value: Array.from({ length: MAX_SMOKE }, () => new THREE.Vector4()) }, uKind: { value: kind }, uN: { value: 0 }, uCol: { value: new THREE.Color(col) }, uCol2: { value: new THREE.Color(col2) } };
      const m = new THREE.ShaderMaterial({ vertexShader: BILL_VS, fragmentShader: BILL_FS, uniforms: u, transparent: true, depthWrite: false, fog: false });
      m.name = name;
      const mesh = new THREE.Mesh(g, m);
      mesh.name = name; mesh.frustumCulled = false; mesh.renderOrder = 34; mesh.visible = false;
      return mesh;
    };
    this.devils = mk(DEVIL_SPRITES, MAX_DEVILS, 0, 'vtp:desert:devils', '#c99a63', '#e2c194');
    this.smokeM = mk(SMOKE_SPRITES, MAX_SMOKE, 1, 'vtp:desert:smoke', '#4a4038', '#9a8c7c');
    // sand sheets
    const sg = quad();
    const sa = new Float32Array(MAX_SHEETS * 4);
    for (let i = 0; i < MAX_SHEETS; i++) { sa[i * 4] = rnd(spec.seed, i, 81); sa[i * 4 + 1] = rnd(spec.seed, i, 82); sa[i * 4 + 2] = rnd(spec.seed, i, 83); sa[i * 4 + 3] = rnd(spec.seed, i, 84); }
    sg.setAttribute('aSeed', new THREE.InstancedBufferAttribute(sa, 4));
    sg.instanceCount = MAX_SHEETS;
    const su = { ...du, uH: clip.hTexU, uPack: clip.packU, uClip: clip.clipU, uBox: { value: 440 }, uCount: { value: 0 }, uLevel: { value: 0 }, uSheetCol: { value: new THREE.Color('#e3c08e') } };
    const sm = new THREE.ShaderMaterial({ vertexShader: SHEET_VS, fragmentShader: SHEET_FS, uniforms: su, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
    sm.name = 'vtp:desert:sheets';
    sm.forceSinglePass = true;                 // (flat ribbons: one pass looks the same)
    this.sheets = new THREE.Mesh(sg, sm);
    this.sheets.name = 'vtp:desert:sheets'; this.sheets.frustumCulled = false; this.sheets.renderOrder = 33;
    // distant walkers (kit pieces, re-filled every frame: ~40 instances)
    this.walkKit = new KitLayer('walkers', du, clip, { walkerbody: 6, box: 120, cyl: 12 });
    this.group.add(this.birds, this.devils, this.smokeM, this.sheets, this.walkKit.group);
  }

  setQuality(q: string) { this.quality = q; }

  update(w: DesertWorld, f: DesertFrame, L: DesertLight) {
    const now = f.now ?? Date.now(), t = now / 1000, d = f.d;
    const O = w.origin();
    const bAt = this.biomeAt;
    const rules = (s: number) => BIOME_RULES[bAt ? bAt(s) : 'dunes'];
    const seed = this.spec.seed;
    const day = L.day, dark = L.dark;
    // ---- birds: flocks per route cell (within 2.4 km), circling their thermal; gliders higher, slower
    let nb = 0, ng = 0;
    for (let j = Math.floor((d - 1200) / BIRD_CELL); j * BIRD_CELL < d + 2400 && nb < MAX_BIRDS; j++) {
      const s0 = (j + rnd(seed, j, 601)) * BIRD_CELL;
      const R = rules(s0);
      if (rnd(seed, j, 602) > 0.55 * R.birds * (dark > 0.6 ? 0.2 : 1)) continue;
      const glider = rnd(seed, j, 603) < 0.18;
      const side = rnd(seed, j, 604) < 0.5 ? -1 : 1;
      const lat = side * (60 + 520 * rnd(seed, j, 605));
      this.rp = w.route.at(s0, this.rp);
      const [ox, oz] = DesertRoute.toWorld(this.rp.heading, lat, 0);
      const cx = this.rp.x + ox, cz = this.rp.z + oz;
      const gy = heightAt(this.spec, cx, cz);
      const n = glider ? 1 + Math.floor(rnd(seed, j, 606) * 3) : 8 + Math.floor(rnd(seed, j, 606) * 16);
      const alt = glider ? 160 + 160 * rnd(seed, j, 607) : 35 + 140 * rnd(seed, j, 607);
      const Rr = glider ? 120 + 80 * rnd(seed, j, 608) : 25 + 60 * rnd(seed, j, 608);
      const om = (glider ? 0.05 : 0.18 + 0.12 * rnd(seed, j, 609)) * (rnd(seed, j, 610) < 0.5 ? 1 : -1);
      for (let i = 0; i < n && nb < MAX_BIRDS; i++) {
        const ph = rnd(seed, j, i, 611) * 6.283, rr = Rr * (0.6 + 0.6 * rnd(seed, j, i, 612));
        const a = om * t + ph;
        const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr, y = gy + alt + 10 * Math.sin(t * 0.3 + ph) + rnd(seed, j, i, 613) * 20;
        // heading along the circle; banked into the turn
        const yaw = Math.atan2(Math.sin(a) * Math.sign(om), -Math.cos(a) * Math.sign(om));
        this.q.setFromEuler(this.eu.set(0, yaw, -0.35 * Math.sign(om), 'YXZ'));
        const span = glider ? 10 + 6 * rnd(seed, j, i, 614) : 1.6 + 1.2 * rnd(seed, j, i, 614);
        this.m.compose(this.v.set(x - O.x, y, z - O.z), this.q, this.sc.set(span, span, span));
        this.birds.setMatrixAt(nb, this.m);
        const far = Math.hypot(x - w.pose.x, z - w.pose.z) > 1400 ? 1 : 0;
        this.birdA.setXYZW(nb, ph, glider ? 0.35 : 2.2 + 1.2 * rnd(seed, j, i, 615), far, 0);
        nb++; if (glider) ng++;
      }
    }
    this.birds.count = nb; this.birds.visible = nb > 0;
    this.birds.instanceMatrix.needsUpdate = true; this.birdA.needsUpdate = true;
    (this.birdU.uBirdCol.value as THREE.Color).setRGB(0.07, 0.055, 0.045).lerp(L.skyAmb, 0.15).multiplyScalar(0.4 + 0.6 * day);
    // ---- dust devils: per route cell, a life window per period (pure in t), wandering downwind
    const dv = this.devils.material.uniforms;
    let nd = 0;
    for (let j = Math.floor((d - 900) / DEVIL_CELL); j * DEVIL_CELL < d + 2200 && nd < MAX_DEVILS; j++) {
      const R = rules(j * DEVIL_CELL);
      if (rnd(seed, j, 621) > 0.45 * R.devils * (1 - 0.8 * dark) || f.storm! > 0.3) continue;
      const period = 150 + 110 * rnd(seed, j, 622), life = 45 + 70 * rnd(seed, j, 623);
      const slot = Math.floor((t + rnd(seed, j, 624) * period) / period);
      const tau = t + rnd(seed, j, 624) * period - slot * period;
      if (tau > life) continue;
      const u = tau / life;
      const lat = (rnd(seed, j, slot, 625) < 0.5 ? -1 : 1) * (70 + 800 * rnd(seed, j, slot, 626));
      this.rp = w.route.at((j + rnd(seed, j, slot, 627)) * DEVIL_CELL, this.rp);
      const [ox, oz] = DesertRoute.toWorld(this.rp.heading, lat, 0);
      const wv = 2 + 3 * rnd(seed, j, slot, 628);
      const x = this.rp.x + ox + this.spec.c * wv * tau, z = this.rp.z + oz + this.spec.s * wv * tau;
      const H = (30 + 70 * rnd(seed, j, slot, 629)) * (0.4 + 0.6 * Math.sin(Math.PI * u));
      (dv.uG.value as THREE.Vector4[])[nd].set(x - O.x, heightAt(this.spec, x, z) - 1, z - O.z, H);
      const far = Math.hypot(x - w.pose.x, z - w.pose.z) > 1400 ? 1 : 0;
      (dv.uG2.value as THREE.Vector4[])[nd].set(1.5 + 2 * rnd(seed, j, slot, 630), 9 + 14 * rnd(seed, j, slot, 631), Math.sin(Math.PI * Math.min(1, u * 1.2)) * (1 - dark * 0.7), far);
      nd++;
    }
    dv.uN.value = nd;
    this.devils.visible = nd > 0;
    (dv.uCol.value as THREE.Color).copy(L.dust).multiply(this.lit(L)).multiplyScalar(0.95);
    (dv.uCol2.value as THREE.Color).copy(L.dust).lerp(L.hazeCol, 0.4).multiply(this.lit(L));
    // ---- distant walkers (and their smoke)
    const walkers = this.walkers(w, d, t);
    const extraSmoke: { x: number; y: number; z: number; r: number }[] = [];
    let wn = 0;
    for (const W of walkers) wn = this.drawWalker(W, O, wn, extraSmoke, dark);
    this.wPool.length = Math.max(this.wPool.length, wn);
    this.walkKit.fill(wn === this.wPool.length ? this.wPool : this.wPool.slice(0, wn));
    // ---- smoke
    const su = this.smokeM.material.uniforms;
    const em = [...this.emitters, ...extraSmoke].slice(0, MAX_SMOKE);
    em.forEach((e, i) => {
      (su.uG.value as THREE.Vector4[])[i].set(e.x, e.y, e.z, 60 + e.r * 14);
      const far = Math.hypot(e.x + O.x - w.pose.x, e.z + O.z - w.pose.z) > 1400 ? 1 : 0;
      (su.uG2.value as THREE.Vector4[])[i].set(Math.max(2, e.r), 0, 0.85 * (1 - f.storm! * 0.6), far);
    });
    su.uN.value = em.length;
    this.smokeM.visible = em.length > 0;
    (su.uCol.value as THREE.Color).setRGB(0.12, 0.1, 0.09).multiply(this.lit(L));
    (su.uCol2.value as THREE.Color).copy(L.hazeCol).multiplyScalar(0.75).lerp(L.dust, 0.3).multiply(this.lit(L));
    // ---- sheets
    const R0 = rules(d);
    const sh = this.sheets.material.uniforms;
    const cnt = SHEETS[this.quality] ?? 0;
    sh.uCount.value = cnt;
    sh.uLevel.value = Math.min(1.6, R0.sheets * (0.55 + 0.45 * Math.sin(t * 0.05 + seed)) * (1 - 0.5 * dark / Math.max(1, this.drift)) * this.drift);
    this.sheets.visible = cnt > 0 && sh.uLevel.value > 0.02;
    (sh.uSheetCol.value as THREE.Color).copy(L.dust).lerp(SAND_PALE, 0.4).multiply(this.lit(L));
    this.stats = { birds: nb - ng, gliders: ng, devils: nd, sheets: this.sheets.visible ? cnt : 0, smoke: em.length, walkers: walkers.length };
  }

  /** sun + sky light on a soft, mostly-lit particle (linear colour multiplier) */
  private lit(L: DesertLight): THREE.Color {
    return this.litC.copy(L.key).multiplyScalar(0.55).add(L.skyAmb).add(this.litT.copy(L.gndAmb).multiplyScalar(0.4));
  }
  /** the k-th pooled walker instance */
  private inst(k: number): KitInstance {
    let it = this.wPool[k];
    if (!it) { it = { shape: 'box', m: new THREE.Matrix4(), mat: MAT.iron, tint: 0, emit: 0, compressed: true, anchor: new THREE.Vector3() }; this.wPool[k] = it; }
    return it;
  }

  /** Other trampers on the horizon: one slot per WALKER_CELL every ~15 min, walking a straight line 1.2..4.5 km out. */
  private walkers(w: DesertWorld, d: number, t: number): Walker[] {
    const out: Walker[] = [];
    const seed = this.spec.seed;
    for (let j = Math.floor((d - 4000) / WALKER_CELL); j * WALKER_CELL < d + 9000 && out.length < 3; j++) {
      if (rnd(seed, j, 641) > 0.6) continue;
      const period = 700 + 400 * rnd(seed, j, 642);
      const slot = Math.floor((t + rnd(seed, j, 643) * period) / period);
      const tau = t + rnd(seed, j, 643) * period - slot * period;
      const lat = (rnd(seed, j, slot, 644) < 0.5 ? -1 : 1) * (1200 + 3300 * rnd(seed, j, slot, 645));
      this.rp = w.route.at((j + rnd(seed, j, slot, 646)) * WALKER_CELL, this.rp);
      const [ox, oz] = DesertRoute.toWorld(this.rp.heading, lat, 0);
      const dir = this.rp.heading + (rnd(seed, j, slot, 647) - 0.5) * 1.6 + (rnd(seed, j, slot, 648) < 0.5 ? 0 : Math.PI);
      const v = 2 + 1.6 * rnd(seed, j, slot, 649);
      const dist = (tau - period / 2) * v;
      const x = this.rp.x + ox + Math.sin(dir) * dist, z = this.rp.z + oz - Math.cos(dir) * dist;
      out.push({ id: hash32(seed, j, slot, 650), x, z, yaw: -dir, dist: tau * v, scale: 0.7 + 0.7 * rnd(seed, j, slot, 651) });
    }
    return out;
  }

  /** One walker: body + six two-segment legs stepping in an alternating tripod, as kit instances (compressed). */
  private drawWalker(W: Walker, O: { x: number; z: number }, n: number, smoke: { x: number; y: number; z: number; r: number }[], dark: number): number {
    const S = 26 * W.scale, stride = S * 0.55;
    const c = Math.cos(W.yaw), s = Math.sin(W.yaw);
    const V = this.wv;
    const loc = (lx: number, ly: number, lz: number, out: THREE.Vector3) => out.set(W.x - O.x + lx * c + lz * s, ly, W.z - O.z - lx * s + lz * c);
    const g = heightAt(this.spec, W.x, W.z);
    const ph = W.dist / stride;
    const bodyY = g + S * 0.72 + Math.sin(ph * Math.PI * 2) * S * 0.015;
    const anchor = loc(0, g, 0, V[0]);
    const put = (shape: 'walkerbody' | 'box', pos: THREE.Vector3, q: THREE.Quaternion, sx: number, sy: number, sz: number, tint: number, emit: number) => {
      const it = this.inst(n++);
      it.shape = shape; it.m.compose(pos, q, this.sc.set(sx, sy, sz)); it.mat = MAT.iron; it.tint = tint; it.emit = emit; it.compressed = true; it.anchor.copy(anchor);
    };
    this.q.setFromAxisAngle(UPV, W.yaw);
    put('walkerbody', loc(0, bodyY, 0, V[1]), this.q, S * 0.5, S * 0.42, S, rnd(W.id, 1), 0.55 * (dark > 0.2 ? 1 : 0.3));
    const top = loc(S * 0.06, bodyY + S * 0.42, S * 0.15, V[1]);
    smoke.push({ x: top.x, y: top.y, z: top.z, r: S * 0.05 });
    for (let k = 0; k < 6; k++) {
      const side = k % 2 ? 1 : -1, row = Math.floor(k / 2) - 1;
      const grp = (k + Math.floor(k / 2)) % 2;                      // alternating tripods
      const u = ((ph + grp * 0.5) % 1 + 1) % 1;
      const stance = u < 0.55;
      const fz = stance ? stride * (0.5 - u / 0.55) : stride * (-0.5 + (u - 0.55) / 0.45);
      const lift = stance ? 0 : Math.sin(Math.PI * (u - 0.55) / 0.45) * S * 0.12;
      const hip = loc(side * S * 0.25, bodyY + S * 0.05, row * S * 0.36, V[2]);
      const foot = loc(side * S * 0.62, g + lift, row * S * 0.36 - fz, V[3]);
      const knee = V[4].copy(hip).lerp(foot, 0.5);
      knee.y += S * 0.32; knee.x += side * c * S * 0.12; knee.z -= side * s * S * 0.12;
      for (let j = 0; j < 2; j++) {
        const a = j ? knee : hip, b = j ? foot : knee;
        const len = a.distanceTo(b);
        this.q.setFromUnitVectors(UPV, V[5].copy(b).sub(a).normalize());
        put('box', a, this.q, S * 0.05, len, S * 0.05, 0.4, 0);
      }
    }
    return n;
  }

  dispose() {
    this.birds.geometry.dispose(); (this.birds.material as THREE.Material).dispose(); this.birds.dispose();
    for (const m of [this.devils, this.smokeM, this.sheets]) { m.geometry.dispose(); m.material.dispose(); }
    this.walkKit.dispose();
  }
}
