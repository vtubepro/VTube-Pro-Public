// Rumble connector — ported from an earlier overlay (src/chat/rumble.js). Polls Rumble's Livestream API
// (https://rumble.com/-livestream-api/get-data?key=<your API key>, read only) and emits:
//   livestreams[].chat.recent_messages → chat · recent_rants / latest_rant → Rumble Rants (amount_cents / amount_dollars;
//   wallet tips during a live stream arrive as rants) · subscribers.recent_subscribers → subs (paid value → usd) ·
//   gifted_subs.recent_gifted_subs → gifted subs (purchased_by = the gifter, total_gifts = count) · followers → system.
// The first poll only seeds what was already there (no history dump on connect / reconnect). Optional SSE override.
import { extractMoneyFields, toNumber } from './finance.ts';
import type { ConnectorHooks } from './types.ts';

/** Rumble badge ids we know (anything else is dropped: a badge decides moderator / member powers). */
const RUMBLE_BADGES = new Set(['admin', 'moderator', 'verified', 'premium', 'recurring_subscription', 'locals', 'locals_supporter', 'whale-gray', 'whale-blue', 'whale-yellow', 'broadcaster']);
function rumbleBadges(v: unknown): string[] {
  return Array.isArray(v) ? v.map((b) => String(b).toLowerCase().trim()).filter((b) => RUMBLE_BADGES.has(b)).slice(0, 6) : [];
}

export interface RumbleConfig {
  enabled: boolean;
  /** The Livestream API key (Rumble → Account → Live Stream API). Secret: config/chat.json only. */
  apiKey: string;
  streamId?: string;
  ssePath?: string;
  pollIntervalMs?: number;
  announceFollowers?: boolean;
  /** Test / override endpoint (the mock server). */
  apiBase?: string;
}

