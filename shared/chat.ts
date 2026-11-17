// Live chat + support ("financial") events from Kick, Rumble and YouTube (server/chat/*, ported from the Overlay
// Overlay), shared by the server (normalisation), the studio (party relay, Scene tab), OBS pages and party guests.
//
// One normalised stream: `ChatEvent` = a chat line, a support event (Super Chat, Rant, Kicks, subs, gifts …), a
// system line (follows, raids) or a moderation removal (a deleted message / a purged user). Everything that crosses
// a process boundary (bus, party link) goes through sanitizeChatEvent(): bounded strings, known fields only.

export type ChatPlatform = 'kick' | 'rumble' | 'youtube' | 'twitch' | 'tiktok' | 'test' | SupportPlatform;
/** Support services (server/support/*, beta.13): their events reach chat as 'finance' lines with the service as the
 *  platform, so `${platform}:${id}` is the SupportEvent id (shared/support.ts) and the old alerts / goal bar react. */
export type SupportPlatform = 'fourthwall' | 'throne' | 'stripe' | 'bmc' | 'patreon' | 'kofi' | 'streamelements' | 'streamlabs' | 'tipeeestream' | 'manual' | 'custom';
export const SUPPORT_PLATFORMS: readonly SupportPlatform[] = ['fourthwall', 'throne', 'stripe', 'bmc', 'patreon', 'kofi', 'streamelements', 'streamlabs', 'tipeeestream', 'manual', 'custom'];
/** The platforms with a connector (server/chat/*). */
export type LivePlatform = 'kick' | 'rumble' | 'youtube' | 'twitch' | 'tiktok';
export const LIVE_PLATFORMS: LivePlatform[] = ['twitch', 'youtube', 'kick', 'rumble', 'tiktok'];
/** Stream events that are not money (the Chat Hub events column): follows, hosts, shares, likes, joins. */
/** reward = a channel-point redemption (Kick only for now): text "redeemed <reward title>". */
export type StreamEventKind = 'follow' | 'host' | 'share' | 'like' | 'join' | 'reward';
export type ChatKind = 'chat' | 'finance' | 'system' | 'delete' | 'purge';

/** Support event kinds (an earlier overlay's finance kinds + YouTube memberships). */
export type FinanceKind =
  | 'kicks' | 'rant' | 'wallet' | 'superchat' | 'supersticker' | 'jewels' | 'tip' | 'donation'
  | 'sub' | 'resub' | 'giftSub' | 'membership' | 'milestone' | 'giftMembership' | 'raid' | 'bits' | 'tiktokGift'
  // support services (beta.13): a merch / store order, a wishlist gift (Throne), a new patron (Patreon)
  | 'purchase' | 'wishlist' | 'patron';

/** A message piece: text or an inline emote (image URL; absolute URLs load through /api/chat/img). Emote `k` = its
 *  stable key "<source>:<id>" (shared/emotes.ts: usage stats, emote sounds); `zw` = a 7TV zero-width emote (drawn over
 *  the one before it). */
export type ChatPart = { t: 'text'; v: string } | { t: 'emote'; n: string; u: string; k?: string; zw?: boolean };

