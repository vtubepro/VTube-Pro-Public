// Show pack: one PROGRAM = a complete look for every fixture class, as data. The generator (generate.ts) builds the
// catalogue from a grammar; the evaluators below turn a program + the musical moment into what each fixture does
// (moving heads, washes / PARs / pixels, strobes, lasers), the LED wall pattern and the special-effects cues. Pure maths:
// every page evaluates the same frame from the same beat grid.
import { fract, hash3 } from '../festival.ts';
import { beamAim, beamFormById, laserAim, laserFormById, rayAim, type Aim, type BeamForm, type LaserForm, type MoverKind, type PackGeo } from './forms.ts';
import { drumKey, targetById, targetLevel, type Motion, type PackSection, type Target, type TLevel } from './rhythm.ts';
import type { DrumPhase, Drums, Feel, GrooveHit, RhythmMode } from '../groove.ts';

export type Family = 'grammar' | 'score' | 'build' | 'drop' | 'groove' | 'slow' | 'signature';
export const FAMILIES: Family[] = ['grammar', 'score', 'build', 'drop', 'groove', 'slow', 'signature'];
export type EnergyCls = 'chill' | 'mid' | 'peak';
/** colour across the rig: the palette spread along the order / left vs right / odd vs even / one colour / flowing in
 *  time / sides swapping every bar / a hue walk / white with a colour accent */
export type ColourMode = 'spread' | 'split' | 'alt' | 'mono' | 'sweep' | 'exchange' | 'rainbow' | 'white';
export type SpreadMode = 'unison' | 'leftright' | 'wings' | 'centerout' | 'bottomtop' | 'random' | 'blocks2' | 'blocks4' | 'oddeven' | 'radial';
/** a spatial / temporal weight on top of the rhythm (the verbs, chases, rolls and breaths of the grammar) */
export const SHAPES = ['none', 'breath', 'glints', 'ascent', 'chase', 'impact', 'counterfire', 'veil', 'tides', 'lift', 'pursuit', 'detonation', 'exchange', 'snarebloom',
  'loop', 'halves', 'steps', 'centre', 'pingpong', 'scatter', 'banks', 'fill', 'glow', 'ripple', 'tide', 'swellramp', 'bounce', 'double', 'dark', 'kickpump'] as const;
export type Shape = (typeof SHAPES)[number];
/** strobe / white-hit pattern (every one passes the flash gate; Safe flashes ON swaps them for motion + colour) */
export type StrobePat = 'none' | 'snare' | 'beat' | 'offbeat' | 'bar' | 'storm' | 'lightning' | 'roll' | 'kick';
export type BlinderPat = 'off' | 'drop' | 'bar4' | 'downbeat' | 'call';
/** special effects the program cues (festival stages; budgeted + governed by the rig): flames on the kicks, flames
 *  answering left / right, flames on the bar, a flame chase, a centre column, CO2 in the build, a gerb line, a flame wave */
export type SfxPat = 'none' | 'kick' | 'call' | 'bar' | 'chase' | 'centre' | 'co2build' | 'gerbs' | 'wave';

export interface Program {
  /** stable id (7 chars, hash of the atoms) */
  id: string;
  name: string;
  family: Family;
  /** the atoms in words (the Look Lab / contact sheets) */
  sub: string;
  cls: EnergyCls; energy: number;
  sections: PackSection[];
  /** genre fit (festival genre ids) */
  genres: string[];
  /** its own palette (festival palette id); programs play the SHOW's palettes unless `fixed` */
  palette: string; fixed?: boolean;
  beam: { form: BeamForm; rate: number; amp: number };
  /** movers' level */
  level: { target: Target; motion: Motion; shape: Shape; spread: SpreadMode };
  /** washes, PARs, pixel bars, the room's accent lights */
  wash: { target: Target; motion: Motion; shape: Shape };
  laser: { form: LaserForm; target: Target; motion: Motion; rate: number } | null;
  strobe: StrobePat; blinder: BlinderPat; sfx: SfxPat;
  /** LED wall visual (a festival WALL_VISUALS id or a pack wall, walls.ts) */
  wall: string;
  colour: ColourMode;
  /** motion tempo (0.5 half time / 1 / 2 double time) */
  tempo: number;
  /** build "hot": mirrored steps, stacked lasers, white bleach with the build */
  hot?: boolean;
  /** drop "wide": wider laser fans */
  wide?: boolean;
  /** has full-depth flash layers (strobes, unison fast hits): Safe flashes ON plays its safe variant */
  flashy: boolean;
  tags: string[];
  score: number;
}

