// Projector-screen guests (look 'projector', shared/tv.ts): WHERE their pull-down screens hang in any room, and how the
// room treats them as performers.
//
// Placement (every page computes the same, from room data + the host's spot):
//  1. scene.json `projectorScreens: [{ position: [x, y, z] (screen centre, room space), yaw (deg), width }]`, or room
//     nodes PROJECTOR_01…03 (empties at the screen centre, +Z towards the audience; scale.x = width) — in that order;
//  2. otherwise searched beside the host: both sides at 1.2–4 m, a little behind their line, centre 1.62 m above the
//     floor, facing the room's main camera (CAM_WIDE → CAM_TALK → CAM_REACT). A candidate must be visible from that
//     camera, not cut into walls / colliders, not stand on anyone's spot, never cover a performer's face or the react
//     screen as seen from the camera; the host's camera-left is preferred (the solo react screen arrives camera-right).
//     2–3 projector guests hang side by side.
// Integration (static hooks on SceneRuntime, see tvPage.ts): each projector guest gets a synthetic spot (index 100+) at
// the floor under its screen, facing the camera — so movers pop them in (no walk), and every camera (talk, group,
// tiles, the shot solver) frames the SCREEN as their face. In Interview mode a projector guest listed on the show goes
// on talkshow's monitor instead (their screen stays up). Talk camera: cuts to a projector guest while they speak
// (host setting TV_BAG.cut).
import * as THREE from 'three';
import type { SceneRuntime } from '../SceneRuntime.ts';
import { spotByIndex, type SpotInfo } from '../contract.ts';
import { RoomRays } from '../twoShot.ts';
import { HOST_KEY } from '../../../shared/scene.ts';

/** Screen centre height above the floor (m) — constant, so the performer's measured "face" never changes per room. */
export const PROJ_CY = 1.62;
export const PROJ_BASE_INDEX = 100;
/** Picture size for a feed aspect: 4:3 → 1.25 × 0.94 m, 16:9 → 1.45 × 0.82 m. */
export function projSize(aspect: number): { W: number; H: number } {
  const a = THREE.MathUtils.clamp(aspect || 4 / 3, 1.2, 1.8);
  const W = a >= 1.55 ? 1.45 : 1.25;
  return { W, H: W / a };
}

export interface ProjectorSlot {
  key: string;
  center: THREE.Vector3;
  yaw: number;
  W: number; H: number;
  floorY: number;
  /** Ceiling above the screen (null = open sky: the rig hangs from a stand-in height). */
  ceilingY: number | null;
  source: 'scene.json' | 'node' | 'auto' | 'fallback';
  spot: SpotInfo;
}

const UP = new THREE.Vector3(0, 1, 0);
/** SceneRuntime internals read here (private there: the ray cache, the react screen's fully-down corners). */
type AnyRt = { rays?: RoomRays | null; screen: { worldCorners?: () => THREE.Vector3[] } | null };

interface Rect { c: THREE.Vector3; r: THREE.Vector3; u: THREE.Vector3; n: THREE.Vector3; W: number; H: number }
function rectOf(c: THREE.Vector3, yaw: number, W: number, H: number): Rect {
  const n = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const r = new THREE.Vector3().crossVectors(UP, n).normalize();
  return { c, r, u: UP.clone(), n, W, H };
}
/** Does segment p0 → p1 pass through the rect (with margin m)? */
function segHits(p0: THREE.Vector3, p1: THREE.Vector3, R: Rect, m = 0.06): boolean {
  const d = p1.clone().sub(p0);
  const den = d.dot(R.n);
  if (Math.abs(den) < 1e-6) return false;
  const t = R.c.clone().sub(p0).dot(R.n) / den;
  if (t <= 0.02 || t >= 0.98) return false;
  const q = p0.clone().addScaledVector(d, t).sub(R.c);
  return Math.abs(q.dot(R.r)) < R.W / 2 + m && Math.abs(q.dot(R.u)) < R.H / 2 + m;
}
function rectPoints(R: Rect): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const x of [-0.45, 0, 0.45]) for (const y of [-0.45, 0, 0.45]) out.push(R.c.clone().addScaledVector(R.r, x * R.W).addScaledVector(R.u, y * R.H));
  return out;
}
/** Horizontal distance from point p to the screen's bottom edge segment. */
function distToScreen(p: THREE.Vector3, R: Rect): number {
  const a = R.c.clone().addScaledVector(R.r, -R.W / 2), b = R.c.clone().addScaledVector(R.r, R.W / 2);
  a.y = b.y = p.y = 0;
  const ab = b.clone().sub(a), t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1);
  return a.addScaledVector(ab, t).distanceTo(p);
}

