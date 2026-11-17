// Show pack: the GRAMMAR that builds the catalogue - ~1,500 distinct programs from seven families, deterministic (the
// same list on every page, every run: curation bitmasks index it), deduplicated and filtered for looks that read badly.
//
//   grammar    formation (54) × rhythm target × motion, a strided sample per formation (+ a laser formation, a wall,
//              a spatial shape, a colour mode and cues that fit)
//   score      route (16 formations) × verb (13: Breath, Glints, Ascent, Chase, Impact, Counterfire, Veil, Tides, Lift,
//              Pursuit, Detonation, Exchange, SnareBloom)
//   build      geometry (Funnel, Pillars, Pinch, Rise, Vortex, Zigzag) × roll (Banks, Chase, Fill, PingPong, Scatter)
//              × wall (Bars, Meter, Rain, Zoom) × Hot
//   drop       form (Burst, Crossfire, Pillars, Snap, Vee, Wall) × hit (Accent, Double, Gate, Slam, Split) × wall (Flash,
//              Halves, Shock, Slabs) × tempo (Half, Double) × Wide
//   groove     motion (BankWave, BarFan, Box, Eight, Mirror, Nod, Orbit, Sway) × pulse (Bounce, Four, Off, Pump,
//              Shuffle) × chase (Centre, Loop, Split, Steps) × wall (Blocks, Check, EQ, Scan, Stripes) × tempo
//   slow       motion (Bath, Ceiling, Drift, Halo, Liquid, Search, SkyTilt) × breath (Breath, Glow, Ripple, Swell,
//              Tide) × wall (Aurora, Gradient, Horizon, Nebula, Stars, Sunrise)
//   signature  hand-written named looks (Laser Cathedral, Scissor Lasers, Lightning Strikes, Liquid Sky, …)
//
// Dedupe: two programs that agree on 6 of the 7 axes that decide what the picture looks like (beam formation, laser
// formation, rhythm target, motion, spatial shape, wall pattern, the lasers' rhythm) are "near-identical"; the lower-scored one is dropped
// (so every program differs from every other in at least two visible ways - colour alone never counts). Rules reject
// combinations that read badly (snapping heads with a slow breath, a calm formation on 16ths, …).
import { hashStr, hash3 } from '../festival.ts';
import { BEAM_FORMS, BEAM_FORM_DEFS, LASER_FORM_DEFS, beamFormById, laserFormById, type BeamForm, type LaserForm } from './forms.ts';
import { MOTIONS_PACK, TARGETS, targetById, type Motion, type PackSection, type Target } from './rhythm.ts';
import { isFlashy, type BlinderPat, type ColourMode, type EnergyCls, type Family, type Program, type SfxPat, type Shape, type SpreadMode, type StrobePat } from './program.ts';
import { PACK_WALL_NAMES, isPackWall } from './walls.ts';

export const PACK_VERSION = 1;
export interface PalLike { id: string; name: string; colors: string[]; tags: string[] }

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const wallWord = (w: string) => (isPackWall(w) ? PACK_WALL_NAMES[w] : cap(w));
const shortId = (s: string) => hashStr(s).toString(36).padStart(7, '0').slice(-7);
const FAST_T = new Set<Target>(['sixteenths', 'gallop', 'triplets', 'hat', 'eighths', 'shuffle']);
const SLOW_T = new Set<Target>(['phrase', 'bar', 'hold']);
const SNAPPY = new Set<BeamForm>(BEAM_FORM_DEFS.filter((f) => f.snaps).map((f) => f.id));
const CALM_F = new Set<BeamForm>(BEAM_FORM_DEFS.filter((f) => f.calm).map((f) => f.id));
const CALM_L = new Set<LaserForm>(LASER_FORM_DEFS.filter((f) => f.calm).map((f) => f.id));

export interface Verdict { ok: boolean; why: string }
/** The rules every program passes (tested in tools/showpack_unit.ts). */
export function packRules(p: Program): Verdict {
  const t = p.level.target, m = p.level.motion;
  if (CALM_F.has(p.beam.form) && FAST_T.has(t) && p.cls !== 'peak') return { ok: false, why: 'a calm formation on a fast target' };
  if (SNAPPY.has(p.beam.form) && (m === 'drift' || m === 'swell') && p.family !== 'build') return { ok: false, why: 'snapping heads with a slow motion' };
  if ((t === 'sixteenths' || t === 'gallop') && m === 'drift') return { ok: false, why: 'a fast target drifting (reads as nothing)' };
  if (p.cls === 'chill' && (p.strobe !== 'none' || p.sfx !== 'none' || p.blinder === 'downbeat' || p.blinder === 'call')) return { ok: false, why: 'strobes / pyro in a chill look' };
  if (p.cls === 'chill' && FAST_T.has(t) && (m === 'hit' || m === 'saw' || m === 'gate')) return { ok: false, why: 'hard fast hits in a chill look' };
  if (p.laser && (p.laser.form === 'burst' || p.laser.form === 'scan') && CALM_F.has(p.beam.form) && p.cls !== 'peak') return { ok: false, why: 'frantic lasers over a calm formation' };
  if (p.laser && CALM_L.has(p.laser.form) && p.cls === 'peak' && p.family === 'grammar' && FAST_T.has(p.laser.target)) return { ok: false, why: 'a slow laser sheet on fast hits' };
  const hits = (p.strobe !== 'none' && p.strobe !== 'bar' ? 1 : 0) + (FAST_T.has(t) && (m === 'hit' || m === 'saw' || m === 'gate') ? 1 : 0) + (p.laser && FAST_T.has(p.laser.target) && p.laser.motion === 'hit' ? 1 : 0) + (p.blinder === 'downbeat' || p.blinder === 'call' ? 1 : 0);
  if (hits > 2) return { ok: false, why: 'more than 2 hit layers' };
  if (p.laser && (t === 'sixteenths' || t === 'gallop') && (p.laser.target === 'sixteenths' || p.laser.target === 'gallop')) return { ok: false, why: 'beams and lasers both on 16ths' };
  if (p.cls === 'peak' && p.energy < 0.5) return { ok: false, why: 'drop look too calm' };
  if (p.cls === 'chill' && p.energy > 0.6) return { ok: false, why: 'chill look too busy' };
  return { ok: true, why: '' };
}

