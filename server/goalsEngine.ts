// The goals + subathon ENGINE (beta.13): persisted in the helper, crash-proof, the same on every page. No Express, no
// bus, no fixed paths: server/goals.ts wires it (routes, the chat hub, the {type:'support'} tap, the Stream Deck), and
// tools/goals_unit.ts drives it with a temp folder + a fake clock (crash / restart included).
//
// Files (all local, the streamer's own stream data):
//   <config>/goals.json        GoalsConfig: goals + stretch goals, the subathon's rules, incentives, wheel, look, mod commands
//   <cache>/goals/events.jsonl the EVENT LOG, append-only: every accepted support event (+ void / unvoid lines). A goal's
//                              value is a sum over it, so it is always recomputable and a mis-counted event can be undone.
//   <cache>/goals/state.json   the subathon (absolute end time, pause, log, leaderboard), goal adjustments (audit log),
//                              celebrated levels, the last log seq applied. Events in the log past that seq (a crash between
//                              the log line and the state write) are applied once, silently, at start.
// Test mode: a SANDBOX copy (starts from the real values / timer) fed only by test events; the real state keeps counting
// real events underneath and the sandbox is thrown away when test mode ends. Test events never touch the real timer.
import fs from 'node:fs';
import path from 'node:path';
import type { ChatEvent } from '../shared/chat.ts';
import { SUPPORT_KINDS, type SupportEvent } from '../shared/support.ts';
import {
  contributionOf, currentTarget, fillText, fmtMetric, fmtMoney, fmtSpan, goalFromTemplate, goalLevels, goalValueOf, INCENTIVE_PRESETS, isMod, levelsReached, mayRun,
  parseDuration, parseModCommand, sanitizeGoal, sanitizeIncentive, sanitizeWheel, supportFires, supportOfChat, SupportDeduper, wheelPick, DEFAULT_WHEEL,
  type Contribution, type GoalAction, type GoalDef, type IncAction, type Incentive, type ModCommandsCfg, type SoundCue, type SupportOrigin, type WheelSlot,
} from '../shared/goals.ts';
import {
  addSupportTime, adjustTime, baseTimeFor, countStats, leaderboard, multiplier, noteHype, pause, remainingMs, reopen, resume, rulesText, sanitizeSubathon, setHappy, setSleep,
  startSubathon, summary, tick as subTick, undoSeq, redoSeq, applyStat, migrateUndoLog, effectUndo, effectRedo, ledgerTotals, DEFAULT_SUBATHON,
  type SubEffect, type StatDelta, type SubathonConfig, type SubathonState, type SubSummary, type SubLog,
} from '../shared/subathon.ts';
import { DEFAULT_SHOW, sanitizeShow, type GoalFx, type GoalLive, type GoalsShow, type GoalsView, type SubLive, type WheelSpin } from '../shared/goalsView.ts';

export interface GoalsConfig {
  v: 1;
  /** the display currency (money goals, $ per minute) */
  currency: string;
  goals: GoalDef[];
  subathon: SubathonConfig;
  incentives: Incentive[];
  wheel: WheelSlot[];
  show: GoalsShow;
  mods: ModCommandsCfg;
  /** the sound when a goal / stretch goal is reached */
  celebrate: SoundCue | 'none';
  /** "every stream" goals start over after this many hours without support or a stream start (0 = only OBS / by hand) */
  streamGapH: number;
}
export const DEFAULT_CONFIG = (): GoalsConfig => ({
  v: 1, currency: 'USD', goals: [], subathon: sanitizeSubathon({}), incentives: [], wheel: DEFAULT_WHEEL.map((s) => ({ ...s })), show: { ...DEFAULT_SHOW },
  mods: { on: true, off: [] }, celebrate: 'fanfare', streamGapH: 6,
});
const SOUNDS = new Set(['fanfare', 'horn', 'siren', 'slap', 'none']);
export function sanitizeConfig(raw: unknown, now = Date.now()): GoalsConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_CONFIG();
  const goals = (Array.isArray(o.goals) ? o.goals : []).map((g) => sanitizeGoal(g, now)).filter((g): g is GoalDef => typeof g !== 'string').slice(0, 8);
  const ids = new Set<string>();
  for (const g of goals) { while (ids.has(g.id)) g.id = `${g.id.slice(0, 26)}x${ids.size}`; ids.add(g.id); }
  const incentives = (Array.isArray(o.incentives) ? o.incentives : []).map(sanitizeIncentive).filter((i): i is Incentive => typeof i !== 'string').slice(0, 24);
  const m = (o.mods && typeof o.mods === 'object' ? o.mods : {}) as Record<string, unknown>;
  return {
    v: 1, currency: typeof o.currency === 'string' && /^[A-Z]{3}$/.test(o.currency) ? o.currency : d.currency, goals,
    subathon: sanitizeSubathon(o.subathon ?? {}), incentives, wheel: sanitizeWheel(o.wheel ?? d.wheel), show: sanitizeShow(o.show),
    mods: { on: m.on !== false, off: Array.isArray(m.off) ? m.off.map(String).filter((x) => /^[a-z]{2,16}$/.test(x)).slice(0, 12) : [] },
    celebrate: SOUNDS.has(String(o.celebrate)) ? o.celebrate as GoalsConfig['celebrate'] : d.celebrate,
    streamGapH: typeof o.streamGapH === 'number' && Number.isFinite(o.streamGapH) ? Math.min(72, Math.max(0, o.streamGapH)) : d.streamGapH,
  };
}

/** A counted support. `fx` = its effects ledger on the subathon (shared/subathon.ts SubEffect): what undo / redo reverse. */
interface Entry { seq: number; at: number; o: SupportOrigin; ev: SupportEvent; c: Contribution; void?: boolean; fx?: SubEffect }
export interface GoalAdjust { seq: number; at: number; goalId: string; delta: number; by: string; note: string; void?: boolean }
interface Book {
  test: boolean;
  entries: Entry[];
  adjust: GoalAdjust[];
  /** levels already celebrated per goal (never twice) */
  fired: Record<string, number>;
  /** hidden stretch goals unlocked per goal */
  unlocked: Record<string, number>;
  sub: SubathonState | null;
  miles: Record<string, number>;
  fx: GoalFx[];
  wheel: { spin: WheelSpin | null; queue: WheelSpin[] };
  values: Map<string, number> | null;
  /** stream start for milestones outside a subathon */
  streamAt: number;
  /** test mode: copies of the real supports' ledgers (the preview timer started from the real one; never undone here) */
  inherited?: SubEffect[];
}
interface Persist {
  v: 1; seq: number; fired: Record<string, number>; unlocked: Record<string, number>; adjust: GoalAdjust[]; sub: SubathonState | null; history: SubSummary[];
  lastEventAt: number; streamAt: number; miles: Record<string, number>; legacy: { on: boolean; target: number; label: string } | null;
  /** 1 = every support has its effects ledger (the one-time migration from builds without it ran and was written) */
  ledgerV?: number;
}

export interface LegacyGoal { on: boolean; target: number; label: string; since: number }
export interface EngineDeps {
  configFile: string;
  dir: string;
  /** a server broadcast: {type:'goals', s} and {type:'showsound', id, s} */
  broadcast: (m: Record<string, unknown>) => void;
  /** run a Stream Deck action (room cue, lighting state, club / lounge moment …) */
  runDeck: (action: string, params: Record<string, unknown>) => { ok: boolean; error?: string };
  now?: () => number;
  random?: () => number;
  /** the old single chat goal (cache/scene.json chat.goal) + the session totals' start, for the migration */
  legacy?: () => LegacyGoal | null;
  /** chat finance lines since `since` (the session log), to seed the migrated goal */
  chatSince?: (since: number) => ChatEvent[];
  log?: (...a: unknown[]) => void;
}

const WHEEL_SPIN_MS = 6500, WHEEL_SHOW_MS = 4500;
const FX_KEEP_MS = 30_000;
const ADJUST_KEEP = 2000;

