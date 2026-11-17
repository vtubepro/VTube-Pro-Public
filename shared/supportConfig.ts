// Support & store (beta.13): the streamer's settings for the support services (server/support/*), what the studio sees
// of each service (never a key), the Fourthwall store / product showcase, and the message auto-filter. Pure: no DOM,
// no Node, no network (tools/support_unit.ts).
//
// The SupportEvent contract itself is shared/support.ts (owned by the integrator); this file is the support lane's own.
import { minorPerMajor, type SupportEvent, type SupportSource } from './support.ts';

/** The services with a connector (server/support/connectors/*). */
export type SupportService = 'fourthwall' | 'throne' | 'stripe' | 'bmc' | 'patreon' | 'kofi' | 'streamelements' | 'streamlabs';
export const SUPPORT_SERVICES: readonly SupportService[] = ['fourthwall', 'throne', 'patreon', 'kofi', 'stripe', 'bmc', 'streamelements', 'streamlabs'];

/** A secret the streamer pastes (stored encrypted on this PC only: server/support/secrets.ts). */
export interface SecretField { key: string; label: string; hint: string; /** a link where they find it */ where?: string; optional?: boolean }

export interface ServiceInfo {
  id: SupportService;
  name: string;
  /** One plain line: what you get. */
  what: string;
  /** How it connects: 'key' = paste a key (the helper asks the service), 'hook' = the service calls your inbox address,
   *  'socket' = a live connection with a pasted token. 'hook' needs the streamer's own invite server (relay). */
  how: ('key' | 'hook' | 'socket')[];
  secrets: SecretField[];
  /** Plain steps for the connect page (HTML-free). */
  steps: string[];
  /** "may break": an unofficial way in (shown with that label). */
  unofficial?: boolean;
  /** The kinds of events it sends (for the test button). */
  test: SupportEvent['kind'];
}

