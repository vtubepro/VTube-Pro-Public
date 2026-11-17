// Size-aware seating (docs/SCENES.md → "Avatar size classes" → "Seats for every size"): how a performer who is not
// human-sized uses an ordinary chair — an automatic step for every sit spot in every room and mode (interview, talk,
// react, TTRPG …), so a room never needs hand edits for a frog, a fairy or a giant.
//
//   measured per seat: the seat surface (spot seatHeight), a desk / table top in front of or beside it (room rays +
//   generated set pieces such as the interview desk: SeatEnv.surfaces), the head room above it, free floor beside it.
//   measured per performer: face height above the seat when sitting / above the feet when standing, face size.
//
//   small / micro   VISIBILITY-DRIVEN: seated normally first; then, from every camera that frames the seat (the
//                   room's authored cameras in front of it + the interview / talk operator positions at a seated
//                   human's eye line), is the face seen (not hidden by the desk / props) and big enough in frame?
//                   Only when it is not, the smallest fix that makes it seen, in this order: a small seat raise
//                   (≤ 0.12 m cushion) → a booster (cushion ≤ 0.28 m small / 0.45 m micro, then standing on the seat)
//                   → standing on the desk / table top in front of (or beside) the chair ('desk'). An open sofa with
//                   nothing between it and the cameras (the Astraea lounge bar) needs nothing.
//   large           knees would meet the desk → the chair scoots back ('back')
//   macro           never squeezes into a chair: stands beside it on the floor, on the side with more room ('beside')
//
// Pure maths over RoomRays; deterministic, so the studio preview and every OBS page derive the same seats.
import * as THREE from 'three';
import type { SizeClass } from '../../shared/avatarSize.ts';
import type { CameraPreset, SpotInfo } from './contract.ts';
import type { RoomRays } from './twoShot.ts';

/** A table top that is not room geometry (the interview desk …): an oriented box top, world space. */
export interface SeatSurface { center: THREE.Vector3; yaw: number; halfW: number; halfD: number; top: number }

/** What the runtime gives actors to plan their seats with. `ver` changes whenever `surfaces` does. `cams` = the
 *  room's authored cameras (the ones in front of a seat count as views of it). */
export interface SeatEnv { rays: () => RoomRays; surfaces: SeatSurface[]; ver: number; cams?: () => Iterable<CameraPreset> }

export type BoostMode = 'none' | 'cushion' | 'standSeat' | 'desk' | 'back' | 'beside';
export interface SeatBoost {
  mode: BoostMode;
  /** Feet / seat surface height above the spot's floor (m) for standing modes; extra seat height for 'cushion'. */
  lift: number;
  /** Offsets in the spot's frame (x = the performer's left, z = forward), room metres. */
  x: number; z: number;
  /** Standing (legs straight) instead of seated. */
  stand: boolean;
  /** Cushion / booster prop thickness (0 = none) and footprint. */
  cushion: number; cushionW: number;
  note: string;
}

export interface SeatBody {
  cls: SizeClass;
  /** Face centre above the seat surface when seated normally (m). */
  sitFace: number;
  /** Face centre above the feet when standing (m). */
  standFace: number;
  /** Top of the head above the feet when standing (m). */
  standTop: number;
  faceSize: number;
  /** Shown standing height (m) and the room's normal-performer height. */
  height: number; base: number;
  quadruped: boolean;
  /** Face centre forward of the spot origin (m, spot frame) when seated / standing; default 0. */
  sitFaceZ?: number; standFaceZ?: number;
}

export const CUSHION_MAX = 0.28;
const NONE: SeatBoost = { mode: 'none', lift: 0, x: 0, z: 0, stand: false, cushion: 0, cushionW: 0, note: '' };
const UP = new THREE.Vector3(0, 1, 0);

/** A human's seated face height above the seat surface (the eye line small performers are matched to). */
export const humanSitFace = (base: number) => base * 0.46;

interface Top { y: number; fw: number; lat: number; p: THREE.Vector3 }