export interface ChatEvent {
  /** Stable id (platform-provided when possible) — dedupe across reconnects / dual event streams. */
  id: string;
  kind: ChatKind;
  platform: ChatPlatform;
  user: string;
  /** The sender's stable platform user id when the connector knows it (YouTube channel id, Twitch user-id, TikTok
   *  uniqueId, Kick user id): display names are not unique (the chat audience keys people by this when present). */
  uid?: string;
  /** Name colour (#rrggbb) when the platform sends one. */
  color?: string;
  /** broadcaster | moderator | vip | subscriber | member | verified | og | founder | staff … */
  badges?: string[];
  text: string;
  /** Parsed message (emotes). Absent = plain `text`. */
  parts?: ChatPart[];
  /** Epoch ms. */
  ts: number;
  // ---- finance
  fkind?: FinanceKind;
  /** "Super Chat", "Rant", "Gifted Subs" … */
  label?: string;
  /** Native units: money in its currency, kicks, jewels, sub count, months, viewers. */
  amount?: number;
  /** Lower-case: usd, eur, … | kicks | jewels | subs | months | viewers. */
  currency?: string;
  /** USD value (kicks / jewels at the platform payout rate; other currencies only when the platform says). */
  usd?: number;
  /** Original-currency display ("$5.00", "€10.00", "500 Kicks", "5 subs"). */
  display?: string;
  /** Approximate USD for non-USD money (static rates, ≈). */
  approxUsd?: number;
  /** Tier / card colour (Super Chat tier, Rant tier, Kick green …). */
  tier?: string;
  /** Gifted subs / memberships: recipients (Kick names them). */
  recipients?: string[];
  giftName?: string;
  /** Twitch's sub plan (msg-param-sub-plan) for subs / resubs / gifted subs: the tier, never guessed from the message */
  subPlan?: '1000' | '2000' | '3000' | 'Prime';
  // ---- flags
  vip?: boolean;
  /** Mentions one of the streamer's own names. */
  mention?: boolean;
  /** Sent with the Scene tab's test button (never relayed to guests, never counted). */
  test?: boolean;
  /** delete: message id · purge: user name. */
  target?: string;
  /** system lines: a stream event (follow / host / share …) the Chat Hub queues. */
  ev?: StreamEventKind;
  /** A "thank on stream" replay of an earlier support event (Chat Hub): alerts / celebrations fire again, feeds don't
   *  store it a second time. */
  cue?: boolean;
  /** This finance line mirrors a SupportEvent the helper already put on the bus ({type:'support'}): its id. Code that
   *  reads SupportBusMessage skips these lines (no double counting); everything that reads chat keeps working. */
  support?: string;
}

/** Session support totals (the goal bar). */
export interface ChatTotals { usd: number; count: number; subs: number; since: number }

export interface ChatPlatformStatus {
  enabled: boolean;
  /** off | connecting | live (connected) | waiting (no live stream yet) | error */
  state: 'off' | 'connecting' | 'live' | 'waiting' | 'error';
  detail: string;
  lastEventAt: number;
  channel: string;
}
export interface ChatStatus { platforms: Record<LivePlatform, ChatPlatformStatus>; configured: boolean; running: boolean; events: number }

/** Scene options (host-owned, part of SceneState.chat — every OBS page / guest renders the same props). */
export interface SceneChatState {
  /** In-world chat monitor. */
  monitor: boolean;
  /** Support board: off | its own neon panel | shown on the chat monitor. */
  panel: 'off' | 'panel' | 'monitor';
  /** The chat buddy (an NPC holding a tablet with the chat). */
  buddy: boolean;
  /** Epoch ms the buddy was switched on (walk-in sync across pages; 0 = snap). */
  buddyAt: number;
  /** Which avatar is the chat buddy ("Who brings the chat?"): any avatar id in the library; DEFAULT_BUDDY (Sprocket)
   *  unless the host picked another. Loaded from each page's OWN library (model custody: never sent over the party
   *  link); a page that doesn't have it shows the default buddy instead. */
  buddyModel: string;
  /** Tablet size multiplier (0.6 … 2.5): a bigger tablet holds more chat at the same text size. */
  tablet: number;
  /** Tablet text size (0.5 … 1.6): smaller = more lines on the tablet, bigger = easier to read. */
  tabletText: number;
  /** 'roam' (default): he wanders around the room and raises the tablet when chat arrives · 'stay': today's
   *  behaviour, one spot per shot with the tablet always up. */
  buddyMode: 'roam' | 'stay';
  /** Roam range: anywhere in view ('room') or within ~3 m of the host ('near'). */
  buddyRange: 'room' | 'near';
  /** Monitor only drops while chat is active (a message in the last `idleSecs`). */
  autoDrop: boolean;
  idleSecs: number;
  /** Preferred side of the frame. */
  side: 'auto' | 'left' | 'right';
  /** Monitor size multiplier (0.6 … 1.6). */
  size: number;
  /** Text size multiplier (0.7 … 1.6). */
  font: number;
  hideCommands: boolean;
  hideBots: boolean;
  /** Extra bot names (lower-case). */
  bots: string[];
  /** Minimum USD value for an in-world alert (subs / gifts always alert unless alertSubs is off). */
  minAlert: number;
  alertSubs: boolean;
  /** Show ≈ USD next to non-USD amounts. */
  converted: boolean;
  goal: { on: boolean; target: number; label: string };
  /** live-tabs (Live → Privacy → Hide chat): viewers see no chat — the chat monitor, the chat buddy and the docked chat
   *  step out (the settings above are kept for when it comes back). Support alerts / the goal stay. Absent = shown. */
  hidden?: boolean;
}

