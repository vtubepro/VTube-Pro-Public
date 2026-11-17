// The Trail — size classes → gameplay (DESIGN.md §6). Pure data + maths (sim, client prediction, rules, tests).
import { avatarSize, sizeClassOf, type SizeClass } from '../avatarSize.ts';

export interface SizeStats {
  cls: SizeClass;
  /** In-game standing height (m): the performer's real height clamped for playability. */
  height: number;
  /** Walk / sprint speed (m/s). */
  walk: number; sprint: number;
  /** Jump apex height (m). */
  jump: number;
  /** Lift strength (kg a player can hold up alone). */
  lift: number;
  /** Food appetite multiplier (a normal = 1). */
  appetite: number;
  /** Water depth before the current sweeps them away (m). */
  wade: number;
  /** Physics mass (kg). */
  mass: number;
  /** Capsule radius / half-height of the cylinder part (m). Total capsule height = 2·(half + radius) = height. */
  radius: number; half: number;
  /** Eye height (first-person camera, m above the feet). */
  eye: number;
}

export const GAME_MIN_H = 0.25, GAME_MAX_H = 6;

const BASE: Record<SizeClass, Omit<SizeStats, 'cls' | 'height' | 'radius' | 'half' | 'eye'>> = {
  micro: { walk: 3.0, sprint: 5.0, jump: 0.5, lift: 8, appetite: 0.25, wade: 0.15, mass: 3 },
  small: { walk: 3.3, sprint: 5.5, jump: 0.6, lift: 25, appetite: 0.6, wade: 0.45, mass: 25 },
  normal: { walk: 3.2, sprint: 6.0, jump: 0.9, lift: 45, appetite: 1, wade: 0.9, mass: 70 },
  large: { walk: 3.2, sprint: 5.8, jump: 0.9, lift: 80, appetite: 1.6, wade: 1.3, mass: 140 },
  macro: { walk: 3.5, sprint: 7.0, jump: 1.2, lift: 250, appetite: 3, wade: 3.5, mass: 600 },
};

/** Gameplay stats for a performer of real height `h` (m; ≤ 0 / NaN = an ordinary human). */
export function sizeStats(h: number): SizeStats {
  const real = h > 0 && Number.isFinite(h) ? h : 1.7;
  const cls = sizeClassOf(real);
  const height = Math.min(GAME_MAX_H, Math.max(GAME_MIN_H, real));
  const b = BASE[cls];
  // micro jumps relative to their height (they are springy), everyone else fixed
  const jump = cls === 'micro' ? Math.max(b.jump, height * 1.3) : b.jump;
  const radius = Math.min(height * 0.22, cls === 'macro' ? height * 0.18 : 0.42);
  const half = Math.max(0.01, height / 2 - radius);
  // speed follows size (v2): stride grows with leg length, so ground speed ~ √height — a micro scurries but covers
  // ground slowly, a macro strolls faster than you can run (floors keep tiny players playable)
  const k = Math.sqrt(height / 1.7);
  const walk = Math.min(6.5, Math.max(1.6, 3.2 * k)), sprint = Math.min(10, Math.max(3.2, 6.0 * k));
  return { cls, height, ...b, walk, sprint, jump, radius, half, eye: height * 0.92 };
}

/** From a (shared) avatar profile: `{size: {height}}` or nothing. */
export function statsOfProfile(p: { size?: unknown } | null | undefined): SizeStats {
  const s = avatarSize(p);
  return sizeStats(s.height);
}

/** Wagon / ferry load weight of a player (kg), what tips things over. */
export const riderWeight = (s: SizeStats) => s.mass;

/** Initial jump velocity for an apex height under gravity g. */
export const jumpVelocity = (apex: number, g = 9.81) => Math.sqrt(2 * g * Math.max(0.05, apex));