// ---------------------------------------------------------------------------------------------------- the frame
/** The moment a program is evaluated at (built once per frame by the engine; see rhythm.ts RhythmFrame). */
export interface PackFrame {
  beat: number; bar: number; barPos: number; bpm: number;
  energy: number; kick: number; snare: number; hat: number; onsets: boolean;
  section: PackSection;
  /** build ramp 0..1, beams pulled to the centre 0..1, beats since the drop (Infinity = none), master level */
  build: number; converge: number; dropAge: number; level: number;
  /** palette step (changes every 8 bars + on drops) */
  step: number;
  /** the beat the movers MOVE on (a calmer clock with the flash limit on) */
  mb: number;
  /** Safe flashes ON */
  safe: boolean;
  /** mirror-symmetric about the rig's centre (x = 0): every fixture plays its mirror twin's state, pans / yaws mirrored
   *  (festival stages + the club rig). Deliberate left / right call-and-response targets (call, split) keep their sides. */
  sym?: boolean;
  /** palette colours, sRGB 0..1 */
  colors: [number, number, number][];
  /** the rhythm lane's groove (shared/groove.ts): with 'groove' the drums own the intensity (`drums`: where the music is
   *  between its kicks / snares, from the flash-limited `plan`) and the figures move on the grid; `feel` 'four' (or a free
   *  rhythm): hats soft. Absent = an older studio: as authored. */
  rhythm?: RhythmMode; plan?: GrooveHit[]; drums?: Drums; feel?: Feel;
}
/** the drum phases a frame's intensity follows (null = the grid as authored) */
export const drumsOf = (f: Pick<PackFrame, 'rhythm' | 'drums'>): Drums | null => (f.rhythm === 'groove' && f.drums && f.drums.n > 0 ? f.drums : null);
/** hats the music isn't known to play (a detected four-on-the-floor): soft hat figures, never a unison hat flash; a free
 *  rhythm (no clear pattern): every grid target a soft figure */
export const softHatsOf = (f: Pick<PackFrame, 'rhythm' | 'feel'>): 'hats' | 'all' | null => (f.rhythm === 'free' ? 'all' : f.rhythm === 'grid' && f.feel === 'four' ? 'hats' : null);
/** the last drum (any) when the drums own the intensity */
const anyDrum = (f: PackFrame): DrumPhase | null => { const d = drumsOf(f); return d && d.any.age >= 0 ? d.any : null; };

/** the geometry a mirror-symmetric rig evaluates a fixture with: its distance from the centre (x = |x|), an index /
 *  seed shared with its mirror twin */
