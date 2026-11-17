// Era shifts — the generic engine behind scene.json `eras` (shared/era.ts has the synced timeline). Any room can list
// eras; each era is a backdrop SET (a node already in the room GLB, `set`, or its own GLB, `file`, loaded lazily) plus
// sky / fog / hemisphere-light / ambient-weather / NPC settings. The stage (every node outside the sets) never changes.
//
// A shift = build-up (a time crystal forms over `crystal`: shards spiral in, light column, pulses) → crack + flash →
// the time ripple: a shockwave sphere expands from the crystal; where its front passes, the old set dissolves (glowing
// edge) and the new one assembles, while sky / fog / light / weather crossfade. Everything is a pure function of the
// shift phase (seconds since its start, from the host's stamped state + the wall clock), so all pages agree.
// Budget: only the showing era's set is visible (+ the incoming one during a shift); era GLBs load on first need and
// the next era is prefetched while the current one shows.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { eraAt, DEFAULT_ERA_TIMING, type SceneEraState, type RoomEraTiming } from '../../../shared/era.ts';

export interface EraSky {
  void?: number; palettes?: string[][]; zenith?: string; horizon?: string; ground?: string; sun?: [number, number, number]; sunColor?: string;
  clouds?: number; cloudColor?: string; stars?: number;
}
export interface EraDef {
  id: string; name?: string; set?: string; file?: string;
  sky?: EraSky; fog?: { color?: string; near?: number; far?: number };
  hemi?: { sky?: string; ground?: string; intensity?: number };
  eclipse?: number; eclipseRim?: string; eclipseRim2?: string; tear?: number; rifts?: number;
  weather?: { kind?: 'snow' | 'ash' | 'pollen' | 'fireflies' | 'embers' | 'none'; amount?: number; color?: string };
  patrons?: { unit: string; clip: string; position: [number, number, number]; facing: [number, number, number]; name?: string }[];
}
export interface RoomErasConfig { list?: EraDef[]; every?: number; build?: number; shift?: number; crystal?: [number, number, number]; support?: { min?: number } }

/** what the rest of the epoch module reads each frame (blended during a shift) */
export interface EraBlend {
  void: number; zen: THREE.Color; hor: THREE.Color; gnd: THREE.Color; sun: THREE.Vector3; sunCol: THREE.Color; clouds: number; cloudCol: THREE.Color; stars: number;
  palA: THREE.Color; palB: THREE.Color; palC: THREE.Color; hasPal: boolean;
  eclipse: number; rim: THREE.Color; rim2: THREE.Color; tear: number; rifts: number; flash: number; build: number;
  current: number; to: number; k: number;
}

interface SetRec {
  root: THREE.Object3D | null; loading: boolean; failed: string; mats: THREE.Material[]; uni: DissolveUniforms;
  sync: { copy: THREE.MeshStandardMaterial; src: THREE.MeshStandardMaterial }[]; ext: { m: THREE.MeshStandardMaterial; base: THREE.Color; em: number }[];
}
interface DissolveUniforms { uEraC: THREE.IUniform<THREE.Vector3>; uEraR: THREE.IUniform<number>; uEraMode: THREE.IUniform<number>; uEraEdge: THREE.IUniform<THREE.Color> }

const smooth = (x: number) => { const k = Math.min(1, Math.max(0, x)); return k * k * (3 - 2 * k); };
const tmpC = new THREE.Color();

// ------------------------------------------------------------------ dissolve patch (any MeshStandard / Basic material)
function patchDissolve(m: THREE.Material, U: DissolveUniforms) {
  if ((m as unknown as { vtpEra?: boolean }).vtpEra) return;
  (m as unknown as { vtpEra?: boolean }).vtpEra = true;
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev?.call(m, sh, r);
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vEraW;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvEraW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vEraW; uniform vec3 uEraC; uniform float uEraR; uniform float uEraMode; uniform vec3 uEraEdge;
      float eraH(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float eraN(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(eraH(i), eraH(i + vec3(1,0,0)), f.x), mix(eraH(i + vec3(0,1,0)), eraH(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(eraH(i + vec3(0,0,1)), eraH(i + vec3(1,0,1)), f.x), mix(eraH(i + vec3(0,1,1)), eraH(i + vec3(1,1,1)), f.x), f.y), f.z); }`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
      if (uEraMode != 0.0) {
        float eraW = 1.6 + uEraR * 0.05;
        float eraD = distance(vEraW, uEraC) + (eraN(vEraW * 0.45) - 0.5) * eraW * 2.2;
        float eraS = eraD - uEraR;
        if (uEraMode < 0.0 && eraS < 0.0) discard;
        if (uEraMode > 0.0 && eraS > 0.0) discard;
        float eraE = 1.0 - smoothstep(0.0, eraW, abs(eraS));
        gl_FragColor.rgb += uEraEdge * eraE * eraE * 4.0;
      }`);
  };
  const key = m.customProgramCacheKey;
  m.customProgramCacheKey = function (this: THREE.Material) { return `${key.call(this)}|vtpEra1`; };
  m.needsUpdate = true;
}

