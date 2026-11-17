// World rules made visible (shared/desert/regions.ts decides WHAT and WHERE; this layer builds the kit pieces):
//   near     boulders, rock pillars, dead trees, bones, debris, marker posts, girders, palms, salt mounds  (40..260 m)
//   lines    telegraph poles every 42 m / lattice pylons every 230 m, with sagging wires between them
//   walls    canyon cliff walls on both sides (canyon regions), talus at their feet
//   marks    stranded liners, dead walkers, lighthouses, factories (lit windows at night), pylons, tank farms,
//            aqueducts, temples, watchtowers, buttes, hoodoo clusters, rock arches, palm groves, wrecks
//   gates    a rock arch / a colossal ruined gateway / a girder gantry the ship walks THROUGH
//   far      horizon megastructures (distance-compressed): megatowers, chimney stacks, stranded liners, colossi, walls
// Every piece is a pure function of (seed, cell, biome) placed on the CPU ground (heightAt), cached per item; the active
// set is rebuilt when the ship crosses a 60 m step or the origin rebases (a pure function of that key, like props.ts).
// Things inside a city or dig-site disc (the voyage's flats / cities) or a keep-out are hidden at fill time.
// Also publishes: chimney tops (smoke emitters for life.ts) and the salt-flat zones (terrain uSaltZ).
import * as THREE from 'three';
import { heightAt, type DesertWorldSpec } from '../../../shared/desert/height.ts';
import { DesertRoute, type RoutePoint } from '../../../shared/desert/route.ts';
import { hash32, rnd } from '../../../shared/desert/noise.ts';
import {
  BIOME_RULES, FAR_CELL, GATE_CLEAR, MARK_CELL, MID_CELL, NEAR_CELL, REGION_LEN, defaultBiomeAt, farCell, lineItems, markCell, midCell, nearCell, regionGate, wallItems,
  type BiomeAt, type FarItem, type GateItem, type LineItem, type MarkItem, type MidItem, type NearItem, type WallItem,
} from '../../../shared/desert/regions.ts';
import { KitLayer, MAT, type KitInstance, type Shape } from './kit.ts';
import type { HeightClipmap } from './clipmap.ts';
import type { DesertUniforms } from './uniforms.ts';
import type { DesertLight } from './light.ts';
import type { DesertFrame, DesertWorld } from './index.ts';

/** Along-route reach per quality: near things ahead / behind, landmarks, horizon megastructures. */
const NEAR_AHEAD: Record<string, number> = { low: 450, medium: 800, high: 1150, ultra: 1500 };
const NEAR_BEHIND: Record<string, number> = { low: 300, medium: 450, high: 550, ultra: 650 };
const MARK_AHEAD: Record<string, number> = { low: 2200, medium: 3000, high: 3800, ultra: 4500 };
const FAR_AHEAD: Record<string, number> = { low: 9000, medium: 14000, high: 20000, ultra: 24000 };
const STEP = 60;
const UP = new THREE.Vector3(0, 1, 0);

/** A placed piece in WORLD coordinates. */
export interface Part { shape: Shape; x: number; y: number; z: number; q: THREE.Quaternion; s: THREE.Vector3; mat: number; tint: number; emit: number }
interface Built { parts: Part[]; x: number; z: number; r: number; far: boolean; smoke: { x: number; y: number; z: number; r: number }[] }

/** Builds one item's parts in its local frame (x right, z back, y up; three's yaw convention) on the CPU ground. */
export class Builder {
  readonly parts: Part[] = [];
  readonly smoke: { x: number; y: number; z: number; r: number }[] = [];
  private c: number; private s: number;
  constructor(readonly ox: number, readonly oz: number, readonly yaw: number, readonly ground: (x: number, z: number) => number, readonly tint: number) {
    this.c = Math.cos(yaw); this.s = Math.sin(yaw);
  }
  /** local (lx, lz) -> world (x, z) */
  at(lx: number, lz: number): [number, number] { return [this.ox + lx * this.c + lz * this.s, this.oz - lx * this.s + lz * this.c]; }
  g(lx: number, lz: number) { const [x, z] = this.at(lx, lz); return this.ground(x, z); }
  /** a piece at local (lx, lz), y = its own ground + dy (or base + dy when `base` is given) */
  add(shape: Shape, lx: number, dy: number, lz: number, sx: number, sy: number, sz: number, mat: number, o: { yaw?: number; pitch?: number; roll?: number; base?: number; tint?: number; emit?: number } = {}) {
    const [x, z] = this.at(lx, lz);
    const y = (o.base ?? this.ground(x, z)) + dy;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(o.pitch ?? 0, this.yaw + (o.yaw ?? 0), o.roll ?? 0, 'YXZ'));
    this.parts.push({ shape, x, y, z, q, s: new THREE.Vector3(sx, sy, sz), mat, tint: o.tint ?? this.tint, emit: o.emit ?? 0 });
  }
  /** a thin box from world-local point a to b (wires, cables, chains): local coords + absolute world heights */
  span(ax: number, ay: number, az: number, bx: number, by: number, bz: number, t: number, mat: number) {
    const [wax, waz] = this.at(ax, az), [wbx, wbz] = this.at(bx, bz);
    const A = new THREE.Vector3(wax, ay, waz), B = new THREE.Vector3(wbx, by, wbz);
    const L = A.distanceTo(B);
    if (L < 0.05) return;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), B.clone().sub(A).normalize());
    const m = A.clone().add(B).multiplyScalar(0.5);
    this.parts.push({ shape: 'box', x: m.x, y: m.y - 0.5 * t, z: m.z, q, s: new THREE.Vector3(t, t, L), mat, tint: 0.3, emit: 0 });
  }
}

export class DesertMarks {
  readonly group = new THREE.Group();
  readonly kit: KitLayer;
  /** the biome at a journey distance (the voyage maps its chapters onto biomes; default: the desert's own regions) */
  biomeAt: BiomeAt;
  /** the side enemies come from (+1 starboard, -1 port): tall near things keep out of their band */
  dangerSide: 1 | -1 = -1;
  private quality = 'high';
  private key = '';
  private K = [NaN, NaN, NaN, NaN];
  private cache = new Map<string, Built>();
  private bver = 0;
  private memo = new Map<number, ReturnType<BiomeAt>>();
  /** smoke emitters (terrain-local, rebuilt with the set) for the life layer */
  smoke: { x: number; y: number; z: number; r: number }[] = [];
  /** salt zones (terrain-local x, z, radius, strength) for the terrain shader */
  saltZ: [number, number, number, number][] = [];
  stats = { near: 0, mid: 0, lines: 0, walls: 0, marks: 0, gates: 0, far: 0, hidden: 0, instances: 0, draws: 0, rebuilds: 0, biome: '', kinds: {} as Record<string, number> };
  private rp: RoutePoint = { x: 0, z: 0, heading: 0, curv: 0 };

