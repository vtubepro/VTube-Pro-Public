// "How much each part moves": the studio's parts (brows, eyes, head …) over the standard tracking sources, and how a
// part's strength reads from / writes into the saved tune (profile.flat.opts.tune, shared/rig2d/drive.ts Rig2DTune).
// Pure (no DOM): the 2D model block (src/ui/rig2dTune.ts) draws it, tools/rig2d_tune_unit.ts tests it.
import { SOURCE_RANGE, SOURCE_REST, TUNE_MAX, sanitizeTune, type Rig2DBinding, type Rig2DStdSource, type Rig2DTune } from './drive.ts';

/** One part as the performer sees it. `down` absent = one strength for both directions (turns and tilts: left and
 *  right are the same amount, and naming them would only confuse with the mirror); `oneWay` = the source only goes
 *  up from rest (a smile squint, a blush). */
export interface TunePart {
  id: string;
  /** the sources it scales (the first two are what the live marker shows) */
  sources: Rig2DStdSource[];
  /** label of the + direction (or of the single strength) */
  up: string;
  /** label of the − direction (absent: one strength for both) */
  down?: string;
  oneWay?: boolean;
  hint: string;
}

/** Brows first (the most common complaint: a frown pulls the brows far too low on some faces / models). */
export const TUNE_PARTS: readonly TunePart[] = [
  { id: 'brows', sources: ['browLY', 'browRY', 'browLForm', 'browRForm'], up: 'Brows up', down: 'Brows down (frown)', hint: 'How far the brows go up when you raise yours, and down when you frown' },
  { id: 'eyes', sources: ['eyeOpenL', 'eyeOpenR'], up: 'Eyes open wide', down: 'Eyes close', hint: 'How wide the eyes open, and how far they close when you blink or squint' },
  { id: 'eyeSmile', sources: ['eyeSmileL', 'eyeSmileR'], up: 'Eye smile', oneWay: true, hint: 'How much the eyes squint when you smile' },
  { id: 'gazeX', sources: ['gazeX'], up: 'Eyes look left / right', hint: 'How far the eyes look to the side' },
  { id: 'gazeY', sources: ['gazeY'], up: 'Eyes look up', down: 'Eyes look down', hint: 'How far the eyes look up and down' },
  { id: 'headYaw', sources: ['headYaw'], up: 'Head turn', hint: 'How far the head turns left and right' },
  { id: 'headPitch', sources: ['headPitch'], up: 'Head nod up', down: 'Head nod down', hint: 'How far the head tips up and down' },
  { id: 'headRoll', sources: ['headRoll'], up: 'Head tilt', hint: 'How far the head tilts to the side' },
  { id: 'body', sources: ['bodyYaw', 'bodyPitch', 'bodyRoll'], up: 'Body sway', hint: 'How much the body follows the head' },
  { id: 'mouthForm', sources: ['mouthForm'], up: 'Mouth smile', down: 'Mouth frown', hint: 'How far the mouth corners go up when you smile, and down when you frown' },
  { id: 'cheek', sources: ['cheek'], up: 'Blush', oneWay: true, hint: 'How much the cheeks blush when you smile' },
];
export const tunePart = (id: string) => TUNE_PARTS.find((p) => p.id === id) ?? null;

/** A part's strength in one direction (1 = as tracked): its first source's saved value. */
export function partStrength(tune: Rig2DTune | undefined, part: TunePart, dir: 'up' | 'down'): number {
  const t = tune?.[part.sources[0]];
  return t ? t[dir === 'up' ? 0 : 1] : 1;
}

/** The tune with a part's strength set (every source of the part; a single-strength part sets both directions). Pure:
 *  returns a new, sanitized tune (undefined = all as tracked). */
export function withPartStrength(tune: Rig2DTune | undefined, part: TunePart, dir: 'up' | 'down', v: number): Rig2DTune | undefined {
  const x = Math.min(TUNE_MAX, Math.max(0, Number.isFinite(v) ? v : 1));
  const next: Record<string, [number, number]> = {};
  for (const [k, val] of Object.entries(tune ?? {})) if (val) next[k] = [val[0], val[1]];
  for (const s of part.sources) {
    const cur = next[s] ?? [1, 1];
    next[s] = part.down || part.oneWay ? (dir === 'up' ? [x, cur[1]] : [cur[0], x]) : [x, x];
  }
  return sanitizeTune(next);
}

/** The parts this model actually moves (a part none of whose sources is bound would do nothing). */
export function boundParts(bindings: readonly Rig2DBinding[]): TunePart[] {
  const on = new Set(bindings.filter((b) => !b.off).map((b) => b.src));
  return TUNE_PARTS.filter((p) => p.sources.some((s) => on.has(s)));
}

/** For the live marker: the part's value now as a fraction of its bar (0 = the − end, 1 = the + end) and where rest
 *  sits on that bar. `vals` = the standard sources (as tracked, or as applied); the first two sources are averaged. */
export function markerOf(part: TunePart, vals: Readonly<Record<string, number>>): { at: number; rest: number } {
  const s0 = part.sources[0], n = Math.min(2, part.sources.length);
  let v = 0;
  for (let i = 0; i < n; i++) v += vals[part.sources[i]] ?? (SOURCE_REST[part.sources[i]] ?? 0);
  v /= n;
  const [lo, hi0] = SOURCE_RANGE[s0], hi = s0 === 'eyeOpenL' || s0 === 'eyeOpenR' ? 1.25 : hi0, rest = SOURCE_REST[s0] ?? 0;
  const f = (x: number) => Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return { at: f(v), rest: f(rest) };
}
