// The visual room picker (Room area, Scene tab, the room helper): the current room as a strip with its picture, and a
// "Change room" drawer of picture cards grouped by world (roomWorlds.ts), with search, world filters, ⭐ favourites, a
// Recent row, TTRPG tables as a 🎲 chip on their room's card (not cards of their own), test / WIP rooms behind a switch,
// arrow-key navigation, and a big gallery over the 3D view (⤢) for when the side panel feels small.
// Picking a card = S.setScene (the room-change transition plays as usual). A 🎲 chip = the TTRPG mode's own path
// (gamesHub.ts openTable). Favourites / recents / switches are per browser (localStorage, every access wrapped).
import { noteRecentRoom, recentRooms, roomFavorites, toggleFavoriteRoom } from '../net/roomPrefs.ts';
import type { App } from '../app.ts';
import type { SceneInfo } from '../../shared/types.ts';
import { roomPickId } from '../../shared/curtain.ts';
import { h, toast } from './dom.ts';
import { catalogue, matches, tableName, type Catalogue, type RoomEntry, type WorldDef } from './roomWorlds.ts';
import { openTable } from './gamesHub.ts';

export type PickerWhere = 'simple' | 'adv' | 'wizard';
export interface PickerOpts {
  where: PickerWhere;
  /** Drawer always open (the room helper). */
  alwaysOpen?: boolean;
  /** Show the Rescan button (asks the server for the room list again). */
  rescan?: boolean;
  /** After a room was picked. */
  onPick?: (id: string | null) => void;
}

// ---------------------------------------------------------------- per-browser memory (never throws)
const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v) as T; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage off / private window */ } },
};
const OPEN = 'vtp.rooms.open', TESTS = 'vtp.rooms.tests'; // (favourites: 'vtp.rooms.fav' was the old per-browser list)
// beta.12: favourites + recent rooms live in the helper (src/net/roomPrefs.ts: every tab, Live Control and the show dock
// share them; this browser's old vtp.rooms.fav / vtp.rooms.recent lists are brought in once)
const favs = (): string[] => roomFavorites();
const recents = (): (string | null)[] => recentRooms();
function toggleFav(id: string) { void toggleFavoriteRoom(id).catch(() => { /* retried by roomPrefs */ }); }
let lastSeen: string | null | undefined;
/** Remember a room as recently used (newest first, 5 kept; the table rooms count as their parent). */
function noteRecent(id: string | null) { void noteRecentRoom(id).catch(() => { /* retried by roomPrefs */ }); }

const ui = {
  open: store.get<Record<string, boolean>>(OPEN, {}),
  tests: store.get<boolean>(TESTS, false) === true,
  q: '',
  world: 'all',
};

