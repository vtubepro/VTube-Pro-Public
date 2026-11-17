// Rain (cheap): one instanced draw of camera-facing streaks in a world-anchored box that wraps around the camera (drops
// don't slide when the camera moves), falling with the wind; drops inside ENV_DRY_* boxes or right in front of the lens
// are collapsed in the vertex shader. Splashes: one instanced draw of expanding rings on up-facing surfaces found by
// ray-casting the room once (spread over frames). Counts follow the graphics level through instanceCount (no recompiles).
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { MAX_DRY } from './materials.ts';

const RAIN_VS = /* glsl */ `
attribute vec4 aSeed;
uniform vec3 uCam; uniform float uT; uniform vec3 uWindV; uniform float uFall; uniform float uBox; uniform float uH;
uniform float uLen; uniform float uWidth; uniform int uDryN; uniform vec3 uDryMin[${MAX_DRY}]; uniform vec3 uDryMax[${MAX_DRY}];
varying float vA; varying float vX;
void main() {
  float sp = uFall * (0.85 + 0.3 * aSeed.w);
  float fall = fract(aSeed.z - uT * sp / uH);                         // 1 = top of the box … 0 = bottom
  vec3 drift = uWindV * ((1.0 - fall) * uH / sp);
  vec3 base;
  base.xz = uCam.xz + (fract((aSeed.xy * uBox - uCam.xz + drift.xz) / uBox) - 0.5) * uBox;
  base.y = uCam.y - uH * 0.42 + fall * uH;
  vec3 vel = vec3(uWindV.x, -sp, uWindV.z);
  vec3 dir = normalize(vel);
  vec3 toCam = normalize(uCam - base);
  vec3 side = normalize(cross(dir, toCam) + vec3(1e-5));
  float dist = length(uCam - base);
  float k = 1.0;
  for (int i = 0; i < ${MAX_DRY}; i++) {
    if (i >= uDryN) break;
    vec3 a = uDryMin[i], b = uDryMax[i];
    if (all(greaterThan(base, a)) && all(lessThan(base, b))) k = 0.0;
  }
  k *= smoothstep(1.1, 2.6, dist);                                     // nothing right in front of the lens / faces
  float len = uLen * (0.7 + 0.6 * aSeed.w) * k;
  vec3 p = base + side * position.x * uWidth * (0.7 + dist * 0.035) * k + dir * position.y * len;
  vA = k * smoothstep(uBox * 0.5, uBox * 0.28, dist) * (1.0 + 0.7 * position.y);      // bright head, faint tail
  vX = position.x * 2.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const RAIN_FS = /* glsl */ `
uniform vec3 uCol; uniform float uAlpha;
varying float vA; varying float vX;
void main() {
  float a = uAlpha * vA * (1.0 - abs(vX));
  if (a < 0.003) discard;
  gl_FragColor = vec4(uCol, a);
  #include <colorspace_fragment>
}`;

const SPLASH_VS = /* glsl */ `
attribute vec4 aP; attribute vec2 aS;
uniform float uT; uniform float uRate;
varying vec2 vUv2; varying float vPh;
void main() {
  float ph = fract(aS.x + uT * uRate * (0.8 + 0.4 * aS.y));
  float r = mix(0.02, 0.15, sqrt(ph)) * (0.7 + 0.6 * aS.y);
  vec3 p = aP.xyz + vec3(position.x, 0.004, position.y) * r;
  vUv2 = position.xy * 2.0; vPh = ph;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const SPLASH_FS = /* glsl */ `
uniform vec3 uCol; uniform float uAlpha;
varying vec2 vUv2; varying float vPh;
void main() {
  float r = length(vUv2);
  float ring = smoothstep(0.62, 0.82, r) * (1.0 - smoothstep(0.86, 1.0, r));
  float dot0 = (1.0 - smoothstep(0.0, 0.35, r)) * (1.0 - smoothstep(0.0, 0.18, vPh)) * 1.4;
  float a = uAlpha * (ring * (1.0 - vPh) * (1.0 - vPh) + dot0);
  if (a < 0.004) discard;
  gl_FragColor = vec4(uCol, a);
  #include <colorspace_fragment>
}`;

export class Rain {
  readonly mesh: THREE.Mesh;
  readonly geo: THREE.InstancedBufferGeometry;
  readonly max: number;
  readonly u = {
    uCam: { value: new THREE.Vector3() }, uT: { value: 0 }, uWindV: { value: new THREE.Vector3() }, uFall: { value: 9 }, uBox: { value: 24 }, uH: { value: 14 },
    uLen: { value: 0.55 }, uWidth: { value: 0.012 }, uDryN: { value: 0 },
    uDryMin: { value: Array.from({ length: MAX_DRY }, () => new THREE.Vector3()) }, uDryMax: { value: Array.from({ length: MAX_DRY }, () => new THREE.Vector3()) },
    uCol: { value: new THREE.Color(0.7, 0.75, 0.82) }, uAlpha: { value: 0.3 },
  };

  constructor(max = 7000, seed = 1) {
    this.max = max;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, -1, 0, -0.5, -1, 0], 3));
    g.setIndex([0, 2, 1, 0, 3, 2]);
    const a = new Float32Array(max * 4);
    let s = seed * 9301 + 49297;
    const r = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
    for (let i = 0; i < max * 4; i++) a[i] = r();
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(a, 4));
    g.instanceCount = 0;
    this.geo = g;
    const m = new THREE.ShaderMaterial({ vertexShader: RAIN_VS, fragmentShader: RAIN_FS, uniforms: this.u, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide });
    m.name = 'vtp:env:rain';
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.name = 'vtp:env:rain';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
  }
  set count(n: number) { this.geo.instanceCount = Math.max(0, Math.min(this.max, Math.round(n))); this.mesh.visible = this.geo.instanceCount > 0; }
  get count() { return this.geo.instanceCount; }
  dispose() { this.mesh.removeFromParent(); this.geo.dispose(); (this.mesh.material as THREE.Material).dispose(); }
}

