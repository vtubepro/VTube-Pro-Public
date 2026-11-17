// Room editor LAYOUTS (named presets) — docs/ROOM_EDITOR.md §2b. Pure TypeScript, shared by the helper's store
// (server/roomEditStore.ts + server/routes/roomEdits.ts), and the editor (src/scene/roomEdit/layouts.ts).
//
// A layout is a saved copy of a room's edit layer under a name the performer picks ("Podcast", "Gaming night"). Loading
// one puts it into the editor (one undo step); Save then uses it like any other change (the on-air question included).
// Layouts never hold the live camera tweaks (those belong to the room, not to a layout).
//
//   { "schema": "vtp-room-layout/1", "room": "vtubepro_studio", "slug": "podcast", "name": "Podcast",
//     "savedAt": "2026-10-11T18:00:00.000Z", "edits": { …a vtp-room-edits/1 layer… } }
import { checkRoomEdits, cloneEdits, editCount, emptyEdits, type EditContext, type RoomEdits } from './roomEdits.ts';

export const LAYOUT_SCHEMA = 'vtp-room-layout/1';
export const LAYOUT_LIMITS = { perRoom: 30, name: 40 };
/** A layout's file / key name: a-z 0-9 -, 1-40 long. */
export const LAYOUT_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export interface RoomLayout { schema: typeof LAYOUT_SCHEMA; room: string; slug: string; name: string; savedAt: string; edits: RoomEdits }
/** What a list of layouts shows (no edits). */
export interface LayoutInfo { slug: string; name: string; savedAt: string; changes: number }

/** A display name: trimmed, single spaces, no control characters, ≤ 40 characters. '' = not a usable name. */
export function layoutName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LAYOUT_LIMITS.name).trim();
}

/** A slug for a name that isn't taken yet ("Gaming night" → "gaming-night", then "gaming-night-2" …). */
export function layoutSlug(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '') || 'layout';
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) { const s = `${base}-${i}`; if (!used.has(s)) return s; }
  return `${base}-${Date.now().toString(36).slice(-5)}`;
}

/** The layer a layout keeps: validated, without the live camera tweaks and the header's rev. */
export function layoutEdits(room: string, raw: unknown): { edits: RoomEdits; errors: string[] } {
  const { edits, errors } = checkRoomEdits(raw ?? emptyEdits(room), { room });
  const e = cloneEdits(edits);
  delete e.camTweaks;
  e.rev = 0; e.savedAt = '';
  return { edits: e, errors };
}

/** A layout body to keep (a save, an imported file — maybe made for another room or another PC): null = not a layer
 *  at all (refused); else the valid subset (no live camera tweaks) and how many entries didn't fit this room and were
 *  left out. `ctx` = what the store knows about the room (the helper: its anchors, bounds, installed props). */
export function trimLayout(room: string, raw: unknown, ctx: EditContext = { room }): { edits: RoomEdits; dropped: number } | null {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) return null;
  const { edits, errors } = checkRoomEdits(raw ?? emptyEdits(room), { ...ctx, room });
  return { edits: layoutEdits(room, edits).edits, dropped: errors.filter((e) => !/^Unknown format/.test(e)).length };
}
/** The plain sentence for what trimLayout left out ('' = nothing). */
export function droppedNote(n: number): string {
  return n <= 0 ? '' : n === 1 ? 'One thing in it doesn\'t fit this room and was left out.' : `${n} things in it don't fit this room and were left out.`;
}

/** A stored layout read back (from a file / localStorage / an imported .json): null when it isn't one. Its edits are
 *  re-validated (a file written by another version loads with what is valid). */
export function readLayout(raw: unknown, room: string, slug?: string): RoomLayout | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const x = raw as Record<string, unknown>;
  if (x.schema !== LAYOUT_SCHEMA) return null;
  const s = typeof slug === 'string' ? slug : typeof x.slug === 'string' ? x.slug : '';
  const name = layoutName(x.name);
  if (!LAYOUT_SLUG.test(s) || !name) return null;
  return { schema: LAYOUT_SCHEMA, room, slug: s, name, savedAt: typeof x.savedAt === 'string' ? x.savedAt.slice(0, 40) : '', edits: layoutEdits(room, x.edits).edits };
}

export const layoutInfo = (l: RoomLayout): LayoutInfo => ({ slug: l.slug, name: l.name, savedAt: l.savedAt, changes: editCount(l.edits) });
/** Newest first. */
export const sortLayouts = (list: LayoutInfo[]) => list.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.name.localeCompare(b.name));
