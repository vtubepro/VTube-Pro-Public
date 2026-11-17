// The groove on a beat grid: which 16th-note slots of the bar carry the kick and the snare, how early / late each one
// sits (swing, a grid that is a little off, a drummer's feel), the feel (four-on-the-floor / backbeat / half-time /
// breakbeat / sparse) and where the bar really starts. Learned live from the music input's drum onsets on WHATEVER
// grid owns the show — the studio's own beat tracking or a DJ clock (Ableton Link, …): the grid gives the tempo and
// the beat, the audio gives the rhythm. Clean-room, after the rhythmic-pattern idea in the beat-tracking literature
// (decaying per-slot onset histograms; research/RHYTHM_NON44.md).
//
// The light show then hits the REAL pattern, pre-cued on the grid (a hit lands exactly on its slot + learned offset,
// not one detection latency after the drum): a rap beat flashes on its kick and snare, not on every beat; a half-time
// drop hits big on 3; a breakbeat gets its broken pattern. When the pattern isn't clear the show doesn't pretend: it
// follows the onsets / energy smoothly (`rhythmMode` 'free').
//
// Pure (no DOM, no Node): used by the studio's beat worker (src/audio/beat/beatAnalyzer.ts, on its own grid), the
// helper's music clock (shared/musicClock.ts, on the DJ clock's grid), every page (src/scene/beatClock.ts → the light
// director + the festival) and the Track library's offline analysis (shared/trackDsp.ts). Tests: tools/groove_unit.ts.

export const FEELS = ['free', 'four', 'back', 'half', 'break', 'sparse'] as const;
export type Feel = (typeof FEELS)[number];
/** One planned hit in the bar (slot 0..15 = 16ths from the downbeat; pos = where it really lands, beats from the
 *  downbeat, slot / 4 + the learned offset). */
export interface GrooveHit { slot: number; pos: number; kind: 'kick' | 'snare'; w: number }
export interface GrooveState {
  feel: Feel;
  /** how sure the pattern is, 0..1 (repeats bar after bar and explains most of the drums) */
  conf: number;
  /** every slot that carries a drum often enough (w = how often, 0..1), sorted by slot, relative to the downbeat */
  hits: GrooveHit[];
  /** half-time feel: the backbeat is on 3 (the lights count half the tempo) */
  half: boolean;
  /** off-8th placement 0.5 = straight … 0.67 = triplet swing (NaN = no off-8th drums) */
  swing: number;
  /** the bar starts on raw beat index b when (b − barShift) mod 4 = 0; how sure (0..1) */
  barShift: number; barConf: number;
  /** bars learned (decayed) */
  bars: number;
}
export const EMPTY_GROOVE: GrooveState = { feel: 'free', conf: 0, hits: [], half: false, swing: NaN, barShift: 0, barConf: 0, bars: 0 };

const DECAY = 0.82;              // per bar: ~5 bars of memory (a new section takes over within 2-4 bars)
const W_MIN = 0.5;               // a slot is part of the pattern at half the strongest slot's rate (or more)
const posMod = (x: number, m: number) => ((x % m) + m) % m;

/** Learns the groove from onsets placed on a grid. Positions are the grid's continuous beat counter (integers = beats). */
export class GrooveTracker {
  private K = new Float64Array(16); private S = new Float64Array(16);
  private KO = new Float64Array(16); private SO = new Float64Array(16);
  private n = 0;
  private bar = NaN;
  private curK = new Float64Array(16); private curS = new Float64Array(16); private curKO = new Float64Array(16); private curSO = new Float64Array(16);
  private shift = 0; private shiftCand = -1; private shiftRun = 0; private shiftConf = 0;
  private lastPos = NaN;
  private st: GrooveState = { ...EMPTY_GROOVE };
  /** bias (beats) subtracted from every onset before it is learned (a detector that reports hits a little late) */
  biasBeats = 0;
  private decay: number; private fixedBar: boolean;
  /** `decay` per bar (default ~5 bars of memory; 1 = average everything: offline, one phrase); `fixedBar` = the grid's
   *  bar is known (an analysed track's grid): never search for the downbeat */
  constructor(o: { decay?: number; fixedBar?: boolean } = {}) { this.decay = o.decay ?? DECAY; this.fixedBar = !!o.fixedBar; }

