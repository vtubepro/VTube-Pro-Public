// Narrow windows (beta.12 UX, phones and small tablets): the top bar ran off the right edge (a 390 px phone got a 573+ px
// page that scrolled sideways). Below 900 px the bar keeps only what you need while live: the logo, your avatar, the
// on-air light (In OBS / Camera on / Not in OBS), Fix it, and the bell. Everything else
// (status chips, studio view, Simple / Advanced, theme, Help, Tools, the OBS chip)
// is ONE "More" menu away. The menu shows the very same elements, moved into it while it is open and put back when it
// closes, so every button keeps working exactly as in the wide bar. Wide windows are unchanged.
import { h } from './dom.ts';
import { icon } from './icons.ts';
import { topbarTier } from '../../shared/uxLayout.ts';

/** What goes into More on a narrow window (in this order); only the ones that exist and the CSS hides. */
const SECONDARY = [
  '#topbar > .tb-chips', '#topbar > [data-ui="observer-chip"]', '#topbar > .vw-bar > :not(.primary)', '#topbar > .vp-seg', '#topbar > .seg',
  '#topbar > [data-ui="theme"]', '#topbar > .gd-help', '#topbar > [data-ui="help"]', '#topbar > [data-ui="tools-button"]', '#topbar > [data-ui="perf"]',
];
const NARROW = '(max-width: 900px)';

let pop: HTMLElement | null = null;
let moved: { el: Element; mark: Comment }[] = [];
let btn: HTMLButtonElement | null = null;

function close(focusBack = false) {
  if (!pop) return;
  for (const m of moved) { m.mark.replaceWith(m.el); }
  moved = []; pop.remove(); pop = null;
  btn?.setAttribute('aria-expanded', 'false'); btn?.classList.remove('on');
  document.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', onKey, true); removeEventListener('resize', onResize);
  if (focusBack) btn?.focus();
}
// (a click on something the menu opened — the Tools list, the Help menu, the tray — closes More, and the moved items go home)
const outside = (e: Event) => { const t = e.target as Node; if (pop && !pop.contains(t) && !btn?.contains(t)) close(); };
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && pop) { e.preventDefault(); e.stopPropagation(); close(true); } };
const onResize = () => { if (!matchMedia(NARROW).matches) close(); };

function open() {
  if (pop) { close(true); return; }
  const items: Element[] = [];
  for (const sel of SECONDARY) for (const el of document.querySelectorAll(sel)) if (!items.includes(el)) items.push(el);
  pop = h('div', { class: 'tbm-pop', role: 'dialog', 'aria-label': 'More', 'data-ui': 'topbar-more-menu', tabindex: -1 });
  const grid = h('div', { class: 'tbm-grid' });
  for (const el of items) { const mark = document.createComment('tbm'); el.replaceWith(mark); moved.push({ el, mark }); grid.append(el); }
  pop.append(h('div', { class: 'tbm-head' }, h('b', null, 'More'), h('span', null, 'Status, view, theme, help and tools')), grid);
  document.body.append(pop);
  const r = btn!.getBoundingClientRect();
  pop.style.top = `${Math.round(r.bottom + 8)}px`;
  pop.style.right = `${Math.max(8, Math.round(innerWidth - r.right))}px`;
  btn!.setAttribute('aria-expanded', 'true'); btn!.classList.add('on');
  document.addEventListener('pointerdown', outside, true); window.addEventListener('keydown', onKey, true); addEventListener('resize', onResize);
  (pop.querySelector('button, a, [tabindex="0"]') as HTMLElement | null)?.focus();
}

/**
 * FR-09: the top bar adapts to the width of #app (not the window), so a docked drawer cannot clip the lamps, Help or
 * Simple / Advanced. Tier 1 (`html.tb-tight`): the four lamps become dots (their tooltip and aria-label keep the words).
 * Tier 2 (`html.tb-tiny`): the logo word, the avatar's name and the Observer chip's word go too. Tier 1 starts below 1100 px
 * (shared/uxLayout.ts topbarTier); either tier also starts when the bar still overflows. Above 900 px only: the More
 * menu takes over below that.
 */
