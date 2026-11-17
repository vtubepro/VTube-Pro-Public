// Stabilisation layer: rock-steady at rest, instant in motion.
//
// A StabGroup holds the channels of ONE rigid thing (head rotation, head position, one arm, one hand …)
// because motion is judged jointly — a real move shows up coherently across a group, sensor noise doesn't.
//
// Per channel: (optional) constant-velocity Kalman → x̂, v̂ (no latency lead yet). Then:
//  • ADAPTIVE NOISE — each channel learns its own noise online: σd (spread of x̂ around its slow mean) and
//    σv (spread of v̂), as running 30th percentiles (set by the quiet moments, so real motion doesn't
//    inflate them), clamped to a physical range. Every threshold below is in units of these learned σ —
//    the same code works for any camera, resolution and lighting.
//  • STILLNESS WITH HYSTERESIS — motion score = max(RMS v̂/σv ÷ kV, max |x̂ − rest|/σd ÷ kD). Motion is
//    declared after 2 frames above 1 (or 1 frame above `burst`) and released only after `hold` seconds
//    below `calm`. `rest` is the value held when stillness began (it drifts slowly), so even a slow lean
//    accumulates displacement and releases the lock.
//  • LOCK — while still, the output is a backlash ("dead-zone") anchor: it only moves when a lightly
//    low-passed x̂ pushes it past ±dz (dz = dzK·σd, capped), plus a slow drift so no bias builds up. The dead zone
//    collapses to 0 the instant motion is declared, so the output is x̂ again within a frame — no pop
//    (the largest step is dz, a fraction of a degree) and no added lag in motion.
//  • PREDICTION — latency lead (x + v̂·lead) only when motion is REAL: gated by the stillness weight
//    AND the Kalman velocity confidence. Channels marked noLead (e.g. body depth) are never predicted.
import { KalmanCV, clamp } from './filters.ts';

export interface StabChannel {
  /** Initial / min / max noise σ of the filtered value (channel units). */
  sigma: [number, number, number];
  /** Kalman [sigmaA, sigmaM] (null = the value is already filtered; velocity by finite difference). */
  kalman?: [number, number] | null;
  /** Never extrapolate this channel (noisy depth). */
  noLead?: boolean;
  /** Fraction of the group's latency lead applied to this channel (default 1). */
  leadScale?: number;
  /** Dead-zone cap (channel units). Default 2·σmax. */
  dzMax?: number;
}

export interface StabOptions {
  kV?: number; /** Single-channel velocity threshold (σv). */ kVmax?: number; kD?: number; burst?: number; calm?: number; hold?: number;
  /** Dead-zone width in σd. */
  dzK?: number;
  /** Time constant of the anchor's drift toward x̂ while still (s). */
  driftTau?: number;
  maxLead?: number;
  /** Low-pass of x̂ that the lock follows (s). */
  lockTau?: number;
}

const DEF: Required<StabOptions> = { kV: 3.5, kVmax: 7, kD: 4.5, burst: 2.5, calm: 0.6, hold: 0.3, dzK: 2, driftTau: 1.2, maxLead: 0.12, lockTau: 0.12 };

class Ch {
  kal: KalmanCV | null;
  x = 0; v = 0; zPrev = NaN;
  /** x̂ low-passed (≈0.12 s) — what the lock follows, so single noisy frames never push the anchor. */
  xs = 0;
  slow = 0; varD: number; varV: number;
  anchor = 0; rest = 0;
  init = false;
  constructor(public c: StabChannel) {
    this.kal = c.kalman ? new KalmanCV(c.kalman[0], c.kalman[1]) : null;
    this.varD = c.sigma[0] ** 2;
    this.varV = (c.sigma[0] * 12) ** 2;
  }
  get sd() { return clamp(Math.sqrt(this.varD), this.c.sigma[1], this.c.sigma[2]); }
  get sv() { return clamp(Math.sqrt(this.varV), this.c.sigma[1] * 4, this.c.sigma[2] * 25); }
}

