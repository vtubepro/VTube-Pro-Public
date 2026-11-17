// Room editor storage (docs/ROOM_EDITOR.md): the per-user override layer of each room lives in
// <data>/room-edits/<room id>.json — never in the room's own folder, so shipped rooms, rooms an update replaces and the
// owner's hand-authored scene.json stay byte-for-byte as they are; "Reset" deletes the file (a copy is kept as
// <id>.reset.json); named layouts (presets) live in <data>/room-edits/<id>/presets/<slug>.json. Node built-ins + shared/* only (server/roomList.ts reads it when it lists rooms).
// VTP_ROOM_EDITS_DIR overrides the folder (tests).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ROOM_ID } from '../shared/roomId.ts';
import { LIMITS, checkRoomEdits, editsEmpty, type RoomEdits } from '../shared/roomEdits.ts';
import { LAYOUT_LIMITS, LAYOUT_SCHEMA, LAYOUT_SLUG, layoutInfo, layoutSlug, readLayout, sortLayouts, type LayoutInfo, type RoomLayout } from '../shared/roomLayouts.ts';
import { DATA_DIR } from './paths.ts';

export const EDITS_DIR = process.env.VTP_ROOM_EDITS_DIR || path.join(DATA_DIR, 'room-edits');

const fileOf = (id: string) => {
  if (!ROOM_ID.test(id)) throw new Error('bad room id');
  return path.join(EDITS_DIR, `${id}.json`);
};

/** The saved layer of a room id (sanitised; null = none / unreadable). Never throws. */
export async function readEdits(id: string): Promise<RoomEdits | null> {
  if (!ROOM_ID.test(id)) return null;
  try {
    const text = await fsp.readFile(fileOf(id), 'utf8');
    if (text.length > LIMITS.bytes) return null;
    const { edits } = checkRoomEdits(JSON.parse(text), { room: id });
    return editsEmpty(edits) ? null : edits;
  } catch { return null; }
}
export function readEditsSync(id: string): RoomEdits | null {
  if (!ROOM_ID.test(id)) return null;
  try {
    const text = fs.readFileSync(fileOf(id), 'utf8');
    if (text.length > LIMITS.bytes) return null;
    const { edits } = checkRoomEdits(JSON.parse(text), { room: id });
    return editsEmpty(edits) ? null : edits;
  } catch { return null; }
}

/** Write a layer (already validated): a temp file + rename, so a crash never leaves half a file. Returns what was saved
 *  (rev = the previous rev + 1, savedAt = now). An empty layer removes the file. */
export async function writeEdits(id: string, e: RoomEdits): Promise<RoomEdits | null> {
  const file = fileOf(id);
  const prev = await readEdits(id);
  if (editsEmpty(e)) { await removeEdits(id); return null; }
  const next: RoomEdits = { ...e, room: id, rev: Math.max(prev?.rev ?? 0, e.rev ?? 0) + 1, savedAt: new Date().toISOString() };
  const text = JSON.stringify(next, null, 1);
  if (text.length > LIMITS.bytes) throw new Error(`Too many changes for one room (${Math.round(text.length / 1024)} KB, at most ${LIMITS.bytes / 1024} KB).`);
  await fsp.mkdir(EDITS_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
  return next;
}

/** Remove a room's layer (Reset). The last one is kept as <id>.reset.json. Returns whether there was one. */
export async function removeEdits(id: string): Promise<boolean> {
  const file = fileOf(id);
  try { await fsp.access(file); } catch { return false; }
  await fsp.copyFile(file, file.replace(/\.json$/, '.reset.json')).catch(() => {});
  await fsp.rm(file, { force: true });
  return true;
}

// ---------------------------------------------------------------- layouts (named presets, shared/roomLayouts.ts)
// <data>/room-edits/<room id>/presets/<slug>.json — one file per layout, written like the layer (temp file + rename).
const layoutDir = (id: string) => {
  if (!ROOM_ID.test(id)) throw new Error('bad room id');
  return path.join(EDITS_DIR, id, 'presets');
};
const layoutFile = (id: string, slug: string) => {
  if (!LAYOUT_SLUG.test(slug)) throw new Error('bad layout name');
  return path.join(layoutDir(id), `${slug}.json`);
};

/** One layout (null = none / unreadable). Never throws. */
export async function readLayoutFile(id: string, slug: string): Promise<RoomLayout | null> {
  try {
    const text = await fsp.readFile(layoutFile(id, slug), 'utf8');
    if (text.length > LIMITS.bytes + 4096) return null;
    return readLayout(JSON.parse(text), id, slug);
  } catch { return null; }
}

/** Every layout of a room, newest first. */
export async function listLayouts(id: string): Promise<LayoutInfo[]> {
  if (!ROOM_ID.test(id)) return [];
  const names = await fsp.readdir(layoutDir(id)).catch(() => [] as string[]);
  const out: LayoutInfo[] = [];
  for (const f of names) {
    const m = /^(.+)\.json$/.exec(f);
    if (!m || !LAYOUT_SLUG.test(m[1])) continue;
    const l = await readLayoutFile(id, m[1]);
    if (l) out.push(layoutInfo(l));
  }
  return sortLayouts(out);
}

/** Save a layout: `slug` = overwrite / rename that one, null = a new one (its slug from the name). */
export async function writeLayout(id: string, slug: string | null, name: string, edits: RoomEdits): Promise<RoomLayout> {
  const dir = layoutDir(id);
  let s = slug;
  if (!s) {
    const have = await listLayouts(id);
    if (have.length >= LAYOUT_LIMITS.perRoom) throw new Error(`A room can keep ${LAYOUT_LIMITS.perRoom} layouts. Delete one you don't use first.`);
    s = layoutSlug(name, have.map((l) => l.slug));
  }
  const l: RoomLayout = { schema: LAYOUT_SCHEMA, room: id, slug: s, name, savedAt: new Date().toISOString(), edits };
  const text = JSON.stringify(l, null, 1);
  if (text.length > LIMITS.bytes + 4096) throw new Error(`Too many changes for one layout (${Math.round(text.length / 1024)} KB).`);
  await fsp.mkdir(dir, { recursive: true });
  const file = layoutFile(id, s);
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
  return l;
}

/** Delete a layout. Returns whether there was one. */
export async function removeLayout(id: string, slug: string): Promise<boolean> {
  const file = layoutFile(id, slug);
  try { await fsp.access(file); } catch { return false; }
  await fsp.rm(file, { force: true });
  return true;
}
