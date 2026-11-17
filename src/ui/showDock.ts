// Show dock (beta.12 UX, owner: "easier to run the show and less diving through submenus"): ONE compact bar along the
// bottom of the studio, in every area, with the live show one click away and everything else in a small menu above it.
//   bar (1 click):   status light · Lights (Shift+1..5) · Mode (Shift+T/R/G/I) · Camera · Hide my screen (Ctrl+B) · Hide chat
//   menus (2 clicks): Room (rooms + areas) · Me (expressions 1-9, emotes, outfits Ctrl+1..9, recalibrate) · Guests
//                     (knocks, mute / camera / cut, cut all, invite link) · Chat (Chat Hub, acknowledge, thank, read-aloud,
//                     polls) · Events (the room's own moments: weather, set pieces, club, lounge, slap) · Screen (share a
//                     window onto the React screen, React size, background video)
// Every button runs the same Stream Deck action as Live Control (deckClient → /ws/deck → shared/deck.ts planRun), so the
// lit state and the result are identical; the two studio-only bits call exactly what their panels call (the window
// picker: SceneController.pickSource / setCapture; React size: setStage, like Shift+< >; the invite link: copyInterviewLink).
// In Live Control the bar hides what the console already shows (light, lights, mode, camera): the rest stays.
// Collapsed (the chevron) it is a slim status strip; that choice is remembered in this browser (never from an observer
// tab, which shares storage with the live studio). New layout only: Classic keeps beta.9's mini-bar.
//
// Extension point for other workstreams: registerDockEntry({ menu: 'room' | 'me' | ..., ... }) adds a row to a menu
// (e.g. a room editor's "Edit this room" in Room, 2D avatar options in Me). Entries never need to touch this file.
import type { App } from '../app.ts';
import { TEST_EXPRESSIONS } from '../app.ts';
import { h, toast } from './dom.ts';
import { icon } from './icons.ts';
import { deckClient } from './live/deckClient.ts';
import { DOING, LIGHTS } from './live/liveControl.ts';
import { pollObs } from './simple.ts';
import { openTool } from './dockTools.ts';
import { copyInterviewLink } from './guestLink.ts';
import { isClassic, onLayoutMode } from './layoutMode.ts';
import { stageModeList } from '../scene/stage/registry.ts';
import { favFirst } from '../../shared/liveView.ts';
import { onRoomFavs, roomFavs } from './roomFavs.ts';
import { fixItIssues, fixItNext, onAssist, openFixIt } from './assistHooks.ts';
import { REACT_PRESETS } from '../../shared/stage.ts';
import { comboLabel, loadHideScreenKey } from '../../shared/hotkey.ts';
import type { DeckLiveState } from '../../shared/deck.ts';
import type { LiveStatus } from '../../shared/liveControl.ts';
import { DOCK_EXPRESSIONS, DOCK_PREF_KEY, dockEvents, dockLit, dockPrefsText, dockShots, expressionKey, parseDockPrefs, type DockKey, type DockMenuId } from '../../shared/showDock.ts';

// ---------------------------------------------------------------- extension registry
export interface DockEntry {
  id: string;
  menu: DockMenuId;
  label: string;
  hint?: string;
  /** Icon name (src/ui/icons.ts). */
  icon?: string;
  /** Lower = higher in the menu's "More" list (default 100). */
  order?: number;
  /** Shown only when this says so (default: always). */
  when?(app: App): boolean;
  run(app: App, from: HTMLElement): void;
}
const entries = new Map<string, DockEntry>();
let repaintAll: (() => void) | null = null;
/** Add a row to one of the dock's menus (returns the remover). Re-registering an id replaces it. */
export function registerDockEntry(e: DockEntry): () => void {
  entries.set(e.id, e); repaintAll?.();
  return () => { if (entries.get(e.id) === e) { entries.delete(e.id); repaintAll?.(); } };
}

export interface DockHost {
  /** Open a studio area ('room', 'me', 'onair' …). */
  go(area: string): void;
  /** The live status (party, knocks, outfits, emotes): Live Control's own. */
  status(): LiveStatus;
}
export interface ShowDock { el: HTMLElement }

const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage off: this tab only */ } };
const AIR = {
  obs: { label: 'In OBS', tip: 'OBS is showing VTube Pro', hint: 'You are live only while OBS is streaming. Viewers see your avatar, not your camera picture. Opens Live Control (Alt+L).' },
  cam: { label: 'Camera on', tip: 'Your camera is on. OBS isn’t showing VTube Pro.', hint: 'Your camera only moves your avatar here. Opens Live Control (Alt+L).' },
  off: { label: 'Not in OBS', tip: 'OBS isn’t showing VTube Pro', hint: 'VTube Pro never streams by itself: OBS does. Opens Live Control (Alt+L).' },
} as const;
const MENUS: { id: DockMenuId; label: string; ic: string; hint: string }[] = [
  { id: 'room', label: 'Room', ic: 'room', hint: 'Switch rooms and areas' },
  { id: 'me', label: 'Me', ic: 'me', hint: 'Expressions, emotes and outfits' },
  { id: 'guests', label: 'Guests', ic: 'users', hint: 'Let people in, mute, hide a camera, cut, invite' },
  { id: 'chat', label: 'Chat', ic: 'chat', hint: 'Chat Hub, acknowledge and thank supporters, read-aloud, polls' },
  { id: 'events', label: 'Events', ic: 'wand', hint: 'This room’s moments: weather, set pieces, celebrations, slap' },
  { id: 'screen', label: 'Screen', ic: 'tv', hint: 'Share a window onto the React screen, its size, background video' },
];

