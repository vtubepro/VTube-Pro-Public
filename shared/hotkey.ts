// Rebindable hotkeys (live-tabs): the "Hide my screen" key (Live → Privacy). Pure helpers — a combo is a string like
// "Ctrl+B" / "Ctrl+Shift+F9" / "Alt+H" (modifiers in the order Ctrl, Alt, Shift, Meta, then ONE key) — used by the studio,
// the Live pop-out / OBS dock (src/ui/live/hideHotkey.ts) and tools/hide_hotkey_unit.ts. No DOM here.

export const HIDE_SCREEN_KEY_LS = 'vtp.hotkey.hideScreen';
/** Owner: "the one you can do with CTRL+B" (was Shift+B in the studio). */
export const HIDE_SCREEN_DEFAULT = 'Ctrl+B';

export interface KeyLike { key: string; code?: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean }
const MODS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
const MOD_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'OS', 'AltGraph', 'CapsLock', 'Fn', 'Dead', 'Unidentified', 'Process']);

/** The key part of a combo: letters / digits by their physical code (so Shift+1 is "1", not "!"), F1–F24, named keys. */
export function keyName(e: KeyLike): string | null {
  if (MOD_KEYS.has(e.key)) return null;
  const c = e.code ?? '';
  let m = /^Key([A-Z])$/.exec(c); if (m) return m[1];
  m = /^Digit([0-9])$/.exec(c); if (m) return m[1];
  m = /^Numpad([0-9])$/.exec(c); if (m) return `Num${m[1]}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) return e.key;
  const named: Record<string, string> = { ' ': 'Space', Escape: 'Esc', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace',
    Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Pause: 'Pause', ScrollLock: 'ScrollLock', PrintScreen: 'PrintScreen' };
  if (named[e.key]) return named[e.key];
  if (e.key.length === 1) return e.key.toUpperCase();
  return null;
}
/** A key event → its combo ("Ctrl+B"), or null for a bare modifier. */
export function comboOf(e: KeyLike): string | null {
  const k = keyName(e);
  if (!k) return null;
  const mods = MODS.filter((m) => (m === 'Ctrl' ? e.ctrlKey : m === 'Alt' ? e.altKey : m === 'Shift' ? e.shiftKey : e.metaKey));
  return [...mods, k].join('+');
}
/** Clean a stored / typed combo (any junk → null). Modifiers are re-ordered, names are case-insensitive. */
export function sanitizeCombo(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 40) return null;
  const parts = v.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const key = parts[parts.length - 1], mods = parts.slice(0, -1).map((p) => p.toLowerCase());
  const norm = (m: string) => (m === 'control' || m === 'ctrl' ? 'Ctrl' : m === 'alt' || m === 'option' ? 'Alt' : m === 'shift' ? 'Shift' : m === 'meta' || m === 'cmd' || m === 'win' ? 'Meta' : null);
  const ms = mods.map(norm);
  if (ms.some((m) => !m) || new Set(ms).size !== ms.length) return null;
  const k = /^f([1-9]|1[0-9]|2[0-4])$/i.test(key) ? key.toUpperCase() : /^num[0-9]$/i.test(key) ? `Num${key.slice(3)}` : key.length === 1 ? key.toUpperCase()
    : ['Space', 'Esc', 'Up', 'Down', 'Left', 'Right', 'Enter', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Pause', 'ScrollLock', 'PrintScreen'].find((x) => x.toLowerCase() === key.toLowerCase());
  if (!k) return null;
  return [...MODS.filter((m) => ms.includes(m)), k].join('+');
}
export const matchCombo = (e: KeyLike, combo: string) => comboOf(e) === combo;
/** How it reads on a button ("Ctrl + B"). */
export const comboLabel = (c: string) => c.split('+').join(' + ');

/** Shortcuts VTube Pro (or the browser) already uses — a rebind onto one of these gets a warning. `null` = free. */
export function comboConflict(combo: string): string | null {
  const c = sanitizeCombo(combo);
  if (!c) return 'That isn’t a key VTube Pro can use.';
  const parts = c.split('+'), key = parts[parts.length - 1], mods = parts.slice(0, -1), only = (...m: string[]) => mods.length === m.length && m.every((x) => mods.includes(x));
  if (!mods.length && !/^F([1-9]|1[0-9]|2[0-4])$/.test(key) && key !== 'Pause' && key !== 'ScrollLock' && key !== 'Insert')
    return 'One key on its own is easy to hit by accident (and H, C, F, 1–9 are taken). Add Ctrl, Alt or Shift.';
  if (only('Shift') && /^[1-5]$/.test(key)) return 'Shift + 1–5 already switch your look (Starting soon … Ending).';
  if (only('Shift') && 'TRGIP'.includes(key) && key.length === 1) return `Shift + ${key} already switches the kind of show.`;
  if (only('Shift') && key === 'S') return 'Shift + S already sends the slapper.';
  if (only('Shift') && key === 'Enter') return 'Shift + Enter already shows a room that waits for you.';
  if ((only('Ctrl') || only('Alt')) && /^[0-9]$/.test(key)) return `${mods[0]} + 0–9 already change your outfit.`;
  if (only('Ctrl', 'Shift') && (/^[0-9]$/.test(key) || key === 'B')) return key === 'B' ? 'Ctrl + Shift + B already plays the show open.' : 'Ctrl + Shift + 0–9 already cut interview cameras.';
  if (only('Ctrl') && key === 'K') return 'Ctrl + K already opens search.';
  if (only('Ctrl') && key === 'Z') return 'Ctrl + Z already undoes a guest camera / mic change.';
  if (only('Alt') && key === 'L') return 'Alt + L already opens Live.';
  if (key === 'F1' && !mods.length) return 'F1 already opens Help.';
  if (only('Ctrl') && 'WTNRLPQFHJ'.includes(key) && key.length === 1) return `Your browser uses Ctrl + ${key}; it may not reach VTube Pro.`;
  if ((only('Ctrl', 'Shift') && 'TNWQ'.includes(key) && key.length === 1) || (!mods.length && key === 'F5') || (only('Ctrl') && key === 'Tab') || (only('Alt') && key === 'F4')) return 'Your browser or computer uses that key.';
  return null;
}

/** The saved binding (per browser), else the default. */
export function loadHideScreenKey(ls: Pick<Storage, 'getItem'> | null | undefined): string {
  try { return sanitizeCombo(ls?.getItem(HIDE_SCREEN_KEY_LS)) ?? HIDE_SCREEN_DEFAULT; } catch { return HIDE_SCREEN_DEFAULT; }
}
/** Save a binding (null / the default = back to the default). Returns what is in effect now. */
export function saveHideScreenKey(ls: Pick<Storage, 'setItem' | 'removeItem'> | null | undefined, combo: string | null): string {
  const c = combo === null ? null : sanitizeCombo(combo);
  try { if (!c || c === HIDE_SCREEN_DEFAULT) ls?.removeItem(HIDE_SCREEN_KEY_LS); else ls?.setItem(HIDE_SCREEN_KEY_LS, c); } catch { /* storage off */ }
  return c ?? HIDE_SCREEN_DEFAULT;
}
