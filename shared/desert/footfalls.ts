// Closed-form footfalls: where and when each foot of a walker plants on the desert, from journey distance alone.
// Gait phase is DISTANCE, not dt (every page agrees; a page opened mid-voyage sees the same trail of prints):
//   leg i plants for the k-th time when the walker has travelled (k + phase_i) * stride metres; during stance (duty *
//   stride metres of travel) the foot stays put, centred under its hip at mid-stance, so it lands half a stance ahead:
//   plant position = P(d_k + duty * stride / 2) + R(heading) * hip.
// The ship lane's foot IK should use footTarget() / plantAt() so feet land exactly on their prints and never slide
// (integration contract: src/scene/desert/index.ts header).
// GaitLike is deliberately minimal: shared/gait.ts (mech lane) can produce one from its own gait description.
import type { DesertRoute, RoutePoint } from './route.ts';
import { DesertRoute as Route } from './route.ts';
import { hash32 } from './noise.ts';

export interface GaitLike {
  /** Hip positions in the ROOM frame (x starboard, z aft; bow = -z), metres, + gait phase 0..1. */
  legs: { hip: [number, number]; phase: number }[];
  /** Distance travelled per full gait cycle (m). */
  stride: number;
  /** Fraction of the cycle a foot is planted. */
  duty: number;
  /** Footprint half-width (m). */
  foot?: number;
  /** Footprint length / width (sled feet > 1, round pads 1). */
  footLen?: number;
  /** Swing apex height (m) for footTarget (default 1.5). */
  lift?: number;
}

export interface Plant {
  /** Stable id (leg, k) for dust seeding. */
  id: number;
  leg: number;
  k: number;
  /** Journey distance at touchdown. */
  d: number;
  /** World position + heading (rad). */
  x: number; z: number; yaw: number;
  r: number;
  /** length / width of the print */
  len: number;
}

/** The SPEC walking ship (SPEC D3 / D4 / 2.5, build/out/rig.json = the runtime truth): six legs in the
 *  SPEC's gaitFor('tripod', ['L1','L2','L3','R1','R2','R3']) order, rest soles from rig.json in the room frame (bow -Z,
 *  starboard +X, k = 20): L1 (-6.872, -14.562), L2 (-8.962, -3.15), L3 (-7.06, 7.436), R1 (6.872, -14.562),
 *  R2 (8.962, -3.15), R3 (7.06, 7.436). Tripods {L1, R2, L3} / {R1, L2, R3} (shared/gait.ts familyOffsets: 0 / .5),
 *  stride L = 6.0 m for every speed (D4), duty .55, lift 1.4 m; sled soles ~2.7 x 1.7 m. Sand at rest: room y -12.844. */
export const SHIP_GAIT: GaitLike = {
  legs: [
    { hip: [-6.872, -14.562], phase: 0 }, { hip: [-8.962, -3.15], phase: 0.5 }, { hip: [-7.06, 7.436], phase: 0 },
    { hip: [6.872, -14.562], phase: 0.5 }, { hip: [8.962, -3.15], phase: 0 }, { hip: [7.06, 7.436], phase: 0.5 },
  ],
  stride: 6, duty: 0.55, foot: 0.85, footLen: 1.6, lift: 1.4,
};
/** Leg ids in SHIP_GAIT order. */
export const SHIP_LEG_IDS = ['L1', 'L2', 'L3', 'R1', 'R2', 'R3'] as const;
/** Room y of the SPEC ship's sand at rest (SPEC D2 / rig.json groundY). */
export const SHIP_GROUND_Y = -12.844;

/** Adapter from shared/gait.ts (mech lane, desert_walker/SPEC.md section 2.1): offsets + duty + cycleDist(spec), with
 *  the rest foot positions in the room frame. Kept structural so this module does not import the gait lane.
 *  Phase convention: gait.ts touches leg i down at dist = (n - offsets[i]) * stride; here plant k lands at
 *  (k + phase) * stride, so phase = frac(-offset) (the same plants for any offset, not only the tripod's 0 / .5). */
export function gaitLikeFrom(spec: { offsets: number[]; duty: number; lift?: number }, cycleDist: number, feet: [number, number][], foot = 0.9, footLen = 1): GaitLike {
  const fr = (x: number) => x - Math.floor(x);
  return { legs: feet.map((f, i) => ({ hip: f, phase: fr(-(spec.offsets[i] ?? 0)) })), stride: cycleDist, duty: spec.duty, foot, footLen, lift: spec.lift };
}

