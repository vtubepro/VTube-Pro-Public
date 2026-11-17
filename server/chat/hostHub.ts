// Host Chat Hub (shared/chathub.ts, docs/CHAT_HUB.md): the events queue (support + stream events) with acknowledge /
// "thank on stream", and text-to-speech of support messages — rendered with this PC's Windows voices
// (server/ttrpg/systemVoice.ts, the AI GM's voice) and played by the OBS page (on stream) or only in the Chat Hub window.
//
//   GET  /api/chathub/state                 → HubSnapshot
//   POST /api/chathub/ack      { id, ack? } → mark read / unread
//   POST /api/chathub/thank    { id }       → replay the alert / celebration on stream (+ mark read)
//   POST /api/chathub/do/:action · GET /api/chathub/do/:action?key=… → Stream Deck / hotkeys (shared HUB_ACTIONS)
//   PUT  /api/chathub/tts      TtsSettings  → save config/chathub.json
//   POST /api/chathub/tts/read { id } · /tts/say { text } (test) · /tts/skip · /tts/replay
//   GET  /api/chathub/tts/audio/:id         → the rendered line (WAV from this PC's voices or Kokoro; short-lived)
//   POST /api/chat/ingest      {…}          → push an event from another tool (Streamer.bot, TikTok bridges, scripts)
// Everything is localhost-only except the Stream Deck GET, which needs the per-PC deck key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request } from 'express';
import { sanitizeChatEvent, type ChatEvent, type LivePlatform } from '../../shared/chat.ts';
import { DEFAULT_TTS, HUB_ACTIONS, isHubEvent, sanitizeTts, ttsFilter, ttsSkipReason, ttsText, type ChatHubBus, type HubAction, type HubItem, type HubSnapshot, type HubTtsStatus, type TtsSettings } from '../../shared/chathub.ts';
import { broadcast } from '../bus.ts';
import { HttpError } from '../library.ts';
import { CONFIG_DIR } from '../paths.ts';
import { requireLocal } from '../routes/util.ts';
import { systemSay, systemVoiceSupported, systemVoices } from '../ttrpg/systemVoice.ts';
import { LineSkipped, ReadAloudVoice } from './readAloudVoice.ts';
import { kokoro } from '../kokoro.ts';
import { CHAT_CACHE, chatHub, chatListeners } from './hub.ts';
import { writeFileSoon } from '../library.ts';

const FILE = path.join(CONFIG_DIR, 'chathub.json');
const ACK_FILE = path.join(CHAT_CACHE, 'hub-acks.json');
const KEEP = 300;

const send = (m: ChatHubBus) => broadcast({ type: 'chathub', m });

class HostHub {
  items: HubItem[] = [];
  tts: TtsSettings = { ...DEFAULT_TTS };
  deckKey = '';
  private acked = new Set<string>();
  private queue: string[] = [];
  private now: string | null = null;
  private last: string | null = null;
  private audio = new Map<string, { buf: Buffer; type: string; at: number }>();
  private err = '';
  private voices: string[] = [];
  private wake: (() => void) | null = null;
  private running = false;
  /** This computer's voices or Kokoro (+ its fallback: server/chat/readAloudVoice.ts). */
  readonly voice = new ReadAloudVoice({
    system: (text, o) => systemSay(text, o),
    kokoro: (text, o) => kokoro.say(text, o),
  });

  constructor() {
    try {
      const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      this.tts = sanitizeTts(j.tts);
      if (typeof j.deckKey === 'string' && /^[a-f0-9]{16,64}$/.test(j.deckKey)) this.deckKey = j.deckKey;
    } catch { /* first run */ }
    try { for (const id of JSON.parse(fs.readFileSync(ACK_FILE, 'utf8'))) if (typeof id === 'string') this.acked.add(id); } catch { /* */ }
    if (!this.deckKey) this.deckKey = crypto.randomBytes(12).toString('hex');
    // catch up with what the chat hub already has (a server restart mid-stream)
    for (const e of [...chatHub.support(30), ...chatHub.recent(160)]) this.add(e, false);
    chatListeners.add((e) => this.add(e, true));
  }

