// Twitch chat, read only.
//   Chat, bits, subs / resubs / gifted subs, raids, announcements, deletions: Twitch's public IRC over WebSocket
//   (wss://irc-ws.chat.twitch.tv) as an ANONYMOUS "justinfan" reader — no account, no sign-in, no token, no app.
//   Follows and channel-point redeems are not part of Twitch's public chat: they are not shown (no sign-in in this build).
// Nothing is ever sent to chat (the IRC login is anonymous and cannot post).
import WebSocket from 'ws';
import type { ChatPart } from '../../shared/chat.ts';
import type { RawFinance } from './finance.ts';
import type { ConnectorHooks } from './types.ts';

export interface TwitchConfig {
  enabled: boolean;
  /** Channel login (lower-case, from the URL twitch.tv/<channel>). */
  channel: string;
  /** Test override of the chat address (http/ws URL; the config sanitiser only lets a plain URL through). */
  irc?: string;
}

const IRC = 'wss://irc-ws.chat.twitch.tv:443';
const EMOTE = (id: string) => `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/default/dark/2.0`;

/** IRCv3 tag value unescaping. */
const unesc = (v: string) => v.replace(/\\(.)/g, (_m, c: string) => (c === 's' ? ' ' : c === ':' ? ';' : c === 'n' ? '\n' : c === 'r' ? '' : c));

export interface IrcLine { tags: Record<string, string>; prefix: string; cmd: string; params: string[]; trailing: string }
export function parseIrc(line: string): IrcLine | null {
  let rest = line;
  const tags: Record<string, string> = {};
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    for (const kv of rest.slice(1, sp).split(';')) { const i = kv.indexOf('='); tags[i < 0 ? kv : kv.slice(0, i)] = i < 0 ? '' : unesc(kv.slice(i + 1)); }
    rest = rest.slice(sp + 1);
  }
  let prefix = '';
  if (rest.startsWith(':')) { const sp = rest.indexOf(' '); prefix = rest.slice(1, sp); rest = rest.slice(sp + 1); }
  let trailing = '';
  const ti = rest.indexOf(' :');
  if (ti >= 0) { trailing = rest.slice(ti + 2); rest = rest.slice(0, ti); }
  const [cmd, ...params] = rest.split(' ').filter(Boolean);
  return cmd ? { tags, prefix, cmd, params, trailing } : null;
}

/** "25:0-4,12-16/1902:6-10" → parts (positions are in UTF-16 code points … Twitch counts code points). */
export function twitchParts(text: string, emotes: string | undefined): ChatPart[] | undefined {
  if (!emotes) return undefined;
  const cps = Array.from(text);
  const spans: { s: number; e: number; id: string }[] = [];
  for (const grp of emotes.split('/')) {
    const [id, pos] = grp.split(':');
    if (!id || !pos) continue;
    for (const r of pos.split(',')) { const [s, e] = r.split('-').map(Number); if (Number.isFinite(s) && Number.isFinite(e) && e >= s) spans.push({ s, e, id }); }
  }
  if (!spans.length) return undefined;
  spans.sort((a, b) => a.s - b.s);
  const parts: ChatPart[] = [];
  let at = 0;
  for (const sp of spans) {
    if (sp.s < at) continue;
    if (sp.s > at) parts.push({ t: 'text', v: cps.slice(at, sp.s).join('') });
    parts.push({ t: 'emote', n: cps.slice(sp.s, sp.e + 1).join(''), u: EMOTE(sp.id) });
    at = sp.e + 1;
  }
  if (at < cps.length) parts.push({ t: 'text', v: cps.slice(at).join('') });
  return parts;
}

const BADGE_MAP: Record<string, string> = { broadcaster: 'broadcaster', moderator: 'moderator', vip: 'vip', subscriber: 'subscriber', founder: 'founder', staff: 'staff', partner: 'verified', premium: 'prime', turbo: 'turbo' };
const badgesOf = (b: string | undefined) => (b ? b.split(',').map((x) => BADGE_MAP[x.split('/')[0]]).filter((x): x is string => !!x) : []);

