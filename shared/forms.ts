// Room forms (docs/SCENES.md -> "Room forms"): a room's set pieces change shape with WHO is at a zone of spots.
//
//   scene.json `forms`
//     zones   host / couch / ...: the spots that make a zone, the forms to try in order, the default form
//     list    form id -> { zone, when (occupant classes / kinds / sizes), nodes (shown while it is up), hide (room
//             nodes hidden while it is up), spots (the zone's spots moved / re-posed: a docking cradle, a desk perch),
//             seatSurfaces, lightGroups (EMIT_<group> programs: rotating beacons, runway chase), cams, in / out
//             animations (tweens of node offsets from their authored rest pose, cues: steam, sparks, light hits) }
//     kit     procedural set pieces (src/scene/forms/kit.ts) for rooms that don't author the nodes in their GLB
//   scene.json `occupants`   occupant rules (shared/occupant.ts)
//   scene.json `bigEntrance` the big-character entrance (src/scene/forms/bigEntrance.ts): hangar doors / floor lift /
//                            drop from above for large / giant / mech occupants
//
// SYNC: the HOST picks each zone's form (pickForm, from the occupants' classes) and stamps it into the scene state's
// mode bag SceneState.modes.forms = { v: 1, room, zones: { host: { id, from, at } } } (stampFormsBag, in the studio
// controller's commit, next to the walk stamps). Every page (studio preview, OBS, guests' OBS: the clock is shifted
// like every other stamp, shiftFormsClock) plays the transform as a pure function of (now - at): formPhase +
// sampleZone. A page that joins late lands mid-transform; nothing accumulates. Pages without a bag (an older host, a
// test page) derive the same choice from the performers they see.
//
// Pure data + maths: no three.js, no DOM. Node tests: tools/forms_unit.ts.
import { isSizeClass, type SizeClass } from './avatarSize.ts';
import {
  DEFAULT_OCCUPANT_RULES, biggestOccupant, isOccupantClass, isOccupantKind, parseKinds, sanitizeOccupantRules,
  type Occupant, type OccupantClass, type OccupantKind, type OccupantRules, type ZoneConverts,
} from './occupant.ts';

export type Vec3 = [number, number, number];

// ---------------------------------------------------------------- easing
export const EASES = ['linear', 'inQuad', 'outQuad', 'inOutQuad', 'inCubic', 'outCubic', 'inOutCubic', 'inOutSine', 'outBack', 'inBack', 'outBounce', 'outElastic', 'step', 'stutter'] as const;
export type EaseName = (typeof EASES)[number];
const clamp01 = (k: number) => (k < 0 ? 0 : k > 1 ? 1 : k);
export function ease(name: EaseName, k0: number): number {
  const k = clamp01(k0);
  switch (name) {
    case 'linear': return k;
    case 'inQuad': return k * k;
    case 'outQuad': return 1 - (1 - k) * (1 - k);
    case 'inOutQuad': return k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    case 'inCubic': return k * k * k;
    case 'outCubic': return 1 - (1 - k) ** 3;
    case 'inOutCubic': return k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
    case 'inOutSine': return -(Math.cos(Math.PI * k) - 1) / 2;
    case 'outBack': { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * (k - 1) ** 3 + c1 * (k - 1) ** 2; }
    case 'inBack': { const c1 = 1.70158, c3 = c1 + 1; return c3 * k * k * k - c1 * k * k; }
    case 'outBounce': {
      const n1 = 7.5625, d1 = 2.75;
      if (k < 1 / d1) return n1 * k * k;
      if (k < 2 / d1) { const x = k - 1.5 / d1; return n1 * x * x + 0.75; }
      if (k < 2.5 / d1) { const x = k - 2.25 / d1; return n1 * x * x + 0.9375; }
      const x = k - 2.625 / d1; return n1 * x * x + 0.984375;
    }
    case 'outElastic': return k === 0 || k === 1 ? k : 2 ** (-10 * k) * Math.sin((k * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
    case 'step': return k >= 1 ? 1 : 0;
    // a hydraulic stutter: the speed pulses three times, never backwards
    case 'stutter': { const e = k * k * (3 - 2 * k); return e - 0.045 * Math.sin(6 * Math.PI * e); }
  }
  return k;
}
const isEase = (v: unknown): v is EaseName => typeof v === 'string' && (EASES as readonly string[]).includes(v);

// ---------------------------------------------------------------- the scene.json contract
/** Who a form is for. Every field given must hold for ONE occupant of the zone (any of them); `empty` = only when the
 *  zone is empty; no field at all = always (a zone's catch-all default); `or` = an alternative. */
export interface FormWhen {
  cls?: OccupantClass[]; size?: SizeClass[]; kind?: OccupantKind[];
  minHeight?: number; maxHeight?: number; empty?: boolean; or?: FormWhen;
}
/** A number, or "fit.<key>" (the zone's fit value: shared/forms.ts fitFor - e.g. the dock well's depth). */
export type FitNum = number | string;
export type FitVec3 = [FitNum, FitNum, FitNum];
/** An offset from a node's authored rest pose: pos (m, the node's parent space), rot (deg, XYZ, applied in the node's
 *  own frame), scale (multiplies the rest scale); `radial`: "fit.clampR" = slide out from the parent's centre to the
 *  occupant's foot contact distance (each-tweens: per node index). */
export interface FormDelta { pos?: FitVec3; rot?: FitVec3; scale?: FitVec3; radial?: string }

// ---------------------------------------------------------------- fit (creations/desert_walker/SPEC.md 2.5)
/** Continuous fit of a form to its occupant (host-computed, in the bag): desk top, chair seat, the dock well under a
 *  pilot, holo plate / call-in screen heights, a console rail, the clamps' radial distances (room metres). */
export interface FormFit { deskY?: number; chairY?: number; wellY?: number; holoY?: number; monY?: number; railY?: number; clampR?: number[] }
export const FIT_KEYS = ['deskY', 'chairY', 'wellY', 'holoY', 'monY', 'railY', 'clampR'] as const;
export type FitKey = (typeof FIT_KEYS)[number];
const isFitKey = (v: unknown): v is FitKey => typeof v === 'string' && (FIT_KEYS as readonly string[]).includes(v);
/** A fit value applied to a node: offset along `axis` = clamp(value - rest, min, max), eased in with the form. */
export interface FitBind { key: Exclude<FitKey, 'clampR'>; node: string; axis: 0 | 1 | 2; rest: number; min: number; max: number }
/** What the occupant fit reads (shared/occupant.ts Occupant: shown size, pilot eye, foot contacts, kind). */
export interface FitInput { shown: number; kind?: string; cls?: string; pilotEye?: number; contactR?: number[]; seat?: number }
/** SPEC 2.5 fitFor: desk top = seat + 0.13 x shown + 0.05; chair = clamp(0.27 x shown, 0.38, 0.62); dock well =
 *  clamp(1.35 - pilot eye, -0.6, 0.4); holo plate = pilot eye - 0.35; call-in screen = clamp(eye + 0.45, 1.7, 2.9);
 *  console rail = 0.42 x shown (0.9 - 1.6), a quadruped's bar 0.55 x withers; clamps = the foot contacts. mm-rounded. */
export function fitFor(o: FitInput | null): FormFit {
  if (!o || !(o.shown > 0)) return {};
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const cl = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const seat = o.seat ?? 0.48, sh = o.shown;
  const quad = o.kind === 'quadruped';
  const eye = o.pilotEye ?? (o.cls === 'giant' || quad ? sh * 0.9 : seat + 0.46 * sh);
  const out: FormFit = {
    deskY: r(seat + 0.13 * sh + 0.05),
    chairY: r(cl(0.27 * sh, 0.38, 0.62)),
    holoY: r(eye - 0.35 * (o.pilotEye != null ? 1 : sh / 1.5)),
    monY: r(cl(eye + 0.45, 1.7, 2.9)),
    railY: r(quad ? 0.55 * sh * 0.62 : cl(0.42 * sh, 0.9, 1.6)),
  };
  if (o.pilotEye != null) out.wellY = r(cl(1.35 - o.pilotEye, -0.6, 0.4));
  if (o.contactR?.length) out.clampR = o.contactR.slice(0, 8).map(r);
  return out;
}
function sanitizeFit(v: unknown): FormFit | undefined {
  const x = obj(v), out: FormFit = {};
  for (const k of FIT_KEYS) {
    const e = x[k];
    if (k === 'clampR') { if (Array.isArray(e)) { const a = e.slice(0, 8).filter((n): n is number => typeof n === 'number' && Number.isFinite(n)).map((n) => Math.min(20, Math.max(0, n))); if (a.length) out.clampR = a; } }
    else if (typeof e === 'number' && Number.isFinite(e)) out[k] = Math.min(40, Math.max(-20, e));
  }
  return Object.keys(out).length ? out : undefined;
}
export interface FormTween {
  /** Node name, or with `each` a name PREFIX: every node whose name starts with it (sorted by name), `stagger` s apart. */
  node: string;
  each?: boolean;
  stagger?: number;
  /** from -> to (either may be missing = the rest pose). `from` only = it arrives; `to` only = it leaves. */
  from?: FormDelta;
  to?: FormDelta;
  /** 'rise': from below the floor by its own height (the runtime measures it) - the default in-animation. */
  auto?: 'rise';
  /** Seconds into the animation. */
  t: [number, number];
  ease: EaseName;
}
export const FX_KINDS = ['steam', 'sparks', 'dust', 'flash', 'beam', 'thrust'] as const;
export type FxKind = (typeof FX_KINDS)[number];
export interface FormCue {
  /** Seconds into the animation. */
  at: number;
  fx?: FxKind;
  /** Where: a node's world position, else `pos` (glTF space), else the zone's first spot. */
  anchor?: string;
  pos?: Vec3;
  size?: number;
  color?: string;
  /** The light engine's moments: 'drop' (a hit), 'ball', 'lasers'; or `cue` = a named cue ('big' celebration ...). */
  light?: 'drop' | 'ball' | 'lasers';
  cue?: string;
  secs?: number;
}
export interface FormAnim { dur: number; tweens: FormTween[]; cues: FormCue[] }
export interface CamDef { pos: Vec3; target: Vec3; fov: number }
export interface FormSpot {
  pos?: Vec3; yaw?: number; pose?: 'sit' | 'stand'; seatHeight?: number; sizes?: SizeClass[]; label?: string;
  /** Body kinds the variant takes (SPEC 3.7 dock `kinds: ["mech", "vehicle"]`; shared/occupant.ts spotFitOcc). */
  kinds?: OccupantKind[];
  /** Explicit head room (skips the measured clamp: a docking cradle under an opened ceiling). */
  clearance?: { height: number; radius: number };
  /** This spot's talk camera while the form is up (replaces SPOT_xx_CAM). */
  cam?: CamDef;
  approach?: Vec3[];
  /** The spot rides this node: it moves with the node's animated offset (a chair on a riser, a perch podium, a cradle).
   *  scene.json `ride` or the SPEC's `carrier`. */
  ride?: string;
}
export interface SeatSurfaceDef { node?: string; at?: Vec3; yaw?: number; halfW: number; halfD: number; top?: number }
export const LIGHT_PROGRAMS = ['rotate', 'chase', 'pulse', 'steady', 'flash', 'off'] as const;
export type LightProgramName = (typeof LIGHT_PROGRAMS)[number];
export interface LightProgram { program: LightProgramName; color?: string; speed: number; intensity: number }
export interface FormDef {
  id: string;
  zone: string;
  label: string;
  when: FormWhen;
  nodes: string[];
  hide: string[];
  spots: Record<string, FormSpot>;
  seatSurfaces: SeatSurfaceDef[];
  lightGroups: Record<string, LightProgram>;
  cams: Record<string, CamDef>;
  in: FormAnim;
  /** null = the in-animation played backwards over outDur. */
  out: FormAnim | null;
  /** Out-animations for a particular next form (form id or '*'): the desk SPLITS for the dock but simply sinks for a
   *  giant's console. Missing = `out`. */
  outTo: Record<string, FormAnim>;
  /** How long the reversed in-animation takes when there is no explicit out-animation (s). */
  outDur: number;
  /** The in-animation starts this long before the previous form's out-animation ends (s). */
  overlap: number;
  /** A projected desk plate in front of a mech pilot's face (the mech host still has a desk + name plate). */
  holoDesk: { node: string; below: number; ahead: number } | null;
  /** A node scaled with the zone's biggest occupant's shown height (a giant's console grows with the giant). */
  scaleTo: { node: string; ref: number; min: number; max: number } | null;
  /** Fit keys this form uses (scene.json `fit`: a list - SPEC 2.5 - or bindings { deskY: { node, axis, rest, min, max } });
   *  a listed deskY / railY with no binding moves the form's first node up / down to the fitted height. */
  fit: FitKey[];
  fitBind: FitBind[];
}
export interface ZoneDef { id: string; spots: string[]; order: string[]; default: string }
/** A procedural set piece (src/scene/forms/kit.ts): `piece` kind, node `name`, glTF-space `at` + `yaw` (deg), plus the
 *  piece's own numbers / colours (w, d, h, color ...). */
export interface KitPieceDef { piece: string; name: string; at: Vec3; yaw: number; params: Record<string, number | string | boolean | number[]> }
export interface FormsDef {
  zones: Record<string, ZoneDef>;
  list: Record<string, FormDef>;
  kit: KitPieceDef[];
  rules: OccupantRules;
  /** Every EMIT_ / LIGHT_ group a form programs (taken away from the room light engine: formsLightGroups). */
  lightGroups: string[];
}

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const NODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const num = (v: unknown, d: number, lo = -Infinity, hi = Infinity) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const vec3 = (v: unknown): Vec3 | undefined => (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? [v[0], v[1], v[2]] : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const strs = (v: unknown, re = NODE, max = 64): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && re.test(x)))].slice(0, max) : typeof v === 'string' && re.test(v) ? [v] : []);

