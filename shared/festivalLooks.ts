// Festival light-show presets, built like a lighting desk (docs/SCENES.md "Festival" → "Looks and shows"):
//   atoms     hand-authored palettes (40), movement patterns (25), intensity rhythms (20), spreads (10) and accent
//             rules (12: strobes, blinders, lasers, pyro)
//   looks     generated as a constrained, seeded product of the atoms, filtered by rules (no ugly combos), scored, and
//             kept per palette and energy class → ~360 named looks (generateLooks). Deterministic: the same list on
//             every page, every run (the curation bitmask in SceneFestivalState indexes it; LOOKS_VERSION guards it).
//   shows     the presets a streamer picks: per genre (hardstyle, rawstyle, hardcore 190–230, house, techno, trance,
//             dubstep, drum & bass, big room, chill) × palette family, each a map of song sections → looks plus a drop
//             sequence (countdown, blackout, blinders, CO2, flames on the kicks …). 'auto' picks the genre by tempo.
// Pure data + pure functions. Room themes add palettes / shows through scene.json `festival` (room data), never here.
import { hashStr, hash3, hexRgb } from './festival.ts';
import { addPackToShows, packLooks } from './showPack/festival.ts';
import type { Program } from './showPack/program.ts';
import type { PackWall } from './showPack/walls.ts';
import { MAINSTAGE_MAGENTA_ROLES, MAINSTAGE_ROLES, type ColorRoles } from './festivalRoles.ts';

export const LOOKS_VERSION = 1;

// ---------------------------------------------------------------------------------------------------- atoms
export interface Palette { id: string; name: string; colors: string[]; tags: string[] }
export type MotionKind = 'still' | 'sweep' | 'fan' | 'ballyhoo' | 'circle' | 'fig8' | 'tiltwave' | 'crossfire' | 'audience' | 'sky' | 'converge' | 'vee' | 'wave' | 'snap' | 'spiral' | 'pendulum' | 'searchlight' | 'bloom' | 'xcross' | 'arc' | 'lift' | 'shake' | 'ripple' | 'helix' | 'fanpump';
export interface Motion { id: MotionKind; name: string; word: string; /** beats per cycle */ rate: number; /** 0..1 of the range */ amp: number; energy: number; fast: boolean }
export type RhythmKind = 'hold' | 'kick' | 'offbeat' | 'gallop' | 'chase' | 'pingpong' | 'sparkle' | 'stack' | 'alternate' | 'snare' | 'halftime' | 'sixteenth' | 'breathe' | 'riser' | 'wave' | 'heartbeat' | 'triplet' | 'downbeat' | 'swing' | 'strobe';
export interface Rhythm { id: RhythmKind; name: string; word: string; energy: number; /** a "hit" layer (full-depth flashes the gate caps) */ hit: boolean; sixteenth: boolean; /** full-depth flashes per beat (photosensitivity check) */ flashesPerBeat: number }
export type SpreadKind = 'unison' | 'leftright' | 'wings' | 'centerout' | 'bottomtop' | 'random' | 'blocks2' | 'blocks4' | 'oddeven' | 'radial';
export interface Spread { id: SpreadKind; name: string; /** fraction of a cycle across the whole order */ phase: number }
export type LaserMode = 'off' | 'fan' | 'sheet' | 'tunnel' | 'scan' | 'cross' | 'liquid' | 'burst';
export interface Accent {
  id: string; name: string; energy: number;
  /** strobe usage 0..1 (white strobes on hits) */
  strobe: number;
  blinder: 'off' | 'drop' | 'downbeat' | 'bar4';
  laser: 'off' | 'slow' | 'beat' | '16th';
  pyro: 'none' | 'drop' | 'phrase' | 'kick';
}