  reset() { this.K.fill(0); this.S.fill(0); this.KO.fill(0); this.SO.fill(0); this.n = 0; this.bar = NaN; this.clearCur(); this.shiftCand = -1; this.shiftRun = 0; this.shiftConf = 0; this.lastPos = NaN; this.st = { ...EMPTY_GROOVE, barShift: this.shift }; }
  private clearCur() { this.curK.fill(0); this.curS.fill(0); this.curKO.fill(0); this.curSO.fill(0); }

  /** A drum onset at grid position `pos` (strength 0..1). */
  hit(kind: 'kick' | 'snare', pos: number, w = 1) {
    if (!Number.isFinite(pos)) return;
    const p = pos - this.biasBeats;
    this.tick(p);
    const x = p * 4, s16 = Math.round(x), off = (x - s16) / 4;   // offset in beats (−⅛ … ⅛)
    const slot = posMod(s16, 16);
    if (kind === 'kick') { if (w > this.curK[slot]) { this.curK[slot] = w; this.curKO[slot] = off; } }
    else if (w > this.curS[slot]) { this.curS[slot] = w; this.curSO[slot] = off; }
  }

  /** Close the bar in progress now (offline: the end of a phrase). */
  flush() { if (Number.isFinite(this.bar)) this.tick((this.bar + 1) * 4 + 0.01); }

  /** Advance to grid position `pos` (call every packet / frame): closes finished bars. Returns true when a bar closed. */
  tick(pos: number): boolean {
    if (!Number.isFinite(pos)) return false;
    // a jump (re-anchor, a loop, a cue): bars that never played are not "empty bars"
    if (Number.isFinite(this.lastPos) && (pos < this.lastPos - 2 || pos > this.lastPos + 16)) { this.bar = NaN; this.clearCur(); }
    this.lastPos = pos;
    const bar = Math.floor((pos * 4 + 0.5) / 16);
    if (!Number.isFinite(this.bar)) { this.bar = bar; return false; }
    if (bar <= this.bar) return false;
    // close the bar(s): decayed histograms (a skipped bar decays the pattern once more)
    for (let b = this.bar; b < bar && b < this.bar + 4; b++) {
      for (let s = 0; s < 16; s++) {
        const k = b === this.bar ? this.curK[s] : 0, sn = b === this.bar ? this.curS[s] : 0;
        this.K[s] = this.K[s] * this.decay + k; this.S[s] = this.S[s] * this.decay + sn;
        this.KO[s] = this.KO[s] * this.decay + k * this.curKO[s]; this.SO[s] = this.SO[s] * this.decay + sn * this.curSO[s];
      }
      this.n = this.n * this.decay + 1;
      this.clearCur();
    }
    this.bar = bar;
    this.solve();
    return true;
  }

  /** The grid renumbered its beats (a re-anchor at the same tempo): new position = old position + `delta` beats.
   *  The learned pattern moves with it (slots rotate, offsets keep their real place). */
  rebase(delta: number) {
    if (!Number.isFinite(delta)) { this.reset(); return; }
    const q = Math.round(delta * 4), res = delta - q / 4;
    const rot = (a: Float64Array) => { const c = Float64Array.from(a); for (let s = 0; s < 16; s++) a[posMod(s + q, 16)] = c[s]; };
    for (const a of [this.K, this.S, this.KO, this.SO, this.curK, this.curS, this.curKO, this.curSO]) rot(a);
    for (let s = 0; s < 16; s++) { this.KO[s] += this.K[s] * res; this.SO[s] += this.S[s] * res; this.curKO[s] += res; this.curSO[s] += res; }
    this.shift = posMod(this.shift + Math.round(delta), 4);
    if (Number.isFinite(this.lastPos)) this.lastPos += delta;
    this.bar = NaN;
    this.solve();
  }

  get state(): GrooveState { return this.st; }

