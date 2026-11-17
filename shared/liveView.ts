// Live Control view choices (beta.12 UX, owner feedback 2026-10-06), pure so tools/show_dock_unit.ts can test them:
//   * the studio view (PROGRAM) size: 'small' by default (it drew a big second picture most people never look at),
//     'large' = the old console, 'hidden' = not drawn at all (OBS keeps its own picture; tracking is unaffected);
//   * which Live sections are folded (remembered per section; the pickers you rarely change start folded);
//   * room favourites first in a room list (the list itself is the helper's: src/net/roomPrefs.ts).
// No DOM, no storage here: the callers read / write localStorage inside try / catch.

export type PgmSize = 'hidden' | 'small' | 'large';
export const PGM_KEY = 'vtp.live.pgm';
export const PGM_SIZES: { id: PgmSize; label: string; hint: string }[] = [
  { id: 'hidden', label: 'Hide', hint: 'Not drawn at all: saves your graphics card. OBS and tracking keep running.' },
  { id: 'small', label: 'Small', hint: 'A small picture of your avatar (the default)' },
  { id: 'large', label: 'Large', hint: 'The big picture, as before' },
];
/** A stored value (any junk) → a size. Missing = small. */
export function parsePgmSize(v: unknown): PgmSize {
  return v === 'hidden' || v === 'large' || v === 'small' ? v : 'small';
}

// ---------------------------------------------------------------- folded sections
export const FOLD_KEY = 'vtp.live.folds';
/** Open unless remembered otherwise: the everyday ones. Pickers you set once start folded. */
export const FOLD_DEFAULTS: Record<string, boolean> = {
  'me-outfits': true, 'me-emotes': true,
  'cover-styles': false, 'brb-styles': false,
  'tr-rooms': false, 'tr-camera': true, 'tr-obs': false,
};
/** Stored folds (any junk) → { key: open }. Only known-looking keys, booleans only. */
export function parseFolds(v: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 64)) if (/^[a-z][a-z0-9-]{0,31}$/.test(k) && typeof x === 'boolean') out[k] = x;
  return out;
}
export const foldOpen = (folds: Record<string, boolean>, key: string): boolean => folds[key] ?? FOLD_DEFAULTS[key] ?? true;

// ---------------------------------------------------------------- room favourites (the list itself: src/net/roomPrefs.ts)
/** Rooms with the favourites first (in favourite order), the rest in their own order. `only` = favourites alone. */
export function favFirst<T extends { id: string }>(rooms: readonly T[], favs: readonly string[], only = false): T[] {
  const fav = favs.map((id) => rooms.find((r) => r.id === id)).filter((r): r is T => !!r);
  return only ? fav : [...fav, ...rooms.filter((r) => !favs.includes(r.id))];
}