// ---------------------------------------------------------------------------------------------------- helpers
function energyOf(form: BeamForm, t: Target, laser: LaserForm | null, strobe: StrobePat, sfx: SfxPat): number {
  const fe = beamFormById(form)?.energy ?? 0.5, te = targetById(t)?.energy ?? 0.5, le = laser ? laserFormById(laser)?.energy ?? 0.5 : 0.2;
  const acc = (strobe === 'none' ? 0 : strobe === 'bar' || strobe === 'snare' ? 0.5 : 1) * 0.6 + (sfx === 'none' ? 0 : 0.4);
  return Math.min(1, 0.32 * fe + 0.38 * te + 0.16 * le + 0.14 * acc + 0.04);
}
function sectionsOf(cls: EnergyCls, t: Target, m: Motion, family: Family): PackSection[] {
  if (family === 'build') return ['build'];
  if (family === 'slow') return ['intro', 'breakdown', 'outro'];
  if (family === 'drop') return ['drop'];
  if (cls === 'chill') return ['intro', 'breakdown', 'outro'];
  if (cls === 'peak') return m === 'swell' || m === 'wipe' ? ['drop', 'build'] : ['drop'];
  const s: PackSection[] = ['groove'];
  if (m === 'swell' || m === 'wipe' || t === 'sixteenths') s.push('build');
  if (SLOW_T.has(t) || m === 'drift') s.push('intro', 'outro');
  return s;
}
/** genre fit from the atoms (festival genre ids) */
function genresOf(p: Omit<Program, 'genres'>): string[] {
  const t = p.level.target, f = p.beam.form, l = p.laser?.form ?? '', W = p.wall, peak = p.cls === 'peak', chill = p.cls === 'chill';
  const sc: Record<string, number> = { hardstyle: 0, rawstyle: 0, hardcore: 0, house: 0, techno: 0, trance: 0, dubstep: 0, dnb: 0, bigroom: 0, chill: 0 };
  if (chill) sc.chill += 3;
  if (['four', 'gallop', 'split', 'offbeat'].includes(t)) { sc.hardstyle += peak ? 2 : 1; sc.bigroom += 1; }
  if (t === 'gallop' || p.strobe === 'storm' || p.strobe === 'lightning') { sc.rawstyle += 2; sc.hardstyle += 1; }
  if (['sixteenths', 'eighths'].includes(t) || p.strobe === 'storm') { sc.hardcore += peak ? 2 : 1; sc.techno += 1; }
  if (['offbeat', 'shuffle'].includes(t) || p.level.motion === 'pump') { sc.house += 2; }
  if (['grid', 'pillars', 'cathedral', 'comb', 'steps', 'snap', 'box', 'nod'].includes(f) || ['pk_matrix', 'pk_check', 'pk_blocks', 'scanner', 'grid'].includes(W) || p.colour === 'mono' || p.colour === 'white') sc.techno += 2;
  if (['fan', 'lift', 'vault', 'wings', 'ribbon', 'sail', 'halo', 'iris', 'skytilt', 'crown', 'vee', 'helix'].includes(f) || ['sheet', 'liquid', 'dome', 'ribbon', 'wall'].includes(l) || p.level.motion === 'swell') sc.trance += 2;
  if (['halfbar', 'snare', 'triplets'].includes(t) || ['pk_shock', 'pk_slabs'].includes(W)) sc.dubstep += 2;
  if (['snare', 'dotted', 'eighths'].includes(t) || ['wave', 'crosswind', 'corkscrew'].includes(f)) sc.dnb += 1.5;
  if (['fan', 'converge', 'lift', 'starburst', 'vee', 'barfan'].includes(f) || p.colour === 'rainbow') sc.bigroom += 1.5;
  if (p.sfx === 'kick' || p.sfx === 'call' || p.sfx === 'wave' || p.sfx === 'chase') { sc.hardstyle += 1.5; sc.rawstyle += 1; }
  if (!peak && !chill) { sc.house += 0.5; sc.trance += 0.5; sc.techno += 0.5; }
  const best = Math.max(...Object.values(sc));
  const out = Object.entries(sc).filter(([, v]) => v >= Math.max(1, best * 0.6)).map(([k]) => k);
  return out.length ? out : [chill ? 'chill' : peak ? 'hardstyle' : 'house'];
}
function pickPalette(pals: PalLike[], cls: EnergyCls, salt: number, prefer: string[] = []): string {
  const want = prefer.length ? prefer : cls === 'chill' ? ['chill', 'cold', 'pastel', 'warm'] : cls === 'peak' ? ['hard', 'fire', 'neon', 'acid', 'uv'] : ['neon', 'cold', 'warm', 'uv', 'rainbow'];
  const pool = pals.filter((p) => p.tags.some((t) => want.includes(t)) && !(cls === 'peak' && p.tags.includes('pastel')));
  const list = pool.length ? pool : pals;
  return list[Math.floor(hash3(salt, 31, 7) * list.length) % list.length].id;
}
const LASER_FOR: Partial<Record<BeamForm, LaserForm[]>> = {
  fan: ['fan', 'sheet', 'split'], tunnel: ['tunnel', 'cone', 'vortex'], cross: ['cross', 'scissor'], counter: ['split', 'scissor', 'zigzag'], converge: ['cone', 'iris', 'tunnel'],
  mirror: ['split', 'fan', 'chevron'], orbit: ['cone', 'helix', 'diamond'], spiral: ['vortex', 'helix', 'star'], wave: ['ribbon', 'helix', 'sheet'], grid: ['grid', 'stack', 'comb'],
  starburst: ['star', 'burst'], pendulum: ['scan', 'fan', 'wall'], lift: ['wall', 'stack', 'sheet'], chevron: ['chevron', 'split'], diamond: ['diamond', 'cross'], helix: ['helix', 'ribbon'],
  iris: ['iris', 'cone'], ribbon: ['ribbon', 'liquid'], sail: ['split', 'sheet'], steps: ['stack', 'zigzag'], vault: ['dome', 'cathedral'], wings: ['fan', 'split', 'chevron'],
  terraces: ['stack', 'sheet'], corkscrew: ['vortex', 'helix'], crosswind: ['scissor', 'scan'], orbitals: ['cone', 'diamond'], ballyhoo: ['burst', 'scan', 'star'],
  cathedral: ['cathedral', 'wall'], scissor: ['scissor', 'cross'], searchlight: ['crown', 'dome', 'scan'], crown: ['crown', 'dome'], comb: ['comb', 'scan', 'wall'],
  rain: ['comb', 'zigzag'], zigzag: ['zigzag', 'stack'], flower: ['star', 'diamond'], pillars: ['cathedral', 'crown'], vee: ['chevron', 'fan'], snap: ['star', 'burst', 'grid'],
  funnel: ['vortex', 'iris', 'cone'], rise: ['stack', 'wall'], vortex: ['vortex', 'tunnel'], pinch: ['scissor', 'cone'], barfan: ['fan', 'split'], nod: ['fan', 'chevron'],
  sway: ['sheet', 'ribbon'], box: ['grid', 'diamond'], eight: ['helix', 'ribbon'], bankwave: ['ribbon', 'sheet'], drift: ['liquid', 'sheet'], liquid: ['liquid', 'ribbon'],
  skytilt: ['wall', 'sheet', 'cathedral'], bath: ['liquid', 'dome'], ceiling: ['dome', 'crown'], halo: ['dome', 'iris', 'crown'],
};
const ALL_WALLS_MID = ['pk_bars', 'pk_zoom', 'pk_blocks', 'pk_check', 'pk_eq', 'pk_stripes', 'pk_ripple', 'pk_matrix', 'tunnel', 'kaleido', 'spectrum', 'warp', 'grid', 'rings', 'scanner'];
const ALL_WALLS_PEAK = ['pk_flash', 'pk_shock', 'pk_halves', 'pk_slabs', 'pk_zoom', 'pk_bars', 'tunnel', 'warp', 'fire', 'grid', 'rings', 'spectrum'];
const ALL_WALLS_CHILL = ['pk_aurora', 'pk_gradient', 'pk_horizon', 'pk_nebula', 'pk_sunrise', 'pk_stars', 'plasma', 'starfield', 'kaleido'];
const GRAMMAR_SHAPES: Shape[] = ['none', 'breath', 'chase', 'loop', 'centre', 'halves', 'steps', 'glints', 'tide', 'ripple', 'pingpong', 'kickpump'];
const SPREADS: SpreadMode[] = ['unison', 'leftright', 'wings', 'centerout', 'bottomtop', 'random', 'blocks2', 'blocks4', 'oddeven', 'radial'];
const COLOURS: ColourMode[] = ['spread', 'split', 'alt', 'sweep', 'exchange', 'mono', 'spread', 'split', 'rainbow', 'white'];
const T_GRAMMAR: Target[] = ['four', 'offbeat', 'eighths', 'sixteenths', 'triplets', 'dotted', 'call', 'bar', 'phrase', 'snare', 'hat', 'halfbar', 'gallop', 'shuffle', 'split'];
const M_GRAMMAR: Motion[] = ['hit', 'swell', 'saw', 'pulse', 'sparkle', 'drift', 'wipe', 'pump', 'gate'];