function makeSpot(i: number, floor: THREE.Vector3, yaw: number): SpotInfo {
  const node = new THREE.Group();
  node.name = `PROJECTOR_SPOT_${i + 1}`;
  node.position.copy(floor);
  node.rotation.y = yaw;
  const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  return { index: PROJ_BASE_INDEX + i, name: node.name, node, pose: 'stand', seatHeight: 0, seatDepth: 0, label: `Projector ${i + 1}`,
    position: floor.clone(), forward, yaw, cam: null, leavePathAt: null, approach: [], extras: { projector: true }, sizes: null };
}

/** The camera the audience mostly sees the room through. */
function viewerOf(rt: SceneRuntime, host: SpotInfo): THREE.Vector3 {
  const c = rt.room.cameras.get('CAM_WIDE') ?? rt.room.cameras.get('CAM_TALK') ?? rt.room.cameras.get('CAM_REACT');
  if (c) return c.position.clone();
  return host.position.clone().addScaledVector(host.forward, 4.5).setY(host.position.y + 1.5);
}
/** The room's wide camera as a three.js camera (16:9), to keep screens inside its frame; null = no authored wide. */
function wideCam(rt: SceneRuntime): THREE.PerspectiveCamera | null {
  const c = rt.room.cameras.get('CAM_WIDE') ?? rt.room.cameras.get('CAM_TALK');
  if (!c) return null;
  const cam = new THREE.PerspectiveCamera(c.fov, 16 / 9, 0.05, 200);
  cam.position.copy(c.position); cam.quaternion.copy(c.quaternion);
  cam.updateMatrixWorld(true);
  return cam;
}
/** The rect's box in the camera's frame (NDC). */
function ndcBox(cam: THREE.PerspectiveCamera, R: Rect): THREE.Box2 {
  const b = new THREE.Box2();
  for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) { const v = R.c.clone().addScaledVector(R.r, x * R.W).addScaledVector(R.u, y * R.H).project(cam); b.expandByPoint(new THREE.Vector2(v.x, v.y)); }
  return b;
}
/** Two screens overlap as the camera sees them (one would hide part of the other). */
function overlapInView(cam: THREE.PerspectiveCamera, A: Rect, B: Rect): boolean {
  const a = ndcBox(cam, A), b = ndcBox(cam, B);
  const i = a.clone().intersect(b);
  if (i.isEmpty()) return false;
  const area = (x: THREE.Box2) => Math.max(0, x.max.x - x.min.x) * Math.max(0, x.max.y - x.min.y);
  return area(i) > 0.01 * Math.min(area(a), area(b));
}
function inFrame(cam: THREE.PerspectiveCamera, R: Rect): boolean {
  for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) {
    const v = R.c.clone().addScaledVector(R.r, x * R.W).addScaledVector(R.u, y * R.H).project(cam);
    if (v.z > 1 || Math.abs(v.x) > 0.94 || Math.abs(v.y) > 0.92) return false;
  }
  return true;
}

