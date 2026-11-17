// Solo react composition: where the side screen goes (when the room doesn't author one) and the camera
// two-shot — host on the left third (head + torso readable), the screen filling ~62% of the frame width
// on the right, nothing in the way — for any output aspect and avatar height.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { CamPose } from './cameraRig.ts';
import { lookPose } from './cameraRig.ts';
import type { RoomInfo, SpotInfo } from './contract.ts';
import type { SoloPlacement } from './soloScreen.ts';

const UP = new THREE.Vector3(0, 1, 0);

/** The room's occluders AT REST — the room as authored, taken when it loads, before any engine opens a door, turns a
 *  turret or launches a pod (SceneRuntime calls snapshotRest). The framing solvers' rays (RoomRays, RoomProbe) test the
 *  room in this pose: a shot solved now and one solved a minute later, or on another page (a reloaded OBS source), see
 *  the same room. Meshes an engine adds later (set pieces, once placed) are tested where they are. */
const restM = new WeakMap<THREE.Mesh, THREE.Matrix4>();
export function snapshotRest(room: RoomInfo): void {
  room.root.updateMatrixWorld(true);
  for (const m of room.occluders) if (!restM.has(m)) restM.set(m, m.matrixWorld.clone());
}
/** The matrix the framing rays use for an occluder: its rest pose when the room was snapshotted, else where it is now. */
export function rayMatrix(m: THREE.Mesh): THREE.Matrix4 { return restM.get(m) ?? m.matrixWorld; }
/** A room transform SETTLED (the forms engine: desk modules, a table slide, the dock gantry put back in the occluders
 *  where the form left them, then SceneRuntime.refreshRays() - desert_walker/SPEC.md §2.5): the rest pose of the parts
 *  it moved is taken again where they stand now, so fresh RoomRays / RoomProbe / seat planning test the desk where the
 *  form put it, never where the GLB authored it. `under` = the nodes that moved (exactly those are re-taken). Without
 *  it every snapshotted occluder is re-taken where it stands EXCEPT the parts that move on their own: continuous movers
 *  (isMoving) and the room's DOOR (it swings on entrances - always tested shut). A settled form is a closed-form pose of
 *  the shared state, so the live page and a page that loads with the form already settled take the same pose. Meshes
 *  never snapshotted (added later) stay tested where they are. Returns how many rest poses changed. */
export function resettleRest(room: RoomInfo, under?: Iterable<THREE.Object3D>): number {
  room.root.updateMatrixWorld(true);
  let pick: Set<THREE.Object3D> | null = null;
  if (under) { pick = new Set(); for (const r of under) r.traverse((o) => { pick!.add(o); }); }
  const door = new Set<THREE.Object3D>();
  if (!pick && room.door) room.door.node.traverse((o) => { door.add(o); });
  let n = 0;
  for (const m of room.occluders) {
    const R = restM.get(m);
    if (!R || (pick ? !pick.has(m) : movingM.has(m) || door.has(m))) continue;
    if (R.equals(m.matrixWorld)) continue;
    restM.set(m, m.matrixWorld.clone());
    moveSeen.delete(m);                                    // (the jump to the settled pose is not motion)
    n++;
  }
  return n;
}

/** Room occluders an engine keeps animating (a roaming drone, a flag, a turning ring or turret, battle FX — seen moving
 *  at every check for MOVER_CHECKS checks in a row): the framing rays skip them — a shot is never placed round where a
 *  mover happened to be — moving parts stay out of the ray tests (desert_walker/SPEC.md §2.5 / B1). Every page converges
 *  on the same set within moments of loading. A part that moves now and then (a door swinging on an entrance) never
 *  qualifies: it stays in the rays at its rest pose (snapshotRest), whatever moment a page solves. */
const movingM = new WeakSet<THREE.Mesh>();
const moveSeen = new WeakMap<THREE.Mesh, { e: number[]; streak: number }>();
export const MOVER_CHECKS = 8;
export function isMoving(m: THREE.Mesh): boolean { return movingM.has(m); }
/** One check of the room's occluders (SceneRuntime: every 0.25 s); returns how many became movers (the shot caches
 *  re-solve then). */
