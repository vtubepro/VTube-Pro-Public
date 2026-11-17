// Eye layout (profile.eyes.layout): which of the avatar's eyes are shown — for characters with an eye patch, a lost
// eye or a single cyclops eye. Pure (no three.js): shared by the profile sanitizer, the runtime and the Face tab.
//   'both'   (default / unset) — the normal two eyes
//   'left'   — only the character's own left eye; the right one is hidden
//   'right'  — only the character's own right eye; the left one is hidden
//   'center' — one eye on the face midline (generated eyes only): placed at the midpoint of the two eye markers,
//              projected onto the surface, `centerScale` × the eye size
// How the unused eye is hidden:
//   - generated eyes (bulb / inset / painted / anime / LED / puppet): it simply isn't drawn
//   - the model's own eyes (VRM / eye bones / eye meshes): its lids are held shut (blink shape), its eye bone is scaled
//     away behind the lid and separate per-side eye meshes are hidden — see src/avatar/eyePatch.ts
//   - eyes painted into the face texture: the optional eye patch (`patch`) covers them (or `replaceBaked`,
//     shared/bakedEyes.ts, erases them and draws tracked eyes)
// Optional eye patch (profile.eyes.patch): a generated leather patch + strap over the hidden eye, any avatar.

export type EyeLayout = 'both' | 'left' | 'right' | 'center';
export const EYE_LAYOUTS: readonly EyeLayout[] = ['both', 'left', 'right', 'center'];

export interface EyePatchConfig {
  /** Show the patch over the hidden eye ('left' / 'right' layouts only). */
  enabled: boolean;
  /** Patch colour (sRGB hex, default near-black leather). */
  color: string;
  /** Strap around the head (default on). */
  strap: boolean;
  /** Patch size multiplier (1 = covers the eye socket). */
  size?: number;
}

export const PATCH_DEFAULTS: EyePatchConfig = { enabled: false, color: '#1c1a1d', strap: true, size: 1 };
export const CENTER_SCALE_DEFAULT = 1.4;
export const CENTER_SCALE_RANGE: [number, number] = [0.5, 3];
export const PATCH_SIZE_RANGE: [number, number] = [0.6, 1.8];

const HEX = /^#[0-9a-f]{6}$/i;

/** A valid layout or undefined (drop the field: undefined = 'both'). */
export function sanitizeEyeLayout(v: unknown): EyeLayout | undefined {
  return typeof v === 'string' && (EYE_LAYOUTS as readonly string[]).includes(v) && v !== 'both' ? v as EyeLayout : undefined;
}

export function sanitizeCenterScale(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.round(Math.max(CENTER_SCALE_RANGE[0], Math.min(CENTER_SCALE_RANGE[1], v)) * 1000) / 1000;
}

export function sanitizeEyePatch(v: unknown): EyePatchConfig | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Partial<EyePatchConfig>;
  const size = typeof o.size === 'number' && Number.isFinite(o.size) ? Math.round(Math.max(PATCH_SIZE_RANGE[0], Math.min(PATCH_SIZE_RANGE[1], o.size)) * 1000) / 1000 : 1;
  return {
    enabled: o.enabled === true,
    color: typeof o.color === 'string' && HEX.test(o.color) ? o.color.toLowerCase() : PATCH_DEFAULTS.color,
    strap: o.strap !== false,
    size,
  };
}

/** Sanitise profile.eyes in place: layout / centerScale / patch are clean values, or the field is dropped. */
export function sanitizeEyeLayoutFields(e: { layout?: unknown; centerScale?: unknown; patch?: unknown }) {
  if ('layout' in e) { const v = sanitizeEyeLayout(e.layout); if (v === undefined) delete e.layout; else e.layout = v; }
  if ('centerScale' in e) { const v = sanitizeCenterScale(e.centerScale); if (v === undefined) delete e.centerScale; else e.centerScale = v; }
  if ('patch' in e) { const v = sanitizeEyePatch(e.patch); if (v === undefined) delete e.patch; else e.patch = v; }
}

/** The layout in effect for this eye source: 'center' needs generated eyes (model eyes can't move) → 'both'. */
export function effectiveLayout(layout: unknown, mode: string): EyeLayout {
  const l = sanitizeEyeLayout(layout) ?? 'both';
  if (mode === 'none') return 'both';
  if (l === 'center' && mode !== 'procedural') return 'both';
  return l;
}

/** Which side is hidden (the character's own side), or null. */
export function hiddenSide(layout: EyeLayout): 'left' | 'right' | null {
  return layout === 'left' ? 'right' : layout === 'right' ? 'left' : null;
}

/** Does a patch get drawn for this eye setup? */
export function patchWanted(eyes: { mode: string; layout?: unknown; patch?: EyePatchConfig | null }): boolean {
  return !!eyes.patch?.enabled && hiddenSide(effectiveLayout(eyes.layout, eyes.mode === 'none' ? 'model' : eyes.mode)) !== null;
}

/** Centre eye marker from the two eye markers (model space): midpoint + averaged normal (the runtime then projects it
 *  onto the surface). null without both markers. */
export function centerMarker(l: { position: number[]; normal: number[] } | null, r: { position: number[]; normal: number[] } | null):
  { position: [number, number, number]; normal: [number, number, number] } | null {
  if (!l || !r) return l ? { position: [l.position[0], l.position[1], l.position[2]], normal: [l.normal[0], l.normal[1], l.normal[2]] }
    : r ? { position: [r.position[0], r.position[1], r.position[2]], normal: [r.normal[0], r.normal[1], r.normal[2]] } : null;
  const p: [number, number, number] = [0, 1, 2].map((i) => (l.position[i] + r.position[i]) / 2) as [number, number, number];
  let n = [0, 1, 2].map((i) => l.normal[i] + r.normal[i]);
  const len = Math.hypot(n[0], n[1], n[2]);
  n = len > 1e-6 ? n.map((x) => x / len) : [0, 0, 1];
  return { position: p, normal: n as [number, number, number] };
}