/** Plan the screens for `members` (in join order). Pure function of the room + state (deterministic on every page). */
export function planProjectors(rt: SceneRuntime, members: { key: string; aspect: number }[]): ProjectorSlot[] {
  const R_ = rt as unknown as AnyRt;
  const room = rt.room;
  const rays = (R_.rays ??= new RoomRays(room));
  const st = rt.state;
  const hostIdx = st.spots[HOST_KEY];
  const host = (typeof hostIdx === 'number' ? spotByIndex(room, hostIdx) : null) ?? room.spots.find((s) => !!s) ?? null;
  if (!host) return [];
  const viewer = viewerOf(rt, host);
  const wide = wideCam(rt);
  // everyone else: their spot + face (projector guests excluded)
  const others: { pos: THREE.Vector3; face: THREE.Vector3 }[] = [];
  for (const a of rt.actors.values()) {
    if (members.some((m) => m.key === a.key)) continue;
    const i = st.spots[a.key];
    const s = (typeof i === 'number' ? spotByIndex(room, i) : null) ?? (a.spot && a.spot.index < PROJ_BASE_INDEX ? a.spot : null) ?? (a.key === HOST_KEY ? host : null);
    if (!s) continue;
    const f = a.rest ? a.faceAt(s)?.center : null;
    others.push({ pos: s.position.clone(), face: f ?? s.position.clone().setY(s.position.y + (s.pose === 'sit' ? 1.15 : 1.45)) });
  }
  if (!others.length) others.push({ pos: host.position.clone(), face: host.position.clone().setY(host.position.y + 1.4) });
  // the react screen (fully down) as seen from the viewer: nothing may cover it
  let screenPts: THREE.Vector3[] = [];
  try { screenPts = R_.screen?.worldCorners?.() ?? []; } catch { screenPts = []; }
  if (screenPts.length) screenPts.push(screenPts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / screenPts.length));
  if (rt.solo) { const f = rt.solo.frame(); screenPts.push(f.center); }

  const toV = viewer.clone().sub(host.position).setY(0);
  if (toV.lengthSq() < 1e-4) toV.copy(host.forward);
  toV.normalize();
  const d = toV.clone().negate();                          // the viewer's look direction
  const camLeft = new THREE.Vector3(d.z, 0, -d.x);          // viewer's left (the solo screen goes to their right)
  const hostFloor = host.position.y;
  const out: ProjectorSlot[] = [];
  const placed: Rect[] = [];
  const info = rt.info as unknown as { projectorScreens?: { position?: unknown; yaw?: unknown; width?: unknown }[] };
  const authored: { c: THREE.Vector3; yaw: number; W: number | null; src: 'scene.json' | 'node' }[] = [];
  for (const j of Array.isArray(info.projectorScreens) ? info.projectorScreens.slice(0, 3) : []) {
    const p = j?.position;
    if (Array.isArray(p) && p.length === 3 && p.every((v) => Number.isFinite(v))) authored.push({ c: room.root.localToWorld(new THREE.Vector3(...(p as number[]))), yaw: THREE.MathUtils.degToRad(Number(j.yaw) || 0), W: Number(j.width) > 0 ? THREE.MathUtils.clamp(Number(j.width), 0.6, 3) : null, src: 'scene.json' });
  }
  if (!authored.length) {
    const nodes: THREE.Object3D[] = [];
    room.root.traverse((o) => { if (/^PROJECTOR_\d\d$/.test(o.name)) nodes.push(o); });
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of nodes.slice(0, 3)) {
      n.updateWorldMatrix(true, false);
      const c = n.getWorldPosition(new THREE.Vector3());
      const f = new THREE.Vector3(0, 0, 1).applyQuaternion(n.getWorldQuaternion(new THREE.Quaternion())).setY(0).normalize();
      authored.push({ c, yaw: Math.atan2(f.x, f.z), W: Math.abs(n.getWorldScale(new THREE.Vector3()).x - 1) > 0.05 ? n.getWorldScale(new THREE.Vector3()).x : null, src: 'node' });
    }
  }

  members.forEach((m, i) => {
    const { W: W0, H: H0 } = projSize(m.aspect);
    const a = authored[i];
    let best: { c: THREE.Vector3; yaw: number; floorY: number; score: number; W: number; H: number; src: ProjectorSlot['source'] } | null = null;
    if (a) {
      const W = a.W ?? W0, H = W * (H0 / W0);
      best = { c: a.c, yaw: a.yaw, floorY: rays.floorBelow(a.c) ?? a.c.y - PROJ_CY, score: 0, W, H, src: a.src };
    } else {
      const W = W0, H = H0;
      for (const side of [1, -1]) for (const dist of [1.25, 1.55, 1.85, 2.2, 2.6, 3.0, 3.5, 4.0]) for (const back of [0.15, 0.5, 0.9, -0.2]) {
        const base = host.position.clone().addScaledVector(camLeft, side * dist).addScaledVector(toV, -back);
        const probe = base.clone().setY(hostFloor + PROJ_CY);
        const fy = rays.floorBelow(probe.clone().setY(hostFloor + 1.0), 3);
        const floorY = fy !== null && Math.abs(fy - hostFloor) < 0.6 ? fy : hostFloor;
        const c = base.clone().setY(floorY + PROJ_CY);
        const tv = viewer.clone().sub(c).setY(0);
        const yaw = Math.atan2(tv.x, tv.z);
        const R = rectOf(c, yaw, W, H);
        // --- hard rules
        let bad = false;
        // inside the room, visible from the camera, not buried in furniture / walls
        if (fy === null && !rt.room.bounds.containsPoint(c)) bad = true;
        if (wide && !inFrame(wide, R)) bad = true;                    // the audience's wide shot shows it whole
        for (const p of rectPoints(R)) if (rays.insideCollider(p, 0.05)) { bad = true; break; }
        if (!bad && !rays.clear(viewer, c)) bad = true;
        if (!bad) { let blocked = 0; for (const p of rectPoints(R)) if (!rays.clear(viewer, p)) blocked++; if (blocked > 2) bad = true; }
        if (!bad) for (const s of [1, -1]) if (rays.hit(c, c.clone().addScaledVector(R.r, s * (W / 2 + 0.08))) !== Infinity) { bad = true; break; }
        // never on anyone's spot, never in front of a face or the react screen
        if (!bad) for (const o of others) {
          if (distToScreen(o.pos.clone(), R) < 0.5) { bad = true; break; }
          if (segHits(viewer, o.face, R, 0.1)) { bad = true; break; }
        }
        if (!bad) for (const p of screenPts) if (segHits(viewer, p, R, 0.05)) { bad = true; break; }
        // not overlapping the screens already placed (as the camera sees them, too)
        if (!bad) for (const P of placed) if (P.c.distanceTo(c) < (P.W + W) / 2 + 0.12 || segHits(viewer, P.c, R, 0) || (wide && overlapInView(wide, P, R))) { bad = true; break; }
        if (bad) continue;
        // --- preferences: close beside the host, camera-left, near the previous screen (side by side), not far back
        let score = Math.abs(dist - 1.9) * 0.9 + Math.abs(back - 0.3) * 0.7 + (side < 0 ? 0.55 : 0);
        if (placed.length) {
          const last = placed[placed.length - 1];
          score += Math.abs(last.c.distanceTo(c) - ((last.W + W) / 2 + 0.25)) * 1.4;
        }
        if (!best || score < best.score) best = { c, yaw, floorY, score, W, H, src: 'auto' };
      }
      if (!best) {
        // nothing clean: behind the host's camera-left shoulder, above head height (still readable)
        const c = host.position.clone().addScaledVector(camLeft, 1.4 + i * (W + 0.2)).addScaledVector(toV, -1.0).setY(hostFloor + PROJ_CY + 0.25);
        const tv = viewer.clone().sub(c).setY(0);
        best = { c, yaw: Math.atan2(tv.x, tv.z), floorY: hostFloor + 0.25, score: 99, W, H, src: 'fallback' };
      }
    }
    const R = rectOf(best.c, best.yaw, best.W, best.H);
    placed.push(R);
    const ceil = rays.ceilingAbove(best.c.clone().add(new THREE.Vector3(0, best.H / 2 + 0.02, 0)), 8);
    const floor = best.c.clone().setY(best.c.y - PROJ_CY);
    out.push({ key: m.key, center: best.c, yaw: best.yaw, W: best.W, H: best.H, floorY: best.floorY, ceilingY: ceil, source: best.src, spot: makeSpot(i, floor, best.yaw) });
  });
  return out;
}

