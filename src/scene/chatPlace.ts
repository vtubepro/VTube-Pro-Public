// Where the in-world chat props go for the CURRENT shot: the chat monitor / support board hang where the camera sees
// them (inside the frame, readable size, near the host's depth), never over a performer's face or the react screen,
// never through a wall or furniture; the chat buddy stands on a free floor point in frame near the host, clear of every
// SPOT_* (guests' seats), the COLLIDE_* boxes and the other props. Pure functions of (room, shot, performers) → every
// page (studio preview, OBS, guests' OBS) picks the same place.
// Two phases: cheap screen-space scoring of every candidate, then room ray tests (BVH) in score order until one
// passes — spread over frames by the caller (a few ms per frame), so OBS never hitches.
import * as THREE from 'three';
import type { CamPose } from './cameraRig.ts';
import type { RoomRays } from './twoShot.ts';
import type { PropPlacement } from './chatRig.ts';

export interface Rect { x0: number; y0: number; x1: number; y1: number }
export const rectOverlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

export interface Performer { face: { center: THREE.Vector3; size: number }; floor: THREE.Vector3; height: number; host: boolean }

export interface ShotContext {
  pose: CamPose;
  aspect: number;
  performers: Performer[];
  /** Screen rects (fractions, y down) that must stay clear: the react screen(s), props placed before. */
  keepOut: Rect[];
  rays: RoomRays;
  /** Where the anchor performer (host / talk focus) is. */
  anchor: Performer | null;
  /** Every SPOT_* floor position (occupied or not — guests may walk in). */
  spots: THREE.Vector3[];
}

const UP = new THREE.Vector3(0, 1, 0);
export function camOf(pose: CamPose, aspect: number) {
  const c = new THREE.PerspectiveCamera(pose.fov, aspect, 0.03, 500);
  c.position.copy(pose.position); c.quaternion.copy(pose.quaternion);
  c.updateProjectionMatrix(); c.updateMatrixWorld();
  return c;
}
function proj(p: THREE.Vector3, cam: THREE.PerspectiveCamera) { const v = p.clone().project(cam); return { u: (v.x + 1) / 2, v: (1 - v.y) / 2, front: v.z > -1 && v.z < 1 }; }
export function rectOf(pts: THREE.Vector3[], cam: THREE.PerspectiveCamera): (Rect & { front: boolean }) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, front = true;
  for (const p of pts) { const q = proj(p, cam); if (!q.front) front = false; x0 = Math.min(x0, q.u); x1 = Math.max(x1, q.u); y0 = Math.min(y0, q.v); y1 = Math.max(y1, q.v); }
  return { x0, y0, x1, y1, front };
}
/** A performer's face (with hair / ears margin) and torso as screen rects. */
export function performerRects(p: Performer, cam: THREE.PerspectiveCamera): { face: Rect; body: Rect } {
  const s = p.face.size;
  const r = new THREE.Vector3().crossVectors(cam.getWorldDirection(new THREE.Vector3()), UP).normalize();
  const f = p.face.center;
  const face = rectOf([f.clone().addScaledVector(r, -s * 0.95).add(new THREE.Vector3(0, s * 1.05, 0)), f.clone().addScaledVector(r, s * 0.95).add(new THREE.Vector3(0, -s * 0.9, 0))], cam);
  const body = rectOf([f.clone().addScaledVector(r, -s * 1.9).add(new THREE.Vector3(0, s * 1.05, 0)), p.floor.clone().addScaledVector(r, s * 1.9).setY(Math.max(p.floor.y, f.y - p.height * 0.62))], cam);
  return { face, body };
}

// ---------------------------------------------------------------- hanging props (monitor / board)
export interface PropSearch {
  /** Display height / width. */
  aspect: number;
  /** Wanted display height as a fraction of the frame height. */
  frac: number;
  /** Physical height limits (m). */
  minH: number; maxH: number;
  side: 'auto' | 'left' | 'right';
  /** Previous side (-1 left / +1 right / 0 none) — stays put when it is still as good. */
  prevSide: number;
  /** Prefer the upper part of the frame (board) or the middle (monitor). */
  vPref: number;
  /** Authored placements (CHAT_MONITOR_xx / scene.json), tried first. */
  authored: PropPlacement[];
}

