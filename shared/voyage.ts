// Voyage engine (docs/SCENES.md -> "Voyage"; the walking-ship SPEC section 2) - the contract shared by the
// studio (Scene tab, bus, host controller) and every page.
//
// A room with a scene.json `voyage` key (RoomVoyageConfig) is a walking ship: the ship
// (the room, its performers and every CAM_*) never moves; the world streams past it. Everything here is a PURE function of
//   * the host's bag SceneState.modes.voyage (VoyageBag: seed, epoch, holds, stamps, forks, toggles),
//   * the room config, and
//   * the wall clock (ms),
// so the studio preview, the host's OBS and every party guest's OBS show the same voyage, and a page opened mid-battle
// lands mid-battle. Guests shift the host's clock stamps into theirs (shiftVoyageClock, next to shiftYachtClock).
// Anything that can change the distance or the hashed state is a host STAMP in the bag (SPEC D10): support events become
// stamps in the host controller (src/scene/voyage/voyageHost.ts), never per page. Nothing here uses Math.random / Date.now.
//
// Time model (SPEC 2.4 + 11.2):
//   V(now)    voyage seconds = (now - epoch - heldMs)/1000 - held(now). Holds (host Anchor, stamped treasure stops) ramp
//             the rate down / up over HOLD_RAMP = 8 s (closed form) and are deferred past a running battle / city / stop.
//             A hold that ended long ago folds into heldMs (S1: never evicted, so V never jumps).
//   chapter   chapters cover exactly D[pacing] metres in C[pacing] seconds. A pacing change takes effect at the NEXT
//             chapter boundary through a `pace` anchor (V, chapter, S at that boundary), so S, the chapter and the hour
//             stay continuous. Its LAYOUT (beats, durations, gaps) depends on (seed, chapter) only; a fork vote changes its
//             CONTENT (flavour, city kind, enemy kind, terrain), never its timing or distance.
//   forks     the vote closes at boundary - 20 s, the host stamps it by boundary - 10 s (FORK_FINAL); a later stamp is
//             ignored everywhere. The terrain of the next chapter cross-fades to the vote over FORK_FADE s of voyage time
//             and only starts BIOME_IN m past the boundary, so nothing under or near the ship ever changes (S3).
//   beats     opening cruise >= 120 s, encounter (~120 s), city pass, sandstorm (60 s approach + inside + 40 s clearing),
//             treasure stop (8 + 60..85 + 10 s), >= 90 s cruise between big beats, the fork vote in the last 120 s.
//   stamps    two rings (S2): `stamps` = episodes (treasure, battle, storm, city, convoy, newVoyage; <= 4, never evicted
//             before the episode ended) and `fx` = effects (whistle, salute, special, broadside, fireworks; ring of 8).
//             Episode stamps only start in a clear window (no battle inside a storm or a stop, ...), else they drop.
//   speed     piecewise smoothstep ramps; distance inside a ramp of length R: R*(v0*u + (v1-v0)*(u^3 - u^4/2)).
//   hour      'journey': one day per `dayLen` chapters (counted in chapters, so a pacing change never moves the sun),
//             night share `nightShare`, dawn / golden / blue hours stretched.

export const VOYAGE_BAG = 'voyage';

// ------------------------------------------------------------------------------------------------ deterministic helpers
/** 32-bit hash of any mix of numbers / strings (FNV-1a + avalanche; numbers are floored). */
export function voyageHash(...xs: (number | string)[]): number {
  let h = 2166136261 >>> 0;
  for (const x of xs) {
    const s = typeof x === 'number' ? String(Math.floor(x)) : x;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    h ^= 0x9e3779b9; h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  }
  h ^= h >>> 13; h = Math.imul(h, 3266489917) >>> 0; h ^= h >>> 16;
  return h >>> 0;
}
/** Deterministic 0..1 from a seed and integer salts. */
export function voyageRand(seed: number, a: number, b = 0): number {
  let x = (Math.imul(seed | 0, 374761393) + Math.imul(a | 0, 668265263) + Math.imul(b | 0, 2246822519)) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x = Math.imul(x ^ (x >>> 16), 2654435761);
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}
export const smooth01 = (u: number) => { const t = u <= 0 ? 0 : u >= 1 ? 1 : u; return t * t * (3 - 2 * t); };
/** integral of smoothstep from 0 to u (u in 0..1): u^3 - u^4/2 */
const P = (u: number) => { const t = u <= 0 ? 0 : u >= 1 ? 1 : u; return t * t * t - (t * t * t * t) / 2; };
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
/** Viewer names in stamps (SPEC 11.4 M3): no control / bidi / zero-width characters, no angle brackets, no floods of
 *  combining marks, whitespace collapsed, at most NAME_MAX characters. */
export const NAME_MAX = 24;
const NAME_BAD = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff<>]/g;
export function voyageName(v: unknown): string {
  if (typeof v !== 'string') return '';
  const s = v.replace(NAME_BAD, '').replace(/(\p{M}{2})\p{M}+/gu, '$1').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, NAME_MAX).join('').trim();
}

// ------------------------------------------------------------------------------------------------ constants (SPEC D4, 2.4)
export type VoyagePacing = 'chill' | 'normal' | 'hot';
export const VOYAGE_PACINGS: readonly VoyagePacing[] = ['chill', 'normal', 'hot'];
/** Seconds per chapter. */
export const LEG_SEC: Record<VoyagePacing, number> = { chill: 1500, normal: 1200, hot: 900 };
/** Metres per chapter (every chapter exactly; its speeds are scaled by k = D / raw, kept in [0.85, 1.15] by the filler). */
export const LEG_DIST: Record<VoyagePacing, number> = { chill: 3600, normal: 3200, hot: 2700 };
export const CHAPTER_SEC = LEG_SEC, CHAPTER_DIST = LEG_DIST;
/** Seconds of the speed ramp at each end of a hold (Anchor / stamped treasure stop). */
export const HOLD_RAMP = 8;
/** Holds kept in the bag (active + recently ended); older finished ones fold into heldMs (SPEC 11.2 S1). */
export const HOLD_CAP = 4;
/** A finished hold folds into heldMs only this long (s) after its last ramp, and only once no stamp in play refers to a
 *  moment before it (pages a little behind the host's clock, past-time references of stamps in play never see a change). */
export const FOLD_MARGIN = 60;
/** Default epoch when a room never stamped one (every page agrees: 2026-01-01T00:00:00Z). */
export const VOYAGE_EPOCH0 = 1767225600000;
/** Stamps start at least this long after the host pressed / the chat event (every page has them before they play). */
export const STAMP_LEAD = 2000;
/** Longest a stamp waits for its clear moment (SPEC 2.8), s: host buttons / bus. */
export const STAMP_MAX_WAIT = 60;
/** ... and a paid episode (a summoned raider, "Dig here!", a storm): with the no-overlap rules (no battle in a storm or a
 *  stop, no stop within 90 s after a battle) one minute drops ~45 % of summoned raiders; 4 minutes plays ~9 in 10. */
export const SUPPORT_MAX_WAIT = 240;
/** Fork vote window: the last FORK_SEC seconds of every chapter. */
export const FORK_SEC = 120;
/** The vote closes this long before the chapter boundary (s, SPEC 11.2 S3). */
export const FORK_CLOSE = 20;
/** A fork must be stamped at least this long before the boundary (voyage s); a later stamp is ignored everywhere. */
export const FORK_FINAL = 10;
/** The voted chapter's terrain cross-fades in over this much voyage time (s): no one-frame pop anywhere. */
export const FORK_FADE = 8;
/** Terrain biome blend between chapters: from BIOME_IN to BIOME_OUT metres PAST the boundary (one-sided, so a fork
 *  landing >= FORK_FINAL s before the boundary never touches the ground under or near the ship). */
export const BIOME_IN = 40, BIOME_OUT = 540;
export const VOYAGE_LEAD = STAMP_LEAD;

export interface VoyageSpeeds { cruise: number; city: number; battle: number; storm: number }
export const DEFAULT_SPEEDS: VoyageSpeeds = { cruise: 3.0, city: 2.2, battle: 4.2, storm: 1.7 };
/** One stride at every speed (phase = S / stride stays continuous through speed changes). */
export const DEFAULT_GAIT = { stride: 6.0, duty: 0.55, lift: 1.4 } as const;
export const DEFAULT_KNEEL = 3.0;
/** Sand at rest under the ship, room frame (the show floor is y 0). */
export const DEFAULT_GROUND_Y = -12.844;
export const DEFAULT_DECK_H = -DEFAULT_GROUND_Y;

export type BeatKind = 'cruise' | 'encounter' | 'city' | 'storm' | 'treasure';
export const BEAT_KINDS: readonly BeatKind[] = ['cruise', 'encounter', 'city', 'storm', 'treasure'];
/** Villains: the art lane's original designs (SPEC D11 - no "gonif"). */
export type EnemyKind = 'gnashers' | 'crawler' | 'lancer' | 'skiffs';
export const ENEMY_KINDS: readonly EnemyKind[] = ['gnashers', 'crawler', 'lancer', 'skiffs'];
export const ENEMY_LABEL: Record<EnemyKind, string> = { gnashers: 'Gnasher pack', crawler: 'Bulwark Crawler', lancer: 'Stilt Lancer', skiffs: 'Skiff raid' };
export type CityKind = 'windtower' | 'hulk' | 'cistern' | 'souk';
export const CITY_KINDS: readonly CityKind[] = ['windtower', 'hulk', 'cistern', 'souk'];
/** Fork flavours: the vote at the end of a chapter picks the next chapter's flavour (content only). */
export type Flavour = 'oasis' | 'bazaar' | 'canyon' | 'dunes' | 'ruins' | 'saltflat';
export const FLAVOURS: readonly Flavour[] = ['oasis', 'bazaar', 'canyon', 'dunes', 'ruins', 'saltflat'];
export const FLAVOUR_LABEL: Record<Flavour, string> = {
  oasis: 'Nosh Oasis', bazaar: 'The Grand Bazaar', canyon: 'The Badlands', dunes: 'Deep Dunes', ruins: 'Old Ruins', saltflat: 'Salt Flats',
};
export const FORK_PAIRS: readonly [Flavour, Flavour][] = [['oasis', 'canyon'], ['bazaar', 'dunes'], ['ruins', 'saltflat'], ['bazaar', 'canyon'], ['dunes', 'oasis'], ['saltflat', 'ruins']];
/** Terrain multipliers per flavour (dune amplitude, hill amplitude): the placeholder ground and the desert lane read the
 *  same numbers. */
export const FLAVOUR_BIOME: Record<Flavour, { dune: number; hill: number }> = {
  saltflat: { dune: 0.18, hill: 0.4 }, dunes: { dune: 1.45, hill: 1 }, canyon: { dune: 0.7, hill: 1.8 }, oasis: { dune: 0.75, hill: 0.8 },
  ruins: { dune: 0.9, hill: 1.2 }, bazaar: { dune: 1, hill: 1 },
};

/** Beat odds per chapter (SPEC 2.4 table). enc2 = a second encounter. */
const ODDS: Record<VoyagePacing, { city: number; enc: number; enc2: number; storm: number; treasure: number }> = {
  chill: { city: 0.8, enc: 0.5, enc2: 0, storm: 0.35, treasure: 0.6 },
  normal: { city: 0.9, enc: 0.85, enc2: 0.3, storm: 0.5, treasure: 0.5 },
  hot: { city: 0.9, enc: 1, enc2: 0.3, storm: 0.6, treasure: 0.4 },
};
/** Encounter structure (SPEC D12): alarm 0-3, approach -20, exchange -75, climax -88, defeat -100, aftermath -120 s. */
export const ENC = { approach: 20, battle: 68, after: 32, total: 120, climax: 55 } as const;
/** Storm weather: approach (haboob) before the beat, clearing after it. */
export const STORM_APPROACH = 60, STORM_CLEAR = 40;
/** The crew repairs for this long after a battle: no treasure stop starts sooner (SPEC 2.4). */
export const REPAIR_GAP = 90;

