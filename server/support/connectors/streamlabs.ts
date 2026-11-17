// Streamlabs (research A8): the Socket API with the streamer's pasted Socket API token (no app of ours: unapproved
// Streamlabs apps are limited to 10 users). Socket.IO is spoken over a plain WebSocket (Engine.IO v3, what the
// documented 2.x client uses): '0{…}' open, '40' connected, '42["event",{…}]' events, '2' / '3' ping / pong.
// Streamlabs donations + merch are its own (source streamlabs); its Twitch / YouTube copies carry via:'streamlabs' and are
// dropped while that platform's own connector is live.
import WebSocket from 'ws';
import type { SupportEvent, SupportKind, SupportSource } from '../../../shared/support.ts';
import { cur, iso, mkEvent, s, toMinor, type ConnectorCtx, type SupportConnector } from '../types.ts';

type J = Record<string, unknown>;
const o = (v: unknown): J => (v && typeof v === 'object' ? v as J : {});
export const SL_SOCKET = 'wss://sockets.streamlabs.com/socket.io/?EIO=3&transport=websocket&token=';

const FOR: Record<string, SupportSource> = { streamlabs: 'streamlabs', '': 'streamlabs', twitch_account: 'twitch', youtube_account: 'youtube', kick_account: 'kick' };

/** One socket event {type, for, message:[…], event_id} → events. */
export function slEvents(e: J, testAll = false): SupportEvent[] {
  const type = s(e.type, 40), source = FOR[s(e.for, 40)] ?? 'streamlabs';
  const via = source === 'streamlabs' ? undefined : 'streamlabs' as const;
  const list = Array.isArray(e.message) ? e.message.map(o) : [];
  const out: SupportEvent[] = [];
  for (const m of list) {
    const pid = s(m._id, 80) || s(m.id, 80) || s(e.event_id, 80);
    if (!pid) continue;
    const name = s(m.name, 60) || s(m.from, 60);
    const test = testAll || m.isTest === true || m.is_test === true;
    const msg = s(m.message, 600) || s(m.comment, 600);
    const base = { who: { name: name || 'Someone', anonymous: !name }, ...(msg ? { message: { text: msg, moderated: 'ok' as const } } : {}), occurredAt: iso(m.createdAt ?? m.created_at), test, ...(via ? { via } : {}) };
    const id = via ? `sl:${pid}` : pid;
    const ev = (kind: SupportKind, extra: Partial<SupportEvent>) => mkEvent(source, id, kind, { ...base, ...extra });
    if (type === 'donation' && source === 'streamlabs') { const c = cur(m.currency); const minor = toMinor(m.amount, c); out.push(ev('tip', minor ? { amount: { minor, currency: c, valuedAt: 'cash' } } : {})); }
    else if (type === 'bits') { const b = Math.round(Number(m.amount) || 0); out.push(ev('bits', { amount: { minor: b, currency: 'USD', valuedAt: 'bits' }, units: { bits: b } })); }
    else if (type === 'subscription') {
      const months = Math.max(1, Number(m.months) || 1);
      const gifter = s(m.gifter, 60) || s(m.gifter_display_name, 60);
      if (gifter) out.push(mkEvent(source, id, 'gift', { ...base, who: { name: gifter, anonymous: false }, recipient: { name: name || 'someone' }, units: { gifted: 1, tier: s(m.sub_plan, 10) } }));
      else out.push(ev('sub', { units: { months, tier: s(m.sub_plan, 10) }, recurring: months > 1 }));
    } else if (type === 'superchat') {
      const c = cur(m.currency);
      const micros = Number(m.amount) || 0;
      out.push(ev('superchat', { amount: { minor: toMinor(micros / 1e6, c), currency: c, valuedAt: 'cash' } }));
    } else if (type === 'membershipGift') out.push(ev('gift', { units: { gifted: Math.max(1, Number(m.amount) || 1) } }));
    else if (type === 'merch') { const c = cur(m.currency); const minor = toMinor(m.amount, c); out.push(ev('purchase', { ...(minor ? { amount: { minor, currency: c, valuedAt: 'cash' } } : {}), item: { name: s(m.product, 100) || s(m.item, 100) || 'merch' } })); }
  }
  return out;
}

