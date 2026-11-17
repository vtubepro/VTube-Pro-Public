// Chat buddy placement (any avatar the user picks — Sprocket by default), TABLET FIRST — and ALWAYS IN THE SHOT while he is on: for the current shot, find where he
// can stand (or perch) so his raised tablet is fully in frame, faces the lens, is big enough to read (the chat text
// ≥ ~14 px at 1080p — a bigger tablet or smaller text needs a bigger tablet on screen) and covers nobody's face, the
// react / solo screen or the chat monitor / board — and nothing in the room hides it or cuts through him.
// FACES ARE SACRED (owner rule): every plan is checked against face boxes projected through the shot's own camera —
// each performer's face and the buddy's OWN face — and rejected if the tablet touches one, at rest AND at the top of
// the cheer bounce (a plan whose bounce would reach a face gets a smaller / no bounce: TabletPlan.cheer). His head
// stays fully inside the frame (no head cut off by the top / side edge) and the chest hold is preferred; the tablet
// goes over his head only when nothing at chest height fits (never at face height).
//
// Candidates, best first:
//  1. world: authored anchors (BUDDY_SPOT_xx for the host's spot, BUDDY_SPOT — may be a shelf / railing / desk top:
//     he poofs up there — and the older CHAT_BUDDY_xx / CHAT_BUDDY), his current place, a grid of floor points laid
//     out in CAMERA space (across the frame, from well in front of the host to behind them) and PERCHES found by
//     probing the room (flat furniture tops under eye level: desks, counters, crates, shelves) — each at his normal
//     size, then (space is tight) 80 % / 64 % of it. Phase 1 scores every one in screen space (no rays); phase 2
//     ray-tests them in score order (tablet seen, nothing through his body or the tablet) — spread over frames.
//  2. fore: the foreground peek — he stands right in front of the lens in a bottom corner of the frame (feet below
//     the frame edge), tablet up: the real 3D buddy, lit by the room, glued to the camera (works in close-ups and in
//     React big-screen shots where the room has no free floor in view).
//  3. overlay: last resort (the foreground is blocked too): the tablet held into the frame from a bottom corner by
//     his arm, drawn on top.
import * as THREE from 'three';
import { camOf, performerRects, rectOf, rectOverlap, type Rect, type ShotContext } from './chatPlace.ts';
import { sanitizeBuddyTune } from '../../shared/buddyTune.ts';

const UP = new THREE.Vector3(0, 1, 0);

/** How a buddy model holds the tablet: proportions as fractions of his height (measured from the rig — buddyRig.ts —
 *  or a hand-tuned preset, TUNED_BUDDIES). */
export interface BuddyBody {
  /** Tablet centre for the one-handed hold (≈ chest). */
  chest: number;
  /** Top of a two-handed tablet (his chin: the head peeks over it). */
  chin: number;
  /** Head centre + half width (the head is kept off faces / screens). */
  head: number; headW: number;
  /** Face half-size (the measured face; absent = from head − chin, e.g. the hand-tuned mascot). Never covered. */
  face?: number;
  /** Top of his head (hair, ears, antenna; absent = head + 0.9 × headW) — kept inside the frame. */
  top?: number;
  /** Forward reach of the hold. */
  reach: number;
  /** one = at his side in one hand, two = in front with both hands (big tablets), stand = no usable arms: the tablet
   *  stands on a pole next to him. */
  hold: 'one' | 'two' | 'stand';
  /** Measured bodies: the chest's front ahead of the feet + the torso half-width (the tablet is held clear of a
   *  barrel chest / beside a wide body). Absent = the classic slim body. */
  front?: number; halfW?: number;
}
/** The classic tuned body (short arms, big head): the fallback before a rig is measured. */
export const CLASSIC_BODY: BuddyBody = { chest: 0.64, chin: 0.72, head: 0.82, headW: 0.3, reach: 0.36, hold: 'one' };
/** Hand-tuned buddies by avatar id; every other model is measured from its rig. */
export const TUNED_BUDDIES: Record<string, { body: BuddyBody; heightK: number; arm?: { skin: number; dark: number } }> = {
};
export type TunedBuddy = (typeof TUNED_BUDDIES)[string];

/** The hand tuning for a loaded buddy: the app's preset for this id (TUNED_BUDDIES) first, else the tuning the model
 *  carries in its own profile (AvatarProfile.buddy, shared/buddyTune.ts: survives the user library, crew packs, a
 *  renamed copy and public builds, which ship no presets). null = measure it from the rig. */
export function tunedBuddy(id: string, profileTune?: unknown): TunedBuddy | null {
  const preset = Object.prototype.hasOwnProperty.call(TUNED_BUDDIES, id) ? TUNED_BUDDIES[id] : undefined;
  if (preset) return preset;
  const t = sanitizeBuddyTune(profileTune);
  if (!t) return null;
  const hex = (s: string) => parseInt(s.slice(1), 16);
  return { body: t.body === 'classic' ? CLASSIC_BODY : { ...t.body }, heightK: t.heightK, ...(t.arm ? { arm: { skin: hex(t.arm.skin), dark: hex(t.arm.dark) } } : {}) };
}

/** Buddy + raised tablet geometry in world metres (room scale). */
export interface BuddyGeo {
  height: number;
  /** Tablet screen size (m). */
  tabW: number; tabH: number;
  /** Raised tablet centre relative to his root: up, forward (towards the camera), sideways (towards the holding hand). */
  tabUp: number; tabFwd: number; tabSide: number;
  hold: BuddyBody['hold'];
  /** Tablet centre heights to try (m above his root: chest / face / over his head) + a preference cost. */
  lifts: { up: number; cost: number }[];
  /** Head centre height + half width (m). */
  headUp: number; headW: number;
  /** His FACE box (m, around headUp): half width, extent below / above the face centre — the tablet never touches it. */
  faceHW: number; faceDn: number; faceUpX: number;
  /** Top of his head above his root (m). */
  headTop: number;
  /** Tablet height on screen (fraction of the frame): readable minimum, preferred, maximum. */
  hfMin: number; hfPref: number; hfMax: number;
  /** Held upright (3:4) — narrow gaps such as beside a big React screen. */
  portrait?: boolean;
}

