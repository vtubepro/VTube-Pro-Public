// Keys the studio and the browser keep for themselves. A 2D model's own keys (its expressions, a VTube Studio import)
// and the keys a performer binds to model sliders / outfits must never take these: the studio action (hide the menus,
// calibrate, frame the camera, the lighting / BRB keys, Help, command search …) or the browser's own (reload, find,
// back …) must still happen. One list, used by:
//   * the studio's key handler (src/ui/flatPanel.ts flatHotkey → src/ui/rig2dSliders.ts): a reserved key is not
//     consumed, the studio action runs;
//   * the Live2D / VTube Studio importer (shared/rig2d/live2d/convert.ts): such a key is imported unbound, and the user
//     is told in one line which key it got instead;
//   * the key forms of the 2D panel (src/ui/rig2dSliders.ts): refused with one sentence;
//   * expression keys stored in a model file (shared/rig2d/userParams.ts expressionKeys): treated as unbound.
// Combos are "Ctrl+Alt+Shift+Meta+<KeyboardEvent.code>" (shared/rig2d/userParams.ts comboOf). Pure; tested in
// tools/rig2d_params_unit.ts.

const PLAIN: Record<string, string> = {
  KeyH: 'hides the studio menus', KeyC: 'calibrates your face', KeyF: 'frames the camera', F1: 'opens Help', F5: 'reloads the page',
  F11: 'switches full screen', F12: 'opens the browser tools', Escape: 'cancels', F3: 'searches the page', F6: 'goes to the address bar', F7: 'is the browser’s caret mode',
  F10: 'opens the browser menu',
};
/** Shift + these letters are the studio's (src/main.ts: show modes T / R / G / I / P registered by src/scene/stage/modes,
 *  Slap = S in src/ui/slapPanel.ts, the tabletop panel = Y in src/ttrpg/studio). Other Shift + letters stay free for
 *  models. (Show modes installed later register their own letter; the studio's handler runs before model keys.) */
const SHIFT_LETTERS: Record<string, string> = { KeyT: 'switches to Talk mode', KeyR: 'switches to React mode', KeyG: 'switches to Gaming mode',
  KeyI: 'switches to Interview mode', KeyP: 'switches to the tabletop mode', KeyS: 'sends the slapper', KeyY: 'opens the tabletop panel' };
// (F2, F4, F8 and F9 stay free for models on purpose: nothing in the studio or the browser page uses them)
const SHIFT: Record<string, string> = { Comma: 'picks the show mode presets', Period: 'picks the show mode presets', Enter: 'reveals a held room change', Slash: 'lists the shortcuts', F5: 'reloads the page',
  F10: 'opens the right-click menu' };
const CTRL: Record<string, string> = {
  KeyK: 'opens command search', KeyR: 'reloads the page', KeyF: 'finds on the page', KeyH: 'opens the browser history', KeyS: 'saves the page',
  KeyP: 'prints', KeyL: 'goes to the address bar', KeyW: 'closes the tab', KeyT: 'opens a tab', KeyN: 'opens a window', KeyD: 'adds a bookmark',
  KeyJ: 'opens downloads', KeyB: 'hides your screen', KeyU: 'shows the page source', KeyG: 'finds again', KeyE: 'searches', KeyO: 'opens a file',
  KeyQ: 'quits the browser', Tab: 'switches tabs', PageUp: 'switches tabs', PageDown: 'switches tabs', F4: 'closes the tab', F5: 'reloads the page',
  Equal: 'zooms', Minus: 'zooms', NumpadAdd: 'zooms', NumpadSubtract: 'zooms',
};
const CTRL_SHIFT: Record<string, string> = { KeyR: 'reloads the page', KeyI: 'opens the browser tools', KeyJ: 'opens the browser console', KeyC: 'opens the browser tools',
  KeyT: 'reopens a tab', KeyN: 'opens a private window', KeyB: 'shows the bookmarks bar', KeyW: 'closes the window', KeyDelete: 'clears browsing data', Delete: 'clears browsing data', Tab: 'switches tabs', KeyQ: 'quits the browser' };
const ALT: Record<string, string> = { ArrowLeft: 'goes back', ArrowRight: 'goes forward', Home: 'opens the home page', F4: 'closes the window', KeyD: 'goes to the address bar', KeyF: 'opens the browser menu', KeyE: 'opens the browser menu' };

/** Why the studio or the browser keeps this key (one plain phrase: "hides the studio menus"), or null when it is free. */
export function reservedKey(combo: string | null | undefined): string | null {
  if (!combo) return null;
  const parts = combo.split('+');
  const code = parts.pop() ?? '';
  const m = new Set(parts);
  const ctrl = m.has('Ctrl') || m.has('Meta'), alt = m.has('Alt'), shift = m.has('Shift');
  const digit = /^(Digit|Numpad)\d$/.test(code);
  if (!ctrl && !alt && !shift) return PLAIN[code] ?? null;
  if (shift && !ctrl && !alt) {
    // (lighting reads the digit from the key, so the keypad's Shift + 1–5 is the same key)
    if (/^(Digit|Numpad)[1-5]$/.test(code)) return /4$/.test(code) ? 'sets the BRB lighting' : 'sets the lighting';
    return SHIFT_LETTERS[code] ?? SHIFT[code] ?? null;
  }
  if (ctrl && !alt && !shift) return digit ? 'wears an outfit / switches browser tabs' : CTRL[code] ?? null;
  // (interview cuts read the number row only: src/ui/stage/panels/interview.ts; Ctrl + Shift + keypad stays free)
  if (ctrl && shift && !alt) return /^Digit\d$/.test(code) ? 'cuts the interview camera' : CTRL_SHIFT[code] ?? null;
  if (alt && !ctrl && !shift) return digit ? 'wears an outfit' : ALT[code] ?? null;
  return null;
}

/** The same for a key event (the studio's key handler). */
export function reservedKeyEvent(e: { code: string; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean }): string | null {
  return reservedKey(`${e.ctrlKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.metaKey ? 'Meta+' : ''}${e.code}`);
}
