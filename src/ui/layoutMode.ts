// UX redesign: the layout switch (Settings -> Look & feel -> Layout: New / Classic). Owner's rule from the Live layout
// history ("I liked the old layout, I just wanted more options"): nothing is ever taken away. The new layout only ADDS
// rail group labels, the notification bell (src/ui/notifyTray.ts), the Tools menu (src/ui/toolsMenu.ts), folding cards
// (remembered per card, src/ui/dom.ts) and three Home tiles (src/ui/home.ts); Classic shows beta.9's arrangement
// exactly. Switching applies at once (no reload: the camera and OBS keep running).
// html.vtp-classic / html.vtp-modern carry the choice for CSS; listeners re-place what moves (rail, notices, Home).
import { CLASSIC_KEY, menuBox, parseClassic } from '../../shared/uxLayout.ts';

const read = (): boolean => { try { return parseClassic(localStorage.getItem(CLASSIC_KEY)); } catch { return false; } };
let classic = read();
const subs = new Set<(classic: boolean) => void>();

function paint() {
  const r = document.documentElement;
  r.classList.toggle('vtp-classic', classic);
  r.classList.toggle('vtp-modern', !classic);
}

/** Classic layout on? (beta.9's arrangement) */
export const isClassic = (): boolean => classic;

/** Switch the layout now, and remember it in this browser (`remember` false: an observer tab, which shares its storage
 *  with the live studio, switches only itself). */
export function setClassic(on: boolean, remember = true) {
  if (on === classic) return;
  classic = on;
  if (remember) { try { if (on) localStorage.setItem(CLASSIC_KEY, '1'); else localStorage.removeItem(CLASSIC_KEY); } catch { /* storage off: this session only */ } }
  paint();
  for (const f of subs) try { f(classic); } catch (e) { console.warn('[layout] listener', e); }
}

/** Called when the layout changes (returns the unsubscribe). */
export function onLayoutMode(fn: (classic: boolean) => void): () => void { subs.add(fn); return () => subs.delete(fn); }

/** Put the classes on <html> and the new layout's styles in (once, by the shell). (No cross-tab following: a live
 *  studio's layout never changes by itself.) */
export function initLayoutMode() {
  paint();
  if (!document.getElementById('vtp-ux-css')) {
    const s = document.createElement('style');
    s.id = 'vtp-ux-css';
    s.textContent = CSS;
    document.head.append(s);
  }
}

// ---------------------------------------------------------------- menus that fit (cr-01)
// One shared window resize listener serves every open menu (R3-9): it is installed while at least one menu is live and
// removed when the last one closes, so opening a menu many times without resizing leaves nothing behind.
const liveFits = new Set<() => void>();
let fitListening = false;
const onFitResize = () => { for (const p of [...liveFits]) p(); };
const syncFitListener = () => {
  if (liveFits.size && !fitListening) { addEventListener('resize', onFitResize); fitListening = true; }
  else if (!liveFits.size && fitListening) { removeEventListener('resize', onFitResize); fitListening = false; }
};
/** How many menus are being kept fitted right now (the unit test checks this drops to 0 when they close). */
export const fittedMenuCount = (): number => liveFits.size;

/** Make a top-bar menu (Tools, Help, the bell tray) fit the window: max height = innerHeight - top - 8 with its own scroll,
 *  never off the left edge, and at 600 px or less a bottom sheet with a Close button. Re-fits on resize until it is
 *  removed (or hidden). `anchor` = the button it opened from (a button inside the More menu counts as the top bar).
 *  Returns `place` (call it to re-fit now). Closing needs no call: when the menu leaves the page its resize hold is
 *  dropped at once (and any menu left behind by a removed parent is dropped the next time a menu opens). */
export function fitMenu(el: HTMLElement, o: { anchor?: HTMLElement | null; close: () => void; ownClose?: boolean }) {
  let closeBtn: HTMLButtonElement | null = null;
  if (!o.ownClose) {
    closeBtn = document.createElement('button');
    closeBtn.type = 'button'; closeBtn.className = 'ux-sheet-close'; closeBtn.setAttribute('role', 'menuitem'); closeBtn.dataset.ui = 'menu-close';
    closeBtn.textContent = 'Close'; closeBtn.addEventListener('click', (e) => { e.stopPropagation(); o.close(); });
    el.append(closeBtn);
  }
  let watcher: MutationObserver | null = null;
  const release = () => { liveFits.delete(place); watcher?.disconnect(); watcher = null; syncFitListener(); };
  const hold = () => {
    if (liveFits.has(place)) return;
    liveFits.add(place); syncFitListener();
    const parent = el.parentNode;
    if (parent && typeof MutationObserver !== 'undefined') {
      watcher = new MutationObserver(() => { if (!el.isConnected) release(); });
      watcher.observe(parent, { childList: true });
    }
  };
  function place() {
    if (!el.isConnected) { release(); return; }
    hold(); // (a tray panel that was taken out and put back is held again by its next place())
    if (el.hidden) return;
    const bar = document.getElementById('topbar');
    let ar = o.anchor?.getBoundingClientRect();
    if (!ar || !ar.width || o.anchor?.closest('.tbm-pop')) { const b = bar?.getBoundingClientRect(); ar = { bottom: b?.bottom ?? 56, right: innerWidth - 8 } as DOMRect; }
    const box = menuBox({ vw: innerWidth, vh: innerHeight, anchorBottom: ar.bottom, anchorRight: ar.right, width: el.offsetWidth || 360 });
    el.classList.toggle('ux-sheet', box.sheet);
    if (box.sheet) { el.style.removeProperty('top'); el.style.removeProperty('right'); el.style.removeProperty('max-height'); }
    else { el.style.top = `${box.top}px`; el.style.right = `${box.right}px`; el.style.maxHeight = `${box.maxHeight}px`; }
  }
  for (const p of [...liveFits]) p(); // (drops menus whose parent was removed with them)
  place();
  return place;
}

