// Pro2D show mode: going live from a phone. A phone can't be a camera for TikTok / YouTube / Twitch, but every one of
// their apps can share the phone's SCREEN. So this page becomes the picture: the avatar alone, full screen, in a 9:16
// (TikTok, Shorts) or 16:9 frame, on a room, a solid colour or green (for a chroma key), with nothing else on screen.
//   * tap anywhere: the controls come and go (they never show while hidden: not even toasts or floating buttons)
//   * the screen stays on (Screen Wake Lock, asked again whenever the page comes back)
//   * big buttons for expressions and outfits (a phone has no hotkeys), Calibrate, smoothing
//   * "Record a clip" (src/mobile/clip.ts) and a short "now share your screen" guide per app
// Leave with "Exit" (or Escape). State the tests read: window.__vtpShow.
import type { App } from '../app.ts';
import { h } from '../ui/dom.ts';
import { rig2dSetLayer } from '../ui/rig2dSliders.ts';
import { ClipRecorder, HELD_MAX_S, clipMaxS, clipNow, clipState, type Clip, type PendingClip } from './clip.ts';
import { webStore } from './webStore.ts';
import { saveFile } from './backup.ts';
import { isPhone, lowDetail, setLowDetail } from './device.ts';

type Bg = 'room' | 'color' | 'green';
type Aspect = 'portrait' | 'landscape';
interface ShowPrefs { bg: Bg; color: string; aspect: Aspect; guided: boolean }
const KEY = 'vtp.pro2d.show';
const GREEN = '#00b140';
const load = (): ShowPrefs => { try { return { bg: 'color', color: '#1d1f2a', aspect: 'portrait', guided: false, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return { bg: 'color', color: '#1d1f2a', aspect: 'portrait', guided: false }; } };
const save = (p: ShowPrefs) => { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage off */ } };

/** Pure (tools/mobile2d_unit.ts): the frame for an aspect inside a w × h screen (centred, as big as fits). */
export function frameRect(w: number, h: number, aspect: Aspect): { x: number; y: number; w: number; h: number } {
  const k = aspect === 'portrait' ? 9 / 16 : 16 / 9;
  let fw = w, fh = w / k;
  if (fh > h) { fh = h; fw = h * k; }
  fw = Math.round(fw); fh = Math.round(fh);
  return { x: Math.round((w - fw) / 2), y: Math.round((h - fh) / 2), w: fw, h: fh };
}

export const showState = { lastClip: null as File | null, lastTake: '', open: false, controls: true, wakeLockRequests: 0, wakeLockHeld: false, bg: '' as string, aspect: '' as string, frame: { w: 0, h: 0 } };

