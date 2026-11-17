// Lounge events — the effects. Every particle / prop is a pure function of (piece start, seed, time): no state, the same
// on every page, a page opened mid-celebration shows mid-celebration. Built on the existing engines:
//   · SpaceFx (src/scene/space/fx.ts) at room scale: firepit flames + embers + smoke, sparklers, glints on the bottle
//     wall, clink sparkles, slide streaks (3 draws). Its face uniforms hide sprites behind performers' faces.
//   · YachtSky (src/scene/yacht/yachtSky.ts) for the night fireworks show (the yacht's peonies, rings, crossettes,
//     chrysanthemums and gold willows; its own SpaceFx, 3 draws) + our daytime shells / train rockets on the same fx.
//   · YachtRoomFx (src/scene/yacht/yachtFx.ts) for the champagne pop (flash, cork, foam, sparkles, confetti).
//   · own instanced pools: confetti (1 draw), balloons + their strings (2), rocks / shot glasses + their drinks (2), a
//     champagne bottle (1, only while popping).
// Never in front of the show: points inside a performer's head box (nearer than the face), inside the React screen, in
// keep-out spheres or within 0.9 m of the lens are skipped (CPU), and SpaceFx sprites fade out behind faces (GPU).
import * as THREE from 'three';
import { SpaceFx, SPRITE } from '../space/fx.ts';
import { YachtSky, type SkyView } from '../yacht/yachtSky.ts';
import { YachtRoomFx } from '../yacht/yachtFx.ts';
import type { YachtItem } from '../../../shared/yacht.ts';
import { loungeRand as rnd, type LoungePiece } from '../../../shared/lounge.ts';
import type { YachtRoom } from '../yacht/yachtRoom.ts';

const smooth = (x: number) => { const k = Math.min(1, Math.max(0, x)); return k * k * (3 - 2 * k); };
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3(), vD = new THREE.Vector3(), vE = new THREE.Vector3(), vP = new THREE.Vector3();
const qA = new THREE.Quaternion(), eA = new THREE.Euler(), sA = new THREE.Vector3(), mA = new THREE.Matrix4(), cA = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
const G = 9.8;

const CONFETTI = ['#ffd36a', '#fff4dc', '#f0a820', '#ff7aa8', '#ffffff', '#6fe3d6', '#c9a0ff'].map((c) => new THREE.Color(c));
const BALLOONS = ['#e8c06a', '#f3d9b0', '#ff8fb1', '#fdf6ee', '#7fd8d0', '#d9b26a', '#c0a8ff'].map((c) => new THREE.Color(c));
const DRINKS = ['#d98a1c', '#e8435a', '#f2c84b', '#5fd1c8', '#b05ad8', '#f08a2c'].map((c) => new THREE.Color(c));
const SHOT = new THREE.Color('#e3a23a');
/** night sky palettes (rgb × intensity) for the train rockets */
const PAL: [number, number, number][] = [[1.0, 0.62, 0.18], [1.0, 0.15, 0.2], [0.15, 1.0, 0.4], [0.65, 0.25, 1.0], [0.2, 0.55, 1.0], [1.0, 0.3, 0.7], [0.95, 0.95, 1.0]];
/** daytime smoke shells */
const SMOKE: [number, number, number][] = [[1.0, 0.18, 0.38], [0.15, 0.45, 1.0], [1.0, 0.78, 0.08], [0.55, 0.2, 1.0], [0.1, 0.9, 0.5], [1.0, 0.42, 0.08]];

class Pool {
  readonly mesh: THREE.InstancedMesh;
  n = 0;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, readonly max: number, name: string, order = 5) {
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.name = name; this.mesh.frustumCulled = false; this.mesh.renderOrder = order; this.mesh.count = 0;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3).fill(1), 3);
  }
  add(p: THREE.Vector3, q: THREE.Quaternion, s: THREE.Vector3, c?: THREE.Color) {
    if (this.n >= this.max) return;
    mA.compose(p, q, s); this.mesh.setMatrixAt(this.n, mA);
    if (c) this.mesh.setColorAt(this.n, c);
    this.n++;
  }
  begin() { this.n = 0; }
  end() {
    this.mesh.count = this.n; this.mesh.visible = this.n > 0;
    if (this.n) { this.mesh.instanceMatrix.needsUpdate = true; if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true; }
  }
  dispose() { this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); this.mesh.removeFromParent(); }
}