export class TwitchChat {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff = 1000;
  private ircDetail = '';
  private timers = new Set<NodeJS.Timeout>();
  /** Mystery gift bursts: gifter → { remaining, recipients, finance } (one attributed gift instead of N lines). */
  private mystery = new Map<string, { left: number; ev: RawFinance; t: NodeJS.Timeout }>();
  readonly chan: string;

  constructor(private cfg: TwitchConfig, private hooks: ConnectorHooks) {
    this.chan = String(cfg.channel || '').toLowerCase().replace(/^https?:\/\/(www\.)?twitch\.tv\//, '').replace(/[^a-z0-9_]/g, '');
  }

  start() {
    if (!this.chan) { this.hooks.onStatus('error', 'no channel set'); return; }
    this.connectIrc();
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    for (const m of this.mystery.values()) clearTimeout(m.t);
    try { this.ws?.close(); } catch { /* */ }
  }

  private later(fn: () => void, ms: number) { const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms); this.timers.add(t); return t; }
  private status(state: 'live' | 'connecting' | 'error' = this.ws?.readyState === WebSocket.OPEN ? 'live' : 'connecting') {
    this.hooks.onStatus(state, this.ircDetail);
  }

  // ---------------------------------------------------------------- IRC (anonymous)
  private connectIrc() {
    if (this.stopped) return;
    this.ircDetail = `joining #${this.chan}`;
    this.status('connecting');
    const ws = new WebSocket(this.cfg.irc || IRC);
    this.ws = ws;
    ws.on('open', () => {
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send('PASS SCHMOOPIIE');
      ws.send(`NICK justinfan${10000 + Math.floor(Math.random() * 80000)}`);
      ws.send(`JOIN #${this.chan}`);
    });
    ws.on('message', (d) => { for (const l of String(d).split('\r\n')) if (l) this.onLine(l); });
    ws.on('close', () => {
      if (this.stopped) return;
      this.ircDetail = 'reconnecting'; this.status('connecting');
      this.later(() => this.connectIrc(), this.backoff);
      this.backoff = Math.min(30000, this.backoff * 2);
    });
    ws.on('error', (e) => { this.hooks.log('irc error', (e as Error).message); });
  }

