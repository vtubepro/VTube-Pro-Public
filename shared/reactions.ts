// Room alert reactions (scene.json `reactions`, docs/SCENES.md "Room alert reactions"): a room maps support events
// (Kick Kicks / subs / gift subs, YouTube Super Chats / members, Rumble Rants, raids, follows …) to things the room does,
// scaled by the event's USD value (raidDonationValue: subs count as $5, gifts as $5 each) and with per-platform / per-kind
// specials. Shared by the studio (the HOST resolves the rule and stamps SceneState.reactions, src/scene/controller.ts),
// every OBS page and party guest (src/scene/reactions.ts plays the stamps at the same wall-clock time) and test pages.
//
//   host-owned actions:  look (lighting state) · camera · space / raid event (with the supporter's name) — changed in the
//                        scene state and put back after `secs` (the stamp remembers what to restore, so a studio reload
//                        mid-reaction still puts them back; a hand change by the host in the meantime wins).
//                        Look and camera are the host's, not the room's: never while BRB / Outro is up, and the camera
//                        only in Talk mode (reactionMayChange). The page-side actions below always play.
//   page-side actions:   clip (one-shot ALERT_* room clips) · cue ("alert" light cue) · groups / house / tint (a light
//                        override for `secs`) · smash (SMASH_xx props break without the Tagilla event)
//
// Besides support events a rule can react to two stream moments that are not chat lines: `goal` (a goal / stretch goal was
// reached) and `timerAdd` (time was added to the subathon timer, the seconds are the amount). They come from the helper's
// goals view (GoalsView on the bus, shared/goalsView.ts) and are picked up by GoalSignals; stamped and played like the rest.
//
// Rooms without a `reactions` block never stamp anything: nothing changes for them.
import type { ChatEvent, FinanceKind } from './chat.ts';
import { FINANCE_LABELS, LIVE_PLATFORMS, MONEY_KINDS } from './chat.ts';
import type { LightGroupSetting, LightingStateId, SceneState } from './types.ts';
import { isLightingState, sanitizeLightGroups } from './lightShow.ts';
import { raidDonationValue } from './raid.ts';
import { handPicked } from './camPick.ts';
import type { GoalsView } from './goalsView.ts';

export const REACTION_TIERS = ['small', 'medium', 'large', 'huge'] as const;
export type ReactionTier = (typeof REACTION_TIERS)[number];
/** Minimum USD value per tier (a room overrides any of them in `reactions.tiers`). */
export const DEFAULT_REACTION_TIERS: Record<ReactionTier, number> = { small: 1, medium: 5, large: 20, huge: 100 };

/** What a rule does (every field optional). */
export interface ReactionDo {
  /** Lighting state for `secs` (preshow / show / react / brb / outro — the room's looks from the Lighting states editor). */
  look?: LightingStateId;
  /** Scene camera for `secs` ('wide', 'group', 'talk', 'react' or a CAM_* preset). */
  camera?: string;
  /** How long look / camera / the light override last (s, default 8). */
  secs?: number;
  /** Per-group light override while the reaction runs (any state), e.g. { alert: { program: 'pulse', color: '#ff2018' } }. */
  groups?: Record<string, LightGroupSetting>;
  /** House light level (0 … 1.2) + tint while the reaction runs (a red alert: house 0.35, tint '#ff3020'). */
  house?: number;
  tint?: string;
  /** One-shot room clips (glTF animations named ALERT_*), played from the start on every page. */
  clip?: string[];
  /** Light cue: 'alert' = a few pulses on the room's cue groups (reactions.cueGroups; default ON AIR + alert / alarm). */
  cue?: 'alert';
  /** SMASH_xx props that break (pre-fractured pieces, they stand again after ~30 s). */
  smash?: string[];
  /** A space event ('barrage', 'threat', 'flyby', 'dogfight', 'laser', 'warp', 'strafe', 'hellbomb') with the supporter's name (space rooms). */
  space?: string;
  /** A raid event ('tagilla', 'skirmish', 'donation' or a room's own kind) with the supporter's name (raid rooms). */
  raid?: string;
}

