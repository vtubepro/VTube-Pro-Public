// Eye depth (profile.eyes.depth): moves the eyes in (−) / out (+) along the face normal, in the model's own units
// (metres for a normal model, like eyes.size). Default 0 = where the eyes were placed / modelled.
//  - procedural bulb / inset eyes: the whole eye (ball + lids) slides along the marker normal. Limited so the eyeball
//    never sinks into the head past its lids (blinks stay visible) and never floats off it (it stays well attached).
//  - model eyes with eye bones (VRM / VRoid, humanoid GLBs with leftEye / rightEye): the eye bones slide along the
//    character's forward axis. Limited by the eye spacing, far tighter outward than inward, so irises can't poke
//    through the lids / lashes.
//  - painted eyes (decal / anime / LED) sit ON the surface: depth does not apply.
// Pure (no three.js): shared by the profile sanitizer, the runtime and the Face tab.

/** Sanitiser hard limit (model units): nothing sane is further than this. */
export const EYE_DEPTH_LIMIT = 0.25;

/** A clean depth number or undefined (drop the field). */
export function sanitizeEyeDepth(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  const x = Math.max(-EYE_DEPTH_LIMIT, Math.min(EYE_DEPTH_LIMIT, v));
  return Math.round(x * 1e5) / 1e5;
}

/** Bulb / inset eyes: allowed depth range for this size + protrusion (same model units as size).
 *  The eye centre sits at size·(2p − 1) along the normal; with depth it must stay within [−0.7, +0.75]·size. */
export function bulbDepthRange(size: number, protrusion: number, style: string): [number, number] {
  const s = Math.max(1e-5, Math.abs(size) || 0);
  const p = style === 'inset' ? Math.min(protrusion, 0.3) : protrusion;
  const t0 = s * (2 * (Number.isFinite(p) ? p : 0.5) - 1);
  return [round5(-0.7 * s - t0), round5(0.75 * s - t0)];
}

/** Model eye bones: range from the distance between the eyes (ipd, model units). */
export function modelDepthRange(ipd: number): [number, number] {
  const d = Number.isFinite(ipd) && ipd > 1e-4 ? ipd : 0.062;
  return [round5(-0.14 * d), round5(0.012 * d)];
}

export function clampEyeDepth(d: number | undefined, range: [number, number] | null): number {
  const v = typeof d === 'number' && Number.isFinite(d) ? d : 0;
  if (!range) return 0;
  return Math.max(range[0], Math.min(range[1], v));
}

/** Does depth apply to this eye setup? */
export function eyeDepthKind(mode: string, style: string): 'bulb' | 'bones' | 'painted' | 'none' {
  if (mode === 'model') return 'bones';
  if (mode !== 'procedural') return 'none';
  return style === 'bulb' || style === 'inset' ? 'bulb' : 'painted';
}

function round5(x: number) { return Math.round(x * 1e5) / 1e5; }
