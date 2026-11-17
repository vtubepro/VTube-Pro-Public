// The desert lane's DesertWorld as the voyage's world provider (voyageWorld.ts VoyageWorldProvider, poseMode 'provider').
// The desert places its world under the ship itself (ride height, ground tilt, heading, floating origin; sand at room
// y = groundY), so the voyage's body pose keeps only the gait heave / sway, kicks and the kneel (voyageScene.bodyAt).
//
// Frames:
//   route (s, d, h)   s = journey distance along the desert route (shared/desert/route.ts), d = metres to starboard,
//                     h = world height (shared/desert/height.ts heightAt). ground.heightAt(s, d) = desert.heightAtRoute.
//   provider local    desert.root space (= the voyage world group's local space): toLocal / fromLocal.
//   route-local       the placeholder world's frame (x = d, y = h, z = -(s - S)): the enemy pool still draws in it, so
//                     `routeGroup` carries that frame (the route's tangent at S; route curvature over the 95-130 m to an
//                     enemy is a few metres sideways - invisible at that range).
// The ship's prints on the sand come from the voyage's own leg rig (gaitLikeFrom: the same phases, stride and duty as
// voyageGait.footAt, which runs on shared/gait.ts), so the feet stand in their prints.
import * as THREE from 'three';
import { DesertWorld, desertQualityFor, newSolidSet } from '../desert/index.ts';
import { gaitLikeFrom } from '../../../shared/desert/footfalls.ts';
import { DesertRoute } from '../../../shared/desert/route.ts';
import { heightAt } from '../../../shared/desert/height.ts';
import type { CityArchetype } from '../../../shared/desert/features.ts';
import { chapterBiome, defaultBiomeAt, type Biome } from '../../../shared/desert/regions.ts';
import type { CityKind, RoomVoyageConfig } from '../../../shared/voyage.ts';
import type { CitySpec, VoyageGroundLike, VoyageWorldProvider, WorldFrame } from './voyageWorld.ts';
import { gfxBudget } from '../../stage/gfx/lod.ts';

/** The desert route is defined to 10 000 km (shared/desert/route.ts MAX_ROUTE_D; tested to 5 000 km) while a voyage's
 *  distance counts from its epoch (a long-running room passes that in a few weeks): the desert runs on S modulo WRAP,
 *  with the base taken from the ship's distance this frame, so the route frame is continuous except for one new
 *  desert every WRAP metres (about 15 days of walking at 3 m/s). */
export const DESERT_WRAP = 4_000_000;
const CITY: Record<CityKind, CityArchetype> = { windtower: 'windtower', hulk: 'hulkharbor', cistern: 'cistern', souk: 'spirebazaar' };
const tv = new THREE.Vector3(), tvA = new THREE.Vector3(), UPV = new THREE.Vector3(0, 1, 0), tm = new THREE.Matrix4(), tm2 = new THREE.Matrix4();
const rp = { x: 0, z: 0, heading: 0, curv: 0 };

/** The voyage's rest feet + gait, for the desert's ship prints and its ground-tilt fit. */
export interface DesertShipLegs { legs: { fwd: number; lat: number; phi: number }[]; cycle: number; duty: number; height: number }

export class DesertProvider implements VoyageWorldProvider {
  readonly desert: DesertWorld;
  readonly poseMode = 'provider' as const;
  readonly group: THREE.Group;
  /** route-local content (x = d, y = h, z = -(s - S)): the voyage's enemy pool */
  readonly routeGroup = new THREE.Group();
  readonly ground: VoyageGroundLike;
  private flatsKey = '';
  private citiesKey = '';
  private S = 0;
  /** S - (S mod WRAP) of this frame: route distances given to the desert are s - base */
  private base = 0;
  /** the wrap, a whole number of gait cycles (the desert's prints keep the voyage feet's phase across a wrap) */
  private wrap = DESERT_WRAP;
  prepare(S: number) { this.S = S; this.base = Math.floor(S / this.wrap) * this.wrap; }
  /** The burning wreck the ship passes next (or has just passed), in voyage route coords (s, lateral d, height h). */
  wreckAt(): { s: number; d: number; h: number } | null {
    const r = this.desert.ruins;
    const f = r ? r.wreckFocus(this.desert, this.desert.pose.d) : null;
    return f ? { s: f.s + this.base, d: f.lat, h: f.y } : null;
  }
  private inv = new THREE.Matrix4();
  private invOk = false;

