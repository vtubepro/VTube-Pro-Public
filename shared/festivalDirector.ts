// The festival show director + fixture evaluator: pure functions of the music clock and the show (no three.js, no
// state), so the studio preview, every OBS page, party guests and the Look Lab show the same frame for the same beat.
//
//   direct()      song section → look (rotating per block, cross-faded), the build countdown (phrase lookahead: strobe
//                 division 4 → 8 → 16 over the last 4 / 2 / 1 bars, beams tightening to the centre, a half-beat blackout),
//                 the drop (white hit, blinders, CO2, flames, confetti; flames on the kick pattern for 8 bars), phrase
//                 accents and the special-effects schedule (sfxHits) for the show's drop style
//   eval*()       one fixture's level / colour / pan-tilt for a look at a musical moment (movers, washes, pars, pixels,
//                 strobes, blinders, lasers)
// Times are in BEATS on the shared grid (MusicState.beat); the renderers turn ages into seconds with the BPM.
import { clamp01, fract, hash3, hashStr, hexRgb, type FestivalConfig, type FestivalCueStep, type FxKind, type FxOrder, type FxStyle } from './festival.ts';
import { accentById, catalogue, genreById, genreForBpm, motionById, rhythmById, SPREADS, type Catalogue, type DropStyle, type Look, type Palette, type RhythmKind, type Section, type Show, type SpreadKind } from './festivalLooks.ts';
import { HIT_LEAD_MS, lastHit, planParts, type Feel, type GrooveHit, type LastHit, type RhythmMode } from './groove.ts';
import { festPackFlat, festPackLaser, festPackMover, festPackStrobe, packHits, packPaletteId } from './showPack/festival.ts';
import { drumKey } from './showPack/rhythm.ts';
import type { PackLaserOut } from './showPack/program.ts';
import { newRoleFrame, roleFrame, type RoleFrame } from './festivalRoles.ts';

// ---------------------------------------------------------------------------------------------------- music state
export interface MusicState {
  /** real music input (false = the built-in auto show) */
  live: boolean;
  bpm: number;
  /** continuous beat position on the shared grid; bar position 0..4; bar index */
  beat: number; barPos: number; bar: number;
  /** beats into the source's current phrase (Pro DJ Link knows it; null / missing = unknown) */
  phraseBeat?: number | null;
  section: Section;
  /** beat index where the current section started, and the section before it */
  sectionStart: number; prevSection: Section;
  energy: number;
  /** envelopes 0..1 */
  kick: number; snare: number; hat: number;
  /** the track has a kick right now (flames follow the kick pattern only when there is one) */
  kickOn: boolean;
  /** beat index of the latest drop downbeat (-Infinity = none yet) and how many drops so far */
  lastDrop: number; dropCount: number;
  /** beat index of the next drop: known (DJ software phrase data) or predicted (a build ends on a phrase boundary) */
  nextDrop: number | null; known: boolean;
  /** the rhythm (shared/groove.ts; absent = 'grid' as before): the grid, the learned groove's hits (flash-limited plan,
   *  beats from the downbeat), or free (onset / energy); the feel, half-time */
  rhythm?: RhythmMode; plan?: GrooveHit[]; feel?: Feel; half?: boolean; onset?: number;
  /** the feel the 'auto' show family follows, latched (src/scene/festival/music.ts: 4 bars running, frozen in builds and
   *  16 bars after a drop); null = none latched yet (the tempo's family); absent = the raw feel (older callers) */
  showFeel?: Feel | null;
}

export const SECTION_OF_PACKET: Record<string, Section> = { listening: 'intro', intro: 'intro', groove: 'groove', buildup: 'build', breakdown: 'breakdown', drop: 'drop', chorus: 'drop' };

// ---------------------------------------------------------------------------------------------------- the drop sequences
export interface DropSeq {
  /** bars of countdown (strobe divisions per bar over the last 4 / 2 / 1 bars) */
  divs: [number, number, number];
  /** blackout before the drop (beats) */
  blackout: number;
  /** flames on the kicks after the drop: [every beat for n beats, then every 2nd beat until m, then every beat to k] */
  kickFlames: [number, number, number] | null;
  co2: boolean; confettiEvery: number; fireworksEvery: number; gerbs: boolean; comet: boolean;
  /** flames on beat 3 of each bar (half-time drops) for n bars */
  halftimeFlames: number;
  /** blinders on every n-th bar's downbeat while the drop runs (0 = only the drop hit) */
  blinderBars: number;
}
export const DROP_SEQS: Record<DropStyle, DropSeq> = {
  // research (DJ_INTEGRATION.md §4): ramp, beams to centre, 4→8→16 strobes, blackout ½ beat, flames + CO2 + confetti
  // on the downbeat, then flames pulse on the kicks for the first 8 bars (budgeted)
  hardstyle: { divs: [4, 8, 16], blackout: 0.5, kickFlames: [8, 24, 32], co2: true, confettiEvery: 2, fireworksEvery: 4, gerbs: true, comet: true, halftimeFlames: 0, blinderBars: 0 },
  hardcore: { divs: [8, 16, 16], blackout: 0.5, kickFlames: [16, 24, 32], co2: true, confettiEvery: 3, fireworksEvery: 4, gerbs: true, comet: true, halftimeFlames: 0, blinderBars: 4 },
  edm: { divs: [4, 8, 16], blackout: 0.5, kickFlames: null, co2: true, confettiEvery: 1, fireworksEvery: 4, gerbs: true, comet: false, halftimeFlames: 0, blinderBars: 0 },
  trance: { divs: [2, 4, 8], blackout: 1, kickFlames: null, co2: true, confettiEvery: 1, fireworksEvery: 2, gerbs: true, comet: true, halftimeFlames: 0, blinderBars: 0 },
  techno: { divs: [4, 4, 8], blackout: 0, kickFlames: null, co2: true, confettiEvery: 0, fireworksEvery: 0, gerbs: false, comet: false, halftimeFlames: 0, blinderBars: 4 },
  dubstep: { divs: [4, 8, 16], blackout: 1, kickFlames: null, co2: true, confettiEvery: 2, fireworksEvery: 4, gerbs: false, comet: false, halftimeFlames: 4, blinderBars: 0 },
  chill: { divs: [0, 0, 0], blackout: 0, kickFlames: null, co2: false, confettiEvery: 2, fireworksEvery: 0, gerbs: false, comet: false, halftimeFlames: 0, blinderBars: 0 },
};

/** One special-effect hit: fires at `beat` for `dur` beats. `side` −1 / 0 / 1 = left / all / right half of the group. */
export interface SfxHit {
  kind: FxKind | 'blinder'; group: string;
  /** the beat it fires (fireworks: the beat the shell BURSTS - it is launched its lift time earlier) */
  beat: number; dur: number; power: number; seed: number; side: -1 | 0 | 1; shape?: string; key: string;
  /** a chase across the group's units (firing order, over `span` beats) and a variant (green flames, waterfalls, …) */
  order?: FxOrder; span?: number; style?: FxStyle;
  /** comet fans: comets, angle / row width, lean; colours (shared/festivalFans.ts) */
  count?: number; spread?: number; tilt?: number; color?: string; color2?: string;
}
/** How early (seconds) a firework hit is in the frame before its burst beat: the longest shell lift. */
export const FIREWORK_LEAD = 3.6;
/** How long a hit stays visible after it starts (beats at 150 BPM ≈ 0.4 s / beat). */
export const SFX_LIFE: Record<string, number> = { flame: 1.5, co2: 8, confetti: 28, gerb: 3, comet: 8, firework: 14, blinder: 2, strobe: 1, par: 1 };

