// "Set up my chat & stream" in the studio (lane stream-setup): the wizard (./core.ts) in its own full-size overlay,
// wired to the studio — the chat connectors on this computer's helper, the scene's chat options, the avatar library.
//
// Open it from anywhere in src/ui:  openStreamSetup(app)  ·  openStreamSetup(app, { step: 'alerts' })
//                                    openStreamSetup(app, { platform: 'twitch' })
// From pages without the App (the Live panel, CONTRACT.md "stream-setup"): dispatch a cancelable
//   document.dispatchEvent(new CustomEvent('vtp:stream-setup', { cancelable: true, detail: { step?, platform?, from? } }))
// The studio (installStreamSetupEvent, called by src/ui/shell.ts) answers it with preventDefault() and opens the wizard.
// Everything goes to this PC's server. Secrets never touch the studio page (server/chat/connectPage.ts).
import type { App } from '../../app.ts';
import { api } from '../../api.ts';
import { DEFAULT_CHAT_STATE, type LivePlatform } from '../../../shared/chat.ts';
import { DEFAULT_STAGE } from '../../../shared/stage.ts';
import { setupSummary, type StepId } from '../../../shared/streamSetup.ts';
import { openChatHub } from '../chatPanel.ts';
import { chatBoxSection } from '../chatBoxPanel.ts';
import { h } from '../dom.ts';
import { mountStreamSetup, STREAM_SETUP_CSS, type ChatConfigView, type Marks, type StreamSetupHandle, type StreamSetupHost } from './core.ts';

export const STREAM_SETUP_EVENT = 'vtp:stream-setup';
export interface StreamSetupDetail { step?: StepId; platform?: LivePlatform; from?: string }

const MARKS_KEY = 'vtp.streamSetup';
function readMarks(): Marks { try { const v = JSON.parse(localStorage.getItem(MARKS_KEY) || '{}'); return v && typeof v === 'object' ? v as Marks : {}; } catch { return {}; } }
function writeMarks(m: Marks) { try { localStorage.setItem(MARKS_KEY, JSON.stringify(m)); } catch { /* storage off */ } }

const DLG_CSS = `
dialog.ss-dlg{padding:0;border:1px solid rgb(255 255 255/.1);border-radius:22px;background:#0b0f12;color:#eef3ef;width:min(1180px,calc(100vw - 32px));height:min(820px,calc(100vh - 32px));max-width:none;max-height:none;overflow:hidden;box-shadow:0 40px 120px -30px #000}
dialog.ss-dlg[open]{animation:ss-dlg-in .5s cubic-bezier(.16,1,.3,1)}
@keyframes ss-dlg-in{from{opacity:0;transform:translateY(14px) scale(.985)}to{opacity:1;transform:none}}
dialog.ss-dlg:focus,dialog.ss-dlg:focus-visible{outline:none}
dialog.ss-dlg::backdrop{background:#05070bd9;backdrop-filter:blur(4px)}
dialog.ss-dlg>.ss-host{height:100%}
@media (max-width:640px){dialog.ss-dlg{width:100vw;height:100dvh;border-radius:0;border:0}}
@media (prefers-reduced-motion:reduce){dialog.ss-dlg[open]{animation:none}}
.ss-need{display:grid;gap:14px;place-content:center;height:100%;padding:24px 16px;max-width:480px;margin:0 auto;text-align:center;font:15px/1.5 Geist,ui-sans-serif,system-ui,"Segoe UI",sans-serif;background:#0b0f12}
.ss-need h2{margin:0;font:700 28px/1.15 Archivo,ui-sans-serif,system-ui,sans-serif;letter-spacing:-.02em}.ss-need p{margin:0;color:#9aa6a0}
`;

let dlg: HTMLDialogElement | null = null;
let handle: StreamSetupHandle | null = null;

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) { let m = `${r.status}`; try { const j = await r.json(); m = j.code === 'local-only' ? 'local-only' : j.error ?? m; } catch { /* */ } throw new Error(m); }
  return r.json() as Promise<T>;
}

