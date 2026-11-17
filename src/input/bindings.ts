// Keys & pads (beta.16 "bindings" lane, docs/b16/BINDINGS.md): press a key in your game, tap a MIDI pad, push a controller
// button or make a hand sign, and the avatar reacts. This file is the PURE half (no DOM, no network, no timers): what a
// binding is, how it is cleaned and described in plain words, which keys are safe to take system-wide, the MIDI parser, the
// controller button diff, and the BindingEngine that turns a trigger into an action ("only while I hold it" included).
// The studio (src/input/runtime.ts) and the helper (server/hotkeys/*) both import it; tools/bindings_unit.ts tests it.
//
// A binding is a one-step rule: when (key | pad | gamepad | hand, exactly the RuleWhen shapes of shared/streamRules.ts)
// then do (a Stream Deck action id from shared/deck.ts, or an action another lane registered with registerRuleAction).
// Every trigger is ALSO handed to the rules (emitRuleTrigger), so a rule built on "when I press F13" works too.
import { HAND_SIGNS, matchWhen, sanitizeWhen, type RuleEvent, type RuleWhen } from '../../shared/streamRules.ts';
import { comboConflict, comboLabel, sanitizeCombo } from '../../shared/hotkey.ts';
import { reservedKey } from '../../shared/studioKeys.ts';
import { ACTION_BY_ID } from '../../shared/deck.ts';

// ---------------------------------------------------------------- data

export const BINDINGS_KEY = 'vtp.bindings';
export const BINDINGS_SETTINGS_KEY = 'vtp.bindings.settings';
export const MAX_BINDINGS = 40;
/** "Only while I hold it" expression: how long the face stays if the release never arrives (a lost key-up must not stick). */
export const HOLD_EXPRESSION_SECS = 30;
/** Same binding twice within this many ms is one press (key auto-repeat, a bouncing controller button). */
export const MIN_GAP_MS = 120;
/** A knob sends at most this many values a second to the action. */
export const KNOB_HZ = 10;
export const DEFAULT_HAND_HOLD_MS = 400;

export type BindingWhen = Extract<RuleWhen, { kind: 'key' | 'pad' | 'gamepad' | 'hand' }>;
export type TriggerKind = BindingWhen['kind'];
export const TRIGGER_KINDS: readonly TriggerKind[] = ['key', 'pad', 'gamepad', 'hand'];
export type ParamValue = string | number | boolean;
export interface BindingAction { action: string; params?: Record<string, ParamValue> }
/** A MIDI knob / slider (cc): its value 0..1 is written into `do.params[param]` between min and max. */
export interface KnobMap { param: string; min: number; max: number }
export interface Binding {
  /** a-z0-9-, unique. */
  id: string;
  /** The words the user gave it ('' = we say what it does). */
  name: string;
  on: boolean;
  when: BindingWhen;
  do: BindingAction;
  /** Put it back when I let go (key / pad / controller button released, hand sign dropped). Only for actions that can be put back. */
  hold?: boolean;
  knob?: KnobMap;
}
export interface BindingSettings {
  /** Hand signs count after being held this long (ms). */
  handHoldMs: number;
}
export const DEFAULT_SETTINGS: BindingSettings = { handHoldMs: DEFAULT_HAND_HOLD_MS };

export type HandSign = (typeof HAND_SIGNS)[number] | 'wave';
export const SIGN_LABEL: Record<string, string> = {
  thumbs_up: 'Thumbs up 👍', thumbs_down: 'Thumbs down 👎', peace: 'Peace sign ✌️', love: 'I love you 🤟', fist: 'Fist ✊', point: 'Point up ☝️',
  wave: 'Wave 👋', palm: 'Open hand ✋', rock: 'Rock on 🤘',
};
/** The signs the panel offers (palm is a resting hand, so it stays out of the list unless a file asks for it). */
export const PICKABLE_SIGNS: readonly string[] = ['thumbs_up', 'thumbs_down', 'peace', 'love', 'rock', 'fist', 'point', 'wave'];

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const ID = /^[a-z0-9-]{1,32}$/;
const ACTION = /^[a-z][a-z0-9-]{0,47}$/;
const PARAM_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

