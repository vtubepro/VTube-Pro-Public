// Hosting setup checks shared by the multiplayer setup helper (src/ui/wizards.ts), Party → Discord setup
// (src/ui/multiplayerPanel.ts) and the interview-link box (src/ui/guestLink.ts). Pure functions, no DOM, so
// tools/hosting_unit.ts can test them. The guide they point to: docs/HOSTING_SETUP.md.
//
// Every message is written for someone who has never seen a terminal: say what is wrong, what the right value looks
// like and where to get it.

/** Where the setup guide's private-links section lives (the Help viewer opens it). */
export const PRIVATE_LINKS_HELP = 'HOSTING_SETUP.md#private-links';

export type RelayCheck =
  | { ok: true; origin: string; redirect: string; privacy: LinkPrivacy; note?: string }
  | { ok: false; error: string };

export interface LinkPrivacy {
  /** 'workers-dev': https://<worker>.<account>.workers.dev (shows your Cloudflare account subdomain);
   *  'custom': your own domain; 'local': the local test relay (127.0.0.1 / localhost). */
  kind: 'workers-dev' | 'custom' | 'local';
  host: string;
  /** For workers.dev: the account part every guest link shows (e.g. "jane-doe" in vtube-pro-relay.jane-doe.workers.dev). */
  account?: string;
}

const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\])$/i;
const EXAMPLE = 'https://vtube-pro-relay.<name>.workers.dev';

