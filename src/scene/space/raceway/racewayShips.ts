// Raceway fleet renderer: <room>/raceway/ships.glb (built by the room's blender/gh_ships.py) → one InstancedMesh per
// hull kind + one per glow part, drawn immediate-mode like the space battle's ShipSet (src/scene/space/ships.ts), plus:
// per-instance liveries (vertex colour (1,0,1) / (0,1,1) markers → primary / secondary paint), a white-blue shield /
// hit flash, burning-hull embers, dithered fades and the shared face hold (nothing bright passes right behind a face).
// Cel lighting from the room's sun (3 bands) + the gas giant's warm bounce + a cool rim; AO from the vertex alpha.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FACE_GLSL, faceUniforms } from '../ships.ts';

export interface RwShipMeta { length: number; width: number; height: number; engines: number[][]; engineR: number; guns: number[][]; main?: number[];
  lights: { p: number[]; c: string; blink: number }[]; booms?: number[][]; pieces?: { name: string; center: number[] }[]; kind?: string }
export interface RwShipDraw { kind: string; pos: THREE.Vector3; quat: THREE.Quaternion; scale?: number; c1?: THREE.Color; c2?: THREE.Color; heat?: number; fade?: number; flash?: number; stretch?: number }

const BAYER = /* glsl */ `
float bayer4(vec2 p) { ivec2 i = ivec2(mod(p, 4.0)); int b[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5); return (float(b[i.y * 4 + i.x]) + 0.5) / 16.0; }`;
const VS = /* glsl */ `
attribute vec4 iFx;            // flash, heat, fade, stretch
attribute vec3 iC1; attribute vec3 iC2;
attribute vec4 color;
varying vec4 vCol; varying vec3 vN; varying vec3 vW; varying vec4 vFx; varying vec3 vLocal; varying vec3 vC1; varying vec3 vC2;
void main() {
  vec3 p = position;
  p.z *= 1.0 + iFx.w;
  vec4 w = modelMatrix * instanceMatrix * vec4(p, 1.0);
  vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vW = w.xyz; vCol = color; vFx = iFx; vLocal = position; vC1 = iC1; vC2 = iC2;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const HULL_FS = /* glsl */ `
