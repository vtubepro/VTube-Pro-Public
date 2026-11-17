// The chat audience (beta.13): everyone active in chat gets a seat in rooms that have audience seats, with their name
// above their head; supporters' names get effects (glow / colour / badge / trail, per tier); viewers ask questions with
// !ask (or a paid message) that a moderator approves before they show above the asker's head.
//
// This file is the PURE core shared by the helper (server/audience.ts: the roster, the question queue, the supporter
// book) and the pages (src/scene/audience/*: seats, bodies, names, bubbles; the studio panel): settings + sanitiser,
// the chat-identity key, supporter tiers + name effects, the active-chatter roster with its slot table, the !ask queue
// state machine, the moderation filter and the bus view. No DOM, no file system, no network: tools/audience_unit.ts
// tests it. Seats (room geometry) are in shared/audienceSeats.ts.
//
// Contracts consumed (never changed here): shared/support.ts (SupportEvent), shared/chat.ts (ChatEvent).
import { CHAT_BOTS, type ChatEvent, type ChatPlatform } from './chat.ts';
import { supportValue, type SupportEvent, type SupportSource } from './support.ts';
import { chatIdCore } from './chatRemove.ts';

// ---------------------------------------------------------------- identity
/** A chatter's identity key: `<platform>:<lower-cased login / display name>`. ChatEvent carries the display name only,
 *  so (like shared/support.ts supportFromChat) the lower-cased name stands in for the platform user id. */
export const chatKey = (platform: string, user: string) => `${platform}:${String(user ?? '').trim().toLowerCase()}`;

/** The chat identity a supporter-status lookup is asked about. */
export interface ChatIdentity { platform: ChatPlatform; user: string; userId?: string }

/** A chatter as the audience keys them: the platform's STABLE user id when the connector knows it (YouTube channel id,
 *  Twitch user-id, TikTok uniqueId, Kick user id — ChatEvent.uid), else only the display name (not unique!). */
export interface Identity { platform: ChatPlatform; user: string; uid?: string }
/** The key of a person: `platform#uid` when the stable id is known, else chatKey (`platform:lower-cased name`). */
export const personKey = (platform: string, user: string, uid?: string | null) => (uid ? `${platform}#${uid}` : chatKey(platform, user));
/** Who a SupportEvent is from (a chat identity), or null. A `who.chat.userId` that is only the lower-cased name (what
 *  shared/support.ts supportFromChat writes) is not an id. */
export function supportIdentity(ev: SupportEvent): Identity | null {
  const plat = ev.who.chat?.platform ?? (PLATFORM_SOURCES.has(ev.source) ? (ev.source as ChatPlatform) : null);
  const user = ev.who.chat?.login ?? ev.who.name;
  if (!plat || !user) return null;
  const id = ev.who.chat?.userId;
  const uid = id && id !== String(user).toLowerCase() && id !== String(ev.who.name).toLowerCase() ? id : undefined;
  return { platform: plat, user, ...(uid ? { uid } : {}) };
}

// ---------------------------------------------------------------- tiers + name effects
/** Supporter tiers that can carry a name effect, highest precedence first. patron_* = Patreon and other
 *  membership-style supporters (Fourthwall / Ko-fi / Buy Me a Coffee members); member = platform subs / members;
 *  tipper = tipped at least `tipperUsd` this session; vip / mod = chat badges. */
export type EffectTier = 'patron_top' | 'patron_plus' | 'patron' | 'member' | 'tipper' | 'vip' | 'mod';
export const EFFECT_TIERS: readonly EffectTier[] = ['patron_top', 'patron_plus', 'patron', 'member', 'tipper', 'vip', 'mod'];
export const TIER_LABELS: Record<EffectTier, string> = {
  patron_top: 'Top patrons', patron_plus: 'Big patrons', patron: 'Patrons & members', member: 'Subs & channel members',
  tipper: 'Tipped this stream', vip: 'VIPs', mod: 'Moderators',
};
/** Rank for eviction / priority (higher = more important); untiered = 0. */
export const tierRank = (t: EffectTier | null | undefined) => (t ? EFFECT_TIERS.length - EFFECT_TIERS.indexOf(t) : 0);

export type NameBadge = 'none' | 'crown' | 'diamond' | 'gem' | 'heart' | 'star' | 'bolt' | 'shield';
export const NAME_BADGES: readonly NameBadge[] = ['none', 'crown', 'diamond', 'gem', 'heart', 'star', 'bolt', 'shield'];
export type NameTrail = 'none' | 'sparkle' | 'hearts' | 'stars' | 'embers';
export const NAME_TRAILS: readonly NameTrail[] = ['none', 'sparkle', 'hearts', 'stars', 'embers'];

export interface NameEffect {
  on: boolean;
  /** '' = keep the chatter's own chat colour. */
  color: string;
  /** '' = no glow. */
  glow: string;
  badge: NameBadge;
  /** Little particles rising round the name (3D audience only). */
  trail: NameTrail;
  /** The name gently breathes in size / brightness (3D audience only). */
  pulse: boolean;
}

export const DEFAULT_EFFECTS: Record<EffectTier, NameEffect> = {
  patron_top: { on: true, color: '#ffd34d', glow: '#ffae00', badge: 'crown', trail: 'sparkle', pulse: true },
  patron_plus: { on: true, color: '#ffb3ec', glow: '#ff4fb8', badge: 'diamond', trail: 'hearts', pulse: false },
  patron: { on: true, color: '', glow: '#ff7a59', badge: 'heart', trail: 'none', pulse: false },
  member: { on: true, color: '', glow: '', badge: 'star', trail: 'none', pulse: false },
  tipper: { on: true, color: '', glow: '#35e3ff', badge: 'bolt', trail: 'none', pulse: false },
  vip: { on: true, color: '', glow: '', badge: 'gem', trail: 'none', pulse: false },
  mod: { on: false, color: '', glow: '', badge: 'shield', trail: 'none', pulse: false },
};

/** What a name looks like once the tier's effect is applied (the 3D name tags and the chat box hook). */
export interface NameStyle { tier: EffectTier | null; color: string; glow: string; badge: NameBadge; trail: NameTrail; pulse: boolean }

// ---------------------------------------------------------------- settings
export type AudienceWho = 'everyone' | 'subs' | 'supporters';
export type AskWho = 'everyone' | 'subs' | 'supporters' | 'paid' | 'off';

export interface AskSettings {
  on: boolean;
  /** The chat command without "!" (letters / digits, 1-16): "ask" = !ask. */
  command: string;
  /** More names for the same command, same rules (default "axe": !axe asks exactly like !ask). At most 4. */
  aliases: string[];
  /** Who may use the free command ('paid' = only paid messages become questions). */
  who: AskWho;
  /** Paid questions: a tip / Super Chat / bits ... of at least `minUsd` with a message becomes a question (only messages
   *  starting with "Q:" when `prefix`). Off by default. */
  paid: { on: boolean; minUsd: number; prefix: boolean };
  /** A tip from the same chatter within this many minutes of their !ask raises its priority. */
  bumpMin: number;
  /** Longest question shown (characters). */
  maxLen: number;
  /** Seconds before the same chatter can ask again after their question was answered or skipped. */
  cooldownSec: number;
  /** Approved questions shown above their askers' heads at once (besides the one being answered), 0-5. */
  cards: number;
  /** "Answer now" cuts the camera to the asker for a few seconds (rooms with audience seats). */
  askerCut: boolean;
  /** Questions wait for a moderator's OK (default on). Off = "Show questions without approval": a question goes up as
   *  approved unless the word / link filter held it back. */
  approve: boolean;
  /** A clean overlay card with the question being answered: 'auto' = only when the room has no audience seats. */
  overlay: 'auto' | 'on' | 'off';
}

export interface AudienceSettings {
  on: boolean;
  /** Most audience members at once (the room's seats may cap it lower). */
  max: number;
  who: AudienceWho;
  /** How long a chatter keeps their seat: 'stream' (default) = the whole stream (nobody leaves over time; a new stream
   *  starts fresh: OBS starting to stream, or 6 hours without a word from them), 'minutes' = `windowMin` minutes after
   *  their last message (supporters twice as long). Either way, when every seat the room has is taken a newcomer takes
   *  the seat of whoever has been quiet longest (90 s or more), and someone whose question is on screen keeps theirs. */
  keep: 'stream' | 'minutes';
  /** With keep 'minutes': a chatter stays this many minutes after their last message (supporters twice as long). */
  windowMin: number;
  names: { size: number; platform: boolean; declutter: boolean };
  /** Speech bubbles with chat messages above the audience (off by default: unmoderated chat text, the streamer opts in). */
  bubbles: boolean;
  /** Reaction size 0 (calm) ... 2 (wild). */
  intensity: number;
  /** Rooms with a background crowd but no audience seats: put chat names over the crowd's characters. */
  crowdNames: boolean;
  /** Extra words that hide a bubble / flag a question (lower-case). */
  blocklist: string[];
  /** Use the built-in list of slurs as well. */
  builtinBlock: boolean;
  /** Words the filter must never block (lower-case): a false alarm the streamer overrides. */
  allowWords: string[];
  /** Display names always shown as they are (lower-case), whatever the filter thinks. */
  allowNames: string[];
  /** The owner's switches (default ON; once switched off they stay off — never re-enabled on an update):
   *  `filterWords` = the blocklist + the built-in list; `filterLinks` = removing / holding back links. They apply to
   *  names, bubbles, !ask questions and emote names. Off = shown as typed (invisible / bidi-control characters are
   *  still removed: that keeps the drawing safe, it is not filtering). */
  filterWords: boolean;
  filterLinks: boolean;
  /** Names that never get a seat (lower-case; bots are always left out). */
  exclude: string[];
  ask: AskSettings;
  effects: Record<EffectTier, NameEffect>;
  /** Patron tier ladder: monthly USD thresholds and tier names (case-insensitive) that count as plus / top. */
  patron: { plusUsd: number; topUsd: number; plusTiers: string[]; topTiers: string[] };
  /** Tipped at least this much (USD) this session = the 'tipper' tier. */
  tipperUsd: number;
  /** Hand-picked name effects: chat name (or "platform:name") -> tier. Works before any Patreon link exists. */
  manual: { who: string; tier: EffectTier }[];
}

export const DEFAULT_ASK: AskSettings = {
  on: true, command: 'ask', aliases: ['axe'], who: 'everyone', paid: { on: false, minUsd: 5, prefix: false }, bumpMin: 10, maxLen: 200,
  cooldownSec: 60, cards: 2, askerCut: true, approve: true, overlay: 'auto',
};

export const DEFAULT_AUDIENCE: AudienceSettings = {
  on: true, max: 80, who: 'everyone', keep: 'stream', windowMin: 15, names: { size: 1, platform: true, declutter: true }, bubbles: false,
  intensity: 1, crowdNames: true, blocklist: [], builtinBlock: true, allowWords: [], allowNames: [], filterWords: true, filterLinks: true, exclude: [], ask: DEFAULT_ASK,
  effects: DEFAULT_EFFECTS, patron: { plusUsd: 10, topUsd: 25, plusTiers: [], topTiers: [] }, tipperUsd: 5, manual: [],
};

