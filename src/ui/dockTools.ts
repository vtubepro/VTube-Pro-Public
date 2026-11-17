// Docked tools (docked workstream): the Chat Hub, Stream Deck & controllers and AI connectors open INSIDE the studio
// as a right-side drawer by default — the very same pages (chathub.html, deck.html, /aiconnect) in a frame, so every
// action still goes through the same endpoints and bus commands. Each drawer has "Pop out ↗" (its own window, as
// before: a second monitor or an OBS dock) and each popped-out window has "Dock back" (src/ui/dockEmbed.ts). The
// choice is remembered per tool; Settings → Look & feel → "Open tools in" sets the default. Esc closes the drawer.
// The drawer pushes the studio over (it never covers the stage or the Live console): #app gets narrower.
import { toast } from './dom.ts';
import { DOCK_CHANNEL, type DockMsg } from './dockEmbed.ts';
import { DRAWER_SHEET_MAX, drawerWidth } from '../../shared/uxLayout.ts';

export type ToolId = 'chathub' | 'deck' | 'aiconnect' | 'aiwizard' | 'tools';
export type ToolMode = 'app' | 'window';
interface ToolDef { title: string; path: string; win: string; feat: string; width: number; min: number }
/** AI connectors is a server page (server/aiconnectPage.ts): on the dev studio (5190) it lives on the server's port. */
const aiOrigin = () => (location.port === '5190' ? `${location.protocol}//127.0.0.1:5191` : '');
export const TOOLS: Record<ToolId, ToolDef> = {
  chathub: { title: 'Chat Hub', path: '/chathub.html', win: 'vtp-chathub', feat: 'popup=yes,width=1280,height=860', width: 500, min: 380 },
  deck: { title: 'Stream Deck & controllers', path: '/deck.html', win: 'vtp-deck', feat: 'popup=yes,width=1320,height=880', width: 1080, min: 680 },
  aiconnect: { title: 'AI connectors', path: '/aiconnect', win: 'vtp-aiconnect', feat: 'popup=yes,width=1100,height=900', width: 780, min: 480 },
  // "Connect an AI in 3 steps" (server/aiconnectWizard.ts), opened from Create's "How do you want to create?" (lane create-gating)
  aiwizard: { title: 'Connect an AI', path: '/aiconnect/connect', win: 'vtp-aiwizard', feat: 'popup=yes,width=1000,height=900', width: 720, min: 460 },
  // Tools & add-ons: optional programs (Blender, ffmpeg, local AI, OBS plugins), detected on this PC (tools.html, server/toolsCatalog.ts)
  tools: { title: 'Tools & add-ons', path: '/tools.html', win: 'vtp-tools', feat: 'popup=yes,width=1180,height=900', width: 760, min: 420 },
};
const isTool = (t: unknown): t is ToolId => typeof t === 'string' && Object.hasOwn(TOOLS, t);

const K = { def: 'vtp.dock.default', mode: (t: ToolId) => `vtp.dock.mode.${t}`, w: (t: ToolId) => `vtp.dock.w.${t}` };
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage off */ } };

/** Default for every tool (Settings → "Open tools in"). */
export const toolDefault = (): ToolMode => (lsGet(K.def) === 'window' ? 'window' : 'app');
export function setToolDefault(m: ToolMode) { lsSet(K.def, m); for (const t of Object.keys(TOOLS) as ToolId[]) lsSet(K.mode(t), null); }
/** Where this tool opens: its own remembered choice, else the default. */
export const toolMode = (t: ToolId): ToolMode => { const v = lsGet(K.mode(t)); return v === 'app' || v === 'window' ? v : toolDefault(); };
const remember = (t: ToolId, m: ToolMode) => lsSet(K.mode(t), m === toolDefault() ? null : m);

const isAi = (t: ToolId) => t === 'aiconnect' || t === 'aiwizard';
function toolUrl(t: ToolId, query: string, docked: boolean): string {
  const [qs, hash] = query.split('#');
  const q = new URLSearchParams(qs);
  if (docked) q.set('docked', '1');
  if (docked && isAi(t)) q.set('host', location.origin); // the page answers only this studio
  const s = q.toString();
  return `${isAi(t) ? aiOrigin() : ''}${TOOLS[t].path}${s ? `?${s}` : ''}${hash ? `#${encodeURIComponent(hash)}` : ''}`;
}