// ---------------------------------------------------------------- per-room cache + the SceneRuntime hooks
interface Plan { sig: string; slots: ProjectorSlot[] }
const plans = new WeakMap<SceneRuntime, Plan>();

/** Projector members on this page (tvPage fills it): key → picture aspect. */
export type ProjectorMembers = () => { key: string; aspect: number }[];

export function projectorPlan(rt: SceneRuntime, members: { key: string; aspect: number }[]): ProjectorSlot[] {
  const st = rt.state;
  // (the others' spots change the plan: recompute when anyone moves; keep the SAME SpotInfo objects otherwise —
  //  the runtime compares spots by identity)
  const sig = JSON.stringify([rt.info.id, st.spots, members, !!rt.solo, [...rt.actors.keys()].sort()]);
  let p = plans.get(rt);
  if (!p || p.sig !== sig) {
    const slots = planProjectors(rt, members);
    // keep identical spots stable across re-plans (no pop-out / pop-in when nothing moved for them)
    if (p) for (const s of slots) {
      const o = p.slots.find((x) => x.key === s.key);
      if (o && o.spot.position.distanceTo(s.spot.position) < 1e-3 && Math.abs(o.yaw - s.yaw) < 1e-4 && o.W === s.W) { s.spot = o.spot; }
    }
    p = { sig, slots };
    plans.set(rt, p);
  }
  return p.slots;
}
export function slotFor(rt: SceneRuntime | null, key: string): ProjectorSlot | null {
  return (rt && plans.get(rt)?.slots.find((s) => s.key === key)) ?? null;
}
