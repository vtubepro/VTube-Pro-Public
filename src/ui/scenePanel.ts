// Scene tab: pick the 3D room (or Classic), talk / react mode, camera, who sits where (drag on the spot
// map or use the list), presence, lights placeholder, the react-screen OBS numbers, and a live preview
// (output.html?preview=1 — exactly what OBS renders, driven straight from this page).
import { closePreviewFrame, mountPreviewFrame, previewFrameIn, previewShowsFrom, previewWanted, setPreviewWanted } from './previewFrame.ts';
import type { App } from '../app.ts';
import { HOST_KEY, MAX_SPOTS, defaultSceneState, sanitizeScreen } from '../../shared/scene.ts';
import { SIZE_ICON } from '../../shared/avatarSize.ts';
import type { SceneController, SceneMember } from '../scene/controller.ts';
import { PREVIEW_FPS_KEY, PREVIEW_PAUSE_KEY, PREVIEW_PAUSED_NOTE, previewFpsSetting, previewPauseSetting, type RoomSummary } from '../scene/previewLink.ts';
import { button, clear, h, rerender, section, select, slider, toast, toggle } from './dom.ts';
import { pollPanel } from '../poll/pollPanel.ts';
import { goalsSection } from '../goals/goalsPanel.ts';
import { audiencePanel } from './audiencePanel.ts';
import { lightingBar, lightsSection } from './lightsPanel.ts';
import { djSyncSection } from './djSyncPanel.ts';
import { djDeckSection } from './djDeckPanel.ts';
import { obsSection } from './obsPanel.ts';
import { captureSection } from './capturePanel.ts';
import { chatSection, openChatHub } from './chatPanel.ts';
import { studioNav } from './wizards.ts';
import { raidSection } from './raidPanel.ts';
import { kitchenSection } from './kitchenPanel.ts';
import { clubSection } from './clubPanel.ts';
import { festivalSection } from './festivalPanel.ts';
import { avatarDetailSection, gfxSection } from './gfxPanel.ts';
import { spaceSection } from './spacePanel.ts';
import { envSection } from './envPanel.ts';
import { eraSection } from './eraPanel.ts';
import { transitionsSection } from './transitionsPanel.ts';
import { capcoverSection } from './capcoverPanel.ts';
import { stageSection } from './stagePanel.ts';
import { afkBar, afkSection } from './afkPanel.ts';
import { roomPicker } from './roomPicker.ts';
import { slapSection } from './slapPanel.ts';
import { yachtSection } from './yachtPanel.ts';
import { voyageSection } from './voyagePanel.ts';
import { loungeSection } from './loungePanel.ts';
import { ambientCamSection, screenVideoSection } from './screenVideoPanel.ts';
import { layoutEditor } from './layoutEditor.ts';
import { sceneTop } from './sceneParts.ts';
import { roomEditorButton } from './roomEditor.ts';
import { forScripts } from './forScripts.ts';

const CSS = `
.scn-seg { display:flex; gap:0; margin:2px 0 10px; }
.scn-seg .btn { flex:1; border-radius:0; }
.scn-seg .btn:first-child { border-radius:8px 0 0 8px; } .scn-seg .btn:last-child { border-radius:0 8px 8px 0; }
.scn-seg .btn.on { background: var(--accent2); color:#06131a; border-color:transparent; font-weight:700; }
.scn-map { width:100%; background:#12151b; border:1px solid var(--line); border-radius:8px; touch-action:none; user-select:none; display:block; }
.scn-map .spot { cursor:pointer; }
.scn-map text { font: 600 9px Inter, system-ui, sans-serif; pointer-events:none; }
.scn-list .mrow { display:grid; grid-template-columns: 1fr 104px 30px; gap:6px; align-items:center; margin:3px 0; }
.scn-list .mrow select { width:100%; }
.scn-list .mrow .nm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.scn-list .mrow.sel .nm { color: var(--accent2); font-weight:600; }
.scn-prev { position:relative; width:100%; background:#000 repeating-conic-gradient(#1a1d24 0 25%, #14171c 0 50%) 0 0/16px 16px; border:1px solid var(--line); border-radius:8px; overflow:hidden; }
.scn-prev iframe { position:absolute; inset:0; width:100%; height:100%; border:0; color-scheme:normal; /* no white box behind the see-through page */ }
.scn-prev.big { position:absolute; z-index:30; left:12px; right:12px; top:12px; width:auto; box-shadow:0 10px 40px #000a; }
.scn-rect { overflow-x:auto; font: 12px ui-monospace, Consolas, monospace; background:#12151b; border:1px solid var(--line); border-radius:6px; padding:6px 8px; margin:4px 0; white-space:pre; }
.scn-badge { display:inline-block; padding:1px 7px; border-radius:9px; background:#262c3a; color:var(--dim); font-size:11px; margin-left:6px; }
`;
let cssDone = false;

const canvasSize = (): [number, number] => {
  const w = parseInt(localStorage.getItem('vtp.scene.obsW') || '1920', 10), hh = parseInt(localStorage.getItem('vtp.scene.obsH') || '1080', 10);
  return [Number.isFinite(w) && w > 100 ? w : 1920, Number.isFinite(hh) && hh > 100 ? hh : 1080];
};

/** Which part of the (formerly one) Scene tab to show: the studio areas Room · Show · Chat · Stream split it up
 *  (src/ui/shell.ts); 'all' = everything, as before. */
export type ScenePart = 'all' | 'room' | 'show' | 'chat' | 'stream';