export function symGeo(g: PackGeo, out: PackGeo): PackGeo {
  const ax = Math.abs(g.x), n = Math.max(1, Math.floor((g.n - 1) / 2) + 1);
  out.x = ax; out.y = g.y; out.z = g.z; out.n = n; out.i = Math.round(ax * (n - 1));
  out.seed = fract(ax * 7.31 + g.y * 3.7 + g.z * 1.3 + 0.123);
  return out;
}
const SG: PackGeo = { x: 0, y: 0, z: 0, i: 0, n: 1, seed: 0 };
/** Safe flashes ON: the fastest a beam formation cycles (per motion beat; the motion clock is ~0.75 beats a second) */
export const SAFE_BEAM_RATE = 0.5;
/** Safe flashes ON: the fastest a laser formation's own rays move (per motion beat) */
export const SAFE_LASER_RATE = 0.3;
const GX: PackGeo = { x: 0, y: 0, z: 0, i: 0, n: 1, seed: 0 };   // (scratch: a hot build's mirrored step, no per-frame object)
export function orderOf(spread: SpreadMode, g: PackGeo): number {
  switch (spread) {
    case 'unison': return 0;
    case 'leftright': return (g.x + 1) / 2;
    case 'wings': return Math.abs(g.x);
    case 'centerout': return Math.min(1, Math.hypot(g.x, (g.y - 0.5) * 2) / 1.42);
    case 'bottomtop': return g.y;
    case 'random': return fract(g.seed * 7.31);
    case 'blocks2': return Math.min(1, Math.floor((g.x + 1) / 2 * 2) / 2);
    case 'blocks4': return Math.min(1, Math.floor((g.x + 1) / 2 * 4) / 4);
    case 'oddeven': return (g.i % 2) * 0.5;
    case 'radial': return (Math.atan2(g.y - 0.4, g.x) / Math.PI + 1) / 2;
  }
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** A shape's weight 0..1 for a fixture at order `o` (0..1 across the rig). */
export function shapeWeight(s: Shape, f: PackFrame, o: number, g: PackGeo): number {
  const b = f.beat, x01 = (g.x + 1) / 2, ctr = Math.abs(g.x);
  switch (s) {
    case 'none': return 1;
    case 'breath': return 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(2 * Math.PI * (b / 8 - o)));
    case 'veil': return 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(2 * Math.PI * (b / 16 - o * 0.7)));
    case 'glints': case 'tides': { const ph = g.seed * 6.28 + g.i * 2.39996; const tw = Math.pow(0.5 + 0.5 * Math.sin(b * (s === 'glints' ? 1.3 : 0.6) + ph), 12); return 0.25 + 0.75 * tw; }
    case 'ascent': case 'lift': { const sp = s === 'ascent' ? 0.75 : 1.5; return 0.15 + 0.85 * Math.pow(Math.max(0, Math.cos(2 * Math.PI * (o * 2 - b * sp / 4))), 4); }
    case 'chase': case 'pursuit': { const st = f.safe ? Math.floor(b) : Math.floor(b * 2); const dir = s === 'pursuit' ? -1 : 1; return ((Math.floor(o * 5.999) * dir + st) % 6 + 6) % 6 < 2 ? 1 : 0.14; }
    // (the rig-wide beat shapes land on the drums when the drums own the intensity: impact / detonation / bounce / double /
    //  counterfire hit with the kick or snare, not on a grid beat the music doesn't play)
    case 'impact': { const P = anyDrum(f); return 0.3 + 0.7 * Math.exp(-Math.pow((P ? P.age : fract(b)) / (f.safe ? 0.3 : 0.14), 2)) * (0.7 + 0.3 * Math.cos(Math.PI * (o - 0.5))); }
    case 'detonation': { const P = anyDrum(f); const ring = Math.abs(ctr - (P ? Math.min(1, P.age / P.gap) : fract(b)) * 1.2); return 0.2 + 0.8 * Math.exp(-ring * ring * 30); }
    case 'counterfire': case 'exchange': { const P = anyDrum(f); const on = (g.i + (P ? P.seq : Math.floor(f.safe && f.bpm > 132 ? b / 2 : b))) % 2 === 0; const tr2 = P ? Math.exp(-P.age * 3) : Math.sin(Math.PI * fract(b)) ** 2; return on ? 0.55 + 0.45 * tr2 : 0.18; }
    case 'snarebloom': { const head = fract(b / 4), d = Math.min(Math.abs(o - head), 1 - Math.abs(o - head)); return 0.2 + 0.8 * Math.exp(-d * d * 40) * (0.45 + 0.55 * Math.min(1, f.snare * 1.5 + 0.2)); }
    case 'loop': { const head = fract(b / 4), d = Math.min(Math.abs(o - head), 1 - Math.abs(o - head)); return 0.12 + 0.88 * Math.exp(-d * d * 30); }
    case 'halves': return ((Math.floor(b / 2) + (x01 < 0.5 ? 0 : 1)) % 2) ? 1 : 0.2;
    case 'steps': { const q = Math.min(3, Math.floor(x01 * 4)); return q === ((Math.floor(b) % 4) + 4) % 4 ? 1 : 0.22; }
    case 'centre': { const r = fract(b / 4) * 1.3; return 0.15 + 0.85 * Math.exp(-Math.pow((ctr - r) * 4, 2)); }
    case 'pingpong': { const t = fract(b / 8) * 2, head = t < 1 ? t : 2 - t; return 0.08 + 0.92 * Math.exp(-Math.pow((x01 - head) * 5, 2)); }
    case 'scatter': { const rate = rollRate(f); const k = Math.floor(b * rate); return hash3(k, g.i, Math.round(g.seed * 997)) < 0.2 + 0.5 * f.build ? 1 : 0.12; }
    case 'banks': { const rate = rollRate(f); const k = Math.floor(b * rate); const bank = Math.min(3, Math.floor(x01 * 4)); return ((k % 4) + 4) % 4 === bank ? 1 : 0.15; }
    case 'fill': return x01 <= (f.barPos / 4) * (0.6 + 0.4 * f.build) + 0.05 ? 1 : 0.12;
    case 'glow': { const k = Math.floor(b / 4); const on = hash3(k, g.i, 31) < 0.4; const w = Math.sin(Math.PI * fract(b / 4)); return 0.3 + 0.7 * (on ? w : 0.2 * w); }
    case 'ripple': return 0.3 + 0.7 * (0.5 + 0.5 * Math.cos(2 * Math.PI * (ctr * 1.2 - b / 8)));
    case 'tide': return 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(2 * Math.PI * (b / 16 - x01)));
    case 'swellramp': return 0.25 + 0.75 * fract(b / 32);
    case 'bounce': { const P = anyDrum(f); return ((((P ? P.seq : Math.floor(b)) % 2) + 2) % 2) ? 0.45 : 1; }
    case 'double': { const P = anyDrum(f); return (P ? P.age : fract(b)) < 0.5 ? 1 : 0.75; }
    case 'dark': return 0.32;
    case 'kickpump': return clamp01(0.35 + 0.65 * f.kick * 1.3);
  }
  return 1;
}
/** build rolls double their rate with the build (1 → 2 → 4 → 8 steps a beat); spatial, so the rig never flashes as one */
export function rollRate(f: PackFrame): number {
  const r = [1, 2, 4, 8][Math.min(3, Math.floor(Math.max(0, f.build) * 4))];
  if (!f.safe) return r;
  // (Safe: the roll steps at most 2.2 a second - steps per beat, quantised to quarters; a stray x4 here let a roll step
  //  3 times a beat at 174 BPM, which only the governors held back)
  return Math.min(r, Math.max(0.5, Math.floor(2.2 * 60 / Math.max(40, f.bpm) * 4) / 4));
}

