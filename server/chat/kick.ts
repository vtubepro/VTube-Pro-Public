// Kick chat connector — ported from an earlier overlay (src/chat/kick.js): resolves the chatroom / channel id from
// the channel slug (https://kick.com/api/v2/channels/{slug}), subscribes to Kick's public Pusher app (no auth, read
// only), and emits chat + support events. Same event handling as the overlay (Kicks in every observed payload shape,
// gifted-sub bursts coalesced into ONE attributed gift, sub / resub dual events merged, hosts / raids, follows).
// Added here: message ids, badges, [emote:ID:NAME] + 7TV emotes as message parts, deleted messages / bans.
//
// Read only: this never sends anything to Kick except the Pusher subscribe / ping / pong frames and the "which realtime
// app?" question below.
//
// Which Pusher app: Kick's own web client asks web.kick.com (POST /api/v1/realtime/connection, seen from 2026-10-04)
// instead of using a fixed key, so that answer is tried first; the old fixed keys stay as the fallback. Every step of
// a connect has a deadline (lookup, the question, the socket handshake, the chat subscription, a silent socket): a
// step that never answers shows as a problem and is retried, never as an endless "connecting…".
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import WebSocket from 'ws';
import type { ChatPart } from '../../shared/chat.ts';
import { CACHE_DIR } from '../paths.ts';
import { toNumber, type RawFinance } from './finance.ts';
import type { ConnectorHooks, ConnectorState, RawChat } from './types.ts';

// The fixed keys (fallback after the negotiated app): the last one Kick's web client used, then the older one, each on
// us2 then eu.
const PUSHER_KEYS = ['32cbd69e4b950bf97679', 'eb1d5f283081a78b932c'];
const PUSHER_CLUSTERS = ['us2', 'eu'];
const REALTIME = 'https://web.kick.com';
const pusherUrl = (key: string, cluster: string) => `wss://ws-${cluster}.pusher.com/app/${key}?protocol=7&client=js&version=8.4.0&flash=false`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** A JSON GET (or POST with `body`) that always settles: the idle timeout (Node arms it only once the socket has
 *  connected, and a server that trickles a byte now and then keeps it from firing) plus a total deadline. */
