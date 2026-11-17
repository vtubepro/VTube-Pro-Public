// TTRPG table state that every page renders (SceneState.ttrpg): host-owned, broadcast to this PC's OBS pages (bus) and
// to party guests (party wire), sanitised on arrival like the rest of SceneState. Only what the 3D table needs lives
// here (map, tokens, initiative, dice stamps, the current spoken line, mood, handout, camera wishes). The full game
// (character sheets, the log, the campaign, the AI GM's config) stays in the host studio / host server
// (src/ttrpg/studio, server/ttrpg) and reaches guests' TTRPG panels over the party's `ttrpg` channel.
// No secrets ever: the bridge pairing token never enters this object (server/ttrpg/config.ts keeps it).

export const TTRPG_MOODS = ['calm', 'tense', 'combat', 'mystery', 'eerie', 'triumph', 'dark'] as const;
export type TtrpgMood = (typeof TTRPG_MOODS)[number];
export const TTRPG_SHOTS = ['auto', 'wide', 'map', 'gm', 'dice', 'seat', 'handout'] as const;
export type TtrpgShot = (typeof TTRPG_SHOTS)[number];
export const GM_BUILTINS = ['d20', 'tome', 'skull', 'radio', 'orb', 'voice'] as const;
export type GmBuiltin = (typeof GM_BUILTINS)[number];
export const TOKEN_KINDS = ['pc', 'npc', 'monster', 'object'] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

/** How the GM is represented at GM_SEAT. `style`: a built-in ('d20', 'tome', 'skull', 'radio', 'orb', 'voice'),
 *  `room:<id>` (a figure / prop from the room's scene.json ttrpg.gmStyles) or `avatar:<avatarId>` (any avatar in THIS
 *  PC's library — pages that don't have it fall back to the room default, like the chat buddy). */
export interface GmLook { style: string; name: string; color: string }

export interface TtrpgToken {
  id: string;
  name: string;
  kind: TokenKind;
  /** Member key ('@host' / party id) for player tokens. */
  owner?: string;
  /** Map cell coordinates (floats allowed: a token between cells). x → east, y → south (row), 0,0 = north-west cell. */
  x: number;
  y: number;
  color: string;
  /** Short glyph on the base / standee (1–2 chars, e.g. 'G', '💀'). */
  icon?: string;
  /** [current, max] — shown as a ring on the base (optional; players may hide theirs). */
  hp?: [number, number];
  dead?: boolean;
  /** Footprint in cells (1 = medium, 2 = large …). */
  size?: number;
  /** Hidden from the audience (GM-only prep): not drawn on OBS. */
  hidden?: boolean;
}

export interface TtrpgInitEntry { id: string; name: string; init: number; tok?: string; kind: TokenKind }
export interface TtrpgInit { on: boolean; round: number; turn: number; order: TtrpgInitEntry[] }

/** One physical die in a roll: sides (4, 6, 8, 10, 12, 20, 100 = the percentile pair), value, kept (advantage etc.). */
export interface TtrpgDie { s: number; v: number; k?: boolean }
/** A dice roll every page throws the same way: the physics throw comes from `seed`, the faces are forced to `dice`. */
export interface TtrpgRoll {
  id: string;
  /** Member key, 'gm', or an NPC name. */
  who: string;
  name: string;
  label: string;
  expr: string;
  dice: TtrpgDie[];
  mod: number;
  total: number;
  /** Natural 20 / natural 1 on a single d20 check (crit juice), else null. */
  crit: 'hi' | 'lo' | null;
  /** When the throw starts (epoch ms, on the receiving page's clock — guests convert the host clock). */
  at: number;
  seed: number;
  /** Target number for the check (shown after the throw: success / fail), if the GM set one. */
  dc?: number;
  /** A GM's secret roll: no throw on OBS, the log says "the GM rolls behind the screen". */
  secret?: boolean;
}

/** The line being spoken right now (captions + the GM's mouth on every page). The text → viseme timeline is
 *  derived from (text, at, dur) on each page (src/ttrpg/gm/speech.ts). */
export interface TtrpgSay { id: string; who: string; name: string; text: string; at: number; dur: number; npc?: boolean }

export interface TtrpgMap {
  /** Procedural template (shared/ttrpg/maps.ts) or 'img' (an image asset the host sent) or 'room' (the room's own painted map). */
  tpl: string;
  seed: number;
  title: string;
  /** Cells across (east–west). */
  grid: number;
  /** Rows (north–south): the host decides from the room's map aspect (scene.json ttrpg.map.aspect), so every page
   *  and the host's rules agree on the grid. Missing = derived from the surface. */
  rows?: number;
  /** Image asset id when tpl === 'img' (sent over the ttrpg channel, RAM only). */
  img?: string;
  /** Fog of war off/on (revealed cells as run-length string; empty = all hidden). */
  fog?: string;
}

