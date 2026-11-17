// Chat & events → "Chat box on stream" (owner: "People need to be able to choose the chatbox location and size", and
// chatfx: "Add an option to choose where I want the chat to be"): when the docked chat box shows (Off / When chat is
// active / Always), where it sits (Auto, a corner, an edge, or Free: drag it ON YOUR STREAM's live picture and pull a
// corner, with snapping to the edges, the centre lines and the safe margin), its size, opacity and text size.
//
// Per room / per mode (chatfx): "Applies to" = Every room · This room · This room in <mode>. The most specific place
// that exists is what OBS shows (shared/chatBox.ts resolveChatBox); "Use this place everywhere" makes one place for all.
// The panel always says which place the stream uses right now, including when the Layout editor's older per-preset chat
// box wins (with a one-click "Use my place here"): the streamer's choice is never overridden silently.
//
// One host setting, SceneState.stage.chatBox (+ dock.chat + chatText): saved by the helper with the scene, so it sticks
// across reloads / restarts, and every OBS page (the host's and the party guests') follows as soon as it is changed.
// Mounted by src/ui/chatPanel.ts (chatBoxSection(app, {live: true}): the live picture behind the box) and the stream
// set-up wizard (chatBoxSection(app)); repaints itself on scene changes, never while dragging.
import type { App } from '../app.ts';
import { DEFAULT_STAGE, type DockMode, type Rect } from '../../shared/stage.ts';
import {
  CHAT_BOX_LIMITS, DEFAULT_CHAT_BOX, chatBoxPreset, chatBoxRect, chatDockChoice, chatScopeCount, chatScopeKey, dropChatScope, hasChatScope, resolveChatBox,
  sanitizeChatBox, scopeEditPlace, setChatScope, sizeOfBox, useChatEverywhere, type ChatBoxAt, type ChatBoxCore, type ChatBoxSize, type ChatScope,
} from '../../shared/chatBox.ts';
import { LAYOUT_BAG, activeSlot, roomKey, sanitizeLayoutBag, slotKey, snapRect } from '../../shared/stageLayout.ts';
import { stageModeDef } from '../scene/stage/modeCore.ts';
import { h, rerender, slider, toast } from './dom.ts';
import { canvasSize } from './stage/common.ts';
import { chatTextSection } from './stage/chatTextPanel.ts';
import { mountPreviewFrame, parkPreviewFrame, previewWanted, setPreviewWanted } from './previewFrame.ts';

