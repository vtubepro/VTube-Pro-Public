// Room editor on the helper (docs/ROOM_EDITOR.md): the per-user override layer of a room + the placeable prop catalog.
//
//   GET    /api/rooms/:id/edits            → { roomId, edits | null, anchors: {spots, cams, screen, bounds} }
//   PUT    /api/rooms/:id/edits            body { edits, apply?: "now" | "later", live?: "ok" }  (localhost only)
//            validated (finite numbers, ranges, known anchor ids, installed props, inside the room) → 422 {errors};
//            OBS streaming / recording and apply "now" without live "ok" → 409 {live: true} (nothing saved);
//            saved → ONE bus message {type: 'roomEdits', id, rev, apply} (apply "now": the OBS / preview pages showing
//            that room apply it at once, without reloading the room; "later": they only drop their cached room list,
//            the edits show the next time the room loads) → { ok, edits, applied }
//   PUT    /api/rooms/:id/edits/tweak      body { angle, tweak | null }  (localhost only) the live camera quick-adjust of ONE
//            angle (src/ui/cameraTweaks.ts): merged into the saved layer here, applied at once on every page (a deliberate
//            live action: no on-air question; the camera eases there like any camera change) → { ok, tweak }
//   DELETE /api/rooms/:id/edits?apply=now  → Reset (the file is kept as <id>.reset.json), same broadcast rules
//   GET    /api/props                      → { items: PropItem[], kits: [...], budgets }   the Room editor's "Add prop" list
//   GET    /api/props/file/lib/:kit/*      → a file of an assets/library/props kit (CC0)
//   GET    /api/props/file/pack/:pack/*    → a file of an installed prop pack (<data>/props/<pack>/)
//   …/api/rooms/:id/presets[/:slug]         named layouts (presets) of a room: list, read, save, rename, delete (below)
//
// The room's own files are never written. The edits live in <data>/room-edits/ (server/roomEditStore.ts) and are merged
// over scene.json by every page that loads the room (GET /api/scenes carries them as `userEdits`).
import { Router } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { broadcast } from '../bus.ts';
import { obs } from '../obs.ts';
import { HttpError } from '../library.ts';
import { DATA_DIR, ROOT } from '../paths.ts';
import { requireLocal, sendFrom, wildcardPath } from './util.ts';
import { ROOM_ID, baseRoomId, splitRoomId } from '../../shared/roomId.ts';
import { stripArea, worldMatrices, apply as applyM, type GltfJson } from '../../shared/roomGlb.ts';
import { ANGLE_KEY, PROP_TRI_BUDGET, PROP_DRAW_BUDGET, checkRoomEdits, cloneEdits, editCount, emptyEdits, type EditContext, type PlacedProp } from '../../shared/roomEdits.ts';
import { PROP_ID, PROP_PACK_FILE, libraryItems, packItems, validatePropPack, type PropItem, type PropPackManifest } from '../../shared/propPacks.ts';
import { installedRoomDir, invalidateRooms } from '../roomList.ts';
import { editViewFromGlb } from '../../shared/roomCheck.ts';
import type { CheckSpot } from '../../shared/roomEditCheck.ts';
import { listLayouts, readEdits, readLayoutFile, removeEdits, removeLayout, writeEdits, writeLayout } from '../roomEditStore.ts';
import { LAYOUT_SLUG, droppedNote, layoutInfo, layoutName, trimLayout } from '../../shared/roomLayouts.ts';

export const LIB_PROPS_DIR = process.env.VTP_LIB_PROPS_DIR || path.join(ROOT, 'assets', 'library', 'props');
export const PROPS_DIR = process.env.VTP_PROPS_DIR || path.join(DATA_DIR, 'props');

export const roomEditRoutes = Router();

