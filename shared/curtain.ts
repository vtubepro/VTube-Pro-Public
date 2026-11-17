// Room-change transitions ("curtains", src/scene/transition/*): a full-frame animated card that covers every OBS page
// BEFORE the old room is torn down, stays up while the new room loads (GLB, textures, engine assets, shader compile,
// first frames), then animates away — automatically once the room is ready, or when the host confirms (hold mode).
//
// HOST-owned, part of SceneState (`state.curtain`, missing = the defaults below), so every OBS page of the host and of
// every party guest plays the same style and reveals on the same confirm. Not to be confused with `state.transition`
// (the camera move duration). Timing never depends on wall clocks: `seq` counts the host's room changes and a confirm
// is `confirm = seq`, so guests need no clock offset.

export interface SceneCurtainState {
  /** Style id (src/scene/transition/styles*.ts registry), 'cut' = no transition (the old behaviour), 'shuffle' = a
   *  different style each change (picked from `seq`, so every page plays the same one). Unknown ids fall back to
   *  'vtp-dark' on the page. */
  style: string;
  /** Base duration of the cover-in animation, seconds (the reveal takes ~1.15 ×). */
  dur: number;
  /** Stay up after the room is ready until the host confirms (Scene tab → Transitions → Confirm, Shift+Enter,
   *  bus command scene {curtain:{confirm:true}}, POST /api/scene/curtain). */
  hold: boolean;
  /** Minimum time fully covered (s) so the card never just flashes. */
  minHold: number;
  /** Bumped when the host picks the room that is already set ("Pick it again" after a room did not load): the state
   *  changes, so it is saved and sent like any change, and a page whose room failed loads it again. */
  retry?: number;
  /** Cover while an OBS page (re)loads with a room, too (OBS "refresh when the scene becomes active"). */
  boot: boolean;
  /** Bumps on every room change the host makes. */
  seq: number;
  /** = seq when the host confirmed that change (hold mode). */
  confirm: number;
  /** Styles 'shuffle' picks from (empty = all of the streamer's own themed styles + both VTube Pro ones). */
  pool?: string[];
  /** Rooms may bring their own transition (scene.json `curtain: {in, out}`; missing = true). false = always `style`. */
  rooms?: boolean;
  /** The room style the HOST resolved for change `seq` (roomCurtainPick below; stamped by the controller when it bumps
   *  `seq`). Pages play it for that change only, so every OBS page and party guest plays the same style. `side`:
   *  'in' = the destination's curtain.in, 'out' = the left room's curtain.out ("UNDOCKING…"). */
  room?: RoomCurtainStamp;
}

export interface RoomCurtainStamp { seq: number; style: string; side: 'in' | 'out'; from?: string }

export const DEFAULT_CURTAIN: SceneCurtainState = { style: 'vtp-dark', dur: 0.6, hold: false, minHold: 0.9, boot: true, seq: 0, confirm: 0 };

const STYLE = /^[a-z][a-z0-9-]{0,31}$/;
export const isCurtainStyle = (v: unknown): v is string => typeof v === 'string' && STYLE.test(v);
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** The curtain state after the host picks room `id` while `cur` is set: a new room = a new change (`seq`, every page
 *  covers it); the same room again = a retry token (pages whose room failed load it again; a loaded room is left be). */
export function curtainForPick(c: SceneCurtainState | undefined, cur: string | null, id: string | null): SceneCurtainState {
  const b = c ?? { ...DEFAULT_CURTAIN };
  if (cur !== id) return { ...b, seq: b.seq + 1 };
  return id ? { ...b, retry: (b.retry ?? 0) + 1 } : b;
}

/** What the room picker sends when the host picks a card / an area chip: the room (or area) already on screen picked
 *  again = that CURRENT id (a retry - never a switch to the card's default area, which would tear the area down on every
 *  page); anything else = the picked id. `card` = the card of the current id (a room with areas: its base room). */
export function roomPickId(picked: string | null, cur: string | null, card: string | null, atTable = false): { id: string | null; retry: boolean } {
  if (picked === cur || (!!picked && picked === card && !atTable)) return { id: cur, retry: true };
  return { id: picked, retry: false };
}

export function sanitizeCurtainState(o: unknown): SceneCurtainState {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const d = DEFAULT_CURTAIN;
  const pool = Array.isArray(x.pool) ? x.pool.filter(isCurtainStyle).slice(0, 24) : undefined;
  return {
    style: isCurtainStyle(x.style) ? x.style : d.style,
    dur: num(x.dur, 0.25, 2, d.dur),
    hold: x.hold === true,
    minHold: num(x.minHold, 0, 10, d.minHold),
    boot: typeof x.boot === 'boolean' ? x.boot : d.boot,
    seq: Math.round(num(x.seq, 0, 1e12, 0)),
    confirm: Math.round(num(x.confirm, 0, 1e12, 0)),
    ...(typeof x.retry === 'number' && x.retry > 0 ? { retry: Math.round(num(x.retry, 0, 1e12, 0)) } : {}),
    ...(pool && pool.length ? { pool } : {}),
    ...(x.rooms === false ? { rooms: false } : {}),
    ...(sanitizeRoomStamp(x.room) ? { room: sanitizeRoomStamp(x.room)! } : {}),
  };
}

