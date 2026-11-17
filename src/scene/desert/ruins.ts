// The desert's ruins (rules: shared/desert/ruins.ts): burning wrecks near the route and ruined towns / industrial
// skylines on the horizon band, plus their fire, smoke columns and night beacons.
//   wrecks  a fallen walker, a broken hull, a toppled tower or an overturned convoy, 165..330 m out; most burn: a fire
//           (GPU particles: additive cards, pure in the wall clock) and a tall smoke column leaning downwind
//   towns   kit-bashed industrial ruins 1.15..2.25 km out on the high ground: halls with broken roofs, chimney stacks
//           (smoke + red beacons at night), gantry cranes, tank farms, fort walls and towers; windows light at night
// Geometry: one KitLayer (instanced kit shapes, one material; world-anchored shading, lit windows by darkness). Effects:
// two draws (fire + beacons additive, smoke alpha), every particle a pure function of (emitter, index, uTime): two pages
// at the same clock draw the same flames. The active set is rebuilt when the ship crosses a 40 m step or the origin
// rebases (cached per item); per frame it is uniforms only. Things inside a city / dig-site disc or a keep-out are hidden.
import * as THREE from 'three';
import { heightAt, type DesertWorldSpec } from '../../../shared/desert/height.ts';
import { DesertRoute } from '../../../shared/desert/route.ts';
import { rnd } from '../../../shared/desert/noise.ts';
import { burningNear, cleanDensity, townsIn, wrecksIn, type TownItem, type WreckItem } from '../../../shared/desert/ruins.ts';
import { DESERT_UNIFORMS, NOISE_GLSL, SHADE_GLSL } from './glsl.ts';
import { KitLayer, MAT, type KitInstance } from './kit.ts';
import { Builder, type Part } from './marks.ts';
import type { HeightClipmap } from './clipmap.ts';
import type { DesertUniforms } from './uniforms.ts';
import type { DesertLight } from './light.ts';
import type { DesertFrame, DesertWorld } from './index.ts';

const STEP = 40;
const MAX_E = 32;
const FIRE_N = 30;
const SMOKE_N = 44;
const WRECK_AHEAD: Record<string, number> = { low: 1400, medium: 2000, high: 2600, ultra: 3000 };
const WRECK_BEHIND: Record<string, number> = { low: 500, medium: 700, high: 900, ultra: 1100 };
const TOWN_ALONG: Record<string, number> = { low: 1800, medium: 2600, high: 3200, ultra: 3600 };

/** A fire / beacon / smoke source (terrain-local). kind 0 = fire (+ smoke when smoke > 0), 1 = beacon (a blinking red
 *  light), 2 = chimney smoke only, 3 = a town's night glow (a wide soft amber light over it). */
interface Emitter { x: number; y: number; z: number; size: number; kind: 0 | 1 | 2 | 3; strength: number; seed: number; smoke: number }
type EmitB = Omit<Emitter, 'x' | 'z'> & { wx: number; wz: number };
interface Built { parts: Part[]; x: number; z: number; r: number; emit: EmitB[] }