const P = (id: string, name: string, colors: string[], ...tags: string[]): Palette => ({ id, name, colors, tags });
export const PALETTES: Palette[] = [
  P('inferno', 'Inferno', ['#ff2200', '#ff7a00', '#ffc400'], 'fire', 'warm', 'hard'),
  P('blood_moon', 'Blood Moon', ['#ff0030', '#ff4d00', '#ffffff'], 'fire', 'warm', 'hard'),
  P('red_alert', 'Red Alert', ['#ff0000', '#ffffff'], 'hard', 'mono', 'warm'),
  P('hellfire', 'Hellfire', ['#ff1100', '#ff6a00', '#ffffff'], 'fire', 'hard'),
  P('lava', 'Lava Flow', ['#ff3300', '#ff0066', '#ffaa00'], 'fire', 'warm'),
  P('ember', 'Ember', ['#ff5a1f', '#ff2a00', '#ffc27a'], 'warm', 'fire', 'chill'),
  P('toxic', 'Toxic', ['#39ff14', '#b6ff00', '#00ff9c'], 'acid', 'neon'),
  P('acid_violet', 'Acid Violet', ['#39ff14', '#a200ff'], 'acid', 'neon', 'hard'),
  P('venom', 'Venom', ['#a6ff00', '#6a00ff', '#00ff66'], 'acid', 'uv'),
  P('neon_jungle', 'Neon Jungle', ['#7dff00', '#00ffc8', '#ff00a0'], 'acid', 'neon'),
  P('toxic_rave', 'Toxic Rave', ['#00ff2a', '#ff00e1'], 'acid', 'neon', 'hard'),
  P('ultraviolet', 'Ultraviolet', ['#6a00ff', '#b000ff', '#ff00d4'], 'uv', 'cold'),
  P('uv_white', 'UV Flash', ['#7a00ff', '#ffffff'], 'uv', 'hard', 'mono'),
  P('plasma', 'Plasma', ['#ff00ff', '#00ffff', '#2a00ff'], 'uv', 'neon'),
  P('deep_ocean', 'Deep Ocean', ['#0050ff', '#00c8ff', '#00ffd5'], 'cold'),
  P('ice_storm', 'Ice Storm', ['#9fe8ff', '#ffffff', '#3a7bff'], 'cold', 'white'),
  P('arctic', 'Arctic White', ['#ffffff', '#cfe9ff'], 'white', 'mono', 'cold'),
  P('storm', 'Thunderstorm', ['#4a7dff', '#ffffff', '#a0b4ff'], 'cold', 'white', 'hard'),
  P('deep_space', 'Deep Space', ['#2a00ff', '#0099ff', '#ffffff'], 'cold', 'uv'),
  P('aurora', 'Aurora', ['#00ffa3', '#00b3ff', '#9d4dff'], 'cold', 'rainbow'),
  P('lagoon', 'Lagoon', ['#00ffd0', '#00a2ff', '#66ffcc'], 'cold', 'chill'),
  P('emerald', 'Emerald', ['#00ff6a', '#00b36b', '#a0ffd0'], 'cold', 'chill'),
  P('silver', 'Silver Screen', ['#e8ecff', '#9bb0ff'], 'white', 'mono', 'chill'),
  P('tungsten', 'Tungsten', ['#ffb35c', '#ffd9a0'], 'warm', 'white', 'chill'),
  P('gold_rush', 'Gold Rush', ['#ffb300', '#fff1b0', '#ff7a00'], 'warm'),
  P('solar', 'Solar Flare', ['#fff000', '#ff8800', '#ffffff'], 'warm', 'hard'),
  P('sunset', 'Sunset Strip', ['#ff4f6d', '#ff9a3c', '#ffd36b'], 'warm', 'chill'),
  P('crimson_gold', 'Crimson & Gold', ['#d4002a', '#ffc000'], 'warm', 'hard'),
  P('citrus', 'Citrus', ['#ffe600', '#9dff00', '#ff8a00'], 'warm', 'acid'),
  P('cherry', 'Cherry Bomb', ['#ff0055', '#ff66a3', '#ffffff'], 'warm', 'neon'),
  P('magenta_cyan', 'Magenta / Cyan', ['#ff00b3', '#00e5ff'], 'neon', 'hard'),
  P('police', 'Siren', ['#ff0022', '#0033ff'], 'hard', 'neon'),
  P('cyberpunk', 'Cyberpunk', ['#ff2bd6', '#00f0ff', '#fff200'], 'neon'),
  P('synthwave', 'Synthwave', ['#ff2e97', '#7b2bff', '#ffb000'], 'neon', 'warm'),
  P('mint_pink', 'Mint & Pink', ['#00ffb0', '#ff4fc8'], 'neon', 'chill'),
  P('royal', 'Royal', ['#3b00ff', '#ffc400'], 'uv', 'warm'),
  P('amber_teal', 'Amber & Teal', ['#ffa000', '#00c2b8'], 'warm', 'cold'),
  P('dusk', 'Dusk', ['#7a3cff', '#ff5f8f', '#ffb36b'], 'chill', 'warm'),
  P('pastel', 'Pastel Dream', ['#ff9ad5', '#a6c8ff', '#b8ffda'], 'chill', 'pastel'),
  P('rainbow', 'Full Spectrum', ['#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00aaff', '#9900ff'], 'rainbow', 'neon'),
];
/** House palettes (shared/festivalRoles.ts): the set colours of the house looks. Not part of the look generator - the
 *  shipped look list, its curation indexes and every generated show stay exactly as they were. */
export const HOUSE_PALETTES: Palette[] = [P('mainstage_red', 'Mainstage Red', ['#b8160c', '#e2591c', '#f29a28', '#ffc24a'], 'fire', 'warm', 'hard')];

const M = (id: MotionKind, name: string, word: string, rate: number, amp: number, energy: number): Motion => ({ id, name, word, rate, amp, energy, fast: rate <= 2 });
export const MOTIONS: Motion[] = [
  M('still', 'Static fan', 'Static', 16, 0.3, 0.1),
  M('sweep', 'Sweep', 'Sweep', 8, 0.8, 0.45),
  M('fan', 'Fan in / out', 'Fan', 8, 0.8, 0.5),
  M('ballyhoo', 'Ballyhoo (random throws)', 'Ballyhoo', 2, 1, 0.95),
  M('circle', 'Circles', 'Circles', 4, 0.7, 0.55),
  M('fig8', 'Figure eight', 'Figure-8', 8, 0.7, 0.5),
  M('tiltwave', 'Tilt wave', 'Tilt Wave', 4, 0.7, 0.55),
  M('crossfire', 'Crossfire', 'Crossfire', 4, 0.8, 0.75),
  M('audience', 'Crowd sweep', 'Crowd Sweep', 8, 0.7, 0.65),
  M('sky', 'Skyward pillars', 'Pillars', 16, 0.2, 0.15),
  M('converge', 'Converge on the DJ', 'Converge', 4, 0.6, 0.7),
  M('vee', 'V spread', 'V-Spread', 8, 0.6, 0.4),
  M('wave', 'Pan wave', 'Wave', 4, 0.7, 0.6),
  M('snap', 'Snap positions', 'Snap', 1, 1, 0.9),
  M('spiral', 'Spiral', 'Spiral', 8, 0.8, 0.6),
  M('pendulum', 'Pendulum', 'Pendulum', 4, 0.8, 0.55),
  M('searchlight', 'Searchlights', 'Searchlight', 32, 0.9, 0.2),
  M('bloom', 'Bloom (circle + zoom)', 'Bloom', 8, 0.6, 0.45),
  M('xcross', 'X cross', 'X-Cross', 2, 0.8, 0.85),
  M('arc', 'Rainbow arc', 'Arc', 16, 0.6, 0.3),
  M('lift', 'Lift to the sky', 'Lift', 4, 0.9, 0.7),
  M('shake', 'Shake', 'Shake', 1, 0.25, 0.95),
  M('ripple', 'Ripple from the centre', 'Ripple', 4, 0.6, 0.55),
  M('helix', 'Helix', 'Helix', 8, 0.7, 0.5),
  M('fanpump', 'Fan pump', 'Fan Pump', 1, 0.8, 0.9),
];