// ------------------------------------------------------------------------------------------------ room config (SPEC App. A)
export type DangerSide = 'aft-port' | 'aft-starboard' | 'port' | 'starboard';
export interface RoomVoyageConfig {
  /** rig.json (geometry lane / v0 build): legs, limits, rams, turrets, damage sites, extCams */
  rig?: string;
  groundY?: number;
  gait?: { family?: string; stride?: number; duty?: number; lift?: number; speeds?: Partial<VoyageSpeeds>; kneel?: number };
  body?: { heave?: number; rollDeg?: number; pitchDeg?: number; impulseDeg?: number; terrainPitchMax?: number; heaveExt?: number };
  modeGain?: Partial<Record<string, number>>;
  chapter?: Partial<Record<VoyagePacing, number>>;
  chapterDist?: Partial<Record<VoyagePacing, number>>;
  dangerSide?: DangerSide;
  /** fireArcBox = the canopy + wings + hatch-stage box [minX, minY, minZ, maxX, maxY, maxZ] (ship frame), fireArcSlots = the
   *  alongside slot nodes: no line of fire within fireArcFromSpots m of either (SPEC C13) */
  keepOut?: { fxFromSpots?: number; shellsFromHull?: number; lens?: number; fireArcFromSpots?: number; fireArcBox?: number[]; fireArcSlots?: string[] };
  turrets?: Record<string, { alias?: string; yawDeg?: [number, number]; elevDeg?: [number, number] }>;
  kits?: Record<string, string>;
  support?: { tiers?: number[] };
  below?: { portholes?: number; sway?: number; lanterns?: string[]; drums?: string[] };
  extCams?: Record<string, Record<string, unknown>>;
  /** Preshow exterior show: in the Preshow lighting state the cameras leave the deck and watch the ship walk from outside
   *  (crane-ups, slow orbits, low tracking shots, flybys, a hero wide under the room's showSky planets), at `hour`.
   *  `always` (default true) = without the host's ambient-camera toggle; `shot` = seconds per shot (ambient cameras on:
   *  their cycle); `moves` = the program (RISE ORBIT TRACK HERO SKYWARD FLYBY FEET). */
  /** the Preshow exterior show: cuts 'music' (default: a director cutting on bar lines, 2 / 4 / 8 bars by the section)
   *  or 'clock' (a fixed `shot` s); `moves` = the moves it may use; `performer` = share of deck shots on a performer 0..1
   *  (0.3); `bars` = bars per shot by section {drop, build, groove, breakdown}; `storm` = the most sandstorm shown
   *  during Preshow 0..1 (0.3: the light show's sky stays readable) */
  preshow?: { exterior?: boolean; always?: boolean; hour?: number; shot?: number; moves?: string[]; cuts?: 'music' | 'clock'; performer?: number; storm?: number; bars?: Partial<Record<'drop' | 'build' | 'groove' | 'breakdown', number>> } | false;
  /** Show b-roll (Talk mode, Show lighting): a short exterior cut on a bar line while the performer is quiet (off by default) */
  broll?: boolean | { on?: boolean; every?: number; bars?: number; quiet?: number; moves?: string[] };
  /** which way the ship's model faces (its bow): '-z' (the contract default), '+z', '-x', '+x', or 'auto' (= the
   *  VOYAGE_BOW node, else the hull's pointed end). The ship always walks bow-first. */
  forward?: '-z' | '+z' | '-x' | '+x' | 'auto';
  /** the room's own names for stamp kinds (banners + Studio buttons), e.g. {"special": "The cook's special"} */
  labels?: Partial<Record<StampKind, string>>;
  /** Kick channel-point reward keywords -> stamp kind */
  rewards?: Record<string, StampKind>;
  /** seed for rooms whose host never stamped one (default: hash of the room id) */ seed?: number;
  /** camera far plane while the voyage runs (m, default 2600) */ far?: number;
  /** 'auto' (default: the room's LEG_* rig, else the procedural placeholder), 'room', 'procedural' */ ship?: 'procedural' | 'room' | 'auto';
  /** fallback hull hit sites (glTF) when the GLB / rig has none */ damage?: [number, number, number][];
  /** the streaming world: provider 'desert' (default: the procedural desert, src/scene/desert) or 'placeholder' (the
   *  voyage lane's own light terrain, voyageWorld.ts); the rest is the placeholder world's look */
  world?: { provider?: 'desert' | 'placeholder'; sand?: string; trough?: string; crest?: string; fogNear?: number; fogFar?: number; scatter?: number;
    /** desert provider: relief under the sand (mesas / cliffs / ridges away from the route) 0..1.5, default 1 */
    relief?: number;
    /** desert provider: aerial-perspective (haze) multiplier 0.4..2.5, default 1 */
    haze?: number;
    /** desert provider: burning wrecks with fire + smoke columns, density 0..2 (0 = none), default 1 */
    wrecks?: number;
    /** desert provider: distant ruined towns / industrial skylines (lit at night), density 0..2 (0 = none), default 1 */
    skyline?: number;
    /** desert provider: drifting sand near the ground, 0..2 (0 = none), default 1 */
    drift?: number;
    /** desert provider: the night key's floor 0..2 (default 1): the relief reads at night */
    moonlight?: number;
  };
  /** pacing default for rooms whose host never chose one */ pacing?: VoyagePacing;
  /** named anchors (v0 build `ship.nodes`): ground (VOYAGE_GROUND: groundY when `groundY` is absent), fallbackGround
   *  (FALLBACK_DESERT: hidden while the voyage world is attached, like every node with extras `voyageHide`) */
  nodes?: Record<string, string | string[]>;
}

// ------------------------------------------------------------------------------------------------ stamps
export const STAMP_KINDS = ['treasure', 'battle', 'storm', 'city', 'broadside', 'salute', 'whistle', 'special', 'fireworks', 'convoy', 'newVoyage'] as const;
export type StampKind = typeof STAMP_KINDS[number];
export const isStampKind = (v: unknown): v is StampKind => typeof v === 'string' && (STAMP_KINDS as readonly string[]).includes(v);
/** Episode stamps (SPEC 11.2 S2): the bag's `stamps` ring - at most EVENT_RING, never evicted before the episode ended. */
export const EVENT_KINDS: readonly StampKind[] = ['treasure', 'battle', 'storm', 'city', 'convoy', 'newVoyage'];
/** Effect stamps: the bag's `fx` ring of FX_RING (the oldest finished / nearly finished one makes room). */
export const FX_KINDS: readonly StampKind[] = ['broadside', 'salute', 'whistle', 'special', 'fireworks'];
export const isEventKind = (k: StampKind) => EVENT_KINDS.includes(k);
export const EVENT_RING = 4, FX_RING = 8;
/** (SPEC 2.3's single ring of 8 is now the fx ring; episodes have their own ring of EVENT_RING) */
export const STAMP_RING = FX_RING;
/** How long each stamp plays (s; treasure = its stopDuration + brake + start, computed per stamp). */
export const STAMP_DUR: Record<StampKind, number> = { treasure: 100, battle: ENC.total, storm: STORM_APPROACH + 120 + STORM_CLEAR, city: 150, broadside: 9, salute: 6, whistle: 4, special: 8, fireworks: 14, convoy: 90, newVoyage: 6 };
/** What a stamp still shows after its duration (s): smoke, the city it put on the map, a convoy walking off. A stamp is
 *  pruned / its ring slot freed / a fold allowed only once at + dur + tail has passed.
 *  A battle stays for the REPAIR_GAP (+5 s) after it ends, so no stamped stop can start in its repair gap once it is tidied. */
export const STAMP_TAIL: Record<StampKind, number> = { treasure: 5, battle: REPAIR_GAP + 5, storm: 5, city: 600, convoy: 30, newVoyage: 2, broadside: 10, salute: 8, whistle: 2, special: 2, fireworks: 6 };
export const STAMP_LABEL: Record<StampKind, string> = {
  treasure: 'Dig here!', battle: 'Summon a raider', storm: 'Sandstorm', city: 'City ahead', broadside: 'Broadside', salute: 'Salute shot',
  whistle: 'Steam whistle', special: "Chef's special", fireworks: 'Fireworks', convoy: 'Skiff convoy', newVoyage: 'New voyage',
};
/** A stamp kind's name in this room: scene.json `voyage.labels` {kind: name} (a room's own flavour, e.g. its deli's
 *  special), else STAMP_LABEL. Trimmed, at most 40 characters. */
export function stampLabel(k: StampKind, cfg?: RoomVoyageConfig | null): string {
  const v = cfg?.labels?.[k];
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 40) : STAMP_LABEL[k];
}
/** Default support tiers (host currency, cumulative) and what each reaches (SPEC 2.8). */
export const DEFAULT_TIERS = [1, 3, 5, 10, 20, 30, 50] as const;
export const TIER_KINDS: readonly StampKind[] = ['whistle', 'salute', 'special', 'broadside', 'fireworks', 'battle', 'treasure'];
/** Offsets (ms) of the parts of one tiered support event: the whistle first, the big ones last. */
export const TIER_OFFSET: Partial<Record<StampKind, number>> = { whistle: 0, salute: 900, special: 1800, broadside: 3000, fireworks: 5000, battle: 7000, treasure: 9000 };

export interface VoyageHold { at: number; until: number | null }
/** A fork vote result: the chapter it was stamped in, the choice, and the voyage time of the stamp (s; a stamp later than
 *  FORK_FINAL s before that chapter's end has no effect). */
export interface VoyageFork { ch: number; choice: 0 | 1; v?: number }
export interface VoyageStamp { id: number; at: number; k: StampKind; arg?: number; who?: string }
/** A pacing change: from voyage time v (a chapter boundary: chapter ch, distance s) on, the next anchor's `was` (or the
 *  bag's pacing for the last anchor) applies; before it, `was`. Kept: the last PACE_KEEP (each >= one chapter apart). */
export const PACE_KEEP = 2;
/** Fork results kept (the chapters around the ship: the one before, this one, the vote for the next). */
export const FORK_KEEP = 4;
export interface VoyagePace { v: number; ch: number; s: number; was: VoyagePacing }
export type Intensity = 'full' | 'background' | 'off';
export interface VoyageBag {
  v: 1;
  /** the whole voyage (off = the ship stands still, no world motion, no events) */ on: boolean;
  seed: number;
  /** host epoch ms of V = 0 (0 = VOYAGE_EPOCH0) */ epoch: number;
  /** ms held by finished holds folded out of `holds` (SPEC 11.2 S1) */ heldMs: number;
  /** the pacing in effect now (or from the pending `pace` anchor on) */ pacing: VoyagePacing;
  /** presentation toggles (never the timing: S never changes when one is switched) */
  events: { battles: boolean; storms: boolean; treasure: boolean; cities: boolean };
  env: 'journey' | 'state' | 'fixed';
  /** chapters per day 1..4 */ dayLen: number;
  /** 0.15..0.45 */ nightShare: number;
  /** env 'fixed' */ hour: number;
  /** master deck motion 0..1.5 */ sway: number;
  /** Talk may cut away from the deck cameras (event cutaways + the room's b-roll). OFF by default: in Talk the camera
   *  stays on the host's choice; only a camera change or the Preshow show moves it. The host turns it on (Studio
   *  "Cut away while I talk", bus flag `cutaways`). */ talkCuts: boolean;
  /** @deprecated beta.11's default-on Talk cutaways flag: no longer read (a stored true was never the host's choice) */
  cutaways?: boolean;
  /** exterior program for Preshow / BRB / Outro (with the host's ambient cameras on) */ extCams: boolean;
  intensity: Partial<Record<string, Intensity>>;
  holds: VoyageHold[];
  /** episode stamps (<= EVENT_RING) */ stamps: VoyageStamp[];
  /** effect stamps (<= FX_RING) */ fx: VoyageStamp[];
  forks: VoyageFork[];
  votes: boolean;
  support: { on: boolean; tiers?: number[]; raids: boolean };
  crew: { helm: 'npc' | 'performer'; count?: number };
  /** pacing changes (anchors at chapter boundaries) */ pace: VoyagePace[];
}

