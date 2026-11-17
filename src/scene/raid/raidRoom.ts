// Background-combat anchors of a room (docs/SCENES.md → "Background combat"): BG_NAV_xx (links / cover extras),
// BG_COVER_xx (stance), BG_LOOT_xx (kind), BG_SPAWN_xx, BG_EXIT_xx, BG_ZONE_xx (bounding meshes, hidden),
// BG_GLASS_xx (crackable glass), EVENT_TAGILLA_ENTER / EVENT_TAGILLA_EXIT, SMASH_xx (+ _intact, _piece_*, optional _stand).
//
// Everything the simulation reads is turned into plain numbers here (SimRoom), plus a line-of-sight matrix between
// the stations (nav nodes, covers, loot spots) ray-cast ONCE against the static room geometry. Same GLB → same
// numbers on every page, so the deterministic simulation (sim.ts) agrees everywhere.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { RoomInfo } from '../contract.ts';

export interface P3 { x: number; y: number; z: number }
export type LootKind = 'crate' | 'jacket' | 'weapon_box' | 'safe' | 'filing_cabinet' | 'med';

/** Plain data for sim.ts. Station index space: [0, nav) nav nodes, then covers, then loot spots. */
export interface SimRoom {
  pts: P3[];
  nav: number;
  /** Nav adjacency (neighbour index, distance) — symmetric. */
  adj: [number, number][][];
  navCover: boolean[];
  /** role: extras.role ('pmc_ambush' = raiders lie in wait for the boss squad here, 'guard' = the squad returns fire from here). */
  covers: { i: number; dx: number; dz: number; crouch: boolean; role?: string }[];
  loot: { i: number; dx: number; dz: number; kind: LootKind }[];
  spawns: { p: P3; dx: number; dz: number; nav: number; fac?: string }[];
  /** dump: extras.bodyDump — where the boss squad hauls the bodies. */
  exits: { p: P3; nav: number; dump?: boolean }[];
  /** los[i * pts.length + j] = 1 when standing eye heights see each other (null until the ray job finished). */
  los: Uint8Array | null;
  /** NPC scale (npc height / 1.8 m model). */
  scale: number;
  /** PATROL_PATH_xx in order + PATROL_PAUSE_xx (index into path, ticks, facing) — the boss squad's route. */
  patrol: { path: P3[]; pauses: PatrolPause[]; form: { f: 'file' | 'column' | 'wedge'; w: number }[] } | null;
}
/** A PATROL_PAUSE_xx: path index, length, where the boss looks (yaw / lookAt point), the action and where the guards stand. */
export interface PatrolPause { i: number; ticks: number; yaw: number | null; action?: string; look?: P3 | null; slots?: P3[] }

export interface SmashProp {
  name: string;
  node: THREE.Object3D;
  intact: THREE.Object3D[];
  pieces: THREE.Object3D[];
  /** Where the brute stands (floor) + which way he faces for the swing. */
  stand: THREE.Vector3;
  yaw: number;
  center: THREE.Vector3;
  box: THREE.Box3;
  floorY: number;
  /** Seen from the room's main camera (CAM_WIDE / defaultCamera) — the donation event prefers these. */
  inWide: boolean;
}

export interface RaidRoom {
  sim: SimRoom;
  zones: { inv: THREE.Matrix4; box: THREE.Box3; keepOut: boolean }[];
  glass: THREE.Mesh[];
  enter: { p: THREE.Vector3; yaw: number } | null;
  exit: { p: THREE.Vector3; yaw: number } | null;
  /** EVENT_TAGILLA_ENTER extras.path: waypoints in (the last may be a ROAR hero-pose point), the door he kicks. */
  tagPath: { p: THREE.Vector3; name: string; kick: boolean }[];
  roar: { p: THREE.Vector3; yaw: number } | null;
  kickDoor: boolean;
  smash: SmashProp[];
  canFight: boolean;
  canTagilla: boolean;
  canPatrol: boolean;
  /** Nav node names (debug). */
  names: string[];
  /** Static meshes for impact rays (no glass / zones / pieces / doors / screen). */
  solids: THREE.Mesh[];
  /** CAM_RAID_xx camera presets (the preshow director). */
  raidCams: string[];
}

