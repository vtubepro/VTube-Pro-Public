// Example-based expression recognition, personalised.
//
// Single tracking channels are weak and person-specific (beards mute mouth blendshapes, some people
// rest with lowered brows…). Instead we learn what THIS performer's smile / angry / sad / surprised /
// kiss / puff / smirk faces look like across ~50 pose-robust features, and when the live face
// resembles one, the avatar is pushed into a strong, clean cartoon version of that expression.
// Direct tracking still drives everything; this only ADDS (max) on top, so nothing is lost.

import { LIP_T } from './mouthGeometry.ts';

export const EXPR_CLASSES = ['neutral', 'talk', 'happy', 'grin', 'sad', 'angry', 'surprised', 'kiss', 'puff', 'smirk'] as const;
export type ExprClass = (typeof EXPR_CLASSES)[number];

const BS = ['browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'eyeSquintLeft', 'eyeSquintRight',
  'eyeWideLeft', 'eyeWideRight', 'cheekSquintLeft', 'cheekSquintRight', 'noseSneerLeft', 'noseSneerRight', 'jawOpen',
  'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthPucker', 'mouthFunnel', 'mouthStretchLeft',
  'mouthStretchRight', 'mouthRollLower', 'mouthRollUpper', 'mouthPressLeft', 'mouthPressRight', 'mouthShrugLower', 'cheekPuff',
  'mouthLowerDownLeft', 'mouthUpperUpLeft'];
const BROWS = ['_browL', '_browR', '_browInL', '_browInR', '_furrow'];
const GEO = ['_gOpen', '_gSmileL', '_gSmileR', '_gFrownL', '_gFrownR', '_gStretchL', '_gStretchR', '_gPucker', '_gFunnel', '_gPress', '_gPuff', '_gUpperUp', '_gLowerDown'];
export const EXPR_FEATURES = [...BS, ...BROWS, ...GEO, ...LIP_T.map((_, i) => `lu${i}`), ...LIP_T.map((_, i) => `ll${i}`)];

export interface ExprInput {
  /** raw blendshapes (+ raw geo channels, which are already relative to the pose neutral) */
  raw: Record<string, number>;
  /** per-channel resting baseline to subtract (calibrated neutral / rest-tension percentile) */
  rest: Record<string, number>;
  lips: { u: number[]; l: number[] } | null;
}

export function exprFeatures(inp: ExprInput): Float32Array {
  const x = new Float32Array(EXPR_FEATURES.length);
  let i = 0;
  for (const k of BS) x[i++] = (inp.raw[k] ?? 0) - (inp.rest[k] ?? 0);
  // brow geometry relative to its resting value, scaled up (raw deltas are ~0.01–0.05)
  for (const k of BROWS) x[i++] = ((inp.raw[k] ?? 0) - (inp.rest[k] ?? inp.raw[k] ?? 0)) * 10;
  for (const k of GEO) x[i++] = Math.min(1.5, inp.raw[k] ?? 0);
  for (let j = 0; j < LIP_T.length; j++) x[i++] = inp.lips?.u[j] ?? 0;
  for (let j = 0; j < LIP_T.length; j++) x[i++] = inp.lips?.l[j] ?? 0;
  return x;
}

export interface ExprModel {
  version: 1;
  features: string[];
  classes: { name: ExprClass; mean: number[]; n: number }[];
  /** pooled per-feature std (so distances are scale-free) */
  std: number[];
  /** Softmax-regression weights over standardized features: per class [bias, w…]. Preferred when present. */
  lr?: { classes: ExprClass[]; mu: number[]; sd: number[]; W: number[][] };
  source: string;
}

/**
 * Multinomial logistic regression (L2, full-batch gradient descent). Small (≈10 classes × 80
 * features) and trains in well under a second, so it also runs live in the browser for "teach my faces".
 * Classes are re-weighted so the big neutral/talk sets don't drown the expressions.
 */