export function initShowDock(app: App, host: DockHost): ShowDock {
  if (!document.getElementById('vtp-sd-css')) document.head.append(h('style', { id: 'vtp-sd-css' }, DOCK_CSS));
  const deck = deckClient();
  const S = app.scene;
  const canRun = !app.observer || new URLSearchParams(location.search).has('livetest');
  let prefs = parseDockPrefs(lsGet(DOCK_PREF_KEY));
  const savePrefs = () => { if (!app.observer) lsSet(DOCK_PREF_KEY, dockPrefsText(prefs)); };

  const el = h('div', { id: 'showdock', class: 'sd', role: 'toolbar', 'aria-label': 'Show controls', 'data-ui': 'show-dock' });
  const tip = h('div', { class: 'sd-tip', role: 'tooltip', hidden: true });
  document.body.append(tip);

  // ---------------------------------------------------------------- running
  const run = (action: string, params: Record<string, unknown> | undefined, label: string) => {
    if (!canRun) { toast('Read-only here (observer tab): show buttons are off', 'warn', 2200); return; }
    void deck.run(action, params).then((r) => { if (!r.ok) toast(`${label}: ${r.error ?? 'didn’t work'}`, 'err'); });
  };
  const editable = () => S.canEdit;
  const roomInfo = () => (S.scenes.find((x) => x.id === S.effective.sceneId) ?? null) as unknown as Record<string, unknown> | null;
  /** The deck's live state; with no server answering it knows no room, so the bar
   *  shows the studio's own room + mode instead of a "No room" that Home contradicts. */
  const liveNow = (): DeckLiveState => { const l = deck.live(); return deck.online() || l.sceneId ? l : { ...l, sceneId: S.effective.sceneId ?? null, mode: S.effective.mode ?? l.mode }; };
  const coverKey = () => { let l: Storage | null = null; try { l = localStorage; } catch { /* blocked */ } return comboLabel(loadHideScreenKey(l)); };

  // ---------------------------------------------------------------- one key
  interface KOpts { on?: boolean | null; cls?: string; ic?: string; sw?: string; tipText?: string; hint?: string; key?: string; disabled?: boolean; danger?: boolean; kids?: (Node | string | null)[]; label?: boolean }
  const keyBtn = (k: string, label: string, onClick: (b: HTMLElement) => void, o: KOpts = {}) => {
    const b = h('button', {
      type: 'button', class: `${o.cls ?? 'sd-k'}${o.on ? ' on' : ''}${o.danger ? ' danger' : ''}`, 'data-k': k,
      'aria-pressed': o.on === null || o.on === undefined ? null : String(!!o.on), disabled: o.disabled || null,
      'data-tip': o.tipText ?? label, 'data-hint': o.hint ?? null, 'data-key': o.key ?? null,
      'aria-label': o.label === false ? label : null,
      onClick: (e: MouseEvent) => { hideTip(); onClick(e.currentTarget as HTMLElement); },
    }, o.sw ? h('i', { class: 'sw', style: `background:${o.sw}`, 'aria-hidden': 'true' }) : null, o.ic ? icon(o.ic, 15) : null,
    o.label === false ? null : h('span', { class: 'l' }, label), ...(o.kids ?? []));
    return b;
  };
  /** A deck action as a key (lit from the deck's live state). */
  const act = (d: DockKey, live: DeckLiveState, o: KOpts = {}) => keyBtn(d.k, d.label, () => run(d.action, d.params, d.label), { on: dockLit(d, live), ic: d.ic, hint: d.hint, key: d.key, ...o });

  // ---------------------------------------------------------------- tooltip (label, plain line, shortcut)
  let tipT = 0, tipFor: HTMLElement | null = null;
  function showTip(t: HTMLElement) {
    const label = t.dataset.tip; if (!label) return;
    // (a menu's own button while that menu is open: its tooltip would sit on the menu)
    if (pop && (t === popFrom || (!!openId && t.dataset.menu === openId))) return;
    tipFor = t;
    const kids: Node[] = [h('b', null, label)];
    if (t.dataset.hint) kids.push(h('span', null, t.dataset.hint));
    if (t.dataset.key) kids.push(h('span', { class: 'kb' }, ...t.dataset.key.split('+').flatMap((x, i) => (i ? ['+', h('kbd', null, x)] : [h('kbd', null, x)]))));
    tip.replaceChildren(...kids);
    tip.hidden = false;
    const r = t.getBoundingClientRect(), w = tip.offsetWidth, hh = tip.offsetHeight;
    const below = r.top - hh - 10 < 4;
    tip.style.left = `${Math.round(Math.min(innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2)))}px`;
    tip.style.top = `${Math.round(below ? r.bottom + 8 : r.top - hh - 8)}px`;
  }
  function hideTip() { clearTimeout(tipT); tip.hidden = true; tipFor = null; }
  const tipHost = (root: HTMLElement) => {
    root.addEventListener('pointerover', (e) => { const t = (e.target as HTMLElement).closest?.('[data-tip]') as HTMLElement | null; if (!t || t === tipFor) return; clearTimeout(tipT); tipT = window.setTimeout(() => showTip(t), 380); });
    root.addEventListener('pointerleave', hideTip);
    root.addEventListener('focusin', (e) => { const t = (e.target as HTMLElement).closest?.('[data-tip]') as HTMLElement | null; if (t && t.matches(':focus-visible')) showTip(t); });
    root.addEventListener('focusout', hideTip);
  };
  tipHost(el);

  // ---------------------------------------------------------------- menus (one at a time, opening upwards)
  let openId: DockMenuId | null = null, pop: HTMLElement | null = null, popFrom: HTMLElement | null = null;
  let roomQuery = '';
  const closeMenu = (focusBack = false) => {
    if (!pop) return;
    pop.remove(); pop = null; const id = openId; openId = null;
    document.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', onKey, true); removeEventListener('resize', closeOnResize);
    paint(true);
    if (focusBack && id) (el.querySelector(`[data-menu="${id}"]`) as HTMLElement | null)?.focus();
  };
  const outside = (e: Event) => { const t = e.target as Node; if (pop && !pop.contains(t) && !(t instanceof Element && t.closest(`[data-menu="${openId}"]`))) closeMenu(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && pop) { e.preventDefault(); e.stopPropagation(); closeMenu(true); } };
  const closeOnResize = () => closeMenu();
  function openMenu(id: DockMenuId, from: HTMLElement, viaKeyboard: boolean) {
    if (openId === id) { closeMenu(true); return; }
    closeMenu(); hideTip();
    openId = id; popFrom = from;
    pop = h('div', { class: 'sd-pop', role: 'dialog', 'aria-label': MENUS.find((m) => m.id === id)?.label ?? id, 'data-ui': `dock-menu-${id}`, tabindex: -1 });
    tipHost(pop);
    document.body.append(pop);
    fillMenu();
    document.addEventListener('pointerdown', outside, true); window.addEventListener('keydown', onKey, true); addEventListener('resize', closeOnResize);
    paint(true);
    const first = pop.querySelector('input, button:not([disabled])') as HTMLElement | null;
    if (viaKeyboard || id === 'room') first?.focus({ preventScroll: true }); else pop.focus({ preventScroll: true });
  }
  function placeMenu() {
    if (!pop || !popFrom) return;
    const anchor = (popFrom.isConnected ? popFrom : el.querySelector(`[data-menu="${openId}"]`)) as HTMLElement | null;
    const r = (anchor ?? el).getBoundingClientRect(), top = Math.min(r.top, el.getBoundingClientRect().top), w = pop.offsetWidth;
    pop.style.left = `${Math.round(Math.min(innerWidth - w - 8, Math.max(8, r.left)))}px`;
    pop.style.bottom = `${Math.round(Math.max(8, innerHeight - top + 6))}px`;   // (above the whole bar, not just the button)
    pop.style.maxHeight = `${Math.round(Math.max(200, Math.min(620, top - 16)))}px`;
  }
  /** Rebuild the open menu (lit states change), keeping focus and scroll. */
  function fillMenu() {
    if (!pop || !openId) return;
    const fk = (document.activeElement as HTMLElement | null)?.closest?.('[data-k]')?.getAttribute('data-k') ?? (document.activeElement?.tagName === 'INPUT' && pop.contains(document.activeElement) ? '@search' : null);
    const caret = (document.activeElement as HTMLInputElement | null)?.selectionStart ?? null;
    const sc = pop.scrollTop;
    pop.replaceChildren(...menuBody(openId));
    pop.scrollTop = sc;
    if (fk) { const t = (fk === '@search' ? pop.querySelector('input') : pop.querySelector(`[data-k="${CSS.escape(fk)}"]`)) as HTMLElement | null; t?.focus({ preventScroll: true }); if (fk === '@search' && caret !== null) (t as HTMLInputElement).setSelectionRange(caret, caret); }
    placeMenu();
  }
  const sec = (title: string, ...kids: (Node | null | false)[]) => h('section', { class: 'sd-sec' }, h('h4', null, title), ...kids.filter((x): x is Node => !!x));
  const chips = (...kids: (Node | null)[]) => h('div', { class: 'sd-chips' }, ...kids);
  const chip = (k: string, label: string, go: (b: HTMLElement) => void, o: KOpts = {}) => keyBtn(k, label, go, { cls: 'sd-chip', ...o });
  const actChip = (d: DockKey, live: DeckLiveState, o: KOpts = {}) => act(d, live, { cls: 'sd-chip', ...o });
  const more = (menu: DockMenuId) => {
    const list = [...entries.values()].filter((e) => e.menu === menu && (!e.when || e.when(app))).sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    return list.map((e) => h('button', { type: 'button', class: 'sd-row', 'data-k': `x-${e.id}`, 'data-entry': e.id, onClick: (ev: MouseEvent) => { const from = ev.currentTarget as HTMLElement; closeMenu(); e.run(app, from); } },
      e.icon ? icon(e.icon, 16) : null, h('span', null, h('b', null, e.label), e.hint ? h('small', null, e.hint) : null)));
  };
  const goRow = (k: string, label: string, hint: string, ic: string, area: string) => h('button', { type: 'button', class: 'sd-row', 'data-k': k, onClick: () => { closeMenu(); host.go(area); } }, icon(ic, 16), h('span', null, h('b', null, label), h('small', null, hint)));
  const foot = (...rows: (HTMLElement | HTMLElement[] | null)[]) => { const r = rows.flat().filter((x): x is HTMLElement => !!x); return r.length ? h('div', { class: 'sd-foot' }, ...r) : null; };

  function menuBody(id: DockMenuId): Node[] {
    const live = liveNow(), st = host.status();
    const head = (title: string, sub: string) => h('header', { class: 'sd-head' }, h('b', null, title), h('span', null, sub));
    switch (id) {
      case 'room': {
        const favs = roomFavs();
        const rooms = favFirst(S.scenes.filter((r) => !(r as { hidden?: boolean }).hidden), favs);
        const q = roomQuery.trim().toLowerCase();
        const shown = q ? rooms.filter((r) => r.name.toLowerCase().includes(q) || r.id.includes(q)) : rooms;
        const cur = live.sceneId ?? '';
        const search = h('input', { type: 'search', class: 'sd-search', placeholder: `Find a room (${rooms.length})`, value: roomQuery, 'aria-label': 'Find a room', onInput: (e: Event) => { roomQuery = (e.target as HTMLInputElement).value; fillMenu(); } });
        const card = (rid: string, name: string, thumb?: string | null) => h('button', {
          type: 'button', class: `sd-room${cur === rid ? ' on' : ''}${favs.includes(rid) ? ' fav' : ''}`, 'data-k': `room-${rid || 'classic'}`, 'aria-pressed': String(cur === rid), 'data-tip': rid ? name : 'Classic (no room)', 'data-hint': rid ? 'Switch room (the transition card covers the change)' : 'See-through background: your avatar over OBS',
          onClick: () => { run('room', { sceneId: rid }, name); closeMenu(); },
        }, h('span', { class: 'th' }, thumb ? h('img', { src: thumb, alt: '', loading: 'lazy' }) : icon(rid ? 'room' : 'eyeoff', 18), favs.includes(rid) ? h('i', { class: 'star', 'aria-label': 'favourite' }, '★') : null), h('span', { class: 'nm' }, name));
        const info = roomInfo() as { areaList?: { key: string; label: string }[] } | null;
        const areas = info?.areaList && info.areaList.length > 1 ? info.areaList : null;
        const curArea = (info as { area?: string } | null)?.area;
        return [head('Room', 'Switch rooms. The transition card covers the change.'),
          search,
          areas ? sec('Areas in this room', chips(...areas.map((a) => chip(`area-${a.key}`, a.label, () => run('area', { area: a.key }, a.label), { on: curArea === a.key })),
            chip('area-next', 'Next', () => run('area', { area: 'next' }, 'Next area'), { ic: 'next' }))) : null,
          h('div', { class: 'sd-rooms', role: 'group', 'aria-label': 'Rooms' }, ...shown.slice(0, favs.length).filter((r) => favs.includes(r.id)).map((r) => card(r.id, r.name, r.thumb)), q ? null : card('', 'Classic'), ...shown.filter((r) => !favs.includes(r.id)).map((r) => card(r.id, r.name, r.thumb)),
            shown.length ? null : h('p', { class: 'sd-empty' }, `No room matches “${roomQuery}”.`)),
          foot(goRow('go-room', 'Room settings', 'Seats, lights, time and weather, camera. Star favourites in Live → Rooms', 'settings', 'room'), more('room')),
        ].filter((x): x is HTMLElement => !!x);
      }
      case 'me': {
        const names = Object.keys(TEST_EXPRESSIONS);
        const outfits = st.me.outfits;
        return [head('Me', 'Your face, emotes and outfit, on stream right away.'),
          sec('Expression (a few seconds)', chips(...DOCK_EXPRESSIONS.filter((n) => names.includes(n)).map((n) => chip(`ex-${n}`, n, () => run('expression', { name: n, seconds: 3 }, n), { key: expressionKey(n, names) || undefined, hint: `Shows “${n}” for 3 seconds, then your own face again` })))),
          st.emotes.length ? sec('Emote', chips(...st.emotes.map((e) => chip(`em-${e.id}`, e.label, () => run('emote', { name: e.id }, e.label), { hint: `Plays the ${e.label.toLowerCase()} emote` })),
            chip('em-stop', 'Stop', () => run('emote', { name: 'stop' }, 'Stop emote'), { ic: 'x', hint: 'Stops the emote' }))) : null,
          sec('Outfit', chips(chip('fit-default', 'Default', () => run('costume', { id: '' }, 'Default outfit'), { on: !st.me.outfit, key: 'Ctrl+0' }),
            ...outfits.map((c, i) => chip(`fit-${c.id}`, c.name, () => run('costume', { id: c.id }, c.name), { on: st.me.outfit === c.id, key: i < 9 ? `Ctrl+${i + 1}` : undefined })))),
          st.me.accessories.length ? sec('Extras', chips(...st.me.accessories.map((c) => chip(`acc-${c.id}`, c.name, () => run('accessory', { id: c.id }, c.name), { on: c.on, hint: `${c.on ? 'Take off' : 'Put on'} ${c.name}` })))) : null,
          sec('Tracking', chips(chip('recal', 'Recalibrate', () => run('recalibrate', undefined, 'Recalibrate'), { ic: 'target', key: 'C', hint: 'Look at the screen with a relaxed face for 2 seconds' }))),
          foot(goRow('go-me', 'Avatar, outfits and look', 'Change avatar, make an outfit, face settings', 'me', 'me'), more('me')),
        ].filter((x): x is HTMLElement => !!x);
      }
      case 'guests': {
        const P = st.party, others = P.members.filter((m) => !m.me), hostRole = P.role === 'host';
        const n = (id: string) => others.findIndex((m) => m.id === id) + 1;
        return [head('Guests', hostRole ? `${others.length} ${others.length === 1 ? 'guest' : 'guests'} in your party` : 'Invite someone to your show.'),
          P.knocks.length ? sec('Knocking', ...P.knocks.map((k) => h('div', { class: 'sd-line' }, h('span', { class: 'who' }, k.name, k.link ? h('small', null, 'link') : null),
            chip(`in-${k.peer}`, 'Let in', () => run('knock-approve', { peer: k.peer }, 'Let in'), { cls: 'sd-chip pri', ic: 'door' }),
            chip(`no-${k.peer}`, 'Deny', () => run('knock-deny', { peer: k.peer }, 'Deny'))))) : null,
          others.length ? sec('On the show', ...others.map((m) => h('div', { class: 'sd-line' }, h('span', { class: 'who' }, m.name, m.speaking ? h('i', { class: 'talk', title: 'Talking' }) : null),
            chip(`mute-${m.id}`, m.mod?.mic ? 'Unmute' : 'Mute', () => run('guest-mute', { peer: m.id, on: 'toggle' }, `Mute ${m.name}`), { on: !!m.mod?.mic, ic: m.mod?.mic ? 'micoff' : 'mic', hint: `Guest ${n(m.id)}: mute or unmute everywhere (Undo in Live → Guests)` }),
            chip(`cam-${m.id}`, m.mod?.cam ? 'Show camera' : 'Hide camera', () => run('guest-cam', { peer: m.id, on: 'toggle' }, `Camera ${m.name}`), { on: !!m.mod?.cam, ic: 'eyeoff', hint: 'Hide or show their camera on stream' }),
            chip(`cut-${m.id}`, 'Cut', () => run('guest-cut', { peer: m.id, on: 'toggle' }, `Cut ${m.name}`), { danger: true, hint: 'Camera and mic off at once. Press again to bring them back' }))),
            chips(chip('cutall', 'Cut all guests', (b) => armThen(b, 'Cut all', () => run('guests-cut-all', { on: 'true' }, 'Cut all')), { danger: true, ic: 'power', hint: 'Panic button: every guest’s camera and mic off. Click twice. One Undo brings them back.' }),
              chip('undo', 'Undo', () => run('guest-undo', undefined, 'Undo'), { ic: 'back', hint: 'Undo the last camera / mic change' }))) : null,
          sec('Invite', chips(chip('link', 'Copy guest link', () => { if (!canRun) { toast('Read-only here (observer tab)', 'warn'); return; } void copyInterviewLink(app); }, { cls: 'sd-chip pri', ic: 'link', hint: 'A no-install link for a guest (any browser, no Discord)' }))),
          foot(goRow('go-live-guests', 'All guest controls', 'Seats, green room, volume, roles: Live → Guests', 'live', 'onair'), goRow('go-party', 'Party', 'Stream together, Discord, invites', 'friends', 'friends'), more('guests')),
        ].filter((x): x is HTMLElement => !!x);
      }
      case 'chat': {
        return [head('Chat', 'Your chat and alerts. VTube Pro never posts in your chat.'),
          sec('Chat on stream', chips(act({ k: 'chathide', label: live.chatHidden ? 'Show chat' : 'Hide chat', action: 'chat-hide', params: { on: 'toggle' }, hint: 'Hides the chat monitor, chat buddy and docked chat from viewers (alerts stay)', ic: live.chatHidden ? 'chat' : 'chatoff' }, live, { cls: 'sd-chip' }),
            chip('hub', 'Open Chat Hub', () => { closeMenu(); openTool('chathub'); }, { ic: 'chat', hint: 'Every chat, donation and alert in one panel beside the stage' }))),
          sec('Supporters', chips(actChip({ k: 'ack', label: 'Acknowledge next', action: 'hub-ack-next', hint: 'Marks the oldest open support or event as done', ic: 'check' }, live),
            actChip({ k: 'thank', label: 'Thank next', action: 'hub-thank-next', hint: 'Thanks the oldest open supporter', ic: 'thanks' }, live),
            actChip({ k: 'tts', label: 'Read-aloud', action: 'hub-tts', hint: 'Reads donation messages out loud (on / off)', ic: 'speak' }, live))),
          sec('Poll', chips(actChip({ k: 'poll-yn', label: 'Yes / No', action: 'poll-start', params: { template: 'Yes / No' }, hint: 'Starts a Yes / No poll in chat', ic: 'poll' }, live),
            actChip({ k: 'poll-14', label: '1–4', action: 'poll-start', params: { template: '1–4' }, hint: 'Starts a 1–4 poll in chat', ic: 'poll' }, live),
            actChip({ k: 'poll-end', label: 'End poll', action: 'poll-end', hint: 'Ends the running poll (winner reveal)', ic: 'x' }, live))),
          foot(goRow('go-chat', 'Chat & events', 'Connect chats, alerts, raids', 'settings', 'chat'), more('chat')),
        ].filter((x): x is HTMLElement => !!x);
      }
      case 'events': {
        const groups = dockEvents(roomInfo(), live);
        return [head('Events', live.sceneId ? 'Moments this room can play. Viewers see them right away.' : 'Pick a room first: events happen inside a room.'),
          ...groups.map((g) => sec(g.label, chips(...g.keys.map((k) => actChip(k, live))))),
          foot(goRow('go-room-events', 'Room settings', 'How often things happen, crew, eras', 'settings', 'room'), more('events')),
        ].filter((x): x is HTMLElement => !!x);
      }
      case 'screen': {
        const room = !!live.sceneId, react = S.stage.react;
        return [head('Screen', 'What the room’s screen shows: your window, a video, how big.'),
          sec('Window on the React screen', h('p', { class: 'sd-note' }, S.capturing ? 'Sharing a window from this browser.' : 'No window shared from this browser (OBS uses the fast window feed, if you set one up).'),
            chips(chip('pick', S.capturing ? 'Pick another window' : 'Pick a window', () => { closeMenu(); if (!editable()) { toast('Only the host can do this', 'warn'); return; } S.pickSource().catch((e) => toast(`No window picked (${(e as Error).message})`, 'warn')); }, { cls: 'sd-chip pri', ic: 'tv', hint: 'Shows a window on the room’s React screen (never its sound)' }),
              S.capturing ? chip('stopshare', 'Stop sharing', () => { if (editable()) S.setCapture(null); }, { ic: 'x' }) : null)),
          room ? sec('React size', chips(...REACT_PRESETS.map((v) => chip(`rs-${v}`, v[0].toUpperCase() + v.slice(1), () => { if (!editable()) return; S.setStage({ react: v }); }, { on: react === v, hint: v === 'auto' ? 'The room decides' : `React window: ${v}`, key: 'Shift+< >' })))) : null,
          room ? sec('Background video', chips(actChip({ k: 'vid-on', label: 'On', action: 'video', params: { action: 'on', slot: '' }, hint: 'The room screen plays your playlists' }, live),
            actChip({ k: 'vid-off', label: 'Off', action: 'video', params: { action: 'off', slot: '' }, hint: 'Stays off until you turn it back on' }, live),
            actChip({ k: 'vid-next', label: 'Next', action: 'video', params: { action: 'next', slot: '' }, hint: 'Next video', ic: 'next' }, live, { on: null }))) : null,
          foot(goRow('go-show', 'Show & layout', 'React screen, game capture, layout editor', 'show', 'show'), more('screen')),
        ].filter((x): x is HTMLElement => !!x);
      }
    }
  }
  const armed = new WeakMap<HTMLElement, number>();
  function armThen(b: HTMLElement, label: string, go: () => void) {
    if (armed.has(b)) { clearTimeout(armed.get(b)); armed.delete(b); b.classList.remove('arm'); go(); return; }
    const old = [...b.childNodes]; b.classList.add('arm'); b.replaceChildren(`Confirm ${label.toLowerCase()}?`);
    armed.set(b, window.setTimeout(() => { armed.delete(b); b.classList.remove('arm'); b.replaceChildren(...old); }, 3000));
  }

  // ---------------------------------------------------------------- the bar
  let lastSig = '';
  function paint(force = false) {
    const live = liveNow(), st = host.status();
    const tracking = app.trackingOn, obs = pollObs();
    const air = obs > 0 ? 'obs' : tracking ? 'cam' : 'off';
    const info = roomInfo();
    const sig = JSON.stringify([live, prefs.min, air, openId, st.party.knocks.length, st.party.members.length, info?.id ?? null, editable(), deck.online(), document.body.classList.contains('lc-console'), entries.size, fixItIssues()]);
    if (!force && sig === lastSig) return;
    lastSig = sig;
    if (pop && openId) fillMenu();
    const focusK = el.contains(document.activeElement) ? (document.activeElement as HTMLElement).getAttribute('data-k') : null;
    const room = !!live.sceneId;
    const roomName = room ? (S.scenes.find((x) => x.id === live.sceneId)?.name ?? live.sceneId!) : 'No room';
    const airBtn = keyBtn('air', AIR[air].label, () => host.go('onair'), { cls: `sd-air ${air}`, tipText: AIR[air].tip, hint: AIR[air].hint, key: 'Alt+L', kids: [] });
    airBtn.prepend(h('i', { class: 'dot', 'aria-hidden': 'true' }));
    el.classList.toggle('min', prefs.min);
    el.dataset.air = air;
    const collapse = keyBtn('collapse', prefs.min ? 'Show the show controls' : 'Collapse the show controls', () => { prefs = { min: !prefs.min }; savePrefs(); closeMenu(); paint(true); (el.querySelector('[data-k="collapse"]') as HTMLElement | null)?.focus(); },
      { cls: 'sd-k sd-fold', ic: 'chev', label: false, hint: prefs.min ? 'Lights, mode, camera and menus' : 'A slim status line; your choice is remembered' });
    collapse.setAttribute('aria-expanded', String(!prefs.min));
    if (prefs.min) {
      const lit = LIGHTS.find((l) => l.id === live.lighting);
      const mode = DOING.find((d) => d.id === live.mode);
      el.replaceChildren(airBtn,
        h('span', { class: 'sd-sum' }, room ? [lit ? h('i', { class: 'sw', style: `background:${lit.sw}` }) : null, h('b', null, lit?.label ?? live.lighting), h('span', null, mode?.label ?? live.mode), h('span', null, roomName)] : h('span', null, 'No room')),
        h('span', { class: 'sd-sp' }), collapse);
      restoreFocus(focusK);
      return;
    }
    const grp = (id: string, label: string, dup: boolean, ...kids: (Node | null)[]) => h('div', { class: 'sd-grp', role: 'group', 'aria-label': label, 'data-grp': id, 'data-dup': dup ? '1' : null }, h('span', { class: 'sd-cap', 'aria-hidden': 'true' }, label), h('div', { class: 'sd-bank' }, ...kids));
    const modes = stageModeList();
    const keyOf = (m: string) => { const d = modes.find((x) => x.id === m); return d?.key ? `Shift+${d.key.toUpperCase()}` : undefined; };
    const roomOnly = !room ? null : [
      grp('lights', 'Lights', true, ...LIGHTS.map((l, i) => act({ k: `light-${l.id}`, label: l.short, action: 'lighting', params: { state: l.id }, hint: `${l.sub}. ${l.hint}.`, key: `Shift+${i + 1}` }, live, { sw: l.sw, tipText: `${l.label} lighting` }))),
      grp('mode', 'Mode', true, ...DOING.filter((d) => d.id !== 'ttrpg').map((d) => act({ k: `mode-${d.id}`, label: d.label, action: 'mode', params: { mode: d.id }, hint: d.sub, key: keyOf(d.id), ic: d.ic }, live))),
      grp('camera', live.mode === 'interview' ? 'Interview camera' : 'Camera', true, ...dockShots(live).map((d) => act(d, live))),
    ];
    const knocks = st.party.knocks.length;
    const menuBtn = (m: (typeof MENUS)[number]) => {
      const label = m.id === 'room' ? roomName : m.label;
      const b = keyBtn(`menu-${m.id}`, label, (btn) => openMenu(m.id, btn, false), {
        cls: `sd-m${m.id === 'room' ? ' room' : ''}`, ic: m.ic, tipText: m.id === 'room' ? `Room: ${roomName}` : m.label, hint: m.hint,
        kids: [m.id === 'guests' && knocks ? h('span', { class: 'badge', 'aria-label': `${knocks} knocking` }, String(knocks)) : null, h('span', { class: 'chev', 'aria-hidden': 'true' }, icon('chev', 12))],
      });
      b.dataset.menu = m.id; b.setAttribute('aria-haspopup', 'dialog'); b.setAttribute('aria-expanded', String(openId === m.id));
      if (openId === m.id) b.classList.add('open');
      b.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowUp') && !e.repeat) { e.preventDefault(); openMenu(m.id, b, true); } });
      return b;
    };
    // zero-effort: when the doctor (src/ui/assistHooks.ts) knows of problems, one amber button next to the light fixes them
    const issues = fixItIssues();
    // (owner rule: only real problems are amber with a count; a set-up step still to do is one calm "Next" button)
    const nx = issues ? null : fixItNext();
    const fixBtn = issues ? keyBtn('fixit', `Fix it (${issues})`, (b) => openFixIt(b), { cls: 'sd-k sd-fix', ic: 'fix', hint: 'Something isn’t working. One click shows what and fixes what it can.' })
      : nx ? keyBtn('next-step', `Next: ${nx.short}`, (b) => openFixIt(b), { cls: 'sd-k sd-fix sd-next', ic: 'fix', tipText: `Next step: ${nx.says}`, hint: 'Nothing is broken. One click does this step for you.' }) : null;
    if (nx && fixBtn) fixBtn.setAttribute('aria-label', `Next step: ${nx.says}`); // (its words fold away on narrow bars)
    el.replaceChildren(
      h('div', { class: 'sd-grp sd-airg', 'data-dup': fixBtn ? null : '1' }, h('span', { 'data-dup': '1', style: 'display:contents' }, airBtn), fixBtn),
      ...(roomOnly ?? [h('div', { class: 'sd-noroom', 'data-dup': '1' }, h('span', null, 'Lights, modes and cameras work inside a room.'),
        keyBtn('pick-room', 'Pick a room', (b) => openMenu('room', b, false), { cls: 'sd-k pri', ic: 'room', hint: 'Opens the room list' }))]),
      grp('privacy', 'Privacy', false,
        act({ k: 'cover', label: 'Hide screen', action: 'cover', params: { on: 'toggle' }, hint: 'An animated card covers your game or window capture (pick the look in Live → Privacy)', key: coverKey(), ic: 'eyeoff' }, live, { tipText: live.cover ? 'Your screen is hidden' : 'Hide my screen' }),
        act({ k: 'chathide', label: 'Hide chat', action: 'chat-hide', params: { on: 'toggle' }, hint: 'Hides chat from viewers (support alerts stay)', ic: 'chatoff' }, live, { tipText: live.chatHidden ? 'Chat is hidden on stream' : 'Hide chat on stream' })),
      h('span', { class: 'sd-sp' }),
      h('div', { class: 'sd-menus', role: 'group', 'aria-label': 'More show controls' }, ...MENUS.map(menuBtn)),
      collapse,
    );
    restoreFocus(focusK);
  }
  function restoreFocus(k: string | null) { if (k) (el.querySelector(`[data-k="${CSS.escape(k)}"]`) as HTMLElement | null)?.focus({ preventScroll: true }); }

  // arrow keys move along the bar (Tab still works as usual)
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const all = [...el.querySelectorAll<HTMLElement>('button:not([disabled])')].filter((b) => b.offsetParent !== null);
    const i = all.indexOf(document.activeElement as HTMLElement); if (i < 0) return;
    e.preventDefault(); all[(i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length]?.focus();
  });

  deck.on(() => paint());
  S.on((w) => { if (w === 'state' || w === 'report') paint(); });
  window.setInterval(() => paint(), 700);
  onLayoutMode(() => { closeMenu(); paint(true); });
  repaintAll = () => paint(true);
  onAssist(() => paint(true));
  onRoomFavs(() => { if (openId === 'room') fillMenu(); });
  document.addEventListener('vtp-live-layout', () => paint(true));
  paint(true);
  void isClassic;
  return { el };
}

