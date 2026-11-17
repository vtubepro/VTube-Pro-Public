// Text-driven lip sync for the GM: a spoken line (text, start time, duration) → a viseme timeline every page derives
// identically, so the GM's mouth moves the same on every OBS page and every guest's OBS without streaming audio.
// Uses the app's 17 viseme names (src/tracking/visemes.ts). When the studio actually starts speaking (Web Speech
// onstart / provider audio), it re-times the line on its own OBS pages (bus 'sayAt'); provider audio also streams a
// level ('mouth') that scales the openness. Natural rather than flappy: vowels open, consonants close, pauses rest.

export type Vis = 'sil' | 'PP' | 'FF' | 'TH' | 'DD' | 'kk' | 'CH' | 'SS' | 'nn' | 'RR' | 'L' | 'W' | 'aa' | 'E' | 'I' | 'O' | 'U';
export const OPEN: Record<Vis, number> = { sil: 0, PP: 0, FF: 0.12, TH: 0.2, DD: 0.28, kk: 0.32, CH: 0.26, SS: 0.16, nn: 0.22, RR: 0.34, L: 0.32, W: 0.22, aa: 0.95, E: 0.62, I: 0.45, O: 0.78, U: 0.42 };
interface Seg { t0: number; t1: number; v: Vis }
export interface SpeechTrack { segs: Seg[]; dur: number; text: string; charAt: number[] }

/** Seconds a line takes to say at `rate` (Web Speech ≈ 14–15 characters / s at rate 1). */
export function estimateDuration(text: string, rate = 1): number {
  const chars = text.replace(/\s+/g, ' ').trim().length;
  const pauses = (text.match(/[,;:—–]/g)?.length ?? 0) * 0.16 + (text.match(/[.!?…]+/g)?.length ?? 0) * 0.3;
  return Math.max(0.6, chars / (14.5 * Math.max(0.5, Math.min(2, rate))) + pauses);
}

const DIG: [RegExp, Vis][] = [[/^th/, 'TH'], [/^(sh|ch|tch)/, 'CH'], [/^(ph|f|v)/, 'FF'], [/^(ck|k|q|g|c(?![eiy]))/, 'kk'], [/^[pbm]/, 'PP'], [/^(s|z|x|c)/, 'SS'], [/^l/, 'L'], [/^r/, 'RR'], [/^(wh|w)/, 'W'],
  [/^n/, 'nn'], [/^[td]/, 'DD'], [/^j/, 'CH'], [/^y/, 'I'], [/^h/, 'aa'], [/^(oo|ou|u)/, 'U'], [/^(ee|ea|ie|i)/, 'I'], [/^(ai|ay|e)/, 'E'], [/^(oa|ow|o)/, 'O'], [/^(au|aw|a)/, 'aa']];

export function speechTrack(text: string, dur: number): SpeechTrack {
  const units: { v: Vis; w: number; ch: number }[] = [];
  const s = text.toLowerCase();
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    if (/^[.!?…]/.test(rest)) { units.push({ v: 'sil', w: 4.5, ch: i }); i++; continue; }
    if (/^[,;:—–]/.test(rest)) { units.push({ v: 'sil', w: 2.4, ch: i }); i++; continue; }
    if (/^\s/.test(rest)) { units.push({ v: 'sil', w: 0.35, ch: i }); i++; continue; }
    const m = DIG.find(([re]) => re.test(rest));
    if (!m) { i++; continue; }
    const len = (m[0].exec(rest)?.[0].length) ?? 1;
    const vowel = OPEN[m[1]] >= 0.4 && m[1] !== 'kk';
    units.push({ v: m[1], w: vowel ? 1.25 : 0.7, ch: i });
    i += len;
  }
  const total = units.reduce((a, u) => a + u.w, 0) || 1;
  const segs: Seg[] = [];
  const charAt: number[] = [];
  let t = 0;
  for (const u of units) { const d = (u.w / total) * dur; segs.push({ t0: t, t1: t + d, v: u.v }); charAt.push(u.ch); t += d; }
  return { segs, dur, text, charAt };
}

/** A timeline from the audio itself (Rhubarb on the rendered line, server/lipsync/rhubarb.ts): [t0, t1, viseme] seconds into the line.
 *  Same shape as speechTrack's, so sampleSpeech() moves the mouth by it; the text and character index stay empty (captions use the text track). */
export function trackFromLip(cues: readonly (readonly [number, number, string])[], dur: number): SpeechTrack | null {
  const segs: Seg[] = [];
  for (const [t0, t1, v] of cues) if (t1 > t0 && v in OPEN) segs.push({ t0, t1, v: v as Vis });
  if (!segs.length) return null;
  return { segs, dur: Math.max(dur, segs[segs.length - 1].t1), text: '', charAt: [] };
}

export interface MouthSample { open: number; vis: Vis; next: Vis; mix: number; speaking: boolean; progress: number }
/** Mouth at `t` seconds into the line: a smooth blend towards the next viseme (co-articulation). */
export function sampleSpeech(tr: SpeechTrack | null, t: number): MouthSample {
  if (!tr || t < 0 || t > tr.dur || !tr.segs.length) return { open: 0, vis: 'sil', next: 'sil', mix: 0, speaking: false, progress: tr && t > tr.dur ? 1 : 0 };
  let lo = 0, hi = tr.segs.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tr.segs[m].t0 <= t) lo = m; else hi = m - 1; }
  const a = tr.segs[lo], b = tr.segs[Math.min(tr.segs.length - 1, lo + 1)];
  const u = Math.max(0, Math.min(1, (t - a.t0) / Math.max(1e-3, a.t1 - a.t0)));
  const mix = u > 0.6 ? (u - 0.6) / 0.4 : 0;
  const open = OPEN[a.v] * (1 - mix) + OPEN[b.v] * mix;
  // a little jaw bounce so long vowels don't freeze
  const wob = a.v !== 'sil' ? 0.06 * Math.sin(t * 23) : 0;
  return { open: Math.max(0, Math.min(1, open + wob)), vis: a.v, next: b.v, mix, speaking: a.v !== 'sil' || b.v !== 'sil', progress: t / tr.dur };
}

/** How much of the text has been spoken at `t` (captions reveal word by word). */
export function spokenChars(tr: SpeechTrack, t: number): number {
  if (t <= 0) return 0;
  if (t >= tr.dur) return tr.text.length;
  let k = 0;
  while (k < tr.segs.length && tr.segs[k].t1 <= t) k++;
  const ch = tr.charAt[Math.min(k, tr.charAt.length - 1)] ?? tr.text.length;
  const sp = tr.text.indexOf(' ', ch);
  return sp < 0 ? tr.text.length : sp;
}