const R = (id: RhythmKind, name: string, word: string, energy: number, hit: boolean, flashesPerBeat: number, sixteenth = false): Rhythm => ({ id, name, word, energy, hit, sixteenth, flashesPerBeat });
export const RHYTHMS: Rhythm[] = [
  R('hold', 'Hold', 'Glow', 0.05, false, 0),
  R('kick', 'Kick pulse', 'Pulse', 0.6, false, 1),
  R('offbeat', 'Offbeat', 'Offbeat', 0.65, false, 1),
  R('gallop', 'Gallop (reverse bass)', 'Gallop', 0.85, true, 2),
  R('chase', 'Chase', 'Chase', 0.5, false, 0),
  R('pingpong', 'Ping-pong', 'Ping-Pong', 0.55, false, 0),
  R('sparkle', 'Sparkle', 'Sparkle', 0.5, false, 0),
  R('stack', 'Stack and drop', 'Stack', 0.6, false, 0.25),
  R('alternate', 'Alternate', 'Alternate', 0.55, false, 1),
  R('snare', 'Backbeat (2 & 4)', 'Backbeat', 0.55, false, 0.5),
  R('halftime', 'Half-time (3)', 'Half-time', 0.6, false, 0.25),
  R('sixteenth', 'Sixteenth chase', 'Sixteenths', 0.95, true, 4, true),
  R('breathe', 'Breathe', 'Breathe', 0.1, false, 0),
  R('riser', 'Riser (accelerating)', 'Riser', 0.75, true, 2),
  R('wave', 'Intensity wave', 'Swell', 0.35, false, 0),
  R('heartbeat', 'Heartbeat', 'Heartbeat', 0.4, false, 0.5),
  R('triplet', 'Triplets', 'Triplets', 0.75, true, 3),
  R('downbeat', 'Downbeat hit', 'Downbeat', 0.45, false, 0.25),
  R('swing', 'Swing eighths (soft)', 'Swing', 0.55, false, 1),
  R('strobe', 'Strobe', 'Strobe', 1, true, 4, true),
];

export const SPREADS: Spread[] = [
  { id: 'unison', name: 'Unison', phase: 0 },
  { id: 'leftright', name: 'Left → right', phase: 0.5 },
  { id: 'wings', name: 'Wings (mirrored)', phase: 0.5 },
  { id: 'centerout', name: 'Centre out', phase: 0.35 },
  { id: 'bottomtop', name: 'Bottom → top', phase: 0.4 },
  { id: 'random', name: 'Random', phase: 1 },
  { id: 'blocks2', name: 'Two blocks', phase: 0.5 },
  { id: 'blocks4', name: 'Four blocks', phase: 0.75 },
  { id: 'oddeven', name: 'Odd / even', phase: 0.5 },
  { id: 'radial', name: 'Radial', phase: 0.6 },
];

const A = (id: string, name: string, energy: number, strobe: number, blinder: Accent['blinder'], laser: Accent['laser'], pyro: Accent['pyro']): Accent => ({ id, name, energy, strobe, blinder, laser, pyro });
export const ACCENTS: Accent[] = [
  A('calm', 'Calm', 0, 0, 'off', 'off', 'none'),
  A('glow', 'Glow + slow lasers', 0.15, 0, 'off', 'slow', 'none'),
  A('lasers_slow', 'Laser sky', 0.3, 0, 'off', 'slow', 'phrase'),
  A('lasers_beat', 'Lasers on the beat', 0.55, 0, 'off', 'beat', 'phrase'),
  A('lasers_16', 'Laser scans (16ths)', 0.8, 0, 'off', '16th', 'drop'),
  A('strobe_light', 'Strobe touches', 0.6, 0.3, 'off', 'beat', 'drop'),
  A('strobe_heavy', 'Strobe storm', 1, 1, 'drop', 'beat', 'drop'),
  A('blinder_drop', 'Blinders on the drop', 0.7, 0, 'drop', 'beat', 'drop'),
  A('blinder_bar4', 'Blinders every 4 bars', 0.75, 0.2, 'bar4', 'slow', 'phrase'),
  A('pyro_drop', 'Pyro on the drop', 0.8, 0.3, 'drop', 'beat', 'drop'),
  A('pyro_kick', 'Flames on the kicks', 0.95, 0.4, 'drop', 'beat', 'kick'),
  A('full_send', 'Full send', 1, 0.6, 'downbeat', 'beat', 'kick'),
];

