// Prop FX for costume / accessory pieces, found by NAME at load (no schema change — any GLB can opt in):
//   * materials named *Ember*        smouldering glow: emissiveIntensity flickers (layered noise) and flares on a
//                                    draw (puckered / pressed lips = puffing the cigar)
//   * meshes named *SmokeEmitter*    hidden markers; each emits soft billboard smoke puffs from its (skinned) world
//                                    position. Puffs live in avatar-anchor space, so they trail behind head motion
//                                    and rise / drift on their own. A few dozen instanced quads, one draw call.

import * as THREE from 'three';

const EMBER_RE = /ember/i;
const EMITTER_RE = /smoke_?emitter/i;

/** Hide emitter markers before toon / outlines / fit see them (call right after the accessories attach). */
export function prepPropMarkers(meshes: THREE.Mesh[]) {
  for (const m of meshes) if (EMITTER_RE.test(m.name)) {
    m.visible = false;
    m.userData.vtpNoToon = true;
    m.userData.vtpHidden = true;
    m.userData.vtpSmokeEmitter = true;
  }
}

interface Ember { mat: THREE.MeshStandardMaterial; base: number; seed: number }
interface Puff { p: THREE.Vector3; v: THREE.Vector3; age: number; life: number; size: number; rot: number; spin: number; seed: number }

const MAX_PUFFS = 64;

export class PropFx {
  private embers: Ember[] = [];
  private emitters: THREE.Mesh[] = [];
  private t = 0;
  private draw = 0;
  private exhale = 0;
  private spawnAcc = 0;
  private puffs: Puff[] = [];
  private mesh: THREE.Mesh | null = null;
  private aP: THREE.InstancedBufferAttribute | null = null;
  private aA: THREE.InstancedBufferAttribute | null = null;
  private last = new Map<THREE.Mesh, THREE.Vector3>();

