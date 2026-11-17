// Kitchen: the room's KITCHEN_* anchors as plain data (room-root space) + the crew's nav graph.
// Contract (docs/SCENES.md → "Kitchen"):
//   KITCHEN_STATION_xx   empty: where a crew frog works (origin = feet, y = the stool top), +Z faces the work surface.
//                        extras kind = grill | assemble | fries | bag | drinks, nav = the KITCHEN_NAV_xx it steps off to.
//   KITCHEN_NAV_xx       empty: nav node (floor); extras links = comma-separated neighbour names (made symmetric).
//   KITCHEN_MANAGER_ENTER / KITCHEN_MANAGER_YELL   the manager's spawn (behind KITCHEN_DOOR_OFFICE) + his yelling spot.
//   KITCHEN_BRUTE_ENTER / KITCHEN_BRUTE_ROAR       the freezer guy's spawn (behind KITCHEN_DOOR_FREEZER) + hero spot.
//   KITCHEN_DOOR_OFFICE / KITCHEN_DOOR_FREEZER     door leaves; origin = hinge; extras openAngle (deg), openSign (±1).
//   KITCHEN_SPLAT_xx     empty: a surface point food can splat on; +Z = the surface normal; extras surface.
//   KITCHEN_TRASH        the trash can (tips over in riots; origin = floor pivot).
//   KITCHEN_SOFTSERVE    the soft-serve nozzle (erupts in riots).
//   KITCHEN_METER / KITCHEN_INCIDENT   planes the engine draws the unrest meter / incident counter on.
//   KITCHEN_ZONE         empty; extras size [x, y, z] (full extents): where the crew may be launched to.
//   LIGHT_ALARM_xx       riot beacons (EMIT_alarm).
import * as THREE from 'three';

export interface KStation { name: string; pos: THREE.Vector3; yaw: number; kind: string; nav: number }
export interface KSplat { pos: THREE.Vector3; normal: THREE.Vector3; surface: string }
export interface KDoor { node: THREE.Object3D; baseRot: THREE.Euler; angle: number; sign: number }

export interface KitchenRoom {
  stations: KStation[];
  nav: THREE.Vector3[];
  navNames: string[];
  links: number[][];
  splats: KSplat[];
  mgrEnter: THREE.Vector3 | null;
  mgrYell: { pos: THREE.Vector3; yaw: number } | null;
  bruteEnter: THREE.Vector3 | null;
  bruteRoar: { pos: THREE.Vector3; yaw: number } | null;
  doorOffice: KDoor | null;
  doorFreezer: KDoor | null;
  mgrNav: number;
  bruteNav: number;
  trash: THREE.Object3D | null;
  trashBase: { pos: THREE.Vector3; rot: THREE.Euler } | null;
  softserve: THREE.Vector3 | null;
  meter: THREE.Mesh | null;
  incident: THREE.Mesh | null;
  zone: THREE.Box3;
  alarms: THREE.Object3D[];
  ok: boolean;
}

const ex = (o: THREE.Object3D) => (o.userData ?? {}) as Record<string, unknown>;

