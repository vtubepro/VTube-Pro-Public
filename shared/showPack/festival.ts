// Show pack → the festival stage engine (shared/festivalLooks.ts catalogue, shared/festivalDirector.ts evaluators):
// every program becomes a festival Look ('p' + its id, `look.pack` = the program) appended to the catalogue after the
// shipped looks (curation bitmasks keep their indexes), every show gets pack looks per section (genre + section fit,
// a mix of families), and the director's evaluators hand pack looks to the program evaluators (program.ts) - beams,
// washes / PARs / pixels, strobes, lasers (+ the ray formations the laser renderer draws), LED wall patterns, cues.
// No runtime import of festivalLooks / festivalDirector here (they import this module): types only.
import { fract, hash3, hashStr } from '../festival.ts';
import type { DirectorFrame, LaserOut, LookFrame, MoverOut, MusicState, FlatOut, FixGeo, Lvl, SfxHit } from '../festivalDirector.ts';
import type { Look, MotionKind, RhythmKind, LaserMode, Section, Show, SpreadKind } from '../festivalLooks.ts';
import { laserFormById, type BeamForm, type LaserForm, type MoverKind } from './forms.ts';
import { generatePack, type PalLike } from './generate.ts';
import { packFlat, packLaser, packMover, packRay, packStrobe, type PackFrame, type PackLaserOut, type Program } from './program.ts';
import { gridOnsets, type Target } from './rhythm.ts';
import { drumPhases, newDrums, planEnvelopes, planFor, planParts, type GrooveHit } from '../groove.ts';
const ENV = { kick: 0, snare: 0 };
const DRUMS = newDrums(), GO = { kick: 0, snare: 0, hat: 0 };
const DM: { src: GrooveHit[] | null; plan: GrooveHit[] | undefined; barPos: number; bar: number; bpm: number } = { src: null, plan: undefined, barPos: NaN, bar: NaN, bpm: NaN };

const MOTION_OF: Record<BeamForm, MotionKind> = {
  fan: 'fan', tunnel: 'circle', cross: 'crossfire', counter: 'xcross', converge: 'converge', mirror: 'wave', orbit: 'circle', spiral: 'spiral', wave: 'wave', grid: 'snap', starburst: 'bloom',
  pendulum: 'pendulum', lift: 'lift', chevron: 'vee', diamond: 'fig8', helix: 'helix', iris: 'bloom', ribbon: 'wave', sail: 'tiltwave', steps: 'snap', vault: 'arc', wings: 'fan', terraces: 'tiltwave',
  corkscrew: 'helix', crosswind: 'sweep', orbitals: 'circle', ballyhoo: 'ballyhoo', cathedral: 'sky', scissor: 'xcross', searchlight: 'searchlight', crown: 'sky', comb: 'sweep', rain: 'audience',
  zigzag: 'shake', flower: 'circle', pillars: 'sky', vee: 'vee', snap: 'snap', funnel: 'converge', rise: 'lift', vortex: 'spiral', pinch: 'crossfire', barfan: 'fan', nod: 'fanpump', sway: 'sweep',
  box: 'snap', eight: 'fig8', bankwave: 'ripple', drift: 'still', liquid: 'fig8', skytilt: 'tiltwave', bath: 'still', ceiling: 'sky', halo: 'circle',
};
const RHYTHM_OF: Record<Target, RhythmKind> = { four: 'kick', offbeat: 'offbeat', snare: 'snare', hat: 'sparkle', eighths: 'alternate', sixteenths: 'sixteenth', triplets: 'triplet', dotted: 'swing', call: 'pingpong', phrase: 'breathe', bar: 'downbeat', halfbar: 'halftime', gallop: 'gallop', shuffle: 'swing', split: 'alternate', hold: 'hold' };
const LASER_OF: Record<LaserForm, LaserMode> = { fan: 'fan', sheet: 'sheet', tunnel: 'tunnel', cone: 'tunnel', scan: 'scan', cross: 'cross', grid: 'cross', star: 'burst', helix: 'fan', chevron: 'fan', liquid: 'liquid', burst: 'burst', wall: 'sheet', scissor: 'cross', comb: 'scan', zigzag: 'fan', cathedral: 'sheet', vortex: 'tunnel', crown: 'tunnel', iris: 'tunnel', ribbon: 'liquid', diamond: 'tunnel', stack: 'sheet', dome: 'tunnel', split: 'fan' };
function accentOf(p: Program): string {
  if (p.cls === 'chill') return p.laser ? 'glow' : 'calm';
  if (p.blinder === 'downbeat') return 'full_send';
  if (p.blinder === 'bar4') return 'blinder_bar4';
  if (p.blinder === 'drop') return p.strobe === 'storm' ? 'strobe_heavy' : p.sfx === 'kick' ? 'pyro_kick' : 'blinder_drop';
  return p.cls === 'peak' ? 'lasers_beat' : 'lasers_slow';
}

