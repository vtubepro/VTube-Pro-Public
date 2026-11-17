// Camera framing guarantee (docs/SCENES.md "Framing guarantee"; the pure contract is shared/framing.ts).
//
// Every solved shot that frames people (talk / group / wide, the interview book, gaming tile cams, the solo React two-shot,
// the TTRPG table's close-ups) gets a post-solve check: is every framed face box (and its head top) inside the family's
// safe area, with the room's motion envelope taken off the edges? If not, the shot is re-solved, in this order, and the
// first that passes is used:
//   1. refit the aim + lens from the SAME position (exact: the smallest change that fits; never zooms in);
//   2. the lens hit its limit: dolly back (rig step, up to the rig's reach) along the view line, then along it 8° higher,
//      only where the path is clear, the camera isn't inside / behind anything and every face is still in sight; refit;
//   3. the solver's next candidates, the room's wide camera (CAM_WIDE) and a synthetic front-on shot from the subjects'
//      facing at the rig's elevation (pulled in front of walls) — each refit as it stands first (one pose test each);
//   4. the same position raised in steps under the ceiling (over a giant / a hull in the way), re-aimed;
//   5. the step-3 fallbacks dollied back (step 2 on each);
//   6. a ring search round the framed faces (needs rays): 24 bearings x 4 distances x 5 heights, nearest the solved view
//      first (every 45° round first, then the fine steps; never from behind them), screened without rays, the first clean
//      one — a giant's face behind a hanging sign from everything above is seen from further round / lower down.
// Count-bounded, never timed (desert_walker/SPEC.md R3: a cold first solve must pick the same shot as a warm one, a slow
// page the same as a fast one): every step frames without rays first, tests each pose's quality cheapest-first and at
// most once, and the whole ladder stops at its ray budget (ladderBudget: LADDER_RAYS for one face, more per extra face).
// Only settled positions. Nothing passes: the least-bad candidate (its notes say so).
//
// LiveGuard: the drift guard on top of the settled camera. Live heads move (a performer leans out of a tight talk
// shot, a giant stands up). No timers (desert_walker/SPEC.md R4: hold / release timers make pages diverge on network
// jitter): the aim (≤ 6°) and zoom (≤ ×1.18) correction is a smooth function of how far a framed face is past the safe
// area as seen from the rig's own pose (0 inside the fix area, in full at the evaluation line), eased by one critically
// damped filter (ω 4, exact for any frame rate). Off while the OBS hole is open, in React, during moves / director
// shots. The same tracking in gives the same camera out on every page: a late or dropped sample only delays it.
import * as THREE from 'three';
import { lookPose, type CamPose } from './cameraRig.ts';
import { RoomProbe, ShotSolver, frameFrom, type ShotRequest, type ShotResult, type ShotSubject } from './shotSolver.ts';
import type { RoomRays } from './twoShot.ts';
import { FACE_BOX, FIX_SAFE, LIVE_DEFAULT, RIGS, dampStep, liveWeight, motionInset, rigFor, safeFor, type FramingClass, type LiveSettings, type MotionEnvelope, type RigPreset, type SafeArea, type ShotFamily } from '../../shared/framing.ts';
import { onFaceSurface } from './faceDepth.ts';

const UP = new THREE.Vector3(0, 1, 0);
const D2R = Math.PI / 180;

/** A framed head: face centre + size, head top above the face centre, head half-width (m), facing (horizontal unit). */
export interface GuardTarget { key: string; face: { center: THREE.Vector3; size: number }; top: number; half?: number; forward?: THREE.Vector3;
  /** The drawn face surface in front of the centre, m (src/scene/faceDepth.ts): line-of-sight tests aim at it. */
  depth?: number }

export interface GuardRequest {
  family: ShotFamily;
  /** The pose is a room's own camera (a studio pedestal / PTZ: its body a few cm BEHIND the lens): only surfaces in
   *  front of the lens count for the lens check at that exact position. Off = the lens check in every direction (the
   *  default; a looser check everywhere let the re-solve ladder test far more candidates and run out of budget). */
  lensBehindOk?: THREE.Vector3;
  targets: GuardTarget[];
  aspect: number;
  /** Points that must be in the frame too (a monitor's picture corners, the React screen's corners). */
  hard?: THREE.Vector3[];
  /** People who can stand between a new camera position and a face (head sphere + torso box). */
  blockers?: ShotSubject[];
  motion?: MotionEnvelope | null;
  rig?: RigPreset;
  /** The next-best candidates of the solver (step 3), best first. */
  alternates?: CamPose[];
  /** The room's wide camera (step 4). */
  wide?: CamPose | null;
  /** Horizontal direction subject → camera for the synthetic shot (default: the mean of `facing`, else +Z). */
  front?: THREE.Vector3 | null;
  facing?: THREE.Vector3[];
  /** Lens limits (deg). */
  minFov?: number;
  maxFov?: number;
  /** Override the family's safe area (scene.json framing.safe: SafeArea from shared/framing.ts safeFor). */
  safe?: SafeArea;
  /** The safe area the hard points must stay in (default: the family's, a little looser). The monitor's picture in a
   *  two-shot: the family's own. */
  hardSafe?: SafeArea;
  /** Soft points (a mech's hull in a group shot): kept in the frame when the lens allows, never a reason to fail. */
  soft?: THREE.Vector3[];
  /** Shot quality the frame must keep too (needs rays): at least this share of every framed face's 5 points in plain
   *  view (room + people), the camera at most `away` degrees off a framed face's facing (never the back of a head), and
   *  never inside anyone. Unset = framing only. */
  see?: number;
  away?: number;
  /** Everyone on the set (targets included, same keys): who can hide a face or swallow the camera. Default: blockers. */
  people?: ShotSubject[];
  /** View rays that meet nothing (the frame shows void): 'none' = an indoor room, any open ray spoils the shot; 'sky' =
   *  an engine draws sky / horizon, only steep looks down count; 'all' / unset = not checked (a space / void room). */
  openOk?: 'none' | 'sky' | 'all';
  /** The ladder's ray budget (default LADDER_RAYS). */
  rayBudget?: number;
}

export interface GuardVerdict { ok: boolean; worst: number; out: string[] }
export type GuardStep = 'ok' | 'refit' | 'dolly' | 'alternate' | 'wide' | 'rise' | 'front' | 'search' | 'best-effort';
/** `clean` = the pose passes the framing AND the shot quality asked for (false: the solver's own view, its framing
 *  fixed, or a best effort — a caller with a better fallback of its own should use that). */
export interface GuardResult { pose: CamPose; step: GuardStep; verdict: GuardVerdict; notes: string[]; clean: boolean }

/** The face points a shot must see (the same 9 as src/scene/camEval.ts). */
const FACE_PTS: [number, number][] = [[0, 0], [-0.35, 0], [0.35, 0], [0, 0.4], [0, -0.35], [-0.25, 0.25], [0.25, 0.25], [-0.25, -0.2], [0.25, -0.2]];

/** A guarded camera keeps this far from every room surface (m): the scene camera's near plane (0.03 m) must never cut into
 *  geometry (the inside of a beam shows as void). */
const LENS_CLEAR = 0.07;

/** The steepest a shot that must SEE faces may look up at one (deg): from further under, the chin / a mascot's collar
 *  covers the face. */
const MAX_LOOK_UP = 42;

/** The ray budget of one guard ladder (RoomRays.hit + RoomProbe.first calls; desert_walker/SPEC.md R3: count-bounded,
 *  never timed): LADDER_RAYS for one framed face, LADDER_RAYS_PER_FACE more for each further face (every pose test of
 *  a group costs that many more rays), at most LADDER_RAYS_MAX. A shot that is fine as solved costs one quality test
 *  (44 for one face indoors); a ladder that finds nothing clean stops at its budget and keeps the best framing found. */