function cleanWhen(v: unknown, depth = 0): FormWhen {
  const x = obj(v), out: FormWhen = {};
  // (`cls` takes occupant classes; the SPEC's size-class names 'normal' / 'macro' there mean the size class)
  const rawCls = Array.isArray(x.cls) ? x.cls : [];
  const cls = rawCls.filter(isOccupantClass);
  if (cls.length) out.cls = [...new Set(cls)];
  const size = [...(Array.isArray(x.size) ? x.size.filter(isSizeClass) : []), ...rawCls.filter((c): c is SizeClass => c === 'normal' || c === 'macro')];
  if (size.length) out.size = [...new Set(size)];
  const kind = Array.isArray(x.kind) ? x.kind.filter(isOccupantKind) : null;
  if (kind?.length) out.kind = [...new Set(kind)];
  if (typeof x.minHeight === 'number' && Number.isFinite(x.minHeight)) out.minHeight = x.minHeight;
  if (typeof x.maxHeight === 'number' && Number.isFinite(x.maxHeight)) out.maxHeight = x.maxHeight;
  if (x.empty === true) out.empty = true;
  if (x.or && depth < 3) out.or = cleanWhen(x.or, depth + 1);
  return out;
}
const FIT_REF = /^fit\.(deskY|chairY|wellY|holoY|monY|railY|clampR)$/;
const fitVec3 = (v: unknown): FitVec3 | undefined => (Array.isArray(v) && v.length === 3 && v.every((x) => (typeof x === 'number' && Number.isFinite(x)) || (typeof x === 'string' && FIT_REF.test(x))) ? [v[0], v[1], v[2]] : undefined);
function cleanDelta(v: unknown): FormDelta | undefined {
  const x = obj(v);
  const d: FormDelta = {};
  const p = fitVec3(x.pos), r = fitVec3(x.rot), s = fitVec3(x.scale);
  if (p) d.pos = p; if (r) d.rot = r; if (s) d.scale = s.map((k) => (typeof k === 'number' ? Math.max(1e-4, k) : k)) as FitVec3;
  if (typeof x.radial === 'string' && FIT_REF.test(x.radial)) d.radial = x.radial;
  return p || r || s || d.radial ? d : undefined;
}
function cleanTween(v: unknown): FormTween | null {
  const x = obj(v);
  if (typeof x.node !== 'string' || !NODE.test(x.node)) return null;
  const t = Array.isArray(x.t) && x.t.length === 2 ? [num(x.t[0], 0, 0, 600), num(x.t[1], 1, 0, 600)] as [number, number] : [0, 1] as [number, number];
  if (t[1] < t[0]) t[1] = t[0];
  const tw: FormTween = { node: x.node, t, ease: isEase(x.ease) ? x.ease : 'inOutCubic' };
  if (x.each === true || typeof x.each === 'string') { tw.each = true; if (typeof x.each === 'string' && NODE.test(x.each)) tw.node = x.each; }
  if (typeof x.stagger === 'number' && Number.isFinite(x.stagger)) tw.stagger = Math.min(5, Math.max(0, x.stagger));
  const f = cleanDelta(x.from), to = cleanDelta(x.to);
  if (f) tw.from = f; if (to) tw.to = to;
  if (x.auto === 'rise') tw.auto = 'rise';
  return f || to || tw.auto ? tw : null;
}
function cleanCue(v: unknown): FormCue | null {
  const x = obj(v);
  const at = num(x.at, NaN, 0, 600);
  if (!Number.isFinite(at)) return null;
  const c: FormCue = { at };
  if (typeof x.fx === 'string' && (FX_KINDS as readonly string[]).includes(x.fx)) c.fx = x.fx as FxKind;
  if (typeof x.anchor === 'string' && NODE.test(x.anchor)) c.anchor = x.anchor;
  const p = vec3(x.pos); if (p) c.pos = p;
  if (typeof x.size === 'number' && Number.isFinite(x.size)) c.size = Math.min(20, Math.max(0.05, x.size));
  if (typeof x.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(x.color)) c.color = x.color;
  if (x.light === 'drop' || x.light === 'ball' || x.light === 'lasers') c.light = x.light;
  if (typeof x.cue === 'string' && /^[a-zA-Z]{2,16}$/.test(x.cue)) c.cue = x.cue;
  if (typeof x.secs === 'number' && Number.isFinite(x.secs)) c.secs = Math.min(30, Math.max(0.2, x.secs));
  return c.fx || c.light || c.cue ? c : null;
}
function cleanAnim(v: unknown): FormAnim | null {
  if (!v || typeof v !== 'object') return null;
  const x = obj(v);
  const tweens = (Array.isArray(x.tweens) ? x.tweens : []).slice(0, 64).map(cleanTween).filter((t): t is FormTween => !!t);
  const cues = (Array.isArray(x.cues) ? x.cues : []).slice(0, 32).map(cleanCue).filter((c): c is FormCue => !!c);
  const end = Math.max(0, ...tweens.map((t) => t.t[1]), ...cues.map((c) => c.at));
  return { dur: num(x.dur, Math.max(0.4, end), 0, 600), tweens, cues };
}
function cleanCam(v: unknown): CamDef | undefined {
  const x = obj(v);
  const pos = vec3(x.pos), target = vec3(x.target);
  return pos && target ? { pos, target, fov: num(x.fov, 34, 8, 100) } : undefined;
}
function cleanSpot(v: unknown): FormSpot {
  const x = obj(v), s: FormSpot = {};
  const p = vec3(x.pos); if (p) s.pos = p;
  if (typeof x.yaw === 'number' && Number.isFinite(x.yaw)) s.yaw = x.yaw;
  if (x.pose === 'sit' || x.pose === 'stand') s.pose = x.pose;
  if (typeof x.seatHeight === 'number' && Number.isFinite(x.seatHeight)) s.seatHeight = Math.min(1.4, Math.max(0.15, x.seatHeight));
  const sizes = Array.isArray(x.sizes) ? x.sizes.filter(isSizeClass) : typeof x.sizes === 'string' ? x.sizes.split(/[\s,]+/).filter(isSizeClass) : null;
  if (sizes?.length) s.sizes = [...new Set(sizes)];
  const kinds = parseKinds(x.kinds);
  if (kinds) s.kinds = kinds;
  if (typeof x.label === 'string') s.label = x.label.slice(0, 40);
  const c = obj(x.clearance);
  if (typeof c.height === 'number' && Number.isFinite(c.height)) s.clearance = { height: Math.min(80, Math.max(0.5, c.height)), radius: num(c.radius, 1.5, 0.2, 20) };
  const cam = cleanCam(x.cam); if (cam) s.cam = cam;
  if (Array.isArray(x.approach)) { const a = x.approach.map(vec3).filter((q): q is Vec3 => !!q).slice(0, 16); if (a.length) s.approach = a; }
  if (typeof x.ride === 'string' && NODE.test(x.ride)) s.ride = x.ride;
  else if (typeof x.carrier === 'string' && NODE.test(x.carrier)) s.ride = x.carrier;
  return s;
}

