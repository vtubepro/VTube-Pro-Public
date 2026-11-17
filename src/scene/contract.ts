// Parses a scene GLB into the named contract nodes of docs/SCENES.md (SPOT_01..12, DOOR, DOOR_OUTSIDE,
// PATH_*, SCREEN, CAM_*, LIGHT_*, EMIT_* materials, COLLIDE_*). Pure data + node references; the
// SceneRuntime, movers (entrances) and the light engine all read from this one RoomInfo.
import * as THREE from 'three';
import { MAX_SPOTS } from '../../shared/scene.ts';
import { parseSizes, type SizeClass } from '../../shared/avatarSize.ts';
import type { OccupantKind } from '../../shared/occupant.ts';

export type SpotPose = 'sit' | 'stand';

export interface SpotInfo {
  /** 0-based (SPOT_01 = 0). */
  index: number;
  name: string;
  node: THREE.Object3D;
  pose: SpotPose;
  /** Seat surface above the node origin (m), sit spots. */
  seatHeight: number;
  seatDepth: number;
  label: string;
  /** World-space root position + facing (the node's +Z, flattened to the floor plane). */
  position: THREE.Vector3;
  forward: THREE.Vector3;
  /** Yaw (rad) about +Y that turns +Z onto `forward`. */
  yaw: number;
  /** SPOT_xx_CAM, when authored. */
  cam: CameraPreset | null;
  /** Entrance routing (extras): leave the PATH_* walk at this waypoint (index into RoomInfo.path, null = the
   *  nearest one), then walk these world points (extras.approach, flat x,y,z list) to the spot. Spots behind
   *  furniture need them - a straight line from the path would clip. */
  leavePathAt: number | null;
  approach: THREE.Vector3[];
  /** All glTF extras of the node, as authored. */
  extras: Record<string, unknown>;
  /** Size classes this spot takes (extras / scene.json `sizes`; null = an ordinary spot: small / normal / large, with
   *  micro and macro only as a fallback) — shared/avatarSize.ts spotFit. */
  sizes?: SizeClass[] | null;
  /** Body kinds this spot takes (GLB extras / scene.json `spotKinds`: src/scene/forms/spotKinds.ts; null / missing = any)
   *  - shared/occupant.ts spotFitOcc (a mech never gets a couch seat marked biped / quadruped / tv). */
  kinds?: OccupantKind[] | null;
  /** Size spots after SPOT_12 (src/scene/sizeSpots.ts): 'auto' = derived from the room, 'json' = scene.json sizeSpots. */
  sizeSpot?: 'auto' | 'json';
  /** Micro performers float this high above the spot (m, room units) — a hover perch where no table was found. */
  hover?: number;
  /** Free height above the spot (m) / free radius around it, when measured (giants are clamped to it). */
  clearance?: { height: number; radius: number };
}

/** A spot by its SceneState index: SPOT_01…12 (0…11), then the size spots (12…). */
export function spotByIndex(room: RoomInfo, i: number): SpotInfo | null {
  if (!Number.isInteger(i) || i < 0) return null;
  return i < MAX_SPOTS ? room.spots[i] ?? null : room.sizeSpots.find((s) => s.index === i) ?? null;
}

export interface CameraPreset {
  name: string;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** Vertical field of view (deg). */
  fov: number;
  /** A LIVE preset (glTF extras `live: true`, or a `CAM_LIVE_` name — docs/SCENES.md "Live (moving) cameras"): the
   *  SceneRuntime re-reads `position` / `quaternion` from the node's world pose every frame (refreshLivePreset), so a
   *  camera parented to a clip-animated ship, or keyed in a room clip, rides along. Absent = a snapshot (the default). */
  live?: LiveCamera;
}

export interface LiveCamera {
  /** The node whose world pose is the shot (the glTF camera, else the CAM_ node itself). */
  node: THREE.Object3D;
  /** extras.lookAt: aim at this node's world origin every frame instead of using the node's own rotation. */
  lookAt: THREE.Object3D | null;
  /** extras.lookAt as authored (resolved against the room's node names after parsing). */
  lookAtName: string | null;
}

