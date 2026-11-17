// Automatic camera framing that keeps the shot INSIDE the modelled set (docs/SCENES.md "Cameras").
//
// Talk (one performer, medium shot) and group (everyone present) shots are chosen from a small set of candidate
// directions / heights around the preferred one (talk: 16° off the performer's facing towards the room centre;
// group: CAM_WIDE's direction). Each candidate frames the ACTUAL faces (measured heights × scale — micro and macro
// performers frame the same), is pulled in front of walls (widening the lens), then scored:
//   · faces hidden by the room (the renderer's own culling: back faces don't block) or by other performers
//   · faces out of frame, performers seen from behind / in profile
//   · the camera inside geometry or BEHIND a wall (it sees the back of big single-sided surfaces = outside the set)
//   · view rays that leave the set sideways / downwards (void), foreground clutter right in front of the lens
//   · distance from the preferred direction / height, lens widening
// Cheap framing for every candidate first, ray tests in score order (a few hundred rays, ~1–3 ms, only when the
// shot's inputs change — SceneRuntime caches the result). Pure function of room + performers → every page agrees.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { lookPose, type CamPose } from './cameraRig.ts';
import type { RoomInfo } from './contract.ts';
import { isMoving, occluderBox, rayMatrix, type RoomRays } from './twoShot.ts';
import type { FramingClass, MotionEnvelope, RigPreset } from '../../shared/framing.ts';
import { onFaceSurface } from './faceDepth.ts';
import { cardLens } from '../../shared/flatFraming.ts';

const UP = new THREE.Vector3(0, 1, 0);
const D2R = Math.PI / 180;

export interface ShotSubject {
  key: string;
  face: { center: THREE.Vector3; size: number };
  /** Floor point under them, standing height (m, scaled), facing (horizontal unit). */
  floor: THREE.Vector3;
  height: number;
  forward: THREE.Vector3;
  sit: boolean;
  /** Head top (hair, ears, antennae, hats) above the face centre, m (default 1.1 × face size). */
  top?: number;
  /** The head's horizontal half-extent, m (hair, a mascot head, a costume box) — measured at rest, when known. */
  headHalf?: number;
  /** Framing class (shared/framing.ts): the camera rig preset of their size class, or `mech` (framed on the pilot, low
   *  hero angle). Unset = normal (the classic talk shot). */
  rig?: FramingClass;
  /** A mech's hull (m above the floor, horizontal half-extent): the group shot frames the whole walker (hull group shot). */
  hull?: { top: number; half: number };
  /** The whole occupant as a world box (a mech's hull): it hides what is behind it, a camera never goes inside it. */
  body?: THREE.Box3;
  /** The drawn face surface in front of the face centre, m (src/scene/faceDepth.ts: an eye-bone face anchor sits inside
   *  the head) — line-of-sight tests aim at the surface. */
  depth?: number;
  /** The middle of the head, where the body volumes (head sphere, torso box) go round (default face.center): a drawn face
   *  sits on the front of a big head — volumes centred on it would stand out in front of the face. */
  head?: THREE.Vector3;
  /** A 2D card: its drawn art's bottom / top (m, world). The talk shot frames the art from its top down (the face of a
   *  picture is no human face measure: a chibi's head-sized "face" made a 4 m wide shot). */
  art?: { bottom: number; top: number; bust?: boolean; half?: number; base?: THREE.Vector3 };
}

export interface ShotRequest {
  kind: 'talk' | 'group';
  subjects: ShotSubject[];
  /** Everyone else in the room (they may block the view, never framed). */
  others: ShotSubject[];
  /** Horizontal unit vector from the subjects towards the preferred camera side. */
  prefer: THREE.Vector3;
  aspect: number;
  /** Outdoor room (an engine draws sky / sea / horizon): only steep looks down into nothing are holes. */
  skyOk: boolean;
  /** Open void in every direction is the designed backdrop (epoch / space rooms): open rays cost nothing. */
  voidOk?: boolean;
  /** An authored pose (SPOT_xx_CAM) to validate / re-aim first. */
  seed?: CamPose | null;
  /** Framing guarantee (src/scene/frameGuard.ts): the room's motion envelope, rig tweaks (scene.json framing.rigs),
   *  its wide camera as a fallback, the talk rig's elevation (deg); off = skip the guard (scene.json framing.guard false). */
  guard?: { off?: boolean; motion?: MotionEnvelope | null; rigs?: Record<string, unknown> | null; safe?: Record<string, unknown> | null; wide?: CamPose | null; rig?: RigPreset | null };
}

export interface ShotResult { pose: CamPose; score: number; source: 'authored' | 'auto'; notes: string[] }

interface Hit { d: number; back: boolean; area: number }

