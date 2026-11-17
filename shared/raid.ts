// Background combat ("raid") options + timed raid events — part of the host-owned SceneState (SceneState.raid), so the
// studio preview, every OBS page and party guests all simulate the SAME fight from the same seed + clock
// (src/scene/raid/*). Rooms opt in with BG_* anchors (docs/SCENES.md → "Background combat").

export type RaidIntensity = 'chill' | 'normal' | 'hot';
/** Original homage archetypes (UI names: "PMC (USEC-style)", "PMC (BEAR-style)", "Scavs", "Raiders"). */
export const RAID_FACTIONS = ['usec', 'bear', 'scav', 'raider', 'frog', 'militia'] as const;
export type RaidFaction = (typeof RAID_FACTIONS)[number];
export const RAID_FACTION_LABELS: Record<RaidFaction, string> = { usec: 'PMC (USEC-style)', bear: 'PMC (BEAR-style)', scav: 'Scavs', raider: 'Raiders', frog: 'Frog soldiers', militia: 'Masked militia' };

/** A timed raid event (host clock, epoch ms; guests convert with the party clock offset). Kinds: 'tagilla' (the
 *  sledgehammer brute smashes a SMASH_xx prop), 'skirmish' (a fight right now) or any name a room registers
 *  (src/scene/raid/raidScene.ts registerRaidEvent). `user` / `amount` = the supporter shown on his sign. */
export interface RaidEventStamp {
  k: string; at: number; id: string; user?: string; amount?: string; /** The host's camera when stamped (sightline picks). */ cam?: string;
  /** Big-donation interrupt: plays even in React mode (the screen winches up, the camera cuts to him, then React resumes). */
  big?: boolean;
  /** The support's USD value (rooms that scale their donation event by the amount, e.g. the warzone set pieces). */
  usd?: number;
}

export interface SceneRaidState {
  /** Background skirmishes on / off (events + tests play either way while the room has the anchors). */
  on: boolean;
  intensity: RaidIntensity;
  /** Skirmish frequency multiplier (0.25 … 3; 1 = one every ~2¾ min at Normal). */
  freq: number;
  /** Factions that show up (null = the room's scene.json raid.factions, else PMCs + scavs). */
  factions: RaidFaction[] | null;
  /** Shared simulation seed + clock origin (epoch ms): re-stamped by the host on every option change. */
  seed: number;
  epoch: number;
  /** Support events summon the room's donation event (Tagilla in Factory). */
  tagilla: boolean;
  /** Minimum USD value for a support event to summon him (subs / gifts count at $5). */
  min: number;
  /** Camera shake on his hammer hit. */
  shake: boolean;
  /** Recent timed events (≤ 8, oldest dropped). */
  events: RaidEventStamp[];
  /** Camera director: during PRESHOW the scene camera cuts between the normal shots and the raid (CAM_RAID_xx / auto). */
  preshowCam: boolean;
  /** …also during BRB. */
  preshowBrb: boolean;
  /** Big donations interrupt the stream: Tagilla comes in even during React (screen up, camera on him, then back). */
  bigOn: boolean;
  /** Minimum USD value of a big donation (default $100). */
  bigMin: number;
  /** "Calm": the streamer is talking — rooms with ambient battle effects (warzone) hold their big moments, and nothing
   *  shakes or drifts inside the room. The regular background fight keeps going. */
  calm?: boolean;
}

export const DEFAULT_RAID_STATE: SceneRaidState = {
  on: false, intensity: 'normal', freq: 1, factions: null, seed: 1, epoch: 0, tagilla: true, min: 5, shake: true, events: [], preshowCam: true, preshowBrb: false, bigOn: true, bigMin: 100,
};

/** scene.json `raid` (room defaults). */
export interface RoomRaidConfig {
  /** Factions that belong in this room (default usec, bear, scav). */
  factions?: RaidFaction[];
  /** NPC standing height in metres (default avatarHeight × 1.08). */
  npcHeight?: number;
  /** Which raid event a support event triggers (default 'tagilla' when the room has EVENT_TAGILLA_ENTER + SMASH_xx, else 'skirmish'). */
  donationEvent?: string;
  /** A boss squad that patrols PATROL_PATH_xx ('reshala'). */
  boss?: string;
  /** Patrol pacing: share of skirmish slots that are patrols, share of patrols that get ambushed (defaults 0.5 / 0.45). */
  patrol?: { chance?: number; ambush?: number } | unknown;
  /** Tagilla: skip props hidden from the current camera (true = the room guarantees sightlines itself). */
  tagillaSightline?: boolean;
  /** Tagilla hints: which chat props winch up while he's in ('chatMonitor', 'chatBoard'; default both) and which SMASH
   *  props suit which camera (preferPropsByCamera: { CAM_WIDE: ['SMASH_01', …] }). */
  tagilla?: { liftProps?: string[]; preferPropsByCamera?: Record<string, string[]> } | unknown;
  /** The event a big donation plays in rooms without Tagilla (default: the donation event, else a skirmish). */
  bigEvent?: string;
}