uniform vec3 uSun; uniform vec3 uSunCol; uniform vec3 uBounceDir; uniform vec3 uBounce; uniform vec3 uAmb; uniform float uTime;
varying vec4 vCol; varying vec3 vN; varying vec3 vW; varying vec4 vFx; varying vec3 vLocal; varying vec3 vC1; varying vec3 vC2;
${FACE_GLSL}
${BAYER}
void main() {
  float fade = vFx.z * faceHold();
  if (fade < 0.999 && fade <= bayer4(gl_FragCoord.xy)) discard;
  vec3 base = vCol.rgb;
  if (base.r > 0.9 && base.g < 0.1 && base.b > 0.9) base = vC1;
  else if (base.r < 0.1 && base.g > 0.9 && base.b > 0.9) base = vC2;
  vec3 N = normalize(vN); vec3 V = normalize(cameraPosition - vW);
  float ndl = dot(N, uSun);
  float band = ndl > 0.5 ? 1.0 : ndl > 0.05 ? 0.66 : 0.24;
  float bo = max(dot(N, uBounceDir), 0.0);
  vec3 light = uSunCol * band * 1.2 + uBounce * (0.35 + 0.65 * bo) + uAmb;
  vec3 col = base * light * mix(0.55, 1.0, vCol.a);
  float spec = pow(max(dot(reflect(-uSun, N), V), 0.0), 24.0);
  col += uSunCol * step(0.55, spec) * 0.22;
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col += vec3(0.35, 0.45, 0.7) * rim * 0.3;
  if (vFx.y > 0.0) {
    vec3 lp = vLocal * 0.9;
    float n = fract(sin(dot(floor(lp), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    vec3 fp = fract(lp) - 0.5;
    float spot = smoothstep(0.34, 0.08, length(fp)) * step(0.45, n);
    float fl = 0.6 + 0.4 * sin(uTime * 11.0 + n * 30.0);
    col = mix(col * (1.0 - vFx.y * 0.6), vec3(1.0, 0.36, 0.06) * (1.3 + fl), vFx.y * spot * 0.95);
  }
  col = mix(col, vec3(0.75, 0.9, 1.4), clamp(vFx.x, 0.0, 1.0) * 0.8);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;
const GLOW_FS = /* glsl */ `
uniform float uTime;
varying vec4 vCol; varying vec3 vN; varying vec3 vW; varying vec4 vFx; varying vec3 vLocal; varying vec3 vC1; varying vec3 vC2;
${FACE_GLSL}
${BAYER}
void main() {
  float fade = vFx.z * faceHold();
  if (fade < 0.999 && fade <= bayer4(gl_FragCoord.xy)) discard;
  vec3 col = vCol.rgb * (1.8 + vFx.y * 1.2);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

interface Batch { hull: THREE.InstancedMesh; glow: THREE.InstancedMesh | null; attrs: THREE.InstancedBufferAttribute[]; gattrs: THREE.InstancedBufferAttribute[]; n: number; max: number }
const m4 = new THREE.Matrix4(), sc = new THREE.Vector3();
const WHITE = new THREE.Color(1, 1, 1), GREY = new THREE.Color(0.35, 0.36, 0.38);
const MAX: Record<string, number> = { RACER_A: 8, RACER_B: 8, RACER_C: 8, BRAWLER: 16, HUNTER: 18, BRICK: 8, GUNSHIP_p1: 2, GUNSHIP_p2: 2, GUNSHIP_p3: 2, DEBRIS: 260, DEBRIS_B: 160 };

export class RacewayShips {
  readonly group = new THREE.Group();
  readonly meta: Record<string, RwShipMeta>;
  private batches = new Map<string, Batch>();
  readonly hullMat: THREE.ShaderMaterial;
  readonly glowMat: THREE.ShaderMaterial;
  tris = 0;

  static async load(url: string, metaUrl: string): Promise<RacewayShips> {
    const [gltf, meta] = await Promise.all([new GLTFLoader().loadAsync(url), fetch(metaUrl).then((r) => { if (!r.ok) throw new Error(`ships.json ${r.status}`); return r.json(); })]);
    return new RacewayShips(gltf.scene, meta as Record<string, RwShipMeta>);
  }

  constructor(src: THREE.Object3D, meta: Record<string, RwShipMeta>) {
    this.meta = meta;
    this.group.name = 'vtp:raceway:ships';
    const uniforms = { uSun: { value: new THREE.Vector3(0.6, 0.7, 0.4).normalize() }, uSunCol: { value: new THREE.Color(1, 0.96, 0.9) },
      uBounceDir: { value: new THREE.Vector3(-0.5, 0.4, -0.7).normalize() }, uBounce: { value: new THREE.Color(0.22, 0.13, 0.1) }, uAmb: { value: new THREE.Color(0.035, 0.04, 0.06) },
      uTime: { value: 0 }, ...faceUniforms };
    this.hullMat = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: HULL_FS, uniforms, fog: false });
    this.glowMat = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: GLOW_FS, uniforms, fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    this.hullMat.name = 'vtp:raceway:hull'; this.glowMat.name = 'vtp:raceway:glow';
    const geos = new Map<string, THREE.BufferGeometry>();
    src.updateMatrixWorld(true);
    src.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const g = m.geometry.clone();
      g.applyMatrix4(m.matrixWorld);
      let c = g.getAttribute('color');
      if (!c) { const n = g.getAttribute('position').count; c = new THREE.BufferAttribute(new Float32Array(n * 4).fill(0.6), 4); g.setAttribute('color', c); }
      if (c.itemSize === 3) { const n = c.count, a = new Float32Array(n * 4); for (let i = 0; i < n; i++) { a[i * 4] = c.getX(i); a[i * 4 + 1] = c.getY(i); a[i * 4 + 2] = c.getZ(i); a[i * 4 + 3] = 1; } g.setAttribute('color', new THREE.BufferAttribute(a, 4)); }
      else if (!(c.array instanceof Float32Array)) { const n = c.count, a = new Float32Array(n * 4); for (let i = 0; i < n; i++) { a[i * 4] = c.getX(i); a[i * 4 + 1] = c.getY(i); a[i * 4 + 2] = c.getZ(i); a[i * 4 + 3] = c.getW(i); } g.setAttribute('color', new THREE.BufferAttribute(a, 4)); }
      if (!g.getAttribute('normal')) g.computeVertexNormals();
      geos.set(o.name, g);
    });
    geos.set('DEBRIS', chunk(3, 0.16)); geos.set('DEBRIS_B', chunk(5, 0.1));
    for (const [k, hg] of geos) {
      if (k.endsWith('_glow')) continue;
      const max = MAX[k] ?? 6;
      const mk = (g: THREE.BufferGeometry, mat: THREE.Material, name: string) => {
        const im = new THREE.InstancedMesh(g, mat, max);
        const attrs = [new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4), new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3), new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3)];
        for (const a of attrs) a.setUsage(THREE.DynamicDrawUsage);
        g.setAttribute('iFx', attrs[0]); g.setAttribute('iC1', attrs[1]); g.setAttribute('iC2', attrs[2]);
        im.frustumCulled = false; im.count = 0; im.name = name;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.group.add(im);
        return { im, attrs };
      };
      const h = mk(hg, this.hullMat, `vtp:raceway:${k}`);
      const gg = geos.get(`${k}_glow`);
      const gl = gg ? mk(gg, this.glowMat, `vtp:raceway:${k}_glow`) : null;
      this.tris += (hg.index ? hg.index.count : hg.getAttribute('position').count) / 3;
      this.batches.set(k, { hull: h.im, glow: gl?.im ?? null, attrs: h.attrs, gattrs: gl?.attrs ?? [], n: 0, max });
    }
  }

  kinds() { return [...this.batches.keys()]; }
  setSun(dir: THREE.Vector3) { this.hullMat.uniforms.uSun.value.copy(dir).normalize(); }
  setBounce(dir: THREE.Vector3, c: THREE.Color) { this.hullMat.uniforms.uBounceDir.value.copy(dir).normalize(); this.hullMat.uniforms.uBounce.value.copy(c); }

  begin(t: number) { for (const b of this.batches.values()) b.n = 0; this.hullMat.uniforms.uTime.value = t % 3600; }

  push(d: RwShipDraw): boolean {
    const b = this.batches.get(d.kind);
    if (!b || b.n >= b.max || (d.fade ?? 1) <= 0.002) return false;
    const i = b.n++;
    sc.setScalar(d.scale ?? 1);
    m4.compose(d.pos, d.quat, sc);
    const c1 = d.c1 ?? WHITE, c2 = d.c2 ?? GREY;
    for (const [im, at] of [[b.hull, b.attrs], [b.glow, b.gattrs]] as const) {
      if (!im) continue;
      im.setMatrixAt(i, m4);
      at[0].setXYZW(i, d.flash ?? 0, d.heat ?? 0, d.fade ?? 1, d.stretch ?? 0);
      at[1].setXYZ(i, c1.r, c1.g, c1.b);
      at[2].setXYZ(i, c2.r, c2.g, c2.b);
    }
    return true;
  }

  end() {
    for (const b of this.batches.values()) {
      for (const [im, at] of [[b.hull, b.attrs], [b.glow, b.gattrs]] as const) {
        if (!im) continue;
        im.count = b.n;
        if (b.n) { im.instanceMatrix.needsUpdate = true; for (const a of at) a.needsUpdate = true; }
      }
    }
  }

  counts() { const o: Record<string, number> = {}; for (const [k, b] of this.batches) if (b.n) o[k] = b.n; return o; }
  warmAll(at: THREE.Vector3) { const q = new THREE.Quaternion(); for (const k of this.batches.keys()) this.push({ kind: k, pos: at, quat: q }); }

  dispose() {
    this.group.removeFromParent();
    for (const b of this.batches.values()) { b.hull.geometry.dispose(); b.glow?.geometry.dispose(); b.hull.dispose(); b.glow?.dispose(); }
    this.hullMat.dispose(); this.glowMat.dispose();
  }
}

/** a small faceted chunk of hull plating (debris). */
function chunk(seed: number, dark: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 0).toNonIndexed();
  const p = g.getAttribute('position');
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const sx = 0.6 + rnd(), sy = 0.25 + rnd() * 0.4, sz = 0.8 + rnd();
  for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * sx, p.getY(i) * sy, p.getZ(i) * sz);
  g.computeVertexNormals();
  const col = new Float32Array(p.count * 4);
  for (let i = 0; i < p.count; i += 3) { const v = dark + rnd() * 0.14; const r = rnd() < 0.25 ? 0.12 : 0; for (let k = 0; k < 3; k++) col.set([v + r, v, v * 0.95, 1], (i + k) * 4); }
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  return g;
}