  private save() {
    try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ tts: this.tts, deckKey: this.deckKey }, null, 2)); fs.renameSync(tmp, FILE); } catch (e) { console.warn('[chathub] save', e); }
  }
  /** At most one write a second, off the event loop (server/library.ts writeFileSoon; the list is made at write time). */
  private saveAcks() {
    writeFileSoon(ACK_FILE, () => { const keep = new Set(this.items.map((i) => i.e.id)); return JSON.stringify([...this.acked].filter((id) => keep.has(id)).slice(-600)); }, 1000);
  }

  snapshot(): HubSnapshot { return { items: this.items, tts: this.tts, ttsStatus: this.status(), deckKey: this.deckKey }; }
  status(): HubTtsStatus { return { ok: systemVoiceSupported() && !this.err, error: this.err, now: this.now, queue: [...this.queue], voices: this.voices, voice: this.voice.status() }; }
  private pushStatus(withSettings = false) { send({ k: 'ttsStatus', s: this.status(), ...(withSettings ? { tts: this.tts } : {}) }); }
  pushStatusNow() { this.pushStatus(true); }
  private pushItems(items: HubItem[]) { if (items.length) send({ k: 'items', items }); }
  find(id: string) { return this.items.find((i) => i.e.id === id); }

  add(e: ChatEvent, live: boolean) {
    if (!isHubEvent(e) || this.find(e.id)) return;
    const it: HubItem = { e, ack: this.acked.has(e.id), tts: '' };
    this.items.push(it);
    this.items.sort((a, b) => a.e.ts - b.e.ts);
    if (this.items.length > KEEP) this.items.splice(0, this.items.length - KEEP);
    if (live) {
      const why = ttsSkipReason(e, this.tts);
      if (!why) { it.tts = 'queued'; this.queue.push(e.id); void this.run(); }
      else if (this.tts.on && why !== 'not support') it.tts = 'filtered';
      this.pushItems([it]);
      if (it.tts === 'queued') this.pushStatus();
    }
  }

  ack(id: string, ack = true) {
    const it = this.find(id);
    if (!it) throw new HttpError(404, 'No such event');
    it.ack = ack;
    if (ack) this.acked.add(id); else this.acked.delete(id);
    this.saveAcks();
    this.pushItems([it]);
    return it;
  }

  thank(id: string) {
    const it = this.find(id);
    if (!it) throw new HttpError(404, 'No such event');
    const e = sanitizeChatEvent({ ...it.e, id: `${it.e.id}~ty${Date.now().toString(36)}`, ts: Date.now(), cue: true });
    if (e) broadcast({ type: 'chat', evs: [e] });
    it.thanked = true;
    return this.ack(id, true);
  }

  act(a: HubAction) {
    const next = () => this.items.find((i) => !i.ack);
    switch (a) {
      case 'ack-next': { const n = next(); return n ? this.ack(n.e.id) : null; }
      case 'thank-next': { const n = next(); return n ? this.thank(n.e.id) : null; }
      case 'ack-all': { const ch: HubItem[] = []; for (const i of this.items) if (!i.ack) { i.ack = true; this.acked.add(i.e.id); ch.push(i); } this.saveAcks(); this.pushItems(ch); return ch.length; }
      case 'skip': return this.skip();
      case 'replay': return this.replay();
      case 'tts-on': case 'tts-off': case 'tts-toggle':
        this.setTts({ on: a === 'tts-on' ? true : a === 'tts-off' ? false : !this.tts.on }); return this.tts.on;
    }
  }

  setTts(p: Partial<TtsSettings>) {
    this.tts = sanitizeTts(p, this.tts);
    if (!this.tts.on) this.clearQueue();
    this.save();
    this.pushStatus(true);
    return this.tts;
  }

  private clearQueue() {
    const ch: HubItem[] = [];
    for (const id of this.queue) { const it = this.find(id); if (it) { it.tts = 'skipped'; ch.push(it); } }
    this.queue = [];
    this.pushItems(ch);
    this.skip();
  }

  // ---------------------------------------------------------------- text-to-speech
  read(id: string) {
    const it = this.find(id);
    if (!it) throw new HttpError(404, 'No such event');
    if (!this.queue.includes(id)) this.queue.unshift(id);
    it.tts = 'queued'; this.pushItems([it]); this.pushStatus();
    void this.run();
  }
  skip() {
    if (!this.now) return false;
    const it = this.find(this.now);
    if (it) { it.tts = 'skipped'; this.pushItems([it]); }
    send({ k: 'hush' });
    this.wake?.();
    return true;
  }
  replay() {
    const id = this.now ?? this.last;
    if (!id || !this.find(id)) return false;
    if (this.now) this.skip();
    this.read(id);
    return true;
  }

  async say(text: string, id: string, where: TtsSettings['where'] = this.tts.where) {
    const noteAt = this.voice.status().noteAt;
    let a;
    try { a = await this.voice.render(text, this.tts); }
    catch (e) { if (e instanceof LineSkipped) return -1; throw e; }      // nothing this voice can say: the line is skipped, no error
    this.play(a.audio, a.type, id, where, text);
    if (this.voice.status().noteAt !== noteAt) this.pushStatus();     // (a new voice status line)
    return a.dur;
  }
  /** Keep a rendered line a few minutes and tell the studio to play it (the mixer's Read-aloud row). */
  play(buf: Buffer, type: string, id: string, where: TtsSettings['where'], text: string) {
    const aid = crypto.randomBytes(10).toString('hex');
    this.audio.set(aid, { buf, type, at: Date.now() });
    for (const [k, v] of this.audio) if (this.audio.size > 24 || Date.now() - v.at > 10 * 60_000) this.audio.delete(k); else break;
    send({ k: 'tts', id, url: `/api/chathub/tts/audio/${aid}`, vol: this.tts.volume, where, text });
  }
  getAudio(id: string) { return this.audio.get(id); }

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!;
        const it = this.find(id);
        if (!it) continue;
        this.now = id;
        it.tts = 'playing'; this.pushItems([it]); this.pushStatus();
        try {
          const dur = await this.say(ttsText(it.e, this.tts), id);
          this.err = '';
          if (dur < 0) it.tts = 'skipped';        // (Kokoro: nothing speakable in this line)
          else {
            // wait for the line (+ a little network slack) or a skip
            await new Promise<void>((ok) => { const t = setTimeout(ok, Math.max(800, dur * 1000 + 600)); this.wake = () => { clearTimeout(t); ok(); }; });
            this.wake = null;
            if (it.tts === 'playing') it.tts = 'done';
          }
        } catch (e) {
          this.err = (e as Error).message.slice(0, 160);
          it.tts = 'skipped';
        }
        this.last = id; this.now = null;
        this.pushItems([it]); this.pushStatus();
        if (this.tts.gapMs) await new Promise((ok) => setTimeout(ok, this.tts.gapMs));
      }
    } finally { this.running = false; this.now = null; }
  }

  async loadVoices() {
    try { this.voices = (await systemVoices()).map((v) => v.name); this.err = this.voices.length ? '' : 'No Windows voices are installed.'; }
    catch (e) { this.err = (e as Error).message; }
    return this.voices;
  }
}

