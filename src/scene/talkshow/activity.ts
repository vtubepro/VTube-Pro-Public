// Speaker activity for the interview auto-director: who is REALLY talking, from whatever each participant gives us.
// Pure logic, no DOM / three.js: the host's studio (src/ui/stage/interviewHost.ts, the authority every page follows) and
// each page's local fallback director run the same code.
//
// A raw level is not speech. Each participant's signals go through, in a fixed 20 Hz step (sample-and-hold on the
// inputs, the loudest value since the last step — the "peak over the check interval" an audio switcher uses), so the
// same signals give the same answer at any frame rate:
//   mic    the voice front-end's `speak` (performers) or a call-audio meter (video guests): an adaptive noise floor
//          (the minimum over the last 5 s — speech always dips between words, a fan / a music bed does not; never closer
//          than 0.2 under the peak right after real speech, so a held vowel or a shout stays a voice) and an
//          automatic gain (the recent peak), so a steady false level from room noise or music never reads as talking;
//   mouth  the camera's mouth opening, ONLY when there is no voice signal, and only its MOVEMENT (syllables open and
//          close the mouth 4-6 times a second): a mouth that rests open (a frog's grin, a calibration offset) is still,
//          so it never reads as talking — the VOD of 2026-10-08 (the host "talked" for 9 minutes because of it);
//   bleed  a performer's mic whose envelope follows a video guest's call audio (the call playing through speakers / a
//          loud headset into the mic) while their mouth doesn't move with it is the guest, not them: suppressed;
//   none   a video guest without a meter has no signal: the director presumes they talk while everyone else is quiet
//          (`voiceless`, director.ts) — never a level from here.
// Output per participant: a clean 0..1 level (talking ≈ 0.7-1, between words / silent ≈ 0) for the director's
// hysteresis, and a state for the studio's "why" readout.

export const VOICE_STEP = 0.05;

export interface VoiceInput {
  id: string;
  kind: 'performer' | 'video';
  /** voice front-end "speaking" 0..1 (mic), null/undefined = no mic data */
  speak?: number | null;
  /** camera mouth opening 0..1, null/undefined = no camera mouth */
  open?: number | null;
  /** call-audio meter 0..1 (video guests), null/undefined = no meter */
  meter?: number | null;
  /** an explicit gate (the audio mixer's noise gate): false = shut (not talking, whatever the level says) */
  gate?: boolean | null;
  /** connected / on the show (false: a guest still "Jacking in…") */
  ready?: boolean;
}

export type VoiceSrc = 'mic' | 'meter' | 'mouth' | 'none' | 'off';
export interface VoiceState { id: string; src: VoiceSrc; lvl: number; floor: number; peak: number; mod: number; bleed: boolean; still: boolean }

const WIN = Math.round(5 / VOICE_STEP);         // noise-floor window (5 s)
const PEAK = Math.round(8 / VOICE_STEP);        // gain window (8 s)
const MODW = Math.round(1 / VOICE_STEP);        // mouth movement window (1 s)
const CORW = Math.round(1.5 / VOICE_STEP);      // bleed correlation window (1.5 s)
const RHY = Math.round(2 / VOICE_STEP);         // mouth rhythm window (2 s)

class Ring {
  readonly a: Float32Array; n = 0; i = 0;
  constructor(size: number) { this.a = new Float32Array(size); }
  push(v: number) { this.a[this.i] = v; this.i = (this.i + 1) % this.a.length; if (this.n < this.a.length) this.n++; }
  /** k-th newest (0 = newest) */
  at(k: number) { return this.a[(this.i - 1 - k + this.a.length * 2) % this.a.length]; }
  min() { let m = Infinity; for (let k = 0; k < this.n; k++) m = Math.min(m, this.at(k)); return this.n ? m : 0; }
  max() { let m = -Infinity; for (let k = 0; k < this.n; k++) m = Math.max(m, this.at(k)); return this.n ? m : 0; }
  clear() { this.n = 0; this.i = 0; }
}