  constructor(cfg: RoomVoyageConfig, seed: number) {
    const W = cfg.world ?? {};
    this.desert = new DesertWorld({
      seed: seed >>> 0 || 1, quality: desertQualityFor(gfxBudget().level), groundY: typeof cfg.groundY === 'number' ? cfg.groundY : undefined,
      relief: W.relief, haze: W.haze, wrecks: W.wrecks, skyline: W.skyline, drift: W.drift, moonlight: W.moonlight,
    });
    this.group = this.desert.root;
    this.routeGroup.name = 'vtp:voyage:routeLocal';
    this.routeGroup.matrixAutoUpdate = false;
    this.group.add(this.routeGroup);
    const d = this.desert;
    const ground: VoyageGroundLike = {
      heightAt: (s, lat) => d.heightAtRoute(s - this.base, lat),
      raw: (s, lat) => d.heightAtRoute(s - this.base, lat),
      flats: [],
      legDist: 3200,
      chapterAt: null,
      biomeOf: () => ({ dune: 1, hill: 1 }),
    };
    this.ground = ground;
    // the world rules follow the voyage's chapters: each chapter's layout flavour -> its biomes (before the first frame,
    // and for distances the voyage has no chapter for, the desert's own regions)
    const own = defaultBiomeAt(seed >>> 0 || 1);
    this.desert.setBiomeAt((dd: number): Biome => {
      const s = dd + this.base, ca = ground.chapterAt, fa = ground.flavourAt;
      if (!ca || !fa) return own(dd);
      const c = ca(s);
      if (!c || !(c.s1 > c.s0)) return own(dd);
      return chapterBiome(fa(c.ch), c.ch, (s - c.s0) / (c.s1 - c.s0), seed >>> 0);
    });
    this.desert.marks && (this.desert.marks.dangerSide = (cfg.dangerSide ?? 'aft-port').includes('starboard') ? 1 : -1);
  }

  /** The voyage's leg rig (rest feet in the ship frame: fwd + = bow, lat + = starboard) -> the desert's prints / tilt fit. */
  setShip(ship: DesertShipLegs | null) {
    if (!ship || ship.legs.length < 3) return;
    const fr = (x: number) => x - Math.floor(x);
    this.wrap = Math.max(1, Math.round(DESERT_WRAP / ship.cycle)) * ship.cycle;
    this.prepare(this.S);
    // footAt: touchdown of cycle k at s = (k - phi) * cycle, plant at + duty * cycle / 2 + fwd; gaitLikeFrom's
    // phase = frac(-offset) puts plant k at (k + phase) * stride + duty * stride / 2: the same plants for offset = phi
    this.desert.gait = gaitLikeFrom({ offsets: ship.legs.map((l) => fr(l.phi)), duty: ship.duty, lift: ship.height }, ship.cycle,
      ship.legs.map((l) => [l.lat, -l.fwd] as [number, number]), 0.85, 1.6);
  }

  toLocal(s: number, d: number, h: number, _S: number, out: THREE.Vector3): THREE.Vector3 {
    const p = this.desert.route.at(s - this.base, rp);
    const [wx, wz] = DesertRoute.toWorld(p.heading, d, 0);
    const O = this.desert.originAt(this.S - this.base);
    return out.set(p.x + wx - O.x, h, p.z + wz - O.z).applyMatrix4(this.desert.world.matrix);
  }

