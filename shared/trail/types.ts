// The Trail — shared game types (host sim, clients, wire, rules, decks). DESIGN.md / TECH.md in S\trail.
import type { SizeClass } from '../avatarSize.ts';

export type Tier = 'mild' | 'hilarious' | 'hard' | 'insane';
export const TIERS: readonly Tier[] = ['mild', 'hilarious', 'hard', 'insane'];
/** How an event plays: a vote card, a physical STOP scene, a moment on the rolling wagon, a voice/face mini-game,
 *  or a modifier applied to the next stop. */
export type EventKind = 'card' | 'stop' | 'trail3d' | 'voice' | 'modifier';
export type Pace = 'steady' | 'strenuous' | 'grueling';
export type Rations = 'filling' | 'meager' | 'bare';
export const ITEM_IDS = ['clothes', 'ammo', 'wheel', 'axle', 'tongue', 'medicine', 'meme'] as const;
export type ItemId = typeof ITEM_IDS[number];
export type Part = 'wheel' | 'axle' | 'tongue';
export const ROLE_IDS = ['banker', 'carpenter', 'whisperer', 'medic', 'hunter', 'streamer'] as const;
export type RoleId = typeof ROLE_IDS[number];
export const COND_IDS = ['dysentery', 'cholera', 'typhoid', 'measles', 'exhaustion', 'snakebite', 'broken_leg', 'munchies'] as const;
export type CondId = typeof COND_IDS[number];
export type StopKind = 'store' | 'river' | 'hunt' | 'landmark' | 'camp' | 'event' | 'finish';
export type NodeKind = 'start' | 'river' | 'fort' | 'landmark' | 'pass' | 'end';
export type RiverChoice = 'ford' | 'caulk' | 'ferry' | 'wait' | 'ask';

// ---------------------------------------------------------------- deck (content, per theme: assets/games/trail/<theme>/deck.json)
export interface RouteNode { id: string; kind: NodeKind; name: string; miles: number; /** river: base depth (ft) + width (ft) */ depth?: number; width?: number; ferry?: number; /** landmark: NPC rumour lines */ talk?: string[] }
export interface RoleDef { name: string; perk: string; money: number; mult: number; icon?: string }
export interface CondDef { name: string; drain: number; /** days until it passes on its own with rest (0 = never) */ days: number }
export interface ItemDef { name: string; price: number; /** per purchase unit (food: lbs per crate) */ unit?: number; icon?: string }
export type Who = 'all' | 'living' | 'target' | 'random' | 'volunteer' | 'dead' | 'ghosts';
/** Outcome effects — the whole event vocabulary (rules.ts applies them). */
export type Effect =
  | { k: 'food'; n: number } | { k: 'money'; n: number } | { k: 'item'; id: ItemId; n: number }
  | { k: 'health'; n: number; who: Who } | { k: 'cond'; id: CondId | 'random'; who: Who; p?: number } | { k: 'cure'; who: Who }
  | { k: 'days'; n: number } | { k: 'miles'; n: number } | { k: 'draft'; n: number } | { k: 'draftHealth'; n: number }
  | { k: 'morale'; n: number } | { k: 'break'; part: Part } | { k: 'repair'; part: Part } | { k: 'flag'; id: string; n: number }
  | { k: 'mod'; id: string } | { k: 'ghost'; who: Who } | { k: 'revive'; who: Who } | { k: 'swap' } | { k: 'chain'; id: string }
  | { k: 'rewind' } | { k: 'rations'; v: Rations; days: number } | { k: 'depth'; n: number } | { k: 'hunt' } | { k: 'meme'; n: number }
  | { k: 'limp' } | { k: 'rest'; n: number };