export function scenePanel(app: App, el: HTMLElement, part: ScenePart = 'all') {
  const want = (p: ScenePart) => part === 'all' || part === p;
  const wantPrev = sceneTop(part, false).preview;
  if (!cssDone) { document.head.append(h('style', null, CSS)); cssDone = true; }
  const S = app.scene;
  el.append(h('h2', null, '3D scene'));
  const top = h('div');
  const controls = h('div');
  const prevBox = h('div');
  el.append(top, prevBox, controls);

  // ---------------------------------------------------------------- live preview (persistent iframe)
  let selected: string | null = null;
  let big = localStorage.getItem('vtp.scene.bigPreview') === '1';
  let on = previewWanted();   // (off until the user turns it on: src/ui/previewFrame.ts)
  const frame = h('div', { class: 'scn-prev' });
  const fit = () => { const [w, hh] = canvasSize(); frame.style.aspectRatio = `${w} / ${hh}`; };
  fit();
  const mountPreview = () => {
    clear(frame);
    frame.classList.toggle('big', big);
    const viewport = document.getElementById('viewport');
    if (big && viewport) viewport.append(frame); else prevBox.prepend(frame);
    if (!on) { frame.style.display = 'none'; closePreviewFrame(); dropOrphans(); return; }
    frame.style.display = '';
    // 20 fps + medium tier: the preview shares the main thread + GPU with the face tracker (it also stops drawing while
    // nobody can see it: src/scene/previewLink.ts PreviewGate). One shared frame for the whole studio, moved here
    // without a reload (src/ui/previewFrame.ts); clear() above parked it.
    mountPreviewFrame(frame, null, 'Scene preview', el);
    dropOrphans();
  };
  // (an older panel's "Big" box left over the 3D view — a re-render, an area switch in game mode — goes: never the box
  //  that holds the running preview, which mountPreviewFrame just moved here)
  const dropOrphans = () => document.getElementById('viewport')?.querySelectorAll(':scope > .scn-prev').forEach((b) => { if (b !== frame && !previewFrameIn(b)) b.remove(); });
  S.trackingProbe ??= () => app.trackingOn;
  previewShowsFrom(() => { const S = app.scene, p = app.profile; return `${S.effective.sceneId ?? ''}|${S.members().map((m) => m.key).join(',')}|${p?.id ?? ''}|${p?.costume ?? ''}|${(p?.accessories ?? []).join(',')}`; },
    (changed) => { app.scene.on(changed); app.on((w) => { if (w === 'avatar' || w === 'costume') changed(); }); });
  if (wantPrev) prevBox.append(h('div', { class: 'btns tight' },
    toggleBtn('Preview', on, (v) => { on = v; setPreviewWanted(v); mountPreview(); }),
    toggleBtn('Big', big, (v) => { big = v; localStorage.setItem('vtp.scene.bigPreview', v ? '1' : '0'); mountPreview(); }),
    button('Pop out', () => { const [w, hh] = canvasSize(); window.open('/output.html?preview=1', 'vtp-scene-preview', `width=${Math.round(w / 2)},height=${Math.round(hh / 2)}`); }),
  ), previewSavings());
  if (wantPrev) mountPreview();
  // the layout editor (Show): draws its handles over this preview frame when it is showing
  const layEd = want('show') ? layoutEditor(app, () => (on && frame.isConnected && frame.style.display !== 'none' ? frame : null)) : null;
  if (layEd) prevBox.append(layEd.el);

  // OBS automation keeps its own state (typed-in fields survive the controls re-rendering)
  const obsBox = obsSection(S.observer);
  // Chat & events keeps its own state too (connections, typed-in fields); it re-renders itself on scene changes
  const chatBox = chatSection(app);
  const raidBox = raidSection(app);
  const kitchenBox = kitchenSection(app);
  const clubBox = clubSection(app);
  const spaceBox = spaceSection(app);
  // AFK / starting-soon cinematic mode + names on ships (re-renders itself on scene changes)
  const afkBox = afkSection(app);
  const envBox = envSection(app);
  const eraBox = eraSection(app);
  // room-change transitions (keeps its own state: the style cards' previews)
  const transBox = transitionsSection(app);
  // 📊 chat polls (src/poll/pollPanel.ts; keeps its own state, host only)
  const pollBox = section('📊 Chat poll', pollPanel((m) => toast(m)));
  const audienceBox = section('👥 Chat audience + questions', audiencePanel((m) => toast(m)));   // src/ui/audiencePanel.ts (keeps its own state, host only)
  // capture cover (hides only the game / window capture while a game is set up; keeps its own state)
  const capBox = capcoverSection(app);
  // 🖐 Slap! (the host's minion knocks someone over — src/ui/slapPanel.ts; re-renders itself)
  const slapBox = slapSection(app);
  // 🥂 Yacht life (rooms with a scene.json `yacht` key — src/ui/yachtPanel.ts; hides itself elsewhere)
  const yachtBox = yachtSection(app);
  // walking-ship rooms (scene.json `voyage` - src/ui/voyagePanel.ts; hides itself elsewhere)
  const voyageBox = voyageSection(app);
  // 🥂 Lounge events (rooms with a scene.json `lounge` key — src/ui/loungePanel.ts; hides itself elsewhere)
  const loungeBox = loungeSection(app);

  // ---------------------------------------------------------------- controls (re-rendered on change)
  // rerender() (dom.ts) waits while a slider / the spot map is held, keeps scroll + focus + open sections,
  // and leaves the DOM alone when the rebuild would look the same (e.g. a slider already at its new value)
  const render = () => { if (el.isConnected) rerender([top, controls], build); };
  const build = () => {
    const st = S.effective, edit = S.canEdit;
    const room = st.sceneId ? S.rooms.get(st.sceneId) ?? null : null;
    // (an observer tab says so in every area header now: src/ui/shell.ts; this line only where that header is missing)
    if (S.observer && !document.getElementById('vtp-observer-bar')) top.append(h('p', { class: 'note' }, h('b', null, 'Observer sandbox: '), 'changes stay in this tab (never saved, never sent to OBS or guests).'));
    // each area opens on its own job (src/ui/sceneParts.ts): Room on the room lights, Show & layout on the show mode
    const topParts = sceneTop(part, !!st.sceneId);
    if (topParts.lights) top.append(lightingBar(app));
    if (topParts.lights && edit) top.append(afkBar(app));   // 🎬 Go AFK, next to the lighting states (src/ui/afkPanel.ts)
    if (topParts.showModeFirst) top.append(stageSection(app));
    if (S.role === 'guest') {
      top.append(h('p', { class: 'note' }, 'You are a guest: ', h('b', null, 'the host runs the room'), ' — your OBS follows it.'),
        toggle('Classic on my OBS', S.guestClassic, (v) => S.setGuestClassic(v), 'Show just the avatars (no room) on YOUR OBS; the host and other guests are unaffected'));
    }

    // room picker: the current room + a "Change room" drawer of picture cards grouped by world (src/ui/roomPicker.ts)
    if (want('room')) controls.append(section('Room', roomPicker(app, { where: 'adv', rescan: true }),
      !st.sceneId ? h('p', { class: 'note' }, 'OBS shows the classic transparent layout (party members side by side). Pick a room to put everyone in 3D.') : null));
    if (want('room') && st.sceneId) controls.append(h('div', { class: 'row' }, roomEditorButton(app)));   // Room editor (src/ui/roomEditor.ts, docs/ROOM_EDITOR.md)
    // room prop toggles (scene.json `toggles` / glb extras `toggleGroup`): only rooms that declare some
    const tgl = st.sceneId && want('room') ? S.roomToggles() : [];
    if (tgl.length) controls.append(section('Room props', ...tgl.map((t) => {
      const row = toggle(t.label || t.id, S.toggleOn(t.id), (v) => S.setToggle(t.id, v), `Show or hide this part of the room on every OBS page and for every guest (toggle id "${t.id}"; remembered for this room)`);
      const i = row.querySelector('input'); if (i) i.disabled = !edit;
      return row;
    }), h('p', { class: 'note' }, 'Hide a set on platforms that don’t allow it.'),
      forScripts('Stream Deck: ', h('code', null, `POST /api/scene/toggle {"id":"${tgl[0].id}"}`), ' flips it (or ', h('code', null, '"on":false'), ' / ', h('code', null, 'true'), '); bus / MCP ', h('code', null, `send_command scene {"toggle":{"id":"${tgl[0].id}","on":false}}`), '.')));
    // the show: Talk / React / Gaming (+ registered modes) with their presets (src/ui/stagePanel.ts)
    if (want('show') && !topParts.showModeFirst) controls.append(stageSection(app));
    if (st.sceneId && want('show')) controls.append(capBox);
    if (want('show')) controls.append(transBox);
    if (want('show') && S.role !== 'guest' && !S.observer) controls.append(pollBox, goalsSection(), audienceBox);   // + 🎯 Goals & subathon (src/goals/goalsPanel.ts)
    // (Avatar detail applies to the classic layout too: shown on its own when there is no room)
    if (!st.sceneId) { if (want('room')) controls.append(avatarDetailSection(app)); if (want('stream')) controls.append(obsHelp()); if (part === 'chat') controls.append(chatNoRoom(app)); return; }
    if (part === 'all') controls.append(slapBox);
    if (want('room')) controls.append(yachtBox);
    if (want('room')) controls.append(voyageBox);
    if (want('room')) controls.append(loungeBox);

    // mode + camera
    const seg = h('div', { class: 'scn-seg' },
      h('button', { class: `btn ${st.mode === 'talk' ? 'on' : ''}`, disabled: !edit, onClick: () => S.setMode('talk') }, '🎙 Talk'),
      h('button', { class: `btn ${st.mode === 'react' ? 'on' : ''}`, disabled: !edit, onClick: () => S.setMode('react') }, '🖥 React'));
    const cams = room?.cameras ?? ['talk', 'group', 'wide', 'react', 'screen'];
    const camLabel = (c: string) => ({ talk: 'Talk — frame one person', group: 'Group — everyone present', wide: 'Wide — the room', react: 'React — the screen (≈80%)', screen: 'Screen — centred on the video / react window' } as Record<string, string>)[c] ?? c.replace(/^CAM_/, '').replace(/_/g, ' ').toLowerCase().replace(/^./, (m) => m.toUpperCase()) + ' (preset)';
    const camSel = select('Camera', st.camera, cams.map((c): [string, string] => [c, camLabel(c)]), (v) => S.setCamera(v));
    const members = S.members();
    const focusSel = select('Talk frames', members.some((m) => m.key === st.focus) ? st.focus : HOST_KEY, members.map((m): [string, string] => [m.key, m.name]), (v) => S.setFocus(v), 'Who the Talk camera frames (their spot\'s SPOT_xx_CAM or an automatic bust shot)');
    for (const x of [camSel, focusSel]) (x.querySelector('select') as HTMLSelectElement).disabled = !edit;
    const fol = [
      toggle('Camera follows my entrance', st.follow.host, (v) => S.setFollow({ host: v }), 'When you walk in: cut to the door camera, follow you to your spot, then back to the camera above'),
      toggle('…and guests’ entrances', st.follow.guests, (v) => S.setFollow({ guests: v }), 'Same for party guests walking in'),
    ];
    for (const x of fol) { const i = x.querySelector('input'); if (i) i.disabled = !edit; }
    const laySel = select('React layout', st.reactLayout ?? 'auto', [['auto', 'Auto — side screen when you\u2019re alone'], ['solo', 'Solo side (beside the host)'], ['big', 'Big centre (the room\u2019s screen)']],
      (v) => S.setReactLayout(v), 'Solo: a screen drops beside the host and the camera pulls out to a two-shot. Auto switches to the big screen when a guest joins.');
    (laySel.querySelector('select') as HTMLSelectElement).disabled = !edit;
    const why = S.layoutReason();
    const layNote = h('p', { class: 'note' }, h('b', null, st.mode === 'react' ? 'Showing: ' : 'React will show: '), why.text);
    void seg; void laySel; void layNote;   // (mode + React layout: the Show mode section above)
    if (want('room')) controls.append(section('Camera', camSel, focusSel,
      slider('Camera move (s)', st.transition, 0, 3, 0.1, (v) => S.setTransition(v), '0 = hard cut', { def: defaultSceneState().transition, hard: [0, 5] }), ...fol,
      h('p', { class: 'note' }, 'React drops the screen and cuts to the React camera; Talk puts it away again.')));
    if (want('room')) controls.append(afkBox);

    // presence: the host walks in / out through the door (everyone's OBS shows the same walk)
    const hostIn = st.present[HOST_KEY] !== false;
    const door = edit ? h('div', { class: 'btns tight' },
      button(hostIn ? '🚪 Leave the room' : '🚪 Walk in', () => S.setPresent(HOST_KEY, !hostIn), hostIn ? '' : 'primary'),
      h('span', { class: 'note', style: 'margin-left:8px' }, hostIn ? 'You are in the room.' : 'You are outside — walk in when you are ready.')) : null;
    // spots
    if (want('room')) controls.append(section('Who sits where', door, spotMap(S, room, members, selected, (k) => { selected = k; render(); }), memberList(S, room, members, selected, (k) => { selected = k; render(); }),
      h('p', { class: 'note' }, edit ? 'Drag a person onto another spot (or click them, then a spot) and they walk there. Moving onto someone swaps you. The “In” box sends someone out of the door / walks them back in. Guests get free spots automatically (they walk in when they join) — and their old seat back when they reconnect.' : 'The host moves people around.'),
      S.observer ? testMembers(S) : null));

    // look + lights (src/ui/lightsPanel.ts)
    if (want('room')) controls.append(section('Look',
      slider('Avatar size', st.avatarScale, 0.5, 1.8, 0.01, (v) => S.setAvatarScale(v), 'Everyone is normalised to a real-world height for the room; this scales that', { def: defaultSceneState().avatarScale, unit: '×', hard: [0.4, 2.5] }),
    ));
    // (only rooms with time + weather: scene.json "environment")
    if (S.scenes.find((x) => x.id === st.sceneId)?.environment || S.report?.env?.on) { if (want('room')) controls.append(envBox); }
    if (S.scenes.find((x) => x.id === st.sceneId)?.eras?.list?.length) { if (want('room')) controls.append(eraBox); }
    if (want('room')) controls.append(gfxSection(app));
    if (want('room')) controls.append(lightsSection(app, room, render));
    if (want('room')) controls.append(djSyncSection(app)); // DJ sync: lights locked to the DJ's decks (src/ui/djSyncPanel.ts)
    if (want('room')) controls.append(djDeckSection(app)); // DJ decks: a DJ setup copying the controller, the hands play it (src/ui/djDeckPanel.ts)
    if (want('chat')) controls.append(chatBox);
    if (want('chat')) controls.append(raidBox);
    if (part === 'chat') controls.append(slapBox);
    if (S.scenes.find((x) => x.id === st.sceneId)?.kitchen || S.report?.kitchen?.room) { if (want('room')) controls.append(kitchenBox); }
    if ((S.scenes.find((x) => x.id === st.sceneId) as { club?: unknown } | undefined)?.club) { if (want('room')) controls.append(clubBox); }
    if ((S.scenes.find((x) => x.id === st.sceneId) as { festival?: unknown } | undefined)?.festival) { if (want('room')) controls.append(festivalSection(app)); }
    // (only rooms with a view onto space)
    if (S.scenes.find((x) => x.id === st.sceneId)?.space || S.report?.space?.space) { if (want('room')) controls.append(spaceBox); }

    if (want('show')) controls.append(screenVideoSection(app, render));
    if (want('show')) controls.append(ambientCamSection(app));
    if (want('show')) controls.append(reactSection(S, room));
    if (want('stream')) controls.append(obsBox);
    if (want('stream')) controls.append(obsHelp());
  };

  // tab switched away: drop the preview (it may live in the viewport when Big) and stop listening
  const watch = window.setInterval(() => { if (!el.isConnected || !el.contains(controls)) { window.clearInterval(watch); off(); frame.remove(); layEd?.dispose(); } }, 400);
  let chatSig = '';
  const off = S.on((what) => {
    if (!el.isConnected) return;
    // (the Chat area builds nothing from the stage report, and its sections keep their own state (the chat box panel holds
    // the live preview): it is rebuilt only when what it shows changes — room or no room, host or guest. A rebuild moves
    // those sections out and back, which would reload that preview every time; chatfx)
    if (what === 'report') { updateRect(S); updateShare(S); if ((roomChanged(S) || stageChanged(S)) && part !== 'chat') render(); return; }
    if (what === 'share') { updateShare(S); return; }
    if (part === 'chat') { const sig = `${!!S.effective.sceneId}|${S.role}|${S.canEdit}`; if (sig === chatSig) return; chatSig = sig; }
    render();
  });
  render();
}

