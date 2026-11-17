// The rules engine (docs/b16/RULES.md): listens to emitRuleTrigger, picks the rules an event fires (matchRules), keeps each rule's
// cooldown and gift-bomb queue (RuleGate), runs the steps (runRuleSteps) and, when a rule says "put back after N seconds",
// stamps what undoes the change. The stamps are plain JSON the studio keeps in SceneState.modes.rules, so a studio reload
// in the middle of a 60 second hat still takes the hat off.
//
// It lives in the STUDIO page (it owns SceneState and the bus; the helper forwards the triggers it notices as the bus command
// `rule-trigger`). Everything the engine needs from the outside world comes in through EngineDeps, so this file has no DOM, no
// fetch and no module state: tools/stream_rules_unit.ts runs it with a fake clock and fake timers.
//
// Cost when idle: nothing. One timer exists only while a revert stamp or a queued event is waiting; with none, no timer at all.
import {
  MAX_REVERT_SECS, RuleGate, matchRules, onRuleTrigger, runRuleSteps, sanitizeRevertStamps,
  type RuleActionCtx, type RuleActionHandler, type RuleActionResult, type RuleEvent, type RuleRevertStamp, type RuleStep, type StreamRule,
} from '../../shared/streamRules.ts';
import { planUndo, toggleKey, type UndoBefore } from './undo.ts';

/** At most this many pending reverts are kept (the stamp bag is capped at 6 KB). */
export const MAX_STAMPS = 24;

/**
 * Undo steps that put back ONE thing the studio has only one of (the outfit, the room, the lighting ...). Two rules that change the
 * same one overlap: whichever put-back runs last wins, so the avatar could end in a hat the first rule put on. Such a step is
 * chained instead: the slot goes back to what it was before the EARLIEST pending rule touched it, and only when the last rule
 * holding it lets go. (A toggle - accessory, model-slider - is not a slot: two flips undo each other in any order.)
 */
const SLOT_ACTIONS: ReadonlySet<string> = new Set(['lighting', 'mode', 'room', 'camera', 'costume', 'cover', 'chat-hide', 'weather']);
const slotOf = (u: RuleStep): string | undefined => (SLOT_ACTIONS.has(u.action) ? u.action : undefined);

/** A put-back step that failed because the lane that owns its action had not started yet (see src/b16/mount.ts): it is tried again. */
const NOT_READY = /No such action|Unknown action|not (ready|mounted|registered)/i;
export const RETRY_MS = 5_000;
export const MAX_RETRIES = 8;

export interface EngineDeps {
  now(): number;
  /** The current rule list (the engine never caches it: a switch in the panel counts at once). */
  rules(): StreamRule[];
  /** Runs a step nobody registered a handler for in this page: the Stream Deck registry through the helper. */
  fallback: RuleActionHandler;
  /** What the studio looks like right now (planUndo reads it just before an old deck action runs). */
  before(): UndoBefore;
  /** The saved revert stamps (SceneState.modes.rules) and where to save them. */
  loadStamps(): RuleRevertStamp[];
  saveStamps(stamps: RuleRevertStamp[]): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Called after every run, drop and revert (the panel's "last ran" line). */
  log?(entry: RuleLogEntry): void;
}

export type RuleLogKind = 'ran' | 'failed' | 'cooldown' | 'queued' | 'full' | 'reverted';
export interface RuleLogEntry { at: number; rule: string; name: string; kind: RuleLogKind; user?: string; detail?: string }

/** A rule with a queue is busy for at least its queue gap, so a gift bomb waits its turn even when the cooldown is 0. */
const gateRule = (r: StreamRule): StreamRule => (r.queue && r.queue.max > 0 && r.queue.gapMs / 1000 > r.cooldownSecs ? { ...r, cooldownSecs: r.queue.gapMs / 1000 } : r);

const sleepFor = (deps: EngineDeps) => (ms: number) => new Promise<void>((r) => { deps.setTimer(r, ms); });

export class RuleEngine {
  readonly gate = new RuleGate();
  private stamps: RuleRevertStamp[] = [];
  private timer: unknown = null;
  private timerAt = 0;
  private off: (() => void) | null = null;
  private listeners = new Set<() => void>();
  /** Last outcome per rule (for the panel). */
  readonly last = new Map<string, RuleLogEntry>();
  private busy = new Set<string>();
  /** Tries made so far to put back a stamp whose lane was not ready (in memory: a reload starts again from the saved stamp). */
  private tries = new Map<string, number>();
  private queued = new Set<string>();
  private ready = false;
  private waiting: RuleEvent[] = [];

