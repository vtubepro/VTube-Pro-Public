// Cue v3 on a page (shared/talkshow.ts InterviewCue): the poses of the shots that ride on existing shot ids plus optional cue
// fields, and the named camera moves. Pure functions of the cue and the set - every page derives the same pose from the same
// cue - so they run on the CPU in tools/interview_director_unit.ts (no browser, no scene).
//   · `wide` + cam / aud / ak: a room camera preset, the audience (reaction / wide / the asker's close-up), else the room wide;
//   · mv 'crane': the host's single reached by a crane move down and in; mv 'pull': dolly back and wider from the on-air pose (both
//     clamped against the room's own surfaces with the same RoomRays on every page, so no page flies a camera out through a wall);
//   · a timed move that a page joins late starts `at` seconds in (moveFrom/progress).
import * as THREE from 'three';
import { lookPose, type CamPose } from '../cameraRig.ts';
import { CRANE_SECS, PULL_SECS } from '../../../shared/talkshow.ts';

/** The crane starts this much higher and further back than the host's single (m); the pull ends this far back (m), this much wider. */
export const CRANE_UP = 1.2, CRANE_BACK = 2.0, PULL_BACK = 1.5, PULL_FOV = 1.6, MAX_FOV = 70;
/** A named move keeps this far (m) off the room's surfaces (a wall is 0.15 m thick, the near plane 0.03 m); a pull the room leaves
 *  less than MIN_MOVE m for is a plain cut - a 20 cm creep reads as a mistake, not a move. */
export const WALL_CLEAR = 0.3, MIN_MOVE = 0.4;

/** Distance from `a` to the first room surface towards `b`; Infinity = clear all the way to `b` (RoomRays.hit). */
export type Reach = (a: THREE.Vector3, b: THREE.Vector3) => number;
/** The room's RoomRays as a Reach. The parts an engine keeps animating (a drone, a flag) stay out of the ray tests - where one happened
 *  to be must not change a camera move (every page derives the same pose from the same cue). */
export function reachOf(rays: { hit(a: THREE.Vector3, b: THREE.Vector3): number; skipMovers: boolean }): Reach {
  return (a, b) => { const sk = rays.skipMovers; rays.skipMovers = true; try { return rays.hit(a, b); } finally { rays.skipMovers = sk; } };
}
/** How far (at most `want` m) a camera at `from` can travel along the unit vector `dir` and still be WALL_CLEAR m short of the first
 *  room surface. No `reach` (a probe, a test): the whole way. The ray goes WALL_CLEAR past the goal, so a wall just beyond it counts. */
export function reachAlong(from: THREE.Vector3, dir: THREE.Vector3, want: number, reach?: Reach): number {
  if (!reach || want <= 0) return want;
  const d = reach(from, from.clone().addScaledVector(dir, want + WALL_CLEAR));
  return d === Infinity ? want : Math.max(0, Math.min(want, d - WALL_CLEAR));
}

/** What a page knows about its room for a `wide` cue. */
/** A short stable key for a chat key (the asker of an "Answer now" question): the cue carries it, a page compares it with the key of
 *  the question its own audience engine shows - the raw key can be any characters, a cue field is bounded. */
