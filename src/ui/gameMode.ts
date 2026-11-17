// "A game is using your graphics card" — the studio's side of stall mode (beta.13.5; research/tracking_gpu_rca/RCA.md P3).
// Zero effort: everything happens by itself and silently —
//   - stall mode (src/tracking/stallGuard.ts): the face moves to the processor, pose / hands are capped then follow, the
//     tracking chip says "Game mode" ("Catching up" with no evidence of the card: gameText.ts cardNamed; src/ui/shell.ts),
//     the avatar keeps living (src/tracking/stallLife.ts);
//   - no room preview runs meanwhile (src/ui/previewFrame.ts suspendPreview): it would render the room a second time on
//     the card the game holds; it comes back by itself afterwards;
//   - the helper's card reading (bus 'gpustat', server/gpuWatch.ts) keeps stall mode on while the card is busy.
// Only when tracking is STILL slow 20 s after all that (or one graphics-queue round trip takes over 100 ms:
// src/tracking/gpuSyncProbe.ts) one plain sentence, once per session, with one button: [Show me how] opens three short
// steps to cap the game's frame rate. An OBS page that only got a picture every few seconds and switched to a lighter look
// (bus 'obsstarve', src/stage/gfx/starve.ts) gets its own sentence, also once. "Don't show again" is remembered in this
// browser (localStorage vtp.gameNotice.off = '1').
import type { App } from '../app.ts';
import { sanitizeGpuStat, type GpuStat } from '../../shared/gpuStat.ts';
import { CAP_STEPS, cardNamed, gameNoticeText, stillSlow } from './gameText.ts';
import { gpuSync } from '../tracking/gpuSyncProbe.ts';
import { setPreviewPausedGpu, suspendPreview } from './previewFrame.ts';
import { h } from './dom.ts';

const OFF_KEY = 'vtp.gameNotice.off';
const STILL_SLOW_MS = 20000;
let card: HTMLElement | null = null;
let shownTracking = false, shownObs = false;
let gpu: GpuStat | null = null;

const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } };

function show(app: App, kind: 'tracking' | 'obs') {
  if (lsGet(OFF_KEY) === '1' || app.observer) return;
  if (kind === 'tracking' ? shownTracking : shownObs) return;
  if (kind === 'tracking') shownTracking = true; else shownObs = true;
  close();
  const t = gameNoticeText(kind, { gpu, waited: app.tracker.stallInfo().gpu });
  let host = document.getElementById('toasts');
  if (!host) { host = h('div', { id: 'toasts' }); document.body.append(host); }
  const steps = h('ol', { style: 'margin:8px 0 0 18px;padding:0;display:none;line-height:1.45' }, ...CAP_STEPS.map((s) => h('li', null, s)));
  const how: HTMLElement = h('button', { class: 'btn primary', onClick: () => { steps.style.display = ''; how.remove(); } }, 'Show me how');
  const ok = h('button', { class: 'btn', onClick: () => close() }, 'OK');
  const never = h('button', { class: 'btn ghost', style: 'font-size:12px', onClick: () => { lsSet(OFF_KEY, '1'); close(); } }, 'Don’t show again');
  card = h('div', { class: 'toast warn game-mode', role: 'status', 'data-ui': 'game-mode', style: 'max-width:min(420px, calc(100vw - 32px));box-sizing:border-box' },
    h('div', null, t), steps,
    h('div', { style: 'display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;margin-top:8px' }, never, ok, how));
  host.append(card);
}

function close() {
  const c = card; card = null;
  if (!c) return;
  c.classList.add('out');
  setTimeout(() => c.remove(), 400);
}

export function installGameMode(app: App) {
  let since = 0;
  app.tracker.onGameMode = (on, info) => {
    suspendPreview(on, cardNamed(info.gpu, gpu));
    since = on ? performance.now() : 0;
  };
  // still slow 20 s after the automatic steps? (checked every 2 s while stall mode lasts; the paused preview's line
  // follows what stall mode learned meanwhile)
  window.setInterval(() => {
    if (!since || !app.tracker.gameMode) return;
    const st = app.tracker.stallInfo();
    setPreviewPausedGpu(cardNamed(st.gpu, gpu));
    if (performance.now() - since < STILL_SLOW_MS) return;
    if (stillSlow({ hz: st.hz, goal: st.goal, starve: app.starveMeter.w, gpuSyncMs: gpuSync.ms })) show(app, 'tracking');
  }, 2000);
  app.bus.on((m) => {
    if (m.type === 'gpustat') {
      // (the tracker judges 'busy' from the reading's age on every use: a stale one says nothing — review round 1)
      gpu = sanitizeGpuStat(m.s);
      app.tracker.gpuStat = gpu;
    } else if (m.type === 'obsstarve') {
      if (m.level > 0 && m.acted) show(app, 'obs');
    }
  });
}