const CSS = `
.cbx { display:grid; gap:8px; }
.cbx-seg { display:flex; flex-wrap:wrap; gap:4px; }
.cbx-seg button { font:inherit; font-size:12.5px; padding:5px 10px; border-radius:99px; border:1px solid var(--line2, #3a4254); background:var(--card2, #1b2130); color:var(--text, #e8ecf4); cursor:pointer; }
.cbx-seg button[aria-pressed="true"] { background:var(--accent2-soft, #6cc7f522); border-color:var(--accent2, #6cc7f5); color:var(--text, #eef1f6); font-weight:700; }
.cbx-seg button:disabled { opacity:.5; cursor:default; }
.cbx-seg button .own { display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--accent, #a78bfa); margin-left:6px; vertical-align:middle; }
.cbx-main { display:grid; grid-template-columns: 112px 1fr; gap:10px; align-items:start; }
@media (max-width: 520px) { .cbx-main { grid-template-columns: 1fr; } .cbx-pad { max-width: 180px; } }
.cbx-pad { display:grid; grid-template-columns: repeat(3, 1fr); gap:4px; }
.cbx-pad button { aspect-ratio: 16/10; border-radius:7px; border:1px solid var(--line2, #3a4254); background:var(--card2, #1b2130); cursor:pointer; position:relative; padding:0; color:var(--dim, #9aa4b8); font:600 10.5px/1 Inter, system-ui, sans-serif; }
.cbx-pad button i { position:absolute; background:var(--dim, #9aa4b8); border-radius:2px; opacity:.85; }
.cbx-pad button[aria-pressed="true"] { border-color:var(--accent2, #6cc7f5); box-shadow:0 0 0 1px var(--accent2, #6cc7f5) inset; background:color-mix(in srgb, var(--accent2, #6cc7f5) 16%, var(--card2, #1b2130)); color:var(--text, #e8ecf4); }
.cbx-pad button[aria-pressed="true"] i { background:var(--accent2, #6cc7f5); opacity:1; }
.cbx-pad button:focus-visible, .cbx-seg button:focus-visible, .cbx-box:focus-visible { outline:2px solid var(--focus, #8ab4ff); outline-offset:1px; }
.cbx-free { grid-column: 1 / -1; aspect-ratio:auto !important; padding:5px 0 !important; font-size:12px !important; }
.cbx-stage { position:relative; width:100%; border-radius:10px; overflow:hidden; border:1px solid var(--line, #2a3142); touch-action:none; user-select:none;
  background: radial-gradient(ellipse 30% 46% at 50% 62%, #8a93a855 0 60%, transparent 61%), radial-gradient(circle at 50% 33%, #8a93a855 0 7.5%, transparent 7.6%), linear-gradient(160deg, #26314a, #121722 70%); }
.cbx-stage.live { background:#000 repeating-conic-gradient(#1a1d24 0 25%, #14171c 0 50%) 0 0/16px 16px; }
.cbx-stage iframe { position:absolute; inset:0; width:100%; height:100%; border:0; pointer-events:none; color-scheme:normal; }
.cbx-stage .lbl { position:absolute; left:8px; top:6px; font:600 10.5px/1.2 Inter, system-ui, sans-serif; color:#ffffffa0; letter-spacing:.02em; pointer-events:none; z-index:3; text-shadow:0 1px 2px #000; }
.cbx-stage .g { position:absolute; background:var(--pink,#ff7ac8); pointer-events:none; opacity:.9; z-index:3; }
.cbx-stage .g.v { top:0; bottom:0; width:1px; } .cbx-stage .g.hz { left:0; right:0; height:1px; }
.cbx-box { position:absolute; z-index:2; box-sizing:border-box; border-radius:7px; border:1.5px solid #a78bfa; background:#151a24e6; box-shadow:0 4px 14px #0008; cursor:move; overflow:hidden; outline:none; touch-action:none; }
.cbx-stage.live .cbx-box { background:#a78bfa1f; box-shadow:0 0 0 1px #000a inset; overflow:visible; }
.cbx-stage.live .cbx-box .ln { display:none; }
.cbx-box.auto { border-style:dashed; cursor:default; }
.cbx-box .ln { margin:5px 6px 0; height:5px; border-radius:3px; background:#ffffff44; }
.cbx-box .ln b { display:inline-block; height:100%; width:22%; border-radius:3px; background:#a78bfa; vertical-align:top; margin-right:4%; }
.cbx-box .hd, .cbx-box .ht { position:absolute; width:14px; height:14px; z-index:1; }
.cbx-box .hd { right:-1px; bottom:-1px; cursor:nwse-resize; background:linear-gradient(135deg, transparent 50%, #fff 50%); border-bottom-right-radius:6px; }
.cbx-box .hd.l { right:auto; left:-1px; cursor:nesw-resize; background:linear-gradient(225deg, transparent 50%, #fff 50%); border-bottom-right-radius:0; border-bottom-left-radius:6px; }
.cbx-box .ht { right:-1px; top:-1px; cursor:nesw-resize; background:linear-gradient(45deg, transparent 50%, #fff 50%); border-top-right-radius:6px; }
.cbx-box .ht.l { right:auto; left:-1px; cursor:nwse-resize; background:linear-gradient(315deg, transparent 50%, #fff 50%); border-top-right-radius:0; border-top-left-radius:6px; }
.cbx-box.auto .hd, .cbx-box.auto .ht { display:none; }
@media (pointer: coarse) { .cbx-box .hd, .cbx-box .ht { width:22px; height:22px; } }
.cbx-box .tag { position:absolute; left:4px; top:3px; font:700 10px/1.2 Inter, system-ui, sans-serif; color:#fff; background:#000a; padding:1px 5px; border-radius:4px; white-space:nowrap; pointer-events:none; }
.cbx-stage:not(.live) .cbx-box .tag { display:none; }
.cbx-note { font-size:12px; color:var(--dim, #9aa4b8); margin:0; }
.cbx-use { font-size:12.5px; margin:0; padding:6px 9px; border-radius:8px; background:var(--card2, #1b2130); border:1px solid var(--line2, #3a4254); }
.cbx-use b { color:var(--text, #e8ecf4); }
.cbx-use.warn { border-color:#e9c440; background:color-mix(in srgb, #e9c440 12%, var(--card2, #1b2130)); }
.cbx-acts { display:flex; flex-wrap:wrap; gap:6px; }
.cbx-acts .btn { padding:4px 10px; font-size:12px; }
.cbx-live { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--dim, #9aa4b8); }
`;
let cssDone = false;
const LIVE_KEY = 'vtp.chatbox.live';
const ls = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage off */ } } };