export class StabGroup {
  private ch: Ch[];
  private o: Required<StabOptions>;
  private tPrev = -1;
  private hot = 0;
  private calmT = 0;
  /** Motion state (true = moving) and smooth motion weight 0..1 (1 = moving: no lock, full prediction). */
  moving = true;
  m = 1;
  /** Last motion score (≥1 means motion) — diagnostics. */
  score = 0;
  /** Output velocities (prediction-gated), channel units/s — for render-rate extrapolation. */
  vel: number[];
  /** Seconds spent still (0 while moving). */
  stillFor = 0;
  /** Master switch: false = plain Kalman + prediction (the pre-stabiliser behaviour). */
  enabled = true;

  constructor(channels: StabChannel[], opts: StabOptions = {}) {
    this.ch = channels.map((c) => new Ch(c));
    this.o = { ...DEF, ...opts };
    this.vel = channels.map(() => 0);
  }

  /** Update Kalman tuning of channel i (smoothing slider). */
  tune(i: number, sigmaA: number, sigmaM: number) {
    const k = this.ch[i].kal;
    if (k) { k.sigmaA = sigmaA; k.sigmaM = sigmaM; }
  }

  reset() {
    for (const c of this.ch) { c.init = false; c.kal?.reset(); c.zPrev = NaN; }
    this.tPrev = -1; this.moving = true; this.m = 1; this.hot = 0; this.calmT = 0; this.stillFor = 0;
  }

  /** Learned noise σd per channel (diagnostics). */
  sigmas() { return this.ch.map((c) => c.sd); }