export interface DoorInfo {
  node: THREE.Object3D;
  /** Rest (closed) local rotation. */
  rest: THREE.Quaternion;
  /** Degrees at fully open (extras.openAngle, default 95). */
  openAngle: number;
  /** 0 = closed … 1 = open (rotates about the node's local +Y). */
  setOpen(t: number): void;
}

export interface ScreenInfo {
  node: THREE.Object3D;
  /** The mesh whose surface is the passthrough hole / preview picture. */
  surface: THREE.Mesh;
  /** Shown (react) local position; the node rests `restOffsetY` above it. */
  shownPosition: THREE.Vector3;
  restOffsetY: number;
}

export type FixtureKind = 'spot' | 'point' | 'emissive';
export interface LightFixture {
  name: string;
  node: THREE.Object3D;
  group: string;
  color: THREE.Color;
  kind: FixtureKind;
  /** EMIT_* materials on this fixture's meshes. */
  materials: THREE.MeshStandardMaterial[];
  extras: Record<string, unknown>;
}

export interface EmissiveMaterial {
  material: THREE.MeshStandardMaterial;
  group: string;
  /** As authored — the light engine modulates relative to these. */
  baseColor: THREE.Color;
  baseIntensity: number;
}

export interface RoomInfo {
  root: THREE.Object3D;
  spots: (SpotInfo | null)[];
  door: DoorInfo | null;
  doorOutside: { position: THREE.Vector3; forward: THREE.Vector3 } | null;
  /** PATH_01, PATH_02 … (world positions, in order) and their node names. */
  path: THREE.Vector3[];
  pathNames: string[];
  screen: ScreenInfo | null;
  /** CAM_* presets by node name (CAM_WIDE, CAM_REACT, …). */
  cameras: Map<string, CameraPreset>;
  fixtures: LightFixture[];
  /** Every EMIT_<group> material in the room. */
  emissive: EmissiveMaterial[];
  colliders: THREE.Object3D[];
  /** Solo react screens (optional SCREEN_SOLO_xx per spot index; SCREEN_SOLO = -1, used for the nearest spot):
   *  node origin = centre of the shown surface, +Z = the side it faces, extras.width (m, default 2.4). */
  soloScreens: Map<number, { center: THREE.Vector3; yaw: number; width: number }>;
  /** World bounds of the rendered room geometry. */
  bounds: THREE.Box3;
  /** Meshes the auto cameras ray-test against (walls etc.). */
  occluders: THREE.Mesh[];
  /** Size-class spots after SPOT_12 (index 12…): scene.json sizeSpots + automatic table perches / back-row giant spots
   *  (src/scene/sizeSpots.ts). Filled in by the SceneRuntime; not part of `spots` (cameras, lights, nav ignore them). */
  sizeSpots: SpotInfo[];
}

const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();

function cameraOf(o: THREE.Object3D): THREE.PerspectiveCamera | null {
  let cam: THREE.PerspectiveCamera | null = null;
  o.traverse((c) => { if (!cam && (c as THREE.PerspectiveCamera).isPerspectiveCamera) cam = c as THREE.PerspectiveCamera; });
  return cam;
}

function preset(name: string, o: THREE.Object3D): CameraPreset | null {
  const cam = cameraOf(o);
  const src = cam ?? o;
  src.updateWorldMatrix(true, false);
  const position = src.getWorldPosition(new THREE.Vector3());
  const quaternion = src.getWorldQuaternion(new THREE.Quaternion());
  const p: CameraPreset = { name, position, quaternion, fov: cam?.fov ?? 35 };
  // live presets: extras on the CAM_ node or on its glTF camera (Blender custom properties), or the CAM_LIVE_ prefix
  const x = { ...(cam?.userData ?? {}), ...(o.userData ?? {}) } as Record<string, unknown>;
  const flag = x.live === true || x.live === 1 || x.live === 'true' || x.live === '1';
  if (flag || /^CAM_LIVE_/.test(name)) {
    const lookAtName = typeof x.lookAt === 'string' && x.lookAt.trim() ? x.lookAt.trim().slice(0, 96) : null;
    p.live = { node: src, lookAt: null, lookAtName };
  }
  return p;
}