/** The same tablet turned upright: the chat re-flows into a taller, narrower column (same text size), so it needs
 *  4/3 of the height on screen to stay readable. */
export function portraitGeo(g: BuddyGeo): BuddyGeo {
  if (g.portrait) return g;
  const hfMin = g.hfMin * 4 / 3;
  return { ...g, tabW: g.tabH, tabH: g.tabW, portrait: true, hfMin, hfPref: Math.max(g.hfPref, hfMin * 1.15), hfMax: Math.max(g.hfMax, hfMin * 1.9) };
}

/** His FACE box as fractions of his height, around the face centre (body.head): extent below (dn) / above (up) and
 *  half width (hw). Measured bodies: the face — grown toward the head's own size where the head is the face (a robot's
 *  screen head, a mascot), capped so long hair / pigtails don't swallow the chest; the tuned mascot (no measured face):
 *  the band from its chin up, most of the head wide. The tablet never touches this box. */
export function faceBand(body: Pick<BuddyBody, 'head' | 'chin' | 'headW' | 'face'>): { dn: number; up: number; hw: number } {
  if (body.face === undefined) {
    const fs = Math.max(0.04, (body.head - body.chin) / 0.9);
    return { dn: fs * 0.9, up: fs * 1.05, hw: Math.max(fs * 0.95, body.headW * 0.6) };
  }
  const fs = body.face, hw = body.headW;
  return { dn: Math.max(fs * 0.9, Math.min(hw * 0.9, fs * 1.6)), up: Math.max(fs * 1.05, Math.min(hw * 0.9, fs * 1.6)), hw: Math.max(fs * 0.95, Math.min(hw * 0.8, fs * 1.3)) };
}

/** Tablet size (× the classic tablet) above which it is held with both hands in front of him. */
export const TWO_HANDS_AT = 1.25;

export function buddyGeoFor(height: number, body: BuddyBody = CLASSIC_BODY, tablet = 1, hfMin = 0.125): BuddyGeo {
  const h = height;
  const tabW = h * 0.46 * tablet, tabH = tabW * 0.75;
  const hold: BuddyBody['hold'] = body.hold === 'stand' ? 'stand' : tablet > TWO_HANDS_AT ? 'two' : 'one';
  const headUp = h * body.head, headW = h * body.headW;
  // his face box (faceBand) and, over his head, the tablet's bottom edge above the top of it and of his head
  const fb = faceBand(body);
  const headTop = Math.max(headUp + headW * 0.9, h * (body.top ?? 0));
  const over = (tabH2: number) => Math.max(headUp + h * fb.up, headTop) + h * 0.02 + tabH2;
  let tabUp: number, tabFwd: number, tabSide: number, lifts: BuddyGeo['lifts'];
  // in front of the chest (a measured body: never inside it, even with the tablet turned ~25° to face a lens off to
  // the side: + a fifth of its width) — beside a wide torso for the stand
  const clearF = body.front !== undefined ? body.front + 0.06 + 0.2 * (tabW / Math.max(1e-6, h)) : 0;
  if (hold === 'one') {
    tabUp = h * body.chest; tabFwd = h * Math.max(body.reach, clearF); tabSide = h * 0.12;
    // a measured (human-proportioned) body: the chest hold keeps the face clear — the tablet's top under the chin
    if (body.front !== undefined) tabUp = Math.max(tabH / 2 + h * 0.22, Math.min(tabUp, h * body.chin - tabH / 2 - h * 0.01));
    // chest (preferred), a bit lower (his face well clear of it), over his head as the last resort — never at face height
    lifts = [{ up: tabUp, cost: 0 }, { up: Math.max(tabH / 2 + h * 0.22, tabUp - h * 0.14), cost: 0.1 }, { up: Math.max(headUp + h * 0.22, over(tabH / 2)), cost: 0.6 }];
  } else if (hold === 'two') {
    tabFwd = h * Math.max(0.24, body.reach * 0.9, clearF); tabSide = 0;
    const lo = tabH / 2 + h * 0.06;
    tabUp = Math.max(lo, h * body.chin - tabH / 2);
    // top under the chin (preferred), a bit lower, over his head as the last resort — never raised to face height
    lifts = [{ up: tabUp, cost: 0 }, { up: Math.max(lo, tabUp - h * 0.12), cost: 0.1 }, { up: Math.max(headUp + headW * 0.5 + tabH / 2, over(tabH / 2)), cost: 0.6 }];
  } else {
    tabFwd = h * Math.max(0.22, clearF * 0.5); tabSide = tabW / 2 + h * Math.max(0.16, (body.halfW ?? 0) + 0.05);                                      // on its pole beside him, a step forward
    tabUp = Math.max(tabH / 2 + h * 0.3, h * body.chest);
    lifts = [{ up: tabUp, cost: 0 }, { up: tabUp + h * 0.16, cost: 0.3 }];
  }
  const hfPref = THREE.MathUtils.clamp(Math.max(0.2, hfMin * 1.3), 0.2, 0.5);
  const hfMax = THREE.MathUtils.clamp(Math.max(0.45, hfMin * 1.9), 0.45, 0.72);
  return { height: h, tabW, tabH, tabUp, tabFwd, tabSide, hold, lifts, headUp, headW, faceHW: h * fb.hw, faceDn: h * fb.dn, faceUpX: h * fb.up, headTop, hfMin, hfPref, hfMax };
}

