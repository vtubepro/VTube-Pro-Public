// Pro2D "Model sliders" + outfit switches in the studio (the Avatars tab's 2D model block, src/ui/rig2dPanel.ts).
//   * every parameter the face / voice / physics don't move (chest, body, outfit, hair, blush … — classified by
//     shared/rig2d/userParams.ts) gets a slider with its range, its default marked, ↺ reset; common ones first; the
//     whole list is folded away with a count ("Model sliders (6)") so the panel stays plain;
//   * each slider can be bound to a key (switch to a value and back, or step through values), a chat word, a stream
//     event (follow, sub, raid, cheer, donation, a channel-point redeem), with a transition time and an optional
//     "back after"; the Stream Deck / bus command `flat {param, op: toggle|step|set|reset|on|off, value?}` does the same
//     (shared/deck.ts "2D model slider / outfit");
//   * the model's own expression keys TOGGLE and STACK, like in VTube Studio (hat + glasses + jacket together, a face
//     expression on top): FlatCue.x, mixed by shared/rig2d/animate.ts ExpressionMixer; `flat {toggle: name}` too;
//   * costume layers (.vtp2 `layers`) show as named outfit switches, live (no reload) and on keys / the deck too.
// Live values ride in the studio's flat cue (app.flatCue.p) so OBS and party guests show the same; the slider positions
// and switches set here are saved with the avatar (profile.flat.opts.params / layers / paramTriggers) — keys, the deck
// and chat change the look for this session only (like VTube Studio expressions), so OBS never reloads mid-show.
// Hooks: rig2dSliderHotkey (flatPanel.ts flatHotkey, one line), rig2dSliderCommand (app.ts 'flat' command, one line),
// toggleFlatExpression / flatExpressionOn / clearFlatExpressions (flatPanel.ts Expressions list on Pro2D models),
// rig2dSetLayer (mobile/showMode.ts outfit buttons).
import type { App } from '../app.ts';
import type { Rig2DDoc } from '../../shared/rig2d/format.ts';
import type { FlatCue } from '../../shared/flatAvatar.ts';
import type { Rig2DBinding } from '../../shared/rig2d/drive.ts';
import {
  DEFAULT_FADE, LAYER_PREFIX, UserParamState, classifyParams, comboOf, keyLabel, paramValuesJson, sameKey,
  sanitizeParamValues, sanitizeTriggers, studioKeyClash, switchLayer, sliderSaveFor, WardrobeLayers, chatFires, DEFAULT_COOLDOWN, MIN_CHAT_WORD, type ParamCue, type ParamTrigger, type UserParamInfo,
} from '../../shared/rig2d/userParams.ts';
import { rig2dExpressionList } from '../avatar/flat/rig2d/source.ts';
import { h, syncSlider, sliderControl, toast } from './dom.ts';