export function trainSoftmax(samples: { cls: ExprClass; x: Float32Array }[], iters = 400, l2 = 0.02, lr = 0.5): ExprModel['lr'] {
  const classes = [...new Set(samples.map((s) => s.cls))];
  const D = samples[0]?.x.length ?? 0, K = classes.length;
  if (!D || K < 2) return undefined;
  const mu = new Array(D).fill(0), sd = new Array(D).fill(0);
  for (const s of samples) for (let d = 0; d < D; d++) mu[d] += s.x[d] / samples.length;
  for (const s of samples) for (let d = 0; d < D; d++) sd[d] += (s.x[d] - mu[d]) ** 2 / samples.length;
  for (let d = 0; d < D; d++) sd[d] = Math.max(1e-3, Math.sqrt(sd[d]));
  const X = samples.map((s) => { const z = new Float64Array(D + 1); z[0] = 1; for (let d = 0; d < D; d++) z[d + 1] = (s.x[d] - mu[d]) / sd[d]; return z; });
  const Y = samples.map((s) => classes.indexOf(s.cls));
  const count = classes.map((_, k) => Y.filter((y) => y === k).length);
  const sw = Y.map((y) => samples.length / (K * count[y])); // balanced class weights
  const W = Array.from({ length: K }, () => new Float64Array(D + 1));
  const G = Array.from({ length: K }, () => new Float64Array(D + 1));
  const p = new Float64Array(K);
  for (let it = 0; it < iters; it++) {
    for (const g of G) g.fill(0);
    for (let n = 0; n < X.length; n++) {
      const z = X[n];
      let mx = -Infinity;
      for (let k = 0; k < K; k++) { let s = 0; const w = W[k]; for (let d = 0; d <= D; d++) s += w[d] * z[d]; p[k] = s; if (s > mx) mx = s; }
      let sum = 0;
      for (let k = 0; k < K; k++) { p[k] = Math.exp(p[k] - mx); sum += p[k]; }
      for (let k = 0; k < K; k++) {
        const e = (p[k] / sum - (Y[n] === k ? 1 : 0)) * sw[n];
        const g = G[k];
        for (let d = 0; d <= D; d++) g[d] += e * z[d];
      }
    }
    for (let k = 0; k < K; k++) for (let d = 0; d <= D; d++) W[k][d] -= lr * (G[k][d] / X.length + (d ? l2 * W[k][d] : 0));
  }
  return { classes, mu, sd, W: W.map((w) => Array.from(w, (v) => +v.toFixed(5))) };
}

export function trainExprModel(samples: { cls: ExprClass; x: Float32Array }[], source: string): ExprModel {
  const D = EXPR_FEATURES.length;
  const by = new Map<ExprClass, Float32Array[]>();
  for (const s of samples) { const a = by.get(s.cls) ?? []; a.push(s.x); by.set(s.cls, a); }
  const classes: ExprModel['classes'] = [];
  const within = new Float64Array(D);
  let total = 0;
  for (const [name, xs] of by) {
    if (xs.length < 5) continue;
    const mean = new Array(D).fill(0);
    for (const x of xs) for (let d = 0; d < D; d++) mean[d] += x[d] / xs.length;
    for (const x of xs) for (let d = 0; d < D; d++) within[d] += (x[d] - mean[d]) ** 2;
    total += xs.length;
    classes.push({ name, mean, n: xs.length });
  }
  const std = Array.from(within, (v) => Math.max(0.02, Math.sqrt(v / Math.max(1, total))));
  return { version: 1, features: EXPR_FEATURES, classes, std, lr: trainSoftmax(samples), source };
}

/** Soft class posteriors from scaled distance to each class centroid. */
export function classifyExpr(m: ExprModel, x: Float32Array, sharpness = 0.9): Record<ExprClass, number> {
  const out = {} as Record<ExprClass, number>;
  if (m.lr) {
    const { classes, mu, sd, W } = m.lr;
    const logits = W.map((w) => { let s = w[0]; for (let d = 0; d < x.length; d++) s += w[d + 1] * (x[d] - mu[d]) / sd[d]; return s; });
    const mx = Math.max(...logits);
    const ex = logits.map((l) => Math.exp(l - mx));
    const sum = ex.reduce((a, b) => a + b, 0) || 1;
    for (const n of EXPR_CLASSES) out[n] = 0;
    classes.forEach((c, i) => (out[c] = ex[i] / sum));
    return out;
  }
  const logits: number[] = [];
  for (const c of m.classes) {
    let d2 = 0;
    for (let d = 0; d < x.length; d++) { const z = (x[d] - c.mean[d]) / m.std[d]; d2 += z * z; }
    logits.push(-sharpness * Math.sqrt(d2 / x.length) * 4);
  }
  const mx = Math.max(...logits);
  const ex = logits.map((l) => Math.exp(l - mx));
  const sum = ex.reduce((a, b) => a + b, 0) || 1;
  for (const n of EXPR_CLASSES) out[n] = 0;
  m.classes.forEach((c, i) => (out[c.name] = ex[i] / sum));
  return out;
}