  constructor(private spec: DesertWorldSpec, du: DesertUniforms, clip: HeightClipmap) {
    this.group.name = 'vtp:desert:marks';
    this.biomeAt = defaultBiomeAt(spec.seed);
    this.kit = new KitLayer('marks', du, clip, {
      box: 3200, cyl: 1400, cone: 200, dome: 160, hull: 80, rock: 2000, crag: 400, arch: 24, rib: 500, mesa: 120, spire: 60, scrub: 1600,
      liner: 40, walkerbody: 40, leg: 260, lattice: 140, truss: 12, chimney: 160, pole: 700, palm: 700, cliff: 700, hoodoo: 400, lighthouse: 24,
      deadtree: 300, arcade: 300, tank: 160, prism: 160, girder: 500,
    });
    this.group.add(this.kit.group);
  }

  setQuality(q: string) { this.quality = q; this.key = ''; }
  /** replace the biome provider (cached items keep their biome in their key: a changed biome rebuilds just them) */
  setBiomeAt(f: BiomeAt | null) { this.biomeAt = f ?? defaultBiomeAt(this.spec.seed); this.bver++; this.memo.clear(); this.key = ''; }
  invalidate() { this.key = ''; }

  /** biome lookups memoised per 10 m during one rebuild (a voyage chapter lookup is not free) */
  private bAt = (d: number) => {
    const k = Math.floor(d / 10);
    let b = this.memo.get(k);
    if (!b) { b = this.biomeAt(k * 10 + 5); this.memo.set(k, b); }
    return b;
  };

  update(w: DesertWorld, f: DesertFrame, _L: DesertLight) {
    const O = w.origin();
    const kd = Math.floor(f.d / STEP);
    const K = this.K;
    if (this.key !== '' && K[0] === kd && K[1] === O.x && K[2] === O.z && K[3] === this.bver) return;
    this.key = 'built'; K[0] = kd; K[1] = O.x; K[2] = O.z; K[3] = this.bver;
    this.rebuild(w, (kd + 0.5) * STEP);
  }

  private rebuild(w: DesertWorld, d: number) {
    const O = w.origin();
    this.memo.clear();                     // (a voyage pacing change can move chapter boundaries: never keep stale biomes)
    const seed = this.spec.seed, bAt = this.bAt, q = this.quality;
    const keep = new Set<string>();
    const list: KitInstance[] = [];
    const smoke: { x: number; y: number; z: number; r: number }[] = [];
    const st = { near: 0, mid: 0, lines: 0, walls: 0, marks: 0, gates: 0, far: 0, hidden: 0 };
    const discs = this.discs(w);
    const shipP = w.route.at(d, this.rp);
    const sx0 = shipP.x, sz0 = shipP.z;
    const put = (key: string, make: () => Built, count: keyof typeof st) => {
      keep.add(key);
      let b = this.cache.get(key);
      if (!b) { b = make(); this.cache.set(key, b); }
      if (!b.parts.length) return;
      for (const c of discs) if (Math.hypot(b.x - c.x, b.z - c.z) < c.r + b.r) { st.hidden++; return; }
      st[count]++;
      const farNow = b.far || Math.hypot(b.x - sx0, b.z - sz0) > 1300;
      const anchor = new THREE.Vector3(b.x - O.x, 0, b.z - O.z);
      for (const p of b.parts) {
        const pos = new THREE.Vector3(p.x - O.x, p.y, p.z - O.z);
        if (!farNow) anchor.copy(pos); else anchor.y = p.y;
        list.push({ shape: p.shape, m: new THREE.Matrix4().compose(pos, p.q, p.s), mat: p.mat, tint: p.tint, emit: p.emit, compressed: farNow, anchor: farNow ? anchor.clone() : pos });
      }
      for (const s of b.smoke) smoke.push({ x: s.x - O.x, y: s.y, z: s.z - O.z, r: s.r });
    };
    // near (both sides) + lines + walls
    const a0 = d - (NEAR_BEHIND[q] ?? 550), a1 = d + (NEAR_AHEAD[q] ?? 1150);
    for (let i = Math.floor(a0 / NEAR_CELL); i * NEAR_CELL < a1; i++) {
      for (const side of [1, -1] as const) {
        const key = `n${i}:${side}:${bAt((i + 0.5) * NEAR_CELL)}`;
        put(key, () => this.buildNear(w, nearCell(seed, i, side, bAt, this.dangerSide)), 'near');
      }
    }
    // mid-range clusters (both sides, a little further ahead than the near things: they stay visible longer)
    for (let i = Math.floor((a0 - 200) / MID_CELL); i * MID_CELL < a1 + 600; i++) {
      for (const side of [1, -1] as const) {
        const key = `i${i}:${side}:${bAt((i + 0.5) * MID_CELL)}`;
        put(key, () => this.buildMid(w, midCell(seed, i, side, bAt, this.dangerSide)), 'mid');
      }
    }
    const lines = lineItems(seed, a0 - 300, a1 + 300, bAt);
    for (let k = 0; k < lines.length; k++) {
      const L = lines[k], N = lines[k + 1];
      const next = N && N.region === L.region && N.kind === L.kind && N.s - L.s < (L.kind === 'pole' ? 90 : 480) ? N : null;
      put(`l${L.id}:${next ? next.id : 0}:${bAt(L.s)}`, () => this.buildLine(w, L, next), 'lines');
    }
    for (const W of wallItems(seed, a0 - 600, a1 + 700, bAt)) put(`w${W.id}:${bAt(W.s)}`, () => this.buildWall(w, W), 'walls');
    // landmarks + gates
    const m0 = d - 1800, m1 = d + (MARK_AHEAD[q] ?? 3800);
    for (let j = Math.floor(m0 / MARK_CELL); j * MARK_CELL < m1; j++) {
      const items = markCell(seed, j, bAt, this.dangerSide);
      items.forEach((m, k) => put(`m${j}:${k}:${m.kind}:${m.biome}`, () => this.buildMark(w, m), 'marks'));
    }
    for (let r = Math.floor(m0 / REGION_LEN); r * REGION_LEN < m1; r++) {
      const g = regionGate(seed, r, bAt);
      if (g) put(`g${r}:${g.kind}`, () => this.buildGate(w, g), 'gates');
    }
    // horizon megastructures
    const f0 = d - 6000, f1 = d + (FAR_AHEAD[q] ?? 20000);
    for (let k = Math.floor(f0 / FAR_CELL); k * FAR_CELL < f1; k++) for (const it of farCell(seed, k, bAt)) put(`f${it.id}:${it.kind}`, () => this.buildFar(w, it), 'far');
    for (const k of [...this.cache.keys()]) if (!keep.has(k)) this.cache.delete(k);
    this.kit.fill(list);
    this.smoke = smoke.slice(0, 24);
    // salt zones: the salt-heavy regions around the ship, as discs on the route
    const zones: [number, number, number, number][] = [];
    for (let r = Math.floor((d - REGION_LEN) / REGION_LEN); r <= Math.floor((d + REGION_LEN * 1.5) / REGION_LEN) && zones.length < 2; r++) {
      const mid = (r + 0.5) * REGION_LEN, sk = BIOME_RULES[bAt(mid)].salt;
      if (sk <= 0.05) continue;
      const p = w.route.at(mid, this.rp);
      zones.push([p.x - O.x, p.z - O.z, REGION_LEN * 0.62, sk]);
    }
    this.saltZ = zones;
    const kinds: Record<string, number> = {};
    for (const it of list) kinds[it.shape] = (kinds[it.shape] ?? 0) + 1;
    this.stats = { ...st, instances: list.length, draws: this.kit.draws, rebuilds: this.stats.rebuilds + 1, biome: bAt(d), kinds };
  }