const CSS = `
.r2s{margin:6px 0 2px}
.r2s h4{margin:12px 0 4px;font-size:13px;font-weight:600}
.r2s .note{opacity:.85;font-size:12.5px;margin:4px 0 8px;color:var(--dim)}
.r2s details.r2s-box>summary{cursor:pointer;margin:8px 0;font-weight:600;list-style:none;display:flex;align-items:center;gap:8px;min-height:32px}
.r2s details.r2s-box>summary::-webkit-details-marker{display:none}
.r2s details.r2s-box>summary::before{content:'▸';display:inline-block;width:1em;transition:transform .12s;color:var(--dim)}
.r2s details.r2s-box[open]>summary::before{transform:rotate(90deg)}
.r2s-row{padding:6px 0 8px;border-top:1px solid var(--line)}
.r2s-head{display:flex;align-items:center;gap:6px;min-height:28px;flex-wrap:wrap}
.r2s-name{flex:1;min-width:0;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.r2s-chip{font:600 11.5px/1.7 ui-monospace,monospace;padding:0 6px;border:1px solid var(--line2);border-radius:6px;color:var(--dim);white-space:nowrap}
.r2s-chip.model{border-style:dashed}
.r2s-kchip{font:600 12px/1.6 ui-monospace,monospace;padding:0 6px;min-width:28px;border:1px solid var(--line,#2c343e);border-radius:5px;background:transparent;color:inherit;cursor:pointer}
.r2s-kchip.rec{border-color:var(--warn);color:var(--warn)}
@media (max-width:640px),(pointer:coarse){.r2s-kchip{min-height:44px;min-width:44px;font-size:14px}}
.r2s .r2s-kbtn,.r2s .r2s-btn{min-height:28px;padding:2px 10px;white-space:nowrap;border-radius:8px;border:1px solid var(--line2);background:var(--card2);color:var(--text);font:inherit;font-size:12.5px;cursor:pointer}
.r2s .r2s-btn.primary{background:var(--accent);color:var(--accent-ink);border-color:transparent}
.r2s .r2s-btn.rec{border-color:var(--warn);color:var(--warn)}
.r2s .sl-inline{width:100%}
.r2s .sl-reset{width:28px;height:28px;font-size:16px}
.r2s-ed{margin:8px 0 2px;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:var(--card2)}
.r2s-ed[hidden]{display:none}
.r2s-ed ul{list-style:none;margin:0 0 8px;padding:0}
.r2s-ed li{display:flex;align-items:center;gap:8px;padding:3px 0;font-size:12.5px}
.r2s-ed li span{flex:1;min-width:0}
.r2s-form{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 10px;align-items:center}
.r2s-form>label{font-size:12.5px;color:var(--dim)}
.r2s-form input[type=text],.r2s-form input[type=number],.r2s-form select{width:100%;min-width:0;min-height:28px;box-sizing:border-box}
.r2s-when{display:flex;flex-wrap:wrap;gap:6px}
.r2s-when>*{flex:1 1 120px;min-width:0}
.r2s-acts{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
.r2s-sw{display:flex;align-items:center;gap:8px;min-height:36px;padding:2px 0}
.r2s-sw .row.toggle{flex:1;margin:0}
.r2s .warn{color:var(--warn);font-size:12px}
@media (max-width:640px),(pointer:coarse){
 .r2s .r2s-kbtn,.r2s .r2s-btn{min-height:44px;padding:4px 14px;font-size:14px}
 .r2s details.r2s-box>summary{min-height:44px;font-size:15px}
 .r2s .sl-inline{flex-wrap:wrap;row-gap:0}
 .r2s .sl-inline .sl-track{flex:1 1 100%}
 .r2s .sl-inline .sl-end{margin-left:auto}
 .r2s .sl-track input[type=range]{-webkit-appearance:none;appearance:none;height:44px;background:transparent;touch-action:pan-y}
 .r2s .sl-track input[type=range]::-webkit-slider-runnable-track{height:8px;border-radius:4px;background:var(--line2)}
 .r2s .sl-track input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:44px;height:44px;margin-top:-18px;border-radius:50%;background:var(--accent);border:3px solid var(--card)}
 .r2s .sl-track input[type=range]::-moz-range-track{height:8px;border-radius:4px;background:var(--line2)}
 .r2s .sl-track input[type=range]::-moz-range-thumb{width:44px;height:44px;border-radius:50%;background:var(--accent);border:3px solid var(--card)}
 .r2s .sl-reset{width:44px;height:44px;font-size:20px}
 .r2s .sl-num{height:36px;width:64px}
 .r2s .sl-num input.sl-in{height:34px;line-height:34px;font-size:14px}
 .r2s-form{grid-template-columns:1fr}
 .r2s-form input[type=text],.r2s-form input[type=number],.r2s-form select{min-height:44px;font-size:15px}
 .r2s-sw{min-height:48px}
 .r2s-ed li{min-height:44px}
}`;
let cssDone = false;
function css() { if (!cssDone && typeof document !== 'undefined') { cssDone = true; document.head.append(h('style', { id: 'vtp-rig2d-sliders' }, CSS)); } }

interface RigLike { doc: Rig2DDoc; anim: { bindings: Rig2DBinding[] } }
interface LayerInfo { id: string; name: string; group: string | null; def: boolean }

