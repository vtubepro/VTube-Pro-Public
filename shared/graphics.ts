// Scene graphics quality (src/stage/gfx/*): Performance / Balanced / High / Ultra, plus Auto. Host-owned like the rest of
// the scene state (SceneState.gfx, saved in cache/scene.json → this PC's OBS pages follow), but PER PC: a party guest's
// studio replaces it with its own local choice before relaying the host's room to its OBS (the host's GPU isn't theirs).
//
// Balanced = exactly today's look and cost (the page's own render tier, no post). High / Ultra add the post pipeline
// (MSAA HDR target → AO, bloom, DOF, haze / shafts, glossy-floor reflections, LUT grade) and the richer toon shading /
// NPC detail. Every effect has a per-level default and can be forced on / off under "Advanced" (only honoured on
// High / Ultra — Performance and Balanced are fixed presets). The studio preview has its own level (keep it cheap).

import { sanitizeAvatarDetail, type AvatarDetailChoice } from './avatarDetail.ts';

export type GfxLevel = 'performance' | 'balanced' | 'high' | 'ultra';
export type GfxChoice = GfxLevel | 'auto';

export const GFX_LEVELS: GfxLevel[] = ['performance', 'balanced', 'high', 'ultra'];
export const GFX_CHOICES: GfxChoice[] = ['auto', 'performance', 'balanced', 'high', 'ultra'];

/** Individually toggleable effects (Advanced). */
export type GfxEffect = 'toon' | 'ao' | 'bloom' | 'dof' | 'haze' | 'shafts' | 'fxaa' | 'grade' | 'shadow' | 'water' | 'reflect' | 'npc' | 'smaa' | 'n8ao' | 'hdri';
export const GFX_EFFECTS: GfxEffect[] = ['toon', 'npc', 'bloom', 'grade', 'ao', 'n8ao', 'hdri', 'shadow', 'dof', 'haze', 'shafts', 'reflect', 'water', 'smaa', 'fxaa'];

export const GFX_EFFECT_LABELS: Record<GfxEffect, [string, string]> = {
  toon: ['Toon rim + highlights', 'Cel rim light and stepped specular highlights on performers and NPCs (tinted shadow ramps on NPCs)'],
  npc: ['Detailed NPCs', 'High-detail LOD0 soldiers up close: 2K cel textures, fingers, coloured ink lines, swinging straps / slings, planted feet'],
  bloom: ['Bloom on lights', 'Neon, holograms, lanterns, muzzle flashes and the light show glow'],
  grade: ['Room colour grade', 'A colour-grading LUT per room (its own mood), plus a soft vignette'],
  ao: ['Ambient occlusion', 'Soft contact shadows in corners and under furniture (half resolution; never on faces)'],
  shadow: ['Performer shadows', 'High: soft contact shadow under each performer · Ultra: a real soft shadow map (performers only)'],
  dof: ['Background blur (talk shots)', 'Subtle depth of field behind the performer in close shots — performers stay crisp'],
  haze: ['Glowing haze', 'Lights bleed softly into the room air (depth-based haze lit by the bloom)'],
  shafts: ['Light shafts', 'Volumetric-looking god rays from the brightest fixtures (quarter resolution)'],
  reflect: ['Glossy floor reflections', 'Screen-space reflections on glossy floors (rooms that ask for it, e.g. Labs)'],
  water: ['Water + sky shaders', 'Animated water (waves, fresnel, glints) and livelier skies (drifting clouds, twinkling stars)'],
  fxaa: ['Extra FXAA', 'A final FXAA pass on top of MSAA (smooths shimmering highlights; slightly softer). Ignored while SMAA is on'],
  smaa: ['SMAA edges', 'Morphological anti-aliasing (pmndrs/postprocessing SMAA) on top of MSAA: crisper hair, outlines and thin props than FXAA. Transparency-safe'],
  n8ao: ['N8AO (better AO)', 'Uses N8AO for the ambient occlusion: smoother, more stable contact shadows (half resolution on High). Needs "Ambient occlusion" on'],
  hdri: ['HDRI room light', 'Image-based light + reflections on room props from a per-room HDRI sky / interior (Poly Haven, CC0). Performers keep the studio light'],
};

