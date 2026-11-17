// Yacht life (docs/SCENES.md → "Yacht life") — the contract shared by the studio (Scene tab, bus command) and every page.
//
// Rooms opt in with a scene.json `yacht` key (RoomYachtConfig). The host owns a stage-mode bag SceneState.modes.yacht
// (same pattern as modes.slap): toggles, the support thresholds and the latest test / bus event
// {seq, at (host clock), kind, seed}; guests' controllers shift `at` into their own clock (shiftYachtClock).
// Support events (chat feed finance events) never go through the bag: every page sees the same ChatEvents (ts + id) and
// turns them into the same schedule with the pure helpers below, so the studio preview, the host's OBS and every party
// guest's OBS show the same drinks, fireworks, flybys and fleets. Nothing here uses Math.random.

export const YACHT_BAG = 'yacht';

export const YACHT_KINDS = ['drink', 'champagne', 'fireworks', 'flyby', 'fleet'] as const;
export type YachtKind = typeof YACHT_KINDS[number];
export const isYachtKind = (v: unknown): v is YachtKind => typeof v === 'string' && (YACHT_KINDS as readonly string[]).includes(v);

/** Room defaults (scene.json `yacht.support`): USD value of one support event → the tier it reaches (cumulative). */
export const DEFAULT_YACHT_SUPPORT = { drink: 1, champagne: 5, fireworks: 10, flyby: 20, fleet: 50 } as const;
/** Room defaults (scene.json `yacht.ambient`): mean seconds between ambient flybys / skirmishes / patrol passes; lightning 0…10. */
export const DEFAULT_YACHT_AMBIENT = { flyby: 80, skirmish: 150, lightning: 6, patrol: 45 } as const;

/** Host lead (ms) between the button / the chat event and the start (the state reaches every page). */
export const YACHT_LEAD = 700;
/** Nominal durations (ms) of each event (the drink's real length depends on the room's walk; pages pass their own). */
export const YACHT_DUR: Record<YachtKind, number> = { drink: 30000, champagne: 7000, fireworks: 14000, flyby: 9000, fleet: 58000 };
/** Where each part of a tiered support event starts, after the event (ms): the drink first, the fleet last. */
export const YACHT_OFFSET: Record<YachtKind, number> = { drink: 0, champagne: 600, fireworks: 2500, flyby: 5000, fleet: 7000 };

export interface RoomYachtConfig {
  units?: string; unitsMeta?: string; fleet?: string; fleetMeta?: string;
  /** crew height (m) */ crewHeight?: number;
  bartender?: string; steward?: string; stewardess?: string; pilot?: string;
  routes?: { route: string; who?: string; every?: number; speed?: number; clip?: string; offset?: number }[];
  patrons?: { unit: string; clip?: string; sit?: boolean | number; position: [number, number, number]; facing?: number }[];
  /** storms: glTF points on the planet's surface; omit / [] / "auto" = 8 generated on the hemisphere facing the room */
  planet?: { center: [number, number, number]; radius: number; storms?: [number, number, number][] | 'auto' };
  far?: [number, number, number][];
  support?: Partial<Record<YachtKind, number>>;
  ambient?: Partial<Record<keyof typeof DEFAULT_YACHT_AMBIENT, number>>;
  /** seed for the ambient schedule (default: hash of the room id) */ seed?: number;
  /** tests only: fake anchors {NODE_NAME: {position (glTF), facing deg, size}} added to the room on attach */
  debugAnchors?: Record<string, { position: [number, number, number]; facing?: number; size?: number }>;
}

export interface YachtEvent {
  /** Bumps on every stamp. */ seq: number;
  /** Start (epoch ms, host clock; guests shift it into theirs). */ at: number;
  kind: YachtKind;
  seed: number;
  /** who summoned it (bus / test), optional */ user?: string;
}

export interface YachtSupport { on: boolean; raids: boolean; drink?: number; champagne?: number; fireworks?: number; flyby?: number; fleet?: number }

export interface YachtBag {
  /** the whole yacht life (crew + ships + effects) */ on: boolean;
  crew: boolean;
  /** ambient ship traffic (flybys, the escort patrol) */ ships: boolean;
  skirmish: boolean;
  lightning: boolean;
  /** the fleet arrival may cut to CAM_EXTERIOR for 6 s (Talk mode only) */ cutaway: boolean;
  support: YachtSupport;
  ev: YachtEvent | null;
}

export const DEFAULT_YACHT: YachtBag = { on: true, crew: true, ships: true, skirmish: true, lightning: true, cutaway: true, support: { on: true, raids: true }, ev: null };

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const USER = /[\u0000-\u001f<>]/g;

export function sanitizeYacht(o: unknown): YachtBag {
  const x = (o && typeof o === 'object' && !Array.isArray(o) ? o : {}) as Record<string, unknown>;
  const s = (x.support && typeof x.support === 'object' && !Array.isArray(x.support) ? x.support : {}) as Record<string, unknown>;
  const support: YachtSupport = { on: bool(s.on, true), raids: bool(s.raids, true) };
  for (const k of YACHT_KINDS) { const v = num(s[k]); if (v >= 0 && v <= 100000) support[k] = Math.round(v * 100) / 100; }
  const e = (x.ev && typeof x.ev === 'object' ? x.ev : null) as Record<string, unknown> | null;
  let ev: YachtEvent | null = null;
  if (e && isYachtKind(e.kind) && num(e.at) > 0 && num(e.seq) >= 0) {
    ev = { seq: Math.floor(num(e.seq)), at: num(e.at), kind: e.kind, seed: Number.isFinite(num(e.seed)) ? Math.abs(Math.floor(num(e.seed))) % 2147483647 : 1 };
    if (typeof e.user === 'string' && e.user.trim()) ev.user = e.user.replace(USER, '').trim().slice(0, 32);
  }
  return {
    on: bool(x.on, true), crew: bool(x.crew, true), ships: bool(x.ships, true), skirmish: bool(x.skirmish, true),
    lightning: bool(x.lightning, true), cutaway: bool(x.cutaway, true), support, ev,
  };
}

