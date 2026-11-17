// The TTRPG room contract (docs/TTRPG.md): finds TABLE, MAP_SURFACE, DICE_TRAY, DICE_SPAWN, GM_SEAT, GM_PROP,
// GM_SCREEN, HANDOUT, MINI_SHELF, LIGHT_MOOD_* and the CAM_TABLE_* / CAM_GM / CAM_DICE / CAM_SEAT_xx cameras in a room,
// derives what's missing (a tray beside the host, a GM prop spot above the table edge) and lists contract problems
// (vtpOut.ttrpg.debug()). Surfaces are planes drawn through their own UVs (glTF convention: image top = v 0).
import * as THREE from 'three';
import type { RoomInfo, CameraPreset } from '../../scene/contract.ts';

export interface Surface {
  mesh: THREE.Mesh;
  /** Authored material (restored when the engine isn't drawing). */
  original: THREE.Material | THREE.Material[];
  /** UV (0..1 over the whole mesh after remapping) → world. */
  at(u: number, v: number, out?: THREE.Vector3): THREE.Vector3;
  normal: THREE.Vector3;
  /** World size along U and V (m). */
  width: number;
  height: number;
  /** Unit world directions of +U / +V. */
  du: THREE.Vector3;
  dv: THREE.Vector3;
  extras: Record<string, unknown>;
  /** The part of the mesh the map uses (UV rect), when the dice tray sits on part of it (avoidTray); the canvas still
   *  covers the whole mesh (`full` = its world size). */
  sub?: { u0: number; u1: number; v0: number; v1: number };
  full?: { width: number; height: number };
}
export interface Frame { position: THREE.Vector3; quaternion: THREE.Quaternion; forward: THREE.Vector3; extras: Record<string, unknown>; node: THREE.Object3D | null }
export interface Tray extends Frame { w: number; d: number; rim: number; die: number; spawn: Frame | null }
export interface TtrpgAnchors {
  table: Frame | null;
  map: Surface | null;
  handout: Surface | null;
  tray: Tray | null;
  gmSeat: Frame | null;
  gmProp: Frame;
  gmScreen: THREE.Object3D | null;
  shelf: Frame | null;
  moodLights: { node: THREE.Object3D; mood: string | null }[];
  cams: { top: CameraPreset | null; wide: CameraPreset | null; gm: CameraPreset | null; dice: CameraPreset | null; handout: CameraPreset | null; seats: Map<number, CameraPreset> };
  problems: string[];
  /** Height of the table top (world y). */
  tableY: number;
}

const X = (o: THREE.Object3D | null | undefined) => ((o?.userData ?? {}) as Record<string, unknown>);
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && Number.isFinite(+v) && v.trim() ? +v : d);

function frameOf(o: THREE.Object3D): Frame {
  o.updateWorldMatrix(true, false);
  const position = o.getWorldPosition(new THREE.Vector3());
  const quaternion = o.getWorldQuaternion(new THREE.Quaternion());
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion); f.y = 0;
  if (f.lengthSq() < 1e-6) f.set(0, 0, 1);
  f.normalize();
  return { position, quaternion: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), f), forward: f, extras: X(o), node: o };
}

function meshOf(o: THREE.Object3D): THREE.Mesh | null {
  if ((o as THREE.Mesh).isMesh) return o as THREE.Mesh;
  let m: THREE.Mesh | null = null;
  o.traverse((c) => { if (!m && (c as THREE.Mesh).isMesh) m = c as THREE.Mesh; });
  return m;
}

