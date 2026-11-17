// Space battle outside a ship's viewport (src/scene/space/*) + the cryo join / drop-pod leave cinematics — part of the
// host-owned SceneState (SceneState.space), so the studio preview, every OBS page and party guests all show the SAME
// sky from the same seed + clock (like the raid system, shared/raid.ts). Rooms opt in with SPACE_* anchors
// (docs/SCENES.md → "Space battle").

export type SpaceIntensity = 'chill' | 'normal' | 'hot';
/** Timed space events (Test buttons, support events): 'threat' (an enemy cruiser warps in close and is destroyed),
 *  'barrage' (orbital barrage on the planet), 'laser' (orbital laser), 'warp' (a friendly ship warps in / out),
 *  'flyby' (a fighter formation passes the viewport), 'strafe' (an Eagle strafing run). */
export const SPACE_EVENT_KINDS = ['threat', 'barrage', 'laser', 'warp', 'flyby', 'strafe', 'dogfight', 'hellbomb'] as const;
export type SpaceEventKind = (typeof SPACE_EVENT_KINDS)[number];
export interface SpaceEventStamp { k: string; at: number; id: string; user?: string; amount?: string }

export interface SpaceToggles { fighters: boolean; warps: boolean; barrages: boolean; lasers: boolean; threats: boolean; planet: boolean }

export interface SceneSpaceState {
  /** The ambient battle (fighters, warps, barrages …). Off = only the backdrop (planet, stars, parked ships). */
  on: boolean;
  intensity: SpaceIntensity;
  /** Activity multiplier (0.25 … 3). */
  freq: number;
  show: SpaceToggles;
  /** Shared seed + clock origin (epoch ms), re-stamped by the host when on / intensity / freq change. */
  seed: number;
  epoch: number;
  /** Support events trigger an orbital barrage (≥ min) or a threat event (≥ threatMin). */
  support: boolean;
  min: number;
  threatMin: number;
  /** Camera shake on big explosions (never in React mode). */
  shake: boolean;
  /** Bridge lights go red during a threat (alarm pulse, ≤ 1 Hz). */
  alert: boolean;
  /** Entrances / exits in rooms that declare them (scene.json entrance: 'cryo' / exit: 'droppod'). */
  cryo: boolean;
  droppod: boolean;
  events: SpaceEventStamp[];
}

export const DEFAULT_SPACE_STATE: SceneSpaceState = {
  on: true, intensity: 'normal', freq: 1, show: { fighters: true, warps: true, barrages: true, lasers: true, threats: true, planet: true },
  seed: 1, epoch: 0, support: true, min: 5, threatMin: 20, shake: true, alert: true, cryo: true, droppod: true, events: [],
};

/** scene.json `space` (room defaults / anchors without re-exporting the GLB — every key optional). Positions are glTF
 *  space. `planet.palette`: 'helldive' (ochre / teal, default), 'desert', 'ice', 'toxic', 'lava', 'ocean'. */
export interface RoomSpaceConfig {
  planet?: { center?: [number, number, number]; radius?: number; palette?: string; spin?: number };
  moon?: { center?: [number, number, number]; radius?: number } | null;
  sun?: { position?: [number, number, number]; direction?: [number, number, number]; color?: string };
  view?: { center?: [number, number, number]; normal?: [number, number, number]; width?: number; height?: number };
  /** Draw the starfield / nebula sky (default true). */
  sky?: boolean;
  /** Default ambient intensity for this room. */
  intensity?: SpaceIntensity;
  /** Camera for the drop-pod streak (default CAM_VIEWPORT / CAM_WIDE). */
  viewCamera?: string;
  /** Keep ONLY these space acts in this room (SPACE_ACTS names, or the group 'fighters'); everything else the space
   *  layer can do is never drawn here, whatever the host's toggles say, and support events only call in the kept ones.
   *  Missing = every act (the default). E.g. a Star Citizen room: ["pod", "barrage", "laser"]. */
  acts?: string[] | string;
  /** The room's own planet mesh when it isn't named PLANET (e.g. "BACKDROP_PLANET"): drawn by the room, the space layer
   *  only adds its combat overlay; its centre / radius come from the mesh unless SPACE_PLANET / `planet` give them. */
  planetNode?: string;
  /** Room nodes that are our own ship's muzzles, used like SPACE_CANNON_xx anchors (e.g. existing turret MUZZLE_* nodes). */
  cannonNodes?: string[];
  /** 'cannons' = orbital barrages and lasers only ever fire from our own cannons (SPACE_CANNON_xx / cannonNodes), never
   *  from a parked destroyer, an empty point in space or an orbital platform. Default 'any'. */
  fireFrom?: 'cannons' | 'any';
  /** Size of the drop-pod re-entry streak (fire, trail, impact) ×, 0.25 … 8 (default 1). For a room whose own planet is
   *  far away at true scale (km), where the default streak is only a few pixels. */
  podSize?: number;
}

/** Everything the space layer can put outside a room's viewport — the names scene.json `space.acts` keeps:
 *  patrol (Eagle patrol loops), pelican (dropship shuttles), flyby, dogfight, strafe, warp (friendly capital ships jump
 *  in / out), barrage, laser, hellbomb, threat (the dreadnought event, also `enemy_ship` raid stamps), pod (the drop-pod
 *  re-entry streak), fleet (parked capital ships at SPACE_SHIP_xx), planet (the war-zone combat drawn on the planet). */
