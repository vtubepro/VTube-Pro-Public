// The deck crew of a walking ship (src/scene/crew/*): the room config (scene.json `crew`), the episode
// inputs the voyage / combat engine feeds in, and their sanitizers. Pure data, shared by the client and tests.
// The crew never reads the network or the frame rate: every page plans the same episodes from the same inputs (seed +
// the voyage's closed-form timeline) and samples them at wall-clock time, so the studio preview, every OBS page and
// party guests show the same crew. Rooms without a `crew` key pay one check per frame.

/** scene.json `crew` (room defaults). Every field optional. */
export interface RoomCrewConfig {
  /** Room-relative files (default 'npc/crew_units.glb', ['npc/crew_anims.json', 'npc/crew_anims_ual.json']). */
  units?: string;
  anims?: string[];
  /** Shown height of a crew member to the fur top (m). Default 1.25 (the puppet unit at 1:1 is 1.22 to the fur top). */
  height?: number;
  /** Crew size 1..9 (roster order: captain, gunner F, loader F, gunner A, loader A, stoker, lookout, deckhand x2). */
  count?: number;
  /** 'npc' = the Cap'n NPC at CREW_HELM; 'performer' = the host's avatar steers, the Cap'n works as a deckhand. */
  helm?: 'npc' | 'performer';
  /** The helm NPC's display name in the host's Voyage panel (the room's own content; default 'The crew captain'). */
  captainName?: string;
  /** Per-crew fur hue shift in degrees (index = roster slot; the unit's own blue = 0). */
  hues?: number[];
  /** Fur tints per crew member (SPEC Appendix A: '#rrggbb', cycled), on top of the hues. */
  tints?: string[];
  /** The show set the crew never enters (SPEC Appendix A ['areas.deck.bounds']): used when the room has no CREW_KEEPOUT
   *  node - the deck area's scene.json `bounds` box. Default on. */
  keepOut?: string[];
  /** Screen-height LOD thresholds (px) and the per-level pose rate (1 = every frame). */
  lod?: { lod0px?: number; lod1px?: number; lod2px?: number; poseEvery?: [number, number, number]; maxLod0?: number };
  /** Fade any crew member who would cover a performer's face (screen radius as a fraction of the frame height). */
  faceGuard?: { screenR?: number; hz?: number };
  /** Speech bubbles on / off and the editable lines per moment. */
  bubbles?: boolean;
  lines?: Partial<Record<CrewLineKey, string[]>>;
  /** Highest drop (m) the shore party jumps from the rail; above it they slide down the rope ladder. Default 9. */
  jumpMax?: number;
  /** Where a stop's treasure is dug when the stop gives no `loot`: [x, z] on the starboard side (mirrored to port), on
   *  the sand under the halted ship. Default [10.5, -22.5] (+ up to 2 m): the near corner of SPEC C14's forward-starboard sector (z -22..-40, x +10..+22),
   *  clear of the alongside size spots and the legs. */
  digSite?: [number, number];
  /** Ground height (room y) under the halted ship when a stop gives none. Default: scene.json voyage.groundY + the
   *  kneel (voyage.gait.kneel, 3.0) when the room has a `voyage` block, else -9.844 (the SPEC ship kneeled 3 m). */
  ground?: number;
  /** Fit the deck to the room's meshes (feet on the real floor, bodies out of rails / bulwarks). Default true. */
  snap?: boolean;
  /** Rooms with areas: the area the deck crew lives in (default the room's default area). Other areas show no crew. */
  area?: string;
  /** The area where only the galley cook is shown (SPEC 1.5, e.g. 'below'): at the GALLEY_COOK anchor or `cook`. */
  galleyCook?: string;
  /** The cook's spot [x, y, z, yawDeg] (room space of that area) when the room has no GALLEY_COOK anchor. */
  cook?: [number, number, number, number];
  /** 'auto' (anchors when the room has >= 4 CREW_NAV_ nodes, else the built-in preset layout), 'anchors', 'preset'. */
  layout?: 'auto' | 'anchors' | 'preset';
  /** Ambient random seed (the cruise loops); episodes add their own id. */
  seed?: number;
  /** Test rooms only: the crew turns GUN_x_YAW itself when no voyage engine feeds the turrets. */
  driveTurrets?: boolean;
}

