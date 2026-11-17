// Viseme engine, audio side (pure; shared by the live mic path and the offline tools).
//
// Viseme set (Meta/Oculus 15 + L + W):
//   sil  silence                      PP  M B P (lips pressed)          FF  F V (lower lip under upper teeth)
//   TH   TH DH (tongue tip at teeth)   DD  T D (tongue tip up, near-closed) kk K G (back closure, slightly open)
//   CH   CH J SH ZH (rounded, teeth near-closed)                        SS  S Z (teeth together, spread)
//   nn   N NG (near-closed, tongue up)  RR  R (rounded, slight open)     L   L (open, tongue tip raised)
//   W    W (tight protruded round)    aa E I O U  vowels
//
// Audio LEADS the timing (the mic is ~60 ms ahead of the camera). Classification is layered:
//   1. rules on articulatory features (speechFeatures.ts) — speaker-normalised, work for anyone out of the
//      box (the "default profile");
//   2. an optional per-user learned profile (diagonal Gaussian classifier) trained from short held
//      sounds in the guided setup ("fff", "vvv", "lll", "shh", "sss", "thh", "rrr", "www", "mmm" + vowels),
//      blended over the rules once available;
//   3. short consonant holds so a 30 ms F still shows for a couple of video frames.
// Camera confirmation (lip tuck, rounding, tongue, closure) happens in speechFusion.ts.

import { AsymEma, clamp01, smoothstep as ss } from './filters.ts';
import type { AudioMouth } from './audioFeatures.ts';
import type { SpeechFeatures } from './speechFeatures.ts';

import { VISEMES, type Viseme } from '../../shared/visemeNames.ts';
export { VISEMES, type Viseme };
export type VisemeWeights = Record<Viseme, number>;
export const CONSONANTS: Viseme[] = ['PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'L', 'W'];
export const VOWEL_VISEMES: Viseme[] = ['aa', 'E', 'I', 'O', 'U'];

export function zeroVisemes(): VisemeWeights {
  const o = {} as VisemeWeights;
  for (const v of VISEMES) o[v] = 0;
  o.sil = 1;
  return o;
}

/** Normalised weights (non-negative, sum 1, `sil` takes the remainder). */
export function normalizeVisemes(w: Partial<Record<Viseme, number>>): VisemeWeights {
  const o = {} as VisemeWeights;
  let s = 0;
  for (const v of VISEMES) { if (v === 'sil') continue; const x = Math.max(0, w[v] ?? 0); o[v] = Number.isFinite(x) ? x : 0; s += o[v]; }
  const sil = Math.max(0, w.sil ?? 0);
  if (s + sil > 1) { const k = 1 / (s + sil); for (const v of VISEMES) if (v !== 'sil') o[v] *= k; o.sil = sil * k; }
  else o.sil = 1 - s;
  return o;
}

export function topViseme(w: Partial<Record<Viseme, number>>, from: readonly Viseme[] = VISEMES): Viseme {
  let best: Viseme = 'sil', bv = -1;
  for (const v of from) if ((w[v] ?? 0) > bv) { bv = w[v] ?? 0; best = v; }
  return best;
}

// ------------------------------------------------------------------ learned per-user profile
export const PROFILE_FEATURES = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'lf1', 'lf2', 'lf3', 'cent', 'sPeak', 'pkRel', 'period', 'nasal', 'fric', 'dip'] as const;

export interface LearnedClass { name: Viseme; mean: number[]; var: number[]; n: number }
export interface LearnedVisemeProfile { v: 1; classes: LearnedClass[]; source: string; sMed?: number }

/** Feature vector for the learned classifier (NaN = not measured this frame). */
export function profileVector(cep: Float32Array, f: SpeechFeatures, nasal: number, sMed: number): number[] {
  const nan = Number.NaN;
  return [
    cep[0] / 20, cep[1] / 10, cep[2] / 10, cep[3] / 6, cep[4] / 6, cep[5] / 6,
    f.fOk ? Math.log(f.f1r) * 4 : nan, f.fOk ? Math.log(f.f2r) * 4 : nan, f.fOk ? Math.log(f.f3r) * 4 : nan,
    f.cent / 2, f.sPeak / 8, f.peakHz / Math.max(1000, sMed) * 2, f.period * 2, nasal / 10, f.fricSnr / 10, f.vDip / 10,
  ];
}

