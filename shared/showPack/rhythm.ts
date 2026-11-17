// Show pack: the musical moment a look reads (one small interface for every engine) and the RHYTHM TARGETS - which
// instants of the bar a light hits (four on the floor, offbeats, the backbeat snare, hats, 8ths, 16ths, triplets, the
// dotted-8th echo, call and response, the phrase, the bar) and how it moves between them (the motion envelope).
//
// The frame (RhythmFrame) is filled per rendered frame by whoever drives the lights:
//   - the festival stage from its MusicState (kick / snare / hat envelopes from its own analysis),
//   - the club rig from the page's BeatClock (rhythmFromClock: kickAt / snareAt / hatAt events + envelopes),
//   - the room director from its MusicFrame (only a kick presence there: snare / hat fall back to the grid).
// The multi-band onset + groove detection (src/audio/beat/*, another lane) only has to fill kick / snare / hat (0..1
// envelopes) and `onsets: true`; until then gridOnsets() stubs them from the beat grid, so every target already lands
// on the music (positions come from the grid - latency-free - and detected onsets only modulate depth).
//
// Photosensitivity: targetLevel() never flashes a unison group faster than the limit when `safe` is set. A target whose
// hits come faster than ~2.2 a second becomes SPATIAL there (each fixture takes every k-th hit, so the hit travels
// across the rig and the group's total light stays steady) and hard envelopes soften to pulses. The governors
// (shared/flashGovernor.ts, the festival gate) still check every drawn output on top.
import { fract, hash3 } from '../festival.ts';
import { drumPhases, newDrums, planEnvelopes, planFor, rhythmMode, type DrumPhase, type Drums, type Feel, type GrooveHit, type RhythmMode } from '../groove.ts';

export type PackSection = 'intro' | 'groove' | 'build' | 'drop' | 'breakdown' | 'outro';
export const PACK_SECTIONS: PackSection[] = ['intro', 'groove', 'build', 'drop', 'breakdown', 'outro'];

/** The per-frame interface the pack consumes (the rhythm lane fills kick / snare / hat; sectionHints are optional). */
export interface RhythmFrame {
  /** continuous beat on the shared grid, bar index, beat in bar 0..4, BPM */
  beat: number; bar: number; barPos: number; bpm: number;
  /** onset envelopes 0..1 (1 = this instant) */
  kick: number; snare: number; hat: number;
  /** true = kick / snare / hat come from detected onsets; false = grid stubs */
  onsets: boolean;
  /** loudness relative to the track 0..1 */
  energy: number;
  section: PackSection;
  /** build ramp 0..1, beats since the drop (Infinity = none), beat in the 8-bar phrase */
  build: number; dropAge: number; phraseBeat: number;
  /** optional hints from a section / groove detector: half-time feel, swing amount, a snare roll now */
  sectionHints?: { halfTime?: boolean; swing?: number; roll?: number; nextDrop?: number | null };
  /** the rhythm lane's groove (shared/groove.ts): 'groove' = the lights' INTENSITY follows the track's own drums (`plan`,
   *  pre-cued on the grid, flash-limited; `drums` = where the music is between them), the figures keep moving on the grid;
   *  'grid' / 'free' = the grid targets as authored, hats soft (`feel` 'four' = a detected four-on-the-floor);
   *  absent = an older studio, everything as authored */
  rhythm?: RhythmMode; plan?: GrooveHit[]; drums?: Drums; feel?: Feel;
}

/** Grid stubs for the onset envelopes (until detected onsets land): kick on every beat, snare on 2 + 4, hats on the
 *  off-8ths. Envelopes decay like the analysers' (kick ~160 ms, snare ~180 ms, hat ~90 ms at 128 BPM). */
export function gridOnsets(beat: number, bpm: number, kickOn = true, out?: { kick: number; snare: number; hat: number }): { kick: number; snare: number; hat: number } {
  const spb = 60 / Math.max(40, bpm);
  const bp = fract(beat), bar = fract(beat / 4) * 4;
  const sn = bar < 1 ? bar + 1 : bar < 3 ? bar - 1 : bar - 3;
  const o = out ?? { kick: 0, snare: 0, hat: 0 };      // (`out`: the caller's scratch - per-frame callers pass one)
  o.kick = kickOn ? Math.exp(-bp * spb / 0.16) : 0; o.snare = Math.exp(-sn * spb / 0.18); o.hat = Math.exp(-fract(beat - 0.5) * spb / 0.09);
  return o;
}

