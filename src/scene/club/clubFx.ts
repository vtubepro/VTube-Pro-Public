// Club effects: confetti cannons, CO2 jets, spark fountains, indoor fireworks, air-horn rings, sliding drinks,
// juggled bottles, the champagne tower, the supporter's sign and chant bubbles. Every particle is a pure function of
// (event seed, age), rebuilt each frame into a handful of InstancedMeshes (no per-particle state → every page shows
// the same burst, a page opened mid-burst shows mid-burst).
import * as THREE from 'three';

// one shared generator, re-seeded per effect (a burst runs every frame: no closure allocated per cannon per frame;
// the same sequence as a fresh generator for that seed)
let rngA = 1;
const rngNext = () => { rngA = (rngA + 0x6d2b79f5) >>> 0; let t = rngA; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const rng = (seed: number) => { rngA = seed >>> 0 || 1; return rngNext; };
const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3(), E = new THREE.Euler(), C = new THREE.Color();
// (confetti scratch: a burst runs every frame for seconds, so nothing is allocated per piece)
const SIDE = new THREE.Vector3(), UP = new THREE.Vector3(), V = new THREE.Vector3(), Y_UP = new THREE.Vector3(0, 1, 0);
const CONFETTI_COLOURS = ['#ff3fd2', '#8dff3a', '#35e3ff', '#ffd84a', '#ffffff'] as const;

function softTex() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

class Pool {
  readonly mesh: THREE.InstancedMesh;
  n = 0;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, readonly max: number, name: string, order = 5) {
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.name = name; this.mesh.frustumCulled = false; this.mesh.renderOrder = order; this.mesh.count = 0;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3).fill(1), 3);
  }
  add(pos: THREE.Vector3, q: THREE.Quaternion, s: THREE.Vector3, col?: THREE.Color) {
    if (this.n >= this.max) return;
    M.compose(pos, q, s); this.mesh.setMatrixAt(this.n, M);
    if (col) this.mesh.setColorAt(this.n, col);
    this.n++;
  }
  begin() { this.n = 0; }
  end() { this.mesh.count = this.n; this.mesh.instanceMatrix.needsUpdate = true; if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true; }
}

export class ClubFx {
  readonly group = new THREE.Group();
  private confetti: Pool; private smoke: Pool; private sparks: Pool; private rings: Pool; private cups: Pool; private bottles: Pool; private glasses: Pool; private streams: Pool;
  private tex = softTex();
  private cam = new THREE.Quaternion();
  private labels = new Map<string, { sprite: THREE.Sprite; used: boolean; w: number }>();
  private disposables: { dispose(): void }[] = [];