export type CrewLineKey = 'alert' | 'stations' | 'fire' | 'hit' | 'repair' | 'victory' | 'flee' | 'treasure' | 'shore' | 'catch' | 'aboard' | 'cruise';

export const CREW_LINES: Record<CrewLineKey, string[]> = {
  alert: ['ENEMY OFF THE BOW!', 'THIEVES ON THE HORIZON!', 'HEY! TROUBLE, CAP\'N!'],
  stations: ['BATTLE STATIONS!', 'ALL HANDS! MOVE IT!', 'MAN THE GUNS!'],
  fire: ['FIRE!', 'TAKE THAT!', 'BOOM!'],
  hit: ['WE\'RE HIT!', 'OUCH!', 'MY GALLEY!'],
  repair: ['I GOT IT, I GOT IT!', 'WHERE\'S MY HAMMER?!', 'GOOD AS NEW!'],
  victory: ['HOORAY!', 'WHAT A SHOT!', 'CHEERS!', 'SEE YOU NEVER!'],
  flee: ['AND STAY OUT!', 'RUN, YOU RASCALS!', 'NEXT TIME, BRING FRIENDS!'],
  treasure: ['TREASURE HO!', 'SHINY! SHINY ON THE SAND!', 'X MARKS THE SPOT!'],
  shore: ['WHEEE!', 'GERONIMOOO!', 'LAST ONE IS A ROTTEN EGG!'],
  catch: ['GOT IT!', 'HEAVY! HEAVY!', 'IT\'S GOLD!'],
  aboard: ['ALL ABOARD!', 'SHE\'S ALL YOURS, CAP\'N!', 'WE\'RE RICH! RICH!'],
  cruise: ['NICE DAY FOR IT.', 'ANYBODY SEEN MY SPYGLASS?', 'MORE COAL, MORE COAL!'],
};

export const CREW_ROLES = ['captain', 'gunner_f', 'loader_f', 'gunner_a', 'loader_a', 'stoker', 'lookout', 'deckhand', 'deckhand'] as const;
export type CrewRole = (typeof CREW_ROLES)[number];

// ------------------------------------------------------------------------------------------------ episode inputs
/** A deck-space point (room space, metres; the ship never moves in room space). */
export type CrewV3 = [number, number, number];

/** A battle, as the combat engine scheduled it. Times are wall-clock epoch ms. */
export interface CrewBattleIn {
  k: 'battle';
  id: string;
  /** Contact sighted: the lookout points + shouts (>= 1.5 s before the first shot by contract). */
  alert: number;
  /** The fight is over (victory / the enemy flees). */
  end: number;
  outcome: 'win' | 'flee';
  /** Room-space yaw (rad, 0 = +Z) towards the enemy at the alert (the lookout points there). */
  bearing: number;
  /** Shots per turret ('F' | 'A'). Contract: consecutive shots of one gun >= 4.2 s apart (the loader cycle). Empty =
   *  the crew plans its own salvo rhythm (test pages / no combat engine) unless `synth` is false. */
  shots: { gun: string; at: number }[];
  /** Hull hits (deck space): a repair job 0.8 s later, 4 + 2 x severity s of hammering / welding. Give each an `id`
   *  (repairProgress(id)); without one it is 'h' + its time. */
  hits: { id?: string; at: number; pos: CrewV3; normal?: CrewV3; severity: 1 | 2 | 3 }[];
  /** false = never invent a salvo rhythm when `shots` is empty (a voyage battle whose shots are all fire-arc skipped). */
  synth?: boolean;
}

/** A treasure stop: the ship is halted (kneeled) from `at`; `until` = when it must walk on again (optional: without
 *  it the voyage holds the halt for crewStopDuration()). */
