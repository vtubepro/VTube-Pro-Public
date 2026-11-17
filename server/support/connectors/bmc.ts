// Buy Me a Coffee (research A4): webhooks (via the relay inbox; x-signature-sha256 = hex HMAC-SHA256(secret, raw body))
// + the optional read-only access token for catching up after VTube Pro was closed (the legacy REST API). The webhook
// and the REST answer share `transaction_id`, so one payment seen both ways counts once. live_mode:false = a test.
// Several booleans arrive as the strings "true" / "false".
import crypto from 'node:crypto';
import type { SupportEvent } from '../../../shared/support.ts';
import { Poller, cur, httpProblem, iso, mkEvent, parseJson, s, safeEq, toMinor, type ConnectorCtx, type HookResult, type InboxDelivery, type SupportConnector } from '../types.ts';

type J = Record<string, unknown>;
const o = (v: unknown): J => (v && typeof v === 'object' ? v as J : {});
const yes = (v: unknown) => v === true || v === 'true' || v === 1 || v === '1';
export const BMC_API = 'https://developers.buymeacoffee.com/api/v1';

export function verifyBmc(body: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  return safeEq(crypto.createHmac('sha256', secret).update(body).digest('hex'), header.trim().toLowerCase());
}

/** One webhook envelope → events / refunds. */
export function parseBmc(j: unknown): { events: SupportEvent[]; voids: { id: string; why: string }[] } {
  const env = o(j), d = o(env.data), type = s(env.type, 60), test = env.live_mode === false || env.live_mode === 'false';
  const pid = s(d.transaction_id, 120) || `${s(d.object, 20) || 'x'}-${s(d.id, 40)}`;
  const name = s(d.supporter_name, 60);
  const anon = !name || /^someone$/i.test(name);
  const currency = cur(d.currency);
  const amt = toMinor(d.amount ?? d.total_amount_charged, currency);
  const note = yes(d.note_hidden) ? '' : s(d.support_note, 600);
  const base = { who: { name: anon ? 'Someone' : name, anonymous: anon }, ...(amt ? { amount: { minor: amt, currency, valuedAt: 'cash' as const } } : {}), ...(note ? { message: { text: note, moderated: 'ok' as const } } : {}), occurredAt: iso(d.created_at ?? env.created), test };
  if (/\.refunded$/.test(type)) return { events: [], voids: [{ id: `bmc:${pid}`, why: 'refund' }] };
  switch (type) {
    case 'donation.created': return { events: [mkEvent('bmc', pid, 'tip', { ...base, ...(Number(d.coffee_count) > 0 ? { item: { name: `${Number(d.coffee_count)} coffee${Number(d.coffee_count) === 1 ? '' : 's'}`, qty: Number(d.coffee_count) } } : {}) })], voids: [] };
    case 'recurring_donation.started': case 'recurring_donation.created': return { events: [mkEvent('bmc', pid, 'tip', { ...base, recurring: true })], voids: [] };
    case 'extra_purchase.created': {
      const ex = Array.isArray(d.extras) ? d.extras.map(o) : [];
      return { events: [mkEvent('bmc', pid, 'purchase', { ...base, item: { name: s(ex[0]?.title, 100) || 'an extra', qty: ex.reduce((n, x) => n + (Number(x.quantity) || 1), 0) || 1 } })], voids: [] };
    }
    case 'wishlist_payment.created': return { events: [mkEvent('bmc', pid, 'wishlist_gift', { ...base, item: { name: s(o(d.wishlist).title, 100) || 'a wishlist item' } })], voids: [] };
    case 'membership.started': {
      const mid = `membership-${s(d.id, 40)}-${s(d.started_at, 20) || s(d.current_period_start, 20)}`;
      const tier = s(d.membership_level_name, 60);
      return { events: [mkEvent('bmc', mid, 'membership', { ...base, recurring: true, firstOfRecurring: true, ...(tier ? { tierName: tier } : {}), who: { ...base.who, linkedId: `bmc:${s(d.supporter_id, 40)}` }, units: { months: s(d.duration_type, 10) === 'year' ? 12 : 1 } })], voids: [] };
    }
    default: return { events: [], voids: [] };
  }
}