  private solve() {
    const n = Math.max(1e-6, this.n);
    // (live onset detection catches roughly half of a mix's drum hits: the pattern is read RELATIVE to its strongest
    // slot, so a groove the detector hears 50 % of the time is as clear as one it hears every time)
    const raw = (a: Float64Array) => Array.from(a, (v) => Math.min(1, v / n));
    const rk = raw(this.K), rs = raw(this.S);
    const m = Math.max(0.2, ...rk, ...rs);
    const pk = rk.map((v) => v / m), ps = rs.map((v) => v / m);
    const at = (a: number[], r: number, s: number) => a[posMod(s + 4 * r, 16)];
    // ---- the bar start: kick on 1, snare on 2 & 4 (backbeat) or on 3 (half-time) — the template that fits best
    const score = (r: number) => {
      const back = at(pk, r, 0) + 0.5 * at(pk, r, 8) + at(ps, r, 4) + at(ps, r, 12) - 0.6 * (at(ps, r, 0) + at(ps, r, 8)) - 0.3 * (at(pk, r, 4) + at(pk, r, 12)) * (at(ps, r, 4) + at(ps, r, 12) > 0.6 ? 0 : 1);
      const half = at(pk, r, 0) + 1.6 * at(ps, r, 8) - 0.8 * (at(ps, r, 4) + at(ps, r, 12) + at(ps, r, 0));
      // (a backbeat reads the same from beat 1 or beat 3; the kick comes more often in a bar's first half — 1, its
      // pick-ups — than in its second: a small tie-break)
      let first = 0, second = 0; for (let s = 0; s < 8; s++) { first += at(pk, r, s); second += at(pk, r, s + 8); }
      return Math.max(back, half) + 0.2 * (first - second);
    };
    const sc = [0, 1, 2, 3].map(score);
    let best = 0; for (let r = 1; r < 4; r++) if (sc[r] > sc[best]) best = r;
    const sorted = [...sc].sort((a, b) => b - a);
    const margin = sorted[0] - sorted[1];
    if (this.fixedBar) { /* the grid knows its bar */ }
    else if (best !== this.shift) {
      if (best === this.shiftCand) this.shiftRun++; else { this.shiftCand = best; this.shiftRun = 1; }
      // (switch only after 4 bars of a clear lead and enough history: the bar line never flickers)
      if (this.shiftRun >= 4 && margin > 0.25 && this.n >= 3.5) { this.shift = best; this.shiftRun = 0; this.shiftCand = -1; }
    } else { this.shiftCand = -1; this.shiftRun = 0; }
    const r = this.shift;
    // (sure of the backbeat's PARITY — snares on 2 & 4, not 1 & 3 — is what matters most; 1-vs-3 rides on the tie-break)
    this.shiftConf = Math.max(0, Math.min(1, (sc[r] - Math.max(sc[(r + 1) % 4], sc[(r + 3) % 4])) / 0.8)) * Math.min(1, this.n / 4);
    // ---- slots relative to the chosen downbeat
    const K = (s: number) => at(pk, r, s), Sn = (s: number) => at(ps, r, s);
    const offK = (s: number) => { const i = posMod(s + 4 * r, 16); return this.K[i] > 1e-6 ? this.KO[i] / this.K[i] : 0; };
    const offS = (s: number) => { const i = posMod(s + 4 * r, 16); return this.S[i] > 1e-6 ? this.SO[i] / this.S[i] : 0; };
    let perBar = 0; for (let s = 0; s < 16; s++) perBar += (K(s) + Sn(s)) * m;
    const hits: GrooveHit[] = [];
    let inS = 0, inN = 0, outS = 0, outN = 0;
    for (let s = 0; s < 16; s++) {
      const k = K(s), sn = Sn(s), P = Math.max(k, sn);
      if (P < W_MIN) { outS += P; outN++; continue; }
      inS += P; inN++;
      const kick = k >= sn * 0.9;
      const off = kick ? offK(s) : offS(s);
      hits.push({ slot: s, pos: s / 4 + Math.max(-0.125, Math.min(0.125, off)), kind: kick ? 'kick' : 'snare', w: +P.toFixed(3) });
    }
    // four-on-the-floor: a kick on every beat, about equally often, and most of the kicks there (judged among the kicks:
    // a clap the detector hears better than the kick must not hide it)
    const beatKick = [0, 4, 8, 12].map(K), kMax = Math.max(1e-6, ...Array.from({ length: 16 }, (_, s) => K(s)));
    let kAll = 0; for (let s = 0; s < 16; s++) kAll += K(s);
    const four = Math.min(...beatKick) / kMax >= 0.6 && beatKick.reduce((a, b) => a + b, 0) / Math.max(1e-6, kAll) >= 0.6 && kMax >= 0.25;
    const half = !four && Sn(8) >= 0.5 && Sn(4) < 0.35 && Sn(12) < 0.35 && K(0) >= 0.4;
    const back = !four && !half && Sn(4) >= 0.45 && Sn(12) >= 0.45;
    let offKick = 0; for (let s = 0; s < 16; s++) if (s % 4) offKick += K(s);
    const feel: Feel = this.n < 2.5 ? 'free' : perBar < 1.3 ? 'sparse' : four ? 'four' : half ? 'half' : back ? 'back' : offKick >= 0.5 && hits.length >= 3 ? 'break' : hits.length >= 2 ? 'break' : 'free';
    // confidence: the pattern's slots stand out from the rest of the bar (a random scatter of onsets doesn't), the
    // strongest slot repeats in a fair share of bars, and there is enough history
    const pin = inN ? inS / inN : 0, pout = outN ? outS / outN : 0;
    const contrast = pin > 0 ? (pin - pout) / pin : 0;
    const conf = Math.max(0, Math.min(1, (contrast - 0.45) / 0.35)) * Math.max(0, Math.min(1, (m - 0.15) / 0.25)) * Math.min(1, this.n / 4) * (hits.length > 10 ? 0.5 : 1);
    // swing: where the off-8th drums sit (slot 2 / 6 / 10 / 14 + their offset)
    let sw = 0, swn = 0; for (const s of [2, 6, 10, 14]) { const w = K(s) + Sn(s); if (w > 0.3) { sw += w * (0.5 + (K(s) >= Sn(s) ? offK(s) : offS(s))); swn += w; } }
    this.st = { feel, conf: +conf.toFixed(3), hits, half, swing: swn ? +(sw / swn).toFixed(3) : NaN, barShift: this.shift, barConf: +this.shiftConf.toFixed(3), bars: +this.n.toFixed(2) };
  }
}

