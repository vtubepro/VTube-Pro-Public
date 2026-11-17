// Show pack → the room light director's form (shared/lightDirector.ts looks: layers of waveform effects per fixture
// kind / role). Every room's LIGHT_* fixtures (the club's floor tiles, rails, truss beams, accents) then play the
// program: moving heads / spots / beams pan + tilt in the formation's character and pulse on its rhythm target,
// strobes / blinders take its white pattern (flash-gated), pixel bars + LED strips chase, accents follow the colours,
// deco twinkles, signs stay calm. Types only from the director: no runtime import (the festival bridge uses this too).
import type { DirectorLook, Effect, LookLayer } from '../lightDirector.ts';
import { beamFormById, laserFormById, type BeamForm, type LaserForm } from './forms.ts';
import { targetById, type Motion, type Target } from './rhythm.ts';
import type { ColourMode, Program, Shape, StrobePat } from './program.ts';

type Wave = Effect['wave'];
const e = (attr: Effect['attr'], wave: Wave, rate: number, depth: number, o: Partial<Effect> = {}): Effect => ({ attr, wave, rate, depth, ...o });
const clampRate = (r: number) => Math.min(16, Math.max(1 / 64, r));

/** a rhythm target + motion → dim effects (the target's grid via rate + phase, the motion's envelope via the waveform).
 *  ONE rhythm effect per layer (+ at most one slow shape below): with the flash limit on the director plays any
 *  non-sine hit faster than 2.2 a second at half time, so a layer never turns more than ~3 times a second. Sines (which
 *  it never slows) only run at a bar or slower. */
