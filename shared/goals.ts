// Goals, stretch goals and incentives (beta.13, research/SUPPORT_INTEGRATIONS.md E3): the PURE part both the helper
// (server/goals.ts: the engine, persisted, the same on every page) and the pages (the goal bars, the stretch-goal ladder,
// the in-world board, the studio panel) use. No DOM, no file system, no network: tools/goals_unit.ts tests all of it.
//
// It CONSUMES the support contract (shared/support.ts: SupportEvent / supportFromChat / supportValue) and never changes
// it. Every way a viewer supports the show arrives as a SupportEvent - from the support lane's connectors
// ({type:'support', ev} on the bus) or derived from today's chat 'finance' lines (supportFromChat) - and both paths are
// deduped here (SupportDeduper) so one event is never counted twice.
//
//   GoalDef      { id, title, metric, weights, filter, target, reward, action?, stretch[], startAt, reset, show, color }
//   a goal's value = the sum over the persisted event log (since startAt, not undone, matching the filter) + manual
//   adjustments: always recomputable, so a mis-counted event can be undone and a crash never loses progress.
//   Stretch goals are absolute targets past the main one, kept in order (sanitizeGoal sorts them).
//   Incentive    { id, name, on, when: trigger, then: actions[] } - "when <event / amount / command / milestone> then
//                <add time / effect / spin the wheel / unlock a stretch goal / play a sound / show a message>".
import { minorPerMajor, supportFromChat, supportValue, SUPPORT_KINDS, SUPPORT_MONEY_KINDS, type SupportEvent, type SupportKind, type SupportSource } from './support.ts';
import type { ChatEvent } from './chat.ts';

