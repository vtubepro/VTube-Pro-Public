// Emotes + emote sounds in the helper (shared/emotes.ts, shared/emoteSounds.ts):
//
//   GET    /api/chat/emotes                     → EmoteListing (the streamer's channels' sets + global + seen in chat)
//   POST   /api/chat/emotes/refresh             → read every set again now                              (localhost only)
//   GET    /api/chat/emotes/stats               → EmoteStats (what chat used this stream)
//   POST   /api/chat/emotes/stats/reset         → start counting again                                  (localhost only)
//   GET    /api/chat/emote-sounds               → { cfg, sounds, builtins }
//   PUT    /api/chat/emote-sounds               → save config/emote_sounds.json (whole cfg or a patch)  (localhost only)
//   POST   /api/chat/emote-sounds/toggle        → { on?: boolean } master switch (missing = flip)        (localhost only)
//   POST   /api/chat/emote-sounds/test          → { snd, gain? } plays on the studio's "Only me" output (localhost only)
//   POST   /api/chat/emote-sounds/upload?name=  → raw audio body (≤ 3 MB: ogg / mp3 / wav / m4a / webm / flac)
//   GET    /api/chat/emote-sounds/file/:id      → the sound
//   DELETE /api/chat/emote-sounds/file/:id      → remove it (rules that used it are switched off)       (localhost only)
//
// Sounds the streamer adds live in the server's library (library/sounds/emotes/<id>.<ext>, index.json), next to the
// avatars. The trigger runs here, once per chat message (server/chat/hub.ts calls
// emoteSoundsOnChat), and sends {type:'showsound'} on the bus: only the studio plays it (OBS pages are silent).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { Router } from 'express';
import type { ChatEvent } from '../../shared/chat.ts';
import { BUILTIN_EMOTE_SOUNDS, DEFAULT_EMOTE_SOUNDS, EmoteSoundTrigger, isSoundRef, sanitizeEmoteSoundCfg, type EmoteSoundCfg, type UserSound } from '../../shared/emoteSounds.ts';
import { broadcast } from '../bus.ts';
import { HttpError } from '../library.ts';
import { CACHE_DIR, CONFIG_DIR, LIBRARY_DIR } from '../paths.ts';
import { requireLocal, sendAbsolute } from '../routes/util.ts';
import { emoteStore } from './emotes.ts';

const CFG_FILE = path.join(CONFIG_DIR, 'emote_sounds.json');
const SOUND_DIR = path.join(LIBRARY_DIR, 'sounds', 'emotes');
const INDEX = path.join(SOUND_DIR, 'index.json');
const MAX_BYTES = 3 << 20;
const MAX_SOUNDS = 100;

let cfg: EmoteSoundCfg | null = null;
export function emoteSoundCfg(): EmoteSoundCfg {
  if (cfg) return cfg;
  try { cfg = sanitizeEmoteSoundCfg(JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))); } catch { cfg = { ...DEFAULT_EMOTE_SOUNDS, rules: [], bots: [] }; }
  return cfg;
}
function saveCfg(next: EmoteSoundCfg) {
  cfg = next;
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); const tmp = CFG_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(next, null, 1)); fs.renameSync(tmp, CFG_FILE); }
  catch (e) { console.warn('[emote-sounds] save', e); }
}