// ---------------------------------------------------------------- what a room has (validation context)
/** The JSON chunk of a .glb, read without loading the whole (up to ~40 MB) file. */
async function glbJson(file: string): Promise<GltfJson | null> {
  let fh: fsp.FileHandle | null = null;
  try {
    fh = await fsp.open(file, 'r');
    const head = Buffer.alloc(20);
    await fh.read(head, 0, 20, 0);
    if (head.readUInt32LE(0) !== 0x46546c67 || head.readUInt32LE(16) !== 0x4e4f534a) return null;
    const len = head.readUInt32LE(12);
    if (len > 64 * 1024 * 1024) return null;
    const body = Buffer.alloc(len);
    await fh.read(body, 0, len, 20);
    return JSON.parse(body.toString('utf8')) as GltfJson;
  } catch { return null; } finally { await fh?.close().catch(() => {}); }
}

export interface RoomAnchors { spots: string[]; cams: string[]; screen: boolean; bounds: [number, number, number, number, number, number] | null;
  /** The places as the room authors them (GLB + scene.json spotOverrides; glTF space): the seating chart without a preview. */
  places: CheckSpot[] }
const anchorCache = new Map<string, { key: string; a: RoomAnchors }>();

/** Spots, camera presets, the screen and the bounds of an installed room id (areas: the area's anchors + shared ones). */
export async function roomAnchors(id: string): Promise<RoomAnchors | null> {
  const { base, area } = splitRoomId(id);
  const dir = installedRoomDir(base);
  if (!dir) return null;
  let sj: Record<string, unknown>;
  try { sj = JSON.parse(await fsp.readFile(path.join(dir, 'scene.json'), 'utf8')) as Record<string, unknown>; } catch { return null; }
  const model = typeof sj.model === 'string' && /^[\w./-]{1,120}$/.test(sj.model) && !sj.model.includes('..') ? sj.model : 'scene.glb';
  const file = path.join(dir, model);
  const st = await fsp.stat(file).catch(() => null);
  const key = `${file}|${st?.size}|${st?.mtimeMs}|${JSON.stringify(sj).length}`;
  const hit = anchorCache.get(id);
  if (hit && hit.key === key) return hit.a;
  const json = st ? await glbJson(file) : null;
  const areas = sj.areas && typeof sj.areas === 'object' ? Object.keys(sj.areas as object) : [];
  const defArea = typeof sj.defaultArea === 'string' ? sj.defaultArea : areas[0];
  const mine = (area ?? defArea ?? '').toUpperCase();
  const spots = new Set<string>(), cams = new Set<string>();
  let screen = false;
  let bounds: RoomAnchors['bounds'] = null;
  if (json) {
    const { world, reached } = worldMatrices(json);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    (json.nodes ?? []).forEach((n, i) => {
      if (!reached[i]) return;
      const raw = n.name ?? '';
      const pre = /^([A-Z0-9][A-Z0-9_-]{0,23})__/.exec(raw)?.[1] ?? '';
      if (pre && areas.length && pre !== mine) return;          // another area's node
      const name = stripArea(raw);
      let m: RegExpExecArray | null;
      if ((m = /^SPOT_(\d{1,2})$/.exec(name)) && +m[1] >= 1 && +m[1] <= 12) spots.add(`SPOT_${m[1].padStart(2, '0')}`);
      else if ((m = /^SEAT_(\d{1,2})$/.exec(name)) && +m[1] >= 1 && +m[1] <= 12) spots.add(`SPOT_${m[1].padStart(2, '0')}`);
      else if (name === 'GM_SEAT') spots.add('SPOT_12');
      else if (/^CAM_[A-Z0-9_]+$/.test(name)) cams.add(name);
      else if (name === 'SCREEN') screen = true;
      if (n.mesh !== undefined) {
        for (const p of json.meshes?.[n.mesh]?.primitives ?? []) {
          const acc = json.accessors?.[p.attributes?.POSITION as number] as { min?: number[]; max?: number[] } | undefined;
          if (!acc?.min || !acc.max || acc.min.length < 3) continue;
          for (let c = 0; c < 8; c++) {
            const q = applyM(world[i], c & 1 ? acc.max[0] : acc.min[0], c & 2 ? acc.max[1] : acc.min[1], c & 4 ? acc.max[2] : acc.min[2]);
            for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], q[k]); hi[k] = Math.max(hi[k], q[k]); }
          }
        }
      }
    });
    if (lo.every(Number.isFinite)) bounds = [lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]];
  }
  // scene.json camera presets (and the area's own entry) count as the room's cameras too
  const view = { ...sj, ...(area && sj.areas && typeof sj.areas === 'object' ? ((sj.areas as Record<string, unknown>)[area] as object ?? {}) : {}) } as Record<string, unknown>;
  for (const k of ['cams', 'cameraOverrides']) {
    const o = view[k];
    if (o && typeof o === 'object') for (const n of Object.keys(o)) if (/^CAM_[A-Z0-9_]+$/.test(n)) cams.add(n);
  }
  const bb = view.bounds;
  if (Array.isArray(bb) && bb.length === 6 && bb.every((v) => typeof v === 'number' && Number.isFinite(v))) bounds = bb as RoomAnchors['bounds'];
  // a TTRPG room without SPOT nodes: SEAT_xx found above; a room whose GLB couldn't be read: no spot check
  let places: CheckSpot[] = [];
  try { if (json) places = editViewFromGlb(json, { ...view, userEdits: { room: id } }).spots.sort((x, y) => x.key.localeCompare(y.key)); } catch { /* no places */ }
  const a: RoomAnchors = { spots: [...spots].sort(), cams: [...cams].sort(), screen: json ? screen : true, bounds, places };
  anchorCache.set(id, { key, a });
  return a;
}

