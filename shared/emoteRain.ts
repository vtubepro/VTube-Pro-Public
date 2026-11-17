// Emote rain + chat flying past the avatar (beta.16, docs/b16/EMOTE_RAIN.md): chat's emotes fall onto the avatar's head,
// bounce off it and pile up on the shoulders, then fade. An optional lane of chat lines flies across the picture.
//
// This file is the DOM-free core, shared by the studio (settings, stamps), the OBS page (the physics and the drawing) and
// tools/emote_rain_unit.ts. Nothing here touches the screen, the network or a clock of its own:
//
//   1. SETTINGS   EmoteRainBag (SceneState.modes.emoterain, plain JSON, well under 6 KB) + sanitizer + the stamp (RainEvent)
//   2. WHAT FALLS rainSourcesOf (a chat line -> its emote pictures and emoji, only when the line may be shown), the pool of
//                 recent emotes, the per-minute budget, chat removals (delete / ban take their emotes off again)
//   3. PHYSICS    RainWorld (struct-of-arrays, fixed capacity, no allocation per frame): fall, bounce off the head,
//                 land on the shoulders, stack, fade. FlyLane: the chat lane.
//
// Custody + privacy: only chat lines the page already shows are used; a hidden / filtered / deleted line never makes
// anything fall. Emote pictures are public CDN images (never an avatar, never saved); nothing here writes to disk.
import { chatVisible, type ChatEvent, type SceneChatState } from './chat.ts';
import { removedBy } from './chatRemove.ts';

export const EMOTE_RAIN_BAG = 'emoterain';

// ---------------------------------------------------------------- settings

export const RAIN_MODES = ['off', 'all', 'rules'] as const;
/** off = nothing falls · all = every chat emote falls (and rules / keys / raids work) · rules = only a rule, key or raid makes it fall. */
export type RainMode = (typeof RAIN_MODES)[number];
export const RAIN_LANES = ['off', 'front', 'behind'] as const;
export type RainLane = (typeof RAIN_LANES)[number];
export const RAIN_WHERE = ['avatar', 'center', 'left', 'right'] as const;
export type RainWhere = (typeof RAIN_WHERE)[number];
export const RAIN_SIZES = ['s', 'm', 'l'] as const;
export type RainSize = (typeof RAIN_SIZES)[number];
export const RAIN_FROM = ['chat', 'raider', 'redeemer'] as const;
export type RainFrom = (typeof RAIN_FROM)[number];
export const RAIN_OPS = ['burst', 'start', 'stop'] as const;
export type RainOpName = (typeof RAIN_OPS)[number];

export const RAIN_LIMITS = {
  perMin: [5, 120] as const,
  secs: [1, 120] as const,
  /** Pictures alive at once (the physics pool). */
  particles: 80,
  /** Chat lines flying at once. */
  laneLines: 8,
  /** A line's longest text (characters). */
  laneChars: 90,
  /** Emotes one chat line may drop. */
  perLine: 3,
} as const;

/** Radius of one falling picture, in frame heights (1 = the whole picture's height). */
export const RAIN_RADIUS: Record<RainSize, number> = { s: 0.028, m: 0.04, l: 0.056 };

/** What the stamp asks for. `at` is the host clock (ms); pages play an event once, by `seq`. */
export interface RainEvent {
  seq: number;
  at: number;
  op: RainOpName;
  secs: number;
  from: RainFrom;
  /** Display name of the raider / redeemer (a rule gives it; used to pick that person's emotes). */
  user?: string;
  /** From the panel's Try it button: plays even while the rain is switched off. */
  test?: boolean;
}

export interface EmoteRainBag {
  mode: RainMode;
  /** Most chat emotes that fall in one minute (bursts from a rule or a raid are on top, with their own cap). */
  perMin: number;
  size: RainSize;
  /** Emotes stay on the shoulders for a few seconds (off = they bounce off and fall away). */
  pile: boolean;
  /** A raid bursts emotes without any rule. */
  raid: boolean;
  where: RainWhere;
  lane: RainLane;
  ev: RainEvent | null;
}

export const DEFAULT_EMOTE_RAIN: EmoteRainBag = { mode: 'off', perMin: 30, size: 'm', pile: true, raid: true, where: 'avatar', lane: 'off', ev: null };

