// Desert weather helpers (pure): sandstorm level -> visibility, the haboob wall's approach, and the WeatherParams a
// room environment can use for a 'sandstorm' weather (the voyage lane / integrator adds it to ENV_WEATHERS; this module
// does not edit shared/environment.ts).
import type { WeatherParams } from '../environment.ts';
import { clamp01, sstep } from './noise.ts';

/** What the environment engine should do during a sandstorm (SPEC D15: cloud .65, dark .4, fog .9, wind 1, no rain, dust 1). */
export const SANDSTORM_WEATHER: WeatherParams & { dust: number } = { cloud: 0.65, cloudDark: 0.25, dark: 0.4, rain: 0, fog: 0.9, wind: 1, bolt: 0, wet: 0, dust: 1 };

/** Visibility (m) at storm level s: ~40 km clear .. 120 m at the core. */
export function stormVisibility(s: number): number {
  const k = clamp01(s);
  return 120 + (40000 - 120) * Math.pow(1 - k, 3.2);
}

/** Haboob wall distance (m, upwind of the ship) for a storm ramping in: front 0 = far (3 km), 1 = arrived (inside).
 *  The voyage lane drives `front` from its storm beat (closed form); the wall fades once it has passed the ship. */
export function haboobDistance(front: number): number {
  const k = clamp01(front);
  return 3200 * (1 - k) - 60 * k;
}

/** How much of the storm is "inside" for a wall front (0 before arrival, 1 inside). */
export function stormInside(front: number): number { return sstep(0.88, 1, clamp01(front)); }

/** Convenience: a storm beat of length `dur` seconds at time t since its start -> {front, level}: the wall approaches
 *  for the first 25 %, the core holds, the last 20 % clears. */
export function stormBeat(t: number, dur: number): { front: number; level: number } {
  if (t <= 0 || t >= dur) return { front: 0, level: 0 };
  const a = dur * 0.25, b = dur * 0.8;
  if (t < a) { const f = t / a; return { front: f, level: sstep(0.82, 1, f) }; }
  if (t < b) return { front: 1, level: 1 };
  return { front: 1, level: 1 - sstep(b, dur, t) };
}
