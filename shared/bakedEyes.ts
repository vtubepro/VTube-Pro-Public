// Replace the model's painted eyes (profile.eyes.replaceBaked): for models whose eyes are painted into the face
// texture (Tripo / Meshy / hand-painted GLBs) or are static eye meshes / decals. The runtime erases the painted
// eye from a COPY of the texture (never the file: src/avatar/bakedEyes.ts), hides separate eye meshes, holds the
// model's own eye shapes still, and draws the generated eyes (anime / painted / bulb / inset) on top, so they
// track gaze, blink, squint and smile. The eyelid that closes over them is the skin around the eye (auto) or
// `lidColor`. Pure (no three.js): shared by the profile sanitizer, the runtime and the Face tab.

export interface BakedEyesConfig {
  /** Replace the painted eyes with tracked generated ones. */
  on: boolean;
  /** Size of the erased area vs the eye size (1 = the painted eye matches the generated eye's size). */
  cover: number;
  /** Move the erased area, in eye sizes: [outward (toward the outer corner), up]. Mirrored for the right eye. */
  nudge?: [number, number];
}

export const BAKED_DEFAULTS: BakedEyesConfig = { on: false, cover: 1, nudge: [0, 0] };
export const BAKED_COVER_RANGE: [number, number] = [0.4, 3];
export const BAKED_NUDGE_RANGE: [number, number] = [-1.5, 1.5];

/** Erase ellipse half-axes, in eye sizes, at cover 1: wide (the painted almond + lash wing), a bit less tall. */
export const BAKED_ELLIPSE: [number, number] = [1.6, 1.15];

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.max(lo, Math.min(hi, v)) * 1000) / 1000 : d);

/** A clean config, or undefined (drop the field: off). */
export function sanitizeBakedEyes(v: unknown): BakedEyesConfig | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Partial<BakedEyesConfig>;
  const n = Array.isArray(o.nudge) ? o.nudge : [0, 0];
  return {
    on: o.on === true,
    cover: num(o.cover, BAKED_COVER_RANGE[0], BAKED_COVER_RANGE[1], 1),
    nudge: [num(n[0], BAKED_NUDGE_RANGE[0], BAKED_NUDGE_RANGE[1], 0), num(n[1], BAKED_NUDGE_RANGE[0], BAKED_NUDGE_RANGE[1], 0)],
  };
}

/** Is the replacement active for this eye setup? (generated eyes only: the toggle switches the source to them) */
export function bakedWanted(eyes: { mode: string; replaceBaked?: BakedEyesConfig | null }): boolean {
  return !!eyes.replaceBaked?.on && eyes.mode === 'procedural';
}

/**
 * The erase ellipse of one eye in its eye frame (world units): centre (cx, cy) along (T = avatar-left, B = up)
 * and half-axes (rx, ry). `outward` = +1 when the eye's outer corner lies toward +T (the character's left eye),
 * −1 for the right eye, 0 for a centre eye.
 */
export function eraseEllipse(size: number, cfg: BakedEyesConfig, outward: number): { cx: number; cy: number; rx: number; ry: number } {
  const [nx, ny] = cfg.nudge ?? [0, 0];
  return { cx: nx * size * outward, cy: ny * size, rx: BAKED_ELLIPSE[0] * size * cfg.cover, ry: BAKED_ELLIPSE[1] * size * cfg.cover };
}