export interface PropCheck { ok: boolean; rect: Rect; score: number }

/** Screen-space part: in frame, clear of faces / bodies / keep-outs; the score. */
function propCheap(ctx: ShotContext, s: PropSearch, pl: PropPlacement, cam: THREE.PerspectiveCamera): PropCheck {
  const W = pl.width, H = W * s.aspect;
  const q = new THREE.Quaternion().setFromAxisAngle(UP, pl.yaw);
  const at = (x: number, y: number) => new THREE.Vector3(x, y, 0).applyQuaternion(q).add(pl.center);
  const rect = rectOf([at(-W / 2, -H / 2), at(W / 2, -H / 2), at(-W / 2, H / 2 + 0.25), at(W / 2, H / 2 + 0.25)], cam);   // + the housing
  const bad = { ok: false, rect, score: 99 };
  if (!rect.front) return bad;
  const m = 0.015;
  if (rect.x0 < m || rect.x1 > 1 - m || rect.y0 < m || rect.y1 > 1 - m) return bad;
  // the cables / ropes / mast it hangs from, up to the ceiling (or 1.5 m): they must not cross a face either
  const top = Math.max(pl.center.y + H / 2 + 0.3, pl.ceilingY > pl.center.y ? pl.ceilingY : pl.center.y + H / 2 + 1.5);
  const hang = rectOf([at(-W * 0.45, H / 2 + 0.25), at(W * 0.45, top - pl.center.y)], cam);
  let bodyHit = 0;
  for (const p of ctx.performers) {
    const pr = performerRects(p, cam);
    const fr = { x0: pr.face.x0 - 0.02, y0: pr.face.y0 - 0.02, x1: pr.face.x1 + 0.02, y1: pr.face.y1 + 0.02 };
    if (rectOverlap(rect, fr) > 0) return bad;
    if (hang.front && rectOverlap(hang, fr) > 0 && p.face.center.distanceTo(cam.position) > pl.center.distanceTo(cam.position)) return bad;
    // the shot's subject keeps their whole body clear; a neighbour's torso may sit behind a prop (faces never)
    bodyHit += (p === ctx.anchor ? 1 : 0.4) * rectOverlap(rect, pr.body) / Math.max(1e-4, (pr.body.x1 - pr.body.x0) * (pr.body.y1 - pr.body.y0));
  }
  // (an authored anchor — a laptop on the crate beside the armchair — may sit in front of a torso; never a face)
  if (bodyHit > (pl.source === 'auto' ? 0.12 : 0.45)) return bad;
  for (const k of ctx.keepOut) if (rectOverlap(rect, { x0: k.x0 - 0.015, y0: k.y0 - 0.015, x1: k.x1 + 0.015, y1: k.y1 + 0.015 }) > 0) return bad;
  const hFrac = rect.y1 - rect.y0;
  const cx = (rect.x0 + rect.x1) / 2, cy = (rect.y0 + rect.y1) / 2;
  const side = cx < 0.5 ? -1 : 1;
  let score = Math.abs(hFrac - s.frac) * 3 + Math.abs(cy - s.vPref) * 1.2 + bodyHit * 4;
  if (s.side !== 'auto' && side !== (s.side === 'left' ? -1 : 1)) score += 5;
  if (s.side === 'auto' && s.prevSide && side !== s.prevSide) score += 0.35;
  if (ctx.anchor) {
    const dA = ctx.anchor.face.center.distanceTo(cam.position), dP = pl.center.distanceTo(cam.position);
    score += Math.abs(dP / dA - 1.15) * 0.8;
    if (dP < dA * 0.8) score += 2;                   // don't hang in front of the host
    else if (dP < dA * 0.95) score += 0.6;
  }
  return { ok: true, rect, score };
}
/** Room part: not inside furniture, nothing between the camera and the display, not through a wall. */
function propRoomOk(ctx: ShotContext, s: PropSearch, pl: PropPlacement, cam: THREE.PerspectiveCamera): boolean {
  const W = pl.width, H = W * s.aspect;
  const q = new THREE.Quaternion().setFromAxisAngle(UP, pl.yaw);
  const at = (x: number, y: number, z = 0) => new THREE.Vector3(x, y, z).applyQuaternion(q).add(pl.center);
  const pts = [[0, 0], [-0.45, -0.4], [0.45, 0.4], [-0.45, 0.4], [0.45, -0.4]].map(([x, y]) => at(x * W, y * H, 0.03));
  if (pl.source === 'auto' && pts.some((p) => ctx.rays.insideCollider(p, 0.05))) return false;   // (authored anchors may rest on furniture)
  if (!ctx.rays.clear(at(-W / 2, 0, 0.02), at(W / 2, 0, 0.02)) || !ctx.rays.clear(at(0, -H / 2, 0.02), at(0, H / 2, 0.02))) return false;
  return pts.every((p) => ctx.rays.clear(cam.position, p));
}

