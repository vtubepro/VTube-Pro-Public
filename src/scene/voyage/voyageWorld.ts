// Voyage world (placeholder provider): everything that streams past the ship, as children of the world group whose matrix
// is the inverse of the ship's body pose (voyageScene.ts). Local frame: x = d (starboard), y = h (up), z = -(s - S).
//   * terrain   4 snapped clipmap bands (1 / 4 / 16 / 64 m), heights from the GLSL twin of voyageGround (no CPU chunks,
//               no swimming: each band's grid is snapped to its spacing in absolute s), coarse bands discard what a
//               finer band covers, skirts close T-junction cracks. 4 draws, ~55k vertices, no per-frame uploads.
//   * scatter   rocks / scrub / bones / wrecks: 4 InstancedMeshes in 64 m cells cached by cell index (heights computed
//               once per cell), re-laid out every 64 m (the group slides in between).
//   * cities    one per city beat, seeded kit (adobe blocks, domes, towers, walls, awnings), 2 instanced draws + lit
//               windows (night factor), on a flattened plateau; visible from 2.5 km out.
//   * backdrop  a distant mesa ring (closed-form silhouette), rotates with the route heading.
//   * dust      camera-boxed sand streaks for sandstorms (1 draw), none inside ENV_DRY boxes (under the awning).
// The desert lane's terrain replaces this through VoyageWorldProvider (setWorldProvider) - feet / props / cameras only
// call ground.heightAt(s, d).
import * as THREE from 'three';
import { GROUND_BIO_N, GROUND_GLSL, VoyageGround, newGroundUniformValues, type GroundChapter, type GroundUniformValues } from './voyageGround.ts';
import { voyageHash, voyageRand, type CityKind } from '../../../shared/voyage.ts';

const tv = new THREE.Vector3(), tm = new THREE.Matrix4(), tq = new THREE.Quaternion(), ts = new THREE.Vector3();

/** What a world provider gets every frame. */
export interface WorldFrame {
  S: number;
  /** sun direction / colour (ship frame), ambient colour, fog colour */
  sunDir: THREE.Vector3; sunCol: THREE.Color; amb: THREE.Color; fogCol: THREE.Color;
  /** 0..1 */ night: number; storm: number;
  /** route heading (rad) - the backdrop + sky turn with it */ heading: number;
  /** camera position in world-group local coordinates */ cam: THREE.Vector3;
  /** ship speed (m/s) and wind (local x, z m/s) for streaks */ v: number; wind: THREE.Vector2;
  /** dry boxes in world-group local coords are not needed: streaks are tested in the SHIP frame */
  t: number;
  level: number;
  /** extras a full desert needs (the desert lane's DesertWorld.update): haboob approach 0..1 (null = none), the journey
   *  hour, wall ms, the live camera + renderer, terrain tilt 0..1 (the deck budget; 1 = exterior), sand y under the ship */
  stormFront?: number | null; hour?: number; now?: number; camera?: THREE.Camera; renderer?: THREE.WebGLRenderer; tilt?: number; groundY?: number;
}
/** The ground the voyage asks for heights (route coords: s along, d starboard). VoyageGround implements it; a desert
 *  adapter maps (s, d) onto its curved route. */
export interface VoyageGroundLike {
  heightAt(s: number, d: number): number;
  raw(s: number, d: number): number;
  flats: { s: number; d: number; r: number; h: number }[];
  legDist: number;
  /** the chapter that holds distance s (set by the voyage every frame: shared/voyage.ts voyageGroundBinding); biomes blend
   *  BIOME_IN..BIOME_OUT m past each chapter start (one-sided), biomeOf(ch) has an open fork vote cross-faded in */
  chapterAt?: ((s: number) => GroundChapter) | null;
  biomeOf: (leg: number) => { dune: number; hill: number };
  /** the chapter's layout flavour (shared/voyage.ts voyageGroundBinding): the desert's world rules map it onto biomes */
  flavourAt?: ((ch: number) => string) | null;
}
/** A replaceable world (the desert lane plugs in here: setWorldProvider in voyageScene.ts).
 *  poseMode 'engine' (default): the voyage computes the terrain follow (ride height + plane-fit tilt) from heightAt and
 *  puts it in the world group's matrix; the provider's content sits in route-local coords (x = d, y = h, z = -(s - S)).
 *  poseMode 'provider': the provider places its world under the ship itself (DesertWorld: ride height, tilt, heading,
 *  floating origin) with the sand at room y = groundY; the voyage's body pose then carries only the gait heave / sway,
 *  kicks and the kneel, and toLocal / fromLocal map route coords through the provider's own transform. */
export interface VoyageWorldProvider {
  readonly group: THREE.Group;
  readonly ground: VoyageGroundLike;
  readonly poseMode?: 'engine' | 'provider';
  toLocal?(s: number, d: number, h: number, S: number, out: THREE.Vector3): THREE.Vector3;
  fromLocal?(p: THREE.Vector3, S: number): { s: number; d: number; h: number };
  setDryBoxes?(boxes: THREE.Box3[]): void;
  /** The ship's distance this frame, before any ground / toLocal query (a provider whose route frame depends on it). */
  prepare?(S: number): void;
  update(f: WorldFrame): void;
  setCities(c: CitySpec[]): void;
  counts(): Record<string, number>;
  dispose(): void;
}
/** A city by the route. `rise` 0..1 (default 1): a city being replaced (a fork vote's new content) sinks into the haze
 *  while its replacement rises (no one-frame swap). */
