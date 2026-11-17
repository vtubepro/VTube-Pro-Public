// The Room editor's ONE entry point in the studio (docs/ROOM_EDITOR.md). The editor itself runs in a full-window frame
// (output.html?roomEdit=<room>: a private test page of that room, src/scene/roomEdit/editor.ts), so opening it never
// touches the live studio's state or OBS: only its Save does, once (the helper broadcasts one message).
//
//   openRoomEditor(roomId, { onClose?, focus? })   open it for a room (focus 'chat': the chat screens up front); returns close
//   roomEditorButton(app)                  an "Edit room…" button for the current room (the one hook the layout needs)
import type { App } from '../app.ts';
import { h, toast } from './dom.ts';

const CSS = `
.vtp-re-ov { position:fixed; inset:0; z-index:9000; background:#0d1016; }
.vtp-re-ov iframe { position:absolute; inset:0; width:100%; height:100%; border:0; }
`;
let open: (() => void) | null = null;

/** Open the Room editor over the whole studio for `roomId` (a room id from the room list; an area id edits that area). */
export function openRoomEditor(roomId: string, opts: { onClose?: (saved: boolean) => void; focus?: 'chat' } = {}): () => void {
  open?.();
  if (!document.getElementById('vtp-re-css')) document.head.append(h('style', { id: 'vtp-re-css' }, CSS));
  const url = `output.html?roomEdit=${encodeURIComponent(roomId)}&fps=60&adaptive=0${opts.focus ? `&focus=${opts.focus}` : ''}`;
  const frame = h('iframe', { src: url, title: 'Room editor', allow: '' }) as HTMLIFrameElement;
  const ov = h('div', { class: 'vtp-re-ov', role: 'dialog', 'aria-label': 'Room editor' }, frame);
  let saved = false;
  const onMsg = (e: MessageEvent) => {
    if (e.source !== frame.contentWindow || e.origin !== location.origin) return;
    const m = e.data as { type?: string; action?: string; applied?: boolean };
    if (m?.type !== 'vtp-roomedit') return;
    if (m.action === 'saved') { saved = true; toast(m.applied ? 'Room changes saved — your OBS output shows them now.' : 'Room changes saved — they show the next time the room loads.', 'ok'); }
    if (m.action === 'close') close();
  };
  const close = () => {
    removeEventListener('message', onMsg);
    frame.src = 'about:blank';                           // (stop its renderer at once: an open editor costs GPU time)
    ov.remove();
    if (open === close) open = null;
    opts.onClose?.(saved);
  };
  addEventListener('message', onMsg);
  document.body.append(ov);
  open = close;
  return close;
}

/** "Edit room…" for the room the studio shows now (disabled in Classic). */
export function roomEditorButton(app: App): HTMLButtonElement {
  const b = h('button', { class: 'btn', title: 'Move cameras, places, the react screen and chat displays, and place props. Nothing changes on stream until you Save.' }, 'Edit room…') as HTMLButtonElement;
  const sync = () => { b.disabled = !app.scene.state.sceneId; };
  b.addEventListener('click', () => {
    const id = app.scene.state.sceneId;
    if (!id) return;
    openRoomEditor(id, { onClose: (saved) => { if (saved) void app.scene.refreshScenes(); } });
  });
  sync();
  // (the panel that holds it re-renders: a button that left the page stops listening)
  let seen = false;
  const off = app.scene.on(() => { if (b.isConnected) { seen = true; sync(); } else if (seen) off(); });
  return b;
}