// ---------------------------------------------------------------- styles
const PICKER_CSS = `
.rp { --rp-gap: 8px; --rp-cols: 3; margin-bottom: 12px; }
.rp-results { display: grid; grid-template-columns: repeat(var(--rp-cols), minmax(0, 1fr)); column-gap: var(--rp-gap); align-items: start; }
.rp-results > .rp-classic, .rp-results > .rp-empty { grid-column: 1 / -1; }
.rp-cur { display: grid; grid-template-columns: 104px 1fr; gap: 10px; align-items: center; padding: 8px; border-radius: 14px; background: var(--card); border: 1px solid var(--line); }
.rp-cur .th { width: 104px; aspect-ratio: 16/9; border-radius: 9px; overflow: hidden; border: 0; padding: 0; cursor: pointer; background: var(--card2); display: grid; place-items: center; font-size: 22px; color: var(--faint); position: relative; }
.rp-cur .th img { width: 100%; height: 100%; object-fit: cover; display: block; }
.rp-cur .th.classic, .rp-card .th.classic { background: repeating-conic-gradient(var(--card3) 0 25%, var(--card2) 0 50%) 0 0/12px 12px; }
.rp-cur .meta { min-width: 0; }
.rp-cur .w { display: flex; align-items: center; gap: 6px; color: var(--dim); font-size: 11.5px; font-weight: 600; }
.rp-cur .nm { font-weight: 700; font-size: 14px; line-height: 1.25; margin: 1px 0 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rp-cur .acts { grid-column: 1 / -1; display: flex; gap: 6px; align-items: center; }
.rp-cur .acts .grow { flex: 1; }
.rp-toggle[aria-expanded=true] { background: var(--accent-soft); border-color: transparent; color: var(--accent); }
.rp-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: hsl(var(--wh, 220) 62% 58%); box-shadow: 0 0 0 2px hsl(var(--wh, 220) 62% 58% / .18); }
.rp-badges { display: flex; gap: 3px; flex-wrap: wrap; font-size: 12px; line-height: 1; }
.rp-badges span { cursor: default; }
.rp-drawer { margin-top: 8px; padding: 10px; border-radius: 14px; background: var(--card); border: 1px solid var(--line); }
.rp-tools { display: flex; gap: 6px; align-items: center; }
.rp-tools input[type=search] { flex: 1; min-width: 0; padding: 7px 10px 7px 30px; border-radius: 10px; background: var(--input) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23889' stroke-width='2.2' stroke-linecap='round'%3E%3Ccircle cx='11' cy='11' r='7'/%3E%3Cpath d='m20 20-3.5-3.5'/%3E%3C/svg%3E") no-repeat 10px 50%; }
.rp-worlds { display: flex; gap: 5px; overflow-x: auto; padding: 8px 1px 4px; scrollbar-width: none; -webkit-mask-image: linear-gradient(90deg, #000 88%, #0000); mask-image: linear-gradient(90deg, #000 88%, #0000); }
.rp-worlds::-webkit-scrollbar { display: none; }
.rp-over .rp-worlds { flex-wrap: wrap; -webkit-mask-image: none; mask-image: none; }
.rp-worlds button { flex: none; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line2); background: var(--card2); color: var(--dim); font: inherit; font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 99px; cursor: pointer; }
.rp-worlds button:hover { color: var(--text); border-color: var(--faint); }
.rp-worlds button.on { background: var(--text); color: var(--bg); border-color: transparent; }
.rp-worlds button.on .rp-dot { box-shadow: none; }
.rp-grp { margin-top: 10px; display: grid; grid-template-columns: subgrid; grid-column: span var(--span, 1); min-width: 0; }
.rp-grp > .gh { grid-column: 1 / -1; display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; color: var(--text); margin: 0 0 6px; min-width: 0; white-space: nowrap; }
.rp-grp > .gh .t { overflow: hidden; text-overflow: ellipsis; }
.rp-grp > .gh .n { color: var(--faint); font-weight: 600; }
.rp-grid { grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; row-gap: var(--rp-gap); }
.rp-pick.rp-classic { flex-direction: row; flex: none; display: flex; align-items: center; gap: 9px; width: 100%; margin-top: 10px; padding: 5px 10px 5px 5px; border-radius: 11px; border: 1px solid var(--line); background: var(--card2); color: var(--text); font: inherit; font-size: 12.5px; font-weight: 650; cursor: pointer; text-align: left; }
.rp-pick.rp-classic:hover { border-color: var(--line2); }
.rp-pick.rp-classic.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.rp-classic .th { width: 44px; height: 25px; border-radius: 6px; flex: none; background: repeating-conic-gradient(var(--card3) 0 25%, var(--card) 0 50%) 0 0/8px 8px; }
.rp-classic small { color: var(--dim); font-weight: 500; margin-left: auto; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.rp-pick.rp-classic { white-space: nowrap; }
.sec .rp-cur, .sec .rp-drawer { background: var(--card2); }
.rp-classic .ok { color: var(--accent); font-weight: 800; }
.rp-card { position: relative; border-radius: 11px; background: var(--card2); border: 1px solid var(--line); overflow: hidden; display: flex; flex-direction: column; }
.rp-card::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 2px; background: hsl(var(--wh, 220) 62% 58%); opacity: .85; z-index: 1; }
.rp-card:hover { border-color: var(--line2); }
.rp-card.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.rp-card.off { opacity: .55; }
.rp-pick { border: 0; padding: 0; margin: 0; background: none; color: var(--text); font: inherit; text-align: left; cursor: pointer; display: flex; flex-direction: column; flex: 1; border-radius: 11px; }
.rp-pick:disabled { cursor: not-allowed; }
.rp-pick:focus-visible { outline-offset: -2px; }
.rp-card .th { width: 100%; aspect-ratio: 16/9; display: grid; place-items: center; background: radial-gradient(circle at 50% 40%, var(--card3), var(--card2)); font-size: 20px; color: var(--faint); position: relative; }
.rp-card .th img { width: 100%; height: 100%; object-fit: cover; display: block; }
.rp-card .nm { margin: 5px 7px 6px; font-size: 11.5px; font-weight: 650; line-height: 1.25; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; min-height: 2.5em; max-height: 2.5em; }
.rp-card .nm.two { display: block; -webkit-line-clamp: unset; }
.rp-card .nm.two small { display: block; font-size: 10.5px; font-weight: 600; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.2; }
.rp-card .nm.two { white-space: nowrap; text-overflow: ellipsis; }
.rp-card .ft { display: flex; align-items: center; gap: 4px; padding: 0 6px 6px 7px; margin-top: -2px; }
.rp-card .ft .rp-badges { flex: 1; min-width: 0; }
.rp-card .check { position: absolute; top: 5px; left: 5px; width: 18px; height: 18px; border-radius: 50%; background: var(--accent); color: var(--accent-ink); display: grid; place-items: center; font-size: 11px; font-weight: 800; z-index: 2; }
.rp-star { position: absolute; top: 4px; right: 4px; width: 24px; height: 24px; border-radius: 8px; border: 0; background: #0009; color: #fff; font-size: 13px; line-height: 1; cursor: pointer; display: grid; place-items: center; opacity: 0; transition: opacity .12s; }
.rp-card:hover .rp-star, .rp-card:focus-within .rp-star, .rp-star.on { opacity: 1; }
.rp-star.on { color: #ffd166; }
.rp-thz { position: absolute; left: 0; right: 0; top: 0; aspect-ratio: 16/9; pointer-events: none; z-index: 2; }
.rp-thz > * { pointer-events: auto; }
.rp-tbl { position: absolute; right: 4px; bottom: 4px; border: 1px solid #ffffff30; background: #140a18d9; color: #fff; font: inherit; font-size: 10.5px; font-weight: 700; padding: 1px 6px; border-radius: 99px; cursor: pointer; white-space: nowrap; }
.rp-tbl:hover { background: #3a1433; border-color: #ff7ac8; }
.rp-tbl.on { background: var(--pink); color: #1a0612; border-color: transparent; }
.rp-tbl:disabled { opacity: .5; cursor: not-allowed; }
.rp-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line); }
.rp-foot .grow { flex: 1; }
.rp-sw { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; color: var(--dim); cursor: pointer; user-select: none; }
.rp-sw .switch { width: 30px; height: 17px; }
.rp-sw .switch i::after { width: 11px; height: 11px; }
.rp-sw .switch input:checked + i::after { left: 16px; }
.rp-empty { text-align: center; color: var(--dim); padding: 18px 8px 8px; font-size: 12.5px; }
.rp-over { position: fixed; inset: 0; z-index: 55; background: #05070bcc; backdrop-filter: blur(3px); display: grid; place-items: center; padding: 24px; }
.rp-over > .rp-drawer { width: min(1180px, 100%); max-height: calc(100vh - 48px); overflow-y: auto; margin: 0; padding: 16px 18px; background: var(--panel); border-color: var(--line2); box-shadow: 0 24px 80px #000a; }
.rp-over .rp { --rp-gap: 12px; }
.rp-over .rp-card .nm { font-size: 13px; }
.rp-over .rp-badges { font-size: 14px; }
.rp-over .rp-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.rp-over .rp-head h3 { margin: 0; font-size: 18px; flex: 1; }
@media (prefers-reduced-motion: reduce) { .rp-star { transition: none; } }
`;
let cssDone = false;

