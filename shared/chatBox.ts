// The docked chat box's place on the stream (owner: "People need to be able to choose the chatbox location and size").
// Part of the host's stage settings (SceneState.stage.chatBox, shared/stage.ts), so it is saved by the helper with the
// rest of the scene and every OBS page (the host's and every party guest's) draws the same box.
//
//   at  'auto'   the automatic place (free space beside the performers; the layout's own column in React / Gaming)
//       corners  'tl' | 'tr' | 'bl' | 'br'   ·  edges 'left' | 'right' (vertically centred) | 'top' | 'bottom' (centred)
//       'custom' x / y as dragged in the Chat box preview
//   w, h       size as fractions of the output frame (the box keeps them in every mode)
//   opacity    0.3 … 1 for the whole box
//   style      absent = the chat panel (its card art) · 'text' = plain outlined chat text, no panel (layouts lane:
//              src/scene/stage/chatText.ts; its options live in the `hud` mode bag, shared/hud.ts chatText). A layout's
//              look can force either style for that layout (shared/layoutLook.ts `chat`).
//   per        chatfx (owner: "Add an option to choose where I want the chat to be"): places kept for ONE room ('<room>')
//              or one room in one show mode ('<room>|<mode>'), over the place above (= "Every room"). The most specific
//              one that exists wins: room + mode > room > every room (resolveChatBox).
// Precedence on the stream (src/scene/stage/compositor.ts, chatDockChoice): a room / room + mode place of this box >
// the Show → Layout editor's old per-preset chat rect (shared/stageLayout.ts slot.chat, kept for layouts saved before
// this) > the every-room place > automatic. The Layout editor now writes its chat drags HERE (room + mode), so there is
// one place for the chat, and the Chat panel says which one is in use.
import type { Rect } from './stage.ts';
import { roomKey } from './stageLayout.ts';

export const CHAT_BOX_PLACES = ['auto', 'tl', 'tr', 'bl', 'br', 'left', 'right', 'top', 'bottom', 'custom'] as const;
export type ChatBoxAt = typeof CHAT_BOX_PLACES[number];

/** One place (no per-room places inside). */
export interface ChatBoxCore { at: ChatBoxAt; w: number; h: number; x: number; y: number; opacity: number; style?: 'text' }
export interface ChatBoxPlace extends ChatBoxCore { per?: Record<string, ChatBoxCore> }

export const DEFAULT_CHAT_BOX: ChatBoxPlace = { at: 'auto', w: 0.22, h: 0.5, x: 0.76, y: 0.25, opacity: 1 };
/** Sizes offered as buttons: a tall box for corners / sides, a wide band for top / bottom. */
export const CHAT_BOX_SIZES = {
  s: { tall: { w: 0.17, h: 0.36 }, wide: { w: 0.4, h: 0.17 } },
  m: { tall: { w: 0.22, h: 0.5 }, wide: { w: 0.5, h: 0.22 } },
  l: { tall: { w: 0.28, h: 0.7 }, wide: { w: 0.64, h: 0.28 } },
} as const;
export type ChatBoxSize = keyof typeof CHAT_BOX_SIZES;
export const CHAT_BOX_LIMITS = { w: [0.08, 0.9], h: [0.08, 0.95], opacity: [0.3, 1] } as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d);
const r4 = (v: number) => Math.round(v * 10000) / 10000;

export function sanitizeChatBox(o: unknown): ChatBoxPlace {
  const core = sanitizeCore(o);
  const per = (o && typeof o === 'object' ? (o as Record<string, unknown>).per : null);
  if (!per || typeof per !== 'object') return core;
  const out: Record<string, ChatBoxCore> = {};
  for (const [k, v] of Object.entries(per as Record<string, unknown>).slice(-MAX_PER)) if (SCOPE_KEY.test(k) && v && typeof v === 'object') out[k] = sanitizeCore(v);
  return Object.keys(out).length ? { ...core, per: out } : core;
}
function sanitizeCore(o: unknown): ChatBoxCore {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const d = DEFAULT_CHAT_BOX;
  const at = (CHAT_BOX_PLACES as readonly string[]).includes(x.at as string) ? x.at as ChatBoxAt : d.at;
  const w = r4(num(x.w, CHAT_BOX_LIMITS.w[0], CHAT_BOX_LIMITS.w[1], d.w)), h = r4(num(x.h, CHAT_BOX_LIMITS.h[0], CHAT_BOX_LIMITS.h[1], d.h));
  return { at, w, h, x: r4(num(x.x, 0, 1 - w, Math.min(d.x, 1 - w))), y: r4(num(x.y, 0, 1 - h, Math.min(d.y, 1 - h))), opacity: Math.round(num(x.opacity, CHAT_BOX_LIMITS.opacity[0], CHAT_BOX_LIMITS.opacity[1], d.opacity) * 100) / 100, ...(x.style === 'text' ? { style: 'text' as const } : {}) };
}