/** Default effects per level (Performance / Balanced ignore overrides). */
export const GFX_DEFAULTS: Record<GfxLevel, Record<GfxEffect, boolean>> = {
  performance: { toon: false, ao: false, bloom: false, dof: false, haze: false, shafts: false, fxaa: false, grade: false, shadow: false, water: false, reflect: false, npc: false, smaa: false, n8ao: false, hdri: false },
  balanced: { toon: false, ao: false, bloom: false, dof: false, haze: false, shafts: false, fxaa: false, grade: false, shadow: false, water: false, reflect: false, npc: false, smaa: false, n8ao: false, hdri: false },
  high: { toon: true, ao: true, bloom: true, dof: true, haze: true, shafts: false, fxaa: false, grade: true, shadow: true, water: true, reflect: false, npc: true, smaa: true, n8ao: true, hdri: true },
  ultra: { toon: true, ao: true, bloom: true, dof: true, haze: true, shafts: true, fxaa: false, grade: true, shadow: true, water: true, reflect: true, npc: true, smaa: true, n8ao: true, hdri: true },
};

export const GFX_LABELS: Record<GfxChoice, string> = {
  auto: 'Auto — picks by GPU headroom, backs off if tracking slows',
  performance: 'Low — no post effects, lighter NPCs / props, never supersampled (GTX 1060 / RX 580 class and up)',
  balanced: 'Medium — the standard look, no post effects (default; GTX 1080 / RTX 3060 / RX 6600 class)',
  high: 'High — post effects, rim light, detailed NPCs (RTX 3060 Ti / RX 6700 XT class and up at 1080p)',
  ultra: 'Ultra — everything, supersampled (heavy! RTX 4070 Ti / RX 7900 class and up)',
};

/** Player-facing preset names (docs/PERFORMANCE.md). The ids stay 'performance' / 'balanced' for saved scenes + ?gfx= URLs. */
export const GFX_NAMES: Record<GfxChoice, string> = { auto: 'Auto', performance: 'Low', balanced: 'Medium', high: 'High', ultra: 'Ultra' };

/** ?gfx= / tools: also accepts the preset names low / medium. */
export function parseGfxChoice(v: unknown): GfxChoice | null {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  if (s === 'low') return 'performance';
  if (s === 'medium') return 'balanced';
  return isGfxChoice(s) ? s : null;
}

/** Render scale per page (fraction of the preset's resolution, 0.5–1). */
export const GFX_SCALES = [1, 0.9, 0.8, 0.75, 0.67, 0.5];
/** Target frame rates for "Lower quality automatically". */
export const GFX_TARGET_FPS = [30, 48, 60];

/** First-run / Settings benchmark result (src/stage/gfx/bench.ts). */
export interface GfxBenchResult {
  at: number;
  /** WebGL renderer string (as the browser reports it). */
  gpu: string;
  /** GPU class guessed from the name (src/stage/gfx/gpuClass.ts). */
  cls: string;
  /** How the pick was made: measured with the GPU timer, or from the GPU name only (no timer query in this browser). */
  how: 'timer' | 'name';
  /** Measured GPU ms / frame (p90) per level tried. */
  ms: Partial<Record<GfxLevel, number>>;
  /** Measured main-thread ms / frame (p95) per level tried (the CPU side of the pick). */
  cpu?: Partial<Record<GfxLevel, number>>;
  pick: GfxLevel;
  room: string | null;
}

export interface SceneGfxState {
  /** OBS output pages (default balanced). */
  obs: GfxChoice;
  /** The studio's Scene-tab preview (default balanced — it shares the GPU with the face tracker). */
  preview: GfxChoice;
  /** Auto may climb to Ultra (default off: Auto tops out at High). */
  autoUltra: boolean;
  /** Advanced: effect → forced on / off (missing = the level's default). High / Ultra only. */
  fx: Partial<Record<GfxEffect, boolean>>;
  /** Render scale of the OBS pages (0.5–1 × the preset's resolution; default 1 = unchanged). */
  obsScale?: number;
  /** Render scale of the studio preview (default 1). */
  previewScale?: number;
  /** MSAA samples of the High / Ultra post target (4 = unchanged default; 2 / 0 are cheaper, SMAA still smooths edges). */
  msaa?: 0 | 2 | 4;
  /** Lower quality automatically when frames drop, the page's CPU runs out of time or face tracking slows (missing = ON;
   *  false = the user turned it off). Steps back up after a minute of headroom, never above the chosen preset. */
  autoLower?: boolean;
  /** Target fps for autoLower (default 60). */
  targetFps?: number;
  /** Last benchmark (first run / Settings → Run benchmark). */
  bench?: GfxBenchResult | null;
  /** Avatar detail (shared/avatarDetail.ts): lighter versions of very detailed avatars, per PC like the rest of gfx.
   *  Missing = DEFAULT_AVATAR_DETAIL. Applies to this PC's own avatar (studio view, OBS pages, Scene-tab preview). */
  avatarDetail?: AvatarDetailChoice;
}

