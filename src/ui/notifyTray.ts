// UX redesign: ONE notification tray (the bell in the top bar, new layout only). Testers (2026-10-04): notices were
// scattered (the update notice and the open-beta note in the area header, guest knocks only inside Live Control and the
// Party panel, errors as toasts that vanish). The tray collects them in one list with an unread count:
//   * standing notices move INTO the tray, the same elements with the same buttons - adoptNotice(). Classic layout
//     puts them back exactly where they were (a marker remembers the spot);
//   * guests knocking (party host): "X is knocking" with Let in / Deny (the same calls as Live Control);
//   * every toast, newest first (errors and warnings count as unread; info / ok ones were seen when they popped up).
// Toasts still pop up as before: the tray is where they can be read again. Opening the tray marks everything read; a
// notice whose text was seen stays read after a reload (only short hashes are kept: localStorage 'vtp.tray.seen').
// Nothing here is sent anywhere, saved to disk, or played: it is a list on this page.
import type { App } from '../app.ts';
import { h, setToastSink } from './dom.ts';
import { icon } from './icons.ts';
import { fitMenu, isClassic, onLayoutMode } from './layoutMode.ts';
import { NoteLog, agoText, badgeText, noticeSig, unreadCount, type NoteKind } from '../../shared/uxLayout.ts';

const SEEN_KEY = 'vtp.tray.seen';
const log = new NoteLog();
let appRef: App | null = null;
let bell: HTMLButtonElement | null = null;
let badge: HTMLElement | null = null;
let panel: HTMLElement | null = null;
let noticesBox: HTMLElement | null = null;
let knockSec: HTMLElement | null = null;
let noticeSec: HTMLElement | null = null;
let logSec: HTMLElement | null = null;
let logList: HTMLElement | null = null;
let emptyEl: HTMLElement | null = null;
let isOpen = false;
let movingOurselves = false;
const listeners = new Set<() => void>();

interface Adopted { el: HTMLElement; mark: Comment; mo: MutationObserver }
const adopted: Adopted[] = [];
const knocksSeen = new Set<string>();
const knocksUnread = new Set<string>();

// ---------------------------------------------------------------- seen notices (short hashes only)
const hash = (s: string) => { let x = 5381; for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0; return (x >>> 0).toString(36); };
let seen: string[] | null = null;
function seenList(): string[] {
  if (!seen) { try { const v = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'); seen = Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(-30) : []; } catch { seen = []; } }
  return seen!;
}
function markSeen(sig: string) {
  const k = hash(sig), l = seenList();
  if (l.includes(k)) return;
  l.push(k); if (l.length > 30) l.splice(0, l.length - 30);
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(l)); } catch { /* storage off: this tab only */ }
}
// (the notice's headline: the update bar's text block, the beta note's bold line; a changed sub-line is not news)
const sigOf = (el: HTMLElement) => noticeSig(!!el.hidden || !el.isConnected, (el.querySelector('.t') ?? el.querySelector('b') ?? el).textContent);

// ---------------------------------------------------------------- counts
function noticesUnread(): number { return adopted.filter((a) => { const s = sigOf(a.el); return !!s && !seenList().includes(hash(s)); }).length; }
/** The bell's number right now. */
export function trayUnread(): number { return unreadCount({ log: log.unread(), notices: noticesUnread(), knocks: knocksUnread.size }); }
/** Knocks waiting right now (the bell pulses). */
const knocksWaiting = () => appRef?.party.role === 'host' ? appRef.party.knocks.length : 0;
export function onTray(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }

function paintBell() {
  if (!bell || !badge) return;
  const n = trayUnread(), t = badgeText(n);
  if (badge.textContent !== t) badge.textContent = t;
  badge.hidden = !t;
  bell.classList.toggle('urgent', knocksWaiting() > 0);
  const label = n ? `Notifications, ${n} unread` : 'Notifications';
  if (bell.getAttribute('aria-label') !== label) bell.setAttribute('aria-label', label);
  for (const f of listeners) try { f(); } catch { /* listener */ }
}

// ---------------------------------------------------------------- standing notices
/** Put a notice element into the tray (new layout) or leave it where it is (Classic). Call it after mounting the element
 *  where it lives in Classic (the area header). Its own code keeps owning it: hiding it, its buttons, removing it. */
