// Lounge events (docs/SCENES.md → "Lounge events") — donations and gifted subs celebrated in a hangout room's bar, patio
// (firepit) and main lounge. The contract shared by the studio (Scene tab, bus command, Stream Deck, Ctrl+K) and every
// page (src/scene/lounge/*).
//
// Rooms opt in with a scene.json `lounge` key (RoomLoungeConfig; per area too, docs/SCENES.md "Areas"). The host owns a
// stage-mode bag SceneState.modes.lounge (like modes.yacht / modes.slap): switches, tier thresholds and the last few test /
// bus stamps {seq, at (host clock), src, usd, n, user, seed}; guests' controllers shift `at` into their own clock.
// Support events (chat feed finance events) never go through the bag: every page sees the same ChatEvents (ts + id) and
// turns them into the same schedule with the pure helpers below, so the studio preview, the host's OBS and every party
// guest's OBS celebrate the same supporter with the same drinks, rockets and balloons. Nothing here uses Math.random.
import { yachtHash, yachtRand } from './yacht.ts';

export const LOUNGE_BAG = 'lounge';

export type LoungeZone = 'main' | 'bar' | 'patio';
export const LOUNGE_ZONES: LoungeZone[] = ['main', 'bar', 'patio'];
/** Where a support event came from: money (tips, Super Chats, bits, Kicks … → USD), gifted subs (count), a sub, a raid. */
export type LoungeSource = 'money' | 'gift' | 'sub' | 'raid';
const SOURCES = new Set<string>(['money', 'gift', 'sub', 'raid']);
export type LoungeTier = 0 | 1 | 2 | 3 | 4 | 5;

/** Default tier lines: one support event's USD value (money) / its gift count (gifted subs) → tier 1…5 (cumulative). */
export const DEFAULT_LOUNGE_MONEY = [1, 5, 20, 50, 100] as const;
export const DEFAULT_LOUNGE_GIFTS = [1, 5, 10, 20, 50] as const;
/** Gifts at or above this count also run the GIFT TRAIN (one drink / balloon / rocket per gift). */
export const DEFAULT_LOUNGE_TRAIN = 10;
/** Most items one train draws (the banner still says ×N). */
export const LOUNGE_TRAIN_CAP = 60;
/** Host lead (ms) between the button / the chat event and the start (the state reaches every page). */
export const LOUNGE_LEAD = 900;

export const LOUNGE_TIER_LABELS: Record<Exclude<LoungeTier, 0>, string> = { 1: 'Cheers', 2: 'Round on the house', 3: 'Party time', 4: 'Big spender', 5: 'Legend' };
/** What each tier does, per area (the Scene tab's help + the docs). */
export const LOUNGE_TIER_HELP: Record<LoungeZone, Record<Exclude<LoungeTier, 0>, string>> = {
  bar: { 1: 'a drink slides down the counter', 2: '+ a round of shots', 3: '+ the bottle wall lights up, bar sparklers', 4: '+ champagne at the bar, rainbow bottle wall, room-wide', 5: '+ a second round, the long chase' },
  patio: { 1: 'the firepit flares up', 2: '+ a big flare, sparklers', 3: '+ fireworks (sky flashes by day)', 4: '+ the full show, a towering flare, room-wide', 5: '+ the finale (gold willows)' },
  main: { 1: 'a confetti puff + a light cue', 2: '+ champagne pops on the coffee table', 3: '+ the balloon drop, confetti cannons, the light show hits', 4: '+ sparklers, more balloons, room-wide', 5: '+ a second balloon wave, a confetti storm' },
};

export interface LoungeAnchorSpec { p: [number, number, number]; yaw?: number; size?: number | number[]; radius?: number; r?: number; w?: number; h?: number }
export interface RoomLoungeConfig {
  on?: boolean;
  /** which event set this room / area uses (default: from the area key / label, else main) */
  zone?: LoungeZone;
  /** tier lines (5 numbers each, ascending) */
  money?: number[]; gifts?: number[];
  trainMin?: number;
  /** anchors without a GLB re-export: {EVT_FIREPIT: {p: [x,y,z], radius}} (glTF space) */
  anchors?: Record<string, LoungeAnchorSpec | [number, number, number]>;
  seed?: number;
}