export const LADDER_RAYS = 1000, LADDER_RAYS_PER_FACE = 400, LADDER_RAYS_MAX = 2200;
export function ladderBudget(faces: number): number { return Math.min(LADDER_RAYS_MAX, LADDER_RAYS + LADDER_RAYS_PER_FACE * Math.max(0, faces - 1)); }

/** The leans a live head makes off its settled estimate (face sizes × 0.4: left, right, slumped, lifted) and the face
 *  points (FACE_PTS indices) that lead each one behind a prop: the whole leading column / row. */
const LEANS: { o: [number, number]; pts: number[] }[] = [{ o: [-1, 0], pts: [1, 5, 7] }, { o: [1, 0], pts: [2, 6, 8] }, { o: [0, -0.8], pts: [4, 7, 8] }, { o: [0, 0.5], pts: [3, 5, 6] }];

/** How far round a framed face a camera is (deg off its facing) and how steeply it looks up at it (deg). No rays. */
function geomOf(P: THREE.Vector3, t: GuardTarget): { away: number; below: number } {
  let away = 0;
  if (t.forward) {
    const to = P.clone().sub(t.face.center).setY(0), f = t.forward.clone().setY(0);
    if (to.lengthSq() > 1e-8 && f.lengthSq() > 1e-8) away = Math.acos(THREE.MathUtils.clamp(f.normalize().dot(to.normalize()), -1, 1)) / D2R;
  }
  const below = Math.atan2(t.face.center.y - P.y, Math.max(1e-6, Math.hypot(P.x - t.face.center.x, P.z - t.face.center.z))) / D2R;
  return { away, below };
}
/** A pose as a memo key (0.1 mm, 1e-5, 0.001°). */
function poseKey(p: CamPose): string {
  const a = p.position, q = p.quaternion;
  return `${Math.round(a.x * 1e4)},${Math.round(a.y * 1e4)},${Math.round(a.z * 1e4)},${Math.round(q.x * 1e5)},${Math.round(q.y * 1e5)},${Math.round(q.z * 1e5)},${Math.round(q.w * 1e5)},${Math.round(p.fov * 1e3)}`;
}

/** Overflow at or under this (NDC) counts as inside (rounding of the iterated re-aim). */
const EPS = 0.004;

/** The guard's per-point limits: x in [-lx, lx], y in [-lb, lt] (NDC), after the motion inset. */
/** `d` = depth slack (m): a live head can lean this much nearer the lens than its rest pose (the box grows). */
interface GPoint { p: THREE.Vector3; lx: number; lt: number; lb: number; key: string; d?: number }

function camOf(pose: CamPose, aspect: number): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(pose.fov, aspect, 0.03, 5000);
  c.position.copy(pose.position); c.quaternion.copy(pose.quaternion); c.updateMatrixWorld(); c.updateProjectionMatrix();
  return c;
}

/** The guard points of a request, with their limits (before the motion inset, which depends on the pose). */
function guardPoints(req: GuardRequest, right: THREE.Vector3, soft = false): GPoint[] {
  const s = req.safe ?? FIX_SAFE[req.family];
  const out: GPoint[] = [];
  for (const t of req.targets) {
    const c = t.face.center, f = t.face.size;
    const dz = Math.max(0.06, f * 0.4);
    const side = right.clone().multiplyScalar(f * FACE_BOX.side);
    // the face box (cheeks, forehead, chin) against the face limits; the head top (hair, ears) against the head line;
    // the head's sides (a mascot head, big hair) against the side line
    out.push({ p: c.clone().add(side), lx: s.x, lt: s.top, lb: s.bottom, key: t.key, d: dz });
    out.push({ p: c.clone().sub(side), lx: s.x, lt: s.top, lb: s.bottom, key: t.key, d: dz });
    out.push({ p: c.clone().addScaledVector(UP, f * FACE_BOX.up), lx: s.x, lt: s.top, lb: s.bottom, key: t.key, d: dz });
    out.push({ p: c.clone().addScaledVector(UP, -f * FACE_BOX.down), lx: s.x, lt: s.top, lb: s.bottom, key: t.key, d: dz });
    const top = Math.max(f * FACE_BOX.up, t.top);
    if (top > f * FACE_BOX.up + 1e-4) out.push({ p: c.clone().addScaledVector(UP, top), lx: Math.min(1, s.x + 0.06), lt: s.head, lb: s.bottom, key: t.key, d: dz });
    const half = t.half ?? 0;
    if (half > f * FACE_BOX.side + 1e-4) {
      const hs = right.clone().multiplyScalar(half);
      const lx = Math.min(1, s.x + 0.07);
      out.push({ p: c.clone().add(hs), lx, lt: s.head, lb: s.bottom, key: t.key, d: dz }, { p: c.clone().sub(hs), lx, lt: s.head, lb: s.bottom, key: t.key, d: dz });
    }
  }
  const hs = req.hardSafe;
  for (const p of req.hard ?? []) out.push(hs ? { p: p.clone(), lx: hs.x, lt: hs.top, lb: hs.bottom, key: '#hard' } : { p: p.clone(), lx: Math.min(0.97, s.x + 0.08), lt: Math.min(0.97, s.head), lb: Math.min(0.97, s.bottom + 0.06), key: '#hard' });
  if (soft) for (const p of req.soft ?? []) out.push({ p: p.clone(), lx: Math.min(0.97, s.x + 0.1), lt: 0.97, lb: 0.97, key: '#soft' });
  return out;
}

export class FrameGuard {
  /** Optional: the framing class of a performer the runtime knows better (the forms engine's occupant class). */
  static classHook: ((key: string) => FramingClass | null) | null = null;
  /** Kill switch for the whole guarantee on this page (tests: before / after comparisons; a safety valve). */
  static off = false;
  /** Page-wide ladder statistics (the acceptance harness reads them): ladders run, the most ray tests one used, the
   *  longest one took (ms — measured for the report only, never a reason to stop: R3), ladders that hit the budget. */
  static stats = { ladders: 0, raysMax: 0, raysSum: 0, msMax: 0, msSum: 0, capped: 0 };
  /** Test pages only (camEval setGuardBudget): the ray budget times this — what a bigger budget would have found. */
  static budgetMul = 1;

  /** rays / probe may be null for pure projection work (check / refit): the live guard. */
  constructor(readonly rays: RoomRays | null, readonly probe: RoomProbe | null) {}

  /** Projected overflow of every guard point (0 = all inside). */
  check(pose: CamPose, req: GuardRequest): GuardVerdict {
    const cam = camOf(pose, req.aspect);
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
    const pts = guardPoints(req, right);
    let worst = 0;
    const out = new Set<string>();
    const v = new THREE.Vector3();
    for (const g of pts) {
      // (a live head leaning nearer: the point moved towards the lens by its depth slack, which only ever grows the box)
      const pp = g.d ? g.p.clone().addScaledVector(pose.position.clone().sub(g.p).normalize(), g.d) : g.p;
      const depth = pp.clone().sub(pose.position).dot(fwd);
      v.copy(pp).project(cam);
      let o: number;
      if (depth < 0.02 || v.z > 1) o = 2;
      else {
        const ins = motionInset(req.motion, depth, pose.fov, req.aspect, v.x, v.y);
        o = Math.max(0, Math.abs(v.x) - (g.lx - ins.x), v.y - (g.lt - ins.y), -(g.lb - ins.y) - v.y);
      }
      if (o > EPS) out.add(g.key);
      worst = Math.max(worst, o);
    }
    return { ok: worst <= EPS, worst, out: [...out] };
  }