export function trainLearnedProfile(samples: { cls: Viseme; x: number[] }[], source: string, sMed?: number): LearnedVisemeProfile {
  const by = new Map<Viseme, number[][]>();
  for (const s of samples) { const a = by.get(s.cls) ?? []; a.push(s.x); by.set(s.cls, a); }
  const classes: LearnedClass[] = [];
  for (const [name, xs] of by) {
    if (xs.length < 6) continue;
    const D = xs[0].length, mean: number[] = [], vr: number[] = [];
    for (let d = 0; d < D; d++) {
      const vals = xs.map((x) => x[d]).filter((v) => Number.isFinite(v));
      if (vals.length < 3) { mean.push(Number.NaN); vr.push(1); continue; }
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      const v = vals.reduce((a, b) => a + (b - m) * (b - m), 0) / vals.length;
      mean.push(m); vr.push(Math.max(v, 0.04)); // variance floor: held sounds are steadier than running speech
    }
    classes.push({ name, mean, var: vr, n: xs.length });
  }
  return { v: 1, classes, source, sMed };
}

/** Posterior over the profile's classes (sums to 1), or null when the profile is empty. */
export function classifyLearned(p: LearnedVisemeProfile, x: number[], temperature = 2.5): Partial<Record<Viseme, number>> | null {
  if (!p.classes.length) return null;
  const ll: number[] = [];
  for (const c of p.classes) {
    let s = 0, n = 0;
    for (let d = 0; d < x.length; d++) {
      if (!Number.isFinite(x[d]) || !Number.isFinite(c.mean[d])) continue;
      const z = x[d] - c.mean[d];
      s += (z * z) / c.var[d] + Math.log(c.var[d]);
      n++;
    }
    ll.push(n ? -0.5 * s / n : -1e9); // per-dimension average: frames with fewer measured dims compare fairly
  }
  const mx = Math.max(...ll);
  const out: Partial<Record<Viseme, number>> = {};
  let sum = 0;
  p.classes.forEach((c, i) => { const e = Math.exp((ll[i] - mx) * temperature); out[c.name] = (out[c.name] ?? 0) + e; sum += e; });
  for (const k in out) out[k as Viseme]! /= sum;
  return out;
}

// vowels are left to the per-user MFCC vowel profile (held vowels in the setup don't look like running speech)
const LEARN_FAMILIES: Viseme[][] = [['FF', 'TH', 'CH', 'SS'], ['PP', 'nn', 'DD', 'kk'], ['L', 'RR', 'W']];

// ------------------------------------------------------------------ formant vowel templates
// Speaker-scaled (by F3 median ≈ vocal-tract length) average adult templates, Hz
const VOWEL_F: Record<'aa' | 'E' | 'I' | 'O' | 'U', [number, number]> = {
  aa: [720, 1200], E: [520, 1800], I: [310, 2200], O: [540, 950], U: [340, 950],
};

function formantVowels(f: SpeechFeatures, f3med: number): Record<'aa' | 'E' | 'I' | 'O' | 'U', number> {
  const k = Math.max(0.75, Math.min(1.35, f3med / 2700));
  const l1 = Math.log(f.F1 / k), l2 = Math.log(f.F2 / k);
  const out = { aa: 0, E: 0, I: 0, O: 0, U: 0 };
  let s = 0;
  for (const v of VOWEL_VISEMES as ('aa' | 'E' | 'I' | 'O' | 'U')[]) {
    const [t1, t2] = VOWEL_F[v];
    const d = ((l1 - Math.log(t1)) / 0.22) ** 2 + ((l2 - Math.log(t2)) / 0.18) ** 2;
    out[v] = Math.exp(-0.5 * d); s += out[v];
  }
  for (const v in out) out[v as 'aa'] /= s || 1;
  return out;
}

// ------------------------------------------------------------------ the classifier
export interface VisemeDbg { hiss: number; peaked: number; chRel: number; flatF: number; clo: number; nas: number; vmass: number; rr: number; l: number; w: number; learned: boolean }

export class VisemeClassifier {
  /** Learned per-user profile (null = rules only). */
  learned: LearnedVisemeProfile | null = null;
  /** Learned vs rules blend when a learned profile exists. */
  learnedMix = 0.5;
  /** Running median of the sibilant peak frequency (S-dominant), for S vs SH. */
  sMed = 5000;
  private sN = 0;
  private sinceVoice = 9;
  private ema = Object.fromEntries(VISEMES.map((v) => [v, new AsymEma(60, 32)])) as Record<Viseme, AsymEma>;
  private hold = Object.fromEntries(VISEMES.map((v) => [v, { v: 0, t: 0 }])) as Record<Viseme, { v: number; t: number }>;
  raw: VisemeWeights = zeroVisemes();
  out: VisemeWeights = zeroVisemes();
  dbg: VisemeDbg = { hiss: 0, peaked: 0, chRel: 0, flatF: 0, clo: 0, nas: 0, vmass: 0, rr: 0, l: 0, w: 0, learned: false };
  lastVector: number[] = [];
  private fvRun = 0;