/** Double-sided first hits with the face's facing + area (walls seen from behind), sharing BVHs via geometry.boundsTree. */
export class RoomProbe {
  private boxes = new Map<THREE.Mesh, { b: THREE.Box3; m: number[] }>();
  private inv = new THREE.Matrix4();
  private nm = new THREE.Matrix3();
  /** Ray tests so far (first calls): the framing guarantee's count-bounded budget (src/scene/frameGuard.ts). */
  count = 0;
  /** Skip the room parts an engine keeps animating (RoomRays.skipMovers). */
  skipMovers = false;
  /** Meshes to leave out for a while (the interview set's own pieces during its room-camera checks); null = none. */
  skip: Set<THREE.Object3D> | null = null;
  constructor(private room: RoomInfo) {}
  private box(m: THREE.Mesh) { return occluderBox(this.boxes, m); }
  /** The nearest drawn room surface within `max` of a point (m), or null: one distance query per nearby mesh, no rays (a
   *  camera lens right against a beam / wall in ANY direction — its near plane would cut into it). */
  nearest(p: THREE.Vector3, max: number): number | null { return this.nearestPoint(p, max)?.d ?? null; }
  /** The same, with the nearest point itself (world). */
  nearestPoint(p: THREE.Vector3, max: number): { d: number; point: THREE.Vector3 } | null {
    let best: { d: number; point: THREE.Vector3 } | null = null;
    const loc = new THREE.Vector3(), w = new THREE.Vector3();
    for (const m of this.room.occluders) {
      if ((this.skipMovers && isMoving(m)) || this.skip?.has(m) || this.box(m).distanceToPoint(p) > max) continue;
      const g = m.geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH };
      if (!g?.attributes?.position) continue;
      if (!g.boundsTree) { try { g.boundsTree = new MeshBVH(g); } catch { continue; } }
      const M = rayMatrix(m);
      this.inv.copy(M).invert();
      loc.copy(p).applyMatrix4(this.inv);
      // (the local threshold: the world one over the mesh's smallest scale — a scaled-down mesh's local units are bigger)
      const sc = new THREE.Vector3().setFromMatrixScale(M);
      const k = Math.max(1e-6, Math.min(Math.abs(sc.x), Math.abs(sc.y), Math.abs(sc.z)));
      const t = g.boundsTree.closestPointToPoint(loc, { point: new THREE.Vector3(), distance: 0, faceIndex: 0 }, 0, max / k);
      if (!t) continue;
      const d = w.copy(t.point).applyMatrix4(M).distanceTo(p);
      if (d <= max && (best === null || d < best.d)) best = { d, point: w.clone() };
    }
    return best;
  }
  first(o: THREE.Vector3, dir: THREE.Vector3, far: number): Hit | null {
    this.count++;
    const world = new THREE.Ray(o, dir);
    const p = new THREE.Vector3();
    let best: Hit | null = null;
    for (const m of this.room.occluders) {
      if ((this.skipMovers && isMoving(m)) || this.skip?.has(m)) continue;
      const b = this.box(m);
      if (!b.containsPoint(o) && (!world.intersectBox(b, p) || p.distanceTo(o) > far)) continue;
      const g = m.geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH };
      if (!g?.attributes?.position) continue;
      if (!g.boundsTree) { try { g.boundsTree = new MeshBVH(g); } catch { continue; } }
      const M = rayMatrix(m);
      this.inv.copy(M).invert();
      const h = g.boundsTree.raycastFirst(world.clone().applyMatrix4(this.inv), THREE.DoubleSide);
      if (!h || !h.face) continue;
      const wp = h.point.clone().applyMatrix4(M);
      const d = wp.distanceTo(o);
      if (d > far || (best && d >= best.d)) continue;
      const n = h.face.normal.clone().applyMatrix3(this.nm.getNormalMatrix(M)).normalize();
      const mat = (Array.isArray(m.material) ? m.material[h.face.materialIndex ?? 0] ?? m.material[0] : m.material) as THREE.Material | undefined;
      const pos = g.attributes.position as THREE.BufferAttribute;
      const t = [h.face.a, h.face.b, h.face.c].map((i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(M));
      best = { d, back: n.dot(dir) > 0 && (mat?.side ?? THREE.FrontSide) === THREE.FrontSide, area: new THREE.Triangle(t[0], t[1], t[2]).getArea() };
    }
    return best;
  }
  /** What the renderer shows along a ray: back faces of single-sided surfaces are culled (see-through), so walk past
   *  them to the first FRONT face. null = nothing drawn (void, or the sky / backdrop colour). */
  drawn(o: THREE.Vector3, dir: THREE.Vector3, far: number): number | null {
    let gone = 0;
    for (let k = 0; k < 6; k++) {
      const h = this.first(o.clone().addScaledVector(dir, gone), dir, far - gone);
      if (!h) return null;
      if (!h.back) return gone + h.d;
      gone += h.d + 0.003;
    }
    return gone;
  }
  /** Inside a closed solid (furniture, a wall slab): most of 6 directions meet a back face within 4 m. */
  inside(p: THREE.Vector3): boolean {
    let n = 0;
    for (const d of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
      const h = this.first(p, new THREE.Vector3(d[0], d[1], d[2]), 4);
      if (h && h.back) n++;
    }
    return n >= 4;
  }
  /** Is this point behind a wall / inside a solid (most horizontal directions meet the back of a big surface)? */
  outside(p: THREE.Vector3, reach = 6): number {
    let n = 0;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const h = this.first(p, new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), reach);
      if (h && h.back && h.area > 0.2) n++;
    }
    const dn = this.first(p, new THREE.Vector3(0, -1, 0), reach);
    if (dn && dn.back && dn.area > 0.2) n += 2;                           // under the floor
    return n;
  }
}

/** Segment a→b against a performer approximated as a head sphere + a torso box. */
export function hitsPerson(a: THREE.Vector3, b: THREE.Vector3, s: ShotSubject): boolean {
  const d = b.clone().sub(a), L = d.length();
  if (L < 1e-4) return false;
  const ray = new THREE.Ray(a, d.divideScalar(L)), p = new THREE.Vector3();
  const c = s.head ?? s.face.center;
  const head = new THREE.Sphere(c.clone().add(new THREE.Vector3(0, s.face.size * 0.15, 0)), s.face.size * 0.72);
  if (ray.intersectSphere(head, p) && p.distanceTo(a) < L - 0.02) return true;
  const w = s.face.size * 1.05;
  const top = c.y - s.face.size * 0.6;
  const bot = s.sit ? top - s.height * 0.32 : s.floor.y;
  const box = new THREE.Box3(new THREE.Vector3(c.x - w, bot, c.z - w), new THREE.Vector3(c.x + w, top, c.z + w));
  return !!ray.intersectBox(box, p) && p.distanceTo(a) < L - 0.02;
}

