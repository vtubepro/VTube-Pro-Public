// The one-time, non-blocking question for GPU lip sync: shown once, when the helper says this PC has an RTX 50-series card with the
// Audio2Face files installed and the owner was never asked (src/tracking/lipEngine.ts). A small card in the toast corner: it blocks
// nothing, starts nothing by itself, and goes away after a while (it is asked again next time only if nobody answered).
// [Turn on] = the owner's yes, kept on the helper (config/gpu.json) so it stays on; [Not now] = no, kept too (never asked again;
// Tracking -> GPU lip sync still turns it on by hand). The helper refuses to start it while OBS is streaming.
import type { App } from '../app.ts';
import { button, h, toast } from './dom.ts';

export const A2F_PROMPT_TEXT = 'Your NVIDIA card can run better lip sync. Turn it on?';
export const A2F_CHIP_TEXT = 'GPU lip sync is ready \u2014 Start';
let shown = false;
let chipShown = false;
/** Test hook: forget what was shown on this page. */
export function resetA2fPrompts() { shown = false; chipShown = false; }

/** The small non-blocking chip for an owner who already said yes but whose live state the helper can't tell (OBS not linked / not answering):
 *  nothing starts at studio load; the sidecar starts only on this click. */
export function showA2fChip(app: Pick<App, 'audio' | 'observer'>): HTMLElement | null {
  if (chipShown || app.observer || typeof document === 'undefined') return null;
  chipShown = true;
  let host = document.getElementById('toasts');
  if (!host) { host = h('div', { id: 'toasts' }); document.body.append(host); }
  const gone = () => { card.classList.add('out'); setTimeout(() => card.remove(), 400); chipShown = false; };
  const card: HTMLElement = h('div', { class: 'toast info a2f-chip', role: 'status', title: "VTube Pro can't tell whether you are live, so it waits for you." },
    h('span', null, 'GPU lip sync is ready \u2014 '),
    button('Start', () => { app.audio.a2f.startByClick(); gone(); }, 'primary'),
    button('Later', gone, 'ghost'));
  host.append(card);
  return card;
}

/** Show the prompt (once per page). Returns the element (tests / screenshots) or null. */
export function showA2fPrompt(app: Pick<App, 'audio' | 'observer'>): HTMLElement | null {
  if (shown || app.observer || typeof document === 'undefined') return null;
  shown = true;
  let host = document.getElementById('toasts');
  if (!host) { host = h('div', { id: 'toasts' }); document.body.append(host); }
  const close = () => { card.classList.add('out'); setTimeout(() => card.remove(), 400); };
  const card = h('div', { class: 'toast info a2f-prompt', role: 'status' },
    h('span', null, A2F_PROMPT_TEXT, ' '),
    button('Turn on', () => {
      app.audio.acceptA2f();
      close();
      toast('GPU lip sync is on. It starts when your microphone is on, never while you are live. Change it in Tracking -> GPU lip sync.', 'ok', 6000);
    }, 'primary'),
    button('Not now', () => { app.audio.declineA2f(); close(); }, 'ghost'));
  host.append(card);
  setTimeout(() => { if (card.isConnected) card.remove(); }, 45_000);
  return card;
}