const tv = new THREE.Vector3();
const tq = new THREE.Quaternion();
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const p3 = (v: THREE.Vector3): P3 => ({ x: r4(v.x), y: r4(v.y), z: r4(v.z) });

function facing(o: THREE.Object3D) {
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(o.getWorldQuaternion(tq));
  f.y = 0;
  if (f.lengthSq() < 1e-6) f.set(0, 0, 1);
  f.normalize();
  return { dx: r4(f.x), dz: r4(f.z), yaw: Math.atan2(f.x, f.z) };
}

const extra = (o: THREE.Object3D) => (o.userData ?? {}) as Record<string, unknown>;
const LOOT_KINDS = new Set(['crate', 'jacket', 'weapon_box', 'safe', 'filing_cabinet', 'med']);

function meshesUnder(o: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  o.traverse((c) => { if ((c as THREE.Mesh).isMesh) out.push(c as THREE.Mesh); });
  return out;
}

export function parseRaidRoom(room: RoomInfo, npcHeight: number, mainCam = 'CAM_WIDE'): RaidRoom {
  const root = room.root;
  root.updateWorldMatrix(true, true);
  const byName = (re: RegExp) => {
    const out: THREE.Object3D[] = [];
    root.traverse((o) => { if (re.test(o.name)) out.push(o); });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  };
  // zones: mesh boxes, or empties whose scale = half extents (extras.size = full extents); extras visibility 'none'
  // (or keepOut: true) = a keep-out box (NPCs never go there)
  const zones: RaidRoom['zones'] = [];
  for (const z of byName(/^BG_ZONE_[A-Za-z0-9]+$/)) {
    const x = extra(z);
    const keepOut = x.visibility === 'none' || x.keepOut === true;
    const ms = meshesUnder(z);
    if (ms.length) for (const m of ms) { m.geometry.computeBoundingBox(); zones.push({ inv: m.matrixWorld.clone().invert(), box: m.geometry.boundingBox!.clone().expandByScalar(0.05), keepOut }); }
    else {
      const sc = z.getWorldScale(new THREE.Vector3());
      const size = Array.isArray(x.size) && x.size.length === 3 ? x.size.map(Number) : null;
      const h = size && size.every(Number.isFinite) ? new THREE.Vector3(size[0] / 2 / (sc.x || 1), size[1] / 2 / (sc.y || 1), size[2] / 2 / (sc.z || 1)) : new THREE.Vector3(1, 1, 1);
      zones.push({ inv: z.matrixWorld.clone().invert(), box: new THREE.Box3(h.clone().negate(), h).expandByScalar(0.02), keepOut });
    }
  }
  const inBox = (z: RaidRoom['zones'][number], p: THREE.Vector3, pad = 0.6) => {
    const l = tv.copy(p).applyMatrix4(z.inv);
    return l.x >= z.box.min.x && l.x <= z.box.max.x && l.z >= z.box.min.z && l.z <= z.box.max.z && l.y >= z.box.min.y - pad && l.y <= z.box.max.y;
  };
  const allow = zones.filter((z) => !z.keepOut), deny = zones.filter((z) => z.keepOut);
  const inZone = (p: THREE.Vector3) => (!allow.length || allow.some((z) => inBox(z, p))) && !deny.some((z) => inBox(z, p, 0.05));

  // nav nodes
  const navObjs = byName(/^BG_NAV_[A-Za-z0-9]+$/).filter((o) => inZone(o.getWorldPosition(new THREE.Vector3())));
  const names = navObjs.map((o) => o.name);
  const pts: P3[] = navObjs.map((o) => p3(o.getWorldPosition(new THREE.Vector3())));
  const nav = pts.length;
  const dist = (a: P3, b: P3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const adjSet: Set<number>[] = navObjs.map(() => new Set());
  navObjs.forEach((o, i) => {
    const l = extra(o).links;
    const list = typeof l === 'string' ? l.split(',') : Array.isArray(l) ? l.map(String) : [];
    for (const n of list) {
      const j = names.indexOf(n.trim());
      if (j >= 0 && j !== i) { adjSet[i].add(j); adjSet[j].add(i); }
    }
  });
  const adj = adjSet.map((s, i) => [...s].sort((a, b) => a - b).map((j) => [j, r4(dist(pts[i], pts[j]))] as [number, number]));
  const navCover = navObjs.map((o) => Number(extra(o).cover) === 1 || extra(o).cover === true);

  const covers: SimRoom['covers'] = [];
  for (const o of byName(/^BG_COVER_[A-Za-z0-9]+$/)) {
    const p = o.getWorldPosition(new THREE.Vector3());
    if (!inZone(p)) continue;
    const f = facing(o);
    const role = typeof extra(o).role === 'string' ? String(extra(o).role) : undefined;
    covers.push({ i: pts.length, dx: f.dx, dz: f.dz, crouch: extra(o).stance !== 'stand', ...(role ? { role } : {}) });
    pts.push(p3(p));
  }
  const loot: SimRoom['loot'] = [];
  for (const o of byName(/^BG_LOOT_[A-Za-z0-9]+$/)) {
    const p = o.getWorldPosition(new THREE.Vector3());
    if (!inZone(p)) continue;
    const f = facing(o);
    const k = String(extra(o).kind ?? 'crate');
    loot.push({ i: pts.length, dx: f.dx, dz: f.dz, kind: (LOOT_KINDS.has(k) ? k : 'crate') as LootKind });
    pts.push(p3(p));
  }
  const navHint = (o: THREE.Object3D) => { const n = extra(o).nav; return typeof n === 'string' ? names.indexOf(n) : -1; };
  const spawns = byName(/^BG_SPAWN_[A-Za-z0-9]+$/).map((o) => { const f = facing(o); const fac = extra(o).faction; return { p: p3(o.getWorldPosition(new THREE.Vector3())), dx: f.dx, dz: f.dz, nav: navHint(o), ...(typeof fac === 'string' ? { fac } : {}) }; });
  const exits = byName(/^BG_EXIT_[A-Za-z0-9]+$/).map((o) => ({ p: p3(o.getWorldPosition(new THREE.Vector3())), nav: navHint(o), ...(extra(o).bodyDump === true ? { dump: true } : {}) }));

  const glass = byName(/^BG_GLASS_[A-Za-z0-9]+$/).flatMap((g) => meshesUnder(g));
  const node = (n: string) => root.getObjectByName(n) ?? null;
  const ev = (n: string) => { const o = node(n); return o ? { p: o.getWorldPosition(new THREE.Vector3()), yaw: facing(o).yaw } : null; };
  const enter = ev('EVENT_TAGILLA_ENTER'), exit = ev('EVENT_TAGILLA_EXIT');
  // entry route (extras.path on EVENT_TAGILLA_ENTER, else EVENT_TAGILLA_PATH_xx in order), ROAR hero pose, door kick
  const enterObj = node('EVENT_TAGILLA_ENTER');
  const pathNames = typeof extra(enterObj ?? root).path === 'string' ? String(extra(enterObj!).path).split(/[,→>]+/).map((x) => x.trim()).filter(Boolean)
    : byName(/^EVENT_TAGILLA_PATH_\d+$/).map((o) => o.name);
  const kickDoor = !!enterObj && (typeof extra(enterObj).door === 'string' || extra(enterObj).kick === true) && !!room.door;
  const doorPos = room.door ? room.door.node.getWorldPosition(new THREE.Vector3()) : null;
  const tagPath = pathNames.map((n) => node(n)).filter((o): o is THREE.Object3D => !!o && !/ROAR$/.test(o.name)).map((o) => ({ p: o.getWorldPosition(new THREE.Vector3()), name: o.name, kick: /kick/i.test(String(extra(o).note ?? '')) || extra(o).kick === true }));
  if (kickDoor && tagPath.length && !tagPath.some((w) => w.kick) && doorPos) {
    let bi = 0; tagPath.forEach((w, i) => { if (w.p.distanceTo(doorPos) < tagPath[bi].p.distanceTo(doorPos)) bi = i; }); tagPath[bi].kick = true;
  }
  const roar = ev('EVENT_TAGILLA_ROAR');

  const smash: SmashProp[] = [];
  for (const o of byName(/^SMASH_[A-Za-z0-9]+$/)) {
    if (/_(intact|stand)$/.test(o.name) || /_piece/.test(o.name)) continue;
    const intact: THREE.Object3D[] = [], pieces: THREE.Object3D[] = [];
    let standObj: THREE.Object3D | null = null;
    o.traverse((c) => {
      if (c === o) return;
      if (c.name.startsWith(`${o.name}_intact`) && !intact.some((x) => isAncestor(x, c))) intact.push(c);
      else if (c.name.startsWith(`${o.name}_piece`) && !pieces.some((x) => isAncestor(x, c))) pieces.push(c);
    });
    standObj = node(`${o.name}_stand`);
    // EVENT_TAGILLA_STRIKE_xx with extras.target = this prop (face its +Z and swing)
    let strike: THREE.Object3D | null = null;
    root.traverse((c) => { if (!strike && /^EVENT_TAGILLA_STRIKE/.test(c.name) && extra(c).target === o.name) strike = c; });
    if (!intact.length) continue;
    const box = new THREE.Box3();
    for (const m of intact) box.expandByObject(m);
    const center = box.getCenter(new THREE.Vector3());
    let stand: THREE.Vector3, yaw: number;
    const sf = extra(o).strikeFrom;
    if (strike) { const s2 = strike as THREE.Object3D; stand = s2.getWorldPosition(new THREE.Vector3()); yaw = facing(s2).yaw; }
    else if (standObj) { stand = standObj.getWorldPosition(new THREE.Vector3()); const to = center.clone().sub(stand).setY(0); yaw = Math.atan2(to.x, to.z); }
    else if (Array.isArray(sf) && sf.length === 3 && sf.every((v) => Number.isFinite(Number(v)))) {
      stand = root.localToWorld(new THREE.Vector3(Number(sf[0]), Number(sf[1]), Number(sf[2])));
      const to = center.clone().sub(stand).setY(0); yaw = Math.atan2(to.x, to.z);
    } else {
      // in front of the prop, on the side facing the entrance (or the room's front)
      const from = enter ? enter.p.clone() : center.clone().add(new THREE.Vector3(0, 0, 3));
      const d = from.sub(center).setY(0).normalize();
      const r = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2;
      stand = center.clone().addScaledVector(d, r + 0.95).setY(box.min.y);
      yaw = Math.atan2(-d.x, -d.z);
    }
    for (const p of pieces) p.visible = false;
    o.traverse((c) => { if (extra(c).hiddenUntilBroken === true && !pieces.includes(c) && !pieces.some((x) => isAncestor(x, c))) { c.visible = false; pieces.push(c); } });
    smash.push({ name: o.name, node: o, intact, pieces, stand, yaw, center, box, floorY: box.min.y, inWide: seenFrom(room, mainCam, center) });
  }

  // static geometry for impacts / line of sight
  const solids: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) {
      if (!p.visible || /^(BG_|SMASH_|DOOR|SCREEN|COLLIDE_|EVENT_|LIGHT_)/.test(p.name)) return;
    }
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    if ((mat as THREE.Material)?.transparent && (mat as THREE.Material).opacity < 0.6) return;
    solids.push(m);
  });

  // patrol route (ordered by the number in the name) + pauses (extras.at = the path point, else the nearest one)
  const num = (n: string) => { const m = /(\d+)\D*$/.exec(n); return m ? +m[1] : 0; };
  const routeObjs = byName(/^PATROL_PATH_[A-Za-z0-9]+$/).sort((a, b) => num(a.name) - num(b.name) || a.name.localeCompare(b.name));
  let patrol: SimRoom['patrol'] = null;
  // glTF-space xyz from extras (a triplet, or a flat / nested list of triplets)
  const trip = (v: unknown): P3[] => {
    const flat = (Array.isArray(v) ? v.flat(2) : []).map(Number);
    const out: P3[] = [];
    for (let k = 0; k + 2 < flat.length; k += 3) if (flat.slice(k, k + 3).every(Number.isFinite)) out.push(p3(root.localToWorld(new THREE.Vector3(flat[k], flat[k + 1], flat[k + 2]))));
    return out;
  };
  if (routeObjs.length >= 2) {
    const path = routeObjs.map((o) => p3(o.getWorldPosition(new THREE.Vector3())));
    const form = routeObjs.map((o) => {
      const x = extra(o);
      const f = x.formation === 'column' || x.formation === 'wedge' ? x.formation : 'file';
      const w = Number(x.width);
      return { f: f as 'file' | 'column' | 'wedge', w: Number.isFinite(w) && w > 0 ? w : 1.4 };
    });
    const pauses: PatrolPause[] = [];
    for (const o of byName(/^PATROL_PAUSE_[A-Za-z0-9]+$/)) {
      const p = o.getWorldPosition(new THREE.Vector3());
      const x = extra(o);
      let bi = typeof x.at === 'string' ? routeObjs.findIndex((r) => r.name === x.at) : -1;
      if (bi < 0) { bi = 1; let bd = Infinity; path.forEach((q, i) => { const d = Math.hypot(q.x - p.x, q.z - p.z); if (i > 0 && d < bd) { bd = d; bi = i; } }); }
      const secs = Number(x.secs ?? x.seconds ?? x.duration ?? x.pause ?? 5);
      const look = trip(x.lookAt)[0] ?? null;
      const slots = trip(x.guardSlots);
      pauses.push({
        i: bi, ticks: Math.round(Math.max(1, Math.min(30, Number.isFinite(secs) ? secs : 5)) * 10), yaw: facing(o).yaw,
        ...(typeof x.action === 'string' ? { action: String(x.action) } : {}), look, ...(slots.length ? { slots } : {}),
      });
    }
    patrol = { path, pauses: pauses.sort((a, b) => a.i - b.i), form };
  }
  const sim: SimRoom = { pts, nav, adj, navCover, covers, loot, spawns, exits, los: null, scale: npcHeight / 1.8, patrol };
  return {
    sim, zones, glass, enter, exit, smash, names, solids, tagPath, roar, kickDoor,
    raidCams: [...room.cameras.keys()].filter((n) => /^CAM_(RAID|BREACH)/.test(n)).sort(),   // (warzone rooms: the breach cameras)
    canFight: nav >= 2 && spawns.length >= 1 && (exits.length >= 1),
    canPatrol: !!patrol && nav >= 2,
    canTagilla: !!enter && smash.length > 0,
  };
}