export interface TabletPlan {
  mode: 'world' | 'fore' | 'overlay';
  pos: THREE.Vector3;
  yaw: number;
  /** Which hand holds it / which side the stand is on (+1 avatar-left, −1 avatar-right) — away from the host. */
  side: 1 | -1;
  /** Overlay / fore: frame corner (−1 bottom-left, +1 bottom-right). */
  corner: -1 | 1;
  score: number;
  hf: number;
  /** Tablet centre height above his root (m): raised to chest, face or over his head. */
  lift: number;
  /** Stands on a perch above the floor (reached by a poof). */
  perch: boolean;
  source: string;
  /** His world height for this plan (m): smaller when space is tight, small in the foreground peek. */
  height: number;
  /** fore: tablet centre in the frame (u, v fractions, v down) at camera depth d (m) — re-applied every frame from the
   *  live camera. */
  fore?: { u: number; v: number; d: number };
  /** Tablet held upright (fore peek in a narrow gap). */
  portrait?: boolean;
  /** How much of the cheer bounce is allowed (1 = all, ½, 0 = none; absent = 1): `cheer` = the tablet lift
   *  (CHEER_LIFT × his height), `hop` = his hop (CHEER_HOP × his height) — the bounce never carries the tablet over a
   *  face either. */
  cheer?: number; hop?: number;
}

/** The cheer bounce chatBuddy.ts animates (fractions of his height): the tablet goes up by LIFT, his whole body hops HOP. */
export const CHEER_LIFT = 0.12, CHEER_HOP = 0.09;

export interface BuddyPlanInput {
  ctx: ShotContext;
  /** His normal world height (m) and the geometry at any height (tablet size, hold, readability). */
  height: number;
  geoAt: (height: number) => BuddyGeo;
  /** The chat monitor / board rects (keep clear). */
  avoid: Rect[];
  /** Where he is now (null = not in the room). */
  cur: THREE.Vector3 | null;
  /** Authored anchors (world floor / perch points). */
  anchors: { pos: THREE.Vector3; source: string }[];
  /** Prefer the frame side opposite the monitor (−1 / +1 / 0). */
  preferSide: number;
  /** Places that turned out hidden on screen for this shot (the live check) — skipped. */
  bad?: THREE.Vector3[];
  /** Exact check of the few best candidates (three.js raycast against the room meshes + performers). */
  exact?: (points: THREE.Vector3[], from: THREE.Vector3) => boolean;
  /** Skip the world search / the foreground peek (tests; the live check found them hidden). */
  noWorld?: boolean;
  noFore?: boolean;
  /** Debug: why foreground-peek candidates were dropped (counts). */
  trace?: Record<string, number>;
}

/** The raised tablet's centre + corners (world) for a buddy at `pos` facing the camera. Given the camera itself, the
 *  tablet is parallel to the image plane (square on screen: no tilt / keystone at the frame edges of a wide or pitched
 *  shot — the most readable it can be); given only a position it faces that point. */
export function tabletCorners(pos: THREE.Vector3, camOrPos: THREE.Vector3 | THREE.Camera, geo: BuddyGeo, side: number) {
  const camPos = camOrPos instanceof THREE.Vector3 ? camOrPos : camOrPos.getWorldPosition(new THREE.Vector3());
  const camQ = camOrPos instanceof THREE.Vector3 ? null : camOrPos.getWorldQuaternion(new THREE.Quaternion());
  const toCam = camPos.clone().sub(pos).setY(0);
  const yaw = Math.atan2(toCam.x, toCam.z);
  const f = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const left = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));      // avatar +X (his left) after the yaw
  const c = pos.clone().addScaledVector(UP, geo.tabUp).addScaledVector(f, geo.tabFwd).addScaledVector(left, side * geo.tabSide);
  const n = camQ ? new THREE.Vector3(0, 0, 1).applyQuaternion(camQ) : camPos.clone().sub(c).normalize();
  const r = camQ ? new THREE.Vector3(1, 0, 0).applyQuaternion(camQ) : new THREE.Vector3().crossVectors(UP, n).normalize();
  const u = new THREE.Vector3().crossVectors(n, r).normalize();
  const at = (x: number, y: number) => c.clone().addScaledVector(r, x * geo.tabW / 2).addScaledVector(u, y * geo.tabH / 2);
  return { yaw, center: c, corners: [at(-1, -1), at(1, -1), at(-1, 1), at(1, 1)], at, f, left };
}

/** Mount position that puts the tablet centre at `c` (inverse of tabletCorners; the yaw depends on the position). */
export function mountFor(c: THREE.Vector3, camPos: THREE.Vector3, geo: BuddyGeo, side: number): THREE.Vector3 {
  let pos = c.clone().addScaledVector(UP, -geo.tabUp);
  for (let i = 0; i < 3; i++) {
    const toCam = camPos.clone().sub(pos).setY(0);
    const yaw = Math.atan2(toCam.x, toCam.z);
    const f = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), left = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    pos = c.clone().addScaledVector(UP, -geo.tabUp).addScaledVector(f, -geo.tabFwd).addScaledVector(left, -side * geo.tabSide);
  }
  return pos;
}

/** A point at camera depth `d` (m) under frame position (u, v) (fractions, v down) — works with zoom / view offsets. */
export function viewPoint(cam: THREE.PerspectiveCamera, u: number, v: number, d: number): THREE.Vector3 {
  const p = new THREE.Vector3(u * 2 - 1, 1 - v * 2, 0.5).applyMatrix4(cam.projectionMatrixInverse);
  p.multiplyScalar(-d / p.z);
  return p.applyMatrix4(cam.matrixWorld);
}

interface Cand { pos: THREE.Vector3; perch: boolean; source: string }
interface PR { face: Rect; body: Rect; depth: number }
interface Pre { cam: THREE.PerspectiveCamera; fwd: THREE.Vector3; rgt: THREE.Vector3; prs: PR[]; keep: Rect[]; hostU: number | null; dA: number | null; hostIn: boolean }