// ---------------------------------------------------------------------------------------------------- looks
export type EnergyClass = 'chill' | 'mid' | 'peak';
export type Section = 'intro' | 'groove' | 'build' | 'drop' | 'breakdown' | 'outro';
export const SECTION_LIST: Section[] = ['intro', 'groove', 'build', 'drop', 'breakdown', 'outro'];
export const WALL_VISUALS = ['tunnel', 'kaleido', 'spectrum', 'plasma', 'warp', 'logo', 'grid', 'rings', 'fire', 'scanner', 'starfield', 'bars'] as const;
export type WallVisual = (typeof WALL_VISUALS)[number] | 'strobe' | 'countdown' | 'eye' | PackWall;
export interface Look {
  /** stable id (hash of the atoms) */
  id: string;
  name: string;
  palette: string; motion: MotionKind; rhythm: RhythmKind; spread: SpreadKind; accent: string;
  /** beams / spots follow `motion`; washes, pars and pixels follow `rhythm`; the beams' own rhythm */
  beamRhythm: RhythmKind;
  laser: LaserMode; wall: WallVisual;
  energy: number; cls: EnergyClass;
  /** song sections it suits */
  sections: Section[];
  score: number;
  /** a show-pack program (shared/showPack): the evaluators hand this look to the pack's own */
  pack?: Program;
}

const contrastOf = (p: Palette) => {
  // hue spread + white present → 0..1
  const hues = p.colors.map((c) => { const [r, g, b] = hexRgb(c); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx - mn < 0.15) return -1; let h = 0; if (mx === r) h = ((g - b) / (mx - mn)) % 6; else if (mx === g) h = (b - r) / (mx - mn) + 2; else h = (r - g) / (mx - mn) + 4; return ((h * 60) + 360) % 360; });
  const white = hues.some((h) => h < 0) ? 0.35 : 0;
  const hs = hues.filter((h) => h >= 0);
  let spread = 0;
  for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) { const d = Math.abs(hs[i] - hs[j]); spread = Math.max(spread, Math.min(d, 360 - d) / 180); }
  return Math.min(1, spread + white);
};
export const paletteContrast = (p: Palette) => contrastOf(p);

const byId = <T extends { id: string }>(list: T[]) => new Map(list.map((x) => [x.id, x]));
const MOTION = byId(MOTIONS), RHYTHM = byId(RHYTHMS), ACCENT = byId(ACCENTS);
export const motionById = (id: string) => MOTION.get(id as MotionKind);
export const rhythmById = (id: string) => RHYTHM.get(id as RhythmKind);
export const accentById = (id: string) => ACCENT.get(id);

/** Motions / rhythms / accents that suit an energy class. */
const CLASS_POOL: Record<EnergyClass, { motions: MotionKind[]; rhythms: RhythmKind[]; accents: string[]; walls: WallVisual[]; lasers: LaserMode[] }> = {
  chill: { motions: ['still', 'sky', 'searchlight', 'arc', 'sweep', 'fig8', 'helix', 'bloom', 'vee', 'tiltwave'], rhythms: ['hold', 'breathe', 'wave', 'heartbeat', 'chase', 'downbeat', 'sparkle'], accents: ['calm', 'glow', 'lasers_slow'], walls: ['plasma', 'starfield', 'kaleido', 'logo', 'rings'], lasers: ['off', 'liquid', 'sheet'] },
  mid: { motions: ['sweep', 'fan', 'circle', 'fig8', 'tiltwave', 'audience', 'vee', 'wave', 'spiral', 'pendulum', 'bloom', 'helix', 'ripple', 'converge', 'arc'], rhythms: ['kick', 'offbeat', 'chase', 'pingpong', 'sparkle', 'stack', 'alternate', 'snare', 'halftime', 'wave', 'downbeat', 'swing', 'riser'], accents: ['glow', 'lasers_slow', 'lasers_beat', 'strobe_light', 'blinder_bar4'], walls: ['tunnel', 'kaleido', 'spectrum', 'warp', 'logo', 'grid', 'rings', 'scanner', 'bars'], lasers: ['fan', 'sheet', 'scan', 'cross', 'liquid'] },
  peak: { motions: ['ballyhoo', 'crossfire', 'converge', 'snap', 'xcross', 'lift', 'shake', 'fanpump', 'audience', 'wave', 'circle', 'ripple', 'fan'], rhythms: ['kick', 'offbeat', 'gallop', 'sixteenth', 'stack', 'alternate', 'triplet', 'strobe', 'swing', 'snare', 'halftime'], accents: ['lasers_beat', 'lasers_16', 'strobe_light', 'strobe_heavy', 'blinder_drop', 'pyro_drop', 'pyro_kick', 'full_send'], walls: ['tunnel', 'warp', 'fire', 'spectrum', 'grid', 'scanner', 'bars', 'kaleido'], lasers: ['fan', 'tunnel', 'scan', 'cross', 'burst', 'sheet'] },
};
const CLASS_SECTIONS: Record<EnergyClass, Section[]> = { chill: ['intro', 'breakdown', 'outro'], mid: ['groove', 'build', 'intro', 'outro'], peak: ['drop', 'build'] };
/** Pairs that read badly (snapping heads with a slow breathe, …). */
const CLASH = new Set(['snap|breathe', 'snap|hold', 'shake|breathe', 'shake|hold', 'ballyhoo|breathe', 'ballyhoo|hold', 'searchlight|sixteenth', 'searchlight|strobe', 'still|gallop', 'sky|sixteenth', 'fanpump|wave', 'xcross|breathe']);
/** Combos that look great together (score bonus). */
const AFFINITY: Record<string, number> = { 'ballyhoo|kick': 0.3, 'ballyhoo|gallop': 0.25, 'sweep|chase': 0.25, 'fan|wave': 0.2, 'sky|breathe': 0.3, 'searchlight|hold': 0.25, 'converge|stack': 0.25, 'crossfire|alternate': 0.25, 'snap|kick': 0.3, 'snap|offbeat': 0.2, 'circle|pingpong': 0.2, 'xcross|sixteenth': 0.15, 'lift|riser': 0.3, 'audience|kick': 0.2, 'wave|wave': 0.2, 'helix|chase': 0.2, 'ripple|downbeat': 0.2, 'fanpump|kick': 0.25, 'shake|strobe': 0.2, 'arc|heartbeat': 0.15, 'tiltwave|offbeat': 0.2, 'pendulum|swing': 0.2, 'bloom|breathe': 0.2, 'spiral|triplet': 0.15 };

