// "Where does the chat show?" — one choice for the chat displays (owner: "Add an option to choose where I want the chat
// to be"): **On screen** (the docked chat box over the stream: src/ui/chatBoxPanel.ts, shared/chatBox.ts), **In the
// room** (a chat screen inside the 3D room: the automatic chat monitor, or the chat screens placed with the Room editor —
// src/scene/chatScreens.ts), **Both** (the room's chat screen, and the box whenever that screen isn't in the shot), or
// **Hidden** (no chat on the stream). Two host settings saved per key through the scene sync (SceneState.chat.monitor,
// SceneState.stage.dock.chat), so the choice sticks across reloads, restarts and room switches; the OBS pages and the
// party guests' pages draw what the host picked.
//
// chatfx: the old two-button control could show "In the room" while the box was still on the stream (monitor on AND the
// box on): the four choices always match what the stream shows. In the room / Both also offer the monitor's side + size.
//
//   chatWhereChoice(app) → the control (mounted next to the chat box panel). "Place it in the room…" opens the Room
//   editor on the current room with the chat screens up front.
import type { App } from '../app.ts';
import { DEFAULT_CHAT_STATE } from '../../shared/chat.ts';
import { DEFAULT_STAGE } from '../../shared/stage.ts';
import { chatWhereOf, type ChatWhere } from '../../shared/chatBox.ts';
import { h } from './dom.ts';
import { openRoomEditor } from './roomEditor.ts';

const CSS = `
.cw { display:grid; gap:6px; margin:2px 0 10px; }
.cw-seg { display:grid; grid-template-columns: repeat(4, 1fr); gap:0; }
.cw-seg button { font:inherit; font-weight:600; padding:8px 6px; border:1px solid var(--line2, #3a4254); border-left-width:0; background:var(--card2, #1b2130); color:var(--text, #e8ecf4); cursor:pointer; min-width:0; }
.cw-seg button:first-child { border-radius:9px 0 0 9px; border-left-width:1px; } .cw-seg button:last-child { border-radius:0 9px 9px 0; }
.cw-seg button[aria-pressed="true"] { background:var(--accent2, #6cc7f5); color:#06131a; border-color:transparent; }
.cw-seg button:disabled { opacity:.5; cursor:default; }
.cw-seg button small { display:block; font-weight:500; font-size:10.5px; opacity:.8; margin-top:1px; }
@media (max-width: 420px) { .cw-seg { grid-template-columns: repeat(2, 1fr); } .cw-seg button { border-left-width:1px; border-radius:0 !important; } .cw-seg button:nth-child(1) { border-radius:9px 0 0 0 !important; } .cw-seg button:nth-child(2) { border-radius:0 9px 0 0 !important; } .cw-seg button:nth-child(3) { border-radius:0 0 0 9px !important; } .cw-seg button:nth-child(4) { border-radius:0 0 9px 0 !important; } }
.cw p { margin:0; font-size:12px; color:var(--dim, #9aa4b8); }
.cw .cw-go { justify-self:start; }
.cw-side { display:flex; flex-wrap:wrap; gap:4px; align-items:center; font-size:12px; color:var(--dim, #9aa4b8); }
.cw-side button { font:inherit; font-size:12px; padding:4px 10px; border-radius:99px; border:1px solid var(--line2, #3a4254); background:var(--card2, #1b2130); color:var(--text, #e8ecf4); cursor:pointer; }
.cw-side button[aria-pressed="true"] { border-color:var(--accent2, #6cc7f5); font-weight:700; }
`;
let cssDone = false;