export function initTopbarFit() {
  const root = document.documentElement;
  const app = document.getElementById('app'), bar = document.getElementById('topbar');
  if (!app || !bar) return;
  let raf = 0, lastSig = '';
  // overflow = the bar is wider than #app, or something in it is cut off (the lamps' box clips its chips: it shrinks instead of overflowing; a badge hanging off the bell is not overflow)
  const over = () => bar.getBoundingClientRect().width > app.getBoundingClientRect().width + 1 || bar.scrollWidth > bar.clientWidth + 1
    || [...bar.querySelectorAll<HTMLElement>(':scope > .tb-chips')].some((c) => c.scrollWidth > c.clientWidth + 1);
  // the widths that decide the fit (R3-14): when none of them moved since the last pass, the status chips only changed
  // their text (the perf chip every 250 ms) and there is nothing to re-measure, so no class is touched
  const sig = () => `${innerWidth}|${app.getBoundingClientRect().width}|${bar.getBoundingClientRect().width}|${bar.scrollWidth}|${bar.clientWidth}`
    + `|${[...bar.querySelectorAll<HTMLElement>(':scope > .tb-chips')].map((c) => `${c.scrollWidth}/${c.clientWidth}`).join(',')}`;
  const fit = () => {
    raf = 0;
    if (innerWidth <= 900) { root.classList.remove('tb-tight', 'tb-tiny'); lastSig = ''; return; }
    const now = sig();
    if (now === lastSig) return;
    // the tier comes from #app's width alone, so below 1100 px tb-tight simply stays on and only tb-tiny is re-measured;
    // classes are touched only where the answer can change (no remove-everything-then-add-back every pass)
    const cl = root.classList;
    if (topbarTier(app.getBoundingClientRect().width) >= 1) { cl.add('tb-tight'); cl.remove('tb-tiny'); }
    else cl.remove('tb-tight', 'tb-tiny');
    if (cl.contains('tb-tight') || over()) {
      cl.add('tb-tight');
      if (over()) cl.add('tb-tiny');
    }
    lastSig = sig();
  };
  const later = () => { if (!raf) raf = requestAnimationFrame(fit); };
  new ResizeObserver(later).observe(app);
  // (a longer avatar name, the room's name or a new chip can change what fits; a chip's changed text is a change too, but fit() drops it when no width moved)
  new MutationObserver(later).observe(bar, { childList: true, subtree: true });
  addEventListener('resize', later);
  later();
}

/** The top bar's More button (shown only on narrow windows). */
export function topbarMoreButton(): HTMLButtonElement {
  if (!document.getElementById('vtp-tbm-css')) document.head.append(h('style', { id: 'vtp-tbm-css' }, CSS));
  btn = h('button', { type: 'button', class: 'icon-btn tbm-btn', 'data-ui': 'topbar-more', title: 'More: status, studio view, theme, help, tools', 'aria-label': 'More', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onClick: () => open() },
    icon('more', 18)) as HTMLButtonElement;
  return btn;
}