export interface CitySpec { id: string; s: number; d: number; kind: CityKind; seed: number; r: number; rise?: number }

// ------------------------------------------------------------------------------------------------ terrain
const TERRAIN_VS = /* glsl */ `
${GROUND_GLSL}
uniform float uOffZ; uniform float uSpacing; uniform float uSkirt;
attribute float skirt;
varying vec3 vL; varying vec3 vN; varying float vDist; varying float vH;
void main() {
  vec2 L = vec2(position.x, position.z + uOffZ);
  float h = vgHeight(L);
  float e = max(0.5, uSpacing * 0.5);
  float hx = vgHeight(L + vec2(e, 0.0)) - vgHeight(L - vec2(e, 0.0));
  float hz = vgHeight(L + vec2(0.0, e)) - vgHeight(L - vec2(0.0, e));
  vN = normalize(vec3(-hx, 2.0 * e, -hz));
  vec3 p = vec3(L.x, h - skirt * uSkirt, L.y);
  vL = p; vH = h;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vDist = distance(w.xyz, cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const TERRAIN_FS = /* glsl */ `
uniform vec4 uInner;           // finer band coverage (x0, z0, x1, z1) in local coords; x0 > x1 = none
uniform vec3 uSunDir; uniform vec3 uSunCol; uniform vec3 uAmb; uniform vec3 uFogCol;
uniform vec2 uFog; uniform float uStorm; uniform float uNight; uniform vec3 uSand; uniform vec3 uTrough; uniform vec3 uCrest;
uniform vec3 uCamL; uniform float uSpacing; uniform vec4 uShadow;  // ship shadow ellipse (x, z, rx, rz) local
uniform vec4 uRip;             // ground-anchored detail: ripple phase offsets (cycles, rad, rad) from S on the CPU, S mod 1024
varying vec3 vL; varying vec3 vN; varying float vDist; varying float vH;
float hsh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
// value noise on cells that repeat every n along z (n cells = 1024 m), so the S mod 1024 wrap is seamless
float vnz(vec2 p, float n) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float y0 = mod(i.y, n), y1 = mod(i.y + 1.0, n);
  return mix(mix(hsh(vec2(i.x, y0)), hsh(vec2(i.x + 1.0, y0)), f.x), mix(hsh(vec2(i.x, y1)), hsh(vec2(i.x + 1.0, y1)), f.x), f.y); }