function rocksGlass() {
  const pts = [[0, 0.004], [0.036, 0], [0.042, 0.006], [0.046, 0.088], [0.043, 0.088], [0.039, 0.012], [0, 0.014]].map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(pts, 18);
}
function champagneBottle() {
  const g = new THREE.Group(); g.name = 'lounge:bottle';
  const glass = new THREE.LatheGeometry([[0, 0], [0.043, 0], [0.045, 0.012], [0.045, 0.2], [0.04, 0.235], [0.018, 0.28], [0.015, 0.33], [0, 0.33]].map(([x, y]) => new THREE.Vector2(x, y)), 20);
  const foil = new THREE.LatheGeometry([[0.0185, 0.27], [0.0165, 0.345], [0, 0.35]].map(([x, y]) => new THREE.Vector2(x, y)), 14);
  const label = new THREE.CylinderGeometry(0.0458, 0.0458, 0.075, 20, 1, true); label.translate(0, 0.12, 0);
  g.add(new THREE.Mesh(glass, new THREE.MeshStandardMaterial({ color: 0x0f2a18, roughness: 0.12, metalness: 0.2 })));
  g.add(new THREE.Mesh(foil, new THREE.MeshStandardMaterial({ color: 0xd9b25a, roughness: 0.3, metalness: 0.9 })));
  g.add(new THREE.Mesh(label, new THREE.MeshStandardMaterial({ color: 0xf2e6c8, roughness: 0.6 })));
  g.visible = false;
  return g;
}

export interface FxRect { x0: number; y0: number; x1: number; y1: number; d: number }

export class LoungeFx {
  readonly group = new THREE.Group();
  readonly fx: SpaceFx;
  readonly sky: YachtSky;
  readonly champ: YachtRoomFx;
  readonly bottle = champagneBottle();
  private confetti: Pool; private balloons: Pool; private glasses: Pool; private liquid: Pool;
  private strings: THREE.LineSegments; private nStr = 0;
  /** screen boxes to keep clear (0…1, y down) + the distance of what they protect (Infinity = the React screen) */
  rects: FxRect[] = [];
  keepouts: { pos: THREE.Vector3; r: number }[] = [];
  /** light pools wanted this frame (the scene hands them to the environment) */
  pools: { p: THREE.Vector3; r: number; c: THREE.Color }[] = [];
  private cam: THREE.PerspectiveCamera | null = null;
  /** 0 = full, 1 = half the particles (governor) */
  level = 0;
  counts = { confetti: 0, balloons: 0, glasses: 0, sprites: 0, sky: 0 };