const liveS = new THREE.Vector3(), liveP = new THREE.Vector3(), liveQ = new THREE.Quaternion(), liveT = new THREE.Vector3();
const liveUp = new THREE.Vector3(0, 1, 0), liveM = new THREE.Matrix4();
/** A live preset: re-read the node's CURRENT world pose into `p.position` / `p.quaternion` (in place, so every holder
 *  of the preset sees it). No-op for snapshot presets. A node scaled to nothing (a ship's pop-out scale key) or a
 *  broken matrix keeps the last good pose. */
export function refreshLivePreset(p: CameraPreset): void {
  const L = p.live;
  if (!L) return;
  L.node.updateWorldMatrix(true, false);
  const e = L.node.matrixWorld.elements;
  if (!e.every(Number.isFinite) || Math.abs(L.node.matrixWorld.determinant()) < 1e-12) return;
  L.node.matrixWorld.decompose(liveP, liveQ, liveS);
  if (L.lookAt) {
    L.lookAt.updateWorldMatrix(true, false);
    L.lookAt.getWorldPosition(liveT);
    // (a camera looks down its -Z: Matrix4.lookAt(eye, target) builds exactly that; world up keeps the horizon level)
    if (liveT.distanceToSquared(liveP) > 1e-8) liveQ.setFromRotationMatrix(liveM.lookAt(liveP, liveT, liveUp));
  }
  if (![liveP.x, liveP.y, liveP.z, liveQ.x, liveQ.y, liveQ.z, liveQ.w].every(Number.isFinite)) return;
  p.position.copy(liveP);
  p.quaternion.copy(liveQ);
}

/** Every live preset of a room: CAM_* presets + authored talk cameras (SPOT_xx_CAM / CAM_SEAT_xx). */
export function livePresets(room: RoomInfo): CameraPreset[] {
  const out: CameraPreset[] = [];
  for (const c of room.cameras.values()) if (c.live) out.push(c);
  for (const s of room.spots) if (s?.cam?.live && !out.includes(s.cam)) out.push(s.cam);
  return out;
}

/** Flattened facing of a node's +Z (world), and the yaw for it. */
function facing(o: THREE.Object3D) {
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(o.getWorldQuaternion(tmpQ));
  f.y = 0;
  if (f.lengthSq() < 1e-6) f.set(0, 0, 1);
  f.normalize();
  return { forward: f, yaw: Math.atan2(f.x, f.z) };
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(+v) ? +v : d);

/** A walk-data floor (src/scene/floors.ts): a FLOOR_* node whose meshes all use the M_Hidden material (or extras.walk).
 *  Plain floors named FLOOR (and GLTFLoader's FLOOR_1… split children) or decorative FLOOR_* meshes stay visible. */
export function isWalkFloor(o: THREE.Object3D): boolean {
  if (!/^FLOOR_/.test(o.name) || /^FLOOR_\d+$/.test(o.name)) return false;
  if ((o.userData as { walk?: unknown }).walk === true) return true;
  let meshes = 0, hidden = 0;
  o.traverse((c) => {
    const m = c as THREE.Mesh; if (!m.isMesh) return;
    for (const mt of (Array.isArray(m.material) ? m.material : [m.material])) { meshes++; if (/^M_Hidden/.test(mt?.name ?? '')) hidden++; }
  });
  return meshes > 0 && hidden === meshes;
}

