// Shared bits of the Scene tab's stage panels: who is in the room (ordered like the OBS pages order them), names, the
// OBS canvas aspect, the preset cards with layout thumbnails.
import { HOST_KEY } from '../../../shared/scene.ts';
import type { StagePlan } from '../../../shared/stage.ts';
import type { SceneController } from '../../scene/controller.ts';
import { h } from '../dom.ts';
import { layoutSvg } from './layoutSvg.ts';

export const STAGE_CSS = `
.stg-modes { display:grid; grid-template-columns: repeat(auto-fit, minmax(88px, 1fr)); gap:6px; margin:4px 0 10px; }
.stg-mode { display:flex; flex-direction:column; align-items:center; gap:2px; padding:9px 6px 7px; border-radius:12px; border:1px solid var(--line); background:var(--card); color:var(--text); cursor:pointer; font:inherit; position:relative; transition: border-color .15s, background .15s, transform .08s; }
.stg-mode:hover:not([disabled]) { border-color: var(--line2); background: var(--card2); }
.stg-mode:active:not([disabled]) { transform: scale(.98); }
.stg-mode .ic { font-size:22px; line-height:1.1; }
.stg-mode b { font-size:13px; }
.stg-mode kbd { font: 10px ui-monospace, Consolas, monospace; color: var(--faint); }
.stg-mode.on { border-color: var(--accent); background: var(--accent-soft); box-shadow: 0 0 0 1px var(--accent) inset; }
.stg-mode.on b { color: var(--accent); }
.stg-cards { display:grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap:6px; margin:4px 0 8px; }
.stg-card { border:1px solid var(--line); border-radius:9px; background:var(--card); padding:4px 4px 5px; cursor:pointer; text-align:center; font:inherit; color:var(--text); }
.stg-card:hover:not([disabled]) { border-color: var(--line2); }
.stg-card.on { border-color: var(--accent2); box-shadow: 0 0 0 1px var(--accent2) inset; }
.stg-card.eff:not(.on) { border-style: dashed; border-color: var(--accent2); }
.stg-card svg { display:block; width:100%; height:auto; border-radius:5px; }
.stg-card b { display:block; font-size:12px; margin-top:3px; }
.stg-card span { display:block; font-size:10.5px; color:var(--faint); line-height:1.25; }
.stg-row { display:flex; align-items:center; gap:6px; margin:5px 0; flex-wrap:wrap; }
.stg-row .lbl { min-width:96px; color:var(--dim); font-size:12px; }
.stg-live { position:relative; border:1px solid var(--line); border-radius:10px; overflow:hidden; background:#0e131b; margin:6px 0; }
.stg-live .cap { position:absolute; right:6px; top:6px; font-size:10.5px; padding:1px 7px; border-radius:9px; background:#000a; color:#fff; }
.stg-help ol { margin:4px 0 6px 18px; padding:0; } .stg-help li { margin:3px 0; }
.stg-nums { font: 12px ui-monospace, Consolas, monospace; background:var(--input, #12151b); border:1px solid var(--line); border-radius:6px; padding:6px 8px; white-space:pre; overflow-x:auto; margin:4px 0; }
.stg-corner { display:inline-grid; grid-template-columns: 22px 22px; gap:3px; }
.stg-corner button { width:22px; height:14px; border-radius:3px; border:1px solid var(--line2); background:var(--card2); cursor:pointer; padding:0; }
.stg-corner button.on { background: var(--accent2); border-color: var(--accent2); }
`;

export const canvasAspect = () => {
  const w = parseInt(localStorage.getItem('vtp.scene.obsW') || '1920', 10), hh = parseInt(localStorage.getItem('vtp.scene.obsH') || '1080', 10);
  return w > 100 && hh > 100 ? w / hh : 16 / 9;
};
export const canvasSize = (): [number, number] => {
  const w = parseInt(localStorage.getItem('vtp.scene.obsW') || '1920', 10), hh = parseInt(localStorage.getItem('vtp.scene.obsH') || '1080', 10);
  return [w > 100 ? w : 1920, hh > 100 ? hh : 1080];
};

/** Members in the room, host first then join order (the strip order). */
export function presentKeys(S: SceneController): string[] {
  const st = S.effective, order = [HOST_KEY, ...S.stage.order.filter((k) => k !== HOST_KEY)];
  const rank = (k: string) => { const i = order.indexOf(k); return i < 0 ? 999 : i; };
  return S.members().filter((m) => st.present[m.key] !== false).map((m) => m.key).sort((a, b) => rank(a) - rank(b));
}
export function nameOf(S: SceneController) {
  const m = new Map(S.members().map((x) => [x.key, x.name.replace(/\s*\((host|you|test)\)$/i, '').replace(/\s*\(@.*?\)$/, '')]));
  const o = S.stage.names ?? {};
  return (k: string) => o[k] ?? m.get(k) ?? k;
}

/** A preset card: thumbnail + name + one line. */
export function card(title: string, sub: string, svg: SVGElement, on: boolean, eff: boolean, disabled: boolean, onClick: () => void, tip = '') {
  return h('button', { class: `stg-card ${on ? 'on' : ''} ${eff ? 'eff' : ''}`, disabled, title: tip, onClick }, svg as unknown as Node, h('b', null, title), h('span', null, sub));
}
export const thumb = (plan: StagePlan | null, aspect: number, schematic?: { kind: 'big' | 'side' | 'talk'; keys: string[] }) => layoutSvg(plan, { width: 120, aspect, size: 'thumb' }, schematic);

/** S / M / L buttons. */
export function steps<T extends string>(value: T, opts: [T, string][], on: (v: T) => void, disabled = false) {
  return h('span', { class: 'seg' }, ...opts.map(([v, l]) => h('button', { class: v === value ? 'on' : '', disabled, onClick: () => on(v) }, l)));
}