const FX_VS = /* glsl */ `
${DESERT_UNIFORMS}
in vec4 aP;                        // emitter index, k (0..1 along its particles), r1, r2
uniform vec4 uE[${MAX_E}];         // x, y, z (terrain-local), size (m)
uniform vec4 uE2[${MAX_E}];        // kind (0 fire, 1 beacon, 2 smoke only), strength, seed, smoke height (m)
uniform float uKind;               // 0 = the fire / beacon pass (additive), 1 = the smoke pass
uniform float uN;
varying vec2 vUv;
varying float vA;
varying float vT;
varying float vSeed;
varying vec3 vPt;
void main() {
  vUv = position.xy;
  int ei = int(aP.x + 0.5);
  vec4 E = uE[ei], E2 = uE2[ei];
  float k = aP.y, r1 = aP.z, r2 = aP.w;
  vec3 wind = vec3(uWindT.x, 0.0, uWindT.y);
  float ws = length(wind);
  vec3 wd = ws > 0.01 ? wind / ws : vec3(1.0, 0.0, 0.0);
  vec3 c = E.xyz;
  float s = 1.0;
  vA = 0.0; vT = 0.0;
  if (uKind < 0.5) {
    if (E2.x > 2.5) {
      // a town's glow at night: one wide soft card over it
      s = E.w; c = E.xyz + vec3(0.0, E.w * 0.1, 0.0);
      vA = k < 0.001 ? E2.y * smoothstep(0.15, 0.6, uDark) : 0.0;
      vT = -3.0;
    } else if (E2.x > 1.5) vA = 0.0;
    else if (E2.x > 0.5) {
      // beacon: one blinking glow (particle 0 only), only in the dark
      float blink = smoothstep(0.35, 0.5, fract(uTime * 0.45 + E2.z)) * (1.0 - smoothstep(0.85, 1.0, fract(uTime * 0.45 + E2.z)));
      s = E.w * (1.0 + 0.4 * blink);
      vA = k < 0.001 ? E2.y * (0.2 + 0.8 * blink) * smoothstep(0.15, 0.6, uDark) : 0.0;
      vT = -1.0;
    } else if (k < 0.001) {
      // the fire's glow on the ground and the wreck (a big dim card at its base)
      c = E.xyz + vec3(0.0, E.w * 0.6, 0.0);
      s = E.w * 7.0;
      vA = E2.y * (0.16 + 0.42 * uDark) * (0.85 + 0.15 * sin(uTime * 7.0 + E2.z * 20.0));
      vT = -2.0;
    } else {
      float life = 1.0 + 0.8 * r1;
      float age = fract(uTime / life + k * 7.31 + r2);
      float rr = sqrt(fract(k * 13.7 + r1));
      vec2 disc = vec2(cos(r1 * 31.4 + k * 12.0), sin(r2 * 27.1 + k * 9.0)) * E.w * 0.75 * rr;
      c = E.xyz + vec3(disc.x, age * E.w * (2.0 + 1.4 * r2), disc.y) + wd * age * age * E.w * 0.9
        + vec3(sin(uTime * 3.1 + k * 20.0), 0.0, cos(uTime * 2.7 + k * 17.0)) * E.w * 0.18 * age;
      s = E.w * (0.95 - 0.6 * age) * (0.7 + 0.5 * r1) * (1.0 - 0.35 * rr);
      vA = E2.y * smoothstep(0.0, 0.08, age) * (1.0 - smoothstep(0.4, 1.0, age));
      vT = age;
    }
  } else if (E2.w > 1.0) {
    // smoke column: puffs rise, swell and lean downwind (a continuous loop: age = fract(t / period + k))
    float H = E2.w;
    float period = 24.0 + 10.0 * fract(E2.z * 3.1);
    float age = fract(uTime / period + k + r1 * 0.11);
    float lean = pow(age, 1.45) * H * (0.3 + 0.025 * ws);
    c = E.xyz + vec3(0.0, E.w * 0.5 + pow(age, 0.82) * H, 0.0) + wd * lean
      + vec3(sin(r1 * 40.0 + uTime * 0.21), 0.0, cos(r2 * 37.0 + uTime * 0.17)) * (E.w * 0.5 + H * 0.1 * age);
    s = (E.w * 2.4 + H * 0.36 * age) * (0.7 + 0.6 * r2);
    vA = E2.y * smoothstep(0.0, 0.04, age) * (1.0 - smoothstep(0.55, 1.0, age)) * (E2.x > 1.5 ? 0.55 : 0.92);
    vT = age;
  }
  if (aP.x > uN - 0.5) vA = 0.0;
  vSeed = r1;
  vPt = c;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  mat3 inv = transpose(mat3(modelMatrix));
  // flames are tongues (taller than wide); everything else a round card
  vec2 sq = uKind < 0.5 && vT >= 0.0 ? vec2(0.7, 1.55) : vT < -2.5 ? vec2(1.0, 0.4) : vec2(1.0);
  vec3 p = c + (inv * right) * position.x * s * sq.x + (inv * up) * position.y * s * sq.y;
  gl_Position = vA > 0.002 ? projectionMatrix * modelViewMatrix * vec4(p, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}`;