function push(out: SfxHit[], kind: SfxHit['kind'], beat: number, dur: number, power: number, side: -1 | 0 | 1, group = '', shape?: string, x?: Pick<FestivalCueStep, 'order' | 'span' | 'style' | 'count' | 'spread' | 'tilt' | 'color' | 'color2'>) {
  out.push({ kind, group, beat, dur, power, seed: Math.floor(hash3(Math.round(beat * 4), hashStr(kind + group + (x?.style ?? '')), side + 2) * 2 ** 31), side, ...(shape ? { shape } : {}),
    ...(x?.order ? { order: x.order, span: x.span ?? 1 } : {}), ...(x?.style ? { style: x.style } : {}),
    ...(x?.count !== undefined ? { count: x.count } : {}), ...(x?.spread !== undefined ? { spread: x.spread } : {}), ...(x?.tilt !== undefined ? { tilt: x.tilt } : {}),
    ...(x?.color ? { color: x.color } : {}), ...(x?.color2 ? { color2: x.color2 } : {}),
    key: `${kind}|${group}|${Math.round(beat * 4)}|${side}|${shape ?? ''}|${x?.style ?? ''}|${x?.order ?? ''}${x?.count !== undefined || x?.tilt !== undefined ? `|${x?.count ?? ''}|${x?.tilt ?? ''}` : ''}` });
}
/** Cue steps (a room cue, a scripted show's cues) fired at beat `at0` → hits. */
export function cueHits(steps: readonly (FestivalCueStep & { beat?: number })[], at0: number, out: SfxHit[] = []): SfxHit[] {
  for (const s of steps) push(out, s.kind === 'blackout' ? 'blinder' : s.kind, (s.beat ?? at0 + s.at), s.dur, s.kind === 'blackout' ? 0 : s.power, s.side ?? 0, s.group, s.shape, s);
  return out;
}

/** Every special-effect hit of a drop that started at beat D (the drop's own schedule, for the 8+ bars after it). */
export function dropHits(seq: DropSeq, D: number, dropCount: number, kickOn: boolean, pyro: boolean, cfg?: Pick<FestivalConfig, 'cues' | 'shapes'> | null, dropCue?: string,
  g?: Partial<Pick<MusicState, 'beat' | 'barPos' | 'rhythm' | 'plan'>> | null): SfxHit[] {
  const out: SfxHit[] = [];
  push(out, 'blinder', D, 0.6, 1, 0);
  if (!pyro) return out;
  if (seq.co2) push(out, 'co2', D, 1.6, 1, 0);
  if (seq.kickFlames || seq.halftimeFlames) push(out, 'flame', D, 1.2, 1.2, 0);
  if (seq.confettiEvery && dropCount % seq.confettiEvery === 1 % seq.confettiEvery) push(out, 'confetti', D, 2, 1, 0);
  if (seq.gerbs) push(out, 'gerb', D, 8, 1, 0);
  if (seq.fireworksEvery && dropCount > 0 && dropCount % seq.fireworksEvery === 0) { push(out, 'firework', D, 1, 1, 0); push(out, 'firework', D + 4, 1, 1, -1); push(out, 'firework', D + 6, 1, 1, 1); }   // (bursts >= 4 / 2 beats apart: <= 2 in any second at 230 BPM)
  if (seq.comet) push(out, 'comet', D + 16, 1, 1, 0);
  // (with a groove every timed cue below lands on a real drum: kicks for the kick flames, the snare from beat 3 for the
  //  half-time flames, the bar's first real drum for blinders and the skyline; none in the groove = no cue)
  const G = g?.rhythm === 'groove' && g.plan?.length && Number.isFinite(g.beat) && Number.isFinite(g.barPos) ? planParts(g.plan) : null;
  const first = G?.first[0]?.pos;
  if (seq.kickFlames && kickOn) {
    const [a, b, c] = seq.kickFlames;
    // (with a groove the flames take the track's real kicks - its plan on the clock's bars - instead of every grid beat)
    const K = G ? G.kicks : null;
    if (K) {   // (a groove without kicks: no kick flames - never the grid's every-beat loop)
      const bar0 = (g!.beat as number) - (g!.barPos as number);
      let n = 0;
      for (let j = Math.floor((D - bar0) / 4); bar0 + j * 4 < D + c; j++) for (const h of K) {
        const k = bar0 + j * 4 + h.pos - D;
        if (k < 1 || k >= c) continue;
        n++;
        if (k < a) push(out, 'flame', D + k, 0.45, 0.85, n % 2 ? -1 : 1);
        else if (k < b) { if (n % 2 === 0) push(out, 'flame', D + k, 0.5, 1, 0); }
        else push(out, 'flame', D + k, 0.4, 0.75 + 0.1 * (k - b) / Math.max(1, c - b), 0);
      }
    } else for (let k = 1; k < c; k++) {
      if (k < a) push(out, 'flame', D + k, 0.45, 0.85, k % 2 ? -1 : 1);                 // every kick, alternating sides
      else if (k < b) { if (k % 2 === 0) push(out, 'flame', D + k, 0.5, 1, 0); }        // every 2nd kick, both sides
      else push(out, 'flame', D + k, 0.4, 0.75 + 0.1 * (k - b) / Math.max(1, c - b), 0); // crescendo into the next phrase
    }
    // the last bar: the flame skyline (a room shape if it has one)
    const sky = cfg?.shapes && Object.keys(cfg.shapes).find((s) => /sky|line|skyline/.test(s));
    if (sky && (!G || first !== undefined)) push(out, 'flame', G ? D + c - 4 + first! : D + c - 2, 1.6, 1.3, 0, '', sky);
  }
  const s3 = G?.snares.find((h) => h.pos >= 1.75)?.pos;
  if (seq.halftimeFlames && kickOn && (!G || s3 !== undefined)) for (let b = 0; b < seq.halftimeFlames; b++) push(out, 'flame', D + b * 4 + (G ? s3! : 2), 0.6, 1, b % 2 ? 1 : -1);
  if (seq.blinderBars && (!G || first !== undefined)) for (let b = seq.blinderBars; b < 16; b += seq.blinderBars) push(out, 'blinder', D + b * 4 + (G ? first! : 0), 0.4, 0.7, 0);
  // the room's own drop cue (scene.json festival.cues[show.dropCue], e.g. a burst pattern from named CO2 jets)
  const cue = dropCue ? cfg?.cues?.[dropCue] : undefined;
  if (cue) cueHits(cue, D, out);
  return out;
}