// ---------------------------------------------------------------------------------------------------- the light plan
/**
 * The hits the lights take in one bar: the groove's slots, strongest first, keeping every two at least `minGapS`
 * seconds apart around the bar (the photosensitivity limit: ≤ 3 full flashes a second → 0.34 s; the output governor
 * still checks everything that is drawn). Deterministic: every page plays the same hits.
 */
export function hitPlan(hits: readonly GrooveHit[], bpm: number, minGapS = 0.34): GrooveHit[] {
  if (!hits.length || !(bpm > 0)) return [];
  const gap = Math.max(0.24, minGapS * bpm / 60);    // beats (never 16th clutter)
  const order = [...hits].sort((a, b) => (b.w * (b.kind === 'kick' ? 1.05 : 1) + (b.slot === 0 ? 0.2 : 0)) - (a.w * (a.kind === 'kick' ? 1.05 : 1) + (a.slot === 0 ? 0.2 : 0)) || a.slot - b.slot);
  const kept: GrooveHit[] = [];
  for (const h of order) {
    if (kept.some((k) => { const d = Math.abs(k.pos - h.pos); return Math.min(d, 4 - d) < gap - 1e-6; })) continue;
    kept.push(h);
  }
  return kept.sort((a, b) => a.pos - b.pos);
}
/** hitPlan, cached for the last groove / tempo / limit (pages call it every frame; the groove changes once a bar). */
const planCache = new Map<string, GrooveHit[]>();
/** (per hits array: the last few plans asked of it - pages ask every frame, per fixture; no string key, no allocation) */
const planMemo = new WeakMap<readonly GrooveHit[], { b: number; gap: number; v: GrooveHit[] }[]>();
export function planFor(hits: readonly GrooveHit[], bpm: number, safe: boolean, minGapS?: number): GrooveHit[] {
  // (safe: the same 2.2 hits a second the grid pulses are held to — margin under the 3 a second limit for the other
  //  layers that may hit in between; tools/lights_unit.ts 'Room / Calm never need the notice')
  const gap = minGapS ?? (safe ? 1 / 2.2 : 0.2), b2 = Math.round(bpm * 2);
  let memo = planMemo.get(hits);
  if (memo) for (const m of memo) if (m.b === b2 && m.gap === gap) return m.v;
  const key = `${b2}|${gap}|${hits.map((h) => `${h.slot}${h.kind[0]}${h.w}:${h.pos}`).join(',')}`;
  let v = planCache.get(key);
  if (!v) { v = hitPlan(hits, bpm, gap); planCache.set(key, v); if (planCache.size > 24) planCache.delete(planCache.keys().next().value as string); }
  if (!memo) planMemo.set(hits, (memo = []));
  memo.push({ b: b2, gap, v }); if (memo.length > 4) memo.shift();
  return v;
}
/** A plan split by role (cached per plan array: no per-frame filtering): its kicks, its snares, the bar's first kick
 *  (pos < 1, the downbeat's drum; empty = none on the 1) and the bar's first real drum of any kind (`first`: where a bar
 *  cue goes when there is no kick on the 1 - a missing drum on beat 1 is never treated as the grid's bar line). */