export function parseRoom(root: THREE.Object3D): RoomInfo {
  root.updateWorldMatrix(true, true);
  const spots: (SpotInfo | null)[] = Array.from({ length: MAX_SPOTS }, () => null);
  const cameras = new Map<string, CameraPreset>();
  const spotCams = new Map<number, CameraPreset>();
  const path: [number, THREE.Vector3, string][] = [];
  const fixtures: LightFixture[] = [];
  const colliders: THREE.Object3D[] = [];
  const soloScreens = new Map<number, { center: THREE.Vector3; yaw: number; width: number }>();
  const emissive: EmissiveMaterial[] = [];
  const seenMat = new Set<THREE.Material>();
  let door: DoorInfo | null = null;
  let doorOutside: RoomInfo['doorOutside'] = null;
  let screen: ScreenInfo | null = null;

  const nodes: THREE.Object3D[] = [];
  root.traverse((o) => nodes.push(o));
  for (const o of nodes) {
    const n = o.name;
    const x = (o.userData ?? {}) as Record<string, unknown>;
    if (x.hiddenUntilBroken === true) o.visible = false;   // pre-fractured smash pieces (src/scene/raid) show only once broken
    let m: RegExpExecArray | null;
    if ((m = /^SPOT_(\d{1,2})_CAM/.exec(n))) {
      const i = +m[1] - 1;
      const p = preset(n, o);
      if (p && i >= 0 && i < MAX_SPOTS) spotCams.set(i, p);
    } else if ((m = /^SPOT_(\d{1,2})$/.exec(n))) {
      const i = +m[1] - 1;
      if (i < 0 || i >= MAX_SPOTS || spots[i]) continue;
      const f = facing(o);
      const pose: SpotPose = x.pose === 'sit' ? 'sit' : 'stand';
      spots[i] = {
        index: i, name: n, node: o, pose,
        seatHeight: pose === 'sit' ? Math.max(0.15, Math.min(1.4, num(x.seatHeight, 0.45))) : 0,
        seatDepth: num(x.seatDepth, 0.5),
        label: typeof x.label === 'string' ? x.label.slice(0, 40) : `Spot ${i + 1}`,
        position: o.getWorldPosition(new THREE.Vector3()), forward: f.forward, yaw: f.yaw, cam: null,
        leavePathAt: null, approach: approachOf(x.approach, root), extras: x, sizes: parseSizes(x.sizes),
      };
    } else if (n === 'DOOR' && !door) {
      const rest = o.quaternion.clone();
      const openAngle = num(x.openAngle, 95);
      const axis = new THREE.Vector3(0, 1, 0);
      door = {
        node: o, rest, openAngle,
        setOpen(t: number) { o.quaternion.copy(rest).multiply(tmpQ.setFromAxisAngle(axis, THREE.MathUtils.degToRad(openAngle) * THREE.MathUtils.clamp(t, 0, 1))); },
      };
    } else if (n === 'DOOR_OUTSIDE') {
      doorOutside = { position: o.getWorldPosition(new THREE.Vector3()), forward: facing(o).forward };
    } else if ((m = /^PATH_(\d+)$/.exec(n))) {
      path.push([+m[1], o.getWorldPosition(new THREE.Vector3()), n]);
    } else if ((m = /^SCREEN_SOLO(?:_(\d{1,2}))?$/.exec(n))) {
      const i = m[1] ? +m[1] - 1 : -1;
      const f = facing(o);
      soloScreens.set(i, { center: o.getWorldPosition(new THREE.Vector3()), yaw: f.yaw, width: Math.min(5, Math.max(0.8, num(x.width, 2.4))) });
      o.visible = false;
    } else if (n === 'SCREEN' && !screen) {
      const surface = findSurface(o);
      if (surface) screen = { node: o, surface, shownPosition: o.position.clone(), restOffsetY: num(x.restOffsetY, 0) };
    } else if (/^CAM_/.test(n)) {
      const p = preset(n, o);
      if (p && !cameras.has(n)) cameras.set(n, p);
    } else if (/^LIGHT_/.test(n) && !/^LIGHT_/.test(o.parent?.name ?? '')) {   // (not the _1/_2 primitive children GLTFLoader splits a multi-material mesh into)
      const kind: FixtureKind = x.kind === 'spot' || x.kind === 'point' ? x.kind : 'emissive';
      const mats: THREE.MeshStandardMaterial[] = [];
      o.traverse((c) => {
        for (const mt of materialsOf(c)) if (/^EMIT_/.test(mt.name) && (mt as THREE.MeshStandardMaterial).isMeshStandardMaterial && !mats.includes(mt as THREE.MeshStandardMaterial)) mats.push(mt as THREE.MeshStandardMaterial);
      });
      let color = new THREE.Color(1, 1, 1);
      try { if (typeof x.color === 'string') color = new THREE.Color(x.color); else if (mats[0]) color = mats[0].emissive.clone(); } catch { /* bad colour */ }
      fixtures.push({ name: n, node: o, group: typeof x.group === 'string' ? x.group.slice(0, 32) : 'default', color, kind, materials: mats, extras: x });
    } else if (/^COLLIDE_/.test(n)) {
      colliders.push(o);
    } else if (isWalkFloor(o)) {
      o.visible = false;   // walkable heights (stage, stairs, balcony — src/scene/floors.ts): data only, never drawn / ray-tested
    } else if (/_SKIN$/.test(n)) {
      o.visible = false;   // screen-rig skin templates (SOLO_SKIN, CHAT_MONITOR_SKIN …, src/scene/screenSkins.ts): cloned per rig
    } else if (/^BG_ZONE_/.test(n) || /^SMASH_.+_piece/.test(n)) {
      o.visible = false;   // background-combat data (src/scene/raid): zone boxes are bounds only; fracture pieces show once broken
    }
  }
  // EMIT_<group> materials anywhere in the room (not only under LIGHT_* nodes)
  for (const o of nodes) for (const mt of materialsOf(o)) {
    const mm = /^EMIT_(.+)$/.exec(mt.name);
    const sm = mt as THREE.MeshStandardMaterial;
    if (!mm || !sm.isMeshStandardMaterial || seenMat.has(mt)) continue;
    seenMat.add(mt);
    emissive.push({ material: sm, group: mm[1].replace(/[._]\d+$/, ''), baseColor: sm.emissive.clone(), baseIntensity: sm.emissiveIntensity });
  }
  // optional keycard-reader LEDs (e.g. Labs): DOOR_LOCKED shows while the door is shut, DOOR_UNLOCKED while it opens
  const ledLocked = nodes.find((o) => o.name === 'DOOR_LOCKED'), ledOpen = nodes.find((o) => o.name === 'DOOR_UNLOCKED');
  if (door && (ledLocked || ledOpen)) {
    const d = door as DoorInfo, rotate = d.setOpen;
    d.setOpen = (t: number) => { rotate(t); if (ledLocked) ledLocked.visible = t < 0.02; if (ledOpen) ledOpen.visible = t >= 0.02; };
    if (ledLocked) ledLocked.visible = true;
    if (ledOpen) ledOpen.visible = false;
  }
  // TTRPG rooms (docs/TTRPG.md): SEAT_01..08 are spots (sit by default), GM_SEAT is spot 12 and CAM_SEAT_xx is that seat's
  // talk camera — only where the room doesn't author the SPOT_xx / SPOT_xx_CAM itself (those win)
  for (const o of nodes) {
    const sm = /^SEAT_(\d{1,2})$/.exec(o.name), gm = o.name === 'GM_SEAT', cm = /^CAM_SEAT_(\d{1,2})$/.exec(o.name);
    if (cm) { const i = +cm[1] - 1; const p = preset(o.name, o); if (p && i >= 0 && i < MAX_SPOTS && !spotCams.has(i)) spotCams.set(i, p); continue; }
    if (!sm && !gm) continue;
    const i = gm ? MAX_SPOTS - 1 : +sm![1] - 1;
    if (i < 0 || i >= MAX_SPOTS || spots[i]) continue;
    const x = (o.userData ?? {}) as Record<string, unknown>, f = facing(o);
    const pose: SpotPose = x.pose === 'stand' || x.pose === 'float' ? 'stand' : 'sit';
    spots[i] = { index: i, name: o.name, node: o, pose, seatHeight: pose === 'sit' ? Math.max(0.15, Math.min(1.4, num(x.seatHeight, 0.45))) : 0, seatDepth: num(x.seatDepth, 0.5),
      label: typeof x.label === 'string' ? x.label.slice(0, 40) : gm ? 'GM seat' : `Seat ${i + 1}`, position: o.getWorldPosition(new THREE.Vector3()), forward: f.forward, yaw: f.yaw, cam: null,
      leavePathAt: null, approach: approachOf(x.approach, root), extras: x, sizes: parseSizes(x.sizes) };
  }
  for (const [i, c] of spotCams) if (spots[i]) spots[i]!.cam = c;
  // live presets aiming at a node (extras.lookAt): resolve the name (as authored, or as GLTFLoader sanitised it)
  const byName = new Map<string, THREE.Object3D>();
  for (const o of nodes) if (o.name && !byName.has(o.name)) byName.set(o.name, o);
  for (const c of [...cameras.values(), ...spotCams.values()]) {
    const L = c.live;
    if (!L?.lookAtName) continue;
    L.lookAt = byName.get(L.lookAtName) ?? byName.get(THREE.PropertyBinding.sanitizeNodeName(L.lookAtName)) ?? null;
    if (!L.lookAt) console.warn(`scene: ${c.name} lookAt '${L.lookAtName}' — no such node (using the camera's own rotation)`);
    else refreshLivePreset(c);
  }
  path.sort((a, b) => a[0] - b[0]);
  const pathNames = path.map((p) => p[2]);
  for (const s of spots) if (s && typeof s.extras.leavePathAt === 'string') { const i = pathNames.indexOf(s.extras.leavePathAt); s.leavePathAt = i >= 0 ? i : null; }
  // colliders are data only (never drawn)
  for (const c of colliders) c.visible = false;

  const bounds = new THREE.Box3();
  const occluders: THREE.Mesh[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !o.visible) return;
    let hidden = false;
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) hidden = true;
    if (hidden) return;
    bounds.expandByObject(mesh);
    let inScreen = false;
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === screen?.node) inScreen = true;
    if (!inScreen) occluders.push(mesh);
  });

  return {
    root, spots, door, doorOutside,
    path: path.map((p) => p[1]), pathNames,
    screen, cameras, fixtures, emissive, colliders, soloScreens, bounds, occluders, sizeSpots: [],
  };
}