// ---------------------------------------------------------------------------------------------------- the director
export interface DirectorFrame {
  show: Show; look: Look; prev: Look | null; mix: number;
  section: Section; secBeat: number;
  /** master level, blackout 0..1, build ramp 0..1, beams pulled to the centre 0..1 */
  level: number; blackout: number; build: number; converge: number;
  /** countdown strobe rate (Hz, before the photosensitivity cap) and beats to the drop */
  strobeHz: number; countdown: number | null;
  /** drop white hit 0..1 and its key (gate), blinder level 0..1 */
  white: number; whiteKey: string; blinder: number;
  /** the gate key of the blinder hit now lighting (one flash decision per hit, not per frame) */
  blinderKey: string;
  /** special effects now visible (start ≤ beat < start + life) */
  hits: SfxHit[];
  /** beats since the last drop (Infinity = none) */
  dropAge: number;
  /** a pinned look (it plays its own palette) */
  pinned?: boolean;
}
export interface DirectOpts {
  pyro: boolean;
  killed?: Set<string> | null;
  /** a pinned look id (Look Lab / Scene tab "use this look") */
  pinned?: string;
  cfg?: Pick<FestivalConfig, 'cues' | 'shapes'> | null;
  /** more hits (a scripted show's cues, the background show's moments), absolute beats - kept while alive like the rest */
  extraHits?: SfxHit[];
  /** the room's house look (festival.house): 'auto' at hard-dance tempos plays that house show */
  house?: string | null;
}

/** The show for a state value ('auto' → genre by tempo; the palette family changes every 4 drops). A room with a house
 *  look (`house`) plays its house show at hard-dance tempos (the house shows are never in auto's rotation otherwise). */
export function resolveShow(cat: Catalogue, show: string, m: Pick<MusicState, 'bpm' | 'dropCount'> & Partial<Pick<MusicState, 'feel' | 'showFeel'>>, house?: string | null): Show {
  const s = cat.showById.get(show);
  if (s) return s;
  // (the feel picks the family when the tempo alone would lie: a half-time 140 is dubstep, not trance; a backbeat at
  // 172 is drum & bass / rap, not hardcore)
  const feel = m.showFeel !== undefined ? m.showFeel ?? undefined : m.feel;
  const g = feel === 'half' && m.bpm >= 120 ? 'dubstep' : (feel === 'back' || feel === 'break') && m.bpm >= 160 ? 'dnb' : (feel === 'back' || feel === 'sparse') && m.bpm < 100 ? 'chill' : genreForBpm(m.bpm);
  // the room's own shows first (its theme), for this genre - else any of the room's shows of a close genre - else ours
  const own = cat.shows.filter((x) => x.room && x.genre === g);
  if (!own.length && house) { const hs = cat.showById.get(`${g}_${house}`); if (hs) return hs; }
  const list = own.length ? own : cat.shows.filter((x) => x.genre === g && !x.house);
  const fams = list.length ? list : cat.shows.filter((x) => !x.house);
  return fams[Math.floor(Math.max(0, m.dropCount) / 4) % fams.length];
}

/** share of phrases a show gives its show-pack pool (the others play its own looks, picked exactly as before the pack) */
export const PACK_SHARE = 0.6;
function pickLook(cat: Catalogue, show: Show, sec: Section, block: number, salt: number, killed?: Set<string> | null): Look {
  let pk = show.pack?.[sec] ?? [];
  if (pk.length && killed?.size) pk = pk.filter((id) => !killed.has(id));
  if (pk.length && hash3(salt, block, 29) < (show.packShare ?? PACK_SHARE)) return cat.byId.get(pk[Math.floor(hash3(salt, block, 31) * pk.length) % pk.length]) ?? cat.looks[0];
  let ids = show.sections[sec].length ? show.sections[sec] : show.sections.groove;
  if (killed?.size) { const alive = ids.filter((id) => !killed.has(id)); if (alive.length) ids = alive; }
  const id = ids[(salt + block) % ids.length];
  return cat.byId.get(id) ?? cat.looks[0];
}