export interface CrewStopIn {
  k: 'treasure';
  id: string;
  at: number;
  until?: number;
  side?: 'port' | 'starboard';
  /** Where the loot is buried (room space; y = the sand). Default: 11-14 m out from the jump side, amidships. */
  loot?: CrewV3;
  /** Sand height (room y) under the ship while halted; default RoomCrewConfig.ground. */
  groundY?: number;
  /** What comes back: 'bigchest' (two carry it, hoisted up), 'chest' (one carries it, hoisted), 'bag' (thrown up). */
  haul?: ('bigchest' | 'chest' | 'bag')[];
  /** Where the walker's feet are planted for this stop (deck x, z): the shore party walks around them (r 2 m). Default
   *  the room's CREW_FOOT_ / LEG_*_FOOT anchors (the rest stance). */
  feet?: [number, number][];
}

export type CrewEpisodeIn = CrewBattleIn | CrewStopIn;

// ------------------------------------------------------------------------------------------------ sanitizers
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clean = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n) : '');
const v3 = (v: unknown, lim = 5000): CrewV3 | null => (Array.isArray(v) && v.length === 3 && v.every(isNum) && v.every((x) => Math.abs(x) <= lim) ? [v[0], v[1], v[2]] : null);
export const CREW_EPISODE_ID = /^[A-Za-z0-9_:.\-]{1,80}$/;

export function sanitizeCrewConfig(o: unknown): RoomCrewConfig {
  if (!o || typeof o !== 'object') return {};
  const x = o as Record<string, unknown>;
  const out: RoomCrewConfig = {};
  const rel = (s: unknown) => (typeof s === 'string' && /^[A-Za-z0-9_\-./]{1,120}$/.test(s) && !s.includes('..') ? s : null);
  if (rel(x.units)) out.units = rel(x.units)!;
  if (Array.isArray(x.anims)) { const a = x.anims.map(rel).filter((s): s is string => !!s).slice(0, 4); if (a.length) out.anims = a; }
  if (x.height !== undefined) out.height = num(x.height, 0.3, 4, 1.25);
  if (x.count !== undefined) out.count = Math.round(num(x.count, 1, 9, 9));
  if (x.helm === 'performer' || x.helm === 'npc') out.helm = x.helm;
  if (Array.isArray(x.hues)) out.hues = x.hues.slice(0, 9).map((h) => num(h, -180, 180, 0));
  if (Array.isArray(x.tints)) { const t = x.tints.filter((c): c is string => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)).slice(0, 9); if (t.length) out.tints = t; }
  if (Array.isArray(x.keepOut)) out.keepOut = x.keepOut.filter((c): c is string => typeof c === 'string' && /^[a-z0-9_.]{1,64}$/i.test(c)).slice(0, 4);
  if (x.lod && typeof x.lod === 'object') {
    const l = x.lod as Record<string, unknown>;
    out.lod = {};
    if (isNum(l.lod0px)) out.lod.lod0px = num(l.lod0px, 20, 2000, 140);
    if (isNum(l.lod1px)) out.lod.lod1px = num(l.lod1px, 8, 1000, 40);
    if (isNum(l.lod2px)) out.lod.lod2px = num(l.lod2px, 1, 500, 12);
    if (Array.isArray(l.poseEvery) && l.poseEvery.length === 3) out.lod.poseEvery = l.poseEvery.map((v) => Math.round(num(v, 1, 8, 1))) as [number, number, number];
    if (isNum(l.maxLod0)) out.lod.maxLod0 = Math.round(num(l.maxLod0, 0, 9, 6));
  }
  if (x.faceGuard && typeof x.faceGuard === 'object') {
    const f = x.faceGuard as Record<string, unknown>;
    out.faceGuard = { screenR: num(f.screenR, 0, 0.5, 0.14), hz: num(f.hz, 1, 30, 4) };
  }
  if (typeof x.bubbles === 'boolean') out.bubbles = x.bubbles;
  if (x.lines && typeof x.lines === 'object') {
    const lines: Partial<Record<CrewLineKey, string[]>> = {};
    for (const k of Object.keys(CREW_LINES) as CrewLineKey[]) {
      const v = (x.lines as Record<string, unknown>)[k];
      if (Array.isArray(v)) { const l = v.map((s) => clean(s, 48)).filter(Boolean).slice(0, 8); if (l.length) lines[k] = l; }
    }
    out.lines = lines;
  }
  if (x.jumpMax !== undefined) out.jumpMax = num(x.jumpMax, 0, 40, 9);
  if (x.ground !== undefined) out.ground = num(x.ground, -200, 50, -11.5);
  if (x.layout === 'auto' || x.layout === 'anchors' || x.layout === 'preset') out.layout = x.layout;
  if (x.seed !== undefined) out.seed = Math.round(num(x.seed, 0, 2 ** 31 - 1, 1));
  if (typeof x.driveTurrets === 'boolean') out.driveTurrets = x.driveTurrets;
  if (typeof x.snap === 'boolean') out.snap = x.snap;
  if (Array.isArray(x.digSite) && x.digSite.length === 2 && x.digSite.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 200)) out.digSite = [x.digSite[0], x.digSite[1]];
  if (typeof x.area === 'string' && /^[a-z0-9_-]{1,32}$/i.test(x.area)) out.area = x.area;
  if (typeof x.galleyCook === 'string' && /^[a-z0-9_-]{1,32}$/i.test(x.galleyCook)) out.galleyCook = x.galleyCook;
  if (Array.isArray(x.cook) && x.cook.length >= 3 && x.cook.slice(0, 4).every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 500)) {
    const c = x.cook as number[];
    out.cook = [c[0], c[1], c[2], c[3] ?? 0];
  }
  return out;
}

