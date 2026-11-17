// The support-event contract (beta.13): every way a viewer supports the show - tips, merch, memberships, subs, gifts,
// bits, Super Chats, wishlist gifts, channel-point redemptions - normalized into ONE SupportEvent, so goals, stretch
// goals, the subathon timer, the chat audience (paid !ask, supporter name effects) and alerts all read one shape.
//
// Lanes and owners (see research/SUPPORT_INTEGRATIONS.md section E):
//   * the support lane owns the connectors (server/support/*), the event log, dedupe, currency, the test injector, and
//     emits `{ type: 'support', ev }` on the bus for every accepted event (plus the existing ChatEvent 'finance' line
//     for the old alerts/goal bar, so nothing that reads ChatEvent today breaks);
//   * the goals lane (goals, stretch goals, subathon) and the audience lane (chat audience, !ask, name effects) only
//     CONSUME SupportEvent / SupportBusMessage and may not change these types without the integrator.
// Change this file only through the integrator: it is the contract between lanes.
import type { ChatEvent, ChatPlatform } from './chat.ts';

export type SupportKind =
  | 'tip' | 'purchase' | 'membership' | 'sub' | 'gift' | 'bits' | 'superchat' | 'wishlist_gift' | 'redemption' | 'other';

export type SupportSource =
  | 'twitch' | 'youtube' | 'kick' | 'rumble' | 'tiktok'
  | 'fourthwall' | 'throne' | 'stripe' | 'bmc' | 'patreon' | 'kofi' | 'streamelements' | 'streamlabs' | 'tipeeestream'
  | 'manual' | 'custom';

/** An amount in minor units (cents; JPY minor = major) of an ISO-4217 currency. Bits: { minor: bits, currency: 'USD' }
 *  with `valuedAt` 'bits' (1 bit = 1 US cent by default, configurable). Kicks / Jewels: see `valuedAt`. */
export interface SupportMoney { minor: number; currency: string; valuedAt?: 'cash' | 'bits' | 'kicks' | 'jewels' | 'estimate' }

/** The amount converted to the streamer's display currency AT RECEIPT (stored, so totals never drift). */
export interface SupportDisplayMoney { minor: number; currency: string; rateSource: string; rateDate: string }

/** Who supported. `chat` ties the supporter to a chat identity when the platform (or a !link) knows it. */
export interface SupportWho {
  name: string;
  anonymous: boolean;
  chat?: { platform: ChatPlatform; userId: string; login?: string };
  /** a linked supporter id (Patreon member id, Fourthwall customer hash ...) once mapped to a chatter */
  linkedId?: string;
}

export interface SupportEvent {
  /** `${source}:${providerEventId}`: the global dedupe key */
  id: string;
  source: SupportSource;
  /** an aggregator that relayed it (StreamElements / Streamlabs): dropped when the native connector is active */
  via?: 'streamelements' | 'streamlabs';
  kind: SupportKind;
  amount?: SupportMoney;
  display?: SupportDisplayMoney;
  units?: { bits?: number; subs?: number; tier?: string; months?: number; gifted?: number; kicks?: number };
  who: SupportWho;
  /** gift subs / gifted memberships */
  recipient?: { name: string; chat?: { platform: ChatPlatform; userId: string } };
  /** the supporter's message. `moderated` starts 'pending' when the streamer requires approval for paid text. */
  message?: { text: string; moderated: 'pending' | 'ok' | 'hidden' };
  /** merch / wishlist item */
  item?: { name: string; imageUrl?: string; productId?: string; qty?: number; priceMinor?: number };
  /** membership / patron tier name and whether it recurs */
  tierName?: string;
  recurring: boolean;
  firstOfRecurring?: boolean;
  /** test / sandbox / dashboard-emulated: never counts toward goals or timers unless the streamer's test mode is on */
  test: boolean;
  /** ISO times */
  occurredAt: string;
  receivedAt: string;
  /** came from offline catch-up: updates goals / timers silently unless "play missed alerts" is on */
  replayed: boolean;
}

/** The bus message every accepted SupportEvent is broadcast as (server/bus.ts -> studio + OBS pages). */
export interface SupportBusMessage { type: 'support'; ev: SupportEvent }

/** A moderation decision on an event's message (studio / phone mod page -> helper -> bus). */
export interface SupportModerationMessage { type: 'support-mod'; id: string; moderated: 'ok' | 'hidden' }

export const SUPPORT_KINDS: readonly SupportKind[] =
  ['tip', 'purchase', 'membership', 'sub', 'gift', 'bits', 'superchat', 'wishlist_gift', 'redemption', 'other'];