const CSS = `
:root { --vdk-w: 0px; }
body.vdk-open:not(.clean) #app { width: calc(100vw - var(--vdk-w)); }
body.vdk-open.vp-mini:not(.clean) #viewport { margin-right: var(--vdk-w); }
.vdk { position: fixed; top: 0; right: 0; bottom: 0; width: var(--vdk-w); z-index: 900; display: flex; flex-direction: column; background: var(--panel, #13161d);
  box-shadow: -1px 0 0 var(--line, #262b37), -18px 0 40px -28px #000c; color: var(--text, #eef1f6); font: 13px/1.3 var(--font-ui, "Segoe UI", system-ui, sans-serif); }
.vdk-head { display: flex; align-items: center; gap: 8px; height: 48px; padding: 0 10px 0 14px; border-bottom: 1px solid var(--line, #262b37); flex: none; }
.vdk-head b { font: 650 15px/1 var(--font-display, inherit); letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vdk-head .ic { width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; background: color-mix(in srgb, var(--accent, #7bd88f) 18%, transparent); color: var(--accent, #7bd88f); flex: none; }
.vdk-head .sp { flex: 1; }
.vdk-head button { height: 30px; padding: 0 11px; border: 0; border-radius: 8px; background: var(--card2, #242a36); color: var(--text, #eef1f6); font: 600 12.5px/1 var(--font-ui, inherit); cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px; box-shadow: 0 0 0 1px var(--line, #262b37) inset; transition: background 150ms; }
.vdk-head button:hover { background: var(--card3, #2d3442); }
.vdk-head button.x { width: 30px; padding: 0; justify-content: center; font-size: 16px; }
.vdk-head button.back { display: none; }
.vdk-head button:focus-visible { outline: 2px solid var(--focus, #8ab4ff); outline-offset: 2px; }
.vdk-frame { flex: 1; width: 100%; border: 0; background: var(--bg, #0e1015); min-height: 0; }
.vdk-grip { position: absolute; left: -4px; top: 0; bottom: 0; width: 8px; cursor: ew-resize; z-index: 2; }
.vdk-grip::after { content: ""; position: absolute; left: 3px; top: 50%; width: 2px; height: 36px; margin-top: -18px; border-radius: 2px; background: var(--line2, #39414f); opacity: 0; transition: opacity 150ms; }
.vdk-grip:hover::after, .vdk.drag .vdk-grip::after { opacity: 1; }
.vdk.drag .vdk-frame { pointer-events: none; }
.vdk-load { position: absolute; inset: 48px 0 0; display: grid; place-items: center; color: var(--dim, #a3abba); pointer-events: none; }
/* cr-02: at ${DRAWER_SHEET_MAX} px or less the drawer is a full-width sheet with a back arrow and the title; #app is not shrunk (--vdk-w is 0) */
@media (max-width: ${DRAWER_SHEET_MAX}px) {
  .vdk { width: 100vw; box-shadow: none; }
  .vdk-grip { display: none; }
  .vdk-head { padding: 0 8px 0 6px; gap: 6px; }
  .vdk-head .ic, .vdk-head button.x { display: none; }
  .vdk-head button.back { display: inline-flex; width: 40px; height: 40px; padding: 0; justify-content: center; font-size: 20px; }
  .vdk-head button { height: 40px; }
  .vdk-head b { flex: 1 1 auto; min-width: 0; }
  .vdk-head .sp { display: none; }
  .vdk-load { inset: 48px 0 0; }
  body.vdk-open #toasts { z-index: 950; }
}
@media (prefers-reduced-motion: no-preference) { .vdk { animation: vdk-in 160ms cubic-bezier(.2,.7,.2,1); } @keyframes vdk-in { from { transform: translateX(24px); opacity: 0; } } }
`;
const GLYPH: Record<ToolId, string> = { chathub: '💬', deck: '🎛', aiconnect: '✦', aiwizard: '✦', tools: '🧰' };