interface Cand extends Omit<Program, 'genres' | 'sections' | 'energy' | 'flashy' | 'score' | 'id' | 'name'> { key: string; name: string; score: number; energy?: number; cls: EnergyCls; sections?: PackSection[]; genres?: string[] }

function finish(c: Cand): Program {
  const energy = c.energy ?? Math.round(energyOf(c.beam.form, c.level.target, c.laser?.form ?? null, c.strobe, c.sfx) * 1000) / 1000;
  const base = { ...c, id: shortId(c.key), energy, sections: c.sections ?? sectionsOf(c.cls, c.level.target, c.level.motion, c.family), flashy: isFlashy(c) } as Omit<Program, 'genres'> & { key?: string };
  delete base.key;
  return { ...base, genres: c.genres ?? genresOf(base) } as Program;
}
const coreKey = (p: Program) => [p.beam.form, p.laser?.form ?? '-', p.level.target, p.level.motion, p.level.shape, p.wall, p.laser ? `${p.laser.target}/${p.laser.motion}` : '-'];

// ---------------------------------------------------------------------------------------------------- families
function grammar(pals: PalLike[]): Cand[] {
  const out: Cand[] = [];
  BEAM_FORMS.forEach((form, g) => {
    const fd = beamFormById(form)!;
    for (let k = 0; k < 18; k++) {
      const h = (s: number) => hash3(g * 131 + k, s, 17);
      let t = T_GRAMMAR[(g + k) % T_GRAMMAR.length];
      let m = M_GRAMMAR[(3 * g + 2 * k) % M_GRAMMAR.length];
      if (fd.calm && FAST_T.has(t)) t = (['bar', 'phrase', 'four', 'halfbar'] as Target[])[k % 4];
      if (t === 'phrase' && (m === 'hit' || m === 'gate')) m = 'swell';
      const lf = LASER_FOR[form] ?? ['fan'];
      const laser = lf[(k + g) % lf.length];
      const e0 = energyOf(form, t, laser, 'none', 'none');
      const cls: EnergyCls = e0 >= 0.62 ? 'peak' : e0 >= 0.4 ? 'mid' : 'chill';
      const walls = cls === 'peak' ? ALL_WALLS_PEAK : cls === 'mid' ? ALL_WALLS_MID : ALL_WALLS_CHILL;
      const wall = walls[(g + 3 * k) % walls.length];
      const shape = GRAMMAR_SHAPES[(2 * g + k) % GRAMMAR_SHAPES.length];
      const strobe: StrobePat = cls === 'peak' ? (['none', 'snare', 'bar', 'beat', 'none', 'offbeat', 'kick'] as StrobePat[])[(2 * g + k) % 7] : cls === 'mid' && k % 5 === 0 ? 'bar' : 'none';
      const sfx: SfxPat = cls === 'peak' ? (['none', 'kick', 'call', 'bar', 'none', 'chase', 'centre', 'wave'] as SfxPat[])[(g + 2 * k) % 8] : 'none';
      const blinder: BlinderPat = cls === 'peak' ? (['drop', 'bar4', 'drop', 'call', 'downbeat'] as BlinderPat[])[(g + k) % 5] : 'off';
      const lt: Target = cls === 'chill' ? 'phrase' : (['four', 'offbeat', 'bar', 'eighths', 'halfbar', 'dotted'] as Target[])[(g * 2 + k) % 6];
      const lm: Motion = cls === 'chill' ? 'drift' : (['pulse', 'hit', 'swell', 'saw', 'wipe'] as Motion[])[(g + k * 3) % 5];
      const wt: Target = t === 'sixteenths' || t === 'gallop' ? 'four' : t;
      out.push({ key: `g|${form}|${t}|${m}|${laser}|${wall}|${shape}|${k}`, name: `${fd.word} ${targetById(t)!.word} ${MOTIONS_PACK.find((x) => x.id === m)!.word}`, family: 'grammar', sub: `${fd.name} · ${targetById(t)!.name} · ${m}`,
        cls, palette: pickPalette(pals, cls, g * 977 + k), beam: { form, rate: fd.rate, amp: 1 }, level: { target: t, motion: m, shape, spread: SPREADS[(g + 7 * k) % SPREADS.length] },
        wash: { target: wt, motion: m === 'sparkle' ? 'hit' : m, shape: shape === 'kickpump' ? 'none' : shape }, laser: { form: laser, target: lt, motion: lm, rate: 1 },
        strobe, blinder, sfx, wall, colour: COLOURS[(g * 3 + k) % COLOURS.length], tempo: 1, tags: ['grammar', form, t, m], score: 0.5 + 0.3 * h(1) + (fd.energy > 0.6 && cls === 'peak' ? 0.1 : 0) });
    }
  });
  return out;
}