/** the pack as festival looks (cached per palette list) */
let lookCache: { key: string; looks: Look[] } | null = null;
export function packLooks(pals: PalLike[]): Look[] {
  const key = pals.map((p) => p.id).join(',');
  if (lookCache?.key === key) return lookCache.looks;
  const { list } = generatePack(pals);
  const looks: Look[] = list.map((p) => ({
    id: `p${p.id}`, name: p.name, palette: p.palette, motion: MOTION_OF[p.beam.form], rhythm: RHYTHM_OF[p.wash.target], beamRhythm: RHYTHM_OF[p.level.target], spread: p.level.spread as SpreadKind,
    accent: accentOf(p), laser: p.laser ? LASER_OF[p.laser.form] : 'off', wall: p.wall as Look['wall'], energy: p.energy, cls: p.cls, sections: p.sections as Section[], score: p.score, pack: p,
  }));
  lookCache = { key, looks };
  return looks;
}

/** how many pack looks a show plays per section (on top of its own) */
const PER_SECTION: Record<Section, number> = { intro: 5, groove: 10, build: 8, drop: 14, breakdown: 6, outro: 4 };
/** Every show gets pack looks: per section the programs that fit the section and the show's genre (drops: peak only),
 *  a deterministic mix across families (round robin), signatures first. Room shows (scene.json) get theirs the same way.
 *  `full` (a room's festival.packPool 'full'): the room's own shows take EVERY program that fits the section (the
 *  genre's first, then the rest, each in the same round-robin order), so the per-phrase pick walks the whole pack. */
export function addPackToShows(shows: Show[], looks: Look[], full?: { share?: number }): void {
  for (const s of shows) {
    const salt = hashStr(`pack:${s.id}`);
    const all = !!full && !!s.room;
    if (all && full!.share !== undefined) s.packShare = full!.share;
    for (const sec of Object.keys(PER_SECTION) as Section[]) {
      const chill = s.genre === 'chill';
      // (a chill show's "drop" is its chorus: groove looks without the peak ones)
      const fits = (l: Look) => (chill && sec === 'drop' ? l.sections.includes('groove') : l.sections.includes(sec)) && (sec !== 'drop' || chill ? true : l.cls === 'peak') && (!chill || l.cls !== 'peak');
      let pool = looks.filter((l) => fits(l) && l.pack!.genres.includes(s.genre));
      const own = pool.length;
      if (all || pool.length < PER_SECTION[sec]) pool = pool.concat(looks.filter((l) => fits(l) && !pool.includes(l)));
      // round robin over families, each family ordered by (signature first) + a seeded shuffle
      const byFam = new Map<string, Look[]>();
      for (const l of pool) { const f = l.pack!.family; (byFam.get(f) ?? byFam.set(f, []).get(f)!).push(l); }
      for (const list of byFam.values()) list.sort((a, b) => (b.pack!.family === 'signature' ? 1 : 0) - (a.pack!.family === 'signature' ? 1 : 0) || hash3(salt, hashStr(a.id)) - hash3(salt, hashStr(b.id)));
      const fams = [...byFam.keys()].sort((a, b) => hash3(salt, hashStr(a), 3) - hash3(salt, hashStr(b), 3));
      const pick: string[] = [];
      if (all) {
        // (the genre's own programs first, then the rest: each block in the round-robin family order)
        const rr = (inGenre: boolean) => { const fam = new Map<string, Look[]>(); for (const f of fams) fam.set(f, byFam.get(f)!.filter((l) => (pool.indexOf(l) < own) === inGenre)); const depth = Math.max(0, ...[...fam.values()].map((v) => v.length)); for (let r = 0; r < depth; r++) for (const f of fams) { const l = fam.get(f)![r]; if (l) pick.push(l.id); } };
        rr(true); rr(false);
      } else for (let r = 0; pick.length < PER_SECTION[sec] && r < 64; r++) for (const f of fams) { const l = byFam.get(f)![r]; if (l && pick.length < PER_SECTION[sec]) pick.push(l.id); }
      (s.pack ??= {})[sec] = pick;
    }
  }
}