let lastStageKey = '';
/** The preview's stage layout changed (another plan, cams, docks): redraw its live picture. */
/** Chat & events with no room (clarity: it was one line pointing at a "Go Live" area that doesn't exist, over an
 *  empty page): what needs a room, what works without one, and the buttons for both. */
function chatNoRoom(app: App): HTMLElement {
  return h('div', null,
    h('p', { class: 'note' }, 'Chat on screen, raids and slaps need a room. Pick one in Room. Connecting your chat and Chat Hub work without one.'),
    h('div', { class: 'btns tight' },
      button('Set up my chat & stream', () => void import('./streamSetup/index.ts').then((m) => m.openStreamSetup(app)), 'primary'),
      button('Open Chat Hub', () => openChatHub()),
      button('Pick a room', () => studioNav().go('room'))));
}

function stageChanged(S: SceneController) {
  const r = S.report?.stage;
  const k = r ? `${r.key}|${r.rail.join(',')}|${!!r.docks.chat}|${!!r.docks.support}|${r.tiles.length}|${r.open}` : '';
  if (k === lastStageKey) return false;
  lastStageKey = k;
  return true;
}

let lastRoomKey = '';
function roomChanged(S: SceneController) {
  const r = S.effective.sceneId ? S.rooms.get(S.effective.sceneId) : null;
  const k = r ? `${r.id}:${r.cameras.join(',')}:${r.spots.filter(Boolean).length}:${r.layout}:${r.soloPending}:${(r.toggles ?? []).map((t) => t.id).join(',')}` : '';
  if (k === lastRoomKey) return false;
  lastRoomKey = k;
  return true;
}

