// Voyage gait (pure maths, no THREE): the ship's legs as a closed-form function of the distance walked S, so every page
// agrees and planted feet never slide (a stance foot's world position is fixed by construction).
//
// The phase is distance, not dt: p_i = frac(S / cycle + phi_i). Stance while p < duty (the foot is planted at
//   s = S_touchdown + fwdRest + duty*cycle/2, i.e. it walks from +duty*cycle/2 ahead of its rest point to -duty*cycle/2
//   behind it while the hull moves on); swing for the rest, in three mechanical sub-phases (lift / swing / slam) that
//   match the mech lane's MechRig (desert_walker locomotion report section 4b), so a mech guest walking alongside reads
//   as the same machine family.
//
// ONE gait module (desert_walker/SPEC.md D9, the walking-ship SPEC 1): the default adapter is shared/gait.ts (the
// walker's and the enemies' gait too). The built-in adapter stays for tests / comparison (setVoyageGait(builtinGait)).
import { gaitPhases, swingProfile } from '../../../shared/gait.ts';

export interface GaitFoot {
  /** along-track world s of the foot (m) */ s: number;
  /** lateral world d (m, + = starboard) */ d: number;
  /** lift above the ground (m) */ lift: number;
  stance: boolean;
  /** swing progress 0..1 (0 in stance) */ u: number;
  /** cycle index of the current / last touchdown */ k: number;
  /** world s where the foot (will) touch down: stance = s; swing = the next plant */ plantS: number;
  /** distance walked since the last plant (m) - feeds dust puffs / footprints */ sincePlant: number;
}

export interface GaitLeg {
  id: string;
  /** rest foot position relative to the ship origin, along-track (+ = forward / bow) and lateral (+ = starboard), m */
  fwd: number; lat: number;
  /** phase offset 0..1 */ phi: number;
}

export interface GaitParams { cycle: number; duty: number; height: number }

/** What an engine needs from a gait library. */
export interface VoyageGaitAdapter {
  readonly name: string;
  /** phase offsets for legs with these ids (FL ML BL FR MR BR / L1.. R1.. / any); type 'tripod' | 'wave' | 'quad' | 'biped' */
  phases(ids: readonly string[], type: string): number[];
  /** swing profile at swing progress u (0..1): horizontal progress 0..1 and lift 0..1 (times the step height) */
  swing(u: number): { h: number; y: number };
}

const sm = (u: number) => { const t = u <= 0 ? 0 : u >= 1 ? 1 : u; return t * t * (3 - 2 * t); };
const easeOutCubic = (u: number) => 1 - (1 - u) ** 3;
const easeInQuad = (u: number) => u * u;

const bare = (id: string) => id.replace(/^LEG_/i, '');
const sideOf = (raw: string): 'L' | 'R' | '?' => { const id = bare(raw); return /^[FMBH]?L|^L\d|_L/i.test(id) ? 'L' : /^[FMBH]?R|^R\d|_R/i.test(id) ? 'R' : '?'; };
const rankOf = (raw: string): number => {
  const id = bare(raw);
  const m = /([FMBH])[LR]|[LR]([FMBH])/i.exec(id);
  const c = (m?.[1] ?? m?.[2] ?? '').toUpperCase();
  if (c === 'F') return 0; if (c === 'M') return 1; if (c === 'B' || c === 'H') return 2;
  const n = /(\d+)/.exec(id); return n ? parseInt(n[1], 10) - 1 : 0;
};

/** The built-in adapter: alternating tripod for six legs ({FL, MR, BL} vs {FR, ML, BR}), a wave gait, the mech lane's
 *  quad / biped defaults; lift (easeOutCubic, vertical only) / swing (smoothstep) / slam (easeInQuad). */