// ---------------------------------------------------------------- the prop catalog
let catalog: { at: number; items: PropItem[]; kits: { kit: string; name: string; source: 'lib' | 'pack'; count: number; license: string; errors?: string[] }[] } | null = null;
const fileUrl = (kind: 'lib' | 'pack', kit: string) => (rel: string) => `/api/props/file/${kind}/${kit}/${rel.split('/').map(encodeURIComponent).join('/')}`;

/** Every placeable prop on this PC (the CC0 library kits + installed prop packs). Re-read at most every 5 s. */
export async function propCatalog(force = false): Promise<NonNullable<typeof catalog>> {
  if (catalog && !force && Date.now() - catalog.at < 5000) return catalog;
  const items: PropItem[] = [];
  const kits: NonNullable<typeof catalog>['kits'] = [];
  for (const d of await fsp.readdir(LIB_PROPS_DIR, { withFileTypes: true }).catch(() => [] as fs.Dirent[])) {
    if (!d.isDirectory() || !PROP_ID.test(d.name)) continue;
    try {
      const idx = JSON.parse(await fsp.readFile(path.join(LIB_PROPS_DIR, d.name, 'index.json'), 'utf8')) as { kit?: string; name?: string; license?: string };
      if (idx.kit !== d.name) continue;
      const list = libraryItems(idx, fileUrl('lib', d.name));
      items.push(...list);
      kits.push({ kit: d.name, name: String(idx.name ?? d.name).slice(0, 80), source: 'lib', count: list.length, license: String(idx.license ?? 'CC0 1.0') });
    } catch { /* not a kit */ }
  }
  for (const d of await fsp.readdir(PROPS_DIR, { withFileTypes: true }).catch(() => [] as fs.Dirent[])) {
    if (!d.isDirectory() || !PROP_ID.test(d.name)) continue;
    const dir = path.join(PROPS_DIR, d.name);
    try {
      const m = JSON.parse(await fsp.readFile(path.join(dir, PROP_PACK_FILE), 'utf8')) as PropPackManifest;
      const files = new Set<string>();
      const walk = async (rel: string, depth: number) => {
        for (const e of await fsp.readdir(path.join(dir, rel), { withFileTypes: true })) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isFile()) files.add(r); else if (e.isDirectory() && depth < 2) await walk(r, depth + 1);
        }
      };
      await walk('', 0);
      const errors = validatePropPack(m, files);
      if (m.id !== d.name) errors.push(`the folder is called ${d.name} but the pack id is ${String(m.id)}`);
      if (errors.length) { kits.push({ kit: d.name, name: String(m.name ?? d.name).slice(0, 80), source: 'pack', count: 0, license: String(m.license ?? ''), errors: errors.slice(0, 6) }); continue; }
      const list = packItems(m, fileUrl('pack', d.name));
      items.push(...list);
      kits.push({ kit: d.name, name: m.name, source: 'pack', count: list.length, license: m.license });
    } catch { /* no props.json: not a prop pack */ }
  }
  catalog = { at: Date.now(), items, kits };
  return catalog;
}