type Data = Record<string, any>;  // eslint-disable-line @typescript-eslint/no-explicit-any
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RumbleChat {
  private stopped = false;
  private sse: AbortController | null = null;
  private apiState: { subs: number; gifts: number; seenFollowers: Set<string> } | null = null;
  private liveIds = new Set<unknown>();
  private chatSeen = new Set<string>();
  private rantSeen = new Set<string>();
  private subSeen = new Set<string>();
  private giftSeen = new Set<string>();
  private wasLive = false;
  private errors = 0;

  constructor(private cfg: RumbleConfig, private hooks: ConnectorHooks) {}
  private log(...a: unknown[]) { this.hooks.log(...a); }
  private get interval() { return Math.max(2000, Number(this.cfg.pollIntervalMs) || 4000); }

  start() {
    this.stopped = false;
    if (this.cfg.apiKey) void this.pollLoop(); else this.hooks.onStatus('error', 'no API key');
    if (this.cfg.ssePath) void this.sseLoop();
  }
  stop() { this.stopped = true; try { this.sse?.abort(); } catch { /* */ } }

  private async pollLoop() {
    this.hooks.onStatus('connecting', 'polling the Livestream API');
    while (!this.stopped) {
      try { await this.pollOnce(); this.errors = 0; } catch (e) {
        this.errors++;
        this.log('api poll error:', (e as Error).message);
        this.hooks.onStatus('error', (e as Error).message.replace(/key=[^&\s]+/, 'key=…'));
      }
      await sleep(this.interval * (this.errors > 3 ? 3 : 1));
    }
  }

  private async pollOnce() {
    const base = (this.cfg.apiBase || 'https://rumble.com').replace(/\/+$/, '');
    const r = await fetch(`${base}/-livestream-api/get-data?key=${encodeURIComponent(this.cfg.apiKey)}`, { headers: { 'User-Agent': 'vtube-pro/1.0' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const d = await r.json() as Data;
    if (!d || typeof d !== 'object') return;
    const numSubs = d.subscribers?.num_subscribers || 0;
    const numGifts = d.gifted_subs?.num_gifted_subs || 0;
    const followers: Data[] = d.followers?.recent_followers || [];
    const livestreams: Data[] = Array.isArray(d.livestreams) ? d.livestreams : [];

    if (!this.apiState) {
      this.apiState = { subs: numSubs, gifts: numGifts, seenFollowers: new Set(followers.map((f) => String(f.username || '').toLowerCase())) };
      this.seedSubs(d.subscribers);
      this.seedGifts(d.gifted_subs);
      for (const ls of livestreams) {
        if (!ls || ls.id == null) continue;
        this.liveIds.add(ls.id);
        for (const m of ls.chat?.recent_messages || []) this.chatSeen.add(this.chatKey(m));
        for (const rt of ls.chat?.recent_rants || []) this.rantSeen.add(this.rantKey(rt));
        if (ls.chat?.latest_rant) this.rantSeen.add(this.rantKey(ls.chat.latest_rant));
      }
      const liveNow = livestreams.some((ls) => ls && ls.is_live);
      this.wasLive = liveNow;
      this.log(`api ready — channel "${d.channel_name || d.username}", ${liveNow ? 'LIVE' : 'offline'}`);
      this.hooks.onStatus(liveNow ? 'live' : 'waiting', `${d.channel_name || d.username || 'channel'}${liveNow ? '' : ' (not live)'}`);
      return;
    }

    this.ingestSubs(d.subscribers, numSubs);
    this.ingestGifts(d.gifted_subs, numGifts);
    if (this.cfg.announceFollowers !== false) {
      const news: Data[] = [];
      for (const f of followers) {
        const key = String(f.username || '').toLowerCase();
        if (key && !this.apiState.seenFollowers.has(key)) { news.push(f); this.apiState.seenFollowers.add(key); }
      }
      for (const f of news.reverse()) this.hooks.onChat({ platform: 'rumble', username: f.username, message: 'just followed!', color: '#ffd200', ts: Date.now(), system: true });
    }
    let anyLive = false;
    for (const ls of livestreams) {
      if (!ls) continue;
      if (ls.is_live) anyLive = true;
      if (ls.id != null && !this.liveIds.has(ls.id)) { this.liveIds.add(ls.id); this.log(`LIVE: "${ls.title || 'untitled'}"`); }
      if (!ls.chat) continue;
      this.ingestChat(ls.chat.recent_messages);
      this.ingestRants(ls.chat.recent_rants);
      if (ls.chat.latest_rant) this.ingestRants([ls.chat.latest_rant]);
      if (this.cfg.streamId && !this.sse) void this.sseLoop();
    }
    if (!anyLive && this.wasLive) { this.log('stream ended (API says offline)'); this.chatSeen.clear(); this.rantSeen.clear(); }
    if (anyLive !== this.wasLive || this.errors === 0) this.hooks.onStatus(anyLive ? 'live' : 'waiting', `${d.channel_name || d.username || 'channel'}${anyLive ? '' : ' (not live)'}`);
    this.wasLive = anyLive;
    this.trim(this.chatSeen, 1000); this.trim(this.rantSeen, 500); this.trim(this.subSeen, 300); this.trim(this.giftSeen, 300);
  }

  // ---- subs
  private seedSubs(subs: Data | undefined) {
    if (!subs) return;
    for (const s of [...(Array.isArray(subs.recent_subscribers) ? subs.recent_subscribers : []), ...(subs.latest_subscriber ? [subs.latest_subscriber] : [])]) { const k = this.subKey(s); if (k) this.subSeen.add(k); }
  }
  private ingestSubs(subs: Data | undefined, numSubs: number) {
    if (!subs) { this.apiState!.subs = numSubs; return; }
    const list: Data[] = Array.isArray(subs.recent_subscribers) ? [...subs.recent_subscribers] : [];
    if (subs.latest_subscriber) { const lk = this.subKey(subs.latest_subscriber); if (lk && !list.some((s) => this.subKey(s) === lk)) list.push(subs.latest_subscriber); }
    const fresh: Data[] = [];
    for (const s of list) { const k = this.subKey(s); if (!k || this.subSeen.has(k)) continue; this.subSeen.add(k); fresh.push(s); }
    const delta = numSubs - this.apiState!.subs;
    if (!fresh.length && delta > 0 && subs.latest_subscriber) {
      const s = subs.latest_subscriber, k = this.subKey(s) || `delta:${numSubs}:${Date.now()}`;
      if (!this.subSeen.has(k)) { this.subSeen.add(k); fresh.push(s); }
    }
    for (const s of fresh.reverse()) {
      const name = s.username || s.user || 'anonymous';
      const money = extractMoneyFields(s);
      const ts = Date.parse(s.subscribed_on) || Date.now();
      this.hooks.onFinance({
        platform: 'rumble', username: name, kind: 'sub', amount: 1, currency: 'months',
        message: money.amountDollars > 0 ? `subscribed ($${money.amountDollars.toFixed(2)})` : 'subscribed', ts,
        usd: money.amountDollars > 0 ? money.amountDollars : 0, id: `rumble:sub:${this.subKey(s)}`,
      });
    }
    this.apiState!.subs = numSubs;
  }
  private subKey(s: Data) { if (!s) return ''; const name = String(s.username || s.user || '').toLowerCase(); return name ? `${name}|${s.subscribed_on || ''}` : ''; }

  // ---- gifted subs
  private seedGifts(g: Data | undefined) {
    if (!g) return;
    for (const x of [...(Array.isArray(g.recent_gifted_subs) ? g.recent_gifted_subs : []), ...(g.latest_gifted_sub ? [g.latest_gifted_sub] : [])]) { const k = this.giftKey(x); if (k) this.giftSeen.add(k); }
  }
  private ingestGifts(gifts: Data | undefined, numGifts: number) {
    if (!gifts) { this.apiState!.gifts = numGifts; return; }
    const list: Data[] = Array.isArray(gifts.recent_gifted_subs) ? [...gifts.recent_gifted_subs] : [];
    if (gifts.latest_gifted_sub) { const lk = this.giftKey(gifts.latest_gifted_sub); if (lk && !list.some((g) => this.giftKey(g) === lk)) list.push(gifts.latest_gifted_sub); }
    const fresh: Data[] = [];
    for (const g of list) { const k = this.giftKey(g); if (!k || this.giftSeen.has(k)) continue; this.giftSeen.add(k); fresh.push(g); }
    const delta = numGifts - this.apiState!.gifts;
    if (!fresh.length && delta > 0 && gifts.latest_gifted_sub) {
      const g = gifts.latest_gifted_sub, k = this.giftKey(g) || `gift-delta:${numGifts}:${Date.now()}`;
      if (!this.giftSeen.has(k)) { this.giftSeen.add(k); fresh.push({ ...g, total_gifts: g.total_gifts || delta }); }
    }
    for (const g of fresh.reverse()) {
      const name = g.purchased_by || g.gifter || g.username || g.user || 'anonymous';
      const count = toNumber(g.total_gifts) || 1;
      const ts = Date.parse(g.gifted_on) || Date.now();
      const money = extractMoneyFields(g);
      this.hooks.onFinance({
        platform: 'rumble', username: name, kind: 'giftSub', amount: count, currency: 'subs', message: `gifted ${count} sub${count === 1 ? '' : 's'}`, ts,
        usd: money.amountDollars > 0 ? money.amountDollars : undefined, id: `rumble:giftsub:${this.giftKey(g)}`,
      });
    }
    this.apiState!.gifts = numGifts;
  }
  private giftKey(g: Data) { if (!g) return ''; return `${String(g.purchased_by || g.gifter || g.username || '').toLowerCase()}|${g.gifted_on || ''}|${g.total_gifts || 1}|${g.video_id || ''}`; }

  // ---- chat
  private ingestChat(list: Data[] | undefined) {
    if (!Array.isArray(list) || !list.length) return;
    const fresh: Data[] = [];
    for (const m of list) { if (!m) continue; const key = this.chatKey(m); if (this.chatSeen.has(key)) continue; this.chatSeen.add(key); fresh.push(m); }
    for (const m of fresh.reverse()) {       // the API is newest-first
      this.hooks.onChat({
        platform: 'rumble', username: m.username || 'rumble_user', message: String(m.text || '').trim(), color: null,
        ts: Date.parse(m.created_on) || Date.now(), badges: rumbleBadges(m.badges),
        id: `rumble:${this.chatKey(m)}`,
      });
    }
  }

  // ---- rants + wallet tips
  private ingestRants(list: Data[] | undefined) {
    if (!Array.isArray(list) || !list.length) return;
    const fresh: Data[] = [];
    for (const m of list) { if (!m) continue; const key = this.rantKey(m); if (this.rantSeen.has(key)) continue; this.rantSeen.add(key); fresh.push(m); }
    for (const m of fresh.reverse()) {
      const ts = Date.parse(m.created_on) || Date.now();
      const badges: string[] = rumbleBadges(m.badges);
      const text = String(m.text || '').trim();
      let dollars = extractMoneyFields(m).amountDollars;
      if (!dollars) { const cents = toNumber(m.price_cents || m.rant_price_cents); if (cents > 0) dollars = cents / 100; }
      dollars = +Number(dollars || 0).toFixed(2);
      const looksWallet = /wallet|tip|crypto/.test(badges.join(' ')) || !!m.wallet || (!!m.tip_type && /wallet|crypto/i.test(String(m.tip_type)));
      const kind = looksWallet ? 'wallet' : 'rant';
      if (dollars <= 0) this.log(`rant with missing amount from ${m.username || '?'}: keys=${Object.keys(m).join(',')}`);
      // (the overlay also emitted the rant text as a chat line; here the support card carries it)
      this.hooks.onFinance({ platform: 'rumble', username: m.username || 'rumble_user', kind, amount: dollars, currency: 'usd', usd: dollars, message: text, ts, badges, id: `rumble:${kind}:${this.rantKey(m)}` });
    }
  }
  private chatKey(m: Data) { return `${m.username || '?'}|${m.created_on || ''}|${String(m.text || '').slice(0, 80)}`; }
  private rantKey(m: Data) { const money = extractMoneyFields(m); return `${m.username || '?'}|${m.created_on || ''}|${String(m.text || '').slice(0, 80)}|${money.cents || money.amountDollars || 0}`; }
  private trim(s: Set<string>, max: number) { if (s.size <= max) return; let drop = s.size - max; for (const k of s) { if (drop-- <= 0) break; s.delete(k); } }

  // ---- optional SSE chat (legacy manual override, as in the overlay)
  private async sseLoop() {
    const url = this.cfg.ssePath || (this.cfg.streamId ? `https://rumble.com/chat/${this.cfg.streamId}/stream` : null);
    if (!url) return;
    while (!this.stopped) {
      try { await this.sseConnect(url); } catch (e) { this.log('SSE error:', (e as Error).message); }
      if (this.stopped) break;
      await sleep(5000);
    }
  }
  private async sseConnect(url: string) {
    this.sse = new AbortController();
    const res = await fetch(url, { headers: { Accept: 'text/event-stream', 'User-Agent': 'vtube-pro/1.0' }, signal: this.sse.signal });
    if (!res.ok || !res.body) throw new Error(`status ${res.status}`);
    let buf = '';
    const dec = new TextDecoder();
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) { const ev = buf.slice(0, idx); buf = buf.slice(idx + 2); this.sseEvent(ev); }
    }
  }
  private sseEvent(text: string) {
    let line = '';
    for (const l of text.split('\n')) if (l.startsWith('data:')) line += l.slice(5).trim();
    if (!line) return;
    let p: Data;
    try { p = JSON.parse(line); } catch { return; }
    const users: Record<string, string> = {};
    for (const u of p.data?.users ?? []) users[u.id] = u.username;
    for (const m of p.data?.messages ?? []) {
      const username = users[m.user_id] || m.user_id || 'rumble_user';
      if (m.rant || m.amount_cents || m.amount_dollars) {
        let dollars = extractMoneyFields(m.rant || m).amountDollars;
        if (!dollars && m.rant?.price_cents) dollars = toNumber(m.rant.price_cents) / 100;
        dollars = +Number(dollars || 0).toFixed(2);
        this.hooks.onFinance({ platform: 'rumble', username, kind: 'rant', amount: dollars, currency: 'usd', usd: dollars, message: m.text || '', ts: Date.now(), id: `rumble:sse:${m.id || m.user_id}:${m.created_on || ''}:${dollars}` });
      } else this.hooks.onChat({ platform: 'rumble', username, message: m.text || '', color: null, ts: Date.now(), id: m.id ? `rumble:sse:${m.id}` : undefined });
    }
  }
}
