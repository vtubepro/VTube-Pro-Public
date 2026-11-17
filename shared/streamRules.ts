// Redeems & Reactions for the avatar (beta.16, docs/b16/LANES.md): "when chat does X, my avatar does Y for N seconds and
// then goes back". This file is the CONTRACT every lane codes against; it has no DOM, no file system and no network, so the
// studio, the helper and tools/stream_rules_unit.ts all use the same code. Three parts:
//
//   1. DATA     RuleWhen (what a rule listens for) · RuleEvent (what happened) · StreamRule (when + then + limits) ·
//               the .vtprules.json file, with sanitisers (a rule set is content: bounded, known fields only, imports are OFF).
//   2. MATCHING matchWhen / matchRule / rolesOf, and ruleEventsFromChat (a ChatEvent -> the RuleEvents it means).
//   3. REGISTRY registerRuleAction(id, handler, meta) · emitRuleTrigger(event) · onRuleTrigger(listener) · runRuleSteps.
//               Every lane that adds something a rule can DO registers an action; every lane that notices something a
//               rule can LISTEN to emits a trigger. Nobody calls anybody else directly.
//
// Limits (the loop guard): a rule runs at most MAX_RULE_CHAIN steps; a trigger that a rule itself caused (an action that
// calls emitRuleTrigger) must carry depth + 1 and is dropped above MAX_RULE_DEPTH; a rule is never fired by its own
// steps (`via`). Ranges: USD is half-open (minUsd <= usd < maxUsd, like shared/reactions.ts); every other min/max (gift
// count, bits, Kicks, raid viewers, coins) is inclusive.
//
// Which process runs the engine is the rules lane's call (src/rules + server/rules.ts); the registry works in both. A
// process that notices a trigger the engine does not live in forwards it with setRuleForwarder() (docs/b16/LANES.md).
import type { ChatEvent } from './chat.ts';
import { MONEY_KINDS } from './chat.ts';
import type { DeckParam } from './deck.ts';

export const RULES_FILE_VERSION = 1;
/** Steps a rule may chain. */
export const MAX_RULE_CHAIN = 5;
/** A trigger that a rule's own action caused may nest this deep (0 = from the outside world). Above this it is dropped. */
export const MAX_RULE_DEPTH = 2;
export const MAX_RULES = 200;
export const MAX_WHEN = 8;
/** Longest timed revert (s). */
export const MAX_REVERT_SECS = 3600;
export const MAX_COOLDOWN_SECS = 3600;
export const MAX_QUEUE = 50;

export const RULE_ROLES = ['everyone', 'sub', 'vip', 'mod', 'me'] as const;
/** Who may fire a chat trigger: `me` = the streamer; `mod` includes the streamer; `sub` = subscriber / member / founder. */
export type RuleRole = (typeof RULE_ROLES)[number];

export const HAND_SIGNS = ['thumbs_up', 'thumbs_down', 'peace', 'love', 'fist', 'point', 'wave', 'palm', 'rock'] as const;
export const SUB_TIERS = ['1000', '2000', '3000', 'Prime'] as const;
export type RuleSubTier = (typeof SUB_TIERS)[number];

// ---------------------------------------------------------------- data

/** What a rule listens for. A rule fires when ANY of its `when` entries matches (every field inside one entry must match). */
export type RuleWhen =
  | { kind: 'redeem'; title: string; contains?: boolean; platform?: string }
  | { kind: 'money'; fkind?: string[]; platform?: string; minUsd?: number; maxUsd?: number; minAmount?: number; maxAmount?: number } // bits / Kicks / Super Chats / tips / USD range
  | { kind: 'giftSub'; min?: number; max?: number; platform?: string }
  | { kind: 'sub'; tier?: RuleSubTier[]; platform?: string }
  | { kind: 'follow'; platform?: string }
  | { kind: 'raid'; minViewers?: number; maxViewers?: number; platform?: string }
  | { kind: 'tiktokGift'; name?: string; minCoins?: number; maxCoins?: number }
  | { kind: 'chat'; command?: string; word?: string; role?: RuleRole; platform?: string }
  | { kind: 'key'; combo: string }                                                // a global / browser key combo (bindings lane): "Ctrl+Shift+F9"
  | { kind: 'pad'; note?: number; cc?: number; channel?: number }                 // MIDI pad (note) or knob (cc)
  | { kind: 'gamepad'; button: number; pad?: number }
  | { kind: 'hand'; sign: string; side?: 'left' | 'right' | 'any'; holdMs?: number }
  | { kind: 'loud'; above: number; forMs: number }                                // "scream": loudness / mouth above a level (0..1) for N ms (soundfx lane)
  | { kind: 'manual' };                                                           // the rule's Try-it button and the deck "run rule" key

export type RuleWhenKind = RuleWhen['kind'];
export const RULE_WHEN_KINDS: readonly RuleWhenKind[] = ['redeem', 'money', 'giftSub', 'sub', 'follow', 'raid', 'tiktokGift', 'chat', 'key', 'pad', 'gamepad', 'hand', 'loud', 'manual'];

