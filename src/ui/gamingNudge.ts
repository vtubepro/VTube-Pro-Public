// "A fullscreen game is running: run face tracking on the processor (For games)?" — one question, one click, once.
// Only for people who picked the graphics card for tracking by hand (Tracking processor = Graphics card): with Auto (the
// default) stall mode already moves the models off the card by itself the moment a game holds it (src/tracking/stallGuard.ts),
// so there is nothing to ask. The helper looks for the game window (GET /api/game/fullscreen: one read-only Windows query,
// cached 30 s) only when the card has been busy for 10 s or stall mode is on, and this module asks at most every 5 minutes.
// "Use For games" sets the same setting as Tracking → Where tracking runs → For games (localStorage vtp.trackDelegate =
// 'nogpu'); "Don't ask again" is remembered in this browser (vtp.gamingNudge.off).
import type { App } from '../app.ts';
import { gpuBusy, sanitizeGpuStat, type GpuStat } from '../../shared/gpuStat.ts';
import { nudgeDecision, nudgeText } from '../../shared/gamingCapture.ts';
import { h, toast } from './dom.ts';

const OFF_KEY = 'vtp.gamingNudge.off', POLICY_KEY = 'vtp.trackDelegate';
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } };

export function installGamingNudge(app: App) {
  if (app.observer) return;
  let gpu: GpuStat | null = null, busySince = 0, lastAsk = 0, shown = false, asking = false;
  app.bus.on((m) => {
    if (m.type !== 'gpustat') return;
    gpu = sanitizeGpuStat(m.s);
    if (gpuBusy(gpu) === true) { if (!busySince) busySince = Date.now(); } else busySince = 0;
  });
  window.setInterval(() => {
    if (asking || shown) return;
    const now = Date.now();
    const go = nudgeDecision({
      helper: true, trackingOn: app.trackingOn, policy: (lsGet(POLICY_KEY) ?? 'auto').toLowerCase(),
      busyMs: busySince ? now - busySince : 0, stall: app.tracker.gameMode, dismissed: lsGet(OFF_KEY) === '1', shownThisSession: shown, sinceLastAskMs: now - lastAsk || 1e12,
    });
    if (!go) return;
    asking = true; lastAsk = now;
    void fetch('/api/game/fullscreen', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((j: { game?: { exe?: string } | null } | null) => {
      if (j?.game) show(app, String(j.game.exe ?? ''));
    }).catch(() => { /* no helper answer: no question */ }).finally(() => { asking = false; });
  }, 5000);
  function show(a: App, exe: string) {
    shown = true;
    let host = document.getElementById('toasts');
    if (!host) { host = h('div', { id: 'toasts' }); document.body.append(host); }
    const close = () => { card.classList.add('out'); setTimeout(() => card.remove(), 400); };
    const card = h('div', { class: 'toast warn game-mode', role: 'status', 'data-ui': 'gaming-nudge', style: 'max-width:min(420px, calc(100vw - 32px));box-sizing:border-box' },
      h('div', null, nudgeText(exe)),
      h('div', { style: 'display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;margin-top:8px' },
        h('button', { class: 'btn ghost', style: 'font-size:12px', onClick: () => { lsSet(OFF_KEY, '1'); close(); } }, 'Don’t ask again'),
        h('button', { class: 'btn', onClick: close }, 'Not now'),
        h('button', { class: 'btn primary', onClick: () => { lsSet(POLICY_KEY, 'nogpu'); a.tracker.refreshPolicy?.(); toast('Face tracking now runs on the processor (Tracking → Where tracking runs → For games)', 'ok', 5000); close(); } }, 'Use For games')));
    host.append(card);
  }
}