export interface TtrpgHandout { id: string; title: string; text?: string; img?: string; style?: 'parchment' | 'note' | 'dossier' | 'wanted' | 'screen'; at: number }

export interface SceneTtrpgState {
  on: boolean;
  /** The environment the party came from (TTRPG → back returns there). */
  from?: string;
  system: 'generic' | '5e';
  gm: { kind: 'ai' | 'human' | 'none'; who?: string; look: GmLook };
  title: string;
  map: TtrpgMap | null;
  tokens: TtrpgToken[];
  init: TtrpgInit;
  rolls: TtrpgRoll[];
  say: TtrpgSay | null;
  handout: TtrpgHandout | null;
  mood: TtrpgMood;
  /** Camera: 'auto' = the auto-director; else a pinned shot (`seat` uses `camWho`). */
  cam: TtrpgShot;
  camWho?: string;
  /** Captions + roll cards + initiative strip as a 2D overlay on the OBS output. */
  overlay: { captions: boolean; rolls: boolean; init: boolean; party: boolean };
  /** X-card tapped (epoch ms): the overlay dims the last line, the GM retcons. */
  xAt?: number;
  /** Bumps on every edit (cheap change detection on pages). */
  rev: number;
}

export const DEFAULT_GM_LOOK: GmLook = { style: 'd20', name: 'The Game Master', color: '#8fd3ff' };
export const DEFAULT_TTRPG_STATE: SceneTtrpgState = {
  on: false, system: '5e', gm: { kind: 'ai', look: { ...DEFAULT_GM_LOOK } }, title: '', map: null, tokens: [], init: { on: false, round: 1, turn: 0, order: [] },
  rolls: [], say: null, handout: null, mood: 'calm', cam: 'auto', overlay: { captions: true, rolls: true, init: true, party: false }, rev: 0,
};

// ---------------------------------------------------------------- sanitiser (host state arrives over the network)
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const int = (v: unknown, lo: number, hi: number, d: number) => Math.round(num(v, lo, hi, d));
/** Printable text only (no control chars), trimmed to `max`. */
export const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '');
const ID = /^[A-Za-z0-9_:.-]{1,40}$/;
const KEY = /^(@host|gm|[a-z0-9]{6,32}|lib:[A-Za-z0-9_-]{1,48})$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const id = (v: unknown) => (typeof v === 'string' && ID.test(v) ? v : null);
const color = (v: unknown, d: string) => (typeof v === 'string' && COLOR.test(v) ? v.toLowerCase() : d);
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (typeof v === 'string' && (list as readonly string[]).includes(v) ? v as T : d);
const STYLE = /^(d20|tome|skull|radio|orb|voice|room:[A-Za-z0-9_-]{1,40}|avatar:[A-Za-z0-9_-]{1,48})$/;
export const DIE_SIDES = [2, 3, 4, 6, 8, 10, 12, 20, 100] as const;

export function sanitizeGmLook(o: unknown): GmLook {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  return { style: typeof x.style === 'string' && STYLE.test(x.style) ? x.style : DEFAULT_GM_LOOK.style, name: clean(x.name, 40) || DEFAULT_GM_LOOK.name, color: color(x.color, DEFAULT_GM_LOOK.color) };
}

export function sanitizeToken(o: unknown): TtrpgToken | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  const tid = id(x.id);
  if (!tid) return null;
  const hp = Array.isArray(x.hp) && x.hp.length === 2 ? [int(x.hp[0], -999, 9999, 0), int(x.hp[1], 1, 9999, 1)] as [number, number] : undefined;
  return {
    id: tid, name: clean(x.name, 32) || tid, kind: oneOf(x.kind, TOKEN_KINDS, 'npc'),
    ...(typeof x.owner === 'string' && KEY.test(x.owner) ? { owner: x.owner } : {}),
    x: num(x.x, -1, 200, 0), y: num(x.y, -1, 200, 0), color: color(x.color, '#c0c0c0'),
    ...(clean(x.icon, 4) ? { icon: clean(x.icon, 4) } : {}),
    ...(hp ? { hp } : {}), ...(x.dead === true ? { dead: true } : {}),
    ...(typeof x.size === 'number' ? { size: int(x.size, 1, 4, 1) } : {}), ...(x.hidden === true ? { hidden: true } : {}),
  };
}

