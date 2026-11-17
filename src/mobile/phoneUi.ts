// The studio on a phone (owner: "some people use their phones for Live2D … we don't need a helper for mobile, they just
// need to import their model"). One install call from src/main.ts; everything phone-only lives under src/mobile/:
//   * html.vtp-phone: no helper / OBS calls to action (a phone has no helper), a landscape layout that works, the
//     camera picture as a small corner thumbnail that never covers the avatar, big enough touch targets
//   * "Go live" on the stage: Pro2D show mode (src/mobile/showMode.ts)
//   * the phone camera profile's recovery (src/mobile/cameraWatch.ts)
// Context-loss recovery ("Reload in low detail", src/mobile/lowDetail.ts) is installed for every studio.
import type { App } from '../app.ts';
import { h } from '../ui/dom.ts';
import { isPhone } from './device.ts';
import { installLowDetail } from './lowDetail.ts';
import { installPersistNote } from './persistNote.ts';

const CSS = `
/* ---- no helper, no OBS on a phone ---- */
html.vtp-phone .vw-bar .vw-btn:not(a), html.vtp-phone .vw-upd, html.vtp-phone .vw-old,
html.vtp-phone #topbar .chip[data-t="Not in OBS"], html.vtp-phone #topbar .tb-air,
html.vtp-phone #tabs .rail-btn[aria-label="OBS & stream"], html.vtp-phone #tabs .rail-btn[aria-label="Party"],
html.vtp-phone #showdock .sd-airg > span[data-dup], html.vtp-phone .hm-copy { display: none !important; }
/* messages: one at a time in a strip over the top bar (above the stage, inside the safe area), two lines; a tap
   opens the whole message. Show mode puts the ones that need you at the bottom instead (src/mobile/showMode.ts). */
html.vtp-phone #toasts { top: calc(env(safe-area-inset-top, 0px) + 4px) !important; left: 8px !important; right: 8px !important; gap: 4px; z-index: 2147483200; }
html.vtp-phone #toasts > .toast { max-width: none; padding: 6px 10px; font-size: 12.5px; line-height: 1.3; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
html.vtp-phone #toasts > .toast.open { -webkit-line-clamp: unset; display: block; }
html.vtp-phone #toasts > .toast:not(:last-child) { display: none; }
/* the camera picture: a small corner thumbnail, never over the avatar */
html.vtp-phone #campip { width: 84px !important; height: auto !important; max-height: 84px; left: auto !important; right: 8px !important; top: auto !important; bottom: 8px !important; border-radius: 10px; opacity: .9; }
html.vtp-phone #campip .pip-cap { display: none; }
/* touch: the stage bar's buttons at least 40 px tall */
html.vtp-phone #viewport .viewbar .btn { min-height: 40px; padding-left: 10px; padding-right: 10px; }
/* the tabletop launcher: a small round button low in the corner (it sat over the panel's text on a phone) */
html.vtp-phone .tt-launch { bottom: 64px !important; right: 8px !important; padding: 9px !important; gap: 0 !important; font-size: 0 !important; }
/* the software-3D card: right of the menu rail and above the bottom bar, never over the menu buttons */
html.vtp-phone .softgl-note { left: 76px !important; right: 8px !important; width: auto !important; top: auto !important; bottom: calc(env(safe-area-inset-bottom, 0px) + 56px) !important; max-height: 55vh !important; }
html.vtp-phone .pro2d-go { background: var(--accent, #3fbf6f) !important; color: var(--accent-ink, #04130a) !important; font-weight: 700; }
/* ---- landscape phone: stage left, menus right, both usable ---- */
@media (orientation: landscape) and (max-height: 540px) {
  html.vtp-phone #app { grid-template-columns: 60px minmax(0, 1fr) minmax(0, 44%) !important; grid-template-rows: 48px minmax(0, 1fr) auto !important; height: 100dvh; }
  html.vtp-phone #topbar { grid-column: 1 / -1 !important; grid-row: 1 !important; }
  html.vtp-phone #tabs { grid-column: 1 !important; grid-row: 2 / 4 !important; overflow-y: auto; padding: 6px 4px; }
  html.vtp-phone #tabs .rail-btn { width: 52px; height: 46px; }
  html.vtp-phone #viewport { grid-column: 2 !important; grid-row: 2 !important; min-height: 0; height: auto !important; max-height: none !important; }
  html.vtp-phone #panel { grid-column: 3 !important; grid-row: 2 / 4 !important; min-height: 0; }
  html.vtp-phone #showdock { grid-column: 2 !important; grid-row: 3 !important; max-height: 44px; overflow-x: auto; overflow-y: hidden; }
}
`;

/** The import dialog's format list on a phone: 2D first, what opens here, nothing that needs a PC. */
export function phoneImportFormats(fmt: (b: string, s: string) => HTMLElement): HTMLElement {
  return h('div', { class: 'dimp-formats' },
    fmt('Pro2D (.vtp2)', 'A model made or saved in VTube Pro.'),
    fmt('Layered picture (.psd)', 'We rig it for you: it moves with your face.'),
    fmt('PNGTuber (PNG, GIF)', 'Two pictures: mouth closed and mouth open.'),
    fmt('Model from another 2D app (.zip)', 'Its .zip, or all of its files (.model3.json + .moc3, or .inx/.inp). Opens right here.'),
    fmt('VRoid / VRM (.vrm, .glb)', '3D models open here too.'));
}

let done = false;
export function installPhone(app: App) {
  if (done) return;
  done = true;
  if (!app.observer) { installLowDetail(app); installPersistNote(); }
  if (!isPhone()) return;
  document.documentElement.classList.add('vtp-phone');
  document.head.append(h('style', { id: 'vtp-phone-css' }, CSS));
  // "Go live" on the stage bar: Pro2D show mode (the phone's way to stream: full screen, then share the screen)
  const bar = document.querySelector('#viewport .viewbar');
  if (bar && !app.observer) {
    const go = h('button', { class: 'btn pro2d-go', title: 'Your avatar full screen, ready to share in TikTok, YouTube or Twitch', onClick: () => void import('./showMode.ts').then((m) => m.openShowMode(app)) }, 'Go live');
    bar.prepend(go);
    // "Hide menus (H)" can only be undone with a keyboard (H / Escape): a phone would be stuck. Go live is the phone's
    // clean view (a tap brings the controls back).
    for (const b of bar.querySelectorAll('button')) if (/^Hide menus/.test(b.textContent ?? '')) (b as HTMLElement).style.display = 'none';
  }
  if (!app.observer) void import('./cameraWatch.ts').then((m) => m.installCameraWatch(app));
  // a tap on a (two-line) message opens all of it
  document.addEventListener('click', (e) => { const t = (e.target as HTMLElement | null)?.closest?.('#toasts > .toast'); if (t) t.classList.toggle('open'); });
}
