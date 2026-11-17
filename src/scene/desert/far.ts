// Distant layers: mesas / buttes / spires out to ~36 km and city skylines 2.5-6 km off the route, all drawn
// DISTANCE-COMPRESSED (true direction + angular size, depth squeezed into < 2.3 km, haze at the true distance), plus the
// sandstorm's haboob wall rolling in from upwind. Active sets are rebuilt only when the camera crosses a cell or the
// terrain origin rebases; per frame it is uniforms only.
import * as THREE from 'three';
import { citiesNear, cityLayout, cellMesa, MESA_CELL, type City, type CityPart } from '../../../shared/desert/features.ts';
import { heightAt, type DesertWorldSpec } from '../../../shared/desert/height.ts';
import { COMPRESS_GLSL, DESERT_UNIFORMS, NOISE_GLSL, SHADE_GLSL } from './glsl.ts';
import { KitLayer, MAT, type KitInstance, type Shape } from './kit.ts';
import type { HeightClipmap } from './clipmap.ts';
import type { DesertUniforms } from './uniforms.ts';
import type { DesertLight } from './light.ts';
import type { DesertFrame, DesertWorld } from './index.ts';

const MESA_RANGE: Record<string, number> = { low: 20000, medium: 28000, high: 36000, ultra: 40000 };
const CITY_RANGE = 26000;

const WALL_VS = /* glsl */ `
${DESERT_UNIFORMS}
${COMPRESS_GLSL}
uniform vec3 uWallC;     // wall centre (terrain-local, ground)
uniform vec2 uWallDir;   // direction the wall travels (downwind, unit)
uniform float uWallR;    // curvature radius
varying vec2 vUv;
varying vec3 vPt;
void main() {
  vUv = uv;
  // plane: x across, y up; bent so the edges curl back upwind
  vec2 side = vec2(-uWallDir.y, uWallDir.x);
  float x = position.x, y = position.y;
  float back = x * x / (2.0 * uWallR);
  vec3 p = uWallC + vec3(side.x * x - uWallDir.x * back, y, side.y * x - uWallDir.y * back);
  vPt = p;
  float D = max(1.0, length(uWallC.xz - uCamT.xz));
  float k = dCompress(D) / D;
  vec3 q = uCamT + (p - uCamT) * k;
  q.y -= dDrop(D) * k;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(q, 1.0);
}`;

const WALL_FS = /* glsl */ `
${DESERT_UNIFORMS}
uniform vec3 uDustCol;
uniform float uWallA;
varying vec2 vUv;
varying vec3 vPt;
${NOISE_GLSL}
${SHADE_GLSL}
void main() {
  vec2 q = vec2(vUv.x * 40.0, vUv.y * 6.0);
  float t = uTime;
  float n = vnf(q + vec2(t * 0.05, -t * 0.08) + vnf(q * 2.1 - t * 0.06) * 1.6) * 0.55 + vnf(q * 3.7 + vec2(-t * 0.12, t * 0.05)) * 0.3 + vnf(q * 9.0 + t * 0.2) * 0.15;
  // cauliflower top edge (big lobes + small billows), solid body, soft ends that curl away
  float ends = smoothstep(0.0, 0.22, vUv.x) * smoothstep(1.0, 0.78, vUv.x);
  float top = (0.38 + 0.32 * vnf(vec2(vUv.x * 11.0 + t * 0.01, 1.0)) + 0.14 * vnf(vec2(vUv.x * 37.0 - t * 0.02, 5.0)) + 0.1 * n) * (0.35 + 0.65 * ends);
  float a = smoothstep(top, top - 0.12, vUv.y) * smoothstep(0.0, 0.1, ends);
  vec3 col = uDustCol * (0.55 + 0.6 * n) * (0.65 + 0.35 * smoothstep(0.0, 0.7, vUv.y));
  // sun-lit rim on the billows
  col += uSunCol * smoothstep(top - 0.25, top - 0.02, vUv.y) * (0.35 + 0.4 * n) * 0.6;
  col = mix(col, dHaze(normalize(vPt - uCamT)), dFogAmt(uCamT, vPt) * 0.55);
  gl_FragColor = vec4(col, a * uWallA);
  #include <colorspace_fragment>
}`;

const GLOW_VS = /* glsl */ `
${DESERT_UNIFORMS}
${COMPRESS_GLSL}
in vec4 aGlow;          // centre x, y, z (terrain-local), radius
varying vec2 vUv;
varying vec3 vPt;
void main() {
  vUv = position.xy;
  vec3 c = aGlow.xyz;
  float D = max(1.0, length(c.xz - uCamT.xz));
  float k = dCompress(D) / D;
  vec3 cc = uCamT + (c - uCamT) * k; cc.y -= dDrop(D) * k;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  mat3 inv = transpose(mat3(modelMatrix));
  vec3 p = cc + ((inv * right) * position.x * 1.6 + (inv * up) * position.y * 0.55) * aGlow.w * k;
  vPt = c;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const GLOW_FS = /* glsl */ `