export interface PlanParts { kicks: GrooveHit[]; snares: GrooveHit[]; down: GrooveHit[]; first: GrooveHit[] }
const partsMemo = new WeakMap<readonly GrooveHit[], PlanParts>();
export function planParts(plan: readonly GrooveHit[]): PlanParts {
  let p = partsMemo.get(plan);
  if (!p) {
    const kicks = plan.filter((h) => h.kind === 'kick'), snares = plan.filter((h) => h.kind === 'snare');
    const d = kicks.filter((h) => h.pos < 1).sort((a, b) => a.pos - b.pos)[0];
    const f0 = [...plan].sort((a, b) => a.pos - b.pos)[0];
    p = { kicks, snares, down: d ? [d] : [], first: d ? [d] : f0 ? [f0] : [] };
    partsMemo.set(plan, p);
  }
  return p;
}
/** Onset envelopes 0..1 from a groove plan at bar position `barPos` (pre-cued, so latency-free): the kick / snare that
 *  played last decays like the analysers' envelopes (kick ~160 ms, snare ~180 ms). */
const LHK: LastHit = { age: 0, w: 0, slot: 0, kind: 'kick', barOff: 0 }, LHS: LastHit = { age: 0, w: 0, slot: 0, kind: 'snare', barOff: 0 };
export function planEnvelopes(plan: readonly GrooveHit[], barPos: number, bpm: number, out: { kick: number; snare: number }) {
  const spb = 60 / Math.max(40, bpm), lead = HIT_LEAD_MS * bpm / 60000, P = planParts(plan);
  const k = lastHit(P.kicks, barPos + lead, LHK), s = lastHit(P.snares, barPos + lead, LHS);
  out.kick = k ? k.w * Math.exp(-k.age * spb / 0.16) : 0;
  out.snare = s ? s.w * Math.exp(-s.age * spb / 0.18) : 0;
  return out;
}
/** A frame shows its picture for a whole frame: a pre-cued hit is aimed half a frame early (at 60 fps), so the frame that
 *  first shows it is centred on the drum, not up to a frame after it (measured: tools/beat/rhythm_eval.ts). */
export const HIT_LEAD_MS = 8;
/** The hit of `plan` that played last at bar position `barPos` (0..4): its age (beats), weight, slot and which bar it
 *  belonged to (−1 = the previous one). null = none in the plan. */
