// Era shifts (rooms whose scene.json has `eras`, first user: assets/scenes/lastepoch_end_of_time): every few minutes a
// time crystal forms over the stage, cracks, and the world around the performers shifts to another era (sky, fog,
// light, backdrop set, ambient FX + NPCs), cycling through the room's list. Host-owned + deterministic like the raid /
// space / environment systems: every page (studio preview, OBS, party guests' OBS) derives the same timeline from this
// state + the wall clock, no per-frame messages. A page opened mid-shift lands mid-shift.
//
// Timeline: `base` = the start (epoch ms) of a shift INTO era `index`. Shift k (k ≥ 0) starts at base + k·every and
// goes into era (index + k) mod n. Before `base` the room shows era index − 1. `on` = false stops the periodic shifts
// (k = 0 only, so "Shift now" still works). Each shift = build-up (crystal) + the shift itself (ripple, dissolve).

export interface SceneEraState {
  /** periodic shifts on */
  on: boolean;
  /** minutes between shifts (1..15) */
  every: number;
  /** start of the anchored shift into era `index` (epoch ms) */
  base: number;
  /** era the anchored shift goes into (index into the room's list, any integer; wrapped mod n) */
  index: number;
  seed: number;
  /** support events (≥ min, approx. USD) trigger a shift */
  support: boolean;
  min: number;
}

export const DEFAULT_ERA_STATE: SceneEraState = { on: true, every: 5, base: 0, index: 1, seed: 1, support: false, min: 5 };

/** room config (scene.json "eras") — timings in seconds */
export interface RoomEraTiming { build: number; shift: number }
export const DEFAULT_ERA_TIMING: RoomEraTiming = { build: 5.2, shift: 4.6 };

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export function sanitizeEraState(o: unknown): SceneEraState {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  return {
    on: x.on !== false,
    every: num(x.every, 1, 15, DEFAULT_ERA_STATE.every),
    base: num(x.base, 0, 1e14, 0),
    index: Math.round(num(x.index, -1e6, 1e6, 1)),
    seed: Math.round(num(x.seed, 0, 2 ** 31, 1)),
    support: x.support === true,
    min: num(x.min, 0, 1e6, DEFAULT_ERA_STATE.min),
  };
}

const wrap = (i: number, n: number) => ((i % n) + n) % n;

export interface EraMoment {
  /** era showing (the destination once a shift is past its build-up crack) */
  current: number;
  /** a shift in progress: from → to, phase = seconds since its start (build-up, then the shift) */
  shift: { from: number; to: number; phase: number; at: number } | null;
  /** next shift start (epoch ms), null = none scheduled */
  next: number | null;
}

/** Where the era timeline is at wall-clock `now` (ms) for a room with `n` eras. */
export function eraAt(s: SceneEraState, n: number, now: number, timing: RoomEraTiming = DEFAULT_ERA_TIMING): EraMoment {
  if (n < 2 || !s.base) return { current: 0, shift: null, next: null };
  const P = Math.max(1, s.every) * 60_000;
  const dur = (timing.build + timing.shift) * 1000;
  if (now < s.base) return { current: wrap(s.index - 1, n), shift: null, next: s.base };
  const k = s.on ? Math.floor((now - s.base) / P) : 0;
  const start = s.base + k * P;
  const to = wrap(s.index + k, n), from = wrap(s.index + k - 1, n);
  const next = s.on ? start + P : null;
  const ph = (now - start) / 1000;
  if (now - start < dur) return { current: ph < timing.build ? from : to, shift: { from, to, phase: ph, at: start }, next };
  return { current: to, shift: null, next };
}

/** Host: the state for "shift now" (starts in `lead` ms, into the era after the one showing). */
export function eraShiftNow(s: SceneEraState, n: number, now: number, lead = 250, timing: RoomEraTiming = DEFAULT_ERA_TIMING): SceneEraState {
  const m = eraAt(s, n, now, timing);
  const cur = m.shift ? m.shift.to : m.current;
  return { ...s, base: now + lead, index: cur + 1 };
}

/** Host: re-anchor after the interval / on-off changed so nothing jumps (the next shift is `every` from now). */
export function eraReanchor(s: SceneEraState, n: number, now: number, timing: RoomEraTiming = DEFAULT_ERA_TIMING): SceneEraState {
  const m = eraAt(s, n, now, timing);
  if (m.shift) return s;                            // never re-anchor mid-shift
  return { ...s, base: now + Math.max(1, s.every) * 60_000, index: m.current + 1 };
}