export interface LoungeStamp {
  /** bumps on every stamp */ seq: number;
  /** start (epoch ms, host clock; guests shift it into theirs) */ at: number;
  src: LoungeSource;
  /** money: USD value */ usd: number;
  /** gifts: count · raids: viewers */ n: number;
  seed: number;
  user?: string;
  /** "$25.00", "20 subs" (shown on the banner) */ amount?: string;
}
export interface LoungeSupport { on: boolean; gifts: boolean; subs: boolean; raids: boolean }
export interface LoungeBag {
  /** every lounge event (off = nothing at all) */ on: boolean;
  /** calm: only small acknowledgements (≤ tier 2 effects, no light-show hits, no fireworks flashes); banners stay */ calm: boolean;
  /** the supporter banner */ banner: boolean;
  /** ask the light show for celebration cues (never in React / calm) */ lights: boolean;
  /** tier 4+ also plays the other areas' signature pieces where this camera can see them (fireworks through the glass …) */ roomWide: boolean;
  support: LoungeSupport;
  money?: number[]; gifts?: number[]; trainMin?: number;
  /** the latest test / bus stamps (≤ 6, newest last) */
  evs: LoungeStamp[];
}
export const DEFAULT_LOUNGE: LoungeBag = { on: true, calm: false, banner: true, lights: true, roomWide: true, support: { on: true, gifts: true, subs: true, raids: true }, evs: [] };

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const USER = /[\u0000-\u001f<>]/g;
const txt = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(USER, '').trim().slice(0, n) : '');
/** five ascending positive numbers, or undefined */
export function sanitizeLadder(v: unknown, max = 100000): number[] | undefined {
  if (!Array.isArray(v) || v.length !== 5) return undefined;
  const out: number[] = [];
  for (const x of v) { const n = num(x); if (!(n >= 0) || n > max) return undefined; out.push(Math.round(n * 100) / 100); }
  for (let i = 1; i < 5; i++) if (out[i] < out[i - 1]) out[i] = out[i - 1];
  return out;
}
export function sanitizeStamp(o: unknown): LoungeStamp | null {
  const e = (o && typeof o === 'object' ? o : null) as Record<string, unknown> | null;
  if (!e || typeof e.src !== 'string' || !SOURCES.has(e.src) || !(num(e.at) > 0) || !(num(e.seq) >= 0)) return null;
  const s: LoungeStamp = {
    seq: Math.floor(num(e.seq)), at: num(e.at), src: e.src as LoungeSource,
    usd: Math.min(1e6, Math.max(0, Number.isFinite(num(e.usd)) ? num(e.usd) : 0)),
    n: Math.min(10000, Math.max(0, Math.round(Number.isFinite(num(e.n)) ? num(e.n) : 0))),
    seed: Number.isFinite(num(e.seed)) ? Math.abs(Math.floor(num(e.seed))) % 2147483647 : 1,
  };
  const u = txt(e.user, 32); if (u) s.user = u;
  const a = txt(e.amount, 24); if (a) s.amount = a;
  return s;
}
export function sanitizeLounge(o: unknown): LoungeBag {
  const x = (o && typeof o === 'object' && !Array.isArray(o) ? o : {}) as Record<string, unknown>;
  const s = (x.support && typeof x.support === 'object' && !Array.isArray(x.support) ? x.support : {}) as Record<string, unknown>;
  const evs = (Array.isArray(x.evs) ? x.evs : []).slice(-6).map(sanitizeStamp).filter((e): e is LoungeStamp => !!e);
  const out: LoungeBag = {
    on: bool(x.on, true), calm: bool(x.calm, false), banner: bool(x.banner, true), lights: bool(x.lights, true), roomWide: bool(x.roomWide, true),
    support: { on: bool(s.on, true), gifts: bool(s.gifts, true), subs: bool(s.subs, true), raids: bool(s.raids, true) }, evs,
  };
  const m = sanitizeLadder(x.money); if (m) out.money = m;
  const g = sanitizeLadder(x.gifts, 10000); if (g) out.gifts = g.map(Math.round);
  const t = num(x.trainMin); if (t >= 2 && t <= 10000) out.trainMin = Math.round(t);
  return out;
}

/** Guest studios: the host's clock → ours (the offset the walks use, controller.ts onHostState). */
export function shiftLoungeClock(modes: Record<string, unknown> | undefined, off: number) {
  const b = modes?.[LOUNGE_BAG] as { evs?: { at?: unknown }[] } | undefined;
  if (Array.isArray(b?.evs)) for (const e of b!.evs) if (e && typeof e.at === 'number' && Number.isFinite(e.at)) e.at += off;
}