let hub: HostHub | null = null;
/** Created lazily (after the chat hub has read its log). */
export const hostHub = () => (hub ??= new HostHub());

// ---------------------------------------------------------------- routes
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
/** This PC only, and never from another website open in the browser (same rule as the TTRPG routes). */
function guard(req: Request) {
  requireLocal(req);
  const o = req.headers.origin;
  if (o && !LOOPBACK_ORIGIN.test(o)) throw new HttpError(403, 'Only VTube Pro pages on this PC may use this');
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site request refused');
}
const str = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '');
const bodyId = (req: Request) => { const id = str((req.body as { id?: unknown } | undefined)?.id, 200); if (!id) throw new HttpError(400, 'id?'); return id; };

export const hostHubRoutes = Router();

hostHubRoutes.get('/api/chathub/state', (req, res) => { guard(req); res.json(hostHub().snapshot()); });
hostHubRoutes.post('/api/chathub/ack', (req, res) => { guard(req); res.json(hostHub().ack(bodyId(req), (req.body as { ack?: unknown }).ack !== false)); });
hostHubRoutes.post('/api/chathub/thank', (req, res) => { guard(req); res.json(hostHub().thank(bodyId(req))); });
const doAction = (a: string) => { if (!(HUB_ACTIONS as readonly string[]).includes(a)) throw new HttpError(404, `Unknown action (${HUB_ACTIONS.join(', ')})`); return { ok: true, action: a, result: hostHub().act(a as HubAction) ?? null }; };
hostHubRoutes.post('/api/chathub/do/:action', (req, res) => { guard(req); res.json(doAction(String(req.params.action))); });
// Stream Deck "Website" action (GET request in background): the per-PC key stops other web pages from triggering it
hostHubRoutes.get('/api/chathub/do/:action', (req, res) => {
  guard(req);
  const k = String(req.query.key ?? '');
  const want = hostHub().deckKey;
  if (k.length !== want.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(want))) throw new HttpError(403, 'Wrong or missing key (copy the URL from the Chat Hub → Stream Deck)');
  res.json(doAction(String(req.params.action)));
});
hostHubRoutes.put('/api/chathub/tts', (req, res) => {
  guard(req);
  const p = { ...(req.body ?? {}) } as Partial<TtsSettings>;
  res.json(hostHub().setTts(p));
});
hostHubRoutes.get('/api/chathub/tts/voices', async (req, res) => { guard(req); const h = hostHub(); res.json({ voices: await h.loadVoices(), status: h.status() }); });
hostHubRoutes.post('/api/chathub/tts/read', (req, res) => { guard(req); hostHub().read(bodyId(req)); res.json({ ok: true }); });
hostHubRoutes.post('/api/chathub/tts/skip', (req, res) => { guard(req); res.json({ ok: hostHub().skip() }); });
hostHubRoutes.post('/api/chathub/tts/replay', (req, res) => { guard(req); res.json({ ok: hostHub().replay() }); });
hostHubRoutes.post('/api/chathub/tts/say', async (req, res) => {
  guard(req);
  const h = hostHub();
  // the same filters as a support message (bleeping, "link", Max characters) before any voice reads it
  const text = ttsFilter(str((req.body as { text?: unknown } | undefined)?.text, 300), h.tts) || 'This is how support messages will sound on stream.';
  try {
    const dur = await h.say(text, 'test');
    // say() answers -1 when the voice had nothing it could say (Kokoro: only emoji / unsupported scripts): tell the caller plainly
    if (dur < 0) res.json({ ok: true, skipped: true, message: 'skipped: nothing speakable' });
    else res.json({ ok: true });
  } catch (e) { throw new HttpError(400, (e as Error).message); }
});
hostHubRoutes.get('/api/chathub/tts/audio/:id', (req, res) => {
  guard(req);
  const b = hostHub().getAudio(String(req.params.id));
  if (!b) throw new HttpError(404, 'gone');
  res.setHeader('Content-Type', b.type || 'audio/wav'); res.setHeader('Cache-Control', 'no-store'); res.end(b.buf);
});