export function chatWhereChoice(app: App): HTMLElement {
  if (!cssDone) { document.head.append(h('style', null, CSS)); cssDone = true; }
  const S = app.scene;
  const box = h('div', { class: 'cw', 'data-cw': '1' });
  const paint = () => {
    const st = S.effective;
    const room = !!st.sceneId, edit = S.canEdit;
    const chat = st.chat ?? DEFAULT_CHAT_STATE;
    const dock = (st.stage?.dock ?? DEFAULT_STAGE.dock);
    const where = chatWhereOf(chat.monitor, dock.chat, room);
    const info = st.sceneId ? S.scenes.find((x) => x.id === st.sceneId) : null;
    const own = (info?.userEdits?.chatScreens?.length ?? 0);
    const set = (w: ChatWhere) => {
      if (!edit) return;
      const boxOn = w === 'screen' || w === 'both', world = w === 'room' || w === 'both';
      if (chat.monitor !== world) S.setChat({ monitor: world });
      // (Both: the box steps aside while the room's chat screen is in the shot — "Always" would sit on top of it)
      if (boxOn && (dock.chat === 'off' || (w === 'both' && dock.chat === 'always'))) S.setStage({ dock: { ...dock, chat: 'auto' } });
      if (!boxOn && dock.chat !== 'off') S.setStage({ dock: { ...dock, chat: 'off' } });
    };
    const btn = (w: ChatWhere, label: string, sub: string, title: string, needRoom = false) =>
      h('button', { 'aria-pressed': String(where === w), 'data-where': w, disabled: !edit || (needRoom && !room), onClick: () => set(w), title: needRoom && !room ? 'Pick a 3D room first' : title }, label, h('small', null, sub));
    const side = (where === 'room' || where === 'both') && edit ? h('div', { class: 'cw-side' }, 'Chat screen:',
      ...([['auto', 'Best side'], ['left', 'Left'], ['right', 'Right']] as const).map(([v, l]) => h('button', { 'aria-pressed': String(chat.side === v), 'data-side': v, onClick: () => S.setChat({ side: v }) }, l)),
      ...([['Smaller', -0.15], ['Bigger', 0.15]] as const).map(([l, d]) => h('button', { 'data-size': l, onClick: () => S.setChat({ size: Math.round(Math.min(1.6, Math.max(0.6, chat.size + d)) * 100) / 100 }) }, l))) : null;
    box.replaceChildren(
      h('div', { class: 'cw-seg', role: 'group', 'aria-label': 'Where the chat shows' },
        btn('screen', 'On screen', 'a box', 'A chat box over your stream (place and size it below)'),
        btn('room', 'In the room', 'a screen', 'A chat screen inside the 3D room', true),
        btn('both', 'Both', 'screen + box', 'The room’s chat screen, and the box whenever that screen isn’t in the shot', true),
        btn('hidden', 'Hidden', 'no chat', 'No chat on your stream (it still comes in to the Chat Hub)')),
      h('p', null, where === 'hidden' ? 'No chat on your stream. Your chat still arrives in the Chat Hub.'
        : !room && where !== 'screen' ? 'In the room needs a 3D room (Room → pick one).'
        : where === 'room' ? (own ? `Your ${own === 1 ? 'chat screen shows' : `${own} chat screens show`} the chat in this room.` : 'VTube Pro puts a chat monitor in the room for every shot. Place your own to choose exactly where, and how big.')
        : where === 'both' ? 'The room’s chat screen shows the chat; when a shot doesn’t see it, the box below takes over.'
        : 'The chat box sits over your stream. Drag it on the picture below, or pick a corner.'),
      side ?? '',
      ...(room && edit && where !== 'screen' && where !== 'hidden' ? [h('button', { class: 'btn cw-go', onClick: () => { openRoomEditor(st.sceneId!, { focus: 'chat', onClose: (saved) => { if (saved) void S.refreshScenes(); } }); } }, own ? 'Move / resize the chat in the room…' : 'Place the chat in the room…')] : []),
    );
  };
  let seen = false, last = '';
  const off = S.on(() => {
    if (!box.isConnected) { if (seen) off(); return; }
    seen = true;
    const st = S.effective;
    const sig = JSON.stringify([st.sceneId, st.chat?.monitor, st.chat?.side, st.chat?.size, st.stage?.dock?.chat, S.canEdit, S.scenes.find((x) => x.id === st.sceneId)?.userEdits?.chatScreens?.length]);
    if (sig !== last) { last = sig; paint(); }
  });
  paint();
  return box;
}