export function adoptNotice(el: HTMLElement | null | undefined) {
  if (!el || adopted.some((a) => a.el === el)) return;
  const mark = document.createComment(`notice ${el.dataset.ui ?? ''}`);
  if (el.parentNode) el.before(mark); else (document.getElementById('area-head-slot') ?? document.body).append(mark);
  const mo = new MutationObserver(() => { if (!movingOurselves) changed(); });
  mo.observe(el, { attributes: true, attributeFilter: ['hidden', 'class'], childList: true, subtree: true, characterData: true });
  adopted.push({ el, mark, mo });
  placeNotices();
  changed();
}
function placeNotices() {
  movingOurselves = true;
  try {
    for (let i = adopted.length - 1; i >= 0; i--) {
      const a = adopted[i];
      // (we never leave one detached: a notice that is gone was removed by its owner, e.g. the beta note's Hide)
      if (!a.el.isConnected) { a.mo.disconnect(); a.mark.remove(); adopted.splice(i, 1); }
    }
    if (isClassic() || !noticesBox) {
      for (const a of adopted) if (a.mark.isConnected && a.mark.nextSibling !== a.el) a.mark.after(a.el);
    } else {
      const want = adopted.map((a) => a.el), cur = [...noticesBox.children];
      if (want.length !== cur.length || want.some((e, i) => cur[i] !== e)) noticesBox.append(...want);
    }
  } finally { movingOurselves = false; }
}

// ---------------------------------------------------------------- knocks
// The open tray never rebuilds what did not change (verifiers 2026-10-04: a repaint on every 1.5 s poll replaced the
// Let in / Deny buttons under the host's pointer, so some clicks were lost and keyboard focus fell to the page). Rows
// are kept per knocking peer and only added / removed / moved when the list itself changes.
const knocksNow = () => { const P = appRef?.party; return P && P.role === 'host' ? P.knocks : []; };
/** The knock list as the tray paints it (who, what name, link or not). */
const knockKey = (list: readonly { peer: string; user?: { name?: string } | null; link?: boolean }[]) => JSON.stringify(list.map((k) => [k.peer, k.user?.name ?? '', !!k.link]));
let paintedKnocks = '[]';
function syncKnocks() {
  const list = knocksNow();
  const now = new Set(list.map((k) => k.peer));
  let fresh = false;
  for (const p of now) if (!knocksSeen.has(p)) { knocksSeen.add(p); if (!isOpen) { knocksUnread.add(p); fresh = true; } }
  for (const p of [...knocksSeen]) if (!now.has(p)) { knocksSeen.delete(p); knocksUnread.delete(p); }
  if (fresh || (isOpen && knockKey(list) !== paintedKnocks)) changed(); else paintBell();
}
const knockEls = new Map<string, { el: HTMLElement; sig: string }>();
let knockHead: HTMLElement | null = null;
function knockRow(peer: string, name: string, link: boolean): HTMLElement {
  // (the click acts on the peer's knock as it is NOW: a guest who knocks again gets a new knock object)
  const act = (fn: 'approve' | 'deny') => () => {
    const P = appRef?.party, k = P?.knocks.find((x) => x.peer === peer);
    if (P && k) { if (fn === 'approve') void P.approve(k); else P.deny(k); }
    syncKnocks();
  };
  return h('div', { class: 'ntf-knock', 'data-knock': peer },
    h('span', { class: 'ic', 'aria-hidden': 'true' }, icon('door', 16)),
    h('span', { class: 'who' }, h('b', null, name), ' is knocking',
      link ? h('span', { class: 'tag', title: 'Came in with your guest link: they typed this name themselves (not verified)' }, 'LINK') : null),
    h('button', { class: 'btn primary', onClick: act('approve') }, 'Let in'),
    h('button', { class: 'btn', onClick: act('deny') }, 'Deny'));
}
function knockRows(): HTMLElement[] {
  const list = knocksNow();
  paintedKnocks = knockKey(list);
  const rows = list.map((k) => {
    const name = k.user?.name ?? 'Someone', sig = JSON.stringify([name, !!k.link]);
    let r = knockEls.get(k.peer);
    if (!r || r.sig !== sig) { r = { el: knockRow(k.peer, name, !!k.link), sig }; knockEls.set(k.peer, r); }
    return r.el;
  });
  for (const p of [...knockEls.keys()]) if (!list.some((k) => k.peer === p)) knockEls.delete(p);
  return rows;
}
/** Make `parent`'s children exactly `want`, touching only what is missing, gone or out of place (an element that stays
 *  keeps its focus, a text selection in it and a click that is half done). */