const ROUTES: BeamForm[] = ['vault', 'helix', 'sail', 'iris', 'chevron', 'orbitals', 'ribbon', 'diamond', 'steps', 'wings', 'corkscrew', 'crosswind', 'terraces', 'flower', 'crown', 'comb'];
const ROUTE_LASER: Record<string, LaserForm> = { vault: 'dome', helix: 'helix', sail: 'split', iris: 'iris', chevron: 'chevron', orbitals: 'cone', ribbon: 'ribbon', diamond: 'diamond', steps: 'stack', wings: 'fan', corkscrew: 'vortex', crosswind: 'scissor', terraces: 'stack', flower: 'star', crown: 'crown', comb: 'comb' };
interface VerbDef { id: string; word: string; shape: Shape; target: Target; motion: Motion; cls: EnergyCls; tempo: number; laser?: LaserForm; colour?: ColourMode; wall: string[]; strobe: StrobePat }
const VERBS: VerbDef[] = [
  { id: 'breath', word: 'Breath', shape: 'breath', target: 'phrase', motion: 'drift', cls: 'chill', tempo: 0.5, wall: ['pk_gradient', 'pk_aurora'], strobe: 'none' },
  { id: 'glints', word: 'Glints', shape: 'glints', target: 'hat', motion: 'sparkle', cls: 'chill', tempo: 0.5, wall: ['pk_stars', 'starfield'], strobe: 'none' },
  { id: 'ascent', word: 'Ascent', shape: 'ascent', target: 'bar', motion: 'swell', cls: 'mid', tempo: 1, wall: ['pk_meter', 'pk_sunrise'], strobe: 'none' },
  { id: 'chase', word: 'Chase', shape: 'chase', target: 'eighths', motion: 'wipe', cls: 'mid', tempo: 1, wall: ['pk_blocks', 'bars'], strobe: 'none' },
  { id: 'impact', word: 'Impact', shape: 'impact', target: 'four', motion: 'hit', cls: 'peak', tempo: 1, wall: ['pk_flash', 'pk_shock'], strobe: 'beat' },
  { id: 'counterfire', word: 'Counterfire', shape: 'counterfire', target: 'split', motion: 'pulse', cls: 'peak', tempo: 1, wall: ['pk_halves', 'pk_check'], strobe: 'snare' },
  { id: 'veil', word: 'Veil', shape: 'veil', target: 'phrase', motion: 'drift', cls: 'chill', tempo: 0.5, laser: 'sheet', wall: ['pk_nebula', 'pk_aurora'], strobe: 'none' },
  { id: 'tides', word: 'Tides', shape: 'tides', target: 'bar', motion: 'pulse', cls: 'chill', tempo: 0.5, laser: 'liquid', wall: ['pk_horizon', 'plasma'], strobe: 'none' },
  { id: 'lift', word: 'Lift', shape: 'lift', target: 'halfbar', motion: 'swell', cls: 'mid', tempo: 1, laser: 'wall', wall: ['pk_meter', 'pk_zoom'], strobe: 'none' },
  { id: 'pursuit', word: 'Pursuit', shape: 'pursuit', target: 'eighths', motion: 'wipe', cls: 'mid', tempo: 1, laser: 'ribbon', wall: ['pk_stripes', 'scanner'], strobe: 'bar' },
  { id: 'detonation', word: 'Detonation', shape: 'detonation', target: 'four', motion: 'hit', cls: 'peak', tempo: 1, laser: 'star', wall: ['pk_shock', 'pk_ripple'], strobe: 'kick' },
  { id: 'exchange', word: 'Exchange', shape: 'exchange', target: 'four', motion: 'pulse', cls: 'peak', tempo: 1, colour: 'exchange', laser: 'split', wall: ['pk_halves', 'pk_slabs'], strobe: 'snare' },
  { id: 'snarebloom', word: 'Snare Bloom', shape: 'snarebloom', target: 'snare', motion: 'pulse', cls: 'peak', tempo: 1, laser: 'sheet', wall: ['pk_shock', 'rings'], strobe: 'snare' },
];
function scores(pals: PalLike[]): Cand[] {
  const out: Cand[] = [];
  ROUTES.forEach((route, ri) => VERBS.forEach((v, vi) => {
    const fd = beamFormById(route)!;
    const laser = ROUTE_LASER[route];
    const wall = v.wall[(ri + vi) % v.wall.length];
    out.push({ key: `s|${route}|${v.id}`, name: `${fd.word} ${v.word}`, family: 'score', sub: `${fd.name} · ${v.word}`, cls: v.cls, palette: pickPalette(pals, v.cls, ri * 31 + vi),
      beam: { form: route, rate: fd.rate / Math.max(0.5, v.tempo), amp: 0.9 + 0.02 * ri }, level: { target: v.target, motion: v.motion, shape: v.shape, spread: SPREADS[(ri + vi) % SPREADS.length] },
      wash: { target: v.target === 'eighths' ? 'four' : v.target, motion: v.motion === 'sparkle' ? 'pulse' : v.motion, shape: v.shape },
      laser: { form: v.laser && ri % 4 === 3 ? v.laser : laser, target: v.cls === 'chill' ? 'phrase' : v.target === 'split' ? 'four' : v.target, motion: v.cls === 'chill' ? 'drift' : v.motion === 'wipe' ? 'wipe' : 'pulse', rate: v.tempo },
      strobe: v.strobe, blinder: v.cls === 'peak' ? (vi % 2 ? 'drop' : 'bar4') : 'off', sfx: v.cls === 'peak' ? (['kick', 'centre', 'call', 'wave'] as SfxPat[])[(ri + vi) % 4] : 'none',
      wall, colour: v.colour ?? COLOURS[(ri * 5 + vi) % COLOURS.length], tempo: v.tempo, tags: ['score', route, v.id], score: 0.6 + 0.2 * hash3(ri, vi, 5) });
  }));
  return out;
}

const BUILD_GEO: [string, BeamForm, LaserForm[]][] = [['Funnel', 'funnel', ['vortex', 'iris']], ['Pillars', 'pillars', ['cathedral', 'stack']], ['Pinch', 'pinch', ['scissor', 'cone']], ['Rise', 'rise', ['stack', 'wall']], ['Vortex', 'vortex', ['vortex', 'tunnel']], ['Zigzag', 'zigzag', ['zigzag', 'stack']]];
const BUILD_ROLL: [string, Shape, Target, Motion][] = [['Banks', 'banks', 'four', 'pulse'], ['Chase', 'chase', 'eighths', 'wipe'], ['Fill', 'fill', 'four', 'swell'], ['PingPong', 'pingpong', 'eighths', 'pulse'], ['Scatter', 'scatter', 'sixteenths', 'sparkle']];
const BUILD_WALL = ['pk_bars', 'pk_meter', 'pk_rain', 'pk_zoom'];
const BUILD_LASER: LaserForm[] = ['vortex', 'iris', 'tunnel', 'cone', 'stack', 'zigzag', 'wall', 'scissor'];
function builds(pals: PalLike[]): Cand[] {
  const out: Cand[] = [];
  BUILD_GEO.forEach(([gw, form, lfs], g) => BUILD_ROLL.forEach(([rw, shape, t, m], r) => BUILD_WALL.forEach((wall, w) => [false, true].forEach((hot) => {
    const laser = w === 0 ? lfs[(r + (hot ? 1 : 0)) % lfs.length] : BUILD_LASER[(g * 3 + w + (hot ? 4 : 0)) % BUILD_LASER.length];
    const cls: EnergyCls = hot ? 'peak' : 'mid';
    out.push({ key: `b|${form}|${shape}|${wall}|${hot}`, name: `Build ${gw} ${rw} ${wallWord(wall)}${hot ? ' Hot' : ''}`, family: 'build', sub: `${gw} · ${rw} · ${wallWord(wall)}${hot ? ' · Hot' : ''}`, cls,
      energy: hot ? 0.78 : 0.6, sections: ['build'], palette: pickPalette(pals, cls, g * 97 + r * 13 + w * 3 + (hot ? 1 : 0), hot ? ['white', 'cold', 'neon', 'hard'] : ['neon', 'cold', 'uv']),
      beam: { form, rate: beamFormById(form)!.rate, amp: 1 }, level: { target: t, motion: hot && m !== 'sparkle' ? 'hit' : m, shape, spread: SPREADS[(g + r + w) % SPREADS.length] }, wash: { target: t === 'sixteenths' ? 'eighths' : t, motion: m === 'sparkle' ? 'pulse' : m, shape },
      laser: { form: laser, target: hot ? 'eighths' : 'four', motion: hot ? 'wipe' : 'pulse', rate: 1 }, strobe: hot ? 'roll' : 'none', blinder: 'off', sfx: hot ? 'co2build' : 'none', wall,
      colour: hot ? 'white' : COLOURS[(g + r * 2 + w) % COLOURS.length], tempo: 1, hot, tags: ['build', gw.toLowerCase(), rw.toLowerCase(), hot ? 'hot' : ''], score: 0.6 + 0.2 * hash3(g, r * 7 + w, hot ? 3 : 2) });
  }))));
  // (a build with a stacked-tier laser is the Hot one: Hot always differs from its plain twin in laser + strobe + colour)
  return out;
}

