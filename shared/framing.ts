// Camera framing guarantee: the pure contract (no three.js, no DOM: the studio, the OBS pages and the Node tests use
// it). docs/SCENES.md "Framing guarantee"; the runtime side is src/scene/frameGuard.ts.
//
//   * safe areas per shot family: where a framed face (and its head top) may sit in the frame, in NDC (-1 ... 1). The
//     EVAL line is the severe line in cam_eval ("face-safe", desert_walker/SPEC.md §2.7), the FIX area (what the guard
//     re-solves to) a margin inside it; scene.json framing.safe overrides per room.
//   * framing classes: the size classes (shared/avatarSize.ts) plus `mech` (a pilot inside a walker / vehicle hull:
//     the framed head is the pilot's, never the hull top) and their camera rig presets (elevation, lens, dolly reach).
//   * motion envelopes: rooms whose world or camera moves (a walking ship's deck kick, an exterior camera that sees the
//     deck sway) shrink the safe area by the worst-case displacement, so the face stays safe at every phase.
//   * face boxes of call-in guests (TV / video): where the face is in the transmitted picture, and the cover-fit
//     window that keeps it inside the panel's safe area instead of cropping around the picture's centre.
import type { SizeClass } from './avatarSize.ts';
import { sizeClassOf } from './avatarSize.ts';

/** Size class, or a mech / vehicle occupant (framed on the pilot, low hero angle). */
export type FramingClass = SizeClass | 'mech';
export const FRAMING_CLASSES: readonly FramingClass[] = ['micro', 'small', 'normal', 'large', 'macro', 'mech'];

/** Shot families the guard knows. */
export type ShotFamily = 'talk' | 'single' | 'group' | 'two' | 'wide' | 'establishing' | 'tile' | 'monitor' | 'solo' | 'ttrpg' | 'remote';
export const SHOT_FAMILIES: readonly ShotFamily[] = ['talk', 'single', 'group', 'two', 'wide', 'establishing', 'tile', 'monitor', 'solo', 'ttrpg', 'remote'];

/** A safe area in NDC: face boxes inside |x| <= x, their tops <= top, chins >= -bottom; head tops (hair) <= head. */
export interface SafeArea { x: number; top: number; bottom: number; head: number }

/** Title safe (90 % of the frame). */
export const TITLE_SAFE = 0.9;
/** Action safe (93 %). */
export const ACTION_SAFE = 0.93;

/** The evaluation lines (cam_eval `face-safe`, severity 3; desert_walker/SPEC.md §2.7): a framed face box crossing its
 *  family's line is "on the fringe". Talk-like singles x 0.82 / top 0.84 / bottom 0.94, multi-person shots x 0.84 /
 *  0.86 / 0.94, a picture (the monitor's call-in picture, a remote guest in their panel) x 0.9 / 0.88 / 0.88, gaming
 *  tiles title safe. Head tops (hair, ears) must stay in the frame. scene.json `framing.safe.<family>` overrides. */
export const EVAL_SAFE_BY: Record<ShotFamily, SafeArea> = {
  talk: { x: 0.82, top: 0.84, bottom: 0.94, head: 1 },
  single: { x: 0.82, top: 0.84, bottom: 0.94, head: 1 },
  ttrpg: { x: 0.82, top: 0.84, bottom: 0.94, head: 1 },
  solo: { x: 0.82, top: 0.84, bottom: 0.94, head: 1 },
  group: { x: 0.84, top: 0.86, bottom: 0.94, head: 1 },
  two: { x: 0.84, top: 0.86, bottom: 0.94, head: 1 },
  establishing: { x: 0.84, top: 0.86, bottom: 0.94, head: 1 },
  wide: { x: 0.84, top: 0.86, bottom: 0.94, head: 1 },
  monitor: { x: 0.9, top: 0.88, bottom: 0.88, head: 1 },
  remote: { x: 0.9, top: 0.88, bottom: 0.88, head: 1 },
  tile: { x: TITLE_SAFE, top: TITLE_SAFE, bottom: TITLE_SAFE, head: 1.02 },
};
/** The loosest line (title safe): kept for callers that don't know the family. */
export const EVAL_SAFE: SafeArea = { x: TITLE_SAFE, top: TITLE_SAFE, bottom: TITLE_SAFE, head: 1 };

