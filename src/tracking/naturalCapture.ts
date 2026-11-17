// Natural capture: the performer emotes NORMALLY and the avatar still reads — no over-acting for the camera.
//
// Why webcam faces need exaggeration (docs/NATURAL_CAPTURE.md): MediaPipe's blendshapes are compressed (an everyday
// smile reads 0.1–0.3 of the range an "average" big smile gives), every channel carries a person-, pose- and
// lighting-dependent resting offset (glasses, beards, looking up at chat, turning to a second monitor), and on top
// sits a noise floor of ±0.01–0.03. A fixed amplifier (neutral → a default "full expression" peak) either leaves a
// subtle face at 20–40 % of the avatar's range, or — turned up — amplifies noise, pose and speech artefacts.
//
// What this does, per feature (brows, brow-down, squint, cheeks, eye-wide, sneer, smile, frown, stretch, dimple,
// pucker/funnel, cheek puff, jaw — the ARKit channels AND the facial-hair-robust lip-geometry channels):
//   1. neutral that follows the performer: a robust recursive fit neutral(pose, jaw) = θ·[1, pitch, yaw, |yaw|, |pitch|,
//      jawOpen] with ~70 s memory, down-weighting frames above the neutral (expressions) far more than frames below it
//      (so it settles at the relaxed face, not the average face). Pose terms remove "looking up at chat reads as
//      surprise" / "turning reads as a frown"; the jaw term removes MediaPipe's brows-and-squint-follow-the-jaw
//      coupling while talking. It also tracks slow lighting drift.
//   2. noise floor σ per channel (robust EMA of frame-to-frame change near rest) → a soft dead zone ≈ 2.5σ (quadratic
//      knee, no step), so rest stays calm however far the channel is amplified.
//   3. natural range: the performer's TYPICAL expression size, learned from their own expression events (the sustained
//      peak of each excursion ≥ 250 ms; decay-weighted mean of the last ~40, with a prior worth 3 events) — typical
//      smiles map to a clear avatar smile; a bigger-than-usual one still reads bigger (exponential curve, no clip).
//      Learning is gated to near-frontal poses, and for mouth channels to non-speech frames.
//   4. curve out = 1 − exp(−k·u), u = (excursion − dead zone) / range, k set so the typical event lands at a
//      per-feature target (0.75 brows/eyes, 0.65 jaw/frown, smiles GENTLE — see SMILE_CAP).
//   5. while speaking, mouth channels never exceed the classic amplifier (articulation drives the mouth, the
//      viseme engine owns it) and smiles are never enlarged beyond max(classic, SMILE_CAP).
// Everything is per person (not per avatar), stored locally (localStorage 'vtp.naturalCapture'), and keeps learning.

export const NATURAL_KEY = 'vtp.naturalCapture';
export const NATURAL_ON_KEY = 'vtp.natural';
/** Natural mode never draws a smile bigger than max(classic amplifier, SMILE_CAP) — gentle smiles by default. */
export const SMILE_CAP = 0.45;

type Kind = 'face' | 'mouth' | 'jaw' | 'smile';
interface Spec {
  kind: Kind; /** default "full" excursion above neutral (what the classic amplifier maps to 1) */ full: number;
  /** avatar value the performer's typical event lands on */ target: number; pair?: string;
  /** curve knee: 1 = expressive from the first millimetre; > 1 = small movements stay small (smiles: gentle) */ gamma: number;
}

