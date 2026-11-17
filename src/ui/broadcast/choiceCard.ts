// "Which one do you stream with?": My OBS / the VTube Pro Live engine (coming later) / Not yet.
// Unpicked, it is a full card at the top. Picked, it folds into one quiet line with a Change button.
import { h } from '../dom.ts';
import { choiceView } from './view.ts';
import type { BackendChoice, BroadcastStatus } from '../../../shared/broadcastTypes.ts';

export interface ChoiceOpts { open: boolean; canAct: boolean; onPick(c: BackendChoice): void; onToggle(): void }

export function renderChoice(s: BroadcastStatus | null, o: ChoiceOpts): HTMLElement {
  const v = choiceView(s);
  if (!v.needsPick && !o.open) {
    return h('div', { class: 'gl-row gl-small gl-dim', 'data-gl': 'choice', 'data-open': '0' },
      h('span', { class: 'gl-grow' }, v.summary),
      h('button', { class: 'gl-btn s', type: 'button', 'data-gl': 'choice-change', onClick: () => o.onToggle() }, 'Change'));
  }
  const close = v.needsPick ? null : h('button', { class: 'gl-btn s', type: 'button', onClick: () => o.onToggle() }, 'Close');
  const options = v.options.map((opt) => h('button', {
    class: 'gl-opt', type: 'button', 'data-choice': opt.id, 'aria-pressed': String(opt.selected), disabled: !opt.enabled || !o.canAct, onClick: () => o.onPick(opt.id),
  }, h('b', null, opt.title), opt.badge ? h('span', { class: 'gl-badge' }, opt.badge) : null, h('span', null, opt.say)));
  return h('section', { class: 'gl-card', 'data-gl': 'choice', 'data-open': '1', 'aria-label': v.question },
    h('div', { class: 'gl-head' }, h('h3', null, v.question), close),
    h('div', { class: 'gl-opts', role: 'group', 'aria-label': v.question }, ...options));
}
