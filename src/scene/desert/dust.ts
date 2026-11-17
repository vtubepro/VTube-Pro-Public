// Dust: (1) sandstorm streaks - camera-boxed instanced quads stretched along the storm wind, denser near the ground,
// never inside dry boxes (the canopy) and thinned over performers' faces; (2) footfall puffs - every plant (the ship's
// closed-form footfalls, mech / crew footprints) kicks 12-20 soft puffs from a ring-buffer pool, closed-form ballistic
// + wind + buoyancy, growing and fading. Puff timing is page-local (visual only; a page that opens mid-walk skips the
// plants that already landed). Two draws, no per-frame allocation.
import * as THREE from 'three';
import type { Plant } from '../../../shared/desert/footfalls.ts';
import { rnd } from '../../../shared/desert/noise.ts';
import { DESERT_UNIFORMS, NOISE_GLSL } from './glsl.ts';
import type { DesertUniforms } from './uniforms.ts';
import type { DesertLight } from './light.ts';
import type { DesertFrame, DesertWorld } from './index.ts';

/** Sand wake + heavier footfall dust from this speed (m/s), full at WAKE_FULL (SPEC 3.6 with the 11.5 R1 speeds:
 *  cruise 2.2, city 1.8, battle 3.0, storm 1.4, chapter pacing k in [0.85, 1.15]). Cruise tops out at 2.53 m/s, so only
 *  battle pace churns the sand; at k < 0.87 the voyage passes `wake` itself (DesertFrame.wake). */
export const WAKE_SPEED = 2.6;
export const WAKE_FULL = 3.0;
export function wakeK(speed: number): number { return Number.isFinite(speed) ? Math.min(1, Math.max(0, (speed - WAKE_SPEED) / (WAKE_FULL - WAKE_SPEED))) : 0; }

const STREAKS: Record<string, number> = { low: 600, medium: 1500, high: 3000, ultra: 3000 };
const MAX_STREAKS = 3000;
const PUFFS = 512;
/** Slots for the ship's own footfalls (the rest: event puffs from other walkers). */
const SHIP_SLOTS = 384;
export const MAX_DRY_BOXES = 4;
export const FACE_SLOTS = 6;

const FACE_GLSL = /* glsl */ `
uniform vec4 uFaces[${FACE_SLOTS}]; uniform int uFaceN; uniform float uFaceDim;
float faceHold() {
  float k = 1.0;
  for (int i = 0; i < ${FACE_SLOTS}; i++) {
    if (i >= uFaceN) break;
    vec4 r = uFaces[i];
    vec2 c = (r.xy + r.zw) * 0.5, h = (r.zw - r.xy) * 0.5;
    vec2 q = abs(gl_FragCoord.xy - c) / max(h, vec2(1.0));
    k = min(k, mix(uFaceDim, 1.0, smoothstep(0.75, 1.25, max(q.x, q.y))));
  }
  return k;
}`;

const STREAK_VS = /* glsl */ `
${DESERT_UNIFORMS}
in vec4 aSeed;
uniform float uBox;
uniform float uGround;      // terrain-local ground y near the camera
uniform vec4 uDryMin[${MAX_DRY_BOXES}]; uniform vec4 uDryMax[${MAX_DRY_BOXES}]; uniform int uDryN;
uniform float uCount;
varying vec2 vUv;
varying float vA;
void main() {
  vUv = position.xy;
  float id = float(gl_InstanceID);
  vec3 wind = vec3(uWindT.x, 0.0, uWindT.y);
  float sp = length(wind) + 1e-3;
  vec3 w = wind / sp;
  // closed-form drift inside a camera-centred box (wraps), height biased towards the ground
  vec3 b = fract(vec3(aSeed.x, 0.0, aSeed.z) + wind * (0.75 + 0.5 * aSeed.w) * uTime / uBox);
  vec3 c = vec3(uCamT.x + (b.x - 0.5) * uBox, uGround + aSeed.y * aSeed.y * 34.0 + 0.3 + sin(uTime * (1.0 + aSeed.w) + id) * 0.4, uCamT.z + (b.z - 0.5) * uBox);
  vec3 view = normalize(c - uCamT);
  vec3 side = normalize(cross(w, view) + vec3(1e-4, 0.0, 0.0));
  float len = 1.2 + 3.4 * aSeed.w * (0.6 + 0.4 * uStorm);
  float wid = 0.02 + 0.05 * aSeed.y;
  vec3 p = c + w * position.x * len + side * position.y * wid;
  // dry boxes (room space): no sand under the canopy
  vec3 room = (modelMatrix * vec4(c, 1.0)).xyz;
  float dry = 0.0;
  for (int i = 0; i < ${MAX_DRY_BOXES}; i++) { if (i >= uDryN) break; if (all(greaterThan(room, uDryMin[i].xyz)) && all(lessThan(room, uDryMax[i].xyz))) dry = 1.0; }
  float dcam = length(c - uCamT);
  vA = uStorm * (1.0 - dry) * smoothstep(0.6, 2.5, dcam) * (1.0 - smoothstep(uBox * 0.38, uBox * 0.5, dcam)) * step(id, uCount - 0.5);
  gl_Position = vA > 0.001 ? projectionMatrix * modelViewMatrix * vec4(p, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}`;

