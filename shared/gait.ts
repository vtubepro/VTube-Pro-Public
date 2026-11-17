// Shared gait maths for legged bodies: THE gait module (desert_walker SPEC.md §2.1). Used by mech / walker avatars
// (src/avatar/mech.ts: the Desert Star Walker's 4 legs, any mech with 2 / 4 / 6 / 8 legs) and by walking ships (the
// walking-ship voyage: six legs FL FR ML MR BL BR, and its raider walker). Pure numbers, no three.js, no state except
// the small Spring2 helper, so the studio, every OBS page, party guests, workers and the server get the same answer.
//
// The rule that makes it deterministic and slide-free: the gait PHASE IS DISTANCE, never time. A leg's cycle is
//   x_i = dist / stride + offset_i,   p_i = frac(x_i)
// with p in [0, duty) = stance (planted) and p in [duty, 1) = swing. `stride` = body travel per gait cycle. A planted
// foot sweeps from +duty*stride/2 to -duty*stride/2 relative to its neutral spot (it stays still in the world), a
// swinging foot goes back to the front. In straight travel every stance foot is world-fixed BY CONSTRUCTION; on curves
// the caller plants at the mid-stance pose (legState().tdDist + duty*stride/2), which holds for any path.
//
// Conventions: body frame +X = the body's own left, +Y up, +Z forward (glTF / avatar space). Rotations are right-handed
// about their axis: roll = about +Z (positive = left side up), pitch = about +X (positive = nose DOWN). Lengths are in
// the caller's unit (metres for ships, model units for avatars), consistently.
//
// SPEC CONTRACT (SPEC.md §2.1):  gaitFor · pickFamily · cycleDist · legState · plants · bodyMotion · solveHingeLeg
// VOYAGE ADAPTER (voyageGait.ts): gaitPhases(ids, type) · swingProfile(u) → { forward, lift }
// HELPERS: footPhase / footOffset / swingCurve / touchdowns / liftoffs / feetDown / bodySway / planeFit / solveLeg (planar
//          coxa + 2-link) / legFK / Spring2 / impulse / gaitAmp / maxSpeed / turnStep / parseLegId

export type V3 = [number, number, number];

/** Gait families (SPEC §2.1). walk = lateral sequence (≤ 1 foot up), march = diagonal pairs, hustle = march at duty .5,
 *  biped, tripod (6), ripple (metachronal, 6 or any), tetrapod (8); 'wave' = one foot at a time for any count. */
export type GaitFamily = 'walk' | 'march' | 'hustle' | 'biped' | 'tripod' | 'ripple' | 'tetrapod' | 'wave';
export const GAIT_FAMILIES: readonly GaitFamily[] = ['walk', 'march', 'hustle', 'biped', 'tripod', 'ripple', 'tetrapod', 'wave'];

/** Swing sub-phase shares (lift straight up, carry over the top, slam straight down; normalised to sum 1) + `hitch` =
 *  a hold at the apex in SECONDS (the servo stutter; converted to a share of the swing with the spec's period). */
export interface SwingShape { lift: number; carry: number; slam: number; hitch: number }
export const DEFAULT_SWING: SwingShape = { lift: 0.25, carry: 0.55, slam: 0.2, hitch: 0 };

/** Where a leg sits in the layout: side +1 = the body's left, -1 = right; row 0 = the front-most row. */
export interface GaitSlot { side: 1 | -1; row: number }