export function noteMovers(room: RoomInfo): number {
  let n = 0;
  for (const m of room.occluders) {
    if (movingM.has(m) || !restM.has(m)) continue;
    const e = m.matrixWorld.elements;
    const s = moveSeen.get(m);
    if (!s) { moveSeen.set(m, { e: e.slice(), streak: 0 }); continue; }
    let moved = false;
    for (let i = 0; i < 16; i++) if (Math.abs(e[i] - s.e[i]) > 1e-5) { moved = true; break; }
    s.streak = moved ? s.streak + 1 : 0;
    if (moved) s.e = e.slice();
    if (s.streak >= MOVER_CHECKS) { movingM.add(m); moveSeen.delete(m); n++; }
  }
  return n;
}

/** An occluder's world box for the framing rays: at rest (snapshotRest) once and for all; a mesh added later is cached
 *  while it stands still and re-taken when it moved (never a stale box that hides it from a ray depending on WHEN a page
 *  first asked). */
export function occluderBox(cache: Map<THREE.Mesh, { b: THREE.Box3; m: number[] }>, m: THREE.Mesh): THREE.Box3 {
  const R = restM.get(m);
  if (R) {
    let c0 = cache.get(m);
    if (!c0) {
      const g = m.geometry as THREE.BufferGeometry;
      if (!g.boundingBox) g.computeBoundingBox();
      c0 = { b: (g.boundingBox ?? new THREE.Box3()).clone().applyMatrix4(R), m: [] };
      cache.set(m, c0);
    }
    return c0.b;
  }
  const e = m.matrixWorld.elements;
  const c = cache.get(m);
  if (c) {
    let same = true;
    for (let i = 0; i < 16; i++) if (c.m[i] !== e[i]) { same = false; break; }
    if (same) return c.b;
    c.b.setFromObject(m); c.m = e.slice();
    return c.b;
  }
  const b = new THREE.Box3().setFromObject(m);
  cache.set(m, { b, m: m.matrixWorld.elements.slice() });
  return b;
}

