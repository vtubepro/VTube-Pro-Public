// UX redesign (owner 2026-10-04: "Implement"): the pure parts of the new studio layout, shared by the studio
// (src/ui/layoutMode.ts, src/ui/shell.ts, src/ui/notifyTray.ts) and the unit test (tools/ux_redesign_unit.ts).
//   * Classic layout: one Settings switch (localStorage 'vtp.ui.classic' = '1') brings back the beta.9 arrangement
//     exactly: the same rail without group labels, notices in the area header, no notification bell, no tools menu,
//     cards that don't fold and the six Home lamps. Nothing is ever removed in the new layout either: it only adds
//     group labels, a bell, a tools menu, folding cards and three Home tiles.
//   * the rail plan: the same buttons in the same order, with small group labels in the new layout;
//   * the notification log: toasts + standing notices + guest knocks in one list, with an unread count.
// No DOM here.

export const CLASSIC_KEY = 'vtp.ui.classic';
/** The stored value -> classic layout on? (anything but '1' = the new layout) */
export const parseClassic = (v: string | null | undefined): boolean => v === '1';

// ---------------------------------------------------------------- the rail
export type RailItem =
  | { kind: 'area'; id: string }
  | { kind: 'group'; label: string }
  | { kind: 'guides' }
  | { kind: 'spacer' };

/** The new layout's groups (the rail keeps beta.9's order; a group label goes above each group's first button). */
export const RAIL_GROUPS: { label: string; ids: string[] }[] = [
  { label: '', ids: ['home', 'onair'] },
  { label: 'You', ids: ['me', 'live'] },
  { label: 'Stream', ids: ['room', 'show', 'chat', 'games', 'friends'] },
  { label: 'Set up', ids: ['stream', 'create'] },
];

/**
 * What the rail shows, top to bottom. Classic = beta.9 exactly: every area in order, and a spacer + Guides
 * right before Settings. New layout: the same order with a label above each group.
 * Areas no group names (added by later work) stay in their place, inside the group before them.
 */
export function railPlan(areaIds: readonly string[], classic: boolean): RailItem[] {
  const out: RailItem[] = [];
  if (classic) {
    for (const id of areaIds) {
      if (id === 'settings') out.push({ kind: 'spacer' }, { kind: 'guides' });
      out.push({ kind: 'area', id });
    }
    return out;
  }
  const groupOf = new Map<string, number>();
  RAIL_GROUPS.forEach((g, i) => { for (const id of g.ids) groupOf.set(id, i); });
  let cur = -1;
  for (const id of areaIds) {
    if (id === 'settings') {
      out.push({ kind: 'spacer' }, { kind: 'guides' }, { kind: 'area', id });
      continue;
    }
    const g = groupOf.get(id);
    if (g !== undefined && g > cur) {
      cur = g;
      if (RAIL_GROUPS[g].label) out.push({ kind: 'group', label: RAIL_GROUPS[g].label });
    }
    out.push({ kind: 'area', id });
  }
  // (no Settings area: Guides still gets its place)
  if (!areaIds.includes('settings')) out.push({ kind: 'spacer' }, { kind: 'guides' });
  return out;
}

// ---------------------------------------------------------------- the notification log
export type NoteKind = 'info' | 'ok' | 'warn' | 'err';
export interface LogEntry { id: number; msg: string; kind: NoteKind; at: number; n: number; read: boolean }

/** Errors and warnings wait for you (unread); info / ok toasts were seen when they popped up (logged as read). */
export const countsUnread = (kind: NoteKind): boolean => kind === 'warn' || kind === 'err';

/**
 * The tray's history of toasts: newest first, at most `max`, the same message within `dedupeMs` folds into one entry
 * ("x3"). Pure: no timers, no storage (nothing is kept after the tab closes).
 */
export class NoteLog {
  entries: LogEntry[] = [];
  private seq = 0;
  constructor(readonly max = 40, readonly dedupeMs = 4000) {}
  add(msg: string, kind: NoteKind, now = Date.now()): LogEntry | null {
    const m = String(msg ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!m) return null;
    const top = this.entries[0];
    if (top && top.msg === m && top.kind === kind && now - top.at <= this.dedupeMs) {
      top.n++; top.at = now;
      if (countsUnread(kind)) top.read = false;
      return top;
    }
    const e: LogEntry = { id: ++this.seq, msg: m, kind, at: now, n: 1, read: !countsUnread(kind) };
    this.entries.unshift(e);
    if (this.entries.length > this.max) this.entries.length = this.max;
    return e;
  }
  unread(): number { return this.entries.filter((e) => !e.read).length; }
  markRead() { for (const e of this.entries) e.read = true; }
  clear() { this.entries = []; }
}