  constructor() {
    this.group.name = 'club:fx';
    const add = (p: Pool) => { this.group.add(p.mesh); this.disposables.push(p.mesh.geometry, p.mesh.material as THREE.Material); return p; };
    const conf = new THREE.PlaneGeometry(0.12, 0.075);
    this.confetti = add(new Pool(conf, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false }), 1400, 'club:confetti'));
    this.smoke = add(new Pool(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, opacity: 0.55, color: 0xeef6ff }), 260, 'club:co2', 4));
    this.sparks = add(new Pool(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }), 900, 'club:sparks', 6));
    const rg = new THREE.RingGeometry(0.42, 0.5, 40);
    this.rings = add(new Pool(rg, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }), 24, 'club:rings', 6));
    const cup = new THREE.CylinderGeometry(0.075, 0.058, 0.2, 10); cup.translate(0, 0.1, 0);
    this.cups = add(new Pool(cup, new THREE.MeshToonMaterial({ color: 0xe23a3a }), 12, 'club:cups'));
    const bt = new THREE.LatheGeometry([new THREE.Vector2(0, 0), new THREE.Vector2(0.045, 0), new THREE.Vector2(0.047, 0.16), new THREE.Vector2(0.02, 0.22), new THREE.Vector2(0.018, 0.29), new THREE.Vector2(0, 0.29)], 10);
    bt.translate(0, -0.145, 0); bt.scale(1.6, 1.6, 1.6);
    this.bottles = add(new Pool(bt, new THREE.MeshToonMaterial({ color: 0x2f8a3a }), 8, 'club:bottles'));
    const coupe = new THREE.LatheGeometry([new THREE.Vector2(0.05, 0), new THREE.Vector2(0.012, 0.01), new THREE.Vector2(0.01, 0.1), new THREE.Vector2(0.03, 0.105), new THREE.Vector2(0.075, 0.14), new THREE.Vector2(0.08, 0.15)], 14);
    this.glasses = add(new Pool(coupe, new THREE.MeshStandardMaterial({ color: 0xf6f0d8, metalness: 0.2, roughness: 0.08, transparent: true, opacity: 0.7, emissive: 0x6a5a20, emissiveIntensity: 0.6 }), 64, 'club:tower'));
    const st = new THREE.CylinderGeometry(0.012, 0.018, 1, 6); st.translate(0, -0.5, 0);
    this.streams = add(new Pool(st, new THREE.MeshBasicMaterial({ color: 0xfff0a0, transparent: true, opacity: 0.8, toneMapped: false }), 8, 'club:pour'));
  }

  begin(camera: THREE.Camera) {
    camera.getWorldQuaternion(this.cam);
    const parentQ = this.group.parent ? this.group.parent.getWorldQuaternion(new THREE.Quaternion()).invert() : new THREE.Quaternion();
    this.cam.premultiply(parentQ);
    for (const p of [this.confetti, this.smoke, this.sparks, this.rings, this.cups, this.bottles, this.glasses, this.streams]) p.begin();
    for (const l of this.labels.values()) l.used = false;
  }
  end() {
    for (const p of [this.confetti, this.smoke, this.sparks, this.rings, this.cups, this.bottles, this.glasses, this.streams]) p.end();
    for (const [k, l] of this.labels) if (!l.used) { l.sprite.visible = false; if (this.labels.size > 24) { l.sprite.removeFromParent(); (l.sprite.material as THREE.SpriteMaterial).map?.dispose(); l.sprite.material.dispose(); this.labels.delete(k); } }
  }

  /** a confetti cannon burst: `age` s after firing from `at` towards `dir` (unit), `n` pieces, colours */
  confettiBurst(at: THREE.Vector3, dir: THREE.Vector3, age: number, seed: number, n = 220, colors: readonly string[] = CONFETTI_COLOURS, spread = 0.55, speed = 9) {
    if (age < 0 || age > 7) return;
    const r = rng(seed);
    const side = SIDE.crossVectors(dir, Y_UP).normalize(), up = UP.crossVectors(side, dir).normalize();
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, s = Math.sqrt(r()) * spread;
      const v = V.copy(dir).addScaledVector(side, Math.cos(a) * s).addScaledVector(up, Math.sin(a) * s + 0.25).normalize().multiplyScalar(speed * (0.55 + r() * 0.6));
      // drag: speed decays fast, then the pieces flutter down at ~0.9 m/s
      const k = 1.6, tt = age;
      const dragged = (1 - Math.exp(-k * tt)) / k;
      P.copy(at).addScaledVector(v, dragged);
      P.y -= 0.9 * Math.max(0, tt - 0.4) + 0.5 * Math.min(tt, 0.4) * tt;
      P.x += 0.25 * Math.sin(tt * 3 + i); P.z += 0.25 * Math.cos(tt * 2.3 + i * 1.7);
      if (P.y < 0.02) P.y = 0.02;
      E.set(tt * (3 + r() * 5) + i, tt * (2 + r() * 4), i); Q.setFromEuler(E);
      const fade = age > 6 ? 1 - (age - 6) : 1;
      S.setScalar(fade);
      this.confetti.add(P, Q, S, C.set(colors[i % colors.length]));
    }
  }

  /** a CO2 jet: a white plume shooting up `h` m from `at` then drifting (age s) */
  co2(at: THREE.Vector3, age: number, seed: number, h = 5.5) {
    if (age < 0 || age > 3.2) return;
    const r = rng(seed);
    const on = age < 1.1;
    for (let i = 0; i < 26; i++) {
      const birth = (i / 26) * 1.1;
      const a = age - birth; if (a < 0 || (!on && a > 2.1)) continue;
      const y = Math.min(h, a * 14) * (0.85 + 0.15 * r());
      P.set(at.x + (r() - 0.5) * 0.3 * (1 + a), at.y + y, at.z + (r() - 0.5) * 0.3 * (1 + a));
      const s = (0.35 + a * 1.1) * (1 - Math.max(0, a - 1.4) / 0.8);
      if (s <= 0.02) continue;
      S.setScalar(s); this.smoke.add(P, this.cam, S);
    }
  }

  /** spark fountain (gerb) shooting up `h` m for `dur` s */
  gerb(at: THREE.Vector3, age: number, seed: number, dur = 3, h = 3.2, col = '#ffd27a') {
    if (age < 0 || age > dur + 1.2) return;
    const r = rng(seed);
    C.set(col);
    for (let i = 0; i < 90; i++) {
      const birth = r() * dur; const a = age - birth; if (a < 0 || a > 1.2) continue;
      const vy = Math.sqrt(2 * 9.8 * h) * (0.75 + 0.25 * r()), vx = (r() - 0.5) * 1.6, vz = (r() - 0.5) * 1.6;
      P.set(at.x + vx * a, at.y + vy * a - 4.9 * a * a, at.z + vz * a);
      if (P.y < at.y) continue;
      S.setScalar(0.08 * (1 - a / 1.2) + 0.02); this.sparks.add(P, this.cam, S, C);
    }
  }

  /** an indoor firework: a shell rising from below `at`, bursting there at `age` 0.6 s */
  firework(at: THREE.Vector3, age: number, seed: number, col: string) {
    if (age < 0 || age > 3) return;
    const r = rng(seed);
    C.set(col);
    if (age < 0.6) { P.set(at.x, at.y - 3 * (1 - age / 0.6), at.z); S.setScalar(0.12); this.sparks.add(P, this.cam, S, C); return; }
    const a = age - 0.6;
    for (let i = 0; i < 70; i++) {
      const th = r() * Math.PI * 2, ph = Math.acos(2 * r() - 1), sp = 3.2 + r() * 0.8;
      const d = (1 - Math.exp(-2.2 * a)) / 2.2 * sp;
      P.set(at.x + Math.sin(ph) * Math.cos(th) * d, at.y + Math.cos(ph) * d - 1.2 * a * a, at.z + Math.sin(ph) * Math.sin(th) * d);
      const s = 0.13 * Math.max(0, 1 - a / 2.4) * (0.7 + 0.3 * Math.sin(a * 30 + i));
      if (s > 0.01) { S.setScalar(s); this.sparks.add(P, this.cam, S, C); }
    }
  }

  /** air-horn blast: sound-wave rings flying out of the horn toward `dir` */
  hornRings(at: THREE.Vector3, dir: THREE.Vector3, age: number) {
    if (age < 0 || age > 1.8) return;
    Q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    for (let i = 0; i < 5; i++) {
      const a = age - i * 0.18; if (a < 0 || a > 0.9) continue;
      P.copy(at).addScaledVector(dir, a * 4);
      S.setScalar(0.4 + a * 2.2);
      this.rings.add(P, Q, S, C.setRGB(1, 0.85, 0.3).multiplyScalar(1 - a / 0.9));
    }
  }

  cup(pos: THREE.Vector3) { this.cups.add(pos, Q.identity(), S.setScalar(1)); }
  bottle(pos: THREE.Vector3, spin: number) { E.set(spin, 0, spin * 0.3); Q.setFromEuler(E); this.bottles.add(pos, Q, S.setScalar(1)); }

  /** champagne tower (4 levels, 30 coupes) popping up at `at` + a pouring stream from above */
  tower(at: THREE.Vector3, age: number, dur = 22) {
    if (age < 0 || age > dur) return;
    const pop = Math.min(1, age / 0.5) * (age > dur - 1 ? Math.max(0, dur - age) : 1);
    const sp = 0.17;
    let lvl = 0;
    for (const n of [4, 3, 2, 1]) {
      const y = at.y + lvl * 0.15;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        P.set(at.x + (i - (n - 1) / 2) * sp, y, at.z + (j - (n - 1) / 2) * sp);
        S.setScalar(pop * (1 + 0.05 * Math.sin(age * 8 + i + j))); this.glasses.add(P, Q.identity(), S);
      }
      lvl++;
    }
    if (age > 0.8 && age < dur - 2) {
      P.set(at.x, at.y + 0.95, at.z); S.set(1, 0.34 + 0.02 * Math.sin(age * 20), 1); this.streams.add(P, Q.identity(), S);
      this.bottle(new THREE.Vector3(at.x + 0.02, at.y + 1.08, at.z), 2.4);
      for (let i = 0; i < 12; i++) { const k = ((age * 1.3 + i / 12) % 1); P.set(at.x + Math.sin(i * 2.3) * 0.25, at.y + k * 0.6, at.z + Math.cos(i * 1.7) * 0.25); S.setScalar(0.03); this.sparks.add(P, this.cam, S, C.set('#fff2a8')); }
    }
  }

  /** a text sprite (sign / chant bubble / BWAAAP!), cached by key */
  label(key: string, text: string, pos: THREE.Vector3, height: number, style: { fg?: string; bg?: string; border?: string; font?: string } = {}) {
    let l = this.labels.get(key);
    if (!l) {
      const c = document.createElement('canvas');
      const g = c.getContext('2d')!;
      const font = style.font ?? 'bold 72px Impact, "Arial Black", sans-serif';
      g.font = font; const w = Math.max(80, Math.ceil(g.measureText(text).width + 48));
      c.width = w; c.height = 110;
      g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
      if (style.bg) { g.fillStyle = style.bg; g.beginPath(); (g as CanvasRenderingContext2D & { roundRect?: (...a: number[]) => void }).roundRect?.(4, 4, w - 8, 102, 18); g.fill(); if (style.border) { g.lineWidth = 6; g.strokeStyle = style.border; g.stroke(); } }
      g.lineWidth = 8; g.strokeStyle = '#140a14'; g.strokeText(text, w / 2, 58);
      g.fillStyle = style.fg ?? '#ffffff'; g.fillText(text, w / 2, 58);
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, toneMapped: false }));
      sp.renderOrder = 7; this.group.add(sp);
      l = { sprite: sp, used: false, w: w / 110 };
      this.labels.set(key, l);
    }
    l.used = true; l.sprite.visible = true;
    l.sprite.position.copy(pos); l.sprite.scale.set(height * l.w, height, 1);
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.tex.dispose();
    for (const l of this.labels.values()) { (l.sprite.material as THREE.SpriteMaterial).map?.dispose(); l.sprite.material.dispose(); }
    this.group.removeFromParent();
  }
}
