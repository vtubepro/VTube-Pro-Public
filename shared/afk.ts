// AFK / starting-soon cinematic mode + chatter names on ships (docs/SCENES.md "AFK cinematic director").
//
// Shared by the server (sanitiser), the host studio (stamps the state), OBS pages and party guests (render it). Everything
// on screen is a PURE FUNCTION of the host's stamped state (`SceneState.afk`: seed, epoch, the crew of chatter names) +
// room data + the wall clock, so every OBS page, the Scene-tab preview and every party guest cut to the same shot at the
// same moment and paint the same name on the same ship. No three.js in here: tools/afk_unit.ts runs it under `npx tsx`.
//
// Clock: `epoch`, event times and crew `at` stamps are wall-clock ms on the SAME base as sky traffic (Date.now()) and room
// clips (seconds since UTC midnight) — deliberately NOT converted to a guest's clock like raid / space epochs: traffic
// and clips aren't either, so on a guest page whose clock is skewed the whole show (ships, battle, cuts) shifts together
// and every cut still lands on the same ship moment.

import { safeName } from './audience.ts';
import { removedBy } from './chatRemove.ts';
import type { ChatEvent } from './chat.ts';

// ---------------------------------------------------------------- state (host-owned, SceneState.afk)
export type AfkOverlay = 'off' | 'brb' | 'soon' | 'custom';
export type AfkNames = 'afk' | 'always' | 'off';
export type AfkPace = 'calm' | 'normal' | 'snappy';
/** One chatter name for the ships: the display name as it appeared in public chat (never an id), when it joined the crew
 *  list and — once newer chatters pushed it out — when it left (epoch ms, wall clock). A ship keeps the name it took off
 *  with (see crewNameFor); retired names only stay for the ships that took off with them, then drop out. */
export interface AfkCrewName { n: string; at: number; until?: number }

export interface SceneAfkState {
  /** The cinematic director runs (Talk mode; the raid / kitchen / interview directors and entrance cams still win). */
  on: boolean;
  /** Schedule seed + origin (epoch ms), re-stamped each time AFK turns on. */
  seed: number;
  epoch: number;
  /** Title card on OBS pages (off by default). */
  overlay: AfkOverlay;
  /** Custom title (overlay 'custom'). */
  text: string;
  /** Chatter names on ships: while AFK (default), always, or never. */
  names: AfkNames;
  /** Cut to landings, launches and kills when a camera sees them. */
  events: boolean;
  /** Shot length: calm 1.4×, normal, snappy 0.7× the room's hold. */
  pace: AfkPace;
  /** Walk the host out of the room while AFK (and back in when AFK ends). */
  hideHost: boolean;
  /** (host) AFK walked the host out — walk them back in when it ends. */
  hostOut?: boolean;
  /** Recent chatters (host-stamped: every page paints the same names), newest first, ≤ AFK_CREW_MAX. */
  crew: AfkCrewName[];
}

export const AFK_CREW_MAX = 24;
export const AFK_NAME_MAX = 24;
/** The custom title card's text (the Scene-tab input, POST /api/scene/afk and the saved state all cap it here). */
export const AFK_TEXT_MAX = 48;
export const DEFAULT_AFK_STATE: SceneAfkState = { on: false, seed: 0, epoch: 0, overlay: 'off', text: '', names: 'afk', events: true, pace: 'normal', hideHost: false, crew: [] };
export const AFK_PACE: Record<AfkPace, number> = { calm: 1.4, normal: 1, snappy: 0.7 };
/** What the studio says when the connected helper is older than AFK mode (it drops the afk state from the saved scene, so
 *  its OBS pages would neither tour nor paint names): plain words, shown in the AFK panel and in Simple's Away row. */