export const DEFAULT_VOYAGE: VoyageBag = {
  v: 1, on: true, seed: 1, epoch: 0, heldMs: 0, pacing: 'normal', events: { battles: true, storms: true, treasure: true, cities: true },
  env: 'journey', dayLen: 2, nightShare: 0.3, hour: 16.5, sway: 1, talkCuts: false, extCams: true, intensity: {},
  holds: [], stamps: [], fx: [], forks: [], votes: true, support: { on: true, raids: true }, crew: { helm: 'npc' }, pace: [],
};

const byAt = (a: VoyageStamp, b: VoyageStamp) => a.at - b.at || a.id - b.id;

export function sanitizeVoyage(o: unknown): VoyageBag {
  const x = obj(o);
  const ev = obj(x.events), sup = obj(x.support), crew = obj(x.crew), inten = obj(x.intensity);
  let heldMs = num(x.heldMs);
  heldMs = heldMs >= 0 && heldMs < 1e13 ? heldMs : 0;
  // holds: sorted, non-overlapping (each starts >= one ramp after the previous one's end), each >= 2 ramps long, at most
  // one open (the last). Never dropped for room: past HOLD_CAP the oldest (finished) ones fold into heldMs.
  const holds: VoyageHold[] = [];
  if (Array.isArray(x.holds)) {
    const raw = x.holds.map(obj).filter((h) => num(h.at) > 0).map((h) => ({ at: num(h.at), until: num(h.until) > 0 ? num(h.until) : null })).sort((a, b) => a.at - b.at);
    for (const h of raw) {
      const prev = holds[holds.length - 1];
      if (prev && (prev.until === null || h.at < prev.until + HOLD_RAMP * 1000)) continue;
      holds.push({ at: h.at, until: h.until === null ? null : Math.max(h.until, h.at + HOLD_RAMP * 1000) });
    }
  }
  while (holds.length > HOLD_CAP && holds[0].until !== null) { const h = holds.shift()!; heldMs += h.until! - h.at; }
  const forks: VoyageFork[] = [];
  if (Array.isArray(x.forks)) for (const f of x.forks.map(obj)) {
    const ch = num(f.ch ?? f.leg);
    if (!(ch >= 0) || ch > 1e7 || forks.some((q) => q.ch === Math.floor(ch))) continue;
    const fk: VoyageFork = { ch: Math.floor(ch), choice: f.choice === 1 ? 1 : 0 };
    const v = num(f.v);
    if (v >= 0 && v < 1e12) fk.v = Math.floor(v * 10) / 10;
    forks.push(fk);
  }
  forks.sort((a, b) => a.ch - b.ch);
  // stamps: episodes and effects in their own rings (an older bag's single ring is split by kind)
  const evs: VoyageStamp[] = [], fx: VoyageStamp[] = [];
  const ids = new Set<number>();
  for (const list of [x.stamps, x.fx]) if (Array.isArray(list)) for (const s of list.map(obj)) {
    if (!isStampKind(s.k) || !(num(s.at) > 0) || !(num(s.id) >= 0)) continue;
    const st: VoyageStamp = { id: Math.floor(num(s.id)) % 2147483647, at: num(s.at), k: s.k };
    if (Number.isFinite(num(s.arg)) && isEventKind(s.k)) st.arg = Math.round(num(s.arg) * 100) / 100;   // (effects carry none)
    const who = voyageName(s.who);
    if (who) st.who = who;
    if (ids.has(st.id)) continue;
    ids.add(st.id);
    (isEventKind(st.k) ? evs : fx).push(st);
  }
  evs.sort(byAt); fx.sort(byAt);
  const pace: VoyagePace[] = [];
  if (Array.isArray(x.pace)) for (const p of x.pace.map(obj)) {
    const v = num(p.v), ch = num(p.ch), s = num(p.s);
    if (!(v >= 0) || !(ch >= 0) || !(s >= 0) || !(VOYAGE_PACINGS as readonly unknown[]).includes(p.was)) continue;
    const q = pace[pace.length - 1];
    if (q && !(v > q.v && ch > q.ch && s > q.s)) continue;
    pace.push({ v, ch: Math.floor(ch), s, was: p.was as VoyagePacing });
  }
  const tiers = Array.isArray(sup.tiers) ? sup.tiers.map(num).filter((t) => t >= 0 && t <= 100000).slice(0, TIER_KINDS.length) : null;
  const intensity: Partial<Record<string, Intensity>> = {};
  for (const [k, v] of Object.entries(inten)) if (/^[a-z]{2,16}$/.test(k) && (v === 'full' || v === 'background' || v === 'off')) intensity[k] = v;
  const seed = num(x.seed), epoch = num(x.epoch), sway = num(x.sway), dayLen = num(x.dayLen), nightShare = num(x.nightShare), hour = num(x.hour);
  return {
    v: 1,
    on: bool(x.on, true),
    seed: seed >= 0 ? Math.floor(seed) % 2147483647 : 1,
    epoch: epoch > 0 && epoch < 1e14 ? epoch : 0,
    heldMs,
    pacing: (VOYAGE_PACINGS as readonly unknown[]).includes(x.pacing) ? x.pacing as VoyagePacing : 'normal',
    events: { battles: bool(ev.battles, true), storms: bool(ev.storms, true), treasure: bool(ev.treasure, true), cities: bool(ev.cities, true) },
    env: x.env === 'state' || x.env === 'fixed' ? x.env : 'journey',
    dayLen: dayLen >= 1 && dayLen <= 4 ? Math.round(dayLen) : 2,
    nightShare: nightShare >= 0.15 && nightShare <= 0.45 ? nightShare : 0.3,
    hour: hour >= 0 && hour < 24 ? hour : 16.5,
    sway: sway >= 0 ? Math.min(1.5, sway) : 1,
    talkCuts: bool(x.talkCuts, false), extCams: bool(x.extCams, true), intensity,
    holds, stamps: evs.slice(-EVENT_RING), fx: fx.slice(-FX_RING), forks: forks.slice(-FORK_KEEP), votes: bool(x.votes, true),
    support: { on: bool(sup.on, true), raids: bool(sup.raids, true), ...(tiers && tiers.length ? { tiers } : {}) },
    crew: { helm: crew.helm === 'performer' ? 'performer' : 'npc', ...(num(crew.count) >= 0 ? { count: Math.min(12, Math.floor(num(crew.count))) } : {}) },
    pace: pace.slice(-PACE_KEEP),
  };
}

/** The bag a page / the host reads: the host's bag with the room's defaults where the host never wrote one (seed from the
 *  room, the room's pacing). The host studio and every page use THIS, so the first host write changes nothing on air. */
export function voyageBagFrom(raw: unknown, cfg: RoomVoyageConfig | null | undefined, roomId: string, seedOverride?: number | null): VoyageBag {
  const b = sanitizeVoyage(raw);
  const r = obj(raw);
  if (typeof r.seed !== 'number') {
    const cs = num(cfg?.seed);
    b.seed = typeof seedOverride === 'number' && Number.isFinite(seedOverride) ? Math.floor(Math.abs(seedOverride)) % 2147483647
      : cs >= 0 ? Math.floor(cs) % 2147483647 : voyageHash(roomId.split('~')[0]) % 100000;
  }
  if (typeof r.pacing !== 'string' && cfg?.pacing && (VOYAGE_PACINGS as readonly unknown[]).includes(cfg.pacing)) b.pacing = cfg.pacing;
  return b;
}

/** Guest studios: the host's clock -> ours (controller.ts onHostState, next to shiftYachtClock). An unstamped epoch is
 *  the shared default VOYAGE_EPOCH0 on the HOST's clock, so it moves too. */
export function shiftVoyageClock(modes: Record<string, unknown> | undefined, off: number) {
  const b = modes?.[VOYAGE_BAG] as { epoch?: unknown; holds?: unknown; stamps?: unknown; fx?: unknown } | undefined;
  if (!b || typeof b !== 'object' || !Number.isFinite(off)) return;
  b.epoch = (typeof b.epoch === 'number' && b.epoch > 0 && b.epoch < 1e14 ? b.epoch : VOYAGE_EPOCH0) + off;
  for (const list of [b.holds, b.stamps, b.fx]) if (Array.isArray(list)) for (const h of list as { at?: unknown; until?: unknown }[]) {
    if (!h || typeof h !== 'object') continue;
    if (typeof h.at === 'number') h.at += off;
    if (typeof h.until === 'number') h.until += off;
  }
}

// ------------------------------------------------------------------------------------------------ support -> stamps
/** Effective tiers: the bag's over the room's over the defaults (7 ascending thresholds). */
export function voyageTierLines(bag: VoyageBag, room?: RoomVoyageConfig | null): number[] {
  const out: number[] = [...DEFAULT_TIERS];
  const r = room?.support?.tiers, b = bag.support.tiers;
  for (const src of [r, b]) if (Array.isArray(src)) src.forEach((v, i) => { if (i < out.length && typeof v === 'number' && v >= 0) out[i] = v; });
  return out;
}
/** The stamps one support event reaches: the effects add up ($10 = whistle + salute + special + broadside); of the
 *  episodes only the biggest one reached ($50 = "Dig here!", not also a raider: two episodes from one tip could never
 *  both find a clear moment). Raid = the convoy; subs / memberships / gifts = a whistle (merged in bursts by the queue). */
export function voyageTiers(usd: number, tiers: readonly number[], fkind = ''): StampKind[] {
  if (fkind === 'raid') return ['convoy'];
  if (/^(sub|resub|membership|milestone|giftSub|giftMembership)$/.test(fkind) && usd < (tiers[1] ?? 3)) return ['whistle'];
  const out: StampKind[] = [];
  let episode: StampKind | null = null;
  TIER_KINDS.forEach((k, i) => { const t = tiers[i]; if (typeof t === 'number' && t > 0 && usd >= t) { if (isEventKind(k)) episode = k; else out.push(k); } });
  if (episode) out.push(episode);
  return out;
}
/** Kick channel-point reward title -> stamp (room keywords first, longest first; then the kind names; else whistle). */
export function voyageRewardKind(title: string, map?: Record<string, StampKind>): StampKind {
  const t = title.toLowerCase();
  const m = map ?? {};
  for (const k of Object.keys(m).sort((a, b) => b.length - a.length)) if (t.includes(k.toLowerCase()) && isStampKind(m[k])) return m[k];
  if (/raider|summon|enemy|attack|battle/.test(t)) return 'battle';
  if (/dig|treasure|chest/.test(t)) return 'treasure';
  if (/broadside|cannon|fire all/.test(t)) return 'broadside';
  if (/firework|flare/.test(t)) return 'fireworks';
  if (/salute|shot|gun/.test(t)) return 'salute';
  if (/sandwich|special|deli|chef/.test(t)) return 'special';
  if (/storm|sand/.test(t)) return 'storm';
  if (/convoy|skiff|escort/.test(t)) return 'convoy';
  return 'whistle';
}