let cur: { t: ToolId; el: HTMLElement; frame: HTMLIFrameElement; opener: HTMLElement | null } | null = null;
const listeners = new Set<() => void>();
const changed = () => { for (const l of listeners) l(); };
/** The docked tool right now (null = drawer closed). */
export const dockedTool = (): ToolId | null => cur?.t ?? null;
export const onDockChange = (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); };

function width(t: ToolId) {
  const d = TOOLS[t], saved = Number(lsGet(K.w(t)));
  const want = saved > 0 ? saved : d.width;
  // keep the studio (#app) at least 1100 px wide on a window of 1500 px or more, and ~960 px on smaller ones (the Live
  // console keeps its compact two-column layout), even when the tool itself would like more (the deck editor): the user can
  // still drag the edge. On a window of 700 px or less the drawer is a full-width sheet and #app is not shrunk (0).
  // (shared/uxLayout.ts drawerWidth)
  return drawerWidth(innerWidth, want, d.min);
}
function applyWidth() { if (cur) document.documentElement.style.setProperty('--vdk-w', `${width(cur.t)}px`); }

/** Open a tool where the user wants it (drawer by default). `query` e.g. 'connect=1'. */
export function openTool(t: ToolId, query = '') {
  if (toolMode(t) === 'window') popTool(t, query); else dockTool(t, query);
}

/** Open the tool in its own window (and remember that). */
export function popTool(t: ToolId, query = '') {
  remember(t, 'window');
  if (cur?.t === t) closeDock();
  const w = window.open(toolUrl(t, query, false), TOOLS[t].win, TOOLS[t].feat);
  if (!w) toast(`Your browser blocked the pop-up: allow pop-ups for this page, or open ${toolUrl(t, query, false)}`, 'warn');
  else { w.focus(); toast(`${TOOLS[t].title} is in its own window now (“Dock back” returns it here)`, 'info', 3500); }
}

/** Open the tool in the right-side drawer (and remember that). */
export function dockTool(t: ToolId, query = '') {
  remember(t, 'app');
  ensure();
  const src = toolUrl(t, query, true);
  if (cur?.t === t) { if (query && cur.frame.getAttribute('src') !== src) cur.frame.src = src; cur.frame.focus(); return; }
  closeDock(true);
  const d = TOOLS[t];
  const frame = document.createElement('iframe');
  Object.assign(frame, { className: 'vdk-frame', title: d.title, src });
  frame.setAttribute('allow', 'clipboard-write; autoplay');
  const load = document.createElement('div'); load.className = 'vdk-load'; load.textContent = `Opening ${d.title}…`;
  frame.addEventListener('load', () => load.remove(), { once: true });
  // Esc inside a same-origin page (Chat Hub, Stream Deck) closes the drawer too; a cross-origin one (the dev studio's AI
  // connectors) is reached by its own close message
  frame.addEventListener('load', () => {
    try { const fd = frame.contentDocument; if (fd) fd.addEventListener('keydown', (e) => escClose(e, fd)); } catch { /* another origin */ }
  });
  const btn = (label: string, title: string, fn: () => void, cls = '') => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.title = title; if (cls === 'back' || cls === 'x') b.setAttribute('aria-label', cls === 'back' ? 'Back to the studio' : 'Close'); b.textContent = label; b.addEventListener('click', fn); return b; };
  const head = document.createElement('div'); head.className = 'vdk-head';
  const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = GLYPH[t];
  const name = document.createElement('b'); name.textContent = d.title;
  const sp = document.createElement('span'); sp.className = 'sp';
  head.append(btn('←', 'Back to the studio (Esc)', () => closeDock(), 'back'), ic, name, sp,
    btn('Pop out ↗', 'Open in its own window (second monitor or an OBS dock). Remembered for next time.', () => popTool(t)),
    btn('✕', 'Close (Esc)', () => closeDock(), 'x'));
  const grip = document.createElement('div'); grip.className = 'vdk-grip'; grip.title = 'Drag to resize';
  const el = document.createElement('aside');
  el.className = 'vdk'; el.dataset.tool = t; el.setAttribute('role', 'complementary'); el.setAttribute('aria-label', d.title);
  el.append(grip, head, frame, load);
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault(); grip.setPointerCapture(e.pointerId); el.classList.add('drag');
    const move = (ev: PointerEvent) => { lsSet(K.w(t), String(Math.round(innerWidth - ev.clientX))); applyWidth(); };
    const up = () => { el.classList.remove('drag'); grip.removeEventListener('pointermove', move); dispatchEvent(new Event('resize')); };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up, { once: true }); grip.addEventListener('pointercancel', up, { once: true });
  });
  grip.addEventListener('dblclick', () => { lsSet(K.w(t), null); applyWidth(); dispatchEvent(new Event('resize')); });
  document.body.append(el);
  const prev = document.activeElement as HTMLElement | null;
  cur = { t, el, frame, opener: prev && prev !== document.body && !el.contains(prev) ? prev : null };
  applyWidth();
  document.body.classList.add('vdk-open');
  dispatchEvent(new Event('resize'));
  changed();
}