// ---------------------------------------------------------------------------------------------------- evaluation
const PF: PackFrame = { beat: 0, bar: 0, barPos: 0, bpm: 120, energy: 0, kick: 0, snare: 0, hat: 0, onsets: false, section: 'groove', build: 0, converge: 0, dropAge: Infinity, level: 1, step: 0, mb: 0, safe: false, colors: [[1, 1, 1]] };
/** the pack's view of a festival LookFrame */
export function packFrameOf(f: LookFrame): PackFrame {
  PF.beat = f.beat; PF.bar = f.bar; PF.barPos = f.barPos; PF.bpm = f.bpm; PF.energy = f.energy; PF.kick = f.kick;
  if (f.onsets && f.snare !== undefined && f.hat !== undefined) { PF.snare = f.snare; PF.hat = f.hat; PF.onsets = true; }
  else { const g = gridOnsets(f.beat, f.bpm, true, GO); PF.snare = g.snare; PF.hat = g.hat; PF.onsets = false; }
  PF.section = f.section ?? 'groove'; PF.build = f.build; PF.converge = f.converge; PF.dropAge = f.dropAge; PF.level = f.level; PF.step = f.step;
  PF.mb = f.motionBeat ?? f.beat; PF.safe = !!f.safe || f.motionBeat != null; PF.colors = f.colors;
  // the rhythm lane's groove: the drums own the intensity (pre-cued kick / snare slots at the safe unison gap), the
  // figures move on the grid; a known four-on-the-floor / free rhythm: hats soft (rhythm.ts targetLevel)
  PF.rhythm = f.rhythm; PF.feel = f.feel;
  // (the plan, its envelopes and the drum phases depend only on the music's moment: computed once per frame - every
  //  mover / flat / strobe / laser of every look this frame reuses them; nothing is allocated per fixture)
  const src = f.rhythm === 'groove' && f.plan ? f.plan : null;
  if (src !== DM.src || f.barPos !== DM.barPos || f.bar !== DM.bar || f.bpm !== DM.bpm) {
    DM.src = src; DM.barPos = f.barPos; DM.bar = f.bar; DM.bpm = f.bpm;
    DM.plan = src ? planFor(src, f.bpm, true, 1 / 2.2) : undefined;
    if (DM.plan) { planEnvelopes(DM.plan, f.barPos, f.bpm, ENV); drumPhases(DM.plan, f.barPos, f.bar, f.bpm, DRUMS); }
  }
  PF.plan = DM.plan;
  if (DM.plan) { PF.kick = ENV.kick; PF.snare = ENV.snare; PF.onsets = true; PF.drums = DRUMS; } else PF.drums = undefined;
  return PF;
}
export function festPackMover(kind: MoverKind, f: LookFrame, g: FixGeo, out: MoverOut): MoverOut { return packMover(f.look.pack!, kind, packFrameOf(f), g, out); }
export function festPackFlat(f: LookFrame, g: FixGeo, out: FlatOut): FlatOut { return packFlat(f.look.pack!, packFrameOf(f), g, out); }
const ST = { v: 0, flash: false, key: '' };
/** strobes: the director's countdown + drop white hit (as strobeLevel), else the program's own pattern */
export function festPackStrobe(f: LookFrame, d: Pick<DirectorFrame, 'strobeHz' | 'white' | 'whiteKey' | 'section'>, out: Lvl): Lvl {
  out.v = 0; out.flash = false; out.key = '';
  if (d.strobeHz > 0) {
    const per = d.strobeHz / (f.bpm / 60), t = fract(f.beat * per);
    out.v = t < 0.3 ? 1 : 0; out.flash = true; out.key = `cd${Math.floor(f.beat * per)}`;
  } else {
    const pf = packFrameOf(f); pf.section = (d.section ?? pf.section) as PackFrame['section'];
    packStrobe(f.look.pack!, pf, ST);
    if (ST.v > 0) { out.v = ST.v; out.flash = ST.flash; out.key = ST.key; }
  }
  if (d.white > out.v) { out.v = d.white; out.flash = true; out.key = d.whiteKey; }
  return out;
}
const newPL = (): PackLaserOut => ({ on: 0, flash: false, key: '', r: 0, g: 0, b: 0, yaw: 0, pitch: 0, spread: 0, spin: 0, form: 'fan', mt: 0, sheet: false, rays: 1, tiers: 1, seed: 0 });
/** lasers: mode 'pack' + the program's formation in `out.pack` (src/scene/festival/lasers.ts draws its rays) */
export function festPackLaser(f: LookFrame, g: FixGeo, sec: Section, out: LaserOut): LaserOut {
  const pf = packFrameOf(f); pf.section = sec;
  const pk = (out.pack ??= newPL());
  packLaser(f.look.pack!, pf, g, 16, pk);
  out.on = pk.on; out.mode = pk.on > 0 ? 'pack' : 'off'; out.rays = pk.rays; out.spread = pk.spread; out.yaw = pk.yaw; out.pitch = pk.pitch; out.spin = pk.spin;
  out.r = pk.r; out.g = pk.g; out.b = pk.b; out.flash = pk.flash; out.key = pk.key;
  return out;
}
/** rays an origin draws for a pack formation (of the renderer's per-origin budget) */
export const packRayCount = (pk: PackLaserOut, budget: number) => Math.max(1, Math.min(budget, Math.round(budget * (laserFormById(pk.form)?.rays ?? 1))));
export { packRay };
const SW = { yaw: 0, pitch: 0 };
/** Safe flashes: how fast a formation's OWN rays swing (rad/s: the fastest of its first, middle and last ray, aim
 *  included) - a ray sweeping across a region of the frame is a flash no governor sees, and a formation's rays move
 *  round its aim (bursts, scissors, fans opening). The engines dim rays with it, as with the aim's swing. `beat`: what
 *  the engine passes packRay (0 with Safe flashes ON: no tier hops). `mem`: the emitter's own (no allocation after the
 *  first frame). */
