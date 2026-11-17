// Installed room folders (shipped and the user's own): GET /api/scenes (server/routes/scenes.ts) and "Check what
// Claude made" (GET /api/ai/pending, server/routes/aiconnect.ts). Light on purpose: no OBS client, no bus — importing
// server/routes/scenes.ts starts the OBS watcher (server/obs.ts), and a test or tool that imports this must still exit
// (the room catalog's watchers and timer never keep a process alive).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { SceneInfo } from '../shared/types.ts';
import { ROOM_FOLDER, expandAreas, roomAreas } from '../shared/roomId.ts';
import { SHIPPED_SCENES_DIR, USER_SCENES_DIR } from './paths.ts';
import { readEdits } from './roomEditStore.ts';

/** Where rooms live: the user's own folder first, then the shipped ones (VTP_SCENES_DIR: tests, the user folder only). */
export const ROOM_DIRS = [...new Set([USER_SCENES_DIR, process.env.VTP_SCENES_DIR ? '' : SHIPPED_SCENES_DIR].filter(Boolean))];

/** Every installed room folder, in list order. A room package whose room is already here is not listed again. */
export function installedRoomIds(): string[] {
  let ids: string[] = [];
  for (const dir of ROOM_DIRS) {
    try { ids.push(...fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && ROOM_FOLDER.test(d.name)).map((d) => d.name)); } catch { /* no rooms there yet */ }
  }
  return [...new Set(ids)];
}
/** An installed room's folder, found the way GET /api/scenes finds it (the user's rooms, then the shipped ones), or null.
 *  For the MCP room checks (validate_room, check_room): in a release the shipped rooms are not in the user's rooms folder.
 */
export function installedRoomDir(id: string): string | null {
  if (!ROOM_FOLDER.test(id)) return null;
  for (const d of ROOM_DIRS) { const own = path.join(d, id); if (fs.existsSync(path.join(own, 'scene.json'))) return own; }
  return null;
}
async function installedRoomIdsAsync(): Promise<string[]> {
  let ids: string[] = [];
  for (const dir of ROOM_DIRS) {
    try { ids.push(...(await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && ROOM_FOLDER.test(d.name)).map((d) => d.name)); } catch { /* no rooms there yet */ }
  }
  return [...new Set(ids)];
}

// ---------------------------------------------------------------- watching a catalog's folder
// (the room catalog below and the avatar catalog, server/library.ts)
/** A watched catalog folder. */
export interface CatalogWatch { close(): void }
/** How folders are watched. 'recursive': one native recursive watcher (Windows, macOS). 'shallow': a plain watcher on the
 *  folder plus one on each item folder in it (Linux: Node's recursive watch there is not native: it walks the whole tree
 *  synchronously, on the thread that relays tracking frames, and puts an inotify watch on every FILE: room textures,
 *  costumes, party versions, the trash ... which can run out of inotify watches). A catalog only needs an item's folder
 *  and the files at its top; anything deeper (a room area's own thumbnail) waits for the 60 s refresh in 'shallow' mode.
 *  VTP_WATCH_MODE=shallow|recursive overrides (tests). */
export function watchMode(): 'recursive' | 'shallow' {
  const m = process.env.VTP_WATCH_MODE;
  if (m === 'shallow' || m === 'recursive') return m;
  return process.platform === 'win32' || process.platform === 'darwin' ? 'recursive' : 'shallow';
}
/** Watch a catalog folder. onEvent(rel): rel = the changed path under root, '/'- or '\'-separated (an item folder, or a
 *  file in one; deeper paths only in 'recursive' mode), null = can't tell (re-read everything). `item`: which names in
 *  root are item folders ('shallow' mode watches those). onError: the watcher broke and is closed (re-arm it later).
 *  Rejects when root can't be watched (no such folder). */