const PAD: { at: ChatBoxAt; label: string; dot: string }[] = [
  { at: 'tl', label: 'Top left', dot: 'left:8%;top:12%;width:26%;height:34%' },
  { at: 'top', label: 'Top', dot: 'left:28%;top:12%;width:44%;height:22%' },
  { at: 'tr', label: 'Top right', dot: 'right:8%;top:12%;width:26%;height:34%' },
  { at: 'left', label: 'Left side', dot: 'left:8%;top:28%;width:22%;height:44%' },
  { at: 'auto', label: 'Auto', dot: '' },
  { at: 'right', label: 'Right side', dot: 'right:8%;top:28%;width:22%;height:44%' },
  { at: 'bl', label: 'Bottom left', dot: 'left:8%;bottom:12%;width:26%;height:34%' },
  { at: 'bottom', label: 'Bottom', dot: 'left:28%;bottom:12%;width:44%;height:22%' },
  { at: 'br', label: 'Bottom right', dot: 'right:8%;bottom:12%;width:26%;height:34%' },
];
const SHOW: { v: DockMode; label: string; hint: string }[] = [
  { v: 'off', label: 'Off', hint: 'No chat box on the stream (the chat monitor / chat buddy in a room still work)' },
  { v: 'auto', label: 'When active', hint: 'Shows while chat is connected or messages are coming in, and only when the room’s own chat screen isn’t in the shot' },
  { v: 'always', label: 'Always', hint: 'Always on the stream, in every mode (Talk, React, Gaming …)' },
];
const SIZES: { v: ChatBoxSize; label: string }[] = [{ v: 's', label: 'Small' }, { v: 'm', label: 'Medium' }, { v: 'l', label: 'Large' }];
const modeName = (m: string) => stageModeDef(m)?.label ?? (m ? m[0].toUpperCase() + m.slice(1) : 'this mode');

export interface ChatBoxSectionOpts {
  /** Draw the box over the studio's live picture of the stream (the Chat area); else a drawn stand-in. */
  live?: boolean;
}