/** Vertical FOV (deg) a camera at `pos` looking at `target` needs to show every point (+ margin m), capped at 75°;
 *  never narrower than `min` / 2 (deg) when given. (Shared with the interview shots, talkshow/shots.ts.) */
export function fitFov(pos: THREE.Vector3, target: THREE.Vector3, pts: THREE.Vector3[], aspect: number, margin: number, min?: number): number {
  const fwd = target.clone().sub(pos).normalize();
  const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
  const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
  let t = min === undefined ? 0.1 : Math.tan((min * 0.5 * D2R) / 2);
  for (const p of pts) {
    const r = p.clone().sub(pos), z = Math.max(0.2, r.dot(fwd));
    t = Math.max(t, (Math.abs(r.dot(up)) + margin) / z, (Math.abs(r.dot(right)) + margin) / z / aspect);
  }
  return Math.min(75, (2 * Math.atan(t)) / D2R);
}

/** Distance along `dir` (from `c`) at which every point fits a frustum looking back at `c`. */
export function fitDistance(pts: THREE.Vector3[], c: THREE.Vector3, dir: THREE.Vector3, fov: number, aspect: number, margin: number): number {
  const fwd = dir.clone().negate();
  const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
  const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
  const vt = Math.tan((fov * D2R) / 2), ht = vt * aspect;
  let need = 0.6;
  for (const p of pts) {
    const r = p.clone().sub(c);
    const depth = r.dot(dir);                                        // towards the camera
    need = Math.max(need, (Math.abs(r.dot(right)) + margin) / ht + depth, (Math.abs(r.dot(up)) + margin) / vt + depth);
  }
  return need;
}

/** Safe area of multi-person shots (NDC): nobody's head / shoulders in the outer 8 % of the sides, head tops below
 *  the top 7 %, the lowest framed point (chests) above the bottom 3 %. */
export const SAFE = { x: 0.84, top: 0.86, bottom: 0.94 };

/** From a FIXED position: the aim + lens that put every point inside the safe area, the points' extent centred
 *  sideways; spare height (a wide row) puts the group's middle a little above the frame's middle, never above the
 *  top safe line. Exact in the projection (iterated re-aim), lens clamped to [minFov, maxFov] (deg; clamped = some
 *  points fall outside, the caller's score sees it). null = a point is behind / level with the camera. */
export function frameFrom(pos: THREE.Vector3, pts: THREE.Vector3[], aspect: number, o: { safeX?: number; safeTop?: number; safeBot?: number; minFov?: number; maxFov?: number; aim?: THREE.Vector3 } = {}): CamPose | null {
  if (!pts.length) return null;
  const sx = o.safeX ?? SAFE.x, st = o.safeTop ?? SAFE.top, sb = o.safeBot ?? SAFE.bottom;
  let aim = (o.aim ?? pts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length)).clone();
  const reach = Math.max(0.5, aim.distanceTo(pos));
  let T = 0.3;
  const fwd = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3(), r = new THREE.Vector3();
  // (re-aim until the extents are centred; the last pass only measures, so the lens always matches the final aim)
  for (let it = 0; it < 8; it++) {
    fwd.copy(aim).sub(pos);
    if (fwd.lengthSq() < 1e-6) return null;
    fwd.normalize();
    if (Math.abs(fwd.y) > 0.97) return null;
    right.crossVectors(fwd, UP).normalize();
    up.crossVectors(right, fwd).normalize();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of pts) {
      r.copy(p).sub(pos);
      const z = r.dot(fwd);
      if (z < 0.15) return null;
      const x = r.dot(right) / z, y = r.dot(up) / z;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    // vertical half-extent (tan) that fits the sides (through the aspect) and top … bottom (asymmetric margins)
    T = Math.max((y1 - y0) / (st + sb), (x1 - x0) / (2 * sx * aspect), 0.02);
    // spare height (a wide row of people): the group's middle a little above the frame's middle — the eye line near
    // the upper third, not heads pinned under the top edge over a frame full of floor
    const cx = (x0 + x1) / 2, cy = Math.max(y1 - st * T, (y0 + y1) / 2 - 0.22 * T);
    if (it === 7 || (Math.abs(cx) < 1e-3 && Math.abs(cy) < 1e-3)) { T *= 1 + Math.abs(cx) / Math.max(0.05, T) + Math.abs(cy) / Math.max(0.05, T); break; }
    aim = pos.clone().addScaledVector(fwd.clone().addScaledVector(right, cx).addScaledVector(up, cy).normalize(), reach);
  }
  const fov = THREE.MathUtils.clamp((2 * Math.atan(T)) / D2R, o.minFov ?? 8, o.maxFov ?? 75);
  return lookPose(pos, aim, fov);
}

/** Frame height (m, at the subject) of a talk medium shot: the face ≈ 15% of the frame (head → waist on a normal
 *  body), bounded by the body so chibis / big heads don't go tight and tiny faces don't go wide. */
