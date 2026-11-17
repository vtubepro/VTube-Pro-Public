// The lip-sync bus: ONE place that knows how a TrackingFrame's mouth channels (voice visemes, the mouth summary, the
// ARKit face, Audio2Face's frame.a2f) turn into the shapes every avatar kind draws. The 3D path (src/avatar/visemeRig.ts,
// VRM presets + ARKit shapes) and the Pro2D path (shared/rig2d/drive.ts, mouth parameters) both read it, so a viseme
// means the same thing on both. Pure (no DOM, no three.js): unit-tested in tools/lipbus_unit.ts.
//
//   · the 17 viseme set (src/tracking/visemes.ts) and its Meta / Oculus 15 ↔ 17 mapping (toOculus15 / fromOculus15)
//   · the vowel mix: A I U E O (Pro2D ParamMouthA…O) = VRM presets aa ih ou ee oh — one table, two names
//   · the A2F accessor (frame.a2f): the mouth channels + the tongue / eye / upper-face extras, camera-aware
//   · Rhubarb's mouth shapes A–H, X → our visemes (offline lip sync for clips and TTS lines, server/lipsync/rhubarb.ts)
import { VISEMES, type Viseme } from './visemeNames.ts';
import type { TrackingFrame } from './types.ts';

export { VISEMES };
export type { Viseme };