export class GoalsEngine {
  cfg: GoalsConfig;
  private real: Book;
  private sandbox: Book | null = null;
  private dedupe = new SupportDeduper();
  private seen = new Set<string>();          // raids / follows / commands already handled (ids)
  private seq = 0;
  private history: SubSummary[] = [];
  private lastEventAt = 0;
  private legacySeen: { on: boolean; target: number; label: string } | null = null;
  private saveT: NodeJS.Timeout | null = null;
  private pushT: NodeJS.Timeout | null = null;
  private rev = 0;
  private cooldown = new Map<string, number>();
  private happyFx = new Set<string>();
  private logFile: string;
  private stateFile: string;
  private readonly now: () => number;
  private readonly rnd: () => number;
  private readonly say: (...a: unknown[]) => void;
  /** pushes sent (tests) */
  pushes = 0;

  constructor(private deps: EngineDeps) {
    this.now = deps.now ?? Date.now;
    this.rnd = deps.random ?? Math.random;
    this.say = deps.log ?? ((...a) => console.log('[goals]', ...a));
    this.logFile = path.join(deps.dir, 'events.jsonl');
    this.stateFile = path.join(deps.dir, 'state.json');
    const t = this.now();
    const hadConfig = fs.existsSync(deps.configFile);
    this.cfg = hadConfig ? sanitizeConfig(readJson(deps.configFile, {}), t) : DEFAULT_CONFIG();
    this.real = emptyBook(false, t);
    const st = readJson<Partial<Persist>>(this.stateFile, {});
    this.real.fired = obj(st.fired) as Record<string, number>;
    this.real.unlocked = obj(st.unlocked) as Record<string, number>;
    this.real.adjust = Array.isArray(st.adjust) ? st.adjust.slice(-ADJUST_KEEP) : [];
    this.real.sub = st.sub && typeof st.sub === 'object' && typeof st.sub.endsAt === 'number' ? st.sub as SubathonState : null;
    if (this.real.sub) migrateUndoLog(this.real.sub);
    this.real.miles = obj(st.miles) as Record<string, number>;
    this.real.streamAt = Number(st.streamAt) || t;
    this.history = Array.isArray(st.history) ? st.history.slice(-10) : [];
    this.lastEventAt = Number(st.lastEventAt) || 0;
    this.legacySeen = st.legacy ?? null;
    const applied = Number(st.seq) || 0;
    // the event log: every entry back into memory; entries the saved state never saw → applied once, silently
    const late: Entry[] = [];
    for (const line of readLines(this.logFile)) {
      let x: Record<string, unknown>;
      try { x = JSON.parse(line); } catch { continue; }
      const seq = Number(x.seq) || 0;
      if (seq > this.seq) this.seq = seq;
      if (x.void !== undefined && typeof x.ref === 'number') { const e = this.real.entries.find((y) => y.seq === x.ref); if (e) e.void = x.void === 1 || x.void === true; continue; }
      // the effects ledger: the newest record of a support wins (applied, undone, redone)
      if (x.fx !== undefined && typeof x.ref === 'number') { const e = this.real.entries.find((y) => y.seq === x.ref); if (e) e.fx = x.fx && typeof x.fx === 'object' ? x.fx as SubEffect : undefined; continue; }
      if (!x.ev || typeof x.ev !== 'object') continue;
      const e: Entry = { seq, at: Number(x.at) || 0, o: (x.o as SupportOrigin) ?? 'chat', ev: x.ev as SupportEvent, c: x.c as Contribution };
      this.real.entries.push(e);
      this.dedupe.seed(e.ev, e.o, e.at, e.c?.money ?? 0, t);
      if (seq > applied) late.push(e);
    }
    for (const a of this.real.adjust) if (a.seq > this.seq) this.seq = a.seq;
    // ONE time (ledgerV): supports counted by a build without the ledger get it, WRITTEN to the log - read off their timer
    // line, or (the line already gone) an explicit "timer effect unknown" marker: their undo moves the goal only
    const sub0 = this.real.sub;
    let migrated = 0;
    if (sub0 && !st.ledgerV) {
      const zero = { subs: 0, gifted: 0, bits: 0, money: 0, members: 0, kicks: 0, events: 0 };
      for (const e of this.real.entries) {
        if (e.fx || e.seq > applied || e.ev.test || e.at < sub0.startedAt) continue;
        const l = sub0.log.find((y) => y.kind === 'event' && y.evId === e.ev.id);
        const fx: SubEffect = l ? { sid: sub0.id, line: l.seq, ms: l.ms, stat: l.stat ?? zero, who: l.who, platform: l.platform, ...(l.undone ? { off: true, clockMs: l.undoneMs ?? -l.ms } : {}) }
          : { sid: sub0.id, ms: 0, stat: zero, unknown: true };
        this.setFx(this.real, e, fx);
        migrated++;
      }
    }
    this.ledgerV = 1;
    if (!hadConfig) this.migrate(t);
    for (const e of late) this.applyToSub(this.real, e, { silent: true });
    if (late.length) this.say(`applied ${late.length} logged event(s) the saved state had not seen`);
    if (migrated) this.say(`gave ${migrated} counted support(s) their effects ledger (once)`);
    if (late.length || !st.ledgerV) this.saveNow();
  }
  private ledgerV = 0;

  // ---------------------------------------------------------------- migration (the old single chat goal → goal #1)
  private migrate(now: number) {
    const L = this.deps.legacy?.() ?? null;
    if (L) this.legacySeen = { on: L.on, target: L.target, label: L.label };
    // only a chat goal that is ON becomes goal #1 (a first-time user gets the templates, not a hidden $100 goal)
    if (L && L.on && L.target > 0) this.adoptLegacy(L, now);
    this.saveConfig();
  }
  /** The old chat goal as goal #1, with this session's support (from the chat log) counted: the bar shows what the old one did. */
  private adoptLegacy(L: LegacyGoal, now: number) {
    const g = sanitizeGoal({ title: L.label || 'Stream goal', metric: 'money', target: L.target, reset: 'manual', show: L.on, startAt: L.since || now, legacy: true }, now);
    if (typeof g === 'string') return;
    // the old chat goal showed on the support board / the HUD goal bar only: no new corner card or room board for it
    // until the streamer turns those on (Goals & subathon → On stream)
    if (!this.cfg.goals.length) this.cfg.show = { ...this.cfg.show, dock: 'off', world: false };
    this.cfg.goals.unshift(g);
    if (this.cfg.goals.length > 8) this.cfg.goals.length = 8;
    let n = 0;
    for (const e of this.deps.chatSince?.(g.startAt) ?? []) {
      if (e.test || e.kind !== 'finance') continue;
      const s = supportOfChat(e, this.cfg.currency);
      if (s && this.ingest(s.ev, 'chat', s.approx, { at: e.ts, silent: true, noSub: true })) n++;
    }
    this.real.values = null;
    this.checkGoals(this.real, true);
    this.say(`the chat goal "${g.title}" is now goal #1 (${n} support event(s) from this session counted)`);
  }

  /** The old Chat & events → Goal settings changed (cache/scene.json): keep goal #1 in step with them. */
  syncLegacy(L: LegacyGoal | null) {
    if (!L) return;
    const k = { on: L.on, target: L.target, label: L.label };
    const prev = this.legacySeen;
    if (prev && prev.on === k.on && prev.target === k.target && prev.label === k.label) return;
    this.legacySeen = k;
    if (!prev) { this.saveSoon(); return; }         // (just remember: the user's newer goals edits win)
    const g = this.cfg.goals.find((x) => x.legacy);
    if (!g) {
      // the old "Goal bar" switch turned on: it shows up as goal #1, like it always did
      if (k.on && !prev.on && this.cfg.goals.length < 8) { this.adoptLegacy(L, this.now()); this.saveConfig(); this.saveNow(); this.push(); }
      else this.saveSoon();
      return;
    }
    g.show = L.on; g.target = Math.max(1, L.target); g.title = L.label || g.title;
    g.stretch = g.stretch.filter((s) => s.target > g.target);
    this.real.values = null;
    this.saveConfig(); this.saveSoon(); this.push();
  }
  /** "Reset session totals" (the old goal bar's button) = the migrated goal starts over too. */
  totalsReset() { const g = this.cfg.goals.find((x) => x.legacy); if (g) this.resetGoal(g.id); }

