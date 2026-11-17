// Raid effects, all pooled and instanced (a handful of draw calls whatever happens): tracers (camera-facing streaks),
// muzzle flashes + dust / smoke puffs (billboards), sparks (points), decals (bullet holes, glass cracks), blob shadows.
// No lights, no post. Sprites are drawn once into a small canvas atlas (no image files).
import * as THREE from 'three';
import { SpotFlashGate } from '../../../shared/flashGovernor.ts';

function spriteAtlas(): THREE.CanvasTexture {
  const S = 256, H = 128;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d')!;
  // 0: muzzle flash star (top-left in UV space = bottom-left of the canvas, see cell math in the shader)
  const cell = (i: number) => [(i % 2) * H, (1 - Math.floor(i / 2)) * H] as const;
  {
    const [x, y] = cell(0);
    g.save(); g.translate(x + H / 2, y + H / 2);
    const rg = g.createRadialGradient(0, 0, 0, 0, 0, H / 2);
    rg.addColorStop(0, 'rgba(255,255,235,1)'); rg.addColorStop(0.25, 'rgba(255,220,120,0.95)'); rg.addColorStop(0.6, 'rgba(255,140,40,0.35)'); rg.addColorStop(1, 'rgba(255,90,20,0)');
    g.fillStyle = rg;
    g.beginPath();
    for (let k = 0; k < 14; k++) { const a = (k / 14) * Math.PI * 2, r = k % 2 ? H * 0.18 : H * (k % 4 ? 0.36 : 0.5); g.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
    g.closePath(); g.fill(); g.restore();
  }
  // 1: soft puff
  {
    const [x, y] = cell(1);
    const rg = g.createRadialGradient(x + H / 2, y + H / 2, 0, x + H / 2, y + H / 2, H / 2);
    rg.addColorStop(0, 'rgba(255,255,255,0.9)'); rg.addColorStop(0.5, 'rgba(255,255,255,0.45)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg; g.fillRect(x, y, H, H);
  }
  // 2: glass crack
  {
    const [x, y] = cell(2);
    g.save(); g.translate(x + H / 2, y + H / 2);
    g.strokeStyle = 'rgba(235,245,255,0.95)'; g.lineWidth = 1.6;
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 11; k++) {
      const a = (k / 11) * Math.PI * 2 + rnd() * 0.4;
      g.beginPath(); g.moveTo(0, 0);
      let px = 0, py = 0;
      for (let s = 1; s <= 4; s++) { const r = s * H * 0.12 * (0.7 + rnd() * 0.5); const aa = a + (rnd() - 0.5) * 0.35; px = Math.cos(aa) * r; py = Math.sin(aa) * r; g.lineTo(px, py); }
      g.stroke();
    }
    for (const r of [H * 0.12, H * 0.26]) { g.beginPath(); for (let k = 0; k <= 12; k++) { const a = (k / 12) * Math.PI * 2; const rr = r * (0.8 + rnd() * 0.4); g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); } g.stroke(); }
    g.fillStyle = 'rgba(20,24,28,0.9)'; g.beginPath(); g.arc(0, 0, 4, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  // 3: bullet hole (dark centre, scorched ring)
  {
    const [x, y] = cell(3);
    const rg = g.createRadialGradient(x + H / 2, y + H / 2, 0, x + H / 2, y + H / 2, H / 2);
    rg.addColorStop(0, 'rgba(10,10,10,1)'); rg.addColorStop(0.18, 'rgba(15,15,15,0.95)'); rg.addColorStop(0.3, 'rgba(60,55,50,0.6)'); rg.addColorStop(1, 'rgba(60,55,50,0)');
    g.fillStyle = rg; g.fillRect(x, y, H, H);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  return t;
}

const BB_VS = `
attribute vec3 iPos; attribute float iSize; attribute float iRot; attribute vec3 iColor; attribute float iAlpha; attribute float iCell;
varying vec2 vUv; varying vec3 vColor; varying float vAlpha;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(iPos, 1.0);
  float c = cos(iRot), s = sin(iRot);
  mvPosition.xy += vec2(position.x * c - position.y * s, position.x * s + position.y * c) * iSize;
  gl_Position = projectionMatrix * mvPosition;
  vUv = (uv + vec2(mod(iCell, 2.0), floor(iCell / 2.0))) * 0.5;
  vColor = iColor; vAlpha = iAlpha;
  #include <fog_vertex>
}`;
const BB_FS = `
uniform sampler2D map;
varying vec2 vUv; varying vec3 vColor; varying float vAlpha;
#include <fog_pars_fragment>
void main() {
  vec4 t = texture2D(map, vUv);
  gl_FragColor = vec4(t.rgb * vColor, t.a * vAlpha);
  if (gl_FragColor.a < 0.004) discard;
  #include <fog_fragment>
}`;
const TR_VS = `
attribute vec3 iA; attribute vec3 iB; attribute float iAlpha; attribute float iWidth;
varying vec2 vUv; varying float vAlpha;
#include <fog_pars_vertex>
void main() {
  vec4 a = modelViewMatrix * vec4(iA, 1.0);
  vec4 b = modelViewMatrix * vec4(iB, 1.0);
  vec4 mvPosition = mix(a, b, position.y);
  vec3 d = b.xyz - a.xyz;
  vec3 side = cross(normalize(d + vec3(1e-5)), normalize(-mvPosition.xyz));
  mvPosition.xyz += normalize(side + vec3(1e-6)) * position.x * iWidth;
  gl_Position = projectionMatrix * mvPosition;
  vUv = vec2(position.x, position.y); vAlpha = iAlpha;
  #include <fog_vertex>
}`;
const TR_FS = `
uniform vec3 core; uniform vec3 glow;
varying vec2 vUv; varying float vAlpha;
#include <fog_pars_fragment>
void main() {
  float across = 1.0 - abs(vUv.x);
  float along = smoothstep(0.0, 0.85, vUv.y);
  vec3 col = mix(glow, core, smoothstep(0.55, 0.95, across));
  gl_FragColor = vec4(col, across * across * along * vAlpha);
  #include <fog_fragment>
}`;
const SP_VS = `
attribute float aAlpha; varying float vAlpha; uniform float scale;
#include <fog_pars_vertex>
void main() { vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition; gl_PointSize = scale * 0.035 / max(0.05, -mvPosition.z); vAlpha = aAlpha;
  #include <fog_vertex>
}`;
const SP_FS = `
varying float vAlpha; uniform vec3 color;
#include <fog_pars_fragment>
void main() { vec2 c = gl_PointCoord - 0.5; float r = 1.0 - smoothstep(0.2, 0.5, length(c)); gl_FragColor = vec4(color, r * vAlpha); if (gl_FragColor.a < 0.01) discard;
  #include <fog_fragment>
}`;

interface Billboard { x: number; y: number; z: number; vx: number; vy: number; vz: number; size: number; grow: number; rot: number; spin: number; r: number; g: number; b: number; a0: number; life: number; age: number; cell: number; drag: number; rise: number }

class BillboardPool {
  readonly mesh: THREE.Mesh;
  private geo = new THREE.InstancedBufferGeometry();
  private items: Billboard[] = [];
  private pos: Float32Array; private size: Float32Array; private rot: Float32Array; private col: Float32Array; private alpha: Float32Array; private cell: Float32Array;
  constructor(readonly max: number, tex: THREE.Texture, additive: boolean) {
    const base = new THREE.PlaneGeometry(1, 1);
    this.geo.index = base.index;
    this.geo.setAttribute('position', base.getAttribute('position'));
    this.geo.setAttribute('uv', base.getAttribute('uv'));
    const mk = (n: number) => new THREE.InstancedBufferAttribute(new Float32Array(max * n), n).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iPos', mk(3)); this.geo.setAttribute('iSize', mk(1)); this.geo.setAttribute('iRot', mk(1));
    this.geo.setAttribute('iColor', mk(3)); this.geo.setAttribute('iAlpha', mk(1)); this.geo.setAttribute('iCell', mk(1));
    this.pos = (this.geo.getAttribute('iPos') as THREE.InstancedBufferAttribute).array as Float32Array;
    this.size = (this.geo.getAttribute('iSize') as THREE.InstancedBufferAttribute).array as Float32Array;
    this.rot = (this.geo.getAttribute('iRot') as THREE.InstancedBufferAttribute).array as Float32Array;
    this.col = (this.geo.getAttribute('iColor') as THREE.InstancedBufferAttribute).array as Float32Array;
    this.alpha = (this.geo.getAttribute('iAlpha') as THREE.InstancedBufferAttribute).array as Float32Array;
    this.cell = (this.geo.getAttribute('iCell') as THREE.InstancedBufferAttribute).array as Float32Array;
    this.geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: null } }]),
      vertexShader: BB_VS, fragmentShader: BB_FS, transparent: true, depthWrite: false, fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    mat.uniforms.map.value = tex;
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 12 : 11;
    this.mesh.name = 'vtp:raid:fx';
  }
  add(b: Partial<Billboard> & { x: number; y: number; z: number }) {
    if (this.items.length >= this.max) this.items.shift();
    this.items.push({ vx: 0, vy: 0, vz: 0, size: 0.3, grow: 0, rot: 0, spin: 0, r: 1, g: 1, b: 1, a0: 1, life: 0.1, age: 0, cell: 0, drag: 0, rise: 0, ...b });
  }
  update(dt: number) {
    let n = 0;
    const keep: Billboard[] = [];
    for (const b of this.items) {
      b.age += dt;
      if (b.age >= b.life) continue;
      keep.push(b);
      const k = Math.exp(-b.drag * dt);
      b.vx *= k; b.vy = b.vy * k + b.rise * dt; b.vz *= k;
      b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
      b.size += b.grow * dt; b.rot += b.spin * dt;
      const u = b.age / b.life;
      this.pos[n * 3] = b.x; this.pos[n * 3 + 1] = b.y; this.pos[n * 3 + 2] = b.z;
      this.size[n] = b.size; this.rot[n] = b.rot; this.cell[n] = b.cell;
      this.col[n * 3] = b.r; this.col[n * 3 + 1] = b.g; this.col[n * 3 + 2] = b.b;
      this.alpha[n] = b.a0 * (b.cell === 0 ? 1 - u : Math.min(1, u * 6) * (1 - u) * (1 - u));
      n++;
    }
    this.items = keep;
    this.geo.instanceCount = n;
    for (const a of ['iPos', 'iSize', 'iRot', 'iColor', 'iAlpha', 'iCell']) { const at = this.geo.getAttribute(a) as THREE.InstancedBufferAttribute; at.needsUpdate = true; }
    this.mesh.visible = n > 0;
  }
  clear() { this.items = []; this.geo.instanceCount = 0; this.mesh.visible = false; }
  get count() { return this.items.length; }
}