export const DEFAULT_GFX: SceneGfxState = { obs: 'balanced', preview: 'balanced', autoUltra: false, fx: {} };

export const isGfxChoice = (v: unknown): v is GfxChoice => typeof v === 'string' && (GFX_CHOICES as string[]).includes(v);
export const isGfxLevel = (v: unknown): v is GfxLevel => typeof v === 'string' && (GFX_LEVELS as string[]).includes(v);

export function sanitizeGfx(o: unknown): SceneGfxState {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const fx: Partial<Record<GfxEffect, boolean>> = {};
  if (x.fx && typeof x.fx === 'object') for (const [k, v] of Object.entries(x.fx as Record<string, unknown>)) if ((GFX_EFFECTS as string[]).includes(k) && typeof v === 'boolean') fx[k as GfxEffect] = v;
  const out: SceneGfxState = { obs: isGfxChoice(x.obs) ? x.obs : DEFAULT_GFX.obs, preview: isGfxChoice(x.preview) ? x.preview : DEFAULT_GFX.preview, autoUltra: x.autoUltra === true, fx };
  const sc = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0.5, v)) : 1);
  if (x.obsScale !== undefined) out.obsScale = sc(x.obsScale);
  if (x.previewScale !== undefined) out.previewScale = sc(x.previewScale);
  if (x.msaa === 0 || x.msaa === 2 || x.msaa === 4) out.msaa = x.msaa;
  if (typeof x.autoLower === 'boolean') out.autoLower = x.autoLower;   // (missing = on; false = the user turned it off)
  if (typeof x.targetFps === 'number' && Number.isFinite(x.targetFps)) out.targetFps = Math.min(144, Math.max(24, Math.round(x.targetFps)));
  const ad = sanitizeAvatarDetail(x.avatarDetail);
  if (ad) out.avatarDetail = ad;
  const b = x.bench as Record<string, unknown> | null | undefined;
  if (b && typeof b === 'object' && isGfxLevel(b.pick)) {
    const ms: Partial<Record<GfxLevel, number>> = {};
    if (b.ms && typeof b.ms === 'object') for (const [k, v] of Object.entries(b.ms as Record<string, unknown>)) if (isGfxLevel(k) && typeof v === 'number' && Number.isFinite(v)) ms[k] = +v.toFixed(2);
    const cpu: Partial<Record<GfxLevel, number>> = {};
    if (b.cpu && typeof b.cpu === 'object') for (const [k, v] of Object.entries(b.cpu as Record<string, unknown>)) if (isGfxLevel(k) && typeof v === 'number' && Number.isFinite(v)) cpu[k] = +v.toFixed(2);
    out.bench = { at: typeof b.at === 'number' ? b.at : 0, gpu: typeof b.gpu === 'string' ? b.gpu.slice(0, 120) : '', cls: typeof b.cls === 'string' ? b.cls.slice(0, 40) : '',
      how: b.how === 'timer' ? 'timer' : 'name', ms, ...(Object.keys(cpu).length ? { cpu } : {}), pick: b.pick, room: typeof b.room === 'string' ? b.room.slice(0, 64) : null };
  }
  return out;
}

/** The effect set a page renders with: the level's defaults, overrides only on High / Ultra. */
export function gfxEffects(level: GfxLevel, fx: Partial<Record<GfxEffect, boolean>> = {}): Record<GfxEffect, boolean> {
  const d = { ...GFX_DEFAULTS[level] };
  if (level === 'high' || level === 'ultra') for (const [k, v] of Object.entries(fx)) if (typeof v === 'boolean') d[k as GfxEffect] = v;
  return d;
}

/** Studio → this PC's OBS pages (~1 Hz): live face-tracking health, so Auto never takes GPU time the tracker needs. */
export interface TrackingHealth {
  inferMs: number; trackFps: number; tracking: boolean;
  // beta.13.5 (optional: older studios omit them; research/tracking_gpu_rca/RCA.md P0) — where each model runs, the face's
  // results a second and the camera's frames a second, how long the face frame in flight has been running (ms), how
  // starved the face is (0..1, src/tracking/stallLife.ts), stall mode (src/tracking/stallGuard.ts), one round trip
  // through the browser's graphics queue (ms, src/tracking/gpuSyncProbe.ts; -1 = not measured), whether the studio window
  // has the focus, and how often the studio view draws (frames a second).
  faceDelegate?: string; poseDelegate?: string; handsDelegate?: string;
  faceHz?: number; camFps?: number; inflightMs?: number;
  starve?: number; stall?: boolean; gpuSyncMs?: number; focused?: boolean; drawFps?: number;
}