export function requestJson(url: string, o: { headers: Record<string, string>; timeoutMs?: number; body?: unknown; what?: string }): Promise<unknown> {
  const what = o.what ?? 'channel lookup', timeoutMs = o.timeoutMs ?? 15000;
  return new Promise((resolve, reject) => {
    const payload = o.body === undefined ? null : Buffer.from(JSON.stringify(o.body));
    let done = false;
    const finish = (e: Error | null, v?: unknown) => { if (done) return; done = true; clearTimeout(deadline); if (e) reject(e); else resolve(v); };
    const headers = payload ? { ...o.headers, 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : o.headers;
    const req = (url.startsWith('https:') ? https : http).request(url, { method: payload ? 'POST' : 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => { size += c.length; if (size > 4_000_000) req.destroy(new Error(`${what}: answer too large`)); else chunks.push(c); });
      res.on('error', (e) => finish(e));
      res.on('end', () => {
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) { finish(new Error(`${what} failed: ${res.statusCode}`)); return; }
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(new Error(`${what}: bad JSON`)); }
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error(`${what} timed out`)), timeoutMs * 2);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${what} timed out`)));
    req.on('error', (e) => finish(e));
    req.end(payload ?? undefined);
  });
}
export const getJson = (url: string, headers: Record<string, string>, timeoutMs = 15000) => requestJson(url, { headers, timeoutMs });

/** The Pusher app in an answer of web.kick.com/api/v1/realtime/… ({data:{connections:[{provider:'pusher',
 *  credentials:{app_key, cluster}}]}}), or null (no Pusher offered, or values that don't look like a key / cluster). */
export function pusherOf(body: unknown): { key: string; cluster: string } | null {
  const b = (body && typeof body === 'object' ? body : {}) as Data;
  const list = Array.isArray(b.data?.connections) ? b.data.connections : Array.isArray(b.connections) ? b.connections : [];
  for (const c of list as Data[]) {
    if (String(c?.provider ?? '').toLowerCase() !== 'pusher') continue;
    const key = c?.credentials?.app_key ?? c?.credentials?.key;
    const cluster = c?.credentials?.cluster ?? 'us2';
    if (typeof key === 'string' && /^[A-Za-z0-9]{8,64}$/.test(key) && typeof cluster === 'string' && /^[a-z0-9-]{1,32}$/.test(cluster)) return { key, cluster };
  }
  return null;
}

interface KickIds { chatroomId: number; channelId: number; userId: number | null }
const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
/** The channel ids last read from Kick, by channel name (cache/chat/kick_ids.json): a restart still connects when
 *  Kick's channel page refuses this PC for a while (its Cloudflare sometimes blocks non-browser clients). */
export const kickIdCache = {
  file: path.join(CACHE_DIR, 'chat', 'kick_ids.json'),
  all(): Record<string, KickIds> { try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } },
  get(slug: string): KickIds | null {
    const v = this.all()[slug];
    return v && posInt(v.chatroomId) && posInt(v.channelId) ? { chatroomId: v.chatroomId, channelId: v.channelId, userId: posInt(v.userId) ? v.userId : null } : null;
  },
  put(slug: string, ids: KickIds) {
    const all = this.all(), old = all[slug];
    if (old && old.chatroomId === ids.chatroomId && old.channelId === ids.channelId && old.userId === ids.userId) return;
    delete all[slug];
    const keep = Object.entries(all).slice(-19);   // a few channels at most (the newest last)
    const text = JSON.stringify(Object.fromEntries([...keep, [slug, ids]]));
    const tmp = `${this.file}.tmp`;
    void fsp.mkdir(path.dirname(this.file), { recursive: true }).then(() => fsp.writeFile(tmp, text)).then(() => fsp.rename(tmp, this.file)).catch(() => { /* best effort */ });
  },
};

export interface KickConfig {
  enabled: boolean;
  channel: string;
  chatroomId?: number | null;
  channelId?: number | null;
  /** 7TV channel + global emotes (read from 7tv.io once per connect). */
  sevenTv?: boolean;
  /** Test / override endpoints (the mock server): https://kick.com, https://web.kick.com and the Pusher URL: the one
   *  socket used (no question asked). A `pusher` with {key} / {cluster} in it (a template for every app tried) only
   *  works on a config built in code (tools/kick_connect_unit.ts): config/chat.json keeps plain URLs. Never from a web
   *  page (server/chat/connectPage.ts). */
  apiBase?: string;
  realtimeBase?: string;
  pusher?: string;
  sevenTvBase?: string;
}

type Data = Record<string, any>;  // eslint-disable-line @typescript-eslint/no-explicit-any

/** Kicks amount from any observed payload shape (Overlay extractKicksAmount, unchanged). */
export function extractKicksAmount(data: Data): number {
  if (!data || typeof data !== 'object') return 0;
  const candidates = [
    data.kicks_amount, data.kicks, data.amount, data.total, data.quantity,
    data.gift?.amount, data.gift?.kicks, data.gift?.quantity, data.gift?.kicks_amount, data.gift?.total,
    data.payload?.kicks, data.payload?.amount, data.payload?.kicks_amount,
    data.metadata?.kicks, data.metadata?.amount, data.metadata?.kicks_amount,
    data.sender?.amount, data.data?.kicks, data.data?.amount,
    data.transaction?.amount, data.transaction?.kicks, data.reward?.amount, data.reward?.kicks,
  ];
  for (const v of candidates) { const n = toNumber(v); if (n > 0) return Math.round(n); }
  const seen = new Set<object>();
  const stack: unknown[] = [data];
  let best = 0;
  while (stack.length) {
    const obj = stack.pop();
    if (!obj || typeof obj !== 'object' || seen.has(obj)) continue;
    seen.add(obj);
    for (const [k, v] of Object.entries(obj as Data)) {
      if (v && typeof v === 'object') { stack.push(v); continue; }
      if (!/kick|amount|tip|total|quantity|value|price/i.test(k)) continue;
      if (/id|time|date|color|tier/i.test(k)) continue;
      const n = toNumber(v);
      if (n > 0 && n < 1e7 && n > best) best = n;
    }
  }
  if (best > 0) return Math.round(best);
  const msg = String(data.message || data.content || data.text || '');
  const m = msg.match(/(\d[\d,]*)\s*kicks?/i) || msg.match(/kicks?\s*[x:]?\s*(\d[\d,]*)/i);
  if (m) { const n = toNumber(m[1]); if (n > 0) return Math.round(n); }
  return 0;
}

function extractUsername(data: Data, fallback = 'anonymous'): string {
  return data?.sender?.username || data?.gifter?.username || data?.user?.username || data?.username || data?.gifter_username || data?.from?.username || data?.subscriber?.username || fallback;
}
function extractMessage(data: Data): string {
  const raw = data?.message ?? data?.content ?? data?.text ?? data?.gift?.message ?? '';
  return typeof raw === 'string' ? raw : '';
}
function badgesOf(data: Data): string[] {
  const list = data?.sender?.identity?.badges;
  if (!Array.isArray(list)) return [];
  // the badge TYPE only: a badge's display text is not a permission (mod commands trust 'moderator' / 'broadcaster')
  return list.map((b: Data) => String(b?.type ?? '').toLowerCase()).filter(Boolean).slice(0, 6);
}

/** "[emote:123:name] hi KEKW" → parts (Kick emotes inline, 7TV by word). */
export function kickParts(text: string, seven: Map<string, string> | null): ChatPart[] | undefined {
  const out: ChatPart[] = [];
  const re = /\[emote:(\d+):([^\]]+)\]/g;
  let i = 0, m: RegExpExecArray | null, any = false;
  const pushText = (s: string) => {
    if (!s) return;
    if (!seven || !seven.size) { out.push({ t: 'text', v: s }); return; }
    for (const w of s.split(/(\s+)/)) {
      const u = w && !/^\s+$/.test(w) ? seven.get(w) : undefined;
      if (u) { out.push({ t: 'emote', n: w, u }); any = true; } else if (w) {
        const last = out[out.length - 1];
        if (last && last.t === 'text') last.v += w; else out.push({ t: 'text', v: w });
      }
    }
  };
  while ((m = re.exec(text)) !== null) {
    pushText(text.slice(i, m.index));
    out.push({ t: 'emote', n: m[2], u: `https://files.kick.com/emotes/${m[1]}/fullsize` });
    any = true;
    i = m.index + m[0].length;
  }
  pushText(text.slice(i));
  return any ? out : undefined;
}
/** Plain text with emote codes as their names. */
const plain = (text: string) => text.replace(/\[emote:\d+:([^\]]+)\]/g, '$1');