export const AFK_OVERLAY_TITLE: Record<Exclude<AfkOverlay, 'off' | 'custom'>, string> = { brb: 'BE RIGHT BACK', soon: 'STARTING SOON' };

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f-\u009f\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;   // (U+200D, the emoji joiner, is dealt with below)
const PICTO_END = /\p{Extended_Pictographic}[\ufe0f\u{1f3fb}-\u{1f3ff}]*$/u;
const PICTO_START = /^\p{Extended_Pictographic}/u;
/** U+200D stays only where it joins two emoji (a family, flag or profession sequence); anywhere else it is invisible, so it goes. */
function keepEmojiJoiners(s: string): string {
  if (!s.includes('\u200d')) return s;
  const parts = s.split('\u200d');
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) out += (PICTO_END.test(out) && PICTO_START.test(parts[i]) ? '\u200d' : '') + parts[i];
  return out;
}
/** A display name made safe to paint: no control / bidi / zero-width characters, single spaces, ≤ `max` characters
 *  (counted by code point, so a pair of surrogates is never cut in half). */
export function cleanCrewName(v: unknown, max = AFK_NAME_MAX): string {
  if (typeof v !== 'string') return '';
  const s = keepEmojiJoiners(v.replace(/[\t\r\n]+/g, ' ').replace(CTRL, '')).replace(/\s+/g, ' ').trim();
  return (s.length > max ? Array.from(s).slice(0, max).join('') : s).replace(/\u200d+$/, '').trim();
}

const numIn = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export function sanitizeAfkState(o: unknown): SceneAfkState {
  const d = DEFAULT_AFK_STATE;
  if (!o || typeof o !== 'object') return { ...d, crew: [] };
  const x = o as Record<string, unknown>;
  const crew: AfkCrewName[] = [];
  const seen = new Set<string>();
  let live = 0, gone = 0;
  if (Array.isArray(x.crew)) for (const c of x.crew.slice(0, AFK_CREW_MAX * 4)) {
    if (!c || typeof c !== 'object') continue;
    const r = c as Record<string, unknown>;
    const n = cleanCrewName(r.n);
    const at = r.at, until = r.until;
    if (n.length < 2 || !crewNameClean(n) || typeof at !== 'number' || !Number.isFinite(at) || at < 0 || at > 1e14 || seen.has(n.toLowerCase())) continue;
    const retired = typeof until === 'number' && Number.isFinite(until) && until > 0 && until < 1e14;
    if (retired ? gone >= AFK_CREW_MAX : live >= AFK_CREW_MAX) continue;
    seen.add(n.toLowerCase());
    if (retired) { gone++; crew.push({ n, at: Math.round(at), until: Math.round(until as number) }); } else { live++; crew.push({ n, at: Math.round(at) }); }
  }
  return {
    on: x.on === true,
    seed: Math.round(numIn(x.seed, 0, 2 ** 32, 0)) >>> 0,
    epoch: Math.round(numIn(x.epoch, 0, 1e14, 0)),
    overlay: x.overlay === 'brb' || x.overlay === 'soon' || x.overlay === 'custom' ? x.overlay : 'off',
    text: cleanCrewName(typeof x.text === 'string' ? x.text.slice(0, 96) : '', AFK_TEXT_MAX),
    names: x.names === 'always' || x.names === 'off' ? x.names : 'afk',
    events: x.events !== false,
    pace: x.pace === 'calm' || x.pace === 'snappy' ? x.pace : 'normal',
    hideHost: x.hideHost === true,
    ...(x.hostOut === true ? { hostOut: true } : {}),
    crew,
  };
}

/** Are chatter names painted on ships right now? */
export const afkNamesOn = (s: SceneAfkState | undefined | null) => !!s && s.names !== 'off' && (s.names === 'always' || s.on);
/** The overlay title in effect ('' = none). */
export function afkTitle(s: SceneAfkState | undefined | null): string {
  if (!s?.on || s.overlay === 'off') return '';
  return s.overlay === 'custom' ? s.text : AFK_OVERLAY_TITLE[s.overlay];
}

