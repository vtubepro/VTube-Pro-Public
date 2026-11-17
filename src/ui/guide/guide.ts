// ux-simplicity: the studio's first-run and way-finding layer (owner: "absolute braindead idiots can figure out what
// to do"; users are "allergic to technology"; it must feel ULTRA PREMIUM).
//  1. "What do you want to do?": on the very first open, four giant choices, each starting the right flow
//     (first-time setup, Add my model, room setup / Add my room, invite). Skippable; reopen any time from Help.
//  2. The guided tour: a spotlight on one thing at a time, one sentence each, Back / Next / Skip, Esc closes.
//  3. A persistent, labelled Help button in the top bar: "You're in <area>" + what to do here, Help for this screen
//     (the right guide section), the tour, the four choices, all guides, shortcuts, and Open Helper on the web.
//  4. A one-line "Next:" hint under each area's title until you dismiss it.
// Read-only: nothing here saves settings, starts the camera, talks to OBS or makes a sound. Observer pages
// (?observer=1) never open it by themselves and never write its "seen" flags; `?guideTest=home|tour|help` (observer
// pages only) opens a part for screenshots.
import type { App } from '../../app.ts';
import { h, toast } from '../dom.ts';
import { icon } from '../icons.ts';
import { openNamed } from '../wizards.ts';
import { wizardOpen } from '../wizard.ts';
import { copyInterviewLink } from '../guestLink.ts';
import { AREA_HELP, AREA_NEXT, CHOICES as ALL_CHOICES, STORE, TOUR, type ChoiceId, type GuideArea, type TourStep } from './content.ts';
import { isPhone } from '../../mobile/device.ts';
import { HELP_CHAT_URL, REPORT_URL, addMyModel, changelogUrl, hasHelpViewer, openGuide } from './links.ts';
import { displayName } from '../streamSafe.ts';
import { openHelpCheck, setHelpCheckHost } from './helpCheck.ts';
import { isGuidesOpen, openGuides } from '../help/guidesPage.ts';

export interface GuideHost {
  area(): GuideArea;
  areaTitle(a: GuideArea): string;
  advanced(): boolean;
  go(a: GuideArea): void;
  showShortcuts(): void;
}

const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage off */ } },
};
let host: GuideHost | null = null;
let app: App | null = null;
const observer = () => !!app?.observer;
/** Observer pages never remember anything (they are sandboxes). */
const remember = (k: string, v: string) => { if (!observer()) ls.set(k, v); };

// ================================================================ 1. "What do you want to do?"
let homeEl: HTMLElement | null = null;
export const startHomeOpen = () => !!homeEl;

/** Should the first-run home open by itself? Brand-new users only (the shell also checks observer / existing). */
export const startHomeDue = () => ls.get(STORE.home) !== 'done';

