// Mouth style ("cartoon mouth" for wide jaw-bone mouths: frogs, toads, mascots — src/avatar/visemeRig.ts). Never switched
// by itself: when an avatar looks like a wide cartoon mouth and its profile hasn't picked a style, the studio SUGGESTS it
// once (a card with the two choices); the Show dock's Me menu has "Mouth style" to switch either way any time.
// One hook: src/ui/laneWiring.ts → installMouthStyle(app). Observer sandboxes: the choice applies to that tab only
// (app.edit never saves there).
import type { App } from '../app.ts';
import { h, toast } from './dom.ts';
import { registerDockEntry } from './showDock.ts';
import { ensureCardStyle } from './autopilot/obsOneClick.ts';

const ASKED = (id: string) => `vtp.mouthStyleAsked.${id}`;
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage off */ } };

/** The current avatar's style + whether it looks like a wide cartoon mouth (null = no 3D avatar / no viseme rig). */
export function mouthStyleState(app: App): { cartoon: boolean; likely: boolean; picked: boolean } | null {
  const caps = app.runtime?.visemeRig?.caps, p = app.profile;
  if (!caps || !p || app.runtime?.flat) return null;
  const st = p.mouth.rules?.style;
  return { cartoon: caps.style === 'wideCartoon', likely: caps.wideLikely, picked: st === 'human' || st === 'wideCartoon' };
}

/** Switch the current avatar's mouth style (saved with the avatar; observers: this tab only). */
export function setMouthStyle(app: App, cartoon: boolean) {
  app.edit((q) => {
    const r = { ...(q.mouth.rules ?? {}) };
    r.style = cartoon ? 'wideCartoon' : 'human';
    // the cartoon mouth pops the throat sac on M / B / P when the avatar has one (an own puff setting wins)
    if (cartoon && r.puff && r.puff.plosive === undefined) r.puff = { ...r.puff, plosive: 0.4 };
    q.mouth.rules = r;
  });
  if (app.profile) lsSet(ASKED(app.profile.id), '1');
  toast(cartoon ? 'Cartoon mouth on: a smaller jaw for everyday talk, the big gape for shouts and laughs.' : 'Human mouth on: the jaw follows every syllable.', 'ok', 5000);
}

let card: HTMLElement | null = null;
function suggest(app: App) {
  const st = mouthStyleState(app), p = app.profile;
  if (!st || !p || !st.likely || st.picked || lsGet(ASKED(p.id))) return;
  ensureCardStyle();
  card?.remove();
  const close = () => { card?.remove(); card = null; };
  card = h('div', { class: 'ap-obs', role: 'dialog', 'aria-label': 'Mouth style', 'data-ui': 'mouth-style-suggest' },
    h('span', { class: 't' }, 'This avatar has a wide cartoon mouth: use the cartoon mouth style?',
      h('small', null, 'A smaller jaw for everyday talk, the big gape for shouts and laughs. You can switch back any time (Me → Mouth style).')),
    h('button', { class: 'primary', onClick: () => { close(); setMouthStyle(app, true); } }, 'Use cartoon mouth'),
    h('button', { onClick: () => { close(); lsSet(ASKED(p.id), '1'); } }, 'Keep it as it is'));
  document.body.append(card);
}

export function installMouthStyle(app: App) {
  app.on((w) => { if (w === 'avatar') { card?.remove(); card = null; window.setTimeout(() => suggest(app), 1500); } });
  registerDockEntry({
    id: 'me-mouth-style', menu: 'me', icon: 'me', order: 30, label: 'Mouth style',
    hint: 'Cartoon mouth (wide frog / mascot mouths) or human mouth.',
    when: (a) => { const s = mouthStyleState(a); return !!s && (s.likely || s.cartoon); },
    run: (a) => {
      const s = mouthStyleState(a);
      if (!s) return;
      ensureCardStyle();
      card?.remove();
      const close = () => { card?.remove(); card = null; };
      card = h('div', { class: 'ap-obs', role: 'dialog', 'aria-label': 'Mouth style', 'data-ui': 'mouth-style' },
        h('span', { class: 't' }, `Mouth style: ${s.cartoon ? 'cartoon' : 'human'}`,
          h('small', null, 'Cartoon: a smaller jaw for everyday talk, the big gape for shouts and laughs. Human: the jaw follows every syllable.')),
        h('button', { class: s.cartoon ? '' : 'primary', onClick: () => { close(); setMouthStyle(a, true); } }, 'Cartoon mouth'),
        h('button', { class: s.cartoon ? 'primary' : '', onClick: () => { close(); setMouthStyle(a, false); } }, 'Human mouth'),
        h('button', { onClick: close }, 'Close'));
      document.body.append(card);
    },
  });
}
