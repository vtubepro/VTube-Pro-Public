// StreamElements (research A7): the Astro socket with the streamer's pasted JWT. One key brings SE tips + SE merch,
// and SE's copies of Twitch / YouTube / Kick / Fourthwall events. The copies carry `via: 'streamelements'` and the
// hub DROPS them while that platform's own connector is live (cross-source dedupe), so nothing counts twice.
//   wss://astro.streamelements.com  subscribe {type:'subscribe', nonce, data:{topic, room, token, token_type:'jwt'}}
//   topics channel.tips (tips:read) + channel.activities (activities:read); server PING every 30 s; 'reconnect' message
import WebSocket from 'ws';
import type { SupportEvent, SupportKind, SupportSource } from '../../../shared/support.ts';
import { cur, httpProblem, iso, mkEvent, s, toMinor, type ConnectorCtx, type SupportConnector } from '../types.ts';

type J = Record<string, unknown>;
const o = (v: unknown): J => (v && typeof v === 'object' ? v as J : {});
export const SE_ASTRO = 'wss://astro.streamelements.com';
export const SE_API = 'https://api.streamelements.com/kappa/v2';

/** The channel id inside SE's JWT (its payload names it), without verifying (we are not the audience). */
export function seChannelOf(jwt: string): string {
  try { const p = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as J; return s(p.channel, 40) || s(p.channel_id, 40); } catch { return ''; }
}

/** channel.tips message data → a tip (SE's own tips: source streamelements, not a copy). */
export function seTip(d: J, test = false): SupportEvent | null {
  const id = s(d._id, 60);
  if (!id || (s(d.status, 20) && s(d.status, 20) !== 'success')) return null;
  const don = o(d.donation), user = o(don.user);
  const name = s(user.username, 60);
  const currency = cur(don.currency);
  const minor = toMinor(don.amount, currency);
  const msg = s(don.message, 600);
  const held = s(d.approved, 20) === 'pending';
  return mkEvent('streamelements', id, 'tip', {
    who: { name: name || 'Someone', anonymous: !name }, ...(minor ? { amount: { minor, currency, valuedAt: 'cash' as const } } : {}),
    ...(msg ? { message: { text: msg, moderated: held ? 'pending' as const : 'ok' as const } } : {}), occurredAt: iso(d.createdAt), test,
  });
}

const PROVIDERS: Record<string, SupportSource> = { twitch: 'twitch', youtube: 'youtube', kick: 'kick', fourthwall: 'fourthwall', streamelements: 'streamelements', trovo: 'custom', facebook: 'custom' };