  constructor() {
    this.group.name = 'vtp:lounge:fx';
    this.fx = new SpaceFx({ sprites: 2600, smoke: 260, streaks: 900 }, false);
    this.fx.uniforms.uMinPx.value = 0;
    (this.fx.uniforms as unknown as { uFaceDim: { value: number } }).uFaceDim.value = 0;
    this.sky = new YachtSky({} as YachtRoom);
    (this.sky.fx.uniforms as unknown as { uFaceDim: { value: number } }).uFaceDim.value = 0.15;
    this.champ = new YachtRoomFx();
    const conf = new THREE.PlaneGeometry(0.065, 0.04);
    this.confetti = new Pool(conf, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.35, metalness: 0.55, emissive: 0x332a18 }), 2400, 'lounge:confetti');
    const bal = new THREE.SphereGeometry(0.15, 20, 14); bal.scale(1, 1.17, 1);
    const knot = new THREE.ConeGeometry(0.022, 0.035, 8); knot.translate(0, -0.185, 0); knot.rotateX(Math.PI);
    const merged = mergeGeoms([bal, knot]);
    this.balloons = new Pool(merged, new THREE.MeshStandardMaterial({ roughness: 0.22, metalness: 0.35 }), 120, 'lounge:balloons');
    this.glasses = new Pool(rocksGlass(), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.04, metalness: 0.1, transparent: true, opacity: 0.38, depthWrite: false }), 96, 'lounge:glasses', 6);
    const liq = new THREE.CylinderGeometry(0.038, 0.035, 1, 14); liq.translate(0, 0.5, 0);
    this.liquid = new Pool(liq, new THREE.MeshStandardMaterial({ roughness: 0.15, transparent: true, opacity: 0.88, emissive: 0x2a1500 }), 96, 'lounge:drinks', 5);
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(120 * 2 * 3), 3));
    this.strings = new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: 0xd8d2c8, transparent: true, opacity: 0.7 }));
    this.strings.frustumCulled = false; this.strings.name = 'lounge:strings';
    this.group.add(this.fx.group, this.sky.group, this.champ.group, this.bottle, this.confetti.mesh, this.balloons.mesh, this.glasses.mesh, this.liquid.mesh, this.strings);
  }

  load(alive: () => boolean) { return this.champ.load(alive); }

  begin(t: number, cam: THREE.PerspectiveCamera) {
    this.cam = cam;
    this.fx.begin(t); this.sky.begin(t); this.champ.begin(t);
    for (const p of [this.confetti, this.balloons, this.glasses, this.liquid]) p.begin();
    this.nStr = 0; this.pools.length = 0;
    this.bottle.visible = false;
  }
  end(cam: THREE.PerspectiveCamera, H: number) {
    this.fx.uniforms.uPx.value = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / Math.max(1, H);
    this.fx.end(); this.sky.end(0, cam, H); this.champ.end(cam, H);
    this.champ.rects = this.rects;
    for (const p of [this.confetti, this.balloons, this.glasses, this.liquid]) p.end();
    const pos = this.strings.geometry.getAttribute('position') as THREE.BufferAttribute;
    this.strings.geometry.setDrawRange(0, this.nStr * 2); pos.needsUpdate = this.nStr > 0; this.strings.visible = this.nStr > 0;
    const c = this.fx.counts(), s = this.sky.fx.counts();
    this.counts = { confetti: this.confetti.n, balloons: this.balloons.n, glasses: this.glasses.n, sprites: c.sprites + c.smoke + c.streaks, sky: s.sprites + s.smoke + s.streaks };
  }

  /** a point that must not be drawn (a face, the React screen, a keep-out, the lens) */
  blocked(p: THREE.Vector3) {
    const cam = this.cam;
    if (!cam) return false;
    const d = p.distanceTo(cam.position);
    if (d < 0.9) return true;
    for (const k of this.keepouts) if (p.distanceTo(k.pos) < k.r) return true;
    if (!this.rects.length) return false;
    vP.copy(p).project(cam);
    if (vP.z > 1) return false;
    const x = (vP.x + 1) / 2, y = (1 - vP.y) / 2;
    for (const r of this.rects) if (x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1 && d < r.d + 0.35) return true;
    return false;
  }

  // ------------------------------------------------------------------------------------------ bar
  /** drinks slide down the counter A → B (a train: one every 0.42 s, lining up from the far end in rows) */
  slide(p: LoungePiece, u: number, seed: number, A: THREE.Vector3, B: THREE.Vector3, side: THREE.Vector3) {
    const L = A.distanceTo(B);
    if (L < 0.5) return;
    const dir = vA.copy(B).sub(A).normalize();
    const train = p.n > 3;
    const perRow = Math.max(3, Math.floor((L * 0.7) / 0.13));
    for (let i = 0; i < p.n; i++) {
      const t0 = i * (train ? 0.42 : 0.65);
      const a = u - t0;
      if (a < 0) continue;
      const T = 1.35 + 0.35 * rnd(seed, i, 1);
      const row = Math.floor(i / perRow), slot = i % perRow;
      const dEnd = train ? 0.18 + slot * 0.13 + (row % 2) * 0.065 : 0.25 + rnd(seed, i, 2) * L * 0.25;
      const lat = train ? row * 0.11 : (rnd(seed, i, 3) - 0.5) * 0.16;
      const k = 1 - (1 - clamp01(a / T)) ** 2;
      const travel = (L - dEnd) * k;
      vB.copy(A).addScaledVector(dir, travel).addScaledVector(side, lat);
      const out = p.dur - u;
      const sc = smooth(a / 0.18) * smooth(out / 0.5);
      if (sc <= 0.01 || this.blocked(vB)) continue;
      const moving = a < T;
      const wob = moving ? Math.sin(a * 22 + i) * 0.06 * (1 - k) : 0;
      eA.set(wob * dir.z, rnd(seed, i, 4) * 6.28, -wob * dir.x); qA.setFromEuler(eA);
      const gs = sc * 1.15;
      this.glasses.add(vB, qA, sA.setScalar(gs));
      this.liquid.add(vB, qA, sA.set(gs, gs * 0.055, gs), DRINKS[(i + (seed % 6)) % DRINKS.length]);
      // a highlight on the rim so the glass reads from a wide shot
      this.fx.sprite(vD.copy(vB).setY(vB.y + 0.1 * gs).addScaledVector(side, 0.03), 0.012, 0.9 * sc, 0.85 * sc, 0.75 * sc, 1, SPRITE.spark, i * 0.5);
      if (moving && k < 0.97) {
        // a faint streak of light off the glass as it skids
        vC.copy(vB).addScaledVector(dir, -0.35 * (1 - k)).setY(vB.y + 0.045);
        vD.copy(vB).setY(vB.y + 0.045);
        this.fx.line(vC, vD, 0.006, 0, 0.9, 0.85, 0.7, 0.35 * (1 - k));
      }
      // the clack as it stops: a little glint
      if (a > T && a < T + 0.25) this.fx.sprite(vD.copy(vB).setY(vB.y + 0.09), 0.035, 1.6, 1.4, 1.0, 1 - (a - T) / 0.25, SPRITE.spark, i * 0.3);
    }
  }

  /** a round of shots: lined up, poured, lifted for a "cheers", downed, set back empty */
  shots(p: LoungePiece, u: number, seed: number, slots: THREE.Vector3[], cheersAt: number) {
    const n = Math.min(p.n, 16);
    for (let i = 0; i < n; i++) {
      const s = slots[i % slots.length];
      if (!s) continue;
      const a = u - i * 0.12;
      if (a < 0) continue;
      const row = Math.floor(i / slots.length);
      vB.copy(s).addScaledVector(UP, 0).add(vC.set(0, 0, row * 0.09));
      const lift = smooth((u - cheersAt) / 0.45) * (1 - smooth((u - cheersAt - 1.2) / 0.4));
      vB.y += lift * 0.22;
      const sc = smooth(a / 0.15) * (1 + 0.15 * Math.sin(Math.min(a, 0.3) * 20) * (1 - clamp01(a / 0.3))) * smooth((p.dur - u) / 0.5) * 0.72;
      if (sc <= 0.01 || this.blocked(vB)) continue;
      eA.set(lift * 0.25 * Math.sin(i * 1.7), 0, lift * 0.25 * Math.cos(i * 1.3)); qA.setFromEuler(eA);
      this.glasses.add(vB, qA, sA.set(sc, sc * 0.85, sc));
      const fill = clamp01((a - 0.2) / 0.35) * (1 - smooth((u - cheersAt - 0.9) / 0.2));
      if (fill > 0.02) this.liquid.add(vB, qA, sA.set(sc, sc * 0.06 * fill, sc), SHOT);
      // the clink: sparkles over the raised glasses
      const c = u - cheersAt - 0.5;
      if (c > 0 && c < 0.6) { vD.copy(vB).setY(vB.y + 0.12); this.fx.sprite(vD, 0.05 + c * 0.1, 1.8 * (1 - c / 0.6), 1.6 * (1 - c / 0.6), 1.1 * (1 - c / 0.6), 1, SPRITE.spark, i * 0.7); }
    }
  }

  /** the bottle wall lights up: a chase of glints sweeping across + the EMIT_bottle* glow (the scene pulses that) */
  bottles(p: LoungePiece, u: number, seed: number, W: { pos: THREE.Vector3; fwd: THREE.Vector3; w: number; h: number }): number {
    const env = smooth(u / 0.6) * smooth((p.dur - u) / 1.2);
    if (env <= 0) return 0;
    const right = vA.crossVectors(UP, W.fwd).normalize();
    const speed = p.big >= 2 ? 0.55 : 0.4;
    const ph = (u * speed) % 2, xb = (ph < 1 ? ph : 2 - ph) * W.w - W.w / 2;          // the band (ping-pong)
    const cols = Math.max(6, Math.round(W.w / 0.28)), rows = Math.max(3, Math.round(W.h / 0.42));
    const step = this.level ? 2 : 1;
    for (let c = 0; c < cols; c += step) for (let r = 0; r < rows; r++) {
      const x = (c / (cols - 1) - 0.5) * W.w, y = (r / (rows - 1) - 0.5) * W.h * 0.85;
      const k = Math.exp(-(((x - xb) / 0.55) ** 2)) * (0.6 + 0.4 * rnd(seed, c * 31 + r, Math.floor(u * 10)));
      if (k < 0.08) continue;
      vB.copy(W.pos).addScaledVector(right, x).addScaledVector(UP, y).addScaledVector(W.fwd, 0.06);
      if (p.big >= 2) cA.setHSL(((x / W.w + 0.5) + u * 0.12) % 1, 0.85, 0.6); else cA.setRGB(1.0, 0.72, 0.32);
      const I = k * env * 1.3;
      this.fx.sprite(vB, 0.035 + 0.03 * k, cA.r * I, cA.g * I, cA.b * I, 1, SPRITE.glow, (c + r) * 0.13);
      if (k > 0.7 && (c + r + Math.floor(u * 8)) % 5 === 0) this.fx.sprite(vB, 0.04, 2 * env, 1.8 * env, 1.4 * env, 1, SPRITE.spark, c * 0.37);
    }
    // a wide soft wash on the band
    vB.copy(W.pos).addScaledVector(right, xb).addScaledVector(W.fwd, 0.12);
    this.fx.sprite(vB, W.h * 0.3, 0.16 * env, 0.1 * env, 0.05 * env, 1, SPRITE.glow);
    return env * (p.big >= 2 ? 1.6 : 1);
  }

  // ------------------------------------------------------------------------------------------ sparklers (gerbs)
  sparklers(p: LoungePiece, u: number, seed: number, pts: THREE.Vector3[]) {
    const n = Math.min(pts.length, Math.max(1, p.n));
    const h = 0.9 * p.big + 0.4;
    for (let j = 0; j < n; j++) {
      const at = pts[j % pts.length];
      const a = u - j * 0.25;
      if (a < 0 || a > p.dur + 1.2) continue;
      const on = a < p.dur;
      const env = smooth(a / 0.3) * (on ? 1 : 0);
      if (env > 0 && !this.blocked(at)) this.fx.sprite(vB.copy(at).setY(at.y + 0.05), 0.12, 2.2 * env, 1.6 * env, 0.8 * env, 1, SPRITE.glow, j);
      const N = this.level ? 40 : 80;
      for (let i = 0; i < N; i++) {
        const birth = rnd(seed, j * 977 + i, 1) * p.dur;
        const b = a - birth;
        if (b < 0 || b > 1.1) continue;
        const vy = Math.sqrt(2 * G * h) * (0.7 + 0.3 * rnd(seed, i, 2)), vx = (rnd(seed, i, 3) - 0.5) * 1.5, vz = (rnd(seed, i, 4) - 0.5) * 1.5;
        vB.set(at.x + vx * b, at.y + vy * b - 0.5 * G * b * b, at.z + vz * b);
        if (vB.y < at.y - 0.05 || this.blocked(vB)) continue;
        const f = 1 - b / 1.1;
        const tb = Math.max(0, b - 0.05);
        vC.set(at.x + vx * tb, at.y + vy * tb - 0.5 * G * tb * tb, at.z + vz * tb);
        this.fx.line(vC, vB, 0.004, 0.6, 1.8 * f, 1.3 * f, 0.6 * f, 0.9);
        if (i % 3 === 0) this.fx.sprite(vB, 0.018 + 0.012 * f, 2.0 * f, 1.7 * f, 1.0 * f, 1, SPRITE.spark, i * 0.21);
      }
    }
  }

  // ------------------------------------------------------------------------------------------ patio: the firepit flares up
  flare(p: LoungePiece, u: number, seed: number, F: { pos: THREE.Vector3; r: number }, wind: THREE.Vector3) {
    if (u < 0 || u > p.dur + 2) return;
    const I = smooth(u / 0.25) * (1 - smooth((u - p.dur + 1.6) / 1.6));
    const H = F.r * (2.2 + 2.6 * p.big) * (0.35 + 0.65 * I);
    const N = this.level ? 34 : 64;
    // the whoosh: a bright ring + a puff of flame at the start
    if (u < 0.5) {
      const k = u / 0.5;
      this.fx.sprite(vB.copy(F.pos).setY(F.pos.y + 0.2), F.r * (1 + k * 2.4), 1.8 * (1 - k), 0.9 * (1 - k), 0.3 * (1 - k), 1, SPRITE.ring, 0.2);
      this.fx.sprite(vB.copy(F.pos).setY(F.pos.y + 0.4 + k * H * 0.5), F.r * (1.2 + k), 2.4 * (1 - k), 1.4 * (1 - k), 0.5 * (1 - k), 1, SPRITE.flare, 0.4);
    }
    if (I > 0.01) {
      // the flame column: fire sprites rising + shrinking, hot at the base
      for (let i = 0; i < N; i++) {
        const ph = ((u * (1.4 + rnd(seed, i, 1) * 0.8) + rnd(seed, i, 2)) % 1);
        const ang = rnd(seed, i, 3) * Math.PI * 2, rr = F.r * 0.65 * Math.sqrt(rnd(seed, i, 4)) * (1 - ph * 0.6);
        vB.set(F.pos.x + Math.cos(ang) * rr + wind.x * ph * H * 0.35 + Math.sin(u * 7 + i) * 0.05 * ph, F.pos.y + 0.05 + ph * H, F.pos.z + Math.sin(ang) * rr + wind.z * ph * H * 0.35);
        if (this.blocked(vB)) continue;
        const s = F.r * (0.55 - 0.35 * ph) * (0.7 + 0.5 * I);
        const heat = 1 - ph;
        this.fx.sprite(vB, s, (1.6 + heat) * I, (0.55 + heat * 0.9) * I, (0.12 + heat * 0.35) * I, 1 - ph * ph, SPRITE.fire, rnd(seed, i, 5));
      }
      // the hot core + the glow on everything around
      this.fx.sprite(vB.copy(F.pos).setY(F.pos.y + H * 0.25), F.r * 1.4, 1.3 * I, 0.55 * I, 0.15 * I, 1, SPRITE.glow);
      this.pools.push({ p: F.pos.clone().setY(F.pos.y + 0.7), r: 4 + 5 * p.big * I, c: new THREE.Color(1.5 * I, 0.62 * I, 0.2 * I) });
    }
    // embers: spiralling up past the flames, drifting with the wind
    const E = Math.round((this.level ? 50 : 110) * Math.min(1.6, p.big));
    for (let i = 0; i < E; i++) {
      const birth = rnd(seed, i, 7) * Math.max(0.5, p.dur - 0.5);
      const b = u - birth;
      const life = 2.2 + rnd(seed, i, 8) * 1.6;
      if (b < 0 || b > life) continue;
      const vy = 1.6 + 2.2 * rnd(seed, i, 9) * p.big, sw = rnd(seed, i, 10) * 6.28;
      vB.set(F.pos.x + Math.cos(sw + b * 3) * 0.25 * b + wind.x * b * 0.6, F.pos.y + 0.2 + vy * b - 0.18 * b * b, F.pos.z + Math.sin(sw + b * 3) * 0.25 * b + wind.z * b * 0.6);
      if (this.blocked(vB)) continue;
      const f = (1 - b / life) * (0.6 + 0.4 * Math.sin(b * 17 + i));
      this.fx.sprite(vB, 0.012 + 0.01 * f, 2.2 * f, 0.9 * f, 0.25 * f, 1, SPRITE.spark, i * 0.17);
    }
    // smoke above it
    for (let i = 0; i < 10; i++) {
      const b = ((u * 0.35 + i / 10) % 1);
      if (u < 0.3 + i * 0.1) continue;
      vB.set(F.pos.x + wind.x * b * 2.2, F.pos.y + H * 0.8 + b * 2.6, F.pos.z + wind.z * b * 2.2);
      if (this.blocked(vB)) continue;
      this.fx.puff(vB, 0.25 + b * 0.8, 0.22, 0.2, 0.19, 0.22 * (1 - b) * I, i * 0.31);
    }
  }

  // ------------------------------------------------------------------------------------------ the sky
  /** the yacht's night show in a lounge sky volume, or daytime smoke shells with salute flashes */
  fireworks(p: LoungePiece, u: number, seed: number, V: SkyView, night: number) {
    if (u < 0 || u > 16) return;
    if (night > 0.35) this.sky.fireworks({ id: '', kind: 'fireworks', start: 0, end: 0, seed, user: '', n: 0 } as YachtItem, u, V);
    if (night < 0.6) this.dayShells(Math.max(6, p.n), u, seed, V, 1 - night);
  }
  private dayShells(N: number, u: number, seed: number, V: SkyView, day: number) {
    const fx = this.sky.fx, S = V.size;
    for (let i = 0; i < N; i++) {
      const ti = 0.6 + (i * 9) / N + rnd(seed, i, 1) * 0.5;
      const tau = u - ti;
      if (tau < -1 || tau > 6) continue;
      vB.copy(V.C).addScaledVector(V.D, V.d + (rnd(seed, i, 2) - 0.5) * S * 0.4).addScaledVector(V.R, (rnd(seed, i, 3) - 0.5) * S * 1.1).addScaledVector(V.U, (rnd(seed, i, 4) - 0.3) * S * 0.45);
      if (tau < 0) {
        const k = 1 + tau;
        vC.copy(vB).addScaledVector(V.U, -S * 0.7 * (1 - k * k));
        vD.copy(vC).addScaledVector(V.U, -S * 0.08);
        fx.line(vD, vC, S * 0.003, 1.2, 0.9, 0.75, 0.55, 0.5 * day);
        fx.puff(vD, S * 0.012, 0.85, 0.85, 0.85, 0.35 * day, i);
        continue;
      }
      const col = SMOKE[(seed + i) % SMOKE.length];
      // the salute: a white flash (the "sky flash"), a ring, then a coloured smoke chrysanthemum drifting
      if (tau < 0.2) fx.sprite(vB, S * 0.14, 2.4 * day, 2.3 * day, 2.0 * day, 1 - tau / 0.2, SPRITE.flare, i * 0.3);
      if (tau < 0.5) fx.sprite(vB, S * (0.05 + tau * 0.35), 1.2 * day, 1.2 * day, 1.1 * day, 1 - tau / 0.5, SPRITE.ring, i);
      const P = 26;
      for (let k = 0; k < P; k++) {
        const y = 1 - (2 * (k + 0.5)) / P, rr = Math.sqrt(1 - y * y), a = k * 2.39996 + i;
        vE.copy(V.R).multiplyScalar(Math.cos(a) * rr).addScaledVector(V.U, y).addScaledVector(V.D, Math.sin(a) * rr);
        const R = S * 0.2 * (1 - Math.exp(-tau * 2.4));
        vC.copy(vB).addScaledVector(vE, R).addScaledVector(V.U, -tau * tau * S * 0.006);
        const f = 1 - tau / 6;
        const c2 = k % 5 === 0 ? SMOKE[(seed + i + 2) % SMOKE.length] : col;
        fx.puff(vC, S * (0.026 + tau * 0.014), c2[0], c2[1], c2[2], 0.85 * f * day, k * 0.1 + i);
        if (tau < 0.6) fx.sprite(vC, S * 0.01, 1.6 * day, 1.5 * day, 1.2 * day, 1 - tau / 0.6, SPRITE.spark, k);
      }
    }
  }
  /** the patio gift train: one rocket per gift, launched from the deck, a small burst each */
  rockets(p: LoungePiece, u: number, seed: number, V: SkyView, from: THREE.Vector3[], night: number) {
    const fx = this.sky.fx, S = V.size;
    for (let i = 0; i < p.n; i++) {
      const t0 = i * 0.42, a = u - t0;
      if (a < 0 || a > 4.4) continue;
      const B = vB.copy(V.C).addScaledVector(V.D, V.d + (rnd(seed, i, 1) - 0.5) * S * 0.3).addScaledVector(V.R, ((i % 9) / 8 - 0.5) * S * 1.2).addScaledVector(V.U, (rnd(seed, i, 2) - 0.2) * S * 0.35);
      if (a < 1.0) {
        const o = from.length ? from[i % from.length] : vC.copy(B).addScaledVector(V.U, -S);
        const k = a / 1.0, e = 1 - (1 - k) * (1 - k);
        vC.copy(o).lerp(B, e); vD.copy(o).lerp(B, Math.max(0, e - 0.06));
        fx.line(vD, vC, S * 0.002, 1.3, 1.6, 1.1, 0.5, 0.9);
        fx.sprite(vC, S * 0.006, 2, 1.5, 0.8, 1, SPRITE.spark, i);
        continue;
      }
      const tau = a - 1.0;
      const c = PAL[(seed + i) % PAL.length];
      const day = 1 - night;
      if (tau < 0.18) fx.sprite(B, S * 0.06, 2.2, 2.1, 1.9, 1 - tau / 0.18, SPRITE.flare, i * 0.2);
      const fade = clamp01(1 - tau / 2.6);
      for (let k = 0; k < 28; k++) {
        const y = 1 - (2 * (k + 0.5)) / 28, rr = Math.sqrt(1 - y * y), ang = k * 2.39996 + i;
        vE.copy(V.R).multiplyScalar(Math.cos(ang) * rr).addScaledVector(V.U, y).addScaledVector(V.D, Math.sin(ang) * rr);
        const R = S * 0.14 * (1 - Math.exp(-tau * 3));
        vC.copy(B).addScaledVector(vE, R).addScaledVector(V.U, -tau * tau * S * 0.01);
        if (night > 0.3) { fx.sprite(vC, S * 0.012, c[0] * 2 * fade * night, c[1] * 2 * fade * night, c[2] * 2 * fade * night, 1, SPRITE.glow, k); if (tau > 0.1) fx.line(vD.copy(B).addScaledVector(vE, R * 0.55), vC, S * 0.0025, 1.1, c[0] * 1.2 * fade * night, c[1] * 1.2 * fade * night, c[2] * 1.2 * fade * night, 0.8); }
        if (day > 0.3 && k % 2 === 0) fx.puff(vC, S * (0.012 + tau * 0.008), SMOKE[(seed + i) % SMOKE.length][0], SMOKE[(seed + i) % SMOKE.length][1], SMOKE[(seed + i) % SMOKE.length][2], 0.5 * fade * day, k);
      }
    }
  }

  // ------------------------------------------------------------------------------------------ main lounge
  /** confetti released from the ceiling points: a puff out, a flutter down, a while on the floor */
  confettiDrop(p: LoungePiece, u: number, seed: number, pts: { pos: THREE.Vector3; fwd: THREE.Vector3 }[], floor: number) {
    const per = Math.round((this.level ? 90 : 180) * p.big);
    const n = Math.min(pts.length, Math.max(1, p.n));
    for (let j = 0; j < n; j++) {
      const P0 = pts[j % pts.length].pos;
      const a0 = u - j * 0.35;
      if (a0 < 0) continue;
      for (let i = 0; i < per; i++) {
        const a = a0 - rnd(seed, j * 7919 + i, 1) * 0.25;
        if (a < 0) continue;
        const ang = rnd(seed, j * 7919 + i, 2) * Math.PI * 2, sp = 0.6 + 2.4 * rnd(seed, j * 7919 + i, 3);
        const tau = 0.35, vt = 0.55 + 0.4 * rnd(seed, i, 4);
        const e = 1 - Math.exp(-a / tau);
        const vx = Math.cos(ang) * sp, vz = Math.sin(ang) * sp, vy = 0.8 * rnd(seed, i, 5);
        vB.set(P0.x + vx * tau * e + Math.sin(a * 2.2 + i) * 0.18 * smooth(a), P0.y + (vy + vt) * tau * e - vt * a, P0.z + vz * tau * e + Math.cos(a * 1.9 + i * 1.3) * 0.18 * smooth(a));
        const landed = vB.y <= floor + 0.006;
        if (landed) vB.y = floor + 0.004 + (i % 7) * 0.0005;
        const out = smooth((p.dur - u) / 1.5);
        if (out <= 0.01 || this.blocked(vB)) continue;
        if (landed) eA.set(-Math.PI / 2, 0, i * 1.37);
        else eA.set(a * (3 + (i % 5)) + i, a * (2 + (i % 3)), i * 0.7);
        qA.setFromEuler(eA);
        this.confetti.add(vB, qA, sA.setScalar(out * (0.8 + 0.4 * rnd(seed, i, 6))), CONFETTI[(i + j) % CONFETTI.length]);
      }
    }
  }

  /** the balloon drop: released from the net box over ~2 s (a train: one per gift), float down, bounce, drift, pop */
  balloonDrop(p: LoungePiece, u: number, seed: number, net: { pos: THREE.Vector3; rx: number; rz: number }, floor: number, right: THREE.Vector3, fwd: THREE.Vector3) {
    const n = Math.min(p.n, 120);
    const train = p.n > 0 && p.dur > 20;
    for (let i = 0; i < n; i++) {
      const rel = train ? i * 0.42 : rnd(seed, i, 1) * 2.2;
      const a = u - rel;
      if (a < 0) continue;
      const sc = 0.85 + 0.35 * rnd(seed, i, 2), R = 0.15 * sc;
      const ox = (rnd(seed, i, 3) * 2 - 1) * net.rx, oz = (rnd(seed, i, 4) * 2 - 1) * net.rz;
      const vt = 0.5 + 0.25 * rnd(seed, i, 5);
      const y0 = net.pos.y - 0.2, fall = Math.max(0, y0 - (floor + R * 1.2));
      const tLand = fall / vt + 0.4;
      let y: number, drift: number;
      if (a < tLand) { y = y0 - vt * Math.max(0, a - 0.4) - 0.5 * Math.min(a, 0.4) * vt * Math.min(a, 0.4) / 0.4; drift = 0; }
      else { const b = a - tLand; y = floor + R * 1.2 + Math.abs(Math.sin(b * 4.5)) * 0.25 * Math.exp(-b * 1.8); drift = 0.35 * (1 - Math.exp(-b * 0.6)); }
      const sway = Math.sin(a * 1.3 + i) * 0.12 * smooth(a);
      const dx = (rnd(seed, i, 6) - 0.5) * 2 * drift, dz = (rnd(seed, i, 7) - 0.5) * 2 * drift;
      vB.copy(net.pos).addScaledVector(right, ox + sway + dx).addScaledVector(fwd, oz + dz); vB.y = y;
      // pop at the end (one by one), or when it would cover a face / the screen
      const popAt = p.dur - 2.6 + rnd(seed, i, 8) * 2.2 - rel;
      const pa = a - popAt;
      if (pa > 0.12) continue;
      if (this.blocked(vB)) continue;
      if (pa > 0) {
        this.fx.sprite(vB, 0.12 + pa * 2, 1.6, 1.4, 1.1, 1 - pa / 0.12, SPRITE.ring, i);
        for (let k = 0; k < 6; k++) this.fx.sprite(vC.copy(vB).add(vD.set(Math.cos(k + i) * pa * 3, Math.sin(k * 2.1) * pa * 3, Math.sin(k + i) * pa * 3)), 0.02, 1.6, 1.4, 1.0, 1, SPRITE.spark, k);
        continue;
      }
      eA.set(Math.sin(a * 1.1 + i) * 0.18, rnd(seed, i, 9) * 6.28, Math.cos(a * 0.9 + i) * 0.18); qA.setFromEuler(eA);
      this.balloons.add(vB, qA, sA.setScalar(sc), BALLOONS[(i + seed) % BALLOONS.length]);
      // the string: from the knot, trailing up while it falls, down once it rests
      if (this.nStr < 120) {
        const pos = this.strings.geometry.getAttribute('position') as THREE.BufferAttribute;
        vC.set(0, -0.2 * sc, 0).applyQuaternion(qA).add(vB);
        const hang = a < tLand ? 0.35 : -0.42;
        vD.copy(vC).add(vE.set(Math.sin(a * 2 + i) * 0.06, hang * (a < tLand ? 1 : 0.6) - (a < tLand ? 0 : 0.0), Math.cos(a * 1.7 + i) * 0.06));
        if (vD.y < floor) vD.y = floor + 0.002;
        pos.setXYZ(this.nStr * 2, vC.x, vC.y, vC.z); pos.setXYZ(this.nStr * 2 + 1, vD.x, vD.y, vD.z);
        this.nStr++;
      }
    }
  }

  /** champagne (the yacht's pop) at `at`, the cork flying away from `from` */
  champagne(p: LoungePiece, u: number, seed: number, at: THREE.Vector3, from: THREE.Vector3, t: number) {
    if (u < 0 || u > 7.2 || !this.cam) return;
    const away = vA.set(at.x - from.x, 0, at.z - from.z);
    if (away.lengthSq() < 1e-4) away.set(1, 0, 0);
    away.normalize();
    this.champ.champagne({ id: '', kind: 'champagne', start: (t - u) * 1000, end: 0, seed, user: '', n: 0 } as YachtItem, t, at, away, this.bottle, this.cam);
    if (u > 1 && u < 1.25) this.pools.push({ p: at.clone().setY(at.y + 0.4), r: 2.5, c: new THREE.Color(1.2, 1.1, 0.8).multiplyScalar(1 - (u - 1) / 0.25) });
  }

  dispose() {
    this.fx.dispose(); this.sky.dispose(); this.champ.dispose();
    for (const p of [this.confetti, this.balloons, this.glasses, this.liquid]) p.dispose();
    this.strings.geometry.dispose(); (this.strings.material as THREE.Material).dispose();
    this.bottle.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
    this.group.removeFromParent();
  }
}

function mergeGeoms(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  let base = 0;
  for (const g0 of gs) {
    const g = g0.index ? g0 : g0;
    const p = g.getAttribute('position'), n = g.getAttribute('normal');
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(g.index.getX(i) + base); else for (let i = 0; i < p.count; i++) idx.push(i + base);
    base += p.count;
    g0.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setIndex(idx);
  return out;
}
