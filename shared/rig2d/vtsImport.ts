// VTube Studio's model file (<name>.vtube.json, saved next to the model3.json) → what the Pro2D importer keeps:
//   * hotkey keys: Hotkeys[].Triggers.Trigger1..3 (Unity-style key names: "N1" / "Alpha1" = the number row,
//     "Numpad1" / "Keypad1", "A", "F5", "LeftControl" …) → our key combination ("Ctrl+Digit1", "KeyA", "F5"): the same
//     key does the same thing after import (shared/rig2d/userParams.ts comboOf is the studio side);
//   * which parameters VTube Studio drives from tracking: ParameterSettings[] with an Input (FaceAngleX, MouthOpen,
//     EyeOpenLeft …) and an OutputLive2D id. Those are never offered as model sliders (doc.extra.vtsTracked).
// There is no published spec of the file (the VTube Studio wiki says so); the field names are the ones VTube Studio
// writes and its public API reports (HotkeyAction.cs: ToggleExpression, TriggerAnimation …). Pure; unit-tested in
// tools/rig2d_params_unit.ts.

import { sanitizeRules, stringifyRuleSet, type RuleStep, type RuleWhen, type StreamRule } from '../streamRules.ts';

const MODS: Record<string, string> = {
  leftcontrol: 'Ctrl', rightcontrol: 'Ctrl', control: 'Ctrl', ctrl: 'Ctrl', leftctrl: 'Ctrl', rightctrl: 'Ctrl',
  leftshift: 'Shift', rightshift: 'Shift', shift: 'Shift',
  leftalt: 'Alt', rightalt: 'Alt', alt: 'Alt', altgr: 'Alt', leftoption: 'Alt', rightoption: 'Alt',
  leftcommand: 'Meta', rightcommand: 'Meta', leftwindows: 'Meta', rightwindows: 'Meta', leftapple: 'Meta', rightapple: 'Meta', leftmeta: 'Meta', rightmeta: 'Meta',
};
const NAMED: Record<string, string> = {
  space: 'Space', return: 'Enter', enter: 'Enter', tab: 'Tab', backspace: 'Backspace', escape: 'Escape', insert: 'Insert', delete: 'Delete',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', uparrow: 'ArrowUp', downarrow: 'ArrowDown', leftarrow: 'ArrowLeft',
  rightarrow: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', minus: 'Minus', equals: 'Equal',
  plus: 'Equal', comma: 'Comma', period: 'Period', slash: 'Slash', backslash: 'Backslash', semicolon: 'Semicolon', quote: 'Quote',
  backquote: 'Backquote', leftbracket: 'BracketLeft', rightbracket: 'BracketRight', keypadplus: 'NumpadAdd', keypadminus: 'NumpadSubtract',
  keypadmultiply: 'NumpadMultiply', keypaddivide: 'NumpadDivide', keypadenter: 'NumpadEnter', keypadperiod: 'NumpadDecimal',
  numpadplus: 'NumpadAdd', numpadminus: 'NumpadSubtract', numpadmultiply: 'NumpadMultiply', numpaddivide: 'NumpadDivide', numpadenter: 'NumpadEnter',
  numpadperiod: 'NumpadDecimal', numpadadd: 'NumpadAdd', numpadsubtract: 'NumpadSubtract', numpaddecimal: 'NumpadDecimal',
};

/** One VTube Studio key name → a KeyboardEvent.code (or a modifier word), '' when unknown. */
export function vtsKeyCode(name: string): string {
  const n = name.trim();
  if (!n) return '';
  const low = n.toLowerCase().replace(/\s+/g, '');
  if (MODS[low]) return MODS[low];
  let m = /^(?:n|num|alpha|digit)([0-9])$/i.exec(n);
  if (m) return `Digit${m[1]}`;
  m = /^(?:numpad|keypad)([0-9])$/i.exec(n);
  if (m) return `Numpad${m[1]}`;
  if (/^[A-Za-z]$/.test(n)) return `Key${n.toUpperCase()}`;
  m = /^(?:key)?([A-Za-z])$/i.exec(n);
  if (m) return `Key${m[1].toUpperCase()}`;
  m = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(n);
  if (m) return `F${m[1]}`;
  return NAMED[low] ?? '';
}