export class StreamlabsConnector implements SupportConnector {
  readonly id = 'streamlabs' as const;
  readonly mirrorsChat = true;
  private ctx: ConnectorCtx | null = null;
  private ws: WebSocket | null = null;
  private st: { state: 'off' | 'connecting' | 'live' | 'waiting' | 'error'; detail: string } = { state: 'off', detail: '' };
  private stopped = true;
  private ping: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private retry = 2000;
  constructor(private base = SL_SOCKET) {}
  start(ctx: ConnectorCtx) {
    this.ctx = ctx; this.stopped = false;
    if (!ctx.secret('socketToken')) { this.st = { state: 'waiting', detail: 'Paste your Streamlabs Socket API token.' }; return; }
    this.connect();
  }
  private connect() {
    if (this.stopped || !this.ctx) return;
    this.st = { state: 'connecting', detail: 'Connecting…' };
    const ws = new WebSocket(this.base + encodeURIComponent(this.ctx.secret('socketToken')));
    this.ws = ws;
    ws.on('message', (raw) => {
      const t = String(raw);
      if (t.startsWith('0')) {
        let iv = 25000; try { iv = Number(o(JSON.parse(t.slice(1))).pingInterval) || 25000; } catch { /* */ }
        if (this.ping) clearInterval(this.ping);
        this.ping = setInterval(() => { try { ws.send('2'); } catch { /* */ } }, iv);
      } else if (t === '2') ws.send('3');
      else if (t.startsWith('40')) { this.st = { state: 'live', detail: 'Connected ✓' }; this.retry = 2000; }
      else if (t.startsWith('44')) { this.st = { state: 'error', detail: 'Streamlabs didn’t accept that token. Copy your Socket API token again.' }; }
      else if (t.startsWith('42')) {
        try {
          const [name, payload] = JSON.parse(t.slice(2)) as [string, J];
          if (name === 'event') { const evs = slEvents(o(payload)); if (evs.length) this.ctx!.emit(evs, { replayed: false }); }
        } catch { /* not ours */ }
      }
    });
    ws.on('close', (code) => {
      if (this.ping) clearInterval(this.ping);
      if (this.ws === ws) this.ws = null;
      if (code === 1008 || code === 4001) this.st = { state: 'error', detail: 'Streamlabs didn’t accept that token. Copy your Socket API token again.' };
      if (!this.stopped) { this.timer = setTimeout(() => this.connect(), this.retry); this.retry = Math.min(this.retry * 2, 60_000); }
    });
    ws.on('error', () => { /* close follows */ });
  }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); if (this.ping) clearInterval(this.ping); try { this.ws?.close(); } catch { /* */ } this.ws = null; this.st = { state: 'off', detail: '' }; }
  status() { return this.st; }
  /** The socket token can't read Streamlabs' history (that needs an app). Missed events are gone: the studio says so. */
  async catchUp() { return 0; }
  test(): SupportEvent[] { return slEvents(SL_DONATION_FIXTURE, true); }
}

/** Streamlabs' documented donation event. */
export const SL_DONATION_FIXTURE = {
  type: 'donation', message: [{ id: 96164121, name: 'NeonNomad', amount: '13.37', formatted_amount: '$13.37', formattedAmount: '$13.37', message: 'test donation', currency: 'USD', emotes: null, iconClassName: 'user', to: { name: 'You' }, from: 'NeonNomad', from_user_id: null, _id: '0820c9d5bafd768c9843f5e35c885e71' }],
  event_id: 'evt_17e5f4dc6888767ed9799f78dfa2cabc',
};