export interface RuleEventBase {
  /** Unique per real-world happening (a platform id when there is one): the same id is delivered once. */
  id: string;
  /** Epoch ms. */
  ts: number;
  /** 0 = from the outside world; a rule's own action that emits a trigger passes depth + 1. */
  depth?: number;
  /** The rule whose action caused this event (it never fires that rule again). */
  via?: string;
  /** From a Try-it / test button: the rule runs for real but nothing is posted anywhere. */
  test?: boolean;
  /** The person behind it (redeemer, sender, raider ...). Display name only. */
  user?: string;
  uid?: string;
  platform?: string;
}

/** What happened. The kinds mirror RuleWhen's. */
export type RuleEvent = RuleEventBase & (
  | { kind: 'redeem'; title: string; cost?: number; input?: string }
  | { kind: 'money'; fkind: string; amount: number; currency?: string; usd?: number }
  | { kind: 'giftSub'; count: number; tier?: string }
  | { kind: 'sub'; tier?: string; months?: number }
  | { kind: 'follow' }
  | { kind: 'raid'; viewers: number }
  | { kind: 'tiktokGift'; name: string; coins: number; count?: number }
  | { kind: 'chat'; text: string; badges?: string[] }
  | { kind: 'key'; combo: string }
  | { kind: 'pad'; note?: number; cc?: number; channel?: number; value?: number }
  | { kind: 'gamepad'; button: number; pad?: number }
  | { kind: 'hand'; sign: string; side: 'left' | 'right'; heldMs: number }
  | { kind: 'loud'; level: number; ms: number }
  | { kind: 'manual'; rule?: string }
);
export type RuleEventKind = RuleEvent['kind'];

/** One thing a rule does: a Stream Deck action id (shared/deck.ts, old and new) or a registered rule action. */
export interface RuleStep {
  action: string;
  /** Deck-style params. String values may use {user} {title} {amount} {count} {text} {viewers} {level} (expandParams). */
  params?: Record<string, string | number | boolean>;
  /** Wait this long after the previous step (ms, 0 .. 60000). */
  delayMs?: number;
}

export interface RuleQueue {
  /** Events that arrive while the rule is busy (a gift bomb): at most this many wait. 0 = drop them. */
  max: number;
  /** Gap between queued runs (ms). */
  gapMs: number;
}

export interface StreamRule {
  id: string;
  name: string;
  /** Imported and starter rules are OFF until the user turns them on. */
  enabled: boolean;
  when: RuleWhen[];
  then: RuleStep[];
  /** Put outfit / accessory / item / light / camera changes back after this many seconds (0 = they stay). */
  revertSecs: number;
  /** Seconds before this rule may fire again. */
  cooldownSecs: number;
  queue?: RuleQueue;
  /** A shipped starter rule (the panel offers "Reset" for these). */
  starter?: boolean;
  note?: string;
}

/** The .vtprules.json file. */
export interface RuleSetFile { vtprules: typeof RULES_FILE_VERSION; name?: string; rules: StreamRule[] }

/** A pending timed revert: what to run, and when. Plain JSON so it can live in SceneState.modes.rules and survive a reload. */
export interface RuleRevertStamp { id: string; rule: string; at: number; until: number; undo: RuleStep[] }

// ---------------------------------------------------------------- sanitising (a rule set is content: bounded, known fields only)