/** What a relay address reveals. Never throws: a string that isn't a URL is treated as a host name. */
export function linkPrivacy(urlOrHost: string): LinkPrivacy {
  let host = String(urlOrHost ?? '').trim();
  try { host = new URL(/^[a-z]+:\/\//i.test(host) ? host : `https://${host}`).hostname; } catch { /* keep as typed */ }
  host = host.toLowerCase();
  if (LOCAL.test(host)) return { kind: 'local', host };
  const m = /^(?:[a-z0-9-]+\.)?([a-z0-9-]+)\.workers\.dev$/.exec(host);
  if (m) return { kind: 'workers-dev', host, account: m[1] };
  return { kind: 'custom', host };
}

/** A sentence for the host about what their links show, or '' when there is nothing to warn about. */
export function privacyWarning(p: LinkPrivacy): string {
  if (p.kind !== 'workers-dev') return '';
  return `Your guest links show “${p.account}” — your Cloudflare account’s workers.dev name. If that is your e-mail name or real name, rename it or use your own domain: Help → Hosting setup → Private links.`;
}

/** Check + clean a pasted relay address. Accepts a missing https://, a trailing /cb, /health or a guest link and
 *  keeps only the address part (the studio stores the origin only). */
export function checkRelayUrl(input: string): RelayCheck {
  let raw = String(input ?? '').trim().replace(/^["'<(]+|["'>).,;]+$/g, '');
  if (!raw) return { ok: false, error: `Paste your relay address first. The relay setup prints it at the end; it looks like ${EXAMPLE}.` };
  if (/\s/.test(raw)) return { ok: false, error: 'The address has a space in it. Copy it again in one piece (no spaces), for example ' + EXAMPLE + '.' };
  if (/<|>|\{|\}|your-?subdomain|<you>|\.you\.workers|\.name\.workers/i.test(raw)) return { ok: false, error: 'That is the example address. Paste YOUR relay address: the one the relay setup printed at the end.' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, error: `That isn’t a web address. It should look like ${EXAMPLE}.` }; }
  const host = u.hostname.toLowerCase();
  if (/(^|\.)discord(app)?\.com$/.test(host)) return { ok: false, error: 'That is a Discord address. Paste your RELAY address here (the one the relay setup printed, ending in .workers.dev or your own domain). The Discord app only gives you the Client ID.' };
  if (/(^|\.)cloudflare\.com$/.test(host)) return { ok: false, error: 'That is the Cloudflare dashboard address. Your relay address is different: it looks like ' + EXAMPLE + ' (Cloudflare → Workers & Pages → vtube-pro-relay shows it too).' };
  if (host === 'workers.dev' || /^[a-z0-9-]+\.workers\.dev$/.test(host)) return { ok: false, error: `That is only your account’s workers.dev name. The relay address has the relay’s name in front: https://vtube-pro-relay.${host === 'workers.dev' ? '<name>.workers.dev' : host}.` };
  const local = LOCAL.test(host);
  if (u.protocol === 'http:' && !local) return { ok: false, error: 'The relay address must start with https:// (not http://).' };
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: `The relay address must start with https://. It looks like ${EXAMPLE}.` };
  if (!local && !host.includes('.')) return { ok: false, error: `That address is incomplete. It should look like ${EXAMPLE}.` };
  if (u.username || u.password) return { ok: false, error: 'That address has a name or password in it. Paste just the relay address.' };
  const origin = u.origin;
  const dropped = (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash;
  return { ok: true, origin, redirect: relayRedirect(origin), privacy: linkPrivacy(origin), ...(dropped ? { note: `Only the address part was kept: ${origin}` } : {}) };
}

/** The OAuth2 redirect guests need in the Discord Developer Portal for this relay. */
export const relayRedirect = (origin: string) => `${origin.replace(/\/+$/, '')}/cb`;

export type ClientIdCheck = { ok: true; id: string } | { ok: false; error: string };

/** Check a pasted Discord application Client ID (a snowflake: 17-20 digits). Spots the usual mix-ups (the client
 *  secret, the bot token, the public key, a URL). 'mock-client' is the local test relay's id. */
export function checkClientId(input: string): ClientIdCheck {
  const raw = String(input ?? '').trim();
  const id = raw.replace(/\s+/g, '');
  if (!id) return { ok: false, error: 'Paste the Client ID first: Discord Developer Portal → your app → OAuth2 → Client ID → Copy.' };
  if (id === 'mock-client') return { ok: true, id };
  if (/^https?:\/\//i.test(id) || id.includes('/')) {
    const m = /client_id=(\d{17,20})/.exec(id);
    if (m) return { ok: true, id: m[1] };
    return { ok: false, error: 'That is a web address. The Client ID is only a long number: Discord Developer Portal → your app → OAuth2 → Client ID → Copy.' };
  }
  if (/^[\w-]{20,30}\.[\w-]{5,8}\.[\w-]{20,45}$/.test(id)) return { ok: false, error: 'That looks like your BOT TOKEN. Never paste it here (it belongs only in the relay setup). The Client ID is only digits: OAuth2 → Client ID.' };
  if (/^[0-9a-f]{64}$/i.test(id)) return { ok: false, error: 'That looks like the app’s Public Key. The Client ID is shorter and only digits: OAuth2 → Client ID.' };
  if (/[A-Za-z_-]/.test(id) && id.length >= 24) return { ok: false, error: 'That looks like the CLIENT SECRET (letters and numbers). Never paste the secret into VTube Pro: it goes only into the relay setup. The Client ID is only digits: OAuth2 → Client ID.' };
  if (!/^\d+$/.test(id)) return { ok: false, error: 'The Client ID is only digits (no letters or symbols). Copy it again: Discord Developer Portal → your app → OAuth2 → Client ID.' };
  if (id.length < 17 || id.length > 20) return { ok: false, error: `A Client ID is 17 to 20 digits long; this one has ${id.length}. Copy it again with the Copy button next to Client ID.` };
  return { ok: true, id };
}

export type SecretCheck = { ok: true; value: string } | { ok: false; error: string };

/** Check a pasted Discord application CLIENT SECRET (OAuth2 → Reset Secret). It goes to your own invite server only. */
export function checkClientSecret(input: string): SecretCheck {
  const v = String(input ?? '').trim();
  if (!v) return { ok: false, error: 'Paste your Discord app’s Client Secret: Discord Developer Portal → your app → OAuth2 → Reset Secret → Copy.' };
  if (/\s/.test(v)) return { ok: false, error: 'The Client Secret has a space in it. Copy it again in one piece.' };
  if (/^\d{17,20}$/.test(v)) return { ok: false, error: 'That is the Client ID (only digits). The Client Secret is a longer mix of letters and numbers: OAuth2 → Reset Secret.' };
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(v)) return { ok: false, error: 'That does not look like a Client Secret (letters, numbers, - and _). Copy it again from OAuth2 → Reset Secret.' };
  return { ok: true, value: v };
}

/** Check a pasted Discord BOT token (optional: the bot that posts the “is live, Join” message in your server). */
export function checkBotToken(input: string): SecretCheck {
  const v = String(input ?? '').trim();
  if (!v) return { ok: true, value: '' };
  if (/\s/.test(v) || !/^[A-Za-z0-9._-]{40,120}$/.test(v)) return { ok: false, error: 'That does not look like a bot token. Discord Developer Portal → your app → Bot → Reset Token → Copy (or leave it empty).' };
  return { ok: true, value: v };
}

export type HostIdsCheck = { ok: true; ids: string[] } | { ok: false; error: string };

/** Check Discord user ids for HOST_USER_IDS (comma- or space-separated snowflakes). */
export function checkHostIds(input: string): HostIdsCheck {
  const parts = String(input ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { ok: false, error: 'Paste your Discord user id (Discord → Settings → Advanced → Developer Mode on, then right-click yourself → Copy User ID).' };
  for (const p of parts) {
    if (p.startsWith('@') || /[A-Za-z]/.test(p)) return { ok: false, error: `“${p}” is a name, not a user id. The user id is a long number: right-click yourself in Discord → Copy User ID.` };
    if (!/^\d{17,20}$/.test(p)) return { ok: false, error: `“${p}” isn’t a Discord user id (they are 17 to 20 digits).` };
  }
  return { ok: true, ids: [...new Set(parts)] };
}

export type DomainCheck = { ok: true; host: string } | { ok: false; error: string };

/** Check a custom relay host name, e.g. join.example.com (a sub-domain is best: the main domain keeps its website). */
export function checkCustomDomain(input: string): DomainCheck {
  let raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return { ok: false, error: 'Type the address you want, for example join.example.com.' };
  raw = raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (raw.endsWith('.workers.dev')) return { ok: false, error: 'That is a workers.dev address. A custom domain is one you own, for example join.example.com.' };
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(raw)) return { ok: false, error: `“${raw}” isn’t a valid address. Use letters, digits and dashes, for example join.example.com.` };
  return { ok: true, host: raw };
}
