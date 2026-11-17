// Warzone anchors (docs/SCENES.md "Warzone"; the contract lives in the room's README): WZ_* empties in the GLB or
// scene.json `warzone.anchors` (glTF coordinates), turned into plain numbers. Anything missing is derived from the raid
// anchors (BG_*) and the performers' spots, so a room that only has a background raid still gets a full battle.
// Same GLB + scene.json -> same numbers on every page (the plan is a pure function of them + the clock).
import * as THREE from 'three';
import type { RoomInfo } from '../contract.ts';
import { parseRaidRoom, RaidRays, type RaidRoom } from '../raid/raidRoom.ts';
import { hash32, Rng } from '../raid/rng.ts';

export type V = THREE.Vector3;
export interface Box { c: V; h: V }
export interface WzAnchors {
  /** Performers: spot positions and a keep-out (the building): nothing lands inside it or within `safeR` of a spot. */
  spots: V[]; keep: Box[]; safeR: number;
  /** Where the fight is (centroid of the raid area) and the "outside" direction (from the performers towards it). */
  battle: V; out: V; floorY: number;
  road: V[]; armor: V[];
  impacts: Box[];
  rpg: { p: V; dir: V; target: V | null }[];
  sniper: { p: V; dir: V } | null;
  fires: { p: V; size: number; smoke: number }[];
  sky: V[];
  far: Box[];
  dust: V[];
  fly: V[][];
  /** Points either side can fire from / at (raid covers split by side of the street). */
  sideA: V[]; sideB: V[];
  raid: RaidRoom;
  /** Where cameras may cut to for set pieces (CAM_BREACH_xx, CAM_RAID_xx). */
  cams: string[];
}

export interface WarzoneCfg {
  on?: boolean;
  seed?: number;
  /** Ambient battle level: 0.25 … 2 (1 = default). */
  level?: number;
  anchors?: Record<string, unknown>;
  /** Donation tiers (USD minimums): { wz_mortar: 0, wz_heli: 5, wz_armor: 20, wz_assault: 50, wz_airstrike: 100 } */
  support?: Record<string, number>;
  /** Channel-point reward keywords -> set piece: { "air strike": "wz_airstrike", … } */
  rewards?: Record<string, string>;
  /** Frogs always win (the militia never takes the street). Default true. */
  heroes?: boolean;
}

const V3 = (a: unknown): V | null => Array.isArray(a) && a.length >= 3 && a.slice(0, 3).every((x) => typeof x === 'number' && Number.isFinite(x)) ? new THREE.Vector3(a[0] as number, a[1] as number, a[2] as number) : null;