const ID = /^[A-Za-z0-9_-]{1,48}$/;
const ACTION = /^[a-z][a-z0-9-]{0,47}$/;
const PARAM_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const PLATFORM = /^[a-z]{2,16}$/;
const COMBO = /^(Ctrl\+)?(Alt\+)?(Shift\+)?(Meta\+)?[A-Za-z0-9]{1,24}$/;
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const optNum = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
const optInt = (v: unknown, lo: number, hi: number): number | undefined => { const n = optNum(v, lo, hi); return n === undefined ? undefined : Math.round(n); };
const plat = (v: unknown): { platform?: string } => (typeof v === 'string' && PLATFORM.test(v) ? { platform: v } : {});
/** Spread only the defined entries (so JSON never carries `undefined` keys). */
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export function sanitizeWhen(o: unknown): RuleWhen | null {
  const x = rec(o), k = x.kind;
  switch (k) {
    case 'redeem': { const title = clean(x.title, 80); return title ? defined({ kind: 'redeem', title, contains: x.contains === true ? true : undefined, ...plat(x.platform) }) as RuleWhen : null; }
    case 'money': {
      const fk = Array.isArray(x.fkind) ? x.fkind.map((f) => clean(f, 24)).filter((f) => /^[A-Za-z]{2,24}$/.test(f)).slice(0, 16) : undefined;
      return defined({ kind: 'money', fkind: fk && fk.length ? fk : undefined, ...plat(x.platform), minUsd: optNum(x.minUsd, 0, 1e6), maxUsd: optNum(x.maxUsd, 0, 1e6), minAmount: optNum(x.minAmount, 0, 1e9), maxAmount: optNum(x.maxAmount, 0, 1e9) }) as RuleWhen;
    }
    case 'giftSub': return defined({ kind: 'giftSub', min: optInt(x.min, 1, 1e5), max: optInt(x.max, 1, 1e5), ...plat(x.platform) }) as RuleWhen;
    case 'sub': { const t = Array.isArray(x.tier) ? x.tier.filter((v): v is RuleSubTier => (SUB_TIERS as readonly unknown[]).includes(v)).slice(0, 4) : undefined; return defined({ kind: 'sub', tier: t && t.length ? t : undefined, ...plat(x.platform) }) as RuleWhen; }
    case 'follow': return defined({ kind: 'follow', ...plat(x.platform) }) as RuleWhen;
    case 'raid': return defined({ kind: 'raid', minViewers: optInt(x.minViewers, 0, 1e7), maxViewers: optInt(x.maxViewers, 0, 1e7), ...plat(x.platform) }) as RuleWhen;
    case 'tiktokGift': return defined({ kind: 'tiktokGift', name: clean(x.name, 40) || undefined, minCoins: optInt(x.minCoins, 0, 1e9), maxCoins: optInt(x.maxCoins, 0, 1e9) }) as RuleWhen;
    case 'chat': {
      const command = clean(x.command, 32).toLowerCase().replace(/\s+/g, ''), word = clean(x.word, 48);
      const role = (RULE_ROLES as readonly unknown[]).includes(x.role) ? x.role as RuleRole : undefined;
      if (!command && !word) return null;
      return defined({ kind: 'chat', command: command ? (command.startsWith('!') ? command : '!' + command) : undefined, word: word || undefined, role, ...plat(x.platform) }) as RuleWhen;
    }
    case 'key': { const c = typeof x.combo === 'string' ? x.combo.trim() : ''; return COMBO.test(c) ? { kind: 'key', combo: c } : null; }
    case 'pad': {
      const w = defined({ kind: 'pad', note: optInt(x.note, 0, 127), cc: optInt(x.cc, 0, 127), channel: optInt(x.channel, 1, 16) }) as RuleWhen;
      return (w as { note?: number }).note === undefined && (w as { cc?: number }).cc === undefined ? null : w;
    }
    case 'gamepad': { const b = optInt(x.button, 0, 63); return b === undefined ? null : defined({ kind: 'gamepad', button: b, pad: optInt(x.pad, 0, 7) }) as RuleWhen; }
    case 'hand': {
      const sign = clean(x.sign, 16);
      if (!(HAND_SIGNS as readonly string[]).includes(sign)) return null;
      return defined({ kind: 'hand', sign, side: x.side === 'left' || x.side === 'right' || x.side === 'any' ? x.side : undefined, holdMs: optInt(x.holdMs, 0, 10000) }) as RuleWhen;
    }
    case 'loud': { const a = optNum(x.above, 0, 1), f = optInt(x.forMs, 0, 10000); return a === undefined ? null : { kind: 'loud', above: a, forMs: f ?? 0 }; }
    case 'manual': return { kind: 'manual' };
  }
  return null;
}

/** Actions automation may never run: a rule (like a goal) may never ask for, let alone start, a stream. */
export const RULE_DENIED_ACTIONS: readonly string[] = ['golive'];

export function sanitizeStep(o: unknown): RuleStep | null {
  const x = rec(o);
  if (typeof x.action !== 'string' || !ACTION.test(x.action) || RULE_DENIED_ACTIONS.includes(x.action)) return null;
  const params: Record<string, string | number | boolean> = {};
  let n = 0;
  for (const [k, v] of Object.entries(rec(x.params))) {
    if (!PARAM_KEY.test(k) || n >= 16) continue;
    if (typeof v === 'string') params[k] = v.replace(/[\u0000-\u001f]/g, ' ').slice(0, 400);
    else if (typeof v === 'number' && Number.isFinite(v)) params[k] = v;
    else if (typeof v === 'boolean') params[k] = v;
    else continue;
    n++;
  }
  return defined({ action: x.action, params: n ? params : undefined, delayMs: optInt(x.delayMs, 0, 60000) || undefined }) as RuleStep;
}

export function sanitizeRule(o: unknown, fallbackId = ''): StreamRule | null {
  const x = rec(o);
  const when = (Array.isArray(x.when) ? x.when : []).slice(0, MAX_WHEN).map(sanitizeWhen).filter((w): w is RuleWhen => !!w);
  const then = (Array.isArray(x.then) ? x.then : []).slice(0, MAX_RULE_CHAIN).map(sanitizeStep).filter((s): s is RuleStep => !!s);
  if (!when.length || !then.length) return null;
  const id = typeof x.id === 'string' && ID.test(x.id) ? x.id : ID.test(fallbackId) ? fallbackId : '';
  if (!id) return null;
  const q = rec(x.queue);
  const queue = Object.keys(q).length ? { max: optInt(q.max, 0, MAX_QUEUE) ?? 0, gapMs: optInt(q.gapMs, 0, 60000) ?? 500 } : undefined;
  return defined({
    id, name: clean(x.name, 60) || id, enabled: x.enabled === true, when, then,
    revertSecs: optNum(x.revertSecs, 0, MAX_REVERT_SECS) ?? 0, cooldownSecs: optNum(x.cooldownSecs, 0, MAX_COOLDOWN_SECS) ?? 0,
    queue, starter: x.starter === true ? true : undefined, note: clean(x.note, 200) || undefined,
  }) as StreamRule;
}