export function closeDock(silent = false) {
  if (!cur) return;
  cur.frame.src = 'about:blank'; // stops the page (its polling / read-aloud) at once
  const opener = cur.opener;
  cur.el.remove(); cur = null;
  document.body.classList.remove('vdk-open');
  document.documentElement.style.setProperty('--vdk-w', '0px');
  if (!silent) { dispatchEvent(new Event('resize')); changed(); if (opener?.isConnected) opener.focus({ preventScroll: true }); } // (focus goes back to what opened it)
}

let ready = false;
function ensure() {
  if (ready) return; ready = true;
  const st = document.createElement('style'); st.id = 'vtp-dock-css'; st.textContent = CSS; document.head.append(st);
  addEventListener('resize', () => { if (cur) { const w = getComputedStyle(document.documentElement).getPropertyValue('--vdk-w'); const n = `${width(cur.t)}px`; if (w.trim() !== n) applyWidth(); } });
  // Esc closes the drawer (unless something else — a popover, a menu, a dialog, a text field — used it first)
  document.addEventListener('keydown', (e) => escClose(e, document));
}

/** Esc closes the docked drawer, unless a dialog or overlay above it owns Esc, or a text field is being typed in. */
const OVERLAY = '.modal-back, .wiz-back, .lc-pop, .gd-back, .gd-menu, .tl-menu, .tbm-pop, .hv-back, .ap-wrap, .ntf-panel:not([hidden]), dialog[open], [role=dialog][aria-modal=true]';
function escClose(e: KeyboardEvent, d: Document) {
  if (e.key !== 'Escape' || !cur || e.defaultPrevented) return;
  const a = d.activeElement as HTMLElement | null;
  if (a && a !== d.body && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
  if (d.querySelector(OVERLAY) || (d !== document && document.querySelector(OVERLAY))) return;
  e.preventDefault(); closeDock();
}

/** Wire the studio side once: messages from docked frames and popped-out windows. */
export function initDockTools(onLive: () => void) {
  ensure();
  const handle = (m: DockMsg | null, fromFrame: boolean) => {
    if (!m || typeof m !== 'object') return;
    if (m.k === 'dock' && m.tool === 'live') { onLive(); return; }
    if (!isTool(m.tool)) return;
    if (m.k === 'dock') dockTool(m.tool);
    else if (m.k === 'popout' && fromFrame && cur?.t === m.tool) popTool(m.tool);
    else if (m.k === 'close' && fromFrame && cur?.t === m.tool) closeDock();
    else if (m.k === 'open' && fromFrame && isTool(m.open)) openTool(m.open);
  };
  // same-origin pages (chathub.html, deck.html, live.html): a BroadcastChannel + direct calls from the frame
  try { const ch = new BroadcastChannel(DOCK_CHANNEL); ch.onmessage = (e) => handle(e.data as DockMsg, false); } catch { /* old browser */ }
  (window as unknown as { vtpDock?: unknown }).vtpDock = { msg: (m: DockMsg) => handle(m, true) };
  // AI connectors is served by the server port (another origin on the dev studio): postMessage, loopback pages only
  addEventListener('message', (e) => {
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(e.origin)) return;
    const d = e.data as { vtpDock?: DockMsg } | null;
    if (!d || typeof d !== 'object' || !d.vtpDock) return;
    const fromFrame = !!cur && e.source === cur.frame.contentWindow;
    if (!fromFrame && d.vtpDock.k !== 'dock') return;
    handle(d.vtpDock, fromFrame);
  });
}