const CSS = `
.tbm-btn, #topbar .tb-air { display: none; }
#topbar .tb-air.live .dot { background: #ff5a5a; box-shadow: 0 0 6px #ff5a5a; }
/* FR-09 (above 900 px): the lamps shrink to dots, then the words around them go; nothing else leaves the bar */
@media (min-width: 901px) {
  html.tb-tight #topbar .tb-chips { gap: 4px; overflow: visible; }
  html.tb-tight #topbar .tb-chips .chip { font-size: 0; gap: 0; padding: 0; width: 26px; height: 26px; justify-content: center; }
  html.tb-tight #topbar .tb-chips .chip .dot { width: 10px; height: 10px; }
  html.tb-tiny #topbar .logo > span:not(.mark), html.tb-tiny #topbar .logo .vw-beta { display: none; }
  html.tb-tiny #topbar .tb-avatar > span:not(.ph) { display: none; }
  html.tb-tiny #topbar .tb-avatar { padding: 3px; }
  html.tb-tiny #topbar > [data-ui="observer-chip"] { font-size: 0; gap: 0; padding: 0; width: 26px; height: 26px; justify-content: center; }
}
@media ${NARROW} {
  #topbar { gap: 6px !important; padding: 0 8px !important; min-width: 0; }
  #topbar > :is(.tb-chips, [data-ui="observer-chip"], .vp-seg, .seg, [data-ui="theme"], .gd-help, [data-ui="help"], [data-ui="tools-button"], [data-ui="perf"]) { display: none !important; }
  #topbar > .vw-bar > :not(.primary) { display: none !important; }
  #topbar > .vw-bar { flex: none; }
  #topbar > .spacer { flex: 1 1 0; min-width: 0; }
  #topbar .tbm-btn { display: grid; flex: none; }
  #topbar .tbm-btn.on { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line2)); }
  #topbar .tb-air { display: inline-flex; flex: none; }
  #topbar > :is(.fixit-btn, [data-ui="fix-it"], .ntf-bell, [data-ui="tray-bell"]) { flex: none; }
  #topbar .tb-avatar { min-width: 0; flex: 0 1 auto; max-width: 180px; }
  #topbar .logo { flex: none; }
}
/* the studio itself on a narrow window: the rail, then the studio view on top and the options under it (the old phone
   layout in styles.css, which the desktop grid in theme.ts had overridden: the panel and the view sat side by side and
   made a 390 px phone page 418+ px wide) */
@media ${NARROW} {
  body:not(.clean) #app { grid-template-columns: var(--rail-w) minmax(0, 1fr) !important; grid-template-rows: 56px auto minmax(0, 1fr) auto !important; }
  body:not(.clean) #tabs { grid-row: 2 / 5 !important; overflow-y: auto; overflow-x: hidden; }
  body:not(.clean) #viewport { grid-column: 2; grid-row: 2; height: 38vh; min-width: 0; }
  body:not(.clean) #panel { grid-column: 2; grid-row: 3; min-width: 0; min-height: 0; }
  body:not(.clean) .pane-div { display: none !important; }
  /* Live Control here: the studio view stays in its place on top (not laid over a frame inside the scrolling console) */
  body.lc-console:not(.clean):not(.vp-hidden):not(.lc-pgm-off) #viewport { position: relative !important; left: auto !important; top: auto !important; width: auto !important; height: 38vh !important; z-index: auto !important; border-radius: 0 !important; }
  body.lc-console .lc.lc-narrow .lc-colL > .lc-pgm { display: none !important; }
  body.lc-console:not(.clean) .area-body[data-ui="simple:onair"] { overflow-y: auto !important; display: block !important; }
  body.lc-console:not(.clean) .area-body[data-ui="simple:onair"] > .lc { height: auto; }
}
@media (max-width: 600px) {
  #topbar .logo > span:not(.mark), #topbar .logo .vw-beta { display: none; }
  #topbar .logo { margin-right: 0 !important; }
  #topbar .tb-avatar > span:not(.ph) { display: none; }
  #topbar .tb-avatar { padding: 3px; }
  #topbar .tb-air { padding: 3px 8px; }
  #topbar > .vw-bar .vw-btn.primary { padding: 7px 10px; font-size: 12px; }
  #viewport .viewbar { gap: 4px; flex-wrap: wrap; justify-content: flex-end; max-width: calc(100% - 12px); }
  #viewport .viewbar button { padding: 3px 7px; font-size: 11px; white-space: nowrap; }
}
.tbm-pop { position: fixed; z-index: 66; width: min(360px, calc(100vw - 16px)); max-height: calc(100vh - 80px); overflow-y: auto; overscroll-behavior: contain; background: var(--panel); color: var(--text);
  border: 1px solid var(--line2); border-radius: 16px; padding: 8px 10px 12px; box-shadow: 0 30px 80px -24px #000d; }
.tbm-pop:focus { outline: none; }
.tbm-head { padding: 6px 4px 10px; border-bottom: 1px solid var(--line); margin-bottom: 10px; display: flex; flex-direction: column; gap: 2px; }
.tbm-head b { font-size: 14px; } .tbm-head span { font-size: 12px; color: var(--dim); }
.tbm-grid { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.tbm-grid > .tb-chips { display: flex !important; flex-wrap: wrap; flex-basis: 100%; overflow: visible; }
.tbm-grid > .vw-bar, .tbm-grid > .vw-btn, .tbm-grid > .vw-who { flex-wrap: wrap; }
body.clean .tbm-pop { display: none; }
`;