  /** Exposed for tests (server/chat simulations feed raw IRC lines). */
  onLine(raw: string) {
    const m = parseIrc(raw);
    if (!m) return;
    const t = m.tags;
    const ts = Number(t['tmi-sent-ts']) || Date.now();
    const user = t['display-name'] || m.prefix.split('!')[0] || 'anonymous';
    switch (m.cmd) {
      case 'PING': this.ws?.send(`PONG :${m.trailing || 'tmi.twitch.tv'}`); return;
      case 'RECONNECT': try { this.ws?.close(); } catch { /* */ } return;
      case 'ROOMSTATE': case 'JOIN':
        if (m.cmd === 'ROOMSTATE' && /^\d{1,20}$/.test(t['room-id'] ?? '')) this.hooks.onRoom?.(t['room-id']);   // (emote sets by channel id)
        if (m.cmd === 'JOIN' && !m.prefix.startsWith('justinfan')) return;
        this.backoff = 1000; this.ircDetail = `#${this.chan}`; this.status('live'); return;
      case 'NOTICE':
        if (/suspended|does not exist|banned/i.test(m.trailing) || /msg_channel_suspended/.test(t['msg-id'] ?? '')) { this.ircDetail = m.trailing.slice(0, 80); this.status('error'); }
        return;
      case 'CLEARMSG': if (t['target-msg-id']) this.hooks.onRemove({ kind: 'delete', platform: 'twitch', target: t['target-msg-id'] }); return;
      case 'CLEARCHAT': this.hooks.onRemove({ kind: 'purge', platform: 'twitch', target: m.trailing || '*', ...(m.trailing && t['target-user-id'] ? { uid: t['target-user-id'] } : {}) }); return;
      case 'PRIVMSG': {
        const text = m.trailing.replace(/^\u0001ACTION (.*)\u0001$/, '$1');
        const badges = badgesOf(t.badges);
        const bits = Number(t.bits) || 0;
        if (bits > 0) {
          this.hooks.onFinance({ platform: 'twitch', username: user, kind: 'bits', amount: bits, currency: 'bits', message: text.replace(/\b[A-Za-z]+\d+\b/g, '').replace(/\s+/g, ' ').trim(), ts, id: t.id ? `tw:${t.id}` : undefined, badges, ...(t['user-id'] ? { uid: t['user-id'] } : {}) });
          return;
        }
        this.hooks.onChat({ platform: 'twitch', username: user, message: text, color: /^#[0-9a-f]{6}$/i.test(t.color ?? '') ? t.color : null, ts, badges, parts: twitchParts(text, t.emotes), id: t.id || undefined, ...(t['user-id'] ? { uid: t['user-id'] } : {}) });
        return;
      }
      case 'USERNOTICE': this.onUserNotice(t, m.trailing, user, ts); return;
      default:
    }
  }

  private onUserNotice(t: Record<string, string>, text: string, user: string, ts: number) {
    const id = t.id ? `tw:${t.id}` : undefined;
    const badges = badgesOf(t.badges);
    const kind = t['msg-id'];
    const p = (k: string) => t[`msg-param-${k}`] ?? '';
    const plan = /^(1000|2000|3000|Prime)$/.test(p('sub-plan')) ? p('sub-plan') : undefined;
    const tier = p('sub-plan') === '2000' ? ' (Tier 2)' : p('sub-plan') === '3000' ? ' (Tier 3)' : p('sub-plan') === 'Prime' ? ' (Prime)' : '';
    switch (kind) {
      case 'sub': case 'resub': {
        const months = Number(p('cumulative-months')) || 1;
        this.hooks.onFinance({ platform: 'twitch', username: user, kind: kind === 'sub' ? 'sub' : 'resub', amount: months, currency: 'months', message: text || `${kind === 'sub' ? 'subscribed' : `resubscribed (${months} months)`}${tier}`, ts, id, badges, subPlan: plan });
        return;
      }
      case 'giftpaidupgrade': case 'primepaidupgrade': case 'anongiftpaidupgrade':
        this.hooks.onFinance({ platform: 'twitch', username: user, kind: 'sub', amount: 1, currency: 'months', message: 'continued their sub', ts, id, badges }); return;
      case 'submysterygift': {
        const n = Number(p('mass-gift-count')) || 1;
        const key = user.toLowerCase();
        const ev: RawFinance = { platform: 'twitch', username: user, kind: 'giftSub', amount: n, currency: 'subs', message: `gifted ${n} sub${n === 1 ? '' : 's'}${tier}`, ts, id, recipients: [], badges, subPlan: plan };
        const prev = this.mystery.get(key);
        if (prev) clearTimeout(prev.t);
        // the individual subgift lines follow: collect their recipients, then emit one event
        const t2 = this.later(() => { this.mystery.delete(key); this.hooks.onFinance(ev); }, 2500);
        this.mystery.set(key, { left: n, ev, t: t2 });
        return;
      }
      case 'subgift': case 'anonsubgift': {
        const to = p('recipient-display-name') || p('recipient-user-name');
        const burst = this.mystery.get(user.toLowerCase());
        if (burst && burst.left > 0) { burst.left--; if (to) burst.ev.recipients!.push(to); return; }
        this.hooks.onFinance({ platform: 'twitch', username: user, kind: 'giftSub', amount: 1, currency: 'subs', message: `gifted a sub to ${to}${tier}`, ts, id, recipients: to ? [to] : [], badges, subPlan: plan });
        return;
      }
      case 'raid': {
        const n = Number(p('viewerCount')) || 0;
        const who = p('displayName') || user;
        this.hooks.onFinance({ platform: 'twitch', username: who, kind: 'raid', amount: n, currency: 'viewers', message: `is raiding with ${n} viewer${n === 1 ? '' : 's'}`, ts, id });
        return;
      }
      case 'announcement':
        this.hooks.onChat({ platform: 'twitch', username: user, message: `📣 ${text}`, ts, badges, system: true, id: t.id || undefined });
        return;
      default:
        if (t['system-msg']) this.hooks.onChat({ platform: 'twitch', username: user, message: t['system-msg'], ts, system: true, id: t.id || undefined });
    }
  }
}
