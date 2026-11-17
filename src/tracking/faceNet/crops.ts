// "My face model" stage 1: aligned grayscale crops + landmark geometry features for the personal image-input expression
// network (docs/FACE_MODEL.md). Pure TS on the cpuFace pixel sampler (imageOps.warpToTensor), no canvas, runs in a worker
// or Node.
//
// Per frame: both eyes (32x24, brows included above each eye) and the mouth (48x32), similarity-aligned from fixed
// MediaPipe landmark ids and contrast-normalised per crop (mean 0, std 1, clamped), plus a ~40-number geometry vector per
// region (distances in the region's own frame, scaled by the inter-ocular distance) for the feature MLP half of the net.
//
//  - EYES: one canonical frame for both. u runs inner corner -> outer corner, v runs down the eye. The person's LEFT eye
//    (263 outer / 362 inner) is the canonical orientation; the RIGHT eye (33 / 133) gets the mirrored frame (its v axis
//    flips), so the same crop net serves both eyes and the right eye's crop is the image flipped left-right.
//  - MOUTH: centred on the mouth corners + inner lip mids, rotated by the EYE LINE (head roll), not by the mouth corners
//    (a one-sided smile would otherwise rotate itself out of the crop), scaled by the inter-ocular distance (so pucker /
//    stretch still change the mouth's width in the crop).
import { warpToTensor, type Affine, type Planes } from '../cpuFace/imageOps.ts';

export const EYE_W = 32, EYE_H = 24, MOUTH_W = 48, MOUTH_H = 32;
/** Eye crop window: this many eye widths across, 3/4 of that tall, centred this far (eye widths) above the eye's centre so the
 *  brow sits in the top third. */
export const EYE_SPAN = 2.0, EYE_RISE = 0.25;
/** Mouth crop window width in inter-ocular distances (height = 2/3 of it). */
export const MOUTH_SPAN = 1.0;
/** Pixel std floor (0..1 grey) so a flat crop (black frame, covered lens) comes out as zeros, not amplified noise. */
export const STD_FLOOR = 0.02, CROP_CLAMP = 3;
/** A crop whose window lies less than this fraction inside the frame (readable pixels) makes extractCrops refuse the frame: the
 *  missing part would be a smeared edge-replicate that looks like an expression. */
export const MIN_COVER = 0.9;

export interface LM { x: number; y: number; z?: number }

type Side = { outer: number; inner: number; up: number[]; lo: number[]; browUp: number[]; browLo: number[]; iris: number; sign: 1 | -1 };
/** MediaPipe 478-landmark ids, person's anatomical sides (left eye = 263 / 362, on the image's right in an un-mirrored frame). */
export const EYE_SIDES: { left: Side; right: Side } = {
  left: { outer: 263, inner: 362, up: [466, 388, 387, 386, 385, 384, 398], lo: [249, 390, 373, 374, 380, 381, 382], browUp: [300, 293, 334, 296, 336], browLo: [276, 283, 282, 295, 285], iris: 473, sign: 1 },
  right: { outer: 33, inner: 133, up: [246, 161, 160, 159, 158, 157, 173], lo: [7, 163, 144, 145, 153, 154, 155], browUp: [70, 63, 105, 66, 107], browLo: [46, 53, 52, 65, 55], iris: 468, sign: -1 },
};
export const MOUTH_LM = { cornerR: 61, cornerL: 291, upperIn: 13, lowerIn: 14, upperOut: 0, lowerOut: 17, chin: 152, nose: 2, cheekR: 205, cheekL: 425, faceR: 234, faceL: 454, innerR: 78, innerL: 308 };
// The five middle points of each lip ring, person's right to left (MediaPipe's lip landmark ids run corner 61 -> corner 291 along
// each ring: outer upper 39 37 0 267 269, outer lower 181 84 17 314 405, inner upper 81 82 13 312 311, inner lower 178 87 14 317 402).
// The inner rings are paired index-for-index (lip gap = lower - upper), so their order matters; the outer rings are just features.
const LIP_OUT_UP = [39, 37, 0, 267, 269], LIP_OUT_LO = [181, 84, 17, 314, 405], LIP_IN_UP = [81, 82, 13, 312, 311], LIP_IN_LO = [178, 87, 14, 317, 402];

export const NF_EYE = 41, NF_MOUTH = 42;

export interface FaceCrops {
  eyeL: Float32Array; eyeR: Float32Array; mouth: Float32Array;
  fEyeL: Float32Array; fEyeR: Float32Array; fMouth: Float32Array;
}
export function newFaceCrops(): FaceCrops {
  return { eyeL: new Float32Array(EYE_W * EYE_H), eyeR: new Float32Array(EYE_W * EYE_H), mouth: new Float32Array(MOUTH_W * MOUTH_H),
    fEyeL: new Float32Array(NF_EYE), fEyeR: new Float32Array(NF_EYE), fMouth: new Float32Array(NF_MOUTH) };
}

/** dst pixel (u, v) of a W x H crop -> source pixel: the crop spans spanX along axis A and spanY along axis B around (cx, cy). */
export function cropAffine(cx: number, cy: number, ax: number, ay: number, bx: number, by: number, spanX: number, spanY: number, W: number, H: number): Affine {
  const kx = spanX * (0.5 / W - 0.5), ky = spanY * (0.5 / H - 0.5);
  return [ax * spanX / W, bx * spanY / H, cx + ax * kx + bx * ky, ay * spanX / W, by * spanY / H, cy + ay * kx + by * ky];
}

/** Fraction of a W x H crop's pixel centres (a 16 x 12 grid) whose source point lies inside the readable pixels of `p`. NaN maps to 0. */
export function cropCoverage(p: Pick<Planes, 'x0' | 'y0' | 'w' | 'h'>, M: Affine, W: number, H: number): number {
  const gx = 16, gy = 12, x0 = p.x0 - 0.5, x1 = p.x0 + p.w - 0.5, y0 = p.y0 - 0.5, y1 = p.y0 + p.h - 0.5;
  let inside = 0;
  for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) {
    const u = (i + 0.5) * W / gx - 0.5, v = (j + 0.5) * H / gy - 0.5, sx = M[0] * u + M[1] * v + M[2], sy = M[3] * u + M[4] * v + M[5];
    if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) inside++;
  }
  return inside / (gx * gy);
}

/** Pixels on demand: the face worker reads only the three crop windows' boxes out of its bitmap instead of the whole thing. */
export interface PlaneReader {
  frameW: number; frameH: number;
  /** a copy of the frame's pixels in [x0, x1) x [y0, y1) (integers inside the frame) as Planes (format RGBA, x0 / y0 / w / h = that box) */
  read(x0: number, y0: number, x1: number, y1: number): Planes;
}
/** The frame-pixel box a crop window touches (its corners through `M`, a bilinear tap of margin), clamped to the frame. */
export function cropBox(M: Affine, W: number, H: number, frameW: number, frameH: number): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [u, v] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]]) {
    const x = M[0] * u + M[1] * v + M[2], y = M[3] * u + M[4] * v + M[5];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const a = Math.max(0, Math.floor(x0) - 2), b = Math.max(0, Math.floor(y0) - 2), c = Math.min(frameW, Math.ceil(x1) + 3), d = Math.min(frameH, Math.ceil(y1) + 3);
  return [a, b, Math.max(a + 2, c), Math.max(b + 2, d)];
}

let tmp = new Float32Array(MOUTH_W * MOUTH_H * 3);
/** Sample a grey crop through `M` (replicate border), then normalise to mean 0 / std 1 (std floored, clamped to +-3). */
export function sampleGrey(p: Planes, M: Affine, W: number, H: number, out: Float32Array) {
  const n = W * H;
  if (tmp.length < n * 3) tmp = new Float32Array(n * 3);
  warpToTensor(p, M, W, H, tmp, 1 / 255, 0, 'replicate', false);
  let s = 0;
  for (let i = 0; i < n; i++) { const g = 0.299 * tmp[i * 3] + 0.587 * tmp[i * 3 + 1] + 0.114 * tmp[i * 3 + 2]; out[i] = g; s += g; }
  const m = s / n;
  let v = 0;
  for (let i = 0; i < n; i++) { const d = out[i] - m; v += d * d; }
  const k = 1 / Math.max(STD_FLOOR, Math.sqrt(v / n));
  for (let i = 0; i < n; i++) { const q = (out[i] - m) * k; out[i] = q > CROP_CLAMP ? CROP_CLAMP : q < -CROP_CLAMP ? -CROP_CLAMP : q; }
}

/** Landmarks in frame pixels (x, y; z in x-pixels, as MediaPipe scales it), read through one object so the feature code stays short. */
class Pts {
  constructor(private lm: ArrayLike<LM>, readonly fw: number, readonly fh: number) {}
  x(i: number) { return this.lm[i].x * this.fw; }
  y(i: number) { return this.lm[i].y * this.fh; }
  z(i: number) { return (this.lm[i].z ?? 0) * this.fw; }
}
/** A landmark frame: origin, unit axes, length unit. u = (p - o) . a / unit, v = (p - o) . b / unit. */
interface Frame { ox: number; oy: number; ax: number; ay: number; bx: number; by: number; unit: number }
const fu = (f: Frame, P: Pts, i: number) => ((P.x(i) - f.ox) * f.ax + (P.y(i) - f.oy) * f.ay) / f.unit;
const fv = (f: Frame, P: Pts, i: number) => ((P.x(i) - f.ox) * f.bx + (P.y(i) - f.oy) * f.by) / f.unit;

function eyeFeatures(P: Pts, s: Side, fr: Frame, ew: number, out: Float32Array) {
  let k = 0;
  const upV: number[] = [], loV: number[] = [], bUpV: number[] = [];
  for (let i = 1; i <= 5; i++) upV.push(fv(fr, P, s.up[i]));
  for (let i = 1; i <= 5; i++) loV.push(fv(fr, P, s.lo[i]));
  for (const v of upV) out[k++] = v;
  for (const v of loV) out[k++] = v;
  let gapSum = 0, gapMin = 1e9;
  for (let i = 0; i < 5; i++) { const g = loV[i] - upV[i]; out[k++] = g; gapSum += g; if (g < gapMin) gapMin = g; }
  let bu = 0, ul = 0;
  for (let i = 0; i < 5; i++) { const v = fv(fr, P, s.browUp[i]); bUpV.push(v); out[k++] = v; bu += v; ul += upV[i]; }
  for (let i = 0; i < 5; i++) out[k++] = fu(fr, P, s.browUp[i]);
  for (let i = 0; i < 5; i++) out[k++] = fv(fr, P, s.browLo[i]);
  for (let i = 0; i < 5; i++) out[k++] = bUpV[i] - upV[i];
  const w = ew / fr.unit;
  out[k++] = w; out[k++] = gapSum / 5 / w; out[k++] = gapMin / w; out[k++] = (bu - ul) / 5;
  out[k++] = fu(fr, P, s.iris) / w; out[k++] = fv(fr, P, s.iris) / w;
}

function mouthFeatures(P: Pts, fr: Frame, out: Float32Array) {
  const M = MOUTH_LM;
  let k = 0;
  for (const i of [M.cornerR, M.cornerL]) { out[k++] = fu(fr, P, i); out[k++] = fv(fr, P, i); }
  for (const ring of [LIP_OUT_UP, LIP_OUT_LO, LIP_IN_UP, LIP_IN_LO]) for (const i of ring) out[k++] = fv(fr, P, i);
  for (let i = 0; i < 5; i++) out[k++] = fv(fr, P, LIP_IN_LO[i]) - fv(fr, P, LIP_IN_UP[i]);
  out[k++] = Math.hypot(P.x(M.innerL) - P.x(M.innerR), P.y(M.innerL) - P.y(M.innerR)) / fr.unit;
  out[k++] = Math.hypot(P.x(M.cornerL) - P.x(M.cornerR), P.y(M.cornerL) - P.y(M.cornerR)) / fr.unit;
  out[k++] = fu(fr, P, M.chin); out[k++] = fv(fr, P, M.chin);
  for (const i of [M.cheekR, M.cheekL]) { out[k++] = fu(fr, P, i); out[k++] = fv(fr, P, i); }
  out[k++] = Math.hypot(P.x(M.faceL) - P.x(M.faceR), P.y(M.faceL) - P.y(M.faceR)) / fr.unit;
  out[k++] = fv(fr, P, M.nose);
  const zc = (P.z(M.cornerR) + P.z(M.cornerL)) / 2;
  for (const i of [M.upperIn, M.upperOut, M.lowerOut]) out[k++] = (P.z(i) - zc) / fr.unit;
}

const USED_IDS = (() => {
  const ids = new Set<number>();
  for (const e of [EYE_SIDES.left, EYE_SIDES.right]) for (const i of [e.outer, e.inner, e.iris, ...e.up, ...e.lo, ...e.browUp, ...e.browLo]) ids.add(i);
  for (const i of Object.values(MOUTH_LM)) ids.add(i);
  for (const r of [LIP_OUT_UP, LIP_OUT_LO, LIP_IN_UP, LIP_IN_LO]) for (const i of r) ids.add(i);
  return [...ids];
})();

/**
 * Fill `out` from one frame: `lm` = the 478 normalised landmarks (x, y in 0..1 of the frame, z in x units), `planes` = the
 * frame's pixels (cpuFace Planes; any format). Returns false, with `out` untouched, when the frame cannot give trustworthy
 * crops: fewer than 478 landmarks, a non-finite coordinate in any landmark the crops or features read, a face under ~8 px
 * wide, or an eye / mouth crop window less than `minCover` (MIN_COVER) inside the frame (a face half out of shot); the caller
 * then skips the frame.
 */
