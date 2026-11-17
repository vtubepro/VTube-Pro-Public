// Avatar real size + size classes (docs/SCENES.md → "Avatar size classes").
//
// Every avatar has an intended REAL height (metres, AvatarProfile.size.height). Missing = "auto": an ordinary
// human-sized character (1.7 m, class normal) — exactly how every avatar behaved before size classes existed.
// The class comes from the height:
//
//   micro   < 0.6 m          fairies, pets, pocket critters      → table-top / perch spots
//   small   0.6 – 1.3 m      chibis, kids, goblins               → ordinary spots, shown smaller
//   normal  1.3 – 2.1 m      humans (the room's normalisation)   → ordinary spots, all shown at the room's height
//   large   2.1 – 2.6 m      ogres, tall robots                  → ordinary spots, shown taller (clamped to the ceiling)
//   macro   > 2.6 m          giants, mechs, kaiju                → back-of-the-room spots with clearance
//
// In a room, normal-class performers are all normalised to scene.json avatarHeight × state.avatarScale (as before).
// Outside the normal band the displayed height scales from the band's edge, so it is continuous and monotonic:
//   shown = base × h / 1.3 (h < 1.3)      shown = base × h / 2.1 (h > 2.1)      base = avatarHeight × avatarScale
// (a 0.3 m fairy next to 1.5 m humans shows at 0.35 m; a 5 m giant at 3.6 m, then clamped to the spot's clearance).
// Pure data + maths: the studio, the OBS page, the party wire and the Node tests all use it.

import { mechRoomScale } from './mech.ts';

export type SizeClass = 'micro' | 'small' | 'normal' | 'large' | 'macro';
export const SIZE_CLASSES: readonly SizeClass[] = ['micro', 'small', 'normal', 'large', 'macro'];

/** Upper height bound (m) of each class (macro: open ended). */
export const SIZE_BANDS: Record<Exclude<SizeClass, 'macro'>, number> = { micro: 0.6, small: 1.3, normal: 2.1, large: 2.6 };
/** The "auto" real height of an unflagged avatar (an ordinary human). */
export const REF_HUMAN = 1.7;
/** Sane limits for a typed real height (m). */
export const MIN_REAL = 0.03, MAX_REAL = 100;

export const SIZE_LABEL: Record<SizeClass, string> = {
  micro: 'Micro (fairy / pet)', small: 'Small (chibi / kid)', normal: 'Normal (human)', large: 'Large (ogre / tall)', macro: 'Macro (giant)',
};
export const SIZE_ICON: Record<SizeClass, string> = { micro: '🧚', small: '🧒', normal: '🧍', large: '🧌', macro: '🗿' };

/** Stored on AvatarProfile.size. Missing / invalid = auto (1.7 m, normal). */
export interface AvatarSizeConfig {
  /** Intended real-world height of the character, metres. */
  height: number;
}

export interface AvatarSize {
  /** Intended real height (m). */
  height: number;
  cls: SizeClass;
  /** true = nobody set it (an ordinary human, today's normalisation). */
  auto: boolean;
}

export function sizeClassOf(h: number): SizeClass {
  if (!(h > 0)) return 'normal';
  if (h < SIZE_BANDS.micro) return 'micro';
  if (h < SIZE_BANDS.small) return 'small';
  if (h <= SIZE_BANDS.normal) return 'normal';
  if (h <= SIZE_BANDS.large) return 'large';
  return 'macro';
}

export const isSizeClass = (v: unknown): v is SizeClass => typeof v === 'string' && (SIZE_CLASSES as readonly string[]).includes(v);

/** Profile field → a clean config (or undefined = auto). Used by the server, the party wire and the UI. */
export function sanitizeSize(v: unknown): AvatarSizeConfig | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const h = (v as { height?: unknown }).height;
  if (typeof h !== 'number' || !Number.isFinite(h) || h < MIN_REAL || h > MAX_REAL) return undefined;
  return { height: Math.round(h * 1000) / 1000 };
}

/** The size of an avatar profile (or a party guest's shared profile). */
export function avatarSize(p: { size?: unknown } | null | undefined): AvatarSize {
  const s = sanitizeSize(p?.size);
  if (!s) return { height: REF_HUMAN, cls: 'normal', auto: true };
  return { height: s.height, cls: sizeClassOf(s.height), auto: false };
}

/** Displayed standing height (room metres) for a performer of real height `h` in a room whose normal performers
 *  are `base` metres (avatarHeight × avatarScale). Normal band → base; outside it, scaled from the band's edge. */
