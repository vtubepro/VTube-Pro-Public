// The 52 ARKit blendshape channels (shared/arkitNames.ts, so the helper can use them too).
import { ARKIT } from '../../shared/arkitNames.ts';
export { ARKIT };

export type ArkitName = (typeof ARKIT)[number];

/** Left<->Right counterpart of a channel (for mirror mode). */
export function mirrorName(n: string): string {
  if (n.endsWith('Left')) return n.slice(0, -4) + 'Right';
  if (n.endsWith('Right')) return n.slice(0, -5) + 'Left';
  if (n === 'mouthLeft') return 'mouthRight';
  if (n === 'mouthRight') return 'mouthLeft';
  if (n === 'jawLeft') return 'jawRight';
  if (n === 'jawRight') return 'jawLeft';
  return n;
}

/**
 * Typical raw MediaPipe peak per channel for an average face (what a "full" expression reads).
 * The amplifier maps [neutral .. peak] onto [0 .. 1]; per-user calibration replaces these.
 * Raw MediaPipe is conservative — e.g. jawOpen rarely exceeds ~0.55 even mouth wide open.
 */
export const DEFAULT_PEAK: Partial<Record<ArkitName, number>> = {
  jawOpen: 0.5, mouthSmileLeft: 0.6, mouthSmileRight: 0.6, mouthFunnel: 0.35, mouthPucker: 0.75,
  mouthFrownLeft: 0.25, mouthFrownRight: 0.25, browInnerUp: 0.55, browDownLeft: 0.45, browDownRight: 0.45,
  browOuterUpLeft: 0.5, browOuterUpRight: 0.5, cheekPuff: 0.25, eyeWideLeft: 0.35, eyeWideRight: 0.35,
  eyeSquintLeft: 0.6, eyeSquintRight: 0.6, cheekSquintLeft: 0.4, cheekSquintRight: 0.4,
  mouthStretchLeft: 0.3, mouthStretchRight: 0.3, mouthPressLeft: 0.4, mouthPressRight: 0.4,
  mouthRollLower: 0.4, mouthRollUpper: 0.3, mouthShrugLower: 0.5, mouthShrugUpper: 0.4,
  mouthLowerDownLeft: 0.5, mouthLowerDownRight: 0.5, mouthUpperUpLeft: 0.5, mouthUpperUpRight: 0.5,
  noseSneerLeft: 0.35, noseSneerRight: 0.35, mouthLeft: 0.3, mouthRight: 0.3, jawLeft: 0.2, jawRight: 0.2,
  jawForward: 0.25, mouthDimpleLeft: 0.3, mouthDimpleRight: 0.3, mouthClose: 0.3, tongueOut: 0.5,
};

/** Normalize a morph/expression name for fuzzy matching against ARKit names. */
export function normKey(name: string): string {
  let s = name.toLowerCase().replace(/^.*[.:|]/, ''); // "blendShape1.jawOpen" / "Face:jawOpen"
  s = s.replace(/[^a-z0-9]/g, '').replace(/^(arkit|blendshape\d*|bs)/, '');
  if (ARKIT_NORM.has(s)) return s;
  // "eyeBlink_L" / "eyeBlinkL" → eyeblinkleft
  const stem = s.slice(0, -1);
  if (s.endsWith('l') && ARKIT_NORM.has(stem + 'left')) return stem + 'left';
  if (s.endsWith('r') && ARKIT_NORM.has(stem + 'right')) return stem + 'right';
  return s;
}

const ARKIT_NORM = new Set(ARKIT.map((n) => n.toLowerCase()));
export const ARKIT_BY_NORM = new Map<string, ArkitName>(ARKIT.map((n) => [n.toLowerCase(), n]));