const S = (kind: Kind, full: number, target: number, pair?: string): Spec => ({ kind, full, target, pair, gamma: kind === 'smile' ? 1.3 : 1 });
/** Features natural capture handles (others keep the classic amplifier). `pair` = shared range with its mirror. */
export const NATURAL_SPECS: Record<string, Spec> = {
  browInnerUp: S('face', 0.5, 0.72),
  browOuterUpLeft: S('face', 0.45, 0.72, 'browOuterUp'), browOuterUpRight: S('face', 0.45, 0.72, 'browOuterUp'),
  browDownLeft: S('face', 0.35, 0.75, 'browDown'), browDownRight: S('face', 0.35, 0.75, 'browDown'),
  eyeSquintLeft: S('face', 0.3, 0.6, 'eyeSquint'), eyeSquintRight: S('face', 0.3, 0.6, 'eyeSquint'),
  cheekSquintLeft: S('face', 0.35, 0.6, 'cheekSquint'), cheekSquintRight: S('face', 0.35, 0.6, 'cheekSquint'),
  eyeWideLeft: S('face', 0.3, 0.7, 'eyeWide'), eyeWideRight: S('face', 0.3, 0.7, 'eyeWide'),
  noseSneerLeft: S('face', 0.3, 0.7, 'noseSneer'), noseSneerRight: S('face', 0.3, 0.7, 'noseSneer'),
  cheekPuff: S('face', 0.25, 0.75),
  mouthSmileLeft: S('smile', 0.55, 0.5, 'mouthSmile'), mouthSmileRight: S('smile', 0.55, 0.5, 'mouthSmile'),
  mouthFrownLeft: S('mouth', 0.25, 0.65, 'mouthFrown'), mouthFrownRight: S('mouth', 0.25, 0.65, 'mouthFrown'),
  mouthDimpleLeft: S('mouth', 0.25, 0.55, 'mouthDimple'), mouthDimpleRight: S('mouth', 0.25, 0.55, 'mouthDimple'),
  mouthStretchLeft: S('mouth', 0.28, 0.6, 'mouthStretch'), mouthStretchRight: S('mouth', 0.28, 0.6, 'mouthStretch'),
  mouthPucker: S('mouth', 0.6, 0.7), mouthFunnel: S('mouth', 0.3, 0.7),
  jawOpen: S('jaw', 0.45, 0.65),
  // facial-hair-robust lip geometry (mouthGeometry.ts, already relative to the pose-aware lip neutral)
  _gSmileL: S('smile', 0.8, 0.5, '_gSmile'), _gSmileR: S('smile', 0.8, 0.5, '_gSmile'),
  _gFrownL: S('mouth', 0.8, 0.65, '_gFrown'), _gFrownR: S('mouth', 0.8, 0.65, '_gFrown'),
  _gStretchL: S('mouth', 0.8, 0.6, '_gStretch'), _gStretchR: S('mouth', 0.8, 0.6, '_gStretch'),
  _gPucker: S('mouth', 0.8, 0.7), _gFunnel: S('mouth', 0.8, 0.7), _gPuff: S('face', 0.8, 0.75),
  _gOpen: S('jaw', 0.8, 0.65),
};
/** geometry channels are measured relative to their own (pose-aware) lip neutral already: their fit starts at 0 */
const GEO = (k: string) => k.startsWith('_g');
/** Which MediaPipe couplings are regressed out of a channel's neutral: [jaw, vertical gaze, blink]. Measured on the
 *  recorded clip: inner/outer brows rise with the jaw on every vowel (no brow movement in the landmarks), brows and lids
 *  follow looking up / down, squint and brow-down jump on every blink. Squint must NOT lose its jaw share (a grin's
 *  Duchenne squint is real) and mouth / jaw channels keep everything (their movement IS the signal). */
const COUPLE = (k: string): [number, number, number] =>
  /^brow(InnerUp|OuterUp)/.test(k) ? [1, 1, 1] : /^browDown|^eyeSquint|^cheekSquint/.test(k) ? [0, 1, 1] : /^eyeWide/.test(k) ? [0, 1, 0] : [0, 0, 0];

/** Typical event size of a normal (not over-acting) performer, as a fraction of the default full excursion — the
 *  prior before any events are seen (≈ the classic amplifier's mid-range, so switching on changes little at first). */
const PRIOR_FRAC = 0.4;
const PRIOR_W = 2;
/** dead zone in noise σ (the soft knee starts at half of it) */
let DZ_SIGMA = 1.5;
export const naturalTuning = { set dz(v: number) { DZ_SIGMA = v; }, get dz() { return DZ_SIGMA; } };
const R_MIN_FRAC = 0.15, R_MAX_FRAC = 1.1;
/** event memory half-life (ms, wall clock: persists across sessions) */
const EVENT_HALF_LIFE = 30 * 60 * 1000;
const MAX_EVENTS = 40;
/** neutral regressors: 1, pitch, yaw, |yaw|, |pitch|, jawOpen, vertical gaze, blink (the last three: upper face only —
 *  MediaPipe lifts brows / squints lids with the jaw, with looking up / down, and during every blink) */