export function targetEffects(t: Target, m0: Motion, depth: number, safe: boolean): Effect[] {
  let m: Motion | 'hold' = m0;
  if (t === 'hold') return m0 === 'drift' ? [e('dim', 'sine', 1 / 16, depth * 0.4, { spread: 1, by: 'x' })] : [];
  const [rate0, phase] = ({ four: [1, 0], offbeat: [1, 0.5], snare: [0.5, 0.5], hat: [2, 0.5], eighths: [2, 0], sixteenths: [4, 0], triplets: [3, 0], dotted: [4 / 3, 0], call: [0.5, 0], phrase: [1 / 8, 0], bar: [0.25, 0], halfbar: [0.5, 0], gallop: [4, 0.25], shuffle: [1, 0], split: [0.5, 0] } as Record<string, [number, number]>)[t] ?? [1, 0];
  // the safe variant: hits on the room's governor grid (half beats) - 8ths / 16ths at half time, triplets on the beat,
  // dotted 8ths every 1.5 beats, gallops on the beat - and in UNISON (a hit offset across the rig turns between the
  // governor's windows, where every page would hold it a little differently); the travel comes from the slow shapes
  const rate = !safe ? rate0 : t === 'triplets' || t === 'gallop' ? 1 : t === 'dotted' ? 2 / 3 : rate0 >= 2 ? rate0 / 2 : rate0;
  const ph = safe ? (phase === 0.5 ? 0.5 : 0) : phase;
  const fast = rate0 >= 2;
  const onset = targetById(t)?.onset;
  const o: Partial<Effect> = { phase: ph, ...(onset === 'kick' ? { kick: true } : onset ? { onset } : {}) };
  // fast unison hits travel across the rig instead (the limit off)
  if (fast && !safe) Object.assign(o, { spread: 1, by: 'x' as const });
  const hard = m === 'hit' || m === 'saw' || m === 'gate' || m === 'sparkle';
  if (hard && fast && !safe) o.flash = true;
  const sp: Partial<Effect> = safe ? {} : { spread: 1, by: 'x' };
  const out: Effect[] = [];
  const slow = clampRate(Math.min(rate, 1 / 4));
  // (safe: a hit is a triangle whose PEAK sits on the grid - a sharp attack would land on a different frame on each page
  // and the governor would hold each page's peak at a different height)
  if (safe && (m === 'hit' || m === 'saw' || m === 'wipe' || m === 'swell' || m === 'gate')) { out.push(e('dim', 'tri', rate, depth * 0.85, { ...o, phase: ph === 0.5 ? 0 : 0.5 })); m = 'hold'; }
  else if (safe && m === 'pump') { out.push(e('dim', 'tri', rate, depth * 0.7, o)); m = 'hold'; }            // (low on the beat, up on the offbeat)
  else if (safe && m === 'sparkle') { out.push(e('dim', 'tri', rate, depth * 0.7, { ...o, spread: 3, by: 'random' })); m = 'hold'; }   // (a smooth twinkle; tri: the director slows it like any hit)
  switch (m) {
    case 'hit': out.push(e('dim', 'pulse', rate, depth, { ...o, width: 0.25 })); break;
    case 'saw': out.push(e('dim', 'saw', rate, depth * 0.9, o)); break;
    case 'swell': out.push(e('dim', 'ramp', rate, depth * 0.8, o)); break;
    case 'pulse': out.push(rate <= 1 / 4 ? e('dim', 'sine', rate, depth * 0.8, o) : e('dim', 'tri', rate, depth * 0.8, o)); break;
    case 'wipe': out.push(e('dim', 'pulse', rate, depth, { ...o, ...sp, width: 0.4 })); break;
    case 'drift': out.push(e('dim', 'sine', clampRate(Math.min(slow, rate / 4)), depth * 0.5, { ...o, spread: 1, by: 'x' })); break;
    case 'sparkle': out.push(e('dim', 'random', rate, depth * 0.8, { ...o, by: 'random' })); break;
    case 'pump': out.push(e('dim', 'ramp', rate, depth * 0.7, o)); break;   // (ducked right after the beat, back up before the next)
    case 'gate': out.push(e('dim', 'square', rate, depth, { ...o, width: safe ? 0.6 : 0.45 })); break;
  }
  // (the limit off: the swung 8th of a shuffle; split / call answer side to side)
  if (!safe && t === 'shuffle') out.push(e('dim', 'pulse', 1, depth * 0.5, { phase: 1 / 3, width: 0.3, onset: 'hat' }));
  if (t === 'split' || t === 'call') out.push(safe ? e('dim', 'sine', 1 / 8, depth * 0.5, { spread: 0.5, by: 'x' }) : e('dim', 'square', 0.25, depth * 0.5, { spread: 0.5, by: 'x', width: 0.5 }));
  return out;
}
/** a spatial shape → one extra dim effect, a bar or slower and CONTINUOUS (sines / triangles / ramps: on top of the
 *  rhythm effect they shape the peaks across the rig without adding turns of their own) */