const STREAK_FS = /* glsl */ `
${DESERT_UNIFORMS}
${FACE_GLSL}
uniform vec3 uDustCol;
varying vec2 vUv;
varying float vA;
void main() {
  float a = (1.0 - smoothstep(0.2, 0.5, abs(vUv.x))) * (1.0 - smoothstep(0.1, 0.5, abs(vUv.y)));
  a *= vA * 0.55 * faceHold();
  if (a < 0.004) discard;
  gl_FragColor = vec4(uDustCol, a);
  #include <colorspace_fragment>
}`;

const PUFF_VS = /* glsl */ `
${DESERT_UNIFORMS}
in vec4 aP0;     // spawn x, y, z (terrain-local), spawn time (s, page clock)
in vec4 aV;      // velocity xyz, size
uniform float uNow;
varying vec2 vUv;
varying float vA;
varying float vSeed;
void main() {
  vUv = position.xy;
  float t = uNow - aP0.w;
  float life = 2.6 + aV.w * 0.8;
  vec3 wind = vec3(uWindT.x, 0.0, uWindT.y) * 0.35;
  // decelerating outward burst (drag), buoyant rise, wind drift
  float drag = (1.0 - exp(-t * 2.2)) / 2.2;
  vec3 c = aP0.xyz + aV.xyz * drag + vec3(0.0, 0.35 * t, 0.0) + wind * t;
  float s = aV.w * (0.6 + 1.9 * (1.0 - exp(-t * 1.4)));
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  // model space of the world group == terrain-local; the view basis is in room space: rotate it back
  mat3 inv = transpose(mat3(modelMatrix));
  vec3 p = c + (inv * right) * position.x * s + (inv * up) * position.y * s;
  vA = (t >= 0.0 && t < life) ? smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(life * 0.35, life, t)) : 0.0;
  // a puff never smothers the lens (a camera low under the legs): it thins out within about its own size of the camera
  vA *= smoothstep(s * 0.8 + 2.0, s * 2.2 + 9.0, length(c - uCamT));
  // world-anchored puff texture seed (x 1536/4096, z 3712/4096: periodic in the 4096 m anchor, so a rebase keeps it)
  vSeed = fract((aP0.x + uAnc.x) * 0.375 + (aP0.z + uAnc.y) * 0.90625);
  gl_Position = vA > 0.001 ? projectionMatrix * modelViewMatrix * vec4(p, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}`;