// ---------------------------------------------------------------- ingest (other tools → the hub)
const ING_PLATS = new Set<LivePlatform>(['twitch', 'youtube', 'kick', 'rumble', 'tiktok']);
hostHubRoutes.post('/api/chat/ingest', (req, res) => {
  guard(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const platform = String(b.platform ?? '') as LivePlatform;
  if (!ING_PLATS.has(platform)) throw new HttpError(400, 'platform must be twitch | youtube | kick | rumble | tiktok');
  const user = str(b.user, 48) || 'anonymous', text = str(b.text, 500), ts = Number(b.ts) || Date.now(), id = str(b.id, 120) || undefined;
  const kind = String(b.kind ?? 'chat');
  const h = chatHub as unknown as { onChat: typeof chatHub.onChat; onFinance: typeof chatHub.onFinance };
  if (kind === 'finance') h.onFinance({ platform, username: user, kind: str(b.fkind, 20) || 'tip', amount: b.amount, currency: str(b.currency, 8) || undefined, usd: typeof b.usd === 'number' ? b.usd : undefined, message: text, ts, id: id && `ing:${id}`, giftName: str(b.giftName, 40) || undefined });
  else if (kind === 'event') {
    const ev = String(b.ev ?? 'follow');
    // reward = a channel-point redemption ({ev:'reward', text:'redeemed <title>'}, server/chat/kick.ts names this route for it)
    if (!['follow', 'host', 'share', 'like', 'join', 'reward'].includes(ev)) throw new HttpError(400, 'ev must be follow | host | share | like | join | reward');
    h.onChat({ platform, username: user, message: text || (ev === 'follow' ? 'just followed!' : ev), ts, system: true, ev: ev as 'follow', id: id && `ing:${id}` });
  } else h.onChat({ platform, username: user, message: text, ts, id: id && `ing:${id}` });
  res.json({ ok: true });
});