/** Table tops in front of / beside a seat: room geometry + env surfaces, 0.12 m above the seat … 1.3 m. */
export function tableTops(s: SpotInfo, rays: RoomRays, surfaces: readonly SeatSurface[]): Top[] {
  const out: Top[] = [];
  const right = new THREE.Vector3().crossVectors(s.forward, UP).normalize();   // the performer's right
  const probes: [number, number][] = [[0, 0.3], [0, 0.42], [0, 0.55], [0, 0.7], [0, 0.85], [0.6, 0.15], [-0.6, 0.15], [0.75, 0.35], [-0.75, 0.35]];
  for (const [lat, fw] of probes) {
    const p = s.position.clone().addScaledVector(s.forward, fw).addScaledVector(right, lat);
    let y: number | null = null;
    for (const f of surfaces) {
      const d = p.clone().sub(f.center);
      const lx = d.x * Math.cos(f.yaw) - d.z * Math.sin(f.yaw), lz = d.x * Math.sin(f.yaw) + d.z * Math.cos(f.yaw);
      if (Math.abs(lx) <= f.halfW - 0.06 && Math.abs(lz) <= f.halfD - 0.04) y = Math.max(y ?? -Infinity, f.top);
    }
    if (y === null) {
      const r = rays.floorBelow(p.clone().setY(s.position.y + 1.45), 1.4);
      // flat (a table, not a chair back / armrest / lamp)
      if (r !== null && [[0.09, 0], [-0.09, 0], [0, 0.09], [0, -0.09]].every(([dx, dz]) => { const q = rays.floorBelow(p.clone().add(new THREE.Vector3(dx, 0, dz)).setY(s.position.y + 1.45), 1.4); return q !== null && Math.abs(q - r) < 0.03; })) y = r;
    }
    if (y === null) continue;
    const h = y - s.position.y;
    if (h < s.seatHeight + 0.12 || h > 1.3) continue;
    out.push({ y: h, fw, lat, p: p.setY(y) });
  }
  return out;
}

// ---------------------------------------------------------------- visibility (small / micro)
/** A camera position that frames a seat; `w` = weight (the frontal interview / talk operator counts double). */
export interface SeatView { pos: THREE.Vector3; w: number; tanHalf: number; front: boolean }
/** Face height in frame below which a view does not count as framing the seat (fraction of the frame height). */
export const MIN_FACE_FRAC = 0.02;
/** Weighted share of the views that must see the face (and the frontal operator must). */
export const SEEN_SHARE = 0.7;

/** Does the segment a→b pass through a set-piece box (a generated desk: top `top`, down to `floorY`)? */
function segHitsSurface(a: THREE.Vector3, b: THREE.Vector3, f: SeatSurface, floorY: number): boolean {
  const c = Math.cos(f.yaw), sn = Math.sin(f.yaw);
  const loc = (p: THREE.Vector3) => { const dx = p.x - f.center.x, dz = p.z - f.center.z; return [dx * c - dz * sn, p.y, dx * sn + dz * c]; };
  const A = loc(a), B = loc(b);
  const lo = [-f.halfW, floorY, -f.halfD], hi = [f.halfW, f.top, f.halfD];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 3; i++) {
    const d = B[i] - A[i];
    if (Math.abs(d) < 1e-9) { if (A[i] < lo[i] || A[i] > hi[i]) return false; continue; }
    let u = (lo[i] - A[i]) / d, v = (hi[i] - A[i]) / d;
    if (u > v) [u, v] = [v, u];
    t0 = Math.max(t0, u); t1 = Math.min(t1, v);
    if (t0 > t1) return false;
  }
  return t1 > 0.02 && t0 < 0.98;
}

/** The camera positions that frame sit spot `s`: the interview / talk operator positions in front of it (at a seated
 *  human's eye line, 1.6 / 2.6 / 4 m out (the far one = the grazing view across a desk), straight on and 35° to each side — dropped where a wall is in the way) and
 *  the room's authored cameras that look at it from the front within 10 m. */