const NREG = 8;
const P0 = [0.5, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3];

interface ChanState {
  /** robust neutral fit θ and its covariance */
  th: Float64Array; P: Float64Array;
  /** noise σ: spread of the calm residual (robust EMA, ~20 s) and its mean */
  sigma: number; rMean: number;
  /** fitted-neutral samples seen */
  n: number;
}
interface RangeState {
  events: [number, number][]; // [sustained peak excursion, wall time ms]
  R: number;
  // event detector
  lp: number; on: boolean; onFor: number; offFor: number; peak: number; win: { t: number; v: number }[];
}

export interface NaturalSaved { v: 1; at: string; ch: Record<string, { th: number[]; sigma: number; n: number }>; rg: Record<string, { events: [number, number][] }> }

export interface NaturalContext {
  /** head pose relative to the calibrated rest (rad): pitch, yaw, roll */
  pitch: number; yaw: number; roll: number;
  /** raw MediaPipe jawOpen (for the brow / eye coupling term) */
  jaw: number;
  /** vertical gaze (raw, + = looking down): looking up at chat lifts brows / lids in MediaPipe */
  gazeY?: number;
  /** raw blink (mean of both eyes) */
  blink?: number;
  /** 0..1 how much the performer is speaking right now (voice gate / level; camera proxy without a mic) */
  speaking: number;
  /** tracker time (s) and step (s) */
  t: number; dt: number;
  /** no learning (calibration capture running, etc.) */
  frozen?: boolean;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export class NaturalCapture {
  /** natural mode on (default on; localStorage 'vtp.natural' = '0' turns it off) */
  enabled = (() => { try { return globalThis.localStorage?.getItem(NATURAL_ON_KEY) !== '0'; } catch { return true; } })();
  /** write what it learns to localStorage (observer / test pages: false) */
  persist = true;
  private ch = new Map<string, ChanState>();
  private rg = new Map<string, RangeState>();
  private x = new Float64Array(NREG);
  private ctx: NaturalContext = { pitch: 0, yaw: 0, roll: 0, jaw: 0, speaking: 0, t: 0, dt: 1 / 60 };
  private saveT = 0;
  private dirty = false;
  /** wall clock (ms) — replaceable for replays */
  now = () => Date.now();

  constructor(load = true) { if (load) this.load(); }

  has(name: string) { return name in NATURAL_SPECS; }

  /** Feed one frame of raw channels (before amplification). Call once per camera frame, before map(). */
  observe(raw: Record<string, number>, classicNeutral: (name: string) => number, c: NaturalContext) {
    this.ctx = c;
    const frontal = Math.abs(c.yaw) < 0.45 && Math.abs(c.pitch) < 0.35;
    const learnNeutral = !c.frozen;
    // ~70 s memory at any frame rate
    const lam = Math.exp(-Math.max(1e-3, c.dt) / 70);
    for (const name in NATURAL_SPECS) {
      const v = raw[name];
      if (v === undefined || !Number.isFinite(v)) continue;
      const sp = NATURAL_SPECS[name];
      let st = this.ch.get(name);
      if (!st) { st = this.newChan(GEO(name) ? 0 : Math.min(v, classicNeutral(name) || v)); this.ch.set(name, st); }
      const x = this.reg(name);
      const pred = this.dot(st.th, x);
      const r = v - pred;
      // noise floor: spread of the residual on calm frames (tracker wander is slow, so a frame-to-frame measure
      // under-reads it ×5–10); expressions are excluded by the 3σ gate
      // (robust: clipped absolute deviation, so a stray expression can't inflate it; Gaussian-consistent ×1.25)
      if (r < 2.5 * st.sigma + 0.01) {
        const a = 1 - Math.exp(-c.dt / 20);
        st.rMean += (r - st.rMean) * a;
        const d = Math.min(Math.abs(r - st.rMean), 2.5 * st.sigma);
        st.sigma = Math.max(0.004, st.sigma + (1.25 * d - st.sigma) * a);
      }
      if (learnNeutral) {
        // asymmetric robust fit: a frame above the neutral (an expression) only counts as "slightly above" and at a
        // quarter weight; a frame below it (the face relaxing further) counts fully → settles on the relaxed face
        const cUp = 2 * st.sigma + 0.012;
        let w = r > cUp ? 0.25 : 1, y = Math.min(v, pred + cUp);
        // mouth channels: articulation isn't rest
        if (sp.kind !== 'face') w *= 1 - 0.9 * clamp01(c.speaking);
        // brows that ride on the jaw while talking: fit them plainly there, so the jaw coefficient learns MediaPipe's
        // brow ↔ jaw coupling instead of treating every vowel as a raised brow
        else if (COUPLE(name)[0] && c.speaking > 0.5) { w = 0.5; y = v; }
        if (w > 1e-3) { this.rls(st, x, y, w, lam); st.n++; this.dirty = true; }
      }
    }
    // ranges from expression events
    const groups = new Map<string, number>();
    for (const name in NATURAL_SPECS) {
      const sp = NATURAL_SPECS[name];
      const g = sp.pair ?? name;
      const e = this.excursion(name, raw[name]);
      if (e === null) continue;
      groups.set(g, Math.max(groups.get(g) ?? 0, e));
    }
    for (const [g, e] of groups) {
      const sp = this.specOf(g);
      const learn = frontal && !c.frozen && (sp.kind === 'face' || c.speaking < 0.15);
      this.detect(g, e, learn, c);
    }
    if (this.persist && this.dirty && c.t - this.saveT > 20) { this.saveT = c.t; this.save(); }
  }

  /** Relaxed-face value of a channel for the current pose (null = not learned). */
  neutral(name: string): number | null {
    const st = this.ch.get(name);
    if (!st) return null;
    return Math.max(0, this.dot(st.th, this.reg(name)));
  }

  /** Excursion above the relaxed face (raw units). */
  excursion(name: string, raw: number | undefined): number | null {
    if (raw === undefined || !Number.isFinite(raw)) return null;
    const n = this.neutral(name);
    if (n === null) return null;
    return Math.max(0, raw - n);
  }

  /**
   * Natural-mode avatar value (0..1) for one raw channel. `classic` = what the classic amplifier gives the same frame
   * (bounds the mouth while speaking and the smile). Returns null when this channel isn't handled.
   */
  map(name: string, raw: number, classic: number): number | null {
    const sp = NATURAL_SPECS[name];
    const st = this.ch.get(name);
    if (!sp || !st) return null;
    const e = this.excursion(name, raw) ?? 0;
    const dz = this.deadZone(name);
    // quadratic knee: 0 below dz/2 … slope 1 above 1.5·dz (no step, no flicker at the threshold)
    const y = e <= dz * 0.5 ? 0 : e >= dz * 1.5 ? e - dz : ((e - dz * 0.5) ** 2) / (2 * dz);
    const R = this.range(sp.pair ?? name);
    const u = y / Math.max(0.01, R - dz);
    const k = -Math.log(1 - sp.target);
    let out = 1 - Math.exp(-k * Math.pow(u, sp.gamma));
    const sPk = clamp01(this.ctx.speaking);
    if (sp.kind === 'smile') out = Math.min(out, Math.max(classic, SMILE_CAP));
    if (sp.kind !== 'face' && sPk > 0) out = out + (Math.min(out, classic) - out) * sPk;
    return clamp01(out);
  }

  /** Soft dead zone for a channel: above the noise floor, never below 0.008. */
  deadZone(name: string) { const st = this.ch.get(name); return Math.max(0.008, DZ_SIGMA * (st?.sigma ?? 0.01)); }

  /** Typical expression size (raw units) of a feature group. */
  range(group: string): number {
    const sp = this.specOf(group);
    const r = this.rg.get(group);
    const R0 = sp.full * PRIOR_FRAC;
    if (!r) return R0;
    return r.R || R0;
  }

  /** Forget everything learned (keeps on/off). */
  reset() {
    this.ch.clear(); this.rg.clear();
    try { globalThis.localStorage?.removeItem(NATURAL_KEY); } catch { /* storage off */ }
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    try { globalThis.localStorage?.setItem(NATURAL_ON_KEY, on ? '1' : '0'); } catch { /* storage off */ }
  }

  /** What it has learned, for the UI / diagnostics: per feature group the typical range vs the default, events seen. */
  summary() {
    const out: Record<string, { gain: number; events: number; sigma: number; neutral: number | null }> = {};
    const seen = new Set<string>();
    for (const name in NATURAL_SPECS) {
      const sp = NATURAL_SPECS[name];
      const g = sp.pair ?? name;
      if (seen.has(g)) continue;
      seen.add(g);
      const r = this.rg.get(g);
      out[g] = { gain: +((sp.full * PRIOR_FRAC) / this.range(g)).toFixed(2), events: r?.events.length ?? 0, sigma: +(this.ch.get(name)?.sigma ?? 0).toFixed(4), neutral: this.neutral(name) === null ? null : +this.neutral(name)!.toFixed(3) };
    }
    return out;
  }

  /** Friendly per-feature readout (UI): how much more sensitive than a default "big" face each feature now is. */
  readout(): { label: string; gain: number; events: number }[] {
    const s = this.summary();
    const pick: [string, string[]][] = [['Smile', ['mouthSmile', '_gSmile']], ['Brows up', ['browInnerUp', 'browOuterUp']], ['Brows down', ['browDown']],
      ['Eye squint', ['eyeSquint', 'cheekSquint']], ['Frown', ['mouthFrown', '_gFrown']], ['Pucker', ['mouthPucker', '_gPucker']], ['Jaw', ['jawOpen', '_gOpen']]];
    return pick.map(([label, gs]) => {
      const xs = gs.map((g) => s[g]).filter(Boolean);
      return { label, gain: +Math.max(...xs.map((x) => x.gain)).toFixed(2), events: xs.reduce((a, x) => a + x.events, 0) };
    });
  }

  // ------------------------------------------------------------------------------------------------ internals
  private specOf(group: string): Spec {
    if (NATURAL_SPECS[group]) return NATURAL_SPECS[group];
    for (const k in NATURAL_SPECS) if (NATURAL_SPECS[k].pair === group) return NATURAL_SPECS[k];
    return S('face', 0.5, 0.7);
  }

  private newChan(n0: number): ChanState {
    const th = new Float64Array(NREG); th[0] = n0;
    const P = new Float64Array(NREG * NREG);
    // a new channel converges in a few frames (large intercept uncertainty), then settles to ~1/N-sample gains
    for (let i = 0; i < NREG; i++) P[i * NREG + i] = P0[i];
    return { th, P, sigma: 0.015, rMean: 0, n: 0 };
  }

  /** regressors of a channel for the current frame */
  private reg(name: string) {
    const x = this.x, c = this.ctx, k = COUPLE(name);
    x[0] = 1; x[1] = c.pitch; x[2] = c.yaw; x[3] = Math.abs(c.yaw); x[4] = Math.abs(c.pitch);
    x[5] = k[0] * c.jaw; x[6] = k[1] * (c.gazeY ?? 0); x[7] = k[2] * (c.blink ?? 0);
    return x;
  }

  private dot(th: Float64Array, x: Float64Array) { let s = 0; for (let i = 0; i < NREG; i++) s += th[i] * x[i]; return s; }

  /** weighted RLS with forgetting + anti-windup (covariance never above its prior) */
  private rls(st: ChanState, x: Float64Array, y: number, w: number, lam: number) {
    const P = st.P, n = NREG;
    const Px = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < n; j++) s += P[i * n + j] * x[j]; Px[i] = s; }
    let den = lam / w;
    for (let i = 0; i < n; i++) den += x[i] * Px[i];
    const err = y - this.dot(st.th, x);
    for (let i = 0; i < n; i++) st.th[i] += (Px[i] / den) * err;
    const cap = P0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) P[i * n + j] = (P[i * n + j] - (Px[i] * Px[j]) / den) / lam;
    for (let i = 0; i < n; i++) if (P[i * n + i] > cap[i]) { const k = Math.sqrt(cap[i] / P[i * n + i]); for (let j = 0; j < n; j++) { P[i * n + j] *= k; P[j * n + i] *= k; } }
    // the slopes stay physically plausible (a channel can't swing more than its full range over the pose range)
    for (let i = 1; i < n; i++) st.th[i] = Math.max(-1.5, Math.min(1.5, st.th[i]));
  }

  /** Expression-event detector for one feature group → updates its typical range. */
  private detect(g: string, e: number, learn: boolean, c: NaturalContext) {
    let r = this.rg.get(g);
    const sp = this.specOf(g);
    if (!r) { r = { events: [], R: 0, lp: 0, on: false, onFor: 0, offFor: 0, peak: 0, win: [] }; this.rg.set(g, r); this.updateRange(g, r); }
    r.lp += (e - r.lp) * (1 - Math.exp(-c.dt / 0.06));
    const names = Object.keys(NATURAL_SPECS).filter((k) => (NATURAL_SPECS[k].pair ?? k) === g);
    const dz = Math.max(...names.map((k) => this.deadZone(k)));
    const R = this.range(g);
    const thOn = Math.max(dz * 1.5, 0.3 * R, 0.08 * sp.full);
    r.win.push({ t: c.t, v: r.lp });
    while (r.win.length > 2 && r.win[0].t < c.t - 0.25) r.win.shift();
    if (!r.on) {
      if (r.lp > thOn && learn) { r.on = true; r.onFor = 0; r.offFor = 0; r.peak = 0; }
      return;
    }
    r.onFor += c.dt;
    // sustained peak: the lowest value of the last 250 ms, at its highest
    if (r.onFor >= 0.25) { let m = Infinity; for (const q of r.win) m = Math.min(m, q.v); r.peak = Math.max(r.peak, m); }
    if (r.lp < thOn * 0.5) r.offFor += c.dt; else r.offFor = 0;
    // the event ends when the face relaxes, when a pose / speech takes over (what was held so far still counts), or
    // after 4 s (a held expression is one event, not a new "neutral")
    if (!learn || r.offFor > 0.15 || r.onFor > 4) {
      r.on = false;
      // a real expression, not a glitch: sustained, and not physically absurd (rejecting relative to the current
      // range would let a run of small events lock the range small and then throw away every real smile)
      if (r.onFor >= 0.4 && r.peak > thOn && r.peak < sp.full * 2) {
        r.events.push([r.peak, this.now()]);
        if (r.events.length > MAX_EVENTS) r.events.shift();
        this.updateRange(g, r);
        this.dirty = true;
      }
    }
  }

  private updateRange(g: string, r: RangeState) {
    const sp = this.specOf(g);
    const R0 = sp.full * PRIOR_FRAC, now = this.now();
    let a = PRIOR_W * R0, w = PRIOR_W;
    for (const [p, at] of r.events) { const k = Math.pow(0.5, Math.max(0, now - at) / EVENT_HALF_LIFE); a += p * k; w += k; }
    r.R = Math.max(sp.full * R_MIN_FRAC, Math.min(sp.full * R_MAX_FRAC, a / w));
  }

  save() {
    if (!this.persist) return;
    const o: NaturalSaved = { v: 1, at: new Date().toISOString(), ch: {}, rg: {} };
    for (const [k, s] of this.ch) o.ch[k] = { th: Array.from(s.th, (v) => +v.toFixed(5)), sigma: +s.sigma.toFixed(5), n: s.n };
    for (const [k, r] of this.rg) o.rg[k] = { events: r.events.map(([p, t]) => [+p.toFixed(4), t]) };
    try { globalThis.localStorage?.setItem(NATURAL_KEY, JSON.stringify(o)); this.dirty = false; } catch { /* storage off */ }
  }

  private load() {
    try {
      const s = globalThis.localStorage?.getItem(NATURAL_KEY);
      const o = s ? JSON.parse(s) as NaturalSaved : null;
      if (!o || o.v !== 1) return;
      for (const [k, c] of Object.entries(o.ch ?? {})) {
        if (!(k in NATURAL_SPECS) || !Array.isArray(c.th) || c.th.length !== NREG) continue;
        const st = this.newChan(0);
        st.th.set(c.th.map(Number)); st.sigma = Number(c.sigma) || 0.015; st.n = Number(c.n) || 0;
        // a restored fit is trusted less than a fresh one: re-open the covariance a little
        this.ch.set(k, st);
      }
      for (const [g, r] of Object.entries(o.rg ?? {})) {
        const st: RangeState = { events: (r.events ?? []).filter((e) => Array.isArray(e) && Number.isFinite(e[0]) && Number.isFinite(e[1])).slice(-MAX_EVENTS), R: 0, lp: 0, on: false, onFor: 0, offFor: 0, peak: 0, win: [] };
        this.rg.set(g, st); this.updateRange(g, st);
      }
    } catch { /* corrupt → start fresh */ }
  }
}
