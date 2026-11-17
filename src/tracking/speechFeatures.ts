// Articulatory speech features for viseme classification (pure; shared by the live mic path and the
// offline tools so what is tuned on recordings is exactly what runs live).
//
// Per 60 Hz frame, from the AnalyserNode spectrum (dB, fft/2 bins) + the raw waveform:
//   * fricative spectrum shape — S/Z hiss peaks high (5–10 kHz), SH/CH/ZH is loud and peaks low
//     (2–4.5 kHz, lip rounding lengthens the front cavity), F/V and TH are weak, flat and diffuse
//   * formants F1–F3 (LPC on a 12 kHz decimated copy) — R has a very low F3, L a low F2 with a high F3
//     and a dip in level, W a very low F1+F2 glide
//   * voicing (autocorrelation periodicity), nasal murmur (hum without formants), articulation dips
//   * plosive bursts — a sudden broadband onset after a closure / silence, placed by its spectrum
//     (P/B diffuse + low, T/D high, K/G compact mid)
// Formants are normalised by the speaker's own running medians so the rules are speaker-independent.

export interface SpeechFeatures {
  /** dB bands */
  bLow: number; bF1: number; bMid: number; bHi: number; bVhi: number; bSH: number; bS: number; bTop: number;
  /** total 1.5–12 kHz energy (dB) and how far above its own noise floor it is */
  fricE: number; fricSnr: number;
  /** spectral centroid of 1–12 kHz, kHz */
  cent: number;
  /** spectral flatness of 1–12 kHz (0 tonal … 1 white noise) */
  flat: number;
  /** SH-ness: 1.8–4.2 kHz band vs 4.5–10 kHz band (dB); S-ness is the opposite sign */
  shVsS: number;
  /** hiss peak prominence (dB) and where it peaks (Hz) */
  sPeak: number; peakHz: number;
  /** periodicity 0..1 (normalised autocorrelation peak at 80–400 Hz pitch lags) */
  period: number;
  /** fundamental frequency estimate (Hz, octave-checked + parabolic lag interpolation); 0 = unvoiced / unsure */
  f0: number;
  /** formant estimates (Hz; 0 = not measured this frame) and relative to the speaker's medians */
  F1: number; F2: number; F3: number; f1r: number; f2r: number; f3r: number; fOk: boolean;
  /** dB below the recent (300 ms) level peak — consonants/glides sit in these valleys */
  vDip: number;
  /** plosive burst 0..1 this frame and its spectral centroid (kHz) */
  burst: number; burstCent: number;
  /** frame energy (dB, uncalibrated) */
  eDb: number;
}

export function emptyFeatures(): SpeechFeatures {
  return { bLow: -120, bF1: -120, bMid: -120, bHi: -120, bVhi: -120, bSH: -120, bS: -120, bTop: -120, fricE: -120, fricSnr: 0, cent: 0, flat: 0, shVsS: 0, sPeak: 0, peakHz: 0, period: 0, f0: 0,
    F1: 0, F2: 0, F3: 0, f1r: 1, f2r: 1, f3r: 1, fOk: false, vDip: 0, burst: 0, burstCent: 0, eDb: -120 };
}

// ---- 4× decimation low-pass (48 kHz → 12 kHz), 31-tap windowed sinc, cutoff 5 kHz ----
const DEC = 4;
const TAPS = (() => {
  const n = 31, fc = 5000 / 48000, h = new Float32Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const m = i - (n - 1) / 2;
    const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
    h[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1)));
    s += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= s;
  return h;
})();

const LPC_ORDER = 12;
/** LPC envelope points (150–4500 Hz) searched for formant peaks */
const ENV_N = 220;

/** dB spectrum → power, P[k] = 10^(db[k] / 10) (the one pow pass per frame the analysis shares; length db.length). */
export function powerSpectrum(db: Float32Array, P: Float64Array): Float64Array {
  for (let k = 0; k < db.length; k++) P[k] = 10 ** (db[k] / 10);
  return P;
}