/** Fast line-of-sight tests against the room (BVH per geometry, built on first use). */
export class RoomRays {
  private bvh = new WeakMap<THREE.BufferGeometry, MeshBVH>();
  private boxes = new Map<THREE.Mesh, { b: THREE.Box3; m: number[] }>();
  private inv = new THREE.Matrix4();
  private ray = new THREE.Ray();
  readonly colliders: THREE.Box3[];
  /** Ray tests so far (hit calls): the framing guarantee's count-bounded budget (src/scene/frameGuard.ts). */
  count = 0;
  /** Skip the room parts an engine keeps animating (isMoving): on for the shot solvers and the framing guarantee (what
   *  they pick must not depend on where a drone happened to be), off for the rest (walk-in planning, seats). */
  skipMovers = false;
  constructor(private room: RoomInfo) {
    this.colliders = room.colliders.map((c) => new THREE.Box3().setFromObject(c, true));
  }
  private box(m: THREE.Mesh) { return occluderBox(this.boxes, m); }
  /** Distance from `a` to the first room surface towards `b` (Infinity = clear up to b). `seeThrough`: clear glass (a
   *  window, a glass door: transparent and mostly see-through) doesn't count — what a viewer sees through it. */
  hit(a: THREE.Vector3, b: THREE.Vector3, skipNear = 0.05, seeThrough = false): number {
    this.count++;
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (len < 1e-4) return Infinity;
    dir.divideScalar(len);
    const world = new THREE.Ray(a, dir);
    let best = Infinity;
    const p = new THREE.Vector3();
    for (const m of this.room.occluders) {
      if ((this.skipMovers && movingM.has(m)) || (seeThrough && this.glassy(m))) continue;
      if (!world.intersectBox(this.box(m), p) && !this.box(m).containsPoint(a)) continue;
      if (p.distanceTo(a) > len && !this.box(m).containsPoint(a)) continue;
      const g = m.geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH };
      if (!g?.attributes?.position) continue;
      // (one BVH per geometry, shared with the camera solver / follow planner via geometry.boundsTree)
      let t = this.bvh.get(g) ?? g.boundsTree;
      if (!t) { try { t = g.boundsTree = new MeshBVH(g); } catch { continue; } }
      this.bvh.set(g, t);
      const M = rayMatrix(m);
      this.inv.copy(M).invert();
      this.ray.copy(world).applyMatrix4(this.inv);
      const mat = Array.isArray(m.material) ? m.material[0] : m.material;
      const h = t.raycastFirst(this.ray, mat?.side ?? THREE.FrontSide);
      if (!h) continue;
      const d = h.point.clone().applyMatrix4(M).distanceTo(a);
      if (d > skipNear && d < best) best = d;
    }
    return best < len - skipNear ? best : Infinity;
  }
  clear(a: THREE.Vector3, b: THREE.Vector3) { return this.hit(a, b) === Infinity; }
  /** Line of sight for a face: like `clear`, but clear glass doesn't block (framing guarantee, src/scene/frameGuard.ts). */
  clearSee(a: THREE.Vector3, b: THREE.Vector3) { return this.hit(a, b, 0.05, true) === Infinity; }
  private glass = new WeakMap<THREE.Mesh, boolean>();
  /** Every material of the mesh is see-through glass (transparent, opacity < 0.5, or transmissive). */
  private glassy(m: THREE.Mesh): boolean {
    let g = this.glass.get(m);
    if (g === undefined) {
      const mats = (Array.isArray(m.material) ? m.material : [m.material]) as (THREE.Material & { transmission?: number })[];
      g = mats.length > 0 && mats.every((x) => !!x && ((x.transparent && x.opacity < 0.5) || (x.transmission ?? 0) > 0.5));
      this.glass.set(m, g);
    }
    return g;
  }
  /** Room surface straight above a point (ceiling), or null. */
  ceilingAbove(p: THREE.Vector3, max = 6): number | null {
    const d = this.hit(p, p.clone().add(new THREE.Vector3(0, max, 0)), 0.01);
    return d === Infinity ? null : p.y + d;
  }
  /** Room surface straight below a point (floor), or null. */
  floorBelow(p: THREE.Vector3, max = 6): number | null {
    const d = this.hit(p, p.clone().add(new THREE.Vector3(0, -max, 0)), 0.01);
    return d === Infinity ? null : p.y - d;
  }
  insideCollider(p: THREE.Vector3, pad = 0.06) {
    return this.colliders.some((b) => b.clone().expandByScalar(pad).containsPoint(p));
  }
}

export interface TwoShot { pose: CamPose; score: number; wfrac: number; hostU: number; clear: boolean }

export interface TwoShotInput {
  face: { center: THREE.Vector3; size: number };
  hostForward: THREE.Vector3;
  bodyH: number;
  screen: { center: THREE.Vector3; normal: THREE.Vector3; width: number; height: number };
  aspect: number;
  rays: RoomRays;
  /** Other performers (rough boxes) that must not cover the screen either. */
  blockers?: THREE.Box3[];
  /** Outdoor / void rooms: an engine draws everything past the set, so open view rays are fine. */
  openOk?: boolean;
}

/** Composition targets (fractions of the frame, left → right). */
export const TWO_SHOT = { hostU: 0.25, screenRight: 0.955, width: 0.62 };

function boxHit(a: THREE.Vector3, b: THREE.Vector3, boxes?: THREE.Box3[]) {
  if (!boxes?.length) return false;
  const d = b.clone().sub(a), len = d.length();
  const ray = new THREE.Ray(a, d.divideScalar(len)), p = new THREE.Vector3();
  return boxes.some((bx) => ray.intersectBox(bx, p) !== null && p.distanceTo(a) < len);
}

function project(p: THREE.Vector3, cam: THREE.PerspectiveCamera) {
  const v = p.clone().project(cam);
  return { u: (v.x + 1) / 2, v: (1 - v.y) / 2, front: v.z < 1 && v.z > -1 };
}