/** What the guard re-solves to: a margin inside the evaluation line (tracking drift, lens rounding, the live guard's
 *  head room); head tops keep a little head room. */
export const FIX_SAFE: Record<ShotFamily, SafeArea> = Object.fromEntries(SHOT_FAMILIES.map((f) => {
  const e = EVAL_SAFE_BY[f];
  return [f, { x: e.x - 0.03, top: e.top - 0.03, bottom: e.bottom - 0.04, head: Math.min(0.95, e.head - 0.04) }];
})) as Record<ShotFamily, SafeArea>;

/** A room's safe areas (scene.json `framing.safe`, e.g. `{ "talk": { "x": 0.8, "top": 0.82, "bottom": 0.94 },
 *  "picture": {…} }` — `picture` = the monitor / remote families): the evaluation line per family, and the guard's fix
 *  area the same margin inside it. */
export function safeFor(family: ShotFamily, room?: Record<string, unknown> | null): { evalArea: SafeArea; fix: SafeArea } {
  const base = EVAL_SAFE_BY[family] ?? EVAL_SAFE;
  const key = family === 'monitor' || family === 'remote' ? 'picture' : family === 'single' || family === 'ttrpg' || family === 'solo' ? 'talk' : family === 'two' || family === 'establishing' || family === 'wide' ? 'group' : family;
  const o = room && typeof room === 'object' ? ((room as Record<string, unknown>)[family] ?? (room as Record<string, unknown>)[key]) : null;
  if (!o || typeof o !== 'object') return { evalArea: base, fix: FIX_SAFE[family] ?? FIX_SAFE.talk };
  const r = o as Record<string, unknown>;
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0.3, v)) : d);
  const evalArea = { x: n(r.x, base.x), top: n(r.top, base.top), bottom: n(r.bottom, base.bottom), head: n(r.head, base.head) };
  return { evalArea, fix: { x: evalArea.x - 0.03, top: evalArea.top - 0.03, bottom: evalArea.bottom - 0.04, head: Math.min(0.95, evalArea.head - 0.04) } };
}

/** The face box measured around a face centre (in face sizes): the same box CamEval scores (forehead 1.15 up, chin 0.8
 *  down, cheeks 0.6 each side). */
export const FACE_BOX = { up: 1.15, down: 0.8, side: 0.6 };

/** Is a projected face box inside a safe area (NDC)? Returns the largest overflow (0 = inside). */
export function boxOverflow(b: { x0: number; x1: number; y0: number; y1: number }, s: Pick<SafeArea, 'x' | 'top' | 'bottom'>): number {
  return Math.max(0, -s.x - b.x0, b.x1 - s.x, b.y1 - s.top, -s.bottom - b.y0);
}

// ---------------------------------------------------------------- framing classes + rigs
/** Camera rig preset per framing class (desert_walker/SPEC.md §2.7 table). elev: the elevation range the talk grid
 *  searches (deg over the eye line; − = below, looking up: the giants' hero angle), its preferred value `elevPref`;
 *  lens: the talk shot's reference lens (deg vertical); camHeight: the preferred camera height as a share of the shown
 *  height (macro: 0.55 — clamped into the range); minDist: closest a talk camera may get (m); maxLens: widest the guard
 *  may go; dolly: how far the guard may pull back (m, at least) and per metre of shown height; step: dolly step.
 *  `normal` has no range: the classic eye-level talk grid, exactly as before. `mech`: a cockpit talk shot (the pilot's
 *  face) and a hull group shot (the whole walker in the group framing). */
export interface RigPreset {
  elev: [number, number] | null; elevPref: number; lens: number; camHeight?: number; minDist?: number; maxLens: number;
  dolly: number; dollyPerH: number; step: number; group: 'faces' | 'hull'; label: string;
}