interface Tracer { ax: number; ay: number; az: number; bx: number; by: number; bz: number; len: number; head: number; speed: number; streak: number; w: number }

class TracerPool {
  readonly mesh: THREE.Mesh;
  private geo = new THREE.InstancedBufferGeometry();
  private items: Tracer[] = [];
  private A: Float32Array; private B: Float32Array; private al: Float32Array; private wd: Float32Array;
  constructor(readonly max = 64) {
    const base = new THREE.BufferGeometry();
    base.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
    base.setIndex([0, 1, 2, 0, 2, 3]);
    this.geo.index = base.index;
    this.geo.setAttribute('position', base.getAttribute('position'));
    const mk = (n: number) => new THREE.InstancedBufferAttribute(new Float32Array(max * n), n).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iA', mk(3)); this.geo.setAttribute('iB', mk(3)); this.geo.setAttribute('iAlpha', mk(1)); this.geo.setAttribute('iWidth', mk(1));
    this.A = (this.geo.getAttribute('iA') as THREE.InstancedBufferAttribute).array as Float32Array;
    this.B = (this.geo.getAttribute('iB') as THREE.InstancedBufferAttribute).array as Float32Array;
    this.al = (this.geo.getAttribute('iAlpha') as THREE.InstancedBufferAttribute).array as Float32Array;
    this.wd = (this.geo.getAttribute('iWidth') as THREE.InstancedBufferAttribute).array as Float32Array;
    this.geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { core: { value: new THREE.Color('#fff6d0') }, glow: { value: new THREE.Color('#ff9a2a') } }]),
      vertexShader: TR_VS, fragmentShader: TR_FS, transparent: true, depthWrite: false, fog: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 13;
    this.mesh.name = 'vtp:raid:tracers';
  }
  add(a: THREE.Vector3, b: THREE.Vector3, w = 0.022, speed = 140) {
    if (this.items.length >= this.max) this.items.shift();
    const len = a.distanceTo(b);
    this.items.push({ ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, len, head: 0, speed, streak: Math.min(4.5, 1.2 + len * 0.3), w });
  }
  update(dt: number) {
    let n = 0;
    const keep: Tracer[] = [];
    for (const t of this.items) {
      t.head += t.speed * dt;
      const tail = t.head - t.streak;
      if (tail >= t.len) continue;
      keep.push(t);
      const h = Math.min(t.len, t.head) / t.len, tl = Math.max(0, tail) / t.len;
      this.A[n * 3] = t.ax + (t.bx - t.ax) * tl; this.A[n * 3 + 1] = t.ay + (t.by - t.ay) * tl; this.A[n * 3 + 2] = t.az + (t.bz - t.az) * tl;
      this.B[n * 3] = t.ax + (t.bx - t.ax) * h; this.B[n * 3 + 1] = t.ay + (t.by - t.ay) * h; this.B[n * 3 + 2] = t.az + (t.bz - t.az) * h;
      this.al[n] = 1; this.wd[n] = t.w;
      n++;
    }
    this.items = keep;
    this.geo.instanceCount = n;
    for (const a of ['iA', 'iB', 'iAlpha', 'iWidth']) (this.geo.getAttribute(a) as THREE.InstancedBufferAttribute).needsUpdate = true;
    this.mesh.visible = n > 0;
  }
  clear() { this.items = []; this.geo.instanceCount = 0; this.mesh.visible = false; }
  get count() { return this.items.length; }
}