const FX_FS = /* glsl */ `
${DESERT_UNIFORMS}
${NOISE_GLSL}
${SHADE_GLSL}
uniform float uKind;
uniform vec3 uSoot; uniform vec3 uAsh; uniform vec3 uBeacon;
varying vec2 vUv;
varying float vA;
varying float vT;
varying float vSeed;
varying vec3 vPt;
void main() {
  float r = length(vUv) * 2.0;
  float fog = dFogAmt(uCamT, vPt);
  if (uKind < 0.5) {
    vec3 col; float a;
    if (vT < -2.5) { float g = exp(-r * r * 2.4); col = vec3(1.0, 0.52, 0.2) * g * 0.9; a = g * vA * (1.0 + fog * 0.35); }
    else if (vT < -1.5) { float g = exp(-r * r * 3.0); col = vec3(1.0, 0.42, 0.12) * g; a = g * vA; }
    else if (vT < -0.5) { float g = exp(-r * r * 6.0) + 0.25 * exp(-r * r * 1.2); col = uBeacon * g * 2.4; a = min(1.0, g) * vA; }
    else {
      // a flame tongue: noise racing upward eats the card from its edges and its tip
      float n = vnf(vec2(vUv.x * 4.0 + vSeed * 11.0, vUv.y * 3.0 - uTime * 5.0 + vSeed * 7.0)) * 0.65 + vnf(vUv * 9.0 - vec2(0.0, uTime * 8.0)) * 0.35;
      float rt = length(vec2(vUv.x * 2.0, (vUv.y + 0.15) * 1.7 - 0.0)) ;
      a = (1.0 - smoothstep(0.2 + 0.55 * n, 1.0, rt + max(0.0, vUv.y) * 0.6 * n)) * vA;
      vec3 hot = mix(vec3(1.0, 0.86, 0.5), vec3(1.0, 0.38, 0.07), smoothstep(0.0, 0.45, vT));
      hot = mix(hot, vec3(0.45, 0.07, 0.02), smoothstep(0.5, 1.0, vT));
      col = hot * (2.0 + 1.6 * n);
    }
    a *= 1.0 - fog * (vT < -2.5 ? 0.45 : 0.85);
    if (a < 0.003) discard;
    gl_FragColor = vec4(col, a);
  } else {
    float n = vnf(vUv * 2.6 + vSeed * 13.0 + uTime * 0.08);
    float a = (1.0 - smoothstep(0.2 + 0.45 * n, 1.0, r)) * vA;
    if (a < 0.004) discard;
    vec3 col = mix(uSoot, uAsh, smoothstep(0.05, 0.75, vT)) * (0.75 + 0.45 * n);
    col += uSunCol * 0.12 * (0.5 + 0.5 * vUv.y) * (1.0 - vT * 0.5);          // the sunny side of each billow
    col += vec3(1.0, 0.36, 0.08) * 0.35 * pow(1.0 - vT, 12.0) * (0.3 + 0.7 * uDark);  // lit from below by the fire
    col = mix(col, dHaze(normalize(vPt - uCamT)), fog);
    gl_FragColor = vec4(col, a);
  }
  #include <colorspace_fragment>
}`;

const quad = () => {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
};

export class DesertRuins {
  readonly group = new THREE.Group();
  readonly kit: KitLayer;
  private fire: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private smoke: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private fu: Record<string, THREE.IUniform>;
  private su: Record<string, THREE.IUniform>;
  /** density 0..2 of wrecks / towns (room config) */
  wrecks = 1;
  towns = 1;
  private quality = 'high';
  private K = [NaN, NaN, NaN, NaN];
  private lit = new THREE.Color();
  private cache = new Map<string, Built>();
  private emitters: Emitter[] = [];
  private focusCache = new Map<number, { x: number; z: number; heading: number; s: number; lat: number }>();
  stats = { wrecks: 0, burning: 0, towns: 0, hidden: 0, emitters: 0, instances: 0, draws: 0, rebuilds: 0 };

  constructor(private spec: DesertWorldSpec, private du: DesertUniforms, clip: HeightClipmap) {
    this.group.name = 'vtp:desert:ruins';
    this.kit = new KitLayer('ruins', du, clip, {
      box: 1400, cyl: 260, walkerbody: 16, leg: 120, hull: 40, rib: 160, lattice: 70, truss: 40, chimney: 90, tank: 90, dome: 50,
      girder: 260, prism: 120, arcade: 60, rock: 160,
    });
    const mk = (n: number, kind: number, name: string, blend: THREE.Blending, order: number) => {
      const g = quad();
      const a = new Float32Array(n * MAX_E * 4);
      for (let e = 0; e < MAX_E; e++) for (let i = 0; i < n; i++) { const o = (e * n + i) * 4; a[o] = e; a[o + 1] = i / n; a[o + 2] = rnd(e, i, 951); a[o + 3] = rnd(e, i, 952); }
      g.setAttribute('aP', new THREE.InstancedBufferAttribute(a, 4));
      g.instanceCount = n * MAX_E;
      const u = { ...du, uE: { value: Array.from({ length: MAX_E }, () => new THREE.Vector4()) }, uE2: { value: Array.from({ length: MAX_E }, () => new THREE.Vector4()) },
        uKind: { value: kind }, uN: { value: 0 }, uSoot: { value: new THREE.Color('#1c1612') }, uAsh: { value: new THREE.Color('#6d6052') }, uBeacon: { value: new THREE.Color('#ff2a12') } };
      const m = new THREE.ShaderMaterial({ vertexShader: FX_VS, fragmentShader: FX_FS, uniforms: u, transparent: true, depthWrite: false, blending: blend, fog: false });
      m.name = name;
      const mesh = new THREE.Mesh(g, m);
      mesh.name = name; mesh.frustumCulled = false; mesh.renderOrder = order; mesh.visible = false;
      return mesh;
    };
    this.smoke = mk(SMOKE_N, 1, 'vtp:desert:ruins:smoke', THREE.NormalBlending, 35);
    this.fire = mk(FIRE_N, 0, 'vtp:desert:ruins:fire', THREE.AdditiveBlending, 36);
    this.fu = this.fire.material.uniforms; this.su = this.smoke.material.uniforms;
    // (one emitter table for both passes: the smoke pass reads the fire pass's arrays)
    this.su.uE = this.fu.uE; this.su.uE2 = this.fu.uE2; this.su.uN = this.fu.uN;
    this.group.add(this.kit.group, this.smoke, this.fire);
  }