/** Light groups a form may program: names starting with `form` (SPEC 2.5). */
export const FORM_GROUP = /^form[A-Za-z0-9_]{0,28}$/;

/** scene.json `fit`: a list of keys (SPEC) or bindings; a listed deskY / railY binds the form's first node. */
function cleanFit(v: unknown, nodes: string[]): { fit: FitKey[]; fitBind: FitBind[] } {
  const keys: FitKey[] = [], bind: FitBind[] = [];
  const AX: Record<string, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };
  if (Array.isArray(v)) for (const k of v) { if (isFitKey(k) && !keys.includes(k)) keys.push(k); }
  else for (const [k, b] of Object.entries(obj(v)).slice(0, 8)) {
    if (!isFitKey(k) || k === 'clampR') continue;
    const x = obj(b);
    if (!keys.includes(k)) keys.push(k);
    if (typeof x.node === 'string' && NODE.test(x.node)) bind.push({ key: k, node: x.node, axis: AX[String(x.axis ?? 'y')] ?? 1, rest: num(x.rest, 0, -20, 40), min: num(x.min, -1, -20, 0), max: num(x.max, 1, 0, 20) });
  }
  // the SPEC's plain list: the desk / rail is the form's first node, authored at the standard height
  for (const k of ['deskY', 'railY'] as const) if (keys.includes(k) && !bind.some((b) => b.key === k) && nodes[0]) bind.push({ key: k, node: nodes[0], axis: 1, rest: k === 'deskY' ? 0.76 : 1.1, min: -0.35, max: 0.6 });
  return { fit: keys, fitBind: bind };
}

/** The rise depth placeholder of an `auto: 'rise'` tween is measured by the runtime (riseFrom). */
const defaultIn = (nodes: string[]): FormAnim => ({ dur: 1.4, cues: [], tweens: nodes.map((n) => ({ node: n, auto: 'rise' as const, t: [0, 1.2] as [number, number], ease: 'outCubic' as const })) });

/** scene.json `forms` (+ `occupants`) -> a clean definition; null = the room has no forms. */
export function parseForms(info: unknown): FormsDef | null {
  const root = obj(info);
  const f = obj(root.forms);
  const zs = obj(f.zones), ls = obj(f.list);
  if (!Object.keys(zs).length || !Object.keys(ls).length) return null;
  const list: Record<string, FormDef> = {};
  for (const [id, raw] of Object.entries(ls).slice(0, 48)) {
    if (!ID.test(id)) continue;
    const x = obj(raw);
    const nodes = strs(x.nodes);
    const spots: Record<string, FormSpot> = {};
    for (const [sn, sv] of Object.entries(obj(x.spots)).slice(0, 12)) if (/^(SPOT|SEAT)_\d{1,2}$/.test(sn)) spots[sn] = cleanSpot(sv);
    const lightGroups: Record<string, LightProgram> = {};
    for (const [g, lv] of Object.entries(obj(x.lightGroups)).slice(0, 8)) {
      const l = obj(lv);
      // (SPEC 2.5: only groups starting with `form` - EMIT_formbeacon, EMIT_formrunway - leave the room light engine; a
      //  room's own neon, say EMIT_holo, is never taken over by a form)
      if (!FORM_GROUP.test(g)) continue;
      lightGroups[g] = { program: (LIGHT_PROGRAMS as readonly string[]).includes(l.program as string) ? l.program as LightProgramName : 'steady',
        ...(typeof l.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(l.color) ? { color: l.color } : {}), speed: num(l.speed, 1, 0.05, 10), intensity: num(l.intensity, 1, 0, 20) };
    }
    const cams: Record<string, CamDef> = {};
    for (const [cn, cv] of Object.entries(obj(x.cams)).slice(0, 8)) { const c = cleanCam(cv); if (c && /^(CAM_[A-Za-z0-9_]{1,40}|SPOT_\d{1,2}_CAM)$/.test(cn)) cams[cn] = c; }
    const seatSurfaces = (Array.isArray(x.seatSurfaces) ? x.seatSurfaces : []).slice(0, 8).map((sv) => {
      const s = obj(sv);
      const halfW = num(s.halfW, NaN, 0.05, 10), halfD = num(s.halfD, NaN, 0.05, 10);
      if (!Number.isFinite(halfW) || !Number.isFinite(halfD)) return null;
      const out: SeatSurfaceDef = { halfW, halfD };
      if (typeof s.node === 'string' && NODE.test(s.node)) out.node = s.node;
      const at = vec3(s.at); if (at) out.at = at;
      if (typeof s.yaw === 'number' && Number.isFinite(s.yaw)) out.yaw = s.yaw;
      if (typeof s.top === 'number' && Number.isFinite(s.top)) out.top = s.top;
      return out.node || out.at ? out : null;
    }).filter((s): s is SeatSurfaceDef => !!s);
    const hd = obj(x.holoDesk);
    const st = obj(x.scaleTo);
    const inA = cleanAnim(x.in), outA = cleanAnim(x.out);
    const inAnim = inA && (inA.tweens.length || inA.cues.length) ? inA : { ...defaultIn(nodes), ...(inA ? { dur: Math.max(inA.dur, 1.4) } : {}) };
    list[id] = {
      id, zone: typeof x.zone === 'string' ? x.zone : '', label: typeof x.label === 'string' ? x.label.slice(0, 40) : id,
      when: cleanWhen(x.when), nodes, hide: strs(x.hide), spots, seatSurfaces, lightGroups, cams,
      in: inAnim,
      out: outA && (outA.tweens.length || outA.cues.length) ? outA : null,
      // (a bare `out: { dur }` still sets how long the reversed in-animation takes)
      outDur: outA ? outA.dur : inAnim.dur,
      outTo: Object.fromEntries(Object.entries(obj(x.outTo)).slice(0, 12).map(([k, v]) => [k, cleanAnim(v)] as const).filter((e): e is [string, FormAnim] => (e[0] === '*' || ID.test(e[0])) && !!e[1] && (e[1].tweens.length > 0 || e[1].cues.length > 0))),
      overlap: num(x.overlap, 0.4, 0, 30),
      holoDesk: typeof hd.node === 'string' && NODE.test(hd.node) ? { node: hd.node, below: num(hd.below, 0.45, -2, 3), ahead: num(hd.ahead, 0.9, 0, 6) } : null,
      scaleTo: typeof st.node === 'string' && NODE.test(st.node) ? { node: st.node, ref: num(st.ref, 3, 0.2, 80), min: num(st.min, 0.6, 0.05, 20), max: num(st.max, 2.5, 0.05, 40) } : null,
      ...cleanFit(x.fit, nodes),
    };
  }
  const zones: Record<string, ZoneDef> = {};
  for (const [id, raw] of Object.entries(zs).slice(0, 8)) {
    if (!ID.test(id)) continue;
    const x = obj(raw);
    const spots = strs(x.spots, /^(SPOT|SEAT)_\d{1,2}$/, 12);
    const order = strs(x.order, ID, 48).filter((f) => list[f] && (list[f].zone === id || !list[f].zone));
    for (const f of order) if (!list[f].zone) list[f].zone = id;
    const def = typeof x.default === 'string' && list[x.default] ? x.default : order[order.length - 1];
    // (a zone without spots - the call-in screen's pylon - follows the host zone's occupant for its fit)
    if (!def) continue;
    if (!list[def].zone) list[def].zone = id;
    if (!order.includes(def)) order.push(def);
    zones[id] = { id, spots, order, default: def };
  }
  if (!Object.keys(zones).length) return null;
  for (const k of Object.keys(list)) if (!zones[list[k].zone]) delete list[k];
  const kit: KitPieceDef[] = [];
  for (const raw of (Array.isArray(f.kit) ? f.kit : []).slice(0, 64)) {
    const x = obj(raw);
    if (typeof x.piece !== 'string' || !/^[a-zA-Z]{2,24}$/.test(x.piece) || typeof x.name !== 'string' || !NODE.test(x.name)) continue;
    const params: KitPieceDef['params'] = {};
    for (const [k, v] of Object.entries(x)) {
      if (['piece', 'name', 'at', 'yaw'].includes(k) || !/^[A-Za-z][A-Za-z0-9]{0,23}$/.test(k)) continue;
      if (typeof v === 'number' && Number.isFinite(v)) params[k] = v;
      else if (typeof v === 'boolean') params[k] = v;
      else if (typeof v === 'string' && v.length <= 64) params[k] = v;
      else if (Array.isArray(v) && v.length <= 48 && v.every((n) => typeof n === 'number' && Number.isFinite(n))) params[k] = v as number[];
    }
    kit.push({ piece: x.piece, name: x.name, at: vec3(x.at) ?? [0, 0, 0], yaw: num(x.yaw, 0, -720, 720), params });
  }
  const lightGroups = [...new Set(Object.values(list).flatMap((d) => Object.keys(d.lightGroups)))];
  return { zones, list, kit, rules: sanitizeOccupantRules(root.occupants), lightGroups };
}