/** Every service, in the order the studio lists them. Words follow the zero-effort rule: no jargon, one next step. */
export const SERVICE_INFO: Record<SupportService, ServiceInfo> = {
  fourthwall: {
    id: 'fourthwall', name: 'Fourthwall', what: 'Your merch store: “Sam bought a hoodie” on stream, your products on screen, and store controls.',
    how: ['key', 'hook'],
    secrets: [
      { key: 'apiUser', label: 'API username', hint: 'From Fourthwall: Settings → For developers → Open API' },
      { key: 'apiPass', label: 'API password', hint: 'Shown next to the username' },
      { key: 'storefrontToken', label: 'Storefront token (optional)', hint: 'Settings → For developers → Storefront token: lets us show your products', optional: true },
      { key: 'hookSecret', label: 'Webhook secret (optional)', hint: 'Only if you add the webhook: Settings → For developers → Webhooks', optional: true },
    ],
    steps: ['Open your Fourthwall dashboard → Settings → For developers.', 'Turn on Open API and copy the username and password into the boxes below.', 'Press Connect. We check it and show your products.'],
    test: 'purchase',
  },
  throne: {
    id: 'throne', name: 'Throne', what: 'Wishlist gifts: “Alex gifted you a keyboard” with the item’s picture.',
    how: ['hook'], secrets: [],
    steps: ['Press “Get my address” below and copy it.', 'In Throne: Settings → Integrations → Webhooks, paste it and save.', 'Press “Send test” in Throne. You see it here.'],
    test: 'wishlist_gift',
  },
  patreon: {
    id: 'patreon', name: 'Patreon', what: 'New patrons on stream, and patrons’ names glow in chat by tier.',
    how: ['key', 'hook'],
    secrets: [
      { key: 'token', label: 'Creator access token', hint: 'patreon.com/portal → My clients → your client → Creator’s Access Token', where: 'https://www.patreon.com/portal/registration/register-clients' },
      { key: 'hookSecret', label: 'Webhook secret (optional)', hint: 'Only if you add the webhook: patreon.com/portal → My webhooks', optional: true },
    ],
    steps: ['Open patreon.com/portal → Clients & API keys → Create client (any name).', 'Copy the “Creator’s Access Token” into the box below.', 'Press Connect. Your tiers and patrons show up here.'],
    test: 'membership',
  },
  kofi: {
    id: 'kofi', name: 'Ko-fi', what: 'Ko-fi tips, memberships and shop orders on stream.',
    how: ['hook'],
    secrets: [{ key: 'verificationToken', label: 'Verification token', hint: 'Ko-fi → Settings → API → Webhooks → Advanced → Verification token', where: 'https://ko-fi.com/manage/webhooks' }],
    steps: ['Press “Get my address” below and copy it.', 'In Ko-fi: Settings → API → Webhooks, paste it as the Webhook URL and save.', 'Copy the Verification token from the same page into the box below.', 'Press “Send Single Donation Test” in Ko-fi.'],
    test: 'tip',
  },
  stripe: {
    id: 'stripe', name: 'Stripe tips', what: 'Tips through your own Stripe Payment Link (pay what you want), with a name and a message.',
    how: ['key', 'hook'],
    secrets: [
      { key: 'restrictedKey', label: 'Restricted key (read only)', hint: 'Stripe → Developers → API keys → Create restricted key: Checkout Sessions = Read, Events = Read', where: 'https://dashboard.stripe.com/apikeys' },
      { key: 'hookSecret', label: 'Webhook signing secret (optional)', hint: 'Only if you add the webhook: starts with whsec_', optional: true },
    ],
    steps: ['In Stripe, make a Payment Link: “Customers choose what to pay”, add a text field “Name to show” and one “Message”.', 'Make a restricted key with Read access to Checkout Sessions and Events, paste it below.', 'Press Connect. Tips show up within a few seconds.'],
    test: 'tip',
  },
  bmc: {
    id: 'bmc', name: 'Buy Me a Coffee', what: 'Coffees, memberships, extras and wishlist payments on stream.',
    how: ['key', 'hook'],
    secrets: [
      { key: 'token', label: 'Access token (optional)', hint: 'developers.buymeacoffee.com → your token. Lets us catch up after VTube Pro was closed.', where: 'https://developers.buymeacoffee.com/', optional: true },
      { key: 'hookSecret', label: 'Webhook secret', hint: 'Buy Me a Coffee → Integrations → Webhooks: shown after you add the address' },
    ],
    steps: ['Press “Get my address” below and copy it.', 'In Buy Me a Coffee: Integrations → Webhooks → New webhook, paste it, tick every event and save.', 'Copy its secret into the box below and press “Send test event”.'],
    test: 'tip',
  },
  streamelements: {
    id: 'streamelements', name: 'StreamElements', what: 'StreamElements tips and merch, plus Twitch / YouTube / Kick events if you don’t connect those here.',
    how: ['socket'],
    secrets: [{ key: 'jwt', label: 'JWT token', hint: 'StreamElements → your avatar → Channel settings → Show secrets → JWT Token', where: 'https://streamelements.com/dashboard/account/channels' }],
    steps: ['Open StreamElements → your avatar → Channel settings.', 'Press “Show secrets” and copy the JWT token into the box below.', 'Press Connect.'],
    test: 'tip',
  },
  streamlabs: {
    id: 'streamlabs', name: 'Streamlabs', what: 'Streamlabs tips and merch, plus Twitch / YouTube events if you don’t connect those here.',
    how: ['socket'],
    secrets: [{ key: 'socketToken', label: 'Socket API token', hint: 'Streamlabs → Settings → API Settings → API Tokens → Your Socket API Token', where: 'https://streamlabs.com/dashboard#/settings/api-settings' }],
    steps: ['Open Streamlabs → Settings → API Settings → API Tokens.', 'Copy “Your Socket API Token” into the box below.', 'Press Connect.'],
    test: 'tip',
  },
};

/** What a buyer's name looks like on stream. */
export type BuyerNames = 'first' | 'hidden' | 'full';

