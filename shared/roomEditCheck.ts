// Room editor checks (docs/ROOM_EDITOR.md → "Warnings"): what a performer's own changes do to the shots, as plain
// warnings. Pure geometry on room-space data, so the same rules run in the editor page (live, while dragging) and in the
// helper's room check (GET /api/rooms/check/<room>, MCP check_room) on the merged room. Nothing here blocks a save: the
// runtime still re-aims / re-solves shots that lose a face (the framing guarantee) — the warnings say where the
// performer's own choice won't be used as is.
//
//   a camera that loses the face safe area (talk cameras: their spot's face; CAM_WIDE / CAM_MY_n: every spot's face)
//   CAM_REACT that no longer shows the whole react screen (or shows it small)
//   a prop that stands where a performer sits / stands, hides a face from a camera, or blocks the react screen
import { EVAL_SAFE_BY, FACE_BOX, boxOverflow } from './framing.ts';
import { faceHeight } from './roomSeats.ts';
import type { V3 } from './roomEdits.ts';

export interface CheckSpot { key: string; label?: string; pos: V3; yawDeg: number; pose: 'sit' | 'stand'; seatHeight?: number }
export interface CheckCam { name: string; pos: V3; target: V3; fov: number }
export interface CheckScreen { center: V3; corners: [V3, V3, V3, V3] }
export interface CheckProp { uid: string; name: string; min: V3; max: V3 }
export interface CheckView {
  spots: CheckSpot[];
  cams: CheckCam[];
  screen: CheckScreen | null;
  props: CheckProp[];
  avatarHeight?: number;
  aspect?: number;
  /** What the performer changed (only those get warnings; props always do). */
  edited?: { cams?: Iterable<string>; spots?: Iterable<string>; screen?: boolean };
}
export type EditWarnCode = 'cam-face' | 'cam-miss' | 'wide-face' | 'react-screen' | 'prop-spot' | 'prop-face' | 'prop-screen';
export interface EditWarning { code: EditWarnCode; level: 'warn' | 'bad'; anchor: string; text: string }

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const add = (a: V3, b: V3, k = 1): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];

/** Camera basis (no roll: up = +Y), like the runtime's lookPose. */
export function camBasis(c: CheckCam): { f: V3; r: V3; u: V3 } {
  const f = norm(sub(c.target, c.pos));
  let r = cross(f, [0, 1, 0]);
  if (Math.hypot(...r) < 1e-6) r = [1, 0, 0];
  r = norm(r);
  return { f, r, u: cross(r, f) };
}
/** A room point in the camera's NDC (x right, y up; z = depth in metres, ≤ 0 = behind the lens). */
export function project(c: CheckCam, p: V3, aspect = 16 / 9): { x: number; y: number; z: number } {
  const { f, r, u } = camBasis(c);
  const d = sub(p, c.pos);
  const z = dot(d, f);
  const t = Math.tan(((c.fov * Math.PI) / 180) / 2);
  if (z <= 1e-4) return { x: NaN, y: NaN, z };
  return { x: dot(d, r) / (z * t * aspect), y: dot(d, u) / (z * t), z };
}

/** The face centre of a spot (room space) and the face size (m) for the room's avatar height. */
export function spotFace(s: CheckSpot, avatarHeight = 1.5): { c: V3; size: number } {
  return { c: [s.pos[0], s.pos[1] + faceHeight(s, avatarHeight), s.pos[2]], size: 0.16 * (avatarHeight / 1.5) };
}

/** The projected face box of a spot through a camera (NDC), or null when the face is behind / beside the lens. */
export function faceBoxNdc(c: CheckCam, s: CheckSpot, avatarHeight = 1.5, aspect = 16 / 9): { x0: number; x1: number; y0: number; y1: number } | null {
  const { c: fc, size } = spotFace(s, avatarHeight);
  const { r } = camBasis(c);
  const pts: V3[] = [add(add(fc, [0, 1, 0], FACE_BOX.up * size), r, -FACE_BOX.side * size), add(add(fc, [0, 1, 0], FACE_BOX.up * size), r, FACE_BOX.side * size),
    add(add(fc, [0, 1, 0], -FACE_BOX.down * size), r, -FACE_BOX.side * size), add(add(fc, [0, 1, 0], -FACE_BOX.down * size), r, FACE_BOX.side * size)];
  const p = pts.map((q) => project(c, q, aspect));
  if (p.some((q) => !(q.z > 0.05))) return null;
  return { x0: Math.min(...p.map((q) => q.x)), x1: Math.max(...p.map((q) => q.x)), y0: Math.min(...p.map((q) => q.y)), y1: Math.max(...p.map((q) => q.y)) };
}

