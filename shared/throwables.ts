// Throw & Bonk (beta.16, docs/b16/THROW.md): chat throws things at the streamer's head, the avatar flinches, a hand pats it.
// This file is the CONTRACT of the throw lane (src/scene/throw, src/avatar/hitReact.ts, src/ui/throwPanel.ts,
// server/routes/throwables.ts). No DOM, no file system, no network: the studio, the OBS pages, the helper and
// tools/throw_unit.ts all use the same code.
//
// How it plays (the same stamping as Slap!, shared/slap.ts): the host's studio writes a throw EVENT {seq, at, what, n, imgs, seed}
// into its stage-mode bag SceneState.modes.throw. Every page that shows the host's avatar (the studio preview, every OBS page)
// reads the event and plays the SAME choreography from (seed, at): item i leaves at at + i * gap, flies an arc to the head,
// hits (squash + star), falls away. Nothing needs per-page randomness, so two pages with the same event show the same throw.
//
// CUSTODY (AGENTS.md rule 7): a thrown picture is either a platform emote (a CDN picture from chat, never an arbitrary URL), a
// starter prop that ships with the app, or one of the HOST's own pictures (<data>/throwables). Nothing of anybody else's avatar or
// items is written anywhere. FLASH SAFETY: impact stars respect the room's flash limit (lights.safe, ≤ 3 per second).
import type { BusMessage } from './types.ts';
import { removedBy } from './chatRemove.ts';
import type { ChatEvent } from './chat.ts';

export const THROW_BAG = 'throw';
export const THROW_COMMAND = 'throw';

export const THROW_LIMITS = {
  /** Items alive at once on the pool (one instanced draw): more are dropped, never queued. */
  maxInFlight: 40,
  /** Items one throw may carry. */
  maxBarrage: 40,
  /** Different pictures one event carries (the bag is ≤ 6 KB). */
  maxImgs: 6,
  /** Events kept in the bag so a throw right after another is not lost on a slow page. */
  maxEvents: 3,
  /** The host's own pictures. */
  maxUserImages: 24,
  /** One of the host's own pictures (bytes). */
  maxImageBytes: 1024 * 1024,
  maxUrl: 180,
  bagBytes: 5500,
} as const;

/** Choreography clock. Seconds unless it says ms. */
export const THROW_T = {
  /** Host lead between the press and the first item leaving: the state reaches every page first. */
  leadMs: 600,
  /** Flight of one item (s): `flightMin` + rand * `flightVar`. */
  flightMin: 0.5, flightVar: 0.22,
  /** Gap between two items of one barrage (s); a big barrage is squeezed so it never lasts more than `barrageMax`. */
  gap: 0.09, barrageMax: 2.4,
  /** After the hit the item stays on the face this long (squashed), then falls. */
  stick: 0.14,
  /** Fall away (s). */
  fall: 0.95,
  /** Impact star life (s). */
  star: 0.45,
  /** Headpat / boop: the hand comes in, pats `pats` times, goes away. */
  patIn: 0.35, patEach: 0.34, patOut: 0.3,
  boopIn: 0.3, boopHold: 0.28, boopOut: 0.35,
  /** Flash limit: at most this many star flashes a second while the room's flash limit is on (WCAG 2.3.1). */
  flashPerSec: 3,
} as const;

export type ThrowWhat = 'emote' | 'prop' | 'image' | 'headpat';
export const THROW_WHATS: readonly ThrowWhat[] = ['emote', 'prop', 'image', 'headpat'];
export type ThrowFrom = 'chat' | 'raider' | 'redeemer';
export const THROW_FROMS: readonly ThrowFrom[] = ['chat', 'raider', 'redeemer'];

/** One picture an event throws. `emote`: a platform emote URL from chat; `prop`: a starter prop id; `image`: one of the host's own pictures. */
export type ThrowImg = { k: 'emote'; v: string } | { k: 'prop'; v: string } | { k: 'image'; v: string };

export interface ThrowEvent {
  /** Bumps on every throw. */
  seq: number;
  /** Start (epoch ms, host clock). */
  at: number;
  what: ThrowWhat;
  /** Items (1..40). A headpat is always 1. */
  n: number;
  /** The distinct pictures; item i shows imgs[pick(i)]. Empty = the page's default (a starter prop). */
  imgs: ThrowImg[];
  seed: number;
  /** '@host' = the host's own avatar (default); '*' = every performer who has not opted out; else a member key. */
  target: string;
}

export type ClickPat = 'off' | 'headpat' | 'boop';
export const CLICK_PATS: readonly ClickPat[] = ['off', 'headpat', 'boop'];

export interface ThrowBag {
  /** How hard the head snaps (0..1). */
  strength: number;
  /** Seconds the head takes to settle back. */
  returnSecs: number;
  /** Wait between the hit and the flinch (ms). */
  delayMs: number;
  /** A pained face while it hurts (needs a model with face shapes). */
  ouch: boolean;
  /** Impact stars (and the pat's hearts). */
  stars: boolean;
  /** Sound on the host's OBS page only (off by default, CC0 Kenney impacts). */
  sound: boolean;
  /** Items in one throw however large the gift (1..40). */
  maxBarrage: number;
  /** Bits (or Kicks) per extra item. */
  perBits: number;
  /** Extra items per gifted sub / TikTok gift. */
  perGift: number;
  /** Item size (0.5..2). */
  size: number;
  /** Clicking the avatar's head in the studio preview. */
  clickPat: ClickPat;
  /** Who is hit: the host only, or every performer in a party (each can opt out in their own studio). */
  who: 'me' | 'everyone';
  /** The latest throws, oldest first. */
  evs: ThrowEvent[];
}