/** A standing notice's signature: '' while it shows nothing (hidden / empty), else its text (a new text = new news). */
export function noticeSig(hidden: boolean, text: string | null | undefined): string {
  if (hidden) return '';
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** The bell's number: unread toasts + notices showing something not seen yet + guests knocking not seen yet. */
export function unreadCount(o: { log: number; notices: number; knocks: number }): number {
  return Math.max(0, o.log) + Math.max(0, o.notices) + Math.max(0, o.knocks);
}
/** What the badge says ('' = no badge). */
export const badgeText = (n: number): string => (n <= 0 ? '' : n > 9 ? '9+' : String(n));

/** "just now" / "4 min ago" / "2 h ago" for the tray list. */
export function agoText(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

// ---------------------------------------------------------------- beta.16 shell fixes (UX redesign v2, lane L1)
// Pure sizing rules for the docked drawer, the menus and the top bar's compact tiers. No DOM here.

/** A docked tool drawer (Chat Hub, Stream Deck & controllers, AI connectors) never leaves #app narrower than this on a
 *  window of at least DRAWER_WIDE px (cr-02). */
export const DRAWER_MIN_APP = 1100;
export const DRAWER_WIDE = 1500;
/** On windows of this width or less the drawer is a full-width sheet with a back arrow and the title; #app is not shrunk. */
export const DRAWER_SHEET_MAX = 700;
/** Below beta.12's ~960 px floor the studio gets cramped: windows between 700 and DRAWER_WIDE keep that older rule. */
export const DRAWER_MIN_APP_OLD = 960;

/**
 * The drawer's width in px (0 = a full-width sheet, #app is not shrunk).
 * `want` = the tool's remembered or default width, `min` = the tool's own minimum. Windows of DRAWER_WIDE or more keep
 * #app at DRAWER_MIN_APP at least (the tool's minimum gives way); smaller windows keep beta.12's rule (#app >= 960).
 */
export function drawerWidth(inner: number, want: number, min: number): number {
  if (inner <= DRAWER_SHEET_MAX) return 0;
  const old = Math.round(Math.max(Math.min(min, inner * 0.6), Math.min(want, inner - DRAWER_MIN_APP_OLD, inner * 0.72)));
  return inner >= DRAWER_WIDE ? Math.max(0, Math.min(old, inner - DRAWER_MIN_APP)) : old;
}

/** Windows of this width or less open the Tools, Help and bell menus as a bottom sheet with a Close button (cr-01). */
export const SHEET_MAX = 600;

export interface MenuBox { sheet: boolean; top: number; right: number; maxHeight: number }
/**
 * Where a top-bar menu goes. Its max height is `innerHeight - top - 8` and it scrolls inside; it never starts left of 8 px;
 * at SHEET_MAX or less it is a bottom sheet (top / right are not used then).
 */
export function menuBox(o: { vw: number; vh: number; anchorBottom: number; anchorRight: number; width: number }): MenuBox {
  const { vw, vh } = o;
  if (vw <= SHEET_MAX) return { sheet: true, top: 0, right: 0, maxHeight: Math.max(200, Math.round(Math.min(vh * 0.86, vh - 48))) };
  const w = Math.min(o.width, vw - 16);
  const top = Math.max(0, Math.round(o.anchorBottom + 8));
  const right = Math.min(Math.max(8, Math.round(vw - o.anchorRight)), Math.max(8, vw - w - 8));
  return { sheet: false, top, right, maxHeight: Math.max(160, Math.round(vh - top - 8)) };
}

/** The top bar's compact tiers, from the width of #app (not the window), before any measuring: 0 = full, 1 = lamps become
 *  dots (below 1100 px). The shell raises the tier when the bar still overflows (src/ui/topbarMore.ts). */
export const TOPBAR_DOTS_BELOW = 1100;
export const topbarTier = (appWidth: number): 0 | 1 => (appWidth < TOPBAR_DOTS_BELOW ? 1 : 0);

/** A lamp's accessible name: always carries the lamp's own word ("Camera off", "Mic: on", "Room: Kingsmarch"). */
export function lampLabel(word: 'Camera' | 'Mic' | 'OBS' | 'Room', text: string): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.includes(word) ? t : t ? `${word}: ${t}` : word;
}
