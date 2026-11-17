// Pro2D → 3D: the design overrides an AI may send with to3d_rebuild (lane to3d, docs/PRO2D_TO_3D.md). ONE table is the
// single source: the zod schema below, the JSON spec the Python side checks again (blender/to3d/overrides_spec.json,
// written by `npx tsx tools/to3d_unit.ts --write-spec`; the unit test fails when it is stale) and the pack's lever list.
// Every key is one the pipeline really reads (blender/live2d/design.py → face_kit / anime_creator params, faceadj.py,
// hair.py + hair2d.py's frame, assemble.py's spring TUNE, finish.py), with the same clamps the pipeline applies:
//   design.py clips eyeSize 0.85–1.35, faceWidth 0.9–1.1, jaw 0.85–1.3 (by sex), chin −1..1, eyeTilt ±8°, brow height
//   1.2–3.0; faceadj.lid_bake_amount 0–0.4; the rest smile 0–0.55; vroid_face.DEFAULTS for the VFace paint keys.
// `stage` = the earliest pipeline stage a change needs (rebuild scope): full > hair > springs > profile.
// Not here on purpose: garment shapes (garment.py measures them from the drawing and stamps the drawn fronts itself),
// anything that projects pictures, teeth geometry (teeth stay a flat drawn band: only 'flat' | 'shark' drawing).
import { z } from 'zod';

export type OvStage = 'full' | 'hair' | 'springs' | 'profile';
export const STAGE_ORDER: readonly OvStage[] = ['full', 'hair', 'springs', 'profile'];

export interface OvSpec {
  path: string;
  type: 'number' | 'int' | 'hex' | 'enum' | 'bool';
  min?: number; max?: number; values?: readonly string[];
  stage: OvStage;
  /** what it changes, in plain words (the pack's lever table + refusal messages) */
  what: string;
}

/** VTube Pro's own bundled bases (assets/builtin: Mirelle, Kairo) and the performer's own base. */
export const BASE_KEYS = ['mirelle', 'kairo', 'user'] as const;
const SPRING = ['fringe', 'side', 'back', 'ahoge'] as const;
const BODY = ['height', 'head', 'shoulders', 'bust', 'waist', 'hips', 'legs', 'arms', 'neck', 'build'] as const;

