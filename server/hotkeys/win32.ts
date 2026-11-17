// Global keys, Windows half 1 (docs/b16/BINDINGS.md): a combo like "Ctrl+Alt+F9" -> the numbers Win32 RegisterHotKey takes,
// and the one-line text protocol with the small hidden helper process (server/hotkeys/hostScript.ts). Pure: no spawn here.
import { sanitizeCombo } from '../../shared/hotkey.ts';
import { globalKeyProblem } from '../../src/input/bindings.ts';

export const MOD_ALT = 0x1, MOD_CONTROL = 0x2, MOD_SHIFT = 0x4, MOD_WIN = 0x8, MOD_NOREPEAT = 0x4000;

const NAMED_VK: Record<string, number> = {
  Space: 0x20, Esc: 0x1b, Enter: 0x0d, Tab: 0x09, Backspace: 0x08, Delete: 0x2e, Insert: 0x2d, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
  Left: 0x25, Up: 0x26, Right: 0x27, Down: 0x28, Pause: 0x13, ScrollLock: 0x91, PrintScreen: 0x2c,
};

/** The Win32 modifier flags and virtual-key code of a combo (shared/hotkey.ts spelling), or null when it is not a key. */
export function toWin32(combo: string): { mods: number; vk: number } | null {
  const c = sanitizeCombo(combo);
  if (!c) return null;
  const parts = c.split('+'), key = parts[parts.length - 1], mods = parts.slice(0, -1);
  let vk: number | undefined;
  if (/^[A-Z]$/.test(key)) vk = key.charCodeAt(0);
  else if (/^[0-9]$/.test(key)) vk = key.charCodeAt(0);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) vk = 0x70 + Number(key.slice(1)) - 1;
  else if (/^Num[0-9]$/.test(key)) vk = 0x60 + Number(key.slice(3));
  else vk = NAMED_VK[key];
  if (vk === undefined) return null;
  const m = (mods.includes('Alt') ? MOD_ALT : 0) | (mods.includes('Ctrl') ? MOD_CONTROL : 0) | (mods.includes('Shift') ? MOD_SHIFT : 0) | (mods.includes('Meta') ? MOD_WIN : 0);
  return { mods: m, vk };
}

export interface HotkeyWant { id: string; combo: string }
export interface HotkeyAnswer { id: string; ok: boolean; why?: string }

/** Clean the list the studio sends: at most 40, valid ids, combos that are safe to take system-wide. Bad ones come back with the reason. */
export function planHotkeys(input: unknown): { keep: (HotkeyWant & { mods: number; vk: number })[]; refused: HotkeyAnswer[] } {
  const keep: (HotkeyWant & { mods: number; vk: number })[] = [], refused: HotkeyAnswer[] = [];
  const seen = new Set<string>(), combos = new Map<string, string>();
  for (const o of (Array.isArray(input) ? input : []).slice(0, 40)) {
    const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
    const id = typeof x.id === 'string' && /^[a-z0-9-]{1,32}$/.test(x.id) ? x.id : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const combo = sanitizeCombo(x.combo);
    if (!combo) { refused.push({ id, ok: false, why: 'That isn’t a key VTube Pro can use.' }); continue; }
    const problem = globalKeyProblem(combo);
    if (problem) { refused.push({ id, ok: false, why: problem }); continue; }
    const w = toWin32(combo);
    if (!w) { refused.push({ id, ok: false, why: 'That isn’t a key VTube Pro can use.' }); continue; }
    const twin = combos.get(combo);
    if (twin) { keep.push({ id, combo, ...w }); continue; }       // two bindings, one key: registered once under the first id
    combos.set(combo, id);
    keep.push({ id, combo, ...w });
  }
  return { keep, refused };
}

// ---- the text protocol (stdin -> helper process: commands; stdout <- helper process: answers) ----
// commands: "clear" | "reg <id> <mods> <vk>" | "quit"
// answers:  "ready" | "ok <id>" | "fail <id> <win32 error>" | "down <id>" | "up <id>"
export const cmdClear = () => 'clear';
export const cmdReg = (id: string, mods: number, vk: number) => `reg ${id} ${mods | MOD_NOREPEAT} ${vk}`;
export const cmdQuit = () => 'quit';

export type HostLine = { t: 'ready' } | { t: 'ok'; id: string } | { t: 'fail'; id: string; code: number } | { t: 'down'; id: string } | { t: 'up'; id: string };
export function parseHostLine(line: string): HostLine | null {
  const p = line.trim().split(/\s+/);
  if (p[0] === 'ready') return { t: 'ready' };
  if ((p[0] === 'ok' || p[0] === 'down' || p[0] === 'up') && /^[a-z0-9-]{1,32}$/.test(p[1] ?? '')) return { t: p[0], id: p[1] } as HostLine;
  if (p[0] === 'fail' && /^[a-z0-9-]{1,32}$/.test(p[1] ?? '')) return { t: 'fail', id: p[1], code: Number(p[2]) || 0 };
  return null;
}
/** Win32 error 1409 = "hot key is already registered" (another program has the key). */
export function failWhy(code: number): string {
  return code === 1409 ? 'Another program already uses this key. Pick a different one.' : 'Windows would not give VTube Pro this key. Pick a different one.';
}
