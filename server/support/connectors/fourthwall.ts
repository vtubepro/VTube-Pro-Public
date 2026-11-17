// Fourthwall (research A1 + B): the creator's own Open API user (Basic auth, Settings → For developers) polls orders,
// donations and memberships; the shop's webhook (via the relay inbox) makes them instant. Both paths give the same
// event id (the order / donation / member id), so an order seen both ways counts once. Never shown: e-mail, address.
//   Open API  https://api.fourthwall.com/open-api/v1.0  (100 requests / 10 s per shop; we use a few per minute)
//   Webhook   X-Fourthwall-Hmac-SHA256 = base64(HMAC-SHA256(secret, raw body)); envelope {id,type,testMode,data}
import crypto from 'node:crypto';
import type { SupportEvent } from '../../../shared/support.ts';
import { Poller, cur, httpProblem, iso, mkEvent, parseJson, s, safeEq, toMinor, type ConnectorCtx, type HookResult, type InboxDelivery, type SupportConnector } from '../types.ts';

export const FW_API = 'https://api.fourthwall.com/open-api/v1.0';
type J = Record<string, unknown>;
const o = (v: unknown): J => (v && typeof v === 'object' ? v as J : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function verifyFourthwall(body: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const want = crypto.createHmac('sha256', secret).update(body).digest('base64');
  return safeEq(want, header.trim());
}

const money = (m: unknown) => { const x = o(m); const c = cur(x.currency); return { minor: toMinor(x.value, c), currency: c }; };

/** ORDER_PLACED data / an order from GET /order. Cancelled and sample orders are skipped. */
export function orderEvent(d: J, test = false): SupportEvent | null {
  const id = s(d.id, 80);
  if (!id) return null;
  const status = s(d.status, 30);
  if (status === 'CANCELLED') return null;
  if (s(o(d.source).type, 40) === 'SAMPLES_ORDER') return null;
  const amounts = o(d.amounts);
  const total = money(amounts.total);
  const offers = arr(d.offers).map(o);
  const first = offers[0] ?? {};
  const qty = offers.reduce((n, x) => n + (Number(o(x.variant).quantity) || 1), 0) || 1;
  const name = s(first.name, 120);
  const more = offers.length > 1 ? ` + ${offers.length - 1} more` : '';
  const user = s(d.username, 60);
  const msg = s(d.message, 600);
  return mkEvent('fourthwall', id, 'purchase', {
    who: { name: user || 'Someone', anonymous: !user },
    ...(total.minor ? { amount: { ...total, valuedAt: 'cash' as const } } : {}),
    item: { name: (name || 'merch') + more, ...(s(o(first.primaryImage).url, 500) ? { imageUrl: s(o(first.primaryImage).url, 500) } : {}), ...(s(first.id, 80) ? { productId: s(first.id, 80) } : {}), qty, ...(o(o(first.variant).unitPrice).value !== undefined ? { priceMinor: money(o(first.variant).unitPrice).minor } : {}) },
    ...(msg ? { message: { text: msg, moderated: 'ok' as const } } : {}),
    occurredAt: iso(d.createdAt), test,
  });
}

/** GIFT_PURCHASE: someone bought gifts for the community (Twitch gift draws). */
export function giftPurchaseEvent(d: J, test = false): SupportEvent | null {
  const id = s(d.id, 80);
  if (!id) return null;
  const offer = o(d.offer), total = money(o(d.amounts).total), user = s(d.username, 60), msg = s(d.message, 600);
  const qty = Math.max(1, Number(d.quantity) || arr(d.gifts).length || 1);
  return mkEvent('fourthwall', id, 'purchase', {
    who: { name: user || 'Someone', anonymous: !user },
    ...(total.minor ? { amount: { ...total, valuedAt: 'cash' as const } } : {}),
    item: { name: `${s(offer.name, 100) || 'merch'} (gift for chat)`, qty, ...(s(o(offer.primaryImage).url, 500) ? { imageUrl: s(o(offer.primaryImage).url, 500) } : {}), ...(s(offer.id, 80) ? { productId: s(offer.id, 80) } : {}) },
    units: { gifted: qty },
    ...(msg ? { message: { text: msg, moderated: 'ok' as const } } : {}),
    occurredAt: iso(d.createdAt), test,
  });
}

export function donationEvent(d: J, test = false): SupportEvent | null {
  const id = s(d.id, 80);
  if (!id) return null;
  const st = s(d.status, 20);
  if (st && st !== 'COMPLETED') return null;
  const total = money(o(d.amounts).total), user = s(d.username, 60), msg = s(d.message, 600);
  return mkEvent('fourthwall', id, 'tip', {
    who: { name: user || 'Someone', anonymous: !user },
    ...(total.minor ? { amount: { ...total, valuedAt: 'cash' as const } } : {}),
    ...(msg ? { message: { text: msg, moderated: 'ok' as const } } : {}),
    occurredAt: iso(d.createdAt), test,
  });
}

/** SUBSCRIPTION_PURCHASED data / a member from GET /memberships/members. The payload has only a tier id: `tiers` names it. */
export function memberEvent(d: J, tiers: Map<string, string>, test = false): SupportEvent | null {
  const id = s(d.id, 80);
  const sub = o(d.subscription), v = o(sub.variant);
  if (!id || s(sub.type, 20) !== 'ACTIVE') return null;
  const nick = s(d.nickname, 60);
  const amt = money(v.amount);
  return mkEvent('fourthwall', `member:${id}:${s(d.createdAt, 40) || ''}`.replace(/:$/, ''), 'membership', {
    who: { name: nick || 'Someone', anonymous: !nick, linkedId: `fourthwall:${id}` },
    ...(amt.minor ? { amount: { ...amt, valuedAt: 'cash' as const } } : {}),
    tierName: tiers.get(s(v.tierId, 80)) || 'Member', recurring: true, firstOfRecurring: true,
    units: { months: s(v.interval, 10) === 'ANNUAL' ? 12 : 1, tier: tiers.get(s(v.tierId, 80)) || '' },
    occurredAt: iso(d.createdAt), test,
  });
}

/** One webhook envelope → events (+ what else it means). */
export function parseFourthwallHook(j: unknown, tiers: Map<string, string> = new Map()): { events: SupportEvent[]; storeChanged: boolean; voids: string[] } {
  const env = o(j), data = o(env.data), type = s(env.type, 40), test = env.testMode === true;
  const one = (e: SupportEvent | null) => (e ? [e] : []);
  switch (type) {
    case 'ORDER_PLACED': return { events: one(orderEvent(data, test)), storeChanged: false, voids: [] };
    case 'GIFT_PURCHASE': return { events: one(giftPurchaseEvent(data, test)), storeChanged: false, voids: [] };
    case 'DONATION': return { events: one(donationEvent(data, test)), storeChanged: false, voids: [] };
    case 'SUBSCRIPTION_PURCHASED': return { events: one(memberEvent(data, tiers, test)), storeChanged: false, voids: [] };
    case 'ORDER_UPDATED': return { events: [], storeChanged: false, voids: s(data.status, 20) === 'CANCELLED' && s(data.id, 80) ? [`fourthwall:${s(data.id, 80)}`] : [] };
    case 'PRODUCT_CREATED': case 'PRODUCT_UPDATED': case 'COLLECTION_UPDATED': return { events: [], storeChanged: true, voids: [] };
    default: return { events: [], storeChanged: false, voids: [] };
  }
}

export class FourthwallConnector implements SupportConnector {
  readonly id = 'fourthwall' as const;
  readonly mirrorsChat = true;
  private ctx: ConnectorCtx | null = null;
  private st: { state: 'off' | 'connecting' | 'live' | 'waiting' | 'error'; detail: string } = { state: 'off', detail: '' };
  private tiers = new Map<string, string>();
  private poller: Poller | null = null;
  private since = '';

  /** The Open API with the creator's key (Basic). Also used by the store (server/support/store.ts). */
  async api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const c = this.ctx!;
    const user = c.secret('apiUser'), pass = c.secret('apiPass');
    if (!user || !pass) throw Object.assign(new Error('Paste your Fourthwall API username and password first.'), { status: 0 });
    const r = await c.fetch(`${FW_API}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`, accept: 'application/json', 'user-agent': 'vtube-pro/1.0', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw Object.assign(new Error(httpProblem('Fourthwall', r.status)), { status: r.status });
    const t = await r.text();
    return (t ? JSON.parse(t) : {}) as T;
  }
  hasKey() { return !!(this.ctx?.secret('apiUser') && this.ctx?.secret('apiPass')); }

  async start(ctx: ConnectorCtx) {
    this.ctx = ctx;
    if (!this.hasKey()) {
      this.st = ctx.secret('hookSecret') ? { state: 'live', detail: 'Connected by webhook ✓ (add the API key to show products and catch up)' } : { state: 'waiting', detail: 'Paste your Fourthwall API username and password.' };
      return;
    }
    this.st = { state: 'connecting', detail: 'Checking your key…' };
    try {
      await this.loadTiers();
      await this.api('/order?page=0&size=1');
      this.st = { state: 'live', detail: 'Connected ✓' };
    } catch (e) { this.st = { state: 'error', detail: (e as Error).message }; return; }
    this.since = new Date().toISOString();
    // with the webhook on, polling is only reconciliation (Fourthwall says webhooks can be missed); else it is the feed
    this.poller = new Poller(() => this.poll(), () => (ctx.secret('hookSecret') ? 60_000 : 15_000));
    this.poller.start();
  }
  stop() { this.poller?.stop(); this.poller = null; this.st = { state: 'off', detail: '' }; }
  status() { return this.st; }

  private async loadTiers() {
    try {
      const t = await this.api<unknown>('/memberships/tiers');
      for (const x of arr(t).map(o)) if (s(x.id, 80)) this.tiers.set(s(x.id, 80), s(x.name, 60));
    } catch { /* no memberships on this shop */ }
  }

  private async poll() {
    const c = this.ctx!;
    try {
      const n = await this.fetchSince(this.since, false);
      if (this.st.state !== 'live') this.st = { state: 'live', detail: 'Connected ✓' };
      if (n) c.log(`${n} new`);
    } catch (e) { this.st = { state: 'error', detail: (e as Error).message }; }
  }

  /** Orders, donations and new members since `since` (page 0 newest first: Fourthwall has no `since` on donations). */
  private async fetchSince(since: string, replayed: boolean): Promise<number> {
    const c = this.ctx!;
    const after = Date.parse(since) || 0;
    const evs: SupportEvent[] = [];
    const orders = o(await this.api(`/order?page=0&size=50&createdAt%5Bgt%5D=${encodeURIComponent(new Date(after).toISOString())}`));
    for (const x of arr(orders.results).map(o)) { const e = orderEvent(x); if (e && Date.parse(e.occurredAt) > after) evs.push(e); }
    try {
      const dons = o(await this.api('/donations?page=0&size=50'));
      for (const x of arr(dons.results).map(o)) { const e = donationEvent(x); if (e && Date.parse(e.occurredAt) > after) evs.push(e); }
    } catch { /* donations off */ }
    try {
      const mem = o(await this.api('/memberships/members?page=0&size=50'));
      for (const x of arr(mem.results).map(o)) { const e = memberEvent(x, this.tiers); if (e && Date.parse(e.occurredAt) > after) evs.push(e); }
    } catch { /* memberships off */ }
    evs.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    if (evs.length) c.emit(evs, replayed ? { replayed: true } : undefined);
    return evs.length;
  }

  async catchUp(sinceIso: string): Promise<number> {
    if (!this.hasKey() || this.st.state === 'error') return 0;
    try { return await this.fetchSince(sinceIso, true); } catch { return 0; }
  }

  hook(d: InboxDelivery): HookResult {
    const c = this.ctx!;
    const secret = c.secret('hookSecret');
    if (!secret) return { ok: false, why: 'Paste your Fourthwall webhook secret so we can check its webhooks.' };
    if (!verifyFourthwall(d.body, d.headers['x-fourthwall-hmac-sha256'], secret)) return { ok: false, why: 'signature did not match' };
    const r = parseFourthwallHook(parseJson(d.body), this.tiers);
    if (r.storeChanged) c.storeChanged?.();
    return { ok: true, events: r.events, ...(r.voids.length ? { voids: r.voids.map((id) => ({ id, why: 'cancelled' })) } : {}) };
  }

  test(): SupportEvent[] {
    const tiers = new Map([['tier_test', 'Night Owls']]);
    return [
      orderEvent(FW_ORDER_FIXTURE.data as J, true)!,
      donationEvent({ id: 'don_test', status: 'COMPLETED', username: 'PixelPioneer', message: 'For the stream fund!', amounts: { total: { value: 10, currency: 'USD' } }, createdAt: new Date().toISOString() }, true)!,
      memberEvent({ id: 'mem_test', nickname: 'NeonNomad', createdAt: new Date().toISOString(), subscription: { type: 'ACTIVE', variant: { id: 'v', tierId: 'tier_test', interval: 'MONTHLY', amount: { value: 5, currency: 'USD' } } } }, tiers, true)!,
    ];
  }
}

/** An ORDER_PLACED delivery in Fourthwall's documented shape (docs.fourthwall.com/openapi/platform.json, OrderV1). */
export const FW_ORDER_FIXTURE = {
  testMode: true, id: 'weve_EXAMPLE0000000000000', webhookId: 'wcon_EXAMPLE0000000000000', shopId: 'sh_00000000-0000-0000-0000-000000000001', type: 'ORDER_PLACED', apiVersion: 'V1',
  createdAt: '2026-10-09T15:05:11.078089+00:00',
  data: {
    id: '00000000-0000-0000-0000-000000000002', shopId: 'sh_00000000-0000-0000-0000-000000000003', friendlyId: 'D3XZFWPP', checkoutId: 'ch_EXAMPLE0000000000000',
    status: 'CONFIRMED', email: 'supporter@example.com', emailMarketingOptIn: false, username: 'Sam Rivera', message: 'Love the show! https://spam.example',
    amounts: { subtotal: { value: 45, currency: 'USD' }, shipping: { value: 6, currency: 'USD' }, tax: { value: 0, currency: 'USD' }, donation: { value: 0, currency: 'USD' }, discount: { value: 0, currency: 'USD' }, total: { value: 51, currency: 'USD' } },
    shipping: { address: { name: 'Sam Rivera', address1: 'Main Street 1', city: 'San Francisco', state: 'CA', country: 'US', zip: '12345' } },
    offers: [{ id: 'prod_hoodie', name: 'Night Owl Hoodie', slug: 'night-owl-hoodie', description: 'Warm.', primaryImage: { id: 'img1', url: 'https://cdn.fourthwall.com/test/hoodie.png', width: 800, height: 800 }, variant: { id: 'var1', name: 'Night Owl Hoodie - Black, L', sku: 'NOH-L', unitPrice: { value: 45, currency: 'USD' }, quantity: 1, price: { value: 45, currency: 'USD' } } }],
    source: { type: 'ORDER' }, createdAt: '2026-10-09T15:05:10.939Z', updatedAt: '2026-10-09T15:05:10.939Z',
  },
};
