// Autopilot first run (ZERO-EFFORT RULE): the studio does the obvious next thing by itself and says so in one sentence.
//  * a brand-new install (no saved scene: GET /api/autopilot/first-run) starts in the starter room, never an empty stage;
//  * React with nothing on the big screen yet: one card with "Pick a window" (a click is needed: browsers only open the
//    window picker from a click);
//  * the camera / mic recovery (src/ui/autopilot/media.ts) learns how to start them from here.
// Mounted once from src/main.ts (mountFirstRun). Never runs in an ?observer=1 studio. Nothing here saves anything by
// itself except the starter room on a brand-new install.
import type { App } from '../../app.ts';
import { h, toast } from '../dom.ts';
import { startCamera, startMic } from '../liveOps.ts';
import { setMediaHost } from './media.ts';
import { starterRoom } from './firstRunRoom.ts';
export { starterRoom } from './firstRunRoom.ts';

const ls = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* off */ } } };

export function mountFirstRun(app: App) {
  if (app.observer) return;
  setMediaHost({ app, start: (k) => (k === 'camera' ? startCamera(app) : startMic(app)) });
  void starterRoomOnce(app);
  watchReact(app);
}

async function starterRoomOnce(app: App) {
  if (ls.get('vtp.autopilot.room') === 'done') return;
  let fresh = false;
  try { fresh = !!(await (await fetch('/api/autopilot/first-run', { cache: 'no-store' })).json() as { freshScene?: boolean }).freshScene; } catch { return; }
  if (!fresh) { ls.set('vtp.autopilot.room', 'done'); return; }
  const S = app.scene;
  for (let i = 0; i < 60 && !S.scenes.length; i++) await new Promise((r) => setTimeout(r, 500));
  await new Promise((r) => setTimeout(r, 1500)); // the saved state is read by now
  if (S.state.sceneId || !S.canEdit) { ls.set('vtp.autopilot.room', 'done'); return; }
  const id = starterRoom(S.scenes);
  if (!id) return;
  S.setScene(id);
  ls.set('vtp.autopilot.room', 'done');
  toast(`We put you in the ${S.scenes.find((s) => s.id === id)?.name ?? 'starter'} room. Pick another one any time in Room.`, 'ok', 7000);
}

// ---------------------------------------------------------------- React: something on the big screen
const CSS = `.ap-react{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9040;width:min(540px,calc(100vw - 32px));display:flex;gap:12px;align-items:center;padding:12px 14px;border-radius:14px;
  border:1px solid rgb(108 199 245 / .45);background:var(--bg2,#0b0f12);color:var(--text);box-shadow:0 20px 60px -20px #000c;font-size:14px}
.ap-react .t{flex:1;min-width:0;line-height:1.4}.ap-react .t small{display:block;color:var(--dim);font-size:12.5px}
.ap-react button{font:600 13px/1 inherit;border-radius:99px;padding:9px 13px;border:1px solid var(--line);background:var(--panel);color:var(--text);cursor:pointer;white-space:nowrap}
.ap-react button.primary{background:var(--accent);color:var(--accent-ink,#0b1410);border-color:transparent}
@media (max-width:520px){.ap-react{flex-wrap:wrap}.ap-react .t{flex-basis:100%}}`;
function watchReact(app: App) {
  const S = app.scene;
  let card: HTMLElement | null = null;
  let dismissed = false;
  const hide = () => { card?.remove(); card = null; };
  const check = () => {
    const react = S.effective.mode === 'react' && !!S.effective.sceneId;
    const passthrough = S.effective.screen?.mode === 'passthrough';
    if (!react || S.capturing || passthrough || dismissed || S.role === 'guest') { hide(); if (!react) dismissed = false; return; }
    if (card) return;
    if (!document.getElementById('ap-react-style')) document.head.append(h('style', { id: 'ap-react-style' }, CSS));
    card = h('div', { class: 'ap-react', role: 'status', 'data-ui': 'react-pick' },
      h('span', { class: 't' }, 'What should the big screen show?', h('small', null, 'Pick the game or video window. Your viewers see it on the screen in your room.')),
      h('button', { class: 'primary', onClick: async () => {
        try { await S.pickSource(); hide(); toast('On the big screen now. Change it any time in Show.', 'ok', 5000); }
        catch (e) { if ((e as Error).name !== 'NotAllowedError' && (e as Error).name !== 'AbortError') toast('The window picker didn’t open. Try again, or pick it in Show → Screen.', 'warn', 6000); }
      } }, 'Pick a window'),
      h('button', { onClick: () => { dismissed = true; hide(); } }, 'Not now'));
    document.body.append(card);
  };
  S.on(() => check());
  setInterval(check, 2000);
}