function shapeEffects(s: Shape, depth: number, aligned: boolean): Effect[] {
  switch (s) {
    case 'breath': case 'veil': return [e('dim', 'sine', s === 'veil' ? 1 / 16 : 1 / 8, depth * 0.5, { spread: 1, by: 'x' })];
    case 'glints': case 'tides': return [e('dim', 'sine', s === 'glints' ? 1 / 4 : 1 / 8, depth * 0.45, { spread: 3, by: 'random' })];
    case 'ascent': case 'lift': return [e('dim', 'tri', s === 'ascent' ? 1 / 8 : 1 / 4, depth * 0.6, { spread: 2, by: 'x' })];
    case 'chase': case 'pursuit': case 'loop': case 'pingpong': return [e('dim', 'tri', 1 / 4, depth * 0.7, { spread: s === 'pursuit' ? -1 : 1, by: 'x' })];
    case 'impact': case 'detonation': case 'kickpump': return aligned ? [e('dim', 'pulse', 1, depth * 0.4, { width: 0.3, ...(s === 'kickpump' ? { kick: true } : {}) })] : [];
    case 'counterfire': case 'exchange': return [e('dim', 'sine', 1 / 4, depth * 0.5, { spread: 0.5, by: 'index' })];
    case 'snarebloom': return [e('dim', 'tri', 1 / 4, depth * 0.6, { spread: 1, by: 'x', onset: 'snare' })];
    case 'halves': return [e('dim', 'sine', 1 / 4, depth * 0.6, { spread: 0.5, by: 'x' })];
    case 'steps': case 'banks': return [e('dim', 'tri', 1 / 4, depth * 0.6, { spread: 1, by: 'x' })];
    case 'centre': case 'ripple': return [e('dim', 'sine', s === 'centre' ? 1 / 4 : 1 / 8, depth * 0.5, { spread: 1, by: 'r' })];
    case 'scatter': return [e('dim', 'sine', 1 / 4, depth * 0.5, { spread: 3, by: 'random' })];
    case 'fill': return [e('dim', 'ramp', 1 / 4, depth * 0.6, { spread: -1, by: 'x' })];
    case 'glow': return [e('dim', 'sine', 1 / 8, depth * 0.35, { spread: 2, by: 'random' })];
    case 'tide': return [e('dim', 'sine', 1 / 16, depth * 0.5, { spread: 1, by: 'x' })];
    case 'swellramp': return [e('dim', 'ramp', 1 / 32, depth * 0.5)];
    default: return [];
  }
}
/** a beam formation → pan / tilt / zoom effects in its character */
export function formEffects(f: BeamForm, tempo: number, amp: number): Effect[] {
  const def = beamFormById(f);
  const r = clampRate(tempo / Math.max(0.5, def?.rate ?? 8));
  switch (f) {
    case 'fan': case 'wings': case 'barfan': case 'mirror': case 'vee': case 'chevron': case 'nod': return [e('pan', 'sine', r, 0.8 * amp, { spread: 1, by: 'x', wings: true }), ...(f === 'nod' ? [e('tilt', 'pulse', 1, 0.4 * amp, { width: 0.4 })] : [])];
    case 'comb': case 'sway': case 'crosswind': case 'wave': case 'eight': return [e('pan', 'sine', r, 0.8 * amp, f === 'comb' || f === 'sway' ? {} : { spread: 0.5, by: 'x' }), ...(f === 'eight' ? [e('tilt', 'sine', clampRate(2 * r), 0.4 * amp)] : [])];
    case 'tunnel': case 'orbit': case 'iris': case 'halo': case 'helix': case 'spiral': case 'vortex': case 'funnel': case 'flower': case 'orbitals': case 'corkscrew': case 'diamond': case 'ceiling': case 'crown':
      return [e('pan', 'sine', r, 0.6 * amp, { spread: f === 'helix' || f === 'corkscrew' ? 1 : 0.25, by: 'index' }), e('tilt', 'sine', r, 0.5 * amp, { spread: 0.25, by: 'index', phase: 0.25 })];
    case 'pendulum': case 'sail': case 'bankwave': case 'rain': case 'skytilt': case 'lift': case 'rise': case 'steps': case 'terraces': case 'zigzag': case 'liquid':
      return [e('tilt', f === 'lift' || f === 'rise' ? 'ramp' : 'sine', r, 0.7 * amp, { spread: f === 'zigzag' ? 0.5 : 1, by: f === 'zigzag' || f === 'steps' ? 'index' : 'x' })];
    case 'ballyhoo': case 'grid': case 'snap': case 'box': return [e('pan', 'random', clampRate(r), 0.8 * amp, { by: 'index' }), e('tilt', 'random', clampRate(r), 0.5 * amp, { by: 'random' })];
    case 'cross': case 'counter': case 'scissor': case 'pinch': return [e('pan', 'tri', r, 0.8 * amp, { spread: 0.5, by: 'index' })];
    case 'starburst': return [e('pan', 'sine', r, 0.5 * amp, { spread: 1, by: 'x', wings: true }), e('zoom', 'pulse', 1, 0.5, { width: 0.3 })];
    default: return [e('tilt', 'sine', clampRate(r / 2), 0.25 * amp, { spread: 0.5, by: 'x', wings: true })];   // still: cathedral, pillars, drift, bath, searchlight, converge
  }
}
function laserEffects(l: LaserForm, tempo: number): Effect[] {
  const calm = !!laserFormById(l)?.calm, r = clampRate(tempo / (calm ? 16 : 4));
  switch (l) {
    case 'scan': case 'comb': case 'burst': return [e('pan', l === 'burst' ? 'random' : 'sine', clampRate(r * 2), 0.9, { by: 'index' })];
    case 'tunnel': case 'cone': case 'vortex': case 'iris': case 'crown': case 'dome': case 'diamond': case 'star': return [e('pan', 'sine', r, 0.5, { spread: 0.25, by: 'index' }), e('tilt', 'sine', r, 0.4, { spread: 0.25, by: 'index', phase: 0.25 })];
    case 'cross': case 'scissor': case 'split': return [e('pan', 'tri', r, 0.8, { spread: 0.5, by: 'index' })];
    default: return [e('pan', 'sine', r, 0.6, { spread: 1, by: 'x', wings: true }), e('tilt', 'sine', clampRate(r / 2), 0.3)];
  }
}
function strobeEffects(s: StrobePat, safe: boolean): Effect[] {
  if (safe) return s === 'none' ? [] : [e('white', 'pulse', 0.25, 0.35, { width: 0.4, flash: true })];   // one soft lift a bar
  switch (s) {
    case 'beat': case 'kick': return [e('white', 'pulse', 1, 0.9, { width: 0.2, flash: true, ...(s === 'kick' ? { kick: true } : {}) })];
    case 'offbeat': return [e('white', 'pulse', 1, 0.9, { width: 0.2, flash: true, phase: 0.5 })];
    case 'snare': return [e('white', 'pulse', 0.5, 0.9, { width: 0.2, flash: true, phase: 0.5, onset: 'snare' })];
    case 'bar': return [e('white', 'pulse', 0.25, 0.8, { width: 0.25, flash: true })];
    case 'storm': return [e('white', 'random', 2, 0.9, { flash: true, by: 'random' })];
    case 'lightning': return [e('white', 'random', 0.5, 1, { flash: true, by: 'random' })];
    case 'roll': return [e('white', 'pulse', 2, 0.7, { width: 0.2, flash: true })];
    default: return [];
  }
}
/** targets whose hits land on the beat (a beat-rate shape pulse coincides with them instead of adding turns) */
const ALIGNED = new Set<Target>(['four', 'bar', 'halfbar', 'phrase']);
/** targets that run at a beat or faster (in the safe variant they carry the layer alone, bar a slow breath) */
const BEATY = new Set<Target>(['four', 'offbeat', 'hat', 'eighths', 'sixteenths', 'triplets', 'dotted', 'gallop', 'shuffle']);
const SLOW_SHAPES = new Set<Shape>(['breath', 'veil', 'tide', 'swellramp', 'glow']);
const shapeOk = (s: Shape, t: Target, safe: boolean) => !safe || !BEATY.has(t) || SLOW_SHAPES.has(s);
const COLOUR: Record<ColourMode, LookLayer['colour']> = { spread: 'sweep', split: 'split', alt: 'alt', mono: 'base', sweep: 'sweep', exchange: 'split', rainbow: 'sweep', white: 'accent' };

