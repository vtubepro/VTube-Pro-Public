// Keys & pads, the studio half (docs/b16/BINDINGS.md): owns the list of bindings (this browser's localStorage, like the phone
// buttons), listens to the four kinds of input, and runs the action a binding points at. Every input source is lazy:
//   * keys       one keydown/keyup listener pair, only while a key binding exists (global keys go through the helper, see
//                server/hotkeys/, and arrive here as the bus command `binding-hotkey`)
//   * MIDI       Web MIDI, only while a pad binding exists AND the user allowed it once
//   * controller the Gamepad API, a 16 ms timer only while a controller is plugged in and a controller binding exists
//   * hand signs a 66 ms read of the tracker's hand results, only while a hand-sign binding exists
// With no bindings nothing here runs at all. Every trigger is also handed to the rules (emitRuleTrigger), so a rule built on
// "when I press F13" works with or without a binding. An observer tab never acts.
import type { App } from '../app.ts';
import type { Bus } from '../bus.ts';
import { ACTION_BY_ID } from '../../shared/deck.ts';
import { comboOf, keyName, sanitizeCombo } from '../../shared/hotkey.ts';
import { emitRuleTrigger, getRuleAction, runRuleSteps, type RuleEvent, type RuleActionHandler, type StreamRule } from '../../shared/streamRules.ts';
import {
  BINDINGS_KEY, BINDINGS_SETTINGS_KEY, BindingEngine, DEFAULT_SETTINGS, MAX_BINDINGS, gamepadEvent, keyEvent, newBindingId, padEvent, sanitizeBinding, sanitizeBindings, sanitizeSettings,
  toCodeCombo, type Binding, type BindingAction, type BindingSettings, type BindingWhen, type FiredInfo, type MidiMsg, type RunFn,
} from './bindings.ts';
import { MidiSource } from './midiSource.ts';
import { GamepadSource } from './gamepadSource.ts';
import { HandSource } from './handSource.ts';

export type InputKind = 'key' | 'midi' | 'gamepad' | 'hand';
export type HelperState = 'none' | 'checking' | 'ok' | 'in-page' | 'offline';
export interface HelperInfo { state: HelperState; results: Record<string, { ok: boolean; why?: string }>; note: string }
export interface LearnResult { when: BindingWhen; /** A knob or slider (a MIDI control that sends many values). */ knob: boolean }
export interface LearnHandle { done: Promise<LearnResult | null>; cancel(): void }

const LEARN_MS = 30_000;
const CC_RULE_MS = 100;

// Other lanes (the Rules screen) can ask for an input to stay on, or for a global key, without owning a binding.
const extraInputs = new Map<InputKind, number>();
const extraKeys = new Map<string, number>();
let current: BindingsRuntime | null = null;
/** For the Rules screen: keep this kind of input listening (and its rule triggers flowing) while the returned release is not called. */
export function wantInput(kind: InputKind): () => void {
  extraInputs.set(kind, (extraInputs.get(kind) ?? 0) + 1); current?.refresh();
  let done = false;
  return () => { if (done) return; done = true; const n = (extraInputs.get(kind) ?? 1) - 1; if (n > 0) extraInputs.set(kind, n); else extraInputs.delete(kind); current?.refresh(); };
}
/** For the Rules screen: make this key combo (global when the helper can) emit `key` rule triggers. */
export function wantKey(combo: string): () => void {
  const c = sanitizeCombo(combo);
  if (!c) return () => {};
  extraKeys.set(c, (extraKeys.get(c) ?? 0) + 1); current?.refresh();
  let done = false;
  return () => { if (done) return; done = true; const n = (extraKeys.get(c) ?? 1) - 1; if (n > 0) extraKeys.set(c, n); else extraKeys.delete(c); current?.refresh(); };
}
export const getBindings = (): BindingsRuntime | null => current;