export interface LastHit { age: number; w: number; slot: number; kind: GrooveHit['kind']; barOff: number }
/** (`out`: the caller's scratch - no allocation per call; without it a new object) */
export function lastHit(plan: readonly GrooveHit[], barPos: number, out?: LastHit): LastHit | null {
  let bi = -1, bAge = Infinity, bOff = 0;
  for (let i = 0; i < plan.length; i++) for (let k = 0; k < 3; k++) {
    const bo = k === 0 ? 0 : k === 1 ? -1 : 1, age = barPos - (plan[i].pos + bo * 4);
    if (age < 0 || age > 4) continue;
    if (age < bAge) { bAge = age; bi = i; bOff = bo; }
  }
  if (bi < 0) return null;
  const h = plan[bi], o = out ?? { age: 0, w: 0, slot: 0, kind: 'kick', barOff: 0 };
  o.age = bAge; o.w = h.w; o.slot = h.slot; o.kind = h.kind; o.barOff = bOff;
  return o;
}

// ---------------------------------------------------------------------------------------------------- drum phases
/**
 * Where the music is between two of its drums, for one list of a plan (all hits / kicks / snares / the bar's first kick):
 * beats since the last one (`age`, NaN = the list is empty), beats from it to the next one (`gap`), its weight and kind,
 * a stable id (absolute bar x 16 + slot: one flash decision per drum hit) and a running count (`seq`: left / right
 * alternation drum by drum). The lights' INTENSITY
 * follows these (the drums own the hits); the show's figures keep moving on the grid (shared/showPack/rhythm.ts).
 */
export interface DrumPhase { age: number; gap: number; w: number; kind: GrooveHit['kind']; id: number; seq: number }
export interface Drums { any: DrumPhase; kick: DrumPhase; snare: DrumPhase; down: DrumPhase; first: DrumPhase; n: number }
const newPhase = (): DrumPhase => ({ age: NaN, gap: 4, w: 0, kind: 'kick', id: 0, seq: 0 });
export const newDrums = (): Drums => ({ any: newPhase(), kick: newPhase(), snare: newPhase(), down: newPhase(), first: newPhase(), n: 0 });
const LHD: LastHit = { age: 0, w: 0, slot: 0, kind: 'kick', barOff: 0 };
function phaseOf(list: readonly GrooveHit[], x: number, bar: number, out: DrumPhase): DrumPhase {
  const h = list.length ? lastHit(list, x, LHD) : null;
  if (!h) { out.age = NaN; out.gap = 4; out.w = 0; out.id = 0; out.seq = 0; return out; }
  const at = x - h.age;
  let gap = 4;
  for (const q of list) for (let bo = -1; bo <= 2; bo++) { const d = q.pos + bo * 4 - at; if (d > 1e-6 && d < gap) gap = d; }
  let j = 0; for (let i = 0; i < list.length; i++) if (list[i].slot === h.slot && list[i].kind === h.kind) { j = i; break; }
  out.age = h.age; out.gap = Math.max(0.25, gap); out.w = h.w; out.kind = h.kind; out.id = (bar + h.barOff) * 16 + h.slot; out.seq = (bar + h.barOff) * list.length + j;
  return out;
}
/** Fill `out` with the plan's drum phases at bar position `barPos` of bar `bar` (pre-cued by HIT_LEAD_MS). */
export function drumPhases(plan: readonly GrooveHit[], barPos: number, bar: number, bpm: number, out: Drums): Drums {
  const P = planParts(plan), x = barPos + HIT_LEAD_MS * bpm / 60000;
  phaseOf(plan, x, bar, out.any); phaseOf(P.kicks, x, bar, out.kick); phaseOf(P.snares, x, bar, out.snare); phaseOf(P.down, x, bar, out.down); phaseOf(P.first, x, bar, out.first);
  out.n = plan.length;
  return out;
}

// ---------------------------------------------------------------------------------------------------- on the wire
/** The packet fields (shared/lightShow.ts BeatPacket `gf` / `gc` / `gh` / `gw`, + `sf`: the sender's latched show feel). */
export interface GrooveWire { gf: number; gc: number; gh: number[]; gw?: number; sf?: number }
/** `sf` on the wire: the FEELS index, −1 = none latched yet. */
export const feelToWire = (f: Feel | undefined): number => (f ? FEELS.indexOf(f) : -1);
/** undefined = no `sf` (an older sender), null = none latched yet */
export function feelFromWire(v: unknown): Feel | null | undefined {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < -1 || v >= FEELS.length) return undefined;
  return v < 0 ? null : FEELS[v];
}