class SparkPool {
  readonly points: THREE.Points;
  private pos: Float32Array; private al: Float32Array;
  private v: Float32Array; private life: Float32Array; private age: Float32Array;
  private n = 0;
  constructor(readonly max = 256) {
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3); this.al = new Float32Array(max);
    this.v = new Float32Array(max * 3); this.life = new Float32Array(max); this.age = new Float32Array(max);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.al, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { scale: { value: 800 }, color: { value: new THREE.Color('#ffcf6a') } }]),
      vertexShader: SP_VS, fragmentShader: SP_FS, transparent: true, depthWrite: false, fog: true, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 13;
    this.points.name = 'vtp:raid:sparks';
  }
  burst(p: THREE.Vector3, n: THREVector, count: number, seed: number, speed = 3.2) {
    let s = seed >>> 0 || 1;
    const r = () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9 >>> 0) / 4294967296);
    for (let k = 0; k < count; k++) {
      if (this.n >= this.max) break;
      const i = this.n++;
      this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
      const sp = speed * (0.4 + r());
      this.v[i * 3] = (n.x + (r() - 0.5) * 1.6) * sp; this.v[i * 3 + 1] = (n.y + r() * 0.9) * sp; this.v[i * 3 + 2] = (n.z + (r() - 0.5) * 1.6) * sp;
      this.life[i] = 0.18 + r() * 0.28; this.age[i] = 0; this.al[i] = 1;
    }
  }
  update(dt: number, scale: number) {
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) continue;
      this.v[i * 3 + 1] -= 9.8 * dt;
      for (let c = 0; c < 3; c++) { this.pos[w * 3 + c] = this.pos[i * 3 + c] + this.v[i * 3 + c] * dt; this.v[w * 3 + c] = this.v[i * 3 + c]; }
      this.life[w] = this.life[i]; this.age[w] = this.age[i]; this.al[w] = 1 - this.age[i] / this.life[i];
      w++;
    }
    this.n = w;
    const g = this.points.geometry;
    g.setDrawRange(0, w);
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
    (this.points.material as THREE.ShaderMaterial).uniforms.scale.value = scale;
    this.points.visible = w > 0;
  }
  clear() { this.n = 0; this.points.visible = false; }
  get count() { return this.n; }
}
type THREVector = { x: number; y: number; z: number };

