// The VTube Studio phone app's on-screen buttons 1–8 (the "Hotkey" field of its tracking packets) → a studio action the
// performer picks. Default: button N toggles the model's own expression N (what VTube Studio does with them). Other
// choices: one of the model's own keys (never a key the studio / browser keeps: shared/studioKeys.ts), a Stream Deck
// action (shared/deck.ts: lighting, slap, recalibrate …), or nothing. Pure; tested in tools/phonecap_unit.ts.
// Runtime: src/tracking/phoneHotkeys.ts (the studio runs it when the helper says a button was tapped).
import { reservedKey } from './studioKeys.ts';
import { ACTION_BY_ID } from './deck.ts';

export type PhoneHotkey =
  | { kind: 'expression' }                                                // the model's expression N (default)
  | { kind: 'key'; combo: string }                                        // press one of the model's own keys
  | { kind: 'deck'; action: string; params?: Record<string, string | number> }
  | { kind: 'none' };
export const PHONE_HOTKEY_COUNT = 8;
export const DEFAULT_PHONE_HOTKEYS: PhoneHotkey[] = Array.from({ length: PHONE_HOTKEY_COUNT }, () => ({ kind: 'expression' }));
const COMBO = /^(Ctrl\+)?(Alt\+)?(Shift\+)?(Meta\+)?[A-Za-z0-9]{1,24}$/;

/** Ready-made deck choices for the picker (id + params + the words the user reads). */
export const PHONE_HOTKEY_PRESETS: { label: string; hk: PhoneHotkey }[] = [
  { label: 'Recalibrate my face', hk: { kind: 'deck', action: 'recalibrate' } },
  { label: 'Smile for a moment', hk: { kind: 'deck', action: 'expression', params: { name: 'happy', seconds: 2.5 } } },
  { label: 'Surprised for a moment', hk: { kind: 'deck', action: 'expression', params: { name: 'surprised', seconds: 2.5 } } },
  { label: 'Angry for a moment', hk: { kind: 'deck', action: 'expression', params: { name: 'angry', seconds: 2.5 } } },
  { label: 'Wave (emote)', hk: { kind: 'deck', action: 'emote', params: { name: 'wave' } } },
  { label: 'Lights: show', hk: { kind: 'deck', action: 'lighting', params: { state: 'show' } } },
  { label: 'Lights: BRB', hk: { kind: 'deck', action: 'lighting', params: { state: 'brb' } } },
  { label: 'Hide my screen on / off', hk: { kind: 'deck', action: 'cover', params: { on: 'toggle' } } },
  { label: 'Slap!', hk: { kind: 'deck', action: 'slap', params: { target: 'random' } } },
];

/** Why this binding can't be used ("that key opens Help"), or null. */
export function hotkeyProblem(h: PhoneHotkey): string | null {
  if (h.kind === 'key') {
    if (!COMBO.test(h.combo)) return 'That isn’t a key.';
    const r = reservedKey(h.combo);
    return r ? `That key ${r} in the studio, so a phone button can’t use it.` : null;
  }
  if (h.kind === 'deck' && !ACTION_BY_ID.has(h.action)) return 'That action doesn’t exist any more.';
  return null;
}

/** Clean an untrusted list (localStorage) → exactly 8 usable bindings (a bad one falls back to the default). */
export function sanitizeHotkeys(v: unknown): PhoneHotkey[] {
  const list = Array.isArray(v) ? v : [];
  return DEFAULT_PHONE_HOTKEYS.map((def, i) => {
    const o = list[i] as Record<string, unknown> | undefined;
    if (!o || typeof o !== 'object') return def;
    let h: PhoneHotkey | null = null;
    if (o.kind === 'none') h = { kind: 'none' };
    else if (o.kind === 'expression') h = { kind: 'expression' };
    else if (o.kind === 'key' && typeof o.combo === 'string') h = { kind: 'key', combo: o.combo.slice(0, 64) };
    else if (o.kind === 'deck' && typeof o.action === 'string') {
      const params: Record<string, string | number> = {};
      if (o.params && typeof o.params === 'object') for (const [k, x] of Object.entries(o.params as Record<string, unknown>).slice(0, 8)) if (/^[a-z]{1,16}$/i.test(k) && (typeof x === 'string' || typeof x === 'number')) params[k] = typeof x === 'string' ? x.slice(0, 80) : x;
      h = { kind: 'deck', action: o.action.slice(0, 40), params };
    }
    return h && !hotkeyProblem(h) ? h : def;
  });
}

/** One plain label for a binding. */
export function hotkeyLabel(h: PhoneHotkey, keyName: (combo: string) => string = (c) => c): string {
  switch (h.kind) {
    case 'expression': return 'The model’s expression with this number';
    case 'none': return 'Nothing';
    case 'key': return `Press ${keyName(h.combo)}`;
    case 'deck': {
      const p = PHONE_HOTKEY_PRESETS.find((x) => x.hk.kind === 'deck' && x.hk.action === h.action && JSON.stringify(x.hk.params ?? {}) === JSON.stringify(h.params ?? {}));
      return p?.label ?? ACTION_BY_ID.get(h.action)?.label ?? h.action;
    }
  }
}

export interface ModelExpression { id: string; name: string; key?: string }
export type HotkeyRun =
  | { do: 'flat-expression'; id: string; name: string }   // toggle a 2D model's expression
  | { do: '3d-expression'; name: string }                  // toggle a 3D face preset
  | { do: 'key'; combo: string }
  | { do: 'deck'; action: string; params: Record<string, string | number> }
  | { do: 'nothing'; why: string };
/** The 3D face presets buttons 1–8 toggle when the avatar has no expression list of its own (src/app.ts TEST_EXPRESSIONS). */
export const DEFAULT_3D_EXPRESSIONS = ['Smile', 'Surprised', 'Angry', 'Sad', 'Wink', 'Tongue', 'Puff', 'Big grin'];

/** What button `n` (1..8) does for this model. `flat`: the 2D model's expressions (null = a 3D avatar). */
export function planHotkey(n: number, list: PhoneHotkey[], flat: ModelExpression[] | null): HotkeyRun {
  if (!Number.isInteger(n) || n < 1 || n > PHONE_HOTKEY_COUNT) return { do: 'nothing', why: 'not a phone button' };
  const h = list[n - 1] ?? DEFAULT_PHONE_HOTKEYS[0];
  if (h.kind === 'none') return { do: 'nothing', why: 'button off' };
  if (h.kind === 'key') return hotkeyProblem(h) ? { do: 'nothing', why: 'reserved key' } : { do: 'key', combo: h.combo };
  if (h.kind === 'deck') return { do: 'deck', action: h.action, params: h.params ?? {} };
  if (flat) {
    // the expression whose key is that number (row or keypad: VTube Studio models save either), else the Nth one
    const num = (k: string | undefined) => /^(?:Digit|Numpad)(\d)$/.exec(k ?? '')?.[1] ?? null;
    const ex = flat.find((x) => num(x.key) === String(n)) ?? flat[n - 1];
    return ex ? { do: 'flat-expression', id: ex.id, name: ex.name } : { do: 'nothing', why: `the model has no expression ${n}` };
  }
  return { do: '3d-expression', name: DEFAULT_3D_EXPRESSIONS[n - 1] };
}
