// ChatHub: runs the enabled connectors (Kick / Rumble / YouTube, config/chat.json) and turns their callbacks into ONE
// normalised stream of ChatEvents (shared/chat.ts): chat lines, support ("finance") events, system lines and
// moderation removals. Dedupe: platform ids + an earlier overlay's 15 s finance window + a persistent recent-id set
// (reconnects / dual event streams / server restarts never show an event twice). Every event is broadcast on the
// bus ({type:'chat'}) to this PC's pages, kept in a small ring for pages that load later, and appended to the
// session log cache/chat/events-YYYY-MM-DD.jsonl (the performer's own stream data, local only).
// Nothing connects until a platform is enabled in the Scene tab; nothing is ever sent to a platform.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { MONEY_KINDS, SUB_KINDS, sanitizeChatEvent, type ChatEvent, type ChatPart, type ChatPlatformStatus, type ChatStatus, type ChatTotals, type LivePlatform } from '../../shared/chat.ts';
import { broadcast } from '../bus.ts';
import { CACHE_DIR } from '../paths.ts';
import { chatConfigExists, loadChatConfig, type ChatConfig } from './config.ts';
import { createFinanceDeduper, normalizeFinance, tierColor, type RawFinance } from './finance.ts';
import { KickChat, kickParts } from './kick.ts';
import { RumbleChat } from './rumble.ts';
import type { Connector, ConnectorHooks, ConnectorState, RawChat, RawRemove } from './types.ts';
import { YouTubeChat } from './youtube.ts';
import { TwitchChat } from './twitch.ts';
import { TikTokChat } from './tiktok.ts';
import { pollOnFinance } from '../poll.ts';
import { chatBadges, routeChatLine, routeChatRemove } from '../chatCommands.ts';
import { writeFileSoon } from '../library.ts';
import { emoteChannelsOf, emoteStore } from './emotes.ts';
import { emoteSoundsOnChat } from './emoteSounds.ts';
import { removedBy } from '../../shared/chatRemove.ts';
import { isFollowText } from '../../shared/reactions.ts';

export const CHAT_CACHE = path.join(CACHE_DIR, 'chat');
const TOTALS_FILE = path.join(CHAT_CACHE, 'totals.json');
const RING = 160;
type P = LivePlatform;
const PLATS: P[] = ['kick', 'rumble', 'youtube', 'twitch', 'tiktok'];
/** Every event the hub emits (the host Chat Hub queue + TTS, server/chat/hostHub.ts). */
export const chatListeners = new Set<(e: ChatEvent) => void>();

const off = (): ChatPlatformStatus => ({ enabled: false, state: 'off', detail: '', lastEventAt: 0, channel: '' });

export class ChatHub {
  private cfg: ChatConfig = loadChatConfig();
  private conns = new Map<P, Connector>();
  private status: Record<P, ChatPlatformStatus> = { kick: off(), rumble: off(), youtube: off(), twitch: off(), tiktok: off() };
  private ring: ChatEvent[] = [];
  private ids = new Set<string>();
  private financeIsNew = createFinanceDeduper(15000, 500);
  totals: ChatTotals = { usd: 0, count: 0, subs: 0, since: Date.now() };
  private statusT: NodeJS.Timeout | null = null;
  private count = 0;
  private logQ: { file: string; line: string }[] = [];
  private logBusy = false;
  private mentionRe: RegExp | null = null;
  private vips = new Set<string>();

  constructor() {
    try { const t = JSON.parse(fs.readFileSync(TOTALS_FILE, 'utf8')); if (t && typeof t.usd === 'number') this.totals = { usd: t.usd, count: t.count | 0, subs: t.subs | 0, since: Number(t.since) || Date.now() }; } catch { /* first run */ }
    this.seedIds();
  }