void main() {
  if (uInner.x < uInner.z && vL.x > uInner.x && vL.x < uInner.z && vL.z > uInner.y && vL.z < uInner.w) discard;
  vec3 N = normalize(vN);
  // ripples: a saw-tooth along the (fixed) wind, faded with distance + on steep lee faces
  float rk = (1.0 - smoothstep(12.0, 60.0, vDist)) * (1.0 - smoothstep(0.45, 0.75, 1.0 - N.y));
  // ground-anchored (they stream past with the sand, not with the ship): w = z - S, phases offset on the CPU in doubles
  vec2 G = vec2(vL.x, vL.z - uRip.w);
  float ph = dot(vL.xz, vec2(0.52, 0.85)) / 0.62 - uRip.x + 0.6 * sin(vL.x * 0.37 + vL.z * 0.23 - uRip.y) + 0.35 * sin(vL.x * 1.3 - vL.z * 0.9 + uRip.z);
  float dr = sin(6.2831 * ph) * 0.045 * rk * (0.6 + 0.4 * vnz(G * 0.25, 256.0));
  N = normalize(N + vec3(0.52, 0.0, 0.85) * dr);
  float slope = 1.0 - N.y;
  vec3 V = normalize(uCamL - vL);
  // colour: trough -> sand -> crest by height, redder on steep lee faces, darker in hollows
  vec3 col = uSand;
  col = mix(col, uTrough, clamp((1.0 - smoothstep(-16.0, -5.0, vH)) * 0.45 + smoothstep(0.22, 0.6, slope) * 0.4, 0.0, 0.75));
  col = mix(col, uCrest, smoothstep(4.0, 14.0, vH) * 0.55);
  col *= 0.9 + 0.1 * vnz(G * 0.125, 128.0);
  // banded toon sun + forward-scatter sheen at low sun
  float ndl = dot(N, uSunDir);
  float band = smoothstep(-0.03, 0.1, ndl) * 0.7 + smoothstep(0.35, 0.6, ndl) * 0.3;
  // the ship's shadow (an ellipse under the hull, softened)
  vec2 q = (vL.xz - uShadow.xy) / uShadow.zw;
  float shadow = 1.0 - 0.55 * (1.0 - smoothstep(0.75, 1.15, length(q)));
  float sheen = pow(1.0 - max(dot(N, V), 0.0), 4.0) * max(dot(V, -uSunDir), 0.0) * 0.35;
  vec3 lit = col * (uAmb + uSunCol * band * shadow) + uSunCol * sheen * col;
  // aerial perspective / sandstorm fog (world materials only - the performers are never fogged)
  float near = mix(uFog.x, 6.0, uStorm), far = mix(uFog.y, 160.0, uStorm);
  float f = smoothstep(near, far, vDist);
  f = max(f, 1.0 - exp(-vDist * mix(0.00012, 0.016, uStorm)));
  gl_FragColor = vec4(mix(lit, uFogCol, clamp(f, 0.0, 1.0)), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

interface Band { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; h: number; x: number; z0: number; z1: number }
const BANDS = [
  { h: 1, x: 48, z0: -112, z1: 48 },
  { h: 4, x: 192, z0: -448, z1: 192 },
  { h: 16, x: 768, z0: -1792, z1: 768 },
  { h: 64, x: 2560, z0: -3584, z1: 1536 },
];

/** Grid with a rectangular hole (grid units) + vertical skirts on the outer edge (attribute skirt = 1). */
function bandGeometry(b: { h: number; x: number; z0: number; z1: number }, hole: { x: number; z0: number; z1: number } | null): THREE.BufferGeometry {
  const nx = Math.round((2 * b.x) / b.h), nz = Math.round((b.z1 - b.z0) / b.h);
  const pos: number[] = [], sk: number[] = [], idx: number[] = [];
  const vid = (i: number, j: number) => j * (nx + 1) + i;
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) { pos.push(-b.x + i * b.h, 0, b.z0 + j * b.h); sk.push(0); }
  const inHole = (x: number, z: number) => !!hole && x > -hole.x && x < hole.x && z > hole.z0 && z < hole.z1;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const x0 = -b.x + i * b.h, z0 = b.z0 + j * b.h;
    if (inHole(x0, z0) && inHole(x0 + b.h, z0 + b.h) && inHole(x0, z0 + b.h) && inHole(x0 + b.h, z0)) continue;
    const a = vid(i, j), c = vid(i + 1, j), d = vid(i, j + 1), e = vid(i + 1, j + 1);
    idx.push(a, d, c, c, d, e);
  }
  // skirts round the outer edge (closes cracks against the next band / the horizon)
  const edge: number[] = [];
  for (let i = 0; i <= nx; i++) edge.push(vid(i, 0));
  for (let j = 1; j <= nz; j++) edge.push(vid(nx, j));
  for (let i = nx - 1; i >= 0; i--) edge.push(vid(i, nz));
  for (let j = nz - 1; j >= 0; j--) edge.push(vid(0, j));
  const base = pos.length / 3;
  for (const v of edge) { pos.push(pos[v * 3], 0, pos[v * 3 + 2]); sk.push(1); }
  for (let k = 0; k < edge.length; k++) {
    const a = edge[k], b2 = edge[(k + 1) % edge.length], c = base + k, d = base + ((k + 1) % edge.length);
    idx.push(a, c, b2, b2, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('skirt', new THREE.Float32BufferAttribute(sk, 1));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, (b.z0 + b.z1) / 2), Math.hypot(b.x, (b.z1 - b.z0) / 2) + 200);
  return g;
}

// ------------------------------------------------------------------------------------------------ the provider
export class PlaceholderWorld implements VoyageWorldProvider {
  readonly group = new THREE.Group();
  readonly ground = new VoyageGround();
  private bands: Band[] = [];
  private gu: GroundUniformValues = newGroundUniformValues();
  private shared: Record<string, THREE.IUniform>;
  private scatter: Scatter;
  private cities: Cities;
  private backdrop: THREE.Mesh;
  readonly dust: Dust;
  sand = new THREE.Color('#d9a25f'); trough = new THREE.Color('#9a5a3a'); crest = new THREE.Color('#f2c98a');
  fogNear = 300; fogFar = 2600;
  /** ship shadow ellipse under the hull (local x, z, rx, rz) */
  shadow = new THREE.Vector4(0, 2, 7, 21);

