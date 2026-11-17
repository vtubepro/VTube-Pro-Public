// Near features + scatter on the sand (real distance, half-buried by the kit material's sand drifts):
//   features (256 m cells, out to ~1.7 km): outcrop clusters, half-buried wrecks (tilted hull + ribs + a mast),
//     ruins (walls, columns, a fallen column), rock arches, giant bone fields (rib cage + skull)
//   scatter (48 m cells, out to ~320 m): small rocks + dry scrub, denser on hardpan
// Per-cell results are cached (ground heights are the only cost), so walking one cell computes one new row.
import * as THREE from 'three';
import { cellFeature, cellScatter, FEATURE_CELL, SCATTER_CELL, type Feature, type Scatter } from '../../../shared/desert/features.ts';
import { heightAt, type DesertWorldSpec, type DuneSample } from '../../../shared/desert/height.ts';
import { rnd } from '../../../shared/desert/noise.ts';
import { KitLayer, MAT, type KitInstance, type Shape } from './kit.ts';
import type { HeightClipmap } from './clipmap.ts';
import type { DesertUniforms } from './uniforms.ts';
import type { DesertLight } from './light.ts';
import type { DesertFrame, DesertWorld } from './index.ts';

const FEATURE_RANGE: Record<string, number> = { low: 900, medium: 1300, high: 1700, ultra: 2100 };
const SCATTER_RANGE: Record<string, number> = { low: 0, medium: 220, high: 320, ultra: 420 };

/** A placed part in WORLD coordinates (cached per cell; converted to terrain-local at fill time). */
export interface Part { shape: Shape; x: number; y: number; z: number; q: THREE.Quaternion; s: THREE.Vector3; mat: number; tint: number }

export class DesertProps {
  readonly group = new THREE.Group();
  readonly kit: KitLayer;
  private quality = 'high';
  /** '' = rebuild at the next update (quality / keep-outs / ground changed); k = the scatter cell key last built. */
  private key = '';
  private k = [NaN, NaN, NaN, NaN];
  private fCache = new Map<string, Part[]>();
  private sCache = new Map<string, Part[]>();
  stats = { features: 0, scatter: 0, instances: 0, draws: 0, rebuilds: 0, kinds: {} as Record<string, number> };
  private sample: DuneSample = { h: 0, flat: 0, field: 0, corridor: 0, dunes: 0 };

  constructor(private spec: DesertWorldSpec, du: DesertUniforms, clip: HeightClipmap) {
    this.group.name = 'vtp:desert:props';
    this.kit = new KitLayer('props', du, clip, { crag: 500, rock: 2400, arch: 40, hull: 40, rib: 600, box: 600, cyl: 300, dome: 60, scrub: 1600 });
    this.group.add(this.kit.group);
  }

  setQuality(q: string) { this.quality = q; this.key = ''; }

  /** World discs nothing may stand in (alongside walkers, crew ashore, the dig site): a feature with any part inside
   *  one is left out whole, scatter part by part. Takes effect at the next update. */
  keepOut: { x: number; z: number; r: number }[] = [];
  setKeepOut(list: { x: number; z: number; r: number }[]) { this.keepOut = list; this.key = ''; }

  /** The ground changed under these world discs (flats added / moved / removed): re-place the cells they touch. */
  invalidate(discs: readonly { x: number; z: number; r: number }[]) {
    const drop = (cache: Map<string, Part[]>, cell: number, pad: number) => {
      for (const k of [...cache.keys()]) {
        const [cx, cz] = k.split(',').map(Number);
        const x0 = cx * cell - pad, x1 = (cx + 1) * cell + pad, z0 = cz * cell - pad, z1 = (cz + 1) * cell + pad;
        if (discs.some((c) => c.x + c.r >= x0 && c.x - c.r <= x1 && c.z + c.r >= z0 && c.z - c.r <= z1)) cache.delete(k);
      }
    };
    drop(this.fCache, FEATURE_CELL, 120);
    drop(this.sCache, SCATTER_CELL, 8);
    this.key = '';
  }

  private blocked(p: Part): boolean {
    const pr = 0.5 * Math.max(p.s.x, p.s.z);
    for (const c of this.keepOut) { const dx = p.x - c.x, dz = p.z - c.z, rr = c.r + pr; if (dx * dx + dz * dz < rr * rr) return true; }
    return false;
  }