  // ---------------------------------------------------------------- ingestion
  /** A chat line from the hub (every platform): finance → a SupportEvent; follows, raids, mod commands, incentive commands. */
  onChatEvent(e: ChatEvent) {
    if (e.cue) return;
    if (e.kind === 'finance') {
      if (e.fkind === 'raid') { this.onRaid(e); return; }
      const s = supportOfChat(e, this.cfg.currency);
      if (s) this.ingest(s.ev, 'chat', s.approx);
      return;
    }
    if (e.kind === 'system' && e.ev === 'follow') { this.onFollow(e); return; }
    if (e.kind === 'chat' && /^\s*!/.test(e.text)) this.onCommand(e);
  }
  /** The support lane's {type:'support', ev} (bus). */
  onSupport(ev: unknown) {
    const x = cleanEvent(ev);
    if (x) this.ingest(x, 'support', 0);
  }

  /** Count one support event (deduped). false = a duplicate / invalid / not counted. */
  ingest(ev: SupportEvent, origin: SupportOrigin, approx = 0, o: { at?: number; silent?: boolean; noSub?: boolean } = {}): boolean {
    // a test event (the Chat tab's "Send test", a dashboard test alert) only ever reaches the test-mode sandbox: never the
    // real log, incentives, milestones or celebrations
    if (ev.test && !this.sandbox) return false;
    const now = o.at ?? this.now();
    const c = contributionOf(ev, this.cfg.currency, approx);
    if (!this.dedupe.accept(ev, origin, this.now(), c.money)) return false;
    const book = ev.test && this.sandbox ? this.sandbox : this.real;
    if (!book.test && !ev.test) this.streamGap(now);
    // (in the sandbox a test event counts like a real one: that is what test mode shows)
    const e: Entry = { seq: ++this.seq, at: now, o: origin, ev: book.test ? { ...trimEvent(ev), test: false } : trimEvent(ev), c };
    if (!book.test) { this.append({ seq: e.seq, at: e.at, o: e.o, ev: e.ev, c: e.c }); if (!ev.test) this.lastEventAt = now; }
    book.entries.push(e);
    if (book.values) for (const g of this.cfg.goals) book.values.set(g.id, (book.values.get(g.id) ?? 0) + goalValueOf(g, e.ev, c, e.at));
    const silent = !!o.silent || ev.replayed;
    this.checkGoals(book, silent);
    if (!o.noSub) this.applyToSub(book, e, { silent });
    if (!silent) this.supportIncentives(book, e);
    this.checkMilestones(book, silent);
    this.saveSoon();
    this.push();
    return true;
  }

  private applyToSub(book: Book, e: Entry, o: { silent: boolean }) {
    const st = book.sub;
    if (!st || st.ended || (e.ev.test && !book.test) || e.void) return;
    const base = baseTimeFor(this.cfg.subathon, e.ev.kind, e.c);
    const stat = countStats(st, e.c, e.ev.kind);
    const who = e.ev.who.anonymous ? 'Anonymous' : e.ev.who.name;
    const fx: SubEffect = { sid: st.id, ms: 0, stat, who, platform: e.ev.source };
    if (base > 0) {
      const hyped = noteHype(this.cfg.subathon, st, e.at);
      const r = addSupportTime(this.cfg.subathon, st, base, { label: `${who}: ${labelOf(e.ev, e.c, this.cfg.currency)}`, who, platform: e.ev.source, evId: e.ev.id, stat }, e.at);
      if (hyped && !o.silent) this.fx(book, 'time', `HYPE! Time ×${this.cfg.subathon.hype.mult}`, `for ${fmtSpan(this.cfg.subathon.hype.ms)}`, '#ff5fa2');
      fx.ms = r.ms;
      if (r.log) fx.line = r.log.seq;
    }
    // the effects ledger, on the support itself (persisted): what its undo / redo reverse exactly
    this.setFx(book, e, fx);
    if (!book.test) this.subSeqApplied = e.seq;
  }
  private subSeqApplied = 0;
  /** Record a support's effects ledger (in memory + an fx line in the event log: the newest wins at load). */
  private setFx(book: Book, e: Entry, fx: SubEffect | undefined) {
    e.fx = fx;
    if (!book.test) this.append({ seq: ++this.seq, at: this.now(), ref: e.seq, fx: fx ?? null });
  }
  /** The ledger invariant (tests / diagnostics): the subathon's stats and support time = the sum of the active effects. */
  ledgerCheck(test = false): { ok: boolean; stats: StatDelta | null; ledger: StatDelta | null; eventMs: number; ledgerMs: number } {
    const book = test && this.sandbox ? this.sandbox : this.real, st = book.sub;
    if (!st) return { ok: true, stats: null, ledger: null, eventMs: 0, ledgerMs: 0 };
    const L = ledgerTotals(st, [...book.entries.map((e) => e.fx).filter((x): x is SubEffect => !!x), ...(book.inherited ?? [])]);
    if (L.unknown) return { ok: true, stats: { ...st.stats }, ledger: L.stats, eventMs: st.eventMs, ledgerMs: L.eventMs };   // (pre-ledger supports: not checkable)
    const s0 = st.stats, l0 = L.stats;
    const ok = s0.subs === l0.subs && s0.gifted === l0.gifted && s0.bits === l0.bits && Math.abs(s0.money - l0.money) < 0.005 && s0.members === l0.members && s0.kicks === l0.kicks
      && s0.events === l0.events && s0.follows === (l0.follows ?? 0) && s0.raids === (l0.raids ?? 0) && st.eventMs === L.eventMs;
    return { ok, stats: { ...s0 }, ledger: l0, eventMs: st.eventMs, ledgerMs: L.eventMs };
  }