  /** world discs nothing stands in: the voyage's flats (dig sites, settlements), cities, keep-outs */
  private discs(w: DesertWorld): { x: number; z: number; r: number }[] {
    const out: { x: number; z: number; r: number }[] = [];
    for (const f of w.spec.flats) out.push({ x: f.x, z: f.z, r: f.r + 10 });
    for (const c of w.cities()) out.push({ x: c.x, z: c.z, r: c.radius * 1.2 + 60 });
    for (const k of w.keepOuts()) out.push(k);
    return out;
  }

  // ------------------------------------------------------------------ builders
  private place(w: DesertWorld, s: number, lat: number) {
    const p = w.route.at(s, { x: 0, z: 0, heading: 0, curv: 0 });
    const [ox, oz] = DesertRoute.toWorld(p.heading, lat, 0);
    return { x: p.x + ox, z: p.z + oz, heading: p.heading };
  }
  private gr = (x: number, z: number) => heightAt(this.spec, x, z);

  private buildNear(w: DesertWorld, items: NearItem[]): Built {
    const all: Part[] = [];
    let cx = 0, cz = 0;
    for (const it of items) {
      const P = this.place(w, it.s, it.lat);
      cx += P.x; cz += P.z;
      const B = new Builder(P.x, P.z, it.yaw, this.gr, rnd(it.id, 1));
      const r = (k: number) => rnd(it.id, k);
      const sc = it.scale;
      switch (it.kind) {
        case 'boulder': {
          const n = 1 + Math.floor(r(2) * 3);
          for (let k = 0; k < n; k++) { const s = (2 + 4 * r(3 + k)) * sc * (k ? 0.5 : 1); B.add('rock', (r(10 + k) - 0.5) * 6, -s * 0.2, (r(20 + k) - 0.5) * 6, s * (0.9 + 0.4 * r(30 + k)), s * (0.55 + 0.4 * r(40 + k)), s, MAT.stone, { yaw: r(50 + k) * 6 }); }
          break;
        }
        case 'pillar':
          if (r(2) < 0.5) B.add('hoodoo', 0, -1, 0, (5 + 4 * r(3)) * sc, (12 + 18 * r(4)) * sc, (5 + 4 * r(3)) * sc, MAT.stone);
          else B.add('crag', 0, -1.5, 0, (4 + 4 * r(3)) * sc, (10 + 20 * r(4)) * sc, (4 + 3 * r(5)) * sc, MAT.stone, { pitch: (r(6) - 0.5) * 0.12, roll: (r(7) - 0.5) * 0.12 });
          B.add('rock', 3 * sc, -0.6, 2 * sc, 3 * sc, 1.6 * sc, 2.6 * sc, MAT.stone);
          break;
        case 'scrub':
          for (let k = 0; k < 3; k++) B.add('scrub', (r(2 + k) - 0.5) * 8, -0.05, (r(5 + k) - 0.5) * 8, (1.2 + 1.4 * r(8 + k)) * sc, (1 + 1.2 * r(11 + k)) * sc, (1.2 + 1.4 * r(8 + k)) * sc, MAT.scrub, { yaw: r(14 + k) * 6 });
          break;
        case 'deadtree':
          B.add('deadtree', 0, -0.3, 0, (5 + 3 * r(2)) * sc, (6 + 5 * r(3)) * sc, (5 + 3 * r(2)) * sc, MAT.wood, { roll: (r(4) - 0.5) * 0.2 });
          B.add('scrub', 1.5, -0.05, 1, 1.6, 1.2, 1.6, MAT.scrub);
          break;
        case 'bones': {
          const len = (8 + 10 * r(2)) * sc, n = 5;
          for (let k = 0; k < n; k++) { const t = k / (n - 1); const wd = len * 0.5 * Math.sin(Math.PI * (0.2 + 0.7 * t)); B.add('rib', 0, -wd * 0.25, -len / 2 + t * len, wd, wd * 0.85, 2.2, MAT.bone, { roll: (r(10 + k) - 0.5) * 0.4 }); }
          B.add('rock', 0, -0.6, -len * 0.62, len * 0.22, len * 0.14, len * 0.28, MAT.bone, { pitch: 0.2 });
          break;
        }
        case 'debris': {
          const n = 2 + Math.floor(r(2) * 4);
          for (let k = 0; k < n; k++) {
            const lx = (r(3 + k) - 0.5) * 10, lz = (r(9 + k) - 0.5) * 10, u = r(15 + k);
            if (u < 0.45) { const s = 1 + 1.2 * r(21 + k); B.add('box', lx, -0.4 * s, lz, s, s, s * (1 + r(27 + k)), MAT.wood, { yaw: r(33 + k) * 3, roll: (r(39 + k) - 0.5) * 0.6 }); }
            else if (u < 0.8) B.add('cyl', lx, -0.15, lz, 0.9, 1.3, 0.9, r(45 + k) < 0.5 ? MAT.rust : MAT.iron, { pitch: r(51 + k) < 0.4 ? Math.PI / 2 : 0 });
            else B.add('cyl', lx, 0.2, lz, 1.4, 7 + 6 * r(57 + k), 1.4, MAT.iron, { pitch: Math.PI / 2 - 0.1, yaw: r(63 + k) * 3 });
          }
          break;
        }
        case 'post':
          if (r(2) < 0.5) {
            B.add('cyl', 0, -0.5, 0, 0.35, 4 + 2 * r(3), 0.35, MAT.wood, { roll: (r(4) - 0.5) * 0.15 });
            B.add('box', 0.35, 3, 0, 0.05, 1.1, 0.5, MAT.cloth, { yaw: 0.3 });
          } else for (let k = 0; k < 4; k++) B.add('rock', 0, -0.2 + k * 0.75, 0, 1.6 - k * 0.3, 0.9, 1.5 - k * 0.3, MAT.stone, { yaw: k * 1.3 });
          break;
        case 'girder': {
          const n = 1 + Math.floor(r(2) * 3);
          for (let k = 0; k < n; k++) B.add('girder', (r(3 + k) - 0.5) * 8, -2, (r(6 + k) - 0.5) * 8, 0.5, (7 + 9 * r(9 + k)) * sc, 0.6, r(12 + k) < 0.6 ? MAT.rust : MAT.iron, { pitch: (r(15 + k) - 0.5) * 0.9, roll: (r(18 + k) - 0.5) * 0.7 });
          break;
        }
        case 'palm': {
          const n = 1 + Math.floor(r(2) * 3);
          for (let k = 0; k < n; k++) { const s = (8 + 5 * r(3 + k)) * sc; B.add('palm', (r(6 + k) - 0.5) * 9, -0.3, (r(9 + k) - 0.5) * 9, s, s, s, MAT.wood, { yaw: r(12 + k) * 6 }); }
          B.add('scrub', 0, -0.05, 0, 2.4, 1.4, 2.4, MAT.scrub);
          break;
        }
        case 'saltmound':
          B.add('rock', 0, -0.4, 0, (4 + 4 * r(2)) * sc, (0.9 + 1.2 * r(3)) * sc, (4 + 4 * r(4)) * sc, MAT.salt);
          break;
      }
      all.push(...B.parts);
    }
    const n = Math.max(1, items.length);
    return { parts: all, x: cx / n, z: cz / n, r: 10, far: false, smoke: [] };
  }