export function extractCrops(lm: ArrayLike<LM>, src: Planes | PlaneReader, out: FaceCrops, minCover = MIN_COVER): boolean {
  if (lm.length < 478) return false;
  for (const i of USED_IDS) if (!(Number.isFinite(lm[i].x) && Number.isFinite(lm[i].y))) return false;
  const reader = 'read' in src ? src : null;
  // what is readable: the whole frame through a reader, else the copied region of the planes
  const planes = reader ? { frameW: reader.frameW, frameH: reader.frameH, x0: 0, y0: 0, w: reader.frameW, h: reader.frameH } : src as Planes;
  const P = new Pts(lm, planes.frameW, planes.frameH);
  const R = EYE_SIDES.right, L = EYE_SIDES.left, Mo = MOUTH_LM;
  const iod = Math.hypot(P.x(L.outer) - P.x(R.outer), P.y(L.outer) - P.y(R.outer));
  if (!(iod > 8)) return false;
  // head-roll axes from the eye line (right outer corner -> left outer corner), b = a rotated 90 degrees = "down the face"
  const hax = (P.x(L.outer) - P.x(R.outer)) / iod, hay = (P.y(L.outer) - P.y(R.outer)) / iod;
  // plan all three crops first (windows + frames), check they sit inside the frame, only then sample: `out` stays untouched on false
  const eyePlan = (s: Side) => {
    const ox = (P.x(s.outer) + P.x(s.inner)) / 2, oy = (P.y(s.outer) + P.y(s.inner)) / 2;
    const ew = Math.hypot(P.x(s.outer) - P.x(s.inner), P.y(s.outer) - P.y(s.inner));
    if (!(ew > 1)) return null;
    const ax = (P.x(s.outer) - P.x(s.inner)) / ew, ay = (P.y(s.outer) - P.y(s.inner)) / ew;
    const bx = -s.sign * ay, by = s.sign * ax; // sign -1 (right eye) mirrors the frame so v still points down the face
    const fr: Frame = { ox, oy, ax, ay, bx, by, unit: iod };
    // the crop centre sits EYE_RISE eye widths up from the eye centre (b points down)
    const M = cropAffine(ox - bx * EYE_RISE * ew, oy - by * EYE_RISE * ew, ax, ay, bx, by, EYE_SPAN * ew, EYE_SPAN * ew * EYE_H / EYE_W, EYE_W, EYE_H);
    return { s, fr, ew, M };
  };
  const pL = eyePlan(L), pR = eyePlan(R);
  if (!pL || !pR) return false;
  const cx = ((P.x(Mo.cornerR) + P.x(Mo.cornerL)) / 2 + (P.x(Mo.upperIn) + P.x(Mo.lowerIn)) / 2) / 2;
  const cy = ((P.y(Mo.cornerR) + P.y(Mo.cornerL)) / 2 + (P.y(Mo.upperIn) + P.y(Mo.lowerIn)) / 2) / 2;
  const bx = -hay, by = hax, sx = MOUTH_SPAN * iod;
  const Mm = cropAffine(cx, cy, hax, hay, bx, by, sx, sx * MOUTH_H / MOUTH_W, MOUTH_W, MOUTH_H);
  if (cropCoverage(planes, pL.M, EYE_W, EYE_H) < minCover || cropCoverage(planes, pR.M, EYE_W, EYE_H) < minCover || cropCoverage(planes, Mm, MOUTH_W, MOUTH_H) < minCover) return false;
  const px = (M: Affine, W: number, H: number): Planes => { if (!reader) return src as Planes; const [a, b, c, d] = cropBox(M, W, H, planes.frameW, planes.frameH); return reader.read(a, b, c, d); };
  sampleGrey(px(pL.M, EYE_W, EYE_H), pL.M, EYE_W, EYE_H, out.eyeL); eyeFeatures(P, pL.s, pL.fr, pL.ew, out.fEyeL);
  sampleGrey(px(pR.M, EYE_W, EYE_H), pR.M, EYE_W, EYE_H, out.eyeR); eyeFeatures(P, pR.s, pR.fr, pR.ew, out.fEyeR);
  sampleGrey(px(Mm, MOUTH_W, MOUTH_H), Mm, MOUTH_W, MOUTH_H, out.mouth);
  mouthFeatures(P, { ox: (P.x(R.outer) + P.x(L.outer)) / 2, oy: (P.y(R.outer) + P.y(L.outer)) / 2, ax: hax, ay: hay, bx, by, unit: iod }, out.fMouth);
  return true;
}