// ================================================================ the per-avatar controller
class SliderCtl {
  readonly user: UserParamInfo[];
  readonly byId: Map<string, UserParamInfo>;
  readonly state: UserParamState;
  readonly layers: LayerInfo[];
  readonly layerOn = new Map<string, boolean>();
  triggers: ParamTrigger[];
  readonly sig: string;
  constructor(readonly avatarId: string, public doc: Rig2DDoc, bindings: readonly Rig2DBinding[], opts: Record<string, unknown>, prev: SliderCtl | null, costume?: string | null) {
    this.sig = sigOf(doc, bindings);
    const { user } = classifyParams(doc, bindings);
    this.user = user;
    this.byId = new Map(user.map((u) => [u.id, u]));
    // (saved positions of parameters that are no sliders any more — tracked now, or not in this model — are dropped)
    const keep = new Map([...sanitizeParamValues(opts.params)].filter(([k]) => this.byId.has(k)));
    this.state = new UserParamState(new Map(user.map((u) => [u.id, { min: u.min, max: u.max, def: u.def }])), keep);
    // (the same avatar rebuilt: keep what the performer holds live)
    if (prev) for (const [k, v] of prev.state.target) if (this.byId.has(k)) this.state.set(k, v, 0);
    this.layers = (doc.layers ?? []).map((l) => ({ id: l.id, name: l.name, group: l.group ?? null, def: l.on }));
    const saved = Array.isArray(opts.layers) ? new Set(opts.layers.filter((x): x is string => typeof x === 'string')) : null;
    for (const l of this.layers) this.layerOn.set(l.id, prev?.layerOn.get(l.id) ?? (saved ? saved.has(l.id) : l.def));
    // (the wardrobe's costume picks a layer at load, src/avatar/flat/rig2d/source.ts: the same here)
    // the wardrobe's costume (a costume layer): on at load; followed on later 'costume' events (WardrobeLayers)
    if (prev) this.wardrobe = prev.wardrobe; else { this.wardrobe = new WardrobeLayers(this.layers); this.wardrobe.start(this.layerOn, costume); }
    this.triggers = sanitizeTriggers(opts.paramTriggers).filter((t) => this.byId.has(t.param) || this.layerOf(t.param));
  }
  layerOf(param: string): LayerInfo | null { return param.startsWith(LAYER_PREFIX) ? this.layers.find((l) => l.id === param.slice(LAYER_PREFIX.length)) ?? null : null; }
  all(): ParamTrigger[] { return this.triggers; }
  forParam(id: string): ParamTrigger[] { return this.all().filter((t) => t.param === id); }
  wardrobe: WardrobeLayers;
  setLayer(id: string, on: boolean) { switchLayer(this.layers, this.layerOn, id, on); }
  cue(): ParamCue {
    const c = this.state.cue();
    for (const [id, on] of this.layerOn) c[LAYER_PREFIX + id] = [on ? 1 : 0, 0];
    return c;
  }
  nameOf(param: string): string { return this.layerOf(param)?.name ?? this.byId.get(param)?.name ?? param; }
}

let ctl: SliderCtl | null = null;
/** The same model (a rebuild of the same avatar loads a new copy of the same rig): the panel, keys and live state
 *  keep working on one controller. */
const sigOf = (doc: Rig2DDoc, bindings: readonly Rig2DBinding[] = []) => `${JSON.stringify(bindings)}#${doc.params.map((q) => `${q.id}:${q.min}:${q.max}:${q.default}`).join('|')}#${(doc.layers ?? []).map((l) => l.id).join('|')}#${(doc.expressions ?? []).length}`;
/** The controller for the avatar on show (null: not a Pro2D rig). Rebuilt when the avatar or its model changes. */
function controller(app: App): SliderCtl | null {
  const p = app.profile, src = app.runtime?.flat?.source as unknown as RigLike | undefined;
  if (!p?.flat || p.flat.kind !== 'rig2d' || !src?.doc) return null;
  if (ctl && ctl.avatarId === p.id && (ctl.doc === src.doc || ctl.sig === sigOf(src.doc, src.anim?.bindings ?? []))) { ctl.doc = src.doc; return ctl; }
  const prev = ctl && ctl.avatarId === p.id ? ctl : null;
  if (ctl && ctl.avatarId !== p.id) { clearTimeout(saveTimer); saveTimer = undefined; }
  ctl = new SliderCtl(p.id, src.doc, src.anim?.bindings ?? [], (p.flat.opts ?? {}) as Record<string, unknown>, prev, (p as { costume?: string | null }).costume);
  hookBus(app);
  return ctl;
}

/** Send the live state with every frame (OBS + party guests follow), and move the panel's sliders. */
function push(app: App, c: SliderCtl) {
  app.flatCue = { ...app.flatCue, p: c.cue() };
  app.emit('flat');
  for (const [id, r] of rows) { if (!r.isConnected) { rows.delete(id); continue; } syncSlider(r, c.state.value(id)); }
  for (const [id, r] of switches) { if (!r.isConnected) { switches.delete(id); continue; } r.checked = !!c.layerOn.get(id); }
}

function editOpts(app: App, fn: (o: Record<string, unknown>) => void, avatarId?: string) {
  if (avatarId && app.profile?.id !== avatarId) return;   // (only ever the avatar these sliders belong to)
  // (no rebuild: the live cue already shows it; the saved profile is what the model starts with next time)
  app.edit((p) => { if (p.flat) { const o = { ...(p.flat.opts ?? {}) }; fn(o); p.flat.opts = o; } }, false);
  const src = app.runtime?.flat?.source as unknown as { applyOpts?: (o: unknown) => void } | undefined;
  try { src?.applyOpts?.(app.profile?.flat?.opts ?? {}); } catch { /* the saved profile still has it */ }
}
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function saveValues(app: App, c: SliderCtl) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    const v = sliderSaveFor(app.profile?.id, c.avatarId, c.state.saved, new Set((ctl?.avatarId === c.avatarId ? ctl : c).byId.keys()));
    if (v) editOpts(app, (o) => { if (v.length) o.params = v; else delete o.params; }, c.avatarId);
  }, 1500);
}
const saveLayers = (app: App, c: SliderCtl) => editOpts(app, (o) => { o.layers = [...c.layerOn].filter(([, on]) => on).map(([id]) => id); }, c.avatarId);
const saveTriggers = (app: App, c: SliderCtl) => editOpts(app, (o) => { if (c.triggers.length) o.paramTriggers = c.triggers; else delete o.paramTriggers; }, c.avatarId);