/** Does the segment a→b pass through the box (shrunk by `pad`)? Slab test. */
export function segHitsBox(a: V3, b: V3, min: V3, max: V3, pad = 0.02): boolean {
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 3; k++) {
    const lo = min[k] + pad, hi = max[k] - pad;
    if (lo > hi) return false;
    const d = b[k] - a[k];
    if (Math.abs(d) < 1e-9) { if (a[k] < lo || a[k] > hi) return false; continue; }
    let u0 = (lo - a[k]) / d, u1 = (hi - a[k]) / d;
    if (u0 > u1) [u0, u1] = [u1, u0];
    t0 = Math.max(t0, u0); t1 = Math.min(t1, u1);
    if (t0 > t1) return false;
  }
  return true;
}

const spotName = (s: CheckSpot) => s.label || s.key.replace('SPOT_', 'Spot ').replace(/ 0/, ' ');
const camName = (n: string) => (n === 'CAM_WIDE' ? 'the wide camera' : n === 'CAM_REACT' ? 'the React camera' : /^SPOT_\d\d_CAM$/.test(n) ? `the talk camera of ${n.slice(0, 7).replace('SPOT_', 'Spot ').replace(/ 0/, ' ')}` : /^CAM_MY_\d$/.test(n) ? `your camera ${n.slice(7)}` : n);

