// The relaxed arm pose the retargeter (src/avatar/retarget.ts) uses for an arm the camera isn't tracking: the upper arm
// hangs slightly out and forward, IDLE_ARM_DOWN_DEFAULT degrees below horizontal, the forearm a little bent forward.
// profile.tracking.idleArmDown (degrees below horizontal) lifts it for wide characters: a barrel-bellied pirate's hands
// sink into his body at the default ~73 degrees and rest beside it at ~50. Unset = the default pose, exactly as before.
// The whole arm swings out together (the forearm keeps its bend relative to the upper arm), and the heading (out /
// forward) is kept. Avatar space: +X = the avatar's left, +Y up, +Z front; sgn = 1 for the left arm, -1 for the right.

export type V3 = [number, number, number];

const U0: V3 = [0.28, -0.95, 0.08];
const L0: V3 = [0.12, -0.9, 0.35];
export const IDLE_ARM_DOWN_MIN = 20;
export const IDLE_ARM_DOWN_MAX = 85;

const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const DEG = 180 / Math.PI;
/** Degrees below horizontal of an avatar-space direction. */
export const downDeg = (v: V3): number => Math.atan2(-v[1], Math.hypot(v[0], v[2])) * DEG;
/** The built-in upper-arm angle (about 73 degrees below horizontal). */
export const IDLE_ARM_DOWN_DEFAULT = Math.round(downDeg(norm(U0)) * 10) / 10;

/** A clean idleArmDown (degrees below horizontal, clamped to 20..85, 0.1 degree steps) or nothing (= the default pose). */
export function sanitizeIdleArmDown(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '' || typeof v === 'boolean') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(Math.min(IDLE_ARM_DOWN_MAX, Math.max(IDLE_ARM_DOWN_MIN, n)) * 10) / 10;
}

/** Rodrigues: rotate v about unit axis k by angle a. */
function rotate(v: V3, k: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a), d = (k[0] * v[0] + k[1] * v[1] + k[2] * v[2]) * (1 - c);
  return [
    v[0] * c + (k[1] * v[2] - k[2] * v[1]) * s + k[0] * d,
    v[1] * c + (k[2] * v[0] - k[0] * v[2]) * s + k[1] * d,
    v[2] * c + (k[0] * v[1] - k[1] * v[0]) * s + k[2] * d,
  ];
}

const cache = new Map<string, { u: V3; l: V3 }>();
/** The relaxed upper-arm (u) and forearm (l) directions, unit length, in avatar space. `down` unset (or not a number) =
 *  the built-in pose. Results are shared (cached): treat them as read-only. */
export function relaxedArmDirs(sgn: 1 | -1, down?: number): { u: V3; l: V3 } {
  const d = sanitizeIdleArmDown(down);
  const key = `${sgn}:${d ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const u0 = norm([U0[0] * sgn, U0[1], U0[2]]), l0 = norm([L0[0] * sgn, L0[1], L0[2]]);
  let out = { u: u0, l: l0 };
  if (d !== undefined && Math.abs(d - downDeg(u0)) > 1e-6) {
    // same heading (out / forward), the new elevation
    const h = Math.hypot(u0[0], u0[2]), e = d / DEG;
    const u: V3 = [(u0[0] / h) * Math.cos(e), -Math.sin(e), (u0[2] / h) * Math.cos(e)];
    // the forearm turns with it (the shortest rotation that takes the old upper arm onto the new one)
    const ax: V3 = [u0[1] * u[2] - u0[2] * u[1], u0[2] * u[0] - u0[0] * u[2], u0[0] * u[1] - u0[1] * u[0]];
    const sn = Math.hypot(ax[0], ax[1], ax[2]), cs = u0[0] * u[0] + u0[1] * u[1] + u0[2] * u[2];
    const l = sn > 1e-9 ? norm(rotate(l0, [ax[0] / sn, ax[1] / sn, ax[2] / sn], Math.atan2(sn, cs))) : l0;
    out = { u, l };
  }
  if (cache.size > 256) cache.clear();
  cache.set(key, out);
  return out;
}
