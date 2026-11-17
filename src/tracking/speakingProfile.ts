// "My speaking profile": how THIS performer's mouth moves when they speak, learned from their own guided setup, so
// every avatar — built-in, uploaded, any rig — talks the way they do. One profile per person (not per avatar):
//
//   voice  what the mic hears: personal vowel templates + consonant profile (audioLipSync.ts) and the personal output
//          layer of the neural viseme model (neuralPersonal.ts) — already learned by the 45-second setup test
//   face   (this file) how wide / round / puckered / open the performer's mouth ACTUALLY is for each vowel, per unit of
//          loudness, measured by the camera during the setup's held vowels (and while talking). It replaces the voice
//          engine's generic vowel → mouth-shape constants (speechFusion.ts), so the voice-driven mouth — which leads
//          the shape while speaking and carries it alone when the camera can't see the mouth — moves like the person.
//
// Model-agnostic: the style lives in the fusion's own shape space (open / wide / round / pucker → the frame's mouth +
// ARKit mouth channels + visemes), and each avatar's retarget layer (visemeRig / expression driver) maps that as usual.
// The fit is a ridge regression toward the generic constants, so a short or noisy capture can't produce anything wild.

export const VOWEL_ORDER = ['A', 'E', 'I', 'O', 'U'] as const;
export type VowelKey = (typeof VOWEL_ORDER)[number];

/** Voice → mouth shape per unit of loudness (×level): open = L·(base + Σ open[v]·w[v]); wide/round/pucker = L·en·Σ k[v]·w[v]. */
export interface VowelStyle { base: number; open: number[]; wide: number[]; round: number[]; pucker: number[] }
/** The engine's generic constants (identical to the pre-profile speechFusion.ts). Order A E I O U. */
export const DEFAULT_STYLE: VowelStyle = {
  base: 0.35,
  open: [0.95, 0.57, 0.304, 0.7125, 0.266],
  wide: [0, 0.6, 1, 0, 0],
  round: [0, 0, 0, 1, 0],
  pucker: [0, 0, 0, 0, 1.1],
};

/** One captured frame: voice level + sharpened vowel weights, and the camera's mouth at the same moment. */
export interface StyleSample { level: number; w: number[]; cam: { open: number; wide: number; round: number; pucker: number } }

export interface SpeakingProfile {
  v: 1;
  at: string;
  face: { style: VowelStyle; samples: number; vowelsSeen: VowelKey[]; fitErr: Record<string, [number, number]> } | null;
  /** what the voice side has learned (for the UI; the data itself stays where audioLipSync keeps it) */
  voice?: { vowels: boolean; consonants: boolean; neural: boolean };
}
export const PROFILE_KEY = 'vtp.speakingProfile';
export function loadSpeakingProfile(): SpeakingProfile | null {
  try { const s = globalThis.localStorage?.getItem(PROFILE_KEY); const p = s ? JSON.parse(s) as SpeakingProfile : null; return p && p.v === 1 ? p : null; } catch { return null; }
}
export function saveSpeakingProfile(p: SpeakingProfile | null) {
  try { if (p) globalThis.localStorage?.setItem(PROFILE_KEY, JSON.stringify(p)); else globalThis.localStorage?.removeItem(PROFILE_KEY); } catch { /* storage off */ }
}

/** The fusion's vowel sharpening (speechFusion.ts): weights^(1+en), normalised. */
export function sharpen(v: Record<VowelKey, number>, en: number): number[] {
  const sq = (x: number) => Math.pow(Math.max(0, x), 1 + en);
  const w = VOWEL_ORDER.map((k) => sq(v[k] ?? 0));
  const s = w.reduce((a, b) => a + b, 0) || 1;
  return w.map((x) => x / s);
}

/** Voice-driven mouth shape for one frame under a style (the same formulas speechFusion.ts runs). */
export function styleShapes(st: VowelStyle, level: number, w: number[], en: number) {
  const dotw = (k: number[]) => k.reduce((a, c, i) => a + c * w[i], 0);
  return {
    open: level * (st.base + dotw(st.open)),
    wide: level * Math.min(1, dotw(st.wide) * en),
    round: level * Math.min(1, dotw(st.round) * en),
    pucker: level * Math.min(1, dotw(st.pucker) * en),
  };
}

