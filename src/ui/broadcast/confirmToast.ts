// The "are you sure" card that opens when Go Live is pressed (and for the private test). Nothing starts until the person
// presses the big button on it: the card only reports the click. Escape or Cancel closes it.
import { h } from '../dom.ts';
import type { ConfirmView } from './view.ts';

export interface ConfirmOpts {
  view: ConfirmView;
  /** The Go button was pressed. The event is passed on so the page can tell a real click from a script. */
  onGo(ev: MouseEvent): void;
  onCancel(): void;
  /** A request is already running: the Go button is off. */
  busy: boolean;
}

export function renderConfirm(o: ConfirmOpts): HTMLElement {
  const v = o.view;
  const title = h('h3', { id: 'gl-confirm-title' }, v.heading);
  const card = h('div', { class: `gl-confirm ${v.tone === 'go' ? '' : 'quiet'}`, role: 'alertdialog', 'aria-labelledby': 'gl-confirm-title', 'aria-modal': 'false', tabindex: '-1', 'data-gl': 'confirm' },
    title,
    h('ul', null, ...v.lines.map((l) => h('li', null, l))),
    h('div', { class: 'gl-row' },
      h('button', { class: 'gl-btn pri', type: 'button', 'data-gl': 'confirm-go', disabled: o.busy, onClick: (ev: MouseEvent) => o.onGo(ev) }, v.goLabel),
      h('button', { class: 'gl-btn', type: 'button', 'data-gl': 'confirm-cancel', onClick: () => o.onCancel() }, v.cancelLabel)));
  card.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); o.onCancel(); } });
  return card;
}