/** Opt-in preview savings while tracking runs (src/scene/previewLink.ts; read live by every preview's gate). The
 *  preview already stops drawing by itself whenever it can't be seen — these trade preview smoothness for the tracker. */
function previewSavings() {
  const ls = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage off */ } };
  const fpsNow = String(previewFpsSetting()) as '20' | '10' | '5';
  return h('details', { class: 'note', style: 'margin:4px 0 6px' }, h('summary', null, 'Preview while tracking'),
    select('Room preview frame rate while tracking', fpsNow, [['20', '20 fps (default)'], ['10', '10 fps'], ['5', '5 fps']], (v) => ls(PREVIEW_FPS_KEY, v),
      'Only this preview (OBS is never affected). Fewer preview frames = more time for the face tracker on this page.'),
    toggle('Pause the preview when this window is not focused for 10 s', previewPauseSetting(), (v) => ls(PREVIEW_PAUSE_KEY, v ? '1' : '0'),
      `While tracking: after 10 s in OBS or a game the preview stops and says "${PREVIEW_PAUSED_NOTE}". Click back into the studio to resume. A popped-out preview window keeps drawing.`));
}

function toggleBtn(label: string, value: boolean, onChange: (v: boolean) => void) {
  const b = button(label, () => { value = !value; b.classList.toggle('active', value); onChange(value); });
  b.classList.toggle('active', value);
  return b;
}

