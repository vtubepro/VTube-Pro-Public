// "Hide my screen" hotkey (live-tabs, owner: "I need that binding to be customizable and work no matter what tab
// you're in"). Default Ctrl+B (shared/hotkey.ts), rebindable in Live → Privacy, saved per browser (localStorage
// vtp.hotkey.hideScreen, read on every press so a change in one window counts in all of them).
//   • One capture-phase keydown listener on the window: fires from any area / tab / panel, before the page's own
//     handlers. Ignored only while you type in a text field, while the Privacy tab records a new key, and on key repeat.
//   • The studio toggles the capture cover itself (src/main.ts); the Live pop-out / OBS dock runs the Stream Deck action
//     `cover` (popout.ts). Docked tools (Chat Hub, deck … in the studio's drawer: an iframe that has the keyboard) pass
//     the press up to the studio (initDockedPage → forwardHideScreenHotkey).
import { comboOf, loadHideScreenKey } from '../../../shared/hotkey.ts';

/** Same-origin message a docked frame sends the studio when the key is pressed inside it. */
export const HIDE_SCREEN_MSG = 'vtp-hide-screen';
let recording = 0;
/** The Privacy tab is recording a new key: the hotkey must not fire meanwhile. */
export function setHotkeyRecording(on: boolean) { recording = Math.max(0, recording + (on ? 1 : -1)); }
export const hotkeyRecording = () => recording > 0;

const NOT_TEXT = new Set(['button', 'checkbox', 'radio', 'range', 'color', 'submit', 'reset', 'file', 'image']);
/** A text field / editable area has the keyboard (the key is for typing there). */
export function isTypingTarget(t: EventTarget | null | undefined): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return tag === 'INPUT' && !NOT_TEXT.has(String((el as HTMLInputElement).type || 'text').toLowerCase());
}
const storage = (w: Window) => { try { return w.localStorage; } catch { return null; } };
/** Does this key event mean "hide / show my screen" right now? */
export function isHideScreenPress(e: KeyboardEvent, w: Window = window): boolean {
  if (recording || e.repeat || isTypingTarget(e.target)) return false;
  const c = comboOf(e);
  return !!c && c === loadHideScreenKey(storage(w));
}

/** Install the global handler (once per page). `toggle` hides / shows the screen. Returns the uninstall. */
export function installHideScreenHotkey(toggle: () => void, w: Window = window): () => void {
  const key = (e: KeyboardEvent) => { if (!isHideScreenPress(e, w)) return; e.preventDefault(); e.stopImmediatePropagation(); toggle(); };
  const msg = (e: MessageEvent) => { if (e.origin === w.location.origin && (e.data as { k?: string } | null)?.k === HIDE_SCREEN_MSG) toggle(); };
  w.addEventListener('keydown', key, true);
  w.addEventListener('message', msg);
  return () => { w.removeEventListener('keydown', key, true); w.removeEventListener('message', msg); };
}

/** A docked frame: hand the press to the studio around it (it owns the cover). */
export function forwardHideScreenHotkey(w: Window = window): () => void {
  const key = (e: KeyboardEvent) => {
    if (w.parent === w || !isHideScreenPress(e, w)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    try { w.parent.postMessage({ k: HIDE_SCREEN_MSG }, w.location.origin); } catch { /* not same origin */ }
  };
  w.addEventListener('keydown', key, true);
  return () => w.removeEventListener('keydown', key, true);
}