const DROP_FORM: [string, BeamForm, LaserForm[]][] = [['Burst', 'starburst', ['star', 'burst']], ['Crossfire', 'cross', ['scissor', 'cross']], ['Pillars', 'pillars', ['stack', 'cathedral']], ['Snap', 'snap', ['burst', 'grid']], ['Vee', 'vee', ['chevron', 'fan']], ['Wall', 'comb', ['wall', 'split']]];
const DROP_HIT: [string, Target, Motion, Shape, StrobePat][] = [['Accent', 'halfbar', 'saw', 'none', 'bar'], ['Double', 'eighths', 'hit', 'double', 'offbeat'], ['Gate', 'four', 'gate', 'none', 'kick'], ['Slam', 'four', 'hit', 'kickpump', 'beat'], ['Split', 'split', 'hit', 'halves', 'snare']];
const DROP_WALL = ['pk_flash', 'pk_halves', 'pk_shock', 'pk_slabs'];
const DROP_LASER: LaserForm[] = ['star', 'burst', 'scissor', 'cross', 'stack', 'cathedral', 'chevron', 'fan', 'wall', 'split', 'grid', 'tunnel'];
function drops(pals: PalLike[]): Cand[] {
  const out: Cand[] = [];
  DROP_FORM.forEach(([fw, form, lfs], g) => DROP_HIT.forEach(([hw, t, m, shape, strobe], h) => DROP_WALL.forEach((wall, w) => [1, 2, 0.5].forEach((tempo, ti) => [false, true].forEach((wide) => {
    const laser = w === 0 && !wide ? lfs[h % lfs.length] : DROP_LASER[(g * 2 + w * 3 + h + (wide ? 5 : 0)) % DROP_LASER.length];
    const sfx = (['kick', 'call', 'bar', 'centre', 'wave'] as SfxPat[])[(g + h + w) % 5];
    const tw = tempo === 2 ? ' Double' : tempo === 0.5 ? ' Half' : '';
    out.push({ key: `d|${form}|${t}|${m}|${wall}|${tempo}|${wide}`, name: `Drop ${fw} ${hw} ${wallWord(wall)}${tw}${wide ? ' Wide' : ''}`, family: 'drop', sub: `${fw} · ${hw} · ${wallWord(wall)}${tw}${wide ? ' · Wide' : ''}`, cls: 'peak',
      sections: ['drop'], palette: pickPalette(pals, 'peak', g * 311 + h * 41 + w * 7 + ti * 3 + (wide ? 1 : 0)), beam: { form, rate: beamFormById(form)!.rate, amp: wide ? 1.15 : 1 },
      level: { target: t, motion: m, shape: tempo === 0.5 ? 'dark' : shape, spread: SPREADS[(g * 2 + h + w) % SPREADS.length] }, wash: { target: t, motion: m === 'gate' ? 'hit' : m, shape },
      laser: { form: laser, target: tempo === 0.5 ? 'halfbar' : tempo === 2 ? 'eighths' : t === 'eighths' ? 'four' : t, motion: tempo === 0.5 ? 'saw' : 'hit', rate: tempo }, strobe, blinder: (['drop', 'bar4', 'call', 'drop'] as BlinderPat[])[(h + w) % 4], sfx, wall,
      colour: (['split', 'alt', 'exchange', 'spread', 'mono'] as ColourMode[])[(g + h + ti) % 5], tempo, wide, tags: ['drop', fw.toLowerCase(), hw.toLowerCase()], score: 0.55 + 0.25 * hash3(g * 7 + h, w * 5 + ti, wide ? 9 : 8) });
  })))));
  return out;
}

const GROOVE_MOTION: [string, BeamForm, LaserForm[]][] = [['BankWave', 'bankwave', ['ribbon', 'sheet']], ['BarFan', 'barfan', ['fan', 'split']], ['Box', 'box', ['grid', 'diamond']], ['Eight', 'eight', ['helix', 'ribbon']], ['Mirror', 'mirror', ['split', 'chevron']], ['Nod', 'nod', ['fan', 'chevron']], ['Orbit', 'orbit', ['cone', 'helix']], ['Sway', 'sway', ['sheet', 'comb']]];
const GROOVE_PULSE: [string, Target, Motion][] = [['Bounce', 'four', 'saw'], ['Four', 'four', 'hit'], ['Off', 'offbeat', 'pulse'], ['Pump', 'four', 'pump'], ['Shuffle', 'shuffle', 'pulse']];
const GROOVE_CHASE: [string, Shape][] = [['Centre', 'centre'], ['Loop', 'loop'], ['Split', 'halves'], ['Steps', 'steps']];
const GROOVE_WALL = ['pk_blocks', 'pk_check', 'pk_eq', 'scanner', 'pk_stripes'];
const GROOVE_LASER: LaserForm[] = ['ribbon', 'sheet', 'fan', 'split', 'grid', 'diamond', 'helix', 'chevron', 'cone', 'comb', 'scan', 'zigzag'];
function grooves(pals: PalLike[]): Cand[] {
  const out: Cand[] = [];
  GROOVE_MOTION.forEach(([mw, form, lfs], mi) => {
    for (let k = 0; k < 40; k++) {
      const [pw, t, m] = GROOVE_PULSE[(mi + k) % 5], [cw, shape] = GROOVE_CHASE[(3 * mi + k) % 4], wall = GROOVE_WALL[(mi + k + 2 * Math.floor(k / 5)) % 5], tempo = [1, 0.5, 2][k % 3];
      const laser = k % 4 === 0 ? lfs[(k / 4) % lfs.length] : GROOVE_LASER[(mi * 5 + k * 7) % GROOVE_LASER.length];
      const tw = tempo === 2 ? ' Double' : tempo === 0.5 ? ' Half' : '';
      out.push({ key: `r|${form}|${t}|${m}|${shape}|${wall}|${tempo}`, name: `Groove ${mw} ${pw} ${cw} ${wallWord(wall)}${tw}`, family: 'groove', sub: `${mw} · ${pw} · ${cw} · ${wallWord(wall)}${tw}`, cls: 'mid',
        palette: pickPalette(pals, 'mid', mi * 211 + k), beam: { form, rate: beamFormById(form)!.rate, amp: 1 }, level: { target: t, motion: m, shape, spread: SPREADS[(mi + k * 3) % SPREADS.length] },
        wash: { target: t, motion: m, shape: pw === 'Bounce' ? 'bounce' : shape }, laser: { form: laser, target: tempo === 0.5 ? 'halfbar' : tempo === 2 ? 'eighths' : t === 'shuffle' ? 'four' : t, motion: tempo === 2 ? 'wipe' : 'pulse', rate: tempo }, strobe: k % 7 === 3 ? 'bar' : 'none', blinder: 'off', sfx: 'none', wall,
        colour: k % 3 === 0 && k % 2 === 1 ? 'rainbow' : COLOURS[(mi * 2 + k) % COLOURS.length], tempo, tags: ['groove', mw.toLowerCase(), pw.toLowerCase(), cw.toLowerCase()], score: 0.5 + 0.3 * hash3(mi, k, 11) });
    }
  });
  return out;
}

