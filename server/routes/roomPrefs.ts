// Room favourites + recent rooms, kept by the helper for every studio of this PC (shared/roomPrefs.ts has the API).
// Stored in config/room_prefs.json (atomic writes; "Bring my stuff over" carries config/ across), kept in memory, and
// broadcast on the bus ({type:'roomPrefs'}) after every change so other studio tabs follow.
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { applyRoomPrefsRequest, emptyRoomPrefs, sanitizeRoomPrefs, type RoomPrefs } from '../../shared/roomPrefs.ts';
import { broadcast } from '../bus.ts';
import { HttpError, writeFileNow } from '../library.ts';
import { CONFIG_DIR } from '../paths.ts';
import { requireLocal } from './util.ts';

const FILE = () => path.join(CONFIG_DIR, 'room_prefs.json');

let prefs: RoomPrefs | null = null;
let exists = false;
function current(): RoomPrefs {
  if (prefs) return prefs;
  try { prefs = sanitizeRoomPrefs(JSON.parse(fs.readFileSync(FILE(), 'utf8'))); exists = true; }
  catch { prefs = emptyRoomPrefs(); exists = false; }
  delete prefs.exists;
  return prefs;
}
const answer = () => ({ ...current(), exists });

export const roomPrefsRoutes = Router();

roomPrefsRoutes.get('/api/rooms/prefs', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(answer()); });

// one handler for every write (the request → new prefs rule is shared with the browser-only fallback)
const write = async (req: import('express').Request, res: import('express').Response) => {
  requireLocal(req);
  const p = String(req.path);
  const next = applyRoomPrefsRequest(current(), req.method, p, req.body);
  if (!next) throw new HttpError(400, p === '/api/rooms/recent' ? 'Body: { id: "<room id>" | null }' : p === '/api/rooms/memory' ? 'Body: { id: "<room id>", host?: <spot index>, stage?: { react?, gaming?, … } }' : 'Body: { id: "<room id>", on?: true | false } (POST) or { favorites: ["<room id>", …] } (PUT / merge)');
  if (next !== current() || !exists) {
    const text = JSON.stringify({ favorites: next.favorites, recent: next.recent, rooms: next.rooms ?? {}, rev: next.rev }, null, 2);
    await writeFileNow(FILE(), text);             // (a failed write is a 500 and nothing changes)
    prefs = next; exists = true;
    broadcast({ type: 'roomPrefs', prefs: answer() });
  }
  res.json(answer());
};
roomPrefsRoutes.post('/api/rooms/favorites', write);
roomPrefsRoutes.put('/api/rooms/favorites', write);
roomPrefsRoutes.post('/api/rooms/favorites/merge', write);
roomPrefsRoutes.post('/api/rooms/recent', write);
roomPrefsRoutes.post('/api/rooms/memory', write);

/** (tests) forget the in-memory copy. */
export function _resetRoomPrefs() { prefs = null; exists = false; }