function prep(inp: BuddyPlanInput): Pre {
  const { ctx } = inp;
  const cam = camOf(ctx.pose, ctx.aspect);
  const fwd = cam.getWorldDirection(new THREE.Vector3());
  const rgt = new THREE.Vector3().crossVectors(fwd, UP).normalize();
  const prs = ctx.performers.map((q) => {
    const pr = performerRects(q, cam);
    return { face: { x0: pr.face.x0 - 0.015, y0: pr.face.y0 - 0.015, x1: pr.face.x1 + 0.015, y1: pr.face.y1 + 0.015 }, body: pr.body, depth: q.face.center.clone().sub(cam.position).dot(fwd) };
  });
  // the host / talk focus in this shot at all? (overview / raid cameras may not show them)
  const hr = ctx.anchor ? rectOf([ctx.anchor.face.center], cam) : null;
  const hostIn = !!hr && hr.front && hr.x0 > -0.05 && hr.x0 < 1.05 && hr.y0 > -0.05 && hr.y0 < 1.05;
  const hostU = hostIn ? hr!.x0 : null;
  const dA = hostIn ? ctx.anchor!.face.center.clone().sub(cam.position).dot(fwd) : null;
  return { cam, fwd, rgt, prs, keep: [...ctx.keepOut, ...inp.avoid], hostU, dA, hostIn };
}

/** His face mostly behind his own tablet (the head should peek over / beside it). */
const faceHidden = (head: Rect, tab: Rect, k = 0.2) => rectOverlap(head, tab) > k * Math.max(1e-6, (head.x1 - head.x0) * (head.y1 - head.y0));
const clip01 = (r: Rect): Rect => ({ x0: Math.max(0, r.x0), y0: Math.max(0, r.y0), x1: Math.min(1, r.x1), y1: Math.min(1, r.y1) });

/** His head (peeking over / beside the tablet), his FACE (+ a small screen margin) and whole body as screen rects. */
function bodyRects(p: THREE.Vector3, geo: BuddyGeo, pre: Pre) {
  const { rgt, cam } = pre;
  const hh = geo.headW * 0.9;
  const head = rectOf([p.clone().addScaledVector(rgt, -geo.headW).setY(p.y + geo.headUp - hh), p.clone().addScaledVector(rgt, geo.headW).setY(p.y + Math.max(geo.headUp + hh, geo.headTop))], cam);
  const f = rectOf([p.clone().addScaledVector(rgt, -geo.faceHW).setY(p.y + geo.headUp - geo.faceDn), p.clone().addScaledVector(rgt, geo.faceHW).setY(p.y + geo.headUp + geo.faceUpX)], cam);
  const face: Rect = { x0: f.x0 - FACE_PAD, y0: f.y0 - FACE_PAD, x1: f.x1 + FACE_PAD, y1: f.y1 + FACE_PAD };
  const body = rectOf([p.clone().addScaledVector(rgt, -geo.height * 0.3).setY(p.y), p.clone().addScaledVector(rgt, geo.height * 0.3).setY(p.y + Math.max(geo.headUp + hh, geo.height * 0.95))], cam);
  return { head, face, body };
}

/** Screen margin around every face box (fraction of the frame; performers get 0.015 in prep()). */
const FACE_PAD = 0.012;
/** His head must be this far inside the frame (no head cut off by an edge). */
const HEAD_IN = 0.01, HEAD_TOP = 0.025;
const headInFrame = (head: Rect & { front: boolean }) => head.front && head.x0 >= HEAD_IN && head.x1 <= 1 - HEAD_IN && head.y0 >= HEAD_TOP && head.y1 <= 1 - HEAD_IN;

/** The tablet's screen rect touches one of these face boxes (performers' and his own). */
export function coversFace(tab: Rect, faces: Rect[]): boolean { return faces.some((f) => rectOverlap(tab, f) > 0); }

/** The largest cheer bounce that keeps the tablet off every face and in the frame: the tablet lift (1, ½, none) and
 *  the hop (1, ½, none) are judged apart — at the top of the bounce the tablet is CHEER_LIFT higher on his body (his
 *  own face doesn't move with it) and the hop lifts him and the tablet together (performers' faces don't). */
function cheerFor(pre: Pre, p: THREE.Vector3, geo: BuddyGeo, side: number, own: Rect): { cheer: number; hop: number } {
  const faces = pre.prs.map((q) => q.face);
  const stand = geo.hold === 'stand';                                                    // (the stand's tablet stays put)
  let best = { cheer: 0, hop: 0 }, bestS = -1;
  for (const k of stand ? [0] : [1, 0.5, 0]) {
    const g = { ...geo, tabUp: geo.tabUp + k * CHEER_LIFT * geo.height };
    if (k > 0 && rectOverlap(rectOf(tabletCorners(p, pre.cam, g, side).corners, pre.cam), own) > 0) continue;
    for (const j of [1, 0.5, 0]) {
      if (k + j <= bestS) break;
      const up = p.clone().setY(p.y + j * CHEER_HOP * geo.height);
      if (k + j > 0) {
        const top = rectOf(tabletCorners(stand ? p : up, pre.cam, g, side).corners, pre.cam);
        if (!top.front || top.y0 < 0.005 || coversFace(top, faces) || pre.keep.some((r) => rectOverlap(top, r) > 0)) continue;
        if (!headInFrame(bodyRects(up, geo, pre).head)) continue;                        // (his head stays in the frame)
      }
      best = { cheer: stand ? 1 : k, hop: j }; bestS = k + j + (stand ? 1 : 0);
      break;
    }
  }
  return best;
}