export function kitchenRoomOf(root: THREE.Object3D, space: THREE.Object3D): KitchenRoom | null {
  const inv = new THREE.Matrix4().copy(space.matrixWorld).invert();
  const P = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
  const q = new THREE.Quaternion(), sq = space.getWorldQuaternion(new THREE.Quaternion()).invert();
  const fwd = (o: THREE.Object3D) => new THREE.Vector3(0, 0, 1).applyQuaternion(sq.clone().multiply(o.getWorldQuaternion(q)));
  const yawOf = (o: THREE.Object3D) => { const f = fwd(o); return Math.atan2(f.x, f.z); };
  const nodes = new Map<string, THREE.Object3D>();
  root.updateMatrixWorld(true);
  root.traverse((o) => { if (/^KITCHEN_|^LIGHT_ALARM_/.test(o.name) && !nodes.has(o.name)) nodes.set(o.name, o); });
  if (![...nodes.keys()].some((n) => n.startsWith('KITCHEN_STATION_'))) return null;
  const sorted = (pre: string) => [...nodes.entries()].filter(([n]) => n.startsWith(pre)).sort(([a], [b]) => a.localeCompare(b));
  // nav graph
  const navE = sorted('KITCHEN_NAV_');
  const navNames = navE.map(([n]) => n);
  const nav = navE.map(([, o]) => P(o));
  const links: number[][] = nav.map(() => []);
  navE.forEach(([, o], i) => {
    const l = ex(o).links;
    if (typeof l !== 'string') return;
    for (const nm of l.split(',').map((s) => s.trim())) {
      const j = navNames.indexOf(nm);
      if (j >= 0 && j !== i) { if (!links[i].includes(j)) links[i].push(j); if (!links[j].includes(i)) links[j].push(i); }
    }
  });
  const nearestNav = (p: THREE.Vector3) => { let b = 0, d = Infinity; nav.forEach((n, i) => { const dd = n.distanceToSquared(p); if (dd < d) { d = dd; b = i; } }); return b; };
  const stations: KStation[] = sorted('KITCHEN_STATION_').map(([name, o]) => {
    const e = ex(o);
    const pos = P(o);
    const ni = typeof e.nav === 'string' ? navNames.indexOf(e.nav) : -1;
    return { name, pos, yaw: yawOf(o), kind: typeof e.kind === 'string' ? e.kind : 'assemble', nav: ni >= 0 ? ni : nearestNav(pos) };
  });
  const splats: KSplat[] = sorted('KITCHEN_SPLAT_').map(([, o]) => ({ pos: P(o), normal: fwd(o).normalize(), surface: typeof ex(o).surface === 'string' ? (ex(o).surface as string) : 'wall' }));
  const door = (n: string): KDoor | null => {
    const o = nodes.get(n);
    if (!o) return null;
    const e = ex(o);
    return { node: o, baseRot: o.rotation.clone(), angle: THREE.MathUtils.degToRad(typeof e.openAngle === 'number' ? e.openAngle : 100), sign: typeof e.openSign === 'number' && e.openSign < 0 ? -1 : 1 };
  };
  const pt = (n: string) => { const o = nodes.get(n); return o ? P(o) : null; };
  const spot = (n: string) => { const o = nodes.get(n); return o ? { pos: P(o), yaw: yawOf(o) } : null; };
  const navOf = (n: string, fallback: THREE.Vector3 | null) => {
    const o = nodes.get(n); const e = o ? ex(o) : {};
    const i = typeof e.nav === 'string' ? navNames.indexOf(e.nav) : -1;
    return i >= 0 ? i : fallback ? nearestNav(fallback) : 0;
  };
  const zoneO = nodes.get('KITCHEN_ZONE');
  const zone = new THREE.Box3();
  if (zoneO) {
    const c = P(zoneO); const s = ex(zoneO).size;
    const sz = Array.isArray(s) && s.length === 3 ? new THREE.Vector3(+s[0], +s[1], +s[2]) : new THREE.Vector3(14, 4, 6);
    zone.setFromCenterAndSize(c.clone().setY(c.y + sz.y / 2), sz);
  } else {
    for (const n of nav) zone.expandByPoint(n);
    zone.expandByScalar(0.5);
  }
  const trash = nodes.get('KITCHEN_TRASH') ?? null;
  const meshOf = (n: string) => { let m: THREE.Mesh | null = null; nodes.get(n)?.traverse((c) => { if (!m && (c as THREE.Mesh).isMesh) m = c as THREE.Mesh; }); return m; };
  const mgrEnter = pt('KITCHEN_MANAGER_ENTER'), bruteEnter = pt('KITCHEN_BRUTE_ENTER');
  const out: KitchenRoom = {
    stations, nav, navNames, links, splats,
    mgrEnter, mgrYell: spot('KITCHEN_MANAGER_YELL'), bruteEnter, bruteRoar: spot('KITCHEN_BRUTE_ROAR'),
    doorOffice: door('KITCHEN_DOOR_OFFICE'), doorFreezer: door('KITCHEN_DOOR_FREEZER'),
    mgrNav: navOf('KITCHEN_MANAGER_ENTER', mgrEnter), bruteNav: navOf('KITCHEN_BRUTE_ENTER', bruteEnter),
    trash, trashBase: trash ? { pos: trash.position.clone(), rot: trash.rotation.clone() } : null,
    softserve: pt('KITCHEN_SOFTSERVE'),
    meter: meshOf('KITCHEN_METER'), incident: meshOf('KITCHEN_INCIDENT'),
    zone, alarms: sorted('LIGHT_ALARM_').map(([, o]) => o),
    ok: stations.length > 0 && nav.length > 1,
  };
  return out;
}

/** Shortest nav path (Dijkstra, ≤ 64 nodes: plain arrays) from node a to node b, as node indices. */
export function navPath(room: KitchenRoom, a: number, b: number): number[] {
  const n = room.nav.length;
  if (a === b) return [a];
  const dist = new Array<number>(n).fill(Infinity), prev = new Array<number>(n).fill(-1), done = new Array<boolean>(n).fill(false);
  dist[a] = 0;
  for (;;) {
    let u = -1, best = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
    if (u < 0 || u === b) break;
    done[u] = true;
    for (const v of room.links[u]) {
      const d = best + room.nav[u].distanceTo(room.nav[v]);
      if (d < dist[v]) { dist[v] = d; prev[v] = u; }
    }
  }
  if (!Number.isFinite(dist[b])) return [a, b];
  const out: number[] = [];
  for (let u = b; u >= 0; u = prev[u]) out.unshift(u);
  return out;
}

export function nearestNav(room: KitchenRoom, p: THREE.Vector3, filter?: (i: number) => boolean): number {
  let b = 0, d = Infinity;
  room.nav.forEach((n, i) => { if (filter && !filter(i)) return; const dx = n.x - p.x, dz = n.z - p.z; const dd = dx * dx + dz * dz; if (dd < d) { d = dd; b = i; } });
  return b;
}