export async function watchCatalogFolder(root: string, item: (name: string) => boolean, onEvent: (rel: string | null) => void, onError: () => void): Promise<CatalogWatch> {
  if (watchMode() === 'recursive') {
    const w = fs.watch(root, { recursive: true, persistent: false }, (_ev, name) => onEvent(name == null ? null : String(name)));
    w.on('error', () => { try { w.close(); } catch { /* */ } onError(); });
    return { close: () => { try { w.close(); } catch { /* */ } } };
  }
  const kids = new Map<string, fs.FSWatcher>();
  let closed = false;
  const unwatch = (name: string) => { const k = kids.get(name); if (k) { kids.delete(name); try { k.close(); } catch { /* */ } } };
  // (re)watch one item folder; a top-level event for it may mean it was removed and made again, so always a new watcher
  const watchKid = (name: string, isDir?: boolean) => {
    unwatch(name);
    if (closed || !item(name)) return;
    const dir = path.join(root, name);
    try {
      if (isDir === undefined && !fs.statSync(dir).isDirectory()) return;   // (one stat, only when an item appears / goes)
      const k = fs.watch(dir, { persistent: false }, (_ev, f) => onEvent(f == null ? name : `${name}/${String(f)}`));
      k.on('error', () => { if (kids.get(name) === k) unwatch(name); onEvent(name); });
      kids.set(name, k);
    } catch { /* gone (again) */ }
  };
  const close = () => { closed = true; try { top.close(); } catch { /* */ } for (const n of [...kids.keys()]) unwatch(n); };
  const top = fs.watch(root, { persistent: false }, (ev, name) => {
    if (name == null) { onEvent(null); return; }
    const n = String(name);
    if (ev === 'rename' || !kids.has(n)) watchKid(n);                          // made / removed / renamed (or not watched yet)
    onEvent(n);
  });
  top.on('error', () => { close(); onError(); });
  try {
    for (const d of await fsp.readdir(root, { withFileTypes: true })) if (d.isDirectory() && !kids.has(d.name)) watchKid(d.name, true);
  } catch { /* the 60 s refresh still runs */ }
  return { close };
}

// ---------------------------------------------------------------- the room catalog (GET /api/scenes)
// Reading every room's scene.json + 3-4 file checks per request froze the thread that relays tracking frames to the OBS
// pages for 40-200 ms (35 rooms). The list is kept in memory instead: built at startup with async fs, refreshed in
// the background when something changes in a rooms folder (fs.watch, 250 ms debounce: room
// installs, "Add my room", AI room packages), and every 60 s as a safety net. GET /api/scenes never answers with a list older than the file events seen before it: a request that comes
// in after a change (the studio re-lists right after an install / removal or a room import) waits for that refresh.
const exists = (p: string) => fsp.stat(p).then(() => true, () => false);

/** A room's folder (the helper's own folders; else where a new room would go). */
async function sceneDirAsync(id: string): Promise<string> {
  for (const d of ROOM_DIRS) { const own = path.join(d, id); if (await exists(path.join(own, 'scene.json'))) return own; }
  return path.join(USER_SCENES_DIR, id);
}
/** One room as listed (one entry per area for rooms with areas), or null when its scene.json is unreadable. */
async function readRoom(id: string): Promise<SceneInfo[] | null> {
  try {
    const dir = await sceneDirAsync(id);
    const j = JSON.parse(await fsp.readFile(path.join(dir, 'scene.json'), 'utf8')) as Partial<SceneInfo>;
    const model = typeof j.model === 'string' && /^[\w./-]{1,120}$/.test(j.model) && !j.model.includes('..') ? j.model : 'scene.glb';
    let thumb: string | undefined;
    for (const f of ['thumb.png', 'preview.png']) if (await exists(path.join(dir, f))) { thumb = f; break; }
    const info = {
      ...j, id, name: String(j.name ?? id).slice(0, 80), model,
      ready: await exists(path.join(dir, model)),
      thumb: thumb ? `/api/scenes/${id}/file/${thumb}` : null,
    } as SceneInfo;
    // an area's own preview / thumb (assets/scenes/<room>/areas/<area>/thumb.png | preview.png), else the room's
    const areaThumbs = new Map<string, string | null>();
    for (const area of roomAreas(info as SceneInfo & { areas?: unknown }).keys) {
      let f: string | null = null;
      for (const n of ['thumb.png', 'preview.png']) if (await exists(path.join(dir, 'areas', area, n))) { f = n; break; }
      areaThumbs.set(area, f);
    }
    const list = expandAreas(info, (areaId, area) => { const f = areaThumbs.get(area); return f ? `/api/scenes/${areaId}/file/${f}` : null; });
    // the user's own Room editor layer per room id (<data>/room-edits, server/roomEditStore.ts): pages merge it over the room
    for (const e of list) {
      const ed = await readEdits(e.id);
      if (ed) e.userEdits = ed; else delete e.userEdits;
    }
    return list;
  } catch { return null; }
}