  private onRaid(e: ChatEvent) {
    if (this.seen.has(e.id)) return; this.mark(e.id);
    const book = e.test ? this.sandbox : this.real;
    if (!book) return;
    const viewers = Math.max(0, Math.round(e.amount ?? 0));
    const r = this.cfg.subathon.rules;
    if (book.sub && !book.sub.ended && (r.raid || r.raidPerViewer)) {
      const stat: StatDelta = { subs: 0, gifted: 0, bits: 0, money: 0, members: 0, kicks: 0, events: 0, raids: 1 };
      const res = addSupportTime(this.cfg.subathon, book.sub, (r.raid + r.raidPerViewer * viewers) * 1000, { label: `${e.user}: raid (${viewers})`, who: e.user, platform: e.platform, stat }, this.now());
      if (res.log) applyStat(book.sub, stat, 1);   // (on the line: its undo takes the raid off the stats too)
    }
    for (const i of this.cfg.incentives) if (i.on && i.when.on === 'raid' && viewers >= i.when.minViewers) this.runActions(book, i.then, { name: e.user, n: 1, src: i.name });
    this.saveSoon(); this.push();
  }
  private onFollow(e: ChatEvent) {
    if (this.seen.has(e.id)) return; this.mark(e.id);
    const book = e.test ? this.sandbox : this.real;
    if (!book) return;
    const r = this.cfg.subathon.rules;
    if (book.sub && !book.sub.ended && r.follow) {
      const stat: StatDelta = { subs: 0, gifted: 0, bits: 0, money: 0, members: 0, kicks: 0, events: 0, follows: 1 };
      const res = addSupportTime(this.cfg.subathon, book.sub, r.follow * 1000, { label: `${e.user}: follow`, who: e.user, platform: e.platform, stat }, this.now());
      if (res.log) applyStat(book.sub, stat, 1);
    }
    for (const i of this.cfg.incentives) if (i.on && i.when.on === 'follow') this.runActions(book, i.then, { name: e.user, n: 1, src: i.name });
    this.saveSoon(); this.push();
  }
  private onCommand(e: ChatEvent) {
    if (this.seen.has(e.id)) return; this.mark(e.id);
    const book = e.test ? this.sandbox : this.real;
    if (!book) return;
    const mod = isMod(e.badges);
    const by = `${e.user} (${e.platform})`;
    const m = parseModCommand(e.text, this.cfg.mods);
    if (m && mod) {
      if (!this.modRate(`${e.platform}:${e.user.toLowerCase()}`, m.cmd)) { this.say(`mod command from ${by} skipped: too many in a minute`); return; }
      this.modCommand(book, m, by);
      return;
    }
    const cmd = (/^\s*!([a-z0-9_]+)/i.exec(e.text)?.[1] ?? '').toLowerCase();
    const now = this.now();
    for (const i of this.cfg.incentives) {
      if (!i.on || i.when.on !== 'command' || i.when.cmd !== cmd || !mayRun(i.when.who, e.badges)) continue;
      const k = `${book.test ? 't' : 'r'}:${i.id}`;
      if (now - (this.cooldown.get(k) ?? 0) < i.when.cooldownSec * 1000) continue;
      this.cooldown.set(k, now);
      this.runActions(book, i.then, { name: e.user, n: 1, src: i.name });
    }
    this.saveSoon(); this.push();
  }
  /** Mods' chat commands, per mod per minute: at most 3 time changes (add / take off / happy hour / undo) and 1 wheel spin;
   *  all mods together at most 4 spins a minute. The studio and the Stream Deck are not limited. */
  private modHits = new Map<string, number[]>();
  private modRate(who: string, cmd: string): boolean {
    const kind = cmd === 'spin' ? 'spin' : cmd === 'addtime' || cmd === 'subtime' || cmd === 'happyhour' || cmd === 'undo' ? 'time' : '';
    if (!kind) return true;
    const now = this.now();
    const hit = (k: string, max: number) => { const l = (this.modHits.get(k) ?? []).filter((t) => now - t < 60_000); if (l.length >= max) { this.modHits.set(k, l); return false; } l.push(now); this.modHits.set(k, l); return true; };
    if (kind === 'spin') return hit('*:spin', 4) && hit(`${who}:spin`, 1);
    if (this.modHits.size > 500) for (const [k, l] of this.modHits) if (!l.some((t) => now - t < 60_000)) this.modHits.delete(k);
    return hit(`${who}:time`, 3);
  }
  /** A mod's chat command (permission already checked), the studio and the Stream Deck use the same path. */
  private modCommand(book: Book, m: NonNullable<ReturnType<typeof parseModCommand>>, by: string) {
    const st = book.sub, now = this.now();
    switch (m.cmd) {
      case 'addtime': case 'subtime': if (st) adjustTime(this.cfg.subathon, st, m.cmd === 'addtime' ? m.ms : -m.ms, { label: `${m.cmd === 'addtime' ? '+' : '-'}${fmtSpan(m.ms)} by ${by}`, who: by }, now); break;
      case 'happyhour': if (st) { setHappy(st, m.mult, m.ms, by, now); this.fx(book, 'time', `HAPPY HOUR ×${m.mult}`, `for ${fmtSpan(m.ms)}`, '#ffd24a'); } break;
      case 'happyoff': if (st) setHappy(st, 1, 0, by, now); break;
      case 'pause': if (st) pause(st, by, now); break;
      case 'resume': if (st) resume(this.cfg.subathon, st, by, now); break;
      case 'undo': if (st) this.undoLastLinked(book, m.n, by); break;
      case 'sleep': if (st) setSleep(st, m.on, by, now); break;
      case 'spin': this.spin(book, by); break;
    }
    if (book.test) this.push(); else { this.saveNow(); this.push(); }
  }

  // ---------------------------------------------------------------- goals: values, celebrations
  private valuesOf(book: Book): Map<string, number> {
    if (book.values) return book.values;
    const m = new Map<string, number>();
    for (const g of this.cfg.goals) {
      let v = 0;
      for (const e of book.entries) if (!e.void) v += goalValueOf(g, e.ev, e.c, e.at);
      for (const a of book.adjust) if (!a.void && a.goalId === g.id && a.at >= g.startAt) v += a.delta;
      m.set(g.id, v);
    }
    book.values = m;
    return m;
  }
  goalValue(id: string, test = !!this.sandbox): number {
    const b = test && this.sandbox ? this.sandbox : this.real;
    const base = b.test ? this.valuesOf(this.real).get(id) ?? 0 : 0;
    return Math.round(((this.valuesOf(b).get(id) ?? 0) + base) * 100) / 100;
  }
  private checkGoals(book: Book, silent: boolean) {
    for (const g of this.cfg.goals) {
      const v = this.goalValue(g.id, book.test);
      const n = levelsReached(g, v), done = book.fired[g.id] ?? 0;
      // dropped back under a level (an undo, a take-off): reaching it again celebrates again
      if (n < done) { book.fired[g.id] = n; continue; }
      if (n === done) continue;
      book.fired[g.id] = n;
      if (silent) continue;
      for (let lv = done + 1; lv <= n; lv++) this.celebrate(book, g, lv);
    }
  }
  private celebrate(book: Book, g: GoalDef, lv: number) {
    const st = lv >= 2 ? g.stretch[lv - 2] : null;
    const reward = lv === 1 ? g.reward : st?.reward ?? '';
    const color = g.color || (lv === 1 ? '#7dff8a' : '#ffd24a');
    const all = lv === goalLevels(g).length;
    this.fx(book, lv === 1 ? 'goal' : 'stretch', lv === 1 ? `${g.title.toUpperCase()} REACHED!` : `STRETCH GOAL ${lv - 1}${all ? ' (THE LAST ONE!)' : ''} REACHED!`, reward ? `Unlocked: ${reward}` : fmtMetric(goalLevels(g)[lv - 1], g.metric, this.cfg.currency), color);
    const action: GoalAction | undefined = lv === 1 ? g.action : st?.action;
    if (!book.test) {
      if (action?.deck) this.deck(action.deck.action, action.deck.params);
      const snd = action?.sound ?? (this.cfg.celebrate !== 'none' ? this.cfg.celebrate : null);
      if (snd) this.sound(snd);
    }
    if (action?.text) this.fx(book, 'message', action.text, '', color);
    for (const i of this.cfg.incentives) if (i.on && i.when.on === 'goal' && (!i.when.goalId || i.when.goalId === g.id) && (!i.when.level || i.when.level === lv)) this.runActions(book, i.then, { name: '', n: 1, src: i.name });
  }