  private buildMid(w: DesertWorld, items: MidItem[]): Built {
    const all: Part[] = [];
    let cx = 0, cz = 0;
    for (const it of items) {
      const P = this.place(w, it.s, it.lat);
      cx += P.x; cz += P.z;
      const B = new Builder(P.x, P.z, it.yaw, this.gr, rnd(it.id, 1));
      const r = (k: number) => rnd(it.id, k);
      const sc = it.scale;
      switch (it.kind) {
        case 'boulders': for (let k = 0; k < 4 + Math.floor(r(2) * 5); k++) { const s = (3 + 7 * r(3 + k) ** 1.5) * sc; B.add('rock', (r(10 + k) - 0.5) * 30, -s * 0.25, (r(20 + k) - 0.5) * 30, s * 1.2, s * 0.7, s, MAT.stone, { yaw: r(30 + k) * 6 }); } break;
        case 'crags': for (let k = 0; k < 2 + Math.floor(r(2) * 3); k++) { const h = (8 + 18 * r(3 + k)) * sc; B.add('crag', (r(10 + k) - 0.5) * 26, -1.5, (r(20 + k) - 0.5) * 26, h * 0.6, h, h * 0.5, MAT.stone, { yaw: r(30 + k) * 6, roll: (r(40 + k) - 0.5) * 0.15 }); } break;
        case 'scrubs': for (let k = 0; k < 6 + Math.floor(r(2) * 8); k++) B.add('scrub', (r(10 + k) - 0.5) * 34, -0.05, (r(20 + k) - 0.5) * 34, 2 + 2.4 * r(30 + k), 1.5 + 1.6 * r(40 + k), 2 + 2.4 * r(30 + k), MAT.scrub, { yaw: r(50 + k) * 6 }); break;
        case 'fence': {
          // a sand fence: a line of leaning posts with slats, half drifted over
          const n = 10 + Math.floor(r(2) * 10);
          for (let k = 0; k < n; k++) { if (r(10 + k) < 0.15) continue; B.add('box', (k - n / 2) * 3.2, -0.6, 0, 0.18, 2.4 + 0.6 * r(20 + k), 0.18, MAT.wood, { roll: (r(30 + k) - 0.5) * 0.3 }); }
          for (const y of [0.7, 1.5]) B.add('box', 0, y, 0, n * 3.2 * 0.9, 0.12, 0.06, MAT.wood, { roll: (r(40) - 0.5) * 0.05 });
          break;
        }
        case 'smallwreck': {
          const len = (12 + 12 * r(2)) * sc;
          B.add('hull', 0, -len * 0.12, 0, len * 0.3, len * 0.28, len, r(3) < 0.5 ? MAT.rust : MAT.wood, { roll: (0.3 + 0.4 * r(4)) * (r(5) < 0.5 ? -1 : 1), pitch: (r(6) - 0.5) * 0.4 });
          B.add('cyl', len * 0.1, -0.5, 0, 0.4, len * 0.5, 0.4, MAT.wood, { roll: 0.5 + 0.4 * r(7) });
          break;
        }
        case 'rubble':
          for (let k = 0; k < 5 + Math.floor(r(2) * 6); k++) { const s = 2 + 5 * r(3 + k); B.add(r(9 + k) < 0.6 ? 'box' : 'rock', (r(10 + k) - 0.5) * 30, -0.6, (r(20 + k) - 0.5) * 30, s, s * (0.5 + r(30 + k)), s * 0.8, MAT.adobe, { yaw: r(40 + k) * 6, roll: (r(50 + k) - 0.5) * 0.4 }); }
          B.add('box', 0, -0.5, 0, (8 + 10 * r(4)) * sc, (3 + 6 * r(5)) * sc, 1.4, MAT.adobe, { roll: (r(6) - 0.5) * 0.1 });
          break;
        case 'stumps': for (let k = 0; k < 3 + Math.floor(r(2) * 5); k++) B.add('cyl', (r(10 + k) - 0.5) * 24, -0.4, (r(20 + k) - 0.5) * 24, 1.6, 2 + 6 * r(30 + k), 1.6, MAT.plaster, { roll: (r(40 + k) - 0.5) * 0.12 }); break;
        case 'pipes':
          for (let k = 0; k < 2 + Math.floor(r(2) * 3); k++) B.add('cyl', (r(10 + k) - 0.5) * 10, 0.4 + k * 0.1, (r(20 + k) - 0.5) * 8, 1.8, 20 + 30 * r(30 + k), 1.8, k % 2 ? MAT.rust : MAT.iron, { pitch: Math.PI / 2, yaw: (r(40 + k) - 0.5) * 0.3 });
          B.add('box', 0, -0.3, 6, 3, 2.5, 3, MAT.iron);
          break;
        case 'tents': for (let k = 0; k < 2 + Math.floor(r(2) * 3); k++) B.add('cone', (r(10 + k) - 0.5) * 22, -0.2, (r(20 + k) - 0.5) * 22, 6 + 3 * r(30 + k), 4 + 2 * r(40 + k), 5 + 3 * r(30 + k), MAT.cloth, { yaw: r(50 + k) * 6, emit: 0.35 }); break;
        case 'cart':
          B.add('box', 0, 0.6, 0, 3, 1.4, 6, MAT.wood, { roll: 0.2, pitch: (r(2) - 0.5) * 0.2 });
          for (const sx of [-1, 1]) B.add('cyl', sx * 1.7, 0.2, 1.2, 1.8, 0.3, 1.8, MAT.wood, { roll: Math.PI / 2 });
          B.add('box', 0, -0.2, 4.5, 0.2, 0.2, 4, MAT.wood, { pitch: 0.2 });
          break;
        case 'pinnacles': {
          // tall eroded spires: they stand above the dune crests, so the deck sees them slide past
          const n = 1 + Math.floor(r(2) * 3);
          for (let k = 0; k < n; k++) { const h = (22 + 30 * r(3 + k)) * sc; B.add(r(9 + k) < 0.5 ? 'hoodoo' : 'crag', (r(10 + k) - 0.5) * 30, -2, (r(20 + k) - 0.5) * 30, h * 0.32, h, h * 0.3, MAT.stone, { yaw: r(30 + k) * 6, roll: (r(40 + k) - 0.5) * 0.1 }); }
          B.add('rock', 4, -1, 3, 7, 3.5, 6, MAT.stone);
          break;
        }
        case 'crane': {
          // a derelict harbour / works crane: lattice tower, a jib, the hook cable
          const H = (26 + 14 * r(2)) * sc, J = H * 0.9;
          B.add('lattice', 0, -0.5, 0, 4.5, H, 4.5, MAT.rust);
          B.add('truss', J * 0.35, H - 2, 0, J, 2.2, 2.2, MAT.rust, { roll: (r(3) - 0.5) * 0.12 });
          B.add('cyl', J * 0.75, H - 14, 0, 0.12, 12, 0.12, MAT.iron);
          B.add('box', J * 0.75, H - 15.5, 0, 1.4, 1.5, 0.6, MAT.rust);
          break;
        }
        case 'masts': {
          // a buried ship: only its masts and a sliver of the deck show
          for (let k = 0; k < 2 + Math.floor(r(2) * 2); k++) { const h = (16 + 12 * r(3 + k)) * sc; B.add('cyl', 0, -2, (k - 1) * 14 * sc, 0.55, h, 0.55, MAT.wood, { roll: (r(10 + k) - 0.5) * 0.35, pitch: (r(20 + k) - 0.5) * 0.2 }); B.add('box', 0, h * 0.7 - 2, (k - 1) * 14 * sc, 9 * sc, 0.4, 0.4, MAT.wood, { roll: (r(30 + k) - 0.5) * 0.3 }); }
          B.add('box', 0, -1.2, 0, 7 * sc, 2, 34 * sc, MAT.wood, { roll: 0.2 });
          break;
        }
        case 'bonepile': {
          const len = (10 + 10 * r(2)) * sc;
          for (let k = 0; k < 6; k++) { const t = k / 5; const wd = len * 0.45 * Math.sin(Math.PI * (0.2 + 0.7 * t)); B.add('rib', 0, -wd * 0.3, -len / 2 + t * len, wd, wd * 0.8, 2, MAT.bone, { roll: (r(10 + k) - 0.5) * 0.5 }); }
          break;
        }
      }
      all.push(...B.parts);
    }
    const n = Math.max(1, items.length);
    return { parts: all, x: cx / n, z: cz / n, r: 18, far: false, smoke: [] };
  }

