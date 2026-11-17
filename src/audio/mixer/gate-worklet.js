// VTube Pro audio mixer: one guest voice's noise gate + optional light hiss clean-up (AudioWorkletProcessor, the
// realtime audio thread; never the main thread). docs/VOICE.md → "Audio mixer".
//
//   voice ─► [clean-up: STFT spectral gate, optional] ─► level detector (10 ms RMS) ─► gate gain ─► out
//                                                                      │
//                                                     stats ~30 Hz ─► main thread (meters, "is talking", the camera director)
//
// Gate: opens when the level rises above the threshold, stays open while it is above (threshold − 5 dB) and for
// `hold` ms after, then fades out over `release` ms (fades in over `attack` ms). Closed = −60 dB (silent).
// Auto mode learns the noise floor = the quietest 100 ms level of the last 5 s (people breathe / pause within 5 s; a fan
// never stops), ignoring digital silence, and sets the threshold 12 dB above it. For its first 3 s it lets everything
// through (nothing is cut while it learns).
// Off = the voice passes untouched (the node still measures it, for the meters).
// Clean-up: 512-point STFT (sqrt-Hann, 50 % overlap, 10.7 ms extra delay), a per-bin noise estimate by minimum tracking,
// a soft subtraction gain floored at −14 dB (light on purpose: no "underwater" sound), smoothed over time.
//
// Self-contained on purpose (no imports): Vite copies worklet files verbatim into the build. The DSP core is exported
// so the unit tests (tools/audio_mixer_unit.ts) run exactly this code in Node.