/**
 * Sanity gates: a preset may only fire when its core physical signal is actually present, so the
 * classifier can't invent a puff or a kiss out of an ambiguous neutral. Returns 0..1 multiplier.
 */
export function exprGate(c: ExprClass, raw: Record<string, number>, rest: Record<string, number>): number {
  const d = (k: string) => (raw[k] ?? 0) - (rest[k] ?? 0);
  const ss = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const innerBrow = (d('_browInL') + d('_browInR')) / 2; // + raised, − lowered
  switch (c) {
    case 'puff': return ss(0.5, 0.8, raw._gPuff ?? 0);
    case 'kiss': return ss(0.12, 0.32, Math.max(raw._gPucker ?? 0, d('mouthPucker')));
    // sad/angry: faces differ person to person (the trained model separates them); just require
    // SOME frown / lip tension so a relaxed face can't trigger either
    case 'angry': case 'sad': return ss(0.08, 0.25, Math.max(raw._gFrownL ?? 0, raw._gFrownR ?? 0, raw._gPress ?? 0, d('mouthRollLower'), Math.abs(innerBrow) * 12));
    case 'happy': case 'grin': return ss(0.2, 0.45, Math.max(raw._gSmileL ?? 0, raw._gSmileR ?? 0, d('mouthSmileLeft'), d('mouthSmileRight')));
    case 'smirk': return ss(0.25, 0.5, Math.abs((raw._gSmileL ?? 0) - (raw._gSmileR ?? 0)));
    default: return 1;
  }
}

/** Strong cartoon targets per recognised expression (ARKit channels, avatar-side after mirroring). */
export const EXPR_PRESETS: Partial<Record<ExprClass, Record<string, number>>> = {
  happy: { mouthSmileLeft: 0.95, mouthSmileRight: 0.95, cheekSquintLeft: 0.6, cheekSquintRight: 0.6, eyeSquintLeft: 0.3, eyeSquintRight: 0.3 },
  grin: { mouthSmileLeft: 1, mouthSmileRight: 1, jawOpen: 0.55, cheekSquintLeft: 0.9, cheekSquintRight: 0.9, eyeSquintLeft: 0.5, eyeSquintRight: 0.5, mouthUpperUpLeft: 0.3, mouthUpperUpRight: 0.3 },
  sad: { mouthFrownLeft: 0.9, mouthFrownRight: 0.9, browInnerUp: 1, eyeSquintLeft: 0.15, eyeSquintRight: 0.15, mouthShrugLower: 0.4 },
  angry: { browDownLeft: 1, browDownRight: 1, mouthFrownLeft: 0.6, mouthFrownRight: 0.6, mouthPressLeft: 0.5, mouthPressRight: 0.5, noseSneerLeft: 0.6, noseSneerRight: 0.6, eyeSquintLeft: 0.35, eyeSquintRight: 0.35 },
  surprised: { browOuterUpLeft: 1, browOuterUpRight: 1, browInnerUp: 1, eyeWideLeft: 1, eyeWideRight: 1, jawOpen: 0.35, mouthFunnel: 0.35 },
  kiss: { mouthPucker: 1, mouthFunnel: 0.15 },
  puff: { cheekPuff: 1, mouthPressLeft: 0.4, mouthPressRight: 0.4 },
  // smirk side is resolved at runtime from which corner is actually lifted
  smirk: { mouthSmileLeft: 0.9, mouthLeft: 0.3, browDownRight: 0.25 },
};