// ---------------------------------------------------------------------------------------------------- colour
const C3: [number, number, number] = [0, 0, 0];
/** The fixture's colour (sRGB 0..1) for the program's colour mode. */
function pickI(c: [number, number, number][], j: number, out: [number, number, number]) { const k = c.length, P = c[((j % k) + k) % k]; out[0] = P[0]; out[1] = P[1]; out[2] = P[2]; }
function blendI(c: [number, number, number][], t: number, out: [number, number, number]) { const k = c.length, i0 = Math.floor(t), w = t - i0, A = c[((i0 % k) + k) % k], B = c[(((i0 + 1) % k) + k) % k]; out[0] = A[0] + (B[0] - A[0]) * w; out[1] = A[1] + (B[1] - A[1]) * w; out[2] = A[2] + (B[2] - A[2]) * w; }
export function packColor(p: Program, f: PackFrame, o: number, g: PackGeo, out: [number, number, number]): [number, number, number] {
  const c = f.colors, k = c.length;
  // (Safe flashes ON: a flash-heavy program keeps its energy with colour - the sides swap colours every bar)
  const mode: ColourMode = f.safe && p.flashy && (p.colour === 'mono' || p.colour === 'white') ? 'exchange' : p.colour;
  switch (mode) {
    case 'mono': pickI(c, f.step, out); break;
    case 'split': pickI(c, f.step + ((f.sym ? g.x < 0.5 : g.x < 0) ? 0 : 1), out); break;
    case 'alt': pickI(c, f.step + (g.i % 2), out); break;
    case 'exchange': { const sw = Math.floor(f.beat / 4) % 2; const w = sm01((fract(f.beat / 4) - 0.85) / 0.15); const a = ((f.sym ? g.x < 0.5 : g.x < 0) ? 0 : 1) ^ sw; blendI(c, f.step + a + (a ? -w : w), out); break; }
    case 'sweep': blendI(c, f.step + o * (k - 1) + f.beat / 16, out); break;
    case 'rainbow': { const h = fract(o * 0.5 + f.beat / 32 + f.step * 0.17); hsl(h, out); break; }
    case 'white': { if (g.i % 3 === 0) pickI(c, f.step, out); else { out[0] = 0.93; out[1] = 0.96; out[2] = 1; } break; }
    default: blendI(c, f.step + o * (k - 1), out);
  }
  return out;
}
const sm01 = (x: number) => { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t); };
const hslC = (n: number, h: number) => { const kk = (n + h * 12) % 12; return 0.5 - 0.5 * Math.max(-1, Math.min(kk - 3, 9 - kk, 1)); };
function hsl(h: number, out: [number, number, number]) { out[0] = hslC(0, h); out[1] = hslC(8, h); out[2] = hslC(4, h); }

