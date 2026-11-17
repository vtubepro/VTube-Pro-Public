// "Who brings the chat?" — the chat buddy picker (the Chat wizard's "In the room" step and Room → Advanced → Chat &
// events). Any avatar in this PC's library walks in holding the chat tablet: the builtins first (Sprocket — the
// default — Mirelle, Kairo), then the user's own imports. Big picture tiles, one click; the rest of a long library
// sits in a "More avatars" list. Choices + order: shared/chat.ts buddyChoices (unit-tested in tools/chatbuddy_unit.ts).
import { api } from '../api.ts';
import type { AvatarProfile } from '../../shared/types.ts';
import { buddyChoices, buddyNameOf, DEFAULT_BUDDY, type BuddyChoice } from '../../shared/chat.ts';
import { h } from './dom.ts';

const CSS = `
.bp { margin-top: 10px; }
.bp-head { display: flex; align-items: center; gap: 8px; font-weight: 700; margin-bottom: 6px; }
.bp-head svg { width: 18px; height: 18px; flex: none; color: var(--accent); }
.bp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: 8px; }
.bp-grid .s-tile .img { aspect-ratio: 1; }
.bp-grid .s-tile .nm { font-size: 12px; }
.bp-grid .s-tile .tag { display: block; font-weight: 500; font-size: 10.5px; color: var(--dim); }
.bp-more { margin-top: 8px; display: flex; gap: 8px; align-items: center; font-size: 12.5px; color: var(--dim); }
.bp-more select { flex: 1; min-width: 0; }
.bp-note { margin-top: 6px; }
`;
let cssDone = false;

/** Chat bubble mark (stroke follows the text colour). */
export const CHAT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"/><path d="M8.5 11h7M8.5 14.5h4.5"/></svg>';

// the library is shared by both pickers and refreshed at most every 20 s (a new import shows up on the next render)
let lib: AvatarProfile[] | null = null;
let libAt = 0;
let loading: Promise<void> | null = null;
function library(onLoad: () => void): AvatarProfile[] | null {
  if (!loading && Date.now() - libAt > 20000) {
    libAt = Date.now();
    loading = api.avatars().then((l) => { const ch = JSON.stringify(l.map((a) => [a.id, a.name, a.thumbnail])) !== JSON.stringify((lib ?? []).map((a) => [a.id, a.name, a.thumbnail])) || lib === null; lib = l; if (ch) onLoad(); })
      .catch(() => { lib ??= []; }).finally(() => { loading = null; });
  }
  return lib;
}

/** The display name of the current buddy on this PC (for "<name> walks in holding a tablet with your chat"). */
export function buddyName(current: string): string { return buddyNameOf(lib, current || DEFAULT_BUDDY); }

export interface BuddyPickerOpts {
  current: string;
  /** Guests / observers: shown, not clickable. */
  disabled?: boolean;
  onPick: (id: string) => void;
  /** Re-render the host (the library arrived / changed). */
  refresh: () => void;
  /** How many picture tiles before "More avatars" (default 6). */
  tiles?: number;
}

export function buddyPicker(o: BuddyPickerOpts): HTMLElement {
  if (!cssDone) { document.head.append(h('style', null, CSS)); cssDone = true; }
  const l = library(o.refresh);
  const head = h('div', { class: 'bp-head' });
  head.innerHTML = CHAT_ICON;
  head.append(h('span', null, 'Who brings the chat?'));
  const box = h('div', { class: 'bp', role: 'group', 'aria-label': 'Who brings the chat?' }, head);
  if (l === null) { box.append(h('p', { class: 'note' }, 'Loading your avatars…')); return box; }
  const current = o.current || DEFAULT_BUDDY;
  const all = buddyChoices(l, current);
  const n = o.tiles ?? 6;
  // the picture tiles: the first n (the current pick always among them)
  let shown = all.filter((c) => !c.missing).slice(0, n);
  const cur = all.find((c) => c.id === current && !c.missing);
  if (cur && !shown.includes(cur)) shown = [...shown.slice(0, n - 1), cur];
  const tile = (c: BuddyChoice<AvatarProfile>) => {
    const on = c.id === current;
    const t = c.item?.thumbnail ? api.fileUrl(c.item, c.item.thumbnail) : null;
    return h('button', { class: `s-tile ${on ? 'on' : ''}`, 'aria-pressed': String(on), disabled: o.disabled, title: on ? `${c.name} brings the chat` : `${c.name} brings the chat instead`, onClick: () => { if (!on) o.onPick(c.id); } },
      t ? h('img', { class: 'img', src: t, alt: '', loading: 'lazy' }) : h('div', { class: 'img' }, '☺'),
      on ? h('span', { class: 'check' }, '✓') : null,
      h('span', { class: 'nm' }, c.name, c.isDefault ? h('span', { class: 'tag' }, 'Default') : null));
  };
  box.append(h('div', { class: 'bp-grid' }, ...shown.map(tile)));
  const rest = all.filter((c) => !c.missing && !shown.includes(c));
  if (rest.length) {
    const sel = h('select', { disabled: o.disabled, 'aria-label': 'More avatars', onChange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v) o.onPick(v); } },
      h('option', { value: '' }, `Pick another (${rest.length})…`), ...rest.map((c) => h('option', { value: c.id, selected: c.id === current }, c.label)));
    box.append(h('label', { class: 'bp-more' }, h('span', null, 'More avatars'), sel));
  }
  const miss = all.find((c) => c.missing);
  if (miss) box.append(h('p', { class: 'note bp-note' }, `“${miss.id}” isn't in this PC's library, so ${buddyNameOf(l, DEFAULT_BUDDY)} brings the chat here. Pick one above to change it.`));
  box.append(h('p', { class: 'note bp-note' }, 'Any avatar works, even your own imports. It walks in without its outfit and holds a tablet with your chat. Party guests see their own copy, or the default if they don’t have it.'));
  return box;
}
