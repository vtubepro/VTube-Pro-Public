// Ko-fi (research A6): webhook only, form-encoded `data=<json>`. No signature: the static verification token in the body
// (pasted here, kept encrypted on this PC) plus the secret inbox address are the only checks, so both are required.
// is_public:false = the supporter asked for privacy: "Someone", no message. Amounts are decimal strings.
import type { SupportEvent } from '../../../shared/support.ts';
import { cur, iso, mkEvent, s, safeEq, toMinor, type ConnectorCtx, type HookResult, type InboxDelivery, type SupportConnector } from '../types.ts';

type J = Record<string, unknown>;
const o = (v: unknown): J => (v && typeof v === 'object' ? v as J : {});

/** The form body → the `data` JSON. */
export function kofiData(body: Buffer): J | null {
  try {
    const raw = new URLSearchParams(body.toString('utf8')).get('data');
    if (raw) return o(JSON.parse(raw));
    return o(JSON.parse(body.toString('utf8'))); // (some relays forward JSON)
  } catch { return null; }
}

export function parseKofi(d: J, test = false): SupportEvent | null {
  const pid = s(d.kofi_transaction_id, 80) || s(d.message_id, 80);
  if (!pid) return null;
  const pub = d.is_public !== false;
  const name = pub ? s(d.from_name, 60) : '';
  const currency = cur(d.currency);
  const amount = { minor: toMinor(d.amount, currency), currency, valuedAt: 'cash' as const };
  const msg = pub ? s(d.message, 600) : '';
  const type = s(d.type, 30).toLowerCase();
  const base = { who: { name: name || 'Someone', anonymous: !name }, ...(amount.minor ? { amount } : {}), ...(msg ? { message: { text: msg, moderated: 'ok' as const } } : {}), occurredAt: iso(d.timestamp), test };
  if (type === 'subscription') {
    const tier = s(d.tier_name, 60);
    return mkEvent('kofi', pid, 'membership', { ...base, recurring: true, firstOfRecurring: d.is_first_subscription_payment === true, ...(tier ? { tierName: tier } : {}), units: { months: 1 } });
  }
  if (type === 'shop order' || type === 'commission') {
    const items = Array.isArray(d.shop_items) ? d.shop_items.map(o) : [];
    const qty = items.reduce((n, x) => n + (Number(x.quantity) || 1), 0) || 1;
    const name1 = type === 'commission' ? 'a commission' : s(items[0]?.variation_name, 80) || 'a shop item';
    return mkEvent('kofi', pid, 'purchase', { ...base, item: { name: name1, qty } });
  }
  return mkEvent('kofi', pid, 'tip', { ...base, recurring: d.is_subscription_payment === true });
}

export class KofiConnector implements SupportConnector {
  readonly id = 'kofi' as const;
  readonly mirrorsChat = true;
  private ctx: ConnectorCtx | null = null;
  start(ctx: ConnectorCtx) { this.ctx = ctx; }
  stop() { this.ctx = null; }
  status() {
    const c = this.ctx;
    if (!c?.secret('verificationToken')) return { state: 'waiting' as const, detail: 'Paste your Ko-fi verification token.' };
    if (!c.settings().inboxServices.includes('kofi')) return { state: 'waiting' as const, detail: 'Press “Get my address” and paste it into Ko-fi.' };
    return { state: 'live' as const, detail: 'Ready ✓ Ko-fi tips show up the moment they are sent.' };
  }
  async catchUp() { return 0; } // no Ko-fi API; the relay inbox keeps 7 days
  hook(d: InboxDelivery): HookResult {
    const token = this.ctx?.secret('verificationToken') ?? '';
    const data = kofiData(d.body);
    if (!data) return { ok: false, why: 'not a Ko-fi delivery' };
    if (!token) return { ok: false, why: 'Paste your Ko-fi verification token so we can check its deliveries.' };
    if (!safeEq(s(data.verification_token, 100), token)) return { ok: false, why: 'verification token did not match' };
    const e = parseKofi(data);
    return { ok: true, events: e ? [e] : [] };
  }
  test(): SupportEvent[] { const e = parseKofi(KOFI_FIXTURE, true); return e ? [e] : []; }
}

/** Ko-fi's documented example delivery (the `data` field). */
export const KOFI_FIXTURE: J = {
  verification_token: '00000000-0000-0000-0000-000000000000', message_id: '11111111-1111-1111-1111-111111111111', timestamp: '2026-10-09T15:22:49Z',
  type: 'Donation', is_public: true, from_name: 'Jo Example', message: 'Good luck with the integration!', amount: '3.00',
  url: 'https://ko-fi.com/Home/CoffeeShop?txid=00000000-1111-2222-3333-444444444444', email: 'jo.example@example.com', currency: 'USD',
  is_subscription_payment: false, is_first_subscription_payment: false, kofi_transaction_id: '00000000-1111-2222-3333-444444444444', shop_items: null, tier_name: null, shipping: null,
};