const PUFF_FS = /* glsl */ `
${DESERT_UNIFORMS}
${FACE_GLSL}
${NOISE_GLSL}
uniform vec3 uPuffCol;
varying vec2 vUv;
varying float vA;
varying float vSeed;
void main() {
  float r = length(vUv) * 2.0;
  float n = vnf(vUv * 3.0 + vSeed * 17.0);
  float a = (1.0 - smoothstep(0.35 + 0.3 * n, 1.0, r)) * vA * 0.55 * faceHold();
  if (a < 0.004) discard;
  vec3 col = uPuffCol * (0.85 + 0.3 * n);
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

export class DesertDust {
  readonly group = new THREE.Group();
  readonly faceU = { uFaces: { value: Array.from({ length: FACE_SLOTS }, () => new THREE.Vector4(-1, -1, -1, -1)) }, uFaceN: { value: 0 }, uFaceDim: { value: 0.25 } };
  private streaks: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private puffs: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private sU: Record<string, THREE.IUniform>;
  private pU: Record<string, THREE.IUniform>;
  private aP0: THREE.InstancedBufferAttribute;
  private aV: THREE.InstancedBufferAttribute;
  private liveKey = 0;
  private evRing = 0;
  private t0 = -1;
  private quality = 'high';
  /** Dry boxes in room space (min, max). */
  dry: THREE.Box3[] = [];
  stats = { streaks: 0, puffs: 0, spawned: 0 };

  constructor(du: DesertUniforms) {
    this.group.name = 'vtp:desert:dust';
    const quad = (sx: number) => { const g = new THREE.InstancedBufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([-sx, -0.5, 0, sx, -0.5, 0, sx, 0.5, 0, -sx, 0.5, 0], 3)); g.setIndex([0, 1, 2, 0, 2, 3]); return g; };
    // streaks
    const sg = quad(0.5);
    const seeds = new Float32Array(MAX_STREAKS * 4);
    for (let i = 0; i < MAX_STREAKS; i++) { seeds[i * 4] = rnd(91, i, 1); seeds[i * 4 + 1] = rnd(91, i, 2); seeds[i * 4 + 2] = rnd(91, i, 3); seeds[i * 4 + 3] = rnd(91, i, 4); }
    sg.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    sg.instanceCount = 0;
    this.sU = { ...du, ...this.faceU, uBox: { value: 90 }, uGround: { value: 0 }, uDustCol: { value: new THREE.Color() }, uCount: { value: 0 },
      uDryMin: { value: Array.from({ length: MAX_DRY_BOXES }, () => new THREE.Vector4()) }, uDryMax: { value: Array.from({ length: MAX_DRY_BOXES }, () => new THREE.Vector4()) }, uDryN: { value: 0 } };
    const sm = new THREE.ShaderMaterial({ vertexShader: STREAK_VS, fragmentShader: STREAK_FS, uniforms: this.sU, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide });
    sm.forceSinglePass = true;                 // (flat streak quads: one pass looks the same)
    sm.name = 'vtp:desert:streaks';
    this.streaks = new THREE.Mesh(sg, sm);
    this.streaks.name = 'vtp:desert:streaks';
    this.streaks.frustumCulled = false;
    this.streaks.renderOrder = 60;
    this.streaks.visible = false;
    this.group.add(this.streaks);
    // puffs
    const pg = quad(0.5);
    this.aP0 = new THREE.InstancedBufferAttribute(new Float32Array(PUFFS * 4).fill(-1e6), 4);
    this.aV = new THREE.InstancedBufferAttribute(new Float32Array(PUFFS * 4), 4);
    this.aP0.setUsage(THREE.DynamicDrawUsage); this.aV.setUsage(THREE.DynamicDrawUsage);
    pg.setAttribute('aP0', this.aP0); pg.setAttribute('aV', this.aV);
    pg.instanceCount = PUFFS;
    this.pU = { ...du, ...this.faceU, uNow: { value: 0 }, uPuffCol: { value: new THREE.Color() } };
    const pm = new THREE.ShaderMaterial({ vertexShader: PUFF_VS, fragmentShader: PUFF_FS, uniforms: this.pU, transparent: true, depthWrite: false, fog: false });
    pm.name = 'vtp:desert:puffs';
    this.puffs = new THREE.Mesh(pg, pm);
    this.puffs.name = 'vtp:desert:puffs';
    this.puffs.frustumCulled = false;
    this.puffs.renderOrder = 55;
    this.group.add(this.puffs);
  }

  setQuality(q: string) { this.quality = q; }

  private clock(now: number) { if (this.t0 < 0) this.t0 = now; return (now - this.t0) / 1000; }

  /** Write one burst (12-20 puffs) into slots from `slot` on; returns the next free slot. t0 = start (s, page clock). */
  private burst(slot: number, end: number, x: number, y: number, z: number, r: number, seed: number, t0: number, boost = 0): number {
    const n = 12 + Math.floor(rnd(seed, 1) * 9) + Math.round(8 * boost);
    r *= 1 + 0.6 * boost;
    for (let i = 0; i < n && slot < end; i++, slot++) {
      const a = rnd(seed, i, 2) * Math.PI * 2, sp = (1.5 + 3.5 * rnd(seed, i, 3)) * Math.sqrt(r);
      this.aP0.setXYZW(slot, x + Math.cos(a) * r * 0.9, y + 0.15, z + Math.sin(a) * r * 0.9, t0 + rnd(seed, i, 4) * 0.08);
      this.aV.setXYZW(slot, Math.cos(a) * sp, (0.6 + 1.6 * rnd(seed, i, 5)) * Math.sqrt(r), Math.sin(a) * sp, r * (0.7 + 0.6 * rnd(seed, i, 6)));
    }
    this.aP0.needsUpdate = true; this.aV.needsUpdate = true;
    this.stats.spawned += n;
    return slot;
  }

  /** A footfall from another walker (mech guest, crew): page-local event, its own ring of slots. */
  puff(x: number, y: number, z: number, r: number, now: number, seed = 0) {
    const t = this.clock(now);
    const n = 20;
    const s0 = SHIP_SLOTS + this.evRing;
    this.evRing = (this.evRing + n) % (PUFFS - SHIP_SLOTS - n);
    this.burst(s0, s0 + n, x, y, z, r, seed || Math.floor(t * 1000), t);
  }

  /** The ship's closed-form plants. The ship slots are a pure function of the plants still kicking dust (touched down
   *  less than 4 s ago, from the distance since touchdown and the speed): two pages at the same moment hold the same
   *  puffs, and a page that opens mid-walk shows the bursts still in the air. Rewritten only when that set changes. */
  plants(list: Plant[], d: number, now: number, O: { x: number; z: number }, h: (x: number, z: number) => number, speed = 3, wake?: number) {
    const tNow = this.clock(now);
    const sp = Math.max(0.2, Number.isFinite(speed) ? speed : 3);
    // battle pace (SPEC 11.5 R1: battle 3.0 m/s): heavier bursts with the sand wake (wakeK: from WAKE_SPEED, full at
    // WAKE_FULL, or the voyage's own wake level), in quarter steps (a rewrite restarts nothing: the burst set is a pure
    // function of the plants and the boost)
    const boost = Math.round((wake !== undefined && Number.isFinite(wake) ? Math.min(1, Math.max(0, wake)) : wakeK(sp)) * 4) / 4;
    // the set of plants still kicking dust, hashed without allocating (rebuilt only when it changes)
    let key = Math.imul(0x9e3779b1, boost * 4 + 1) ^ Math.imul(O.x | 0, 0x85ebca6b) ^ Math.imul(O.z | 0, 0xc2b2ae35);
    for (const p of list) { const age = d - p.d; if (age >= 0 && age / sp < 4) key = (Math.imul(key ^ (p.leg * 0x10000 + (p.k & 0xffff)), 0x01000193) + (p.k >> 16)) | 0; }
    if (key === this.liveKey) return;
    this.liveKey = key;
    const live = list.filter((p) => { const age = d - p.d; return age >= 0 && age / sp < 4; }).sort((a, b) => a.leg - b.leg || a.k - b.k);
    let slot = 0;
    for (const p of live) slot = this.burst(slot, SHIP_SLOTS, p.x - O.x, h(p.x, p.z), p.z - O.z, p.r * Math.sqrt(p.len), p.id, tNow - (d - p.d) / sp, boost);
    for (; slot < SHIP_SLOTS; slot++) this.aP0.setXYZW(slot, 0, -1e6, 0, -1e6);
    this.aP0.needsUpdate = true;
  }

  /** The terrain origin moved by (dx, dz): keep every puff in flight at its world position. */
  rebase(dx: number, dz: number) {
    const a = this.aP0.array as Float32Array;
    for (let i = 0; i < PUFFS; i++) { if (a[i * 4 + 1] < -1e5) continue; a[i * 4] -= dx; a[i * 4 + 2] -= dz; }
    this.aP0.needsUpdate = true;
  }

  update(w: DesertWorld, f: DesertFrame, L: DesertLight, _dt: number, storm: number, _wall: number | null) {
    const now = f.now ?? Date.now();
    this.pU.uNow.value = this.clock(now);
    (this.pU.uPuffCol.value as THREE.Color).copy(w.farGround()).multiplyScalar(1.25).lerp(L.hazeCol, 0.35).lerp(L.dust, 0.25 * storm);
    // streaks
    const count = storm > 0.02 ? Math.round((STREAKS[this.quality] ?? 1500) * Math.min(1, 0.25 + storm)) : 0;
    this.streaks.visible = count > 0;
    this.streaks.geometry.instanceCount = count;
    this.sU.uCount.value = count;
    this.sU.uBox.value = 70 + 40 * (1 - storm);
    this.sU.uGround.value = w.pose.h0;
    (this.sU.uDustCol.value as THREE.Color).copy(L.dust).lerp(L.hazeSun, 0.25).multiplyScalar(1.1);
    // dry boxes (given in ROOM space = desert.root's local frame, like the casters; the shader tests the streak's
    // scene position, so carry them through root.matrixWorld) + faces
    const n = Math.min(MAX_DRY_BOXES, this.dry.length);
    for (let i = 0; i < n; i++) {
      const b = DRY_TMP.copy(this.dry[i]).applyMatrix4(w.root.matrixWorld);
      (this.sU.uDryMin.value as THREE.Vector4[])[i].set(b.min.x, b.min.y, b.min.z, 0); (this.sU.uDryMax.value as THREE.Vector4[])[i].set(b.max.x, b.max.y, b.max.z, 0);
    }
    this.sU.uDryN.value = n;
    const faces = f.faces ?? [];
    const nf = Math.min(FACE_SLOTS, faces.length);
    this.faceU.uFaceN.value = nf;
    for (let i = 0; i < nf; i++) this.faceU.uFaces.value[i].copy(faces[i]);
    this.stats.streaks = count;
    this.stats.puffs = PUFFS;
  }

  dispose() { this.streaks.geometry.dispose(); this.streaks.material.dispose(); this.puffs.geometry.dispose(); this.puffs.material.dispose(); }
}

const DRY_TMP = new THREE.Box3();