class DecalPool {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private z = new THREE.Vector3(0, 0, 1);
  constructor(readonly max: number, tex: THREE.Texture, cellIndex: number, opacity = 1) {
    const g = new THREE.PlaneGeometry(1, 1);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) + (cellIndex % 2)) * 0.5, (uv.getY(i) + Math.floor(cellIndex / 2)) * 0.5);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, side: THREE.DoubleSide, toneMapped: false });
    this.mesh = new THREE.InstancedMesh(g, mat, max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.name = 'vtp:raid:decals';
  }
  add(p: THREE.Vector3, n: THREE.Vector3, size: number, spin: number) {
    const i = this.n % this.max;
    this.q.setFromUnitVectors(this.z, n).multiply(new THREE.Quaternion().setFromAxisAngle(this.z, spin));
    this.m.compose(p.clone().addScaledVector(n, 0.004), this.q, new THREE.Vector3(size, size, size));
    this.mesh.setMatrixAt(i, this.m);
    this.n++;
    this.mesh.count = Math.min(this.n, this.max);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  clear() { this.n = 0; this.mesh.count = 0; }
  get count() { return Math.min(this.n, this.max); }
}

/** Blob shadows under the NPCs (one instanced draw). */
class ShadowPool {
  readonly mesh: THREE.InstancedMesh;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  constructor(max = 12) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32); rg.addColorStop(0, 'rgba(0,0,0,0.55)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2 }), max);
    this.mesh.count = 0; this.mesh.frustumCulled = false; this.mesh.renderOrder = 9; this.mesh.name = 'vtp:raid:shadows';
  }
  set(list: { x: number; y: number; z: number; r: number; o: number }[]) {
    let n = 0;
    for (const s of list) {
      if (n >= this.mesh.instanceMatrix.count || s.o < 0.05) continue;
      this.m.compose(new THREE.Vector3(s.x, s.y + 0.012, s.z), this.q, new THREE.Vector3(s.r * 2, s.r * 2, 1));
      this.mesh.setMatrixAt(n++, this.m);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = n > 0;
  }
}