/** Camera for the solo react two-shot (searches a few directions / heights, keeps the clearest composition). */
export function solveTwoShot(inp: TwoShotInput): TwoShot {
  const { face, screen, aspect } = inp;
  const H = face.center.clone();
  const S = screen.center.clone();
  const nS = screen.normal.clone().setY(0).normalize();
  const fH = inp.hostForward.clone().setY(0).normalize();
  // look against the screen normal, pulled a little towards the host's facing so both read front-on
  const c0 = nS.clone().multiplyScalar(0.72).add(fH.clone().multiplyScalar(0.28)).normalize().negate();
  const vfov = 32;
  const k = Math.tan(THREE.MathUtils.degToRad(vfov) / 2) * aspect;
  const across = new THREE.Vector3().crossVectors(UP, nS).normalize();     // the screen's own left→right, seen from the front
  const torso = face.size * 2.2 + inp.bodyH * 0.12;
  let best: TwoShot | null = null;
  for (const dYaw of [0, -7, 7, -14, 14, 21, -21]) for (const dy of [0, 0.22, 0.45, -0.12]) {
    const c = c0.clone().applyAxisAngle(UP, THREE.MathUtils.degToRad(dYaw));
    const r = new THREE.Vector3().crossVectors(c, UP).normalize();          // camera right
    // the screen edge that ends up on the right of the frame
    const edge = S.clone().addScaledVector(across, (across.dot(r) >= 0 ? 1 : -1) * screen.width / 2);
    const mh = 2 * TWO_SHOT.hostU - 1, mr = 2 * TWO_SHOT.screenRight - 1;
    const a0h = H.dot(r), b0h = H.dot(c), a0r = edge.dot(r), b0r = edge.dot(c);
    const y = (k * (mh * b0h - mr * b0r) - (a0h - a0r)) / (k * (mh - mr));
    const x = a0h - mh * k * (b0h - y);
    const C = r.clone().multiplyScalar(x).addScaledVector(c, y);
    if (b0h - y < 0.9 || b0r - y < 0.9) continue;                            // both well in front
    C.y = H.y * 0.5 + S.y * 0.5 + dy;
    // vertical: centre the union of the host's head-and-torso and the screen
    const top = Math.max(H.y + face.size * 0.9, S.y + screen.height / 2 + 0.3);   // + the motor housing
    const bot = Math.min(H.y - torso, S.y - screen.height / 2 - 0.08);
    const dist = ((b0h - y) + (b0r - y)) / 2;
    // vertical: the union's centre, moved (within the slack the frame leaves) so the host's face sits at ≤ 45% from the
    // top — a screen hung high must not push the host to the bottom edge
    const Hf = 2 * (b0h - y) * Math.tan(THREE.MathUtils.degToRad(vfov) / 2);
    let cy = (top + bot) / 2;
    const want = H.y + Hf * (0.5 - 0.45);                                     // centre that puts the face at v = 0.45
    const lo = top - Hf * 0.48, hi = bot + Hf * 0.48;                        // the union still fits between these
    if (lo <= hi) cy = THREE.MathUtils.clamp(want, lo, hi);
    const target = C.clone().addScaledVector(c, dist).setY(cy);
    const pose = lookPose(C, target, vfov);
    // score it with a real projection
    const cam = new THREE.PerspectiveCamera(vfov, aspect, 0.03, 200);
    cam.position.copy(pose.position); cam.quaternion.copy(pose.quaternion); cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    const corners = [-1, 1].flatMap((sx) => [-1, 1].map((sy) => S.clone().addScaledVector(across, sx * screen.width / 2).add(new THREE.Vector3(0, sy * screen.height / 2, 0))));
    const pc = corners.map((p) => project(p, cam));
    const u0 = Math.min(...pc.map((q) => q.u)), u1 = Math.max(...pc.map((q) => q.u));
    const v0 = Math.min(...pc.map((q) => q.v)), v1 = Math.max(...pc.map((q) => q.v));
    const ph = project(H, cam);
    const hostHalf = (face.size * 1.6) / (2 * dist * k);                     // shoulders, as a frame fraction
    let score = Math.abs((u1 - u0) - TWO_SHOT.width) * 4 + Math.abs(dYaw) * 0.01 + Math.abs(dy) * 0.5;
    if (u0 < ph.u + hostHalf + 0.015) score += 3 + (ph.u + hostHalf - u0) * 10;   // host overlaps the screen
    if (v0 < 0.02 || v1 > 0.98 || u1 > 0.99 || u0 < 0.01) score += 2;
    const hTop = project(S.clone().add(new THREE.Vector3(0, screen.height / 2 + 0.26, 0)), cam);
    if (hTop.v < 0.005) score += 1.2;                                        // keep the motor housing in shot
    if (ph.v < 0.18 || ph.v > 0.58) score += 1 + Math.max(0, ph.v - 0.58) * 8;   // the host's face stays readable (not at the bottom edge)
    if (!pc.every((q) => q.front) || !ph.front) score += 50;
    // nothing may occlude the screen (6×4 samples, inset) or the host's face; the camera must see into the room
    let clear = true, blocked = 0;
    for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) {
      const p = S.clone().addScaledVector(across, ((i + 0.5) / 6 - 0.5) * screen.width * 0.97).add(new THREE.Vector3(0, ((j + 0.5) / 4 - 0.5) * screen.height * 0.97, 0));
      if (!inp.rays.clear(C, p) || boxHit(C, p, inp.blockers)) blocked++;
    }
    if (blocked) { clear = false; score += 1 + blocked * 0.8; }
    if (!inp.rays.clear(C, H)) { clear = false; score += 3; }
    // the frame must not look past the set's edge (view rays sideways / down that meet nothing = void)
    let open = 0;
    for (const v of [0.05, 0.5, 0.95]) for (const u of [0.03, 0.35, 0.65, 0.97]) {
      const d = new THREE.Vector3(u * 2 - 1, 1 - v * 2, 0.5).unproject(cam).sub(C).normalize();
      if (!inp.openOk && d.y < 0.08 && inp.rays.hit(C, C.clone().addScaledVector(d, 60), 0.02) === Infinity) open++;
    }
    if (open) { clear = false; score += open * 1.2; }
    if (!inp.rays.clear(H, C)) { clear = false; score += 4; }                 // a wall between host and camera
    const shot: TwoShot = { pose, score, wfrac: u1 - u0, hostU: ph.u, clear };
    if (!best || shot.score < best.score) best = shot;
  }
  return best ?? { pose: lookPose(H.clone().addScaledVector(fH, 3).setY(H.y + 0.2), H.clone().lerp(S, 0.5), vfov), score: 99, wfrac: 0, hostU: 0.5, clear: false };
}