export function packRaySwing(e: PackLaserOut, n: number, beat: number, mem: { raySw?: Float64Array; raySwOk?: boolean }, dt: number): number {
  const m = (mem.raySw ??= new Float64Array(6));
  let w = 0;
  for (let j = 0; j < 3; j++) {
    packRay(e, j === 0 ? 0 : j === 1 ? n >> 1 : n - 1, n, beat, SW);
    if (mem.raySwOk) {
      const dy = ((((SW.yaw - m[j * 2]) % 360) + 540) % 360 - 180) * Math.cos(SW.pitch * Math.PI / 180), dp = SW.pitch - m[j * 2 + 1];
      w = Math.max(w, Math.hypot(dy, dp));
    }
    m[j * 2] = SW.yaw; m[j * 2 + 1] = SW.pitch;
  }
  mem.raySwOk = true;
  return (w * Math.PI / 180) / Math.max(1e-3, dt);
}

/** the palette a pack look plays: the show's (rotating every 8 bars / drop), unless the program keeps its own */
export function packPaletteId(look: Look, show: Pick<Show, 'palettes'> | undefined, step: number): string {
  if (!look.pack || look.pack.fixed || !show?.palettes.length) return look.palette;
  const n = show.palettes.length;
  return show.palettes[((step % n) + n) % n];
}

// ---------------------------------------------------------------------------------------------------- cues
/** The program's special-effects cues around `beat` (absolute beats; the director keeps them while alive): flames on the
 *  kicks (16 bars, every 2nd beat after 8), answering left / right, on the bar, chases and waves across the units, CO2
 *  through the last 2 bars of a build, a gerb line on phrase starts. Budgeted: <= 1 flame hit a beat per side. */