interface PendingGift { sender: string | null; count: number; recipients: Set<string>; id: string | null; ts: number; timer: NodeJS.Timeout | null }

export class KickChat {
  readonly slug: string;
  chatroomId: number | null;
  channelId: number | null;
  private userId: number | null = null;
  private ws: WebSocket | null = null;
  private stopped = false;
  /** Deadlines (ms): tests shorten them. */
  retryMs = 2000;
  lookupMs = 15000;
  negotiateMs = 10000;
  handshakeMs = 15000;
  joinMs = 15000;
  pingMs = 30000;
  silentMs = 75000;
  private reconnectDelay = this.retryMs;
  /** Kick was asked for the channel's ids in this run (a failed lookup with saved ids is not repeated every retry). */
  private looked = false;
  /** The Pusher apps to try, in order (the negotiated one first), and the one in use. Rebuilt (asked again) after a
   *  round where none of them let us into the chat. */
  private endpoints: { url: string; label: string }[] | null = null;
  private epIdx = 0;
  private readonly clientId = crypto.randomUUID();
  private onJoin: ((channel: string) => void) | null = null;
  /** The socket was closed by this connector to rejoin a moved chatroom (not the app's fault). */
  private rejoin = false;
  private unknownLogged = new Set<string>();
  private payloadLogged = new Set<string>();
  private zeroKicksLogged = 0;
  giftWindowMs = 1800;
  subHoldMs = 3000;
  private pendingGift: PendingGift | null = null;
  private recentGifts: { sender: string; at: number; count: number; unclaimed: number; recipients: Set<string> }[] = [];
  private pendingSubs = new Map<string, { timer: NodeJS.Timeout | null; evt: RawFinance; preferred: boolean }>();
  private anonRecipients: { count: number; timer: NodeJS.Timeout | null } | null = null;
  private seven: Map<string, string> | null = null;
  private subscribeFn: (() => void) | null = null;

  constructor(private cfg: KickConfig, private hooks: ConnectorHooks) {
    this.slug = (cfg.channel || '').toLowerCase().trim();
    this.chatroomId = cfg.chatroomId || null;
    this.channelId = cfg.channelId || null;
  }

  private log(...a: unknown[]) { this.hooks.log(...a); }
  /** A stopped connector (Save + reconnect builds a new one) never writes over its successor's status. */
  private status(s: ConnectorState, detail: string) { if (!this.stopped) this.hooks.onStatus(s, detail); }
  private get api() { return (this.cfg.apiBase || 'https://kick.com').replace(/\/+$/, ''); }
  private get realtime() { return (this.cfg.realtimeBase || REALTIME).replace(/\/+$/, ''); }

  private logPayloadOnce(name: string, data: Data) {
    if (this.payloadLogged.has(name)) return;
    this.payloadLogged.add(name);
    try { this.log(`${name} payload sample:`, JSON.stringify(data).slice(0, 400)); } catch { /* */ }
  }

  // ---------------------------------------------------------------- gift coalescing (Overlay, unchanged)
  private gift(sender: string | null, count: number, recipients: string[], id: string | null, ts: number) {
    const known = sender && !/^anonymous$/i.test(sender) ? String(sender) : null;
    const now = ts || Date.now();
    this.recentGifts = this.recentGifts.filter((g) => now - g.at < 10000);
    const fresh = (recipients || []).filter(Boolean);
    if (!this.pendingGift && this.recentGifts.some((g) => (!known || g.sender.toLowerCase() === known.toLowerCase()) && g.count >= (count || 1) && fresh.every((r) => g.recipients.has(String(r))))) return;
    const g = this.pendingGift ?? (this.pendingGift = { sender: null, count: 0, recipients: new Set(), id: null, ts: now, timer: null });
    if (known && !g.sender) g.sender = known;
    for (const r of recipients || []) if (r) g.recipients.add(String(r));
    g.count = Math.max(g.count, count || 0, g.recipients.size);
    if (id && !g.id) g.id = id;
    if (this.anonRecipients) { if (this.anonRecipients.timer) clearTimeout(this.anonRecipients.timer); this.anonRecipients = null; }
    if (!g.timer) g.timer = setTimeout(() => this.flushGift(), this.giftWindowMs);
  }

