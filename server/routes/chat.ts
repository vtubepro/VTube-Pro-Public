// Live chat + support events (server/chat/*, docs/SCENES.md "Chat & events").
//
//   GET  /api/chat/status            → ChatStatus (per-platform connection state)
//   GET  /api/chat/recent?n=60       → { evs: ChatEvent[], tot } (pages that load mid-stream)
//   GET  /api/chat/config            → ChatConfigPublic (no secrets)                          (localhost only)
//   PUT  /api/chat/config            → save config/chat.json, restart the connectors            (localhost only)
//   POST /api/chat/import-overlay     → { dir, apply? } read an earlier overlay's config.json    (localhost only)
//   POST /api/chat/test              → { what, platform?, amount?, user? } a local test event (never sent anywhere) (localhost only)
//   GET  /chat/connect               → the helper's own page for the Rumble link / TikFinity (this PC only)
// Secrets (the Rumble key) and connector addresses never come from a web page: server/chat/connectPage.ts.
//   POST /api/chat/totals/reset      → zero the session totals (goal bar)                     (localhost only)
//   GET  /api/chat/img?u=<https url> → emote image via this PC (allow-listed CDNs, cached in cache/chat/img)
//   /api/chat/emotes*, /api/chat/emote-sounds*  → the streamer's emotes + emote sounds (server/chat/emoteSounds.ts)
import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from '../library.ts';
import { CHAT_CACHE, chatHub } from '../chat/hub.ts';
import { loadChatConfig, OVERLAY_DEFAULT_DIR, publicChatConfig, readOverlayConfig, sanitizeChatConfig, saveChatConfig, type ChatConfig } from '../chat/config.ts';
import { requireLocal, sendAbsolute } from './util.ts';
import { streamPcOf } from '../streamPcMark.ts';
import { hostHub, hostHubRoutes } from '../chat/hostHub.ts';
import { pollHooks, pollRoutes, testVoteHook } from '../poll.ts';
import { goalsTotalsReset } from '../goals.ts';
import { audienceRoutes } from '../audience.ts';
import { chatWriteGuard, connectPageRoutes } from '../chat/connectPage.ts';
import { LIVE_PLATFORMS, type LivePlatform } from '../../shared/chat.ts';
import { emoteRoutes } from '../chat/emoteSounds.ts';

export const chatRoutes = Router();
chatRoutes.use(chatWriteGuard);     // lane stream-setup: no chat keys / connector addresses from a web page (first!)
chatRoutes.use(connectPageRoutes);  // GET /chat/connect: where the Rumble link is added, on this PC
chatRoutes.use(hostHubRoutes); // host Chat Hub: events queue, acknowledge, TTS, Stream Deck, ingest (server/chat/hostHub.ts)
chatRoutes.use(pollRoutes);    // chat polls: /api/poll/* (server/poll.ts)
chatRoutes.use(emoteRoutes);   // the streamer's emotes (7TV / BTTV / FFZ / Kick / Twitch / YouTube) + emote sounds
chatRoutes.use(audienceRoutes); // the chat audience + !ask questions: /api/audience/* (server/audience.ts)
pollHooks.sendChat = (text) => { let n = 0; for (const c of chatHub.senders()) { try { if (text) void Promise.resolve(c.send(text)).catch(() => {}); n++; } catch { /* */ } } return n; };
pollHooks.canSend = () => chatHub.senders().length > 0;
pollHooks.say = (text) => hostHub().say(text, 'poll', 'obs');
testVoteHook.send = (c) => chatHub.onChat({ platform: c.platform as never, username: c.user, message: c.text, ts: Date.now(), badges: c.badges, id: `test:vote:${Date.now()}:${Math.random().toString(36).slice(2, 8)}` }, true);

chatRoutes.get('/api/chat/status', (_req, res) => { res.json(chatHub.snapshot()); });
chatRoutes.get('/api/chat/recent', (req, res) => {
  const n = Math.max(1, Math.min(160, parseInt(String(req.query.n ?? '60'), 10) || 60));
  // + the last support events even when chat buried them (the support board lists them)
  const evs = chatHub.recent(n), have = new Set(evs.map((e) => e.id));
  const fin = chatHub.support(12).filter((e) => !have.has(e.id));
  res.json({ evs: [...fin, ...evs], tot: chatHub.totals });
});