/** Is the box placed by hand (anything but 'auto')? */
export const chatBoxFixed = (p: ChatBoxPlace | undefined | null): p is ChatBoxPlace => !!p && p.at !== 'auto';

/** The box's rect in the frame (fractions, top-left origin) for a frame of `aspect` (w / h); null = 'auto'.
 *  The margin is 20 px of a 1080-high frame (the stage layouts' margin), the same in every aspect. */
export function chatBoxRect(p: ChatBoxPlace | undefined | null, aspect = 16 / 9): Rect | null {
  if (!chatBoxFixed(p)) return null;
  const my = 20 / 1080, mx = my / Math.max(0.25, aspect);
  const w = clamp(p.w, 0.02, 1 - 2 * mx), h = clamp(p.h, 0.02, 1 - 2 * my);
  const L = mx, R = 1 - mx - w, T = my, B = 1 - my - h, CX = (1 - w) / 2, CY = (1 - h) / 2;
  switch (p.at) {
    case 'tl': return { x: L, y: T, w, h };
    case 'tr': return { x: R, y: T, w, h };
    case 'bl': return { x: L, y: B, w, h };
    case 'br': return { x: R, y: B, w, h };
    case 'left': return { x: L, y: CY, w, h };
    case 'right': return { x: R, y: CY, w, h };
    case 'top': return { x: CX, y: T, w, h };
    case 'bottom': return { x: CX, y: B, w, h };
    default: return { x: clamp(p.x, 0, 1 - w), y: clamp(p.y, 0, 1 - h), w, h };
  }
}

/** A preset place with the matching size shape (top / bottom = a wide band, everything else = a tall box). */
export function chatBoxPreset(cur: ChatBoxPlace, at: ChatBoxAt, size?: ChatBoxSize): ChatBoxPlace {
  const wide = at === 'top' || at === 'bottom';
  const wasWide = cur.w / Math.max(0.01, cur.h) > 1.6;
  const sz = size ?? sizeOfBox(cur);
  const dims = wide !== wasWide || size ? CHAT_BOX_SIZES[sz][wide ? 'wide' : 'tall'] : { w: cur.w, h: cur.h };
  const next = sanitizeChatBox({ ...cur, at, ...dims });
  // 'custom' starts where the box is now (so switching to free placement never jumps)
  if (at === 'custom') { const r = chatBoxRect({ ...cur, at: cur.at === 'auto' ? 'right' : cur.at }) ?? { x: cur.x, y: cur.y }; return sanitizeChatBox({ ...next, x: r.x, y: r.y }); }
  return next;
}
/** The size button closest to the box's size. */
export function sizeOfBox(p: ChatBoxPlace): ChatBoxSize {
  const wide = p.w / Math.max(0.01, p.h) > 1.6;
  let best: ChatBoxSize = 'm', d = Infinity;
  for (const k of Object.keys(CHAT_BOX_SIZES) as ChatBoxSize[]) {
    const z = CHAT_BOX_SIZES[k][wide ? 'wide' : 'tall'];
    const e = Math.abs(z.w - p.w) + Math.abs(z.h - p.h);
    if (e < d) { d = e; best = k; }
  }
  return best;
}