/** Weight multiplier when a condition holds (party has a role / a size class / a flag; `on: 'target'` = the event's target). */
export interface WeightMod { role?: RoleId; size?: SizeClass; flag?: string; item?: ItemId; on?: 'party' | 'target'; x: number }
export interface DeckOutcome { id?: string; w?: number; mods?: WeightMod[]; /** physical stop result this outcome is for */ on?: 'success' | 'partial' | 'fail'; text: string; fx: Effect[] }
export interface Requirement { item?: ItemId; n?: number; money?: number; role?: RoleId; food?: number; players?: number }
export interface DeckChoice { id: string; label: string; hint?: string; req?: Requirement; /** a physical stop plays this choice out */ stop?: string; outcomes: DeckOutcome[] }
export type NeedStat = 'food' | 'money' | 'draft' | 'dead' | 'micro' | 'small' | 'macro' | 'sick' | 'dysentery' | 'meme' | 'players' | 'graves' | 'heat' | 'haunted' | 'badDays' | 'living' | 'foodDays' | 'broken';
export interface Need { s: NeedStat; op: '>' | '>=' | '<' | '<=' | '='; n: number }
export interface Trigger { minP?: number; maxP?: number; minLeg?: number; biome?: string[]; weather?: string[]; pace?: Pace[]; night?: boolean; need?: Need[] }
export type Target = 'none' | 'random' | 'smallest' | 'largest' | 'sick' | 'dysentery' | 'main' | 'dead';
export interface DeckEvent {
  id: string; tier: Tier; kind: EventKind; name: string; text: string; icon?: string;
  /** Base weight within its tier (default 1). */
  weight?: number; trigger?: Trigger; target?: Target;
  /** The stop level for the physical version ('road', 'camp', 'river', 'hunt'…). */
  level?: string;
  /** Effects applied the moment the event is drawn (before the vote: the bite, the illness…). */
  fire?: Effect[];
  choices: DeckChoice[];
}
export interface Deck {
  id: string; name: string; extends?: string;
  /** Theme strings (UI + meme text). Keys used by the engine: see DECK_TEXT_KEYS in deck.ts. */
  text: Record<string, string>;
  currency: { name: string; sym: string };
  palette: Record<string, string>;
  route: RouteNode[];
  /** The vertical-slice route (shorter). */
  slice?: RouteNode[];
  roles: Record<RoleId, RoleDef>;
  conds: Record<CondId, CondDef>;
  items: Record<ItemId | 'food' | 'draft', ItemDef>;
  events: DeckEvent[];
  epitaphs: string[];
  memes: string[];
  weather: { id: string; name: string; speed: number; health: number }[];
  biomes: { id: string; name: string; from: number }[];
  /** Hunting animals: id → {name, kg (meat), speed, danger 0..1, flee m} */
  animals: Record<string, { name: string; kg: number; speed: number; danger: number; flee: number; count: number; grabs?: 'micro' | 'small' | 'normal' }>;
  /** NPC names / lines. */
  npcs: Record<string, { name: string; lines: string[] }>;
  /** v2 meme moments: re-word the engine's (same id) or add more (`k` = one of the engine's effects, memes.ts). */
  memes2?: MemeDef[];
}
export interface MemeDef { id: string; tier: 'common' | 'rare' | 'legendary'; k: string; text: string }

// ---------------------------------------------------------------- run state (the TRAIL layer, pure data — rules.ts)
export interface CondState { id: CondId; days: number }
export interface MemberStats { swept: number; dropped: number; carriedKg: number; shots: number; hits: number; revives: number; deaths: number }
export interface Member {
  id: string; name: string; role: RoleId; height: number; cls: SizeClass; color: string;
  health: number; conds: CondState[]; alive: boolean; ghost: boolean;
  diedOf?: string; diedMile?: number; diedDay?: number; epitaph?: string; quirk?: string;
  stats: MemberStats;
  /** Joined after the start (late pilgrim). */
  late?: boolean;
}
export interface Grave { mile: number; name: string; cause: string; epitaph: string; theme: string; seed: string; date: string; day?: number; run?: string }
export interface RunState {
  theme: string; seed: string; slice: boolean; modifiers: string[];
  day: number; startMonth: number; miles: number; total: number;
  /** Index of the NEXT route node (0 = the start is done when miles > 0). */
  node: number;
  pace: Pace; rations: Rations; rationsLock?: { v: Rations; until: number };
  money: number; food: number; items: Record<ItemId, number>;
  draft: number; draftHealth: number; morale: number;
  weather: string; biome: string;
  broken: Part[]; limp: boolean;
  flags: Record<string, number>;
  party: Record<string, Member>;
  order: string[];
  /** Day of the last event (spacing), events seen this run, legs with an INSANE event. */
  lastEventDay: number; seen: string[]; insaneLegs: number[];
  /** Graves of this run + old graves on this road (from the host's graveyard). */
  graves: Grave[]; oldGraves: Grave[];
  /** River (when at one): depth ft, width ft. */
  river: { depth: number; width: number; swift: boolean } | null;
  /** Rolling log shown on the HUD (newest last). */
  log: string[];
  bossIdx: number;
  /** Active stop modifiers (big head, inverted…) until the next camp / stop. */
  mods: string[];
  /** Days with bad outcomes (time loop trigger). */
  badDays: number[];
  outcome: 'playing' | 'won' | 'wiped';
  score?: ScoreSheet;
}
export interface ScoreSheet { lines: { label: string; n: number; pts: number }[]; mult: number; total: number; titles: { who: string; title: string }[] }