export const RIGS: Record<FramingClass, RigPreset> = {
  micro: { elev: [0, 4], elevPref: 2, lens: 26, minDist: 0.35, maxLens: 60, dolly: 1.5, dollyPerH: 3, step: 0.08, group: 'faces', label: 'table-top eye level' },
  small: { elev: null, elevPref: 0, lens: 30, maxLens: 62, dolly: 3, dollyPerH: 2, step: 0.15, group: 'faces', label: 'eye level' },
  normal: { elev: null, elevPref: 0, lens: 30, maxLens: 64, dolly: 4, dollyPerH: 1.5, step: 0.25, group: 'faces', label: 'eye level (classic talk)' },
  large: { elev: [-3, 6], elevPref: 1.5, lens: 30, maxLens: 66, dolly: 4.5, dollyPerH: 1.5, step: 0.25, group: 'faces', label: 'slight low / eye level' },
  macro: { elev: [-14, -4], elevPref: -9, lens: 38, camHeight: 0.55, maxLens: 70, dolly: 6, dollyPerH: 1.6, step: 0.35, group: 'faces', label: 'low hero angle' },
  mech: { elev: [-10, 2], elevPref: -4, lens: 34, maxLens: 70, dolly: 6, dollyPerH: 1.6, step: 0.35, group: 'hull', label: 'cockpit hero shot (pilot face), hull group shot' },
};

/** A room's own rig tweaks (scene.json `framing.rigs.<class>`, the spec's format: `{ "elev": [-14, -4], "fov": 38,
 *  "camHeight": 0.55, "minDist": 0.35, "group": "hull" }`; `lens` = `fov`), merged over the defaults; junk is ignored. */
export function rigFor(cls: FramingClass, room?: unknown): RigPreset {
  const base = RIGS[cls] ?? RIGS.normal;
  const r = room && typeof room === 'object' ? (room as Record<string, unknown>)[cls] : null;
  if (!r || typeof r !== 'object') return base;
  const o = r as Record<string, unknown>;
  const n = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  let elev = base.elev, pref = base.elevPref;
  if (Array.isArray(o.elev) && o.elev.length === 2 && o.elev.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    const a = Math.max(-40, Math.min(40, Math.min(o.elev[0], o.elev[1]))), b = Math.max(-40, Math.min(40, Math.max(o.elev[0], o.elev[1])));
    elev = [a, b]; pref = (a + b) / 2;
  } else if (typeof o.elev === 'number' && Number.isFinite(o.elev)) { const e = n(o.elev, -40, 40, 0); elev = [e, e]; pref = e; }
  return { ...base, elev, elevPref: pref, lens: n(o.fov ?? o.lens, 12, 70, base.lens), maxLens: n(o.maxLens, 20, 80, base.maxLens),
    camHeight: typeof o.camHeight === 'number' ? n(o.camHeight, 0.05, 1.5, 0.55) : base.camHeight, minDist: typeof o.minDist === 'number' ? n(o.minDist, 0.05, 10, 0.35) : base.minDist,
    dolly: n(o.dolly, 0, 30, base.dolly), dollyPerH: n(o.dollyPerH, 0, 6, base.dollyPerH), step: n(o.step, 0.02, 2, base.step),
    group: o.group === 'hull' ? 'hull' : o.group === 'faces' ? 'faces' : base.group };
}

/** Body kinds that frame as a mech (the pilot inside a hull). */
export const MECH_BODIES: readonly string[] = ['mech', 'vehicle'];

/** The framing class of a performer: `mech` when the profile says so (profile.body 'mech' | 'vehicle', or a `mech`
 *  block from the mech avatar module), else the size class of its real height. Tolerant of anything (party guests). */
export function framingClassOf(p: { size?: unknown; body?: unknown; mech?: unknown } | null | undefined, cls?: SizeClass): FramingClass {
  if (p && (MECH_BODIES.includes(String(p.body)) || (p.mech && typeof p.mech === 'object'))) return 'mech';
  if (cls) return cls;
  const h = p && p.size && typeof p.size === 'object' ? Number((p.size as { height?: unknown }).height) : NaN;
  return Number.isFinite(h) && h > 0 ? sizeClassOf(h) : 'normal';
}

// ---------------------------------------------------------------- scene.json `framing`
/** The live drift guard's settings (scene.json `framing.live`: `false`, or `{ "on": true, "maxTurnDeg": 6, "maxZoom":
 *  1.18, "omega": 4 }`). No timers (desert_walker/SPEC.md R4: hold / release timers make pages diverge on network
 *  jitter): the correction is a smooth function of how far the face is past the safe area, through one critically
 *  damped filter of natural frequency `omega` (rad/s). (Older `after` / `release` keys are ignored.) */