  /** From a FIXED position: the smallest change of aim + lens that puts every guard point inside its limits (keeps the
   *  aim and lens when they already fit; never narrows the lens). null = a point behind the camera. `clamped` = the
   *  lens would have to go past maxFov (the result then is at maxFov and may still overflow). */
  refit(pose: CamPose, req: GuardRequest): { pose: CamPose; clamped: boolean } | null {
    // (soft points first: the mech's whole hull in the group shot when the lens allows; else without them)
    if (req.soft?.length) { const r = this.refitWith(pose, req, true); if (r && !r.clamped) return r; }
    return this.refitWith(pose, req, false);
  }
  private refitWith(pose: CamPose, req: GuardRequest, soft: boolean): { pose: CamPose; clamped: boolean } | null {
    const maxFov = req.maxFov ?? req.rig?.maxLens ?? 72, minFov = req.minFov ?? 6;
    let aim = pose.position.clone().add(new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion));
    let T = Math.tan((Math.max(minFov, pose.fov) * D2R) / 2);
    const T0 = T;
    const Tmax = Math.tan((maxFov * D2R) / 2);
    const fwd = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3(), r = new THREE.Vector3();
    let clamped = false;
    for (let it = 0; it < 6; it++) {
      fwd.copy(aim).sub(pose.position).normalize();
      if (Math.abs(fwd.y) > 0.985) return null;
      right.crossVectors(fwd, UP).normalize();
      up.crossVectors(right, fwd).normalize();
      const pts = guardPoints(req, right, soft);
      // tangent-plane coordinates of each point in the current basis
      const tp = pts.map((g) => {
        r.copy(g.p).sub(pose.position);
        const z = r.dot(fwd), ze = Math.max(0.05, z - (g.d ?? 0));       // (the depth slack: a nearer head)
        return { z, x: r.dot(right) / Math.max(1e-6, ze), y: r.dot(up) / Math.max(1e-6, ze), g };
      });
      if (tp.some((q) => q.z < 0.05)) return null;
      // limits with the motion inset (measured at the current lens, conservative for a wider one)
      const fovNow = (2 * Math.atan(T)) / D2R;
      const lim = tp.map((q) => {
        const ins = motionInset(req.motion, q.z, fovNow, req.aspect, q.x / (T * req.aspect), q.y / T);
        return { lx: Math.max(0.05, q.g.lx - ins.x), lt: Math.max(0.05, q.g.lt - ins.y), lb: Math.max(0.05, q.g.lb - ins.y) };
      });
      // feasible aim offsets (cx, cy) for a lens T: every point inside its limits
      const feas = (t: number) => {
        let ax = -Infinity, bx = Infinity, ay = -Infinity, by = Infinity;
        tp.forEach((q, i) => {
          const L = lim[i];
          ax = Math.max(ax, q.x - L.lx * t * req.aspect); bx = Math.min(bx, q.x + L.lx * t * req.aspect);
          ay = Math.max(ay, q.y - L.lt * t); by = Math.min(by, q.y + L.lb * t);
        });
        return { ax, bx, ay, by, ok: ax <= bx && ay <= by };
      };
      let t = T;
      if (!feas(t).ok) {
        let lo = t, hi = Math.max(t * 1.05, 0.02);
        while (!feas(hi).ok && hi < Tmax * 4) hi *= 1.4;
        for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (feas(m).ok) hi = m; else lo = m; }
        t = hi * 1.002;
      }
      if (t > Tmax) { clamped = true; t = Tmax; }
      const F = feas(t);
      // keep the current aim when it fits: the smallest shift otherwise (clamped: the middle of what's left)
      const cx = F.ok ? THREE.MathUtils.clamp(0, F.ax, F.bx) : (F.ax + F.bx) / 2;
      const cy = F.ok ? THREE.MathUtils.clamp(0, F.ay, F.by) : (F.ay + F.by) / 2;
      T = Math.max(T, t);
      if (Math.abs(cx) < 1e-5 && Math.abs(cy) < 1e-5) break;
      const reach = Math.max(0.5, aim.distanceTo(pose.position));
      aim = pose.position.clone().addScaledVector(fwd.clone().addScaledVector(right, cx).addScaledVector(up, cy).normalize(), reach);
    }
    const fov = THREE.MathUtils.clamp((2 * Math.atan(T)) / D2R, minFov, maxFov);
    void T0;
    return { pose: lookPose(pose.position, aim, fov), clamped };
  }

  // ---------------------------------------------------------------- the ray budget (desert_walker/SPEC.md R3)
  /** The ladder running now (guard()): ray tests (RoomRays.hit + RoomProbe.first) counted from its start, its cap, and
   *  each pose's quality verdict (a pose is never ray-tested twice in one ladder). */
  private run: { start: number; cap: number; q: Map<string, boolean>; los: Map<string, boolean> } | null = null;
  /** Line of sight from a camera position to a face point (clear glass doesn't hide a face; only the first 1 cm in front
   *  of the lens is skipped), memoised for the running ladder (the usable test and the quality test share rays). */
  private see(P: THREE.Vector3, q: THREE.Vector3): boolean {
    const k = this.run ? `${Math.round(P.x * 1e4)},${Math.round(P.y * 1e4)},${Math.round(P.z * 1e4)}>${Math.round(q.x * 1e4)},${Math.round(q.y * 1e4)},${Math.round(q.z * 1e4)}` : '';
    const m = this.run?.los.get(k);
    if (m !== undefined) return m;
    const v = this.rays!.hit(P, q, 0.01, true) === Infinity;
    this.run?.los.set(k, v);
    return v;
  }
  private rayCount(): number { return (this.rays?.count ?? 0) + (this.probe?.count ?? 0); }
  /** Ray tests the running ladder has spent so far (0 outside guard()). */
  get spent(): number { return this.run ? this.rayCount() - this.run.start : 0; }
  /** The running ladder has used its whole ray budget: no step after this casts a ray. */
  private broke(): boolean { return !!this.run && this.rayCount() - this.run.start >= this.run.cap; }
  /** Ray tests of the last finished ladder (debug / tests / the acceptance harness). */
  lastSpent = 0;

  /** Shot quality from a pose (see GuardRequest.see / away), in full (the least-bad pick, tests): the worst framed face's
   *  share of points in view (at rest and leaned), the worst angle off a face's facing, whether the camera is inside
   *  someone, open (void) view rays, clutter at the lens (9 = the lens against a surface), how steeply it looks up. */
  quality(pose: CamPose, req: GuardRequest): { seen: number; away: number; inside: string | null; open: number; near: number; below: number } {
    const P = pose.position;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
    const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
    const people = req.people ?? req.blockers ?? [];
    let seen = 1, away = 0, inside: string | null = null, below = -90;
    for (const t of req.targets) {
      if (this.rays) seen = Math.min(seen, this.faceSeen(P, t, right, people, 0));
      const g = geomOf(P, t);
      away = Math.max(away, g.away); below = Math.max(below, g.below);
    }
    for (const b of people) if (insidePerson(P, b)) { inside = b.key; break; }
    let near = 0, open = 0;
    if (this.probe && (req.see !== undefined || req.people)) {
      if (this.lensBlocked(pose, req)) near = 9;
      else near = this.nearHits(pose, req, 9);
    }
    if (this.probe && (req.openOk === 'none' || req.openOk === 'sky')) open = this.openRays(pose, req, 15);
    return { seen, away, inside, open, near, below };
  }

  /** The same verdict as quality() against the request's limits, cheapest first and stopping at the first failure (the
   *  ladder's test of every pose it tries); memoised per pose for the running ladder. */
  private qualityOk(pose: CamPose, req: GuardRequest): boolean {
    if (req.see === undefined && req.away === undefined && !req.people && (req.openOk === undefined || req.openOk === 'all')) return true;
    const key = this.run ? poseKey(pose) : '';
    const hit = this.run?.q.get(key);
    if (hit !== undefined) return hit;
    const v = this.qualityTest(pose, req);
    this.run?.q.set(key, v);
    return v;
  }
  private qualityTest(pose: CamPose, req: GuardRequest): boolean {
    const P = pose.position;
    const people = req.people ?? req.blockers ?? [];
    // (no rays: inside someone, too far round a face, looking up under a chin)
    if (people.some((b) => insidePerson(P, b))) return false;
    for (const t of req.targets) {
      const g = geomOf(P, t);
      if (req.away !== undefined && g.away > req.away) return false;
      if (req.see !== undefined && g.below > MAX_LOOK_UP) return false;
    }
    if (this.probe && (req.see !== undefined || req.people) && this.lensBlocked(pose, req)) return false;
    if (this.rays && req.see !== undefined) {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
      const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
      for (const t of req.targets) if (this.faceSeen(P, t, right, people, req.see) < req.see - 1e-9) return false;
    }
    if (this.probe && (req.see !== undefined || req.people) && this.nearHits(pose, req, 3) >= 3) return false;
    if (this.probe && (req.openOk === 'none' || req.openOk === 'sky') && this.openRays(pose, req, 1) > 0) return false;
    return true;
  }

  /** A framed face's share of its 9 points in plain view (room + people), the worst of the face at rest and leaned 0.4
   *  face sizes left / right / down / up (a live head drifts that far off its settled estimate: a face right at the edge
   *  of a prop is one lean away from hidden). A lean re-tests only the 3 points that lead it (the ones that go behind a
   *  prop first). `stopBelow` > 0: returns as soon as the share is known to be under it. */
  private faceSeen(P: THREE.Vector3, t: GuardTarget, right: THREE.Vector3, people: ShotSubject[], stopBelow: number): number {
    const s = t.face.size, lean = Math.max(0.05, s * 0.4);
    const vis = (c: THREE.Vector3, x: number, y: number) => {
      const q = onFaceSurface(c.clone().addScaledVector(right, x * s).addScaledVector(UP, y * s), P, t.depth ?? 0, t.forward);
      // (a surface a few cm in front of the lens hides everything: only the first 1 cm is skipped here, not the solver's 5 cm)
      return !people.some((b) => b.key !== t.key && blocks(P, q, b)) && this.see(P, q);
    };
    const N = FACE_PTS.length, maxHidden = stopBelow > 0 ? Math.floor(N * (1 - stopBelow) + 1e-9) : N;
    const at: boolean[] = [];
    let hidden = 0;
    for (const [x, y] of FACE_PTS) {
      const v = vis(t.face.center, x, y);
      at.push(v);
      if (!v && ++hidden > maxHidden) return (N - hidden) / N;
    }
    let seen = (N - hidden) / N;
    for (const L of LEANS) {
      const c = t.face.center.clone().addScaledVector(right, L.o[0] * lean).addScaledVector(UP, L.o[1] * lean);
      let lost = 0;
      for (const i of L.pts) if (at[i] && !vis(c, FACE_PTS[i][0], FACE_PTS[i][1])) lost++;
      seen = Math.min(seen, (N - hidden - lost) / N);
      if (stopBelow > 0 && seen < stopBelow - 1e-9) return seen;
    }
    return seen;
  }
  /** The lens right against a surface (within LENS_CLEAR): the near plane cuts into it and the frame shows the inside of
   *  a beam / wall — void. For a room's own camera (req.lensBehindOk, that exact position) only a surface IN FRONT of the
   *  lens counts: its body a few cm behind is not in the picture — a second distance query just ahead of the lens makes
   *  sure nothing else is there. Distance queries only — no rays (the guard's ray budget is untouched). */
  private lensBlocked(pose: CamPose, req?: GuardRequest): boolean {
    if (!this.probe) return false;
    const P = pose.position;
    const q = this.probe.nearestPoint(P, LENS_CLEAR);
    if (!q) return false;
    if (!req?.lensBehindOk || req.lensBehindOk.distanceTo(P) > 1e-4) return true;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
    if (q.point.clone().sub(P).dot(fwd) > -0.005) return true;
    const q2 = this.probe.nearestPoint(P.clone().addScaledVector(fwd, LENS_CLEAR), LENS_CLEAR);
    return !!q2 && q2.point.clone().sub(P).dot(fwd) > -0.005;
  }
  /** Of 9 view rays, how many meet a drawn surface within 0.3 m (foreground clutter); stops counting at `stop`. */
  private nearHits(pose: CamPose, req: GuardRequest, stop: number): number {
    const cam = camOf(pose, req.aspect), P = pose.position;
    let near = 0;
    for (const v of [0.2, 0.5, 0.8]) for (const u of [0.2, 0.5, 0.8]) {
      const d = new THREE.Vector3(u * 2 - 1, 1 - v * 2, 0.5).unproject(cam).sub(P).normalize();
      const h = this.probe!.drawn(P, d, 0.3);
      if (h !== null && h < 0.3 && ++near >= stop) return near;
    }
    return near;
  }
  /** Of a 5 x 3 grid of view rays (edges included), how many leave the set (void); stops counting at `stop`. */
  private openRays(pose: CamPose, req: GuardRequest, stop: number): number {
    const cam = camOf(pose, req.aspect), P = pose.position;
    let open = 0;
    for (const v of [0.06, 0.5, 0.94]) for (const u of [0.04, 0.27, 0.5, 0.73, 0.96]) {
      // (the frame's very centre is the subject a framed shot is about: the face rays see it)
      if (u === 0.5 && v === 0.5 && req.targets.length) continue;
      const d = new THREE.Vector3(u * 2 - 1, 1 - v * 2, 0.5).unproject(cam).sub(P).normalize();
      if (req.openOk === 'sky' && d.y > -0.35) continue;
      if (this.probe!.drawn(P, d, 80) === null && ++open >= stop) return open;
    }
    return open;
  }

  /** The narrowest lens (tan of half the vertical fov) that holds every guard point inside its limits from this pose's
   *  position AND aim (no re-aim), with the motion inset. */
  lensFor(pose: CamPose, req: GuardRequest): number {
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
    const right = new THREE.Vector3().crossVectors(fwd, UP).normalize(), up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    let T = Math.tan((pose.fov * D2R) / 2) * 0.2;
    const r = new THREE.Vector3();
    for (const g of guardPoints(req, right)) {
      r.copy(g.p).sub(pose.position);
      const z = r.dot(fwd);
      if (z < 0.05) return Infinity;
      const ze = Math.max(0.05, z - (g.d ?? 0));
      const x = r.dot(right) / ze, y = r.dot(up) / ze;
      const ins = motionInset(req.motion, z, pose.fov, req.aspect, 0, 0);
      T = Math.max(T, Math.abs(x) / (Math.max(0.05, g.lx - ins.x) * req.aspect), y / Math.max(0.05, g.lt - ins.y), -y / Math.max(0.05, g.lb - ins.y));
    }
    return T;
  }

  /** Is a position usable for a re-solved shot: not inside anyone / against a head, the path from `from` clear, the faces
   *  in sight (room + people) and — unless `geometry` is false — not inside geometry / behind a wall. Cheapest first. */
  usable(p: THREE.Vector3, req: GuardRequest, from?: THREE.Vector3, geometry = true): boolean {
    if (!this.rays || !this.probe) return false;
    if ((req.people ?? req.blockers ?? []).some((b) => insidePerson(p, b))) return false;
    // never inside / right against a head; nobody between the lens and a face
    for (const t of req.targets) {
      if (p.distanceTo(t.face.center) < Math.max(0.25, t.face.size * 1.6)) return false;
      const fc = onFaceSurface(t.face.center, p, t.depth ?? 0, t.forward);
      if ((req.blockers ?? []).some((b) => b.key !== t.key && blocks(p, fc, b))) return false;
    }
    if (from && !this.rays.clear(from, p)) return false;
    for (const t of req.targets) if (!this.see(p, onFaceSurface(t.face.center, p, t.depth ?? 0, t.forward))) return false;
    if (geometry && (this.probe.inside(p) || this.probe.outside(p, 5) >= 3)) return false;
    return true;
  }

  /** Steps 1–2 on one pose. */
  private fixAt(pose: CamPose, req: GuardRequest, notes: string[], tag: string, framingOnly?: { pose: CamPose | null }, dolly = true): { pose: CamPose; step: GuardStep; verdict: GuardVerdict } | null {
    const v0 = this.check(pose, req);
    const q0 = this.qualityOk(pose, req);
    if (v0.ok && q0) return { pose, step: 'ok', verdict: v0 };
    // (a refit keeps the position: it fixes the framing, never what the camera can see — a view the solver chose that
    // isn't clean is remembered as the last resort, the rest of the ladder looks for a clean one first)
    const rf = this.refit(pose, req);
    if (rf) {
      const v = this.check(rf.pose, req);
      if (v.ok && q0) { notes.push(`${tag}refit ${pose.fov.toFixed(0)}°→${rf.pose.fov.toFixed(0)}°`); return { pose: rf.pose, step: 'refit', verdict: v }; }
      if (v.ok && framingOnly && !framingOnly.pose) framingOnly.pose = rf.pose;
    }
    if (v0.ok && framingOnly && !framingOnly.pose) framingOnly.pose = pose;
    if (!q0) notes.push(`${tag}hidden / from behind / inside someone`);
    if (!dolly) return null;
    // dolly back along the view line (then a little higher): the rig's step, up to its reach
    const rig = req.rig ?? RIGS.normal;
    const h = Math.max(...req.targets.map((t) => Math.max(0.2, t.top + t.face.size * 4)), 0.5);
    const reach = Math.max(rig.dolly, rig.dollyPerH * h);
    const step = Math.max(rig.step, reach / 24);
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(pose.quaternion);
    const lift = back.clone().setY(0).normalize();
    const paths = [back.clone().normalize(), lift.lengthSq() > 0.5 ? back.clone().normalize().applyAxisAngle(new THREE.Vector3().crossVectors(UP, lift).normalize(), -8 * D2R) : null].filter((d): d is THREE.Vector3 => !!d);
    // (a dolly path gives up after 3 steps in a row that still don't see the faces — the same thing stays in the way
    // further back along the same line — and never takes more than a quarter of the ladder's budget)
    const cap = this.run ? this.spent + this.run.cap / 4 : Infinity;
    for (const dir of paths) {
      let misses = 0;
      for (let d = step; d <= reach + 1e-6; d += step) {
        if (this.broke() || this.spent >= cap) return null;
        const p = pose.position.clone().addScaledVector(dir, d);
        const moved = { ...pose, position: p };
        // (framing first — no rays: a step the lens can't fit from is skipped before anything is ray-tested)
        const r2 = this.refit(moved, req);
        if (!r2 || r2.clamped || !this.check(r2.pose, req).ok) continue;
        // (a clear path back from a usable view crosses no wall; the inside / behind-a-wall votes only for the pick)
        if (!this.usable(p, req, pose.position, false)) break;              // (a wall / someone behind: further is no better)
        if (!this.qualityOk(r2.pose, req)) { if (++misses >= 3) break; continue; }
        if (!this.usable(p, req)) break;
        notes.push(`${tag}dolly back ${d.toFixed(2)} m, ${r2.pose.fov.toFixed(0)}°`);
        return { pose: r2.pose, step: 'dolly', verdict: this.check(r2.pose, req) };
      }
    }
    return null;
  }

  /** The re-solve ladder (see the file header). Count-bounded: at most LADDER_RAYS ray tests (desert_walker/SPEC.md R3:
   *  never a time budget — a slow page must pick the same shot as a fast one); past it, the best framing found so far. */
  guard(pose: CamPose, req: GuardRequest): GuardResult {
    const notes: string[] = [];
    if ((!req.targets.length && !req.hard?.length) || FrameGuard.off) return { pose, step: 'ok', verdict: { ok: true, worst: 0, out: [] }, notes, clean: true };
    const outer = this.run;
    // (the room parts an engine keeps animating stay out of the ladder's rays: RoomRays.skipMovers)
    const sk = [this.rays?.skipMovers ?? false, this.probe?.skipMovers ?? false];
    if (this.rays) this.rays.skipMovers = true;
    if (this.probe) this.probe.skipMovers = true;
    this.run = { start: this.rayCount(), cap: (req.rayBudget ?? ladderBudget(req.targets.length)) * FrameGuard.budgetMul, q: new Map(), los: new Map() };
    const t0 = performance.now();
    try { return this.ladder(pose, req, notes); }
    finally {
      this.lastSpent = this.spent;
      const S = FrameGuard.stats, ms = performance.now() - t0;
      S.ladders++; S.raysSum += this.lastSpent; S.raysMax = Math.max(S.raysMax, this.lastSpent); S.msSum += ms; S.msMax = Math.max(S.msMax, ms);
      if (this.lastSpent >= this.run.cap) S.capped++;
      this.run = outer;
      if (this.rays) this.rays.skipMovers = sk[0];
      if (this.probe) this.probe.skipMovers = sk[1];
    }
  }
  private ladder(pose: CamPose, req: GuardRequest, notes: string[]): GuardResult {
    const fo: { pose: CamPose | null } = { pose: null };
    const first = this.fixAt(pose, req, notes, '', fo);
    if (first) return { ...first, notes, clean: true };
    let best = { pose, verdict: this.check(pose, req) };
    const keep = (p: CamPose) => { const v = this.check(p, req); if (v.worst < best.verdict.worst && !this.broke() && this.qualityOk(p, req)) best = { pose: p, verdict: v }; };
    const rf0 = this.refit(pose, req); if (rf0) keep(rf0.pose);
    // (fallback cameras must SEE the faces: the solver scored its own pick for occlusion, not these. Cheapest first:
    // every fallback as it stands (a refit) before any of them is dollied — one pose test each, where a dolly path is
    // a few dozen; a giant hiding a guest from the whole front arc must not use the budget up on the first candidate)
    const falls: { pose: CamPose; step: GuardStep; tag: string }[] = [];
    let k = 0;
    for (const alt of req.alternates ?? []) {
      if (k >= 5 || this.broke()) break;
      if (!this.sees(alt.position, req)) continue;
      k++;
      falls.push({ pose: alt, step: 'alternate', tag: `candidate ${k}: ` });
    }
    if (req.wide && !this.broke() && this.sees(req.wide.position, req)) falls.push({ pose: req.wide, step: 'wide', tag: 'wide: ' });
    const fr = this.broke() ? null : this.front(req);
    if (fr) falls.push({ pose: fr, step: 'front', tag: 'front-on: ' });
    for (const f of falls) {
      if (this.broke()) break;
      const r = this.fixAt(f.pose, req, notes, f.tag, undefined, false);
      if (r) return { ...r, step: f.step, notes, clean: true };
      keep(f.pose);
    }
    // over whoever is in the way (a giant / a mech hull between the lens and a guest): the same spot, raised in steps
    const up = this.broke() ? null : this.rise(pose, req, notes);
    if (up) return { ...up, step: 'rise', notes, clean: true };
    // (then the fallbacks dollied back — together never more than a quarter of the budget: the ring search keeps its share)
    const cap5 = this.run ? this.spent + this.run.cap / 4 : Infinity;
    for (const f of falls) {
      if (this.broke() || this.spent >= cap5) break;
      const r = this.fixAt(f.pose, req, [], f.tag);
      if (r) { notes.push(`${f.tag}dollied`); return { ...r, step: f.step, notes, clean: true }; }
    }
    const sr = this.broke() ? null : this.search(pose, req, notes);
    if (sr) return { ...sr, step: 'search', notes, clean: true };
    if (this.broke()) notes.push(`ray budget spent (${this.spent} ray tests)`);
    // (nothing clean: the least bad of the solver's own view (framing fixed), its other candidates and the wide — seeing
    // the faces counts most, then never inside anything / into the void, then the framing; poses the budget can't score
    // any more are left out: the solver's own view, framing fixed, comes first)
    if (fo.pose && this.rays && (req.see !== undefined || req.people)) {
      const pool: CamPose[] = [fo.pose];
      for (const p of [...(req.alternates ?? []).slice(0, 6), ...(req.wide ? [req.wide] : [])]) { const r = this.refit(p, req); pool.push(r ? r.pose : p); }
      const bad = (p: CamPose) => { const q = this.quality(p, req), v = this.check(p, req); return Math.max(0, (req.see ?? 0) - q.seen) * 10 + (q.inside ? 8 : 0) + q.open * 1.5 + (q.near >= 3 ? 8 : 0) + (req.see !== undefined && q.below > MAX_LOOK_UP ? 4 : 0) + (req.away !== undefined && q.away > req.away ? 4 : 0) + Math.min(2, v.worst) * 3; };
      let pick = fo.pose;
      if (!this.broke()) {
        let pb = bad(fo.pose);
        for (const p of pool.slice(1)) { if (this.broke()) break; const b = bad(p); if (b < pb - 0.5) { pick = p; pb = b; } }
        notes.push(pick === fo.pose ? 'framing fixed; the view as solved (no cleaner view found)' : `no clean view: the least bad (${pb.toFixed(1)})`);
      } else notes.push('framing fixed; the view as solved (ray budget spent)');
      return { pose: pick, step: pick === pose ? 'ok' : pick === fo.pose ? 'refit' : 'alternate', verdict: this.check(pick, req), notes, clean: false };
    }
    if (fo.pose) { notes.push('framing fixed; the view as solved (no cleaner view found)'); return { pose: fo.pose, step: fo.pose === pose ? 'ok' : 'refit', verdict: this.check(fo.pose, req), notes, clean: false }; }
    notes.push(`no clean frame (overflow ${best.verdict.worst.toFixed(3)} ${best.verdict.out.join(',')})`);
    return { pose: best.pose, step: 'best-effort', verdict: best.verdict, notes, clean: false };
  }

  /** The pose raised in steps (0.35 m, up to 2.5 m — a giant on the set: a tenth / 0.6 of the tallest one — under the
   *  ceiling) and re-aimed: clean from up there? */
  private rise(pose: CamPose, req: GuardRequest, notes: string[]): { pose: CamPose; step: GuardStep; verdict: GuardVerdict } | null {
    if (!this.rays || !req.targets.length) return null;
    const tall = Math.max(0, ...(req.people ?? req.blockers ?? []).map((p) => p.height || 0));
    const step = Math.max(0.35, tall / 10), reach = Math.max(2.5, tall * 0.6);
    const ceil = this.rays.ceilingAbove(pose.position, Math.max(8, reach + 1));
    const c = req.targets.reduce((a, t) => a.add(t.face.center), new THREE.Vector3()).multiplyScalar(1 / req.targets.length);
    for (let dy = step; dy <= reach + 1e-6; dy += step) {
      if (this.broke()) return null;
      const p = pose.position.clone().addScaledVector(UP, dy);
      if (ceil !== null && p.y > ceil - 0.25) break;
      // (framing first, no rays)
      const r = this.refit(lookPose(p, c, pose.fov), req);
      if (!r || r.clamped) continue;
      const v = this.check(r.pose, req);
      if (!v.ok || !this.usable(p, req, pose.position, false) || !this.qualityOk(r.pose, req) || !this.usable(p, req)) continue;
      notes.push(`raised ${dy.toFixed(2)} m`);
      return { pose: r.pose, step: 'rise', verdict: v };
    }
    return null;
  }

  /** Step 6: a ring search round the framed faces for a clean view, the candidates nearest the solved view first (same
   *  bearing, distance and height; a bearing behind the subjects' facing costs extra). Candidates are screened without
   *  rays first (inside someone, against a head, a lens that can't frame them from there); at most `budget` of them are
   *  ray-tested (and never past the ladder's ray budget). Deterministic (a fixed grid, a stable order). */
  search(pose: CamPose, req: GuardRequest, notes: string[], budget = 240): { pose: CamPose; step: GuardStep; verdict: GuardVerdict } | null {
    if (!this.rays || !this.probe || !req.targets.length) return null;
    const c = req.targets.reduce((a, t) => a.add(t.face.center), new THREE.Vector3()).multiplyScalar(1 / req.targets.length);
    const off = pose.position.clone().sub(c);
    const d0 = Math.max(1, Math.hypot(off.x, off.z));
    const az0 = Math.atan2(off.x, off.z);
    const face = new THREE.Vector3();
    for (const t of req.targets) if (t.forward) face.add(t.forward.clone().setY(0));
    for (const f of req.facing ?? []) face.add(f.clone().setY(0));
    const azF = face.lengthSq() > 1e-6 ? Math.atan2(face.x, face.z) : az0;
    const ys = req.targets.map((t) => t.face.center.y);
    const lo = Math.min(...ys), hi = Math.max(...ys), mid = (lo + hi) / 2;
    const heights = [pose.position.y, mid, lo + 0.1, hi + 0.6, hi + 1.8].filter((y, i, a) => a.findIndex((z) => Math.abs(z - y) < 0.2) === i);
    const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
    const cands: { p: THREE.Vector3; cost: number }[] = [];
    for (const k of [1, 1.35, 0.75, 1.8]) for (let i = 0; i < 24; i++) for (const y of heights) {
      // (bearings outwards from the solved one: 0, +15, -15, +30 ... 180)
      const a = az0 + (Math.ceil(i / 2) * 15 * D2R) * (i % 2 ? 1 : -1);
      const p = new THREE.Vector3(c.x + Math.sin(a) * d0 * k, y, c.z + Math.cos(a) * d0 * k);
      const behind = Math.abs(wrap(a - azF)) > 100 * D2R ? 3 : 0;
      cands.push({ p, cost: Math.abs(wrap(a - az0)) / (45 * D2R) + Math.abs(Math.log(k)) * 1.5 + Math.abs(y - pose.position.y) / 2 + behind });
    }
    // (coarse first: every 45° round, two distances, three heights — a guest hidden behind a giant from the whole front
    // arc is seen from the side long before the fine steps near the solved view are used up — then the rest, nearest the
    // solved view first)
    const coarse = (c0: { p: THREE.Vector3 }) => {
      const o = c0.p.clone().sub(c), a = Math.round(Math.abs(wrap(Math.atan2(o.x, o.z) - az0)) / D2R);
      const k = Math.hypot(o.x, o.z) / d0, y = c0.p.y;
      return a % 45 === 0 && (Math.abs(k - 1) < 1e-6 || Math.abs(k - 1.35) < 1e-6) && (Math.abs(y - pose.position.y) < 1e-6 || Math.abs(y - mid) < 1e-6 || Math.abs(y - (hi + 0.6)) < 1e-6);
    };
    for (const c0 of cands) if (coarse(c0)) c0.cost -= 100;
    cands.sort((a, b) => a.cost - b.cost);
    // (a shot that must show a picture — the React screen, the call-in monitor — must see it too: its corners and
    // centre past the room and everyone; the solvers that made the other rungs scored that, this search did not)
    const hard = req.hard ?? [];
    const pics = hard.length ? [...hard, hard.reduce((a, q) => a.add(q), new THREE.Vector3()).multiplyScalar(1 / hard.length)] : [];
    const people = req.people ?? req.blockers ?? [];
    const seesPicture = (p: THREE.Vector3) => pics.every((q0) => {
      const q = q0.clone().addScaledVector(p.clone().sub(q0).normalize(), 0.03);
      return !people.some((b) => blocks(p, q, b)) && this.rays!.hit(p, q, 0.01, true) === Infinity;
    });
    let tried = 0;
    for (const { p } of cands) {
      if (tried >= budget || this.broke()) break;
      // (screened without rays: inside / against someone, a frame the lens can't make from there, too far round a face,
      // looking up under a chin)
      if (people.some((b) => insidePerson(p, b)) || req.targets.some((t) => p.distanceTo(t.face.center) < Math.max(0.25, t.face.size * 1.6))) continue;
      const r = this.refit(lookPose(p, c, pose.fov), req);
      if (!r || r.clamped) continue;
      const v = this.check(r.pose, req);
      if (!v.ok) continue;
      if (req.targets.some((t) => { const g = geomOf(p, t); return (req.away !== undefined && g.away > req.away) || (req.see !== undefined && g.below > MAX_LOOK_UP); })) continue;
      tried++;
      if (!this.usable(p, req, undefined, false) || !seesPicture(p) || !this.qualityOk(r.pose, req) || !this.usable(p, req)) continue;
      const o = r.pose.position.clone().sub(c);
      notes.push(`searched: ${Math.round(wrap(Math.atan2(o.x, o.z) - az0) / D2R)}° round, ${(Math.hypot(o.x, o.z) / d0).toFixed(2)}× out, ${(p.y - pose.position.y).toFixed(1)} m up, ${r.pose.fov.toFixed(0)}° (${tried} tried)`);
      return { pose: r.pose, step: 'search', verdict: v };
    }
    notes.push(`searched ${tried} positions: none clean`);
    return null;
  }

  /** A fallback camera position sees every framed face (room + people) and isn't inside geometry. */
  sees(p: THREE.Vector3, req: GuardRequest): boolean {
    if (!this.rays || !this.probe) return true;
    for (const t of req.targets) {
      const fc = onFaceSurface(t.face.center, p, t.depth ?? 0, t.forward);
      if ((req.blockers ?? []).some((b) => b.key !== t.key && blocks(p, fc, b)) || !this.see(p, fc)) return false;
    }
    return !this.probe.inside(p);
  }

  /** Step 5: straight at the subjects from their facing, at the rig's elevation, pulled in front of walls. */
  front(req: GuardRequest): CamPose | null {
    if (!req.targets.length) return null;
    const rig = req.rig ?? RIGS.normal;
    let dir = req.front?.clone().setY(0) ?? new THREE.Vector3();
    if (dir.lengthSq() < 1e-6) for (const f of req.facing ?? []) dir.add(f.clone().setY(0));
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();
    const c = req.targets.reduce((a, t) => a.add(t.face.center), new THREE.Vector3()).multiplyScalar(1 / req.targets.length);
    const el = rig.elevPref * D2R;
    const d3 = dir.clone().multiplyScalar(Math.cos(el)).addScaledVector(UP, Math.sin(el)).normalize();
    // the distance that fits every face box + head at the rig's lens (with the safe margins)
    const s = req.safe ?? FIX_SAFE[req.family];
    const vt = Math.tan((rig.lens * D2R) / 2) * Math.min(s.top, s.bottom), ht = Math.tan((rig.lens * D2R) / 2) * req.aspect * s.x;
    const right = new THREE.Vector3().crossVectors(UP, dir).normalize();
    let need = 0.6;
    for (const t of req.targets) {
      const r = t.face.center.clone().sub(c);
      const depth = r.dot(d3);
      const hx = Math.abs(r.dot(right)) + Math.max(t.half ?? 0, t.face.size * FACE_BOX.side);
      const hy = Math.abs(r.y) + Math.max(t.top, t.face.size * FACE_BOX.up) * 1.1;
      need = Math.max(need, hx / ht + depth, hy / vt + depth, t.face.size * 3);
    }
    let pos = c.clone().addScaledVector(d3, need);
    if (!this.rays) return null;
    const hit = this.rays.hit(c, pos, 0.2);
    if (hit !== Infinity) pos = c.clone().addScaledVector(d3, Math.max(0.4, hit - 0.15));
    if (!this.usable(pos, req)) return null;
    return frameFrom(pos, [c], req.aspect, { minFov: rig.lens * 0.5, maxFov: rig.lens }) ?? lookPose(pos, c, rig.lens);
  }
}

