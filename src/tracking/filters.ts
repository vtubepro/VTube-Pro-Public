// Signal filters for tracking data.

/** One Euro filter (Casiez et al.) — low jitter at rest, low lag when moving fast. */
export class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private tPrev = 0;
  constructor(public minCutoff = 1.5, public beta = 0.02, public dCutoff = 1.0) {}

  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(value: number, t: number): number {
    if (this.x === null) {
      this.x = value;
      this.tPrev = t;
      return value;
    }
    const dt = Math.max(1e-3, t - this.tPrev);
    this.tPrev = t;
    const dxRaw = (value - this.x) / dt;
    const ad = OneEuro.alpha(this.dCutoff, dt);
    this.dx = this.dx + ad * (dxRaw - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = OneEuro.alpha(cutoff, dt);
    this.x = this.x + a * (value - this.x);
    return this.x;
  }

  reset() { this.x = null; this.dx = 0; }
}

/** A bank of One Euro filters keyed by channel name. */
export class OneEuroBank {
  private f = new Map<string, OneEuro>();
  constructor(public minCutoff = 1.5, public beta = 0.02, public dCutoff = 1.0) {}
  filter(key: string, v: number, t: number) {
    let e = this.f.get(key);
    if (!e) { e = new OneEuro(this.minCutoff, this.beta, this.dCutoff); this.f.set(key, e); }
    e.minCutoff = this.minCutoff; e.beta = this.beta; e.dCutoff = this.dCutoff;
    return e.filter(v, t);
  }
  reset() { this.f.clear(); }
}

/**
 * Latency-compensated One Euro filter for motion channels (head pose, head position).
 * - `speedScale` is the channel's "fast" speed in its own units per second (≈1 rad/s for rotation,
 *   ≈0.25 m/s for position): the speed boost is normalised by it, so one set of params works for any unit.
 * - `filter(v, t, lead)` returns the filtered value PREDICTED forward by the filter's own lag (1/2πfc) plus
 *   `lead` seconds (camera → display pipeline). Prediction is gated by speed — none at rest (no added
 *   jitter), full while moving — and uses a separately smoothed velocity so noise isn't amplified.
 */
export class LeadEuro {
  private x: number | null = null;
  private dx = 0;
  private v = 0;
  private tPrev = 0;
  gateLo = 0.08;
  gateHi = 0.35;
  /** Normalised speed treated as sensor noise (no cutoff boost / prediction below it). */
  deadband = 0;
  constructor(public minCutoff = 1.5, public beta = 1, public speedScale = 1, public dCutoff = 6, public maxLead = 0.12) {}
  private static alpha(cutoff: number, dt: number) { return 1 / (1 + 1 / (2 * Math.PI * cutoff * dt)); }
  filter(value: number, t: number, lead = 0): number {
    if (this.x === null) { this.x = value; this.tPrev = t; return value; }
    const dt = Math.max(1e-3, t - this.tPrev);
    this.tPrev = t;
    const prev = this.x;
    // speed estimate from the raw input (fast), used to open the cutoff
    const dxRaw = (value - prev) / dt;
    this.dx += LeadEuro.alpha(this.dCutoff, dt) * (dxRaw - this.dx);
    const speed = Math.max(0, Math.abs(this.dx) / this.speedScale - this.deadband);
    const cutoff = this.minCutoff + this.beta * speed * 10;
    this.x = prev + LeadEuro.alpha(cutoff, dt) * (value - prev);
    // velocity of the FILTERED signal (what we extrapolate), lightly smoothed
    this.v += LeadEuro.alpha(this.dCutoff, dt) * ((this.x - prev) / dt - this.v);
    const gate = smoothstep(this.gateLo, this.gateHi, speed);
    const L = Math.min(this.maxLead, lead + 1 / (2 * Math.PI * cutoff)) * gate;
    return this.x + this.v * L;
  }
  reset() { this.x = null; this.dx = 0; this.v = 0; }
}

export class LeadEuroBank {
  private f = new Map<string, LeadEuro>();
  gateLo = 0.08;
  gateHi = 0.35;
  deadband = 0;
  constructor(public minCutoff = 1.5, public beta = 1, public dCutoff = 6) {}
  filter(key: string, v: number, t: number, speedScale: number, lead = 0) {
    let e = this.f.get(key);
    if (!e) { e = new LeadEuro(this.minCutoff, this.beta, speedScale, this.dCutoff); this.f.set(key, e); }
    e.minCutoff = this.minCutoff; e.beta = this.beta; e.dCutoff = this.dCutoff; e.speedScale = speedScale;
    e.gateLo = this.gateLo; e.gateHi = this.gateHi; e.deadband = this.deadband;
    return e.filter(v, t, lead);
  }
  reset() { this.f.clear(); }
}