const HEX = /^#[0-9a-fA-F]{6}$/;
/** Chat commands other features own (polls, the Trail game, the goals lane's timer commands, links): !ask can't be renamed to them. */
export const RESERVED_COMMANDS: ReadonlySet<string> = new Set(['vote', 'addtime', 'subtime', 'happyhour', 'pausetimer', 'resumetimer', 'undotime', 'sleepmode', 'spin', 'link', 'poll', 'goal', 'timer']);
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
const hex = (v: unknown, d: string) => (typeof v === 'string' && (v === '' || HEX.test(v)) ? v.toLowerCase() : d);
const words = (v: unknown, max: number, len = 40) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().toLowerCase().slice(0, len)).filter(Boolean))].slice(0, max) : []);
const obj = (v: unknown) => (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
/** A usable name for the question command ("!" and case stripped): letters / digits, 1-16, starting with a letter (a
 *  number is a Trail vote), never another feature's command; null = not usable. */
const commandName = (v: unknown): string | null => {
  const c = typeof v === 'string' ? v.trim().replace(/^!+/, '').toLowerCase() : '';
  return /^[a-z][a-z0-9]{0,15}$/.test(c) && !RESERVED_COMMANDS.has(c) ? c : null;
};

export function sanitizeEffect(o: unknown, d: NameEffect): NameEffect {
  const x = obj(o);
  return { on: bool(x.on, d.on), color: hex(x.color, d.color), glow: hex(x.glow, d.glow), badge: oneOf(x.badge, NAME_BADGES, d.badge), trail: oneOf(x.trail, NAME_TRAILS, d.trail), pulse: bool(x.pulse, d.pulse) };
}

export function sanitizeAudience(o: unknown, base: AudienceSettings = DEFAULT_AUDIENCE): AudienceSettings {
  const x = obj(o), a = obj(x.ask), pd = obj(a.paid), nm = obj(x.names), ef = obj(x.effects), pt = obj(x.patron);
  const b = base, ba = b.ask;
  const cmd = typeof a.command === 'string' ? a.command.trim().replace(/^!+/, '').toLowerCase() : ba.command;
  const command = commandName(cmd) ?? ba.command;
  const al = typeof a.aliases === 'string' ? a.aliases.split(/[\s,]+/) : a.aliases;
  const effects = {} as Record<EffectTier, NameEffect>;
  for (const t of EFFECT_TIERS) effects[t] = sanitizeEffect(ef[t], b.effects?.[t] ?? DEFAULT_EFFECTS[t]);   // a tier added later gets its default
  const manual = Array.isArray(x.manual) ? x.manual : b.manual;
  return {
    on: bool(x.on, b.on),
    max: Math.round(num(x.max, 10, 200, b.max)),
    who: oneOf(x.who, ['everyone', 'subs', 'supporters'] as const, b.who),
    keep: oneOf(x.keep, ['stream', 'minutes'] as const, b.keep ?? 'stream'),
    windowMin: Math.round(num(x.windowMin, 2, 120, b.windowMin)),
    names: { size: num(nm.size, 0.5, 2, b.names.size), platform: bool(nm.platform, b.names.platform), declutter: bool(nm.declutter, b.names.declutter) },
    bubbles: bool(x.bubbles, b.bubbles),
    intensity: num(x.intensity, 0, 2, b.intensity),
    crowdNames: bool(x.crowdNames, b.crowdNames),
    blocklist: 'blocklist' in x ? words(x.blocklist, 300) : b.blocklist,
    builtinBlock: bool(x.builtinBlock, b.builtinBlock),
    allowWords: 'allowWords' in x ? words(x.allowWords, 200) : b.allowWords,
    filterWords: bool(x.filterWords, b.filterWords),
    filterLinks: bool(x.filterLinks, b.filterLinks),
    allowNames: 'allowNames' in x ? words(x.allowNames, 200, 48) : b.allowNames,
    exclude: 'exclude' in x ? words(x.exclude, 200, 48) : b.exclude,
    ask: {
      on: bool(a.on, ba.on),
      command,
      aliases: [...new Set((Array.isArray(al) ? al.map(commandName) : (ba.aliases ?? DEFAULT_ASK.aliases))
        .filter((c): c is string => !!c && c !== command))].slice(0, 4),
      who: oneOf(a.who, ['everyone', 'subs', 'supporters', 'paid', 'off'] as const, ba.who),
      paid: { on: bool(pd.on, ba.paid.on), minUsd: num(pd.minUsd, 0.5, 10000, ba.paid.minUsd), prefix: bool(pd.prefix, ba.paid.prefix) },
      bumpMin: Math.round(num(a.bumpMin, 0, 120, ba.bumpMin)),
      maxLen: Math.round(num(a.maxLen, 40, 400, ba.maxLen)),
      cooldownSec: Math.round(num(a.cooldownSec, 0, 3600, ba.cooldownSec)),
      cards: Math.round(num(a.cards, 0, 5, ba.cards)),
      askerCut: bool(a.askerCut, ba.askerCut),
      approve: bool(a.approve, ba.approve),
      overlay: oneOf(a.overlay, ['auto', 'on', 'off'] as const, ba.overlay),
    },
    effects,
    patron: {
      plusUsd: num(pt.plusUsd, 1, 100000, b.patron.plusUsd), topUsd: num(pt.topUsd, 1, 100000, b.patron.topUsd),
      plusTiers: 'plusTiers' in pt ? words(pt.plusTiers, 20) : b.patron.plusTiers, topTiers: 'topTiers' in pt ? words(pt.topTiers, 20) : b.patron.topTiers,
    },
    tipperUsd: num(x.tipperUsd, 0.5, 100000, b.tipperUsd),
    manual: manual.map((m) => obj(m)).map((m) => ({ who: typeof m.who === 'string' ? m.who.trim().toLowerCase().slice(0, 60) : '', tier: oneOf(m.tier, EFFECT_TIERS, 'patron') })).filter((m) => m.who).slice(0, 200),
  };
}

// ---------------------------------------------------------------- supporter status (local interface; swap point)
/** What is known about a chatter as a supporter. The support lane's shared/supporters.ts `supporterOf(chatIdentity)`
 *  is meant to replace SupporterBook: anything implementing SupporterLookup plugs into the helper (server/audience.ts
 *  setSupporterLookup). */
export interface SupporterStatus {
  /** The strongest supporter tier from support events / badges (null = none; vip / mod come from badges only). */
  tier: EffectTier | null;
  source: SupportSource | 'badge' | 'manual' | null;
  /** Epoch ms the current tier began. */
  since: number;
  tierName?: string;
  monthlyUsd?: number;
  /** Tips this session (display currency, major units). */
  tippedUsd: number;
  lastTipAt: number;
}
export interface SupporterLookup { supporterOf(id: ChatIdentity): SupporterStatus | null }

const PLATFORM_SOURCES = new Set<string>(['twitch', 'youtube', 'kick', 'rumble', 'tiktok']);
const MEMBER_BADGES = /^(subscriber|sub|member|founder|og|premium)$/;
const MOD_BADGES = /^(moderator|mod|broadcaster|staff|admin)$/;

/** The patron tier of a membership-style event by tier name, then monthly value. */
export function patronTier(ev: Pick<SupportEvent, 'tierName' | 'amount' | 'display'> & Partial<SupportEvent>, s: Pick<AudienceSettings, 'patron'>): EffectTier {
  const name = (ev.tierName ?? '').trim().toLowerCase();
  if (name && s.patron.topTiers.includes(name)) return 'patron_top';
  if (name && s.patron.plusTiers.includes(name)) return 'patron_plus';
  const usd = monthlyUsdOf(ev);
  if (usd >= s.patron.topUsd) return 'patron_top';
  if (usd >= s.patron.plusUsd) return 'patron_plus';
  return 'patron';
}
function monthlyUsdOf(ev: Partial<SupportEvent>): number {
  const v = ev.display ? supportValue(ev as SupportEvent) : 0;
  if (v > 0) return v;
  const a = ev.amount;
  return a && a.currency?.toUpperCase() === 'USD' && Number.isFinite(a.minor) ? a.minor / 100 : 0;
}

/** Session supporter memory, fed by SupportEvents and chat badges. RAM only (nothing about chatters is stored). Keyed
 *  like the roster (personKey: the platform user id when known, else the name). */
export class SupporterBook implements SupporterLookup {
  private map = new Map<string, SupporterStatus>();
  private badges = new Map<string, EffectTier>();
  /** key → lower-case name (manual effects match names) */
  private names = new Map<string, string>();
  constructor(public settings: () => Pick<AudienceSettings, 'patron' | 'tipperUsd' | 'manual'>) {}

  /** A support event: memberships / subs set a tier, money adds to the session tips. `who` = the supporter's chat identity
   *  when the caller knows it better than the event (chat 'finance' lines carry the platform user id). Returns the
   *  chatter key it concerned (null when the supporter has no chat identity). */
  onSupport(ev: SupportEvent, now = Date.now(), who: Identity | null = supportIdentity(ev)): string | null {
    if (ev.who.anonymous || !who) return null;
    const k = personKey(who.platform, who.user, who.uid);
    this.names.set(k, who.user.trim().toLowerCase());
    const st = this.map.get(k) ?? { tier: null, source: null, since: now, tippedUsd: 0, lastTipAt: 0 };
    const usd = supportValue(ev);
    const platformSub = PLATFORM_SOURCES.has(ev.source) && (ev.kind === 'sub' || ev.kind === 'membership');
    let tier: EffectTier | null = null;
    if (platformSub) tier = 'member';
    else if (ev.kind === 'membership') tier = patronTier(ev, this.settings());
    if (tier) {
      st.tier = better(st.tier, tier); st.source = ev.source; st.since = st.tier === tier ? now : st.since;
      if (ev.tierName) st.tierName = ev.tierName;
      if (!platformSub) st.monthlyUsd = Math.max(st.monthlyUsd ?? 0, monthlyUsdOf(ev));
    }
    if (usd > 0 && ev.kind !== 'membership' && ev.kind !== 'sub') {
      st.tippedUsd = +(st.tippedUsd + usd).toFixed(2); st.lastTipAt = now;
      if (!st.source) st.source = ev.source;
    }
    this.map.set(k, st);
    // a gifted sub makes the recipient a member too
    if (ev.recipient?.chat || (ev.kind === 'gift' && ev.recipient?.name)) {
      const rp = ev.recipient.chat?.platform ?? who.platform;
      const rk = ev.recipient.chat?.userId && ev.recipient.chat.userId !== ev.recipient.name.toLowerCase() ? personKey(rp, ev.recipient.name, ev.recipient.chat.userId) : chatKey(rp, ev.recipient.name);
      const r = this.map.get(rk) ?? { tier: null, source: null, since: now, tippedUsd: 0, lastTipAt: 0 };
      r.tier = better(r.tier, 'member'); r.source = r.source ?? ev.source; this.map.set(rk, r); this.names.set(rk, ev.recipient.name.trim().toLowerCase());
    }
    if (this.map.size > 5000) { const drop = [...this.map.keys()].slice(0, 1000); for (const d of drop) { this.map.delete(d); this.names.delete(d); } }
    return k;
  }

  /** Chat badges (sub / member / founder → member, vip, moderator → mod). */
  onChat(e: Pick<ChatEvent, 'platform' | 'user' | 'badges' | 'vip' | 'uid'>) {
    const t = badgeTier(e.badges, e.vip);
    const k = personKey(e.platform, e.user, e.uid);
    if (t) { this.badges.set(k, t); this.names.set(k, e.user.trim().toLowerCase()); } else this.badges.delete(k);
    if (this.badges.size > 5000) { const drop = [...this.badges.keys()].slice(0, 1000); for (const d of drop) this.badges.delete(d); }
  }

  supporterOf(id: ChatIdentity): SupporterStatus | null {
    const k = personKey(id.platform, id.user, id.userId);
    return this.statusOf(k, id.platform, id.user.trim().toLowerCase());
  }
  private statusOf(k: string, platform: string, name: string): SupporterStatus | null {
    const st = this.map.get(k) ?? null;
    const s = this.settings();
    const man = s.manual.find((m) => m.who === k || m.who === `${platform}:${name}` || m.who === name);
    const bt = this.badges.get(k) ?? null;
    let tier = st?.tier ?? null;
    if (st && st.tippedUsd >= s.tipperUsd) tier = better(tier, 'tipper');
    tier = better(tier, bt);
    if (man) tier = better(tier, man.tier);
    if (!tier && !st) return null;
    return { tier, source: man && tier === man.tier ? 'manual' : st?.source ?? (bt ? 'badge' : null), since: st?.since ?? 0, tippedUsd: st?.tippedUsd ?? 0, lastTipAt: st?.lastTipAt ?? 0, ...(st?.tierName ? { tierName: st.tierName } : {}), ...(st?.monthlyUsd ? { monthlyUsd: st.monthlyUsd } : {}) };
  }

  /** Everyone with a tier (for the chat box's name styles), bounded: person keys, plus hand-picked names as
   *  `platform:name` / `*:name`. */
  tiers(max = 500): Record<string, EffectTier> {
    const out: Record<string, EffectTier> = {};
    let n = 0;
    for (const k of new Set([...this.map.keys(), ...this.badges.keys()])) {
      if (n >= max) break;
      const i = Math.max(k.indexOf(':'), k.indexOf('#'));
      const st = this.statusOf(k, k.slice(0, i), this.names.get(k) ?? k.slice(i + 1));
      if (st?.tier) { out[k] = st.tier; n++; }
    }
    for (const m of this.settings().manual) { if (n >= max) break; out[m.who.includes(':') ? m.who : `*:${m.who}`] = better(out[m.who], m.tier) ?? m.tier; n++; }
    return out;
  }
  clear() { this.map.clear(); this.badges.clear(); this.names.clear(); }
}

export function badgeTier(badges: readonly string[] | undefined, vip?: boolean): EffectTier | null {
  let t: EffectTier | null = null;
  for (const b of badges ?? []) {
    if (MEMBER_BADGES.test(b)) t = better(t, 'member');
    else if (b === 'vip') t = better(t, 'vip');
    else if (MOD_BADGES.test(b)) t = better(t, 'mod');
  }
  if (vip) t = better(t, 'vip');
  return t;
}
export const better = (a: EffectTier | null | undefined, b: EffectTier | null | undefined): EffectTier | null => (tierRank(b) > tierRank(a) ? b ?? null : a ?? null);

/** The name style for a chatter: their tier's effect (when on), else their own chat colour. */
export function resolveNameStyle(tier: EffectTier | null | undefined, chatColor: string | undefined, s: Pick<AudienceSettings, 'effects'>): NameStyle {
  const base = HEX.test(chatColor ?? '') ? chatColor!.toLowerCase() : '';
  const fx = tier ? s.effects[tier] : null;
  if (!tier || !fx || !fx.on) return { tier: null, color: base, glow: '', badge: 'none', trail: 'none', pulse: false };
  return { tier, color: fx.color || base, glow: fx.glow, badge: fx.badge, trail: fx.trail, pulse: fx.pulse };
}

// ---------------------------------------------------------------- moderation filter
// The built-in list: the worst slurs, base64 so the source stays clean. Matched on normalised whole words.
const BUILTIN_B64 = 'bmlnZ2VyLG5pZ2dhLGZhZ2dvdCxmYWcscmV0YXJkLHRyYW5ueSxraWtlLHNwaWMsY2hpbmssd2V0YmFjayxjb29uLGR5a2Usbmlnbm9n';
let builtin: string[] | null = null;
function builtinWords(): string[] {
  if (builtin) return builtin;
  try {
    const s = typeof atob === 'function' ? atob(BUILTIN_B64) : (globalThis as unknown as { Buffer: { from(s: string, e: string): { toString(e: string): string } } }).Buffer.from(BUILTIN_B64, 'base64').toString('utf8');
    builtin = s.split(',').map((w) => w.trim()).filter(Boolean);
  } catch { builtin = []; }
  return builtin;
}

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '!': 'i', '|': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't', '+': 't', '8': 'b', '9': 'g' };
// fontwarm-ignore-start (lookalike-letter and punctuation tables for the filter: matched, never shown)
/** Look-alike letters (Cyrillic / Greek / IPA / small caps …) folded to the Latin letter they imitate (detection only:
 *  the text shown keeps its own letters). */