/** The studio as the wizard's host. */
export function studioHost(app: App, close: () => void): StreamSetupHost {
  const S = app.scene;
  return {
    observer: !!app.observer,
    getConfig: () => fetch('/api/chat/config', { cache: 'no-store' }).then((r) => json<ChatConfigView>(r)),
    saveConfig: (patch) => app.observer ? Promise.reject(new Error('observer')) : fetch('/api/chat/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }).then((r) => json<ChatConfigView>(r)),
    sendTest: (what, platform) => fetch('/api/chat/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ what, ...(platform ? { platform } : {}) }) }).then((r) => json<unknown>(r)).then(() => undefined),
    status: () => S.chat.status,
    events: () => S.chat.events,
    onChange: (fn) => { const off = S.chat.on(fn); return () => { off(); }; },
    canEdit: () => S.canEdit,
    inRoom: () => !!S.effective.sceneId,
    chatState: () => S.effective.chat ?? { ...DEFAULT_CHAT_STATE, goal: { ...DEFAULT_CHAT_STATE.goal }, bots: [] },
    setChat: (p) => { if (S.canEdit) S.setChat(p); },
    dockChat: () => (S.stage ?? DEFAULT_STAGE).dock.chat,
    setDockChat: (m) => { if (S.canEdit) S.setStage({ dock: { ...S.stage.dock, chat: m } }); },
    chatBoxPlace: () => chatBoxSection(app),
    avatars: () => api.avatars().then((l) => l.map((a) => ({ id: a.id, name: a.name, source: a.source, thumb: a.thumbnail ? api.fileUrl(a, a.thumbnail) : null }))),
    openChatHub: () => openChatHub(),
    marks: readMarks,
    setMarks: writeMarks,
    close,
  };
}

/** Open "Set up my chat & stream". `step` jumps to a step, `platform` straight to connecting that platform; without
 *  either it starts at the first step that isn't done yet. */
export function openStreamSetup(app: App, opts: StreamSetupDetail = {}) {
  if (!document.getElementById('ss-dlg-style')) document.head.append(h('style', { id: 'ss-dlg-style' }, DLG_CSS));
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.className = 'ss-dlg';
    dlg.setAttribute('aria-label', 'Set up my chat & stream');
    dlg.addEventListener('close', () => {
      handle?.destroy(); handle = null;
      // Settings → Setup helpers reads the classic wizard state (src/ui/wizard.ts 'vtp.wiz.<id>'): keep it in step
      const sum = streamSetupSummary(app);
      const done = (['platforms', 'connect', 'alerts', 'screen'] as const).slice(0, sum.done);
      try { localStorage.setItem('vtp.wiz.chat', JSON.stringify({ step: sum.ready ? null : sum.firstOpen, done, skipped: [], finished: sum.ready, at: Date.now() })); } catch { /* storage off */ }
      document.dispatchEvent(new CustomEvent('vtp-wizard', { detail: { id: 'chat', finished: sum.ready } }));
    });
    document.body.append(dlg);
  }
  const host = h('div', { class: 'ss-host' });
  dlg.replaceChildren(host);
  if (!dlg.open) dlg.showModal();
  const close = () => dlg?.close();
  handle?.destroy(); handle = mountStreamSetup(host, studioHost(app, close), { startAt: opts.step, platform: opts.platform });
}
export const streamSetupOpen = () => !!dlg?.open;

/** How far the chat set-up is (for a badge or "Chat: 2 of 4 done"). */
export function streamSetupSummary(app: App) { return setupSummary(app.scene.chat.status, app.scene.chat.events, readMarks()); }

/** The studio answers `vtp:stream-setup` (the Live panel's "Set up" button, other pages' links). Call once. */
let installed = false;
export function installStreamSetupEvent(app: App) {
  if (installed) return;
  installed = true;
  document.addEventListener(STREAM_SETUP_EVENT, (e) => {
    e.preventDefault();
    const d = ((e as CustomEvent).detail ?? {}) as StreamSetupDetail;
    openStreamSetup(app, { step: d.step, platform: d.platform });
  });
}