/** What a rule reacts to: 'goal' (a goal or stretch goal reached; `minAmount` = the level, 1 = the main goal, 2 = the first stretch …),
 *  'timerAdd' (time added to the subathon timer; `minAmount` = seconds added), 'support' (any support event), 'money' (Kicks, Rants, Super Chats, Twitch bits, TikTok gifts, tips,
 *  store orders …: MONEY_KINDS), 'sub' (subs, resubs, memberships, milestones), 'giftSub' (gift subs / memberships), 'raid',
 *  'follow' (a follow line), or one finance kind. Platforms are compared as plain strings (kick, youtube, rumble, twitch,
 *  tiktok, and the support services of beta.13 that reach chat as 'finance' lines: fourthwall, kofi, throne …). */
export type ReactionOn = 'support' | 'money' | 'sub' | 'giftSub' | 'raid' | 'follow' | 'goal' | 'timerAdd' | FinanceKind;
/** The stream moments that are not chat lines (see ReactionSignal). */
export type ReactionSignalOn = 'goal' | 'timerAdd';

export interface ReactionRule {
  on: ReactionOn[];
  /** Only these platforms ('kick', 'youtube', 'rumble', 'twitch', 'tiktok', a support service …). Missing = any. */
  platform?: string[];
  /** Only these finance kinds (shared/chat.ts FinanceKind). Missing = any the `on` allows. */
  fkind?: string[];
  /** Only this tier (by USD value) … */
  tier?: ReactionTier;
  /** … or a USD range: minUsd ≤ value < maxUsd. */
  minUsd?: number;
  maxUsd?: number;
  /** Native amount at least this (gift count, raid viewers, Kicks, months; `goal`: the level; `timerAdd`: seconds). */
  minAmount?: number;
  /** true = add this rule's actions and keep matching (a later rule fills what this one left out). */
  continue?: boolean;
  /** Seconds before another reaction of the same or a lower tier may start (default reactions.cooldown). */
  cooldown?: number;
  do: ReactionDo;
}

export interface RoomReactionsConfig {
  tiers: Record<ReactionTier, number>;
  /** Seconds before another reaction of the same or a lower tier may start (a bigger one always goes through). Default 4. */
  cooldown: number;
  /** Light groups the 'alert' cue pulses (default: ON AIR groups + groups named alert / alarm). */
  cueGroups: string[] | null;
  rules: ReactionRule[];
}

/** One stamped reaction (SceneState.reactions, host clock; guests convert with the party clock offset). */
export interface ReactionStamp {
  id: string;
  /** Start / end of the reaction (epoch ms). */
  at: number;
  until: number;
  tier?: ReactionTier;
  platform?: string;
  fkind?: string;
  /** The supporter + what they gave ("$25.00", "500 Kicks", "5 subs"). */
  user?: string;
  amount?: string;
  // ---- played on every page
  clip?: string[];
  cue?: 'alert';
  smash?: string[];
  groups?: Record<string, LightGroupSetting>;
  house?: number;
  tint?: string;
  // ---- applied by the host (what it set), and what to put back at `until` (gone once restored / taken over)
  look?: LightingStateId;
  camera?: string;
  rv?: { look?: LightingStateId; camera?: string };
  /** Set when a goal or a timer add started it (not a support event). */
  ev?: ReactionSignalOn;
}

/** A matched rule set for one event. */
export interface ReactionHit { tier: ReactionTier | null; rank: number; usd: number; cooldown: number; do: ReactionDo; ev?: ReactionSignalOn }
/** What stampReaction needs to know about whatever started the reaction (a ChatEvent has all of it). */
export interface ReactionSource { id: string; platform: string; user: string; fkind?: string; display?: string }

// ---------------------------------------------------------------- sanitising (scene.json is room content: bounded, known fields only)
// (every finance kind the chat module knows: shared/chat.ts FINANCE_LABELS, so a kind added there works in rules as is)
const FKINDS = new Set<string>(Object.keys(FINANCE_LABELS));
const ON = new Set<string>(['support', 'money', 'sub', 'giftSub', 'raid', 'follow', 'goal', 'timerAdd', 'finance', ...FKINDS]);
/** Money-like kinds: the chat module's list (Kicks, Rants, Super Chats, Twitch bits, TikTok gifts, tips, store orders …). */
const MONEY = new Set<string>(MONEY_KINDS);
const CAM = /^[A-Za-z0-9_]{1,48}$/;
const CLIP = /^ALERT_[A-Za-z0-9_.-]{1,56}$/;
const SMASH = /^SMASH_[A-Za-z0-9]{1,24}$/;
const EVENT = /^[a-z][a-z0-9_]{0,23}$/;
const GROUP = /^[A-Za-z0-9_-]{1,32}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const PLATFORM = /^[a-z]{2,16}$/;
const num = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const strs = (v: unknown, re: RegExp, max: number) => [...new Set(list(v).filter((x): x is string => typeof x === 'string' && re.test(x)))].slice(0, max);
// eslint-disable-next-line no-control-regex
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').slice(0, max) : '');