  constructor(opts: { sand?: string; trough?: string; crest?: string; fogNear?: number; fogFar?: number; scatter?: number } = {}) {
    this.group.name = 'vtp:voyage:world';
    if (opts.sand) this.sand.set(opts.sand);
    if (opts.trough) this.trough.set(opts.trough);
    if (opts.crest) this.crest.set(opts.crest);
    if (opts.fogNear) this.fogNear = opts.fogNear;
    if (opts.fogFar) this.fogFar = opts.fogFar;
    this.shared = {
      uVgOffN: { value: new THREE.Vector4() }, uVgOffV: { value: 0 }, uVgPh: { value: new THREE.Vector2() }, uVgBio: { value: [-1e6, 1e6, 1, 1, 1, 1, 1, 1] },
      uVgFlatN: { value: 0 }, uVgFlat: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
      uSunDir: { value: new THREE.Vector3(0.4, 0.6, -0.5).normalize() }, uSunCol: { value: new THREE.Vector3(1, 0.92, 0.8) }, uAmb: { value: new THREE.Vector3(0.45, 0.42, 0.42) },
      uFogCol: { value: new THREE.Vector3(0.85, 0.75, 0.62) }, uFog: { value: new THREE.Vector2(this.fogNear, this.fogFar) }, uStorm: { value: 0 }, uNight: { value: 0 },
      uSand: { value: new THREE.Vector3(this.sand.r, this.sand.g, this.sand.b) }, uTrough: { value: new THREE.Vector3(this.trough.r, this.trough.g, this.trough.b) }, uCrest: { value: new THREE.Vector3(this.crest.r, this.crest.g, this.crest.b) },
      uCamL: { value: new THREE.Vector3() }, uShadow: { value: this.shadow }, uRip: { value: new THREE.Vector4() },
    };
    let inner: { x: number; z0: number; z1: number } | null = null;
    for (const b of BANDS) {
      const hole = inner ? { x: inner.x - b.h, z0: inner.z0 + b.h, z1: inner.z1 - b.h } : null;
      const geo = bandGeometry(b, hole);
      const mat = new THREE.ShaderMaterial({
        vertexShader: TERRAIN_VS, fragmentShader: TERRAIN_FS, fog: false,
        uniforms: { ...this.shared, uOffZ: { value: 0 }, uSpacing: { value: b.h }, uSkirt: { value: b.h * 1.5 }, uInner: { value: new THREE.Vector4(1, 0, -1, 0) } },
      });
      mat.name = 'vtp:voyage:terrain';
      // coarser bands overlap the finer band's rim (no cracks) and lose the depth test there (no z-fight)
      if (inner) { mat.polygonOffset = true; mat.polygonOffsetFactor = 1; mat.polygonOffsetUnits = 4 * this.bands.length; }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `vtp:voyage:terrain${b.h}`;
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;                        // after the ship / deck (early-z under the hull)
      this.group.add(mesh);
      this.bands.push({ mesh, mat, ...b });
      inner = b;
    }
    this.scatter = new Scatter(this.ground, opts.scatter ?? 1);
    this.cities = new Cities(this.ground);
    this.backdrop = makeBackdrop();
    this.dust = new Dust();
    this.group.add(this.scatter.group, this.cities.group, this.backdrop);
  }

  /** the dust streaks live in the SHIP frame (camera box): add this to the ship group */
  get dustMesh() { return this.dust.mesh; }

  setCities(c: CitySpec[]) { this.cities.set(c); }

  update(f: WorldFrame) {
    const S = f.S;
    this.ground.uniforms(S, this.gu);
    const u = this.shared;
    (u.uVgOffN.value as THREE.Vector4).set(this.gu.offN[0], this.gu.offN[1], this.gu.offN[2], this.gu.offN[3]);
    u.uVgOffV.value = this.gu.offV;
    (u.uVgPh.value as THREE.Vector2).set(this.gu.ph1, this.gu.ph2);
    const bio = u.uVgBio.value as number[]; for (let i = 0; i < GROUND_BIO_N; i++) bio[i] = this.gu.bio[i];
    u.uVgFlatN.value = this.gu.flatN;
    { const fr = (x: number) => x - Math.floor(x), TAU = Math.PI * 2;
      (u.uRip.value as THREE.Vector4).set(fr((0.85 * S) / 0.62), TAU * fr((0.23 * S) / TAU), TAU * fr((0.9 * S) / TAU), S - 1024 * Math.floor(S / 1024)); }
    const fl = u.uVgFlat.value as THREE.Vector4[];
    for (let i = 0; i < 4; i++) fl[i].set(this.gu.flats[i * 4], this.gu.flats[i * 4 + 1], this.gu.flats[i * 4 + 2], this.gu.flats[i * 4 + 3]);
    (u.uSunDir.value as THREE.Vector3).copy(f.sunDir);
    (u.uSunCol.value as THREE.Vector3).set(f.sunCol.r, f.sunCol.g, f.sunCol.b);
    (u.uAmb.value as THREE.Vector3).set(f.amb.r, f.amb.g, f.amb.b);
    const light = Math.min(1, Math.max(0.03, 1.5 * (0.3 * f.amb.r + 0.59 * f.amb.g + 0.11 * f.amb.b) + 0.6 * (0.3 * f.sunCol.r + 0.59 * f.sunCol.g + 0.11 * f.sunCol.b)));
    const fc = ts.set(f.fogCol.r, f.fogCol.g, f.fogCol.b).lerp(tv.set(0.62, 0.45, 0.28).multiplyScalar(light), f.storm * 0.85);
    this.dust.light = light;
    (u.uFogCol.value as THREE.Vector3).copy(fc);
    (u.uFog.value as THREE.Vector2).set(this.fogNear, this.fogFar);
    u.uStorm.value = f.storm; u.uNight.value = f.night;
    (u.uCamL.value as THREE.Vector3).copy(f.cam);
    for (let i = 0; i < this.bands.length; i++) {
      const b = this.bands[i];
      const off = S - b.h * Math.floor(S / b.h);           // vertices sit on absolute multiples of the spacing
      b.mat.uniforms.uOffZ.value = off;
      const inner = this.bands[i - 1];
      if (inner) {
        const io = S - inner.h * Math.floor(S / inner.h);
        const m = 1.5 * inner.h;                                    // overlap ring (< the coarse hole's slack)
        (b.mat.uniforms.uInner.value as THREE.Vector4).set(-inner.x + m, inner.z0 + io + m, inner.x - m, inner.z1 + io - m);
      }
    }
    this.scatter.update(S, f.level);
    this.cities.update(S, f.night);
    // backdrop: centred on the ship, turned by the heading, faded into the haze
    this.backdrop.position.set(0, -12, 0);
    this.backdrop.rotation.y = -f.heading;
    const bm = this.backdrop.material as THREE.ShaderMaterial;
    (bm.uniforms.uFogCol.value as THREE.Vector3).copy(fc);
    (bm.uniforms.uSunCol.value as THREE.Vector3).set(f.sunCol.r, f.sunCol.g, f.sunCol.b);
    bm.uniforms.uStorm.value = f.storm;
    bm.uniforms.uNight.value = f.night;
    this.dust.update(f);
  }

