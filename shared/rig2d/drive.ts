// Rigged 2D avatars (Live2D, Inochi2D): our tracking → the puppet's parameters. Pure (unit-tested in tools/rig2d_unit.ts).
//
// 1. rig2dDrive(frame) turns a TrackingFrame into STANDARD SOURCES in Cubism's usual units (angles in degrees ±30, eyes
//    0..1, eye balls / brows / mouth form ±1, mouth open 0..1) — the same numbers for every kind.
// 2. A binding says which puppet parameter a source drives (+ axis for Inochi2D's 2D parameters, gain, invert, an
//    optional in → out range). Live2D models: live2dAutoMap (standard ids, Cubism 2 aliases, riggers' common ids, cdi3
//    display names in EN / JA / ZH / KO, the EyeBlink / LipSync groups, the model's own VTube Studio mapping; tested in
//    tools/live2d_mapping_unit.ts); Inochi2D puppets get their parameters matched by NAME (head yaw, eye left blink …);
//    the parameter-mapping panel overrides any of it.
// Our frame conventions: head = [yaw, pitch, roll] radians, +yaw = avatar-left (= the viewer's right for an avatar facing
// the camera), +pitch = DOWN, +roll = counter-clockwise; gaze -1..1, +x = avatar-left, +y = DOWN; face = ARKit 52.
// Cubism template: +AngleX / +EyeBallX = toward the viewer's right, +AngleY / +EyeBallY = up, +AngleZ = CCW on screen.
import type { TrackingFrame } from '../types.ts';
import { readLipBus, VOWELS } from '../lipBus.ts';

export const RIG2D_SOURCES = ['headYaw', 'headPitch', 'headRoll', 'bodyYaw', 'bodyPitch', 'bodyRoll', 'eyeOpenL', 'eyeOpenR', 'eyeSmileL', 'eyeSmileR',
  'gazeX', 'gazeY', 'browLY', 'browRY', 'browLForm', 'browRForm', 'mouthOpen', 'mouthForm', 'cheek', 'breath', 'voice',
  // the extended mouth set riggers use for detailed lip sync (VBridger-style parameter names)
  'jawOpen', 'mouthFunnel', 'mouthPuckerWiden', 'mouthPressLipOpen', 'mouthShrug', 'mouthX', 'cheekPuff', 'tongueOut',
  // the five mouth shapes (ParamMouthA / I / U / E / O): voice visemes → vowels, shared/lipBus.ts. Only rigs that have them bind them.
  'mouthA', 'mouthI', 'mouthU', 'mouthE', 'mouthO'] as const;
export type Rig2DStdSource = typeof RIG2D_SOURCES[number];
/** A source: a standard one, or any raw ARKit blendshape as 'bs:<name>' (0..1). */
export type Rig2DSource = Rig2DStdSource | `bs:${string}`;

/** Each standard source's natural range (what the panel shows, what Inochi2D parameters are scaled from). */
export const SOURCE_RANGE: Record<Rig2DStdSource, [number, number]> = {
  headYaw: [-30, 30], headPitch: [-30, 30], headRoll: [-30, 30], bodyYaw: [-10, 10], bodyPitch: [-10, 10], bodyRoll: [-10, 10],
  eyeOpenL: [0, 1], eyeOpenR: [0, 1], eyeSmileL: [0, 1], eyeSmileR: [0, 1], gazeX: [-1, 1], gazeY: [-1, 1],
  browLY: [-1, 1], browRY: [-1, 1], browLForm: [-1, 1], browRForm: [-1, 1], mouthOpen: [0, 1], mouthForm: [-1, 1], cheek: [0, 1], breath: [0, 1], voice: [0, 1],
  jawOpen: [0, 1], mouthFunnel: [0, 1], mouthPuckerWiden: [-1, 1], mouthPressLipOpen: [-1, 1], mouthShrug: [0, 1], mouthX: [-1, 1], cheekPuff: [0, 1], tongueOut: [0, 1],
  mouthA: [0, 1], mouthI: [0, 1], mouthU: [0, 1], mouthE: [0, 1], mouthO: [0, 1],
};
export const SOURCE_LABEL: Record<Rig2DStdSource, string> = {
  headYaw: 'Head turn (left / right)', headPitch: 'Head nod (up / down)', headRoll: 'Head tilt', bodyYaw: 'Body turn', bodyPitch: 'Body lean', bodyRoll: 'Body tilt',
  eyeOpenL: 'Left eye open', eyeOpenR: 'Right eye open', eyeSmileL: 'Left eye smile', eyeSmileR: 'Right eye smile', gazeX: 'Eyes look left / right', gazeY: 'Eyes look up / down',
  browLY: 'Left brow up / down', browRY: 'Right brow up / down', browLForm: 'Left brow shape', browRForm: 'Right brow shape', mouthOpen: 'Mouth open',
  mouthForm: 'Mouth smile / frown', cheek: 'Blush', breath: 'Breathing', voice: 'Voice level',
  jawOpen: 'Jaw open', mouthFunnel: 'Lips rounded ("oh")', mouthPuckerWiden: 'Lips pucker / wide', mouthPressLipOpen: 'Lips pressed / apart',
  mouthShrug: 'Lower lip up', mouthX: 'Mouth left / right', cheekPuff: 'Cheeks puffed', tongueOut: 'Tongue out',
  mouthA: 'Mouth shape "ah"', mouthI: 'Mouth shape "ee" (thin)', mouthU: 'Mouth shape "oo"', mouthE: 'Mouth shape "eh"', mouthO: 'Mouth shape "oh"',
};

/** "How much each part moves" (profile.flat.opts.tune): per standard source, [toward +, toward −] = how far the value
 *  may move away from its rest in each direction, as a multiple of what tracking says (1 = as tracked, 0.4 = 40 %, up to
 *  TUNE_MAX). Applied to the SOURCE (before any binding's range), so it works the same for every model, converted Live2D
 *  ones included, and on every page that animates it (studio, OBS, phone, party guests). Missing = as tracked. */