/** The tracking mapping changed (the panel's Details): sliders are classified again; a parameter tracked now leaves the
 *  list and the live cue (tracking drives it; the pages' driver lets it go too). */
export function rig2dSlidersRefresh(app: App) {
  const before = ctl, c = controller(app);
  if (c && c !== before) push(app, c);
}

const now = () => performance.now() / 1000;
let holdTimer: ReturnType<typeof setInterval> | undefined;
function fire(app: App, c: SliderCtl, t: ParamTrigger, quiet = false) {
  const L = c.layerOf(t.param);
  if (L) c.setLayer(L.id, !c.layerOn.get(L.id));
  else if (c.state.press(t, now()) === null) return;
  push(app, c);
  if (t.hold && !holdTimer) holdTimer = setInterval(() => { const k = ctl; if (!k) return; if (k.state.tick(now())) push(app, k); }, 250);
  if (!quiet) toast(L ? `${L.name}: ${c.layerOn.get(L.id) ? 'on' : 'off'}` : `${c.nameOf(t.param)}: ${fmt(c.state.value(t.param), c.byId.get(t.param))}`, 'ok', 900);
}
const fmt = (v: number, u?: UserParamInfo) => v.toFixed(Math.min(3, Math.max(0, u?.decimals ?? 2)));

// ================================================================ keys (studio keydown; flatPanel.ts flatHotkey calls this first)
let recorder: ((combo: string) => void) | null = null;
/** A model slider / outfit key, or one of the model's expression keys (plain or a VTube Studio combination like
 *  Ctrl+1): on a Pro2D model expression keys TOGGLE and stack, like in VTube Studio. true = handled. */
export function rig2dSliderHotkey(e: KeyboardEvent, app: App): boolean {
  if (e.repeat || recorder) return false;
  const c = controller(app);
  if (!c) return false;
  const combo = comboOf(e);
  const hits = c.all().filter((t) => t.key && sameKey(t.key, combo));
  if (hits.length) { e.preventDefault(); for (const t of hits) fire(app, c, t, hits.length > 1 && t !== hits[0]); return true; }
  // (plain keys: the number row and the keypad are one key; Shift + key never fires a plain key's expression)
  const ex = (app.runtime?.flat?.expressions() ?? rig2dExpressionList(c.doc)).find((x) => x.key && sameKey(x.key, combo));
  if (ex) { e.preventDefault(); const on = toggleFlatExpression(app, ex.id); toast(`${ex.name}: ${on ? 'on' : 'off'}`, 'ok', 900); return true; }
  return false;
}

/** Switch one of a Pro2D model's expressions on / off on its own (the others stay: they stack). The expression the
 *  panel's "Show" held on counts as on. Returns whether it is on now. */
