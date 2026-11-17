// Room preferences kept by the helper (server/routes/roomPrefs.ts → config/room_prefs.json), so every studio of this PC
// (the studio, a second tab, a reinstall that brings config/ over) sees the same favourites
// and recent rooms. Pure data + the operations, shared by the server, the studio client (src/net/roomPrefs.ts) and the
// in-browser fallback (unused in this build).
//
// API (all JSON, answers are always the whole RoomPrefs):
//   GET  /api/rooms/prefs                                   → RoomPrefs
//   POST /api/rooms/favorites        { id, on?: boolean }   → add (on: true) / remove (on: false) / toggle (on missing)
//   PUT  /api/rooms/favorites        { favorites: [...] }   → replace the whole list (order = the order given)
//   POST /api/rooms/favorites/merge  { favorites: [...] }   → add the ones not there yet (a browser's old list, once)
//   POST /api/rooms/recent           { id: string | null }  → to the front of the recent list (null = Classic)
//   POST /api/rooms/memory           { id, host?, stage? }  → what this PC remembers per room: the host's seat and the
//                                                             room's stage presets (merged per room; used on a switch)
// Every change is broadcast on this PC's bus as { type: 'roomPrefs', prefs } (other studio tabs follow at once).
import { isRoomId } from './roomId.ts';

export const MAX_FAVORITES = 60;
export const MAX_RECENT = 8;
export const MAX_ROOM_MEMORY = 200;
/** Stage presets remembered per room (SceneStageState keys; src/scene/controller.ts rememberStage). */
export const ROOM_STAGE_KEYS = ['react', 'gaming', 'strip', 'corner', 'cam', 'framing', 'backdrop'] as const;

/** What this PC remembers about one room: the host's seat (spot index) and the room's stage presets. */
export interface RoomMemory { host?: number; stage?: Partial<Record<typeof ROOM_STAGE_KEYS[number], string>> }

export interface RoomPrefs {
  /** Favourite room ids (a room or `<room>~<area>`), newest first unless the host reordered them. */
  favorites: string[];
  /** Recently used rooms, newest first; null = Classic (no room). */
  recent: (string | null)[];
  /** Per room (room id → memory): the host's seat and stage presets, so every studio of this PC switches the same way. */
  rooms?: Record<string, RoomMemory>;
  /** Bumps on every change (a page ignores an answer older than what it has). */
  rev: number;
  /** The helper has a saved file (false = never saved: a browser may bring its old per-browser list in). */
  exists?: boolean;
}

export const emptyRoomPrefs = (): RoomPrefs => ({ favorites: [], recent: [], rev: 0 });

const uniq = <T>(a: T[]) => [...new Set(a)];

export function sanitizeFavorites(v: unknown): string[] {
  return Array.isArray(v) ? uniq(v.filter(isRoomId)).slice(0, MAX_FAVORITES) : [];
}

export function sanitizeRoomMemory(o: unknown): RoomMemory | null {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const out: RoomMemory = {};
  if (typeof x.host === 'number' && Number.isInteger(x.host) && x.host >= 0 && x.host < 32) out.host = x.host;
  if (x.stage && typeof x.stage === 'object') {
    const st: RoomMemory['stage'] = {};
    for (const k of ROOM_STAGE_KEYS) { const v = (x.stage as Record<string, unknown>)[k]; if (typeof v === 'string' && /^[a-z-]{1,16}$/.test(v)) st[k] = v; }
    if (Object.keys(st).length) out.stage = st;
  }
  return Object.keys(out).length ? out : null;
}

export function sanitizeRoomPrefs(o: unknown): RoomPrefs {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const recent = Array.isArray(x.recent) ? uniq(x.recent.filter((r): r is string | null => r === null || isRoomId(r))).slice(0, MAX_RECENT) : [];
  const rev = typeof x.rev === 'number' && Number.isFinite(x.rev) ? Math.max(0, Math.min(1e12, Math.round(x.rev))) : 0;
  const rooms: Record<string, RoomMemory> = {};
  if (x.rooms && typeof x.rooms === 'object') for (const [k, v] of Object.entries(x.rooms as Record<string, unknown>).slice(-MAX_ROOM_MEMORY)) { const m = sanitizeRoomMemory(v); if (isRoomId(k) && m) rooms[k] = m; }
  return { favorites: sanitizeFavorites(x.favorites), recent, ...(Object.keys(rooms).length ? { rooms } : {}), rev, ...(typeof x.exists === 'boolean' ? { exists: x.exists } : {}) };
}

