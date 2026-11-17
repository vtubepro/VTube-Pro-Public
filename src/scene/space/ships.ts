// Ships + debris: assets/space/space_ships.glb (built by assets/space/blender/build_ships.py) → one InstancedMesh per
// hull and per glow part, drawn immediate-mode: every frame the director pushes the ships it wants (position,
// orientation, stretch along the nose for warp jumps, warp glow, heat / fire, fade) and the counts are rewritten.
// Hulls: cel shading from the sun (3 bands) + a cool rim + planet bounce; glows: unlit vertex colour × intensity.
// Fades are ordered dithering (no sorting, stays in the opaque pass); a screen-space "face hold" dims whatever passes
// right behind a performer's face.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import SHIP_META from '../../../assets/space/space_ships.json';

const SHIPS_URL = new URL('../../../assets/space/space_ships.glb', import.meta.url).href;

export type ShipKind = 'SD' | 'FRIGATE' | 'EAGLE' | 'PELICAN' | 'BOT_FIGHTER' | 'SAUCER' | 'BOT_CRUISER_p1' | 'BOT_CRUISER_p2' | 'BOT_CRUISER_p3' | 'BOT_CRUISER_p4' | 'BOT_CRUISER_p5' | 'DEBRIS' | 'DEBRIS_B';
export interface ShipMeta { length: number; width: number; height: number; main?: number[]; guns: number[][]; broadside?: number[][]; engines: number[][]; engineR: number; lights: { p: number[]; c: string; blink: number }[]; emitter?: number[]; booms?: number[][]; pieces?: { name: string; center: number[]; span: number[] }[]; bridge?: number[] }

const MAX: Partial<Record<ShipKind, number>> = { SD: 8, FRIGATE: 8, EAGLE: 48, PELICAN: 10, BOT_FIGHTER: 16, SAUCER: 3, DEBRIS: 220, DEBRIS_B: 120 };

export const FACE_SLOTS = 6;
/** Screen-space face boxes (pixels, x0 y0 x1 y1) shared by every space material. */
export const faceUniforms = { uFaces: { value: Array.from({ length: FACE_SLOTS }, () => new THREE.Vector4(-1, -1, -1, -1)) }, uFaceN: { value: 0 }, uFaceDim: { value: 0.3 } };
export const FACE_GLSL = /* glsl */ `
uniform vec4 uFaces[${FACE_SLOTS}]; uniform int uFaceN; uniform float uFaceDim;
float faceHold() {
  float k = 1.0;
  for (int i = 0; i < ${FACE_SLOTS}; i++) {
    if (i >= uFaceN) break;
    vec4 r = uFaces[i];
    vec2 c = (r.xy + r.zw) * 0.5, h = (r.zw - r.xy) * 0.5;
    vec2 q = abs(gl_FragCoord.xy - c) / max(h, vec2(1.0));
    float m = max(q.x, q.y);
    k = min(k, mix(uFaceDim, 1.0, smoothstep(0.75, 1.25, m)));
  }
  return k;
}`;
const BAYER = /* glsl */ `
float bayer4(vec2 p) { ivec2 i = ivec2(mod(p, 4.0)); int b[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5); return (float(b[i.y * 4 + i.x]) + 0.5) / 16.0; }`;

const HULL_VS = /* glsl */ `
attribute vec4 iFx;            // warp glow, heat, fade, stretch
attribute vec3 color;
varying vec3 vCol; varying vec3 vN; varying vec3 vW; varying vec4 vFx; varying vec3 vLocal;
void main() {
  vec3 p = position;
  p.z *= 1.0 + iFx.w;          // warp stretch along the nose
  vec4 w = modelMatrix * instanceMatrix * vec4(p, 1.0);
  vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vW = w.xyz; vCol = color; vFx = iFx; vLocal = position;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const HULL_FS = /* glsl */ `
