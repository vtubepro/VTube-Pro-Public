// Vocal gestures the lip-sync engine otherwise reads as ordinary speech (pure; shared by the app and the tools):
//
//   laughter  "ha-ha-ha": a train of short voiced bursts at 3–7 Hz on the SAME open vowel, no lip closures or hiss
//             between them. Read as syllables, the mouth snaps shut between every "ha" (chattering teeth). A real
//             laughing mouth stays open and smiles, the jaw bouncing on each burst. → `laugh` 0..1
//   shouting  the voice front-end normalises the performer's everyday level, and the envelope saturates at that
//             level, so a shout looked exactly like talking. `loud` 0..1 = how far the voice is above the performer's
//             own running speech level (+4 → +10 dB) → a bigger jaw / more teeth downstream.
// Both only ever ADD to the mouth (SpeechFusion applies them); silence stays the voice gate's.
import type { AudioMouth } from './audioFeatures.ts';

const ss = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

interface Burst { t0: number; t1: number; vowel: string; clo: number; hiss: number }

export class VocalGestures {
  /** 0..1 smoothed laughter (attack ~120 ms, release ~450 ms) */
  laugh = 0;
  /** 0..1 smoothed "louder than you usually talk" (+6 → +12 dB over your ~90th-percentile syllable level) */
  loud = 0;
  private t = 0;
  private inBurst = false;
  private cur: Burst | null = null;
  private bursts: Burst[] = [];
  private gapClo = 0;
  private peak = 0;
  private trough = 0;
  private gapHiss = 0;
  /** the performer's loud-syllable level (dBFS on voiced frames): a slow ~90th-percentile tracker */
  private ref = NaN;
  private refN = 0;
  dbg = { score: 0, n: 0, period: 0, db: 0 };
  parts: number[] = [];

  step(a: AudioMouth, dt: number, dbfs?: number): { laugh: number; loud: number } {
    this.t += dt;
    const t = this.t;
    // ---- bursts (voiced syllable nuclei) ----
    // a burst ends when the voice stops OR the envelope falls to 55 % of the burst's peak (fast laughs never go silent
    // between the "ha"s); the next one starts when it climbs 1.5× above that trough again
    if (this.inBurst) this.peak = Math.max(this.peak, a.level); else this.trough = Math.min(this.trough, a.level);
    const on = a.level > 0.28 && a.voiced && a.level > this.trough * 1.5;
    const off = !a.voiced || a.level < 0.14 || a.level < this.peak * 0.55;
    const top = (() => { let k = 'A', m = -1; for (const [v, w] of Object.entries(a.vowels)) if (w > m) { m = w; k = v; } return k; })();
    if (!this.inBurst && on) {
      this.inBurst = true; this.peak = a.level;
      this.cur = { t0: t, t1: t, vowel: top, clo: this.gapClo, hiss: this.gapHiss };
      this.gapClo = 0; this.gapHiss = 0;
    } else if (this.inBurst) {
      this.cur!.t1 = t;
      if (a.vowels[top as keyof typeof a.vowels] > 0.5) this.cur!.vowel = top;
      if (off) { this.inBurst = false; this.trough = a.level; this.bursts.push(this.cur!); this.cur = null; }
    } else {
      // between bursts: lip closures (M/B/P) or sibilant / lip-teeth hiss mean speech, not laughter
      this.gapClo = Math.max(this.gapClo, a.closure, a.visemes?.PP ?? 0);
      this.gapHiss = Math.max(this.gapHiss, a.sib, a.fv);
    }
    while (this.bursts.length && this.bursts[0].t0 < t - 1.6) this.bursts.shift();
    // ---- laughter score over the last ~1.6 s ----
    // (the last ≤ 5 bursts: a laugh right after a sentence must not be judged by the sentence's syllables)
    const B = this.bursts.concat(this.cur ? [this.cur] : []).slice(-5);
    let score = 0, period = 0;
    if (B.length >= 3) {
      const ioi: number[] = [];
      for (let i = 1; i < B.length; i++) ioi.push(B[i].t0 - B[i - 1].t0);
      const m = ioi.reduce((s, x) => s + x, 0) / ioi.length;
      const sd = Math.sqrt(ioi.reduce((s, x) => s + (x - m) ** 2, 0) / ioi.length);
      period = m;
      const rate = ss(0.11, 0.15, m) * ss(0.4, 0.3, m);                 // 2.5–7 Hz
      const regular = ss(0.45, 0.25, sd / m);                            // metrical, not speech rhythm
      const short = ss(0.3, 0.2, Math.max(...B.slice(0, -1).map((b) => b.t1 - b.t0), 0)); // no long vowels
      const same = B.filter((b) => b.vowel === B[B.length - 1].vowel).length / B.length; // one repeated vowel
      const open = B.filter((b) => b.vowel !== 'U').length / B.length;                   // ha / he / hee / ho — not "woo"
      // lip closures between the bursts = "mama / baba / papa" speech (a laugh's breathy "h" DOES read as hiss, so
      // hiss can't veto it)
      const clean = 1 - ss(0.35, 0.6, Math.max(...B.slice(1).map((b) => b.clo), 0));
      score = rate * regular * short * ss(0.6, 0.85, same) * ss(0.5, 0.8, open) * clean * ss(2.5, 3.5, B.length);
      this.parts = [rate, regular, short, same, open, clean].map((x) => +x.toFixed(2));
    }
    // stays on while the train goes on; lets go ~0.5 s after the last burst
    const alive = B.length && t - B[B.length - 1].t1 < 0.45 ? 1 : 0;
    const target = score * alive;
    this.laugh += (target - this.laugh) * (1 - Math.exp(-dt / (target > this.laugh ? 0.12 : 0.45)));
    // ---- shouting: dB above the performer's own running voiced level ----
    let db = 0;
    const snrDb = dbfs;
    if (snrDb !== undefined && Number.isFinite(snrDb)) {
      if (a.voiced && a.level > 0.3) {
        if (!Number.isFinite(this.ref)) this.ref = snrDb;
        // ~90th percentile (up 0.6 dB/s, down 0.067 dB/s: 9 : 1), fast while it learns; a few seconds of shouting
        // barely move it, an evening of talking quieter lowers it
        const k = this.refN < 120 ? 8 : 1;
        this.ref += (snrDb > this.ref ? 0.6 : -0.067) * k * dt;
        this.refN++;
      }
      db = a.voiced && Number.isFinite(this.ref) && this.refN > 60 ? snrDb - this.ref : 0;
    }
    const loudT = ss(6, 12, db) * (a.voiced ? 1 : 0);
    this.loud += (loudT - this.loud) * (1 - Math.exp(-dt / (loudT > this.loud ? 0.12 : 0.3)));
    this.dbg = { score: +score.toFixed(2), n: B.length, period: +period.toFixed(3), db: +db.toFixed(1), parts: this.parts.join(',') } as typeof this.dbg;
    return { laugh: this.laugh, loud: this.loud };
  }
}
