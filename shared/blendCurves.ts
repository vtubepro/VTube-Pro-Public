// Per-blendshape range + response curve for the 52 ARKit channels (lane #190). One saved set per avatar
// (profile.tracking.blendCurves), applied to the tracked frame ONCE, right before it reaches the avatar, so VRM / GLB avatars
// (src/avatar/expressions.ts) and rigged 2D / Pro2D avatars (shared/rig2d/drive.ts) both see the same shaped values.
//
//   input range [inLo, inHi]   what the tracker reads for "nothing" and for "all the way" on THIS face (a face that never
//                              opens the jaw past 0.4 sets inHi = 0.4 and the avatar still opens fully)
//   curve (gamma)              < 1 = the channel rises early (lazy brows get lively), > 1 = it rises late (a twitchy
//                              channel stays calm until you mean it); 1 = straight
//   output range [outLo, outHi] how far the avatar's channel may move (cap a shape that clips the mesh at 0.7; swap the two
//                              to invert; raise outLo to keep a little of it always on)
//
// IDENTITY IS TODAY'S BEHAVIOUR EXACTLY: a channel at its defaults is never stored, and a frame with no curves comes back as the
// very same object (no copy, no float round trip). Pure: tools/blend_curves_unit.ts.
import type { TrackingFrame } from './types.ts';

export interface BlendCurve { inLo: number; inHi: number; outLo: number; outHi: number; gamma: number }
export type BlendCurves = Record<string, Partial<BlendCurve>>;

export const BLEND_CURVE_DEFAULT: Readonly<BlendCurve> = { inLo: 0, inHi: 1, outLo: 0, outHi: 1, gamma: 1 };
export const GAMMA_MIN = 0.25, GAMMA_MAX = 4;
/** The input range may not collapse: it would divide by (almost) zero. */
export const MIN_IN_SPAN = 0.05;

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const cl = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export const isIdentityCurve = (c: Partial<BlendCurve> | undefined): boolean =>
  !c || ((c.inLo ?? 0) === 0 && (c.inHi ?? 1) === 1 && (c.outLo ?? 0) === 0 && (c.outHi ?? 1) === 1 && (c.gamma ?? 1) === 1);

/** A full curve from a (possibly partial / junk) one: finite numbers, inputs in 0..1 with a minimum span, gamma in range. */
export function fullCurve(c: Partial<BlendCurve> | undefined): BlendCurve {
  const d = BLEND_CURVE_DEFAULT;
  let inLo = fin(c?.inLo) ? cl(c!.inLo!, 0, 1 - MIN_IN_SPAN) : d.inLo;
  let inHi = fin(c?.inHi) ? cl(c!.inHi!, MIN_IN_SPAN, 1) : d.inHi;
  if (inHi - inLo < MIN_IN_SPAN) { if (inLo + MIN_IN_SPAN <= 1) inHi = inLo + MIN_IN_SPAN; else { inHi = 1; inLo = 1 - MIN_IN_SPAN; } }
  return {
    inLo, inHi,
    outLo: fin(c?.outLo) ? cl(c!.outLo!, 0, 1) : d.outLo,
    outHi: fin(c?.outHi) ? cl(c!.outHi!, 0, 1) : d.outHi,
    gamma: fin(c?.gamma) ? cl(c!.gamma!, GAMMA_MIN, GAMMA_MAX) : d.gamma,
  };
}

/** One value through one curve (an identity curve returns the value untouched). */
export function curveValue(c: Partial<BlendCurve> | undefined, v: number): number {
  if (isIdentityCurve(c)) return v;
  const f = fullCurve(c);
  let t = cl((v - f.inLo) / (f.inHi - f.inLo), 0, 1);
  if (f.gamma !== 1) t = Math.pow(t, f.gamma);
  return f.outLo + t * (f.outHi - f.outLo);
}

/** Clean a saved set (profile JSON, a guest's profile): known channel names (no `_internal` keys) with sane numbers; identity
 *  entries are dropped. Undefined = nothing to apply. */
export function sanitizeBlendCurves(v: unknown, channels: readonly string[]): BlendCurves | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: BlendCurves = {};
  let n = 0;
  for (const name of channels) {
    const raw = (v as Record<string, unknown>)[name];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const f = fullCurve(raw as Partial<BlendCurve>);
    const keep: Partial<BlendCurve> = {};
    for (const k of ['inLo', 'inHi', 'outLo', 'outHi', 'gamma'] as const) if (f[k] !== BLEND_CURVE_DEFAULT[k]) keep[k] = +f[k].toFixed(4);
    if (!Object.keys(keep).length) continue;
    out[name] = keep; n++;
  }
  return n ? out : undefined;
}

/** The TrackingFrame.mouth fields that are summaries of ARKit channels, and which channels (rig2dDrive and the 3D mouth read
 *  both: shaping only `face` would leave a 2D avatar's mouth unchanged). */
const MOUTH_OF: Record<string, readonly string[]> = {
  open: ['jawOpen'], wide: ['mouthStretchLeft', 'mouthStretchRight'], smile: ['mouthSmileLeft', 'mouthSmileRight'],
  frown: ['mouthFrownLeft', 'mouthFrownRight'], pucker: ['mouthPucker'], funnel: ['mouthFunnel'], tongue: ['tongueOut'],
};

/**
 * The frame the avatar should see. No curves → the SAME frame object. Otherwise a copy with the shaped `face` channels and the
 * `mouth` summaries that stand for them (a summary of a left / right pair takes the mean of its two shaped channels).
 */
export function applyBlendCurves(frame: TrackingFrame, curves: BlendCurves | undefined): TrackingFrame {
  if (!curves) return frame;
  let face: Record<string, number> | null = null;
  const active: string[] = [];
  for (const name in curves) {
    const c = curves[name];
    if (isIdentityCurve(c)) continue;
    const v = frame.face?.[name];
    if (v === undefined) continue;
    if (!face) face = { ...frame.face };
    face[name] = curveValue(c, v);
    active.push(name);
  }
  if (!face) return frame;
  let mouth = frame.mouth;
  if (mouth) {
    let m: typeof mouth | null = null;
    for (const field in MOUTH_OF) {
      const chans = MOUTH_OF[field];
      if (!chans.some((k) => active.includes(k))) continue;
      const cur = (mouth as unknown as Record<string, number | undefined>)[field];
      if (typeof cur !== 'number') continue;
      // the summary stands for its channels: shape it with their curves (the mean for a pair)
      let sum = 0;
      for (const k of chans) sum += curveValue(curves[k], cur);
      if (!m) m = { ...mouth };
      (m as unknown as Record<string, number>)[field] = sum / chans.length;
    }
    if (m) mouth = m;
  }
  return { ...frame, face, mouth };
}