const ROOM_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
function sanitizeRoomStamp(v: unknown): RoomCurtainStamp | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (!isCurtainStyle(r.style) || (r.side !== 'in' && r.side !== 'out')) return null;
  const seq = Math.round(num(r.seq, 0, 1e12, -1));
  if (seq < 0) return null;
  return { seq, style: r.style, side: r.side, ...(typeof r.from === 'string' && ROOM_ID.test(r.from) ? { from: r.from } : {}) };
}

// ---------------------------------------------------------------- per-room transitions (scene.json `curtain`)
/** scene.json `curtain`: `{ "in": "<style>", "out": "<style>" }` (or one string = both). `in` plays when the party
 *  arrives in this room, `out` when it leaves it for another room. */
export function roomCurtainOf(info: unknown): { in: string | null; out: string | null } {
  const c = info && typeof info === 'object' ? (info as Record<string, unknown>).curtain : undefined;
  if (isCurtainStyle(c)) return { in: c, out: c };
  if (!c || typeof c !== 'object') return { in: null, out: null };
  const o = c as Record<string, unknown>;
  return { in: isCurtainStyle(o.in) ? o.in : null, out: isCurtainStyle(o.out) ? o.out : null };
}

/** The style a room change A → B plays by the rooms' own defaults: B's curtain.in, else A's curtain.out, else null (the
 *  host's style). `from` / `to` = the rooms' scene.json (null = Classic). */
export function roomCurtainPick(from: unknown, to: unknown): { style: string; side: 'in' | 'out' } | null {
  const b = roomCurtainOf(to).in;
  if (b) return { style: b, side: 'in' };
  const a = roomCurtainOf(from).out;
  if (a) return { style: a, side: 'out' };
  return null;
}

/** Host side, when a room change bumps `seq`: stamp (or clear) the room style for it. The host's own choice wins when it
 *  is 'cut' (no transitions at all), when room styles are off (`rooms: false`), or for a change that named a style
 *  itself (`explicit`: a bus / MCP / Stream Deck command with both a style and a room). Otherwise the rooms' style
 *  replaces the host's pick (also 'shuffle') for that one change. */
export function stampRoomCurtain(c: SceneCurtainState, from: unknown, to: unknown, fromId: string | null, explicit = false): SceneCurtainState {
  const { room: _old, ...rest } = c;
  void _old;
  if (c.style === 'cut' || c.rooms === false || explicit) return rest;
  const pick = roomCurtainPick(from, to);
  if (!pick) return rest;
  return { ...rest, room: { seq: c.seq, style: pick.style, side: pick.side, ...(fromId && ROOM_ID.test(fromId) ? { from: fromId } : {}) } };
}

/** The style id a page plays for change `seq` (pages: src/scene/transition/styles.ts resolveCurtainStyle): the
 *  host's room stamp for exactly that change, else the host's style. */
export function curtainStyleId(st: SceneCurtainState, seq: number): string {
  if (st.style === 'cut') return 'cut';
  const r = st.room;
  if (r && r.seq === seq && st.rooms !== false) return r.style;
  return st.style;
}

/** What an OBS page reports on the bus while a transition runs ({type:'curtain'}), for the studio's status line. */
export interface CurtainStatus {
  /** Bus id of the reporting page. */
  page: string;
  /** 'covering' → 'loading' → 'warming' → 'ready' (waiting for the confirm in hold mode) → 'revealing' → 'idle';
   *  'failed': the room did not load (why: 'failed' an error, 'stalled' no progress for a minute) - the cover stays up
   *  with a line saying so until the host picks a room (the same one again retries it). */
  phase: 'idle' | 'covering' | 'loading' | 'warming' | 'ready' | 'revealing' | 'failed';
  /** The host's change this page is covering (SceneCurtainState.seq), -1 = a page (re)load / local test. */
  seq: number;
  room: string | null;
  style: string;
  /** Milliseconds: cover start → room loaded, → ready (warm frames), → fully revealed (filled in as they happen). */
  loadMs?: number;
  readyMs?: number;
  totalMs?: number;
  /** Why it revealed: 'ready', 'confirmed', 'timeout', 'failed', 'cancelled'. */
  why?: string;
}