// ---------------------------------------------------------------- the trigger (one per helper)
const trigger = new EmoteSoundTrigger();
/** Fires sent (tests / the panel's "last sounds" line). */
export const emoteSoundLog: { at: number; key: string; snd: string; id: string }[] = [];
/** The bots of the host's chat settings (Chat & events → More bots: cache/scene.json chat.bots), read at most every 10 s. */
let botsCache = { at: 0, list: [] as string[] };
function sceneBots(): string[] {
  const now = Date.now();
  if (now - botsCache.at < 10_000) return botsCache.list;
  botsCache = { at: now, list: [] };
  try { const s = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'scene.json'), 'utf8')) as { chat?: { bots?: unknown } }; if (Array.isArray(s.chat?.bots)) botsCache.list = s.chat.bots.filter((b): b is string => typeof b === 'string').map((b) => b.toLowerCase()).slice(0, 40); } catch { /* none */ }
  return botsCache.list;
}
/** A chat event left the hub: count its emotes, and play the sounds its emotes have (when switched on). */
export function emoteSoundsOnChat(e: ChatEvent, now = Date.now()) {
  if (e.kind !== 'chat') return;
  trigger.noteMessage(now);                                   // (every message: the raid / flood guard)
  const em = emoteStore.note(e);
  // (a Scene-tab "Test chat" line never sets off a sound on the stream mix: sounds are tested with the panel's Test,
  // which plays on the Only-me output)
  if (!em.length || e.test) return;
  const c = emoteSoundCfg();
  if (!c.on) return;
  for (const f of trigger.onMessage({ id: e.id, user: e.user, emotes: em, test: e.test, ...(e.badges ? { badges: e.badges } : {}) }, c, now, sceneBots())) {
    broadcast({ type: 'showsound', id: f.id, s: { k: 'emote', snd: f.snd, gain: f.gain } });
    emoteSoundLog.push({ at: now, key: f.key, snd: f.snd, id: f.id });
    if (emoteSoundLog.length > 50) emoteSoundLog.shift();
  }
}