const pick = <T extends string>(v: unknown, list: readonly T[], d: T): T => ((list as readonly unknown[]).includes(v) ? v as T : d);
const clampN = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const NAME = /^[^\u0000-\u001f<>]{1,48}$/;

export function sanitizeRainEvent(o: unknown): RainEvent | null {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const x = o as Record<string, unknown>;
  const op = pick(x.op, RAIN_OPS, 'burst');
  if (typeof x.seq !== 'number' || !Number.isFinite(x.seq) || typeof x.at !== 'number' || !Number.isFinite(x.at) || x.at <= 0) return null;
  const user = typeof x.user === 'string' && NAME.test(x.user.trim()) ? x.user.trim() : undefined;
  return { seq: Math.max(0, Math.floor(x.seq)), at: x.at, op, secs: Math.round(clampN(x.secs, RAIN_LIMITS.secs[0], RAIN_LIMITS.secs[1], 8)), from: pick(x.from, RAIN_FROM, 'chat'), ...(user ? { user } : {}), ...(x.test === true ? { test: true } : {}) };
}

export function sanitizeEmoteRain(o: unknown): EmoteRainBag {
  const x = (o && typeof o === 'object' && !Array.isArray(o) ? o : {}) as Record<string, unknown>;
  const d = DEFAULT_EMOTE_RAIN;
  return {
    mode: pick(x.mode, RAIN_MODES, d.mode),
    perMin: Math.round(clampN(x.perMin, RAIN_LIMITS.perMin[0], RAIN_LIMITS.perMin[1], d.perMin)),
    size: pick(x.size, RAIN_SIZES, d.size),
    pile: typeof x.pile === 'boolean' ? x.pile : d.pile,
    raid: typeof x.raid === 'boolean' ? x.raid : d.raid,
    where: pick(x.where, RAIN_WHERE, d.where),
    lane: pick(x.lane, RAIN_LANES, d.lane),
    ev: sanitizeRainEvent(x.ev),
  };
}

/** The plain JSON that goes into SceneState.modes.emoterain (no `ev: null`, nothing undefined). */
export function emoteRainJson(b: EmoteRainBag): Record<string, unknown> {
  const { ev, ...rest } = sanitizeEmoteRain(b);
  return ev ? { ...rest, ev } : { ...rest };
}

/** A deck / rule request: "emote-rain" with op, secs, from (shared/deck.ts plans the same ranges). Null = junk. */
export interface RainOp { op: RainOpName; secs: number; from: RainFrom; user?: string }
export function planRainOp(a: unknown, user?: string): RainOp | null {
  const x = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
  const op = x.op === undefined || x.op === '' ? 'burst' : x.op;
  if (!(RAIN_OPS as readonly unknown[]).includes(op)) return null;
  const from = x.from === undefined || x.from === '' ? 'chat' : x.from;
  if (!(RAIN_FROM as readonly unknown[]).includes(from)) return null;
  const sec = Number(x.secs);
  const u = (typeof x.user === 'string' && x.user.trim() ? x.user : user)?.trim();
  return { op: op as RainOpName, from: from as RainFrom, secs: Math.round(Number.isFinite(sec) ? clampN(sec, RAIN_LIMITS.secs[0], RAIN_LIMITS.secs[1], 8) : 8), ...(u && NAME.test(u) ? { user: u } : {}) };
}

/** Is a stamp still worth playing? (A page that loads later must not replay yesterday's burst.) */
export function rainEventFresh(ev: RainEvent, now: number): boolean {
  if (ev.at - now > 10_000) return false;
  const span = ev.op === 'start' ? ev.secs * 1000 : ev.op === 'burst' ? 6000 : 1500;
  return now - ev.at < span + 1500;
}

/** How many emotes a burst of `secs` drops, and how long they take to leave the sky (s). */
export function burstPlan(secs: number): { count: number; over: number } {
  const count = Math.min(40, Math.max(8, Math.round(secs * 2.5)));
  return { count, over: Math.min(3, 1 + secs / 8) };
}
/** A raid's burst: more viewers, more emotes (12 .. 40). */
export function raidPlan(viewers: number): { count: number; over: number } {
  const count = Math.min(40, Math.max(12, Math.round(6 + Math.sqrt(Math.max(0, viewers)) * 2.2)));
  return { count, over: 3 };
}
/** Steady rain (op "start"): emotes per second. */
export const STEADY_RATE = 4;
/** Two bursts closer than this are one (a rule AND the raid switch asking for the same raid). */
export const BURST_GAP_MS = 2500;

