// Sustained-fricative merge (pure; shared by AudioLipSync and tools/eval_voice.ts).
//
// The analysis' own fricative paths only trust hiss within ~0.4 s of voicing, so a held "fffff" / "sssss" fades
// out, and a steady "vvvvv" reads as a vowel (periodic, no dip). The voice worklet detects fricatives on the raw,
// pre-RNNoise signal (spectral shape, continuity, near-mic level) and reports a confidence + class split; this
// blends that into the voice's visemes / mouth hints for as long as the sound is held.
import type { AudioMouth } from '../../tracking/audioFeatures.ts';
import { normalizeVisemes, type Viseme } from '../../tracking/visemes.ts';

export interface FricStat { fric: number; fF: number; fTH: number; fS: number; fSH: number; fV: number; fDur?: number }
export interface Fricative {
  cls: 'FF' | 'TH' | 'SS' | 'CH' | null;
  /** 0..1 */
  conf: number;
  /** V / Z / ZH (voicing under the hiss) */
  voiced: boolean;
  /** seconds the current fricative has been held */
  held: number;
  probs: { FF: number; TH: number; SS: number; CH: number };
}

export function fricativeOf(st: FricStat | null | undefined): Fricative {
  if (!st || !(st.fric > 0)) return { cls: null, conf: 0, voiced: false, held: 0, probs: { FF: 0, TH: 0, SS: 0, CH: 0 } };
  const s = st.fF + st.fTH + st.fS + st.fSH || 1;
  const probs = { FF: st.fF / s, TH: st.fTH / s, SS: st.fS / s, CH: st.fSH / s };
  let cls: Fricative['cls'] = 'FF', b = -1;
  for (const k of ['FF', 'TH', 'SS', 'CH'] as const) if (probs[k] > b) { b = probs[k]; cls = k; }
  return { cls: st.fric > 0.15 ? cls : null, conf: Math.min(1, st.fric), voiced: st.fV > 0.5, held: st.fDur ?? 0, probs };
}

/** Blend a detected fricative into the analysis result (in place). No-op when nothing is detected. */
export function mergeFricative(m: AudioMouth, f: Fricative) {
  // in running speech the analysis classifies short fricatives itself (it now hears the raw hiss); the detector
  // takes over as the sound is HELD (≥ ~50 ms), which is where the analysis loses it
  const c = f.conf * Math.min(1, Math.max(0, (f.held - 0.04) / 0.08));
  if (c < 0.02) return m;
  const w = { ...(m.visemes ?? {}) } as Record<Viseme, number>;
  const fam = (w.FF ?? 0) + (w.TH ?? 0) + (w.SS ?? 0) + (w.CH ?? 0);
  // the analysis already sees a fricative → only re-split / top up; otherwise the detector takes over by `c`
  const k = c * (1 - 0.5 * Math.min(1, fam));
  for (const v of Object.keys(w) as Viseme[]) w[v] = (w[v] ?? 0) * (1 - k);
  for (const v of ['FF', 'TH', 'SS', 'CH'] as const) w[v] = (w[v] ?? 0) + k * f.probs[v] + (1 - k) * 0;
  m.visemes = normalizeVisemes(w);
  const lip = c * (f.probs.FF + f.probs.TH), sib = c * (f.probs.SS + f.probs.CH);
  m.fv = Math.max(m.fv, lip);
  m.sib = Math.max(m.sib, sib);
  m.open *= 1 - 0.75 * c;          // F/V/S/SH are near-closed shapes, even when voiced
  m.wide = Math.max(m.wide * (1 - c), sib * 0.4 * (m.level || 0.5));
  return m;
}