export interface GaitSpec {
  legs: number;
  /** Phase offset (0..1) per leg, in the caller's leg order. */
  offsets: number[];
  /** Stance share of the cycle (0.5 … 0.9). */
  duty: number;
  /** Seconds per cycle at this family's top pace (maxSpeed = stride / period). */
  period: number;
  /** Body travel per full gait cycle (length units). */
  stride: number;
  /** Swing apex height (length units). */
  lift: number;
  swing: SwingShape;
  family: GaitFamily;
  /** Per leg: side / row (body-motion signs, re-sorting). */
  sides: GaitSlot[];
  /** 'arc' = a smooth sine arc instead of lift / carry / slam (ships may prefer it). */
  style?: 'mech' | 'arc';
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const frac = (v: number) => v - Math.floor(v);
export const smoothstep = (v: number) => { const k = clamp01(v); return k * k * (3 - 2 * k); };
const easeOutQuad = (v: number) => 1 - (1 - clamp01(v)) * (1 - clamp01(v));
const easeInQuad = (v: number) => clamp01(v) * clamp01(v);
const TAU = Math.PI * 2;

// ------------------------------------------------------------------------------------------------ leg ids → slots
/**
 * A leg id → side + row. Accepts FL FR ML MR HL HR BL BR (B = back = hind), L R, L1..L9 / R1..R9, 1L..9R, and any of
 * them behind a prefix (LEG_FL, mleg_FL_2, mfoot_HR). Row: F = 0, M = 1, H / B = 2 (rank within the leg set is
 * re-normalised by `slotsFor`); digits count from the front (1 = 0). Unknown side = left.
 */
export function parseLegId(raw: string): { side: 1 | -1; rank: number } {
  const id = raw.replace(/^(LEG_|mleg_|mfoot_|mtip_)/i, '').replace(/_\d+$/, '');
  let m = /^([FMHB])([LR])$/i.exec(id);
  if (m) return { side: m[2].toUpperCase() === 'L' ? 1 : -1, rank: { F: 0, M: 1, H: 2, B: 2 }[m[1].toUpperCase() as 'F'] };
  m = /^([LR])(\d)$/i.exec(id) ?? /^(\d)([LR])$/i.exec(id);
  if (m) { const s = /[LR]/i.test(m[1]) ? m[1] : m[2], n = /\d/.test(m[1]) ? m[1] : m[2]; return { side: s.toUpperCase() === 'L' ? 1 : -1, rank: Math.max(0, Number(n) - 1) }; }
  m = /^([LR])$/i.exec(id);
  if (m) return { side: m[1].toUpperCase() === 'L' ? 1 : -1, rank: 0 };
  return { side: /R/i.test(id) && !/L/i.test(id) ? -1 : 1, rank: 0 };
}
/** Slots for a set of leg ids (rows renumbered 0.. in front-to-back order of the ranks used). */
export function slotsFor(ids: readonly string[]): GaitSlot[] {
  const p = ids.map(parseLegId);
  const ranks = [...new Set(p.map((x) => x.rank))].sort((a, b) => a - b);
  return p.map((x) => ({ side: x.side, row: ranks.indexOf(x.rank) }));
}

// ------------------------------------------------------------------------------------------------ families
export const FAMILY_DUTY: Record<GaitFamily, number> = { walk: 0.78, march: 0.62, hustle: 0.5, biped: 0.65, tripod: 0.55, ripple: 0.7, tetrapod: 0.6, wave: 0 };
export const FAMILY_PERIOD: Record<GaitFamily, number> = { walk: 1.15, march: 0.8, hustle: 0.6, biped: 0.9, tripod: 0.8, ripple: 1.0, tetrapod: 0.9, wave: 1.2 };

/** The family a leg count can actually use (walk / march / hustle are 4-leg patterns; others map to their nearest). */
export function familyFor(family: GaitFamily | 'auto', legs: number): GaitFamily {
  if (family === 'auto') return legs === 2 ? 'biped' : legs === 4 ? 'walk' : legs === 6 ? 'tripod' : legs === 8 ? 'tetrapod' : 'ripple';
  if (legs === 2) return 'biped';
  if (legs === 4) return family === 'tripod' || family === 'tetrapod' ? 'march' : family === 'ripple' ? 'walk' : family;
  if (legs === 6) return family === 'march' || family === 'hustle' || family === 'tetrapod' ? 'tripod' : family === 'walk' || family === 'biped' ? 'ripple' : family;
  if (legs === 8) return family === 'wave' || family === 'ripple' ? family : 'tetrapod';
  return family === 'wave' ? 'wave' : 'ripple';
}

/** Per segment (never per frame): the family for a planned speed. 4 legs: < 45 % of vmax walk, < 75 % march, else
 *  hustle; 6: slow = ripple, else tripod; 2 = biped; 8 = tetrapod; others ripple. */
export function pickFamily(planned: number, vmax: number, legs: number): GaitFamily {
  const r = vmax > 0 ? planned / vmax : 1;
  if (legs === 2) return 'biped';
  if (legs === 4) return r < 0.45 ? 'walk' : r < 0.75 ? 'march' : 'hustle';
  if (legs === 6) return r < 0.45 ? 'ripple' : 'tripod';
  if (legs === 8) return 'tetrapod';
  return 'ripple';
}

/** Phase offsets for slots under a family (see GaitFamily). */
export function familyOffsets(family: GaitFamily, slots: readonly GaitSlot[]): number[] {
  const n = slots.length;
  const f = familyFor(family, n);
  const rows = slots.reduce((m, l) => Math.max(m, l.row), 0) + 1;
  return slots.map((l) => {
    const right = l.side < 0 ? 1 : 0;
    switch (f) {
      case 'biped': return right * 0.5;
      case 'walk': {
        // lateral sequence: hind-left 0, fore-left .25, hind-right .5, fore-right .75
        const fore = l.row === 0 && rows > 1 ? 1 : 0;
        return frac(right * 0.5 + fore * 0.25);
      }
      case 'march': case 'hustle': case 'tripod':
        return ((l.row + right) % 2) * 0.5;
      case 'tetrapod':
        return frac(((l.row + right) % 2) * 0.5 + 0.04 * l.row);
      case 'ripple': {
        // a wave hind → front on each side (1/rows apart), the right side half a cycle behind the left
        const w = rows - 1 - l.row;
        return frac(-w / rows + right * 0.5);
      }
      default: {
        // wave: one foot at a time, hind → front on the left, then on the right
        const seq = right * rows + (rows - 1 - l.row);
        return frac(-seq / Math.max(1, 2 * rows));
      }
    }
  });
}

/** SPEC: a ready spec for a family and a list of leg ids (FL / FR / … / L1 … in the caller's order). `o` overrides any
 *  field; `o.offsets` entries that are not numbers keep the family's. Defaults: stride 1, lift 0.2 (pass yours). */
export function gaitFor(family: GaitFamily | 'auto', sides: readonly string[], o: Omit<Partial<GaitSpec>, 'offsets' | 'swing'> & { offsets?: (number | undefined)[]; swing?: Partial<SwingShape> } = {}): GaitSpec {
  const slots = o.sides ?? slotsFor(sides);
  const f = familyFor(family, slots.length);
  const base = familyOffsets(f, slots);
  const duty = o.duty ?? (f === 'wave' ? Math.max(0.5, Math.min(0.9, 1 - 1 / Math.max(2, slots.length))) : FAMILY_DUTY[f]);
  return {
    legs: slots.length,
    offsets: base.map((b, i) => (typeof o.offsets?.[i] === 'number' && Number.isFinite(o.offsets[i]) ? frac(o.offsets[i]!) : b)),
    duty: clamp(duty, 0.3, 0.95),
    period: Math.max(0.1, o.period ?? FAMILY_PERIOD[f]),
    stride: Math.max(1e-6, o.stride ?? 1),
    lift: Math.max(0, o.lift ?? 0.2),
    swing: { ...DEFAULT_SWING, ...o.swing },
    family: f,
    sides: [...slots],
    ...(o.style ? { style: o.style } : {}),
  };
}

/** SPEC: body travel per gait cycle (= spec.stride). */
export function cycleDist(spec: GaitSpec): number { return spec.stride; }

/** Top speed of a spec: one cycle per period. */
export function specSpeed(spec: GaitSpec): number { return spec.stride / spec.period; }

// ------------------------------------------------------------------------------------------------ phase + swing
export interface FootPhase {
  /** Planted. */
  stance: boolean;
  /** Raw cycle position 0..1 (0 = touchdown, duty = lift-off). */
  p: number;
  /** Progress 0..1 inside the current stance or swing. */
  u: number;
  /** Step number: increments at every lift-off (stable across pages for the same dist). */
  step: number;
}

/** Where leg `i` is in its cycle at `dist`. */
export function footPhase(dist: number, spec: GaitSpec, i: number): FootPhase {
  const x = dist / spec.stride + (spec.offsets[i] ?? 0);
  const p = frac(x), D = spec.duty;
  const step = Math.floor(x - D);
  return p < D ? { stance: true, p, u: p / D, step } : { stance: false, p, u: (p - D) / (1 - D), step };
}

/** The apex hold as a share of the swing for a spec (hitch seconds over the swing's duration at the family pace). */
export function hitchShare(spec: GaitSpec): number {
  const T = (1 - spec.duty) * spec.period;
  return T > 0 ? clamp(spec.swing.hitch / T, 0, 0.4 * spec.swing.carry / Math.max(1e-6, spec.swing.lift + spec.swing.carry + spec.swing.slam)) : 0;
}

/**
 * Swing shape at swing progress u (0..1): `s` = horizontal progress 0..1, `h` = height as a share of the apex (apex = 1).
 * 'mech': LIFT straight up to 85 % (easeOut), CARRY over the top (smoothstep; a slight arc to the apex; an optional
 * `hold` share pauses it at the apex: the servo stutter), SLAM straight down (easeIn) into the plant. 'arc': cycloid
 * horizontal + sine height.
 */
export function swingCurve(u: number, style: 'mech' | 'arc' = 'mech', shape: SwingShape = DEFAULT_SWING, hold = 0): { s: number; h: number } {
  const k = clamp01(u);
  if (style === 'arc') return { s: k - Math.sin(TAU * k) / TAU, h: Math.sin(Math.PI * k) };
  const tot = Math.max(1e-6, shape.lift + shape.carry + shape.slam);
  const a = shape.lift / tot, b = (shape.lift + shape.carry) / tot;
  if (k < a) return { s: 0, h: 0.85 * easeOutQuad(k / a) };
  if (k < b) {
    let v = (k - a) / (b - a);
    const q = clamp(hold / Math.max(1e-6, b - a), 0, 0.8);
    if (q > 0) v = v < (1 - q) / 2 ? v / (1 - q) : v < (1 + q) / 2 ? 0.5 : (v - q) / (1 - q);
    return { s: smoothstep(v), h: 0.85 + 0.15 * Math.sin(Math.PI * v) };
  }
  return { s: 1, h: 0.85 * (1 - easeInQuad((k - b) / (1 - b))) };
}

/** VOYAGE ADAPTER: swing progress → { forward (0 = lift-off point, 1 = next plant), lift (0..1 × the step height) }. */
export function swingProfile(u: number, shape: SwingShape = DEFAULT_SWING, hold = 0, style: 'mech' | 'arc' = 'mech'): { forward: number; lift: number } {
  const c = swingCurve(u, style, shape, hold);
  return { forward: c.s, lift: c.h };
}

/** VOYAGE ADAPTER: phase offsets for leg ids under a type ('tripod' | 'wave' | 'ripple' | 'quad' | 'walk' | 'march' |
 *  'hustle' | 'biped' | 'tetrapod' | 'auto'). 'quad' = walk; 'wave' for 6 legs = ripple. */
export function gaitPhases(ids: readonly string[], type: string): number[] {
  const t = type === 'quad' ? 'walk' : type === 'wave' && ids.length === 6 ? 'ripple' : type === 'hex' ? 'tripod' : type === 'octo' ? 'tetrapod' : type === 'trot' ? 'march' : type;
  const f = (GAIT_FAMILIES as readonly string[]).includes(t) ? (t as GaitFamily) : 'auto';
  return familyOffsets(familyFor(f, ids.length), slotsFor(ids));
}

export interface LegState extends FootPhase {
  /** Path distance of this stance's touchdown (stance) or of the next touchdown (swing): a pure function of dist. */
  tdDist: number;
  /** Swing progress split: vertical 0..1 (share of the lift) and horizontal 0..1 (lift-off → next plant). 0 in stance. */
  lift: number;
  carry: number;
}

/** SPEC: leg `i` at `dist`. The stance foot belongs at the mid-stance pose: tdDist + duty·stride/2. */
export function legState(spec: GaitSpec, i: number, dist: number): LegState {
  const f = footPhase(dist, spec, i);
  const x = dist / spec.stride + (spec.offsets[i] ?? 0);
  const n = Math.floor(x);
  const td = (n - (spec.offsets[i] ?? 0)) * spec.stride;
  if (f.stance) return { ...f, tdDist: td, lift: 0, carry: 0 };
  const sw = swingCurve(f.u, spec.style ?? 'mech', spec.swing, hitchShare(spec));
  return { ...f, tdDist: td + spec.stride, lift: sw.h, carry: sw.s };
}

/**
 * Straight-line travel: where foot `i` is relative to its neutral spot, along the travel (+ = ahead), and its height.
 * `stride01` scales the sweep (0 = stepping on the spot, e.g. turning in place).
 */
export function footOffset(dist: number, spec: GaitSpec, i: number, stride01 = 1): { along: number; up: number; stance: boolean; u: number } {
  const f = footPhase(dist, spec, i), c = spec.stride * stride01, D = spec.duty;
  if (f.stance) return { along: (D * c) / 2 - f.p * c, up: 0, stance: true, u: f.u };
  const sw = swingCurve(f.u, spec.style ?? 'mech', spec.swing, hitchShare(spec));
  return { along: -(D * c) / 2 + D * c * sw.s, up: spec.lift * sw.h, stance: false, u: f.u };
}

/** Route coordinate of foot `i` (straight travel along s): body at `S`, the foot's neutral spot `neutral` ahead of it. */
export function footRouteS(S: number, spec: GaitSpec, i: number, neutral: number, stride01 = 1): number {
  return S + neutral + footOffset(S, spec, i, stride01).along;
}

/** Every touchdown (stance start) with d0 < dist <= d1, oldest first. */
export function touchdowns(d0: number, d1: number, spec: GaitSpec, legs?: readonly number[]): { leg: number; dist: number; step: number }[] {
  return crossings(d0, d1, spec, 0, legs);
}
/** SPEC: plants (touchdowns) in (d0, d1]: exactly one per leg per cycle. */
export function plants(spec: GaitSpec, d0: number, d1: number): { leg: number; dist: number }[] {
  return crossings(d0, d1, spec, 0).map(({ leg, dist }) => ({ leg, dist }));
}
/** Every lift-off (swing start) with d0 < dist <= d1, oldest first. */
export function liftoffs(d0: number, d1: number, spec: GaitSpec, legs?: readonly number[]): { leg: number; dist: number; step: number }[] {
  return crossings(d0, d1, spec, spec.duty, legs);
}
function crossings(d0: number, d1: number, spec: GaitSpec, at: number, legs?: readonly number[]) {
  const out: { leg: number; dist: number; step: number }[] = [];
  if (!(d1 > d0)) return out;
  const idx = legs ?? spec.offsets.map((_, i) => i);
  for (const i of idx) {
    const o = (spec.offsets[i] ?? 0) - at;
    const a = Math.floor(d0 / spec.stride + o), b = Math.floor(d1 / spec.stride + o);
    for (let n = a + 1; n <= b && n - a <= 64; n++) out.push({ leg: i, dist: (n - o) * spec.stride, step: n });
  }
  return out.sort((x, y) => x.dist - y.dist || x.leg - y.leg);
}

/** Feet down at `dist`. */
export function feetDown(dist: number, spec: GaitSpec): number {
  let n = 0;
  for (let i = 0; i < spec.offsets.length; i++) if (footPhase(dist, spec, i).stance) n++;
  return n;
}

/** Speed → gait amplitude 0..1 (bob / sway scale): 0 at rest, 1 from `full` up. */
export function gaitAmp(speed: number, full: number): number { return full > 0 ? smoothstep(Math.abs(speed) / full) : 0; }
/** Top speed that keeps the cadence at one cycle per `period` seconds. */
export function maxSpeed(stride: number, period: number): number { return period > 0 ? stride / period : 0; }
/** Arc length a foot travels per radian of an on-the-spot turn = the footprint radius (feeds the turn's "distance"). */
export function turnStep(footprintRadius: number): number { return Math.max(1e-6, footprintRadius); }

// ------------------------------------------------------------------------------------------------ body motion
/**
 * SPEC: closed-form body motion from the legs in the air, as SHARES (the caller scales them): `drop` 0..1 (how much
 * support is missing, 1 ≈ a full support's worth of legs up), `roll` / `pitch` −1..1 toward the unsupported side / end
 * (roll − = left side down, pitch + = nose down), all × speed01.
 */
export function bodyMotion(spec: GaitSpec, dist: number, speed01: number): { drop: number; roll: number; pitch: number } {
  const n = Math.max(1, spec.legs);
  const rows = spec.sides.reduce((m, l) => Math.max(m, l.row), 0) + 1;
  let sum = 0, roll = 0, pitch = 0;
  for (let i = 0; i < spec.legs; i++) {
    const f = footPhase(dist, spec, i);
    if (f.stance) continue;
    const h = swingCurve(f.u, spec.style ?? 'mech', spec.swing, hitchShare(spec)).h;
    const s = spec.sides[i] ?? { side: 1, row: 0 };
    sum += h;
    roll += -s.side * h;
    pitch += rows > 1 ? (1 - (2 * s.row) / (rows - 1)) * h : 0;
  }
  const norm = 1 / (n * Math.max(0.05, 1 - spec.duty));
  const k = clamp01(speed01);
  return { drop: clamp(sum * norm, 0, 2) * k, roll: clamp(roll * norm, -1, 1) * k, pitch: clamp(pitch * norm, -1, 1) * k };
}

/**
 * Closed-form body sway from neutral foot spots (ships): y sags while legs are off the ground, roll / pitch lean toward
 * the side / end that lost support. `legs` = neutral foot spots in the body frame (x = left, z = forward).
 */
export function bodySway(dist: number, spec: GaitSpec, legs: readonly { x: number; z: number }[], amp: number, k: { sag: number; roll: number; pitch: number }): { y: number; roll: number; pitch: number; lifted: number } {
  const n = Math.max(1, legs.length);
  let sum = 0, roll = 0, pitch = 0;
  for (let i = 0; i < legs.length; i++) {
    const f = footPhase(dist, spec, i);
    if (f.stance) continue;
    const h = swingCurve(f.u, spec.style ?? 'mech', spec.swing, hitchShare(spec)).h;
    sum += h;
    roll += -Math.sign(legs[i].x) * h;
    pitch += Math.sign(legs[i].z) * h;
  }
  const norm = 1 / (n * (1 - spec.duty));
  return { y: -k.sag * sum * norm * amp, roll: k.roll * roll * norm * amp, pitch: k.pitch * pitch * norm * amp, lifted: sum };
}

/** Least-squares plane y = a + b x + c z through foot points (body frame): height, roll (+ = left up), pitch (+ = nose down). */
export function planeFit(points: readonly { x: number; y: number; z: number }[]): { y: number; roll: number; pitch: number; slopeX: number; slopeZ: number } {
  const n = points.length;
  if (!n) return { y: 0, roll: 0, pitch: 0, slopeX: 0, slopeZ: 0 };
  let mx = 0, my = 0, mz = 0;
  for (const p of points) { mx += p.x; my += p.y; mz += p.z; }
  mx /= n; my /= n; mz /= n;
  let sxx = 0, sxz = 0, szz = 0, sxy = 0, szy = 0;
  for (const p of points) {
    const dx = p.x - mx, dz = p.z - mz, dy = p.y - my;
    sxx += dx * dx; sxz += dx * dz; szz += dz * dz; sxy += dx * dy; szy += dz * dy;
  }
  const det = sxx * szz - sxz * sxz;
  if (n < 3 || Math.abs(det) < 1e-12) return { y: my, roll: 0, pitch: 0, slopeX: 0, slopeZ: 0 };
  const b = (sxy * szz - szy * sxz) / det, c = (szy * sxx - sxy * sxz) / det;
  return { y: my - b * mx - c * mz, roll: Math.atan(b), pitch: -Math.atan(c), slopeX: b, slopeZ: c };
}

/** A damped hit kick (closed form, t in seconds since the hit; 0 before it). */
export function impulse(t: number, amp: number, tau = 0.4, freq = 1.8): number {
  return t < 0 ? 0 : amp * Math.exp(-t / tau) * Math.sin(TAU * freq * t);
}

/** Second-order spring (hydraulic overshoot). dt-based, sub-stepped at 240 Hz with the target ramped across the frame
 *  (a first-order hold), so a page at 30 fps and one at 144 fps converge on the same motion. */
export class Spring2 {
  x = 0;
  v = 0;
  private prev: number | null = null;
  constructor(x = 0) { this.x = x; }
  /** omega = stiffness (rad/s), zeta = damping ratio (< 1 overshoots). */
  step(target: number, omega: number, zeta: number, dt: number): number {
    if (!(dt > 0)) return this.x;
    const t0 = this.prev ?? target;
    this.prev = target;
    const n = Math.min(64, Math.max(1, Math.ceil(dt * 240)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const tg = t0 + (target - t0) * ((i + 1) / n);
      const a = omega * omega * (tg - this.x) - 2 * zeta * omega * this.v;
      this.v += a * h;
      this.x += this.v * h;
    }
    return this.x;
  }
  /** Add velocity (a plant thump, a hit). */
  kick(dv: number) { this.v += dv; }
  reset(x = 0) { this.x = x; this.v = 0; this.prev = null; }
}

// ------------------------------------------------------------------------------------------------ vectors
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a); return l > 1e-12 ? mul(a, 1 / l) : [0, 0, 0]; };
/** Rotate v about the unit axis k by angle a (Rodrigues). */
export function rotateAxis(v: V3, k: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a), kv = cross(k, v), kd = dot(k, v);
  return [v[0] * c + kv[0] * s + k[0] * kd * (1 - c), v[1] * c + kv[1] * s + k[1] * kd * (1 - c), v[2] * c + kv[2] * s + k[2] * kd * (1 - c)];
}
/** Signed angle from a to b about the unit axis n. */
export function signedAngle(a: V3, b: V3, n: V3): number { return Math.atan2(dot(cross(a, b), n), dot(a, b)); }