export class Splashes {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private pts: Float32Array;
  private n = 0;
  readonly max: number;
  readonly u = { uT: { value: 0 }, uRate: { value: 1.6 }, uCol: { value: new THREE.Color(0.8, 0.85, 0.92) }, uAlpha: { value: 0.5 } };
  private job: Generator<void, void, void> | null = null;
  /** Found splash points so far (debug). */
  get found() { return this.n; }

  constructor(max = 900) {
    this.max = max;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setIndex([0, 2, 1, 0, 3, 2]);
    this.pts = new Float32Array(max * 4);
    const s = new Float32Array(max * 2);
    for (let i = 0; i < max; i++) { s[i * 2] = fract(Math.sin(i * 12.9898) * 43758.5453); s[i * 2 + 1] = fract(Math.sin(i * 78.233) * 12543.117); }
    g.setAttribute('aP', new THREE.InstancedBufferAttribute(this.pts, 4));
    g.setAttribute('aS', new THREE.InstancedBufferAttribute(s, 2));
    g.instanceCount = 0;
    this.geo = g;
    const m = new THREE.ShaderMaterial({ vertexShader: SPLASH_VS, fragmentShader: SPLASH_FS, uniforms: this.u, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    m.name = 'vtp:env:splash';
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.name = 'vtp:env:splash';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
  }

  /** Find splash points: a jittered grid over `area` (world XZ box), rays straight down from above `top`, keeping
   *  up-facing hits outside dry boxes. Resumable (≤ ~2 ms per call). */
  scan(meshes: THREE.Mesh[], area: THREE.Box3, top: number, dry: THREE.Box3[]) {
    this.job = this.scanSteps(meshes, area, top, dry);
  }
  private *scanSteps(meshes: THREE.Mesh[], area: THREE.Box3, top: number, dry: THREE.Box3[]): Generator<void, void, void> {
    const bvh = new Map<THREE.BufferGeometry, MeshBVH>();
    const boxes = meshes.map((m) => new THREE.Box3().setFromObject(m));
    const inv = new THREE.Matrix4(), ray = new THREE.Ray(), wr = new THREE.Ray(), nm = new THREE.Matrix3();
    const side = Math.ceil(Math.sqrt(this.max * 1.6));
    const sx = (area.max.x - area.min.x) / side, sz = (area.max.z - area.min.z) / side;
    let t0 = performance.now();
    const p = new THREE.Vector3(), nrm = new THREE.Vector3();
    for (let iz = 0; iz < side && this.n < this.max; iz++) {
      for (let ix = 0; ix < side && this.n < this.max; ix++) {
        const x = area.min.x + (ix + fract(Math.sin((ix + iz * 131) * 91.3) * 437.5)) * sx;
        const z = area.min.z + (iz + fract(Math.sin((iz + ix * 17) * 47.1) * 921.7)) * sz;
        wr.origin.set(x, top, z); wr.direction.set(0, -1, 0);
        let best = Infinity;
        for (let i = 0; i < meshes.length; i++) {
          const b = boxes[i];
          if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue;
          const m = meshes[i];
          const g = m.geometry;
          if (!g?.attributes?.position) continue;
          let t = bvh.get(g);
          if (!t) { try { t = new MeshBVH(g); } catch { continue; } bvh.set(g, t); if (performance.now() - t0 > 2) { yield; t0 = performance.now(); } }
          inv.copy(m.matrixWorld).invert();
          ray.copy(wr).applyMatrix4(inv);
          const h = t.raycastFirst(ray, THREE.DoubleSide);
          if (!h || !h.face) continue;
          const hp = h.point.clone().applyMatrix4(m.matrixWorld);
          const d = top - hp.y;
          if (d < best) { best = d; p.copy(hp); nm.getNormalMatrix(m.matrixWorld); nrm.copy(h.face.normal).applyMatrix3(nm).normalize(); }
        }
        if (best < Infinity && Math.abs(nrm.y) > 0.75 && !dry.some((b) => b.containsPoint(p))) {
          const i = this.n++;
          this.pts[i * 4] = p.x; this.pts[i * 4 + 1] = p.y; this.pts[i * 4 + 2] = p.z; this.pts[i * 4 + 3] = 1;
        }
        if (performance.now() - t0 > 2) { yield; t0 = performance.now(); }
      }
    }
    (this.geo.getAttribute('aP') as THREE.InstancedBufferAttribute).needsUpdate = true;
  }
  /** Continue a scan (call every frame; ~2 ms). */
  step() {
    if (!this.job) return;
    if (this.job.next().done) this.job = null;
  }
  get scanning() { return !!this.job; }
  set count(n: number) { this.geo.instanceCount = Math.max(0, Math.min(this.n, Math.round(n))); this.mesh.visible = this.geo.instanceCount > 0; }
  dispose() { this.mesh.removeFromParent(); this.geo.dispose(); (this.mesh.material as THREE.Material).dispose(); this.job = null; }
}

function fract(x: number) { return x - Math.floor(x); }