  private flushGift() {
    const g = this.pendingGift;
    this.pendingGift = null;
    if (!g) return;
    const recipients = [...g.recipients];
    const count = Math.max(1, g.count);
    const sender = g.sender || 'anonymous';
    for (const r of recipients) this.cancelSub(r);
    let unclaimed = count - recipients.length;
    for (const [key, p] of this.pendingSubs) {
      if (unclaimed <= 0) break;
      if (p.evt.kind === 'sub' && p.evt.amount === 1) { if (p.timer) clearTimeout(p.timer); this.pendingSubs.delete(key); unclaimed--; }
    }
    this.recentGifts.push({ sender, at: g.ts, count, unclaimed, recipients: new Set(recipients) });
    const who = recipients.length ? (recipients.length <= 3 ? recipients.join(', ') : `${recipients.slice(0, 3).join(', ')} +${recipients.length - 3}`) : '';
    this.hooks.onFinance({
      platform: 'kick', username: sender, kind: 'giftSub', amount: count, currency: 'subs',
      message: who ? `gifted ${count} sub${count > 1 ? 's' : ''} → ${who}` : `gifted ${count} sub${count > 1 ? 's' : ''}`,
      ts: g.ts, recipients,
      id: g.id ? `kick:giftsub:${g.id}` : `kick:giftsub:${sender.toLowerCase()}:${count}:${Math.floor(g.ts / 10000)}`,
    });
  }

  private giftActive(ts: number) { return !!this.pendingGift || this.recentGifts.some((g) => (ts || Date.now()) - g.at < 10000); }

  private holdSub(evt: RawFinance, preferred: boolean) {
    const key = String(evt.username || '').toLowerCase();
    const prev = this.pendingSubs.get(key);
    if (prev) { if (prev.timer) clearTimeout(prev.timer); if (!preferred && prev.preferred) evt = prev.evt; }
    const entry = { evt, preferred: preferred || !!prev?.preferred, timer: null as NodeJS.Timeout | null };
    entry.timer = setTimeout(() => {
      this.pendingSubs.delete(key);
      if (this.pendingGift && this.pendingGift.recipients.has(String(entry.evt.username))) return;
      this.hooks.onFinance(entry.evt);
    }, this.subHoldMs);
    this.pendingSubs.set(key, entry);
  }
  private cancelSub(username: string) {
    const key = String(username || '').toLowerCase();
    const p = this.pendingSubs.get(key);
    if (p) { if (p.timer) clearTimeout(p.timer); this.pendingSubs.delete(key); }
  }

  // ---------------------------------------------------------------- connection
  /** The channel's chatroom / channel ids (+ the user id, for its 7TV emotes). Ids already known (a Overlay import, the
   *  id cache) never wait for Kick's channel page: it is read in the background to refresh them (its answer wins from
   *  the next connect on), and a refusal (Cloudflare) only costs the 7TV channel emotes. */
  private async resolveIds() {
    if (!this.chatroomId || !this.channelId) {
      const c = kickIdCache.get(this.slug);
      if (c) { this.chatroomId = c.chatroomId; this.channelId = c.channelId; this.userId ??= c.userId; }
    }
    const known = !!(this.chatroomId && this.channelId);
    const failed = (e: unknown) => this.log(`channel lookup failed (${(e as Error).message}): using the saved chatroom ${this.chatroomId}`);
    if (known && (this.looked || this.userId || this.cfg.sevenTv === false)) {
      if (!this.looked) { this.looked = true; void this.lookup().catch(failed); }
      return;
    }
    this.looked = true;
    try { await this.lookup(); } catch (e) { if (!known) throw e; failed(e); }
  }

  private async lookup() {
    // node:https, not fetch(): Kick's Cloudflare rejects Node's built-in fetch (undici) with 403 but lets the
    // classic http client through — the same reason the overlay uses node-fetch.
    const data = await getJson(`${this.api}/api/v2/channels/${encodeURIComponent(this.slug)}`,
      { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'en-US,en;q=0.9', Referer: `https://kick.com/${this.slug}` }, this.lookupMs) as Data;
    if (this.stopped) return;
    if (!posInt(data?.chatroom?.id)) throw new Error('chatroom id missing from API response');
    const moved = !!this.chatroomId && this.chatroomId !== data.chatroom.id;
    this.chatroomId = data.chatroom.id;
    // (saved ids that no longer match: a socket already in the old room rejoins with the new one)
    if (moved && this.ws?.readyState === WebSocket.OPEN) { this.log(`Kick says chatroom ${data.chatroom.id}: rejoining`); this.rejoin = true; try { this.ws.close(); } catch { /* */ } }
    this.channelId = [data.id, data.chatroom?.channel_id].find(posInt) ?? this.channelId ?? null;
    this.userId = [data.user_id, data.user?.id].find(posInt) ?? this.userId ?? null;
    if (this.channelId) kickIdCache.put(this.slug, { chatroomId: data.chatroom.id, channelId: this.channelId, userId: this.userId });
  }

