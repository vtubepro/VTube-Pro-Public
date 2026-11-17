// Colour roles per fixture class and the structure (keylight) layer of a festival stage - the pure part, shared by the
// renderers (src/scene/festival/*), the composer (shared/festivalCompose.ts) and the units (tools/festival_roles_unit.ts).
// docs/SCENES.md "Festival stages" → "House look".
//
//   roles      a show (or a room show in scene.json) can give each fixture class its own colour job instead of the one
//              palette spread over everything: the set's outline (structure / pixels / the stage wash) in the palette's
//              warm colours, beams cold white in half the peak phrases, lasers mostly green, warm blinders, a second colour on
//              the crowd and one deep colour for the quiet parts. Colour changes happen on 8-bar phrase boundaries only
//              (eased over 2 beats).
//   structure  the lights that outline the set keep the stage's silhouette all show long: a slow level per song section,
//              a shallow pulse (never strobed, never a flash key), a floor that survives every blackout.
// Everything is a pure function of the music moment, so every page agrees. No allocation per call (scratch objects,
// colours parsed once per roles object).
import { clamp01, hash3, hashStr, hexRgb } from './festival.ts';

export type RGB = [number, number, number];
type Sec = 'intro' | 'groove' | 'build' | 'drop' | 'breakdown' | 'outro';

// ---------------------------------------------------------------------------------------------------- roles
export interface ColorRoles {
  /** the set's outline (pixel bars, structure PARs, the stage wash): spread across the rig, one step per 8-bar phrase */
  structure: string[];
  /** beams: this colour in `beamShare` of the peak phrases (drops, builds), the palette's colour in the rest; `beamGain`
   *  = how bright it is (0..1 of the colour: a white beam is ~9x the luminance of a red one - a whole rig of full-white
   *  cones in the haze would wash the warm set out) */
  beam: string; beamShare: number; beamGain: number;
  /** lasers: one colour per phrase, picked by these weights */
  lasers: string[]; laserShare: number[];
  blinder: string; strobe: string;
  /** the crowd wash: the show's second colour */
  crowd: string;
  /** breakdowns: the show layer (beams, spots, washes, PARs) in one deep colour */
  quiet: string;
}
/** The generic hard-dance mainstage house look: a red / amber / gold set, cold white beams in half the peak phrases, green lasers, warm blinders, a
 *  violet second colour on the crowd, deep blue in the quiet parts. All values are tunable defaults (room shows override
 *  any field in scene.json `festival.shows[].roles`). */
export const MAINSTAGE_ROLES: ColorRoles = {
  structure: ['#b8160c', '#e2591c', '#f29a28', '#ffc24a'],
  // (white beams in half the peak phrases at 0.4: a whole rig of white cones in the haze in most phrases - 70 % at 0.6 -
  //  read as a grey veil over the frame on the drawn page; half of them warm keeps the set's contrast)
  beam: '#eef2ff', beamShare: 0.5, beamGain: 0.4,
  lasers: ['#2bff5a', '#00e5ff', '#f4f8ff'], laserShare: [0.8, 0.15, 0.05],
  blinder: '#ffb066', strobe: '#ffece0',
  crowd: '#7a3cff', quiet: '#1424a8',
};
/** the same house with a magenta second colour */
export const MAINSTAGE_MAGENTA_ROLES: ColorRoles = { ...MAINSTAGE_ROLES, crowd: '#d4207e' };

const HEX = /^#[0-9a-fA-F]{6}$/;
/** Room data → roles: every field optional (missing / invalid = the house default). */
export function sanitizeRoles(raw: unknown, base: ColorRoles = MAINSTAGE_ROLES): ColorRoles | null {
  if (raw === true) return { ...base };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const hex = (v: unknown, d: string) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : d);
  const hexes = (v: unknown, d: string[], min = 1) => { const l = Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string' && HEX.test(c)).slice(0, 6).map((c) => c.toLowerCase()) : []; return l.length >= min ? l : d; };
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : d);
  const lasers = hexes(o.lasers, base.lasers);
  const share = Array.isArray(o.laserShare) ? o.laserShare.slice(0, lasers.length).map((v) => num(v, 0)) : lasers === base.lasers ? base.laserShare : lasers.map(() => 1 / lasers.length);
  while (share.length < lasers.length) share.push(0);
  return { structure: hexes(o.structure, base.structure, 1), beam: hex(o.beam, base.beam), beamShare: num(o.beamShare, base.beamShare), beamGain: typeof o.beamGain === 'number' && Number.isFinite(o.beamGain) ? Math.min(1, Math.max(0.1, o.beamGain)) : base.beamGain, lasers, laserShare: share,
    blinder: hex(o.blinder, base.blinder), strobe: hex(o.strobe, base.strobe), crowd: hex(o.crowd, base.crowd), quiet: hex(o.quiet, base.quiet) };
}