export interface LoungeLines { money: number[]; gifts: number[]; trainMin: number }
/** Effective tier lines: the host's bag over the room's scene.json over the defaults. */
export function loungeLines(bag: LoungeBag, room?: RoomLoungeConfig | null): LoungeLines {
  return {
    money: bag.money ?? sanitizeLadder(room?.money) ?? [...DEFAULT_LOUNGE_MONEY],
    gifts: bag.gifts ?? sanitizeLadder(room?.gifts, 10000) ?? [...DEFAULT_LOUNGE_GIFTS],
    trainMin: bag.trainMin ?? (num(room?.trainMin) >= 2 ? Math.round(num(room?.trainMin)) : DEFAULT_LOUNGE_TRAIN),
  };
}

const ladder = (v: number, l: readonly number[]): LoungeTier => { let t = 0; for (let i = 0; i < 5; i++) if (l[i] > 0 && v >= l[i]) t = i + 1; return t as LoungeTier; };
/** One support event → its tier, the item count it scales (gifts: N; money: none), and whether it is a gift train. */
export function loungeTier(src: LoungeSource, usd: number, n: number, L: LoungeLines): { tier: LoungeTier; n: number; train: boolean } {
  if (src === 'gift') { const c = Math.max(1, Math.round(n)); return { tier: ladder(c, L.gifts), n: c, train: c >= L.trainMin }; }
  if (src === 'sub') return { tier: 1, n: 1, train: false };
  if (src === 'raid') return { tier: 3, n: Math.max(1, Math.min(LOUNGE_TRAIN_CAP, Math.round(n))), train: false };
  return { tier: ladder(usd, L.money), n: 0, train: false };
}

/** A chat finance event → the lounge's view of it (null = not a support event the lounge celebrates). */
export function loungeSupportOf(e: { kind?: string; fkind?: string; usd?: number; approxUsd?: number; amount?: number }): { src: LoungeSource; usd: number; n: number } | null {
  if (e.kind !== 'finance' || !e.fkind) return null;
  const f = e.fkind;
  if (f === 'giftSub' || f === 'giftMembership') return { src: 'gift', usd: 0, n: Math.max(1, Math.round(e.amount ?? 1)) };
  if (f === 'sub' || f === 'resub' || f === 'membership' || f === 'milestone') return { src: 'sub', usd: 0, n: 1 };
  if (f === 'raid') return { src: 'raid', usd: 0, n: Math.max(1, Math.round(e.amount ?? 1)) };
  const usd = e.usd || e.approxUsd || 0;
  return usd > 0 ? { src: 'money', usd, n: 0 } : null;
}

// ---------------------------------------------------------------- the pieces each tier plays
export type LoungePieceKind = 'slide' | 'shots' | 'bottles' | 'sparklers' | 'champagne' | 'confetti' | 'balloons' | 'flare' | 'fireworks' | 'rockets' | 'lights';
export interface LoungePiece {
  k: LoungePieceKind;
  /** zone whose anchors it needs (≠ the area's own zone = a room-wide extra, drawn only where this camera sees it) */ z: LoungeZone;
  /** start (s after the item's start) */ at: number;
  /** length (s) */ dur: number;
  /** count (glasses, balloons, rockets …) */ n: number;
  /** 0.5 … 2: how big */ big: number;
}
const P = (k: LoungePieceKind, z: LoungeZone, at: number, dur: number, n = 1, big = 1): LoungePiece => ({ k, z, at, dur, n, big });

/** The pieces of one celebration in one zone. Gifts scale the counts (N drinks / balloons / rockets); a train adds one
 *  per gift (≤ LOUNGE_TRAIN_CAP). Tier 4+ adds the other zones' signature pieces (room-wide; drawn where visible). Pure. */