export const OVERRIDES: readonly OvSpec[] = [
  { path: 'sex', type: 'enum', values: ['female', 'male'], stage: 'full', what: 'the eye / brow / face style family (re-runs the design)' },
  { path: 'creator.base', type: 'enum', values: BASE_KEYS, stage: 'full', what: 'the body + face base: "mirelle" (female) or "kairo" (male), VTube Pro\'s own bases, or "user" = the performer\'s own base' },
  ...(['hair', 'hairTip', 'eyes', 'brows', 'skin'] as const).map((k): OvSpec => ({ path: `creator.colors.${k}`, type: 'hex', stage: 'full', what: `${k} colour (sRGB hex; converted to linear by the pipeline)` })),
  { path: 'creator.face.eyeSize', type: 'number', min: 0.85, max: 1.35, stage: 'full', what: 'eye size vs the base' },
  { path: 'creator.face.chin', type: 'number', min: -1, max: 1, stage: 'full', what: 'chin length (− shorter, + longer)' },
  { path: 'creator.face.faceWidth', type: 'number', min: 0.9, max: 1.1, stage: 'full', what: 'cheek width' },
  { path: 'creator.face.jaw', type: 'number', min: 0.85, max: 1.3, stage: 'full', what: 'jaw width below the mouth' },
  { path: 'creator.face.eyeTilt', type: 'number', min: -8, max: 8, stage: 'full', what: 'eye corner tilt in degrees vs the base' },
  ...BODY.map((k): OvSpec => ({ path: `creator.body.${k}`, type: 'number', min: 0.85, max: 1.15, stage: 'full', what: `body ${k} scale` })),
  ...(['tops', 'bottoms', 'shoes'] as const).map((k): OvSpec => ({ path: `creator.outfit.${k}.color`, type: 'hex', stage: 'full', what: `${k} colour` })),
  ...(['color', 'top', 'bottom', 'ring', 'pupilColor'] as const).map((k): OvSpec => ({ path: `face.iris.${k}`, type: 'hex', stage: 'full', what: `painted iris ${k}` })),
  { path: 'face.iris.pupil', type: 'number', min: 0.2, max: 0.5, stage: 'full', what: 'pupil size (share of the iris)' },
  { path: 'face.iris.scale', type: 'number', min: 0.8, max: 1.35, stage: 'full', what: 'painted iris size' },
  { path: 'face.iris.scaleY', type: 'number', min: 0.85, max: 1.2, stage: 'full', what: 'painted iris height' },
  { path: 'face.iris.dy', type: 'number', min: -0.3, max: 0.3, stage: 'full', what: 'painted iris up / down' },
  ...(['line', 'line2', 'white', 'whiteShadow'] as const).map((k): OvSpec => ({ path: `face.eye.${k}`, type: 'hex', stage: 'full', what: `eye ${k} colour (dark warm, never pure black)` })),
  { path: 'face.eye.lineMax', type: 'number', min: 0.1, max: 0.35, stage: 'full', what: 'upper lash line thickness' },
  { path: 'face.eye.wing', type: 'number', min: 0, max: 0.45, stage: 'full', what: 'lash wing at the outer corner' },
  { path: 'face.eye.spikes', type: 'int', min: 0, max: 5, stage: 'full', what: 'lash spikes' },
  { path: 'face.hl.sparkles', type: 'int', min: 0, max: 4, stage: 'full', what: 'small highlight sparkles' },
  { path: 'face.brow.color', type: 'hex', stage: 'full', what: 'brow colour' },
  { path: 'face.brow.height', type: 'number', min: 1.2, max: 3.0, stage: 'full', what: 'brow height in eye heights above the eye' },
  { path: 'face.brow.width', type: 'number', min: 0.08, max: 0.3, stage: 'full', what: 'brow thickness' },
  { path: 'face.brow.tilt', type: 'number', min: -0.5, max: 0.5, stage: 'full', what: 'brow tilt' },
  { path: 'face.brow.shape', type: 'enum', values: ['female', 'male'], stage: 'full', what: 'brow shape' },
  { path: 'face.skin.blush', type: 'hex', stage: 'full', what: 'blush colour' },
  { path: 'face.skin.blushAlpha', type: 'number', min: 0, max: 0.6, stage: 'full', what: 'blush strength' },
  { path: 'face.skin.nose', type: 'enum', values: ['tick', 'dot', 'wedge', 'none'], stage: 'full', what: 'drawn nose mark' },
  { path: 'face.skin.mouthLine', type: 'hex', stage: 'full', what: 'closed-mouth line colour' },
  { path: 'face.skin.lowerLash', type: 'number', min: 0, max: 1, stage: 'full', what: 'lower lash strength' },
  { path: 'eyes.lidBake', type: 'number', min: 0, max: 0.4, stage: 'full', what: 'how much the eye opening is narrowed (share of the close morph baked in)' },
  { path: 'eyes.drawnLid', type: 'bool', stage: 'full', what: 'shape the lid on the drawn lid line (true) or narrow uniformly (false)' },
  { path: 'mouth.restSmile', type: 'number', min: 0, max: 0.55, stage: 'full', what: 'resting smile (the carved mouth corners)' },
  { path: 'mouth.teeth', type: 'enum', values: ['flat', 'shark'], stage: 'full', what: 'drawn teeth style (always a flat drawn band)' },
  { path: 'hair.mode', type: 'enum', values: ['auto', 'down', 'ponytail', 'twintails'], stage: 'hair', what: 'hairstyle' },
  { path: 'hair.backLengthScale', type: 'number', min: 0.5, max: 1.6, stage: 'hair', what: 'back hair length (× the drawn distance below the eye line)' },
  { path: 'hair.ink', type: 'number', min: 0.0002, max: 0.0015, stage: 'hair', what: 'hair ink outline width (metres)' },
  { path: 'hair.silfit', type: 'bool', stage: 'hair', what: 'fit the locks to the drawn silhouette (front + turns)' },
  { path: 'hair.seed', type: 'int', min: 0, max: 9999, stage: 'hair', what: 'variation seed for invented back locks' },
  ...SPRING.flatMap((g): OvSpec[] => [
    { path: `springs.${g}.stiffness`, type: 'number', min: 0.2, max: 6, stage: 'springs', what: `${g} hair spring stiffness` },
    { path: `springs.${g}.gravity`, type: 'number', min: 0, max: 0.3, stage: 'springs', what: `${g} hair spring gravity` },
    { path: `springs.${g}.drag`, type: 'number', min: 0.1, max: 1, stage: 'springs', what: `${g} hair spring drag` },
  ]),
  { path: 'look.vrmExposure', type: 'number', min: 0.5, max: 1, stage: 'profile', what: 'how bright the toon colours render in the app' },
];

