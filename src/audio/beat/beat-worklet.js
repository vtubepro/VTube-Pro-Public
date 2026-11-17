// Beat feed (BeatEngine v8 feed, 15 channels) — keep in sync; do not retune here.
/* ===========================================================================
   beat-worklet.js — AudioWorkletProcessor that extracts beat-detection
   features ON THE AUDIO THREAD.

   Why: the previous pipeline polled an AnalyserNode from the dashboard tab's
   main thread with setTimeout. Main-thread timers jitter by tens of ms under
   UI load and are throttled to ~1 Hz when the tab is backgrounded — which is
   exactly when a streamer minimises the dashboard mid-set. Onset timing was
   garbage precisely when it mattered.

   This worklet (v2):
     - runs on the realtime audio thread (never throttled, never jittered),
     - band-splits the signal with cascaded biquad bandpass filters and
       accumulates RMS per band over ~10.7 ms hops (512 samples @ 48 kHz,
       scaled with the device rate so 96/192 kHz interfaces behave the same),
     - tracks a kick TRANSIENT: envelope high-pass of the low band plus the
       kick-click band (distorted hardcore pegs low-band RMS — the HP envelope
       still spikes on the beater hit),
     - NEW: runs a 1024-point STFT per hop and computes SUPERFLUX
       (Böck & Widmer 2013): log-magnitude spectral flux against a
       max-filtered frame μ hops back. This is the onset detection function
       the state-space beat tracker in beatengine.js consumes. It is sharp on
       percussive attacks and nearly blind to vibrato / sustained tones —
       a far better beat cue than RMS envelope differences.
     - posts batches of hops with their exact audio-clock timestamps.

   Hop channels (nBands = 15):
     0 kick RMS    1 body RMS    2 lowMid RMS   3 mid RMS
     4 click RMS   5 high RMS    6 kickHp (envelope-HP transient)
     7 superflux (all bands)      8 superflux low  (< 220 Hz)
     9 superflux mid (220–2.5k)  10 superflux high (> 2.5 kHz)
    11 isolated low-band envelope transient (no snare/click contribution)
    12 isolated presence attack   13 midrange spectral flatness
    14 isolated snare-body envelope transient
   Channels 0–6 are byte-identical to v1 so an old engine still works.
   =========================================================================== */

class Biquad {
  // RBJ-cookbook bandpass (constant skirt gain, peak = Q)
  constructor(sr, fc, q) {
    const w0 = 2 * Math.PI * fc / sr;
    const alpha = Math.sin(w0) / (2 * q);
    const cosW0 = Math.cos(w0);
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b1 = 0;
    this.b2 = -alpha / a0;
    this.a1 = (-2 * cosW0) / a0;
    this.a2 = (1 - alpha) / a0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }
  step(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
            - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/* Iterative radix-2 complex FFT, real input. N must be a power of two. */
class FFT {
  constructor(n) {
    this.n = n;
    this.rev = new Uint32Array(n);
    let bits = 0; while ((1 << bits) < n) bits++;
    for (let i = 0; i < n; i++) {
      let r = 0, x = i;
      for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      this.rev[i] = r;
    }
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos(-2 * Math.PI * i / n);
      this.sin[i] = Math.sin(-2 * Math.PI * i / n);
    }
    this.re = new Float32Array(n);
    this.im = new Float32Array(n);
  }
  // input: Float32Array(n) real samples (already windowed). Output in this.re/this.im.
  forward(input) {
    const n = this.n, re = this.re, im = this.im, rev = this.rev;
    for (let i = 0; i < n; i++) { re[i] = input[rev[i]]; im[i] = 0; }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = this.cos[t], wi = this.sin[t];
          const i0 = start + k, i1 = i0 + half;
          const xr = re[i1] * wr - im[i1] * wi;
          const xi = re[i1] * wi + im[i1] * wr;
          re[i1] = re[i0] - xr; im[i1] = im[i0] - xi;
          re[i0] += xr;         im[i0] += xi;
        }
      }
    }
  }
}