// ------------------------------------------------------------------------------------------------ voyage time
/** Seconds held by the host's holds up to `now` (ms). Closed form (smoothstep rate ramps of HOLD_RAMP s). */
export function voyageHeld(holds: readonly VoyageHold[], now: number): number {
  const R = HOLD_RAMP;
  let sum = 0;
  for (const h of holds) {
    const a = h.at / 1000, t = now / 1000;
    if (t <= a) continue;
    const u = h.until === null ? Infinity : h.until / 1000;
    if (t < a + R) { sum += R * P((t - a) / R); continue; }
    if (t < u) { sum += R / 2 + (t - a - R); continue; }
    if (t < u + R) { sum += R / 2 + (u - a - R) + (t - u) - R * P((t - u) / R); continue; }
    sum += u - a;
  }
  return sum;
}
/** Rate of voyage time at `now` (1 = walking, 0 = held). */
export function voyageRate(holds: readonly VoyageHold[], now: number): number {
  const R = HOLD_RAMP, t = now / 1000;
  for (const h of holds) {
    const a = h.at / 1000, u = h.until === null ? Infinity : h.until / 1000;
    if (t <= a || t >= u + R) continue;
    if (t < u) return 1 - smooth01((t - a) / R);
    return smooth01((t - u) / R);
  }
  return 1;
}
/** Voyage seconds at wall-clock `now` (ms). */
export function voyageTime(bag: Pick<VoyageBag, 'epoch' | 'holds'> & { heldMs?: number }, now: number): number {
  const ep = bag.epoch > 0 ? bag.epoch : VOYAGE_EPOCH0;
  return Math.max(0, (now - ep - (bag.heldMs ?? 0)) / 1000 - voyageHeld(bag.holds, now));
}
/** Wall-clock ms at which voyage time reaches `v` (searching from `from` ms; Infinity while anchored for good). */
export function voyageWallOf(bag: Pick<VoyageBag, 'epoch' | 'holds'> & { heldMs?: number }, v: number, from: number): number {
  if (voyageTime(bag, from) >= v) return from;
  let lo = from, hi = from + 1000 * (v - voyageTime(bag, from)) + 1;
  for (const h of bag.holds) if (h.until !== null && h.until > from) hi += h.until - Math.max(h.at, from) + HOLD_RAMP * 2000;
  if (voyageTime(bag, hi) < v) return Infinity;
  for (let i = 0; i < 60 && hi - lo > 0.5; i++) { const mid = (lo + hi) / 2; if (voyageTime(bag, mid) >= v) hi = mid; else lo = mid; }
  return hi;
}

// ------------------------------------------------------------------------------------------------ chapters + beats
export interface SpeedSeg { t0: number; t1: number; v0: number; v1: number }
export interface Beat {
  kind: BeatKind;
  /** chapter-relative seconds */ t0: number; t1: number;
  seed: number;
  /** encounter: approach / battle / aftermath lengths; city: closest approach time; treasure: brake / stop / start */
  a?: number; b?: number; c?: number;
  enemy?: EnemyKind;
  city?: CityKind;
  /** +1 starboard, -1 port */ side?: number;
  /** city / dig site lateral distance (m) */ off?: number;
}
export interface LegPlan {
  leg: number; seed: number; flavour: Flavour; pacing: VoyagePacing;
  dur: number; dist: number; k: number;
  beats: Beat[];
  segs: SpeedSeg[];
  /** chapter-relative metres at each seg start (length segs.length + 1) */ segS: number[];
  fork: [Flavour, Flavour];
}

const segDist = (g: SpeedSeg, t: number) => {
  const R = g.t1 - g.t0;
  if (R <= 0) return 0;
  const u = clamp((t - g.t0) / R, 0, 1);
  return R * (g.v0 * u + (g.v1 - g.v0) * P(u));
};
const segV = (g: SpeedSeg, t: number) => { const R = g.t1 - g.t0; return R <= 0 ? g.v1 : g.v0 + (g.v1 - g.v0) * smooth01((t - g.t0) / R); };
const segA = (g: SpeedSeg, t: number) => { const R = g.t1 - g.t0; if (R <= 0 || g.v0 === g.v1) return 0; const u = clamp((t - g.t0) / R, 0, 1); return ((g.v1 - g.v0) / R) * 6 * u * (1 - u); };

function speedsOf(cfg?: RoomVoyageConfig | null): VoyageSpeeds {
  const s = { ...DEFAULT_SPEEDS };
  const c = cfg?.gait?.speeds ?? {};
  for (const k of Object.keys(s) as (keyof VoyageSpeeds)[]) { const v = num(c[k]); if (v > 0 && v < 40) s[k] = v; }
  return s;
}
export function chapterSec(pacing: VoyagePacing, cfg?: RoomVoyageConfig | null) { const v = num(cfg?.chapter?.[pacing]); return v >= 300 && v <= 7200 ? v : LEG_SEC[pacing]; }
export function chapterDist(pacing: VoyagePacing, cfg?: RoomVoyageConfig | null) { const v = num(cfg?.chapterDist?.[pacing]); return v >= 300 && v <= 50000 ? v : LEG_DIST[pacing]; }

/** Where a chapter sits: its index, pacing, length (s / m), and its start in voyage seconds (v0) and metres (s0). */
export interface ChapterRef { leg: number; pacing: VoyagePacing; C: number; D: number; v0: number; s0: number }
type PaceBag = Pick<VoyageBag, 'pacing'> & { pace?: readonly VoyagePace[] };
/** the pacing after anchor i (the next anchor's `was`, or the bag's pacing for the last one) */
const paceAfter = (bag: PaceBag, i: number): VoyagePacing => (bag.pace && i + 1 < bag.pace.length ? bag.pace[i + 1].was : bag.pacing);
function refFrom(bag: PaceBag, cfg: RoomVoyageConfig | null | undefined, i: number, n: number): ChapterRef {
  // n chapters from anchor i (i = -1: from 0 with no anchor; n < 0 = backwards with the first anchor's `was`)
  const ps = bag.pace ?? [];
  if (i < 0 && !ps.length) { const C = chapterSec(bag.pacing, cfg), D = chapterDist(bag.pacing, cfg); return { leg: n, pacing: bag.pacing, C, D, v0: n * C, s0: n * D }; }
  if (i < 0) { const a = ps[0], C = chapterSec(a.was, cfg), D = chapterDist(a.was, cfg); return { leg: a.ch + n, pacing: a.was, C, D, v0: a.v + n * C, s0: a.s + n * D }; }
  const a = ps[i], p = paceAfter(bag, i), C = chapterSec(p, cfg), D = chapterDist(p, cfg);
  return { leg: a.ch + n, pacing: p, C, D, v0: a.v + n * C, s0: a.s + n * D };
}
/** The chapter running at voyage time V. */
export function chapterAtV(bag: PaceBag, cfg: RoomVoyageConfig | null | undefined, V: number): ChapterRef {
  const ps = bag.pace ?? [];
  if (!ps.length) { const C = chapterSec(bag.pacing, cfg); return refFrom(bag, cfg, -1, Math.floor(V / C)); }
  let i = ps.length - 1;
  while (i >= 0 && ps[i].v > V) i--;
  if (i < 0) { const C = chapterSec(ps[0].was, cfg); return refFrom(bag, cfg, -1, -Math.min(ps[0].ch, Math.max(1, Math.ceil((ps[0].v - V) / C)))); }
  return refFrom(bag, cfg, i, Math.floor((V - ps[i].v) / chapterSec(paceAfter(bag, i), cfg)));
}
/** The chapter that holds distance s (m). */
export function chapterAtS(bag: PaceBag, cfg: RoomVoyageConfig | null | undefined, s: number): ChapterRef {
  const ps = bag.pace ?? [];
  if (!ps.length) { const D = chapterDist(bag.pacing, cfg); return refFrom(bag, cfg, -1, Math.floor(s / D)); }
  let i = ps.length - 1;
  while (i >= 0 && ps[i].s > s) i--;
  if (i < 0) { const D = chapterDist(ps[0].was, cfg); return refFrom(bag, cfg, -1, -Math.min(ps[0].ch, Math.max(1, Math.ceil((ps[0].s - s) / D)))); }
  return refFrom(bag, cfg, i, Math.floor((s - ps[i].s) / chapterDist(paceAfter(bag, i), cfg)));
}
/** Chapter `leg` by index. */
export function chapterRef(bag: PaceBag, cfg: RoomVoyageConfig | null | undefined, leg: number): ChapterRef {
  const ps = bag.pace ?? [];
  if (!ps.length) return refFrom(bag, cfg, -1, leg);
  let i = ps.length - 1;
  while (i >= 0 && ps[i].ch > leg) i--;
  return i < 0 ? refFrom(bag, cfg, -1, leg - ps[0].ch) : refFrom(bag, cfg, i, leg - ps[i].ch);
}

/** Is this fork stamp in time (stamped in its own chapter, >= FORK_FINAL s before the boundary)? Legacy forks (no v) count. */
export function forkInTime(bag: VoyageBag, cfg: RoomVoyageConfig | null | undefined, f: VoyageFork): boolean {
  if (typeof f.v !== 'number') return true;
  const ref = chapterAtV(bag, cfg, f.v);
  return ref.leg === f.ch && f.v <= ref.v0 + ref.C - FORK_FINAL + 1e-6;
}
/** The fork choice that led INTO chapter `ch` (the vote at the end of ch-1): the host's stamp (if in time), else the
 *  seeded pick. */
export function forkChoice(bag: Pick<VoyageBag, 'seed' | 'forks'> & Partial<VoyageBag>, ch: number, cfg?: RoomVoyageConfig | null): 0 | 1 {
  if (ch <= 0) return 0;
  const f = bag.forks.find((q) => q.ch === ch - 1);
  if (f && (typeof f.v !== 'number' || !bag.pacing || forkInTime(bag as VoyageBag, cfg, f))) return f.choice;
  return (voyageHash(bag.seed, 'fork', ch - 1) & 1) as 0 | 1;
}
/** Chapter `ch`'s fork state at voyage time V: the seeded pick, the effective choice, and how far the voted content has
 *  faded in (0..1, over FORK_FADE s of voyage time from the stamp; 1 when the vote matches the seeded pick). */
export function forkState(bag: VoyageBag, cfg: RoomVoyageConfig | null | undefined, ch: number, V: number): { def: 0 | 1; choice: 0 | 1; w: number } {
  const def = ch <= 0 ? 0 : (voyageHash(bag.seed, 'fork', ch - 1) & 1) as 0 | 1;
  const choice = forkChoice(bag, ch, cfg);
  if (choice === def) return { def, choice, w: 1 };
  const f = bag.forks.find((q) => q.ch === ch - 1);
  return { def, choice, w: typeof f?.v === 'number' ? smooth01((V - f.v) / FORK_FADE) : 1 };
}
/** The flavour of chapter `ch` for a fork choice (pure; what legPlan uses). */
export function flavourOf(seed: number, ch: number, choice: 0 | 1): Flavour {
  if (ch <= 0) return FLAVOURS[voyageHash(seed, 'fl0') % FLAVOURS.length];
  return FORK_PAIRS[voyageHash(seed, 'pair', ch - 1) % FORK_PAIRS.length][choice];
}
/** What the terrain needs from the timeline at voyage time V (the placeholder ground and the desert lane's world):
 *  the chapter that holds a distance, and each chapter's biome multipliers with an open fork vote cross-faded in. */