/** A hotkey's Triggers ({ Trigger1, Trigger2, Trigger3 }) → "Ctrl+Shift+KeyB" (modifiers in our order), '' when it has
 *  no key we can press (a mouse / screen-button-only hotkey, an unknown name, or two non-modifier keys at once). */
export function vtsKeyCombo(triggers: unknown): string {
  const t = triggers && typeof triggers === 'object' ? triggers as Record<string, unknown> : {};
  const names = ['Trigger1', 'Trigger2', 'Trigger3'].map((k) => (typeof t[k] === 'string' ? (t[k] as string) : '')).filter(Boolean);
  const mods = new Set<string>();
  let key = '';
  for (const nm of names) {
    const c = vtsKeyCode(nm);
    if (!c) return '';
    if (c === 'Ctrl' || c === 'Shift' || c === 'Alt' || c === 'Meta') mods.add(c);
    else if (key) return '';
    else key = c;
  }
  if (!key) return '';
  return `${mods.has('Ctrl') ? 'Ctrl+' : ''}${mods.has('Alt') ? 'Alt+' : ''}${mods.has('Shift') ? 'Shift+' : ''}${mods.has('Meta') ? 'Meta+' : ''}${key}`;
}

/** VTube Studio inputs that come from the face / voice tracker (not the mouse, not a plugin's own input). */
const TRACKED_INPUT = /^(Face|Mouth|Brow|Eye|Cheek|Tongue|Voice|Hand|Both|Left|Right|Head|Body|Jaw)/;

/** The Live2D parameter ids VTube Studio drives from tracking in this model (its ParameterSettings). */
export function vtsTrackedParams(vts: unknown): string[] {
  const o = vts && typeof vts === 'object' ? vts as Record<string, unknown> : {};
  const list = Array.isArray(o.ParameterSettings) ? o.ParameterSettings : [];
  const out = new Set<string>();
  for (const s of list.slice(0, 1024)) {
    if (!s || typeof s !== 'object') continue;
    const r = s as Record<string, unknown>;
    const input = typeof r.Input === 'string' ? r.Input : '', id = typeof r.OutputLive2D === 'string' ? r.OutputLive2D : '';
    if (id && id.length <= 128 && TRACKED_INPUT.test(input)) out.add(id);
  }
  return [...out];
}

// ================================================================ VTube Studio hotkeys + Twitch triggers -> Redeems & Reactions
// (beta.16, shared/streamRules.ts). Every hotkey VTube Studio saved that has an equivalent here becomes ONE rule, switched
// OFF, so the performer reviews and turns on what they want. Nothing is guessed that could surprise a stream: an action we
// have no equivalent for is listed (with a plain reason), never faked.
//
// [unknown] There is still no published spec of the file. Read here: Hotkeys[].Action / Name / File / Triggers (keys as in
// vtsKeyCombo) / DeactivateAfterSeconds; and, for Twitch triggers, any entry inside the hotkey (or its Triggers) whose name
// says redeem / reward / bits / cheer / gift / sub / raid / follow with a value that is switched on (true, a number, a
// title, a list, or an object with Enabled / Min). Field names that differ in a real file are the first thing to compare
// with an owner-supplied sample (docs/b16/PNGTUBER.md, "Needs a real save").

export interface VtsRulesResult {
  rules: StreamRule[];
  /** Hotkeys that did not become a rule, each with the reason in plain words. */
  skipped: { name: string; why: string }[];
  /** Sentences about the rules that were made (shown once, under the list). */
  notes: string[];
}