const isTyping = (t: EventTarget | null) => { const el = t as HTMLElement | null; return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable); };

export class BindingsRuntime {
  list: Binding[] = [];
  settings: BindingSettings = { ...DEFAULT_SETTINGS };
  helper: HelperInfo = { state: 'none', results: {}, note: '' };
  lastFired: FiredInfo | null = null;
  readonly engine: BindingEngine;
  readonly midi: MidiSource;
  readonly pads: GamepadSource;
  private hands: HandSource | null = null;
  private listeners = new Set<() => void>();
  private offBus: (() => void) | null = null;
  private keysOn = false;
  private heldKeys = new Map<string, string>();          // key name -> combo, for key-up
  private heldGlobal = new Set<string>();
  private ccHigh = new Map<string, boolean>();
  private ccRuleAt = new Map<number, number>();
  private learning: { resolve: (r: LearnResult | null) => void; cc: Map<number, { n: number; lo: number; hi: number; mid: number }>; timer: number } | null = null;
  private syncTimer = 0;
  private helperTouched = false;
  private started = false;
  private peeking = 0;

  constructor(readonly app: App, readonly bus: Bus) {
    this.engine = new BindingEngine({ run: this.run });
    this.engine.onFired((f) => { this.lastFired = f; this.changed(); });
    this.midi = new MidiSource((m) => this.onMidi(m), () => this.changed());
    this.pads = new GamepadSource({ press: (b, p) => this.fire(gamepadEvent(b, p)), release: (b, p) => void this.engine.up(gamepadEvent(b, p)), lost: () => void this.engine.releaseAll() }, () => this.changed());
  }

  // ---------------------------------------------------------------- lifecycle