  counts() {
    return { draws: this.bands.length + this.scatter.draws() + this.cities.draws() + 1 + (this.dust.mesh.visible ? 1 : 0), scatter: this.scatter.count(), cities: this.cities.count(), dust: this.dust.mesh.visible ? this.dust.n : 0 };
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
    this.dust.mesh.removeFromParent(); this.dust.mesh.geometry.dispose(); (this.dust.mesh.material as THREE.Material).dispose();
  }
}

// ------------------------------------------------------------------------------------------------ scatter
const CELL = 64;
interface Item { s: number; d: number; h: number; rot: number; sc: number; k: number }
class Scatter {
  readonly group = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private cache = new Map<number, Item[]>();
  private ref = NaN;
  private lastLevel = -1;
  private n = [0, 0, 0, 0];
  constructor(private ground: VoyageGround, private density: number) {
    this.group.name = 'vtp:voyage:scatter';
    const mat = (c: string, r = 0.9, m = 0.05) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m, flatShading: true });
    const rock = new THREE.DodecahedronGeometry(1, 0); rock.scale(1.4, 0.8, 1.1);
    const scrub = new THREE.ConeGeometry(0.8, 1.1, 6, 1); scrub.translate(0, 0.5, 0);
    const bone = new THREE.TorusGeometry(1.6, 0.14, 5, 10, Math.PI); bone.rotateY(Math.PI / 2); bone.translate(0, -0.35, 0);
    const wreck = new THREE.BoxGeometry(6, 3.2, 14); wreck.rotateZ(0.35); wreck.translate(0, 0.6, 0);
    const defs: [THREE.BufferGeometry, THREE.Material, number][] = [[rock, mat('#7b5a43'), 1200], [scrub, mat('#6f6b3a'), 700], [bone, mat('#b8ab90', 0.85), 60], [wreck, mat('#5d3a26', 0.8, 0.4), 40]];
    for (const [g, m, max] of defs) {
      const im = new THREE.InstancedMesh(g, m, max);
      im.count = 0; im.frustumCulled = false; im.renderOrder = 2; im.name = 'vtp:voyage:scatter';
      this.meshes.push(im); this.group.add(im);
    }
  }
  private cell(c: number): Item[] {
    let it = this.cache.get(c);
    if (it) return it;
    it = [];
    const h = voyageHash(91, c);
    const n = Math.floor((6 + 6 * voyageRand(h, 1)) * this.density);
    for (let i = 0; i < n; i++) {
      const r = voyageRand(h, 10, i);
      const k = r < 0.62 ? 0 : r < 0.95 ? 1 : r < 0.99 ? 2 : 3;
      const s = c * CELL + CELL * voyageRand(h, 11, i);
      let d = (voyageRand(h, 12, i) - 0.5) * 1400;
      if (Math.abs(d) < 26) d = Math.sign(d || 1) * (26 + Math.abs(d));          // keep the leg corridor clear
      const sc = k === 0 ? 0.5 + 2.5 * voyageRand(h, 13, i) ** 2 : k === 1 ? 0.6 + 0.8 * voyageRand(h, 13, i) : k === 2 ? 0.8 + 1.4 * voyageRand(h, 13, i) : 1 + 0.6 * voyageRand(h, 13, i);
      it.push({ s, d, h: this.ground.heightAt(s, d) - (k === 0 ? 0.3 * sc : k === 3 ? 1.2 : 0), rot: voyageRand(h, 14, i) * Math.PI * 2, sc, k });
    }
    this.cache.set(c, it);
    if (this.cache.size > 160) this.cache.delete(this.cache.keys().next().value as number);
    return it;
  }
  update(S: number, level: number) {
    const ref = Math.floor(S / CELL) * CELL;
    if (ref !== this.ref || level !== this.lastLevel) {
      this.ref = ref; this.lastLevel = level;
      const c0 = Math.floor((S - 320) / CELL), c1 = Math.floor((S + 1300) / CELL);
      const n = [0, 0, 0, 0];
      const keep = level <= 0 ? 0.5 : 1;
      for (let c = c0; c <= c1; c++) for (const it of this.cell(c)) {
        const m = this.meshes[it.k];
        if (n[it.k] >= m.instanceMatrix.count) continue;
        if (keep < 1 && voyageRand(c, it.k, Math.floor(it.s)) > keep) continue;
        tq.setFromAxisAngle(tv.set(0, 1, 0), it.rot);
        tm.compose(tv.set(it.d, it.h, -(it.s - ref)), tq, ts.setScalar(it.sc));
        m.setMatrixAt(n[it.k]++, tm);
      }
      this.meshes.forEach((m, i) => { m.count = n[i]; m.instanceMatrix.needsUpdate = true; });
      this.n = n;
    }
    this.group.position.z = S - this.ref;
  }
  draws() { return this.meshes.filter((m) => m.count > 0).length; }
  count() { return this.n.reduce((a, b) => a + b, 0); }
}

