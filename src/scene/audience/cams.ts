// Audience camera shots + the hook a director can use (docs/SCENES.md "Chat audience → Camera hook").
//
//   audienceShots.request()          → what the audience would like on camera now, or null:
//                                      { kind: 'asker', key, since, until, priority } while a question is being answered
//                                      (the first `askerSecs`), { kind: 'reaction', since, until } after a big cheer /
//                                      applause / a laugh wave.
//   audienceShots.pose(kind, aspect)  → a CamPose (world space) for 'asker' (a close-up of the asker from the stage side),
//                                      'reaction' / 'wide' (the audience from the stage: CAM_AUDIENCE when the room has one)
//                                      or null (no audience in this room / nobody to show).
// The interview director (src/scene/talkshow/director.ts, owned by the interviewcam lane) may call these to cut to the
// audience on its own terms. Until it does, the audience engine itself takes a SHORT asker close-up through
// SceneRuntime.cameraOverride when "Answer now" is pressed (setting `ask.askerCut`, default on; the interview engine
// consults the earlier override first, like a room event).
import * as THREE from 'three';
import { lookPose, type CamPose } from '../cameraRig.ts';

export type AudienceShotKind = 'asker' | 'reaction' | 'wide';
export interface AudienceShotRequest { kind: AudienceShotKind; key?: string; since: number; until: number; priority: number }

export interface AudienceShotSource {
  request(): AudienceShotRequest | null;
  pose(kind: AudienceShotKind, aspect: number): CamPose | null;
}

let source: AudienceShotSource | null = null;
/** The registry the director reads (one audience engine per page). */
export const audienceShots: AudienceShotSource = {
  request: () => { try { return source?.request() ?? null; } catch { return null; } },
  pose: (k, a) => { try { return source?.pose(k, a) ?? null; } catch { return null; } },
};
export function setAudienceShotSource(s: AudienceShotSource | null) { source = s; }

const UP = new THREE.Vector3(0, 1, 0);

/** A close-up of a person at `head` (world) from the stage side: 2.1 m towards `stage`, raised so the rows in front
 *  stay below the frame; fov by aspect so the head + shoulders fill the frame (+ the card above). */
export function askerPose(head: THREE.Vector3, stage: THREE.Vector3, aspect: number, cardH = 0.5): CamPose {
  const dir = new THREE.Vector3(stage.x - head.x, 0, stage.z - head.z);
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
  dir.normalize();
  const side = new THREE.Vector3().crossVectors(UP, dir).normalize();
  const pos = head.clone().addScaledVector(dir, 2.7).addScaledVector(side, 0.35).addScaledVector(UP, 0.5);
  const target = head.clone().addScaledVector(UP, cardH * 0.3);
  const fov = aspect < 1.2 ? 46 : 38;
  return lookPose(pos, target, fov);
}

/** What blocks the view: `hit(a, b)` = the distance to the first room surface from a towards b (Infinity = clear) - RoomRays. */
export interface ViewRays { hit(a: THREE.Vector3, b: THREE.Vector3, skipNear?: number): number }
/** An asker's close-up may lose at most this share of the head + card box to a prop (a pedestal, a railing): ASKER_BLOCKED. */
export const ASKER_BLOCKED = 0.1;

/** The share (0…1) of the asker's head, shoulders and card above them - a 5 × 5 grid of points on a plane facing the camera - that the
 *  room's surfaces hide from a lens at `pos`. */
export function blockedShare(pos: THREE.Vector3, head: THREE.Vector3, rays: ViewRays, cardH = 0.5): number {
  const to = head.clone().sub(pos).setY(0);
  if (to.lengthSq() < 1e-6) return 0;
  const side = new THREE.Vector3().crossVectors(UP, to.normalize()).normalize();
  let blocked = 0, n = 0;
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
    const p = head.clone().addScaledVector(side, (i / 4 - 0.5) * 0.56).addScaledVector(UP, -0.28 + (j / 4) * (0.28 + 0.12 + cardH));
    n++;
    const d = pos.distanceTo(p);
    if (rays.hit(pos, p, 0.05) < d - 0.05) blocked++;
  }
  return blocked / n;
}

/** The asker's close-up, or - the default one is hidden by more than ASKER_BLOCKED of the head + card box - the first of a few other
 *  stands (the other side, nearer, farther, higher) that is clear; null = none (the page then shows the audience wide). Without `rays`
 *  it is `askerPose`. */
export function askerPoseClear(head: THREE.Vector3, stage: THREE.Vector3, aspect: number, rays: ViewRays | null, cardH = 0.5): CamPose | null {
  const base = askerPose(head, stage, aspect, cardH);
  if (!rays) return base;
  const dir = new THREE.Vector3(stage.x - head.x, 0, stage.z - head.z);
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
  dir.normalize();
  const side = new THREE.Vector3().crossVectors(UP, dir).normalize();
  const target = head.clone().addScaledVector(UP, cardH * 0.3);
  const fov = aspect < 1.2 ? 46 : 38;
  const stands: [number, number, number][] = [[2.7, 0.35, 0.5], [2.7, -0.35, 0.5], [2.2, 0.35, 0.5], [2.2, -0.35, 0.5], [3.3, 0.35, 0.5], [3.3, -0.35, 0.5], [2.7, 0, 1.0], [2.2, 0, 1.0], [3.3, 0, 1.2]];
  for (const [d, s, up] of stands) {
    const pos = head.clone().addScaledVector(dir, d).addScaledVector(side, s).addScaledVector(UP, up);
    if (blockedShare(pos, head, rays, cardH) <= ASKER_BLOCKED) return d === 2.7 && s === 0.35 && up === 0.5 ? base : lookPose(pos, target, fov);
  }
  return null;
}

/** The audience from the stage: above the stage focus, looking at the seats' centre, wide enough for their spread. */
export function audienceWidePose(stage: THREE.Vector3, seats: THREE.Vector3[], aspect: number): CamPose | null {
  if (!seats.length) return null;
  const c = seats.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / seats.length);
  const dir = new THREE.Vector3(c.x - stage.x, 0, c.z - stage.z);
  const dist = dir.length();
  if (dist < 0.5) return null;
  dir.normalize();
  // stand a little in front of the stage, at eye height + 0.6
  const pos = new THREE.Vector3(stage.x, 0, stage.z).addScaledVector(dir, Math.min(dist * 0.35, 2.2));
  pos.y = Math.max(...seats.map((s) => s.y)) + 1.35;
  const target = c.clone().setY(c.y + 0.75);
  // fov to fit the spread across
  const right = new THREE.Vector3().crossVectors(dir, UP).normalize();
  const half = Math.max(...seats.map((s) => Math.abs(s.clone().sub(c).dot(right)))) + 0.7;
  const d = pos.distanceTo(target);
  const hfov = 2 * Math.atan(half / d);
  const vfov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hfov / 2) / Math.max(0.5, aspect)));
  return lookPose(pos, target, Math.min(70, Math.max(30, vfov)));
}