// ---------------------------------------------------------------- room config (scene.json, all optional)
export interface RoomAfkShot { cam: string; weight?: number; hold?: [number, number]; drift?: AfkDrift }
export type AfkDrift = 'push' | 'pull' | 'pan' | 'none';
export type AfkMomentKind = 'kill' | 'dies' | 'land' | 'launch' | 'moment';
export interface RoomAfkMoment {
  /** The node the moment happens at (its world position at `at` is where cameras must look). */
  node?: string;
  /** Loop length (s): default = the room clip animating `node` (or named `clip`). */
  every?: number;
  clip?: string;
  /** Seconds into the loop. */
  at: number;
  kind?: AfkMomentKind;
  /** Cameras allowed for it (default: any camera that sees it). */
  cams?: string[];
  /** Seconds shown before / after the moment. */
  lead?: number;
  tail?: number;
}
/** scene.json `afk`. */
export interface RoomAfkConfig {
  /** The cycle: camera names (or {cam, weight, hold, drift}). Default: every CAM_* except tight ones (a performer's face
   *  big in frame), CAM_REACT, CAM_DOOR and the raid / space cinematic cameras. */
  shots?: (string | RoomAfkShot)[];
  /** Cameras never used by the cycle. */
  exclude?: string[];
  /** Seconds per shot [min, max] (default [7, 12]). */
  hold?: [number, number];
  /** 'shuffle' (seeded, every shot once per round, default) or 'list' (in order). */
  order?: 'shuffle' | 'list';
  /** Live (moving) camera presets (the ones the room flags `live`) join the cycle and the event shots (default true). */
  includeLive?: boolean;
  /** Event shots in this room (default true). */
  events?: boolean;
  /** Find battle moments in the room clips: pop-ins of nodes named *EXPLOSION* / *BOOM* / *BLAST* / *KILL* (default true). */
  autoMoments?: boolean;
  moments?: RoomAfkMoment[];
  /** Chase / over-the-shoulder cameras on our own craft (traffic ships, shipNames craft) for event shots (default true). */
  chase?: boolean;
  /** Slow push-in / pull-out / pan while a static shot holds (default true). */
  drift?: boolean;
  /** Seconds of ordinary shots at least between two event shots (default 14). */
  gap?: number;
  /** Share of the moments that get an event shot (0…1, default 0.7). */
  share?: number;
}
export interface RoomShipNamesStyle { text?: string; bg?: string; border?: string; font?: string; /** px at 1080p */ size?: number; upper?: boolean }
/** scene.json `shipNames`. */
export interface RoomShipNamesConfig {
  /** false = no name tags in this room. */
  enabled?: boolean;
  /** Sky-traffic ships (default true) and the parked ones (default true). */
  traffic?: boolean;
  parked?: boolean;
  /** Room craft that get a tag (and can be chased by event shots). Default: nodes named after one of the room's traffic
   *  ships (e.g. BTL_G1_SKIFF_A for `skiff`); false = none. */
  craft?: (string | { node: string; label?: string })[] | false;
  /** Ship id → class label (default: the id, capitalised). */
  classes?: Record<string, string>;
  style?: RoomShipNamesStyle;
  /** Beyond this distance (m) a tag is never drawn (default 1200). */
  maxDistance?: number;
}