/** a roles object's colours parsed once (sRGB 0..1) */
interface Parsed { structure: RGB[]; beam: RGB; lasers: RGB[]; share: number[]; blinder: RGB; strobe: RGB; crowd: RGB; quiet: RGB; seed: number }
const PARSED = new WeakMap<ColorRoles, Parsed>();
function parsed(r: ColorRoles): Parsed {
  let p = PARSED.get(r);
  if (!p) {
    const tot = r.laserShare.reduce((a, b) => a + b, 0) || 1;
    p = { structure: (r.structure.length ? r.structure : MAINSTAGE_ROLES.structure).map(hexRgb), beam: hexRgb(r.beam).map((c) => c * (r.beamGain ?? 1)) as RGB, lasers: r.lasers.map(hexRgb), share: r.laserShare.map((s) => s / tot), blinder: hexRgb(r.blinder), strobe: hexRgb(r.strobe), crowd: hexRgb(r.crowd), quiet: hexRgb(r.quiet), seed: hashStr(r.structure.join('') + r.beam) % 9973 };
    PARSED.set(r, p);
  }
  return p;
}

/** The roles at one musical moment (built once per frame, shared by every fixture). Colours sRGB 0..1. */
export interface RoleFrame {
  roles: ColorRoles;
  /** the phrase step (changes every 8 bars and on drops) and how far the 2-beat ease into it is (0..1) */
  step: number; ease: number;
  /** beams take the beam colour by this much (0..1, eased across a phrase change) */
  beamWhite: number;
  /** the show layer takes the quiet colour by this much (breakdowns) and bleaches toward white by this much (builds) */
  quiet: number; bleach: number;
  /** this phrase's laser colour (eased), the crowd wash, blinders, strobes, beams, the quiet colour */
  laser: RGB; crowd: RGB; blinder: RGB; strobe: RGB; beam: RGB; quietC: RGB;
}
export const newRoleFrame = (r: ColorRoles = MAINSTAGE_ROLES): RoleFrame => ({ roles: r, step: 0, ease: 1, beamWhite: 0, quiet: 0, bleach: 0, laser: [0, 1, 0], crowd: [0, 0, 1], blinder: [1, 0.7, 0.4], strobe: [1, 1, 1], beam: [1, 1, 1], quietC: [0, 0, 1] });

/** what roleFrame reads of the music + the director */
export interface RoleMoment { beat: number; bar: number; barPos: number; dropCount: number; lastDrop: number; sectionStart: number; section: Sec; build: number }

const isPeak = (s: Sec) => s === 'drop' || s === 'build';
/** does this phrase play white beams (seeded per phrase + roles: every page agrees) */
export function beamWhiteAt(r: ColorRoles, step: number, sec: Sec): number {
  const p = parsed(r);
  if (sec === 'breakdown') return 0;
  if (sec === 'intro' || sec === 'outro') return 1;                        // (parked white beams over a warm set)
  const share = isPeak(sec) ? r.beamShare : r.beamShare * 0.5;
  return hash3(step, p.seed, 11) < share ? 1 : 0;
}
/** this phrase's laser colour index (weighted, seeded) */
export function laserIndexAt(r: ColorRoles, step: number): number {
  const p = parsed(r), u = hash3(step, p.seed, 23);
  let acc = 0;
  for (let i = 0; i < p.share.length; i++) { acc += p.share[i]; if (u < acc) return i; }
  return p.share.length - 1;
}
const mixInto = (out: RGB, a: RGB, b: RGB, w: number) => { out[0] = a[0] + (b[0] - a[0]) * w; out[1] = a[1] + (b[1] - a[1]) * w; out[2] = a[2] + (b[2] - a[2]) * w; return out; };
const ease2 = (x: number) => { const t = clamp01(x); return t * t * (3 - 2 * t); };