  update(w: DesertWorld, _f: DesertFrame, _L: DesertLight) {
    const O = w.origin();
    const cx0 = Math.floor((w.camT.x + O.x) / SCATTER_CELL), cz0 = Math.floor((w.camT.z + O.z) / SCATTER_CELL);
    const K = this.k;
    if (this.key !== '' && K[0] === cx0 && K[1] === cz0 && K[2] === O.x && K[3] === O.z) return;
    this.key = 'built'; K[0] = cx0; K[1] = cz0; K[2] = O.x; K[3] = O.z;
    // the active set is a pure function of the key: ranges are measured from the camera's scatter-cell centre (never
    // from wherever the camera happened to be when it entered the cell: two pages must hold the same set)
    const camWx = (cx0 + 0.5) * SCATTER_CELL, camWz = (cz0 + 0.5) * SCATTER_CELL;
    const list: KitInstance[] = [];
    const kinds: Record<string, number> = {};
    // features
    const FR = FEATURE_RANGE[this.quality] ?? 1700;
    const fr = Math.ceil(FR / FEATURE_CELL);
    const fx0 = Math.floor(camWx / FEATURE_CELL), fz0 = Math.floor(camWz / FEATURE_CELL);
    let nf = 0;
    const keepF = new Set<string>();
    for (let j = -fr; j <= fr; j++) for (let i = -fr; i <= fr; i++) {
      const ck = `${fx0 + i},${fz0 + j}`;
      const cx = ((fx0 + i) + 0.5) * FEATURE_CELL - camWx, cz = ((fz0 + j) + 0.5) * FEATURE_CELL - camWz;
      if (cx * cx + cz * cz > (FR + FEATURE_CELL) ** 2) continue;
      keepF.add(ck);
      let parts = this.fCache.get(ck);
      if (!parts) { const f = cellFeature(this.spec, fx0 + i, fz0 + j); parts = f ? this.build(f) : []; this.fCache.set(ck, parts); }
      if (parts.length && !(this.keepOut.length && parts.some((p) => this.blocked(p)))) { nf++; for (const p of parts) this.emit(list, p, O); }
    }
    for (const k of this.fCache.keys()) if (!keepF.has(k)) this.fCache.delete(k);
    // scatter
    const SR = SCATTER_RANGE[this.quality] ?? 320;
    let ns = 0;
    const keepS = new Set<string>();
    if (SR > 0) {
      const sr = Math.ceil(SR / SCATTER_CELL);
      const sx0 = Math.floor(camWx / SCATTER_CELL), sz0 = Math.floor(camWz / SCATTER_CELL);
      for (let j = -sr; j <= sr; j++) for (let i = -sr; i <= sr; i++) {
        const cx = ((sx0 + i) + 0.5) * SCATTER_CELL - camWx, cz = ((sz0 + j) + 0.5) * SCATTER_CELL - camWz;
        if (cx * cx + cz * cz > SR * SR) continue;
        const ck = `${sx0 + i},${sz0 + j}`;
        keepS.add(ck);
        let parts = this.sCache.get(ck);
        if (!parts) { parts = this.scatter(sx0 + i, sz0 + j); this.sCache.set(ck, parts); }
        for (const p of parts) { if (this.keepOut.length && this.blocked(p)) continue; this.emit(list, p, O); ns++; }
      }
    }
    for (const k of this.sCache.keys()) if (!keepS.has(k)) this.sCache.delete(k);
    for (const it of list) kinds[it.shape] = (kinds[it.shape] ?? 0) + 1;
    this.kit.fill(list);
    this.stats = { features: nf, scatter: ns, instances: list.length, draws: this.kit.draws, rebuilds: this.stats.rebuilds + 1, kinds };
  }

  private emit(list: KitInstance[], p: Part, O: { x: number; z: number }) {
    const pos = new THREE.Vector3(p.x - O.x, p.y, p.z - O.z);
    list.push({ shape: p.shape, m: new THREE.Matrix4().compose(pos, p.q, p.s), mat: p.mat, tint: p.tint, emit: 0, compressed: false, anchor: pos });
  }

