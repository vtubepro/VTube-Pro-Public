// The Settings cards that Simple and Advanced share (UX redesign v2, L4 / FR-02): Guided set-ups, Performance
// and the keyboard shortcut list (Look & feel stays in src/ui/simple.ts, where tools/ux_redesign_unit.ts guards its
// Layout switch). Simple Settings (src/ui/simple.ts settingsView) builds them
// first; Advanced Settings (src/ui/panels.ts settings) builds the very same cards before its own (Status, AI apps, Models
// & tools, Credits, Keyboard), so turning Advanced on only adds. Card ids: src/ui/settingsRegistry.ts.
import type { App } from '../app.ts';
import type { QualityTier } from '../tracking/Tracker.ts';
import { card, item, seg } from './bits.ts';
import { button, h } from './dom.ts';
import { WIZARD_LIST, wizardStatus } from './wizards.ts';

/** What the shared cards need from the shell (the Simple view gets it as `nav`, the Advanced panel builds it). */
export interface SettingsNav {
  wizard(id: string, at?: string): void;
  refresh(): void;
  setGlobalAdvanced(on: boolean): void;
  globalAdvanced(): boolean;
}

/** Tag a card with its registry id so the unit test and the e2e can find it. */
export const tagCard = <T extends HTMLElement>(id: string, el: T): T => { el.dataset.card = id; return el; };

/** Guided set-ups: all 8 wizards, each with a done / paused marker. ("helper" alone means the VTube Pro Helper app.) */
export function guidedSetupsCard(app: App, nav: SettingsNav) {
  return tagCard('guided-setups', card('Guided set-ups', 'Step-by-step guides. Skip any step; close one and it remembers where you were.',
    h('div', { class: 's-list' }, ...WIZARD_LIST.map((w) => {
      const st = wizardStatus(w.id);
      const go = button(st.finished ? 'Run again' : st.started ? 'Continue' : 'Start', () => nav.wizard(w.id), st.finished ? 'ghost' : 'primary');
      const text = st.finished ? 'Done ✓' : st.started ? `Paused${st.stepTitle ? ` at “${st.stepTitle}”` : ''}` : w.blurb;
      // "Add my model" promises "or walk you through it": Start opens the quick importer (it checks the file and sets it up),
      // "Walk me through it" opens the guided wizard (the same one as Me → Advanced → "Add my model (guided)…")
      const detail = w.id === 'model'
        ? h('span', null, text, h('span', { class: 's-row', style: 'margin-top:6px', 'data-ui': 'model-guided' },
          button('Walk me through it', () => void import('./modelWizard.ts').then((m) => m.openModelWizard(app, { onDone: () => app.emit('library') })), '')))
        : text;
      return item(st.finished ? 'ok' : st.started ? 'warn' : '', w.icon, w.title, detail, go);
    }))));
}

/** Performance: how hard face and body tracking work. */
export function performanceCard(app: App, nav: SettingsNav) {
  return tagCard('performance', card('Performance', 'Lower this if the avatar stutters. It changes how hard face & body tracking work.',
    seg<QualityTier>([['low', 'Older PC'], ['medium', 'Balanced'], ['high', 'Fast'], ['ultra', 'Gaming PC']], app.tier, (v) => { app.setTier(v); nav.refresh(); })));
}

export function shortcutList() {
  const k = (...keys: string[]) => h('span', null, ...keys.flatMap((x, i) => [i ? ' + ' : '', h('span', { class: 'kbd' }, x)]));
  return h('div', { class: 'sc-list' },
    k('H'), 'Hide all menus (clean window capture) — press again or Esc to bring them back',
    k('C'), 'Calibrate your neutral face',
    k('F'), 'Re-frame the camera on your avatar',
    k('1–9'), 'Preview an expression',
    k('Ctrl', '1–9'), 'Wear outfit 1–9 (Ctrl+0: default look; Alt works too)',
    k('Shift', '1–5'), 'Lighting: Preshow · Show · React · BRB · Outro',
    // ("+" means "together": G then H is a sequence, so it says "then")
    h('span', null, h('span', { class: 'kbd' }, 'G'), ' then ', h('span', { class: 'kbd' }, 'H / R / S…')), 'Go to an area: G then H (Home), R (Room), S (Show), C (Chat), P (Party), O (OBS)…',
    k('Ctrl', 'K'), 'Search every setting',
    k('?'), 'Show all shortcuts',
    k('Esc'), 'Cancel / close');
}