// ------------------------------------------------------------------------------------------------ cities
interface Bld { kind: number; x: number; y: number; z: number; sx: number; sy: number; sz: number; rot: number; col: THREE.Color; win: number }
class Cities {
  readonly group = new THREE.Group();
  private blocks: THREE.InstancedMesh; private domes: THREE.InstancedMesh; private towers: THREE.InstancedMesh; private wins: THREE.InstancedMesh;
  private specs: CitySpec[] = [];
  private built = new Map<string, Bld[]>();
  private key = '';
  private winMat: THREE.MeshBasicMaterial;
  private n = 0;
  constructor(private ground: VoyageGround) {
    this.group.name = 'vtp:voyage:cities';
    const m = new THREE.MeshStandardMaterial({ vertexColors: false, roughness: 0.92, metalness: 0.02, flatShading: true });
    this.blocks = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), m, 900);
    this.domes = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), m, 300);
    this.towers = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.8, 1, 1, 8).translate(0, 0.5, 0), m, 300);
    this.winMat = new THREE.MeshBasicMaterial({ color: '#ffc27a', transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
    this.wins = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), this.winMat, 1600);
    for (const im of [this.blocks, this.domes, this.towers, this.wins]) { im.count = 0; im.frustumCulled = false; im.renderOrder = 2; this.group.add(im); }
  }
  set(c: CitySpec[]) { this.specs = c; }
  private build(c: CitySpec): Bld[] {
    const hit = this.built.get(c.id);
    if (hit) return hit;
    const out: Bld[] = [];
    const R = (i: number, j = 0) => voyageRand(c.seed, i, j);
    const pal = c.kind === 'cistern' ? ['#efe6d4', '#e3d6bd', '#f6efe2'] : c.kind === 'hulk' ? ['#6b4a35', '#7a5b42', '#8b6a4a'] : c.kind === 'souk' ? ['#c98e5a', '#b77b4c', '#dca46e'] : ['#c49a6c', '#b48558', '#d4ab7d'];
    const n = c.kind === 'souk' ? 46 : 64;
    // the hero landmark at the centre
    if (c.kind === 'windtower') out.push({ kind: 2, x: 0, y: 0, z: 0, sx: 7, sy: 46, sz: 7, rot: 0, col: new THREE.Color('#d4ab7d'), win: 6 });
    if (c.kind === 'cistern') out.push({ kind: 1, x: 0, y: 0, z: 0, sx: 22, sy: 16, sz: 22, rot: 0, col: new THREE.Color('#f6efe2'), win: 0 });
    if (c.kind === 'hulk') out.push({ kind: 0, x: 0, y: -2, z: 0, sx: 16, sy: 14, sz: 62, rot: 0.3, col: new THREE.Color('#5d3a26'), win: 10 });
    if (c.kind === 'souk') out.push({ kind: 1, x: 0, y: 4, z: 0, sx: 30, sy: 18, sz: 38, rot: 0, col: new THREE.Color('#7f8a5a'), win: 0 });
    for (let i = 0; i < n; i++) {
      const a = R(1, i) * Math.PI * 2, r = c.r * Math.sqrt(0.06 + 0.94 * R(2, i));
      const x = Math.cos(a) * r, z = Math.sin(a) * r * 0.75;
      const ring = r / c.r;
      const t = R(3, i);
      const kind = c.kind === 'cistern' ? (t < 0.45 ? 1 : t < 0.55 ? 2 : 0) : c.kind === 'windtower' ? (t < 0.25 ? 2 : t < 0.35 ? 1 : 0) : c.kind === 'hulk' ? (t < 0.15 ? 2 : 0) : (t < 0.3 ? 1 : 0);
      const big = (1 - ring) * 0.8 + 0.2;
      const sx = kind === 2 ? 2.2 + 2 * R(4, i) : 5 + 9 * R(4, i) * big, sz = kind === 2 ? sx : 5 + 9 * R(5, i) * big;
      const sy = kind === 2 ? 14 + 24 * R(6, i) * big : kind === 1 ? Math.min(sx, sz) * 0.55 : 3 + 9 * R(6, i) * big;
      out.push({ kind, x, y: 0, z, sx, sy, sz: kind === 1 ? sx : sz, rot: R(7, i) * 0.6, col: new THREE.Color(pal[Math.floor(R(8, i) * pal.length) % pal.length]), win: kind === 1 ? 0 : Math.floor(1 + 4 * R(9, i)) });
    }
    // perimeter wall
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2, x = Math.cos(a) * c.r * 1.08, z = Math.sin(a) * c.r * 0.81;
      out.push({ kind: 0, x, y: 0, z, sx: 1.2, sy: 3.5, sz: (c.r * 2 * Math.PI) / 28 * 0.95, rot: -a, col: new THREE.Color(pal[0]), win: 0 });
    }
    this.built.set(c.id, out);
    if (this.built.size > 8) this.built.delete(this.built.keys().next().value as string);
    return out;
  }
  update(S: number, night: number) {
    const vis = this.specs.filter((c) => c.s > S - 1800 && c.s < S + 3000);
    const ref = Math.floor(S / 64) * 64;
    const riseOf = (c: CitySpec) => Math.max(0, Math.min(1, c.rise ?? 1));
    const key = vis.map((c) => `${c.id}${riseOf(c) < 1 ? `@${riseOf(c).toFixed(2)}` : ''}`).join(',') + '|' + ref;
    if (key !== this.key) {
      this.key = key;
      let nb = 0, nd = 0, nt = 0, nw = 0;
      for (const c of vis) {
        const rise = riseOf(c);
        if (rise <= 0.001) continue;
        const base = this.ground.heightAt(c.s, c.d);
        for (const b of this.build(c)) {
          const s = c.s + b.z, d = c.d + b.x;
          // a city being replaced by a fork vote sinks into the haze while the new one rises (smooth, every page alike)
          const y = base + b.y - (b.kind === 1 ? 0 : 0.6) - (1 - rise) * (b.y + b.sy + 4);
          tq.setFromAxisAngle(tv.set(0, 1, 0), b.rot);
          tm.compose(tv.set(d, y, -(s - ref)), tq, ts.set(b.sx, b.sy, b.sz));
          const im = b.kind === 1 ? this.domes : b.kind === 2 ? this.towers : this.blocks;
          const i = b.kind === 1 ? nd++ : b.kind === 2 ? nt++ : nb++;
          if (i >= im.instanceMatrix.count) continue;
          im.setMatrixAt(i, tm); im.setColorAt(i, b.col);
          // windows: a few lit squares on the face towards the route
          for (let w = 0; w < b.win && nw < this.wins.instanceMatrix.count; w++) {
            const wy = y + 1.4 + (b.sy - 2.2) * ((w + 0.5) / Math.max(1, b.win)) * 0.8;
            const face = -Math.sign(c.d) * (b.kind === 2 ? b.sx * 0.95 : b.sx * 0.5 + 0.06);
            tq.setFromAxisAngle(tv.set(0, 1, 0), Math.sign(c.d) > 0 ? -Math.PI / 2 : Math.PI / 2);
            tm.compose(tv.set(d + face, wy, -(s - ref) + (w % 2 ? 1.2 : -1.2)), tq, ts.set(0.9, 1.1, 1));
            this.wins.setMatrixAt(nw++, tm);
          }
        }
      }
      for (const [im, n] of [[this.blocks, nb], [this.domes, nd], [this.towers, nt], [this.wins, nw]] as [THREE.InstancedMesh, number][]) {
        im.count = Math.min(n, im.instanceMatrix.count); im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
      this.n = nb + nd + nt;
      this.ref = ref;
    }
    this.group.position.z = S - this.ref;
    this.winMat.opacity = Math.min(1, night * 1.2);
    this.wins.visible = night > 0.02;
  }
  private ref = 0;
  draws() { return [this.blocks, this.domes, this.towers, this.wins].filter((m) => m.count > 0 && m.visible).length; }
  count() { return this.n; }
}