  /** 7TV channel + global emote names → image URL (best-effort; failures just mean no 7TV emotes). */
  private async load7tv() {
    if (this.cfg.sevenTv === false || this.seven) return;
    const base = (this.cfg.sevenTvBase || 'https://7tv.io').replace(/\/+$/, '');
    const map = new Map<string, string>();
    const add = (set: Data | null | undefined) => {
      for (const e of (set?.emotes ?? []) as Data[]) {
        const host = e?.data?.host;
        const url = typeof host?.url === 'string' ? host.url : '';
        if (e?.name && url) map.set(String(e.name), `${url.startsWith('//') ? 'https:' : ''}${url}/2x.webp`);
      }
    };
    try { const g = await fetch(`${base}/v3/emote-sets/global`, { signal: AbortSignal.timeout(8000) }); if (g.ok) add(await g.json() as Data); } catch { /* optional */ }
    if (this.userId) try { const u = await fetch(`${base}/v3/users/kick/${this.userId}`, { signal: AbortSignal.timeout(8000) }); if (u.ok) add(((await u.json()) as Data)?.emote_set); } catch { /* optional */ }
    this.seven = map;
    if (map.size) this.log(`7TV: ${map.size} emotes`);
  }

  /** Ask Kick which Pusher app its web client uses right now: the channel's own chat connection first, then the
   *  general one (same answer shape). Pusher only: that is the protocol read here. null = no answer (blocked, down,
   *  or only another provider offered): the fixed keys are used. */
  private async negotiate(): Promise<{ key: string; cluster: string } | null> {
    const body = { client: { id: this.clientId, type: 'web' }, capabilities: { accepted_providers: [{ provider: 'pusher' }] } };
    const headers = { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'en-US,en;q=0.9', Origin: 'https://kick.com', Referer: `https://kick.com/${this.slug}` };
    const urls = [...(this.channelId ? [`${this.realtime}/api/v1/realtime/channels/${this.channelId}/chat/connection`] : []), `${this.realtime}/api/v1/realtime/connection`];
    for (const url of urls) {
      if (this.stopped) return null;
      try {
        const r = pusherOf(await requestJson(url, { headers, body, timeoutMs: this.negotiateMs, what: 'realtime question' }));
        if (r) return r;
        this.log(`realtime question: no Pusher app offered (${url.replace(this.realtime, '')})`);
      } catch (e) { this.log(`realtime question: ${(e as Error).message} (${url.replace(this.realtime, '')})`); }
    }
    return null;
  }

  private appUrl(key: string, cluster: string) {
    const t = this.cfg.pusher;
    return t?.includes('{key}') ? t.replace('{key}', key).replace('{cluster}', cluster) : pusherUrl(key, cluster);
  }

  private async endpointList() {
    if (this.endpoints) return this.endpoints;
    const fixed = this.cfg.pusher && !this.cfg.pusher.includes('{key}') ? this.cfg.pusher : null;
    // (a test setup that points Kick at a mock never asks the real web.kick.com)
    const ask = !fixed && (!!this.cfg.realtimeBase || !(this.cfg.apiBase || this.cfg.pusher));
    const list: { url: string; label: string }[] = [];
    if (fixed) list.push({ url: fixed, label: 'the configured app' });
    else {
      const n = ask ? await this.negotiate() : null;
      if (n) list.push({ url: this.appUrl(n.key, n.cluster), label: `Kick's current app (${n.cluster})` });
      for (const cluster of PUSHER_CLUSTERS) for (const [i, key] of PUSHER_KEYS.entries()) {
        const url = this.appUrl(key, cluster);
        if (!list.some((e) => e.url === url)) list.push({ url, label: `fixed app ${i + 1} (${cluster})` });
      }
    }
    this.epIdx = 0;
    return (this.endpoints = list);
  }

  /** The app in use did not let us into the chat: the next one; after the last, ask Kick again next round. */
  private nextEndpoint() {
    if (!this.endpoints) return;
    if (++this.epIdx >= this.endpoints.length) { this.epIdx = 0; this.endpoints = null; }
  }

