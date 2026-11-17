// Stripe TIPS (research A3), always called "Tip", never "Donation". The creator's OWN Stripe account: a Payment Link
// with "customers choose what to pay" + text fields for the name and the message. We read it with a RESTRICTED key
// (read-only Checkout Sessions + Events, Stripe's recommendation for sharing) by polling completed sessions, and/or
// the webhook through the relay inbox (Stripe-Signature t=…,v1=… = HMAC-SHA256(whsec, `${t}.${body}`), checked against
// the time the RELAY received it, because the inbox may hand it over hours later). Never Stripe Connect.
// The checkout session id is the event id on both paths, so a tip seen twice counts once.
import crypto from 'node:crypto';
import type { SupportEvent } from '../../../shared/support.ts';
import { Poller, cur, httpProblem, iso, mkEvent, parseJson, s, safeEq, type ConnectorCtx, type HookResult, type InboxDelivery, type SupportConnector } from '../types.ts';

type J = Record<string, unknown>;
const o = (v: unknown): J => (v && typeof v === 'object' ? v as J : {});
export const STRIPE_API = 'https://api.stripe.com/v1';
export const STRIPE_TOLERANCE_S = 300;

/** Stripe-Signature check; `at` = when the delivery reached the relay (ms). */
export function verifyStripe(body: Buffer, header: string | undefined, secret: string, atMs: number, tolerance = STRIPE_TOLERANCE_S): boolean {
  if (!header || !secret) return false;
  let t = '';
  const sigs: string[] = [];
  for (const part of header.split(',')) { const [k, v] = part.split('=', 2); if (k?.trim() === 't') t = (v ?? '').trim(); else if (k?.trim() === 'v1' && v) sigs.push(v.trim()); }
  if (!/^\d{9,11}$/.test(t) || !sigs.length) return false;
  if (Math.abs(atMs / 1000 - Number(t)) > tolerance) return false;
  const want = crypto.createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex');
  return sigs.some((v) => safeEq(want, v));
}

/** A completed, paid checkout session → a tip. Name: the "name" custom field, else the buyer's FIRST name only. */
export function sessionTip(cs: J, test = false): SupportEvent | null {
  const id = s(cs.id, 120);
  if (!id || s(cs.payment_status, 20) !== 'paid' || s(cs.mode, 20) === 'setup') return null;
  const fields = Array.isArray(cs.custom_fields) ? cs.custom_fields.map(o) : [];
  const val = (f: J) => s(o(f.text).value, 300) || s(o(f.dropdown).value, 120) || s(o(f.numeric).value, 60);
  const by = (re: RegExp) => { const f = fields.find((x) => re.test(s(x.key, 60)) || re.test(s(o(x.label).custom, 80))); return f ? val(f) : ''; };
  const shown = by(/name|display|twitch|user/i);
  const legal = s(o(cs.customer_details).name, 80).split(' ')[0];
  const name = shown || s(o(cs.metadata).name, 60) || legal;
  const msg = by(/message|note|comment|say/i) || s(o(cs.metadata).message, 300);
  const currency = cur(cs.currency);
  const minor = Math.max(0, Math.round(Number(cs.amount_total) || 0));
  return mkEvent('stripe', id, 'tip', {
    who: { name: name || 'Someone', anonymous: !name }, ...(minor ? { amount: { minor, currency, valuedAt: 'cash' as const } } : {}),
    ...(msg ? { message: { text: msg, moderated: 'ok' as const } } : {}), occurredAt: iso(cs.created), test: test || cs.livemode === false,
  });
}

export function parseStripeEvent(j: unknown): SupportEvent[] {
  const ev = o(j), type = s(ev.type, 80), obj = o(o(ev.data).object);
  if (type !== 'checkout.session.completed' && type !== 'checkout.session.async_payment_succeeded') return [];
  const e = sessionTip(obj, ev.livemode === false);
  return e ? [e] : [];
}

