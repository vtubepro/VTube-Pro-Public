// Comet fans (the finale picture of a hard-dance endshow: a sunburst of comets from the roofline, roof fans, crossing
// lattices, curtains) drawn from ONE particle slot each: an event carries the whole fan and the slot's particles are
// shared out among its comets (a head + a short ember trail each), so a 30-comet sunburst costs 3 of the spark system's
// 32 slots and no new uniforms (src/scene/festival/pyro.ts SPARK_MOTION modes 10-12; stageRig.ts places them).
// The pure part: the styles' defaults, how many slots a fan takes on a tier, the event encoding the shader decodes and a
// CPU mirror of the shader's geometry for the unit (tools/festival_fans_unit.ts). KEEP IN STEP with the GLSL.
import { hexRgb } from './festival.ts';

export type FanStyle = 'fan' | 'vfan' | 'sunburst' | 'semicircle' | 'lattice' | 'curtain';
export const FAN_STYLES: readonly FanStyle[] = ['fan', 'vfan', 'sunburst', 'semicircle', 'lattice', 'curtain'];
export const isFanStyle = (s: string | undefined): s is FanStyle => !!s && (FAN_STYLES as readonly string[]).includes(s);

/** how a style fires: comets, angle (deg; rows: width in m, 0 = the group's span), lean (deg, + toward +x), a row
 *  (parallel comets from a line) or a radial fan (from a point; V = two wings), where it fires from, launch stagger (s),
 *  its own colours (head, tail) */
export interface FanSpec { count: number; spread: number; tilt: number; shape: 'radial' | 'row' | 'vee'; from: 'centre' | 'each' | 'halves' | 'span'; stagger: number; color?: string; color2?: string }
export const FAN_DEFAULTS: Record<FanStyle, FanSpec> = {
  // roof fans: every unit of the group fires a fan of 5-10 comets over 30-60 deg (the outer ones lean out)
  fan: { count: 7, spread: 45, tilt: 0, shape: 'radial', from: 'each', stagger: 0.04 },
  // V-fans: two wings of comets, +-30 deg, a gap up the middle
  vfan: { count: 7, spread: 60, tilt: 0, shape: 'vee', from: 'each', stagger: 0.03 },
  // the sunburst: 25-30 comets over ~180 deg from one point behind the centre piece
  sunburst: { count: 28, spread: 170, tilt: 0, shape: 'radial', from: 'centre', stagger: 0.06 },
  // a semicircle of red-star comets with gold tails
  semicircle: { count: 18, spread: 180, tilt: 0, shape: 'radial', from: 'centre', stagger: 0.03, color: '#ff2a1a', color2: '#ffb040' },
  // crossing lattice: the left half fires a row leaning right, the right half a row leaning left - a diamond net
  lattice: { count: 8, spread: 0, tilt: 45, shape: 'row', from: 'halves', stagger: 0.02 },
  // a curtain: comets straight up from a line across the group (2 slots on High: ~24 comets)
  curtain: { count: 24, spread: 0, tilt: 0, shape: 'row', from: 'span', stagger: 0.04, color: '#fff4dc', color2: '#ffcf7a' },
};

/** particles per comet the fans aim for (a head + 6 embers) and the most slots one fan may take */
export const FAN_PARTICLES = 7, FAN_MAX_SLOTS = 4;
/** comets one slot carries with `per` particles, and the slots + comets a fan of `n` comets takes */
export function fanSlots(n: number, per: number): { slots: number; count: number; perSlot: number } {
  const perSlot = Math.max(1, Math.floor(per / FAN_PARTICLES));
  const slots = Math.max(1, Math.min(FAN_MAX_SLOTS, Math.ceil(Math.max(1, n) / perSlot)));
  return { slots, count: Math.max(1, Math.min(Math.round(n), slots * perSlot)), perSlot };
}

/** shader mode: 10 radial, 11 row, 12 V (+0.5: the event's own head / tail colours) */
export const fanMode = (shape: FanSpec['shape'], own: boolean) => (shape === 'row' ? 11 : shape === 'vee' ? 12 : 10) + (own ? 0.5 : 0);
/** the slot's `dur` uniform: the spread (radial: deg; row: width in 0.25 m) * 4096 + comets * 64 + this slot * 8 + slots - 1
 *  (all integers < 2^24: exact in a 32-bit float) */