const levTmp = new Float64Array(LPC_ORDER + 1);
/** Levinson–Durbin: autocorrelation r[0..p] → predictor a[1..p] (a[0] = 1). */
function levinson(r: Float64Array, p: number, a: Float64Array): boolean {
  const tmp = p === LPC_ORDER ? levTmp : new Float64Array(p + 1);
  a.fill(0); a[0] = 1;
  let err = r[0];
  if (err <= 0) return false;
  for (let i = 1; i <= p; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / err;
    tmp.set(a);
    for (let j = 1; j < i; j++) a[j] = tmp[j] + k * tmp[i - j];
    a[i] = k;
    err *= 1 - k * k;
    if (err <= 0) return false;
  }
  return true;
}

export class SpeechFeatureExtractor {
  readonly f: SpeechFeatures = emptyFeatures();
  private fricFloor = -80;
  private eHist: number[] = [];
  private hiHist: number[] = [];
  private lowLevelHist: number[] = [];
  /** speaker medians (running) of voiced vowel formants */
  med = { F1: 550, F2: 1500, F3: 2600 };
  private medN = 0;
  private fHist: number[][] = [];
  private dec = new Float32Array(0);
  private win = new Float32Array(0);
  private r = new Float64Array(LPC_ORDER + 1);
  private a = new Float64Array(LPC_ORDER + 1);
  private ac = new Float32Array(0);
  private pw = new Float64Array(0);
  /** prefix sums of the decimated signal's squares (pitch autocorrelation energies) */
  private sq = new Float64Array(0);
  private wbuf = new Float32Array(0);
  private mag = new Float32Array(ENV_N);
  private envCos: Float64Array | null = null;
  private envSin: Float64Array | null = null;
  private envFs = 0;