  private buildLine(w: DesertWorld, L: LineItem, N: LineItem | null): Built {
    const P = this.place(w, L.s, L.lat);
    const yaw = -P.heading;
    const B = new Builder(P.x, P.z, yaw, this.gr, rnd(L.id, 1));
    const g0 = this.gr(P.x, P.z);
    if (L.kind === 'pole') {
      const H = 8.5;
      if (L.fallen) B.add('pole', 0, 0.3, 0, H, H, H, MAT.wood, { pitch: 1.45, base: g0 });
      else {
        B.add('pole', 0, -0.4, 0, H, H, H, MAT.wood, { roll: L.lean, base: g0 });
        if (N && !N.fallen) {
          const Q = this.place(w, N.s, N.lat);
          const gN = this.gr(Q.x, Q.z);
          // the next pole in this pole's local frame (wires: 2 per span, a sag of 0.7 m in the middle)
          const dx = Q.x - P.x, dz = Q.z - P.z, c = Math.cos(yaw), s = Math.sin(yaw);
          const nlx = dx * c - dz * s, nlz = dx * s + dz * c;
          for (const ox of [-0.94, 0.94]) {
            const y0 = g0 - 0.4 + H * 0.94, y1 = gN - 0.4 + H * 0.94, ym = (y0 + y1) / 2 - 0.7;
            B.span(ox, y0, 0, (ox + nlx + ox) / 2, ym, nlz / 2, 0.05, MAT.iron);
            B.span((ox + nlx + ox) / 2, ym, nlz / 2, nlx + ox, y1, nlz, 0.05, MAT.iron);
          }
        }
      }
    } else {
      const H = 36, Wd = 8;
      B.add('lattice', 0, -0.5, 0, Wd, H, Wd, MAT.iron, { base: g0 });
      if (N) {
        const Q = this.place(w, N.s, N.lat);
        const gN = this.gr(Q.x, Q.z);
        const dx = Q.x - P.x, dz = Q.z - P.z, c = Math.cos(yaw), s = Math.sin(yaw);
        const nlx = dx * c - dz * s, nlz = dx * s + dz * c;
        for (const ox of [-5.6, 0, 5.6]) {
          const y0 = g0 - 0.5 + H * (ox ? 0.88 : 1.0), y1 = gN - 0.5 + H * (ox ? 0.88 : 1.0);
          const pts = [0, 0.25, 0.5, 0.75, 1].map((t) => [ox + nlx * t, y0 + (y1 - y0) * t - 7 * 4 * t * (1 - t), nlz * t]);
          for (let k = 0; k + 1 < pts.length; k++) B.span(pts[k][0], pts[k][1], pts[k][2], pts[k + 1][0], pts[k + 1][1], pts[k + 1][2], 0.12, MAT.iron);
        }
      }
    }
    return { parts: B.parts, x: P.x, z: P.z, r: L.kind === 'pole' ? 2 : 6, far: false, smoke: [] };
  }

  private buildWall(w: DesertWorld, W: WallItem): Built {
    const P = this.place(w, W.s, W.lat);
    const B = new Builder(P.x, P.z, -P.heading + Math.PI / 2 + W.yaw, this.gr, rnd(W.id, 1));
    const g = Math.min(B.g(-W.w * 0.4, 0), B.g(W.w * 0.4, 0), B.g(0, 0));
    // mostly ridge pieces (the mesa profile: talus skirt, cliff band, cap rim) that overlap into one wall; now and then
    // a sheer slab face
    if (W.variant === 0) B.add('cliff', 0, -6, 0, W.w * 1.2, W.h + 6, 40 + 12 * rnd(W.id, 2), MAT.stone, { base: g });
    else B.add('mesa', 0, -5, 0, W.w * 0.55, W.h + 5, 20 + 8 * rnd(W.id, 2), MAT.stone, { base: g, yaw: (rnd(W.id, 4) - 0.5) * 0.3 });
    // talus on the route side
    const inward = W.lat > 0 ? 1 : -1;
    for (let k = 0; k < 3; k++) { const s = 5 + 8 * rnd(W.id, 3 + k); B.add('rock', (rnd(W.id, 6 + k) - 0.5) * W.w, -s * 0.25, inward * (14 + 10 * rnd(W.id, 9 + k)), s, s * 0.6, s, MAT.stone); }
    return { parts: B.parts, x: P.x, z: P.z, r: W.w * 0.5, far: false, smoke: [] };
  }