// ---------------------------------------------------------------- what falls

/** Pictures a falling thing can be: 'u:<emote image url>' or 'g:<emoji>'. */
export type RainKey = string;
export const FALLBACK_GLYPHS = ['❤️', '✨', '🎉', '⭐', '💜', '🔥', '😂', '👏', '🌈', '💖'];

/** What identifies where an emote came from (so a delete / ban can take it off again). */
export type RainSrc = Pick<ChatEvent, 'id' | 'kind' | 'platform' | 'user' | 'uid'>;
export const srcOf = (e: ChatEvent): RainSrc => ({ id: e.id, kind: e.kind, platform: e.platform, user: e.user, ...(e.uid ? { uid: e.uid } : {}) });

const EMOJI = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*/gu;
/** Emoji in plain text (the first few, in order, once each). */
export function emojiOf(text: string, max = 2): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(EMOJI)) {
    const g = m[0];
    // old text symbols (©, ™, arrows ...) only count with the emoji marker; real emoji sit at 0x2300 and up
    if (out.includes(g) || ((g.codePointAt(0) ?? 0) < 0x2300 && !g.includes('️'))) continue;
    out.push(g);
    if (out.length >= max) break;
  }
  return out;
}

const URL_OK = (u: string) => /^\/[\w\-./%?=&]{1,300}$/.test(u) || /^https:\/\/[\w\-.]+(:\d+)?\/[^\s"'<>\\]{0,400}$/.test(u);

/** The pictures one chat line drops (none when the line must not be shown: a bot or !command under the chat filters, a
 *  removal, or when chat is hidden). Image emotes first, then emoji from the text; at most RAIN_LIMITS.perLine. */
export function rainSourcesOf(ev: ChatEvent, st: Pick<SceneChatState, 'hideBots' | 'hideCommands' | 'bots' | 'hidden'> | null | undefined): RainKey[] {
  if (ev.kind !== 'chat') return [];
  if (st?.hidden) return [];
  if (st && !chatVisible(ev, { hideBots: st.hideBots, hideCommands: st.hideCommands, bots: st.bots ?? [] } as SceneChatState)) return [];
  const out: RainKey[] = [];
  for (const p of ev.parts ?? []) {
    if (p.t !== 'emote' || p.zw || !URL_OK(p.u)) continue;
    const k = 'u:' + p.u;
    if (!out.includes(k)) out.push(k);
    if (out.length >= RAIN_LIMITS.perLine) return out;
  }
  for (const g of emojiOf(ev.text ?? '')) {
    out.push('g:' + g);
    if (out.length >= RAIN_LIMITS.perLine) break;
  }
  return out;
}

/** One chat line for the lane: text and emote pictures, cut to a sensible length. Null = not to be shown. */
export interface LaneLine { id: string; user: string; color?: string; parts: ({ t: 'text'; v: string } | { t: 'emote'; n: string; u: string })[] }
export function laneLineOf(ev: ChatEvent, st: Pick<SceneChatState, 'hideBots' | 'hideCommands' | 'bots' | 'hidden'> | null | undefined): LaneLine | null {
  if (ev.kind !== 'chat' || st?.hidden) return null;
  if (st && !chatVisible(ev, { hideBots: st.hideBots, hideCommands: st.hideCommands, bots: st.bots ?? [] } as SceneChatState)) return null;
  const src = ev.parts?.length ? ev.parts : [{ t: 'text' as const, v: ev.text }];
  const parts: LaneLine['parts'] = [];
  let chars = 0, emotes = 0;
  for (const p of src) {
    if (p.t === 'text') {
      const v = p.v.replace(/\s+/g, ' ');
      if (!v.trim() && !parts.length) continue;
      const room = RAIN_LIMITS.laneChars - chars;
      if (room <= 0) break;
      parts.push({ t: 'text', v: v.length > room ? v.slice(0, room - 1) + '…' : v });
      chars += Math.min(v.length, room);
    } else if (!p.zw && URL_OK(p.u) && emotes < 8) { parts.push({ t: 'emote', n: p.n, u: p.u }); emotes++; chars += 2; }
  }
  if (!parts.some((p) => p.t === 'emote' || p.v.trim())) return null;
  return { id: ev.id, user: ev.user, ...(ev.color ? { color: ev.color } : {}), parts };
}

/** A raid line: the raider's name and size. */
export function raidOf(ev: ChatEvent): { user: string; viewers: number } | null {
  return ev.kind === 'finance' && ev.fkind === 'raid' ? { user: ev.user, viewers: Math.max(0, Math.round(ev.amount ?? 0)) } : null;
}

/** Most chat emotes per minute (a sliding window; bursts have their own, separate cap). */
export class RainBudget {
  private ring = new Float64Array(RAIN_LIMITS.perMin[1] + 1);
  private head = 0;
  private len = 0;
  constructor(public limit = DEFAULT_EMOTE_RAIN.perMin) {}
  private expire(now: number) {
    while (this.len > 0 && now - this.ring[this.head] >= 60_000) { this.head = (this.head + 1) % this.ring.length; this.len--; }
  }
  /** Ask for `n`; returns how many may go (0..n) and counts them. */
  take(now: number, n = 1): number {
    this.expire(now);
    const room = Math.max(0, Math.min(this.limit, this.ring.length - 1) - this.len);
    const got = Math.min(n, room);
    for (let i = 0; i < got; i++) { this.ring[(this.head + this.len) % this.ring.length] = now; this.len++; }
    return got;
  }
  used(now: number) { this.expire(now); return this.len; }
  clear() { this.head = 0; this.len = 0; }
}

interface PoolItem { key: RainKey; src: RainSrc; ts: number }
/** The emotes seen in chat lately (newest last): what a burst drops. */
export class RainPool {
  private items: PoolItem[] = [];
  constructor(private cap = 80, private maxAgeMs = 10 * 60_000) {}
  add(keys: RainKey[], src: RainSrc, ts: number) {
    for (const key of keys) this.items.push({ key, src, ts });
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap);
  }
  /** Take a removed line's / banned person's emotes out (shared/chatRemove.ts). */
  drop(rm: Pick<ChatEvent, 'kind' | 'platform' | 'target' | 'uid'>) { this.items = this.items.filter((it) => !removedBy(rm, it.src)); }
  /** One emote for a burst: `from` 'raider' / 'redeemer' prefers that person's own emotes; null = nothing seen yet. */
  pick(from: RainFrom, user: string | undefined, now: number, rng: () => number): { key: RainKey; src: RainSrc } | null {
    const fresh = this.items.filter((it) => now - it.ts < this.maxAgeMs);
    if (!fresh.length) return null;
    let pool = fresh;
    if (from !== 'chat' && user) {
      const u = user.toLowerCase();
      const theirs = fresh.filter((it) => it.src.user.toLowerCase() === u);
      if (theirs.length) pool = theirs;
    }
    // lean on the newest: two draws, the later one wins
    const a = Math.floor(rng() * pool.length), b = Math.floor(rng() * pool.length);
    const it = pool[Math.max(a, b)];
    return { key: it.key, src: it.src };
  }
  get size() { return this.items.length; }
  clear() { this.items = []; }
}