// ---------------------------------------------------------------- spot map (top-down)
function spotMap(S: SceneController, room: RoomSummary | null, members: SceneMember[], selected: string | null, onSelect: (k: string | null) => void) {
  const st = S.effective;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'scn-map');
  if (!room) {
    const d = h('div', { class: 'note' }, 'Loading the room… (turn the preview on to see the spot map)');
    return d;
  }
  const spots = room.spots.filter((s): s is NonNullable<typeof s> => !!s);
  const b = room.bounds ?? { min: [-4, 0, -3], max: [4, 3, 3] };
  // frame the spots (+ a margin), clipped to the room — hallways / outside props don't shrink the map
  const sx = spots.map((s) => s.x), sz = spots.map((s) => s.z);
  const x0 = Math.max(b.min[0], Math.min(...sx) - 1.1) - 0.1, x1 = Math.min(b.max[0], Math.max(...sx) + 1.1) + 0.1;
  const z0 = Math.max(b.min[2], Math.min(...sz) - 0.9) - 0.1, z1 = Math.min(b.max[2], Math.max(...sz) + 0.9) + 0.1;
  const W = 300, H = Math.max(120, Math.min(260, (W * (z1 - z0)) / (x1 - x0)));
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const X = (x: number) => ((x - x0) / (x1 - x0)) * W, Z = (z: number) => ((z - z0) / (z1 - z0)) * H;
  const el = (tag: string, attrs: Record<string, string | number>, parent: Element = svg) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    parent.append(e);
    return e;
  };
  // room outline + "camera side" marker (stage front = +Z = bottom)
  el('rect', { x: Math.max(0, X(b.min[0])), y: Math.max(0, Z(b.min[2])), width: Math.min(W, X(b.max[0])) - Math.max(0, X(b.min[0])), height: Math.min(H, Z(b.max[2])) - Math.max(0, Z(b.min[2])), fill: '#191d25', stroke: '#2a303c', rx: 4 });
  const ft = el('text', { x: W / 2, y: H - 3, fill: '#5d6677', 'text-anchor': 'middle' }); ft.textContent = '▼ stage front (camera side)';
  if (room.screen) { const t = el('text', { x: W / 2, y: Math.max(0, Z(b.min[2])) + 10, fill: '#4cc9f0', 'text-anchor': 'middle' }); t.textContent = '▬ screen'; }
  const byIndex = new Map<number, SceneMember>();
  for (const m of members) { const i = st.spots[m.key]; if (i !== undefined) byIndex.set(i, m); }
  const initials = (n: string) => n.replace(/\(.*?\)/g, '').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  const edit = S.canEdit;
  let drag: { key: string; ghost: Element } | null = null;
  const spotAt = (cx: number, cy: number) => {
    let best = -1, bd = 18 * 18;
    for (const s of spots) { const d = (X(s.x) - cx) ** 2 + (Z(s.z) - cy) ** 2; if (d < bd) { bd = d; best = s.index; } }
    return best;
  };
  const toSvg = (e: PointerEvent) => { const r = svg.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H]; };
  for (const s of spots) {
    const g = el('g', { class: 'spot', transform: `translate(${X(s.x)},${Z(s.z)})` });
    const m = byIndex.get(s.index);
    const absent = m && st.present[m.key] === false;
    const isSel = m && m.key === selected;
    // facing arrow
    const fx = Math.sin(s.yaw) * 17, fz = Math.cos(s.yaw) * 17;
    el('line', { x1: 0, y1: 0, x2: fx, y2: fz, stroke: '#3a4254', 'stroke-width': 2 }, g);
    const fill = m ? (m.host ? '#7bd88f' : '#4cc9f0') : '#262c3a';
    if (s.pose === 'sit') el('rect', { x: -11, y: -11, width: 22, height: 22, rx: 5, fill, stroke: isSel ? '#fff' : '#0000', 'stroke-width': 2, opacity: absent ? 0.35 : 1 }, g);
    else el('circle', { r: 11.5, fill, stroke: isSel ? '#fff' : '#0000', 'stroke-width': 2, opacity: absent ? 0.35 : 1 }, g);
    const t = el('text', { y: 3.2, 'text-anchor': 'middle', fill: m ? '#0b1310' : '#7b8496' }, g);
    t.textContent = m ? initials(m.name) : String(s.index + 1);
    const tip = el('title', {}, g); tip.textContent = `${s.index < MAX_SPOTS ? `SPOT_${String(s.index + 1).padStart(2, '0')}` : `Size spot ${s.index + 1}`} · ${s.label} · ${s.pose}${s.sizes?.length ? ` · for ${s.sizes.join(' / ')}` : ''}${m ? ` · ${m.name}${absent ? ' (not in the room)' : ''}` : ''}`;
    if (s.sizes?.length && !m) { const k = el('text', { y: -14, 'text-anchor': 'middle', 'font-size': 10 }, g); k.textContent = s.sizes.map((c) => SIZE_ICON[c]).join(''); }
    if (!edit) continue;
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (m) {
        (svg as unknown as HTMLElement).setPointerCapture((e as PointerEvent).pointerId);
        const ghost = el('circle', { r: 10, fill: '#fff', opacity: 0.35, cx: X(s.x), cy: Z(s.z) });
        drag = { key: m.key, ghost };
      } else if (selected) { S.move(selected, s.index); onSelect(null); }
    });
  }
  svg.addEventListener('pointermove', (e) => { if (!drag) return; const [x, y] = toSvg(e as PointerEvent); drag.ghost.setAttribute('cx', String(x)); drag.ghost.setAttribute('cy', String(y)); });
  svg.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    d.ghost.remove();
    const [x, y] = toSvg(e as PointerEvent);
    const i = spotAt(x, y);
    const cur = st.spots[d.key];
    if (i >= 0 && i !== cur) { S.move(d.key, i); onSelect(null); }
    else onSelect(selected === d.key ? null : d.key);   // a click: select / deselect
  });
  return svg;
}

