// The "Slap!" gag — host-owned, every OBS page plays the same thing (docs/SCENES.md → "Slap!").
//
// The host presses 🖐 Slap (Scene tab, Shift+S, Stream Deck `POST /api/command {"command":"slap","args":{"target":…}}`):
// the host's studio resolves the target ('random' → a concrete member key), stamps an event
// {seq, at (host clock, a short lead ahead), target, seed} into its stage-mode bag SceneState.modes.slap, and every page
// (the host's OBS + preview, every party guest's OBS — guests shift `at` into their own clock, controller.ts) plays the
// same deterministic choreography from (room, target, seed, at): the minion (the chat buddy's model by default, or any
// library avatar — loaded from each page's OWN library, no costume, never saved, never a party member) runs in, winds
// up, slaps, the target is knocked over, the minion bows and runs off. Nothing in it needs per-page randomness.
//
// The bag is plain JSON (≤ 6 KB, re-validated on read like every mode bag).

export const SLAP_BAG = 'slap';

/** Choreography clock (seconds after `at`). IMPACT = the slap lands; the hit-stop holds everything for STOP. */
export const SLAP_T = {
  /** The slap lands (seconds after the event's start). */
  impact: 2.0,
  /** Hit-stop at the impact (s): the minion and the knocked performer hold still for this long. */
  stop: 0.09,
  /** Everything (minion gone, the performer back on tracking) — pages drop the event after this. */
  total: 5.2,
  /** The camera goes back to the show's own shot. */
  release: 4.75,
  /** Host lead (ms) between the button and the start: the state reaches every page + the minion model loads. */
  lead: 900,
  /** Host cooldown (ms) from one start to the next press: the next gag starts (after the lead) once this one is over. */
  cooldown: 4600,
} as const;

export interface SlapEvent {
  /** Bumps on every slap. */
  seq: number;
  /** Start (epoch ms, host clock; guests' controllers shift it into theirs). */
  at: number;
  /** Member key ('@host' / party id / 'lib:x' stand-ins), already resolved from 'random' by the host. */
  target: string;
  /** Choreography choices (side, bow or dust-off …). */
  seed: number;
}

export interface SlapBag {
  /** Slapper model: '' = the same as the chat buddy (Sprocket unless the host picked another), else an avatar id. */
  model: string;
  /** Punch + thud sounds on the OBS pages (CC0 Kenney impact pack). */
  sound: boolean;
  /** The latest slap (null = none yet). */
  ev: SlapEvent | null;
}

export const DEFAULT_SLAP: SlapBag = { model: '', sound: true, ev: null };

const KEY = /^(@host|[a-z0-9]{6,32}|lib:[A-Za-z0-9_-]{1,48})$/;
const AVATAR = /^[A-Za-z0-9_-]{0,48}$/;

export function sanitizeSlap(o: unknown): SlapBag {
  const x = (o && typeof o === 'object' && !Array.isArray(o) ? o : {}) as Record<string, unknown>;
  const e = (x.ev && typeof x.ev === 'object' ? x.ev : null) as Record<string, unknown> | null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  let ev: SlapEvent | null = null;
  if (e && typeof e.target === 'string' && KEY.test(e.target) && num(e.at) > 0 && num(e.seq) >= 0) {
    ev = { seq: Math.floor(num(e.seq)), at: num(e.at), target: e.target, seed: Number.isFinite(num(e.seed)) ? Math.abs(Math.floor(num(e.seed))) % 2147483647 : 1 };
  }
  return {
    model: typeof x.model === 'string' && AVATAR.test(x.model) ? x.model : DEFAULT_SLAP.model,
    sound: typeof x.sound === 'boolean' ? x.sound : DEFAULT_SLAP.sound,
    ev,
  };
}

/** Guest studios: the host's clock → ours (the same offset the walks use, controller.ts onHostState). */
export function shiftSlapClock(modes: Record<string, unknown> | undefined, off: number) {
  const b = modes?.[SLAP_BAG] as { ev?: { at?: unknown } } | undefined;
  if (b?.ev && typeof b.ev.at === 'number' && Number.isFinite(b.ev.at)) b.ev.at += off;
}

/** Choreography time with the hit-stop folded in: holds at the impact for SLAP_T.stop. */
export function slapTau(t: number): number {
  const I = SLAP_T.impact;
  return t < I ? t : t < I + SLAP_T.stop ? I : t - SLAP_T.stop;
}

/** Deterministic 0..1 from a seed and a salt (every page picks the same). */
export function slapRand(seed: number, salt: number): number {
  let x = (Math.imul(seed | 0, 374761393) + Math.imul(salt | 0, 668265263)) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** 'random' → a performer: a guest in the room when there is one (the host is the one pressing the button), else the host. */
export function pickSlapTarget(keys: string[], seed: number, host = '@host'): string | null {
  const guests = keys.filter((k) => k !== host);
  const pool = guests.length ? guests : keys;
  if (!pool.length) return null;
  return pool[Math.floor(slapRand(seed, 17) * pool.length) % pool.length];
}
