// The Trail v2 — weather you can see on the journey: rain streaks (rain), a downpour + lightning flashes (storm),
// flurries (cold), a warm haze (hot). One draw call; particles live in a box around the camera (no allocations).
import * as THREE from 'three';

const N = 1400, BOX = 36, HGT = 22;
export class WeatherFx {
  readonly obj: THREE.LineSegments;
  private pos: Float32Array;
  private vel: Float32Array;
  private mat: THREE.LineBasicMaterial;
  kind = 'clear';
  /** 0..1 lightning flash (the world adds it to its lights). */
  flash = 0;
  private nextBolt = 5;
  private active = 0;

  constructor() {
    this.pos = new Float32Array(N * 6);
    this.vel = new Float32Array(N);
    for (let i = 0; i < N; i++) this.reset(i, Math.random() * HGT);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.mat = new THREE.LineBasicMaterial({ color: '#cfe0ff', transparent: true, opacity: 0.5, depthWrite: false, fog: true });
    this.obj = new THREE.LineSegments(g, this.mat);
    this.obj.frustumCulled = false;
    this.obj.visible = false;
    this.obj.renderOrder = 4;
  }
  private reset(i: number, y = HGT) {
    const x = (Math.random() - 0.5) * BOX, z = (Math.random() - 0.5) * BOX;
    this.pos.set([x, y, z, x, y + 0.5, z], i * 6);
    this.vel[i] = 0.8 + Math.random() * 0.4;
  }
  set(kind: string) {
    if (kind === this.kind) return;
    this.kind = kind;
    const rain = kind === 'rain' || kind === 'storm', snow = kind === 'cold';
    this.active = kind === 'storm' ? N : kind === 'rain' ? Math.floor(N * 0.55) : snow ? Math.floor(N * 0.4) : 0;
    this.obj.visible = this.active > 0;
    this.obj.geometry.setDrawRange(0, this.active * 2);
    this.mat.color.set(snow ? '#ffffff' : '#cfe0ff');
    this.mat.opacity = snow ? 0.8 : kind === 'storm' ? 0.55 : 0.4;
    void rain;
  }
  /** Follow the camera (local space); rain falls fast + slants with the wind, snow drifts. */
  update(dt: number, cam: THREE.Vector3, onBolt?: () => void) {
    this.flash = Math.max(0, this.flash - dt * 3);
    if (this.kind === 'storm') { this.nextBolt -= dt; if (this.nextBolt <= 0) { this.nextBolt = 6 + Math.random() * 12; this.flash = 1; onBolt?.(); } }
    if (!this.active) return;
    this.obj.position.set(Math.floor(cam.x / 4) * 4, Math.floor(cam.y / 4) * 4 - HGT / 2, Math.floor(cam.z / 4) * 4);
    const snow = this.kind === 'cold';
    const vy = snow ? 1.4 : this.kind === 'storm' ? 26 : 18, wind = snow ? 0.4 : this.kind === 'storm' ? 5 : 2;
    const len = snow ? 0.06 : this.kind === 'storm' ? 0.9 : 0.6;
    const p = this.pos, t = performance.now() / 1000;
    for (let i = 0; i < this.active; i++) {
      const o = i * 6;
      let y = p[o + 1] - vy * this.vel[i] * dt;
      if (y < 0) { this.reset(i); continue; }
      const sx = snow ? Math.sin(t * 1.3 + i) * 0.3 * dt : wind * dt * 0.3;
      p[o] += sx; p[o + 2] += snow ? Math.cos(t + i * 1.7) * 0.3 * dt : 0;
      p[o + 1] = y; p[o + 3] = p[o] - wind * 0.03; p[o + 4] = y + len; p[o + 5] = p[o + 2];
    }
    (this.obj.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
  dispose() { this.obj.geometry.dispose(); this.mat.dispose(); this.obj.removeFromParent(); }
}