const CSS = `
html.pro2d-showing, html.pro2d-showing body { overflow: hidden !important; background: var(--pro2d-bg, #000) !important; }
html.pro2d-showing body > *:not(#app):not(.pro2d-show):not(.pro2d-resume):not(.pro2d-lost):not(#toasts) { display: none !important; }
html.pro2d-showing #app > *:not(#viewport) { display: none !important; }
html.pro2d-showing #viewport { position: fixed !important; z-index: 2147480000; left: var(--pro2d-x) !important; top: var(--pro2d-y) !important;
  width: var(--pro2d-w) !important; height: var(--pro2d-h) !important; margin: 0 !important; border: 0 !important; border-radius: 0 !important; }
html.pro2d-showing #viewport > *:not(canvas):not(.vtp-flat-layer) { display: none !important; }
/* the studio's messages in show mode: only what needs you (warnings, errors), as a sheet at the bottom; the rest
   (hints, "camera on", "saved" …) never cover the stream. Show mode's own answers are its .p2-say line. */
html.pro2d-showing #toasts { top: auto !important; bottom: calc(env(safe-area-inset-bottom, 0px) + 8px) !important; left: 8px !important; right: 8px !important; z-index: 2147483100; align-items: stretch; }
html.pro2d-showing #toasts > .toast.ok, html.pro2d-showing #toasts > .toast.info { display: none !important; }
html.pro2d-showing #toasts > .toast { max-width: none; border-radius: 14px; }
.pro2d-show .p2-say { position: absolute; left: 50%; bottom: calc(env(safe-area-inset-bottom, 0px) + 150px); transform: translateX(-50%); max-width: min(90vw, 420px);
  background: #151821f2; color: #fff; border: 1px solid #fff3; border-radius: 14px; padding: 10px 14px; font: 600 14px/1.35 system-ui, sans-serif; text-align: center; pointer-events: none; }
.pro2d-show.hidden .p2-say { display: none; }
.pro2d-show { position: fixed; inset: 0; z-index: 2147481000; pointer-events: auto; background: transparent; -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
.pro2d-show .p2-top, .pro2d-show .p2-bottom { position: absolute; left: 0; right: 0; display: flex; flex-wrap: wrap; gap: 8px; padding: 10px max(10px, env(safe-area-inset-right)) 10px max(10px, env(safe-area-inset-left)); justify-content: center; }
.pro2d-show .p2-top { top: 0; padding-top: max(10px, env(safe-area-inset-top)); background: linear-gradient(#000b, #0000); }
.pro2d-show .p2-bottom { bottom: 0; padding-bottom: max(12px, env(safe-area-inset-bottom)); background: linear-gradient(#0000, #000b); }
.pro2d-show button { min-height: 44px; min-width: 44px; padding: 0 14px; border-radius: 22px; border: 1px solid #fff3; background: #151821e6; color: #fff; font: 600 15px/1 system-ui, sans-serif; cursor: pointer; }
.pro2d-show button.on { background: #3fbf6f; color: #04130a; border-color: #3fbf6f; }
.pro2d-show button.rec { background: #e5263a; border-color: #e5263a; }
.pro2d-show .p2-bottom button { min-height: 52px; font-size: 16px; }
.pro2d-show .p2-label { flex-basis: 100%; text-align: center; color: #fffc; font: 600 13px/1.2 system-ui, sans-serif; }
.pro2d-show.hidden .p2-top, .pro2d-show.hidden .p2-bottom, .pro2d-show.hidden .p2-sheet { display: none; }
.pro2d-show .p2-sheet { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(92vw, 440px); max-height: 80dvh; overflow: auto;
  background: #151821f2; color: #fff; border: 1px solid #fff2; border-radius: 16px; padding: 16px 18px; font: 15px/1.45 system-ui, sans-serif; box-shadow: 0 20px 60px #000a; }
.pro2d-show .p2-sheet h3 { margin: 0 0 8px; font-size: 18px; }
.pro2d-show .p2-sheet ol { margin: 6px 0 10px; padding-left: 20px; } .pro2d-show .p2-sheet li { margin: 4px 0; }
.pro2d-show .p2-tabs, .pro2d-show .p2-row { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; align-items: center; }
.pro2d-show .p2-note { color: #fffb; font-size: 13px; }
.pro2d-show input[type=range] { flex: 1; min-width: 140px; height: 36px; } .pro2d-show input[type=color] { width: 52px; height: 44px; border: 0; background: none; }
`;

const APPS: { id: string; name: string; steps: string[]; note: string }[] = [
  { id: 'tiktok', name: 'TikTok', note: 'Portrait fits TikTok. TikTok lets you go live once your account is allowed to (it asks for enough followers).',
    steps: ['Open TikTok and tap + then LIVE.', 'Choose “Mobile gaming” or screen sharing (if your app offers it), then start.', 'Come back to this page: what you see here is what they see.'] },
  { id: 'youtube', name: 'YouTube', note: 'YouTube lets you go live from a phone once your channel has enough subscribers. Landscape fits YouTube best.',
    steps: ['Open YouTube and tap + then “Go live”.', 'Choose “Share screen” (screencast), then start.', 'Come back to this page.'] },
  { id: 'twitch', name: 'Twitch', note: 'Twitch shares everything on your screen, so turn on Do Not Disturb first.',
    steps: ['Open Twitch, tap your picture, then “Go live” → “Stream games”.', 'Start the broadcast.', 'Come back to this page.'] },
  { id: 'prism', name: 'PRISM', note: 'With the green background, add a chroma key in PRISM (if your version offers it) to put yourself over a game.',
    steps: ['Open PRISM Live Studio and choose “Screencast” (screen sharing).', 'Pick where to stream and start.', 'Come back to this page.'] },
];