/** Clean a rule list (bad rules dropped, duplicate ids renamed `-2`, `-3` ...). */
export function sanitizeRules(o: unknown): StreamRule[] {
  const out: StreamRule[] = [], seen = new Set<string>();
  for (const [i, r] of (Array.isArray(o) ? o : []).slice(0, MAX_RULES).entries()) {
    const s = sanitizeRule(r, `rule-${i + 1}`);
    if (!s) continue;
    let id = s.id, n = 2;
    while (seen.has(id)) id = `${s.id.slice(0, 44)}-${n++}`;
    seen.add(id);
    out.push(id === s.id ? s : { ...s, id });
  }
  return out;
}

/** Read a .vtprules.json. `imported` (a file from somebody else) forces every rule OFF; the user reviews and turns them on. */
export function parseRuleSet(text: string, imported = true): RuleSetFile | null {
  let j: unknown;
  try { j = JSON.parse(text); } catch { return null; }
  const x = rec(j);
  if (x.vtprules !== RULES_FILE_VERSION) return null;
  const rules = sanitizeRules(x.rules).map((r) => (imported ? { ...r, enabled: false } : r));
  return { vtprules: RULES_FILE_VERSION, ...(clean(x.name, 60) ? { name: clean(x.name, 60) } : {}), rules };
}
export function stringifyRuleSet(rules: StreamRule[], name?: string): string {
  return JSON.stringify({ vtprules: RULES_FILE_VERSION, ...(name ? { name: clean(name, 60) } : {}), rules: sanitizeRules(rules) }, null, 1);
}

/**
 * SceneState.modes bags are cut at depth 5 (shared/stage.ts cleanJson), and bag -> stamps[] -> stamp -> undo[] -> step -> params
 * is depth 6, so a stamp saved as-is came back with every step's params removed. The saved form keeps each stamp 3 levels deep:
 * `{ id, rule, at, until, u: [<JSON text of the undo steps, cut in pieces of at most 180 characters>] }` (strings pass the cut).
 */
const PACK_CHUNK = 180, PACK_MAX_CHUNKS = 8;
export function packRevertStamps(stamps: RuleRevertStamp[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const s of stamps) {
    const text = JSON.stringify(s.undo);
    const u: string[] = [];
    for (let i = 0; i < text.length; i += PACK_CHUNK) u.push(text.slice(i, i + PACK_CHUNK));
    if (!u.length || u.length > PACK_MAX_CHUNKS) continue;   // too long to keep in the saved state: it still reverts while the studio stays open
    out.push({ id: s.id, rule: s.rule, at: s.at, until: s.until, u });
  }
  return out;
}

/** Read stamps back: the saved form of packRevertStamps (`u`), or plain stamps with an `undo` array. Bad ones are dropped. */
export function sanitizeRevertStamps(o: unknown): RuleRevertStamp[] {
  const out: RuleRevertStamp[] = [];
  for (const v of (Array.isArray(o) ? o : []).slice(0, 64)) {
    const x = rec(v);
    let raw: unknown = x.undo;
    if (!Array.isArray(raw) && Array.isArray(x.u) && x.u.every((c) => typeof c === 'string')) {
      try { raw = JSON.parse((x.u as string[]).join('')); } catch { raw = []; }
    }
    const undo = (Array.isArray(raw) ? raw : []).slice(0, MAX_RULE_CHAIN).map(sanitizeStep).filter((s): s is RuleStep => !!s);
    if (typeof x.id !== 'string' || !ID.test(x.id) || typeof x.rule !== 'string' || !ID.test(x.rule) || !undo.length) continue;
    const at = optNum(x.at, 0, 1e15), until = optNum(x.until, 0, 1e15);
    if (at === undefined || until === undefined) continue;
    out.push({ id: x.id, rule: x.rule, at, until, undo });
  }
  return out;
}

/** Bus command that carries a RuleEvent from the process that noticed it to the process that runs the engine (setRuleForwarder). */
export const RULE_TRIGGER_COMMAND = 'rule-trigger';

