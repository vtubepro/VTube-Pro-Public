// Room favourites + recent rooms for the studio UI (the room picker, the Live panel …): the server keeps them
// (server/routes/roomPrefs.ts, shared/roomPrefs.ts), so every tab shares one list that survives reloads and restarts.
//
// Synchronous getters for painting (the last known list: memory, else this browser's mirror), async setters that
// change the list at once (optimistic), send it to the helper in order and retry until it is saved:
//
//   roomFavorites(): string[]                 isFavoriteRoom(id): boolean
//   toggleFavoriteRoom(id, on?): Promise      setFavoriteRooms(list): Promise     (reorder / clear)
//   recentRooms(): (string | null)[]          noteRecentRoom(id | null): Promise
//   onRoomPrefs(fn): () => void               (fn(prefs) after every change: own, another tab's, a load)
//   loadRoomPrefs(): Promise<RoomPrefs>        (called by itself on first use; again = refresh)
//   followRoomPrefs(bus)                      (other tabs' changes arrive on the bus: src/scene/controller.ts calls it)
//   roomMemory(id) / rememberRoomMemory(id, {host?, stage?})   (the host's seat + stage presets per room: the scene
//                                             controller reads them on a room switch, so every studio switches alike)
//
// A browser that kept favourites in localStorage before (vtp.rooms.fav, the old per-browser list) brings them in once.
import { applyRoomPrefsRequest, emptyRoomPrefs, rememberRoom, sanitizeRoomPrefs, type RoomMemory, type RoomPrefs } from '../../shared/roomPrefs.ts';

const MIRROR = 'vtp.rooms.prefs', LEGACY_FAV = 'vtp.rooms.fav', LEGACY_RECENT = 'vtp.rooms.recent', MERGED = 'vtp.rooms.fav.merged', QUEUE = 'vtp.rooms.prefs.queue';
const ls = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string | null) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage off */ } },
};
const parse = (t: string | null): unknown => { try { return t ? JSON.parse(t) : null; } catch { return null; } };

interface Op { method: 'POST' | 'PUT'; path: string; body: unknown }

let prefs: RoomPrefs = sanitizeRoomPrefs(parse(ls.get(MIRROR)) ?? emptyRoomPrefs());
let queue: Op[] = (() => { const q = parse(ls.get(QUEUE)); return Array.isArray(q) ? q.filter((o): o is Op => !!o && typeof o === 'object' && typeof (o as Op).path === 'string').slice(0, 50) : []; })();
const fns = new Set<(p: RoomPrefs) => void>();
let loadP: Promise<RoomPrefs> | null = null;
let loaded = false;
let flushing = false;
let retryT: ReturnType<typeof setTimeout> | null = null;
let retryMs = 1000;

const emit = () => { ls.set(MIRROR, JSON.stringify({ favorites: prefs.favorites, recent: prefs.recent, rooms: prefs.rooms ?? {}, rev: prefs.rev })); for (const f of fns) try { f(prefs); } catch (e) { console.warn('[roomPrefs]', e); } };
const saveQueue = () => ls.set(QUEUE, queue.length ? JSON.stringify(queue) : null);

async function call(method: string, path: string, body?: unknown): Promise<RoomPrefs> {
  const r = await fetch(path, { method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), cache: 'no-store' });
  if (!r.ok) { let m = `${r.status}`; try { m = (await r.json()).error ?? m; } catch { /* */ } throw Object.assign(new Error(m), { status: r.status }); }
  return sanitizeRoomPrefs(await r.json());
}

/** The helper's answer → ours, with the ops still waiting re-applied on top (they are newer than the answer). */
let serverRev = -1;
function adopt(server: RoomPrefs) {
  if (server.rev < serverRev) return;                       // (an older answer / broadcast than one already taken)
  serverRev = server.rev;
  let p = { ...server };
  delete p.exists;
  for (const o of queue) p = applyRoomPrefsRequest(p, o.method, o.path, o.body) ?? p;
  if (JSON.stringify([p.favorites, p.recent, p.rooms ?? {}]) !== JSON.stringify([prefs.favorites, prefs.recent, prefs.rooms ?? {}]) || p.rev !== prefs.rev) { prefs = p; emit(); }
}

async function flush() {
  if (flushing || !loaded) return;
  flushing = true;
  try {
    while (queue.length) {
      const o = queue[0];
      let back: RoomPrefs;
      try { back = await call(o.method, o.path, o.body); }
      catch (e) {
        if ((e as { status?: number }).status === 400) { queue.shift(); saveQueue(); continue; }      // (a bad op: drop it)
        if (!retryT) { retryT = setTimeout(() => { retryT = null; void flush(); }, retryMs); retryMs = Math.min(15000, retryMs * 2); }
        return;
      }
      retryMs = 1000;
      queue.shift(); saveQueue();
      adopt(back);
    }
  } finally { flushing = false; }
}

