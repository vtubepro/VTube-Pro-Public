// Throne wishlists (research A2): webhook only (no pull API). Signed with Throne's Ed25519 key over
// `${X-Signature-Timestamp}.${raw body}`, so the relay checks it at the edge too (and that the event is for the
// creator who owns the inbox); the helper checks it again here (it never trusts the relay). Amounts are in cents.
//   events: gift_purchased, contribution_purchased (someone chipped in), gift_crowdfunded (an item is fully funded)
import crypto from 'node:crypto';
import type { SupportEvent } from '../../../shared/support.ts';
import { cur, mkEvent, parseJson, s, type ConnectorCtx, type HookResult, type InboxDelivery, type SupportConnector } from '../types.ts';

/** Throne's published webhook key (help.throne.com "How do I set up webhook integration"). */
export const THRONE_PUBLIC_KEY_PEM = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAPXbUfxh7XL4SYUVcfhmYMIbxvtR9E9LDd8gPJ1PwSD8=\n-----END PUBLIC KEY-----\n';
/** A delivery older than this (by Throne's timestamp vs when the relay received it) is a replay. */
export const THRONE_MAX_SKEW_S = 600;

export function verifyThrone(body: Buffer, ts: string | undefined, sigHex: string | undefined, receivedAtMs: number, pem: string = THRONE_PUBLIC_KEY_PEM): boolean {
  if (!ts || !/^\d{9,11}$/.test(ts) || !sigHex || !/^[0-9a-f]{128}$/i.test(sigHex)) return false;
  if (Math.abs(receivedAtMs / 1000 - Number(ts)) > THRONE_MAX_SKEW_S) return false;
  try { return crypto.verify(null, Buffer.concat([Buffer.from(`${ts}.`), body]), pem, Buffer.from(sigHex, 'hex')); } catch { return false; }
}

type J = Record<string, unknown>;
const o = (v: unknown): J => (v && typeof v === 'object' ? v as J : {});

export function parseThrone(j: unknown, creator = ''): { events: SupportEvent[]; wrongCreator: boolean } {
  const env = o(j), d = o(env.data), type = s(env.event_type, 40), eid = s(env.event_id, 80);
  if (!eid) return { events: [], wrongCreator: false };
  if (creator) {
    const c = creator.toLowerCase();
    if (s(d.creator_id, 80).toLowerCase() !== c && s(d.creator_username, 80).toLowerCase() !== c) return { events: [], wrongCreator: true };
  }
  const gifter = s(d.gifter_username, 60);
  const anon = !gifter || /^anonymous$/i.test(gifter);
  const currency = cur(d.currency);
  const surprise = d.is_surprise_gift === true;
  const item = { name: surprise ? 'a surprise gift' : s(d.item_name, 120) || 'a wishlist item', ...(!surprise && /^https:\/\//.test(s(d.item_thumbnail_url, 500)) ? { imageUrl: s(d.item_thumbnail_url, 500) } : {}) };
  const msg = s(d.message, 600);
  const cents = (v: unknown) => Math.max(0, Math.round(Number(v) || 0));
  const base = { who: { name: anon ? 'Someone' : gifter, anonymous: anon }, item, ...(msg ? { message: { text: msg, moderated: 'ok' as const } } : {}) };
  if (type === 'gift_purchased') return { events: [mkEvent('throne', eid, 'wishlist_gift', { ...base, amount: { minor: cents(d.price), currency, valuedAt: 'cash' } })], wrongCreator: false };
  if (type === 'contribution_purchased') return { events: [mkEvent('throne', eid, 'wishlist_gift', { ...base, item: { ...item, name: `${item.name} (chipped in)` }, amount: { minor: cents(d.amount), currency, valuedAt: 'cash' } })], wrongCreator: false };
  // fully funded: the money was counted with each contribution; this is only the celebration
  if (type === 'gift_crowdfunded') return { events: [mkEvent('throne', eid, 'other', { who: { name: 'Your chat', anonymous: false }, item: { ...item, name: `${item.name} is fully funded` } })], wrongCreator: false };
  return { events: [], wrongCreator: false };
}

export class ThroneConnector implements SupportConnector {
  readonly id = 'throne' as const;
  readonly mirrorsChat = true;
  private ctx: ConnectorCtx | null = null;
  constructor(private pem = THRONE_PUBLIC_KEY_PEM) {}
  start(ctx: ConnectorCtx) { this.ctx = ctx; }
  stop() { this.ctx = null; }
  status() {
    const hook = this.ctx?.settings().inboxServices.includes('throne');
    return hook ? { state: 'live' as const, detail: 'Ready ✓ Gifts show up the moment they are bought.' } : { state: 'waiting' as const, detail: 'Press “Get my address” and paste it into Throne.' };
  }
  async catchUp() { return 0; } // the relay inbox keeps 7 days of deliveries instead
  hook(d: InboxDelivery): HookResult {
    if (!verifyThrone(d.body, d.headers['x-signature-timestamp'], d.headers['x-signature-ed25519'], d.at, this.pem)) return { ok: false, why: 'signature did not match' };
    const r = parseThrone(parseJson(d.body), this.ctx?.service().creatorId ?? '');
    if (r.wrongCreator) return { ok: false, why: 'this gift is for another Throne creator' };
    return { ok: true, events: r.events };
  }
  test(): SupportEvent[] { return parseThrone(THRONE_FIXTURE).events.map((e) => ({ ...e, test: true })); }
}

/** A gift_purchased delivery in Throne's documented shape. */
export const THRONE_FIXTURE = {
  contract_version: '1', event_id: '3b7c1a52-9a1e-4c0e-9d1a-5c2f6b9e0a11', event_type: 'gift_purchased',
  data: { creator_id: 'creator_test', creator_username: 'yourname', gifter_username: 'LateShiftLiz', message: 'For the new setup!', item_name: 'Mechanical keyboard', item_thumbnail_url: 'https://thronecdn.com/test/keyboard.png', price: 8999, currency: 'USD', is_surprise_gift: false },
};