export class StripeConnector implements SupportConnector {
  readonly id = 'stripe' as const;
  readonly mirrorsChat = true;
  private ctx: ConnectorCtx | null = null;
  private st: { state: 'off' | 'connecting' | 'live' | 'waiting' | 'error'; detail: string } = { state: 'off', detail: '' };
  private poller: Poller | null = null;
  private since = 0;
  private async api(path: string): Promise<J> {
    const c = this.ctx!;
    const r = await c.fetch(`${STRIPE_API}${path}`, { headers: { authorization: `Bearer ${c.secret('restrictedKey')}`, 'user-agent': 'vtube-pro/1.0' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(r.status === 403 ? 'That key can’t read Checkout Sessions. Make a restricted key with Read access to Checkout Sessions.' : httpProblem('Stripe', r.status));
    return o(await r.json());
  }
  async start(ctx: ConnectorCtx) {
    this.ctx = ctx;
    const key = ctx.secret('restrictedKey');
    if (!key) { this.st = ctx.secret('hookSecret') ? { state: 'live', detail: 'Connected by webhook ✓' } : { state: 'waiting', detail: 'Paste a restricted key (read only).' }; return; }
    if (/^sk_/.test(key)) { this.st = { state: 'error', detail: 'That is your secret key. Make a RESTRICTED key (read only) instead: it is safer.' }; return; }
    this.st = { state: 'connecting', detail: 'Checking your key…' };
    try { await this.api('/checkout/sessions?limit=1'); this.st = { state: 'live', detail: /^rk_test_/.test(key) ? 'Connected ✓ (test mode key)' : 'Connected ✓' }; } catch (e) { this.st = { state: 'error', detail: (e as Error).message }; return; }
    this.since = Math.floor(Date.now() / 1000) - 60;
    this.poller = new Poller(() => this.poll(), () => (ctx.secret('hookSecret') && ctx.settings().inboxServices.includes('stripe') ? 60_000 : 10_000));
    this.poller.start();
  }
  stop() { this.poller?.stop(); this.poller = null; this.st = { state: 'off', detail: '' }; }
  status() { return this.st; }
  private async fetchSince(sinceS: number, replayed: boolean) {
    const evs: SupportEvent[] = [];
    let after = '';
    for (let page = 0; page < 5; page++) {
      const r = await this.api(`/checkout/sessions?status=complete&limit=100&created%5Bgte%5D=${sinceS}${after ? `&starting_after=${encodeURIComponent(after)}` : ''}`);
      const list = Array.isArray(r.data) ? r.data.map(o) : [];
      for (const cs of list) { if (!s(cs.payment_link, 80) && !s(o(cs.metadata).vtp_tip, 10)) continue; const e = sessionTip(cs); if (e) evs.push(e); }
      if (r.has_more !== true || !list.length) break;
      after = s(list[list.length - 1].id, 120);
    }
    evs.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    if (evs.length) this.ctx!.emit(evs, replayed ? { replayed: true } : undefined);
    return evs.length;
  }
  private async poll() { try { await this.fetchSince(this.since, false); if (this.st.state === 'error') this.st = { state: 'live', detail: 'Connected ✓' }; } catch (e) { this.st = { state: 'error', detail: (e as Error).message }; } }
  async catchUp(since: string) { if (!this.ctx?.secret('restrictedKey') || this.st.state === 'error') return 0; try { return await this.fetchSince(Math.floor((Date.parse(since) || Date.now()) / 1000), true); } catch { return 0; } }
  hook(d: InboxDelivery): HookResult {
    const secret = this.ctx?.secret('hookSecret') ?? '';
    if (!secret) return { ok: false, why: 'Paste your Stripe webhook signing secret (whsec_…) so we can check its webhooks.' };
    if (!verifyStripe(d.body, d.headers['stripe-signature'], secret, d.at)) return { ok: false, why: 'signature did not match' };
    return { ok: true, events: parseStripeEvent(parseJson(d.body)) };
  }
  test(): SupportEvent[] { return parseStripeEvent(STRIPE_FIXTURE); }
}

/** checkout.session.completed in Stripe's documented shape (a Payment Link tip with two custom fields). */
export const STRIPE_FIXTURE = {
  id: 'evt_1NG8Du2eZvKYlo2CUI79vXWy', object: 'event', api_version: '2024-06-20', created: 1791552000, livemode: false, pending_webhooks: 1, type: 'checkout.session.completed',
  data: { object: {
    id: 'cs_test_a11YYufWQzNY63zpQ6QSNRQhkUpVph4WRmzW0zWJO2znZKdVujZ0N0S22u', object: 'checkout.session', amount_subtotal: 1500, amount_total: 1500, currency: 'usd', created: 1791552000, livemode: false, mode: 'payment',
    payment_link: 'plink_1TestTipLink', payment_status: 'paid', status: 'complete', metadata: {},
    custom_fields: [
      { key: 'nametoshow', label: { custom: 'Name to show', type: 'custom' }, optional: true, type: 'text', text: { value: 'Beatsmith' } },
      { key: 'message', label: { custom: 'Message', type: 'custom' }, optional: true, type: 'text', text: { value: 'Tip for the late-night set!' } },
    ],
    customer_details: { email: 'fan@example.com', name: 'Jo Fan', address: { country: 'US', postal_code: '94103' } },
  } },
};