export type Rig2DTune = Partial<Record<Rig2DStdSource, [number, number]>>;
export const TUNE_MAX = 2;
/** Where each source rests (eyes rest open; breathing in the middle; everything else at 0). */
export const SOURCE_REST: Partial<Record<Rig2DStdSource, number>> = { eyeOpenL: 1, eyeOpenR: 1, breath: 0.5 };
/** The values a tuned source may reach (its natural range; the eyes may open a little wider, as rig2dDrive allows). */
const tuneBounds = (s: Rig2DStdSource): [number, number] => (s === 'eyeOpenL' || s === 'eyeOpenR' ? [0, 1.25] : SOURCE_RANGE[s]);

/** Clean a saved tune (profile JSON, a guest's profile): known sources only, two finite numbers each, clamped to
 *  0..TUNE_MAX; entries that change nothing ([1, 1]) are dropped. Undefined = nothing to tune. */
export function sanitizeTune(v: unknown): Rig2DTune | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Rig2DTune = {};
  let n = 0;
  for (const s of RIG2D_SOURCES) {
    const x = (v as Record<string, unknown>)[s];
    if (!Array.isArray(x) || x.length !== 2 || !x.every((y) => typeof y === 'number' && Number.isFinite(y))) continue;
    const up = cl(x[0] as number, 0, TUNE_MAX), down = cl(x[1] as number, 0, TUNE_MAX);
    if (Math.abs(up - 1) < 1e-4 && Math.abs(down - 1) < 1e-4) continue;
    out[s] = [Math.round(up * 1000) / 1000, Math.round(down * 1000) / 1000];
    n++;
  }
  return n ? out : undefined;
}

/** Scale each tuned source's move away from its rest: the + side by tune[0], the − side by tune[1], kept inside the
 *  source's natural range. `raw` (optional) receives the values as tracked, before tuning (the studio's live marker). */
export function tuneSources(out: Record<string, number>, tune: Rig2DTune | undefined, raw?: Record<string, number>) {
  if (raw) for (const s of RIG2D_SOURCES) raw[s] = out[s] ?? 0;
  if (!tune) return;
  for (const k in tune) {
    const s = k as Rig2DStdSource, t = tune[s];
    if (!t) continue;
    const rest = SOURCE_REST[s] ?? 0, v = out[s] ?? rest, d = v - rest, [lo, hi] = tuneBounds(s);
    out[s] = cl(rest + d * (d >= 0 ? t[0] : t[1]), Math.min(lo, rest), Math.max(hi, rest));
  }
}

/** `roundSources`: the model has a dedicated rounding parameter bound (mouthFunnel / mouthPuckerWiden) → mouthForm is
 *  the corners only; otherwise mouthForm keeps the classic formula (rounding pulls it negative, as every older model expects). */
export interface DriveOpts { lipGain?: number; headGain?: number; tune?: Rig2DTune; /** receives the untuned values */ raw?: Record<string, number>; roundSources?: boolean }