// ---------------------------------------------------------------- small helpers
const clean = (s: unknown, n: number) => String(s ?? '').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const num = (v: unknown, lo: number, hi: number, d: number) => { const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const cleanId = (v: unknown, d: string) => { const s = String(v ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32); return ID.test(s) ? s : d; };
/** A short random id (pages + helper). */
export const newId = (p = 'g') => `${p}${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 24);

// ---------------------------------------------------------------- money / units
const SYM: Record<string, string> = { USD: '$', CAD: 'CA$', AUD: 'A$', NZD: 'NZ$', EUR: '€', GBP: '£', JPY: '¥', KRW: '₩', INR: '₹', BRL: 'R$', MXN: 'MX$', PHP: '₱', CHF: 'CHF ', SEK: 'kr ', NOK: 'kr ', DKK: 'kr ', PLN: 'zł ', TRY: '₺' };
export const currencySymbol = (cur: string) => SYM[cur.toUpperCase()] ?? `${cur.toUpperCase()} `;
/** "$1,234" / "$12.50" (cents only when there are some and the number is small). */
export function fmtMoney(v: number, cur = 'USD', cents: 'auto' | 'never' | 'always' = 'auto'): string {
  const z = minorPerMajor(cur) === 1;
  const show = !z && (cents === 'always' || (cents === 'auto' && Math.abs(v) < 1000 && Math.round(v * 100) % 100 !== 0));
  const n = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: show ? 2 : 0, maximumFractionDigits: show ? 2 : 0 });
  return `${v < 0 ? '-' : ''}${currencySymbol(cur)}${n}`;
}
/** A metric value as text ("$450", "37 subs", "12,000 bits", "8 members", "120 pts"). */
export function fmtMetric(v: number, metric: GoalMetric, cur = 'USD', short = false): string {
  const r = Math.floor(v + 1e-9);
  const n = (x: number) => x.toLocaleString('en-US');
  switch (metric) {
    case 'money': return fmtMoney(v, cur, 'auto');
    case 'subs': return short ? n(r) : `${n(r)} sub${r === 1 ? '' : 's'}`;
    case 'bits': return short ? n(r) : `${n(r)} bits`;
    case 'members': return short ? n(r) : `${n(r)} member${r === 1 ? '' : 's'}`;
    case 'points': return short ? n(r) : `${n(r)} pts`;
    default: return short ? n(r) : `${n(r)} supporter${r === 1 ? '' : 's'}`;
  }
}

/** "5m", "1h30m", "90s", "1:30:00", "2h", "45" (minutes) → ms (0 = not a duration). */
export function parseDuration(s: unknown): number {
  const t = String(s ?? '').trim().toLowerCase();
  if (!t) return 0;
  const colon = /^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?$/.exec(t);
  if (colon) { const [a, b, c] = [Number(colon[1]), Number(colon[2]), colon[3] === undefined ? null : Number(colon[3])]; return (c === null ? a * 60 + b : a * 3600 + b * 60 + c) * 1000; }
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 60_000);
  const re = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/g;
  let ms = 0, m: RegExpExecArray | null, used = 0;
  while ((m = re.exec(t))) { const v = Number(m[1]), u = m[2][0]; ms += v * (u === 'd' ? 86_400_000 : u === 'h' ? 3_600_000 : u === 'm' ? 60_000 : 1000); used += m[0].length; }
  return used && t.replace(/\s+/g, '').length <= used + 2 ? Math.round(ms) : 0;
}
/** 3725000 → "1:02:05", 59000 → "0:59"; `days` adds "2d 03:04:05" style past 24 h. */
export function fmtClock(ms: number, days = true): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const p = (v: number) => String(v).padStart(2, '0');
  if (days && d > 0) return `${d}d ${p(h)}:${p(m)}:${p(x)}`;
  const hh = d * 24 + h;
  return hh > 0 ? `${hh}:${p(m)}:${p(x)}` : `${m}:${p(x)}`;
}
/** 300000 → "5 min", 5400000 → "1 h 30 min", 30000 → "30 s". */
export function fmtSpan(ms: number): string {
  const neg = ms < 0, s = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const parts = [h ? `${h} h` : '', m ? `${m} min` : '', x && !h ? `${x} s` : ''].filter(Boolean);
  return (neg ? '-' : '') + (parts.join(' ') || '0 s');
}

// ---------------------------------------------------------------- what one event contributes
export interface Contribution {
  /** display-currency major units (0 = none / unknown) */
  money: number;
  /** subs: own subs (1 per sub event) */
  subs: number;
  /** gifted subs / memberships: counted PER SUB, not per gift event */
  gifted: number;
  bits: number;
  /** memberships / patrons */
  members: number;
  kicks: number;
  /** sub tier: 1 / 2 / 3, 0 = Prime */
  tier: 0 | 1 | 2 | 3;
}

/** The sub tier of an event: ONLY the platform's own plan (units.tier: '1000' / '2000' / '3000' / 'Prime', or '1'..'3' /
 *  'Tier 2' from a native connector). Never the viewer's message or a colour: unknown = tier 1. */
export function tierOf(ev: SupportEvent): 0 | 1 | 2 | 3 {
  const t = String(ev.units?.tier ?? '').toLowerCase().trim();
  if (!t) return 1;
  if (t === 'prime') return 0;
  const m = /^(?:tier\s*)?([123])(?:000)?$/.exec(t);
  return m ? Number(m[1]) as 1 | 2 | 3 : 1;
}

/** Bits of an event: units.bits, or the contract's bits amount ({minor: bits, currency 'USD', valuedAt 'bits'}), or the
 *  chat path's ({minor: bits × 100, currency 'BITS'}). */
export function bitsOf(ev: SupportEvent): number {
  if (typeof ev.units?.bits === 'number' && ev.units.bits > 0) return Math.round(ev.units.bits);
  if (ev.kind !== 'bits' || !ev.amount) return 0;
  const a = ev.amount;
  if (a.currency.toUpperCase() === 'BITS') return Math.round(a.minor / 100);
  return Math.round(a.valuedAt === 'bits' ? a.minor : a.minor / minorPerMajor(a.currency) * 100);
}

/** The display-currency value: supportValue (the contract), else the amount when it is already in the display currency,
 *  else `approx` (a chat line's approximate USD when the display currency is USD). Never a guess at an exchange rate. */
export function moneyOf(ev: SupportEvent, displayCurrency = 'USD', approx = 0): number {
  const v = supportValue(ev);
  if (v > 0) return v;
  const a = ev.amount;
  if (a && a.currency.toUpperCase() === displayCurrency.toUpperCase() && (a.valuedAt ?? 'cash') === 'cash' && a.minor > 0) return a.minor / minorPerMajor(a.currency);
  return approx > 0 && displayCurrency.toUpperCase() === 'USD' ? approx : 0;
}

export function contributionOf(ev: SupportEvent, displayCurrency = 'USD', approx = 0): Contribution {
  const u = ev.units ?? {};
  const gifted = ev.kind === 'gift' ? Math.max(1, Math.round(u.gifted ?? u.subs ?? 1)) : 0;
  const subs = ev.kind === 'sub' ? Math.max(1, Math.round(u.subs ?? 1)) : 0;
  const members = ev.kind === 'membership' ? Math.max(1, Math.round(u.subs ?? 1)) : 0;
  return { money: moneyOf(ev, displayCurrency, approx), subs, gifted, bits: bitsOf(ev), members, kicks: Math.max(0, Math.round(u.kicks ?? 0)), tier: subs || gifted ? tierOf(ev) : 1 };
}

// ---------------------------------------------------------------- goals
export type GoalMetric = 'money' | 'subs' | 'bits' | 'members' | 'points' | 'count';
export const GOAL_METRICS: readonly GoalMetric[] = ['money', 'subs', 'bits', 'members', 'points', 'count'];
export const METRIC_LABEL: Record<GoalMetric, string> = {
  money: 'Money (tips, Super Chats, bits, merch …)', subs: 'Subs (gifted subs count one each)', bits: 'Bits', members: 'Members / patrons',
  points: 'Points (your own weights)', count: 'Supporters (one per support)',
};
export type ResetPolicy = 'stream' | 'manual' | 'never';
export const RESET_LABEL: Record<ResetPolicy, string> = { stream: 'Every stream', manual: 'Only when I reset it', never: 'Never (a long-term goal)' };

/** Sounds go through the show-sound path (shared/showSound.ts; the studio plays them, OBS pages stay silent). */
export type SoundCue = 'fanfare' | 'horn' | 'siren' | 'slap';
export const SOUND_CUES: readonly SoundCue[] = ['fanfare', 'horn', 'siren', 'slap'];
export const SOUND_LABEL: Record<SoundCue, string> = { fanfare: 'Fanfare', horn: 'Air horn', siren: 'Raid siren', slap: 'Slap' };
/** Any Stream Deck action (shared/deck.ts DECK_ACTIONS): room cues, lighting states, club / lounge moments, emotes … */
export interface DeckCue { action: string; params: Record<string, string | number | boolean> }
/** What happens when a goal / stretch goal is reached (all optional). */
export interface GoalAction { deck?: DeckCue; sound?: SoundCue; text?: string }

export interface StretchGoal {
  id: string;
  /** absolute target (higher than the main target and the stretch before it) */
  target: number;
  reward: string;
  /** shown as "???" until reached or unlocked (a mystery stretch goal) */
  hidden: boolean;
  action?: GoalAction;
}
export interface GoalFilter {
  /** empty = every source */
  sources: SupportSource[];
  /** empty = the metric's own kinds */
  kinds: SupportKind[];
  /** count test events too (dashboard test alerts) */
  test: boolean;
  /** smallest money amount that counts (display currency; 0 = any) */
  minValue: number;
}
export interface GoalDef {
  id: string;
  title: string;
  metric: GoalMetric;
  /** points goals: points per unit, per kind (sub / gift: per sub · bits: per 100 bits · money kinds: per 1 of the
   *  display currency · membership: per member · other: per event) */
  weights: Partial<Record<SupportKind, number>>;
  filter: GoalFilter;
  target: number;
  reward: string;
  action?: GoalAction;
  stretch: StretchGoal[];
  /** epoch ms: events before this don't count (reset = a new startAt) */
  startAt: number;
  reset: ResetPolicy;
  /** on stream */
  show: boolean;
  /** '' = the room's accent */
  color: string;
  /** the old single "chat goal" (Chat & events → Goal), kept in step with it */
  legacy?: boolean;
}

export const MAX_GOALS = 8;
export const MAX_STRETCH = 10;
export const DEFAULT_WEIGHTS: Partial<Record<SupportKind, number>> = { sub: 1, gift: 1, membership: 1, bits: 1, tip: 1, superchat: 1, purchase: 1, wishlist_gift: 1 };
const SOURCES = new Set<string>(['twitch', 'youtube', 'kick', 'rumble', 'tiktok', 'fourthwall', 'throne', 'stripe', 'bmc', 'patreon', 'kofi', 'streamelements', 'streamlabs', 'tipeeestream', 'manual', 'custom']);
const COLOR = /^#[0-9a-f]{6}$/i;

/** The kinds a metric counts when the filter names none. */
export function metricKinds(metric: GoalMetric): ReadonlySet<SupportKind> {
  switch (metric) {
    case 'money': return SUPPORT_MONEY_KINDS;
    case 'subs': return new Set<SupportKind>(['sub', 'gift']);
    case 'bits': return new Set<SupportKind>(['bits']);
    case 'members': return new Set<SupportKind>(['membership']);
    default: return new Set<SupportKind>(SUPPORT_KINDS.filter((k) => k !== 'redemption'));
  }
}

export function sanitizeAction(raw: unknown): GoalAction | undefined {
  const o = obj(raw);
  const a: GoalAction = {};
  const d = obj(o.deck);
  if (typeof d.action === 'string' && /^[a-z][a-z0-9-]{1,31}$/.test(d.action)) {
    const params: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(obj(d.params)).slice(0, 8)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,23}$/.test(k)) continue;
      if (typeof v === 'string') params[k] = clean(v, 80); else if (typeof v === 'number' && Number.isFinite(v)) params[k] = v; else if (typeof v === 'boolean') params[k] = v;
    }
    a.deck = { action: d.action, params };
  }
  if (typeof o.sound === 'string' && (SOUND_CUES as readonly string[]).includes(o.sound)) a.sound = o.sound as SoundCue;
  const t = clean(o.text, 120);
  if (t) a.text = t;
  return a.deck || a.sound || a.text ? a : undefined;
}

/** A usable goal from anything (UI, HTTP, templates, an old file) - or an error message. */
export function sanitizeGoal(raw: unknown, now = Date.now()): GoalDef | string {
  const o = obj(raw);
  const metric = (GOAL_METRICS as readonly string[]).includes(String(o.metric)) ? o.metric as GoalMetric : 'money';
  const title = clean(o.title, 48) || (metric === 'money' ? 'Stream goal' : metric === 'subs' ? 'Sub goal' : metric === 'bits' ? 'Bits goal' : metric === 'members' ? 'Member goal' : 'Goal');
  const target = num(o.target, 0, 1e9, 0);
  if (!(target > 0)) return 'The goal needs a target above 0';
  const f = obj(o.filter);
  const filter: GoalFilter = {
    sources: Array.isArray(f.sources) ? [...new Set(f.sources.map(String).filter((s) => SOURCES.has(s)))].slice(0, 16) as SupportSource[] : [],
    kinds: Array.isArray(f.kinds) ? [...new Set(f.kinds.map(String).filter((k) => (SUPPORT_KINDS as readonly string[]).includes(k)))] as SupportKind[] : [],
    test: bool(f.test, false),
    minValue: num(f.minValue, 0, 1e6, 0),
  };
  const weights: Partial<Record<SupportKind, number>> = {};
  const w = obj(o.weights);
  for (const k of SUPPORT_KINDS) { const v = num(w[k], 0, 1e4, NaN); if (Number.isFinite(v)) weights[k] = v; }
  const seen = new Set<string>();
  const stretch: StretchGoal[] = (Array.isArray(o.stretch) ? o.stretch : []).slice(0, MAX_STRETCH * 2).map((x, i) => {
    const s = obj(x);
    let id = cleanId(s.id, `s${i + 1}`);
    while (seen.has(id)) id = `${id.slice(0, 28)}${i}x`;
    seen.add(id);
    const t = num(s.target, 0, 1e9, 0);
    const st: StretchGoal = { id, target: t, reward: clean(s.reward, 80), hidden: bool(s.hidden, false) };
    const a = sanitizeAction(s.action);
    if (a) st.action = a;
    return st;
  }).filter((s) => s.target > target).sort((a, b) => a.target - b.target)
    .filter((s, i, arr) => i === 0 || s.target > arr[i - 1].target).slice(0, MAX_STRETCH);
  const g: GoalDef = {
    id: cleanId(o.id, newId('g')), title, metric, weights: Object.keys(weights).length ? weights : metric === 'points' ? { ...DEFAULT_WEIGHTS } : {}, filter, target,
    reward: clean(o.reward, 80), stretch, startAt: Math.round(num(o.startAt, 0, 1e14, now)), reset: o.reset === 'manual' || o.reset === 'never' ? o.reset : 'stream',
    show: bool(o.show, true), color: typeof o.color === 'string' && COLOR.test(o.color) ? o.color.toLowerCase() : '',
  };
  const a = sanitizeAction(o.action);
  if (a) g.action = a;
  if (o.legacy === true) g.legacy = true;
  return g;
}

/** Does this event count toward the goal at all (before its value)? */
export function goalCounts(g: GoalDef, ev: SupportEvent, at: number, value?: number): boolean {
  if (at < g.startAt) return false;
  if (ev.test && !g.filter.test) return false;
  if (g.filter.sources.length && !g.filter.sources.includes(ev.source)) return false;
  const kinds = g.filter.kinds.length ? new Set(g.filter.kinds) : metricKinds(g.metric);
  if (!kinds.has(ev.kind)) return false;
  if (g.filter.minValue > 0 && g.metric === 'money' && (value ?? 0) < g.filter.minValue) return false;
  return true;
}

/** What one event adds to a goal (0 = nothing). */
export function goalValueOf(g: GoalDef, ev: SupportEvent, c: Contribution, at: number): number {
  if (!goalCounts(g, ev, at, c.money)) return 0;
  switch (g.metric) {
    case 'money': return c.money;
    case 'subs': return c.subs + c.gifted;
    case 'bits': return c.bits;
    case 'members': return c.members;
    case 'count': return 1;
    case 'points': {
      const w = g.weights[ev.kind] ?? DEFAULT_WEIGHTS[ev.kind] ?? 0;
      if (!w) return 0;
      const units = ev.kind === 'sub' || ev.kind === 'gift' ? (c.subs + c.gifted) * (c.tier === 2 ? 2 : c.tier === 3 ? 5 : 1)
        : ev.kind === 'bits' ? c.bits / 100
          : ev.kind === 'membership' ? c.members
            : SUPPORT_MONEY_KINDS.has(ev.kind) ? c.money : 1;
      return Math.round(units * w * 100) / 100;
    }
  }
}

/** Every level of a goal in order: the main target, then the stretch goals. */
export const goalLevels = (g: GoalDef): number[] => [g.target, ...g.stretch.map((s) => s.target)];
/** How many levels a value has reached (0 = not even the main goal). */
export function levelsReached(g: GoalDef, value: number): number {
  let n = 0;
  for (const t of goalLevels(g)) { if (value + 1e-9 >= t) n++; else break; }
  return n;
}
/** The target the bar is filling towards now (the next unreached level; the last one once everything is reached). */
export function currentTarget(g: GoalDef, value: number): { target: number; from: number; level: number } {
  const L = goalLevels(g), n = levelsReached(g, value);
  const i = Math.min(n, L.length - 1);
  return { target: L[i], from: i > 0 ? L[i - 1] : 0, level: i };
}

// ---------------------------------------------------------------- dedupe (the chat line + the support lane's event)
/** Origins an event can arrive by. 'chat' = derived from a ChatEvent finance line (supportFromChat), 'support' = the
 *  support lane's {type:'support'} bus message, 'manual' / 'test' = the studio. */
export type SupportOrigin = 'chat' | 'support' | 'manual' | 'test';
/** The same supporter + the same normalized contribution from the OTHER path within this window is the same event (the
 *  support lane keeps the chat 'finance' line AND emits its own event, whose provider id differs from the chat line's). */
export const CROSS_PATH_MS = 20_000;
/** …and both sides' own occurrence times (when they carry one) are this close. */
export const CROSS_PATH_OCCURRED_MS = 10_000;

/** The normalized contribution an event is matched on across paths: source, kind and what it is worth in its own units
 *  (bits for bits, the sub / gift / member count for those, Kicks, else money cents) - never the display text. */
export function contribKey(ev: SupportEvent, money: number): string {
  const c = contributionOf(ev, 'USD');
  const unit = c.bits ? `b${c.bits}` : c.gifted ? `g${c.gifted}` : c.subs ? `s${c.subs}` : c.members ? `m${c.members}` : c.kicks ? `k${c.kicks}` : `c${Math.round(money * 100)}`;
  return `${ev.source}|${ev.kind}|${unit}`;
}
/** Who it is, every way the paths spell it: the platform user id, the login and the display name, normalized
 *  (lower case, letters + digits only: "Cool User" = "cooluser"). */
export function whoTokens(ev: SupportEvent, origin: SupportOrigin = 'support'): { id: string; names: Set<string> } {
  const n = (v: unknown) => String(v ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
  const names = new Set([n(ev.who.name), n(ev.who.chat?.login), n(ev.who.chat?.userId)].filter(Boolean));
  // (a chat line knows the display name only: supportFromChat's userId is that name lower-cased, not an id)
  return { id: origin === 'support' && ev.who.chat?.userId ? `${ev.who.chat.platform}:${ev.who.chat.userId}` : '', names };
}

interface Slot { origin: SupportOrigin; at: number; occurred: number; id: string; who: ReturnType<typeof whoTokens> }

export class SupportDeduper {
  private ids = new Map<string, number>();
  private slots = new Map<string, Slot[]>();
  constructor(private max = 5000, private windowMs = CROSS_PATH_MS) {}
  has(id: string) { return this.ids.has(id); }
  /** Remember an event from the log (start): its id, and - while recent - its cross-path slot (a replay right after a
   *  restart with another id is still matched). */
  seed(ev: SupportEvent, origin: SupportOrigin, at: number, money = 0, now = at) {
    this.ids.set(ev.id, at);
    if ((origin === 'chat' || origin === 'support') && now - at < this.windowMs) this.slot(ev, origin, at, money);
    this.trim();
  }
  private slot(ev: SupportEvent, origin: SupportOrigin, at: number, money: number) {
    const k = contribKey(ev, money);
    const list = this.slots.get(k) ?? [];
    list.push({ origin, at, occurred: Date.parse(ev.occurredAt) || 0, id: ev.id, who: whoTokens(ev, origin) });
    this.slots.set(k, list);
  }
  /** true = new: count it. `money` = its display money (part of the match when it has no units). */
  accept(ev: SupportEvent, origin: SupportOrigin, now: number, money = 0): boolean {
    if (this.ids.has(ev.id)) return false;
    if (origin === 'chat' || origin === 'support') {
      const k = contribKey(ev, money);
      const list = (this.slots.get(k) ?? []).filter((x) => now - x.at < this.windowMs);
      const me = whoTokens(ev, origin), occ = Date.parse(ev.occurredAt) || 0;
      // only the OTHER path can hold the same event (two events with different ids on one path are two events), the same
      // supporter (the platform user id when both have one, else any spelling of the name) and close occurrence times
      const twin = list.findIndex((x) => x.origin !== origin && (x.origin === 'chat' || x.origin === 'support')
        && (me.id && x.who.id ? me.id === x.who.id : [...me.names].some((t) => x.who.names.has(t)))
        && (!occ || !x.occurred || Math.abs(occ - x.occurred) <= CROSS_PATH_OCCURRED_MS));
      if (twin >= 0) { list.splice(twin, 1); this.slots.set(k, list); this.ids.set(ev.id, now); this.trim(); return false; }
      list.push({ origin, at: now, occurred: occ, id: ev.id, who: me });
      this.slots.set(k, list);
      if (this.slots.size > 2000) for (const [key, l] of this.slots) { if (!l.some((x) => now - x.at < this.windowMs)) this.slots.delete(key); }
    }
    this.ids.set(ev.id, now);
    this.trim();
    return true;
  }
  private trim() { if (this.ids.size > this.max) { let drop = this.ids.size - this.max; for (const k of this.ids.keys()) { if (drop-- <= 0) break; this.ids.delete(k); } } }
  recent(n = 2000): string[] { return [...this.ids.keys()].slice(-n); }
}

/** A chat line → a SupportEvent (the contract's supportFromChat) + the chat's approximate USD for non-USD money. */
export function supportOfChat(e: ChatEvent, displayCurrency = 'USD'): { ev: SupportEvent; approx: number } | null {
  if (e.cue) return null;                            // a "thank on stream" replay of an event already counted
  const ev = supportFromChat(e, displayCurrency);
  if (!ev) return null;
  if (e.fkind === 'raid') return null;               // raids are handled as raids (subathon bonus), not money
  return { ev, approx: typeof e.approxUsd === 'number' && e.approxUsd > 0 ? e.approxUsd : 0 };
}

// ---------------------------------------------------------------- incentives ("when … then …")
export type IncTrigger =
  /** a support event (kinds empty = any); `min` in `unit`; `every` = once per whole multiple of `min` ($25 with every $10 = 2×) */
  | { on: 'support'; kinds: SupportKind[]; unit: 'money' | 'subs' | 'bits' | 'any'; min: number; every: boolean }
  /** a chat command (no "!"), who may use it, a cooldown */
  | { on: 'command'; cmd: string; who: 'everyone' | 'subs' | 'mods'; cooldownSec: number }
  | { on: 'follow' }
  | { on: 'raid'; minViewers: number }
  /** every N of a running total: subathon minutes added, subs, money (since the subathon started / the goal's start) */
  | { on: 'milestone'; of: 'time' | 'subs' | 'money'; every: number }
  /** a goal (or one of its stretch goals) reached: `level` 1 = the main goal, 2 = the first stretch goal … 0 = any */
  | { on: 'goal'; goalId: string; level: number };
export type IncAction =
  | { do: 'addTime'; ms: number }
  | { do: 'deck'; cue: DeckCue }
  | { do: 'wheel' }
  | { do: 'unlock'; goalId: string }
  | { do: 'sound'; s: SoundCue }
  | { do: 'message'; text: string }
  | { do: 'happyhour'; mult: number; ms: number };
export interface Incentive { id: string; name: string; on: boolean; when: IncTrigger; then: IncAction[] }
export const MAX_INCENTIVES = 24;

function sanitizeTrigger(raw: unknown): IncTrigger | null {
  const o = obj(raw);
  switch (o.on) {
    case 'support': {
      const kinds = Array.isArray(o.kinds) ? [...new Set(o.kinds.map(String).filter((k) => (SUPPORT_KINDS as readonly string[]).includes(k)))] as SupportKind[] : [];
      const unit = o.unit === 'money' || o.unit === 'subs' || o.unit === 'bits' ? o.unit : 'any';
      return { on: 'support', kinds, unit, min: num(o.min, 0, 1e7, 0), every: bool(o.every, false) };
    }
    case 'command': {
      const cmd = String(o.cmd ?? '').toLowerCase().replace(/^!+/, '').replace(/[^a-z0-9_]/g, '').slice(0, 24);
      if (!cmd) return null;
      return { on: 'command', cmd, who: o.who === 'subs' || o.who === 'mods' ? o.who : 'everyone', cooldownSec: num(o.cooldownSec, 0, 86400, 30) };
    }
    case 'follow': return { on: 'follow' };
    case 'raid': return { on: 'raid', minViewers: num(o.minViewers, 0, 1e6, 0) };
    case 'milestone': {
      const of = o.of === 'subs' || o.of === 'money' ? o.of : 'time';
      const every = num(o.every, 0, 1e9, 0);
      return every > 0 ? { on: 'milestone', of, every } : null;
    }
    case 'goal': return { on: 'goal', goalId: cleanId(o.goalId, ''), level: Math.round(num(o.level, 0, MAX_STRETCH + 1, 0)) };
    default: return null;
  }
}
function sanitizeIncAction(raw: unknown): IncAction | null {
  const o = obj(raw);
  switch (o.do) {
    case 'addTime': { const ms = Math.round(num(o.ms, -86_400_000, 86_400_000, 0)); return ms ? { do: 'addTime', ms } : null; }
    case 'deck': { const a = sanitizeAction({ deck: o.cue }); return a?.deck ? { do: 'deck', cue: a.deck } : null; }
    case 'wheel': return { do: 'wheel' };
    case 'unlock': return { do: 'unlock', goalId: cleanId(o.goalId, '') };
    case 'sound': return typeof o.s === 'string' && (SOUND_CUES as readonly string[]).includes(o.s) ? { do: 'sound', s: o.s as SoundCue } : null;
    case 'message': { const t = clean(o.text, 120); return t ? { do: 'message', text: t } : null; }
    case 'happyhour': return { do: 'happyhour', mult: num(o.mult, 1, 10, 2), ms: Math.round(num(o.ms, 60_000, 86_400_000, 1_800_000)) };
    default: return null;
  }
}
export function sanitizeIncentive(raw: unknown): Incentive | string {
  const o = obj(raw);
  const when = sanitizeTrigger(o.when);
  if (!when) return 'Pick what starts it (a support, a command, a follow, a raid, a milestone or a goal)';
  const then = (Array.isArray(o.then) ? o.then : []).map(sanitizeIncAction).filter((x): x is IncAction => !!x).slice(0, 6);
  if (!then.length) return 'Pick at least one thing that happens';
  return { id: cleanId(o.id, newId('i')), name: clean(o.name, 48) || incentiveText({ id: '', name: '', on: true, when, then }), on: bool(o.on, true), when, then };
}

/** One plain line for an incentive ("Every $10 tipped → spin the wheel"). */
export function incentiveText(i: Incentive, cur = 'USD'): string {
  const w = i.when;
  const unitTxt = (v: number, u: string) => u === 'money' ? fmtMoney(v, cur) : u === 'subs' ? `${v} sub${v === 1 ? '' : 's'}` : u === 'bits' ? `${v} bits` : `${v}`;
  const when = w.on === 'support' ? `${w.every && w.min ? 'Every' : w.min ? 'A support of' : 'Any support'}${w.min ? ` ${unitTxt(w.min, w.unit)}${w.every ? '' : '+'}` : ''}${w.kinds.length ? ` (${w.kinds.join(', ')})` : ''}`
    : w.on === 'command' ? `!${w.cmd} (${w.who === 'mods' ? 'mods' : w.who === 'subs' ? 'subs' : 'anyone'})`
      : w.on === 'follow' ? 'A follow'
        : w.on === 'raid' ? `A raid${w.minViewers ? ` of ${w.minViewers}+` : ''}`
          : w.on === 'milestone' ? `Every ${w.of === 'time' ? fmtSpan(w.every * 60_000) + ' added' : w.of === 'money' ? fmtMoney(w.every, cur) : `${w.every} subs`}`
            : `Goal reached${w.level > 1 ? ` (stretch ${w.level - 1})` : ''}`;
  const then = i.then.map((a) => a.do === 'addTime' ? `${a.ms > 0 ? '+' : ''}${fmtSpan(a.ms)}` : a.do === 'deck' ? a.cue.action.replace(/-/g, ' ') : a.do === 'wheel' ? 'spin the wheel'
    : a.do === 'unlock' ? 'unlock a stretch goal' : a.do === 'sound' ? SOUND_LABEL[a.s].toLowerCase() : a.do === 'message' ? `“${a.text}”` : `happy hour ${a.mult}× for ${fmtSpan(a.ms)}`).join(' + ');
  return `${when} → ${then}`;
}

/** How many times a support trigger fires for this contribution (0 = not at all). */
export function supportFires(t: Extract<IncTrigger, { on: 'support' }>, ev: SupportEvent, c: Contribution): number {
  if (t.kinds.length && !t.kinds.includes(ev.kind)) return 0;
  const v = t.unit === 'money' ? c.money : t.unit === 'subs' ? c.subs + c.gifted : t.unit === 'bits' ? c.bits : 1;
  if (t.unit !== 'any' && v <= 0) return 0;
  if (!t.min) return 1;
  if (v + 1e-9 < t.min) return 0;
  return t.every ? Math.min(20, Math.floor((v + 1e-9) / t.min)) : 1;
}

/** Wheel slots ("spin the wheel" incentives; the helper picks, every page shows the same spin). */
export interface WheelSlot { label: string; weight: number }
export const DEFAULT_WHEEL: WheelSlot[] = [
  { label: 'Do 10 push-ups', weight: 1 }, { label: 'Sing a song', weight: 1 }, { label: '+15 minutes', weight: 1 }, { label: 'Accent for 10 min', weight: 1 },
  { label: 'Chat picks the game', weight: 1 }, { label: 'Outfit change', weight: 1 }, { label: 'Hydrate!', weight: 1 }, { label: 'Spin again', weight: 1 },
];
export function sanitizeWheel(raw: unknown): WheelSlot[] {
  const list = (Array.isArray(raw) ? raw : []).map((x) => { const o = obj(x); return { label: clean(o.label ?? x, 40), weight: num(o.weight, 0.1, 100, 1) }; }).filter((s) => s.label).slice(0, 16);
  return list.length >= 2 ? list : DEFAULT_WHEEL.map((s) => ({ ...s }));
}
/** A weighted pick: `r` in [0, 1). */
export function wheelPick(slots: WheelSlot[], r: number): number {
  const tot = slots.reduce((a, s) => a + s.weight, 0);
  let x = Math.min(0.999999, Math.max(0, r)) * tot;
  for (let i = 0; i < slots.length; i++) { x -= slots[i].weight; if (x < 0) return i; }
  return slots.length - 1;
}

// ---------------------------------------------------------------- mod commands (subathon + goals)
export type ModCommand =
  | { cmd: 'addtime' | 'subtime'; ms: number }
  | { cmd: 'happyhour'; mult: number; ms: number }
  | { cmd: 'happyoff' }
  | { cmd: 'pause' } | { cmd: 'resume' }
  | { cmd: 'undo'; n: number }
  | { cmd: 'sleep'; on: boolean | 'toggle' }
  | { cmd: 'spin' };
export interface ModCommandsCfg {
  on: boolean;
  /** each command's own switch (absent = on) */
  off: string[];
}
export const MOD_COMMANDS: { cmd: string; usage: string; what: string }[] = [
  { cmd: 'addtime', usage: '!addtime 5m', what: 'add time to the subathon' },
  { cmd: 'subtime', usage: '!subtime 10m', what: 'take time off' },
  { cmd: 'happyhour', usage: '!happyhour 2x 30m', what: 'multiply time added (!happyhour off ends it)' },
  { cmd: 'pausetimer', usage: '!pausetimer', what: 'pause the timer' },
  { cmd: 'resumetimer', usage: '!resumetimer', what: 'resume it' },
  { cmd: 'undotime', usage: '!undotime 2', what: 'undo the last N time changes' },
  { cmd: 'sleepmode', usage: '!sleepmode on', what: 'reduced rates (on / off)' },
  { cmd: 'spin', usage: '!spin', what: 'spin the wheel' },
];
/** Only the broadcaster and moderators (per the platform's badges) run mod commands. */
export const isMod = (badges: readonly string[] | undefined) => !!badges?.some((b) => b === 'broadcaster' || b === 'moderator');
const isSub = (badges: readonly string[] | undefined) => !!badges?.some((b) => b === 'subscriber' || b === 'member' || b === 'founder' || b === 'vip') || isMod(badges);
export const mayRun = (who: 'everyone' | 'subs' | 'mods', badges: readonly string[] | undefined) => who === 'everyone' || (who === 'subs' ? isSub(badges) : isMod(badges));

/** A chat line → a mod command (null = not one, or switched off). Permission is checked by the caller (isMod). */
export function parseModCommand(text: string, cfg: ModCommandsCfg = { on: true, off: [] }): ModCommand | null {
  if (!cfg.on) return null;
  const m = /^\s*!([a-z]+)\b\s*(.*)$/i.exec(text);
  if (!m) return null;
  const c = m[1].toLowerCase(), arg = m[2].trim().toLowerCase();
  const name = c === 'pause' || c === 'pausetimer' ? 'pausetimer' : c === 'resume' || c === 'resumetimer' || c === 'unpause' ? 'resumetimer'
    : c === 'undo' || c === 'undotime' ? 'undotime' : c === 'sleep' || c === 'sleepmode' ? 'sleepmode' : c === 'hh' ? 'happyhour' : c;
  if (cfg.off.includes(name)) return null;
  switch (name) {
    case 'addtime': case 'subtime': { const ms = parseDuration(arg || '1m'); return ms > 0 && ms <= 7 * 86_400_000 ? { cmd: name, ms } : null; }
    case 'happyhour': {
      if (/^(off|stop|end|0)$/.test(arg)) return { cmd: 'happyoff' };
      const mult = /(\d+(?:\.\d+)?)\s*x\b|\bx\s*(\d+(?:\.\d+)?)/.exec(arg);
      const rest = arg.replace(/(\d+(?:\.\d+)?)\s*x\b|\bx\s*(\d+(?:\.\d+)?)/, ' ').trim();
      const mu = mult ? Number(mult[1] ?? mult[2]) : 2;
      const ms = rest ? parseDuration(rest) : 30 * 60_000;
      return mu >= 1 && mu <= 10 && ms > 0 && ms <= 86_400_000 ? { cmd: 'happyhour', mult: mu, ms } : null;
    }
    case 'pausetimer': return { cmd: 'pause' };
    case 'resumetimer': return { cmd: 'resume' };
    case 'undotime': { const n = arg ? Math.round(Number(arg)) : 1; return n >= 1 && n <= 20 ? { cmd: 'undo', n } : null; }
    case 'sleepmode': return { cmd: 'sleep', on: /^(on|1|yes)$/.test(arg) ? true : /^(off|0|no)$/.test(arg) ? false : 'toggle' };
    case 'spin': return { cmd: 'spin' };
    default: return null;
  }
}

// ---------------------------------------------------------------- templates (3 clicks)
export interface GoalTemplate { id: string; label: string; hint: string; goal: Partial<GoalDef> }
export const GOAL_TEMPLATES: GoalTemplate[] = [
  { id: 'money500', label: '$500 stream goal + 3 stretch goals', hint: 'Tips, Super Chats, bits and merch from every platform; resets each stream',
    goal: { title: 'Stream goal', metric: 'money', target: 500, reward: 'Karaoke hour', reset: 'stream',
      stretch: [{ id: 's1', target: 750, reward: 'Outfit change', hidden: false }, { id: 's2', target: 1000, reward: 'Spicy noodle challenge', hidden: false }, { id: 's3', target: 1500, reward: '???', hidden: true }] } },
  { id: 'subs50', label: 'Sub goal (50 subs)', hint: 'New subs + gifted subs (each gifted sub counts), every platform',
    goal: { title: 'Sub goal', metric: 'subs', target: 50, reward: 'New emote', reset: 'stream', stretch: [{ id: 's1', target: 75, reward: 'Face reveal (of my cat)', hidden: false }, { id: 's2', target: 100, reward: '24 h stream', hidden: false }] } },
  { id: 'bits10k', label: 'Bits goal (10,000 bits)', hint: 'Twitch bits only', goal: { title: 'Bits goal', metric: 'bits', target: 10000, reward: 'Game of chat’s choice', reset: 'stream', stretch: [] } },
  { id: 'members', label: 'Member goal (25 members)', hint: 'Memberships and patrons', goal: { title: 'Member goal', metric: 'members', target: 25, reward: 'Members-only stream', reset: 'never', stretch: [] } },
  { id: 'monthly', label: 'Monthly money goal ($2,000)', hint: 'Keeps counting across streams until you reset it', goal: { title: 'Monthly goal', metric: 'money', target: 2000, reward: 'New model', reset: 'manual', stretch: [{ id: 's1', target: 3000, reward: 'New room', hidden: false }] } },
];
export function goalFromTemplate(id: string, now = Date.now(), cur = 'USD'): GoalDef | null {
  const t = GOAL_TEMPLATES.find((x) => x.id === id);
  if (!t) return null;
  const g = sanitizeGoal({ ...t.goal, id: newId('g'), startAt: now, stretch: t.goal.stretch?.map((s) => ({ ...s })) }, now);
  if (typeof g === 'string') return null;
  if (cur !== 'USD' && g.metric === 'money') g.title = g.title.replace('$', currencySymbol(cur).trim());
  return g;
}

/** Ready-made incentives (zero effort: tick them on). */
export const INCENTIVE_PRESETS: Incentive[] = [
  { id: 'p-wheel10', name: 'Every $10 spins the wheel', on: true, when: { on: 'support', kinds: [], unit: 'money', min: 10, every: true }, then: [{ do: 'wheel' }] },
  { id: 'p-gift5', name: '5+ gifted subs: air horn + confetti line', on: true, when: { on: 'support', kinds: ['gift'], unit: 'subs', min: 5, every: false }, then: [{ do: 'sound', s: 'horn' }, { do: 'message', text: '{name} gifted {subs} subs!' }] },
  { id: 'p-raid', name: 'Raids add 10 minutes + the siren', on: true, when: { on: 'raid', minViewers: 5 }, then: [{ do: 'addTime', ms: 600_000 }, { do: 'sound', s: 'siren' }] },
  { id: 'p-hour', name: 'Every hour added spins the wheel', on: true, when: { on: 'milestone', of: 'time', every: 60 }, then: [{ do: 'wheel' }] },
  { id: 'p-big50', name: '$50+ tips: show lights + a shout-out', on: true, when: { on: 'support', kinds: [], unit: 'money', min: 50, every: false }, then: [{ do: 'deck', cue: { action: 'lighting', params: { state: 'show' } } }, { do: 'message', text: 'HUGE thanks {name}! {amount}' }] },
  { id: 'p-hype', name: '!hype (mods): happy hour 2× for 15 min', on: true, when: { on: 'command', cmd: 'hype', who: 'mods', cooldownSec: 600 }, then: [{ do: 'happyhour', mult: 2, ms: 900_000 }, { do: 'sound', s: 'fanfare' }] },
  { id: 'p-follow', name: 'Follows add 30 seconds', on: true, when: { on: 'follow' }, then: [{ do: 'addTime', ms: 30_000 }] },
];

/** "{name} gifted {subs} subs!" with an event's values. */
export function fillText(t: string, v: { name?: string; amount?: string; subs?: number; bits?: number; time?: string }): string {
  return t.replace(/\{(name|amount|subs|bits|time)\}/g, (_, k: string) => String((v as Record<string, unknown>)[k] ?? '')).replace(/\s+/g, ' ').trim().slice(0, 140);
}