/** extras.approach: flat [x,y,z, x,y,z …] in the GLB's (glTF) space → world points. */
function approachOf(v: unknown, root: THREE.Object3D): THREE.Vector3[] {
  if (!Array.isArray(v)) return [];
  const out: THREE.Vector3[] = [];
  for (let i = 0; i + 2 < v.length && out.length < 32; i += 3) {
    const [x, y, z] = [v[i], v[i + 1], v[i + 2]].map(Number);
    if ([x, y, z].every(Number.isFinite)) out.push(root.localToWorld(new THREE.Vector3(x, y, z)));
  }
  return out;
}

function materialsOf(o: THREE.Object3D): THREE.Material[] {
  const m = (o as THREE.Mesh).material;
  return !(o as THREE.Mesh).isMesh || !m ? [] : Array.isArray(m) ? m : [m];
}

/** The SCREEN surface: the node itself when it's a mesh, else a child named *SURFACE*, else the largest child mesh. */
function findSurface(o: THREE.Object3D): THREE.Mesh | null {
  if ((o as THREE.Mesh).isMesh) {
    // glTF multi-primitive meshes load as a Group of meshes; a plain Mesh node is the surface itself
    return o as THREE.Mesh;
  }
  let named: THREE.Mesh | null = null, big: THREE.Mesh | null = null, bigA = 0;
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh) return;
    if (!named && /surface/i.test(m.name)) named = m;
    m.geometry.computeBoundingBox();
    const s = m.geometry.boundingBox!.getSize(tmpV);
    const a = Math.max(s.x * s.y, s.y * s.z, s.x * s.z);
    if (a > bigA) { bigA = a; big = m; }
  });
  return named ?? big;
}