/** All three axes at or under this = a node that loads collapsed (Blender's 0.0001 floor + float32 noise; the same line
 *  as src/scene/roomClips.ts ZERO_SCALE). */
export const COLLAPSED_SCALE = 2e-4;
/** A form part a room GLB ships COLLAPSED (scale ~1e-4, so an engine without forms shows a clean default set) with its
 *  real scale in glTF extras `restScale` (three.js: userData): that scale, which the forms engine restores as the
 *  node's rest pose (its visibility is the form's). null = not collapsed, or no usable restScale (left as authored).
 *  Without it a perch podium / booster riser / wide desk / guest pad stays a point while its form is up: the spot that
 *  rides it puts the performer on nothing. */
export function restScaleOf(extras: unknown, scale: readonly number[]): Vec3 | null {
  if (scale.length < 3 || !scale.slice(0, 3).every((v) => Number.isFinite(v) && Math.abs(v) <= COLLAPSED_SCALE)) return null;
  const rs = obj(extras).restScale;
  if (!Array.isArray(rs) || rs.length !== 3 || !rs.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) >= 1e-3 && Math.abs(v) <= 1e3)) return null;
  return [rs[0], rs[1], rs[2]];
}

/** EMIT_ / LIGHT_ groups the forms engine drives (the room light engine leaves them alone: SceneRuntime). */
export function formsLightGroups(info: unknown): string[] { return parseForms(info)?.lightGroups ?? []; }

// ---------------------------------------------------------------- picking
function oneMatches(w: FormWhen, o: Occupant): boolean {
  if (w.cls && !w.cls.includes(o.cls)) return false;
  if (w.size && !w.size.includes(o.size)) return false;
  if (w.kind && !w.kind.includes(o.kind)) return false;
  if (w.minHeight !== undefined && o.height < w.minHeight) return false;
  if (w.maxHeight !== undefined && o.height > w.maxHeight) return false;
  return true;
}
/** Does a zone with these occupants want this form? */
export function whenMatches(w: FormWhen, occ: readonly Occupant[]): boolean {
  let ok: boolean;
  if (w.empty) ok = occ.length === 0;
  else if (!w.cls && !w.size && !w.kind && w.minHeight === undefined && w.maxHeight === undefined) ok = true;
  else ok = occ.some((o) => oneMatches(w, o));
  return ok || (!!w.or && whenMatches(w.or, occ));
}
/** The form a zone shows for its occupants: the host's lock (when it is one of the zone's forms), else the first form in
 *  the zone's order that matches, else the zone's default. */
export function pickForm(defs: FormsDef, zone: string, occ: readonly Occupant[], lock?: string | null): string {
  const z = defs.zones[zone];
  if (!z) return '';
  if (lock && defs.list[lock]?.zone === zone) return lock;
  for (const id of z.order) { const f = defs.list[id]; if (f && whenMatches(f.when, occ)) return id; }
  return z.default;
}

// ---------------------------------------------------------------- the state bag (SceneState.modes.forms)
export const FORMS_BAG = 'forms';
export interface FormZoneState {
  /** The zone's fit to its occupant (fitFor; SPEC 2.5) - optional. */
  fit?: FormFit;
  /** How the change plays (SPEC: 'iris' | 'crane' | 'lift' | 'instant' …) - optional, informational. */
  style?: string;
  /** The form the zone shows (or is changing to). */
  id: string;
  /** The form it changes from (== id: settled). */
  from: string;
  /** When the change starts: epoch ms on this page's clock (guests: shifted). */
  at: number;
}
export interface FormsBag {
  v: 1; room: string; zones: Record<string, FormZoneState>; lock?: Record<string, string>;
  /** The host's big-entrance style choice (Live panel; SPEC 2.9): 'auto' | 'iris' | 'walk' | 'crane' | 'drop' | 'lift' | 'powerup' | 'instant'. */
  entrance?: string;
}

export function sanitizeFormsBag(v: unknown): FormsBag | null {
  const x = obj(v);
  if (x.v !== 1 || typeof x.room !== 'string' || x.room.length > 80) return null;
  const zones: Record<string, FormZoneState> = {};
  for (const [z, raw] of Object.entries(obj(x.zones)).slice(0, 8)) {
    const s = obj(raw);
    if (!ID.test(z) || typeof s.id !== 'string' || !ID.test(s.id) || typeof s.at !== 'number' || !Number.isFinite(s.at)) continue;
    zones[z] = { id: s.id, from: typeof s.from === 'string' && ID.test(s.from) ? s.from : s.id, at: s.at };
    const fit = sanitizeFit(s.fit);
    if (fit) zones[z].fit = fit;
    if (typeof s.style === 'string' && /^[a-z]{2,12}$/.test(s.style)) zones[z].style = s.style;
  }
  const lock: Record<string, string> = {};
  for (const [z, f] of Object.entries(obj(x.lock)).slice(0, 8)) if (ID.test(z) && typeof f === 'string' && ID.test(f)) lock[z] = f;
  return { v: 1, room: x.room, zones, ...(Object.keys(lock).length ? { lock } : {}), ...(typeof x.entrance === 'string' && /^[a-z]{2,12}$/.test(x.entrance) ? { entrance: x.entrance } : {}) };
}
/** The forms bag of a scene state's mode bags (null = none / not for this room). */
export function formsBagOf(modes: unknown, room?: string | null): FormsBag | null {
  const b = sanitizeFormsBag(obj(modes)[FORMS_BAG]);
  return b && (room == null || b.room === room) ? b : null;
}
/** Host clock -> ours (guests, controller.onHostState): every zone stamp moves by `off` ms. */
export function shiftFormsClock(modes: unknown, off: number) {
  const b = obj(obj(modes)[FORMS_BAG]);
  for (const z of Object.values(obj(b.zones))) { const s = z as { at?: unknown }; if (typeof s.at === 'number' && Number.isFinite(s.at)) s.at += off; }
}

/** How long a form's in- / out-animation takes (s). */
export function animDur(f: FormDef | undefined, which: 'in' | 'out', next?: string): number {
  if (!f) return 0;
  if (which === 'in') return f.in.dur;
  const o = outAnim(f, next);
  return o ? o.dur : f.outDur;
}
/** The out-animation a form plays when changing to `next` (null = its in-animation backwards). */
export function outAnim(f: FormDef, next?: string): FormAnim | null {
  return (next ? f.outTo?.[next] : undefined) ?? f.outTo?.['*'] ?? f.out;
}

/** How much of a fit key's value is applied in this phase (0..1), eased like sampleZone's fit bindings: 1 while a form
 *  that lists `key` is settled, easing in with its in-animation, out with the previous form's out-animation. The
 *  interview engine lifts the call-in screen by fit.monY x this (SPEC 6.1 C7). */
export function fitWeight(defs: FormsDef, ph: FormPhase, key: FitKey): number {
  const has = (id: string) => !!defs.list[id]?.fit.includes(key);
  const cur = defs.list[ph.cur];
  if (!cur) return 0;
  if (ph.prev === ph.cur || ph.k === 'settled') return has(ph.cur) ? 1 : 0;
  if (ph.k === 'pre') return has(ph.prev) ? 1 : 0;
  if (has(ph.prev) && has(ph.cur)) return 1;
  let k = 0;
  if (has(ph.prev) && ph.t < ph.outEnd) k = Math.max(k, 1 - ease('inOutCubic', ph.t / Math.max(1e-3, ph.outEnd)));
  if (has(ph.cur) && ph.t >= ph.inStart) k = Math.max(k, ease('outCubic', (ph.t - ph.inStart) / Math.max(1e-3, cur.in.dur)));
  return clamp01(k);
}

/** SPEC 6.1 C7, a call-in screen the set brought (a skin / holo on its own pylon, `liftable`): how far (m, world up) it
 *  rises from where the set placed it - to `monY` over its floor, eased by `k` (fitWeight); `monY` null = as placed.
 *  Clamped to -1.5 .. 2.5 m. A screen ON a room node (callInOffset `housing`) never takes this path. */