const PH: SfxHit[] = [];   // (scratch: the show pack's cue list, reused every frame)
export function direct(cat: Catalogue, showId: string, m: MusicState, o: DirectOpts): DirectorFrame {
  const show = resolveShow(cat, showId, m, o.house);
  const seq = DROP_SEQS[show.drop];
  const beat = m.beat;
  const dropAge = Number.isFinite(m.lastDrop) ? beat - m.lastDrop : Infinity;
  // the drop section holds for 16 bars after a detected drop even when the section tracker wavers
  const sec: Section = dropAge >= 0 && dropAge < 64 && m.section !== 'breakdown' && m.section !== 'build' ? 'drop' : m.section;
  const start = sec === 'drop' && dropAge >= 0 && dropAge < 64 ? m.lastDrop : m.sectionStart;
  const secBeat = Math.max(0, beat - start);
  const salt = Math.floor(hash3(Math.round(start), hashStr(show.id)) * 997);
  const blockBeats = sec === 'build' ? 1e9 : (sec === 'breakdown' || sec === 'intro' || sec === 'outro' ? 16 : show.rotate) * 4;
  const block = Math.floor(secBeat / blockBeats);
  const pinned = o.pinned ? cat.byId.get(o.pinned) : undefined;
  let look = pinned ?? pickLook(cat, show, sec, block, salt, o.killed);
  let prev: Look | null = null, mix = 1;
  if (!pinned) {
    const xf = sec === 'drop' || sec === 'build' ? 0 : sec === 'groove' ? 4 : 8;   // beats of cross-fade (drops cut)
    const into = secBeat - block * blockBeats;
    if (xf > 0 && into < xf) {
      prev = block > 0 ? pickLook(cat, show, sec, block - 1, salt, o.killed) : pickLook(cat, show, m.prevSection, 0, Math.floor(hash3(Math.round(start) - 1, hashStr(show.id)) * 997), o.killed);
      mix = clamp01(into / xf);
      if (prev.id === look.id) { prev = null; mix = 1; }
    }
  }
  // build countdown (phrase lookahead)
  let build = 0, converge = 0, strobeHz = 0, blackout = 0, countdown: number | null = null;
  const toDrop = m.nextDrop != null ? m.nextDrop - beat : Infinity;
  if (sec === 'build') {
    const len = m.nextDrop != null ? Math.max(8, m.nextDrop - m.sectionStart) : 32;
    build = clamp01(m.nextDrop != null ? 1 - toDrop / len : secBeat / 32);
    converge = Math.pow(build, 1.5);
    if (toDrop > 0 && toDrop <= 16) {
      countdown = Math.ceil(toDrop);
      const div = toDrop <= 4 ? seq.divs[2] : toDrop <= 8 ? seq.divs[1] : seq.divs[0];
      strobeHz = div / 4 * m.bpm / 60;
      if (toDrop <= seq.blackout) blackout = 1;
    }
    if (!m.kickOn && toDrop > 16) converge *= 0.6;
  }
  // the drop: white hit + blinders (decay ~300 ms), release the beams
  let white = 0, blinder = 0;
  const whiteKey = `drop${Math.round(m.lastDrop)}`;
  const secPerBeat = 60 / Math.max(40, m.bpm);
  if (dropAge >= 0 && dropAge < 4) {
    const s = dropAge * secPerBeat;
    white = Math.exp(-s / 0.12);
    blinder = Math.exp(-s / 0.35);
  }
  // hits: the drop schedule of the last (and the one before, for long-lived confetti) drops + phrase accents
  const hits: SfxHit[] = [];
  const lead = FIREWORK_LEAD / secPerBeat;
  const keep = (h: SfxHit) => { const life = (SFX_LIFE[h.kind] ?? 2) + h.dur + (h.span ?? 0); return beat >= h.beat - (h.kind === 'firework' ? lead : 0) && beat < h.beat + life; };
  if (Number.isFinite(m.lastDrop) && dropAge >= 0 && dropAge < 140) for (const h of dropHits(seq, m.lastDrop, m.dropCount, m.kickOn, o.pyro, o.cfg, show.dropCue, m)) if (keep(h)) hits.push(h);
  // phrase starts in a drop: a CO2 burst + gerbs (every 8 bars after the drop)
  if (o.pyro && sec === 'drop' && seq.co2) {
    const ph = Math.floor(dropAge / 32);
    for (const p of [ph, ph - 1]) {
      if (p < 1) continue;
      const pb = m.lastDrop + p * 32;
      const ph2: SfxHit[] = [];
      push(ph2, 'co2', pb, 0.8, 0.8, p % 2 ? -1 : 1);
      if (seq.gerbs) push(ph2, 'gerb', pb, 4, 0.8, 0);
      const pc = show.phraseCue ? o.cfg?.cues?.[show.phraseCue] : undefined;
      if (pc) cueHits(pc, pb, ph2);
      for (const h of ph2) if (keep(h)) hits.push(h);
    }
  }
  // accent blinders from the look (downbeat / every 4 bars) while the energy is up
  const acc = accentById(look.accent);
  if (acc && sec !== 'breakdown' && sec !== 'intro') {
    const PP = m.rhythm === 'groove' && m.plan?.length ? planParts(m.plan) : null, bi = Math.floor(beat), dpos = PP ? (PP.down[0] ?? PP.first[0])?.pos : undefined;
    // (on the bar's first kick, else its first real drum, when there is a groove: a blinder is a hit. That drum can sit in
    //  the bar's second half - a snare on 3 - so the blinder lives on past the barline: this bar's and the last bar's
    //  are both offered, and `keep` holds each for its whole life, from its drum on)
    const bar0 = dpos !== undefined ? beat - m.barPos + dpos : bi - Math.floor(m.barPos);
    for (const k of [0, -1]) {
      const b0 = bar0 + 4 * k, inBar4 = ((((m.bar + k) % 4) + 4) % 4) === 0;
      if (acc.blinder === 'downbeat') { const h: SfxHit[] = []; push(h, 'blinder', b0, 0.3, 0.55, 0); hits.push(...h.filter(keep)); }
      if (acc.blinder === 'bar4' && inBar4) { const h: SfxHit[] = []; push(h, 'blinder', b0, 0.4, 0.7, 0); hits.push(...h.filter(keep)); }
    }
  }
  // a show-pack look's own cues (flame patterns, CO2 in the build, answering blinders)
  if (look.pack) { PH.length = 0; for (const h of packHits(look.pack, m, sec, o.pyro, PH)) if (keep(h)) hits.push(h); }
  if (o.extraHits) for (const h of o.extraHits) if (keep(h)) hits.push(h);
  let blinderKey = blinder > 0 ? whiteKey : '';
  for (const h of hits) if (h.kind === 'blinder' && beat >= h.beat) { const v = h.power * Math.exp(-Math.max(0, beat - h.beat) * secPerBeat / 0.35); if (v > blinder) { blinder = v; blinderKey = h.key; } }
  const level = sec === 'breakdown' ? 0.55 : sec === 'intro' || sec === 'outro' ? 0.7 : sec === 'build' ? 0.65 + 0.35 * build : 1;
  return { show, look, prev, mix, section: sec, secBeat, level, blackout, build, converge, strobeHz, countdown, white, whiteKey, blinder, blinderKey, hits, dropAge, ...(pinned ? { pinned: true } : {}) };
}

// ---------------------------------------------------------------------------------------------------- fixture evaluation
/** Where a fixture is: x −1..1 (left → right of the rig), y 0..1 (low → high), z 0..1 (back → front), its index i of n
 *  in its class, and a stable seed. */
export interface FixGeo { x: number; y: number; z: number; i: number; n: number; seed: number }
/** One look evaluated at one moment (built once per frame per look, shared by every fixture). */
export interface LookFrame {
  look: Look; colors: [number, number, number][];
  beat: number; barPos: number; bar: number; bpm: number; energy: number; kick: number;
  build: number; converge: number; dropAge: number; level: number;
  /** phrase step (palette rotation), changes every 8 bars and on drops */
  step: number;
  /** the beat the movers MOVE on (default `beat`): with Safe flashes ON a calmer clock at fast tempi - bright beams
   *  sweeping across the frame turn the drawn picture as surely as a level change */
  motionBeat?: number;
  /** the rhythm the pulses follow (from MusicState) */
  rhythm?: RhythmMode; plan?: GrooveHit[]; half?: boolean; onset?: number; feel?: Feel;
  /** show-pack looks (shared/showPack): Safe flashes ON, the song section, the snare / hat envelopes (onsets = from the
   *  music's analysis, else the pack's grid stubs) */
  safe?: boolean; section?: Section; snare?: number; hat?: number; onsets?: boolean;
  /** the show's colour roles at this moment (a show with `roles`: shared/festivalRoles.ts) - the renderers colour each
   *  fixture class by them */
  roles?: RoleFrame;
}
/** the palette a look plays at this moment: a show-pack look plays the show's palettes (one step per 8 bars and per drop)
 *  unless it keeps its own or is pinned - the stage AND the room's own lights (festivalScene) read this */
export function framePaletteId(look: Look, m: Pick<MusicState, 'bar' | 'dropCount'>, d: Partial<Pick<DirectorFrame, 'show' | 'pinned'>>): string {
  const step = Math.floor(m.bar / 8) + Math.max(0, m.dropCount);
  // (a show with colour roles plays ITS palettes on every look - the house look is the show's, not the look's)
  if (d.show?.roles && !d.pinned && d.show.palettes.length) { const n = d.show.palettes.length; return d.show.palettes[((step % n) + n) % n]; }
  return look.pack && !d.pinned ? packPaletteId(look, d.show, step) : look.palette;
}
const RF: RoleFrame = newRoleFrame();   // (scratch: the roles at this moment - every look frame of a frame shares it)
export function lookFrame(cat: Catalogue, look: Look, m: Pick<MusicState, 'beat' | 'barPos' | 'bar' | 'bpm' | 'energy' | 'kick' | 'dropCount'> & Partial<Pick<MusicState, 'snare' | 'hat' | 'live' | 'lastDrop' | 'sectionStart' | 'section'>>, d: Pick<DirectorFrame, 'build' | 'converge' | 'dropAge' | 'level'> & Partial<Pick<DirectorFrame, 'section' | 'show' | 'pinned'>>): LookFrame {
  const step = Math.floor(m.bar / 8) + Math.max(0, m.dropCount);
  const pal = cat.palettes.get(framePaletteId(look, m, d));
  const colors = (pal?.colors ?? ['#ffffff', '#88aaff']).map(hexRgb);
  const x = m as Partial<MusicState>;
  const f: LookFrame = { look, colors, beat: m.beat, barPos: m.barPos, bar: m.bar, bpm: m.bpm, energy: m.energy, kick: m.kick, build: d.build, converge: d.converge, dropAge: d.dropAge, level: d.level, step,
    ...(x.rhythm ? { rhythm: x.rhythm, plan: x.plan, half: x.half, onset: x.onset, feel: x.feel } : {}) };
  if (look.pack) { f.section = d.section; f.snare = m.snare; f.hat = m.hat; f.onsets = !!m.live; }
  if (d.show?.roles) f.roles = roleFrame(d.show.roles, { beat: m.beat, bar: m.bar, barPos: m.barPos, dropCount: m.dropCount, lastDrop: m.lastDrop ?? (Number.isFinite(d.dropAge) ? m.beat - d.dropAge : -Infinity),
    sectionStart: m.sectionStart ?? m.beat - 16, section: d.section ?? m.section ?? 'groove', build: d.build }, RF);
  return f;
}

