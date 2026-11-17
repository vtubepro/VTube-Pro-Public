// Voyage enemies: original walker designs (art lane section 7), procedural blockouts until the kitbash lane delivers
// meshes - the Bulwark Crawler (eight piston legs, shield plates, twin mortar towers), the Stilt Lancer (heron walker on two
// stilts + a tail leg with a rail lance), Gnasher packs (bucket-wheel heads) and the summoned GONIF raider (two-legged,
// boxy cockpit). Same gait maths as the ship (voyageGait footAt), feet on the same ground. Silhouettes vertical and
// angular against the ship's low boxy shape; rust over sand camouflage; signal red-orange eyes = danger only.
// Draws: one body mesh per live enemy + 3 instanced draws for every leg segment / foot of every enemy.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { footAt, voyageGait, type GaitFoot } from './voyageGait.ts';
import type { EnemyKind } from '../../../shared/voyage.ts';

const UP = new THREE.Vector3(0, 1, 0);
const tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), tv3 = new THREE.Vector3(), tq = new THREE.Quaternion(), tm = new THREE.Matrix4(), ts = new THREE.Vector3(), tsd = new THREE.Vector3();

export interface EnemyLegDef { id: string; hip: [number, number, number] }
export interface EnemyDef {
  kind: EnemyKind; legs: EnemyLegDef[]; upper: number; lower: number; bodyH: number;
  cycle: number; duty: number; lift: number; pole: 'up' | 'back';
  /** body-local muzzle / eyes */ gun: [number, number, number]; eyes: [number, number, number][];
  /** segment radii */ ru: number; rl: number; foot: number;
  /** radius used for keep-outs / hit spread */ size: number;
  build(): THREE.BufferGeometry;
}

const RUST = new THREE.Color('#6b3f26'), RUST2 = new THREE.Color('#8a5634'), SAND = new THREE.Color('#9c7a52'), DARK = new THREE.Color('#2d2622'), EYE = new THREE.Color('#ff4b1f');
function tint(g: THREE.BufferGeometry, c: THREE.Color) {
  const geo = g.index ? g.toNonIndexed() : g;
  const n = geo.getAttribute('position').count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (geo.getAttribute('uv')) geo.deleteAttribute('uv');
  return geo;
}
const B = (w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.Color, rx = 0) => tint(new THREE.BoxGeometry(w, h, d).rotateX(rx).translate(x, y, z), c);
const C = (r: number, h: number, x: number, y: number, z: number, c: THREE.Color, axis: 'x' | 'y' | 'z' = 'y', seg = 10) => { const g = new THREE.CylinderGeometry(r, r, h, seg); if (axis === 'x') g.rotateZ(Math.PI / 2); if (axis === 'z') g.rotateX(Math.PI / 2); return tint(g.translate(x, y, z), c); };
const E = (r: number, x: number, y: number, z: number) => tint(new THREE.SphereGeometry(r, 8, 6).translate(x, y, z), EYE);
const merge = (gs: THREE.BufferGeometry[]) => mergeGeometries(gs.map((g) => (g.index ? g.toNonIndexed() : g)), false)!;

