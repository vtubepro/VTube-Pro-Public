// Space-room anchors (docs/SCENES.md → "Space battle"): the viewport, the planet / moon / sun, parked capital ships,
// flight lanes, warp points, enemy approach points — plus the cryo bay (join) and drop-pod bay (leave). Read once from
// the room GLB's named nodes, with scene.json `space` as an override / fallback (glTF-space positions).
//
// Space is drawn COMPRESSED about the viewport centre (a homothety of factor `k`): authored distances of kilometres
// would ruin the depth precision of the room, so everything outside is scaled towards the glass (angular sizes seen
// from the viewport are unchanged; only parallax is a little stronger). The director works in authored units.
import * as THREE from 'three';
import type { CameraPreset, RoomInfo } from '../contract.ts';
import { spaceActsOf, type SpaceAct } from '../../../shared/space.ts';
import type { SceneInfo } from '../../../shared/types.ts';
import type { RoomSpaceConfig } from '../../../shared/space.ts';
import { legacyStyle, parseRoleStyles, type RoleStyles } from '../../../shared/arrivals.ts';

type V3 = THREE.Vector3;
export interface Anchor { name: string; p: V3; fwd: V3; q: THREE.Quaternion; extras: Record<string, unknown> }

export interface CryoPod { index: number; name: string; node: THREE.Object3D; p: V3; yaw: number; fwd: V3; door: THREE.Object3D | null; doorMode: string; doorAngle: number; out: V3; outYaw: number; doorBox: THREE.Box3 | null;
  /** Optional CRYO_POD_xx_window (a child of the door): the small view window the frozen occupant is seen through. */
  window: THREE.Object3D | null }
export interface DropPod { index: number; name: string; node: THREE.Object3D; p: V3; yaw: number; fwd: V3; hatch: THREE.Object3D | null; hatchMode: string; hatchAngle: number; board: V3; boardYaw: number; tubeStart: V3; tubeEnd: V3; exitDir: V3 | null; target: V3 | null }

export interface SpaceRoom {
  /** Viewport glass: centre, normal INTO space, right / up in the glass plane, size (m). */
  view: { center: V3; normal: V3; right: V3; up: V3; width: number; height: number };
  /** Compression factor (render = c + (authored - c) * k) and the eye the director aims its shots at (authored). */
  k: number;
  eye: V3;
  /** The room's main camera (CAM_WIDE / defaultCamera): the director prefers what it can see. */
  cam0: CameraPreset | null;
  planet: { center: V3; radius: number; palette: string; spin: number };
  moon: { center: V3; radius: number } | null;
  sun: { dir: V3; pos: V3; color: THREE.Color };
  ships: (Anchor & { kind: string; length: number })[];
  /** Our own ship's cannon muzzles (SPACE_CANNON_xx, + scene.json `space.cannonNodes`): barrages + lasers from the ship
   *  the streamer is on. */
  cannons: Anchor[];
  /** scene.json `space.fireFrom: 'cannons'` (and the room has cannons): barrages + lasers only ever fire from them. */
  cannonsOnly: boolean;
  /** scene.json `space.acts`: the only acts this room keeps (null = every act). */
  acts: ReadonlySet<SpaceAct> | null;
  /** scene.json `space.podSize`: the drop-pod streak's size × (default 1). */
  podSize: number;
  /** Surface combat sites (SPACE_BATTLE_xx): planet directions. */
  sites: V3[];
  /** Boxes effects keep out of (SPACE_KEEPOUT_xx: our bow / superstructure). */
  keepOut: THREE.Box3[];
  /** What the room draws itself (its own planet / sky / moon / static fleet meshes): the space layer then only adds
   *  the moving parts (and, on an own planet, an emissive combat overlay). */
  own: { planet: boolean; sky: boolean; moon: boolean; fleet: boolean; overlayRadius: number; planetNode?: string | null };
  lanes: { pts: V3[]; adj: number[][] };
  warps: Anchor[];
  approaches: Anchor[];
  zone: THREE.Box3 | null;
  /** Farthest authored distance from the viewport (camera far plane). */
  reach: number;
  sky: boolean;
  /** Room units per nominal unit (the director is written for a 1800-radius planet / 180 m destroyers). */
  unit: number;
  /** Cryo join / drop-pod leave. */
  cryoPods: CryoPod[];
  joinPath: V3[];
  dropPods: DropPod[];
  leavePath: V3[];
  cams: { cryo: CameraPreset | null; dropbay: CameraPreset | null; viewport: CameraPreset | null };
  hasSpace: boolean;
  entrance: string | null;
  exit: string | null;
  /** Per role (scene.json entrance / exit may be { host, guests }: shared/arrivals.ts); a string = both roles. */
  entranceBy: RoleStyles;
  exitBy: RoleStyles;
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(+v) ? +v : d);
const vec = (v: unknown): [number, number, number] | null => (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((x) => Number.isFinite(Number(x))) ? [Number(v[0]), Number(v[1]), Number(v[2])] : null);
const flatYaw = (f: V3) => Math.atan2(f.x, f.z);