  // ---------------------------------------------------------------- incentives
  private supportIncentives(book: Book, e: Entry) {
    for (const i of this.cfg.incentives) {
      if (!i.on || i.when.on !== 'support') continue;
      const n = supportFires(i.when, e.ev, e.c);
      if (n > 0) this.runActions(book, i.then, { name: e.ev.who.anonymous ? 'Anonymous' : e.ev.who.name, amount: e.c.money ? fmtMoney(e.c.money, this.cfg.currency) : '', subs: e.c.subs + e.c.gifted, bits: e.c.bits, n, src: i.name });
    }
  }
  private checkMilestones(book: Book, silent: boolean) {
    for (const i of this.cfg.incentives) {
      if (!i.on || i.when.on !== 'milestone') continue;
      const w = i.when;
      let total = 0;
      if (book.sub) {
        const s = book.sub;
        total = w.of === 'time' ? (s.eventMs + s.adjustMs) / 60_000 : w.of === 'subs' ? s.stats.subs + s.stats.gifted : s.stats.money;
      } else {
        for (const e of book.entries) if (!e.void && e.at >= book.streamAt && (!e.ev.test || book.test)) total += w.of === 'subs' ? e.c.subs + e.c.gifted : w.of === 'money' ? e.c.money : 0;
      }
      const reached = Math.floor((total + 1e-9) / w.every);
      const key = `${book.sub?.id ?? `stream${book.streamAt}`}:${i.id}`;
      const done = book.miles[key] ?? 0;
      if (reached <= done) continue;
      book.miles[key] = reached;
      if (silent) continue;
      this.runActions(book, i.then, { name: '', n: Math.min(5, reached - done), src: i.name });
    }
  }
  private runActions(book: Book, list: IncAction[], v: { name: string; amount?: string; subs?: number; bits?: number; n: number; src: string }) {
    const now = this.now();
    for (const a of list) {
      switch (a.do) {
        case 'addTime': if (book.sub) adjustTime(this.cfg.subathon, book.sub, a.ms * v.n, { label: `${v.src}${v.name ? ` (${v.name})` : ''}`, who: v.name || 'incentive' }, now); break;
        case 'happyhour': if (book.sub) { setHappy(book.sub, a.mult, a.ms, v.src, now); this.fx(book, 'time', `HAPPY HOUR ×${a.mult}`, `for ${fmtSpan(a.ms)}`, '#ffd24a'); } break;
        case 'wheel': for (let k = 0; k < Math.min(5, v.n); k++) this.spin(book, v.name || v.src); break;
        case 'unlock': { const g = this.cfg.goals.find((x) => x.id === a.goalId) ?? this.cfg.goals.find((x) => x.stretch.some((s) => s.hidden)); if (g) book.unlocked[g.id] = (book.unlocked[g.id] ?? 0) + 1; this.fx(book, 'stretch', 'STRETCH GOAL UNLOCKED', g ? g.title : '', '#b388ff'); break; }
        case 'message': this.fx(book, 'message', fillText(a.text, { name: v.name, amount: v.amount, subs: v.subs, bits: v.bits }), '', ''); break;
        case 'sound': if (!book.test) this.sound(a.s); else this.fx(book, 'message', `(test) would play: ${a.s}`, '', '#9aa4b8'); break;
        case 'deck': if (!book.test) this.deck(a.cue.action, a.cue.params); else this.fx(book, 'message', `(test) would run: ${a.cue.action}`, '', '#9aa4b8'); break;
      }
    }
  }
  /** "Try it" from the panel: ALWAYS in the test-mode sandbox (switched on if needed): the stream shows a TEST preview;
   *  the real timer, the room (Stream Deck cues) and the show's sounds are never touched. */
  tryIncentive(id: string): boolean {
    const i = this.cfg.incentives.find((x) => x.id === id) ?? INCENTIVE_PRESETS.find((x) => x.id === id);
    if (!i) return false;
    if (!this.sandbox) this.setTest(true);
    this.runActions(this.sandbox!, i.then, { name: 'Test viewer', amount: fmtMoney(10, this.cfg.currency), subs: 5, bits: 500, n: 1, src: i.name });
    this.push();
    return true;
  }


  // ---------------------------------------------------------------- effects
  private fxN = 0;
  private fx(book: Book, kind: GoalFx['kind'], text: string, sub: string, color: string) {
    const now = this.now();
    book.fx = book.fx.filter((f) => now - f.at < FX_KEEP_MS);
    book.fx.push({ id: `${now.toString(36)}${++this.fxN}`, at: now, kind, text: text.slice(0, 140), sub: sub.slice(0, 140), color });
    if (book.fx.length > 6) book.fx.splice(0, book.fx.length - 6);
  }
  private sndN = 0;
  private sound(s: SoundCue) {
    const id = `goals:${this.now().toString(36)}:${++this.sndN}`;
    const m = s === 'fanfare' ? { k: 'sting' } : s === 'horn' ? { k: 'horn', v: 'bits' } : s === 'siren' ? { k: 'horn', v: 'raid' } : { k: 'slap', kind: 'slap', seed: Math.floor(this.rnd() * 1e6), gain: 1, rate: 1 };
    this.deps.broadcast({ type: 'showsound', id, s: m });
  }
  private deck(action: string, params: Record<string, unknown>) {
    try { const r = this.deps.runDeck(action, params); if (!r.ok) this.say(`effect "${action}" did not run: ${r.error ?? '?'}`); } catch (e) { this.say('effect', e); }
  }

  // ---------------------------------------------------------------- the wheel
  spin(book: Book = this.sandbox ?? this.real, by = 'studio'): WheelSpin | null {
    const slots = this.cfg.wheel;
    if (slots.length < 2) return null;
    const now = this.now();
    const i = wheelPick(slots, this.rnd());
    const last = book.wheel.queue[book.wheel.queue.length - 1] ?? book.wheel.spin;
    const at = last ? Math.max(now, last.at + WHEEL_SPIN_MS + WHEEL_SHOW_MS) : now;
    const sp: WheelSpin = { id: `w${now.toString(36)}${++this.fxN}`, at, result: i, label: slots[i].label, by: by.slice(0, 48) };
    if (!book.wheel.spin) book.wheel.spin = sp; else book.wheel.queue.push(sp);
    if (book.wheel.queue.length > 10) book.wheel.queue.splice(0, book.wheel.queue.length - 10);
    this.push();
    return sp;
  }
  private wheelStep(book: Book, now: number) {
    const sp = book.wheel.spin;
    if (!sp) return;
    if (!(sp as WheelSpin & { landed?: boolean }).landed && now >= sp.at + WHEEL_SPIN_MS) {
      (sp as WheelSpin & { landed?: boolean }).landed = true;
      this.fx(book, 'wheel', `WHEEL: ${sp.label}`, sp.by ? `spun for ${sp.by}` : '', '#35e3ff');
      // a slot that names time ("+15 minutes", "-10 min") changes the subathon by itself
      const t = /^([+-])\s*(.+)$/.exec(sp.label.trim());
      const ms = t ? parseDuration(t[2].replace(/minutes?|mins?/i, 'm').replace(/hours?|hrs?/i, 'h').replace(/seconds?|secs?/i, 's')) : 0;
      if (ms && book.sub) adjustTime(this.cfg.subathon, book.sub, t![1] === '-' ? -ms : ms, { label: `Wheel: ${sp.label}`, who: 'wheel' }, now);
      this.push();
    }
    if (now >= sp.at + WHEEL_SPIN_MS + WHEEL_SHOW_MS) { book.wheel.spin = book.wheel.queue.shift() ?? null; this.push(); }
  }