/** The default chat buddy for everyone: Sprocket the robot (assets/builtin/robot), a builtin every install has. */
export const DEFAULT_BUDDY = 'robot';

export const DEFAULT_CHAT_STATE: SceneChatState = {
  monitor: false, panel: 'off', buddy: false, buddyAt: 0, buddyModel: DEFAULT_BUDDY, tablet: 1, tabletText: 1, buddyMode: 'roam', buddyRange: 'room', autoDrop: false, idleSecs: 60, side: 'auto', size: 1, font: 1,
  hideCommands: true, hideBots: true, bots: [], minAlert: 0, alertSubs: true, converted: true,
  goal: { on: false, target: 100, label: 'Stream goal' },
};

/** Known chat bots (hidden with "Hide bots"). */
export const CHAT_BOTS = ['nightbot', 'streamelements', 'streamlabs', 'moobot', 'fossabot', 'wizebot', 'botrix', 'botrixoficial', 'kickbot', 'sery_bot', 'soundalerts', 'streamerbot', 'streamer.bot', 'coebot', 'phantombot', 'deepbot', 'ankhbot', 'rumblebot', 'kicklet'];

/** Avatar ids (server/library.ts ID_RE). */
const BUDDY_ID = /^[a-z0-9][a-z0-9._-]{0,80}$/i;

// ---------------------------------------------------------------- the chat buddy model ("Who brings the chat?")
/** The builtins offered first in the picker (after the default). */
export const STARTER_BUDDIES = ['robot', 'mirelle', 'kairo'];
/** What an EMPTY buddyModel meant before the picker existed — state saved by older versions keeps the buddy it showed
 *  (only the default changed). */
export const LEGACY_BUDDY = DEFAULT_BUDDY;

/** The buddy model of a (possibly old / foreign) chat state: a valid avatar id as is; '' (saved before the picker) →
 *  LEGACY_BUDDY; missing / invalid → DEFAULT_BUDDY. */
export function buddyModelOf(v: unknown): string {
  if (v === '') return LEGACY_BUDDY;
  return typeof v === 'string' && BUDDY_ID.test(v) && !v.includes('..') ? v : DEFAULT_BUDDY;
}

export interface BuddyChoice<T> {
  id: string;
  /** Picker label: the avatar's name ("(default)" on the default; "(id)" when two share a name). */
  label: string;
  /** Plain display name ("<name> walks in holding a tablet with your chat"). */
  name: string;
  isDefault: boolean;
  /** Picked but not in this PC's library (another PC's avatar / deleted): the page shows the default instead. */
  missing: boolean;
  item: T | null;
}

/** Library avatars as picker choices: the default first, then the other starters, the current pick, then the rest
 *  by name. Test-only builtins are left out. */
export function buddyChoices<T extends { id: string; name?: string; source?: string }>(lib: readonly T[], current: string): BuddyChoice<T>[] {
  const list = lib.filter((a) => a.source !== 'builtin-test' && BUDDY_ID.test(a.id));
  const nm = (a: T) => (a.name || a.id).trim() || a.id;
  const dupe = (a: T) => list.filter((x) => nm(x).toLowerCase() === nm(a).toLowerCase()).length > 1;
  const rank = (a: T) => { const i = STARTER_BUDDIES.indexOf(a.id); return i >= 0 ? i : a.id === current ? STARTER_BUDDIES.length : STARTER_BUDDIES.length + 1; };
  const sorted = [...list].sort((a, b) => rank(a) - rank(b) || nm(a).localeCompare(nm(b)) || a.id.localeCompare(b.id));
  const out: BuddyChoice<T>[] = sorted.map((a) => {
    const name = nm(a), isDefault = a.id === DEFAULT_BUDDY;
    return { id: a.id, name, label: `${dupe(a) ? `${name} (${a.id})` : name}${isDefault ? ' (default)' : ''}`, isDefault, missing: false, item: a };
  });
  if (!out.some((c) => c.isDefault)) out.unshift({ id: DEFAULT_BUDDY, name: 'Sprocket', label: 'Sprocket (default)', isDefault: true, missing: false, item: null });
  if (current && !out.some((c) => c.id === current)) out.push({ id: current, name: current, label: `${current} (not on this PC)`, isDefault: false, missing: true, item: null });
  return out;
}