/** a program → the director's look; `safe` = its Safe-flashes variant (no strobe hits, fast hits at half time and
 *  travelling, the rhythm carries a layer alone) - every program has one ('pack:<id>s') */
export function compileProgram(p: Program, id: string, safe = false): DirectorLook {
  const peak = p.cls === 'peak', chill = p.cls === 'chill';
  const lv: [number, number] = chill ? [0.25, 0.7] : peak ? [0.45, 1.15] : [0.35, 0.95];
  // (the safe variant never swaps colours on the beat: 'alt' trades them every beat, a step on top of the rhythm)
  const colour = safe && COLOUR[p.colour] === 'alt' ? 'split' : COLOUR[p.colour];
  // colours trading sides every 4 bars: a soft sine in the safe variant (a colour step on top of a beat pulse is one turn too many)
  const exch: Effect[] = p.colour === 'exchange' || (safe && p.flashy) ? [safe ? e('mix', 'sine', 1 / 16, 1, { spread: 0.5, by: 'x' }) : e('mix', 'square', 1 / 8, 1, { spread: 0.5, by: 'x', width: 0.5 })] : [];
  const amp = p.beam.amp * (safe && p.flashy ? 1.2 : 1);
  const movers: LookLayer = { kinds: ['beam', 'spot', 'wash'], level: lv, colour, effects: [...targetEffects(p.level.target, p.level.motion, 0.85, safe), ...(shapeOk(p.level.shape, p.level.target, safe) ? shapeEffects(p.level.shape, 0.6, ALIGNED.has(p.level.target) && p.level.motion !== 'wipe') : []), ...formEffects(p.beam.form, p.tempo, amp), ...exch].slice(0, 8), ...(peak ? { dropHit: 1 } : {}) };
  const strobes: LookLayer = { kinds: ['strobe', 'blinder'], level: chill ? [0.1, 0.3] : [0.2, 0.6], colour: 'accent', effects: [...strobeEffects(p.strobe, safe), e('dim', 'sine', 1 / 8, 0.2)], ...(peak ? { dropHit: 1 } : {}) };
  const lasers: LookLayer = { kinds: ['laser'], level: p.laser ? lv : [0, 0], colour: colour === 'accent' ? 'base' : colour, effects: p.laser ? [...targetEffects(p.laser.target, p.laser.motion, 0.7, safe), ...laserEffects(p.laser.form, p.laser.rate * p.tempo)].slice(0, 8) : [] };
  const pixels: LookLayer = { kinds: ['pixelbar', 'ledwall'], level: lv, colour, effects: [...targetEffects(p.wash.target, p.wash.motion, 0.7, safe), ...(shapeOk(p.wash.shape, p.wash.target, safe) ? shapeEffects(p.wash.shape, 0.7, ALIGNED.has(p.wash.target) && p.wash.motion !== 'wipe') : []), ...exch].slice(0, 8) };
  const show: LookLayer = { roles: ['show'], level: lv, colour, effects: [...targetEffects(p.wash.target, p.wash.motion, 0.8, safe), ...(shapeOk(p.wash.shape, p.wash.target, safe) ? shapeEffects(p.wash.shape, 0.5, ALIGNED.has(p.wash.target) && p.wash.motion !== 'wipe') : []), ...formEffects(p.beam.form, p.tempo, amp * 0.8), ...exch].slice(0, 8), ...(peak ? { dropHit: 0.9 } : {}) };
  const accent: LookLayer = { roles: ['accent'], level: chill ? [0.4, 0.8] : [0.5, 1.05], colour: colour === 'accent' ? 'sweep' : colour, tint: 0.85, effects: [...targetEffects(p.wash.target, p.wash.motion, 0.45, true), ...(shapeOk(p.wash.shape, p.wash.target, true) ? shapeEffects(p.wash.shape, 0.35, ALIGNED.has(p.wash.target) && p.wash.motion !== 'wipe') : [])].slice(0, 8), ...(peak ? { dropHit: 0.6 } : {}) };
  return { id, layers: [strobes, lasers, movers, pixels, show, accent,
    { roles: ['deco'], level: [0.7, 1.05], colour: 'authored', effects: [e('dim', 'random', chill ? 1 / 2 : 2, 0.3)] },
    { roles: ['sign'], level: [0.95, 1.1], colour: 'authored', effects: chill ? [] : [e('dim', 'pulse', 1 / 4, 0.15, { width: 0.4 })] }] };
}