/** A plane mesh → a drawable surface: UVs remapped to 0..1 over the mesh, the UV → world mapping solved from a triangle. */
export function surfaceOf(o: THREE.Object3D, extras = X(o)): Surface | null {
  const mesh = meshOf(o);
  if (!mesh) return null;
  mesh.updateWorldMatrix(true, false);
  const geo = mesh.geometry.clone();
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  if (!uv || !pos) return null;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let i = 0; i < uv.count; i++) { u0 = Math.min(u0, uv.getX(i)); u1 = Math.max(u1, uv.getX(i)); v0 = Math.min(v0, uv.getY(i)); v1 = Math.max(v1, uv.getY(i)); }
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) - u0) / Math.max(1e-6, u1 - u0), (uv.getY(i) - v0) / Math.max(1e-6, v1 - v0));
  uv.needsUpdate = true;
  mesh.geometry = geo;
  // solve P(u, v) = A + u·Du + v·Dv from the triangle with the biggest UV area
  const idx = geo.index;
  const tri = (k: number) => (idx ? [idx.getX(k * 3), idx.getX(k * 3 + 1), idx.getX(k * 3 + 2)] : [k * 3, k * 3 + 1, k * 3 + 2]);
  const nTri = (idx ? idx.count : pos.count) / 3;
  let best: number[] | null = null, bestA = 0;
  for (let k = 0; k < nTri; k++) {
    const [a, b, c] = tri(k);
    const area = Math.abs((uv.getX(b) - uv.getX(a)) * (uv.getY(c) - uv.getY(a)) - (uv.getX(c) - uv.getX(a)) * (uv.getY(b) - uv.getY(a)));
    if (area > bestA) { bestA = area; best = [a, b, c]; }
  }
  if (!best || bestA < 1e-6) return null;
  const W = mesh.matrixWorld;
  const P = best.map((i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(W));
  const T = best.map((i) => [uv.getX(i), uv.getY(i)]);
  const e1 = P[1].clone().sub(P[0]), e2 = P[2].clone().sub(P[0]);
  const a1 = T[1][0] - T[0][0], b1 = T[1][1] - T[0][1], a2 = T[2][0] - T[0][0], b2 = T[2][1] - T[0][1];
  const det = a1 * b2 - a2 * b1;
  const Du = e1.clone().multiplyScalar(b2).sub(e2.clone().multiplyScalar(b1)).multiplyScalar(1 / det);
  const Dv = e2.clone().multiplyScalar(a1).sub(e1.clone().multiplyScalar(a2)).multiplyScalar(1 / det);
  const A = P[0].clone().sub(Du.clone().multiplyScalar(T[0][0])).sub(Dv.clone().multiplyScalar(T[0][1]));
  const normal = new THREE.Vector3().crossVectors(Du, Dv).normalize();
  // the plane's front: the side its mesh normal points to
  const nAttr = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (nAttr) { const mn = new THREE.Vector3().fromBufferAttribute(nAttr, best[0]).transformDirection(W); if (mn.dot(normal) < 0) normal.negate(); }
  return {
    mesh, original: mesh.material, normal, width: Du.length(), height: Dv.length(), du: Du.clone().normalize(), dv: Dv.clone().normalize(), extras,
    at: (u, v, out = new THREE.Vector3()) => out.copy(A).addScaledVector(Du, u).addScaledVector(Dv, v),
  };
}