  async start() {
    this.stopped = false;
    this.reconnectDelay = this.retryMs;
    while (!this.stopped) {
      let joined = false;
      try {
        this.status('connecting', `finding ${this.slug}`);
        await this.resolveIds();
        if (this.stopped) break;
        await this.load7tv();
        if (this.stopped) break;
        const eps = await this.endpointList();
        if (this.stopped) break;
        this.log(`resolved chatroom=${this.chatroomId} channel=${this.channelId} for ${this.slug}`);
        this.status('connecting', `joining ${this.slug}’s chat`);
        this.rejoin = false;
        const r = await this.connect(eps[this.epIdx % eps.length]);
        joined = r.joined || this.rejoin;
        // in through a fallback app: the next connect asks Kick again first (its own app may be back)
        if (r.joined && this.epIdx > 0) this.endpoints = null;
        if (r.err) throw r.err;
      } catch (e) {
        if (this.stopped) break;
        this.log('connection error:', (e as Error).message);
        this.status('error', (e as Error).message);
      }
      if (this.stopped) break;
      if (!joined) this.nextEndpoint();
      this.log(`reconnecting in ${this.reconnectDelay}ms`);
      await new Promise((res) => setTimeout(res, this.reconnectDelay));
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000);
    }
  }

  stop() {
    this.stopped = true;
    try { this.ws?.close(); } catch { /* */ }
    if (this.pendingGift?.timer) clearTimeout(this.pendingGift.timer);
    for (const p of this.pendingSubs.values()) if (p.timer) clearTimeout(p.timer);
    if (this.anonRecipients?.timer) clearTimeout(this.anonRecipients.timer);
  }

  /** One socket's life. Settles when it closes: `joined` = the chat subscription was confirmed at some point; `err` =
   *  why it ended early (a handshake / subscription / silence deadline, a socket error). */
  private connect(ep: { url: string; label: string }): Promise<{ joined: boolean; err?: Error }> {
    return new Promise((resolve) => {
      if (this.stopped) { resolve({ joined: false }); return; }
      this.log(`connecting to ${ep.label}`);
      const ws = new WebSocket(ep.url, { headers: { 'User-Agent': UA }, handshakeTimeout: this.handshakeMs });
      this.ws = ws;
      let joined = false, err: Error | undefined, lastFrame = Date.now();
      let pingTimer: NodeJS.Timeout | null = null, joinTimer: NodeJS.Timeout | null = null;
      const fail = (e: Error) => { err ??= e; try { ws.terminate(); } catch { /* */ } };
      this.onJoin = (ch) => {
        if (!joined) this.log(`in the chat (${ch}) through ${ep.label}`);
        joined = true;
        if (joinTimer) { clearTimeout(joinTimer); joinTimer = null; }
      };
      ws.on('open', () => {
        this.log('socket open');
        lastFrame = Date.now();
        joinTimer = setTimeout(() => { this.log(`no chat subscription confirmed in ${this.joinMs} ms`); fail(new Error('Kick chat did not answer (timed out)')); }, this.joinMs);
        pingTimer = setInterval(() => {
          if (Date.now() - lastFrame > this.silentMs) { this.log(`nothing from the socket for ${this.silentMs} ms`); fail(new Error('Kick chat went quiet (timed out)')); return; }
          try { ws.send(JSON.stringify({ event: 'pusher:ping', data: {} })); } catch { /* */ }
        }, this.pingMs);
      });
      this.subscribeFn = () => {
        const sub = (ch: string) => ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: ch } }));
        sub(`chatrooms.${this.chatroomId}.v2`);
        sub(`chatrooms.${this.chatroomId}`);
        if (this.channelId) { sub(`channel.${this.channelId}`); sub(`channel_${this.channelId}`); sub(`channel-${this.channelId}`); }
        sub(`predictions-channel-${this.channelId || this.chatroomId}`);
      };
      ws.on('message', (raw) => {
        lastFrame = Date.now();
        let frame: Data;
        try { frame = JSON.parse(raw.toString()); } catch { return; }
        if (frame.event === 'pusher:ping') { try { ws.send(JSON.stringify({ event: 'pusher:pong', data: {} })); } catch { /* */ } return; }
        let data = frame.data;
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch { /* leave as string */ } }
        try { this.handleEvent(frame.event, data, frame.channel); } catch (e) { this.log('event error:', (e as Error).message); }
      });
      ws.on('close', (code) => {
        if (pingTimer) clearInterval(pingTimer);
        if (joinTimer) clearTimeout(joinTimer);
        if (this.ws === ws) this.onJoin = null;
        this.log(`socket closed (${code})`);
        if (!this.stopped) this.status('connecting', 'reconnecting');
        if (!joined && !err && !this.rejoin && !this.stopped) err = new Error(`Kick chat refused the connection (${code})`);
        resolve({ joined, err });
      });
      ws.on('error', (e) => { this.log('socket error:', e.message); fail(e); });
    });
  }

  private emitKicks(data: Data, ts: number) {
    const username = extractUsername(data);
    const kicks = extractKicksAmount(data);
    const message = plain(extractMessage(data));
    if (kicks <= 0 && this.zeroKicksLogged < 5) { this.zeroKicksLogged++; try { this.log('kicks amount=0 payload sample:', JSON.stringify(data).slice(0, 400)); } catch { /* */ } }
    this.hooks.onFinance({
      platform: 'kick', username, kind: 'kicks', amount: kicks, currency: 'kicks', usd: +(kicks / 100).toFixed(2), message, ts,
      badges: badgesOf(data), giftName: typeof data?.gift?.name === 'string' ? data.gift.name : undefined, ...(data?.sender?.id != null ? { uid: String(data.sender.id) } : {}),
      id: data?.id ? `kick:kicks:${data.id}` : `kick:kicks:${username}:${kicks}:${Math.floor(ts / 5000)}`,
    });
    // (the overlay also emitted the message as chat; here the support card carries it — no duplicate line)
  }

  handleEvent(name: string, data: Data, channel?: string) {
    if (!name) return;
    if (name === 'pusher:connection_established') { try { this.subscribeFn?.(); } catch (e) { this.log('subscribe failed:', (e as Error).message); } return; }
    if (name === 'pusher_internal:subscription_succeeded') {
      // the chatroom itself (any of the names Kick's web client subscribes): in the chat
      if (/^(chatrooms\.\d+(\.v2)?|chatroom_\d+)$/.test(channel ?? '')) {
        this.status('live', `#${this.slug}`);
        this.reconnectDelay = this.retryMs;
        this.onJoin?.(String(channel));
      }
      return;
    }
    if (name === 'pusher:error') { this.log('pusher error:', data && typeof data === 'object' ? `${data.code ?? ''} ${data.message ?? JSON.stringify(data)}` : data); return; }
    if (!data || typeof data !== 'object') return;
    const ts = Date.now();
    const bare = name.replace(/^App\\Events\\/, '');
    switch (bare) {
      case 'ChatMessageEvent':
      case 'ChatMessageSentEvent': {
        const username = extractUsername(data, 'kick_user');
        const message = extractMessage(data);
        const userColor = data?.sender?.identity?.color || null;
        const type = String(data?.type || data?.message_type || 'message').toLowerCase();
        if (type === 'kicks_gifted' || type === 'kicks' || type === 'tip' || data?.kicks_amount != null || data?.kicks != null
          || (data?.gift && (data.gift.kicks != null || data.gift.amount != null)) || /kicks_gifted|kicks/i.test(String(data?.type || ''))) {
          this.emitKicks(data, ts);
          return;
        }
        const chat: RawChat = { platform: 'kick', username, message: plain(message), color: userColor, ts, badges: badgesOf(data), parts: kickParts(message, this.seven) };
        if (data?.id) chat.id = `kick:${data.id}`;
        if (data?.sender?.id != null) chat.uid = String(data.sender.id);   // (stable user id: names are display names)
        this.hooks.onChat(chat);
        return;
      }
      case 'KicksGifted': case 'KickGiftsEvent': case 'KicksSentEvent': case 'KickReceivedEvent': case 'KicksEvent':
      case 'TipEvent': case 'KicksGiftedEvent': case 'ChatroomKicksGiftedEvent': case 'ChannelKicksGiftedEvent':
        this.emitKicks(data, ts);
        return;
      case 'GiftedSubscriptionsEvent': case 'GiftedSubscriptionEvent': case 'ChannelGiftedSubscriptionsEvent':
      case 'LuckyUsersWhoGotGiftSubscriptionsEvent': case 'SubscriptionGiftedEvent': case 'GiftSubscriptionsEvent': {
        this.logPayloadOnce(bare, data);
        const list = data?.gifted_usernames || data?.usernames || data?.giftees || data?.recipients || [];
        const recipients = (Array.isArray(list) ? list : []).map((g: unknown) => (g && typeof g === 'object' ? ((g as Data).username || (g as Data).slug) : g)).filter(Boolean) as string[];
        const count = recipients.length || toNumber(data?.gifted_quantity) || toNumber(data?.quantity) || toNumber(data?.amount) || toNumber(data?.sub_count) || toNumber(data?.gifted_count) || 1;
        const sender = data?.gifter_username || data?.gifter?.username || data?.sender?.username || data?.user?.username || null;
        this.gift(sender, count, recipients, data?.id ?? null, ts);
        return;
      }
      case 'GiftsLeaderboardUpdated': case 'GiftsLeaderboardUpdatedEvent': {
        this.logPayloadOnce(bare, data);
        const count = toNumber(data?.gifted_quantity) || toNumber(data?.quantity);
        const sender = data?.gifter_username || data?.gifter?.username || null;
        if (count > 0 && sender) this.gift(sender, count, [], null, ts);
        return;
      }
      case 'SubscriptionEvent': case 'ChannelSubscriptionEvent': case 'ChannelSubscribedEvent': case 'SubscriptionRenewedEvent':
      case 'NewSubscriptionEvent': case 'SubscriptionCreatedEvent': {
        this.logPayloadOnce(bare, data);
        const named = data?.username || data?.user?.username || data?.subscriber?.username || data?.sender?.username;
        if (!named) {
          const n = Array.isArray(data?.user_ids) && data.user_ids.length ? data.user_ids.length : 1;
          if (this.giftActive(ts)) return;
          if (this.anonRecipients) { this.anonRecipients.count += n; return; }
          const pending = this.anonRecipients = { count: n, timer: null as NodeJS.Timeout | null };
          pending.timer = setTimeout(() => {
            if (this.anonRecipients !== pending) return;
            this.anonRecipients = null;
            this.gift(null, pending.count, [], null, ts);
          }, this.giftWindowMs);
          return;
        }
        if (this.pendingGift && this.pendingGift.recipients.has(named)) return;
        if (!(toNumber(data?.months) > 1)) {
          const g = this.recentGifts.find((r) => r.unclaimed > 0 && ts - r.at < 10000);
          if (g) { g.unclaimed--; return; }
        }
        const months = toNumber(data?.months) || toNumber(data?.month_count) || toNumber(data?.tenure) || toNumber(data?.streak) || 1;
        const isResub = bare === 'SubscriptionRenewedEvent' || months > 1 || /renew|resub/i.test(String(data?.type || ''));
        this.holdSub({
          platform: 'kick', username: named, kind: isResub ? 'resub' : 'sub', amount: months, currency: 'months',
          message: isResub ? `resubbed (${months} mo)` : 'subscribed', ts,
          id: `kick:sub:${String(named).toLowerCase()}:${Math.floor(ts / 10000)}`,
        }, data?.months != null);
        return;
      }
      case 'StreamHostEvent': case 'StreamHostedEvent': {
        const username = data?.host_username || data?.user?.username || data?.username || 'host';
        const viewers = toNumber(data?.number_viewers) || toNumber(data?.viewers) || 0;
        if (!viewers && username === 'host') return;
        this.hooks.onFinance({ platform: 'kick', username, kind: 'raid', amount: viewers, currency: 'viewers', message: `hosted with ${viewers} viewer${viewers === 1 ? '' : 's'}`, ts });
        return;
      }
      // Kick channel points (Kick only for now): a viewer redeemed a reward. The public Pusher socket sends it on the
      // channel's own channel (reward title + redeemer; payload shapes vary, so read every known spelling). The
      // official Kick API has the same as the webhook `channel.reward.redemption.updated` (needs an OAuth app + a
      // public URL): a bridge can POST it to /api/chat/ingest as {kind:'event', ev:'reward', text:'redeemed <title>'}.
      case 'RewardRedeemedEvent': case 'ChannelRewardRedeemedEvent': case 'RewardRedemptionEvent': case 'ChannelPointsRewardRedeemedEvent': case 'RedemptionCreatedEvent': {
        this.logPayloadOnce(bare, data);
        const title = String(data?.reward_title ?? data?.reward?.title ?? data?.title ?? data?.reward_name ?? data?.reward?.name ?? '').trim();
        const username = data?.username || data?.user_name || data?.redeemer?.username || data?.user?.username || data?.sender?.username;
        if (!title || !username) return;
        const rid = data?.id ?? data?.redemption_id ?? data?.redemption?.id;
        this.hooks.onChat({ platform: 'kick', username: String(username), message: `redeemed ${plain(title).slice(0, 60)}`, color: '#53fc18', system: true, ev: 'reward', ts,
          id: rid ? `kick:reward:${rid}` : `kick:reward:${String(username).toLowerCase()}:${Math.floor(ts / 3000)}` });
        return;
      }
      case 'FollowerEvent': case 'FollowEvent': case 'ChannelFollowEvent': {
        const username = data?.username || data?.follower?.username || data?.user?.username;
        if (!username) return;
        this.hooks.onChat({ platform: 'kick', username, message: 'just followed!', color: '#ffd84a', system: true, ts });
        return;
      }
      // ---- moderation (read only: the monitor drops what the mods removed)
      case 'MessageDeletedEvent': case 'ChatMessageDeletedEvent': {
        const id = data?.message?.id || data?.message_id || data?.id;
        if (id) this.hooks.onRemove({ kind: 'delete', platform: 'kick', target: `kick:${id}` });
        return;
      }
      case 'UserBannedEvent': case 'UserTimedOutEvent': {
        const user = data?.user?.username || data?.username;
        const uid = data?.user?.id ?? data?.user_id;
        if (user) this.hooks.onRemove({ kind: 'purge', platform: 'kick', target: String(user), ...(uid != null ? { uid: String(uid) } : {}) });
        return;
      }
      case 'ChatroomClearEvent': this.hooks.onRemove({ kind: 'purge', platform: 'kick', target: '*' }); return;
      default:
        if (/^App\\Events\\/.test(name) && !this.unknownLogged.has(bare)) {
          this.unknownLogged.add(bare);
          this.log(`unknown event: ${bare}`);
          if (data && (data.kicks != null || data.kicks_amount != null || /kick/i.test(bare))) { this.log('treating unknown event as possible kicks:', bare); this.emitKicks(data, ts); }
        }
    }
  }
}