/** A supporter from the REST API (GET /supporters) → the same id as its webhook. */
export function bmcSupporter(x: J): SupportEvent | null {
  const pid = s(x.transaction_id, 120);
  if (!pid || yes(x.is_refunded)) return null;
  const name = s(x.supporter_name, 60) || s(x.payer_name, 60);
  const currency = cur(x.support_currency);
  const coffees = Number(x.support_coffees) || 1;
  const minor = toMinor((Number(x.support_coffee_price) || 0) * coffees, currency);
  const pub = s(x.support_visibility, 10) !== '0';
  const note = pub ? s(x.support_note, 600) : '';
  const at = s(x.support_created_on, 30);
  return mkEvent('bmc', pid, 'tip', {
    who: { name: name || 'Someone', anonymous: !name }, ...(minor ? { amount: { minor, currency, valuedAt: 'cash' as const } } : {}),
    ...(note ? { message: { text: note, moderated: 'ok' as const } } : {}), item: { name: `${coffees} coffee${coffees === 1 ? '' : 's'}`, qty: coffees },
    occurredAt: iso(at ? `${at.replace(' ', 'T')}Z` : undefined),
  });
}

export class BmcConnector implements SupportConnector {
  readonly id = 'bmc' as const;
  readonly mirrorsChat = true;
  private ctx: ConnectorCtx | null = null;
  private st: { state: 'off' | 'connecting' | 'live' | 'waiting' | 'error'; detail: string } = { state: 'off', detail: '' };
  private poller: Poller | null = null;
  private since = '';
  private async api(path: string): Promise<J> {
    const c = this.ctx!;
    const r = await c.fetch(`${BMC_API}${path}`, { headers: { authorization: `Bearer ${c.secret('token')}`, accept: 'application/json', 'user-agent': 'vtube-pro/1.0' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(httpProblem('Buy Me a Coffee', r.status));
    return o(await r.json());
  }
  async start(ctx: ConnectorCtx) {
    this.ctx = ctx;
    const hook = ctx.secret('hookSecret') && ctx.settings().inboxServices.includes('bmc');
    if (ctx.secret('token')) {
      this.st = { state: 'connecting', detail: 'Checking your token…' };
      try { await this.api('/supporters?page=1'); this.st = { state: 'live', detail: 'Connected ✓' }; } catch (e) { this.st = { state: 'error', detail: (e as Error).message }; return; }
      this.since = new Date().toISOString();
      if (!hook) { this.poller = new Poller(() => this.poll(), () => 30_000); this.poller.start(); }
    } else this.st = hook ? { state: 'live', detail: 'Ready ✓ Coffees show up the moment they are bought.' } : { state: 'waiting', detail: ctx.secret('hookSecret') ? 'Press “Get my address” and paste it into Buy Me a Coffee.' : 'Paste your webhook secret (or an access token).' };
  }
  stop() { this.poller?.stop(); this.poller = null; this.st = { state: 'off', detail: '' }; }
  status() { return this.st; }
  private async fetchSince(since: string, replayed: boolean) {
    const after = Date.parse(since) || 0;
    const page = await this.api('/supporters?page=1');
    const evs = (Array.isArray(page.data) ? page.data.map(o) : []).map(bmcSupporter).filter((e): e is SupportEvent => !!e && Date.parse(e.occurredAt) > after);
    if (evs.length) this.ctx!.emit(evs.reverse(), replayed ? { replayed: true } : undefined);
    return evs.length;
  }
  private async poll() { try { await this.fetchSince(this.since, false); } catch (e) { this.st = { state: 'error', detail: (e as Error).message }; } }
  async catchUp(since: string) { if (!this.ctx?.secret('token') || this.st.state === 'error') return 0; try { return await this.fetchSince(since, true); } catch { return 0; } }
  hook(d: InboxDelivery): HookResult {
    const secret = this.ctx?.secret('hookSecret') ?? '';
    if (!secret) return { ok: false, why: 'Paste your Buy Me a Coffee webhook secret so we can check its webhooks.' };
    if (!verifyBmc(d.body, d.headers['x-signature-sha256'], secret)) return { ok: false, why: 'signature did not match' };
    const r = parseBmc(parseJson(d.body));
    return { ok: true, events: r.events, ...(r.voids.length ? { voids: r.voids } : {}) };
  }
  test(): SupportEvent[] { return parseBmc({ ...BMC_FIXTURE, live_mode: false }).events; }
}

/** BMC's documented donation.created example. */
export const BMC_FIXTURE = {
  event_id: 1234, type: 'donation.created', live_mode: true, created: 1791552000, attempt: 1,
  data: { id: 98765, object: 'payment', transaction_id: 'pi_3QxxxxxYyyyyy', status: 'succeeded', refunded: 'false', amount: 15, coffee_count: 3, coffee_price: 5, currency: 'USD', total_amount_charged: 15, application_fee: 0.75, supporter_name: 'Alex', supporter_name_type: 'default', supporter_id: 42, supporter_email: 'alex@example.com', support_note: 'Keep up the great work!', note_hidden: 'false', support_type: 'Supporter', message: 'Alex bought 3 coffees', created_at: 1791552000, refunded_at: null },
};