const SLOW_MOTION: [string, BeamForm, LaserForm[]][] = [['Bath', 'bath', ['liquid', 'dome']], ['Ceiling', 'ceiling', ['dome', 'crown']], ['Drift', 'drift', ['liquid', 'sheet']], ['Halo', 'halo', ['crown', 'iris']], ['Liquid', 'liquid', ['liquid', 'ribbon']], ['Search', 'searchlight', ['crown', 'cathedral']], ['SkyTilt', 'skytilt', ['wall', 'cathedral']]];
const SLOW_BREATH: [string, Shape, Target, Motion][] = [['Breath', 'breath', 'phrase', 'drift'], ['Glow', 'glow', 'hold', 'drift'], ['Ripple', 'ripple', 'bar', 'pulse'], ['Swell', 'swellramp', 'phrase', 'swell'], ['Tide', 'tide', 'hold', 'drift']];
const SLOW_WALL = ['pk_aurora', 'pk_gradient', 'pk_horizon', 'pk_nebula', 'pk_stars', 'pk_sunrise'];
const SLOW_LASER: LaserForm[] = ['liquid', 'dome', 'sheet', 'crown', 'cathedral', 'ribbon', 'wall', 'iris'];
function slows(pals: PalLike[]): Cand[] {
  const out: Cand[] = [];
  SLOW_MOTION.forEach(([mw, form, lfs], mi) => SLOW_BREATH.forEach(([bw, shape, t, m], bi) => SLOW_WALL.forEach((wall, wi) => {
    const laser = wi === 0 ? lfs[bi % lfs.length] : SLOW_LASER[(mi + bi * 2 + wi * 3) % SLOW_LASER.length];
    out.push({ key: `w|${form}|${shape}|${wall}`, name: `Slow ${mw} ${bw} ${wallWord(wall)}`, family: 'slow', sub: `${mw} · ${bw} · ${wallWord(wall)}`, cls: 'chill', energy: 0.12 + 0.04 * bi,
      sections: ['intro', 'breakdown', 'outro'], palette: pickPalette(pals, 'chill', mi * 53 + bi * 7 + wi), beam: { form, rate: beamFormById(form)!.rate, amp: 0.9 },
      level: { target: t, motion: m, shape, spread: SPREADS[(mi + bi + wi) % SPREADS.length] }, wash: { target: t, motion: m, shape }, laser: { form: laser, target: t === 'hold' ? 'phrase' : t, motion: m === 'pulse' ? 'pulse' : 'drift', rate: 0.5 },
      strobe: 'none', blinder: 'off', sfx: 'none', wall, colour: (bi + wi) % 2 ? 'mono' : 'sweep', tempo: 1, tags: ['slow', mw.toLowerCase(), bw.toLowerCase()], score: 0.5 + 0.3 * hash3(mi, bi * 11 + wi, 13) });
  })));
  return out;
}