export interface ServiceSettings {
  enabled: boolean;
  /** Fourthwall: the shop's address (https://<name>.fourthwall.com or a custom domain) for the "buy it" link + QR. */
  shopUrl?: string;
  /** Throne: the creator's Throne username / id (the relay checks events are for this creator). */
  creatorId?: string;
}

export interface ShowcaseSettings {
  /** Show products on stream. */
  on: boolean;
  /** 'featured' = one product, 'carousel' = cycle through the shown ones. */
  mode: 'featured' | 'carousel';
  /** The featured product id ('' = the first available). */
  featured: string;
  /** Carousel: seconds per product. */
  every: number;
  /** Where on stream: 'auto' = on the room's support board when it is in the shot, else a card in a free corner. */
  where: 'auto' | 'docked' | 'world';
  /** Show the product's card when someone buys it ("Sam bought this"). */
  purchases: boolean;
  /** Product ids the streamer hid from the showcase (the store itself is unchanged). */
  hidden: string[];
  /** Show the "scan to buy" QR (the shop's own address). */
  qr: boolean;
}

export interface SupportSettings {
  /** ISO 4217: every amount is converted to this at receipt (the original is kept). */
  displayCurrency: string;
  /** Goals count gross (what the supporter paid). 'net' is reserved for later. */
  count: 'gross';
  /** 1 bit = this many US cents (1 by default). */
  bitCents: number;
  /** Merch buyers' names on stream: first name only (default), hidden ("Someone"), or as they typed it. A buyer who chose
   *  to stay anonymous is always "Someone". Emails and addresses are never shown. */
  buyerNames: BuyerNames;
  /** Hold EVERY paid message for approval (studio → Events). Off: messages show after the auto-filter. */
  holdMessages: boolean;
  /** "Filter tip messages": blocklisted words hold a message for approval. Off: no word filter at all. */
  filterMessages: boolean;
  /** "Remove links from tip messages" (links, web addresses, e-mail addresses). Off: shown as typed. */
  stripLinks: boolean;
  /** Words that hold a message for approval (and are never shown). */
  blocklist: string[];
  /** Test events count toward goals / timers (test mode). */
  testMode: boolean;
  /** The services' own test events (Fourthwall "Send test", Stripe / BMC test mode) play alerts + cards on stream. Off:
   *  they only show in the studio's feed. (The studio's own "Send a test" button always shows on stream.) */
  testsOnStream: boolean;
  /** Events that arrived while VTube Pro was closed alert on stream (else they only update goals quietly). */
  playMissedAlerts: boolean;
  /** Allow unofficial ways in (labelled "may break"). */
  unofficial: boolean;
  services: Record<SupportService, ServiceSettings>;
  showcase: ShowcaseSettings;
  /** The webhook inbox: '' = automatic (your own invite server, once you set it up), or another https:// relay of your own. */
  inboxRelay: string;
  /** Which services are connected to the inbox (their address was made). */
  inboxServices: SupportService[];
}

export const DEFAULT_SHOWCASE: ShowcaseSettings = { on: false, mode: 'featured', featured: '', every: 12, where: 'auto', purchases: true, hidden: [], qr: true };

export function defaultSupportSettings(): SupportSettings {
  const services = {} as Record<SupportService, ServiceSettings>;
  for (const s of SUPPORT_SERVICES) services[s] = { enabled: false };
  return {
    displayCurrency: 'USD', count: 'gross', bitCents: 1, buyerNames: 'first', holdMessages: false, filterMessages: true, stripLinks: true, blocklist: [], testMode: false,
    testsOnStream: false, playMissedAlerts: false, unofficial: true, services, showcase: { ...DEFAULT_SHOWCASE, hidden: [] }, inboxRelay: '', inboxServices: [],
  };
}