/** A clock with the BeatClock's shape (src/scene/beatClock.ts) - structural, so shared code needs no page import. */
export interface ClockLike {
  bpm: number; section: string; env: { e: number; k?: number; s?: number; h?: number }; kickAt: number; snareAt: number; hatAt: number; dropAt: number;
  kickPresence: number; phraseBeat: number;
  posAt(t: number): number; barAt(t: number): number; barPosAt(t: number): number; active(t: number): boolean;
  /** the groove on the clock's grid (newer studios / music clocks; src/scene/beatClock.ts) */
  locked?: boolean; grooveNow?(t: number): { feel: import('../groove.ts').Feel; conf: number; hits: GrooveHit[]; half: boolean } | null;
}
/** The safe unison limit as a plan gap: a pack target's hits never come faster than SAFE_UNISON_HZ in unison. */
const PACK_PLAN_GAP_S = 1 / 2.2;
const ENV = { kick: 0, snare: 0 }, GRID = { kick: 0, snare: 0, hat: 0 };
const SEC: Record<string, PackSection> = { intro: 'intro', listening: 'groove', groove: 'groove', verse: 'groove', buildup: 'build', build: 'build', up: 'build', drop: 'drop', chorus: 'drop', breakdown: 'breakdown', down: 'breakdown', bridge: 'breakdown', outro: 'outro' };
export const packSection = (s: string | undefined): PackSection => SEC[s ?? ''] ?? 'groove';

const evEnv = (now: number, at: number, tau: number, spb: number) => (now - at >= 0 && now - at < 4 * spb ? Math.exp(-(now - at) / tau) : 0);
/** Fill a RhythmFrame from a page's beat clock at `now` (epoch ms). Events newer than ~1.5 beats count as onsets. */
export function rhythmFromClock(c: ClockLike, now: number, out: RhythmFrame, buildFrom = -Infinity): RhythmFrame {
  const bpm = c.bpm >= 40 ? c.bpm : 120;
  let beat = c.posAt(now); if (!Number.isFinite(beat)) beat = now / (60000 / bpm);
  const spb = 60000 / bpm;
  out.beat = beat; out.bpm = bpm;
  out.bar = Number.isFinite(c.barAt(now)) ? c.barAt(now) : Math.floor(beat / 4);
  out.barPos = Number.isFinite(c.barPosAt(now)) ? c.barPosAt(now) : fract(beat / 4) * 4;
  const k = evEnv(now, c.kickAt, 160, spb), s = evEnv(now, c.snareAt, 180, spb), h = evEnv(now, c.hatAt, 90, spb);
  const live = now - Math.max(c.kickAt, c.snareAt, c.hatAt) < 1.5 * spb;
  const kickOn = !(c.kickPresence < 0.3);
  if (live) { out.kick = k; out.snare = s; out.hat = h; out.onsets = true; }
  else { const g = gridOnsets(beat, bpm, kickOn, GRID); out.kick = g.kick; out.snare = g.snare; out.hat = g.hat; out.onsets = false; }
  // the groove (rhythm lane): the kick / snare targets hit the track's own slots, and their envelopes come from the
  // pre-cued plan (latency-free) instead of the late detected events
  const gr = c.grooveNow ? c.grooveNow(now) : null;
  out.rhythm = c.grooveNow ? rhythmMode(gr, Number.isFinite(c.posAt(now)) && c.locked !== false) : undefined;
  out.feel = gr?.feel;
  out.plan = out.rhythm === 'groove' && gr ? planFor(gr.hits, bpm, true, PACK_PLAN_GAP_S) : undefined;
  if (out.plan) {
    planEnvelopes(out.plan, out.barPos, bpm, ENV); out.kick = ENV.kick; out.snare = ENV.snare; out.onsets = true;
    drumPhases(out.plan, out.barPos, out.bar, bpm, (out.drums ??= newDrums()));
    (out.sectionHints ??= {}).halfTime = !!gr?.half;
  } else if (out.drums) out.drums.n = 0;
  out.energy = Math.max(0, Math.min(1, c.env.e));
  out.section = packSection(c.section);
  out.dropAge = Number.isFinite(c.dropAt) && now >= c.dropAt ? (now - c.dropAt) / spb : Infinity;
  out.build = out.section === 'build' ? Math.min(1, Math.max(0, (now - buildFrom) / (spb * 32))) : 0;
  out.phraseBeat = Number.isFinite(c.phraseBeat) ? c.phraseBeat : ((out.bar % 8) + 8) % 8 * 4 + Math.floor(out.barPos);
  return out;
}
export const newRhythmFrame = (): RhythmFrame => ({ beat: 0, bar: 0, barPos: 0, bpm: 120, kick: 0, snare: 0, hat: 0, onsets: false, energy: 0.5, section: 'groove', build: 0, dropAge: Infinity, phraseBeat: 0 });