  // ---------------------------------------------------------------- goals: edits
  saveGoal(raw: unknown): GoalDef | string {
    const now = this.now();
    const prev = this.cfg.goals.find((g) => g.id === (raw as { id?: string })?.id);
    const g = sanitizeGoal({ ...(prev ?? {}), ...(raw as object), startAt: (raw as { startAt?: number })?.startAt ?? prev?.startAt ?? now }, now);
    if (typeof g === 'string') return g;
    if (prev?.legacy) g.legacy = true;
    if (prev) this.cfg.goals[this.cfg.goals.indexOf(prev)] = g;
    else { if (this.cfg.goals.length >= 8) return 'Up to 8 goals at once'; this.cfg.goals.push(g); }
    this.afterGoalsChange();
    // a target lowered under the value: celebrate silently (no fanfare for an edit)
    this.checkGoals(this.real, true);
    if (this.sandbox) this.checkGoals(this.sandbox, true);
    this.saveNow(); this.push();
    return g;
  }
  addTemplate(id: string): GoalDef | string {
    const g = goalFromTemplate(id, this.now(), this.cfg.currency);
    if (!g) return 'Unknown template';
    return this.saveGoal(g);
  }
  removeGoal(id: string): boolean {
    const n = this.cfg.goals.length;
    this.cfg.goals = this.cfg.goals.filter((g) => g.id !== id);
    if (n === this.cfg.goals.length) return false;
    delete this.real.fired[id]; delete this.real.unlocked[id];
    this.afterGoalsChange(); this.saveNow(); this.push();
    return true;
  }
  orderGoals(ids: string[]) {
    const by = new Map(this.cfg.goals.map((g) => [g.id, g]));
    const out = ids.map((i) => by.get(i)).filter((g): g is GoalDef => !!g);
    for (const g of this.cfg.goals) if (!out.includes(g)) out.push(g);
    this.cfg.goals = out; this.saveConfig(); this.push();
  }
  resetGoal(id: string): boolean {
    const g = this.cfg.goals.find((x) => x.id === id);
    if (!g) return false;
    g.startAt = this.now();
    this.real.fired[id] = 0; this.real.unlocked[id] = 0;
    if (this.sandbox) { this.sandbox.fired[id] = 0; this.sandbox.unlocked[id] = 0; }
    this.afterGoalsChange(); this.saveNow(); this.push();
    return true;
  }
  /** A new stream: every "every stream" goal starts over (OBS started streaming, a long gap, or the streamer said so). */
  newStream(why = 'studio') {
    const now = this.now();
    for (const g of this.cfg.goals) if (g.reset === 'stream') { g.startAt = now; this.real.fired[g.id] = 0; this.real.unlocked[g.id] = 0; }
    this.real.streamAt = now;
    this.say(`new stream (${why}): per-stream goals start over`);
    this.afterGoalsChange(); this.saveNow(); this.push();
  }
  private streamGap(now: number) {
    const h = this.cfg.streamGapH;
    if (h > 0 && this.lastEventAt && now - this.lastEventAt > h * 3_600_000 && this.cfg.goals.some((g) => g.reset === 'stream' && g.startAt < this.lastEventAt + 1)) this.newStream(`no support for ${h} h`);
  }
  /** Manual add / subtract on a goal (audit-logged). */
  adjustGoal(id: string, delta: number, by: string, note: string): GoalAdjust | null {
    const g = this.cfg.goals.find((x) => x.id === id);
    if (!g || !Number.isFinite(delta) || !delta) return null;
    const book = this.sandbox ?? this.real;
    const a: GoalAdjust = { seq: ++this.seq, at: this.now(), goalId: id, delta: Math.round(delta * 100) / 100, by: by.slice(0, 48), note: note.slice(0, 120) };
    book.adjust.push(a);
    if (book.adjust.length > ADJUST_KEEP) book.adjust.splice(0, book.adjust.length - ADJUST_KEEP);
    book.values = null;
    this.checkGoals(book, false);
    if (!book.test) this.saveNow();
    this.push();
    return a;
  }
  /** Undo (void) / redo an event from the log: every goal recounts. */
  voidEntry(seq: number, on: boolean, by: string): boolean {
    const book = this.sandbox && this.sandbox.entries.some((e) => e.seq === seq) ? this.sandbox : this.real;
    const e = book.entries.find((x) => x.seq === seq);
    if (e) {
      if (!!e.void === on) return true;
      e.void = on;
      if (!book.test) this.append({ seq: ++this.seq, at: this.now(), ref: seq, void: on ? 1 : 0, by: by.slice(0, 48) });
      // the subathon moves WITH the goal, in every state: its credit (board, totals, stats) always, its clock while the run
      // is on (shared/subathon.ts shift)
      // exactly its recorded effect (the ledger) - nothing recorded = the subathon is not touched
      const st = book.sub;
      if (st && e.fx && e.fx.sid === st.id) {
        const label = `${e.ev.who.anonymous ? 'Anonymous' : e.ev.who.name}: ${labelOf(e.ev, e.c, this.cfg.currency)}`;
        const changed = on ? effectUndo(st, e.fx, by, this.now(), label) : effectRedo(st, e.fx, by, this.now(), label, this.cfg.subathon);
        if (changed) this.setFx(book, e, e.fx);
      }
      book.values = null;
      this.checkGoals(book, true);
      if (!book.test) this.saveNow();
      this.push();
      return true;
    }
    const a = book.adjust.find((x) => x.seq === seq);
    if (!a) return false;
    a.void = on; book.values = null;
    this.checkGoals(book, true);
    if (!book.test) this.saveNow();
    this.push();
    return true;
  }
  private afterGoalsChange() { this.real.values = null; if (this.sandbox) this.sandbox.values = null; this.saveConfig(); }

  setConfig(patch: Partial<GoalsConfig>) {
    const now = this.now();
    const next = sanitizeConfig({ ...this.cfg, ...patch, goals: patch.goals ?? this.cfg.goals }, now);
    const curChanged = next.currency !== this.cfg.currency;
    this.cfg = next;
    if (curChanged) this.real.values = null;
    this.afterGoalsChange(); this.saveSoon(); this.push();
  }

  // ---------------------------------------------------------------- subathon controls
  private book() { return this.sandbox ?? this.real; }
  subStart(cfg?: unknown): SubathonState {
    if (cfg !== undefined) this.cfg.subathon = sanitizeSubathon(cfg);
    const book = this.book(), now = this.now();
    if (book.sub && !book.test) this.archive(book.sub, now);
    book.sub = startSubathon(this.cfg.subathon, now, `s${now.toString(36)}`);
    this.fx(book, 'time', `${this.cfg.subathon.title.toUpperCase()} STARTED`, `${fmtSpan(this.cfg.subathon.startMs)} on the clock`, '#35e3ff');
    this.saveConfig();
    if (!book.test) this.saveNow();
    this.push();
    return book.sub;
  }
  /** Rules / caps edited while it runs (the timer keeps its time). */
  subConfig(cfg: unknown) { this.cfg.subathon = sanitizeSubathon(cfg); this.saveConfig(); this.push(); }
  subStop(): boolean {
    const book = this.book();
    if (!book.sub) return false;
    if (!book.test) this.archive(book.sub, this.now());
    book.sub = null;
    if (!book.test) this.saveNow();
    this.push();
    return true;
  }
  private archive(st: SubathonState, now: number) {
    this.history.push(summary(this.cfg.subathon, st, now));
    if (this.history.length > 10) this.history.splice(0, this.history.length - 10);
  }
  subAdjust(ms: number, by: string, note = ''): boolean {
    const st = this.book().sub;
    if (!st || !ms) return false;
    adjustTime(this.cfg.subathon, st, ms, { label: note || `${ms > 0 ? '+' : '-'}${fmtSpan(Math.abs(ms))} (${by})`, who: by }, this.now());
    this.afterSub(); return true;
  }
  subPause(on: boolean | 'toggle', by: string): boolean {
    const st = this.book().sub;
    if (!st) return false;
    const want = on === 'toggle' ? !st.paused : on;
    const ok = want ? pause(st, by, this.now()) : resume(this.cfg.subathon, st, by, this.now());
    this.afterSub(); return ok;
  }
  subUndo(n: number, by: string, seq?: number): number {
    const st = this.book().sub;
    if (!st) return 0;
    const book = this.book();
    if (seq) {
      // a support's line: undone through its event, so the goal and the timer always move together
      const l = st.log.find((x) => x.seq === seq);
      const e = l?.kind === 'event' && l.evId ? book.entries.find((x) => x.ev.id === l.evId) : undefined;
      if (e) return !e.void && this.voidEntry(e.seq, true, by) ? 1 : 0;
      if (l?.kind === 'event' && l.evId) return 0;            // (a support with no entry here: never the timer alone)
      const k = undoSeq(st, seq, by, this.now(), this.cfg.subathon) ? 1 : 0;
      this.afterSub(); return k;
    }
    const k = this.undoLastLinked(book, Math.max(1, Math.min(20, n)), by);
    this.afterSub(); return k;
  }
  /** Redo one timer line (the audit log's Redo): a support's through its event (goal + ledger together), any other line
   *  (a manual add / take-off, a follow, a raid, a wheel prize, an incentive) through the line itself. */
  subRedo(seq: number, by: string): boolean {
    const book = this.book(), st = book.sub;
    if (!st) return false;
    const l = st.log.find((x) => x.seq === seq);
    const e = l?.kind === 'event' && l.evId ? book.entries.find((x) => x.ev.id === l.evId) : undefined;
    if (e) return !!e.void && this.voidEntry(e.seq, false, by);
    if (l?.kind === 'event' && l.evId) return false;
    const ok = !!redoSeq(st, seq, by, this.now(), this.cfg.subathon);
    this.afterSub(); return ok;
  }
  /** !undotime / the studio's Undo last: the newest N time changes; a support's through its event (goal + ledger). */
  private undoLastLinked(book: Book, n: number, by: string): number {
    const st = book.sub;
    if (!st) return 0;
    let k = 0;
    const seen = new Set<number>();
    while (k < n) {
      let l = null as SubLog | null;
      for (let i = st.log.length - 1; i >= 0; i--) { const x = st.log[i]; if (!x.undone && (x.kind === 'event' || x.kind === 'adjust') && (x.ms || x.stat) && !seen.has(x.seq)) { l = x; break; } }
      if (!l) break;
      seen.add(l.seq);
      if (l.kind === 'event' && l.evId) {
        // a support: through its goal entry (goal + timer together); one without an entry here (test mode's preview of a
        // real support) is skipped - never the preview timer without the goal
        const e = book.entries.find((x) => x.ev.id === l!.evId);
        if (e && !e.void && this.voidEntry(e.seq, true, by)) k++;
      } else if (undoSeq(st, l.seq, by, this.now(), this.cfg.subathon)) k++;
    }
    return k;
  }
  subHappy(mult: number, ms: number, by: string) {
    const st = this.book().sub;
    if (!st) return false;
    setHappy(st, mult, ms, by, this.now());
    if (mult > 1) this.fx(this.book(), 'time', `HAPPY HOUR ×${mult}`, `for ${fmtSpan(ms)}`, '#ffd24a');
    this.afterSub(); return true;
  }
  subSleep(on: boolean | 'toggle', by: string) { const st = this.book().sub; if (!st) return false; setSleep(st, on, by, this.now()); this.afterSub(); return true; }
  subReopen(ms: number, by: string) { const st = this.book().sub; if (!st || !st.ended) return false; reopen(st, ms, by, this.now()); this.afterSub(); return true; }
  private afterSub() { if (!this.book().test) this.saveNow(); this.push(); }

