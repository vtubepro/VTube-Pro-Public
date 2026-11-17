// ONE room preview for the whole studio (output.html?preview=1: the room exactly as OBS renders it). The Room area's
// picture-in-picture and the Room / Show / Chat / OBS panels' preview box used to create their own <iframe> every time
// they were shown and destroy it when the area changed: every visit loaded the whole room again (scripts, the room
// model, textures, shader programs) on the studio's main thread, the thread that also feeds the face tracker. Measured
// (tools/perf_tabs.mjs, Kingsmarch, tracking on): 0.5-1.1 s of tracking gaps per switch to Room or Show.
//
// Now the studio keeps one preview frame and MOVES it between the places that show it with Element.moveBefore() (a
// state-preserving move: the page inside keeps running, no reload). While no area shows it, it waits in a hidden
// parking spot: its PreviewGate (src/scene/previewLink.ts) sees no box and stops drawing (logic frames twice a second,
// as for a preview scrolled out of view). It is only closed when the user hides the preview. Browsers without
// moveBefore (Firefox, Safari, Chromium < 133) behave exactly as before: a new frame per mount, removed when parked.
// beta.12: the shared preview loads from the other loopback name (127.0.0.1 <-> localhost) so the browser runs it in its
// own process, off the tracker's thread (src/scene/previewBridge.ts). A preview that doesn't connect (hello) within 8 s
// of loading falls back to the same-origin page for this session.
// beta.13.5 (owner decision): the live room preview is OFF until the user turns it on (remembered per browser: 'vtp.scene.
// preview' = '1'). It renders the whole room a second time on the graphics card, next to OBS and a game. What needs the
// room's own analysis for a moment (its seats, React re-seating) opens it out of sight and closes it after
// (src/ui/logicPreview.ts); while a game starves face tracking (Tracker game mode) no preview runs at all.
import { onBeforeClear } from './dom.ts';
import { bridgedFrames, markIsolationFailed, previewIsolationOrigin, previewUrl } from '../scene/previewBridge.ts';
import { previewPausedText } from './gameText.ts';

const QUERY = 'preview=1&fps=20&tier=medium';
type Movable = Element & { moveBefore?: (node: Node, child: Node | null) => void };
/** State-preserving moves are available (Chrome / Edge 133+). */
export const canKeepPreview = typeof (Element.prototype as Movable).moveBefore === 'function';

let frame: HTMLIFrameElement | null = null;
let park: HTMLElement | null = null;
/** The panel that showed it last (when the box sits outside that panel: the Show panel's "Big" preview over the 3D view). */
let owner: HTMLElement | null = null;
/** Times the shared frame was (re)created: a test / diagnostics number (tools/perf_tabs.mjs). */
export let previewFrameLoads = 0;

/** The user wants the live room preview (Room / Show / Chat boxes): off unless they turned it on in this browser. */
export const PREVIEW_KEY = 'vtp.scene.preview';
export function previewWanted(): boolean { try { return localStorage.getItem(PREVIEW_KEY) === '1'; } catch { return false; } }
export function setPreviewWanted(on: boolean) { try { localStorage.setItem(PREVIEW_KEY, on ? '1' : '0'); } catch { /* storage blocked */ } }

/** While a game starves face tracking (src/ui/gameMode.ts): no preview at all — the frame is closed and the boxes show a
 *  line instead; it comes back by itself afterwards (a 'vtp-refresh' re-mounts it). The line names a game on the graphics
 *  card only when stall mode measured a wait there (`gpu`, stallGuard.ts StallState.gpu; beta.14.1). */