/** Light group overrides: { group: { program, intensity, speed, color } } or the shorthand "program[:intensity[:speed[:#rrggbb]]]". */
function sanitizeGroups(o: unknown): Record<string, LightGroupSetting> | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const long: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>).slice(0, 16)) {
    if (!GROUP.test(k)) continue;
    if (typeof v === 'string') {
      const [program, intensity, speed, color] = v.split(':');
      long[k] = { program, intensity: intensity ? Number(intensity) : undefined, speed: speed ? Number(speed) : undefined, color };
    } else long[k] = v;
  }
  return sanitizeLightGroups(long);
}

function sanitizeDo(o: unknown): ReactionDo {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const d: ReactionDo = {};
  if (isLightingState(x.look)) d.look = x.look;
  if (typeof x.camera === 'string' && CAM.test(x.camera)) d.camera = x.camera;
  const secs = num(x.secs, 1, 120); if (secs !== undefined) d.secs = secs;
  const groups = sanitizeGroups(x.groups); if (groups) d.groups = groups;
  const house = num(x.house, 0, 1.2); if (house !== undefined) d.house = house;
  if (typeof x.tint === 'string' && HEX.test(x.tint)) d.tint = x.tint.toLowerCase();
  const clip = strs(x.clip, CLIP, 6); if (clip.length) d.clip = clip;
  if (x.cue === 'alert' || x.cue === true) d.cue = 'alert';
  const smash = strs(x.smash, SMASH, 4); if (smash.length) d.smash = smash;
  if (typeof x.space === 'string' && EVENT.test(x.space)) d.space = x.space;
  if (typeof x.raid === 'string' && EVENT.test(x.raid)) d.raid = x.raid;
  return d;
}

function sanitizeRule(o: unknown): ReactionRule | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  const on = strs(x.on ?? 'support', /^[A-Za-z]{2,16}$/, 8).filter((v) => ON.has(v)).map((v) => (v === 'finance' ? 'support' : v)) as ReactionOn[];
  if (!on.length) return null;
  const r: ReactionRule = { on, do: sanitizeDo(x.do) };
  const platform = strs(x.platform, PLATFORM, 6); if (platform.length) r.platform = platform;
  const fkind = strs(x.fkind, /^[A-Za-z]{2,16}$/, 16).filter((v) => FKINDS.has(v)); if (fkind.length) r.fkind = fkind;
  if (typeof x.tier === 'string' && (REACTION_TIERS as readonly string[]).includes(x.tier)) r.tier = x.tier as ReactionTier;
  const minUsd = num(x.minUsd ?? x.min, 0, 1e6); if (minUsd !== undefined) r.minUsd = minUsd;
  const maxUsd = num(x.maxUsd, 0, 1e6); if (maxUsd !== undefined) r.maxUsd = maxUsd;
  const minAmount = num(x.minAmount, 0, 1e9); if (minAmount !== undefined) r.minAmount = minAmount;
  if (x.continue === true) r.continue = true;
  const cd = num(x.cooldown, 0, 600); if (cd !== undefined) r.cooldown = cd;
  return r;
}

/** scene.json `reactions` → a clean config, or null (no block / no usable rule = the room has no reactions). */
export function sanitizeRoomReactions(o: unknown): RoomReactionsConfig | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  const rules = list(x.rules).slice(0, 48).map(sanitizeRule).filter((r): r is ReactionRule => !!r);
  if (!rules.length) return null;
  const t = (x.tiers && typeof x.tiers === 'object' ? x.tiers : {}) as Record<string, unknown>;
  const tiers = { ...DEFAULT_REACTION_TIERS };
  for (const k of REACTION_TIERS) { const v = num(t[k], 0, 1e6); if (v !== undefined) tiers[k] = v; }
  const cue = strs(x.cueGroups, GROUP, 16);
  return { tiers, cooldown: num(x.cooldown, 0, 600) ?? 4, cueGroups: Array.isArray(x.cueGroups) ? cue : null, rules };
}