export function newBindingId(taken: Iterable<string> = []): string {
  const t = new Set(taken);
  for (;;) { const id = 'b' + Math.random().toString(36).slice(2, 8); if (!t.has(id)) return id; }
}

function cleanParams(v: unknown): Record<string, ParamValue> | undefined {
  const o = rec(v), out: Record<string, ParamValue> = {};
  for (const [k, x] of Object.entries(o).slice(0, 12)) {
    if (!PARAM_KEY.test(k)) continue;
    if (typeof x === 'string') out[k] = clean(x, 200);
    else if (typeof x === 'number' && Number.isFinite(x)) out[k] = x;
    else if (typeof x === 'boolean') out[k] = x;
  }
  return Object.keys(out).length ? out : undefined;
}

/** A trigger as a binding may hold it: key / pad / gamepad / hand only, keys re-spelled the way shared/hotkey.ts does. */
export function sanitizeBindingWhen(o: unknown): BindingWhen | null {
  const x = rec(o);
  if (!(TRIGGER_KINDS as readonly unknown[]).includes(x.kind)) return null;
  const src = x.kind === 'key' ? { ...x, combo: sanitizeCombo(x.combo) ?? '' } : x;
  const w = sanitizeWhen(src);
  return w && (TRIGGER_KINDS as readonly string[]).includes(w.kind) ? w as BindingWhen : null;
}

export function sanitizeBinding(o: unknown, taken: Iterable<string> = []): Binding | null {
  const x = rec(o);
  const when = sanitizeBindingWhen(x.when);
  const d = rec(x.do), action = typeof d.action === 'string' ? d.action.trim() : '';
  if (!when || !ACTION.test(action)) return null;
  const used = new Set(taken);
  const id = typeof x.id === 'string' && ID.test(x.id) && !used.has(x.id) ? x.id : newBindingId(used);
  const params = cleanParams(d.params);
  const k = rec(x.knob);
  const knob: KnobMap | undefined = when.kind === 'pad' && when.cc !== undefined && typeof k.param === 'string' && PARAM_KEY.test(k.param) && Number.isFinite(k.min) && Number.isFinite(k.max)
    ? { param: k.param, min: Number(k.min), max: Number(k.max) } : undefined;
  return {
    id, name: clean(x.name, 60), on: x.on !== false, when,
    do: { action, ...(params ? { params } : {}) },
    ...(x.hold === true && !knob ? { hold: true } : {}),
    ...(knob ? { knob } : {}),
  };
}

/** Clean an untrusted list (localStorage, an import): known fields only, at most MAX_BINDINGS, ids unique. */
export function sanitizeBindings(v: unknown): Binding[] {
  const out: Binding[] = [], ids = new Set<string>();
  for (const o of Array.isArray(v) ? v : []) {
    if (out.length >= MAX_BINDINGS) break;
    const b = sanitizeBinding(o, ids);
    if (b) { out.push(b); ids.add(b.id); }
  }
  return out;
}

export function sanitizeSettings(v: unknown): BindingSettings {
  const x = rec(v), n = typeof x.handHoldMs === 'number' && Number.isFinite(x.handHoldMs) ? x.handHoldMs : DEFAULT_HAND_HOLD_MS;
  return { handHoldMs: Math.round(Math.min(3000, Math.max(0, n))) };
}

// ---------------------------------------------------------------- plain words