roomEditRoutes.get('/api/props', async (_req, res) => {
  const c = await propCatalog();
  res.json({ items: c.items, kits: c.kits, budgets: { tris: PROP_TRI_BUDGET, draws: PROP_DRAW_BUDGET } });
});
const PROP_FILE_EXT = /\.(glb|gltf|bin|png|jpe?g|webp|ktx2)$/i;
roomEditRoutes.get('/api/props/file/:kind/:kit/*rel', (req, res) => {
  const kind = String(req.params.kind), kit = String(req.params.kit);
  const rel = wildcardPath((req.params as Record<string, unknown>).rel);
  if ((kind !== 'lib' && kind !== 'pack') || !PROP_ID.test(kit) || !PROP_FILE_EXT.test(rel) || rel.split('/').some((s) => s.startsWith('.'))) throw new HttpError(400, 'Bad prop file');
  sendFrom(res, path.join(kind === 'lib' ? LIB_PROPS_DIR : PROPS_DIR, kit), rel);
});

// ---------------------------------------------------------------- the edits
const roomIdOf = (v: unknown): string => {
  const id = String(v ?? '');
  if (!ROOM_ID.test(id)) throw new HttpError(400, 'Bad room id');
  if (!installedRoomDir(baseRoomId(id))) throw new HttpError(404, `No room "${id}" on this PC.`);
  return id;
};
async function contextFor(id: string): Promise<{ ctx: EditContext; anchors: RoomAnchors | null }> {
  const anchors = await roomAnchors(id);
  const props = new Map<string, { box?: PlacedProp['box'] }>();
  for (const it of (await propCatalog()).items) props.set(it.src, {});
  return {
    anchors,
    ctx: { room: id, props, ...(anchors ? { spots: anchors.spots.length ? new Set(anchors.spots) : undefined, cams: new Set(anchors.cams), screen: anchors.screen, bounds: anchors.bounds } : {}) },
  };
}

roomEditRoutes.get('/api/rooms/:id/edits', async (req, res) => {
  const id = roomIdOf(req.params.id);
  const [edits, { anchors }] = await Promise.all([readEdits(id), contextFor(id)]);
  // (the places where the user's edits put them)
  const places = (anchors?.places ?? []).map((s) => { const e = edits?.spots?.[s.key]; return e ? { ...s, ...(e.pos ? { pos: e.pos } : {}), ...(e.yaw !== undefined ? { yawDeg: e.yaw } : {}) } : s; });
  // objects / presets: what this server keeps (shared/roomEdits.ts hiddenObjects / movedObjects and the layouts routes)
  res.json({ roomId: id, edits, anchors: anchors ? { ...anchors, places } : null, objects: true, presets: true });
});

/** Is OBS on air (streaming / recording)? null = can't tell (OBS not connected through VTube Pro). */
async function onAir(): Promise<boolean | null> {
  try { return await obs.outputActive(); } catch { return null; }
}
function announce(id: string, rev: number, apply: boolean) {
  invalidateRooms([baseRoomId(id)]);
  broadcast({ type: 'roomEdits', id, rev, apply });
}