${DESERT_UNIFORMS}
${SHADE_GLSL}
uniform vec3 uGlowCol;
varying vec2 vUv;
varying vec3 vPt;
void main() {
  float r = length(vUv * vec2(1.0, 1.6));
  float a = pow(max(0.0, 1.0 - r), 2.2) * smoothstep(-0.5, 0.1, vUv.y + 0.35);
  a *= uDark * (1.0 - uStorm * 0.7) * (1.0 - 0.6 * dFogAmt(uCamT, vPt));
  if (a < 0.002) discard;
  gl_FragColor = vec4(uGlowCol * a, 1.0);
  #include <colorspace_fragment>
}`;

export class DesertFar {
  readonly group = new THREE.Group();
  readonly kit: KitLayer;
  /** '' = rebuild at the next update (quality / cities / ground changed); k = the cell key last built. */
  private key = '';
  private k = [NaN, NaN, NaN, NaN, NaN];
  private quality = 'high';
  private wall: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private glow: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private glowA: THREE.InstancedBufferAttribute;
  private wallU: Record<string, THREE.IUniform>;
  cities: City[] = [];
  /** per-cell mesa results (world; null = empty cell) and per-city part lists: the expensive bits (ground heights) */
  private mesaCache = new Map<string, { m: NonNullable<ReturnType<typeof cellMesa>>; base: number } | null>();
  private cityCache = new Map<number, { base: number; parts: CityPart[] }>();
  stats = { mesas: 0, cities: 0, parts: 0, draws: 0, rebuilds: 0, wall: false };

  constructor(private spec: DesertWorldSpec, du: DesertUniforms, clip: HeightClipmap) {
    this.group.name = 'vtp:desert:far';
    this.kit = new KitLayer('far', du, clip, { mesa: 900, spire: 300, box: 1400, dome: 500, cyl: 500, cone: 400, hull: 24 });
    this.group.add(this.kit.group);
    this.wallU = { ...du, uWallC: { value: new THREE.Vector3() }, uWallDir: { value: new THREE.Vector2(1, 0) }, uWallR: { value: 2600 }, uDustCol: { value: new THREE.Color() }, uWallA: { value: 0 } };
    const wm = new THREE.ShaderMaterial({ vertexShader: WALL_VS, fragmentShader: WALL_FS, uniforms: this.wallU, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
    wm.name = 'vtp:desert:haboob';
    wm.forceSinglePass = true;                 // (an open curved sheet: one pass looks the same)
    const g = new THREE.PlaneGeometry(7000, 1100, 160, 20).translate(0, 550, 0);
    this.wall = new THREE.Mesh(g, wm);
    this.wall.name = 'vtp:desert:haboob';
    this.wall.frustumCulled = false;
    this.wall.renderOrder = 40;
    this.wall.visible = false;
    this.group.add(this.wall);
    // city light domes at night (additive, one draw for every city)
    const gg = new THREE.InstancedBufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    gg.setIndex([0, 1, 2, 0, 2, 3]);
    this.glowA = new THREE.InstancedBufferAttribute(new Float32Array(16 * 4), 4);
    gg.setAttribute('aGlow', this.glowA);
    gg.instanceCount = 0;
    const gm = new THREE.ShaderMaterial({ vertexShader: GLOW_VS, fragmentShader: GLOW_FS, uniforms: { ...du, uGlowCol: { value: new THREE.Color('#ff9a48').multiplyScalar(0.55) } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    gm.name = 'vtp:desert:cityglow';
    this.glow = new THREE.Mesh(gg, gm);
    this.glow.name = 'vtp:desert:cityglow';
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 30;
    this.group.add(this.glow);
  }

  setQuality(q: string) { this.quality = q; this.key = ''; }

  /** Voyage-placed cities (DesertWorld.setCities): replace the seeded skyline cities (or join them, keepSeeded). */
  private placed: City[] | null = null;
  private keepSeeded = false;
  setPlaced(list: City[] | null, keepSeeded = false) { this.placed = list; this.keepSeeded = keepSeeded; this.key = ''; }

  /** The ground changed under these world discs: re-sit the mesas and cities near them. */
  invalidate(discs: readonly { x: number; z: number; r: number }[]) {
    for (const [k, e] of [...this.mesaCache]) if (e && discs.some((c) => Math.hypot(e.m.x - c.x, e.m.z - c.z) < c.r + e.m.r + 50)) this.mesaCache.delete(k);
    this.cityCache.clear();
    this.key = '';
  }

  update(w: DesertWorld, f: DesertFrame, L: DesertLight) {
    const O = w.origin();
    const cx = Math.floor((w.camT.x + O.x) / MESA_CELL), cz = Math.floor((w.camT.z + O.z) / MESA_CELL);
    const cityKey = Math.floor(f.d / 2000);
    // pure in the key: ranges from the mesa cell's centre, cities around the 2 km bucket's middle (two pages that reach
    // the same key by different paths hold the same set). Compared field by field: no string per frame.
    const K = this.k;
    if (this.key === '' || K[0] !== cx || K[1] !== cz || K[2] !== O.x || K[3] !== O.z || K[4] !== cityKey) {
      this.key = 'built'; K[0] = cx; K[1] = cz; K[2] = O.x; K[3] = O.z; K[4] = cityKey;
      this.rebuild(w, (cx + 0.5) * MESA_CELL, (cz + 0.5) * MESA_CELL, (cityKey + 0.5) * 2000);
    }
    // haboob wall
    const front = f.stormFront;
    const show = front !== undefined && front > 0.001 && front < 0.995;
    this.wall.visible = show;
    this.stats.wall = show;
    if (show) {
      const dist = Math.max(40, 3200 * (1 - front!));
      // the wall comes from upwind (the dune wind blows along +u = (c, s)) and travels downwind towards the ship
      const P = w.pose;
      const ux = this.spec.c, uz = this.spec.s;
      (this.wallU.uWallC.value as THREE.Vector3).set(P.x - O.x - ux * dist, P.h0 - 30, P.z - O.z - uz * dist);
      (this.wallU.uWallDir.value as THREE.Vector2).set(ux, uz);
      this.wallU.uWallR.value = Math.max(1800, dist * 1.6);
      (this.wallU.uDustCol.value as THREE.Color).copy(L.dust);
      this.wallU.uWallA.value = Math.min(1, front! * 4) * (1 - smooth(0.9, 0.995, front!));
    }
    this.glow.visible = w.du.uDark.value > 0.05 && this.cities.length > 0;
    this.stats.draws = this.kit.draws + (show ? 1 : 0) + (this.glow.visible ? 1 : 0);
  }

  private rebuild(w: DesertWorld, camWx: number, camWz: number, d: number) {
    const O = w.origin();
    const list: KitInstance[] = [];
    const R = MESA_RANGE[this.quality] ?? MESA_RANGE.high;
    const cr = Math.ceil(R / MESA_CELL);
    const cx0 = Math.floor(camWx / MESA_CELL), cz0 = Math.floor(camWz / MESA_CELL);
    let mesas = 0;
    const keep = new Set<string>();
    for (let j = -cr; j <= cr; j++) for (let i = -cr; i <= cr; i++) {
      const ck = `${cx0 + i},${cz0 + j}`;
      keep.add(ck);
      let e = this.mesaCache.get(ck);
      if (e === undefined) { const m = cellMesa(this.spec, cx0 + i, cz0 + j); e = m ? { m, base: heightAt(this.spec, m.x, m.z) - m.h * 0.05 } : null; this.mesaCache.set(ck, e); }
      if (!e) continue;
      const m = e.m;
      const dx = m.x - camWx, dz = m.z - camWz;
      if (dx * dx + dz * dz > R * R) continue;
      const shape: Shape = m.kind === 'spire' ? 'spire' : 'mesa';
      const anchor = new THREE.Vector3(m.x - O.x, e.base, m.z - O.z);
      const mm = new THREE.Matrix4().compose(anchor, new THREE.Quaternion().setFromAxisAngle(UP, m.yaw), new THREE.Vector3(m.r, m.h, m.r * (m.kind === 'butte' ? 0.8 : 1)));
      list.push({ shape, m: mm, mat: MAT.stone, tint: (m.id % 1000) / 1000, emit: 0, compressed: true, anchor });
      mesas++;
    }
    for (const k of this.mesaCache.keys()) if (!keep.has(k)) this.mesaCache.delete(k);
    // cities
    const seeded = !this.placed || this.keepSeeded ? citiesNear(this.spec, d, CITY_RANGE) : [];
    this.cities = this.placed ? [...this.placed.filter((c) => Math.abs(c.d - d) <= CITY_RANGE), ...seeded] : seeded;
    let parts = 0;
    for (const c of this.cities) {
      let cc = this.cityCache.get(c.id);
      if (!cc) { cc = { base: heightAt(this.spec, c.x, c.z) - 1.5, parts: cityLayout(c) }; this.cityCache.set(c.id, cc); }
      const anchor = new THREE.Vector3(c.x - O.x, cc.base, c.z - O.z);
      const rot = w.route.heading(c.d);
      for (const p of cc.parts) parts += this.part(list, p, anchor, rot, c);
    }
    if (this.cityCache.size > 24) for (const k of [...this.cityCache.keys()]) if (!this.cities.some((c) => c.id === k)) this.cityCache.delete(k);
    this.kit.fill(list);
    this.cities.slice(0, 16).forEach((c, i) => this.glowA.setXYZW(i, c.x - O.x, (this.cityCache.get(c.id)?.base ?? 0) + c.radius * 0.12, c.z - O.z, c.radius * 1.4));
    this.glowA.needsUpdate = true;
    this.glow.geometry.instanceCount = Math.min(16, this.cities.length);
    this.stats = { mesas, cities: this.cities.length, parts, draws: this.kit.draws + (this.wall.visible ? 1 : 0), rebuilds: this.stats.rebuilds + 1, wall: this.wall.visible };
  }

  /** One city part -> 1..4 kit instances (city-local -> terrain-local). */
  private part(list: KitInstance[], p: CityPart, anchor: THREE.Vector3, rot: number, c: City): number {
    const cs = Math.cos(rot), sn = Math.sin(rot);
    const at = new THREE.Vector3(anchor.x + p.x * cs - p.z * sn, anchor.y + p.y, anchor.z + p.x * sn + p.z * cs);
    const q = new THREE.Quaternion().setFromAxisAngle(UP, p.yaw + rot);
    const n0 = list.length;
    const add = (shape: Shape, dx: number, dy: number, dz: number, sx: number, sy: number, sz: number, mat: number, emit: number, extraYaw = 0) => {
      const off = new THREE.Vector3(dx, dy, dz).applyQuaternion(q);
      const qq = extraYaw ? q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(UP, extraYaw)) : q;
      list.push({ shape, m: new THREE.Matrix4().compose(at.clone().add(off), qq, new THREE.Vector3(sx, sy, sz)), mat, tint: p.tint, emit, compressed: true, anchor });
    };
    const wallMat = c.archetype === 'cistern' ? MAT.plaster : MAT.adobe;
    switch (p.kind) {
      case 'plinth': add('mesa', 0, -p.h * 0.1, 0, p.w * 0.5, p.h * 1.1, p.d * 0.5, MAT.stone, 0); break;
      case 'box': add('box', 0, 0, 0, p.w, p.h, p.d, wallMat, p.emit); break;
      case 'wall': add('box', 0, 0, 0, p.w, p.h, Math.max(1.5, p.d * 0.25), MAT.adobe, 0); break;
      case 'dome': add('cyl', 0, 0, 0, p.w, p.h * 0.45, p.w, wallMat, p.emit * 0.5); add('dome', 0, p.h * 0.45, 0, p.w, p.h * 0.55, p.w, c.archetype === 'cistern' ? MAT.plaster : MAT.bone, 0); break;
      case 'tower': add('cyl', 0, 0, 0, p.w, p.h, p.w, wallMat, p.emit); add('dome', 0, p.h, 0, p.w * 1.1, p.w * 0.5, p.w * 1.1, MAT.bone, 0); break;
      case 'spire': add('cyl', 0, 0, 0, p.w, p.h * 0.45, p.w, wallMat, p.emit); add('cone', 0, p.h * 0.45, 0, p.w * 0.8, p.h * 0.55, p.w * 0.8, MAT.bone, 0); break;
      case 'windcatcher': add('box', 0, 0, 0, p.w, p.h, p.w, wallMat, p.emit); add('box', 0, p.h, 0, p.w * 1.25, p.w * 0.45, p.w * 1.25, MAT.wood, 0); break;
      case 'hull': add('hull', 0, p.y, 0, p.w, p.h, p.d, MAT.rust, p.emit); break;
      case 'crane': add('box', 0, 0, 0, p.w, p.h, p.w, MAT.rust, 0); add('box', 0, p.h, p.d * 0.3, p.w * 0.6, p.w * 0.6, p.d, MAT.rust, 0); break;
      case 'tent': add('cone', 0, 0, 0, p.w, p.h, p.d, MAT.cloth, p.emit * 0.4); break;
      case 'windmill': add('cyl', 0, 0, 0, p.w * 0.6, p.h, p.w * 0.6, MAT.wood, 0); add('box', 0, p.h * 0.72, p.w * 0.4, 0.8, p.h * 0.46, 0.3, MAT.cloth, 0); add('box', 0, p.h * 0.93, p.w * 0.4, p.h * 0.46, 0.8, 0.3, MAT.cloth, 0); break;
    }
    return list.length - n0;
  }

  dispose() { this.kit.dispose(); this.wall.geometry.dispose(); this.wall.material.dispose(); this.glow.geometry.dispose(); this.glow.material.dispose(); }
}

const UP = new THREE.Vector3(0, 1, 0);
function smooth(e0: number, e1: number, x: number) { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }
