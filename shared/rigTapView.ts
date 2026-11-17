// The picture the taps are made on, as plain maths (no three.js, so tools/autorig3d_unit.ts checks it): a square
// orthographic view of the model from the front or from the side, and the way back from a spot on the picture to a point
// in the model's own space and to the [u,v,w] form blender/autorig.py reads.
//
//   front  the camera is in front of the model (+Z) looking back; the picture's right is the model's +X (its left hand)
//   side   the camera is at the model's -X side (its right side) looking across; the picture's right is +Z (the way it faces)
//
// A tap is a spot on a flat picture: the third coordinate (how far in or out) comes from the model itself, the middle of
// where a ray through the spot goes in and out of it (the caller passes that depth, or null for the middle of the box).

import type { Vec3 } from './types.ts';

export type TapView = 'front' | 'side';
export interface Box { min: Vec3; max: Vec3 }
/** The square picture: `h0` = the model-space coordinate at the picture's left edge (x for front, z for side), `v0` = y at the top edge, `w` = the square's size in model units. */
export interface ViewFrame { view: TapView; h0: number; v0: number; w: number }

const size = (b: Box): Vec3 => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
const center = (b: Box): Vec3 => [(b.max[0] + b.min[0]) / 2, (b.max[1] + b.min[1]) / 2, (b.max[2] + b.min[2]) / 2];

/** The picture's frame: the model centred, the bigger of its two visible sides filling `1 / (2 * pad)` of the square. */
export function frameFor(view: TapView, box: Box, pad = 0.58): ViewFrame {
  const s = size(box), c = center(box);
  const horiz = view === 'front' ? s[0] : s[2];
  const half = Math.max(horiz, s[1], 1e-6) * pad;
  return { view, h0: (view === 'front' ? c[0] : c[2]) - half, v0: c[1] + half, w: half * 2 };
}

/** A spot on the picture (fractions 0..1 from the top-left) -> a model-space point. `depth` = the coordinate along the view (z front, x side). */
export function pictureToPoint(f: ViewFrame, box: Box, fx: number, fy: number, depth: number | null): Vec3 {
  const c = center(box);
  const h = f.h0 + fx * f.w, y = f.v0 - fy * f.w;
  return f.view === 'front' ? [h, y, depth ?? c[2]] : [depth ?? c[0], y, h];
}

/** The way back: a model-space point -> fractions on the picture (for drawing the marks). */
export function pointToPicture(f: ViewFrame, p: Vec3): [number, number] {
  const h = f.view === 'front' ? p[0] : p[2];
  return [(h - f.h0) / f.w, (f.v0 - p[1]) / f.w];
}

/** Model-space point -> [u,v,w] over the box (what the autorig request carries). */
export function toUvw(box: Box, p: Vec3): Vec3 {
  const s = size(box);
  return [(p[0] - box.min[0]) / (s[0] || 1), (p[1] - box.min[1]) / (s[1] || 1), (p[2] - box.min[2]) / (s[2] || 1)].map((x) => Math.round(x * 1e4) / 1e4) as Vec3;
}

export function fromUvw(box: Box, u: Vec3): Vec3 {
  const s = size(box);
  return [box.min[0] + u[0] * s[0], box.min[1] + u[1] * s[1], box.min[2] + u[2] * s[2]];
}

/** Which way the model's front is on this picture (for the little "front" arrow): +1 = right, -1 = left, 0 = towards you. */
export const facingOnPicture = (view: TapView): -1 | 0 | 1 => (view === 'side' ? 1 : 0);
