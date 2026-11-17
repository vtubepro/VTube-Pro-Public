// When a phone runs out of graphics memory. Two ways it shows:
//   * the stage's WebGL context is lost (iOS does this to big pages, especially after the app was in the background):
//     the picture freezes. We say so in one sentence: on a phone "Reload in low detail" (or "Full detail" when low
//     detail is already on) and "Reload"; on a desktop only "Reload" (a desktop never turns low detail on). Never an
//     automatic reload, so a page that keeps running out can't loop.
//   * iOS kills the whole tab and Safari loads it again (it can do this in a loop with a heavy model). A start-up
//     marker notices two starts in a row that never got going; then the studio opens in low detail by itself and says
//     so (once). "Got going" = the avatar has DRAWN and 20 s have passed since (a slow decode that dies counts as a
//     failed start; leaving the page before that is no proof either way, so it doesn't count as a good start).
// Low detail = 2D models decode at half the phone's texture budget (src/avatar/flat/rig2d/textureBudget.ts) and the
// studio preview draws fewer pixels. Only this page changes: nothing is written into the room's saved graphics
// settings, OBS pages are untouched. The way back: "Full detail" on the banner, in show mode's More, and on the
// graphics panel (lowDetailRow).
import type { App } from '../app.ts';
import { button, h, toast } from '../ui/dom.ts';
import { isPhone, lowDetail, setLowDetail } from './device.ts';

const BOOT = 'vtp.bootMark';
/** A start counts as "got going" this long after the avatar first drew. */
export const STABLE_MS = 20_000;

/** Pure (tools/mobile2d_unit.ts): after this start, low detail on? `prev` = the marker the last start left. */
export function bootDecision(prev: { t: number; n: number; ok: boolean } | null, now: number): { n: number; goLow: boolean } {
  if (!prev || prev.ok || now - prev.t > 10 * 60_000) return { n: 1, goLow: false };
  const n = prev.n + 1;   // the last start never got going (killed while loading)
  return { n, goLow: n >= 3 };
}

/** Low detail for THIS page only: a smaller studio preview (never the room's saved graphics settings). */
function applyLow(app: App) {
  try { app.stage.setPreviewCap(360_000); app.stage.renderScale = 0.75; app.stage.resize(); } catch { /* old stage */ }
}

const reloadFull = () => { setLowDetail(false); location.reload(); };

let banner: HTMLElement | null = null;
function showLost() {
  if (banner?.isConnected) return;
  const phone = isPhone(), low = lowDetail();
  const btns: HTMLElement[] = [];
  if (phone && !low) btns.push(h('button', { class: 'btn primary', onClick: () => { setLowDetail(true); location.reload(); } }, 'Reload in low detail'));
  btns.push(h('button', { class: phone && !low ? 'btn' : 'btn primary', onClick: () => location.reload() }, 'Reload'));
  if (low) btns.push(h('button', { class: 'btn', onClick: reloadFull }, 'Full detail'));
  banner = h('div', { class: 'pro2d-lost', role: 'alertdialog', 'aria-live': 'assertive' },
    h('b', null, phone ? (low ? 'Your phone ran out of graphics memory again.' : 'Your phone ran out of graphics memory, so the picture stopped.') : 'The browser lost the 3D picture (graphics memory).'),
    h('span', null, phone ? (low ? 'Close other apps, then reload. Your model is still saved.' : 'Reload in low detail to keep going. Your model is still saved.') : 'Reload the page to get it back. Your models are still saved.'),
    h('div', { class: 'pro2d-lost-btns' }, ...btns));
  document.body.append(banner);
}

/** The graphics panel's line while low detail is on (one-line hook in src/ui/gfxPanel.ts): what it is + Full detail. */
export function lowDetailRow(): HTMLElement | null {
  if (!lowDetail()) return null;
  return h('div', { class: 'note', style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:4px 0' },
    h('span', null, 'Low detail is on (this device ran out of graphics memory before): 2D models use smaller pictures.'),
    button('Full detail', reloadFull));
}

/** Resolves once the avatar has been built and two frames have drawn it. */
function avatarDrawn(app: App): Promise<void> {
  return new Promise((res) => {
    const check = () => {
      const rt = app.runtime as unknown as { flat?: { source?: { version?: number } } } | null;
      const ready = !!rt && (!rt.flat || (rt.flat.source?.version ?? 0) > 0);
      if (ready) requestAnimationFrame(() => requestAnimationFrame(() => res()));
      else window.setTimeout(check, 500);
    };
    check();
  });
}

const CSS = `.pro2d-lost { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 2147483000; width: min(92vw, 420px);
  background: var(--panel, #161b24); color: var(--text, #eef2f8); border: 1px solid var(--warn, #f5c451); border-radius: 14px; padding: 18px; display: grid; gap: 8px;
  box-shadow: 0 20px 60px #000a; font-size: 15px; line-height: 1.4; }
.pro2d-lost-btns { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; } .pro2d-lost .btn { min-height: 44px; padding: 0 16px; }`;

export function installLowDetail(app: App) {
  document.head.append(h('style', { id: 'pro2d-lost-css' }, CSS));
  // ---- start-up marker (phones only: a tab iOS keeps killing while it loads)
  if (isPhone()) {
    let prev: { t: number; n: number; ok: boolean } | null = null;
    try { prev = JSON.parse(localStorage.getItem(BOOT) ?? 'null'); } catch { prev = null; }
    const d = bootDecision(prev, Date.now());
    try { localStorage.setItem(BOOT, JSON.stringify({ t: Date.now(), n: d.n, ok: false })); } catch { /* storage off */ }
    const good = () => { try { localStorage.setItem(BOOT, JSON.stringify({ t: Date.now(), n: 0, ok: true })); } catch { /* storage off */ } };
    // (ONLY this counts: iOS fires pagehide when you switch apps too, so a pagehide is no proof the start got going)
    void avatarDrawn(app).then(() => window.setTimeout(good, STABLE_MS));
    if (d.goLow && !lowDetail()) {
      setLowDetail(true);
      window.setTimeout(() => toast('Your phone closed the studio while it was loading, so it now runs in low detail. Go live → More → Full detail turns it off.', 'warn', 12000), 2500);
    }
  }
  if (lowDetail()) applyLow(app);
  // ---- the stage's WebGL context lost: say it, offer the way out, never reload by itself
  const canvas = app.stage.renderer.domElement;
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); showLost(); });
  canvas.addEventListener('webglcontextrestored', () => { banner?.remove(); banner = null; });
}