let suspended = false;
let suspendedGpu = true;
export const PREVIEW_SUSPENDED_NOTE = previewPausedText(true);
/** Where the preview was showing when it was suspended (or asked for meanwhile): it goes back there afterwards. */
let resume: { parent: HTMLElement; before: Node | null; title: string; panel: HTMLElement | null } | null = null;
export function suspendPreview(on: boolean, gpu = true) {
  if (on) suspendedGpu = gpu;
  if (on === suspended) return;
  if (on && frame?.isConnected && !parked() && !hiddenUse && frame.parentElement) {
    const p = frame.parentElement;
    resume = { parent: p, before: frame.nextSibling, title: frame.title, panel: owner };
    closePreviewFrame();
    suspended = true;
    mountPreviewFrame(p, resume.before, resume.title, resume.panel);   // (the line in its place)
  } else { suspended = on; if (on) closePreviewFrame(); }
  if (!on) {
    // back where it was (when that place is still on the page), else at the next visit as usual
    const r = resume; resume = null;
    if (r && r.parent.isConnected) mountPreviewFrame(r.parent, r.before && r.before.parentNode === r.parent ? r.before : null, r.title, r.panel);
  }
  try { document.dispatchEvent(new CustomEvent('vtp-refresh')); } catch { /* no DOM */ }
}
export const previewSuspended = () => suspended;
/** Stall mode learned more after it began (a wait on the card measured later, a helper reading): the paused line follows,
 *  on the page now and at every later mount (review round 1 of beta.14.1). */
export function setPreviewPausedGpu(gpu: boolean) {
  if (gpu === suspendedGpu) return;
  suspendedGpu = gpu;
  if (typeof document === 'undefined') return;
  for (const n of document.querySelectorAll('.vtp-preview-paused')) n.textContent = previewPausedText(gpu);
}
/** A preview the user can see right now (not parked, not a hidden analysis frame). */
export const previewVisible = () => !!frame && frame.isConnected && !parked() && !hiddenUse;

function parking(): HTMLElement {
  if (park?.isConnected) return park;
  park = document.createElement('div');
  park.id = 'vtp-preview-park';
  park.setAttribute('aria-hidden', 'true');
  // no box at all: the preview's gate (ResizeObserver: no size) pauses its drawing
  park.style.cssText = 'display:none';
  document.body.append(park);
  return park;
}

function create(title: string): HTMLIFrameElement {
  const f = document.createElement('iframe');
  const iso = previewIsolationOrigin(location);
  f.src = previewUrl(QUERY, iso);
  f.title = title;
  f.allow = 'display-capture';
  previewFrameLoads++;
  if (iso) {
    // (no hello from the cross-site page: the other loopback name doesn't reach the helper here, or the browser blocks
    // it — the same-origin preview instead, for the rest of this session)
    let timer = 0;
    const fallback = () => {
      clearTimeout(timer);
      if (bridgedFrames.has(f) || !f.isConnected) return;
      markIsolationFailed();
      console.warn('[preview] the separate-process preview did not connect: using the same-origin preview');
      f.src = previewUrl(QUERY, null);
    };
    f.addEventListener('load', () => { clearTimeout(timer); timer = window.setTimeout(fallback, 8000); }, { once: true });
    timer = window.setTimeout(fallback, 60000);
  }
  return f;
}

/** Put the studio's room preview into `parent` (before `before`, default: at the end) and return it. Re-uses the running
 *  preview when the browser can move it without a reload. */
export function mountPreviewFrame(parent: HTMLElement, before: Node | null = null, title = 'Room preview — what OBS shows', panel: HTMLElement | null = null): HTMLIFrameElement | null {
  owner = panel;
  hiddenUse = false;
  if (suspended) {
    // (a game holds the graphics card: a line instead of a second render of the room; the preview comes back here after)
    resume = { parent, before, title, panel };
    parent.querySelector('.vtp-preview-paused')?.remove();
    const n = document.createElement('div');
    n.className = 'vtp-preview-paused note';
    n.style.cssText = 'padding:10px 12px;font-size:12.5px;line-height:1.4';
    n.textContent = previewPausedText(suspendedGpu);
    parent.insertBefore(n, before);
    return null;
  }
  parent.querySelector('.vtp-preview-paused')?.remove();
  if (frame && canKeepPreview && frame.isConnected && parent.isConnected) {
    frame.title = title;
    if (frame.parentNode !== parent || frame.nextSibling !== before) (parent as Movable).moveBefore!(frame, before);
    return frame;
  }
  // (no state-preserving move here: the old frame closes, a new one starts — as before this module)
  frame?.remove();
  frame = create(title);
  parent.insertBefore(frame, before);
  return frame;
}