export function seatViews(s: SpotInfo, base: number, rays: RoomRays, cams: Iterable<CameraPreset> = [], eye?: number): SeatView[] {
  const out: SeatView[] = [];
  const eyeY = s.position.y + (eye ?? s.seatHeight + humanSitFace(base));
  const anchor = s.position.clone().addScaledVector(s.forward, 0.12).setY(eyeY);
  const t20 = Math.tan(THREE.MathUtils.degToRad(20));
  for (const d of [1.6, 2.6, 4.0]) {
    for (const az of [0, -35, 35]) {
      const dir = s.forward.clone().applyAxisAngle(UP, THREE.MathUtils.degToRad(az));
      const want = anchor.clone().addScaledVector(dir, d).setY(eyeY + (d > 3 ? 0.05 : d > 2 ? 0.15 : 0.02));
      const h = rays.hit(anchor, want, 0.05);
      const dd = h === Infinity ? anchor.distanceTo(want) : h - 0.25;
      if (dd < 0.9) continue;
      out.push({ pos: anchor.clone().addScaledVector(want.clone().sub(anchor).normalize(), dd), w: az === 0 ? 2 : 1, tanHalf: t20, front: az === 0 && d < 2 });
    }
  }
  for (const c of cams) {
    const to = anchor.clone().sub(c.position);
    const dist = to.length();
    if (dist < 0.8 || dist > 10) continue;
    if (to.clone().setY(0).normalize().dot(s.forward) > -0.2) continue;          // behind / beside the performer
    const look = new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion);
    if (THREE.MathUtils.radToDeg(look.angleTo(to)) > c.fov * 0.75) continue;    // the seat is not in its frame
    out.push({ pos: c.position.clone(), w: 1, tanHalf: Math.tan(THREE.MathUtils.degToRad(c.fov / 2)), front: false });
  }
  return out;
}

/** Weighted share of `views` that see a face (centre + 4 edge points, the chin 0.5 × size below: all clear) big enough in frame; `front` =
 *  the frontal operator view (when there is one) sees it. share -1 = no view frames the seat (can't judge). */
export function faceSeen(face: THREE.Vector3, size: number, s: SpotInfo, views: readonly SeatView[], rays: RoomRays, surfaces: readonly SeatSurface[]): { share: number; front: boolean } {
  const right = new THREE.Vector3().crossVectors(s.forward, UP).normalize();
  const pts = [face, face.clone().setY(face.y + size * 0.3), face.clone().setY(face.y - size * 0.5), face.clone().addScaledVector(right, size * 0.3), face.clone().addScaledVector(right, -size * 0.3)];
  let seen = 0, all = 0, front = true;
  for (const v of views) {
    const dist = v.pos.distanceTo(face);
    if (size / (2 * dist * v.tanHalf) < MIN_FACE_FRAC) continue;               // too far to frame this face at all
    all += v.w;
    let clear = 0, mid = false;
    for (const p of pts) {
      // both ways: room meshes are ray-tested with their material side, and a one-sided desk front seen from its
      // back (inverted normals) is only hit by the reverse ray
      if (rays.hit(v.pos, p, 0.05) !== Infinity || rays.hit(p, v.pos, 0.05) !== Infinity) continue;
      if (surfaces.some((f) => segHitsSurface(v.pos, p, f, s.position.y))) continue;
      clear++; if (p === face) mid = true;
    }
    if (mid && clear >= 5) seen += v.w; else if (v.front) front = false;
  }
  return { share: all ? seen / all : -1, front };
}

/** Free height above `p` (a seat / table top) is more than `need`. */
function headRoomAt(rays: RoomRays, p: THREE.Vector3, need: number): boolean {
  const c = rays.ceilingAbove(p.clone().add(new THREE.Vector3(0, 0.04, 0)), need + 0.1);
  return c === null || c - p.y > need;
}

/** Plan how `body` uses sit spot `s`. `cams` = the room's authored cameras (views of the seat, with the operators). */
export function planSeat(s: SpotInfo, body: SeatBody, rays: RoomRays, surfaces: readonly SeatSurface[], cams?: Iterable<CameraPreset>): SeatBoost {
  if (s.pose !== 'sit' || body.cls === 'normal') return NONE;
  if (s.sizes && s.sizes.includes(body.cls)) return NONE;                   // authored for this class: use as is
  if (body.cls === 'small' || body.cls === 'micro') return planSmall(s, body, rays, surfaces, cams ?? []);
  return planGeometric(s, body, rays, surfaces);
}