// ---------------------------------------------------------------------------------------------------- evaluators
const TL: TLevel = { v: 0, flash: false, key: '' };
const AIM: Aim = { yaw: 0, pitch: 0, zoom: 0 };
const onsetOf = (t: Target, f: PackFrame) => { const d = targetById(t); if (!d?.onset || !f.onsets) return NaN; return d.onset === 'kick' ? f.kick : d.onset === 'snare' ? f.snare : f.hat; };
/** the level floor beams / spots keep between hits (a drop's beams stay up between kicks) - chases keep their gaps */
export const PACK_BEAM_FLOOR = 0.3;
const GAPPY = new Set<Shape>(['chase', 'pursuit', 'steps', 'banks', 'scatter', 'fill', 'halves', 'loop', 'pingpong']);

export interface MoverOutLike { level: number; flash: boolean; key: string; r: number; g: number; b: number; yaw: number; pitch: number; zoom: number }
/** A moving head (beam / spot / wash) for the program. */
export function packMover(p: Program, kind: MoverKind, f: PackFrame, g0: PackGeo, out: MoverOutLike): MoverOutLike {
  const L = kind === 'wash' ? p.wash : p.level;
  const side = g0.x < 0 ? -1 : 1;
  // (symmetric: evaluate the mirror twin's geometry, then mirror the pan)
  const g = f.sym ? symGeo(g0, SG) : g0, mir = f.sym && g0.x < 0 ? -1 : 1;
  const o = orderOf(p.level.spread, g);
  const def = beamFormById(p.beam.form);
  const calm = f.safe;
  const mb = f.mb * p.tempo;
  // hot builds mirror every other step
  let gx = g;
  if (p.hot && f.section === 'build' && Math.floor(f.beat) % 2) { gx = Object.assign(GX, g); GX.x = -g.x; }
  let amp = p.beam.amp * (0.75 + 0.25 * f.energy) * (1 + 0.35 * f.build);
  if (f.safe && p.flashy) amp *= 1.2;                                   // (the safe variant: wider moves instead of flashes)
  // (Safe flashes ON: a formation sweeps at most one cycle per SAFE_BEAM_RATE⁻¹ motion beats - in a dark room the beams
  //  ARE the frame's light, and a cone swinging fast changes how much of the frame it lights several times a second)
  beamAim(p.beam.form, kind, mb, f.safe ? Math.min(p.beam.rate, SAFE_BEAM_RATE) : p.beam.rate, amp, gx, calm || !!def?.calm, AIM);
  let yaw = AIM.yaw, pitch = AIM.pitch;
  // build geometry: narrow + tilt up with the build; the director's converge pulls everything onto the DJ
  if (f.section === 'build' && f.build > 0) { const nb = Math.pow(f.build, 1.3); yaw *= 1 - 0.55 * nb; pitch += (kind === 'beam' ? 18 : 10) * nb; }
  const cv = f.converge;
  if (cv > 0) { yaw = yaw * (1 - cv) + (-g.x * 30) * cv; pitch = pitch * (1 - cv) + (kind === 'beam' ? 50 : -8) * cv; }
  targetLevel(L.target, L.motion, f.beat, f.bpm, o, side, g.seed, f.safe, onsetOf(L.target, f), TL, drumsOf(f), softHatsOf(f));
  let v = TL.v * shapeWeight(L.shape, f, o, g);
  if (kind !== 'wash' && !GAPPY.has(L.shape) && L.motion !== 'sparkle' && L.motion !== 'wipe') v = PACK_BEAM_FLOOR + (1 - PACK_BEAM_FLOOR) * v;
  packColor(p, f, kind === 'beam' ? o : 1 - o, g, C3);
  if (p.hot && f.section === 'build') { const wb = 0.42 * f.build; C3[0] += (1 - C3[0]) * wb; C3[1] += (1 - C3[1]) * wb; C3[2] += (1 - C3[2]) * wb; }
  out.level = v * f.level; out.flash = TL.flash; out.key = TL.key ? `pk${TL.key}` : '';
  out.r = C3[0]; out.g = C3[1]; out.b = C3[2];
  out.yaw = yaw * mir; out.pitch = Math.max(-70, Math.min(89, pitch)); out.zoom = AIM.zoom;
  return out;
}