// ---------------------------------------------------------------- where they land

/** The head and shoulders, in frame units: x in 0 .. aspect, y in 0 .. 1 (top down). */
export interface RainAnchor {
  /** Head centre. */
  x: number; y: number;
  /** Head ellipse radii. */
  rx: number; ry: number;
  /** Top of the shoulders at the neck, half of their width, half of the neck, and how far they droop at the ends. */
  shY: number; shHalf: number; neck: number; drop: number;
}

/** A sensible spot when the avatar can't be found (or the user picked one): head about a third of the way down. */
export function defaultAnchor(where: RainWhere, aspect: number): RainAnchor {
  const cx = where === 'left' ? 0.27 : where === 'right' ? 0.73 : 0.5;
  return { x: aspect * cx, y: 0.36, rx: 0.075, ry: 0.1, shY: 0.57, shHalf: 0.2, neck: 0.05, drop: 0.035 };
}
/** Is a measured anchor believable (inside the picture, a sensible size)? */
export function anchorOk(a: RainAnchor | null | undefined, aspect: number): a is RainAnchor {
  if (!a) return false;
  const v = [a.x, a.y, a.rx, a.ry, a.shY, a.shHalf, a.neck, a.drop];
  if (!v.every(Number.isFinite)) return false;
  return a.x > -0.2 * aspect && a.x < 1.2 * aspect && a.y > -0.3 && a.y < 1.3 && a.ry > 0.012 && a.ry < 0.6 && a.rx > 0.01 && a.rx < 0.6 && a.shHalf > a.neck && a.shHalf < 1.5;
}
/** Ease `cur` toward `to` (k = 0..1 of the way). Writes into `cur`: no allocation. */
export function easeAnchor(cur: RainAnchor, to: RainAnchor, k: number): RainAnchor {
  cur.x += (to.x - cur.x) * k; cur.y += (to.y - cur.y) * k; cur.rx += (to.rx - cur.rx) * k; cur.ry += (to.ry - cur.ry) * k;
  cur.shY += (to.shY - cur.shY) * k; cur.shHalf += (to.shHalf - cur.shHalf) * k; cur.neck += (to.neck - cur.neck) * k; cur.drop += (to.drop - cur.drop) * k;
  return cur;
}