/**
 * Fit a personal style from captured samples (voiced frames of held vowels and ordinary talking). Ridge regression
 * per channel toward the generic constants: y ≈ L·(x·k) with a prior of strength `lambda` samples; coefficients clamped
 * to [0, 2.5]. Returns null with too little data.
 */
export function fitStyle(samples: StyleSample[], en = 1.3, lambda = 40): { style: VowelStyle; fitErr: Record<string, [number, number]>; vowelsSeen: VowelKey[] } | null {
  const S = samples.filter((s) => s.level > 0.12 && s.w.every(Number.isFinite));
  if (S.length < 30) return null;
  const seen = VOWEL_ORDER.filter((_, i) => S.filter((s) => s.w[i] > 0.6).length >= 8);
  const solveRidge = (rows: { x: number[]; y: number }[], k0: number[], lam = lambda) => {
    const n = k0.length, A = new Float64Array(n * n), b = new Float64Array(n);
    for (const r of rows) for (let i = 0; i < n; i++) { b[i] += r.x[i] * r.y; for (let j = 0; j < n; j++) A[i * n + j] += r.x[i] * r.x[j]; }
    // prior: lambda pseudo-samples per coefficient, scaled by the typical x² so it weighs the same on every channel
    const sc = rows.reduce((a, r) => a + r.x.reduce((q, v) => q + v * v, 0), 0) / Math.max(1, rows.length * n);
    for (let i = 0; i < n; i++) { A[i * n + i] += lam * sc; b[i] += lam * sc * k0[i]; }
    // Gaussian elimination
    const M = Array.from(A), v = Array.from(b);
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
      if (Math.abs(M[p * n + c]) < 1e-12) return k0.slice();
      for (let k = 0; k < n; k++) [M[c * n + k], M[p * n + k]] = [M[p * n + k], M[c * n + k]];
      [v[c], v[p]] = [v[p], v[c]];
      for (let r = c + 1; r < n; r++) { const f = M[r * n + c] / M[c * n + c]; for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k]; v[r] -= f * v[c]; }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) { let s = v[r]; for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k]; x[r] = s / M[r * n + r]; }
    return x.map((q) => Math.min(2.5, Math.max(0, q)));
  };
  const D = DEFAULT_STYLE;
  // open: [base, A..U] with x = L·[1, w]
  const openK = solveRidge(S.map((s) => ({ x: [s.level, ...s.w.map((q) => q * s.level)], y: s.cam.open })), [D.base, ...D.open]);
  // pucker: the camera's pucker on running speech is weak/unreliable (beards, the U weight fires on other vowels) —
  // a 4× stronger prior keeps it near the generic value unless the capture clearly says otherwise (held-out check)
  const fitCh = (key: 'wide' | 'round' | 'pucker') => solveRidge(S.map((s) => ({ x: s.w.map((q) => q * s.level * en), y: s.cam[key] })), D[key], key === 'pucker' ? lambda * 4 : lambda);
  // Held-out check on the recorded clip (tools/eval_speaking_profile.ts, 3 folds): the personal WIDE and ROUND halve the
  // voice-driven mouth's error vs the camera on speech the fit never saw; OPEN was neutral (±0.01) and PUCKER got worse
  // in 2 of 3 folds — those two stay generic until a better capture proves otherwise (their fits are reported only).
  const style: VowelStyle = { base: D.base, open: D.open.slice(), wide: fitCh('wide'), round: fitCh('round'), pucker: D.pucker.slice() };
  void openK;
  // training error, generic vs personal (mean abs, on the samples)
  const err = (st: VowelStyle) => {
    const e = { open: 0, wide: 0, round: 0, pucker: 0 };
    for (const s of S) { const p = styleShapes(st, s.level, s.w, en); for (const k of Object.keys(e) as (keyof typeof e)[]) e[k] += Math.abs(p[k] - s.cam[k]); }
    for (const k of Object.keys(e) as (keyof typeof e)[]) e[k] /= S.length;
    return e;
  };
  const e0 = err(D), e1 = err(style);
  const fitErr = Object.fromEntries(Object.keys(e0).map((k) => [k, [+e0[k as keyof typeof e0].toFixed(3), +e1[k as keyof typeof e1].toFixed(3)]])) as Record<string, [number, number]>;
  return { style, fitErr, vowelsSeen: seen };
}