// ---------------------------------------------------------------- live game state (host → everyone; small JSON)
export type Phase = 'lobby' | 'travel' | 'stop' | 'end';
export interface PlayerInfo {
  id: string; name: string; role: RoleId; height: number; cls: SizeClass; color: string;
  ready: boolean; connected: boolean; host: boolean; bot?: boolean;
}
export interface VoteOption { id: string; label: string; hint?: string; disabled?: string }
export interface VoteState {
  id: string; title: string; text: string; tier?: Tier; icon?: string; kind: 'event' | 'river' | 'camp' | 'store' | 'travel' | 'generic' | 'consent';
  options: VoteOption[]; votes: Record<string, string>; endsAt: number; boss: string | null;
  /** Chat bloc vote (optional). */
  chat?: Record<string, number>;
  result?: string;
}
export interface CardState { id: string; title: string; text: string; tier?: Tier; icon?: string; until: number; big?: boolean; death?: { name: string; cause: string } }
export interface StopObjective { label: string; progress: number; goal: number; unit?: string }
export interface StopState {
  kind: StopKind; level: string; title: string; endsAt: number; objective: StopObjective | null;
  /** Event stops: which event + choice is playing out. */
  event?: string; choice?: string;
  river?: RiverChoice; ready: string[]; notes: string[];
}
export interface GameState {
  v: 1; rev: number; phase: Phase; theme: string; seed: string; now: number;
  players: PlayerInfo[]; run: RunState | null; vote: VoteState | null; card: CardState | null; stop: StopState | null;
  /** Travel: the wagon is rolling (days ticking) vs halted (vote / card). */
  rolling: boolean; paused: boolean;
  /** Seconds per day at the current pace (client animation). */
  dayLen: number;
  /** Lobby settings. */
  lobby: { slice: boolean; modifiers: string[]; chatVotes: boolean; chaosConsent: boolean; daily: boolean };
  /** Epitaph requests: player id → deadline (ms, host clock). */
  epitaphs: Record<string, number>;
  /** v2: the driven journey (DESIGN_V2.md); absent in the classic treadmill travel. */
  journey?: JourneyState;
  /** v2: what's in the wagon (props aboard / slots, kg / capacity) + whether the loading ramp is down. */
  cargo?: { used: number; cap: number; kg: number; maxKg: number; ramp: boolean; items: Record<string, number> };
}
export interface JourneyState {
  /** Time of day 0..1 (0.25 = morning, 0.5 = noon, 0.75 = dusk, 0.9 = night). */
  tod: number;
  /** Who drives (player id), or null: the animals follow the road on their own (slower, always the main road). */
  driver: string | null;
  /** m/s + what's under the wheels (road / grass / mud / water / void) + bogged in mud (+ push progress 0..1). */
  speed: number; surface: string; bogged: boolean; push: number;
  /** Wagon heading (rad, 0 = +Z) + steering (rad, + = right): chase camera + wheel animation. */
  heading: number; steer: number;
  /** The road the wagon is on (path id) + the fork ahead, if any (the signpost HUD; `alt` = side of the shortcut). */
  path: string | null; fork: { labels: [string, string]; dist: number; alt: -1 | 1; id?: string } | null;
  /** Floating origin (world metres, chunk aligned): local = world − origin. */
  origin: [number, number];
  /** Next route node (name) + metres to it (straight line). */
  next: string; nextDist: number;
  /** Heading to the next node / the camp spot (rad, world) for the compass. */
  goal?: number;
  /** Dusk: the party is heading for a camp spot (metres to it). */
  campDist?: number;
  /** Camp in progress (v2 camp: tasks in the world). */
  camp: CampState | null;
  /** Weather id (rain / fog / storm …: the client's sky + particles) + the leg's biome index. */
  weather?: string; biome?: number;
  /** The last meme moment (banner + director cut), newest first. */
  meme?: { id: string; tier: 'common' | 'rare' | 'legendary'; text: string; at: number; who?: string } | null;
}
export interface CampTask {
  id: string; label: string; icon: string;
  /** Local position (the task's spot) + radius. */
  p: [number, number, number]; r: number;
  /** 0..1 */
  progress: number;
  /** A hold-E task: the rhythm band is on (press / hold E now) — mashing does nothing. */
  band?: boolean;
  /** Who is working on it now. */
  who: string[];
  hint: string;
  /** Rhythm phase (0..1): the band is on when sin((t / 1.6 + ph)·2π) > 0.22 (t = host seconds). */
  ph?: number;
}
export interface CampState {
  /** 0..100 survival stats the dawn report applies. */
  fire: number; meals: number; tents: number; repair: number; animals: number; watch: number;
  night: boolean; t: number; endsAt: number;
  tasks: CampTask[];
  /** Morning report lines (after the night). */
  report?: string[];
}