chatRoutes.get('/api/chat/config', (req, res) => { requireLocal(req); res.json({ ...publicChatConfig(loadChatConfig()), overlayDir: OVERLAY_DEFAULT_DIR }); });
chatRoutes.put('/api/chat/config', (req, res) => {
  requireLocal(req);
  const body = (req.body ?? {}) as Record<string, unknown> & { rumble?: Record<string, unknown>; clearRumbleKey?: boolean };
  const cur = loadChatConfig();
  // an empty key field means "keep the saved one" (the studio never sees it); clearRumbleKey removes it
  if (body.rumble && (body.rumble.apiKey === '' || body.rumble.apiKey === undefined)) delete body.rumble.apiKey;
  const next = sanitizeChatConfig(body, cur);
  if (body.clearRumbleKey === true) { next.rumble.apiKey = ''; next.rumble.enabled = false; }
  saveChatConfig(next);
  chatHub.start();
  res.json(publicChatConfig(next));
});

chatRoutes.post('/api/chat/import-overlay', (req, res) => {
  requireLocal(req);
  const b = (req.body ?? {}) as { dir?: unknown; apply?: unknown };
  const { cfg, preview } = readOverlayConfig(typeof b.dir === 'string' && b.dir.trim() ? b.dir.trim() : OVERLAY_DEFAULT_DIR);
  if (!preview.ok || b.apply !== true) { res.json({ preview }); return; }
  const cur = loadChatConfig();
  const imported = cfg as ChatConfig;
  // imported values win where the overlay has them; nothing else of the overlay's config is read
  const next = sanitizeChatConfig({
    kick: imported.kick.channel ? imported.kick : cur.kick,
    rumble: imported.rumble.apiKey ? imported.rumble : cur.rumble,
    youtube: imported.youtube.handle || imported.youtube.channelId || imported.youtube.videoId ? imported.youtube : cur.youtube,
    names: cur.names, vips: imported.vips.length ? imported.vips : cur.vips, emotes: cur.emotes,
  }, cur);
  saveChatConfig(next);
  chatHub.start();
  res.json({ preview, config: publicChatConfig(next) });
});

chatRoutes.post('/api/chat/test', (req, res) => {
  requireLocal(req);
  const b = (req.body ?? {}) as { what?: unknown; platform?: unknown; amount?: unknown; user?: unknown };
  const what = String(b.what ?? 'chat').slice(0, 20);
  // stream-setup: "Send a test message" from one platform's card shows that platform's icon
  const platform = LIVE_PLATFORMS.includes(b.platform as LivePlatform) ? b.platform as LivePlatform : undefined;
  // (optional size: alert-reaction tiers — a $150 Super Chat, a 20-sub gift, a 40-viewer raid; still local-only + marked test)
  const amount = typeof b.amount === 'number' && Number.isFinite(b.amount) ? b.amount : undefined;
  const user = typeof b.user === 'string' ? b.user : undefined;
  res.json({ ok: true, sent: chatHub.test(what, platform, { amount, user }) });
});
chatRoutes.post('/api/chat/totals/reset', (req, res) => { requireLocal(req); chatHub.resetTotals(); goalsTotalsReset(); res.json(chatHub.totals); });