/** channel.activities message data → an event (null for follows / raids / host and SE tips, which come via channel.tips). */
export function seActivity(d: J, test = false): SupportEvent | null {
  const type = s(d.type, 40), prov = s(d.provider, 30).toLowerCase(), aid = s(d.activityId, 60) || s(d._id, 60);
  const x = o(d.data);
  if (!aid) return null;
  const source = PROVIDERS[prov] ?? 'streamelements';
  const via = source === 'streamelements' ? undefined : 'streamelements' as const;
  const name = s(x.displayName, 60) || s(x.username, 60);
  const who: SupportEvent['who'] = { name: name || 'Someone', anonymous: !name };
  if ((source === 'twitch' || source === 'youtube' || source === 'kick') && s(x.providerId, 60)) who.chat = { platform: source, userId: s(x.providerId, 60), ...(s(x.username, 48) ? { login: s(x.username, 48) } : {}) };
  const msg = s(x.message, 600);
  const m = msg ? { message: { text: msg, moderated: 'ok' as const } } : {};
  const at = iso(d.createdAt);
  const id = via ? `se:${aid}` : aid;
  const ev = (kind: SupportKind, extra: Partial<SupportEvent>) => mkEvent(source, id, kind, { who, ...m, occurredAt: at, test, ...(via ? { via } : {}), ...extra });
  const amount = Number(x.amount) || 0;
  switch (type) {
    case 'cheer': return ev('bits', { amount: { minor: Math.round(amount), currency: 'USD', valuedAt: 'bits' }, units: { bits: Math.round(amount) } });
    case 'subscriber': {
      const gifted = !!s(x.sender, 60) || x.gifted === true;
      if (gifted) return ev('gift', { who: { name: s(x.sender, 60) || 'Someone', anonymous: !s(x.sender, 60) }, recipient: { name: name || 'someone' }, units: { gifted: 1, tier: s(x.tier, 10) } });
      return ev('sub', { units: { months: Math.max(1, Math.round(amount) || 1), tier: s(x.tier, 10) }, recurring: amount > 1 });
    }
    case 'communityGiftPurchase': return ev('gift', { units: { gifted: Math.max(1, Math.round(amount) || 1), tier: s(x.tier, 10) } });
    case 'superchat': { const c = cur(x.currency); return ev('superchat', { amount: { minor: toMinor(amount, c), currency: c, valuedAt: 'cash' } }); }
    case 'sponsor': return ev('membership', { recurring: true, units: { months: Math.max(1, Math.round(amount) || 1), tier: s(x.tier, 40) } });
    case 'channelPointsRedemption': return ev('redemption', { item: { name: s(x.redemption, 80) || s(x.title, 80) || 'a reward' } });
    case 'merch': case 'purchase': {
      const items = Array.isArray(x.items) ? x.items.map(o) : [];
      const c = cur(x.currency);
      const total = toMinor(x.amount ?? items.reduce((n, it) => n + (Number(it.price) || 0) * (Number(it.quantity) || 1), 0), c);
      return ev('purchase', { ...(total ? { amount: { minor: total, currency: c, valuedAt: 'cash' } } : {}), item: { name: s(items[0]?.name, 100) || 'merch', qty: items.reduce((n, it) => n + (Number(it.quantity) || 1), 0) || 1 } });
    }
    default: return null; // tip (via channel.tips), follow, raid, host, hype train …
  }
}

export class StreamElementsConnector implements SupportConnector {
  readonly id = 'streamelements' as const;
  readonly mirrorsChat = true;
  private ctx: ConnectorCtx | null = null;
  private ws: WebSocket | null = null;
  private st: { state: 'off' | 'connecting' | 'live' | 'waiting' | 'error'; detail: string } = { state: 'off', detail: '' };
  private room = '';
  private retry = 2000;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private reconnectToken = '';
  constructor(private url = SE_ASTRO) {}

