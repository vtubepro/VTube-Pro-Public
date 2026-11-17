// Yacht life — outside the windows: ships (a Fleet of fleet/ships.glb clones, closed-form poses) and the space effects
// (SpaceFx: additive sprites, smoke, streaks — 3 draws whatever happens).
//   ambient : distant flybys (fighter pairs, a Constellation, a Carrack …), the escort patrol holding station, an
//             occasional far pirate skirmish (tracers, hits, a fireball), storm lightning inside Crusader
//   events  : fireworks in the YACHT_SKY show volume, the escort flyby (barrel roll + salute), the fleet quantum arrival
// Every pose / particle is a pure function of (room, wall-clock s, event start + seed) → the same sky on every page.
import * as THREE from 'three';
import { Fleet } from '../traffic/fleet.ts';
import type { ShipMeta } from '../traffic/config.ts';
import type { ShipPose } from '../traffic/flights.ts';
import { SpaceFx, SPRITE } from '../space/fx.ts';
import { envFlashAt, envStrikes, type Strike } from '../../../shared/environment.ts';
import { yachtAmbient, yachtHash, yachtRand, type YachtItem } from '../../../shared/yacht.ts';
import type { YachtRoom } from './yachtRoom.ts';

/** A show volume seen from a camera: C = the camera, D = unit direction to the volume, R / U = its right / up. */
export interface SkyView { C: THREE.Vector3; D: THREE.Vector3; R: THREE.Vector3; U: THREE.Vector3; d: number; size: number; tanH: number; anchor: number;
  /** the camera itself: forward / right / up, tan of the half fov (vertical) and the aspect */ F: THREE.Vector3; CR: THREE.Vector3; CU: THREE.Vector3; tanV: number; aspect: number }

const ROLES: Record<string, string[]> = {
  fighter: ['arrow', 'hornet', 'gladius', 'mustang', 'aurora'],
  pirate: ['cutlass', 'mustang', 'aurora', 'prospector'],
  capital: ['idris', 'javelin', 'hammerhead', 'carrack', 'caterpillar', 'jump890'],
  escort: ['gladius', 'arrow', 'hornet', 'constellation', 'hercules', 'x600i', 'cutlass', 'mustang'],
  big: ['constellation', 'carrack', 'hercules', 'x600i', 'caterpillar', 'jump890', 'x85', 'freelancer'],
};
const PALETTES: [number, number, number][][] = [
  [[1.0, 0.62, 0.18], [1.0, 0.88, 0.55]],              // champagne gold
  [[1.0, 0.12, 0.16], [1.0, 0.7, 0.3]],                // crimson + gold
  [[0.12, 1.0, 0.35], [0.85, 1.0, 0.5]],               // emerald
  [[0.62, 0.22, 1.0], [1.0, 0.55, 0.9]],               // violet + pink
  [[0.18, 0.5, 1.0], [0.75, 0.9, 1.0]],                // azure + ice
  [[0.92, 0.93, 1.0], [1.0, 0.7, 0.25]],               // silver + gold
  [[1.0, 0.28, 0.65], [1.0, 0.85, 0.35]],              // rose + gold
];
const FORMATION: [number, number, number][] = [[0.55, 0.26, -0.28], [0.52, -0.24, -0.2], [0.26, 0.44, 0.08], [0.24, -0.42, 0.12], [-0.22, 0.36, -0.34], [-0.28, -0.34, -0.3], [0.78, 0.04, -0.48], [-0.5, 0.08, 0.24]];

const Y = new THREE.Vector3(0, 1, 0);
const tq = new THREE.Quaternion(), tq2 = new THREE.Quaternion(), tm = new THREE.Matrix4();
const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3(), vD = new THREE.Vector3(), vE = new THREE.Vector3(), vF = new THREE.Vector3(), vG = new THREE.Vector3();
const eA = new THREE.Vector3(), eB = new THREE.Vector3();
const kF = new THREE.Vector3(), kC = new THREE.Vector3(), kR = new THREE.Vector3(), kU = new THREE.Vector3(), kPP = new THREE.Vector3(), kPF = new THREE.Vector3(), kDP = new THREE.Vector3(), kDF = new THREE.Vector3(), kT = new THREE.Vector3();
const vX = new THREE.Vector3(), vYv = new THREE.Vector3(), vZ = new THREE.Vector3(), ZAX = new THREE.Vector3(0, 0, 1);
const smooth = (x: number) => { const k = Math.min(1, Math.max(0, x)); return k * k * (3 - 2 * k); };
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** nose (−Z) along fwd, rolled by bank about the nose */
function orient(fwd: THREE.Vector3, bank: number, out: THREE.Quaternion, up = Y) {
  vZ.copy(fwd).normalize().negate();
  vX.crossVectors(up, vZ);
  if (vX.lengthSq() < 1e-6) vX.set(1, 0, 0);
  vX.normalize();
  vYv.crossVectors(vZ, vX);
  tm.makeBasis(vX, vYv, vZ);
  out.setFromRotationMatrix(tm);
  if (bank) out.multiply(tq2.setFromAxisAngle(ZAX, bank));
  return out;
}