export interface FlatOutLike { level: number; flash: boolean; key: string; r: number; g: number; b: number }
/** Washes, PAR cans, pixel bars: the program's wash rhythm over its spread. */
export function packFlat(p: Program, f: PackFrame, g0: PackGeo, out: FlatOutLike): FlatOutLike {
  const side = g0.x < 0 ? -1 : 1;
  const g = f.sym ? symGeo(g0, SG) : g0;
  const o = orderOf(p.level.spread, g);
  targetLevel(p.wash.target, p.wash.motion, f.beat, f.bpm, o, side, g.seed, f.safe, onsetOf(p.wash.target, f), TL, drumsOf(f), softHatsOf(f));
  const v = TL.v * shapeWeight(p.wash.shape, f, o, g);
  packColor(p, f, o, g, C3);
  out.level = v * f.level; out.flash = TL.flash; out.key = TL.key ? `pf${TL.key}` : '';
  out.r = C3[0]; out.g = C3[1]; out.b = C3[2];
  return out;
}

const has = (q: DrumPhase) => q.age >= 0;
const SKEY: Record<StrobePat, string> = { none: 'psgnone', snare: 'psgsnare', beat: 'psgbeat', offbeat: 'psgoffbeat', bar: 'psgbar', storm: 'psgstorm', lightning: 'psglightning', roll: 'psgroll', kick: 'psgkick' };
/** The strobe group's own pattern (the director's countdown + drop hit are added by the engine): 0..1 + a gate key.
 *  Safe flashes ON: strobe-heavy patterns stand down (the program's safe variant moves + colours instead); single
 *  accents (bar, snare) stay and pass the gate. */