class Chan {
  src: VoiceSrc = 'none';
  x = new Ring(WIN); pk = new Ring(PEAK); mo = new Ring(MODW); cor = new Ring(CORW); rh = new Ring(RHY);
  floor = 0; peak = 0; mod = 0; lvl = 0; bleed = false; still = false;
  /** inputs held since the last step (the loudest) */
  hold: { speak: number | null; open: number | null; meter: number | null; gate: boolean | null; ready: boolean; kind: VoiceInput['kind'] } = { speak: null, open: null, meter: null, gate: null, ready: true, kind: 'performer' };
  fresh = false;
  reset(src: VoiceSrc) { this.src = src; this.x.clear(); this.pk.clear(); this.mo.clear(); this.cor.clear(); this.rh.clear(); this.floor = 0; this.peak = 0; this.mod = 0; this.lvl = 0; }
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const q = (v: number) => Math.round(v * 1000) / 1000;   // (quantised: tiny float noise never flips a decision)

export class InterviewVoices {
  private ch = new Map<string, Chan>();
  private t = -1;
  private order: string[] = [];
  private readonly out: Record<string, number> = {};

  /** Feed this frame's signals (any rate) and get the clean levels, stepped at VOICE_STEP on the time `t` (s). */
  levels(t: number, inputs: VoiceInput[]): Record<string, number> {
    // the steps that ended before this frame first, on the frames inside them (a step [a, b) holds the loudest of its
    // frames: pages at 30, 60 or 144 fps take the same steps); then this frame counts for the step it is in
    if (this.t < 0) this.t = t;
    // (a long stall — a backgrounded page — never replays minutes of steps)
    if (t - this.t > 2) this.t = t - VOICE_STEP;
    while (this.t + VOICE_STEP <= t + 1e-9) { this.t += VOICE_STEP; this.step(); }
    if (this.order.length !== inputs.length || inputs.some((x, i) => x.id !== this.order[i])) this.order = inputs.map((x) => x.id);
    for (const x of inputs) {
      let c = this.ch.get(x.id);
      if (!c) { c = new Chan(); this.ch.set(x.id, c); }
      const h = c.hold, num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : null);
      const sp = num(x.speak), op = num(x.open), me = num(x.meter);
      if (!c.fresh) { h.speak = sp; h.open = op; h.meter = me; h.gate = x.gate ?? null; }
      else {
        h.speak = sp === null ? h.speak : Math.max(h.speak ?? 0, sp);
        h.open = op === null ? h.open : op;            // (the newest mouth: its movement is what counts)
        h.meter = me === null ? h.meter : Math.max(h.meter ?? 0, me);
        if (x.gate === false) h.gate = false; else if (x.gate === true && h.gate !== false) h.gate = true;
      }
      h.ready = x.ready !== false; h.kind = x.kind; c.fresh = true;
    }
    if (this.ch.size > this.order.length) for (const k of [...this.ch.keys()]) if (!this.order.includes(k)) this.ch.delete(k);
    // (one object, refilled: the levels are read in this frame — copy them to keep them)
    const out = this.out;
    for (const k in out) if (!this.ch.has(k)) delete out[k];
    for (const id of this.order) out[id] = this.ch.get(id)!.lvl;
    return out;
  }

  /** Participants with no voice signal at all (video guests without a meter): the director presumes for them. */
  voiceless(): string[] { return this.order.filter((id) => { const h = this.ch.get(id)!.hold; return h.kind === 'video' && h.meter === null && h.ready; }); }

  state(): Record<string, VoiceState> {
    const o: Record<string, VoiceState> = {};
    for (const id of this.order) { const c = this.ch.get(id)!; o[id] = { id, src: c.src, lvl: q(c.lvl), floor: q(c.floor), peak: q(c.peak), mod: q(c.mod), bleed: c.bleed, still: c.still }; }
    return o;
  }