export interface LiveSettings { on: boolean; maxTurnDeg: number; maxZoom: number; omega: number }
export const LIVE_DEFAULT: LiveSettings = { on: true, maxTurnDeg: 6, maxZoom: 1.18, omega: 4 };

/** scene.json `framing` (all optional): { guard: false (off for this room), live: false | LiveSettings, safe: { talk |
 *  group | picture | <family>: {x, top, bottom} }, rigs: { macro: { elev: [-14, -4], fov: 38 } }, motion:
 *  MotionEnvelope (a deck that always sways in every deck shot) }. */
export interface RoomFraming { guard: boolean; live: boolean; liveSet: LiveSettings; safe: Record<string, unknown> | null; rigs: Record<string, unknown> | null; motion: MotionEnvelope | null }
export function roomFraming(v: unknown): RoomFraming {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const obj = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null);
  const lv = obj(o.live);
  const n = (x: unknown, lo: number, hi: number, d: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);
  const liveSet: LiveSettings = lv ? { on: lv.on !== false, maxTurnDeg: n(lv.maxTurnDeg, 0, 20, 6), maxZoom: n(lv.maxZoom, 1, 1.6, 1.18), omega: n(lv.omega, 1, 12, 4) }
    : { ...LIVE_DEFAULT, on: o.live !== false };
  return { guard: o.guard !== false, live: liveSet.on, liveSet, safe: obj(o.safe), rigs: obj(o.rigs), motion: sanitizeMotion(o.motion) };
}

/** The live guard's weight of a correction (0..1) for a face `over` (NDC) past the fix area, where `band` = the gap
 *  between the fix area and the evaluation line: 0 at the fix line, 1 at the evaluation line and beyond, smooth (C1)
 *  between — a face just past the fix line barely moves the camera, one at the evaluation line is fixed in full. */
export function liveWeight(over: number, band: number): number {
  if (!(over > 0)) return 0;
  const t = Math.min(1, over / Math.max(1e-3, band));
  return t * t * (3 - 2 * t);
}

/** One step of a critically damped filter (natural frequency `w` rad/s) towards a constant `target` over `dt`, exact
 *  (no integration error: a 30 fps and a 144 fps page given the same samples end in the same place). */
export function dampStep(x: number, v: number, target: number, w: number, dt: number): [number, number] {
  if (!(dt > 0)) return [x, v];
  const y = x - target, B = v + w * y, e = Math.exp(-w * dt);
  return [target + (y + B * dt) * e, (v - w * B * dt) * e];
}

// ---------------------------------------------------------------- moving rooms
/** Worst-case motion between the camera and the performers during a shot (amplitudes): heave (m), roll / pitch / yaw /
 *  kick (deg). Ship-frame rooms (the world scrolls, the deck stands still) have none for deck cameras; an exterior
 *  camera fixed in the world sees the whole deck sway; a camera kick (a hit) is pitch on the camera. */
export interface MotionEnvelope { heave: number; roll: number; pitch: number; yaw: number; kick: number }
export const NO_MOTION: MotionEnvelope = { heave: 0, roll: 0, pitch: 0, yaw: 0, kick: 0 };

export function sanitizeMotion(v: unknown): MotionEnvelope | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const n = (x: unknown, hi: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(0, Math.abs(x))) : 0);
  const m = { heave: n(o.heave, 2), roll: n(o.roll, 15), pitch: n(o.pitch, 15), yaw: n(o.yaw, 15), kick: n(o.kick, 10) };
  return m.heave || m.roll || m.pitch || m.yaw || m.kick ? m : null;
}

/** How a motion envelope is rounded before a guarded shot is solved for it: as ONE step on a doubling scale of a
 *  reference envelope (a battle on a walking deck), always covering every component — so a continuously varying
 *  envelope (a voyage's speed, a storm building) re-solves the guarded shots only when it crosses a step (a calm-to-battle
 *  build-up: 4 solves, never one per frame), and every page rounds the same envelope to the same step. */
