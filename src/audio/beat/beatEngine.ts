/* BeatEngine v8 — live onset detection with a stable VJ beat grid.
 *
 * AudioWorklet features -> drum/onset cues -> OnsetComb (comb/coverage tempo
 * + phase over all onsets, DBN as fallback) -> StableBeatGrid consensus ->
 * render-clock beats. Tempo is folded into 70-232 BPM (lo-fi 70s up to uptempo /
 * hardcore 230s; an octave-up guard doubles a half-time lock when the kick fills
 * every half beat); an offbeat guard and a
 * low-band downbeat model keep phase and bar aligned. Tuned and measured
 * against rekordbox grids: scripts/eval-rekordbox.js, docs/rekordbox-eval.md.
 * Optional authoritative clock: control('link', {bpm, beat}) from Ableton Link.
 *
 * Acquisition uses ~3 seconds of agreeing estimates. A locked grid survives
 * fills and breakdowns. New tempi require ~7 seconds of consistent evidence
 * (10 seconds for octave changes) plus measured onset coverage. Refinement
 * uses eight seconds of onset intervals, with up to 0.4 BPM/second pitch tracking.
 * A robust phase loop corrects timing independently of tempo.
 * Onset-comb voting cross-checks the DBN; live controls can hold a manual grid.
 * True silence stops beat emission and releases the lock after 8 seconds.
 *
 * pushBandHop(tMs, hop): up to 15-channel worklet features
 * pushFrame(bins, tMs, feat): visual-bin fallback or precomputed features
 * sample(tMs): consume render-clock beat/kick events once per render frame
 * peek(tMs): read state without consuming events
 * update(tMs, bins): legacy combined ingest/sample
 */