export const builtinGait: VoyageGaitAdapter = {
  name: 'voyage-builtin',
  phases(ids, type) {
    const n = ids.length;
    if (type === 'biped' || n === 2) return ids.map((id) => (sideOf(id) === 'R' ? 0.5 : 0));
    if (type === 'quad' || n === 4) return ids.map((id) => { const s = sideOf(id), r = rankOf(id); return s === 'L' ? (r === 0 ? 0.25 : 0) : (r === 0 ? 0.75 : 0.5); });
    if (type === 'wave') return ids.map((id) => { const s = sideOf(id), r = rankOf(id); return ((2 - Math.min(2, r)) / 6 + (s === 'R' ? 0.5 : 0)) % 1; });
    // tripod: rank parity xor side; a tiny ripple per rank keeps three feet from slamming in the same frame
    return ids.map((id) => { const s = sideOf(id) === 'R' ? 1 : 0, r = rankOf(id); return (((r + s) % 2) * 0.5 + 0.02 * r) % 1; });
  },
  swing(u) {
    if (u < 0.25) return { h: 0, y: easeOutCubic(u / 0.25) };
    if (u < 0.8) { const w = (u - 0.25) / 0.55; return { h: sm(w), y: 1 + 0.12 * Math.sin(Math.PI * w) }; }
    return { h: 1, y: 1 - easeInQuad((u - 0.8) / 0.2) };
  },
};

/** shared/gait.ts (the default): familyOffsets for the leg ids ('tripod' {L1 R2 L3} / {R1 L2 R3} at 0 / .5, 'wave' =
 *  ripple for six legs, 'quad' = walk), and its lift / carry / slam swing (DEFAULT_SWING). */
export const sharedGaitAdapter: VoyageGaitAdapter = {
  name: 'shared/gait',
  phases: (ids, type) => gaitPhases(ids, type),
  swing: (u) => { const s = swingProfile(u); return { h: s.forward, y: s.lift }; },
};
let current: VoyageGaitAdapter = sharedGaitAdapter;
/** Point the voyage at another gait library (tests); null = shared/gait.ts. */
export function setVoyageGait(a: VoyageGaitAdapter | null) { current = a ?? sharedGaitAdapter; }
export const voyageGait = () => current;

/** One foot at distance S (closed form). `w` (0..1) scales the step height: 0 = feet stay on the ground (stopped). */
export function footAt(S: number, leg: GaitLeg, g: GaitParams, w: number, out: GaitFoot): GaitFoot {
  const L = Math.max(0.5, g.cycle), D = Math.min(0.95, Math.max(0.05, g.duty));
  const x = S / L + leg.phi;
  const k = Math.floor(x);
  const p = x - k;
  const sTd = (k - leg.phi) * L;                       // ship S at this cycle's touchdown
  const plant = sTd + leg.fwd + (D * L) / 2;            // world s of this cycle's plant point
  out.d = leg.lat; out.k = k;
  if (p < D) {
    out.s = plant; out.lift = 0; out.stance = true; out.u = 0; out.plantS = plant; out.sincePlant = S - sTd;
    return out;
  }
  const u = (p - D) / (1 - D);
  const sw = current.swing(u);
  out.s = plant + L * sw.h;                              // from this plant (lift-off) to the next one
  out.lift = Math.max(0, sw.y) * g.height * Math.max(0, Math.min(1, w));
  out.stance = false; out.u = u; out.plantS = plant + L; out.sincePlant = S - sTd;
  return out;
}

/** Heave (m, + = up) and weight-shift roll (rad, + = starboard down) of the hull from the gait alone (no terrain):
 *  a dip at each tripod's plant (two per cycle) and a side-to-side shift once per cycle. g(v) fades both when stopped. */
export function gaitBob(S: number, cycle: number, speedK: number): { heave: number; roll: number } {
  const ph = (2 * Math.PI * S) / Math.max(0.5, cycle);
  const k = Math.max(0, Math.min(1, speedK));
  return { heave: -Math.cos(2 * ph) * k, roll: Math.sin(ph) * k };
}

/* ------------------------------------------------------------------------------------------------ shared/gait.ts hook
   sharedGaitAdapter (above) is the default. The contract the voyage needs: phases() returns one 0..1 offset per leg id; swing(u) maps swing progress to a horizontal
   progress 0..1 (0 = lift-off point, 1 = next plant) and a lift 0..1 (times the step height). Everything else (stance
   locking, distance phase, body heave) stays here because it must be closed-form in S for cross-page determinism. */