// ---------------------------------------------------------------- per room / per mode (chatfx)
export type ChatScope = 'all' | 'room' | 'mode';
export const MAX_PER = 60;
const SCOPE_KEY = /^[A-Za-z0-9_@:.-]{1,48}(\|[a-z][a-z0-9-]{1,23})?$/;
/** A room's key for the chat box: the room without its area (a room's bar and its stage share one place). */
export const chatRoomKey = (roomId: string | null | undefined) => roomKey((roomId || '').split('~')[0] || null);
/** The key of a scope ('all' = none: the box's own fields). */
export function chatScopeKey(scope: ChatScope, roomId: string | null | undefined, mode: string): string | null {
  if (scope === 'all' || !roomId) return null;
  return scope === 'room' ? chatRoomKey(roomId) : `${chatRoomKey(roomId)}|${mode}`;
}
const coreOf = (p: ChatBoxPlace | ChatBoxCore): ChatBoxCore => { const { per: _p, ...c } = p as ChatBoxPlace; void _p; return c; };
/** The place for this room + mode, and which scope it comes from. */
export function resolveChatBox(p: ChatBoxPlace | null | undefined, roomId: string | null | undefined, mode: string): { place: ChatBoxCore; scope: ChatScope } {
  const box = p ?? DEFAULT_CHAT_BOX;
  const per = box.per;
  if (per && roomId) {
    const m = per[chatScopeKey('mode', roomId, mode)!];
    if (m) return { place: m, scope: 'mode' };
    const r = per[chatScopeKey('room', roomId, mode)!];
    if (r) return { place: r, scope: 'room' };
  }
  return { place: coreOf(box), scope: 'all' };
}
/** Is there a place kept for this exact scope? */
export function hasChatScope(p: ChatBoxPlace | null | undefined, scope: ChatScope, roomId: string | null | undefined, mode: string): boolean {
  if (scope === 'all') return true;
  const k = chatScopeKey(scope, roomId, mode);
  return !!k && !!p?.per?.[k];
}
/** Store `core` for a scope (the others are kept). */
export function setChatScope(p: ChatBoxPlace | null | undefined, scope: ChatScope, roomId: string | null | undefined, mode: string, core: ChatBoxCore): ChatBoxPlace {
  const box = sanitizeChatBox(p ?? DEFAULT_CHAT_BOX);
  const c = sanitizeCore(core);
  const k = chatScopeKey(scope, roomId, mode);
  if (!k) return box.per ? { ...c, per: box.per } : c;
  const per = { ...(box.per ?? {}) };
  delete per[k];
  per[k] = c;                                               // (newest last: the oldest go first past MAX_PER)
  const keys = Object.keys(per);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_PER))) delete per[old];
  return { ...coreOf(box), per };
}
/** Forget the place kept for a scope (that room / mode follows the broader one again). */
export function dropChatScope(p: ChatBoxPlace | null | undefined, scope: ChatScope, roomId: string | null | undefined, mode: string): ChatBoxPlace {
  const box = sanitizeChatBox(p ?? DEFAULT_CHAT_BOX);
  const k = chatScopeKey(scope, roomId, mode);
  if (!k || !box.per?.[k]) return box;
  const per = { ...box.per };
  delete per[k];
  return Object.keys(per).length ? { ...coreOf(box), per } : coreOf(box);
}
/** "Use this place everywhere": `core` for every room and mode (every per-room place is forgotten). */
export const useChatEverywhere = (core: ChatBoxCore): ChatBoxPlace => sanitizeCore(core);
/** How many rooms / modes keep their own place. */
export const chatScopeCount = (p: ChatBoxPlace | null | undefined) => Object.keys(p?.per ?? {}).length;

/** The place a scope EDITS (the Chat panel; picking a scope writes nothing): its own place; else the one it inherits
 *  (this room's for a mode, else every room's). When the stream shows the Layout editor's rect right now (`layoutRect`)
 *  and this room / mode would take over from it, that rect as a Free place: the first edit then never moves the chat. */
export function scopeEditPlace(p: ChatBoxPlace | null | undefined, scope: ChatScope, roomId: string | null | undefined, mode: string, layoutRect: Rect | null = null): ChatBoxCore {
  const box = sanitizeChatBox(p ?? DEFAULT_CHAT_BOX);
  const k = chatScopeKey(scope, roomId, mode);
  if (k && box.per?.[k]) return box.per[k];
  if (scope === 'mode') { const rk = chatScopeKey('room', roomId, mode); if (rk && box.per?.[rk]) return box.per[rk]; }
  const core = coreOf(box);
  if (layoutRect && k) return sanitizeCore({ ...core, at: 'custom', x: layoutRect.x, y: layoutRect.y, w: layoutRect.w, h: layoutRect.h });
  return core;
}

/** Which chat place the stream uses (pure; src/scene/stage/compositor.ts + the Chat panel's "in use" line):
 *  'box'    the chat box place (a fixed rect: `rect`), from `scope`
 *  'layout' the Layout editor's old per-preset chat rect (slot.chat), only under an every-room box
 *  'auto'   the automatic place */
export function chatDockChoice(p: ChatBoxPlace | null | undefined, roomId: string | null | undefined, mode: string, slotChat: boolean, aspect = 16 / 9):
  { use: 'box' | 'layout' | 'auto'; scope: ChatScope; place: ChatBoxCore; rect: Rect | null } {
  const { place, scope } = resolveChatBox(p, roomId, mode);
  const rect = chatBoxRect(place, aspect);
  if (scope !== 'all') return { use: rect ? 'box' : 'auto', scope, place, rect };
  if (slotChat) return { use: 'layout', scope, place, rect: null };
  return { use: rect ? 'box' : 'auto', scope, place, rect };
}

/** "Where does the chat show?" (src/ui/chatWhere.ts): what the stream shows, from the chat monitor switch and the box's
 *  Show setting. 'both' = the room's chat screen, and the box whenever that screen isn't in the shot. */
export type ChatWhere = 'screen' | 'room' | 'both' | 'hidden';
export function chatWhereOf(monitor: boolean, dock: 'auto' | 'always' | 'off', hasRoom: boolean): ChatWhere {
  const box = dock !== 'off', world = monitor && hasRoom;
  return box && world ? 'both' : world ? 'room' : box ? 'screen' : 'hidden';
}
