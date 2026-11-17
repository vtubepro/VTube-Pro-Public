// The subathon timer (beta.13, research/SUPPORT_INTEGRATIONS.md E3): the PURE state machine the helper persists
// (server/goals.ts) and every page shows (the overlay is a pure view of it). No DOM, no file system, no network, no
// clock of its own: every function takes `now` (epoch ms), so tools/goals_unit.ts can drive hours in microseconds.
//
// State = { endsAt (ABSOLUTE epoch), paused, pausedRemaining, … , log[] }: a crash or a reload never changes the time
// left, because nothing counts down in a browser. Time rules (per sub tier, per gifted sub - counted per sub -, per 100
// bits, per 1 of money, per member, per 100 Kicks, follow / raid bonuses), a minimum to count, whole seconds with the
// fraction carried over, caps (a hard end time, a max total, per event), decay, multipliers (happy hour - scheduled or
// by a mod command -, an automatic hype multiplier, sleep mode), pause / resume, manual add / subtract, undo of the last
// N changes and a full audit log + "time added by" leaderboard.
import { fmtSpan, type Contribution } from './goals.ts';

export interface SubathonRules {
  /** seconds per sub: tier 1 / 2 / 3 */
  sub: [number, number, number];
  /** seconds per Prime sub */
  prime: number;
  /** gifted subs: × the same tier's time, PER gifted sub */
  giftMult: number;
  /** seconds per 1 of the display currency (tips, merch, Super Chats, wishlist gifts …) */
  perMoney: number;
  /** seconds per 100 bits */
  per100Bits: number;
  /** seconds per new / renewing member or patron */
  perMember: number;
  /** seconds per 100 Kicks */
  per100Kicks: number;
  /** bonuses (seconds): a follow, a raid, + per raiding viewer */
  follow: number;
  raid: number;
  raidPerViewer: number;
  /** money below this doesn't add time (display currency; 0 = any) */
  minMoney: number;
}
export interface SubathonCaps {
  /** never run past this moment (epoch ms; 0 = no limit) */
  maxEndAt: number;
  /** the timer's whole length (the start time + everything added) never exceeds this (ms; 0 = no limit) */
  maxTotalMs: number;
  /** one event adds at most this (ms; 0 = no limit) */
  perEventMs: number;
}
export interface SubathonDecay {
  on: boolean;
  /** after this much time was added by supporters (ms) … */
  afterMs: number;
  /** … the rate halves every this much more (ms) */
  halveEveryMs: number;
  /** but never below this fraction */
  floor: number;
}
export interface HappySlot { at: number; ms: number; mult: number }
export interface SubathonConfig {
  title: string;
  /** the timer's starting length (ms) */
  startMs: number;
  rules: SubathonRules;
  caps: SubathonCaps;
  decay: SubathonDecay;
  /** scheduled happy hours (epoch ms) */
  happy: HappySlot[];
  /** automatic hype multiplier: `events` supports within `windowMs` → × `mult` for `ms` */
  hype: { on: boolean; events: number; windowMs: number; mult: number; ms: number };
  /** sleep mode: reduced rates between `from` and `to` (minutes after local midnight) when `auto`, or switched on by hand */
  sleep: { auto: boolean; from: number; to: number; mult: number };
  /** while paused, supports still add time (to the frozen remaining time) */
  pauseCounts: boolean;
  /** what the timer shows on stream: time left, time running (uptime), or both */
  display: 'remaining' | 'uptime' | 'both';
}

export const DEFAULT_RULES: SubathonRules = { sub: [300, 600, 900], prime: 300, giftMult: 1, perMoney: 60, per100Bits: 60, perMember: 300, per100Kicks: 60, follow: 0, raid: 0, raidPerViewer: 0, minMoney: 1 };
export const DEFAULT_SUBATHON: SubathonConfig = {
  title: 'Subathon', startMs: 12 * 3_600_000, rules: DEFAULT_RULES, caps: { maxEndAt: 0, maxTotalMs: 0, perEventMs: 0 },
  decay: { on: false, afterMs: 24 * 3_600_000, halveEveryMs: 24 * 3_600_000, floor: 0.25 }, happy: [],
  hype: { on: true, events: 5, windowMs: 5 * 60_000, mult: 1.5, ms: 10 * 60_000 },
  sleep: { auto: false, from: 2 * 60, to: 10 * 60, mult: 0.5 }, pauseCounts: true, display: 'remaining',
};