const cl = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const ss = (a: number, b: number, x: number) => { const t = cl((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------- Meta / Oculus 15 ↔ our 17
/** Meta (Oculus) lip-sync viseme set, in Meta's order: sil PP FF TH DD kk CH SS nn RR aa E I O U. */
export const OCULUS15 = ['sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'aa', 'E', 'I', 'O', 'U'] as const;
export type OculusViseme = typeof OCULUS15[number];
/** Our 17 = Oculus 15 + L + W. Folding the two extras back: L (tongue tip up, open) is Meta's `nn` (n, l); W (tight
 *  round) is `U` (Meta's "ou"). Everything else is the same name and the same sound. */
export const FOLD_TO_OCULUS: Partial<Record<Viseme, OculusViseme>> = { L: 'nn', W: 'U' };
/** Meta's own names → ours (also accepts "viseme_aa", the OVR / glTF extras spelling, and the VRM vowel names). */
const OCULUS_ALIASES: Record<string, Viseme> = { ih: 'I', oh: 'O', ou: 'U', ee: 'E', sil: 'sil', silence: 'sil' };
export function oculusToViseme(name: string): Viseme | null {
  const n = name.replace(/^viseme[_\s-]*/i, '').trim();
  const exact = (VISEMES as readonly string[]).includes(n) ? (n as Viseme) : null;
  if (exact) return exact;
  return OCULUS_ALIASES[n.toLowerCase()] ?? (VISEMES.find((v) => v.toLowerCase() === n.toLowerCase()) ?? null);
}

/** Our 17 viseme weights → Oculus 15 weights (L → nn, W → U; sums are kept). */
export function toOculus15(vis: Partial<Record<string, number>>): Record<OculusViseme, number> {
  const out = {} as Record<OculusViseme, number>;
  for (const o of OCULUS15) out[o] = 0;
  for (const v of VISEMES) { const w = vis[v] ?? 0; if (w > 0) out[FOLD_TO_OCULUS[v] ?? (v as OculusViseme)] += w; }
  return out;
}
/** Oculus 15 weights (keys with or without "viseme_") → our 17 (L and W stay 0: Meta's set has no such class). */
export function fromOculus15(o: Partial<Record<string, number>>): Record<Viseme, number> {
  const out = {} as Record<Viseme, number>;
  for (const v of VISEMES) out[v] = 0;
  for (const [k, w] of Object.entries(o)) { const v = oculusToViseme(k); if (v && Number.isFinite(w) && (w as number) > 0) out[v] += w as number; }
  return out;
}

// ---------------------------------------------------------------- vowel mix
/** The five Pro2D mouth-shape parameters (ParamMouthA / I / U / E / O). */
export const VOWELS = ['A', 'I', 'U', 'E', 'O'] as const;
export type Vowel = typeof VOWELS[number];
export type Vowels = Record<Vowel, number>;
/** VRM presets (aa ih ou ee oh) ↔ the vowels: the same five mouth shapes under two names. */
export const VRM_OF_VOWEL: Record<Vowel, 'aa' | 'ih' | 'ou' | 'ee' | 'oh'> = { A: 'aa', I: 'ih', U: 'ou', E: 'ee', O: 'oh' };
export type VrmPresets = { aa?: number; ih?: number; ou?: number; ee?: number; oh?: number; close?: number; small?: number };

/** What each viseme looks like on a preset-only face (VRM A/I/U/E/O, VRChat / MMD visemes, VRoid Fcl_MTH_*) and on a
 *  Pro2D vowel mouth: a consonant leans on the nearest vowel shape (S = a thin "ih", W = a round "ou" …). */
export const VISEME_PRESET: Record<Viseme, VrmPresets> = {
  sil: {},
  PP: { close: 0.8 },
  FF: { ih: 0.42, close: 0.2 },
  TH: { ee: 0.3, aa: 0.14 },
  DD: { ih: 0.3, aa: 0.08 },
  kk: { aa: 0.3, ee: 0.1 },
  CH: { ou: 0.45, ih: 0.25, small: 0.3 },
  SS: { ih: 0.6 },
  nn: { ih: 0.15, ee: 0.1 },
  RR: { ou: 0.4, oh: 0.2, small: 0.2 },
  L: { aa: 0.35, ee: 0.15 },
  W: { ou: 0.9, small: 0.5 },
  aa: { aa: 1 }, E: { ee: 0.85 }, I: { ih: 0.85 }, O: { oh: 0.9 }, U: { ou: 0.9, small: 0.2 },
};

/** The articulators a vowel mix is built from (the viseme rig's smoothed envelopes, or the frame's mouth summary). */
export interface Articulators { open: number; round: number; spread: number; teeth: number; tuck: number; seal: number }

/** VRM preset weights from the articulators. `k` = intensity (model style × speaking engagement). The total is capped
 *  at 1 (presets are additive blendshapes: combined vowels must not over-deform the face). Moved here from
 *  visemeRig.ts unchanged, so the 3D rig and Pro2D share one formula. */
export function vrmPresetsFromArticulators(a: Articulators, k = 1): { aa: number; ee: number; ih: number; oh: number; ou: number } {
  const { round, spread, teeth, tuck, seal } = a;
  const o = ss(0.02, 0.5, a.open);                                 // preset opening follows the jaw stroke
  const v = {
    aa: cl(o * (1 - round) * (1 - spread * 0.6) * k, 0, 1),
    ee: cl(o * spread * 0.75 * (1 - round) * k, 0, 1),
    ih: cl((spread * (1 - o * 0.5) * 0.7 + teeth * 0.45 + tuck * 0.4) * (1 - round) * (1 - seal) * k, 0, 1),
    oh: cl(o * round * 0.9 * k, 0, 1),
    ou: cl(round * (1 - o * 0.6) * 0.85 * (1 - seal) * k, 0, 1),
  };
  const tot = v.aa + v.ee + v.ih + v.oh + v.ou;
  if (tot > 1) { v.aa /= tot; v.ee /= tot; v.ih /= tot; v.oh /= tot; v.ou /= tot; }
  return v;
}
const toVowels = (p: { aa?: number; ih?: number; ou?: number; ee?: number; oh?: number }): Vowels => ({ A: p.aa ?? 0, I: p.ih ?? 0, U: p.ou ?? 0, E: p.ee ?? 0, O: p.oh ?? 0 });

/** Vowel mix from the voice-timed visemes (a consonant leans on its nearest vowel, VISEME_PRESET), total ≤ 1. */
export function vowelsFromVisemes(vis: Partial<Record<string, number>>): Vowels {
  const out = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
  for (const v of VISEMES) {
    const w = vis[v] ?? 0;
    if (w <= 0) continue;
    const p = VISEME_PRESET[v];
    out.aa += w * (p.aa ?? 0); out.ih += w * (p.ih ?? 0); out.ou += w * (p.ou ?? 0); out.ee += w * (p.ee ?? 0); out.oh += w * (p.oh ?? 0);
  }
  const tot = out.aa + out.ih + out.ou + out.ee + out.oh;
  if (tot > 1) for (const k of Object.keys(out) as (keyof typeof out)[]) out[k] /= tot;
  return toVowels(out);
}

// ---------------------------------------------------------------- A2F (frame.a2f)
/** Channels of the A2F record that are not the mouth articulators (src/tracking/a2fMerge.ts A2F_EXTRA): tongue poses,
 *  eye look (micro-motion), and the upper face that A2F's emotion model moves. */
export const A2F_TONGUE = ['tongueOut', 'tongueTipUp', 'tongueTipDown', 'tongueUp', 'tongueDown', 'tongueStretch', 'tongueWide', 'tongueNarrow', 'tongueIn'] as const;
export const A2F_EYES = ['eyeLookUpLeft', 'eyeLookDownLeft', 'eyeLookInLeft', 'eyeLookOutLeft', 'eyeLookUpRight', 'eyeLookDownRight', 'eyeLookInRight', 'eyeLookOutRight'] as const;
export const A2F_UPPER = ['browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'browDownLeft', 'browDownRight', 'eyeWideLeft', 'eyeWideRight', 'eyeSquintLeft', 'eyeSquintRight',
  'cheekSquintLeft', 'cheekSquintRight', 'noseSneerLeft', 'noseSneerRight'] as const;
export const A2F_EXTRA_KEYS: readonly string[] = [...A2F_TONGUE, ...A2F_EYES, ...A2F_UPPER];
const EXTRA_SET = new Set<string>(A2F_EXTRA_KEYS), UPPER_SET = new Set<string>(A2F_UPPER);

/** How much of A2F's upper face a camera-tracked frame accepts (it may only RAISE what the camera sees, never fight it);
 *  an untracked frame takes it whole. Eye look: untracked frames only (the camera owns the gaze) AND only with the dev flag (a2fDev.eyes). */
export const A2F_UPPER_TRACKED = 0.35;

/** DEV FLAG: apply A2F's eye look. OFF: the channel is computed and carried (sidecar -> frame.a2f) but nothing reads it as a gaze
 *  until its sign is verified (the network's up / down convention is not documented and could not be checked against a reference;
 *  docs/GPU_TRACKING.md). Turn on only to test: localStorage `vtp.dev.a2fEyes` = '1', or set `a2fDev.eyes`. */
export const a2fDev = { eyes: false };
try { if (globalThis.localStorage?.getItem('vtp.dev.a2fEyes') === '1') a2fDev.eyes = true; } catch { /* no storage (node, tools) */ }

export interface A2fBus {
  /** blend weight 0..1 (the voice gate decides what counts as speech) */
  k: number;
  /** a mouth channel (gained, 0..1), 0 when A2F doesn't have it */
  ch(name: string): number;
  /** a tongue / eye / upper-face channel, camera-aware (see A2F_UPPER_TRACKED): the value to MAX with the face's own */
  extra(name: string): number;
}
const NO_A2F: A2fBus = { k: 0, ch: () => 0, extra: () => 0 };
export function readA2f(f: Pick<TrackingFrame, 'a2f' | 'tracked'>): A2fBus {
  const A = f.a2f;
  if (!A) return NO_A2F;
  const k = cl(A.k ?? 0, 0, 1);
  if (k <= 0) return NO_A2F;
  const tracked = f.tracked !== false;
  return {
    k,
    ch: (c) => A[c] ?? 0,
    extra: (c) => {
      const v = A[c] ?? 0;
      if (v <= 0) return 0;
      if (c.startsWith('eyeLook')) return a2fDev.eyes && !tracked ? v : 0;
      if (UPPER_SET.has(c)) return tracked ? v * A2F_UPPER_TRACKED : v;
      return v;                                                      // tongue: the camera doesn't see it
    },
  };
}

// ---------------------------------------------------------------- the frame, read once
export interface LipBus {
  /** the mouth summary with defaults filled in */
  mouth: { open: number; wide: number; smile: number; frown: number; pucker: number; funnel: number; tongue: number; fv: number; sib: number; closure: number; laugh: number; speak: number };
  /** voice visemes (sum 1), null when the mic is off */
  visemes: Partial<Record<Viseme, number>> | null;
  /** rounded-vowel mass and spread-vowel mass of the visemes (O + U + 0.6 W, E + 0.8 I): the 2D drive's round / wide */
  round: number;
  wide: number;
  a2f: A2fBus;
  /** a face (ARKit) channel with A2F's tongue / eye / upper-face extras folded in (max) */
  face(name: string): number;
  /** A2F's eye micro-motion as a gaze [x (+ = avatar-left), y (+ = up)], −1..1; [0, 0] while the camera tracks the face */
  gaze(): [number, number];
  /** the five mouth shapes (ParamMouthA I U E O / VRM aa ih ou ee oh): voice-timed visemes when there are any, else the mouth summary */
  vowels(): Vowels;
}

const MOUTH0 = { open: 0, wide: 0, smile: 0, frown: 0, pucker: 0, funnel: 0, tongue: 0 };
export function readLipBus(f: TrackingFrame): LipBus {
  const face = f.face ?? {};
  const m = f.mouth ?? MOUTH0 as TrackingFrame['mouth'];
  const v = (f.visemes ?? null) as Partial<Record<Viseme, number>> | null;
  const a2f = readA2f(f);
  const mouth = { open: m.open ?? 0, wide: m.wide ?? 0, smile: m.smile ?? 0, frown: m.frown ?? 0, pucker: m.pucker ?? 0, funnel: m.funnel ?? 0, tongue: m.tongue ?? 0,
    fv: m.fv ?? 0, sib: m.sib ?? 0, closure: m.closure ?? 0, laugh: m.laugh ?? 0, speak: m.speak ?? 0 };
  const vv = v ?? {};
  const bus: LipBus = {
    mouth, visemes: v,
    round: (vv.O ?? 0) + (vv.U ?? 0) + (vv.W ?? 0) * 0.6,
    wide: (vv.E ?? 0) + (vv.I ?? 0) * 0.8,
    a2f,
    face: (n) => { const x = face[n] ?? 0; return a2f.k > 0 && EXTRA_SET.has(n) ? Math.max(x, a2f.extra(n) * a2f.k) : x; },
    gaze: () => {
      if (a2f.k <= 0) return [0, 0];
      const e = (n: string) => a2f.extra(n) * a2f.k;
      return [cl(((e('eyeLookOutLeft') - e('eyeLookInLeft')) + (e('eyeLookInRight') - e('eyeLookOutRight'))) / 2, -1, 1),
        cl(((e('eyeLookUpLeft') - e('eyeLookDownLeft')) + (e('eyeLookUpRight') - e('eyeLookDownRight'))) / 2, -1, 1)];
    },
    vowels: () => {
      if (v && mouth.speak > 0.02) return vowelsFromVisemes(v);
      return toVowels(vrmPresetsFromArticulators({ open: mouth.open, round: Math.max(mouth.pucker, mouth.funnel), spread: mouth.wide, teeth: mouth.sib, tuck: mouth.fv, seal: mouth.closure }));
    },
  };
  return bus;
}

// ---------------------------------------------------------------- Rhubarb mouth shapes → our visemes
/** Rhubarb Lip Sync's mouth shapes (Preston Blair set + G H X): A closed MBP · B teeth together (K S T, EE) · C open (EH)
 *  · D wide (AA) · E rounded (AO ER) · F puckered (OO W) · G F V · H L · X rest. One viseme each (B is the thin spread
 *  "I" with the teeth-near-closed consonants mixed in). */
export const RHUBARB_SHAPES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'X'] as const;
export type RhubarbShape = typeof RHUBARB_SHAPES[number];
export const RHUBARB_VISEME: Record<RhubarbShape, Partial<Record<Viseme, number>>> = {
  A: { PP: 1 }, B: { I: 0.6, DD: 0.2, SS: 0.2 }, C: { E: 1 }, D: { aa: 1 }, E: { O: 1 }, F: { U: 0.7, W: 0.3 }, G: { FF: 1 }, H: { L: 1 }, X: { sil: 1 },
};