/** Ask the helper for the lists (first use does this by itself). */
export function loadRoomPrefs(): Promise<RoomPrefs> {
  loadP = (async () => {
    let p: RoomPrefs;
    for (let wait = 500; ; wait = Math.min(8000, wait * 2)) {
      try { p = await call('GET', '/api/rooms/prefs'); break; }
      catch { if (loaded) return prefs; await new Promise((r) => setTimeout(r, wait)); }
    }
    // this browser's old per-browser favourites (and recents, while the helper has none): brought in once
    if (ls.get(MERGED) !== '1') {
      const old = parse(ls.get(LEGACY_FAV));
      if (Array.isArray(old) && old.length) queue.unshift({ method: 'POST', path: '/api/rooms/favorites/merge', body: { favorites: old } });
      const rec = parse(ls.get(LEGACY_RECENT));
      if (!p.recent.length && Array.isArray(rec)) for (const id of [...rec].reverse()) if (id === null || typeof id === 'string') queue.push({ method: 'POST', path: '/api/rooms/recent', body: { id } });
      // this browser's per-room seat + stage presets (src/scene/controller.ts kept them per browser): for rooms the
      // helper doesn't remember yet
      const seats = parse(ls.get('vtp.scene.memory')) as Record<string, { host?: unknown }> | null, stages = parse(ls.get('vtp.stage.rooms')) as Record<string, unknown> | null;
      for (const id of new Set([...Object.keys(seats ?? {}), ...Object.keys(stages ?? {})])) {
        if (p.rooms?.[id]) continue;
        const host = seats?.[id]?.host;
        queue.push({ method: 'POST', path: '/api/rooms/memory', body: { id, ...(typeof host === 'number' ? { host } : {}), ...(stages?.[id] && typeof stages[id] === 'object' ? { stage: stages[id] } : {}) } });
      }
      saveQueue();
      ls.set(MERGED, '1');
    }
    loaded = true;
    adopt(p);
    void flush();
    return prefs;
  })();
  return loadP;
}
const ensure = () => { if (!loadP) void loadRoomPrefs(); };

function change(o: Op): Promise<RoomPrefs> {
  ensure();
  const next = applyRoomPrefsRequest(prefs, o.method, o.path, o.body);
  if (!next) return Promise.resolve(prefs);
  if (next !== prefs) { prefs = next; emit(); }
  queue.push(o); saveQueue();
  void flush();
  return (loadP ?? Promise.resolve(prefs)).then(() => prefs);
}

export function roomFavorites(): string[] { ensure(); return [...prefs.favorites]; }
export function isFavoriteRoom(id: string): boolean { ensure(); return prefs.favorites.includes(id); }
export function recentRooms(): (string | null)[] { ensure(); return [...prefs.recent]; }
/** Favourite on (true) / off (false) / toggle (missing). */
export function toggleFavoriteRoom(id: string, on?: boolean): Promise<RoomPrefs> { return change({ method: 'POST', path: '/api/rooms/favorites', body: on === undefined ? { id } : { id, on } }); }
/** Replace the list (reorder, clear). */
export function setFavoriteRooms(list: string[]): Promise<RoomPrefs> { return change({ method: 'PUT', path: '/api/rooms/favorites', body: { favorites: list } }); }
export function noteRecentRoom(id: string | null): Promise<RoomPrefs> { return change({ method: 'POST', path: '/api/rooms/recent', body: { id } }); }
/** What this PC remembers for a room (the helper's copy; null = nothing yet). */
export function roomMemory(id: string): RoomMemory | null { return prefs.rooms?.[id] ?? null; }   // (no load: observers read only)
/** Remember the host's seat / the stage presets for a room (sent only when something changed). */
export function rememberRoomMemory(id: string, patch: RoomMemory): void {
  if (rememberRoom(prefs, id, patch) === prefs) return;
  void change({ method: 'POST', path: '/api/rooms/memory', body: { id, ...patch } });
}
export function onRoomPrefs(fn: (p: RoomPrefs) => void): () => void { ensure(); fns.add(fn); return () => { fns.delete(fn); }; }

/** Other tabs' changes (the helper broadcasts {type:'roomPrefs'} after every save). */
export function followRoomPrefs(bus: { on(h: (m: { type: string; prefs?: unknown }) => void): unknown }) {
  bus.on((m) => {
    if (m.type !== 'roomPrefs' || !m.prefs) return;
    adopt(sanitizeRoomPrefs(m.prefs));
  });
}

/** (tests) reset the module. */
export function _resetRoomPrefsClient() { prefs = emptyRoomPrefs(); queue = []; loadP = null; loaded = false; flushing = false; if (retryT) clearTimeout(retryT); retryT = null; retryMs = 1000; serverRev = -1; fns.clear(); }