/** The "Chat box on stream" section body (Chat & events panel, stream set-up). */
export function chatBoxSection(app: App, opts: ChatBoxSectionOpts = {}): HTMLElement {
  if (!cssDone) { document.head.append(h('style', null, CSS)); cssDone = true; }
  const S = app.scene;
  const [CW, CH] = canvasSize();
  const aspect = CW / CH;
  const stage = () => S.stage ?? DEFAULT_STAGE;
  const room = () => S.effective.sceneId ?? null;
  const mode = () => String(S.effective.mode ?? 'talk');
  /** Which place this panel edits (null = the one the stream uses now). */
  let pick: ChatScope | null = null;
  const effScope = (): ChatScope => resolveChatBox(stage().chatBox, room(), mode()).scope;
  const scope = (): ChatScope => { const sc = pick ?? effScope(); return sc !== 'all' && !room() ? 'all' : sc; };
  /** The place being edited (its scope's own, else what that scope would inherit). */
  /** The place being edited: the scope's own, else what it inherits (the Layout editor's rect when that is what the
   *  stream shows: the first edit keeps the chat where it is). Picking a scope writes nothing. */
  const place = (): ChatBoxCore => {
    const sl = slotChat(), rm = room(), md = mode();
    const onLayout = !!sl && chatDockChoice(stage().chatBox, rm, md, true, aspect).use === 'layout';
    return scopeEditPlace(stage().chatBox, scope(), rm, md, onLayout ? sl!.rect : null);
  };
  let draft: ChatBoxCore | null = null;                 // while dragging: shown here, saved on release
  const save = (p: ChatBoxCore) => {
    if (!S.canEdit) return;
    const sc = scope();
    S.setStage({ chatBox: setChatScope(stage().chatBox, sc, room(), mode(), p) });
  };
  const setDock = (v: DockMode) => { if (S.canEdit) S.setStage({ dock: { ...stage().dock, chat: v } }); };
  // the Layout editor's per-preset chat rect (shared/stageLayout.ts) for this room / mode / preset
  // the plan's label (= the Layout editor's preset): the stage report's when a preview / OBS page reports one, else the
  // mode's own label (what a room shot's plan is called: compositor plan3d) — the panel must not need a preview running
  const planLabel = () => S.report?.stage?.label ?? stageModeDef(mode())?.label ?? mode();
  const slotChat = () => {
    const rm = room(), label = planLabel();
    if (!rm) return null;
    const slot = activeSlot(sanitizeLayoutBag((S.effective.modes ?? {})[LAYOUT_BAG]), rm, mode(), label);
    const c = slot?.chat;
    return Array.isArray(c) ? { label, rect: { x: c[0], y: c[1], w: c[2], h: c[3] } } : null;
  };
  const dropSlotChat = () => {
    const rm = room();
    if (!rm || !S.canEdit) return;
    const bag = sanitizeLayoutBag((S.effective.modes ?? {})[LAYOUT_BAG]);
    const sl = bag.rooms[roomKey(rm)]?.[slotKey(mode(), planLabel())];
    if (sl) { delete sl.chat; S.setModeBag(LAYOUT_BAG, bag); }
  };

  const root = h('div', { class: 'cbx', 'data-cbx': '1' });
  const scopeSeg = h('div', { class: 'cbx-seg', role: 'radiogroup', 'aria-label': 'Which rooms this place is for' });
  const seg = h('div', { class: 'cbx-seg', role: 'radiogroup', 'aria-label': 'When the chat box shows' });
  const pad = h('div', { class: 'cbx-pad', role: 'radiogroup', 'aria-label': 'Where the chat box sits' });
  const wantLive = () => !!opts.live && ls.get(LIVE_KEY) !== '0' && ls.get('vtp.scene.preview') === '1';
  const stg = h('div', { class: 'cbx-stage', style: `aspect-ratio:${CW} / ${CH}` }, h('span', { class: 'lbl' }, 'Your stream'));
  const lines = Array.from({ length: 12 }, (_, i) => h('div', { class: 'ln', style: `width:${[78, 60, 86, 52, 70, 90, 64, 74, 58, 82, 66, 72][i]}%` }, h('b')));
  const hdR = h('i', { class: 'hd', 'data-h': 'se', title: 'Drag to resize' });
  const hdL = h('i', { class: 'hd l', 'data-h': 'sw', title: 'Drag to resize' });
  const htR = h('i', { class: 'ht', 'data-h': 'ne', title: 'Drag to resize' });
  const htL = h('i', { class: 'ht l', 'data-h': 'nw', title: 'Drag to resize' });
  const tag = h('span', { class: 'tag' }, 'Chat');
  const boxEl = h('div', { class: 'cbx-box', tabindex: 0, role: 'button', 'aria-label': 'Chat box: drag to move, drag a corner to resize, arrow keys move it (Alt + arrows resize)' }, ...lines, tag, htL, htR, hdL, hdR);
  stg.append(boxEl);
  const liveRow = opts.live ? h('label', { class: 'cbx-live', title: 'Shows your stream behind the box (the same picture as OBS). Turn it off to save a little computer power.' },
    // (ticking it is the user turning the live preview on: with the preview off by default it silently did nothing —
    //  review round 1; the preview still pauses while a game needs the card)
    h('input', { type: 'checkbox', checked: wantLive(), onChange: (e: Event) => { const on = (e.target as HTMLInputElement).checked; ls.set(LIVE_KEY, on ? '1' : '0'); if (on && !previewWanted()) setPreviewWanted(true); mountLive(); } }), 'Show my stream behind the box') : null;
  const sizes = h('div', { class: 'cbx-seg', role: 'radiogroup', 'aria-label': 'Chat box size' });
  const sliders = h('div');
  const use = h('p', { class: 'cbx-use', 'data-cbx-use': '1', role: 'status' });
  const acts = h('div', { class: 'cbx-acts' });
  const note = h('p', { class: 'cbx-note' });
  root.append(
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Show'), seg),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Applies to'), scopeSeg),
    h('div', { class: 'cbx-main' }, pad, h('div', null, stg, liveRow)),
    use, acts,
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Size'), sizes),
    sliders, note);

  // the studio's live picture behind the box (the shared preview frame: src/ui/previewFrame.ts)
  function mountLive() {
    // (the studio has ONE preview: never take it from a preview box that is showing it elsewhere on the page — the old
    // all-in-one Scene tab shows its own above this panel; the drawn stand-in is used then)
    const other = [...document.querySelectorAll('.scn-prev iframe')].find((f) => !stg.contains(f) && (f as HTMLElement).offsetParent !== null);
    const on = wantLive() && stg.isConnected && !other;
    stg.classList.toggle('live', on);
    if (on) mountPreviewFrame(stg, boxEl, 'Your stream (chat box placement)', root);
    else { const f = stg.querySelector('iframe'); if (f && !other) parkPreviewFrame(); }
  }

  const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
  const rectOf = (p: ChatBoxCore) => chatBoxRect(p, aspect) ?? chatBoxRect({ ...p, at: 'right' }, aspect)!;   // Auto: drawn at the usual right-hand spot, dashed
  function paintBox() {
    const p = draft ?? place();
    const r = rectOf(p);
    boxEl.classList.toggle('auto', p.at === 'auto');
    Object.assign(boxEl.style, { left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h), opacity: String(stg.classList.contains('live') ? 1 : p.opacity), display: stage().dock.chat === 'off' ? 'none' : '' });
    boxEl.title = p.at === 'auto' ? 'Auto: VTube Pro finds free space beside you (pick a place to fix it)' : 'Drag to move · corners resize';
    tag.textContent = p.at === 'auto' ? 'Chat (auto)' : 'Chat';
  }
  const scopeLabel = (sc: ChatScope) => sc === 'all' ? 'every room' : sc === 'room' ? 'this room' : `this room in ${modeName(mode())}`;
  let painted = '';
  function paint() {
    if (draft) return;
    const st = stage(), p = place(), edit = S.canEdit, rm = room(), md = mode(), sc = scope();
    const sl = slotChat();
    const key = JSON.stringify([st.dock.chat, st.chatBox ?? null, st.chatText ?? 1, edit, rm, md, sc, pick, sl]);   // (no raw report fields: several pages report, and a flip must not rebuild the buttons under the pointer)
    if (key === painted) return;                       // (the scene changes often: only repaint when this changed)
    painted = key;
    const box = sanitizeChatBox(st.chatBox ?? DEFAULT_CHAT_BOX);
    seg.replaceChildren(...SHOW.map((o) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(st.dock.chat === o.v), 'aria-pressed': String(st.dock.chat === o.v), title: o.hint, disabled: !edit, 'data-show': o.v, onClick: () => setDock(o.v) }, o.label)));
    const scopes: { v: ChatScope; label: string; hint: string }[] = [
      { v: 'all', label: 'Every room', hint: 'One place for the chat everywhere (unless a room keeps its own)' },
      { v: 'room', label: 'This room', hint: 'This room keeps its own place, in every show mode' },
      { v: 'mode', label: `Only in ${modeName(md)}`, hint: `This room keeps its own place while you are in ${modeName(md)}` },
    ];
    scopeSeg.replaceChildren(...scopes.map((o) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(sc === o.v), 'aria-pressed': String(sc === o.v), title: rm || o.v === 'all' ? o.hint : 'Pick a room first', disabled: !edit || (!rm && o.v !== 'all'), 'data-scope': o.v,
      onClick: () => {
        // (only WHICH place the panel edits: nothing is saved and nothing moves until the next drag / corner / size)
        pick = o.v;
        painted = ''; paint();
      } }, o.label, o.v !== 'all' && hasChatScope(box, o.v, rm, md) ? h('span', { class: 'own', title: 'Has its own place' }) : null)));
    pad.replaceChildren(...PAD.map((o) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(p.at === o.at), 'aria-pressed': String(p.at === o.at), title: o.label, 'aria-label': o.label, disabled: !edit, 'data-at': o.at, onClick: () => save(chatBoxPreset(p, o.at)) },
      o.dot ? h('i', { style: o.dot }) : 'Auto')),
      h('button', { type: 'button', class: 'cbx-free', role: 'radio', 'aria-checked': String(p.at === 'custom'), 'aria-pressed': String(p.at === 'custom'), title: 'Free: drag the box on your stream', disabled: !edit, 'data-at': 'custom', onClick: () => save(chatBoxPreset(p, 'custom')) }, 'Free'));
    const cur = sizeOfBox(p);
    sizes.replaceChildren(...SIZES.map((o) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(cur === o.v), 'aria-pressed': String(cur === o.v), disabled: !edit, 'data-size': o.v, onClick: () => save(chatBoxPreset(p, p.at, o.v)) }, o.label)));
    rerender(sliders, () => sliders.append(
      slider('Width', p.w, CHAT_BOX_LIMITS.w[0], CHAT_BOX_LIMITS.w[1], 0.01, (v) => save({ ...p, w: v, ...(p.at === 'custom' ? { x: Math.min(p.x, 1 - v) } : {}) }), 'Width of the chat box (share of the stream’s width)', { scale: 100, unit: '%', commit: true, def: DEFAULT_CHAT_BOX.w, disabled: !edit }),
      slider('Height', p.h, CHAT_BOX_LIMITS.h[0], CHAT_BOX_LIMITS.h[1], 0.01, (v) => save({ ...p, h: v, ...(p.at === 'custom' ? { y: Math.min(p.y, 1 - v) } : {}) }), 'Height of the chat box (share of the stream’s height)', { scale: 100, unit: '%', commit: true, def: DEFAULT_CHAT_BOX.h, disabled: !edit }),
      slider('Opacity', p.opacity, CHAT_BOX_LIMITS.opacity[0], 1, 0.05, (v) => save({ ...p, opacity: v }), 'See-through chat box: lower = more of the room shows through', { scale: 100, unit: '%', commit: true, def: 1, disabled: !edit }),
      slider('Text size', st.chatText ?? 1, 0.6, 1.6, 0.05, (v) => { if (edit) S.setStage({ chatText: v }); }, 'Chat text size in the box (≈ 18 px at 1080p × this)', { unit: '×', commit: true, def: 1, disabled: !edit }),
    ));
    // ---- which place the stream uses right now (never a silent override)
    const ch = chatDockChoice(st.chatBox, rm, md, !!sl, aspect);
    const roomName = rm ? (S.scenes.find((x) => x.id === rm)?.name ?? rm) : '';
    const here = rm ? `${roomName} · ${modeName(md)}` : 'no room';
    use.classList.toggle('warn', ch.use === 'layout' || sc !== ch.scope);
    const parts: (Node | string)[] = [];
    if (st.dock.chat === 'off') parts.push(h('b', null, 'The chat box is off.'), ' Pick “When active” or “Always” to show it.');
    else if (ch.use === 'layout') parts.push(h('b', null, `On your stream now (${here}): `), `the Layout editor’s own chat place for “${sl?.label}” — it was set there earlier.`);
    else parts.push(h('b', null, `On your stream now (${here}): `), ch.use === 'auto' ? 'Auto (free space beside you)' : 'your place', ch.scope === 'all' ? ' for every room.' : ch.scope === 'room' ? ' for this room.' : ` for this room in ${modeName(md)}.`);
    // (editing another scope than the one on screen: say what happens, plainly)
    const narrower = (a: ChatScope, b: ChatScope) => ['all', 'room', 'mode'].indexOf(a) > ['all', 'room', 'mode'].indexOf(b);
    if (st.dock.chat !== 'off' && sc !== ch.scope) {
      if (narrower(sc, ch.scope)) parts.push(' You are setting a place for ', h('b', null, scopeLabel(sc)), ': it takes over as soon as you move, resize or restyle the box.');
      else parts.push(' You are editing the place for ', h('b', null, scopeLabel(sc)), `: ${scopeLabel(ch.scope)} keeps its own place, so this change shows in other rooms and modes.`);
    }
    use.replaceChildren(...parts);
    const n = chatScopeCount(box);
    acts.replaceChildren(
      ...(ch.use === 'layout' && edit ? [h('button', { class: 'btn primary', 'data-act': 'use-mine', onClick: () => { dropSlotChat(); toast('Your chat place is used here now', 'ok', 2200); } }, 'Use my place here')] : []),
      ...(sc !== 'all' && edit && hasChatScope(box, sc, rm, md) ? [h('button', { class: 'btn', 'data-act': 'forget', title: `This room${sc === 'mode' ? ` in ${modeName(md)}` : ''} follows the broader place again`, onClick: () => { pick = null; painted = ''; S.setStage({ chatBox: dropChatScope(stage().chatBox, sc, rm, md) }); painted = ''; paint(); } }, sc === 'mode' ? `Forget the ${modeName(md)} place` : 'Forget this room’s place')] : []),
      ...((n > 0 || sc !== 'all') && edit ? [h('button', { class: 'btn', 'data-act': 'everywhere', title: n ? `${n} room / mode place${n === 1 ? '' : 's'} will be forgotten` : 'Every room uses this place', onClick: () => { const p = place(); pick = 'all'; painted = ''; S.setStage({ chatBox: useChatEverywhere(p) }); painted = ''; paint(); toast('One chat place for every room', 'ok', 2000); } }, n ? `Use this place everywhere (${n} other${n === 1 ? '' : 's'})` : 'Use this place everywhere')] : []),
    );
    note.textContent = !edit ? 'The host places the chat box (you see their choice).'
      : st.dock.chat === 'off' ? ''
      : p.at === 'auto' ? 'Auto: the box finds free space beside you and never covers a face or the screen. Pick a corner, Free, or drag the box to fix its place.'
      : 'Your OBS (and your party guests’ OBS) shows it there as soon as you let go. Drag it; it snaps to the edges and centre lines (hold Alt to place it freely).';
    paintBox();
    if (opts.live && wantLive() && stg.isConnected && !stg.querySelector('iframe') && !document.querySelector('.scn-prev iframe')) mountLive();
  }

  // ---- drag / resize on the picture (Free placement; dragging a preset or Auto makes it Free where you drop it)
  let drag: { mode: 'move' | 'se' | 'sw' | 'ne' | 'nw'; x0: number; y0: number; r0: Rect; p0: ChatBoxCore; id: number } | null = null;
  const guides = (gx: number[], gy: number[]) => { for (const g of stg.querySelectorAll('.g')) g.remove(); stg.append(...gx.map((x) => h('div', { class: 'g v', style: `left:${pct(x)}` })), ...gy.map((y) => h('div', { class: 'g hz', style: `top:${pct(y)}` }))); };
  boxEl.addEventListener('pointerdown', (e: PointerEvent) => {
    if (!S.canEdit || e.button !== 0) return;
    const p = place(), r = rectOf(p);
    const hd = (e.target as HTMLElement).dataset?.h as 'se' | 'sw' | 'ne' | 'nw' | undefined;
    drag = { mode: hd ?? 'move', x0: e.clientX, y0: e.clientY, r0: r, p0: p, id: e.pointerId };
    boxEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  boxEl.addEventListener('pointermove', (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const b = stg.getBoundingClientRect();
    const dx = (e.clientX - drag.x0) / Math.max(1, b.width), dy = (e.clientY - drag.y0) / Math.max(1, b.height);
    let r = { ...drag.r0 };
    const L = drag.mode === 'sw' || drag.mode === 'nw', T = drag.mode === 'ne' || drag.mode === 'nw';
    if (drag.mode === 'move') { r.x += dx; r.y += dy; }
    else { r.w += L ? -dx : dx; r.h += T ? -dy : dy; }
    r.w = Math.min(CHAT_BOX_LIMITS.w[1], Math.max(CHAT_BOX_LIMITS.w[0], r.w)); r.h = Math.min(CHAT_BOX_LIMITS.h[1], Math.max(CHAT_BOX_LIMITS.h[0], r.h));
    if (drag.mode !== 'move') { if (L) r.x = drag.r0.x + drag.r0.w - r.w; if (T) r.y = drag.r0.y + drag.r0.h - r.h; }
    // snapping: the frame edges, the centre lines and the safe margin (Alt = free)
    if (!e.altKey) {
      const safe = sanitizeLayoutBag((S.effective.modes ?? {})[LAYOUT_BAG]).safe ?? 20 / 1080;
      const sn = snapRect(r, [], 10 / Math.max(1, b.width), safe, drag.mode === 'move' ? 'move' : 'resize');
      if (drag.mode === 'move' || drag.mode === 'se') r = sn.rect;
      guides(sn.gx, sn.gy);
    } else guides([], []);
    draft = sanitizeChatBox({ ...drag.p0, at: 'custom', x: Math.min(1 - r.w, Math.max(0, r.x)), y: Math.min(1 - r.h, Math.max(0, r.y)), w: r.w, h: r.h });
    paintBox();
  });
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const wasAuto = drag.p0.at === 'auto';
    drag = null; guides([], []);
    const d = draft; draft = null; painted = '';
    if (d) { save(d); if (wasAuto) toast('Chat box placed by hand (pick Auto to let VTube Pro place it again)', 'info', 2600); } else paint();
  };
  boxEl.addEventListener('pointerup', end);
  boxEl.addEventListener('pointercancel', end);
  boxEl.addEventListener('keydown', (e: KeyboardEvent) => {
    const p = place();
    if (!S.canEdit || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const r = rectOf(p), k = e.shiftKey ? 0.05 : 0.01;
    const dx = e.key === 'ArrowLeft' ? -k : e.key === 'ArrowRight' ? k : 0, dy = e.key === 'ArrowUp' ? -k : e.key === 'ArrowDown' ? k : 0;
    if (e.altKey) save({ ...p, at: 'custom', x: r.x, y: r.y, w: r.w + dx, h: r.h + dy });
    else save({ ...p, at: 'custom', x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });
  });

  S.on((what) => { if ((what === 'state' || what === 'report') && root.isConnected && !drag) paint(); });
  paint();
  // (mounted once it is in the page: the preview needs a connected parent)
  // (the panel is built before it is in the page: mount the live picture once it is — checked here and on every repaint)
  if (opts.live) { let tries = 0; const wait = () => { if (stg.isConnected) mountLive(); else if (++tries < 100) setTimeout(wait, 100); }; wait(); }
  return h('div', null, h('h4', { style: 'margin:10px 0 4px' }, 'Chat box on stream'), root, chatTextSection(app));
}

/** The Show → Layout editor's "Docked chat" box was dragged / reset (src/ui/layoutEditor.ts): the chat's place for this
 *  room in this mode lives in the chat box (one place for the chat; the Chat panel shows it), not in the layout slot. */
export function placeChatFromLayout(app: App, r: Rect | null) {
  const S = app.scene;
  if (!S.canEdit) return;
  const rm = S.effective.sceneId ?? null, md = String(S.effective.mode ?? 'talk'), st = S.stage;
  if (!rm) return;
  // (the slot's own chat rect from before goes: it would shadow nothing now, and confuse the Chat panel)
  const label = S.report?.stage?.label;
  if (label) {
    const bag = sanitizeLayoutBag((S.effective.modes ?? {})[LAYOUT_BAG]);
    const sl = bag.rooms[roomKey(rm)]?.[slotKey(md, label)];
    if (sl && Array.isArray(sl.chat)) { delete sl.chat; S.setModeBag(LAYOUT_BAG, bag); }
  }
  if (!r) { S.setStage({ chatBox: dropChatScope(st.chatBox, 'mode', rm, md) }); return; }
  const cur = resolveChatBox(st.chatBox, rm, md).place;
  S.setStage({ chatBox: setChatScope(st.chatBox, 'mode', rm, md, { ...cur, at: 'custom', x: r.x, y: r.y, w: r.w, h: r.h }) });
  toast(`Chat placed for this room in ${modeName(md)} (Chat → Chat box on stream: “Use this place everywhere” for every room)`, 'info', 3600);
}

// ---------------------------------------------------------------- "Move the chat" from anywhere (Live Control …)
/** Live Control's "Move chat" (and any panel) dispatches this: the studio opens Chat & events at the chat box, with the
 *  box on the live picture ready to drag. Not handled (a pop-out without the studio) = the caller says so. */
export const CHAT_PLACE_EVENT = 'vtp:chat-place';
if (typeof document !== 'undefined') document.addEventListener(CHAT_PLACE_EVENT, (e) => {
  e.preventDefault();
  void import('./wizards.ts').then((m) => {
    m.studioNav().go('chat');
    let n = 0;
    const find = () => {
      const el = document.querySelector('[data-cbx]') as HTMLElement | null;
      if (!el) { if (++n < 40) setTimeout(find, 100); return; }
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.animate([{ boxShadow: '0 0 0 3px var(--accent2, #6cc7f5)' }, { boxShadow: '0 0 0 0 transparent' }], { duration: 1600, easing: 'ease-out' });
      (el.querySelector('.cbx-box') as HTMLElement | null)?.focus({ preventScroll: true });
    };
    find();
  });
});
