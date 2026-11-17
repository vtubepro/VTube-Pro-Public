// "Lower quality automatically" told the studio that an OBS page stepped down (bus {type:'gfxlower'}, src/output.ts):
// one plain sentence with OK and Undo, in the toast corner, until answered (or 30 s). Undo puts the user's preset back
// and turns the automatic lowering off (they chose looks over smoothness); it can be turned on again in
// Room → Advanced → Graphics quality. Several OBS pages stepping down together show ONE notice.
import type { App } from '../app.ts';
import { GFX_NAMES, type GfxLevel } from '../../shared/graphics.ts';
import { h } from './dom.ts';

let card: HTMLElement | null = null;
let hideT = 0;

export function installGfxNotice(app: App) {
  if (app.observer) return;                      // (an observer tab never changes the scene state)
  app.bus.on((m) => {
    if (m.type !== 'gfxlower' || !GFX_NAMES[m.to] || !GFX_NAMES[m.from]) return;
    show(app, m.from, m.to, typeof m.why === 'string' ? m.why.slice(0, 120) : '');
  });
}

function show(app: App, from: GfxLevel, to: GfxLevel, why: string) {
  close();
  let host = document.getElementById('toasts');
  if (!host) { host = h('div', { id: 'toasts' }); document.body.append(host); }
  const ok = h('button', { class: 'btn primary', onClick: () => close() }, 'OK');
  const undo = h('button', { class: 'btn', title: `Back to ${GFX_NAMES[from]}, and stop lowering it automatically`, onClick: () => {
    app.scene.setGfx({ autoLower: false });       // the OBS pages go back to the chosen preset at once
    close();
  } }, 'Undo');
  card = h('div', { class: 'toast warn gfx-lower', role: 'status', 'data-ui': 'gfx-lower', style: 'max-width:min(380px, calc(100vw - 32px));box-sizing:border-box' },
    h('div', null, `Your stream was starting to stutter${why ? ` (${why})` : ''}, so VTube Pro lowered the room quality from ${GFX_NAMES[from]} to ${GFX_NAMES[to]}.`),
    h('div', { style: 'display:flex;gap:6px;justify-content:flex-end;margin-top:7px' }, undo, ok));
  host.append(card);
  hideT = window.setTimeout(close, 30000);
}

function close() {
  clearTimeout(hideT);
  const c = card; card = null;
  if (!c) return;
  c.classList.add('out');
  setTimeout(() => c.remove(), 400);
}