/** Money-like kinds (count toward money goals when they carry an amount). */
export const SUPPORT_MONEY_KINDS: ReadonlySet<SupportKind> =
  new Set<SupportKind>(['tip', 'purchase', 'bits', 'superchat', 'wishlist_gift', 'membership']);

/** The display-currency amount of an event in MAJOR units (0 when it has none). */
export function supportValue(ev: SupportEvent): number {
  const d = ev.display;
  if (!d || !Number.isFinite(d.minor)) return 0;
  return d.minor / minorPerMajor(d.currency);
}

/** Minor units per major unit for a currency (ISO 4217 exponent; the common zero-decimal ones). */
export function minorPerMajor(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 1 : 100;
}
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'TWD', 'UGX', 'XAF', 'XOF', 'PYG', 'RWF', 'KMF', 'GNF', 'BIF', 'DJF', 'VUV', 'XPF']);

/** A best-effort SupportEvent for a ChatEvent 'finance' line (today's chat connectors: Twitch / YouTube / Kick / Rumble /
 *  TikTok). The support lane may replace this with richer native data; consumers can rely on it for old sources. */
export function supportFromChat(e: ChatEvent, displayCurrency = 'USD'): SupportEvent | null {
  if (e.kind !== 'finance' || !e.fkind) return null;
  const k = e.fkind;
  const kind: SupportKind =
    k === 'bits' ? 'bits'
      : k === 'superchat' || k === 'supersticker' || k === 'rant' ? 'superchat'
        : k === 'sub' || k === 'resub' ? 'sub'
          : k === 'giftSub' || k === 'giftMembership' ? 'gift'
            : k === 'membership' || k === 'milestone' ? 'membership'
              : k === 'tip' || k === 'donation' || k === 'kicks' || k === 'wallet' || k === 'jewels' || k === 'tiktokGift' ? 'tip'
                : 'other';
  const at = new Date(typeof e.ts === 'number' ? e.ts : Date.now()).toISOString();
  // ChatEvent.amount is in native units: money in its currency, or kicks / jewels / subs / months / viewers
  const unit = (e.currency || '').toLowerCase();
  const n = typeof e.amount === 'number' && Number.isFinite(e.amount) && e.amount > 0 ? e.amount : 0;
  const counted = unit === 'subs' || unit === 'months' || unit === 'viewers';
  const cur = unit === 'kicks' || unit === 'jewels' || !unit ? 'USD' : unit.toUpperCase();
  const amt = counted ? 0 : unit === 'kicks' || unit === 'jewels' ? 0 : n;
  const usd = typeof e.usd === 'number' && Number.isFinite(e.usd) && e.usd > 0 ? e.usd : 0;
  const ev: SupportEvent = {
    id: `${e.platform}:${e.id}`,
    source: e.platform as SupportSource,
    kind,
    // (chat lines carry the display name only: the lower-cased name stands in for the user id)
    who: { name: e.user || 'Someone', anonymous: !e.user, ...(e.user ? { chat: { platform: e.platform, userId: e.user.toLowerCase(), login: e.user } } : {}) },
    recurring: k === 'resub' || k === 'membership' || k === 'milestone',
    test: !!e.test,
    occurredAt: at,
    receivedAt: at,
    replayed: false,
  };
  if (amt) ev.amount = { minor: Math.round(amt * minorPerMajor(cur)), currency: cur, valuedAt: k === 'bits' ? 'bits' : 'cash' };
  else if ((unit === 'kicks' || unit === 'jewels') && usd) ev.amount = { minor: Math.round(usd * 100), currency: 'USD', valuedAt: unit };
  if (unit === 'kicks' && n) ev.units = { kicks: n };
  else if (unit === 'subs' && n) ev.units = { [k === 'giftSub' || k === 'giftMembership' ? 'gifted' : 'subs']: n };
  else if (unit === 'months' && n) ev.units = { months: n };
  // the platform's own sub plan (Twitch msg-param-sub-plan), never a guess from the message (optional adapter field)
  if (e.subPlan) ev.units = { ...(ev.units ?? {}), tier: e.subPlan };
  if (usd && displayCurrency.toUpperCase() === 'USD') ev.display = { minor: Math.round(usd * 100), currency: 'USD', rateSource: 'chat', rateDate: at.slice(0, 10) };
  if (e.text) ev.message = { text: e.text, moderated: 'ok' };
  // (ChatEvent.tier is the card colour, not a membership tier: the tier name comes from the connector, never from here)
  return ev;
}