export interface RuleVerdict { ok: boolean; why: string }
/** The rules every generated look passes (tested in tools/festival_unit.ts). */
export function lookRules(pal: Palette, m: Motion, r: Rhythm, a: Accent, cls: EnergyClass, energy: number): RuleVerdict {
  const heavyStrobe = r.id === 'strobe' || a.strobe >= 0.6;
  if (heavyStrobe && energy < 0.75) return { ok: false, why: 'strobe-heavy below energy 0.75' };
  if (cls === 'chill' && (m.fast || r.hit || a.strobe > 0 || a.pyro === 'kick' || a.pyro === 'drop')) return { ok: false, why: 'fast / hits in a chill look' };
  if (cls === 'peak' && contrastOf(pal) < 0.3 && !pal.tags.includes('hard')) return { ok: false, why: 'low-contrast palette in a drop look' };
  if (cls === 'peak' && pal.tags.includes('pastel')) return { ok: false, why: 'pastel palette in a drop look' };
  const hits = (r.hit ? 1 : 0) + (a.strobe >= 0.5 ? 1 : 0) + (a.blinder === 'downbeat' || a.blinder === 'bar4' ? 1 : 0) + (a.laser === '16th' ? 1 : 0);
  if (hits > 2) return { ok: false, why: 'more than 2 hit layers' };
  if (r.sixteenth && a.laser === '16th') return { ok: false, why: 'beams and lasers both on 16ths' };
  if (CLASH.has(`${m.id}|${r.id}`)) return { ok: false, why: 'motion / rhythm clash' };
  // photosensitivity: a layer that flashes at full depth faster than 3 Hz at 150 BPM must be a declared hit layer (the gate caps those)
  if (!r.hit && r.flashesPerBeat * 2.5 > 3) return { ok: false, why: 'non-hit layer flashes > 3 Hz' };
  if (cls === 'peak' && energy < 0.6) return { ok: false, why: 'drop look too calm' };
  if (cls === 'mid' && (energy < 0.3 || energy > 0.85)) return { ok: false, why: 'mid look out of range' };
  return { ok: true, why: '' };
}
export const lookEnergy = (m: Motion, r: Rhythm, a: Accent) => Math.min(1, 0.35 * m.energy + 0.4 * r.energy + 0.25 * a.energy + 0.05);

const QUOTA: Record<EnergyClass, number> = { chill: 3, mid: 3, peak: 4 };
const shortId = (s: string) => hashStr(s).toString(36).padStart(7, '0').slice(-7);

/** Generate the look list (deterministic for a seed). `extra` = room palettes (scene.json festival.palettes): their
 *  looks are appended after the shipped ones (the curation bitmask keeps indexing the same base list). */
