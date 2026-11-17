// Hands / Body switches (owner: "Under tracking, we need to also make sure people can quickly disable hand and body
// tracking in simple mode"): the big card near the top of Simple → Tracking, and the Ctrl+K "Run" lines. Every screen
// flips the same state (app.setTrackPart, shared/trackParts.ts): Advanced → Tracking → Camera, Live → Me and Ctrl+K.
import type { App } from '../app.ts';
import { TRACK_PARTS, TRACK_PART_TEXT, trackPartsCommand, type TrackPart } from '../../shared/trackParts.ts';
import { h, toast } from './dom.ts';
import { icon } from './icons.ts';
import { live } from './bits.ts';

const CSS = `
.tp-list { display: flex; flex-direction: column; gap: 8px; }
.tp-row { display: grid; grid-template-columns: 40px 1fr auto; align-items: center; gap: 12px; padding: 12px 12px 12px 10px;
  border-radius: 12px; background: var(--card2); border: 1px solid var(--line); cursor: pointer;
  transition: border-color .18s cubic-bezier(.16,1,.3,1), background .18s cubic-bezier(.16,1,.3,1); }
.tp-row:hover { border-color: var(--line2); }
.tp-row .tp-ic { width: 40px; height: 40px; border-radius: 11px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent);
  transition: background .18s cubic-bezier(.16,1,.3,1), color .18s cubic-bezier(.16,1,.3,1); }
.tp-row.off .tp-ic { background: var(--card3); color: var(--faint); }
.tp-row .tp-t { font-weight: 700; font-size: 15px; letter-spacing: .005em; }
.tp-row .tp-d { color: var(--dim); font-size: 12.5px; line-height: 1.4; margin-top: 2px; }
.tp-row .tp-st { font-size: 12px; font-weight: 600; margin-top: 4px; color: var(--dim); }
.tp-row .tp-st:empty { display: none; }
.tp-row.off .tp-st { color: var(--text); }
.tp-sw { position: relative; flex: none; width: 64px; height: 34px; border-radius: 99px; border: 0; padding: 0; cursor: pointer;
  background: var(--card3); box-shadow: inset 0 0 0 1px var(--line2); font: inherit; color: var(--dim);
  transition: background .18s cubic-bezier(.16,1,.3,1), box-shadow .18s cubic-bezier(.16,1,.3,1); }
.tp-sw[aria-checked="true"] { background: var(--accent); box-shadow: none; color: var(--accent-ink); }
.tp-sw .tp-knob { position: absolute; top: 4px; left: 4px; width: 26px; height: 26px; border-radius: 50%; background: #f4f6f9;
  box-shadow: 0 1px 3px #0006; transition: transform .2s cubic-bezier(.16,1,.3,1); }
.tp-sw[aria-checked="true"] .tp-knob { transform: translateX(30px); }
.tp-sw .tp-lb { position: absolute; top: 0; bottom: 0; display: grid; place-items: center; font-size: 11px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; }
.tp-sw .tp-lb.on { left: 10px; } .tp-sw .tp-lb.off { right: 9px; }
.tp-sw[aria-checked="true"] .tp-lb.off, .tp-sw[aria-checked="false"] .tp-lb.on { visibility: hidden; }
.tp-sw:focus-visible { outline: 2px solid var(--accent2); outline-offset: 3px; }
.tp-foot { margin: 10px 2px 0; }
@media (prefers-reduced-motion: reduce) { .tp-row, .tp-row .tp-ic, .tp-sw, .tp-sw .tp-knob { transition: none; } }
`;
function ensureCss() { if (!document.getElementById('vtp-trackparts-css')) document.head.append(h('style', { id: 'vtp-trackparts-css' }, CSS)); }

/** The small line under a switch: what happens now (empty while it simply runs). */
function statusText(app: App, part: TrackPart): string {
  switch (app.partState(part)) {
    case 'off': return part === 'hands' ? 'Off. Your hands rest.' : 'Off. Your arms rest.';
    case 'starting': return part === 'hands' ? 'Starting hand tracking…' : 'Starting body tracking…';
    default: return '';
  }
}

/** Simple → Tracking: "Hands and body", two big switches near the top. */
export function trackPartsCard(app: App, refresh: () => void): HTMLElement {
  ensureCss();
  const parts = app.parts;
  const states: { part: TrackPart; st: HTMLElement }[] = [];
  const row = (part: TrackPart) => {
    const T = TRACK_PART_TEXT[part], on = parts[part];
    const flip = () => { app.setTrackPart(part, !app.parts[part]); refresh(); };
    const sw = h('button', {
      type: 'button', class: 'tp-sw', role: 'switch', 'aria-checked': String(on), 'data-key': `tp-${part}`, 'data-part': part,
      'aria-label': T.what, 'aria-describedby': `tp-${part}-d`, title: `${T.what}: ${on ? 'on' : 'off'}`,
      onClick: (e: Event) => { e.stopPropagation(); flip(); },
    }, h('span', { class: 'tp-lb on', 'aria-hidden': 'true' }, 'On'), h('span', { class: 'tp-lb off', 'aria-hidden': 'true' }, 'Off'), h('span', { class: 'tp-knob', 'aria-hidden': 'true' }));
    const st = h('div', { class: 'tp-st', 'aria-live': 'polite' }, statusText(app, part));
    states.push({ part, st });
    return h('div', { class: `tp-row ${on ? 'on' : 'off'}`, 'data-ui': `track-${part}`, onClick: flip },
      h('span', { class: 'tp-ic', 'aria-hidden': 'true' }, icon(part === 'hands' ? 'hand' : 'body', 22)),
      h('div', null, h('div', { class: 'tp-t' }, T.name), h('div', { class: 'tp-d', id: `tp-${part}-d` }, T.hint), st),
      sw);
  };
  const foot = h('p', { class: 'note tp-foot' });
  const paint = () => {
    for (const { part, st } of states) { const t = statusText(app, part); if (st.textContent !== t) st.textContent = t; }
    const t = app.trackingOn ? '' : 'Your camera is off. Your choice applies when you turn it on.';
    if (foot.textContent !== t) foot.textContent = t;
    foot.style.display = t ? '' : 'none';
  };
  const card = h('section', { class: 's-card', id: 'track-parts' },
    h('h3', null, h('span', { class: 'grow' }, 'Hand and body tracking')),
    h('p', { class: 'lead' }, 'Your face is always tracked. This browser remembers your choice.'),
    h('div', { class: 'tp-list', role: 'group', 'aria-label': 'What the camera tracks' }, ...TRACK_PARTS.map(row)),
    foot);
  paint();
  live(() => { if (!card.isConnected) return false; paint(); return true; });
  return card;
}

/** Ctrl+K "Run" lines: "hand tracking off", "body tracking on", "stop tracking my hands" … */
export function trackPartActions(app: App, q: string): { t: string; where: string; run(): void }[] {
  return trackPartsCommand(q, app.parts).map(({ part, on }) => ({
    t: `▶ ${TRACK_PART_TEXT[part].what} ${on ? 'on' : 'off'}`, where: 'Run now',
    run: () => { app.setTrackPart(part, on); toast(on ? TRACK_PART_TEXT[part].on : TRACK_PART_TEXT[part].off, 'ok', 2400); },
  }));
}
