// Neck & head motion settings (per avatar, AvatarProfile.neck) — long-necked characters (llamas, giraffes, swans…).
//
// A neck is the bone chain between the torso and the head: the humanoid `neck` bone plus any extra, unmapped bones
// between it and `head` (neck_2, neck_3 … — a llama has 4, a giraffe may have 6). src/avatar/neckRig.ts measures it at
// load and, every frame, spreads the tracked head rotation down that chain instead of the stock 40 % neck / 60 % head
// split, so a long neck bends as a gentle curve and doesn't whip the head around.
//
//   length     neck length multiplier (1 = as modelled). The chain's rest offsets are stretched at load / live;
//              the mesh follows through its skin weights (build long-necked models with smooth weights along the chain).
//   sway       how much of the body's lean / breathing / bounce reaches the neck (1 = all of it, as before; 0 = the neck
//              stands upright on a swaying body, the head stays put in space).
//   tilt       head roll amount (1 = your real tilt; 0.5 = half).
//   stiffness  how the head rotation is spread down the neck: 0 = evenly over every neck joint (a bendy, swan-like
//              curve), 1 = top-heavy (the head turns on an almost still neck — no whip).
//   maxTurn    soft limit on the head's turn / nod (degrees) — keeps a long neck from swinging the head too far.
//   smoothing  extra smoothing of head rotation for long necks (0 = none, 1 = heavy, laggy).
//
// Every field is optional: missing = auto, from how long the neck is compared to the character's height (a human
// neck resolves to "no change" — exactly the old behaviour; longer necks get more stiffness, less sway / tilt, a
// tighter turn limit and some smoothing). Pure data + maths: the studio, the OBS page, the server and the party wire
// all use it.

export interface NeckConfig {
  /** Neck length multiplier, 0.5 … 2.5 (1 = as modelled). */
  length?: number;
  /** Body lean / idle sway passed up the neck, 0 … 1. Missing = auto. */
  sway?: number;
  /** Head roll (tilt) amount, 0 … 1.5. Missing = auto. */
  tilt?: number;
  /** Rotation spread down the neck: 0 = even (bendy) … 1 = top-heavy (still neck). Missing = auto. */
  stiffness?: number;
  /** Soft max head turn / nod, degrees 20 … 120. Missing = auto. */
  maxTurn?: number;
  /** Extra head-rotation smoothing, 0 … 1. Missing = auto. */
  smoothing?: number;
}

export type NeckKey = keyof NeckConfig;
export const NECK_KEYS: readonly NeckKey[] = ['length', 'sway', 'tilt', 'stiffness', 'maxTurn', 'smoothing'];

/** Allowed range of every field. */
export const NECK_LIMITS: Record<NeckKey, [number, number]> = {
  length: [0.5, 2.5], sway: [0, 1], tilt: [0, 1.5], stiffness: [0, 1], maxTurn: [20, 120], smoothing: [0, 1],
};

/** Neck length presets (the Neck section's quick buttons; also the variants the llama was reviewed at). */
export const NECK_PRESETS: readonly [string, number][] = [['Short', 0.6], ['Normal', 1], ['Long', 1.6], ['Extra long', 2.3]];

/** Profile field → a clean config (or undefined = all auto, length 1). Used by the server, the party wire and the UI. */
export function sanitizeNeck(v: unknown): NeckConfig | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const out: NeckConfig = {};
  for (const k of NECK_KEYS) {
    const x = o[k];
    if (typeof x !== 'number' || !Number.isFinite(x)) continue;
    const [lo, hi] = NECK_LIMITS[k];
    const c = Math.min(hi, Math.max(lo, x));
    out[k] = k === 'maxTurn' ? Math.round(c) : Math.round(c * 1000) / 1000;
  }
  if (out.length !== undefined && Math.abs(out.length - 1) < 1e-3) delete out.length;
  return Object.keys(out).length ? out : undefined;
}

/** Fully resolved settings the neck rig runs with. */
export interface NeckResolved {
  length: number;
  sway: number;
  tilt: number;
  stiffness: number;
  maxTurn: number;
  smoothing: number;
  /** 0 = an ordinary human neck … 1 = giraffe (from the neck's share of the character's height). */
  longness: number;
  /** Which fields came from auto (not set in the profile). */
  auto: Partial<Record<NeckKey, boolean>>;
}

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * How long a neck is, 0 (human) … 1 (giraffe), from its rest length (neck base → head, metres, as modelled), the
 * character's height as modelled and the length multiplier. Human necks are ~6 % of the height, a stylised llama's
 * ~18 %, a giraffe's 35 %+.
 */
export function neckLongness(restLength: number, height: number, length = 1): number {
  if (!(restLength > 0) || !(height > 0)) return 0;
  const L = restLength * length;
  const H = Math.max(height + restLength * (length - 1), 1e-3);
  return smooth(0.09, 0.36, L / H);
}

/** Auto value of every motion field for a given longness (the defaults the sliders reset to). */
export function neckAuto(longness: number): Omit<NeckResolved, 'length' | 'longness' | 'auto'> {
  const t = Math.min(1, Math.max(0, longness));
  return {
    sway: Math.round(mix(1, 0.3, t) * 100) / 100,
    tilt: Math.round(mix(1, 0.55, t) * 100) / 100,
    stiffness: Math.round(mix(0.3, 0.85, t) * 100) / 100,
    maxTurn: Math.round(mix(90, 55, t)),
    smoothing: Math.round(mix(0, 0.55, t) * 100) / 100,
  };
}

/** Settings the rig runs with: the profile's values where set, auto (from the measured neck) elsewhere. */
export function resolveNeck(cfg: NeckConfig | undefined, restLength: number, height: number): NeckResolved {
  const c = sanitizeNeck(cfg) ?? {};
  const length = c.length ?? 1;
  const longness = neckLongness(restLength, height, length);
  const a = neckAuto(longness);
  const auto: NeckResolved['auto'] = {};
  const pick = (k: Exclude<NeckKey, 'length'>) => { const v = c[k]; if (v === undefined) { auto[k] = true; return a[k]; } return v; };
  return { length, sway: pick('sway'), tilt: pick('tilt'), stiffness: pick('stiffness'), maxTurn: pick('maxTurn'), smoothing: pick('smoothing'), longness, auto };
}

/**
 * Share of the head's rotation (relative to the neck base) that each joint of a neck chain carries: `n` neck joints
 * (bottom → top) then the head, summing to 1. stiffness 0 = even; 1 = top-heavy (the head takes ~90 %, the rest is
 * biased toward the top of the neck, so the base barely moves).
 */
export function neckWeights(n: number, stiffness: number): number[] {
  const s = Math.min(1, Math.max(0, stiffness));
  const joints = Math.max(1, Math.round(n));
  const head = mix(1 / (joints + 1), 0.9, s);
  const raw = Array.from({ length: joints }, (_, j) => Math.pow((j + 1) / joints, 3 * s));
  const sum = raw.reduce((x, y) => x + y, 0) || 1;
  return [...raw.map((w) => (w / sum) * (1 - head)), head];
}

/** Human label for a longness value (the Neck section's note). */
export function neckLabel(longness: number): string {
  return longness < 0.05 ? 'human-length' : longness < 0.4 ? 'long (llama)' : longness < 0.8 ? 'very long' : 'giraffe-long';
}