// ---------------------------------------------------------------------------------------------------- targets
export type Target = 'four' | 'offbeat' | 'snare' | 'hat' | 'eighths' | 'sixteenths' | 'triplets' | 'dotted' | 'call' | 'phrase' | 'bar' | 'halfbar' | 'gallop' | 'shuffle' | 'split' | 'hold';
export interface TargetDef {
  id: Target; name: string; word: string;
  /** hits per beat (for the flash budget: unison hits per second = perBeat x BPM / 60) */
  perBeat: number;
  /** which onset class scales its depth when onsets are detected */
  onset: 'kick' | 'snare' | 'hat' | null;
  energy: number;
}
const T = (id: Target, name: string, word: string, perBeat: number, onset: TargetDef['onset'], energy: number): TargetDef => ({ id, name, word, perBeat, onset, energy });
export const TARGETS: TargetDef[] = [
  T('four', 'Four on the floor', 'Four', 1, 'kick', 0.6),
  T('offbeat', 'Offbeat', 'Offbeat', 1, 'hat', 0.62),
  T('snare', 'Backbeat snare (2 + 4)', 'Snare', 0.5, 'snare', 0.55),
  T('hat', 'Hats (off-16ths)', 'Hats', 2, 'hat', 0.7),
  T('eighths', 'Eighths', 'Eighths', 2, null, 0.75),
  T('sixteenths', 'Sixteenths', 'Sixteenths', 4, 'hat', 0.92),
  T('triplets', 'Triplets', 'Triplets', 3, null, 0.8),
  T('dotted', 'Dotted eighths', 'Dotted', 4 / 3, null, 0.72),
  T('call', 'Call and response', 'Call', 0.75, null, 0.58),
  T('phrase', 'The phrase (every 2 bars)', 'Phrase', 1 / 8, null, 0.3),
  T('bar', 'The bar', 'Bar', 0.25, 'kick', 0.4),
  T('halfbar', 'Half bars (1 + 3)', 'Half-bar', 0.5, 'kick', 0.5),
  T('gallop', 'Gallop (reverse-bass 16ths)', 'Gallop', 3, 'kick', 0.88),
  T('shuffle', 'Shuffle (beat + a swung 8th)', 'Shuffle', 2, 'hat', 0.6),
  T('split', 'Split (left / right on alternate beats)', 'Split', 1, 'kick', 0.7),
  T('hold', 'Hold', 'Glow', 0, null, 0.1),
];
export const targetById = (id: string) => TARGETS.find((t) => t.id === id);