interface Stretch { key: string; k: number }

export class YachtSky {
  readonly group = new THREE.Group();
  readonly fleet = new Fleet();
  readonly fx: SpaceFx;
  private meta = new Map<string, ShipMeta>();
  private midY = new Map<string, number>();
  private poses: ShipPose[] = [];
  private pool = new Map<string, ShipPose>();
  private stretch: Stretch[] = [];
  private nStretch = 0;
  private strikes: { slot: number; list: Strike[] }[] = [];
  ready = false;
  error = '';
  /** ships in view last frame (debug) */
  shown: string[] = [];
  /** where the last skirmish ran (debug) */
  readonly skirmishAt = new THREE.Vector3();
  counts = { ships: 0, sprites: 0, streaks: 0 };

  constructor(private room: YachtRoom) {
    this.group.name = 'yacht:sky';
    this.fx = new SpaceFx({ sprites: 1600, smoke: 160, streaks: 1600 }, false);
    this.fx.uniforms.uFaceDim.value = 0.3;
    this.group.add(this.fx.group, this.fleet.group);
    for (let i = 0; i < 24; i++) this.stretch.push({ key: '', k: 1 });
  }

  async load(glbUrl: string, meta: ShipMeta[]) {
    for (const m of meta) this.meta.set(m.id, m);
    this.fleet.scale = 1;
    this.fleet.lod0Px = 160;
    await this.fleet.load(glbUrl, meta);
    // hull centre above the origin (the origin sits under the belly): formations are placed by their centres
    const box = new THREE.Box3(), c = new THREE.Vector3();
    for (const [id, tpl] of this.fleet.templates) { box.setFromObject(tpl, true); if (!box.isEmpty()) this.midY.set(id, box.getCenter(c).y - tpl.position.y); }
    this.error = this.fleet.error;
    this.ready = this.fleet.ready;
  }

  /** the first ship id of a role this fleet file has (rotated by `k`) */
  ship(role: string, k = 0): string | null {
    const l = (ROLES[role] ?? []).filter((id) => this.fleet.templates.has(id));
    if (!l.length) { const any = [...this.fleet.templates.keys()].filter((id) => (this.meta.get(id)?.cls ?? '') !== 'T'); return any.length ? any[k % any.length] : null; }
    return l[((k % l.length) + l.length) % l.length];
  }
  len(id: string) { return this.meta.get(id)?.length ?? 20; }