const objOf = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const strOf = (v: unknown, max = 128) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');
const stemOf = (f: string) => (f.replace(/\\/g, '/').split('/').pop() ?? f).replace(/\.(exp3|motion3|item)?\.?json$/i, '').replace(/\.[^.]+$/, '');

/** Why an action has no rule (the ones we have an equivalent for are in stepFor). Keys: the action, lower case, letters only. */
const NO_RULE: Record<string, string> = {
  triggeranimation: 'Animations are played from the Motions list in your 2D model’s panel.',
  changeidleanimation: 'The idle animation is chosen in your 2D model’s panel.',
  movemodel: 'Moving the model is done with its position in the studio.',
  changebackground: 'Rooms and backgrounds are chosen in Scene.',
  reloadmicrophone: 'VTube Pro picks up microphone changes by itself.',
  reloadtextures: 'Not needed here.',
  changevtsmodel: 'Switch avatars from your avatar list.',
  takescreenshot: 'Screenshots are taken from the studio.',
  screencoloroverlay: 'Screen colours are set in Scene.',
  downloadrandomitem: 'Items come from your item sets.',
};

/** hotkey Action -> the step our rules run for it (null = see NO_RULE). */
function stepFor(action: string, name: string, file: string): RuleStep | null {
  const a = action.toLowerCase().replace(/[^a-z]/g, '');
  const cmd = (command: string, args: Record<string, unknown>): RuleStep => ({ action: 'command', params: { command, args: JSON.stringify(args) } });
  switch (a) {
    case 'toggleexpression': { const n = name || stemOf(file); return n ? cmd('flat', { toggle: n }) : null; }
    case 'removeallexpressions': return cmd('flat', { expression: null });
    case 'calibratecam': return { action: 'recalibrate' };
    case 'removeallitems': return { action: 'sticker', params: { op: 'clear' } };
    case 'toggleitemscene': case 'loaditemscene': return { action: 'item-scene', params: { name: stemOf(file) || name, on: 'toggle' } };
  }
  return null;
}

const isOff = (v: unknown): boolean => {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.Enabled === false || o.enabled === false || o.Active === false) return true;
    return Object.keys(o).length === 0;
  }
  return false;
};
const titlesOf = (v: unknown): string[] => {
  if (typeof v === 'string') return [strOf(v, 80)].filter(Boolean);
  if (Array.isArray(v)) return v.flatMap(titlesOf).slice(0, 8);
  const o = objOf(v);
  for (const k of ['Title', 'title', 'Name', 'name', 'Reward', 'RewardName', 'RedeemName']) if (typeof o[k] === 'string') return titlesOf(o[k]);
  return [];
};
const minOf = (v: unknown): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.round(v));
  const o = objOf(v);
  for (const k of ['Min', 'min', 'MinBits', 'Bits', 'Amount', 'Threshold', 'Viewers', 'MinViewers']) if (typeof o[k] === 'number') return Math.max(0, Math.round(o[k] as number));
  return 0;
};

/** The Twitch-style triggers inside one hotkey, as rule `when` entries. */
export function vtsTwitchWhen(hotkey: unknown): RuleWhen[] {
  const out: RuleWhen[] = [];
  const SKIP = /^trigger\d$|screenbutton|onlyon|removeall|fade|toggle|^file$|^name$|^action$|hotkeyid|position|deactivate/;
  const scan = (o: Record<string, unknown>, depth: number) => {
    for (const [k, v] of Object.entries(o)) {
      const key = k.toLowerCase();
      if (SKIP.test(key)) continue;
      const known = /redeem|reward|bits|cheer|gift|raid|follow|(^|[^a-z])sub/.test(key);
      if (!known) { if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2) scan(v as Record<string, unknown>, depth + 1); continue; }
      if (isOff(v)) continue;
      if (/redeem|reward/.test(key)) { for (const t of titlesOf(v)) out.push({ kind: 'redeem', title: t, platform: 'twitch' }); }
      else if (/bits|cheer/.test(key)) { const m = minOf(v); out.push({ kind: 'money', fkind: ['bits'], platform: 'twitch', ...(m > 0 ? { minAmount: m } : {}) }); }
      else if (/gift/.test(key)) { const m = minOf(v); out.push({ kind: 'giftSub', platform: 'twitch', ...(m > 1 ? { min: m } : {}) }); }
      else if (/raid/.test(key)) { const m = minOf(v); out.push({ kind: 'raid', platform: 'twitch', ...(m > 0 ? { minViewers: m } : {}) }); }
      else if (/follow/.test(key)) out.push({ kind: 'follow', platform: 'twitch' });
      else out.push({ kind: 'sub', platform: 'twitch' });
    }
  };
  const h = objOf(hotkey);
  scan(h, 0);
  return out;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);