// enemy local frame: forward = -Z (like the ship), +X right, +Y up, origin = body centre
export const ENEMY_DEFS: Record<EnemyKind, EnemyDef> = {
  crawler: {
    kind: 'crawler', upper: 7.5, lower: 9, bodyH: 7.5, cycle: 9, duty: 0.6, lift: 1.3, pole: 'up', ru: 0.55, rl: 0.45, foot: 1.1, size: 16,
    legs: [-10.5, -3.5, 3.5, 10.5].flatMap((z, i) => [{ id: `L${i + 1}`, hip: [-6, -1.6, z] as [number, number, number] }, { id: `R${i + 1}`, hip: [6, -1.6, z] as [number, number, number] }]),
    gun: [0, 6.5, 4], eyes: [[-2.6, 0.8, -15.2], [2.6, 0.8, -15.2], [0, 1.6, -15.3]],
    build: () => merge([
      B(12, 4.5, 28, 0, 0, 0, RUST), B(13, 1.2, 26, 0, 2.6, 0, RUST2), B(10, 2.2, 6, 0, -2.4, 0, DARK),
      B(13, 5.5, 1.2, 0, 0.3, -14.6, RUST2, -0.25), B(11, 4.5, 1.2, 0, 1.2, -15.6, RUST, -0.35), B(9, 3.2, 1.2, 0, 2.2, -16.4, RUST2, -0.45),
      C(1.6, 5, -3.2, 5.2, 4, DARK), C(1.6, 5, 3.2, 5.2, 4, DARK), B(2.4, 1.2, 4.2, -3.2, 7.6, 2.8, RUST), B(2.4, 1.2, 4.2, 3.2, 7.6, 2.8, RUST),
      C(0.5, 3, -2, 4.2, 12, DARK), C(0.5, 3, 2, 4.2, 12, DARK),
      E(0.55, -2.6, 0.8, -15.2), E(0.55, 2.6, 0.8, -15.2), E(0.45, 0, 1.6, -15.3),
    ]),
  },
  lancer: {
    kind: 'lancer', upper: 11, lower: 12.5, bodyH: 19, cycle: 15, duty: 0.55, lift: 3.2, pole: 'back', ru: 0.42, rl: 0.32, foot: 1.0, size: 12,
    legs: [{ id: 'L1', hip: [-1.8, -1.2, 0.5] }, { id: 'R1', hip: [1.8, -1.2, 0.5] }, { id: 'T1', hip: [0, -0.6, 6.5] }],
    gun: [0, 0.6, -20], eyes: [[0, 1.1, -6.6]],
    build: () => merge([
      B(3.2, 3, 12, 0, 0, 0, RUST2), B(2.4, 1.6, 4, 0, 1.4, -5, RUST), C(0.35, 16, 0, 0.4, -14, DARK, 'z', 8), C(0.8, 2, 0, 0.4, -6.8, RUST, 'z'),
      B(0.6, 6, 0.6, 0, 3.8, 2, DARK), B(4, 0.4, 1.2, 0, 6.6, 2, RUST2), C(0.7, 5, 0, -0.2, 7, RUST, 'z'), E(0.5, 0, 1.1, -6.6),
    ]),
  },
  gnashers: {
    kind: 'gnashers', upper: 3.5, lower: 4.5, bodyH: 4.2, cycle: 5, duty: 0.6, lift: 0.9, pole: 'up', ru: 0.28, rl: 0.22, foot: 0.5, size: 5,
    legs: [{ id: 'FL', hip: [-1.5, -0.6, -1.8] }, { id: 'FR', hip: [1.5, -0.6, -1.8] }, { id: 'BL', hip: [-1.5, -0.6, 1.8] }, { id: 'BR', hip: [1.5, -0.6, 1.8] }],
    gun: [0, 0.4, -4], eyes: [[-0.6, 0.6, -3.6], [0.6, 0.6, -3.6]],
    build: () => merge([
      B(3, 2.2, 5, 0, 0, 0, RUST), B(3.4, 0.6, 4.6, 0, 1.3, 0, RUST2),
      tint(new THREE.TorusGeometry(1.5, 0.35, 6, 12).rotateY(Math.PI / 2).translate(0, 0.2, -3.4), DARK),
      ...[0, 1, 2, 3, 4, 5].map((k) => { const a = (k / 6) * Math.PI * 2; return B(0.3, 0.7, 0.3, 0, 0.2 + Math.cos(a) * 1.9, -3.4 + Math.sin(a) * 0.01, SAND); }),
      E(0.25, -0.6, 0.6, -3.6), E(0.25, 0.6, 0.6, -3.6),
    ]),
  },
  skiffs: {
    // sand skiffs: small fast raiders - a wedge hull with a patched sail on four short running legs
    kind: 'skiffs', upper: 2.2, lower: 2.6, bodyH: 2.8, cycle: 4.2, duty: 0.5, lift: 0.7, pole: 'up', ru: 0.18, rl: 0.15, foot: 0.4, size: 4,
    legs: [{ id: 'FL', hip: [-1.0, -0.5, -1.6] }, { id: 'FR', hip: [1.0, -0.5, -1.6] }, { id: 'BL', hip: [-1.0, -0.5, 1.6] }, { id: 'BR', hip: [1.0, -0.5, 1.6] }],
    gun: [0, 0.8, -2.6], eyes: [[0, 0.5, -3.1]],
    build: () => merge([
      B(2.2, 0.9, 5.2, 0, 0, 0, RUST2), B(1.6, 0.6, 1.8, 0, 0.7, 0.8, RUST), tint(new THREE.ConeGeometry(1.0, 2.2, 4).rotateX(-Math.PI / 2).rotateZ(Math.PI / 4).translate(0, 0, -3.4), RUST),
      C(0.08, 4.2, 0, 2.4, 0.2, DARK, 'y', 6), B(0.06, 2.8, 2.2, 0, 2.8, 0.6, SAND), C(0.12, 1.6, 0, 0.8, -2.0, DARK, 'z', 6), E(0.22, 0, 0.5, -3.1),
    ]),
  },
};