// [id, name, beam form, rate, laser, target, motion, shape, wall, strobe, blinder, sfx, colour, cls, palette ('' = by energy), fixed, wash target, wash motion, tempo]
type Sig = [string, string, BeamForm, number, LaserForm | null, Target, Motion, Shape, string, StrobePat, BlinderPat, SfxPat, ColourMode, EnergyCls, string, boolean, Target?, Motion?, number?];
const SIGS: Sig[] = [
  ['laser_cathedral', 'Laser Cathedral', 'cathedral', 16, 'cathedral', 'hold', 'drift', 'breath', 'pk_aurora', 'none', 'off', 'none', 'spread', 'chill', 'arctic', false],
  ['laser_tunnel', 'Laser Tunnel', 'tunnel', 8, 'tunnel', 'four', 'pulse', 'loop', 'pk_zoom', 'none', 'off', 'none', 'sweep', 'mid', '', false],
  ['scissor_lasers', 'Scissor Lasers', 'scissor', 4, 'scissor', 'eighths', 'wipe', 'chase', 'pk_stripes', 'none', 'drop', 'none', 'split', 'peak', '', false],
  ['heartbeat_tunnel', 'Heartbeat Tunnel', 'converge', 4, 'tunnel', 'four', 'hit', 'kickpump', 'pk_flash', 'none', 'off', 'none', 'mono', 'mid', '', false, 'four', 'pulse'],
  ['prism_avalanche', 'Prism Avalanche', 'grid', 2, 'burst', 'eighths', 'sparkle', 'scatter', 'pk_matrix', 'snare', 'bar4', 'none', 'rainbow', 'peak', '', false],
  ['lightning_strikes', 'Lightning Strikes', 'ballyhoo', 2, 'burst', 'snare', 'sparkle', 'dark', 'pk_shock', 'lightning', 'off', 'none', 'white', 'peak', 'storm', true],
  ['liquid_sky', 'Liquid Sky', 'drift', 32, 'liquid', 'phrase', 'drift', 'veil', 'pk_nebula', 'none', 'off', 'none', 'sweep', 'chill', '', false],
  ['moon_beam', 'Moon Beam', 'pillars', 16, 'dome', 'hold', 'drift', 'glow', 'pk_horizon', 'none', 'off', 'none', 'white', 'chill', 'silver', true],
  ['euphoric_fans', 'Euphoric Fans', 'fan', 8, 'fan', 'bar', 'swell', 'ascent', 'pk_sunrise', 'bar', 'drop', 'none', 'spread', 'peak', '', false, 'bar', 'swell'],
  ['thunder_strobe', 'Thunder Strobe', 'grid', 2, 'stack', 'eighths', 'sparkle', 'none', 'pk_flash', 'storm', 'drop', 'centre', 'white', 'peak', 'red_alert', true, 'four', 'hit'],
  ['crowd_wave', 'Crowd Wave', 'bankwave', 8, 'ribbon', 'four', 'wipe', 'tide', 'pk_stripes', 'none', 'off', 'none', 'sweep', 'mid', '', false],
  ['sunrise_breakdown', 'Sunrise Breakdown', 'lift', 32, 'sheet', 'phrase', 'swell', 'swellramp', 'pk_sunrise', 'none', 'off', 'none', 'spread', 'chill', 'sunset', true],
  ['snare_roll_riser', 'Snare Roll Riser', 'funnel', 8, 'vortex', 'sixteenths', 'wipe', 'fill', 'pk_meter', 'roll', 'off', 'co2build', 'white', 'peak', '', false, 'eighths', 'pulse'],
  ['flame_wall', 'Flame Wall', 'comb', 4, 'wall', 'four', 'hit', 'loop', 'fire', 'none', 'drop', 'chase', 'spread', 'peak', 'inferno', true],
  ['hammer_chase', 'Hammer Chase', 'steps', 4, 'stack', 'four', 'hit', 'banks', 'pk_slabs', 'beat', 'bar4', 'kick', 'alt', 'peak', 'red_alert', true],
  ['red_power', 'Red Power', 'vee', 8, 'stack', 'four', 'hit', 'halves', 'pk_halves', 'kick', 'drop', 'kick', 'split', 'peak', 'blood_moon', true],
  ['ice_tunnel', 'Ice Tunnel', 'tunnel', 8, 'cone', 'bar', 'pulse', 'loop', 'pk_zoom', 'bar', 'drop', 'none', 'sweep', 'peak', 'ice_storm', true, 'four', 'pulse'],
  ['laser_dome', 'Laser Dome', 'crown', 16, 'dome', 'bar', 'saw', 'impact', 'pk_ripple', 'bar', 'drop', 'centre', 'spread', 'peak', 'arctic', true, 'bar', 'saw'],
  ['power_hour', 'Power Hour', 'starburst', 4, 'star', 'four', 'hit', 'kickpump', 'pk_flash', 'beat', 'call', 'kick', 'split', 'peak', '', false],
  ['anthem_singalong', 'Anthem Singalong', 'sway', 8, 'liquid', 'phrase', 'drift', 'glints', 'pk_stars', 'none', 'off', 'none', 'spread', 'mid', '', false],
  ['scanner_run', 'Scanner Run', 'comb', 8, 'scan', 'eighths', 'wipe', 'loop', 'scanner', 'none', 'off', 'none', 'mono', 'mid', '', false],
  ['bank_bumps', 'Bank Bumps', 'terraces', 8, 'stack', 'four', 'hit', 'banks', 'pk_blocks', 'none', 'bar4', 'none', 'alt', 'peak', '', false],
  ['phone_lights', 'Phone Lights', 'drift', 32, 'crown', 'hold', 'sparkle', 'glints', 'pk_stars', 'none', 'off', 'none', 'sweep', 'chill', 'lagoon', false],
  ['offbeat_pump', 'Offbeat Pump', 'nod', 1, 'fan', 'offbeat', 'pump', 'none', 'pk_eq', 'none', 'off', 'none', 'split', 'mid', '', false],
  ['reverse_pump', 'Reverse Pump', 'nod', 1, 'fan', 'gallop', 'swell', 'kickpump', 'pk_meter', 'none', 'drop', 'kick', 'alt', 'peak', 'hellfire', false, 'four', 'pump'],
  ['sheet_stack', 'Sheet Stack', 'terraces', 8, 'stack', 'four', 'pulse', 'halves', 'pk_slabs', 'none', 'off', 'none', 'spread', 'mid', '', false],
  ['kick_strobe_grid', 'Kick Strobe Grid', 'grid', 2, 'grid', 'four', 'hit', 'kickpump', 'pk_check', 'kick', 'drop', 'none', 'mono', 'peak', 'arctic', false],
  ['rainbow_bar', 'Rainbow Bar', 'barfan', 4, 'fan', 'four', 'saw', 'steps', 'pk_bars', 'none', 'off', 'none', 'rainbow', 'mid', 'rainbow', true],
  ['vortex_tunnel', 'Vortex Tunnel', 'vortex', 8, 'vortex', 'eighths', 'pulse', 'loop', 'tunnel', 'none', 'drop', 'none', 'sweep', 'peak', '', false],
  ['iris_pulse', 'Iris Pulse', 'iris', 8, 'iris', 'bar', 'pulse', 'centre', 'pk_ripple', 'none', 'off', 'none', 'spread', 'mid', '', false],
  ['cross_chase', 'Cross Chase', 'cross', 4, 'scissor', 'eighths', 'wipe', 'pingpong', 'pk_stripes', 'snare', 'drop', 'none', 'split', 'peak', '', false],
  ['fan_sweep', 'Fan Sweep', 'fan', 8, 'fan', 'four', 'drift', 'loop', 'pk_gradient', 'none', 'off', 'none', 'spread', 'mid', '', false],
  ['alternating_banks', 'Alternating Banks', 'counter', 4, 'split', 'four', 'hit', 'counterfire', 'pk_halves', 'none', 'bar4', 'none', 'alt', 'mid', '', false],
  ['tidal_wave', 'Tidal Wave', 'wave', 4, 'ribbon', 'phrase', 'drift', 'tide', 'pk_aurora', 'none', 'off', 'none', 'sweep', 'chill', 'deep_ocean', true],
  ['orbital_sweep', 'Orbital Sweep', 'orbit', 8, 'cone', 'four', 'pulse', 'loop', 'pk_ripple', 'none', 'off', 'none', 'split', 'mid', '', false],
  ['spectrum_rain', 'Spectrum Rain', 'rain', 4, 'comb', 'hat', 'sparkle', 'glints', 'pk_eq', 'none', 'off', 'none', 'rainbow', 'mid', '', false],
  ['prism_chase', 'Prism Chase', 'snap', 1, 'star', 'eighths', 'hit', 'chase', 'pk_blocks', 'snare', 'drop', 'none', 'rainbow', 'peak', '', false, 'four', 'hit'],
  ['storm_front', 'Storm Front', 'searchlight', 32, 'burst', 'snare', 'sparkle', 'dark', 'pk_nebula', 'lightning', 'off', 'none', 'white', 'peak', 'storm', true],
  ['mirror_sweep', 'Mirror Sweep', 'mirror', 8, 'split', 'four', 'pulse', 'centre', 'pk_halves', 'none', 'off', 'none', 'split', 'mid', '', false],
  ['snake_run', 'Snake Run', 'zigzag', 4, 'zigzag', 'sixteenths', 'wipe', 'chase', 'pk_stripes', 'none', 'drop', 'none', 'spread', 'peak', '', false, 'four', 'hit'],
  ['eclipse', 'Eclipse', 'halo', 16, 'iris', 'phrase', 'drift', 'ripple', 'pk_ripple', 'none', 'off', 'none', 'mono', 'chill', 'deep_space', true],
  ['intro_reveal', 'Intro Reveal', 'skytilt', 32, 'sheet', 'bar', 'swell', 'ascent', 'pk_horizon', 'none', 'off', 'none', 'spread', 'chill', '', false],
  ['riser_tunnel', 'Riser Tunnel', 'rise', 1, 'tunnel', 'sixteenths', 'wipe', 'fill', 'pk_zoom', 'roll', 'off', 'none', 'white', 'peak', '', false, 'eighths', 'pulse'],
  ['anthem_sails', 'Anthem Sails', 'sail', 8, 'ribbon', 'bar', 'swell', 'breath', 'pk_gradient', 'none', 'off', 'none', 'spread', 'mid', '', false],
  ['spotlight_ballyhoo', 'Spotlight Ballyhoo', 'ballyhoo', 2, 'cone', 'four', 'hit', 'none', 'pk_matrix', 'beat', 'drop', 'none', 'alt', 'peak', '', false],
  ['spotlight_fans', 'Spotlight Fans', 'vee', 8, 'sheet', 'four', 'pulse', 'none', 'pk_gradient', 'none', 'off', 'none', 'split', 'mid', '', false],
  ['cross_stage_duet', 'Cross-Stage Duet', 'cross', 4, 'cross', 'halfbar', 'pulse', 'halves', 'pk_halves', 'none', 'off', 'none', 'split', 'mid', '', false],
  ['crown_detonation', 'Crown Detonation', 'crown', 16, 'crown', 'four', 'hit', 'detonation', 'pk_shock', 'beat', 'drop', 'centre', 'spread', 'peak', '', false],
  ['crossfire_chase', 'Crossfire Chase', 'crosswind', 8, 'scissor', 'eighths', 'hit', 'chase', 'pk_slabs', 'offbeat', 'drop', 'call', 'split', 'peak', '', false, 'four', 'hit'],
  ['arena_heartbeat', 'Arena Heartbeat', 'halo', 16, 'cone', 'four', 'hit', 'kickpump', 'rings', 'none', 'drop', 'none', 'mono', 'peak', '', false],
  ['victory_fans', 'Victory Fans', 'vee', 8, 'chevron', 'bar', 'swell', 'ascent', 'pk_sunrise', 'bar', 'drop', 'none', 'spread', 'peak', '', false, 'bar', 'swell'],
  ['ember_breath', 'Ember Breath', 'bath', 16, 'liquid', 'phrase', 'drift', 'breath', 'pk_gradient', 'none', 'off', 'none', 'sweep', 'chill', 'ember', true],
  ['moonlit_canopy', 'Moonlit Canopy', 'ceiling', 16, 'dome', 'phrase', 'drift', 'glow', 'pk_stars', 'none', 'off', 'none', 'sweep', 'chill', 'deep_space', true],
  ['rising_spiral', 'Rising Spiral', 'spiral', 8, 'vortex', 'bar', 'swell', 'ascent', 'pk_zoom', 'none', 'off', 'none', 'sweep', 'mid', '', false],
  ['horizon_curtain', 'Horizon Curtain', 'skytilt', 32, 'wall', 'phrase', 'drift', 'veil', 'pk_horizon', 'none', 'off', 'none', 'mono', 'chill', '', false],
  ['suspended_stars', 'Suspended Stars', 'pillars', 16, 'star', 'hold', 'sparkle', 'glints', 'pk_stars', 'none', 'off', 'none', 'sweep', 'chill', '', false],
  ['flame_wave', 'Flame Wave', 'wings', 4, 'fan', 'four', 'hit', 'none', 'pk_bars', 'none', 'drop', 'wave', 'split', 'peak', 'lava', true],
  ['co2_countdown', 'CO2 Countdown', 'pinch', 4, 'cone', 'eighths', 'wipe', 'fill', 'pk_meter', 'roll', 'off', 'co2build', 'white', 'peak', 'ice_storm', true, 'four', 'pulse'],
  ['gallop_storm', 'Gallop Storm', 'ballyhoo', 2, 'stack', 'gallop', 'hit', 'none', 'fire', 'none', 'downbeat', 'kick', 'alt', 'peak', 'hellfire', false, 'four', 'hit'],
  ['dotted_echo', 'Dotted Echo', 'orbitals', 4, 'diamond', 'dotted', 'pulse', 'loop', 'pk_ripple', 'none', 'off', 'none', 'split', 'mid', '', false],
  ['triplet_spin', 'Triplet Spin', 'corkscrew', 4, 'vortex', 'triplets', 'wipe', 'none', 'kaleido', 'none', 'drop', 'none', 'sweep', 'peak', '', false, 'halfbar', 'pulse'],
  ['call_and_answer', 'Call and Answer', 'mirror', 4, 'split', 'call', 'hit', 'none', 'pk_halves', 'none', 'call', 'call', 'split', 'peak', '', false],
];
function signatures(pals: PalLike[]): Cand[] {
  const ids = new Set(pals.map((p) => p.id));
  return SIGS.map(([id, name, form, rate, laser, t, m, shape, wall, strobe, blinder, sfx, colour, cls, pal, fixed, wt, wm, tempo], i) => ({
    key: `x|${id}`, name, family: 'signature' as Family, sub: name, cls, energy: cls === 'peak' ? 0.82 : cls === 'mid' ? 0.55 : 0.2, palette: pal && ids.has(pal) ? pal : pickPalette(pals, cls, i * 7919), fixed: fixed && ids.has(pal),
    beam: { form, rate, amp: 1 }, level: { target: t, motion: m, shape, spread: (['leftright', 'wings', 'centerout', 'unison', 'oddeven'] as SpreadMode[])[i % 5] },
    wash: { target: wt ?? (t === 'sixteenths' || t === 'gallop' ? 'four' : t), motion: wm ?? (m === 'sparkle' ? 'pulse' : m), shape: shape === 'kickpump' ? 'none' : shape },
    laser: laser ? { form: laser, target: cls === 'chill' ? 'phrase' : t === 'gallop' || t === 'sixteenths' || t === 'eighths' ? 'four' : t, motion: cls === 'chill' ? 'drift' : m === 'sparkle' ? 'hit' : m, rate: 1 } : null,
    strobe, blinder, sfx, wall, colour, tempo: tempo ?? 1, tags: ['signature', id], score: 2,
  }));
}