roomEditRoutes.put('/api/rooms/:id/edits', async (req, res) => {
  requireLocal(req);
  const id = roomIdOf(req.params.id);
  const b = (req.body ?? {}) as { edits?: unknown; apply?: unknown; live?: unknown };
  const { ctx } = await contextFor(id);
  const { edits, errors } = checkRoomEdits(b.edits ?? emptyEdits(id), ctx);
  if (errors.length) { res.status(422).json({ error: `These changes can't be saved: ${errors[0]}`, errors: errors.slice(0, 40) }); return; }
  const now = b.apply !== 'later';
  if (now && b.live !== 'ok' && await onAir() === true) {
    res.status(409).json({ live: true, error: 'You are live: saving now changes the room on your stream (cameras may move). Apply it now, or save it for the next time the room loads.' });
    return;
  }
  // (the live camera tweaks are written only by PUT …/edits/tweak: a Save from the editor keeps the newest ones)
  const stored = await readEdits(id);
  if (stored?.camTweaks) edits.camTweaks = stored.camTweaks; else delete edits.camTweaks;
  let saved;
  try { saved = await writeEdits(id, edits); } catch (e) { throw new HttpError(500, (e as Error).message); }
  announce(id, saved?.rev ?? 0, now);
  res.json({ ok: true, roomId: id, edits: saved, changes: editCount(saved), applied: now });
});

roomEditRoutes.delete('/api/rooms/:id/edits', async (req, res) => {
  requireLocal(req);
  const id = roomIdOf(req.params.id);
  const now = req.query.apply !== 'later';
  if (now && req.query.live !== 'ok' && await onAir() === true) {
    res.status(409).json({ live: true, error: 'You are live: resetting now changes the room on your stream. Reset it now, or for the next time the room loads.' });
    return;
  }
  const had = await removeEdits(id);
  if (had) announce(id, 0, now);
  res.json({ ok: true, roomId: id, removed: had, applied: now && had });
});

// One write at a time per room for the quick-adjust (sliders send a burst; the last one wins, none is lost half-way).
const tweakChain = new Map<string, Promise<unknown>>();
roomEditRoutes.put('/api/rooms/:id/edits/tweak', async (req, res) => {
  requireLocal(req);
  const id = roomIdOf(req.params.id);
  const b = (req.body ?? {}) as { angle?: unknown; tweak?: unknown };
  const angle = typeof b.angle === 'string' && ANGLE_KEY.test(b.angle) ? b.angle : null;
  if (!angle) throw new HttpError(400, 'Body: { angle: "talk:SPOT_01" | "group" | "wide" | "react" | "CAM_…", tweak: {orbit, tilt, dolly, height, fov} | null }');
  const run = (tweakChain.get(id) ?? Promise.resolve()).then(async () => {
    const cur = (await readEdits(id)) ?? emptyEdits(id);
    const next = cloneEdits(cur);
    next.camTweaks = { ...(next.camTweaks ?? {}) };
    if (b.tweak === null || b.tweak === undefined) delete next.camTweaks[angle];
    else next.camTweaks[angle] = b.tweak as never;
    const { ctx } = await contextFor(id);
    // (only the tweak is judged here: a prop whose pack was removed meanwhile stays in the file)
    const { edits, errors } = checkRoomEdits(next, { ...ctx, props: undefined });
    const mine = errors.filter((e) => e.startsWith(`camTweaks.${angle}`));
    if (mine.length) throw new HttpError(422, mine[0]);
    const saved = await writeEdits(id, edits);
    announce(id, saved?.rev ?? 0, true);
    return saved?.camTweaks?.[angle] ?? null;
  });
  tweakChain.set(id, run.catch(() => {}));
  const tweak = await run;
  res.json({ ok: true, roomId: id, angle, tweak });
});