export function generateLooks(seed = 1, extra: Palette[] = []): Look[] {
  const out: Look[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  // global novelty: atoms used often already score lower, so every motion / rhythm shows up across the catalogue
  const gM = new Map<string, number>(), gR = new Map<string, number>(), gS = new Map<string, number>();
  for (const pal of [...PALETTES, ...extra]) {
    const usedM = new Set<string>(), usedR = new Set<string>();
    for (const cls of ['chill', 'mid', 'peak'] as EnergyClass[]) {
      if (cls === 'peak' && pal.tags.includes('pastel')) continue;
      if (cls === 'chill' && pal.tags.includes('hard') && !pal.tags.includes('white')) continue;
      const pool = CLASS_POOL[cls];
      const cand: Look[] = [];
      for (let k = 0; k < 160; k++) {
        const h = (salt: number) => hash3(seed * 7919 + hashStr(pal.id), k * 31 + salt, cls.length * 1013);
        const m = MOTION.get(pool.motions[Math.floor(h(1) * pool.motions.length)])!;
        const r = RHYTHM.get(pool.rhythms[Math.floor(h(2) * pool.rhythms.length)])!;
        const a = ACCENT.get(pool.accents[Math.floor(h(3) * pool.accents.length)])!;
        const s = SPREADS[Math.floor(h(4) * SPREADS.length)];
        const energy = lookEnergy(m, r, a);
        if (!lookRules(pal, m, r, a, cls, energy).ok) continue;
        const key = `${pal.id}|${m.id}|${r.id}|${s.id}|${a.id}`;
        const id = shortId(key);
        if (ids.has(id) || cand.some((c) => c.id === id)) continue;
        // beams: their own rhythm (drops: punchy; calm: hold)
        const br: RhythmKind = cls === 'chill' ? (h(5) < 0.6 ? 'hold' : 'breathe') : cls === 'mid' ? (['hold', 'kick', 'wave', 'chase'] as RhythmKind[])[Math.floor(h(5) * 4)] : (['kick', 'hold', 'offbeat', 'alternate'] as RhythmKind[])[Math.floor(h(5) * 4)];
        let score = (AFFINITY[`${m.id}|${r.id}`] ?? 0) + 0.25 * contrastOf(pal) + 0.2 * h(6);
        if (usedM.has(m.id)) score -= 0.35;
        if (usedR.has(r.id)) score -= 0.25;
        score -= 0.035 * (gM.get(m.id) ?? 0) + 0.025 * (gR.get(r.id) ?? 0) + 0.01 * (gS.get(s.id) ?? 0);
        if (cls === 'peak') score += 0.15 * energy;
        cand.push({ id, name: '', palette: pal.id, motion: m.id, rhythm: r.id, spread: s.id, accent: a.id, beamRhythm: br,
          laser: a.laser === 'off' ? 'off' : pool.lasers[Math.floor(h(7) * pool.lasers.length)],
          wall: pool.walls[Math.floor(h(8) * pool.walls.length)], energy: Math.round(energy * 1000) / 1000, cls, sections: CLASS_SECTIONS[cls], score: Math.round(score * 1000) / 1000 });
      }
      cand.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1));
      let n = 0;
      for (const c of cand) {
        if (n >= QUOTA[cls]) break;
        if (usedM.has(c.motion) && cand.some((d) => !usedM.has(d.motion) && d.score > c.score - 0.4 && !ids.has(d.id))) continue;
        const mo = MOTION.get(c.motion)!, rh = RHYTHM.get(c.rhythm)!;
        let name = `${pal.name} ${mo.word}`;
        if (names.has(name)) name = `${pal.name} ${mo.word} ${rh.word}`;
        if (names.has(name)) continue;
        c.name = name; names.add(name); ids.add(c.id);
        usedM.add(c.motion); usedR.add(c.rhythm);
        gM.set(c.motion, (gM.get(c.motion) ?? 0) + 1); gR.set(c.rhythm, (gR.get(c.rhythm) ?? 0) + 1); gS.set(c.spread, (gS.get(c.spread) ?? 0) + 1);
        out.push(c); n++;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- shows
export type DropStyle = 'hardstyle' | 'hardcore' | 'edm' | 'trance' | 'techno' | 'dubstep' | 'chill';
export interface Genre {
  id: string; name: string; bpm: [number, number]; drop: DropStyle;
  /** palette tags this genre likes (families are drawn from these) */
  tags: string[];
  motions: MotionKind[]; rhythms: RhythmKind[];
  /** bars per look before the show rotates (groove / drop) */
  rotate: number;
}
export const GENRES: Genre[] = [
  { id: 'hardstyle', name: 'Hardstyle', bpm: [145, 162], drop: 'hardstyle', tags: ['fire', 'warm', 'acid', 'neon', 'cold'], motions: ['ballyhoo', 'fan', 'converge', 'snap', 'crossfire', 'lift', 'fanpump'], rhythms: ['kick', 'gallop', 'offbeat', 'stack', 'sixteenth'], rotate: 8 },
  { id: 'rawstyle', name: 'Rawstyle', bpm: [150, 168], drop: 'hardstyle', tags: ['fire', 'hard', 'mono', 'uv'], motions: ['ballyhoo', 'snap', 'shake', 'xcross', 'crossfire'], rhythms: ['kick', 'gallop', 'strobe', 'sixteenth', 'triplet'], rotate: 8 },
  { id: 'hardcore', name: 'Hardcore', bpm: [170, 230], drop: 'hardcore', tags: ['hard', 'mono', 'uv', 'fire', 'acid'], motions: ['snap', 'shake', 'ballyhoo', 'xcross', 'fanpump'], rhythms: ['kick', 'strobe', 'sixteenth', 'alternate', 'offbeat'], rotate: 8 },
  { id: 'house', name: 'House', bpm: [116, 128], drop: 'edm', tags: ['warm', 'neon', 'chill', 'pastel'], motions: ['sweep', 'fan', 'circle', 'wave', 'fig8', 'pendulum'], rhythms: ['kick', 'offbeat', 'swing', 'chase', 'snare'], rotate: 16 },
  { id: 'techno', name: 'Techno', bpm: [125, 142], drop: 'techno', tags: ['mono', 'white', 'cold', 'hard', 'uv'], motions: ['still', 'tiltwave', 'audience', 'ripple', 'snap', 'converge'], rhythms: ['kick', 'strobe', 'sixteenth', 'stack', 'chase'], rotate: 16 },
  { id: 'trance', name: 'Trance', bpm: [132, 142], drop: 'trance', tags: ['cold', 'uv', 'rainbow', 'neon'], motions: ['sweep', 'fan', 'lift', 'arc', 'helix', 'circle', 'sky'], rhythms: ['offbeat', 'wave', 'riser', 'chase', 'breathe', 'kick'], rotate: 16 },
  { id: 'dubstep', name: 'Dubstep', bpm: [138, 152], drop: 'dubstep', tags: ['acid', 'neon', 'uv', 'hard'], motions: ['shake', 'snap', 'converge', 'crossfire', 'xcross'], rhythms: ['halftime', 'snare', 'triplet', 'strobe', 'stack'], rotate: 8 },
  { id: 'dnb', name: 'Drum & Bass', bpm: [168, 180], drop: 'edm', tags: ['cold', 'acid', 'neon', 'uv'], motions: ['wave', 'circle', 'ballyhoo', 'audience', 'ripple'], rhythms: ['snare', 'kick', 'swing', 'sixteenth', 'alternate'], rotate: 8 },
  { id: 'bigroom', name: 'Big Room', bpm: [126, 132], drop: 'edm', tags: ['neon', 'rainbow', 'warm', 'white'], motions: ['fan', 'converge', 'lift', 'ballyhoo', 'fanpump', 'audience'], rhythms: ['kick', 'stack', 'riser', 'alternate', 'offbeat'], rotate: 8 },
  { id: 'chill', name: 'Chill', bpm: [60, 116], drop: 'chill', tags: ['chill', 'pastel', 'cold', 'warm'], motions: ['still', 'sky', 'searchlight', 'arc', 'fig8', 'helix', 'sweep'], rhythms: ['hold', 'breathe', 'wave', 'heartbeat', 'chase'], rotate: 16 },
];
export const genreById = (id: string) => GENRES.find((g) => g.id === id);

export interface Show {
  id: string; name: string; genre: string; drop: DropStyle;
  palettes: string[];
  sections: Record<Section, string[]>;
  /** show-pack looks per section: their own pool, played on some phrases (festivalDirector pickLook) - kept out of
   *  `sections` so every phrase that plays the show's own looks picks exactly what it did before the pack */
  pack?: Partial<Record<Section, string[]>>;
  rotate: number;
  /** room cues fired on drops / phrase starts (scene.json festival.cues) */
  dropCue?: string; phraseCue?: string;
  /** a room's own show (scene.json festival.shows): 'auto' prefers it for its genre */
  room?: boolean;
  /** colour roles per fixture class (shared/festivalRoles.ts): every look of the show plays the show's palettes, beams /
   *  lasers / blinders / the crowd / the structure take their own colours */
  roles?: ColorRoles;
  /** a house show (the generic mainstage look): never in 'auto''s family rotation - a room opts in (festival.house) */
  house?: boolean;
  /** share of phrases that play the pack pool (a room's packShare; unset = festivalDirector PACK_SHARE) */
  packShare?: number;
}

/** Palette families per genre: 4 families of 3 palettes, drawn by tag affinity (deterministic). */
function familiesFor(g: Genre, pals: Palette[]): Palette[][] {
  // the genre's first tags weigh most (hardstyle leads with fire, techno with mono / white …), a little seeded variety
  const w = (t: string) => { const i = g.tags.indexOf(t); return i < 0 ? 0 : 1.6 - 0.25 * i; };
  const ranked = pals.map((p) => ({ p, s: p.tags.reduce((a, t) => a + w(t), 0) + hash3(hashStr(g.id), hashStr(p.id)) * 0.45 }))
    .filter((x) => x.s >= 1).sort((a, b) => b.s - a.s);
  const fams: Palette[][] = [];
  const used = new Set<string>();
  for (const { p } of ranked) {
    if (used.has(p.id) || fams.length >= 4) continue;
    // a family: the lead + two neighbours sharing a tag
    const fam = [p];
    used.add(p.id);
    for (const { p: q } of ranked) {
      if (fam.length >= 3) break;
      if (used.has(q.id) && fams.length < 3) continue;
      if (q.id !== p.id && !fam.includes(q) && q.tags.some((t) => p.tags.includes(t))) { fam.push(q); used.add(q.id); }
    }
    fams.push(fam);
  }
  return fams;
}

function sectionPick(g: Genre, looks: Look[], fam: string[], sec: Section, n: number, salt: number): string[] {
  // (chill shows have no peak looks: their "drop" is the chorus, played by the mid looks)
  const fits = (l: Look) => (g.drop === 'chill' && sec === 'drop' ? l.cls === 'mid' : l.sections.includes(sec));
  const want = (l: Look) => fits(l) && fam.includes(l.palette)
    && !(sec === 'build' && l.cls === 'peak' && l.rhythm !== 'riser' && l.rhythm !== 'stack' && l.rhythm !== 'sixteenth')
    && !(g.drop === 'chill' && l.cls === 'peak');
  const score = (l: Look) => (g.motions.includes(l.motion) ? 0.6 : 0) + (g.rhythms.includes(l.rhythm) ? 0.5 : 0) + l.score * 0.4 + hash3(salt, hashStr(l.id)) * 0.5
    + (sec === 'build' && (l.rhythm === 'riser' || l.rhythm === 'stack' || l.motion === 'lift' || l.motion === 'converge') ? 0.6 : 0);
  let pool = looks.filter(want);
  if (pool.length < 2) pool = looks.filter((l) => fits(l) && (g.drop !== 'chill' || l.cls !== 'peak'));   // a thin family borrows from everyone
  return pool.sort((a, b) => score(b) - score(a) || (a.id < b.id ? -1 : 1)).slice(0, n).map((l) => l.id);
}

/** Every show: GENRES × 4 palette families (+ the room's own shows from scene.json). */
export function generateShows(looks: Look[], roomPalettes: Palette[] = [], roomShows: { id: string; name: string; genre: string; palettes: string[]; dropCue?: string; phraseCue?: string; roles?: ColorRoles }[] = []): Show[] {
  const pals = [...PALETTES, ...roomPalettes];
  const out: Show[] = [];
  for (const g of GENRES) {
    familiesFor(g, PALETTES).forEach((fam, fi) => {
      const ids = fam.map((p) => p.id);
      const salt = hashStr(`${g.id}${fi}`);
      out.push({ id: `${g.id}_${fam[0].id}`, name: `${g.name} · ${fam[0].name}`, genre: g.id, drop: g.drop, palettes: ids, rotate: g.rotate,
        sections: Object.fromEntries((['intro', 'groove', 'build', 'drop', 'breakdown', 'outro'] as Section[]).map((s) => [s, sectionPick(g, looks, ids, s, s === 'drop' ? 8 : 5, salt)])) as Record<Section, string[]> });
    });
  }
  for (const rs of roomShows) {
    const g = genreById(rs.genre) ?? GENRES[0];
    const ids = rs.palettes.filter((id) => pals.some((p) => p.id === id));
    if (!ids.length) continue;
    const salt = hashStr(rs.id);
    out.push({ id: rs.id, name: rs.name, genre: g.id, drop: g.drop, palettes: ids, rotate: g.rotate, room: true, ...(rs.dropCue ? { dropCue: rs.dropCue } : {}), ...(rs.phraseCue ? { phraseCue: rs.phraseCue } : {}), ...(rs.roles ? { roles: rs.roles } : {}),
      sections: Object.fromEntries((['intro', 'groove', 'build', 'drop', 'breakdown', 'outro'] as Section[]).map((s) => [s, sectionPick(g, looks, ids, s, s === 'drop' ? 8 : 5, salt)])) as Record<Section, string[]> });
  }
  return out;
}

/** The house shows (the generic mainstage look, shared/festivalRoles.ts): per hard-dance genre, the genre's first family's
 *  looks played in the house palette with colour roles - a red / amber / gold set, white beams, green lasers, warm
 *  blinders and a violet (or magenta) crowd. Appended after every other show (no generated show changes). */
export const HOUSE_GENRES = ['hardstyle', 'rawstyle', 'hardcore'] as const;
export const HOUSE_STYLES: { id: string; name: string; roles: ColorRoles }[] = [{ id: 'mainstage', name: 'Mainstage', roles: MAINSTAGE_ROLES }, { id: 'mainstage_magenta', name: 'Mainstage Magenta', roles: MAINSTAGE_MAGENTA_ROLES }];
export function houseShows(shows: Show[]): Show[] {
  const out: Show[] = [];
  for (const g of HOUSE_GENRES) {
    const base = shows.find((s) => s.genre === g && !s.room && !s.house);
    const gen = genreById(g);
    if (!base || !gen) continue;
    for (const h of HOUSE_STYLES) out.push({ id: `${g}_${h.id}`, name: `${gen.name} · ${h.name}`, genre: g, drop: base.drop, palettes: HOUSE_PALETTES.map((p) => p.id), rotate: base.rotate,
      sections: Object.fromEntries(Object.entries(base.sections).map(([k, v]) => [k, [...v]])) as Record<Section, string[]>, roles: h.roles, house: true });
  }
  return out;
}

/** 'auto': the genre for a tempo (hardstyle 145–165, hardcore ≥ 170 unless it is drum & bass-ish 168–180 with a
 *  half-time feel, chill < 100 …), then a family that changes every few drops. */
export function genreForBpm(bpm: number): string {
  if (!(bpm > 0)) return 'hardstyle';
  if (bpm < 100) return 'chill';
  if (bpm < 124) return 'house';
  if (bpm < 132) return 'bigroom';
  if (bpm < 143) return 'trance';
  if (bpm < 166) return 'hardstyle';
  if (bpm < 181) return 'hardcore';
  return 'hardcore';
}

/** The whole catalogue for a room: looks (+ room palettes), shows (+ room shows), indexes. Cached per config key. */
export interface Catalogue { looks: Look[]; byId: Map<string, Look>; shows: Show[]; showById: Map<string, Show>; palettes: Map<string, Palette>; baseCount: number; /** show-pack looks: the LAST packCount looks (after the base list and the room's own) */ packCount: number }
const CACHE = new Map<string, Catalogue>();
export function catalogue(room: { palettes?: { id: string; name: string; colors: string[]; tags?: string[] }[]; shows?: { id: string; name: string; genre: string; palettes: string[]; dropCue?: string; phraseCue?: string; roles?: ColorRoles }[]; packPool?: 'show' | 'full'; packShare?: number } | null = null): Catalogue {
  const key = JSON.stringify(room ? [room.palettes ?? [], room.shows ?? [], room.packPool ?? 'show', room.packShare ?? null] : null);
  const hit = CACHE.get(key);
  if (hit) return hit;
  const rp: Palette[] = (room?.palettes ?? []).map((p) => ({ id: p.id, name: p.name, colors: p.colors, tags: p.tags ?? ['neon'] }));
  const base = generateLooks(1);
  const extra = rp.length ? generateLooks(1, rp).slice(base.length) : [];
  // the show pack (shared/showPack): ~1,700 programs at the END (after the shipped looks and the room's own: every index
  // a LOOKS_VERSION 1 curation saved before the pack stays put); every show (and the room's) gets a pack pool per
  // section, played in the show's palettes
  const pack = packLooks(PALETTES);
  const looks = [...base, ...extra, ...pack];
  const shows = generateShows([...base, ...extra], rp, room?.shows ?? []);
  // (the house shows after every generated / room show: auto's rotation, the show ids and the pack pools of every other
  //  show stay as they were - addPackToShows salts each show's pool with its own id)
  shows.push(...houseShows(shows).filter((h) => !shows.some((s) => s.id === h.id)));
  addPackToShows(shows, pack, room?.packPool === 'full' ? { share: room.packShare } : undefined);
  const c: Catalogue = { looks, byId: new Map(looks.map((l) => [l.id, l])), shows, showById: new Map(shows.map((s) => [s.id, s])), palettes: new Map([...PALETTES, ...HOUSE_PALETTES.filter((h) => !rp.some((p) => p.id === h.id)), ...rp].map((p) => [p.id, p])), baseCount: base.length, packCount: pack.length };
  CACHE.set(key, c);
  if (CACHE.size > 8) CACHE.delete(CACHE.keys().next().value as string);
  return c;
}