  private buildMark(w: DesertWorld, m: MarkItem): Built {
    const P = this.place(w, m.s, m.lat);
    const B = new Builder(P.x, P.z, m.yaw, this.gr, rnd(m.id, 1));
    const r = (k: number) => rnd(m.id, k);
    const sc = m.scale;
    let R = 30;
    switch (m.kind) {
      case 'liner': {
        const len = (170 + 90 * r(2)) * sc, wid = len * 0.14, H = len * 0.24;
        B.add('liner', 0, -H * 0.16, 0, wid, H, len, MAT.paint, { roll: (0.12 + 0.18 * r(3)) * (r(4) < 0.5 ? -1 : 1), pitch: (r(5) - 0.5) * 0.08 });
        // a funnel that fell off, plates and drifts of debris
        B.add('cyl', wid * 1.4, -1, len * 0.15, wid * 0.11, H * 0.24, wid * 0.11, MAT.rust, { pitch: Math.PI / 2 - 0.15, yaw: 0.7 });
        for (let k = 0; k < 6; k++) B.add('box', (r(10 + k) - 0.5) * wid * 4, -1, (r(20 + k) - 0.5) * len, 3 + 5 * r(30 + k), 0.4, 4 + 6 * r(40 + k), MAT.rust, { roll: (r(50 + k) - 0.5) * 1.2, pitch: (r(60 + k) - 0.5) * 0.8 });
        R = len * 0.55;
        break;
      }
      case 'deadwalker': R = this.deadWalker(B, m.id, 32 * sc); break;
      case 'lighthouse': {
        B.add('crag', 0, -2, 0, 22 * sc, 8 * sc, 20 * sc, MAT.stone);
        const g0 = B.g(0, 0) + 5 * sc;
        B.add('lighthouse', 0, 0, 0, 8 * sc, 34 * sc, 8 * sc, MAT.plaster, { base: g0, emit: 0.3 });
        B.add('box', 7 * sc, 0, 4 * sc, 7 * sc, 4 * sc, 6 * sc, MAT.plaster, { base: g0, emit: 0.6 });
        B.add('prism', 7 * sc, 4 * sc, 4 * sc, 7.4 * sc, 2.4 * sc, 6.4 * sc, MAT.rust, { base: g0 });
        R = 16 * sc;
        break;
      }
      case 'factory': {
        const g0 = B.g(0, 0) - 1.5;
        const L = 46 * sc, D = 26 * sc, H = 15 * sc;
        B.add('box', 0, 0, 0, L, H, D, MAT.adobe, { base: g0, emit: 0.55 });
        for (let k = 0; k < 4; k++) B.add('prism', -L / 2 + L * (k + 0.5) / 4, H, 0, L / 4, 5 * sc, D, MAT.iron, { base: g0, yaw: 0 });
        const nc = 2 + Math.floor(r(2) * 3);
        for (let k = 0; k < nc; k++) {
          const cx = -L / 2 + 6 + (L - 12) * (k + 0.5) / nc, cz = D / 2 + 8 * sc, ch = (42 + 26 * r(3 + k)) * sc, cr = 6.5 * sc;
          B.add('chimney', cx, 0, cz, cr, ch, cr, MAT.adobe, { base: g0 });
          const [wx, wz] = B.at(cx, cz);
          B.smoke.push({ x: wx, y: g0 + ch, z: wz, r: cr * 0.35 });
        }
        for (let k = 0; k < 2; k++) B.add('tank', -L / 2 - 14 * sc, 0, -D / 2 + 13 * sc * k, 12 * sc, 11 * sc, 12 * sc, MAT.plaster, { base: g0 });
        B.add('lattice', L / 2 + 12 * sc, 0, -6 * sc, 7 * sc, 30 * sc, 7 * sc, MAT.iron, { base: g0 });
        R = L * 0.8;
        break;
      }
      case 'pylon': B.add('lattice', 0, -0.5, 0, 16 * sc, 70 * sc, 16 * sc, MAT.iron); R = 12 * sc; break;
      case 'tanks': {
        const n = 3 + Math.floor(r(2) * 4), g0 = B.g(0, 0) - 1;
        for (let k = 0; k < n; k++) { const s = (16 + 10 * r(3 + k)) * sc; B.add('tank', (k % 3) * 30 * sc - 30 * sc, 0, Math.floor(k / 3) * 30 * sc, s, s * 0.8, s, k % 2 ? MAT.plaster : MAT.paint, { base: g0 }); }
        B.add('cyl', 0, 6, -14 * sc, 1.6 * sc, 90 * sc, 1.6 * sc, MAT.iron, { pitch: Math.PI / 2, yaw: Math.PI / 2, base: g0 });
        R = 55 * sc;
        break;
      }
      case 'aqueduct': {
        const n = 9 + Math.floor(r(2) * 9), bay = 15 * sc, H = 19 * sc;
        const g0 = B.g(0, 0) - 2;
        for (let k = 0; k < n; k++) {
          const lx = (k - (n - 1) / 2) * bay;
          if (r(10 + k) < 0.22) { B.add('rock', lx, -1, 0, bay * 0.7, 3, bay * 0.6, MAT.stone); continue; }   // a collapsed bay
          B.add('arcade', lx, 0, 0, bay, H, bay, MAT.adobe, { base: Math.min(g0, B.g(lx, 0) - 1.5) });
        }
        R = n * bay * 0.5;
        break;
      }
      case 'temple': {
        const g0 = B.g(0, 0) - 0.5, Wd = 34 * sc, Dp = 22 * sc, ch = 12 * sc;
        B.add('box', 0, 0, 0, Wd, 2.2 * sc, Dp, MAT.plaster, { base: g0 });
        for (const zz of [-1, 1]) for (let k = 0; k < 6; k++) {
          const lx = -Wd / 2 + 2.5 * sc + (Wd - 5 * sc) * k / 5, lz = zz * (Dp / 2 - 2.5 * sc);
          if (r(20 + k + (zz > 0 ? 10 : 0)) < 0.3) B.add('cyl', lx + 3 * sc, 2.2 * sc + 1, lz, 2.2 * sc, ch, 2.2 * sc, MAT.plaster, { base: g0, pitch: Math.PI / 2 - 0.05, yaw: r(40 + k) * 3 });
          else { B.add('cyl', lx, 2.2 * sc, lz, 2.2 * sc, ch * (0.6 + 0.4 * r(50 + k)), 2.2 * sc, MAT.plaster, { base: g0 }); }
        }
        if (r(3) < 0.6) B.add('prism', -Wd * 0.2, 2.2 * sc + ch, 0, Wd * 0.55, 5 * sc, Dp, MAT.plaster, { base: g0, roll: 0.08 });
        R = Wd * 0.7;
        break;
      }
      case 'watchtower': {
        const g0 = B.g(0, 0) - 1, H = (20 + 10 * r(2)) * sc;
        if (r(3) < 0.5) { B.add('box', 0, 0, 0, 7 * sc, H, 7 * sc, MAT.adobe, { base: g0, emit: 0.4 }); B.add('box', 0, H, 0, 9 * sc, 3 * sc, 9 * sc, MAT.adobe, { base: g0, emit: 0.4 }); B.add('prism', 0, H + 3 * sc, 0, 9.5 * sc, 4 * sc, 9.5 * sc, MAT.wood, { base: g0 }); }
        else { B.add('cyl', 0, 0, 0, 8 * sc, H, 8 * sc, MAT.adobe, { base: g0, emit: 0.4 }); B.add('cone', 0, H, 0, 10 * sc, 7 * sc, 10 * sc, MAT.wood, { base: g0 }); }
        B.add('cyl', 0, H + 6 * sc, 0, 0.3, 7 * sc, 0.3, MAT.wood, { base: g0 });
        B.add('box', 0.9 * sc + 0.2, H + 11 * sc, 0, 2.2 * sc, 1.3 * sc, 0.06, MAT.cloth, { base: g0 });
        for (let k = 0; k < 3; k++) B.add('box', (r(10 + k) - 0.5) * 30 * sc, 0, (r(20 + k) - 0.5) * 30 * sc, 10 * sc, 3 * sc, 1.2, MAT.adobe, { yaw: r(30 + k) * 3 });
        R = 18 * sc;
        break;
      }
      case 'butte': B.add('mesa', 0, -4, 0, (40 + 50 * r(2)) * sc, (50 + 60 * r(3)) * sc, (36 + 40 * r(4)) * sc, MAT.stone); R = 90 * sc; break;
      case 'hoodoos': {
        const n = 4 + Math.floor(r(2) * 6);
        for (let k = 0; k < n; k++) { const a = r(3 + k) * 6.28, rr = 6 + 26 * r(13 + k); const h = (14 + 26 * r(23 + k)) * sc; B.add('hoodoo', Math.cos(a) * rr, -1.5, Math.sin(a) * rr, h * 0.38, h, h * 0.38, MAT.stone, { yaw: r(33 + k) * 6 }); }
        R = 36;
        break;
      }
      case 'arch': { const span = (48 + 30 * r(2)) * sc, h = span * (0.55 + 0.25 * r(3)); B.add('arch', 0, -h * 0.05, 0, span, h, span * 0.5, MAT.stone); R = span * 0.6; break; }
      case 'palms': {
        const n = 8 + Math.floor(r(2) * 12);
        for (let k = 0; k < n; k++) { const a = r(3 + k) * 6.28, rr = 4 + 30 * Math.sqrt(r(13 + k)); const s = 9 + 6 * r(23 + k); B.add('palm', Math.cos(a) * rr, -0.4, Math.sin(a) * rr, s, s, s, MAT.wood, { yaw: r(33 + k) * 6 }); }
        for (let k = 0; k < 6; k++) { const a = r(43 + k) * 6.28, rr = 8 + 24 * r(53 + k); B.add('scrub', Math.cos(a) * rr, -0.05, Math.sin(a) * rr, 3, 2, 3, MAT.scrub); }
        B.add('cyl', 0, -0.5, 0, 5, 1.6, 5, MAT.stone);
        for (let k = 0; k < 2; k++) B.add('cone', 14 + k * 9, -0.2, -10 + k * 5, 8, 5, 7, MAT.cloth, { emit: 0.3 });
        R = 40;
        break;
      }
      case 'wreck': {
        const len = (34 + 30 * r(2)) * sc, wid = len * 0.22, hh = wid * 0.75;
        const roll = (0.25 + 0.35 * r(3)) * (r(4) < 0.5 ? -1 : 1);
        B.add('hull', 0, -hh * 0.45, 0, wid, hh, len, r(5) < 0.5 ? MAT.rust : MAT.wood, { roll, pitch: (r(6) - 0.5) * 0.25 });
        for (let k = 0; k < 5; k++) B.add('rib', 0, -1.2, len * 0.62 + k * 3.2, wid * (1 - k * 0.08), hh * (1.1 - k * 0.12), 4, MAT.wood, { roll: (r(20 + k) - 0.5) * 0.3 });
        B.add('cyl', 0, -2, -len * 0.1, 0.7, hh * 2.2, 0.7, MAT.wood, { pitch: 0.2 + 0.3 * r(40), roll: roll * 1.4 });
        R = len * 0.6;
        break;
      }
    }
    return { parts: B.parts, x: P.x, z: P.z, r: R, far: false, smoke: B.smoke };
  }