/**
 * Constant-velocity Kalman filter with latency compensation (the VR head-tracking approach).
 * State [x, v]; process noise = white acceleration (sigmaA, units/s²), measurement noise sigmaM (units).
 * `filter(z, t, lead)` returns x + v·lead: the value predicted `lead` seconds ahead (camera → display
 * latency). The prediction is gated by how CERTAIN the velocity is (|v| vs its std-dev), so sensor noise
 * at rest is never extrapolated into shake, while real motion is predicted in full.
 */
export class KalmanCV {
  private x = 0; private v = 0;
  private p00 = 1; private p01 = 0; private p11 = 1;
  private tPrev = -1;
  /** Velocity as used for prediction (confidence-gated), units/s — for render-rate / remote extrapolation. */
  vel = 0;
  /** Ungated velocity estimate and the prediction confidence gate (0..1) of the last update. */
  rawVel = 0;
  gate = 0;
  constructor(public sigmaA = 12, public sigmaM = 0.003, public maxLead = 0.12) {}
  filter(z: number, t: number, lead = 0): number {
    // first sample, or a long gap since the last one (a starved tracker: results 0.2-2 s apart): start over at the
    // measurement. The old 0.2 s clamp read a 0.9 s gap as 0.2 s, so the velocity came out 5-50x too large and the lead /
    // extrapolation threw the head far off (research/tracking_gpu_rca/RCA.md RC3: 36° RMS, steps up to 147° a frame).
    if (this.tPrev < 0 || t - this.tPrev > 0.2) {
      this.x = z; this.v = 0; this.vel = 0; this.rawVel = 0; this.gate = 0;
      this.p00 = this.sigmaM ** 2; this.p01 = 0; this.p11 = 1; this.tPrev = t; return z;
    }
    const dt = Math.max(1e-3, t - this.tPrev);
    this.tPrev = t;
    // predict
    const q = this.sigmaA * this.sigmaA;
    const dt2 = dt * dt, dt3 = dt2 * dt, dt4 = dt3 * dt;
    this.x += this.v * dt;
    const p00 = this.p00 + dt * (2 * this.p01 + dt * this.p11) + q * dt4 / 4;
    const p01 = this.p01 + dt * this.p11 + q * dt3 / 2;
    const p11 = this.p11 + q * dt2;
    // update
    const r = this.sigmaM * this.sigmaM;
    const s = p00 + r;
    const k0 = p00 / s, k1 = p01 / s;
    const y = z - this.x;
    this.x += k0 * y; this.v += k1 * y;
    this.p00 = (1 - k0) * p00; this.p01 = (1 - k0) * p01; this.p11 = p11 - k1 * p01;
    // confidence-gated prediction: extrapolate only a velocity clearly above its own uncertainty
    const sv = Math.sqrt(Math.max(this.p11, 1e-12));
    const gate = smoothstep(1.0, 3.0, Math.abs(this.v) / sv);
    this.vel = this.v * gate;
    this.rawVel = this.v; this.gate = gate;
    return this.x + this.v * Math.min(this.maxLead, lead) * gate;
  }
  reset() { this.tPrev = -1; this.vel = 0; this.rawVel = 0; this.gate = 0; }
}

export class KalmanBank {
  private f = new Map<string, KalmanCV>();
  vel(key: string) { return this.f.get(key)?.vel ?? 0; }
  filter(key: string, z: number, t: number, sigmaA: number, sigmaM: number, lead = 0) {
    let e = this.f.get(key);
    if (!e) { e = new KalmanCV(sigmaA, sigmaM); this.f.set(key, e); }
    e.sigmaA = sigmaA; e.sigmaM = sigmaM;
    return e.filter(z, t, lead);
  }
  reset() { this.f.clear(); }
}

/** Asymmetric exponential smoother: different speed rising vs falling (blinks close fast, open a bit slower). */
export class AsymEma {
  v = 0;
  constructor(public riseRate = 40, public fallRate = 22) {}
  step(target: number, dt: number) {
    const rate = target > this.v ? this.riseRate : this.fallRate;
    this.v += (target - this.v) * (1 - Math.exp(-rate * dt));
    return this.v;
  }
}

/** Critically damped spring toward a target (for procedural secondary motion). */
export class Spring1 {
  x = 0; v = 0;
  constructor(public freq = 4, public damping = 1) {}
  step(target: number, dt: number) {
    const w = 2 * Math.PI * this.freq;
    const a = w * w * (target - this.x) - 2 * this.damping * w * this.v;
    this.v += a * dt;
    this.x += this.v * dt;
    return this.x;
  }
}

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const clamp01 = (x: number) => clamp(x, 0, 1);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Map the user-facing smoothing slider (0..1) to One Euro params. */
export function smoothingToOneEuro(s: number): { minCutoff: number; beta: number } {
  // s=0 → very responsive (cutoff 6 Hz), s=1 → very smooth (cutoff 0.4 Hz)
  const minCutoff = 6 * Math.pow(0.4 / 6, clamp01(s));
  const beta = lerp(0.08, 0.004, clamp01(s));
  return { minCutoff, beta };
}