function cheap(inp: BuddyPlanInput, pre: Pre, cand: Cand, geo: BuddyGeo, side: number): { ok: boolean; score: number; hf: number; yaw: number; cheer: number; hop: number } {
  const { ctx } = inp;
  const no = { ok: false, score: 99, hf: 0, yaw: 0, cheer: 0, hop: 0 };
  const p = cand.pos, cam = pre.cam;
  if (inp.bad?.some((b) => b.distanceTo(p) < 0.35)) return no;
  for (const s of ctx.spots) if (Math.hypot(s.x - p.x, s.z - p.z) < (cand.perch ? 0.5 : 0.6)) return no;              // never on a (guest's) seat
  if (!cand.perch) {
    for (const q of ctx.performers) if (Math.hypot(q.floor.x - p.x, q.floor.z - p.z) < 0.7) return no;
    for (const y of [0.15, 0.5, 0.85]) if (ctx.rays.insideCollider(new THREE.Vector3(p.x, p.y + y * geo.height, p.z), 0.2 * Math.min(1, geo.height / 1.08))) return no;
  }
  const t = tabletCorners(p, cam, geo, side);
  const tr = rectOf(t.corners, cam);
  if (!tr.front) return no;
  const m = 0.03;
  if (tr.x0 < m || tr.x1 > 1 - m || tr.y0 < m || tr.y1 > 1 - m) return no;
  const hf = tr.y1 - tr.y0;
  if (hf < geo.hfMin || hf > geo.hfMax) return no;
  const { head, face, body } = bodyRects(p, geo, pre);
  if (faceHidden(head, tr)) return no;                                                   // his own tablet over his face
  if (rectOverlap(tr, face) > 0) return no;                                              // …not even the edge of it
  if (!headInFrame(head)) return no;                                                     // his head fully in the shot
  const dT = t.center.clone().sub(cam.position).dot(pre.fwd);
  let score = 0;
  for (const q of pre.prs) {
    if (rectOverlap(tr, q.face) > 0 || rectOverlap(head, q.face) > 0) return no;
    if (q.depth > dT + 0.1 && rectOverlap(clip01(body), q.face) > 0) return no;          // standing in front of someone's face
    const ov = rectOverlap(tr, q.body) / Math.max(1e-5, (tr.x1 - tr.x0) * hf);
    if (q.depth < dT - 0.1 && ov > 0.04) return no;                                     // a performer in front would hide it
    score += ov * 1.2;                                                                   // in front of someone's body: allowed, not loved
  }
  for (const k of pre.keep) {
    if (rectOverlap(tr, k) > 0 || rectOverlap(head, k) > 0.002) return no;
    if (rectOverlap(clip01(body), k) > 0.004) return no;                                 // never over the react screen / monitor
  }
  const uc = (tr.x0 + tr.x1) / 2, vc = (tr.y0 + tr.y1) / 2;
  score += Math.abs(hf - geo.hfPref) * 4 + Math.abs(vc - 0.64) * 1.6;
  const bw = body.x1 - body.x0;
  if (bw > 0.3) score += (bw - 0.3) * 4;
  if (pre.hostU !== null && pre.dA !== null) {
    score += Math.max(0, Math.abs(uc - pre.hostU) - 0.3) * 1.2;                         // near the host in the frame
    if (dT < pre.dA * 0.45) score += 1;                                                  // very close to the lens
    else if (dT < pre.dA * 0.65) score += 0.6;
  }
  if (inp.preferSide && Math.sign(uc - 0.5) !== inp.preferSide) score += 0.3;
  if (inp.cur) {
    const d = inp.cur.distanceTo(p);
    score += d < 0.05 ? -0.6 : Math.min(2.5, d) * 0.12;                                  // stay put when it's as good
  }
  if (cand.source === 'perch') score += 0.2;                                             // furniture tops: fine, the floor is nicer
  else if (cand.source !== 'grid' && cand.source !== 'current') score -= 0.4;            // authored anchors win ties
  const { cheer, hop } = cheerFor(pre, p, geo, side, face);
  score += (2 - cheer - hop) * 0.06;                                                     // a full bounce is nicer
  return { ok: true, score, hf, yaw: t.yaw, cheer, hop };
}

function raysOk(inp: BuddyPlanInput, pre: Pre, cand: Cand, geo: BuddyGeo, side: number): boolean {
  const { ctx } = inp;
  const cam = pre.cam, p = cand.pos, h = geo.height;
  const t = tabletCorners(p, cam, geo, side);
  const pts = [[0, 0], [-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9], [0, -0.9], [0, 0.9], [-0.9, 0], [0.9, 0]].map(([x, y]) => t.at(x, y));
  if (pts.some((q) => !ctx.rays.clear(cam.position, q))) return false;
  // nothing cuts through the tablet or his body (a shelf above him, a wall through the tablet, a table edge)
  if (!ctx.rays.clear(t.at(-1, -1), t.at(1, 1)) || !ctx.rays.clear(t.at(-1, 1), t.at(1, -1))) return false;
  const chest = p.clone().setY(p.y + h * 0.5);
  if (!ctx.rays.clear(p.clone().setY(p.y + h * 0.06), p.clone().setY(p.y + Math.max(geo.headUp + geo.headW * 0.6, h * 0.9)))) return false;
  if (!ctx.rays.clear(chest.clone().addScaledVector(pre.rgt, -h * 0.22), chest.clone().addScaledVector(pre.rgt, h * 0.22))) return false;
  if (!ctx.rays.clear(chest, t.center)) return false;
  if (inp.exact && !inp.exact(pts, cam.position)) return false;
  // HE is in the shot too, not just his tablet: his face is seen (not hidden behind a sign / a desk)
  const hc = p.clone().setY(p.y + geo.headUp);
  const heads = [hc, hc.clone().addScaledVector(pre.rgt, geo.headW * 0.6), hc.clone().addScaledVector(pre.rgt, -geo.headW * 0.6), hc.clone().setY(hc.y - geo.headW * 0.5)];
  if (heads.filter((q) => ctx.rays.clear(cam.position, q)).length < 3) return false;
  // something under his feet
  const down = ctx.rays.hit(p.clone().setY(p.y + 0.6), p.clone().setY(p.y - 0.4), 0.01);
  if (down === Infinity) return false;
  if (cand.perch) return true;
  // on a floor: no wall between him and the host (he walks / poofs over) — when the host is in this shot
  if (ctx.anchor && pre.hostIn && !ctx.rays.clear(ctx.anchor.floor.clone().setY(1.3), p.clone().setY(1.3))) return false;
  return true;
}

