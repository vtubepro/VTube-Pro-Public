// Occupant class (docs/SCENES.md -> "Room forms"; creations/desert_walker/SPEC.md 2.2): WHAT stands or sits at a spot,
// from the performer's profile only (no page needs the model loaded): real size (shared/avatarSize.ts), body plan
// (profile.body / profile.mech / profile.vehicle) and, for mechs, the mech config's pilot-scale rule + footprint. Room
// forms (shared/forms.ts) pick the desk / dock / pad variant of a zone from it, and the big-entrance mover
// (src/scene/forms/bigEntrance.ts) decides who gets the iris / lift / crane / power-up entrance.
//
//   cls       from
//   micro     size class micro                       (< 0.6 m: fairies, pets)
//   small     size class small                       (0.6 - 1.3 m: chibis, kids)
//   human     size class normal (and every auto size: an ordinary 1.7 m human, exactly as before)
//   large     size class large                       (2.1 - 2.6 m: ogres)
//   giant     size class macro, not a mech / vehicle (> 2.6 m: giants, kaiju)
//   mech      body 'mech' (or a profile.mech config) whose SHOWN footprint >= rules.mechMinFootprint (1.4 m) or whose
//             size class >= rules.mechMin (large). SPEC D8: eligibility comes from kind + footprint, not height - the
//             Desert Star Walker is 1.91 m tall (size class normal) but 2.40 m wide.
//   vehicle   the same for body 'vehicle' / a profile.vehicle config
//
// Shown size (SPEC 2.2 scale rule): a mech with `mech.pilotHeight` is scaled so its pilot is normalised like a human:
// scale = base x heroScale / pilotHeight; shown height = real height x scale. Everyone else: avatarSize.shownHeight.
// `big` (SPEC 2.2) = a mech / vehicle with a footprint >= mechMinFootprint, or size class macro (a room's bigEntrance
// can widen it with its door width: usesBigEntrance in shared/forms.ts).
// Pure data + maths: the studio controller (host stamps), every OBS page, the party wire and Node tests use it.
import { SIZE_CLASSES, avatarSize, isSizeClass, shownHeight, sizeClassOf, spotFit, type AvatarSize, type SizeClass } from './avatarSize.ts';

export type OccupantKind = 'biped' | 'quadruped' | 'mech' | 'vehicle' | 'tv';
export const OCCUPANT_KINDS: readonly OccupantKind[] = ['biped', 'quadruped', 'mech', 'vehicle', 'tv'];
export type OccupantClass = 'micro' | 'small' | 'human' | 'large' | 'giant' | 'mech' | 'vehicle';
/** Smallest to biggest (a zone with several occupants is shaped for the biggest: occupantRank). */
export const OCCUPANT_CLASSES: readonly OccupantClass[] = ['micro', 'small', 'human', 'large', 'giant', 'mech', 'vehicle'];

export interface Occupant {
  cls: OccupantClass;
  /** The size class behind it (shared/avatarSize.ts; the SPEC's `cls`). */
  size: SizeClass;
  kind: OccupantKind;
  /** Real height (m): the profile's, the measured one (mechs without a typed size), else the 1.7 m default. */
  height: number;
  /** true = nobody set a size (an ordinary human). */
  auto: boolean;
  /** Shown standing height in a room whose normal performers are `base` metres (room metres). */
  shown: number;
  /** Shown footprint (the wider of width / depth, room metres): a mech's from its config, else estimated. */
  footprint: number;
  /** A mech pilot's eye height above the floor, shown (room metres), when the mech config says. */
  pilotEye?: number;
  /** A mech's foot contacts' distances from its centre, shown (room metres): docking clamps travel to them. */
  contactR?: number[];
  /** Big-entrance / dock eligibility (SPEC 2.2). */
  big: boolean;
}

/** scene.json `occupants`: how a room classes its performers. */
export interface OccupantRules {
  /** Smallest size class whose mech / vehicle counts as a mech whatever its footprint. */
  mechMin: SizeClass;
  /** Body kinds that count as mechs (a room may treat vehicles as mechs, or quadrupeds as giants: kindsAsMech). */
  kindsAsMech: OccupantKind[];
  /** A mech / vehicle with a shown footprint at least this wide (m) is a mech (SPEC D8). */
  mechMinFootprint: number;
}
export const DEFAULT_OCCUPANT_RULES: OccupantRules = { mechMin: 'large', kindsAsMech: ['mech', 'vehicle'], mechMinFootprint: 1.4 };

export const isOccupantClass = (v: unknown): v is OccupantClass => typeof v === 'string' && (OCCUPANT_CLASSES as readonly string[]).includes(v);
export const isOccupantKind = (v: unknown): v is OccupantKind => typeof v === 'string' && (OCCUPANT_KINDS as readonly string[]).includes(v);