/** Nobody shows the preview right now: keep it running, out of sight (paused by its gate). Without moveBefore: closed. */
export function parkPreviewFrame() {
  if (!frame) return;
  if (!canKeepPreview || !frame.isConnected) { frame.remove(); frame = null; return; }
  const p = parking();
  if (frame.parentNode !== p) { (p as Movable).moveBefore!(frame, null); parkedKey = keyOf?.() ?? ''; }
}

// A parked preview must never LOAD anything nobody looks at: a room change, a guest joining, an avatar or outfit change
// would load models + compile shaders on the tracker's thread for a picture nobody sees (before this module there was no
// preview at all outside Room / Show). So while it is parked and what it shows changes, it is closed; the next visit
// loads the new state once (it had to load that anyway).
let keyOf: (() => string) | null = null;
let parkedKey = '';
const parked = () => !!frame && !!park && frame.parentNode === park;
/** What the preview shows (room, performers, own avatar + outfit) and when it may have changed. Registered once. */
export function previewShowsFrom(key: () => string, subscribe: (changed: () => void) => void) {
  if (keyOf) return;
  keyOf = key;
  // (the hidden analysis frame is needed for exactly this change — a guest / costume while React re-seats: it stays and
  //  takes the new state; review round 1, G2)
  subscribe(() => { if (parked() && key() !== parkedKey) { if (hiddenUse) parkedKey = key(); else closePreviewFrame(); } });
}

/** The user hid the preview: close it for good (frees its room, textures and WebGL context). */
export function closePreviewFrame() { frame?.remove(); frame = null; hiddenUse = false; }

/** An analysis that needs the room page for a moment (src/ui/logicPreview.ts): the shared preview, loaded out of sight
 *  (parked: it does not draw except while someone walks / the room loads, its logic runs twice a second and it reports
 *  to the studio). false = not now (suspended, or no DOM). A preview someone is looking at is used as it is. */
let hiddenUse = false;
export function openHiddenPreview(): boolean {
  if (suspended || typeof document === 'undefined') return false;
  if (frame?.isConnected) return true;
  frame = create('Room analysis (hidden)');
  hiddenUse = true;
  parking().append(frame);
  if (!canKeepPreview) { frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:180px;visibility:hidden'; document.body.append(frame); }
  parkedKey = keyOf?.() ?? '';
  return true;
}
/** The analysis is done: close the hidden preview (never one the user is looking at). */
export function closeHiddenPreview() { if (hiddenUse) closePreviewFrame(); }
export const hiddenPreviewOpen = () => hiddenUse && !!frame?.isConnected;

/** Is the shared preview inside `root`? */
export const previewFrameIn = (root: Node) => !!frame && root.contains(frame);

// a container being emptied (an area switch, a panel re-built) parks the preview first instead of destroying it
onBeforeClear((el) => {
  if (!frame) {
    // (suspended: the panel that owns a box outside itself — the Show panel's "Big" box over the 3D view — is going away:
    //  that box goes too, and the preview does not come back there later; review round 1)
    if (owner && el.contains(owner)) {
      const box = resume?.parent;
      if (box && box !== park && !el.contains(box)) box.remove();
      resume = null; owner = null;
    }
    return;
  }
  const box = frame.parentElement;
  if (el.contains(frame)) { parkPreviewFrame(); owner = null; return; }
  // the panel that owns a box outside itself is going away: park the preview and drop that (now empty) box with it
  if (owner && el.contains(owner)) { parkPreviewFrame(); if (box && box !== park) box.remove(); owner = null; }
});