// ------------------------------------------------------------------------------------------------ planar leg IK
/** A leg at rest, in one consistent body frame. `coxa` absent = no yaw joint (the leg plane is fixed). */
export interface LegRest {
  coxa?: V3;
  /** Yaw axis (the body's up), unit. */
  up: V3;
  hip: V3;
  knee: V3;
  ankle: V3;
  /** The sole / tip point that touches the ground. */
  contact: V3;
}
export interface LegSolution {
  yaw: number;
  hip: V3; knee: V3; ankle: V3; contact: V3;
  axis: V3;
  hipAngle: number; kneeAngle: number; ankleAngle: number;
  reach: number;
  clamped: boolean;
}

/**
 * Planar spider / hexapod leg: coxa yaw so the leg plane contains the target, two-bone IK for femur + tibia (the knee
 * keeps its rest side) and a foot that keeps its rest attitude turned by the yaw. The plane is the one through the rest
 * hip / knee / ankle; exact for any coxa offset. solveHingeLeg (below) refines this onto the real hinge axes.
 */
export function solveLeg(rest: LegRest, target: V3, opts: { ankle?: V3; plane?: V3 } = {}): LegSolution {
  const up = norm(rest.up);
  const footOff = sub(rest.ankle, rest.contact);
  let n0 = opts.plane ? norm(opts.plane) : cross(sub(rest.knee, rest.hip), sub(rest.ankle, rest.knee));
  if (len(n0) < 1e-9) n0 = cross(up, sub(rest.ankle, rest.hip));
  if (len(n0) < 1e-9) n0 = [1, 0, 0];
  n0 = norm(n0);
  let yawMiss = false;
  const yawFor = (A: V3): number => {
    if (!rest.coxa) return 0;
    const c = rest.coxa;
    const e1 = norm(Math.abs(up[0]) < 0.9 ? cross(up, [1, 0, 0]) : cross(up, [0, 0, 1])), e2 = cross(up, e1);
    const ang = (v: V3) => Math.atan2(dot(v, e2), dot(v, e1));
    const hz = (v: V3): V3 => sub(v, mul(up, dot(v, up)));
    const nh = hz(n0), m = len(nh);
    if (m < 1e-6) return 0;
    const d = dot(sub(rest.hip, c), n0);
    const t = sub(A, c), th = hz(t), r = len(th);
    const t0 = sub(rest.ankle, c), r0 = len(hz(t0));
    if (r < 1e-6 || r0 < 1e-6) return 0;
    const dp = d - dot(n0, up) * dot(t, up), dp0 = d - dot(n0, up) * dot(t0, up);
    const s = Math.sign(Math.atan2(Math.sin(ang(hz(t0)) - ang(nh)), Math.cos(ang(hz(t0)) - ang(nh)))) || 1;
    const a0 = ang(hz(t0)) - ang(nh) - s * Math.acos(clamp(dp0 / (m * r0), -1, 1));
    if (Math.abs(dp / (m * r)) > 1) yawMiss = true;
    const a1 = ang(th) - ang(nh) - s * Math.acos(clamp(dp / (m * r), -1, 1));
    return Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0));
  };
  let A: V3;
  let yaw: number;
  if (opts.ankle) { A = opts.ankle; yaw = yawFor(A); }
  else {
    yaw = yawFor(add(target, footOff));
    A = add(target, rotateAxis(footOff, up, yaw));
    for (let it = 0; it < 24; it++) {
      yawMiss = false;
      const y2 = yawFor(A);
      A = add(target, rotateAxis(footOff, up, y2));
      const done = Math.abs(y2 - yaw) < 1e-13;
      yaw = y2;
      if (done) break;
    }
  }
  const piv = rest.coxa ?? rest.hip;
  const R = (p: V3) => add(piv, rotateAxis(sub(p, piv), up, yaw));
  const H = R(rest.hip), axis = norm(rotateAxis(n0, up, yaw));
  A = sub(A, mul(axis, dot(sub(A, H), axis)));
  const a = len(sub(rest.knee, rest.hip)), b = len(sub(rest.ankle, rest.knee));
  const D = sub(A, H);
  const dRaw = len(D);
  const dir = dRaw > 1e-9 ? mul(D, 1 / dRaw) : norm(sub(R(rest.ankle), H));
  const dMin = Math.abs(a - b) + 1e-6, dMax = (a + b) * (1 - 1e-6);
  const d = clamp(dRaw, dMin, dMax);
  const clamped = dRaw > dMax || dRaw < dMin || yawMiss;
  const restDir = norm(sub(rest.ankle, rest.hip));
  const side = Math.sign(dot(sub(rest.knee, rest.hip), cross(n0, restDir))) || 1;
  const perp = norm(cross(axis, dir));
  const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const knee = add(H, add(mul(dir, a * cosA), mul(perp, side * a * Math.sqrt(1 - cosA * cosA))));
  const ankle = add(H, mul(dir, d));
  const contact = sub(ankle, rotateAxis(footOff, up, yaw));
  const fem0 = rotateAxis(sub(rest.knee, rest.hip), up, yaw), tib0 = rotateAxis(sub(rest.ankle, rest.knee), up, yaw);
  const hipAngle = signedAngle(fem0, sub(knee, H), axis);
  const kneeAngle = signedAngle(rotateAxis(tib0, axis, hipAngle), sub(ankle, knee), axis);
  return { yaw, hip: H, knee, ankle, contact, axis, hipAngle, kneeAngle, ankleAngle: -(hipAngle + kneeAngle), reach: dRaw / (a + b), clamped };
}