/** Small / micro: the smallest fix that lets the cameras see the face (none → raise → booster → desk perch). */
function planSmall(s: SpotInfo, body: SeatBody, rays: RoomRays, surfaces: readonly SeatSurface[], cams: Iterable<CameraPreset>): SeatBoost {
  const views = seatViews(s, body.base, rays, cams);
  const right = new THREE.Vector3().crossVectors(s.forward, UP).normalize();
  const at = (x: number, y: number, z: number) => s.position.clone().addScaledVector(right, -x).addScaledVector(s.forward, z).setY(s.position.y + y);
  const judge = (b: SeatBoost) => {
    const f = b.stand ? at(b.x, b.lift + body.standFace, b.z + (body.standFaceZ ?? 0)) : at(0, s.seatHeight + body.sitFace + b.lift, b.z + (body.sitFaceZ ?? 0));
    return faceSeen(f, body.faceSize, s, views, rays, surfaces);
  };
  const seen = (b: SeatBoost) => { const r = judge(b); return r.front && r.share >= SEEN_SHARE; };
  // no camera frames this seat at all (walls all round): can't judge — the geometric plan
  if (judge(NONE).share < 0) return planGeometric(s, body, rays, surfaces);
  const headRoom = (p: THREE.Vector3, need: number) => headRoomAt(rays, p, need);
  const seatP = (lift: number) => s.position.clone().setY(s.position.y + s.seatHeight + lift);
  const cw = THREE.MathUtils.clamp(body.height * 0.6, 0.26, 0.46);
  const cmax = body.cls === 'micro' ? 0.45 : CUSHION_MAX;
  const why = 'the cameras could not see the face';
  // 0) as is
  if (seen(NONE)) return NONE;
  const ladder: SeatBoost[] = [];
  if (!body.quadruped) {
    // 1) a small seat raise, 2) a booster, then standing on the seat (+ booster)
    for (const l of [0.06, 0.12]) ladder.push({ ...NONE, mode: 'cushion', lift: l, cushion: l, cushionW: cw, note: `seat raised ${Math.round(l * 100)} cm (${why})` });
    for (let l = 0.18; l <= cmax + 1e-6; l += 0.06) ladder.push({ ...NONE, mode: 'cushion', lift: l, cushion: l, cushionW: cw, note: `booster cushion ${Math.round(l * 100)} cm (${why})` });
    for (let c = 0; c <= cmax + 1e-6; c += 0.1) ladder.push({ ...NONE, mode: 'standSeat', lift: s.seatHeight + c, stand: true, cushion: c, cushionW: cw, note: `stands on the seat${c > 0.01 ? ` + ${Math.round(c * 100)} cm booster` : ''} (${why})` });
  }
  for (const b of ladder) {
    if (!headRoom(seatP(b.stand ? b.lift - s.seatHeight : b.lift), b.stand ? body.standTop + 0.05 : body.height)) continue;
    if (seen(b)) return b;
  }
  // 3) the desk / table top in front of (or beside) the chair
  const tops = tableTops(s, rays, surfaces);
  const front = tops.filter((t) => t.lat === 0);
  const deskNear = front.length ? Math.min(...front.map((t) => t.fw)) : Infinity;
  const perches = tops.filter((t) => headRoom(t.p, body.standTop + 0.05)).sort((a, b) => (Math.abs(a.lat) - Math.abs(b.lat)) || (a.fw - b.fw))
    .map((t): SeatBoost => ({ ...NONE, mode: 'desk', lift: t.y, x: -t.lat, z: t.lat === 0 ? Math.min(deskNear + 0.14, t.fw + 0.1) : t.fw, stand: true, note: `on the ${t.lat === 0 ? 'desk in front of' : 'table beside'} the chair (${t.y.toFixed(2)} m; ${why})` }));
  for (const b of perches) if (seen(b)) return b;
  // nothing clears every view: the geometric plan (the desk perch at a desk, else the tallest booster)
  const g = planGeometric(s, body, rays, surfaces);
  return { ...g, note: `${g.note || 'as is'} (no fix clears every camera view)` };
}