export class RaidFx {
  readonly group = new THREE.Group();
  readonly tex = spriteAtlas();
  readonly flashes = new BillboardPool(48, this.tex, true);
  readonly puffs = new BillboardPool(160, this.tex, false);
  readonly tracers = new TracerPool(64);
  readonly sparks = new SparkPool(320);
  readonly holes = new DecalPool(80, this.tex, 3, 0.9);
  readonly cracks = new DecalPool(32, this.tex, 2, 0.85);
  readonly shadows = new ShadowPool(12);
  /** 0 = full, 1 = reduced, 2 = minimal (perf governor). */
  level = 0;
  constructor() {
    this.group.name = 'vtp:raid:fx';
    this.group.add(this.shadows.mesh, this.holes.mesh, this.cracks.mesh, this.puffs.mesh, this.tracers.mesh, this.flashes.mesh, this.sparks.points);
  }
  /** photosensitivity: with the flash limit on, one muzzle flash per spot every 360 ms (a burst still reads, slower) */
  private flashGate = new SpotFlashGate();
  muzzle(p: THREE.Vector3, dir: THREE.Vector3, scale: number, seed: number) {
    const r = (seed % 997) / 997;
    if (this.flashGate.allow(p.x, p.y, p.z, performance.now())) this.flashes.add({ x: p.x + dir.x * 0.06, y: p.y + dir.y * 0.06, z: p.z + dir.z * 0.06, size: (0.3 + r * 0.16) * scale, rot: r * 6.28, life: 0.07, cell: 0, a0: 1 });
    if (this.level < 2) this.puffs.add({ x: p.x + dir.x * 0.15, y: p.y, z: p.z + dir.z * 0.15, vx: dir.x * 0.8, vy: 0.2, vz: dir.z * 0.8, size: 0.14 * scale, grow: 0.5 * scale, life: 0.6, cell: 1, a0: 0.28, r: 0.8, g: 0.8, b: 0.8, drag: 2, rise: 0.3 });
  }
  tracer(a: THREE.Vector3, b: THREE.Vector3, scale: number) { this.tracers.add(a, b, 0.03 * Math.max(0.8, scale), 85); }
  impact(p: THREE.Vector3, n: THREE.Vector3, kind: 'wall' | 'glass' | 'body' | 'floor', seed: number, scale: number) {
    const r = (seed % 991) / 991;
    if (kind === 'body') {
      this.puffs.add({ x: p.x, y: p.y, z: p.z, vx: n.x * 0.6, vy: 0.3, vz: n.z * 0.6, size: 0.1 * scale, grow: 0.35 * scale, life: 0.4, cell: 1, a0: 0.55, r: 0.55, g: 0.12, b: 0.1, drag: 3 });
      return;
    }
    if (kind === 'glass') {
      this.cracks.add(p, n, (0.22 + r * 0.16) * scale, r * 6.28);
      if (this.level < 2) this.sparks.burst(p, { x: -n.x * 0.5, y: 0.2, z: -n.z * 0.5 }, 8, seed, 1.6);
      return;
    }
    if (this.level < 2) this.sparks.burst(p, n, kind === 'floor' ? 5 : 9, seed, 2.6);
    this.puffs.add({ x: p.x + n.x * 0.05, y: p.y + n.y * 0.05, z: p.z + n.z * 0.05, vx: n.x * 0.9, vy: n.y * 0.9 + 0.2, vz: n.z * 0.9, size: 0.08 * scale, grow: 0.55 * scale, life: 0.7, cell: 1, a0: 0.5, r: 0.72, g: 0.66, b: 0.58, drag: 3.2, rise: 0.1 });
    if (this.level < 1 || r < 0.5) this.holes.add(p, n, (0.05 + r * 0.03) * scale, r * 6.28);
  }
  /** Red alarm light (big-donation interrupt): a soft red bloom + a hot core. */
  alarm(p: THREE.Vector3, size: number) {
    this.flashes.add({ x: p.x, y: p.y, z: p.z, size: 2.6 * size, grow: 1.5 * size, life: 0.55, cell: 0, a0: 0.55, r: 1, g: 0.08, b: 0.04 });
    this.flashes.add({ x: p.x, y: p.y, z: p.z, size: 0.7 * size, life: 0.3, cell: 0, a0: 0.9, r: 1, g: 0.25, b: 0.15 });
  }
  /** Explosion / hammer hit: a ring of dust + debris sparks (+ a flash for explosions). */
  burst(p: THREE.Vector3, size: number, seed: number, flash: boolean) {
    let s = seed >>> 0 || 7;
    const r = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
    if (flash) this.flashes.add({ x: p.x, y: p.y + 0.3 * size, z: p.z, size: 1.4 * size, life: 0.12, cell: 0, a0: 1, rot: r() * 6 });
    const n = this.level >= 2 ? 8 : 18;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + r() * 0.3;
      const sp = (1.2 + r() * 1.6) * size;
      const grey = 0.55 + r() * 0.2;
      this.puffs.add({ x: p.x, y: p.y + 0.1, z: p.z, vx: Math.cos(a) * sp, vy: 0.4 + r() * 1.2 * size, vz: Math.sin(a) * sp, size: 0.25 * size, grow: 1.1 * size, life: 1.2 + r() * 0.8, cell: 1, a0: 0.55, r: grey, g: grey * 0.95, b: grey * 0.88, drag: 2.4, rise: 0.25, rot: r() * 6, spin: (r() - 0.5) });
    }
    this.sparks.burst(p, { x: 0, y: 1, z: 0 }, this.level >= 2 ? 10 : 30, seed, 4 * size);
  }
  update(dt: number, cam: THREE.PerspectiveCamera, viewportH: number) {
    this.flashes.update(dt); this.puffs.update(dt); this.tracers.update(dt);
    this.sparks.update(dt, viewportH / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)));
  }
  clearTransient() { this.flashes.clear(); this.puffs.clear(); this.tracers.clear(); this.sparks.clear(); }
  clearDecals() { this.holes.clear(); this.cracks.clear(); }
  counts() { return { flashes: this.flashes.count, puffs: this.puffs.count, tracers: this.tracers.count, sparks: this.sparks.count, holes: this.holes.count, cracks: this.cracks.count }; }
  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh || (o as THREE.Points).isPoints) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
    this.tex.dispose();
  }
}