/** Hand holding the tablet: the side away from the host (so the tablet sits on the free side of the frame). */
function holdSide(ctx: ShotContext, pos: THREE.Vector3, cam: THREE.PerspectiveCamera): 1 | -1 {
  if (!ctx.anchor) return 1;
  const toCam = cam.position.clone().sub(pos).setY(0);
  const yaw = Math.atan2(toCam.x, toCam.z);
  const left = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  return ctx.anchor.floor.clone().sub(pos).dot(left) > 0 ? -1 : 1;
}

/** Flat furniture top under (x, z) below `top` (desk, counter, crate, shelf): its height, or null. */
function perchAt(ctx: ShotContext, x: number, z: number, top: number): number | null {
  const y = ctx.rays.floorBelow(new THREE.Vector3(x, top, z), top + 0.5);
  if (y === null || y < 0.3 || y > top - 0.3) return null;
  for (const [dx, dz] of [[0.17, 0], [-0.17, 0], [0, 0.17], [0, -0.17]]) {
    const yy = ctx.rays.floorBelow(new THREE.Vector3(x + dx, top, z + dz), top + 0.5);
    if (yy === null || Math.abs(yy - y) > 0.035) return null;
  }
  return y;
}

// ---------------------------------------------------------------- the foreground peek
interface ForeCand { plan: TabletPlan; score: number; geo: BuddyGeo }

/** Where the foreground peek puts him for tablet centre (u, v) at depth d with the tablet `hf` of the frame tall. */
export function forePose(cam: THREE.PerspectiveCamera, fore: { u: number; v: number; d: number }, hf: number, height: number, geoAt: (h: number) => BuddyGeo, side: number) {
  const c = viewPoint(cam, fore.u, fore.v, fore.d);
  const frameH = viewPoint(cam, 0.5, 0, fore.d).distanceTo(viewPoint(cam, 0.5, 1, fore.d));
  const r = geoAt(1).tabH;
  const h = THREE.MathUtils.clamp((hf * frameH) / Math.max(1e-4, r), 0.05, height);
  const geo = geoAt(h);
  const pos = mountFor(c, cam.position, geo, side);
  const toCam = cam.position.clone().sub(pos).setY(0);
  return { pos, yaw: Math.atan2(toCam.x, toCam.z), geo, h };
}