// ---------------------------------------------------------------- hashing (identical on every JS engine)
/** 32-bit hash of numbers / strings (FNV-1a over the parts, then an avalanche). */
export function afkHash(...parts: (number | string)[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    const s = typeof p === 'number' ? String(Math.round(p * 1000) / 1000) : p;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    h ^= 0x1f; h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}
export const afkRand = (...parts: (number | string)[]) => afkHash(...parts) / 4294967296;

// ---------------------------------------------------------------- the regular shot cycle
export interface AfkShotDef { id: string; weight: number; hold: [number, number] }
export interface AfkSegment { n: number; shot: number; start: number; end: number }

/** The cycle of ordinary shots from `epoch`: seeded rounds (shuffle: every shot `weight` times per round, never the same
 *  shot twice in a row; list: in order), each shot held a seeded time in its hold range × pace. Segments are generated
 *  lazily and kept (≈ 9 000 for a day), so any time maps to the same segment on every page. */
export class AfkCycle {
  private segs: AfkSegment[] = [];
  private round: number[] = [];
  private roundN = -1;
  private pos = 0;
  constructor(readonly seed: number, readonly epoch: number, readonly shots: AfkShotDef[], readonly order: 'shuffle' | 'list', readonly pace = 1) {}

  private roundOf(r: number, prevLast: number): number[] {
    const list: number[] = [];
    this.shots.forEach((s, i) => { for (let k = 0; k < Math.max(1, Math.min(4, Math.round(s.weight))); k++) list.push(i); });
    if (this.order === 'list' || list.length < 2) return list;
    // seeded Fisher-Yates, then break up repeats (a weight-2 shot, the round boundary)
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(afkRand(this.seed, 'round', r, i) * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    const clean = (k: number) => k < 0 || k >= list.length || (list[k] !== (k === 0 ? prevLast : list[k - 1]) && (k + 1 >= list.length || list[k] !== list[k + 1]));
    for (let i = 0; i < list.length; i++) {
      if (list[i] !== (i === 0 ? prevLast : list[i - 1])) continue;
      // swap it with the first element (either side) that leaves no repeat around either position
      for (let j = 0; j < list.length; j++) {
        if (j === i || list[j] === list[i]) continue;
        [list[i], list[j]] = [list[j], list[i]];
        if ([i - 1, i, i + 1, j - 1, j, j + 1].every(clean)) break;
        [list[i], list[j]] = [list[j], list[i]];
      }
    }
    return list;
  }

  private grow() {
    if (this.pos >= this.round.length) {
      const last = this.round.length ? this.round[this.round.length - 1] : -1;
      this.roundN++;
      this.round = this.roundOf(this.roundN, last);
      this.pos = 0;
    }
    const n = this.segs.length;
    const shot = this.round[this.pos++];
    const [a, b] = this.shots[shot].hold;
    const len = Math.max(2000, Math.round((a + (b - a) * afkRand(this.seed, 'hold', n)) * 1000 * this.pace));
    const start = n ? this.segs[n - 1].end : this.epoch;
    this.segs.push({ n, shot, start, end: start + len });
  }

  /** The segment on air at `t` (ms). Before the epoch: the first one. */
  at(t: number): AfkSegment {
    if (!this.shots.length) return { n: 0, shot: -1, start: this.epoch, end: Infinity };
    if (!this.segs.length) this.grow();
    let guard = 0;
    while (this.segs[this.segs.length - 1].end <= t && guard++ < 200_000) this.grow();
    if (t < this.epoch) return this.segs[0];
    let lo = 0, hi = this.segs.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.segs[m].end <= t) lo = m + 1; else hi = m; }
    return this.segs[lo];
  }
  /** Segment n (generated on demand). */
  seg(n: number): AfkSegment | null {
    if (n < 0 || !this.shots.length) return null;
    let guard = 0;
    while (this.segs.length <= n && guard++ < 200_000) this.grow();
    return this.segs[n] ?? null;
  }
}

// ---------------------------------------------------------------- event shots (landings, launches, kills)
export interface AfkEvent {
  /** Stable id of this occurrence (kind + source + occurrence), the same on every page. */
  id: string;
  kind: AfkMomentKind;
  /** The moment (ms): touchdown / lift-off / the explosion. */
  at: number;
  /** Shown from at − lead to at + tail (ms). */
  lead: number;
  tail: number;
  /** Higher wins a conflict (kind weight × how well a camera sees it × a seeded jitter). */
  prio: number;
  /** This event's own factor on the room's share (a kill in a short loop repeats: fewer of its occurrences count). */
  share?: number;
}
const evStart = (e: AfkEvent) => e.at - e.lead;
const evEnd = (e: AfkEvent) => e.at + e.tail;
const beats = (a: AfkEvent, b: AfkEvent) => (a.prio !== b.prio ? a.prio > b.prio : a.id < b.id);

/** Which events get an event shot: a seeded `share` of them is eligible, and an eligible event is taken when it beats
 *  every other eligible event whose shot (padded by `gap` ms of ordinary shots) would overlap it. A LOCAL rule — it only
 *  looks at neighbours within ±(longest event + gap) — so a page that opens late decides exactly like one that ran all
 *  along. Returns the taken events sorted by start. */
export function takeEvents<E extends AfkEvent>(evs: E[], seed: number, gap: number, share: number): E[] {
  const el = evs.filter((e) => afkRand(seed, 'share', e.id) < share * (e.share ?? 1)).sort((a, b) => evStart(a) - evStart(b) || (a.id < b.id ? -1 : 1));
  const out: E[] = [];
  for (let i = 0; i < el.length; i++) {
    const e = el[i];
    let ok = true;
    for (let j = 0; j < el.length && ok; j++) {
      if (j === i) continue;
      const f = el[j];
      if (evStart(f) < evEnd(e) + gap && evStart(e) < evEnd(f) + gap && beats(f, e)) ok = false;
    }
    if (ok) out.push(e);
  }
  return out;
}