function syncChildren(parent: HTMLElement, want: HTMLElement[]) {
  const keep = new Set<Element>(want);
  for (const c of [...parent.children]) if (!keep.has(c)) c.remove();
  want.forEach((el, i) => { const at = parent.children[i]; if (at !== el) parent.insertBefore(el, at ?? null); });
}

// ---------------------------------------------------------------- the panel
function changed() {
  if (isOpen) { markAllRead(); paintPanel(); }
  paintBell();
}
function markAllRead() {
  log.markRead();
  knocksUnread.clear();
  for (const a of adopted) { const s = sigOf(a.el); if (s) markSeen(s); }
}
const KIND_LABEL: Record<NoteKind, string> = { info: 'Info', ok: 'Done', warn: 'Warning', err: 'Error' };
// (one list item per log entry, kept while the entry is listed: only its "4 min ago (3x)" line is updated in place)
const logEls = new Map<number, { li: HTMLElement; t: HTMLElement }>();
function logItems(now: number): HTMLElement[] {
  const items = log.entries.map((e) => {
    let r = logEls.get(e.id);
    if (!r) {
      const t = h('span', { class: 't' });
      r = { li: h('li', { class: `ntf-item k-${e.kind}` },
        h('span', { class: 'dot', title: KIND_LABEL[e.kind], 'aria-label': KIND_LABEL[e.kind] }),
        h('span', { class: 'm' }, e.msg), t), t };
      logEls.set(e.id, r);
    }
    const when = agoText(e.at, now) + (e.n > 1 ? ` (${e.n}x)` : '');
    if (r.t.textContent !== when) r.t.textContent = when;
    return r.li;
  });
  const ids = new Set(log.entries.map((e) => e.id));
  for (const id of [...logEls.keys()]) if (!ids.has(id)) logEls.delete(id);
  return items;
}
function setHidden(el: HTMLElement, hide: boolean) { if (el.hidden !== hide) el.hidden = hide; }
function paintPanel() {
  if (!panel || !logList || !knockSec || !noticeSec || !logSec || !emptyEl) return;
  const knocks = knockRows();
  setHidden(knockSec, !knocks.length);
  knockHead ??= h('h4', null, 'Waiting for you');
  syncChildren(knockSec, [knockHead, ...knocks]);
  const showing = adopted.filter((a) => !!sigOf(a.el)).length;
  setHidden(noticeSec, !showing);
  syncChildren(logList, logItems(Date.now()));
  setHidden(logSec, !log.entries.length);
  setHidden(emptyEl, !!(knocks.length || showing || log.entries.length));
}
let fit: (() => void) | null = null;
function place() {
  if (!panel || !bell) return;
  // cr-01: fits the window (max height = innerHeight - top - 8, never off the left edge); a bottom sheet at 600 px or less
  // (its header's close button is the sheet's Close)
  if (!fit) fit = fitMenu(panel, { anchor: bell, close: () => { closeTray(); bell?.focus(); }, ownClose: true });
  fit();
}
const outside = (e: Event) => { const t = e.target as Node; if (panel && !panel.contains(t) && !bell?.contains(t)) closeTray(); };
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && isOpen && !document.querySelector('dialog[open]')) { e.preventDefault(); e.stopPropagation(); closeTray(); bell?.focus(); } };
let tick = 0;
/** Open the tray (the bell, or Home's Notifications tile). */
export function openTray() {
  if (!panel || isClassic()) return;
  if (isOpen) { place(); return; }
  isOpen = true;
  panel.hidden = false;
  bell?.setAttribute('aria-expanded', 'true');
  bell?.classList.add('on');
  place();
  markAllRead();
  paintPanel(); paintBell();
  document.addEventListener('pointerdown', outside, true);
  window.addEventListener('keydown', onKey, true);
  tick = window.setInterval(() => { if (isOpen) paintPanel(); }, 30_000);
  (panel.querySelector('.ntf-head .x') as HTMLElement | null)?.focus({ preventScroll: true });
}
export function closeTray() {
  if (!panel || !isOpen) return;
  isOpen = false;
  panel.hidden = true;
  bell?.setAttribute('aria-expanded', 'false');
  bell?.classList.remove('on');
  document.removeEventListener('pointerdown', outside, true);
  window.removeEventListener('keydown', onKey, true);
  clearInterval(tick);
  paintBell();
}
export const trayOpen = () => isOpen;

