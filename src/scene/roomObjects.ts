// The room's OWN objects in the Room editor layer (docs/ROOM_EDITOR.md, shared/roomEdits.ts hiddenObjects / movedObjects):
//   listRoomObjects(room)            the meshes / groups a user would call "objects" (a desk, the plants, a wall): named,
//                                    drawn, not an engine anchor / camera / light / collider / screen, not a tiny
//                                    sub-mesh, not a room-wide container (those are opened up instead); capped
//   applyRoomObjects(room, p, layer) hide / move them (the authored transform + visibility is snapshotted first)
//   restoreRoomObjects(room, p)      everything back exactly as authored; returns the nodes it touched (their ray rest
//                                    poses are re-taken by SceneRuntime.refreshRays)
// Objects are addressed by node name as three.js loads the room (GLTFLoader makes names unique), the same on every page.
// An LOD group (siblings <base>_LOD0 … _LODn, src/stage/gfx/lod.ts) is ONE object, named by its first level: listed
// once, picked from any level, every level snapshotted / moved by the same transform / hidden together; the LOD system
// keeps the user's hidden levels hidden (gfxLod.hold) and switches a moved group by where it is now (gfxLod.refit).
import * as THREE from 'three';
import { ENGINE_NODE, OBJECT_NAME, objectNameOk, type ObjectEdit, type RoomEdits, type V3 } from '../../shared/roomEdits.ts';
import { gfxLod } from '../stage/gfx/lod.ts';
import type { RoomInfo } from './contract.ts';

/** The authored state of a node the user's layer changed. */
export interface ObjectSnap { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3; visible: boolean; roomScale: THREE.Vector3; room: THREE.Matrix4 }
/** What roomEdits.ts's RoomPristine keeps for the objects (its `objects` field). */
export interface ObjectsPristine { snaps: Map<THREE.Object3D, ObjectSnap>; occluders: Set<THREE.Mesh> }
export const newObjectsPristine = (): ObjectsPristine => ({ snaps: new Map(), occluders: new Set() });

export interface RoomObject { name: string; node: THREE.Object3D; label: string; /** the node + its LOD siblings */ nodes: THREE.Object3D[] }
export const OBJECT_LIST_CAP = 250;
/** Smaller than this (bounding-box diagonal, m) is a detail, not an object. */
const MIN_DIAG = 0.15;

const d2r = THREE.MathUtils.degToRad;
const eulerOf = (rot: V3) => new THREE.Euler(d2r(rot[0]), d2r(rot[1]), d2r(rot[2]), 'YXZ');

/** name → node (the first node of that name under the room; engine-added groups are never listed). */
const index = new WeakMap<THREE.Object3D, Map<string, THREE.Object3D>>();
export function objectNode(room: RoomInfo, name: string): THREE.Object3D | null {
  let m = index.get(room.root);
  if (!m) {
    m = new Map();
    const map = m;
    room.root.traverse((o) => { if (o !== room.root && o.name && !map.has(o.name)) map.set(o.name, o); });
    index.set(room.root, m);
  }
  return m.get(name) ?? null;
}

const LOD = /^(.*)_LOD(\d)$/;
/** A node and its LOD siblings (<base>_LOD0 … _LODn under the same parent; the node first). Not an LOD level: [node]. */
export function lodGroup(node: THREE.Object3D): THREE.Object3D[] {
  const m = LOD.exec(node.name);
  if (!m || !node.parent) return [node];
  const sib = node.parent.children.filter((c) => c !== node && LOD.exec(c.name)?.[1] === m[1]);
  return [node, ...sib.sort((a, b) => a.name.localeCompare(b.name))];
}
/** Every node an object name stands for (an LOD group's levels too). */
export function objectNodes(room: RoomInfo, name: string): THREE.Object3D[] {
  const n = objectNode(room, name);
  return n ? lodGroup(n) : [];
}
/** The nodes a layer moves (+ their LOD siblings): the room clips stop animating exactly these (SceneRuntime). */
export function movedNodes(room: RoomInfo, ue: Pick<RoomEdits, 'movedObjects'> | null | undefined): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  for (const name of Object.keys(ue?.movedObjects ?? {})) if (objectNameOk(name)) out.push(...objectNodes(room, name));
  return out;
}