  /** A fallen walker (a tramper like ours, long dead): tilted armoured body half in the sand, legs splayed / sticking up. */
  private deadWalker(B: Builder, id: number, S: number): number {
    const r = (k: number) => rnd(id, k);
    const roll = (0.15 + 0.4 * r(70)) * (r(71) < 0.5 ? -1 : 1), pitch = (r(72) - 0.5) * 0.3;
    B.add('walkerbody', 0, -S * 0.22, 0, S * 0.9, S * 0.7, S * 1.5, r(73) < 0.5 ? MAT.paint : MAT.iron, { roll, pitch });
    const n = 4 + Math.floor(r(74) * 3);
    for (let k = 0; k < n; k++) {
      const side = k % 2 ? 1 : -1, row = Math.floor(k / 2), lz = (row - (Math.ceil(n / 2) - 1) / 2) * S * 0.6;
      const up = r(80 + k) < 0.35;                                    // a leg sticking up into the air
      const yaw = side > 0 ? 0 : Math.PI;
      B.add('leg', side * S * 0.4, up ? S * 0.15 : -S * 0.1, lz, S * (0.9 + 0.3 * r(90 + k)), S * (0.9 + 0.3 * r(90 + k)), S * 0.9, MAT.iron,
        { yaw: yaw + (r(100 + k) - 0.5) * 0.6, roll: up ? side * 1.2 : (r(110 + k) - 0.5) * 0.5, pitch: (r(120 + k) - 0.5) * 0.3 });
    }
    return S * 1.4;
  }

  private buildGate(w: DesertWorld, G: GateItem): Built {
    const P = this.place(w, G.s, 0);
    // local x = across the route (starboard), z = along it
    const B = new Builder(P.x, P.z, -P.heading + G.yaw, this.gr, rnd(G.id, 1));
    const sc = G.scale;
    const half = GATE_CLEAR + 12;
    switch (G.kind) {
      case 'rockarch': {
        const span = 2 * (GATE_CLEAR + 16), h = (64 + 14 * rnd(G.id, 2)) * sc;
        const g = Math.min(B.g(-span / 2, 0), B.g(span / 2, 0));
        B.add('arch', 0, -h * 0.04, 0, span, h, span * 0.42, MAT.stone, { base: g });
        for (const sd of [-1, 1]) { B.add('crag', sd * span * 0.55, -3, 0, span * 0.16, h * 0.22, span * 0.14, MAT.stone); B.add('rock', sd * span * 0.62, -2, 12, 12, 7, 11, MAT.stone); }
        break;
      }
      case 'gateway': {
        const H = (54 + 10 * rnd(G.id, 2)) * sc, T = 16 * sc;
        const g = Math.min(B.g(-half, 0), B.g(half, 0)) - 2;
        for (const sd of [-1, 1]) {
          B.add('box', sd * (half + T / 2), 0, 0, T, H, T, MAT.adobe, { base: g, emit: 0.25 });
          B.add('box', sd * (half + T / 2), H, 0, T * 1.2, 4 * sc, T * 1.2, MAT.adobe, { base: g });
          for (let k = 0; k < 4; k++) B.add('box', sd * (half + T / 2) + (k % 2 ? 1 : -1) * T * 0.4, H + 4 * sc, (k < 2 ? 1 : -1) * T * 0.4, 3, 4 * sc, 3, MAT.adobe, { base: g });
        }
        // the broken lintel: two pieces that no longer meet, the fallen middle lying beside the road
        const Lw = half + T * 0.3;
        B.add('box', -Lw / 2 - T * 0.1, H - 9 * sc, 0, Lw * 0.82, 9 * sc, T * 0.8, MAT.adobe, { base: g, roll: 0.03 });
        B.add('box', Lw / 2 + T * 0.1, H - 9 * sc, 0, Lw * 0.7, 9 * sc, T * 0.8, MAT.adobe, { base: g, roll: -0.05 });
        B.add('box', half + 26, -2, 22, Lw * 0.5, 7, T * 0.7, MAT.adobe, { yaw: 0.4, roll: 0.15 });
        for (let k = 0; k < 8; k++) B.add('rock', (rnd(G.id, 10 + k) - 0.5) * 2 * (half + 30), -1, (rnd(G.id, 20 + k) - 0.5) * 60, 4 + 4 * rnd(G.id, 30 + k), 2.5, 4 + 3 * rnd(G.id, 40 + k), MAT.adobe);
        break;
      }
      case 'gantry': {
        const H = 42 * sc, T = 12;
        const g = Math.min(B.g(-half, 0), B.g(half, 0)) - 1;
        for (const sd of [-1, 1]) B.add('lattice', sd * (half + T / 2), 0, 0, T, H + 6, T, MAT.iron, { base: g });
        const L = 2 * (half + T / 2) + T;
        B.add('truss', 0, H - 4, 0, L, 8, 8, MAT.rust, { base: g });
        // a crane trolley and its hanging hook chain
        B.add('box', 6, H - 6.5, 0, 6, 3, 9, MAT.iron, { base: g });
        B.add('cyl', 6, H - 26, 0, 0.35, 20, 0.35, MAT.iron, { base: g });
        B.add('box', 6, H - 29, 0, 2.2, 3, 1, MAT.rust, { base: g });
        break;
      }
    }
    return { parts: B.parts, x: P.x, z: P.z, r: 1, far: false, smoke: [] };
  }