/** Guest studios: the host's clock → ours (the offset the walks use, controller.ts onHostState). */
export function shiftYachtClock(modes: Record<string, unknown> | undefined, off: number) {
  const b = modes?.[YACHT_BAG] as { ev?: { at?: unknown } } | undefined;
  if (b?.ev && typeof b.ev.at === 'number' && Number.isFinite(b.ev.at)) b.ev.at += off;
}

/** Effective thresholds: the host's bag over the room's defaults (0 / missing in both = the built-in default). */
export function yachtThresholds(bag: YachtBag, room?: RoomYachtConfig | null): Record<YachtKind, number> {
  const out = { ...DEFAULT_YACHT_SUPPORT } as Record<YachtKind, number>;
  for (const k of YACHT_KINDS) {
    const r = num(room?.support?.[k]);
    if (r >= 0) out[k] = r;
    const b = num(bag.support[k]);
    if (b >= 0) out[k] = b;
  }
  return out;
}

/** The tiers one support event reaches (cumulative: $10 = a drink + champagne + fireworks). A raid = the fleet only. */
export function yachtTiers(usd: number, thr: Record<YachtKind, number>, raid = false): YachtKind[] {
  if (raid) return ['fleet'];
  const out: YachtKind[] = [];
  for (const k of YACHT_KINDS) if (thr[k] > 0 && usd >= thr[k]) out.push(k);
  return out;
}

// ---------------------------------------------------------------- deterministic helpers
/** 32-bit hash of any mix of numbers / strings (FNV-1a + avalanche). */
export function yachtHash(...xs: (number | string)[]): number {
  let h = 2166136261 >>> 0;
  for (const x of xs) {
    const s = typeof x === 'number' ? String(Math.floor(x)) : x;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    h ^= 0x9e3779b9; h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  }
  h ^= h >>> 13; h = Math.imul(h, 3266489917) >>> 0; h ^= h >>> 16;
  return h >>> 0;
}
/** Deterministic 0…1 from a seed and salts. */
export function yachtRand(seed: number, a: number, b = 0): number {
  let x = (Math.imul(seed | 0, 374761393) + Math.imul(a | 0, 668265263) + Math.imul(b | 0, 2246822519)) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x = Math.imul(x ^ (x >>> 16), 2654435761);
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}

/** An ambient act on the wall clock: slots of `every` s, each holding (with probability `chance`) one act of `dur` s at a
 *  seeded offset. Returns the act running at `t` (s) or null. Pure: every page gets the same answer. */
export function yachtAmbient(seed: number, salt: number, every: number, dur: number, t: number, chance = 0.8): { slot: number; start: number; seed: number } | null {
  const E = Math.max(dur + 1, every);
  const s0 = Math.floor(t / E);
  for (let s = s0; s >= s0 - 1; s--) {
    const h = yachtHash(seed, salt, s);
    if ((h % 10000) / 10000 >= chance) continue;
    const start = s * E + yachtRand(h, 3) * (E - dur);
    if (t >= start && t < start + dur) return { slot: s, start, seed: h };
  }
  return null;
}

export interface YachtEventIn { id: string; at: number; kind: YachtKind; seed: number; user?: string }
export interface YachtItem { id: string; kind: YachtKind; start: number; end: number; seed: number; user: string; /** index in its lane (drinks: delivery #) */ n: number }

/** Min spacing (× duration) between two starts of one kind: stewards alternate, so drinks overlap by half. */
const SPACING: Record<YachtKind, number> = { drink: 0.55, champagne: 0.85, fireworks: 0.9, flyby: 1, fleet: 1 };
/** Longest a queued event may wait (ms) before it is dropped (bursts of gift subs don't queue an hour of drinks). */
const MAX_WAIT: Record<YachtKind, number> = { drink: 150000, champagne: 60000, fireworks: 60000, flyby: 60000, fleet: 150000 };
/** Events of one kind closer than this (ms) merge into one (a burst of gifts = one drink / one show). */
const MERGE = 3500;

/** The schedule: events (sorted by at, id) → lanes per kind that never overlap more than SPACING allows. Pure. */
export function yachtSchedule(evs: readonly YachtEventIn[], dur: Record<YachtKind, number> = YACHT_DUR): YachtItem[] {
  const sorted = [...evs].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: YachtItem[] = [];
  const last: Partial<Record<YachtKind, { at: number; start: number; n: number }>> = {};
  for (const e of sorted) {
    const L = last[e.kind];
    if (L && Math.abs(e.at - L.at) < MERGE) continue;
    const d = Math.max(1000, dur[e.kind]);
    const start = L ? Math.max(e.at, L.start + d * SPACING[e.kind]) : e.at;
    if (start - e.at > MAX_WAIT[e.kind]) continue;
    const n = L ? L.n + 1 : 0;
    last[e.kind] = { at: e.at, start, n };
    out.push({ id: e.id, kind: e.kind, start, end: start + d, seed: e.seed, user: e.user ?? '', n });
  }
  return out;
}
