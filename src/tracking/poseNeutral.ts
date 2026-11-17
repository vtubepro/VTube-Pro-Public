// Pose-aware neutral: how each resting face measurement shifts with head pitch/yaw/roll.
//
// Perspective makes a relaxed mouth look different when you lean back or turn (corners read lower
// looking up → fake frown; width shrinks when turned → fake pucker). We fit, per measurement,
//     neutral(pose) = a + b·pitch + c·yaw + d·roll
// with recursive least squares (exponential forgetting) using only calm frames, and subtract that
// instead of a single static neutral. All measurements share the same regressors, so one P matrix.

const N = 4;

export class PoseNeutral {
  private P = new Float64Array(N * N);
  private theta = new Map<string, Float64Array>();
  samples = 0;

  constructor(private lambda = 0.998) { this.resetP(); }

  private resetP() {
    this.P.fill(0);
    // prior: intercept well known (from calibration), slopes unknown
    const prior = [1e-3, 1.5, 1.5, 1.5];
    for (let i = 0; i < N; i++) this.P[i * N + i] = prior[i];
  }

  /** Seed intercepts from a static neutral (slopes start at 0). */
  seed(neutral: Record<string, number>) {
    for (const [k, v] of Object.entries(neutral)) {
      const th = this.theta.get(k) ?? new Float64Array(N);
      th.fill(0); th[0] = v;
      this.theta.set(k, th);
    }
    this.resetP();
    this.samples = 0;
  }

  get seeded() { return this.theta.size > 0; }

  predict(x: ArrayLike<number>, key: string): number {
    const th = this.theta.get(key);
    if (!th) return 0;
    let s = 0;
    for (let i = 0; i < N; i++) s += th[i] * x[i];
    return s;
  }

  /** One RLS step with regressor x = [1, pitch, yaw, roll] and observed values. */
  update(x: ArrayLike<number>, values: Record<string, number>) {
    const P = this.P, lam = this.lambda;
    // k = P x / (λ + xᵀ P x)
    const Px = new Float64Array(N);
    for (let i = 0; i < N; i++) { let s = 0; for (let j = 0; j < N; j++) s += P[i * N + j] * x[j]; Px[i] = s; }
    let den = lam;
    for (let i = 0; i < N; i++) den += x[i] * Px[i];
    const k = Px.map((v) => v / den);
    for (const [key, y] of Object.entries(values)) {
      let th = this.theta.get(key);
      if (!th) { th = new Float64Array(N); th[0] = y; this.theta.set(key, th); continue; }
      let pred = 0;
      for (let i = 0; i < N; i++) pred += th[i] * x[i];
      const e = y - pred;
      for (let i = 0; i < N; i++) th[i] += k[i] * e;
      // keep slopes physically plausible (measurements are in interocular units per radian)
      for (let i = 1; i < N; i++) th[i] = Math.max(-0.6, Math.min(0.6, th[i]));
    }
    // P = (P − k xᵀ P) / λ
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) P[i * N + j] = (P[i * N + j] - k[i] * Px[j]) / lam;
    // don't let P blow up during long calm stretches without pose variety
    for (let i = 0; i < N; i++) P[i * N + i] = Math.min(P[i * N + i], i === 0 ? 0.05 : 3);
    this.samples++;
  }
}