// ---------------------------------------------------------------- emote image proxy
// (exact CDN host names only; cdn.betterttv.net + cdn.frankerfacez.com: the BTTV / FFZ emotes, shared/emotes.ts)
export const IMG_HOSTS = /^(files\.kick\.com|cdn\.7tv\.app|cdn\.betterttv\.net|cdn\.frankerfacez\.com|yt[34]\.ggpht\.com|[\w-]+\.ggpht\.com|[\w-]+\.googleusercontent\.com|i\.ytimg\.com|static-cdn\.jtvnw\.net|[\w-]+\.tiktokcdn(-us)?\.com|[\w-]+\.rumble\.com|rumble\.com)$/i;
/** GET an allow-listed image, following at most 3 redirects and only to allow-listed https hosts (never anywhere else). */
async function fetchImage(href: string): Promise<Response> {
  let u = href;
  for (let hop = 0; hop < 4; hop++) {
    const r = await fetch(u, { headers: { 'User-Agent': 'vtube-pro/1.0' }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if (r.status < 300 || r.status >= 400) return r;
    const loc = r.headers.get('location');
    let next: URL;
    try { next = new URL(loc ?? '', u); } catch { throw new HttpError(502, 'bad redirect'); }
    if (next.protocol !== 'https:' || !IMG_HOSTS.test(next.hostname)) throw new HttpError(502, 'redirect to a host that is not allowed');
    u = next.href;
  }
  throw new HttpError(502, 'too many redirects');
}
const IMG_DIR = path.join(CHAT_CACHE, 'img');
const IMG_MAX = 2 << 20;
/** A raster image type (never SVG: opened directly, an SVG could run script on this helper's origin). */
export const imageTypeOk = (type: string) => /^image\//i.test(type) && !/svg/i.test(type);
/** The body, read as it streams in and cut off past `max` (a huge allow-listed file is never buffered whole). */
export async function readCapped(r: Response, max = IMG_MAX): Promise<Buffer> {
  const len = Number(r.headers.get('content-length') ?? '');
  if (Number.isFinite(len) && len > max) { try { await r.body?.cancel(); } catch { /* gone */ } throw new HttpError(413, 'too big'); }
  if (!r.body) return Buffer.alloc(0);
  const reader = r.body.getReader(), parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { try { await reader.cancel(); } catch { /* gone */ } throw new HttpError(413, 'too big'); }
    parts.push(value);
  }
  return Buffer.concat(parts);
}
const inflight = new Map<string, Promise<{ type: string; file?: string; buf?: Buffer }>>();
/** key -> content type of the images already on disk: a chat full of emotes and avatars asks for dozens of them per
 *  second, so a cached hit costs no file read (the type file was a sync read per image). Bounded; oldest out first. */
const imgTypes = new Map<string, string>();
const IMG_TYPES_MAX = 4000;
function rememberType(key: string, type: string) {
  imgTypes.delete(key); imgTypes.set(key, type);
  if (imgTypes.size > IMG_TYPES_MAX) imgTypes.delete(imgTypes.keys().next().value!);
}
/** The emote / avatar picture cache on disk: pictures not asked for in 30 days go, and when it is over 512 MB the least
 *  recently asked-for go first until it is under. A minute after start, then once a day. */
export const IMG_KEEP_MS = 30 * 24 * 3600 * 1000;
export const IMG_CACHE_MAX_BYTES = 512 * 1024 ** 2;
export async function pruneImgCache(dir: string, o: { now?: number; keepMs?: number; maxBytes?: number; forget?: (key: string) => void } = {}) {
  const now = o.now ?? Date.now(), keepMs = o.keepMs ?? IMG_KEEP_MS, maxBytes = o.maxBytes ?? IMG_CACHE_MAX_BYTES;
  let names: string[] = [];
  try { names = await fsp.readdir(dir); } catch { return { removed: 0, bytes: 0 }; }
  const items: { key: string; used: number; size: number }[] = [];
  for (const n of names) {
    if (!/^[0-9a-f]{40}$/.test(n)) continue;
    try {
      const st = await fsp.stat(path.join(dir, n));
      const ty = await fsp.stat(path.join(dir, `${n}.type`)).catch(() => null);
      items.push({ key: n, used: Math.max(st.atimeMs, st.mtimeMs), size: st.size + (ty?.size ?? 0) });
    } catch { /* gone */ }
  }
  items.sort((a, b) => a.used - b.used);   // least recently asked for first
  let total = items.reduce((t, i) => t + i.size, 0), removed = 0;
  for (const i of items) {
    if (now - i.used <= keepMs && total <= maxBytes) break;
    try { await fsp.unlink(path.join(dir, i.key)); await fsp.rm(path.join(dir, `${i.key}.type`), { force: true }); o.forget?.(i.key); total -= i.size; removed++; } catch { /* in use */ }
  }
  return { removed, bytes: total };
}
// The running total of the cache on disk (null until the first prune pass has measured it), plus the bytes of pictures
// being written right now (reserved before the write, so parallel misses for different pictures can't all fit in the
// same room). Past the cap a prune pass runs at once (one at a time); while the cache is well over (a prune can't keep
// up), or before it has been measured at all, new pictures are passed through without being written.
let imgBytes: number | null = null;
let imgPending = 0;
let pruning: Promise<unknown> | null = null;
function prune() {
  pruning ??= pruneImgCache(IMG_DIR, { forget: (k) => imgTypes.delete(k) }).then((r) => { imgBytes = r.bytes; }, () => {}).finally(() => { pruning = null; });
  return pruning;
}
/** Reserves room in the picture cache for `bytes` more (false: pass this one through, don't write it). A true answer
 *  must be settled with imgCacheSettle once the write is done or has failed. */
function imgCacheRoom(bytes: number): boolean {
  if (imgBytes === null) { void prune(); return false; }
  const after = imgBytes + imgPending + bytes;
  if (after > IMG_CACHE_MAX_BYTES) void prune();
  if (after > IMG_CACHE_MAX_BYTES * 1.25) return false;
  imgPending += bytes;
  return true;
}
function imgCacheSettle(bytes: number, written: boolean) {
  imgPending = Math.max(0, imgPending - bytes);
  if (written && imgBytes !== null) imgBytes += bytes;
}
/** A cache hit marks the picture used (its mtime, what the prune ranks by), at most once an hour per picture. */
const touched = new Map<string, number>();
function touchImg(key: string, file: string) {
  const now = Date.now();
  if (now - (touched.get(key) ?? 0) < 3600_000) return;
  touched.delete(key); touched.set(key, now);
  if (touched.size > IMG_TYPES_MAX) touched.delete(touched.keys().next().value!);
  const t = now / 1000;
  void fsp.utimes(file, t, t).catch(() => {});
}
setTimeout(() => { void prune(); setInterval(() => { void prune(); }, 24 * 3600 * 1000).unref(); }, 60_000).unref();
/** Tests: the cache's running total and the prune that keeps it. */
export const imgCacheState = { bytes: () => imgBytes, pending: () => imgPending, prune, room: imgCacheRoom, settle: imgCacheSettle, touch: touchImg, dir: IMG_DIR };
chatRoutes.get('/api/chat/img', async (req, res) => {
  const u = String(req.query.u ?? '');
  let url: URL;
  try { url = new URL(u); } catch { throw new HttpError(400, 'Bad url'); }
  if (url.protocol !== 'https:' || !IMG_HOSTS.test(url.hostname)) throw new HttpError(403, 'Host not allowed');
  const key = crypto.createHash('sha1').update(url.href).digest('hex');
  const file = path.join(IMG_DIR, key);
  const send = (type: string, f: string) => { res.setHeader('Content-Type', type); res.setHeader('Cache-Control', 'public, max-age=86400'); res.setHeader('X-Content-Type-Options', 'nosniff'); sendAbsolute(res, f); };
  const known = imgTypes.get(key);
  if (known) { touchImg(key, file); send(known, file); return; }
  try {
    const type = await fsp.readFile(file + '.type', 'utf8');
    if (imageTypeOk(type)) { await fsp.access(file); rememberType(key, type); touchImg(key, file); send(type, file); return; }
  } catch { /* not cached */ }
  // a paired STREAM PC (server/streamPc.ts) is display-only: no redirects followed (only the allow-listed host itself
  // answers), nothing written to this PC's cache, the image passed straight through
  if (streamPcOf(req)) {
    const r = await fetch(url.href, { headers: { 'User-Agent': 'vtube-pro/1.0' }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const type = r.headers.get('content-type') ?? '';
    if (r.status !== 200 || !imageTypeOk(type)) { try { await r.body?.cancel(); } catch { /* gone */ } throw new HttpError(502, `upstream ${r.status}`); }
    const buf = await readCapped(r);
    res.setHeader('Content-Type', type); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(buf);
    return;
  }
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      const r = await fetchImage(url.href);
      const type = r.headers.get('content-type') ?? '';
      if (!r.ok || !imageTypeOk(type)) { try { await r.body?.cancel(); } catch { /* gone */ } throw new HttpError(502, `upstream ${r.status}`); }
      const buf = await readCapped(r);
      const size = buf.length + type.length;
      if (!imgCacheRoom(size)) return { type, buf };   // cache full (or not measured yet): shown, not kept
      try {
        await fsp.mkdir(IMG_DIR, { recursive: true });
        await fsp.writeFile(file, buf); await fsp.writeFile(file + '.type', type);
      } catch { imgCacheSettle(size, false); await fsp.rm(file, { force: true }).catch(() => {}); return { type, buf }; }
      imgCacheSettle(size, true);
      rememberType(key, type);
      return { type, file };
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  const got = await p;
  if (got.buf) { res.setHeader('Content-Type', got.type); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.end(got.buf); return; }
  send(got.type, got.file!);
});

/** Server start: connect only what the performer enabled (nothing without config/chat.json). */
export function startChat() { try { if (fs.existsSync(path.dirname(CHAT_CACHE))) chatHub.start(); hostHub(); } catch (e) { console.warn('[chat] start failed', e); } }
