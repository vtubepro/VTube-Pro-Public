// view.html: the page the other streamer pastes into OBS as a Browser Source (view.html#r=..&i=..&d=..&q=.., served by the streamer's own VTube Pro or relay).
// It shows the guest's avatar on a see-through background, silently (voice goes over Discord). Plain DOM + WebGL, no framework,
// no calls to any VTube Pro helper: the only network it uses is the page itself and the relay socket (+ the media connection).
// Spec: docs/GUEST_BROWSER_SOURCE.md sections 2 to 4 and 6. Test hooks: window.__gsView and the extra fragment key st=1.
import { GS_LADDER, derivePeerKey, gsTier, newViewerInst, newViewerKey, parseViewHash, GS_KEY_RX, type GsViewerState, type GsQuality } from '../../shared/guestFeed.ts';
import { GsViewLink, type GsCfg } from './link.ts';
import { createRenderer, type GsRenderer } from './render.ts';
import { mountPlate, plateText } from './status.ts';

const KEY_STORE = 'vtp.gv.key';
const win = window as unknown as Record<string, unknown>;

/** The key identifies "this OBS install" for the sender's link lock. Kept in the page's storage; with storage off it lives in memory (such an OBS asks again after every reload). */
function viewerKey(override: string | null): string {
  if (override) return override;
  try {
    const k = localStorage.getItem(KEY_STORE);
    if (k && GS_KEY_RX.test(k)) return k;
    const n = newViewerKey();
    localStorage.setItem(KEY_STORE, n);
    return n;
  } catch { return newViewerKey(); }
}

async function boot() {
  const app = document.getElementById('app') ?? document.body;
  const hash = location.hash;
  const link = parseViewHash(hash);
  const stampTest = new URLSearchParams(hash.replace(/^#/, '')).get('st') === '1';
  const plate = mountPlate(app);
  const hooks: Record<string, unknown> = { state: () => phase, text: () => text, link: () => link };
  win.__gsView = hooks;
  let phase: GsViewerState = 'connecting', text = '';
  const say = (p: GsViewerState, picture: 'none' | 'held' | 'fresh' = 'none', lost = false) => { phase = p; text = plateText(p, picture, lost, name); plate.set(text); };
  let name = link?.name ?? '';
  if (!link) { say('badLink'); return; }
  if (!link.pub) { say('oldLink'); return; }   // a link from before the guest's signing key: nothing could be verified, so nothing is connected (docs/GUEST_BROWSER_SOURCE.md, Security)
  const hasRtc = typeof RTCPeerConnection === 'function' && typeof WebSocket === 'function' && typeof RTCPeerConnection.prototype.addTransceiver === 'function';
  if (!hasRtc || !globalThis.crypto?.subtle) { say('tooOld'); return; }

  // the picture: a canvas that fills the source (object-fit: contain) + the muted video that feeds it (in the DOM, 1 px, barely visible)
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;object-fit:contain;background:transparent';
  const video = document.createElement('video');
  video.muted = true; video.defaultMuted = true; video.playsInline = true; video.autoplay = true;
  video.setAttribute('muted', ''); video.setAttribute('playsinline', '');
  video.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:.01;pointer-events:none;z-index:-1';
  app.prepend(canvas, video);
  const r: GsRenderer = createRenderer(canvas, video, { q: link.q, delayMs: link.delayMs, stamp: stampTest });
  if (!r.ok) { say('noGl'); return; }

  const log: string[] = [];
  const inst = newViewerInst();
  // the identity the sender (and the relay) see is derived per link: the key kept in this page's storage never leaves the page, and this OBS is a different
  // identity on every link
  const key = await derivePeerKey(viewerKey(link.key), link.id);
  const obs = !!(win as { obsstudio?: unknown }).obsstudio;
  let visible = true;
  const shown = () => visible && document.visibilityState === 'visible';
  const vl = new GsViewLink(link, key, inst, {
    onPhase: (p) => { phase = p; refresh(); },
    onTrack: (t) => { r.attach(t); },
    onNoTrack: () => { r.detach(); },
    onCfg: (c: GsCfg) => { if (c.n) name = c.n; r.configure({ delayMs: c.d, q: c.q, fps: c.fps, w: c.w, h: c.h }); refresh(); },
    onTerminal: () => { r.clear(); },
    frames: () => r.frames(),
    log: (w) => { (log as string[]).push(`${Math.round(performance.now())} ${w}`); if (log.length > 200) log.shift(); },
  }, obs);

  let wasLost = false;
  function refresh() {
    const p = r.picture(), lostNow = r.hold.lost && p === 'none';
    if (lostNow && !wasLost) log.push(`${Math.round(performance.now())} lost`);   // (AC31 reads this: the hold ran out)
    wasLost = lostNow;
    say(vl.phase, p, r.hold.lost);
  }
  // the hold timer: 8 seconds without frames, then the canvas goes clear and the sentence shows
  window.setInterval(() => { if (r.picture() === 'none' && r.hasShown) r.blank(); refresh(); }, 500);

  const syncVis = () => { const v = shown(); r.setVisible(v); vl.setVisible(v); };
  document.addEventListener('visibilitychange', syncVis);
  window.addEventListener('obsSourceVisibleChanged', (e) => { visible = (e as CustomEvent<{ visible?: boolean }>).detail?.visible !== false; syncVis(); });
  window.addEventListener('pagehide', () => vl.leave());

  Object.assign(hooks, {
    peer: vl.peer, key, inst, log,
    pc: () => vl.pc, policy: () => vl.policy, cfg: () => vl.cfg, stats: () => vl.lastStats, channelOpen: () => vl.channelOpen,
    frames: () => r.frames(), snapshot: () => r.snapshot(), stamp: () => r.stamp(), info: () => r.info(), picture: () => r.picture(),
    delay: () => r.info().delayMs, video: () => video,
    tier: () => (vl.cfg ? gsTier(vl.cfg.q as GsQuality, vl.cfg.tier) : null), ladder: GS_LADDER,
  });
  refresh();
  vl.start();
}
void boot();