let open: { close(): void } | null = null;

export function openShowMode(app: App) {
  if (open) return;
  if (!document.getElementById('pro2d-show-css')) document.head.append(h('style', { id: 'pro2d-show-css' }, CSS));
  const prefs = load();
  const root = document.documentElement;
  const vp = document.getElementById('viewport');
  if (!vp) return;
  const ui = h('div', { class: 'pro2d-show', role: 'dialog', 'aria-label': 'Show mode' });
  const top = h('div', { class: 'p2-top' }), bottom = h('div', { class: 'p2-bottom' });
  let sheet: HTMLElement | null = null;
  ui.append(top, bottom);
  document.body.append(ui);
  root.classList.add('pro2d-showing', 'pro2d-ctl-on');
  Object.assign(showState, { open: true, controls: true });
  (window as unknown as { __vtpShow?: typeof showState }).__vtpShow = showState;
  (window as unknown as { __vtpClip?: typeof clipState }).__vtpClip = clipState;

  // ---- the frame (9:16 or 16:9, centred; the rest is the background colour)
  const placeFrame = () => {
    const r = frameRect(window.innerWidth, window.innerHeight, prefs.aspect);
    root.style.setProperty('--pro2d-x', `${r.x}px`); root.style.setProperty('--pro2d-y', `${r.y}px`);
    root.style.setProperty('--pro2d-w', `${r.w}px`); root.style.setProperty('--pro2d-h', `${r.h}px`);
    showState.frame = { w: r.w, h: r.h }; showState.aspect = prefs.aspect;
    window.setTimeout(() => { try { app.frameCamera(); } catch { /* a room camera frames it */ } }, 60);
  };
  const onResize = () => placeFrame();
  window.addEventListener('resize', onResize);

  // ---- background: the room, a colour, or green
  const prevRoom = app.scene.state.sceneId ?? null;
  const prevBg = app.stage.background;
  let removedRoom = false;
  let bgTimer = 0;
  const applyBg = () => {
    window.clearInterval(bgTimer);
    showState.bg = prefs.bg;
    if (prefs.bg === 'room') {
      root.style.setProperty('--pro2d-bg', '#000');
      restoreBg();
      if (removedRoom && prevRoom) { app.scene.setScene(prevRoom); removedRoom = false; }
      return;
    }
    const color = prefs.bg === 'green' ? GREEN : prefs.color;
    root.style.setProperty('--pro2d-bg', color);
    if (app.scene.state.sceneId) { removedRoom = true; app.scene.setScene(null); }
    // (the room's exit restores its own background a moment later: keep ours on top while show mode is open)
    const paint = () => { app.stage.setTransparent(true); app.stage.background = color; };
    paint(); bgTimer = window.setInterval(paint, 500);
  };

  /** the studio's own background again (before a room loads: it remembers the background it found) */
  function restoreBg() { app.stage.setTransparent(prevBg === null); if (prevBg !== null) app.stage.background = prevBg; }

  // ---- the screen stays on: asked for again EVERY time the page comes back (the browser lets go of it when the page
  // hides, and its 'release' can arrive after the page is visible again), and again on a release while show mode is
  // open and the page is visible
  let lock: { release(): Promise<void>; addEventListener?(t: string, f: () => void): void } | null = null;
  let closed = false;
  const wake = async () => {
    const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<NonNullable<typeof lock>> } }).wakeLock;
    if (!wl || closed || document.visibilityState !== 'visible') return;
    showState.wakeLockRequests++;
    try {
      const l = await wl.request('screen');
      if (closed) { void l.release().catch(() => {}); return; }
      lock = l; showState.wakeLockHeld = true;
      l.addEventListener?.('release', () => {
        if (lock === l) { lock = null; showState.wakeLockHeld = false; }
        if (!closed && document.visibilityState === 'visible') void wake();
      });
    } catch { /* Low Power Mode can refuse: the screen may dim */ }
  };
  const onVis = () => {
    if (document.visibilityState === 'visible') { lock = null; void wake(); return; }
    // hidden: a clip being recorded stops and is kept (the phone pauses the camera and the page anyway)
    lock = null; showState.wakeLockHeld = false;
    if (clip.recording) void stopClip('hidden');
  };
  document.addEventListener('visibilitychange', onVis);
  void wake();

  // ---- show mode's own one-line answers (never a toast over the stream)
  let sayEl: HTMLElement | null = null, sayT = 0;
  const say = (msg: string, kind: 'info' | 'ok' | 'warn' = 'info', ms = 3500) => {
    sayEl?.remove();
    sayEl = h('div', { class: `p2-say ${kind}`, role: kind === 'warn' ? 'alert' : 'status' }, msg);
    ui.append(sayEl); window.clearTimeout(sayT);
    sayT = window.setTimeout(() => { sayEl?.remove(); sayEl = null; }, ms);
  };

  // ---- clip recording: every take in its own folder; the finished clip is one file on disk, removed only once it has
  // been saved (src/mobile/clip.ts)
  const clip = new ClipRecorder({
    write: async (p, b) => { const st = await webStore(); if (!st) throw new Error('no store'); await st.write(p, b); },
    read: async (p) => (await webStore())?.read(p) ?? null,
    remove: async (p) => { await (await webStore())?.remove(p); },
    list: async (p) => (await webStore())?.list(p) ?? [],
  }, clipMaxS(isPhone()));
  (window as unknown as { __vtpClipRec?: ClipRecorder }).__vtpClipRec = clip;   // (tests)
  // a new show: the sweep (src/mobile/clip.ts cleanup), then any clip still waiting for a "Saved" is offered again
  void (async () => {
    await clip.cleanup(clipNow());
    const waiting = await clip.pendingClips();
    if (waiting.length && !closed) offerWaiting(waiting);
  })();
  const mins = () => `${Math.round(clip.capSeconds / 60)} minutes`;
  let clipTick = 0;
  /** a finished clip not saved yet (stopped by itself, or the share sheet was closed): "Save my clip" */
  let pending: Clip | null = null;
  /** a downloaded clip: its file stays until you say "Saved" (or the next show), the download may still be reading it */
  let downloaded: Clip | null = null;
  const recBtn = h('button', { onClick: () => void toggleClip() }, 'Record a clip');
  const savedBtn = h('button', { style: 'display:none', onClick: (e: Event) => { e.stopPropagation(); if (downloaded) { void clip.discard(downloaded.take); downloaded = null; } savedBtn.style.display = 'none'; say('Done: the copy on this phone is deleted.', 'ok', 2500); } }, 'Saved ✓');
  clip.onAutoStop = () => void stopClip('cap');
  clip.onHeld = (max) => say(`This browser keeps the recording in memory, so this clip stops after ${max} seconds.`, 'info', 6000);
  /** Hand the clip to the share sheet (its take goes once share() has resolved) or a download (kept until "Saved" or
   *  the next show). Closed without saving: it stays as "Save my clip". */
  async function saveClip(c: Clip) {
    clip.hold(c.take);
    let how: Awaited<ReturnType<typeof saveFile>>;
    try { how = await saveFile(c.file); } finally { clip.release(c.take); }
    showState.lastClip = c.file; showState.lastTake = c.take;
    if (how === 'cancelled') { pending = c; recBtn.textContent = 'Save my clip'; say('Not saved yet. Tap “Save my clip” to keep it.', 'info', 6000); return; }
    pending = null; recBtn.textContent = 'Record a clip';
    if (how === 'shared') { await clip.discard(c.take); say('Your clip is saved. Post it on TikTok, Shorts or Reels.', 'ok', 6000); return; }
    // a download: kept (marked waiting) until you tap "Saved ✓"; offered again at the next show if you don't
    await clip.markPending(c);
    downloaded = c; savedBtn.style.display = '';
    say('Your clip is downloading. Tap “Saved ✓” once it is in your files, then post it on TikTok, Shorts or Reels.', 'ok', 8000);
  }
  /** "Your last clip is still on this phone: Save again / Delete" (clips waiting for a "Saved" from an earlier show). */
  function offerWaiting(list: PendingClip[]) {
    let left = list.length;
    const rows = list.map((p) => {
      const row: HTMLElement = h('div', { class: 'p2-row' },
        h('span', null, new Date(p.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })),
        btn('Save again', true, () => { setSheet(null); void saveClip({ file: p.file, take: p.take }); }),
        btn('Delete', false, () => { row.remove(); if (--left === 0) setSheet(null); void clip.discard(p.take).then(() => { say('Deleted.', 'ok', 2000); }); }));
      return row;
    });
    setSheet(h('div', { class: 'p2-waiting' }, h('h3', null, list.length > 1 ? 'Your last clips are still on this phone' : 'Your last clip is still on this phone'),
      h('p', null, list.length > 1 ? 'Save them again if they didn’t reach your files, or delete them to free the space.' : 'Save it again if it didn’t reach your files, or delete it to free the space.'), ...rows,
      h('div', { class: 'p2-row' }, btn('Later', false, () => setSheet(null)))));
  }
  async function toggleClip() {
    if (pending) { await saveClip(pending); return; }
    if (!clip.recording) {
      // at most one clip waiting + the one being recorded: over that, ask first
      const stored = await clip.takes();
      if (stored.length >= 2) {
        const older = stored.slice(0, -1);
        setSheet(h('div', null, h('h3', null, `${stored.length} clips are still on this phone`),
          h('p', null, 'This phone keeps one finished clip next to the one you record. Delete the older ones and record?'),
          h('div', { class: 'p2-row' },
            btn('Delete older and record', true, () => { setSheet(null); void (async () => { for (const t of older) await clip.discard(t); await toggleClip(); })(); }),
            btn('Cancel', false, () => setSheet(null)))));
        return;
      }
      try { await clip.start(app.stage.renderer.domElement, app.audio.stream ?? null); }
      catch (e) { say((e as Error).message, 'warn', 6000); return; }
      recBtn.classList.add('rec');
      clipTick = window.setInterval(() => { recBtn.textContent = `Stop (${Math.floor(clip.seconds)} s)`; }, 250);
      say(app.audio.active ? `Recording. Clips stop by themselves after ${mins()}.` : `Recording without sound: turn on your microphone for your voice. Clips stop after ${mins()}.`, 'info', 5000);
      return;
    }
    await stopClip('button');
  }
  async function stopClip(why: 'button' | 'hidden' | 'cap') {
    window.clearInterval(clipTick);
    recBtn.classList.remove('rec'); recBtn.textContent = 'Record a clip';
    let c: Clip | null = null;
    try { c = await clip.stop(app.profile?.name?.replace(/[^\w-]+/g, '-').toLowerCase() || 'my-clip'); }
    catch { say('The clip couldn’t be finished. Try again.', 'warn'); return; }
    if (!c) { say('Nothing was recorded. Try again.', 'warn'); return; }
    if (why === 'button') { await saveClip(c); return; }
    // stopped by itself: keep it until you tap (a phone only shares or downloads after a tap)
    pending = c; recBtn.textContent = 'Save my clip';
    if (!showState.controls) setControls(true);
    say(why === 'cap' ? `Clips stop at ${clipState.held ? `${HELD_MAX_S} seconds in this browser` : mins()}. Tap “Save my clip” to keep it.` : 'You left the page, so the clip stopped. Tap “Save my clip” to keep it.', 'warn', 9000);
  }

  // ---- controls
  const btn = (label: string, on: boolean, fn: () => void) => h('button', { class: on ? 'on' : '', onClick: (e: Event) => { e.stopPropagation(); fn(); } }, label);
  const paintTop = () => {
    top.replaceChildren(
      btn('Exit', false, () => close()),
      ...(app.trackingOn ? [] : [btn('Turn on camera', true, () => { void import('../ui/liveOps.ts').then((m) => m.startCamera(app)).then(() => paintTop()); })]),
      btn(prefs.aspect === 'portrait' ? 'Portrait 9:16' : 'Landscape 16:9', false, () => { prefs.aspect = prefs.aspect === 'portrait' ? 'landscape' : 'portrait'; save(prefs); placeFrame(); paintTop(); }),
      btn('Room', prefs.bg === 'room', () => { prefs.bg = 'room'; save(prefs); applyBg(); paintTop(); }),
      btn('Colour', prefs.bg === 'color', () => { prefs.bg = 'color'; save(prefs); applyBg(); paintTop(); }),
      btn('Green', prefs.bg === 'green', () => { prefs.bg = 'green'; save(prefs); applyBg(); paintTop(); }),
      recBtn, savedBtn,
      btn('How to go live', false, () => guide()),
      btn('More', false, () => more()),
      h('span', { class: 'p2-label' }, 'Tap anywhere to hide these buttons. Tap again to bring them back.'));
  };
  const paintBottom = () => {
    const fl = app.runtime?.flat;
    const kids: HTMLElement[] = [];
    if (fl) {
      const exprs = fl.expressions();
      if (exprs.length) kids.push(btn('Default', !app.flatCue.s, () => { app.setFlatExpression(null); paintBottom(); }));
      for (const x of exprs.slice(0, 9)) kids.push(btn(x.name, app.flatCue.s === x.id, () => { app.setFlatExpression(app.flatCue.s === x.id ? null : x.id); paintBottom(); }));
      // outfits: a Pro2D model's costume layers (one per group), switched at once and remembered
      const src = fl.source as unknown as { doc?: { layers?: { id: string; name: string; group?: string }[] }; anim?: { setLayer(id: string, on: boolean): void; layerOn(id: string): boolean } };
      for (const l of (src.doc?.layers ?? []).slice(0, 8)) {
        const on = !!src.anim?.layerOn(l.id);
        // (through the studio's outfit switches, so the live cue agrees: the next frame can't switch it back)
        kids.push(btn(l.name, on, () => { rig2dSetLayer(app, l.id, !on); src.anim?.setLayer(l.id, !on); if (!on) app.edit((p) => { (p as { costume?: string | null }).costume = l.id; }, false); paintBottom(); }));
      }
    } else if (app.profile?.costumes?.length) {
      for (const c of app.profile.costumes.filter((x) => (x as { kind?: string }).kind !== 'accessory').slice(0, 8)) kids.push(btn(c.name, app.profile.costume === c.id, () => { void app.setCostume(app.profile?.costume === c.id ? null : c.id).then(paintBottom); }));
    }
    bottom.replaceChildren(...kids);
    bottom.style.display = kids.length ? '' : 'none';
  };
  const setSheet = (el: HTMLElement | null) => { sheet?.remove(); sheet = el; if (el) { el.classList.add('p2-sheet'); el.addEventListener('click', (e) => e.stopPropagation()); ui.append(el); } };
  function guide(first = false) {
    let cur = APPS[0];
    const body = h('div');
    const tabs = h('div', { class: 'p2-tabs' });
    const paint = () => {
      tabs.replaceChildren(...APPS.map((a) => btn(a.name, a === cur, () => { cur = a; paint(); })));
      body.replaceChildren(h('ol', null, ...cur.steps.map((s) => h('li', null, s))), h('p', { class: 'p2-note' }, cur.note));
    };
    paint();
    setSheet(h('div', null, h('h3', null, first ? 'Now share your screen' : 'How to go live'),
      h('p', null, 'Your streaming app shows this screen. Keep this page in front: your phone pauses the camera if you switch apps.'),
      tabs, body, h('div', { class: 'p2-row' }, btn('Got it', true, () => setSheet(null)))));
  }
  function more() {
    const smooth = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(app.tune.smoothing ?? 0.5), 'aria-label': 'Smoothing' }) as HTMLInputElement;
    smooth.oninput = () => app.edit((p) => { p.tracking.smoothing = Number(smooth.value); }, false);
    const color = h('input', { type: 'color', value: prefs.color, 'aria-label': 'Background colour' }) as HTMLInputElement;
    color.oninput = () => { prefs.color = color.value; prefs.bg = 'color'; save(prefs); applyBg(); paintTop(); };
    setSheet(h('div', null, h('h3', null, 'More'),
      h('div', { class: 'p2-row' }, btn('Calibrate', false, () => void calibrate()), h('span', { class: 'p2-note' }, 'Look at the screen with a relaxed face.')),
      h('div', { class: 'p2-row' }, h('span', null, 'Smoothing'), smooth),
      h('div', { class: 'p2-row' }, h('span', null, 'Background colour'), color),
      h('div', { class: 'p2-row' }, h('span', null, 'Show'), ...(['head', 'bust', 'full'] as const).map((f) => btn(f === 'head' ? 'Head' : f === 'bust' ? 'Bust' : 'Whole body', app.focus === f, () => { app.focus = f; app.frameCamera(); more(); }))),
      lowDetail() ? h('div', { class: 'p2-row' }, btn('Full detail', false, () => { setLowDetail(false); location.reload(); }), h('span', { class: 'p2-note' }, 'Low detail is on (your phone ran out of graphics memory before).')) : null,
      h('div', { class: 'p2-row' }, btn('Done', true, () => setSheet(null)))));
  }
  async function calibrate() {
    setSheet(null);
    if (!app.trackingOn) { say('Turn on your camera first.', 'warn'); return; }
    say('Relax your face and look at the screen…', 'info', 2500);
    await app.face.calibrate(2);
    say('Calibrated.', 'ok');
  }
  const setControls = (on: boolean) => {
    showState.controls = on;
    ui.classList.toggle('hidden', !on);
    root.classList.toggle('pro2d-ctl-on', on);
    if (on) paintBottom(); else setSheet(null);
  };
  // tap anywhere (not a drag) toggles the controls
  let down: { x: number; y: number; t: number } | null = null;
  ui.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  ui.addEventListener('pointerup', (e) => {
    if (!down) return;
    const tap = Math.hypot(e.clientX - down.x, e.clientY - down.y) < 12 && performance.now() - down.t < 600;
    down = null;
    if (!tap || (e.target as HTMLElement).closest('button, input, .p2-sheet')) return;
    setControls(!showState.controls);
  });
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  window.addEventListener('keydown', onKey, true);
  const offApp = app.on((what) => { if ((what === 'flat' || what === 'avatar' || what === 'library') && showState.controls) paintBottom(); if (what === 'tracking') paintTop(); });

  function close() {
    closed = true;
    // leaving show mode: a clip being recorded is saved as usual
    if (clip.recording) void stopClip('button');
    // a clip never saved is kept, marked waiting (the next show offers it; removed after a day); a downloaded one is
    // already marked
    else if (pending) { const c = pending; pending = null; void clip.markPending(c); }
    window.clearInterval(bgTimer); window.clearInterval(clipTick);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('visibilitychange', onVis);
    try { (offApp as unknown as (() => void) | undefined)?.(); } catch { /* old emitter */ }
    void lock?.release().catch(() => {}); lock = null; showState.wakeLockHeld = false;
    restoreBg();
    if (removedRoom && prevRoom) app.scene.setScene(prevRoom);
    root.classList.remove('pro2d-showing', 'pro2d-ctl-on');
    for (const v of ['--pro2d-x', '--pro2d-y', '--pro2d-w', '--pro2d-h', '--pro2d-bg']) root.style.removeProperty(v);
    ui.remove();
    showState.open = false;
    open = null;
    window.setTimeout(() => { try { app.frameCamera(); } catch { /* fine */ } }, 60);
  }
  open = { close };

  placeFrame(); applyBg(); paintTop(); paintBottom();
  if (!prefs.guided) { prefs.guided = true; save(prefs); guide(true); }
}

export function closeShowMode() { open?.close(); }