export function packHits(p: Program, m: Pick<MusicState, 'beat' | 'lastDrop' | 'kickOn' | 'nextDrop'> & Partial<Pick<MusicState, 'barPos' | 'rhythm' | 'plan'>>, sec: Section, pyro: boolean, out: SfxHit[]): SfxHit[] {
  const B = m.beat, dropAge = Number.isFinite(m.lastDrop) ? B - m.lastDrop : Infinity;
  const hit = (kind: SfxHit['kind'], beat: number, dur: number, power: number, side: -1 | 0 | 1, x: Partial<SfxHit> = {}) =>
    out.push({ kind, group: '', beat, dur, power, seed: Math.floor(hash3(Math.round(beat * 4), hashStr(kind + p.id), side + 2) * 2 ** 31), side, key: `pk|${kind}|${Math.round(beat * 4)}|${side}|${p.id}`, ...x });
  const b0 = Math.floor(B) - 10, b1 = Math.floor(B) + 1;
  // the drums own the hits (rhythm lane): blinders and flames fire on the track's kicks / snares (the plan, pre-cued on
  // the grid's bars) instead of grid beats the music may not play; bar / phrase cues on the bar's first kick
  const G = m.rhythm === 'groove' && m.plan?.length && Number.isFinite(m.barPos) ? planParts(m.plan) : null;
  const bar0 = B - (m.barPos ?? 0);                      // (the current bar's downbeat, beats)
  const callHit = (kind: 'blinder' | 'flame', dur: number, power: number) => {   // left on the bar's first kick, right on its first drum after the half
    let k1: GrooveHit | undefined, k2: GrooveHit | undefined;
    for (const h of G!.kicks) if (h.pos < 2 && !k1) k1 = h;
    for (const h of G!.snares) if (h.pos >= 2 && !k2) k2 = h;
    if (!k2) for (const h of G!.kicks) if (h.pos >= 2 && !k2) k2 = h;
    const ok = (bt: number) => bt >= b0 && bt <= b1 && (kind !== 'flame' || (bt - m.lastDrop >= 1 && bt - m.lastDrop < 64));
    for (let j = Math.floor((b0 - bar0) / 4) - 1; bar0 + j * 4 <= b1; j++) {
      const bs = bar0 + j * 4;
      if (k1 && ok(bs + k1.pos)) hit(kind, bs + k1.pos, dur, power, -1);
      if (k2 && ok(bs + k2.pos)) hit(kind, bs + k2.pos, dur, power, 1);
    }
  };
  // blinder 'call': left on beat 1, right on beat 3 of each bar while the energy is up (gated by the rig like every blinder)
  if (p.blinder === 'call' && (sec === 'drop' || sec === 'groove')) {
    if (G) callHit('blinder', 0.3, 0.55);
    else for (let b = b0; b <= b1; b++) { const bp = ((b % 4) + 4) % 4; if (bp === 0 || bp === 2) hit('blinder', b, 0.3, 0.55, bp === 0 ? -1 : 1); }
  }
  if (!pyro || p.sfx === 'none') return out;
  if (p.sfx === 'co2build') {
    if (sec === 'build' && m.nextDrop != null) for (let b = Math.max(b0, Math.ceil(m.nextDrop - 8)); b <= Math.min(b1, m.nextDrop - 1); b += 1) if (((b - Math.ceil(m.nextDrop - 8)) % 2) === 0) hit('co2', b, 0.6, 0.75, (b / 2) % 2 ? 1 : -1);
    return out;
  }
  if (sec !== 'drop' || !(dropAge >= 0)) return out;
  const D = m.lastDrop;
  if (G && (p.sfx === 'kick' || p.sfx === 'call')) {
    if (p.sfx === 'call') { callHit('flame', 0.5, 0.9); return out; }
    // flames on the kicks: every kick for 32 beats, then every 2nd, sides alternating (same-side flames are two plan hits
    // apart: >= 0.68 s with the plan's 0.34 s gap). A kick's number counts from the DROP's bar, so it keeps its side and
    // its every-2nd parity across bar lines (an early downbeat kick burns across one)
    if (!m.kickOn) return out;
    for (let j = Math.floor((b0 - bar0) / 4) - 1; bar0 + j * 4 <= b1; j++) for (let i = 0; i < G.kicks.length; i++) {
      const jd = Math.round((bar0 + j * 4 - D) / 4);
      const bt = bar0 + j * 4 + G.kicks[i].pos, k = bt - D, n = jd * G.kicks.length + i;
      if (bt < b0 || bt > b1 || k < 1 || k >= 64) continue;
      if (k < 32 || n % 2 === 0) hit('flame', bt, 0.45, 0.85, n % 2 ? -1 : 1);
    }
    return out;
  }
  const dpos = G ? (G.down[0] ?? G.first[0])?.pos : undefined;   // (bar cues: on the bar's first kick, else its first real drum)
  for (let b = b0; b <= b1; b++) {
    const k = b - D; if (k < 1 || k >= 64) continue;
    const bp = ((b % 4) + 4) % 4;
    switch (p.sfx) {
      case 'kick': if (m.kickOn && (k < 32 || k % 2 === 0)) hit('flame', b, 0.45, 0.85, k % 2 ? -1 : 1); break;
      case 'call': if (bp === 0 || bp === 2) hit('flame', b, 0.5, 0.9, bp === 0 ? -1 : 1); break;
      case 'bar': if (bp === 0) hit('flame', b + (dpos ?? 0), 0.6, 1, 0); break;
      case 'chase': if (k % 8 === 0) hit('flame', b + (bp === 0 ? dpos ?? 0 : 0), 0.4, 0.9, 0, { order: 'lr', span: 2 }); break;
      case 'centre': if (k % 8 === 4) hit('flame', b + (bp === 0 ? dpos ?? 0 : 0), 0.5, 1, 0, { order: 'out', span: 1 }); break;
      case 'wave': if (k % 16 === 0) hit('flame', b + (bp === 0 ? dpos ?? 0 : 0), 1.2, 0.9, 0, { order: 'wave', span: 4 }); break;
      case 'gerbs': if (k % 32 === 0) hit('gerb', b, 4, 0.8, 0); break;
    }
  }
  return out;
}