/** One enemy this frame (world route coords + its own gait distance). */
export interface EnemyPose {
  key: string; kind: EnemyKind;
  s: number; d: number;
  /** heading (rad): 0 = forward along the route (+s), + = towards starboard */ yaw: number;
  /** gait distance (m) and speed factor 0..1 (lift) */ dist: number; walk: number;
  /** 0 = standing .. 1 = down (collapsed) */ down: number;
  /** 0..1 */ fade: number;
}

export interface EnemyDrawn { key: string; kind: EnemyKind; body: THREE.Vector3; gun: THREE.Vector3; eyes: THREE.Vector3[]; size: number; alive: boolean }

export class EnemyPool {
  readonly group = new THREE.Group();
  private upper: THREE.InstancedMesh; private lower: THREE.InstancedMesh; private feet: THREE.InstancedMesh;
  private bodies = new Map<EnemyKind, THREE.Mesh[]>();
  private used = new Map<EnemyKind, number>();
  private nu = 0; private nl = 0; private nf = 0;
  private mat: THREE.MeshStandardMaterial;
  private foot: GaitFoot = { s: 0, d: 0, lift: 0, stance: true, u: 0, k: 0, plantS: 0, sincePlant: 0 };
  private phases = new Map<EnemyKind, number[]>();
  readonly drawn: EnemyDrawn[] = [];
  constructor() {
    this.group.name = 'vtp:voyage:enemies';
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.45, flatShading: true, name: 'vtp:voyage:enemy' });
    const seg = new THREE.CylinderGeometry(1, 1, 1, 7).translate(0, 0.5, 0);
    const legMat = new THREE.MeshStandardMaterial({ color: '#3a2a20', roughness: 0.75, metalness: 0.5, flatShading: true });
    this.upper = new THREE.InstancedMesh(seg, legMat, 96);
    this.lower = new THREE.InstancedMesh(seg.clone(), legMat, 96);
    this.feet = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1.25, 0.6, 8).translate(0, 0.3, 0), legMat, 96);
    for (const im of [this.upper, this.lower, this.feet]) { im.count = 0; im.frustumCulled = false; im.renderOrder = 2; this.group.add(im); }
    // (the bodies are built on the first battle: a hidden one now, so the room's warm-up compiles their program — the
    // first battle of a show compiled it on stream; src/stage/gfx/programKeep.ts)
    const warm = new THREE.Mesh(seg, this.mat);
    warm.name = 'vtp:voyage:enemy:warm'; warm.visible = false;
    this.group.add(warm);
  }
  private body(kind: EnemyKind): THREE.Mesh {
    const list = this.bodies.get(kind) ?? [];
    this.bodies.set(kind, list);
    const i = this.used.get(kind) ?? 0;
    this.used.set(kind, i + 1);
    if (!list[i]) {
      const geo = list[0]?.geometry ?? ENEMY_DEFS[kind].build();
      const m = new THREE.Mesh(geo, this.mat);
      m.name = `vtp:voyage:enemy:${kind}`; m.frustumCulled = false; m.renderOrder = 2;
      this.group.add(m);
      list[i] = m;
    }
    list[i].visible = true;
    return list[i];
  }
  begin() { this.used.clear(); this.nu = this.nl = this.nf = 0; this.drawn.length = 0; }
  /** Place one enemy. S = ship distance (local z = -(s - S)); heightAt = the ground. */
  draw(p: EnemyPose, S: number, heightAt: (s: number, d: number) => number) {
    const D = ENEMY_DEFS[p.kind];
    if (p.fade <= 0.01) return;
    let ph = this.phases.get(p.kind);
    if (!ph) { ph = voyageGait().phases(D.legs.map((l) => l.id), D.legs.length === 2 ? 'biped' : D.legs.length === 4 ? 'quad' : D.legs.length === 3 ? 'biped' : 'tripod'); if (D.legs.length === 3) ph[2] = 0.25; this.phases.set(p.kind, ph); }
    const g0 = heightAt(p.s, p.d);
    const fw = tv3.set(Math.sin(p.yaw), 0, -Math.cos(p.yaw));          // local frame: forward (s) = -z, starboard (d) = +x
    const rt = new THREE.Vector3(Math.cos(p.yaw), 0, Math.sin(p.yaw));
    const body = this.body(p.kind);
    const sink = p.down * D.bodyH * 0.72;
    body.position.set(p.d, g0 + D.bodyH - sink, -(p.s - S));
    body.quaternion.setFromAxisAngle(UP, -p.yaw).multiply(tq.setFromEuler(new THREE.Euler(p.down * 0.35, 0, p.down * 0.5)));
    body.scale.setScalar(p.fade < 1 ? 0.6 + 0.4 * p.fade : 1);
    body.updateMatrix();
    body.updateMatrixWorld();
    const out: EnemyDrawn = { key: p.key, kind: p.kind, body: body.position.clone(), gun: new THREE.Vector3(...D.gun).applyMatrix4(body.matrix), eyes: D.eyes.map((e) => new THREE.Vector3(...e).applyMatrix4(body.matrix)), size: D.size, alive: p.down < 0.05 };
    this.drawn.push(out);
    D.legs.forEach((L, i) => {
      const hip = tv.set(L.hip[0], L.hip[1], L.hip[2]).applyMatrix4(body.matrix);
      // foot: gait along the enemy's heading; rest foot = the hip pushed out + down
      const outK = Math.sign(L.hip[0]) || 0;
      const rest = { fwd: -L.hip[2], lat: L.hip[0] + outK * D.upper * 0.55, phi: ph![i] ?? 0 };
      footAt(p.dist, { id: L.id, fwd: 0, lat: rest.lat, phi: rest.phi }, { cycle: D.cycle, duty: D.duty, height: D.lift }, p.walk * (1 - p.down), this.foot);
      const rel = this.foot.s - p.dist + rest.fwd;            // along the heading, from the body centre
      const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw);
      const fsAbs = p.s + rel * cy - rest.lat * sy;
      const fx = p.d + rel * sy + rest.lat * cy;
      const fy = heightAt(fsAbs, fx) + this.foot.lift;
      const foot = tv2.set(fx, fy, -(fsAbs - S));
      // two-bone with a pole (spider: up + out; biped: back)
      const dir = ts.copy(foot).sub(hip);
      let d = dir.length();
      dir.normalize();
      const a = D.upper, b = D.lower;
      d = Math.max(Math.abs(a - b) + 0.05, Math.min((a + b) * 0.995, d));
      const ca = (a * a + d * d - b * b) / (2 * a * d);
      const sa = Math.sqrt(Math.max(0, 1 - ca * ca));
      const pole = D.pole === 'up' ? new THREE.Vector3().copy(UP).addScaledVector(rt, outK * 0.6) : new THREE.Vector3().copy(fw).multiplyScalar(-1).addScaledVector(UP, 0.15);
      pole.addScaledVector(dir, -pole.dot(dir)).normalize();
      const knee = new THREE.Vector3().copy(hip).addScaledVector(dir, a * ca).addScaledVector(pole, a * sa);
      const footP = new THREE.Vector3().copy(hip).addScaledVector(dir, d);
      this.seg(this.upper, this.nu++, hip, knee, D.ru);
      this.seg(this.lower, this.nl++, knee, footP, D.rl);
      if (this.nf < this.feet.instanceMatrix.count) { tm.compose(footP.clone().setY(footP.y - 0.3), tq.setFromAxisAngle(UP, -p.yaw), tv.set(D.foot, D.foot * 0.8, D.foot)); this.feet.setMatrixAt(this.nf++, tm); }
      void rt;
    });
    return out;
  }
  private seg(im: THREE.InstancedMesh, i: number, a: THREE.Vector3, b: THREE.Vector3, r: number) {
    if (i >= im.instanceMatrix.count) return;
    const d = tsd.copy(b).sub(a);                           // (not tv: the hip passed in IS tv)
    const len = d.length();
    tq.setFromUnitVectors(UP, d.multiplyScalar(1 / Math.max(1e-5, len)));
    tm.compose(a, tq, ts.set(r, len, r));
    im.setMatrixAt(i, tm);
  }
  end() {
    for (const [k, list] of this.bodies) { const n = this.used.get(k) ?? 0; list.forEach((m, i) => { m.visible = i < n; }); }
    this.upper.count = Math.min(this.nu, 96); this.lower.count = Math.min(this.nl, 96); this.feet.count = Math.min(this.nf, 96);
    for (const im of [this.upper, this.lower, this.feet]) im.instanceMatrix.needsUpdate = true;
  }
  counts() { let b = 0; for (const [k] of this.bodies) b += this.used.get(k) ?? 0; return { bodies: b, legs: this.nu, draws: b + (this.nu ? 3 : 0) }; }
  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    this.mat.dispose(); (this.upper.material as THREE.Material).dispose();
  }
}