export function packStrobe(p: Program, f: PackFrame, out: { v: number; flash: boolean; key: string }) {
  out.v = 0; out.flash = false; out.key = '';
  if (p.strobe === 'none') return out;
  const peak = f.section === 'drop' || (p.strobe === 'roll' && f.section === 'build');
  if (!peak && p.strobe !== 'bar') return out;
  const b = f.beat, bar = fract(b / 4) * 4;
  const hit = (per: number, off: number, decay: number, tag: string) => { const u = b * per - off; out.v = Math.exp(-fract(u) * decay); out.flash = true; out.key = `ps${tag}${Math.floor(u)}`; };
  const D = drumsOf(f);
  if (f.safe && (p.strobe === 'storm' || p.strobe === 'lightning' || p.strobe === 'roll' || p.strobe === 'beat' || p.strobe === 'offbeat' || p.strobe === 'kick')) {
    // (one soft white lift per bar on the downbeat - under the gate's 3 a second by construction; on the bar's first kick
    //  when the drums own the hits)
    if (D && p.strobe !== 'roll') { const B = has(D.down) ? D.down : D.first; if (has(B)) { out.v = 0.35 * Math.exp(-B.age * 2.2); out.flash = true; out.key = drumKey('psgb', B.id); } return out; }
    out.v = 0.35 * Math.exp(-bar * 2.2); out.flash = true; out.key = `psb${Math.floor(b / 4)}`; return out;
  }
  // the drums own the strobe pops: snare / offbeat strobes on the snares, beat / kick strobes on the kicks, the bar on its
  // first kick, storm / lightning on drums picked per hit (a build's roll stays on its grid: the roll IS the build)
  if (D && p.strobe !== 'roll') {
    const P = p.strobe === 'snare' || p.strobe === 'offbeat' ? (has(D.snare) ? D.snare : D.any)
      : p.strobe === 'beat' || p.strobe === 'kick' ? (has(D.kick) ? D.kick : D.any)
      : p.strobe === 'bar' ? (has(D.down) ? D.down : D.first) : D.any;
    if (has(P)) {
      const a = P.age;
      switch (p.strobe) {
        case 'snare': case 'offbeat': out.v = Math.exp(-a * 8); break;
        case 'beat': case 'kick': out.v = Math.exp(-a * 9) * (p.strobe === 'kick' ? Math.min(1, 0.3 + f.kick) : 1); break;
        case 'bar': out.v = Math.exp(-a * 5); break;
        case 'storm': out.v = hash3(P.id, 77) < 0.5 ? Math.exp(-a * 10) : 0; break;
        case 'lightning': out.v = hash3(P.id, 13) < 0.45 ? Math.max(Math.exp(-a * 14), a > 0.18 ? Math.exp(-(a - 0.18) * 14) * 0.8 : 0) : 0; break;
      }
      out.flash = true; out.key = drumKey(p.strobe === 'lightning' && a > 0.18 ? 'psglightningb' : SKEY[p.strobe], P.id);
    }
    return out;   // (a groove with no drum for this pattern: dark - never a grid pop)
  }
  switch (p.strobe) {
    case 'snare': { const t = bar < 1 ? bar + 1 : bar < 3 ? bar - 1 : bar - 3; out.v = Math.exp(-t * 8); out.flash = true; out.key = `pss${Math.floor((b - 1) / 2)}`; break; }
    case 'beat': case 'kick': hit(1, 0, 9, 'k'); if (p.strobe === 'kick') out.v *= Math.min(1, 0.3 + f.kick); break;
    case 'offbeat': hit(1, 0.5, 9, 'o'); break;
    case 'bar': hit(0.25, 0, 5, 'b'); break;
    case 'storm': { const k = Math.floor(b * 2); out.v = hash3(k, 77) < 0.5 ? Math.exp(-fract(b * 2) * 10) : 0; out.flash = true; out.key = `pst${k}`; break; }
    case 'lightning': { const t = fract(b / 2) * 2; const on = hash3(Math.floor(b / 2), 13) < 0.6; out.v = on ? Math.max(Math.exp(-t * 14), t > 0.18 ? Math.exp(-(t - 0.18) * 14) * 0.8 : 0) : 0; out.flash = true; out.key = `psl${Math.floor(b / 2)}${t > 0.18 ? 'b' : 'a'}`; break; }
    case 'roll': { const r = rollRate(f); hit(r, 0, 10, `r${r}`); out.v *= 0.4 + 0.6 * f.build; break; }
  }
  return out;
}

export interface PackLaserOut { on: number; flash: boolean; key: string; r: number; g: number; b: number; yaw: number; pitch: number; spread: number; spin: number; form: LaserForm; mt: number; sheet: boolean; rays: number; tiers: number; seed: number;
  /** a left-side origin of a symmetric rig: its rays are its mirror twin's, mirrored (packRay) */
  mirror?: boolean }