export const MOTION_REF: MotionEnvelope = { heave: 0.08, roll: 1.2, pitch: 0.8, yaw: 0.6, kick: 0.7 };
export const MOTION_LEVELS = [0.125, 0.25, 0.5, 1, 2, 4, 8, 16];
export function quantizeMotion(v: MotionEnvelope | null | undefined): MotionEnvelope | null {
  const m = sanitizeMotion(v);
  if (!m) return null;
  const R = MOTION_REF;
  const k = Math.max(m.heave / R.heave, m.roll / R.roll, m.pitch / R.pitch, m.yaw / R.yaw, m.kick / R.kick);
  const q = MOTION_LEVELS.find((l) => k <= l + 1e-9) ?? MOTION_LEVELS[MOTION_LEVELS.length - 1];
  // (the step's envelope, never under a component that was there: clamped to the sane maxima like sanitizeMotion)
  return { heave: Math.min(2, Math.max(m.heave, R.heave * q)), roll: Math.min(15, Math.max(m.roll, R.roll * q)), pitch: Math.min(15, Math.max(m.pitch, R.pitch * q)),
    yaw: Math.min(15, Math.max(m.yaw, R.yaw * q)), kick: Math.min(10, Math.max(m.kick, R.kick * q)) };
}

/** Combine two envelopes (worst case of both). */
export function addMotion(a: MotionEnvelope | null | undefined, b: MotionEnvelope | null | undefined): MotionEnvelope | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return { heave: a.heave + b.heave, roll: a.roll + b.roll, pitch: a.pitch + b.pitch, yaw: a.yaw + b.yaw, kick: a.kick + b.kick };
}

const D2R = Math.PI / 180;
/** NDC displacement bound of a point at NDC (x, y), depth `dist` (m), under a motion envelope, for a camera of vertical
 *  lens `fov` (deg) and `aspect`. Small-angle: pitch / kick move y by θ·sec² / tan(fov/2), yaw moves x likewise, roll
 *  rotates the tangent plane (a point far from the centre moves most), heave moves y by h / (d·tan(fov/2)). */
export function motionInset(m: MotionEnvelope | null | undefined, dist: number, fov: number, aspect: number, x: number, y: number): { x: number; y: number } {
  if (!m) return { x: 0, y: 0 };
  const t = Math.tan((fov * D2R) / 2), a = Math.max(0.2, aspect);
  const u = x * t * a, v = y * t;                                   // tangent-plane coordinates
  const pv = (m.pitch + m.kick) * D2R, yw = m.yaw * D2R, rl = m.roll * D2R;
  const dy = (pv * (1 + v * v)) / t + (Math.abs(u) * rl) / t + m.heave / Math.max(0.2, dist) / t;
  const dx = (yw * (1 + u * u)) / (t * a) + (Math.abs(v) * rl) / (t * a);
  return { x: dx, y: dy };
}

// ---------------------------------------------------------------- call-in face boxes (TV / video guests)
/** Where the face is in a picture: [x, y, w, h], fractions of the picture, top-left origin. */
export type FaceBox = [number, number, number, number];

/** A clean face box (quantised to 1/128 so a jittery tracker doesn't re-send / re-crop every frame), or undefined. */
export function sanitizeFaceBox(v: unknown): FaceBox | undefined {
  if (!Array.isArray(v) || v.length !== 4 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) return undefined;
  const q = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 128) / 128;
  let [x, y, w, h] = v as number[];
  if (w < 0.01 || h < 0.01 || w > 1 || h > 1) return undefined;
  x = Math.min(Math.max(0, x), 1 - w); y = Math.min(Math.max(0, y), 1 - h);
  const b: FaceBox = [q(x), q(y), q(w), q(h)];
  return b[2] >= 1 / 128 && b[3] >= 1 / 128 ? b : undefined;
}

/** Same box? (within `eps`, to skip re-sends) */
export function sameFaceBox(a: FaceBox | undefined | null, b: FaceBox | undefined | null, eps = 1 / 64): boolean {
  if (!a || !b) return !a && !b;
  return a.every((v, i) => Math.abs(v - b[i]) <= eps);
}

/** 1-D window placement: a window of length `len` inside [lo, hi] (centred by default) moved so that [f0, f1] sits in
 *  its inner `safe` fraction; a face too big for that is centred; always clamped inside [lo, hi]. Returns the start. */