// ------------------------------------------------------------------------------------------------ backdrop ring
function makeBackdrop(): THREE.Mesh {
  const N = 360, R = 2350;
  const pos: number[] = [], idx: number[] = [];
  const sil = (a: number) => {
    let h = 0;
    for (let k = 1; k <= 5; k++) h += Math.abs(Math.sin(a * (3 + k * 2.3) + k * 1.7)) ** (1 + k * 0.4) / k;
    const mesa = Math.max(0, Math.sin(a * 5 + 0.4)) > 0.82 ? 1 : 0;
    return 30 + 110 * h * 0.5 + mesa * 70;
  };
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const x = Math.sin(a) * R, z = -Math.cos(a) * R;
    pos.push(x, -40, z, x, sil(a), z);
  }
  for (let i = 0; i < N; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uFogCol: { value: new THREE.Vector3(0.8, 0.7, 0.6) }, uSunCol: { value: new THREE.Vector3(1, 0.9, 0.8) }, uStorm: { value: 0 }, uNight: { value: 0 } },
    vertexShader: /* glsl */ `varying float vY; void main() { vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `uniform vec3 uFogCol; uniform vec3 uSunCol; uniform float uStorm; uniform float uNight; varying float vY;
      void main() { vec3 base = mix(vec3(0.42, 0.33, 0.36), vec3(0.62, 0.48, 0.42), smoothstep(-40.0, 160.0, vY)) * (0.6 + 0.4 * uSunCol) * mix(1.0, 0.1, uNight);
        vec3 c = mix(base, uFogCol * mix(1.0, 0.3, uNight * (1.0 - uStorm)), 0.55 + 0.45 * uStorm); gl_FragColor = vec4(c, 1.0);
#include <tonemapping_fragment>
#include <colorspace_fragment>
      }`,
    side: THREE.DoubleSide, fog: false, depthWrite: true,
  });
  mat.name = 'vtp:voyage:backdrop';
  const m = new THREE.Mesh(g, mat);
  m.name = 'vtp:voyage:backdrop'; m.frustumCulled = false; m.renderOrder = 1;
  return m;
}

// ------------------------------------------------------------------------------------------------ storm dust streaks
const DUST_VS = /* glsl */ `
attribute vec4 iSeed;
uniform vec3 uCam; uniform vec3 uVel; uniform float uT; uniform float uBox; uniform float uAmt;
uniform int uDryN; uniform vec3 uDryMin[4]; uniform vec3 uDryMax[4];
varying float vA; varying vec2 vUv;
void main() {
  vec3 p = iSeed.xyz * uBox + uVel * uT * (0.6 + 0.8 * iSeed.w);
  p = mod(p - uCam + 0.5 * uBox, uBox) - 0.5 * uBox + uCam;
  float a = step(iSeed.w, uAmt);
  for (int i = 0; i < 4; i++) { if (i >= uDryN) break; if (all(greaterThan(p, uDryMin[i])) && all(lessThan(p, uDryMax[i]))) a = 0.0; }
  vec3 dir = normalize(uVel + vec3(0.0, 0.0001, 0.0));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec4 mv2 = modelViewMatrix * vec4(p + dir * (0.9 + 1.4 * iSeed.w), 1.0);
  vec4 m = mix(mv, mv2, position.y);
  vec3 side = normalize(cross(mv2.xyz - mv.xyz, -mv.xyz) + vec3(1e-6));
  m.xyz += side * position.x * 0.05 * (1.0 + 0.03 * length(mv.xyz));
  gl_Position = projectionMatrix * m;
  vA = a * (1.0 - smoothstep(0.35 * uBox, 0.5 * uBox, length(p - uCam)));
  vUv = position.xy;
}`;
const DUST_FS = /* glsl */ `
varying float vA; varying vec2 vUv; uniform vec3 uCol;
void main() { float a = vA * (1.0 - abs(vUv.x)) * smoothstep(0.0, 0.3, vUv.y) * smoothstep(1.0, 0.6, vUv.y) * 0.55; if (a < 0.01) discard; gl_FragColor = vec4(uCol, a);
#include <colorspace_fragment>
}`;
class Dust {
  readonly mesh: THREE.Mesh;
  readonly n = 3000;
  private u: Record<string, THREE.IUniform>;
  /** dry boxes (ship frame) */
  dry: THREE.Box3[] = [];
  constructor() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 2, 1, 3]);
    const seeds = new Float32Array(this.n * 4);
    for (let i = 0; i < this.n; i++) { seeds[i * 4] = voyageRand(7, i, 1); seeds[i * 4 + 1] = voyageRand(7, i, 2); seeds[i * 4 + 2] = voyageRand(7, i, 3); seeds[i * 4 + 3] = voyageRand(7, i, 4); }
    g.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    g.instanceCount = this.n;
    this.u = { uCam: { value: new THREE.Vector3() }, uVel: { value: new THREE.Vector3() }, uT: { value: 0 }, uBox: { value: 60 }, uAmt: { value: 0 }, uCol: { value: new THREE.Color('#c9a06a') },
      uDryN: { value: 0 }, uDryMin: { value: [0, 1, 2, 3].map(() => new THREE.Vector3()) }, uDryMax: { value: [0, 1, 2, 3].map(() => new THREE.Vector3()) } };
    const mat = new THREE.ShaderMaterial({ vertexShader: DUST_VS, fragmentShader: DUST_FS, uniforms: this.u, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide });
    mat.forceSinglePass = true;                // (streak quads: one pass looks the same)
    mat.name = 'vtp:voyage:dust';
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = 'vtp:voyage:dust'; this.mesh.frustumCulled = false; this.mesh.renderOrder = 6;
  }
  /** 0..1 scene light (night: dark dust) */
  light = 1;
  /** camShip = camera position in the SHIP frame (the mesh lives there) */
  camShip = new THREE.Vector3();
  update(f: WorldFrame) {
    const amt = Math.min(1, f.storm * (f.level <= 0 ? 0.35 : f.level === 1 ? 0.6 : 1));
    this.mesh.visible = amt > 0.01;
    if (!this.mesh.visible) return;
    this.u.uAmt.value = amt;
    (this.u.uCol.value as THREE.Color).setRGB(0.79 * this.light, 0.63 * this.light, 0.42 * this.light);
    (this.u.uCam.value as THREE.Vector3).copy(this.camShip);
    // the wind blows sideways across the route; the ship's own speed adds a head wind (+z in the ship frame)
    (this.u.uVel.value as THREE.Vector3).set(f.wind.x * 3 + 7, -0.4, f.wind.y * 3 + f.v);
    this.u.uT.value = f.t % 600;
    this.u.uDryN.value = Math.min(4, this.dry.length);
    this.dry.slice(0, 4).forEach((b, i) => { (this.u.uDryMin.value as THREE.Vector3[])[i].copy(b.min); (this.u.uDryMax.value as THREE.Vector3[])[i].copy(b.max); });
  }
}
export type { Dust };