export function callInLift(o: { liftable: boolean; floor: number; baseY: number; monY?: number | null; k?: number }): number {
  const cl = (v: number) => Math.min(2.5, Math.max(-1.5, v));
  if (!o.liftable || o.monY == null || !Number.isFinite(o.monY) || !Number.isFinite(o.floor) || !Number.isFinite(o.baseY)) return 0;
  return cl(o.floor + o.monY - o.baseY) * clamp01(o.k ?? 1);
}
/** Where the call-in screen moves from where the set placed it (m, world XYZ), written into `out` (no allocation: called
 *  every frame).
 *  - `housing` given: the picture sits ON a room node (scene.json `interview.monitor.node`, else a skin monitor's own
 *    template: the late-night room's CRT glass) - it follows that node's whole world move since the set was built,
 *    exactly (no clamp), and never monY. (Lifted to monY off a housing that stays put, the guest's picture left the CRT
 *    glass by 0.965 m - the floor probe from the glass meets the CRT's own cabinet - and ran into the CRT's frame.)
 *  - else: straight up by callInLift (the self-lift, clamped). */
export function callInOffset(o: { housing?: readonly number[] | null; liftable: boolean; floor: number; baseY: number; monY?: number | null; k?: number }, out: Vec3 = [0, 0, 0]): Vec3 {
  const h = o.housing;
  if (h && h.length >= 3 && Number.isFinite(h[0]) && Number.isFinite(h[1]) && Number.isFinite(h[2])) { out[0] = h[0]; out[1] = h[1]; out[2] = h[2]; return out; }
  out[0] = 0; out[1] = callInLift(o); out[2] = 0;
  return out;
}

export interface FormPhase {
  zone: string;
  /** Shown / changing to. */
  cur: string;
  /** Changing from (== cur: settled). */
  prev: string;
  /** Seconds since the stamp (< 0: not started). */
  t: number;
  /** Seconds after the stamp: prev's out ends / cur's in starts / cur's in ends (settled). */
  outEnd: number; inStart: number; inEnd: number;
  k: 'pre' | 'out' | 'in' | 'settled';
  /** Epoch ms when the zone is settled in `cur` (the big entrance waits for it). */
  readyAt: number;
}
export function formPhase(defs: FormsDef, zone: string, st: FormZoneState | undefined, now: number): FormPhase {
  const z = defs.zones[zone];
  const ok = (id: string | undefined) => !!id && defs.list[id]?.zone === zone;
  const cur = ok(st?.id) ? st!.id : z?.default ?? '';
  const prev = ok(st?.from) ? st!.from : cur;
  const at = st && Number.isFinite(st.at) ? st.at : 0;
  const t = (now - at) / 1000;
  if (prev === cur) return { zone, cur, prev, t, outEnd: 0, inStart: 0, inEnd: 0, k: t < 0 ? 'pre' : 'settled', readyAt: at };
  const outEnd = animDur(defs.list[prev], 'out', cur);
  const inStart = Math.max(0, outEnd - (defs.list[cur]?.overlap ?? 0));
  const inEnd = inStart + animDur(defs.list[cur], 'in');
  const k = t < 0 ? 'pre' : t < inStart ? 'out' : t < inEnd ? 'in' : 'settled';
  return { zone, cur, prev, t, outEnd, inStart, inEnd, k, readyAt: at + inEnd * 1000 };
}

// ---------------------------------------------------------------- sampling (node offsets + visibility)
/** A summed offset: pos (m), rot (deg), scale (multiplier). */
export interface Delta { p: Vec3; r: Vec3; s: Vec3 }
export const zeroDelta = (): Delta => ({ p: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] });
/** What fit-driven offsets need: the zone's fit (bag), a node's unit direction out from its parent's centre and its rest
 *  distance from it (radial: clamps travelling out to the occupant's feet). */
export interface FitCtx { fit?: FormFit; radial?: (node: string) => { dir: Vec3; r: number } | null }
function fitNum(v: FitNum, c: FitCtx | undefined, i: number, dflt: number): number {
  if (typeof v === 'number') return v;
  const m = /^fit\.([A-Za-z]+)$/.exec(v);
  const x = m && c?.fit && isFitKey(m[1]) ? c.fit[m[1]] : undefined;
  const n = Array.isArray(x) ? x[Math.min(i, x.length - 1)] : x;
  return typeof n === 'number' && Number.isFinite(n) ? n : dflt;
}
function fromDelta(d: FormDelta | undefined, c?: FitCtx, node = '', i = 0): Delta {
  const v = (a: FitVec3 | undefined, dflt: number): Vec3 => (a ? [fitNum(a[0], c, i, dflt), fitNum(a[1], c, i, dflt), fitNum(a[2], c, i, dflt)] : [dflt, dflt, dflt]);
  const out: Delta = { p: v(d?.pos, 0), r: v(d?.rot, 0), s: v(d?.scale, 1) };
  if (d?.radial && c?.radial) {
    const rr = fitNum(d.radial, c, i, -1), dir = c.radial(node);
    if (rr > 0 && dir) { const k = rr - dir.r; out.p[0] += dir.dir[0] * k; out.p[1] += dir.dir[1] * k; out.p[2] += dir.dir[2] * k; }
  }
  return out;
}
function lerpD(a: Delta, b: Delta, k: number): Delta {
  const l = (x: number, y: number) => x + (y - x) * k;
  return { p: [l(a.p[0], b.p[0]), l(a.p[1], b.p[1]), l(a.p[2], b.p[2])], r: [l(a.r[0], b.r[0]), l(a.r[1], b.r[1]), l(a.r[2], b.r[2])], s: [l(a.s[0], b.s[0]), l(a.s[1], b.s[1]), l(a.s[2], b.s[2])] };
}
function addD(into: Delta, d: Delta) {
  for (let i = 0; i < 3; i++) { into.p[i] += d.p[i]; into.r[i] += d.r[i]; into.s[i] *= d.s[i]; }
}

/** One tween's offset at `tl` s into its animation (stagger slot `i`). `start` replaces a missing `from` (out-animations
 *  start from where the in-animation left the node); `auto` = the measured rise for `auto: 'rise'`; `c` resolves
 *  "fit.*" values and radial offsets for `node`. */
export function tweenDelta(tw: FormTween, tl: number, i = 0, start?: Delta, auto?: Delta, c?: FitCtx, node = tw.node): Delta {
  const off = (tw.stagger ?? 0) * i;
  const t0 = tw.t[0] + off, t1 = tw.t[1] + off;
  const k = t1 > t0 ? ease(tw.ease, (tl - t0) / (t1 - t0)) : tl >= t1 ? 1 : 0;
  const a = tw.from ? fromDelta(tw.from, c, node, i) : tw.auto === 'rise' && auto ? auto : start ?? zeroDelta();
  const b = fromDelta(tw.to, c, node, i);
  return lerpD(a, b, k);
}

/** Where a form's in-animation leaves a node: its position offset from the rest pose (the node's parent space), the
 *  sum of the end states of the tweens that name it (`fit.*` values resolve with `c`, else 0). A spot that rides that
 *  node (FormSpot.ride / carrier) is carried this far once the form is settled. */
export function settledOffset(f: FormDef, node: string, c?: FitCtx): Vec3 {
  const p: Vec3 = [0, 0, 0];
  for (const tw of f.in.tweens) {
    if (tw.each || tw.auto || tw.node !== node) continue;
    const d = tweenDelta(tw, Infinity, 0, undefined, undefined, c, node);
    p[0] += d.p[0]; p[1] += d.p[1]; p[2] += d.p[2];
  }
  return p;
}

export interface ZoneSample {
  /** Node name -> summed offset (only nodes some tween touches right now). */
  deltas: Map<string, Delta>;
  /** Forms whose nodes are shown right now (prev and / or cur). */
  shown: string[];
  /** The form the zone counts as (its spots, seat surfaces, lights, cams): cur from its in-start on, else prev. */
  active: string;
  /** Nodes moving right now (left out of the ray tests until they stop). */
  moving: Set<string>;
  settled: boolean;
}

/** Everything a page draws for one zone at one moment: a pure function of the phase. `expand` resolves an `each`
 *  prefix to node names (sorted); `rise(node)` = the measured `auto: 'rise'` offset. Nodes shared by the two forms of a
 *  change stay put (their automatic rise / sink is skipped: a desk both forms use never dips). */