/** scene.json `occupants` -> clean rules (missing / bad fields = the defaults). */
export function sanitizeOccupantRules(v: unknown): OccupantRules {
  const x = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const kinds = Array.isArray(x.kindsAsMech) ? [...new Set(x.kindsAsMech.filter(isOccupantKind))] : null;
  const fp = typeof x.mechMinFootprint === 'number' && Number.isFinite(x.mechMinFootprint) ? Math.min(20, Math.max(0.2, x.mechMinFootprint)) : DEFAULT_OCCUPANT_RULES.mechMinFootprint;
  return {
    mechMin: isSizeClass(x.mechMin) ? x.mechMin : DEFAULT_OCCUPANT_RULES.mechMin,
    kindsAsMech: kinds && kinds.length ? kinds : [...DEFAULT_OCCUPANT_RULES.kindsAsMech],
    mechMinFootprint: fp,
  };
}

/** The body plan of a profile (or a party guest's shared profile, or a TV performer). Unknown / missing = biped. */
export function occupantKind(p: unknown): OccupantKind {
  const x = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  if (x.body === 'mech' || x.body === 'vehicle') return x.body;
  // the mech lane's MechConfig / a vehicle config on the profile mark it even when `body` was dropped on the way
  if (x.mech && typeof x.mech === 'object') return 'mech';
  if (x.vehicle && typeof x.vehicle === 'object') return 'vehicle';
  if (x.body === 'quadruped') return 'quadruped';
  // walking-TV performers (src/scene/tv): their stand-in profile has modelFile 'tv'
  return x.modelFile === 'tv' || x.kind === 'tv' ? 'tv' : 'biped';
}

const rank = (c: SizeClass) => SIZE_CLASSES.indexOf(c);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The mech config fields the occupant class reads (SPEC 2.2 MechConfig; profile.mech or profile.vehicle). */
function mechOf(p: unknown): { pilotHeight: number | null; pilotEye: number | null; heroScale: number; footprint: number | null; contacts: number[] } | null {
  const x = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const m = (x.mech && typeof x.mech === 'object' ? x.mech : x.vehicle && typeof x.vehicle === 'object' ? x.vehicle : null) as Record<string, unknown> | null;
  if (!m) return null;
  const fp = (m.footprint && typeof m.footprint === 'object' ? m.footprint : {}) as Record<string, unknown>;
  const w = num(fp.w), d = num(fp.d);
  const contacts: number[] = [];
  for (const l of Array.isArray(m.legs) ? m.legs.slice(0, 8) : []) {
    const c = (l && typeof l === 'object' ? (l as Record<string, unknown>).contact : null) as unknown;
    if (Array.isArray(c) && c.length === 3 && c.every((v) => typeof v === 'number' && Number.isFinite(v))) contacts.push(Math.hypot(c[0] as number, c[2] as number));
  }
  const ph = num(m.pilotHeight);
  return {
    pilotHeight: ph && ph > 0.2 && ph < 5 ? ph : null,
    pilotEye: num(m.pilotEye),
    heroScale: Math.min(2, Math.max(1, num(m.heroScale) ?? 1)),
    footprint: w !== null || d !== null ? Math.max(w ?? 0, d ?? 0) : null,
    contacts,
  };
}

/** Occupant of a profile. `measured` = the model's own height in metres (readNative), used only for a mech / vehicle
 *  with no typed real size; `base` = the room's normal-performer height (avatarHeight x avatarScale). */
export function occupantOf(p: unknown, rules: OccupantRules = DEFAULT_OCCUPANT_RULES, measured?: number, base = 1.5): Occupant {
  const kind = occupantKind(p);
  let size: AvatarSize = avatarSize(p as { size?: unknown } | null);
  const mechy = kind === 'mech' || kind === 'vehicle';
  if (size.auto && mechy && typeof measured === 'number' && Number.isFinite(measured) && measured > 0.05 && measured < 100) {
    size = { height: Math.round(measured * 1000) / 1000, cls: sizeClassOf(measured), auto: false };
  }
  const m = mechy ? mechOf(p) : null;
  // the SPEC 2.2 scale rule: a piloted mech is scaled so its pilot stands like a human performer
  const k = m?.pilotHeight ? (base * m.heroScale) / m.pilotHeight : (shownHeight(size, base) / Math.max(0.01, size.height));
  const shown = m?.pilotHeight ? size.height * k : shownHeight(size, base);
  // (no footprint in the config: a humanoid estimate, so a human-sized mech suit stays human-sized; the size class rule
  //  still makes a big one a mech)
  const footprint = m?.footprint != null ? m.footprint * k : kind === 'quadruped' ? shown * 0.9 : shown * 0.45;
  const isMech = rules.kindsAsMech.includes(kind) && (footprint >= rules.mechMinFootprint || rank(size.cls) >= rank(rules.mechMin));
  let cls: OccupantClass = size.cls === 'normal' ? 'human' : size.cls === 'macro' ? 'giant' : size.cls;
  if (isMech) cls = kind === 'vehicle' ? 'vehicle' : 'mech';
  const out: Occupant = {
    cls, size: size.cls, kind, height: size.height, auto: size.auto,
    shown: Math.round(shown * 1000) / 1000, footprint: Math.round(footprint * 1000) / 1000,
    big: isMech || size.cls === 'macro',
  };
  if (m?.pilotEye != null) out.pilotEye = Math.round(m.pilotEye * k * 1000) / 1000;
  if (m?.contacts.length) out.contactR = m.contacts.map((r) => Math.round(r * k * 1000) / 1000);
  return out;
}

