// Simple → Tracking: "Where tracking runs" (owner, 2026-10-11: gamers did not know the setting existed — it sat under
// Tracking → Fine tuning). Same setting as Advanced → Tracking → Fine tuning → Tracking processor (localStorage
// vtp.trackDelegate: none = Auto, 'gpu', 'cpu', 'nogpu' = Processor (for games)), applied at once (Tracker.refreshPolicy: one model at a time, no gap).
// The live line says where the face runs now and whether a game pushed it to the processor (game mode).
import type { App } from '../app.ts';
import { TRACK_DELEGATE_KEY, parseDelegatePolicy, type DelegatePolicy } from '../tracking/delegatePolicy.ts';
import { card, live, seg } from './bits.ts';
import { h, toast } from './dom.ts';
import { cardNamed, processorStatus } from './gameText.ts';

const read = (): DelegatePolicy => { try { return parseDelegatePolicy(localStorage.getItem(TRACK_DELEGATE_KEY)); } catch { return 'auto'; } };

export function trackProcessorCard(app: App): HTMLElement {
  const line = h('p', { class: 'note', style: 'margin:8px 2px 0' });
  const box = h('div');
  const paint = () => {
    box.replaceChildren(seg<DelegatePolicy>([['auto', 'Auto', 'fastest right now'], ['nogpu', 'For games', 'body and hands 10 a second'], ['cpu', 'Processor', 'uses the graphics card less'], ['gpu', 'Graphics card']], read(), (v) => {
      try { if (v === 'auto') localStorage.removeItem(TRACK_DELEGATE_KEY); else localStorage.setItem(TRACK_DELEGATE_KEY, v); } catch { /* storage blocked */ }
      app.tracker.refreshPolicy();
      if (app.trackingOn) toast(v === 'nogpu' ? 'Tracking moves to the processor now, with body and hands 10 times a second.' : v === 'cpu' ? 'Tracking moves to the processor now.' : v === 'gpu' ? 'Tracking moves to the graphics card now.' : 'Auto: tracking runs wherever it is faster right now.', 'ok', 4500);
      paint();
    }));
  };
  paint();
  const status = () => {
    const roles = (app.tracker.models() as { roles?: { face?: { delegate: string } | null } }).roles;
    line.textContent = processorStatus({ tracking: app.trackingOn, face: roles?.face ?? null, gameMode: app.tracker.gameMode, gpu: cardNamed(app.tracker.stallInfo().gpu, app.tracker.gpuStat) });
  };
  status();
  live(() => { if (!line.isConnected) return false; status(); return true; });
  return card('Where tracking runs', 'Playing games on this PC? Pick For games: your face runs on the processor and never waits for the graphics card, and body and hands update 10 times a second, so a busy game slows your tracking least.', box, line);
}
