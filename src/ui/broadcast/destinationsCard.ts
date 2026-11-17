// "Where you stream": one chip per destination (Twitch, YouTube, Kick, TikTok, any other site), an editor under the chip
// being edited, and the step to finish one: paste the stream key from the streaming site.
// Stream keys are typed into a password box, sent once, and the box is emptied. They are never put in the page, a
// draft, an attribute or a log.
import { h } from '../dom.ts';
import {
  PLATFORM_NAME, PLATFORM_ORDER, destChipView, safeLink, toneClass,
} from './view.ts';
import type { DestLiveState, DestPlatform, DestinationView } from '../../../shared/broadcastTypes.ts';

export interface DestUi {
  editing: string | null;
  adding: boolean;
  /** Typed-but-not-saved words (label, address). Never keys. */
  draft: Record<string, string>;
}

export interface DestHandlers {
  toggle(id: string): void;
  startAdd(): void;
  add(platform: DestPlatform): void;
  edit(id: string | null): void;
  draftSet(key: string, value: string): void;
  saveMeta(id: string, f: { label: string; url: string }): void;
  remove(id: string): void;
  /** `input` is emptied by the caller as soon as the key is sent. */
  saveKey(id: string, input: HTMLInputElement): void;
  clearKey(id: string): void;
}

export interface DestCardOpts {
  destinations: readonly DestinationView[];
  live: readonly DestLiveState[];
  ui: DestUi;
  canAct: boolean;
  /** A show is on the air: switching destinations or editing keys is paused until it ends. */
  locked: boolean;
  handlers: DestHandlers;
}

const field = (label: string, input: HTMLElement) => h('label', { class: 'gl-field' }, h('span', null, label), input);

export function renderDestinations(o: DestCardOpts): HTMLElement {
  const { handlers: hd, ui } = o;
  const dis = !o.canAct || o.locked;
  const head = h('div', { class: 'gl-head' }, h('h3', null, 'Where you stream'),
    h('button', { class: 'gl-btn s', type: 'button', 'data-gl': 'add-dest', disabled: dis, onClick: () => hd.startAdd() }, 'Add where I stream'));

  const chips = o.destinations.length
    ? h('div', { class: 'gl-chips', role: 'group', 'aria-label': 'Where you stream' }, ...o.destinations.map((d) => {
      const cv = destChipView(d, o.live.find((l) => l.destId === d.id) ?? null);
      const needs = cv.state === 'needs-key';
      return h('div', { class: 'gl-row', 'data-dest': d.id },
        h('button', { class: `gl-chip ${toneClass(cv.tone)}${cv.on ? '' : ' off'}${ui.editing === d.id ? ' editing' : ''}`, type: 'button', 'data-gl': 'dest-chip', 'data-state': cv.state, 'aria-pressed': String(cv.on), disabled: dis,
          'aria-label': `${cv.label}: ${cv.say}`, onClick: () => hd.toggle(d.id) },
        h('span', { class: 'dot', 'aria-hidden': 'true' }), h('b', null, cv.label), h('small', null, cv.say)),
        h('button', { class: `gl-btn s${needs ? ' pri' : ''}`, type: 'button', 'data-gl': 'dest-edit', 'aria-expanded': String(ui.editing === d.id), disabled: !o.canAct, onClick: () => hd.edit(ui.editing === d.id ? null : d.id) },
          needs ? 'Finish setup' : ui.editing === d.id ? 'Done' : 'Edit'));
    }))
    : h('p', { class: 'gl-dim' }, 'You haven’t added anywhere to stream yet. Add Twitch, YouTube or any other site.');

  const adding = ui.adding ? h('div', { class: 'gl-edit', 'data-gl': 'add-panel' }, h('b', null, 'Where do you stream?'),
    h('div', { class: 'gl-add' }, ...PLATFORM_ORDER.map((p) => h('button', { class: 'gl-btn', type: 'button', 'data-add': p, disabled: dis, onClick: () => hd.add(p) }, PLATFORM_NAME[p]))),
    h('button', { class: 'gl-btn s', type: 'button', onClick: () => hd.startAdd() }, 'Never mind')) : null;

  const d = ui.editing ? o.destinations.find((x) => x.id === ui.editing) ?? null : null;
  const editor = d ? renderEditor(d, o) : null;
  return h('section', { class: 'gl-card', 'data-gl': 'destinations', 'aria-label': 'Where you stream' }, head, chips, adding, editor);
}