  /** provider local -> route coords, EXACT: the route point whose normal runs through the point (Newton from the ship's
   *  tangent), so heightAt(s, d) is the sand right under it and toLocal(fromLocal(q)) = q. (A straight tangent was a few
   *  metres off 100+ m out on a bend: an exterior lens checked against the sand beside it.) */
  fromLocal(q: THREE.Vector3, S: number): { s: number; d: number; h: number } {
    if (!this.invOk) { this.inv.copy(this.desert.world.matrix).invert(); this.invOk = true; }
    const t = tv.copy(q).applyMatrix4(this.inv);
    const O = this.desert.originAt(this.S - this.base);
    const wx = t.x + O.x, wz = t.z + O.z;
    let s = S - this.base;
    let p = this.desert.route.at(s, rp);
    let [rx, rz] = DesertRoute.toRoom(p.heading, wx - p.x, wz - p.z);
    for (let i = 0; i < 5 && Math.abs(rz) > 1e-4; i++) {
      s -= rz;
      p = this.desert.route.at(s, rp);
      [rx, rz] = DesertRoute.toRoom(p.heading, wx - p.x, wz - p.z);
    }
    return { s: s + this.base, d: rx, h: t.y };
  }

  /** A provider-local point -> WORLD (x, height, z) with the ship at voyage distance S (the exterior pose: full ground
   *  tilt). Pure in S: cameras plan a whole move ahead with it. */
  worldAt(q: THREE.Vector3, S: number, out: THREE.Vector3, base: number = this.base): THREE.Vector3 {
    return out.copy(q).applyMatrix4(this.planMat(S, base, false));
  }
  /** ... and back: a WORLD point -> provider-local with the ship at S (pure) */
  rootAt(w: THREE.Vector3, S: number, out: THREE.Vector3, base: number = this.base): THREE.Vector3 {
    return out.copy(w).applyMatrix4(this.planMat(S, base, true));
  }
  private planMat(S: number, base: number, inv: boolean): THREE.Matrix4 {
    if (base !== this.planBase || S !== this.planS) { this.desert.rootToWorldAt(S - base, 1, this.planM); this.planIM.copy(this.planM).invert(); this.planBase = base; this.planS = S; }
    return inv ? this.planIM : this.planM;
  }
  private planM = new THREE.Matrix4();
  private planIM = new THREE.Matrix4();
  private planBase = NaN;
  private planS = NaN;
  /** The desert wrap a voyage distance falls in (the base its route distances are taken from), and the ship's now. */
  baseOf(S: number): number { return Math.floor(S / this.wrap) * this.wrap; }
  get baseNow(): number { return this.base; }
  /** Route coords (voyage distance s, starboard d, height h) -> WORLD, in wrap `base` (pure). */
  routeWorld(s: number, d: number, h: number, base: number, out: THREE.Vector3): THREE.Vector3 {
    const p = this.desert.route.at(s - base, rp);
    const [wx, wz] = DesertRoute.toWorld(p.heading, d, 0);
    return out.set(p.x + wx, h, p.z + wz);
  }
  /** The burning wreck a WRECK / ESTAB shot frames when the ship is at S, in the WORLD (pure in S), or null. */
  wreckWorldAt(S: number, base: number): THREE.Vector3 | null {
    const r = this.desert.ruins;
    const f = r ? r.wreckFocus(this.desert, S - base) : null;
    if (!f) return null;
    const O = this.desert.origin();
    return new THREE.Vector3(f.x + O.x, f.y, f.z + O.z);
  }
  /** Have this page's layers placed their things (landmarks, lines, burning wrecks: placed round the ship's distance) for
   *  the stretch S0..S1? They reach >= 300 m behind and 450 m ahead of the ship at the lowest quality: a stretch from 250 m
   *  behind to 400 m ahead of the ship's distance at the last update is covered. False before the first update and right
   *  after a seek. (A parked ship is fine: its distance is where it stands.) */
  solidsReadyFor(S0: number, S1: number): boolean {
    if (!this.updated) return false;
    const d = this.desert.pose.d, base = this.base;
    return S0 - base >= d - 250 && S1 - base <= d + 400;
  }
  private updated = false;
  /** The sand height at WORLD (x, z) (the same sand worldAt's coordinates stand on). */
  groundW(x: number, z: number): number { return heightAt(this.desert.spec, x, z); }
  /** The solid things on the sand for a camera plan over a WORLD box (DesertWorld.solidSet: the same set on every page),
   *  as a WORLD segment (or point) test with a pad. A new set per call: two plans in flight (the director's lookahead)
   *  never share buffers, and the placed kit is the layer's snapshot at the call. null = no set: a
   *  non-finite box, or one wider than 3 km (a shot's box is a few hundred metres - a bad input is not plannable). */
  solidsIn(x0: number, z0: number, x1: number, z1: number): { hit(a: THREE.Vector3, b: THREE.Vector3, pad: number): boolean } | null {
    if (!Number.isFinite(x0 + z0 + x1 + z1) || Math.abs(x1 - x0) > 3000 || Math.abs(z1 - z0) > 3000) return null;
    const S = this.desert.solidSet(Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1), newSolidSet());
    return { hit: (a, b, pad) => S.hit(a.x, a.y, a.z, b.x, b.y, b.z, pad) };
  }

  setDryBoxes(boxes: THREE.Box3[]) { this.desert.setDryBoxes(boxes); }

  /** The world-rules biome at voyage distance S (test pages: seek a biome). */
  biomeAtS(S: number): string { return this.desert.biomeAt(S - Math.floor(S / this.wrap) * this.wrap); }

  setCities(c: CitySpec[]) {
    const key = `${this.base}|` + c.map((x) => `${x.id}:${x.s.toFixed(1)}:${x.d.toFixed(1)}:${x.kind}:${(x.rise ?? 1).toFixed(2)}`).join('|');
    if (key === this.citiesKey) return;
    this.citiesKey = key;
    // (a city being replaced by a fork vote sinks: the desert has no rise, so it goes once it is mostly down)
    this.desert.setCities(c.filter((x) => (x.rise ?? 1) > 0.35).map((x) => ({ d: x.s - this.base, lateral: x.d, radius: Math.max(150, x.r), archetype: CITY[x.kind] ?? 'windtower', seed: x.seed })));
  }

  update(f: WorldFrame) {
    const d = this.desert;
    if (f.camera && f.renderer) this.updated = true;
    if (f.S !== this.S) this.prepare(f.S);
    const D = f.S - this.base;
    // the voyage's flats (the dig site, cities) on the desert's own raw height (routeFlat), before the frame
    const fl = this.ground.flats;
    const fk = `${this.base}|` + fl.map((x) => `${x.s.toFixed(1)}:${x.d.toFixed(1)}:${x.r}`).join('|');
    if (fk !== this.flatsKey) { this.flatsKey = fk; d.setFlats(fl.map((x) => d.routeFlat(x.s - this.base, x.d, x.r * 1.35))); }
    if (f.camera && f.renderer) {
      d.update({ d: D, speed: f.v, hour: f.hour ?? 12, storm: f.storm, stormFront: f.stormFront ?? undefined, now: f.now, camera: f.camera, renderer: f.renderer, tilt: f.tilt });
    }
    this.invOk = false;
    // route-local frame at S: desert.world (terrain-local -> root) x T(P(S) - O) x basis(starboard, up, aft)
    const p = d.route.at(D, rp);
    const O = d.originAt(D);
    const [sx, sz] = DesertRoute.toWorld(p.heading, 1, 0), [ax, az] = DesertRoute.toWorld(p.heading, 0, 1);
    tm.makeBasis(tv.set(sx, 0, sz), UPV, tvA.set(ax, 0, az)).setPosition(p.x - O.x, 0, p.z - O.z);
    tm2.multiplyMatrices(d.world.matrix, tm);
    this.routeGroup.matrix.copy(tm2);
    this.routeGroup.matrixWorldNeedsUpdate = true;
  }

  counts(): Record<string, number> {
    const i = this.desert.info();
    return { desert: 1, prints: Number(i.prints) || 0, rebases: Number(i.rebases) || 0, ms: Number(i.ms) || 0 };
  }

  dispose() { this.routeGroup.removeFromParent(); this.desert.dispose(); }
}
