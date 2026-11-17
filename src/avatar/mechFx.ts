// Walking machine FX (SPEC.md §2.3.6): one pooled particle batch (48 soft sprites, ONE draw call) in room space — a dust
// ring at every footfall, exhaust puffs at the mexhaust_* anchors on the stand-up and on every second plant. It reads the
// MechRig's events, so it works in any room and on every page (the events come from the same distance-phased gait).
// Never shakes a camera, never makes a sound. Purely cosmetic: the randomness is hashed from the event number.
import * as THREE from 'three';
import type { MechEvent, MechRig } from './mech.ts';

const N = 48;
const hash = (n: number) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

interface P { alive: boolean; age: number; life: number; pos: THREE.Vector3; vel: THREE.Vector3; size0: number; size1: number; alpha: number; color: THREE.Color; drag: number }

export class MechFx {
  readonly points: THREE.Points;
  private ps: P[] = [];
  private geo = new THREE.BufferGeometry();
  private aPos = new Float32Array(N * 3);
  private aSize = new Float32Array(N);
  private aAlpha = new Float32Array(N);
  private aColor = new Float32Array(N * 3);
  private lastSeq = 0;
  private plants = 0;
  private next = 0;
  private host: THREE.Object3D | null = null;
  private readonly dust = new THREE.Color(0.72, 0.64, 0.5);
  private readonly smoke = new THREE.Color(0.42, 0.42, 0.44);

  constructor(private rig: MechRig) {
    for (let i = 0; i < N; i++) this.ps.push({ alive: false, age: 0, life: 1, pos: new THREE.Vector3(), vel: new THREE.Vector3(), size0: 0, size1: 0, alpha: 0, color: new THREE.Color(), drag: 1 });
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.aPos, 3));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.aSize, 1));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.aAlpha, 1));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.aColor, 3));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 700 } },
      vertexShader: `attribute float aSize; attribute float aAlpha; attribute vec3 aColor; uniform float uScale; varying float vA; varying vec3 vC;
        void main() { vA = aAlpha; vC = aColor; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = aSize * uScale / max(0.05, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying float vA; varying vec3 vC;
        void main() { vec2 d = gl_PointCoord - 0.5; float r = dot(d, d) * 4.0; float a = vA * smoothstep(1.0, 0.0, r); if (a < 0.004) discard; gl_FragColor = vec4(vC, a); }`,
      transparent: true, depthWrite: false,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.name = 'vtp:mech-fx';
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.lastSeq = rig.events.length ? rig.events[rig.events.length - 1].seq : 0;
  }

  private spawn(pos: THREE.Vector3, vel: THREE.Vector3, life: number, size0: number, size1: number, alpha: number, color: THREE.Color, drag: number) {
    const p = this.ps[this.next];
    this.next = (this.next + 1) % N;
    p.alive = true; p.age = 0; p.life = life; p.pos.copy(pos); p.vel.copy(vel); p.size0 = size0; p.size1 = size1; p.alpha = alpha; p.color.copy(color); p.drag = drag;
  }

  private onEvent(e: MechEvent, scale: number) {
    const L = this.rig.L * scale;
    if (e.kind === 'plant' && e.pos) {
      this.plants++;
      const c = new THREE.Vector3(...e.pos);
      const n = e.settle ? 3 : 5;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + hash(e.seq * 7 + k) * 0.8;
        const v = new THREE.Vector3(Math.cos(a), 0.15 + 0.2 * hash(e.seq + k), Math.sin(a)).multiplyScalar(L * (0.5 + 0.4 * hash(e.seq * 3 + k)));
        this.spawn(c.clone().addScaledVector(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), 0.05 * L), v, 0.7 + 0.3 * hash(e.seq + k * 5), 0.08 * L, 0.3 * L, e.settle ? 0.25 : 0.38, this.dust, 3.5);
      }
      if (this.plants % 2 === 0) this.puff(e.seq, 1, L);
    } else if (e.kind === 'spool') this.puff(e.seq, 3, L);
  }

  private puff(seed: number, n: number, L: number) {
    for (const [j, o] of this.rig.exhaust.entries()) {
      const at = o.getWorldPosition(new THREE.Vector3());
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion()));
      for (let k = 0; k < n; k++) {
        const h = hash(seed * 13 + j * 5 + k);
        this.spawn(at, up.clone().multiplyScalar(L * (0.35 + 0.25 * h)).add(new THREE.Vector3((h - 0.5) * 0.2 * L, 0, (hash(seed + k) - 0.5) * 0.2 * L)), 1.1 + 0.4 * h, 0.06 * L, 0.32 * L, 0.32, this.smoke, 1.2);
      }
    }
  }

  update(dt: number) {
    // live in the room (the scene root above the avatar): dust stays where the foot fell while the walker moves on
    let top: THREE.Object3D = this.rig.legs[0]?.tipParent ?? this.points;
    for (let o: THREE.Object3D | null = top; o; o = o.parent) top = o;
    if (top !== this.host && top !== this.points) { this.points.removeFromParent(); top.add(this.points); this.host = top; }
    const scale = this.rig.legs[0]?.tipParent.getWorldScale(new THREE.Vector3()).x ?? 1;
    for (const e of this.rig.events) if (e.seq > this.lastSeq) { this.onEvent(e, scale); this.lastSeq = e.seq; }
    let any = false;
    for (let i = 0; i < N; i++) {
      const p = this.ps[i];
      if (p.alive) {
        p.age += dt;
        if (p.age >= p.life) p.alive = false;
        else { p.pos.addScaledVector(p.vel, dt); p.vel.multiplyScalar(Math.exp(-p.drag * dt)); }
      }
      const k = p.alive ? p.age / p.life : 1;
      this.aPos.set([p.pos.x, p.pos.y, p.pos.z], i * 3);
      this.aSize[i] = p.alive ? p.size0 + (p.size1 - p.size0) * Math.sqrt(k) : 0;
      this.aAlpha[i] = p.alive ? p.alpha * (1 - k) * Math.min(1, k * 8) : 0;
      this.aColor.set([p.color.r, p.color.g, p.color.b], i * 3);
      if (p.alive) any = true;
    }
    for (const n of ['position', 'aSize', 'aAlpha', 'aColor']) (this.geo.getAttribute(n) as THREE.BufferAttribute).needsUpdate = true;
    this.points.visible = any;
  }

  /** Live particles (tests). */
  get alive() { return this.ps.filter((p) => p.alive).length; }

  dispose() {
    this.points.removeFromParent();
    this.geo.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