function renderEditor(d: DestinationView, o: DestCardOpts): HTMLElement {
  const { handlers: hd, ui } = o;
  const val = (k: string, fallback: string) => ui.draft[`${d.id}:${k}`] ?? fallback;
  const inp = (k: string, fallback: string, label: string, ph = '') => {
    const i = h('input', { class: 'gl-input', type: 'text', value: val(k, fallback), placeholder: ph, 'aria-label': label, 'data-field': k, autocomplete: 'off', maxLength: 140 }) as HTMLInputElement;
    i.addEventListener('input', () => hd.draftSet(`${d.id}:${k}`, i.value));
    return i;
  };
  const label = inp('label', d.label, 'Name', PLATFORM_NAME[d.platform]);
  const url = d.platform === 'custom' ? inp('url', d.url, 'Stream address', 'Where your site wants the stream sent') : null;
  const fields = h('div', { class: 'gl-field-grid gl-edit', 'data-gl': 'editor', 'data-for': d.id },
    field('Name', label), url ? field('Stream address', url) : null,
    h('div', { class: 'gl-row' },
      h('button', { class: 'gl-btn s pri', type: 'button', 'data-gl': 'save-meta', disabled: !o.canAct,
        onClick: () => hd.saveMeta(d.id, { label: label.value, url: url?.value ?? d.url }) }, 'Save'),
      removeButton(d, o)),
    renderKeyPart(d, o));
  return fields;
}

/** Remove needs a second press (the first changes the words on the button). */
function removeButton(d: DestinationView, o: DestCardOpts): HTMLElement {
  const b = h('button', { class: 'gl-btn s bad', type: 'button', 'data-gl': 'remove-dest', disabled: !o.canAct || o.locked }, 'Remove this one') as HTMLButtonElement;
  let armed = 0;
  b.addEventListener('click', () => {
    if (armed) { window.clearTimeout(armed); armed = 0; o.handlers.remove(d.id); return; }
    b.textContent = 'Press again to remove';
    armed = window.setTimeout(() => { armed = 0; b.textContent = 'Remove this one'; }, 3000);
  });
  return b;
}

function renderKeyPart(d: DestinationView, o: DestCardOpts): HTMLElement {
  const { handlers: hd } = o;
  const linked = d.keyState === 'saved';
  const key = h('input', { class: 'gl-input', type: 'password', placeholder: linked ? 'A key is saved. Paste a new one to replace it.' : 'Paste your stream key', 'aria-label': 'Stream key',
    'data-gl': 'key-input', autocomplete: 'off', autocapitalize: 'off', maxLength: 512 }) as HTMLInputElement;
  key.setAttribute('spellcheck', 'false');
  const save = () => hd.saveKey(d.id, key);
  key.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  return h('div', { class: 'gl-field', 'data-gl': 'key-part' }, h('span', null, `Your ${PLATFORM_NAME[d.platform]} stream key`), key,
    h('div', { class: 'gl-row' },
      h('button', { class: 'gl-btn s pri', type: 'button', 'data-gl': 'save-key', disabled: !o.canAct || o.locked, onClick: save }, linked ? 'Replace key' : 'Save key'),
      linked ? h('button', { class: 'gl-btn s', type: 'button', 'data-gl': 'clear-key', disabled: o.locked, onClick: () => hd.clearKey(d.id) }, 'Forget the key') : null),
    h('span', { class: 'gl-dim gl-small' }, 'Find it on your streaming site, under stream settings. Treat it like a password.'));
}