export function askKey(k: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

export interface WideEnv {
  aspect: number;
  /** The room's own wide shot (CAM_WIDE, else the auto wide). */
  roomWide(): { key: string; pose: CamPose };
  /** A camera preset of this room by name (CAM_*, SPOT_*_CAM), or null when it has none. */
  camera(name: string): { key: string; pose: CamPose } | null;
  /** The audience engine's shots (src/scene/audience/cams.ts): none on a page whose room has no audience. */
  audience: { request(): { kind: string; key?: string } | null; pose(kind: 'asker' | 'reaction' | 'wide', aspect: number): CamPose | null };
}

/** The pose of a `wide` cue: the audience when it asks for it (the asker's close-up only for the question it names, else the
 *  audience wide; a section camera the director picked beats the engine's generic pose), then a room camera, then the room wide.
 *  The key is the shot's identity: another key = a new shot for the camera rig. */
export function widePoseFor(x: { cam?: string; aud?: 'r' | 'w' | 'a'; ak?: string }, env: WideEnv): { key: string; pose: CamPose } {
  if (x.aud) {
    if (x.aud === 'a') {
      const r = env.audience.request();
      if (r && r.kind === 'asker' && (!x.ak || askKey(r.key ?? '') === x.ak)) {
        const p = env.audience.pose('asker', env.aspect);
        if (p) return { key: `aud:a:${x.ak ?? ''}`, pose: p };
      }
    }
    const cam = x.cam ? env.camera(x.cam) : null;
    if (cam) return { key: `aud:${x.aud}#${x.cam}`, pose: cam.pose };
    const p = env.audience.pose(x.aud === 'r' ? 'reaction' : 'wide', env.aspect);
    if (p) return { key: `aud:${x.aud === 'a' ? 'w' : x.aud}`, pose: p };
  }
  if (x.cam) { const c = env.camera(x.cam); if (c) return { key: `cam:${x.cam}`, pose: c.pose }; }
  const w = env.roomWide();
  return { key: w.key, pose: w.pose };
}

/** A named move's time (s); any other shot keeps the time its cue carries. */
export const moveSecs = (mv: 'crane' | 'pull' | undefined, secs: number) => (mv === 'crane' ? CRANE_SECS : mv === 'pull' ? PULL_SECS : secs);

/** The crane's start: the single's pose raised CRANE_UP m and pulled back CRANE_BACK m (away from where it looks, level), still
 *  aimed at `focus` (the host's face; else the point 3 m ahead of the single). With a `reach` the start stays inside the room: the
 *  way back is clamped against the wall behind, then the way up from there against the ceiling. */
export function craneFrom(p: CamPose, focus: THREE.Vector3 | null, reach?: Reach): CamPose {
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(p.quaternion);
  const back = fwd.clone().setY(0);
  if (back.lengthSq() < 1e-6) back.set(0, 0, 1); else back.normalize().negate();
  const up = new THREE.Vector3(0, 1, 0);
  const behind = p.position.clone().addScaledVector(back, reachAlong(p.position, back, CRANE_BACK, reach));
  const pos = behind.clone().addScaledVector(up, reachAlong(behind, up, CRANE_UP, reach));
  return lookPose(pos, focus ?? p.position.clone().addScaledVector(fwd, 3), p.fov);
}

/** The pull's end: the on-air pose dollied PULL_BACK m back along its own axis, PULL_FOV times wider (at most MAX_FOV). With a `reach`
 *  the dolly stops WALL_CLEAR m short of a wall behind the camera (the sample room's wide sits 0.25 m in front of its front wall). */
export function pullTo(p: CamPose, reach?: Reach): CamPose {
  const back = new THREE.Vector3(0, 0, 1).applyQuaternion(p.quaternion);
  return { position: p.position.clone().addScaledVector(back, reachAlong(p.position, back, PULL_BACK, reach)), quaternion: p.quaternion.clone(), fov: Math.min(MAX_FOV, Math.max(p.fov, p.fov * PULL_FOV)) };
}

/** Jump-cut softening (a page-side belt and braces behind the shot book): a cut to the SAME subject within SOFT_DEG degrees of the pose
 *  on air (and less than SOFT_DIST m from it) and less than SOFT_FOV times its field of view change would look like a jump cut - it
 *  becomes a SOFT_SECS s move (short enough never to cross furniture). A pure
 *  function of the two poses (every page that saw the same two shots derives the same thing); 0 = a plain cut. */
export const SOFT_DEG = 30, SOFT_FOV = 1.4, SOFT_SECS = 0.6, SOFT_DIST = 1.5;
export function softCutSecs(prev: CamPose | null, next: CamPose, sameSubject: boolean): number {
  if (!prev || !sameSubject) return 0;
  const a = new THREE.Vector3(0, 0, -1).applyQuaternion(prev.quaternion), b = new THREE.Vector3(0, 0, -1).applyQuaternion(next.quaternion);
  const deg = Math.acos(Math.min(1, Math.max(-1, a.dot(b)))) * 180 / Math.PI;
  const fov = Math.max(prev.fov, next.fov) / Math.max(1e-3, Math.min(prev.fov, next.fov));
  return deg < SOFT_DEG && fov < SOFT_FOV && prev.position.distanceTo(next.position) < SOFT_DIST ? SOFT_SECS : 0;
}

/** No camera flights: a timed move (a push-in) that would carry the camera more than FLIGHT_M m is a cut - a push is a slow growth on
 *  the subject you are already looking at, not a 6.5 s ride across the set (it used to follow an over-the-shoulder shot: 3-8 m behind a
 *  guest's head). Named moves (crane / pull) are declared flights and keep their time. A pure function of the two poses. */
export const FLIGHT_M = 1.5;
export function noFlight(secs: number, named: boolean, prev: CamPose | null, next: CamPose): number {
  return secs > 0 && !named && prev && prev.position.distanceTo(next.position) > FLIGHT_M ? 0 : secs;
}

/** How far into a timed move of `secs` a page that took the cut `at` s late starts (0…1); a cut taken live starts at 0. */
export const moveProgress = (secs: number, at: number | undefined) => (secs > 0 && at !== undefined && at > 0.25 ? Math.min(1, at / secs) : 0);

/** The camera move of a shot on air: the pose it ends on, its time, the pose it starts from (when it is not simply wherever the
 *  camera is: a crane, a pull, a push-in a page joined late) and how far in it starts. `single` = the subject's own single (a
 *  push-in starts from it); `focus` = the host's face (the crane stays aimed at it); `reach` = the room's surfaces (a crane / pull never
 *  leaves the room; a pull with no space for MIN_MOVE m is a plain cut: no move, secs 0). */
export function moveOf(s: { mv?: 'crane' | 'pull'; secs: number; at?: number }, pose: CamPose, ctx: { single?: CamPose | null; focus?: THREE.Vector3 | null; reach?: Reach }): { pose: CamPose; secs: number; from?: CamPose; t0?: number } {
  const secs = moveSecs(s.mv, s.secs);
  const t0 = moveProgress(secs, s.at);
  if (s.mv === 'crane') return { pose, secs, from: craneFrom(pose, ctx.focus ?? null, ctx.reach), ...(t0 ? { t0 } : {}) };
  if (s.mv === 'pull') {
    const end = pullTo(pose, ctx.reach);
    if (end.position.distanceTo(pose.position) < MIN_MOVE) return { pose, secs: 0 };
    return { pose: end, secs, from: pose, ...(t0 ? { t0 } : {}) };
  }
  // (a timed move from the subject's own single: the same start a page that saw the cut had)
  if (secs > 0 && t0 > 0 && ctx.single) return { pose, secs, from: ctx.single, t0 };
  return { pose, secs };
}