const rooms = {
  started: false,
  ready: false,
  first: null as Promise<void> | null,
  byId: new Map<string, SceneInfo[] | null>(),
  list: [] as SceneInfo[],
  json: null as string | null,
  body: Buffer.alloc(0),
  etag: '',
  queued: new Set<string>(),
  all: false,
  running: null as Promise<void> | null,
  timer: null as NodeJS.Timeout | null,
  firstEventAt: 0,
  watchers: new Map<string, CatalogWatch>(),  // by folder
  arming: Promise.resolve(),
  seq: 0,                                     // file events so far
  lastEvent: 0,                               // seq of the newest file event
  applied: 0,                                 // every event up to this seq is in the list
  refreshes: 0,
};

async function refreshRoomsOnce(all: boolean, want: Set<string>, startSeq: number) {
  const ids = await installedRoomIdsAsync();
  const todo = ids.filter((id) => all || want.has(id) || !rooms.byId.has(id));
  const got = new Map<string, SceneInfo[] | null>();
  for (let i = 0; i < todo.length; i += 4) {                                   // 4 rooms at a time
    const part = todo.slice(i, i + 4);
    (await Promise.all(part.map(readRoom))).forEach((r, k) => got.set(part[k], r));
  }
  const next = new Map<string, SceneInfo[] | null>();
  for (const id of ids) next.set(id, got.has(id) ? got.get(id)! : rooms.byId.get(id) ?? null);
  rooms.byId = next;
  rooms.list = ids.flatMap((id) => next.get(id) ?? []);
  rooms.json = null;
  rooms.ready = true;
  rooms.applied = Math.max(rooms.applied, startSeq);
  rooms.refreshes++;
}
function refreshRooms(): Promise<void> {
  if (rooms.running) return rooms.running;
  rooms.running = (async () => {
    try {
      do {
        const all = rooms.all || !rooms.ready;
        rooms.all = false;
        const want = new Set(rooms.queued);
        rooms.queued.clear();
        const startSeq = rooms.seq;                                              // (every event up to here is in want / all)
        try { await refreshRoomsOnce(all, want, startSeq); } catch (e) { console.warn('[rooms] list refresh failed:', (e as Error).message); rooms.ready = true; }
      } while (rooms.all || rooms.queued.size);
    } finally { rooms.running = null; }
  })();
  return rooms.running;
}
/** Debounced: a burst of file events (a room being copied in) = one refresh, at the latest 2 s after the first event. */
function scheduleRooms(delay = 250) {
  const now = Date.now();
  if (!rooms.firstEventAt) rooms.firstEventAt = now;
  if (rooms.timer) clearTimeout(rooms.timer);
  rooms.timer = setTimeout(() => { rooms.timer = null; rooms.firstEventAt = 0; void refreshRooms(); }, Math.min(delay, Math.max(0, rooms.firstEventAt + 2000 - now)));
  rooms.timer.unref?.();
}
/** A room was installed / changed / removed (ids), or anything may have changed (no ids): re-read in the background, and
 *  the next GET /api/scenes waits for it. fs.watch on the rooms folders calls this for every writer. */
export function invalidateRooms(ids?: string[]) {
  if (!rooms.started) return;
  if (!ids) rooms.all = true; else for (const id of ids) rooms.queued.add(id);
  rooms.lastEvent = ++rooms.seq;
  scheduleRooms();
}
/** Bring the list up to the file events seen so far (GET /api/scenes): an async refresh, never a sync scan. The 60 s
 *  safety refresh is not an event: nobody waits for it. */