const CUR = /^[A-Z]{3}$/;
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const ids = (v: unknown, max = 200) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().slice(0, 80)).filter(Boolean))].slice(0, max) : []);
/** An http(s) address of a shop / relay (no credentials, no spaces). */
export const httpsUrl = (v: unknown, allowLocal = false): string => {
  const s = str(v, 300);
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.username || u.password) return '';
    if (u.protocol === 'https:') return u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''));
    if (allowLocal && u.protocol === 'http:' && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname)) return u.origin;
  } catch { /* not a URL */ }
  return '';
};

export function sanitizeSupportSettings(o: unknown, base: SupportSettings = defaultSupportSettings()): SupportSettings {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const cur = str(x.displayCurrency, 3).toUpperCase();
  const sv = (x.services && typeof x.services === 'object' ? x.services : {}) as Record<string, unknown>;
  const services = {} as Record<SupportService, ServiceSettings>;
  for (const s of SUPPORT_SERVICES) {
    const b = base.services[s] ?? { enabled: false };
    const y = (sv[s] && typeof sv[s] === 'object' ? sv[s] : {}) as Record<string, unknown>;
    const out: ServiceSettings = { enabled: bool(y.enabled, b.enabled) };
    const shop = 'shopUrl' in y ? httpsUrl(y.shopUrl) : b.shopUrl ?? '';
    if (shop) out.shopUrl = shop;
    const cid = 'creatorId' in y ? str(y.creatorId, 80).replace(/[^\w.\-]/g, '') : b.creatorId ?? '';
    if (cid) out.creatorId = cid;
    services[s] = out;
  }
  const sc = (x.showcase && typeof x.showcase === 'object' ? x.showcase : {}) as Record<string, unknown>;
  const bs = base.showcase;
  const blocklist = 'blocklist' in x ? [...new Set(ids(x.blocklist, 300).map((w) => w.toLowerCase()))] : base.blocklist;
  return {
    displayCurrency: CUR.test(cur) ? cur : base.displayCurrency,
    count: 'gross',
    bitCents: num(x.bitCents, 0.01, 100, base.bitCents),
    buyerNames: x.buyerNames === 'hidden' || x.buyerNames === 'full' || x.buyerNames === 'first' ? x.buyerNames : base.buyerNames,
    holdMessages: bool(x.holdMessages, base.holdMessages),
    filterMessages: bool(x.filterMessages, base.filterMessages ?? true),
    stripLinks: bool(x.stripLinks, base.stripLinks ?? true),
    blocklist,
    testMode: bool(x.testMode, base.testMode),
    testsOnStream: bool(x.testsOnStream, base.testsOnStream ?? false),
    playMissedAlerts: bool(x.playMissedAlerts, base.playMissedAlerts),
    unofficial: bool(x.unofficial, base.unofficial),
    services,
    showcase: {
      on: bool(sc.on, bs.on),
      mode: sc.mode === 'carousel' || sc.mode === 'featured' ? sc.mode : bs.mode,
      featured: 'featured' in sc ? str(sc.featured, 80) : bs.featured,
      every: Math.round(num(sc.every, 4, 120, bs.every)),
      where: sc.where === 'docked' || sc.where === 'world' || sc.where === 'auto' ? sc.where : bs.where,
      purchases: bool(sc.purchases, bs.purchases),
      hidden: 'hidden' in sc ? ids(sc.hidden) : bs.hidden,
      qr: bool(sc.qr, bs.qr),
    },
    inboxRelay: 'inboxRelay' in x ? httpsUrl(x.inboxRelay, true) : base.inboxRelay,
    inboxServices: 'inboxServices' in x ? (ids(x.inboxServices, 20).filter((s) => (SUPPORT_SERVICES as readonly string[]).includes(s)) as SupportService[]) : base.inboxServices,
  };
}