/** Build the bell (returned, for the top bar) + the panel, and start collecting. Once, by the shell. */
export function initNotifyTray(app: App): HTMLButtonElement {
  if (bell) return bell;
  appRef = app;
  if (!document.getElementById('vtp-ntf-css')) document.head.append(h('style', { id: 'vtp-ntf-css' }, CSS));
  badge = h('span', { class: 'ntf-badge', hidden: true, 'aria-hidden': 'true' });
  bell = h('button', { class: 'icon-btn ntf-bell ux-only', type: 'button', title: 'Notifications: updates, guests knocking, messages', 'aria-label': 'Notifications', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-ui': 'tray-bell',
    onClick: () => { if (isOpen) closeTray(); else openTray(); } }, icon('bell', 18), badge) as HTMLButtonElement;
  noticesBox = h('div', { class: 'ntf-notices' });
  // (a notice its owner removes - the beta note's Hide - leaves at once: the header and "Nothing new." follow)
  new MutationObserver(() => changed()).observe(noticesBox, { childList: true });
  knockSec = h('div', { class: 'ntf-sec', 'data-sec': 'knocks', hidden: true });
  noticeSec = h('div', { class: 'ntf-sec', 'data-sec': 'notices', hidden: true }, h('h4', null, 'Notices'), noticesBox);
  logList = h('ol', { class: 'ntf-log' });
  logSec = h('div', { class: 'ntf-sec', 'data-sec': 'log', hidden: true },
    h('div', { class: 'ntf-sub' }, h('h4', null, 'Recent messages'), h('button', { class: 'ntf-link', type: 'button', onClick: () => { log.clear(); paintPanel(); paintBell(); } }, 'Clear')),
    logList);
  emptyEl = h('p', { class: 'ntf-empty' }, h('b', null, 'Nothing new.'), ' Updates, guests knocking and messages from the studio collect here.');
  // (always in the page, hidden while closed: the notices inside keep working and stay connected)
  panel = h('div', { class: 'ntf-panel', role: 'dialog', 'aria-label': 'Notifications', hidden: true, 'data-ui': 'tray' },
    h('div', { class: 'ntf-head' }, h('span', { class: 'ic', 'aria-hidden': 'true' }, icon('bell', 16)), h('b', null, 'Notifications'), h('span', { class: 'sp' }),
      h('button', { class: 'x', type: 'button', 'aria-label': 'Close notifications', title: 'Close (Esc)', onClick: () => { closeTray(); bell?.focus(); } }, icon('x', 16))),
    h('div', { class: 'ntf-scroll' }, knockSec, noticeSec, logSec, emptyEl));
  document.body.append(panel);
  setToastSink((msg, kind) => { log.add(msg, kind); changed(); });
  app.party.listeners.add(syncKnocks);
  window.setInterval(syncKnocks, 1500); // (a knock can also clear without a party change event)
  window.addEventListener('resize', () => { if (isOpen) place(); });
  onLayoutMode((classic) => { if (classic) closeTray(); placeNotices(); paintBell(); });
  paintBell();
  return bell;
}