  /**
   * One measurement per channel at time t (s); returns the stabilised values predicted `lead` s ahead.
   * NaN inputs hold the channel (missing measurement). `w` (0..1 per channel, default 1) is the
   * measurement's trust: untrusted channels (an off-frame, hallucinated joint) neither release the lock
   * nor get extrapolated, and below 0.05 they are held.
   */
  step(z: number[], t: number, lead = 0, w?: number[]): number[] {
    const o = this.o;
    const first = this.tPrev < 0;
    // (a long gap since the last measurement — a starved tracker —: every channel's Kalman starts over at its new value,
    //  no velocity carried across the gap, gate 0: research/tracking_gpu_rca/RCA.md P1 item 2)
    const gap = !first && t - this.tPrev > 0.25;
    if (gap) for (const c of this.ch) c.kal?.reset();
    const dt = first ? 1 / 60 : clamp(t - this.tPrev, 1e-3, 0.25);
    this.tPrev = t;
    const gates: number[] = [];
    // ---- per-channel filtering ----
    for (let i = 0; i < this.ch.length; i++) {
      const c = this.ch[i];
      let zi = z[i];
      if (!Number.isFinite(zi) || (w && w[i] < 0.05 && c.init)) zi = c.init ? c.x : 0;
      if (!c.init) {
        c.init = true; c.x = zi; c.xs = zi; c.v = 0; c.slow = zi; c.anchor = zi; c.rest = zi; c.zPrev = zi;
        c.kal?.filter(zi, t, 0);
        gates.push(0);
        continue;
      }
      if (c.kal) {
        c.x = c.kal.filter(zi, t, 0);
        c.v = c.kal.rawVel;
        gates.push(c.kal.gate);
      } else if (gap) {
        c.v = 0; c.x = zi; gates.push(0);
      } else {
        const vr = (zi - c.zPrev) / dt;
        c.v += (vr - c.v) * (1 - Math.exp(-dt * 2 * Math.PI * 6));
        c.x = zi;
        gates.push(clamp((Math.abs(c.v) / c.sv - 1) / 2, 0, 1));
      }
      c.zPrev = zi;
    }
    if (first) return this.ch.map((c) => c.x);
    // ---- motion score (joint over the group) ----
    let sv2 = 0, dmax = 0, wsum = 0;
    for (let i = 0; i < this.ch.length; i++) {
      const c = this.ch[i], wi = w ? w[i] : 1;
      sv2 += wi * (c.v / c.sv) ** 2; wsum += wi;
      dmax = Math.max(dmax, wi * Math.abs(c.x - c.rest) / c.sd);
    }
    // RMS catches coherent motion of the whole group; the max term catches one channel moving alone
    // (a single finger curling among 28 hand channels)
    let vmax = 0;
    for (let i = 0; i < this.ch.length; i++) vmax = Math.max(vmax, (w ? w[i] : 1) * Math.abs(this.ch[i].v) / this.ch[i].sv);
    const zv = Math.max(Math.sqrt(sv2 / Math.max(1e-6, wsum)), vmax * o.kV / o.kVmax);
    // displacement from the held rest only matters while locked (it's what releases a slow lean);
    // once moving, "calm" is judged on velocity alone
    const score = this.moving ? zv / o.kV : Math.max(zv / o.kV, dmax / o.kD);
    this.score = score;
    if (!this.enabled) { this.moving = true; }
    else if (!this.moving) {
      this.hot = score > 1 ? this.hot + 1 : 0;
      if (this.hot >= 2 || score > o.burst) { this.moving = true; this.hot = 0; this.calmT = 0; }
    } else {
      this.calmT = score < o.calm ? this.calmT + dt : 0;
      if (this.calmT >= o.hold) {
        this.moving = false; this.calmT = 0;
        for (const c of this.ch) { c.rest = c.x; c.anchor = c.x; }
      }
    }
    // weight: instant release of the lock, eased re-lock (≈0.2 s) so settling isn't a visible stop
    this.m = this.moving ? 1 : this.m * Math.exp(-dt / 0.2);
    this.stillFor = this.moving ? 0 : this.stillFor + dt;
    // ---- noise learning: running 30th percentile of |v̂| and |x̂ − slow mean| (stochastic quantile
    // tracking in the log domain, ~3 s memory). A low quantile is set by the quiet moments, so it measures
    // the sensor noise even for a performer who is rarely perfectly still; for |N(0,σ)| q30 = 0.385σ.
    {
      const eta = Math.min(0.2, dt / 3) * 4;
      for (const c of this.ch) {
        const ad = Math.abs(c.x - c.slow), av = Math.abs(c.v);
        const qd = Math.sqrt(c.varD) * 0.385, qv = Math.sqrt(c.varV) * 0.385;
        const nd = qd * Math.exp(eta * ((ad < qd ? 0 : 1) - 0.7));
        const nv = qv * Math.exp(eta * ((av < qv ? 0 : 1) - 0.7));
        c.varD = (nd / 0.385) ** 2; c.varV = (nv / 0.385) ** 2;
        // keep the estimate inside the physical range (so it can't run away in either direction)
        const sd = clamp(Math.sqrt(c.varD), c.c.sigma[1], c.c.sigma[2]), sv = clamp(Math.sqrt(c.varV), c.c.sigma[1] * 4, c.c.sigma[2] * 25);
        c.varD = sd * sd; c.varV = sv * sv;
      }
    }
    // ---- outputs ----
    const out: number[] = [];
    const drift = 1 - Math.exp(-dt / o.driftTau);
    const L = Math.min(o.maxLead, Math.max(0, lead));
    for (let i = 0; i < this.ch.length; i++) {
      const c = this.ch[i];
      c.slow += (c.x - c.slow) * (1 - Math.exp(-dt / 0.8));
      const dz = Math.min(o.dzK * c.sd, c.c.dzMax ?? 2 * c.c.sigma[2]) * (1 - this.m);
      c.xs = this.moving ? c.x : c.xs + (c.x - c.xs) * (1 - Math.exp(-dt / o.lockTau));
      if (!this.enabled || this.moving && this.m >= 1) { c.anchor = c.x; c.xs = c.x; }
      else {
        c.anchor = clamp(c.anchor, c.xs - dz, c.xs + dz);
        if (!this.moving) { c.anchor += (c.xs - c.anchor) * drift; c.rest += (c.x - c.rest) * drift * 0.5; }
      }
      const g = c.c.noLead ? 0 : gates[i] * this.m * (w ? w[i] * w[i] : 1);
      this.vel[i] = c.v * g;
      out.push(c.anchor + c.v * L * (c.c.leadScale ?? 1) * g);
    }
    return out;
  }
}