/** Remember the host's seat / stage presets for a room (merged into what is there; unchanged = same object). */
export function rememberRoom(p: RoomPrefs, id: string, patch: RoomMemory): RoomPrefs {
  if (!isRoomId(id)) return p;
  const cur = p.rooms?.[id] ?? {};
  const next = sanitizeRoomMemory({ ...cur, ...patch, stage: { ...(cur.stage ?? {}), ...(patch.stage ?? {}) } });
  if (!next || JSON.stringify(next) === JSON.stringify(cur)) return p;
  const rooms = { ...(p.rooms ?? {}) };
  delete rooms[id];
  rooms[id] = next;                                    // (most recently changed last: the oldest go first past the cap)
  const keys = Object.keys(rooms);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ROOM_MEMORY))) delete rooms[k];
  return { ...p, rooms, rev: p.rev + 1 };
}

/** Favourite on / off / toggle (`on` undefined). New favourites go to the front. */
export function setFavorite(p: RoomPrefs, id: string, on?: boolean): RoomPrefs {
  if (!isRoomId(id)) return p;
  const has = p.favorites.includes(id);
  const want = on === undefined ? !has : on;
  if (want === has) return p;
  const favorites = want ? [id, ...p.favorites].slice(0, MAX_FAVORITES) : p.favorites.filter((f) => f !== id);
  return { ...p, favorites, rev: p.rev + 1 };
}

/** Replace the whole list (the host reordered / cleared it). */
export function replaceFavorites(p: RoomPrefs, list: unknown): RoomPrefs {
  const favorites = sanitizeFavorites(list);
  if (JSON.stringify(favorites) === JSON.stringify(p.favorites)) return p;
  return { ...p, favorites, rev: p.rev + 1 };
}

/** Add the ids not there yet, after the existing ones (a browser's old per-browser list, brought in once). */
export function mergeFavorites(p: RoomPrefs, list: unknown): RoomPrefs {
  const add = sanitizeFavorites(list).filter((f) => !p.favorites.includes(f));
  if (!add.length) return p;
  return { ...p, favorites: [...p.favorites, ...add].slice(0, MAX_FAVORITES), rev: p.rev + 1 };
}

/** A room was used: to the front of the recent list. */
export function noteRecentRoom(p: RoomPrefs, id: string | null): RoomPrefs {
  if (id !== null && !isRoomId(id)) return p;
  if (p.recent[0] === id) return p;
  return { ...p, recent: [id, ...p.recent.filter((r) => r !== id)].slice(0, MAX_RECENT), rev: p.rev + 1 };
}

/** The request bodies of the API above → the new prefs (null = a bad request). Shared by the server and any in-browser fallback. */
export function applyRoomPrefsRequest(p: RoomPrefs, method: string, path: string, body: unknown): RoomPrefs | null {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (path === '/api/rooms/favorites' && method === 'POST') {
    if (!isRoomId(b.id)) return null;
    return setFavorite(p, b.id, typeof b.on === 'boolean' ? b.on : undefined);
  }
  if (path === '/api/rooms/favorites' && method === 'PUT') return Array.isArray(b.favorites) ? replaceFavorites(p, b.favorites) : null;
  if (path === '/api/rooms/favorites/merge' && method === 'POST') return Array.isArray(b.favorites) ? mergeFavorites(p, b.favorites) : null;
  if (path === '/api/rooms/recent' && method === 'POST') return b.id === null || isRoomId(b.id) ? noteRecentRoom(p, b.id as string | null) : null;
  if (path === '/api/rooms/memory' && method === 'POST') { const m = sanitizeRoomMemory(b); return isRoomId(b.id) && m ? rememberRoom(p, b.id, m) : null; }
  return null;
}
