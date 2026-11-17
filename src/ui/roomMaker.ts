// Create → "Make a room with your AI" (owner 2026-10-02: "make sure the room maker is correctly under Create and tells an
// AI like Claude, GPT, or Grok … what's required … seating, entrances, cameras, and the screens"; "make sure that it lets
// them properly use their desktop apps for it … Claude Desktop, ChatGPT Desktop, and Grok Bot. Notifications about API
// can be a thing, but be careful"). The brief (shared/roomBrief.ts) carries every name the engine reads and both ways to
// build: desktop apps with Blender → "＋ Add my room"; Grok Bot → a room package built from "Check what Claude made".
// The built-in chat (a model on this PC) can take the brief too.
import type { App } from '../app.ts';
import { BRIEF_MAX_SEATS, ROOM_BRIEF_DEFAULTS, roomBrief } from '../../shared/roomBrief.ts';
import { fillChat, openAiChat } from './aiChat.ts';
import { button, h, toast } from './dom.ts';

/** Kept across redraws (the Create page redraws often). */
const st = { idea: '', ...ROOM_BRIEF_DEFAULTS };
export function roomMakerCard(app: App, o: { chat: boolean; refresh: () => void; pickRoom: () => void; guide: HTMLElement }): HTMLElement {
  const brief = () => roomBrief({ idea: st.idea, seats: st.seats, screen: st.screen, door: st.door });
  const ta = h('textarea', { rows: 2, value: st.idea, 'aria-label': 'Describe your room', 'data-rm': 'idea',
    placeholder: 'e.g. “a cozy ramen bar at night, neon signs, a counter with stools”', onInput: (e: Event) => { st.idea = (e.target as HTMLTextAreaElement).value; } });
  const ready = () => { if (st.idea.trim()) return true; toast('Describe your room first', 'warn'); ta.focus(); return false; };
  const copyBrief = () => {
    if (!ready()) return;
    void navigator.clipboard?.writeText(brief()).then(() => toast('Brief copied. Paste it into a new chat in your AI app.', 'ok', 3500),
      () => toast('Copy didn’t work here. Open “See the brief” and copy it yourself.', 'warn'));
  };
  const seats = h('select', { 'aria-label': 'Places for people', 'data-rm': 'seats', onChange: (e: Event) => { st.seats = Number((e.target as HTMLSelectElement).value); } },
    ...Array.from({ length: BRIEF_MAX_SEATS }, (_, i) => h('option', { value: String(i + 1), selected: i + 1 === st.seats }, String(i + 1))));
  const tick = (label: string, key: 'screen' | 'door') => h('label', { style: 'display:inline-flex;gap:6px;align-items:center;margin-right:14px' },
    h('input', { type: 'checkbox', checked: st[key], 'data-rm': key, onChange: (e: Event) => { st[key] = (e.target as HTMLInputElement).checked; } }), label);
  const pre = h('pre', { style: 'white-space:pre-wrap;max-height:260px;overflow:auto;font-size:12px;margin:6px 0 0', 'data-rm': 'brief' });
  const see = h('details', { style: 'margin-top:8px' }, h('summary', null, 'See the brief'), pre);
  see.addEventListener('toggle', () => { if (see.open) pre.textContent = brief(); });
  return h('section', { class: 's-card', 'data-rm': 'card' },
    h('h3', null, 'Make a room with your AI'),
    h('p', { class: 'lead' }, 'Describe it. VTube Pro writes the full brief for Claude, ChatGPT or Grok: places to sit, cameras, a screen and a door, named the way VTube Pro reads them. So the room works the first time.'),
    ta,
    h('div', { class: 's-field' }, h('span', null, 'Places for people'), seats),
    h('div', { style: 'margin:6px 0 2px' }, tick('A screen for React mode', 'screen'), tick('A door to walk in', 'door')),
    h('div', { class: 's-row', style: 'margin-top:8px;gap:8px;flex-wrap:wrap' },
      button('Copy the brief', copyBrief, 'primary'),
      button('＋ Add my room', () => void import('./onboard/roomKind.ts').then((m) => m.openRoomWizard(app, {}))),
      // (the built-in chat runs a model on this PC; the desktop apps stay the way we recommend)
      o.chat ? button('Use it in Ask your AI', () => {
        if (!ready()) return;
        const box = document.querySelector('[data-cg-panel=chat]');
        if (box) { fillChat(brief()); box.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        else { void navigator.clipboard?.writeText(brief()); void openAiChat(); toast('Brief copied: paste it into the chat.', 'ok', 3500); }
      }, 'ghost') : null),
    h('ol', { class: 'note', style: 'margin:10px 0 0;padding-left:18px' },
      h('li', null, 'Copy the brief.'),
      h('li', null, 'In Claude Desktop, ChatGPT Desktop or Grok Bot, start a new chat and paste it.'),
      h('li', null, 'Claude and ChatGPT build it in Blender on this computer: approve it in VTube Pro when it asks, then press ＋ Add my room with the file it gives you. Grok Bot sends a room package: build it from Check what Claude made.')),
    h('p', { class: 'note', style: 'margin:8px 0 0' }, 'Needs Blender (free) on this computer.'),
    see,
    h('p', { class: 'note', style: 'margin:10px 0 0' }, 'Rather pick a ready-made room? ', button('Describe a room', o.pickRoom, 'link'), ' · Building it yourself? ', o.guide));
}