export function slideWindow(lo: number, hi: number, len: number, f0: number, f1: number, safe: number): number {
  const span = hi - lo;
  if (len >= span - 1e-9) return lo;
  let s = lo + (span - len) / 2;
  const m = (len * (1 - safe)) / 2;
  if (f1 - f0 > len - 2 * m) s = (f0 + f1) / 2 - len / 2;          // too big: centre on it
  else if (f0 < s + m) s = f0 - m;
  else if (f1 > s + len - m) s = f1 + m - len;
  return Math.min(hi - len, Math.max(lo, s));
}

/** Cover-fit crop of a picture into a panel that keeps the face inside the panel's safe area. `crop` = the part of the
 *  picture the panel may use ([x, y, w, h] fractions, top-left; default the whole picture), `srcAspect` the picture's
 *  w/h, `panelAspect` the panel's. Returns the crop the panel shows (top-left origin, fractions of the picture). Without
 *  a face: the centred cover crop (exactly the old behaviour). */
export function coverCrop(srcAspect: number, panelAspect: number, crop: FaceBox | null | undefined, face: FaceBox | null | undefined, safe = 0.78): FaceBox {
  let [cx, cy, cw, ch] = crop ?? [0, 0, 1, 1];
  const x0 = cx, y0 = cy, w0 = cw, h0 = ch;
  const sa = (srcAspect > 0 ? srcAspect : panelAspect) * (cw / ch);
  if (sa > panelAspect) { const nw = cw * panelAspect / sa; cx += (cw - nw) / 2; cw = nw; } else { const nh = ch * sa / panelAspect; cy += (ch - nh) / 2; ch = nh; }
  if (face) {
    cx = slideWindow(x0, x0 + w0, cw, face[0], face[0] + face[2], safe);
    cy = slideWindow(y0, y0 + h0, ch, face[1], face[1] + face[3], safe);
  }
  return [cx, cy, cw, ch];
}

/** The TV screen's cover window in feed UV (y up, centre 0.5): the visible fraction (fx, fy) and the window centre's
 *  offset from the picture centre, so the face box stays in the window's inner `safe` part. (The shader adds the
 *  offset after its mirror flip, so a mirrored picture needs nothing special.) */
export function coverOffset(feedAspect: number, surfAspect: number, face: FaceBox | null | undefined, safe = 0.78): { fx: number; fy: number; ox: number; oy: number } {
  const r = feedAspect / Math.max(1e-3, surfAspect);
  const fx = r > 1 ? 1 / r : 1, fy = r > 1 ? 1 : r;
  if (!face) return { fx, fy, ox: 0, oy: 0 };
  // (feed uv: x as sent (the shader adds the offset after its mirror flip), y up)
  const f0x = face[0], f1x = face[0] + face[2];
  const f0y = 1 - (face[1] + face[3]), f1y = 1 - face[1];
  const sx = slideWindow(0, 1, fx, f0x, f1x, safe), sy = slideWindow(0, 1, fy, f0y, f1y, safe);
  return { fx, fy, ox: sx + fx / 2 - 0.5, oy: sy + fy / 2 - 0.5 };
}

/** Where a picture's face box lands on a TV / projector surface (uv 0..1, y up, as drawn: fit + the face-following
 *  offset + mirror) and its height as a fraction of the surface height. null = no face box (or it fell off). */
export function faceOnSurface(face: FaceBox | null | undefined, feedAspect: number, surfAspect: number, fit: 'cover' | 'contain', mirror: boolean): { u: number; v: number; h: number } | null {
  if (!face) return null;
  const r = feedAspect / Math.max(1e-3, surfAspect);
  let fx = 1, fy = 1, ox = 0, oy = 0;
  if (fit === 'contain') { if (r > 1) fy = r; else fx = 1 / r; }
  else ({ fx, fy, ox, oy } = coverOffset(feedAspect, surfAspect, face));
  // shader: fu = mirror((puv - 0.5) * f + 0.5) + off  →  puv from a feed point F
  const Fx = face[0] + face[2] / 2, Fy = 1 - (face[1] + face[3] / 2);
  const preX = mirror ? 1 - (Fx - ox) : Fx - ox, preY = Fy - oy;
  const u = (preX - 0.5) / fx + 0.5, v = (preY - 0.5) / fy + 0.5;
  if (u < -0.2 || u > 1.2 || v < -0.2 || v > 1.2) return null;
  return { u, v, h: face[3] / fy };
}