/** VTube Studio's model file -> rules (all OFF). `vts` = the parsed .vtube.json. */
export function vtsHotkeysToRules(vts: unknown): VtsRulesResult {
  const list = Array.isArray(objOf(vts).Hotkeys) ? objOf(vts).Hotkeys as unknown[] : [];
  const rules: StreamRule[] = [], skipped: VtsRulesResult['skipped'] = [];
  const seen = new Set<string>();
  let keyed = 0, twitch = 0;
  for (const [i, raw] of list.slice(0, 400).entries()) {
    const h = objOf(raw);
    const action = strOf(h.Action, 48), file = strOf(h.File, 300), name = strOf(h.Name) || stemOf(file) || `Hotkey ${i + 1}`;
    const step = stepFor(action, strOf(h.Name), file);
    if (!step) { skipped.push({ name, why: NO_RULE[action.toLowerCase().replace(/[^a-z]/g, '')] || `“${action || 'This action'}” has no matching action in VTube Pro yet.` }); continue; }
    const when: RuleWhen[] = [];
    const combo = vtsKeyCombo(h.Triggers);
    if (combo) when.push({ kind: 'key', combo });
    const tw = vtsTwitchWhen(h);
    when.push(...tw);
    if (!when.length) { skipped.push({ name, why: 'It had no keyboard key or Twitch trigger.' }); continue; }
    if (combo) keyed++;
    if (tw.length) twitch++;
    let id = `vts-${slug(name) || i + 1}`, n = 2;
    while (seen.has(id)) id = `vts-${slug(name) || i + 1}-${n++}`;
    seen.add(id);
    // "switch it off again after N seconds": a second toggle N seconds later (a rule step waits at most 60 s)
    const secs = typeof h.DeactivateAfterSeconds === 'number' && h.DeactivateAfterSeconds > 0 ? h.DeactivateAfterSeconds : 0;
    const timed = secs > 0 && /^toggleexpression$/i.test(action.replace(/[^a-z]/gi, ''));
    const back: RuleStep[] = timed && secs <= 60 ? [{ ...step, delayMs: Math.round(secs * 1000) }] : [];
    rules.push({
      id, name: name.slice(0, 60), enabled: false, when: when.slice(0, 8), then: [step, ...back],
      revertSecs: 0, cooldownSecs: tw.length ? 5 : 0,
      note: `From your VTube Studio hotkey “${name}”.${timed && !back.length ? ' VTube Studio switched it off after a while; here you switch it off yourself.' : ''}`.slice(0, 200),
    });
  }
  const clean = sanitizeRules(rules).map((r) => ({ ...r, enabled: false }));
  const notes: string[] = [];
  if (clean.length) notes.push('They are all switched off. Turn on the ones you want in Rules.');
  if (keyed) notes.push('Your model’s own keys already work in the studio. A key rule is for pressing the key while another app (your game) is in front.');
  if (twitch) notes.push('Twitch triggers need your Twitch chat connected.');
  return { rules: clean, skipped, notes };
}

/** The same as a .vtprules.json file (text), ready to import in Rules. */
export function vtsRulesFile(vts: unknown, name = 'From VTube Studio'): string {
  return stringifyRuleSet(vtsHotkeysToRules(vts).rules, name);
}