export const SPACE_ACTS = ['patrol', 'pelican', 'flyby', 'dogfight', 'strafe', 'warp', 'barrage', 'laser', 'hellbomb', 'threat', 'pod', 'fleet', 'planet'] as const;
export type SpaceAct = (typeof SPACE_ACTS)[number];
/** Group names a room may list instead of single acts. */
export const SPACE_ACT_GROUPS: Record<string, readonly SpaceAct[]> = { fighters: ['patrol', 'pelican', 'flyby', 'dogfight', 'strafe'] };

/** scene.json `space.acts` → the acts this room keeps. null = no list (every act: today's behaviour). Accepts an array
 *  or a comma / space separated string; names are case-insensitive, a plural works ('lasers'), unknown names are
 *  ignored; a list with nothing valid keeps nothing. */
export function spaceActsOf(cfg: { acts?: unknown } | null | undefined): ReadonlySet<SpaceAct> | null {
  const v = cfg?.acts;
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/).filter(Boolean) : null;
  if (!list) return null;
  const out = new Set<SpaceAct>();
  for (const raw of list.slice(0, 64)) {
    if (typeof raw !== 'string') continue;
    const k = raw.trim().toLowerCase();
    const group = Object.prototype.hasOwnProperty.call(SPACE_ACT_GROUPS, k) ? SPACE_ACT_GROUPS[k] : null;
    if (group) { for (const g of group) out.add(g); continue; }
    const one = (SPACE_ACTS as readonly string[]).includes(k) ? k : k.endsWith('s') ? k.slice(0, -1) : '';
    if ((SPACE_ACTS as readonly string[]).includes(one)) out.add(one as SpaceAct);
  }
  return out;
}
/** Does the room keep this act? (null = no list = yes). */
export const spaceActOn = (acts: ReadonlySet<string> | null | undefined, k: string) => !acts || acts.has(k);

/** Slot length (s) at freq 1 (one ambient "act" may start per slot), threat period (s), ambient patrol groups. */
export const SPACE_PACING: Record<SpaceIntensity, { slot: number; threat: number; patrols: number; pelicans: number }> = {
  chill: { slot: 26, threat: 720, patrols: 1, pelicans: 1 },
  normal: { slot: 14, threat: 420, patrols: 2, pelicans: 2 },
  hot: { slot: 7.5, threat: 220, patrols: 3, pelicans: 3 },
};

const numIn = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
// eslint-disable-next-line no-control-regex
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').slice(0, max) : '');
export const SPACE_EVENT_KIND = /^[a-z][a-z0-9_]{0,23}$/;

export function sanitizeSpaceState(o: unknown): SceneSpaceState {
  const d = DEFAULT_SPACE_STATE;
  if (!o || typeof o !== 'object') return { ...d, show: { ...d.show }, events: [] };
  const x = o as Record<string, unknown>;
  const events: SpaceEventStamp[] = [];
  if (Array.isArray(x.events)) {
    for (const e of x.events.slice(-10)) {
      if (!e || typeof e !== 'object') continue;
      const v = e as Record<string, unknown>;
      if (typeof v.k !== 'string' || !SPACE_EVENT_KIND.test(v.k) || typeof v.at !== 'number' || !Number.isFinite(v.at) || v.at <= 0 || v.at > 1e14) continue;
      const id = clean(v.id, 80);
      if (!id) continue;
      const ev: SpaceEventStamp = { k: v.k, at: v.at, id };
      const user = clean(v.user, 32), amount = clean(v.amount, 24);
      if (user) ev.user = user;
      if (amount) ev.amount = amount;
      events.push(ev);
    }
  }
  const s = (x.show && typeof x.show === 'object' ? x.show : {}) as Record<string, unknown>;
  const b = (k: keyof SpaceToggles) => (typeof s[k] === 'boolean' ? (s[k] as boolean) : d.show[k]);
  return {
    on: x.on !== false,
    intensity: x.intensity === 'chill' || x.intensity === 'hot' ? x.intensity : 'normal',
    freq: numIn(x.freq, 0.25, 3, 1),
    show: { fighters: b('fighters'), warps: b('warps'), barrages: b('barrages'), lasers: b('lasers'), threats: b('threats'), planet: b('planet') },
    seed: Math.round(numIn(x.seed, 0, 2 ** 31 - 1, 1)),
    epoch: numIn(x.epoch, 0, 1e14, 0),
    support: x.support !== false,
    min: numIn(x.min, 0, 10000, 5),
    threatMin: numIn(x.threatMin, 0, 10000, 20),
    shake: x.shake !== false,
    alert: x.alert !== false,
    cryo: x.cryo !== false,
    droppod: x.droppod !== false,
    events,
  };
}

/** Which space event a support event of this USD value triggers (null = none). `acts` = the room's kept acts
 *  (spaceActsOf; null / missing = all): in a room without threats a big support event plays as a barrage instead. */
export function spaceSupportKind(st: SceneSpaceState, usd: number, acts?: ReadonlySet<string> | null): 'threat' | 'barrage' | null {
  if (!st.support || !(usd > 0)) return null;
  if (st.threatMin > 0 && usd >= st.threatMin && st.show.threats && spaceActOn(acts, 'threat')) return 'threat';
  if (usd >= Math.max(0.01, st.min) && spaceActOn(acts, 'barrage')) return 'barrage';
  return null;
}
