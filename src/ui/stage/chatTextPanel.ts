// Chat & events → Chat box on stream → "Look": the chat box as its panel (card art) or as plain text over the stream
// (no panel: outlined, shadowed, fading lines — src/scene/stage/chatText.ts). The style is part of the chat box
// (SceneState.stage.chatBox.style, shared/chatBox.ts); the text options (lines, fade, font, colours, outline …) are kept
// once in the `hud` mode bag (shared/hud.ts CHAT_TEXT_PROPS). A layout's look can force panel / text for that layout.
// Mounted by src/ui/chatBoxPanel.ts (one line). Repaints itself on scene changes (never while a slider is held).
import type { App } from '../../app.ts';
import { DEFAULT_CHAT_BOX, sanitizeChatBox } from '../../../shared/chatBox.ts';
import { CHAT_TEXT_PROPS, HUD_BAG, chatTextOptions, sanitizeHudBag, type HudPropSpec } from '../../../shared/hud.ts';
import { DEFAULT_STAGE } from '../../../shared/stage.ts';
import { h, rerender, slider, toggle } from '../dom.ts';
import { steps } from './common.ts';

type BagApi = { modeBag(id: string): unknown; setModeBag(id: string, v: unknown): void };
let timer = 0;
let optsOpen = false;

export function chatTextSection(app: App): HTMLElement {
  const S = app.scene;
  const B = S as unknown as BagApi;
  const root = h('div', { 'data-chattext': '1' });
  const stage = () => S.stage ?? DEFAULT_STAGE;
  const place = () => sanitizeChatBox(stage().chatBox ?? DEFAULT_CHAT_BOX);
  const opts = () => chatTextOptions(sanitizeHudBag(B.modeBag(HUD_BAG)).chatText);
  const setStyle = (text: boolean) => { if (!S.canEdit) return; const p = place(); const { style: _s, ...rest } = p; void _s; S.setStage({ chatBox: sanitizeChatBox(text ? { ...rest, style: 'text' } : rest) }); };
  const setOpt = (k: string, v: string | number | boolean, now = true) => {
    if (!S.canEdit) return;
    const write = () => { const b = sanitizeHudBag(B.modeBag(HUD_BAG)); B.setModeBag(HUD_BAG, sanitizeHudBag({ ...b, chatText: { ...chatTextOptions(b.chatText), [k]: v } })); };
    clearTimeout(timer);
    if (now) write(); else timer = window.setTimeout(write, 200);
  };
  const control = (k: string, p: HudPropSpec, v: string | number | boolean, edit: boolean): HTMLElement => {
    switch (p.kind) {
      case 'num': return slider(p.label, Number(v), p.min, p.max, p.step ?? 0.01, (x) => setOpt(k, x, false), p.label, { ...(p.unit ? { unit: p.unit } : {}), def: p.def, disabled: !edit });
      case 'bool': return toggle(p.label, v === true, (x) => setOpt(k, x));
      case 'enum': return h('div', { class: 'row' }, h('span', { class: 'lbl' }, p.label), steps(String(v), p.options.map((o, i) => [o, p.labels?.[i] ?? o] as [string, string]), (x) => setOpt(k, x), !edit));
      case 'color': return h('div', { class: 'row' }, h('span', { class: 'lbl' }, p.label), h('input', { type: 'color', value: String(v) || '#ffffff', disabled: !edit, onInput: (e: Event) => setOpt(k, (e.target as HTMLInputElement).value, false) }));
      default: return h('div', { class: 'row' }, h('span', { class: 'lbl' }, p.label), h('input', { type: 'text', value: String(v), disabled: !edit, onChange: (e: Event) => setOpt(k, (e.target as HTMLInputElement).value) }));
    }
  };
  let painted = '';
  const paint = () => {
    const p = place(), o = opts(), edit = S.canEdit;
    const key = JSON.stringify([p.style ?? 'panel', o, edit, stage().dock.chat]);
    if (key === painted) return;
    painted = key;
    const text = p.style === 'text';
    rerender(root, () => root.append(
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Look'),
        steps(text ? 'text' : 'panel', [['panel', 'Panel'], ['text', 'Text only']], (v) => setStyle(v === 'text'), !edit)),
      h('p', { class: 'cbx-note' }, text
        ? 'Text only: the messages as outlined text right on your stream, no panel. They fade out after a while.'
        : 'Panel: the chat card in your room’s colours. A layout can pick its own (Show mode → Look → Adjust the look → Chat box).'),
      ...(text ? [h('details', { open: optsOpen, onToggle: (e: Event) => { optsOpen = (e.target as HTMLDetailsElement).open; } } as never,
        h('summary', { style: 'cursor:pointer;margin:2px 0 6px', class: 'cbx-note' }, 'Text options (optional)'),
        ...Object.entries(CHAT_TEXT_PROPS).map(([k, sp]) => control(k, sp, o[k], edit)),
        h('button', { type: 'button', class: 'btn tight', disabled: !edit, onClick: () => { const b = sanitizeHudBag(B.modeBag(HUD_BAG)); B.setModeBag(HUD_BAG, { ...b, chatText: {} }); } }, 'Reset to default'))] : []),
    ));
  };
  S.on((what) => { if (what === 'state' && root.isConnected) paint(); });
  paint();
  return root;
}
