// VTube Pro voice front-end — AudioWorkletProcessor (runs on the realtime audio thread, never the main thread).
//
//   mic ─► high-pass 80 Hz (4th-order) ─► RNNoise (48 kHz, 10 ms frames) ─► voice gate × level normaliser ─► out
//                     │                         │ per-frame VAD                  ▲
//                     └─► 16 kHz decimator ─► Silero VAD (worker, via MessagePort) ─┘
//
// The OUTPUT is what the existing lip-sync analysis (AnalyserNode → SpeechAnalyzer) reads: a denoised signal,
// normalised so quiet and loud speakers look alike, gated to a constant quiet floor whenever it is not the
// performer talking (keyboard, mouse, fans, hum, breathing, music/TV, quieter background voices).
//
// Latency: RNNoise delays its output by one 10 ms frame and the 128-sample render quantum needs ≤ 9.3 ms of
// buffering → ≈ 19 ms added. The gate decides on the UNDELAYED input (RNNoise's own VAD + level), so it gets
// that 10 ms as look-ahead and opens before the first syllable reaches the output; Silero (32 ms windows,
// ~0.4 ms inference in a worker) only confirms / cancels a provisional opening and holds the gate through words.
//
// Self-contained on purpose (no imports): Vite copies worklet files verbatim into the build.
// Also loaded by the offline harness (Node vm) — see tools/eval_voice.ts — so what is scored is what runs.