const CSS = `
/* menus that fit: the Close button only shows in the bottom sheet (600 px or less) */
.ux-sheet-close { display: none; }
.ux-sheet { position: fixed !important; left: 0 !important; right: 0 !important; bottom: 0 !important; top: auto !important; width: auto !important; max-width: none !important;
  max-height: min(86vh, calc(100vh - 48px)) !important; border-radius: 16px 16px 0 0 !important; overflow-y: auto; overscroll-behavior: contain; animation: none !important;
  padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px)); scroll-padding-bottom: 64px; box-shadow: 0 -18px 60px -20px #000e; }
.ux-sheet > .ux-sheet-close { display: block; position: sticky; bottom: 0; z-index: 1; width: 100%; min-height: 44px; margin-top: 8px; border: 1px solid var(--line2); border-radius: 12px; background: var(--card2);
  color: var(--text); font: 600 14px/1 inherit; font-family: inherit; cursor: pointer; }
.ux-sheet > .ux-sheet-close:hover, .ux-sheet > .ux-sheet-close:focus-visible { background: var(--card3, var(--card2)); outline: 2px solid var(--accent); outline-offset: -2px; }
/* rail group labels (new layout only; Classic never builds them) */
#tabs .rail-grp { flex: none; width: calc(var(--rail-w) - 20px); margin: 3px 0 -1px; padding-top: 6px; border-top: 1px solid var(--line); text-align: center;
  font: 600 9px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: .14em; text-transform: uppercase; color: var(--faint); user-select: none; }
@media (max-height: 820px) { #tabs .rail-grp { margin: 1px 0 -2px; padding-top: 4px; font-size: 8.5px; } }
@media (max-height: 780px) { #tabs .rail-grp { padding-top: 3px; font-size: 8px; letter-spacing: .1em; } }
/* short windows (a 1366 x 768 laptop's browser shows ~640-660 px): the words would push Settings below the rail, so each
   label becomes a thin divider that takes no room (1 px line + 3 px gap - 4 px margin): the rail fits wherever beta.9's did */
@media (max-height: 740px) { #tabs .rail-grp { height: 0; padding: 0; margin: -2px 0; font-size: 0; line-height: 0; letter-spacing: 0; color: transparent; overflow: hidden; } }

/* folding cards: the fold button only shows on the panel's own cards in the new layout */
.s-fold { display: none; }
html.vtp-modern .area-body .s-card > h3 > .s-fold { display: inline-grid; place-items: center; flex: none; margin-left: auto; width: 26px; height: 26px; border-radius: 8px;
  border: 1px solid transparent; background: transparent; color: var(--faint); cursor: pointer; padding: 0; transition: transform var(--dur, 160ms) var(--ease, ease), color 120ms, background 120ms; }
html.vtp-modern .area-body .s-card > h3 > .s-fold svg { width: 16px; height: 16px; }
html.vtp-modern .area-body .s-card > h3 > .s-fold:hover { color: var(--text); background: var(--card2); }
html.vtp-modern .area-body .s-card > h3:has(> .s-fold) { display: flex; align-items: center; gap: 8px; cursor: pointer; }
html.vtp-modern .area-body .s-card.collapsed > h3 > .s-fold { transform: rotate(-90deg); }
html.vtp-modern .area-body .s-card.collapsed { padding-top: 10px; padding-bottom: 10px; }
html.vtp-modern .area-body .s-card.collapsed > h3 { margin-bottom: 0; color: var(--dim); }
html.vtp-modern .area-body .s-card.collapsed > :not(h3) { display: none !important; }

/* things only the new layout shows */
html.vtp-classic .ux-only { display: none !important; }
/* (narrow windows: the bell + Tools need ~90 px; the top bar tightens and Help shows its icon, title and keys unchanged) */
@media (max-width: 1180px) {
  html.vtp-modern #topbar { gap: 6px; }
  html.vtp-modern #topbar .gd-help { padding: 0 9px; margin-left: 0; }
  html.vtp-modern #topbar .gd-help span { display: none; }
}
`;