/** "DESK_PROPS" → "Desk props", "Gaming_Chair_2" → "Gaming chair 2", "TV_FRAME" → "TV frame". */
export function objectLabel(name: string): string {
  const words = name.replace(/_LOD\d$/, '').replace(/[_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').split(/\s+/).filter(Boolean);
  const s = words.map((w) => (/^[A-Z]{2}$/.test(w) ? w : w.toLowerCase())).join(' ');
  return s ? s[0].toUpperCase() + s.slice(1) : name;
}

/** The room's own objects a user can hide / move. `hidden` = names the layer hides now (listed although invisible). */
export function listRoomObjects(room: RoomInfo, hidden: Iterable<string> = []): RoomObject[] {
  const hid = new Set(hidden);
  const out: RoomObject[] = [];
  const seen = new Set<string>();
  const roomDiag = room.bounds.isEmpty() ? 40 : room.bounds.getSize(new THREE.Vector3()).length();
  const box = new THREE.Box3();
  room.root.updateMatrixWorld(true);
  const visit = (o: THREE.Object3D, depth: number) => {
    const lodDone = new Set<string>();
    for (const c of o.children) {
      if (out.length >= OBJECT_LIST_CAP) return;
      const name = c.name;
      // an LOD group: one object (its first level), drawn if any level is (the LOD system shows one at a time)
      const lm = LOD.exec(name);
      if (lm && lodDone.has(lm[1])) continue;
      const group = lm ? lodGroup(c) : [c];
      if (lm) lodDone.add(lm[1]);
      const userHidden = group.some((n) => !!n.name && hid.has(n.name));
      const shown = group.some((n) => n.visible || gfxLod.manages(n));
      if (!shown && !userHidden) continue;                     // data nodes, colliders, author hideNodes, screen-skin templates
      if (name && ENGINE_NODE.test(name)) continue;            // an engine node (anchors, lights, the screen, FX …): the engine's
      if (name && !OBJECT_NAME.test(name)) { if (depth < 5) visit(c, depth + 1); continue; }   // (an unusual name: look inside)
      let meshes = 0, engine = false, skinned = false;
      c.traverse((x) => {
        if (x !== c && x.name && ENGINE_NODE.test(x.name)) engine = true;
        if ((x as THREE.Mesh).isMesh) { meshes++; if ((x as THREE.SkinnedMesh).isSkinnedMesh) skinned = true; }
      });
      if (!meshes || skinned) continue;
      box.setFromObject(c);
      const diag = box.isEmpty() ? 0 : box.getSize(new THREE.Vector3()).length();
      // (one glTF mesh with several materials loads as a group of childless meshes NAME_1, NAME_2 …: one object, never
      // opened up; any other group as big as most of the room is a container: its parts are the objects)
      const container = !(c as THREE.Mesh).isMesh && c.children.length > 1 && diag > roomDiag * 0.6 && !primitiveSplit(c);
      if (!name || engine || container) { if (depth < 5) visit(c, depth + 1); continue; }
      if (diag < MIN_DIAG || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, node: c, label: objectLabel(name), nodes: group });
    }
  };
  visit(room.root, 0);
  return out;
}
/** A group GLTFLoader made from ONE multi-material mesh: only childless meshes, named after one base (+ _1, _2 …). */
function primitiveSplit(g: THREE.Object3D): boolean {
  if (g.children.length < 2 || g.children.length > 32) return false;
  let base: string | null = null;
  for (const ch of g.children) {
    if (!(ch as THREE.Mesh).isMesh || ch.children.length) return false;
    const b = ch.name.replace(/_?\d+$/, '');
    if (base === null) base = b; else if (b !== base) return false;
  }
  return true;
}

/** The handle a room object is moved / turned by: the bottom centre of its own geometry, in the node's local frame
 *  (a merged room mesh often has its origin at the room's centre: turning it about that would swing it across the room).
 *  The layer still stores the node's origin; the editor converts (pivotToOrigin). */
const pivots = new WeakMap<THREE.Object3D, THREE.Vector3>();
export function objectPivot(node: THREE.Object3D): THREE.Vector3 {
  let p = pivots.get(node);
  if (p) return p;
  node.updateWorldMatrix(true, true);
  const inv = node.matrixWorld.clone().invert();
  const box = new THREE.Box3(), part = new THREE.Box3(), m4 = new THREE.Matrix4();
  node.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    part.copy(m.geometry.boundingBox!).applyMatrix4(m4.multiplyMatrices(inv, m.matrixWorld));
    box.union(part);
  });
  p = box.isEmpty() ? new THREE.Vector3() : new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
  pivots.set(node, p);
  return p;
}
/** Where a node's origin goes (room space) for its handle at `pivot` with rotation `quat` and room-space size `scale`. */
export function pivotToOrigin(node: THREE.Object3D, pivot: THREE.Vector3, quat: THREE.Quaternion, scale: THREE.Vector3): THREE.Vector3 {
  return pivot.clone().sub(objectPivot(node).clone().multiply(scale).applyQuaternion(quat));
}
/** The handle (room space) of a node posed at origin `pos`, `quat`, room-space size `scale`. */
export function originToPivot(node: THREE.Object3D, pos: THREE.Vector3, quat: THREE.Quaternion, scale: THREE.Vector3): THREE.Vector3 {
  return objectPivot(node).clone().multiply(scale).applyQuaternion(quat).add(pos);
}