export function openStartHome(why: 'first' | 'help' = 'help') {
  if (!app || !host || homeEl) return;
  injectCss();
  const A = app, H = host;
  const prev = document.activeElement as HTMLElement | null;
  const name = displayName();
  // a phone: no helper / OBS choices, phone words (src/ui/guide/content.ts Choice.phone)
  const phone = isPhone();
  const CHOICES = phone ? ALL_CHOICES.filter((c) => !c.phone?.hide) : ALL_CHOICES;
  const close = (answered: boolean) => {
    if (!homeEl) return;
    homeEl.classList.add('out');
    const el = homeEl; homeEl = null;
    window.setTimeout(() => el.remove(), 180);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', paintHint);
    if (answered || why === 'first') remember(STORE.home, 'done');
    if (!answered) prev?.focus?.();
  };
  const run = (id: ChoiceId) => {
    close(true);
    switch (id) {
      case 'golive': if (isPhone()) { void import('../../mobile/showMode.ts').then((m) => m.openShowMode(A)); break; } openNamed(A, 'firstRun'); break;
      case 'model': void addMyModel(A, () => H.go('me')); break;
      case 'room': openNamed(A, 'room'); break;
      case 'invite':
        if (A.party.role === 'host') void copyInterviewLink(A); // a link is ready to paste: the toast says so
        H.go('friends');
        break;
    }
  };
  const cards = CHOICES.map((c, i) => {
    const sub = h('span', { class: 'gd-line' }, (phone && c.phone?.line) || c.line);
    const b = h('button', { class: `gd-choice${i === 0 ? ' main' : ''}`, 'data-choice': c.id, style: `--i:${i}`, onClick: () => run(c.id) },
      h('span', { class: 'gd-ic', 'aria-hidden': 'true' }, icon(c.icon, 30)),
      h('span', { class: 'gd-words' }, h('b', null, (phone && c.phone?.title) || c.title), sub, h('span', { class: 'gd-time' }, c.time)),
      h('span', { class: 'gd-key', 'aria-hidden': 'true' }, String(i + 1)));
    return b;
  });
  // FR-07: the choices scroll inside the card, the footer (Show me around / Skip) stays put, so at 390×844 both are always
  // on screen. A narrow layout keeps Help in the More menu, and the hint says so.
  const narrow = () => window.innerWidth <= 700;
  const hint = h('span', { class: 'gd-hint' });
  const paintHint = () => { hint.textContent = narrow() ? 'Help lives in the More menu (⋯). It brings this back.' : 'Help (top right) brings this back.'; };
  paintHint();
  window.addEventListener('resize', paintHint);
  const dialog = h('div', { class: 'gd-home', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gd-home-t', tabindex: -1 },
    h('button', { class: 'gd-skiptop', 'data-ui': 'gd-skip-top', onClick: () => close(false) }, 'Skip'),
    h('div', { class: 'gd-home-body' },
      h('p', { class: 'gd-eyebrow' }, h('i', { 'aria-hidden': 'true' }), name ? `Welcome, ${name}` : 'Welcome to VTube Pro'),
      h('h1', { id: 'gd-home-t' }, 'What do you want to do?'),
      // (clarity: the very first screen says what this page is, and that nothing is broadcast from it)
      h('p', { class: 'gd-lead' }, phone ? 'This is your studio: nothing is shared until you share your screen in your streaming app. Pick one; the rest stay on Home.' : 'This is your studio: nothing goes on stream until you start it in OBS. Pick one; the rest stay on Home.'),
      h('div', { class: 'gd-choices' }, ...cards)),
    h('div', { class: 'gd-foot' },
      h('button', { class: 'btn', 'data-ui': 'gd-tour', onClick: () => { close(true); window.setTimeout(() => startTour(), 200); } }, icon('play', 15), 'Show me around first'),
      h('button', { class: 'btn ghost', 'data-ui': 'gd-skip', onClick: () => close(false) }, 'Skip, I’ll look around myself'),
      hint));
  homeEl = h('div', { class: 'gd-back', onClick: (e: Event) => { if (e.target === homeEl) close(false); } }, dialog);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); return; }
    if ((e.target as HTMLElement)?.closest?.('input,textarea,select')) return;
    const n = Number(e.key);
    if (n >= 1 && n <= CHOICES.length && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); e.stopPropagation(); run(CHOICES[n - 1].id); return; }
    if (e.key === 'Tab') trapFocus(dialog, e);
  };
  window.addEventListener('keydown', onKey, true);
  document.body.append(homeEl);
  // focus the dialog, not a card: no ring "pre-selects" a choice for mouse users; Tab or 1-4 for the keyboard
  dialog.focus({ preventScroll: true });
}

function trapFocus(root: HTMLElement, e: KeyboardEvent) {
  const f = [...root.querySelectorAll<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetParent !== null);
  if (!f.length) return;
  const a = f[0], z = f[f.length - 1];
  if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
  else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
}

// ================================================================ 2. the guided tour
let tour: { close(done: boolean): void } | null = null;
export const tourOpen = () => !!tour;

