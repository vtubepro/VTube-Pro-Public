// RAM-only vault for party members' SEALED avatars (docs/MULTIPLAYER_DISCORD.md "Model custody").
//
// The studio seals every received model / costume / profile with a per-member AES-GCM key BEFORE it gets here, so
// this process only ever holds ciphertext. Nothing is written to disk. An item is readable only
//   * from this machine (loopback socket, and no foreign Origin — a website can't read it cross-origin),
//   * with its capability (random 256-bit, sent in a header, never in a URL; only its SHA-256 is kept),
// and is served with Cache-Control: no-store so no browser / OBS (CEF) disk cache keeps a copy.
// Items belong to a studio session: gone when the studio purges it (member left, party ended, page closed) or stops
// heart-beating for 60 s (crash / closed tab), and of course when the server restarts.
import crypto from 'node:crypto';
import type { Request } from 'express';
import { HttpError } from './library.ts';
import { streamPcOf } from './streamPcMark.ts';
import { PARTY_MAX_MODEL } from '../shared/partyXfer.ts';

interface Item { id: string; session: string; capHash: Buffer; data: Buffer; at: number }
interface Session { items: Set<string>; alive: number }

const items = new Map<string, Item>();
const sessions = new Map<string, Session>();
// One sealed item = a whole model / costume (≤ PARTY_MAX_MODEL) + 28 bytes of AES-GCM iv + tag. This was 72 MB while
// the party carried up to 256 MB: every model over ~72 MB arrived and was then refused here ("vault 413") — the
// member stayed "waiting for avatar" forever although the owner was sharing it (mpfix, 2026-09-26).
export const VAULT_MAX_ITEM = PARTY_MAX_MODEL + 1024 * 1024;
// 7 guests' models + costumes, plus the old copy of one being replaced (put before drop)
const MAX_TOTAL = 2560 * 1024 * 1024;
const IDLE_MS = 60_000;
const SESSION = /^[a-z0-9]{16,48}$/;
const ID = /^[a-f0-9]{32}$/;
let total = 0;

const sha = (s: string) => crypto.createHash('sha256').update(s).digest();
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/i;

/** Loopback socket + (if the browser sent one) a loopback Origin. Blocks other websites and LAN clients. */
export function requireLocalPage(req: Request) {
  // a paired stream PC's output page may READ sealed blobs (it gets the key over the bus, opens them in RAM; no-store)
  if (streamPcOf(req) && (req.method === 'GET' || req.method === 'HEAD')) return;
  const addr = req.socket.remoteAddress ?? '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) throw new HttpError(403, 'localhost only');
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let host = '';
    try { host = new URL(origin).hostname; } catch { /* bad origin */ }
    if (!LOOPBACK_HOST.test(host) && !LOOPBACK_HOST.test(`[${host}]`)) throw new HttpError(403, 'foreign origin');
  } else if (origin === 'null') throw new HttpError(403, 'opaque origin');
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site') throw new HttpError(403, 'cross-site request');
}

function sessionOf(id: string): Session {
  if (!SESSION.test(id)) throw new HttpError(400, 'bad session');
  let s = sessions.get(id);
  if (!s) { s = { items: new Set(), alive: Date.now() }; sessions.set(id, s); }
  return s;
}

export function vaultPut(sessionId: string, data: Buffer): { id: string; cap: string } {
  if (!Buffer.isBuffer(data) || data.length < 29 || data.length > VAULT_MAX_ITEM) throw new HttpError(400, 'bad sealed blob');
  if (total + data.length > MAX_TOTAL) throw new HttpError(507, 'vault full');
  const s = sessionOf(sessionId);
  const id = crypto.randomBytes(16).toString('hex');
  const cap = crypto.randomBytes(32).toString('base64url');
  // own copy (the request buffer may be pooled)
  const own = Buffer.allocUnsafeSlow(data.length);
  data.copy(own);
  items.set(id, { id, session: sessionId, capHash: sha(cap), data: own, at: Date.now() });
  s.items.add(id);
  s.alive = Date.now();
  total += own.length;
  return { id, cap };
}

function check(id: string, cap: unknown): Item {
  if (!ID.test(id) || typeof cap !== 'string' || cap.length > 64) throw new HttpError(404, 'not found');
  const it = items.get(id);
  // same answer for unknown id and wrong cap
  if (!it || !crypto.timingSafeEqual(it.capHash, sha(cap))) throw new HttpError(404, 'not found');
  return it;
}
export function vaultGet(id: string, cap: unknown): Buffer { return check(id, cap).data; }
export function vaultDrop(id: string, cap: unknown) { drop(check(id, cap)); }
function drop(it: Item) {
  it.data.fill(0);
  total -= it.data.length;
  items.delete(it.id);
  sessions.get(it.session)?.items.delete(it.id);
}
export function vaultAlive(sessionId: string) { const s = sessions.get(sessionId); if (s) s.alive = Date.now(); return !!s; }
export function vaultPurge(sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) return 0;
  let n = 0;
  for (const id of [...s.items]) { const it = items.get(id); if (it) { drop(it); n++; } }
  sessions.delete(sessionId);
  return n;
}
export function vaultStats() { return { items: items.size, sessions: sessions.size, bytes: total }; }

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.alive > IDLE_MS) { vaultPurge(id); }
}, 10_000).unref();