// ---------------------------------------------------------------- the component
const CLASSIC = '__classic__';
const hueStyle = (w: WorldDef) => `--wh:${w.hue}`;
/** Area chips (rooms with several locations): under the current-room strip and on the room's card. */
const AREA_CSS = `
.rp-areas { display: flex; flex-wrap: wrap; gap: 4px; }
.rp-areas.cur { margin: 6px 2px 0; }
.rp-areas.card { padding: 0 6px 5px 7px; }
.rp-area { border: 1px solid hsl(var(--wh, 220) 40% 60% / .45); background: hsl(var(--wh, 220) 30% 16% / .7); color: inherit; font: inherit; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 99px; cursor: pointer; white-space: nowrap; }
.rp-areas.card .rp-area { font-size: 10px; padding: 1px 6px; }
.rp-area:hover:not(:disabled) { border-color: hsl(var(--wh, 220) 70% 65%); background: hsl(var(--wh, 220) 40% 24%); }
.rp-area.on { background: hsl(var(--wh, 220) 62% 58%); color: #08101a; border-color: transparent; }
.rp-area:disabled { opacity: .5; cursor: not-allowed; }
`;
const badges = (e: RoomEntry, max = 4) => e.badges.length ? h('span', { class: 'rp-badges', 'aria-label': e.badges.map((b) => b.label).join(', ') },
  ...e.badges.slice(0, max).map((b) => h('span', { title: b.label, 'aria-hidden': 'true' }, b.icon)), e.badges.length > max ? h('span', { title: e.badges.slice(max).map((b) => b.label).join(', ') }, '…') : null) : null;