  step(a: AudioMouth, f: SpeechFeatures, nasal: number, cep: Float32Array, f3med: number, dt: number): VisemeWeights {
    const L = a.level;
    this.sinceVoice = a.voiced ? 0 : this.sinceVoice + dt;
    const near = this.sinceVoice < 0.45 || L > 0.05 || a.fv > 0.3 || a.sib > 0.3 ? 1 : 0;
    // ---- fricatives: hissy (energy above ~2.5 kHz, clearly above its floor), then spectral shape
    // a loud, strongly periodic frame at the syllable peak is a vowel even when it is bright (held "EE")
    const vowelLike = ss(0.78, 0.92, f.period) * ss(8, 3, f.vDip);
    const hiss = ss(2.2, 3.4, f.cent) * ss(7, 16, f.fricSnr) * near * (1 - vowelLike);
    // sibilant vs flat hiss: S/Z/SH are peaked AND strong (within ~18 dB of the syllable peak); F/V/TH are
    // flat and weak (lip/teeth friction is quiet)
    const peaked = 1 / (1 + Math.exp(-((f.sPeak - 9) / 4 + (19 - f.vDip) / 3)));
    if (hiss > 0.7 && f.sPeak > 12) {
      // track the speaker's S peak (S/Z are by far the most frequent sibilants)
      const k = this.sN < 40 ? 0.06 : 0.01;
      this.sN++;
      this.sMed += Math.sign(f.peakHz - this.sMed) * k * 400;
      this.sMed = Math.max(3200, Math.min(9000, this.sMed));
    }
    const chRel = ss(0.82, 0.64, f.peakHz / this.sMed);
    // a weak, flat hiss is F/V or TH; a loud one that isn't peaked is aspiration / breathy speech
    const loudFlat = ss(0.35, 0.7, L) * (1 - peaked);
    const flatF = hiss * (1 - peaked) * (1 - loudFlat * 0.7);
    // the analyzer's S-vs-F cue (energy above 4.5 kHz vs 2.5-4.5 kHz, voicing-aware) wins when they disagree:
    // a held or voiced F whose hiss the peak / periodicity checks misread still reads as lip under teeth
    // (not when the hiss has a sharp spectral peak: a sibilant groove, SH mostly, which the fv/sib band split calls F)
    const fvA = ss(0.5, 0.9, a.fv) * (1 - ss(0.1, 0.4, a.sib)) * (1 - 0.9 * ss(10, 15, f.sPeak));
    this.fvRun = fvA > 0.5 ? this.fvRun + dt : 0;
    const fvHeld = fvA * ss(0.12, 0.25, this.fvRun);          // only a SUSTAINED lip-teeth hiss overrides S / SH
    const SS = hiss * peaked * (1 - chRel) * (1 - fvHeld * 0.85);
    const CH = hiss * peaked * chRel * (1 - fvHeld * 0.85);
    // …and only once it has lasted a moment: a brief fv blip inside a J / CH / S mustn't steal their frame
    const FF = Math.max(flatF * 0.68, fvA * 0.8 * ss(0.03, 0.08, this.fvRun)), TH = flatF * 0.32;
    // ---- constrictions (lips / tongue closing while voicing continues) and nasal murmur
    const clo = a.closure * (1 - hiss);
    const nas = ss(12, 24, nasal) * (a.voiced ? 1 : 0);
    let PP = clo * (0.6 + 0.15 * nas);
    const nn = clo * nas * 0.35;
    let DD = clo * (1 - nas) * 0.25;
    let kk = clo * (1 - nas) * 0.2;
    // plosive release: place of articulation from the burst spectrum
    if (f.burst > 0) {
      const hi = ss(3.6, 5.2, f.burstCent), lo = 1 - ss(1.8, 2.8, f.burstCent);
      PP += f.burst * lo * 0.6;
      DD += f.burst * hi * 0.5;
      kk += f.burst * (1 - hi) * (1 - lo) * 0.5;
    }
    // ---- voiced approximants + vowels
    const vmass = (a.voiced ? clamp01(L * 1.8) : 0) * (1 - hiss) * (1 - clo * 0.9) * (1 - fvA * 0.6);
    let RR = 0, Ll = 0, W = 0;
    let vow = { aa: a.vowels.A, E: a.vowels.E, I: a.vowels.I, O: a.vowels.O, U: a.vowels.U };
    if (f.fOk) {
      const k = Math.max(0.75, Math.min(1.35, f3med / 2700));
      const F1 = f.F1 / k, F2 = f.F2 / k;
      // R: F3 dives toward F2
      RR = ss(0.84, 0.68, f.f3r) * ss(1100, 700, f.F3 - f.F2);
      // L: low F1, low-mid F2, HIGH F3 (unlike R), and weaker than the vowels around it
      Ll = ss(470, 380, F1) * ss(800, 950, F2) * ss(1450, 1250, F2) * ss(0.98, 1.08, f.f3r) * ss(1.5, 5, f.vDip) * (1 - RR);
      // W: very low F1 + F2 glide into a vowel (a held one is just U)
      W = ss(420, 330, F1) * ss(950, 800, F2) * ss(2, 6, f.vDip) * (1 - RR);
      // formant vowels complement the (per-user) MFCC matcher; skip them where LPC is unreliable —
      // back vowels merge F1+F2 and the "F2" peak is really F3
      const merged = f.F1 < 330 && f.F2 > 1900 && vow.U + vow.O > 0.4;
      const fv = formantVowels(f, f3med);
      const m = merged ? 0 : 0.25;
      vow = { aa: vow.aa * (1 - m) + fv.aa * m, E: vow.E * (1 - m) + fv.E * m, I: vow.I * (1 - m) + fv.I * m, O: vow.O * (1 - m) + fv.O * m, U: vow.U * (1 - m) + fv.U * m };
    }
    const vs = vow.aa + vow.E + vow.I + vow.O + vow.U;
    const approx = Math.min(1, RR + Ll + W);
    const vk = vmass * (1 - approx) / (vs > 1e-6 ? vs : 1);
    const raw: Partial<Record<Viseme, number>> = {
      PP, FF, TH, DD, kk, CH, SS, nn,
      RR: vmass * RR, L: vmass * Ll, W: vmass * W,
      aa: vk * vow.aa, E: vk * vow.E, I: vk * vow.I, O: vk * vow.O, U: vk * vow.U,
    };
    // quiet voiced murmur that isn't anything else stays "barely open" — the vowel shapes carry that
    // ---- learned per-user profile
    this.lastVector = profileVector(cep, f, nasal, this.sMed);
    this.dbg = { hiss, peaked, chRel, flatF, clo, nas, vmass, rr: RR, l: Ll, w: W, learned: false };
    if (this.learned?.classes.length) {
      const post = classifyLearned(this.learned, this.lastVector);
      const act = Math.max(vmass, hiss, clo);
      if (post && act > 0.05) {
        this.dbg.learned = true;
        const m = this.learnedMix;
        // the rules decide the articulation FAMILY (fricative / closure / approximant / vowel — robust,
        // speaker-independent); the learned profile re-splits mass among the family members it was trained on
        for (const fam of LEARN_FAMILIES) {
          const known = fam.filter((v) => this.learned!.classes.some((c) => c.name === v));
          if (known.length < 2) continue;
          const mass = known.reduce((acc, v) => acc + (raw[v] ?? 0), 0);
          const ps = known.reduce((acc, v) => acc + (post[v] ?? 0), 0);
          if (mass < 1e-4 || ps < 1e-6) continue;
          for (const v of known) raw[v] = (raw[v] ?? 0) * (1 - m) + mass * ((post[v] ?? 0) / ps) * m;
        }
      }
    }
    this.raw = normalizeVisemes(raw);
    // ---- smoothing: fast attack, short release; consonants hold ≥ 50 ms so they read on video
    const o: Partial<Record<Viseme, number>> = {};
    for (const v of VISEMES) {
      if (v === 'sil') continue;
      let x = this.ema[v].step(this.raw[v], dt);
      const h = this.hold[v];
      if (CONSONANTS.includes(v)) {
        if (this.raw[v] > 0.22 && this.raw[v] >= h.v * 0.9) { h.v = Math.max(this.raw[v], x); h.t = 0.05; }
        else h.t -= dt;
        if (h.t > 0) x = Math.max(x, h.v * 0.85);
        else h.v = x;
      }
      o[v] = x;
    }
    this.out = normalizeVisemes(o);
    return this.out;
  }
}