// ---------------------------------------------------------------- the solver hook (talk / group shots)
/** A ShotSubject as a guard target. */
export function targetOf(s: ShotSubject): GuardTarget {
  const top = Math.max(s.face.size * 1.15, Math.min(s.top ?? s.face.size * 1.1, Math.max(s.height * 0.45, s.face.size * 1.8)));
  return { key: s.key, face: s.face, top, forward: s.forward, ...(s.headHalf ? { half: s.headHalf } : {}), ...(s.depth ? { depth: s.depth } : {}) };
}

/** A performer's body for occlusion / inside tests: a head sphere (the face, or the whole head when it is measured wider —
 *  a fluffy mascot whose face markers only span the eyes) and a torso box under it. */
function bodyOf(s: ShotSubject): { head: THREE.Sphere; torso: THREE.Box3 } {
  // (round the head's middle — a drawn face sits on its front)
  const c = s.head ?? s.face.center, f = s.face.size, half = s.headHalf ?? 0;
  const r = Math.max(f * 0.72, half * 0.9);
  // (a mech: the whole hull box, the pilot's head inside it)
  if (s.body && !s.body.isEmpty()) return { head: new THREE.Sphere(c.clone().addScaledVector(UP, f * 0.15), r), torso: s.body.clone() };
  const w = Math.max(f * 1.05, half), top = c.y - Math.max(f * 0.6, half * 0.6), bot = s.sit ? top - s.height * 0.32 : s.floor.y;
  return { head: new THREE.Sphere(c.clone().addScaledVector(UP, f * 0.15), r), torso: new THREE.Box3(new THREE.Vector3(c.x - w, bot, c.z - w), new THREE.Vector3(c.x + w, top, c.z + w)) };
}
/** Segment a → b passes through someone (head sphere + torso box, the head as wide as measured). */
export function blocks(a: THREE.Vector3, b: THREE.Vector3, s: ShotSubject): boolean {
  const d = b.clone().sub(a), L = d.length();
  if (L < 1e-4) return false;
  const ray = new THREE.Ray(a, d.divideScalar(L)), p = new THREE.Vector3();
  const o = bodyOf(s);
  if (ray.intersectSphere(o.head, p) && p.distanceTo(a) < L - 0.02) return true;
  return !!ray.intersectBox(o.torso, p) && p.distanceTo(a) < L - 0.02;
}
/** Is a point inside a performer (the camera swallowed by a giant)? */
export function insidePerson(p: THREE.Vector3, s: ShotSubject): boolean {
  const o = bodyOf(s);
  return p.distanceTo(o.head.center) < o.head.radius * 1.3 || o.torso.clone().expandByScalar(0.05).containsPoint(p);
}