  // ---------------------------------------------------------------- test mode (a sandbox, never the real state)
  get testing() { return !!this.sandbox; }
  setTest(on: boolean) {
    if (on === !!this.sandbox) return;
    if (on) {
      const r = this.real, now = this.now();
      this.sandbox = {
        ...emptyBook(true, now), fired: { ...r.fired }, unlocked: { ...r.unlocked }, miles: { ...r.miles }, streamAt: r.streamAt,
        sub: r.sub ? JSON.parse(JSON.stringify(r.sub)) as SubathonState : null,
        inherited: r.entries.filter((e) => e.fx).map((e) => JSON.parse(JSON.stringify(e.fx)) as SubEffect),
      };
    } else this.sandbox = null;
    this.push();
  }
  private testN = 0;
  /** A fake event for test mode (or the panel's "Try" buttons): never counted in the real state. */
  testEvent(what: string, user?: string): boolean {
    if (!this.sandbox) this.setTest(true);
    const n = ++this.testN, now = this.now();
    const names = ['NightOwl42', 'PixelPioneer', 'NeonNomad', 'Beatsmith', 'LateShiftLiz', 'StarlightSam'];
    const name = user || names[n % names.length];
    const plats = ['twitch', 'youtube', 'kick'] as const;
    const src = plats[n % 3];
    const base = { id: `test:goals:${now}:${n}`, source: src, who: { name, anonymous: false }, recurring: false, test: true, occurredAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString(), replayed: false } as const;
    const usd = (v: number) => ({ amount: { minor: Math.round(v * 100), currency: 'USD', valuedAt: 'cash' as const }, display: { minor: Math.round(v * 100), currency: this.cfg.currency, rateSource: 'test', rateDate: '' } });
    let ev: SupportEvent;
    switch (what) {
      case 'sub': ev = { ...base, source: 'twitch', kind: 'sub', units: { subs: 1, tier: '1000' } }; break;
      case 'sub2': ev = { ...base, source: 'twitch', kind: 'sub', units: { subs: 1, tier: '2000' } }; break;
      case 'sub3': ev = { ...base, source: 'twitch', kind: 'sub', units: { subs: 1, tier: '3000' } }; break;
      case 'gift': case 'gift5': ev = { ...base, source: 'twitch', kind: 'gift', units: { gifted: 5, tier: '1000' } }; break;
      case 'bits': ev = { ...base, source: 'twitch', kind: 'bits', units: { bits: 500 }, ...usd(5) }; break;
      case 'member': ev = { ...base, source: 'youtube', kind: 'membership', units: { subs: 1 }, recurring: true }; break;
      case 'kicks': ev = { ...base, source: 'kick', kind: 'tip', units: { kicks: 500 }, ...usd(5) }; break;
      case 'big': ev = { ...base, kind: 'superchat', ...usd(50) }; break;
      case 'follow': this.onFollow({ id: base.id, kind: 'system', platform: src, user: name, text: 'just followed!', ts: now, ev: 'follow', test: true }); return true;
      case 'raid': this.onRaid({ id: base.id, kind: 'finance', platform: 'twitch', user: name, text: 'raid', ts: now, fkind: 'raid', amount: 42, currency: 'viewers', test: true }); return true;
      default: ev = { ...base, kind: 'tip', ...usd(10) };
    }
    return this.ingest(ev, 'test');
  }

  // ---------------------------------------------------------------- the clock (1 Hz)
  tick() {
    const now = this.now();
    for (const book of [this.real, this.sandbox]) {
      if (!book) continue;
      const st = book.sub;
      if (st && subTick(st, now)) {
        const sm = summary(this.cfg.subathon, st, now);
        this.fx(book, 'end', `${this.cfg.subathon.title.toUpperCase()} COMPLETE!`, `${fmtSpan(sm.lengthMs)} · ${st.stats.subs + st.stats.gifted} subs · ${fmtMoney(st.stats.money, this.cfg.currency)}`, '#ffd24a');
        if (!book.test) { this.sound('fanfare'); this.saveNow(); }
        this.push();
      }
      if (st && !st.ended) for (const h of this.cfg.subathon.happy) {
        const k = `${book.test ? 't' : 'r'}${h.at}`;
        if (now >= h.at && now < h.at + h.ms && !this.happyFx.has(k)) { this.happyFx.add(k); this.fx(book, 'time', `HAPPY HOUR ×${h.mult}`, `for ${fmtSpan(h.at + h.ms - now)}`, '#ffd24a'); this.push(); }
      }
      this.wheelStep(book, now);
    }
  }

  // ---------------------------------------------------------------- the view (what every page draws)
  view(): GoalsView {
    const book = this.book(), now = this.now();
    const cur = this.cfg.currency;
    const goals: GoalLive[] = this.cfg.goals.map((g) => {
      const value = this.goalValue(g.id, book.test);
      const reached = levelsReached(g, value);
      const unl = book.unlocked[g.id] ?? 0;
      let hiddenLeft = unl;
      const levels = goalLevels(g).map((t, i) => {
        const st = i ? g.stretch[i - 1] : null;
        let hidden = !!st?.hidden && i >= reached;
        if (hidden && hiddenLeft > 0) { hiddenLeft--; hidden = false; }
        return { target: t, reward: hidden ? '' : i ? st!.reward : g.reward, hidden, hit: i < reached };
      });
      return { id: g.id, title: g.title, metric: g.metric, value, levels, reached, show: g.show, color: g.color };
    });
    let sub: SubLive | null = null;
    const st = book.sub;
    if (st) {
      const m = multiplier(this.cfg.subathon, st, now);
      const sm = st.ended ? summary(this.cfg.subathon, st, now) : null;
      sub = {
        title: this.cfg.subathon.title, startedAt: st.startedAt, endsAt: st.endsAt, paused: st.paused, pausedRemaining: st.paused ? remainingMs(st, now) : 0, ended: st.ended, endedAt: st.endedAt,
        mult: Math.round(m.total * 100) / 100, happy: m.happy > 1 ? { mult: m.happy, until: happyUntil(this.cfg.subathon, st, now) } : null,
        hype: m.hype > 1 && st.hype ? { mult: st.hype.mult, until: st.hype.until } : null, sleep: m.sleep < 1, addedMs: st.eventMs + st.adjustMs,
        last: st.log.filter((l) => (l.kind === 'event' || l.kind === 'adjust') && !l.undone && l.ms).slice(-5).map((l) => ({ seq: l.seq, at: l.at, ms: l.ms, label: l.label, who: l.who ?? '' })),
        top: leaderboard(st, 5).map((r) => ({ name: r.name, platform: r.platform, ms: r.ms })),
        rules: rulesText(this.cfg.subathon, cur, fmtMoney(1, cur).replace(/[\d.,\s]/g, '') || '$'),
        display: this.cfg.subathon.display,
        stats: { subs: st.stats.subs + st.stats.gifted, gifted: st.stats.gifted, bits: st.stats.bits, money: st.stats.money, members: st.stats.members, events: st.stats.events },
        summary: sm ? { lengthMs: sm.lengthMs, addedMs: sm.addedMs, biggest: sm.biggest ? `${sm.biggest.label} (+${fmtSpan(sm.biggest.ms)})` : '' } : null,
      };
    }
    return {
      v: 1, now, rev: this.rev, cur, goals, sub,
      wheel: { slots: this.cfg.wheel.map((s) => s.label), spin: book.wheel.spin ? { id: book.wheel.spin.id, at: book.wheel.spin.at, result: book.wheel.spin.result, label: book.wheel.spin.label, by: book.wheel.spin.by } : null },
      fx: book.fx.filter((f) => now - f.at < FX_KEEP_MS), show: this.cfg.show, test: book.test,
    };
  }