const DEG = 180 / Math.PI;
const cl = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const ss = (a: number, b: number, x: number) => { const t = cl((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** The tracked frame as standard sources. `voice` = 0..1 voice activity; untracked frames give a calm idle. Writes
 *  into `out` (no allocation per frame). */
export function rig2dDrive(f: TrackingFrame, timeS: number, voice: number, o: DriveOpts = {}, out: Record<string, number> = {}): Record<Rig2DStdSource, number> {
  // the mouth channels come off the shared lip bus (shared/lipBus.ts): the same reading the 3D viseme rig uses
  const bus = readLipBus(f);
  const g = bus.face;
  const hg = o.headGain ?? 1;
  const tracked = f.tracked !== false;
  const [yaw, pitch, roll] = tracked ? f.head : [0, 0, 0];
  const ax = cl(yaw * DEG * hg, -30, 30), ay = cl(-pitch * DEG * hg, -30, 30), az = cl(roll * DEG * hg, -30, 30);
  const round = bus.round, wide = bus.wide;
  const m = f.mouth ?? { open: 0, smile: 0, frown: 0, pucker: 0, funnel: 0 };
  const smile = Math.max(m.smile ?? 0, (g('mouthSmileLeft') + g('mouthSmileRight')) / 2);
  const open = cl(Math.max(m.open ?? 0, (m.laugh ?? 0) * 0.6) * (o.lipGain ?? 1), 0, 1);
  const hp = f.headPos ?? [0, 0, 0];
  out.headYaw = ax; out.headPitch = ay; out.headRoll = az;
  out.bodyYaw = cl(ax / 3 + (hp[0] ?? 0) * 20, -10, 10); out.bodyPitch = cl(ay / 3, -10, 10); out.bodyRoll = cl(az / 3, -10, 10);
  out.eyeOpenL = tracked ? cl(1 - g('eyeBlinkLeft') * 1.08 + g('eyeWideLeft') * 0.25, 0, 1.25) : 1;
  out.eyeOpenR = tracked ? cl(1 - g('eyeBlinkRight') * 1.08 + g('eyeWideRight') * 0.25, 0, 1.25) : 1;
  out.eyeSmileL = cl(Math.max(g('cheekSquintLeft'), smile * 0.6 * g('eyeSquintLeft')), 0, 1);
  out.eyeSmileR = cl(Math.max(g('cheekSquintRight'), smile * 0.6 * g('eyeSquintRight')), 0, 1);
  const gz = f.gaze ?? [0, 0];
  // (a frame the camera lost: Audio2Face's eye micro-motion keeps the eyes alive, [0, 0] without it)
  const ag = bus.gaze();
  out.gazeX = tracked ? cl(gz[0], -1, 1) : ag[0]; out.gazeY = tracked ? cl(-gz[1], -1, 1) : ag[1];
  out.browLY = cl(g('browOuterUpLeft') * 0.6 + g('browInnerUp') * 0.6 - g('browDownLeft'), -1, 1);
  out.browRY = cl(g('browOuterUpRight') * 0.6 + g('browInnerUp') * 0.6 - g('browDownRight'), -1, 1);
  out.browLForm = cl(g('browInnerUp') * 0.4 - g('browDownLeft'), -1, 1);
  out.browRForm = cl(g('browInnerUp') * 0.4 - g('browDownRight'), -1, 1);
  out.mouthOpen = open;
  // classic: rounding pulls MouthForm negative (what models with only Open + Form were rigged for). With a dedicated
  // rounding parameter bound (o.roundSources) the corners are emotion only — rounding has its own sources below.
  out.mouthForm = o.roundSources
    ? cl(smile * 1.3 - (m.frown ?? 0) + wide * 0.35 * open, -1, 1)
    : cl(smile * 1.3 - (m.frown ?? 0) - (m.pucker ?? 0) * 0.6 - (m.funnel ?? 0) * 0.4 + wide * 0.35 * open - round * 0.5 * open, -1, 1);
  const rnd = cl(Math.max(m.pucker ?? 0, m.funnel ?? 0, round * Math.min(1, open * 2 + 0.3)), 0, 1);
  const spread = cl(Math.max(m.wide ?? 0, wide * 0.8), 0, 1);
  out.jawOpen = cl(Math.max(g('jawOpen'), open) * (o.lipGain ?? 1), 0, 1);
  out.mouthFunnel = cl(Math.max(m.funnel ?? 0, g('mouthFunnel'), round * 0.8), 0, 1);
  out.mouthPuckerWiden = cl(spread - rnd, -1, 1);
  // pressed lips (M / B / P seal, a press) → −1; lips apart over the teeth (F / S / an open "ee") → +
  const press = Math.max(m.closure ?? 0, (g('mouthPressLeft') + g('mouthPressRight')) / 2);
  out.mouthPressLipOpen = cl(Math.max(m.sib ?? 0, (g('mouthUpperUpLeft') + g('mouthUpperUpRight')) / 2) - press, -1, 1);
  out.mouthShrug = cl(Math.max(m.fv ?? 0, g('mouthShrugLower'), g('mouthRollLower')), 0, 1);
  out.mouthX = cl(g('mouthLeft') - g('mouthRight'), -1, 1);
  out.cheekPuff = cl(g('cheekPuff'), 0, 1);
  out.tongueOut = cl(Math.max(m.tongue ?? 0, g('tongueOut')), 0, 1);
  // the five mouth shapes, gated by how open the mouth is (a vowel without a gape is a lip shape on a shut mouth)
  const vw = bus.vowels(), vg = ss(0.02, 0.3, open);
  for (const k of VOWELS) out[`mouth${k}`] = cl(vw[k] * vg, 0, 1);
  out.cheek = cl(smile * 0.7, 0, 1);
  out.breath = 0.5 + 0.5 * Math.sin(timeS * 2 * Math.PI / 3.4);
  out.voice = cl(voice, 0, 1);
  if (o.tune || o.raw) tuneSources(out, o.tune, o.raw);
  return out as Record<Rig2DStdSource, number>;
}

/** The value of any source (standard or 'bs:<ARKit name>'). */
export function sourceValue(src: string, std: Record<string, number>, f: TrackingFrame): number {
  if (src.startsWith('bs:')) return f.face?.[src.slice(3)] ?? 0;
  return std[src] ?? 0;
}

// ---------------------------------------------------------------- bindings
/** One source → one puppet parameter. `axis` = 0 (x) / 1 (y) for 2D parameters (Inochi2D); `range` maps the source's
 *  [inLo, inHi] onto the parameter's [outLo, outHi] (missing = the value is written as is). */
export interface Rig2DBinding { src: Rig2DSource; param: string; axis?: 0 | 1; gain?: number; invert?: boolean; range?: [number, number, number, number]; off?: boolean }

const SRC_RE = /^(bs:[A-Za-z0-9_]{1,40}|[a-zA-Z]{2,20})$/;
const PARAM_RE = /^[^\x00-\x1f]{1,96}$/;
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
export function sanitizeBindings(v: unknown, max = 96): Rig2DBinding[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Rig2DBinding[] = [];
  for (const b of v.slice(0, max)) {
    if (!b || typeof b !== 'object') continue;
    const o = b as Record<string, unknown>;
    if (typeof o.src !== 'string' || !SRC_RE.test(o.src) || (!o.src.startsWith('bs:') && !(RIG2D_SOURCES as readonly string[]).includes(o.src))) continue;
    if (typeof o.param !== 'string' || !PARAM_RE.test(o.param)) continue;
    const r: Rig2DBinding = { src: o.src as Rig2DSource, param: o.param };
    if (o.axis === 1 || o.axis === 0) r.axis = o.axis;
    if (fin(o.gain)) r.gain = cl(o.gain, -10, 10);
    if (o.invert === true) r.invert = true;
    if (o.off === true) r.off = true;
    if (Array.isArray(o.range) && o.range.length === 4 && o.range.every(fin) && o.range[0] !== o.range[1]) r.range = o.range.map((x) => cl(x as number, -1e4, 1e4)) as Rig2DBinding['range'];
    out.push(r);
  }
  return out;
}

/** A binding's parameter value from its source value. */
export function bindValue(b: Rig2DBinding, v: number): number {
  let x = v * (b.gain ?? 1);
  if (b.invert) x = -x;
  if (b.range) {
    const [a, c, lo, hi] = b.range;
    const t = cl((x - a) / (c - a), 0, 1);
    x = lo + (hi - lo) * t;
  }
  return x;
}

/** A puppet parameter as the binding code sees it. */
export interface Rig2DParamInfo { id: string; name: string; /** 2 = a 2D parameter (Inochi2D vec2) */ dims: 1 | 2; min: [number, number]; max: [number, number]; def: [number, number] }

// ---------------------------------------------------------------- Live2D: standard ids
/** Cubism standard parameter id(s) per source (the first that the model has wins; then the Cubism 2 aliases). */
export const L2D_STANDARD: Partial<Record<Rig2DStdSource, string[]>> = {
  headYaw: ['ParamAngleX', 'PARAM_ANGLE_X'], headPitch: ['ParamAngleY', 'PARAM_ANGLE_Y'], headRoll: ['ParamAngleZ', 'PARAM_ANGLE_Z'],
  bodyYaw: ['ParamBodyAngleX', 'PARAM_BODY_ANGLE_X'], bodyPitch: ['ParamBodyAngleY', 'PARAM_BODY_ANGLE_Y'], bodyRoll: ['ParamBodyAngleZ', 'PARAM_BODY_ANGLE_Z'],
  eyeOpenL: ['ParamEyeLOpen', 'PARAM_EYE_L_OPEN'], eyeOpenR: ['ParamEyeROpen', 'PARAM_EYE_R_OPEN'],
  eyeSmileL: ['ParamEyeLSmile', 'PARAM_EYE_L_SMILE'], eyeSmileR: ['ParamEyeRSmile', 'PARAM_EYE_R_SMILE'],
  gazeX: ['ParamEyeBallX', 'PARAM_EYE_BALL_X'], gazeY: ['ParamEyeBallY', 'PARAM_EYE_BALL_Y'],
  browLY: ['ParamBrowLY', 'PARAM_BROW_L_Y'], browRY: ['ParamBrowRY', 'PARAM_BROW_R_Y'],
  browLForm: ['ParamBrowLForm', 'PARAM_BROW_L_FORM'], browRForm: ['ParamBrowRForm', 'PARAM_BROW_R_FORM'],
  mouthOpen: ['ParamMouthOpenY', 'PARAM_MOUTH_OPEN_Y'], mouthForm: ['ParamMouthForm', 'PARAM_MOUTH_FORM'],
  cheek: ['ParamCheek', 'PARAM_CHEEK'], breath: ['ParamBreath', 'PARAM_BREATH'],
};
/** The extended mouth sources' usual parameter ids (VBridger-style rigs). NOT auto-bound (live2dAutoMap leaves a model's
 *  parameters exactly as before): the parameter-mapping panel offers them for the user to bind. */
export const L2D_EXTENDED_MOUTH: Partial<Record<Rig2DStdSource, string[]>> = {
  jawOpen: ['ParamJawOpen'], mouthFunnel: ['ParamMouthFunnel'], mouthPuckerWiden: ['ParamMouthPuckerWiden'], mouthPressLipOpen: ['ParamMouthPressLipOpen'],
  mouthShrug: ['ParamMouthShrug'], mouthX: ['ParamMouthX'], cheekPuff: ['ParamCheekPuffC', 'ParamCheekPuff'], tongueOut: ['ParamTongueOut'],
  mouthA: ['ParamMouthA'], mouthI: ['ParamMouthI'], mouthU: ['ParamMouthU'], mouthE: ['ParamMouthE'], mouthO: ['ParamMouthO'],
};

// ---------------------------------------------------------------- Live2D: commissioned models' own names
/** Parameter ids riggers use instead of the standard ones, normalised (lower case, no "Param" prefix, letters and
 *  digits only). A `!` prefix = the parameter runs the other way (a "blink" / "close" parameter: 1 = shut). */
const L2D_ALIASES: Partial<Record<Rig2DStdSource, string[]>> = {
  headYaw: ['anglex', 'headx', 'headanglex', 'faceanglex', 'faceangx', 'headyaw', 'faceyaw', 'headturn', 'angx', 'headrotx', 'facex', 'kaox', 'kaoanglex'],
  headPitch: ['angley', 'heady', 'headangley', 'faceangley', 'faceangy', 'headpitch', 'facepitch', 'headnod', 'angy', 'headroty', 'facey', 'kaoy', 'kaoangley'],
  headRoll: ['anglez', 'headz', 'headanglez', 'faceanglez', 'faceangz', 'headroll', 'faceroll', 'headtilt', 'angz', 'headrotz', 'facez', 'kaoz', 'kaoanglez'],
  bodyYaw: ['bodyanglex', 'bodyx', 'bodyyaw', 'bodyturn', 'bodyangx', 'torsox', 'torsoanglex', 'bodyrotx'],
  bodyPitch: ['bodyangley', 'bodyy', 'bodypitch', 'bodyangy', 'torsoy', 'torsoangley', 'bodyroty'],
  bodyRoll: ['bodyanglez', 'bodyz', 'bodyroll', 'bodyangz', 'torsoz', 'torsoanglez', 'bodyrotz', 'bodytilt'],
  eyeOpenL: ['eyelopen', 'eyeopenl', 'lefteyeopen', 'eyeleftopen', 'leyeopen', 'eyelopenclose', 'eyel', 'lefteye', 'eyeopen', 'eyesopen', 'eyeopenclose', '!eyelblink', '!eyeblinkl', '!lefteyeblink', '!eyelclose', '!eyeclosel', '!eyeblink', '!blink', '!eyeclose', '!eyesclose'],
  eyeOpenR: ['eyeropen', 'eyeopenr', 'righteyeopen', 'eyerightopen', 'reyeopen', 'eyeropenclose', 'eyer', 'righteye', '!eyerblink', '!eyeblinkr', '!righteyeblink', '!eyerclose', '!eyecloser'],
  eyeSmileL: ['eyelsmile', 'eyesmilel', 'lefteyesmile', 'eyesmile', 'eyeshappy'],
  eyeSmileR: ['eyersmile', 'eyesmiler', 'righteyesmile'],
  gazeX: ['eyeballx', 'eyex', 'eyesx', 'pupilx', 'irisx', 'eyeballsx', 'lookx', 'gazex', 'eyelookx', 'medamax'],
  gazeY: ['eyebally', 'eyey', 'eyesy', 'pupily', 'irisy', 'eyeballsy', 'looky', 'gazey', 'eyelooky', 'medamay'],
  browLY: ['browly', 'browyl', 'eyebrowly', 'leftbrowy', 'browlefty', 'eyebrowlefty', 'browleft', 'browleftupdown', 'browlupdown', 'eyebrowleft'],
  browRY: ['browry', 'browyr', 'eyebrowry', 'rightbrowy', 'browrighty', 'eyebrowrighty', 'browright', 'browrightupdown', 'browrupdown', 'eyebrowright'],
  browLForm: ['browlform', 'browforml', 'eyebrowlform', 'leftbrowform'],
  browRForm: ['browrform', 'browformr', 'eyebrowrform', 'rightbrowform'],
  mouthOpen: ['mouthopeny', 'mouthopen', 'mouthy', 'jawopen', 'mouthopenclose', 'mouthopenness', 'kuchiopen', 'mouthopenyy', 'openmouth', 'mouthopening', 'jaw'],
  mouthForm: ['mouthform', 'mouthsmile', 'mouthshape', 'mouthemotion', 'mouthformy', 'smile', 'mouthhappy'],
  cheek: ['cheek', 'blush', 'cheeks', 'flush', 'cheekred', 'blushing', 'hoho', 'tere'],
  breath: ['breath', 'breathing', 'breathe', 'kokyu'],
};
const idKey = (id: string) => id.normalize('NFKC').toLowerCase().replace(/^param(eter)?[_\s-]*/, '').replace(/[^a-z0-9]/g, '');
/** A guess: the source, whether the parameter runs the other way, and `half` = it holds only the + or − half of a
 *  signed source (a "mouth corners up" parameter = the smile half of mouthForm, "corners down" = the frown half). */
interface Guess { s: Rig2DStdSource; inv: boolean; half?: 1 | -1 }
const ALIAS_OF = new Map<string, Guess>();
for (const [s, list] of Object.entries(L2D_ALIASES) as [Rig2DStdSource, string[]][]) for (const a of list) { const k = a.replace(/^!/, ''); if (!ALIAS_OF.has(k)) ALIAS_OF.set(k, { s, inv: a.startsWith('!') }); }
for (const k of ['mouthup', 'mouthcornerup', 'mouthcornersup', 'mouthsmileup', 'mouthhappy', 'mouthcornerupl', 'mouthcornerupr']) ALIAS_OF.set(k, { s: 'mouthForm', inv: false, half: 1 });
for (const k of ['mouthdown', 'mouthcornerdown', 'mouthcornersdown', 'mouthfrown', 'mouthsad', 'mouthcornerdownl', 'mouthcornerdownr']) ALIAS_OF.set(k, { s: 'mouthForm', inv: false, half: -1 });

/** What a parameter's DISPLAY name (cdi3.json; Cubism Editor's English / Japanese / Chinese / Korean templates and
 *  riggers' own words) says it is. null = not a tracked part (hair sway, arms, physics, toggles …). */
export function guessLive2DName(display: string): Guess | null {
  const n = ` ${display.normalize('NFKC').toLowerCase().replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-:./()[\]（）]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  if (n.trim().length < 1) return null;
  const t = (re: RegExp) => re.test(n);
  // never: hair, arms / hands, physics / sway, toggles, accessories, tongue, cheek puff, vowels
  if (t(/髪|hair|머리카락|头发|頭髪|腕|arm|手|hand|팔|손|指|finger|足|脚|leg|揺れ|摇|sway|swing|bounce|phys|物理|toggle|切替|切り替え|switch|スカート|skirt|リボン|ribbon|尻尾|tail|耳|ear|帽|hat|舌|tongue|膨|puff|inflate|ほっぺ膨|涙|tear|汗|sweat|影|shadow|accessor|アクセ|服|cloth|衣|胸|breast|chest bounce/)) return null;
  const side: 'L' | 'R' | null = t(/左|left|왼|(^| )l( |$)/) ? 'L' : t(/右|right|오른|(^| )r( |$)/) ? 'R' : null;
  const axis: 'x' | 'y' | 'z' | null = t(/( |\d|[^a-z])x( |$)|横|左右|水平|yaw|turn/) ? 'x' : t(/( |\d|[^a-z])y( |$)|縦|上下|垂直|pitch|nod/) ? 'y' : t(/( |\d|[^a-z])z( |$)|傾|倾|回転 ?z|roll|tilt/) ? 'z' : null;
  if (t(/呼吸|breath|호흡/)) return { s: 'breath', inv: false };
  if (t(/照れ|頬|ほほ|赤面|脸红|臉紅|害羞|红晕|cheek|blush|홍조|볼 /)) return { s: 'cheek', inv: false };
  if (t(/眉|brow|눈썹/)) {
    if (t(/変形|变形|變形|form|shape|변형/)) return side === 'R' ? { s: 'browRForm', inv: false } : side === 'L' ? { s: 'browLForm', inv: false } : null;
    if (t(/上下|( |^)y( |$)|up|高さ|높이|위아래/) || !t(/左右|( |^)x( |$)|角度|angle|回転|회전/)) return side === 'R' ? { s: 'browRY', inv: false } : side === 'L' ? { s: 'browLY', inv: false } : null;
    return null;
  }
  if (t(/目玉|眼球|眼珠|瞳|eye ?ball|pupil|iris|눈알|눈동자|gaze|視線|视线/)) return axis === 'y' ? { s: 'gazeY', inv: false } : axis === 'x' ? { s: 'gazeX', inv: false } : null;
  if (t(/目|眼|eye|눈|まぶた|瞼|lid/) && !t(/目尻|eyelash|まつげ|睫/)) {
    if (t(/笑|smile|微笑|웃|happy/)) return { s: side === 'R' ? 'eyeSmileR' : 'eyeSmileL', inv: false };
    const closeOnly = t(/閉じ|閉|闭|close|blink|まばたき|瞬|眨|감/) && !t(/開閉|开闭|開閉|open|開|开|개폐|뜨/);
    if (closeOnly || t(/開閉|开闭|开合|open|開|开|개폐|뜨/)) return { s: side === 'R' ? 'eyeOpenR' : 'eyeOpenL', inv: closeOnly };
    return null;
  }
  if (t(/口|嘴|mouth|입|唇|lip|jaw|あご|顎/)) {
    if (t(/上がり|口角 ?上|嘴角 ?上|corners? ?up|mouth ?up|입꼬리 ?올/)) return { s: 'mouthForm', inv: false, half: 1 };
    if (t(/下がり|口角 ?下|嘴角 ?下|corners? ?down|mouth ?down|frown|입꼬리 ?내/)) return { s: 'mouthForm', inv: false, half: -1 };
    if (t(/変形|变形|變形|form|smile|shape|변형|笑|형태|emotion|表情/)) return { s: 'mouthForm', inv: false };
    if (t(/開閉|开闭|开合|張開|张开|open|개폐|開|开|열/)) return { s: 'mouthOpen', inv: false };
    return null;
  }
  const body = t(/体|身体|身體|body|몸|torso|胴|上半身/);
  // the head: named as the head / face, or Cubism's bare template name ("Angle X", "角度 X", "각도 X") and nothing
  // else: "Wing Angle X", "Shoulder Angle X", "Camera Angle X" are not the head
  const head = t(/頭|顔|头|脸|頭部|head|face|얼굴|머리|首|neck/) || /^(angle|角度|각도) ?[xyz]$/.test(n.trim());
  if (body || head) {
    if (!axis) return null;
    const S = body ? (['bodyYaw', 'bodyPitch', 'bodyRoll'] as const) : (['headYaw', 'headPitch', 'headRoll'] as const);
    return { s: S[axis === 'x' ? 0 : axis === 'y' ? 1 : 2], inv: false };
  }
  return null;
}

/** How each automatic binding was found (the mapping report and the studio's details panel). */
export type Live2DMapHow = 'standard' | 'alias' | 'name' | 'blink group' | 'lip sync group' | 'vtube studio';
export interface Live2DAutoOpts {
  /** model3.json EyeBlink group */
  eyeBlink?: readonly string[];
  /** VTube Studio's parameter mapping from the model's .vtube.json (converter: extra.vtsBindings; sanitized here) */
  vts?: unknown;
}

/** A binding's in → out range so the source's natural units land on the parameter's own range (a head parameter
 *  that runs −1..1 instead of −30..30, a 0..10 mouth, a 0..1 mouth form, an inverted "blink" eye). Undefined = as is. */
function fitRange(s: Rig2DStdSource, p: Rig2DParamInfo, inv: boolean): Rig2DBinding['range'] {
  const lo = Math.min(p.min[0], p.max[0]), hi = Math.max(p.min[0], p.max[0]), def = p.def[0], span = hi - lo;
  const [a, b] = SOURCE_RANGE[s];
  if (!(span > 0)) return undefined;
  if (s === 'eyeOpenL' || s === 'eyeOpenR') {
    // open = the parameter's rest value (its default), unless the default is the shut end
    const shut = inv ? hi : lo;
    const open = Math.abs(def - shut) > span * 0.25 ? def : (inv ? lo : hi);
    return inv || Math.abs(shut - 0) > 1e-6 || Math.abs(open - 1) > 1e-6 ? [0, 1, shut, open] : undefined;
  }
  if (a < 0) return signedRange(s, p, false);
  // 0..1 sources: a parameter that runs much further (0..10, 0..100) is scaled
  if (inv) return [a, b, hi, lo];
  return span > (b - a) * 2.5 || lo > a + 0.5 ? [a, b, lo, hi] : undefined;
}
/** Signed sources (head / body angles, gaze, brows, mouth form; rest = 0), written in Cubism's units as VTube Studio's
 *  default mapping does, unless the parameter is on another scale:
 *  - standard ids: as is, except a head / body angle on a ±1 scale;
 *  - other parameters: as is when they hold the natural range at a similar scale (a −2..1 mouth form, a ±1 brow);
 *    one that only goes one way from its rest (0..1 resting at 0) takes the half of the source with room; anything
 *    else (a 0..1 brow resting at 0.5, a ±30 eye ball, a ±1 head) spans the natural range over the parameter's. */
function signedRange(s: Rig2DStdSource, p: Rig2DParamInfo, standard: boolean): Rig2DBinding['range'] {
  const lo = Math.min(p.min[0], p.max[0]), hi = Math.max(p.min[0], p.max[0]), def = p.def[0], span = hi - lo;
  const [a, b] = SOURCE_RANGE[s];
  if (!(span > 0)) return undefined;
  if (standard) return (s.startsWith('head') || s.startsWith('body')) && span <= (b - a) * 0.2 ? [a, b, lo, hi] : undefined;
  if (lo <= a * 0.5 && hi >= b * 0.5 && span <= (b - a) * 5) return undefined;
  const atLo = def - lo <= span * 0.05, atHi = hi - def <= span * 0.05;
  if (atLo && !atHi) return [0, b, def, hi];
  if (atHi && !atLo) return [a, 0, lo, def];
  return [a, b, lo, hi];
}

/** The automatic mapping for a Live2D model (what the camera / voice moves), most certain first:
 *  1. Cubism's standard ids (and the Cubism 2 aliases); 2. the ids riggers commonly use instead (ParamHeadX, EyeBlinkL,
 *  Param_Mouth_Open …); 3. the display names in the cdi3.json (English / Japanese / Chinese / Korean); 4. the
 *  model3.json EyeBlink group (left / right by name or order) and LipSync group; 5. VTube Studio's own mapping when the
 *  model brought its .vtube.json (it wins for the parameters it maps with inputs we track). Each parameter is driven
 *  by one source at most (VTube Studio may drive one input into several); ranges are fitted (fitRange). */
export function live2dAutoMap(params: readonly Rig2DParamInfo[], lipSyncIds: readonly string[] = [], o: Live2DAutoOpts = {}): { bindings: Rig2DBinding[]; how: Map<string, Live2DMapHow> } {
  const byId = new Map(params.map((p) => [p.id, p]));
  const out: Rig2DBinding[] = [];
  const how = new Map<string, Live2DMapHow>();
  const usedParam = new Set<string>(), usedSrc = new Set<string>();
  const halves = new Set<string>();
  const add = (s: Rig2DStdSource, p: Rig2DParamInfo, h: Live2DMapHow, inv = false, half?: 1 | -1) => {
    if (usedParam.has(p.id) || p.dims !== 1) return false;
    let range = h === 'standard' && !inv ? standardRange(s, p) : fitRange(s, p, inv);
    if (half) {
      // one half of a signed source: rest (the default) at 0, the parameter's far end at ±1
      const lo = Math.min(p.min[0], p.max[0]), hi = Math.max(p.min[0], p.max[0]), d = p.def[0], far = Math.abs(hi - d) >= Math.abs(d - lo) ? hi : lo;
      range = half > 0 ? [0, 1, d, far] : [-1, 0, far, d];
      halves.add(`${s}${half}`);
    } else usedSrc.add(s);
    out.push({ src: s, param: p.id, ...(range ? { range } : {}) });
    usedParam.add(p.id); how.set(p.id, h);
    return true;
  };
  // 1. standard ids
  for (const s of RIG2D_SOURCES) {
    const id = (L2D_STANDARD[s] ?? []).find((c) => byId.has(c));
    if (id) add(s, byId.get(id)!, 'standard');
  }
  // 2. aliases, 3. display names (only for sources still free; first matching parameter in model order)
  for (const pass of ['alias', 'name'] as const) {
    for (const p of params) {
      if (usedParam.has(p.id)) continue;
      const g = pass === 'alias' ? ALIAS_OF.get(idKey(p.id)) : (p.name && p.name !== p.id ? guessLive2DName(p.name) : null) ?? (pass === 'name' ? guessLive2DName(p.id.replace(/^Param/, '')) : null);
      if (!g || usedSrc.has(g.s) || (g.half && halves.has(`${g.s}${g.half}`))) continue;
      add(g.s, p, pass, g.inv, g.half);
    }
  }
  // 4. the model's own groups
  const blink = (o.eyeBlink ?? []).filter((id) => byId.has(id) && !usedParam.has(id));
  for (const [i, id] of blink.entries()) {
    const nm = `${id} ${byId.get(id)!.name}`;
    const side = /(^|[^a-z])R([^a-z]|$)|Right|右|오른|[a-z]R[A-Z]/.test(nm) ? 'R' : /(^|[^a-z])L([^a-z]|$)|Left|左|왼|[a-z]L[A-Z]/.test(nm) ? 'L' : i === 0 ? 'L' : 'R';
    const s: Rig2DStdSource = side === 'R' ? (usedSrc.has('eyeOpenR') && !usedSrc.has('eyeOpenL') ? 'eyeOpenL' : 'eyeOpenR') : (usedSrc.has('eyeOpenL') && !usedSrc.has('eyeOpenR') ? 'eyeOpenR' : 'eyeOpenL');
    add(s, byId.get(id)!, 'blink group', /close|blink|閉/i.test(nm) && !/open|開/i.test(nm));
  }
  for (const id of lipSyncIds) { const p = byId.get(id); if (p && !usedParam.has(id)) add('mouthOpen', p, 'lip sync group'); }
  // 5. VTube Studio's mapping
  const vts = sanitizeBindings(o.vts) ?? [];
  if (vts.length) {
    const mapped = new Set(vts.filter((b) => byId.has(b.param)).map((b) => b.param));
    for (let i = out.length - 1; i >= 0; i--) if (mapped.has(out[i].param)) { how.delete(out[i].param); out.splice(i, 1); }
    for (const b of vts) if (byId.has(b.param)) { out.push(b); how.set(b.param, 'vtube studio'); }
  }
  return { bindings: out, how };
}
/** Standard ids are written as is (Cubism's units), unless the rigger gave the parameter a different scale. */
function standardRange(s: Rig2DStdSource, p: Rig2DParamInfo): Rig2DBinding['range'] {
  const lo = Math.min(p.min[0], p.max[0]), hi = Math.max(p.min[0], p.max[0]), span = hi - lo;
  const [a] = SOURCE_RANGE[s];
  if (!(span > 0)) return undefined;
  if (a < 0) return signedRange(s, p, true);                     // a ±1 head, a mouth form resting at one end
  if (s === 'mouthOpen' && hi > 3) return [0, 1, lo, hi];       // a 0..10 / 0..100 mouth
  return undefined;
}

/** The automatic bindings for a Live2D model (live2dAutoMap without the report). */
export function live2dAutoBindings(params: readonly Rig2DParamInfo[], lipSyncIds: readonly string[] = [], o: Live2DAutoOpts = {}): Rig2DBinding[] {
  return live2dAutoMap(params, lipSyncIds, o).bindings;
}

// ---------------------------------------------------------------- Inochi2D: parameters matched by name
const norm = (s: string) => ` ${s.toLowerCase().replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[^a-z0-9]+/g, ' ').trim()} `;
const has = (n: string, ...w: string[]) => w.some((x) => n.includes(` ${x} `) || n.includes(` ${x}`) && x.length > 3);
const left = (n: string) => has(n, 'left', 'l');
const right = (n: string) => has(n, 'right', 'r');

/** What an Inochi2D parameter name most likely means: [source for axis x, source for axis y]. Covers the names Inochi
 *  Creator users commonly use ("Head:: Yaw-Pitch", "Head:: Roll", "Eye:: Left:: Blink", "Mouth:: Open" …). */
export function guessInochiSources(name: string, dims: 1 | 2): [Rig2DStdSource | null, Rig2DStdSource | null] {
  const n = norm(name);
  const isEye = has(n, 'eye', 'eyes'), isHead = has(n, 'head', 'face', 'neck'), isBody = has(n, 'body', 'torso', 'chest'), isMouth = has(n, 'mouth', 'lip', 'lips', 'jaw');
  const isBrow = has(n, 'brow', 'brows', 'eyebrow', 'eyebrows');
  const yaw = has(n, 'yaw', 'x', 'turn', 'horizontal'), pitch = has(n, 'pitch', 'y', 'nod', 'vertical'), roll = has(n, 'roll', 'z', 'tilt');
  if (isBrow) {
    const s: Rig2DStdSource | null = left(n) ? (has(n, 'form', 'shape', 'angle') ? 'browLForm' : 'browLY') : right(n) ? (has(n, 'form', 'shape', 'angle') ? 'browRForm' : 'browRY') : null;
    return [s, null];
  }
  if (isEye && !isHead) {
    if (has(n, 'blink', 'open', 'close', 'closed', 'lid')) {
      const closing = has(n, 'blink', 'close', 'closed');
      void closing;
      return [left(n) ? 'eyeOpenL' : right(n) ? 'eyeOpenR' : 'eyeOpenL', null];
    }
    if (has(n, 'smile', 'happy', 'squint')) return [left(n) ? 'eyeSmileL' : 'eyeSmileR', null];
    if (dims === 2 || has(n, 'look', 'gaze', 'ball', 'pupil', 'iris', 'yaw', 'pitch', 'x', 'y')) {
      if (dims === 2) return ['gazeX', 'gazeY'];
      return [pitch && !yaw ? 'gazeY' : 'gazeX', null];
    }
  }
  if (isMouth) {
    if (has(n, 'open', 'opening', 'jaw', 'talk', 'speak')) return ['mouthOpen', null];
    if (has(n, 'smile', 'form', 'shape', 'happy', 'emotion', 'mood')) return dims === 2 ? ['mouthForm', 'mouthOpen'] : ['mouthForm', null];
    return [null, null];
  }
  if (isHead || isBody) {
    const [Y, P, R]: Rig2DStdSource[] = isBody && !isHead ? ['bodyYaw', 'bodyPitch', 'bodyRoll'] : ['headYaw', 'headPitch', 'headRoll'];
    if (dims === 2) return roll && !yaw ? [R, P] : [Y, P];
    if (roll) return [R, null];
    if (yaw && !pitch) return [Y, null];
    if (pitch && !yaw) return [P, null];
    return [null, null];
  }
  if (has(n, 'breath', 'breathe', 'breathing')) return ['breath', null];
  if (has(n, 'blush', 'cheek', 'cheeks')) return ['cheek', null];
  return [null, null];
}

/** Map a source's natural range onto the parameter's [min, max] for that axis (eyes: open 1 = the parameter's "open"
 *  end; an Inochi2D "blink" parameter is usually 0 open → 1 closed, so it is inverted). */
export function inochiAutoBindings(params: readonly Rig2DParamInfo[]): Rig2DBinding[] {
  const out: Rig2DBinding[] = [];
  const used = new Set<string>();
  for (const p of params) {
    const g = guessInochiSources(p.name, p.dims);
    for (const axis of [0, 1] as const) {
      const s = g[axis];
      if (!s || (axis === 1 && p.dims === 1)) continue;
      const key = `${s}`;
      if (used.has(key) && !s.startsWith('eye') && !s.startsWith('mouth')) continue;
      used.add(key);
      const [lo, hi] = SOURCE_RANGE[s];
      let outLo = p.min[axis], outHi = p.max[axis];
      const n = norm(p.name);
      // eye "blink" / "close" parameters run the other way round from "open"
      if ((s === 'eyeOpenL' || s === 'eyeOpenR') && has(n, 'blink', 'close', 'closed')) [outLo, outHi] = [outHi, outLo];
      // our pitch +up / Inochi2D usually +down on screen-like (y-down) rigs: keep the parameter's own sign; the panel inverts
      out.push({ src: s, param: p.id, ...(p.dims === 2 ? { axis } : {}), range: [lo, hi, outLo, outHi] });
    }
  }
  return out;
}

/** Apply bindings to parameter values: `set(param, axis, value)` gets values clamped to the parameter's range. Several
 *  bindings on one parameter axis add up (relative to the parameter default). */
export function applyBindings(bindings: readonly Rig2DBinding[], std: Record<string, number>, f: TrackingFrame,
  info: (param: string) => Rig2DParamInfo | null, set: (param: string, axis: 0 | 1, v: number) => void) {
  for (const b of bindings) {
    if (b.off) continue;
    const p = info(b.param);
    if (!p) continue;
    const axis = b.axis ?? 0;
    const v = bindValue(b, sourceValue(b.src, std, f));
    const lo = Math.min(p.min[axis], p.max[axis]), hi = Math.max(p.min[axis], p.max[axis]);
    set(b.param, axis, cl(v, lo, hi));
  }
}