// ------------------------------------------------------------------------------------------------ hinge-constrained IK
/** One joint of a hinge leg: pivot + unit axis in the body frame AT REST; angle limits in radians relative to rest. */
export interface HingeJoint { type: 'yaw' | 'hinge'; pivot: V3; axis: V3; min?: number; max?: number }
/** SPEC HingeLegModel: [yaw coxa?, hip hinge, knee hinge, (ankle hinge)] + the rest sole point. */
export interface HingeLegModel { joints: HingeJoint[]; contact: V3 }

/** Per-model rest data as flat arrays (pivots, unit axes), cached: legFK runs a few dozen times a frame per leg. */
const fkRest = new WeakMap<HingeLegModel, { P: Float64Array; A: Float64Array; up: V3 }>();
function restOf(leg: HingeLegModel) {
  let r = fkRest.get(leg);
  if (!r) {
    const n = leg.joints.length, P = new Float64Array(n * 3), A = new Float64Array(n * 3);
    leg.joints.forEach((j, i) => { const a = norm(j.axis); P.set(j.pivot, i * 3); A.set(a, i * 3); });
    r = { P, A, up: leg.joints[0]?.type === 'yaw' ? norm(leg.joints[0].axis) : [0, 1, 0] };
    fkRest.set(leg, r);
  }
  return r;
}