/** Is a placement good for this shot? */
export function checkProp(ctx: ShotContext, s: PropSearch, pl: PropPlacement, cam = camOf(ctx.pose, ctx.aspect)): PropCheck {
  const c = propCheap(ctx, s, pl, cam);
  if (!c.ok || !propRoomOk(ctx, s, pl, cam)) return { ...c, ok: false };
  return c;
}

/** Authored anchors first, then camera-space candidates (cheap score for all, rays in score order). */
export function* searchProp(ctx: ShotContext, s: PropSearch): Generator<void, { place: PropPlacement; check: PropCheck } | null, void> {
  const cam = camOf(ctx.pose, ctx.aspect);
  let best: { place: PropPlacement; check: PropCheck } | null = null;
  for (const pl of s.authored) { const c = checkProp(ctx, s, pl, cam); if (c.ok && (!best || c.score < best.check.score)) best = { place: pl, check: c }; }
  if (best) return best;
  yield;
  const fwd = cam.getWorldDirection(new THREE.Vector3());
  const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
  const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
  const vt = Math.tan(THREE.MathUtils.degToRad(ctx.pose.fov) / 2), ht = vt * ctx.aspect;
  const dA = ctx.anchor ? Math.max(1, ctx.anchor.face.center.clone().sub(cam.position).dot(fwd)) : 3;
  const cands: { pl: PropPlacement; c: PropCheck }[] = [];
  let n = 0;
  // (a performer against a wall leaves no room behind them: nearer depths to the side are tried too, costing a little)
  for (const dk of [1.05, 1.25, 1.5, 0.92, 1.85, 2.3, 0.82, 0.72]) for (const u of [0.2, 0.8, 0.13, 0.87, 0.28, 0.72, 0.36, 0.64]) for (const v of [s.vPref, s.vPref - 0.1, s.vPref + 0.1, 0.3, 0.55, 0.2]) for (const fk of [1, 0.8, 0.62, 0.48]) {
    const d = dA * dk;
    const Hm = THREE.MathUtils.clamp(s.frac * fk * 2 * d * vt, s.minH, s.maxH);
    const Wm = Hm / s.aspect;
    const c = cam.position.clone().addScaledVector(fwd, d).addScaledVector(right, (2 * u - 1) * d * ht).addScaledVector(up, (1 - 2 * v) * d * vt);
    if (c.y - Hm / 2 < 0.35) continue;                                        // would sit on the floor
    const to = cam.position.clone().sub(c).setY(0);
    const pl: PropPlacement = { center: c, yaw: Math.atan2(to.x, to.z), width: Wm, ceilingY: 0, source: 'auto' };
    const ch = propCheap(ctx, s, pl, cam);
    if (ch.ok) cands.push({ pl, c: ch });
    if (++n % 120 === 0) yield;
  }
  cands.sort((a, b) => a.c.score - b.c.score);
  n = 0;
  for (const cd of cands) {
    const ceil = ctx.rays.ceilingAbove(cd.pl.center) ?? cd.pl.center.y + cd.pl.width * s.aspect / 2 + 1.4;
    if (ceil >= cd.pl.center.y + cd.pl.width * s.aspect / 2 + 0.3 && propRoomOk(ctx, s, cd.pl, cam)) { cd.pl.ceilingY = ceil; return { place: cd.pl, check: cd.c }; }
    if (++n % 3 === 0) yield;
  }
  return null;
}