export function packFan(spreadQ: number, n: number, slot: number, slots: number): number {
  return Math.round(Math.max(0, Math.min(1023, spreadQ))) * 4096 + Math.max(1, Math.min(63, Math.round(n))) * 64 + Math.max(0, Math.min(7, slot)) * 8 + (Math.max(1, Math.min(8, slots)) - 1);
}
export function unpackFan(w: number): { spreadQ: number; n: number; slot: number; slots: number } {
  let a = w;
  const slots = (a % 8) + 1; a = Math.floor(a / 8);
  const slot = a % 8; a = Math.floor(a / 8);
  const n = a % 64; const spreadQ = Math.floor(a / 64);
  return { spreadQ, n, slot, slots };
}
/** the comets a slot draws: their indexes in the fan (interleaved: slot s of S draws s, s + S, s + 2S …) */
export function slotComets(n: number, slot: number, slots: number): number[] {
  const out: number[] = [];
  for (let j = slot; j < n; j += slots) out.push(j);
  return out;
}

/** CPU mirror of the shader: the launch direction (room frame, unit) of comet j of n. Radial: rotated by u * spread
 *  about the fan's normal (the aim x the room's +Z, else +X); V: the two wings from a quarter to a half of the spread;
 *  row: the aim itself (the origin moves along the room's +X instead: `rowOffset`). */
export function fanDir(shape: FanSpec['shape'], aim: readonly number[], spreadDeg: number, j: number, n: number, out: number[]): number[] {
  const u = n > 1 ? j / (n - 1) - 0.5 : 0;
  const len = Math.hypot(aim[0], aim[1], aim[2]) || 1, ax = aim[0] / len, ay = aim[1] / len, az = aim[2] / len;
  if (shape === 'row') { out[0] = ax; out[1] = ay; out[2] = az; return out; }
  // side = normalize(cross(aim, +Z)) (+X when the aim is along Z)
  let sx = ay * 1 - az * 0, sy = az * 0 - ax * 1, sz = 0;
  const sl = Math.hypot(sx, sy, sz);
  if (sl < 1e-3) { sx = 1; sy = 0; sz = 0; } else { sx /= sl; sy /= sl; sz /= sl; }
  // (the side points to -x for an upward aim: flip so u > 0 = toward +x)
  if (sx < 0) { sx = -sx; sy = -sy; sz = -sz; }
  const half = spreadDeg * Math.PI / 180;
  const a = shape === 'vee' ? Math.sign(u || 1) * (half / 2) * (0.5 + Math.abs(u)) : u * half;
  out[0] = ax * Math.cos(a) + sx * Math.sin(a); out[1] = ay * Math.cos(a) + sy * Math.sin(a); out[2] = az * Math.cos(a) + sz * Math.sin(a);
  return out;
}
/** a row's comet j of n: its offset along the room's +X (m) for a row `width` m wide */
export const rowOffset = (width: number, j: number, n: number) => (n > 1 ? j / (n - 1) - 0.5 : 0) * width;
/** the aim of a fan leaning `tiltDeg` (+ toward +x) from straight up */
export function tiltAim(tiltDeg: number, out: number[]): number[] { const t = tiltDeg * Math.PI / 180; out[0] = Math.sin(t); out[1] = Math.cos(t); out[2] = 0; return out; }
/** the speed scale (the shader's uScale for the sparks) that puts a vertical fan comet's apex at ~1.15 x the stage height
 *  above its origin (0.8-1.5 x with the power), x the root of the room's effect scale */
export const FAN_APEX = 1.15;
export function fanScale(stageH: number, fxScale = 1): number {
  const v = Math.sqrt(2 * 9.8 * FAN_APEX * Math.max(4, stageH));
  return (v / 28) * Math.sqrt(Math.max(0.25, fxScale));
}
/** a comet's launch speed (m/s): the old comet's 24 + 4 x power, x the scale */
export const fanSpeed = (power: number, scale: number) => (24 + 4 * power) * scale;
/** the apex of a comet launched at `v` m/s at `deg` from vertical (m above its origin) */
export const fanApex = (v: number, deg: number) => { const vy = v * Math.cos(deg * Math.PI / 180); return (vy * vy) / (2 * 9.8); };
/** a style's colours as sRGB (null = the show's palette) */
export const fanColors = (s: FanSpec): [number, number, number][] | null => (s.color ? [hexRgb(s.color), hexRgb(s.color2 ?? s.color)] : null);