export function findAnchors(room: RoomInfo): TtrpgAnchors {
  const root = room.root;
  const byName = new Map<string, THREE.Object3D>();
  root.traverse((o) => { if (o.name && !byName.has(o.name)) byName.set(o.name, o); });
  const get = (n: string) => byName.get(n) ?? null;
  const problems: string[] = [];
  const cams = room.cameras;
  const seats = new Map<number, CameraPreset>();
  for (let i = 1; i <= 12; i++) { const c = cams.get(`CAM_SEAT_${String(i).padStart(2, '0')}`); if (c) seats.set(i - 1, c); }
  const tableN = get('TABLE');
  let table = tableN ? frameOf(tableN) : null;
  const mapN = get('MAP_SURFACE');
  const map = mapN ? surfaceOf(mapN) : null;
  if (!mapN) problems.push('no MAP_SURFACE: the battle map has nowhere to go');
  else if (!map) problems.push('MAP_SURFACE is not a UV-mapped plane mesh');
  else if (map.normal.y < 0.8) problems.push(`MAP_SURFACE should face up (normal y = ${map.normal.y.toFixed(2)})`);
  if (!table && map) table = { position: map.at(0.5, 0.5), quaternion: new THREE.Quaternion(), forward: new THREE.Vector3(0, 0, 1), extras: {}, node: null };
  if (!table) {
    const sp = room.spots.filter((s) => !!s);
    if (sp.length) { const c = sp.reduce((a, s) => a.add(s!.position), new THREE.Vector3()).multiplyScalar(1 / sp.length); table = { position: c.setY(0.76), quaternion: new THREE.Quaternion(), forward: new THREE.Vector3(0, 0, 1), extras: {}, node: null }; }
    problems.push('no TABLE anchor');
  }
  const tableY = map ? map.at(0.5, 0.5).y : table?.position.y ?? 0.76;
  const handN = get('HANDOUT');
  const handout = handN ? surfaceOf(handN) : null;
  if (handN && !handout) problems.push('HANDOUT is not a UV-mapped plane mesh');
  // GM seat: the GM_SEAT empty (also spot 12 in the room engine)
  const gmN = get('GM_SEAT');
  const gmSeat = gmN ? frameOf(gmN) : room.spots[11] ? { position: room.spots[11]!.position.clone(), quaternion: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), room.spots[11]!.forward), forward: room.spots[11]!.forward.clone(), extras: room.spots[11]!.extras, node: room.spots[11]!.node } : null;
  if (!gmSeat) problems.push('no GM_SEAT');
  // GM prop spot: GM_PROP, else above the table edge in front of the GM seat
  const propN = get('GM_PROP');
  let gmProp: Frame;
  if (propN) gmProp = frameOf(propN);
  else {
    const c = table?.position ?? new THREE.Vector3(0, tableY, 0);
    const from = gmSeat?.position ?? c.clone().add(new THREE.Vector3(0, 0, -1));
    const dir = c.clone().sub(from).setY(0);
    const len = dir.length() || 1;
    dir.normalize();
    const edge = from.clone().addScaledVector(dir, Math.min(len * 0.55, 0.6)).setY(tableY + 0.3);
    gmProp = { position: edge, quaternion: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir), forward: dir, extras: {}, node: null };
  }
  // dice tray
  const trayN = get('DICE_TRAY');
  let tray: Tray | null = null;
  if (trayN) {
    const f = frameOf(trayN), x = f.extras;
    const w = num(x.w, 0.32), d = num(x.d, 0.24);
    const fy = num(x.floorY, NaN);
    if (Number.isFinite(fy)) f.position.y = fy;
    const q = trayN.getWorldQuaternion(new THREE.Quaternion());
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    if (up.y < 0.9) problems.push('DICE_TRAY should be level (+Y up)');
    if (w < 0.2 || d < 0.15) problems.push(`DICE_TRAY is small (${w.toFixed(2)} × ${d.toFixed(2)} m): ≥ 0.30 × 0.22 reads well`);
    tray = { ...f, w, d, rim: num(x.rim ?? x.wall, 0.05), die: Math.min(0.06, Math.max(0.02, num(x.die, Math.min(w, d) * 0.14))), spawn: get('DICE_SPAWN') ? frameOf(get('DICE_SPAWN')!) : null };
  } else if (table) {
    const host = room.spots[0]?.position ?? table.position.clone().add(new THREE.Vector3(0, 0, 1));
    const p = table.position.clone().lerp(host, 0.5).setY(tableY + 0.002);
    const f = host.clone().sub(table.position).setY(0).normalize();
    // throw across the table, sideways to the host
    const side = new THREE.Vector3(f.z, 0, -f.x);
    tray = { position: p, quaternion: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), side.lengthSq() > 0 ? side : new THREE.Vector3(0, 0, 1)), forward: side, extras: {}, node: null, w: 0.32, d: 0.24, rim: 0.05, die: 0.034, spawn: null };
    problems.push('no DICE_TRAY: dice land beside the host seat');
  }
  // a dice tray standing on the map: the map (grid, minis) moves over to the part of the surface the tray leaves free
  let mapOut = map;
  if (map && tray) {
    const cut = avoidTray(map, tray);
    if (cut) { mapOut = cut; problems.push(`DICE_TRAY stands on MAP_SURFACE: the map uses ${Math.round((cut.sub!.u1 - cut.sub!.u0) * (cut.sub!.v1 - cut.sub!.v0) * 100)}% of it (aspect ${(cut.width / cut.height).toFixed(3)} — set scene.json ttrpg.map.aspect to that)`); }
  }
  const moodLights: TtrpgAnchors['moodLights'] = [];
  for (const fx of room.fixtures) if (/^LIGHT_MOOD/.test(fx.name) || /^mood/i.test(fx.group)) moodLights.push({ node: fx.node, mood: typeof fx.extras.mood === 'string' ? fx.extras.mood : null });
  const cam = (n: string, alt?: string) => cams.get(n) ?? (alt ? cams.get(alt) : undefined) ?? null;
  const out: TtrpgAnchors = {
    table, map: mapOut, handout, tray, gmSeat, gmProp, gmScreen: get('GM_SCREEN'), shelf: get('MINI_SHELF') ? frameOf(get('MINI_SHELF')!) : null, moodLights, tableY,
    cams: { top: cam('CAM_TABLE_TOP'), wide: cam('CAM_TABLE_WIDE', 'CAM_WIDE'), gm: cam('CAM_GM'), dice: cam('CAM_DICE'), handout: cam('CAM_HANDOUT'), seats },
    problems,
  };
  if (!out.cams.top) problems.push('no CAM_TABLE_TOP (the map shot is derived)');
  if (!out.cams.dice) problems.push('no CAM_DICE (the dice shot is derived)');
  if (!out.cams.gm) problems.push('no CAM_GM (the GM shot is derived)');
  return out;
}