const CONFUSABLES: Record<string, string> = {
  а: 'a', в: 'b', д: 'd', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', п: 'n', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', ч: 'ch', і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', һ: 'h', ӏ: 'l', ɡ: 'g', ɑ: 'a', ɩ: 'i', ո: 'n', ս: 'u', ց: 'g', օ: 'o',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ϲ: 'c', ς: 'c', σ: 'o', ϳ: 'j', ℓ: 'l', ı: 'i',
  ᴀ: 'a', ʙ: 'b', ᴄ: 'c', ᴅ: 'd', ᴇ: 'e', ɢ: 'g', ʜ: 'h', ɪ: 'i', ᴊ: 'j', ᴋ: 'k', ʟ: 'l', ᴍ: 'm', ɴ: 'n', ᴏ: 'o', ᴘ: 'p', ʀ: 'r', ꜱ: 's', ᴛ: 't', ᴜ: 'u', ᴠ: 'v', ᴡ: 'w', ʏ: 'y', ᴢ: 'z',
};
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜ᅟᅠ឴឵ㅤﾠ￹-￻]|\p{Default_Ignorable_Code_Point}|\p{Bidi_Control}/gu;
/** Every dot shape we know (before and after NFKC): they all become "." in the scan copy. */
const DOT_SHAPES = /[··˙․‥…‧•∙⋅⦁⸰⸱⸳。・．｡･﹒܁܂۔᛫ꞏᐧ⸼་༌๚๏]/gu;
const MARKS = /\p{M}/gu;
/** Spacing diacritics (NFKC: a space + a combining mark): read as dots by the link check. */
const SPACING_MARKS = /[¨¯´¸˘-˝΄΅᾽᾿-῁῍-῏῝-῟῭-`´῾゛゜＾￣]/gu;

/** Enclosed / parenthesized / squared / circled / negative / regional-indicator letters and digits → their ASCII base,
 *  generated from the Unicode blocks (not typed by hand): U+2460–24FF, U+2776–2793, U+3200–32FF, U+1F100–1F1FF. A code
 *  point whose NFKC is one letter / digit (optionally in parentheses or with a dot) maps to it; the blocks NFKC leaves
 *  alone (negative circled / squared letters, regional indicators, dingbat digits) map by their position. */
const ENCLOSED: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  const ranges: [number, number][] = [[0x2460, 0x24ff], [0x2776, 0x2793], [0x3200, 0x32ff], [0x1f100, 0x1f1ff]];
  for (const [a, b] of ranges) for (let cp = a; cp <= b; cp++) {
    const c = String.fromCodePoint(cp), n = c.normalize('NFKC');
    const k = /^\(?([A-Za-z0-9]{1,2})\)?[.,]?$/.exec(n);
    if (k && n !== c) m.set(c, k[1].toLowerCase());
  }
  const run = (start: number, chars: string) => { [...chars].forEach((ch, i) => { const c = String.fromCodePoint(start + i); if (!m.has(c)) m.set(c, ch); }); };
  const AZ = 'abcdefghijklmnopqrstuvwxyz';
  for (const base of [0x1f110, 0x1f130, 0x1f150, 0x1f170, 0x1f1e6]) run(base, AZ);
  for (const base of [0x2776, 0x2780, 0x278a, 0x24f5]) { run(base, '123456789'); m.set(String.fromCodePoint(base + 9), '10'); }   // (+ double circled 1–10)
  for (let i = 0; i < 10; i++) m.set(String.fromCodePoint(0x24eb + i), String(11 + i));                                     // negative circled 11–20
  for (const zero of [0x24ff, 0x1f10b, 0x1f10c, 0x24ea]) m.set(String.fromCodePoint(zero), '0');                             // circled / negative zeros
  return m;
})();
const ENCLOSED_RE = /[①-⓿❶-➓㈀-㋿\u{1f100}-\u{1f1ff}]/gu;
// fontwarm-ignore-end

/** The SCAN COPY of a text (never shown): invisible characters out, NFKC, lower case, look-alike letters folded, every
 *  combining mark (any block) out, every dot shape a ".". Both the link scan and the word scan read this. */
export function foldText(s: string): string {
  let t = String(s ?? '').replace(CTRL_RE, '').replace(DOT_SHAPES, '.').replace(ENCLOSED_RE, (c) => ENCLOSED.get(c) ?? c).normalize('NFKC').replace(CTRL_RE, '').toLowerCase();
  t = t.replace(ENCLOSED_RE, (c) => ENCLOSED.get(c) ?? c);
  // a run of 2+ parenthesized single letters right after a word (with or without a space) is a spelled-out piece of it:
  // a TLD → "evil.com" ("evil(c)(o)(m)", "evil (c) (o) (m)"), anything else → its own word ("evil (d)(o)(t) com" → "evil dot
  // com", then the spoken-dot rule); the space after the run is kept. Other parenthesized single letters lose their
  // parentheses ("(c)(o)(m)" → "com").
  t = t.replace(/([\p{L}\p{N}]{2,})\s*(\(\s*[a-z0-9]\s*\)(?:\s*\(\s*[a-z0-9]\s*\))+)/gu, (_m, w: string, run: string) => {
    const letters = run.replace(/[()\s]/g, '');
    return TLD_SET.has(letters) ? `${w}.${letters}` : `${w} ${letters}`;
  });
  t = t.replace(/\(\s*([a-z0-9])\s*\)/g, '$1');
  // marks off first (an accented look-alike "έ" is a look-alike too), then the look-alike table
  t = t.normalize('NFKD').replace(MARKS, '').replace(/[^\x00-\x7f]/g, (c) => CONFUSABLES[c] ?? c);
  return t.normalize('NFKD').replace(MARKS, '').replace(DOT_SHAPES, '.');
}
/** Lower-case, look-alikes + marks + leetspeak folded, letters only, runs of 3+ squeezed: "N1GGG3R" → "nigger". */
export function normWord(w: string): string {
  const s = foldText(w).replace(/[0-9!|@$+]/g, (c) => LEET[c] ?? c).replace(/[^a-z]/g, '');
  return s.replace(/(.)\1{2,}/g, '$1$1');
}
const squeeze = (s: string) => s.replace(/(.)\1+/g, '$1');
/** Ordinary words that contain a blocked root. They are BLANKED (only their own letters) before the roots are looked
 *  for, so a root glued to one ("snigger" + root) is still found. The streamer adds more in Settings → Allowed words. */
export const ALLOWED_WORDS: readonly string[] = ['spicy', 'spice', 'spices', 'spiced', 'spicier', 'spiciest', 'retardant', 'retardants', 'retardation', 'raccoon', 'raccoons', 'cocoon', 'cocoons', 'tycoon', 'tycoons', 'coonhound', 'coonhounds', 'pecan', 'scunthorpe', 'snigger', 'sniggers', 'sniggering', 'niggle', 'niggles', 'niggling', 'niggard', 'chinking', 'chinked', 'chinkapin', 'retardance'];
/** Does this token hit a root? Allowed words are blanked first (their span only); in each piece left: exact (squeezed
 *  letters too, plural s); roots of 5+ letters also with a grammatical suffix and anywhere inside.
 *  A 4-letter root never matches inside a longer word ("spicy"). */
function tokenHit(t: string, roots: readonly string[], allow: readonly string[]): boolean {
  if (!t) return false;
  let rest = t;
  for (const a of [...ALLOWED_WORDS, ...allow].sort((x, y) => y.length - x.length)) if (a && rest.includes(a)) rest = rest.split(a).join('|');
  // the pieces left and, when an allowed word was cut out, the pieces run together: an allowed word spliced through a
  // root ("n" + allowed + "igger") hides nothing
  const pieces = rest.split('|');
  if (pieces.length > 1) pieces.push(pieces.join(''));
  for (const piece of pieces) {
    if (!piece) continue;
    const st = squeeze(piece);
    for (const w of roots) {
      if (piece === w || st === squeeze(w) || piece === `${w}s`) return true;
      if (w.length >= 5 && w.endsWith('y') && /^(?:ies|ied)$/.test(piece.slice(w.length - 1)) && piece.startsWith(w.slice(0, -1))) return true;
      if (w.length >= 5 && piece.startsWith(w) && /^(s|es|ed|er|ers|ing|z|y|a|as|az)$/.test(piece.slice(w.length))) return true;
      if (w.length >= 5 && piece.length > w.length && (piece.includes(w) || st.includes(squeeze(w)))) return true;
    }
  }
  return false;
}

// ---- links (structural). In the scan copy a SEPARATOR is any run of characters that are neither letters, numbers nor
// spaces (after NFKC, mark stripping and dot folding); written / spoken dots ("(.)", "[dot]", " dot ", punkt, punto,
// point, точка, дот) count as one too. A link is:
//   A. a chunk of 2+ letters / numbers, a separator run with no space in it, a TLD                  "evil‥com" "a˙b.gg"
//   B. the same with spaces round the separator, when the TLD isn't an everyday chat word           "evil . com"
//   C. a scheme, "www" + a separator, punycode                                                     "h t t p s :" "xn--"
//   D. with letters spaced out (2+ one-letter pieces), A on the text with the spaces removed       "e v i l . c o m"
// Trade-off (accepted for a live show): "hey...lol" is held / hidden / "viewer" (the allow lists rescue names + words).
const TLD_LIST = 'com|net|org|io|gg|tv|ly|me|co|xyz|ru|be|link|app|dev|info|biz|us|uk|de|fr|live|stream|site|online|shop|store|tk|ml|ga|cf|cc|to|sh|so|ai|fm|gl|im|lol|bio|click|top|vip|win|cam|zip|mov|ca|au|in|br|jp|cn|es|it|nl|pl|se|no|fi|dk|ch|at|cz|pt|gr|tr|kr|eu|asia|club|fun|space|website|tech|pro|icu|buzz|work|life|world|today|news|blog|page|wtf|art|gay|sex|xxx|porn|cash|money|bet|casino|gift|gifts|free|best|run|one|lat|rest|cfd|sbs|monster|quest|bond|fyi|wiki|social|chat|codes|cloud|host|email|digital|media|ws|su|ua|by|kz|ir|vn|id|ph|my|th|sg|hk|tw|mx|ar|cl|pe|ve|za|ng|ke|nz|onion|ninja|games|game|stream|watch|video|pics|pw|cx|nu|la|ly|gd|cm|vc|re|tf|ac|io';
/** TLDs that are also everyday chat words: only a link when glued to their separator (rule A), never across spaces. */
const CHATTY = new Set(['gg', 'lol', 'me', 'so', 'to', 'in', 'it', 'no', 'be', 'us', 'at', 'is', 'my', 'fun', 'live', 'one', 'win', 'best', 'top', 'run', 'life', 'today', 'news', 'art', 'chat', 'work', 'world', 'page', 'wtf', 'free', 'gift', 'game', 'games', 'watch', 'video', 're', 'ac', 'la', 'ch', 'th', 'id', 'by', 'pe', 'ar', 'es', 'de', 'co', 'tv', 'pro', 'bet', 'cash', 'money', 'rest', 'bond', 'quest', 'social', 'cloud', 'host', 'media', 'blog', 'stream', 'club', 'space', 'tech', 'ninja', 'monster', 'shop', 'store', 'gifts', 'pics', 'email', 'digital', 'codes', 'wiki', 'fyi', 'one']);
const STRONG_LIST = TLD_LIST.split('|').filter((t) => !CHATTY.has(t)).join('|');
const TLD_SET: ReadonlySet<string> = new Set(TLD_LIST.split('|'));
const HAS_TEXT = /[\p{L}\p{N}]/u;
/** letters of a dot-spelled run ("e.v.i.l.c.o.m") that end in a TLD after 2+ letters */
const DOTTED_DOMAIN = new RegExp(`^[a-z0-9]{2,}(?:${TLD_LIST})$`);
const SPOKEN = 'dot|punkt|punto|ponto|kropka|tochka|tocka';
/** English words that are also spoken dots elsewhere: only before a real-link TLD */
const SPOKEN_WEAK = 'point|punt';
const LN = '\\p{L}\\p{N}';
// separators: never apostrophes / hyphens / underscores (we're, co-op) or emoji; everyday-word TLDs only after a dot
// shape (any "." or non-ASCII punctuation: "hey...lol", "evil‥gg"), real-link TLDs after any punctuation ("evil,com")
const NOT_SEP = `${LN}\\s'\\u2018\\u2019\`_\\-\\p{Extended_Pictographic}\\u{1F1E6}-\\u{1F1FF}\\u{1F3FB}-\\u{1F3FF}`;
const SEP = `[^${NOT_SEP}]`;
const DOTSEP = `(?:\\.|[^\\x00-\\x7f${NOT_SEP}])`;
const LINK_A = new RegExp(`[${LN}]{2,}(?:${SEP}+(?:${STRONG_LIST})|${DOTSEP}+(?:${TLD_LIST}))(?![${LN}])`, 'u');
const LINK_B = new RegExp(`[${LN}]{2,}\\s*${SEP}+\\s*(?:${STRONG_LIST})(?![${LN}])`, 'u');
// a dot shape with a space BEFORE it ("drop . me", "discord ‥ gg"): sentences put spaces after their dots, not before
const LINK_B2 = new RegExp(`[${LN}]{2,}\\s+${DOTSEP}+\\s*(?:${TLD_LIST})(?![${LN}])`, 'u');
const LINK_C = /h\s*t\s*t\s*p\s*s?\s*:|\bh[xt]{2}ps?:|\bwww\s*[^\p{L}\p{N}\s]|xn--/u;
const WRITTEN = new RegExp(`\\s*[([{<]\\s*(?:\\.|${SPOKEN})\\s*[)\\]}>]\\s*`, 'gu');
/** spoken dots: any TLD but the tiniest everyday words ("polka dot is …" is not a link) */
const SPOKEN_TLDS = TLD_LIST.split('|').filter((t) => !['is', 'it', 'in', 'at', 'to', 'so', 'no', 'be', 'my', 'us', 'by', 'id', 're', 'es', 'de', 'la', 'ac', 'ch', 'th', 'pe', 'ar'].includes(t)).join('|');
const SPOKEN_DOT = new RegExp(`([${LN}]{2,})\\s*(?:${SPOKEN})\\s*(${SPOKEN_TLDS})(?![${LN}])`, 'gu');
const SPOKEN_DOT_WEAK = new RegExp(`([${LN}]{2,})\\s*(?:${SPOKEN_WEAK})\\s*(${STRONG_LIST})(?![${LN}])`, 'gu');
/** Is there a link in this scan copy (foldText output)? */
export function hasLink(scan: string): boolean {
  let t = scan.replace(WRITTEN, '.').replace(/\s+/g, ' ');
  // letters spelled out one by one ("c . o . m", "e.v.i.l.c.o.m", "c o m", "u r"): ONLY that contiguous run is joined
  // (never the whole message); a run spelled with dot shapes that ends in a TLD after 2+ letters is a domain on its own
  let dottedDomain = false;
  t = t.replace(SINGLE_RUN, (run: string) => {
    const letters = run.replace(/[^\p{L}\p{N}]/gu, '');
    if (/\./.test(run) && DOTTED_DOMAIN.test(letters)) dottedDomain = true;
    return letters;
  });
  if (dottedDomain) return true;
  // spoken dots after the join ("example dot c o m"). (No leet in TLDs: "S2.E5", "bmw.m3" are everyday chat.)
  t = t.replace(SPOKEN_DOT, '$1.$2').replace(SPOKEN_DOT_WEAK, '$1.$2');
  return LINK_A.test(t) || LINK_B.test(t) || LINK_B2.test(t) || LINK_C.test(t);
}
/** a run of 2+ single letters / digits, each on its own between separators (spaces, dots, any punctuation) */
const SINGLE_RUN = /(?<![\p{L}\p{N}])[\p{L}\p{N}](?:[^\p{L}\p{N}\p{Extended_Pictographic}']+[\p{L}\p{N}](?![\p{L}\p{N}]))+/gu;
// shown text: obvious links are cut out of it (the rest of the message stays); anything hasLink() still sees = held back
const SHOWN_LINKS: RegExp[] = [
  /\bh\s*t\s*t\s*p\s*s?\s*:\s*\/\s*\/\S*|\bw\s+w\s+w\s*\.\S*/gi,                      // spaced scheme / www
  /\b(?:[a-z][a-z0-9+.-]{1,9}:\/\/|www\.)\S+/gi,                                      // scheme://… or www.…
  /\S*xn--\S*/gi,                                                                       // punycode
  new RegExp(`[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9-]+)*\\.(?:${TLD_LIST})(?![a-z0-9])(?:\\/\\S*)?`, 'gi'),   // example.com/…
  new RegExp(`[a-z0-9][a-z0-9-]*\\s+\\.\\s*(?:${STRONG_LIST})(?![a-z0-9])(?:\\/\\S*)?`, 'gi'),         // example . com
];

export interface FilterResult { text: string; blocked: boolean; notes: string[] }

/** The moderation filter for chat text going on stream (a bubble, a question, a name). The SHOWN text: invisible
 *  characters out, NFKC, piled-up combining marks capped at two, obvious links cut out, letter runs squeezed, spaces
 *  collapsed, a length cap. The SCAN copy (foldText: marks, look-alikes, dot shapes folded) decides `blocked`: a link
 *  still in it (hasLink: structural, any separator) or a blocked word (yours + the built-in list; allowed words blanked
 *  by their own span; short spaced-out pieces joined). */
export function filterText(raw: string, opt: { maxLen: number; blocklist?: readonly string[]; builtin?: boolean; links?: 'loose' | 'strict'; allow?: readonly string[]; words?: boolean; linkFilter?: boolean }): FilterResult {
  const doLinks = opt.linkFilter !== false, doWords = opt.words !== false;
  const notes: string[] = [];
  let s = String(raw ?? '').replace(CTRL_RE, '').normalize('NFKC').replace(CTRL_RE, '');
  // zalgo: at most two combining marks in a row (any block)
  s = s.replace(/(\p{M}{2})\p{M}+/gu, '$1');
  const before = s;
  // dot shapes that NFKC turns into "space + mark" (˙ ˘ ´ …): the shown text keeps them, but a link spelled with one
  // (found by mapping them to "." first) holds the text back
  const asDots = String(raw ?? '').replace(CTRL_RE, '').replace(DOT_SHAPES, '.').replace(SPACING_MARKS, '.').normalize('NFKC');
  let linkCount = 0, dotCount = 0;
  for (const re of SHOWN_LINKS) { linkCount += (s.match(re) ?? []).length; dotCount += (asDots.match(re) ?? []).length; }
  if (doLinks) for (const re of SHOWN_LINKS) s = s.replace(re, ' ');
  if (s !== before) notes.push('link removed');
  s = s.replace(/(\S)\1{4,}/gu, '$1$1$1').replace(/\s+/g, ' ').trim();
  let blocked = false;
  const scan = foldText(s);
  let dotsLeft = asDots;
  for (const re of SHOWN_LINKS) dotsLeft = dotsLeft.replace(re, ' ');
  if (doLinks && (hasLink(scan) || dotCount > linkCount || hasLink(foldText(dotsLeft)))) { blocked = true; notes.push('hidden link'); }
  // (a root ending in "y" also as its "ie" stem: "…ies" inside a longer word)
  const roots = [...(opt.blocklist ?? []), ...(opt.builtin === false ? [] : builtinWords())].map((w) => normWord(w)).filter((w) => w.length >= 2)
    .flatMap((w) => (w.length >= 5 && w.endsWith('y') ? [w, `${w.slice(0, -1)}ie`] : [w]));
  if (doWords && roots.length && s) {
    const allow = (opt.allow ?? []).map(normWord).filter(Boolean);
    const toks = scan.split(/[^a-z0-9!|@$+]+/).map(normWord).filter(Boolean);
    let hit = toks.some((t) => tokenHit(t, roots, allow));
    // letters spaced / dotted out ("n i g g e r", "nig ger", "n.i.g.g.e.r"): runs of short pieces joined — roots of 5+
    // letters across pieces of up to 4 letters, 3–4 letter roots only across single letters ("f a g")
    if (!hit) {
      const scanRuns = (maxPiece: number, minRoot: number, maxRoot: number) => {
        let run = '', pieces = 0;
        const flush = () => { if (pieces >= 2 && roots.some((w) => w.length >= minRoot && w.length <= maxRoot && (run.includes(w) || squeeze(run).includes(squeeze(w))))) hit = true; run = ''; pieces = 0; };
        for (const t of toks) { if (t.length <= maxPiece) { run += t; pieces++; } else flush(); }
        flush();
      };
      scanRuns(4, 5, 99);
      if (!hit) scanRuns(1, 3, 4);
    }
    if (hit) { blocked = true; notes.push('blocked word'); }
  }
  if ([...s].length > opt.maxLen) { s = [...s].slice(0, Math.max(1, opt.maxLen - 1)).join('').trimEnd() + '…'; notes.push('shortened'); }
  return { text: s, blocked, notes };
}

/** A display name safe for a name tag / a card: cleaned and capped (cleanName), and a name with a blocked word or a
 *  link in it shows as "viewer". */
export function safeName(n: string, s: Pick<AudienceSettings, 'blocklist' | 'builtinBlock'> & Partial<Pick<AudienceSettings, 'allowNames' | 'allowWords' | 'filterWords' | 'filterLinks'>>): string {
  const c = cleanName(n);
  if (s.allowNames?.includes(c.trim().toLowerCase())) return c;   // the streamer said this name is fine
  const f = filterText(c, { maxLen: 64, blocklist: s.blocklist, builtin: s.builtinBlock, links: 'strict', allow: s.allowWords, words: s.filterWords !== false, linkFilter: s.filterLinks !== false });
  return f.blocked || f.notes.includes('link removed') ? 'viewer' : c;
}

/** How big a support event's cheer is (0 none … 3 huge): $5 / $20 / $100 at the default crowd intensity - a livelier crowd (higher
 *  intensity) cheers at smaller amounts. Shared by the audience engine (its cheer animation) and the interview director (which
 *  camera, if any, the cheer deserves). */
export function cheerSize(usd: number, intensity = 1): 0 | 1 | 2 | 3 {
  const I = Math.max(0.25, intensity);
  return usd >= 100 / I ? 3 : usd >= 20 / I ? 2 : usd >= 5 / I ? 1 : 0;
}

/** Text that makes the audience laugh (LUL / KEKW / LOL / 😂 …): emote names and words. */
const LAUGH_RE = /^(lul|lulw|kekw|kek|omegalul|lol+|lmao+|lmfao|rofl|haha+|hahaha+|jaja+|ahaha+|xd+|icant|kappa|pepelaugh|kekwait|lolw|lul+)$/i;
export function isLaugh(text: string, emoteNames: readonly string[] = []): boolean {
  if (emoteNames.some((n) => LAUGH_RE.test(n))) return true;
  // fontwarm-ignore-start (laugh emoji detection: matched, never shown)
  if (/[😂🤣😆😹]/u.test(text)) return true;
  // fontwarm-ignore-end
  return text.split(/[\s.,!?]+/).some((w) => w && LAUGH_RE.test(w));
}

// ---------------------------------------------------------------- the active-chatter roster
export interface RosterMember {
  k: string; name: string; platform: ChatPlatform; color?: string; slot: number; joinedAt: number; lastAt: number; tier: EffectTier | null;
  /** lower-case raw login / display name, and the platform user id when known (moderation purges match them) */
  u: string; uid?: string;
  /** the display name as typed (RAM only): names are filtered again from it when the owner changes the filter */
  raw: string;
  /** a local test chatter (the panel's "+40 test chatters"): never kept for a whole stream, first to give up a seat */
  test?: true;
}
export type TouchResult = 'joined' | 'seen' | 'full' | 'ignored';

/** Who sits in the audience: every chatter seen this stream (keep 'stream', the default) or in the last `windowMin`
 *  (keep 'minutes', supporters 2×), at most `max`, each in a stable SLOT kept until they leave, so every page seats them
 *  in the same place with no messages. Slots below `cap()` are the seats the room on stream really has (`seatCap`,
 *  reported by the OBS page; 0 = the best seat); slots from `cap()` up are the BENCH: kept, not shown. A newcomer takes a
 *  free seat, else the seat of someone quiet for ≥ 90 s whose tier is not higher than theirs (a supporter's tier counts
 *  only while they spoke in the last TIER_HOLD_MS; test chatters always give way), who moves to the bench; a benched
 *  chatter who talks again comes back the same way, and free seats are refilled from the bench (askers first, then the
 *  most recent). The roster only shrinks for `max`, time (keep 'minutes' / a new stream / test chatters), the settings
 *  (Never seat, Who gets a seat) and moderation. Someone whose question is on screen (`protect`) keeps their seat. */
export class AudienceRoster {
  readonly members = new Map<string, RosterMember>();
  /** Bumps on every seat change (pages / pushes). */
  rev = 0;
  static IDLE_SWAP_MS = 90_000;
  /** keep 'stream': this long without a word from someone = they were in an earlier stream (no stream lasts this long). */
  static SESSION_GAP_MS = 6 * 3_600_000;
  /** A supporter's tier keeps lurkers from taking their seat only while they spoke this recently. */
  static TIER_HOLD_MS = 30 * 60_000;
  /** Seats that must not be given away or timed out (the helper: askers whose question is on screen). */
  protect: (k: string) => boolean = () => false;
  /** How many seats the room on stream really has (the OBS page reports it); 0 = unknown (then `max`). */
  seatCap: () => number = () => 0;
  /** keep 'stream': does the SESSION_GAP_MS fallback apply? The helper: not while OBS is known to be live (then a new
   *  stream is OBS going live after a break, newStream). */
  gapApplies: (now: number) => boolean = () => true;
  /** The seats the room shows: `max`, and no more than the room has (slots from here up are the bench). */
  cap(max: number): number { const n = this.seatCap(); return n > 0 ? Math.min(max, n) : max; }
  constructor(public settings: () => Pick<AudienceSettings, 'max' | 'who' | 'windowMin' | 'exclude' | 'on' | 'blocklist' | 'builtinBlock'> & Partial<Pick<AudienceSettings, 'keep' | 'allowNames' | 'allowWords' | 'filterWords' | 'filterLinks'>>) {}

  eligible(e: { user: string; badges?: readonly string[] }, tier: EffectTier | null): boolean {
    const s = this.settings();
    const u = e.user.trim().toLowerCase();
    if (!u || u === 'anonymous' || CHAT_BOTS.includes(u) || s.exclude.includes(u)) return false;
    if ((e.badges ?? []).includes('broadcaster')) return false;   // the streamer is on stage, not in their own audience
    if (s.who === 'subs') return tier === 'member' || tier === 'patron' || tier === 'patron_plus' || tier === 'patron_top';
    if (s.who === 'supporters') return tier !== null && tier !== 'vip' && tier !== 'mod';
    return true;
  }

  /** A chat line (or a support event) from a viewer. */
  /** `force` (the helper seating an asker whose question is on screen): a full roster makes room with the quietest
   *  unprotected member however recently they spoke, and the asker takes a seat the room has the same way. */
  touch(e: { platform: ChatPlatform; user: string; uid?: string; color?: string; badges?: readonly string[]; test?: boolean }, now: number, tier: EffectTier | null = null, force = false): TouchResult {
    const s = this.settings();
    if (!s.on) return 'ignored';
    const k = personKey(e.platform, e.user, e.uid);
    const m = this.members.get(k);
    if (m) {
      m.lastAt = now;
      let ch = false;
      if (e.color && e.color !== m.color) { m.color = e.color; ch = true; }
      if (tier !== m.tier) { m.tier = tier; ch = true; }
      // on the bench and talking again: back into a seat the room has
      if (m.slot >= this.cap(s.max) && this.seat(m, now)) ch = true;
      if (ch) this.rev++;
      return 'seen';
    }
    if (!this.eligible(e, tier)) return 'ignored';
    if (this.members.size >= s.max) {
      // the roster itself is full: the quietest member anyone may bump leaves it
      const v = this.victim(now, tier, Infinity, '', force);
      if (!v || (e.test && !v.test)) return 'full';   // (a test chatter never pushes a real viewer out of the audience)
      this.members.delete(v.k);
    }
    const nm: RosterMember = { k, name: safeName(e.user, s), platform: e.platform, ...(e.color ? { color: e.color } : {}), slot: -1, joinedAt: now, lastAt: now, tier, u: e.user.trim().toLowerCase(), raw: e.user, ...(e.uid ? { uid: e.uid } : {}), ...(e.test ? { test: true as const } : {}) };
    this.members.set(k, nm);
    if (!this.seat(nm, now, force)) nm.slot = this.firstFree(this.cap(s.max), s.max);   // every seat taken by people who stay: the bench
    this.rev++;
    return 'joined';
  }

  /** Update a member's tier (a support event / link arrived). */
  setTier(k: string, tier: EffectTier | null) { const m = this.members.get(k); if (m && m.tier !== tier) { m.tier = tier; this.rev++; } }

  /** Put `m` (new: slot -1, or on the bench) in a seat the room has: a free one, else the seat of the quietest member
   *  they may bump, who moves to the bench (`m`'s bench slot, or a free one; none left: they leave). false = no seat.
   *  `force` (an asker whose question is on screen): anyone unprotected gives way, however recently they spoke. A test
   *  chatter only ever swaps with another test chatter. */
  private seat(m: RosterMember, now: number, force = false): boolean {
    const s = this.settings(), cap = this.cap(s.max);
    const f = this.firstFree(0, cap);
    if (f >= 0) { m.slot = f; return true; }
    const v = this.victim(now, m.tier, cap, m.k, force);
    if (!v || (m.test && !v.test)) return false;
    const vs = v.slot, bench = m.slot >= cap ? m.slot : this.firstFree(cap, s.max);
    if (bench >= 0) v.slot = bench; else this.members.delete(v.k);
    m.slot = vs;
    return true;
  }

  /** keep 'minutes': drop chatters quiet for longer than the window (supporters stay twice as long); keep 'stream':
   *  only someone quiet for SESSION_GAP_MS (an earlier stream); test chatters always go after the window. An asker whose
   *  question is on screen stays. Both: people the settings no longer seat leave, the roster is trimmed to `max` (askers
   *  last), and free seats the room has are filled from the bench (askers first, then the most recent). */
  prune(now: number): string[] {
    const s = this.settings();
    const out: string[] = [];
    const win = s.windowMin * 60_000, timed = s.keep === 'minutes';
    for (const m of this.members.values()) {
      const w = m.tier && m.tier !== 'vip' && m.tier !== 'mod' && !m.test ? win * 2 : win;
      const quiet = timed || m.test ? now - m.lastAt > w : this.gapApplies(now) && now - m.lastAt > AudienceRoster.SESSION_GAP_MS;
      if (!s.on || !this.eligible({ user: m.raw }, m.tier) || (quiet && !this.protect(m.k))) { this.members.delete(m.k); out.push(m.k); }
    }
    if (this.members.size > s.max) {
      const pr = (m: RosterMember) => (this.protect(m.k) ? 1 : 0);
      const order = [...this.members.values()].sort((a, b) => pr(a) - pr(b) || (a.test ? 0 : 1) - (b.test ? 0 : 1) || this.rankAt(a, now) - this.rankAt(b, now) || a.lastAt - b.lastAt);
      while (this.members.size > s.max) { const v = order.shift()!; this.members.delete(v.k); out.push(v.k); }
    }
    // seats the room has: free ones filled from the bench (askers on screen first, then the most recent); an asker still
    // benched takes the seat of a quiet one (their card needs a head)
    const cap = this.cap(s.max);
    let moved = false;
    const bench = [...this.members.values()].filter((m) => m.slot >= cap)
      .sort((a, b) => (this.protect(b.k) ? 1 : 0) - (this.protect(a.k) ? 1 : 0) || b.lastAt - a.lastAt);
    for (const m of bench) {
      const f = this.firstFree(0, cap);
      if (f >= 0) { m.slot = f; moved = true; continue; }
      if (this.protect(m.k) && this.seat(m, now, true)) { moved = true; continue; }
      // (a real viewer waiting while a test chatter sits in a seat the room has: they swap)
      const t = m.test ? null : [...this.members.values()].find((x) => x.test && x.slot >= 0 && x.slot < cap && !this.protect(x.k));
      if (t) { const ts = t.slot; t.slot = m.slot; m.slot = ts; moved = true; }
    }
    if (out.length || moved) this.rev++;
    return out;
  }
  /** OBS started streaming after a break (keep 'stream'): people from an earlier stream — quiet for 30 min or more — and
   *  every test chatter leave; anyone who spoke lately, or whose question is on screen, stays. */
  newStream(now: number): string[] {
    const out: string[] = [];
    for (const m of this.members.values()) if ((m.test || now - m.lastAt >= 30 * 60_000) && !this.protect(m.k)) { this.members.delete(m.k); out.push(m.k); }
    if (out.length) { this.rev++; this.prune(now); }
    return out;
  }

  remove(k: string) { if (this.members.delete(k)) this.rev++; }
  /** The owner changed the filter: every seated name is filtered again from what they typed (on: a bad name becomes
   *  "viewer" now; off: the name as typed comes back). true = a name changed. */
  refilter(): boolean {
    const s = this.settings();
    let any = false;
    for (const m of this.members.values()) { const n = safeName(m.raw, s); if (n !== m.name) { m.name = n; any = true; } }
    if (any) this.rev++;
    return any;
  }
  clear() { if (this.members.size) { this.members.clear(); this.rev++; } }

  /** The lowest unused slot in [from, to); -1 = none. */
  private firstFree(from: number, to: number): number {
    const used = new Set([...this.members.values()].map((m) => m.slot));
    for (let i = from; i < to; i++) if (!used.has(i)) return i;
    return -1;
  }
  /** A member's tier as it counts against a newcomer: only while they spoke in the last TIER_HOLD_MS; test chatters 0. */
  private rankAt(m: RosterMember, now: number): number { return m.test || now - m.lastAt >= AudienceRoster.TIER_HOLD_MS ? 0 : tierRank(m.tier); }
  /** Who gives up their seat (slot below `below`) to someone of `tier`: quiet ≥ 90 s, not protected, not `except`, their
   *  current rank not higher; test chatters first, then the lowest rank, then the quietest. */
  private victim(now: number, tier: EffectTier | null, below: number, except: string, force = false): RosterMember | null {
    let best: RosterMember | null = null;
    const key = (m: RosterMember) => [m.test ? 0 : 1, this.rankAt(m, now), m.lastAt];
    for (const m of this.members.values()) {
      if (m.slot >= below || m.k === except || m.slot < 0 || this.protect(m.k)) continue;
      if (!force && (now - m.lastAt < AudienceRoster.IDLE_SWAP_MS || this.rankAt(m, now) > tierRank(tier))) continue;
      if (!best) { best = m; continue; }
      const x = key(m), y = key(best);
      if (x[0] < y[0] || (x[0] === y[0] && (x[1] < y[1] || (x[1] === y[1] && x[2] < y[2])))) best = m;
    }
    return best;
  }

  list(): RosterMember[] { return [...this.members.values()].sort((a, b) => a.slot - b.slot); }
}

/** A break of this long between streams makes the next one a new stream; OBS not live (or not set up) this long is
 *  when the 6-hour fallback starts to apply. */
export const OBS_BREAK_MS = 30 * 60_000;
/** What the helper knows about OBS for the audience (server/audience.ts polls it every minute): `known` 'live', 'off'
 *  (OBS said not live, or was unreachable 3 polls in a row = closed) or 'unset' (OBS not set up in VTube Pro), each
 *  `since` when; `lastLive` = the last poll that saw it live. One poll that can't tell changes nothing. */
export interface ObsWatch { known: 'live' | 'off' | 'unset'; since: number; lastLive: number | null; nulls: number; firstNull: number }
export const newObsWatch = (now: number): ObsWatch => ({ known: 'unset', since: now, lastLive: null, nulls: 0, firstNull: 0 });
/** A poll: OBS live (streaming or recording; `startedAt` = when that output started, by OBS's own clock, when it says),
 *  not live, or null (couldn't tell: unreachable, or a status it couldn't read). */
export type ObsPoll = { on: true; startedAt?: number } | { on: false } | null;
/** One poll. true = a new stream starts: the output running now started OBS_BREAK_MS or more after OBS was last seen
 *  live (not seen live since the helper started: after it was first seen off). OBS restarting, or out of reach for a
 *  while, in the middle of one stream is the same stream: its output started before the break. */
export function obsWatchStep(w: ObsWatch, enabled: boolean, r: ObsPoll, now: number): boolean {
  const to = (k: ObsWatch['known'], at: number) => { if (w.known !== k) { w.known = k; w.since = at; } };
  if (!enabled) { to('unset', now); w.nulls = 0; return false; }
  if (r === null) {
    if (w.nulls++ === 0) w.firstNull = now;
    if (w.nulls >= 3) to('off', w.firstNull);   // unreachable for 3 polls: closed (since the first)
    return false;
  }
  w.nulls = 0;
  if (!r.on) { to('off', now); return false; }
  const started = Math.min(now, r.startedAt ?? now);
  const last = w.lastLive ?? (w.known === 'off' ? w.since : null);
  to('live', now); w.lastLive = now;
  return last !== null && started - last >= OBS_BREAK_MS;
}
/** The 6-hour fallback (AudienceRoster.SESSION_GAP_MS) applies once OBS has not been live for OBS_BREAK_MS, or isn't
 *  set up: an OBS restart or a short loss of contact never drops anyone mid-show. (OBS out of reach for over half an
 *  hour counts as closed: then anyone quiet for 6 hours leaves.) */
export const obsGapApplies = (w: ObsWatch, now: number) => w.known !== 'live' && now - w.since >= OBS_BREAK_MS;

/** A display name cleaned for a name tag: no control / bidi characters, ≤ 24 characters (words: safeName). */
export function cleanName(n: string): string {
  const s = String(n ?? '').replace(CTRL_RE, '').replace(/\s+/g, ' ').trim();
  return [...s].slice(0, 24).join('') || 'viewer';
}

// ---------------------------------------------------------------- the !ask command + the question queue
/** Is the chat command `name` (lower-case, without "!") the question command or one of its other names (!axe)? */
export const isAskCommand = (ask: Pick<AskSettings, 'command'> & { aliases?: readonly string[] }, name: string): boolean =>
  name === ask.command || (ask.aliases ?? []).includes(name);

/** `!ask <text>` (command name configurable): the question text, '' for a bare "!ask", null = not this command. */
export function parseAsk(text: string, command = 'ask'): string | null {
  const m = new RegExp(`^\\s*!${command.replace(/[^a-z0-9]/gi, '')}(?:\\s+([\\s\\S]*))?$`, 'i').exec(String(text ?? ''));
  return m ? (m[1] ?? '').trim() : null;
}

/** May this chatter use the free command? */
export function canAsk(who: AskWho, badges: readonly string[] | undefined, tier: EffectTier | null): boolean {
  if (who === 'off' || who === 'paid') return false;
  if ((badges ?? []).some((b) => /^(broadcaster|moderator|mod)$/.test(b))) return true;
  if (who === 'subs') return tier === 'member' || tier === 'patron' || tier === 'patron_plus' || tier === 'patron_top';
  if (who === 'supporters') return tier !== null && tier !== 'vip' && tier !== 'mod';
  return true;
}

/** Text of a paid message as a question: Twitch cheermotes ("Cheer100") removed; with `prefix` only "Q: …" messages
 *  count (the "Q:" is dropped). null = not a question. */
export function paidQuestionText(text: string, prefix: boolean, bits = false): string | null {
  let s = String(text ?? '').trim();
  if (bits) s = s.split(/\s+/).filter((w) => !/^[a-z]{2,20}\d{1,7}$/i.test(w)).join(' ').trim();
  const q = /^\s*q\s*[:.)-]\s*/i.exec(s);
  if (prefix && !q) return null;
  if (q) s = s.slice(q[0].length);
  return s.trim() ? s.trim() : null;
}

export type QStatus = 'pending' | 'approved' | 'pinned' | 'answering' | 'answered' | 'skipped';
export interface Question {
  id: string;
  /** asker key (personKey) + display (safeName) */
  k: string; name: string; platform: ChatPlatform; color?: string;
  /** the asker's stable platform user id when known (bumps only match on it), and their lower-case raw login / name
   *  (a ban by name matches it) */
  uid?: string;
  login?: string;
  /** what they typed (RAM only): text + name are filtered again from these when the owner changes the filter */
  raw?: string; rawName?: string;
  /** the chat message / support event it came from (a delete in chat takes the question down) */
  msgId?: string;
  /** filtered text (what goes on stream once approved) */
  text: string;
  source: 'ask' | 'paid';
  paid?: { usd: number; display: string; tier: string };
  /** USD of later tips that raised it */
  bump: number;
  /** a tip from someone with the SAME NAME but no platform id to prove it is the same person: the moderator confirms */
  maybeBump?: { usd: number; display: string; from: string };
  /** priority (higher first): paid = 100 + usd, a bump adds 50 + usd */
  pr: number;
  status: QStatus;
  /** asked at, and when the current status began */
  at: number; since: number;
  /** filter notes for the moderator ('link removed', 'blocked word', 'hidden link', 'shortened', 'deleted in chat') */
  notes: string[];
  /** the filter held it back (a blocked word / a hidden link): it can't go on stream until a moderator looked at the text
   *  and chose "Show anyway" (`allowed`) */
  blocked: boolean;
  allowed?: boolean;
  /** the filter removed everything meaningful in it (set by refilter; cleared when the filter no longer does) */
  emptied?: boolean;
  test?: boolean;
  /** the asker's chat badges when they asked (re-seating them for their card replays the seat rules: the broadcaster
   *  never sits in their own audience) */
  badges?: string[];
}
/** A question as shown on stream (approved / pinned / answering, and 'answered' for AskQueue.LINGER_MS after Done / Next
 *  so its card fades out instead of vanishing; Skip, a chat delete / ban or the filter still take it down at once —
 *  pending text never leaves the helper's panel). */
export type QuestionView = Pick<Question, 'id' | 'k' | 'name' | 'platform' | 'color' | 'text' | 'paid' | 'status' | 'since' | 'pr'>;

export type AskOutcome = { ok: true; q: Question; replaced?: boolean } | { ok: false; reason: 'off' | 'not-allowed' | 'empty' | 'cooldown' | 'already-approved' | 'full' };

/** Are these the same person? Both have platform ids → they must match; neither has one → the same name is only a
 *  'maybe' (display names are not unique); one has an id and the other not → no. */
export function samePerson(a: Identity, b: Identity): 'same' | 'maybe' | 'no' {
  if (a.platform !== b.platform) return 'no';
  if (a.uid && b.uid) return a.uid === b.uid ? 'same' : 'no';
  if (!a.uid && !b.uid) return a.user.trim().toLowerCase() === b.user.trim().toLowerCase() ? 'maybe' : 'no';
  return 'no';
}
const OPEN = new Set<QStatus>(['pending', 'approved', 'pinned', 'answering']);

/** The question queue: pending → approved / pinned → answering → answered, or skipped. Nothing reaches the stream before
 *  a moderator approves it; a question the filter held back (`blocked`) needs an explicit "Show anyway" (allow) first.
 *  One open question per chatter (a new !ask while pending replaces its text). */
export class AskQueue {
  list: Question[] = [];
  rev = 0;
  private seq = 0;
  private cool = new Map<string, number>();
  /** open (not answered / skipped) questions at most; finished ones are dropped first */
  static MAX = 120;
  constructor(public settings: () => Pick<AudienceSettings, 'ask' | 'blocklist' | 'builtinBlock'> & Partial<Pick<AudienceSettings, 'allowNames' | 'allowWords' | 'filterWords' | 'filterLinks'>>, private idBase = 'q') {}

  private filter(raw: string) { const s = this.settings(); return filterText(raw, { maxLen: s.ask.maxLen, blocklist: s.blocklist, builtin: s.builtinBlock, allow: s.allowWords, words: s.filterWords !== false, linkFilter: s.filterLinks !== false }); }
  /** A new question's first status: pending, or approved straight away when the owner turned approval off (never one the
   *  filter held back). */
  private firstStatus(blocked: boolean): QStatus { return this.settings().ask.approve === false && !blocked ? 'approved' : 'pending'; }
  private open(k: string) { return this.list.find((q) => q.k === k && OPEN.has(q.status)); }
  private touch() { this.rev++; }
  private idOf(q: Question): Identity { return { platform: q.platform, user: q.k.includes('#') ? q.name : q.k.slice(q.k.indexOf(':') + 1), ...(q.uid ? { uid: q.uid } : {}) }; }

  /** `!ask <text>` from chat. */
  ask(e: { platform: ChatPlatform; user: string; uid?: string; id?: string; color?: string; badges?: readonly string[]; test?: boolean }, raw: string, tier: EffectTier | null, now: number): AskOutcome {
    const s = this.settings(), a = s.ask;
    if (!a.on) return { ok: false, reason: 'off' };
    if (!canAsk(a.who, e.badges, tier)) return { ok: false, reason: 'not-allowed' };
    const f = this.filter(raw);
    if (!f.text) return { ok: false, reason: 'empty' };
    const k = personKey(e.platform, e.user, e.uid);
    const cur = this.open(k);
    if (cur && cur.status === 'pending') {   // (keeps its place in line)
      cur.text = f.text; cur.notes = f.notes; cur.blocked = f.blocked; cur.allowed = false; cur.emptied = false; cur.raw = raw; if (e.id) cur.msgId = e.id;
      if (e.badges?.length) cur.badges = [...e.badges].slice(0, 8); else delete cur.badges;
      this.touch(); return { ok: true, q: cur, replaced: true };
    }
    if (cur) return { ok: false, reason: 'already-approved' };
    if ((this.cool.get(k) ?? 0) > now) return { ok: false, reason: 'cooldown' };
    const q: Question = {
      id: `${this.idBase}${++this.seq}`, k, name: safeName(e.user, s), raw, rawName: e.user, platform: e.platform, login: e.user.trim().toLowerCase(), ...(e.uid ? { uid: e.uid } : {}), ...(e.id ? { msgId: e.id } : {}), ...(e.color ? { color: e.color } : {}),
      text: f.text, source: 'ask', bump: 0, pr: 0, status: this.firstStatus(f.blocked), at: now, since: now, notes: f.notes, blocked: f.blocked, ...(e.test ? { test: true } : {}), ...(e.badges?.length ? { badges: [...e.badges].slice(0, 8) } : {}),
    };
    return this.add(q, now) ? { ok: true, q } : { ok: false, reason: 'full' };
  }

  /** A support event: a paid question (when on and the amount / message qualify) or a bump of the supporter's open !ask.
   *  `who` = the supporter's identity when the caller knows it better than the event (chat 'finance' lines carry the
   *  platform user id). A bump needs the same platform id on both sides; the same NAME without ids only marks a
   *  "possible match" for the moderator (maybeBump) — someone else's money never lands on a question by itself. */
  support(ev: SupportEvent, now: number, who: Identity | null = supportIdentity(ev)): { kind: 'paid'; q: Question } | { kind: 'bump'; q: Question } | { kind: 'maybe'; q: Question } | null {
    const s = this.settings(), a = s.ask;
    if (!a.on || ev.who.anonymous) return null;
    const usd = supportValue(ev);
    const id: Identity = who ?? { platform: 'test', user: ev.who.name };
    const k = who ? personKey(who.platform, who.user, who.uid) : `${ev.source}:${String(ev.who.name).toLowerCase()}`;
    const msg = ev.message && ev.message.moderated !== 'hidden' ? ev.message.text : '';
    if (a.paid.on && usd >= a.paid.minUsd && msg) {
      const t = paidQuestionText(msg, a.paid.prefix, ev.kind === 'bits');
      if (t) {
        const f = this.filter(t);
        if (f.text) {
          // a paid question replaces the same person's pending free one (proven by the platform id)
          const cur = this.list.find((q) => OPEN.has(q.status) && q.status === 'pending' && q.source === 'ask' && samePerson(this.idOf(q), id) === 'same');
          if (cur) { cur.status = 'skipped'; cur.since = now; }
          const q: Question = {
            id: `${this.idBase}${++this.seq}`, k, name: safeName(who?.user ?? ev.who.name, s), raw: t, rawName: String(who?.user ?? ev.who.name), platform: id.platform, login: String(who?.user ?? ev.who.name).trim().toLowerCase(), ...(id.uid ? { uid: id.uid } : {}), msgId: ev.id, text: f.text, source: 'paid',
            paid: { usd, display: moneyText(ev, usd), tier: paidTierColor(usd) }, bump: 0, pr: 100 + usd, status: this.firstStatus(f.blocked), at: now, since: now, notes: f.notes, blocked: f.blocked, ...(ev.test ? { test: true } : {}),
          };
          if (this.add(q, now)) return { kind: 'paid', q };
          return null;
        }
      }
    }
    // a bump: a tip within bumpMin minutes of their open !ask
    if (usd > 0 && a.bumpMin > 0) {
      for (const cur of this.list) {
        if (!OPEN.has(cur.status) || cur.status === 'answering' || now - cur.at > a.bumpMin * 60_000) continue;
        const m = samePerson(this.idOf(cur), id);
        if (m === 'same') { this.applyBump(cur, usd); this.touch(); return { kind: 'bump', q: cur }; }
        if (m === 'maybe') {
          const sum = +((cur.maybeBump?.usd ?? 0) + usd).toFixed(2);
          cur.maybeBump = { usd: sum, display: cur.maybeBump ? `$${sum.toFixed(sum % 1 ? 2 : 0)}` : moneyText(ev, usd), from: ev.who.name };
          this.touch(); return { kind: 'maybe', q: cur };
        }
      }
    }
    return null;
  }
  private applyBump(cur: Question, usd: number) {
    cur.bump = +(cur.bump + usd).toFixed(2); cur.pr += 50 + usd;
    const total = +((cur.source === 'paid' && cur.paid ? cur.paid.usd : 0) + usd + (cur.source === 'paid' ? 0 : cur.bump - usd)).toFixed(2);
    cur.paid = { usd: total, display: `$${total.toFixed(total % 1 ? 2 : 0)}`, tier: paidTierColor(total) };
  }
  /** The moderator confirms a "possible match" tip belongs to this question (or drops it with `on` false). */
  confirmBump(id: string, on = true): boolean {
    const q = this.get(id); if (!q || !q.maybeBump) return false;
    if (on) this.applyBump(q, q.maybeBump.usd);
    delete q.maybeBump; this.touch(); return true;
  }

  /** false = full: MAX open questions are waiting (finished ones are dropped first; nobody's open question is, nor one
   *  still fading out after Done — those don't count towards MAX: each lasts LINGER_MS). */
  private add(q: Question, now: number): boolean {
    const fading = this.list.filter((x) => x.status === 'answered' && this.live(x, now)).length;
    while (this.list.length - fading >= AskQueue.MAX) {
      const i = this.list.findIndex((x) => !this.live(x, now));
      if (i < 0) return false;
      this.list.splice(i, 1);
    }
    this.list.push(q);
    this.touch();
    return true;
  }

  get(id: string) { return this.list.find((q) => q.id === id) ?? null; }
  /** May it go on stream? (not held back by the filter, or a moderator chose "Show anyway") */
  private showable(q: Question) { return (!q.blocked || !!q.allowed) && !q.emptied; }   // (emptied by the filter: never; "???" / "🔥" as typed: fine)

  /** Moderator actions. Each returns false when the transition isn't allowed. */
  approve(id: string, now: number): boolean { const q = this.get(id); if (!q || q.status !== 'pending' || !this.showable(q)) return false; q.status = 'approved'; q.since = now; this.touch(); return true; }
  /** "Show anyway": the moderator has seen the flagged text and lets it be approved. */
  allow(id: string): boolean { const q = this.get(id); if (!q || !q.blocked || !OPEN.has(q.status)) return false; q.allowed = true; this.touch(); return true; }
  skip(id: string, now: number): boolean {
    const q = this.get(id); if (!q || !this.live(q, now)) return false;
    // (answered and still fading out: it comes down now; its asker's wait already started when it was answered)
    if (q.status !== 'answered') this.cool.set(q.k, now + this.settings().ask.cooldownSec * 1000);
    q.status = 'skipped'; q.since = now; this.touch(); return true;
  }
  /** Still on the pages (or about to be): an open question, or one answered under LINGER_MS ago. */
  private live(q: Question, now: number): boolean { return OPEN.has(q.status) || (q.status === 'answered' && now - q.since < AskQueue.LINGER_MS); }
  /** Delete: gone from the queue entirely. */
  remove(id: string): boolean { const i = this.list.findIndex((q) => q.id === id); if (i < 0) return false; this.list.splice(i, 1); this.touch(); return true; }
  pin(id: string, on: boolean, now: number): boolean {
    const q = this.get(id); if (!q) return false;
    if (on && (q.status === 'pending' || q.status === 'approved') && this.showable(q)) { q.status = 'pinned'; q.since = now; this.touch(); return true; }
    if (!on && q.status === 'pinned') { q.status = 'approved'; q.since = now; this.touch(); return true; }
    return false;
  }
  /** "Answer now": this question goes up (approving it if needed); the one being answered is done. */
  answer(id: string, now: number): boolean {
    const q = this.get(id); if (!q || q.status === 'answered' || q.status === 'skipped' || !this.showable(q)) return false;
    if (q.status === 'answering') return true;
    this.finishAnswering(now);
    q.status = 'answering'; q.since = now; this.touch(); return true;
  }
  /** Done with the question being answered. */
  done(now: number): boolean { const r = this.finishAnswering(now); if (r) this.touch(); return r; }
  /** The next approved question (pinned first, then priority, then oldest) goes up; false = none waiting. */
  next(now: number): boolean {
    const n = this.ordered().find((q) => (q.status === 'pinned' || q.status === 'approved') && this.showable(q));
    if (!n) { this.done(now); return false; }
    return this.answer(n.id, now);
  }
  private finishAnswering(now: number): boolean {
    let any = false;
    for (const q of this.list) if (q.status === 'answering') { q.status = 'answered'; q.since = now; this.cool.set(q.k, now + this.settings().ask.cooldownSec * 1000); any = true; }
    return any;
  }
  /** A ban / timeout / purge in chat: that person's open questions come down. `uid` given = only that account (never
   *  everyone with the same display name); else the login / name, or the person key. `target` '*' = everyone on the
   *  platform. true = something changed. */
  purge(r: { platform: string; target: string; uid?: string } | string, now: number): boolean {
    const m = typeof r === 'string' ? null : r;
    const t = m ? m.target.trim().toLowerCase() : '';
    const hit = (q: Question) => {
      if (!m) return q.k === r;
      if (q.platform !== m.platform) return false;
      if (m.target === '*') return true;
      if (m.uid) return q.uid === m.uid;
      return q.login === t || q.uid === m.target || q.k === chatKey(m.platform, m.target);
    };
    let any = false;
    for (const q of this.list) if (this.live(q, now) && hit(q)) { q.status = 'skipped'; q.since = now; q.notes = [...q.notes, 'removed in chat']; any = true; }
    if (any) this.touch();
    return any;
  }
  /** A message deleted in chat: a pending question from it is dropped; one already approved / on air comes off stream
   *  (skipped, noted). true = something changed. */
  deleted(target: string, now: number, platform?: string): boolean {
    const core = chatIdCore(target);
    const hit = (q: Question) => !!q.msgId && (q.msgId === target || ((!platform || q.platform === platform) && chatIdCore(q.msgId) === core && !!core));
    let any = false;
    for (const q of [...this.list]) {
      if (!hit(q) || !this.live(q, now)) continue;
      if (q.status === 'pending') this.list.splice(this.list.indexOf(q), 1);
      else { q.status = 'skipped'; q.since = now; q.notes = [...q.notes, 'deleted in chat']; }
      any = true;
    }
    if (any) this.touch();
    return any;
  }
  clear() { this.list = []; this.cool.clear(); this.touch(); }
  /** The owner changed the filter (or approval): every open question is filtered again from what was typed. Filter ON:
   *  one that is now held back comes off stream at once (back to pending, noted); filter OFF: the text as typed comes
   *  back, and with approval off a question no longer held goes up. true = something changed. */
  refilter(now: number): boolean {
    const s = this.settings();
    let any = false;
    for (const q of this.list) {
      if (q.status === 'answered' && this.live(q, now) && q.raw !== undefined) {
        // answered and still fading out: the filter now holding it back (or changing it) takes it down at once
        const f = this.filter(q.raw);
        if ((f.blocked && !q.allowed) || (HAS_TEXT.test(q.raw) && !HAS_TEXT.test(f.text)) || f.text !== q.text) { q.status = 'skipped'; q.since = now; q.notes = [...q.notes, 'taken down: the filter now holds it back']; any = true; }
        continue;
      }
      if (!OPEN.has(q.status) || q.raw === undefined) continue;
      const f = this.filter(q.raw);
      const name = q.rawName !== undefined ? safeName(q.rawName, s) : q.name;
      const sig = `${q.text}|${q.blocked}|${q.name}|${q.notes.join(',')}`;
      // never the raw text back: nothing left after the filter (a link-only question) = held back, off stream
      // emptied = the FILTER removed what was meaningful (a link-only question); "???" / "🔥" as typed never were
      const emptied = HAS_TEXT.test(q.raw) && !HAS_TEXT.test(f.text);
      q.text = f.text; q.notes = emptied ? [...f.notes, 'nothing left after the filter'] : f.notes; q.blocked = f.blocked; q.emptied = emptied; q.name = name;
      const held = (q.blocked && !q.allowed) || emptied;
      if (held && q.status !== 'pending') { q.status = 'pending'; q.since = now; q.notes = [...q.notes, 'taken down: the filter now holds it back']; }
      else if (!held && q.status === 'pending' && s.ask.approve === false) { q.status = 'approved'; q.since = now; }
      if (`${q.text}|${q.blocked}|${q.name}|${q.notes.join(',')}` !== sig) any = true;
    }
    if (any) this.touch();
    return any;
  }

  /** Queue order: answering, pinned, then priority (paid / bumped first), then oldest. */
  ordered(): Question[] {
    const rank = (s: QStatus) => (s === 'answering' ? 0 : s === 'pinned' ? 1 : s === 'approved' ? 2 : s === 'pending' ? 3 : 4);
    return [...this.list].sort((a, b) => rank(a.status) - rank(b.status) || b.pr - a.pr || a.at - b.at);
  }
  /** An answered question stays on stream this long after Done / Next (its card fades out; Skip takes it down at once). */
  static LINGER_MS = 6000;
  /** Has this person an open question (pending, approved, pinned or on air)? */
  hasOpen(k: string): boolean { return this.list.some((q) => q.k === k && OPEN.has(q.status)); }
  /** The askers whose question is on screen (on air, the next `cards` approved, or fading out after Done): their seats
   *  are kept (AudienceRoster.protect). Pending ones show nothing, so they hold no seat. */
  stageKeys(cards: number, now = Date.now()): Set<string> { return new Set(this.onStage(cards, now).map((q) => q.k)); }
  /** What the pages may show: the question being answered + the next `cards` approved ones (pending never) + the ones
   *  answered in the last LINGER_MS (newest first). */
  onStage(cards: number, now = Date.now()): QuestionView[] {
    const o = this.ordered().filter((q) => this.showable(q));
    const ans = o.filter((q) => q.status === 'answering');
    const up = o.filter((q) => q.status === 'pinned' || q.status === 'approved').slice(0, Math.max(0, cards));
    const done = o.filter((q) => q.status === 'answered' && now - q.since < AskQueue.LINGER_MS).sort((a, b) => b.since - a.since).slice(0, 2);
    return [...ans, ...up, ...done].map(({ id, k, name, platform, color, text, paid, status, since, pr }) => ({ id, k, name, platform, ...(color ? { color } : {}), text, ...(paid ? { paid } : {}), status, since, pr }));
  }
  counts() {
    const c = { pending: 0, approved: 0, answering: 0, answered: 0, skipped: 0 };
    for (const q of this.list) { if (q.status === 'pinned') c.approved++; else c[q.status]++; }
    return c;
  }
}

/** Card colour of a paid question by its value (the YouTube Super Chat ladder). */
export function paidTierColor(usd: number): string {
  if (usd >= 100) return '#e62117';
  if (usd >= 50) return '#e91e63';
  if (usd >= 20) return '#f57c00';
  if (usd >= 10) return '#ffca28';
  if (usd >= 5) return '#1de9b6';
  if (usd >= 2) return '#00e5ff';
  return '#1e88e5';
}
function moneyText(ev: SupportEvent, usd: number): string {
  if (ev.kind === 'bits' && ev.units?.bits) return `${ev.units.bits} bits`;
  const d = ev.display;
  if (d && d.currency.toUpperCase() !== 'USD') return `${(d.minor / 100).toFixed(2)} ${d.currency.toUpperCase()}`;
  return `$${usd.toFixed(usd % 1 ? 2 : 0)}`;
}

// ---------------------------------------------------------------- the bus view
/** One seated chatter on the bus (short keys: up to 200 of them go out on every change). */
export interface AudienceMemberView { k: string; n: string; p: ChatPlatform; c?: string; s: number; j: number; t?: EffectTier }
/** What the pages render: `{ type: 'audience', s: AudienceView }` (server/audience.ts, ≤ 3 pushes / s, on change only). */
export interface AudienceView {
  rev: number;
  /** helper clock when sent (epoch ms) */
  at: number;
  on: boolean;
  members: AudienceMemberView[];
  questions: QuestionView[];
  /** Crowd-wide applause (Stream Deck / the panel): epoch ms it started + a counter. */
  applause: { seq: number; at: number };
  /** Every known supporter's tier (the chat box's name styles), keyed by chatKey. */
  tiers: Record<string, EffectTier>;
  /** Pending questions waiting for a moderator (count only). */
  pending: number;
  /** Chat messages deleted in the last 2 minutes (their bubbles come down). */
  removed: string[];
  /** The settings the pages need. */
  look: Pick<AudienceSettings, 'max' | 'names' | 'bubbles' | 'intensity' | 'crowdNames' | 'blocklist' | 'builtinBlock' | 'allowWords' | 'allowNames' | 'filterWords' | 'filterLinks' | 'effects'> & { ask: Pick<AskSettings, 'cards' | 'askerCut' | 'overlay' | 'command'> };
}

export function emptyView(s: AudienceSettings = DEFAULT_AUDIENCE): AudienceView {
  return { rev: 0, at: 0, on: s.on, members: [], questions: [], applause: { seq: 0, at: 0 }, tiers: {}, pending: 0, removed: [], look: lookOf(s) };
}
export function lookOf(s: AudienceSettings): AudienceView['look'] {
  return { max: s.max, names: s.names, bubbles: s.bubbles, intensity: s.intensity, crowdNames: s.crowdNames, blocklist: s.blocklist, builtinBlock: s.builtinBlock, allowWords: s.allowWords, allowNames: s.allowNames, filterWords: s.filterWords, filterLinks: s.filterLinks, effects: s.effects, ask: { cards: s.ask.cards, askerCut: s.ask.askerCut, overlay: s.ask.overlay, command: s.ask.command } };
}

const PLATS = new Set(['kick', 'rumble', 'youtube', 'twitch', 'tiktok', 'test']);
const QST = new Set(['approved', 'pinned', 'answering', 'answered']);
const str = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(CTRL_RE, '').slice(0, n) : '');
/** Pages: a bus view checked field by field (bounded strings, known values only). */
export function sanitizeView(o: unknown): AudienceView | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  const look = sanitizeAudience({ ...obj(x.look), ask: obj(obj(x.look).ask) });
  const members: AudienceMemberView[] = [];
  const seen = new Set<number>();
  for (const r of Array.isArray(x.members) ? x.members.slice(0, 200) : []) {
    const m = obj(r);
    const k = str(m.k, 90), p = String(m.p), s = Math.round(num(m.s, 0, 199, -1));
    if (!k || !PLATS.has(p) || s < 0 || seen.has(s)) continue;
    seen.add(s);
    members.push({ k, n: safeName(str(m.n, 60), look), p: p as ChatPlatform, ...(typeof m.c === 'string' && HEX.test(m.c) ? { c: m.c } : {}), s, j: num(m.j, 0, 1e14, 0), ...(EFFECT_TIERS.includes(m.t as EffectTier) ? { t: m.t as EffectTier } : {}) });
  }
  const questions: QuestionView[] = [];
  for (const r of Array.isArray(x.questions) ? x.questions.slice(0, 8) : []) {
    const q = obj(r), pd = obj(q.paid);
    if (!QST.has(String(q.status)) || !PLATS.has(String(q.platform))) continue;
    questions.push({
      id: str(q.id, 40), k: str(q.k, 90), name: safeName(str(q.name, 60), look), platform: q.platform as ChatPlatform, ...(typeof q.color === 'string' && HEX.test(q.color) ? { color: q.color } : {}),
      text: str(q.text, 420), status: q.status as QStatus, since: num(q.since, 0, 1e14, 0), pr: num(q.pr, -1e6, 1e6, 0),
      ...(q.paid ? { paid: { usd: num(pd.usd, 0, 1e7, 0), display: str(pd.display, 24), tier: typeof pd.tier === 'string' && HEX.test(pd.tier) ? pd.tier : '#1e88e5' } } : {}),
    });
  }
  const tiers: Record<string, EffectTier> = {};
  let n = 0;
  for (const [k, t] of Object.entries(obj(x.tiers))) { if (n++ >= 600) break; if (EFFECT_TIERS.includes(t as EffectTier)) tiers[k.slice(0, 90)] = t as EffectTier; }
  const ap = obj(x.applause);
  return {
    rev: Math.round(num(x.rev, 0, 1e12, 0)), at: num(x.at, 0, 1e14, 0), on: x.on !== false, members, questions,
    applause: { seq: Math.round(num(ap.seq, 0, 1e9, 0)), at: num(ap.at, 0, 1e14, 0) }, tiers, pending: Math.round(num(x.pending, 0, 1e4, 0)),
    removed: Array.isArray(x.removed) ? x.removed.filter((r): r is string => typeof r === 'string').map((r) => r.slice(0, 160)).slice(0, 60) : [], look: lookOf(look),
  };
}