/** Forward kinematics: each joint turns everything distal to it about its CURRENT axis through its CURRENT pivot.
 *  (Flat-array Rodrigues: no per-step allocation; the model's arrays are cached.) */
export function legFK(leg: HingeLegModel, angles: readonly number[]): { pivots: V3[]; axes: V3[]; contact: V3; soleUp: V3 } {
  const n = leg.joints.length, rest = restOf(leg);
  const P = Float64Array.from(rest.P), A = Float64Array.from(rest.A);
  let cx = leg.contact[0], cy = leg.contact[1], cz = leg.contact[2];
  let ux = rest.up[0], uy = rest.up[1], uz = rest.up[2];
  for (let i = 0; i < n; i++) {
    const th = angles[i] ?? 0;
    if (!th) continue;
    const kx = A[i * 3], ky = A[i * 3 + 1], kz = A[i * 3 + 2], c = Math.cos(th), s = Math.sin(th), t = 1 - c;
    const r00 = c + t * kx * kx, r01 = t * kx * ky - s * kz, r02 = t * kx * kz + s * ky;
    const r10 = t * kx * ky + s * kz, r11 = c + t * ky * ky, r12 = t * ky * kz - s * kx;
    const r20 = t * kx * kz - s * ky, r21 = t * ky * kz + s * kx, r22 = c + t * kz * kz;
    const px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2];
    for (let j = i + 1; j < n; j++) {
      const o = j * 3, x = P[o] - px, y = P[o + 1] - py, z = P[o + 2] - pz;
      P[o] = px + r00 * x + r01 * y + r02 * z; P[o + 1] = py + r10 * x + r11 * y + r12 * z; P[o + 2] = pz + r20 * x + r21 * y + r22 * z;
      const ax = A[o], ay = A[o + 1], az = A[o + 2];
      A[o] = r00 * ax + r01 * ay + r02 * az; A[o + 1] = r10 * ax + r11 * ay + r12 * az; A[o + 2] = r20 * ax + r21 * ay + r22 * az;
    }
    const x = cx - px, y = cy - py, z = cz - pz;
    cx = px + r00 * x + r01 * y + r02 * z; cy = py + r10 * x + r11 * y + r12 * z; cz = pz + r20 * x + r21 * y + r22 * z;
    const vx = ux, vy = uy, vz = uz;
    ux = r00 * vx + r01 * vy + r02 * vz; uy = r10 * vx + r11 * vy + r12 * vz; uz = r20 * vx + r21 * vy + r22 * vz;
  }
  const pivots: V3[] = [], axes: V3[] = [];
  for (let i = 0; i < n; i++) { pivots.push([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]); axes.push([A[i * 3], A[i * 3 + 1], A[i * 3 + 2]]); }
  return { pivots, axes, contact: [cx, cy, cz], soleUp: [ux, uy, uz] };
}