/** The display name of the buddy that will walk in on this PC (the default's when the pick isn't here). */
export function buddyNameOf<T extends { id: string; name?: string; source?: string }>(lib: readonly T[] | null, current: string): string {
  const ch = buddyChoices(lib ?? [], current);
  const c = ch.find((x) => x.id === current && !x.missing) ?? ch.find((x) => x.isDefault)!;
  return c.name;
}
const numIn = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const s = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

export function sanitizeChatState(o: unknown): SceneChatState {
  const d = DEFAULT_CHAT_STATE;
  if (!o || typeof o !== 'object') return { ...d, goal: { ...d.goal }, bots: [] };
  const x = o as Record<string, unknown>;
  const g = (x.goal && typeof x.goal === 'object' ? x.goal : {}) as Record<string, unknown>;
  return {
    monitor: x.monitor === true,
    panel: x.panel === 'panel' || x.panel === 'monitor' ? x.panel : 'off',
    buddy: x.buddy === true,
    buddyAt: Math.round(numIn(x.buddyAt, 0, 1e14, 0)),
    buddyModel: buddyModelOf(x.buddyModel),
    tablet: numIn(x.tablet, 0.6, 2.5, 1),
    tabletText: numIn(x.tabletText, 0.5, 1.6, 1),
    buddyMode: x.buddyMode === 'stay' ? 'stay' : 'roam',
    buddyRange: x.buddyRange === 'near' ? 'near' : 'room',
    autoDrop: x.autoDrop === true,
    idleSecs: Math.round(numIn(x.idleSecs, 10, 900, d.idleSecs)),
    side: x.side === 'left' || x.side === 'right' ? x.side : 'auto',
    size: numIn(x.size, 0.6, 1.6, 1),
    font: numIn(x.font, 0.7, 1.6, 1),
    hideCommands: x.hideCommands !== false,
    hideBots: x.hideBots !== false,
    bots: Array.isArray(x.bots) ? x.bots.filter((b): b is string => typeof b === 'string').map((b) => b.trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 30) : [],
    minAlert: numIn(x.minAlert, 0, 10000, 0),
    alertSubs: x.alertSubs !== false,
    converted: x.converted !== false,
    goal: { on: g.on === true, target: numIn(g.target, 1, 1e7, 100), label: s(g.label, 40) || d.goal.label },
    ...(x.hidden === true ? { hidden: true } : {}),
  };
}

// ---------------------------------------------------------------- event sanitiser (bus / party)
const PLATFORMS = new Set<string>(['kick', 'rumble', 'youtube', 'twitch', 'tiktok', 'test', ...SUPPORT_PLATFORMS]);
const EVS = new Set(['follow', 'host', 'share', 'like', 'join', 'reward', 'back']);
const KINDS = new Set(['chat', 'finance', 'system', 'delete', 'purge']);
const FKINDS = new Set(['kicks', 'rant', 'wallet', 'superchat', 'supersticker', 'jewels', 'tip', 'donation', 'sub', 'resub', 'giftSub', 'membership', 'milestone', 'giftMembership', 'raid', 'bits', 'tiktokGift', 'purchase', 'wishlist', 'patron']);
const COLOR = /^#[0-9a-fA-F]{6}$/;
/** Emote URLs: same-origin paths or http(s) (the page loads remote ones through /api/chat/img). */
const EMOTE_KEY = /^(twitch|kick|youtube|7tv|bttv|ffz):[\w:.~-]{1,80}$/;   // (= shared/emotes.ts EMOTE_KEY_RE)
const URLOK = (u: string) => /^\/[\w\-./%?=&]{1,300}$/.test(u) || /^https:\/\/[\w\-.]+(:\d+)?\/[^\s"'<>\\]{0,400}$/.test(u);
// eslint-disable-next-line no-control-regex
const clean = (v: unknown, max: number) => s(v, max * 2).replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, '').slice(0, max);
const fin = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);