const num = (v: unknown, lo: number, hi: number, d: number) => { const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const clean = (s: unknown, n: number) => String(s ?? '').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const DAY = 86_400_000, WEEK = 7 * DAY;

export function sanitizeSubathon(raw: unknown): SubathonConfig {
  const o = obj(raw), d = DEFAULT_SUBATHON;
  const r = obj(o.rules), dr = d.rules;
  const sub = Array.isArray(r.sub) ? r.sub : [];
  const rules: SubathonRules = {
    sub: [0, 1, 2].map((i) => Math.round(num(sub[i], 0, DAY / 1000, dr.sub[i]))) as [number, number, number],
    prime: Math.round(num(r.prime, 0, DAY / 1000, dr.prime)), giftMult: num(r.giftMult, 0, 10, dr.giftMult),
    perMoney: num(r.perMoney, 0, 86400, dr.perMoney), per100Bits: num(r.per100Bits, 0, 86400, dr.per100Bits), perMember: num(r.perMember, 0, 86400, dr.perMember),
    per100Kicks: num(r.per100Kicks, 0, 86400, dr.per100Kicks), follow: num(r.follow, 0, 86400, dr.follow), raid: num(r.raid, 0, 86400, dr.raid),
    raidPerViewer: num(r.raidPerViewer, 0, 3600, dr.raidPerViewer), minMoney: num(r.minMoney, 0, 1e6, dr.minMoney),
  };
  const c = obj(o.caps), de = obj(o.decay), hy = obj(o.hype), sl = obj(o.sleep);
  return {
    title: clean(o.title, 40) || d.title,
    startMs: Math.round(num(o.startMs, 60_000, 30 * DAY, d.startMs)),
    rules,
    caps: { maxEndAt: Math.round(num(c.maxEndAt, 0, 1e14, 0)), maxTotalMs: Math.round(num(c.maxTotalMs, 0, 365 * DAY, 0)), perEventMs: Math.round(num(c.perEventMs, 0, DAY, 0)) },
    decay: { on: de.on === true, afterMs: Math.round(num(de.afterMs, 0, 365 * DAY, d.decay.afterMs)), halveEveryMs: Math.round(num(de.halveEveryMs, 60_000, 365 * DAY, d.decay.halveEveryMs)), floor: num(de.floor, 0.01, 1, d.decay.floor) },
    happy: (Array.isArray(o.happy) ? o.happy : []).map((x) => { const h = obj(x); return { at: Math.round(num(h.at, 0, 1e14, 0)), ms: Math.round(num(h.ms, 60_000, DAY, 3_600_000)), mult: num(h.mult, 1, 10, 2) }; }).filter((h) => h.at > 0).slice(0, 24),
    hype: { on: hy.on !== false, events: Math.round(num(hy.events, 2, 500, d.hype.events)), windowMs: Math.round(num(hy.windowMs, 30_000, 3_600_000, d.hype.windowMs)), mult: num(hy.mult, 1, 10, d.hype.mult), ms: Math.round(num(hy.ms, 60_000, 6 * 3_600_000, d.hype.ms)) },
    sleep: { auto: sl.auto === true, from: Math.round(num(sl.from, 0, 1439, d.sleep.from)), to: Math.round(num(sl.to, 0, 1439, d.sleep.to)), mult: num(sl.mult, 0, 1, d.sleep.mult) },
    pauseCounts: o.pauseCounts !== false,
    display: o.display === 'uptime' || o.display === 'both' ? o.display : 'remaining',
  };
}

// ---------------------------------------------------------------- state
export type SubLogKind = 'start' | 'event' | 'adjust' | 'undo' | 'redo' | 'pause' | 'resume' | 'happy' | 'sleep' | 'end' | 'reopen';
/** What one support added to the stats (kept on its log line, so an undo takes it out again and a redo puts it back). */
export interface StatDelta { subs: number; gifted: number; bits: number; money: number; members: number; kicks: number; events: number; follows?: number; raids?: number }
export interface SubLog {
  seq: number;
  at: number;
  kind: SubLogKind;
  /** time actually applied (ms; negative = taken off) */
  ms: number;
  /** before caps / multipliers (events + adjustments) */
  raw?: number;
  mult?: number;
  /** why it was clipped ("max end time", "per-event cap" …) */
  capped?: string;
  label: string;
  /** supporter / mod / "studio" */
  who?: string;
  platform?: string;
  /** the source event (SupportEvent id) */
  evId?: string;
  undone?: boolean;
  /** what its undo really moved the clock by (ms, signed): the end never goes before now, so an undo with less time left
   *  than it added removes only what was left - and its redo puts back exactly that */
  undoneMs?: number;
  /** the credit its undo removed (ms): always the line's full amount (the board, the totals, the stats) */
  creditMs?: number;
  /** the stats this support added (events only) */
  stat?: StatDelta;
}
export interface SubBoardRow { name: string; platform: string; ms: number; n: number }
export interface SubathonState {
  /** saved-format version: 2 = undo lines carry creditMs (the credit / clock split), supports keep an effects ledger */
  v?: number;
  /** follow / raid lines that scrolled off the log, still counted (time + stats) */
  retired?: { ms: number; stat: StatDelta };
  id: string;
  startedAt: number;
  /** ABSOLUTE end (epoch ms) while running */
  endsAt: number;
  paused: boolean;
  /** frozen time left while paused (ms) */
  pausedRemaining: number;
  pausedAt: number;
  ended: boolean;
  endedAt: number;
  initialMs: number;
  /** net time added by supporters (after multipliers + caps) */
  eventMs: number;
  /** net manual adjustments (mods / studio / incentives) */
  adjustMs: number;
  /** the fraction of a second waiting to be added (0 ≤ carry < 1000) */
  carry: number;
  happy: { mult: number; until: number; by: string } | null;
  hype: { mult: number; until: number } | null;
  hypeAt: number[];
  sleep: boolean;
  stats: { subs: number; gifted: number; bits: number; money: number; members: number; kicks: number; events: number; follows: number; raids: number };
  board: Record<string, SubBoardRow>;
  log: SubLog[];
  seq: number;
  /** incentive milestones fired (incentive id → how many times) */
  miles: Record<string, number>;
}
export const SUB_LOG_KEEP = 1500;

export function startSubathon(cfg: SubathonConfig, now: number, id = `s${now.toString(36)}`): SubathonState {
  const st: SubathonState = {
    v: 2, id, startedAt: now, endsAt: now + cfg.startMs, paused: false, pausedRemaining: 0, pausedAt: 0, ended: false, endedAt: 0, initialMs: cfg.startMs,
    eventMs: 0, adjustMs: 0, carry: 0, happy: null, hype: null, hypeAt: [], sleep: false,
    stats: { subs: 0, gifted: 0, bits: 0, money: 0, members: 0, kicks: 0, events: 0, follows: 0, raids: 0 }, board: {}, log: [], seq: 0, miles: {},
  };
  if (cfg.caps.maxEndAt > now) st.endsAt = Math.min(st.endsAt, cfg.caps.maxEndAt);
  pushLog(st, { at: now, kind: 'start', ms: st.endsAt - now, label: `Started: ${fmtSpan(st.endsAt - now)}` });
  return st;
}

function pushLog(st: SubathonState, e: Omit<SubLog, 'seq'>): SubLog {
  const l: SubLog = { seq: ++st.seq, ...e };
  st.log.push(l);
  if (st.log.length > SUB_LOG_KEEP) {
    // follow / raid lines that scroll off keep counting in `retired` (they can no longer be undone; supports keep their
    // own record on their goal entry: the effects ledger)
    for (const o of st.log.splice(0, st.log.length - SUB_LOG_KEEP)) {
      if (o.kind !== 'event' || o.evId || o.undone) continue;
      const r = st.retired ?? (st.retired = { ms: 0, stat: { subs: 0, gifted: 0, bits: 0, money: 0, members: 0, kicks: 0, events: 0, follows: 0, raids: 0 } });
      r.ms += o.ms;
      if (o.stat) for (const k of Object.keys(r.stat) as (keyof StatDelta)[]) (r.stat[k] as number) += (o.stat[k] as number | undefined) ?? 0;
    }
  }
  return l;
}

/** Time left (ms). */
export function remainingMs(st: SubathonState, now: number): number {
  if (st.ended) return 0;
  return st.paused ? Math.max(0, st.pausedRemaining) : Math.max(0, st.endsAt - now);
}
/** How long it has run (ms): start → now (or the end). */
export const uptimeMs = (st: SubathonState, now: number) => Math.max(0, (st.ended ? st.endedAt : now) - st.startedAt);
/** The timer's whole length so far: the start time + everything added (ms). */
export const totalLengthMs = (st: SubathonState) => st.initialMs + st.eventMs + st.adjustMs;

/** Local minutes after midnight (sleep windows use the helper PC's own clock = the streamer's). */
export const minuteOfDay = (now: number) => { const d = new Date(now); return d.getHours() * 60 + d.getMinutes(); };
const inWindow = (m: number, from: number, to: number) => (from <= to ? m >= from && m < to : m >= from || m < to);

export interface MultParts { happy: number; hype: number; sleep: number; decay: number; total: number }
/** The multiplier on support-added time right now. */
export function multiplier(cfg: SubathonConfig, st: SubathonState, now: number): MultParts {
  let happy = st.happy && st.happy.until > now ? st.happy.mult : 1;
  for (const h of cfg.happy) if (now >= h.at && now < h.at + h.ms) happy = Math.max(happy, h.mult);
  const hype = cfg.hype.on && st.hype && st.hype.until > now ? st.hype.mult : 1;
  const sleep = st.sleep || (cfg.sleep.auto && inWindow(minuteOfDay(now), cfg.sleep.from, cfg.sleep.to)) ? cfg.sleep.mult : 1;
  const over = st.eventMs - cfg.decay.afterMs;
  const decay = cfg.decay.on && over > 0 ? Math.max(cfg.decay.floor, Math.pow(0.5, over / cfg.decay.halveEveryMs)) : 1;
  return { happy, hype, sleep, decay, total: happy * hype * sleep * decay };
}

/** The base time (ms, before multipliers / caps) a support adds. */
export function baseTimeFor(cfg: SubathonConfig, kind: string, c: Contribution): number {
  const r = cfg.rules;
  const tierS = (t: number) => (t === 0 ? r.prime : r.sub[Math.max(0, Math.min(2, t - 1))]);
  let s = 0;
  if (c.subs) s += c.subs * tierS(c.tier);
  if (c.gifted) s += c.gifted * tierS(c.tier || 1) * r.giftMult;
  if (c.members) s += c.members * r.perMember;
  if (c.bits) s += (c.bits / 100) * r.per100Bits;
  else if (c.kicks) s += (c.kicks / 100) * r.per100Kicks;
  else if (c.money > 0 && !c.subs && !c.gifted && !c.members && kind !== 'redemption') {
    if (c.money + 1e-9 >= r.minMoney) s += c.money * r.perMoney;
  }
  return s * 1000;
}

export interface AddMeta { label: string; who?: string; platform?: string; evId?: string; kind?: 'event' | 'adjust'; stat?: StatDelta }
export interface AddResult { ms: number; raw: number; mult: number; capped?: string; log: SubLog | null }

/** Apply caps to an amount about to be added (positive) - pure: how much of `ms` fits. */
function capFor(cfg: SubathonConfig, st: SubathonState, ms: number, now: number, perEvent: boolean): { ms: number; why?: string } {
  if (ms <= 0) return { ms };
  let out = ms, why: string | undefined;
  if (perEvent && cfg.caps.perEventMs > 0 && out > cfg.caps.perEventMs) { out = cfg.caps.perEventMs; why = 'per-event cap'; }
  if (cfg.caps.maxTotalMs > 0) { const room = cfg.caps.maxTotalMs - totalLengthMs(st); if (out > room) { out = Math.max(0, room); why = 'max length'; } }
  if (cfg.caps.maxEndAt > 0) {
    const end = st.paused ? now + st.pausedRemaining : st.endsAt;
    const room = cfg.caps.maxEndAt - end;
    if (out > room) { out = Math.max(0, room); why = 'max end time'; }
  }
  return { ms: out, why };
}

/** Move the end by `ms` (never before now / below zero left; taking time off a clock that already ran out moves
 *  nothing); returns how far it really moved. */
function moveEnd(st: SubathonState, ms: number, now: number): number {
  if (st.paused) { const b = st.pausedRemaining; st.pausedRemaining = Math.max(0, b + ms); return st.pausedRemaining - b; }
  const b = st.endsAt;
  st.endsAt = ms < 0 ? Math.max(Math.min(b, now), b + ms) : Math.max(now, b + ms);
  return st.endsAt - b;
}

/** A support adds time: multipliers, the carried fraction, caps. Ended / paused-without-pauseCounts = nothing added. */
export function addSupportTime(cfg: SubathonConfig, st: SubathonState, baseMs: number, meta: AddMeta, now: number): AddResult {
  if (st.ended || baseMs <= 0) return { ms: 0, raw: baseMs, mult: 1, log: null };
  if (st.paused && !cfg.pauseCounts) {
    // no time while paused, but the support happened: a 0-second line carrying its stats (undoable like any other)
    const log = meta.stat ? pushLog(st, { at: now, kind: 'event', ms: 0, raw: Math.round(baseMs), capped: 'paused', label: meta.label, who: meta.who, platform: meta.platform, evId: meta.evId, stat: meta.stat }) : null;
    return { ms: 0, raw: baseMs, mult: 1, capped: 'paused', log };
  }
  const m = multiplier(cfg, st, now).total;
  const exact = baseMs * m + st.carry;
  let whole = Math.floor(exact / 1000) * 1000;
  st.carry = exact - whole;
  const c = capFor(cfg, st, whole, now, true);
  if (c.ms < whole) st.carry = 0;              // (a capped add drops the fraction too)
  whole = c.ms;
  moveEnd(st, whole, now);
  st.eventMs += whole;
  const log = pushLog(st, { at: now, kind: 'event', ms: whole, raw: Math.round(baseMs), mult: Math.round(m * 1000) / 1000, ...(c.why ? { capped: c.why } : {}), label: meta.label, who: meta.who, platform: meta.platform, evId: meta.evId, ...(meta.stat ? { stat: meta.stat } : {}) });
  if (meta.who && whole > 0) {
    const k = `${meta.platform ?? ''}:${meta.who.toLowerCase()}`;
    const row = st.board[k] ?? (st.board[k] = { name: meta.who, platform: meta.platform ?? '', ms: 0, n: 0 });
    row.ms += whole; row.n++;
  }
  return { ms: whole, raw: baseMs, mult: m, capped: c.why, log };
}

/** A manual change (mods' !addtime / !subtime, the studio's buttons, incentives): no multiplier; caps still hold. */
export function adjustTime(cfg: SubathonConfig, st: SubathonState, ms: number, meta: AddMeta, now: number): AddResult {
  if (st.ended || !ms) return { ms: 0, raw: ms, mult: 1, log: null };
  let v = Math.round(ms);
  let why: string | undefined;
  if (v > 0) { const c = capFor(cfg, st, v, now, false); v = c.ms; why = c.why; }
  else v = -Math.min(-v, remainingMs(st, now));     // never below zero time left
  moveEnd(st, v, now);
  st.adjustMs += v;
  const log = pushLog(st, { at: now, kind: 'adjust', ms: v, raw: Math.round(ms), ...(why ? { capped: why } : {}), label: meta.label, who: meta.who, platform: meta.platform, evId: meta.evId });
  return { ms: v, raw: ms, mult: 1, capped: why, log };
}

/** Undo (sign -1) / redo (+1) one change. Two separate things, with ONE rule each:
 *   - the CREDIT always moves by the line's full amount, in every state (running, paused, ended), and is never refused:
 *     "time added by", the added-time totals (decay, the max length), the supporter count and the stats - a voided gift
 *     leaves all of them, a redo restores all of it;
 *   - the CLOCK moves only while the run has not ended: running = the end, never before now (undoneMs records what
 *     really moved); paused = the frozen time left, never below 0; ended = nothing moves (undoneMs 0). A redo puts back
 *     what its undo took, within the max-length / max-end caps. */
function shift(st: SubathonState, l: SubLog, sign: 1 | -1, now: number, cfg?: SubathonConfig) {
  let move = sign < 0 ? -l.ms : -(l.undoneMs ?? -l.ms);
  let moved = 0;
  if (!st.ended) {
    if (move > 0 && cfg) move = capFor(cfg, st, move, now, false).ms;
    moved = moveEnd(st, move, now);
  }
  if (sign < 0) l.undoneMs = moved; else delete l.undoneMs;
  const credit = sign < 0 ? -l.ms : (l.creditMs ?? l.ms);
  if (sign < 0) l.creditMs = l.ms; else delete l.creditMs;
  if (l.kind === 'event') {
    st.eventMs += credit;
    if (l.who && l.ms > 0) {
      const k = `${l.platform ?? ''}:${l.who.toLowerCase()}`;
      const r = st.board[k] ?? (sign > 0 ? (st.board[k] = { name: l.who, platform: l.platform ?? '', ms: 0, n: 0 }) : undefined);
      if (r) { r.ms += credit; r.n = Math.max(0, r.n + sign); if (r.ms <= 0 || r.n <= 0) delete st.board[k]; }
    }
    if (l.stat) applyStat(st, l.stat, sign);
  } else st.adjustMs += credit;
}
/** Can this log line be undone / redone: a time change, or a support that only added stats (0 whole seconds). */
const undoable = (l: SubLog) => (l.kind === 'event' || l.kind === 'adjust') && (!!l.ms || (l.kind === 'event' && !!l.stat));
const endedNote = (st: SubathonState) => (st.ended ? ' (credit only: the timer already ended)' : '');
/** Undo the last N time changes that are not undone yet (events and adjustments): their credit always, their time
 *  while the run is on. */
export function undoLast(st: SubathonState, n: number, by: string, now: number, cfg?: SubathonConfig): SubLog[] {
  const out: SubLog[] = [];
  let total = 0;
  for (let i = st.log.length - 1; i >= 0 && out.length < n; i--) {
    const l = st.log[i];
    if (l.undone || (l.kind !== 'event' && l.kind !== 'adjust') || !l.ms) continue;   // (!undotime: time changes only)
    l.undone = true;
    out.push(l);
    shift(st, l, -1, now, cfg);
    total += l.undoneMs ?? 0;
  }
  if (out.length) pushLog(st, { at: now, kind: 'undo', ms: total, label: `Undid ${out.length} change${out.length === 1 ? '' : 's'}${endedNote(st)}`, who: by });
  return out;
}
/** Undo one log entry by its seq (the audit log's Undo, a voided event). null = no such undoable line / already undone. */
export function undoSeq(st: SubathonState, seq: number, by: string, now: number, cfg?: SubathonConfig): SubLog | null {
  const l = st.log.find((x) => x.seq === seq);
  if (!l || l.undone || !undoable(l)) return null;
  l.undone = true;
  shift(st, l, -1, now, cfg);
  pushLog(st, { at: now, kind: 'undo', ms: l.undoneMs ?? 0, label: `Undid: ${l.label}${endedNote(st)}`, who: by });
  return l;
}
/** Redo an undone entry: its full credit always; on the clock what its undo took (within the caps) while the run is on. */
export function redoSeq(st: SubathonState, seq: number, by: string, now: number, cfg?: SubathonConfig): SubLog | null {
  const l = st.log.find((x) => x.seq === seq);
  if (!l || !l.undone || !undoable(l)) return null;
  const end0 = st.paused ? st.pausedRemaining : st.endsAt;
  l.undone = false;
  shift(st, l, 1, now, cfg);
  pushLog(st, { at: now, kind: 'redo', ms: (st.paused ? st.pausedRemaining : st.endsAt) - end0, label: `Redid: ${l.label}${endedNote(st)}`, who: by });
  return l;
}
/** Saved logs from before the credit / clock split (no `v`): an undone line without creditMs is treated as a full-credit
 *  removal (what every build that left the lane did); from now on `v: 2` marks the format, so a later change can migrate
 *  without guessing. */
export function migrateUndoLog(st: SubathonState) {
  if ((st.v ?? 1) >= 2) return;
  for (const l of st.log) if (l.undone && l.creditMs === undefined) l.creditMs = l.ms;
  st.v = 2;
}

export function pause(st: SubathonState, by: string, now: number): boolean {
  if (st.paused || st.ended) return false;
  st.pausedRemaining = Math.max(0, st.endsAt - now);
  st.paused = true; st.pausedAt = now;
  pushLog(st, { at: now, kind: 'pause', ms: 0, label: 'Paused', who: by });
  return true;
}
export function resume(cfg: SubathonConfig, st: SubathonState, by: string, now: number): boolean {
  if (!st.paused || st.ended) return false;
  st.paused = false;
  st.endsAt = now + st.pausedRemaining;
  if (cfg.caps.maxEndAt > 0 && st.endsAt > cfg.caps.maxEndAt) st.endsAt = Math.max(now, cfg.caps.maxEndAt);
  pushLog(st, { at: now, kind: 'resume', ms: 0, label: `Resumed (${fmtSpan(st.endsAt - now)} left)`, who: by });
  return true;
}
export function setHappy(st: SubathonState, mult: number, ms: number, by: string, now: number) {
  st.happy = mult > 1 && ms > 0 ? { mult, until: now + ms, by } : null;
  pushLog(st, { at: now, kind: 'happy', ms: 0, label: st.happy ? `Happy hour ${mult}× for ${fmtSpan(ms)}` : 'Happy hour off', who: by });
}
export function setSleep(st: SubathonState, on: boolean | 'toggle', by: string, now: number) {
  st.sleep = on === 'toggle' ? !st.sleep : on;
  pushLog(st, { at: now, kind: 'sleep', ms: 0, label: st.sleep ? 'Sleep mode on' : 'Sleep mode off', who: by });
}
/** A qualifying support for the hype multiplier: true = hype started (or extended) now. */
export function noteHype(cfg: SubathonConfig, st: SubathonState, now: number): boolean {
  if (!cfg.hype.on) return false;
  st.hypeAt = st.hypeAt.filter((t) => now - t < cfg.hype.windowMs);
  st.hypeAt.push(now);
  if (st.hypeAt.length > 500) st.hypeAt.splice(0, st.hypeAt.length - 500);
  const active = !!st.hype && st.hype.until > now;
  if (st.hypeAt.length >= cfg.hype.events) {
    st.hype = { mult: cfg.hype.mult, until: now + cfg.hype.ms };
    return !active;
  }
  return false;
}
/** Advance: the timer ran out → ended (true once). */
export function tick(st: SubathonState, now: number): boolean {
  if (st.ended || st.paused || now < st.endsAt) return false;
  st.ended = true; st.endedAt = st.endsAt;
  pushLog(st, { at: now, kind: 'end', ms: 0, label: `Ended after ${fmtSpan(st.endedAt - st.startedAt)}` });
  return true;
}
/** Bring an ended subathon back (the streamer wants to keep going): `ms` more on the clock. */
export function reopen(st: SubathonState, ms: number, by: string, now: number) {
  st.ended = false; st.endedAt = 0; st.paused = false; st.endsAt = now + Math.max(60_000, ms);
  pushLog(st, { at: now, kind: 'reopen', ms: 0, label: `Reopened with ${fmtSpan(st.endsAt - now)}`, who: by });
}

export function leaderboard(st: SubathonState, n = 5): SubBoardRow[] {
  return Object.values(st.board).filter((r) => r.ms > 0).sort((a, b) => b.ms - a.ms || a.name.localeCompare(b.name)).slice(0, n);
}

/** What one support adds to the stats. */
export function statOf(c: Contribution, kind: string): StatDelta {
  return { subs: c.subs, gifted: c.gifted, bits: c.bits, money: c.money > 0 && kind !== 'redemption' ? c.money : 0, members: c.members, kicks: c.kicks, events: 1 };
}
export function applyStat(st: SubathonState, d: StatDelta, sign: 1 | -1 = 1) {
  const s = st.stats;
  s.subs = Math.max(0, s.subs + sign * d.subs); s.gifted = Math.max(0, s.gifted + sign * d.gifted); s.bits = Math.max(0, s.bits + sign * d.bits);
  s.members = Math.max(0, s.members + sign * d.members); s.kicks = Math.max(0, s.kicks + sign * d.kicks); s.events = Math.max(0, s.events + sign * d.events);
  s.money = Math.max(0, Math.round((s.money + sign * d.money) * 100) / 100);
  if (d.follows) s.follows = Math.max(0, s.follows + sign * d.follows);
  if (d.raids) s.raids = Math.max(0, s.raids + sign * d.raids);
}
/** Count one support in the stats (after it was accepted, whether or not time was added). */
export function countStats(st: SubathonState, c: Contribution, kind: string): StatDelta {
  const d = statOf(c, kind);
  applyStat(st, d, 1);
  return d;
}

export interface SubSummary {
  title: string; startedAt: number; endedAt: number; lengthMs: number; addedMs: number;
  stats: SubathonState['stats']; top: SubBoardRow[]; biggest: { label: string; ms: number } | null;
}
export function summary(cfg: SubathonConfig, st: SubathonState, now: number): SubSummary {
  let biggest: SubLog | null = null;
  for (const l of st.log) if (l.kind === 'event' && !l.undone && (!biggest || l.ms > biggest.ms)) biggest = l;
  const end = st.ended ? st.endedAt : now;
  return { title: cfg.title, startedAt: st.startedAt, endedAt: end, lengthMs: Math.max(0, end - st.startedAt), addedMs: st.eventMs + st.adjustMs, stats: { ...st.stats }, top: leaderboard(st, 5), biggest: biggest ? { label: biggest.label, ms: biggest.ms } : null };
}

/** The "how to add time" lines the overlay rotates through. */
export function rulesText(cfg: SubathonConfig, cur = 'USD', sym = '$'): string[] {
  const r = cfg.rules, out: string[] = [];
  const t = (s: number) => fmtSpan(s * 1000).replace(' 0 s', '');
  if (r.sub[0]) out.push(r.sub[0] === r.sub[1] && r.sub[1] === r.sub[2] ? `Sub = +${t(r.sub[0])}` : `Sub T1 +${t(r.sub[0])} · T2 +${t(r.sub[1])} · T3 +${t(r.sub[2])}`);
  if (r.giftMult && r.sub[0]) out.push(`Each gifted sub = +${t(r.sub[0] * r.giftMult)}`);
  if (r.perMoney) out.push(`${sym}1 = +${t(r.perMoney)}${r.minMoney > 1 ? ` (${sym}${r.minMoney}+)` : ''}`);
  if (r.per100Bits) out.push(`100 bits = +${t(r.per100Bits)}`);
  if (r.perMember) out.push(`New member = +${t(r.perMember)}`);
  if (r.per100Kicks) out.push(`100 Kicks = +${t(r.per100Kicks)}`);
  if (r.raid || r.raidPerViewer) out.push(`Raid = +${t(r.raid)}${r.raidPerViewer ? ` + ${t(r.raidPerViewer)}/viewer` : ''}`);
  if (r.follow) out.push(`Follow = +${t(r.follow)}`);
  void cur;
  return out;
}

/** "Subathon 12h start, 5/10/15 min per sub tier" (the panel's template). */
export function subathonTemplate(id: 'classic' | 'chill' | 'weekend'): SubathonConfig {
  const base = sanitizeSubathon({});
  if (id === 'chill') return sanitizeSubathon({ ...base, title: 'Subathon', startMs: 4 * 3_600_000, rules: { ...base.rules, sub: [120, 240, 360], prime: 120, perMoney: 30, per100Bits: 30, perMember: 120, per100Kicks: 30 } });
  if (id === 'weekend') return sanitizeSubathon({ ...base, title: 'Weekend subathon', startMs: 24 * 3_600_000, decay: { on: true, afterMs: 24 * 3_600_000, halveEveryMs: 24 * 3_600_000, floor: 0.25 }, caps: { maxEndAt: 0, maxTotalMs: 72 * 3_600_000, perEventMs: 0 }, sleep: { auto: true, from: 180, to: 600, mult: 0.5 } });
  return base;
}
export const WEEK_MS = WEEK;

// ---------------------------------------------------------------- the effects ledger (a support's own record)
/** Exactly what one support did to a subathon, kept ON the support's goal-log entry (server/goalsEngine.ts, persisted):
 *  undo reverses exactly this and redo re-applies exactly this - never a guess, even after the timer ended, after "Keep
 *  going", after its timer line scrolled off the log, or after a restart. No effect recorded (it arrived after the end,
 *  in test mode, before the subathon started) = the subathon is never touched by its undo / redo. */
export interface SubEffect {
  /** the subathon it counted in (a later subathon is never touched) */
  sid: string;
  /** its timer line (for the audit log; may have scrolled off) */
  line?: number;
  /** the credit: time it added (ms, after multipliers + caps) */
  ms: number;
  /** what it added to the stats */
  stat: StatDelta;
  who?: string;
  platform?: string;
  /** undone right now */
  off?: boolean;
  /** what its undo really moved the clock by (ms, signed; 0 when the run had ended) */
  clockMs?: number;
  /** counted by a build without the ledger and its timer line was already gone at the upgrade: what it did to the timer
   *  is unknown - its undo / redo move the goal only (the panel says so), never a guess */
  unknown?: true;
}
function effectCredit(st: SubathonState, fx: SubEffect, sign: 1 | -1) {
  st.eventMs += sign * fx.ms;
  if (fx.who && fx.ms > 0) {
    const k = `${fx.platform ?? ''}:${fx.who.toLowerCase()}`;
    const r = st.board[k] ?? (sign > 0 ? (st.board[k] = { name: fx.who, platform: fx.platform ?? '', ms: 0, n: 0 }) : undefined);
    if (r) { r.ms += sign * fx.ms; r.n = Math.max(0, r.n + sign); if (r.ms <= 0 || r.n <= 0) delete st.board[k]; }
  }
  applyStat(st, fx.stat, sign);
}
/** Undo one support's recorded effect: its full credit always; its time on the clock while the run is on. */
export function effectUndo(st: SubathonState, fx: SubEffect, by: string, now: number, label: string): boolean {
  if (fx.off || fx.sid !== st.id || fx.unknown) return false;
  fx.off = true;
  const moved = st.ended || !fx.ms ? 0 : moveEnd(st, -fx.ms, now);
  fx.clockMs = moved;
  effectCredit(st, fx, -1);
  const l = fx.line ? st.log.find((x) => x.seq === fx.line) : undefined;
  if (l) { l.undone = true; l.undoneMs = moved; l.creditMs = l.ms; }
  pushLog(st, { at: now, kind: 'undo', ms: moved, label: `Undid: ${label}${st.ended ? ' (credit only: the timer already ended)' : ''}`, who: by });
  return true;
}
/** Redo one support's recorded effect: its full credit always; on the clock what its undo took (within the caps). */
export function effectRedo(st: SubathonState, fx: SubEffect, by: string, now: number, label: string, cfg?: SubathonConfig): boolean {
  if (!fx.off || fx.sid !== st.id || fx.unknown) return false;
  fx.off = false;
  let move = -(fx.clockMs ?? -fx.ms), moved = 0;
  if (!st.ended && move) { if (move > 0 && cfg) move = capFor(cfg, st, move, now, false).ms; moved = moveEnd(st, move, now); }
  delete fx.clockMs;
  effectCredit(st, fx, 1);
  const l = fx.line ? st.log.find((x) => x.seq === fx.line) : undefined;
  if (l) { l.undone = false; delete l.undoneMs; delete l.creditMs; }
  pushLog(st, { at: now, kind: 'redo', ms: moved, label: `Redid: ${label}${st.ended ? ' (credit only: the timer already ended)' : ''}`, who: by });
  return true;
}
/** The invariant (tests): the stats + the support credit = the active effects + the active non-support lines. */
export function ledgerTotals(st: SubathonState, effects: SubEffect[]): { stats: StatDelta; eventMs: number; unknown: number } {
  const z: StatDelta = { subs: 0, gifted: 0, bits: 0, money: 0, members: 0, kicks: 0, events: 0, follows: 0, raids: 0 };
  let ms = 0;
  const add = (d: StatDelta) => { for (const k of Object.keys(z) as (keyof StatDelta)[]) (z[k] as number) += (d[k] as number | undefined) ?? 0; };
  for (const fx of effects) if (fx.sid === st.id && !fx.off && !fx.unknown) { add(fx.stat); ms += fx.ms; }
  for (const l of st.log) if (l.kind === 'event' && !l.evId && !l.undone) { if (l.stat) add(l.stat); ms += l.ms; }
  if (st.retired) { add(st.retired.stat); ms += st.retired.ms; }
  z.money = Math.round(z.money * 100) / 100;
  return { stats: z, eventMs: ms, unknown: effects.filter((fx) => fx.sid === st.id && fx.unknown).length };
}