  /** time: waveform, db: AnalyserNode dB spectrum, `level`/`voiced` from the envelope follower. `P`: db as power
   *  (powerSpectrum()) when the caller already has it; computed here otherwise. */
  step(time: Float32Array, db: Float32Array, sampleRate: number, dt: number, level: number, voicedE: boolean, P?: Float64Array): SpeechFeatures {
    const f = this.f;
    const hz = sampleRate / (db.length * 2);
    if (!P || P.length !== db.length) {
      if (this.pw.length !== db.length) this.pw = new Float64Array(db.length);
      P = powerSpectrum(db, this.pw);
    }
    const pw = P;
    const band = (lo: number, hi: number) => {
      let s = 0;
      for (let k = Math.max(1, Math.floor(lo / hz)); k < Math.min(db.length, Math.ceil(hi / hz)); k++) s += pw[k];
      return 10 * Math.log10(s + 1e-12);
    };
    f.bLow = band(80, 400); f.bF1 = band(400, 1000); f.bMid = band(1000, 2500); f.bHi = band(2500, 4500); f.bVhi = band(4500, 8000);
    f.bSH = band(1800, 4200); f.bS = band(4500, 10000); f.bTop = band(8000, 12000);
    f.shVsS = f.bSH - f.bS;
    // centroid + flatness over 1–12 kHz
    {
      const k0 = Math.floor(1000 / hz), k1 = Math.min(db.length - 1, Math.ceil(12000 / hz));
      let sp = 0, sfp = 0, slog = 0, n = 0;
      for (let k = k0; k <= k1; k++) {
        const p = pw[k] + 1e-14;
        sp += p; sfp += p * k * hz; slog += Math.log(p); n++;
      }
      f.cent = sp > 0 ? sfp / sp / 1000 : 0;
      f.flat = n ? Math.exp(slog / n) / (sp / n) : 0;
      f.fricE = 10 * Math.log10(sp + 1e-14);
    }
    this.fricFloor = f.fricE < this.fricFloor ? f.fricE : this.fricFloor + (f.fricE - this.fricFloor) * 0.002 * dt * 60;
    f.fricSnr = f.fricE - this.fricFloor;
    // sibilant peak: S/Z/SH concentrate the hiss in a narrow resonance (a groove jet on the teeth), F/V/TH
    // spread it flat. Peak density (1 kHz windows, 1.5–11 kHz) over the 0.8–1.5 kHz density.
    {
      const dens = (lo: number, hi: number) => {
        let s = 0, n = 0;
        for (let k = Math.max(1, Math.floor(lo / hz)); k < Math.min(db.length, Math.ceil(hi / hz)); k++) { s += pw[k]; n++; }
        return 10 * Math.log10(s / Math.max(1, n) + 1e-14);
      };
      let best = -200, at = 0;
      for (let c = 1500; c <= 11000; c += 250) { const d = dens(c - 500, c + 500); if (d > best) { best = d; at = c; } }
      f.sPeak = best - dens(800, 1500);
      f.peakHz = at;
    }
    // energy + recent-peak dip
    let e = 0;
    for (let i = 0; i < time.length; i++) e += time[i] * time[i];
    f.eDb = 10 * Math.log10(e / time.length + 1e-12);
    const keep = Math.max(4, Math.round(0.3 / Math.max(dt, 1e-3)));
    this.eHist.push(f.eDb);
    while (this.eHist.length > keep) this.eHist.shift();
    f.vDip = Math.max(...this.eHist) - f.eDb;

    // ---- plosive burst: broadband high-band jump after a quiet / closed stretch ----
    const hiNow = 10 * Math.log10(10 ** (f.bHi / 10) + 10 ** (f.bVhi / 10) + 10 ** (f.bTop / 10));
    const bk = Math.max(3, Math.round(0.09 / Math.max(dt, 1e-3)));
    this.hiHist.push(hiNow);
    while (this.hiHist.length > bk + 1) this.hiHist.shift();
    this.lowLevelHist.push(level);
    while (this.lowLevelHist.length > bk + 1) this.lowLevelHist.shift();
    const prevHi = Math.min(...this.hiHist.slice(0, -1));
    const prevLvl = Math.min(...this.lowLevelHist.slice(0, -1));
    const jump = hiNow - prevHi;
    // a closure (level near zero) within the last ~90 ms, then ≥ 12 dB of broadband onset
    const gated = prevLvl < 0.12 ? 1 : 0;
    f.burst = gated * Math.min(1, Math.max(0, (jump - 10) / 10));
    f.burstCent = f.burst > 0 ? f.cent : 0;

    // ---- decimate to 12 kHz for periodicity + LPC formants ----
    const n = Math.floor((time.length - TAPS.length) / DEC);
    if (this.dec.length !== n) { this.dec = new Float32Array(n); this.win = new Float32Array(n); for (let i = 0; i < n; i++) this.win[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1)); }
    const x = this.dec;
    for (let i = 0; i < n; i++) {
      let s = 0;
      const o = i * DEC;
      for (let k = 0; k < TAPS.length; k++) s += time[o + k] * TAPS[k];
      x[i] = s;
    }
    const fs = sampleRate / DEC;
    // periodicity: normalised autocorrelation, pitch 80–400 Hz
    {
      const l0 = Math.floor(fs / 400), l1 = Math.min(n - 32, Math.ceil(fs / 80));
      let best = 0, bestL = 0;
      if (this.ac.length < l1 + 2) this.ac = new Float32Array(l1 + 2);
      const ac = this.ac;
      // window energies from prefix sums of x²: e0 = Σ x[0..n−L−1]² is the same running sum the per-lag loop formed,
      // e1 = Σ x[L..n−1]² = Q[n] − Q[L] (differs from the loop's sum by float64 rounding only)
      if (this.sq.length !== n + 1) this.sq = new Float64Array(n + 1);
      const Q = this.sq;
      Q[0] = 0;
      for (let i = 0; i < n; i++) Q[i + 1] = Q[i] + x[i] * x[i];
      for (let L = l0; L <= l1; L++) {
        let c = 0;
        for (let i = 0; i + L < n; i++) c += x[i] * x[i + L];
        const e0 = Q[n - L], e1 = Q[n] - Q[L];
        const v = c / Math.sqrt(e0 * e1 + 1e-18);
        ac[L] = v;
        if (v > best) { best = v; bestL = L; }
      }
      f.period = Math.max(0, Math.min(1, best));
      // f0 (additive — prosody for the talking-face layer): the SHORTEST lag that is a local peak within 8 % of
      // the best one (a periodic signal also peaks at 2×, 3× its period — picking those halves the pitch)
      f.f0 = 0;
      if (best > 0.5 && bestL > 0) {
        let L = bestL;
        for (let k = l0 + 1; k < bestL; k++) if (ac[k] >= best * 0.92 && ac[k] >= ac[k - 1] && ac[k] >= ac[k + 1]) { L = k; break; }
        // parabolic interpolation of the peak (sub-sample lag → ~1 % pitch resolution at 12 kHz)
        const a0 = L > l0 ? ac[L - 1] : ac[L], a1 = ac[L], a2 = L < l1 ? ac[L + 1] : ac[L];
        const den = a0 - 2 * a1 + a2;
        const d = den < 0 ? Math.max(-0.5, Math.min(0.5, (a0 - a2) / (2 * den))) : 0;
        f.f0 = fs / (L + d);
      }
    }
    // LPC formants (voiced frames only)
    f.fOk = false;
    if (voicedE && f.period > 0.45) {
      if (this.wbuf.length !== n) this.wbuf = new Float32Array(n);
      const w = this.wbuf;
      for (let i = 0; i < n; i++) w[i] = (x[i] - (i ? 0.95 * x[i - 1] : 0)) * this.win[i];
      const r = this.r;
      for (let lag = 0; lag <= LPC_ORDER; lag++) { let s = 0; for (let i = 0; i + lag < n; i++) s += w[i] * w[i + lag]; r[lag] = s; }
      r[0] *= 1.0001; // white-noise correction (stabilises the recursion)
      if (levinson(r, LPC_ORDER, this.a)) {
        const pk = this.envelopePeaks(fs);
        const F1 = pk.find((p) => p >= 200 && p <= 1100) ?? 0;
        const F2 = pk.find((p) => p > Math.max(F1 + 150, 550) && p <= 3000) ?? 0;
        const F3 = pk.find((p) => p > Math.max(F2 + 200, 1300) && p <= 4200) ?? 0;
        if (F1 && F2 && F3) {
          // 3-frame median: a single mis-picked peak (merged F1/F2, a missed F3) must not flash an R or L
          this.fHist.push([F1, F2, F3]);
          while (this.fHist.length > 3) this.fHist.shift();
          const med3 = (i: number) => { const v = this.fHist.map((h) => h[i]).sort((a, b) => a - b); return v[v.length >> 1]; };
          f.F1 = med3(0); f.F2 = med3(1); f.F3 = med3(2); f.fOk = true;
          // running speaker medians from clear, loud vowel frames (a slow 1-quantile tracker)
          if (level > 0.35 && f.vDip < 4) {
            const k = this.medN < 60 ? 0.08 : 0.01;
            this.medN++;
            for (const key of ['F1', 'F2', 'F3'] as const) this.med[key] += Math.sign(f[key] - this.med[key]) * k * this.med[key] * 0.25;
          }
        }
      }
    }
    if (!f.fOk) { f.F1 = 0; f.F2 = 0; f.F3 = 0; if (!voicedE) this.fHist.length = 0; }
    f.f1r = f.fOk ? f.F1 / this.med.F1 : 1;
    f.f2r = f.fOk ? f.F2 / this.med.F2 : 1;
    f.f3r = f.fOk ? f.F3 / this.med.F3 : 1;
    return f;
  }

  /** Peaks of the LPC envelope 150–4500 Hz (ascending frequency). */
  private envelopePeaks(fs: number): number[] {
    const a = this.a, N = ENV_N, fLo = 150, fHi = 4500, K = LPC_ORDER + 1;
    if (this.envFs !== fs || !this.envCos || !this.envSin) {
      // cos / sin(w·k) for every envelope point and LPC tap, per sample rate (the same values the loop computed)
      const ct = new Float64Array(N * K), st = new Float64Array(N * K);
      for (let i = 0; i < N; i++) {
        const w = (2 * Math.PI * (fLo + ((fHi - fLo) * i) / (N - 1))) / fs;
        for (let k = 0; k < K; k++) { ct[i * K + k] = Math.cos(w * k); st[i * K + k] = Math.sin(w * k); }
      }
      this.envCos = ct; this.envSin = st; this.envFs = fs;
    }
    const ct = this.envCos, st = this.envSin, mag = this.mag;
    for (let i = 0; i < N; i++) {
      let re = 0, im = 0;
      for (let k = 0, o = i * K; k < K; k++, o++) { re += a[k] * ct[o]; im -= a[k] * st[o]; }
      mag[i] = -Math.log(re * re + im * im + 1e-18);
    }
    const out: number[] = [];
    for (let i = 1; i < N - 1; i++) if (mag[i] > mag[i - 1] && mag[i] >= mag[i + 1]) {
      // parabolic interpolation
      const d = (mag[i - 1] - mag[i + 1]) / (2 * (mag[i - 1] - 2 * mag[i] + mag[i + 1]) || 1);
      out.push(fLo + ((fHi - fLo) * (i + d)) / (N - 1));
    }
    return out;
  }
}