function* planFore(inp: BuddyPlanInput, pre: Pre): Generator<void, ForeCand | null, void> {
  const { ctx } = inp, cam = pre.cam;
  const found: ForeCand[] = [];
  let n = 0;
  // landscape first; upright (3:4) when only a narrow strip is free (beside a big React screen)
  for (const port of [false, true]) {
  const geoAtO = (hh: number) => (port ? portraitGeo(inp.geoAt(hh)) : inp.geoAt(hh));
  const g1 = geoAtO(inp.height);
  const hostSide = pre.hostU === null ? 0 : pre.hostU > 0.5 ? 1 : -1;
  const corners: (-1 | 1)[] = hostSide > 0 ? [-1, 1] : hostSide < 0 ? [1, -1] : inp.preferSide < 0 ? [-1, 1] : [1, -1];
  const hfs = [...new Set([g1.hfPref, (g1.hfPref + g1.hfMin) / 2, g1.hfMin * 1.02].map((x) => +x.toFixed(3)))];
  for (const corner of corners) for (const hf of hfs) for (const inset of [0.035, 0.016, 0.1]) for (const d of [0.9, 0.7, 1.2]) for (const lift of [0, 1, 2]) {
    const w = hf * (port ? 3 / 4 : 4 / 3) / ctx.aspect;                   // tablet width fraction
    const u = corner < 0 ? inset + w / 2 : 1 - inset - w / 2;
    const v = 0.965 - hf / 2;
    // the tablet toward the middle of the frame, his body toward the edge
    const side = (corner > 0 ? -1 : 1) as 1 | -1;
    // tablet at its normal height / low (he stands behind it, only the head over the top) / raised
    const geoAt = (hh: number) => {
      const g = geoAtO(hh);
      if (lift === 1) return { ...g, tabUp: Math.min(g.tabUp, g.tabH / 2 - hh * 0.03) };
      const up = g.lifts.find((l) => l.up > g.tabUp + 1e-6);
      if (lift === 2 && up) return { ...g, tabUp: up.up };
      return g;
    };
    const fp = forePose(cam, { u, v, d }, hf, inp.height, geoAt, side);
    const geo = fp.geo;
    if (++n % 3 === 0) yield;
    const t = tabletCorners(fp.pos, cam, geo, side);
    const tr = rectOf(t.corners, cam);
    const why = (k: string) => { if (inp.trace) inp.trace[k] = (inp.trace[k] ?? 0) + 1; };
    if (!tr.front || tr.x0 < 0.008 || tr.x1 > 0.992 || tr.y0 < 0.02 || tr.y1 > 0.985) { why('frame'); continue; }
    const feet = rectOf([fp.pos], cam);
    const behind = feet.x0 > tr.x0 + 0.01 && feet.x0 < tr.x1 - 0.01 && feet.y0 < tr.y1 - 0.005;
    if (feet.front && feet.y0 < 0.985 && feet.x0 > 0 && feet.x0 < 1 && !behind) { why('feet'); continue; }   // no floating legs in view
    const { head, face, body } = bodyRects(fp.pos, geo, pre);
    // peeking over the tablet from the corner is the look — with his whole head in the frame and his face uncovered
    if (!headInFrame(head)) { why('head'); continue; }
    let bad = faceHidden(clip01(head), tr, 0.55) || rectOverlap(tr, face) > 0;
    for (const q of pre.prs) if (rectOverlap(tr, q.face) > 0 || rectOverlap(clip01(head), q.face) > 0 || rectOverlap(clip01(body), q.face) > 0) bad = true;
    for (const k of pre.keep) if (rectOverlap(tr, k) > 0 || rectOverlap(clip01(body), k) > 0.002) bad = true;
    if (bad) { why('rects'); continue; }
    let score = Math.abs(tr.y1 - tr.y0 - g1.hfPref) * 4 + (d === 0.9 ? 0 : 0.1) + (inset > 0.05 ? 0.15 : inset < 0.03 ? 0.05 : 0) + [0, 0.1, 0.25][lift] + (port ? 0.4 : 0);
    if (corner === corners[1]) score += 0.3;
    let cover = 0;
    for (const q of pre.prs) cover += rectOverlap(clip01(body), q.body);
    score += cover * 3;
    const { cheer, hop } = cheerFor(pre, fp.pos, geo, side, face);
    found.push({ score, geo, plan: { mode: 'fore', pos: fp.pos, yaw: fp.yaw, side, corner, score: 50 + score, hf: tr.y1 - tr.y0, lift: geo.tabUp, perch: false, source: 'fore', height: fp.h, fore: { u, v, d }, portrait: port, cheer, hop } });
  }
  if (found.length) break;
  }
  found.sort((a, b) => a.score - b.score);
  n = 0;
  for (const f of found) {
    yield;
    const p = f.plan.pos, geo = f.geo;
    const t = tabletCorners(p, cam, geo, f.plan.side);
    const pts = [[0, 0], [-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9], [0, -0.9], [0, 0.9], [-0.9, 0], [0.9, 0]].map(([x, y]) => t.at(x, y));
    const body = [p.clone().setY(p.y + geo.headUp), p.clone().setY(p.y + geo.height * 0.5), p.clone().setY(p.y + geo.height * 0.2)];
    // in free air right in front of the lens: nothing between the lens and him, nothing inside him
    const why = (k: string) => { if (inp.trace) inp.trace[k] = (inp.trace[k] ?? 0) + 1; };
    if ([...pts, ...body].some((q) => !ctx.rays.clear(cam.position, q))) { why('rayBlocked'); continue; }
    if ([...pts, ...body].some((q) => ctx.rays.insideCollider(q, 0.02))) { why('collider'); continue; }
    if (!ctx.rays.clear(t.at(-1, -1), t.at(1, 1)) || !ctx.rays.clear(body[0], body[2])) { why('clip'); continue; }
    if (inp.exact && !inp.exact(pts, cam.position)) { why('exact'); continue; }
    return f;
  }
  return null;
}

