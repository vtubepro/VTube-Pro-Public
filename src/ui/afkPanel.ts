// Scene tab → "AFK / Starting soon": the cinematic AFK mode (the camera tours the room, cutting to landings, launches and
// kills — src/scene/afk) and chatter names on the ships. Part of the host's scene state, so every OBS page and party guest
// shows the same tour and the same names. Also: the bus / MCP command scene {afk}, POST /api/scene/afk. No default key (a
// Shift+letter would take a key people have bound to their models); the Stream Deck / the bus command do the same.
import type { App } from '../app.ts';
import { AFK_CREW_MAX, liveCrew, type AfkNames, type AfkOverlay, type AfkPace } from '../../shared/afk.ts';
import { button, h, rerender, section, select, toggle } from './dom.ts';

const CSS = `
.afk-bar { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin:6px 0 10px; }
.afk-bar .note { flex:1 1 100%; margin:0; }
.afk-bar .btn { font-weight:700; }
.afk-bar .btn.on { background:#F5A623; color:#1a1204; border-color:transparent; }
.afk-crew { display:flex; flex-wrap:wrap; gap:4px; margin:4px 0 6px; }
.afk-crew span { padding:1px 8px; border-radius:10px; background:#1d1a14; border:1px solid #5a4516; color:#F5A623; font-size:11px; }
`;
let cssDone = false;
const css = () => { if (!cssDone) { document.head.append(h('style', null, CSS)); cssDone = true; } };

/** The one-click toggle for the top of the Scene tab (next to the lighting states). */
export function afkBar(app: App, note = true): HTMLElement {
  css();
  const S = app.scene, on = S.afk.on;
  const b = button(on ? '🎬 AFK cinematic — on (click to end)' : '🎬 Go AFK', () => S.toggleAfk(), on ? 'on' : '');
  b.title = 'The camera tours the room — the full ship, the flight deck, the battle — and cuts to landings, launches and kills; chatter names ride on the ships. Stream Deck: POST http://127.0.0.1:5191/api/scene/afk';
  (b as HTMLButtonElement).disabled = !S.canEdit;
  return h('div', { class: 'afk-bar' }, b);
}