/** 0..1 position of a fixture along the look's spread (and how much of a cycle that is). */
export function orderOf(spread: SpreadKind, g: FixGeo): number {
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
const SPREAD_PHASE = new Map(SPREADS.map((s) => [s.id, s.phase]));

export interface Lvl { v: number; flash: boolean; key: string }
/** Rhythms that are "a pulse on the beat" (they follow the learned groove when the music isn't four-on-the-floor). */
const GROOVED = new Set<RhythmKind>(['kick', 'offbeat', 'alternate', 'swing', 'heartbeat', 'snare', 'halftime', 'downbeat']);
const LH: LastHit = { age: 0, w: 0, slot: 0, kind: 'kick', barOff: 0 };   // (scratch: no allocation per fixture)
/** A rhythm's intensity 0..1 for a fixture at a given order (o). `flash` = this level is a full-depth hit the gate
 *  must see (key = one decision per layer and hit). */
export function rhythmLevel(r: RhythmKind, f: LookFrame, o: number, phase: number, i: number, seed: number, out: Lvl): Lvl {
  // above 180 BPM (hardcore / uptempo) the beat pulses run at half time: a pulse on every beat would flash > 3 Hz
  // without the gate (they are not hit layers)
  // the music's own pattern (rhythm lane, shared/groove.ts): the beat-pulse rhythms hit the track's real kicks / snares
  // (pre-cued on the grid), the backbeat ones its snares; no clear pattern → they follow the onsets / energy
  out.flash = false; out.key = '';
  if (f.rhythm === 'groove' && f.plan && GROOVED.has(r)) {
    const P = planParts(f.plan), snareOnly = r === 'snare' || r === 'halftime';
    const plan = snareOnly ? P.snares : r === 'downbeat' ? P.down : f.plan;
    const h = lastHit(plan.length ? plan : f.plan, f.barPos + HIT_LEAD_MS * f.bpm / 60000, LH);
    const k = r === 'downbeat' ? 1.3 : r === 'halftime' || r === 'snare' ? 3 : 4.5;
    out.v = h ? 0.15 + 0.85 * h.w * Math.exp(-h.age * k) * (f.half && h.kind === 'snare' ? 1 : 0.92) : 0.15;
    return out;
  }
  // a stack fills on the drums (each step is a brightness accent: it lands on a drum), the 16th chase is a figure (it
  // travels; no unison gate jump on a 16th the music may not play)
  if (f.rhythm === 'groove' && f.plan?.length && r === 'sparkle') {   // (sparkles fire on the drums, a few fixtures each)
    const h = lastHit(f.plan, f.barPos + HIT_LEAD_MS * f.bpm / 60000, LH);
    out.v = h && hash3(Math.round(f.bar + h.barOff) * 16 + h.slot, i, Math.round(seed * 1e4)) > 0.72 ? 0.25 + 0.75 * Math.exp(-h.age * 3) : 0.08; return out;
  }
  if (f.rhythm === 'groove' && f.plan?.length && (r === 'stack' || r === 'sixteenth')) {
    // (the fill holds the last drum's place in ITS bar - across the bar line - until this bar's first drum resets it)
    if (r === 'stack') { const x = f.barPos + HIT_LEAD_MS * f.bpm / 60000, h = lastHit(f.plan, x, LH), pos = h ? x - h.age - 4 * h.barOff : 4; out.v = o <= pos / 4 + 0.02 ? 1 : 0.08; return out; }
    const head = fract(f.beat), d = Math.min(Math.abs(o - head), 1 - Math.abs(o - head)); out.v = 0.05 + 0.95 * Math.exp(-d * 14); return out;
  }
  // the hard grid chops (triplets, the gallop, the strobe chop) are hits too: with a groove they land on its drums (one
  // gate decision per drum), not on grid instants the music doesn't play
  if (f.rhythm === 'groove' && f.plan?.length && (r === 'triplet' || r === 'gallop' || r === 'strobe' || (r === 'riser' && !(f.build > 0)))) {
    const h = lastHit(f.plan, f.barPos + HIT_LEAD_MS * f.bpm / 60000, LH);
    out.v = h ? (r === 'strobe' ? (h.age < 0.22 ? 1 : 0.04) : 0.1 + 0.9 * h.w * Math.exp(-h.age * (r === 'gallop' ? 9 : r === 'riser' ? 6 : 5))) : 0.1;
    if (h) { out.flash = true; out.key = drumKey(r === 'strobe' ? 'sg' : r === 'gallop' ? 'gg' : r === 'riser' ? 'rg' : 'tg', Math.round(f.bar + h.barOff) * 16 + h.slot); }
    return out;
  }
  if (f.rhythm === 'free' && (GROOVED.has(r) || r === 'gallop' || r === 'triplet' || r === 'sixteenth' || r === 'strobe' || r === 'riser')) {
    out.v = 0.25 + 0.6 * Math.max(0, Math.min(1, f.onset ?? 0)) + 0.15 * (0.5 + 0.5 * Math.cos(2 * Math.PI * (f.beat / 8 - o * phase)));
    return out;
  }
  const half = f.bpm > 180 && (r === 'kick' || r === 'offbeat' || r === 'alternate' || r === 'swing' || r === 'heartbeat') ? 2 : 1;
  const b = (f.beat - o * phase) / half;
  const bp = fract(b), bar = fract(b / 4) * 4;
  out.flash = false; out.key = '';
  const dec = (x: number, k: number) => Math.exp(-Math.max(0, x) * k);
  let v = 1;
  switch (r) {
    case 'hold': v = 1; break;
    case 'kick': v = 0.18 + 0.82 * dec(bp, 4.5); break;
    case 'offbeat': v = 0.15 + 0.85 * dec(fract(b - 0.5), 6); break;
    case 'gallop': { const t = bp < 0.5 ? bp + 0.25 : bp < 0.75 ? bp - 0.5 : bp - 0.75; v = 0.1 + 0.9 * dec(t, 9); out.flash = true; out.key = `g${Math.floor(f.beat * 4)}`; break; }
    case 'chase': { const head = fract(f.beat / 4); const d = Math.min(Math.abs(o - head), 1 - Math.abs(o - head)); v = 0.06 + 0.94 * dec(d, 9); break; }
    case 'pingpong': { const t = fract(f.beat / 8) * 2; const head = t < 1 ? t : 2 - t; v = 0.06 + 0.94 * dec(Math.abs(o - head), 8); break; }
    case 'sparkle': { const s = Math.floor(f.beat * 4); const p = Math.min(0.28, 2.4 * 60 / (4 * Math.max(40, f.bpm))); v = hash3(s, i, Math.round(seed * 1e4)) > 1 - p ? 0.25 + 0.75 * dec(fract(f.beat * 4), 3) : 0.08; break; }
    case 'stack': v = o <= f.barPos / 4 + 0.02 ? 1 : 0.08; break;
    case 'alternate': v = ((Math.floor(f.beat / half) + i) % 2 === 0 ? 0.25 + 0.75 * dec(fract(f.beat / half), 3) : 0.1); break;
    case 'snare': { const t = bar < 1 ? bar + 1 : bar < 3 ? bar - 1 : bar - 3; v = 0.15 + 0.85 * dec(t, 3.5); break; }
    case 'halftime': { const t = bar < 2 ? bar + 2 : bar - 2; v = 0.12 + 0.88 * dec(t, 2.5); break; }
    case 'sixteenth': { const head = fract(f.beat); const d = Math.min(Math.abs(o - head), 1 - Math.abs(o - head)); v = 0.05 + 0.95 * dec(d, 14); out.flash = true; out.key = `x${Math.floor(f.beat * 4)}`; break; }
    case 'breathe': v = 0.35 + 0.65 * (0.5 + 0.5 * Math.cos(2 * Math.PI * (f.beat / 8 - o * phase))); break;
    case 'riser': { const rate = [1, 2, 4, 4][((Math.floor(f.beat / 4) % 4) + 4) % 4]; v = 0.15 + 0.85 * dec(fract(f.beat * rate), 6); out.flash = rate >= 4; out.key = `r${Math.floor(f.beat * rate)}`; break; }
    case 'wave': v = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(2 * Math.PI * (f.beat / 4 - o * Math.max(0.5, phase)))); break;
    case 'heartbeat': { const t = bar % 2; const h1 = dec(t, 7), h2 = dec(t - 0.3, 7) * (t >= 0.3 ? 1 : 0); v = 0.15 + 0.85 * Math.max(h1, 0.8 * h2); break; }
    case 'triplet': v = 0.12 + 0.88 * dec(fract(b * 3), 5); out.flash = true; out.key = `t${Math.floor(f.beat * 3)}`; break;
    case 'downbeat': v = 0.2 + 0.8 * dec(bar, 1.3); break;
    case 'swing': { const t = bp < 0.66 ? bp : bp - 0.66; v = 0.3 + 0.45 * dec(t, 5); break; }
    case 'strobe': v = fract(f.beat * 4) < 0.22 ? 1 : 0.04; out.flash = true; out.key = `s${Math.floor(f.beat * 4)}`; break;
  }
  out.v = v;
  return out;
}