  /** null when the model carries no prop FX (the common case: zero cost). */
  static create(model: THREE.Object3D, anchor: THREE.Object3D, scale: number): PropFx | null {
    const fx = new PropFx(anchor, scale);
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (m.userData.vtpSmokeEmitter) { fx.emitters.push(m); return; }
      for (const mat of ([] as THREE.Material[]).concat(m.material)) {
        const sm = mat as THREE.MeshStandardMaterial;
        if (sm && EMBER_RE.test(sm.name) && sm.emissive && !fx.embers.some((e) => e.mat === sm)) {
          if (sm.emissive.getHex() === 0) sm.emissive.setRGB(1, 0.35, 0.08);
          fx.embers.push({ mat: sm, base: sm.emissiveIntensity || 1, seed: Math.random() * 100 });
        }
      }
    });
    if (!fx.embers.length && !fx.emitters.length) return null;
    if (fx.emitters.length) fx.buildSmoke();
    return fx;
  }

  private constructor(private anchor: THREE.Object3D, private scale: number) {}

  private buildSmoke() {
    const quad = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.setIndex(quad.index);
    g.setAttribute('position', quad.attributes.position);
    g.setAttribute('uv', quad.attributes.uv);
    this.aP = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PUFFS * 4), 4); // xyz (anchor space), size
    this.aA = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PUFFS * 4), 4); // alpha, rotation, seed, age01
    this.aP.setUsage(THREE.DynamicDrawUsage); this.aA.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aP', this.aP); g.setAttribute('aA', this.aA);
    g.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      name: 'vtp-smoke',
      transparent: true, depthWrite: false,
      uniforms: { uColor: { value: new THREE.Color(0.8, 0.81, 0.85) } },
      vertexShader: /* glsl */`
        attribute vec4 aP; attribute vec4 aA;
        varying vec2 vUv; varying vec4 vA;
        void main() {
          vUv = uv; vA = aA;
          vec4 mv = modelViewMatrix * vec4(aP.xyz, 1.0);
          float c = cos(aA.y), s = sin(aA.y);
          mv.xy += mat2(c, s, -s, c) * position.xy * aP.w;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; varying vec2 vUv; varying vec4 vA;
        float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
        void main() {
          vec2 q = vUv - 0.5; float r = length(q) * 2.0;
          // wispy: two octaves of value noise, drifting with the puff's age
          vec2 w = q * 3.0 + vec2(vA.z, vA.w * 1.7);
          float n = n2(w) * 0.65 + n2(w * 2.3 + 7.1) * 0.35;
          float a = smoothstep(1.0, 0.25, r + (n - 0.5) * 0.7) * vA.x;
          if (a < 0.004) discard;
          gl_FragColor = vec4(uColor * (0.85 + 0.25 * n), a);
        }`,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = 'vtp_smoke';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 15;
    this.anchor.add(this.mesh);
  }

  /** draw: 0..1 how hard he is pulling on it (pucker / pressed lips); open: mouth open 0..1 (exhale). */
  update(dt: number, draw: number, open: number) {
    dt = Math.min(dt, 0.1);
    this.t += dt;
    const k = draw > this.draw ? 1 - Math.exp(-6 * dt) : 1 - Math.exp(-1.5 * dt);
    this.draw += (THREE.MathUtils.clamp(draw, 0, 1) - this.draw) * k;
    // a draw followed by an open mouth = a puff of smoke
    this.exhale = Math.max(this.exhale - dt * 0.8, Math.min(1, this.draw * 1.5) * THREE.MathUtils.clamp(open * 2, 0, 1));
    for (const e of this.embers) {
      const t = this.t + e.seed;
      const flick = 0.72 + 0.14 * Math.sin(t * 2.1) + 0.09 * Math.sin(t * 5.3 + 1.3) + 0.05 * Math.sin(t * 13.7 + 0.4);
      e.mat.emissiveIntensity = e.base * flick * (1 + 1.4 * this.draw);
    }
    if (this.mesh) this.updateSmoke(dt);
  }

  private updateSmoke(dt: number) {
    const S = this.scale;
    const v = new THREE.Vector3();
    for (const em of this.emitters) {
      em.updateWorldMatrix(true, false);
      const sm = em as THREE.SkinnedMesh;
      if (sm.isSkinnedMesh) sm.getVertexPosition(0, v); else v.fromBufferAttribute(em.geometry.attributes.position, 0);
      v.applyMatrix4(em.matrixWorld);
      this.anchor.worldToLocal(v);
      const prev = this.last.get(em) ?? v.clone();
      // steady wisps + extra puffs when exhaling; spawn along the path the ember moved this frame (no gaps)
      this.spawnAcc += dt * (5 + 16 * this.exhale);
      while (this.spawnAcc >= 1) {
        this.spawnAcc -= 1;
        if (this.puffs.length >= MAX_PUFFS) this.puffs.shift();
        const f = Math.random();
        const puff: Puff = {
          p: prev.clone().lerp(v, f),
          v: new THREE.Vector3((Math.random() - 0.5) * 0.012, 0.018 + Math.random() * 0.012, (Math.random() - 0.5) * 0.012).multiplyScalar(S),
          age: 0, life: 2.2 + Math.random() * 1.4, size: (0.006 + Math.random() * 0.004) * S,
          rot: Math.random() * Math.PI * 2, spin: (Math.random() - 0.5) * 0.8, seed: Math.random() * 50,
        };
        if (this.exhale > 0.3) puff.v.add(new THREE.Vector3(0, -0.004, 0.03).multiplyScalar(S * this.exhale)); // blown forward
        this.puffs.push(puff);
      }
      this.last.set(em, v.clone());
    }
    const P = this.aP!.array as Float32Array, A = this.aA!.array as Float32Array;
    let n = 0;
    this.puffs = this.puffs.filter((p) => (p.age += dt) < p.life);
    for (const p of this.puffs) {
      const u = p.age / p.life;
      // buoyancy + drag + a lazy curl so the column wavers like real smoke
      p.v.y += 0.02 * S * dt;
      p.v.multiplyScalar(Math.exp(-0.9 * dt));
      p.v.x += Math.sin(this.t * 1.3 + p.seed) * 0.006 * S * dt;
      p.v.z += Math.cos(this.t * 1.1 + p.seed * 1.7) * 0.006 * S * dt;
      p.p.addScaledVector(p.v, dt);
      p.rot += p.spin * dt;
      const size = p.size + 0.05 * S * Math.pow(u, 0.8);
      const alpha = Math.min(1, p.age / 0.3) * Math.pow(1 - u, 1.5) * 0.38;
      P[n * 4] = p.p.x; P[n * 4 + 1] = p.p.y; P[n * 4 + 2] = p.p.z; P[n * 4 + 3] = size;
      A[n * 4] = alpha; A[n * 4 + 1] = p.rot; A[n * 4 + 2] = p.seed; A[n * 4 + 3] = u;
      n++;
    }
    (this.mesh!.geometry as THREE.InstancedBufferGeometry).instanceCount = n;
    this.aP!.needsUpdate = true; this.aA!.needsUpdate = true;
  }

  dispose() {
    for (const e of this.embers) e.mat.emissiveIntensity = e.base;
    if (this.mesh) {
      this.mesh.removeFromParent();
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
      this.mesh = null;
    }
    this.puffs = [];
  }
}
