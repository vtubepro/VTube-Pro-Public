// The kitchen (fast-food room, src/scene/kitchen/*): background frog crew, food fights, the manager, the
// donation-fed unrest meter and riots. Part of the host-owned SceneState (SceneState.kitchen) so the studio preview,
// every OBS page and party guests all play the SAME kitchen from the same seed + clock. Rooms opt in with KITCHEN_*
// anchors (docs/SCENES.md → "Kitchen").

/** A timed kitchen event (host clock, epoch ms). Kinds: 'foodfight' (a fight right now, the manager ends it), 'riot'
 *  (the crew goes insane; the freezer guy pacifies them), 'manager' (a surprise inspection: he storms in and yells),
 *  'stir' (a donation stirred the crew: one frog seethes). `user` / `amount` = the supporter shown on the meter. */
export interface KitchenEventStamp { k: string; at: number; id: string; user?: string; amount?: string }

export interface SceneKitchenState {
  /** The crew works + random food fights. Events / tests play either way while the room has the anchors. */
  on: boolean;
  /** Random food fights on / off. */
  fights: boolean;
  /** Food fight frequency multiplier (0.25 … 3; 1 = one every ~4 min). */
  freq: number;
  /** Shared simulation seed + clock origin (epoch ms), re-stamped by the host when fights / freq change. */
  seed: number;
  epoch: number;
  /** Donations feed the unrest meter. */
  donations: boolean;
  /** Unrest ($, USD value of support events) at host time `unrestAt`; it cools by `decay` $ per minute. */
  unrest: number;
  unrestAt: number;
  /** $ of unrest that starts a riot (the meter's top). Halfway there the crew starts a food fight. */
  riotAt: number;
  /** $ per minute the unrest cools down (0 = never). */
  decay: number;
  /** Riots cut the camera to the kitchen (never during React). */
  riotCam: boolean;
  /** Recent timed events (≤ 8, oldest dropped). */
  events: KitchenEventStamp[];
}

export const DEFAULT_KITCHEN_STATE: SceneKitchenState = {
  on: true, fights: true, freq: 1, seed: 1, epoch: 0, donations: true, unrest: 0, unrestAt: 0, riotAt: 50, decay: 0.5, riotCam: true, events: [],
};

/** scene.json `kitchen` (room defaults). */
export interface RoomKitchenConfig {
  frogHeight?: number;
  managerHeight?: number;
  bruteHeight?: number;
  /** Folder of the NPC GLBs inside the room (default 'npc'). */
  npc?: string;
}

export const KITCHEN_EVENT_KIND = /^[a-z][a-z0-9_]{0,23}$/;
export const KITCHEN_EVENTS = ['foodfight', 'riot', 'manager', 'stir'] as const;

const numIn = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const clean = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n) : '');

export function sanitizeKitchenState(o: unknown): SceneKitchenState {
  const d = DEFAULT_KITCHEN_STATE;
  if (!o || typeof o !== 'object') return { ...d, events: [] };
  const x = o as Record<string, unknown>;
  const events: KitchenEventStamp[] = [];
  if (Array.isArray(x.events)) {
    for (const e of x.events.slice(-8)) {
      if (!e || typeof e !== 'object') continue;
      const v = e as Record<string, unknown>;
      if (typeof v.k !== 'string' || !KITCHEN_EVENT_KIND.test(v.k) || typeof v.at !== 'number' || !Number.isFinite(v.at) || v.at <= 0 || v.at > 1e14) continue;
      const id = clean(v.id, 80);
      if (!id) continue;
      const ev: KitchenEventStamp = { k: v.k, at: v.at, id };
      const user = clean(v.user, 32), amount = clean(v.amount, 24);
      if (user) ev.user = user;
      if (amount) ev.amount = amount;
      events.push(ev);
    }
  }
  return {
    on: x.on !== false,
    fights: x.fights !== false,
    freq: numIn(x.freq, 0.25, 3, 1),
    seed: Math.round(numIn(x.seed, 0, 2 ** 31 - 1, 1)),
    epoch: numIn(x.epoch, 0, 1e14, 0),
    donations: x.donations !== false,
    unrest: numIn(x.unrest, 0, 1e6, 0),
    unrestAt: numIn(x.unrestAt, 0, 1e14, 0),
    riotAt: numIn(x.riotAt, 1, 100000, 50),
    decay: numIn(x.decay, 0, 1000, 0.5),
    riotCam: x.riotCam !== false,
    events,
  };
}

/** The meter's value ($) at host time `now`. */
export function kitchenUnrestAt(s: Pick<SceneKitchenState, 'unrest' | 'unrestAt' | 'decay'>, now: number): number {
  if (!s.unrest) return 0;
  const mins = Math.max(0, now - (s.unrestAt || now)) / 60000;
  return Math.max(0, s.unrest - s.decay * mins);
}