async function roomsCaughtUp() {
  await new Promise<void>((r) => setImmediate(r));       // a file event read in the same poll as this request runs first
  const want = rooms.lastEvent;
  for (let i = 0; i < 3 && rooms.applied < want; i++) {
    if (rooms.timer) { clearTimeout(rooms.timer); rooms.timer = null; rooms.firstEventAt = 0; }
    await refreshRooms();
  }
}

function onRoomEvent(rel: string | null) {
  if (rel === null) { invalidateRooms(); return; }
  const id = rel.split(/[\\/]/)[0];
  if (ROOM_FOLDER.test(id)) invalidateRooms([id]);
}
/** The folders to watch: this helper's own rooms folders. */
function roomRoots(): string[] {
  return [...new Set(ROOM_DIRS.map((d) => path.resolve(d)))];
}
/** Watch every room folder that is not watched yet. One at a time. */
function armRoomWatchers(): Promise<void> {
  rooms.arming = rooms.arming.then(async () => {
    const roots = roomRoots();
    for (const [r, w] of rooms.watchers) if (!roots.includes(r)) { w.close(); rooms.watchers.delete(r); }
    for (const r of roots) {
      if (rooms.watchers.has(r)) continue;
      await fsp.mkdir(r, { recursive: true }).catch(() => {});   // the user's rooms folder may not exist yet
      const me: { w: CatalogWatch | null } = { w: null };
      try {
        me.w = await watchCatalogFolder(r, (n) => ROOM_FOLDER.test(n), onRoomEvent, () => {
          if (me.w && rooms.watchers.get(r) === me.w) rooms.watchers.delete(r);   // the 60 s tick watches it again
          invalidateRooms();
        });
        rooms.watchers.set(r, me.w);
      } catch { /* no such folder (yet): the 60 s tick tries again */ }
    }
  }).catch(() => { /* never breaks the chain */ });
  return rooms.arming;
}

/** Start the room catalog (idempotent): watchers, first build, the 60 s safety refresh. */
export function startRoomCatalog(): Promise<void> {
  if (rooms.started) return rooms.first ?? Promise.resolve();
  rooms.started = true;
  const t = setInterval(() => {
    void armRoomWatchers();                                                     // a folder that was missing / whose watcher broke
    rooms.all = true;
    void refreshRooms();
  }, 60_000);
  t.unref?.();
  rooms.first = armRoomWatchers().then(() => refreshRooms());
  return rooms.first;
}

/** GET /api/scenes: every installed room (areas expanded), its JSON and an ETag. Never older than the file events seen
 *  before the call (it waits for that refresh, off the event loop). */
export async function roomCatalog(): Promise<{ list: readonly SceneInfo[]; json: string; body: Buffer; etag: string }> {
  if (!rooms.ready) await startRoomCatalog();
  await roomsCaughtUp();
  if (rooms.json === null) {
    rooms.json = JSON.stringify(rooms.list);
    rooms.body = Buffer.from(rooms.json, 'utf8');
    rooms.etag = `W/"${rooms.body.length.toString(16)}-${crypto.createHash('sha1').update(rooms.json).digest('base64').slice(0, 27)}"`;
  }
  return { list: rooms.list, json: rooms.json, body: rooms.body, etag: rooms.etag };
}
/** (tests, benchmarks) */
export function roomCatalogInfo() { return { ready: rooms.ready, refreshes: rooms.refreshes, rooms: rooms.byId.size, listed: rooms.list.length, watchers: rooms.watchers.size, watched: [...rooms.watchers.keys()] }; }
/** (tests) Run the queued refreshes now and wait for them. */
export async function settleRoomCatalog() {
  await rooms.arming;
  for (let i = 0; i < 50 && (rooms.timer || rooms.running); i++) {
    if (rooms.timer) { clearTimeout(rooms.timer); rooms.timer = null; rooms.firstEventAt = 0; void refreshRooms(); }
    await rooms.running;
  }
}