export function sampleZone(defs: FormsDef, ph: FormPhase, expand: (prefix: string) => string[] = (p) => [p], rise: (node: string) => Delta = () => ({ p: [0, -1, 0], r: [0, 0, 0], s: [1, 1, 1] }), c?: FitCtx): ZoneSample {
  const deltas = new Map<string, Delta>();
  const moving = new Set<string>();
  const put = (n: string, d: Delta) => { const c = deltas.get(n); if (c) addD(c, d); else deltas.set(n, d); };
  const nodesOf = (tw: FormTween) => (tw.each ? expand(tw.node) : [tw.node]);
  const cur = defs.list[ph.cur], prev = defs.list[ph.prev];
  const shared = new Set(prev && cur && ph.prev !== ph.cur ? prev.nodes.filter((n) => cur.nodes.includes(n)) : []);
  const skip = (tw: FormTween, n: string) => tw.auto === 'rise' && shared.has(n);
  const riseOf = (tw: FormTween, n: string) => (tw.auto === 'rise' ? rise(n) : undefined);
  /** a form's in-animation at `tl` (Infinity = its end state) */
  const playIn = (f: FormDef, tl: number, mark = true) => {
    for (const tw of f.in.tweens) nodesOf(tw).forEach((n, i) => {
      if (skip(tw, n)) return;
      put(n, tweenDelta(tw, tl, i, undefined, riseOf(tw, n), c, n));
      const off = (tw.stagger ?? 0) * i;
      if (mark && Number.isFinite(tl) && tl > tw.t[0] + off - 0.05 && tl < tw.t[1] + off + 0.05) moving.add(n);
    });
  };
  const endOf = (f: FormDef, n: string): Delta => {
    const d = zeroDelta();
    for (const x of f.in.tweens) { const i = nodesOf(x).indexOf(n); if (i >= 0 && !skip(x, n)) addD(d, tweenDelta(x, Infinity, i, undefined, riseOf(x, n), c, n)); }
    return d;
  };
  const playOut = (f: FormDef, tl: number) => {
    const od = animDur(f, 'out', ph.cur);
    const oa = outAnim(f, ph.cur);
    if (!oa) {
      // the in-animation backwards, squeezed into the out duration
      const back = Math.max(0, f.in.dur * (1 - tl / Math.max(1e-3, od)));
      playIn(f, back, false);
      for (const tw of f.in.tweens) nodesOf(tw).forEach((n, i) => {
        const off = (tw.stagger ?? 0) * i;
        if (!skip(tw, n) && back > tw.t[0] + off - 0.05 && back < tw.t[1] + off + 0.05) moving.add(n);
      });
      return;
    }
    const outNodes = new Set<string>();
    for (const tw of oa.tweens) nodesOf(tw).forEach((n, i) => {
      outNodes.add(n);
      put(n, tweenDelta(tw, tl, i, endOf(f, n), undefined, c, n));
      const off = (tw.stagger ?? 0) * i;
      if (tl > tw.t[0] + off - 0.05 && tl < tw.t[1] + off + 0.05) moving.add(n);
    });
    // nodes the out-animation doesn't mention hold where the in-animation left them
    for (const tw of f.in.tweens) for (const n of nodesOf(tw)) if (!outNodes.has(n) && !deltas.has(n)) put(n, endOf(f, n));
  };
  /** a form's fit bindings (deskY / railY ... from the bag's fit), weighted k (eased in / out with the form) */
  const binds = (f: FormDef | undefined, k: number) => {
    if (!f || !c?.fit || k <= 0) return;
    for (const b of f.fitBind) {
      const v = c.fit[b.key];
      if (typeof v !== 'number') continue;
      const d = zeroDelta();
      d.p[b.axis] = Math.min(b.max, Math.max(b.min, v - b.rest)) * k;
      put(b.node, d);
    }
  };
  if (!cur) return { deltas, shown: [], active: ph.cur, moving, settled: true };
  if (ph.prev === ph.cur || ph.k === 'settled') { playIn(cur, Infinity); binds(cur, 1); return { deltas, shown: [ph.cur], active: ph.cur, moving, settled: true }; }
  if (ph.k === 'pre') { if (prev) { playIn(prev, Infinity); binds(prev, 1); } return { deltas, shown: prev ? [ph.prev] : [], active: ph.prev, moving, settled: true }; }
  const shown: string[] = [];
  if (prev && ph.t < ph.outEnd) { playOut(prev, ph.t); shown.push(ph.prev); binds(prev, 1 - ease('inOutCubic', ph.t / Math.max(1e-3, ph.outEnd))); }
  if (ph.t >= ph.inStart) { playIn(cur, ph.t - ph.inStart); shown.push(ph.cur); binds(cur, ease('outCubic', (ph.t - ph.inStart) / Math.max(1e-3, cur.in.dur))); }
  // not started yet: cur's nodes wait (hidden) at their in-animation's first pose
  else playIn(cur, 0, false);
  return { deltas, shown, active: ph.t >= ph.inStart ? ph.cur : ph.prev, moving, settled: false };
}