/** Installed as ShotSolver.guard: every solved talk / group shot passes the framing guarantee before it is used. */
function solvedGuard(solver: ShotSolver, req: ShotRequest, res: ShotResult, alternates: CamPose[]): ShotResult {
  const g = req.guard;
  if (g?.off || !req.subjects.length) return res;
  const fg = new FrameGuard(solver.rays, solver.probe);
  const cls = req.subjects.length === 1 ? req.subjects[0].rig ?? 'normal' : biggest(req.subjects);
  const family = req.kind === 'talk' ? 'talk' : 'group';
  // (a mech's hull: soft points of the group shot — the whole walker when the lens allows)
  const soft = req.kind === 'group' ? req.subjects.flatMap((s) => (s.hull ? hullPoints(s) : [])) : [];
  const r = fg.guard(res.pose, {
    family, targets: req.subjects.map(targetOf), aspect: req.aspect, blockers: req.others, safe: safeFor(family, g?.safe ?? null).fix, ...(soft.length ? { soft } : {}),
    motion: g?.motion ?? null, rig: rigFor(cls, g?.rigs ?? undefined), alternates, wide: g?.wide ?? null,
    facing: req.subjects.map((s) => s.forward), front: req.prefer, maxFov: req.kind === 'talk' ? undefined : 75,
    // (the shot must also show the faces: nobody hidden, never the back of the talker's head, never inside anyone)
    see: 0.75, ...(req.kind === 'talk' ? { away: 100 } : {}), people: [...req.subjects, ...req.others], openOk: req.voidOk ? 'all' : req.skyOk ? 'sky' : 'none',
  });
  if (r.step === 'ok') return res;
  return { ...res, pose: r.pose, notes: [...res.notes, `guard: ${r.step}`, ...r.notes] };
}
/** A mech's hull as points: its top over the floor and its sides at half height (ShotSubject.hull). */
export function hullPoints(s: ShotSubject): THREE.Vector3[] {
  const h = s.hull;
  if (!h) return [];
  const base = s.floor.clone(), mid = base.clone().addScaledVector(UP, h.top * 0.5), right = new THREE.Vector3().crossVectors(s.forward, UP).normalize();
  return [base.clone().addScaledVector(UP, h.top), mid.clone().addScaledVector(right, h.half), mid.clone().addScaledVector(right, -h.half)];
}
function biggest(s: ShotSubject[]): FramingClass {
  const order: FramingClass[] = ['micro', 'small', 'normal', 'large', 'mech', 'macro'];
  return s.reduce<FramingClass>((a, x) => (order.indexOf(x.rig ?? 'normal') > order.indexOf(a) ? x.rig ?? 'normal' : a), 'micro');
}
ShotSolver.guard = solvedGuard;