/** The fixture's colour (0..1 sRGB) for the look: palette colours spread along the order, stepping every phrase. */
export function colorAt(f: LookFrame, o: number, i: number, out: [number, number, number]): [number, number, number] {
  const c = f.colors, k = c.length;
  const sp = f.look.spread;
  let a: number;
  // (indices wrap for negative phrase steps too: a fresh DJ clock counts its first bar as −1)
  const wrap = (x: number) => ((x % k) + k) % k;
  if (sp === 'unison') a = wrap(f.step);
  else if (sp === 'oddeven' || sp === 'blocks2' || sp === 'blocks4') a = wrap(Math.round(o * (k - 0.001) * 2) + f.step);
  else { const t = o * (k - 1) + f.step; const i0 = wrap(Math.floor(t)), i1 = (i0 + 1) % k, w = fract(t); out[0] = c[i0][0] + (c[i1][0] - c[i0][0]) * w; out[1] = c[i0][1] + (c[i1][1] - c[i0][1]) * w; out[2] = c[i0][2] + (c[i1][2] - c[i0][2]) * w; void i; return out; }
  out[0] = c[a][0]; out[1] = c[a][1]; out[2] = c[a][2];
  return out;
}

export interface MoverOut { level: number; flash: boolean; key: string; r: number; g: number; b: number; yaw: number; pitch: number; zoom: number }
/** Mover home pitch per class (deg above the horizon): beams reach for the sky, spots / washes into the crowd. */
const HOME: Record<'beam' | 'spot' | 'wash', number> = { beam: 58, spot: -18, wash: -30 };
const L: Lvl = { v: 0, flash: false, key: '' };
/** the level beams / spots never drop below on a pulse rhythm (kick, offbeat, snare, gallop, …) */
export const BEAM_FLOOR = 0.32;
const DARK_GAP = new Set<RhythmKind>(['chase', 'pingpong', 'stack', 'sparkle', 'strobe']);
const C3: [number, number, number] = [0, 0, 0];

/** A moving head (beam / spot / wash) for the look: pan (yaw, deg, 0 = towards the crowd, + = towards stage left / +x)
 *  and tilt (pitch, deg above the horizon), level, colour, zoom. */