  /** The scatter rocks of every 48 m cell touching a world box, whatever the camera (the camera planner looks where the
   *  lens WILL be: the drawn set follows the camera). Pure in the seed; cached. */
  scatterRocks(x0: number, z0: number, x1: number, z1: number, out: Part[]) {
    for (let cz = Math.floor(z0 / SCATTER_CELL); cz <= Math.floor(z1 / SCATTER_CELL); cz++) for (let cx = Math.floor(x0 / SCATTER_CELL); cx <= Math.floor(x1 / SCATTER_CELL); cx++) {
      const k = `${cx},${cz}`;
      let parts = this.planCache.get(k);
      if (!parts) { parts = this.scatter(cx, cz).filter((p) => p.shape === 'rock'); if (this.planCache.size > 512) this.planCache.clear(); this.planCache.set(k, parts); }
      for (const p of parts) out.push(p);
    }
  }
  private planCache = new Map<string, Part[]>();
  /** The near features (outcrops, wrecks, ruins, arches, bones) of every 256 m cell whose pieces can reach a world box,
   *  whatever the camera: pure in the seed and the keep-outs (the drawn set follows the camera; a camera plan must not). */
  featureParts(x0: number, z0: number, x1: number, z1: number, out: Part[]) {
    const R = 140;                                                          // (a feature's pieces reach <= ~110 m from its cell point)
    for (let cz = Math.floor((z0 - R) / FEATURE_CELL); cz <= Math.floor((z1 + R) / FEATURE_CELL); cz++) for (let cx = Math.floor((x0 - R) / FEATURE_CELL); cx <= Math.floor((x1 + R) / FEATURE_CELL); cx++) {
      const k = `${cx},${cz}`;
      let parts = this.featCache.get(k);
      if (!parts) { const f = cellFeature(this.spec, cx, cz); parts = f ? this.build(f) : []; if (this.featCache.size > 512) this.featCache.clear(); this.featCache.set(k, parts); }
      if (!parts.length || (this.keepOut.length && parts.some((p) => this.blocked(p)))) continue;
      for (const p of parts) out.push(p);
    }
  }
  private featCache = new Map<string, Part[]>();