// ---------------------------------------------------------------- physics

export const ST_DEAD = 0;
export const ST_FALL = 1;
export const ST_REST = 2;
/** Gravity (frame heights per second squared), the fastest fall, the time to fade out, how long a landed emote stays. */
export const RAIN_PHYS = { gravity: 1.9, vmax: 1.3, fade: 0.6, restMin: 3.5, restVar: 2.5, pileMax: 0.2, restSpeed: 0.16, headBounce: 0.55, shoulderBounce: 0.28 } as const;

/**
 * The emotes in the air and on the shoulders. Fixed capacity, struct-of-arrays, nothing allocated while stepping.
 * Surface: the head ellipse and (with `pile`) the shoulder line; a falling emote bounces off the head, lands on the
 * shoulders or on a landed emote, rests there a few seconds (following the avatar if it moves) and fades. When one
 * fades, those stacked on it fall again.
 */
export class RainWorld {
  readonly cap: number;
  readonly x: Float32Array; readonly y: Float32Array; readonly vx: Float32Array; readonly vy: Float32Array;
  readonly r: Float32Array; readonly rot: Float32Array; readonly vr: Float32Array; readonly age: Float32Array;
  /** > 0: fading out (seconds left). */
  readonly fade: Float32Array;
  /** Resting: seconds left. */
  readonly rest: Float32Array;
  /** Resting: offset from the head's x and height above the surface. */
  readonly ox: Float32Array; readonly oy: Float32Array;
  readonly state: Uint8Array;
  readonly sprite: Int16Array;
  readonly src: Int16Array;
  anchor: RainAnchor = defaultAnchor('avatar', 16 / 9);
  aspect = 16 / 9;
  pile = true;
  private n = 0;
  /** 1 = the head, 2 = the shoulders (set by surfaceY). */
  private kind = 0;
  private slope = 0;

  constructor(private rng: () => number = Math.random, cap: number = RAIN_LIMITS.particles) {
    this.cap = cap;
    const f = () => new Float32Array(cap);
    this.x = f(); this.y = f(); this.vx = f(); this.vy = f(); this.r = f(); this.rot = f(); this.vr = f(); this.age = f(); this.fade = f(); this.rest = f(); this.ox = f(); this.oy = f();
    this.state = new Uint8Array(cap); this.sprite = new Int16Array(cap); this.src = new Int16Array(cap);
  }

  /** Living count (falling + resting + fading). */
  get active() { return this.n; }
  get resting() { let c = 0; for (let i = 0; i < this.cap; i++) if (this.state[i] === ST_REST) c++; return c; }