/** Fill `out` for this moment. The phrase step is the LookFrame's (floor(bar / 8) + drops); a change eases over 2 beats. */
export function roleFrame(r: ColorRoles, m: RoleMoment, out: RoleFrame): RoleFrame {
  const p = parsed(r);
  out.roles = r;
  // beats since the phrase step changed: the 8-bar line (bar-phase grid) or the drop, whichever came last
  const { step, ease: e } = phraseEase(m);
  out.step = step; out.ease = e;
  const bw = beamWhiteAt(r, step, m.section), bw0 = beamWhiteAt(r, step - 1, m.section);
  out.beamWhite = bw0 + (bw - bw0) * e;
  const li = laserIndexAt(r, step), l0 = laserIndexAt(r, step - 1);
  mixInto(out.laser, p.lasers[l0] ?? p.lasers[0], p.lasers[li] ?? p.lasers[0], e);
  // the quiet colour eases in over the first bar of a breakdown (and out over the first 2 beats after it)
  const sinceSec = Math.max(0, m.beat - m.sectionStart);
  out.quiet = m.section === 'breakdown' ? ease2(sinceSec / 4) : 0;
  out.bleach = m.section === 'build' ? clamp01(m.build) ** 2 * 0.6 : 0;
  out.crowd[0] = p.crowd[0]; out.crowd[1] = p.crowd[1]; out.crowd[2] = p.crowd[2];
  out.blinder[0] = p.blinder[0]; out.blinder[1] = p.blinder[1]; out.blinder[2] = p.blinder[2];
  out.strobe[0] = p.strobe[0]; out.strobe[1] = p.strobe[1]; out.strobe[2] = p.strobe[2];
  out.beam[0] = p.beam[0]; out.beam[1] = p.beam[1]; out.beam[2] = p.beam[2];
  out.quietC[0] = p.quiet[0]; out.quietC[1] = p.quiet[1]; out.quietC[2] = p.quiet[2];
  return out;
}

const S1: RGB = [0, 0, 0], S2: RGB = [0, 0, 0];
/** A structure colour (sRGB) from any colour list: `o` 0..1 across the rig (0 = the centre, 1 = the outer edge: the
 *  caller mirrors), the list spread across it, rotated one colour per phrase `step`, eased from the last step by `ease`. */
function spreadAt(c: readonly (readonly number[])[], k: number, o: number, st: number, dst: RGB): RGB {
  const t = clamp01(o) * (k - 1) + st, i0 = Math.floor(t), w = t - i0;
  const A = c[((i0 % k) + k) % k], B = c[(((i0 + 1) % k) + k) % k];
  dst[0] = A[0] + (B[0] - A[0]) * w; dst[1] = A[1] + (B[1] - A[1]) * w; dst[2] = A[2] + (B[2] - A[2]) * w;
  return dst;
}
export function spreadStepColor(c: readonly (readonly number[])[], step: number, ease: number, o: number, out: RGB): RGB {
  const k = c.length;
  if (!k) { out[0] = out[1] = out[2] = 1; return out; }
  spreadAt(c, k, o, step, S1);
  if (ease < 1) { spreadAt(c, k, o, step - 1, S2); return mixInto(out, S2, S1, ease); }
  out[0] = S1[0]; out[1] = S1[1]; out[2] = S1[2];
  return out;
}
/** the structure colour (sRGB) under the roles at a place across the rig (`o`: 0 = the centre, 1 = the outer edge) */
export function structureColor(rf: RoleFrame, o: number, out: RGB): RGB { return spreadStepColor(parsed(rf.roles).structure, rf.step, rf.ease, o, out); }
/** the phrase step + its 2-beat ease for a music moment (no roles needed: the structure layer of any show) */
export function phraseEase(m: Pick<RoleMoment, 'beat' | 'bar' | 'barPos' | 'dropCount' | 'lastDrop'>): { step: number; ease: number } {
  const intoPhrase = ((((m.bar % 8) + 8) % 8) * 4) + Math.max(0, Math.min(3.999, m.barPos));
  const dropAge = Number.isFinite(m.lastDrop) ? m.beat - m.lastDrop : Infinity;
  PE.step = Math.floor(m.bar / 8) + Math.max(0, m.dropCount); PE.ease = ease2(Math.min(intoPhrase, dropAge >= 0 ? dropAge : Infinity) / 2);
  return PE;
}
const PE = { step: 0, ease: 1 };

/** A moving head's colour under the roles: beams white in their phrases, the show layer deep in the quiet parts, a
 *  build bleaching toward white. `rgb` = the look's colour (sRGB, in / out). */