export function evalMover(kind: 'beam' | 'spot' | 'wash', f: LookFrame, g: FixGeo, out: MoverOut): MoverOut {
  if (f.look.pack) return festPackMover(kind, f, g, out);
  const look = f.look;
  const mo = motionById(look.motion)!;
  const phase = SPREAD_PHASE.get(look.spread) ?? 0;
  const o = orderOf(look.spread, g);
  const mb = f.motionBeat ?? f.beat, calm = f.motionBeat != null;
  const t = mb / mo.rate - o * phase;
  const tw = 2 * Math.PI * t;
  const ease = (x: number) => { const c = Math.min(1, Math.max(0, x)); return c * c * (3 - 2 * c); };
  const amp = mo.amp * (0.75 + 0.25 * f.energy) * (1 + 0.35 * f.build);
  let yaw = g.x * 18, pitch = HOME[kind];
  const wing = g.x < 0 ? -1 : 1;
  switch (mo.id) {
    case 'still': yaw = g.x * 26 * amp; break;
    case 'sweep': yaw = Math.sin(tw) * 55 * amp + g.x * 8; break;
    case 'fan': yaw = g.x * (12 + 48 * (0.5 + 0.5 * Math.sin(tw))) * amp; pitch += -8 * Math.sin(tw); break;
    case 'ballyhoo': { const k = Math.floor(mb / 2), w = fract(mb / 2); const e = w < 0.35 ? w / 0.35 : 1; const s = (w2: number) => w2 * w2 * (3 - 2 * w2);
      const ya = (hash3(k - 1, g.i, 7) - 0.5) * 120, yb = (hash3(k, g.i, 7) - 0.5) * 120, pa = (hash3(k - 1, g.i, 9) - 0.5) * 70, pb = (hash3(k, g.i, 9) - 0.5) * 70;
      // (beams throw across the audience's airspace - from a high truss straight up they'd leave every wide shot)
      if (kind === 'beam') pitch = 36;
      yaw = (ya + (yb - ya) * s(e)) * amp; pitch += (pa + (pb - pa) * s(e)) * amp * 0.7; break; }
    case 'circle': yaw = Math.cos(tw) * 32 * amp + g.x * 10; pitch += Math.sin(tw) * 22 * amp; break;
    case 'fig8': yaw = Math.sin(tw) * 38 * amp; pitch += Math.sin(2 * tw) * 16 * amp; break;
    case 'tiltwave': yaw = g.x * 16; pitch += Math.sin(tw) * 32 * amp; break;
    case 'crossfire': yaw = -wing * (26 + 22 * (0.5 + 0.5 * Math.sin(tw))) * amp; pitch -= 12; break;
    case 'audience': yaw = g.x * 26 + Math.sin(tw) * 24 * amp; pitch = (kind === 'beam' ? 6 : -14) + Math.sin(tw * 2) * 8; break;
    case 'sky': yaw = g.x * 9 + Math.sin(tw) * 3; pitch = 84 - Math.abs(g.x) * 10; break;
    case 'converge': yaw = -g.x * 34; pitch = kind === 'beam' ? 48 : -10; pitch += Math.sin(tw) * 6 * amp; break;
    case 'vee': yaw = g.x * 46 * amp; pitch = kind === 'beam' ? 62 : pitch; break;
    case 'wave': yaw = Math.sin(2 * Math.PI * (mb / mo.rate - g.x * 0.5)) * 40 * amp; break;
    case 'snap': { const P = [[-30, 0], [30, -10], [0, 18], [g.x * 50, -6]], k = Math.floor(mb), a = P[((k % 4) + 4) % 4], b = P[(((k - 1) % 4) + 4) % 4];
      // (calm: the snap eases over 40 % of the step instead of jumping)
      const e = calm ? ease(fract(mb) / 0.4) : 1; yaw = (b[0] + (a[0] - b[0]) * e) * amp + g.x * 6; pitch += (b[1] + (a[1] - b[1]) * e) * amp; break; }
    case 'spiral': { const r = 10 + 30 * fract(mb / 8); yaw = Math.cos(tw) * r * amp; pitch += Math.sin(tw) * r * 0.7 * amp; break; }
    case 'pendulum': yaw = g.x * 12; pitch += Math.sin(tw) * 42 * amp; break;
    case 'searchlight': yaw = Math.cos(tw + g.x) * 50 * amp; pitch = 62 + Math.sin(tw + g.x) * 18; break;
    case 'bloom': yaw = Math.cos(tw) * 20 * amp + g.x * 14; pitch += Math.sin(tw) * 14 * amp; break;
    case 'xcross': yaw = (g.i % 2 ? 1 : -1) * 40 * amp * Math.sin(tw); pitch -= 6; break;
    case 'arc': yaw = g.x * 40 * amp; pitch = (kind === 'beam' ? 70 : pitch) - Math.abs(g.x) * 34 + Math.sin(tw) * 4; break;
    case 'lift': { const w = calm ? 0.5 - 0.5 * Math.cos(2 * Math.PI * mb / mo.rate) : fract(mb / mo.rate); pitch = (kind === 'beam' ? -5 : -25) + 90 * (w * w); yaw = g.x * 22; break; }
    case 'shake': { const q = mb * (calm ? 1 : 4), k = Math.floor(q), e = calm ? ease(fract(q)) : 1;   // (calm: one smooth move a beat)
      const hy = (j: number) => hash3(j, g.i) - 0.5, hp = (j: number) => hash3(j, g.i, 3) - 0.5;
      yaw = g.x * 26 + (hy(k - 1) + (hy(k) - hy(k - 1)) * e) * 14 * amp; pitch += (hp(k - 1) + (hp(k) - hp(k - 1)) * e) * 12 * amp; break; }
    case 'ripple': yaw = g.x * 20; pitch += Math.sin(2 * Math.PI * (mb / mo.rate - Math.abs(g.x))) * 28 * amp; break;
    case 'helix': yaw = Math.cos(tw + g.i * 0.6) * 34 * amp; pitch += Math.sin(tw + g.i * 0.6) * 20 * amp; break;
    case 'fanpump': { const w = calm ? 0.5 + 0.5 * Math.cos(2 * Math.PI * fract(mb)) : Math.exp(-fract(mb) * 4); yaw = g.x * (14 + 46 * w) * amp; pitch += 10 * w; break; }
  }
  // build: tighten to the centre; converge pulls everything onto the DJ
  const cv = f.converge;
  if (cv > 0) { yaw = yaw * (1 - cv) + (-g.x * 30) * cv; pitch = pitch * (1 - cv) + (kind === 'beam' ? 50 : -8) * cv; }
  const r = rhythmById(kind === 'wash' ? look.rhythm : look.beamRhythm)!;
  rhythmLevel(r.id, f, o, phase, g.i, g.seed, L);
  // beams and spots ride the pulse on top of a floor (a drop's beams stay up between kicks, as on a real main stage);
  // chases / stacks / sparkles / strobe chops keep their dark gaps - that's the look
  if (kind !== 'wash' && !DARK_GAP.has(r.id)) L.v = BEAM_FLOOR + (1 - BEAM_FLOOR) * L.v;
  colorAt(f, kind === 'beam' ? o : 1 - o, g.i, C3);
  out.level = L.v * f.level; out.flash = L.flash; out.key = L.key;
  out.r = C3[0]; out.g = C3[1]; out.b = C3[2];
  out.yaw = yaw; out.pitch = Math.max(-70, Math.min(89, pitch));
  out.zoom = mo.id === 'bloom' ? 0.5 + 0.5 * Math.sin(tw) : kind === 'beam' ? 0 : kind === 'spot' ? 0.35 : 0.8;
  return out;
}

export interface FlatOut { level: number; flash: boolean; key: string; r: number; g: number; b: number }
/** Washes, PAR cans and pixels: the look's rhythm over the spread, palette colours. */
export function evalFlat(f: LookFrame, g: FixGeo, out: FlatOut, rhythm?: RhythmKind): FlatOut {
  if (f.look.pack && !rhythm) return festPackFlat(f, g, out);
  const look = f.look;
  const phase = SPREAD_PHASE.get(look.spread) ?? 0;
  const o = orderOf(look.spread, g);
  rhythmLevel(rhythm ?? look.rhythm, f, o, phase, g.i, g.seed, L);
  colorAt(f, o, g.i, C3);
  out.level = L.v * f.level; out.flash = L.flash; out.key = L.key;
  out.r = C3[0]; out.g = C3[1]; out.b = C3[2];
  return out;
}

/** Strobes: white hits from the look's accent (snares / every beat in the drop / 16ths), the build countdown rate and
 *  the drop hit. Returns 0..1 and the gate key of the hit it belongs to. */