// ---------------------------------------------------------------- matching
/** The highest tier whose minimum the USD value reaches (null = below `small`, or worth $0 like a raid). */
export function reactionTier(cfg: RoomReactionsConfig, usd: number): ReactionTier | null {
  let out: ReactionTier | null = null;
  for (const k of REACTION_TIERS) if (usd > 0 && usd >= cfg.tiers[k]) out = k;
  return out;
}
export const tierRank = (t: ReactionTier | null | undefined) => (t ? REACTION_TIERS.indexOf(t) : -1);

const SUBS = new Set<string>(['sub', 'resub', 'membership', 'milestone']);
const GIFTS = new Set<string>(['giftSub', 'giftMembership']);

/** A connector's own follow line ("just followed!") recognised by its text, for a source that sets no `ev` (Kick, Rumble). A
 *  channel announcement ("\u{1F4E3} welcome, everyone who just followed") is a system line too and is not a follow. */
export const isFollowText = (text: string): boolean => !text.startsWith('\u{1F4E3}') && /\bjust followed\b/i.test(text);

function onMatches(on: ReactionOn, e: ChatEvent): boolean {
  // (a follow is a system line with ev 'follow'; a connector that doesn't set `ev` is matched by its text, "just followed!".
  // The text must say "followed": a channel announcement ("📣 follow me on ..."), "followers-only mode" or a viewer called
  // FollowTheLeader are system lines too and are not follows)
  if (on === 'follow') return e.kind === 'system' && (e.ev ? e.ev === 'follow' : !e.text.startsWith('\u{1F4E3}') && /\bfollowed\b/i.test(e.text));
  const fk: string | undefined = e.fkind;
  if (e.kind !== 'finance' || !fk) return false;
  if (on === 'support') return true;
  if (on === 'money') return MONEY.has(fk);
  if (on === 'sub') return SUBS.has(fk);
  if (on === 'giftSub') return GIFTS.has(fk);
  return fk === on;
}

function ruleMatches(r: ReactionRule, e: ChatEvent, usd: number, tier: ReactionTier | null): boolean {
  if (!r.on.some((on) => onMatches(on, e))) return false;
  if (r.platform && !r.platform.includes(String(e.platform))) return false;
  if (r.fkind && (!e.fkind || !r.fkind.includes(String(e.fkind)))) return false;
  if (r.tier && r.tier !== tier) return false;
  if (r.minUsd !== undefined && usd < r.minUsd) return false;
  if (r.maxUsd !== undefined && usd >= r.maxUsd) return false;
  if (r.minAmount !== undefined && (e.amount ?? 0) < r.minAmount) return false;
  return true;
}

/** Rules are tried in order: the first match wins (a `continue: true` rule adds its actions and keeps looking). */
export function matchReaction(cfg: RoomReactionsConfig, e: ChatEvent): ReactionHit | null {
  const usd = e.kind === 'finance' ? raidDonationValue(e) : 0;
  const tier = reactionTier(cfg, usd);
  let d: ReactionDo | null = null, cooldown: number | undefined;
  for (const r of cfg.rules) {
    if (!ruleMatches(r, e, usd, tier)) continue;
    d = mergeDo(d, r.do);
    cooldown ??= r.cooldown;
    if (!r.continue) break;
  }
  if (!d || !Object.keys(d).length) return null;
  return { tier, rank: tierRank(tier), usd, cooldown: cooldown ?? cfg.cooldown, do: d };
}

// ---------------------------------------------------------------- goals + subathon timer (not chat lines)
/** A goal reached or time added to the subathon, as the reaction rules see it. `amount`: goal = the level reached (1 = the main
 *  goal, 2 = the first stretch goal …); timerAdd = the seconds added. */
export interface ReactionSignal {
  id: string; on: ReactionSignalOn; amount: number; user?: string; display?: string;
  /** timerAdd from GoalSignals: the seconds added in the rolling window (TIMER_WINDOW_MS) including this update, and before it.
   *  A threshold rule (`minAmount`) matches when this update alone reaches it, or when this update makes the window CROSS it
   *  (before < minAmount <= window): many small adds reach it once, then it re-arms when the window has run down again. */
  window?: number; windowBefore?: number;
}