  private step() {
    const metered: Chan[] = [];
    for (const id of this.order) {
      const c = this.ch.get(id)!, h = c.hold;
      c.fresh = false;
      const src: VoiceSrc = !h.ready ? 'off' : h.kind === 'video' ? (h.meter !== null ? 'meter' : 'none') : h.speak !== null ? 'mic' : h.open !== null ? 'mouth' : 'none';
      if (src !== c.src) c.reset(src);
      if (src === 'off' || src === 'none') { c.lvl = 0; c.bleed = false; c.still = false; continue; }
      if (src === 'mouth') { this.mouth(c, h.open!); continue; }
      const x = src === 'mic' ? h.speak! : h.meter!;
      c.x.push(x); c.pk.push(x); c.cor.push(x);
      // noise floor: the minimum of the last 5 s, falling at once, rising over ~2 s — a steady fan / music bed is absorbed
      // in ~7 s; while there was real speech (dips and peaks) in the last 8 s it stays ≥ 0.32 under the peak, so a held
      // vowel or a shout with no dip is not swallowed mid-word
      const m = c.x.min();
      c.floor = m < c.floor ? m : c.floor + (m - c.floor) * 0.025;
      const pmax = c.pk.max();
      // (0.32: a held level up to 0.2 under the peak still clears the 0.12 dead zone below)
      if (pmax - c.pk.min() > 0.3) c.floor = Math.min(c.floor, pmax - 0.32);
      // gain: the recent peak (never less than a 0.25 span over the floor: a quiet room's breathing is not a voice)
      c.peak = Math.max(pmax, c.floor + 0.25);
      let lvl = clamp01(((x - c.floor) / (c.peak - c.floor)) * 1.25);
      // (a level barely over the floor is breath / keyboard, not a word)
      if (x - c.floor < 0.12) lvl = 0;
      if (h.gate === false) lvl = 0;
      // mouth movement too (bleed check): only when the camera sees a mouth
      if (h.open !== null) { c.mo.push(h.open); c.mod = this.movement(c.mo); } else c.mod = -1;
      c.lvl = lvl;
      c.bleed = false; c.still = false;
      if (src === 'meter') metered.push(c);
    }
    // bleed: a performer's mic that follows a video guest's call audio, while their own mouth isn't moving with it
    if (metered.length) for (const id of this.order) {
      const c = this.ch.get(id)!;
      if (c.src !== 'mic' || c.lvl <= 0) continue;
      let worst = 0, best: Chan | null = null;
      for (const g of metered) if (g.lvl > 0.3 && g.cor.n >= CORW) { const r = corr(c.cor, g.cor); if (r > worst) { worst = r; best = g; } }
      const mouthSays = c.mod >= 0 ? c.mod > 0.35 : false;
      // (no mouth to ask: only a close match counts as the call, and what the call can't explain is the host talking
      // over it — the mic level left after the guest's share, still well over the floor)
      const need = c.mod >= 0 ? 0.6 : 0.8;
      if (best && worst > need && !mouthSays && residual(c.cor, best.cor) < Math.max(0.15, (c.peak - c.floor) * 0.3)) { c.bleed = true; c.lvl *= 0.1; }
    }
  }

  /** Mouth only: syllabic movement (mean |Δ| over 1 s), never the opening itself. */
  private mouth(c: Chan, open: number) {
    c.mo.push(open);
    c.mod = this.movement(c.mo);
    c.floor = c.mo.min(); c.peak = c.mo.max();
    c.still = c.mod < 0.15 && open > 0.25;              // (open and still: a resting / stuck mouth — the readout says so)
    // low confidence: the mouth must move AND open-close in a syllable rhythm (≥ 2 open-close cycles a second); a head
    // turn, a wink, a smirk or a grin moves the mouth once, slowly — not speech
    // and speech is UNEVEN: a laugh ("ha-ha-ha") or chewing opens and closes like clockwork (the gaps between turns
    // vary < 20 %), syllables don't (≥ 30 % on the owner's recorded clip)
    c.rh.push(open);
    const rhythm = clamp01((this.reversals(c.mo) - 1) / 2) * clamp01((this.unevenness(c.rh) - 0.22) / 0.1);
    c.lvl = clamp01((c.mod - 0.4) / 0.3) * rhythm;
    c.bleed = false;
  }