/** The biggest part of the map surface (cut along one side) that the dice tray (+ its walls, 1 cm) doesn't stand on, or
 *  null when the tray is off the map (or only grazes its edge by < 4 cm). Deterministic (geometry only), so every page
 *  draws the same map. */
export function avoidTray(m: Surface, t: Tray): Surface | null {
  const o = m.at(0, 0);
  const right = new THREE.Vector3().crossVectors(t.forward, new THREE.Vector3(0, 1, 0)).normalize();
  const wall = Math.min(t.rim, 0.06) * 0.5 + 0.01, hw = t.w / 2 + wall, hd = t.d / 2 + wall;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const p = t.position.clone().addScaledVector(right, x * hw).addScaledVector(t.forward, z * hd).sub(o);
    const u = p.dot(m.du) / m.width, v = p.dot(m.dv) / m.height;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const ou = (Math.min(u1, 1) - Math.max(u0, 0)) * m.width, ov = (Math.min(v1, 1) - Math.max(v0, 0)) * m.height;
  if (ou < 0.04 || ov < 0.04) return null;                                              // off the map / just grazing its edge
  const opts = [{ u0: 0, u1: Math.max(0, u0), v0: 0, v1: 1 }, { u0: Math.min(1, u1), u1: 1, v0: 0, v1: 1 }, { u0: 0, u1: 1, v0: 0, v1: Math.max(0, v0) }, { u0: 0, u1: 1, v0: Math.min(1, v1), v1: 1 }];
  const best = opts.reduce((a, b) => ((b.u1 - b.u0) * (b.v1 - b.v0) > (a.u1 - a.u0) * (a.v1 - a.v0) ? b : a));
  if ((best.u1 - best.u0) * (best.v1 - best.v0) < 0.4) return null;                    // (the tray sits in the middle: keep the whole map)
  const Du = m.du.clone().multiplyScalar(m.width), Dv = m.dv.clone().multiplyScalar(m.height);
  return {
    ...m, sub: best, full: { width: m.width, height: m.height }, width: m.width * (best.u1 - best.u0), height: m.height * (best.v1 - best.v0),
    at: (u, v, out = new THREE.Vector3()) => out.copy(o).addScaledVector(Du, best.u0 + u * (best.u1 - best.u0)).addScaledVector(Dv, best.v0 + v * (best.v1 - best.v0)),
  };
}