/**
 * SPEC: hinge-constrained leg IK. The coxa only yaws, every other joint only turns about ITS OWN axis (hubs stay
 * concentric), all clamped to their limits. Solve: the planar answer (solveLeg) as the start, then Newton on (yaw, hip,
 * knee) against the real axes until the ankle sits on its target (< 1e-7), then the ankle hinge levels the sole (sole-up
 * = the yaw axis, or `normal`). `angles` are relative to rest (radians), one per joint. reach = |hip → ankle| / (femur +
 * tibia); clamped = a limit or the reach stopped it (the caller forces an early step).
 */
export function solveHingeLeg(leg: HingeLegModel, footTarget: V3, opts: { level?: boolean; normal?: V3; guess?: readonly number[] } = {}): { angles: number[]; reach: number; clamped: boolean; contact: V3; error: number } {
  const J = leg.joints;
  const yawI = J[0]?.type === 'yaw' ? 0 : -1;
  const hips = J.map((j, i) => (j.type === 'hinge' ? i : -1)).filter((i) => i >= 0);
  const [hi, ki, fi] = [hips[0], hips[1], hips[2] ?? -1];
  const angles = J.map(() => 0);
  if (hi === undefined || ki === undefined) return { angles, reach: 0, clamped: true, contact: [...leg.contact], error: Infinity };
  const up = yawI >= 0 ? norm(J[yawI].axis) : ([0, 1, 0] as V3);
  const ankle0 = fi >= 0 ? J[fi].pivot : leg.contact;
  const footOff = sub(ankle0, leg.contact);
  const n = opts.normal ? norm(opts.normal) : up;
  // the ankle target for a yaw: the sole's rest offset turned by the yaw (and tilted onto the ground normal)
  const tilt = (v: V3): V3 => { const c = cross(up, n), s = len(c); return s > 1e-9 ? rotateAxis(v, mul(c, 1 / s), Math.atan2(s, dot(up, n))) : v; };
  const ankleTarget = (yaw: number): V3 => add(footTarget, tilt(yawI >= 0 ? rotateAxis(footOff, up, yaw) : footOff));
  // 1. start: the caller's last answer (a warm start: one or two Newton steps per frame), else the planar solution
  if (opts.guess && opts.guess.length === J.length && opts.guess.every((x) => Number.isFinite(x))) opts.guess.forEach((x, i) => { angles[i] = x; });
  else {
    const planar = solveLeg({ ...(yawI >= 0 ? { coxa: J[yawI].pivot } : {}), up, hip: J[hi].pivot, knee: J[ki].pivot, ankle: ankle0, contact: leg.contact }, footTarget, { plane: J[hi].axis });
    if (yawI >= 0) angles[yawI] = planar.yaw;
    const sgn = (i: number) => Math.sign(dot(norm(J[i].axis), planar.axis)) || 1;
    angles[hi] = planar.hipAngle * sgn(hi);
    angles[ki] = planar.kneeAngle * sgn(ki);
  }
  // 2. Newton on the real axes (yaw, hip, knee) → the ankle point, then the ankle hinge levels the sole; the sole's
  //    real offset under the ankle after levelling feeds the next round (non-parallel hinges: the levelled foot can end
  //    turned a little about the up axis), until the sole sits on the target
  const free = [yawI, hi, ki].filter((i) => i >= 0);
  const level = fi >= 0 && opts.level !== false;
  // (with a warm start the sole's offset under the ankle is the one the previous answer had: usually exact already)
  // one FK pass at the current angles is kept and reused: the Newton step, the levelling and the final report share it
  let cur = legFK(leg, angles);
  let off: V3 = opts.guess && level ? sub(cur.pivots[fi], cur.contact) : sub(ankleTarget(yawI >= 0 ? angles[yawI] : 0), footTarget);
  const scale = len(sub(J[ki].pivot, J[hi].pivot)) + len(sub(ankle0, J[ki].pivot));
  let lastOuter = Infinity;
  for (let outer = 0; outer < 6; outer++) {
    const T = add(footTarget, off);
    let prevErr = Infinity;
    for (let it = 0; it < 10; it++) {
      const base = fi >= 0 ? cur.pivots[fi] : cur.contact;
      const r = sub(base, T);
      const e = len(r);
      if (e < 1e-7 * scale || (it > 2 && e > 0.8 * prevErr)) break;   // converged (sub-micron), or stalled (out of reach)
      prevErr = e;
      // revolute Jacobian: d(point)/d(theta_i) = axis_i x (point - pivot_i), all from the one FK pass
      const cols: V3[] = free.map((i) => cross(cur.axes[i], sub(base, cur.pivots[i])));
      const m = free.length;
      const A: number[][] = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, j) => dot(cols[i], cols[j]) + (i === j ? 1e-9 * scale * scale : 0)));
      const x = solveSmall(A, cols.map((c) => -dot(c, r)));
      if (!x) break;
      const big = Math.max(...x.map(Math.abs));
      const k = big > 0.5 ? 0.5 / big : 1;                            // at most half a radian a step
      free.forEach((i, j) => { angles[i] += x[j] * k; });
      cur = legFK(leg, angles);
    }
    if (!level) break;
    // 3. the sole: level (or onto the normal) about the ankle's own axis (analytic on the kept FK pass)
    const k = cur.axes[fi], piv = cur.pivots[fi], th0 = angles[fi];
    const proj = (v: V3) => norm(sub(v, mul(k, dot(v, k))));
    const th = signedAngle(proj(rotateAxis(cur.soleUp, k, -th0)), proj(tilt(up)), k);
    angles[fi] = th;
    const contact = add(piv, rotateAxis(sub(cur.contact, piv), k, th - th0));
    cur = { ...cur, contact, soleUp: rotateAxis(cur.soleUp, k, th - th0) };
    const err = len(sub(contact, footTarget));
    if (err < 1e-6 * scale || err > 0.8 * lastOuter) break;
    lastOuter = err;
    off = sub(piv, contact);
  }
  // 4. limits
  let clamped = false;
  J.forEach((j, i) => {
    const lo = j.min ?? -Math.PI, hi2 = j.max ?? Math.PI;
    const c = clamp(angles[i], lo, hi2);
    if (c !== angles[i]) { clamped = true; angles[i] = c; }
  });
  const fk = clamped ? legFK(leg, angles) : cur;
  const A2 = fi >= 0 ? fk.pivots[fi] : fk.contact;
  const femur = len(sub(J[ki].pivot, J[hi].pivot)), tibia = len(sub(ankle0, J[ki].pivot));
  const reach = len(sub(A2, fk.pivots[hi])) / Math.max(1e-9, femur + tibia);
  const error = len(sub(fk.contact, footTarget));
  if (error > 1e-4 * (femur + tibia) || reach > 1 - 1e-6) clamped = true;
  // (out of reach: report how far the target is, so the caller steps early)
  const want = len(sub(add(footTarget, off), fk.pivots[hi])) / Math.max(1e-9, femur + tibia);
  return { angles, reach: Math.max(reach, error > 1e-4 * (femur + tibia) ? want : 0), clamped, contact: fk.contact, error };
}

/** Gaussian elimination for a small dense system (null when singular). */
function solveSmall(A: number[][], b: number[]): number[] | null {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}