// ---------------------------------------------------------------- the streamer's own sounds
function readIndex(): UserSound[] {
  try { const j = JSON.parse(fs.readFileSync(INDEX, 'utf8')); return Array.isArray(j) ? j.filter((s) => s && /^[a-f0-9]{16}$/.test(s.id)).slice(0, MAX_SOUNDS) : []; } catch { return []; }
}
function writeIndex(list: UserSound[]) { fs.mkdirSync(SOUND_DIR, { recursive: true }); const tmp = INDEX + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(list, null, 1)); fs.renameSync(tmp, INDEX); }
/** What the bytes are (never what the name or the browser says). */
export function sniffAudio(b: Buffer): { type: string; ext: string } | null {
  if (b.length < 12) return null;
  const s = (i: number, n: number) => b.subarray(i, i + n).toString('latin1');
  if (s(0, 4) === 'OggS') return { type: 'audio/ogg', ext: 'ogg' };
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE') return { type: 'audio/wav', ext: 'wav' };
  if (s(0, 4) === 'fLaC') return { type: 'audio/flac', ext: 'flac' };
  if (s(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { type: 'audio/mpeg', ext: 'mp3' };
  if (s(4, 4) === 'ftyp') return { type: 'audio/mp4', ext: 'm4a' };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { type: 'audio/webm', ext: 'webm' };
  return null;
}
const fileFor = (s: UserSound) => path.join(SOUND_DIR, `${s.id}.${s.type === 'audio/ogg' ? 'ogg' : s.type === 'audio/wav' ? 'wav' : s.type === 'audio/flac' ? 'flac' : s.type === 'audio/mpeg' ? 'mp3' : s.type === 'audio/mp4' ? 'm4a' : 'webm'}`);

// ---------------------------------------------------------------- routes
export const emoteRoutes = Router();
emoteRoutes.get('/api/chat/emotes', (_req, res) => { res.json(emoteStore.listing()); });
emoteRoutes.post('/api/chat/emotes/refresh', async (req, res) => { requireLocal(req); await emoteStore.refresh(true); res.json(emoteStore.listing()); });
emoteRoutes.get('/api/chat/emotes/stats', (_req, res) => { res.json(emoteStore.stats()); });
emoteRoutes.post('/api/chat/emotes/stats/reset', (req, res) => { requireLocal(req); emoteStore.resetStats(); res.json(emoteStore.stats()); });

const view = () => ({ cfg: emoteSoundCfg(), sounds: readIndex(), builtins: BUILTIN_EMOTE_SOUNDS.map(({ id, label }) => ({ id, label })), last: emoteSoundLog.slice(-5) });
emoteRoutes.get('/api/chat/emote-sounds', (_req, res) => { res.json(view()); });
emoteRoutes.put('/api/chat/emote-sounds', (req, res) => {
  requireLocal(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  // a patch keeps what it doesn't mention (the Stream Deck may flip `on` while the panel edits a rule)
  saveCfg(sanitizeEmoteSoundCfg({ ...emoteSoundCfg(), ...b }));
  res.json(view());
});
/** Master switch (the panel, the Stream Deck action "Emote sounds on / off"). */
export function setEmoteSoundsOn(on?: boolean): boolean {
  const c = emoteSoundCfg();
  saveCfg({ ...c, on: typeof on === 'boolean' ? on : !c.on });
  return emoteSoundCfg().on;
}
emoteRoutes.post('/api/chat/emote-sounds/toggle', (req, res) => {
  requireLocal(req);
  const on = (req.body ?? {}).on;
  setEmoteSoundsOn(typeof on === 'boolean' ? on : undefined);
  res.json(view());
});
emoteRoutes.post('/api/chat/emote-sounds/test', (req, res) => {
  requireLocal(req);
  const b = (req.body ?? {}) as { snd?: unknown; gain?: unknown };
  if (!isSoundRef(b.snd)) throw new HttpError(400, 'Pick a sound first');
  if (b.snd.startsWith('u:') && !readIndex().some((s) => `u:${s.id}` === b.snd)) throw new HttpError(404, 'That sound is not on this PC any more');
  const gain = typeof b.gain === 'number' && Number.isFinite(b.gain) ? Math.min(1.5, Math.max(0, b.gain)) : 1;
  const id = `emotetest:${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  broadcast({ type: 'showsound', id, s: { k: 'emote', snd: b.snd, gain, only: true } });
  res.json({ ok: true, id });
});
emoteRoutes.post('/api/chat/emote-sounds/upload', express.raw({ type: () => true, limit: MAX_BYTES }), (req, res) => {
  requireLocal(req);
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!buf.length) throw new HttpError(400, 'The file was empty');
  if (buf.length > MAX_BYTES) throw new HttpError(413, 'That sound is bigger than 3 MB: use a shorter clip');
  const kind = sniffAudio(buf);
  if (!kind) throw new HttpError(415, 'That file is not a sound VTube Pro can play (use .mp3, .ogg, .wav, .m4a, .webm or .flac)');
  const list = readIndex();
  const id = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
  const name = String(req.query.name ?? '').replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[^\p{L}\p{N} _().-]/gu, '').trim().slice(0, 40) || 'My sound';
  if (!list.some((s) => s.id === id)) {
    if (list.length >= MAX_SOUNDS) throw new HttpError(409, `You have ${MAX_SOUNDS} sounds: remove one first`);
    const s: UserSound = { id, name, type: kind.type, bytes: buf.length };
    fs.mkdirSync(SOUND_DIR, { recursive: true });
    fs.writeFileSync(fileFor(s), buf);
    writeIndex([...list, s]);
  }
  res.json({ ...view(), added: `u:${id}` });
});
emoteRoutes.get('/api/chat/emote-sounds/file/:id', (req, res) => {
  const s = readIndex().find((x) => x.id === String(req.params.id));
  if (!s || !fs.existsSync(fileFor(s))) throw new HttpError(404, 'No such sound');
  sendAbsolute(res, fileFor(s), { headers: { 'Content-Type': s.type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600' } });
});
emoteRoutes.delete('/api/chat/emote-sounds/file/:id', (req, res) => {
  requireLocal(req);
  const id = String(req.params.id);
  const list = readIndex(), s = list.find((x) => x.id === id);
  if (!s) throw new HttpError(404, 'No such sound');
  try { fs.rmSync(fileFor(s), { force: true }); } catch { /* gone already */ }
  writeIndex(list.filter((x) => x.id !== id));
  const c = emoteSoundCfg();
  if (c.rules.some((r) => r.snd === `u:${id}`)) saveCfg({ ...c, rules: c.rules.map((r) => (r.snd === `u:${id}` ? { ...r, on: false } : r)) });
  res.json(view());
});