export function talkHeight(s: ShotSubject): number {
  // (a 2D bust: down to its cut edge, just past the frame's bottom — no taller, or the raw edge shows wherever no
  // pedestal / seat hides it; a whole body: the whole art when it fits, at least the frame a 3D performer of its height
  // gets, at most head → hips)
  if (s.art?.bust) return Math.max(0.05, s.art.top - s.art.bottom) / (1 - ART_HEADROOM + ART_CUT);
  if (s.art) return THREE.MathUtils.clamp((s.art.top - s.art.bottom) / (1 - ART_HEADROOM), s.height * (s.sit ? SIT_TALK_MAX : 0.7), s.height * (s.sit ? 0.75 : 0.95));
  // the whole head (+ a little head room) fits above the target line: face 20% above centre → frame top 0.5
  const need = (headTop(s) + 0.02) / 0.62;
  return Math.max(need, talkHeightFace(s));
}
// (never below the face box: a skeleton-measured height can put the rest "top" at the face — a big-headed mascot in a
// costume — and a frame fitted to that cuts the whole head off)
const headTop = (s: ShotSubject) => Math.max(s.face.size * 1.15, Math.min(s.top ?? s.face.size * 1.1, Math.max(s.height * 0.45, s.face.size * 1.8)));
function talkHeightFace(s: ShotSubject): number {
  // (big heads — frogs, chibis — need ≥ 7.5 face sizes so the head top + some head room stay in frame)
  // seated: at most head → lap (0.62 × standing height), a waist-up medium shot — not head → knees, which filmed
  // the lap from chest height (a skirt's worst angle; src/avatar/seatDrape.ts covers it, the shot shouldn't feature it)
  return THREE.MathUtils.clamp(s.face.size * 13, s.height * (s.sit ? 0.46 : 0.5), Math.max(s.height * (s.sit ? SIT_TALK_MAX : 0.95), s.face.size * 7.5));
}
/** Where a talk shot of `height` aims: the face 20 % above the frame's middle; a 2D card's art top just under the
 *  frame's top edge. */
export function talkTarget(s: ShotSubject, height: number): THREE.Vector3 {
  if (s.art) return new THREE.Vector3(s.face.center.x, s.art.top + height * (ART_HEADROOM - 0.5), s.face.center.z);
  return s.face.center.clone().add(new THREE.Vector3(0, -height * 0.2, 0));
}
const ART_HEADROOM = 0.08, ART_CUT = 0.01;
/** A talk candidate of a 2D BUST: re-aimed (and, when it looks down steeply or stands too close, lowered / stepped back)
 *  so its cut edge lands just past the frame's bottom from that camera — a candidate above the level one would show the
 *  raw cut where no pedestal / seat hides it (shared/flatFraming.ts cardLens). Anything else: unchanged. */
function bustPose(s: ShotSubject, p: CamPose, aspect: number): CamPose {
  const a = s.art;
  if (!a?.bust || !a.base || a.half === undefined) return p;
  const L = cardLens(p.position, { bottom: a.bottom, top: a.top, half: a.half, base: a.base }, aspect, true, s.forward);
  const eye = new THREE.Vector3(L.eye.x, L.eye.y, L.eye.z), hz = new THREE.Vector3(a.base.x - eye.x, 0, a.base.z - eye.z), D = Math.max(1e-6, hz.length());
  return lookPose(eye, eye.clone().addScaledVector(hz.divideScalar(D), D).add(new THREE.Vector3(0, D * Math.tan(L.pitch), 0)), THREE.MathUtils.radToDeg(2 * Math.atan(L.tanHalf)));
}

/** Seated talk shot: the most of a sitter's standing height the frame may show (see talkHeightFace). */
export const SIT_TALK_MAX = 0.62;

/** pre = a lower bound of the full score (sorting + early out); base = the part of it that isn't the pose's framing
 *  (the full score re-measures that). */
interface Cand { pose: CamPose; pre: number; base?: number; pulled: number; dyaw: number; notes: string[]; fix?: () => CamPose | null }

const RING = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [Math.cos((k * Math.PI) / 4), Math.sin((k * Math.PI) / 4)]);

/** What a group shot must fit per person: head top, chest, and the head's / shoulders' width (a ring: any view direction). */
export function groupPoints(subs: ShotSubject[]): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (const s of subs) {
    const b = bodyOf(s), c = s.face.center, chest = c.clone().add(new THREE.Vector3(0, -b.chest, 0));
    pts.push(c.clone().add(new THREE.Vector3(0, headTop(s), 0)), chest);
    // (a mech: the hull group shot — its top and sides, the cockpit's pilot face framed with the rest)
    if (s.hull) { const right = new THREE.Vector3().crossVectors(s.forward, UP).normalize(), mid = s.floor.clone().add(new THREE.Vector3(0, s.hull.top * 0.5, 0));
      pts.push(s.floor.clone().add(new THREE.Vector3(0, s.hull.top, 0)), mid.clone().addScaledVector(right, s.hull.half), mid.clone().addScaledVector(right, -s.hull.half)); }
    // (a ring of 8, not a cross: seen at 45 degrees a cross would under-measure a wide head by 30 %)
    for (const [dx, dz] of RING) {
      pts.push(c.clone().add(new THREE.Vector3(dx * b.shoulder, -b.shoulderY, dz * b.shoulder)));
      pts.push(c.clone().add(new THREE.Vector3(dx * b.head, 0, dz * b.head)));
    }
  }
  return pts;
}

/** A performer's head half-width, shoulder half-width / drop and chest drop (m, from the face centre): from the face
 *  measure, but never narrower than the body says (face markers that only span the eyes — a bee, a chibi — would
 *  frame the shoulders off). */
export function bodyOf(s: ShotSubject): { head: number; shoulder: number; shoulderY: number; chest: number } {
  const f = s.face.size, h = s.height;
  const head = Math.max(f * 0.62, h * 0.075, Math.min(s.headHalf ?? 0, Math.max(h * 0.5, f * 2.5)));
  return { head, shoulder: Math.max(f * 1.5, h * 0.14, head), shoulderY: Math.max(f * 1.3, h * 0.13), chest: Math.max(f * 1.9, h * 0.2) };
}

export class ShotSolver {
  readonly probe: RoomProbe;
  constructor(readonly room: RoomInfo, readonly rays: RoomRays) { this.probe = new RoomProbe(room); }
  /** The framing guarantee (src/scene/frameGuard.ts installs it): every solved shot passes it before it is used, with
   *  the solver's next-best candidates as fallbacks. */
  static guard: ((solver: ShotSolver, req: ShotRequest, res: ShotResult, alternates: CamPose[]) => ShotResult) | null = null;