function anchorOf(o: THREE.Object3D): Anchor {
  o.updateWorldMatrix(true, false);
  const p = o.getWorldPosition(new THREE.Vector3());
  const q = o.getWorldQuaternion(new THREE.Quaternion());
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
  return { name: o.name, p, fwd, q, extras: (o.userData ?? {}) as Record<string, unknown> };
}

/** Space / cryo anchors of a room (null = not a space room). */
export function parseSpaceRoom(room: RoomInfo, info: SceneInfo | null): SpaceRoom | null {
  const cfg = ((info as unknown as { space?: RoomSpaceConfig } | null)?.space ?? {}) as RoomSpaceConfig;
  const X = (info ?? {}) as unknown as Record<string, unknown>;
  const nodes = new Map<string, THREE.Object3D>();
  room.root.updateWorldMatrix(true, true);
  room.root.traverse((o) => { if (o.name && !nodes.has(o.name)) nodes.set(o.name, o); });
  const w = (v: [number, number, number]) => room.root.localToWorld(new THREE.Vector3(...v));
  const sorted = (re: RegExp) => [...nodes.entries()].filter(([n]) => re.test(n)).sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true })).map(([, o]) => o);

  // ---- viewport
  const vn = nodes.get('SPACE_VIEW');
  const spots = room.spots.filter((s): s is NonNullable<typeof s> => !!s);
  const spotC = spots.length ? spots.reduce((a, s) => a.add(s.position), new THREE.Vector3()).multiplyScalar(1 / spots.length) : new THREE.Vector3();
  let center: V3 | null = null, normal: V3 | null = null, width = 8, height = 3;
  if (vn) {
    const a = anchorOf(vn);
    center = a.p; normal = vec(a.extras.normal) ? new THREE.Vector3(...vec(a.extras.normal)!).normalize() : a.fwd.clone();
    width = num(a.extras.width, width); height = num(a.extras.height, height);
    // a mesh plane: its size
    const box = new THREE.Box3().setFromObject(vn);
    if (!box.isEmpty() && !(a.extras.width)) { const s = box.getSize(new THREE.Vector3()); width = Math.max(s.x, s.z, 1); height = Math.max(s.y, 1); }
  }
  if (cfg.view?.center) center = w(cfg.view.center);
  if (cfg.view?.normal) normal = new THREE.Vector3(...cfg.view.normal).normalize();
  if (cfg.view?.width) width = cfg.view.width;
  if (cfg.view?.height) height = cfg.view.height;

  const planetNode = nodes.get('SPACE_PLANET');
  // the room's own planet under another name (scene.json `space.planetNode`): a mesh the room draws itself
  const ownPlanetName = typeof cfg.planetNode === 'string' && cfg.planetNode.trim() ? cfg.planetNode.trim() : null;
  const ownPlanetNode = ownPlanetName ? nodes.get(ownPlanetName) ?? null : null;
  // existing room nodes named as our cannons (scene.json `space.cannonNodes`, e.g. turret MUZZLE_* nodes)
  const cannonExtra = (Array.isArray(cfg.cannonNodes) ? cfg.cannonNodes : []).filter((n): n is string => typeof n === 'string' && !/^SPACE_CANNON_\d+$/.test(n)).map((n) => nodes.get(n)).filter((o): o is THREE.Object3D => !!o);
  const hasSpace = !!(vn || planetNode || cfg.planet?.center || sorted(/^SPACE_SHIP_\d+$/).length || ownPlanetNode);
  const cryoNodes = sorted(/^CRYO_POD_\d+$/);
  const dropNodes = sorted(/^DROP_POD_\d+$/);
  if (!hasSpace && !cryoNodes.length && !dropNodes.length) return null;

  // default viewport: behind the spots, away from the default camera
  const cam0 = room.cameras.get(String(X.defaultCamera ?? 'CAM_WIDE')) ?? room.cameras.get('CAM_WIDE') ?? null;
  if (!center) center = spotC.clone().add(new THREE.Vector3(0, 2, -6));
  if (!normal) normal = cam0 ? center.clone().sub(cam0.position).setY(0).normalize() : new THREE.Vector3(0, 0, -1);
  if (spots.length && normal.dot(spotC.clone().sub(center)) > 0) normal.negate();     // must point away from the people
  const up0 = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(normal, up0).normalize();
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
  const up = new THREE.Vector3().crossVectors(right, normal).normalize();

  // ---- planet / moon / sun
  const pa = planetNode ? anchorOf(planetNode) : null;
  const ownBox = ownPlanetNode ? new THREE.Box3().setFromObject(ownPlanetNode) : null;
  const ownSphere = ownBox && !ownBox.isEmpty() ? { c: ownBox.getCenter(new THREE.Vector3()), r: Math.max(...ownBox.getSize(new THREE.Vector3()).toArray()) / 2 } : null;
  const pc = cfg.planet?.center ? w(cfg.planet.center) : pa ? pa.p : ownSphere ? ownSphere.c.clone() : center.clone().addScaledVector(normal, 2400).add(new THREE.Vector3(0, -1900, 0));
  const pr = num(cfg.planet?.radius, pa ? num(pa.extras.radius, ownSphere && ownSphere.r > 0 ? ownSphere.r : 1800) : ownSphere && ownSphere.r > 0 ? ownSphere.r : 1800);
  const planet = { center: pc, radius: pr, palette: String(cfg.planet?.palette ?? pa?.extras.palette ?? 'helldive'), spin: num(cfg.planet?.spin, num(pa?.extras.spin, 1)) };
  const mn = nodes.get('SPACE_MOON');
  let moon: SpaceRoom['moon'] = null;
  if (cfg.moon !== null) {
    if (cfg.moon?.center) moon = { center: w(cfg.moon.center), radius: num(cfg.moon.radius, 150) };
    else if (mn) { const a = anchorOf(mn); moon = { center: a.p, radius: num(a.extras.radius, 150) }; }
  }
  const sn = nodes.get('SPACE_SUN');
  let sunPos: V3;
  if (cfg.sun?.position) sunPos = w(cfg.sun.position);
  else if (sn) sunPos = anchorOf(sn).p;
  else sunPos = pc.clone().add(new THREE.Vector3(0.8, 0.45, 0.4).normalize().multiplyScalar(6000));
  const sd = (cfg.sun as { dir?: number[] } | undefined)?.dir ?? (vec(sn?.userData?.dir) ?? undefined);
  const sunDir = cfg.sun?.direction ? new THREE.Vector3(...cfg.sun.direction).normalize() : sd ? new THREE.Vector3(sd[0], sd[1], sd[2]).normalize() : sunPos.clone().sub(pc).normalize();
  if (sd && !cfg.sun?.position) sunPos = pc.clone().addScaledVector(sunDir, pr * 30);
  let sunColor = new THREE.Color('#fff2dc');
  try { if (cfg.sun?.color) sunColor = new THREE.Color(cfg.sun.color); else if (typeof sn?.userData?.color === 'string') sunColor = new THREE.Color(sn.userData.color as string); } catch { /* bad colour */ }

  // ---- ships, lanes, warps, approaches, zone
  const ships = sorted(/^SPACE_SHIP_\d+$/).map((o) => {
    const a = anchorOf(o); const k = String(a.extras.kind ?? a.extras.type ?? 'destroyer').toLowerCase();
    const f = vec(a.extras.forward); if (f) a.fwd.set(...f).normalize();
    return { ...a, kind: /frig|corv/.test(k) ? 'frigate' : 'destroyer', length: num(a.extras.length, 0) };
  });
  const laneNodes = sorted(/^SPACE_LANE_\d+$/);
  const lanePts = laneNodes.map((o) => anchorOf(o).p);
  const adj: number[][] = laneNodes.map(() => []);
  laneNodes.forEach((o, i) => {
    const links = String((o.userData as Record<string, unknown>)?.links ?? '').split(/[,\s]+/).filter(Boolean);
    for (const l of links) { const j = laneNodes.findIndex((x) => x.name === l); if (j >= 0 && j !== i) { if (!adj[i].includes(j)) adj[i].push(j); if (!adj[j].includes(i)) adj[j].push(i); } }
  });
  // no links authored: a loop in file order
  if (lanePts.length > 1 && adj.every((a) => !a.length)) for (let i = 0; i < lanePts.length; i++) { const j = (i + 1) % lanePts.length; adj[i].push(j); adj[j].push(i); }
  const dirOf = (a: Anchor) => { const d = vec(a.extras.dir); if (d) a.fwd.set(...d).normalize(); return a; };
  const warps = sorted(/^SPACE_WARP_\d+$/).map(anchorOf).map(dirOf);
  const approaches = sorted(/^SPACE_ENEMY_APPROACH_\d+$/).map(anchorOf).map(dirOf);
  const cannons = [...sorted(/^SPACE_CANNON_\d+$/), ...cannonExtra].map(anchorOf).map(dirOf);
  const sites = sorted(/^SPACE_BATTLE_\d+$/).map((o) => { const a = anchorOf(o); const n = vec(a.extras.normal); return n ? new THREE.Vector3(...n).normalize() : a.p.clone().sub(pc).normalize(); });
  const keepOut = sorted(/^SPACE_KEEPOUT_\d+$/).map((o) => { const a = anchorOf(o); const s = vec(a.extras.size); return s ? new THREE.Box3().setFromCenterAndSize(a.p, new THREE.Vector3(...s)) : new THREE.Box3().setFromObject(o); }).filter((b) => !b.isEmpty());
  let zone: THREE.Box3 | null = null;
  const zn = nodes.get('SPACE_ZONE');
  if (zn) {
    const a = anchorOf(zn);
    const size = vec(a.extras.size);
    const mn0 = vec(a.extras.min), mx0 = vec(a.extras.max);
    if (mn0 && mx0) zone = new THREE.Box3(new THREE.Vector3(...mn0).min(new THREE.Vector3(...mx0)), new THREE.Vector3(...mn0).max(new THREE.Vector3(...mx0)));
    else if (size) zone = new THREE.Box3().setFromCenterAndSize(a.p, new THREE.Vector3(...size));
    else {
      const b = new THREE.Box3().setFromObject(zn);
      if (!b.isEmpty() && b.getSize(new THREE.Vector3()).length() > 1) zone = b;
      else { const s = zn.getWorldScale(new THREE.Vector3()); zone = new THREE.Box3().setFromCenterAndSize(a.p, s.multiplyScalar(2)); }
    }
  }

  // ---- what the room draws itself
  const meshNamed = (re: RegExp) => [...nodes.entries()].some(([n, o]) => re.test(n) && ((o as THREE.Mesh).isMesh || o.children.some((c) => (c as THREE.Mesh).isMesh)));
  const pExtras = (pa?.extras ?? {}) as Record<string, unknown>;
  const ownPlanetMesh = !!ownPlanetNode && ((ownPlanetNode as THREE.Mesh).isMesh || ownPlanetNode.children.some((c) => (c as THREE.Mesh).isMesh));
  const own = { planet: meshNamed(/^PLANET$/) || ownPlanetMesh, sky: meshNamed(/^SPACE_SKY$|^SKY$/), moon: meshNamed(/^MOON$/), fleet: meshNamed(/^SPACE_FLEET$/), overlayRadius: 0, planetNode: ownPlanetMesh ? ownPlanetName : null };
  own.overlayRadius = num((cfg.planet as Record<string, unknown> | undefined)?.fxRadius, num(pExtras.fxRadius, pr * 1.012)) + pr * 0.0015;
  // ---- nominal space: the director is written for a ~1800-radius planet and 180 m destroyers. A room authored at
  // another scale (e.g. a compact diorama with 40 m capital ships) is mapped by a homothety about the glass (factor U).
  const lens = ships.map((s) => s.length).filter((l) => l > 0);
  const U = lens.length ? (lens.reduce((a, b) => a + b, 0) / lens.length) / 180 : pr / 1800;
  const toN = (p: V3) => p.sub(center).multiplyScalar(1 / U).add(center);
  for (const s of ships) { toN(s.p); s.length /= U; }
  for (const a of [...warps, ...approaches, ...cannons]) {
    toN(a.p);
    for (const key of ['killPoint', 'target']) { const v = vec(a.extras[key]); if (v) a.extras[key] = toN(w(v)).toArray(); }
  }
  lanePts.forEach(toN);
  const pcN = toN(pc.clone()), prN = pr / U;
  if (moon) { toN(moon.center); moon.radius /= U; }
  toN(sunPos);
  if (zone) zone = new THREE.Box3(toN(zone.min.clone()), toN(zone.max.clone()));
  for (const b of keepOut) { toN(b.min); toN(b.max); }
  const planetN = { ...planet, center: pcN, radius: prN };
  own.overlayRadius /= U;
  // ---- compression: a far-away planet is pulled in (depth precision); a room's own planet mesh stays exactly where it is
  const nearPlanet = Math.max(50, pcN.distanceTo(center) - prN);
  let reachA = pcN.distanceTo(center) + prN;
  for (const s of ships) reachA = Math.max(reachA, s.p.distanceTo(center) + 300);
  if (moon) reachA = Math.max(reachA, moon.center.distanceTo(center) + moon.radius);
  const kc = own.planet ? 1 : THREE.MathUtils.clamp(num((cfg as Record<string, unknown>).scale, 700 / nearPlanet), 0.04, 1);
  const k = U * kc;
  const eyeR = cam0 ? cam0.position.clone() : spotC.clone().add(new THREE.Vector3(0, 1.6, 0)).addScaledVector(normal, -6);
  const eye = center.clone().add(eyeR.clone().sub(center).multiplyScalar(1 / k));

  // ---- cryo bay
  const cryoPods: CryoPod[] = cryoNodes.map((o, i) => {
    const a = anchorOf(o);
    const f = a.fwd.clone().setY(0).normalize();
    const door = nodes.get(`${o.name}_door`) ?? nodes.get(`${o.name}_DOOR`) ?? null;
    const outN = nodes.get(`${o.name}_out`) ?? nodes.get(`${o.name}_OUT`) ?? null;
    const out = outN ? anchorOf(outN).p.setY(0) : a.p.clone().setY(0).addScaledVector(f, 1.0);
    const doorBox = door ? new THREE.Box3().setFromObject(door) : null;
    const dx = (door?.userData ?? {}) as Record<string, unknown>;
    const win = nodes.get(`${o.name}_window`) ?? nodes.get(`${o.name}_WINDOW`) ?? null;
    return { index: i, name: o.name, node: o, p: a.p.clone(), yaw: flatYaw(f), fwd: f, door, doorMode: String(dx.open ?? (typeof dx.openAngle === 'number' ? 'swing' : 'slide_up')), doorAngle: num(dx.openAngle, 105), out, outYaw: outN ? flatYaw(anchorOf(outN).fwd.setY(0).normalize()) : flatYaw(f), doorBox: doorBox && !doorBox.isEmpty() ? doorBox : null, window: win };
  });
  const joinPath = sorted(/^JOIN_PATH_\d+$/).map((o) => anchorOf(o).p.setY(0));
  const leavePath = sorted(/^LEAVE_PATH_\d+$/).map((o) => anchorOf(o).p.setY(0));
  const dropPods: DropPod[] = dropNodes.map((o, i) => {
    const a = anchorOf(o);
    const f = a.fwd.clone().setY(0).normalize();
    const hatch = nodes.get(`${o.name}_hatch`) ?? nodes.get(`${o.name}_HATCH`) ?? null;
    const bn = nodes.get(`${o.name}_board`) ?? nodes.get(`${o.name}_BOARD`) ?? null;
    // the pod's facing: towards its board point when one is authored
    let fwd = f;
    const board = bn ? anchorOf(bn).p.setY(0) : a.p.clone().setY(0).addScaledVector(f, 0.95);
    if (bn) { const d = board.clone().sub(a.p.clone().setY(0)); if (d.lengthSq() > 0.01) fwd = d.normalize(); }
    const idx = /(\d+)$/.exec(o.name)?.[1] ?? String(i + 1);
    const tube = nodes.get(`LAUNCH_TUBE_${idx}`) ?? sorted(/^LAUNCH_TUBE_\d+$/)[i] ?? null;
    let tubeStart = a.p.clone(), tubeEnd = a.p.clone().add(new THREE.Vector3(0, -30, 0));
    let exitDir: V3 | null = null, target: V3 | null = null;
    if (tube) {
      const ta = anchorOf(tube);
      tubeStart = vec(ta.extras.start) ? w(vec(ta.extras.start)!) : ta.p.clone();
      if (vec(ta.extras.exitDir)) exitDir = new THREE.Vector3(...vec(ta.extras.exitDir)!).normalize();
      if (vec(ta.extras.target)) target = w(vec(ta.extras.target)!).sub(pc).normalize();
      const endN = nodes.get(`${tube.name}_end`) ?? nodes.get(`${tube.name}_END`);
      const ev = vec(ta.extras.end);
      if (endN) tubeEnd = anchorOf(endN).p;
      else if (ev) tubeEnd = w(ev);
      else if (vec(ta.extras.direction)) tubeEnd = tubeStart.clone().addScaledVector(new THREE.Vector3(...vec(ta.extras.direction)!).normalize(), num(ta.extras.length, 30));
      else tubeEnd = tubeStart.clone().addScaledVector(ta.fwd, num(ta.extras.length, 30));
    }
    const hx = (hatch?.userData ?? {}) as Record<string, unknown>;
    return { index: i, name: o.name, node: o, p: a.p.clone(), yaw: flatYaw(fwd), fwd, hatch, hatchMode: String(hx.open ?? (typeof hx.openAngle === 'number' ? 'swing' : 'slide_up')), hatchAngle: num(hx.openAngle, -105), board, boardYaw: flatYaw(fwd.clone().negate()), tubeStart, tubeEnd, exitDir, target };
  });
  const cam = (...names: string[]) => { for (const n of names) { const c = room.cameras.get(n); if (c) return c; } return null; };
  return {
    view: { center, normal, right, up, width, height }, k, eye, cam0,
    acts: spaceActsOf(cfg), cannonsOnly: cfg.fireFrom === 'cannons' && cannons.length > 0, podSize: THREE.MathUtils.clamp(num(cfg.podSize, 1), 0.25, 8),
    planet: planetN, moon, sun: { dir: sunDir, pos: sunPos, color: sunColor }, ships, cannons, sites, keepOut, own, unit: U,
    lanes: { pts: lanePts, adj }, warps, approaches, zone, reach: reachA, sky: cfg.sky !== false && !own.sky,
    cryoPods, joinPath, dropPods, leavePath,
    cams: { cryo: cam('CAM_CRYO', 'CAM_CRYOBAY', 'CAM_CRYO_BAY'), dropbay: cam('CAM_DROPBAY', 'CAM_DROP_BAY', 'CAM_DROPPOD'), viewport: cam(cfg.viewCamera ?? 'CAM_VIEWPORT', 'CAM_VIEWPORT', 'CAM_VIEW', 'CAM_WINDOW', 'CAM_SPACE') },
    hasSpace,
    entrance: legacyStyle(X.entrance, cryoNodes.length ? 'cryo' : null, 'cryo'),
    exit: legacyStyle(X.exit, dropNodes.length ? 'droppod' : null, 'droppod'),
    entranceBy: parseRoleStyles(X.entrance, cryoNodes.length ? 'cryo' : null),
    exitBy: parseRoleStyles(X.exit, dropNodes.length ? 'droppod' : null),
  };
}

/** authored → render (the compression about the viewport centre). */
export function toRender(r: SpaceRoom, p: V3, out = new THREE.Vector3()) { return out.copy(p).sub(r.view.center).multiplyScalar(r.k).add(r.view.center); }
export function toAuthored(r: SpaceRoom, p: V3, out = new THREE.Vector3()) { return out.copy(p).sub(r.view.center).multiplyScalar(1 / r.k).add(r.view.center); }

const cache = new WeakMap<RoomInfo, SpaceRoom | null>();
/** Parsed once per loaded room (shared by the space scene and the cryo / drop-pod mover). */
export function spaceRoomOf(room: RoomInfo, info: SceneInfo | null): SpaceRoom | null {
  if (cache.has(room)) return cache.get(room)!;
  let r: SpaceRoom | null = null;
  try { r = parseSpaceRoom(room, info); } catch (e) { console.warn('space room parse failed', e); }
  cache.set(room, r);
  return r;
}