  constructor(private deps: EngineDeps) {}

  /** Start listening. Events that arrive before resume() wait (up to 30 s) so nothing is lost while the studio is still loading. Safe to call twice. */
  start() {
    if (this.off) return;
    this.off = onRuleTrigger((e) => { void this.handle(e); });
  }
  /**
   * The studio is loaded (scene state read, avatar on): read the saved revert stamps (a reload in the middle of a hat still
   * takes the hat off), put back what is already due, and run the events that waited.
   */
  resume() {
    if (this.ready) return;
    this.ready = true;
    this.stamps = sanitizeRevertStamps(this.deps.loadStamps()).slice(0, MAX_STAMPS);
    const waited = this.waiting.splice(0);
    const now = this.deps.now();
    for (const e of waited) if (now - e.ts < 30_000) void this.handle(e);
    this.schedule();
  }
  stop() {
    this.off?.(); this.off = null; this.ready = false; this.waiting.length = 0;
    if (this.timer !== null) { this.deps.clearTimer(this.timer); this.timer = null; }
  }
  /** The panel redraws on this. Returns the unsubscribe. */
  onChange(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private changed() { for (const fn of [...this.listeners]) { try { fn(); } catch { /* a panel redraw must never stop the engine */ } } }

  /** Reverts waiting (a copy). */
  pending(): RuleRevertStamp[] { return this.stamps.map((s) => ({ ...s })); }

  private note(rule: StreamRule, kind: RuleLogKind, e?: RuleEvent, detail?: string) {
    const entry: RuleLogEntry = { at: this.deps.now(), rule: rule.id, name: rule.name, kind, ...(e?.user ? { user: e.user } : {}), ...(detail ? { detail } : {}) };
    this.last.set(rule.id, entry);
    try { this.deps.log?.(entry); } catch { /* logging is best effort */ }
    this.changed();
  }

  /** One event: every enabled rule it fires goes through the gate (cooldown, queue) and runs. */
  async handle(e: RuleEvent): Promise<void> {
    if (!this.ready) { if (this.waiting.length < 50) this.waiting.push(e); return; }
    const now = this.deps.now();
    for (const rule of matchRules(this.deps.rules(), e)) {
      // the Try-it button and the "run rule" key always run: a cooldown must never make a test look broken
      const verdict = e.kind === 'manual' ? 'run' : this.gate.offer(gateRule(rule), e, now);
      if (verdict === 'run') { if (e.kind === 'manual') this.gate.resetCooldown(rule.id); void this.run(rule, e); }
      else if (verdict === 'queued') { this.queued.add(rule.id); this.note(rule, 'queued', e); this.schedule(); }
      else this.note(rule, verdict === 'full' ? 'full' : 'cooldown', e);
    }
  }

  /** Run a rule's steps for an event, then stamp the revert. */
  private async run(rule: StreamRule, e: RuleEvent): Promise<void> {
    if (this.busy.has(rule.id + ':' + e.id)) return;
    this.busy.add(rule.id + ':' + e.id);
    try {
      const fallback = this.planningFallback(rule);
      const rep = await runRuleSteps(rule, e, { now: this.deps.now(), fallback, sleep: sleepFor(this.deps) });
      if (rep.failed.length && !rep.ran) this.note(rule, 'failed', e, rep.failed.map((f) => `${f.action}: ${f.error}`).join('; '));
      else this.note(rule, 'ran', e, rep.failed.length ? `${rep.failed.length} step(s) failed: ${rep.failed.map((f) => f.action).join(', ')}` : undefined);
      if (rule.revertSecs > 0 && rep.undo.length) this.stampRevert(rule, rep.undo);
    } finally {
      this.busy.delete(rule.id + ':' + e.id);
      this.schedule();
    }
  }

  /** The fallback that, for an old deck action, also remembers how to put it back (the new actions answer with their own undo). */
  private planningFallback(rule: StreamRule): RuleActionHandler {
    return async (ctx: RuleActionCtx): Promise<RuleActionResult | void> => {
      const before = this.deps.before();
      const planned = planUndo(ctx.step.action, ctx.params, before);
      // A toggle (accessory, model-slider toggle) that this rule already flipped and has not put back: running it again would take
      // it off. Skip the step; stampRevert only holds the revert longer and the original undo still puts it back.
      const key = toggleKey(ctx.step.action, ctx.params);
      if (key && planned && this.stamps.some((s) => s.rule === rule.id && s.undo.some((u) => toggleKey(u.action, u.params) === key))) return { ok: true, undo: planned };
      const r = await this.deps.fallback(ctx);
      if (r && r.ok === false) return r;
      const undo = (r && r.undo) || planned;
      return undo ? { ok: true, undo } : { ok: true };
    };
  }

  private stampRevert(rule: StreamRule, undo: RuleStep[]) {
    const now = this.deps.now();
    const until = now + Math.min(MAX_REVERT_SECS, rule.revertSecs) * 1000;
    const mine = this.stamps.find((s) => s.rule === rule.id);
    if (mine) {
      // it fired again before it was put back: keep the ORIGINAL state to go back to, just hold it longer
      mine.until = Math.max(mine.until, until);
    } else {
      this.stamps.push({ id: `${rule.id.slice(0, 30)}-${now.toString(36)}`, rule: rule.id, at: now, until, undo: undo.slice().reverse() });
      while (this.stamps.length > MAX_STAMPS) this.stamps.shift();
    }
    this.persist();
  }
  private persist() { try { this.deps.saveStamps(this.stamps.map((s) => ({ ...s }))); } catch { /* the revert still happens in memory */ } this.changed(); }

  /**
   * Put back what is due (all of it with `all`: the panel's "Put everything back now" and Stop). Newest first; a slot two rules
   * changed (planChain) goes back to its earliest original state, once, when the last rule holding it lets go.
   */
  async revertDue(all = false): Promise<number> {
    const now = this.deps.now();
    const due = this.stamps.filter((s) => all || s.until <= now);
    if (!due.length) { this.schedule(); return 0; }
    const plan = this.planChain(due);
    this.stamps = this.stamps.filter((s) => !due.includes(s));
    this.persist();
    for (const s of [...due].sort((a, b) => b.at - a.at)) {   // newest first (the sort is stable: equal times keep their order)
      const steps = plan.get(s) ?? [];
      const rule: StreamRule = this.deps.rules().find((r) => r.id === s.rule) ?? { id: s.rule, name: s.rule, enabled: true, when: [], then: s.undo, revertSecs: 0, cooldownSecs: 0 };
      if (!steps.length) { this.tries.delete(s.id); this.note(rule, 'reverted', undefined, 'left for a later rule that changed the same thing'); continue; }
      const undoRule: StreamRule = { ...rule, then: steps, revertSecs: 0 };
      const ev: RuleEvent = { kind: 'manual', id: 'revert:' + s.id, ts: now, via: s.rule, rule: s.rule, depth: 1 };
      try {
        // a revert is not planned again (no undo of an undo) and does not need the cooldown
        const rep = await runRuleSteps(undoRule, ev, { now, fallback: this.deps.fallback, sleep: sleepFor(this.deps) });
        const again = this.retryable(s, steps, rep.failed);
        this.note(rule, 'reverted', undefined, again ? `${again} step(s) wait for the studio to finish starting` : rep.failed.length ? `${rep.failed.length} step(s) could not be put back` : undefined);
      } catch (err) { this.note(rule, 'failed', undefined, (err as Error).message); }
    }
    this.schedule();
    return due.length;
  }

  /**
   * What each due stamp really runs. For every slot (SLOT_ACTIONS) the stamps holding it are ordered by when they started; the
   * EARLIEST holder knows the original state. Still-waiting holders are given that original (they put it back later), and the due
   * ones leave the slot alone; with no holder left waiting, only the earliest due holder puts the slot back.
   */
  private planChain(due: RuleRevertStamp[]): Map<RuleRevertStamp, RuleStep[]> {
    const plan = new Map<RuleRevertStamp, RuleStep[]>(due.map((s) => [s, s.undo.slice()]));
    const slots = new Set<string>();
    for (const s of due) for (const u of s.undo) { const k = slotOf(u); if (k) slots.add(k); }
    for (const slot of slots) {
      const holders = [...this.stamps].filter((s) => s.undo.some((u) => slotOf(u) === slot)).sort((a, b) => a.at - b.at);
      const first = holders[0];
      const waiting = holders.filter((h) => !due.includes(h));
      const original = [...first.undo].reverse().find((u) => slotOf(u) === slot)!;   // (a stamp runs its steps in order: the last one of a slot is the original)
      if (waiting.length) {
        for (const h of waiting) {
          let placed = false;
          h.undo = h.undo.flatMap((u) => (slotOf(u) !== slot ? [u] : placed ? [] : ((placed = true), [original])));
        }
        for (const d of due) plan.set(d, plan.get(d)!.filter((u) => slotOf(u) !== slot));
      } else {
        for (const d of due) if (d !== first) plan.set(d, plan.get(d)!.filter((u) => slotOf(u) !== slot));
      }
    }
    return plan;
  }

  /** Steps that failed because their lane was not ready yet go back on the list for a few more tries (the stamp keeps its start time, so it still chains right). */
  private retryable(s: RuleRevertStamp, steps: RuleStep[], failed: { action: string; error: string }[]): number {
    const late = new Set(failed.filter((f) => NOT_READY.test(f.error)).map((f) => f.action));
    const keep = steps.filter((u) => late.has(u.action));
    const n = (this.tries.get(s.id) ?? 0) + 1;
    if (!keep.length || n > MAX_RETRIES) { this.tries.delete(s.id); return 0; }
    this.tries.set(s.id, n);
    this.stamps.push({ id: s.id, rule: s.rule, at: s.at, until: this.deps.now() + RETRY_MS, undo: keep });
    this.persist();
    return keep.length;
  }

  /** Queued events whose rule is free again run now. */
  private drainQueues() {
    const now = this.deps.now();
    for (const rule of this.deps.rules()) {
      if (!this.gate.waiting(rule.id)) continue;
      if (!rule.enabled) { this.gate.clear(rule.id); continue; }
      const e = this.gate.take(gateRule(rule), now);
      if (e) void this.run(rule, e);
    }
  }

  /** Arm ONE timer for the nearest thing waiting (a revert due, a queued event ready); no timer when nothing waits. */
  private schedule() {
    let at = Infinity;
    for (const s of this.stamps) at = Math.min(at, s.until);
    for (const r of this.deps.rules()) if (this.gate.waiting(r.id)) at = Math.min(at, Math.max(this.gate.readyAt(r.id), this.deps.now()));
    if (this.timer !== null) {
      if (this.timerAt === at) return;
      this.deps.clearTimer(this.timer); this.timer = null;
    }
    if (!Number.isFinite(at)) return;
    this.timerAt = at;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      this.drainQueues();
      void this.revertDue().then(() => this.schedule());
    }, Math.max(20, at - this.deps.now()));
  }

  /** How many events wait for this rule, and when it can run again (for the panel). */
  state(ruleId: string) { return { waiting: this.gate.waiting(ruleId), readyAt: this.gate.readyAt(ruleId), revertAt: this.stamps.find((s) => s.rule === ruleId)?.until ?? 0 }; }

  /** A rule was switched off, deleted or edited: nothing queued for it runs any more (a pending revert still happens). */
  forget(ruleId: string) { this.gate.clear(ruleId); this.queued.delete(ruleId); this.schedule(); }
  /** The rule list changed: drop the line of every rule that is gone or off. */
  prune() {
    if (!this.queued.size) return;
    const rules = this.deps.rules();
    for (const id of [...this.queued]) { const r = rules.find((x) => x.id === id); if (!r || !r.enabled || !this.gate.waiting(id)) this.forget(id); }
  }
}