  /** Run `fn` with the room parts an engine keeps animating left out of this solver's rays (and put back after). */
  still<T>(fn: () => T): T {
    const a = this.rays.skipMovers, b = this.probe.skipMovers;
    this.rays.skipMovers = true; this.probe.skipMovers = true;
    try { return fn(); } finally { this.rays.skipMovers = a; this.probe.skipMovers = b; }
  }

  solve(req: ShotRequest): ShotResult { return this.still(() => this.solveIn(req)); }
  private solveIn(req: ShotRequest): ShotResult {
    const t0 = performance.now();
    const cands = req.kind === 'talk' ? this.talkCands(req) : this.groupCands(req);
    cands.sort((a, b) => a.pre - b.pre);
    let best: ShotResult | null = null;
    // the authored pose first: kept when it is clean (re-aimed to the real face for talk shots)
    // (every scored candidate, for the framing guarantee's fallbacks: the best ones after the pick, in score order)
    const scored: { pose: CamPose; score: number }[] = [];
    const done = (r: ShotResult) => {
      const alts = scored.filter((x) => x.pose !== r.pose).sort((a, b) => a.score - b.score).map((x) => x.pose);
      // (cheap candidates nobody scored yet are fallbacks too: framing only, the guard re-checks what it uses)
      for (const c of cands) if (alts.length < 6 && c.pose !== r.pose && !alts.includes(c.pose)) alts.push(c.pose);
      const g = ShotSolver.guard && !req.guard?.off ? ShotSolver.guard(this, req, r, alts) : r;
      g.notes.push(`${(performance.now() - t0).toFixed(1)} ms`);
      return g;
    };
    if (req.seed) {
      const seed = req.kind === 'talk' ? this.reaim(req.seed, req) : req.seed;
      const s = this.score(seed, req, 0, 0);
      best = { pose: seed, score: s.score - 1.0, source: 'authored', notes: s.notes };
      scored.push({ pose: seed, score: best.score });
      if (s.score < 1.2) return done(best);
    }
    let n = 0;
    for (const c of cands) {
      if (best && c.pre >= best.score) break;                              // (pre is a lower bound of the full score)
      // a thick wall (front faces on both sides) still between the group and the camera: dolly in until most are seen
      const fixed = c.fix?.();
      let base = c.base ?? c.pre;
      if (fixed) { c.pose = fixed; base += 0.3; c.notes.push('dollied in'); }
      const s = this.score(c.pose, req, c.pulled, c.dyaw);
      const total = s.score + base;
      scored.push({ pose: c.pose, score: total });
      if (!best || total < best.score) best = { pose: c.pose, score: total, source: 'auto', notes: [...c.notes, ...s.notes] };
      // (a candidate COUNT, never a time budget: a cold first solve — BVHs still being built — must pick the same shot as a
      // warm one, and the studio preview, every OBS page and every guest must agree — desert_walker/SPEC.md R3)
      if (best.score < 0.6 || ++n >= (req.kind === 'group' ? 24 : 14)) break;
    }
    const out = best ?? { pose: cands[0]?.pose ?? lookPose(new THREE.Vector3(0, 1.6, 4), new THREE.Vector3(0, 1.2, 0), 35), score: 99, source: 'auto' as const, notes: ['no candidate'] };
    return done(out);
  }

  /** Keep an authored camera's position, aim + zoom so the real face sits where the medium shot wants it. */
  private reaim(p: CamPose, req: ShotRequest): CamPose {
    const s = req.subjects[0];
    if (!s) return p;
    const cam = new THREE.PerspectiveCamera(p.fov, req.aspect, 0.03, 500);
    cam.position.copy(p.position); cam.quaternion.copy(p.quaternion); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    const f = s.face.center.clone().project(cam);
    const dist = s.face.center.distanceTo(p.position);
    const hf = (s.face.size * 1.95) / (2 * dist * Math.tan((p.fov * D2R) / 2));
    const v = (1 - f.y) / 2, u = (f.x + 1) / 2;
    if (f.z < 1 && v > 0.22 && v < 0.5 && u > 0.2 && u < 0.8 && hf > 0.08 && hf < 0.3) return p;
    const height = talkHeight(s);
    const target = talkTarget(s, height);
    const fov = THREE.MathUtils.clamp(2 * Math.atan((height * 0.5) / Math.max(0.3, target.distanceTo(p.position))) / D2R, 12, 60);
    return lookPose(p.position, target, fov);
  }