export function sanitizeChatEvent(o: unknown): ChatEvent | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  const id = clean(x.id, 160), kind = String(x.kind), platform = String(x.platform);
  if (!id || !KINDS.has(kind) || !PLATFORMS.has(platform)) return null;
  const ts = fin(x.ts, 0, 1e14) ?? Date.now();
  const e: ChatEvent = { id, kind: kind as ChatKind, platform: platform as ChatPlatform, user: clean(x.user, 48) || 'anonymous', text: clean(x.text, 500), ts };
  if (typeof x.color === 'string' && COLOR.test(x.color)) e.color = x.color;
  if (typeof x.uid === 'string' && /^[\w.:@-]{1,64}$/.test(x.uid)) e.uid = x.uid;
  if (Array.isArray(x.badges)) { const b = x.badges.filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20)).filter(Boolean).slice(0, 6); if (b.length) e.badges = b; }
  if (Array.isArray(x.parts)) {
    const parts: ChatPart[] = [];
    let n = 0;
    for (const p of x.parts.slice(0, 80)) {
      if (!p || typeof p !== 'object') continue;
      const q = p as Record<string, unknown>;
      if (q.t === 'text') { const v = clean(q.v, 500); if (v) { parts.push({ t: 'text', v }); n += v.length; } }
      else if (q.t === 'emote' && typeof q.u === 'string' && URLOK(q.u)) parts.push({ t: 'emote', n: clean(q.n, 60) || '?', u: q.u, ...(typeof q.k === 'string' && EMOTE_KEY.test(q.k) ? { k: q.k } : {}), ...(q.zw === true ? { zw: true } : {}) });
      if (n > 600) break;
    }
    if (parts.some((p) => p.t === 'emote')) e.parts = parts;
  }
  if (kind === 'finance') {
    if (typeof x.fkind === 'string' && FKINDS.has(x.fkind)) e.fkind = x.fkind as FinanceKind; else return null;
    e.label = clean(x.label, 32) || undefined;
    e.amount = fin(x.amount, 0, 1e9);
    e.currency = typeof x.currency === 'string' && /^[a-z]{2,8}$/.test(x.currency) ? x.currency : undefined;
    e.usd = fin(x.usd, 0, 1e7);
    e.approxUsd = fin(x.approxUsd, 0, 1e7);
    e.display = clean(x.display, 32) || undefined;
    if (typeof x.tier === 'string' && COLOR.test(x.tier)) e.tier = x.tier;
    if (Array.isArray(x.recipients)) e.recipients = x.recipients.filter((r): r is string => typeof r === 'string').map((r) => clean(r, 40)).filter(Boolean).slice(0, 12);
    e.giftName = clean(x.giftName, 40) || undefined;
    if (x.subPlan === '1000' || x.subPlan === '2000' || x.subPlan === '3000' || x.subPlan === 'Prime') e.subPlan = x.subPlan;
  }
  if (kind === 'delete' || kind === 'purge') { e.target = clean(x.target, 160); if (!e.target) return null; }
  if (x.vip === true) e.vip = true;
  if (x.mention === true) e.mention = true;
  if (x.test === true) e.test = true;
  if (x.cue === true) e.cue = true;
  if (typeof x.support === 'string') { const sid = clean(x.support, 200); if (sid) e.support = sid; }
  if (typeof x.ev === 'string' && EVS.has(x.ev)) e.ev = x.ev as StreamEventKind;
  for (const k of Object.keys(e) as (keyof ChatEvent)[]) if (e[k] === undefined) delete e[k];
  return e;
}