  /** Highest solid y at x (Infinity = nothing there). Sets `kind` / `slope` for the bounce. */
  surfaceY(x: number): number {
    const a = this.anchor, adx = Math.abs(x - a.x);
    let top = Infinity;
    this.kind = 0; this.slope = 0;
    if (adx < a.rx) { top = a.y - a.ry * Math.sqrt(1 - (adx / a.rx) * (adx / a.rx)); this.kind = 1; }
    if (this.pile && adx <= a.shHalf) {
      const t = Math.min(1, Math.max(0, (adx - a.neck) / Math.max(1e-6, a.shHalf - a.neck)));
      const s = a.shY + a.drop * t * t;
      if (s < top) { top = s; this.kind = 2; this.slope = (2 * a.drop * t / Math.max(1e-6, a.shHalf - a.neck)) * (x < a.x ? -1 : 1); }
    }
    return top;
  }

  /** Add one. `x` defaults to a random spot above the head and shoulders. False = no room. */
  spawn(sprite: number, radius: number, src: number, x?: number): boolean {
    let i = -1;
    for (let k = 0; k < this.cap; k++) if (this.state[k] === ST_DEAD) { i = k; break; }
    if (i < 0) return false;
    const a = this.anchor, rng = this.rng;
    this.state[i] = ST_FALL; this.n++;
    this.x[i] = x ?? a.x + (rng() * 2 - 1) * Math.max(a.rx * 1.6, a.shHalf * 0.8);
    this.y[i] = -radius * 1.2;
    this.vx[i] = (rng() - 0.5) * 0.14; this.vy[i] = 0.2 + rng() * 0.15;
    this.r[i] = radius * (0.9 + rng() * 0.2);
    this.rot[i] = (rng() - 0.5) * 0.8; this.vr[i] = (rng() - 0.5) * 3.2;
    this.age[i] = 0; this.fade[i] = 0; this.rest[i] = 0; this.ox[i] = 0; this.oy[i] = 0;
    this.sprite[i] = sprite; this.src[i] = src;
    return true;
  }

  private kill(i: number) {
    if (this.state[i] === ST_DEAD) return;
    const wasRest = this.state[i] === ST_REST;
    this.state[i] = ST_DEAD; this.n--;
    if (!wasRest) return;
    // whatever was stacked on this one falls again
    for (let j = 0; j < this.cap; j++) {
      if (this.state[j] !== ST_REST || j === i) continue;
      if (this.oy[j] > this.oy[i] + 1e-4 && Math.abs(this.ox[j] - this.ox[i]) < (this.r[j] + this.r[i]) * 0.9) { this.state[j] = ST_FALL; this.vx[j] = 0; this.vy[j] = 0; this.rest[j] = 0; }
    }
  }

  /** Everything fades out in `secs`. */
  clear(secs = 0.4) {
    for (let i = 0; i < this.cap; i++) if (this.state[i] !== ST_DEAD && (this.fade[i] <= 0 || this.fade[i] > secs)) this.fade[i] = Math.max(0.01, secs);
  }
  /** Drop all at once (the page is going away). */
  reset() { this.state.fill(ST_DEAD); this.n = 0; }

  /** Fade the ones whose source `pred` says were removed (a deleted line, a ban). */
  fadeWhere(pred: (srcIndex: number) => boolean) {
    for (let i = 0; i < this.cap; i++) if (this.state[i] !== ST_DEAD && pred(this.src[i]) && (this.fade[i] <= 0 || this.fade[i] > 0.25)) this.fade[i] = 0.25;
  }

  alphaOf(i: number) { const f = this.fade[i]; return f > 0 ? Math.min(1, f / RAIN_PHYS.fade) : 1; }
  /** Pop in: 0.55 → 1 over the first 0.15 s. */
  scaleOf(i: number) { const a = this.age[i]; return a >= 0.15 ? 1 : 0.55 + 0.45 * (a / 0.15); }

  step(dt: number) {
    if (!(dt > 0) || this.n === 0) return;
    if (dt > 0.05) dt = 0.05;
    for (let i = 0; i < this.cap; i++) {
      if (this.state[i] === ST_DEAD) continue;
      this.age[i] += dt;
      if (this.fade[i] > 0) { this.fade[i] -= dt; if (this.fade[i] <= 0) { this.kill(i); continue; } }
      if (this.state[i] === ST_FALL) this.stepFall(i, dt); else this.stepRest(i, dt);
    }
  }