// ---------------------------------------------------------------- what the studio sees (no secrets, ever)
export type ServiceState = 'off' | 'connecting' | 'live' | 'waiting' | 'error';
export interface ServiceStatus {
  id: SupportService;
  enabled: boolean;
  state: ServiceState;
  /** One plain sentence ("Connected ✓ · 12 products", "Fourthwall didn’t accept that key. Paste it again."). */
  detail: string;
  /** Which secret fields are saved (names only). */
  saved: string[];
  /** The inbox address was made for this service (webhook ready). */
  hook: boolean;
  lastEventAt: number;
}
export interface SupportStatus {
  services: Record<SupportService, ServiceStatus>;
  /** How keys are kept on this PC. */
  vault: { kind: 'dpapi' | 'keychain' | 'libsecret' | 'plain'; label: string };
  inbox: { state: 'off' | 'connecting' | 'connected' | 'unsupported' | 'error'; relay: string; detail: string };
  rates: { date: string; source: string; currency: string };
  events: number;
}

// ---------------------------------------------------------------- the store + product showcase
export interface StoreProduct {
  id: string;
  slug: string;
  name: string;
  /** The image through this PC's helper (/api/support/img/<b64url>): OBS pages never fetch a shop's CDN themselves. */
  image: string;
  priceMinor: number;
  currency: string;
  /** In stock / buyable. */
  available: boolean;
  /** Shown in the shop (Fourthwall availability). */
  listed: boolean;
  /** The product page (the shop's own address). */
  url: string;
  /** "Only 3 left!" when the shop says so (read only). */
  left?: number;
}
export interface StoreCollection { id: string; slug: string; name: string }
export interface StoreSnapshot { products: StoreProduct[]; collections: StoreCollection[]; shopUrl: string; at: number; error: string }

/** What every OBS page draws: the showcase (bus {type:'supportShow'}). Flash = a purchase of a product right now. */
export interface ShowcaseView {
  on: boolean;
  mode: 'featured' | 'carousel';
  where: 'auto' | 'docked' | 'world';
  every: number;
  qr: boolean;
  shopUrl: string;
  products: StoreProduct[];
  featured: string;
  /** A purchase to celebrate (shown for ~10 s even while the showcase is off when `purchases` is on). */
  flash: { id: string; product: StoreProduct | null; itemName: string; image: string; who: string; at: number; test: boolean } | null;
}

export const MAX_SHOW_PRODUCTS = 24;
/** Images on stream always come through this PC's helper: /api/support/img/<base64url of the https address>. */
export const supportImg = (url: string) => (/^https:\/\//.test(url) ? `/api/support/img/${b64url(url)}` : '');
const b64url = (t: string) => { const b = typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(t))) : ''; return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const IMG = (u: unknown) => (typeof u === 'string' && (/^\/api\/support\/img\/[A-Za-z0-9_-]{8,1200}$/.test(u) || /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]{1,200000}$/.test(u)) ? u : '');
export function sanitizeProduct(o: unknown): StoreProduct | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  const id = str(x.id, 80), name = cleanText(str(x.name, 120), 80);
  if (!id || !name) return null;
  const cur = str(x.currency, 3).toUpperCase();
  const p: StoreProduct = {
    id, slug: str(x.slug, 120).replace(/[^\w\-]/g, ''), name, image: IMG(x.image),
    priceMinor: Math.round(num(x.priceMinor, 0, 1e9, 0)), currency: CUR.test(cur) ? cur : 'USD',
    available: x.available !== false, listed: x.listed !== false, url: httpsUrl(x.url),
  };
  if (typeof x.left === 'number' && Number.isFinite(x.left) && x.left >= 0) p.left = Math.round(Math.min(x.left, 1e6));
  return p;
}
export function sanitizeShowcase(o: unknown): ShowcaseView | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  const products = Array.isArray(x.products) ? x.products.slice(0, MAX_SHOW_PRODUCTS).map(sanitizeProduct).filter((p): p is StoreProduct => !!p) : [];
  const f = (x.flash && typeof x.flash === 'object' ? x.flash : null) as Record<string, unknown> | null;
  return {
    on: x.on === true, mode: x.mode === 'carousel' ? 'carousel' : 'featured', where: x.where === 'docked' || x.where === 'world' ? x.where : 'auto',
    every: Math.round(num(x.every, 4, 120, 12)), qr: x.qr !== false, shopUrl: httpsUrl(x.shopUrl), products, featured: str(x.featured, 80),
    flash: f ? { id: str(f.id, 200), product: sanitizeProduct(f.product), itemName: cleanText(str(f.itemName, 120), 80), image: IMG(f.image), who: cleanText(str(f.who, 60), 40) || 'Someone', at: num(f.at, 0, 1e14, 0), test: f.test === true } : null,
  };
}