const BANDS = [
  [48, 90],      // kick fundamental (rumble wall lives here — HP'd below)
  [90, 190],     // 808 / bass body
  [190, 520],    // low mids / kick punch
  [520, 1700],   // melody / leads
  [1700, 5200],  // kick CLICK / snare crack (distorted punch lives here)
  [5200, 12000]  // hats / air
];

// Hop ≈ 10.7 ms and STFT window ≈ 21 ms (47 Hz bins) at ANY device rate.
// The dashboard's AudioContext follows the output device, and festival
// interfaces often run 96 or 192 kHz; a fixed 512/1024 there would mean a
// 2.7 ms hop, 187 Hz bins (the whole 90–220 Hz kick group in one bin) and 4×
// the CPU. 512/1024 @ 44.1–48 kHz, 1024/2048 @ 88.2–96 kHz, 2048/4096 @ 176.4–192 kHz.
const SR_MUL = Math.max(1, Math.round(sampleRate / 48000));
const HOP = 512 * (SR_MUL >= 4 ? 4 : SR_MUL >= 2 ? 2 : 1);   // samples per hop
const BATCH = 1;          // one hop per message: no 32 ms batching delay
const N_RMS = 6;
const N_CHAN = 15;        // previous 11 channels + isolated low-band transient

const FFT_N = HOP * 2;    // STFT window (2 hops, 50 % overlap)
const SF_BANDS = 36;      // log-spaced superflux bands
// Bands start at 90 Hz: below that the 47 Hz FFT resolution is 1 bin/band and
// a kick's pitch sweep settling into the sub bin re-fires as a fake onset.
const SF_F_LO = 90, SF_F_HI = 16000;
// Reference = element-wise MAX over the previous SF_MU frames (each ±1-band
// max-filtered). A single past frame lets the random band-to-band wobble of a
// decaying noise burst (snare tail, riser) exceed it every few frames; the
// max over three frames does not, while a true attack still jumps clear.
const SF_MU = 3;
// Band value = SUM of bin magnitudes (amplitude units, full-scale sine ≈ 1),
// not the mean: a snare or hat spreads its energy over hundreds of bins and
// with a mean it vanishes next to a kick's single loud bin. log1p(mul·S)
// with mul=300 puts a −25 dB noise burst at ~0.6 and a full-scale sine at
// ~5.6 — hats stay visible but subordinate, which is what beat tracking wants.
const SF_LOG_MUL = 300;

class BeatFeedProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = sampleRate;
    // Two cascaded biquads per band for usable skirt steepness (4th order).
    this.filters = BANDS.map(([lo, hi]) => {
      const fc = Math.sqrt(lo * hi);
      const q = fc / (hi - lo);
      return [new Biquad(sr, fc, q), new Biquad(sr, fc, q)];
    });
    this.nRms = N_RMS;
    this.nBands = N_CHAN;
    this.acc = new Float64Array(this.nRms);  // sum of squares, current hop
    this.hopFill = 0;
    this.totalSamples = 0;

    // Envelope HP of kick (band 0) + click (band 4): rumble is the slow
    // floor, the beater attack is the fast bump. Time constants at 48 kHz:
    //   kick fast ~3.5 ms, kick slow ~55 ms (rumble AM)
    //   click fast ~2 ms,  click slow ~22 ms
    this.kickFast = 0; this.kickSlow = 0;
    this.clickFast = 0; this.clickSlow = 0;
    this.bodyFast = 0; this.bodySlow = 0; this.bodyHpAcc = 0;
    this.kickHpAcc = 0;
    this.clickHpAcc = 0;
    this.aKickFast  = 1 - Math.exp(-1 / (0.0035 * sr));
    this.aKickSlow  = 1 - Math.exp(-1 / (0.055  * sr));
    this.aClickFast = 1 - Math.exp(-1 / (0.0020 * sr));
    this.aClickSlow = 1 - Math.exp(-1 / (0.022  * sr));

    // ---- STFT / superflux state ----
    this.fft = new FFT(FFT_N);
    this.ring = new Float32Array(FFT_N);     // last FFT_N mono samples
    this.ringPos = 0;
    this.frame = new Float32Array(FFT_N);
    this.window = new Float32Array(FFT_N);
    for (let i = 0; i < FFT_N; i++) this.window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FFT_N);
    const binHz = sr / FFT_N;
    const nBins = FFT_N / 2;
    // Log bands may share FFT bins: low frequencies have coarser resolution
    // than the log spacing. Forcing disjoint bins shifts "bass" into the mids.
    this.sfLo = new Int32Array(SF_BANDS);
    this.sfHi = new Int32Array(SF_BANDS);
    this.sfGroup = new Uint8Array(SF_BANDS);   // 0 low, 1 mid, 2 high
    const fHi = Math.min(SF_F_HI, sr * 0.47);
    for (let b = 0; b < SF_BANDS; b++) {
      const e0 = SF_F_LO * Math.pow(fHi / SF_F_LO, b / SF_BANDS);
      const e1 = SF_F_LO * Math.pow(fHi / SF_F_LO, (b + 1) / SF_BANDS);
      let lo = Math.max(1, Math.round(e0 / binHz));
      let hi = Math.max(lo, Math.round(e1 / binHz) - 1);
      if (hi < lo) hi = lo;
      hi = Math.min(nBins - 1, hi);
      this.sfLo[b] = lo; this.sfHi[b] = hi;
      const fc = Math.sqrt(e0 * e1);
      this.sfGroup[b] = fc < 220 ? 0 : fc < 2500 ? 1 : 2;
    }
    this.sfGroupCount = [0, 0, 0];
    for (let b = 0; b < SF_BANDS; b++) this.sfGroupCount[this.sfGroup[b]]++;
    // ring of the last (SF_MU + 1) log-band frames
    this.logHist = [];
    for (let k = 0; k <= SF_MU; k++) this.logHist.push(new Float32Array(SF_BANDS));
    this.logIdx = 0;
    this.logFilled = 0;
    this.sfOut = new Float32Array(4);

    this.batch = new Float32Array(BATCH * this.nBands);
    this.batchT0 = 0;   // audio-clock seconds of the END of the first hop in batch
    this.batchFill = 0;
  }

  // Compute superflux for the hop that just ended (ring holds the last FFT_N samples).
  _superflux() {
    const N = FFT_N, ring = this.ring, frame = this.frame, w = this.window;
    let p = this.ringPos;                    // oldest sample index
    for (let i = 0; i < N; i++) { frame[i] = ring[p] * w[i]; p++; if (p === N) p = 0; }
    this.fft.forward(frame);
    const re = this.fft.re, im = this.fft.im;

    // Noise-like snare tails occupy many bins; a pitched lead occupies a few.
    // Measure only the mids so a high hat cannot hide a tonal midrange.
    let sumPower = 0, sumLog = 0, count = 0;
    for (let k = Math.ceil(500 * N / sampleRate); k <= Math.floor(5000 * N / sampleRate); k++) {
      const power = re[k] * re[k] + im[k] * im[k] + 1e-18;
      sumPower += power; sumLog += Math.log(power); count++;
    }
    this.noiseFlatness = sumPower > 1e-12 ? Math.exp(sumLog / count) / (sumPower / count) : 0;
    const cur = this.logHist[this.logIdx];
    for (let b = 0; b < SF_BANDS; b++) {
      let s = 0;
      const lo = this.sfLo[b], hi = this.sfHi[b];
      for (let k = lo; k <= hi; k++) s += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      const mag = s / (N * 0.25);                    // amplitude units (sine A → A)
      cur[b] = Math.log1p(mag * SF_LOG_MUL);
    }

    const out = this.sfOut; out[0] = out[1] = out[2] = out[3] = 0;
    if (this.logFilled >= SF_MU) {
      const H = this.logHist.length;
      for (let b = 0; b < SF_BANDS; b++) {
        // max over the previous μ frames and ±1 neighbouring band
        let m = -Infinity;
        for (let k = 1; k <= SF_MU; k++) {
          const ref = this.logHist[(this.logIdx - k + H) % H];
          if (ref[b] > m) m = ref[b];
          if (b > 0 && ref[b - 1] > m) m = ref[b - 1];
          if (b < SF_BANDS - 1 && ref[b + 1] > m) m = ref[b + 1];
        }
        const d = cur[b] - m;
        if (d > 0) { out[0] += d; out[1 + this.sfGroup[b]] += d; }
      }
      out[0] /= SF_BANDS;
      for (let g = 0; g < 3; g++) if (this.sfGroupCount[g]) out[1 + g] /= this.sfGroupCount[g];
    }
    this.logIdx = (this.logIdx + 1) % this.logHist.length;
    if (this.logFilled < this.logHist.length) this.logFilled++;
    return out;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    // mix down to mono
    const ch0 = input[0];
    const ch1 = input.length > 1 ? input[1] : null;
    const n = ch0.length;
    const filters = this.filters;
    const acc = this.acc;

    for (let i = 0; i < n; i++) {
      const x = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
      this.ring[this.ringPos] = x;
      this.ringPos++; if (this.ringPos === FFT_N) this.ringPos = 0;

      let yKick = 0, yClick = 0, yBody = 0;
      for (let b = 0; b < this.nRms; b++) {
        const f = filters[b];
        const y = f[1].step(f[0].step(x));
        acc[b] += y * y;
        if (b === 0) yKick = y;
        else if (b === 4) yClick = y;
        else if (b === 2) yBody = y;
      }

      const kAbs = yKick < 0 ? -yKick : yKick;
      this.kickFast += (kAbs - this.kickFast) * this.aKickFast;
      this.kickSlow += (kAbs - this.kickSlow) * this.aKickSlow;
      const kHp = this.kickFast - this.kickSlow * 1.10;
      if (kHp > 0) this.kickHpAcc += kHp * kHp;

      const bAbs = Math.abs(yBody);
      this.bodyFast += (bAbs - this.bodyFast) * this.aKickFast;
      this.bodySlow += (bAbs - this.bodySlow) * this.aKickSlow;
      const bHp = Math.max(0, this.bodyFast - this.bodySlow * 1.1);
      this.bodyHpAcc += bHp * bHp;
      const cAbs = yClick < 0 ? -yClick : yClick;
      this.clickFast += (cAbs - this.clickFast) * this.aClickFast;
      this.clickSlow += (cAbs - this.clickSlow) * this.aClickSlow;
      const cHp = this.clickFast - this.clickSlow * 1.08;
      if (cHp > 0) this.clickHpAcc += cHp * cHp;

      this.hopFill++;
      this.totalSamples++;

      if (this.hopFill === HOP) {
        const base = this.batchFill * this.nBands;
        for (let b = 0; b < this.nRms; b++) {
          this.batch[base + b] = Math.sqrt(acc[b] / HOP);   // RMS
          acc[b] = 0;
        }
        // Channel 6: rumble-rejected kick transient (low-band HP + click HP).
        this.batch[base + 6] = Math.sqrt((this.kickHpAcc + 1.55 * this.clickHpAcc) / HOP);
        this.batch[base + 11] = Math.sqrt(this.kickHpAcc / HOP);
        this.batch[base + 14] = Math.sqrt(this.bodyHpAcc / HOP);
        this.bodyHpAcc = 0;
        this.batch[base + 12] = Math.sqrt(this.clickHpAcc / HOP);
        this.kickHpAcc = 0;
        this.clickHpAcc = 0;
        // Channels 7–10: superflux (all / low / mid / high)
        const sf = this._superflux();
        this.batch[base + 7]  = sf[0];
        this.batch[base + 8]  = sf[1];
        this.batch[base + 9]  = sf[2];
        this.batch[base + 10] = sf[3];
        this.batch[base + 13] = this.noiseFlatness;

        if (this.batchFill === 0) {
          this.batchT0 = this.totalSamples / sampleRate;
        }
        this.hopFill = 0;
        this.batchFill++;

        if (this.batchFill === BATCH) {
          this.port.postMessage({
            t0: this.batchT0,                    // audio seconds, end of hop 0
            hopSec: HOP / sampleRate,
            nBands: this.nBands,
            hops: Array.from(this.batch)
          });
          this.batchFill = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('beat-feed', BeatFeedProcessor);