  private stepRest(i: number, dt: number) {
    const a = this.anchor, x = a.x + this.ox[i], gy = this.surfaceY(x);
    if (gy === Infinity) { this.state[i] = ST_FALL; this.x[i] = x; this.vx[i] = 0; this.vy[i] = 0; return; }   // the avatar moved away from under it
    this.x[i] = x; this.y[i] = gy - this.r[i] - this.oy[i];
    this.rot[i] += this.vr[i] * dt; this.vr[i] *= Math.max(0, 1 - 6 * dt);
    this.rest[i] -= dt;
    if (this.rest[i] <= 0 && this.fade[i] <= 0) this.fade[i] = RAIN_PHYS.fade;
  }

  private stepFall(i: number, dt: number) {
    const P = RAIN_PHYS, rng = this.rng, r = this.r[i];
    let vx = this.vx[i] * Math.max(0, 1 - 0.35 * dt), vy = Math.min(P.vmax, this.vy[i] + P.gravity * dt);
    const x = this.x[i] + vx * dt;
    let y = this.y[i] + vy * dt;
    this.rot[i] += this.vr[i] * dt;
    if (y - r > 1.15 || x < -0.35 || x > this.aspect + 0.35) { this.kill(i); return; }
    // landed emotes first (stacking)
    if (this.pile && y > -0.2) {
      for (let j = 0; j < this.cap; j++) {
        if (this.state[j] !== ST_REST || this.fade[j] > 0) continue;
        const dx = x - this.x[j], sum = r + this.r[j];
        if (Math.abs(dx) < sum * 0.8 && y + r > this.y[j] - this.r[j] * 0.2 && y < this.y[j]) {
          // sit on it, nudged away from the head so the pile spreads outward (and never ends up inside the head)
          const nx = x + (Math.abs(dx) < sum * 0.3 ? (x >= this.anchor.x ? 1 : -1) * r * 0.45 : 0), ny = this.y[j] - sum * 0.78;
          const g2 = this.surfaceY(nx);
          if (g2 !== Infinity && ny + r <= g2 + 1e-4) { this.land(i, nx, ny); return; }
        }
      }
    }
    const gy = this.surfaceY(x);
    if (gy !== Infinity && this.kind === 1 && y - gy > r * 0.25) {
      // came down beside the head (its centre is already under the top edge there): slide it out to the side instead of popping it up
      const a = this.anchor, side = x >= a.x ? 1 : -1, t = (y - a.y) / a.ry;
      const edge = a.rx * Math.sqrt(Math.max(0, 1 - t * t)) + r * 0.6;
      if (Math.abs(x - a.x) < edge) { this.x[i] = a.x + side * edge; this.y[i] = y; this.vx[i] = side * Math.max(0.12, Math.abs(vx) * 0.6); this.vy[i] = vy; return; }
    } else if (gy !== Infinity && y + r >= gy && y + r - gy < r * 1.7) {
      // normal of the surface (pointing out of it)
      let nx: number, ny: number;
      if (this.kind === 1) { const a = this.anchor; nx = (x - a.x) / (a.rx * a.rx); ny = (gy - a.y) / (a.ry * a.ry); }
      else { nx = this.slope; ny = -1; }
      const len = Math.hypot(nx, ny) || 1; nx /= len; ny /= len;
      const kind = this.kind;
      y = gy - r;
      const vn = vx * nx + vy * ny;
      if (vn < 0) {
        const e = kind === 1 ? P.headBounce : P.shoulderBounce;
        vx -= (1 + e) * vn * nx; vy -= (1 + e) * vn * ny;
        // friction along the surface: a shoulder grips (a landing mostly stays), a head is slicker
        const tx = -ny, ty = nx, vt = vx * tx + vy * ty, vn2 = vx * nx + vy * ny, keep = kind === 1 ? 0.8 : 0.4;
        vx = vn2 * nx + vt * keep * tx; vy = vn2 * ny + vt * keep * ty;
        this.vr[i] *= 0.6;
        if (kind === 1 && Math.abs(nx) < 0.15) vx += (rng() - 0.5) * 0.3;   // balanced on top of the head: roll off one side
      }
      if (kind === 2 && vx * vx + vy * vy < P.restSpeed * P.restSpeed) { this.land(i, x, y); return; }
    }
    this.x[i] = x; this.y[i] = y; this.vx[i] = vx; this.vy[i] = vy;
  }