  setQuality(q: string) { this.quality = q; this.K[0] = NaN; }
  setDensity(wrecks: unknown, towns: unknown) { this.wrecks = cleanDensity(wrecks); this.towns = cleanDensity(towns); this.K[0] = NaN; }
  invalidate() { this.K[0] = NaN; }

  /** The burning wreck the ship passes next (or has just passed): its fire in terrain-local metres + its reach, for
   *  camera shots that frame the walker going by it; null = none near. */
  wreckFocus(w: DesertWorld, d: number): { x: number; y: number; z: number; r: number; s: number; lat: number } | null {
    const it = burningNear(this.spec.seed, d, this.wrecks);
    if (!it) return null;
    let p = this.focusCache.get(it.id);
    if (!p) { p = this.flattest(w, it.s, it.lat, 30 * it.scale, [0, -60, 60], [0, -40]); this.focusCache.clear(); this.focusCache.set(it.id, p); }
    const O = w.origin();
    return { x: p.x - O.x, y: heightAt(this.spec, p.x, p.z) + 6 * it.scale, z: p.z - O.z, r: 24 * it.scale, s: p.s, lat: p.lat };
  }

  update(w: DesertWorld, f: DesertFrame, L: DesertLight) {
    const O = w.origin();
    const kd = Math.floor(f.d / STEP);
    const K = this.K;
    if (!(K[0] === kd && K[1] === O.x && K[2] === O.z && K[3] === this.wrecks * 10 + this.towns)) {
      K[0] = kd; K[1] = O.x; K[2] = O.z; K[3] = this.wrecks * 10 + this.towns;
      this.rebuild(w, (kd + 0.5) * STEP);          // (the cell's centre: pages that reached d by different paths agree)
    }
    // per frame: colours (lit like the world), emitter count
    const lit = this.lit.copy(L.key).multiplyScalar(0.35).add(L.skyAmb).add(L.gndAmb);
    (this.su.uSoot.value as THREE.Color).setRGB(0.07, 0.055, 0.045).multiply(lit).multiplyScalar(1.4);
    (this.su.uAsh.value as THREE.Color).copy(L.hazeCol).multiplyScalar(0.55).lerp(L.dust, 0.25).multiply(lit).multiplyScalar(1.6 * (0.35 + 0.65 * L.day));
    const n = this.emitters.length;
    this.fu.uN.value = n;
    // light pools: the main fires nearest the ship (the emitter list is sorted fires-first, nearest-first)
    const F = this.du.uFires.value as THREE.Vector4[];
    let nf = 0;
    for (const e of this.emitters) { if (nf >= F.length) break; if (e.kind === 0 && e.size >= 3) F[nf++].set(e.x, e.y + e.size * 0.6, e.z, 30 + e.size * 9); }
    for (; nf < F.length; nf++) F[nf].set(0, 0, 0, 0);
    this.fire.visible = n > 0;
    this.smoke.visible = this.emitters.some((e) => e.smoke > 0);
  }