export const DEFAULT_THROW: ThrowBag = {
  strength: 0.6, returnSecs: 0.7, delayMs: 60, ouch: true, stars: true, sound: false,
  maxBarrage: 20, perBits: 100, perGift: 1, size: 1, clickPat: 'off', who: 'me', evs: [],
};

// ---------------------------------------------------------------- the picture catalogue

export interface ThrowProp { id: string; label: string; file: string; /** relative size (1 = head width) */ size: number; /** hand props are used by headpat / boop only */ hand?: 'pat' | 'boop'; }
/** The starter props. All drawn for this app (CC0, assets/library/throwables/LICENSE.txt); the files are SVG pictures. */
export const THROW_PROPS: readonly ThrowProp[] = [
  { id: 'tomato', label: 'Tomato', file: 'tomato.svg', size: 0.8 },
  { id: 'cream-pie', label: 'Cream pie', file: 'cream-pie.svg', size: 1.1 },
  { id: 'rubber-duck', label: 'Rubber duck', file: 'rubber-duck.svg', size: 0.85 },
  { id: 'banana', label: 'Banana', file: 'banana.svg', size: 0.9 },
  { id: 'snowball', label: 'Snowball', file: 'snowball.svg', size: 0.7 },
  { id: 'boxing-glove', label: 'Boxing glove', file: 'boxing-glove.svg', size: 1 },
  { id: 'pillow', label: 'Pillow', file: 'pillow.svg', size: 1.1 },
  { id: 'heart', label: 'Heart', file: 'heart.svg', size: 0.75 },
  { id: 'bonk-bat', label: 'Bonk bat', file: 'bonk-bat.svg', size: 1.2 },
  { id: 'paper-plane', label: 'Paper plane', file: 'paper-plane.svg', size: 0.85 },
  { id: 'pat-hand', label: 'Headpat hand', file: 'pat-hand.svg', size: 1.5, hand: 'pat' },
  { id: 'boop-finger', label: 'Boop finger', file: 'boop-finger.svg', size: 1.3, hand: 'boop' },
  { id: 'star', label: 'Impact star', file: 'star.svg', size: 1 },
];
export const THROW_THROWN: readonly ThrowProp[] = THROW_PROPS.filter((p) => !p.hand && p.id !== 'star');
export const THROW_PROP_BY_ID: ReadonlyMap<string, ThrowProp> = new Map(THROW_PROPS.map((p) => [p.id, p]));

const PROP_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const USER_ID = /^u-[a-f0-9]{16}$/;
const SEED = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.abs(Math.floor(v)) % 2147483647 : 1);
const TARGET = /^(@host|\*|[a-z0-9]{6,32}|lib:[A-Za-z0-9_-]{1,48})$/;

/**
 * Only the platforms' own emote pictures may be thrown: https on an emote CDN (the same hosts the helper's picture proxy
 * allows, server/routes/chat.ts IMG_HOSTS, minus video thumbnails). Anything else a chat line might carry
 * (a link, a data: URL, a tracker) is refused here, before it can reach a page.
 */