// ---------------------------------------------------------------- the chat buddy's stand point
export interface BuddySearch { height: number; prev: THREE.Vector3 | null; avoid: Rect[]; preferSide: number }
export interface BuddyPick { pos: THREE.Vector3; yaw: number; score: number; inFrame: boolean }
type BuddyCheck = { ok: boolean; score: number; inFrame: boolean; offFrame?: boolean };

/** Buddy body (feet → head) as a screen rect + its upper body (head + tablet). */
export function buddyRect(pos: THREE.Vector3, h: number, cam: THREE.PerspectiveCamera) {
  const r = new THREE.Vector3().crossVectors(cam.getWorldDirection(new THREE.Vector3()), UP).normalize();
  const body = rectOf([pos.clone().addScaledVector(r, -h * 0.42), pos.clone().addScaledVector(r, h * 0.42).setY(pos.y + h * 1.02)], cam);
  const upper = rectOf([pos.clone().addScaledVector(r, -h * 0.34).setY(pos.y + h * 0.38), pos.clone().addScaledVector(r, h * 0.34).setY(pos.y + h * 1.02)], cam);
  return { body, upper };
}

/** Screen-space + floor part (no rays). */
function buddyCheap(ctx: ShotContext, b: BuddySearch, pos: THREE.Vector3, cam: THREE.PerspectiveCamera): BuddyCheck {
  const no = { ok: false, score: 99, inFrame: false };
  const h = b.height;
  for (const s of ctx.spots) if (Math.hypot(s.x - pos.x, s.z - pos.z) < 0.78) return no;
  for (const p of ctx.performers) if (Math.hypot(p.floor.x - pos.x, p.floor.z - pos.z) < 0.7) return no;
  for (const y of [0.15, 0.5, 0.9]) if (ctx.rays.insideCollider(new THREE.Vector3(pos.x, pos.y + y * h, pos.z), 0.22)) return no;
  const { body, upper } = buddyRect(pos, h, cam);
  if (!body.front) return no;
  const m = 0.02;
  const inFrame = upper.x0 > m && upper.x1 < 1 - m && upper.y0 > m && upper.y1 < 1 - m;
  // nowhere good in this shot: wait just outside it (never a half-cut frog at the edge)
  const offFrame = body.x1 < -0.02 || body.x0 > 1.02 || body.y0 > 1.02;
  if (!inFrame && !offFrame) return { ...no, inFrame };
  let score = 0;
  if (inFrame) {
    for (const p of ctx.performers) {
      const pr = performerRects(p, cam);
      if (rectOverlap(upper, pr.face) > 0) return no;
      score += rectOverlap(body, pr.body) / Math.max(1e-4, (pr.body.x1 - pr.body.x0) * (pr.body.y1 - pr.body.y0)) * 3;
    }
    for (const k of [...ctx.keepOut, ...b.avoid]) if (rectOverlap(upper, k) > 0.002) score += 4 + rectOverlap(upper, k) * 40;
    score += Math.abs(Math.min(0.5, upper.y1 - upper.y0) - 0.5) * 2.2;         // bigger is better, up to half the frame
    if (b.preferSide) { const cx = (upper.x0 + upper.x1) / 2; if (Math.sign(cx - 0.5) !== b.preferSide) score += 0.8; }
  }
  if (ctx.anchor) {
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    const dA = ctx.anchor.floor.clone().sub(cam.position).dot(fwd), dB = pos.clone().sub(cam.position).dot(fwd);
    // in front of the host: only off to the side (never over anyone) and not much closer (no photobombing)
    if (dB < dA - 0.1) {
      if (dB < dA * 0.72) return no;
      for (const p of ctx.performers) if (rectOverlap(body, performerRects(p, cam).body) > 0) return no;
      score += (dA - dB) * 0.8;
    }
    score += Math.abs(Math.hypot(pos.x - ctx.anchor.floor.x, pos.z - ctx.anchor.floor.z) - 1.2) * 0.35;
  }
  if (b.prev && pos.distanceTo(b.prev) < 0.05) score -= 0.4;        // stay put when it's as good
  return { ok: true, score, inFrame, offFrame };
}
/** Ray part: seen by the camera (head, face, both tablet sides, body — furniture in front = no) and no wall
 *  between him and the host. Off-frame waiting points only need the wall test. */