/** Per-intensity pacing: slot length (s) at freq 1, chance of a skirmish per slot, squad sizes. */
export const RAID_PACING: Record<RaidIntensity, { slot: number; chance: number; sizes: [number, number][] }> = {
  chill: { slot: 230, chance: 0.75, sizes: [[1, 1], [1, 2], [2, 1]] },
  normal: { slot: 165, chance: 0.9, sizes: [[2, 2], [2, 3], [3, 2], [2, 1]] },
  hot: { slot: 130, chance: 1, sizes: [[3, 3], [4, 3], [3, 4], [4, 4]] },
};

const numIn = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
// eslint-disable-next-line no-control-regex
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').slice(0, max) : '');
export const RAID_EVENT_KIND = /^[a-z][a-z0-9_]{0,23}$/;

export function sanitizeRaidState(o: unknown): SceneRaidState {
  const d = DEFAULT_RAID_STATE;
  if (!o || typeof o !== 'object') return { ...d, events: [] };
  const x = o as Record<string, unknown>;
  const events: RaidEventStamp[] = [];
  if (Array.isArray(x.events)) {
    for (const e of x.events.slice(-8)) {
      if (!e || typeof e !== 'object') continue;
      const v = e as Record<string, unknown>;
      if (typeof v.k !== 'string' || !RAID_EVENT_KIND.test(v.k) || typeof v.at !== 'number' || !Number.isFinite(v.at) || v.at <= 0 || v.at > 1e14) continue;
      const id = clean(v.id, 80);
      if (!id) continue;
      const ev: RaidEventStamp = { k: v.k, at: v.at, id };
      const user = clean(v.user, 32), amount = clean(v.amount, 24);
      if (user) ev.user = user;
      if (amount) ev.amount = amount;
      if (typeof v.cam === 'string' && /^[A-Za-z0-9_]{1,48}$/.test(v.cam)) ev.cam = v.cam;
      if (v.big === true) ev.big = true;
      if (typeof v.usd === 'number' && Number.isFinite(v.usd) && v.usd > 0) ev.usd = Math.min(1e6, v.usd);
      events.push(ev);
    }
  }
  const f = Array.isArray(x.factions) ? [...new Set(x.factions.filter((v): v is RaidFaction => (RAID_FACTIONS as readonly string[]).includes(v as string)))] : null;
  return {
    on: x.on === true,
    intensity: x.intensity === 'chill' || x.intensity === 'hot' ? x.intensity : 'normal',
    freq: numIn(x.freq, 0.25, 3, 1),
    factions: f && f.length ? f : null,
    seed: Math.round(numIn(x.seed, 0, 2 ** 31 - 1, 1)),
    epoch: numIn(x.epoch, 0, 1e14, 0),
    tagilla: x.tagilla !== false,
    min: numIn(x.min, 0, 10000, 5),
    shake: x.shake !== false,
    events,
    preshowCam: x.preshowCam !== false,
    preshowBrb: x.preshowBrb === true,
    bigOn: x.bigOn !== false,
    bigMin: numIn(x.bigMin, 1, 100000, 100),
    ...(x.calm === true ? { calm: true } : {}),
  };
}

/** Would this support event summon the room's donation event? (usd = the event's USD value, subs/gifts count as $5.) */
export function raidDonationValue(e: { fkind?: string; usd?: number; approxUsd?: number; amount?: number }): number {
  const subs = ['sub', 'resub', 'membership', 'milestone'];
  const gifts = ['giftSub', 'giftMembership'];
  if (e.fkind && subs.includes(e.fkind)) return 5;
  if (e.fkind && gifts.includes(e.fkind)) return 5 * Math.max(1, Math.min(50, e.amount ?? 1));
  if (e.fkind === 'raid') return 0;
  return e.usd || e.approxUsd || 0;
}