export function loungePieces(zone: LoungeZone, tier: LoungeTier, n = 0, train = false, roomWide = true): LoungePiece[] {
  if (tier <= 0) return [];
  const out: LoungePiece[] = [];
  const g = Math.max(0, Math.round(n));
  const cap = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const trainN = train ? Math.min(LOUNGE_TRAIN_CAP, g) : 0;
  const trainDur = trainN ? 2.5 + trainN * 0.42 : 0;
  out.push(P('lights', zone, 0, 4, 1, tier));
  if (zone === 'bar') {
    out.push(P('slide', 'bar', 0.2, 9, train ? 1 : cap(g || 1, 1, 3)));
    if (tier >= 2) out.push(P('shots', 'bar', 1.6, 9, cap(g || tier * 2, 3, 8), 1));
    if (tier >= 3) { out.push(P('bottles', 'bar', 0.8, tier >= 4 ? 16 : 10, 1, tier >= 4 ? 2 : 1)); out.push(P('sparklers', 'bar', 2.2, 6, 2, 0.7)); }
    if (tier >= 4) out.push(P('champagne', 'bar', 3.2, 7));
    if (tier >= 5) { out.push(P('shots', 'bar', 11.5, 9, 8, 1.2)); out.push(P('sparklers', 'bar', 12.5, 7, 4, 0.9)); }
    if (trainN) out.push(P('slide', 'bar', 2.5, trainDur + 6, trainN, 1));
  } else if (zone === 'patio') {
    out.push(P('flare', 'patio', 0.1, tier >= 2 ? 6 : 4, 1, tier >= 4 ? 2 : tier >= 2 ? 1.4 : 1));
    if (tier >= 2) out.push(P('sparklers', 'patio', 1.0, 7, tier >= 3 ? 4 : 2, 1));
    if (tier >= 3) out.push(P('fireworks', 'patio', 1.8, tier >= 4 ? 14 : 8, tier >= 4 ? 12 : 6, tier >= 4 ? 1.2 : 1));
    if (tier >= 4) out.push(P('flare', 'patio', 10, 6, 1, 1.6));
    if (tier >= 5) out.push(P('fireworks', 'patio', 15, 14, 13, 1.4));
    if (trainN) out.push(P('rockets', 'patio', 2.5, trainDur + 4, trainN, 1));
  } else {
    out.push(P('confetti', 'main', 0.3, 7, tier >= 3 ? 2 : 1, tier >= 3 ? 1 : 0.45));
    if (tier >= 2) out.push(P('champagne', 'main', 1.0, 7));
    if (tier >= 3) out.push(P('balloons', 'main', 1.5, 18, g ? cap(g, 12, 60) : tier >= 4 ? 40 : 24, 1));
    if (tier >= 4) out.push(P('sparklers', 'main', 2.0, 6, 2, 1));
    if (tier >= 5) { out.push(P('balloons', 'main', 11, 16, 30, 1)); out.push(P('confetti', 'main', 10.5, 8, 4, 1.4)); }
    if (trainN) out.push(P('balloons', 'main', 2.5, trainDur + 10, trainN, 1));
  }
  // room-wide (big ones): the other zones' signatures, wherever this camera can see their anchors
  if (tier >= 4 && roomWide) {
    if (zone !== 'patio') { out.push(P('fireworks', 'patio', 2.4, 12, 10, 1.1)); out.push(P('flare', 'patio', 0.5, 6, 1, 1.6)); }
    if (zone !== 'bar') out.push(P('bottles', 'bar', 0.8, 14, 1, 2));
    if (zone !== 'main') out.push(P('confetti', 'main', 0.6, 7, 2, 1));
  }
  return out;
}
/** Length (s) of a celebration (its last piece's end, the banner's minimum). */
export function loungeLength(pieces: readonly LoungePiece[]): number {
  let e = 8;
  for (const p of pieces) if (p.k !== 'lights') e = Math.max(e, p.at + p.dur);
  return e;
}

// ---------------------------------------------------------------- the schedule
export interface LoungeIn { id: string; at: number; src: LoungeSource; usd: number; n: number; user?: string; amount?: string; seed?: number }
export interface LoungeItem {
  id: string; src: LoungeSource; tier: LoungeTier; n: number; train: boolean; usd: number;
  /** epoch ms */ start: number; end: number; seed: number; user: string; amount: string;
}
/** Gift bursts (Kick sends 1 event per gifted sub at times): the same user's gifts this close (ms) add up into one. */
const GIFT_MERGE = 6000;
/** Longest a queued celebration may wait (ms) before it is dropped — by tier (big ones always play). */
const MAX_WAIT = [0, 25000, 45000, 90000, 300000, 300000];

