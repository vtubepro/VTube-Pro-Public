// The camera on a phone when the page leaves the screen (switching to TikTok, a call, the lock button):
//   * hidden → the studio stops the camera and the tracker itself (the phone would pause it anyway; nothing keeps
//     running unseen, and the camera light goes off)
//   * back → ONE card: "Your phone paused the camera while you were away. Tap to resume." One tap starts it again; if
//     that fails, the card stays with "That didn't work. Tap to try again."
//   * a camera that stops or is paused by the phone while the page is in front (another app took it) → the same card
// Phones only (src/mobile/phoneUi.ts installs it).
import type { App } from '../app.ts';
import { h } from '../ui/dom.ts';

/** Pure (tools/mobile2d_unit.ts): does a running camera need the resume card? */
export function cameraStalled(o: { trackingOn: boolean; visible: boolean; track: { readyState: string; muted: boolean; enabled: boolean } | null }): boolean {
  if (!o.trackingOn || !o.visible) return false;
  if (!o.track) return true;
  return o.track.readyState === 'ended' || o.track.muted || !o.track.enabled;
}

const CSS = `.pro2d-resume { position: fixed; inset: 0; z-index: 2147482000; display: grid; place-items: center; background: #0008; border: 0; padding: 24px; cursor: pointer; }
.pro2d-resume > div { width: min(88vw, 380px); background: var(--panel, #161b24); color: var(--text, #eef2f8); border-radius: 16px; padding: 20px; display: grid; gap: 10px;
  font-size: 16px; line-height: 1.4; text-align: center; box-shadow: 0 20px 60px #000a; }
.pro2d-resume b { font-size: 18px; } .pro2d-resume .btn { min-height: 48px; font-size: 16px; }`;

type Cam = Parameters<App['startTracking']>[0];
let card: HTMLElement | null = null;
/** What the watch did (tests: window.__vtpCameraWatch). */
const state = { shown: 0, resumed: 0, failed: 0, pausedOnHide: 0, last: '' };
/** the camera request to bring back (set when the page hid with the camera on, or the camera stalled) */
let paused: Cam | null = null;

const savedCam = (): Cam => {
  try { const s = JSON.parse(localStorage.getItem('vtp.tracking') ?? 'null'); if (s && typeof s === 'object') return s as Cam; } catch { /* no saved camera */ }
  return { width: 1280, height: 720, fps: 30 };
};

async function resume(app: App) {
  const cam = paused ?? savedCam();
  state.resumed++;
  setCard(app, 'Starting your camera…', null);
  if (app.trackingOn) app.stopTracking();   // (a dead track and the tracker's input let go first)
  await app.startTracking(cam);
  if (app.trackingOn) { paused = null; card?.remove(); card = null; return; }
  state.failed++;
  setCard(app, 'That didn’t work.', 'Tap to try again.');
}

function setCard(app: App, title: string, line: string | null) {
  card?.remove();
  card = h('button', { class: 'pro2d-resume', 'aria-label': line ? 'Resume the camera' : title, onClick: () => { if (line) void resume(app); } },
    h('div', null, h('b', null, title), line ? h('span', null, line) : null, line ? h('span', { class: 'btn primary' }, 'Resume the camera') : null));
  document.body.append(card);
}
function show(app: App, why: string) {
  if (card?.isConnected) return;
  state.shown++; state.last = why;
  setCard(app, 'Your phone paused the camera while you were away.', 'Tap to resume.');
}

export function installCameraWatch(app: App) {
  document.head.append(h('style', { id: 'pro2d-resume-css' }, CSS));
  (window as unknown as { __vtpCameraWatch?: typeof state }).__vtpCameraWatch = state;
  let timer = 0;
  const check = (why: string, wait = 1500) => {
    window.clearTimeout(timer);
    // (iOS often brings a paused camera back by itself a moment after the page shows: give it that moment)
    timer = window.setTimeout(() => {
      const t = app.video.track;
      if (cameraStalled({ trackingOn: app.trackingOn, visible: document.visibilityState === 'visible', track: t ? { readyState: t.readyState, muted: t.muted, enabled: t.enabled } : null })) { paused = savedCam(); show(app, why); }
    }, wait);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (!app.trackingOn) return;
      // stop the camera and the tracker now; keep the request so it comes back exactly as it was
      paused = savedCam();
      state.pausedOnHide++;
      app.stopTracking();
      try { localStorage.setItem('vtp.tracking', JSON.stringify(paused)); } catch { /* storage off */ }
      return;
    }
    if (paused) show(app, 'visible'); else check('visible');
  });
  window.addEventListener('pageshow', () => { if (paused) show(app, 'pageshow'); else check('pageshow'); });
  // the track itself: ended (the system took the camera) or muted (paused) while we are on screen
  let watched: MediaStreamTrack | null = null;
  const hook = () => {
    const t = app.video.track;
    if (t === watched) return;
    watched = t;
    if (!t) return;
    t.addEventListener('ended', () => { if (watched === t) check('ended', 300); });
    t.addEventListener('mute', () => { if (watched === t) check('mute', 2000); });
    t.addEventListener('unmute', () => { if (watched === t && card && !paused) { card.remove(); card = null; } });
  };
  app.on((what) => { if (what === 'tracking') hook(); });
  hook();
}