/** The hit grid of a target: the latest hit at or before `beat` - its beat, the gap to the next hit (beats), its index. */
function per(out: { at: number; gap: number; idx: number }, beat: number, step: number, off = 0) { const k = Math.floor((beat - off) / step); out.at = k * step + off; out.gap = step; out.idx = k; }
export function hitAt(t: Target, beat: number, out: { at: number; gap: number; idx: number; side: number }): { at: number; gap: number; idx: number; side: number } {
  out.side = 0;
  switch (t) {
    case 'four': per(out, beat, 1); break;
    case 'offbeat': per(out, beat, 1, 0.5); break;
    case 'snare': per(out, beat, 2, 1); break;
    case 'hat': per(out, beat, 0.5, 0.25); break;
    case 'eighths': per(out, beat, 0.5); break;
    case 'sixteenths': per(out, beat, 0.25); break;
    case 'triplets': per(out, beat, 1 / 3); break;
    case 'gallop': { // the reverse-bass pattern: 16ths 2, 3, 4 of every beat (the "da-da-dum" before the kick); sequential index
      const b = Math.floor(beat), u = beat - b;
      if (u < 0.25) { out.at = b - 0.25; out.gap = 0.5; out.idx = (b - 1) * 3 + 2; } else { const j = Math.min(2, Math.floor(u * 4) - 1); out.at = b + 0.25 * (j + 1); out.gap = j === 2 ? 0.5 : 0.25; out.idx = b * 3 + j; }
      break; }
    case 'dotted': { // dotted 8ths, re-starting every bar: 0, 0.75, 1.5, 2.25, 3, 3.75
      const b0 = Math.floor(beat / 4) * 4, u = beat - b0, k = Math.min(5, Math.floor(u / 0.75));
      out.at = b0 + k * 0.75; out.gap = k === 5 ? 0.25 : 0.75; out.idx = Math.floor(beat / 4) * 6 + k; break; }
    case 'call': { // a call on the left (beats 0, 0.5, 1), the right answers (2, 2.5, 3); the next bar swaps
      const b0 = Math.floor(beat / 4) * 4, u = beat - b0;
      const pts = [0, 0.5, 1, 2, 2.5, 3];
      let k = 0; for (let j = 0; j < pts.length; j++) if (u >= pts[j]) k = j;
      out.at = b0 + pts[k]; out.gap = k === 2 ? 1 : k === 5 ? 1 : 0.5; out.idx = Math.floor(beat / 4) * 6 + k;
      const swap = Math.floor(beat / 4) % 2 ? -1 : 1;
      out.side = (k < 3 ? -1 : 1) * swap; break; }
    case 'shuffle': { const b = Math.floor(beat), u = beat - b; if (u < 2 / 3) { out.at = b; out.gap = 2 / 3; out.idx = b * 2; } else { out.at = b + 2 / 3; out.gap = 1 / 3; out.idx = b * 2 + 1; } break; }
    case 'split': per(out, beat, 1); out.side = out.idx % 2 ? 1 : -1; break;
    case 'phrase': per(out, beat, 8); break;
    case 'bar': per(out, beat, 4); break;
    case 'halfbar': per(out, beat, 2); break;
    case 'hold': out.at = Math.floor(beat); out.gap = 1; out.idx = 0; break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- motions
/** How a light moves between hits: hit (sharp decay), swell (rises INTO the next hit), saw (instant on, linear fall),
 *  wipe (the hit travels across the fixtures), drift (a slow sine, the hits only nudge it), pulse (a soft cosine bump),
 *  sparkle (each hit lights a random few). */
export type Motion = 'hit' | 'swell' | 'saw' | 'wipe' | 'drift' | 'pulse' | 'sparkle' | 'pump' | 'gate';
export const MOTIONS_PACK: { id: Motion; name: string; word: string; hard: boolean }[] = [
  { id: 'hit', name: 'Hit', word: 'Hit', hard: true }, { id: 'swell', name: 'Swell', word: 'Swell', hard: false }, { id: 'saw', name: 'Saw', word: 'Saw', hard: true },
  { id: 'wipe', name: 'Wipe', word: 'Wipe', hard: false }, { id: 'drift', name: 'Drift', word: 'Drift', hard: false }, { id: 'pulse', name: 'Pulse', word: 'Pulse', hard: false },
  { id: 'sparkle', name: 'Sparkle', word: 'Sparkle', hard: false }, { id: 'pump', name: 'Pump (sidechain duck)', word: 'Pump', hard: false },
  { id: 'gate', name: 'Gate', word: 'Gate', hard: true },
];

export interface TLevel { v: number; flash: boolean; key: string }
/** hat targets (no hat slots in the groove: soft figures) and the grid figures (they move on the grid; their brightness
 *  follows the drums) */
const HAT_T = new Set<Target>(['offbeat', 'hat', 'sixteenths', 'shuffle']);
const FIG_T = new Set<Target>(['eighths', 'triplets', 'dotted', 'call']);
const HF = { at: 0, gap: 1, idx: 0, side: 0 };
const GKEY = Object.fromEntries(TARGETS.map((d) => [d.id, `${d.id}g`])) as Record<Target, string>;
/** the grid a target's figure travels on (a free rhythm: kick / snare / bar targets travel on their own grid; split / call
 *  on the beat, gallop on the 16ths) */
const FIGURE_OF: Record<Target, Target> = { four: 'four', offbeat: 'offbeat', snare: 'snare', hat: 'hat', eighths: 'eighths', sixteenths: 'sixteenths', triplets: 'triplets', dotted: 'dotted', call: 'four', phrase: 'phrase', bar: 'bar', halfbar: 'halfbar', gallop: 'sixteenths', shuffle: 'shuffle', split: 'four', hold: 'four' };
/** A grid figure as MOTION: the target's grid hits travel across the rig (slice k of the order takes every k-th hit,
 *  cross-fading into the next slice), so each fixture steps on the grid while the rig's total stays steady - never a
 *  unison hit. 0..1. */
const FV = { v: 0.5 }, EV = { v: 0.5 };
const has = (q: DrumPhase) => q.age >= 0;   // (results land in scratch: no number boxed per fixture)
function figure(t: Target, beat: number, o: number, seed: number): void {
  hitAt(t, beat, HF);
  const k = t === 'triplets' ? 3 : 4;
  const oo = o > 1e-6 ? o : fract(seed * 7.31);           // (a unison spread: a stable scatter instead)
  const slot = Math.min(k - 1, Math.floor(oo * k)), cur = ((HF.idx % k) + k) % k, nxt = (cur + 1) % k;
  const u = HF.gap > 0 ? Math.min(1, Math.max(0, (beat - HF.at) / HF.gap)) : 0, e = u * u * (3 - 2 * u);
  FV.v = slot === cur ? 1 - e : slot === nxt ? e : 0;
}
const dec = (x: number, s: number) => Math.exp(-Math.max(0, x) * s);
const sm = (a: number, b: number, x: number) => { const q = Math.min(1, Math.max(0, (x - a) / (b - a))); return q * q * (3 - 2 * q); };
/** one gate key string per (prefix, drum id): built when the drum changes, not per fixture per frame */
const KEYS = new Map<string, { id: number; key: string }>();
function keyOf(prefix: string, id: number): string {
  let k = KEYS.get(prefix);
  if (!k) KEYS.set(prefix, (k = { id: NaN, key: '' }));
  if (k.id !== id) { k.id = id; k.key = prefix + id; }
  return k.key;
}
export { keyOf as drumKey };
/** A motion envelope 0..1 between two drums (`P`: the last drum's age / the gap to the next, beats). Every SHARP change
 *  is on a drum (that is what reads as a hit): a pulse jumps up on the drum and fades over the gap, a pump ducks on the
 *  drum and comes back slowly, a swell grows into the next drum and cuts on it. */
function drumEnv(P: DrumPhase, m: Motion, beat: number, o: number, seed: number, safe: boolean): void {
  if (!(P.age >= 0)) { EV.v = 0.15; return; }
  const u = Math.min(1, P.age / P.gap);
  let v: number;
  switch (m) {
    case 'swell': v = 0.1 + 0.9 * Math.pow(u, 2.2); break;
    case 'pulse': v = 0.25 + 0.75 * (0.5 + 0.5 * Math.cos(Math.PI * u)); break;
    case 'drift': v = 0.55 + 0.3 * Math.sin(2 * Math.PI * (beat / 8 - o * 0.5)) + 0.15 * Math.exp(-u * 3); break;
    case 'wipe': {   // (the head travels from the drum across the rig; normalised so the rig's total only moves with the drum)
      const head = Math.min(1, u * 1.25), k = safe ? 4 : 7, i0 = (1 - Math.exp(-k)) / k, ih = (2 - Math.exp(-k * head) - Math.exp(-k * (1 - head))) / k;
      v = 0.06 + 0.94 * Math.exp(-Math.abs(o - head) * k) * (i0 / ih) * (0.55 + 0.45 * Math.exp(-u * 3)); break; }
    case 'saw': v = 0.06 + 0.94 * Math.max(0, 1 - u); break;
    case 'pump': { const q = Math.min(1, Math.max(0, (u - 0.12) / 0.78)); v = 0.15 + 0.85 * q * q * (3 - 2 * q); break; }
    case 'sparkle': v = hash3(P.id, Math.round(seed * 1e4), 5) < (safe ? 0.22 : 0.35) ? 0.2 + 0.8 * Math.exp(-u * 4) : 0.08; break;
    default: v = 0.08 + 0.92 * Math.exp(-u * (safe ? 3.2 : 6));   // hit / gate
  }
  EV.v = v;
}
const H = { at: 0, gap: 1, idx: 0, side: 0 };
/** the fastest a unison hit may come with the flash limit on (hits a second) */
export const SAFE_UNISON_HZ = 2.2;

/**
 * A fixture's level 0..1 for a target + motion at `beat`. `o` = the fixture's order 0..1 along the program's spread,
 * `side` = −1 / 1 (left / right half: call and response), `seed` = per-fixture, `onsetEnv` = the detected envelope of
 * the target's onset class (NaN = none: grid only). `safe` = the flash limit is on.
 */
export function targetLevel(t: Target, m: Motion, beat: number, bpm: number, o: number, side: number, seed: number, safe: boolean, onsetEnv: number, out: TLevel, drums?: Drums | null, soft?: 'hats' | 'all' | null): TLevel {
  out.flash = false; out.key = '';
  if (t === 'hold') { out.v = m === 'drift' ? 0.75 + 0.25 * Math.sin(2 * Math.PI * (beat / 16 + o)) : 1; return out; }
  // THE DRUMS OWN THE INTENSITY (rhythm lane, shared/groove.ts): with a learned groove every hit lands on a real drum,
  // pre-cued on the grid, the plan flash-limited to the safe unison rate -
  //   kick targets (four, bar, half bars, gallop, split) the track's kicks ('four' / 'split': every drum, the kick leads),
  //   'snare' its snares (a half-time snare on 3), the grid figures (8ths, triplets, dotted, call) keep MOVING on the grid
  //   while their brightness follows the drums, and hats - the groove has no hat slots - play a soft figure, never a
  //   unison hit. 'phrase' stays on the phrase. Without a groove (an older studio) everything plays as authored.
  if (drums && drums.n > 0 && t !== 'phrase') {
    if (HAT_T.has(t)) { figure(t, beat, o, seed); out.v = 0.3 + 0.55 * FV.v; return out; }
    if (FIG_T.has(t)) {
      const P = drums.any; drumEnv(P, m, beat, o, seed, safe); const env = EV.v;
      if (t === 'call') {
        hitAt('call', beat, H);
        if (H.side && side && H.side !== side) { out.v = m === 'drift' ? 0.5 : 0.12; return out; }
        out.v = env;
        if (m === 'hit' || m === 'saw' || m === 'sparkle' || m === 'gate') { out.flash = true; out.key = keyOf('callg', P.id); }
        return out;
      }
      figure(t, beat, o, seed); out.v = (0.3 + 0.7 * FV.v) * (0.45 + 0.55 * env);
      return out;
    }
    const D = drums;
    const P = t === 'snare' ? (has(D.snare) ? D.snare : D.any)
      : t === 'halfbar' || t === 'gallop' ? (has(D.kick) ? D.kick : D.any)
      : t === 'bar' ? (has(D.down) ? D.down : has(D.kick) ? D.kick : D.any) : D.any;
    if (has(P)) {
      // (split: left / right answer each other drum by drum)
      if (t === 'split' && side && (P.seq % 2 ? 1 : -1) !== side) { out.v = m === 'drift' ? 0.5 : 0.12; return out; }
      drumEnv(P, m, beat, o, seed, safe); let v = EV.v;
      if (P.kind === 'snare' && t !== 'snare') v = 0.08 + (v - 0.08) * 0.85;   // (the kick leads, the snare answers)
      out.v = Math.max(0, Math.min(1, v * (0.6 + 0.4 * P.w)));
      if (m === 'hit' || m === 'saw' || m === 'sparkle' || m === 'gate') { out.flash = true; out.key = keyOf(GKEY[t], P.id); }
      return out;
    }
  }
  // hats the music isn't known to play (no groove slots for hats; a four-on-the-floor): a soft figure across the rig,
  // never a unison flash. No clear pattern (a free rhythm): every grid target is a soft figure - the lights don't pretend
  // a grid the music doesn't play (as the director's free mode)
  if ((soft === 'hats' && HAT_T.has(t)) || (soft === 'all' && t !== 'phrase')) { figure(FIGURE_OF[t], beat, o, seed); out.v = 0.3 + 0.55 * FV.v; return out; }
  // a fast unison target with the limit on: each fixture takes every k-th hit (the hit travels; the group stays steady)
  const def = targetById(t)!;
  const hz = def.perBeat * bpm / 60;
  let k = 1;
  if (safe && hz > SAFE_UNISON_HZ && m !== 'drift') k = Math.min(8, Math.ceil(hz / SAFE_UNISON_HZ));
  hitAt(t, beat, H);
  if (H.side && side && H.side !== side) {                                    // call and response: not this side's hit
    out.v = m === 'drift' ? 0.5 : 0.12; return out;
  }
  let u = H.gap > 0 ? (beat - H.at) / H.gap : 0;                             // 0..1 since the hit
  let mine = true;
  if (k > 1) {
    // (spatial: the hit index picks a slice of the rig; with < k fixtures some hits light nobody - that is the point)
    const slot = Math.min(k - 1, Math.floor(o * k));
    mine = ((H.idx % k) + k) % k === slot;
    if (!mine) { // between this fixture's own hits: the tail of its last one (k hits ago)
      const back = ((H.idx - slot) % k + k) % k;
      u = (u + back) / k;
    } else u = u / k;
  }
  let v = 1;
  switch (m) {
    case 'hit': v = 0.08 + 0.92 * dec(u, safe ? 3.2 : 6); break;
    case 'saw': v = 0.06 + 0.94 * Math.max(0, 1 - u); break;
    case 'swell': v = 0.1 + 0.9 * Math.pow(Math.min(1, u), 2.2) * (u < 0.98 ? 1 : 0.6); break;
    case 'pulse': v = 0.25 + 0.75 * (0.5 + 0.5 * Math.cos(2 * Math.PI * Math.min(1, u))); break;
    case 'wipe': { const head = Math.min(1, u * 1.25), d = Math.abs(o - head); v = 0.06 + 0.94 * dec(d, safe ? 4 : 7); break; }
    case 'drift': v = 0.55 + 0.3 * Math.sin(2 * Math.PI * (beat / 8 - o * 0.5)) + 0.15 * dec(u, 3); break;
    case 'pump': v = 0.15 + 0.85 * (soft ? sm(0.12, 0.9, u) : sm(0.18, 0.5, u)); break;   // (a known rhythm: the duck is the hit, the recovery slow)
    case 'gate': v = 0.08 + 0.92 * (1 - sm(0.36, safe ? 0.62 : 0.48, u)); break;
    case 'sparkle': { const p = safe ? 0.22 : 0.35; v = hash3(H.idx, Math.round(seed * 1e4), 5) < p ? 0.2 + 0.8 * dec(u, 4) : 0.08; break; }
  }
  // detected onsets: a hit that the music doesn't play (a dropped kick, a fill) is lighter - never a hit without the
  // grid, so latency never moves the light
  if (Number.isFinite(onsetEnv) && def.onset && m !== 'drift') v = 0.15 + (v - 0.15) * (0.55 + 0.45 * Math.min(1, onsetEnv * 1.6 + (u > 0.2 ? 1 : 0)));
  out.v = Math.max(0, Math.min(1, v));
  // a hard, full-depth hit faster than the limit in unison is a flash the gate must see
  if ((m === 'hit' || m === 'saw' || m === 'sparkle' || m === 'gate') && hz / k > 2.2) { out.flash = true; out.key = `${t}${H.idx}`; }
  return out;
}

/** Shader time for patterns that move in seconds (LED walls, the pixel ceiling): the wall clock (epoch ms - the same on
 *  every page: studio, OBS, party guests) from an anchor on a shared grid, so they play in phase everywhere and stay
 *  small enough for a 32-bit float (raw epoch seconds step 128 s at a time on the GPU). The anchor moves every
 *  SHARED_EPOCH_S seconds (~11 h), on every page at the same moment. */
export const SHARED_EPOCH_S = 40_000;
export const sharedBase = (ms: number) => Math.floor(ms / 1000 / SHARED_EPOCH_S) * SHARED_EPOCH_S;
export const sharedSec = (ms: number) => ms / 1000 - sharedBase(ms);