  private talkCands(req: ShotRequest): Cand[] {
    const s = req.subjects[0];
    const out: Cand[] = [];
    // the framing class's rig (shared/framing.ts RIGS): an elevation range + lens for giants (low hero), mechs (cockpit),
    // fairies (table-top); normal / small keep the classic eye-level grid (exactly the old candidates)
    const rig = req.guard?.rig?.elev ? req.guard.rig : null;
    const fov0 = rig ? rig.lens : 30;
    const body = s.height;
    const height = talkHeight(s);
    const target = talkTarget(s, height);
    const eye = s.face.center.clone().add(new THREE.Vector3(0, s.face.size * 0.15, 0));
    let dist = (height * 0.5) / Math.tan((fov0 * D2R) / 2);
    if (req.aspect < 1) dist /= req.aspect;
    const k = body / 1.5;
    if (rig && rig.elev) {
      // the rig's elevation range: its preferred angle (or the camera height it asks for, clamped into the range) first
      const [lo, hi] = rig.elev;
      let pref = rig.elevPref;
      if (rig.camHeight) pref = THREE.MathUtils.clamp(Math.atan2(s.floor.y + rig.camHeight * s.height - eye.y, dist) / D2R, lo, hi);
      const els = [...new Set([pref, lo, hi, (pref + lo) / 2, (pref + hi) / 2].map((e) => Math.round(e * 10) / 10))];
      const minD = rig.minDist ?? 0.55 * Math.max(0.6, k);
      for (const dyaw of [0, -12, 12, -24, 24, -38, 38, -55, 55]) for (const el of els) {
        const dir = req.prefer.clone().applyAxisAngle(UP, dyaw * D2R);
        const pos = eye.clone().addScaledVector(dir, dist).add(new THREE.Vector3(0, dist * Math.tan(el * D2R), 0));
        const pl = this.pullIn(eye, pos, target, fov0, minD);
        if (!pl) continue;
        const pre = Math.abs(dyaw) / 28 + Math.abs(el - pref) / 12 + (pl.pose.fov - fov0) / 14 + pl.cost;
        out.push({ pose: bustPose(s, pl.pose, req.aspect), pre, pulled: pl.pulled, dyaw, notes: [`rig ${el.toFixed(0)}°`] });
      }
      return out;
    }
    for (const dyaw of [0, -12, 12, -24, 24, -38, 38, -55, 55]) for (const dh of [0, 0.22, -0.1, 0.45, 0.8]) {
      const dir = req.prefer.clone().applyAxisAngle(UP, dyaw * D2R);
      const pos = eye.clone().addScaledVector(dir, dist).add(new THREE.Vector3(0, dh * k, 0));
      const pl = this.pullIn(eye, pos, target, fov0, 0.55 * Math.max(0.6, k));
      if (!pl) continue;
      const pre = Math.abs(dyaw) / 28 + Math.abs(dh) * 1.4 + (pl.pose.fov - fov0) / 14 + pl.cost;
      out.push({ pose: bustPose(s, pl.pose, req.aspect), pre, pulled: pl.pulled, dyaw, notes: [] });
    }
    return out;
  }

  private groupCands(req: ShotRequest): Cand[] {
    const pts = groupPoints(req.subjects);
    const box = new THREE.Box3().setFromPoints(pts);
    const c = box.getCenter(new THREE.Vector3());
    const out: Cand[] = [];
    const fov0 = 34;
    // the distance that fills the safe area at the reference lens (screen-space margins: the same breathing room for a
    // fairy and a giant); from wherever the camera ends up (pulled in front of a wall, dollied past one) the aim + lens
    // are re-fitted exactly (frameFrom): everyone inside the safe area, centred, head tops on the top safe line
    const fovSafe = (2 * Math.atan(Math.tan((fov0 * D2R) / 2) * SAFE.x)) / D2R;
    const frame = (p: THREE.Vector3) => frameFrom(p, pts, req.aspect, { aim: c, minFov: 12, maxFov: 72 });
    for (const dyaw of [0, -12, 12, -24, 24, -36, 36, -50, 50]) for (const el of [8, 16, 3, 26, 38]) {
      const h = req.prefer.clone().applyAxisAngle(UP, dyaw * D2R);
      const dir = h.clone().multiplyScalar(Math.cos(el * D2R)).addScaledVector(UP, Math.sin(el * D2R)).normalize();
      const need = fitDistance(pts, c, dir, fovSafe, req.aspect, 0.04);
      const pos = c.clone().addScaledVector(dir, need);
      // (a group's centre can sit inside furniture — a war table, a DJ booth: walls are found from the CAMERA side,
      // by their backs; furniture in the way is the face-visibility score's business)
      const pl = this.wallIn(pos, c, fov0);
      if (!pl) continue;
      pl.pose = frame(pl.pose.position) ?? pl.pose;
      const fr = this.framing(pl.pose, req);
      // rows: a higher camera sees the back row over the front one — worth it only when there is depth
      const pre = Math.abs(dyaw) / 30 + Math.abs(el - 8) / 30 + Math.max(0, pl.pose.fov - fov0) / 16 + pl.cost + fr.cost;
      // (a thick wall still between them and the camera is fixed lazily, only for the candidates actually scored)
      out.push({ pose: pl.pose, pre, base: pre - fr.cost, pulled: pl.pulled, dyaw, notes: [], fix: () => {
        const dl = this.dollyIn(pl.pose.position, c, req.subjects);
        return dl ? frame(dl) : null;
      } });
    }
    return out;
  }

  /** Move a camera towards `target` (0.4 m steps) until ≥ 70% of the faces' centres are in line of sight; null =
   *  already fine (or nothing better found before 1 m from the target). */
  private dollyIn(pos: THREE.Vector3, target: THREE.Vector3, subs: ShotSubject[]): THREE.Vector3 | null {
    const pick = subs.length <= 5 ? subs : [0, 0.25, 0.5, 0.75, 1].map((k) => subs[Math.round(k * (subs.length - 1))]);
    const seen = (p: THREE.Vector3) => pick.filter((s) => this.rays.clear(p, s.face.center)).length / pick.length;
    if (seen(pos) >= 0.7) return null;
    const dir = target.clone().sub(pos), L = dir.length();
    dir.divideScalar(L);
    for (let d = 0.5; d < L - 1; d += 0.5) {
      const p = pos.clone().addScaledVector(dir, d);
      if (seen(p) >= 0.7 && !this.probe.inside(p)) return p;
    }
    return null;
  }

  /** Walk the camera in from outside the set: while the first surface towards the target is the BACK of a big
   *  single-sided surface (a wall seen from outside), step in past it. */
  private wallIn(pos: THREE.Vector3, target: THREE.Vector3, fov: number): { pose: CamPose; pulled: number; cost: number } | null {
    const p = pos.clone();
    const len0 = pos.distanceTo(target);
    for (let k = 0; k < 3; k++) {
      const to = target.clone().sub(p), L = to.length();
      if (L < 0.6) return null;
      to.divideScalar(L);
      const h = this.probe.first(p, to, L - 0.3);
      if (!h || !h.back || h.area < 0.3) break;
      p.addScaledVector(to, h.d + 0.25);
    }
    const len = p.distanceTo(target);
    if (len < 0.8) return null;
    const f = Math.min(72, 2 * Math.atan(Math.tan((fov * D2R) / 2) * (len0 / len)) / D2R);
    return { pose: lookPose(p, target, f), pulled: len0 - len, cost: len < 1.5 ? 2 : 0 };
  }