/** Every warning for a room view. */
export function checkEditView(v: CheckView): EditWarning[] {
  const out: EditWarning[] = [];
  const H = v.avatarHeight ?? 1.5, A = v.aspect ?? 16 / 9;
  const eCams = new Set(v.edited?.cams ?? []), eSpots = new Set(v.edited?.spots ?? []);
  const spotByKey = new Map(v.spots.map((s) => [s.key, s]));
  const camByName = new Map(v.cams.map((c) => [c.name, c]));
  // talk cameras: their own spot's face inside the talk safe area
  for (const c of v.cams) {
    const m = /^(SPOT_\d\d)_CAM$/.exec(c.name);
    if (!m) continue;
    const s = spotByKey.get(m[1]);
    if (!s || !(eCams.has(c.name) || eSpots.has(s.key))) continue;
    const b = faceBoxNdc(c, s, H, A);
    if (!b) { out.push({ code: 'cam-miss', level: 'bad', anchor: c.name, text: `${cap(camName(c.name))} doesn't see ${spotName(s)}'s face (it points away). VTube Pro frames that spot automatically instead.` }); continue; }
    const over = boxOverflow(b, EVAL_SAFE_BY.talk);
    if (over > 0) out.push({ code: 'cam-face', level: 'warn', anchor: c.name, text: `${cap(camName(c.name))} puts ${spotName(s)}'s face ${over > 0.25 ? 'outside the frame' : 'too close to the edge'}. VTube Pro re-aims it on air; move it so the face sits inside the guides.` });
  }
  // wide / own presets: every spot's face in the group safe area
  for (const c of v.cams) {
    if (c.name !== 'CAM_WIDE' && !/^CAM_MY_\d$/.test(c.name)) continue;
    if (!eCams.has(c.name) && ![...eSpots].length) continue;
    const off: string[] = [];
    for (const s of v.spots) { const b = faceBoxNdc(c, s, H, A); if (!b || boxOverflow(b, EVAL_SAFE_BY.wide) > 0) off.push(spotName(s)); }
    if (off.length && off.length === v.spots.length) out.push({ code: 'wide-face', level: 'bad', anchor: c.name, text: `${cap(camName(c.name))} shows none of the places people sit.` });
    else if (off.length) out.push({ code: 'wide-face', level: 'warn', anchor: c.name, text: `${cap(camName(c.name))} cuts off ${off.length > 3 ? `${off.length} places` : off.join(', ')} (faces outside the safe area).` });
  }
  // the react camera + the screen
  const rc = camByName.get('CAM_REACT');
  if (rc && v.screen && (eCams.has('CAM_REACT') || v.edited?.screen)) {
    const p = v.screen.corners.map((q) => project(rc, q, A));
    if (p.some((q) => !(q.z > 0) || Math.abs(q.x) > 1.001 || Math.abs(q.y) > 1.001)) out.push({ code: 'react-screen', level: 'warn', anchor: 'CAM_REACT', text: 'The React camera no longer shows the whole react screen. React mode then uses an automatic shot of it.' });
    else {
      const w = (Math.max(...p.map((q) => q.x)) - Math.min(...p.map((q) => q.x))) / 2;
      if (w < 0.5) out.push({ code: 'react-screen', level: 'warn', anchor: 'CAM_REACT', text: `The react screen fills only ${Math.round(w * 100)} % of the React shot's width (aim for about 80 %).` });
    }
  }
  // props
  for (const pr of v.props) {
    const name = pr.name || 'A prop';
    for (const s of v.spots) {
      const top = s.pos[1] + faceHeight(s, H) + 0.15, bottom = s.pos[1] + (s.pose === 'sit' ? (s.seatHeight ?? 0.45) + 0.05 : 0.1);
      const r = 0.22;
      const cx = Math.max(pr.min[0], Math.min(s.pos[0], pr.max[0])), cz = Math.max(pr.min[2], Math.min(s.pos[2], pr.max[2]));
      if (Math.hypot(cx - s.pos[0], cz - s.pos[2]) < r && pr.max[1] > bottom && pr.min[1] < top) {
        out.push({ code: 'prop-spot', level: 'warn', anchor: pr.uid, text: `${name} stands where ${spotName(s)} sits or stands: the performer would be inside it.` });
        break;
      }
    }
    const blocked: string[] = [];
    for (const c of v.cams) {
      const talk = /^(SPOT_\d\d)_CAM$/.exec(c.name)?.[1];
      const subjects = talk ? [spotByKey.get(talk)].filter((s): s is CheckSpot => !!s) : c.name === 'CAM_WIDE' || /^CAM_MY_\d$/.test(c.name) ? v.spots : [];
      for (const s of subjects) {
        const b = faceBoxNdc(c, s, H, A);
        if (!b || boxOverflow(b, EVAL_SAFE_BY.wide) > 0.3) continue;   // (not in that shot anyway)
        if (segHitsBox(c.pos, spotFace(s, H).c, pr.min, pr.max)) blocked.push(`${spotName(s)} from ${camName(c.name)}`);
      }
    }
    if (blocked.length) out.push({ code: 'prop-face', level: 'warn', anchor: pr.uid, text: `${name} hides ${blocked.length > 2 ? `${blocked.slice(0, 2).join(', ')} and ${blocked.length - 2} more` : blocked.join(' and ')}.` });
    if (rc && v.screen) {
      const pts = [v.screen.center, ...v.screen.corners.map((q) => add(q, sub(v.screen!.center, q), 0.15))];
      if (pts.some((q) => segHitsBox(rc.pos, q, pr.min, pr.max))) out.push({ code: 'prop-screen', level: 'warn', anchor: pr.uid, text: `${name} is in front of the react screen in the React shot.` });
    }
  }
  return out;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A prop's room-space AABB from its own box, position, rotation (deg, Euler YXZ) and scale. */
export function propBox(box: [number, number, number, number, number, number] | undefined, pos: V3, rotDeg: V3, scale: number, fallback: V3 = [0.5, 0.5, 0.5]): { min: V3; max: V3 } {
  const b = box ?? [-fallback[0] / 2, 0, -fallback[2] / 2, fallback[0] / 2, fallback[1], fallback[2] / 2];
  const [x, y, z] = rotDeg.map((d) => (d * Math.PI) / 180);
  // Euler YXZ rotation matrix (three.js order 'YXZ': R = Ry · Rx · Rz)
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  const m = [
    cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx,
    cx * sz, cx * cz, -sx,
    -sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx,
  ];
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const p = [i & 1 ? b[3] : b[0], i & 2 ? b[4] : b[1], i & 4 ? b[5] : b[2]].map((c) => c * scale);
    for (let k = 0; k < 3; k++) {
      const w = m[k * 3] * p[0] + m[k * 3 + 1] * p[1] + m[k * 3 + 2] * p[2] + pos[k];
      if (w < min[k]) min[k] = w;
      if (w > max[k]) max[k] = w;
    }
  }
  return { min, max };
}

/** An in-world chat screen as a blocker box (room space): its panel (+ frame) at its place, yaw and pitch. A screen that
 *  turns to the camera is tested as the box it sweeps (a square of its width). */
export function chatScreenBox(c: { pos: V3; yaw: number; pitch?: number; width: number; height: number; face?: string }): { min: V3; max: V3 } {
  const w = c.width / 2 + 0.04, h = c.height / 2 + 0.04;
  if (c.face === 'camera') return { min: [c.pos[0] - w, c.pos[1] - h, c.pos[2] - w], max: [c.pos[0] + w, c.pos[1] + h, c.pos[2] + w] };
  return propBox([-w, -h, -0.05, w, h, 0.05], c.pos, [c.pitch ?? 0, c.yaw, 0], 1);
}