export function afkSection(app: App): HTMLElement {
  css();
  const S = app.scene;
  const box = h('div');
  const stat = h('p', { class: 'note' });
  const render = () => rerender(box, () => {
    const st = S.afk, edit = S.canEdit;
    const info = S.scenes.find((x) => x.id === S.effective.sceneId) as (Record<string, unknown> & { traffic?: unknown; shipNames?: { enabled?: boolean } }) | undefined;
    const ships = !!info?.traffic && info.shipNames?.enabled !== false;
    const title = select<AfkOverlay>('Title card', st.overlay, [['off', 'Off'], ['brb', 'BE RIGHT BACK'], ['soon', 'STARTING SOON'], ['custom', 'My own text']],
      (v) => S.setAfk({ overlay: v }), 'A lower-third title on the OBS output while AFK is on (off by default)');
    const text = st.overlay === 'custom'
      ? h('label', { class: 'row' }, h('span', { class: 'lbl' }, 'Title text'), h('input', { type: 'text', value: st.text, maxlength: 48, disabled: !edit, placeholder: 'BACK IN 5', onChange: (e: Event) => S.setAfk({ text: (e.target as HTMLInputElement).value }) }))
      : null;
    const names = select<AfkNames>('Chatter names on ships', st.names, [['afk', 'While AFK (default)'], ['always', 'Always'], ['off', 'Never']],
      (v) => S.setAfk({ names: v }), 'Recent chatters’ display names ride on the ships (“Skiff · Maple”) — the same names on every OBS page and for guests');
    const pace = select<AfkPace>('Shot length', st.pace, [['calm', 'Calm — longer shots'], ['normal', 'Normal'], ['snappy', 'Snappy — quicker cuts']], (v) => S.setAfk({ pace: v }));
    const events = toggle('Cut to the action', st.events, (v) => S.setAfk({ events: v }), 'Landings and launches on the pads, kills in the battle: the camera cuts to one that a room camera (or a chase camera behind the ship) sees');
    const hide = toggle('Walk me out while AFK', st.hideHost, (v) => S.setAfk({ hideHost: v }), 'Going AFK walks you out of the room; ending it walks you back in (the entrance camera follows you in). Off: your avatar stays in its seat');
    const block = h('input', { type: 'text', value: S.afkBlock().join(', '), placeholder: 'words, never on a ship', disabled: !edit, style: 'width:100%',
      onChange: (e: Event) => S.setAfkBlock((e.target as HTMLInputElement).value.split(',')) }) as HTMLInputElement;
    for (const el of [title, names, pace, events, hide]) for (const i of el.querySelectorAll('input, select')) if (!edit) (i as HTMLInputElement).disabled = true;
    box.append(...([
      afkBar(app, false),
      stat,
      h('h4', { style: 'margin:10px 0 4px' }, 'On screen'), title, text, pace, events, hide,
      h('h4', { style: 'margin:10px 0 4px' }, 'Names on ships'), names,
      !ships ? h('p', { class: 'note' }, 'This room has no sky traffic, so there are no ships to name (rooms opt in with scene.json traffic / shipNames).') : null,
      liveCrew(st.crew).length ? h('div', { class: 'afk-crew', title: 'The names on the ships now (newest chatters first)' }, ...liveCrew(st.crew).map((c) => h('span', null, c.n))) : h('p', { class: 'note' }, 'No names yet — they appear as people chat (Kick, YouTube, Rumble …).'),
      edit ? h('div', { class: 'btns tight' }, button('Use test names', () => S.afkTestNames()), button('Clear names', () => S.afkClearNames())) : null,
      edit ? h('label', { class: 'row', title: 'A name containing one of these (also spelled with 0/1/3/4/5/@/$) never goes on a ship. This browser only.' }, h('span', { class: 'lbl' }, 'Never show'), block) : null,
      h('p', { class: 'note' }, `Only display names already public in chat are used (never ids), up to ${AFK_CREW_MAX}; bots, the broadcaster, links, deleted messages and banned / timed-out users are left out.`),
      h('p', { class: 'note' }, h('b', null, 'Stream Deck: '), 'System → Website, ', h('code', null, 'POST http://127.0.0.1:5191/api/scene/afk'), ' (no body = toggle; ', h('code', null, '{"on":true,"overlay":"soon"}'), ' …). The raid / kitchen directors and entrance cameras still take over when they have a shot; AFK tours in Talk mode.'),
    ].filter((x): x is HTMLElement => !!x)));
  });
  const renderStat = () => {
    const r = S.report?.afk ?? null;
    const st = S.afk;
    const roomOk = S.report?.room?.id === S.effective.sceneId;
    stat.textContent = !S.effective.sceneId ? 'Pick a room first.'
      : !roomOk || !r ? 'Turn the preview on to see this room’s shots.'
        : `${r.shots.length} shots${r.planned ? '' : ' (measuring what the cameras see…)'}${r.pads.length ? ` · ${r.pads.length} pads` : ''}${r.moments.length ? ` · ${r.moments.length} battle moments` : ''}${r.crafts.length ? ` · ${r.crafts.length} of our craft` : ''}`
          + (st.on ? (r.active ? ` · 🎥 ${r.shot ?? '…'}${r.left !== null ? ` (${r.left}s)` : ''}${r.next ? ` · next: ${r.next.what} in ${r.next.in}s` : ''}` : ' · waiting for Talk mode') : '')
          + (r.tags ? ` · ${r.tags} names on screen` : '');
  };
  app.scene.on((what) => { if (!box.isConnected) return; if (what === 'state') { render(); renderStat(); } else if (what === 'report') renderStat(); });
  render();
  renderStat();
  return section('AFK / Starting soon', box);
}