/** A node's pose relative to the room root (room space). */
export function roomPose(room: RoomInfo, node: THREE.Object3D): { pos: THREE.Vector3; quat: THREE.Quaternion; scale: THREE.Vector3 } {
  room.root.updateMatrixWorld(true);
  node.updateWorldMatrix(true, false);
  const m = room.root.matrixWorld.clone().invert().multiply(node.matrixWorld);
  const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scale = new THREE.Vector3();
  m.decompose(pos, quat, scale);
  return { pos, quat, scale };
}

function snap(room: RoomInfo, p: ObjectsPristine, node: THREE.Object3D): ObjectSnap {
  let s = p.snaps.get(node);
  if (!s) {
    const m = roomMatrix(room, node);
    // (decompose, not setFromMatrixScale: a mirrored mesh keeps its negative axis, so `want` never flips it)
    const roomScale = new THREE.Vector3();
    m.decompose(new THREE.Vector3(), new THREE.Quaternion(), roomScale);
    s = { position: node.position.clone(), quaternion: node.quaternion.clone(), scale: node.scale.clone(), visible: node.visible, roomScale, room: m };
    p.snaps.set(node, s);
  }
  return s;
}
/** Set a node's local transform so its room-space matrix is `m`. */
function setRoomMatrix(room: RoomInfo, node: THREE.Object3D, m: THREE.Matrix4) {
  node.parent?.updateWorldMatrix(true, false);
  const world = room.root.matrixWorld.clone().multiply(m);
  const local = (node.parent ? node.parent.matrixWorld.clone().invert() : new THREE.Matrix4()).multiply(world);
  local.decompose(node.position, node.quaternion, node.scale);
  node.updateMatrixWorld(true);
}

/** Put a node where a room-space pose says (scale = on top of its authored room-space size). */
export function placeRoomObject(room: RoomInfo, node: THREE.Object3D, roomScale: THREE.Vector3, e: Pick<ObjectEdit, 'pos' | 'rot' | 'scale'>) {
  room.root.updateMatrixWorld(true);
  setRoomMatrix(room, node, new THREE.Matrix4().compose(new THREE.Vector3(...e.pos), new THREE.Quaternion().setFromEuler(eulerOf(e.rot)), roomScale.clone().multiplyScalar(e.scale)));
}
/** Move a set of nodes by one room-space transform `delta` applied to their room matrices `from` (an LOD group moved
 *  as one; the editor's live drag). */
export function moveRoomNodes(room: RoomInfo, nodes: { node: THREE.Object3D; from: THREE.Matrix4 }[], delta: THREE.Matrix4) {
  room.root.updateMatrixWorld(true);
  for (const { node, from } of nodes) setRoomMatrix(room, node, delta.clone().multiply(from));
  for (const { node } of nodes) gfxLod.refit(node);
}
/** The pristine of each room (registered when the layer is applied / restored), for authoredRoomMatrix. */
const pristineOf = new WeakMap<THREE.Object3D, ObjectsPristine>();
/** A node's AUTHORED room-space matrix — what applyRoomObjects places from: its snapshot when the layer touched it, else
 *  its own (untouched) local transform under its parent's authored matrix (a parent the layer moved / resized counts as
 *  authored, so a child's size never includes the parent's new size). */
export function authoredRoomMatrix(room: RoomInfo, node: THREE.Object3D): THREE.Matrix4 {
  const p = pristineOf.get(room.root);
  const walk = (n: THREE.Object3D): THREE.Matrix4 => {
    const s = p?.snaps.get(n);
    if (s) return s.room.clone();
    const local = new THREE.Matrix4().compose(n.position, n.quaternion, n.scale);
    return !n.parent || n.parent === room.root ? local : walk(n.parent).multiply(local);
  };
  return walk(node);
}
/** Where a room object goes for an editor handle (its bottom-centre pivot) at `pivot`, turned `quat`, `s` × its authored
 *  size: the node origin the layer stores and the room matrix applyRoomObjects will give it (`authored` = taken before a
 *  live drag moved the node). The editor's drag preview and its Save both use this, so mouse-up never jumps. */