const BY_PATH = new Map(OVERRIDES.map((o) => [o.path, o]));
const HEX = /^#[0-9a-fA-F]{6}$/;

function leafSchema(o: OvSpec): z.ZodTypeAny {
  switch (o.type) {
    case 'number': return z.number().min(o.min!).max(o.max!);
    case 'int': return z.number().int().min(o.min!).max(o.max!);
    case 'hex': return z.string().regex(HEX, 'a colour like "#a1b2c3"');
    case 'enum': return z.enum(o.values as [string, ...string[]]);
    case 'bool': return z.boolean();
  }
}

/** Flatten {a:{b:1}} → {'a.b': 1}; dotted keys pass through. */
export function flatten(v: unknown, pre = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) flatten(x, pre ? `${pre}.${k}` : k, out);
  } else if (pre) out[pre] = v;
  return out;
}

/** Edit distance (short strings: nearest real key in a refusal). */
function lev(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
export function nearestKey(k: string): string {
  let best = OVERRIDES[0].path, bd = Infinity;
  for (const o of OVERRIDES) { const x = lev(k.toLowerCase(), o.path.toLowerCase()); if (x < bd) { bd = x; best = o.path; } }
  return best;
}

export type OvResult = { ok: true; flat: Record<string, string | number | boolean>; stage: OvStage | null } | { ok: false; errors: string[] };

/** Check an override object (nested or dotted). Unknown keys are refused with the nearest real key. */
export function validateOverrides(raw: unknown): OvResult {
  if (raw === undefined || raw === null) return { ok: true, flat: {}, stage: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['overrides must be an object like {"creator":{"face":{"eyeSize":1.1}}}'] };
  const flat = flatten(raw), errors: string[] = [], out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(flat)) {
    const o = BY_PATH.get(k);
    if (!o) { errors.push(`"${k}" is not a setting the converter reads. Did you mean "${nearestKey(k)}"?`); continue; }
    const r = leafSchema(o).safeParse(v);
    if (!r.success) {
      const range = o.type === 'number' || o.type === 'int' ? ` (${o.min} to ${o.max})` : o.type === 'enum' ? ` (one of ${o.values!.join(', ')})` : o.type === 'hex' ? ' (like "#a1b2c3")' : ' (true or false)';
      errors.push(`"${k}": ${JSON.stringify(v)} is out of range${range}.`);
      continue;
    }
    out[k] = r.data as string | number | boolean;
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, flat: out, stage: stageOf(Object.keys(out)) };
}

/** The earliest stage any of these keys needs (null = none). */
export function stageOf(keys: readonly string[]): OvStage | null {
  let best: number | null = null;
  for (const k of keys) { const o = BY_PATH.get(k); if (!o) continue; const i = STAGE_ORDER.indexOf(o.stage); if (best === null || i < best) best = i; }
  return best === null ? null : STAGE_ORDER[best];
}

/** The rebuild scope between two override sets (what changed). */
export function changedStage(prev: Record<string, unknown>, next: Record<string, unknown>): OvStage | null {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  return stageOf([...keys].filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k])));
}

/** The JSON the Python side re-checks against (blender/to3d/overrides_spec.json). */
export function overridesSpecJson(): string {
  return JSON.stringify({ format: 'vtp.to3d-overrides/1', keys: OVERRIDES.map((o) => ({ path: o.path, type: o.type, min: o.min ?? null, max: o.max ?? null, values: o.values ?? null, stage: o.stage })) }, null, 1) + '\n';
}

/** The zod schema of the MCP input (any of the keys, nested or dotted; checked in detail by validateOverrides). */
export const overridesInput = z.record(z.string(), z.unknown()).describe(
  'Design overrides, nested or dotted, e.g. {"creator":{"face":{"eyeSize":1.12}},"hair":{"mode":"ponytail"}}. Allowed keys: ' +
  OVERRIDES.map((o) => o.path).join(', '));