// ---------------------------------------------------------------------------------------------------- the catalogue
export interface PackStats { total: number; perFamily: Record<Family, number>; rejected: Record<string, number>; dupes: number; candidates: number }
const QUOTA: Record<Family, number> = { signature: 999, score: 999, build: 999, drop: 280, groove: 260, slow: 999, grammar: 640 };
let cacheKey = '', cache: { list: Program[]; stats: PackStats } | null = null;

/** Every program of the pack (deterministic for a palette list). Families in a fixed order; signatures first. */
export function generatePack(pals: PalLike[], o: { fresh?: boolean } = {}): { list: Program[]; stats: PackStats } {
  const key = pals.map((p) => p.id).join(',');
  if (cache && key === cacheKey && !o.fresh) return cache;
  const fam: [Family, Cand[]][] = [['signature', signatures(pals)], ['score', scores(pals)], ['build', builds(pals)], ['drop', drops(pals)], ['groove', grooves(pals)], ['slow', slows(pals)], ['grammar', grammar(pals)]];
  const seen = new Set<string>();
  const names = new Set<string>(), ids = new Set<string>();
  const stats: PackStats = { total: 0, perFamily: { grammar: 0, score: 0, build: 0, drop: 0, groove: 0, slow: 0, signature: 0 }, rejected: {}, dupes: 0, candidates: 0 };
  const list: Program[] = [];
  for (const [f, cands] of fam) {
    stats.candidates += cands.length;
    const progs = cands.map(finish);
    // (signatures keep their order; the rest by score with a novelty pass)
    const order = f === 'signature' ? progs : progs.map((p, i) => ({ p, s: cands[i].score })).sort((a, b) => b.s - a.s || (a.p.id < b.p.id ? -1 : 1)).map((x) => x.p);
    let n = 0;
    for (const p of order) {
      if (n >= QUOTA[f]) break;
      const v = packRules(p);
      if (!v.ok) { stats.rejected[v.why] = (stats.rejected[v.why] ?? 0) + 1; continue; }
      const ck = coreKey(p);
      // near-identical: equal on 6 of the 7 visual axes to a program already in
      const wild = ck.map((_, j) => ck.map((x, q) => (q === j ? '*' : x)).join('|'));
      if (wild.some((w) => seen.has(w)) || ids.has(p.id)) { stats.dupes++; continue; }
      let name = p.name;
      if (names.has(name)) name = `${p.name} · ${laserFormById(p.laser?.form ?? '')?.word ?? wallWord(p.wall)}`;
      if (names.has(name)) name = `${p.name} · ${wallWord(p.wall)}`;
      if (names.has(name)) { stats.dupes++; continue; }
      for (const w of wild) seen.add(w);
      names.add(name); ids.add(p.id);
      p.name = name;
      p.score = Math.round(p.score * 1000) / 1000;
      list.push(p); n++;
    }
    stats.perFamily[f] = n;
  }
  stats.total = list.length;
  cacheKey = key; cache = { list, stats };
  return cache;
}