function memberList(S: SceneController, room: RoomSummary | null, members: SceneMember[], selected: string | null, onSelect: (k: string | null) => void) {
  const st = S.effective, edit = S.canEdit;
  const box = h('div', { class: 'scn-list' });
  const spotOpts: [string, string, number][] = [['', '— no spot —', -1]];
  for (let i = 0; i < (room ? room.spots.length : MAX_SPOTS); i++) {
    const s = room?.spots[i];
    if (room && !s) continue;
    spotOpts.push([String(i), `${i + 1} · ${s ? `${s.label}${s.pose === 'sit' ? ' 🪑' : ''}${s.sizes?.length ? ` ${s.sizes.map((c) => SIZE_ICON[c]).join('')}` : ''}` : `SPOT_${String(i + 1).padStart(2, '0')}`}`, i]);
  }
  for (const m of members) {
    const i = st.spots[m.key];
    // spots made for another size class (a fairy's table perch, a giant's back row) or body kind (a couch seat for
    // bipeds, a mech pad) can't be picked for this member: the controller's own rule (shared/occupant.ts spotFitOcc)
    const sel = h('select', { disabled: !edit, onChange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v !== '') S.move(m.key, +v); } },
      ...spotOpts.map(([v, l, idx]) => h('option', { value: v, selected: v === (i === undefined ? '' : String(i)), disabled: idx >= 0 && !!room && S.spotFitFor(m.key, idx) === 0 }, l)));
    const present = st.present[m.key] !== false;
    const pres = h('input', { type: 'checkbox', checked: present, disabled: !edit, title: 'In the room (untick: they walk out of the door; tick: they walk back in)', onChange: (e: Event) => S.setPresent(m.key, (e.target as HTMLInputElement).checked) });
    box.append(h('div', { class: `mrow ${m.key === selected ? 'sel' : ''}` },
      h('span', { class: 'nm', title: m.size && !m.size.auto ? `${m.name} — ${m.size.cls}, ${m.size.height} m real height` : m.name, onClick: () => onSelect(m.key === selected ? null : m.key), style: 'cursor:pointer' }, `${m.host ? '★ ' : ''}${m.size && !m.size.auto && m.size.cls !== 'normal' ? SIZE_ICON[m.size.cls] + ' ' : ''}${m.name}`),
      sel, pres));
  }
  if (members.length > 1 || edit) box.prepend(h('div', { class: 'mrow note', style: 'margin:0' }, h('span', null, 'Performer'), h('span', null, 'Spot'), h('span', { title: 'In the room' }, 'In')));
  // size classes: who is micro / macro and where that puts them; a refused move says why
  if (S.sizeWarning) box.append(h('p', { class: 'note', style: 'color:#f5c451;margin:4px 0 0' }, '⚠ ' + S.sizeWarning));
  for (const n of S.sizeNotes()) box.append(h('p', { class: 'note', style: 'margin:2px 0 0' }, n));
  return box;
}