/** Where a solo screen should go when the room doesn't say: beside the host (camera-right), clear of furniture and walls. */
export type SoloInput = { spot: SpotInfo; face: { center: THREE.Vector3; size: number }; bodyH: number; aspect: number; rays: RoomRays; openOk?: boolean };
export type SoloResult = { place: SoloPlacement; shot: TwoShot };

/** Run the whole search now (≈150–200 ms on a detailed room — prefer stepping deriveSoloSteps with a budget). */
export function deriveSoloPlacement(o: SoloInput): SoloResult {
  const g = deriveSoloSteps(o);
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}

/** The same search as a generator: yields after every candidate so the OBS page can spread it over frames. */
export function* deriveSoloSteps(o: SoloInput): Generator<void, SoloResult, void> {
  const { spot, face, rays } = o;
  const fH = spot.forward.clone().setY(0).normalize();
  const right = new THREE.Vector3().crossVectors(fH.clone().negate(), UP).normalize();   // camera-right of the host
  const W0 = THREE.MathUtils.clamp(2.5 * (o.bodyH / 1.5), 1.8, 3.2);
  const base = face.center.clone().setY(spot.position.y);
  const cands: { place: SoloPlacement; n: THREE.Vector3; pre: number; W: number }[] = [];
  for (const W of [W0, W0 * 1.16]) for (const lift of [0, 0.28, 0.56]) for (const side of [0.95, 1.1, 1.25, 1.45]) for (const back of [0.25, 0.6, 0.0, -0.3, 0.95]) for (const turn of [18, 28, 8]) {
    const Hs = W * 9 / 16;
    const d = side * (W / 2 + 0.55);
    const c = base.clone().addScaledVector(right, d).addScaledVector(fH, -back);
    const ceiling = rays.ceilingAbove(c.clone().setY(face.center.y)) ?? face.center.y + 2.4;
    // (hung with its middle a little above the face: host + screen read as one composition, the face mid-frame)
    c.y = Math.min(Math.max(face.center.y + Hs * 0.2, spot.position.y + 0.8 + Hs / 2) + lift, ceiling - 0.45 - Hs / 2);
    const n = fH.clone().multiplyScalar(Math.cos(THREE.MathUtils.degToRad(turn))).addScaledVector(right, -Math.sin(THREE.MathUtils.degToRad(turn))).normalize();
    const across = new THREE.Vector3().crossVectors(UP, n).normalize();
    // furniture: sample the panel (and the hanging bar below it)
    let bad = false;
    for (let i = 0; i <= 4 && !bad; i++) for (let j = 0; j <= 3 && !bad; j++) {
      const p = c.clone().addScaledVector(across, (i / 4 - 0.5) * (W + 0.2)).add(new THREE.Vector3(0, (j / 3 - 0.5) * (Hs + 0.12), 0));
      if (rays.insideCollider(p, 0.08)) bad = true;
    }
    if (bad) continue;
    // walls: the host must see the whole panel, and it can't poke through anything
    const corners = [-1, 1].flatMap((sx) => [-1, 1].map((sy) => c.clone().addScaledVector(across, sx * (W / 2 + 0.1)).add(new THREE.Vector3(0, sy * Hs / 2, 0))));
    if (!corners.every((q) => rays.clear(face.center, q))) continue;
    if (!rays.clear(corners[0], corners[3]) || !rays.clear(corners[1], corners[2])) continue;
    const place: SoloPlacement = { center: c, yaw: Math.atan2(n.x, n.z), width: W, ceilingY: ceiling, source: 'auto' };
    cands.push({ place, n, W, pre: Math.abs(side - 1.1) * 0.6 + Math.abs(back - 0.2) * 0.3 + Math.abs(turn - 18) * 0.01 + lift * 0.5 + (W > W0 ? 0.15 : 0) });
    yield;
  }
  // the full camera solve (many line-of-sight rays) only for the most natural few
  let best: { place: SoloPlacement; shot: TwoShot; cost: number } | null = null;
  for (const cd of cands.sort((a, b) => a.pre - b.pre).slice(0, 14)) {
    const shot = solveTwoShot({ face, hostForward: fH, bodyH: o.bodyH, screen: { center: cd.place.center, normal: cd.n, width: cd.W, height: cd.W * 9 / 16 }, aspect: o.aspect, rays, openOk: o.openOk });
    const cost = shot.score + cd.pre;
    if (!best || cost < best.cost) best = { place: cd.place, shot, cost };
    if (shot.clear && shot.score < 0.4) break;
    yield;
  }
  if (best) return { place: best.place, shot: best.shot };
  const W = W0, Hs = W * 9 / 16;
  // nothing fits cleanly: straight to the side, as high as the ceiling allows
  const c = base.clone().addScaledVector(right, W / 2 + 0.7).setY(face.center.y + 0.1);
  const place: SoloPlacement = { center: c, yaw: Math.atan2(fH.x, fH.z), width: W, ceilingY: rays.ceilingAbove(c) ?? c.y + 2, source: 'auto' };
  return { place, shot: solveTwoShot({ face, hostForward: fH, bodyH: o.bodyH, screen: { center: c, normal: fH, width: W, height: Hs }, aspect: o.aspect, rays, openOk: o.openOk }) };
}