  /** Start / restart every enabled connector from config/chat.json. */
  start() {
    this.stop();
    this.cfg = loadChatConfig();
    const c = this.cfg;
    const own = [c.kick.channel, c.youtube.handle?.replace(/^@/, ''), ...c.names].filter((x): x is string => !!x && x.length >= 3);
    this.mentionRe = own.length ? new RegExp(`@(${own.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i') : null;
    this.vips = new Set(c.vips.map((v) => v.toLowerCase()));
    // the streamer's emotes (7TV / BTTV / FFZ / Kick / Twitch / YouTube) for the channels that are switched on
    try { emoteStore.configure(emoteChannelsOf({ twitch: c.twitch.enabled ? c.twitch : { channel: '' }, kick: c.kick.enabled ? c.kick : { channel: '' }, youtube: c.youtube.enabled ? c.youtube : {} })); } catch (e) { console.warn('[chat] emotes', e); }
    for (const p of PLATS) {
      const pc = c[p];
      this.status[p] = { ...off(), enabled: pc.enabled, channel: p === 'kick' ? c.kick.channel : p === 'twitch' ? c.twitch.channel : p === 'tiktok' ? (c.tiktok.user || 'TikFinity bridge') : p === 'youtube' ? (c.youtube.handle || c.youtube.channelId || c.youtube.videoId || '') : (c.rumble.apiKey ? 'API key set' : '') };
      if (!pc.enabled) continue;
      const hooks = this.hooks(p);
      let conn: Connector | null = null;
      if (p === 'kick' && c.kick.channel) conn = new KickChat(c.kick, hooks);
      else if (p === 'rumble' && c.rumble.apiKey) conn = new RumbleChat(c.rumble, hooks);
      else if (p === 'youtube' && YouTubeChat.resolveId(c.youtube)) conn = new YouTubeChat(c.youtube, hooks);
      else if (p === 'twitch' && c.twitch.channel) conn = new TwitchChat(c.twitch, hooks);
      else if (p === 'tiktok') conn = new TikTokChat(c.tiktok, hooks);
      if (!conn) { this.status[p] = { ...this.status[p], state: 'error', detail: p === 'rumble' ? 'no API key' : 'no channel set' }; continue; }
      this.conns.set(p, conn);
      this.status[p].state = 'connecting';
      try { void Promise.resolve(conn.start()).catch((e) => this.setStatus(p, 'error', (e as Error).message)); } catch (e) { this.setStatus(p, 'error', (e as Error).message); }
    }
    this.pushStatus();
  }

  stop() {
    for (const c of this.conns.values()) try { c.stop(); } catch { /* */ }
    this.conns.clear();
    for (const p of PLATS) this.status[p] = { ...this.status[p], state: 'off', detail: '' };
  }

  get running() { return this.conns.size > 0; }
  /** Connectors that can post a chat line (polls' end-of-poll message). Every connector is read-only today → none. */
  senders(): { send: (text: string) => unknown }[] { return [...this.conns.values()].filter((c): c is Connector & { send: (text: string) => unknown } => typeof (c as { send?: unknown }).send === 'function'); }

  snapshot(): ChatStatus {
    return { platforms: { kick: { ...this.status.kick }, rumble: { ...this.status.rumble }, youtube: { ...this.status.youtube }, twitch: { ...this.status.twitch }, tiktok: { ...this.status.tiktok } }, configured: chatConfigExists(), running: this.running, events: this.count };
  }
  recent(n = 60): ChatEvent[] { return this.ring.slice(-n); }
  /** The last support events (a busy chat never pushes them out). */
  support(n = 12): ChatEvent[] { return this.fin.slice(-n); }
  private fin: ChatEvent[] = [];

  resetTotals() { this.totals = { usd: 0, count: 0, subs: 0, since: Date.now() }; this.saveTotals(); broadcast({ type: 'chat', evs: [], tot: this.totals }); }

  // ---------------------------------------------------------------- ingestion
  private hooks(p: P): ConnectorHooks {
    return {
      onChat: (c) => this.onChat(c),
      onFinance: (f) => this.onFinance(f),
      onRemove: (r) => this.onRemove(r),
      onStatus: (s, d) => this.setStatus(p, s, d),
      onRoom: (id) => { if (p === 'twitch') emoteStore.noteTwitchId(id); },
      log: (...a) => console.log(`[chat:${p}]`, ...a),
    };
  }

  private setStatus(p: P, s: ConnectorState, detail: string) {
    const st = this.status[p];
    if (st.state === s && st.detail === detail) return;
    st.state = s; st.detail = String(detail).slice(0, 120);
    this.pushStatus();
  }
  private pushStatus() {
    if (this.statusT) return;
    this.statusT = setTimeout(() => { this.statusT = null; broadcast({ type: 'chatStatus', status: this.snapshot() }); }, 400);
  }

  onChat(c: RawChat, test = false) {
    const ts = Number(c.ts) || Date.now();
    const id = c.id || `${c.platform}:${String(c.username).toLowerCase()}:${ts}:${String(c.message).slice(0, 24)}`;
    if (!this.fresh(id)) return;
    const text = String(c.message ?? '');
    const e: ChatEvent = { id, kind: c.system ? 'system' : 'chat', platform: c.platform, user: c.username || 'anonymous', text, ts };
    if (c.color) e.color = c.color;
    if (c.uid) e.uid = String(c.uid);
    if (c.badges?.length) e.badges = c.badges;
    if (!c.system) { const extra = chatBadges(c.platform, e.user).filter((b) => !e.badges?.includes(b)); if (extra.length) e.badges = [...(e.badges ?? []), ...extra]; }
    // + the 7TV / BTTV / FFZ emotes of this chat (server/chat/emotes.ts): words that name one become emote parts
    // (Kick text from another tool — Streamer.bot, the ingest route — still carries Kick's [emote:id:name] codes)
    const kickCodes = c.platform === 'kick' && !c.parts?.length && /\[emote:\d+:[^\]]+\]/.test(text) ? kickParts(text, null) : undefined;
    if (kickCodes) e.text = text.replace(/\[emote:\d+:([^\]]+)\]/g, '$1');
    const parts = emoteStore.enrich(c.platform, e.text, c.parts?.length ? c.parts : kickCodes);
    if (parts?.length) e.parts = this.proxyParts(parts);
    // (Kick and Rumble send their follow as plain text with no `ev`; an announcement that says "just followed" is not one)
    const ev = c.ev ?? (c.system && isFollowText(text) ? 'follow' : undefined);
    if (ev && c.system) e.ev = ev;
    if (this.vips.has(e.user.toLowerCase())) e.vip = true;
    if (this.mentionRe?.test(text)) e.mention = true;
    if (test) e.test = true;
    if (e.kind === 'chat' && routeChatLine(e)) return;   // a poll vote / an !ask (server/chatCommands.ts → server/poll.ts, server/audience.ts): kept off the chat display
    this.emit(e);
  }

  /** `exact`: the event has a provider id that was already deduped (support services, server/support/hub.ts): skip the
   *  15 s look-alike window, so two equal $5 tips from "Someone" a second apart both count. `quiet`: an event that
   *  happened while VTube Pro was closed: counted and listed, but sent as catch-up (no alert, no read-aloud). */
  onFinance(f: RawFinance, test = false, exact = false, quiet = false) {
    const n = normalizeFinance(f);
    if (!n) return;
    if (n.kind === 'raid' && !n.amount && n.username === 'host') return;
    if (!exact && !this.financeIsNew(n)) { console.log(`[chat] deduped ${n.platform} ${n.kind} ${n.username} ${n.displayAmount}`); return; }
    if (!this.fresh(n.id)) return;
    const e: ChatEvent = {
      id: n.id, kind: 'finance', platform: n.platform as ChatEvent['platform'], user: n.username, text: n.message, ts: n.ts,
      fkind: n.kind, label: n.kindLabel, amount: n.amount, currency: n.currency, usd: n.usd, display: n.displayAmount, tier: tierColor(n),
    };
    if (n.approxUsd) e.approxUsd = n.approxUsd;
    if (n.recipients?.length) e.recipients = n.recipients.slice(0, 12);
    if (n.giftName) e.giftName = n.giftName;
    if (n.subPlan) e.subPlan = n.subPlan as ChatEvent['subPlan'];
    if (n.badges?.length) e.badges = n.badges;
    if (n.support) e.support = n.support;
    if (n.uid) e.uid = n.uid;
    if (this.vips.has(n.username.toLowerCase())) e.vip = true;
    if (test) e.test = true;
    else {
      if (MONEY_KINDS.has(n.kind) || n.usd > 0) this.totals.usd = +(this.totals.usd + (n.usd || 0)).toFixed(2);
      if (SUB_KINDS.has(n.kind)) this.totals.subs += n.kind === 'giftSub' || n.kind === 'giftMembership' ? Math.max(1, n.amount) : 1;
      if (n.kind !== 'raid') this.totals.count++;
      this.saveTotals();
    }
    this.emit(e, true, quiet);
    if (!quiet) pollOnFinance(e);   // a tip naming a poll option = donation votes (when the poll allows them)
  }

  onRemove(r: RawRemove) {
    const e: ChatEvent = { id: `${r.kind}:${r.target}:${Date.now()}`, kind: r.kind, platform: r.platform, user: '', text: '', ts: Date.now(), target: r.target, ...(r.uid ? { uid: r.uid } : {}) };
    this.ring = this.ring.filter((x) => !removedBy(e, x));   // (shared/chatRemove.ts: a ban by platform user id; a deleted support card)
    if (r.kind === 'delete') this.fin = this.fin.filter((x) => !removedBy(e, x));
    broadcast({ type: 'chat', evs: [e] });
    routeChatRemove(r);   // modules holding chatter state (the chat audience) drop them too
  }

  /** Scene tab test button (local only: marked test, never counted, never relayed to guests). `opts.amount` / `opts.user`
   *  size a test (room alert reaction tiers: a $150 Super Chat, a 20-sub gift bomb, a 40-viewer raid …). */
  test(what: string, platform?: LivePlatform, opts: TestOpts = {}) {
    const T = testEvents(what, platform, opts);
    for (const c of T.chat) this.onChat(c, true);
    for (const f of T.finance) this.onFinance(f, true);
    return T.chat.length + T.finance.length;
  }

  private emit(raw: ChatEvent, withTotals = false, quiet = false) {
    const e = sanitizeChatEvent(raw);
    if (!e) return;
    this.count++;
    this.ring.push(e);
    if (this.ring.length > RING) this.ring.splice(0, this.ring.length - RING);
    if (e.kind === 'finance' && !e.test) { this.fin.push(e); if (this.fin.length > 30) this.fin.shift(); }
    this.status[e.platform as P] && (this.status[e.platform as P].lastEventAt = e.ts);
    broadcast({ type: 'chat', evs: [e], ...(withTotals ? { tot: this.totals } : {}), ...(quiet ? { snap: true } : {}) });
    this.log(e);
    if (quiet) return;
    for (const l of chatListeners) try { l(e); } catch (err) { console.warn('[chat] listener', err); }
    try { emoteSoundsOnChat(e); } catch (err) { console.warn('[chat] emote sounds', err); }   // usage stats + emote sounds
  }

  private fresh(id: string) {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    if (this.ids.size > 4000) { let drop = 1000; for (const k of this.ids) { if (drop-- <= 0) break; this.ids.delete(k); } }
    return true;
  }

  /** Remote emote images load through this PC's server (/api/chat/img) so the in-world canvases stay untainted. */
  private proxyParts(parts: ChatPart[]): ChatPart[] | undefined {
    if (!this.cfg.emotes) return undefined;
    return parts;
  }

  // ---------------------------------------------------------------- session log + totals
  // Both are written off the event loop: it relays the tracking frames to the OBS pages, and a raid or a sub train must
  // never stall them on a busy disk.
  /** Appended in order, in batches (best effort; lines still queued at exit are written then). */
  private log(e: ChatEvent) {
    const day = new Date().toISOString().slice(0, 10);
    this.logQ.push({ file: path.join(CHAT_CACHE, `events-${day}.jsonl`), line: JSON.stringify(e) + '\n' });
    if (!this.logBusy) void this.drainLog();
  }
  private async drainLog() {
    this.logBusy = true;
    try {
      while (this.logQ.length) {
        const file = this.logQ[0].file;
        let text = '';
        while (this.logQ.length && this.logQ[0].file === file) text += this.logQ.shift()!.line;
        try { await fsp.mkdir(CHAT_CACHE, { recursive: true }); await fsp.appendFile(file, text); } catch { /* logging is best-effort */ }
      }
    } finally { this.logBusy = false; }
  }
  /** (process exit) the log lines not written yet. */
  flushLogSync() {
    for (const { file, line } of this.logQ.splice(0)) { try { fs.appendFileSync(file, line); } catch { /* best effort */ } }
  }
  /** Coalesced: a sub train = at most 2 writes a second (server/library.ts writeFileSoon). */
  private saveTotals() { writeFileSoon(TOTALS_FILE, () => JSON.stringify(this.totals)); }
  /** Recent ids from today's log: a server restart mid-stream never repeats an event (Rumble / YouTube history). */
  private seedIds() {
    try {
      const f = path.join(CHAT_CACHE, `events-${new Date().toISOString().slice(0, 10)}.jsonl`);
      const lines = fs.readFileSync(f, 'utf8').trim().split('\n').slice(-1500);
      for (const l of lines) { try { const e = JSON.parse(l) as ChatEvent; if (e.id) this.ids.add(e.id); if (e.kind !== 'delete' && e.kind !== 'purge' && !e.test) { this.ring.push(e); if (e.kind === 'finance') this.fin.push(e); } } catch { /* */ } }
      this.ring = this.ring.slice(-RING);
      this.fin = this.fin.slice(-30);
    } catch { /* no log yet */ }
  }
}

// ---------------------------------------------------------------- test events (Scene tab "Send test …")
let testN = 0;
/** Optional size of a test event: amount in the kind's own units ($ for Super Chats / Rants, Kicks, bits, coins, gift count,
 *  months, raid viewers) and the supporter's name. */
export interface TestOpts { amount?: number; user?: string }
export function testEvents(what: string, only?: LivePlatform, opts: TestOpts = {}): { chat: RawChat[]; finance: RawFinance[] } {
  const ts = Date.now(), n = ++testN;
  const users = ['NightOwl42', 'PixelPioneer', 'NeonNomad', 'Beatsmith', 'LateShiftLiz', 'StarlightSam'];
  const u = (opts.user ?? '').replace(/[^\w .-]/g, '').slice(0, 32) || users[n % users.length];
  const amt = typeof opts.amount === 'number' && Number.isFinite(opts.amount) && opts.amount > 0 ? Math.min(100000, opts.amount) : null;
  const A = (d: number) => amt ?? d, N = (d: number) => Math.max(1, Math.round(amt ?? d));
  const lines = ['this room is sick 🔥', 'the new overlay looks clean', 'what song is this?', 'hi from Rumble!', 'LETS GOOO', 'the lights in here 😮'];
  const chat: RawChat[] = [], finance: RawFinance[] = [];
  const plat = only ?? (['kick', 'youtube', 'rumble', 'twitch', 'tiktok'] as const)[n % 5];
  const id = (k: string) => `test:${k}:${ts}:${n}`;
  switch (what) {
    case 'chat': chat.push({ platform: plat, username: u, message: lines[n % lines.length], ts, badges: n % 2 ? ['subscriber'] : [], id: id('chat') }); break;
    case 'superchat': finance.push({ platform: 'youtube', username: u, kind: 'superchat', amount: A(5), currency: 'usd', message: 'Test Super Chat — love the stream!', ts, id: id('sc'), ...(amt ? {} : { color: '#1de9b6' }) }); break;
    case 'rant': finance.push({ platform: 'rumble', username: u, kind: 'rant', amount: A(10), currency: 'usd', usd: A(10), message: 'Test Rumble Rant 🎉', ts, id: id('rant') }); break;
    case 'kicks': finance.push({ platform: 'kick', username: u, kind: 'kicks', amount: N(500), currency: 'kicks', message: 'Test Kicks!', ts, id: id('kicks') }); break;
    case 'sub': finance.push({ platform: 'kick', username: u, kind: 'resub', amount: N(6), currency: 'months', message: `resubbed (${N(6)} mo)`, ts, id: id('sub') }); break;
    case 'gift': finance.push({ platform: 'kick', username: u, kind: 'giftSub', amount: N(5), currency: 'subs', message: `gifted ${N(5)} subs`, ts, id: id('gift'), recipients: ['a', 'b', 'c', 'd', 'e'].slice(0, N(5)) }); break;
    case 'bits': finance.push({ platform: 'twitch', username: u, kind: 'bits', amount: N(500), currency: 'bits', message: 'Test cheer — take my bits!', ts, id: id('bits') }); break;
    case 'tiktok': finance.push({ platform: 'tiktok', username: u, kind: 'tiktokGift', amount: N(1000), currency: 'coins', message: 'sent Lion', giftName: 'Lion', ts, id: id('tt') }); break;
    case 'raid': finance.push({ platform: 'twitch', username: u, kind: 'raid', amount: N(42), currency: 'viewers', message: `is raiding with ${N(42)} viewers`, ts, id: id('raid') }); break;
    case 'follow': chat.push({ platform: plat, username: u, message: 'just followed!', ts, system: true, ev: 'follow', id: id('follow') }); break;
    // a Kick channel-point redemption (the frontline room maps reward titles to supports)
    case 'reward': chat.push({ platform: 'kick', username: u, message: `redeemed ${['Mech Drop', 'Sentry Turret', 'Orbital Laser', 'Supply Drop', 'Eagle Airstrike', '500kg Bomb'][n % 6]}`, ts, system: true, ev: 'reward', id: id('reward') }); break;
    case 'member': finance.push({ platform: 'youtube', username: u, kind: 'membership', amount: 1, currency: 'months', message: 'Welcome to the crew!', ts, id: id('member') }); break;
    default: finance.push({ platform: plat, username: u, kind: plat === 'kick' ? 'kicks' : plat === 'rumble' ? 'rant' : plat === 'twitch' ? 'bits' : plat === 'tiktok' ? 'tiktokGift' : 'superchat', amount: plat === 'kick' || plat === 'twitch' ? 100 : plat === 'tiktok' ? 400 : 2, currency: plat === 'kick' ? 'kicks' : plat === 'twitch' ? 'bits' : plat === 'tiktok' ? 'coins' : 'usd', message: 'Test donation', ts, id: id('don') });
  }
  return { chat, finance };
}

export const chatHub = new ChatHub();
process.on('exit', () => chatHub.flushLogSync());