/** The feel the 'auto' show family follows, LATCHED: a confident feel (half / back / break / four, conf >= 0.5) has to
 *  hold for 4 bars running (the first one 2), 'sparse' / 'free' never move it (a breakdown keeps the last), and it never
 *  changes in a build or in the 16 bars after a drop - a drop opens in the family it will play. It runs on the SENDER
 *  that publishes the groove (the studio's analyser, the helper's music clock) and rides the packets as `sf`: every page
 *  plays the same family, whenever it was opened (a page latches locally only for an older sender). */
export class FeelLatch {
  feel: Feel | undefined;
  private cand: Feel | undefined; private run = 0; private bar = NaN;
  /** once per bar (`bar` = a running bar count; repeats are ignored); `frozen` = in a build or < 16 bars after a drop */
  step(bar: number, g: { feel: Feel; conf: number } | null | undefined, frozen: boolean): Feel | undefined {
    if (!Number.isFinite(bar) || bar === this.bar) return this.feel;
    this.bar = bar;
    const cf = g && g.conf >= 0.5 && (g.feel === 'half' || g.feel === 'back' || g.feel === 'break' || g.feel === 'four') ? g.feel : undefined;
    if (cf && cf === this.cand) this.run++; else { this.cand = cf; this.run = cf ? 1 : 0; }
    if (!frozen && cf && cf !== this.feel && this.run >= (this.feel === undefined ? 2 : 4)) this.feel = cf;
    return this.feel;
  }
}
export function grooveToWire(g: GrooveState): GrooveWire {
  const gh: number[] = [];
  for (const h of g.hits.slice(0, 16)) gh.push(h.slot, Math.round(h.w * 100) * (h.kind === 'kick' ? 1 : -1), Math.round((h.pos - h.slot / 4) * 1000));
  const w: GrooveWire = { gf: FEELS.indexOf(g.feel), gc: +g.conf.toFixed(2), gh };
  if (Number.isFinite(g.swing)) w.gw = g.swing;
  return w;
}
/** Sanitised wire fields → hits (null = none / bad). */
export function grooveFromWire(gf: unknown, gc: unknown, gh: unknown, gw?: unknown): { feel: Feel; conf: number; hits: GrooveHit[]; half: boolean; swing: number } | null {
  if (typeof gf !== 'number' || !Number.isInteger(gf) || gf < 0 || gf >= FEELS.length || typeof gc !== 'number' || !Number.isFinite(gc)) return null;
  const hits: GrooveHit[] = [];
  if (Array.isArray(gh)) for (let i = 0; i + 2 < gh.length && i < 48; i += 3) {
    const s = gh[i], w = gh[i + 1], o = gh[i + 2];
    if (![s, w, o].every((v) => typeof v === 'number' && Number.isFinite(v)) || s < 0 || s > 15 || !Number.isInteger(s) || Math.abs(w) > 100 || Math.abs(o) > 125) continue;
    hits.push({ slot: s, pos: s / 4 + o / 1000, kind: w >= 0 ? 'kick' : 'snare', w: Math.abs(w) / 100 });
  }
  const feel = FEELS[gf];
  return { feel, conf: Math.max(0, Math.min(1, gc)), hits, half: feel === 'half', swing: typeof gw === 'number' && Number.isFinite(gw) ? Math.max(0.4, Math.min(0.8, gw)) : NaN };
}

/** How the show should follow the rhythm now: the grid (four-on-the-floor), the learned groove, or freely (no clear
 *  pattern: smooth, onset / energy reactive — never a wrong grid). */
export type RhythmMode = 'grid' | 'groove' | 'free';
export function rhythmMode(g: { feel: Feel; conf: number } | null | undefined, locked: boolean): RhythmMode {
  if (!locked) return 'free';
  if (!g) return 'grid';                         // (an older studio: no groove on the wire → as before)
  if (g.feel === 'four' && g.conf >= 0.3) return 'grid';
  if (g.conf >= 0.4 && (g.feel === 'back' || g.feel === 'half' || g.feel === 'break' || g.feel === 'sparse')) return 'groove';
  return g.conf < 0.25 || g.feel === 'free' ? 'free' : 'groove';
}