export function shownHeight(size: AvatarSize, base: number): number {
  const h = size.height;
  if (size.auto || size.cls === 'normal') return base;
  const k = h < SIZE_BANDS.small ? h / SIZE_BANDS.small : h / SIZE_BANDS.normal;
  return Math.min(80, Math.max(0.04, base * k));
}

/** Walking machines (desert_walker SPEC §2.2 scale rule): the PILOT is normalised like a human performer, so the machine
 *  shows at its true size around them: room metres per model unit = base × heroScale / mech.pilotHeight (pilotHeight in
 *  the GLB's own units). null = not a mech, or no pilotHeight (the size-class rule above applies). Pass the model's
 *  measured height (its own units) so a claimed pilot can't blow the machine up (shared/mech.ts MECH_RATIO, 80 m cap);
 *  callers apply it only to a model that really built a MechRig, and keep the room's clearance clamp on top. */
export function shownScaleFor(p: { body?: string; mech?: unknown } | null | undefined, base: number, measuredHeight?: number): number | null {
  if (!p || p.body !== 'mech') return null;
  return mechRoomScale(base, p.mech as Parameters<typeof mechRoomScale>[1], measuredHeight);
}

/** A model's own (native) height → what it probably means, for the studio's "measured" hint. Exports in centimetres
 *  (≈170 units) and millimetres are recognised; 10× / 0.1× exports are ambiguous, so they are only flagged.
 *  The room never uses the native height directly (normal avatars are normalised; others use `size.height`). */
export function readNative(native: number): { metres: number; unit: 'm' | 'cm' | 'mm' | '?'; note: string } {
  if (!(native > 0) || !Number.isFinite(native)) return { metres: REF_HUMAN, unit: '?', note: 'could not measure the model' };
  if (native > 300) return { metres: native / 1000, unit: 'mm', note: `${fmtM(native, 0)} units tall — looks like millimetres (${fmtM(native / 1000)})` };
  if (native > 30) return { metres: native / 100, unit: 'cm', note: `${fmtM(native, 0)} units tall — looks like centimetres (${fmtM(native / 100)})` };
  if (native > 4) return { metres: native, unit: '?', note: `${fmtM(native)} tall — a giant, or exported at 10× scale?` };
  if (native < 0.02) return { metres: native * 100, unit: '?', note: `${fmtM(native, 3)} tall — exported at 1/100 scale?` };
  return { metres: native, unit: 'm', note: `${fmtM(native)} tall` };
}

export function fmtM(m: number, digits = 2): string {
  if (!Number.isFinite(m)) return '—';
  if (digits === 0) return `${Math.round(m)}`;
  return m < 1 && digits >= 2 ? `${Math.round(m * 100)} cm` : `${m.toFixed(digits)} m`;
}

// ---------------------------------------------------------------- spot eligibility
/** Parse a spot's `sizes` (GLB extras / scene.json): an array or a comma string of classes; null = not authored. */
export function parseSizes(v: unknown): SizeClass[] | null {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : null;
  if (!arr) return null;
  const out = [...new Set(arr.map((x) => String(x).trim().toLowerCase()).filter(isSizeClass))];
  return out.length ? out : null;
}

/** How well a spot suits a size class: 2 = made for it, 1 = usable fallback (a micro hovers / sits on an ordinary
 *  seat, a macro is clamped to the spot's clearance), 0 = never (a normal person on a fairy's table perch).
 *  `sizes` null = an ordinary authored spot (small / normal / large). */
export function spotFit(sizes: readonly SizeClass[] | null | undefined, cls: SizeClass): 0 | 1 | 2 {
  if (sizes && sizes.length) return sizes.includes(cls) ? 2 : 0;
  return cls === 'micro' || cls === 'macro' ? 1 : 2;
}

export interface SeatSpot { index: number; sizes?: readonly SizeClass[] | null }

/** Best free spot for a class: fit 2 first (lowest index), then fit 1. -1 = none. `prefer` wins when it fits as well. */
export function pickSpot(spots: readonly (SeatSpot | null | undefined)[], cls: SizeClass, taken: ReadonlySet<number>, prefer = -1): number {
  const ok = (s: SeatSpot | null | undefined): s is SeatSpot => !!s && !taken.has(s.index);
  const pf = spots.find((s) => s && s.index === prefer);
  for (const want of [2, 1] as const) {
    if (ok(pf) && spotFit(pf.sizes, cls) === want) return pf.index;
    const s = spots.find((x) => ok(x) && spotFit(x.sizes, cls) === want);
    if (s) return s.index;
  }
  return -1;
}