function testMembers(S: SceneController) {
  const inp = h('input', { type: 'text', value: S.testMembers.map((t) => t.avatarId).join(','), placeholder: 'robot', style: 'width:100%' }) as HTMLInputElement;
  return h('div', null, h('p', { class: 'note' }, 'Observer test: stand-in performers (library avatar ids) for this preview only:'), inp,
    h('div', { class: 'btns tight' }, button('Use stand-ins', () => S.setTestMembers(inp.value.split(',').map((x) => x.trim()).filter((x) => /^[A-Za-z0-9_-]{1,48}$/.test(x))))));
}

// ---------------------------------------------------------------- react screen / OBS numbers
const rectBox = h('div', { class: 'scn-rect' });
function updateRect(S: SceneController) {
  const rs = S.report?.rects;
  const r = S.report?.rect;
  const [W, H] = canvasSize();
  if (!rs && !r) { rectBox.textContent = S.report?.loading ? 'Loading the room…' : 'Turn the preview on to measure the screen.'; return; }
  const fmt = (label: string, x: typeof r | null | undefined, inUse: boolean) => {
    if (!x) return `${label}\n  (not available in this room / for this spot)`;
    const px = { x: Math.round(x.x * W), y: Math.round(x.y * H), w: Math.round(x.w * W), h: Math.round(x.h * H) };
    return `${label}${inUse ? '   ◀ in use' : ''}\n  Position  x ${px.x}   y ${px.y}\n  Size      ${px.w} × ${px.h}   (${Math.round(x.w * 100)}% × ${Math.round(x.h * 100)}%)${x.visible ? '' : '\n  ⚠ partly outside the frame'}`;
  };
  // angled screens: how far the hole's real corners are from the axis-aligned box (OBS transforms can't skew)
  const skew = (x: typeof r | null | undefined, q: [number, number][] | null | undefined) => {
    if (!x || !q) return '';
    const box: [number, number][] = [[x.x, x.y], [x.x + x.w, x.y], [x.x + x.w, x.y + x.h], [x.x, x.y + x.h]];
    const d = Math.max(...q.map((c, i) => Math.hypot((c[0] - box[i][0]) * W, (c[1] - box[i][1]) * H)));
    const corners = q.map((c) => `${Math.round(c[0] * W)},${Math.round(c[1] * H)}`).join('  ');
    return `\n  Corners   ${corners}${d > W * 0.006 ? `\n  \u26a0 angled: corners up to ${Math.round(d)} px off the box — use In-scene capture (or the corner-pin plugin)` : ''}`;
  };
  const qs = rs?.quads;
  rectBox.textContent = rs
    ? `${fmt('Big centre', rs.big, rs.layout === 'big')}${skew(rs.big, qs?.big)}\n${fmt('Solo side', rs.solo, rs.layout === 'solo')}${skew(rs.solo, qs?.solo)}\n(${W}×${H} canvas)`
    : fmt('React screen', r, true);
}

function reactSection(S: SceneController, room: RoomSummary | null) {
  const [W, H] = canvasSize();
  const st = S.effective, edit = S.canEdit;
  const sc = sanitizeScreen(st.screen);
  const wIn = h('input', { type: 'number', value: W, min: 320, max: 7680, style: 'width:70px' }) as HTMLInputElement;
  const hIn = h('input', { type: 'number', value: H, min: 240, max: 4320, style: 'width:70px' }) as HTMLInputElement;
  const save = () => { localStorage.setItem('vtp.scene.obsW', wIn.value); localStorage.setItem('vtp.scene.obsH', hIn.value); updateRect(S); document.querySelectorAll<HTMLElement>('.scn-prev').forEach((f) => (f.style.aspectRatio = `${wIn.value} / ${hIn.value}`)); };
  wIn.addEventListener('change', save); hIn.addEventListener('change', save);
  updateRect(S);
  // ---- source: the window the screen shows (in-scene) / previews (passthrough)
  const mode = select('Screen shows', sc.mode, [['auto', 'Auto — OBS capture when it fits, else in the room (recommended)'], ['inscene', 'In-scene capture (always)'], ['passthrough', 'OBS passthrough (a hole + your Window Capture)']],
    (v) => S.setScreen({ mode: v }), 'Auto: when OBS automation is on and the screen faces the camera straight on (or with the corner-pin), OBS shows your capture there itself, which stays smooth next to a heavy game. A screen at an angle, or one with glass sheen or scanlines, is drawn ON the screen in 3D with the fast window feed, never a crooked box. In-scene always draws it in 3D.');
  (mode.querySelector('select') as HTMLSelectElement).disabled = !edit;
  const pick = button(S.capturing ? 'Pick another window…' : 'Pick a window…', async () => {
    try { await S.pickSource(); } catch (e) { toast(`No window picked (${(e as Error).message})`, 'warn'); }
  }, S.capturing ? '' : 'primary');
  const stop = S.capturing ? button('Stop', () => S.setCapture(null), 'danger') : null;
  shareVideo.srcObject = S.captureStream;
  shareVideo.style.display = S.capturing ? '' : 'none';
  updateShare(S);
  return h('div', null,
    section('React screen',
      room && !room.screen && !room.solo ? h('p', { class: 'note' }, 'This room has no SCREEN node (the solo side screen still works).') : null,
      room?.skins ? h('p', { class: 'note' }, h('b', null, 'Solo screen: '), room.skins.solo, h('br'), h('b', null, 'Chat props: '), room.skins.monitor,
        room.skins.source === 'scene.json' || room.skins.source === 'glb node' ? ' — set by this room' : ' — this room’s built-in skin (scene.json screenSkin can change it)',
        room.skins.warnings.length ? h('span', { style: 'color:var(--warn,#e0a030)' }, h('br'), `scene.json screenSkin: ${room.skins.warnings.join('; ')}`) : null) : null,
      mode,
      sc.mode !== 'passthrough' ? captureSection(S.observer) : null,
      sc.mode === 'inscene' && !S.capturing ? h('p', { class: 'note', style: 'color:var(--dim)' }, 'In-scene (always): the screen shows the Fast window feed above; if it can’t run and no window is shared below, OBS shows NO SIGNAL (Auto would then use OBS passthrough on a screen that faces the camera straight on).') : null,
      h('p', { class: 'note' }, h('b', null, 'Or share a window from this browser'), ' (works on any OS, ≈ 90 ms, has to be picked again after a studio reload; wins over the fast feed while shared):'),
      h('div', { class: 'btns tight' }, pick, stop),
      shareVideo, shareBox,
      toggle('Glass sheen', sc.glass, (v) => S.setScreen({ glass: v }), 'A faint reflection on the screen glass (in-scene; off by default — it only brightens highlights)'),
      toggle('Subtle scanlines', sc.scanlines, (v) => S.setScreen({ scanlines: v }), 'Very faint CRT lines over the window (in-scene)'),
      h('p', { class: 'note' }, 'The picked window is sent only to this PC’s OBS pages (a local connection, never online) and never its sound — keep the window’s audio in OBS as usual. Browsers can’t re-open a picked window by themselves: after a studio reload click ', h('b', null, 'Pick a window'), ' again (OBS shows NO SIGNAL until then).')),
    section('OBS passthrough (fallback)',
      h('label', { class: 'row' }, h('span', { class: 'lbl' }, 'OBS canvas'), h('span', null, wIn, ' × ', hIn)),
      h('p', { class: 'note' }, 'Only used in passthrough mode: where the hole lands with the React camera — the Window Capture numbers (OBS automation sets them for you):'),
      rectBox,
      h('div', { class: 'btns tight' }, button('Copy numbers', () => { void navigator.clipboard.writeText(rectBox.textContent ?? ''); toast('Copied', 'ok'); })),
      h('p', { class: 'note' }, 'OBS can’t skew a source, so an angled screen only lines up exactly with In-scene capture — or with OBS automation + the free obs-shaderfilter plugin (corner-pin, see OBS automation).')));
}