/** A RuleEvent that arrived over the bus (or from a REST call): known kinds and fields only, bounded. Null = junk. */
export function sanitizeRuleEvent(o: unknown): RuleEvent | null {
  const x = rec(o);
  if (!(RULE_WHEN_KINDS as readonly unknown[]).includes(x.kind)) return null;
  const n = (v: unknown, lo: number, hi: number, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const id = clean(x.id, 80) || `rt-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const base: RuleEventBase = {
    id, ts: n(x.ts, 0, 1e15, Date.now()), depth: Math.round(n(x.depth, 0, 99)) || undefined, via: typeof x.via === 'string' && ID.test(x.via) ? x.via : undefined,
    test: x.test === true ? true : undefined, user: clean(x.user, 48) || undefined, uid: clean(x.uid, 64) || undefined, platform: typeof x.platform === 'string' && PLATFORM.test(x.platform) ? x.platform : undefined,
  };
  let e: RuleEvent | null;
  switch (x.kind as RuleEventKind) {
    case 'redeem': e = { ...base, kind: 'redeem', title: clean(x.title, 80), ...(typeof x.cost === 'number' ? { cost: n(x.cost, 0, 1e9) } : {}), ...(clean(x.input, 200) ? { input: clean(x.input, 200) } : {}) }; break;
    case 'money': e = { ...base, kind: 'money', fkind: clean(x.fkind, 24), amount: n(x.amount, 0, 1e9), ...(clean(x.currency, 12) ? { currency: clean(x.currency, 12) } : {}), ...(typeof x.usd === 'number' ? { usd: n(x.usd, 0, 1e7) } : {}) }; break;
    case 'giftSub': e = { ...base, kind: 'giftSub', count: Math.round(n(x.count, 1, 1e5, 1)), ...(clean(x.tier, 8) ? { tier: clean(x.tier, 8) } : {}) }; break;
    case 'sub': e = { ...base, kind: 'sub', ...(clean(x.tier, 8) ? { tier: clean(x.tier, 8) } : {}), ...(typeof x.months === 'number' ? { months: Math.round(n(x.months, 0, 1e4)) } : {}) }; break;
    case 'follow': e = { ...base, kind: 'follow' }; break;
    case 'raid': e = { ...base, kind: 'raid', viewers: Math.round(n(x.viewers, 0, 1e7)) }; break;
    case 'tiktokGift': e = { ...base, kind: 'tiktokGift', name: clean(x.name, 40), coins: Math.round(n(x.coins, 0, 1e9)), ...(typeof x.count === 'number' ? { count: Math.round(n(x.count, 1, 1e5, 1)) } : {}) }; break;
    case 'chat': e = { ...base, kind: 'chat', text: clean(x.text, 500), ...(Array.isArray(x.badges) ? { badges: x.badges.map((b) => clean(b, 20).toLowerCase()).filter(Boolean).slice(0, 6) } : {}) }; break;
    case 'key': e = typeof x.combo === 'string' && COMBO.test(x.combo.trim()) ? { ...base, kind: 'key', combo: x.combo.trim() } : null; break;
    case 'pad': e = { ...base, kind: 'pad', ...(typeof x.note === 'number' ? { note: Math.round(n(x.note, 0, 127)) } : {}), ...(typeof x.cc === 'number' ? { cc: Math.round(n(x.cc, 0, 127)) } : {}), ...(typeof x.channel === 'number' ? { channel: Math.round(n(x.channel, 1, 16, 1)) } : {}), ...(typeof x.value === 'number' ? { value: n(x.value, 0, 1) } : {}) }; break;
    case 'gamepad': e = { ...base, kind: 'gamepad', button: Math.round(n(x.button, 0, 63)), ...(typeof x.pad === 'number' ? { pad: Math.round(n(x.pad, 0, 7)) } : {}) }; break;
    case 'hand': e = { ...base, kind: 'hand', sign: clean(x.sign, 16), side: x.side === 'left' ? 'left' : 'right', heldMs: Math.round(n(x.heldMs, 0, 600000)) }; break;
    case 'loud': e = { ...base, kind: 'loud', level: n(x.level, 0, 1), ms: Math.round(n(x.ms, 0, 600000)) }; break;
    case 'manual': e = { ...base, kind: 'manual', ...(typeof x.rule === 'string' && ID.test(x.rule) ? { rule: x.rule } : {}) }; break;
    default: e = null;
  }
  return e ? (Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) as RuleEvent) : null;
}

// ---------------------------------------------------------------- matching

const lc = (v: unknown) => String(v ?? '').toLowerCase();
const inRange = (v: number, lo: number | undefined, hi: number | undefined) => (lo === undefined || v >= lo) && (hi === undefined || v <= hi);

/** The roles a chatter holds, from the badges the chat module normalised (shared/chat.ts). `mod` includes the streamer. */
export function rolesOf(badges: readonly string[] | undefined, vip = false): Set<RuleRole> {
  const b = new Set((badges ?? []).map(lc));
  const r = new Set<RuleRole>(['everyone']);
  const me = b.has('broadcaster') || b.has('owner') || b.has('streamer');
  if (me) { r.add('me'); r.add('mod'); }
  if (b.has('moderator') || b.has('mod')) r.add('mod');
  if (vip || b.has('vip')) r.add('vip');
  if (b.has('subscriber') || b.has('member') || b.has('founder') || b.has('sub')) r.add('sub');
  return r;
}

/** Does one `when` entry match this event? (Pure: cooldown, enabled and loop guards are the engine's.) */
export function matchWhen(w: RuleWhen, e: RuleEvent): boolean {
  if (w.kind !== e.kind) return false;
  const platOk = () => { const p = (w as { platform?: string }).platform; return !p || lc(e.platform) === lc(p); };
  switch (w.kind) {
    case 'redeem': { const ev = e as Extract<RuleEvent, { kind: 'redeem' }>, a = lc(ev.title).trim(), b = lc(w.title).trim(); return platOk() && (w.contains ? a.includes(b) : a === b); }
    case 'money': {
      const ev = e as Extract<RuleEvent, { kind: 'money' }>;
      if (!platOk()) return false;
      if (w.fkind && w.fkind.length && !w.fkind.map(lc).includes(lc(ev.fkind))) return false;
      if (w.minUsd !== undefined || w.maxUsd !== undefined) { if (ev.usd === undefined) return false; if ((w.minUsd !== undefined && ev.usd < w.minUsd) || (w.maxUsd !== undefined && ev.usd >= w.maxUsd)) return false; }
      return inRange(ev.amount, w.minAmount, w.maxAmount);
    }
    case 'giftSub': return platOk() && inRange((e as Extract<RuleEvent, { kind: 'giftSub' }>).count, w.min, w.max);
    case 'sub': { const t = (e as Extract<RuleEvent, { kind: 'sub' }>).tier; return platOk() && (!w.tier || !w.tier.length || (!!t && w.tier.map(String).includes(t))); }
    case 'follow': return platOk();
    case 'raid': return platOk() && inRange((e as Extract<RuleEvent, { kind: 'raid' }>).viewers, w.minViewers, w.maxViewers);
    case 'tiktokGift': { const ev = e as Extract<RuleEvent, { kind: 'tiktokGift' }>; return (!w.name || lc(ev.name) === lc(w.name)) && inRange(ev.coins, w.minCoins, w.maxCoins); }
    case 'chat': {
      const ev = e as Extract<RuleEvent, { kind: 'chat' }>;
      if (!platOk()) return false;
      if (w.role && w.role !== 'everyone' && !rolesOf(ev.badges).has(w.role)) return false;
      const text = ev.text.trim();
      if (w.command && lc(text.split(/\s+/, 1)[0]) !== lc(w.command)) return false;
      if (w.word) { const esc = w.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); if (!new RegExp(`(^|[^\\p{L}\\p{N}_])${esc}($|[^\\p{L}\\p{N}_])`, 'iu').test(text)) return false; }
      return true;
    }
    case 'key': return lc((e as Extract<RuleEvent, { kind: 'key' }>).combo) === lc(w.combo);
    case 'pad': {
      const ev = e as Extract<RuleEvent, { kind: 'pad' }>;
      return (w.note === undefined || w.note === ev.note) && (w.cc === undefined || w.cc === ev.cc) && (w.channel === undefined || w.channel === ev.channel);
    }
    case 'gamepad': { const ev = e as Extract<RuleEvent, { kind: 'gamepad' }>; return w.button === ev.button && (w.pad === undefined || w.pad === (ev.pad ?? 0)); }
    case 'hand': { const ev = e as Extract<RuleEvent, { kind: 'hand' }>; return w.sign === ev.sign && (!w.side || w.side === 'any' || w.side === ev.side) && ev.heldMs >= (w.holdMs ?? 0); }
    case 'loud': { const ev = e as Extract<RuleEvent, { kind: 'loud' }>; return ev.level >= w.above && ev.ms >= w.forMs; }
    case 'manual': return true;
  }
}

/** Does this rule fire for this event? Off rules never; a rule is never fired by its own steps (`via`); manual events name a rule. */
export function matchRule(r: StreamRule, e: RuleEvent): boolean {
  if (e.via === r.id) return false;
  if (e.kind === 'manual') return !!e.rule && e.rule === r.id;
  if (!r.enabled) return false;
  return r.when.some((w) => matchWhen(w, e));
}

/** Every enabled rule an event fires, in list order. */
export function matchRules(rules: readonly StreamRule[], e: RuleEvent): StreamRule[] {
  if ((e.depth ?? 0) > MAX_RULE_DEPTH) return [];
  return rules.filter((r) => matchRule(r, e));
}

/** The rule events a chat/support line means (one line can mean several: a TikTok gift is both a tiktokGift and money). */
export function ruleEventsFromChat(c: ChatEvent): RuleEvent[] {
  const base = { id: c.id, ts: c.ts, user: c.user, platform: c.platform, ...(c.uid ? { uid: c.uid } : {}), ...(c.test ? { test: true } : {}) };
  const out: RuleEvent[] = [];
  if (c.kind === 'chat') {
    if (c.text.trim()) out.push({ ...base, kind: 'chat', text: c.text, ...(c.badges ? { badges: c.badges } : {}), ...(c.vip && !c.badges?.includes('vip') ? { badges: [...(c.badges ?? []), 'vip'] } : {}) });
    return out;
  }
  if (c.kind === 'system') {
    if (c.ev === 'reward') out.push({ ...base, kind: 'redeem', title: c.text.replace(/^redeemed\s+/i, '').trim() });
    else if (c.ev === 'follow') out.push({ ...base, kind: 'follow' });
    return out;
  }
  if (c.kind !== 'finance' || !c.fkind) return out;
  const amount = c.amount ?? 0;
  switch (c.fkind) {
    case 'raid': out.push({ ...base, kind: 'raid', viewers: amount }); return out;
    case 'giftSub': case 'giftMembership': out.push({ ...base, id: c.id + ':gift', kind: 'giftSub', count: Math.max(1, amount || 1), ...(c.subPlan ? { tier: c.subPlan } : {}) }); return out;
    case 'sub': case 'resub': case 'membership': case 'milestone': case 'patron': out.push({ ...base, id: c.id + ':sub', kind: 'sub', ...(c.subPlan ? { tier: c.subPlan } : {}), ...(c.currency === 'months' ? { months: amount } : {}) }); return out;
  }
  if (c.fkind === 'tiktokGift') out.push({ ...base, id: c.id + ':gift', kind: 'tiktokGift', name: c.giftName ?? '', coins: amount });
  if (MONEY_KINDS.has(c.fkind)) out.push({ ...base, kind: 'money', fkind: c.fkind, amount, ...(c.currency ? { currency: c.currency } : {}), ...(c.usd !== undefined || c.approxUsd !== undefined ? { usd: c.usd ?? c.approxUsd } : {}) });
  return out;
}

/** Fill {user} {title} {amount} {count} {text} {viewers} {level} in string params from the event. Unknown names stay as they are. */
export function expandParams(params: RuleStep['params'], e: RuleEvent): Record<string, string | number | boolean> {
  const f: Record<string, string> = { user: e.user ?? '' };
  if (e.kind === 'redeem') f.title = e.title;
  if (e.kind === 'money') f.amount = String(e.amount);
  if (e.kind === 'giftSub') f.count = String(e.count);
  if (e.kind === 'tiktokGift') { f.count = String(e.coins); f.title = e.name; }
  if (e.kind === 'chat') f.text = e.text;
  if (e.kind === 'raid') f.viewers = String(e.viewers);
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(params ?? {})) out[k] = typeof v === 'string' ? v.replace(/\{([a-z]+)\}/g, (m, n: string) => (n in f ? f[n] : m)) : v;
  return out;
}

// ---------------------------------------------------------------- registry

export interface RuleActionCtx {
  rule: StreamRule | null;
  event: RuleEvent;
  step: RuleStep;
  /** step.params with the {placeholders} filled in. */
  params: Record<string, string | number | boolean>;
  /** Pass depth + 1 (and via: rule.id) to any emitRuleTrigger this action makes. */
  depth: number;
  /** A Try-it run: do it, but post nothing anywhere. */
  test: boolean;
  now: number;
}
/** `undo` = the step that puts it back (outfit off, item removed, camera back ...). Plain data, so it can be stamped and survive a reload. */
export interface RuleActionResult { ok: boolean; error?: string; undo?: RuleStep }
export type RuleActionHandler = (ctx: RuleActionCtx) => RuleActionResult | void | Promise<RuleActionResult | void>;
export interface RuleActionMeta {
  label: string;
  group?: string;
  icon?: string;
  params?: DeckParam[];
  /** Which process the handler lives in. A step whose handler is in the other process is the engine's to forward. */
  where?: 'studio' | 'helper' | 'any';
  /** The handler can return an `undo` (the panel offers "put back after N seconds" for rules that use it). */
  undoable?: boolean;
  /** Plays sound: the panel says so, and it only ever plays on the host OBS page. */
  sound?: boolean;
}
interface ActionEntry { handler: RuleActionHandler; meta: RuleActionMeta }

const actions = new Map<string, ActionEntry>();
/** Add (or replace: HMR registers twice) a rule action. Returns the function that removes it again. */
export function registerRuleAction(id: string, handler: RuleActionHandler, meta: RuleActionMeta): () => void {
  if (!ACTION.test(id)) throw new Error(`Bad rule action id "${id}"`);
  const entry = { handler, meta };
  actions.set(id, entry);
  return () => { if (actions.get(id) === entry) actions.delete(id); };
}
export const getRuleAction = (id: string): ActionEntry | undefined => actions.get(id);
export const listRuleActions = (): { id: string; meta: RuleActionMeta }[] => [...actions].map(([id, e]) => ({ id, meta: e.meta }));

type TriggerListener = (e: RuleEvent) => void;
const listeners = new Set<TriggerListener>();
let forwarder: ((e: RuleEvent) => void) | null = null;
const recent = new Map<string, number>();
const DEDUPE_MS = 5000;

/** The engine (and anything that wants to watch) listens here. Returns the unsubscribe. */
export function onRuleTrigger(fn: TriggerListener): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
/** A process whose engine lives elsewhere sends every trigger it notices there (a bus message). Pass null to stop. */
export function setRuleForwarder(fn: ((e: RuleEvent) => void) | null) { forwarder = fn; }

export type EmitResult = { delivered: number } | { dropped: 'depth' | 'duplicate' | 'bad' };
/**
 * Tell the rules that something happened. Safe to call from anywhere and from both processes: bad events and loops are
 * dropped here, the same id is delivered once (so a line seen by the helper AND the studio fires a rule once), and a throwing
 * listener never reaches the caller. Does nothing at all (no timers, no allocation worth the name) when nobody listens.
 */
export function emitRuleTrigger(e: RuleEvent, now = Date.now()): EmitResult {
  if (!e || typeof e !== 'object' || !(RULE_WHEN_KINDS as readonly string[]).includes(e.kind)) return { dropped: 'bad' };
  if ((e.depth ?? 0) > MAX_RULE_DEPTH) return { dropped: 'depth' };
  if (!listeners.size && !forwarder) return { delivered: 0 };
  if (e.id) {
    const key = e.kind + ':' + e.id, seen = recent.get(key);
    if (seen !== undefined && now - seen < DEDUPE_MS) return { dropped: 'duplicate' };
    recent.set(key, now);
    if (recent.size > 256) for (const [k, t] of recent) if (now - t >= DEDUPE_MS) recent.delete(k);
  }
  let n = 0;
  for (const fn of [...listeners]) { try { fn(e); n++; } catch (err) { console.warn('[rules] listener', err); } }
  if (forwarder) { try { forwarder(e); } catch (err) { console.warn('[rules] forward', err); } }
  return { delivered: n };
}

/** Tests only: forget every action, listener, forwarder and seen id. */
export function resetRuleRegistry() { actions.clear(); listeners.clear(); forwarder = null; recent.clear(); }

// ---------------------------------------------------------------- running a rule

export interface RuleRunOptions {
  now?: number;
  /** Runs a step nobody registered a handler for (the engine passes "run this Stream Deck action"). */
  fallback?: RuleActionHandler;
  /** Sleep for a step's delayMs (the engine's timer; the default really waits). */
  sleep?: (ms: number) => Promise<void>;
  /** Skip the delays (tests). */
  noDelay?: boolean;
}
export interface RuleRunReport { ran: number; failed: { action: string; error: string }[]; undo: RuleStep[]; truncated: boolean }

/** Run a rule's steps in order, at most MAX_RULE_CHAIN. A failing step is reported and the chain goes on. Returns the undo steps (newest last). */
export async function runRuleSteps(rule: StreamRule, event: RuleEvent, opt: RuleRunOptions = {}): Promise<RuleRunReport> {
  const rep: RuleRunReport = { ran: 0, failed: [], undo: [], truncated: rule.then.length > MAX_RULE_CHAIN };
  const depth = event.depth ?? 0;
  if (depth > MAX_RULE_DEPTH) return rep;
  const sleep = opt.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (const step of rule.then.slice(0, MAX_RULE_CHAIN)) {
    if (step.delayMs && !opt.noDelay) await sleep(step.delayMs);
    const h = getRuleAction(step.action)?.handler ?? opt.fallback;
    if (!h) { rep.failed.push({ action: step.action, error: 'No such action' }); continue; }
    try {
      const r = await h({ rule, event, step, params: expandParams(step.params, event), depth, test: !!event.test, now: opt.now ?? Date.now() });
      if (r && r.ok === false) rep.failed.push({ action: step.action, error: r.error ?? 'failed' });
      else { rep.ran++; if (r && r.undo) rep.undo.push(r.undo); }
    } catch (err) { rep.failed.push({ action: step.action, error: (err as Error).message || 'failed' }); }
  }
  return rep;
}

// ---------------------------------------------------------------- cooldown + queue

export type GateVerdict = 'run' | 'cooldown' | 'queued' | 'full';
/**
 * Per-rule cooldown and the gift-bomb queue, with an injectable clock. `offer` says what to do with an event for a rule;
 * `take` hands back the next queued event once the rule is free again. State is in memory only (a restart forgets cooldowns).
 */
export class RuleGate {
  private until = new Map<string, number>();
  private queues = new Map<string, RuleEvent[]>();
  /** The rule is busy until `until`; events that come meanwhile wait (rule.queue) or are dropped. */
  offer(rule: StreamRule, e: RuleEvent, now: number): GateVerdict {
    const busy = (this.until.get(rule.id) ?? 0) > now;
    if (!busy) { this.until.set(rule.id, now + Math.max(0, rule.cooldownSecs) * 1000); return 'run'; }
    const max = rule.queue?.max ?? 0;
    if (max <= 0) return 'cooldown';
    const q = this.queues.get(rule.id) ?? [];
    if (q.length >= max) return 'full';
    q.push(e); this.queues.set(rule.id, q);
    return 'queued';
  }
  /** The next waiting event if the rule is free (its cooldown is then started again), else null. */
  take(rule: StreamRule, now: number): RuleEvent | null {
    if ((this.until.get(rule.id) ?? 0) > now) return null;
    const e = this.queues.get(rule.id)?.shift() ?? null;
    if (e) this.until.set(rule.id, now + Math.max(rule.cooldownSecs * 1000, rule.queue?.gapMs ?? 0));
    return e;
  }
  /** When the rule can run again (epoch ms), 0 = now. */
  readyAt(ruleId: string) { return this.until.get(ruleId) ?? 0; }
  waiting(ruleId: string) { return this.queues.get(ruleId)?.length ?? 0; }
  /** Forget only the cooldown of a rule; the events waiting in its line stay (Try it must never drop a gift bomb's queue). */
  resetCooldown(ruleId: string) { this.until.delete(ruleId); }
  clear(ruleId?: string) { if (ruleId) { this.until.delete(ruleId); this.queues.delete(ruleId); } else { this.until.clear(); this.queues.clear(); } }
}