  /** Direction changes of the mouth opening over the window (each ≥ 0.035): ~2 per open-close cycle. */
  private reversals(r: Ring): number {
    if (r.n < 6) return 0;
    const H = 0.035;
    let n = 0, dir = 0, hi = r.at(r.n - 1), lo = hi;
    for (let k = r.n - 2; k >= 0; k--) {
      const x = r.at(k);
      if (dir === 0) { hi = Math.max(hi, x); lo = Math.min(lo, x); if (hi - x > H) { dir = -1; lo = x; } else if (x - lo > H) { dir = 1; hi = x; } }
      else if (dir > 0) { if (x > hi) hi = x; else if (hi - x > H) { n++; dir = -1; lo = x; } }
      else if (x < lo) lo = x; else if (x - lo > H) { n++; dir = 1; hi = x; }
    }
    return n;
  }


  /** Coefficient of variation of the gaps between the mouth's turns over the window (0 = clockwork); 1 when there are
   *  too few turns to tell (the movement / reversal gates decide then). */
  private unevenness(r: Ring): number {
    if (r.n < 8) return 1;
    const H = 0.035;
    let dir = 0, hi = r.at(r.n - 1), lo = hi, hiK = r.n - 1, loK = hiK, last = -1, n = 0, sum = 0, sum2 = 0;
    const turn = (k: number) => { if (last >= 0) { const g = last - k; sum += g; sum2 += g * g; n++; } last = k; };
    for (let k = r.n - 2; k >= 0; k--) {
      const x = r.at(k);
      if (dir === 0) { if (x > hi) { hi = x; hiK = k; } if (x < lo) { lo = x; loK = k; } if (hi - x > H) { turn(hiK); dir = -1; lo = x; loK = k; } else if (x - lo > H) { turn(loK); dir = 1; hi = x; hiK = k; } }
      else if (dir > 0) { if (x > hi) { hi = x; hiK = k; } else if (hi - x > H) { turn(hiK); dir = -1; lo = x; loK = k; } }
      else if (x < lo) { lo = x; loK = k; } else if (x - lo > H) { turn(loK); dir = 1; hi = x; hiK = k; }
    }
    if (n < 3) return 1;
    const m = sum / n;
    return Math.sqrt(Math.max(0, sum2 / n - m * m)) / m;
  }

  /** 0..1: how much a mouth moves like speech over the window (mean |Δopen| per 50 ms, ~0.08+ when talking). */
  private movement(r: Ring): number {
    if (r.n < 4) return 0;
    let s = 0;
    for (let k = 0; k < r.n - 1; k++) s += Math.abs(r.at(k) - r.at(k + 1));
    return clamp01((s / (r.n - 1)) / 0.1);
  }
}

/** The newest sample of `a` minus what a straight-line fit on `b` (over the shared window) explains of it. */
function residual(a: Ring, b: Ring): number {
  const n = Math.min(a.n, b.n);
  if (n < 8) return 1;
  let sa = 0, sb = 0;
  for (let k = 0; k < n; k++) { sa += a.at(k); sb += b.at(k); }
  const ma = sa / n, mb = sb / n;
  let sab = 0, sbb = 0;
  for (let k = 0; k < n; k++) { const y = b.at(k) - mb; sab += (a.at(k) - ma) * y; sbb += y * y; }
  const k1 = sbb > 1e-6 ? sab / sbb : 0;
  return a.at(0) - (ma + k1 * (b.at(0) - mb));
}

/** Pearson correlation of the overlapping newest samples of two rings. */
function corr(a: Ring, b: Ring): number {
  const n = Math.min(a.n, b.n);
  if (n < 8) return 0;
  let sa = 0, sb = 0;
  for (let k = 0; k < n; k++) { sa += a.at(k); sb += b.at(k); }
  const ma = sa / n, mb = sb / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let k = 0; k < n; k++) { const x = a.at(k) - ma, y = b.at(k) - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa > 1e-6 && sbb > 1e-6 ? sab / Math.sqrt(saa * sbb) : 0;
}