/** One episode from an untrusted source (a host bag, a bus message, a test hook) -> a clean one, or null. */
export function sanitizeCrewEpisode(o: unknown): CrewEpisodeIn | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  const id = clean(x.id, 80);
  if (!id || !CREW_EPISODE_ID.test(id)) return null;
  const t = (v: unknown) => (isNum(v) && v > 0 && v < 1e14 ? v : null);
  if (x.k === 'battle') {
    const alert = t(x.alert), end = t(x.end);
    if (alert === null || end === null || end <= alert || end - alert > 15 * 60e3) return null;
    const shots = (Array.isArray(x.shots) ? x.shots : []).slice(0, 400).map((s) => {
      const r = s as Record<string, unknown>;
      const at = t(r?.at); const gun = clean(r?.gun, 8);
      return at !== null && gun ? { gun, at } : null;
    }).filter((s): s is { gun: string; at: number } => !!s).sort((a, b) => a.at - b.at);
    const hits = (Array.isArray(x.hits) ? x.hits : []).slice(0, 64).map((h) => {
      const r = h as Record<string, unknown>;
      const at = t(r?.at), pos = v3(r?.pos);
      if (at === null || !pos) return null;
      const sev = Math.round(num(r.severity, 1, 3, 1)) as 1 | 2 | 3;
      const n = v3(r.normal, 2);
      const hid = clean(r.id, 40) || `h${Math.round(at).toString(36)}`;
      return { id: hid, at, pos, ...(n ? { normal: n } : {}), severity: sev };
    }).filter((h): h is NonNullable<typeof h> => !!h).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const b: CrewBattleIn = { k: 'battle', id, alert, end, outcome: x.outcome === 'flee' ? 'flee' : 'win', bearing: num(x.bearing, -100, 100, 0), shots, hits };
    if (x.synth === false) b.synth = false;
    return b;
  }
  if (x.k === 'treasure') {
    const at = t(x.at);
    if (at === null) return null;
    const until = t(x.until);
    const out: CrewStopIn = { k: 'treasure', id, at };
    if (until !== null && until > at + 5000) out.until = until;
    if (x.side === 'port' || x.side === 'starboard') out.side = x.side;
    const loot = v3(x.loot);
    if (loot) out.loot = loot;
    if (isNum(x.groundY)) out.groundY = num(x.groundY, -200, 50, -11.5);
    if (Array.isArray(x.haul)) {
      const h = x.haul.filter((v): v is 'bigchest' | 'chest' | 'bag' => v === 'bigchest' || v === 'chest' || v === 'bag').slice(0, 4);
      if (h.length) out.haul = h;
    }
    if (Array.isArray(x.feet)) {
      const f = x.feet.filter((v): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every((q) => isNum(q) && Math.abs(q) < 500)).slice(0, 12).map((v) => [v[0], v[1]] as [number, number]);
      if (f.length) out.feet = f;
    }
    return out;
  }
  return null;
}