// Silence gate on the squashed band level (was 0.012 ≈ -53 dBFS band RMS: a quiet loopback / low system volume read
// as silence and the arrangement never started). 0.006 ≈ -60 dBFS, still well above a real interface's noise floor.
const SILENCE = 0.006;
const clamp   = (v: number, lo: number, hi: number) => v < lo ? lo : v > hi ? hi : v;
const clamp01 = (v: number) => clamp(Number(v) || 0, 0, 1);
const lerp    = (a: number, b: number, t: number) => a + (b - a) * t;
const coef30  = (p: number, dt: number) => 1 - Math.pow(1 - clamp(p, 0, 1), dt * 30);
const smoothstep = (e0: number, e1: number, v: number) => { const t = clamp((v - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

/* --------------------------------------------------------------------------
   DbnBeatTracker — joint tempo/phase state space, online forward inference
   -------------------------------------------------------------------------- */
export class DbnBeatTracker {
  [k: string]: any;
  constructor(opts: any = {}) {
    this.fps = opts.fps || 100;                 // internal observation rate
    this.minBpm = opts.minBpm || 55;
    this.maxBpm = opts.maxBpm || 215;
    this.obsLambda = opts.obsLambda || 16;      // beat region = 1/λ of the period (legacy sizing)
    this.transLambda = opts.transLambda || 80;  // tempo stickiness (madmom: 100)
    // Observation model for SPIKE activations (one frame per onset):
    //   L_in(a)  = ε·r + G·a³      likelihood of a beat-window state
    //   L_out(a) = ε + a           likelihood of any other state
    // - a = 0 (no onset): nearly uninformative; the in-window state pays a
    //   small fixed Occam cost (r < 1) so a hypothesis that subdivides the
    //   beat without evidence loses slowly — but the cost is per WINDOW,
    //   not per period, so it no longer favours slow tempi the way
    //   madmom's (1−a)/(λ−1) does with a fixed-width window.
    // - strong onset (a → 1): in-window earns ~ln((εr+G)/(ε+1)) ≈ 1.8 nats.
    // - weak onset (a below the crossover √(1/G) ≈ 0.4): prefers being OFF
    //   the beat. This is what stops 8th-note hats from doubling the tempo:
    //   hats are subordinate, kicks and snares carry the pulse.
    this.eps = opts.eps != null ? opts.eps : 0.05;
    this.emptyRatio = opts.emptyRatio != null ? opts.emptyRatio : 0.85;
    this.gain = opts.gain != null ? opts.gain : 10;
    // Beat region: a FIXED 3 frames (30 ms) at every tempo. Musical timing
    // precision does not scale with period — a 60 ms window at 68 BPM lets
    // a 3:4 alias swallow a hip-hop kick played a 16th early.
    this.minBeatLen = opts.minBeatLen || 3;
    this.maxBeatLen = opts.maxBeatLen || 3;
    this.obsSigma = opts.obsSigma || 1.2;       // soft window width (frames)

    this.tauMin = Math.max(4, Math.ceil(this.fps * 60 / this.maxBpm));
    this.tauMax = Math.floor(this.fps * 60 / this.minBpm);
    this.nT = this.tauMax - this.tauMin + 1;
    this.tau = new Int32Array(this.nT);
    this.off = new Int32Array(this.nT);
    this.beatLen = new Int32Array(this.nT);
    let total = 0;
    for (let i = 0; i < this.nT; i++) {
      const t = this.tauMin + i;
      this.tau[i] = t;
      this.off[i] = total;
      this.beatLen[i] = clamp(Math.round(t / this.obsLambda), this.minBeatLen, this.maxBeatLen);
      total += t;
    }
    this.total = total;
    this.alpha = new Float64Array(total);
    this.wrap = new Float64Array(this.nT);
    this.marg = new Float64Array(this.nT);

    // Soft observation window: w[φ] ∈ [0,1] says how "on the beat" phase φ
    // is. Hard windows + 1-frame onset spikes are brittle: a tempo whose
    // true period is 34.5 frames drifts half a frame per beat between the
    // τ=34 and τ=35 states and gets punished as off-beat every few beats,
    // while its half-time alias (τ=69, integer) fits perfectly → octave
    // error. A Gaussian of σ=1.2 frames centred on the beat region gives a
    // spike one frame out ~70 % credit, two frames out 25 %, and nothing
    // beyond ±4 frames (40 ms) — wrapping so slightly-early onsets
    // (φ = τ−1) count too.
    this.obsW = new Float64Array(total);
    for (let i = 0; i < this.nT; i++) {
      const o = this.off[i], t = this.tau[i], bl = this.beatLen[i];
      const c = (bl - 1) / 2, sigma = this.obsSigma;
      for (let p = 0; p < t; p++) {
        let d = p - c;
        if (d > t / 2) d -= t;          // wrap: φ near τ is "just before" the beat
        this.obsW[o + p] = Math.exp(-0.5 * (d / sigma) * (d / sigma));
      }
    }

    // Tempo prior: broad log-Gaussian centred on 128 BPM (σ ≈ 0.85 octave)
    // with a high floor. Used at init and (softly) inside the transition so
    // an ambiguous mix leans toward the perceived range rather than 60/215.
    this.prior = new Float64Array(this.nT);
    for (let i = 0; i < this.nT; i++) {
      const bpm = this.fps * 60 / this.tau[i];
      const dev = Math.log2(bpm / 128) / 0.85;
      this.prior[i] = 0.35 + 0.65 * Math.exp(-0.5 * dev * dev);
    }

    // Tempo transition matrix: trans[i*nT + j] = P(τ_i | τ_j), columns sum to 1.
    this.trans = new Float64Array(this.nT * this.nT);
    for (let j = 0; j < this.nT; j++) {
      let s = 0;
      for (let i = 0; i < this.nT; i++) {
        const ratio = this.tau[i] / this.tau[j];
        const v = Math.exp(-this.transLambda * Math.abs(ratio - 1)) * Math.pow(this.prior[i], 0.35);
        this.trans[i * this.nT + j] = v; s += v;
      }
      for (let i = 0; i < this.nT; i++) this.trans[i * this.nT + j] /= s;
    }
    // Sparse row access: only neighbours within ±12 % contribute meaningfully.
    this.transLo = new Int32Array(this.nT);
    this.transHi = new Int32Array(this.nT);
    for (let i = 0; i < this.nT; i++) {
      let lo = i, hi = i;
      while (lo > 0 && this.tau[i] / this.tau[lo - 1] > 0.88) lo--;
      while (hi < this.nT - 1 && this.tau[hi + 1] / this.tau[i] < 1.12) hi++;
      this.transLo[i] = lo; this.transHi[i] = hi;
    }

    // Published estimate
    this.bpm = 0;            // sub-frame MAP tempo
    this.conf = 0;           // posterior mass within ±4 % of MAP tempo
    this.phaseFrac = 0;      // 0 = on beat, →1 approaching next beat
    this.phaseR = 0;         // circular resultant length (phase certainty)
    this.bestI = 0;
    this.frames = 0;
    this.reset();
  }

  reset() {
    const A = this.alpha;
    let s = 0;
    for (let i = 0; i < this.nT; i++) {
      const o = this.off[i], t = this.tau[i], v = this.prior[i] / t;
      for (let p = 0; p < t; p++) A[o + p] = v;
      s += this.prior[i];
    }
    for (let k = 0; k < this.total; k++) A[k] /= s;
    this.bpm = 0; this.conf = 0; this.phaseFrac = 0; this.phaseR = 0;
    this.frames = 0;
  }

  /** One observation frame. a ∈ [0,1] = beat activation. */
  step(a: number) {
    const A = this.alpha, nT = this.nT, tau = this.tau, off = this.off, wrap = this.wrap;
    const act = clamp01(a);
    const pn = this.eps + act;
    const pb = this.eps * this.emptyRatio + this.gain * act * act * act;

    // 1. mass leaving each tempo's last phase slot (about to cross a beat)
    for (let i = 0; i < nT; i++) wrap[i] = A[off[i] + tau[i] - 1];
    // 2. advance phase within each tempo
    for (let i = 0; i < nT; i++) {
      const o = off[i], t = tau[i];
      for (let p = t - 1; p >= 1; p--) A[o + p] = A[o + p - 1];
    }
    // 3. re-inject wrapped mass at φ=0 with tempo transition
    const T = this.trans;
    for (let i = 0; i < nT; i++) {
      let s = 0;
      const row = i * nT, lo = this.transLo[i], hi = this.transHi[i];
      for (let j = lo; j <= hi; j++) s += T[row + j] * wrap[j];
      A[off[i]] = s;
    }
    // 4. observation likelihood (soft window) + normalisation
    let sum = 0;
    const W = this.obsW, dpb = pb - pn, total = this.total;
    for (let k = 0; k < total; k++) {
      const v = A[k] * (pn + dpb * W[k]);
      A[k] = v; sum += v;
    }
    if (sum > 0) { const inv = 1 / sum; for (let k = 0; k < total; k++) A[k] *= inv; }
    else this.reset();
    this.frames++;
  }

  /** Read the posterior: MAP tempo (sub-frame), confidence, phase. */
  estimate() {
    const A = this.alpha, nT = this.nT, tau = this.tau, off = this.off, marg = this.marg;
    let best = 0, bestV = -1;
    for (let i = 0; i < nT; i++) {
      const o = off[i], t = tau[i];
      let s = 0;
      for (let p = 0; p < t; p++) s += A[o + p];
      marg[i] = s;
      if (s > bestV) { bestV = s; best = i; }
    }
    this.bestI = best;
    const tb = tau[best];

    // sub-frame period: mass-weighted mean over the ±4 % neighbourhood
    let wsum = 0, tsum = 0, conf = 0;
    for (let i = 0; i < nT; i++) {
      const rel = Math.abs(tau[i] - tb) / tb;
      if (rel <= 0.045) { conf += marg[i]; }
      if (rel <= 0.03) { wsum += marg[i]; tsum += marg[i] * tau[i]; }
    }
    const tauEst = wsum > 0 ? tsum / wsum : tb;
    this.bpm = this.fps * 60 / tauEst;
    this.conf = conf;

    // phase: posterior MODE under the MAP tempo, refined by a circular mean
    // over ±3 frames around it. (A global circular mean is dragged toward
    // secondary modes — off-beat bass / open hats — and jitters the grid.)
    {
      const o = off[best], t = tau[best];
      let pm = 0, vm = -1;
      for (let p = 0; p < t; p++) if (A[o + p] > vm) { vm = A[o + p]; pm = p; }
      let sx = 0, sy = 0, ms = 0, tot = 0;
      const k = (2 * Math.PI) / t;
      for (let p = 0; p < t; p++) tot += A[o + p];
      for (let d = -3; d <= 3; d++) {
        const p = ((pm + d) % t + t) % t;
        const w = A[o + p];
        sx += w * Math.cos(p * k); sy += w * Math.sin(p * k); ms += w;
      }
      if (ms > 0) {
        let ang = Math.atan2(sy, sx) / (2 * Math.PI);
        if (ang < 0) ang += 1;
        // window centre sits (beatLen−1)/2 frames after the beat state
        ang -= ((this.beatLen[best] - 1) / 2) / t;
        if (ang < 0) ang += 1;
        this.phaseFrac = ang;
        // certainty = share of this tempo's mass concentrated at the mode
        this.phaseR = tot > 0 ? clamp01(ms / tot * 1.5) : 0;
      }
    }
    return this;
  }
}

/* --------------------------------------------------------------------------
   BeatEngine v5
   -------------------------------------------------------------------------- */
const BANDS = ['kick', 'body', 'mid', 'high', 'flux'];

// Per-band detection profiles for the REACTIVE path + hat/kick cues.
const PROFILE: Record<string, { w: number; absFloor: number; kMad: number }> = {
  kick: { w: 0.28, absFloor: 0.020, kMad: 1.90 },
  body: { w: 0.32, absFloor: 0.022, kMad: 1.80 },
  mid:  { w: 1.20, absFloor: 0.022, kMad: 1.40 },
  high: { w: 1.40, absFloor: 0.016, kMad: 1.28 },
  flux: { w: 1.25, absFloor: 0.020, kMad: 1.32 }
};

let DBN_FPS = 100;
let DBN_STEP_MS = 1000 / DBN_FPS;

// Comb/coverage tempo+phase estimator over the last ~12 s of onsets.
// For each candidate period P, onsets (weight = activation × recency) are
// folded into a phase histogram; E = share of onset weight near the best
// phase ("how much of the rhythm this grid explains") and C = share of the
// grid's slots that actually hold an onset ("how many of its beats are
// real"). score = √(E·C). Double tempo loses on C, half tempo loses on E,
// 3:2 aliases lose on both. Uses every onset ≥ 0.1, not only drum-strength
// ones, which is what lets it lock inside a few bars. Measured against
// rekordbox grids with scripts/eval-rekordbox.js.
export class OnsetComb {
  [k: string]: any;
  constructor() { this.t = []; this.a = []; this.hist = new Float64Array(512); this.sm = new Float64Array(512); this.w = new Float64Array(1024); this.kern = new Float64Array(64); }
  observe(t: number, a: number) {
    if (!(a >= 0.1)) return;
    this.t.push(t); this.a.push(a);
    while (this.t.length && (this.t[0] < t - 16000 || this.t.length > 600)) { this.t.shift(); this.a.shift(); }
  }
  clear() { this.t = []; this.a = []; }
  count(from: number) { let n = 0; for (let i = this.t.length - 1; i >= 0 && this.t[i] >= from; i--) n++; return n; }
  _score(P: number, T: number, i0: number, sig: number): any {
    const bins = Math.max(24, Math.min(512, Math.round(P / 5))), bw = P / bins, H = this.hist, t = this.t, a = this.a, w = this.w;
    H.fill(0, 0, bins);
    let tot = 0;
    for (let i = i0; i < t.length; i++) {
      const wi = w[i - i0]; tot += wi;
      const ph = (((t[i] % P) + P) % P) / bw, b = Math.floor(ph), f = ph - b;
      H[b % bins] += wi * (1 - f); H[(b + 1) % bins] += wi * f;
    }
    if (tot <= 0) return null;
    const r = Math.min(31, Math.ceil(3 * sig / bw)), K = this.kern;
    for (let d = 0; d <= r; d++) { const x = d * bw / sig; K[d] = Math.exp(-0.5 * x * x); }
    let best = -1, bi = 0;
    for (let b = 0; b < bins; b++) {
      let s = H[b] * K[0];
      for (let d = 1; d <= r; d++) s += (H[(b + d) % bins] + H[(b - d + bins * 32) % bins]) * K[d];
      if (s > best) { best = s; bi = b; }
    }
    const phase = bi * bw, E = best / tot, from = t[i0];
    let expd = 0, cov = 0, j = i0;
    const k0 = Math.ceil((from - phase) / P), k1 = Math.floor((T - phase) / P);
    for (let k = k0; k <= k1; k++) {
      const st = phase + k * P, rw = Math.exp(-(T - st) / 9000);
      expd += rw;
      let m = 0;
      while (j < t.length && t[j] < st - 3 * sig) j++;
      // weighted by onset strength: a faint hat cannot 'cover' a beat slot
      for (let q = j; q < t.length && t[q] <= st + 3 * sig; q++) { const x = (t[q] - st) / sig, v = Math.exp(-0.5 * x * x) * a[q]; if (v > m) m = v; }
      cov += m * rw;
    }
    const C = expd ? cov / expd : 0;
    return { s: Math.sqrt(E * C), E, C, phase };
  }
  /** Best {bpm, s, E, C, phase} in [lo, hi) over the last windowMs, or null. */
  estimate(T: number, windowMs = 12000, o: any = {}) {
    const from = T - windowMs, t = this.t;
    let i0 = t.length; while (i0 > 0 && t[i0 - 1] >= from) i0--;
    const n = t.length - i0;
    if (n < 6 || T - t[i0] < 2500) return null;
    if (n > this.w.length) this.w = new Float64Array(n * 2);
    for (let i = i0; i < t.length; i++) this.w[i - i0] = this.a[i] * Math.exp(-(T - t[i]) / 9000);
    const lo = o.lo || 85, hi = o.hi || 190, sig = 22, prefer = o.prefer || 0, cont = o.continuity || 0;
    const total = (bpm: number) => {
      const r = this._score(60000 / bpm, T, i0, sig); if (!r) return null;
      r.bpm = bpm;
      r.total = r.s + 0.1 * Math.exp(-0.5 * Math.pow(Math.log2(bpm / 125) / 0.5, 2)) + (prefer && Math.abs(bpm / prefer - 1) < 0.015 ? cont : 0);
      return r;
    };
    let best = null;
    for (let bpm = lo; bpm < hi; bpm += 0.5) { const r = total(bpm); if (r && (!best || r.total > best.total)) best = r; }
    if (!best) return null;
    const c = best.bpm;
    for (let bpm = c - 0.45; bpm <= c + 0.451; bpm += 0.05) { const r = total(bpm); if (r && r.total > best.total) best = r; }
    return best;
  }
  /** Score of a given period (for comparing the current grid to a challenger). */
  scoreAt(T: number, bpm: number, windowMs = 12000) {
    const from = T - windowMs, t = this.t;
    let i0 = t.length; while (i0 > 0 && t[i0 - 1] >= from) i0--;
    if (t.length - i0 < 6) return 0;
    for (let i = i0; i < t.length; i++) this.w[i - i0] = this.a[i] * Math.exp(-(T - t[i]) / 9000);
    const r = this._score(60000 / bpm, T, i0, 22);
    return r ? r.s : 0;
  }
}

// Stable musical clock: consensus chooses tempo; long onset intervals refine
// it. Short-term phase errors must never modulate the song's BPM.
export class StableBeatGrid {
  [k: string]: any;
  constructor() {
    this.onsets = []; this.votes = []; this.period = 0; this.confidence = 0;
    this.lastCheck = -Infinity; this.lastOnset = -Infinity;
    this.lastChange = 0; this.changes = 0; this.status = 'acquiring';this.challenger=0;this.challengerAt=0;this.transitioning=false;
    this.fold = (b: number) => b;   // BeatEngine installs its octave policy here
    this.range = [85, 190];
    this.comb = new OnsetComb(); this.lastComb = null;
  }
  observe(t: number, activation: number) {
    this.comb.observe(t, activation);
    if (activation < 0.55) return;
    if (t - this.lastOnset < 65) return;
    this.onsets.push(t); this.lastOnset = t;
    while (this.onsets.length && this.onsets[0] < t - 20000) this.onsets.shift();
  }
  median(values: any) {
    values.sort((a: number, b: number) => a - b);
    const n = values.length;
    return n % 2 ? values[n >> 1] : (values[n / 2 - 1] + values[n / 2]) / 2;
  }
  fit(period: number, since: number) {
    const times = this.onsets.filter((t: number) => t >= since);
    if (times.length < 6 || times[times.length - 1] - times[0] < period * 6) return null;
    const slopes = [];
    for (let i = 0; i < times.length; i++) for (let j = i + 1; j < times.length; j++) {
      const delta = times[j] - times[i], beats = Math.round(delta / period);
      if (beats < 4) continue;
      const p = delta / beats;
      if (Math.abs(p / period - 1) < 0.025) slopes.push(p);
    }
    return slopes.length >= 6 ? this.median(slopes) : null;
  }
  support(period: number, since: number) {
    const times = this.onsets.filter((t: number) => t >= since);
    if (times.length < 6) return 0;
    let best = 0;
    for (const origin of times.slice(-8)) {
      const slots = new Set();
      let matched = 0;
      for (const t of times) {
        const slot = Math.round((t - origin) / period);
        if (Math.abs(t - origin - slot * period) < period * 0.12) { matched++; slots.add(slot); }
      }
      const expected = (times[times.length - 1] - times[0]) / period + 1;
      best = Math.max(best, Math.min(matched / times.length, slots.size / expected));
    }
    return best;
  }
  candidate(t: number, estimate: any, windowMs=8000) {
    // Primary evidence: the comb over all onsets (see OnsetComb).
    const c=this.comb.estimate(t,windowMs>=8000?12000:windowMs,{lo:this.range[0],hi:this.range[1],prefer:this.period?60000/this.period:0,continuity:.03});
    if(windowMs>=8000)this.lastComb=c;
    if(c&&c.s>=.3){this.supportScore=c.s;return {bpm:c.bpm,conf:Math.min(.98,.5+c.s*.6),phaseR:Math.max(.36,c.s),comb:c};}
    // Fallback: interval voting over drum-strength onsets.
    const times=this.onsets.filter((v: number)=>v>=t-windowMs);
    if(times.length<8||times[times.length-1]-times[0]<3000)return estimate;
    const votes=new Map();
    for(let i=0;i<times.length;i++)for(let j=i+1;j<times.length;j++){
      const d=times[j]-times[i];if(d<650||d>6000)continue;
      for(let k=1;k<=12;k++){
        const bpm=60000*k/d;if(bpm<55||bpm>245)continue;
        const bin=Math.round(bpm*2);votes.set(bin,(votes.get(bin)||0)+1);
      }
    }
    const candidates=[...new Set([...votes].sort((a,b)=>b[1]-a[1]).slice(0,10).map(v=>+this.fold(v[0]/2).toFixed(2)))];
    candidates.push(estimate.bpm);if(this.period)candidates.push(60000/this.period);
    let best=null;
    for(const bpm of candidates){
      if(!(bpm>=55&&bpm<=245))continue;
      const p=this.fit(60000/bpm,t-windowMs)||60000/bpm;
      const support=this.support(p,t-windowMs);
      const prior=.025*Math.exp(-Math.pow(Math.log2((60000/p)/128),2));
      const continuity=this.period&&Math.abs(p/this.period-1)<.015?.025:0;
      const score=support+prior+continuity;
      if(!best||score>best.score)best={period:p,support,score};
    }
    this.supportScore=best?best.support:0;
    if(best&&best.support>.72)return {bpm:60000/best.period,conf:Math.min(.98,best.support),phaseR:best.support};
    return estimate;
  }
  phaseOrigin(period: number, since: number, fallback: number) {
    const times=this.onsets.filter((t: number)=>t>=since);
    let best=fallback,score=-1;
    for(const origin of times.slice(-16)){
      let sum=0;for(const t of times){const d=t-origin-Math.round((t-origin)/period)*period;sum+=Math.exp(-.5*(d/22)**2);}
      if(sum>score){score=sum;best=origin;}
    }
    const offsets=times.map((t: number)=>t-best-Math.round((t-best)/period)*period).filter((d: number)=>Math.abs(d)<period*.13);
    return best+(offsets.length?this.median(offsets):0);
  }
  update(t: number, estimate: any, coasting: boolean) {
    if (t - this.lastCheck < 500) return false;
    this.lastCheck = t;
    if (!coasting) estimate=this.candidate(t,estimate);
    const fresh = t - this.lastOnset < 1200;
    const reliable = !coasting && fresh && estimate.conf > 0.55 && estimate.phaseR > 0.35;
    this.votes.push({ t, bpm: estimate.bpm, good: reliable });
    this.votes = this.votes.filter((v: any) => v.t >= t - 12000);
    this.status = this.period ? (fresh && !coasting ? 'locked' : 'holding') : 'acquiring';
    // A recent coherent replacement can outvote old-track history. Two
    // competing clocks do not qualify: require coverage and a clear margin.
    this.transitioning=false;
    if(this.period&&fresh&&!coasting){
      const currentSupport=this.support(this.period,t-5000);
      this.transitioning=currentSupport<.55;
      if(this.transitioning)this.status='mixing';
      const replacement=this.candidate(t,{bpm:0,conf:0,phaseR:0},5000);
      const ratio=replacement.bpm/(60000/this.period);
      const octave=Math.abs(ratio-2)<.08||Math.abs(ratio-.5)<.04;
      // A challenger must explain the last 5 s clearly better than the current grid does.
      const currentScore=replacement.comb?this.comb.scoreAt(t,60000/this.period,5000):currentSupport;
      const credible=replacement.comb?(replacement.comb.s>.55&&Math.abs(ratio-1)>.03&&!octave&&replacement.comb.s-currentScore>.15)
        :(replacement.conf>.84&&Math.abs(ratio-1)>.03&&!octave&&replacement.conf-currentSupport>.22);
      if(credible){
        if(!this.challenger||Math.abs(replacement.bpm/this.challenger-1)>.015){this.challenger=replacement.bpm;this.challengerAt=t;}
        if(t-this.challengerAt>=2500){
          this.period=60000/replacement.bpm;this.lastChange=t;this.confidence=replacement.conf;this.changes++;
          this.votes=[];this.challenger=0;this.transitioning=false;this.status='locked';return true;
        }
      }else this.challenger=0;
    }else this.challenger=0;
    if (!reliable) return false;
    const bpm = estimate.bpm;
    const different = this.period && Math.abs(bpm / (60000 / this.period) - 1) > 0.03;
    const ratio = this.period ? bpm / (60000 / this.period) : 1;
    const octave = Math.abs(ratio - 2) < 0.08 || Math.abs(ratio - 0.5) < 0.04;
    const windowMs = !this.period ? 3000 : octave ? 10000 : 7000;
    const recent = this.votes.filter((v: any) => v.t >= t - windowMs);
    const agreed = recent.filter((v: any) => v.good && Math.abs(v.bpm / bpm - 1) < 0.015);
    const consensus = recent.length >= windowMs / 510 && agreed.length / recent.length >= 0.85;
    if ((!this.period || different) && consensus) {
      const next = 60000 / this.median(agreed.map((v: any) => v.bpm));
      // Require real beat coverage, not just a confident octave hypothesis.
      if (this.period && this.support(next, t - windowMs) < 0.60) return false;
      this.period = this.fit(next, t - windowMs) || next;
      this.lastChange = t; this.confidence = estimate.conf; this.changes++;
      this.status = 'locked';
      return true;
    }
    if (this.period && !different) {
      // Track gradual pitch rides while ignoring sub-0.08 BPM noise.
      const fit = this.fit(this.period, Math.max(this.lastChange, t - 8000));
      if (fit) {
        const oldBpm = 60000 / this.period, targetBpm = 60000 / fit;
        if (Math.abs(targetBpm - oldBpm) > 0.08)
          this.period = 60000 / (oldBpm + clamp(targetBpm - oldBpm, -0.20, 0.20));
      }
      this.confidence = lerp(this.confidence, estimate.conf, 0.10);
    }
    return false;
  }
}

// Causal arrangement cues, not lyric/stem recognition. Repeated energetic
// textures are labelled chorus-like with an explicit confidence.
export class MusicSectionTracker {
  [k: string]: any;
  constructor(){
    this.name='listening';this.confidence=0;this.changedAt=0;this.serial=0;
    this.last=null;this.started=null;this.lastKick=-1e9;this.energy=0;this.slow=0;this.bright=0;this.brightSlow=0;this.bass=0;this.peak=.05;this.kickRate=0;this.snareRate=0;
    this.candidate='';this.candidateAt=0;this.lowSince=null;this.armed=false;this.returnHits=0;this.pendingDrop=null;this.fakeDropAt=-1e9;this.dropAt=-1e9;this.dropId=0;this.hasGroove=false;this.riseFor=0;
    this.intensity=0;this.highEnergy=false;this.tension=0;this.templates=[];this.texture=[0,0,0];this.grooveAge=0;this.saved=false;this.hadContrast=false;this.silence=0;
  }
  set(name: string,confidence: number,t: number){if(this.name!==name){this.name=name;this.changedAt=t;this.serial++;}this.confidence=confidence;}
  push(t: number,f: any){
    const dt=this.last===null?.01:Math.max(0,Math.min(.2,(t-this.last)/1000));this.last=t;
    const level=Math.max(0,f.level||0),period=60000/(f.bpm||120);
    if(level<SILENCE){if(this.pendingDrop){this.fakeDropAt=t;this.pendingDrop=null;}this.highEnergy=false;this.intensity=0;this.tension*=Math.exp(-dt/1.5);this.silence+=dt;if(this.silence>.6)this.set('listening',1,t);if(this.silence>8&&this.started!==null){const next=new MusicSectionTracker();Object.assign(this,next);this.last=t;}return;}
    this.silence=0;if(this.started===null)this.started=t;
    const fast=1-Math.exp(-dt/.5),slow=1-Math.exp(-dt/4);
    const previousEnergy=this.energy;
    this.energy+=(level-this.energy)*fast;this.slow+=(level-this.slow)*slow;
    const previousBright=this.bright;
    this.bright+=((f.bright||0)-this.bright)*fast;this.brightSlow+=((f.bright||0)-this.brightSlow)*slow;
    this.bass+=((f.bass||0)-this.bass)*fast;this.peak=Math.max(this.energy,this.peak*Math.exp(-dt/90),.025);
    this.kickRate=this.kickRate*Math.exp(-dt/2)+(f.kick?.5:0);this.snareRate=this.snareRate*Math.exp(-dt/2)+(f.snare?.5:0);
    const quietGap=t-this.lastKick;if(f.kick)this.lastKick=t;
    this.intensity=clamp01(f.performanceIntensity||0);this.highEnergy=!!f.highEnergy;
    // Band-energy structure (worklet feed only): the low end (sub+bass) is
    // what DJ arrangements remove in breakdowns/builds and slam back on the
    // drop. Levels in dB against a slowly decaying loud reference.
    const bands=f.lowPow!=null;let bandQuiet=false,bandRising=false;
    if(bands){
      const db=(x: number)=>10*Math.log10(Math.max(1e-12,x)),k=(tau: any)=>1-Math.exp(-dt/tau),L=db(f.lowPow),H=db(f.midHighPow);
      if(this.bL==null){this.bL=this.bLs=L;this.bH=this.bHs=H;this.bRef=L;this.bHist=[];this.bHistAt=-1e9;this.bReducedFor=0;this.bPending=null;}
      this.bL+=(L-this.bL)*k(.12);this.bLs+=(L-this.bLs)*k(1.2);this.bH+=(H-this.bH)*k(.3);this.bHs+=(H-this.bHs)*k(3);
      this.bRef=Math.max(this.bLs,this.bRef-dt*.15);
      if(t-this.bHistAt>=100){this.bHist.push([t,this.bL,this.bH]);this.bHistAt=t;while(this.bHist.length&&this.bHist[0][0]<t-12000)this.bHist.shift();}
      const win=(a: number,b: number,i: any)=>{let sum=0,n=0;for(const h of this.bHist)if(h[0]>=t-a&&h[0]<t-b){sum+=h[i];n++;}return n?sum/n:null;};
      const reduced=this.bLs<this.bRef-7;
      this.bReducedFor=reduced?this.bReducedFor+dt:Math.max(0,this.bReducedFor-dt*2);
      bandQuiet=this.bReducedFor*1000>period*4;
      const hPrev=win(4500,3500,2);
      bandRising=reduced&&hPrev!==null&&this.bH-hPrev>2&&this.bH>this.bHs+.5;
      // Drop: the low end slams back >= 6 dB above the LOUDEST it got over
      // the previous ~1.5 bars (a max, so one-bar fills and kick gaps inside
      // a groove never qualify) and lands near the track's loud reference.
      let beforeMax=-Infinity,n=0;for(const h of this.bHist)if(h[0]>=t-period*9&&h[0]<t-period*1.2){n++;if(h[1]>beforeMax)beforeMax=h[1];}
      if(!this.bPending&&n>=5&&this.bL-beforeMax>=6.5&&this.bL>=this.bRef-5&&t-this.dropAt>period*16&&t-this.started>4000){
        this.bPending={at:t,jump:this.bL-beforeMax};this.pendingDrop={at:t,hits:0,peak:this.energy,band:true};
      }
      if(this.bPending){
        const age=t-this.bPending.at;
        if(this.bL<this.bRef-9){this.fakeDropAt=t;this.bPending=null;this.pendingDrop=null;}
        else if(age>=Math.min(period,500)){this.dropStrength=clamp01((this.bPending.jump-6)/14+.25);this.dropStart=this.bPending.at;this.bPending=null;this.pendingDrop=null;this.dropAt=t;this.dropId++;this.armed=false;this.riseFor=0;this.bReducedFor=0;this.set('drop',.88,t);}
      }
    }
    const quiet=bands?bandQuiet:(!this.highEnergy&&t-this.lastKick>period*3&&this.kickRate<.45)||this.energy<this.peak*.42;
    if(quiet){if(this.lowSince===null)this.lowSince=t;if(t-this.lowSince>period*4){this.armed=this.hasGroove&&t-this.dropAt>period*16;this.hadContrast=true;}}
    else this.lowSince=null;
    // A rising texture or accelerating snare activity must persist. A single
    // bright transient is insufficient; this can also detect kick-backed builds.
    const swelling=t-this.started>4000&&this.energy>this.slow*1.16&&(this.energy-previousEnergy)/Math.max(.001,dt)>.012&&this.energy>this.peak*.3;
    const rising=bands?(bandRising||swelling&&this.bReducedFor>0):swelling||(this.bright-this.brightSlow>.025&&(this.bright-previousBright)/Math.max(.001,dt)>.004&&this.energy>this.slow*1.08)||(this.snareRate>2.6&&this.energy>this.slow*1.12&&this.bright>this.brightSlow+.03);
    this.riseFor=rising?this.riseFor+dt:Math.max(0,this.riseFor-dt*.6);
    if(this.riseFor>3&&this.hasGroove)this.armed=true;
    // The first returning kick is a tease until rhythm and body persist.
    if(!bands&&this.armed&&f.kick&&!this.pendingDrop)this.pendingDrop={at:t,hits:0,peak:this.energy};
    if(!bands&&this.pendingDrop){
      const pending=this.pendingDrop;pending.peak=Math.max(pending.peak,this.energy);
      if(f.kick)pending.hits++;
      const age=t-pending.at,collapsed=this.energy<pending.peak*.45||t-this.lastKick>period*1.7;
      if(age>period*.8&&collapsed||age>period*6){this.fakeDropAt=t;this.pendingDrop=null;this.returnHits=0;}
      else if(pending.hits>=3&&age>=period*2&&this.energy>this.peak*.55&&this.bass>this.energy*.25&&t-this.dropAt>period*32){
        this.dropAt=t;this.dropStart=pending.at;this.dropId++;this.dropStrength=.6;this.armed=false;this.pendingDrop=null;this.returnHits=0;this.riseFor=0;this.set('drop',.88,t);
      }
    }
    const values=[this.bass/Math.max(.02,this.energy),this.bright/Math.max(.02,this.energy),this.kickRate/(f.bpm?f.bpm/60:2)];
    for(let i=0;i<3;i++)this.texture[i]+=(Math.min(3,values[i])-this.texture[i])*(1-Math.exp(-dt/2));
    const energetic=(this.kickRate>.65||this.highEnergy)&&this.energy>this.peak*.65;
    if(energetic){this.grooveAge+=dt;this.hasGroove=this.hasGroove||this.grooveAge>period*6/1000;}
    else{
      if(this.grooveAge>period*8/1000&&!this.saved)this.pendingTemplate=this.texture.slice();
      if(this.pendingTemplate&&this.lowSince!==null&&t-this.lowSince>period*2){this.templates.push(this.pendingTemplate);if(this.templates.length>8)this.templates.shift();this.pendingTemplate=null;this.saved=true;}
      this.grooveAge=0;
    }
    if(energetic&&this.grooveAge>period*4/1000){this.saved=false;this.pendingTemplate=null;}
    let repeat=0;
    if(this.hadContrast&&this.grooveAge>period*8/1000)for(const template of this.templates){let d=0;for(let i=0;i<3;i++)d+=Math.abs(template[i]-this.texture[i]);repeat=Math.max(repeat,Math.max(0,1-d/1.2));}
    // Preparatory tension is a causal cue, not a claim of lyrical pre-chorus recognition.
    const tensionTarget=Math.min(1,this.riseFor/4);
    this.tension+=(tensionTarget-this.tension)*(1-Math.exp(-dt/(tensionTarget>this.tension?.4:1.5)));
    let next,confidence;
    if(t-this.dropAt<period*8){next='drop';confidence=.88;}
    else if(this.riseFor>2.4){next='buildup';confidence=Math.min(.9,.6+this.riseFor*.06);}
    else if(!this.hasGroove&&t-this.started<90000){next='intro';confidence=.7;}
    else if(quiet){next='breakdown';confidence=.8;}
    else if(repeat>.72&&energetic){next='chorus';confidence=Math.min(.88,.6+repeat*.25);}
    else{next='groove';confidence=.65;}
    if(next!==this.candidate){this.candidate=next;this.candidateAt=t;}
    if(next===this.name||t-this.candidateAt>Math.max(1800,period*4))this.set(next,confidence,t);
  }
  state(t: number){return {section:t-(this.last||0)>600?'listening':this.name,sectionConfidence:this.confidence,sectionAge:Math.max(0,t-this.changedAt)/1000,sectionSerial:this.serial,dropId:this.dropId,dropPending:t-(this.last||0)<600&&!!this.pendingDrop,fakeDrop:t-(this.last||0)<600?Math.exp(-Math.max(0,t-this.fakeDropAt)/1200):0,drop:Math.exp(-Math.max(0,t-this.dropAt)/450),dropStrength:this.dropId?(this.dropStrength||0):0,build:Math.min(1,this.riseFor/4),tension:t-(this.last||0)>600?0:this.tension,performanceMood:t-(this.last||0)>600?'quiet':this.name==='buildup'?'building':this.highEnergy?'peak':this.name==='breakdown'||this.name==='intro'||this.name==='listening'?'quiet':'groove',chorus:this.name==='chorus'?this.confidence:0,intro:this.name==='intro'?this.confidence:0};}
}

// Online two-bar drum memory. Observations stay separate from predictions:
// learned expectations can prepare motion, but never emit kick/snare events.
export class GroovePredictor {
  [k: string]: any;
  constructor(){this.reset();}
  reset(){this.seen=new Float32Array(16);this.kicks=new Float32Array(16);this.snares=new Float32Array(16);this.cell=null;this.hitK=0;this.hitS=0;this.epoch=null;this.period=0;this.last=-1e9;this.lastDrum=-1e9;this.lastKick=-1e9;this.lastSnare=-1e9;this.style='learning';this.candidate='';this.candidateAt=0;this.styleConfidence=0;this.patternError=0;this.residuals=[];}
  probability(kind: string,slot: number){const n=this.seen[slot];return n<2?0:(this[kind][slot]+.1)/(n+.5);}
  expectedKick(t: number,g: any){if(g._stableGrid?.transitioning||this.patternError>.2||!g.locked||!g.anchorSet||t-this.lastKick>Math.max(1800,g._period()*4))return 0;const coordinate=(t-g.detectLatencyMs-g.leadMs-g.anchorMs)/g._period()*2,nearest=Math.round(coordinate);if(Math.abs(coordinate-nearest)>.18)return 0;return this.probability('kicks',((nearest%16)+16)%16);}
  push(t: number,f: any,g: any){
    const period=g._period();if(!g.locked||!g.anchorSet||!period)return;
    if(this.epoch!==g.anchorEpoch||(this.period&&Math.abs(period/this.period-1)>.12)||t-this.last>2500){this.reset();this.epoch=g.anchorEpoch;}
    this.period=period;this.last=t;
    const coordinate=(t-g.detectLatencyMs-g.leadMs-g.anchorMs)/period*2,cell=Math.floor(coordinate+.5);
    if(this.cell!==null&&cell!==this.cell){
      if(cell===this.cell+1){const slot=((this.cell%16)+16)%16;if(this.seen[slot]>=2){const error=(Math.abs(this.probability('kicks',slot)-this.hitK)+Math.abs(this.probability('snares',slot)-this.hitS))/2;this.patternError+=(error-this.patternError)*.15;}this.seen[slot]=this.seen[slot]*.88+1;this.kicks[slot]=this.kicks[slot]*.88+this.hitK;this.snares[slot]=this.snares[slot]*.88+this.hitS;}
      this.hitK=0;this.hitS=0;
    }this.cell=cell;
    if(f.kick){this.hitK=1;this.lastKick=t;}
    if(f.snare){this.hitS=1;this.lastSnare=t;}
    if(f.kick||f.snare){this.lastDrum=t;const residual=(coordinate-Math.round(coordinate))*period/2;this.residuals.push(residual);if(this.residuals.length>48)this.residuals.shift();}
    let even=0,odd=0,kickSum=0,snapSum=0;for(let i=0;i<16;i++){const k=this.probability('kicks',i);kickSum+=k;snapSum+=this.probability('snares',i);if(i%2)odd+=k;else even+=k;}
    const coverage=Math.min(...this.seen),confidence=Math.min(1,coverage/4);
    let style='learning';if(coverage>=2){
      if(t-this.lastDrum>period*6)style='ambient';
      else if(even/8>.58&&odd/8<.24)style='four-on-floor';
      else if(snapSum<2.8&&snapSum>.6&&kickSum<4.5)style='half-time';
      else if(g.bpm>=155&&kickSum>1.2)style='fast-breakbeat';
      else style='broken-beat';
    }
    if(style!==this.candidate){this.candidate=style;this.candidateAt=t;}
    if(t-this.candidateAt>2000||style===this.style){this.style=style;this.styleConfidence=confidence;}
  }
  state(t: number,g: any){
    const fresh=t-this.last<500&&g._silentMs<400,active=fresh&&!g._stableGrid?.transitioning&&t-this.lastDrum<Math.max(1200,this.period*3),events=[];
    let confidence=0,anticipation=0;
    if(active&&g.locked&&this.period){const coordinate=(t-g.anchorMs)/this.period*2,first=Math.floor(coordinate)+1;
      for(let n=first;n<first+4;n++){const slot=((n%16)+16)%16,at=g.anchorMs+n*this.period/2;
        for(const [kind,key] of [['kick','kicks'],['snare','snares']]){if(t-(kind==='kick'?this.lastKick:this.lastSnare)>this.period*4)continue;const p=this.probability(key,slot)*Math.min(1,g.confidence/.8)*Math.max(0,1-this.patternError*2);if(p>.6){events.push({kind,atMs:at,confidence:p});confidence=Math.max(confidence,p);if(kind==='kick'&&at-t<150)anticipation=Math.max(anticipation,p*(1-(at-t)/150));}}
      }
    }
    const hints: Record<string, string>={'four-on-floor':g.bpm>=145?'hard dance / techno':'house / dance','half-time':'halftime / bass / hip-hop','fast-breakbeat':'drum and bass / fast breaks','broken-beat':'breakbeat / syncopated','ambient':'ambient / breakdown',learning:'learning'};
    const mean=this.residuals.reduce((a: number,b: number)=>a+b,0)/Math.max(1,this.residuals.length),variance=this.residuals.reduce((a: number,b: number)=>a+(b-mean)**2,0)/Math.max(1,this.residuals.length);
    const styleTrust=active?this.styleConfidence*Math.max(0,1-this.patternError*2):0;
    const profile=({'four-on-floor':[1, .75,1.2],'half-time':[.5,1.5,.8],'fast-breakbeat':[1,1.25,.8],'broken-beat':[.85,1.4,.95]} as Record<string, number[]>)[this.style]||[1,1,1];
    const weight=clamp01((styleTrust-.35)/.45);
    return {dancePace:1+(profile[0]-1)*weight,danceSway:1+(profile[1]-1)*weight,dancePunch:1+(profile[2]-1)*weight,patternReliability:active?Math.max(0,1-this.patternError*2):0,rhythmStyle:active?this.style:'learning',genreHint:active?hints[this.style]:'listening',styleConfidence:styleTrust,predictionConfidence:confidence,upcomingDrums:events,anticipation, timingUncertaintyMs:Math.max(10,Math.sqrt(variance)),rhythmicDensity:active?Math.min(1,(this.kicks.reduce((a: number,b: number,i: any)=>a+this.probability('kicks',i),0)+this.snares.reduce((a: number,b: number,i: any)=>a+this.probability('snares',i),0))/12):0};
  }
}

// Stable spectrum summary for visuals. Six worklet bands (sub 48-90 Hz,
// bass 90-190, lowMid 190-520, mid 520-1.7k, highMid 1.7-5.2k, high
// 5.2-12k) with a slow per-band AGC: 1 = the band's recent peak (8 s
// release, floored at 30 % of a 60 s peak so a breakdown's noise floor is
// not boosted to full scale), 0 = 36 dB below it. Levels attack instantly
// and release over ~90 ms so 60 fps sampling does not alias 94 Hz hops.
// centroid: energy-weighted log-frequency position (0 = 60 Hz, 1 = 10 kHz).
// flux: superflux onset strength under the same AGC. Fields are always
// present; they fall to 0 when audio stops.
export class SpectrumBands {
  [k: string]: any;
  constructor() {
    this.keys = ['sub', 'bass', 'lowMid', 'mid', 'highMid', 'high'];
    this.centers = [66, 131, 318, 941, 2973, 7899];
    this.peak = new Float64Array(7).fill(1e-4); this.longPeak = new Float64Array(7).fill(1e-4);
    this.level = new Float64Array(7); this.centroid = 0; this.last = null;
  }
  push(t: number, ...vals: any[]) {
    const dt = this.last === null ? 0.0107 : clamp((t - this.last) / 1000, 0, 0.2); this.last = t;
    const rel = Math.exp(-dt / 0.09);
    let num = 0, den = 0;
    for (let i = 0; i < 7; i++) {
      const v = Math.max(0, Number(vals[i]) || 0);
      this.longPeak[i] = Math.max(v, this.longPeak[i] * Math.pow(0.5, dt / 60));
      this.peak[i] = Math.max(v, this.peak[i] * Math.pow(0.5, dt / 8), this.longPeak[i] * 0.3, i < 6 ? 1e-4 : 1e-3);
      const r = v / this.peak[i];
      const x = i < 6 ? clamp01(1 + 20 * Math.log10(Math.max(r, 1e-6)) / 36) : clamp01(r);
      this.level[i] = Math.max(x, this.level[i] * rel);
      // pink-compensated amplitude weighting: flat for typical mixes, so it
      // tracks brightness instead of sitting on the kick's energy
      if (i < 6) { const e = v * Math.sqrt(this.centers[i] / 66); num += e * Math.log(this.centers[i] / 60) / Math.log(10000 / 60); den += e; }
    }
    const c = den > 1e-9 ? clamp01(num / den) : this.centroid;
    this.centroid += (c - this.centroid) * (1 - Math.exp(-dt / 0.12));
  }
  state(t: number) {
    const live = this.last !== null && t - this.last < 500;
    const out: any = {};
    for (let i = 0; i < 6; i++) out[this.keys[i]] = live ? this.level[i] : 0;
    out.centroid = live ? this.centroid : 0;
    out.flux = live ? this.level[6] : 0;
    return out;
  }
}

// Continuous show energy, independent of drum labels and tempo lock.
export class PerformanceEnergy {
  [k: string]: any;
  constructor(){this.fast=0;this.slow=0;this.intensity=0;this.last=null;this.hotFor=0;this.coolFor=0;this.high=false;this.surgeId=0;this.lastSurge=-1e9;this.riseFor=0;this.surgeArmed=true;}
  push(t: number,f: any){
    const dt=this.last===null?.01:clamp((t-this.last)/1000,0,.2);this.last=t;
    const level=clamp01(f.level||0),body=clamp01(f.body||0),brightness=clamp01(f.brightness||0),activity=clamp01(f.activity||0);
    const power=smoothstep(.025,.52,level),breadth=smoothstep(.015,.30,body+brightness);
    const target=level<SILENCE?0:clamp01(power*(.64+.24*breadth)+.12*activity);
    this.fast+=(target-this.fast)*(1-Math.exp(-dt/.18));
    this.slow+=(target-this.slow)*(1-Math.exp(-dt/5));
    // Contrast against this track's own loud reference: measured on the
    // rekordbox library, breakdowns/builds sit only 3-5 dB under the chorus,
    // which the absolute curve maps to ~0.08. Expanding the deficit below a
    // slowly decaying peak (0.8 s average, floor 0.45) spreads sections
    // apart without lowering the loudest part of any track.
    this.mid=(this.mid||0)+(target-(this.mid||0))*(1-Math.exp(-dt/(target>(this.mid||0)?.2:.8)));
    this.ref=Math.max(this.mid,.45,(this.ref||0)-dt*.008);
    const shown=clamp01(this.fast-1.2*Math.max(0,this.ref-this.mid));
    this.intensity+=(shown-this.intensity)*(1-Math.exp(-dt/(shown>this.intensity?.22:1.0)));
    this.hotFor=this.intensity>.68?this.hotFor+dt:0;this.coolFor=this.intensity<.48?this.coolFor+dt:0;
    if(this.hotFor>.3)this.high=true;if(this.coolFor>1.2)this.high=false;
    const lift=this.fast-this.slow;this.riseFor=lift>.18&&this.fast>.68?this.riseFor+dt:0;
    if(lift<.06||this.fast<.4)this.surgeArmed=true;
    if(this.surgeArmed&&this.riseFor>.12&&t-this.lastSurge>7000){this.surgeArmed=false;this.surgeId++;this.lastSurge=t;this.riseFor=0;}
  }
  state(t: number){const fresh=this.last!==null&&t-this.last<500;return {performanceIntensity:fresh?this.intensity:0,highEnergy:fresh&&this.high,energyLift:fresh?Math.max(0,this.fast-this.slow):0,surge:fresh?Math.exp(-Math.max(0,t-this.lastSurge)/650):0,surgeId:this.surgeId};}
}

export class BeatEngine {
  [k: string]: any;
  constructor(opts: any = {}) {
    if (opts.dbnFps) { DBN_FPS = opts.dbnFps; DBN_STEP_MS = 1000 / DBN_FPS; }
    const HIST = 192;
    this.histLen = HIST;
    this.histIdx = 0;
    this.histFilled = 0;

    this.hist = {};
    this.envFast = {};
    this.envSlow = {};
    this.peak = {};
    this.lastBandAt = {};
    for (const b of BANDS) {
      this.hist[b] = new Float32Array(HIST);
      this.envFast[b] = 0;
      this.envSlow[b] = 0;
      this.peak[b] = 0.12;
      this.lastBandAt[b] = -1e9;
    }
    this._sortBuf = new Float32Array(HIST);
    this.prevBins = null;

    // Visuals should land ON the transient after browser-source + display
    // latency; the grid is shifted this far ahead of the audio clock.
    this.leadMs = opts.leadMs != null ? opts.leadMs : 0;
    this.manualTempo=false; this.externalClock=false; this._linkAt=-1e9; this.phaseErrorMs=0; this.section="listening"; this._sectionAt=0; this._dropUntil=0; this._tapTimes=[];this._sections=new MusicSectionTracker();this._groove=new GroovePredictor();this._performanceEnergy=new PerformanceEnergy();this._sampledSurgeId=0;this._sectionSnareId=0;this._sampledDropId=0;this._sampledSectionSerial=0;
    // Detection latency of the activation chain (STFT window + 1-hop
    // peak-picking lookahead + slot). Calibrated on the synthetic bench.
    this.detectLatencyMs = 30;

    this.refractoryMs = 110;
    this.hardRefractoryMs = 200;
    this.bandRefractoryMs = 70;
    this.lastBeatAt = -1e9;
    this.lastHardAt = -1e9;
    this.lastOnsetAt = -1e9;

    // ---- tracker ----
    this._dbn = new DbnBeatTracker(Object.assign({ fps: DBN_FPS, minBpm: 62, maxBpm: 245 }, opts.dbn || {}));
    this._dbnNextT = null;         // ms of the next internal observation slot
    // Published tempo range (octave folding). Measured against rekordbox
    // grids (scripts/eval-rekordbox.js). 70-232 (was 85-190): lo-fi / boom-bap at 70-85 stays at its own tempo
    // instead of a frantic double, and hardcore / uptempo (190-230) is no longer halved (tools/beat/bench.ts).
    this.bpmRange = opts.bpmRange || [70, 232];
    this._spectrum = new SpectrumBands();
    this._stableGrid = new StableBeatGrid();
    this._stableGrid.fold = (b: number) => this._foldBpm(b); this._stableGrid.range = this.bpmRange;
    this._phaseCorrectionAt = -Infinity;
    this._dbnPend = 0;             // max activation seen since the last slot
    this._dbnLastT = 0;
    this.bpm = 0;
    this.confidence = 0;
    this.locked = false;
    this._lockFrames = 0;
    this._unlockMs = 0;
    this.anchorMs = 0;             // time of a reference beat (render clock)
    this.anchorSet = false;
    this.anchorEpoch = 0;
    this._jumpMs = 0;              // how long the MAP tempo has disagreed with bpm
    this._periodMs = 0;            // PLL loop variable (bpm = 60000 / _periodMs)
    this._phaseDisagreeMs = 0;

    // activation whitening / baseline / peak picking
    this._sfPeak = 0.05; this._sfBase = 0; this._sfPeakLong = 0.05;
    this._sfLowPeak = 0.03; this._sfLowBase = 0; this._sfLowPeakLong = 0.03;
    this._sfHighPeak = 0.03; this._sfHighPeakLong = 0.03;
    this._actMean = 0;
    this._act1 = 0; this._act2 = 0;       // a[n-1], a[n-2] for lookahead peak picking
    this._actEmitAt = -1e9; this._actEmitVal = 0;
    this._actRecentMax = 0;
    this._actOnsetAt = -1e9;
    this._evidence = 0;            // recent STRONG onset evidence (coast gate)
    this._strongAtMs = -1e9;       // time of the last strong onset
    this._coasting = false;

    // Grid emission (render clock)
    this._gridK = null;
    this._gridEpoch = -1;

    // Downbeat accumulation: onset strength per (beatIndex mod 4)
    this._barAcc = new Float32Array(4); this._snapAcc = new Float32Array(4); this._tonalAcc = new Float32Array(4); this._snapPeakK = 0; this._tonalPeakK = 0;
    this._lowHist = new Float64Array(2 * 900); this._lowIdx = 0; this._parityVotes = 0; this._parityAt = 0; this._parityEpoch = -1; this._parityOk = false;
    this._downbeatSlot = 0; this._barK = null; this._barPeak = 0; this._barBeats = 0;

    // Output envelopes + latches
    this.pulse = 0;
    this.flash = 0;
    this.strength = 0;
    this.lastBand = 'idle';
    this._evtBeat = false;
    this._evtHard = false;
    this._evtDown = false;

    this._masterNovelty = 0;
    this.drive = 0;
    this._rumble = 0;
    this._kickTransient = 0;
    this._kickAct = 0;
    this._kickActFast = 0;
    this._sinceKickMs = 1e9;
    this._lastKickHitMs = -1e9;
    this._kickId = 0;
    this._sampledKickId = 0;
    this._snareId = 0; this._sampledSnareId = 0;
    this._subPeak = 0.015;
    this._kickReady = true;
    this._kickPrev = 0;
    this._dropArmed = false;
    this._brightPrev = 0;
    this.kick = 0;
    this.hat = 0;
    this.snare = 0;
    this._snapPeak = 0.02;
    this._snareReady = true;
    this._lastSnareMs = -1e9;
    this._thumpPeak = 0.01;
    this._clickPeak = 0.01;
    this._lowAttackPeak = 0.01;
    this._legacyLow = 0;
    this._legacyMid = 0;
    this.drop = 0;
    this.build = 0;
    this.breakdown = 0;
    this.lifeEnergy = 0;
    this.lifeBright = 0;
    this._energyPrev = 0;
    this._silentMs = 0;
    this._lastPushMs = null;
    this._lastSampleMs = null;
    this._prevHop = null;
    this._hasSuperflux = false;
  }

  // Legacy combined entry point.
  update(tMs: number, bins: any) {
    this.pushFrame(bins, tMs);
    return this.sample(tMs);
  }

  // -----------------------------------------------------------------------
  // pushBandHop() — one worklet hop. 7 channels (v1) or 11 (v2, superflux).
  // -----------------------------------------------------------------------
  pushBandHop(tMs: number, rms: any) {
    if (!rms || rms.length < 6) return this._state(false, false, false, tMs);
    const EPS = 1e-4;
    const GATE = 0.004;
    const prev = this._prevHop;
    let flux = 0, lowFlux = 0, linLow = 0, clickFlux = 0, hatFlux = 0;
    if (prev) {
      for (let b = 0; b < 6; b++) {
        const cur = rms[b];
        const dLin = cur - prev[b];
        if (dLin > 0) {
          if (b <= 1) linLow += dLin;
          if (b === 4) clickFlux += dLin;
          if (b === 5) hatFlux += dLin;
        }
        if (cur < GATE) continue;
        const d = Math.log(cur + EPS) - Math.log(prev[b] + EPS);
        if (d > 0) {
          flux += d;
          if (b <= 1) lowFlux += d;
          if (b === 4) lowFlux += d * 0.55;
        }
      }
    } else {
      this._prevHop = new Float32Array(6);
    }
    this._prevHop.set(rms.subarray ? rms.subarray(0, 6) : rms.slice(0, 6));

    const squash = (x: number) => Math.log1p(Math.max(0, x) * 16) / Math.log1p(16);
    const kickHp = rms.length > 6 ? rms[6] : 0;
    const hasSf = rms.length >= 11;
    this._hasSuperflux = hasSf;
    const feat = {
      kick:      squash(rms[0]),
      body:      squash(rms[1]),
      lowMid:    squash(rms[2]),
      mid:       squash(rms[3]),
      presence:  squash(rms[4]),
      high:      squash(rms[5]),
      flux:      clamp01(flux / 2.4),
      lowFlux:   clamp01(lowFlux / 1.15),
      linLow:    clamp01(linLow * 8),
      clickFlux: clamp01(clickFlux * 10),
      hatFlux:   clamp01(hatFlux * 8),
      kickHp:    clamp01(kickHp * 8),
      snareBodyHp: rms.length >= 15 ? rms[14] * 8 : null,
      snapHp: rms.length >= 14 ? rms[12] * 8 : null,
      noiseFlatness: rms.length >= 14 ? rms[13] : null,
      lowRms: rms[0], midRms: rms[2] + rms[3], presenceRms: rms[4],
      midShare: (rms[2] + rms[3]) / Math.max(0.00001, rms[2] + rms[3] + rms[4] + rms[5]),
      subHp: rms.length >= 12 ? clamp01(rms[11] * 8) : null,
      lowShare: rms[0] / Math.max(0.00001, rms[0] + rms[1] + rms[2] + rms[4]),
      sf:     hasSf ? rms[7]  : -1,
      sfLow:  hasSf ? rms[8]  : -1,
      sfMid:  hasSf ? rms[9]  : -1,
      sfHigh: hasSf ? rms[10] : -1
    };
    this._spectrum.push(tMs, rms[0], rms[1], rms[2], rms[3], rms[4], rms[5], hasSf ? rms[7] : feat.flux);
    this._hopPow = { lowPow: rms[0] * rms[0] + rms[1] * rms[1], midHighPow: rms[3] * rms[3] + rms[4] * rms[4] + rms[5] * rms[5] };
    return this.pushFrame(null, tMs, feat);
  }

  peek(tMs: number) {
    const state=Object.assign(this._state(false,false,false,tMs),this._sections.state(tMs),this._groove.state(tMs,this),this._performanceEnergy.state(tMs));
    state.intensity=state.performanceIntensity;return state;
  }

  // ---- grid helpers (render clock) ----
  _period() { return this.bpm >= 40 ? 60000 / this.bpm : 0; }
  phase(tMs: number) {
    const P = this._period();
    if (!this.anchorSet || !P) return 0;
    const p = ((tMs - this.anchorMs) % P + P) % P;
    return p / P;
  }
  beatIndex(tMs: number) {
    const P = this._period();
    if (!this.anchorSet || !P) return 0;
    return Math.floor((tMs - this.anchorMs) / P);
  }
  nextBeatMs(tMs: number) {
    const P = this._period();
    if (!this.anchorSet || !P) return 0;
    return this.anchorMs + (this.beatIndex(tMs) + 1) * P;
  }

  // Called once per RENDER frame: decay envelopes, fire grid beats, deliver latches.
  sample(tMs: number) {
    if (this._lastSampleMs == null) this._lastSampleMs = tMs;
    let dt = (tMs - this._lastSampleMs) / 1000;
    this._lastSampleMs = tMs;
    if (!(dt >= 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    this.flash *= Math.pow(0.58, dt * 30);
    this.kick *= Math.pow(0.70, dt * 30);
    this.snare *= Math.exp(-dt / 0.13);
    this.hat *= Math.pow(0.90, dt * 30);
    this.drop *= Math.pow(0.90, dt * 30);
    this.build *= Math.pow(0.96, dt * 30);
    this.breakdown *= Math.pow(0.94, dt * 30);

    // ---- predictive grid emission ----
    let fired = false, firedHard = false, firedDown = false;
    const conf = this.confidence;
    const gridMode = this.locked && this.anchorSet && conf >= 0.28;
    const rhythmAlive = (tMs - this.lastOnsetAt) < 4000 || conf > 0.55;
    if (gridMode && rhythmAlive && this._silentMs < 400 && tMs-this._lastPushMs<500) {
      const P = this._period();
      const k = this.beatIndex(tMs);
      if (this._gridEpoch !== this.anchorEpoch || this._gridK === null) {
        this._gridEpoch = this.anchorEpoch;
        this._gridK = k;
      }
      // A new anchor can put its first beat beside the old grid's last
      // beat. Consume that crossing instead of emitting a double flash.
      const crossed=k>this._gridK;
      if(crossed)this._gridK=k;
      if (crossed && tMs - this.lastBeatAt > Math.max(this.refractoryMs,P*.55)) {
        this.lastBeatAt = tMs;
        fired = true;
        const s = clamp01(0.35 + this._masterNovelty * 1.4 + this._kickAct * 0.40);
        this.strength = clamp(s, 0.3, 1);
        const recentKick = (tMs - this._lastKickHitMs) < P * 0.55;
        if (recentKick) this.flash = Math.max(this.flash, Math.max(this.strength, this.kick));
        const slot = ((k % 4) + 4) % 4;
        firedDown = slot === this._downbeatSlot;
        // hard = the downbeat with a kick under it, or an exceptional hit
        const isHard = (firedDown && recentKick && conf > 0.35) ||
                       (recentKick && this.kick > 0.95 && this.strength > 0.9);
        if (isHard && tMs - this.lastHardAt > this.hardRefractoryMs) {
          this.lastHardAt = tMs;
          firedHard = true;
          this.flash = 1;
        }
      }
    }

    // Pulse: one-pole attack/release toward a phase groove that never collapses.
    let target = 0.22 + 0.50 * this.drive;
    if (this.locked && this.bpm >= 40) {
      const ph = this.phase(tMs);
      const swell = 0.42 + 0.58 * (0.5 + 0.5 * Math.cos(ph * Math.PI * 2));
      target = (0.26 + 0.62 * this.drive) * swell;
    }
    const atk = 1 - Math.exp(-dt / 0.055);
    const rel = 1 - Math.exp(-dt / 0.150);
    this.pulse += (target - this.pulse) * (target > this.pulse ? atk : rel);
    if (this.pulse < 0.001) this.pulse = 0;
    if (this.flash < 0.001) this.flash = 0;
    if (this.kick < 0.001) this.kick = 0;

    const fresh=tMs-this._lastPushMs<500;
    const beat = fresh&&(this._evtBeat || fired), hard = fresh&&(this._evtHard || firedHard), down = fresh&&(this._evtDown || firedDown);
    this._evtBeat = this._evtHard = this._evtDown = false;
    const state = this._state(beat, hard, down, tMs);
    state.kickHit = this._kickId !== this._sampledKickId && tMs - this._lastKickHitMs < 200;
    this._sampledKickId = this._kickId;
    state.snareHit = this._snareId !== this._sampledSnareId && tMs - this._lastSnareMs < 200;
    this._sampledSnareId = this._snareId;
    const arrangement=this._sections.state(tMs);
    Object.assign(state,arrangement);
    state.dropHit=arrangement.dropId!==this._sampledDropId&&arrangement.drop>.1;this._sampledDropId=arrangement.dropId;
    state.sectionChanged=arrangement.sectionSerial!==this._sampledSectionSerial;this._sampledSectionSerial=arrangement.sectionSerial;
    state.breakdown=arrangement.section==='breakdown'?arrangement.sectionConfidence:0;
    this.section=arrangement.section;
    state.barBeat=((state.beatIndex-this._downbeatSlot)%4+4)%4;
    state.phraseBeat=((state.beatIndex-this._downbeatSlot)%32+32)%32;
    state.phraseHit=state.downbeat&&state.phraseBeat===0;
    state.intensity=clamp01(this.drive*.6+this.lifeEnergy*.4);
    Object.assign(state,this._groove.state(tMs,this),this._performanceEnergy.state(tMs));
    state.surgeHit=state.surgeId!==this._sampledSurgeId&&state.surge>.1;this._sampledSurgeId=state.surgeId;
    state.intensity=state.performanceIntensity;
    state.scheduledBeatMs=this.anchorSet?this.anchorMs+state.beatIndex*this._period():0;
    return state;
  }

  // Operator controls preserve one shared clock across every scene.
  control(action: any,value: any,tMs: number){
    const tapped=action==='tap';
    if(action==='auto'){this.manualTempo=false;this._manualBar=false;this.externalClock=false;this._stableGrid.votes=[];return;}
    // Ableton Link (server/src/beat/abletonlink.js relays rekordbox's session):
    // value = {bpm, beat, playing, offsetMs} with beat measured at arrival.
    // The Link timeline becomes the grid; bar phase follows Link's quantum.
    if(action==='link'){
      const v=value;
      if(!v||!(v.bpm>=40&&v.bpm<=300)||!Number.isFinite(Number(v.beat))||v.playing===false){if(this.externalClock){this.externalClock=false;this._manualBar=false;this._stableGrid.votes=[];}return;}
      const P=60000/v.bpm,anchor=tMs+(Number(v.offsetMs)||0)-Number(v.beat)*P;
      const same=this.externalClock&&Math.abs(this._periodMs/P-1)<1e-4;
      if(same&&Math.abs(anchor-this.anchorMs)<25)this.anchorMs+=(anchor-this.anchorMs)*.3;   // network jitter
      else{this.anchorMs=anchor;this.anchorEpoch++;}
      this.bpm=Number(v.bpm);this._periodMs=P;this._stableGrid.period=P;this._stableGrid.confidence=1;
      this.anchorSet=true;this.locked=true;this.confidence=1;this.externalClock=true;this._linkAt=tMs;
      this._downbeatSlot=0;this._manualBar=true;
      return;
    }
    if(action==='tap'){
      if(this._tapTimes.length&&tMs-this._tapTimes.at(-1)>2000)this._tapTimes=[];
      this._tapTimes.push(tMs);this._tapTimes=this._tapTimes.slice(-8);
      if(this._tapTimes.length<3)return;
      value=60000/this._stableGrid.median(this._tapTimes.slice(1).map((v: number,i: any)=>v-this._tapTimes[i]));action='tempo';
    }
    if(action==='half'||action==='double'){value=this.bpm*(action==='half'?.5:2);action='tempo';}
    if(action==='tempo'&&Number.isFinite(Number(value))&&value>=40&&value<=300){
      const old=this._period(),phase=old?this.phase(tMs):0;
      this.bpm=Number(value);this._periodMs=60000/this.bpm;this._stableGrid.period=this._periodMs;
      this.anchorMs=tapped?tMs:tMs-phase*this._periodMs;this.anchorSet=true;this.locked=true;this.manualTempo=true;this.confidence=1;this._stableGrid.confidence=1;this.anchorEpoch++;
    }
    if(action==='downbeat') {this.anchorMs=tMs;this.anchorSet=!!this.bpm;this._downbeatSlot=0;this._manualBar=true;this.anchorEpoch++;}
    if(action==='nudge'&&Number.isFinite(Number(value)))this.anchorMs+=clamp(Number(value),-100,100);
    if(action==='offset'&&Number.isFinite(Number(value))){const next=clamp(Number(value),-250,250);this.anchorMs+=this.leadMs-next;this.leadMs=next;}
  }
  resetInput(tMs=0){const leadMs=this.leadMs,bpmRange=this.bpmRange,bpm=this.bpm,manual=this.manualTempo;Object.assign(this,new BeatEngine({leadMs,bpmRange}));if(manual)this.control("tempo",bpm,tMs);}

  // Called once per AUDIO frame with fresh spectral data.
  pushFrame(bins: any, tMs: number, feat?: any) {
    const hasFeat = feat && typeof feat.kick === 'number';
    if (!hasFeat && (!bins || bins.length < 32)) return this._state(false, false, false, tMs);

    let dt;
    if (this._lastPushMs == null) dt = 1 / 45;
    else dt = (tMs - this._lastPushMs) / 1000;
    this._lastPushMs = tMs;
    if (!(dt > 0)) dt = 1 / 45;
    if (dt > 0.2) dt = 0.2;

    // ---- band extraction ----
    let raw;
    if (hasFeat) {
      raw = {
        kick: feat.kick,
        body: Math.max(feat.body, (feat.lowMid || 0) * 0.55),
        mid:  Math.max(feat.mid, (feat.lowMid || 0) * 0.7),
        high: Math.max(feat.presence || 0, feat.high || 0),
        flux: Math.min(1, Math.max(feat.flux || 0, (feat.lowFlux || 0) * 1.05))
      };
    } else {
      raw = this._bandsFromBins(bins);
      this._spectrum.push(tMs, raw.kick, raw.body, raw.mid * 0.8, raw.mid, raw.high, raw.high * 0.8, raw.flux);
      this._hopPow = null;
    }

    // ---- silence gate ----
    const level = Math.max(raw.kick, raw.body, raw.mid, raw.high);
    if (level < SILENCE) {
      this._groove.push(tMs,{kick:false,snare:false},this);
      this._performanceEnergy.push(tMs,{level:0});
      this._sections.push(tMs,{level,bpm:this.bpm});
      this._silentMs += dt * 1000;
      if (this._silentMs > 600) {
        this._feedTracker(tMs, 0);
        if (this._silentMs > 8000 && this.anchorSet && !this.manualTempo) {
          this._dbn.reset(); this._stableGrid = new StableBeatGrid(); this._stableGrid.fold = (b: number) => this._foldBpm(b); this._stableGrid.range = this.bpmRange; this.bpm = 0; this._periodMs = 0; this.locked = false; this.confidence = 0; this.anchorSet = false; this.anchorEpoch++;
        }
        return this._state(false, false, false, tMs);
      }
    } else {
      this._silentMs = 0;
    }

    // ---- adaptive whitening + envelopes + novelty (reactive path / cues) ----
    let master = 0;
    let hatNov = 0;
    let bestBand = null, bestNovelty = 0;
    const onsets = [];
    for (const b of BANDS) {
      const v = raw[b];
      this.peak[b] = Math.max(v * 0.62, this.peak[b] * Math.pow(0.5, dt / 1.6));
      const norm = v / Math.max(0.06, this.peak[b]);
      const aS = coef30(0.045, dt), rS = coef30(0.010, dt);
      const aF = coef30(0.65, dt),  rF = coef30(0.22, dt);
      this.envSlow[b] = lerp(this.envSlow[b], norm, norm > this.envSlow[b] ? aS : rS);
      this.envFast[b] = lerp(this.envFast[b], norm, norm > this.envFast[b] ? aF : rF);
      const novelty = Math.max(0, this.envFast[b] - this.envSlow[b]);
      this.hist[b][this.histIdx] = novelty;
      const prof = PROFILE[b];
      const weighted = novelty * prof.w;
      if (weighted > master) master = weighted;
      if (b === 'high' || b === 'mid' || b === 'flux') hatNov = Math.max(hatNov, novelty);
      if (novelty > bestNovelty) { bestNovelty = novelty; bestBand = b; }
      if (tMs - this.lastBandAt[b] >= this.bandRefractoryMs && v > prof.absFloor) {
        const med = this._median(this.hist[b]);
        const mad = this._mad(this.hist[b], med);
        const thr = med + prof.kMad * Math.max(0.015, mad);
        if (novelty > thr && this.histFilled > 10) {
          const strength = clamp((novelty - med) / Math.max(0.02, mad) / 4.5, 0.3, 1);
          onsets.push({ band: b, strength });
          this.lastBandAt[b] = tMs;
        }
      }
    }
    this.histIdx = (this.histIdx + 1) % this.histLen;
    this.histFilled = Math.min(this.histFilled + 1, this.histLen);

    // ---- kick = TRANSIENT, not rumble RMS ----
    const rumbleNow = Math.max(raw.kick, raw.body);
    this._rumble = lerp(this._rumble, rumbleNow, rumbleNow > this._rumble ? coef30(0.06, dt) : coef30(0.025, dt));
    const lowHp = Math.max(0, rumbleNow - this._rumble * 1.12);
    const fKickHp    = hasFeat ? (feat.kickHp    || 0) : 0;
    const fClickFlux = hasFeat ? (feat.clickFlux || 0) : 0;
    const fLinLow    = hasFeat ? (feat.linLow    || 0) : 0;
    const fLowFlux   = hasFeat ? (feat.lowFlux   || 0) : (raw.flux || 0);
    const fHatFlux   = hasFeat ? (feat.hatFlux   || 0) : 0;
    const lowEvidence = Math.max(fLinLow, fLowFlux, clamp01(lowHp * 4.5));
    // The legacy kickHp channel includes the snare/click band. Use the
    // isolated sub attack when available, and require actual low energy.
    const hasLowShare = hasFeat && typeof feat.lowShare === 'number';
    const sub = hasLowShare ? (feat.subHp != null ? feat.subHp : fLinLow) : 0;
    // Keep a long reference as well as the fast peak: a repeating bass line
    // must not become a kick just because the real drums left the mix.
    // Apply the spectral mask BEFORE peak normalization. A loud snare can
    // leak into the sub filter; allowing that rejected energy into the peak
    // suppresses real kicks on the backbeat for the rest of the phrase.
    const kickShape=hasLowShare?smoothstep(.10,.30,feat.lowShare):1;
    const isolatedSub=sub*kickShape;
    this._subLongPeak=Math.max(isolatedSub,(this._subLongPeak||.006)*Math.exp(-dt/90));
    this._subPeak = Math.max(isolatedSub, this._subPeak * Math.exp(-dt / 12), this._subLongPeak*.9, 0.006);
    const kickTransient = hasLowShare
      ? clamp01(isolatedSub / this._subPeak)
      : clamp01(Math.max(fKickHp, lowEvidence));
    this._kickTransient = kickTransient;

    const P0 = this._period();
    const kickRefMs = this.locked && P0 ? clamp(P0 * 0.22, 65, 100) : 80;
    // A held bass envelope must release or attack again before another hit.
    const kickRise = kickTransient - this._kickPrev;
    this._kickPrev = kickTransient;
    if (kickTransient < (hasLowShare ? 0.18 : 0.09)) this._kickReady = true;
    const quietBeforeHitMs = this._sinceKickMs;
    // A quieter recurrence gets a lower threshold only after this exact slot
    // has repeated reliably. Spectral shape, re-arming, and refractory gates still apply.
    const expectedKick=this._groove.expectedKick(tMs,this);
    const kickThreshold=hasLowShare?(expectedKick>.68?.24:.60):.13;
    const kickHit = kickTransient > kickThreshold
      && (this._kickReady || kickRise > (hasLowShare ? 0.18 : 0.10))
      && (tMs - this._lastKickHitMs) >= kickRefMs
      && !(hasFeat && feat.snareBodyHp != null && tMs - this._lastSnareMs < 100
        && tMs - this._lastSnareOnset > 65);
    if (kickHit) {
      this._kickId++;
      this._kickReady = false;
      this._lastKickHitMs = tMs;
      this._sinceKickMs = 0;
      const spike = clamp01(0.62 + kickTransient * 0.55);
      this.kick = Math.max(this.kick, spike);
      this.flash = Math.max(this.flash, spike);
    } else {
      this._sinceKickMs += dt * 1000;
    }
    this._kickActFast = lerp(this._kickActFast, kickTransient, kickTransient > this._kickActFast ? 0.45 : 0.12);
    this._kickAct = lerp(this._kickAct, kickTransient, kickTransient > this._kickAct ? 0.22 : 0.045);

    // Hats
    this.hat = lerp(this.hat, clamp01(fHatFlux * 1.5), coef30(0.35, dt));
    if (bestBand === 'high' || bestBand === 'mid' || bestBand === 'flux') {
      for (const o of onsets) {
        if (o.band === 'high' || o.band === 'mid' || o.band === 'flux') this.hat = Math.max(this.hat, o.strength);
      }
    }

    // ---- BEAT ACTIVATION for the state-space tracker ----
    // Superflux (worklet v2) → whitened by a slow running peak, baseline
    // subtracted, soft-compressed to 0..1. Falls back to the envelope
    // novelty when the feed is v1 / visual bins.
    const sfRaw = (hasFeat && feat.sf >= 0) ? feat.sf : Math.max(raw.flux * 0.9, master * 0.6);
    const sfLowRaw = (hasFeat && feat.sfLow >= 0) ? feat.sfLow : Math.max(fLowFlux, lowHp * 3);
    // Broadband mid/high attacks are a snare/clap cue; sustained leads
    // and high-only hats should not fire the chorus. This is a cue, not stems.
    const midFlux = hasFeat ? Math.max(0, feat.sfMid || 0) : master;
    const highFlux = hasFeat ? Math.max(0, feat.sfHigh || 0) : fHatFlux;
    const detailedSnap = hasFeat && feat.snapHp != null;
    const texture = detailedSnap ? smoothstep(0.008, 0.06, feat.noiseFlatness) : 1;
    const bodyAttack = hasFeat && feat.snareBodyHp != null ? feat.snareBodyHp : null;
    this._snareBodyPeak = Math.max((this._snareBodyPeak || 0.001) * Math.exp(-dt / 12), 0.00005);
    const snap = detailedSnap ? Math.sqrt(Math.max(0, feat.snapHp) * midFlux) * texture
      : Math.sqrt(midFlux * highFlux);
    this._snapPeak = Math.max(snap, (this._snapPeak || 0.02) * Math.exp(-dt / 5), 0.02);
    // Do not normalize an absent/noisy component into a full-strength drum.
    this._snapLongPeak = Math.max(snap, (this._snapLongPeak || 0.02) * Math.exp(-dt / 40), 0.02);
    const snapCue = clamp01(snap / Math.max(this._snapPeak, this._snapLongPeak * 0.4)) * texture;
    if (snapCue < 0.25) this._snareReady = true;
    if (!detailedSnap) this._pendingSnare = null;
    if (this._pendingSnare) {
      const candidate = this._pendingSnare;
      candidate.low = Math.max(candidate.low, feat.lowRms || 0);
      candidate.mid = Math.max(candidate.mid, feat.midRms || 0);
      candidate.presence = Math.max(candidate.presence, feat.presenceRms || 0);
      candidate.strength = Math.max(candidate.strength, snapCue);
      candidate.body = Math.max(candidate.body, bodyAttack || 0);
      if (tMs - candidate.at >= 48) {
        // A beater click precedes its sub/body by several hops. Classify the
        // whole attack instead of emitting a snare before that body arrives.
        if (candidate.mid > candidate.low * 0.95 && feat.presenceRms > candidate.presence * 0.07
            && (bodyAttack == null || candidate.body > this._snareBodyPeak * 0.25)) {
          this._snareBodyPeak = Math.max(this._snareBodyPeak, candidate.body);
          this.snare = candidate.strength; this._snareId++; this._lastSnareMs = tMs; this._lastSnareOnset = candidate.at;
        }
        this._pendingSnare = null;
      }
    }
    if (!this._pendingSnare && this._snareReady !== false && snapCue > 0.55
        && (detailedSnap || midFlux > sfLowRaw * 0.65)
        && tMs - (this._lastSnareMs == null ? -1e9 : this._lastSnareMs) > 150) {
      this._snareReady = false;
      if (detailedSnap) this._pendingSnare = { at: tMs, low: feat.lowRms, mid: feat.midRms, presence: feat.presenceRms, body: bodyAttack || 0, strength: snapCue };
      else { this.snare = snapCue; this._snareId++; this._lastSnareMs = tMs; }
    }
    // Whitening peak: 3 s half-life, but floored at 30 % of a 40 s peak so a
    // breakdown / pad intro can't normalise its own noise floor up to 1.0.
    const sfHighRaw = (hasFeat && feat.sfHigh >= 0) ? feat.sfHigh : -1;
    this._sfPeakLong = Math.max(sfRaw, this._sfPeakLong * Math.pow(0.5, dt / 40));
    this._sfLowPeakLong = Math.max(sfLowRaw, this._sfLowPeakLong * Math.pow(0.5, dt / 40));
    this._sfHighPeakLong = Math.max(sfHighRaw, this._sfHighPeakLong * Math.pow(0.5, dt / 40));
    // (45 %: a track that is 10 dB quieter still saturates the kick cue, but
    // a breakdown bass at ~40 % of the kick's flux is not promoted to 1.0.)
    const FLOOR = 0.45;
    this._sfPeak = Math.max(sfRaw, this._sfPeak * Math.pow(0.5, dt / 3.0), this._sfPeakLong * FLOOR, 0.02);
    this._sfLowPeak = Math.max(sfLowRaw, this._sfLowPeak * Math.pow(0.5, dt / 3.0), this._sfLowPeakLong * FLOOR, 0.015);
    this._sfHighPeak = Math.max(sfHighRaw, this._sfHighPeak * Math.pow(0.5, dt / 3.0), this._sfHighPeakLong * FLOOR, 0.015);
    const sfN = sfRaw / this._sfPeak, sfLowN = sfLowRaw / this._sfLowPeak;
    const sfHighN = sfHighRaw >= 0 ? sfHighRaw / this._sfHighPeak : -1;
    this._sfBase = lerp(this._sfBase, sfN, coef30(0.12, dt));
    this._sfLowBase = lerp(this._sfLowBase, sfLowN, coef30(0.12, dt));
    // Compressive: a snare at ~⅓ of the kick's flux still reads ~0.75.
    const aFull = 1 - Math.exp(-4.0 * Math.max(0, sfN - this._sfBase * 1.05));
    const aLow  = 1 - Math.exp(-4.0 * Math.max(0, sfLowN - this._sfLowBase * 1.05));
    // DRUM CUE — "is this onset a drum hit?" (kick or snare), 0..1.
    // It is a SHAPE test on the event's own band shares, not a loudness
    // test: a drum hit is broadband — low thump AND high snap — whereas a
    // bass note has no high and a hat has no low. Measured shares
    // (low/high) on the bench: kick .29/.51, snare .22/.59, bass .23/.01,
    // open hat .01/.97, riser-swell-on-bass .28/.11. Two modest loudness
    // gates (whitened high flux, whitened total flux) reject a quiet hat
    // that happens to land on a bass note. Deliberately NOT scaled by
    // loudness: that let the loudest syncopated kick out-vote the on-beat
    // snares and the tracker settled on a 3:4 alias. Loudness ordering is
    // aFull's job.
    // (Also deliberately not the RMS-band kick transient: narrow low-band
    // RMS wobbles while a bass note decays and fired it at ~0.7 on frames
    // with zero spectral flux. That signal still drives the `kick` visual.)
    let kickCue;
    this._thumpPeak = Math.max(fKickHp, this._thumpPeak * Math.exp(-dt / 6), 0.002);
    this._clickPeak = Math.max(fClickFlux, this._clickPeak * Math.exp(-dt / 6), 0.002);
    this._lowAttackPeak = Math.max(fLinLow, this._lowAttackPeak * Math.exp(-dt / 6), 0.002);
    if (sfHighN >= 0) {
      const tot = feat.sfLow + feat.sfMid + feat.sfHigh + 1e-6;
      const sL = feat.sfLow / tot, sH = feat.sfHigh / tot;
      kickCue = smoothstep(0.05, 0.15, sL) * smoothstep(0.15, 0.32, sH)
        * smoothstep(0.22, 0.48, sfHighN) * smoothstep(0.22, 0.42, sfN);
      // Deep kicks need not have a high-frequency click, and claps need
      // not contain bass. Requiring both erased alternate beats and
      // confidently locked the tracker at half the actual tempo.
      const subAttack = smoothstep(0.25, 0.60, sfLowN)
        * smoothstep(0.20, 0.55, fLinLow / this._lowAttackPeak)
        * smoothstep(0.25, 0.60, sL);
      const clapAttack = smoothstep(0.35, 0.75, sfN)
        * smoothstep(0.25, 0.65, sfHighN)
        * smoothstep(0.25, 0.65, fClickFlux / this._clickPeak);
      kickCue = Math.max(kickCue, subAttack, clapAttack);
      // Coincident offbeat bass + hats can also look broadband. Require
      // a sharp drum attack relative to recent attacks, before awarding
      // the drum bonus. Keep separate references for kicks and snares.
      const attack = Math.max(subAttack, smoothstep(0.20, 0.50, fKickHp / this._thumpPeak),
        smoothstep(0.25, 0.65, fClickFlux / this._clickPeak));
      kickCue *= attack;
    } else if (hasFeat) {
      // v1 worklet feed: low-band rise coincident with a click-band rise
      const clickRise = fClickFlux * 1.6;
      kickCue = clamp01(2.0 * Math.min(lowEvidence * 1.4, clickRise));
    } else {
      // Visual-bin fallback has no clickFlux channel. Treat measured
      // low/mid attacks as evidence instead of permanently withholding it.
      const rise = Math.max(raw.kick - this._legacyLow, raw.mid - this._legacyMid);
      kickCue = smoothstep(0.025, 0.14, rise);
      this._legacyLow = raw.kick;
      this._legacyMid = raw.mid;
    }
    // Hat discount: an onset whose flux lives almost entirely above 2.5 kHz
    // is a hat/shaker, not a beat carrier. Scale it down so the tracker's
    // weak-onset rule treats it as subordinate.
    let hatDiscount = 1;
    if (hasFeat && feat.sfHigh >= 0) {
      const tot = feat.sfLow + feat.sfMid + feat.sfHigh + 1e-6;
      const hatness = feat.sfHigh / tot;
      hatDiscount = 1 - 0.55 * clamp01((hatness - 0.45) / 0.55);
    }
    // Drum attacks approach 1.0. Without a drum cue, x <= 0.24 stays below
    // 0.30 AFTER the soft knee, where the tracker prefers an offbeat.
    // The old 0.40 ceiling became ~0.48 after compression and accidentally
    // promoted bass notes/hats into additional beats.
    const x = clamp01(((0.18 + 0.46 * kickCue) * aFull + 0.06 * aLow) * hatDiscount + 0.42 * kickCue);
    // soft knee: nothing below 0.08, gentle compression above
    const actRaw = x <= 0.08 ? 0 : Math.pow((x - 0.08) / 0.92, 0.7);

    // Onset peak-picking (Böck-style): a frame is an onset if it is a local
    // maximum (one frame of lookahead), exceeds the local mean by a crest
    // margin, and is ≥ 70 ms after the previous onset unless clearly bigger.
    // The tracker therefore sees ONE clean spike per hit — no plateaus, no
    // 808 pitch-sweep smear, no dense noise from risers.
    let activation = 0;
    const a1 = this._act1, a2 = this._act2;
    this._actRecentMax *= Math.pow(0.5, dt / 1.5);
    if (a1 >= a2 && a1 > actRaw && a1 > this._actMean * 1.4 + 0.04 && a1 > this._actRecentMax * 0.12) {
      if (tMs - this._actEmitAt > 70 || a1 > this._actEmitVal * 1.4) {
        activation = a1;
        this._actEmitAt = tMs;
        this._actEmitVal = a1;
      }
    }
    if (a1 > this._actRecentMax) this._actRecentMax = a1;
    this._actMean = lerp(this._actMean, actRaw, coef30(0.10, dt));
    this._act2 = a1; this._act1 = actRaw;
    // Beat evidence (coast gate): only STRONG onsets count — a drum hit,
    // not a bass note or hat that whitening has promoted during a breakdown.
    const strong = activation >= 0.60 ? activation : 0;
    // Half-life scales with tempo (≥ 1.75 beats) so a sparse 78 BPM hip-hop
    // bar with a 1.75-beat gap between snare and kick doesn't read as a
    // breakdown; at 128 BPM this is the same 0.9 s as before.
    const evHalfLife = Math.max(0.9, (this._periodMs > 0 ? this._periodMs : 470) * 1.75 / 1000);
    this._evidence = Math.max(strong, this._evidence * Math.pow(0.5, dt / evHalfLife));
    if (strong > 0) this._strongAtMs = tMs;
    // low-band attack history for the beat/offbeat parity check
    this._lowHist[this._lowIdx] = tMs; this._lowHist[this._lowIdx + 1] = clamp(sfLowN, 0, 2);
    this._lowIdx = (this._lowIdx + 2) % this._lowHist.length;
    this._feedTracker(tMs, activation);

    // ---- tempo novelty / life energy (drives strength, build/drop) ----
    const tempoNov = (raw.flux || 0) * 1.15 + (raw.high || 0) * 0.42 + fHatFlux * 0.70
      + hatNov * 0.80 + master * 0.35 + kickTransient * 0.22 + aFull * 0.5;
    this._masterNovelty = Math.max(tempoNov, this._masterNovelty * Math.pow(0.62, dt * 30));

    this._performanceEnergy.push(tMs,{level,body:raw.kick+raw.body,brightness:raw.mid+raw.high,activity:Math.max(aFull,aLow,kickTransient)});
    const inst = clamp01(this._kickAct * 0.40 + (raw.mid + raw.high) * 0.28 + this._masterNovelty * 0.45);
    this.drive = inst > this.drive ? lerp(this.drive, inst, 0.16) : lerp(this.drive, inst, 0.05);
    const lvl = clamp01(this._kickAct * 0.55 + (raw.mid + raw.high) * 0.40 + this._masterNovelty * 0.20);
    this.lifeEnergy = lerp(this.lifeEnergy, lvl, lvl > this.lifeEnergy ? 0.16 : 0.05);
    const bright = clamp01((raw.high + raw.mid) * 0.55);
    this.lifeBright = lerp(this.lifeBright, bright, 0.12);
    const dE = this.lifeEnergy - this._energyPrev;
    this._energyPrev = this.lifeEnergy;
    const dBright = this.lifeBright - this._brightPrev;
    this._brightPrev = this.lifeBright;

    const locked = this.locked && this.bpm >= 50;
    const period = locked ? this._period() : 500;
    const quietBeats = this._sinceKickMs / period;
    const kickGone = this._kickAct < 0.10 && this._sinceKickMs > period * 1.5;

    // Phrase-scale evidence: brightness wiggles inside a verse are not a
    // build. Require a sustained rise while the kick pattern is absent.
    this._sectionBright = lerp(this._sectionBright == null ? bright : this._sectionBright, bright, 1 - Math.exp(-dt / 0.8));
    this._sectionBrightSlow = lerp(this._sectionBrightSlow == null ? bright : this._sectionBrightSlow, bright, 1 - Math.exp(-dt / 4));
    this._sectionEnergy = lerp(this._sectionEnergy || 0, lvl, 1 - Math.exp(-dt / 1));
    this._sectionPeak = Math.max(this._sectionEnergy, (this._sectionPeak || 0.1) * Math.exp(-dt / 30), 0.1);
    const missingPattern = this._sinceKickMs > period * 3;
    const quietSection = missingPattern && (this._kickAct < 0.12 || this._sectionEnergy < this._sectionPeak * 0.6);
    const rising = quietSection && this._sectionBright - this._sectionBrightSlow > 0.025;
    this._risingFor = rising ? (this._risingFor || 0) + dt : Math.max(0, (this._risingFor || 0) - dt * 2);
    if (quietSection) this.breakdown = Math.max(this.breakdown, 0.8);
    if (this._risingFor > 0.8) this.build = Math.max(this.build, clamp01(0.45 + this._risingFor * 0.12));
    if (quietSection && quietBeats >= 4) this._dropArmed = true;
    if (kickHit && quietBeforeHitMs / period > 3 && this._dropArmed) {
      this.drop = Math.max(this.drop, 0.95); this._dropArmed = false;
      this.build = 0; this.breakdown = 0;
    }
    if (kickHit) { this.breakdown *= 0.3; this.build *= 0.5; }

    if (locked) {
      this.refractoryMs = clamp(period * 0.34, 60, 180);
      this.hardRefractoryMs = clamp(period * 0.62, 100, 280);
    }

    this._groove.push(tMs,{kick:kickHit,snare:this._snareId!==this._sectionSnareId},this);
    this._sections.push(tMs,{level,bass:raw.kick+raw.body,bright,kick:kickHit,snare:this._snareId!==this._sectionSnareId,bpm:this.bpm,...this._performanceEnergy.state(tMs),...(hasFeat&&this._hopPow||{})});
    this._sectionSnareId=this._snareId;
    // Arrangement events land on bar lines: a detected drop, or the kick coming back after >= 2 bars without it,
    // votes for its beat slot as the downbeat (resolves 1-vs-3 when kick + backbeat can't).
    if (locked && this.anchorSet && !this._manualBar) {
      const vote = this._sections.dropId !== this._dbVoteDrop ? 1 : kickHit && quietBeforeHitMs > period * 7 ? 0.6 : 0;
      this._dbVoteDrop = this._sections.dropId;
      if (vote) {
        const at = vote === 1 ? (this._sections.dropStart ?? tMs) : tMs;
        const k = Math.round((at - this.detectLatencyMs - this.leadMs - this.anchorMs) / period), slot = ((k % 4) + 4) % 4;
        const m = Math.max(1e-3, ...this._barAcc);
        this._barAcc[slot] += m * 0.25 * vote; this._tonalAcc[slot] += Math.max(1e-3, ...this._tonalAcc) * 0.5 * vote; this._eventVotes = (this._eventVotes || 0) + vote;
      }
    }
    // ---- onset bookkeeping (downbeat model + reactive beats) ----
    let onset = null;
    for (const o of onsets) {
      const isLow = o.band === 'kick' || o.band === 'body';
      if (isLow && kickTransient < 0.14) continue;
      if (!onset || o.strength > onset.strength) onset = o;
    }
    if (kickHit && (!onset || onset.strength < 0.7)) onset = { band: 'kick', strength: clamp01(0.55 + kickTransient * 0.5) };
    // superflux peaks count as onsets too (sharper than the envelope tests)
    const actPeak = activation > 0.30 && (tMs - this._actOnsetAt) > this.refractoryMs * 0.6;
    if (actPeak) {
      this._actOnsetAt = tMs;
      if (!onset || onset.strength < activation) onset = { band: aLow > aFull * 0.8 ? 'kick' : 'flux', strength: clamp(activation, 0.3, 1) };
    }
    if (onset && tMs - this.lastOnsetAt > this.refractoryMs * 0.6) {
      this.lastOnsetAt = tMs;
      this.lastBand = onset.band;
    }

    // ---- downbeat model: low-band attack strength per bar slot ----
    // Measured on rekordbox grids: summed low-band onset strength at each
    // beat position picks the bar's first beat on 24/29 tracks, while snare
    // and harmonic-change cues added nothing. One sample per grid beat = the
    // strongest low-band superflux within ±50 ms of it (after latency).
    // When the low band can't tell (four-on-the-floor: a kick on every beat), two more cues break the tie: the
    // snare / clap backbeat (on 2 and 4 → the downbeat is the slot BEFORE a snare) and tonal change (chords
    // change on the bar line: mid-band flux on tonal, non-noisy frames). (tools/beat/bench.ts: hardstyle /
    // hardcore downbeats 0 → see the bench numbers.)
    if (locked && this.anchorSet && !this._manualBar) {
      const x = (tMs - this.detectLatencyMs - this.leadMs - this.anchorMs) / period, k = Math.round(x);
      if (this._barK !== k) {
        if (this._barK != null) {
          const slot = ((this._barK % 4) + 4) % 4;
          for (let i = 0; i < 4; i++) { this._barAcc[i] *= 0.99; this._snapAcc[i] *= 0.99; this._tonalAcc[i] *= 0.99; }
          this._barAcc[slot] += this._barPeak; this._snapAcc[slot] += this._snapPeakK; this._tonalAcc[slot] += this._tonalPeakK; this._barBeats++;
        }
        this._barK = k; this._barPeak = 0; this._snapPeakK = 0; this._tonalPeakK = 0;
      }
      if (Math.abs(x - k) * period < 50) {
        this._barPeak = Math.max(this._barPeak, clamp(sfLowN, 0, 2));
        this._snapPeakK = Math.max(this._snapPeakK, snapCue);
        if (hasFeat && feat.sfMid >= 0) this._tonalPeakK = Math.max(this._tonalPeakK, Math.max(0, feat.sfMid) * (1 - smoothstep(0.02, 0.12, feat.noiseFlatness ?? 0)));
      }
      const score = this._barScores();
      let bestSlot = 0;
      for (let i = 1; i < 4; i++) if (score[i] > score[bestSlot]) bestSlot = i;
      if (bestSlot !== this._downbeatSlot && this._barBeats >= 12 &&
          score[bestSlot] > score[this._downbeatSlot] + 0.08 &&
          tMs - (this._barChangeAt || 0) > period * 8) { this._downbeatSlot = bestSlot; this._barChangeAt = tMs; }
    }

    // ---- reactive beats while the tracker is not yet locked ----
    let fired = false, firedHard = false;
    const gridMode = this.locked && this.anchorSet && this.confidence >= 0.28;
    if (!gridMode && onset && tMs - this.lastBeatAt > this.refractoryMs) {
      this.lastBeatAt = tMs;
      fired = true;
      this.strength = onset.strength;
      if (onset.band === 'kick' || onset.band === 'body') {
        if (kickHit) {
          this.flash = Math.max(this.flash, onset.strength);
          this.kick = Math.max(this.kick, 0.7 + onset.strength * 0.3);
        }
      } else {
        this.hat = Math.max(this.hat, onset.strength);
      }
      const isHard = kickHit && onset.strength > 0.75;
      if (isHard && tMs - this.lastHardAt > this.hardRefractoryMs) {
        this.lastHardAt = tMs;
        firedHard = true;
        this.flash = 1;
      }
    }
    if (fired)     this._evtBeat = true;
    if (firedHard) this._evtHard = true;

    return this._state(fired, firedHard, false, tMs);
  }

  // -----------------------------------------------------------------------
  // Feed the DBN on its fixed 100 Hz slot grid (max-hold resampling of the
  // hop-rate activation), then pull the posterior into (bpm, anchor, conf).
  // -----------------------------------------------------------------------
  _feedTracker(tMs: number, activation: number) {
    if (this._dbnNextT == null) { this._dbnNextT = tMs; this._dbnPend = 0; }
    this._stableGrid.observe(tMs, activation);
    this._dbnPend = Math.max(this._dbnPend, activation);
    // stalled feed (hidden tab / reconnect): don't replay a thousand frames
    if (tMs - this._dbnNextT > 1500) this._dbnNextT = tMs;
    // Hold the published grid during sparse passages. The estimator still
    // receives real observations; no invented clicks reinforce its guess.
    const coasting = this.locked && this.anchorSet && this._evidence < 0.30 &&
      (tMs - this._strongAtMs) < 45000;
    this._coasting = coasting;
    let steps = 0;
    while (tMs >= this._dbnNextT && steps < 40) {
      const a = this._dbnPend;
      this._dbn.step(a);
      this._dbnLastT = this._dbnNextT;
      this._dbnNextT += DBN_STEP_MS;
      this._dbnPend = 0;            // an onset occupies ONE slot; extra slots are silence
      steps++;
    }
    if (!steps) return;
    if (this._dbn.frames < DBN_FPS * 1.2) return;   // < 1.2 s of evidence: nothing to say yet

    if(this.externalClock&&tMs-this._linkAt>3000){this.externalClock=false;this._manualBar=false;this._stableGrid.votes=[];}
    if(this.manualTempo||this.externalClock)return;
    const raw = this._dbn.estimate();
    // Octave policy: publish tempi inside the DJ range (like rekordbox's
    // analysis BPM range). Half-time rock/hip-hop grooves otherwise lock
    // at 62-93 BPM when the track is 124-185. Phase stays valid because a
    // folded grid contains every beat of the half/double grid.
    const est = { bpm: this._foldBpm(raw.bpm), conf: raw.conf, phaseR: raw.phaseR, phaseFrac: raw.phaseFrac };
    const previousPeriod = this._periodMs;
    const changed = this._stableGrid.update(tMs, est, coasting);
    if (!this._stableGrid.period) return;
    this.locked = true;
    this.confidence = this._stableGrid.confidence;
    const nextPeriod = this._stableGrid.period;
    // Preserve phase at the present beat when refining period. Keeping the
    // original anchor would multiply a tiny tempo change by track duration.
    if (this.anchorSet && previousPeriod && !changed) {
      const k = Math.floor((tMs - this.anchorMs) / previousPeriod);
      this.anchorMs += k * (previousPeriod - nextPeriod);
    }
    this._periodMs = nextPeriod;
    this.bpm = 60000 / nextPeriod;
    if (changed || !this.anchorSet) {
      if(changed&&previousPeriod&&Math.abs(nextPeriod/previousPeriod-1)>.06){
        // Confirmed tempo handoffs invalidate learned chorus textures and
        // pending drop preparation, without blacking out measured intensity.
        this._sections.templates=[];this._sections.pendingTemplate=null;
        this._sections.armed=false;this._sections.pendingDrop=null;this._sections.returnHits=0;this._sections.hadContrast=false;
        this._sections.riseFor=0;this._sections.tension=0;
      }
      const oldAnchor = this.anchorMs, hadAnchor = this.anchorSet;
      this.anchorMs = this._stableGrid.phaseOrigin(nextPeriod,tMs-6000,this._dbnLastT-raw.phaseFrac*(60000/raw.bpm))-this.detectLatencyMs-this.leadMs;
      this.anchorSet = true;
      this.anchorEpoch++;
      // Re-anchoring renumbers beats. Keep the bar evidence (and the chosen
      // downbeat) attached to absolute time when the tempo is the same song.
      if (hadAnchor && previousPeriod && Math.abs(nextPeriod / previousPeriod - 1) < .06) {
        const shift = ((Math.round((oldAnchor - this.anchorMs) / nextPeriod) % 4) + 4) % 4;
        for (const arr of [this._barAcc, this._snapAcc, this._tonalAcc]) { const acc = Array.from(arr); for (let i = 0; i < 4; i++) arr[(i + shift) % 4] = acc[i]; }
        if (!this._manualBar) this._downbeatSlot = (this._downbeatSlot + shift) % 4;
      } else { this._barAcc.fill(0); this._snapAcc.fill(0); this._tonalAcc.fill(0); this._barBeats = 0; }
      this._barK = null;
      this._phaseCorrectionAt = tMs;
      return;
    }
    // Robust phase-locked loop: correct a coherent cluster, ignore isolated
    // syncopation. A re-entry after a breakdown may be a new DJ cue point.
    if (!coasting && !this._stableGrid.transitioning && tMs - this._parityAt >= 2000) { this._parityAt = tMs; this._checkParity(tMs, nextPeriod); if (this._checkOctave(tMs, nextPeriod)) return; }
    if (coasting || tMs-this._phaseCorrectionAt<500)return;
    this._phaseCorrectionAt=tMs;
    const errors=[];
    for(const onset of this._stableGrid.onsets){
      if(onset<tMs-3000)continue;
      const d=onset-this.detectLatencyMs-this.leadMs-this.anchorMs;
      const e=d-Math.round(d/nextPeriod)*nextPeriod;
      if(Math.abs(e)<nextPeriod*.27)errors.push(e);
    }
    if(errors.length<4 && this._stableGrid.support(nextPeriod,tMs-3000)>.8){
      const origin=this._stableGrid.phaseOrigin(nextPeriod,tMs-3000,this.anchorMs)-this.detectLatencyMs-this.leadMs;
      const delta=origin-this.anchorMs,err=delta-Math.round(delta/nextPeriod)*nextPeriod;
      this.phaseErrorMs=err;
      if(Math.abs(err)>25)this.anchorMs+=clamp(err*.35,-24,24);
    }
    if(errors.length>=4){
      const e=this._stableGrid.median(errors),spread=this._stableGrid.median(errors.map(v=>Math.abs(v-e)));
      this.phaseErrorMs=e;
      if(spread<18&&Math.abs(e)>2)this.anchorMs+=clamp(e*.35,-12,12);
    }

  }

  // Offbeat-lock guard. Kicks land on beats: over the last 8 s the low-band
  // attack at grid beats beats the half-beat positions in 94 % of decisive
  // windows on the rekordbox library (offbeat bass, hats and hardstyle
  // reverse-bass tails included). Two consecutive clear losses (4 s) shift
  // the grid by half a beat.
  _checkParity(tMs: number, P: number) {
    const H = this._lowHist, lat = this.detectLatencyMs + this.leadMs;
    let on = 0, off = 0;
    for (let i = 0; i < H.length; i += 2) {
      const t = H[i], v = H[i + 1];
      if (!(t > tMs - 8000) || !v) continue;
      const x = (t - lat - this.anchorMs) / P, f = x - Math.floor(x);
      const d = Math.min(f, 1 - f) * P, dh = Math.abs(f - 0.5) * P;
      if (d < 40) on += v; else if (dh < 40) off += v;
    }
    // A grid whose beats have already been confirmed by on-beat low-end
    // attacks is kept: a later reversal is the arrangement (kick removed,
    // offbeat bass left playing), not a wrong lock.
    if (this._parityEpoch !== this.anchorEpoch) { this._parityEpoch = this.anchorEpoch; this._parityOk = false; }
    this._parityOnRun = on > off * 1.5 && on > 3 ? (this._parityOnRun || 0) + 1 : 0;
    if (on > off * 2 && on > 4 || this._parityOnRun >= 2) this._parityOk = true;
    if (!this._parityOk && off > on * 1.5 && off > 3) this._parityVotes++; else this._parityVotes = 0;
    if (this._parityVotes >= 2) {
      this.anchorMs += P / 2; this.anchorEpoch++; this._parityVotes = 0; this._parityEpoch = this.anchorEpoch; this._parityOk = true;
      this._barAcc.fill(0); this._snapAcc.fill(0); this._tonalAcc.fill(0); this._barBeats = 0; this._barK = null;
    }
  }

  // Octave-up guard (uptempo / hardcore / hardstyle locked at half time). A low-band attack on nearly EVERY beat
  // AND every half beat of the grid, about as strong, means the kick runs at twice the published tempo (a half-time
  // grid explains a four-on-the-floor kick at 220 just as well, and the tempo prior leans to it). Sparse patterns
  // (boom-bap kicks on the 'and', DnB's 2-step, offbeat bass in house) never cover every half beat.
  _checkOctave(tMs: number, P: number): boolean {
    if (this.manualTempo || this.externalClock || 120000 / P > this.bpmRange[1]) { this._octVotes = 0; return false; }
    const H = this._lowHist, lat = this.detectLatencyMs + this.leadMs, on = new Map<number, number>(), off = new Map<number, number>();
    for (let i = 0; i < H.length; i += 2) {
      const t = H[i], v = H[i + 1];
      if (!(t > tMs - 8000) || !v) continue;
      const x = (t - lat - this.anchorMs) / P, k = Math.floor(x), f = x - k;
      if (Math.min(f, 1 - f) * P < 40) { const kk = f < 0.5 ? k : k + 1; on.set(kk, Math.max(on.get(kk) ?? 0, v)); }
      else if (Math.abs(f - 0.5) * P < 40) off.set(k, Math.max(off.get(k) ?? 0, v));
    }
    const beats = Math.floor(8000 / P) - 1;
    const cov = (m: Map<number, number>) => [...m.values()].filter((v) => v > 0.35).length / Math.max(1, beats);
    const mean = (m: Map<number, number>) => { const v = [...m.values()]; return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };
    if (cov(on) > 0.8 && cov(off) > 0.8 && mean(off) > 0.6 * mean(on)) this._octVotes = (this._octVotes || 0) + 1; else this._octVotes = 0;
    if (this._octVotes < 2) return false;
    this._octVotes = 0;
    const next = P / 2, k = Math.floor((tMs - this.anchorMs) / P);
    this.anchorMs += k * P;   // keep the current beat as beat 0 of the new grid
    this._periodMs = next; this.bpm = 60000 / next; this._stableGrid.period = next; this._stableGrid.votes = []; this._stableGrid.lastChange = tMs;
    this.anchorEpoch++; this._barAcc.fill(0); this._snapAcc.fill(0); this._tonalAcc.fill(0); this._barBeats = 0; this._barK = null; this._phaseCorrectionAt = tMs;
    return true;
  }

  /** Downbeat score per bar slot: low-band attacks, + backbeat parity and tonal change when the low band is ambiguous. */
  _barScores(): number[] {
    const L = this._barAcc as Float32Array, S = this._snapAcc as Float32Array, T = this._tonalAcc as Float32Array;
    const lm = Math.max(1e-6, ...L), sm = Math.max(1e-6, ...S), tm = Math.max(1e-6, ...T);
    const sorted = Array.from(L).sort((a, b) => b - a);
    const ambig = sorted[0] < sorted[1] * 1.15 + 0.02 ? 1 : 0.25;
    const out = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const parity = (S[(i + 1) % 4] + S[(i + 3) % 4] - S[i] - S[(i + 2) % 4]) / sm;
      out[i] = L[i] / lm + ambig * (0.6 * parity + 0.4 * T[i] / tm);
    }
    return out;
  }

  _foldBpm(bpm: number) {
    const [lo, hi] = this.bpmRange;
    if (!(bpm > 0)) return bpm;
    while (bpm < lo && bpm * 2 < hi) bpm *= 2;
    while (bpm >= hi && bpm / 2 >= lo) bpm /= 2;
    return bpm;
  }

  _bandsFromBins(bins: any) {
    const kick = (bins[0] || 0) / 255;
    const body = Math.max(bins[1] || 0, bins[2] || 0, bins[3] || 0) / 255;
    let mMax = 0;
    for (let i = 4; i <= 12 && i < bins.length; i++) { const v = bins[i] || 0; if (v > mMax) mMax = v; }
    let hMax = 0;
    for (let i = 13; i <= 30 && i < bins.length; i++) { const v = bins[i] || 0; if (v > hMax) hMax = v; }
    let flux = 0;
    const prev = this.prevBins;
    if (prev && prev.length === bins.length) {
      for (let i = 0; i < bins.length; i++) { const d = (bins[i] - prev[i]) / 255; if (d > 0) flux += d; }
      flux /= bins.length;
    }
    if (!prev || prev.length !== bins.length) this.prevBins = new Uint8Array(bins.length);
    this.prevBins.set(bins);
    return { kick, body, mid: mMax / 255, high: hMax / 255, flux: Math.min(1, flux * 6) };
  }

  _median(arr: any) {
    const n = this.histFilled;
    const buf = this._sortBuf;
    for (let i = 0; i < n; i++) buf[i] = arr[i];
    buf.subarray(0, n).sort();
    return buf[n >> 1];
  }

  _mad(arr: any, med: number) {
    const n = this.histFilled;
    const buf = this._sortBuf;
    for (let i = 0; i < n; i++) buf[i] = Math.abs(arr[i] - med);
    buf.subarray(0, n).sort();
    return buf[n >> 1];
  }

  _state(beat: any, hard: any, downbeat: any, tMs: number): any {
    return {
      beat, hard, downbeat,
      pulse: this.pulse,
      flash: this.flash,
      strength: this.strength,
      bpm: this.bpm,
      confidence: this.confidence,
      phase: this.phase(tMs),
      band: this.lastBand,
      locked: this.locked,
      tempoTransition: !this.manualTempo&&!this.externalClock&&tMs-this._lastPushMs<500&&this._stableGrid.transitioning,
      gridStatus: tMs-this._lastPushMs>500?"no audio":this.manualTempo?"manual":this.externalClock?"link":this._stableGrid.status,
      phaseErrorMs: this.phaseErrorMs,
      section: this.section,
      sectionConfidence:this._sections.confidence,
      leadMs: this.leadMs,
      drive: this.drive,
      kick: this.kick,
      kickHit: false,
      hat: this.hat,
      snare: this.snare,
      snareHit: false,
      drop: this.drop,
      build: this.build,
      breakdown: this.breakdown,
      energy: this.lifeEnergy,
      brightness: this.lifeBright,
      nextBeatMs: this.nextBeatMs(tMs),
      beatIndex: this.beatIndex(tMs),
      superflux: this._hasSuperflux,
      spectrum: this._spectrum.state(tMs)
    };
  }
}

export class AudioHopClock {
  [k: string]: any;
  constructor(){this.offset=null;this.lastEnd=null;this.stream=null;this.delays=[];this.lastMapped=-Infinity;}
  map(msg: any,now: number){
    const n=msg.nBands,count=Math.floor((msg.hops||[]).length/n),hop=msg.hopMs;
    if(!Number.isFinite(msg.t0)||!Number.isFinite(hop)||hop<1||hop>100||!Number.isInteger(n)||n<7||n>32||count<1||count>64||msg.hops.some((v: number)=>!Number.isFinite(v)))return null;
    const end=msg.t0+(count-1)*hop;
    const reset=this.offset===null||this.stream!==msg.streamId||end<(this.lastEnd||0)-100;
    if(reset){this.offset=now-end;this.delays=[];this.lastMapped=-Infinity;}
    if(!reset&&end<=this.lastEnd)return null;
    this.stream=msg.streamId;this.lastEnd=end;
    this.delays.push(now-end);if(this.delays.length>128)this.delays.shift();
    const target=Math.min(...this.delays);
    this.offset=Math.min(target,this.offset+.02);
    let first=msg.t0+this.offset;
    // Drop delayed packets; never squeeze their samples together or replay hits.
    if(now-(first+(count-1)*hop)>250)return null;
    if(first<=this.lastMapped)return null;
    this.lastMapped=first+(count-1)*hop;
    return {first,count,reset,ageMs:now-this.lastMapped};
  }
}