export function sanitizeTotals(o: unknown): ChatTotals | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const x = o as Record<string, unknown>;
  return { usd: fin(x.usd, 0, 1e9) ?? 0, count: Math.round(fin(x.count, 0, 1e9) ?? 0), subs: Math.round(fin(x.subs, 0, 1e9) ?? 0), since: fin(x.since, 0, 1e14) ?? 0 };
}

// ---------------------------------------------------------------- display helpers
export const FINANCE_LABELS: Record<FinanceKind, string> = {
  kicks: 'Kicks', rant: 'Rumble Rant', wallet: 'Wallet Tip', superchat: 'Super Chat', supersticker: 'Super Sticker', jewels: 'Jewels Gift',
  tip: 'Tip', donation: 'Donation', sub: 'New Sub', resub: 'Resub', giftSub: 'Gifted Subs', membership: 'New Member', milestone: 'Member Milestone',
  giftMembership: 'Gifted Memberships', raid: 'Raid / Host', bits: 'Bits', tiktokGift: 'TikTok Gift',
  purchase: 'Merch', wishlist: 'Wishlist Gift', patron: 'New Patron',
};

/** Money-like (counts toward the $ goal). */
export const MONEY_KINDS = new Set<FinanceKind>(['kicks', 'rant', 'wallet', 'superchat', 'supersticker', 'jewels', 'tip', 'donation', 'bits', 'tiktokGift', 'purchase', 'wishlist']);
/** Subscription-like (alerts even without a $ value). */
export const SUB_KINDS = new Set<FinanceKind>(['sub', 'resub', 'giftSub', 'membership', 'milestone', 'giftMembership', 'patron']);

/** YouTube Super Chat tier colours by USD value (the renderer's own colour wins when present). */
export function superChatTier(usd: number): string {
  if (usd >= 100) return '#e62117';
  if (usd >= 50) return '#e91e63';
  if (usd >= 20) return '#f57c00';
  if (usd >= 10) return '#ffca28';
  if (usd >= 5) return '#1de9b6';
  if (usd >= 2) return '#00e5ff';
  return '#1e88e5';
}
/** Rumble Rant tiers (best-effort: Rumble's API doesn't send the colour; the app's tier ladder by amount). */
export function rantTier(usd: number): string {
  if (usd >= 500) return '#ff2d55';
  if (usd >= 100) return '#ff6a00';
  if (usd >= 50) return '#ffb300';
  if (usd >= 20) return '#c6ff00';
  if (usd >= 10) return '#00e676';
  if (usd >= 5) return '#00b0ff';
  if (usd >= 2) return '#7c4dff';
  return '#85c742';
}
export const PLATFORM_COLORS: Record<ChatPlatform, string> = {
  kick: '#53fc18', rumble: '#85c742', youtube: '#ff0033', twitch: '#9146ff', tiktok: '#fe2c55', test: '#9aa4b8',
  fourthwall: '#ff5c39', throne: '#a77bff', stripe: '#635bff', bmc: '#ffdd00', patreon: '#ff424d', kofi: '#29abe0',
  streamelements: '#3c74f6', streamlabs: '#80f5d2', tipeeestream: '#ff6b5b', manual: '#ffd84a', custom: '#ffd84a',
};
/** Display names of the support services (studio + alerts), spelled the way the services spell themselves. */
export const SUPPORT_PLATFORM_NAMES: Record<SupportPlatform, string> = {
  fourthwall: 'Fourthwall', throne: 'Throne', stripe: 'Stripe', bmc: 'Buy Me a Coffee', patreon: 'Patreon', kofi: 'Ko-fi',
  streamelements: 'StreamElements', streamlabs: 'Streamlabs', tipeeestream: 'TipeeeStream', manual: 'Added by you', custom: 'Custom',
};