const shareVideo = h('video', { muted: true, autoplay: true, playsInline: true, style: 'width:100%;aspect-ratio:16/9;background:#000;border-radius:6px;margin:4px 0' }) as HTMLVideoElement;
const shareBox = h('div', { class: 'note' });
function updateShare(S: SceneController) {
  const s = S.share.status, rep = S.report?.room;
  const parts: (string | Node)[] = [];
  if (!s.sharing) parts.push(S.effective.screen?.mode === 'passthrough' ? 'No window shared — the screen uses OBS passthrough.' : 'No window shared from this browser — OBS uses the Fast window feed (above).');
  else {
    const rx = s.receivers.filter((r) => r.stats);
    parts.push(`● Sharing ${s.label || 'a window'} · ${s.width}×${s.height} @ ${s.sentFps} fps${s.encoder && !s.encoder.startsWith('?') ? ` · ${s.encoder}` : ''}${s.limited ? ` · limited by ${s.limited}` : ''}`);
    parts.push(h('br'), rx.length ? `→ ${rx.length} OBS page${rx.length > 1 ? 's' : ''}: ${rx.map((r) => `${r.stats!.fps} fps ${Math.round(r.stats!.kbps / 1000)} Mbit/s ${r.stats!.codec.replace('video/', '')}${r.stats!.hw ? ' (hw)' : ''}`).join(' · ')}` : S.observer ? '(observer: not sent to OBS)' : '→ waiting for an OBS page (is the Browser Source open?)');
    if (s.delayMs !== null) parts.push(h('br'), h('b', null, `≈ ${s.delayMs} ms`), ' from the window to OBS. If its sound runs ahead, set that audio source’s ', h('b', null, 'Sync Offset'), ` to ${s.delayMs} ms (OBS → Audio Mixer → ⋮ → Advanced Audio Properties).`);
  }
  if (rep && rep.inScene === false && s.sharing && S.effective.screen?.mode === 'passthrough') parts.push(h('br'), 'Mode is OBS passthrough: the shared window is only used by this preview.');
  clear(shareBox);
  shareBox.append(...parts);
}

function obsHelp() {
  return section('OBS setup',
    h('p', { class: 'note' }, h('b', null, '1.'), ' Browser Source ', h('code', null, 'http://127.0.0.1:5191/output.html'), ' at your canvas size (e.g. 1920×1080). It follows this tab: Classic = avatars only, a room = the full 3D scene.'),
    h('p', { class: 'note' }, h('b', null, '2. In-scene capture (recommended):'), ' the ', h('b', null, 'Fast window feed'), ' draws the window your OBS Window Capture shows ON the 3D screen (≈ 30 ms; Windows + ffmpeg 8.1+). Or React screen → ', h('b', null, 'Pick a window'), ' to share one from this browser. Correct at any angle, even while the camera moves; keep the window’s sound in OBS as before (use the Sync Offset shown above if it runs ahead).'),
    h('p', { class: 'note' }, h('b', null, '3. OBS passthrough (fallback):'), ' add a ', h('b', null, 'Window Capture'), ' BELOW the browser source; Transform → Edit Transform: Position / Bounding Box Size = the numbers above, Bounding Box Type “Scale to inner bounds”, Alignment Top Left — or let OBS automation place it. Angled screens only match exactly with the obs-shaderfilter corner-pin (OBS automation).'),
    h('p', { class: 'note' }, 'In Talk mode the screen is up (in passthrough the room covers the capture — leave it in the scene); in React mode it drops and shows your window — avatars in front of it still cover it.'));
}
