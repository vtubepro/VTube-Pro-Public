// Drum onsets for the groove (shared/groove.ts): kick and snare hits with their TRUE time, from the beat worklet's
// band features (no extra DSP on the audio thread). The engine's own kick / snare cues are tuned to fire the reactive
// lights fast and safe (envelope thresholds, a 48 ms snare classification wait), which makes their time stamps wander
// 0-60 ms; the groove needs where each hit really was, so this peak-picks the spectral-flux bands with one hop of
// look-ahead and back-dates every peak by the worklet's measured latency (tools/beat/rhythm_eval.ts measures it
// against offline-labelled drum attacks). Pure: runs in the beat worker and in the Node harness alike.
//
// Worklet channels used: 8 superflux < 220 Hz, 9 superflux 220-2.5k, 10 superflux > 2.5k, 0 / 1 kick + body RMS,
// 13 midrange spectral flatness (noise = snare / clap), 12 presence attack.

/** Time from a drum's attack to the END of the hop whose flux peaks on it (ms): one STFT window (2 hops) is centred a
 *  hop before the hop's end. Measured: tools/beat/rhythm_eval.ts --onset-bias (see docs/DJ_SYNC.md "Groove"). */
export const ONSET_BIAS_MS = { kick: 16, snare: 14 };

export interface DrumHit { kind: 'kick' | 'snare'; t: number; w: number }

class Odf {
  // the last 5 hops: a peak is the largest within ±2 hops (two hops of look-ahead: a smaller bump on the way up to the
  // real attack never wins)
  private h = [0, 0, 0, 0, 0];
  private tH = [0, 0, 0, 0, 0];
  private peak = 1e-3; private mean = 0; private last = -1e9;
  constructor(private refrMs: number, private rel: number) {}
  /** One hop value at time t (ms, hop end). Returns the peak hop's value/time once it is confirmed. */
  push(v: number, t: number, dtS: number): { v: number; t: number } | null {
    this.h.shift(); this.h.push(v); this.tH.shift(); this.tH.push(t);
    const b = this.h[2];
    this.peak = Math.max(b, this.peak * Math.exp(-dtS / 6), 1e-4);
    this.mean += (v - this.mean) * (1 - Math.exp(-dtS / 0.4));
    if (b > this.h[0] && b > this.h[1] && b >= this.h[3] && b >= this.h[4] && b > this.peak * this.rel && b > this.mean * 1.6 && this.tH[2] - this.last >= this.refrMs) {
      this.last = this.tH[2];
      return { v: Math.min(1, b / this.peak), t: this.tH[2] };
    }
    return null;
  }
}

export class DrumOnsets {
  private kick = new Odf(90, 0.3);
  private snare = new Odf(110, 0.3);
  private lastT = NaN;
  private lows = [0, 0, 0, 0, 0];
  private kv = [1, 1, 1, 1, 1];
  /** Feed one worklet hop (`row` = its 15 channels) ending at time t (ms). Returns the hits that just peaked. */
  push(t: number, row: ArrayLike<number>): DrumHit[] {
    const dt = Number.isFinite(this.lastT) ? Math.min(0.2, Math.max(0.001, (t - this.lastT) / 1000)) : 0.0107;
    this.lastT = t;
    if (row.length < 14) return [];
    const out: DrumHit[] = [];
    const sfLow = Math.max(0, row[8]), sfMid = Math.max(0, row[9]), sfHigh = Math.max(0, row[10]), flat = row[13] || 0;
    // the kick: low-band flux, while the low band gets louder (a decaying bass note's wobble doesn't)
    const low = row[0] * row[0] + row[1] * row[1];
    this.lows.shift(); this.lows.push(low);
    const rising = this.lows[4] > this.lows[0] * 1.4 || this.lows[3] > this.lows[0] * 1.4;
    this.kv.shift(); this.kv.push(rising ? 1 : 0.25);
    const k = this.kick.push(sfLow * this.kv[4], t, dt);
    if (k) out.push({ kind: 'kick', t: k.t - ONSET_BIAS_MS.kick, w: k.v });
    // the snare / clap: broadband NOISE flux in the mids + highs (a hat has almost nothing under 2.5 kHz, a synth note
    // is tonal)
    const noise = Math.max(0, Math.min(1, (flat - 0.01) / 0.05));
    const hatOnly = sfMid < 0.12 * sfHigh;
    // (a kick's beater click is flux in the mids too, but it isn't noisy for long: below half the noise level a hop that
    // also carries a strong low-band attack counts as the kick's)
    const kickish = sfLow > 0.8 * (sfMid + sfHigh) && noise < 0.5;
    const s = this.snare.push(hatOnly || kickish ? 0 : (0.6 * sfMid + sfHigh) * Math.pow(0.15 + 0.85 * noise, 1.5), t, dt);
    if (s) out.push({ kind: 'snare', t: s.t - ONSET_BIAS_MS.snare, w: s.v });
    return out;
  }
}