export const GAMEPAD_BUTTONS = ['A (bottom)', 'B (right)', 'X (left)', 'Y (top)', 'left bumper', 'right bumper', 'left trigger', 'right trigger', 'Back / Select', 'Start / Menu',
  'left stick press', 'right stick press', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'Home / Guide'];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (n: number) => `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;

export function describeWhen(w: BindingWhen): string {
  switch (w.kind) {
    case 'key': return comboLabel(w.combo);
    case 'pad': {
      const ch = w.channel ? ` (channel ${w.channel})` : '';
      return w.cc !== undefined ? `MIDI knob / slider ${w.cc}${ch}` : `MIDI pad ${noteName(w.note ?? 0)}${ch}`;
    }
    case 'gamepad': return `Controller ${GAMEPAD_BUTTONS[w.button] ?? `button ${w.button}`}${w.pad ? ` (controller ${w.pad + 1})` : ''}`;
    case 'hand': {
      const side = w.side === 'left' ? 'left hand' : w.side === 'right' ? 'right hand' : 'either hand';
      return `${SIGN_LABEL[w.sign] ?? w.sign}, ${side}`;
    }
  }
}

export function actionLabel(id: string): string { return ACTION_BY_ID.get(id)?.label ?? id; }
/** "Expression: happy" / "Emote: wave" / "Hide my screen". */
export function describeDo(d: BindingAction): string {
  const def = ACTION_BY_ID.get(d.action);
  const shown = Object.entries(d.params ?? {}).filter(([k, v]) => v !== '' && v !== 'toggle' && !/^(seconds|secs|count|ms)$/.test(k) && typeof v !== 'boolean').map(([, v]) => String(v)).slice(0, 2);
  const label = def?.label ?? d.action;
  return shown.length ? `${label}: ${shown.join(', ')}` : label;
}
export function describeBinding(b: Binding): string { return b.name || `${describeWhen(b.when)} → ${describeDo(b.do)}`; }

// ---------------------------------------------------------------- keys

const NAMED_CODE: Record<string, string> = { Esc: 'Escape', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' };
/** "Ctrl+Shift+B" (shared/hotkey.ts) → the studio's "Ctrl+Shift+KeyB" (shared/studioKeys.ts, shared/rig2d/userParams.ts). */
export function toCodeCombo(combo: string): string {
  const parts = combo.split('+'), key = parts.pop() ?? '';
  const code = /^[A-Z]$/.test(key) ? `Key${key}` : /^[0-9]$/.test(key) ? `Digit${key}` : /^Num([0-9])$/.test(key) ? `Numpad${key.slice(3)}` : NAMED_CODE[key] ?? key;
  return [...parts, code].join('+');
}

const BARE_OK = /^(F(1[3-9]|2[0-4])|Pause|ScrollLock)$/;
const WIN_KEEPS = new Set(['Ctrl+Alt+Delete', 'Ctrl+Shift+Esc', 'Alt+F4', 'Alt+Tab', 'Alt+Esc', 'Alt+Space', 'Ctrl+Esc', 'Ctrl+F4', 'Ctrl+F5', 'Ctrl+Tab', 'Alt+Shift+Tab', 'Ctrl+Shift+Tab', 'Shift+F10', 'Meta+L', 'Meta+D', 'Meta+Tab', 'Meta+Space']);
/**
 * Can this combo be taken system-wide (while a game has focus)? A taken key stops working in EVERY program, so a bare letter,
 * Ctrl+C, Alt+F4 and friends are refused. Plain words, or null when it is fine.
 */
export function globalKeyProblem(combo: string): string | null {
  const c = sanitizeCombo(combo);
  if (!c) return 'That isn’t a key VTube Pro can use.';
  const parts = c.split('+'), key = parts[parts.length - 1], mods = parts.slice(0, -1);
  if (WIN_KEEPS.has(c)) return 'Windows keeps that one for itself.';
  if (mods.includes('Meta')) return 'Windows keeps most Windows-key shortcuts for itself. Use Ctrl + Alt or Ctrl + Shift instead.';
  if (BARE_OK.test(key)) return null;
  if (mods.length >= 2) return null;
  if (mods.length === 1 && /^F([2-9]|1[0-2])$/.test(key)) return null;
  return 'This key would stop working in every other program. Add a second key like Ctrl + Alt, or use F13–F24 or Pause.';
}

export interface KeyAdvice { block: string | null; warn: string | null }
/**
 * What to tell the user about a key before saving it. `block` = can't be used; `warn` = works, but it clashes with something.
 * `modelKeys` = the keys the loaded 2D model has bound (KeyboardEvent.code spelling, like shared/studioKeys.ts).
 */
export function keyAdvice(combo: string, opt: { global: boolean; modelKeys?: readonly string[] }): KeyAdvice {
  const c = sanitizeCombo(combo);
  if (!c) return { block: 'That isn’t a key VTube Pro can use.', warn: null };
  if (opt.global) { const p = globalKeyProblem(c); if (p) return { block: p, warn: null }; }
  const code = toCodeCombo(c), norm = (s: string) => s.replace(/Numpad(\d)$/, 'Digit$1');
  if ((opt.modelKeys ?? []).some((k) => norm(k) === norm(code))) return { block: null, warn: 'Your model already uses this key for its own expression. Both would happen.' };
  const own = reservedKey(code);
  if (own) return { block: null, warn: `In the studio this key ${own}.` };
  if (!opt.global) { const w = comboConflict(c); if (w) return { block: null, warn: w }; }
  return { block: null, warn: null };
}

// ---------------------------------------------------------------- MIDI

export interface MidiMsg { type: 'on' | 'off' | 'cc'; ch: number; note?: number; cc?: number; /** 0..1 */ value: number }
/** One Web MIDI message → what it means. Note on with velocity 0 is a note off. Clock, pitch bend, program change, SysEx → null. */
export function parseMidi(d: ArrayLike<number> | null | undefined): MidiMsg | null {
  if (!d || d.length < 2) return null;
  const st = d[0] & 0xf0, ch = (d[0] & 0x0f) + 1, a = d[1] & 0x7f, b = (d.length > 2 ? d[2] : 0) & 0x7f;
  if (st === 0x90) return b > 0 ? { type: 'on', ch, note: a, value: b / 127 } : { type: 'off', ch, note: a, value: 0 };
  if (st === 0x80) return { type: 'off', ch, note: a, value: 0 };
  if (st === 0xb0) return { type: 'cc', ch, cc: a, value: b / 127 };
  return null;
}

// ---------------------------------------------------------------- controller

/** Which buttons went down / up between two polls. `prev` undefined = first look (nothing counts as a press). */
export function diffButtons(prev: readonly boolean[] | undefined, cur: readonly boolean[]): { pressed: number[]; released: number[] } {
  const pressed: number[] = [], released: number[] = [];
  if (!prev) return { pressed, released };
  for (let i = 0; i < cur.length; i++) {
    if (cur[i] && !prev[i]) pressed.push(i);
    else if (!cur[i] && prev[i]) released.push(i);
  }
  return { pressed, released };
}

// ---------------------------------------------------------------- hand signs

type Side = 'left' | 'right';
const MP_SIGN: Record<string, HandSign> = { Thumb_Up: 'thumbs_up', Thumb_Down: 'thumbs_down', Victory: 'peace', ILoveYou: 'love', Closed_Fist: 'fist', Pointing_Up: 'point', Open_Palm: 'palm' };
/**
 * The sign this frame shows. MediaPipe knows seven of them; "rock on" (index and little finger up, thumb tucked) is read from
 * the finger bend the body solver already measured (curls: [thumb, index, middle, ring, little] x joints, radians, + = bent).
 */
export function signFrom(name: string | null | undefined, score: number, curls?: readonly (readonly number[])[] | null): HandSign | null {
  const known = name && score > 0.55 ? MP_SIGN[name] ?? null : null;
  if (known && known !== 'palm' && known !== 'fist') return known;
  if (curls && curls.length >= 5 && score > 0.4) {
    const bend = (f: number) => { const c = curls[f] ?? []; return (c[0] ?? 0) + (c[1] ?? 0); };
    const up = (f: number) => bend(f) < 0.7, down = (f: number) => bend(f) > 1.6;
    if (up(1) && up(4) && down(2) && down(3) && !(known === 'fist' && bend(1) > 1.6)) return 'rock';
  }
  return known;
}

export type SignEvent = { type: 'down' | 'up'; sign: string; side: Side; heldMs: number };
interface SideState { cand: string | null; candSince: number; cur: string | null; curSince: number; lastSeen: number; next: number; fired: boolean }
/**
 * Hand-sign dwell and release for one person, both hands. Feed it the raw sign each frame; it says when a sign has been held
 * long enough ('down', once per threshold) and when it was dropped ('up'). A sign must show for DEBOUNCE ms before it counts
 * and may flicker out for GRACE ms before it counts as dropped (tracking drops a frame now and then).
 */
export class SignTracker {
  static DEBOUNCE = 90;
  static GRACE = 260;
  private s: Record<Side, SideState> = { left: this.blank(), right: this.blank() };
  private blank(): SideState { return { cand: null, candSince: 0, cur: null, curSince: 0, lastSeen: 0, next: 0, fired: false }; }
  reset(): SignEvent[] {
    const out: SignEvent[] = [];
    for (const side of ['left', 'right'] as const) { const st = this.s[side]; if (st.cur && st.fired) out.push({ type: 'up', sign: st.cur, side, heldMs: 0 }); this.s[side] = this.blank(); }
    return out;
  }
  /** `thresholds`: ascending hold times (ms) to report, at least [0]. */
  update(side: Side, raw: string | null, t: number, thresholds: readonly number[]): SignEvent[] {
    const st = this.s[side], out: SignEvent[] = [];
    const th = thresholds.length ? thresholds : [0];
    if (raw) {
      st.lastSeen = t;
      if (raw !== st.cand) { st.cand = raw; st.candSince = t; }
      if (raw !== st.cur && t - st.candSince >= SignTracker.DEBOUNCE) {
        if (st.cur && st.fired) out.push({ type: 'up', sign: st.cur, side, heldMs: Math.max(0, st.lastSeen - st.curSince) });
        st.cur = raw; st.curSince = st.candSince; st.next = 0; st.fired = false;
      }
    } else {
      st.cand = null;
      if (st.cur && t - st.lastSeen >= SignTracker.GRACE) {
        if (st.fired) out.push({ type: 'up', sign: st.cur, side, heldMs: Math.max(0, st.lastSeen - st.curSince) });
        st.cur = null; st.fired = false; st.next = 0;
      }
    }
    if (st.cur && raw === st.cur) {
      const held = t - st.curSince;
      while (st.next < th.length && held >= th[st.next]) { out.push({ type: 'down', sign: st.cur, side, heldMs: th[st.next] }); st.next++; st.fired = true; }
    }
    return out;
  }
}

// ---------------------------------------------------------------- rule events

let evN = 0;
const eid = (kind: string, ts: number) => `${kind}-${ts.toString(36)}-${(evN++).toString(36)}`;
export const keyEvent = (combo: string, ts = Date.now()): RuleEvent => ({ id: eid('key', ts), ts, kind: 'key', combo });
export const padEvent = (m: MidiMsg, ts = Date.now()): RuleEvent => ({ id: eid('pad', ts), ts, kind: 'pad', channel: m.ch, ...(m.note !== undefined ? { note: m.note } : {}), ...(m.cc !== undefined ? { cc: m.cc } : {}), value: m.value });
export const gamepadEvent = (button: number, pad = 0, ts = Date.now()): RuleEvent => ({ id: eid('gamepad', ts), ts, kind: 'gamepad', button, ...(pad ? { pad } : {}) });
export const handEvent = (sign: string, side: Side, heldMs: number, ts = Date.now()): RuleEvent => ({ id: eid('hand', ts), ts, kind: 'hand', sign, side, heldMs });

/** One source of a trigger: pressing and releasing the same thing pair up ('key:Ctrl+Alt+F9', 'pad:n36', 'gp:0:3', 'hand:peace:left'). */
export function sourceKey(e: RuleEvent): string {
  switch (e.kind) {
    case 'key': return `key:${e.combo.toLowerCase()}`;
    case 'pad': return e.cc !== undefined ? `pad:c${e.cc}` : `pad:n${e.note ?? 0}`;
    case 'gamepad': return `gp:${e.pad ?? 0}:${e.button}`;
    case 'hand': return `hand:${e.sign}:${e.side}`;
    default: return e.kind;
  }
}

// ---------------------------------------------------------------- duplicates

const stableWhen = (w: BindingWhen) => JSON.stringify(Object.keys(w).sort().map((k) => [k, (w as unknown as Record<string, unknown>)[k]]));
/** The same trigger? (a hand sign with a different hold time counts as the same). */
export function sameTrigger(a: BindingWhen, b: BindingWhen): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'hand' && b.kind === 'hand') return a.sign === b.sign && (a.side ?? 'any') === (b.side ?? 'any');
  if (a.kind === 'key' && b.kind === 'key') return a.combo.toLowerCase() === b.combo.toLowerCase();
  return stableWhen(a) === stableWhen(b);
}
/** The other enabled binding that already uses this trigger, if any. */
export function duplicateOf(list: readonly Binding[], b: Binding): Binding | null {
  return list.find((x) => x.id !== b.id && x.on && sameTrigger(x.when, b.when)) ?? null;
}

// ---------------------------------------------------------------- put it back ("only while I hold it")

/**
 * The two halves of a held action: what to do on press and what puts it back on release. Only deck actions that have a clean
 * "back" are listed; an action another lane registered can instead return its own `undo` (RuleActionResult).
 */
export function holdPlan(d: BindingAction): { down: BindingAction; up: BindingAction } | null {
  const p = d.params ?? {};
  switch (d.action) {
    case 'expression': return { down: { action: 'expression', params: { ...p, seconds: HOLD_EXPRESSION_SECS } }, up: { action: 'expression', params: { name: 'Neutral', seconds: 0.05 } } };
    case 'emote': return String(p.name ?? '') === 'stop' ? null : { down: d, up: { action: 'emote', params: { name: 'stop' } } };
    case 'cover': return { down: { action: 'cover', params: { ...p, on: 'true' } }, up: { action: 'cover', params: { ...p, on: 'false', text: '', style: '' } } };
    case 'chat-hide': return { down: { action: 'chat-hide', params: { on: 'true' } }, up: { action: 'chat-hide', params: { on: 'false' } } };
    default: return null;
  }
}
export const canHold = (action: string, undoable = false) => undoable || holdPlan({ action }) !== null;

// ---------------------------------------------------------------- the engine

export interface RunResult { ok: boolean; error?: string; undo?: BindingAction[] }
export type RunFn = (a: BindingAction, ctx: { binding: Binding; event: RuleEvent; phase: 'down' | 'up' | 'move' }) => Promise<RunResult> | RunResult;
export interface FiredInfo { binding: Binding; phase: 'down' | 'up' | 'move'; ok: boolean; error?: string; at: number }
interface Active { src: string; undo: BindingAction[]; b: Binding; timer?: unknown }
/** A held thing is put back after this long even if the release never arrives (helper crashed, controller unplugged). */
export const HOLD_MAX_MS = 120_000;
export interface EngineOptions {
  run: RunFn;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

/**
 * Trigger -> action. `down` runs every enabled binding the event matches (at most once per press, even for hand signs that
 * report several hold times), remembers how to put a held one back, and `up` (the same source released) puts it back.
 * A knob's value is rounded into the action's parameter and sent at most KNOB_HZ times a second, the last value always.
 */
export class BindingEngine {
  private list: Binding[] = [];
  private active = new Map<string, Active>();       // binding id -> held
  private lastDown = new Map<string, number>();     // binding id -> ms
  private knobTimers = new Map<string, { h: unknown; ev: RuleEvent; last: number }>();
  private knobSent = new Map<string, number>();
  private fired = new Set<(f: FiredInfo) => void>();
  private readonly run: RunFn;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;
  constructor(o: EngineOptions) {
    this.run = o.run; this.now = o.now ?? Date.now;
    this.setTimer = o.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms) as unknown as { unref?: () => void }; t?.unref?.(); return t; });
    this.clearTimer = o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }
  set(list: readonly Binding[]) {
    this.list = list.slice();
    const ids = new Set(list.map((b) => b.id));
    for (const id of [...this.active.keys()]) if (!ids.has(id)) { void this.release(id); }
  }
  onFired(fn: (f: FiredInfo) => void): () => void { this.fired.add(fn); return () => { this.fired.delete(fn); }; }
  private tell(f: FiredInfo) { for (const fn of [...this.fired]) { try { fn(f); } catch { /* a listener never stops a binding */ } } }
  get holding(): string[] { return [...this.active.keys()]; }

  private async exec(b: Binding, a: BindingAction, ev: RuleEvent, phase: 'down' | 'up' | 'move'): Promise<RunResult> {
    let r: RunResult;
    try { r = await this.run(a, { binding: b, event: ev, phase }); } catch (e) { r = { ok: false, error: (e as Error).message || 'failed' }; }
    this.tell({ binding: b, phase, ok: r.ok, error: r.error, at: this.now() });
    return r;
  }

  /** A trigger fired. Returns the bindings it ran. */
  async down(ev: RuleEvent): Promise<Binding[]> {
    const src = sourceKey(ev), t = this.now(), ran: Binding[] = [];
    for (const b of this.list) {
      if (!b.on || b.when.kind !== ev.kind || b.knob) continue;
      if (!this.matches(b, ev)) continue;
      if (this.active.get(b.id)?.src === src) continue;                   // still held: not a second press
      const last = this.lastDown.get(b.id);
      if (last !== undefined && t - last < MIN_GAP_MS) continue;
      this.lastDown.set(b.id, t);
      ran.push(b);
      const plan = b.hold ? holdPlan(b.do) : null;
      const r = await this.exec(b, plan ? plan.down : b.do, ev, 'down');
      if (b.hold && r.ok) this.hold(b, src, plan ? [plan.up] : r.undo ?? []);
      else if (ev.kind === 'hand') this.hold(b, src, []);                  // (remember it fired: a longer hold time is not a second press)
    }
    return ran;
  }

  /** The source was released: put back what it held. */
  async up(ev: RuleEvent): Promise<void> {
    const src = sourceKey(ev);
    for (const [id, a] of [...this.active]) if (a.src === src) await this.release(id, ev);
  }

  private hold(b: Binding, src: string, undo: BindingAction[]) {
    const old = this.active.get(b.id);
    if (old?.timer !== undefined) this.clearTimer(old.timer);
    this.active.set(b.id, { src, undo, b, timer: this.setTimer(() => { void this.release(b.id); }, HOLD_MAX_MS) });
  }
  private async release(id: string, ev?: RuleEvent) {
    const a = this.active.get(id);
    if (!a) return;
    this.active.delete(id);
    if (a.timer !== undefined) this.clearTimer(a.timer);
    for (const u of a.undo) await this.exec(a.b, u, ev ?? ({ id: 'release', ts: this.now(), kind: 'manual' } as RuleEvent), 'up');
  }

  /** "Try it": run the binding's action once now, as a test (a knob tries its middle value). Never held. */
  async tryNow(b: Binding): Promise<RunResult> {
    const ev = { id: `try-${this.now().toString(36)}`, ts: this.now(), kind: 'manual', test: true } as RuleEvent;
    const mid = b.knob ? Math.round(((b.knob.min + b.knob.max) / 2) * 100) / 100 : undefined;
    const a: BindingAction = b.knob && mid !== undefined ? { action: b.do.action, params: { ...(b.do.params ?? {}), [b.knob.param]: mid } } : b.do;
    return this.exec(b, a, ev, 'down');
  }

  /** Put every held thing back (tab hidden, controller unplugged, panel closed). */
  async releaseAll() { for (const id of [...this.active.keys()]) await this.release(id); }

  /** A knob moved. Values arrive at the controller's speed; this sends them at KNOB_HZ. */
  knob(ev: RuleEvent) {
    if (ev.kind !== 'pad' || ev.cc === undefined || ev.value === undefined) return;
    for (const b of this.list) {
      if (!b.on || !b.knob || b.when.kind !== 'pad' || !this.matches(b, ev)) continue;
      const slot = this.knobTimers.get(b.id), sent = this.knobSent.get(b.id) ?? 0, t = this.now();
      if (slot) { slot.ev = ev; continue; }
      const wait = Math.max(0, 1000 / KNOB_HZ - (t - sent));
      if (wait === 0) { this.sendKnob(b, ev); continue; }
      const entry = { h: null as unknown, ev, last: t };
      entry.h = this.setTimer(() => { this.knobTimers.delete(b.id); this.sendKnob(b, entry.ev); }, wait);
      this.knobTimers.set(b.id, entry);
    }
  }
  private sendKnob(b: Binding, ev: RuleEvent) {
    if (!b.knob || ev.kind !== 'pad') return;
    this.knobSent.set(b.id, this.now());
    const v = Math.min(1, Math.max(0, ev.value ?? 0)), val = b.knob.min + (b.knob.max - b.knob.min) * v;
    const rounded = Math.abs(b.knob.max - b.knob.min) >= 20 ? Math.round(val) : Math.round(val * 100) / 100;
    void this.exec(b, { action: b.do.action, params: { ...(b.do.params ?? {}), [b.knob.param]: rounded } }, ev, 'move');
  }

  dispose() {
    for (const e of this.knobTimers.values()) this.clearTimer(e.h);
    this.knobTimers.clear();
    for (const a of this.active.values()) if (a.timer !== undefined) this.clearTimer(a.timer);
    this.active.clear();
    this.fired.clear();
  }

  private matches(b: Binding, ev: RuleEvent): boolean {
    const w = b.when;
    return matchWhen(w, ev);   // (a hand sign: its own hold time, else the first one the tracker reports = the setting)
  }
}

// ---------------------------------------------------------------- quick starts (one click, plain words)

export interface QuickStart { id: string; title: string; blurb: string; make: () => Omit<Binding, 'id'> }
export const QUICK_STARTS: QuickStart[] = [
  { id: 'thumbs-happy', title: '👍 Thumbs up = happy face', blurb: 'Your avatar smiles while you hold a thumbs up.',
    make: () => ({ name: '', on: true, when: { kind: 'hand', sign: 'thumbs_up', side: 'any' }, do: { action: 'expression', params: { name: 'happy', seconds: 2.5 } }, hold: true }) },
  { id: 'peace-wave', title: '✌️ Peace sign = wave', blurb: 'A peace sign makes your avatar wave.',
    make: () => ({ name: '', on: true, when: { kind: 'hand', sign: 'peace', side: 'any' }, do: { action: 'emote', params: { name: 'wave' } } }) },
  { id: 'fist-angry', title: '✊ Fist = angry face', blurb: 'An angry face while your fist is up.',
    make: () => ({ name: '', on: true, when: { kind: 'hand', sign: 'fist', side: 'any' }, do: { action: 'expression', params: { name: 'angry', seconds: 2.5 } }, hold: true }) },
  { id: 'key-hide', title: '⌨️ Ctrl + Alt + H = hide my screen', blurb: 'Works in your game too (Windows). Press it again to show your screen.',
    make: () => ({ name: '', on: true, when: { kind: 'key', combo: 'Ctrl+Alt+H' }, do: { action: 'cover', params: { on: 'toggle' } } }) },
  { id: 'key-brb', title: '⌨️ Ctrl + Alt + B = BRB lights', blurb: 'One key puts the show on BRB, wherever you are.',
    make: () => ({ name: '', on: true, when: { kind: 'key', combo: 'Ctrl+Alt+B' }, do: { action: 'lighting', params: { state: 'brb' } } }) },
];