// ---------------------------------------------------------------- live drift guard
/** A pose turned by `yaw` about the world up and `pitch` about its right (no roll) — the live guard's correction. */
function turned(p: CamPose, yaw: number, pitch: number): CamPose {
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(p.quaternion).applyAxisAngle(UP, yaw);
  fwd.applyAxisAngle(new THREE.Vector3().crossVectors(fwd, UP).normalize(), pitch);
  return lookPose(p.position, p.position.clone().add(fwd), p.fov);
}
export interface LiveFace { key: string; center: THREE.Vector3; size: number; top: number; half?: number }

/** The live guard's filter: natural frequency (rad/s) of its critically damped ease (desert_walker/SPEC.md R4). */
export const LIVE_OMEGA = 4;

export class LiveGuard {
  /** Filter state per channel: yaw (rad), pitch (rad), zoom - 1; and their rates. */
  private x = [0, 0, 0];
  private v = [0, 0, 0];
  private tgt = [0, 0, 0];
  private over = 0;
  private key = '';
  /** Debug: what the guard is doing (vtpOut.scene.liveGuard). */
  get info() {
    return { yaw: +(this.x[0] / D2R).toFixed(2), pitch: +(this.x[1] / D2R).toFixed(2), zoom: +(1 + this.x[2]).toFixed(3), target: { yaw: +(this.tgt[0] / D2R).toFixed(2), pitch: +(this.tgt[1] / D2R).toFixed(2), zoom: +(1 + this.tgt[2]).toFixed(3) },
      over: +this.over.toFixed(3), active: this.active };
  }
  get active() { return Math.abs(this.x[0]) > 1e-4 || Math.abs(this.x[1]) > 1e-4 || this.x[2] > 1e-4; }