export type AfkPick<E extends AfkEvent = AfkEvent> = { kind: 'shot'; seg: AfkSegment; from: number; to: number } | { kind: 'event'; ev: E; from: number; to: number };
/** Shortest stretch an ordinary shot is shown between cuts (ms). */
export const AFK_MIN_SHOW = 3500;

/** What is on air at `t` (ms): the taken event covering it, else the cycle's segment — but never a sliver: an ordinary
 *  shot squeezed to < AFK_MIN_SHOW by an event is replaced by its neighbour (the one before keeps going until the event,
 *  or the one after starts right when the event ends), and a gap < AFK_MIN_SHOW between two events keeps the first
 *  event's shot up. `from` / `to` = when this pick went on air / goes off (ms). */
export function afkPick<E extends AfkEvent>(t: number, cycle: AfkCycle, taken: E[]): AfkPick<E> {
  let prevEnd = -Infinity, nextStart = Infinity, prevEv: E | null = null;
  for (const e of taken) {
    const s = evStart(e), en = evEnd(e);
    if (s <= t && t < en) return { kind: 'event', ev: e, from: s, to: en };
    if (en <= t && en > prevEnd) { prevEnd = en; prevEv = e; }
    if (s > t && s < nextStart) nextStart = s;
  }
  if (prevEv && nextStart - prevEnd < AFK_MIN_SHOW) return { kind: 'event', ev: prevEv, from: evStart(prevEv), to: nextStart };
  let seg = cycle.at(t);
  let from = Math.max(seg.start, prevEnd), to = Math.min(seg.end, nextStart);
  if (to - from < AFK_MIN_SHOW) {
    if (seg.start < prevEnd) {
      // cut short at its start by an event: the next shot takes over as the event ends
      const nx = cycle.seg(seg.n + 1);
      if (nx) { seg = nx; from = prevEnd; to = Math.min(nx.end, nextStart); }
    } else if (seg.end > nextStart && seg.n > 0) {
      // cut short at its end by an event: the shot before keeps going until the event
      const pv = cycle.seg(seg.n - 1)!;
      from = Math.max(pv.start, prevEnd); to = nextStart; seg = pv;
    }
  }
  return { kind: 'shot', seg, from, to };
}

// ---------------------------------------------------------------- chatter names on ships
export interface AfkFlight { id: string; start: number }

/** Names a flight that started at `start` may carry: in the crew by then and not retired before it (a new chatter never
 *  renames a ship already flying, a chatter pushed out of the list stays on the ships that took off with them). A flight
 *  older than every name (the crew was empty when it started) takes the first batch — so ships already in the air get
 *  names the moment the first chatters arrive, and later arrivals don't rename them. */
function eligible(crew: AfkCrewName[], start: number): AfkCrewName[] {
  const live = crew.filter((c) => c.until === undefined || start < c.until);
  const e = live.filter((c) => c.at <= start);
  if (e.length || !live.length) return e;
  const first = Math.min(...live.map((c) => c.at));
  return live.filter((c) => c.at === first);
}
function ranked(names: AfkCrewName[], seed: number, id: string): string[] {
  return names.map((c) => ({ n: c.n, h: afkHash(seed, id, c.n.toLowerCase()) })).sort((a, b) => b.h - a.h || (a.n < b.n ? -1 : 1)).map((x) => x.n);
}

/** Naming history is resolved within wall-clock hours (UTC): a flight counts the ships of an earlier hour by their first
 *  choice. Bounds the work (a page that opens late resolves ≤ 1 hour of flights, a few ms) and only matters for ships
 *  that took off in the last minutes of the previous hour. */
export const AFK_NAME_FRAME = 3600_000;

/** The name a flight carries (null = no eligible names). Stable for the whole flight and the same on every page:
 *  rendezvous hashing over its eligible names, taking the first one no ship already in the air carries (else the least
 *  used) — `activeAt(t)` = the flights up at time t (ties by id). The ships already in the air are named the same way
 *  (memoised per crew list in `memo`), so ships seen together get different names while there are enough names. */
