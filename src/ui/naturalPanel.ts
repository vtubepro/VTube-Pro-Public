// "Natural mode" (docs/NATURAL_CAPTURE.md): one switch that lets the performer emote normally — the tracker learns
// their relaxed face (per head pose, lighting drift, MediaPipe's jaw / gaze / blink couplings) and the size of their
// own everyday expressions, so small real smiles, frowns and brow moves read on the avatar without acting for the
// camera. Card for Go Live (simple UI) + a compact section for the Track tab.
import type { App } from '../app.ts';
import { button, h, toast } from './dom.ts';
import { add, live } from './bits.ts';

function learnedText(app: App) {
  const N = app.face.natural;
  if (!N.enabled) return 'Off — the classic amplifier (big, deliberate faces read best).';
  const r = N.readout();
  const seen = r.reduce((a, x) => a + x.events, 0);
  if (!app.trackingOn) return 'On · learns while the camera is on.';
  if (seen < 3) return 'On · learning your face — just stream normally; it settles within a few minutes.';
  const top = r.filter((x) => x.events > 0).map((x) => `${x.label} ×${x.gain.toFixed(1)}`).join(' · ');
  return `On · tuned to you (${seen} expressions seen): ${top}`;
}

/** Friendly card: Go Live (simple UI). */
export function naturalCard(app: App, refresh: () => void): HTMLElement {
  const N = app.face.natural;
  const on = N.enabled;
  const st = h('p', { class: 'note', style: 'margin:6px 0 0' });
  const paint = () => { st.textContent = learnedText(app); };
  paint();
  live(() => { if (!st.isConnected) return false; paint(); return true; });
  const set = (v: boolean) => {
    if (app.observer) { toast('Observer sandbox: not changed here (it would change your real studio).', 'warn', 5000); return; }
    N.setEnabled(v); refresh();
    toast(v ? 'Natural mode on — talk and react like you normally do; it keeps learning your face.' : 'Natural mode off — classic amplifier.', 'ok', 5000);
  };
  const card = h('section', { class: 's-card' });
  add(card,
    h('h3', null, h('span', { class: 'grow' }, '🙂 Natural mode'), h('span', { class: 's-badge ok' }, 'no over-acting')),
    h('p', { class: 'lead' }, 'Be yourself on stream. VTube Pro learns your relaxed face and how big YOUR everyday expressions are, so small real smiles, frowns and eyebrow moves show on the avatar — while looking at chat, turning your head or talking no longer make it pull faces. Smiles stay gentle unless you really grin.'),
    h('div', { class: 's-seg', role: 'radiogroup' },
      h('button', { class: !on ? 'on' : '', role: 'radio', 'aria-checked': String(!on), onClick: () => set(false) }, 'Classic', h('small', null, 'big faces')),
      h('button', { class: on ? 'on' : '', role: 'radio', 'aria-checked': String(on), onClick: () => set(true) }, 'Natural', h('small', null, 'learns you'))),
    st,
    h('div', { class: 's-row', style: 'margin-top:8px' },
      button('Relearn my face', () => {
        if (app.observer) { toast('Observer sandbox: not reset', 'warn'); return; }
        if (!confirm('Forget what natural mode learned about your face (relaxed face + expression sizes)? It relearns while you stream.')) return;
        N.reset(); toast('Natural mode will relearn your face as you stream.', 'ok', 4000); refresh();
      }, 'ghost')));
  return card;
}

/** Compact section for the Track tab (advanced UI). */
export function naturalSection(app: App, rerender: () => void): HTMLElement {
  const N = app.face.natural;
  const st = h('p', { class: 'note' });
  const paint = () => { st.textContent = learnedText(app); };
  paint();
  live(() => { if (!st.isConnected) return false; paint(); return true; });
  const wrap = h('div', { class: 'btns' },
    button(N.enabled ? 'Natural mode: ON' : 'Natural mode: off', () => {
      if (app.observer) { toast('Observer sandbox: not changed', 'warn'); return; }
      N.setEnabled(!N.enabled); rerender();
    }, N.enabled ? 'primary' : ''),
    button('Relearn my face', () => { if (app.observer) { toast('Observer sandbox: not reset', 'warn'); return; } N.reset(); toast('Relearning as you stream', 'ok'); rerender(); }));
  return h('div', null, h('p', { class: 'note' }, 'Natural mode: emote normally — learns your relaxed face (per head pose) and your own expression sizes; smiles stay gentle.'), wrap, st);
}