export function parseWarzoneRoom(room: RoomInfo, cfg: WarzoneCfg, npcHeight: number, mainCam: string): WzAnchors {
  const root = room.root;
  root.updateWorldMatrix(true, true);
  const raid = parseRaidRoom(room, npcHeight, mainCam);
  const J = (cfg.anchors ?? {}) as Record<string, unknown>;
  // node (GLB) or scene.json anchor by name: position, +Z facing, extras
  const nodes = new Map<string, THREE.Object3D>();
  root.traverse((o) => { if (/^WZ_/.test(o.name)) nodes.set(o.name, o); });
  const names = (re: RegExp) => [...new Set([...nodes.keys(), ...Object.keys(J)])].filter((n) => re.test(n)).sort();
  const get = (name: string): { p: V; dir: V; extra: Record<string, unknown>; half: V | null } | null => {
    const j = J[name];
    if (j !== undefined) {
      const o = (Array.isArray(j) ? { p: j } : j) as Record<string, unknown>;
      const p = V3(o.p);
      if (!p) return null;
      const yaw = typeof o.yaw === 'number' ? THREE.MathUtils.degToRad(o.yaw) : 0;
      const size = V3(o.size);
      return { p, dir: new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), extra: o, half: size ? size.multiplyScalar(0.5) : null };
    }
    const n = nodes.get(name);
    if (!n) return null;
    const p = n.getWorldPosition(new THREE.Vector3());
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(n.getWorldQuaternion(new THREE.Quaternion()));
    const x = (n.userData ?? {}) as Record<string, unknown>;
    const sz = V3(x.size);
    const s = n.getWorldScale(new THREE.Vector3());
    return { p, dir, extra: x, half: sz ? sz.multiplyScalar(0.5) : s.x !== 1 || s.y !== 1 || s.z !== 1 ? s : null };
  };
  const pts = (re: RegExp) => names(re).map(get).filter((x): x is NonNullable<ReturnType<typeof get>> => !!x);

  // ---- performers + the building
  const spots = room.spots.filter((s): s is NonNullable<typeof s> => !!s).map((s) => s.position.clone());
  const sc = spots.reduce((a, b) => a.add(b), new THREE.Vector3()).divideScalar(Math.max(1, spots.length));
  const keep: Box[] = [];
  if (spots.length) {
    const b = new THREE.Box3().setFromPoints(spots).expandByScalar(4);
    b.max.y += 8; b.min.y -= 3;
    keep.push({ c: b.getCenter(new THREE.Vector3()), h: b.getSize(new THREE.Vector3()).multiplyScalar(0.5) });
  }
  for (const k of pts(/^WZ_KEEPOUT_/)) keep.push({ c: k.p, h: k.half ?? new THREE.Vector3(2, 2, 2) });
  // ---- the battle area (raid anchors)
  const bp = raid.sim.pts.map((p) => new THREE.Vector3(p.x, p.y, p.z));
  const battle = bp.length ? bp.reduce((a, b) => a.add(b), new THREE.Vector3()).divideScalar(bp.length) : sc.clone().add(new THREE.Vector3(0, 0, -30));
  const floorY = bp.length ? bp.map((p) => p.y).sort((a, b) => a - b)[bp.length >> 1] : battle.y;
  const out = battle.clone().sub(sc).setY(0);
  if (out.lengthSq() < 1) out.set(0, 0, -1);
  out.normalize();
  const side = new THREE.Vector3(-out.z, 0, out.x);
  // raid covers / nav split into the two sides of the fight (along the street = the line between the spawns)
  const sp = raid.sim.spawns.map((s) => new THREE.Vector3(s.p.x, s.p.y, s.p.z));
  let axis = side.clone();
  if (sp.length >= 2) { let best = 0; for (const a of sp) for (const b of sp) { const d = a.distanceTo(b); if (d > best) { best = d; axis = b.clone().sub(a).setY(0).normalize(); } } }
  const sideA: V[] = [], sideB: V[] = [];
  for (const p of bp) (p.clone().sub(battle).dot(axis) < 0 ? sideA : sideB).push(p);
  // frogs hold the end their tagged spawn is on (BG_SPAWN extras faction: frog)
  const frogSp = raid.sim.spawns.find((s) => s.fac === 'frog');
  if (frogSp && new THREE.Vector3(frogSp.p.x, 0, frogSp.p.z).sub(battle.clone().setY(0)).dot(axis) > 0) { const t = sideA.splice(0); sideA.push(...sideB.splice(0)); sideB.push(...t); }

  // ---- road
  let road = pts(/^WZ_ROAD_\d+$/).map((x) => x.p);
  if (road.length < 2) {
    const L = Math.max(40, bp.length ? Math.max(...bp.map((p) => Math.abs(p.clone().sub(battle).dot(axis)))) * 2 + 40 : 60);
    const c = battle.clone().addScaledVector(out, 4).setY(floorY);
    road = [c.clone().addScaledVector(axis, -L / 2), c.clone().addScaledVector(axis, -L / 6), c.clone().addScaledVector(axis, L / 6), c.clone().addScaledVector(axis, L / 2)];
  }
  const armorPts = pts(/^WZ_ARMOR_\d+$/).map((x) => x.p);
  const armor = armorPts.length >= 2 ? armorPts : road;
  // wheels on the ground: route points snap down (or up) onto the street surface
  const rays = new RaidRays(raid.solids);
  const DOWN = new THREE.Vector3(0, -1, 0);
  for (const p of [...new Set([...road, ...armor])]) { const h = rays.cast(p.clone().setY(p.y + 0.6), DOWN, 4); if (h.d < Infinity && Math.abs(h.p.y - p.y) < 1.5) p.y = h.p.y; }

  // ---- impact zones
  let impacts: Box[] = pts(/^WZ_IMPACT_/).map((x) => ({ c: x.p, h: x.half ?? new THREE.Vector3(4, 0.5, 4) }));
  if (!impacts.length) {
    // the street around the fight, plus the blocks beyond it
    const ext = bp.length ? new THREE.Box3().setFromPoints(bp) : new THREE.Box3().setFromCenterAndSize(battle, new THREE.Vector3(30, 1, 20));
    const c = ext.getCenter(new THREE.Vector3()).setY(floorY), s = ext.getSize(new THREE.Vector3());
    impacts = [{ c, h: new THREE.Vector3(Math.max(6, s.x / 2 + 4), 0.3, Math.max(6, s.z / 2 + 4)) },
      { c: c.clone().addScaledVector(out, 35), h: new THREE.Vector3(18, 2, 18) }];
  }
  // ---- rpg positions
  let rpg = pts(/^WZ_RPG_\d+$/).map((x) => { const tn = typeof x.extra.target === 'string' ? get(x.extra.target) : null; return { p: x.p, dir: x.dir.clone().setY(0).normalize(), target: tn ? tn.p : null }; });
  if (!rpg.length) {
    const from = sideB.length ? sideB : bp;
    const rng = new Rng(hash32(from.length, 'rpg'));
    for (let i = 0; i < Math.min(4, from.length); i++) { const p = from[rng.int(from.length)].clone(); p.y += 1.4; rpg.push({ p, dir: axis.clone().negate(), target: null }); }
  }
  const sn = get('WZ_SNIPER');
  const sniper = sn ? { p: sn.p, dir: sn.dir.clone().setY(0).normalize() } : null;
  // ---- fires, skyline, far fights
  let fires = pts(/^WZ_FIRE_/).map((x) => ({ p: x.p, size: typeof x.extra.size === 'number' ? x.extra.size : 1, smoke: typeof x.extra.smoke === 'number' ? x.extra.smoke : 0.8 }));
  if (!fires.length) {
    const r = new Rng(hash32(bp.length, 'fire'));
    fires = [0, 1].map((i) => ({ p: road[1 + (i % Math.max(1, road.length - 2))].clone().addScaledVector(side, r.range(-6, 6)).addScaledVector(out, 8 + i * 6), size: 1.2 + i * 0.4, smoke: 0.9 }));
  }
  let sky = pts(/^WZ_SKY_/).map((x) => x.p);
  if (!sky.length) {
    const r = new Rng(7);
    for (let i = 0; i < 9; i++) {
      const a = r.range(-1.0, 1.0), d = r.range(220, 650);
      sky.push(sc.clone().addScaledVector(out, Math.cos(a) * d).addScaledVector(side, Math.sin(a) * d).setY(floorY));
    }
  }
  let far = pts(/^WZ_FAR_/).map((x) => ({ c: x.p, h: x.half ?? new THREE.Vector3(10, 4, 10) }));
  if (!far.length) {
    const r = new Rng(11);
    for (let i = 0; i < 6; i++) {
      const a = r.range(-0.9, 0.9), d = r.range(90, 260);
      far.push({ c: sc.clone().addScaledVector(out, Math.cos(a) * d).addScaledVector(side, Math.sin(a) * d).setY(floorY + r.range(0, 12)), h: new THREE.Vector3(12, 5, 12) });
    }
  }
  const dust = pts(/^WZ_DUST_/).map((x) => x.p);
  let fly = [pts(/^WZ_FLY_\d+$/).map((x) => x.p)].filter((l) => l.length >= 2);
  if (!fly.length) {
    const c = battle.clone().setY(floorY);
    fly = [[c.clone().addScaledVector(axis, -400).addScaledVector(out, 60).setY(floorY + 55), c.clone().addScaledVector(out, 30).setY(floorY + 38), c.clone().addScaledVector(axis, 400).addScaledVector(out, 10).setY(floorY + 60)],
      [c.clone().addScaledVector(axis, 450).addScaledVector(out, 120).setY(floorY + 80), c.clone().addScaledVector(out, 90).setY(floorY + 65), c.clone().addScaledVector(axis, -450).addScaledVector(out, 70).setY(floorY + 90)]];
  }
  const cams = [...room.cameras.keys()].filter((n) => /^CAM_(BREACH|RAID)/.test(n)).sort();
  return { spots, keep, safeR: 12, battle, out, floorY, road, armor, impacts, rpg, sniper, fires, sky, far, dust, fly, sideA, sideB, raid, cams };
}

/** Is p safe for an effect (outside the building keep-outs and far enough from every performer)? */
export function safeAt(A: WzAnchors, p: V, r = A.safeR): boolean {
  for (const k of A.keep) if (Math.abs(p.x - k.c.x) < k.h.x && Math.abs(p.y - k.c.y) < k.h.y && Math.abs(p.z - k.c.z) < k.h.z) return false;
  for (const s of A.spots) if (Math.hypot(p.x - s.x, p.z - s.z) < r) return false;
  return true;
}