/** Is a point inside a camera preset's 16:9 frustum (room constant — same answer on every page)? */
function seenFrom(room: RoomInfo, cam: string, p: THREE.Vector3) {
  const c = room.cameras.get(cam) ?? room.cameras.get('CAM_WIDE');
  if (!c) return true;
  const pc = new THREE.PerspectiveCamera(c.fov, 16 / 9, 0.05, 200);
  pc.position.copy(c.position); pc.quaternion.copy(c.quaternion); pc.updateMatrixWorld(); pc.updateProjectionMatrix();
  const v = p.clone().project(pc);
  return v.z < 1 && Math.abs(v.x) < 0.92 && Math.abs(v.y) < 0.95;
}

function isAncestor(a: THREE.Object3D, b: THREE.Object3D) { for (let p = b.parent; p; p = p.parent) if (p === a) return true; return false; }

/** Ray tests against the static room (BVH per geometry, built lazily). */
export class RaidRays {
  private bvh = new WeakMap<THREE.BufferGeometry, MeshBVH>();
  private boxes: THREE.Box3[];
  private inv: THREE.Matrix4[];
  private ray = new THREE.Ray();
  private lr = new THREE.Ray();
  constructor(readonly meshes: THREE.Mesh[]) {
    this.boxes = meshes.map((m) => new THREE.Box3().setFromObject(m));
    this.inv = meshes.map((m) => m.matrixWorld.clone().invert());
  }
  /** First hit from a along dir (unit) within maxD: distance, point, world normal, mesh. */
  cast(a: THREE.Vector3, dir: THREE.Vector3, maxD: number, out?: { d: number; p: THREE.Vector3; n: THREE.Vector3; m: THREE.Mesh | null }) {
    const res = out ?? { d: Infinity, p: new THREE.Vector3(), n: new THREE.Vector3(), m: null as THREE.Mesh | null };
    res.d = Infinity; res.m = null;
    this.ray.set(a, dir);
    const hp = new THREE.Vector3();
    for (let i = 0; i < this.meshes.length; i++) {
      const b = this.boxes[i];
      if (!b.containsPoint(a) && (!this.ray.intersectBox(b, hp) || hp.distanceTo(a) > Math.min(maxD, res.d))) continue;
      const m = this.meshes[i];
      const g = m.geometry;
      if (!g?.attributes?.position) continue;
      let t = this.bvh.get(g);
      if (!t) { try { t = new MeshBVH(g); } catch { continue; } this.bvh.set(g, t); }
      this.lr.copy(this.ray).applyMatrix4(this.inv[i]);
      const h = t.raycastFirst(this.lr, THREE.DoubleSide);
      if (!h) continue;
      const wp = h.point.clone().applyMatrix4(m.matrixWorld);
      const d = wp.distanceTo(a);
      if (d < res.d && d <= maxD) {
        res.d = d; res.p.copy(wp); res.m = m;
        if (h.face) res.n.copy(h.face.normal).transformDirection(m.matrixWorld); else res.n.copy(dir).negate();
      }
    }
    return res;
  }
  clear(a: THREE.Vector3, b: THREE.Vector3, endPad = 0.35) {
    const d = b.clone().sub(a);
    const len = d.length();
    if (len < 1e-3) return true;
    const h = this.cast(a, d.divideScalar(len), len);
    return !(h.d < len - endPad && h.d > 0.25);
  }
}

/** Line-of-sight matrix between all stations, spread over frames (yield ≈ every few ms). */
export function* losJob(sim: SimRoom, rays: RaidRays): Generator<void, Uint8Array, void> {
  const n = sim.pts.length;
  const los = new Uint8Array(n * n);
  const eye = 1.4 * sim.scale;
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  let t0 = performance.now();
  for (let i = 0; i < n; i++) {
    los[i * n + i] = 1;
    for (let j = i + 1; j < n; j++) {
      a.set(sim.pts[i].x, sim.pts[i].y + eye, sim.pts[i].z);
      b.set(sim.pts[j].x, sim.pts[j].y + eye, sim.pts[j].z);
      const v = a.distanceTo(b) < 45 && rays.clear(a, b) ? 1 : 0;
      los[i * n + j] = v; los[j * n + i] = v;
      if (performance.now() - t0 > 0.9) { yield; t0 = performance.now(); }
    }
  }
  return los;
}