/** "Customs — Dorms Lounge" → a dim "Customs" line over "Dorms Lounge" (fits a narrow card); plain names stay one block. */
function nameOf(t: string) {
  const p = t.split(/\s+[—–]\s+|\s+-\s+/);
  return p.length === 2 && p[0].length <= 22 ? h('span', { class: 'nm two' }, h('small', null, p[0]), p[1]) : h('span', { class: 'nm' }, t);
}

/** The picker. Build it inside a panel's build function (it re-reads the room list and state every time). */
export function roomPicker(app: App, o: PickerOpts): HTMLElement {
  if (!cssDone) { document.head.append(h('style', { id: 'rp-css' }, PICKER_CSS)); cssDone = true; }
  if (!document.getElementById('rp-area-css')) document.head.append(h('style', { id: 'rp-area-css' }, AREA_CSS));
  const root = h('div', { class: 'rp', 'data-rp': o.where });
  draw(app, root, o, false);
  return root;
}

function draw(app: App, root: HTMLElement, o: PickerOpts, big: boolean) {
  const S = app.scene, st = S.effective, edit = S.canEdit;
  const cat = catalogue(S.scenes);
  const curId = st.sceneId ?? null;
  // the card that stands for what's on screen (a table room → its room's card)
  const curCard = curId ? cat.tableOf.get(curId) ?? cat.areaOf.get(curId) ?? curId : null;
  if (lastSeen !== curCard) { if (lastSeen !== undefined) noteRecent(curCard); lastSeen = curCard; }
  const atTable = !!curId && cat.tableOf.has(curId);
  const open = big || o.alwaysOpen || !!ui.open[o.where];
  const redraw = () => { if (big) { root.replaceChildren(); draw(app, root, o, true); } else { root.replaceChildren(); draw(app, root, o, false); } };
  // the room list is still loading: redraw this picker by itself once it arrives (the panel may be waiting on a focused box)
  if (!S.scenes.length) { const off = S.on(() => { if (!S.scenes.length) return; off(); if (root.isConnected) redraw(); }); }
  const pick = (id: string | null) => {
    if (!edit) return;
    // (the room - or the area of it - already set, picked again = a retry of THAT id for any page whose room did not load;
    // the checked card never switches a room's area back to its default one)
    const pk = roomPickId(id, curId, curCard, atTable);
    if (pk.retry) { if (pk.id) S.setScene(pk.id); if (!o.alwaysOpen && !big) { ui.open[o.where] = false; store.set(OPEN, ui.open); } closeBig(); redraw(); return; }
    const info = id ? S.scenes.find((x) => x.id === id) : null;
    if (id && info?.ready === false) { toast(`${info.name} isn’t built yet`, 'warn'); return; }
    if ((st.mode as string) === 'ttrpg' && atTable) S.setMode('talk');     // leave the table first (the mode takes everyone back)
    S.setScene(id);
    noteRecent(id); lastSeen = id;
    if (!o.alwaysOpen) { ui.open[o.where] = false; store.set(OPEN, ui.open); }
    closeBig();
    o.onPick?.(id);
    if (root.isConnected) redraw();
  };
  // rooms with areas (shared/roomId.ts): go to one area of a room (the default area's id is the card's own id, so this
  // doesn't go through pick()'s "that's the room already showing" shortcut)
  const goArea = (id: string) => {
    if (!edit) return;
    if (id === curId) { S.setScene(id); return; }   // (the area on screen: a retry if it did not load)
    if ((st.mode as string) === 'ttrpg' && atTable) S.setMode('talk');
    S.setScene(id);
    noteRecent(cat.areaOf.get(id) ?? id); lastSeen = cat.areaOf.get(id) ?? id;
    closeBig();
    o.onPick?.(id);
    if (root.isConnected) redraw();
  };
  const areaChips = (e: RoomEntry, cls: string) => h('div', { class: `rp-areas ${cls}`, role: 'group', 'aria-label': `Areas of ${e.title}` },
    ...e.areas.map((a) => h('button', { class: `rp-area ${a.id === curId ? 'on' : ''}`, 'aria-pressed': String(a.id === curId), disabled: !edit || e.info.ready === false,
      title: a.id === curId ? `Here now: ${a.name}` : `Go to ${a.name} (the transition covers the move)`, onClick: () => goArea(a.id) }, a.icon ? `${a.icon} ${a.label}` : a.label)));

  // ---- the current room strip (not in the big gallery)
  if (!big) {
    const e = curCard ? cat.byId.get(curCard) ?? null : null;
    const info: SceneInfo | null = curId ? S.scenes.find((x) => x.id === curId) ?? null : null;
    const w = e?.world;
    const toggleBtn = o.alwaysOpen ? null : h('button', { class: 'btn rp-toggle', 'data-tut': 'room-change', 'aria-expanded': String(open && edit), disabled: !edit, title: edit ? 'Show every room (Esc closes)' : 'The host picks the room',
      onClick: () => { ui.open[o.where] = !open; store.set(OPEN, ui.open); redraw(); if (!open) setTimeout(() => (root.querySelector('.rp-tools input') as HTMLInputElement | null)?.focus(), 0); } }, open && edit ? 'Close list' : 'Change room');
    root.append(h('div', { class: 'rp-cur', style: w ? hueStyle(w) : '' },
      h('button', { class: `th ${curId ? '' : 'classic'}`, title: edit ? 'Change room' : '', 'aria-label': 'Change room', disabled: !edit || !!o.alwaysOpen, onClick: () => toggleBtn?.click() },
        info?.thumb || e?.info.thumb ? h('img', { src: (e?.info.thumb ?? info?.thumb)!, alt: '', loading: 'lazy' }) : curId ? '🏠' : null),
      h('div', { class: 'meta' },
        h('div', { class: 'w' }, w ? h('span', { class: 'rp-dot' }) : null, w ? w.label : 'Classic'),
        h('div', { class: 'nm', title: info?.name ?? '' }, e ? e.title : curId ? info?.name ?? curId : 'No room — transparent'),
        atTable ? h('div', { class: 'note', style: 'margin:0;font-size:12px' }, '🎲 At the table: ', h('b', null, tableName(info?.name ?? ''))) : e ? badges(e, 8) : h('div', { class: 'note', style: 'margin:0;font-size:12px' }, 'Just the avatars over your game or desktop.')),
      h('div', { class: 'acts' }, toggleBtn,
        // "Add my room" (src/ui/onboard/roomKind.ts): check a room file, add seats, save it on the user's side
        edit && !o.alwaysOpen ? h('button', { class: 'btn', title: 'Bring your own 3D room (.glb, or .fbx / .blend with VTube Pro)', 'data-ui': 'add-my-room',
          onClick: () => void import('./onboard/roomKind.ts').then((m) => m.openRoomWizard(app, { onDone: () => void S.refreshScenes().then(() => { if (root.isConnected) redraw(); }) })) }, '＋ Add my room') : null,
        h('span', { class: 'grow' }),
        o.rescan ? h('button', { class: 'btn ghost', title: 'Look for new rooms', onClick: () => void S.refreshScenes().then(() => { toast(`${S.scenes.length} rooms`, 'ok', 1500); redraw(); }) }, '↻ Rescan') : null,
        !o.alwaysOpen ? h('button', { class: 'btn ghost', title: 'Big gallery over the 3D view', 'aria-label': 'Open the big room gallery', disabled: !edit, onClick: () => openBig(app, o) }, '⤢') : null)));
    if (e && e.areas.length > 1) root.append(areaChips(e, 'cur'));
    if (!edit) { root.append(h('p', { class: 'note', style: 'margin:6px 2px 0' }, 'You are a guest: the host picks the room.')); return; }
    if (!open) return;
  }

  // ---- the drawer
  const drawer = h('div', { class: 'rp-drawer', 'data-tut': 'room-list', onKeydown: (ev: KeyboardEvent) => keys(ev, root, o, big, redraw) });
  const fav = favs();
  const shown = cat.entries.filter((e) => ui.tests || !e.test || e.info.id === curCard);
  const tests = cat.entries.filter((e) => e.test).length;
  const results = h('div', { class: 'rp-results' });
  const search = h('input', { type: 'search', class: 'rp-q', placeholder: 'Search rooms, worlds, features…', value: ui.q, 'aria-label': 'Search rooms',
    onInput: (ev: Event) => { ui.q = (ev.target as HTMLInputElement).value; paintResults(); },
    onKeydown: (ev: KeyboardEvent) => {
      if (ev.key === 'ArrowDown' || (ev.key === 'Enter' && ui.q)) { const first = results.querySelector<HTMLButtonElement>('.rp-pick:not(:disabled)'); if (first) { ev.preventDefault(); if (ev.key === 'Enter') first.click(); else first.focus(); } }
    } }) as HTMLInputElement;
  const worlds = h('div', { class: 'rp-worlds', role: 'toolbar', 'aria-label': 'Filter by world' });
  const paintWorlds = () => {
    const list: [string, string, WorldDef | null][] = [['all', 'All', null]];
    if (fav.length) list.push(['fav', '⭐ Favourites', null]);
    for (const w of cat.worlds) if (w.id !== 'test' || ui.tests) if (shown.some((e) => e.world.id === w.id)) list.push([w.id, w.label, w]);
    if (!list.some(([id]) => id === ui.world)) ui.world = 'all';
    worlds.replaceChildren(...list.map(([id, label, w]) => h('button', { class: ui.world === id ? 'on' : '', 'aria-pressed': String(ui.world === id), style: w ? hueStyle(w) : '',
      onClick: () => { ui.world = id; paintWorlds(); paintResults(); } }, w ? h('span', { class: 'rp-dot' }) : null, label)));
  };
  const card = (e: RoomEntry | null): HTMLElement => {
    const id = e ? e.info.id : null;
    const on = e ? id === curCard : curId === null;
    const ready = !e || e.info.ready !== false;
    const isFav = !!id && fav.includes(id);
    const tableOn = on && (atTable || !!st.ttrpg?.on);
    const title = e ? `${e.info.name}${!ready ? ' — not built yet' : ''}${e.badges.length ? `\n${e.badges.map((b) => `${b.icon} ${b.label}`).join('\n')}` : ''}${e.table ? `\n🎲 Tabletop: ${tableName(e.table.name)}` : ''}` : 'No room: the classic transparent look (just the avatars)';
    return h('div', { class: `rp-card ${on ? 'on' : ''} ${ready ? '' : 'off'}`, style: e ? hueStyle(e.world) : '--wh:220', 'data-rid': id ?? CLASSIC },
      h('button', { class: 'rp-pick', disabled: !ready, title, 'aria-current': on ? 'true' : 'false', 'aria-label': `${e ? e.info.name : 'No room'}${on ? ' (showing now)' : ''}`, onClick: () => pick(id) },
        h('span', { class: `th ${e ? '' : 'classic'}` }, e?.info.thumb ? h('img', { src: e.info.thumb, alt: '', loading: 'lazy', draggable: false }) : e ? '🏠' : null),
        nameOf(e ? e.title : 'No room (transparent)')),
      on ? h('span', { class: 'check', 'aria-hidden': 'true' }, '✓') : null,
      h('div', { class: 'rp-thz' },
      id ? h('button', { class: `rp-star ${isFav ? 'on' : ''}`, title: isFav ? 'Remove from favourites (F)' : 'Add to favourites (F)', 'aria-label': isFav ? `Remove ${e!.title} from favourites` : `Add ${e!.title} to favourites`, 'aria-pressed': String(isFav),
        onClick: () => { toggleFav(id); redraw(); } }, isFav ? '★' : '☆') : null,
        e?.table ? h('button', { class: `rp-tbl ${tableOn ? 'on' : ''}`, disabled: e.table.ready === false || !ready,
          title: tableOn ? `You're at the table: ${tableName(e.table.name)}` : `Open the tabletop game here: everyone walks to ${tableName(e.table.name)} (TTRPG mode)`,
          onClick: () => { if (tableOn) { toast('Already at the table — the TTRPG panel has the dice and the story', 'info', 2400); openTable(app, id); return; } closeBig(); openTable(app, id); noteRecent(id); lastSeen = id; if (root.isConnected) redraw(); } }, '🎲 table') : null),
      e && e.areas.length > 1 ? areaChips(e, 'card') : null,
      e && e.badges.length ? h('div', { class: 'ft' }, badges(e)) : null);
  };
  const classicRow = () => h('button', { class: `rp-classic rp-pick ${curId === null ? 'on' : ''}`, 'data-rid': CLASSIC, 'aria-current': curId === null ? 'true' : 'false', title: 'No room: the classic transparent look (just the avatars, party side by side)', onClick: () => pick(null) },
    h('span', { class: 'th', 'aria-hidden': 'true' }), 'No room', curId === null ? h('span', { class: 'ok', 'aria-hidden': 'true' }, '✓') : null, h('small', null, 'transparent, avatars only'));
  // (small worlds share a row: each group spans as many columns as it has cards — CSS subgrid)
  const cols = big ? bigCols() : o.where === 'wizard' ? 5 : 3;       // (the room helper's page is wider than the side panel)
  if (cols !== 3) root.style.setProperty('--rp-cols', String(cols));
  const group = (label: string, list: (RoomEntry | null)[], w: WorldDef | null, wide = false) => h('section', { class: 'rp-grp', style: `${w ? hueStyle(w) + ';' : ''}--span:${wide ? cols : Math.min(cols, Math.max(1, list.length))}`, 'aria-label': label, title: list.length === 1 ? label : '' },
    h('div', { class: 'gh' }, w ? h('span', { class: 'rp-dot' }) : null, h('span', { class: 't' }, list.length > 1 || !w ? label : w.label), list.length > 1 ? h('span', { class: 'n' }, String(list.length)) : null),
    h('div', { class: 'rp-grid' }, ...list.map(card)));
  const paintResults = () => {
    const q = ui.q.trim();
    const hit = shown.filter((e) => matches(e, q) && (ui.world === 'all' || (ui.world === 'fav' ? fav.includes(e.info.id) : e.world.id === ui.world)));
    const out: HTMLElement[] = [];
    if (!q && ui.world === 'all') {
      const rec = recents().filter((id, i, a) => a.indexOf(id) === i && id !== curCard).map((id) => (id === null ? null : cat.byId.get(id) ?? undefined)).filter((x): x is RoomEntry | null => x !== undefined && (x === null || !x.test || ui.tests)).slice(0, 4);
      if (rec.length) out.push(group('Recent', rec, null, true));
      const favList = fav.map((id) => cat.byId.get(id)).filter((x): x is RoomEntry => !!x && (!x.test || ui.tests));
      if (favList.length) out.push(group('⭐ Favourites', favList, null, true));
      out.push(classicRow());
    }
    for (const w of cat.worlds) {
      const list = hit.filter((e) => e.world.id === w.id);
      if (list.length) out.push(group(`${w.icon} ${w.label}`, list, w));
    }
    if (q && /^(no|none|classic|transparent)/i.test(q)) out.unshift(classicRow());
    if (!S.scenes.length) { results.replaceChildren(h('div', { class: 'rp-empty' }, 'Looking for rooms…')); return; }
    if (!out.length) out.push(h('div', { class: 'rp-empty' }, h('b', null, `No rooms match “${q}”.`), h('br'), 'Try a world name or a feature like weather, kitchen, space.',
      h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn', onClick: () => { ui.q = ''; ui.world = 'all'; search.value = ''; paintWorlds(); paintResults(); search.focus(); } }, 'Clear the search'))));
    results.replaceChildren(...out);
  };
  paintWorlds(); paintResults();
  const testSw = h('input', { type: 'checkbox', checked: ui.tests, onChange: (ev: Event) => { ui.tests = (ev.target as HTMLInputElement).checked; store.set(TESTS, ui.tests); redraw(); } });
  if (big) drawer.append(h('div', { class: 'rp-head' }, h('h3', null, 'Pick a room'), h('span', { class: 'note', style: 'margin:0' }, 'Arrow keys move · Enter switches · F favourites · Esc closes'), h('button', { class: 'icon-btn', 'aria-label': 'Close', title: 'Close (Esc)', onClick: () => closeBig() }, '✕')));
  drawer.append(h('div', { class: 'rp-tools' }, search), worlds, results,
    h('div', { class: 'rp-foot' },
      tests ? h('label', { class: 'rp-sw', title: 'Grey boxes, test yards and work-in-progress rebuilds' }, h('span', { class: 'switch' }, testSw, h('i')), `Show test rooms (${tests})`) : null,
      h('span', { class: 'grow' }),
      !big ? h('span', { class: 'note', style: 'margin:0;font-size:11.5px' }, '↑↓←→ move · F ★') : null));
  root.append(drawer);
}

// ---------------------------------------------------------------- keyboard: arrows move between cards, F = favourite, / = search, Esc closes
function keys(ev: KeyboardEvent, root: HTMLElement, o: PickerOpts, big: boolean, redraw: () => void) {
  const t = ev.target as HTMLElement;
  if (ev.key === 'Escape') {
    if (big) { ev.preventDefault(); closeBig(); return; }
    if (!o.alwaysOpen && ui.open[o.where]) { ev.preventDefault(); ui.open[o.where] = false; store.set(OPEN, ui.open); redraw(); (root.querySelector('.rp-toggle') as HTMLElement | null)?.focus(); }
    return;
  }
  if (ev.key === '/' && !(t instanceof HTMLInputElement)) { ev.preventDefault(); (root.querySelector('.rp-q') as HTMLInputElement | null)?.focus(); return; }
  if (!t.classList.contains('rp-pick')) return;
  if (ev.key === 'f' || ev.key === 'F') {
    const id = t.closest<HTMLElement>('.rp-card')?.dataset.rid;
    if (id && id !== CLASSIC) {
      ev.preventDefault();
      const same = () => [...root.querySelectorAll<HTMLElement>(`.rp-card[data-rid="${CSS.escape(id)}"] .rp-pick`)];
      const grp = t.closest('.rp-grp')?.getAttribute('aria-label');
      toggleFav(id); redraw();
      (same().find((b) => b.closest('.rp-grp')?.getAttribute('aria-label') === grp) ?? same()[0])?.focus();
    }
    return;
  }
  const all = [...root.querySelectorAll<HTMLButtonElement>('.rp-pick')].filter((b) => b.offsetParent !== null);
  const i = all.indexOf(t as HTMLButtonElement);
  if (i < 0) return;
  let next: HTMLButtonElement | undefined;
  if (ev.key === 'ArrowRight') next = all[i + 1];
  else if (ev.key === 'ArrowLeft') next = all[i - 1];
  else if (ev.key === 'Home') next = all[0];
  else if (ev.key === 'End') next = all[all.length - 1];
  else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    const r = t.getBoundingClientRect(), cx = r.left + r.width / 2, down = ev.key === 'ArrowDown';
    let best = Infinity;
    for (const b of all) {
      const q = b.getBoundingClientRect();
      const dy = down ? q.top - r.bottom : r.top - q.bottom;
      if (dy < -2) continue;
      const score = dy * 4 + Math.abs(q.left + q.width / 2 - cx);
      if (score < best) { best = score; next = b; }
    }
    if (!next && !down) { ev.preventDefault(); (root.querySelector('.rp-q') as HTMLInputElement | null)?.focus(); return; }
  } else return;
  if (next) { ev.preventDefault(); next.focus(); next.scrollIntoView({ block: 'nearest' }); }
}

// ---------------------------------------------------------------- the big gallery (over the 3D view)
const bigCols = () => (innerWidth > 1700 ? 7 : innerWidth > 1300 ? 6 : innerWidth > 1000 ? 5 : innerWidth > 700 ? 4 : 2);
let over: { el: HTMLElement; off: () => void } | null = null;
function closeBig() { if (!over) return; const o = over; over = null; o.off(); o.el.remove(); }
function openBig(app: App, o: PickerOpts) {
  closeBig();
  const box = h('div', { class: 'rp' });
  const el = h('div', { class: 'rp-over', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Pick a room', onClick: (e: Event) => { if (e.target === el) closeBig(); } }, box);
  const paint = () => { box.replaceChildren(); draw(app, box, { ...o, onPick: (id) => { o.onPick?.(id); document.dispatchEvent(new CustomEvent('vtp-refresh')); } }, true); };
  paint();
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && over) { e.stopPropagation(); e.preventDefault(); closeBig(); } };
  window.addEventListener('keydown', onKey, true);
  const offScene = app.scene.on((what) => { if (what === 'state') { const f = document.activeElement as HTMLElement | null; const rid = f?.closest<HTMLElement>('.rp-card')?.dataset.rid; if (!(f instanceof HTMLInputElement)) { paint(); if (rid) box.querySelector<HTMLElement>(`.rp-card[data-rid="${CSS.escape(rid)}"] .rp-pick`)?.focus(); } } });
  over = { el, off: () => { window.removeEventListener('keydown', onKey, true); offScene?.(); } };
  document.body.append(el);
  setTimeout(() => (box.querySelector('.rp-q') as HTMLInputElement | null)?.focus(), 0);
}

/** For tests / other panels: the grouping the picker shows. */
export function roomCatalogue(scenes: SceneInfo[]): Catalogue { return catalogue(scenes); }