/** Support + stamps (sorted by at, id) → the celebrations, merged and queued. Pure: every page gets the same list, and
 *  it doesn't depend on the area (lengths are the longest zone's), so moving to another area lands mid-celebration. */
export function loungeSchedule(evs: readonly LoungeIn[], L: LoungeLines): LoungeItem[] {
  const sorted = [...evs].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // 1. merge gift bursts
  const merged: LoungeIn[] = [];
  for (const e of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && e.src === 'gift' && prev.src === 'gift' && (prev.user ?? '') === (e.user ?? '') && e.at - prev.at < GIFT_MERGE) {
      merged[merged.length - 1] = { ...prev, n: prev.n + e.n, amount: `${prev.n + e.n} subs` };
      continue;
    }
    merged.push({ ...e });
  }
  // 2. tiers + the queue (a new celebration starts once the last one has had ~60 % of its run, 3–14 s)
  const out: LoungeItem[] = [];
  let lastStart = -Infinity, lastLen = 0;
  for (const e of merged) {
    const { tier, n, train } = loungeTier(e.src, e.usd, e.n, L);
    if (tier <= 0) continue;
    const len = Math.max(...LOUNGE_ZONES.map((z) => loungeLength(loungePieces(z, tier, n, train)))) * 1000;
    const gap = Math.min(14000, Math.max(3000, lastLen * 0.6));
    const start = Math.max(e.at, lastStart + gap);
    if (start - e.at > MAX_WAIT[tier]) continue;
    lastStart = start; lastLen = len;
    out.push({ id: e.id, src: e.src, tier, n, train, usd: e.usd, start, end: start + len, seed: e.seed ?? loungeHash(e.id), user: e.user ?? '', amount: e.amount ?? '' });
  }
  return out;
}

/** The banner's words for an item. */
export function loungeBannerText(it: Pick<LoungeItem, 'src' | 'tier' | 'n' | 'train' | 'user' | 'amount' | 'usd'>, zone: LoungeZone): { title: string; who: string; icon: string } {
  const who = [it.user, it.amount || (it.src === 'money' && it.usd ? `$${it.usd.toFixed(2)}` : '')].filter(Boolean).join('  ·  ');
  if (it.src === 'gift') return { title: it.train ? `GIFT TRAIN  ×${it.n}` : `GIFTED ${it.n} SUB${it.n === 1 ? '' : 'S'}`, who: it.user, icon: it.train ? '🚂' : '🎁' };
  if (it.src === 'sub') return { title: 'NEW SUB', who: it.user, icon: '⭐' };
  if (it.src === 'raid') return { title: 'RAID — WELCOME IN', who: [it.user, it.n ? `${it.n} viewers` : ''].filter(Boolean).join('  ·  '), icon: '🎉' };
  const flavour: Record<LoungeZone, Record<number, string>> = {
    bar: { 1: 'CHEERS!', 2: 'SHOTS!', 3: 'LIGHT UP THE BAR', 4: 'BIG SPENDER', 5: 'LEGEND' },
    patio: { 1: 'STOKE THE FIRE', 2: 'FIRE IT UP', 3: 'FIREWORKS!', 4: 'BIG SPENDER', 5: 'LEGEND' },
    main: { 1: 'CHEERS!', 2: 'POP THE BUBBLY', 3: 'PARTY TIME', 4: 'BIG SPENDER', 5: 'LEGEND' },
  };
  return { title: flavour[zone][it.tier] ?? 'THANK YOU', who, icon: it.tier >= 5 ? '👑' : it.tier >= 4 ? '💎' : it.tier >= 3 ? '🎉' : '🥂' };
}

/** Zone of a room / area: its config, else the area key / label, else main. */
export function loungeZoneOf(cfg: RoomLoungeConfig | null | undefined, area?: string, label?: string): LoungeZone {
  if (cfg?.zone && (LOUNGE_ZONES as string[]).includes(cfg.zone)) return cfg.zone;
  const s = `${area ?? ''} ${label ?? ''}`.toLowerCase();
  if (/bar|pub|counter|tavern/.test(s)) return 'bar';
  if (/patio|deck|fire|terrace|garden|roof|yard|balcony/.test(s)) return 'patio';
  return 'main';
}

export const loungeHash = (...xs: (number | string)[]) => yachtHash('lounge', ...xs);
export const loungeRand = yachtRand;