/** The geometric plan (no camera views): large / macro, and the small / micro fallback. */
function planGeometric(s: SpotInfo, body: SeatBody, rays: RoomRays, surfaces: readonly SeatSurface[]): SeatBoost {
  const tops = tableTops(s, rays, surfaces);
  const front = tops.filter((t) => t.lat === 0);
  const desk = front.length ? front.reduce((a, b) => (b.y > a.y ? b : a)) : null;
  const deskNear = front.length ? Math.min(...front.map((t) => t.fw)) : Infinity;
  const headRoom = (p: THREE.Vector3, need: number) => headRoomAt(rays, p, need);
  if (body.cls === 'macro') {
    // never in the chair: stand beside it, on the side with more free floor
    const right = new THREE.Vector3().crossVectors(s.forward, UP).normalize();
    const hip = s.position.clone().add(new THREE.Vector3(0, Math.min(1.2, body.height * 0.4), 0));
    const room = (sd: number) => Math.min(2.5, rays.hit(hip, hip.clone().addScaledVector(right, sd * 2.5), 0.01));
    const rR = room(1), rL = room(-1);
    const sd = rR >= rL ? 1 : -1;
    const off = THREE.MathUtils.clamp(0.3 + body.height * 0.12, 0.45, Math.max(0.45, Math.max(rR, rL) - body.height * 0.12));
    return { ...NONE, mode: 'beside', lift: 0, x: -sd * off, z: -0.12, stand: true, note: `giant: stands beside the chair (${sd > 0 ? 'right' : 'left'})` };
  }
  if (body.cls === 'large') {
    if (desk && deskNear < 0.62) return { ...NONE, mode: 'back', z: -THREE.MathUtils.clamp((body.height / body.base - 1) * 0.6 + 0.08, 0.08, 0.3), note: 'large: chair scooted back from the desk' };
    return NONE;
  }
  // ---- small / micro
  const seatTop = s.seatHeight;
  const human = seatTop + humanSitFace(body.base);
  const faceSeated = seatTop + body.sitFace;
  // the face must clear a desk in front (chin above its top) and should come close to a seated human's eye line
  const clear = desk ? desk.y + body.faceSize * 0.7 + 0.04 : -Infinity;
  const want = Math.max(clear, human - (body.cls === 'micro' ? 0.1 : 0.14));
  const need = want - faceSeated;
  if (need <= 0.04) return NONE;
  const cw = THREE.MathUtils.clamp(body.height * 0.6, 0.26, 0.46);
  // micro: the table top right in front of (or beside) the chair
  if (body.cls === 'micro') {
    const cands = tops.filter((t) => { const f = t.y + body.standFace; return f > want - 0.25 && f < human + 0.35 && headRoom(t.p, body.standTop + 0.05); })
      .sort((a, b) => (Math.abs(a.lat) - Math.abs(b.lat)) || (a.fw - b.fw));
    const t = cands[0];
    if (t) {
      // front tops: step 0.12 m onto the desk from its near edge; side tops: where probed
      const z = t.lat === 0 ? Math.min(deskNear + 0.14, t.fw + 0.1) : t.fw;
      return { ...NONE, mode: 'desk', lift: t.y, x: -t.lat, z, stand: true, note: `micro: on the ${t.lat === 0 ? 'desk in front of' : 'table beside'} the chair (${t.y.toFixed(2)} m)` };
    }
  }
  if (body.quadruped) return NONE;                                          // pets stand in front of the seat (actor.ts)
  const cmax = body.cls === 'micro' ? 0.45 : CUSHION_MAX;
  if (need <= cmax && headRoom(s.position.clone().setY(s.position.y + seatTop + need), body.height)) {
    return { ...NONE, mode: 'cushion', lift: need, cushion: need, cushionW: cw, note: `booster cushion ${Math.round(need * 100)} cm` };
  }
  // stand on the seat (plus a booster if that is still short)
  const standGain = body.standFace - body.sitFace;
  const c = THREE.MathUtils.clamp(need - standGain, 0, cmax);
  const lift = seatTop + c;
  if (headRoom(s.position.clone().setY(s.position.y + lift), body.standTop + 0.05)) {
    return { ...NONE, mode: 'standSeat', lift, stand: true, cushion: c, cushionW: cw, note: `stands on the seat${c > 0.01 ? ` + ${Math.round(c * 100)} cm booster` : ''}` };
  }
  const cc = Math.min(need, cmax);
  return { ...NONE, mode: 'cushion', lift: cc, cushion: cc, cushionW: cw, note: `booster cushion ${Math.round(cc * 100)} cm (low ceiling)` };
}