export function* planTablet(inp: BuddyPlanInput): Generator<void, TabletPlan, void> {
  const { ctx } = inp;
  const pre = prep(inp);
  const cam = pre.cam;
  const fwd = cam.getWorldDirection(new THREE.Vector3()).setY(0);
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
  fwd.normalize();
  const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
  const ht = Math.tan(THREE.MathUtils.degToRad(ctx.pose.fov) / 2) * ctx.aspect;
  const base = cam.position.clone().setY(0);
  // grid depth: the host's, else (host not in this shot) how far the camera sees along its axis
  let dA = pre.hostIn && ctx.anchor ? Math.max(1.2, ctx.anchor.floor.clone().sub(base).dot(fwd)) : 3;
  if (!pre.hostIn) {
    const look = cam.getWorldDirection(new THREE.Vector3());
    const hit = ctx.rays.hit(cam.position, cam.position.clone().addScaledVector(look, 30), 0.05);
    const flat = Math.max(0.2, Math.hypot(look.x, look.z));
    dA = THREE.MathUtils.clamp((hit === Infinity ? 8 : hit) * flat * 0.8, 1.5, 9);
  }
  if (!inp.noWorld) {
    const cands: Cand[] = [];
    for (const a of inp.anchors) cands.push({ pos: a.pos.clone(), perch: a.pos.y > 0.15, source: a.source });
    if (inp.cur) cands.push({ pos: inp.cur.clone(), perch: inp.cur.y > 0.15, source: 'current' });
    for (const dk of [0.3, 0.38, 0.47, 0.57, 0.68, 0.8, 0.93, 1.07, 1.25, 1.5]) {
      const d = Math.max(0.9, dA * dk);
      for (let i = 0; i <= 16; i++) {
        const u = 0.04 + (i / 16) * 0.92;
        cands.push({ pos: base.clone().addScaledVector(fwd, d).addScaledVector(right, (2 * u - 1) * d * ht * 0.92), perch: false, source: 'grid' });
      }
    }
    yield;
    // perches: flat furniture tops under eye level across the frame (desks, counters, crates, shelves)
    const top = Math.min(cam.position.y + 0.25, 2.4);
    let n = 0;
    for (const dk of [0.35, 0.5, 0.65, 0.8, 0.95, 1.1, 1.3]) {
      const d = Math.max(0.8, dA * dk);
      for (let i = 0; i <= 10; i++) {
        const u = 0.05 + (i / 10) * 0.9;
        const p = base.clone().addScaledVector(fwd, d).addScaledVector(right, (2 * u - 1) * d * ht * 0.9);
        const y = perchAt(ctx, p.x, p.z, top);
        if (y !== null) cands.push({ pos: p.setY(y), perch: true, source: 'perch' });
        if (++n % 2 === 0) yield;
      }
    }
    // normal size first; smaller (tight spaces) only when nothing fits at normal size
    for (const k of [1, 0.8, 0.64]) {
      const g0 = inp.geoAt(inp.height * k);
      const scored: { c: Cand; side: 1 | -1; s: ReturnType<typeof cheap>; geo: BuddyGeo }[] = [];
      n = 0;
      for (const c of cands) {
        const side = holdSide(ctx, c.pos, cam);
        for (const L of g0.lifts) {
          const geo = { ...g0, tabUp: L.up };
          let s = cheap(inp, pre, c, geo, side), sd = side;
          if (!s.ok) { const s2 = cheap(inp, pre, c, geo, -side as 1 | -1); if (s2.ok) { s = { ...s2, score: s2.score + 0.4 }; sd = -side as 1 | -1; } }
          if (s.ok) scored.push({ c, side: sd, s: { ...s, score: s.score + L.cost + (1 - k) * 1.5 }, geo });
        }
        if (++n % 8 === 0) yield;
      }
      scored.sort((a, b) => a.s.score - b.s.score);
      n = 0;
      for (const x of scored.slice(0, 60)) {
        if (raysOk(inp, pre, x.c, x.geo, x.side)) return { mode: 'world', pos: x.c.pos, yaw: x.s.yaw, side: x.side, corner: 1, score: x.s.score, hf: x.s.hf, perch: x.c.perch, source: x.c.source, lift: x.geo.tabUp, height: x.geo.height, cheer: x.s.cheer, hop: x.s.hop };
        if (++n % 2 === 0) yield;
      }
    }
  }
  // no floor / perch in this shot: the foreground peek
  const fore = inp.noFore ? null : yield* planFore(inp, pre);
  if (fore) return fore.plan;
  // a very big tablet / tiny text that can't be fully readable anywhere in this shot: still in the shot, a bit smaller
  // (the text down to ~70 % of the readable size) rather than not at all
  const relaxed: BuddyPlanInput = { ...inp, geoAt: (h: number) => { const g = inp.geoAt(h); const m = g.hfMin * 0.7; return { ...g, hfMin: m, hfPref: Math.max(0.2, m * 1.3), hfMax: Math.max(0.45, m * 1.9) }; } };
  if (!inp.noFore && inp.geoAt(inp.height).hfMin > 0.2) {
    const f2 = yield* planFore(relaxed, pre);
    if (f2) return { ...f2.plan, source: 'fore-small' };
  }
  // not even that (a wall right in front of the lens): hold it into the frame from a bottom corner clear of every face,
  // the react screen and the props (landscape, else upright); none = nothing drawn (never over the react screen)
  const first: -1 | 1 = pre.hostU !== null ? (pre.hostU > 0.5 ? -1 : 1) : inp.preferSide < 0 ? -1 : 1;
  for (const src of [inp, relaxed]) {
    const g0 = src.geoAt(inp.height);
    for (const port of [false, true]) for (const corner of [first, -first as -1 | 1]) {
      const gm = port ? g0.hfMin * 4 / 3 : g0.hfMin;
      for (const hf of [Math.max(0.22, gm * 1.1), Math.max(0.17, gm * 1.02)]) {
        const w = hf * (port ? 0.75 : 4 / 3) / ctx.aspect;
        for (const inset of [0.075, 0.03, 0.012]) {
          const u = corner < 0 ? inset + w / 2 : 1 - inset - w / 2, v = 0.9 - hf / 2;
          if (v - hf / 2 < 0.03 || w > 0.9) continue;
          const r = { x0: u - w / 2 - 0.004, y0: v - hf / 2 - 0.004, x1: u + w / 2 + 0.004, y1: v + hf / 2 + 0.004 };
          if (pre.keep.some((k) => rectOverlap(r, k) > 0) || pre.prs.some((q) => rectOverlap(r, q.face) > 0)) continue;
          return { mode: 'overlay', pos: inp.cur?.clone() ?? base, yaw: 0, side: 1, corner, score: 99, hf, perch: false, source: 'overlay', lift: 0, height: inp.height, fore: { u, v, d: 0.5 }, portrait: port };
        }
      }
    }
  }
  return { mode: 'overlay', pos: inp.cur?.clone() ?? base, yaw: 0, side: 1, corner: first, score: 99, hf: 0, perch: false, source: 'none', lift: 0, height: inp.height };
}

/** Is the current plan still fine for this shot? (cheap + rays, one candidate). */
export function planStillGood(inp: BuddyPlanInput, plan: TabletPlan): boolean {
  if (plan.mode !== 'world') return false;
  const pre = prep(inp);
  const c: Cand = { pos: plan.pos, perch: plan.perch, source: 'current' };
  const geo = { ...(plan.portrait ? portraitGeo(inp.geoAt(plan.height)) : inp.geoAt(plan.height)), tabUp: plan.lift };
  const s = cheap(inp, pre, c, geo, plan.side);
  return s.ok && raysOk(inp, pre, c, geo, plan.side);
}

/** Test pages: internals for the coverage harness. */
export const _dbg = { bodyRects: (p: THREE.Vector3, geo: BuddyGeo, inp: BuddyPlanInput) => bodyRects(p, geo, prep(inp)), faceHidden, headInFrame,
  /** The screen rules for one floor point (tests). */
  cheap: (inp: BuddyPlanInput, pos: THREE.Vector3, geo: BuddyGeo, side: 1 | -1, perch = false) => cheap(inp, prep(inp), { pos, perch, source: 'grid' }, geo, side) };
/** Roam mode (chatBuddyRoam.ts): the same screen / ray tests for the spots he wanders between. */
export const _place = { prep, cheap, raysOk, holdSide, perchAt, bodyRects, clip01, faceHidden, headInFrame };