  /** Pull the camera in front of the first wall between the subject and it; widen the lens to keep the framing. */
  private pullIn(from: THREE.Vector3, pos: THREE.Vector3, target: THREE.Vector3, fov: number, minDist: number): { pose: CamPose; pulled: number; cost: number } | null {
    const dir = pos.clone().sub(from);
    const len = dir.length();
    let p = pos, f = fov, pulled = 0, cost = 0;
    if (len > 1e-4) {
      dir.divideScalar(len);
      const d = this.rays.hit(from, pos, 0.2);
      if (d !== Infinity) {
        const dd = Math.max(0.3, d - 0.18);
        if (dd < 0.3) return null;
        if (dd < minDist) cost = 1.5 + (minDist - dd) * 6;                  // (kept, but costs: a lens this close distorts)
        p = from.clone().addScaledVector(dir, dd);
        f = Math.min(72, 2 * Math.atan(Math.tan((fov * D2R) / 2) * (len / dd)) / D2R);
        pulled = len - dd;
      }
    }
    return { pose: lookPose(p, target, f), pulled, cost };
  }

  /** Group framing from the pose alone (no rays — also a candidate's lower bound): everyone's head + shoulders inside
   *  the safe area, the group centred, and tight — the smallest face as big as the room allows (among candidates that
   *  all fit everyone, the direction that shows the group most compactly wins). */
  framing(pose: CamPose, req: ShotRequest): { cost: number; notes: string[] } {
    if (req.kind !== 'group' || !req.subjects.length) return { cost: 0, notes: [] };
    const cam = new THREE.PerspectiveCamera(pose.fov, req.aspect, 0.03, 500);
    cam.position.copy(pose.position); cam.quaternion.copy(pose.quaternion); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    const P = pose.position;
    const right = new THREE.Vector3().crossVectors(cam.getWorldDirection(new THREE.Vector3()), UP).normalize();
    const vt = Math.tan((pose.fov * D2R) / 2);
    const notes: string[] = [];
    let sx = 0, edge = 0, minHf = Infinity, n = 0;
    for (const s of req.subjects) {
      const f = s.face.center.clone().project(cam);
      if (f.z > 1) continue;
      n++; sx += f.x;
      const d = Math.max(0.3, s.face.center.distanceTo(P));
      // head + shoulders (bodyOf) against the side safe lines
      const b = bodyOf(s);
      for (const [dx, dy, k] of [[-b.head, 0, 12], [b.head, 0, 12], [-b.shoulder, -b.shoulderY, 6], [b.shoulder, -b.shoulderY, 6]]) {
        const q = s.face.center.clone().addScaledVector(right, dx).add(new THREE.Vector3(0, dy, 0)).project(cam);
        edge += Math.max(0, Math.abs(q.x) - SAFE.x) * k;
      }
      const top = s.face.center.clone().add(new THREE.Vector3(0, headTop(s), 0)).project(cam);
      edge += (Math.max(0, top.y - SAFE.top) + Math.max(0, -0.75 - f.y)) * 8;
      minHf = Math.min(minHf, Math.max(s.face.size * 1.95, s.height * 0.13) / (2 * d * vt));
    }
    let cost = 0;
    if (edge > 0.02) { cost += edge; notes.push(`near the edge ${edge.toFixed(2)}`); }
    const off = n ? Math.abs(sx / n) : 0;
    if (n > 1 && off > 0.15) { cost += (off - 0.15) * 4; notes.push(`off-centre ${off.toFixed(2)}`); }
    // tight: the smallest face ≈ 8 % of the frame height for 2–4 people (5 % for a crowd) is the goal
    const want = n <= 4 ? 0.08 : n <= 8 ? 0.05 : 0.035;
    if (minHf < want) { cost += (want - minHf) * 25; notes.push(`small ${(minHf * 100).toFixed(1)}%`); }
    return { cost, notes };
  }