export function voyageGroundBinding(bag: VoyageBag, cfg: RoomVoyageConfig | null | undefined, V: number) {
  const memo = new Map<number, { dune: number; hill: number }>();
  return {
    chapterAt: (s: number) => { const r = chapterAtS(bag, cfg, s); return { ch: r.leg, s0: r.s0, s1: r.s0 + r.D }; },
    /** the chapter's LAYOUT flavour (the default fork choice: a vote never changes what already stands in the desert) */
    flavourAt: (ch: number) => flavourOf(bag.seed, ch, ch <= 0 ? 0 : (voyageHash(bag.seed, 'fork', ch - 1) & 1) as 0 | 1),
    biomeOf: (ch: number) => {
      let b = memo.get(ch);
      if (!b) {
        const f = forkState(bag, cfg, ch, V);
        const A = FLAVOUR_BIOME[flavourOf(bag.seed, ch, f.def)], B = FLAVOUR_BIOME[flavourOf(bag.seed, ch, f.choice)];
        const w = f.choice === f.def ? 1 : f.w;
        b = { dune: A.dune + (B.dune - A.dune) * w, hill: A.hill + (B.hill - A.hill) * w };
        if (memo.size > 16) memo.clear();
        memo.set(ch, b);
      }
      return b;
    },
  };
}

/** A treasure stop's stop part (s): kneel, sortie, rise - 60..85 s (pure: the crew plan reads the same number). */
export function stopDuration(seed: number): number { return Math.round(60 + 25 * voyageRand(seed, 77)); }

const planCache = new Map<string, LegPlan>();

/** One chapter's plan (pure; cached). Layout from (seed, chapter); content from the fork choice that led here. */
export function legPlan(seed: number, leg: number, choice: 0 | 1, pacing: VoyagePacing, cfg?: RoomVoyageConfig | null): LegPlan {
  const sp = speedsOf(cfg);
  const C = chapterSec(pacing, cfg), D = chapterDist(pacing, cfg);
  const key = `${seed}|${leg}|${choice}|${pacing}|${sp.cruise},${sp.city},${sp.battle},${sp.storm}|${C}|${D}|${cfg?.dangerSide ?? ''}`;
  const hit = planCache.get(key);
  if (hit) return hit;
  const ls = voyageHash(seed, leg, 'leg');
  const cs = voyageHash(seed, leg, choice, 'content');
  const r = (i: number, j = 0) => voyageRand(ls, i, j);
  const rc = (i: number, j = 0) => voyageRand(cs, i, j);
  const flavour: Flavour = flavourOf(seed, leg, choice);
  const fork = FORK_PAIRS[voyageHash(seed, 'pair', leg) % FORK_PAIRS.length];
  const odds = ODDS[pacing];
  // ---- candidate beats (layout from ls only)
  type Draft = { kind: BeatKind; d: number; prio: number; extra: Partial<Beat> };
  const drafts: Draft[] = [];
  const enemyPick = (i: number): EnemyKind => {
    const u = rc(i);
    const w = flavour === 'canyon' ? [0.25, 0.25, 0.45, 0.05] : flavour === 'dunes' ? [0.55, 0.25, 0.15, 0.05] : [0.4, 0.3, 0.25, 0.05];
    let acc = 0; for (let k = 0; k < 4; k++) { acc += w[k]; if (u < acc) return ENEMY_KINDS[k]; } return 'gnashers';
  };
  const dangerSide = (cfg?.dangerSide ?? 'aft-port').includes('starboard') ? 1 : -1;
  if (r(1) < odds.enc) drafts.push({ kind: 'encounter', d: ENC.total, prio: 5, extra: { enemy: enemyPick(2), a: ENC.approach, b: ENC.battle, c: ENC.after, side: dangerSide } });
  if (r(3) < odds.enc2) drafts.push({ kind: 'encounter', d: ENC.total, prio: 1, extra: { enemy: enemyPick(4), a: ENC.approach, b: ENC.battle, c: ENC.after, side: dangerSide } });
  const cityKinds: Record<Flavour, CityKind[]> = { oasis: ['cistern'], bazaar: ['souk'], canyon: ['windtower', 'hulk'], dunes: ['windtower', 'cistern'], ruins: ['hulk', 'windtower'], saltflat: ['hulk', 'souk'] };
  const ck = cityKinds[flavour];
  if (r(5) < odds.city) drafts.push({ kind: 'city', d: Math.round(110 + 40 * r(6)), prio: 4, extra: { city: ck[Math.floor(rc(7) * ck.length) % ck.length], off: Math.round(250 + 350 * r(8)), side: r(9) < 0.7 ? 1 : -1 } });
  if (r(10) < odds.storm) drafts.push({ kind: 'storm', d: Math.round(90 + 60 * r(11)), prio: 2, extra: {} });
  if (r(12) < odds.treasure) { const stop = stopDuration(voyageHash(ls, 'stop')); drafts.push({ kind: 'treasure', d: 8 + stop + 10, prio: 3, extra: { a: 8, b: stop, c: 10, off: Math.round(20 + 10 * r(13)), side: r(14) < 0.75 ? 1 : -1 } }); }
  // ---- fit: opening cruise >= 120, >= 90 between, tail >= the fork window + 30; drop the least important first
  const head = 120, tail = FORK_SEC + 30, gap = 90;
  const need = () => head + tail + drafts.reduce((a, d) => a + d.d, 0) + gap * Math.max(0, drafts.length - 1) + (drafts.some((d) => d.kind === 'storm') ? STORM_APPROACH : 0);
  while (drafts.length && need() > C) { let lo = 0; drafts.forEach((d, i) => { if (d.prio < drafts[lo].prio) lo = i; }); drafts.splice(lo, 1); }
  // ---- order: seeded Fisher-Yates; two encounters never adjacent when there is anything to put between them
  for (let i = drafts.length - 1; i > 0; i--) { const j = Math.floor(r(20 + i) * (i + 1)) % (i + 1); const t = drafts[i]; drafts[i] = drafts[j]; drafts[j] = t; }
  if (drafts.some((d, i) => i > 0 && d.kind === 'encounter' && drafts[i - 1].kind === 'encounter') && drafts.some((d) => d.kind !== 'encounter')) {
    // two encounters: one opens, one closes the chapter, everything else between them
    const enc = drafts.filter((d) => d.kind === 'encounter'), rest = drafts.filter((d) => d.kind !== 'encounter');
    drafts.splice(0, drafts.length, enc[0], ...rest, ...enc.slice(1));
  }
  // a storm needs its approach inside the gap before it (the haboob is seen coming)
  const free = Math.max(0, C - need());
  const w = drafts.map((_, i) => 0.35 + r(40 + i));
  w.push(0.35 + r(49));
  const wsum = w.reduce((a, b) => a + b, 0);
  const beats: Beat[] = [];
  let t = head + (free * w[0]) / wsum;
  drafts.forEach((d, i) => {
    if (d.kind === 'storm') t += STORM_APPROACH;
    const t0 = Math.round(t), t1 = t0 + d.d;
    beats.push({ kind: d.kind, t0, t1, seed: voyageHash(cs, i, d.kind), ...d.extra });
    t = t1 + gap + (free * w[i + 1]) / wsum;
  });
  // ---- speed segments (6 s ramps; the stop brakes over 8 s and starts over 10 s). Speeds are symbolic first: a cruise
  // speed c and beat speeds scaled by k; the distance is linear in both (dist = c*A + k*B), so the chapter covers exactly D:
  // one uniform scale k = D / raw when it lies in [0.85, 1.15], else k clamped and the cruise filler takes the rest.
  const RAMP = 6;
  type SSeg = { t0: number; t1: number; c0: number; b0: number; c1: number; b1: number };
  const ss: SSeg[] = [];
  let cur = 0, vc = 1, vb = 0;
  const hold = (to: number) => { if (to > cur + 1e-6) { ss.push({ t0: cur, t1: to, c0: vc, b0: vb, c1: vc, b1: vb }); cur = to; } };
  const ramp = (to: number, c1: number, b1: number) => { if (to > cur + 1e-6) { ss.push({ t0: cur, t1: to, c0: vc, b0: vb, c1, b1 }); cur = to; } vc = c1; vb = b1; };
  for (const b of beats) {
    const target = b.kind === 'encounter' ? sp.battle : b.kind === 'city' ? sp.city : b.kind === 'storm' ? sp.storm : 0;
    if (b.kind === 'treasure') { hold(b.t0); ramp(b.t0 + (b.a ?? 8), 0, 0); hold(b.t1 - (b.c ?? 10)); ramp(b.t1, 1, 0); continue; }
    hold(b.t0); ramp(b.t0 + RAMP, 0, target); hold(b.t1 - RAMP); ramp(b.t1, 1, 0);
  }
  hold(C);
  let A = 0, Bd = 0;
  for (const g of ss) { const R = g.t1 - g.t0; A += R * (g.c0 + g.c1) / 2; Bd += R * (g.b0 + g.b1) / 2; }
  const raw = sp.cruise * A + Bd;
  let k = raw > 0 ? D / raw : 1;
  let c = sp.cruise * k;
  if (k < 0.85 || k > 1.15) { k = clamp(k, 0.85, 1.15); c = A > 0 ? (D - k * Bd) / A : sp.cruise; }
  const segs: SpeedSeg[] = ss.map((g) => ({ t0: g.t0, t1: g.t1, v0: g.c0 * c + g.b0 * k, v1: g.c1 * c + g.b1 * k }));
  const segS = [0];
  for (const g of segs) segS.push(segS[segS.length - 1] + segDist(g, g.t1));
  for (const b of beats) if (b.kind === 'city') b.a = (b.t0 + b.t1) / 2;
  const plan: LegPlan = { leg, seed: cs, flavour, pacing, dur: C, dist: D, k, beats, segs, segS, fork };
  if (planCache.size > 64) planCache.delete(planCache.keys().next().value as string);
  planCache.set(key, plan);
  return plan;
}
export const chapterPlan = legPlan;
/** Chapter `leg`'s plan as the bag has it (its pacing, the fork that led into it). */
export function chapterPlanOf(bag: VoyageBag, cfg: RoomVoyageConfig | null | undefined, leg: number, choice?: 0 | 1): LegPlan {
  return legPlan(bag.seed, leg, choice ?? forkChoice(bag, leg, cfg), chapterRef(bag, cfg, leg).pacing, cfg);
}

/** Chapter-relative distance (m), speed (m/s of voyage time) and acceleration at chapter time t (s). */
export function legMotion(plan: LegPlan, t: number): { s: number; v: number; a: number; seg: number } {
  const segs = plan.segs;
  const tt = clamp(t, 0, plan.dur);
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (segs[m].t0 <= tt) lo = m; else hi = m - 1; }
  const g = segs[lo];
  return { s: plan.segS[lo] + segDist(g, tt), v: segV(g, tt), a: segA(g, tt), seg: lo };
}

/** The beat running at chapter time t (null = cruise). */
export function beatAt(plan: LegPlan, t: number): Beat | null {
  for (const b of plan.beats) if (t >= b.t0 && t < b.t1) return b;
  return null;
}

/** Journey hour (SPEC D14) at a position counted in chapters (chapter index + the fraction done): u over `dayLen`
 *  chapters; day = (1 - nightShare) of it with dawn / golden / blue hours stretched x1.6 and noon compressed; night = the
 *  rest. Sunrise 6.2, sunset 19.0 (the room's environment). */
export function journeyHourPos(pos: number, dayLen = 2, nightShare = 0.3, sunrise = 6.2, sunset = 19.0): number {
  const u = ((pos / Math.max(1, dayLen)) % 1 + 1) % 1;
  const dayU = 1 - nightShare;
  if (u < dayU) {
    const x = u / dayU;
    const g = x + (0.6 * Math.sin(2 * Math.PI * x)) / (2 * Math.PI);    // slope 1.6 at the ends, 0.4 at noon
    return sunrise + (sunset - sunrise) * g;
  }
  const x = (u - dayU) / nightShare;
  return (sunset + (24 - sunset + sunrise) * x) % 24;
}
/** journeyHourPos at V voyage seconds of C-second chapters (one pacing all along). */
export function journeyHour(V: number, C: number, dayLen = 2, nightShare = 0.3, sunrise = 6.2, sunset = 19.0): number {
  return journeyHourPos(V / C, dayLen, nightShare, sunrise, sunset);
}