/** The Desert Star Walker (4 legs, lateral-sequence walk HL 0 / FL .25 / HR .5 / FR .75), scaled by its leg length. */
export function walkerGait(halfWidth = 1.2, halfLength = 1.6, stride = 2.2, foot = 0.45): GaitLike {
  return {
    legs: [
      { hip: [-halfWidth, halfLength], phase: 0 }, { hip: [-halfWidth, -halfLength], phase: 0.25 },
      { hip: [halfWidth, halfLength], phase: 0.5 }, { hip: [halfWidth, -halfLength], phase: 0.75 },
    ],
    stride, duty: 0.75, foot,
  };
}

const tmp: RoutePoint = { x: 0, z: 0, heading: 0, curv: 0 };

/** Where plant k of leg `leg` lands. */
export function plantAt(route: DesertRoute, gait: GaitLike, leg: number, k: number, out?: Plant): Plant {
  const L = gait.legs[leg];
  const d = (k + L.phase) * gait.stride;
  route.at(d + (gait.duty * gait.stride) / 2, tmp);
  const [wx, wz] = Route.toWorld(tmp.heading, L.hip[0], L.hip[1]);
  const p = out ?? { id: 0, leg, k, d, x: 0, z: 0, yaw: 0, r: 0, len: 1 };
  p.id = hash32(leg, k, 0x77) ; p.leg = leg; p.k = k; p.d = d; p.x = tmp.x + wx; p.z = tmp.z + wz; p.yaw = tmp.heading; p.r = gait.foot ?? 1; p.len = gait.footLen ?? 1;
  return p;
}

/** The most recent `perLeg` plants of every leg at journey distance d (touchdown d_k <= d), newest first per leg. */
export function footfalls(route: DesertRoute, d: number, gait: GaitLike, perLeg: number, out: Plant[] = []): Plant[] {
  let n = 0;
  for (let i = 0; i < gait.legs.length; i++) {
    const kLast = Math.floor(d / gait.stride - gait.legs[i].phase);
    for (let j = 0; j < perLeg; j++) {
      const k = kLast - j;
      out[n] = plantAt(route, gait, i, k, out[n]);
      n++;
    }
  }
  out.length = n;
  return out;
}

/** Foot target for IK at journey distance d: planted (stance) position, or the swing arc between lift-off and the next
 *  plant (height = lift * sin(pi u)). World coordinates + y offset above the ground (caller adds the ground height). */
export function footTarget(route: DesertRoute, gait: GaitLike, leg: number, d: number, lift = gait.lift ?? 1.5): { x: number; z: number; up: number; planted: boolean } {
  const L = gait.legs[leg];
  const ph = d / gait.stride - L.phase;
  const k = Math.floor(ph), u = ph - k;           // u in [0, 1): 0 = touchdown of plant k
  const cur = plantAt(route, gait, leg, k);
  if (u < gait.duty) return { x: cur.x, z: cur.z, up: 0, planted: true };
  const nxt = plantAt(route, gait, leg, k + 1);
  const s = (u - gait.duty) / (1 - gait.duty);
  const e = s * s * (3 - 2 * s);
  return { x: cur.x + (nxt.x - cur.x) * e, z: cur.z + (nxt.z - cur.z) * e, up: lift * Math.sin(Math.PI * s), planted: false };
}

/** The ship's footprint set at journey distance d for a uniform budget of `cap` prints (keeping `reserve` for other
 *  walkers): perLeg = floor((cap - reserve) / legs) newest plants per leg, each fading with its age so that it is fully
 *  refilled exactly when it drops out of the set (age = perLeg * stride): no print ever pops out. Storms refill faster
 *  (the fade ends at (1 - 0.5 storm) of that). Pure: the same prints on every page. Returns the number written. */
export function shipPrints(route: DesertRoute, gait: GaitLike, d: number, cap: number, storm: number, plants: Plant[], out: { plant: Plant; strength: number }[], reserve = 4): { n: number; perLeg: number; life: number } {
  const legs = gait.legs.length;
  if (!legs) { out.length = 0; return { n: 0, perLeg: 0, life: 0 }; }
  const perLeg = Math.max(1, Math.floor((cap - reserve) / legs));
  const life = perLeg * gait.stride;
  const s = Math.min(1, Math.max(0, storm));
  const fadeEnd = life * (1 - 0.5 * s), fadeStart = fadeEnd * 0.45;
  footfalls(route, d, gait, perLeg, plants);
  let n = 0;
  for (const p of plants) {
    const age = d - p.d;
    const t = Math.min(1, Math.max(0, (age - fadeStart) / (fadeEnd - fadeStart)));
    const k = 1 - t * t * (3 - 2 * t);
    if (k <= 0.004) continue;
    const o = out[n] ?? (out[n] = { plant: p, strength: 0 });
    o.plant = p; o.strength = k;
    n++;
  }
  out.length = n;
  return { n, perLeg, life };
}