// One look in both themes: the bar is a recessed key bank (the theme's own tokens), the lit key carries a tally strip
// along its bottom edge; red only means "OBS shows VTube Pro".
const DOCK_CSS = `
#showdock { display: none; }
html.vtp-modern body:not(.clean) #showdock { display: flex; }
html.vtp-modern #app { grid-template-rows: 56px 1fr auto; }
html.vtp-modern #tabs { grid-row: 2 / 4; }
#showdock { grid-column: 2 / -1; grid-row: 3; container: sd / inline-size; align-items: center; gap: 8px; min-width: 0; height: 52px; padding: 0 10px 0 12px;
  background: var(--bg2); border-top: 1px solid var(--line); overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; position: relative; z-index: 61; }
#showdock.min { height: 36px; }
.sd-grp { display: flex; align-items: center; gap: 7px; flex: none; }
.sd-cap { font-size: 11.5px; font-weight: 600; color: var(--faint); white-space: nowrap; }
.sd-bank { display: flex; gap: 2px; padding: 3px; border-radius: 10px; background: var(--bg); box-shadow: inset 0 0 0 1px var(--line); }
.sd-k, .sd-m { height: 30px; display: inline-flex; align-items: center; gap: 6px; padding: 0 10px; border: 0; border-radius: 7px; background: transparent; color: var(--dim);
  font: 600 12.5px/1 Inter, system-ui, sans-serif; white-space: nowrap; cursor: pointer; position: relative; flex: none; }
.sd-k:hover:not([disabled]), .sd-m:hover { color: var(--text); background: var(--card2); }
.sd-k svg, .sd-m svg { flex: none; opacity: .85; }
.sd-k .sw { width: 9px; height: 9px; border-radius: 3px; flex: none; box-shadow: inset 0 0 0 1px #0003; }
.sd-k.on { color: var(--text); background: var(--card); box-shadow: inset 0 0 0 1px var(--line2), 0 1px 2px #0002; }
.sd-k.on::after { content: ''; position: absolute; left: 9px; right: 9px; bottom: 2px; height: 2px; border-radius: 2px; background: var(--accent); }
.sd-k.on svg { opacity: 1; color: var(--accent); }
.sd-k[disabled] { opacity: .45; cursor: default; }
.sd-k.pri { background: var(--accent); color: var(--accent-ink); }
.sd-k.pri:hover { background: var(--accent); color: var(--accent-ink); filter: brightness(1.06); }
.sd-air { border: 1px solid var(--line); background: var(--card); color: var(--text); padding: 0 12px 0 10px; height: 30px; border-radius: 99px; }
.sd-air .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--faint); flex: none; }
.sd-air.cam .dot { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.sd-air.obs { border-color: #ff5a5a66; background: color-mix(in srgb, #ff5a5a 14%, var(--card)); }
.sd-air.obs .dot { background: #ff5a5a; box-shadow: 0 0 0 3px #ff5a5a33, 0 0 10px #ff5a5a; }
.sd-sp { flex: 1 1 0; min-width: 8px; }
.sd-k.sd-fix { background: var(--warn-soft); color: var(--warn); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--warn) 55%, transparent); }
.sd-k.sd-fix.sd-next { background: var(--accent2-soft, transparent); color: var(--text); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent2, #6cc7f5) 45%, transparent); }
.sd-menus { display: flex; gap: 4px; flex: none; }
.sd-m { background: var(--card); box-shadow: inset 0 0 0 1px var(--line); color: var(--text); padding: 0 8px 0 10px; }
.sd-m.room .l { max-width: 150px; overflow: hidden; text-overflow: ellipsis; }
.sd-m .chev { display: inline-grid; transform: rotate(180deg); opacity: .6; margin-left: -1px; }
.sd-m.open { box-shadow: inset 0 0 0 1px var(--accent); }
.sd-m.open .chev { transform: none; }
.sd-m .badge { min-width: 17px; height: 17px; padding: 0 5px; border-radius: 99px; background: var(--warn); color: #1a1205; font-size: 11px; display: inline-grid; place-items: center; }
.sd-fold { width: 30px; padding: 0; justify-content: center; }
.sd-fold svg { transform: none; }
#showdock.min .sd-fold svg { transform: rotate(180deg); }
.sd-noroom { display: flex; align-items: center; gap: 10px; color: var(--dim); font-size: 12.5px; white-space: nowrap; }
.sd-sum { display: flex; align-items: center; gap: 10px; font-size: 12.5px; color: var(--dim); white-space: nowrap; }
.sd-sum b { color: var(--text); }
.sd-sum .sw { width: 9px; height: 9px; border-radius: 3px; }
#showdock.min .sd-air { height: 26px; }
/* floating cards from other parts of the studio (autopilot's React / OBS cards, the tutorial resume chip, the wizard's
   minimised pill, the search jump bar, the import's background note) stand on the dock, never
   over its buttons */
html.vtp-modern { --sd-h: 52px; }
html.vtp-modern body:has(#showdock.min) { --sd-h: 36px; }
html.vtp-modern body:not(.clean) :is(.ap-react, .ap-obs, .tu-resume, .wiz-mini, .pm-jump, .vw-strip) { bottom: calc(var(--sd-h) + 14px) !important; }
html.vtp-modern body:not(.clean) .dimp-bgnote { bottom: calc(var(--sd-h) + 12px) !important; }
/* the dock sits under the panel: Live Control's own bottom margin is not needed any more */
html.vtp-modern body.lc-console:not(.clean) .area-body[data-ui="simple:onair"] { padding-bottom: 10px !important; }
/* Live Control already shows the light, the lights, the mode and the camera: the bar keeps the rest */
body.lc-console #showdock [data-dup] { display: none !important; }   /* (!important: the air light's wrapper is display:contents inline) */
body.lc-console #showdock .sd-grp[data-grp="privacy"] .l { display: inline !important; }
body.lc-console #showdock .sd-cap { display: inline !important; }
body.lc-console #showdock .sd-m .l { display: inline !important; }
/* narrower windows: captions go first, then the mode names (the lit one keeps its name), then the menu names, then the
   camera names; every button keeps its tooltip with the name and the shortcut */
@container sd (max-width: 2000px) { .sd-cap { display: none; } }
@container sd (max-width: 1900px) { .sd-grp[data-grp="mode"] .sd-k:not(.on) .l { display: none; } .sd-grp[data-grp="mode"] .sd-k:not(.on) { padding: 0 8px; } .sd-m.room .l { max-width: 130px; } .sd-m .chev { display: none; } .sd-m { padding: 0 9px; } .sd-k { padding: 0 9px; } }
@container sd (max-width: 1500px) { .sd-grp[data-grp="mode"] .l, .sd-grp[data-grp="privacy"] .l, .sd-m:not(.room) .l { display: none; } .sd-grp:is([data-grp="mode"], [data-grp="privacy"]) .sd-k { padding: 0 8px; } .sd-m:not(.room) { padding: 0 6px 0 8px; } .sd-m.room .l { max-width: 110px; } }
/* the doctor's "Fix it (n)" beside the light (beta.12 autopilot: it counts camera / mic / OBS to set up): the bar compacts
   one step earlier so it still fits without a sideways scroll */
@container sd (max-width: 1900px) { .sd-airg:has(.sd-fix) ~ .sd-grp[data-grp="privacy"] .l { display: none; } .sd-airg:has(.sd-fix) ~ .sd-grp[data-grp="privacy"] .sd-k { padding: 0 8px; } }
@container sd (max-width: 1500px) { .sd-airg:has(.sd-fix) ~ .sd-grp[data-grp="camera"] .l { display: none; } }
@container sd (max-width: 1360px) { .sd-grp[data-grp="camera"] .l { display: none; } .sd-k { padding: 0 8px; } }
/* the calm "Next: …" step (autopilot): its words fold away first when the bar is short (the tooltip keeps them) */
@container sd (max-width: 1500px) { .sd-k.sd-next .l { display: none; } .sd-k.sd-next { padding: 0 9px; } }
@media (max-width: 900px) {
  html.vtp-modern #showdock { position: fixed; left: var(--rail-w, 48px); right: 0; bottom: 0; z-index: 61; }
  html.vtp-modern body:not(.clean) .area-body { padding-bottom: 72px; }
}
body.clean #showdock { display: none !important; }
/* menus */
.sd-pop { position: fixed; z-index: 70; width: min(420px, calc(100vw - 16px)); overflow-y: auto; overscroll-behavior: contain; background: var(--panel); color: var(--text);
  border: 1px solid var(--line2); border-radius: 14px; padding: 6px 12px 10px; box-shadow: 0 -18px 60px -20px #000c, 0 2px 8px #0003; }
.sd-pop:focus, .sd-pop:focus-visible { outline: none !important; }
body.clean .sd-pop { display: none; }
.sd-head { padding: 8px 0 8px; display: flex; flex-direction: column; gap: 2px; border-bottom: 1px solid var(--line); margin-bottom: 4px; }
.sd-head b { font-size: 14px; }
.sd-head span { font-size: 12px; color: var(--dim); }
.sd-sec { padding: 8px 0 4px; }
.sd-sec h4 { margin: 0 0 7px; font-size: 12px; font-weight: 600; color: var(--dim); letter-spacing: 0; text-transform: none; }
.sd-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.sd-chip { height: 30px; display: inline-flex; align-items: center; gap: 6px; padding: 0 11px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--text);
  font: 600 12.5px/1 Inter, system-ui, sans-serif; cursor: pointer; white-space: nowrap; }
.sd-chip:hover { border-color: var(--line2); background: var(--card2); }
.sd-chip.on { border-color: var(--accent); background: var(--accent-soft); }
.sd-chip.on svg { color: var(--accent); }
.sd-chip.pri { background: var(--accent); border-color: transparent; color: var(--accent-ink); }
.sd-chip.danger { color: var(--err); }
.sd-chip.arm { background: var(--err); color: #fff; border-color: transparent; }
.sd-chip .kbh { font: 600 10.5px/1 ui-monospace, Consolas, monospace; color: var(--faint); margin-left: 2px; }
.sd-line { display: flex; align-items: center; gap: 6px; padding: 3px 0; flex-wrap: wrap; }
.sd-line .who { flex: 1 1 120px; font-weight: 600; display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.sd-line .who small { font-weight: 500; color: var(--faint); }
.sd-line .talk { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
.sd-search { width: 100%; height: 34px; margin: 6px 0 4px; padding: 0 12px; border-radius: 9px; border: 1px solid var(--line2); background: var(--input); color: var(--text); font: inherit; }
.sd-rooms { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 6px; padding: 6px 0 4px; }
.sd-room { display: flex; flex-direction: column; gap: 5px; padding: 4px 4px 6px; border-radius: 9px; border: 1px solid var(--line); background: var(--card); color: var(--text); cursor: pointer; text-align: left; font: 600 12px/1.25 Inter, system-ui, sans-serif; min-width: 0; }
.sd-room:hover { border-color: var(--line2); }
.sd-room.on { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.sd-room .th { aspect-ratio: 16 / 9; border-radius: 6px; background: var(--card2); overflow: hidden; display: grid; place-items: center; color: var(--faint); }
.sd-room .th { position: relative; }
.sd-room .th img { width: 100%; height: 100%; object-fit: cover; display: block; }
.sd-room .star { position: absolute; top: 3px; left: 4px; font-style: normal; color: #ffcf4a; text-shadow: 0 1px 2px #000a; font-size: 13px; }
.sd-room .nm { padding: 0 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sd-empty, .sd-note { color: var(--dim); font-size: 12.5px; margin: 2px 0 8px; }
.sd-foot { margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--line); display: flex; flex-direction: column; }
.sd-row { display: flex; align-items: center; gap: 10px; padding: 7px 6px; border: 0; border-radius: 8px; background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.sd-row:hover { background: var(--card); }
.sd-row svg { color: var(--dim); flex: none; }
.sd-row b { display: block; font-size: 12.5px; }
.sd-row small { display: block; color: var(--dim); font-size: 11.5px; margin-top: 1px; }
/* tooltip: inverted, so it reads on the stage, the panel and both themes */
.sd-tip { position: fixed; z-index: 72; max-width: 280px; padding: 8px 10px; border-radius: 9px; background: var(--text); color: var(--bg); font-size: 12px; line-height: 1.4; pointer-events: none;
  box-shadow: 0 8px 24px #0006; display: flex; flex-direction: column; gap: 3px; }
.sd-tip[hidden] { display: none; }
.sd-tip b { font-size: 12.5px; }
.sd-tip span { opacity: .82; }
.sd-tip .kb { opacity: 1; display: flex; gap: 3px; align-items: center; margin-top: 2px; }
.sd-tip kbd { font: 600 11px/1 Inter, system-ui, sans-serif; padding: 3px 6px; border-radius: 5px; background: color-mix(in srgb, var(--bg) 16%, transparent); border: 1px solid color-mix(in srgb, var(--bg) 35%, transparent); }
`;