const LA = { yaw: 0, pitch: 0, spread: 0, spin: 0 };
/** A laser origin: aim, width, spin, level, colour + the formation its rays make (rayAim per ray). `budget` = rays the
 *  renderer has per origin. */
export function packLaser(p: Program, f: PackFrame, g0: PackGeo, budget: number, out: PackLaserOut): PackLaserOut {
  out.flash = false; out.key = '';
  const g = f.sym ? symGeo(g0, SG) : g0, mir = f.sym && g0.x < 0;
  out.mirror = mir;
  const lz = p.laser;
  if (!lz || (f.section === 'intro' && f.energy < 0.3)) { out.on = 0; return out; }
  const def = laserFormById(lz.form)!;
  // (Safe flashes ON: the formation's own ray motion is capped as the beams' - rays that move slowly stay bright; fast ones
  //  would be dimmed by their swing speed, see packRaySwing)
  const mt = f.mb * (f.safe ? Math.min(lz.rate * p.tempo, SAFE_LASER_RATE) : lz.rate * p.tempo);
  laserAim(lz.form, mt, g, f.safe || def.calm, LA);
  out.yaw = LA.yaw; out.pitch = LA.pitch; out.spread = LA.spread * (p.wide ? 1.35 : 1); out.spin = LA.spin;
  if (f.section === 'build' && f.build > 0) { out.spread *= 1 - 0.6 * f.build; out.pitch += 6 * f.build; }
  const o = f.sym ? g.x : (g.x + 1) / 2, side = g0.x < 0 ? -1 : 1;
  if (mir) out.yaw = -out.yaw;
  targetLevel(lz.target, lz.motion, f.beat, f.bpm, o, side, g.seed, f.safe, onsetOf(lz.target, f), TL, drumsOf(f), softHatsOf(f));
  let on = 0.3 + 0.7 * TL.v;
  if (f.section === 'breakdown') on *= 0.6;
  out.flash = TL.flash; out.key = TL.key ? `pl${TL.key}` : '';
  packColor(p, f, o, g, C3);
  out.r = C3[0]; out.g = C3[1]; out.b = C3[2];
  out.on = on * f.level;
  out.form = lz.form; out.mt = mt; out.sheet = def.sheet; out.seed = g.seed;
  out.rays = Math.max(1, Math.round(budget * def.rays));
  out.tiers = p.hot && f.section === 'build' ? 3 : 1;
  return out;
}
const RA = { yaw: 0, pitch: 0 };
/** Ray k of n of an evaluated origin (yaw / pitch, deg). Stacked tiers (hot builds) step the rows every beat. */
export function packRay(e: PackLaserOut, k: number, n: number, beat: number, out: { yaw: number; pitch: number }) {
  // (a mirrored origin draws its twin's rays, mirrored: fans, crosses and counter-rotating cones stay symmetric)
  LA.yaw = e.mirror ? -e.yaw : e.yaw; LA.pitch = e.pitch; LA.spread = e.spread; LA.spin = e.spin;
  if (e.tiers > 1) { const per = Math.max(1, Math.ceil(n / e.tiers)), row = Math.floor(k / per); rayAim(e.form, k % per, per, e.mt, e.seed, LA, RA); RA.pitch += ((row + Math.floor(beat)) % e.tiers) * 8; }
  else rayAim(e.form, k, n, e.mt, e.seed, LA, RA);
  out.yaw = e.mirror ? -RA.yaw : RA.yaw; out.pitch = RA.pitch;
  return out;
}

/** is this program's look built on flashes (strobe patterns / unison hits faster than the limit)? */
export function isFlashy(p: Pick<Program, 'strobe' | 'level' | 'wash' | 'laser'>, bpm = 150): boolean {
  if (p.strobe !== 'none' && p.strobe !== 'bar' && p.strobe !== 'snare') return true;
  const fast = (t: Target, m: Motion) => (m === 'hit' || m === 'saw' || m === 'sparkle') && (targetById(t)?.perBeat ?? 0) * bpm / 60 > 2.2;
  return fast(p.level.target, p.level.motion) || fast(p.wash.target, p.wash.motion) || (!!p.laser && fast(p.laser.target, p.laser.motion));
}