// ------------------------------------------------------------------------------------------------ stamps in play
/** A stamp's play length (s). */
export function stampDur(bag: Pick<VoyageBag, 'seed'>, s: VoyageStamp): number {
  return s.k === 'treasure' ? 8 + stopDuration(voyageHash(bag.seed, 'stamp', s.id)) + 10 : STAMP_DUR[s.k];
}
/** Wall ms after which a stamp shows nothing at all (duration + tail). */
export function stampEnd(bag: Pick<VoyageBag, 'seed'>, s: VoyageStamp): number { return s.at + (stampDur(bag, s) + STAMP_TAIL[s.k]) * 1000; }
export interface StampPlay { stamp: VoyageStamp; tau: number; dur: number; seed: number }
/** Stamps playing (or still smoking) at `now`, both rings. Pure. */
export function stampPlays(bag: VoyageBag, now: number, tail = 60): StampPlay[] {
  const out: StampPlay[] = [];
  for (const list of [bag.stamps, bag.fx ?? []]) for (const s of list) {
    const tau = (now - s.at) / 1000;
    const seed = voyageHash(bag.seed, 'stamp', s.id);
    const dur = s.k === 'treasure' ? 8 + stopDuration(seed) + 10 : STAMP_DUR[s.k];
    if (tau < -2 || tau > dur + tail) continue;
    out.push({ stamp: s, tau, dur, seed });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the state at a moment
export type EncounterPhase = 'approach' | 'battle' | 'defeat';
export type EncounterSub = 'alarm' | 'approach' | 'exchange' | 'climax' | 'defeat' | 'aftermath';
export type StopPhase = 'brake' | 'kneel' | 'dig' | 'carry' | 'rise' | 'start';
export interface VoyageStop { phase: StopPhase; tau: number; kneel: number; stop: number; seed: number; side: number; off: number; stamped: boolean; at: number }
export interface VoyageNow {
  now: number;
  /** voyage seconds */ V: number;
  leg: number; tLeg: number; u: number;
  /** the running chapter: pacing, length, start (voyage s / metres) */ chap: ChapterRef;
  plan: LegPlan;
  /** total metres walked (double) */ S: number;
  /** world speed (m/s, includes the hold rate) and acceleration */ v: number; a: number;
  rate: number;
  beat: Beat | null;
  /** seconds into the beat */ tb: number;
  encounter: { phase: EncounterPhase; sub: EncounterSub; tau: number } | null;
  stop: VoyageStop | null;
  storm: number;
  /** haboob wall approach 0 (far) .. 1 (arrived); null = no wall */ stormFront: number | null;
  /** 0..24 (journey; the env drive pins Preshow / BRB / Outro) */ hour: number;
  night: number;
  fork: { open: boolean; in: number; pair: [Flavour, Flavour] };
}

function stopFrom(tb: number, brake: number, stop: number, start: number, kneelSecs = 6): { phase: StopPhase; kneel: number } {
  const kneel = smooth01((tb - brake) / kneelSecs) * (1 - smooth01((tb - (brake + stop - kneelSecs)) / kneelSecs));
  const phase: StopPhase = tb < brake ? 'brake' : tb < brake + kneelSecs ? 'kneel' : tb < brake + stop * 0.55 ? 'dig' : tb < brake + stop - kneelSecs ? 'carry' : tb < brake + stop ? 'rise' : 'start';
  void start;
  return { phase, kneel: tb < brake + stop ? kneel : 0 };
}

export function voyageNow(bag: VoyageBag, cfg: RoomVoyageConfig | null | undefined, now: number): VoyageNow {
  const V = voyageTime(bag, now);
  const chap = chapterAtV(bag, cfg, V);
  const leg = chap.leg, LS = chap.C;
  const tLeg = V - chap.v0;
  const plan = legPlan(bag.seed, leg, forkChoice(bag, leg, cfg), chap.pacing, cfg);
  const m = legMotion(plan, tLeg);
  const rate = voyageRate(bag.holds, now);
  const S = chap.s0 + m.s;
  const beat = beatAt(plan, tLeg);
  const tb = beat ? tLeg - beat.t0 : 0;
  let encounter: VoyageNow['encounter'] = null, stop: VoyageNow['stop'] = null;
  if (beat?.kind === 'encounter') {
    const A = beat.a ?? ENC.approach, B = beat.b ?? ENC.battle;
    const phase: EncounterPhase = tb < A ? 'approach' : tb < A + B ? 'battle' : 'defeat';
    const sub: EncounterSub = tb < 3 ? 'alarm' : tb < A ? 'approach' : tb < A + ENC.climax ? 'exchange' : tb < A + B ? 'climax' : tb < A + B + 12 ? 'defeat' : 'aftermath';
    encounter = { phase, sub, tau: phase === 'approach' ? tb : phase === 'battle' ? tb - A : tb - A - B };
  }
  if (beat?.kind === 'treasure') {
    const br = beat.a ?? 8, st = beat.b ?? 70, rs = beat.c ?? 10;
    const s = stopFrom(tb, br, st, rs);
    stop = { ...s, tau: tb, stop: st, seed: beat.seed, side: beat.side ?? 1, off: beat.off ?? 24, stamped: false, at: now - tb * 1000 };
  }
  // stamped treasure stops (a hold carries the brake / start; the sequence runs on the wall clock)
  for (const p of stampPlays(bag, now, 0)) {
    if (p.stamp.k !== 'treasure' || stop) continue;
    const st = stopDuration(p.seed);
    const s = stopFrom(p.tau, 8, st, 10);
    if (p.tau >= 0 && p.tau < 8 + st + 10) stop = { ...s, tau: p.tau, stop: st, seed: p.seed, side: voyageRand(p.seed, 3) < 0.75 ? 1 : -1, off: Math.round(20 + 10 * voyageRand(p.seed, 4)), stamped: true, at: p.stamp.at };
  }
  // storm intensity: the base beats (approach 60 s, clearing 40 s) + stamped storms
  let storm = 0, front: number | null = null;
  for (const b of plan.beats) if (b.kind === 'storm') {
    storm = Math.max(storm, smooth01((tLeg - (b.t0 - 25)) / 25) * (1 - smooth01((tLeg - b.t1) / STORM_CLEAR)));
    if (tLeg > b.t0 - STORM_APPROACH && tLeg < b.t1 + STORM_CLEAR) front = clamp((tLeg - (b.t0 - STORM_APPROACH)) / STORM_APPROACH, 0, 1);
  }
  for (const p of stampPlays(bag, now, 0)) if (p.stamp.k === 'storm') {
    const inside = p.dur - STORM_APPROACH - STORM_CLEAR;
    storm = Math.max(storm, smooth01((p.tau - (STORM_APPROACH - 25)) / 25) * (1 - smooth01((p.tau - STORM_APPROACH - inside) / STORM_CLEAR)));
    if (p.tau >= 0 && p.tau < p.dur) front = Math.max(front ?? 0, clamp(p.tau / STORM_APPROACH, 0, 1));
  }
  const hour = bag.env === 'fixed' ? bag.hour : journeyHourPos(leg + tLeg / LS, bag.dayLen, bag.nightShare);
  const night = smooth01((Math.abs(((hour % 24) + 24) % 24 - 12) - 6.6) / 1.4);   // 0 by day, 1 from ~20:00 to ~4:00
  const forkIn = LS - FORK_SEC - tLeg;
  return {
    now, V, leg, tLeg, u: tLeg / LS, chap, plan, S, v: m.v * rate, a: m.a * rate, rate, beat, tb, encounter, stop, storm, stormFront: front, hour, night,
    fork: { open: forkIn <= 0, in: forkIn, pair: plan.fork },
  };
}

/** Distance walked (m) at wall-clock `now`. */
export function voyageDistance(bag: VoyageBag, cfg: RoomVoyageConfig | null | undefined, now: number): number {
  const V = voyageTime(bag, now);
  const chap = chapterAtV(bag, cfg, V);
  const plan = legPlan(bag.seed, chap.leg, forkChoice(bag, chap.leg, cfg), chap.pacing, cfg);
  return chap.s0 + legMotion(plan, V - chap.v0).s;
}

/** Earliest start for a hold / big stamp at `now`: after the running base encounter / city / treasure stop and after any
 *  stamped battle or treasure stop in play or queued (never mid-salvo). */
export function voyageBlockEnd(bag: VoyageBag, cfg: RoomVoyageConfig | null | undefined, now: number): number {
  let end = now;
  const st = voyageNow(bag, cfg, now);
  const b = st.beat;
  if (b && b.kind !== 'storm') {
    const w = voyageWallOf(bag, st.chap.v0 + b.t1, now);
    if (Number.isFinite(w)) end = Math.max(end, Math.ceil(w));
  }
  for (const s of bag.stamps) if ((s.k === 'battle' || s.k === 'treasure') && s.arg === undefined) {
    const e = s.at + stampDur(bag, s) * 1000;
    if (e > now) end = Math.max(end, e);
  }
  return end;
}
/** The first moment a new hold may start: one ramp after the last finished / closing hold (sanitize drops a hold that
 *  starts sooner, so a stop right after Weigh anchor would lose its hold). */
export function voyageHoldFree(bag: Pick<VoyageBag, 'holds'>): number {
  let t = 0;
  for (const h of bag.holds) if (h.until !== null) t = Math.max(t, h.until + HOLD_RAMP * 1000 + 1);
  return t;
}
/** Host "Anchor" stamp time. */
export function voyageHoldAt(bag: VoyageBag, cfg: RoomVoyageConfig | null | undefined, now: number): number {
  return Math.max(now + STAMP_LEAD, voyageBlockEnd(bag, cfg, now + STAMP_LEAD), voyageHoldFree(bag));
}
/** Host "Weigh anchor": the open hold's end - never before every stamped stop that stands on it has finished its stop. */
export function voyageWeighAt(bag: VoyageBag, now: number): number | null {
  const open = bag.holds.find((h) => h.until === null);
  if (!open) return null;
  let u = Math.max(now + STAMP_LEAD, open.at + HOLD_RAMP * 1000);
  for (const s of bag.stamps) if (s.k === 'treasure' && s.at >= open.at - 1 && stampEnd(bag, s) > now) u = Math.max(u, s.at + (8 + stopDuration(voyageHash(bag.seed, 'stamp', s.id))) * 1000);
  return u;
}
/** Is a stamped treasure stop held for its whole brake + stop (its own hold, or an open anchor that already holds)? */
export function voyageStopHeld(bag: VoyageBag, s: VoyageStamp): boolean {
  const end = s.at + (8 + stopDuration(voyageHash(bag.seed, 'stamp', s.id))) * 1000;
  return bag.holds.some((h) => h.at <= s.at + 1 && (h.until === null || h.until >= end - 1));
}

/** Host: tidy the bag before a write (pure): drop stamps that show nothing any more, fold finished holds into heldMs
 *  (SPEC 11.2 S1) once no stamp in play refers to a moment before them. V(t) for every t that any page still evaluates is
 *  unchanged (to the last bit for t after the folded hold). */
export function voyageCompact(bag: VoyageBag, now: number): VoyageBag {
  const live = (s: VoyageStamp) => stampEnd(bag, s) + 1000 > now;
  const b: VoyageBag = { ...bag, stamps: bag.stamps.filter(live), fx: bag.fx.filter(live), holds: [...bag.holds] };
  for (;;) {
    const h = b.holds[0];
    if (!h || h.until === null) break;
    const end = h.until + HOLD_RAMP * 1000;
    if (now < end + FOLD_MARGIN * 1000) break;
    if ([...b.stamps, ...b.fx].some((s) => s.at < end && stampEnd(b, s) + FOLD_MARGIN * 1000 > now)) break;
    b.heldMs += h.until - h.at;
    b.holds.shift();
  }
  return b;
}

/** Base beats near voyage seconds [vA, vB] in voyage seconds (chapter + index). */
function baseBeats(bag: VoyageBag, cfg: RoomVoyageConfig | null | undefined, vA: number, vB: number) {
  const out: { kind: BeatKind; v0: number; v1: number; leg: number; i: number }[] = [];
  const a = chapterAtV(bag, cfg, Math.max(0, vA - 400)).leg, z = chapterAtV(bag, cfg, vB + 400).leg;
  for (let leg = a; leg <= z && leg <= a + 3; leg++) {
    const ref = chapterRef(bag, cfg, leg);
    const plan = legPlan(bag.seed, leg, forkChoice(bag, leg, cfg), ref.pacing, cfg);
    plan.beats.forEach((x, i) => out.push({ kind: x.kind, v0: ref.v0 + x.t0, v1: ref.v0 + x.t1, leg, i }));
  }
  return out;
}
/** Why a stamped episode of kind k on wall window [at, at + dur s] would clash with the timeline (null = it fits):
 *  no battle in a storm (SPEC 2.4), none during a stop, no stop within REPAIR_GAP s after a battle, never two battles or
 *  two storms at once. `bag` already carries the episode's own hold (treasure). The voyage-time window is taken
 *  conservatively - a battle / storm spans `dur` s of voyage time, a stop its ramps - so no later Anchor / Weigh anchor
 *  can bring a base beat into an episode that has started (holds only ever shorten it). */
export function voyageClash(bag: VoyageBag, cfg: RoomVoyageConfig | null | undefined, k: StampKind, at: number, dur: number, selfId = -1): string | null {
  if (k !== 'battle' && k !== 'storm' && k !== 'treasure') return null;
  const vA = voyageTime(bag, at), vB = vA + (k === 'treasure' ? HOLD_RAMP : dur);
  for (const x of baseBeats(bag, cfg, vA, vB)) {
    let lo = x.v0, hi = x.v1;
    if (x.kind === 'encounter') { lo -= 5; hi += k === 'treasure' ? REPAIR_GAP : 5; }
    else if (x.kind === 'storm') { lo -= STORM_APPROACH; hi += STORM_CLEAR; }
    else if (x.kind === 'treasure') { if (k === 'battle') lo -= REPAIR_GAP; }
    else continue;
    if (vA < hi && vB > lo) return `${x.kind === 'encounter' ? 'a battle' : x.kind === 'storm' ? 'a sandstorm' : 'a treasure stop'} is due`;
  }
  const w0 = at, w1 = at + dur * 1000;
  for (const s of bag.stamps) {
    if (s.id === selfId || (s.k !== 'battle' && s.k !== 'storm' && s.k !== 'treasure') || (s.k === 'battle' && s.arg !== undefined)) continue;
    const s0 = s.at, s1 = s.at + stampDur(bag, s) * 1000;
    let lo = s0 - 5000, hi = s1 + 5000;
    if (k === 'battle' && s.k === 'treasure') lo = s0 - REPAIR_GAP * 1000;
    if (k === 'treasure' && s.k === 'battle') hi = s1 + REPAIR_GAP * 1000;
    if (k === 'treasure' && s.k === 'treasure') { lo = s0; hi = s1; }
    if (w0 < hi && w1 > lo) return `a stamped ${STAMP_LABEL[s.k]} is on`;
  }
  return null;
}

/** After the timeline moved under queued episodes (a hold added / weighed, a stamped stop's hold, a pacing switch):
 *  a queued (not yet started) battle or storm that would now clash moves to its next clear moment within
 *  SUPPORT_MAX_WAIT s, or is dropped; a raider that joined a base battle follows that battle's new start. Episodes on air
 *  never move. Mutates `bag` (a fresh copy); returns the dropped stamps. */
export function voyageReslot(bag: VoyageBag, cfg: RoomVoyageConfig | null | undefined, now: number): VoyageStamp[] {
  const dropped: VoyageStamp[] = [];
  const last = now + STAMP_LEAD + SUPPORT_MAX_WAIT * 1000;
  for (const s of [...bag.stamps].sort(byAt)) {
    if (s.at <= now + STAMP_LEAD || (s.k !== 'battle' && s.k !== 'storm')) continue;
    if (s.k === 'battle' && s.arg !== undefined) {
      const leg = Math.floor(s.arg / 16), i = Math.round(s.arg - leg * 16);
      const ref = chapterRef(bag, cfg, leg);
      const b = legPlan(bag.seed, leg, forkChoice(bag, leg, cfg), ref.pacing, cfg).beats[i];
      const w = b && b.kind === 'encounter' ? voyageWallOf(bag, ref.v0 + b.t0, now) : Infinity;
      if (Number.isFinite(w) && w > now + 1000) s.at = Math.round(w); else dropped.push(s);
      continue;
    }
    const dur = stampDur(bag, s);
    if (!voyageClash(bag, cfg, s.k, s.at, dur, s.id)) continue;
    let slot: number | null = null;
    for (let t = s.at + 1000; t <= last; t += 1000) if (!voyageClash(bag, cfg, s.k, t, dur, s.id)) { slot = t; break; }
    if (slot === null) dropped.push(s); else s.at = slot;
  }
  bag.stamps = bag.stamps.filter((s) => !dropped.includes(s)).sort(byAt);
  return dropped;
}

/** Host controller only: queue a stamp (SPEC 2.8 + 11.2 S2): at >= now + 2 s, after the running big beat and in a clear
 *  window (voyageClash) found within `maxWait` s (STAMP_MAX_WAIT for buttons, SUPPORT_MAX_WAIT for paid episodes), else
 *  dropped - a summoned raider joins a base battle that starts before its own first clear window (arg = that battle's
 *  chapter * 16 + beat index). At most one pending
 *  battle and one pending treasure; a burst of the same kind within 3 s merges. Episodes go to the `stamps` ring (<= 4,
 *  never evicted before they end: a full ring drops the new one), effects to the `fx` ring of 8 (the one closest to its end
 *  makes room). A treasure stamp gets its hold (or stands on an open anchor). Returns the new bag (a copy) or null when
 *  the stamp was merged / dropped (`why.reason` says why). `now` is the real clock (the bag is tidied and stamps on air are
 *  judged at it); `delayMs` (a support tier's offset) only moves when the stamp wants to start. */
export function voyageStamp(bag0: VoyageBag, cfg: RoomVoyageConfig | null | undefined, k: StampKind, now: number, who?: string, arg?: number, id?: number, why?: { reason?: string; dropped?: VoyageStamp[] }, maxWait = STAMP_MAX_WAIT, delayMs = 0): { bag: VoyageBag; stamp: VoyageStamp } | null {
  const no = (r: string) => { if (why) why.reason = r; return null; };
  const bag = voyageCompact(sanitizeVoyage(JSON.parse(JSON.stringify(bag0))), now);
  const ep = isEventKind(k);
  const name = voyageName(who);
  const t0 = now + Math.max(0, delayMs || 0);
  let at = t0 + STAMP_LEAD;
  if ((k === 'battle' || k === 'treasure') && bag.stamps.some((s) => s.k === k && s.at > now)) return no('one is already queued');
  if ((ep ? bag.stamps : bag.fx).some((s) => s.k === k && Math.abs(s.at - at) < 3000)) return no('merged with the one just queued');
  if (ep && bag.stamps.length >= EVENT_RING) return no('four events are already on');
  const sid = id ?? (voyageHash(k, Math.floor(t0), name, bag.stamps.length + bag.fx.length) % 2147483646) + 1;
  const stamp: VoyageStamp = { id: sid, at: Math.round(at), k, ...(arg !== undefined ? { arg } : {}), ...(name ? { who: name } : {}) };
  const open = bag.holds.find((h) => h.until === null);
  const last = t0 + STAMP_LEAD + Math.max(0, maxWait) * 1000;
  if (k === 'battle' || k === 'treasure' || k === 'storm' || k === 'city') {
    let from = Math.max(at, voyageBlockEnd(bag, cfg, at));
    if (k === 'treasure') from = open ? Math.max(from, open.at) : Math.max(from, voyageHoldFree(bag));
    const stop = stopDuration(voyageHash(bag.seed, 'stamp', sid));
    const dur = k === 'treasure' ? 8 + stop + 10 : STAMP_DUR[k];
    const withHold = (t: number): VoyageBag => (k === 'treasure' && !open ? { ...bag, holds: [...bag.holds, { at: t, until: t + (8 + stop) * 1000 }] } : bag);
    // a summoned raider may join a base battle that starts within the wait (named in its banner) - taken when it comes
    // before the first clear window of its own
    let join: { at: number; tag: number } | null = null;
    if (k === 'battle') {
      const V0 = voyageTime(bag, t0);
      for (const x of baseBeats(bag, cfg, V0, V0 + maxWait + 10)) {
        if (x.kind !== 'encounter') continue;
        const w = voyageWallOf(bag, x.v0, t0);
        const tag = x.leg * 16 + x.i;
        if (!Number.isFinite(w) || w < at || w > last || bag.stamps.some((s) => s.k === 'battle' && s.arg === tag)) continue;
        if (!join || w < join.at) join = { at: Math.round(w), tag };
      }
    }
    let slot: number | null = null, reason = '';
    for (let t = Math.ceil(from); t <= last && (!join || t < join.at); t += 1000) {
      const c = voyageClash(withHold(t), cfg, k, t, dur, sid);
      if (!c) { slot = t; break; }
      reason ||= c;
    }
    if (slot === null && join) {
      stamp.at = join.at; stamp.arg = join.tag;
      bag.stamps = [...bag.stamps, stamp].sort(byAt);
      return { bag: sanitizeVoyage(bag), stamp };
    }
    const span = maxWait >= 120 ? `${Math.round(maxWait / 60)} minutes` : 'a minute';
    if (slot === null) return no(from > last ? `the ship is busy for more than ${span}` : `no clear moment within ${span} (${reason || 'busy'})`);
    at = slot;
    stamp.at = Math.round(at);
    if (k === 'city' && stamp.arg === undefined) stamp.arg = Math.round(voyageDistance(bag, cfg, at + 75000) * 100) / 100;   // the city stays where it was put
    if (k === 'treasure' && !open) bag.holds = [...bag.holds, { at: stamp.at, until: stamp.at + (8 + stop) * 1000 }];
  }
  if (ep) bag.stamps = [...bag.stamps.filter((s) => s.id !== sid), stamp].sort(byAt);
  else {
    let fx = [...bag.fx.filter((s) => s.id !== sid)];
    while (fx.length >= FX_RING) { let j = 0; fx.forEach((s, i) => { if (stampEnd(bag, s) < stampEnd(bag, fx[j])) j = i; }); fx.splice(j, 1); }
    bag.fx = [...fx, stamp].sort(byAt);
  }
  const out = sanitizeVoyage(bag);
  if (ep && !out.stamps.some((s) => s.id === sid)) return no('the event ring is full');
  if (k === 'treasure' && !voyageStopHeld(out, stamp)) return no('the stop could not get its hold');
  // a stop's hold moves every later base beat: queued battles / storms find their clear moment again
  if (k === 'treasure') { const d = voyageReslot(out, cfg, now); if (why && d.length) why.dropped = d; }
  return { bag: out, stamp };
}

/** Host: anchor (true) / weigh anchor (false) - pure. An anchor waits for the running battle / city / stop and starts one
 *  ramp after the last hold; weighing anchor waits for every stamped stop standing on the anchor. Queued battles / storms
 *  move to a clear moment again (voyageReslot); `dropped` gets the ones that found none. */
export function voyageAnchorBag(bag0: VoyageBag, cfg: RoomVoyageConfig | null | undefined, on: boolean, now: number, dropped?: VoyageStamp[]): VoyageBag {
  const b = voyageCompact(sanitizeVoyage(JSON.parse(JSON.stringify(bag0))), now);
  const open = b.holds.find((x) => x.until === null);
  if (on && !open) b.holds.push({ at: voyageHoldAt(b, cfg, now), until: null });
  if (!on && open) open.until = voyageWeighAt(b, now);
  const out = sanitizeVoyage(b);
  const lost = voyageReslot(out, cfg, now);   // always (an optional `dropped` must not skip the reslot)
  dropped?.push(...lost);
  return out;
}

/** Host: switch pacing (pure) at the first chapter boundary after every stamped episode on air or queued has finished
 *  (their clear windows were checked against the chapters as they are), so S, the chapter and the journey hour stay
 *  continuous and no episode meets a beat it was not checked against. A switch still pending is withdrawn first. */
export function voyageSetPacing(bag0: VoyageBag, cfg: RoomVoyageConfig | null | undefined, p: VoyagePacing, now: number): VoyageBag {
  const b = sanitizeVoyage(JSON.parse(JSON.stringify(bag0)));
  const V = voyageTime(b, now);
  let lock = V;
  for (const s of b.stamps) if (s.k === 'battle' || s.k === 'storm' || s.k === 'treasure') lock = Math.max(lock, voyageTime(b, s.at) + (s.k === 'treasure' ? HOLD_RAMP : stampDur(b, s)) + REPAIR_GAP);
  const last = b.pace[b.pace.length - 1];
  if (last && last.v > lock) { b.pacing = last.was; b.pace.pop(); }      // nothing has used a pending switch yet
  if (p === b.pacing) return sanitizeVoyage(b);
  const ref = chapterAtV(b, cfg, lock);
  b.pace = [...b.pace, { v: ref.v0 + ref.C, ch: ref.leg + 1, s: ref.s0 + ref.D, was: ref.pacing }].slice(-PACE_KEEP);
  b.pacing = p;
  const out = sanitizeVoyage(b);
  voyageReslot(out, cfg, now);
  return out;
}

// ------------------------------------------------------------------------------------------------ combat plan (pure)
export interface Salvo { tau: number; gun: number; hit: boolean; seed: number }
export interface Incoming { tau: number; kind: 'miss' | 'hit'; seed: number; site: number; sev: number; repairAt: number; repairDur: number }
export interface BattlePlan { dur: number; salvos: Salvo[]; incoming: Incoming[]; killTau: number }
/** Ship salvos + enemy return fire over a battle of `dur` s (tau 0 = the end of the approach). Guns alternate, >= 4.2 s
 *  apart per gun, >= 1.2 s between any two shots; the climax (last 13 s) fires faster; <= maxHits hull hits, severity
 *  1..3 (SPEC 2.6). */
export function battlePlan(seed: number, dur: number, guns = 2, sites = 6, maxHits = 3): BattlePlan {
  const salvos: Salvo[] = [];
  const G = Math.max(1, guns);
  const lastBy = new Array(G).fill(-99);
  let t = 2 + 2 * voyageRand(seed, 1), i = 0, gun = 0, last = -99;
  const climax = dur - 13;
  while (t < dur - 3 && i < 80) {
    if (t - lastBy[gun] < 4.2) t = lastBy[gun] + 4.2;
    if (t - last < 1.2) t = last + 1.2;
    if (t >= dur - 3) break;
    salvos.push({ tau: +t.toFixed(3), gun, hit: voyageRand(seed, 10, i) < 0.55, seed: voyageHash(seed, 's', i) });
    lastBy[gun] = t; last = t;
    gun = (gun + 1) % G;
    t += (t > climax ? 1.4 : 2.4) + (t > climax ? 1.0 : 2.6) * voyageRand(seed, 11, i);
    i++;
  }
  if (salvos.length) salvos[salvos.length - 1].hit = true;              // the killing blow
  const incoming: Incoming[] = [];
  let hits = 0;
  t = 5 + 3 * voyageRand(seed, 2); i = 0;
  while (t < dur - 6 && i < 60) {
    const isHit = hits < maxHits && voyageRand(seed, 20, i) < 0.32;
    const sev = isHit ? 1 + Math.floor(3 * voyageRand(seed, 21, i)) : 0;
    if (isHit) hits++;
    incoming.push({ tau: +t.toFixed(3), kind: isHit ? 'hit' : 'miss', seed: voyageHash(seed, 'i', i), site: Math.floor(voyageRand(seed, 22, i) * Math.max(1, sites)) % Math.max(1, sites), sev,
      repairAt: +(t + 0.8).toFixed(3), repairDur: +(10 + 2 * sev + 4 * voyageRand(seed, 23, i)).toFixed(3) });
    t += (t > climax ? 2.4 : 3.5) + 2.5 * voyageRand(seed, 24, i);
    i++;
  }
  return { dur, salvos, incoming, killTau: salvos.length ? salvos[salvos.length - 1].tau : dur - 3 };
}

/** Hull health (0.35..1): max(0.35, 1 - sum(hits * 0.12 * sev) + repairs). The ship never sinks. */
export function hullHealth(plan: BattlePlan, tau: number): number {
  let h = 1;
  for (const x of plan.incoming) {
    if (x.kind !== 'hit' || tau < x.tau) continue;
    const rep = clamp((tau - x.repairAt) / x.repairDur, 0, 1);
    h -= 0.12 * x.sev * (1 - rep);
  }
  return Math.max(0.35, h);
}

/** Where a turret's line of fire starts (level ship frame [x, 0, z]): its muzzle, `reach` m (the rest pivot -> muzzle
 *  distance, horizontal) out from the yaw pivot toward the target. Pure, so every page decides the same shots. */
export function fireFrom(px: number, pz: number, reach: number, tx: number, tz: number): number[] {
  const dx = tx - px, dz = tz - pz, L = Math.hypot(dx, dz);
  const r = L > 1e-6 ? Math.min(Math.max(0, reach || 0), L) / L : 0;
  return [px + dx * r, 0, pz + dz * r];
}
/** Fire-arc rule (SPEC D18 / C13, purely geometric): false when the line muzzle -> target passes within `min` m of any
 *  point in `keep` (every authored spot, the alongside slots) or within `min` m of `box` (the canopy + wings + hatch stage,
 *  [minX, minY, minZ, maxX, maxY, maxZ]; exact segment-to-box distance). Pure geometry on plain arrays. */
export function fireArcClear(m: readonly number[], t: readonly number[], keep: readonly (readonly number[])[], min = 6, box?: readonly number[] | null): boolean {
  const dx = t[0] - m[0], dy = t[1] - m[1], dz = t[2] - m[2];
  const L2 = dx * dx + dy * dy + dz * dz || 1;
  for (const p of keep) {
    const u = clamp(((p[0] - m[0]) * dx + (p[1] - m[1]) * dy + (p[2] - m[2]) * dz) / L2, 0, 1);
    const qx = m[0] + dx * u - p[0], qy = m[1] + dy * u - p[1], qz = m[2] + dz * u - p[2];
    if (qx * qx + qy * qy + qz * qz < min * min) return false;
  }
  if (box && box.length === 6) return segBoxDist2(m, [dx, dy, dz], box) >= min * min;
  return true;
}
/** Squared distance from the segment o + u d (u in 0..1) to an axis-aligned box: the point-to-box distance is convex along
 *  a line, so a ternary search finds its minimum (exact to ~1e-9 of the segment). */
function segBoxDist2(o: readonly number[], d: readonly number[], b: readonly number[]): number {
  const f = (u: number) => {
    let s = 0;
    for (let k = 0; k < 3; k++) { const p = o[k] + d[k] * u, e = Math.max(b[k] - p, 0, p - b[k + 3]); s += e * e; }
    return s;
  };
  let lo = 0, hi = 1;
  for (let i = 0; i < 80 && hi - lo > 1e-12; i++) {
    const a = lo + (hi - lo) / 3, c = hi - (hi - lo) / 3;
    if (f(a) <= f(c)) hi = c; else lo = a;
  }
  return Math.min(f(0), f(1), f((lo + hi) / 2));
}

// ------------------------------------------------------------------------------------------------ Talk cut-aways
/** May the voyage cut away from the deck cameras right now (event cutaways, the room's b-roll)? Only in Talk mode under
 *  Show lighting with no OBS hole open, and only when the HOST turned it on (bag.talkCuts, off by default: in Talk the
 *  camera stays on the host's pick; a camera change or the Preshow show are the only other things that move it). A room's
 *  scene.json can never turn it on by itself (voyage.broll only says what a cut-away looks like). */
export function voyageTalkCuts(bag: Pick<VoyageBag, 'talkCuts'>, mode: string, lightState: string, hole: boolean): boolean {
  return bag.talkCuts === true && mode === 'talk' && lightState === 'show' && !hole;
}

// ------------------------------------------------------------------------------------------------ deck motion (SPEC R2)
const MODE_GAIN: Record<string, number> = { talk: 1, interview: 0.6, ttrpg: 0.8, react: 0, gaming: 0 };
/** Deck motion gain per stage mode (room `modeGain` over the spec defaults); BRB deck shots are still. */
export function modeGain(mode: string, lightState: string, cfg?: RoomVoyageConfig | null): number {
  if (lightState === 'brb') return 0;
  const g = num(cfg?.modeGain?.[mode]);
  return g >= 0 ? Math.min(2, g) : MODE_GAIN[mode] ?? 0.6;
}
/** Back-compat helper: mode gain x battle x2 x (1 - kneel) x sway. */
export function deckMotionMult(mode: string, lightState: string, battle: boolean, stopKneel: number, sway: number, cfg?: RoomVoyageConfig | null): number {
  let m = modeGain(mode, lightState, cfg);
  if (battle && m > 0) m *= 2;
  m *= 1 - stopKneel;
  return Math.min(2, Math.max(0, m * clamp(sway, 0, 1.5)));
}
/** Hit kicks allowed? Never in React / Gaming (and never with sway 0). */
export const voyageKickOk = (mode: string, sway: number) => mode !== 'react' && mode !== 'gaming' && sway > 0;
/** Presentation of an event in a mode (SPEC 5.6; the plan never changes, only how much of it is shown). */
export function eventIntensity(bag: VoyageBag, mode: string, event: 'battle' | 'storm' | 'treasure' | 'city' | 'support'): Intensity {
  const o = bag.intensity[mode];
  if (o) return o;
  if (mode === 'talk') return 'full';
  if (mode === 'react' || mode === 'gaming') return event === 'storm' ? 'full' : 'background';
  if (mode === 'interview') return event === 'storm' || event === 'support' ? 'full' : 'background';
  return 'full';
}

// ------------------------------------------------------------------------------------------------ state digest (tests)
/** A stable digest of the timeline at `now` (two pages at the same clock must agree). */
export function voyageDigest(bag: VoyageBag, cfg: RoomVoyageConfig | null | undefined, now: number): string {
  const s = voyageNow(bag, cfg, now);
  return [s.leg, s.tLeg.toFixed(3), s.S.toFixed(3), s.v.toFixed(4), s.beat?.kind ?? '-', s.encounter?.sub ?? '-', s.stop?.phase ?? '-', s.storm.toFixed(3), s.hour.toFixed(3), s.plan.flavour, stampPlays(bag, now).map((p) => p.stamp.id).join(',')].join('|');
}