/** The product a showcase shows at `now` (featured, or the carousel's current one), skipping hidden / sold-out ones. */
export function showcaseProduct(v: ShowcaseView, now: number): StoreProduct | null {
  const list = v.products.filter((p) => p.available && p.listed);
  if (!list.length) return null;
  if (v.mode === 'featured') return list.find((p) => p.id === v.featured) ?? list[0];
  const i = Math.floor(now / 1000 / Math.max(4, v.every)) % list.length;
  return list[i];
}

/** "$25.00", "€19.99", "¥2,000". */
export function moneyText(minor: number, currency: string): string {
  const cur = (currency || 'USD').toUpperCase();
  const major = minor / minorPerMajor(cur);
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: minorPerMajor(cur) === 1 ? 0 : 2 }).format(major); } catch { return `${major.toFixed(2)} ${cur}`; }
}

// ---------------------------------------------------------------- names + messages on stream
/** Bounded, control-free text (no bidi overrides). */
export function cleanText(v: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The name shown for a buyer: never an email; first name only by default; "Someone" when they asked to stay
 *  anonymous or the streamer hides buyers. */
export function buyerName(raw: string | undefined, anonymous: boolean, mode: BuyerNames): string {
  const n = cleanText(raw ?? '', 60);
  if (anonymous || mode === 'hidden' || !n || /@/.test(n) || /^anonymous$/i.test(n)) return 'Someone';
  if (mode === 'full') return n.slice(0, 40);
  return n.split(' ')[0].slice(0, 24);
}

/** Links, e-mail addresses, @-handles to other sites and domains are removed from paid messages before they reach the
 *  screen; blocklisted words hold the message for approval. */
const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[\w.+-]+@[\w-]+\.[\w.-]+\b|\b[\w-]{2,}\.(?:com|net|org|io|gg|tv|xyz|ru|cn|co|me|ly|link|live|shop|store|app|site|info|biz|us|uk|de)(?:\/\S*)?\b/gi;
export interface FilteredMessage { text: string; flagged: boolean; stripped: boolean }
/** `stripLinks: false` keeps links; an empty blocklist flags nothing. Both off = the message as typed (only control /
 *  bidi characters are removed, so it renders safely). */
export function filterMessage(raw: string, blocklist: readonly string[], o: { stripLinks?: boolean } = {}): FilteredMessage {
  const t0 = cleanText(raw, 600);
  const t1 = o.stripLinks === false ? t0 : t0.replace(LINK, '').replace(/\s+/g, ' ').trim();
  const low = t1.toLowerCase();
  const flagged = blocklist.some((w) => w && (w.includes(' ') ? low.includes(w) : new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(low)));
  return { text: t1.slice(0, 300), flagged, stripped: t1 !== t0 };
}

/** The moderation state a new paid message starts in. */
export function initialModeration(f: FilteredMessage, holdAll: boolean): 'pending' | 'ok' { return holdAll || f.flagged ? 'pending' : 'ok'; }

/** A refund / cancellation / the streamer's "Remove" (helper → pages): goals and timers drop that event. The log keeps
 *  it marked `voided` (GET /api/support/log). */
export interface SupportVoidMessage { type: 'support-void'; id: string; why: string }

/** Sources whose events count as "support services" (connectors here) rather than chat platforms. */
export const SERVICE_SOURCES: ReadonlySet<SupportSource> = new Set<SupportSource>(['fourthwall', 'throne', 'stripe', 'bmc', 'patreon', 'kofi', 'streamelements', 'streamlabs', 'tipeeestream', 'manual', 'custom']);