function signalMatches(r: ReactionRule, sig: ReactionSignal): boolean {
  if (!r.on.includes(sig.on)) return false;
  if (r.platform || r.fkind || r.tier) return false;                        // (no platform / kind / USD value: those rules are for support events)
  if (r.minUsd !== undefined && r.minUsd > 0) return false;
  if (r.maxUsd !== undefined && r.maxUsd <= 0) return false;
  if (r.minAmount !== undefined) {
    const m = r.minAmount;
    const crossed = sig.window !== undefined && (sig.windowBefore ?? 0) < m && m <= sig.window;   // (timerAdd: the minute's adds crossed it)
    if (sig.amount < m && !crossed) return false;
  }
  return true;
}

/** Same rules as matchReaction (first match wins, `continue` adds up), for `goal` / `timerAdd` rules. A goal outranks every
 *  tier; each of the two keeps its own ReactionGate (a support reaction in progress never swallows them). */
export function matchSignal(cfg: RoomReactionsConfig, sig: ReactionSignal): ReactionHit | null {
  let d: ReactionDo | null = null, cooldown: number | undefined;
  for (const r of cfg.rules) {
    if (!signalMatches(r, sig)) continue;
    d = mergeDo(d, r.do);
    cooldown ??= r.cooldown;
    if (!r.continue) break;
  }
  if (!d || !Object.keys(d).length) return null;
  return { tier: null, rank: sig.on === 'goal' ? tierRank('huge') + 1 : -1, usd: 0, cooldown: cooldown ?? cfg.cooldown, do: d, ev: sig.on };
}

/** The stamp's source for a signal. */
export const signalSource = (sig: ReactionSignal): ReactionSource => ({ id: `${sig.on}:${sig.id}`, platform: sig.on === 'goal' ? 'goals' : 'subathon', user: sig.user ?? '', ...(sig.display ? { display: sig.display } : {}) });

/** A made-up goal / timer add for manual / Stream Deck / test reactions ({reaction: {on: 'goal' | 'timerAdd', amount?, user?}}), or null (not one). */
export function manualReactionSignal(o: Record<string, unknown>, n = Date.now()): ReactionSignal | null {
  if (o.on !== 'goal' && o.on !== 'timerAdd') return null;
  const amount = num(o.amount, 0, 1e9) ?? (o.on === 'goal' ? 1 : 300);
  return { id: `manual:${n}`, on: o.on, amount, user: clean(o.user, 32) || 'Test', display: o.on === 'goal' ? goalLabel(amount) : spanLabel(amount) };
}

