// On-stream photosensitivity notice. The flash limit (≤ 3 flashes a second, WCAG 2.3.1) is on by default; a streamer
// may turn it off (Scene tab → Lights). While it is off AND the show is actually flashing faster than the limit, the
// OBS page can show a small "Flashing lights" notice in the corner, and festival stages a card / badge on their walls,
// when the streamer turned on lights.warnOnStream (owner 2026-10-11: every notice can be turned off; default off).
// Pure DOM, no-op outside a browser.

/** The lights settings this reads (shared/types.ts SceneLightsState). */
export interface FlashNoticeSettings { safe?: boolean; warnOnStream?: boolean }
/** May the stream show a flashing-lights notice at all? Only with the flash limit off AND the notice switched on. */
export const flashNoticeWanted = (l: FlashNoticeSettings | null | undefined): boolean => l?.safe === false && l?.warnOnStream === true;
/** The corner pill: wanted + the show really flashed faster than the limit within the last 8 s. */
export const flashPillOn = (l: FlashNoticeSettings | null | undefined, sinceOverMs: number): boolean => flashNoticeWanted(l) && sinceOverMs < 8000;
/** The festival walls: a card for 8 s after the notice became wanted (`cardUntil`), then a badge; 'off' when not wanted. */
export const wallNotice = (l: FlashNoticeSettings | null | undefined, nowMs: number, cardUntil: number): 'off' | 'card' | 'badge' =>
  !flashNoticeWanted(l) ? 'off' : nowMs < cardUntil ? 'card' : 'badge';

let el: HTMLElement | null = null;
let shown = false;

export function flashWarning(on: boolean) {
  if (on === shown || typeof document === 'undefined') return;
  shown = on;
  if (on && !el) {
    el = document.createElement('div');
    el.setAttribute('role', 'status');
    el.textContent = '⚠ Flashing lights';
    Object.assign(el.style, {
      position: 'fixed', left: '1.2vw', bottom: '1.6vh', zIndex: '2147483000', pointerEvents: 'none',
      font: '600 max(12px, 1.25vh)/1.2 system-ui, "Segoe UI", sans-serif', color: '#fff', letterSpacing: '0.02em',
      background: 'rgba(20, 16, 28, 0.72)', border: '1px solid rgba(255, 210, 74, 0.85)', borderRadius: '999px',
      padding: '0.45vh 1vh', boxShadow: '0 0 0.8vh rgba(0,0,0,0.5)', transition: 'opacity 400ms', opacity: '0',
    } as CSSStyleDeclaration);
    document.body.appendChild(el);
  }
  if (el) el.style.opacity = on ? '1' : '0';
}