const visible = (el: Element | null): el is HTMLElement => {
  if (!el) return false;
  const r = (el as HTMLElement).getBoundingClientRect();
  const cs = getComputedStyle(el);
  return r.width > 8 && r.height > 8 && cs.visibility !== 'hidden' && cs.display !== 'none' && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
};
const target = (s: TourStep) => { for (const q of s.sel) { const el = document.querySelector(q); if (visible(el)) return el; } return null; };

export function startTour() {
  if (!app || !host || tour) return;
  injectCss();
  const H = host;
  if (H.area() !== 'home') H.go('home');
  const prev = document.activeElement as HTMLElement | null;
  const shade = h('div', { class: 'gd-tour', role: 'presentation' });
  const hole = h('div', { class: 'gd-hole', 'aria-hidden': 'true' });
  const eyebrow = h('p', { class: 'gd-eyebrow' });
  const title = h('h2', { id: 'gd-tour-t' });
  const text = h('p', { class: 'gd-tour-text' });
  const back = h('button', { class: 'btn ghost', onClick: () => go(-1) }, 'Back') as HTMLButtonElement;
  const next = h('button', { class: 'btn primary', onClick: () => go(1) }, 'Next') as HTMLButtonElement;
  const skip = h('button', { class: 'gd-skip', onClick: () => close(false) }, 'Skip tour');
  const dots = h('div', { class: 'gd-dots', 'aria-hidden': 'true' });
  const bubble = h('div', { class: 'gd-bubble', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gd-tour-t', 'aria-describedby': 'gd-tour-x' },
    h('div', { class: 'gd-bubble-top' }, eyebrow, skip), title, text, h('div', { class: 'gd-bubble-row' }, dots, back, next));
  text.id = 'gd-tour-x';
  shade.append(hole, bubble);
  let steps: TourStep[] = [];
  let ix = 0;

  function place() {
    const s = steps[ix];
    const el = s ? target(s) : null;
    const pad = 8;
    if (el) {
      const r = el.getBoundingClientRect();
      const x = Math.max(4, r.left - pad), y = Math.max(4, r.top - pad);
      const w = Math.min(innerWidth - 8, r.right + pad) - x, hh = Math.min(innerHeight - 8, r.bottom + pad) - y;
      Object.assign(hole.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hh}px`, opacity: '1' });
      // the bubble goes where there is most room: right, below, left, above (then clamped into the window)
      const bw = Math.min(360, innerWidth - 24), bh = bubble.offsetHeight || 170, gap = 16;
      const room = { right: innerWidth - (x + w), below: innerHeight - (y + hh), left: x, above: y };
      let bx: number, by: number;
      if (room.right >= bw + gap * 2 && hh < innerHeight * 0.9) { bx = x + w + gap; by = y + Math.min(hh / 2 - bh / 2, hh - bh); }
      else if (room.below >= bh + gap * 2) { bx = x + w / 2 - bw / 2; by = y + hh + gap; }
      else if (room.left >= bw + gap * 2) { bx = x - bw - gap; by = y + hh / 2 - bh / 2; }
      else if (room.above >= bh + gap * 2) { bx = x + w / 2 - bw / 2; by = y - bh - gap; }
      else { bx = x + w / 2 - bw / 2; by = y + hh / 2 - bh / 2; } // big target: sit on top of it
      bubble.style.width = `${bw}px`;
      bubble.style.left = `${Math.round(Math.max(12, Math.min(innerWidth - bw - 12, bx)))}px`;
      bubble.style.top = `${Math.round(Math.max(12, Math.min(innerHeight - bh - 12, by)))}px`;
    } else {
      hole.style.opacity = '0';
      bubble.style.left = `${Math.round(innerWidth / 2 - 180)}px`; bubble.style.top = `${Math.round(innerHeight / 2 - 90)}px`;
    }
  }
  function paint() {
    const s = steps[ix];
    eyebrow.textContent = `Step ${ix + 1} of ${steps.length}`;
    title.textContent = s.title;
    text.textContent = s.text;
    back.disabled = ix === 0;
    back.style.visibility = ix === 0 ? 'hidden' : '';
    const last = ix === steps.length - 1;
    next.textContent = last ? 'Done' : 'Next';
    dots.replaceChildren(...steps.map((_, i) => h('i', { class: i === ix ? 'on' : i < ix ? 'done' : '' })));
    place();
    requestAnimationFrame(place); // the bubble's height is known after the first layout
    next.focus({ preventScroll: true });
  }
  function go(d: number) {
    if (d > 0 && ix === steps.length - 1) { close(true); return; }
    ix = Math.max(0, Math.min(steps.length - 1, ix + d));
    paint();
  }
  function close(done: boolean) {
    if (!tour) return;
    tour = null;
    remember(STORE.tour, done ? 'done' : 'skipped');
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    shade.classList.add('out');
    window.setTimeout(() => shade.remove(), 180);
    if (done) toast('You’re all set! Press Help any time.', 'ok', 4200);
    prev?.focus?.();
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { if (e.key === 'Enter' && (e.target as HTMLElement) !== next && bubble.contains(e.target as Node)) return; e.preventDefault(); e.stopPropagation(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(-1); }
    else if (e.key === 'Tab') trapFocus(bubble, e);
  };
  tour = { close };
  // wait for Home to draw, then keep only the steps that are on screen
  window.setTimeout(() => {
    steps = TOUR.filter((s) => !!target(s));
    if (!steps.length) { tour = null; toast('Nothing to show right now. Press Help if you get stuck.', 'info'); return; }
    document.body.append(shade);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    paint();
  }, H.area() === 'home' ? 60 : 400);
}

// ================================================================ 3. the Help button
let menuEl: HTMLElement | null = null;
function closeMenu() { menuEl?.remove(); menuEl = null; document.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', menuKey, true); }
const outside = (e: Event) => { if (menuEl && !menuEl.contains(e.target as Node) && !(e.target as HTMLElement)?.closest?.('.gd-help')) closeMenu(); };
const menuKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && menuEl) { e.preventDefault(); e.stopPropagation(); closeMenu(); (document.querySelector('.gd-help') as HTMLElement | null)?.focus(); } };

export function openHelpMenu(anchor?: HTMLElement, viaKeyboard = true) {
  if (!host) return;
  if (menuEl) { closeMenu(); return; }
  injectCss();
  const H = host;
  const A = app!;
  const a = H.area(), adv = H.advanced();
  // "this screen" is the page on top when one is open (Guides), else the area
  const helpTo = AREA_HELP[a] ? (adv ? AREA_HELP[a].advanced : AREA_HELP[a].simple) : 'QUICK_START.md';
  const item = (ic: string, t: string, d: string, run: () => void, cls = '') =>
    h('button', { class: `gd-mi ${cls}`, role: 'menuitem', onClick: () => { closeMenu(); run(); } }, h('span', { class: 'gd-mi-ic', 'aria-hidden': 'true' }, icon(ic, 18)), h('span', null, h('b', null, t), h('span', null, d)));
  const nextLine = AREA_NEXT[a];
  const page = isGuidesOpen() ? 'Guides' : null;
  menuEl = h('div', { class: 'gd-menu', role: 'menu', 'aria-label': 'Help', tabindex: -1 },
    h('div', { class: 'gd-where' }, h('span', { class: 'gd-eyebrow' }, h('i', { 'aria-hidden': 'true' }), 'You’re in'), h('b', null, page ?? H.areaTitle(a)), nextLine && !page ? h('p', null, nextLine) : null),
    item('check', 'Help me', 'Checks your setup and says what to do next.', () => openHelpCheck(), 'main'),
    item('target', 'Tutorials', 'Step by step: we point at each button and wait for you.', () => void import('../tutorials/index.ts').then((m) => m.openTutorials())),
    item('help', 'Help for this screen', 'Opens the guide right at this part.', () => { if (isGuidesOpen()) openGuides(); else void openGuide(helpTo); }),
    item('play', 'Show me around', 'A 1-minute tour. One thing at a time.', () => startTour()),
    item('home', 'What do you want to do?', 'Go live, add your model, pick a room, invite.', () => openStartHome('help')),
    item('speak', 'Best lip sync for me', 'We check your setup and pick what fits.', () => void import('../lipsyncGuide.ts').then((m) => m.openLipSyncGuide(A, { from: 'help', nav: { go: (x) => H.go(x as GuideArea) } }))),
    item('power', 'Check my computer', 'See which heavy features fit your computer.', () => void import('../lipsyncGuide.ts').then((m) => m.openHardwareCheck(A, { nav: { go: (x) => H.go(x as GuideArea) } }))),
    item('search', 'All guides', 'Every guide, with search, as a page in the studio.', () => openGuides()),
    item('users', 'Ask for help', 'Ask a question on the project’s GitHub page.', () => { window.open(HELP_CHAT_URL, '_blank', 'noopener'); }),
    item('chat', 'Report a problem', 'Tell us what went wrong. Opens our bug page on GitHub (a free GitHub account). Never share passwords.', () => { window.open(REPORT_URL, '_blank', 'noopener'); }),
    item('popout', 'Changelog', 'What’s new in VTube Pro (opens the releases page on GitHub).', () => { window.open(changelogUrl(), '_blank', 'noopener'); }),
    item('keys', 'Keyboard shortcuts', 'Or press ? any time.', () => H.showShortcuts()));
  document.body.append(menuEl);
  const r = (anchor ?? document.querySelector('.gd-help'))?.getBoundingClientRect();
  if (r) { menuEl.style.top = `${Math.round(r.bottom + 8)}px`; menuEl.style.right = `${Math.max(8, Math.round(innerWidth - r.right))}px`; }
  document.addEventListener('pointerdown', outside, true);
  window.addEventListener('keydown', menuKey, true);
  if (viaKeyboard) (menuEl.querySelector('.gd-mi') as HTMLElement | null)?.focus();
  else (menuEl as HTMLElement).focus({ preventScroll: true });
}

function mountHelpButton() {
  const top = document.getElementById('topbar');
  if (!top || top.querySelector('.gd-help')) return;
  const btn = h('button', { class: 'gd-help', title: 'Help: guides, a tour, and what to do next', 'aria-haspopup': 'menu', onClick: (e: MouseEvent) => openHelpMenu(e.currentTarget as HTMLElement, e.detail === 0) },
    icon('help', 17), h('span', null, 'Help'));
  top.append(btn);
  // one Help in the top bar: the older icon-only help button stays reachable by its keys (? and F1), not twice on screen
  const hideOld = () => top.querySelectorAll<HTMLElement>('.icon-btn[aria-label^="Help"]').forEach((b) => { b.style.display = 'none'; });
  hideOld();
  if (!hasHelpViewer()) {
    // without the in-app Help viewer nothing owns F1: let it open this menu
    window.addEventListener('keydown', (e) => { if (e.key === 'F1' && !e.ctrlKey && !e.altKey) { e.preventDefault(); openHelpMenu(); } });
  }
}

// ================================================================ 4. the "Next:" line under each area title
const dismissed = (): string[] => { try { const v = JSON.parse(ls.get(STORE.next) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
/** One sentence under the area title: where you are and what to do here. Null once dismissed (or for Advanced users). */
export function nextHint(area: string): HTMLElement | null {
  const text = AREA_NEXT[area as GuideArea];
  if (!text || dismissed().includes(area) || ls.get('vtp.ui.mode') === 'advanced') return null;
  injectCss();
  const el = h('div', { class: 'gd-next', role: 'note' },
    h('span', { class: 'gd-next-tag' }, 'Next'), h('span', { class: 'gd-next-t' }, text),
    h('button', { class: 'gd-next-x', title: 'Hide this tip', onClick: () => { remember(STORE.next, JSON.stringify([...dismissed(), area])); el.remove(); } }, 'Got it'));
  return el;
}

// ================================================================ wiring
/** Called once by the shell (src/ui/shell.ts). `firstOpen`: this is a brand-new user's first launch. */
export function initGuide(a: App, hst: GuideHost, opts: { firstOpen: boolean }) {
  app = a; host = hst;
  setHelpCheckHost((x) => hst.go(x));
  injectCss();
  mountHelpButton();
  const test = new URLSearchParams(location.search).get('guideTest');
  if (a.observer && new URLSearchParams(location.search).has('lipsyncTest')) void import('../lipsyncGuide.ts').then((m) => m.maybeOpenLipSyncTest(a));
  if (test && a.observer) {
    window.setTimeout(() => { if (test === 'home') openStartHome('help'); else if (test === 'tour') startTour(); else if (test === 'help') openHelpMenu(); else if (test === 'check') openHelpCheck(); }, 900);
    return;
  }
  if (opts.firstOpen && !a.observer && startHomeDue()) window.setTimeout(() => { if (!wizardOpen()) openStartHome('first'); }, 600);
}

// ================================================================ style (BRAND.md tokens through the studio's own variables)
function injectCss() {
  if (document.getElementById('vtp-guide')) return;
  document.head.append(h('style', { id: 'vtp-guide' }, CSS));
}
const CSS = `
.gd-back { position: fixed; inset: 0; z-index: 62; display: grid; place-items: center; padding: 24px; background: radial-gradient(120% 90% at 50% 0%, #7bd88f14, transparent 60%), #05070bd0; backdrop-filter: blur(6px) saturate(130%); animation: gd-fade 220ms var(--ease, ease) both; }
.gd-back.out, .gd-tour.out { animation: gd-fade 160ms var(--ease, ease) reverse both; }
@keyframes gd-fade { from { opacity: 0; } to { opacity: 1; } }
.gd-home { position: relative; display: flex; flex-direction: column; width: min(860px, 100%); max-height: calc(100vh - 48px); max-height: calc(100dvh - 48px); overflow: hidden; background: linear-gradient(180deg, #ffffff0d, #ffffff04), var(--panel); color: var(--text); border: 1px solid var(--line2); border-radius: 24px; padding: 0; box-shadow: 0 40px 120px -30px #000c, inset 0 1px 0 #ffffff12; animation: gd-rise 420ms cubic-bezier(.16,1,.3,1) both; }
@keyframes gd-rise { from { opacity: 0; transform: translateY(14px) scale(.985); } to { opacity: 1; transform: none; } }
.gd-eyebrow { display: inline-flex; align-items: center; gap: 8px; margin: 0; font: 600 11px/1 ui-monospace, "Geist Mono", SFMono-Regular, Menlo, monospace; letter-spacing: .2em; text-transform: uppercase; color: var(--accent); }
.gd-eyebrow i { width: 22px; height: 1px; background: var(--accent); opacity: .7; }
html .gd-back .gd-home:is(:focus, :focus-visible), html body .gd-menu:is(:focus, :focus-visible) { outline: none !important; box-shadow: 0 40px 120px -30px #000c, inset 0 1px 0 #ffffff12 !important; }
.gd-home h1 { margin: 12px 0 6px; font: 750 clamp(26px, 3.4vw, 36px)/1.08 var(--font-display, system-ui); letter-spacing: -.025em; }
.gd-lead { margin: 0 0 22px; color: var(--dim); font-size: 15px; }
.gd-choices { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.gd-choice { position: relative; display: grid; grid-template-columns: auto 1fr; gap: 16px; align-items: start; text-align: left; padding: 20px 20px 18px; min-height: 132px; border-radius: 18px; border: 1px solid var(--line2); background: var(--card); color: var(--text); font: inherit; cursor: pointer; transition: transform 180ms cubic-bezier(.16,1,.3,1), border-color 160ms, background 160ms, box-shadow 180ms; animation: gd-rise 520ms cubic-bezier(.16,1,.3,1) both; animation-delay: calc(80ms + var(--i) * 60ms); }
.gd-choice:hover { transform: translateY(-2px); border-color: var(--accent); background: color-mix(in srgb, var(--accent) 6%, var(--card)); box-shadow: 0 18px 40px -22px #000c; }
.gd-choice:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.gd-choice.main { border-color: color-mix(in srgb, var(--accent) 55%, transparent); background: linear-gradient(140deg, color-mix(in srgb, var(--accent) 16%, var(--card)), var(--card) 70%); box-shadow: 0 0 0 1px #7bd88f22, 0 22px 50px -26px #7bd88f66; }
.gd-ic { width: 56px; height: 56px; border-radius: 16px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); }
.gd-choice.main .gd-ic { background: var(--accent); color: var(--accent-ink); }
.gd-words b { display: block; font: 700 20px/1.15 var(--font-display, system-ui); letter-spacing: -.015em; margin-top: 2px; }
.gd-line { display: block; color: var(--dim); font-size: 14px; line-height: 1.45; margin-top: 6px; }
.gd-time { display: inline-block; margin-top: 10px; font-size: 11.5px; color: var(--faint); }
.gd-key { position: absolute; top: 14px; right: 14px; width: 22px; height: 22px; border-radius: 7px; border: 1px solid var(--line2); color: var(--faint); font-size: 11px; display: grid; place-items: center; }
.gd-helperrow { display: flex; align-items: center; gap: 12px; margin-top: 14px; padding: 12px 14px; border-radius: 14px; border: 1px dashed var(--line2); color: var(--dim); font-size: 13.5px; }
.gd-helperrow span { flex: 1; }
.gd-home-body { flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 34px 34px 18px; }
.gd-foot { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 14px 34px 18px; border-top: 1px solid var(--line); background: var(--panel); }
.gd-skiptop { position: absolute; top: 14px; right: 16px; z-index: 2; border: 0; background: none; color: var(--dim); font: inherit; font-size: 13px; cursor: pointer; padding: 6px 10px; min-height: 32px; border-radius: 8px; }
.gd-skiptop:hover { color: var(--text); background: var(--card2); }
.gd-foot .btn { display: inline-flex; align-items: center; gap: 7px; min-height: 38px; border-radius: 12px; }
.gd-hint { margin-left: auto; color: var(--faint); font-size: 12px; }
@media (max-width: 700px) { .gd-key { display: none; } .gd-back { padding: 12px; } .gd-home { max-height: calc(100vh - 24px); max-height: calc(100dvh - 24px); border-radius: 20px; } .gd-home-body { padding: 22px 16px 12px; } .gd-home h1 { margin-right: 44px; }
  .gd-choices { grid-template-columns: 1fr; gap: 8px; } .gd-choice { min-height: 0; padding: 12px 14px; gap: 12px; } .gd-ic { width: 44px; height: 44px; border-radius: 13px; } .gd-words b { font-size: 17px; } .gd-line { margin-top: 3px; font-size: 13px; } .gd-time { margin-top: 5px; }
  .gd-lead { margin-bottom: 14px; font-size: 14px; } .gd-foot { padding: 10px 16px 12px; gap: 6px; } .gd-foot .btn { flex: 1 1 100%; justify-content: center; min-height: 40px; } .gd-hint { margin-left: 0; flex: 1 1 100%; text-align: center; font-size: 11.5px; } }

.gd-tour { position: fixed; inset: 0; z-index: 70; animation: gd-fade 200ms var(--ease, ease) both; }
.gd-hole { position: fixed; border-radius: 14px; box-shadow: 0 0 0 2px var(--accent), 0 0 0 6px #7bd88f33, 0 0 0 200vmax #05070bc4; transition: left 320ms cubic-bezier(.16,1,.3,1), top 320ms cubic-bezier(.16,1,.3,1), width 320ms cubic-bezier(.16,1,.3,1), height 320ms cubic-bezier(.16,1,.3,1), opacity 200ms; pointer-events: none; }
.gd-bubble { position: fixed; z-index: 71; background: var(--panel); color: var(--text); border: 1px solid var(--line2); border-radius: 18px; padding: 16px 18px 14px; box-shadow: 0 30px 80px -24px #000d, inset 0 1px 0 #ffffff10; transition: left 320ms cubic-bezier(.16,1,.3,1), top 320ms cubic-bezier(.16,1,.3,1); }
.gd-bubble-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.gd-bubble h2 { margin: 10px 0 4px; font: 700 19px/1.2 var(--font-display, system-ui); letter-spacing: -.015em; }
.gd-tour-text { margin: 0; color: var(--dim); font-size: 14.5px; line-height: 1.5; }
.gd-bubble-row { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
.gd-bubble-row .btn { min-height: 34px; border-radius: 10px; padding: 6px 14px; }
.gd-dots { display: flex; gap: 5px; margin-right: auto; }
.gd-dots i { width: 6px; height: 6px; border-radius: 3px; background: var(--line2); transition: width 200ms, background 200ms; }
.gd-dots i.done { background: color-mix(in srgb, var(--accent) 50%, var(--line2)); }
.gd-dots i.on { width: 18px; background: var(--accent); }
.gd-skip { border: 0; background: none; color: var(--dim); font: inherit; font-size: 12.5px; cursor: pointer; padding: 4px 6px; border-radius: 6px; }
.gd-skip:hover { color: var(--text); }

.gd-help { display: inline-flex; align-items: center; gap: 7px; height: 34px; padding: 0 14px 0 11px; margin-left: 6px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--line2)); background: var(--accent-soft); color: var(--text); font: 600 13.5px/1 inherit; font-family: inherit; cursor: pointer; transition: background 160ms, border-color 160ms; white-space: nowrap; }
.gd-help svg { color: var(--accent); }
.gd-help:hover { background: color-mix(in srgb, var(--accent) 22%, transparent); border-color: var(--accent); }
.gd-help:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.gd-menu { position: fixed; z-index: 66; width: min(340px, calc(100vw - 16px)); background: var(--panel); color: var(--text); border: 1px solid var(--line2); border-radius: 16px; padding: 8px; box-shadow: 0 30px 80px -24px #000d; animation: gd-rise 260ms cubic-bezier(.16,1,.3,1) both;
  max-height: calc(100vh - 100px); overflow-y: auto; overscroll-behavior: contain; /* (1366×768: the last items were off-screen) */ }
.gd-where { padding: 10px 10px 12px; border-bottom: 1px solid var(--line); margin-bottom: 6px; }
.gd-where b { display: block; margin-top: 6px; font: 700 18px/1.2 var(--font-display, system-ui); }
.gd-where p { margin: 4px 0 0; color: var(--dim); font-size: 13px; line-height: 1.45; }
.gd-mi { display: grid; grid-template-columns: auto 1fr; gap: 12px; align-items: center; width: 100%; text-align: left; padding: 9px 10px; border: 0; border-radius: 11px; background: none; color: var(--text); font: inherit; cursor: pointer; }
.gd-mi:hover, .gd-mi:focus-visible { background: var(--card2); outline: none; }
.gd-mi-ic { width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center; background: var(--card2); color: var(--text); }
.gd-mi.main .gd-mi-ic { background: var(--accent); color: var(--accent-ink); }
.gd-mi b { display: block; font-size: 14px; }
.gd-mi span > span { display: block; color: var(--dim); font-size: 12px; margin-top: 1px; }

.gd-next { display: flex; align-items: center; gap: 10px; margin: 8px 0 2px; padding: 8px 8px 8px 10px; border-radius: 12px; background: var(--accent-soft); border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); font-size: 13px; line-height: 1.4; }
.gd-next-tag { flex: none; font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .16em; text-transform: uppercase; color: var(--accent-ink); background: var(--accent); padding: 4px 7px; border-radius: 999px; }
.gd-next-t { flex: 1; color: var(--text); }
.gd-next-x { flex: none; border: 0; background: none; color: var(--dim); font: inherit; font-size: 12px; cursor: pointer; padding: 4px 6px; border-radius: 6px; }
.gd-next-x:hover { color: var(--text); }
@media (prefers-reduced-motion: reduce) { .gd-back, .gd-home, .gd-choice, .gd-menu, .gd-tour, .gd-hole, .gd-bubble { animation: none !important; transition: none !important; } }
`;