  private scatter(cx: number, cz: number): Part[] {
    const out: Scatter[] = [];
    cellScatter(this.spec, cx, cz, (x, z) => { heightAt(this.spec, x, z, this.sample); return this.sample.flat; }, out);
    return out.map((s) => {
      const y = heightAt(this.spec, s.x, s.z);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((rnd(s.id, 1) - 0.5) * 0.4, s.yaw, (rnd(s.id, 2) - 0.5) * 0.4));
      const k = s.scale;
      return s.kind === 'scrub'
        ? { shape: 'scrub' as Shape, x: s.x, y: y - 0.05, z: s.z, q, s: new THREE.Vector3(k * 1.3, k, k * 1.3), mat: MAT.scrub, tint: rnd(s.id, 3) }
        : { shape: 'rock' as Shape, x: s.x, y: y - k * 0.2, z: s.z, q, s: new THREE.Vector3(k * (0.8 + 0.6 * rnd(s.id, 4)), k * (0.5 + 0.5 * rnd(s.id, 5)), k), mat: MAT.stone, tint: rnd(s.id, 6) };
    });
  }

  /** Feature -> parts (world coordinates). */
  private build(f: Feature): Part[] {
    const P: Part[] = [];
    const r = (k: number) => rnd(f.id, k);
    const yawQ = (yaw: number, pitch = 0, roll = 0) => new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));
    const at = (lx: number, lz: number) => { const c = Math.cos(f.yaw), s = Math.sin(f.yaw); return [f.x + lx * c - lz * s, f.z + lx * s + lz * c] as [number, number]; };
    const ground = (x: number, z: number) => heightAt(this.spec, x, z);
    const S = f.scale;
    switch (f.kind) {
      case 'outcrop': {
        const n = 3 + Math.floor(r(1) * 4);
        for (let i = 0; i < n; i++) {
          const big = i === 0;
          const a = r(10 + i) * 6.28, rr = big ? 0 : (8 + 14 * r(20 + i)) * S;
          const [x, z] = at(Math.cos(a) * rr, Math.sin(a) * rr);
          const w = (big ? 16 + 14 * r(30) : 4 + 8 * r(30 + i)) * S, h = (big ? 9 + 16 * r(40) : 2 + 6 * r(40 + i)) * S;
          P.push({ shape: big || r(50 + i) < 0.5 ? 'crag' : 'rock', x, y: ground(x, z) - h * 0.18, z, q: yawQ(r(60 + i) * 6.28, (r(70 + i) - 0.5) * 0.25, (r(80 + i) - 0.5) * 0.25), s: new THREE.Vector3(w, h, w * (0.6 + 0.6 * r(90 + i))), mat: MAT.stone, tint: r(100 + i) });
        }
        break;
      }
      case 'wreck': {
        const len = (34 + 30 * r(1)) * S, wid = len * 0.22, hh = wid * 0.75;
        const [x, z] = at(0, 0);
        const roll = (0.25 + 0.35 * r(2)) * (r(3) < 0.5 ? -1 : 1), pitch = (r(4) - 0.5) * 0.25;
        P.push({ shape: 'hull', x, y: ground(x, z) - hh * 0.45, z, q: yawQ(f.yaw, pitch, roll), s: new THREE.Vector3(wid, hh, len), mat: MAT.rust, tint: r(5) });
        // broken stern ribs sticking out of the sand behind it, and a leaning mast
        for (let i = 0; i < 5; i++) {
          const [rx, rz] = at((r(10) - 0.5) * 4, len * 0.62 + i * 3.2);
          P.push({ shape: 'rib', x: rx, y: ground(rx, rz) - 1.2, z: rz, q: yawQ(f.yaw, 0, (r(20 + i) - 0.5) * 0.3), s: new THREE.Vector3(wid * (1 - i * 0.08), hh * (1.1 - i * 0.12), 4), mat: MAT.wood, tint: r(30 + i) });
        }
        const [mx, mz] = at(0, -len * 0.1);
        P.push({ shape: 'cyl', x: mx, y: ground(mx, mz) - 2, z: mz, q: yawQ(f.yaw, 0.2 + 0.3 * r(40), roll * 1.4), s: new THREE.Vector3(0.7, hh * 2.2, 0.7), mat: MAT.wood, tint: r(41) });
        break;
      }
      case 'ruin': {
        const n = 6 + Math.floor(r(1) * 7);
        for (let i = 0; i < n; i++) {
          const lx = (r(10 + i) - 0.5) * 40 * S, lz = (r(20 + i) - 0.5) * 40 * S;
          const [x, z] = at(lx, lz);
          const g = ground(x, z);
          if (r(30 + i) < 0.55) {
            const w = 6 + 12 * r(40 + i), h = 2 + 7 * r(50 + i) ** 1.5;
            P.push({ shape: 'box', x, y: g - 0.8, z, q: yawQ(f.yaw + (r(60 + i) < 0.5 ? 0 : Math.PI / 2), 0, (r(70 + i) - 0.5) * 0.08), s: new THREE.Vector3(w, h, 1.2), mat: MAT.adobe, tint: r(80 + i) });
          } else if (r(90 + i) < 0.7) {
            const h = 3 + 9 * r(100 + i);
            P.push({ shape: 'cyl', x, y: g - 0.5, z, q: yawQ(0, (r(110 + i) - 0.5) * 0.1), s: new THREE.Vector3(1.4, h, 1.4), mat: MAT.stone, tint: 0.7 });
          } else {
            P.push({ shape: 'cyl', x, y: g + 0.2, z, q: yawQ(r(120 + i) * 6.28, Math.PI / 2 - 0.05), s: new THREE.Vector3(1.4, 7 + 5 * r(130 + i), 1.4), mat: MAT.stone, tint: 0.7 });
          }
        }
        const [dx, dz] = at(0, 0);
        P.push({ shape: 'dome', x: dx, y: ground(dx, dz) - 3, z: dz, q: yawQ(f.yaw, 0.15, 0.1), s: new THREE.Vector3(14 * S, 9 * S, 14 * S), mat: MAT.adobe, tint: r(140) });
        break;
      }
      case 'arch': {
        const span = (36 + 34 * r(1)) * S, h = span * (0.6 + 0.3 * r(2));
        const [x, z] = at(0, 0);
        P.push({ shape: 'arch', x, y: ground(x, z) - h * 0.04, z, q: yawQ(f.yaw), s: new THREE.Vector3(span, h, span * 0.55), mat: MAT.stone, tint: r(3) });
        for (const sd of [-1, 1]) {
          const [rx, rz] = at(sd * span * 0.5, (r(4) - 0.5) * 6);
          P.push({ shape: 'crag', x: rx, y: ground(rx, rz) - 2, z: rz, q: yawQ(r(5) * 6.28), s: new THREE.Vector3(span * 0.12, h * 0.14, span * 0.1), mat: MAT.stone, tint: r(6) });
        }
        break;
      }
      case 'bones': {
        const len = (26 + 20 * r(1)) * S, n = 9;
        for (let i = 0; i < n; i++) {
          const t = i / (n - 1);
          const [x, z] = at(0, -len / 2 + t * len);
          const w = len * 0.42 * Math.sin(Math.PI * (0.15 + 0.75 * t)), hh = w * 0.85;
          P.push({ shape: 'rib', x, y: ground(x, z) - hh * 0.25, z, q: yawQ(f.yaw, (r(10 + i) - 0.5) * 0.1, (r(20 + i) - 0.5) * 0.35), s: new THREE.Vector3(w, hh, 8), mat: MAT.bone, tint: 0.6 });
        }
        const [sx, sz] = at(0, -len * 0.62);
        P.push({ shape: 'rock', x: sx, y: ground(sx, sz) - 1.5, z: sz, q: yawQ(f.yaw, 0.2), s: new THREE.Vector3(len * 0.2, len * 0.14, len * 0.28), mat: MAT.bone, tint: 0.5 });
        break;
      }
    }
    return P;
  }

  dispose() { this.kit.dispose(); }
}