  private place(w: DesertWorld, s: number, lat: number) {
    const p = w.route.at(s, { x: 0, z: 0, heading: 0, curv: 0 });
    const [ox, oz] = DesertRoute.toWorld(p.heading, lat, 0);
    return { x: p.x + ox, z: p.z + oz, heading: p.heading };
  }
  private gr = (x: number, z: number) => heightAt(this.spec, x, z);
  /** The flattest spot near a rule's placement (pure: the same candidates and the same heights on every page): a town
   *  never straddles a cliff edge, a wreck never hangs on a mesa wall. Candidates along / across the route. */
  private flattest(w: DesertWorld, s: number, lat: number, r: number, along: number[], across: number[]) {
    let best = { ...this.place(w, s, lat), s, lat }, bestV = Infinity;
    for (const ds of along) for (const dl of across) {
      const P = this.place(w, s + ds, lat + Math.sign(lat) * dl);
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < 9; k++) {
        const a = (k / 8) * Math.PI * 2, rr = k === 8 ? 0 : r;
        const h = this.gr(P.x + Math.cos(a) * rr, P.z + Math.sin(a) * rr);
        lo = Math.min(lo, h); hi = Math.max(hi, h);
      }
      const v = hi - lo + 0.002 * (Math.abs(ds) + Math.abs(dl));
      if (v < bestV) { bestV = v; best = { ...P, s: s + ds, lat: lat + Math.sign(lat) * dl }; }
    }
    return best;
  }

  private rebuild(w: DesertWorld, d: number) {
    const O = w.origin(), q = this.quality, seed = this.spec.seed;
    const keep = new Set<string>();
    const list: KitInstance[] = [];
    const em: (Emitter & { dist: number })[] = [];
    const st = { wrecks: 0, burning: 0, towns: 0, hidden: 0 };
    const discs: { x: number; z: number; r: number }[] = [];
    for (const fl of w.spec.flats) discs.push({ x: fl.x, z: fl.z, r: fl.r + 10 });
    for (const c of w.cities()) discs.push({ x: c.x, z: c.z, r: c.radius * 1.2 + 60 });
    for (const k of w.keepOuts()) discs.push(k);
    const ship = w.route.at(d, { x: 0, z: 0, heading: 0, curv: 0 });
    const maxDist = w.terrain.end - 150;
    const put = (key: string, make: () => Built, kind: 'wrecks' | 'towns') => {
      keep.add(key);
      let b = this.cache.get(key);
      if (!b) { b = make(); this.cache.set(key, b); }
      for (const c of discs) if (Math.hypot(b.x - c.x, b.z - c.z) < c.r + b.r) { st.hidden++; return; }
      if (Math.hypot(b.x - ship.x, b.z - ship.z) > maxDist) return;
      st[kind]++;
      for (const p of b.parts) {
        const pos = new THREE.Vector3(p.x - O.x, p.y, p.z - O.z);
        list.push({ shape: p.shape, m: new THREE.Matrix4().compose(pos, p.q, p.s), mat: p.mat, tint: p.tint, emit: p.emit, compressed: false, anchor: pos });
      }
      for (const e of b.emit) {
        if (e.kind === 0) st.burning++;
        em.push({ x: e.wx - O.x, y: e.y, z: e.wz - O.z, size: e.size, kind: e.kind, strength: e.strength, seed: e.seed, smoke: e.smoke, dist: Math.hypot(e.wx - ship.x, e.wz - ship.z) });
      }
    };
    if (this.wrecks > 0) for (const it of wrecksIn(seed, d - (WRECK_BEHIND[q] ?? 900), d + (WRECK_AHEAD[q] ?? 2600), this.wrecks)) put(`w${it.id}`, () => this.buildWreck(w, it), 'wrecks');
    if (this.towns > 0) { const R = TOWN_ALONG[q] ?? 3200; for (const it of townsIn(seed, d - R, d + R, this.towns)) put(`t${it.id}`, () => this.buildTown(w, it), 'towns'); }
    for (const k of [...this.cache.keys()]) if (!keep.has(k)) this.cache.delete(k);
    this.kit.fill(list);
    // the nearest emitters win the slots (fires first: a beacon / chimney never pushes out a burning wreck)
    const rank = (k: number) => (k === 0 ? 0 : k === 3 ? 1 : 2);
    em.sort((a, b) => rank(a.kind) - rank(b.kind) || a.dist - b.dist);
    this.emitters = em.slice(0, MAX_E);
    const E = this.fu.uE.value as THREE.Vector4[], E2 = this.fu.uE2.value as THREE.Vector4[];
    this.emitters.forEach((e, i) => { E[i].set(e.x, e.y, e.z, e.size); E2[i].set(e.kind, e.strength, e.seed, e.smoke); });
    this.stats = { ...st, emitters: this.emitters.length, instances: list.length, draws: this.kit.draws + 2, rebuilds: this.stats.rebuilds + 1 };
  }

  // ------------------------------------------------------------------ wrecks
  private buildWreck(w: DesertWorld, it: WreckItem): Built {
    const P = this.flattest(w, it.s, it.lat, 30 * it.scale, [0, -60, 60], [0, -40]);
    // (tint < 0: charred, burnt-out metal; kit.ts albedo x (0.86 + 0.28 tint))
    const B = new Builder(P.x, P.z, -P.heading + it.yaw, this.gr, it.burning ? -1.6 + 0.4 * rnd(it.id, 1) : -0.6 + 0.6 * rnd(it.id, 1));
    const r = (k: number) => rnd(it.id, k);
    const sc = it.scale;
    const emit: Built['emit'] = [];
    const fire = (lx: number, dy: number, lz: number, size: number, smokeH: number) => {
      if (!it.burning) return;
      const [wx, wz] = B.at(lx, lz);
      emit.push({ wx, wz, y: this.gr(wx, wz) + dy, size: size * it.heat, kind: 0, strength: 0.85 + 0.15 * r(60 + emit.length), seed: r(70 + emit.length), smoke: smokeH * (0.8 + 0.4 * it.heat) });
    };
    let R = 30 * sc;
    switch (it.kind) {
      case 'walker': {
        const S = 28 * sc;
        const roll = (0.35 + 0.35 * r(2)) * (r(3) < 0.5 ? -1 : 1), pitch = (r(4) - 0.5) * 0.35;
        B.add('walkerbody', 0, -S * 0.2, 0, S * 0.9, S * 0.7, S * 1.5, r(5) < 0.5 ? MAT.iron : MAT.paint, { roll, pitch });
        for (let k = 0; k < 6; k++) {
          const side = k % 2 ? 1 : -1, row = Math.floor(k / 2), lz = (row - 1) * S * 0.6;
          if (r(10 + k) < 0.2) continue;                                    // a leg torn off
          const up = r(20 + k) < 0.3;
          B.add('leg', side * S * 0.4, up ? S * 0.12 : -S * 0.12, lz, S * (0.9 + 0.3 * r(30 + k)), S * (0.9 + 0.3 * r(30 + k)), S * 0.9, MAT.iron,
            { yaw: (side > 0 ? 0 : Math.PI) + (r(40 + k) - 0.5) * 0.7, roll: up ? side * 1.1 : (r(50 + k) - 0.5) * 0.5 });
        }
        for (let k = 0; k < 7; k++) B.add('box', (r(80 + k) - 0.5) * S * 3, -0.6, (r(90 + k) - 0.5) * S * 3, (2 + 4 * r(100 + k)) * sc, (1 + 2 * r(110 + k)) * sc, (2 + 5 * r(120 + k)) * sc, MAT.iron, { yaw: r(130 + k) * 6, roll: (r(140 + k) - 0.5) * 0.8 });
        fire(0, S * 0.45, -S * 0.2, 5.5 * sc, 240 * sc);
        if (r(6) < 0.6) fire(S * 0.3, S * 0.2, S * 0.5, 3.2 * sc, 0);
        R = S * 1.5;
        break;
      }
      case 'hull': {
        const len = (60 + 30 * r(2)) * sc, wid = len * 0.2, hh = wid * 0.8;
        const roll = (0.3 + 0.3 * r(3)) * (r(4) < 0.5 ? -1 : 1);
        B.add('hull', 0, -hh * 0.4, -len * 0.27, wid, hh, len * 0.52, r(5) < 0.5 ? MAT.rust : MAT.paint, { roll, pitch: 0.06 + 0.1 * r(6) });
        B.add('hull', wid * 0.35, -hh * 0.5, len * 0.33, wid * 0.95, hh, len * 0.42, MAT.rust, { roll: -roll * 0.6, yaw: 0.25 + 0.25 * r(7), pitch: -0.12 });
        for (let k = 0; k < 6; k++) B.add('rib', wid * 0.1, -1.5, len * 0.02 + k * 2.6, wid * (1 - k * 0.06), hh * (1.05 - k * 0.1), 4, MAT.iron, { roll: (r(20 + k) - 0.5) * 0.4 });
        B.add('girder', -wid * 0.3, 0, -len * 0.3, 1.2, 28 * sc, 1.2, MAT.iron, { roll: 0.5 + 0.3 * r(8), pitch: 0.2 });
        B.add('box', wid * 0.1, hh * 0.35, -len * 0.4, wid * 0.55, hh * 0.6, len * 0.12, MAT.plaster, { roll: roll * 0.9, emit: 0.2 });
        fire(0, hh * 0.3, len * 0.02, 6.5 * sc, 260 * sc);
        if (r(9) < 0.5) fire(wid * 0.2, hh * 0.5, -len * 0.35, 3.5 * sc, 0);
        R = len * 0.62;
        break;
      }
      case 'tower': {
        const H = (70 + 30 * r(2)) * sc;
        // the toppled lattice tower lies across the sand, its stump still standing; a crushed tank burns under it
        B.add('lattice', 0, 1.2, 0, 11 * sc, H, 11 * sc, MAT.iron, { roll: -1.45 - 0.08 * r(3), yaw: r(4) * 0.4 });
        B.add('lattice', -2, -0.5, 0, 12 * sc, H * 0.16, 12 * sc, MAT.iron);
        B.add('tank', H * 0.45, -1, 10 * sc, 18 * sc, 7 * sc, 18 * sc, MAT.paint, { roll: 0.25, pitch: 0.15 });
        B.add('tank', H * 0.65, -0.5, -16 * sc, 14 * sc, 12 * sc, 14 * sc, MAT.plaster);
        for (let k = 0; k < 5; k++) B.add('girder', H * (0.2 + 0.15 * k), 0, (r(20 + k) - 0.5) * 30, 1, (8 + 10 * r(30 + k)) * sc, 1, MAT.iron, { roll: 1.3 + 0.3 * r(40 + k), yaw: r(50 + k) * 6 });
        fire(H * 0.45, 4 * sc, 10 * sc, 6 * sc, 250 * sc);
        R = H * 0.8;
        break;
      }
      default: {          // convoy: overturned trucks and a tanker
        const n = 3 + Math.floor(r(2) * 2);
        for (let k = 0; k < n; k++) {
          const lz = (k - (n - 1) / 2) * 16 * sc + (r(10 + k) - 0.5) * 6, lx = (r(20 + k) - 0.5) * 14;
          const yaw = (r(30 + k) - 0.5) * 1.4, roll = r(40 + k) < 0.6 ? (r(41 + k) < 0.5 ? 1 : -1) * (1.2 + 0.4 * r(42 + k)) : (r(43 + k) - 0.5) * 0.3;
          if (k === 1) B.add('cyl', lx, 2.4 * sc, lz, 4.6 * sc, 13 * sc, 4.6 * sc, MAT.paint, { pitch: Math.PI / 2, yaw, roll: roll * 0.2 });
          else {
            B.add('box', lx, 0, lz, 4.2 * sc, 4.4 * sc, 10 * sc, MAT.rust, { yaw, roll });
            B.add('box', lx, 0, lz - 7 * sc, 4 * sc, 3.6 * sc, 3.5 * sc, MAT.paint, { yaw, roll, emit: 0.1 });
          }
        }
        fire(0, 2 * sc, 0, 5 * sc, 220 * sc);
        fire(6 * sc, 1.5 * sc, 14 * sc, 3 * sc, 0);
        R = 40 * sc;
        break;
      }
    }
    return { parts: B.parts, x: P.x, z: P.z, r: R, emit };
  }

  // ------------------------------------------------------------------ towns
  private buildTown(w: DesertWorld, it: TownItem): Built {
    const P = this.flattest(w, it.s, it.lat, 110 * it.scale, [0, -280, 280, -560, 560], [0, -300, 300]);
    const B = new Builder(P.x, P.z, -P.heading + it.yaw, this.gr, rnd(it.id, 1));
    const r = (k: number) => rnd(it.id, k);
    const sc = it.scale;
    const emit: Built['emit'] = [];
    // one floor for the whole town (the lowest ground under it); foundations reach well below it (no floating corners)
    let g0 = Infinity;
    for (const [lx, lz] of [[0, 0], [90, 0], [-90, 0], [0, 90], [0, -90], [60, 60], [-60, -60]]) g0 = Math.min(g0, B.g(lx * sc, lz * sc));
    g0 -= 2;
    const FOUND = 26;
    const block = (lx: number, lz: number, L: number, H: number, D: number, mat: number, o: { yaw?: number; emit?: number; roof?: boolean; broken?: boolean } = {}) => {
      B.add('box', lx, -FOUND, lz, L, H + FOUND, D, mat, { base: g0, yaw: o.yaw ?? 0, emit: o.emit ?? it.lights * 0.7 });
      if (o.roof !== false && !o.broken) B.add('prism', lx, H, lz, L, Math.min(L, D) * 0.25, D, MAT.iron, { base: g0, yaw: o.yaw ?? 0 });
      if (o.broken) {
        // a burnt-out roof: bare trusses and a slumped corner
        for (let k = 0; k < 4; k++) B.add('girder', lx + (k - 1.5) * L * 0.24, H - 1, lz, 0.9, D * 0.95, 0.9, MAT.iron, { base: g0, pitch: Math.PI / 2, yaw: o.yaw ?? 0 });
        B.add('box', lx + L * 0.3, H * 0.75, lz + D * 0.25, L * 0.4, H * 0.4, D * 0.45, mat, { base: g0, yaw: o.yaw ?? 0, roll: 0.35 });
      }
    };
    const stack = (lx: number, lz: number, H: number, R: number, smoke: boolean) => {
      B.add('chimney', lx, -FOUND, lz, R, H + FOUND, R, MAT.adobe, { base: g0 });
      const [wx, wz] = B.at(lx, lz);
      if (smoke) emit.push({ wx, wz, y: g0 + H, size: R * 0.35, kind: 2, strength: 0.55 + 0.25 * r(300 + emit.length), seed: r(310 + emit.length), smoke: 90 + 70 * r(320 + emit.length) });
      emit.push({ wx, wz, y: g0 + H + 2, size: 3.2, kind: 1, strength: 1, seed: r(330 + emit.length), smoke: 0 });
    };
    const crane = (lx: number, lz: number, H: number, yaw: number) => {
      B.add('lattice', lx, -FOUND * 0.3, lz, 9, H + FOUND * 0.3, 9, MAT.iron, { base: g0 });
      B.add('truss', lx + H * 0.3 * Math.cos(yaw), H, lz - H * 0.3 * Math.sin(yaw), H * 0.9, 5, 4, MAT.iron, { base: g0, yaw });
      const [wx, wz] = B.at(lx, lz);
      emit.push({ wx, wz, y: g0 + H + 6, size: 2.8, kind: 1, strength: 1, seed: r(340 + emit.length), smoke: 0 });
    };
    switch (it.kind) {
      case 'works': {
        const nh = 3 + Math.floor(r(2) * 3);
        for (let k = 0; k < nh; k++) {
          const L = (40 + 40 * r(10 + k)) * sc, H = (18 + 22 * r(20 + k)) * sc, D = (26 + 22 * r(30 + k)) * sc;
          block((k - (nh - 1) / 2) * 62 * sc + (r(40 + k) - 0.5) * 20, (r(50 + k) - 0.5) * 80 * sc, L, H, D, k % 2 ? MAT.adobe : MAT.plaster, { broken: r(60 + k) < 0.45, yaw: (r(70 + k) - 0.5) * 0.3 });
        }
        const ns = 2 + Math.floor(r(3) * 3);
        for (let k = 0; k < ns; k++) stack((k - (ns - 1) / 2) * 34 * sc, 60 * sc, (70 + 45 * r(80 + k)) * sc, 9 * sc, r(90 + k) < 0.75);
        for (let k = 0; k < 4; k++) B.add('tank', -120 * sc + (k % 2) * 30 * sc, 0, -40 * sc + Math.floor(k / 2) * 30 * sc, 22 * sc, 16 * sc, 22 * sc, k % 2 ? MAT.paint : MAT.plaster, { base: g0 });
        crane(110 * sc, -30 * sc, (55 + 20 * r(4)) * sc, r(5) * 6.28);
        // the leaning tower (a landmark silhouette)
        B.add('box', 60 * sc, -FOUND, -70 * sc, 16 * sc, (85 + 30 * r(6)) * sc + FOUND, 16 * sc, MAT.plaster, { base: g0, roll: 0.12 + 0.1 * r(7), emit: it.lights * 0.6 });
        break;
      }
      case 'fort': {
        const R = (95 + 30 * r(2)) * sc, n = 10;
        for (let k = 0; k < n; k++) {
          if (r(10 + k) < 0.25) continue;                               // a breach
          const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2, am = (a0 + a1) / 2, len = 2 * R * Math.sin(Math.PI / n);
          B.add('box', Math.cos(am) * R, -FOUND, Math.sin(am) * R, len * 0.98, (16 + 6 * r(20 + k)) * sc + FOUND, 7 * sc, MAT.stone, { base: g0, yaw: -am + Math.PI / 2 });
        }
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2 + r(3);
          B.add('cyl', Math.cos(a) * R, -FOUND, Math.sin(a) * R, 16 * sc, (32 + 14 * r(30 + k)) * sc + FOUND, 16 * sc, MAT.stone, { base: g0, emit: it.lights * 0.4 });
          if (r(40 + k) < 0.6) { const [wx, wz] = B.at(Math.cos(a) * R, Math.sin(a) * R); emit.push({ wx, wz, y: g0 + (32 + 14 * r(30 + k)) * sc + 2, size: 2.6, kind: 1, strength: 0.9, seed: r(50 + k), smoke: 0 }); }
        }
        block(0, 0, 44 * sc, (48 + 22 * r(4)) * sc, 40 * sc, MAT.stone, { roof: false, emit: it.lights });
        B.add('dome', 0, (48 + 22 * r(4)) * sc, 0, 30 * sc, 18 * sc, 30 * sc, MAT.plaster, { base: g0 });
        block(-46 * sc, 30 * sc, 30 * sc, 24 * sc, 26 * sc, MAT.adobe, { broken: true });
        block(40 * sc, -34 * sc, 28 * sc, 20 * sc, 30 * sc, MAT.adobe);
        stack(52 * sc, 44 * sc, 64 * sc, 7 * sc, r(5) < 0.6);
        break;
      }
      default: {          // stacks: a power station - a long turbine hall, a row of tall chimneys, cooling tanks, pylons
        const ns = 4 + Math.floor(r(2) * 4);
        block(0, -40 * sc, ns * 30 * sc, 34 * sc, 40 * sc, MAT.plaster, { broken: r(3) < 0.5 });
        for (let k = 0; k < ns; k++) stack((k - (ns - 1) / 2) * 30 * sc, 12 * sc, (95 + 45 * r(10 + k)) * sc, 11 * sc, r(20 + k) < 0.8);
        for (let k = 0; k < 3; k++) B.add('tank', (k - 1) * 46 * sc, 0, 80 * sc, 36 * sc, 26 * sc, 36 * sc, MAT.plaster, { base: g0 });
        for (let k = 0; k < 2; k++) B.add('lattice', (k ? 1 : -1) * (ns * 15 + 40) * sc, -2, 0, 14 * sc, 60 * sc, 14 * sc, MAT.iron, { base: g0 });
        crane(-(ns * 15 + 70) * sc, 60 * sc, 60 * sc, r(4) * 6.28);
        break;
      }
    }
    // the town's night glow (over its middle; strength by how many of its lights burn)
    emit.push({ wx: P.x, wz: P.z, y: g0 + 30 * sc, size: 300 * sc, kind: 3, strength: 0.55 * it.lights, seed: r(400), smoke: 0 });
    return { parts: B.parts, x: P.x, z: P.z, r: 160 * sc, emit };
  }

  dispose() { this.kit.dispose(); for (const m of [this.fire, this.smoke]) { m.geometry.dispose(); m.material.dispose(); } }
}