const CSS = `
.ntf-bell { position: relative; }
.ntf-bell.on { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line2)); background: var(--accent-soft); }
.ntf-badge { position: absolute; top: -5px; right: -6px; min-width: 17px; height: 17px; padding: 0 4px; border-radius: 99px; background: var(--err); color: #fff; font: 700 10.5px/17px var(--font-ui, system-ui, sans-serif); text-align: center; box-shadow: 0 0 0 2px var(--bg2); pointer-events: none; }
.ntf-badge[hidden] { display: none; }
.ntf-bell.urgent::after { content: ''; position: absolute; inset: -3px; border-radius: 12px; border: 2px solid var(--warn); animation: ntf-pulse 1.6s ease-out infinite; pointer-events: none; }
@keyframes ntf-pulse { from { opacity: .9; transform: scale(.94); } to { opacity: 0; transform: scale(1.18); } }
.ntf-panel { position: fixed; z-index: 9060; width: min(400px, calc(100vw - 16px)); max-height: calc(100vh - 90px); display: flex; flex-direction: column; background: var(--panel); color: var(--text);
  border: 1px solid var(--line2); border-radius: 16px; box-shadow: 0 30px 80px -24px #000d; overflow: hidden; }
.ntf-panel.ux-sheet { overflow: hidden; }
.ntf-scroll { min-height: 0; }
.ntf-panel[hidden], body.clean .ntf-panel { display: none; } /* (H = clean window capture: never over the avatar) */
.ntf-head { display: flex; align-items: center; gap: 9px; padding: 11px 10px 11px 14px; border-bottom: 1px solid var(--line); }
.ntf-head b { font-size: 14.5px; }
.ntf-head .ic { width: 26px; height: 26px; border-radius: 8px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); }
.ntf-head .sp { flex: 1; }
.ntf-head .x { width: 36px; height: 36px; border-radius: 9px; border: 0; background: transparent; color: var(--dim); cursor: pointer; display: grid; place-items: center; }
.ntf-head .x:hover { color: var(--text); background: var(--card2); }
.ntf-panel.ux-sheet .ntf-head .x { width: 44px; height: 44px; }
.ntf-scroll { overflow-y: auto; overscroll-behavior: contain; padding: 4px 12px 12px; }
.ntf-sec { padding-top: 8px; }
.ntf-sec[hidden] { display: none; }
.ntf-sec h4 { margin: 4px 2px 6px; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); }
.ntf-sub { display: flex; align-items: center; justify-content: space-between; }
.ntf-link { border: 0; background: none; color: var(--dim); font: inherit; font-size: 12px; cursor: pointer; padding: 2px 6px; border-radius: 6px; }
.ntf-link:hover { color: var(--text); background: var(--card2); }
.ntf-notices > .vw-hbar, .ntf-notices > .vw-strip { margin: 0 0 8px; }
.ntf-notices > .vw-strip.inline { flex-wrap: wrap; }
/* (the tray is narrower than the header: the notice's text gets its own line, its buttons go under it) */
.ntf-notices > .vw-hbar { flex-wrap: wrap; row-gap: 8px; }
.ntf-notices > .vw-hbar .t { flex: 1 1 calc(100% - 24px); }
.ntf-notices > .vw-hbar .x { margin-left: auto; }
.ntf-knock { display: grid; grid-template-columns: auto 1fr auto auto; gap: 8px; align-items: center; padding: 8px 8px 8px 10px; margin-bottom: 6px; border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent); background: var(--warn-soft); }
.ntf-knock .ic { color: var(--warn); display: grid; }
.ntf-knock .who { min-width: 0; font-size: 13px; }
.ntf-knock .tag { margin-left: 6px; font: 700 9.5px/1 ui-monospace, monospace; letter-spacing: .08em; padding: 3px 5px; border-radius: 6px; border: 1px solid var(--line2); color: var(--dim); }
.ntf-knock .btn { min-height: 28px; padding: 4px 10px; font-size: 12.5px; }
.ntf-log { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.ntf-item { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; align-items: baseline; padding: 7px 8px; border-radius: 10px; font-size: 13px; line-height: 1.4; }
.ntf-item:hover { background: var(--card2); }
.ntf-item .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent2); align-self: center; grid-row: 1 / span 2; }
.ntf-item.k-ok .dot { background: var(--ok); } .ntf-item.k-warn .dot { background: var(--warn); } .ntf-item.k-err .dot { background: var(--err); }
.ntf-item .m { overflow-wrap: anywhere; }
.ntf-item .t { grid-column: 2; color: var(--faint); font-size: 11.5px; }
.ntf-empty { margin: 14px 4px 6px; color: var(--dim); font-size: 13px; line-height: 1.5; }
.ntf-empty[hidden] { display: none; }
@media (prefers-reduced-motion: reduce) { .ntf-bell.urgent::after { animation: none; opacity: .8; } }
`;