export function roleMover(kind: 'beam' | 'spot' | 'wash', rf: RoleFrame, rgb: RGB): RGB {
  if (kind === 'beam' && rf.beamWhite > 0) mixInto(rgb, rgb, rf.beam, rf.beamWhite);
  if (rf.bleach > 0) mixInto(rgb, rgb, rf.beam, rf.bleach);
  // (the beams keep a little of their warmth in the quiet colour - a deep blue rig of cones reads as nothing in the haze)
  if (rf.quiet > 0) mixInto(rgb, rgb, rf.quietC, kind === 'beam' ? rf.quiet * 0.7 : rf.quiet);
  // (a beam is never a SATURATED red: a rig of deep-red cones sweeping the sky is WCAG red-flash content the governors
  //  can't see - they see each beam's level, never the sweep - so a red phrase's beams play red-orange / amber; the set's
  //  deep red stays on the structure)
  if (kind === 'beam') notSatRed(rgb);
  // (beams in any colour are no brighter than the role's white beam: a gold phrase of a whole rig of cones sweeping the
  //  sky - half a pyro wide's frame - must not out-shine the white ones; luminance-capped, the hue kept)
  if (kind === 'beam') { const cap = relLumS(rf.beam), l = relLumS(rgb); if (l > cap && l > 1e-6) { const k = Math.pow(cap / l, 1 / 2.2); rgb[0] *= k; rgb[1] *= k; rgb[2] *= k; } }
  return rgb;
}
const linS = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const srgbS = (l: number) => (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
/** the most red a beam's linear R may be of R + G + B (WCAG's saturated red starts at 0.8) */
export const BEAM_RED_MAX = 0.76;
/** pull a saturated red toward orange in place (more green, linear) until R is BEAM_RED_MAX of R + G + B */
export function notSatRed(rgb: RGB): RGB {
  const r = linS(rgb[0]), g = linS(rgb[1]), b = linS(rgb[2]), s = r + g + b;
  if (s > 1e-5 && r / s > BEAM_RED_MAX) rgb[1] = Math.min(1, srgbS(r / BEAM_RED_MAX - r - b));
  return rgb;
}
/** relative luminance of an sRGB colour */
export const relLumS = (c: readonly number[]) => 0.2126 * linS(c[0]) + 0.7152 * linS(c[1]) + 0.0722 * linS(c[2]);
/** a show-layer PAR / wash light under the roles (the quiet colour in breakdowns) */
export function roleFlat(rf: RoleFrame, rgb: RGB): RGB {
  if (rf.quiet > 0) mixInto(rgb, rgb, rf.quietC, rf.quiet);
  return rgb;
}

// ---------------------------------------------------------------------------------------------------- structure
/** scene.json `festival.structure` (or the house preset): the set's outline as its own layer. */
export interface StructureCfg {
  /** the level it never goes under (share of the show level), blackouts included */
  floor: number;
  /** the level in intros / outros (a breakdown sits a little under it) */
  intro: number;
  /** the kick pulse's depth (0 = steady; never more than 0.15: the beats belong to the show layer) */
  pulse: number;
  /** anchor groups (pixel bars / PARs) that are structure; null = every pixel bar */
  groups: string[] | null;
  /** the stage wash on the set's materials (festival.wash) is structure too: keeps its floor in blackouts */
  wash: boolean;
}
export const DEFAULT_STRUCTURE: StructureCfg = { floor: 0.07, intro: 0.35, pulse: 0.15, groups: null, wash: true };
const GROUP = /^[A-Z][A-Z0-9]{0,15}$/;
export function sanitizeStructure(raw: unknown): StructureCfg | null {
  if (raw === true) return { ...DEFAULT_STRUCTURE };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const n = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const groups = Array.isArray(o.groups) ? o.groups.filter((g): g is string => typeof g === 'string' && GROUP.test(g)).slice(0, 24) : null;
  return { floor: n(o.floor, 0, 0.3, DEFAULT_STRUCTURE.floor), intro: n(o.intro, 0.05, 1, DEFAULT_STRUCTURE.intro), pulse: n(o.pulse, 0, 0.15, DEFAULT_STRUCTURE.pulse), groups: groups && groups.length ? groups : null, wash: o.wash !== false };
}

/** the structure's level for a song section (before the pulse, the show's own level and blackouts) */
export function structureTarget(st: StructureCfg, sec: Sec, build: number): number {
  switch (sec) {
    case 'intro': case 'outro': return st.intro;
    case 'breakdown': return st.intro * 0.85;
    case 'groove': return Math.max(st.intro, 0.6);
    case 'build': return Math.max(st.intro, 0.55 + 0.3 * clamp01(build));
    case 'drop': return 0.9;
  }
  return st.intro;
}
/** The structure's drawn level: the section target (already eased by the caller), a shallow pulse (`pulse` 0..1: the
 *  kick envelope, or a slow breath with Safe flashes ON), the show's own level (`show`: an endshow part's master; 0 in a
 *  blackout) - and the floor, which no blackout takes away. Multiplied by the stage level outside. */
export function structureLevel(st: StructureCfg, target: number, pulse: number, show: number): number {
  const p = Math.min(0.15, st.pulse);
  const v = target * (1 - p + p * clamp01(pulse)) * Math.max(0, show);
  return Math.max(st.floor, v);
}