/** Sort key: smallest first (micro 0 ... vehicle 6). */
export const occupantRank = (o: Pick<Occupant, 'cls'>) => OCCUPANT_CLASSES.indexOf(o.cls);

/** The biggest of several occupants (the one a zone is shaped for); null = none. */
export function biggestOccupant<T extends Pick<Occupant, 'cls' | 'height'>>(list: readonly T[]): T | null {
  let best: T | null = null;
  for (const o of list) if (!best || occupantRank(o) > occupantRank(best) || (occupantRank(o) === occupantRank(best) && o.height > best.height)) best = o;
  return best;
}

/** Mechs and vehicles: hulls with a pilot (docking cradles, landing pads, cockpit framing). */
export const isMechClass = (c: OccupantClass) => c === 'mech' || c === 'vehicle';

/** Short label for the Live panel / logs. */
export const OCCUPANT_LABEL: Record<OccupantClass, string> = {
  micro: 'Micro', small: 'Small', human: 'Human', large: 'Large', giant: 'Giant', mech: 'Mech', vehicle: 'Vehicle',
};

// ---------------------------------------------------------------- seat routing by body kind (SPEC 6.1 C1)
/** GLB extras / scene.json `kinds` (`spotKinds`) -> clean body kinds; null = any kind (an ordinary spot). */
export function parseKinds(v: unknown): OccupantKind[] | null {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : null;
  if (!arr) return null;
  const out = [...new Set(arr.map((x) => String(x).trim().toLowerCase()).filter(isOccupantKind))];
  return out.length ? out : null;
}
/** A spot as the seat rules see it (a SpotInfo, a RoomSummary spot, a SeatSpot): its size classes, body kinds, pose. */
export interface OccSpot { index: number; sizes?: readonly SizeClass[] | null; kinds?: readonly OccupantKind[] | null; pose?: 'sit' | 'stand' }
/** Rule (1)'s question, answered by the room's forms (shared/forms.ts zoneConverts): does the forms zone this spot is in
 *  have a form made for this occupant (the zone converts for them: a docking cradle at the host desk, a landing pad)? */
export type ZoneConverts = (index: number, occ: Occupant) => boolean;
/** How well a spot suits an occupant (SPEC 6.1 C1): 2 = made for them, 1 = a usable fallback, 0 = never.
 *  (1) a spot in a forms zone that converts for them: 2;
 *  (2) a spot with `kinds`: 0 for any other body kind; a listed mech / vehicle: 2 (a hull is not a size class - the
 *      Desert Star Walker is 'normal' tall but 2.4 m wide); a listed biped / quadruped / tv: on to the size rule (a giant's
 *      back-row spot `sizes: ["macro"], kinds: [..., "biped"]` still never takes an ordinary human);
 *  (3) the size-class rule (shared/avatarSize.ts spotFit), except that a big mech / vehicle only ever falls back (1) to
 *      a spot not made for it (it stands at a seat): like a macro giant at an ordinary spot, it takes a dock / pad /
 *      spot listing its kind first (SPEC M6: a mech guest skips the couch and goes to the pad).
 *  An ordinary performer at a spot without `kinds` in a room without forms scores exactly spotFit(sizes, size class). */
export function spotFitOcc(spot: OccSpot, occ: Occupant, converts?: ZoneConverts | null): 0 | 1 | 2 {
  const mechy = occ.kind === 'mech' || occ.kind === 'vehicle';
  if (converts?.(spot.index, occ)) return 2;
  if (spot.kinds && spot.kinds.length) {
    if (!spot.kinds.includes(occ.kind)) return 0;
    if (mechy) return 2;
  }
  const f = spotFit(spot.sizes, occ.size);
  return occ.big && mechy && f > 1 ? 1 : f;
}
/** shared/avatarSize.ts pickSpot by occupant: the best free spot (fit 2 first, lowest index; then fit 1); `prefer` wins
 *  when it fits as well. -1 = none. */
export function pickSpotOcc(spots: readonly (OccSpot | null | undefined)[], occ: Occupant, taken: ReadonlySet<number>, prefer = -1, converts?: ZoneConverts | null): number {
  const ok = (s: OccSpot | null | undefined): s is OccSpot => !!s && !taken.has(s.index);
  const pf = spots.find((s) => s && s.index === prefer);
  for (const want of [2, 1] as const) {
    if (ok(pf) && spotFitOcc(pf, occ, converts) === want) return pf.index;
    const s = spots.find((x) => ok(x) && spotFitOcc(x, occ, converts) === want);
    if (s) return s.index;
  }
  return -1;
}