  private pose(key: string, ship: string, pos: THREE.Vector3, fwd: THREE.Vector3, bank: number, thrust: number, up?: THREE.Vector3) {
    let p = this.pool.get(key);
    if (!p) { p = { key, ship, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), gear: 0, thrust: 1, phase: 'cruise', landing: 0 }; this.pool.set(key, p); }
    p.ship = ship; p.pos.copy(pos); orient(fwd, bank, p.quat, up); p.thrust = thrust;
    this.poses.push(p);
    return p;
  }
  private stretchShip(key: string, k: number) { if (this.nStretch < this.stretch.length && k > 1.01) { const s = this.stretch[this.nStretch++]; s.key = key; s.k = k; } }

  // ------------------------------------------------------------------------------------------ frame
  begin(t: number) { this.poses.length = 0; this.nStretch = 0; this.fx.begin(t); }

  end(t: number, cam: THREE.PerspectiveCamera, H: number) {
    this.fx.uniforms.uPx.value = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / Math.max(1, H);
    this.fleet.update(this.poses, 0.7, t, cam, H);
    const live = (this.fleet as unknown as { live: Map<string, { obj: THREE.Object3D }> }).live;
    for (let i = 0; i < this.nStretch; i++) { const o = live.get(this.stretch[i].key)?.obj; if (o) o.scale.z *= this.stretch[i].k; }
    this.fx.end();
    const c = this.fx.counts();
    this.counts.ships = this.poses.length; this.counts.sprites = c.sprites; this.counts.streaks = c.streaks;
  }

  /** pull a point into the camera's frame (fractions of the half extents), keeping its depth */
  private inFrame(p: THREE.Vector3, V: SkyView, mx: number, y0: number, y1: number) {
    const rel = eA.copy(p).sub(V.C), z = Math.max(1, rel.dot(V.F));
    const x = rel.dot(V.CR) / z, y = rel.dot(V.CU) / z;
    const X = V.tanV * V.aspect * mx, cx = Math.max(-X, Math.min(X, x)), cy = Math.max(V.tanV * y0, Math.min(V.tanV * y1, y));
    return p.addScaledVector(V.CR, (cx - x) * z).addScaledVector(V.CU, (cy - y) * z);
  }

  // ------------------------------------------------------------------------------------------ engine glow + trail
  private engine(p: THREE.Vector3, fwd: THREE.Vector3, len: number, thrust: number, trail: number, col: [number, number, number] = [0.55, 0.75, 1.0]) {
    const back = eA.copy(p).addScaledVector(fwd, -len * 0.48).addScaledVector(Y, len * 0.06);
    this.fx.sprite(back, len * 0.12 * (0.6 + 0.4 * thrust), col[0] * 1.6 * thrust, col[1] * 1.6 * thrust, col[2] * 1.8 * thrust, 1, SPRITE.glow);
    if (trail > 0.01) { eB.copy(back).addScaledVector(fwd, -len * 1.8 * trail); this.fx.line(eB, back, len * 0.025, 1.1, col[0] * 0.8, col[1] * 0.8, col[2], 0.55 * trail); }
  }

  // ------------------------------------------------------------------------------------------ lightning in Crusader's storms
  lightning(nowMs: number, level: number, seed: number) {
    const P = this.room.planet;
    if (!P || !P.storms.length || level <= 0.01) return;
    const bolt = Math.min(1, level / 10);
    const slot = Math.floor(nowMs / 1700);
    for (let i = 0; i < P.storms.length; i++) {
      let c = this.strikes[i];
      if (!c) { c = this.strikes[i] = { slot: -1, list: [] }; }
      if (c.slot !== slot) { c.slot = slot; c.list = envStrikes(seed + i * 131, nowMs, bolt, true); }
      if (!c.list.length) continue;
      const f = envFlashAt(c.list, nowMs, true);
      if (f.f < 0.01) continue;
      const s = P.storms[i];
      const n = vA.copy(s).sub(P.center).normalize();
      const base = vB.copy(P.center).addScaledVector(n, P.radius * 1.004);
      const R = P.radius;
      const k = f.f;
      // the cloud lights up from inside: a soft wide glow + a few cells flickering around it
      this.fx.sprite(base, R * 0.032 * (0.7 + 0.3 * k), 0.3 * k, 0.4 * k, 0.75 * k, 1, SPRITE.glow, i * 0.37);   // (subtle: a storm cell lit from inside, not a white blotch)
      const tx = vC.crossVectors(n, Y).normalize(), ty = vD.crossVectors(n, tx);
      const h = yachtHash(seed, i, f.at);
      for (let j = 0; j < 4; j++) {
        const a = yachtRand(h, j, 1) * Math.PI * 2, r = R * 0.022 * yachtRand(h, j, 2);
        vE.copy(base).addScaledVector(tx, Math.cos(a) * r).addScaledVector(ty, Math.sin(a) * r);
        const kk = k * (0.5 + 0.5 * yachtRand(h, j, Math.floor(nowMs / 60)));
        this.fx.sprite(vE, R * 0.011, 0.6 * kk, 0.7 * kk, 1.1 * kk, 1, SPRITE.glow, j * 0.2);
      }
      if (f.near && k > 0.5) this.fx.sprite(base, R * 0.012, 1.2 * k, 1.3 * k, 1.7 * k, 1, SPRITE.flare, (h % 100) / 100);
    }
  }

  // ------------------------------------------------------------------------------------------ the escort patrol (fixed to the ship)
  patrol(t: number, period: number, origin: THREE.Vector3 | null) {
    const S = this.room.sky[0];
    if (!S || !origin) return;
    const id = this.ship('fighter', 0), id2 = this.ship('fighter', 1);
    if (!id || !id2) return;
    const D = vA.copy(S.pos).sub(origin); const d = D.length(); D.normalize();
    const R = vB.crossVectors(D, Y).normalize(), U = vC.crossVectors(R, D);
    const w = (2 * Math.PI) / Math.max(20, period);
    const A = d * 0.6;
    const c = vD.copy(origin).addScaledVector(D, d * 2.4).addScaledVector(U, d * 0.35);
    for (let i = 0; i < 2; i++) {
      const ph = t * w + i * 0.35;
      const p = vE.copy(c).addScaledVector(R, A * Math.sin(ph) - i * 32).addScaledVector(U, A * 0.35 * Math.sin(2 * ph) + i * 9).addScaledVector(D, i * 18);
      const f = vF.copy(R).multiplyScalar(A * w * Math.cos(ph)).addScaledVector(U, A * 0.7 * w * Math.cos(2 * ph)).normalize();
      const sid = i ? id2 : id;
      this.pose(`patrol${i}`, sid, p, f, -0.5 * Math.cos(ph) * Math.sign(Math.sin(ph) + 1e-3) * 0.6, 1);
      this.engine(p, f, this.len(sid), 0.9, 0.3);
    }
  }

  // ------------------------------------------------------------------------------------------ ambient flybys
  ambientFlyby(t: number, every: number, seed: number, view: (key: string) => SkyView | null) {
    const a = yachtAmbient(seed, 41, every, Math.min(every - 2, 30), t, 0.85);
    if (!a) return null;
    const V = view(`amb:${a.slot}`);
    if (!V) return null;
    const h = a.seed;
    const pair = yachtRand(h, 1) < 0.35;
    const id = pair ? this.ship('fighter', h % 7) : this.ship('big', h % 11);
    if (!id) return null;
    const L = this.len(id);
    const depth = V.d * (pair ? 1.8 + yachtRand(h, 2) * 1.5 : 3 + yachtRand(h, 3) * 3);
    const W = depth * V.tanH * 1.5 + L;
    const dir = yachtRand(h, 4) < 0.5 ? 1 : -1;
    const speed = Math.max(pair ? 110 : 26 + L * 0.12, (2 * W) / Math.max(4, Math.min(every - 2, 30) - 1));
    const dur = (2 * W) / speed;
    const u = t - a.start;
    if (u > dur) return null;
    const k = u / dur;
    const hy = (yachtRand(h, 5) - 0.35) * depth * V.tanH * 0.9;
    const p = vA.copy(V.C).addScaledVector(V.D, depth).addScaledVector(V.R, dir * (-W + 2 * W * k)).addScaledVector(V.U, hy + Math.sin(k * Math.PI) * depth * 0.04);
    const f = vB.copy(V.R).multiplyScalar(dir).addScaledVector(V.D, -0.08).normalize();
    this.pose('amb0', id, p, f, 0, 1);
    this.engine(p, f, L, 1, pair ? 0.6 : 0.25);
    if (pair) {
      const p2 = vC.copy(p).addScaledVector(f, -L * 2.2).addScaledVector(V.U, L * 0.6).addScaledVector(V.D, L * 1.2);
      this.pose('amb1', id, p2, f, 0, 1);
      this.engine(p2, f, L, 1, 0.6);
    }
    return id;
  }

  // ------------------------------------------------------------------------------------------ far pirate skirmish
  skirmish(t: number, every: number, seed: number, view: SkyView | null) {
    const DUR = 32;
    const a = yachtAmbient(seed, 57, every, DUR, t, 0.65);
    if (!a || !view) return false;
    const h = a.seed, u = t - a.start;
    const far = this.room.far;
    const fd = Math.min(1500, Math.max(600, view.d * 8));
    const F = far.length ? kF.copy(far[h % far.length]) : kF.copy(view.C).addScaledVector(view.D, fd).addScaledVector(view.R, (yachtRand(h, 1) - 0.5) * fd * view.tanH * 0.8).addScaledVector(view.U, (yachtRand(h, 2) * 0.3 - 0.25) * fd * view.tanH / 1.78);
    this.skirmishAt.copy(F);
    const toC = kC.copy(view.C).sub(F).normalize();
    const R = kR.crossVectors(toC, Y).normalize(), U = kU.crossVectors(R, toC);
    const pairs = 1 + (h % 2) + (yachtRand(h, 3) < 0.35 ? 1 : 0);      // 1-3 duels = 2-5 ships (the 3rd pair may be a lone pirate)
    const boomAt = DUR - 7;
    const w = (2 * Math.PI) / 13;
    const pos = (i: number, uu: number, lag: number, out: THREE.Vector3) => {
      const ph = uu * w * (i % 2 ? -1 : 1) + i * 2.1 - lag;
      const a0 = 170 + 50 * yachtRand(h, i, 4);
      return out.copy(F).addScaledVector(R, a0 * Math.cos(ph)).addScaledVector(U, a0 * 0.45 * Math.sin(2 * ph) + i * 40).addScaledVector(toC, a0 * 0.7 * Math.sin(ph));
    };
    const fade = Math.min(1, u / 2, (DUR - u) / 2);
    for (let i = 0; i < pairs; i++) {
      const pid = this.ship('pirate', h + i), did = this.ship('fighter', h + i * 3);
      if (!pid || !did) continue;
      const dead = i === 0 && u > boomAt;
      const pp = pos(i, u, 0, kPP), pf = pos(i, u + 0.1, 0, kPF).sub(pp).normalize();
      if (!dead) { this.pose(`sk${i}p`, pid, pp, pf, 0.6 * Math.sin(u * 1.3 + i), 1); this.engine(pp, pf, this.len(pid), 1, 0.4, [1, 0.5, 0.25]); }
      const lone = i === 2 && yachtRand(h, 9) < 0.5;
      if (lone) continue;
      const dp = pos(i, u, 0.32, kDP), df = pos(i, u + 0.1, 0.32, kDF).sub(dp).normalize();
      this.pose(`sk${i}d`, did, dp, df, -0.5 * Math.sin(u * 1.1 + i), 1);
      this.engine(dp, df, this.len(did), 1, 0.4);
      if (dead && u > boomAt + 2) continue;
      // bursts of fire: the defender at the pirate (blue lasers), sometimes the pirate back (red)
      const slot = Math.floor(u / 1.3);
      for (const [from, to, sd, col] of [[dp, pp, 0, [0.35, 0.6, 1.6]], [pp, dp, 1, [1.7, 0.35, 0.2]]] as const) {
        if (dead && sd === 1) continue;
        if (yachtRand(h, slot * 7 + i, 20 + sd) > (sd ? 0.35 : 0.65)) continue;
        const s0 = slot * 1.3 + yachtRand(h, slot, 30 + sd) * 0.5;
        for (let k = 0; k < 4; k++) {
          const tk = u - (s0 + k * 0.11);
          if (tk < 0 || tk > 0.5) continue;
          const kk = tk / 0.4;
          const a1 = vB.copy(from).lerp(to, Math.min(1, kk));
          const a0 = vC.copy(from).lerp(to, Math.max(0, kk - 0.12));
          if (kk <= 1) this.fx.line(a0, a1, 1.2, 1.3, col[0] * fade, col[1] * fade, col[2] * fade, 1);
          else if (yachtRand(h, slot * 13 + k, 40 + sd) < 0.5) this.fx.sprite(to, 9, 1.8 * fade, 1.4 * fade, 0.9 * fade, 1 - (kk - 1) * 8, SPRITE.flare, k * 0.3);
        }
      }
    }
    // the kill: fireball + ring + smoke + debris
    const ub = u - boomAt;
    if (ub > 0 && ub < 7) {
      const B = pos(0, boomAt, 0, kT);
      const g = smooth(ub / 0.5);
      this.fx.sprite(B, 16 + 55 * g, 3 * (1 - ub / 7), 1.6 * (1 - ub / 7), 0.6 * (1 - ub / 7), 1 - smooth((ub - 1.2) / 5), SPRITE.fire, (h % 97) / 97);
      if (ub < 0.35) this.fx.sprite(B, 60, 3, 2.6, 2.2, 1 - ub / 0.35, SPRITE.core);
      if (ub < 1.2) this.fx.sprite(B, 20 + 70 * (ub / 1.2), 1.2, 0.9, 0.6, Math.pow(1 - ub / 1.2, 2) * 0.5, SPRITE.ring);
      for (let k = 0; k < 18; k++) {
        const dx = yachtRand(h, k, 50) - 0.5, dy = yachtRand(h, k, 51) - 0.5, dz = yachtRand(h, k, 52) - 0.5;
        const sp = 40 + 60 * yachtRand(h, k, 53);
        vF.set(dx, dy, dz).normalize();
        vG.copy(B).addScaledVector(vF, sp * ub);
        this.fx.sprite(vG, 4, 2 * fade, 1.2 * fade, 0.5 * fade, clamp01(1 - ub / (2 + yachtRand(h, k, 54) * 2)), SPRITE.spark, k * 0.1);
        if (k < 7) { vG.copy(B).addScaledVector(vF, 18 * ub); this.fx.puff(vG, 18 + 10 * ub, 0.18, 0.16, 0.15, 0.55 * clamp01(1 - ub / 7) * smooth(ub / 0.4), k * 0.13); }
      }
    }
    return true;
  }

  // ------------------------------------------------------------------------------------------ fireworks (event)
  fireworks(it: YachtItem, t: number, V: SkyView) {
    const u = t - it.start / 1000;
    const h = it.seed;
    const N = 10 + (h % 4);
    const S = V.size;
    const pos = (i: number, out: THREE.Vector3) => {
      const rx = (yachtRand(h, i, 1) - 0.5) * 2, ry = yachtRand(h, i, 2) * 0.7 - 0.35, rz = (yachtRand(h, i, 3) - 0.5);
      out.copy(V.C).addScaledVector(V.D, V.d + rz * S * 0.5).addScaledVector(V.R, rx * S * 0.55).addScaledVector(V.U, ry * S * 0.4);
      // keep the burst (and most of its stars) inside the camera's frame
      const rel = vE.copy(out).sub(V.C), z = Math.max(1, rel.dot(V.F));
      const x = rel.dot(V.CR) / z, y = rel.dot(V.CU) / z;
      const mx = V.tanV * V.aspect * 0.62, my = V.tanV * 0.5;
      const cx = Math.max(-mx, Math.min(mx, x)), cy = Math.max(-my * 0.7, Math.min(my, y));
      return out.addScaledVector(V.CR, (cx - x) * z).addScaledVector(V.CU, (cy - y) * z);
    };
    for (let i = 0; i < N; i++) {
      const finale = i >= N - 3;
      const ti = finale ? 10.4 + (i - (N - 3)) * 0.35 : 0.8 + (i * 9.2) / (N - 3) + yachtRand(h, i, 4) * 0.6;
      const tau = u - ti;
      let shape = i === N - 1 ? 4 : Math.floor(yachtRand(h, i, 5) * 5);
      if (shape === 2 && i % 4 !== 1) shape = 0;                                           // willows: now and then, not every other burst          // 0 peony · 1 ring · 2 willow · 3 crossette · 4 chrysanthemum
      const life = shape === 2 ? 4.4 : 2.4 + yachtRand(h, i, 6) * 0.7;
      if (tau < -1.1 || tau > life) continue;
      const B = pos(i, vA);
      const pal = PALETTES[(h + i * 3) % PALETTES.length];
      const r = S * (finale ? 0.3 : 0.17 + yachtRand(h, i, 7) * 0.1);
      if (tau < 0) {
        // the rocket: a spark climbing from below with a short glowing tail
        const k = 1 + tau / 1.1;
        const from = vB.copy(B).addScaledVector(V.U, -S * 0.75);
        const head = vC.copy(from).lerp(B, 1 - (1 - k) * (1 - k));
        const tail = vD.copy(from).lerp(B, Math.max(0, 1 - (1 - k + 0.12) * (1 - k + 0.12)));
        this.fx.line(tail, head, S * 0.004, 1.3, 1.0, 0.62, 0.3, 0.9);
        this.fx.sprite(head, S * 0.012, 1.6, 1.1, 0.5, 1, SPRITE.spark, i * 0.1);
        continue;
      }
      const c0 = shape === 2 ? PALETTES[0][0] : pal[0], c1 = shape === 2 ? PALETTES[0][1] : pal[1];     // willows always burn gold
      // the burst: a white-hot flash, a coloured bloom lighting the smoke, then the stars
      if (tau < 0.22) this.fx.sprite(B, r * 0.55, 2.0, 1.9, 1.7, 1 - tau / 0.22, SPRITE.flare, i * 0.21);
      if (tau < 1.6) this.fx.sprite(B, r * 1.25, c0[0] * 0.45, c0[1] * 0.45, c0[2] * 0.45, Math.pow(1 - tau / 1.6, 2), SPRITE.glow);
      const P = shape === 1 ? 48 : shape === 4 ? 96 : 72;
      const g = r * (shape === 2 ? 0.2 : 0.055);
      const tilt = yachtRand(h, i, 8) * 1.2 - 0.6;
      const fade = Math.pow(clamp01(1 - tau / life), 1.2);
      const exp = (x: number) => (shape === 2 ? 1 - Math.exp(-x * 2.0) : 1 - Math.exp(-x * 3.0));
      const tl = shape === 2 ? 0.55 : shape === 4 ? 0.26 : 0.14;
      for (let k = 0; k < P; k++) {
        // directions: a Fibonacci sphere (rings: a circle), jittered by the seed
        if (shape === 1) {
          const a = (k / P) * Math.PI * 2;
          vE.copy(V.R).multiplyScalar(Math.cos(a)).addScaledVector(V.U, Math.sin(a) * Math.cos(tilt)).addScaledVector(V.D, Math.sin(a) * Math.sin(tilt));
        } else {
          const y = 1 - (2 * (k + 0.5)) / P, rr = Math.sqrt(1 - y * y), a = k * 2.39996 + yachtRand(h, i, 9) * 6.28;
          vE.copy(V.R).multiplyScalar(Math.cos(a) * rr).addScaledVector(V.U, y).addScaledVector(V.D, Math.sin(a) * rr);
        }
        const jit = 0.85 + 0.3 * yachtRand(h, i * 97 + k, 10);
        const at = (x: number, out: THREE.Vector3) => out.copy(B).addScaledVector(vE, r * jit * exp(Math.max(0, x))).addScaledVector(V.U, -g * x * x);
        const head = at(tau, vF);
        const tail = at(Math.max(0, tau - tl), vG);
        // colour: the palette's main colour, a few of its second; willows burn gold → ember
        const c = shape === 2 ? c0 : k % 4 === 0 ? c1 : c0;
        const ck = fade * (shape === 2 ? 0.9 : 1.05);
        const hot = tau < 0.35 ? 1 + (0.35 - tau) * 2.5 : 1;                   // white-hot at first
        this.fx.line(tail, head, r * 0.016, 1.4, c[0] * ck * hot, c[1] * ck * hot, c[2] * ck * hot, shape === 2 ? 0.75 : 0.9);
        // star heads: a soft coloured glow; chrysanthemums / crossettes crackle late
        const tw = shape === 4 || shape === 3 ? yachtRand(h, i * 131 + k, Math.floor(u * 16)) : 0;
        if (tau > life * 0.5 && tw > 0.5) this.fx.sprite(head, r * 0.04, 1.9 * fade, 1.8 * fade, 1.5 * fade, 1, SPRITE.spark, k * 0.07);
        else this.fx.sprite(head, r * 0.035, c[0] * ck * 1.2, c[1] * ck * 1.2, c[2] * ck * 1.2, 1, SPRITE.glow);
        // crossettes split once
        if (shape === 3 && tau > 0.6 && k % 4 === 0) {
          for (let s = -1; s <= 1; s += 2) {
            vD.copy(V.R).multiplyScalar(s * 0.5).addScaledVector(V.U, 0.4);
            vC.copy(head).addScaledVector(vD, r * 0.35 * exp(tau - 0.6));
            this.fx.line(head, vC, r * 0.012, 1.2, c1[0] * ck, c1[1] * ck, c1[2] * ck, 0.9);
            this.fx.sprite(vC, r * 0.03, c1[0] * ck * 1.2, c1[1] * ck * 1.2, c1[2] * ck * 1.2, 1, SPRITE.glow);
          }
        }
      }
      // a faint smoke cloud after the burst, lit by the stars at first
      if (tau > 0.3) this.fx.puff(B, r * 1.1, 0.16 + c0[0] * 0.08 * fade, 0.15 + c0[1] * 0.08 * fade, 0.17 + c0[2] * 0.08 * fade, 0.14 * fade, i * 0.3);
    }
  }

  // ------------------------------------------------------------------------------------------ escort flyby (event)
  flyby(it: YachtItem, t: number, V: SkyView) {
    const u = t - it.start / 1000;
    const h = it.seed;
    const id = this.ship('fighter', h % 3);
    if (!id) return;
    const L = this.len(id);
    const dir = h % 2 ? 1 : -1;
    // pass 1 (0.8 – 4.6 s): low and close, the lead barrel-rolls; pass 2 (4.8 – 8.6 s): back the other way, higher,
    // both waggle their wings and flash the nav lights (a salute)
    for (const pass of [0, 1]) {
      const t0 = pass ? 4.9 : 0.8, T = 3.6;
      const k = (u - t0) / T;
      if (k < -0.02 || k > 1.02) continue;
      const depth = Math.max(40, V.d * (pass ? 0.95 : 0.72));
      const W = depth * V.tanH * 1.35 + L * 2;
      const dd = pass ? -dir : dir;
      const yOff = (pass ? 0.02 : -0.16) * depth * V.tanH / 1.78;
      for (let w = 0; w < 2; w++) {
        const kw = k - w * 0.07;
        const p = vA.copy(V.C).addScaledVector(V.D, depth * (1 - 0.12 * Math.sin(Math.PI * clamp01(kw))) + w * L * 1.4)
          .addScaledVector(V.R, dd * (-W + 2 * W * kw) - w * dd * L * 0.3).addScaledVector(V.U, yOff + w * L * 0.55 + Math.sin(Math.PI * kw) * depth * 0.05);
        const f = vB.copy(V.R).multiplyScalar(dd).addScaledVector(V.D, -0.12 * Math.cos(Math.PI * clamp01(kw))).normalize();
        let bank = 0.22 * dd;
        if (!pass && w === 0) bank += Math.PI * 2 * smooth((kw - 0.36) / 0.3);        // barrel roll mid-frame
        if (pass) bank += 0.45 * Math.sin(clamp01((kw - 0.3) / 0.45) * Math.PI * 3);   // wing waggle
        this.pose(`fly${pass}${w}`, id, p, f, bank, 1.6);
        this.engine(p, f, L, 1.8, 0.9, [0.6, 0.8, 1]);
        // nav-light flash at the wingtips (pass 2)
        if (pass && kw > 0.3 && kw < 0.8 && Math.floor(u * 6) % 2 === 0) {
          const side = vC.crossVectors(f, V.U).normalize();
          for (const s of [-1, 1]) { vD.copy(p).addScaledVector(side, s * L * 0.45); this.fx.sprite(vD, L * 0.09, s > 0 ? 0.4 : 2.4, s > 0 ? 2.4 : 0.3, s > 0 ? 0.5 : 0.25, 1, SPRITE.flare, s * 0.2); }
        }
      }
    }
  }

  // ------------------------------------------------------------------------------------------ the fleet quantum-arrives (event)
  /** returns the formation centre (for the exterior cutaway) */
  fleetEvent(it: YachtItem, t: number, V: SkyView, out: THREE.Vector3): { capitalAt: number } | null {
    const u = t - it.start / 1000;
    const h = it.seed;
    const cap = this.ship('capital', h % 2);
    if (!cap) return null;
    const Lc = this.len(cap);
    const n = 4 + (h % 5);
    const dir = (h >> 3) % 2 ? 1 : -1;
    const dc = Math.max(V.d * 1.4, Lc * 1.75 / Math.max(0.5, V.tanH * 1.6));
    const F = out.copy(V.C).addScaledVector(V.D, dc);
    this.inFrame(F, V, 0.35, -0.15, 0.25);                  // the formation centre stays in the middle of the shot
    const hd = vA.copy(V.R).multiplyScalar(dir).addScaledVector(V.D, 0.18).normalize();       // heading: across the view, slightly away
    const arrive = (i: number) => (i < n ? 1.2 + i * 0.32 : 1.2 + n * 0.32 + 0.9);
    const depart = (i: number) => (i < n ? 44 + i * 0.25 : 44 + n * 0.25 + 1.2);
    const capitalAt = arrive(n);
    for (let i = 0; i <= n; i++) {
      const isCap = i === n;
      const id = isCap ? cap : this.ship('escort', h + i * 5);
      if (!id) continue;
      const L = this.len(id);
      const ua = u - arrive(i), ud = u - depart(i);
      if (ua < -0.35 || ud > 1.6) continue;
      const o = isCap ? null : FORMATION[i % FORMATION.length];
      const hold = vB.copy(F);
      if (o) hold.addScaledVector(hd, o[0] * Lc).addScaledVector(V.U, o[1] * Lc * 0.6).addScaledVector(V.D, o[2] * Lc);
      hold.addScaledVector(V.U, -(this.midY.get(id) ?? 0));                                  // (by the hull's centre)
      hold.addScaledVector(hd, 5 * Math.max(0, ua));                                          // cruise drift
      hold.addScaledVector(V.U, Math.sin(u * 0.4 + i) * L * 0.03);
      // quantum drop: the last ~100 m in a blur, stretched along the nose, a flash + a streak that shrinks into the hull
      const tau = isCap ? 0.3 : 0.2;
      const Dq = 60 + L * 0.9;
      let stretch = 1, thrust = 1, show = ua >= 0;
      const P = vC.copy(hold);
      if (ua >= 0) P.addScaledVector(hd, -Dq * Math.exp(-ua / tau));
      if (ud >= 0) {
        // spool (1.6 s: engines up) then the jump: accelerating away, stretching, gone in a flash
        thrust = 1 + smooth(ud / 1.6);
        const uj = ud - 1.6;
        if (uj > 0) { P.addScaledVector(hd, 40 * (Math.exp(uj / 0.16) - 1)); stretch = 1 + Math.min(9, 0.6 * (Math.exp(uj / 0.16) - 1)); }
        if (uj > 0.45) show = false;
        if (uj > 0) {
          const kf = clamp01(1 - (uj - 0.3) / 0.5);
          vD.copy(hold).addScaledVector(hd, 40 * (Math.exp(Math.min(uj, 0.45) / 0.16) - 1));
          if (uj > 0.3) this.fx.sprite(vD, L * 1.1, 1.2 * kf, 1.7 * kf, 2.6 * kf, 1, SPRITE.flare, i * 0.3);
          this.fx.line(hold, vD, L * 0.05, 2, 0.6, 0.85, 1.4, 0.7 * kf, true);
        }
      }
      if (ua >= 0) stretch *= 1 + 5 * Math.exp(-ua / 0.14);
      // the arrival flash + streak (before and after the drop)
      if (ua > -0.35 && ua < 0.7) {
        const kf = ua < 0 ? smooth((ua + 0.35) / 0.35) : Math.pow(1 - ua / 0.7, 2);
        this.fx.sprite(P, L * (isCap ? 0.9 : 1.6), 1.1 * kf, 1.5 * kf, 2.4 * kf, 1, SPRITE.flare, i * 0.17);
        this.fx.sprite(P, L * (isCap ? 0.35 : 0.6), 2.2 * kf, 2.4 * kf, 2.8 * kf, 1, SPRITE.core);
        const sl = (isCap ? 2400 : 1200) * Math.exp(-Math.max(0, ua) / 0.22);
        vD.copy(P).addScaledVector(hd, -sl);
        this.fx.line(vD, P, L * (isCap ? 0.05 : 0.08), 2.5, 0.55 * kf, 0.8 * kf, 1.4 * kf, 1);
      }
      if (!show) continue;
      const key = `fl${i}`;
      this.pose(key, id, P, hd, 0, thrust);
      this.stretchShip(key, stretch);
      this.engine(P, hd, L, thrust, isCap ? 0.1 : 0.25);
    }
    return { capitalAt: it.start / 1000 + capitalAt };
  }

  dispose() {
    this.fleet.dispose();
    this.fx.dispose();
    this.group.removeFromParent();
    this.pool.clear();
    this.ready = false;
  }
}