  /** The studio panel: config, view, the audit logs, history. */
  panelState() {
    const book = this.book();
    const cur = this.cfg.currency;
    const recent = book.entries.slice(-80).reverse().map((e) => ({ seq: e.seq, at: e.at, origin: e.o, void: !!e.void, test: e.ev.test, source: e.ev.source, kind: e.ev.kind, who: e.ev.who.anonymous ? 'Anonymous' : e.ev.who.name, label: labelOf(e.ev, e.c, cur), ...(e.fx?.unknown ? { timerUnknown: true } : {}) }));
    const adjust = book.adjust.slice(-40).reverse();
    const subLog = book.sub ? book.sub.log.slice(-120).reverse() : [];
    return { cfg: this.cfg, view: this.view(), recent, adjust, subLog, history: [...this.history].reverse(), test: book.test, presets: INCENTIVE_PRESETS };
  }

  // ---------------------------------------------------------------- pushes + persistence
  push(now = false) {
    this.rev++;
    if (now) { if (this.pushT) { clearTimeout(this.pushT); this.pushT = null; } this.send(); return; }
    if (this.pushT) return;
    this.pushT = setTimeout(() => { this.pushT = null; this.send(); }, 120);
  }
  private send() { this.pushes++; try { this.deps.broadcast({ type: 'goals', s: this.view() }); } catch (e) { this.say('push', e); } }
  /** Pushed now (tests / a page asked). */
  flushPush() { if (this.pushT) { clearTimeout(this.pushT); this.pushT = null; this.send(); } }

  private append(x: Record<string, unknown>) {
    try { fs.mkdirSync(this.deps.dir, { recursive: true }); fs.appendFileSync(this.logFile, JSON.stringify(x) + '\n'); } catch (e) { this.say('log write', e); }
  }
  private saveConfig() { writeAtomic(this.deps.configFile, JSON.stringify(this.cfg, null, 1), this.say); }
  saveSoon() { if (this.saveT) return; this.saveT = setTimeout(() => { this.saveT = null; this.saveNow(); }, 300); }
  saveNow() {
    if (this.saveT) { clearTimeout(this.saveT); this.saveT = null; }
    const r = this.real;
    const p: Persist = { v: 1, ledgerV: this.ledgerV, seq: Math.max(this.subSeqApplied, ...r.entries.slice(-1).map((e) => e.seq), 0), fired: r.fired, unlocked: r.unlocked, adjust: r.adjust, sub: r.sub, history: this.history, lastEventAt: this.lastEventAt, streamAt: r.streamAt, miles: r.miles, legacy: this.legacySeen };
    writeAtomic(this.stateFile, JSON.stringify(p), this.say);
  }
  /** Shutdown: everything on disk now. */
  close() { this.saveNow(); if (this.pushT) { clearTimeout(this.pushT); this.pushT = null; } }
  private mark(id: string) { this.seen.add(id); if (this.seen.size > 3000) { let d = 1000; for (const k of this.seen) { if (d-- <= 0) break; this.seen.delete(k); } } }
}

// ---------------------------------------------------------------- helpers
function happyUntil(cfg: SubathonConfig, st: SubathonState, now: number): number {
  let u = st.happy && st.happy.until > now ? st.happy.until : 0;
  for (const h of cfg.happy) if (now >= h.at && now < h.at + h.ms) u = Math.max(u, h.at + h.ms);
  return u;
}
function emptyBook(test: boolean, now: number): Book {
  return { test, entries: [], adjust: [], fired: {}, unlocked: {}, sub: null, miles: {}, fx: [], wheel: { spin: null, queue: [] }, values: null, streamAt: now };
}
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {});
function readJson<T>(f: string, d: T): T { try { return JSON.parse(fs.readFileSync(f, 'utf8')) as T; } catch { return d; } }
function readLines(f: string): string[] { try { return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()); } catch { return []; } }
function writeAtomic(file: string, data: string, say: (...a: unknown[]) => void) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) { say('save', file, e); }
}
/** The parts of a SupportEvent the log keeps (no addresses / e-mails ever reach here; message text trimmed). */
function trimEvent(ev: SupportEvent): SupportEvent {
  const t: SupportEvent = { id: ev.id, source: ev.source, kind: ev.kind, who: { name: ev.who.name.slice(0, 48), anonymous: !!ev.who.anonymous, ...(ev.who.chat ? { chat: ev.who.chat } : {}) }, recurring: !!ev.recurring, test: !!ev.test, occurredAt: ev.occurredAt, receivedAt: ev.receivedAt, replayed: !!ev.replayed };
  if (ev.amount) t.amount = ev.amount;
  if (ev.display) t.display = ev.display;
  if (ev.units) t.units = ev.units;
  if (ev.tierName) t.tierName = ev.tierName.slice(0, 40);
  if (ev.via) t.via = ev.via;
  if (ev.message?.text) t.message = { text: ev.message.text.slice(0, 100), moderated: ev.message.moderated };
  return t;
}
/** A SupportEvent from the bus: shape-checked (the support lane sanitises; this guards the engine). */
export function cleanEvent(raw: unknown): SupportEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== 'string' || !e.id || e.id.length > 200) return null;
  if (typeof e.kind !== 'string' || !(SUPPORT_KINDS as readonly string[]).includes(e.kind)) return null;
  const who = e.who as Record<string, unknown> | undefined;
  if (!who || typeof who.name !== 'string') return null;
  const money = (m: unknown) => { const x = m as Record<string, unknown> | undefined; return x && typeof x.minor === 'number' && Number.isFinite(x.minor) && x.minor >= 0 && typeof x.currency === 'string' ? x : undefined; };
  const ev = { ...(e as unknown as SupportEvent) };
  ev.amount = money(e.amount) as SupportEvent['amount'];
  ev.display = money(e.display) as SupportEvent['display'];
  if (e.units && typeof e.units === 'object') { const u = e.units as Record<string, unknown>; const k: NonNullable<SupportEvent['units']> = {}; for (const f of ['bits', 'subs', 'months', 'gifted', 'kicks'] as const) if (typeof u[f] === 'number' && Number.isFinite(u[f]) && (u[f] as number) >= 0) k[f] = Math.min(1e7, u[f] as number); if (typeof u.tier === 'string') k.tier = u.tier.slice(0, 16); ev.units = k; } else delete ev.units;
  ev.test = e.test === true; ev.replayed = e.replayed === true; ev.recurring = e.recurring === true;
  ev.who = { name: who.name.slice(0, 48), anonymous: who.anonymous === true, ...(who.chat && typeof who.chat === 'object' ? { chat: who.chat as SupportEvent['who']['chat'] } : {}) };
  return ev;
}
/** "$5.00 tip", "5 gifted subs", "500 bits", "Tier 2 sub". */
export function labelOf(ev: SupportEvent, c: Contribution, cur: string): string {
  if (c.gifted) return `${c.gifted} gifted sub${c.gifted === 1 ? '' : 's'}`;
  if (c.subs) return c.tier === 0 ? 'Prime sub' : c.tier > 1 ? `Tier ${c.tier} sub` : 'sub';
  if (c.members) return 'membership';
  if (c.bits) return `${c.bits.toLocaleString('en-US')} bits`;
  if (c.kicks) return `${c.kicks.toLocaleString('en-US')} Kicks`;
  if (c.money) return `${fmtMoney(c.money, cur)} ${ev.kind === 'superchat' ? 'Super Chat' : ev.kind === 'purchase' ? 'merch' : ev.kind === 'wishlist_gift' ? 'wishlist gift' : 'tip'}`;
  return ev.kind;
}
export { currentTarget };