export function sanitizeRoll(o: unknown): TtrpgRoll | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  const rid = id(x.id);
  if (!rid || !Array.isArray(x.dice)) return null;
  const dice: TtrpgDie[] = [];
  for (const d of x.dice.slice(0, 40)) {
    if (!d || typeof d !== 'object') continue;
    const s = (d as Record<string, unknown>).s, v = (d as Record<string, unknown>).v;
    if (typeof s !== 'number' || !(DIE_SIDES as readonly number[]).includes(s) || typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > s) continue;
    dice.push({ s, v, ...((d as Record<string, unknown>).k === false ? { k: false } : {}) });
  }
  return {
    id: rid, who: typeof x.who === 'string' && x.who.length <= 40 ? clean(x.who, 40) : 'gm', name: clean(x.name, 32), label: clean(x.label, 60), expr: clean(x.expr, 40),
    dice, mod: int(x.mod, -999, 999, 0), total: int(x.total, -9999, 99999, 0), crit: x.crit === 'hi' || x.crit === 'lo' ? x.crit : null,
    at: num(x.at, 0, 1e14, 0), seed: int(x.seed, 0, 2 ** 32 - 1, 0),
    ...(typeof x.dc === 'number' ? { dc: int(x.dc, 0, 99, 10) } : {}), ...(x.secret === true ? { secret: true } : {}),
  };
}

export function sanitizeTtrpgState(o: unknown): SceneTtrpgState {
  const d = DEFAULT_TTRPG_STATE;
  if (!o || typeof o !== 'object') return structuredClone(d);
  const x = o as Record<string, unknown>;
  const g = (x.gm && typeof x.gm === 'object' ? x.gm : {}) as Record<string, unknown>;
  const m = (x.map && typeof x.map === 'object' ? x.map : null) as Record<string, unknown> | null;
  const it = (x.init && typeof x.init === 'object' ? x.init : {}) as Record<string, unknown>;
  const s = (x.say && typeof x.say === 'object' ? x.say : null) as Record<string, unknown> | null;
  const h = (x.handout && typeof x.handout === 'object' ? x.handout : null) as Record<string, unknown> | null;
  const ov = (x.overlay && typeof x.overlay === 'object' ? x.overlay : {}) as Record<string, unknown>;
  const order: TtrpgInitEntry[] = [];
  for (const e of Array.isArray(it.order) ? it.order.slice(0, 30) : []) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    const eid = id(r.id);
    if (eid) order.push({ id: eid, name: clean(r.name, 32) || eid, init: int(r.init, -20, 99, 0), kind: oneOf(r.kind, TOKEN_KINDS, 'npc'), ...(id(r.tok) ? { tok: id(r.tok)! } : {}) });
  }
  const tokens = (Array.isArray(x.tokens) ? x.tokens.slice(0, 48) : []).map(sanitizeToken).filter((t): t is TtrpgToken => !!t);
  const rolls = (Array.isArray(x.rolls) ? x.rolls.slice(-8) : []).map(sanitizeRoll).filter((r): r is TtrpgRoll => !!r);
  return {
    on: x.on === true,
    ...(typeof x.from === 'string' && /^[a-z0-9][a-z0-9_-]{0,47}(?:~[a-z0-9][a-z0-9_-]{0,23})?$/.test(x.from) ? { from: x.from } : {}),
    system: x.system === 'generic' ? 'generic' : '5e',
    gm: { kind: g.kind === 'human' || g.kind === 'none' ? g.kind : 'ai', ...(typeof g.who === 'string' && KEY.test(g.who) ? { who: g.who } : {}), look: sanitizeGmLook(g.look) },
    title: clean(x.title, 80),
    map: m ? {
      tpl: typeof m.tpl === 'string' && /^[a-z0-9_]{1,24}$/.test(m.tpl) ? m.tpl : 'dungeon', seed: int(m.seed, 0, 2 ** 31, 1), title: clean(m.title, 60), grid: int(m.grid, 4, 60, 16),
      ...(typeof m.rows === 'number' ? { rows: int(m.rows, 4, 60, 9) } : {}),
      ...(id(m.img) ? { img: id(m.img)! } : {}), ...(typeof m.fog === 'string' && /^[0-9a-z,]{0,4000}$/.test(m.fog) ? { fog: m.fog } : {}),
    } : null,
    tokens,
    init: { on: it.on === true, round: int(it.round, 1, 9999, 1), turn: int(it.turn, 0, 29, 0), order },
    rolls,
    say: s && id(s.id) ? { id: id(s.id)!, who: clean(s.who, 40) || 'gm', name: clean(s.name, 40), text: clean(s.text, 600), at: num(s.at, 0, 1e14, 0), dur: num(s.dur, 0.2, 90, 3), ...(s.npc === true ? { npc: true } : {}) } : null,
    handout: h && id(h.id) ? { id: id(h.id)!, title: clean(h.title, 60), ...(clean(h.text, 1200) ? { text: clean(h.text, 1200) } : {}), ...(id(h.img) ? { img: id(h.img)! } : {}),
      style: oneOf(h.style, ['parchment', 'note', 'dossier', 'wanted', 'screen'] as const, 'parchment'), at: num(h.at, 0, 1e14, 0) } : null,
    mood: oneOf(x.mood, TTRPG_MOODS, 'calm'),
    cam: oneOf(x.cam, TTRPG_SHOTS, 'auto'),
    ...(typeof x.camWho === 'string' && KEY.test(x.camWho) ? { camWho: x.camWho } : {}),
    overlay: { captions: ov.captions !== false, rolls: ov.rolls !== false, init: ov.init !== false, party: ov.party === true },
    ...(typeof x.xAt === 'number' && Number.isFinite(x.xAt) && x.xAt > 0 ? { xAt: num(x.xAt, 0, 1e14, 0) } : {}),
    rev: int(x.rev, 0, 1e12, 0),
  };
}