uniform vec3 uSun; uniform vec3 uSunCol; uniform vec3 uBounce; uniform float uTime;
varying vec3 vCol; varying vec3 vN; varying vec3 vW; varying vec4 vFx; varying vec3 vLocal;
${FACE_GLSL}
${BAYER}
void main() {
  float fade = vFx.z * faceHold();
  if (fade < 0.999 && fade <= bayer4(gl_FragCoord.xy)) discard;
  vec3 N = normalize(vN); vec3 V = normalize(cameraPosition - vW);
  float ndl = dot(N, uSun);
  float band = ndl > 0.45 ? 1.0 : ndl > 0.0 ? 0.62 : 0.3;
  vec3 col = vCol * (uSunCol * band * 1.15 + uBounce * (0.5 + 0.5 * -N.y));
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col += vec3(0.25, 0.4, 0.6) * rim * 0.35;
  // heat: burning hull (enemy break-up), flickering embers
  if (vFx.y > 0.0) {
    vec3 lp = vLocal * 0.22;
    float n = fract(sin(dot(floor(lp), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    vec3 fp = fract(lp) - 0.5 - (vec3(fract(n * 7.1), fract(n * 13.7), fract(n * 3.3)) - 0.5) * 0.4;
    float spot = smoothstep(0.32, 0.06, length(fp)) * step(0.5, n);
    float fl = 0.6 + 0.4 * sin(uTime * 11.0 + n * 30.0);
    col = mix(col, vec3(1.0, 0.35, 0.06) * (1.2 + fl), vFx.y * spot * 0.9);
    col += vec3(0.35, 0.06, 0.02) * vFx.y * 0.3;
  }
  col = mix(col, vec3(0.7, 0.9, 1.3), vFx.x);
  gl_FragColor = vec4(col, 1.0);

  #include <colorspace_fragment>
}`;
const GLOW_FS = /* glsl */ `
uniform float uTime;
varying vec3 vCol; varying vec3 vN; varying vec3 vW; varying vec4 vFx; varying vec3 vLocal;
${FACE_GLSL}
${BAYER}
void main() {
  float fade = vFx.z * faceHold();
  if (fade < 0.999 && fade <= bayer4(gl_FragCoord.xy)) discard;
  vec3 col = vCol * (1.6 + vFx.y * 1.5);
  col = mix(col, vec3(0.8, 0.95, 1.4), vFx.x);
  gl_FragColor = vec4(col, 1.0);

  #include <colorspace_fragment>
}`;

export interface ShipDraw { kind: ShipKind; pos: THREE.Vector3; quat: THREE.Quaternion; scale?: number; warp?: number; heat?: number; fade?: number; stretch?: number }

interface Batch { hull: THREE.InstancedMesh; glow: THREE.InstancedMesh | null; fx: THREE.InstancedBufferAttribute; gfx: THREE.InstancedBufferAttribute | null; n: number; max: number }

const m4 = new THREE.Matrix4(), sc = new THREE.Vector3();
const CRAFT_SCALE: Record<string, number> = { EAGLE: 1.5, BOT_FIGHTER: 1.5, PELICAN: 1.35 };

export class ShipSet {
  readonly group = new THREE.Group();
  readonly meta: Record<string, ShipMeta>;
  private batches = new Map<ShipKind, Batch>();
  readonly hullMat: THREE.ShaderMaterial;
  readonly glowMat: THREE.ShaderMaterial;
  tris = 0;

  static async load(): Promise<ShipSet> {
    const gltf = await new GLTFLoader().loadAsync(SHIPS_URL);
    return new ShipSet(gltf.scene, SHIP_META as unknown as Record<string, ShipMeta>);
  }

  constructor(src: THREE.Object3D, meta0: Record<string, ShipMeta>, sun = new THREE.Vector3(0.5, 0.6, 0.3)) {
    // small craft are drawn a little larger than true scale (stylised: they have to read from the bridge)
    const meta: Record<string, ShipMeta> = JSON.parse(JSON.stringify(meta0));
    for (const k of Object.keys(CRAFT_SCALE)) {
      const m = meta[k], f = CRAFT_SCALE[k];
      if (!m) continue;
      const sc = (a?: number[]) => a?.forEach((v, i) => (a[i] = v * f));
      m.length *= f; m.width *= f; m.height *= f; m.engineR *= f;
      sc(m.main); m.guns.forEach(sc); m.broadside?.forEach(sc); m.engines.forEach(sc); m.lights.forEach((l) => sc(l.p));
    }
    this.meta = meta;
    this.group.name = 'vtp:space:ships';
    const uniforms = { uSun: { value: sun.clone().normalize() }, uSunCol: { value: new THREE.Color(1, 0.96, 0.9) }, uBounce: { value: new THREE.Color(0.05, 0.06, 0.07) }, uTime: { value: 0 }, ...faceUniforms };
    this.hullMat = new THREE.ShaderMaterial({ vertexShader: HULL_VS, fragmentShader: HULL_FS, uniforms, fog: false });
    this.glowMat = new THREE.ShaderMaterial({ vertexShader: HULL_VS, fragmentShader: GLOW_FS, uniforms, fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    const geos = new Map<string, THREE.BufferGeometry>();
    src.updateMatrixWorld(true);
    src.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const g = m.geometry.clone();
      g.applyMatrix4(m.matrixWorld);
      // pieces were exported around their own centre already; ships at the origin
      if (!g.getAttribute('color')) { const n = g.getAttribute('position').count; g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(0.5), 3)); }
      const c = g.getAttribute('color');
      if (c.itemSize === 4) { const n = c.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[i * 3] = c.getX(i); a[i * 3 + 1] = c.getY(i); a[i * 3 + 2] = c.getZ(i); } g.setAttribute('color', new THREE.BufferAttribute(a, 3)); }
      const f = CRAFT_SCALE[o.name.replace(/_glow$/, '')];
      if (f) g.scale(f, f, f);
      geos.set(o.name, g);
    });
    // debris chunks: two small faceted rocks of hull plating
    geos.set('DEBRIS', chunk(1, 0.14)); geos.set('DEBRIS_B', chunk(2, 0.09));
    const kinds: ShipKind[] = ['SD', 'FRIGATE', 'EAGLE', 'PELICAN', 'BOT_FIGHTER', 'SAUCER', 'BOT_CRUISER_p1', 'BOT_CRUISER_p2', 'BOT_CRUISER_p3', 'BOT_CRUISER_p4', 'BOT_CRUISER_p5', 'DEBRIS', 'DEBRIS_B'];
    for (const k of kinds) {
      const hg = geos.get(k);
      if (!hg) { console.warn('space: ship mesh missing', k); continue; }
      const max = MAX[k] ?? 2;
      const hull = new THREE.InstancedMesh(hg, this.hullMat, max);
      const fx = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4); fx.setUsage(THREE.DynamicDrawUsage);
      hg.setAttribute('iFx', fx);
      hull.frustumCulled = false; hull.count = 0; hull.name = `vtp:space:${k}`;
      hull.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(hull);
      const gg = geos.get(`${k}_glow`);
      let glow: THREE.InstancedMesh | null = null, gfx: THREE.InstancedBufferAttribute | null = null;
      if (gg) {
        glow = new THREE.InstancedMesh(gg, this.glowMat, max);
        gfx = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4); gfx.setUsage(THREE.DynamicDrawUsage);
        gg.setAttribute('iFx', gfx);
        glow.frustumCulled = false; glow.count = 0; glow.name = `vtp:space:${k}_glow`;
        glow.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.group.add(glow);
      }
      this.tris += (hg.index ? hg.index.count : hg.getAttribute('position').count) / 3;
      this.batches.set(k, { hull, glow, fx, gfx, n: 0, max });
    }
  }

  setSun(dir: THREE.Vector3, color?: THREE.Color) { this.hullMat.uniforms.uSun.value.copy(dir).normalize(); if (color) this.hullMat.uniforms.uSunCol.value.copy(color); }
  setBounce(c: THREE.Color) { this.hullMat.uniforms.uBounce.value.copy(c); }

  begin(t: number) { for (const b of this.batches.values()) b.n = 0; this.hullMat.uniforms.uTime.value = t % 3600; }

  push(d: ShipDraw): boolean {
    const b = this.batches.get(d.kind);
    if (!b || b.n >= b.max) return false;
    const i = b.n++;
    sc.setScalar(d.scale ?? 1);
    m4.compose(d.pos, d.quat, sc);
    b.hull.setMatrixAt(i, m4);
    b.fx.setXYZW(i, d.warp ?? 0, d.heat ?? 0, d.fade ?? 1, d.stretch ?? 0);
    if (b.glow && b.gfx) { b.glow.setMatrixAt(i, m4); b.gfx.setXYZW(i, d.warp ?? 0, d.heat ?? 0, d.fade ?? 1, d.stretch ?? 0); }
    return true;
  }

  end() {
    for (const b of this.batches.values()) {
      b.hull.count = b.n;
      if (b.n) { b.hull.instanceMatrix.needsUpdate = true; b.fx.needsUpdate = true; }
      if (b.glow && b.gfx) { b.glow.count = b.n; if (b.n) { b.glow.instanceMatrix.needsUpdate = true; b.gfx.needsUpdate = true; } }
    }
  }

  counts() { const o: Record<string, number> = {}; for (const [k, b] of this.batches) if (b.n) o[k] = b.n; return o; }

  /** Warm-up: one of everything far away, for renderer.compile. */
  warmAll(at: THREE.Vector3) { const q = new THREE.Quaternion(); for (const k of this.batches.keys()) this.push({ kind: k, pos: at, quat: q }); }

  dispose() {
    this.group.removeFromParent();
    for (const b of this.batches.values()) { b.hull.geometry.dispose(); b.glow?.geometry.dispose(); b.hull.dispose(); b.glow?.dispose(); }
    this.hullMat.dispose(); this.glowMat.dispose();
  }
}

/** A small faceted chunk (debris) with dark hull colours. */
function chunk(seed: number, dark: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 0).toNonIndexed();
  const p = g.getAttribute('position');
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const sx = 0.6 + rnd(), sy = 0.3 + rnd() * 0.5, sz = 0.8 + rnd();
  for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * sx, p.getY(i) * sy, p.getZ(i) * sz);
  g.computeVertexNormals();
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i += 3) { const v = dark + rnd() * 0.12; const r = rnd() < 0.2 ? 0.1 : 0; col.set([v + r, v, v, v + r, v, v, v + r, v, v], i * 3); }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