  private buildFar(w: DesertWorld, F: FarItem): Built {
    const P = this.place(w, F.s, F.lat);
    const B = new Builder(P.x, P.z, F.yaw, this.gr, rnd(F.id, 1));
    const r = (k: number) => rnd(F.id, k);
    const sc = F.scale;
    const g0 = this.gr(P.x, P.z) - 5;
    switch (F.kind) {
      case 'megatower': {
        const n = 2 + Math.floor(r(2) * 3);
        for (let k = 0; k < n; k++) {
          const lx = (k - (n - 1) / 2) * 170 * sc + (r(3 + k) - 0.5) * 60, H = (380 + 520 * r(10 + k)) * sc, Wd = (70 + 60 * r(20 + k)) * sc;
          if (r(30 + k) < 0.5) B.add('box', lx, 0, (r(40 + k) - 0.5) * 120, Wd, H, Wd * 0.8, MAT.adobe, { base: g0, emit: 0.18, roll: (r(50 + k) - 0.5) * 0.05 });
          else B.add('cyl', lx, 0, (r(40 + k) - 0.5) * 120, Wd, H, Wd, MAT.stone, { base: g0, emit: 0.18 });
          const lz = (r(40 + k) - 0.5) * 120;
          // tiers stepping in, buttresses, an antenna lattice or a broken crown
          B.add('box', lx, H * 0.55, lz, Wd * 1.25, H * 0.05, Wd * 1.05, MAT.adobe, { base: g0, emit: 0.1 });
          B.add('box', lx, H, lz, Wd * 0.7, H * 0.16, Wd * 0.6, MAT.adobe, { base: g0, emit: 0.2 });
          for (const sd of [-1, 1]) B.add('box', lx + sd * Wd * 0.62, 0, lz, Wd * 0.22, H * (0.32 + 0.2 * r(80 + k)), Wd * 0.5, MAT.stone, { base: g0 });
          if (r(60 + k) < 0.55) B.add('lattice', lx, H * 1.16, lz, Wd * 0.3, H * 0.3, Wd * 0.3, MAT.iron, { base: g0 });
          else B.add(r(90 + k) < 0.5 ? 'spire' : 'cone', lx, H * 1.16, lz, Wd * 0.5, H * 0.22, Wd * 0.5, MAT.stone, { base: g0, roll: (r(70 + k) - 0.5) * 0.5 });
        }
        break;
      }
      case 'stacks': {
        const n = 4 + Math.floor(r(2) * 5);
        B.add('box', 0, 0, 0, 380 * sc, 60 * sc, 160 * sc, MAT.iron, { base: g0, emit: 0.2 });
        for (let k = 0; k < n; k++) {
          const lx = (k - (n - 1) / 2) * 60 * sc, H = (160 + 120 * r(3 + k)) * sc, R = 26 * sc;
          B.add('chimney', lx, 0, 90 * sc, R, H, R, MAT.adobe, { base: g0 });
          const [wx, wz] = B.at(lx, 90 * sc);
          B.smoke.push({ x: wx, y: g0 + H, z: wz, r: R * 0.4 });
        }
        break;
      }
      case 'linerfar': B.add('liner', 0, -20, 0, 48 * sc, 80 * sc, 320 * sc, MAT.paint, { base: g0, roll: 0.2 * (r(2) - 0.5) * 2 }); break;
      case 'colossus': this.deadWalker(B, F.id, 110 * sc); break;
      case 'wallruin': {
        const n = 4 + Math.floor(r(2) * 5);
        for (let k = 0; k < n; k++) if (r(10 + k) > 0.25) B.add('box', (k - (n - 1) / 2) * 230 * sc, 0, 0, 200 * sc, (70 + 50 * r(20 + k)) * sc, 30 * sc, MAT.adobe, { base: g0, roll: (r(30 + k) - 0.5) * 0.06 });
        for (let k = 0; k < 3; k++) B.add('box', (r(40 + k) - 0.5) * n * 200 * sc, 0, 0, 40 * sc, (120 + 60 * r(50 + k)) * sc, 40 * sc, MAT.adobe, { base: g0, emit: 0.15 });
        break;
      }
      case 'mesa': B.add('mesa', 0, -10, 0, (300 + 400 * r(2)) * sc, (90 + 140 * r(3)) * sc, (260 + 300 * r(4)) * sc, MAT.stone, { base: g0 }); break;
    }
    return { parts: B.parts, x: P.x, z: P.z, r: 1, far: true, smoke: B.smoke };
  }

  dispose() { this.kit.dispose(); }
}

/** (exported for tests) every item key the layer would draw around journey distance d, without three.js placement. */
export function marksAround(seed: number, d: number, biomeAt: BiomeAt = defaultBiomeAt(seed)) {
  return {
    near: Array.from({ length: 40 }, (_, k) => [...nearCell(seed, Math.floor(d / NEAR_CELL) + k, 1, biomeAt), ...nearCell(seed, Math.floor(d / NEAR_CELL) + k, -1, biomeAt)]).flat(),
    marks: Array.from({ length: 8 }, (_, k) => markCell(seed, Math.floor(d / MARK_CELL) + k, biomeAt)).flat(),
    gate: regionGate(seed, Math.floor(d / REGION_LEN), biomeAt),
    hash: hash32(seed, Math.floor(d)),
  };
}
void UP;