const goalLabel = (level: number) => (level <= 1 ? 'Goal' : `Stretch ${level - 1}`);
const spanLabel = (secs: number) => {
  const s = Math.max(0, Math.round(secs)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `+${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `+${m}:${String(r).padStart(2, '0')}`;
};
/** A goal's celebration is only news for this long (ms, the helper's clock). */
export const SIGNAL_FRESH_MS = 8000;
/** The rolling window (ms) over which small timer adds add up towards a `timerAdd` threshold rule. */
export const TIMER_WINDOW_MS = 60_000;

/** Turns the helper's goals view (bus {type:'goals'}) into reaction signals: a goal / stretch goal the engine just REACHED
 *  (GoalsView.fx kind 'goal' / 'stretch' whose text says REACHED: never "STRETCH GOAL UNLOCKED" (a hidden stretch goal
 *  revealed), never the silent catch-up of an edited target) and time just added to the subathon (GoalsView.sub.last,
 *  positive entries). Everything new in ONE view becomes ONE signal per kind (a gift bomb is one add; two levels at once is
 *  one goal, the highest). Test-mode views are ignored. Host side only.
 *
 *  **Restart safety**: the helper keeps a goal's effect for 30 s and the last few timer additions for good, so the first view
 *  this object sees (a studio reload, a room change that starts the feed) is only a baseline: everything it already shows is
 *  recorded as seen and never fires (the chat reactions' `snap` protection). Only what appears after that can fire.
 *
 *  **Timer window**: small adds are summed over a rolling TIMER_WINDOW_MS; each timerAdd signal carries `window` (the sum
 *  including it) and `windowBefore`, so a threshold rule (`minAmount: 600`) fires when the adds of the last minute CROSS it
 *  (once per crossing: it re-arms when the window has run down below it), while a single big add still fires at once. */
export class GoalSignals {
  private seen = new Set<string>();
  private based = false;
  private adds: { at: number; secs: number }[] = [];
  feed(v: GoalsView | null | undefined): ReactionSignal[] {
    if (!v || v.test) return [];
    const base = !this.based;
    this.based = true;
    const fresh = (at: number) => !base && v.now - at <= SIGNAL_FRESH_MS;
    const out: ReactionSignal[] = [];
    let level = 0, goalId = '';
    for (const f of v.fx) {
      if ((f.kind !== 'goal' && f.kind !== 'stretch') || this.seen.has(`fx:${f.id}`)) continue;
      this.seen.add(`fx:${f.id}`);
      if (!fresh(f.at) || !/\bREACHED\b/i.test(f.text)) continue;
      const lv = f.kind === 'goal' ? 1 : Number(/STRETCH GOAL (\d+)/i.exec(f.text)?.[1] ?? 1) + 1;
      if (lv >= level) { level = lv; goalId = f.id; }
    }
    if (level) out.push({ id: goalId, on: 'goal', amount: level, display: goalLabel(level) });
    const sub = v.sub;
    if (sub && !sub.ended) {
      let ms = 0, top = 0, who = '', seq = 0;
      for (const l of sub.last) {
        const key = `t:${sub.startedAt}:${l.seq}`;
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        if (!fresh(l.at) || l.ms <= 0) continue;
        ms += l.ms; seq = Math.max(seq, l.seq);
        if (l.ms >= top) { top = l.ms; who = l.who; }
      }
      const secs = Math.round(ms / 1000);
      if (secs >= 1) {
        this.adds = this.adds.filter((a) => v.now - a.at <= TIMER_WINDOW_MS);
        const windowBefore = this.adds.reduce((n, a) => n + a.secs, 0);
        this.adds.push({ at: v.now, secs });
        out.push({ id: `${sub.startedAt}:${seq}`, on: 'timerAdd', amount: secs, window: windowBefore + secs, windowBefore, user: who, display: spanLabel(secs) });
      }
    }
    if (this.seen.size > 400) this.seen = new Set([...this.seen].slice(-200));
    return out;
  }
}

/** Earlier fields win; clips / smashes add up. */
function mergeDo(a: ReactionDo | null, b: ReactionDo): ReactionDo {
  if (!a) return { ...b };
  const out: ReactionDo = { ...b, ...a };
  if (a.groups || b.groups) out.groups = { ...(b.groups ?? {}), ...(a.groups ?? {}) };
  if (a.clip || b.clip) out.clip = [...new Set([...(a.clip ?? []), ...(b.clip ?? [])])].slice(0, 6);
  if (a.smash || b.smash) out.smash = [...new Set([...(a.smash ?? []), ...(b.smash ?? [])])].slice(0, 4);
  return out;
}

/** Host side: dedupe by event id + the cooldown (a bigger tier than the one playing always goes through). */
export class ReactionGate {
  private seen = new Set<string>();
  private last = { at: -Infinity, rank: -2, cooldown: 0 };
  accept(e: { id: string }, hit: ReactionHit, now = Date.now()): boolean {
    if (this.seen.has(e.id)) return false;
    this.seen.add(e.id);
    if (this.seen.size > 500) this.seen = new Set([...this.seen].slice(-200));
    return this.force(hit, now);
  }
  /** The cooldown only (manual / test reactions). */
  force(hit: ReactionHit, now = Date.now()): boolean {
    if (now < this.last.at + this.last.cooldown * 1000 && hit.rank <= this.last.rank) return false;
    this.last = { at: now, rank: hit.rank, cooldown: hit.cooldown };
    return true;
  }
}

// ---------------------------------------------------------------- stamping (host) — mutate a draft of the scene state
const REACTION_KEEP_MS = 10 * 60_000;
/** How long a FINISHED stamp stays in the scene state before the host drops it (pruneReactions): long enough for a page
 *  that opens late to still fast-forward its smash (props stand again ~32 s after the hit) or land mid-clip. */
export const REACTION_LINGER_MS = 60_000;

/** May a reaction change the host's look / camera right now? Never while the lighting state is BRB or Outro (a reaction
 *  must not uncover a BRB card or pull the camera in the outro), and the camera only in Talk mode (React / Gaming lay
 *  their own cameras out) and only while the host has not picked a camera by hand (SceneState.camPick: the Live panel
 *  dictates the camera). Pure so tools/reactions_unit.ts covers it; the stamp's page-side actions are not affected. */
export function reactionMayChange(s: Pick<SceneState, 'mode' | 'lights'> & Partial<Pick<SceneState, 'camPick'>>, what: 'look' | 'camera'): boolean {
  const look = s.lights.state ?? 'show';
  if (look === 'brb' || look === 'outro') return false;
  return what === 'look' || (s.mode === 'talk' && !handPicked(s));
}

/** Stamp one reaction into a draft state: page-side actions go into the stamp; look / camera are applied now and
 *  remembered for the revert. Returns the host-side events still to stamp (space / raid) with the supporter. */
export function stampReaction(s: SceneState, hit: ReactionHit, e: ReactionSource, now = Date.now(), lead = 600):
  { stamp: ReactionStamp; space?: string; raid?: string; user: string; amount: string } {
  const d = hit.do;
  const at = now + lead;
  const user = clean(e.user, 32);
  const amount = clean(e.display ?? (hit.usd > 0 ? `$${hit.usd.toFixed(2)}` : ''), 24);
  const stamp: ReactionStamp = { id: clean(`rx:${e.id}`, 80), at, until: at + (d.secs ?? 8) * 1000 };
  if (hit.tier) stamp.tier = hit.tier;
  if (hit.ev) stamp.ev = hit.ev;
  stamp.platform = e.platform;
  if (e.fkind) stamp.fkind = e.fkind;
  if (user) stamp.user = user;
  if (amount) stamp.amount = amount;
  if (d.clip) stamp.clip = d.clip;
  if (d.cue) stamp.cue = d.cue;
  if (d.smash) stamp.smash = d.smash;
  if (d.groups) stamp.groups = d.groups;
  if (d.house !== undefined) stamp.house = d.house;
  if (d.tint) stamp.tint = d.tint;
  const keep = (s.reactions ?? []).filter((r) => r.until > now - REACTION_KEEP_MS).map((r) => ({ ...r, ...(r.rv ? { rv: { ...r.rv } } : {}) }));
  // look / camera: a reaction that still owns them hands over what to go back to (so a chain of reactions ends where it
  // began, and the newest one decides when — even when it asks for the same look / camera)
  const cur = { look: s.lights.state ?? 'show', camera: s.camera };
  for (const k of ['look', 'camera'] as const) {
    const want = d[k];
    if (!want || !reactionMayChange(s, k)) continue;
    const owner = keep.find((r) => r.rv?.[k] !== undefined && r[k] === cur[k]);
    if (!owner && want === cur[k]) continue;                    // already showing (the host's own choice): nothing to put back
    const back = owner ? owner.rv![k] : cur[k];
    if (owner) delete owner.rv![k];
    if (k === 'look') { stamp.look = want as LightingStateId; stamp.rv = { ...stamp.rv, look: back as LightingStateId }; s.lights = { ...s.lights, state: want as LightingStateId }; }
    else { stamp.camera = want; stamp.rv = { ...stamp.rv, camera: back }; s.camera = want; }
  }
  for (const r of keep) if (r.rv && !Object.keys(r.rv).length) delete r.rv;
  s.reactions = [...keep.slice(-7), stamp];
  return { stamp, space: d.space, raid: d.raid, user, amount };
}

/** Put back what finished reactions changed (all = every pending one, e.g. before a room change). Only a look / camera
 *  still showing what the reaction set is restored: a change the host made in the meantime wins. true = changed. */
export function revertReactions(s: SceneState, now = Date.now(), all = false): boolean {
  let changed = false;
  for (const r of s.reactions ?? []) {
    if (!r.rv || (!all && r.until > now)) continue;
    if (r.rv.look !== undefined && r.look && (s.lights.state ?? 'show') === r.look) s.lights = { ...s.lights, state: r.rv.look };
    if (r.rv.camera !== undefined && r.camera && s.camera === r.camera && !handPicked(s)) s.camera = r.rv.camera;   // (a camera the host picked by hand stays)
    delete r.rv;
    changed = true;
  }
  return changed;
}

/** A reaction still waiting to put something back (the host's revert timer). */
export const reactionsPending = (s: SceneState, now = Date.now()) => (s.reactions ?? []).some((r) => r.rv && r.until <= now);

/** A finished stamp nobody needs any more (nothing to put back, REACTION_LINGER_MS past its end). */
const stale = (r: ReactionStamp, now: number) => !r.rv && r.until + REACTION_LINGER_MS <= now;
/** Some stamp is ready to be dropped (the host's tick checks this before it touches the state). */
export const reactionsStale = (s: SceneState, now = Date.now()) => (s.reactions ?? []).some((r) => stale(r, now));
/** Drop finished stamps. Without this the list keeps the last reactions for minutes and every page keeps working through
 *  it each frame; an idle room has NO stamps, so src/scene/reactions.ts returns at once (and no `reactions` key is sent). */
export function pruneReactions(s: SceneState, now = Date.now()): boolean {
  if (!s.reactions || !reactionsStale(s, now)) return false;
  const keep = s.reactions.filter((r) => !stale(r, now));
  if (keep.length) s.reactions = keep; else delete s.reactions;
  return true;
}

/** A synthetic support event for manual / Stream Deck / test reactions ({reaction: {usd, platform, fkind, user}}). */
export function manualReactionEvent(o: Record<string, unknown>, n = Date.now()): ChatEvent {
  const tier = typeof o.tier === 'string' && (REACTION_TIERS as readonly string[]).includes(o.tier) ? (o.tier as ReactionTier) : null;
  const usd = num(o.usd, 0, 1e6) ?? (tier ? DEFAULT_REACTION_TIERS[tier] : 5);
  const fkind = (typeof o.fkind === 'string' && FKINDS.has(o.fkind) ? o.fkind : 'donation') as FinanceKind;
  const platform = (typeof o.platform === 'string' && (LIVE_PLATFORMS as string[]).includes(o.platform) ? o.platform : 'test') as ChatEvent['platform'];
  const amount = num(o.amount, 0, 1e9) ?? usd;
  return { id: `manual:${n}`, kind: 'finance', platform, user: clean(o.user, 32) || 'Test', text: '', ts: n, fkind, amount, usd, display: `$${usd.toFixed(2)}`, test: true };
}

// ---------------------------------------------------------------- SceneState.reactions sanitiser
export function sanitizeReactionStamps(o: unknown): ReactionStamp[] {
  if (!Array.isArray(o)) return [];
  const out: ReactionStamp[] = [];
  for (const v of o.slice(-8)) {
    if (!v || typeof v !== 'object') continue;
    const x = v as Record<string, unknown>;
    const id = clean(x.id, 80), at = num(x.at, 1, 1e14), until = num(x.until, 1, 1e14);
    if (!id || at === undefined || until === undefined || until < at) continue;
    const r: ReactionStamp = { id, at, until: Math.min(until, at + 120_000) };
    if (typeof x.tier === 'string' && (REACTION_TIERS as readonly string[]).includes(x.tier)) r.tier = x.tier as ReactionTier;
    if (x.ev === 'goal' || x.ev === 'timerAdd') r.ev = x.ev;
    if (typeof x.platform === 'string' && PLATFORM.test(x.platform)) r.platform = x.platform;
    if (typeof x.fkind === 'string' && FKINDS.has(x.fkind)) r.fkind = x.fkind;
    const user = clean(x.user, 32), amount = clean(x.amount, 24);
    if (user) r.user = user;
    if (amount) r.amount = amount;
    const d = sanitizeDo({ clip: x.clip, cue: x.cue, smash: x.smash, groups: x.groups, house: x.house, tint: x.tint, look: x.look, camera: x.camera });
    if (d.clip) r.clip = d.clip;
    if (d.cue) r.cue = d.cue;
    if (d.smash) r.smash = d.smash;
    if (d.groups) r.groups = d.groups;
    if (d.house !== undefined) r.house = d.house;
    if (d.tint) r.tint = d.tint;
    if (d.look) r.look = d.look;
    if (d.camera) r.camera = d.camera;
    if (x.rv && typeof x.rv === 'object') {
      const rv = x.rv as Record<string, unknown>, o2: NonNullable<ReactionStamp['rv']> = {};
      if (isLightingState(rv.look)) o2.look = rv.look;
      if (typeof rv.camera === 'string' && CAM.test(rv.camera)) o2.camera = rv.camera;
      if (Object.keys(o2).length) r.rv = o2;
    }
    out.push(r);
  }
  return out;
}