/** The cues of a change, in seconds after the stamp (prev's out cues, then cur's in cues). */
export function zoneCues(defs: FormsDef, ph: FormPhase): { at: number; cue: FormCue; form: string; which: 'in' | 'out' }[] {
  if (ph.prev === ph.cur) return [];
  const out: { at: number; cue: FormCue; form: string; which: 'in' | 'out' }[] = [];
  const prev = defs.list[ph.prev], cur = defs.list[ph.cur];
  const oa = prev ? outAnim(prev, ph.cur) : null;
  if (oa) for (const c of oa.cues) out.push({ at: c.at, cue: c, form: ph.prev, which: 'out' });
  if (cur) for (const c of cur.in.cues) out.push({ at: ph.inStart + c.at, cue: c, form: ph.cur, which: 'in' });
  return out.sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------- the host's stamps
export interface StampMember {
  key: string;
  /** SceneState.spots index (-1 = none). */
  spot: number;
  present: boolean;
  occ: Occupant;
}
export interface StampCtx {
  defs: FormsDef;
  sceneId: string;
  now: number;
  /** A different room than the previous state: every zone just IS its form (no transform). */
  roomChanged: boolean;
  members: readonly StampMember[];
  /** SPOT_01 -> 0 ... (the room's spot names; SEAT_xx too). */
  spotIndex: (name: string) => number;
  moves?: Record<string, { from: number; to: number; at: number }>;
  /** Seconds a leaving occupant's exit keeps the zone's form up (a big exit walks out first). */
  holdFor?: (occ: Occupant) => number;
}
/** The occupants of a zone: present members whose spot is one of the zone's spots. */
export function zoneOccupants(defs: FormsDef, zone: string, members: readonly StampMember[], spotIndex: (n: string) => number): StampMember[] {
  const z = defs.zones[zone];
  if (!z) return [];
  const idx = new Set(z.spots.map(spotIndex).filter((i) => i >= 0));
  return members.filter((m) => m.present && m.spot >= 0 && idx.has(m.spot));
}
/** Instant stamps (room loads): far enough in the past that every page is settled. */
export const INSTANT_AGO = 600_000;
/** The host's new forms bag for a committed state (unchanged zones keep their stamp; a change starts with the walk-in
 *  that caused it, after the walk-out of whoever left, else 0.3 s from now). */
export function stampFormsBag(prev: FormsBag | null, c: StampCtx): FormsBag {
  const same = !!prev && prev.room === c.sceneId && !c.roomChanged;
  const zones: Record<string, FormZoneState> = {};
  const lock = same && prev!.lock ? { ...prev!.lock } : undefined;
  for (const z of Object.values(c.defs.zones)) {
    const occ = zoneOccupants(c.defs, z.id, c.members, c.spotIndex);
    const target = pickForm(c.defs, z.id, occ.map((m) => m.occ), lock?.[z.id]);
    const old = same ? prev!.zones[z.id] : undefined;
    // the zone's fit to its biggest occupant (SPEC 2.5): rides along with the stamp (a spotless zone: the host zone's)
    const fitOcc = z.spots.length ? occ : zoneOccupants(c.defs, c.defs.zones.host ? 'host' : Object.keys(c.defs.zones)[0], c.members, c.spotIndex);
    const big = biggestOccupant(fitOcc.map((m) => m.occ));
    const fit = big ? fitFor({ shown: big.shown, kind: big.kind, cls: big.cls, pilotEye: big.pilotEye, contactR: big.contactR }) : {};
    const withFit = (st: FormZoneState): FormZoneState => { const { fit: _f, ...rest } = st; void _f; return Object.keys(fit).length ? { ...rest, fit } : rest; };
    if (!old || !c.defs.list[old.id]) { zones[z.id] = withFit({ id: target, from: target, at: c.now - INSTANT_AGO }); continue; }
    if (old.id === target) { zones[z.id] = JSON.stringify(old.fit ?? {}) === JSON.stringify(fit) ? old : withFit(old); continue; }
    const idx = new Set(z.spots.map(c.spotIndex).filter((i) => i >= 0));
    const recent = (at: number) => at >= c.now - 2500;
    let at = c.now + 300;
    // someone walking in to the zone: the change starts with their walk (the big entrance waits for it)
    const arrivals = occ.map((m) => c.moves?.[m.key]).filter((mv): mv is NonNullable<typeof mv> => !!mv && idx.has(mv.to) && !idx.has(mv.from) && recent(mv.at));
    if (arrivals.length) at = Math.min(...arrivals.map((m) => m.at));
    else {
      // someone left: the set changes once they are out of the way
      const leavers = c.members.filter((m) => { const mv = c.moves?.[m.key]; return !!mv && idx.has(mv.from) && !idx.has(mv.to) && recent(mv.at); });
      if (leavers.length) at = Math.max(at, ...leavers.map((m) => c.moves![m.key].at + (c.holdFor?.(m.occ) ?? 1.2) * 1000));
    }
    zones[z.id] = withFit({ id: target, from: old.id, at: Math.round(at) });
  }
  // (the host's big-entrance style choice rides along: a re-stamp never resets it)
  const entrance = same ? prev!.entrance : undefined;
  return { v: 1, room: c.sceneId, zones, ...(lock && Object.keys(lock).length ? { lock } : {}), ...(entrance ? { entrance } : {}) };
}

// ---------------------------------------------------------------- a generated desk for any room (interview engine)
/** A generated talk-show desk shaped for whoever sits at it (rooms without authored forms): the interview engine's
 *  buildDesk numbers made parametric. heights in room metres. */
export interface DeskSpec {
  /** Desk top above the floor. */
  height: number;
  depth: number;
  /** x the planned width. */
  widthK: number;
  /** A projected holo plate instead of a desk (mech pilots). */
  holo: boolean;
  /** Extra room between the performer and the desk's back edge (m): the desk moves away from them by this much, on top
   *  of keeping its back edge where the standard 0.64 m desk has it (a deeper desk grows towards the audience). */
  back: number;
  /** Where the height came from: the performer's measured seated elbow, or the class table (no skeleton to measure). */
  from: 'elbow' | 'table';
}
/** The standard generated desk (talkshow/props.ts buildDesk): top 0.76 m, 0.64 m deep. */
export const DESK_STD = { height: 0.76, depth: 0.64 } as const;
/** Desk-top limits per class when it follows the performer's elbow (m above the desk's floor). */
// (large: from 0.60 - a hunched, long-armed ogre's hanging elbow is lower than a human's: stone_brute at 2.4 m sits with
//  it at 0.65 m in a 1.5 m room)
const DESK_RANGE: Partial<Record<OccupantClass, [number, number]>> = { small: [0.46, 0.76], large: [0.6, 1.0] };
/** A seated performer's elbow height with the upper arm hanging (the ergonomic desk-top reference), m above the floor of
 *  the seat: hips a thigh-radius (0.055 x standing height, as SceneActor.seatBase sits them) above the seat surface, the
 *  shoulder joint above the hips as in the rest pose, minus the upper arm. Inputs are rest-pose numbers (model units)
 *  and the model's scale `k` (shown / rest). null = no arm / hips joints to measure. */
export function seatedElbow(b: { seat: number; height: number; hipsY: number | null; shoulderY: number | null; upperArm: number | null }, k: number): number | null {
  if (b.hipsY === null || b.shoulderY === null || b.upperArm === null || !(b.upperArm > 0) || !(k > 0)) return null;
  const v = b.seat + b.height * k * 0.055 + (b.shoulderY - b.hipsY) * k - b.upperArm * k;
  return Number.isFinite(v) ? v : null;
}
/** The desk for a host of this class. `elbow` = their measured seated elbow height above the desk's floor (seatedElbow):
 *  a small or large host gets the top 1 cm under it (SPEC L2: elbow - top within -0.04 ... +0.06 m), clamped per class;
 *  without it, the class table (SPEC 2.5). An ordinary human keeps the standard desk exactly (as before this existed);
 *  a micro stands on the standard desk top (sizeSeat.ts); a giant gets a standing console, a mech / vehicle a holo plate. */
export function deskSpec(cls: OccupantClass, shown: number, elbow?: number | null): DeskSpec {
  const base: DeskSpec = { height: DESK_STD.height, depth: DESK_STD.depth, widthK: 1, holo: false, back: 0, from: 'table' };
  const fitted = (lo: number, hi: number, dflt: number): Pick<DeskSpec, 'height' | 'from'> =>
    typeof elbow === 'number' && Number.isFinite(elbow) ? { height: Math.min(hi, Math.max(lo, elbow - 0.01)), from: 'elbow' } : { height: dflt, from: 'table' };
  switch (cls) {
    case 'small': return { ...base, ...fitted(...DESK_RANGE.small!, 0.62) };
    // (an ogre's bulk: 6 cm more room behind the desk; the deeper top grows towards the audience)
    case 'large': return { ...base, ...fitted(...DESK_RANGE.large!, 0.86), depth: 0.8, widthK: 1.25, back: 0.06 };
    case 'giant': return { ...base, height: Math.min(1.6, Math.max(0.9, 0.42 * shown)), depth: 1.0, widthK: 1.6 };
    case 'mech': case 'vehicle': return { ...base, height: 0, depth: 0, holo: true };
    default: return base;
  }
}
/** How far a desk of this spec sits further from the performer than the standard desk (m, along the desk's facing). */
export const deskShift = (d: Pick<DeskSpec, 'depth' | 'back'>) => Math.max(0, (d.depth - DESK_STD.depth) / 2) + d.back;
/** A grown desk (deskSpec: wider, deeper towards the audience) kept clear of the people around it. `planned` = the desk
 *  the set layout placed (half width, depth: never made smaller); `grown` = deskSpec's (half width, depth, shift = its
 *  centre's offset towards the audience). `others` = body discs of the other seats (a guest chair beside the desk, its
 *  knees) in the PLANNED desk's frame: x along the desk, z towards the audience, r = radius (m). A disc the planned desk
 *  already touches is the layout's business (co-hosts behind the desk: their knees). One beside the planned desk narrows
 *  the grown one; one in front pulls its front edge back (its back edge stays where deskSpec put it). */
export function clampDeskSpan(planned: { halfW: number; depth: number }, grown: { halfW: number; depth: number; shift: number }, others: { x: number; z: number; r: number }[]): { halfW: number; depth: number; shift: number; clamped: boolean } {
  let halfW = Math.max(planned.halfW, grown.halfW);
  const back = grown.shift - grown.depth / 2;
  let front = Math.max(planned.depth / 2, grown.shift + grown.depth / 2);
  let clamped = false;
  // (nearest first: the guest chair right beside the desk decides before one further along)
  const list = others.filter((q) => Number.isFinite(q.x) && Number.isFinite(q.z) && q.r >= 0).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
  for (const q of list) {
    const ax = Math.abs(q.x);
    if (ax < planned.halfW + q.r && q.z > -planned.depth / 2 - q.r && q.z < planned.depth / 2 + q.r) continue;
    if (!(ax < halfW + q.r && q.z > back - q.r && q.z < front + q.r)) continue;
    clamped = true;
    if (ax - q.r >= planned.halfW) halfW = ax - q.r;
    else front = Math.max(planned.depth / 2, q.z - q.r);
  }
  return { halfW, depth: front - back, shift: (front + back) / 2, clamped };
}

// ---------------------------------------------------------------- the big entrance (src/scene/forms/bigEntrance.ts)
/** walk = the big door (hangar / iris) and a lane; lift = up through the floor at the spot (avatar swaps); drop = down
 *  from above on thrusters (crane: on the gantry hook, no thrusters); powerup = at the spot, folded -> standing (rooms
 *  without a big door); instant = just there. scene.json / the bag also take the SPEC's names: iris = walk, crane = drop. */
export type BigStyle = 'walk' | 'lift' | 'drop' | 'powerup' | 'instant';
export interface BigCamDef extends CamDef { use?: [number, number] }
/** SPEC 3.7 camera windows: a CAM_* node (authored GLB camera / scene.json cams) or a rail (glTF points, aimed at the
 *  walker), between two time marks: a number (s), "alert+0.6", "walk@0.35" (fraction of the walk), "dock", "dock+3.8". */
export interface BigCamWindow { cam: string | null; rail: [Vec3, Vec3] | null; fov: number; from: string; to: string }
export interface BigEntranceDef {
  /** true = the room's scene.json has `bigEntrance`; false = the power-up default every room gets for mechs. */
  explicit: boolean;
  /** Who uses it: occupant classes, size classes (SPEC `classes: ["macro"]`), kinds (with `big`), wider than the door. */
  classes: OccupantClass[];
  sizes: SizeClass[];
  kinds: OccupantKind[];
  doorWidth: number | null;
  style: BigStyle | 'auto';
  /** The drop is a crane drop (gantry hook, no thrusters). */
  crane: boolean;
  exit: BigStyle | 'auto';
  door: { kind: 'hangar' | 'iris' | 'none'; node: string; leaves: string; slide: number; turn: number; open: number; close: number } | null;
  /** Iris opening window + earliest walk start + close time (SPEC `phases`), s from the stamp. */
  phases: { irisOpen: [number, number] | null; walkFrom: number | null; irisClose: number | null };
  /** Where a walker starts / ends outside (node name or glTF point). */
  outside: string | Vec3 | null;
  /** The walk in (node prefix like BIG_PATH_ or glTF points), door side first; `paths[zone]` per destination zone. */
  path: string | Vec3[] | null;
  paths: Record<string, string>;
  lift: { node: string | null; hatch: string | null; dur: number; open: number; hide: [number, number] | null };
  drop: { height: number; dur: number; hook: string | null };
  powerup: { dur: number };
  /** x the walker's own speed. */
  speed: number;
  /** Authored cinematic cameras (glTF space) with their time windows (s from the entrance stamp). */
  cams: Record<string, BigCamDef>;
  camList: BigCamWindow[];
  /** The stage modes in which the entrance owns the camera (null = all but react / gaming). */
  camModes: string[] | null;
  /** Steam / sparks / thrusters. */
  fx: boolean;
  /** The runway light group that chases towards the room while someone walks in. */
  runway: string | null;
}
export const BIG_DEFAULT_CLASSES: readonly OccupantClass[] = ['large', 'giant', 'mech', 'vehicle'];
/** A style name from scene.json / the host's bag -> the engine's style (+ crane). */
export function bigStyleOf(v: unknown): { style: BigStyle | 'auto'; crane: boolean } | null {
  switch (v) {
    case 'walk': case 'iris': case 'hangar': return { style: 'walk', crane: false };
    case 'drop': return { style: 'drop', crane: false };
    case 'crane': return { style: 'drop', crane: true };
    case 'lift': return { style: 'lift', crane: false };
    case 'powerup': return { style: 'powerup', crane: false };
    case 'instant': return { style: 'instant', crane: false };
    case 'auto': return { style: 'auto', crane: false };
    default: return null;
  }
}
const pair = (v: unknown): [number, number] | null => (Array.isArray(v) && v.length === 2 && v.every((k) => typeof k === 'number' && Number.isFinite(k)) ? [v[0] as number, v[1] as number] : null);
const TIME_MARK = /^(\d+(\.\d+)?|(alert|dock|arrive)([+-]\d+(\.\d+)?)?|walk@(0|1|0?\.\d+))$/;
/** The default every room gets (no `bigEntrance`): mechs / vehicles power up at their spot. */
export const POWERUP_DEFAULT: BigEntranceDef = {
  explicit: false, classes: ['mech', 'vehicle'], sizes: [], kinds: [], doorWidth: null, style: 'powerup', crane: false, exit: 'powerup',
  door: null, phases: { irisOpen: null, walkFrom: null, irisClose: null }, outside: null, path: null, paths: {},
  lift: { node: null, hatch: null, dur: 5, open: 1.2, hide: null }, drop: { height: 12, dur: 4, hook: null }, powerup: { dur: 4 },
  speed: 1, cams: {}, camList: [], camModes: null, fx: true, runway: null,
};
export function parseBigEntrance(info: unknown): BigEntranceDef | null {
  const root = obj(info);
  if (!root.bigEntrance || typeof root.bigEntrance !== 'object') return null;
  const x = obj(root.bigEntrance);
  if (x.on === false) return null;
  const rawCls = Array.isArray(x.classes) ? x.classes : [];
  const classes = [...new Set(rawCls.filter(isOccupantClass))];
  const sizes = [...new Set(rawCls.filter((c): c is SizeClass => c === 'normal' || c === 'macro'))];
  const kinds = Array.isArray(x.kinds) ? [...new Set(x.kinds.filter(isOccupantKind))] : [];
  // the door: `door { kind, node, leaves, slide, turn, open, close }`, or the SPEC's `iris { node, blades, bladeTurn, outside }`
  const d = obj(x.door), ir = obj(x.iris), ph = obj(x.phases);
  let door: BigEntranceDef['door'] = null;
  if (typeof d.node === 'string' && NODE.test(d.node)) {
    const kind = d.kind === 'iris' || d.kind === 'hangar' || d.kind === 'none' ? d.kind : 'hangar';
    door = { kind, node: d.node, leaves: typeof d.leaves === 'string' && NODE.test(d.leaves) ? d.leaves : kind === 'iris' ? `${d.node}_BLADE_` : `${d.node}_`, slide: num(d.slide, 3.2, 0, 30), turn: num(d.turn, 62, -360, 360), open: num(d.open, 2.2, 0.2, 20), close: num(d.close, 2.0, 0.2, 20) };
  } else if (typeof ir.node === 'string' && NODE.test(ir.node)) {
    const op = pair(ph.irisOpen);
    door = { kind: 'iris', node: ir.node, leaves: typeof ir.blades === 'string' && NODE.test(ir.blades) ? ir.blades : `${ir.node}_BLADE_`, slide: 0, turn: num(ir.bladeTurn, 62, -360, 360), open: op ? Math.max(0.2, op[1] - op[0]) : 2.6, close: num(ph.irisClose, 2.5, 0.2, 20) };
  }
  const outRaw = x.outside ?? ir.outside;
  const outside = typeof outRaw === 'string' && NODE.test(outRaw) ? outRaw : vec3(outRaw) ?? null;
  const path = typeof x.path === 'string' && NODE.test(x.path) ? x.path : Array.isArray(x.path) ? x.path.map(vec3).filter((p): p is Vec3 => !!p).slice(0, 24) : null;
  const paths: Record<string, string> = {};
  for (const [z, v] of Object.entries(obj(x.paths)).slice(0, 8)) if (ID.test(z) && typeof v === 'string' && NODE.test(v)) paths[z] = v;
  const l = obj(x.lift), dr = obj(x.drop), sty = obj(x.styles), sl = obj(sty.lift), sc = obj(sty.crane), sp = obj(sty.powerup);
  const cams: Record<string, BigCamDef> = {};
  const camList: BigCamWindow[] = [];
  if (Array.isArray(x.cams)) for (const v of x.cams.slice(0, 12)) {
    const c = obj(v);
    const from = typeof c.from === 'string' || typeof c.from === 'number' ? String(c.from) : '', to = typeof c.to === 'string' || typeof c.to === 'number' ? String(c.to) : '';
    if (!TIME_MARK.test(from) || !TIME_MARK.test(to)) continue;
    const rail = Array.isArray(c.rail) && c.rail.length === 2 ? [vec3(c.rail[0]), vec3(c.rail[1])] : null;
    camList.push({ cam: typeof c.cam === 'string' && /^CAM_[A-Za-z0-9_]{1,40}$/.test(c.cam) ? c.cam : null, rail: rail && rail[0] && rail[1] ? [rail[0], rail[1]] : null, fov: num(c.fov, 36, 8, 100), from, to });
  } else for (const [n, v] of Object.entries(obj(x.cams)).slice(0, 8)) {
    const c = cleanCam(v);
    if (!c || !/^CAM_[A-Za-z0-9_]{1,40}$/.test(n)) continue;
    const u = pair(obj(v).use);
    cams[n] = { ...c, ...(u ? { use: u } : {}) };
  }
  const st = bigStyleOf(x.style) ?? { style: 'auto' as const, crane: false };
  const ex = x.exit === 'reverse' || x.exit === undefined ? { style: 'auto' as const } : bigStyleOf(x.exit) ?? { style: 'auto' as const };
  const modes = obj(x.modes).camera;
  const liftNode = l.node ?? sl.node;
  return {
    explicit: true,
    classes: classes.length || sizes.length || kinds.length ? classes : [...BIG_DEFAULT_CLASSES], sizes, kinds,
    doorWidth: typeof x.doorWidth === 'number' && Number.isFinite(x.doorWidth) && x.doorWidth > 0.3 ? x.doorWidth : null,
    style: st.style, crane: st.crane, exit: ex.style,
    door, phases: { irisOpen: pair(ph.irisOpen), walkFrom: typeof ph.walkFrom === 'number' && Number.isFinite(ph.walkFrom) ? ph.walkFrom : null, irisClose: typeof ph.irisClose === 'number' && Number.isFinite(ph.irisClose) ? ph.irisClose : null },
    outside, path: Array.isArray(path) && !path.length ? null : path, paths,
    lift: { node: typeof liftNode === 'string' && NODE.test(liftNode) ? liftNode : null, hatch: typeof l.hatch === 'string' && NODE.test(l.hatch) ? l.hatch : null,
      dur: num(l.dur ?? sl.dur, 5, 1, 30), open: num(l.open, 1.2, 0.1, 10), hide: pair(sl.hide) },
    drop: { height: num(dr.height ?? sc.from, 14, 2, 120), dur: num(dr.dur ?? sc.dur, 4.2, 1, 30), hook: typeof sc.hook === 'string' && NODE.test(sc.hook) ? sc.hook : null },
    powerup: { dur: num(sp.dur, 4, 1, 20) },
    speed: num(x.speed, 1, 0.2, 4), cams, camList,
    camModes: Array.isArray(modes) ? modes.filter((m): m is string => typeof m === 'string' && /^[a-z][a-z0-9-]{1,23}$/.test(m)).slice(0, 16) : null,
    fx: x.fx !== false,
    runway: typeof x.runway === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(x.runway) ? x.runway : null,
  };
}
/** Does this occupant come in by the big entrance? Its occupant class is listed, or its size class (SPEC `classes:
 *  ["macro"]`), or it is `big` and of a listed kind, or its footprint is wider than the room's people door. */
export function usesBigEntrance(def: BigEntranceDef | null, occ: Pick<Occupant, 'cls'> & Partial<Pick<Occupant, 'size' | 'kind' | 'big' | 'footprint'>>): boolean {
  if (!def) return false;
  if (def.classes.includes(occ.cls)) return true;
  if (occ.size && def.sizes.includes(occ.size)) return true;
  if (occ.kind && occ.big && def.kinds.includes(occ.kind)) return true;
  return !!def.doorWidth && (occ.footprint ?? 0) > def.doorWidth;
}

/** Defaults used when a room has forms but nothing for this: the biggest occupant of a list (re-exported for engines). */
export { biggestOccupant, DEFAULT_OCCUPANT_RULES };

/** SPEC 6.1 C1 rule (1) for shared/occupant.ts spotFitOcc: spot index -> does the forms zone there have a form made for
 *  this occupant? = a form of the zone whose `when` names who it is for (kind / class / size / height - a catch-all
 *  `when: {}` names nobody) and matches them (the walker at the host desk: the dock; a giant guest at the couch: the
 *  guest pad). null = a room without forms. */
export function zoneConverts(defs: FormsDef | null): ZoneConverts | null {
  if (!defs) return null;
  const named = (w: FormWhen): boolean => !!(w.cls || w.size || w.kind || w.minHeight !== undefined || w.maxHeight !== undefined) || (!!w.or && named(w.or));
  const byIndex = new Map<number, FormDef[]>();
  for (const z of Object.values(defs.zones)) {
    const forms = z.order.map((id) => defs.list[id]).filter((f): f is FormDef => !!f && !f.when.empty && named(f.when));
    if (!forms.length) continue;
    for (const n of z.spots) { const i = spotIndexOfName(n); if (i >= 0) byIndex.set(i, forms); }
  }
  if (!byIndex.size) return null;
  return (index, occ) => (byIndex.get(index) ?? []).some((f) => whenMatches(f.when, [occ]));
}

/** SPOT_01 / SEAT_01 -> 0 (the room contract's spot index; GM_SEAT and size spots are never zone spots). */
export function spotIndexOfName(name: string): number {
  const m = /^(?:SPOT|SEAT)_(\d{1,2})$/.exec(name);
  return m ? +m[1] - 1 : -1;
}
/** Seconds a big performer's exit keeps their zone's form up (the host stamps the change back after it). */
export function bigExitHold(def: BigEntranceDef): number {
  const st = def.exit === 'auto' ? def.style : def.exit;
  if (st === 'lift') return def.lift.open + def.lift.dur + 0.8;
  if (st === 'drop') return def.drop.dur + 1.2;
  if (st === 'powerup') return def.powerup.dur + 0.5;
  if (st === 'instant') return 0.3;
  // a walk out through the big door: turn, walk the lane, the door closes
  return 9 + (def.door ? def.door.open : 0);
}