const FRAME = 480;          // RNNoise frame (10 ms @ 48 kHz)
const SIL_N = 512;          // Silero window @ 16 kHz (32 ms)
const DEC = 3;              // 48 kHz → 16 kHz
const dbOf = (ms) => 10 * Math.log10(ms + 1e-12);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/** RBJ 2nd-order high-pass section. */
class HP2 {
  constructor(sr, fc, q) {
    const w = (2 * Math.PI * fc) / sr, al = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + al;
    this.b0 = (1 + c) / 2 / a0; this.b1 = -(1 + c) / a0; this.b2 = (1 + c) / 2 / a0;
    this.a1 = (-2 * c) / a0; this.a2 = (1 - al) / a0;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
  step(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/** Instantiate @jitsi/rnnoise-wasm's rnnoise.wasm directly (its emscripten glue needs window/setTimeout). */
function makeRnnoise(bytes) {
  const mod = new WebAssembly.Module(bytes);
  let mem = null;
  const imports = {
    a: {
      // emscripten_resize_heap
      a: (req) => { try { const need = (req >>> 0) - mem.buffer.byteLength; if (need > 0) mem.grow(Math.ceil(need / 65536)); return 1; } catch { return 0; } },
      // emscripten_memcpy_big
      b: (d, s, n) => { new Uint8Array(mem.buffer).copyWithin(d, s, s + n); },
    },
  };
  const ex = new WebAssembly.Instance(mod, imports).exports;
  mem = ex.c;
  ex.d(); // static constructors
  const st = ex.f(0);
  const pin = ex.g(FRAME * 4), pout = ex.g(FRAME * 4);
  return {
    /** in/out: 480 samples in int16 scale. Returns RNNoise's voice probability for this input frame. */
    process(inp, out) {
      new Float32Array(mem.buffer, pin, FRAME).set(inp);
      const v = ex.j(st, pout, pin);
      out.set(new Float32Array(mem.buffer, pout, FRAME));
      return v;
    },
    destroy() { try { ex.h(st); ex.i(pin); ex.i(pout); } catch { /* ignore */ } },
  };
}

/** Half-band-ish low-pass (windowed sinc, 7 kHz @ 48 kHz) for the 16 kHz Silero feed. */
function makeDecimFir() {
  const N = 47, fc = 7000 / 48000, h = new Float32Array(N);
  let s = 0;
  for (let i = 0; i < N; i++) {
    const m = i - (N - 1) / 2;
    const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (N - 1));
    h[i] = sinc * w; s += h[i];
  }
  for (let i = 0; i < N; i++) h[i] /= s;
  return h;
}

/**
 * Fricative detector on the RAW (high-passed, pre-RNNoise) signal. RNNoise treats unvoiced frication as noise and
 * Silero doesn't call a lone "fffff" speech, so F / V / S / Z / SH / TH are found here in parallel, from the
 * spectrum's shape: hiss above ~2 kHz that dominates the band below it (unvoiced) or rides on voicing with far more
 * energy above 5.5 kHz than any vowel has (voiced V / Z / ZH); continuous (keyboard clicks are single spiky frames);
 * clearly above its own adaptive floor (fans, white noise). Class by shape: S / SH are peaked (a groove jet on the
 * teeth; S peaks above ~4.5 kHz, SH lower), F / V / TH are flat and weak.
 */
class FricDetector {
  constructor() {
    const N = 512;
    this.N = N;
    this.win = new Float32Array(N);
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    this.cos = new Float32Array(N / 2); this.sin = new Float32Array(N / 2);
    for (let i = 0; i < N / 2; i++) { this.cos[i] = Math.cos((2 * Math.PI * i) / N); this.sin[i] = -Math.sin((2 * Math.PI * i) / N); }
    this.rev = new Uint16Array(N);
    for (let i = 0, j = 0; i < N; i++) { this.rev[i] = j; let bit = N >> 1; while (j & bit) { j ^= bit; bit >>= 1; } j |= bit; }
    this.re = new Float32Array(N); this.im = new Float32Array(N); this.pw = new Float32Array(N / 2 + 1);
    this.buf = new Float32Array(N);
    this.hiFloor = NaN; this.onFor = 0; this.run = 0; this.on = false; this.off = 0; this.conf = 0;
    this.pF = 0; this.pTH = 0; this.pS = 0; this.pSH = 0; this.voiced = 0;
    this.dbg = { hiDb: -120, hiSnr: 0, shape: 0, like: 0, peaked: 0, peakHz: 0, crest: 0, per: 0 };
  }
  fft() {
    const N = this.N, re = this.re, im = this.im;
    for (let i = 0; i < N; i++) { const j = this.rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let len = 2; len <= N; len <<= 1) {
      const half = len >> 1, step = N / len;
      for (let i = 0; i < N; i += len) for (let k = 0; k < half; k++) {
        const c = this.cos[k * step], sn = this.sin[k * step], a = i + k, b = a + half;
        const tr = re[b] * c - im[b] * sn, ti = re[b] * sn + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
  band(a, b) { let s = 0; for (let k = a; k <= b; k++) s += this.pw[k]; return dbOf(s); }
  /**
   * frame: newest 480 raw samples; prevTail: the 32 before them; d16/n16: 16 kHz history ring for voicing.
   * ctx: { speechRecent, known, ref, rawFloor, vad, p, sens }
   */
  step(frame, prevTail, d16, d16pos, ctx) {
    const N = this.N, buf = this.buf;
    buf.set(prevTail.subarray(prevTail.length - (N - FRAME)), 0); buf.set(frame, N - FRAME);
    let e = 0, pk = 0;
    for (let i = 0; i < FRAME; i++) { const v = frame[i] * frame[i]; e += v; if (v > pk) pk = v; }
    const crest = pk / (e / FRAME + 1e-12);
    for (let i = 0; i < N; i++) { this.re[i] = buf[i] * this.win[i]; this.im[i] = 0; }
    this.fft();
    for (let k = 0; k <= N / 2; k++) this.pw[k] = (this.re[k] * this.re[k] + this.im[k] * this.im[k]) / (N * N);
    // bins are 93.75 Hz wide
    const loDb = this.band(1, 4), midDb = this.band(5, 21), hiDb = this.band(22, 170), hfDb = this.band(59, 170);
    // spectral peak in 2–12 kHz (5-bin smoothed) and how far it stands above that region's mean
    let best = -1e9, bestK = 22, sumDb = 0, n = 0;
    for (let k = 22; k <= 128; k++) {
      const sm = (this.pw[k - 2] + this.pw[k - 1] + this.pw[k] + this.pw[k + 1] + this.pw[k + 2]) / 5;
      const d = dbOf(sm); sumDb += d; n++;
      if (d > best) { best = d; bestK = k; }
    }
    const peaked = best - sumDb / n, peakHz = bestK * 93.75;
    // voicing: normalised autocorrelation of the (≈1 kHz low-passed) 16 kHz feed over 80–500 Hz lags
    const L = 320, R = d16.length;
    let per = 0;
    {
      const x = this.x16 || (this.x16 = new Float32Array(L));
      let y = 0;
      for (let i = 0; i < L; i++) { y += 0.33 * (d16[(d16pos - L + i + R) % R] - y); x[i] = y; }
      for (let lag = 32; lag <= 200; lag += 2) {
        let sxy = 0, sxx = 0, syy = 0;
        for (let i = 0; i + lag < L; i++) { const a = x[i], b = x[i + lag]; sxy += a * b; sxx += a * a; syy += b * b; }
        const r = sxy / Math.sqrt(sxx * syy + 1e-20);
        if (r > per) per = r;
      }
    }
    const voiced = per > 0.55 && loDb > ctx.rawFloor + 10;
    const sens = ctx.sens;
    const hiSnr = hiDb - this.hiFloor;
    // unvoiced: hiss dominates everything below 2 kHz (voicing / F1 absent) AND is either broadband up to 10 kHz+
    // (F / TH: flat) or a sharp sibilant peak (S / SH). Breath and "hhh" aspiration fall off above ~3 kHz.
    const loMid = dbSum(loDb, midDb), hfRatio = hfDb - this.band(22, 58);
    const broad = Math.max(ss(-7, -2, hfRatio), ss(8, 12, peaked));
    const unv = voiced ? 0 : ss(3, 8, hiDb - loMid) * broad;
    const vcd = voiced ? ss(-30, -18, hfDb - loMid) : 0;                                // noise at 5.5 kHz+ riding on voicing
    const shape = Math.max(unv, vcd);
    const like = shape * ss(5 - sens * 3, 12 - sens * 3, hiSnr) * ss(60, 25, crest);   // clicks are spiky single frames
    this.run = like > 0.5 ? this.run + 1 : like < 0.3 ? 0 : this.run;
    // context: inside / right after words anything fricative-shaped counts; a STANDALONE held sound needs 40 ms of
    // continuous hiss, near-mic loudness (not TV / room noise) and, when voiced, a voice-like VAD reading
    const loudOk = ctx.known ? hiDb > ctx.ref - (32 + sens * 8) : hiDb > ctx.rawFloor + 18;
    const alone = this.run >= 4 && hiSnr > 12 - sens * 4 && loudOk && (!voiced || ctx.vad > 0.4 || ctx.p > 0.3);
    const inWord = ctx.speechRecent && this.run >= 1;
    if (!this.on) { if (inWord || alone) { this.on = true; this.off = 0; } }
    else { this.off = like > 0.3 ? 0 : this.off + 1; if (this.off > 2) this.on = false; }
    // floor: fast down, slow up, frozen while a fricative is on (a held "sssss" mustn't become the floor)
    // (…but nobody holds one for 3 s: a steady hiss that long is the room, learn it)
    this.onFor = this.on ? this.onFor + 1 : 0;
    if (!(this.hiFloor > -200)) this.hiFloor = hiDb;
    this.hiFloor += (hiDb < this.hiFloor ? 0.25 : this.on && this.onFor < 300 ? 0 : this.onFor >= 300 ? 0.02 : 0.002) * (hiDb - this.hiFloor);
    // class by shape (+ loudness: sibilants are strong, lip/teeth friction is weak)
    // loudness vs the performer's own level is the robust cue (S / SH ≈ 15–20 dB under the vowels, F / TH ≈ 30+);
    // peakedness helps when the level isn't learnt yet
    const loud = ctx.known ? ss(-32, -21, hiDb - ctx.ref) : 0.5;
    const sib = clamp(0.35 * ss(5, 11, peaked) + 0.65 * loud, 0, 1);
    const hiPk = ss(3700, 4700, peakHz);
    const k = 0.35;
    this.pS += k * (sib * hiPk - this.pS);
    this.pSH += k * (sib * (1 - hiPk) - this.pSH);
    this.pF += k * ((1 - sib) * 0.75 - this.pF);
    this.pTH += k * ((1 - sib) * 0.25 - this.pTH);
    this.voiced += 0.3 * ((voiced ? 1 : 0) - this.voiced);
    const target = this.on ? clamp(0.4 + like, 0, 1) : 0;
    this.conf += (target - this.conf) * (target > this.conf ? 0.6 : 0.35);
    this.dbg.hiDb = hiDb; this.dbg.hiSnr = hiSnr; this.dbg.shape = shape; this.dbg.like = like; this.dbg.peaked = peaked; this.dbg.peakHz = peakHz; this.dbg.crest = crest; this.dbg.per = per; this.dbg.hf = hfRatio; this.dbg.hm = hiDb - loMid;
    return this.on;
  }
}
const ss = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const dbSum = (a, b) => 10 * Math.log10(10 ** (a / 10) + 10 ** (b / 10));

/** Filter presets. `resid`: fraction of the (high-passed) original mixed back under RNNoise so quiet F/S hiss survives. */
const MODES = {
  standard: { resid: 0.12, vadOn: 0.55, pOn: 0.5, pHold: 0.3, cancelP: 0.2, confirmN: 2, bgRange: 6 },
  strong: { resid: 0.0, vadOn: 0.7, pOn: 0.6, pHold: 0.4, cancelP: 0.3, confirmN: 2, bgRange: 4 },
};

class VoiceFrontEnd extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.sr = sampleRate;
    this.ok48 = Math.abs(this.sr - 48000) < 1;
    this.hp = [new HP2(this.sr, 80, 0.5412), new HP2(this.sr, 80, 1.3066)]; // 4th-order Butterworth
    this.rnn = null;
    this.err = '';
    if (o.rnnoise && this.ok48) {
      try { this.rnn = makeRnnoise(o.rnnoise); } catch (e) { this.err = 'rnnoise: ' + ((e && e.message) || e); }
    }
    this.cfg = {
      mode: 'standard', sensitivity: 0.5, ignoreBg: true, bypassGate: false, targetDb: -20, floorDb: -58,
      ...(o.cfg || {}),
    };
    // frame buffers
    this.inBuf = new Float32Array(FRAME); this.inN = 0;
    this.i16 = new Float32Array(FRAME); this.o16 = new Float32Array(FRAME);
    this.hpHist = [new Float32Array(FRAME), new Float32Array(FRAME)]; // hp frames k-1, k-2 (aligned with RNNoise output)
    // output FIFO (prefilled so a 480-sample frame cadence never underruns a 128-sample quantum)
    this.fifo = new Float32Array(FRAME * 8); this.fr = 0; this.fw = 0; this.fn = 0;
    // prefilled with the quiet floor, never digital silence: an all-zero start drags the analyser's adaptive noise
    // floor to −100 dB and every sound afterwards would read as loud speech for seconds
    this.seed = 12345;
    const pre = FRAME - 32, fa = 10 ** (this.cfg.floorDb / 20) * Math.sqrt(12);
    for (let i = 0; i < pre; i++) this.push(fa * this.rand());
    // silero feed
    this.fir = makeDecimFir();
    this.firBuf = new Float32Array(this.fir.length * 2); this.firPos = 0; this.decPhase = 0;
    this.sil = new Float32Array(SIL_N * 2); this.silN = 0;
    this.d16 = new Float32Array(400); this.d16pos = 0; // 16 kHz history for the fricative detector's voicing test
    this.fric = new FricDetector(); this.sinceSpeech = 999; this.fricOn = false;
    this.hop = o.silHop || 512;
    this.silSeq = 0;
    // neural visemes (optional, cfg.nv): the same 16 kHz stream in 10 ms chunks to the VAD worker, each with the voice
    // gate at that instant (g: 1 = open or fricative), plus one 'nvWake' the moment the gate opens. Only the worker's
    // opt-in idle skip uses them (it stops the model after ~0.5 s of g = 0); by default the model always runs.
    this.nvBuf = new Float32Array(160); this.nvN = 0; this.nvSeq = 0; this.gWas = false;
    this.vadPort = null;
    this.p = 0; this.pAt = -1; this.pSeq = -1; this.pSince = []; this.cancels = 0;
    this.vadAlive = false;
    // gate + level state
    this.floorDb = -70; this.rawFloorDb = -70; this.ref = NaN; this.gainDb = 0; this.floorAtRef = null; this.floorDropFor = 0; this.rejected = 0;
    this.open = false; this.prov = false; this.openAt = 0; this.quietFor = 0; this.g = 0;
    this.vadS = 0; this.frameIdx = 0; this.lastCand = 0; this.gf = 0;
    this.seed = 12345;
    this.cal = null;
    this.stat = { raw: -100, dn: -100, out: -100, vad: 0, p: 0, gate: 0, ref: -100, floor: -100, prov: 0, ms: 0 };
    this.statEvery = 2; this.statCount = 0;
    // warm start from the last session (the app persists the learned speaker level + room floor)
    if (Number.isFinite(this.cfg.initRef)) { this.ref = this.cfg.initRef; this.gainDb = clamp(this.cfg.targetDb - this.ref, -12, 30); }
    if (Number.isFinite(this.cfg.initRawFloor)) this.floorAtRef = this.cfg.initRawFloor;
    if (Number.isFinite(this.cfg.initRawFloor)) this.rawFloorDb = this.cfg.initRawFloor;
    this.port.onmessage = (e) => this.onMsg(e.data);
  }

  onMsg(d) {
    if (!d) return;
    if (d.type === 'cfg') Object.assign(this.cfg, d.cfg);
    else if (d.type === 'vadPort') {
      this.vadPort = d.port;
      this.vadPort.onmessage = (e) => this.onVad(e.data);
    } else if (d.type === 'calibrate') this.cal = { n: Math.round((d.seconds || 3) * 100), raw: [], dn: [], vad: [], p: [] };
    else if (d.type === 'state') {
      if (d.resetRef) { this.ref = NaN; this.floorAtRef = null; }
      if (Number.isFinite(d.ref)) this.ref = d.ref;
      if (Number.isFinite(d.rawFloor)) this.rawFloorDb = d.rawFloor;
    }
  }

  onVad(m) {
    if (!m || m.type !== 'p') return;
    this.vadAlive = true;
    this.p = m.p; this.pSeq = m.seq; this.pAt = this.frameIdx;
    if (this.open && this.pSince.length < 16) this.pSince.push(m.p);
  }

  push(x) { this.fifo[this.fw] = x; this.fw = (this.fw + 1) % this.fifo.length; this.fn++; }

  rand() { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 4294967296 - 0.5; }

  feedSilero(x) {
    // 47-tap FIR + keep every 3rd sample
    const L = this.fir.length;
    this.firBuf[this.firPos] = x; this.firBuf[this.firPos + L] = x;
    this.firPos = (this.firPos + 1) % L;
    if (++this.decPhase < DEC) return;
    this.decPhase = 0;
    let y = 0;
    const b = this.firBuf, h = this.fir, p = this.firPos;
    for (let i = 0; i < L; i++) y += h[i] * b[p + i];
    this.sil[this.silN++] = y;
    this.d16[this.d16pos] = y; this.d16pos = (this.d16pos + 1) % this.d16.length;
    if ((this.cfg.nv || this.cfg.a2f || this.cfg.cap) && this.vadPort) {
      this.nvBuf[this.nvN++] = y;
      if (this.nvN === 160) { const c = this.nvBuf.slice(); this.vadPort.postMessage({ type: 'pcm', seq: this.nvSeq++, x: c, g: this.open || this.fricOn ? 1 : 0 }, [c.buffer]); this.nvN = 0; }
    }
    if (this.silN >= SIL_N) {
      if (this.vadPort) {
        const chunk = this.sil.slice(0, SIL_N);
        this.vadPort.postMessage({ type: 'chunk', seq: this.silSeq++, x: chunk }, [chunk.buffer]);
      }
      // keep the last SIL_N - hop samples for the next (overlapping) window
      const keep = SIL_N - this.hop;
      if (keep > 0) this.sil.copyWithin(0, SIL_N - keep, SIL_N);
      this.silN = keep;
    }
  }

  frame() {
    const c = this.cfg, M = MODES[c.mode] || MODES.standard;
    const sens = clamp(c.sensitivity, 0, 1); // 0 = strict, 1 = lets everything voice-like through
    const hp = this.inBuf;
    let e = 0;
    for (let i = 0; i < FRAME; i++) e += hp[i] * hp[i];
    const rawDb = dbOf(e / FRAME);
    // ---- RNNoise (or pass-through when unavailable / off)
    const prev = this.hpHist[0];
    let vad = 0;
    const den = this.o16;
    if (this.rnn && c.mode !== 'off') {
      for (let i = 0; i < FRAME; i++) this.i16[i] = hp[i] * 32768;
      vad = this.rnn.process(this.i16, den);
      const r = Number.isFinite(c.resid) ? c.resid : M.resid;
      for (let i = 0; i < FRAME; i++) den[i] = den[i] / 32768 + r * prev[i];
    } else {
      for (let i = 0; i < FRAME; i++) den[i] = prev[i];
      vad = -1;
    }
    // ---- fricatives from the raw signal (current frame = 10 ms look-ahead over the RNNoise output)
    const fr = this.fric.step(hp, prev, this.d16, this.d16pos, {
      speechRecent: this.sinceSpeech < 60, known: Number.isFinite(this.ref), ref: this.ref, rawFloor: this.rawFloorDb,
      vad: vad < 0 ? 0 : vad, p: this.vadAlive ? this.p : 0, sens: clamp(c.sensitivity, 0, 1),
    }) && c.fricatives !== false;
    const fricOut = this.fricOn; // the output frame is one behind: use the previous decision for it …
    this.fricOn = fr;            // … and this frame's for the next
    this.hpHist[1].set(prev); this.hpHist[0].set(hp);
    let ed = 0;
    for (let i = 0; i < FRAME; i++) ed += den[i] * den[i];
    const dnDb = dbOf(ed / FRAME);

    // ---- adaptive floors (fast down, slow up; never learns up while the gate is open)
    const fDown = 0.25, fUp = 0.0015;
    this.rawFloorDb += (rawDb < this.rawFloorDb ? fDown : this.open ? 0 : fUp) * (rawDb - this.rawFloorDb);
    this.floorDb += (dnDb < this.floorDb ? fDown : this.open ? 0 : fUp) * (dnDb - this.floorDb);

    // ---- voice evidence
    const haveVad = vad >= 0;
    this.vadS = haveVad ? Math.max(vad, this.vadS * 0.6) : 0;
    const silero = this.vadAlive;
    const pNow = silero ? this.p : haveVad ? this.vadS : 0;
    const sh = (0.5 - sens) * 0.3; // sensitivity shifts every threshold ±0.15
    const vadOn = clamp(M.vadOn + sh, 0.2, 0.95), pOn = clamp(M.pOn + sh, 0.2, 0.95), pHold = clamp(M.pHold + sh, 0.1, 0.9);
    // speaker-level gate: background voices / TV sit well below the performer's own level at the mic
    const bgRange = (Number.isFinite(c.bgRange) ? c.bgRange : M.bgRange) + sens * 8;
    const known = Number.isFinite(this.ref);
    const lvlDb = haveVad ? dnDb : rawDb;
    // Speaker-level window: a word from the performer STARTS within `bgRange` dB of their usual level (background
    // voices / TV at the mic sit lower); once open, quieter syllables down to ~30 dB below still hold it.
    const openMin = known ? this.ref - (c.ignoreBg ? bgRange : 30 + sens * 8) : -200;
    const holdMin = known ? this.ref - (32 + sens * 8) : -200;
    const levelOk = lvlDb > Math.max(this.floorDb + 8, openMin) && rawDb > this.rawFloorDb + 4;
    const levelHold = lvlDb > Math.max(this.floorDb + 6, holdMin);
    const fast = haveVad ? vad > vadOn : rawDb > this.rawFloorDb + 12; // RNNoise VAD sees the NEXT output frame (look-ahead)
    const cand = levelOk && (fast || pNow > pOn);

    // ---- gate state machine (10 ms steps)
    const k = this.frameIdx;
    if (c.bypassGate) { this.open = true; this.prov = false; }
    else if (!this.open) {
      if (cand) { this.open = true; this.prov = !(pNow > pOn) && silero; this.openAt = k; this.quietFor = 0; this.pSince = []; }
    } else {
      // provisional openings (RNNoise said "voice", Silero hasn't yet): Silero must agree within ~2 windows
      if (this.prov && silero) {
        const ps = this.pSince; // Silero results since the opening (the first one mostly predates the onset)
        if (this.p > pHold && ps.length >= 1) this.prov = false;
        else if (ps.length >= 1 + M.confirmN && Math.max(...ps.slice(1)) < M.cancelP) { this.open = false; this.prov = false; this.cancels++; }
      }
      const holding = levelHold && (pNow > pHold || (haveVad && vad > vadOn * 0.7));
      this.quietFor = holding ? 0 : this.quietFor + 1;
      if (this.open && this.quietFor > 12) this.open = false; // 120 ms hangover
    }
    if (!this.open) this.prov = false;
    this.sinceSpeech = this.open && !this.prov ? 0 : this.sinceSpeech + 1;
    // neural visemes: tell the worker the moment the gate opens (its next 'pcm' chunk can be up to 10 ms away)
    const gNow = this.open || this.fricOn;
    if (gNow && !this.gWas && this.cfg.nv && this.vadPort) this.vadPort.postMessage({ type: 'nvWake' });
    this.gWas = gNow;

    // ---- speaker reference level: upper envelope of accepted, Silero-confirmed speech. It only ever sinks when the
    // room floor drops for good (mic gain turned down → floor and voice drop together), so a TV / second talker
    // below the window can never talk the reference down to its own level.
    if (known && this.floorAtRef !== null && this.rawFloorDb < this.floorAtRef - 6) {
      if (++this.floorDropFor > 500) { this.ref -= this.floorAtRef - this.rawFloorDb; this.floorAtRef = this.rawFloorDb; this.floorDropFor = 0; }
    } else this.floorDropFor = 0;
    this.rejected = !this.open && known && c.ignoreBg && pNow > 0.7 && lvlDb > this.floorDb + 12 && lvlDb < openMin ? 1 : Math.max(0, (this.rejected || 0) - 0.02);
    if (this.open && !this.prov && pNow > 0.6 && lvlDb > this.floorDb + 10) {
      if (!Number.isFinite(this.ref)) { this.ref = lvlDb; this.gainDb = clamp(c.targetDb - lvlDb, -12, 30); }
      else this.ref += (lvlDb > this.ref ? 0.03 : 0.0004) * (lvlDb - this.ref);
      this.floorAtRef = this.rawFloorDb;
    }
    // ---- level normalisation: the performer's speech lands on targetDb whatever the mic gain
    const want = clamp(c.targetDb - (Number.isFinite(this.ref) ? this.ref : -24), -12, 30);
    this.gainDb += (want - this.gainDb) * 0.01;
    const gain = 10 ** (this.gainDb / 20);
    // ---- output: gated, normalised speech over a constant quiet floor (keeps the analyser's noise floor sane)
    const fOn = fricOut || fr;
    const gT = this.open || fOn ? 1 : 0;
    const floorAmp = 10 ** (c.floorDb / 20) * Math.sqrt(12);
    let eo = 0;
    for (let i = 0; i < FRAME; i++) {
      this.g += (gT - this.g) * (gT > this.g ? 0.02 : 0.0012); // ~1 ms attack, ~17 ms release
      this.gf += ((fOn ? 1 : 0) - this.gf) * 0.01;
      const x = den[i] + this.gf * (prev[i] - den[i]); // fricative: raw (RNNoise would erase the hiss)
      const y = x * gain * this.g + floorAmp * this.rand();
      eo += y * y;
      this.push(y);
    }
    // ---- calibration: learn the room (floors + where background voices sit)
    if (this.cal) {
      this.cal.raw.push(rawDb); this.cal.dn.push(dnDb); this.cal.vad.push(vad); this.cal.p.push(pNow);
      if (this.cal.raw.length >= this.cal.n) {
        const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * f))]; };
        const r = { rawFloor: q(this.cal.raw, 0.5), rawP90: q(this.cal.raw, 0.9), dnFloor: q(this.cal.dn, 0.5), dnP95: q(this.cal.dn, 0.95),
          vadP90: q(this.cal.vad, 0.9), pP90: q(this.cal.p, 0.9) };
        this.rawFloorDb = r.rawFloor; this.floorDb = r.dnFloor;
        this.cal = null;
        this.port.postMessage({ type: 'calibrated', r });
      }
    }
    this.frameIdx++;
    const s = this.stat;
    s.raw = rawDb; s.dn = dnDb; s.out = dbOf(eo / FRAME); s.vad = vad; s.p = silero ? this.p : -1; s.gate = this.open ? 1 : 0; s.prov = this.prov ? 1 : 0;
    s.ref = Number.isFinite(this.ref) ? this.ref : -100; s.bg = this.rejected > 0.5 ? 1 : 0; s.floor = this.floorDb; s.rawFloor = this.rawFloorDb; s.gain = this.gainDb;
    const F = this.fric;
    s.fric = F.conf; s.fF = F.pF; s.fTH = F.pTH; s.fS = F.pS; s.fSH = F.pSH; s.fV = F.voiced; s.fDur = F.onFor * 0.01;
    if (c.debugFric) { s.fHi = F.dbg.hiDb; s.fSnr = F.dbg.hiSnr; s.fShape = F.dbg.shape; s.fLike = F.dbg.like; s.fPk = F.dbg.peaked; s.fHz = F.dbg.peakHz; s.fCrest = F.dbg.crest; s.fPer = F.dbg.per; s.fHf = F.dbg.hf; s.fHm = F.dbg.hm; }
    if (++this.statCount >= this.statEvery) {
      this.statCount = 0;
      this.port.postMessage({ type: 'stat', t: currentTime, s: { ...s }, err: this.err });
    }
  }

  process(inputs, outputs) {
    const inp = inputs[0] && inputs[0][0];
    const out = outputs[0] && outputs[0][0];
    const n = out ? out.length : inp ? inp.length : 128;
    { // no input yet (source not connected / stream starting): keep framing zeros so the floor keeps flowing
      const inR = inp && inputs[0].length > 1 ? inputs[0][1] : null;
      const m = inp ? inp.length : n;
      for (let i = 0; i < m; i++) {
        let x = inp ? (inR ? 0.5 * (inp[i] + inR[i]) : inp[i]) : 0;
        x = this.hp[1].step(this.hp[0].step(x));
        this.feedSilero(x);
        this.inBuf[this.inN++] = x;
        if (this.inN >= FRAME) { this.frame(); this.inN = 0; }
      }
    }
    if (out) {
      for (let i = 0; i < n; i++) {
        if (this.fn > 0) { out[i] = this.fifo[this.fr]; this.fr = (this.fr + 1) % this.fifo.length; this.fn--; }
        else out[i] = 0;
      }
    }
    if (out) for (let ch = 1; ch < outputs[0].length; ch++) outputs[0][ch].set(out);
    return true;
  }
}

registerProcessor('vtp-voice', VoiceFrontEnd);