function buddyRaysOk(ctx: ShotContext, b: BuddySearch, pos: THREE.Vector3, cam: THREE.PerspectiveCamera, inFrame: boolean): boolean {
  // (above the furniture: the host may sit INSIDE a couch's mesh; walls are taller than 1.3 m)
  if (ctx.anchor && !ctx.rays.clear(ctx.anchor.floor.clone().setY(1.3), pos.clone().setY(1.3))) return false;
  if (!inFrame) return true;
  const h = b.height;
  const side = new THREE.Vector3().crossVectors(cam.getWorldDirection(new THREE.Vector3()), UP).normalize();
  for (const [x, y] of [[0, 0.92], [0, 0.78], [0.42, 0.62], [-0.42, 0.62], [0, 0.48], [0.25, 0.3], [-0.25, 0.3]]) {
    if (!ctx.rays.clear(cam.position, pos.clone().addScaledVector(side, x * h).setY(pos.y + y * h))) return false;
  }
  return true;
}

export function checkBuddy(ctx: ShotContext, b: BuddySearch, pos: THREE.Vector3, cam = camOf(ctx.pose, ctx.aspect)): BuddyCheck {
  const c = buddyCheap(ctx, b, pos, cam);
  if (!c.ok || !buddyRaysOk(ctx, b, pos, cam, c.inFrame)) return { ...c, ok: false };
  return c;
}

export function* searchBuddy(ctx: ShotContext, b: BuddySearch): Generator<void, BuddyPick | null, void> {
  const cam = camOf(ctx.pose, ctx.aspect);
  const faceCam = (p: THREE.Vector3) => { const to = cam.position.clone().sub(p).setY(0); return Math.atan2(to.x, to.z); };
  const a = ctx.anchor?.floor ?? ctx.pose.position.clone().add(new THREE.Vector3(0, 0, -3)).setY(0);
  const inF: { p: THREE.Vector3; s: number }[] = [], out: { p: THREE.Vector3; s: number }[] = [];
  const pts = b.prev ? [b.prev.clone()] : [];
  for (const r of [1.0, 1.3, 1.65, 2.05, 2.5, 3.1]) for (let k = 0; k < 24; k++) { const t = (k / 24) * Math.PI * 2; pts.push(new THREE.Vector3(a.x + Math.cos(t) * r, 0, a.z + Math.sin(t) * r)); }
  let n = 0;
  for (const p of pts) {
    const c = buddyCheap(ctx, b, p, cam);
    if (c.ok) (c.inFrame ? inF : out).push({ p, s: c.inFrame ? c.score : Math.hypot(p.x - a.x, p.z - a.z) });
    if (++n % 48 === 0) yield;
  }
  inF.sort((x, y) => x.s - y.s);
  out.sort((x, y) => x.s - y.s);
  n = 0;
  for (const c of inF) { if (buddyRaysOk(ctx, b, c.p, cam, true)) return { pos: c.p, yaw: faceCam(c.p), score: c.s, inFrame: true }; if (++n % 3 === 0) yield; }
  for (const c of out) { if (buddyRaysOk(ctx, b, c.p, cam, false)) return { pos: c.p, yaw: faceCam(c.p), score: c.s, inFrame: false }; if (++n % 3 === 0) yield; }
  return null;
}