  /** Full score of a pose (rays + the group framing). */
  score(pose: CamPose, req: ShotRequest, pulled: number, dyaw: number): { score: number; notes: string[] } { return this.still(() => this.scoreIn(pose, req, pulled, dyaw)); }
  private scoreIn(pose: CamPose, req: ShotRequest, pulled: number, dyaw: number): { score: number; notes: string[] } {
    void pulled; void dyaw;
    const cam = new THREE.PerspectiveCamera(pose.fov, req.aspect, 0.03, 500);
    cam.position.copy(pose.position); cam.quaternion.copy(pose.quaternion); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    const P = pose.position;
    const notes: string[] = [];
    let sc = 0;
    const right = new THREE.Vector3().crossVectors(cam.getWorldDirection(new THREE.Vector3()), UP).normalize();
    const all = [...req.subjects, ...req.others];
    const w = req.kind === 'talk' ? 2 : 1;
    for (const s of req.subjects) {
      // in frame (face top … chin, with a little margin)
      const top = s.face.center.clone().add(new THREE.Vector3(0, Math.max(s.face.size * 1.1, headTop(s) * 0.85), 0)).project(cam);
      const chin = s.face.center.clone().add(new THREE.Vector3(0, -s.face.size * 0.8, 0)).project(cam);
      const l = s.face.center.clone().addScaledVector(right, -s.face.size * 0.6).project(cam), r = s.face.center.clone().addScaledVector(right, s.face.size * 0.6).project(cam);
      if (top.z > 1 || chin.z > 1 || top.y > 0.98 || chin.y < -0.98 || l.x < -0.98 || r.x > 0.98) { sc += 8 * w; notes.push(`${s.key} out of frame`); continue; }
      // hidden: 5 points (eyes, both cheeks, forehead, mouth) by the room (renderer culling: RoomRays uses each
      // material's side) or anyone else
      let hid = 0;
      for (const [x, y] of [[0, 0], [-0.35, 0], [0.35, 0], [0, 0.35], [0, -0.35]]) {
        const q = onFaceSurface(s.face.center.clone().addScaledVector(right, x * s.face.size).add(new THREE.Vector3(0, y * s.face.size, 0)), P, s.depth ?? 0, s.forward);
        if (!this.rays.clear(P, q) || all.some((o) => o !== s && hitsPerson(P, q, o))) hid++;
      }
      if (hid) { sc += 1.4 * hid * w; notes.push(`${s.key} hidden ${hid}/5`); }
      // seen from the front?
      const toCam = P.clone().sub(s.face.center).setY(0).normalize();
      const ang = Math.acos(THREE.MathUtils.clamp(s.forward.dot(toCam), -1, 1)) / D2R;
      if (ang > 55) sc += ((ang - 55) / 25) * w;
      if (ang > 100) { sc += 4 * w; notes.push(`${s.key} from behind`); }
    }
    if (req.kind === 'group') { const fr = this.framing(pose, req); sc += fr.cost; notes.push(...fr.notes); }
    // talk: a neighbour's face half cut by the frame edge looks like a mistake — fully in or out
    if (req.kind === 'talk') for (const o of req.others) {
      const c = o.face.center.clone().project(cam);
      if (c.z > 1 || Math.abs(c.y) > 1.1) continue;
      const half = (o.face.size * 0.7) / Math.max(0.3, o.face.center.distanceTo(P)) / Math.tan((pose.fov * D2R) / 2) / req.aspect;
      if (Math.abs(c.x) < 1 + half && Math.abs(c.x) > 1 - half) sc += 0.8;
    }
    // the set: camera behind a wall / inside something
    if (this.probe.inside(P)) { sc += 20; notes.push('inside geometry'); }
    // never inside / right against a performer (someone at the edge of a group, a giant)
    for (const o of all) {
      const r = Math.max(0.45, o.face.size * 2.2), oc = o.head ?? o.face.center;
      if (Math.hypot(P.x - oc.x, P.z - oc.z) < r && P.y < oc.y + o.face.size * 2 && P.y > o.floor.y) { sc += 15; notes.push(`in ${o.key}`); break; }
    }
    const out = this.probe.outside(P, 5);
    if (out >= 2) { sc += out * 1.6; notes.push(`outside the set (${out})`); }
    // 5×3 view rays (edges included): leaving the set sideways / down = void; something right in front of the lens = clutter
    let open = 0, near = 0;
    for (const v of [0.04, 0.5, 0.96]) for (const u of [0.03, 0.27, 0.5, 0.73, 0.97]) {       // (edges: void hides in corners)
      const d = new THREE.Vector3(u * 2 - 1, 1 - v * 2, 0.5).unproject(cam).sub(P).normalize();
      const far = P.clone().addScaledVector(d, 60);
      const h = this.rays.hit(P, far, 0.02);
      if (h === Infinity) { if (!req.voidOk && (!req.skyOk || d.y < -0.35)) open++; }   // (outdoors the environment draws the horizon)
      else if (h < 0.35) near++;
    }
    if (open) { sc += open * 1.2; notes.push(`open ${open}/15`); }
    if (near) { sc += near * 0.8; notes.push(`clutter ${near}/15`); }
    return { score: sc, notes };
  }
}

/** scene.json `cams` (glTF space, no GLB re-export needed): `{ "CAM_X": { "pos": [x,y,z], "target": [x,y,z], "fov": 35 },
 *  "SPOT_03_CAM": {…}, "SPOT_09_CAM": null }` — adds / replaces presets and talk cameras; null removes an authored one
 *  (that spot then gets the automatic talk framing). Returns the names applied. */
export function applySceneCams(room: RoomInfo, cams: unknown): string[] {
  if (!cams || typeof cams !== 'object' || Array.isArray(cams)) return [];
  const done: string[] = [];
  const v3 = (a: unknown) => (Array.isArray(a) && a.length === 3 && a.every((x) => typeof x === 'number' && Number.isFinite(x)) ? new THREE.Vector3(a[0], a[1], a[2]) : null);
  for (const [name, raw] of Object.entries(cams as Record<string, unknown>)) {
    const sm = /^SPOT_(\d{1,2})_CAM$/.exec(name);
    if (!sm && !/^CAM_[A-Z0-9_]+$/.test(name)) continue;
    let preset: { name: string; position: THREE.Vector3; quaternion: THREE.Quaternion; fov: number } | null = null;
    if (raw && typeof raw === 'object') {
      const r = raw as { pos?: unknown; target?: unknown; fov?: unknown };
      const p = v3(r.pos), t = v3(r.target);
      if (!p || !t || p.distanceTo(t) < 1e-3) continue;
      const wp = room.root.localToWorld(p.clone()), wt = room.root.localToWorld(t.clone());
      const fov = typeof r.fov === 'number' && r.fov > 5 && r.fov < 120 ? r.fov : 35;
      const lp = lookPose(wp, wt, fov);
      preset = { name, position: lp.position, quaternion: lp.quaternion, fov };
    } else if (raw !== null) continue;
    if (sm) {
      const s = room.spots[+sm[1] - 1];
      if (!s) continue;
      s.cam = preset;
    } else if (preset) room.cameras.set(name, preset);
    else room.cameras.delete(name);
    done.push(name);
  }
  return done;
}
