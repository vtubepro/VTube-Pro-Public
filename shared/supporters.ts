// Supporters by chat identity (beta.13, the support lane): "is this chatter a patron / member, which tier, since when?"
// The audience lane (supporter name effects, !ask priority) and the chat lanes call this to style names. Pure: no DOM,
// no Node (tools/support_unit.ts).
//
// HOW TO USE IT
//   * In the helper (server/*):   import { supporterOf } from '../support/supporters.ts';
//                                 supporterOf({ platform: 'twitch', userId: '123456', login: 'nightowl42' })
//                                 -> SupporterInfo | null
//   * In a page (studio / OBS):   the helper broadcasts { type: 'supporters', list } (SupportersBusMessage) whenever the
//                                 list changes, and GET /api/support/supporters returns { list } for a page that loads
//                                 later. Build a lookup with makeSupporterLookup(list) and call it the same way:
//                                 const lookup = makeSupporterLookup(list); lookup({ platform: e.platform, login: e.user })
//   * Effects are keyed by the platform USER ID when the chat line has one (names change), else by the lower-cased login /
//     display name. Only ACTIVE supporters are in the list (a cancelled patron drops out within a day).
//
// WHERE THE LINKS COME FROM (server/support/supporters.ts, research section C):
//   1. 'link'   - the viewer typed `!link <code>` in chat: the code was made for their Patreon (or other) membership in the
//                 studio (Support & store -> Supporters -> "Make a link code") and proves the chat identity.
//   2. 'social' - Patreon's social_connections named the same Twitch / YouTube account id as the chatter (automatic).
//   3. 'manual' - the streamer typed the chat name next to a supporter in the studio (always wins).
//   4. 'native' - the platform itself said so (a Twitch sub, a YouTube member) - reserved; the chat lanes already have
//                 badges for these.
// Nothing here is sent to a website: the list stays on this PC's bus (chat identities + tier names, never an e-mail).
import type { ChatPlatform } from './chat.ts';
import type { SupportSource } from './support.ts';

/** Who is asking: a chat line's identity. `userId` (platform user id) beats `login` (name), which is matched lower-cased. */
export interface ChatIdentity { platform: ChatPlatform; userId?: string; login?: string }

export interface SupporterInfo {
  /** The tier's name as the streamer named it on the service ("Gold", "Supporter", "Member"). */
  tier: string;
  /** 1 = the cheapest tier on that service, higher = pricier (for effects that scale); 0 = unknown. */
  rank: number;
  /** The tier's monthly price in US cents when known. */
  cents?: number;
  /** Which service they support through. */
  source: SupportSource;
  /** ISO date they became a supporter (the service's own date when it says, else when the link was made). */
  since: string;
  /** How the chat identity was tied to them. */
  how: 'link' | 'social' | 'manual' | 'native';
}

/** One linked supporter as the pages see it (no e-mail, no service ids beyond the opaque linkedId). */
export interface SupporterEntry {
  /** The chat identity: platform + user id and / or login. */
  chat: { platform: ChatPlatform; userId?: string; login?: string };
  /** Their name on the service (shown in the studio's Supporters list; never on stream by itself). */
  name: string;
  /** Opaque service-side id ("patreon:12345678"). */
  linkedId: string;
  info: SupporterInfo;
}

/** helper -> this PC's pages, whenever the list changes. */
export interface SupportersBusMessage { type: 'supporters'; list: SupporterEntry[] }

/** The function the audience / chat lanes call. */
export type SupporterLookup = (who: ChatIdentity) => SupporterInfo | null;

const norm = (s: string | undefined) => String(s ?? '').trim().replace(/^@/, '').toLowerCase();
/** Keys a chat identity is found under: `twitch#<userId>` and `twitch@<login>`. */
export function supporterKeys(who: ChatIdentity): string[] {
  const out: string[] = [];
  if (who.userId) out.push(`${who.platform}#${String(who.userId).trim()}`);
  if (who.login) out.push(`${who.platform}@${norm(who.login)}`);
  return out;
}

/** A lookup over a list (pages: from the bus / GET; the helper builds its own the same way). When several services
 *  link the same chatter, the highest rank wins, then the oldest `since`. */
export function makeSupporterLookup(list: readonly SupporterEntry[]): SupporterLookup {
  const map = new Map<string, SupporterInfo>();
  const better = (a: SupporterInfo, b: SupporterInfo) => (b.rank !== a.rank ? b.rank > a.rank : b.since < a.since);
  for (const e of list) {
    for (const k of supporterKeys(e.chat)) {
      const cur = map.get(k);
      if (!cur || better(cur, e.info)) map.set(k, e.info);
    }
  }
  return (who) => {
    for (const k of supporterKeys(who)) { const v = map.get(k); if (v) return v; }
    return null;
  };
}

const PLAT = /^[a-z]{2,16}$/;
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').trim().slice(0, max) : '');
/** Sanitise a list from the bus / an API answer. */
export function sanitizeSupporters(o: unknown): SupporterEntry[] {
  if (!Array.isArray(o)) return [];
  const out: SupporterEntry[] = [];
  for (const raw of o.slice(0, 5000)) {
    if (!raw || typeof raw !== 'object') continue;
    const x = raw as Record<string, unknown>;
    const c = (x.chat && typeof x.chat === 'object' ? x.chat : {}) as Record<string, unknown>;
    const i = (x.info && typeof x.info === 'object' ? x.info : {}) as Record<string, unknown>;
    const platform = clean(c.platform, 16);
    if (!PLAT.test(platform)) continue;
    const userId = clean(c.userId, 64), login = norm(clean(c.login, 64));
    if (!userId && !login) continue;
    const how = i.how === 'link' || i.how === 'social' || i.how === 'manual' || i.how === 'native' ? i.how : 'manual';
    out.push({
      chat: { platform: platform as ChatPlatform, ...(userId ? { userId } : {}), ...(login ? { login } : {}) },
      name: clean(x.name, 60), linkedId: clean(x.linkedId, 80),
      info: {
        tier: clean(i.tier, 60) || 'Supporter', rank: typeof i.rank === 'number' && Number.isFinite(i.rank) ? Math.max(0, Math.min(50, Math.round(i.rank))) : 0,
        ...(typeof i.cents === 'number' && Number.isFinite(i.cents) && i.cents >= 0 ? { cents: Math.round(i.cents) } : {}),
        source: (clean(i.source, 20) || 'manual') as SupportSource, since: clean(i.since, 40) || new Date(0).toISOString(), how,
      },
    });
  }
  return out;
}