/** The DSP core for one voice (mono). `process(input, output)` takes any block length. */
export function createGateCore(sampleRate) {
  const sr = sampleRate || 48000;
  const cfg = { mode: 'off', threshold: -45, attack: 5, hold: 200, release: 150, clean: false };
  const LEARN_S = 3;
  const CLOSED = 0.001;                         // −60 dB
  const HYST_DB = 5;
  const AUTO_MARGIN = 12;
  const aDet = 1 - Math.exp(-1 / (0.010 * sr)); // 10 ms mean-square detector (the gate)
  const aFloor = 1 - Math.exp(-1 / (0.100 * sr)); // 100 ms mean-square (the noise floor: steadier, so its minimum isn't a dip)
  let aAtt = 0, aRel = 0, holdN = 0;
  const times = () => {
    // attack = time to ~95 % open, release = time to fully shut (−60 dB): exponential fades with those lengths
    aAtt = 1 - Math.exp(-3 / (Math.max(0.5, cfg.attack) * 0.001 * sr));
    aRel = 1 - Math.exp(-6.9 / (Math.max(5, cfg.release) * 0.001 * sr));
    holdN = Math.round(Math.max(0, cfg.hold) * 0.001 * sr);
  };
  times();
  let ms = 0, msF = 0, open = true, holdLeft = 0, g = 1;
  let floor = -60, floorInit = false, age = 0;  // auto: noise floor (dBFS), seconds of audio seen
  // sliding minimum: the quietest level of each 250 ms slice, the last 20 slices (5 s)
  const SLICE_S = 0.25, SLICES = 20;
  const mins = new Float32Array(SLICES).fill(NaN);
  let slice = 0, sliceT = 0, sliceMin = Infinity, liveT = 0;
  // stats since the last take
  let sPeak = 0, sSum = 0, sPost = 0, sN = 0, sOpen = 0;

  // ---------------------------------------------------------------- clean-up (STFT spectral gate)
  const N = 512, H = 256, B = N / 2 + 1;
  const win = new Float32Array(N);
  for (let n = 0; n < N; n++) win[n] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N));
  const rev = new Uint16Array(N);
  for (let i = 0, bits = Math.log2(N); i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cosT = new Float32Array(N / 2), sinT = new Float32Array(N / 2);
  for (let i = 0; i < N / 2; i++) { cosT[i] = Math.cos((2 * Math.PI * i) / N); sinT[i] = Math.sin((2 * Math.PI * i) / N); }
  const re = new Float32Array(N), im = new Float32Array(N);
  const fifo = new Float32Array(N), fresh = new Float32Array(H), acc = new Float32Array(N), ready = new Float32Array(H);
  const noise = new Float32Array(B), smooth = new Float32Array(B), gain = new Float32Array(B).fill(1);
  let pos = 0, frames = 0;
  function fft(inv) {
    for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let s = 0; s < N; s += size) {
        for (let k = 0; k < half; k++) {
          const c = cosT[k * step], sn = inv ? sinT[k * step] : -sinT[k * step];
          const a = s + k, b = a + half;
          const tr = re[b] * c - im[b] * sn, ti = re[b] * sn + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  }
  function frame() {
    fifo.copyWithin(0, H); fifo.set(fresh, N - H);
    for (let n = 0; n < N; n++) { re[n] = fifo[n] * win[n]; im[n] = 0; }
    fft(false);
    frames++;
    for (let k = 0; k < B; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      smooth[k] = frames === 1 ? p : smooth[k] * 0.7 + p * 0.3;
      // minimum tracking: falls to the quietest recent value, creeps up ~1.2 dB/s (a voice never becomes "noise")
      if (frames === 1 || smooth[k] < noise[k]) noise[k] = smooth[k]; else noise[k] *= 1.0015;
      // (a minimum sits ~5 dB under the noise's mean power: × 3 brings the estimate back up; × 1.6 over-subtracts a little)
      let gk = 1 - (4.8 * noise[k]) / (p + 1e-20);
      if (gk < 0.2) gk = 0.2;
      gain[k] = gain[k] * 0.5 + gk * 0.5;
      re[k] *= gain[k]; im[k] *= gain[k];
      if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    }
    fft(true);
    for (let n = 0; n < N; n++) acc[n] += (re[n] / N) * win[n];
    for (let n = 0; n < H; n++) ready[n] = acc[n];   // (no subarray view: nothing allocated on the audio thread)
    acc.copyWithin(0, H); acc.fill(0, N - H);
  }
  function cleanSample(x) {
    fresh[pos] = x;
    const y = ready[pos];
    if (++pos === H) { pos = 0; frame(); }
    return y;
  }

  // ---------------------------------------------------------------- per block
  function threshold() {
    if (cfg.mode === 'manual') return cfg.threshold;
    const t = floor + AUTO_MARGIN;
    return t < -66 ? -66 : t > -24 ? -24 : t;
  }
  function process(input, output) {
    const n = output.length;
    const learning = cfg.mode === 'auto' && age < LEARN_S;
    const gating = cfg.mode !== 'off' && !learning;
    const thr = threshold();
    const openMs = Math.pow(10, thr / 10), closeMs = Math.pow(10, (thr - HYST_DB) / 10);
    let peak = sPeak, sum = 0, post = 0, opened = 0;
    for (let i = 0; i < n; i++) {
      const raw = input ? input[i] || 0 : 0;
      const ax = raw < 0 ? -raw : raw;
      if (ax > peak) peak = ax;
      sum += raw * raw;
      const x = cfg.clean ? cleanSample(raw) : raw;
      ms += aDet * (x * x - ms);
      msF += aFloor * (x * x - msF);
      if (ms > openMs || (open && ms > closeMs)) { open = true; holdLeft = holdN; }
      else if (open) { if (holdLeft > 0) holdLeft--; else open = false; }
      const target = !gating || open ? 1 : CLOSED;
      g += (target - g) * (target > g ? aAtt : aRel);
      const y = x * g;
      output[i] = y;
      post += y * y;
      if (!gating || open) opened++;
    }
    // auto: the noise floor follows the detector level once per block
    const lvl = 10 * Math.log10(msF + 1e-12);
    const dt = n / sr;
    age += dt;
    // digital silence (a muted guest, a track starting) isn't a room: skip it, and the 300 ms the 100 ms detector needs
    // to warm up again after it (its decay into the silence happens on silent blocks, so it is skipped too)
    if (sum / n < 1e-10) liveT = 0; else liveT += dt;
    if (liveT > 0.3 && lvl < sliceMin) sliceMin = lvl;
    sliceT += dt;
    if (sliceT >= SLICE_S) {
      sliceT = 0;
      mins[slice] = sliceMin === Infinity ? NaN : sliceMin; slice = (slice + 1) % SLICES; sliceMin = Infinity;
      let m = Infinity; for (let i = 0; i < SLICES; i++) if (mins[i] < m) m = mins[i];
      if (m !== Infinity) {
        if (!floorInit) { floor = m; floorInit = true; }
        else floor += (m - floor) * (m < floor ? 0.8 : 0.3);   // (per slice: down fast, up within ~1 s)
      }
    } else if (!floorInit && sliceMin !== Infinity) { floor = sliceMin; floorInit = true; }
    if (floor < -100) floor = -100; else if (floor > -10) floor = -10;
    sPeak = peak; sSum += sum; sPost += post; sN += n; sOpen += opened;
  }
  const db = (x) => (x > 1e-10 ? 10 * Math.log10(x) : -100);
  return {
    cfg,
    setCfg(c) {
      if (!c || typeof c !== 'object') return;
      if (c.mode === 'off' || c.mode === 'auto' || c.mode === 'manual') cfg.mode = c.mode;
      for (const k of ['threshold', 'attack', 'hold', 'release']) if (typeof c[k] === 'number' && Number.isFinite(c[k])) cfg[k] = c[k];
      if (typeof c.clean === 'boolean') cfg.clean = c.clean;
      // (the floor is tracked in every mode, so switching to Auto later gates at once; "Learn again" starts over:
      //  everything passes for 3 s while it listens)
      if (c.relearn) { age = 0; floorInit = false; mins.fill(NaN); sliceMin = Infinity; sliceT = 0; }
      times();
    },
    process,
    /** Numbers since the last call (dBFS): peak, rms (input), post (after clean-up + gate), open share 0..1, floor, thr. */
    take() {
      const s = { peak: sPeak > 1e-10 ? 20 * Math.log10(sPeak) : -100, rms: db(sN ? sSum / sN : 0), post: db(sN ? sPost / sN : 0), open: sN ? sOpen / sN : 1,
        gate: cfg.mode !== 'off' && !(cfg.mode === 'auto' && age < LEARN_S), learning: cfg.mode === 'auto' && age < LEARN_S, floor, thr: threshold(), clip: sPeak >= 0.966 };
      sPeak = 0; sSum = 0; sPost = 0; sN = 0; sOpen = 0;
      return s;
    },
    get open() { return open || cfg.mode === 'off' || (cfg.mode === 'auto' && age < LEARN_S); },
    get floor() { return floor; },
    get threshold() { return threshold(); },
  };
}

// ---------------------------------------------------------------- the processor (only inside an AudioWorklet)
if (typeof registerProcessor === 'function' && typeof AudioWorkletProcessor !== 'undefined') {
  const STAT_EVERY = 1600;   // samples (~33 ms at 48 kHz)
  class MixGate extends AudioWorkletProcessor {
    constructor(o) {
      super();
      // eslint-disable-next-line no-undef
      this.core = createGateCore(sampleRate);
      this.core.setCfg(o && o.processorOptions && o.processorOptions.cfg);
      this.mono = new Float32Array(128);
      this.n = 0;
      this.alive = true;
      this.port.onmessage = (e) => { const d = e.data || {}; if (d.cfg) this.core.setCfg(d.cfg); if (d.bye) this.alive = false; };
    }
    process(inputs, outputs) {
      const inp = inputs[0] || [], out = outputs[0] || [];
      const len = out[0] ? out[0].length : 128;
      if (this.mono.length !== len) this.mono = new Float32Array(len);
      let src = null;
      if (inp.length === 1) src = inp[0];
      else if (inp.length > 1) { const m = this.mono; m.fill(0); for (let c = 0; c < inp.length; c++) { const ch = inp[c]; for (let i = 0; i < len; i++) m[i] += ch[i] / inp.length; } src = m; }
      const o0 = out[0] || new Float32Array(len);
      this.core.process(src, o0);
      for (let c = 1; c < out.length; c++) out[c].set(o0);
      this.n += len;
      if (this.n >= STAT_EVERY) { this.n = 0; this.port.postMessage(this.core.take()); }
      return this.alive;
    }
  }
  registerProcessor('vtp-mix-gate', MixGate);
}