export function objectTarget(room: RoomInfo, node: THREE.Object3D, pivot: THREE.Vector3, quat: THREE.Quaternion, s: number, authored = authoredRoomMatrix(room, node)): { origin: THREE.Vector3; want: THREE.Matrix4; authored: THREE.Matrix4 } {
  const base = new THREE.Vector3();
  authored.decompose(new THREE.Vector3(), new THREE.Quaternion(), base);
  const size = base.multiplyScalar(s);
  const origin = pivotToOrigin(node, pivot, quat, size);
  return { origin, want: new THREE.Matrix4().compose(origin, quat, size), authored };
}

/** A node's room-space matrix now. */
export function roomMatrix(room: RoomInfo, node: THREE.Object3D): THREE.Matrix4 {
  room.root.updateMatrixWorld(true);
  node.updateWorldMatrix(true, false);
  return room.root.matrixWorld.clone().invert().multiply(node.matrixWorld);
}

const depthOf = (o: THREE.Object3D) => { let d = 0; for (let p = o.parent; p; p = p.parent) d++; return d; };

/** Hide / move the room's own objects as the layer says (call on the authored room: after restoreRoomObjects). */
export function applyRoomObjects(room: RoomInfo, p: ObjectsPristine, ue: { hiddenObjects?: unknown; movedObjects?: unknown } | undefined) {
  pristineOf.set(room.root, p);
  if (!ue) return;
  const moved = ue.movedObjects && typeof ue.movedObjects === 'object' ? ue.movedObjects as Record<string, ObjectEdit> : {};
  const list: [THREE.Object3D[], ObjectEdit][] = [];
  for (const [name, e] of Object.entries(moved)) {
    if (!objectNameOk(name) || !e || !Array.isArray(e.pos) || !Array.isArray(e.rot)) continue;
    const ns = objectNodes(room, name);
    if (ns.length) list.push([ns, e]);
  }
  list.sort((a, b) => depthOf(a[0][0]) - depthOf(b[0][0]));            // (a moved parent first: its children follow it)
  // every moved node's AUTHORED pose first (a moved parent must not change the size a moved child is snapshotted at)
  for (const [ns] of list) for (const n of ns) snap(room, p, n);
  for (const [ns, e] of list) {
    const s0 = p.snaps.get(ns[0])!;
    const want = new THREE.Matrix4().compose(new THREE.Vector3(...e.pos), new THREE.Quaternion().setFromEuler(eulerOf(e.rot)), s0.roomScale.clone().multiplyScalar(typeof e.scale === 'number' && e.scale > 0 ? e.scale : 1));
    // (the named node lands exactly where the layer says; its LOD siblings move by the same transform)
    const delta = want.clone().multiply(s0.room.clone().invert());
    moveRoomNodes(room, ns.map((n) => ({ node: n, from: p.snaps.get(n)!.room })), delta);
  }
  const hidden = Array.isArray(ue.hiddenObjects) ? ue.hiddenObjects : [];
  if (!hidden.length) return;
  const gone = new Set<THREE.Object3D>();
  for (const name of hidden) {
    if (!objectNameOk(name)) continue;
    for (const n of objectNodes(room, name)) {
      snap(room, p, n);
      n.visible = false;
      gfxLod.hold(n, true);                                              // (an LOD level stays hidden whatever its size)
      n.traverse((c) => gone.add(c));
    }
  }
  if (!gone.size) return;
  const keep: THREE.Mesh[] = [];
  for (const m of room.occluders) { if (gone.has(m)) p.occluders.add(m); else keep.push(m); }
  room.occluders.length = 0;
  room.occluders.push(...keep);
}

/** Every object the layer touched back to its authored transform + visibility (and hidden ones back in the ray tests).
 *  Returns those nodes. */
export function restoreRoomObjects(room: RoomInfo, p: ObjectsPristine): THREE.Object3D[] {
  pristineOf.set(room.root, p);
  const back = [...p.snaps.keys()];
  for (const [n, s] of p.snaps) {
    n.position.copy(s.position); n.quaternion.copy(s.quaternion); n.scale.copy(s.scale);
    if (gfxLod.manages(n)) gfxLod.hold(n, false); else n.visible = s.visible;   // (an LOD level: the LOD system picks again)
  }
  p.snaps.clear();
  if (back.length) { room.root.updateMatrixWorld(true); for (const n of back) gfxLod.refit(n); }
  if (p.occluders.size) {
    const have = new Set(room.occluders);
    for (const m of p.occluders) if (!have.has(m)) room.occluders.push(m);
    p.occluders.clear();
  }
  if (back.length) room.root.updateMatrixWorld(true);
  return back;
}