export function crewNameFor(crew: AfkCrewName[], seed: number, f: AfkFlight, activeAt: (t: number) => AfkFlight[], memo: Map<string, string | null> = new Map(), frameMs = AFK_NAME_FRAME): string | null {
  const hit = memo.get(f.id);
  if (hit !== undefined) return hit;
  const mine = ranked(eligible(crew, f.start), seed, f.id);
  let out: string | null = mine[0] ?? null;
  if (mine.length > 1) {
    const fr = Math.floor(f.start / frameMs);
    const used = new Map<string, number>();
    for (const g of activeAt(f.start)) {
      if (g.id === f.id || g.start > f.start || (g.start === f.start && g.id >= f.id)) continue;
      const n = Math.floor(g.start / frameMs) === fr ? crewNameFor(crew, seed, g, activeAt, memo, frameMs) : ranked(eligible(crew, g.start), seed, g.id)[0] ?? null;
      if (n) used.set(n.toLowerCase(), (used.get(n.toLowerCase()) ?? 0) + 1);
    }
    let best = Infinity;
    for (const n of mine) { const u = used.get(n.toLowerCase()) ?? 0; if (u < best) { best = u; out = n; if (!u) break; } }
  }
  memo.set(f.id, out);
  return out;
}

// ---------------------------------------------------------------- building the crew (host studio)
/** Light normalisation for word checks: lower case, common digit / symbol swaps, letters only. */
function norm(s: string): string {
  const map: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i', '|': 'i' };
  return s.toLowerCase().replace(/[0-9@$!|]/g, (c) => map[c] ?? c).replace(/[^a-z]/g, '');
}
/** Is this name clean by the app's built-in word + link filter (shared/audience.ts safeName: the filter the crowd name tags
 *  and the question cards use — it folds look-alike letters, spaced-out letters and links)? Memoised: the filter is not
 *  cheap and the sanitiser runs on every scene edit. Names the streamer allow-listed for the crowd are not looked up here
 *  (the scene has no audience settings); the host's own AFK word list is `crewNameOk`'s `block`. */
const cleanMemo = new Map<string, boolean>();
export function crewNameClean(name: string): boolean {
  const n = cleanCrewName(name);
  if (!n) return false;
  const k = n.toLowerCase();
  const hit = cleanMemo.get(k);
  if (hit !== undefined) return hit;
  // ('viewer' is what safeName answers for a blocked name; a chatter really called "viewer" is fine)
  const ok = safeName(n, { blocklist: [], builtinBlock: true }) !== 'viewer' || k === 'viewer';
  if (cleanMemo.size > 2000) cleanMemo.clear();
  cleanMemo.set(k, ok);
  return ok;
}
/** Can this display name go on a ship? Not a link, not a slur (built-in filter), not a blocked word (the host's list,
 *  matched loosely), ≥ 2 characters. */
export function crewNameOk(name: string, block: readonly string[] = []): boolean {
  const n = cleanCrewName(name);
  if (n.length < 2) return false;
  if (!crewNameClean(n)) return false;
  if (/(https?:|www\.|\.(com|net|org|tv|gg|io|ly|me|xyz|ru)\b|discord\.)/i.test(n)) return false;
  const k = norm(n);
  for (const w of block) { const b = norm(w); if (b.length >= 3 && k.includes(b)) return false; }
  return true;
}

export interface CrewSighting { user: string; ts: number; bot?: boolean; broadcaster?: boolean }
/** A chatter the host's crew list remembers: the display name as it appeared in chat, its last message time and — from that
 *  chat line — the platform and the platform user id. (A name seeded from the saved state has neither.) */
export interface CrewSeen { n: string; ts: number; platform?: ChatEvent['platform']; uid?: string }
/** Which remembered chatters (key = the lower-case name) a moderation event takes off the ships. The rule every holder of
 *  chat lines uses (shared/chatRemove.ts removedBy): by platform user id when both sides have one — Twitch names the LOGIN
 *  of a banned user while the chat line carries the DISPLAY name, so a name match misses anyone whose display name is not
 *  just their login in other letters — else by name; '*' (a chat clear) = everyone on THAT platform. A name with no platform
 *  yet goes on '*' or a name match. */