  async start(ctx: ConnectorCtx) {
    this.ctx = ctx; this.stopped = false;
    const jwt = ctx.secret('jwt');
    if (!jwt) { this.st = { state: 'waiting', detail: 'Paste your StreamElements JWT token.' }; return; }
    this.room = seChannelOf(jwt);
    if (!this.room) {
      try {
        const r = await ctx.fetch(`${SE_API}/channels/me`, { headers: { authorization: `Bearer ${jwt}` }, signal: AbortSignal.timeout(10000) });
        if (!r.ok) { this.st = { state: 'error', detail: httpProblem('StreamElements', r.status) }; return; }
        this.room = s(o(await r.json())._id, 40);
      } catch (e) { this.st = { state: 'error', detail: `Couldn’t reach StreamElements: ${(e as Error).message}` }; return; }
    }
    this.connect();
  }
  private connect() {
    if (this.stopped || !this.ctx) return;
    this.st = { state: 'connecting', detail: 'Connecting…' };
    const ws = new WebSocket(this.reconnectToken ? `${this.url}/?reconnect_token=${encodeURIComponent(this.reconnectToken)}` : this.url);
    this.ws = ws;
    let n = 0;
    ws.on('message', (raw) => {
      let m: J; try { m = JSON.parse(String(raw)) as J; } catch { return; }
      const type = s(m.type, 20);
      if (type === 'welcome') {
        for (const topic of ['channel.tips', 'channel.activities']) ws.send(JSON.stringify({ type: 'subscribe', nonce: `vtp-${++n}`, data: { topic, room: this.room, token: this.ctx!.secret('jwt'), token_type: 'jwt' } }));
      } else if (type === 'response') { this.st = { state: 'live', detail: 'Connected ✓' }; this.retry = 2000; }
      else if (type === 'error') { const err = s(m.error, 40); this.st = { state: 'error', detail: err === 'err_unauthorized' ? 'StreamElements didn’t accept that token. Copy the JWT token again.' : `StreamElements: ${s(o(m.data).message, 120) || err}` }; }
      else if (type === 'reconnect') { this.reconnectToken = s(o(m.data).reconnect_token, 300); try { ws.close(); } catch { /* */ } }
      else if (type === 'message') {
        const topic = s(m.topic, 40), d = o(m.data);
        const e = topic === 'channel.tips' ? seTip(d) : topic === 'channel.activities' ? seActivity(d) : null;
        if (e) this.ctx!.emit([e], { replayed: false });
      }
    });
    ws.on('ping', () => { try { ws.pong(); } catch { /* */ } });
    ws.on('close', () => { if (this.ws === ws) this.ws = null; this.later(); });
    ws.on('error', () => { /* close follows */ });
  }
  private later() {
    if (this.stopped) return;
    if (this.st.state !== 'error') this.st = { state: 'connecting', detail: 'Reconnecting…' };
    this.timer = setTimeout(() => this.connect(), this.retry);
    this.retry = Math.min(this.retry * 2, 60_000);
  }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); try { this.ws?.close(); } catch { /* */ } this.ws = null; this.st = { state: 'off', detail: '' }; }
  status() { return this.st; }
  /** Missed SE tips (REST, the same JWT; the activity feed's REST shape is unverified, so only tips are replayed). */
  async catchUp(since: string): Promise<number> {
    const c = this.ctx;
    if (!c?.secret('jwt') || !this.room) return 0;
    try {
      const r = await c.fetch(`${SE_API}/tips/${this.room}?limit=50&after=${encodeURIComponent(since)}`, { headers: { authorization: `Bearer ${c.secret('jwt')}` }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) return 0;
      const docs = o(await r.json()).docs;
      const evs = (Array.isArray(docs) ? docs.map(o) : []).map((d) => seTip(d)).filter((e): e is SupportEvent => !!e && e.occurredAt > since);
      if (evs.length) c.emit(evs.reverse(), { replayed: true });
      return evs.length;
    } catch { return 0; }
  }
  test(): SupportEvent[] {
    const tip = seTip(SE_TIP_FIXTURE.data as J, true);
    const cheer = seActivity({ type: 'cheer', provider: 'twitch', activityId: 'act-test', createdAt: new Date().toISOString(), data: { username: 'nightowl42', displayName: 'NightOwl42', providerId: '1234567', amount: 300, message: 'Cheer300 love it' } }, true);
    return [tip, cheer].filter((e): e is SupportEvent => !!e);
  }
}

/** StreamElements' documented channel.tips message. */
export const SE_TIP_FIXTURE = {
  id: '00000000000000000000000000', ts: '2026-10-09T15:07:17Z', type: 'message', topic: 'channel.tips', room: '000000000000000000000000',
  data: { donation: { user: { username: 'Styler', geo: 'ZZ', email: 'styler@example.com', channel: '000000000000000000000000' }, message: 'gg!', amount: 4.2, currency: 'USD', paymentMethod: 'scheme' },
    _id: '111111111111111111111111', channel: '000000000000000000000000', provider: 'paypal', approved: 'allowed', status: 'success', createdAt: '2026-10-09T15:07:09.302Z', updatedAt: '2026-10-09T15:07:17.099Z', transactionId: 'EXAMPLETRANSACTION1' },
};