// ------------------------------------------------------------------ the crystal + ripple FX
const NOISE = /* glsl */`float h21(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}`;
function crystalMaterial() {
  // a SOLID faceted time crystal (reads against the bright gate rift behind it): dark violet core, cyan facet edges,
  // bright rim, travelling energy bands; the cracks light up white just before it shatters
  return new THREE.ShaderMaterial({
    name: 'vtp:era:crystal', transparent: true, depthWrite: true, side: THREE.FrontSide, fog: false,
    uniforms: { uT: { value: 0 }, uGlow: { value: 1 }, uCrack: { value: 0 }, uCol: { value: new THREE.Color('#9fe8ff') }, uCore: { value: new THREE.Color('#2a0c5a') }, uA: { value: 1 } },
    vertexShader: `varying vec3 vN; varying vec3 vV; varying vec3 vP; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vN = normalize(mat3(modelMatrix)*normal); vV = normalize(cameraPosition - w.xyz); vP = position; gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `uniform float uT, uGlow, uCrack, uA; uniform vec3 uCol, uCore; varying vec3 vN; varying vec3 vV; varying vec3 vP; ${NOISE}
      void main(){ vec3 n = normalize(vN); float ndv = abs(dot(n, normalize(vV))); float fr = pow(1.0 - ndv, 2.2);
        float key = 0.35 + 0.65 * max(0.0, dot(n, normalize(vec3(-0.4, 0.8, 0.45))));
        float bands = smoothstep(0.7, 1.0, sin(vP.y * 7.0 - uT * 5.0));
        float edge = smoothstep(0.82, 0.97, 1.0 - ndv);
        float cr = step(0.9, fract(sin(floor(vP.y * 7.0) * 12.3 + floor(atan(vP.z, vP.x) * 3.0)) * 43758.5)) * uCrack;
        vec3 c = mix(uCore, uCol * 0.9, key * 0.55 + fr * 0.8) + uCol * (bands * 0.5 + edge * 0.9) * uGlow + vec3(1.0) * (cr * 3.0 + fr * fr * 0.8 * uGlow);
        c = mix(c, vec3(1.25, 1.35, 1.5), smoothstep(0.55, 1.0, uCrack) * 0.85);     // it blazes white as it breaks
        gl_FragColor = vec4(c, uA); }`,
  });
}
function beamMaterial() {
  return new THREE.ShaderMaterial({
    name: 'vtp:era:beam', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    uniforms: { uT: { value: 0 }, uA: { value: 0 }, uCol: { value: new THREE.Color('#9fe8ff') } },
    vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ vUv = uv; vec4 w = modelMatrix*vec4(position,1.0); vN = normalize(mat3(modelMatrix)*normal); vV = normalize(cameraPosition-w.xyz); gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `uniform float uT, uA; uniform vec3 uCol; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){ float e = pow(abs(dot(normalize(vN), normalize(vV))), 2.0); float s = 0.6 + 0.4 * sin(vUv.y * 40.0 - uT * 9.0);
        float fade = smoothstep(0.0, 0.15, vUv.y) * (1.0 - smoothstep(0.6, 1.0, vUv.y));
        gl_FragColor = vec4(uCol * e * s * fade * uA, 1.0); }`,
  });
}
function rippleMaterial() {
  return new THREE.ShaderMaterial({
    name: 'vtp:era:ripple', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    uniforms: { uA: { value: 0 }, uCol: { value: new THREE.Color('#bff4ff') }, uCol2: { value: new THREE.Color('#c070ff') }, uT: { value: 0 } },
    vertexShader: `varying vec3 vN; varying vec3 vV; varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix)*normal); vV = normalize(cameraPosition-w.xyz); gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `uniform float uA, uT; uniform vec3 uCol, uCol2; varying vec3 vN; varying vec3 vV; varying vec3 vW; ${NOISE}
      void main(){ float f = 1.0 - abs(dot(normalize(vN), normalize(vV))); float rim = pow(f, 3.0);
        float wave = 0.5 + 0.5 * sin(vW.y * 0.6 + uT * 4.0 + atan(vW.z, vW.x) * 6.0);
        vec3 c = mix(uCol2, uCol, rim) * (rim * 2.2 + 0.08 + wave * rim * 0.6);
        gl_FragColor = vec4(c * uA, 1.0); }`,
  });
}
function ringMaterial() {
  return new THREE.ShaderMaterial({
    name: 'vtp:era:ring', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    uniforms: { uA: { value: 0 }, uCol: { value: new THREE.Color('#9fe8ff') } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `uniform float uA; uniform vec3 uCol; varying vec2 vUv; void main(){ vec2 p = vUv*2.0-1.0; float r = length(p);
      float band = exp(-pow((r - 0.9) * 22.0, 2.0)) + exp(-pow((r - 0.75) * 40.0, 2.0)) * 0.5; float a = band * (1.0 - smoothstep(0.98, 1.0, r));
      gl_FragColor = vec4(uCol * a * uA, 1.0); }`,
  });
}

// ------------------------------------------------------------------ ambient weather (one Points draw per era kind, world-anchored wrap round the camera)
const WEATHER: Record<string, { n: number; box: [number, number, number]; vel: [number, number, number]; size: number; color: string; blend: THREE.Blending; blink: number; band: [number, number] }> = {
  snow: { n: 2600, box: [44, 22, 44], vel: [0.35, -1.25, 0.1], size: 0.07, color: '#f4f8ff', blend: THREE.NormalBlending, blink: 0, band: [-2, 20] },
  ash: { n: 2000, box: [44, 22, 44], vel: [0.25, -0.55, -0.12], size: 0.075, color: '#b0a8b8', blend: THREE.NormalBlending, blink: 0, band: [-2, 20] },
  pollen: { n: 900, box: [40, 12, 40], vel: [0.25, 0.08, 0.12], size: 0.05, color: '#ffe8a0', blend: THREE.AdditiveBlending, blink: 0.3, band: [0.3, 8] },
  fireflies: { n: 700, box: [46, 7, 46], vel: [0.05, 0.03, 0.04], size: 0.07, color: '#d8ff80', blend: THREE.AdditiveBlending, blink: 1, band: [0.2, 5] },
  embers: { n: 700, box: [40, 16, 40], vel: [0.1, 0.7, -0.05], size: 0.06, color: '#ff9040', blend: THREE.AdditiveBlending, blink: 0.6, band: [0, 14] },
};
class Weather {
  readonly points: THREE.Points;
  readonly u: Record<string, THREE.IUniform>;
  constructor(kind: string, color?: string) {
    const c = WEATHER[kind];
    const pos = new Float32Array(c.n * 3);
    for (let i = 0; i < c.n; i++) {
      const h = (k: number) => { const v = Math.sin((i + 1) * (12.9898 + k * 7.13)) * 43758.5453; return v - Math.floor(v); };
      pos[i * 3] = h(0); pos[i * 3 + 1] = h(1); pos[i * 3 + 2] = h(2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.u = { uT: { value: 0 }, uCam: { value: new THREE.Vector3() }, uBox: { value: new THREE.Vector3(...c.box) }, uVel: { value: new THREE.Vector3(...c.vel) },
      uSize: { value: c.size }, uPx: { value: 800 }, uA: { value: 0 }, uCol: { value: new THREE.Color(color ?? c.color) }, uBlink: { value: c.blink }, uBand: { value: new THREE.Vector2(...c.band) } };
    const mat = new THREE.ShaderMaterial({
      name: 'vtp:era:weather:' + kind, uniforms: this.u, transparent: true, depthWrite: false, blending: c.blend, fog: false,
      vertexShader: `uniform float uT, uSize, uPx, uA, uBlink; uniform vec3 uCam, uBox, uVel; uniform vec2 uBand; varying float vA;
        void main(){ vec3 s = position; vec3 p = s * uBox + uVel * uT + vec3(sin(uT * 0.7 + s.x * 40.0), 0.0, cos(uT * 0.6 + s.z * 30.0)) * 0.6;
          vec3 w = uCam + mod(p - uCam, uBox) - uBox * 0.5;
          w.y = uBand.x + mod(p.y, uBand.y - uBand.x);
          vA = uA * (1.0 - uBlink + uBlink * pow(0.5 + 0.5 * sin(uT * (1.5 + s.y * 3.0) + s.x * 60.0), 3.0));
          vec4 mv = modelViewMatrix * vec4(w, 1.0); gl_Position = projectionMatrix * mv;
          vA *= smoothstep(2.5, 5.0, -mv.z);                       // never a big blob right at the lens (over a face)
          gl_PointSize = min(uSize * uPx / max(0.5, -mv.z), 7.0); }`,
      fragmentShader: `uniform vec3 uCol; varying float vA; void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; float a = (1.0 - smoothstep(0.3, 1.0, d)) * vA; if (a < 0.01) discard; gl_FragColor = vec4(uCol, a); }`,
    });
    this.points = new THREE.Points(g, mat);
    this.points.name = 'vtp:era:weather:' + kind;
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }
  dispose() { this.points.removeFromParent(); this.points.geometry.dispose(); (this.points.material as THREE.Material).dispose(); }
}

// ================================================================== the director
export class EraDirector {
  readonly group = new THREE.Group();
  readonly defs: EraDef[];
  readonly timing: RoomEraTiming;
  private sets = new Map<number, SetRec>();
  private loader = new GLTFLoader();
  private halo: THREE.Sprite;
  private crystal: THREE.Mesh; private beam: THREE.Mesh; private ripple: THREE.Mesh; private ringA: THREE.Mesh; private ringB: THREE.Mesh; private flashS: THREE.Sprite;
  private shards: THREE.InstancedMesh;
  private weather = new Map<string, Weather>();
  private hemi: THREE.HemisphereLight;
  private fogBase: { color: THREE.Color; near: number; far: number } | null = null;
  private houseProbe: { m: THREE.MeshStandardMaterial; base: THREE.Color } | null = null;
  private pc = new THREE.Vector3();
  private lastCur = -1;
  readonly blend: EraBlend;
  stats = { loaded: 0, visible: 0, loads: 0 };

  constructor(readonly roomId: string, readonly cfg: RoomErasConfig, readonly roomRoot: THREE.Object3D, private readonly fileUrl: (f: string) => string, private stage: { scene: THREE.Scene }) {
    this.defs = cfg.list ?? [];
    this.timing = { build: cfg.build ?? DEFAULT_ERA_TIMING.build, shift: cfg.shift ?? DEFAULT_ERA_TIMING.shift };
    this.group.name = 'vtp:eras';
    const c = cfg.crystal ?? [0, 3.3, -2.45];
    this.pc.set(c[0], c[1], c[2]);
    // crystal: a six-sided bipyramid
    const g = new THREE.CylinderGeometry(0.34, 0.34, 0.9, 6, 1, true);
    const top = new THREE.ConeGeometry(0.34, 0.75, 6, 1, true); top.translate(0, 0.825, 0);
    const bot = new THREE.ConeGeometry(0.34, 0.6, 6, 1, true); bot.rotateX(Math.PI); bot.translate(0, -0.75, 0);
    const merged = mergeGeos([g, top, bot]).toNonIndexed();
    merged.scale(1.45, 1.45, 1.45);
    merged.computeVertexNormals();                     // flat facets
    this.crystal = new THREE.Mesh(merged, crystalMaterial());
    this.crystal.position.copy(this.pc); this.crystal.renderOrder = 8; this.crystal.visible = false;
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.9, 30, 16, 1, true), beamMaterial());
    this.beam.position.set(this.pc.x, 12, this.pc.z); this.beam.renderOrder = 7; this.beam.visible = false;
    this.ripple = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), rippleMaterial());
    this.ripple.position.copy(this.pc); this.ripple.renderOrder = 9; this.ripple.visible = false;
    this.ringA = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), ringMaterial()); this.ringA.rotation.x = -Math.PI / 2; this.ringA.position.set(this.pc.x, 0.03, this.pc.z); this.ringA.visible = false;
    this.ringB = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), ringMaterial()); this.ringB.rotation.x = -Math.PI / 2; this.ringB.position.set(this.pc.x, 0.05, this.pc.z); this.ringB.visible = false;
    for (const r of [this.ringA, this.ringB]) r.renderOrder = 6;
    this.flashS = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xd8f4ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, map: glowTexture() }));
    this.flashS.position.copy(this.pc); this.flashS.renderOrder = 10; this.flashS.visible = false;
    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, map: glowTexture() }));
    this.halo.position.copy(this.pc); this.halo.renderOrder = 7; this.halo.visible = false;
    const sg = new THREE.OctahedronGeometry(1, 0); sg.scale(0.35, 1.2, 0.35);
    this.shards = new THREE.InstancedMesh(sg, new THREE.MeshBasicMaterial({ color: 0xbff4ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }), 48);
    this.shards.frustumCulled = false; this.shards.renderOrder = 8; this.shards.visible = false;
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x404040, 0);
    this.hemi.name = 'vtp:eras:hemi';
    this.group.add(this.halo, this.crystal, this.beam, this.ripple, this.ringA, this.ringB, this.flashS, this.shards, this.hemi);
    const fog = stage.scene.fog;
    if (fog instanceof THREE.Fog) this.fogBase = { color: fog.color.clone(), near: fog.near, far: fog.far };
    // house-light probe: the stage floor's material (the light show dims it with the house level / tint)
    roomRoot.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined; if (!this.houseProbe && o.name === 'PLAZA' && m?.isMeshStandardMaterial) this.houseProbe = { m, base: m.color.clone() }; });
    this.blend = { void: 1, zen: new THREE.Color(), hor: new THREE.Color(), gnd: new THREE.Color(), sun: new THREE.Vector3(0, 1, 0), sunCol: new THREE.Color(), clouds: 0, cloudCol: new THREE.Color(), stars: 1,
      palA: new THREE.Color(), palB: new THREE.Color(), palC: new THREE.Color(), hasPal: true, eclipse: 1, rim: new THREE.Color('#ff8a3a'), rim2: new THREE.Color('#ff3a8a'), tear: 1, rifts: 1, flash: 0, build: 0, current: 0, to: 0, k: 0 };
    // in-GLB sets: every set node starts hidden except era 0's
    this.defs.forEach((d, i) => { if (d.set) this.ensure(i); });
    for (const [i, s] of this.sets) if (s.root) s.root.visible = i === 0;
  }

  // ---------------------------------------------------------------- sets
  private rec(i: number): SetRec {
    let s = this.sets.get(i);
    if (!s) {
      s = { root: null, loading: false, failed: '', mats: [], sync: [], ext: [], uni: { uEraC: { value: this.pc.clone() }, uEraR: { value: 0 }, uEraMode: { value: 0 }, uEraEdge: { value: new THREE.Color('#9fe8ff') } } };
      this.sets.set(i, s);
    }
    return s;
  }

  private ensure(i: number) {
    const d = this.defs[i]; if (!d) return;
    const s = this.rec(i);
    if (s.root || s.loading || s.failed) return;
    if (d.set) {
      const node = this.roomRoot.getObjectByName(d.set);
      if (!node) { s.failed = 'no node ' + d.set; return; }
      this.adopt(s, node, false);
    } else if (d.file) {
      s.loading = true; this.stats.loads++;
      this.loader.load(this.fileUrl(d.file), (gltf) => {
        s.loading = false;
        const root = gltf.scene; root.name = 'vtp:era:' + d.id; root.visible = false;
        this.roomRoot.add(root);
        this.adopt(s, root, true);
      }, undefined, (e) => { s.loading = false; s.failed = String((e as Error)?.message ?? e); console.warn('eras: load failed', d.file, e); });
    }
  }

  /** take a set over: patch its materials for the dissolve (clone the ones the stage shares) */
  private adopt(s: SetRec, root: THREE.Object3D, external: boolean) {
    const inside = new Set<THREE.Object3D>();
    root.traverse((o) => inside.add(o));
    const users = new Map<THREE.Material, number>();
    if (!external) this.roomRoot.traverse((o) => { if (inside.has(o)) return; const m = (o as THREE.Mesh).material; if (!m) return; for (const mm of Array.isArray(m) ? m : [m]) users.set(mm, (users.get(mm) ?? 0) + 1); });
    const cloned = new Map<THREE.Material, THREE.Material>();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.frustumCulled = true;
      const swap = (m: THREE.Material) => {
        if (users.has(m)) {
          let c = cloned.get(m);
          if (!c) { c = m.clone(); cloned.set(m, c); if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) s.sync.push({ copy: c as THREE.MeshStandardMaterial, src: m as THREE.MeshStandardMaterial }); }
          m = c;
        }
        if (!s.mats.includes(m)) {
          s.mats.push(m);
          patchDissolve(m, s.uni);
          const sm = m as THREE.MeshStandardMaterial;
          if (external && sm.isMeshStandardMaterial) s.ext.push({ m: sm, base: sm.color.clone(), em: sm.emissiveIntensity });
          if (external && /^M_Cards/.test(m.name)) { m.depthWrite = false; (m as THREE.MeshStandardMaterial).transparent = true; }
        }
        return m;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
    });
    s.root = root;
    this.stats.loaded++;
  }

  // ---------------------------------------------------------------- frame
  update(state: SceneEraState | undefined, nowMs: number, t: number, cam: THREE.Camera, px: number, level: string) {
    const n = this.defs.length;
    if (!n) return;
    const st = state ?? null;
    const m = st ? eraAt(st, n, nowMs, this.timing) : { current: 0, shift: null, next: null };
    const B = this.timing.build, D = this.timing.shift;
    let from = m.current, to = m.current, ph = -1;
    if (m.shift) { from = m.shift.from; to = m.shift.to; ph = m.shift.phase; }
    // assets: the showing era(s) now, the next one in the background
    this.ensure(from); this.ensure(to);
    if (!m.shift) this.ensure((m.current + 1) % n);
    // ---- the shift's progress
    const u = ph < B ? 0 : Math.min(1, (ph - B) / D);                 // ripple progress
    const k = ph < 0 ? (from === to ? 0 : 1) : smooth((ph - B - 0.2) / (D * 0.8));
    const build = ph < 0 ? 0 : ph < B ? smooth(ph / B) : 1 - smooth((ph - B) / 0.6);
    const crack = ph >= B - 0.25 && ph < B + 0.9 ? Math.max(0, 1 - Math.abs(ph - B) / 0.9) : 0;
    const R = ph < B ? 0 : 2 + 260 * Math.pow(u, 2.1);
    // ---- sets: visibility + dissolve fronts
    let vis = 0;
    for (const [i, s] of this.sets) {
      if (!s.root) continue;
      const active = m.shift ? (i === from && u < 1) || (i === to && ph >= B) : i === m.current;
      s.root.visible = active;
      if (active) vis++;
      s.uni.uEraR.value = R;
      s.uni.uEraMode.value = !m.shift || ph < B ? 0 : i === to ? 1 : i === from ? -1 : 0;
      if (i === from && i === to) s.uni.uEraMode.value = 0;
      (s.uni.uEraEdge.value as THREE.Color).set(i === to ? '#bff4ff' : '#d080ff');
      // house + light-show sync for materials the set had to clone / for external eras
      for (const c of s.sync) { c.copy.color.copy(c.src.color); c.copy.emissive.copy(c.src.emissive); c.copy.emissiveIntensity = c.src.emissiveIntensity; c.copy.envMapIntensity = c.src.envMapIntensity; c.copy.metalness = c.src.metalness; }
      if (s.ext.length && this.houseProbe && active) {
        const hp = this.houseProbe;
        tmpC.setRGB(hp.m.color.r / Math.max(0.01, hp.base.r), hp.m.color.g / Math.max(0.01, hp.base.g), hp.m.color.b / Math.max(0.01, hp.base.b));
        for (const e of s.ext) { e.m.color.copy(e.base).multiply(tmpC); e.m.emissiveIntensity = e.em * (1 + build * 0.6); }
      }
    }
    this.stats.visible = vis;
    // ---- blended look (sky / fog / light / weather / backdrop amounts)
    const A = this.defs[from], Bd = this.defs[to];
    const bl = this.blend;
    const pick = (d: EraDef) => ({ void: d.sky?.void ?? 1, zen: d.sky?.zenith ?? '#0a0614', hor: d.sky?.horizon ?? '#2a1030', gnd: d.sky?.ground ?? '#08040c', sun: d.sky?.sun ?? [0.3, 0.3, -0.9],
      sunCol: d.sky?.sunColor ?? '#ffe0b0', clouds: d.sky?.clouds ?? 0, cloudCol: d.sky?.cloudColor ?? '#ffffff', stars: d.sky?.stars ?? 1 });
    const a = pick(A), b = pick(Bd);
    bl.void = a.void + (b.void - a.void) * k;
    bl.zen.set(a.zen).lerp(tmpC.set(b.zen), k); bl.hor.set(a.hor).lerp(tmpC.set(b.hor), k); bl.gnd.set(a.gnd).lerp(tmpC.set(b.gnd), k);
    bl.sun.set(...a.sun).lerp(new THREE.Vector3(...b.sun), k).normalize();
    bl.sunCol.set(a.sunCol).lerp(tmpC.set(b.sunCol), k); bl.cloudCol.set(a.cloudCol).lerp(tmpC.set(b.cloudCol), k);
    bl.clouds = a.clouds + (b.clouds - a.clouds) * k; bl.stars = a.stars + (b.stars - a.stars) * k;
    const pa = A.sky?.palettes, pb = Bd.sky?.palettes;
    bl.hasPal = !!(pa || pb);
    if (pb && k > 0.5) { bl.palA.set(pb[0][0]); bl.palB.set(pb[0][1]); bl.palC.set(pb[0][2]); } else if (pa) { bl.palA.set(pa[0][0]); bl.palB.set(pa[0][1]); bl.palC.set(pa[0][2]); }
    bl.eclipse = (A.eclipse ?? 0) + ((Bd.eclipse ?? 0) - (A.eclipse ?? 0)) * k;
    bl.tear = (A.tear ?? 0) + ((Bd.tear ?? 0) - (A.tear ?? 0)) * k;
    bl.rifts = (A.rifts ?? 0) + ((Bd.rifts ?? 0) - (A.rifts ?? 0)) * k;
    bl.rim.set(A.eclipseRim ?? '#ff8a3a').lerp(tmpC.set(Bd.eclipseRim ?? '#ff8a3a'), k);
    bl.rim2.set(A.eclipseRim2 ?? '#ff3a8a').lerp(tmpC.set(Bd.eclipseRim2 ?? '#ff3a8a'), k);
    bl.flash = crack; bl.build = build; bl.current = m.current; bl.to = to; bl.k = k;
    // fog + the era's light on the plaza (and softly on the performers)
    const fog = this.stage.scene.fog;
    if (fog instanceof THREE.Fog && this.fogBase) {
      const fa = A.fog ?? {}, fb = Bd.fog ?? {};
      fog.color.set(fa.color ?? `#${this.fogBase.color.getHexString()}`).lerp(tmpC.set(fb.color ?? `#${this.fogBase.color.getHexString()}`), k);
      fog.near = (fa.near ?? this.fogBase.near) + ((fb.near ?? this.fogBase.near) - (fa.near ?? this.fogBase.near)) * k;
      fog.far = (fa.far ?? this.fogBase.far) + ((fb.far ?? this.fogBase.far) - (fa.far ?? this.fogBase.far)) * k;
    }
    const ha = A.hemi ?? {}, hb = Bd.hemi ?? {};
    this.hemi.color.set(ha.sky ?? '#ffffff').lerp(tmpC.set(hb.sky ?? '#ffffff'), k);
    this.hemi.groundColor.set(ha.ground ?? '#303030').lerp(tmpC.set(hb.ground ?? '#303030'), k);
    this.hemi.intensity = ((ha.intensity ?? 0) + ((hb.intensity ?? 0) - (ha.intensity ?? 0)) * k) * (1 + crack * 1.5);
    // weather: each era kind fades with its share
    const share = level === 'performance' ? 0.4 : level === 'balanced' ? 0.7 : level === 'high' ? 0.9 : 1;
    const want = new Map<string, number>();
    const add = (d: EraDef, w: number) => { const kd = d.weather?.kind; if (kd && kd !== 'none' && WEATHER[kd]) want.set(kd, (want.get(kd) ?? 0) + (d.weather?.amount ?? 1) * w); };
    add(A, 1 - k); add(Bd, k);
    for (const [kd, w] of want) if (w > 0.001 && !this.weather.has(kd)) { const wx = new Weather(kd, (A.weather?.kind === kd ? A.weather?.color : Bd.weather?.color)); this.weather.set(kd, wx); this.group.add(wx.points); }
    const cp = (cam as THREE.PerspectiveCamera).getWorldPosition(new THREE.Vector3());
    for (const [kd, wx] of this.weather) {
      const w = want.get(kd) ?? 0;
      wx.u.uA.value = w * share; wx.u.uT.value = t % 3600; (wx.u.uCam.value as THREE.Vector3).copy(cp); wx.u.uPx.value = px;
      wx.points.visible = w > 0.001;
    }
    // ---- the crystal build-up, crack, ripple
    const on = ph >= 0;
    const cm = this.crystal.material as THREE.ShaderMaterial;
    const cs = ph < 0 ? 0 : ph < B ? smooth((ph - 0.6) / (B - 1.4)) : Math.max(0, 1 - (ph - B) / 0.35);
    this.crystal.visible = on && cs > 0.002;
    this.crystal.scale.set(cs * 1.05, cs * (1.1 + 0.15 * Math.sin(t * 3)), cs * 1.05);
    this.crystal.rotation.y = t * (0.6 + build * 2.5);
    this.crystal.position.set(this.pc.x, this.pc.y + Math.sin(t * 1.3) * 0.08, this.pc.z);
    cm.uniforms.uT.value = t % 600; cm.uniforms.uGlow.value = 0.6 + build * 1.4 + crack * 3; cm.uniforms.uCrack.value = smooth((ph - (B - 1.2)) / 1.0);
    const bm = this.beam.material as THREE.ShaderMaterial;
    this.beam.visible = on && build > 0.01;
    bm.uniforms.uT.value = t % 600; bm.uniforms.uA.value = build * (0.35 + 0.25 * Math.sin(t * 8)) + crack * 1.5;
    // gathering shards spiral in toward the crystal during the build-up, then burst outward at the crack
    this.shards.visible = on && (build > 0.01 || crack > 0.01);
    if (this.shards.visible) {
      const M = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
      for (let i = 0; i < 48; i++) {
        const f = (i * 0.618034) % 1, a = f * Math.PI * 2 + ph * (1.2 + f);
        const gather = ph < B ? smooth(ph / B) : 1;
        const burst = ph < B ? 0 : (ph - B) * (6 + f * 8);
        const r = (5.5 - 5.0 * gather) * (0.6 + 0.8 * f) + burst;
        p.set(this.pc.x + Math.cos(a) * r, this.pc.y + (f - 0.5) * 3 * (1 - gather) + Math.sin(ph * 2 + i) * 0.2 + (ph >= B ? (f - 0.5) * burst : 0), this.pc.z + Math.sin(a) * r);
        q.setFromEuler(new THREE.Euler(ph * 3 + i, ph * 2 + f * 5, i));
        sc.setScalar((0.06 + f * 0.06) * (ph < B ? 0.4 + gather : Math.max(0, 1 - (ph - B) / 1.2)));
        M.compose(p, q, sc); this.shards.setMatrixAt(i, M);
      }
      this.shards.instanceMatrix.needsUpdate = true;
    }
    const rm = this.ripple.material as THREE.ShaderMaterial;
    this.ripple.visible = on && ph >= B && u < 1;
    this.ripple.scale.setScalar(Math.max(0.01, R));
    rm.uniforms.uA.value = (1 - smooth((u - 0.55) / 0.45)) * 0.9; rm.uniforms.uT.value = t % 600;
    for (const [r, off, amp] of [[this.ringA, 0, 1], [this.ringB, 0.35, 0.6]] as [THREE.Mesh, number, number][]) {
      const ringOn = on && ((ph < B && build > 0.05) || (ph >= B && u < 1));
      r.visible = ringOn;
      const rr = ph < B ? 1.2 + ((ph * 0.8 + off) % 1) * 2.6 : Math.max(0.1, R * (1 - off * 0.2));
      r.scale.set(rr, rr, 1);
      (r.material as THREE.ShaderMaterial).uniforms.uA.value = ph < B ? build * amp * (1 - ((ph * 0.8 + off) % 1)) : (1 - u) * amp * 1.4;
    }
    const hm = this.halo.material as THREE.SpriteMaterial;
    this.halo.visible = this.crystal.visible;
    hm.opacity = cs * (0.35 + 0.35 * build + 0.15 * Math.sin(t * 6)); this.halo.scale.setScalar(2.5 + cs * 4 + build * 3);
    this.halo.position.copy(this.crystal.position);
    const fm = this.flashS.material as THREE.SpriteMaterial;
    this.flashS.visible = crack > 0.01;
    fm.opacity = crack * 0.95; this.flashS.scale.setScalar(4 + crack * 26);
    this.lastCur = m.current;
  }

  /** debug / Scene tab */
  info(state: SceneEraState | undefined, nowMs: number) {
    const n = this.defs.length;
    const m = state ? eraAt(state, n, nowMs, this.timing) : { current: 0, shift: null, next: null };
    return { eras: this.defs.map((d) => d.id), current: this.defs[m.current]?.id, shift: m.shift ? { from: this.defs[m.shift.from]?.id, to: this.defs[m.shift.to]?.id, phase: +m.shift.phase.toFixed(2) } : null,
      nextIn: m.next ? Math.round((m.next - nowMs) / 1000) : null, sets: [...this.sets.entries()].map(([i, s]) => `${this.defs[i]?.id}:${s.root ? (s.root.visible ? 'on' : 'ready') : s.loading ? 'loading' : s.failed || 'idle'}`), ...this.stats };
  }

  dispose() {
    for (const [, s] of this.sets) {
      if (s.root && s.root.name.startsWith('vtp:era:')) { s.root.removeFromParent(); s.root.traverse((o) => { const me = o as THREE.Mesh; if (me.isMesh) { me.geometry.dispose(); for (const mm of Array.isArray(me.material) ? me.material : [me.material]) mm.dispose(); } }); }
      else if (s.root) { s.root.visible = true; s.uni.uEraMode.value = 0; }
    }
    this.sets.clear();
    for (const w of this.weather.values()) w.dispose();
    this.weather.clear();
    const fog = this.stage.scene.fog;
    if (fog instanceof THREE.Fog && this.fogBase) { fog.color.copy(this.fogBase.color); fog.near = this.fogBase.near; fog.far = this.fogBase.far; }
    this.group.removeFromParent();
  }
}

function mergeGeos(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  let off = 0;
  for (const g0 of list) {
    const g = g0.index ? g0 : g0;
    const p = g.attributes.position, nn = g.attributes.normal;
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(nn.getX(i), nn.getY(i), nn.getZ(i)); }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(g.index.getX(i) + off);
    else for (let i = 0; i < p.count; i++) idx.push(i + off);
    off += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setIndex(idx);
  return out;
}

let glowTex: THREE.Texture | null = null;
function glowTexture() {
  if (glowTex) return glowTex;
  const s = 64, d = new Uint8Array(s * s * 4);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const r = Math.hypot(x - s / 2 + 0.5, y - s / 2 + 0.5) / (s / 2);
    const a = Math.max(0, 1 - r) ** 2.2;
    const i = (y * s + x) * 4; d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = Math.round(a * 255);
  }
  const t = new THREE.DataTexture(d, s, s, THREE.RGBAFormat); t.needsUpdate = true; glowTex = t;
  return t;
}
