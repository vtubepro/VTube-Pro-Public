// TikTok LIVE, read only — through a LOCAL BRIDGE.
// TikTok has no public chat API for LIVE, and reading it directly needs an unofficial signing service (the
// "tiktok-live-connector" library + a third-party sign server). VTube Pro does not ship that. Instead it reads the
// event stream that TikTok tools already running on this PC publish on a local WebSocket, in the widely used
// tiktok-live-connector event format ({ event: 'chat' | 'gift' | 'follow' | 'social' | 'like' | 'share' |
// 'subscribe' | 'member', data: {...} }):
//   • TikFinity (desktop app) — ws://localhost:21213/ (its "WebSocket API"; the default here)
//   • any other bridge that speaks the same format (e.g. a tiktok-live-connector script the performer runs).
// Tools that can only POST (Streamer.bot, custom scripts) can use POST /api/chat/ingest instead (docs/CHAT_HUB.md).
import WebSocket from 'ws';
import type { ConnectorHooks } from './types.ts';

export interface TikTokConfig {
  enabled: boolean;
  /** @username (display only: which channel the bridge is watching is set in the bridge tool). */
  user: string;
  /** Local bridge WebSocket (loopback / LAN only). */
  bridge: string;
  /** Show likes as events (TikTok sends a LOT of them: batched, off by default). */
  likes?: boolean;
  /** Show joins ("member" events): off by default. */
  joins?: boolean;
}

export const TIKFINITY_WS = 'ws://localhost:21213/';

type D = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
/** The stable TikTok handle (uniqueId): display nicknames are not unique. */
const uidOf = (d: D) => str(d.uniqueId) || str((d.user as D | undefined)?.uniqueId) || undefined;
const who = (d: D) => str(d.nickname) || str(d.uniqueId) || str((d.user as D | undefined)?.nickname) || str((d.user as D | undefined)?.uniqueId) || 'someone';

export class TikTokChat {
  private ws: WebSocket | null = null;
  private stopped = false;
  private t: NodeJS.Timeout | null = null;
  private likeAcc = new Map<string, { n: number; t: NodeJS.Timeout }>();
  private seen = new Set<string>();

  constructor(private cfg: TikTokConfig, private hooks: ConnectorHooks) {}

  static bridgeOk(u: string) { return /^wss?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?(\/[\w\-./]*)?$/i.test(u); }

  start() {
    const url = this.cfg.bridge || TIKFINITY_WS;
    if (!TikTokChat.bridgeOk(url)) { this.hooks.onStatus('error', 'the bridge must be a local ws:// address'); return; }
    this.connect(url);
  }
  stop() { this.stopped = true; if (this.t) clearTimeout(this.t); for (const l of this.likeAcc.values()) clearTimeout(l.t); try { this.ws?.close(); } catch { /* */ } }

  private connect(url: string) {
    if (this.stopped) return;
    this.hooks.onStatus('connecting', 'looking for TikFinity / the TikTok bridge');
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on('open', () => this.hooks.onStatus('live', `bridge connected${this.cfg.user ? ` · @${this.cfg.user.replace(/^@/, '')}` : ''}`));
    ws.on('message', (d) => { try { this.onEvent(JSON.parse(String(d))); } catch { /* not JSON */ } });
    ws.on('close', () => {
      if (this.stopped) return;
      this.hooks.onStatus('waiting', 'bridge not running (start TikFinity and go live)');
      this.t = setTimeout(() => this.connect(url), 5000);
    });
    ws.on('error', () => { /* → close */ });
  }

  /** One bridge message (exposed for the simulations). */
  onEvent(m: unknown) {
    if (!m || typeof m !== 'object') return;
    const o = m as D;
    const ev = str(o.event || o.type).toLowerCase();
    const d = (o.data && typeof o.data === 'object' ? o.data : o) as D;
    const user = who(d);
    const ts = num(d.createTime) > 1e12 ? num(d.createTime) : Date.now();
    const mid = str(d.msgId);
    const id = (k: string) => (mid ? `tt:${k}:${mid}` : undefined);
    if (mid && this.seen.has(mid + ev)) return;
    if (mid) { this.seen.add(mid + ev); if (this.seen.size > 3000) this.seen.clear(); }
    const badges = [d.isModerator ? 'moderator' : '', d.isSubscriber ? 'subscriber' : '', num(d.followRole) >= 1 ? 'follower' : ''].filter(Boolean);
    switch (ev) {
      case 'chat':
        this.hooks.onChat({ platform: 'tiktok', username: user, message: str(d.comment), ts, badges, id: id('c'), uid: uidOf(d) });
        return;
      case 'gift': {
        // streakable gifts (giftType 1) repeat while the viewer holds the button: count once, at the end
        if (num(d.giftType) === 1 && d.repeatEnd === false) return;
        const count = Math.max(1, num(d.repeatCount));
        const coins = Math.max(0, num(d.diamondCount)) * count;
        const name = str(d.giftName) || 'Gift';
        this.hooks.onFinance({ platform: 'tiktok', username: user, kind: 'tiktokGift', amount: coins, currency: 'coins', message: `sent ${name}${count > 1 ? ` x${count}` : ''}`, ts, id: id('g'), giftName: name, badges, uid: uidOf(d) });
        return;
      }
      case 'subscribe':
        this.hooks.onFinance({ platform: 'tiktok', username: user, kind: 'sub', amount: 1, currency: 'months', message: 'subscribed', ts, id: id('s') });
        return;
      case 'follow':
        this.hooks.onChat({ platform: 'tiktok', username: user, message: 'just followed!', color: '#fe2c55', ts, system: true, ev: 'follow', id: id('f') });
        return;
      case 'share':
        this.hooks.onChat({ platform: 'tiktok', username: user, message: 'shared the LIVE', ts, system: true, ev: 'share', id: id('sh') });
        return;
      case 'social': {
        const t = str(d.displayType).toLowerCase();
        if (t.includes('follow')) this.onEvent({ event: 'follow', data: d });
        else if (t.includes('share')) this.onEvent({ event: 'share', data: d });
        return;
      }
      case 'member':
        if (this.cfg.joins) this.hooks.onChat({ platform: 'tiktok', username: user, message: 'joined', ts, system: true, ev: 'join', id: id('j') });
        return;
      case 'like': {
        if (!this.cfg.likes) return;
        const k = user.toLowerCase();
        const acc = this.likeAcc.get(k);
        const n = Math.max(1, num(d.likeCount));
        if (acc) { acc.n += n; return; }
        const t = setTimeout(() => { const a = this.likeAcc.get(k); this.likeAcc.delete(k); if (a) this.hooks.onChat({ platform: 'tiktok', username: user, message: `sent ${a.n} like${a.n === 1 ? '' : 's'}`, ts: Date.now(), system: true, ev: 'like' }); }, 8000);
        this.likeAcc.set(k, { n, t });
        return;
      }
      case 'streamend': case 'disconnected':
        this.hooks.onStatus('waiting', 'the LIVE ended'); return;
      default:
    }
  }
}