export function crewPurged(seen: Iterable<[string, CrewSeen]>, rm: Pick<ChatEvent, 'kind' | 'platform' | 'target' | 'uid'>): string[] {
  const out: string[] = [];
  const target = (rm.target ?? '').toLowerCase();
  for (const [k, v] of seen) {
    const gone = v.platform ? removedBy(rm, { id: '', kind: 'chat', platform: v.platform, user: v.n, uid: v.uid }) : target === '*' || v.n.toLowerCase() === target;
    if (gone) out.push(k);
  }
  return out;
}
/** Lead (ms) before a newly stamped name can go on a ship: the state reaches every OBS page and guest first. */
export const AFK_CREW_LEAD = 3000;
/** Retired names stay this long (ms) after they left the list: the longest a ship keeps flying with one. */
export const AFK_CREW_KEEP = 15 * 60_000;
/** The crew list from the chatters seen (each name's last message time `ts`): the most recent chatters, ≤ max names. A
 *  name already in `cur` keeps its `at`; a new one gets `now` + AFK_CREW_LEAD (never a ship already flying, see
 *  crewNameFor). A name newer chatters push out is retired (`until` = now + lead: ships that took off with it keep it)
 *  and dropped AFK_CREW_KEEP later. Banned (moderated) names, bots, the broadcaster, links and blocked words never enter
 *  — and a banned name is removed at once, retired or not. */
export function mergeCrew(cur: AfkCrewName[], seen: CrewSighting[], now: number, opts: { max?: number; block?: readonly string[]; banned?: ReadonlySet<string> } = {}): AfkCrewName[] {
  const max = Math.max(1, Math.min(AFK_CREW_MAX, opts.max ?? AFK_CREW_MAX));
  const banned = opts.banned ?? new Set<string>();
  const last = new Map<string, { n: string; ts: number }>();
  for (const s of seen) {
    const n = cleanCrewName(s.user);
    if (s.bot || s.broadcaster || !crewNameOk(n, opts.block)) continue;
    const k = n.toLowerCase();
    const p = last.get(k);
    if (!p || s.ts > p.ts) last.set(k, { n, ts: s.ts });
  }
  const had = new Map(cur.map((c) => [c.n.toLowerCase(), c]));
  const live = [...last.entries()]
    .filter(([k]) => !banned.has(k))
    .sort((a, b) => b[1].ts - a[1].ts || (a[0] < b[0] ? -1 : 1))
    .slice(0, max)
    .map(([k, v]): AfkCrewName => {
      const h = had.get(k);
      // (back before its retirement took effect: simply still in; after it: a fresh entry)
      if (h && (h.until === undefined || h.until > now + AFK_CREW_LEAD)) return { n: h.n, at: h.at };
      return { n: v.n, at: Math.round(now + AFK_CREW_LEAD) };
    });
  const inLive = new Set(live.map((c) => c.n.toLowerCase()));
  const retired: AfkCrewName[] = [];
  for (const c of cur) {
    const k = c.n.toLowerCase();
    if (inLive.has(k) || banned.has(k) || !crewNameOk(c.n, opts.block)) continue;
    const until = c.until ?? Math.round(now + AFK_CREW_LEAD);
    if (until + AFK_CREW_KEEP > now) retired.push({ n: c.n, at: c.at, until });
  }
  retired.sort((a, b) => b.until! - a.until! || (a.n < b.n ? -1 : 1));
  return [...live, ...retired.slice(0, AFK_CREW_MAX)];
}
/** Same names (order doesn't matter to the ships: only the set and the `at` / `until` stamps do). */
export function sameCrew(a: AfkCrewName[], b: AfkCrewName[]): boolean {
  if (a.length !== b.length) return false;
  const m = new Map(a.map((c) => [c.n, `${c.at}|${c.until ?? ''}`]));
  return b.every((c) => m.get(c.n) === `${c.at}|${c.until ?? ''}`);
}
/** The names showing in the list now (not retired). */
export const liveCrew = (crew: AfkCrewName[]) => crew.filter((c) => c.until === undefined);