  /** Come to rest at (x, y). Too high a pile: it just fades instead. */
  private land(i: number, x: number, y: number) {
    const a = this.anchor, gy = this.surfaceY(x);
    const oy = gy === Infinity ? 0 : Math.max(0, gy - this.r[i] - y);
    if (gy === Infinity) { this.x[i] = x; this.y[i] = y; this.vx[i] = 0; this.vy[i] = 0.2; return; }
    if (oy > RAIN_PHYS.pileMax) { this.x[i] = x; this.y[i] = y; this.vx[i] = (this.rng() < 0.5 ? -1 : 1) * 0.3; this.vy[i] = 0.1; if (this.fade[i] <= 0) this.fade[i] = RAIN_PHYS.fade; return; }
    this.state[i] = ST_REST; this.ox[i] = x - a.x; this.oy[i] = oy; this.x[i] = x; this.y[i] = y; this.vx[i] = 0; this.vy[i] = 0;
    this.rest[i] = RAIN_PHYS.restMin + this.rng() * RAIN_PHYS.restVar;
  }
}

// ---------------------------------------------------------------- the chat lane

export const LANE_BANDS = [0.1, 0.27, 0.44, 0.61, 0.78];
/** Each band has its own steady speed (frame heights per second), so two lines in one band never run into each other. */
const LANE_SPEED = [0.17, 0.2, 0.16, 0.19, 0.18];

/** Chat lines flying right to left. Fixed capacity, no allocation while stepping. */
export class FlyLane {
  readonly cap: number;
  readonly x: Float32Array; readonly y: Float32Array; readonly w: Float32Array; readonly h: Float32Array;
  readonly handle: Int32Array; readonly band: Uint8Array; readonly alive: Uint8Array;
  private n = 0;
  constructor(private rng: () => number = Math.random, cap: number = RAIN_LIMITS.laneLines) {
    this.cap = cap;
    this.x = new Float32Array(cap); this.y = new Float32Array(cap); this.w = new Float32Array(cap); this.h = new Float32Array(cap);
    this.handle = new Int32Array(cap); this.band = new Uint8Array(cap); this.alive = new Uint8Array(cap);
  }
  get active() { return this.n; }

  /** Start a line `w` wide and `h` high (frame heights). `avoid` = a band of y the line must not cross (the face, for "in front"). False = no free place. */
  add(handle: number, w: number, h: number, aspect: number, avoid?: { y0: number; y1: number } | null): boolean {
    let slot = -1;
    for (let i = 0; i < this.cap; i++) if (!this.alive[i]) { slot = i; break; }
    if (slot < 0) return false;
    const start = Math.floor(this.rng() * LANE_BANDS.length);
    for (let k = 0; k < LANE_BANDS.length; k++) {
      const b = (start + k) % LANE_BANDS.length, by = LANE_BANDS[b];
      if (avoid && by + h > avoid.y0 && by < avoid.y1) continue;
      let tail = -Infinity;
      for (let i = 0; i < this.cap; i++) if (this.alive[i] && this.band[i] === b) tail = Math.max(tail, this.x[i] + this.w[i]);
      if (tail > aspect - 0.05) continue;
      this.alive[slot] = 1; this.n++;
      this.x[slot] = aspect + 0.02; this.y[slot] = by; this.w[slot] = w; this.h[slot] = h; this.handle[slot] = handle; this.band[slot] = b;
      return true;
    }
    return false;
  }
  /** `gone(handle)` is called for every line that left the picture. */
  step(dt: number, gone?: (handle: number) => void) {
    if (!this.n) return;
    if (dt > 0.05) dt = 0.05;
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i]) continue;
      this.x[i] -= LANE_SPEED[this.band[i]] * dt;
      if (this.x[i] + this.w[i] < -0.02) { this.alive[i] = 0; this.n--; gone?.(this.handle[i]); }
    }
  }
  /** Remove lines (by handle test), e.g. a deleted message. */
  removeWhere(pred: (handle: number) => boolean, gone?: (handle: number) => void) {
    for (let i = 0; i < this.cap; i++) if (this.alive[i] && pred(this.handle[i])) { this.alive[i] = 0; this.n--; gone?.(this.handle[i]); }
  }
  clear(gone?: (handle: number) => void) { this.removeWhere(() => true, gone); }
}