export function strobeLevel(f: LookFrame, d: Pick<DirectorFrame, 'strobeHz' | 'white' | 'whiteKey' | 'section'>, out: Lvl): Lvl {
  if (f.look.pack) return festPackStrobe(f, d, out);
  out.v = 0; out.flash = false; out.key = '';
  const acc = accentById(f.look.accent);
  const bar = fract(f.beat / 4) * 4;
  if (d.strobeHz > 0) {
    const per = d.strobeHz / (f.bpm / 60);              // flashes per beat
    const t = fract(f.beat * per);
    out.v = t < 0.3 ? 1 : 0; out.flash = true; out.key = `cd${Math.floor(f.beat * per)}`;
  } else if (acc && acc.strobe > 0 && d.section === 'drop' && f.rhythm === 'groove' && f.plan?.length) {
    // the drums own the pops: light accents on the snares, heavy ones on every drum (the plan, pre-cued); no drum = dark
    const P = planParts(f.plan), light = acc.strobe < 0.5, list = light ? P.snares : f.plan;
    const h = list.length ? lastHit(list, f.barPos + HIT_LEAD_MS * f.bpm / 60000, LH) : null;
    if (h) { out.v = Math.exp(-h.age * (light ? 8 : 9)); out.flash = true; out.key = drumKey(light ? 'sng' : 'acg', Math.round(f.bar + h.barOff) * 16 + h.slot); }
  } else if (acc && acc.strobe > 0 && d.section === 'drop') {
    const per = acc.strobe >= 0.9 ? 2 : acc.strobe >= 0.5 ? 1 : 0;
    if (per) { const t = fract(f.beat * per); out.v = Math.exp(-t * 9); out.flash = true; out.key = `ac${Math.floor(f.beat * per)}`; }
    else { const t = bar < 1 ? bar + 1 : bar < 3 ? bar - 1 : bar - 3; out.v = Math.exp(-t * 8); out.flash = true; out.key = `sn${Math.floor((f.beat - 1) / 2)}`; }
  }
  if (d.white > out.v) { out.v = d.white; out.flash = true; out.key = d.whiteKey; }
  return out;
}

export interface LaserOut { on: number; mode: string; rays: number; spread: number; yaw: number; pitch: number; spin: number; r: number; g: number; b: number; flash: boolean; key: string; /** mode 'pack': the show-pack formation (src/scene/festival/lasers.ts draws its rays) */ pack?: PackLaserOut }
/** A laser origin: mode, how many rays, fan width (deg), aim, spin (tunnels), level, colour. */
export function evalLaser(f: LookFrame, g: FixGeo, sec: Section, out: LaserOut): LaserOut {
  if (f.look.pack) return festPackLaser(f, g, sec, out);
  const look = f.look, acc = accentById(look.accent);
  const mode = look.laser;
  out.mode = mode; out.flash = false; out.key = '';
  const rate = acc?.laser ?? 'off';
  if (mode === 'off' || rate === 'off' || sec === 'intro' && f.energy < 0.3) { out.on = 0; return out; }
  const t = f.beat;
  let on = 1;
  // (with a groove the beat / 16th lasers ride the drums: a decay from each drum, a chop on each drum; no drum = no chop)
  const gh = f.rhythm === 'groove' && f.plan?.length ? lastHit(f.plan, f.barPos + HIT_LEAD_MS * f.bpm / 60000, LH) : undefined;
  if (rate === 'beat') on = gh !== undefined ? (gh ? 0.35 + 0.65 * Math.exp(-gh.age * 3) : 0.35) : 0.35 + 0.65 * Math.exp(-fract(t) * 3);
  else if (rate === '16th') {
    if (gh !== undefined) { on = gh && gh.age < 0.25 ? 1 : 0; if (gh) { out.flash = true; out.key = drumKey('lzg', Math.round(f.bar + gh.barOff) * 16 + gh.slot); } }
    else { on = fract(t * 4) < 0.5 ? 1 : 0; out.flash = true; out.key = `lz${Math.floor(t * 4)}`; }
  } else on = 0.8;
  if (sec === 'breakdown') on *= 0.6;
  const side = g.x < 0 ? -1 : 1;
  colorAt(f, (g.x + 1) / 2, g.i, C3);
  out.r = C3[0]; out.g = C3[1]; out.b = C3[2];
  out.rays = 1; out.spread = 40; out.yaw = -g.x * 10; out.pitch = 8; out.spin = 0;
  // (the rays MOVE on the calm clock when one is set (Safe flashes ON): bright rays sweeping across a region of the
  // frame - a red one most of all - are flashes the governors never see; a burst eases between aims instead of jumping)
  const mt = f.motionBeat ?? t, calm = f.motionBeat != null;
  switch (mode) {
    // (calm: every mode moves slowly enough that its rays stay bright on screen - a ray dimmed to nothing by its own speed
    // left Safe flashes ON without lasers; peak swing ~20-30 deg/s at the calm clock's 0.75 beats/s)
    case 'fan': out.spread = 30 + 40 * (0.5 + 0.5 * Math.sin(mt * Math.PI / (calm ? 8 : 4))); out.pitch = 6 + 6 * Math.sin(mt * Math.PI / (calm ? 16 : 8)); break;
    case 'sheet': out.spread = 80; out.pitch = 4 + 16 * (0.5 + 0.5 * Math.sin(mt * Math.PI / 4 + g.i)); break;
    case 'tunnel': out.spread = 18; out.pitch = 2; out.spin = mt * (calm ? 20 : 45); break;
    case 'scan': out.spread = 6; out.yaw = Math.sin(mt * Math.PI / (calm ? 4 : 2) + g.i) * (calm ? 35 : 50); out.pitch = 3 + 8 * Math.sin(mt * (calm ? Math.PI / 4 : Math.PI)); break;
    case 'cross': out.spread = 24; out.yaw = -side * 28 + Math.sin(mt * Math.PI / 4) * 10; out.pitch = 5; break;
    case 'liquid': out.spread = 110; out.pitch = 1.5 + 2.5 * Math.sin(mt * Math.PI / 8 + g.x * 2); break;
    case 'burst': {
      if (calm) { const m2 = mt / 2, k = Math.floor(m2), w = fract(m2), e = w * w * (3 - 2 * w), lerp = (a: number, b: number) => a + (b - a) * e;   // (a new aim every 2 beats)
        out.spread = 60 + 30 * Math.cos(Math.PI * mt); out.pitch = 10 + 20 * lerp(hash3(k - 1, g.i), hash3(k, g.i)); out.yaw = (lerp(hash3(k - 1, g.i, 3), hash3(k, g.i, 3)) - 0.5) * 40; break; }
      out.spread = 100 * Math.exp(-fract(t) * 2); out.pitch = 10 + 20 * hash3(Math.floor(t), g.i); out.yaw = (hash3(Math.floor(t), g.i, 3) - 0.5) * 40; break; }
  }
  out.on = on * f.level;
  return out;
}

/** Catalogue for a room config (shared cache). */
export const festivalCatalogue = (cfg: Pick<FestivalConfig, 'palettes' | 'shows'> & Partial<Pick<FestivalConfig, 'packPool' | 'packShare'>> | null) => catalogue(cfg ? { palettes: cfg.palettes, shows: cfg.shows, packPool: cfg.packPool, packShare: cfg.packShare } : null);
export { genreById };
export type { Palette };