/** Guest: the host's clock → ours (every `at` in the table state). */
export function shiftTtrpgClock(t: SceneTtrpgState, off: number) {
  for (const r of t.rolls) if (r.at > 0) r.at += off;
  if (t.say && t.say.at > 0) t.say.at += off;
  if (t.handout && t.handout.at > 0) t.handout.at += off;
  if (t.xAt) t.xAt += off;
}

/** scene.json `ttrpg` block of a TTRPG room (the TTRPG room contract, S/ttrpg/CONTRACT.md → docs/TTRPG.md). */
export interface RoomGmStyle {
  id: string; name: string; kind: 'character' | 'object' | 'glow';
  /** GLB / VRM in the room folder (e.g. "gm/radio.glb"). */
  model?: string;
  /** An avatar id (builtin / library) as the GM character. */
  avatar?: string;
  /** A built-in figure with the room's colours. */
  builtin?: GmBuiltin;
  height?: number;
  mouth?: { node?: string; open?: number; morph?: string; glow?: string };
  voice?: { pitch?: number; rate?: number; hint?: string };
  persona?: string;
  color?: string;
}
export interface RoomTtrpgConfig {
  of?: string;
  theme?: string;
  seats?: number;
  persona?: string;
  gmStyles?: (RoomGmStyle | string)[];
  defaultGm?: string;
  map?: { look?: 'paper' | 'felt' | 'chalk' | 'holo' | 'crt' | 'blueprint'; ink?: string; paper?: string; accent?: string; aspect?: number; grid?: number };
  dice?: { style?: 'bone' | 'brass' | 'resin' | 'glass' | 'neon' | 'pearl' | 'plastic'; color?: string; ink?: string; size?: number };
  seeds?: string[];
}

/** The room's GM styles as objects (strings = built-ins). */
export function roomGmStyles(cfg: RoomTtrpgConfig | undefined): RoomGmStyle[] {
  const out: RoomGmStyle[] = [];
  for (const g of cfg?.gmStyles ?? []) {
    if (typeof g === 'string') { if ((GM_BUILTINS as readonly string[]).includes(g)) out.push({ id: g, name: BUILTIN_NAMES[g as GmBuiltin], kind: g === 'voice' ? 'glow' : 'object', builtin: g as GmBuiltin }); continue; }
    if (!g || typeof g !== 'object' || typeof g.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(g.id)) continue;
    out.push({ ...g, name: clean(g.name, 40) || g.id, kind: g.kind === 'character' || g.kind === 'glow' ? g.kind : 'object' });
  }
  return out;
}
export const BUILTIN_NAMES: Record<GmBuiltin, string> = { d20: 'Talking d20', tome: 'Living spellbook', skull: 'Skull lantern', radio: 'Field radio', orb: 'Holo orb', voice: 'Voice only (a glow)' };

/** Spot index of the GM's chair in TTRPG rooms (SPOT_12 / GM_SEAT). */
export const GM_SPOT = 11;
/** Automatic seating in a TTRPG room (scene.json has a `ttrpg` block) keeps the GM's chair for the GM: 'never' — no
 *  performer is auto-seated there while an AI GM runs the table (its figure / avatar sits there); 'last' — only when no
 *  other spot is free (no table, no GM, or a human GM who is someone else); 'free' — the human GM (the chair is theirs).
 *  Ordinary rooms: always 'free'. A host's explicit move onto spot 12 is never refused. */
export function gmSeatRule(room: { ttrpg?: unknown } | null | undefined, table: SceneTtrpgState | null | undefined, key: string): 'free' | 'last' | 'never' {
  if (!room?.ttrpg) return 'free';
  if (table?.on && table.gm.kind === 'human') return table.gm.who === key ? 'free' : 'last';
  return table?.on && table.gm.kind === 'ai' ? 'never' : 'last';
}