export const EMOTE_HOSTS = /^(files\.kick\.com|cdn\.7tv\.app|cdn\.betterttv\.net|cdn\.frankerfacez\.com|static-cdn\.jtvnw\.net|[\w-]+\.ggpht\.com|[\w-]+\.googleusercontent\.com|[\w-]+\.tiktokcdn(-us)?\.com|[\w-]+\.rumble\.com|rumble\.com)$/i;
export function isEmoteUrl(u: unknown): u is string {
  if (typeof u !== 'string' || u.length < 8 || u.length > THROW_LIMITS.maxUrl || /[\s"'<>\\]/.test(u)) return false;
  const m = /^https:\/\/([\w.-]+)(?::\d+)?\/[^\s"'<>\\]*$/.exec(u);
  return !!m && EMOTE_HOSTS.test(m[1]);
}
/** The URL a page loads an emote from: remote pictures go through the helper's allow-listed proxy so canvases stay untainted. */
export const emoteSrc = (u: string) => `/api/chat/img?u=${encodeURIComponent(u)}`;

export function sanitizeThrowImg(o: unknown, hand = false): ThrowImg | null {
  const x = rec(o);
  if (x.k === 'emote') return !hand && isEmoteUrl(x.v) ? { k: 'emote', v: x.v } : null;
  if (x.k === 'prop') {
    const p = typeof x.v === 'string' && PROP_ID.test(x.v) ? THROW_PROP_BY_ID.get(x.v) : undefined;
    // thrown things are the plain props; the hand props (pat, boop) belong to a headpat only; the star is never an item
    return p && p.id !== 'star' && !!p.hand === hand ? { k: 'prop', v: p.id } : null;
  }
  if (x.k === 'image') return !hand && typeof x.v === 'string' && USER_ID.test(x.v) ? { k: 'image', v: x.v } : null;
  return null;
}
const imgKey = (i: ThrowImg) => `${i.k}:${i.v}`;

// ---------------------------------------------------------------- sanitising

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

export function sanitizeThrowEvent(o: unknown): ThrowEvent | null {
  const x = rec(o);
  const what = (THROW_WHATS as readonly unknown[]).includes(x.what) ? x.what as ThrowWhat : null;
  if (!what || typeof x.at !== 'number' || !Number.isFinite(x.at) || x.at <= 0 || typeof x.seq !== 'number' || !Number.isFinite(x.seq) || x.seq < 0) return null;
  const imgs: ThrowImg[] = [], seen = new Set<string>();
  for (const v of Array.isArray(x.imgs) ? x.imgs : []) {
    const i = sanitizeThrowImg(v, what === 'headpat');
    if (i && !seen.has(imgKey(i)) && imgs.length < THROW_LIMITS.maxImgs) { seen.add(imgKey(i)); imgs.push(i); }
  }
  return {
    seq: Math.floor(x.seq), at: x.at, what, n: what === 'headpat' ? 1 : Math.round(num(x.n, 1, THROW_LIMITS.maxBarrage, 1)), imgs, seed: SEED(x.seed),
    target: typeof x.target === 'string' && TARGET.test(x.target) ? x.target : '@host',
  };
}

/** Cut the oldest events until the bag fits (a mode bag is ≤ 6 KB). */
export function fitEvents(evs: ThrowEvent[]): ThrowEvent[] {
  const out = evs.slice(-THROW_LIMITS.maxEvents);
  while (out.length > 1 && JSON.stringify(out).length > THROW_LIMITS.bagBytes) out.shift();
  return out;
}

export function sanitizeThrow(o: unknown): ThrowBag {
  const x = rec(o), d = DEFAULT_THROW;
  const evs: ThrowEvent[] = [];
  for (const v of Array.isArray(x.evs) ? x.evs : []) { const e = sanitizeThrowEvent(v); if (e) evs.push(e); }
  return {
    strength: num(x.strength, 0, 1, d.strength), returnSecs: num(x.returnSecs, 0.15, 2.5, d.returnSecs), delayMs: Math.round(num(x.delayMs, 0, 500, d.delayMs)),
    ouch: bool(x.ouch, d.ouch), stars: bool(x.stars, d.stars), sound: bool(x.sound, d.sound),
    maxBarrage: Math.round(num(x.maxBarrage, 1, THROW_LIMITS.maxBarrage, d.maxBarrage)), perBits: Math.round(num(x.perBits, 1, 100000, d.perBits)), perGift: num(x.perGift, 0.1, 40, d.perGift),
    size: num(x.size, 0.5, 2, d.size),
    clickPat: (CLICK_PATS as readonly unknown[]).includes(x.clickPat) ? x.clickPat as ClickPat : d.clickPat,
    who: x.who === 'everyone' ? 'everyone' : 'me',
    evs: fitEvents(evs.sort((a, b) => a.seq - b.seq)),
  };
}

/** Guest studios: the host's clock → ours. (The scene controller only shifts the bags it knows; pages also fall back to `eventStart`.) */
export function shiftThrowClock(modes: Record<string, unknown> | undefined, off: number) {
  const b = modes?.[THROW_BAG] as { evs?: { at?: unknown }[] } | undefined;
  if (Array.isArray(b?.evs)) for (const e of b!.evs!) if (e && typeof e.at === 'number' && Number.isFinite(e.at)) e.at += off;
}

/**
 * When does a page start an event? On the host's clock when ours agrees (within 4 s), else ("a guest whose clock was not
 * shifted") now plus the lead that is left when it arrived, so a throw is never lost or replayed hours late.
 */
export function eventStart(at: number, now: number, firstSeen: number): number {
  return Math.abs(at - now) <= 4000 ? at : firstSeen + THROW_T.leadMs;
}
/** Seconds an event lasts from its start (all items gone). */
export function eventSecs(e: Pick<ThrowEvent, 'what' | 'n'>): number {
  if (e.what === 'headpat') return patSecs('pat') + 0.2;
  return barrageSpan(e.n) + THROW_T.flightMin + THROW_T.flightVar + THROW_T.stick + THROW_T.fall + 0.2;
}
/** A stale event (a reloaded page seeing an old stamp) is not played. */
export const eventLive = (e: Pick<ThrowEvent, 'what' | 'n'>, start: number, now: number) => now < start + eventSecs(e) * 1000;

/** Who gets hit on THIS page? `self` is the page's own performer ('@host' on the host's pages), `optOut` the performer's own switch. */
export function throwMayApply(target: string | undefined, self: string, optOut: boolean): boolean {
  const t = target ?? '@host';
  if (t === '@host') return self === '@host';
  if (t === '*') return self === '@host' || !optOut;
  return t === self && !optOut;
}

// ---------------------------------------------------------------- how many, and which pictures

/** Items for a happening: the rule's own count, raised by bits / Kicks (one per `perBits`) or gifted subs / TikTok gifts, capped. */
export function barrageCount(base: number, ev: { kind?: string; amount?: number; fkind?: string; count?: number; coins?: number; viewers?: number } | null | undefined, cfg: Pick<ThrowBag, 'perBits' | 'perGift' | 'maxBarrage'>): number {
  let n = Number.isFinite(base) ? Math.round(base) : 1;
  if (ev) {
    if (ev.kind === 'money' && (ev.fkind === 'bits' || ev.fkind === 'kicks') && typeof ev.amount === 'number') n = Math.max(n, Math.floor(ev.amount / Math.max(1, cfg.perBits)));
    else if (ev.kind === 'giftSub' && typeof ev.count === 'number') n = Math.max(n, Math.round(ev.count * cfg.perGift));
    else if (ev.kind === 'tiktokGift' && typeof ev.coins === 'number') n = Math.max(n, Math.round(Math.max(1, ev.count ?? 1) * cfg.perGift));
    else if (ev.kind === 'raid' && typeof ev.viewers === 'number') n = Math.max(n, Math.round(Math.sqrt(Math.max(0, ev.viewers)) * 1.5));
  }
  return Math.min(THROW_LIMITS.maxBarrage, Math.max(1, Math.min(cfg.maxBarrage, n)));
}

/** A recent emote from a chat line (kept in RAM by the studio's mount, never saved). */
export interface SeenEmote { url: string; user: string; at: number; id: string }
/** The emotes of a chat line: only platform pictures (isEmoteUrl), zero-width overlays skipped. */
export function emotesOf(c: Pick<ChatEvent, 'kind' | 'parts' | 'user' | 'id' | 'ts' | 'test'>): SeenEmote[] {
  if (c.kind !== 'chat' || !c.parts) return [];
  const out: SeenEmote[] = [];
  for (const p of c.parts) if (p.t === 'emote' && !p.zw && isEmoteUrl(p.u)) out.push({ url: p.u, user: c.user, at: c.ts, id: c.id });
  return out;
}

/** The studio's memory of what chat sent lately: a small ring, newest last. Removed (deleted / purged) lines drop out. */
export class EmoteRing {
  private list: SeenEmote[] = [];
  constructor(private readonly max = 120, private readonly maxAgeMs = 10 * 60_000) {}
  get size() { return this.list.length; }
  add(c: ChatEvent) {
    if (c.test) return;
    const es = emotesOf(c);
    if (!es.length) return;
    this.list.push(...es);
    if (this.list.length > this.max) this.list.splice(0, this.list.length - this.max);
  }
  /** A moderation event: forget what the removed line(s) sent. */
  remove(rm: Pick<ChatEvent, 'kind' | 'platform' | 'target' | 'uid'>, lines: ReadonlyMap<string, Pick<ChatEvent, 'id' | 'kind' | 'platform' | 'user' | 'uid'>>) {
    this.list = this.list.filter((e) => { const l = lines.get(e.id); return !(l && removedBy(rm, l)); });
  }
  /** Distinct pictures, newest first. `user` = only that person's (case-insensitive). */
  recent(opt: { user?: string; now?: number; limit?: number } = {}): string[] {
    const now = opt.now ?? Date.now(), u = opt.user?.trim().toLowerCase();
    const out: string[] = [], seen = new Set<string>();
    for (let i = this.list.length - 1; i >= 0 && out.length < (opt.limit ?? THROW_LIMITS.maxImgs); i--) {
      const e = this.list[i];
      if (now - e.at > this.maxAgeMs || (u && e.user.toLowerCase() !== u) || seen.has(e.url)) continue;
      seen.add(e.url); out.push(e.url);
    }
    return out;
  }
  clear() { this.list = []; }
}

export interface ThrowRequest {
  what?: unknown; count?: unknown; item?: unknown; from?: unknown;
}
/** What the pictures of a request are: emotes (falling back to props when chat sent none), a prop or the host's own picture. */
export function pickImgs(what: ThrowWhat, item: string, emotes: readonly string[], seed: number): { imgs: ThrowImg[]; what: ThrowWhat; fellBack: boolean } {
  if (what === 'headpat') return { imgs: [{ k: 'prop', v: item === 'boop-finger' ? 'boop-finger' : 'pat-hand' } as ThrowImg], what, fellBack: false };
  if (what === 'image') {
    if (USER_ID.test(item)) return { imgs: [{ k: 'image', v: item }], what, fellBack: false };
    return { imgs: [], what, fellBack: false };       // the page throws the host's pictures at random (the caller fills the list)
  }
  if (what === 'prop') {
    const p = THROW_PROP_BY_ID.get(item);
    if (p && !p.hand && p.id !== 'star') return { imgs: [{ k: 'prop', v: p.id }], what, fellBack: false };
    const pool = THROW_THROWN, a = pool[Math.floor(throwRand(seed, 3) * pool.length) % pool.length], b = pool[Math.floor(throwRand(seed, 4) * pool.length) % pool.length];
    return { imgs: a.id === b.id ? [{ k: 'prop', v: a.id }] : [{ k: 'prop', v: a.id }, { k: 'prop', v: b.id }], what, fellBack: false };
  }
  const em = emotes.filter(isEmoteUrl).slice(0, THROW_LIMITS.maxImgs);
  if (em.length) return { imgs: em.map((v): ThrowImg => ({ k: 'emote', v })), what, fellBack: false };
  // chat has sent no emotes lately: throw props instead (and say so)
  return { ...pickImgs('prop', '', [], seed), what: 'prop', fellBack: true };
}

/** Build the next event for a bag (the caller writes it back). `now` = host clock. */
export function stampThrow(bag: ThrowBag, req: { what: ThrowWhat; n: number; imgs: ThrowImg[]; seed?: number; target?: string }, now = Date.now()): ThrowBag {
  const last = bag.evs[bag.evs.length - 1];
  const seq = (last?.seq ?? 0) + 1;
  const target = req.target && TARGET.test(req.target) ? req.target : bag.who === 'everyone' ? '*' : '@host';
  // two throws never start inside each other's lead: the next waits for the previous one's first item to be on its way
  const earliest = last ? Math.max(0, last.at - now + 120) : 0;
  const e: ThrowEvent = {
    seq, at: now + THROW_T.leadMs + (earliest > 0 && earliest < 1500 ? earliest : 0), what: req.what,
    n: req.what === 'headpat' ? 1 : Math.round(Math.min(THROW_LIMITS.maxBarrage, Math.max(1, req.n))), imgs: req.imgs.slice(0, THROW_LIMITS.maxImgs),
    seed: req.seed !== undefined ? SEED(req.seed) : ((Math.random() * 2147483646) | 0) + 1, target,
  };
  return { ...bag, evs: fitEvents([...bag.evs, e]) };
}

/** Events a page has not played yet (seq above its high-water mark), oldest first. */
export function unseenEvents(bag: ThrowBag, lastSeq: number): ThrowEvent[] { return bag.evs.filter((e) => e.seq > lastSeq); }

// ---------------------------------------------------------------- the choreography (pure: a function of the seed and the clock)

/** Deterministic 0..1 from a seed and a salt: every page picks the same. */
export function throwRand(seed: number, salt: number): number {
  let x = (Math.imul(seed | 0, 374761393) + Math.imul(salt | 0, 668265263)) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** Seconds from the start to the LAST item leaving (a big barrage is squeezed to `barrageMax`). */
export function barrageSpan(n: number): number { return n <= 1 ? 0 : Math.min(THROW_T.barrageMax, (n - 1) * THROW_T.gap); }
export const patSecs = (kind: 'pat' | 'boop', pats = 3): number => (kind === 'pat' ? THROW_T.patIn + pats * THROW_T.patEach + THROW_T.patOut : THROW_T.boopIn + THROW_T.boopHold + THROW_T.boopOut);

/** Which picture item i shows (index into the event's imgs, -1 = none). */
export function imgIndex(e: Pick<ThrowEvent, 'seed' | 'imgs'>, i: number): number {
  const k = e.imgs.length;
  return k ? (k === 1 ? 0 : Math.floor(throwRand(e.seed, 100 + i) * k) % k) : -1;
}

/**
 * One item's plan (all lengths are in HEAD SIZES from the head centre: +x = the viewer's right, +y up, +z toward the viewer).
 * `leave` = seconds after the event's start, `flight` = seconds in the air.
 */
export interface ItemPlan {
  i: number; img: number;
  leave: number; flight: number;
  sx: number; sy: number; sz: number;     // where it comes from
  ex: number; ey: number; ez: number;     // where it hits (on the face)
  arc: number; spin: number; spin0: number;
  /** After the hit: sideways and up speed (head sizes / s) and the way it spins. */
  vx: number; vy: number; tumble: number;
  size: number;
}
export function planItem(e: Pick<ThrowEvent, 'seed' | 'imgs' | 'n'>, i: number, sizeScale = 1): ItemPlan {
  const r = (salt: number) => throwRand(e.seed, i * 17 + salt);
  const n = Math.max(1, e.n), gap = n <= 1 ? 0 : Math.min(THROW_T.gap, THROW_T.barrageMax / (n - 1));
  const side = r(1) < 0.5 ? -1 : 1;
  const img = imgIndex(e, i);
  const prop = img >= 0 && e.imgs[img].k === 'prop' ? THROW_PROP_BY_ID.get(e.imgs[img].v) : undefined;
  const flight = THROW_T.flightMin + r(2) * THROW_T.flightVar;
  const ex = (r(5) - 0.5) * 0.7, ey = (r(6) - 0.5) * 0.55 + 0.05;
  return {
    i, img, leave: i * gap + r(3) * 0.03, flight,
    sx: side * (3.4 + r(4) * 2.2), sy: 0.6 + r(7) * 3.2, sz: 1.6 + r(8) * 1.4,
    ex, ey, ez: 0.55,
    arc: 0.7 + r(9) * 1.1, spin: (r(10) - 0.5) * 16, spin0: r(11) * Math.PI * 2,
    vx: -side * (0.5 + r(12) * 1.3) + (r(13) - 0.5) * 0.4, vy: 1.4 + r(14) * 1.6, tumble: (r(15) - 0.5) * 10,
    size: (0.5 + (prop ? 0.5 * prop.size : 0.18)) * sizeScale,
  };
}

export type ItemPhase = 'wait' | 'fly' | 'stick' | 'fall' | 'done';
export interface ItemPose { phase: ItemPhase; x: number; y: number; z: number; rot: number; sx: number; sy: number; alpha: number; /** 0..1 since the hit (stick+fall), else -1 */ since: number }
const smooth = (u: number) => u * u * (3 - 2 * u);
const clamp01 = (u: number) => (u < 0 ? 0 : u > 1 ? 1 : u);
export const THROW_GRAVITY = 7.5;

/** Where item `p` is at `t` seconds after the event's start. Pure; writes into `out` (no allocation per frame). */
export function itemPose(p: ItemPlan, t: number, out: ItemPose): ItemPose {
  const tt = t - p.leave;
  out.sx = 1; out.sy = 1; out.alpha = 1; out.since = -1;
  if (tt < 0) { out.phase = 'wait'; out.alpha = 0; out.x = p.sx; out.y = p.sy; out.z = p.sz; out.rot = p.spin0; return out; }
  if (tt < p.flight) {
    const u = tt / p.flight, v = u * u * 0.35 + u * 0.65;                 // a little speed-up into the hit
    out.phase = 'fly';
    out.x = p.sx + (p.ex - p.sx) * v; out.z = p.sz + (p.ez - p.sz) * v;
    out.y = p.sy + (p.ey - p.sy) * v + 4 * p.arc * u * (1 - u);
    out.rot = p.spin0 + p.spin * tt;
    const grow = 0.75 + 0.25 * smooth(clamp01(u * 3));
    out.sx = grow; out.sy = grow; out.alpha = clamp01(u * 8);
    return out;
  }
  const h = tt - p.flight;                                                // seconds since the hit
  const rotHit = p.spin0 + p.spin * p.flight;
  if (h < THROW_T.stick) {
    const k = h / THROW_T.stick;                                          // squash flat against the face, then spring back
    const sq = Math.sin(Math.min(1, k * 1.4) * Math.PI) * 0.45;
    out.phase = 'stick'; out.x = p.ex; out.y = p.ey; out.z = p.ez; out.rot = rotHit * (1 - k * 0.2);
    out.sx = 1 + sq * 1.1; out.sy = 1 - sq; out.since = h / (THROW_T.stick + THROW_T.fall);
    return out;
  }
  const f = h - THROW_T.stick;
  if (f >= THROW_T.fall) { out.phase = 'done'; out.alpha = 0; out.x = p.ex; out.y = p.ey; out.z = p.ez; out.rot = rotHit; out.since = 1; return out; }
  out.phase = 'fall';
  out.x = p.ex + p.vx * f; out.y = p.ey + p.vy * f - 0.5 * THROW_GRAVITY * f * f; out.z = p.ez + 0.4 * f;
  out.rot = rotHit + p.tumble * f;
  out.alpha = 1 - smooth(clamp01((f / THROW_T.fall - 0.55) / 0.45));
  out.since = (THROW_T.stick + f) / (THROW_T.stick + THROW_T.fall);
  return out;
}

/** Seconds after the event's start when item i hits. */
export const hitTime = (p: ItemPlan) => p.leave + p.flight;

/**
 * The hit's push on the head: the direction the item was travelling (screen plane, unit-ish) and a size 0..1 (a pie hits harder
 * than a heart). Thrown from the right, the head snaps to the left and tips.
 */
export function hitImpulse(p: ItemPlan): { dx: number; dy: number; power: number } {
  const dx = p.ex - p.sx, dy = p.ey - p.sy, l = Math.hypot(dx, dy) || 1;
  return { dx: dx / l, dy: dy / l, power: Math.min(1, 0.45 + p.size * 0.6) };
}

/** An impact star: grows out of the hit and fades. Same clock as the item. */
export interface StarPose { alive: boolean; x: number; y: number; z: number; size: number; alpha: number; rot: number }
export function starPose(p: ItemPlan, t: number, out: StarPose, flashSafe: boolean): StarPose {
  const h = t - hitTime(p);
  if (h < 0 || h >= THROW_T.star) { out.alive = false; out.alpha = 0; return out; }
  const k = h / THROW_T.star;
  out.alive = true; out.x = p.ex + 0.12 * Math.sign(p.sx) * -1 * k; out.y = p.ey + 0.18 + 0.25 * k; out.z = p.ez + 0.15;
  // flash-safe: no pop, a soft low-alpha fade (a star never strobes either way: one slow fade per hit)
  out.size = flashSafe ? 0.55 + 0.25 * k : 0.4 + 0.9 * Math.sin(Math.min(1, k * 2.2) * Math.PI * 0.5);
  out.alpha = (flashSafe ? 0.7 : 1) * (1 - smooth(clamp01((k - 0.35) / 0.65)));
  out.rot = p.spin0 * 0.2 + k * 1.2;
  return out;
}

/**
 * Flash limit for the stars: which hits may show one while the room's flash limit is on. Hits are in time order; at most
 * `THROW_T.flashPerSec` stars start in any one-second window. (Without the limit every hit shows its star.)
 */
export function starHits(hits: readonly number[], flashSafe: boolean): boolean[] {
  const shown: number[] = [], out: boolean[] = [];
  for (const h of hits) {
    if (!flashSafe) { out.push(true); continue; }
    let c = 0;
    for (let i = shown.length - 1; i >= 0 && h - shown[i] < 1; i--) c++;
    if (c < THROW_T.flashPerSec) { shown.push(h); out.push(true); } else out.push(false);
  }
  return out;
}

// ---------------------------------------------------------------- headpat / boop

export interface HandPose { alive: boolean; x: number; y: number; z: number; rot: number; sx: number; sy: number; alpha: number }
/** Seconds after the start of each contact (a pat lands, or the boop touches), for the head to dip / jolt. */
export function contactTimes(kind: 'pat' | 'boop', pats = 3): number[] {
  if (kind === 'boop') return [THROW_T.boopIn];
  return Array.from({ length: pats }, (_, k) => THROW_T.patIn + (k + 0.5) * THROW_T.patEach);
}
/** The hand at `t` seconds. Head sizes from the head centre. A pat: comes in from the right above the head, taps down `pats` times, leaves. A boop: a finger from the front pokes once. */
export function handPose(kind: 'pat' | 'boop', t: number, out: HandPose, pats = 3): HandPose {
  const total = patSecs(kind, pats);
  out.sx = 1; out.sy = 1; out.alpha = 1; out.alive = t >= 0 && t < total;
  if (!out.alive) { out.alpha = 0; out.x = 0; out.y = 0; out.z = 0.7; out.rot = 0; return out; }
  if (kind === 'pat') {
    const topY = 0.95;
    if (t < THROW_T.patIn) { const u = smooth(t / THROW_T.patIn); out.x = 2.2 * (1 - u) + 0.1 * u; out.y = topY + 1.4 * (1 - u); out.rot = -0.5 * (1 - u); out.alpha = clamp01(u * 4); }
    else if (t < THROW_T.patIn + pats * THROW_T.patEach) {
      const k = ((t - THROW_T.patIn) % THROW_T.patEach) / THROW_T.patEach;     // 0..1 inside one pat: down on the first half, up on the second
      const down = Math.sin(Math.PI * k);
      out.x = 0.1; out.y = topY + 0.25 - 0.4 * down; out.rot = -0.08 * down; out.sy = 1 - 0.1 * down;
    } else { const u = smooth((t - THROW_T.patIn - pats * THROW_T.patEach) / THROW_T.patOut); out.x = 0.1 + 2.2 * u; out.y = topY + 0.25 + 1.2 * u; out.rot = -0.5 * u; out.alpha = 1 - clamp01(u * 1.2); }
    out.z = 0.7;
    return out;
  }
  // boop: a finger from the lower right toward the nose, holds, backs off
  const aim = { x: 0.05, y: -0.05 };
  let u: number;
  if (t < THROW_T.boopIn) u = smooth(t / THROW_T.boopIn);
  else if (t < THROW_T.boopIn + THROW_T.boopHold) u = 1;
  else u = 1 - smooth((t - THROW_T.boopIn - THROW_T.boopHold) / THROW_T.boopOut);
  out.x = aim.x + 1.6 * (1 - u); out.y = aim.y - 1.1 * (1 - u); out.z = 0.9; out.rot = 0.6 * (1 - u) + 0.15;
  out.alpha = clamp01(u * 5);
  return out;
}

// ---------------------------------------------------------------- the head's spring (pure)

/** A damped spring on three head angles (rad: pitch, yaw, roll). Critically-under-damped, settles in about `returnSecs`. */
export interface Flinch { p: number; y: number; r: number; vp: number; vy: number; vr: number }
export const newFlinch = (): Flinch => ({ p: 0, y: 0, r: 0, vp: 0, vy: 0, vr: 0 });
export const FLINCH_ZETA = 0.42;
/** Natural frequency (rad/s) so the 2 % settling time (4 / (ζω)) is `returnSecs`. */
export const flinchOmega = (returnSecs: number) => 4 / (FLINCH_ZETA * Math.max(0.1, returnSecs));
/** Largest angle (rad) the head may be pushed from rest. */
export const FLINCH_MAX = 0.52;
/** Kick the spring: the hit travelled along (dx, dy) on screen (+x = viewer's right, +y up); `power` 0..1; `strength` 0..1 is the setting. */
export function kickFlinch(f: Flinch, dx: number, dy: number, power: number, strength: number, returnSecs: number) {
  const k = (0.35 + 1.65 * strength) * power, w = flinchOmega(returnSecs);
  // peak angle of an impulse of speed v on this spring ≈ v / (ω·√e^…) – we pick v so a strength-1, power-1 hit peaks ≈ 0.38 rad (22°)
  const v = 0.38 * w * 1.5 * (k / 2);
  f.vy += dx * v * 0.8;            // pushed toward the viewer's left (dx < 0): the face turns that way (yaw about +Y: + = toward the viewer's right)
  f.vr += -dx * v * 0.55;          // …and the top of the head tips the same way (roll about +Z: + = top toward the viewer's left)
  f.vp += (dy < 0 ? 1 : -1) * Math.abs(dy) * v * 0.7 - v * 0.25;  // a hit from above nods the head down (+ = chin down); the push into the face rocks it back a touch
}
/** Step with substeps for stability. Returns the largest |angle|. */
export function stepFlinch(f: Flinch, dt: number, returnSecs: number): number {
  const w = flinchOmega(returnSecs), z = FLINCH_ZETA;
  let left = Math.min(dt, 0.1);
  while (left > 1e-6) {
    const h = Math.min(left, 1 / 240);
    f.vp += (-w * w * f.p - 2 * z * w * f.vp) * h; f.p += f.vp * h;
    f.vy += (-w * w * f.y - 2 * z * w * f.vy) * h; f.y += f.vy * h;
    f.vr += (-w * w * f.r - 2 * z * w * f.vr) * h; f.r += f.vr * h;
    left -= h;
  }
  f.p = Math.max(-FLINCH_MAX, Math.min(FLINCH_MAX, f.p)); f.y = Math.max(-FLINCH_MAX, Math.min(FLINCH_MAX, f.y)); f.r = Math.max(-FLINCH_MAX, Math.min(FLINCH_MAX, f.r));
  return Math.max(Math.abs(f.p), Math.abs(f.y), Math.abs(f.r));
}
/** At rest: angles and speeds under these = the spring is asleep (the hook costs nothing again). */
export const flinchAsleep = (f: Flinch) => Math.max(Math.abs(f.p), Math.abs(f.y), Math.abs(f.r)) < 0.0015 && Math.max(Math.abs(f.vp), Math.abs(f.vy), Math.abs(f.vr)) < 0.01;
/** The pained face's strength 0..1 from the head's displacement (and a floor while it still moves). */
export const ouchAmount = (maxAngle: number) => clamp01(maxAngle / 0.2);

// ---------------------------------------------------------------- sound

/** CC0 Kenney impact sounds (assets/library/sounds/kenney_impact), by item weight. */
export const THROW_SOUNDS = {
  soft: ['impactSoft_medium_000', 'impactSoft_medium_001', 'impactSoft_heavy_000'],
  hard: ['impactPunch_medium_000', 'impactPunch_heavy_000', 'impactWood_heavy_001'],
} as const;
export const throwSoundName = (seed: number, i: number, hard: boolean): string => {
  const l = hard ? THROW_SOUNDS.hard : THROW_SOUNDS.soft;
  return l[Math.floor(throwRand(seed, 300 + i) * l.length) % l.length];
};
export const isHardProp = (id: string) => id === 'boxing-glove' || id === 'bonk-bat';

// ---------------------------------------------------------------- the deck / rule request

export const throwBusMessage = (args: { what: ThrowWhat; count?: number; item?: string; from?: ThrowFrom }): BusMessage => ({ type: 'command', command: THROW_COMMAND, args });

export interface ThrowArgs { what: ThrowWhat; count: number; item: string; from: ThrowFrom }
/** The deck action's args (shared/deck.ts plans them: what, count, item, from), cleaned. */
export function sanitizeThrowArgs(o: unknown): ThrowArgs {
  const x = rec(o);
  const item = typeof x.item === 'string' && (PROP_ID.test(x.item) || USER_ID.test(x.item)) ? x.item : '';
  return {
    what: (THROW_WHATS as readonly unknown[]).includes(x.what) ? x.what as ThrowWhat : 'emote',
    count: Math.round(num(x.count, 1, THROW_LIMITS.maxBarrage, 1)), item,
    from: (THROW_FROMS as readonly unknown[]).includes(x.from) ? x.from as ThrowFrom : 'chat',
  };
}

// ---------------------------------------------------------------- the host's own pictures (server/routes/throwables.ts)

export interface UserThrowable { id: string; name: string; type: 'image/png' | 'image/gif' | 'image/webp'; bytes: number }
export function sanitizeUserThrowables(o: unknown): UserThrowable[] {
  const out: UserThrowable[] = [];
  for (const v of Array.isArray(o) ? o : []) {
    const x = rec(v);
    if (typeof x.id !== 'string' || !USER_ID.test(x.id) || out.some((u) => u.id === x.id)) continue;
    const type = x.type === 'image/gif' || x.type === 'image/webp' ? x.type : 'image/png';
    out.push({ id: x.id, name: cleanName(x.name), type, bytes: Math.round(num(x.bytes, 0, THROW_LIMITS.maxImageBytes, 0)) });
    if (out.length >= THROW_LIMITS.maxUserImages) break;
  }
  return out;
}
export const cleanName = (v: unknown): string => (typeof v === 'string' ? v.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[^\p{L}\p{N} _().-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40) : '') || 'My picture';
/** What kind of picture these first bytes are (PNG, GIF, WebP) – the helper checks it, never the file's name. */
export function sniffThrowImage(b: Uint8Array): UserThrowable['type'] | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}
export const userImageUrl = (id: string) => `/api/throwables/file/${id}`;
export const propUrl = (id: string) => `/api/throwables/starter/${THROW_PROP_BY_ID.get(id)?.file ?? 'tomato.svg'}`;
/** The URL a page draws a picture from. */
export const imgSrc = (i: ThrowImg): string => (i.k === 'emote' ? emoteSrc(i.v) : i.k === 'prop' ? propUrl(i.v) : userImageUrl(i.v));