  start() {
    if (this.started) return;
    this.started = true; current = this;
    this.list = this.load();
    this.settings = this.loadSettings();
    this.engine.set(this.list);
    this.offBus = this.bus.on((m) => {
      if (m.type !== 'command') return;
      if (m.command === 'binding-hotkey') this.onHotkey(m.args);
    });
    const offLink = this.bus.onLink((up) => { if (up) this.queueSync(); else { this.heldGlobal.clear(); void this.engine.releaseAll(); } });
    const off = this.offBus;
    this.offBus = () => { off(); offLink(); };
    this.refresh();
  }
  stop() {
    this.started = false;
    if (current === this) current = null;
    this.offBus?.(); this.offBus = null;
    this.cancelLearn();
    this.setKeys(false);
    this.midi.stop(); this.pads.stop(); this.hands?.stop(); this.hands = null;
    void this.engine.releaseAll(); this.engine.dispose();
    clearTimeout(this.syncTimer);
    if (this.helperTouched) void this.putKeys([]);
  }
  on(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private changed() { for (const fn of [...this.listeners]) { try { fn(); } catch { /* a screen never stops the input */ } } }

  // ---------------------------------------------------------------- storage

  private load(): Binding[] { try { return sanitizeBindings(JSON.parse(localStorage.getItem(BINDINGS_KEY) ?? '[]')); } catch { return []; } }
  private loadSettings(): BindingSettings { try { return sanitizeSettings(JSON.parse(localStorage.getItem(BINDINGS_SETTINGS_KEY) ?? 'null')); } catch { return { ...DEFAULT_SETTINGS }; } }
  /** Replace the whole list (cleaned). Returns what is stored now. */
  save(next: readonly Binding[]): Binding[] {
    this.list = sanitizeBindings(next);
    try { localStorage.setItem(BINDINGS_KEY, JSON.stringify(this.list)); } catch { /* storage off: it works until the tab closes */ }
    this.engine.set(this.list);
    this.refresh();
    this.changed();
    return this.list;
  }
  add(b: Omit<Binding, 'id'>): Binding | null {
    if (this.list.length >= MAX_BINDINGS) return null;
    const made = sanitizeBinding({ ...b, id: newBindingId(this.list.map((x) => x.id)) }, this.list.map((x) => x.id));
    if (!made) return null;
    this.save([...this.list, made]);
    return made;
  }
  update(id: string, patch: Partial<Binding>) { this.save(this.list.map((b) => (b.id === id ? { ...b, ...patch, id } : b))); }
  remove(id: string) { this.save(this.list.filter((b) => b.id !== id)); }
  saveSettings(s: Partial<BindingSettings>) {
    this.settings = sanitizeSettings({ ...this.settings, ...s });
    try { localStorage.setItem(BINDINGS_SETTINGS_KEY, JSON.stringify(this.settings)); } catch { /* storage off */ }
    this.refresh(); this.changed();
  }
  /** The keys the loaded 2D model binds itself (KeyboardEvent.code spelling). */
  modelKeys(): string[] {
    try {
      const fl = this.app.runtime?.flat;
      if (!fl) return [];
      return [...fl.expressions().map((x) => x.key), ...fl.motions().map((x) => x.key)].filter((k): k is string => !!k);
    } catch { return []; }
  }

  // ---------------------------------------------------------------- what is listening

  private enabled(kind: BindingWhen['kind']): Binding[] { return this.list.filter((b) => b.on && b.when.kind === kind); }
  private wanted = new Set<string>();                  // the combos (lower case) any key handler may act on, rebuilt by refresh()
  private wantedKeys(): Set<string> { return this.wanted; }
  private rebuildWanted() {
    const s = new Set<string>();
    for (const b of this.enabled('key')) if (b.when.kind === 'key') s.add(b.when.combo.toLowerCase());
    for (const c of extraKeys.keys()) s.add(c.toLowerCase());
    this.wanted = s;
  }
  /** Hold times the hand tracker reports: the setting first, then any longer one a binding asked for. */
  handThresholds(): number[] {
    if (this.learning) return [500];
    const d = this.settings.handHoldMs, set = new Set<number>([d]);
    for (const b of this.enabled('hand')) if (b.when.kind === 'hand' && (b.when.holdMs ?? 0) > d) set.add(b.when.holdMs as number);
    return [...set].sort((a, b) => a - b);
  }

  /** Start or stop each source to match what is needed now. Cheap; called after every change. */
  refresh() {
    if (!this.started) return;
    const learn = !!this.learning;
    this.rebuildWanted();
    this.setKeys(learn || this.wantedKeys().size > 0);
    const wantMidi = learn || this.enabled('pad').length > 0 || extraInputs.has('midi');
    if (wantMidi) void this.midi.start(false); else if (this.midi.state === 'on') this.midi.stop();
    if (learn || this.peeking > 0 || this.enabled('gamepad').length > 0 || extraInputs.has('gamepad')) this.pads.start(); else this.pads.stop();
    const wantHands = learn || this.enabled('hand').length > 0 || extraInputs.has('hand');
    if (wantHands) { this.hands ??= new HandSource(this.app, { down: (ev, first) => this.onHand(ev, first), up: (ev) => this.onHandUp(ev) }, () => this.handThresholds(), () => this.changed()); this.hands.start(); }
    else if (this.hands) { this.hands.stop(); this.hands = null; }
    this.queueSync();
  }

  /** The Keys & pads screen is open: listen for controllers (only the plug-in events, plus the 16 ms read while one is connected) so it can show them. */
  peek(): () => void {
    this.peeking++; this.refresh();
    let done = false;
    return () => { if (done) return; done = true; this.peeking = Math.max(0, this.peeking - 1); this.refresh(); };
  }
  get handsSeenRecently(): boolean { return !!this.hands && performance.now() - this.hands.lastSeen < 3000; }
  get handsListening(): boolean { return !!this.hands?.running; }

  // ---------------------------------------------------------------- firing

  /** One trigger happened: tell the rules, then run the bindings that match. */
  private fire(ev: RuleEvent, emit = true) {
    if (this.app.observer) return;
    if (this.learning) { this.learnFrom(ev); return; }
    if (emit) emitRuleTrigger(ev);
    void this.engine.down(ev);
  }

  private onMidi(m: MidiMsg) {
    if (this.app.observer) return;
    if (this.learning) { this.learnMidi(m); return; }
    const ev = padEvent(m);
    if (m.type === 'on') { this.fire(ev); return; }
    if (m.type === 'off') { void this.engine.up(ev); return; }
    // a control that sends many values: knob bindings get the value; a CC that behaves like a button (a jump over the middle) presses
    this.engine.knob(ev);
    const k = `${m.ch}:${m.cc}`, was = this.ccHigh.get(k) ?? false, high = m.value >= 0.5;
    this.ccHigh.set(k, high);
    const t = performance.now();
    if ((t - (this.ccRuleAt.get(m.cc ?? 0) ?? 0)) >= CC_RULE_MS) { this.ccRuleAt.set(m.cc ?? 0, t); emitRuleTrigger(ev); }
    if (high && !was) void this.engine.down(ev);
    else if (!high && was) void this.engine.up(ev);
  }

  private onHand(ev: RuleEvent, first: boolean) {
    if (this.app.observer) return;
    if (this.learning) { this.learnFrom(ev); return; }
    if (first) emitRuleTrigger(ev);
    void this.engine.down(ev);
  }
  private onHandUp(ev: RuleEvent) { void this.engine.up(ev); }

  // ---------------------------------------------------------------- keys (inside the page)

  private setKeys(on: boolean) {
    if (on === this.keysOn) return;
    this.keysOn = on;
    if (on) { window.addEventListener('keydown', this.onKeyDown, true); window.addEventListener('keyup', this.onKeyUp, true); window.addEventListener('blur', this.onBlur); }
    else { window.removeEventListener('keydown', this.onKeyDown, true); window.removeEventListener('keyup', this.onKeyUp, true); window.removeEventListener('blur', this.onBlur); this.heldKeys.clear(); }
  }
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat || this.app.observer) return;
    const combo = comboOf(e);
    if (!combo) return;
    if (this.learning) {
      e.preventDefault(); e.stopPropagation();
      if (combo === 'Esc') { this.cancelLearn(); return; }
      this.learnFrom(keyEvent(combo));
      return;
    }
    if (!this.wantedKeys().has(combo.toLowerCase())) return;
    if (isTyping(e.target) && !e.ctrlKey && !e.altKey && !e.metaKey) return;      // typing a name: a bare key is a letter, not a trigger
    e.preventDefault();
    const k = keyName(e); if (k) this.heldKeys.set(k, combo);
    this.fire(keyEvent(combo));
  };
  private onKeyUp = (e: KeyboardEvent) => {
    const k = keyName(e); if (!k) return;
    const combo = this.heldKeys.get(k);
    if (combo) { this.heldKeys.delete(k); void this.engine.up(keyEvent(combo)); }
  };
  private onBlur = () => { this.heldKeys.clear(); void this.engine.releaseAll(); };

  /** A global key the helper saw (it only ever reports combos this studio asked it to hold). */
  private onHotkey(args: unknown) {
    const a = (args && typeof args === 'object' ? args : {}) as { combo?: unknown; phase?: unknown };
    const combo = sanitizeCombo(a.combo);
    if (!combo || !this.wantedKeys().has(combo.toLowerCase())) return;
    if (a.phase === 'up') { if (this.heldGlobal.delete(combo)) void this.engine.up(keyEvent(combo)); return; }
    if (a.phase !== 'down' || this.heldGlobal.has(combo)) return;
    this.heldGlobal.add(combo);
    this.fire(keyEvent(combo));
  }

  // ---------------------------------------------------------------- teaching ("Learn")

  /** Wait for the next key, MIDI pad or knob, controller button or hand sign and say which. Esc or 30 s cancels. */
  learn(): LearnHandle {
    this.cancelLearn();
    const done = new Promise<LearnResult | null>((resolve) => {
      this.learning = { resolve, cc: new Map(), timer: window.setTimeout(() => this.finishLearn(null), LEARN_MS) };
    });
    if (this.helperTouched) void this.putKeys([]);            // a key VTube Pro holds would never reach the page: let go while teaching
    void this.midi.start(true).then(() => this.changed());    // (the click that called learn() is the user gesture the browser wants)
    this.refresh();
    this.changed();
    return { done, cancel: () => this.cancelLearn() };
  }
  get isLearning() { return !!this.learning; }
  cancelLearn() { if (this.learning) this.finishLearn(null); }
  private finishLearn(r: LearnResult | null) {
    const l = this.learning; if (!l) return;
    this.learning = null;
    clearTimeout(l.timer);
    l.resolve(r);
    this.refresh();
    this.changed();
  }
  private learnFrom(ev: RuleEvent) {
    switch (ev.kind) {
      case 'key': this.finishLearn({ when: { kind: 'key', combo: ev.combo }, knob: false }); break;
      case 'gamepad': this.finishLearn({ when: { kind: 'gamepad', button: ev.button, ...(ev.pad ? { pad: ev.pad } : {}) }, knob: false }); break;
      case 'hand': this.finishLearn({ when: { kind: 'hand', sign: ev.sign, side: 'any' }, knob: false }); break;
      case 'pad': this.finishLearn({ when: ev.cc !== undefined ? { kind: 'pad', cc: ev.cc } : { kind: 'pad', note: ev.note ?? 0 }, knob: false }); break;
    }
  }
  private learnMidi(m: MidiMsg) {
    const l = this.learning; if (!l) return;
    if (m.type === 'on') { this.finishLearn({ when: { kind: 'pad', note: m.note ?? 0 }, knob: false }); return; }
    if (m.type !== 'cc' || m.cc === undefined) return;
    const s = l.cc.get(m.cc) ?? { n: 0, lo: 1, hi: 0, mid: 0 };
    s.n++; s.lo = Math.min(s.lo, m.value); s.hi = Math.max(s.hi, m.value); if (m.value > 0.1 && m.value < 0.9) s.mid++;
    l.cc.set(m.cc, s);
    // values in between = a knob or slider; only the two ends = a button that talks CC
    if (s.mid >= 2 && s.hi - s.lo > 0.12) this.finishLearn({ when: { kind: 'pad', cc: m.cc }, knob: true });
    else if (s.n >= 2 && s.mid === 0 && s.hi >= 0.9 && s.lo <= 0.1) this.finishLearn({ when: { kind: 'pad', cc: m.cc }, knob: false });
  }

  // ---------------------------------------------------------------- running an action

  /** A binding's action: a rule action somebody registered in this page, else the Stream Deck action of that id on the helper. */
  private run: RunFn = async (a: BindingAction, ctx) => {
    const rule: StreamRule = { id: `binding-${ctx.binding.id}`, name: ctx.binding.name || ctx.binding.id, enabled: true, when: [ctx.binding.when], then: [{ action: a.action, ...(a.params ? { params: a.params } : {}) }], revertSecs: 0, cooldownSecs: 0 };
    const rep = await runRuleSteps(rule, ctx.event, { noDelay: true, fallback: deckFallback });
    if (rep.failed.length) return { ok: false, error: rep.failed[0].error };
    return { ok: true, undo: rep.undo.map((u) => ({ action: u.action, ...(u.params ? { params: u.params } : {}) })) };
  };

  /** "Try it". */
  test(b: Binding) { return this.engine.tryNow(b); }
  /** Does a registered rule action of this id exist in this page, and can it be put back? */
  ruleActionUndoable(id: string): boolean { return !!getRuleAction(id)?.meta.undoable; }

  // ---------------------------------------------------------------- the helper's global keys

  /** What the helper should hold: every enabled key binding (one id each) plus the keys the Rules screen asked for. */
  private helperKeys(): { id: string; combo: string }[] {
    if (this.learning) return [];
    const out: { id: string; combo: string }[] = [], seen = new Set<string>();
    for (const b of this.enabled('key')) if (b.when.kind === 'key' && !seen.has(b.when.combo)) { seen.add(b.when.combo); out.push({ id: b.id, combo: b.when.combo }); }
    let i = 1;
    for (const c of extraKeys.keys()) if (!seen.has(c)) { seen.add(c); out.push({ id: `x${i++}`, combo: c }); }
    return out;
  }
  private queueSync() {
    clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => void this.syncHelper(), 250);
  }
  /** Tell the helper which keys to hold. Public so the panel's "Check again" can call it. */
  async syncHelper() {
    if (!this.started || this.app.observer) return;
    const keys = this.helperKeys();
    if (!keys.length && !this.helperTouched) { if (this.helper.state !== 'none') { this.helper = { state: 'none', results: {}, note: '' }; this.changed(); } return; }
    this.helperTouched = true;
    if (keys.length) { this.helper = { ...this.helper, state: 'checking' }; this.changed(); }
    const r = await this.putKeys(keys);
    if (r) { this.helper = r; this.changed(); }
  }
  private async putKeys(keys: { id: string; combo: string }[]): Promise<HelperInfo | null> {
    try {
      const res = await fetch('/api/hotkeys', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys }) });
      if (!res.ok) return { state: 'offline', results: {}, note: 'VTube Pro said no. Keys work while this tab is in front.' };
      const j = await res.json() as { supported?: boolean; results?: { id: string; ok: boolean; why?: string }[]; note?: string };
      const results: HelperInfo['results'] = {};
      for (const x of j.results ?? []) results[x.id] = { ok: !!x.ok, ...(x.why ? { why: String(x.why) } : {}) };
      if (j.supported === false) return { state: keys.length ? 'in-page' : 'none', results, note: 'Keys that work inside games need Windows. On this computer a key works while the VTube Pro tab is in front.' };
      return { state: keys.length ? 'ok' : 'none', results, note: j.note ?? '' };
    } catch {
      return keys.length ? { state: 'offline', results: {}, note: 'VTube Pro isn’t answering, so keys work while this tab is in front.' } : null;
    }
  }

  /** The words and facts the panel shows about each input. */
  status() {
    return {
      helper: this.helper,
      midi: { state: this.midi.state, ports: this.midi.ports.slice(), error: this.midi.error, allowedBefore: this.midi.allowedBefore },
      controllers: this.pads.names.slice(),
      hands: { listening: this.handsListening, seen: this.handsSeenRecently },
      tabHidden: typeof document !== 'undefined' && document.hidden,
    };
  }
  /** Ask the browser for MIDI now (from a click). */
  async allowMidi() { const ok = await this.midi.start(true); this.refresh(); return ok; }
  /** Same key, Code spelling, for the model-key check. */
  codeOf(combo: string) { return toCodeCombo(combo); }
}

/** The fallback for a binding whose action is a Stream Deck action (every old action, and the new ones from other lanes). */
const deckFallback: RuleActionHandler = async ({ step, params }) => {
  if (!ACTION_BY_ID.has(step.action)) return { ok: false, error: `“${step.action}” isn’t an action any more.` };
  try {
    const res = await fetch(`/api/deck/run/${encodeURIComponent(step.action)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ params }) });
    if (res.ok) return { ok: true };
    let why = '';
    try { why = String(((await res.json()) as { error?: string }).error ?? ''); } catch { /* not JSON */ }
    return { ok: false, error: why || `VTube Pro said ${res.status}.` };
  } catch { return { ok: false, error: 'VTube Pro isn’t answering.' }; }
};
