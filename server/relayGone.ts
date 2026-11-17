// "The invite server's address doesn't exist any more": the saved relay (config/discord.json relayUrl) no longer
// resolves, e.g. its workers.dev name was renamed, or the Worker / custom domain was deleted. Node's fetch then throws
// "TypeError: fetch failed" with the DNS error underneath (cause: "getaddrinfo ENOTFOUND <host>"), which tells a
// streamer nothing. server/routes/discord.ts and the setup probe (server/routes/setup.ts) turn it into RELAY_GONE.
// But a missing name is NOT always a renamed server (relayDnsVerdict):
//  * offline: on Windows a PC with no internet ALSO gets ENOTFOUND (libuv EAI_NONAME), so the helper first checks that
//    a well-known name still resolves; if none does, the words are RELAY_OFFLINE.
//  * brand new: "Set up my invite server" saves the address BEFORE its new workers.dev name exists in DNS (that can
//    take minutes), so for RELAY_NEW_GRACE_MS after saving, until it first answers, the words are RELAY_NOT_YET.
//  * a resolver that could not answer RIGHT NOW (EAI_AGAIN, "temporary failure in name resolution": a flaky resolver,
//    SERVFAIL, the first minutes of an internet drop while the well-known names are still cached) is not "no such
//    name" either: RELAY_OFFLINE's "try again" words, never "renamed" (relayDnsTemporary).
// Pure (no imports): tools/relay_gone_unit.ts tests it directly.

export const RELAY_GONE = "Your invite server's address doesn't exist any more (was it renamed?) — open Party → Setup and paste the new address.";
export const RELAY_NOT_YET = "Your invite server's address isn't live yet — a brand-new one can take a few minutes to appear. Try again in a minute (and check the address for typos if you pasted it).";
export const RELAY_OFFLINE = "This computer can't look up web addresses right now — check your internet connection, then try again.";
/** The setup probe, for an address that is NOT the saved one (the streamer just typed it). */
export const RELAY_TYPO = 'Nothing exists at that address. Check it for typos (a brand-new invite server can take a minute to appear).';

/** How long after the invite server's address is saved a missing name still means "brand new, not live yet". 45 min:
 *  workers.dev answers a name that does not exist yet with a negative-cache TTL of 900 s (its SOA minimum is 1800 s), so a
 *  resolver can keep saying "no such name" for 15-30 min after the name went live (b10 relaymsg verifier). */
export const RELAY_NEW_GRACE_MS = 45 * 60_000;

export type RelayDnsVerdict = 'gone' | 'new' | 'offline';
export const RELAY_DNS: Record<RelayDnsVerdict, { title: string; message: string }> = {
  gone: { title: 'Invite server not found', message: RELAY_GONE },
  new: { title: 'Invite server not live yet', message: RELAY_NOT_YET },
  offline: { title: 'No internet connection', message: RELAY_OFFLINE },
};

/** DNS "no such name" codes: Node's ENOTFOUND (getaddrinfo EAI_NONAME / EAI_NODATA), a resolver's NXDOMAIN, EAI_AGAIN. */
const NAME_GONE = /\b(ENOTFOUND|NXDOMAIN|EAI_AGAIN|EAI_NONAME|EAI_NODATA)\b/;

/** True when `e`, its `cause` chain or an AggregateError inside it is a DNS "this host name doesn't exist" failure. */
export function relayAddressGone(e: unknown, depth = 0): boolean {
  if (!e || typeof e !== 'object' || depth > 6) return false;
  const x = e as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
  if (typeof x.code === 'string' && NAME_GONE.test(x.code)) return true;
  if (typeof x.message === 'string' && NAME_GONE.test(x.message)) return true;
  if (Array.isArray(x.errors) && x.errors.some((y) => relayAddressGone(y, depth + 1))) return true;
  return relayAddressGone(x.cause, depth + 1);
}

/** The DNS codes anywhere in `e` (its cause chain, AggregateErrors inside it). */
function dnsCodes(e: unknown, out: Set<string>, depth = 0): Set<string> {
  if (!e || typeof e !== 'object' || depth > 6) return out;
  const x = e as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
  for (const s of [x.code, x.message]) if (typeof s === 'string') for (const m of s.matchAll(/\b(ENOTFOUND|NXDOMAIN|EAI_AGAIN|EAI_NONAME|EAI_NODATA)\b/g)) out.add(m[1]);
  if (Array.isArray(x.errors)) for (const y of x.errors) dnsCodes(y, out, depth + 1);
  return dnsCodes(x.cause, out, depth + 1);
}

/** True when the DNS failure in `e` is only "temporary failure in name resolution" (EAI_AGAIN): the resolver could not
 *  answer right now, which says nothing about whether the name exists. */
export function relayDnsTemporary(e: unknown): boolean {
  const c = dnsCodes(e, new Set());
  return c.size === 1 && c.has('EAI_AGAIN');
}

/** The relay's name didn't resolve: why? internetOk = a well-known name still resolves; savedAt = when this address
 *  was saved as the invite server (undefined: not the saved one, or saved before the stamp existed); answered = it has
 *  resolved / answered since then; temporary = the resolver could not answer right now (relayDnsTemporary). */
export function relayDnsVerdict(o: { internetOk: boolean; savedAt?: number; answered: boolean; now: number; temporary?: boolean }): RelayDnsVerdict {
  if (!o.internetOk || o.temporary) return 'offline';
  const age = typeof o.savedAt === 'number' ? o.now - o.savedAt : -1;
  return !o.answered && age >= 0 && age < RELAY_NEW_GRACE_MS ? 'new' : 'gone';
}