// ---------------------------------------------------------------- stand spots behind a counter (the step-up rule)
/** Highest step (m) a standing performer gets behind a lectern / counter. */
export const STEP_MAX = 0.4;

/** A stand spot with a lectern / counter right in front (top 0.7 … 1.7 m above the spot's floor, ≤ 0.9 m out)? */
export function counterInFront(s: SpotInfo, rays: RoomRays): boolean {
  for (const fw of [0.3, 0.45, 0.6, 0.75, 0.9]) {
    const p = s.position.clone().addScaledVector(s.forward, fw).setY(s.position.y + 2.2);
    const y = rays.floorBelow(p, 2.2);
    if (y !== null && y - s.position.y > 0.7 && y - s.position.y < 1.7) return true;
  }
  return false;
}

/** The step-up rule: a standing performer whose face the cameras can't see over a lectern / counter in front of
 *  their stand spot gets the lowest step (0.1 m increments ≤ STEP_MAX) that shows it; 0 = stays on the floor. Views =
 *  the operators at a standing human's eye line + the room's cameras in front (seatViews). */
export function planStep(s: SpotInfo, body: { standFace: number; standFaceZ?: number; faceSize: number; standTop: number; base: number }, rays: RoomRays, surfaces: readonly SeatSurface[], cams: Iterable<CameraPreset> = []): number {
  if (s.pose === 'sit' || s.hover || !counterInFront(s, rays)) return 0;
  const views = seatViews(s, body.base, rays, cams, body.base * 0.9);
  const face = (lift: number) => s.position.clone().addScaledVector(s.forward, body.standFaceZ ?? 0).setY(s.position.y + lift + body.standFace);
  const ok = (lift: number) => { const r = faceSeen(face(lift), body.faceSize, s, views, rays, surfaces); return r.share < 0 || (r.front && r.share >= SEEN_SHARE); };
  if (ok(0)) return 0;
  for (let l = 0.1; l <= STEP_MAX + 1e-6; l += 0.1) {
    const c = rays.ceilingAbove(s.position.clone().setY(s.position.y + l + 0.04), body.standTop + 0.2);
    if (c !== null && c - (s.position.y + l) < body.standTop + 0.1) break;
    if (ok(l)) return +l.toFixed(2);
  }
  return 0;
}

/** The step / riser under a standing performer (a low dark box), origin at its bottom centre. */
export function buildStep(h: number, w: number): THREE.Group {
  const g = new THREE.Group();
  g.name = 'stand-step';
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, w * 0.8), new THREE.MeshStandardMaterial({ color: 0x2c2f36, roughness: 0.7, metalness: 0.35 }));
  m.position.y = h / 2;
  m.castShadow = true; m.receiveShadow = true;
  g.add(m);
  return g;
}

/** The booster / cushion prop (a stack of soft slabs), origin at its bottom centre. */
export function buildCushion(thick: number, width: number): THREE.Group {
  const g = new THREE.Group();
  g.name = 'seat-booster';
  const n = Math.max(1, Math.ceil(thick / 0.11));
  const cols = [0x7a2e3a, 0x2f4f7a, 0xc9a24a, 0x3f6b4a];
  let y = 0;
  for (let i = 0; i < n; i++) {
    const t = thick / n;
    const geo = new THREE.CylinderGeometry(width / 2, width / 2 * 1.02, t, 28, 1);
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: cols[i % cols.length], roughness: 0.92, metalness: 0 }));
    m.scale.set(1, 1, 0.92);
    m.position.y = y + t / 2;
    m.rotation.y = i * 0.4;
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
    y += t;
  }
  return g;
}