export function toggleFlatExpression(app: App, id: string): boolean {
  const x = [...(app.flatCue.x ?? [])], i = x.indexOf(id), held = app.flatCue.s === id;
  const on = !(i >= 0 || held);
  if (i >= 0) x.splice(i, 1);
  if (on) x.push(id);
  const cue: FlatCue = { ...app.flatCue, x };
  if (!x.length) delete cue.x;
  if (held) delete cue.s;
  app.flatCue = cue;
  app.emit('flat');
  return on;
}
/** Every expression off (held and toggled): "Default look". */
export function clearFlatExpressions(app: App) { const cue = { ...app.flatCue }; delete cue.x; delete cue.s; app.flatCue = cue; app.emit('flat'); }
/** Is an expression on (held or toggled)? */
export const flatExpressionOn = (app: App, id: string) => app.flatCue.s === id || !!app.flatCue.x?.includes(id);
/** Wait for the next key (Esc cancels); modifiers alone don't count. */
function recordKey(btn: HTMLButtonElement, done: (combo: string | null) => void, clearable = false) {
  const label = btn.textContent;
  btn.textContent = 'Press a key… (Esc = cancel)'; btn.classList.add('rec');
  const fin = (combo: string | null) => { window.removeEventListener('keydown', onKey, true); recorder = null; btn.textContent = label; btn.classList.remove('rec'); done(combo); };
  const onKey = (e: KeyboardEvent) => {
    if (/^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(e.code) || e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return;
    e.preventDefault(); e.stopPropagation();
    fin(e.code === 'Escape' ? null : clearable && (e.code === 'Delete' || e.code === 'Backspace') ? '' : comboOf(e));
  };
  recorder = fin;
  window.addEventListener('keydown', onKey, true);
}

/** The key of one of a Pro2D model's expressions in the 2D panel's Expressions list: shows it, and a click lets the
 *  performer pick another (Esc = keep, Delete / Backspace = no key). Keys the studio keeps and keys a model slider uses
 *  are refused with one sentence. Saved per avatar (profile.flat.opts.exprKeys). */
export function expressionKeyChip(app: App, x: { id: string; name: string; key?: string }, changed: () => void): HTMLElement {
  css();
  const b = h('button', { type: 'button', class: 'r2s-kchip', title: `The key for “${x.name}”: click, then press a key (Delete = no key)`, 'aria-label': `Key for ${x.name}: ${x.key ? keyLabel(x.key) : 'none'}. Change` }, x.key ? keyLabel(x.key) : '–');
  b.onclick = () => recordKey(b, (k) => {
    const p = app.profile;
    if (k === null || !p?.flat) return;
    if (k) {
      const no = studioKeyClash(k);
      if (no) { toast(no, 'warn', 4000); return; }
      const c = controller(app), slider = c?.triggers.find((t) => t.key && sameKey(t.key, k));
      if (slider) { toast(`${keyLabel(k)} is the key of the “${c!.nameOf(slider.param)}” slider — pick another key.`, 'warn', 4000); return; }
    }
    const id = p.id;
    editOpts(app, (o) => {
      const list = Array.isArray(o.exprKeys) ? (o.exprKeys as unknown[]).filter((e) => Array.isArray(e) && e[0] !== x.id && !(k && typeof e[1] === 'string' && sameKey(e[1], k))) : [];
      o.exprKeys = [...list, [x.id, k]];
    }, id);
    toast(k ? `${x.name}: ${keyLabel(k)}` : `${x.name}: no key`, 'ok', 1500);
    changed();
  }, true);
  return b;
}

// ================================================================ deck / bus command `flat {param, op, value}`
/** Stream Deck "2D model slider / outfit", MCP send_command, any bus client. `param` = a slider / outfit name or id
 *  (empty = the first slider); op toggle | step | set | reset (= back to the saved position) | on | off. */
export function rig2dSliderCommand(app: App, a: Record<string, unknown>) {
  const c = controller(app);
  if (!c) return;
  // `flat {toggle: expression id or name}`: switch one expression on / off (stacking)
  if (typeof a.toggle === 'string') {
    const q = a.toggle.trim().toLowerCase(), e = (c.doc.expressions ?? []).find((x) => x.id.toLowerCase() === q || x.name.toLowerCase() === q);
    if (e) toggleFlatExpression(app, e.id); else toast(`This model has no expression called “${a.toggle.slice(0, 40)}”.`, 'warn', 3000);
    return;
  }
  const q = String(a.param ?? '').trim().toLowerCase().slice(0, 128), op = String(a.op ?? 'toggle');
  const L = q ? c.layers.find((l) => l.id.toLowerCase() === q || l.name.toLowerCase() === q) : undefined;
  if (L) {
    c.setLayer(L.id, op === 'on' ? true : op === 'off' ? false : op === 'reset' ? L.def : !c.layerOn.get(L.id));
    push(app, c);
    return;
  }
  const u = !q ? c.user[0] : c.user.find((x) => x.id.toLowerCase() === q || x.name.toLowerCase() === q) ?? c.user.find((x) => x.name.toLowerCase().includes(q) || x.id.toLowerCase().includes(q));
  if (!u) { toast(q ? `This model has no slider called “${String(a.param)}”.` : 'This model has no model sliders.', 'warn', 3000); return; }
  const base = c.state.base(u.id), far = base - u.min < u.max - base ? u.max : u.min;
  const own = (m: ParamTrigger['mode']) => c.forParam(u.id).find((t) => t.mode === m);
  const v = Number(a.value);
  switch (op) {
    case 'set': if (Number.isFinite(v)) c.state.set(u.id, v); break;
    case 'reset': case 'off': c.state.set(u.id, base); break;
    case 'on': c.state.set(u.id, own('toggle')?.values[0] ?? far, own('toggle')?.fade ?? DEFAULT_FADE); break;
    case 'step': c.state.press(own('step') ?? { param: u.id, mode: 'step', values: [u.min, (u.min + u.max) / 2, u.max] }, now()); break;
    default: c.state.press(own('toggle') ?? { param: u.id, mode: 'toggle', values: [far] }, now());
  }
  push(app, c);
}

/** An outfit / accessory switch from elsewhere in the studio (the phone's show mode, mobile/showMode.ts): the same
 *  path as the panel's switch — the live cue (so the next frame's cue agrees and nothing snaps back), the switches,
 *  the saved list. false = no Pro2D slider controller for this avatar (the caller switches the model itself). */
export function rig2dSetLayer(app: App, id: string, on: boolean): boolean {
  const c = controller(app);
  if (!c || !c.layers.some((l) => l.id === id)) return false;
  c.setLayer(id, on); push(app, c); saveLayers(app, c);
  return true;
}

// ================================================================ chat + stream events (the studio's bus)
let busHooked = false;
const seen = new Set<string>();
const lastFire = new Map<ParamTrigger, number>();
function hookBus(app: App) {
  if (busHooked) return;
  busHooked = true;
  // a wardrobe costume that is a costume layer (same avatar, rebuilt): the live controller wears it and sends a fresh
  // cue, so the old session outfit in the cue can't switch it back off on the model, OBS or the panel's switches
  app.on((what) => {
    if (what !== 'costume' || !ctl || app.profile?.id !== ctl.avatarId) return;
    const c = controller(app);
    if (!c) return;
    // (a real costume change only: an accessory toggle fires the same event with the same costume — no change)
    if (c.wardrobe.wear(c.layerOn, (app.profile as { costume?: string | null }).costume)) push(app, c);
  });
  app.bus.on((m) => {
    if (m.type !== 'chat' || m.snap || !Array.isArray(m.evs)) return;
    const c = ctl;
    if (!c || !c.all().some((t) => t.chat || t.event) || app.profile?.id !== c.avatarId) return;
    const fresh = m.evs.slice(0, 50).filter((e) => e?.id && !seen.has(e.id));
    for (const e of fresh) seen.add(e.id);
    if (seen.size > 600) seen.clear();
    // (one fire per slider / outfit per message, each trigger at most once per its cooldown: chat can't strobe it)
    for (const t of chatFires(c.all(), fresh, now(), lastFire)) fire(app, c, t, true);
  });
}
// ================================================================ the panel block
const rows = new Map<string, HTMLInputElement>();
const switches = new Map<string, HTMLInputElement>();
const OPEN_KEY = 'vtp.rig2d.sliders.open';
const SHOW_FIRST = 10;
const EVENTS: [string, string][] = [['', '— no stream event —'], ['follow', 'A follow'], ['sub', 'A sub / membership'], ['raid', 'A raid'], ['cheer', 'Bits / cheer'],
  ['donation', 'A donation / Super Chat'], ['redeem', 'Any channel-point redeem']];

/** Outfit switches + "Model sliders (N)" for the Pro2D model on show; null when it isn't one. */
export function rig2dSliders(app: App): HTMLElement | null {
  const c = controller(app);
  if (!c) return null;
  css();
  const root = h('div', { class: 'r2s', 'data-tut': 'rig2d-sliders' });
  if (c.layers.length) root.append(outfits(app, c));
  root.append(sliders(app, c));
  return root;
}

function chipsFor(c: SliderCtl, param: string): HTMLElement[] {
  return c.forParam(param).map((t) => h('span', { class: 'r2s-chip', title: describe(c, t) }, t.key ? keyLabel(t.key) : t.chat ? `“${t.chat}”` : t.event ?? '•'));
}
function describe(c: SliderCtl, t: ParamTrigger): string {
  const when = [t.key ? `key ${keyLabel(t.key)}` : '', t.chat ? `chat says “${t.chat}”` : '', t.event ? (EVENTS.find(([k]) => k === t.event)?.[1].toLowerCase() ?? t.event) : ''].filter(Boolean).join(' or ');
  const u = c.byId.get(t.param);
  const what = c.layerOf(t.param) ? 'switches it on / off' : t.mode === 'step' ? `steps through ${t.values.map((v) => fmt(v, u)).join(', ')}`
    : `goes to ${fmt(t.values[0], u)} and back${t.values.length > 1 ? ` to ${fmt(t.values[1], u)}` : ''}`;
  return `${when || 'Deck only'}: ${what}${t.fade !== undefined && !c.layerOf(t.param) ? ` over ${t.fade} s` : ''}${t.hold ? `, back after ${t.hold} s` : ''}`;
}

function outfits(app: App, c: SliderCtl): HTMLElement {
  const box = h('div', null, h('h4', null, 'Outfits'));
  for (const L of c.layers) {
    const input = h('input', { type: 'checkbox', checked: !!c.layerOn.get(L.id), 'aria-label': L.name });
    input.onchange = () => { c.setLayer(L.id, input.checked); push(app, c); saveLayers(app, c); };
    switches.set(L.id, input);
    const param = LAYER_PREFIX + L.id;
    const chips = h('span', null, ...chipsFor(c, param));
    const keyBtn = h('button', { type: 'button', class: 'r2s-kbtn', title: 'Put this outfit on a key (press it to switch on / off)' }, c.forParam(param).length ? 'Change key' : 'Add key');
    keyBtn.onclick = () => recordKey(keyBtn, (combo) => {
      if (!combo) return;
      const no = studioKeyClash(combo);
      if (no) { toast(no, 'warn', 4000); return; }
      c.triggers = [...c.triggers.filter((t) => t.param !== param), { param, mode: 'toggle', values: [1, 0], key: combo }];
      saveTriggers(app, c);
      chips.replaceChildren(...chipsFor(c, param));
      keyBtn.textContent = 'Change key';
      toast(`${L.name}: ${keyLabel(combo)} switches it on / off.`, 'ok', 3500);
    });
    box.append(h('div', { class: 'r2s-sw' }, h('label', { class: 'row toggle' }, h('span', { class: 'lbl' }, L.name), h('span', { class: 'switch' }, input, h('i'))), chips, keyBtn));
  }
  return box;
}

function sliders(app: App, c: SliderCtl): HTMLElement {
  const n = c.user.length;
  const det = h('details', { class: 'r2s-box' }) as HTMLDetailsElement;
  try { det.open = localStorage.getItem(OPEN_KEY) === '1'; } catch { /* closed */ }
  det.addEventListener('toggle', () => { try { localStorage.setItem(OPEN_KEY, det.open ? '1' : '0'); } catch { /* fine */ } });
  det.append(h('summary', null, `Model sliders (${n})`));
  if (!n) { det.append(h('p', { class: 'note' }, 'This model has no extra sliders: everything on it follows your face and voice.')); return det; }
  det.append(h('p', { class: 'note' }, `Parts of the model your face doesn’t move: body, chest, outfit, hair … Drag to set; it’s kept with this avatar. Put any of them on a key, the Stream Deck or a chat word with “Keys and chat”. The model’s own expression keys still work on top.`));
  // (models with dozens of effect parameters: the common ones + a few, the rest one tap away)
  const common = c.user.filter((u) => u.group === 'chest' || u.group === 'body' || u.group === 'outfit' || u.group === 'hair' || c.forParam(u.id).length);
  const first = new Set([...common, ...c.user.filter((u) => !common.includes(u)).slice(0, Math.max(0, SHOW_FIRST - common.length))]);
  for (const u of c.user) if (first.has(u)) det.append(row(app, c, u));
  const rest = c.user.filter((u) => !first.has(u));
  if (rest.length) {
    const more = h('button', { type: 'button', class: 'r2s-btn' }, `Show all ${n} sliders`);
    more.onclick = () => { more.replaceWith(...rest.map((u) => row(app, c, u))); };
    det.append(h('div', { class: 'r2s-acts' }, more));
  }
  return det;
}

function row(app: App, c: SliderCtl, u: UserParamInfo): HTMLElement {
  const span = u.max - u.min, dec = Math.min(4, Math.max(0, u.decimals ?? (span > 20 ? 0 : span > 2 ? 1 : 2)));
  const step = Math.max(10 ** -dec, +(span / 100).toFixed(dec + 1));
  const ctlEl = sliderControl(c.state.value(u.id), u.min, u.max, step, (v) => {
    c.state.set(u.id, v, 0.12); c.state.keep(u.id); push(app, c); saveValues(app, c);
  }, { def: u.def, inline: true, label: u.name });
  const range = ctlEl.querySelector('input[type=range]') as HTMLInputElement;
  rows.set(u.id, range);
  const chips = h('span', { class: 'r2s-chips' }, ...chipsFor(c, u.id));
  const ed = h('div', { class: 'r2s-ed', hidden: true });
  const kbtn = h('button', { type: 'button', class: 'r2s-kbtn', 'aria-expanded': 'false', title: 'Keys, Stream Deck, chat and stream events for this slider' }, 'Keys and chat');
  kbtn.onclick = () => { const open = ed.hidden; ed.hidden = !open; kbtn.setAttribute('aria-expanded', String(open)); if (open) editor(app, c, u, ed, () => chips.replaceChildren(...chipsFor(c, u.id))); };
  return h('div', { class: 'r2s-row', 'data-param': u.id },
    h('div', { class: 'r2s-head' }, h('span', { class: 'r2s-name', title: u.name === u.id ? u.id : `${u.name} (${u.id})` }, u.name), chips, kbtn),
    ctlEl, ed);
}

/** "Keys" for one slider: what's bound now + add a key / chat word / stream event. */
function editor(app: App, c: SliderCtl, u: UserParamInfo, ed: HTMLElement, changed: () => void) {
  const list = h('ul');
  const paintList = () => {
    list.replaceChildren(...c.forParam(u.id).map((t) => h('li', null, h('span', null, describe(c, t)),
      h('button', { type: 'button', class: 'r2s-btn', 'aria-label': 'Remove', onClick: () => { c.triggers = c.triggers.filter((x) => x !== t); saveTriggers(app, c); paintList(); changed(); } }, 'Remove'))));
    if (!list.childElementCount) list.append(h('li', null, h('span', { class: 'note' }, 'Nothing yet. The Stream Deck’s “2D model slider / outfit” button works with any slider by its name.')));
  };
  paintList();
  // the form (zero effort: a key that switches to the far end and back, smoothly)
  const base = c.state.base(u.id), far = base - u.min < u.max - base ? u.max : u.min;
  let combo = '';
  const keyBtn = h('button', { type: 'button', class: 'r2s-btn' }, 'Press a key…');
  const warn = h('span', { class: 'warn' });
  keyBtn.onclick = () => recordKey(keyBtn, (k) => {
    if (!k) return;
    const no = studioKeyClash(k);
    if (no) { warn.textContent = no; combo = ''; keyBtn.textContent = 'Press a key…'; return; }
    combo = k; keyBtn.textContent = `Key: ${keyLabel(k)}`; warn.textContent = '';
  });
  const chat = h('input', { type: 'text', placeholder: 'or a chat word', maxLength: 64, 'aria-label': 'Chat word' });
  const ev = h('select', { 'aria-label': 'Stream event' }, ...EVENTS.map(([v, l]) => h('option', { value: v }, l)));
  const mode = h('select', { 'aria-label': 'What it does' }, h('option', { value: 'toggle' }, 'Switch to a value and back'), h('option', { value: 'step' }, 'Step through values'));
  let to = far;
  const toCtl = sliderControl(far, u.min, u.max, Math.max(1e-4, (u.max - u.min) / 100), (v) => { to = v; }, { inline: true, label: 'Goes to' });
  const steps = h('input', { type: 'text', value: [u.min, (u.min + u.max) / 2, u.max].map((v) => fmt(v, u)).join(', '), 'aria-label': 'Values to step through' });
  const valRow = h('div', null, toCtl);
  mode.onchange = () => valRow.replaceChildren(mode.value === 'step' ? steps : toCtl);
  const fade = h('input', { type: 'number', min: '0', max: '30', step: '0.1', value: String(DEFAULT_FADE), 'aria-label': 'Transition seconds' });
  const hold = h('input', { type: 'number', min: '0', max: '3600', step: '1', placeholder: 'stays', 'aria-label': 'Back after seconds' });
  const cool = h('input', { type: 'number', min: '0', max: '600', step: '1', placeholder: String(DEFAULT_COOLDOWN), 'aria-label': 'Chat and events: at most every seconds' });
  const add = h('button', { type: 'button', class: 'r2s-btn primary' }, 'Add');
  add.onclick = () => {
    const t: Record<string, unknown> = { param: u.id, mode: mode.value, values: mode.value === 'step' ? steps.value.split(/[,;\s]+/).map(Number).filter(Number.isFinite) : [to],
      fade: Number(fade.value) || 0 };
    if (combo) t.key = combo;
    if (chat.value.trim()) {
      if (chat.value.trim().length < MIN_CHAT_WORD) { warn.textContent = `A chat word needs at least ${MIN_CHAT_WORD} letters (a shorter one matches almost every message).`; return; }
      t.chat = chat.value.trim();
    }
    if (Number(cool.value) >= 0 && cool.value !== '') t.cooldown = Number(cool.value);
    if (ev.value) t.event = ev.value;
    if (Number(hold.value) > 0) t.hold = Number(hold.value);
    const ok = sanitizeTriggers([t])[0];
    if (!ok) { toast(mode.value === 'step' ? 'Type the values to step through, like 0, 0.5, 1.' : 'That didn’t work: pick a value.', 'warn'); return; }
    if (!ok.key && !ok.chat && !ok.event) toast('Saved for the Stream Deck. Add a key, a chat word or an event to use it without the deck.', 'info', 4000);
    c.triggers = [...c.triggers, ok];
    saveTriggers(app, c); paintList(); changed();
    combo = ''; keyBtn.textContent = 'Press a key…'; warn.textContent = ''; chat.value = ''; ev.value = ''; hold.value = ''; cool.value = '';
  };
  ed.replaceChildren(list,
    h('div', { class: 'r2s-form' },
      h('label', null, 'When'), h('div', { class: 'r2s-when' }, keyBtn, chat, ev),
      h('label', null, 'Does'), mode,
      h('label', null, 'Value'), valRow,
      h('label', null, 'Smoothly over (seconds)'), fade,
      h('label', null, 'Back after (seconds)'), hold,
      h('label', null, 'Chat / events at most every (seconds)'), cool),
    warn, h('div', { class: 'r2s-acts' }, add));
}