// ---------------------------------------------------------------- layouts (named presets: shared/roomLayouts.ts)
//   GET    /api/rooms/:id/presets           → { roomId, presets: [{slug, name, savedAt, changes}] }   (newest first)
//   GET    /api/rooms/:id/presets/:slug     → { roomId, preset: {slug, name, savedAt, edits} }
//   POST   /api/rooms/:id/presets           body { name, edits }   (localhost only) a new layout → 201 { ok, preset }
//   PUT    /api/rooms/:id/presets/:slug     body { name?, edits? } (localhost only) rename and / or overwrite it
//   DELETE /api/rooms/:id/presets/:slug     (localhost only)
// A layout never reaches OBS by itself: the editor loads it, then its Save goes through PUT …/edits (the on-air rule).
const slugOf = (v: unknown): string => { const s = String(v ?? ''); if (!LAYOUT_SLUG.test(s)) throw new HttpError(400, 'Bad layout name'); return s; };
/** A layout body: what fits this room is kept, what doesn't (another room's places, a prop not installed here, a node
 *  this room hasn't got) is left out and counted; only a body that isn't a layer at all is refused. */
async function layoutFrom(id: string, raw: unknown) {
  const { ctx } = await contextFor(id);
  const t = trimLayout(id, raw, ctx);
  if (!t) throw new HttpError(400, 'That is not a room layout.');
  return t;
}
roomEditRoutes.get('/api/rooms/:id/presets', async (req, res) => {
  const id = roomIdOf(req.params.id);
  res.json({ roomId: id, presets: await listLayouts(id) });
});
roomEditRoutes.get('/api/rooms/:id/presets/:slug', async (req, res) => {
  const id = roomIdOf(req.params.id), slug = slugOf(req.params.slug);
  const l = await readLayoutFile(id, slug);
  if (!l) throw new HttpError(404, 'That layout is gone (deleted on another page?).');
  res.json({ roomId: id, preset: l });
});
roomEditRoutes.post('/api/rooms/:id/presets', async (req, res) => {
  requireLocal(req);
  const id = roomIdOf(req.params.id);
  const b = (req.body ?? {}) as { name?: unknown; edits?: unknown };
  const name = layoutName(b.name);
  if (!name) throw new HttpError(400, 'Give the layout a name.');
  const { edits, dropped } = await layoutFrom(id, b.edits);
  let l;
  try { l = await writeLayout(id, null, name, edits); } catch (e) { throw new HttpError(409, (e as Error).message); }
  res.status(201).json({ ok: true, roomId: id, preset: layoutInfo(l), dropped, ...(dropped ? { note: droppedNote(dropped) } : {}) });
});
roomEditRoutes.put('/api/rooms/:id/presets/:slug', async (req, res) => {
  requireLocal(req);
  const id = roomIdOf(req.params.id), slug = slugOf(req.params.slug);
  const cur = await readLayoutFile(id, slug);
  if (!cur) throw new HttpError(404, 'That layout is gone (deleted on another page?).');
  const b = (req.body ?? {}) as { name?: unknown; edits?: unknown };
  const name = b.name === undefined ? cur.name : layoutName(b.name);
  if (!name) throw new HttpError(400, 'Give the layout a name.');
  const t = b.edits === undefined ? { edits: cur.edits, dropped: 0 } : await layoutFrom(id, b.edits);
  const l = await writeLayout(id, slug, name, t.edits);
  res.json({ ok: true, roomId: id, preset: layoutInfo(l), dropped: t.dropped, ...(t.dropped ? { note: droppedNote(t.dropped) } : {}) });
});
roomEditRoutes.delete('/api/rooms/:id/presets/:slug', async (req, res) => {
  requireLocal(req);
  const id = roomIdOf(req.params.id), slug = slugOf(req.params.slug);
  res.json({ ok: true, roomId: id, removed: await removeLayout(id, slug) });
});