/** Approximate USD per unit (static; for the "≈" display only — never counted as real money). */
export const APPROX_USD: Record<string, number> = {
  usd: 1, eur: 1.08, gbp: 1.27, cad: 0.73, aud: 0.66, nzd: 0.6, jpy: 0.0068, krw: 0.00073, inr: 0.012, brl: 0.18, mxn: 0.055, php: 0.017,
  sgd: 0.74, hkd: 0.128, twd: 0.031, chf: 1.12, sek: 0.093, nok: 0.092, dkk: 0.145, pln: 0.25, czk: 0.043, try: 0.029, ils: 0.27, thb: 0.028,
  idr: 0.000062, myr: 0.21, vnd: 0.00004, uah: 0.024, ngn: 0.00065, zar: 0.054, cny: 0.138, rub: 0.011, huf: 0.0027, ars: 0.001, clp: 0.0011, cop: 0.00025, pen: 0.26,
};

/** Ready-made test events for preview-only tests (an ?observer=1 studio never asks the server). */
export function testChatEvents(what: string, n = Date.now()): ChatEvent[] {
  const users = ['NightOwl42', 'PixelPioneer', 'NeonNomad', 'Beatsmith', 'LateShiftLiz'];
  const user = users[n % users.length], ts = Date.now(), id = `ptest:${what}:${n}`;
  const fin = (platform: ChatPlatform, fkind: FinanceKind, amount: number, currency: string, usd: number, display: string, tier: string, text: string): ChatEvent =>
    ({ id, kind: 'finance', platform, user, text, ts, fkind, label: FINANCE_LABELS[fkind], amount, currency, usd, display, tier, test: true });
  switch (what) {
    case 'superchat': return [fin('youtube', 'superchat', 5, 'usd', 5, '$5.00', superChatTier(5), 'Test Super Chat — love the stream!')];
    case 'rant': return [fin('rumble', 'rant', 10, 'usd', 10, '$10.00', rantTier(10), 'Test Rumble Rant 🎉')];
    case 'kicks': return [fin('kick', 'kicks', 500, 'kicks', 5, '500 Kicks', '#53fc18', 'Test Kicks!')];
    case 'gift': return [{ ...fin('kick', 'giftSub', 5, 'subs', 0, '5 subs', '#53fc18', 'gifted 5 subs'), recipients: ['a', 'b', 'c', 'd', 'e'] }];
    case 'member': return [fin('youtube', 'membership', 1, 'months', 0, 'Member', '#2ba640', 'Welcome to the crew!')];
    case 'sub': return [fin('kick', 'resub', 6, 'months', 0, '6 months', '#53fc18', 'resubbed (6 mo)')];
    case 'bits': return [fin('twitch', 'bits', 500, 'bits', 5, '500 bits', '#9146ff', 'Cheer500 test bits!')];
    case 'tiktok': return [{ ...fin('tiktok', 'tiktokGift', 100, 'coins', 0.5, '100 coins', '#fe2c55', 'sent Rose x100'), giftName: 'Rose' }];
    case 'raid': return [fin('twitch', 'raid', 42, 'viewers', 0, '42 viewers', '#9146ff', 'is raiding with 42 viewers')];
    case 'follow': return [{ id, kind: 'system', platform: 'twitch', user, text: 'just followed!', ts, ev: 'follow', test: true }];
    default: return [{ id, kind: 'chat', platform: (['kick', 'youtube', 'rumble'] as const)[n % 3], user, text: 'this room is sick 🔥', ts, badges: ['subscriber'], test: true }];
  }
}

/** Would this event be shown with these filters? */
export function chatVisible(e: ChatEvent, st: SceneChatState): boolean {
  if (e.kind === 'delete' || e.kind === 'purge') return false;
  if (e.kind === 'finance') return true;
  const u = e.user.toLowerCase();
  if (st.hideBots && (CHAT_BOTS.includes(u) || st.bots.includes(u))) return false;
  if (st.hideCommands && e.kind === 'chat' && /^\s*!\w/.test(e.text)) return false;
  return true;
}

/** Does this support event get an in-world alert? */
export function chatAlerts(e: ChatEvent, st: SceneChatState): boolean {
  if (e.kind !== 'finance' || !e.fkind) return false;
  if (e.fkind === 'raid') return true;
  if (SUB_KINDS.has(e.fkind)) return st.alertSubs;
  const v = e.usd || e.approxUsd || 0;
  return v >= st.minAlert;
}