  reset() { this.x = [0, 0, 0]; this.v = [0, 0, 0]; this.tgt = [0, 0, 0]; this.over = 0; }

  /** The correction this frame's faces call for, from the RIG's pose (never the corrected camera: no feedback, no
   *  state): 0 while every face is inside the fix area; past it, the refit that puts them back in, weighed from 0 at the
   *  fix line to 1 at the evaluation line (liveWeight) — capped at maxTurnDeg of aim, the lens making up the rest up to
   *  maxZoom. A pure function of the tracking every page receives. */
  static target(pose: CamPose, faces: LiveFace[], aspect: number, motion: MotionEnvelope | null, family: ShotFamily, safe: Record<string, unknown> | null | undefined, LS: LiveSettings): { t: [number, number, number]; over: number } {
    const sf = safeFor(family, safe ?? null);
    const targets = faces.map((f) => ({ key: f.key, face: { center: f.center, size: f.size }, top: f.top, ...(f.half ? { half: f.half } : {}) }));
    const maxFov = Math.min(80, (2 * Math.atan(Math.tan((pose.fov * D2R) / 2) * LS.maxZoom)) / D2R);
    const req: GuardRequest = { family, targets, aspect, motion, safe: sf.fix, maxFov };
    const g = new FrameGuard(null, null);
    const v = g.check(pose, req);
    if (v.ok) return { t: [0, 0, 0], over: 0 };
    const band = Math.max(0.01, Math.min(sf.evalArea.x - sf.fix.x, sf.evalArea.top - sf.fix.top, sf.evalArea.bottom - sf.fix.bottom));
    const w = liveWeight(v.worst, band);
    const rf = g.refit(pose, req);
    if (!rf || w <= 0) return { t: [0, 0, 0], over: v.worst };
    const f0 = new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion), f1 = new THREE.Vector3(0, 0, -1).applyQuaternion(rf.pose.quaternion);
    const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
    const lim = LS.maxTurnDeg * D2R;
    const yaw = THREE.MathUtils.clamp(-wrap(Math.atan2(f0.x, f0.z) - Math.atan2(f1.x, f1.z)), -lim, lim);
    const pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(f1.y, -1, 1)) - Math.asin(THREE.MathUtils.clamp(f0.y, -1, 1)), -lim, lim);
    // (the aim is capped: the lens makes up the rest, measured from the capped aim)
    const aimed = turned(pose, yaw, pitch);
    const zoom = THREE.MathUtils.clamp(Math.max(Math.tan((rf.pose.fov * D2R) / 2), g.lensFor(aimed, req)) / Math.tan((pose.fov * D2R) / 2), 1, LS.maxZoom);
    return { t: [yaw * w, pitch * w, (zoom - 1) * w], over: v.worst };
  }

  /** After the camera rig wrote `cam` for this frame. `on` false (moving, hole open, React, a director shot): eases back
   *  to the rig's own pose. `key` = the shot (a new shot starts clean). `o.family` = the shot family (its fix area and
   *  evaluation line); `o.safe` = scene.json framing.safe; `o.set` = scene.json framing.live. */
  update(dt: number, cam: THREE.PerspectiveCamera, faces: LiveFace[], aspect: number, on: boolean, key: string, motion: MotionEnvelope | null = null,
    o: { family?: ShotFamily; safe?: Record<string, unknown> | null; set?: LiveSettings } = {}) {
    if (key !== this.key) { this.key = key; this.reset(); }
    const LS = o.set ?? LIVE_DEFAULT;
    if (on && LS.on && faces.length && !FrameGuard.off) {
      const r = LiveGuard.target({ position: cam.position.clone(), quaternion: cam.quaternion.clone(), fov: cam.fov }, faces, aspect, motion, o.family ?? 'talk', o.safe, LS);
      this.tgt = r.t; this.over = r.over;
    } else { this.tgt = [0, 0, 0]; this.over = 0; }
    const w = LS.omega > 0 ? LS.omega : LIVE_OMEGA;
    for (let i = 0; i < 3; i++) [this.x[i], this.v[i]] = dampStep(this.x[i], this.v[i], this.tgt[i], w, Math.min(dt, 0.25));
    // (settled back on the rig: exactly the rig's pose, not a 1e-6 rad drift)
    for (let i = 0; i < 3; i++) if (!this.tgt[i] && Math.abs(this.x[i]) < 1e-5 && Math.abs(this.v[i]) < 1e-4) { this.x[i] = 0; this.v[i] = 0; }
    if (!this.active) return;
    // apply on top of the rig's pose: yaw about the world up, pitch about the camera's right (no roll)
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    fwd.applyAxisAngle(UP, this.x[0]);
    const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
    fwd.applyAxisAngle(right, this.x[1]);
    const m = new THREE.Matrix4().lookAt(cam.position, cam.position.clone().add(fwd), UP);
    cam.quaternion.setFromRotationMatrix(m);
    cam.fov = (2 * Math.atan(Math.tan((cam.fov * D2R) / 2) * (1 + Math.max(0, this.x[2])))) / D2R;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }
}
