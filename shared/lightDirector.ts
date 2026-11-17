// The reactive light director: how a room's lights follow music — the engine of "Reactive lights" (calm / club /
// rave / match the room) and the public API other light rigs build on (the DJ stage registers fixture kinds, looks
// and shows here without touching the engine). Pure data + pure maths: every OBS page / guest / preview evaluates
// the same frame from the same beat clock, so they all agree.
//
// The rules it follows (pro auto-lighting: rekordbox Lighting, SoundSwitch, MaestroDMX; docs/SCENES.md "Reactive"):
//   - STRUCTURE changes the look (section changes + 8-bar phrases, from the studio's arranger); transients only
//     modulate inside it. Looks never change on a random kick.
//   - intensity (0..1, relative to the track) drives brightness; quiet parts are dim, the drop is bright.
//   - movement is on the GRID (beat phase from the clock — latency-free, never "late" detected kicks).
//   - designed palettes: 2-3 colours per look (base / contrast / accent), changed on phrase boundaries.
//   - white + strobes only on drops / peaks, through the photosensitivity gate (≤ 3 flashes / s by default).
//   - lights that aren't show lights (lamps, candles, windows, screens, signals) never dance (shared/lightRoles.ts).
//   - talking / no music = a calm idle look (the room as authored, breathing very slowly).
//
// ---------------------------------------------------------------- the API (for other rigs)
//   registerPalette({ id, colours: [base, contrast, accent?], mood })
//   registerLook({ id, layers: [{ roles?, kinds?, groups?, level: [lo, hi], colour, effects: [...] , white? }] })
//   registerShow({ id, name, mood, palettes: [...ids], sections: { idle, intro, groove, build, drop, breakdown }: lookId[], rotateBars })
//   registerFixtureKind(kind, { roles default, attrs })   (moving heads: pan / tilt / zoom; strobes: white; …)
//   evalFixture(show, fixture, frame, out)  →  out = { dim, r, g, b, white, pan, tilt, zoom }
// An Effect = a waveform over an attribute, `rate` cycles per beat, phase spread across the selection by position
// (x / y / z / angle / radius / index / random) with optional wings (mirror) — the grandMA "phaser" idea, synced to
// the beat clock. Fixtures are matched by role (lightRoles.ts), kind (emissive / point / spot / beam / wash / par /
// strobe / blinder / laser / pixelbar / ledwall / …) or group name.
import type { LightRole } from './lightRoles.ts';
import { HIT_LEAD_MS, lastHit, planEnvelopes, planFor, rhythmMode, type GrooveHit, type LastHit, type RhythmMode } from './groove.ts';

export type Mood = 'room' | 'calm' | 'club' | 'rave';
export const MOODS: { id: Mood; label: string; hint: string }[] = [
  { id: 'room', label: 'Match the room', hint: 'The room\'s own colours, gently following the music (default)' },
  { id: 'calm', label: 'Calm', hint: 'Soft colour swells with the music, no flashes' },
  { id: 'club', label: 'Club', hint: 'Colour pulses on the beat, sweeps every bar, a hit on the drop' },
  { id: 'rave', label: 'Rave', hint: 'Hard pulses, chases and strobes on drops (still safe-limited)' },
];
export const isMood = (v: unknown): v is Mood => v === 'room' || v === 'calm' || v === 'club' || v === 'rave';

export type DirSection = 'idle' | 'intro' | 'groove' | 'build' | 'drop' | 'breakdown';
export type FixtureKind = 'emissive' | 'point' | 'spot' | 'beam' | 'wash' | 'par' | 'strobe' | 'blinder' | 'laser' | 'pixelbar' | 'ledwall' | (string & {});
export type Wave = 'sine' | 'tri' | 'saw' | 'ramp' | 'square' | 'pulse' | 'random' | 'hold';
export type SpreadBy = 'x' | 'y' | 'z' | 'ang' | 'r' | 'index' | 'random';
export type ColourRule = 'authored' | 'base' | 'contrast' | 'accent' | 'split' | 'alt' | 'sweep' | 'roomTint';

export interface Effect {
  attr: 'dim' | 'mix' | 'white' | 'pan' | 'tilt' | 'zoom';
  wave: Wave;
  /** cycles per beat (0.25 = once a bar, 0.125 = every 2 bars, 2 = eighths) */
  rate: number;
  /** phase offset across the selection (0 = all together, 1 = one full cycle spread across the room) */
  spread?: number;
  by?: SpreadBy;
  /** mirror the spread around the middle (both walls move together) */
  wings?: boolean;
  depth: number;
  /** pulse / square duty (0..1 of the cycle) */
  width?: number;
  /** scale the depth by the kick presence (pulses only where there is a kick) */
  kick?: boolean;
  /** this is a "flash" (big brightness hit): it goes through the photosensitivity gate */
  flash?: boolean;
  /** phase offset (cycles) for every fixture: 0.5 = on the offbeat (show pack, shared/showPack) */
  phase?: number;
  /** scale the depth by the snare / hat envelope (when the frame has one; grid only otherwise) */
  onset?: 'snare' | 'hat';
}
export interface LookLayer {
  roles?: LightRole[];
  kinds?: FixtureKind[];
  groups?: string[];
  /** level at intensity 0 → 1 (1 = authored brightness) */
  level: [number, number];
  colour: ColourRule;
  /** how far toward the palette (0 = authored colour, 1 = palette) */
  tint?: number;
  effects: Effect[];
  /** white hit on the drop's downbeat (gated) */
  dropHit?: number;
}
export interface DirectorLook { id: string; layers: LookLayer[] }
export interface DirectorPalette { id: string; mood: Mood | 'any'; colours: [string, string, string?] }
export interface DirectorShow { id: string; name: string; mood: Mood; palettes: string[]; sections: Record<DirSection, string[]>; rotateBars: number; dropPalettes?: string[];
  /** a selection hook (show pack): the look id to play now (null / unknown = the section list's rotation) */
  pick?: (fr: MusicFrame) => string | null }

/** Where a fixture is (normalised over the room's fixtures; see lightShow.ts) + what it is. */
export interface FixtureInfo {
  role: LightRole; kind: FixtureKind; group: string;
  x: number; y: number; z: number; ang: number; r: number; i: number; n: number; seed: number;
  /** authored colour (linear 0..1) */
  base: [number, number, number];
}
/** The musical moment (from the page's beat clock). Ages in ms (Infinity = never). */
export interface MusicFrame {
  now: number; beat: number; bar: number; barPos: number; phraseId: number; phraseBeat: number;
  section: DirSection; sectionBeats: number; intensity: number; kick: number;
  kickAge: number; dropAge: number; buildK: number; bpm: number;
  /** photosensitivity gate: depth 0.1..1 for a flash `key` that started at `at` */
  gate: (key: string, at: number) => number;
  /** the room's own palette (linear RGB), for 'roomTint' / the 'room' mood */
  room?: [number, number, number][];
  /** the flash limit is on: anything that would swing a light more than ~3 times a second runs at half (or quarter)
   *  time instead (the output governor, shared/flashGovernor.ts, enforces the limit either way) */
  safe?: boolean;
  /** How the beat pulses follow the music (shared/groove.ts): 'grid' = every beat (four-on-the-floor), 'groove' = the
   *  track's real kick / snare slots, pre-cued on the grid (`plan`), 'free' = no clear pattern: pulses follow the
   *  onsets / energy smoothly (`onset`) instead of a guessed grid. Absent = 'grid' (as before). */
  rhythm?: RhythmMode;
  /** the hits of one bar (flash-limited), positions in beats from the downbeat */
  plan?: GrooveHit[];
  /** half-time feel: movement runs at half the tempo, the big hit is the snare on 3 */
  half?: boolean;
  /** 0 = sweeps / moves on the beat, 1 = at half the tempo (half-time feel / free); in between while a change of feel
   *  blends over a bar (frameFromClock) */
  slowK?: number;
  /** 0..1 onset / energy envelope for 'free' */
  onset?: number;
  /** onset envelopes 0..1 (the rhythm lane's detection; missing = grid only) */
  snare?: number; hat?: number;
  /** the groove plan's own kick envelope 0..1 (pre-cued, like its hits; 'groove' only): kick-scaled effects follow it so
   *  they rise WITH the plan's hits, not a few frames after them (an up-down-up wiggle = extra flashes) */
  kickCue?: number;
}
export interface FixtureOut { dim: number; r: number; g: number; b: number; white: number; pan: number; tilt: number; zoom: number }
export const newOut = (): FixtureOut => ({ dim: 1, r: 1, g: 1, b: 1, white: 0, pan: 0, tilt: 0, zoom: 0 });

// ---------------------------------------------------------------- registries
const PALETTES = new Map<string, DirectorPalette>();
const LOOKS = new Map<string, DirectorLook>();
const SHOWS = new Map<string, DirectorShow>();
const KINDS = new Map<string, { role: LightRole; attrs: Effect['attr'][] }>();
// Registries are shared by every room of the page. The built-ins below are sealed: another rig registers its own
// under a namespaced id ('<rig>:<name>', e.g. 'festival:hs_drop'), and replacing a built-in id needs
// `{ override: true }`. Everything is validated (finite numbers, real colours, known waveforms / attributes / roles,
// shows that name existing looks + palettes); a bad registration throws instead of drawing NaN light. Whatever a look
// does, its output still passes the photosensitivity governor (shared/flashGovernor.ts) — no flag can skip it.
let sealed = false;
const BUILTIN = new Set<string>();
const HEXRE = /^#[0-9a-fA-F]{6}$/;
const WAVES = new Set<Wave>(['sine', 'tri', 'saw', 'ramp', 'square', 'pulse', 'random', 'hold']);
const ATTRS = new Set<Effect['attr']>(['dim', 'mix', 'white', 'pan', 'tilt', 'zoom']);
const BYS = new Set<SpreadBy>(['x', 'y', 'z', 'ang', 'r', 'index', 'random']);
const COLOURS = new Set<ColourRule>(['authored', 'base', 'contrast', 'accent', 'split', 'alt', 'sweep', 'roomTint']);
const ROLES = new Set<string>(['practical', 'window', 'screen', 'signal', 'mood', 'deco', 'sign', 'show', 'accent']);
const fin = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
function claim(kind: string, id: string, override?: boolean) {
  if (typeof id !== 'string' || !/^[a-z0-9_]{1,32}(:[a-z0-9_]{1,32})?$/.test(id)) throw new Error(`light ${kind} id "${id}": use lower-case letters, digits, _ (and one ':' namespace)`);
  const key = `${kind}:${id}`;
  if (!sealed) { BUILTIN.add(key); return; }
  if (BUILTIN.has(key)) { if (!override) throw new Error(`light ${kind} "${id}" is built in: pass { override: true } to replace it`); return; }
  if (!id.includes(':')) throw new Error(`light ${kind} "${id}": name it '<your rig>:${id}' (built-in names are reserved)`);
}
export function registerPalette(p: DirectorPalette, o: { override?: boolean } = {}) {
  claim('palette', p.id, o.override);
  const cols = p.colours.filter((c) => c !== undefined);
  if (cols.length < 2 || !cols.every((c) => typeof c === 'string' && HEXRE.test(c))) throw new Error(`palette "${p.id}": 2-3 colours like '#ff2bd6'`);
  PALETTES.set(p.id, p); paletteCache.delete(p.id);
}
export function registerLook(l: DirectorLook, o: { override?: boolean } = {}) {
  claim('look', l.id, o.override);
  if (!Array.isArray(l.layers) || !l.layers.length || l.layers.length > 16) throw new Error(`look "${l.id}": 1-16 layers`);
  for (const y of l.layers) {
    if (!Array.isArray(y.level) || !fin(y.level[0], 0, 4) || !fin(y.level[1], 0, 4)) throw new Error(`look "${l.id}": level [lo, hi] within 0..4`);
    if (!COLOURS.has(y.colour)) throw new Error(`look "${l.id}": unknown colour rule "${y.colour}"`);
    if (y.tint !== undefined && !fin(y.tint, 0, 1)) throw new Error(`look "${l.id}": tint 0..1`);
    if (y.dropHit !== undefined && !fin(y.dropHit, 0, 1)) throw new Error(`look "${l.id}": dropHit 0..1`);
    if (y.roles && !y.roles.every((r) => ROLES.has(r))) throw new Error(`look "${l.id}": unknown role`);
    if (!Array.isArray(y.effects) || y.effects.length > 8) throw new Error(`look "${l.id}": at most 8 effects a layer`);
    for (const e of y.effects) {
      if (!ATTRS.has(e.attr) || !WAVES.has(e.wave)) throw new Error(`look "${l.id}": unknown attribute / waveform`);
      if (!fin(e.rate, 1 / 64, 16) || !fin(e.depth, -4, 4)) throw new Error(`look "${l.id}": rate (cycles a beat) 1/64..16 and depth -4..4`);
      if ((e.spread !== undefined && !fin(e.spread, -8, 8)) || (e.width !== undefined && !fin(e.width, 0.01, 1)) || (e.by !== undefined && !BYS.has(e.by))) throw new Error(`look "${l.id}": spread -8..8, width 0.01..1, by x|y|z|ang|r|index|random`);
      if ((e.phase !== undefined && !fin(e.phase, -1, 1)) || (e.onset !== undefined && e.onset !== 'snare' && e.onset !== 'hat')) throw new Error(`look "${l.id}": phase -1..1, onset snare|hat`);
    }
  }
  LOOKS.set(l.id, l);
}
export function registerShow(sh: DirectorShow, o: { override?: boolean } = {}) {
  claim('show', sh.id, o.override);
  if (!isMood(sh.mood) || !fin(sh.rotateBars, 1, 256) || !sh.palettes.length || !sh.palettes.every((p) => PALETTES.has(p))) throw new Error(`show "${sh.id}": a mood, rotateBars 1..256 and registered palettes`);
  if (sh.pick !== undefined && typeof sh.pick !== 'function') throw new Error(`show "${sh.id}": pick must be a function`);
  for (const sec of ['idle', 'intro', 'groove', 'build', 'drop', 'breakdown'] as DirSection[]) if (!(sh.sections[sec] ?? []).every((id) => LOOKS.has(id))) throw new Error(`show "${sh.id}": section ${sec} names a look that isn't registered`);
  if (sh.dropPalettes && !sh.dropPalettes.every((p) => PALETTES.has(p))) throw new Error(`show "${sh.id}": unknown drop palette`);
  SHOWS.set(sh.id, sh);
}
export function registerFixtureKind(kind: string, def: { role: LightRole; attrs: Effect['attr'][] }, o: { override?: boolean } = {}) {
  claim('kind', kind, o.override);
  if (!ROLES.has(def.role) || !def.attrs.every((a) => ATTRS.has(a))) throw new Error(`fixture kind "${kind}": a known role + attributes`);
  KINDS.set(kind, def);
}
export const showById = (id: string) => SHOWS.get(id) ?? null;
export const lookById = (id: string) => LOOKS.get(id) ?? null;
export const fixtureKind = (kind: string) => KINDS.get(kind) ?? null;
export const listShows = () => [...SHOWS.values()];

// ---------------------------------------------------------------- maths
const frac = (x: number) => x - Math.floor(x);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const hash1 = (a: number, b: number) => frac(Math.sin(a * 127.1 + b * 311.7) * 43758.5453);
function wave(w: Wave, u: number, width = 0.25, seed = 0, cyc = 0): number {
  switch (w) {
    case 'sine': return 0.5 - 0.5 * Math.cos(2 * Math.PI * u);
    case 'tri': return 1 - Math.abs(2 * u - 1);
    case 'saw': return 1 - u;
    case 'ramp': return u;
    case 'square': return u < width ? 1 : 0;
    case 'pulse': return Math.exp(-u / Math.max(0.02, width) * 2.3);    // a hit decaying over `width` of the cycle
    case 'random': return hash1(seed * 97 + 1, cyc);
    case 'hold': return 1;
  }
  return 0;
}
function coord(f: FixtureInfo, by: SpreadBy | undefined, wings: boolean | undefined): number {
  let c: number;
  switch (by ?? 'x') {
    case 'x': c = f.x; break; case 'y': c = f.y; break; case 'z': c = f.z; break; case 'ang': c = f.ang; break; case 'r': c = f.r; break;
    case 'index': c = f.n > 1 ? f.i / (f.n - 1) : 0; break; default: c = f.seed;
  }
  return wings ? 1 - Math.abs(2 * c - 1) : c;
}
const hex = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16);
  const lin = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)];
};
const paletteCache = new Map<string, [number, number, number][]>();
function paletteRgb(id: string): [number, number, number][] {
  let c = paletteCache.get(id);
  if (!c) { const p = PALETTES.get(id); c = (p?.colours.filter(Boolean) as string[] ?? ['#ffffff', '#ffffff']).map(hex); if (c.length < 3) c.push(c[0]); paletteCache.set(id, c); }
  return c;
}

/** The palette a show plays now: rotates every `rotateBars` and on every section change / drop (deterministic). */
export function showPalette(show: DirectorShow, fr: MusicFrame): [number, number, number][] {
  if (show.mood === 'room' && fr.room && fr.room.length) {
    // the room's own colours, rotating which one leads every phrase
    const k = Math.floor(fr.phraseId / 2) % fr.room.length;
    return [fr.room[k], fr.room[(k + 1) % fr.room.length], fr.room[(k + 2) % fr.room.length]];
  }
  const list = fr.section === 'drop' && show.dropPalettes?.length ? show.dropPalettes : show.palettes;
  const block = Math.floor(fr.phraseId / Math.max(1, show.rotateBars / 8));
  return paletteRgb(list[Math.floor(hash1(block, list.length) * list.length) % list.length]);
}

/** The look a show plays for a section now (rotates within the section's list every phrase). */
export function showLook(show: DirectorShow, fr: MusicFrame): DirectorLook | null {
  if (show.pick) { const id = show.pick(fr); const l = id ? LOOKS.get(id) : undefined; if (l) return l; }
  const ids = show.sections[fr.section]?.length ? show.sections[fr.section] : show.sections.groove;
  if (!ids?.length) return null;
  return LOOKS.get(ids[((fr.phraseId % ids.length) + ids.length) % ids.length]) ?? null;
}

const matches = (l: LookLayer, f: FixtureInfo) =>
  (!l.roles || l.roles.includes(f.role)) && (!l.kinds || l.kinds.includes(f.kind)) && (!l.groups || l.groups.includes(f.group));

/**
 * One fixture, one frame. `pal` = showPalette(show, fr) (compute once per frame). Writes `out` (dim 1 = authored
 * level; colour linear RGB; white 0..1 = how far to blend to white). Returns false when no layer drives the fixture
 * (the engine keeps its own program for it).
 */
const LH: LastHit = { age: 0, w: 0, slot: 0, kind: 'kick', barOff: 0 };   // (scratch: no allocation per fixture)
export function evalFixture(look: DirectorLook, f: FixtureInfo, fr: MusicFrame, pal: [number, number, number][], out: FixtureOut): boolean {
  let layer: LookLayer | null = null;
  for (const l of look.layers) if (matches(l, f)) { layer = l; break; }
  if (!layer) return false;
  const I = clamp01(fr.intensity);
  let dim = layer.level[0] + (layer.level[1] - layer.level[0]) * I;
  let mix = 0, white = 0, pan = 0, tilt = 0, zoom = 0;
  const mode = fr.rhythm ?? 'grid';
  for (const e of layer.effects) {
    const c = coord(f, e.by, e.wings);
    const moving = e.attr === 'pan' || e.attr === 'tilt';
    const beatHit = (e.wave === 'pulse' || e.wave === 'square') && !moving && e.rate >= 0.5 && e.rate <= 2;
    // flash limit: while the drop's white hit plays, it IS the hit (no beat pulse on top of it); right after a section
    // change the cut is the transition (the pulses come back a beat and a half later) - in every rhythm mode
    if (fr.safe && ((layer.dropHit && fr.dropAge >= 0 && fr.dropAge < 700) || fr.sectionBeats < 1.5) && !moving && (e.wave === 'pulse' || e.wave === 'square')) continue;
    // the music's own pattern (rhythm lane, shared/groove.ts): a beat pulse becomes the track's kick / snare hits,
    // pre-cued on the grid (rap: kick + snare, not every beat; half-time: the big hit on 3; breakbeat: its pattern)
    if (mode === 'groove' && beatHit && fr.section !== 'build' && fr.plan) {
      const h = lastHit(fr.plan, fr.barPos + HIT_LEAD_MS * fr.bpm / 60000, LH);
      if (h) {
        const width = Math.max(0.02, e.width ?? 0.25), u = Math.min(1, h.age * Math.min(1, e.rate));
        let depth = e.depth * h.w * (fr.half && h.kind === 'snare' ? 1.15 : 1);
        if (e.flash && depth > 0.3) depth *= fr.gate(`${e.attr}g:${fr.bar + h.barOff}:${h.slot}`, fr.now - h.age * 60000 / Math.max(40, fr.bpm));
        const v = e.wave === 'pulse' ? Math.exp(-u / width * 2.3) : u < width ? 1 : 0;
        if (e.attr === 'dim') dim += depth * (v - (e.wave === 'pulse' ? 0 : 0.5)); else if (e.attr === 'mix') mix += depth * v; else if (e.attr === 'white') white = Math.max(white, depth * v); else if (e.attr === 'zoom') zoom += depth * v;
      }
      continue;
    }
    // no clear pattern: the pulses follow the onsets / energy (smooth, no guessed grid)
    if (mode === 'free' && beatHit) {
      const v = Math.max(0, Math.min(1, fr.onset ?? 0)) * e.depth * 0.7;
      if (e.attr === 'dim') dim += v; else if (e.attr === 'mix') mix += v; else if (e.attr === 'white') white = Math.max(white, v * 0.5); else if (e.attr === 'zoom') zoom += v;
      continue;
    }
    // flash limit: a hit / step that would come more than 2.2 times a second plays at half time (beats, then bars):
    // every beat up to ~132 BPM, every other beat above (margin for tempo jitter under the 3 a second)
    let rate = e.rate;
    if (fr.safe && e.attr !== 'pan' && e.attr !== 'tilt' && e.wave !== 'sine' && e.depth >= 0.08) while (rate * fr.bpm / 60 > 2.2 && rate > 1 / 64) rate /= 2;
    // (half-time feel: sweeps, swells and moves count half the tempo; free: they keep moving, slowly. A change of feel
    //  blends the two time bases over a bar (fr.slowK) - movers and swells never jump in one frame)
    const sk = moving || e.wave === 'sine' || e.wave === 'tri' ? (fr.slowK ?? (fr.half || mode === 'free' ? 1 : 0)) : 0;
    const off = (e.spread ?? 0) * c + (e.phase ?? 0);
    const u0 = (sk >= 0.5 ? fr.beat / 2 : fr.beat) * rate + off;
    const u = frac(u0), cyc = Math.floor(u0);
    let v = wave(e.wave, u, e.width, f.seed, cyc);
    if (sk > 0 && sk < 1) {   // (mid-blend: the other base too - vFull + (vHalf - vFull) * sk)
      const u1 = (sk >= 0.5 ? fr.beat : fr.beat / 2) * rate + off, v1 = wave(e.wave, frac(u1), e.width, f.seed, Math.floor(u1));
      v = sk >= 0.5 ? v1 + (v - v1) * sk : v + (v1 - v) * sk;
    }
    let depth = e.depth * (e.kick ? clamp01((mode === 'groove' && fr.kickCue !== undefined ? fr.kickCue : fr.kick) * 1.4) : 1);
    if (e.onset) { const env = e.onset === 'snare' ? fr.snare : fr.hat; if (env !== undefined) depth *= clamp01(0.35 + env * 1.3); }
    if (e.flash && depth > 0.3) depth *= fr.gate(`${e.attr}${rate}:${cyc}`, fr.now - u * 60000 / Math.max(40, fr.bpm) / Math.max(1e-3, rate));
    switch (e.attr) {
      case 'dim': dim += depth * (v - (e.wave === 'pulse' ? 0 : 0.5)); break;
      case 'mix': mix += depth * v; break;
      case 'white': white = Math.max(white, depth * v); break;
      case 'pan': pan += depth * (v - 0.5) * 2; break;
      case 'tilt': tilt += depth * (v - 0.5) * 2; break;
      case 'zoom': zoom += depth * v; break;
    }
  }
  // the drop's downbeat: one big gated white hit
  if (layer.dropHit && fr.dropAge >= 0 && fr.dropAge < 700) {
    const d = Math.exp(-fr.dropAge / 160) * layer.dropHit * fr.gate('drophit', fr.now - fr.dropAge);
    dim = Math.max(dim, 1 + 0.5 * d); white = Math.max(white, d);
  }
  // colour
  const A = pal[0], B = pal[1], C = pal[2] ?? pal[0];
  let tr = 0, tg = 0, tb = 0;
  const pick = (k: number) => { const P = k === 0 ? A : k === 1 ? B : C; tr = P[0]; tg = P[1]; tb = P[2]; };
  switch (layer.colour) {
    case 'authored': tr = f.base[0]; tg = f.base[1]; tb = f.base[2]; break;
    case 'base': pick(0); break;
    case 'contrast': pick(1); break;
    case 'accent': pick(2); break;
    case 'split': pick((f.x < 0.5 ? 0 : 1) ^ (fr.phraseId & 1)); break;
    case 'alt': pick((f.i + Math.floor(fr.beat / (fr.safe && fr.bpm > 132 ? 2 : 1))) & 1); break;   // (a colour swap is a flash too)
    case 'sweep': { const k = clamp01(0.5 + 0.5 * Math.sin(2 * Math.PI * (f.x - fr.beat / 16))); tr = A[0] + (B[0] - A[0]) * k; tg = A[1] + (B[1] - A[1]) * k; tb = A[2] + (B[2] - A[2]) * k; break; }
    case 'roomTint': { const P = fr.room?.[f.i % Math.max(1, fr.room.length)] ?? A; tr = P[0]; tg = P[1]; tb = P[2]; break; }
  }
  if (mix > 0) { const m = clamp01(mix); tr += (B[0] - tr) * m; tg += (B[1] - tg) * m; tb += (B[2] - tb) * m; }
  const t = layer.tint ?? 1;
  if (t < 1) { tr = f.base[0] + (tr - f.base[0]) * t; tg = f.base[1] + (tg - f.base[1]) * t; tb = f.base[2] + (tb - f.base[2]) * t; }
  out.dim = Math.max(0, Math.min(1.8, dim)); out.r = tr; out.g = tg; out.b = tb; out.white = clamp01(white); out.pan = pan; out.tilt = tilt; out.zoom = zoom;
  return true;
}

// ---------------------------------------------------------------- built-in palettes, looks and shows
const P = (id: string, mood: Mood | 'any', ...c: string[]) => registerPalette({ id, mood, colours: [c[0], c[1], c[2]] });
// calm: analogous, soft
P('amber_rose', 'calm', '#ffb067', '#ff7a8a', '#ffd9a8'); P('blue_hour', 'calm', '#5ec8ff', '#7a7cff', '#c8f0ff');
P('lavender', 'calm', '#a08cff', '#ff9ad5', '#ffe1f0'); P('lagoon', 'calm', '#3fe0c0', '#4c9cff', '#d8fff4'); P('golden', 'calm', '#ffcf6a', '#ff9a4a', '#fff1d0');
// club: complementary pairs on different fixtures (never mixed on one surface)
P('magenta_cyan', 'club', '#ff2bd6', '#00e5ff', '#ffffff'); P('violet_mint', 'club', '#7c3cff', '#00ff9c', '#e8fff6'); P('orange_azure', 'club', '#ff6a00', '#00a8ff', '#fff0d8');
P('gold_purple', 'club', '#ffc800', '#9a2bff', '#fff6d0'); P('aqua_pink', 'club', '#00ffd5', '#ff4fd8', '#ffffff'); P('coral_blue', 'club', '#ff4f6a', '#2b6bff', '#ffe0e6');
// rave: hot neon, white for hits only
P('acid', 'rave', '#b0ff00', '#7a2bff', '#ffffff'); P('uv_green', 'rave', '#00ff4a', '#ff00d4', '#ffffff'); P('ice_fire', 'rave', '#00e5ff', '#ff5a00', '#ffffff'); P('pink_white', 'rave', '#ff00a8', '#00d0ff', '#ffffff');

const SHOWL: LightRole[] = ['show'], ACC: LightRole[] = ['accent'], DECO: LightRole[] = ['deco'], SIGN: LightRole[] = ['sign'];
const L = (id: string, ...layers: LookLayer[]) => registerLook({ id, layers });
const e = (attr: Effect['attr'], wave: Wave, rate: number, depth: number, o: Partial<Effect> = {}): Effect => ({ attr, wave, rate, depth, ...o });
// idle: no music / talking — the room as authored, breathing very slowly (no beat anywhere)
L('idle',
  { roles: ACC, level: [0.92, 0.92], colour: 'authored', effects: [e('dim', 'sine', 1 / 24, 0.08, { spread: 0.4, by: 'x' })] },
  { roles: SHOWL, level: [0.7, 0.7], colour: 'authored', effects: [e('dim', 'sine', 1 / 32, 0.1, { spread: 0.5, by: 'index' })] },
  { roles: DECO, level: [0.9, 0.9], colour: 'authored', effects: [e('dim', 'random', 1 / 4, 0.18)] },
  { roles: SIGN, level: [1, 1], colour: 'authored', effects: [] });
// calm
L('calm_flow',
  { roles: ACC, level: [0.55, 1.0], colour: 'sweep', tint: 0.75, effects: [e('dim', 'sine', 1 / 8, 0.18, { spread: 0.6, by: 'x' }), e('dim', 'pulse', 1, 0.1, { kick: true, width: 0.35 })] },
  { roles: SHOWL, level: [0.4, 0.85], colour: 'base', tint: 0.8, effects: [e('dim', 'sine', 1 / 4, 0.4, { spread: 1, by: 'x' }), e('pan', 'sine', 1 / 32, 0.3, { spread: 0.5, by: 'x' })] },
  { roles: DECO, level: [0.7, 1.0], colour: 'authored', effects: [e('dim', 'random', 1 / 2, 0.25)] },
  { roles: SIGN, level: [0.9, 1.05], colour: 'authored', effects: [e('dim', 'sine', 1 / 8, 0.12)] });
L('calm_break',
  { roles: ACC, level: [0.45, 0.8], colour: 'base', tint: 0.7, effects: [e('dim', 'sine', 1 / 16, 0.3, { spread: 1, by: 'x' })] },
  { roles: SHOWL, level: [0.25, 0.5], colour: 'contrast', tint: 0.8, effects: [e('dim', 'sine', 1 / 16, 0.3, { spread: 1, by: 'index' })] },
  { roles: DECO, level: [0.6, 0.9], colour: 'authored', effects: [e('dim', 'random', 1 / 4, 0.25)] },
  { roles: SIGN, level: [0.85, 0.95], colour: 'authored', effects: [] });
L('calm_lift',
  { roles: ACC, level: [0.7, 1.15], colour: 'split', tint: 0.8, effects: [e('dim', 'pulse', 1, 0.16, { kick: true, width: 0.3 }), e('dim', 'sine', 1 / 8, 0.12, { spread: 1, by: 'x' })], dropHit: 0.35 },
  { roles: SHOWL, level: [0.5, 1.0], colour: 'contrast', effects: [e('dim', 'sine', 1 / 2, 0.35, { spread: 1, by: 'x' })] },
  { roles: DECO, level: [0.8, 1.1], colour: 'authored', effects: [e('dim', 'random', 1, 0.3)] },
  { roles: SIGN, level: [1, 1.1], colour: 'authored', effects: [e('dim', 'pulse', 0.25, 0.12)] });
// club
L('club_groove',
  { roles: ACC, level: [0.45, 1.0], colour: 'split', effects: [e('dim', 'pulse', 1, 0.38, { kick: true, width: 0.3 }), e('dim', 'sine', 1 / 4, 0.12, { spread: 1, by: 'x' })] },
  { roles: SHOWL, level: [0.35, 0.9], colour: 'contrast', effects: [e('dim', 'pulse', 1 / 4, 0.9, { spread: 1, by: 'x', width: 0.35 }), e('pan', 'sine', 1 / 8, 0.5, { spread: 1, by: 'x', wings: true })] },
  { roles: DECO, level: [0.7, 1.05], colour: 'authored', effects: [e('dim', 'random', 1, 0.3)] },
  { roles: SIGN, level: [0.95, 1.15], colour: 'authored', effects: [e('dim', 'pulse', 0.25, 0.2, { width: 0.4 })] });
L('club_wave',
  { roles: ACC, level: [0.45, 1.0], colour: 'sweep', effects: [e('dim', 'pulse', 1, 0.32, { kick: true, width: 0.3 }), e('mix', 'sine', 1 / 8, 1, { spread: 1, by: 'x' })] },
  { roles: SHOWL, level: [0.35, 0.9], colour: 'base', effects: [e('dim', 'tri', 1 / 4, 0.8, { spread: 1, by: 'x', wings: true })] },
  { roles: DECO, level: [0.7, 1.05], colour: 'authored', effects: [e('dim', 'random', 1, 0.3)] },
  { roles: SIGN, level: [0.95, 1.15], colour: 'authored', effects: [e('dim', 'pulse', 0.25, 0.2, { width: 0.4 })] });
L('club_build',
  { roles: ACC, level: [0.35, 1.0], colour: 'base', effects: [e('dim', 'pulse', 1, 0.3, { width: 0.3 }), e('dim', 'pulse', 2, 0.2, { width: 0.4 })] },
  { roles: SHOWL, level: [0.3, 1.0], colour: 'contrast', effects: [e('dim', 'pulse', 1 / 2, 0.8, { spread: 1, by: 'index', width: 0.3 })] },
  { roles: DECO, level: [0.6, 1.1], colour: 'authored', effects: [e('dim', 'random', 2, 0.35)] },
  { roles: SIGN, level: [0.9, 1.2], colour: 'authored', effects: [e('dim', 'pulse', 1, 0.15)] });
L('club_drop',
  // (colour swaps with the bar, not every beat: an every-beat colour flip for 16 bars reads as a strobe — rave keeps it)
  { roles: ACC, level: [0.6, 1.2], colour: 'split', effects: [e('dim', 'pulse', 1, 0.5, { kick: true, width: 0.35, flash: true }), e('mix', 'square', 1 / 8, 1, { spread: 0.5, by: 'x', width: 0.5 })], dropHit: 0.8 },
  { roles: SHOWL, level: [0.5, 1.15], colour: 'split', effects: [e('dim', 'pulse', 1 / 2, 0.9, { spread: 1, by: 'x', width: 0.3 }), e('pan', 'tri', 1 / 4, 0.7, { spread: 1, by: 'x', wings: true }), e('tilt', 'sine', 1 / 8, 0.4)], dropHit: 1 },
  { roles: DECO, level: [0.8, 1.2], colour: 'authored', effects: [e('dim', 'random', 2, 0.35)] },
  { roles: SIGN, level: [1, 1.25], colour: 'authored', effects: [e('dim', 'pulse', 1, 0.25, { kick: true })], dropHit: 0.4 });
L('club_break',
  { roles: ACC, level: [0.3, 0.75], colour: 'sweep', effects: [e('dim', 'sine', 1 / 16, 0.35, { spread: 1, by: 'x' })] },
  { roles: SHOWL, level: [0.15, 0.4], colour: 'base', effects: [e('dim', 'sine', 1 / 16, 0.3, { spread: 1, by: 'index' })] },
  { roles: DECO, level: [0.6, 0.9], colour: 'authored', effects: [e('dim', 'random', 1 / 2, 0.3)] },
  { roles: SIGN, level: [0.85, 1], colour: 'authored', effects: [] });
// rave
L('rave_groove',
  { roles: ACC, level: [0.3, 1.0], colour: 'split', effects: [e('dim', 'pulse', 1, 0.6, { kick: true, width: 0.25, flash: true })] },
  { roles: SHOWL, level: [0.2, 1.0], colour: 'contrast', effects: [e('dim', 'pulse', 1 / 2, 1, { spread: 1, by: 'x', width: 0.25 }), e('pan', 'tri', 1 / 4, 0.8, { spread: 1, by: 'x', wings: true })] },
  { roles: DECO, level: [0.6, 1.1], colour: 'authored', effects: [e('dim', 'random', 2, 0.4)] },
  { roles: SIGN, level: [0.9, 1.25], colour: 'authored', effects: [e('dim', 'pulse', 1, 0.3, { kick: true })] });
L('rave_build',
  { roles: ACC, level: [0.2, 1.1], colour: 'base', effects: [e('dim', 'pulse', 2, 0.5, { width: 0.3, flash: true })] },
  { roles: SHOWL, level: [0.2, 1.1], colour: 'accent', effects: [e('dim', 'pulse', 1, 0.8, { width: 0.25, flash: true }), e('white', 'pulse', 1, 0.5, { width: 0.2, flash: true })] },
  { roles: DECO, level: [0.6, 1.2], colour: 'authored', effects: [e('dim', 'random', 4, 0.4)] },
  { roles: SIGN, level: [0.9, 1.3], colour: 'authored', effects: [e('dim', 'pulse', 2, 0.25)] });
L('rave_drop',
  { roles: ACC, level: [0.25, 1.2], colour: 'alt', effects: [e('dim', 'pulse', 1, 0.85, { width: 0.3, flash: true })], dropHit: 1 },
  { roles: SHOWL, level: [0.2, 1.2], colour: 'accent', effects: [e('dim', 'pulse', 1, 1, { width: 0.2, flash: true }), e('white', 'pulse', 1, 0.8, { width: 0.15, flash: true }), e('pan', 'random', 1 / 2, 0.9, { by: 'index' })], dropHit: 1 },
  { roles: DECO, level: [0.8, 1.3], colour: 'authored', effects: [e('dim', 'random', 4, 0.45)] },
  { roles: SIGN, level: [1, 1.3], colour: 'authored', effects: [e('dim', 'pulse', 1, 0.4, { flash: true })], dropHit: 0.6 });
L('rave_break',
  { roles: ACC, level: [0.15, 0.6], colour: 'base', effects: [e('dim', 'sine', 1 / 8, 0.4, { spread: 1, by: 'x', wings: true })] },
  { roles: SHOWL, level: [0.05, 0.3], colour: 'contrast', effects: [e('dim', 'sine', 1 / 8, 0.3, { spread: 1, by: 'index' })] },
  { roles: DECO, level: [0.5, 0.9], colour: 'authored', effects: [e('dim', 'random', 1, 0.35)] },
  { roles: SIGN, level: [0.8, 1], colour: 'authored', effects: [] });
// match the room: the room's own colours (fr.room), club-style structure at half the depth
L('room_groove',
  { roles: ACC, level: [0.6, 1.05], colour: 'authored', effects: [e('dim', 'pulse', 1, 0.22, { kick: true, width: 0.3 }), e('dim', 'sine', 1 / 8, 0.12, { spread: 1, by: 'x' })] },
  { roles: SHOWL, level: [0.45, 0.95], colour: 'authored', effects: [e('dim', 'sine', 1 / 4, 0.6, { spread: 1, by: 'x' }), e('pan', 'sine', 1 / 16, 0.35, { spread: 1, by: 'x', wings: true })] },
  { roles: DECO, level: [0.75, 1.05], colour: 'authored', effects: [e('dim', 'random', 1 / 2, 0.25)] },
  { roles: SIGN, level: [0.95, 1.1], colour: 'authored', effects: [e('dim', 'pulse', 0.25, 0.12, { width: 0.4 })] });
L('room_glow',
  { roles: ACC, level: [0.6, 1.05], colour: 'roomTint', tint: 0.6, effects: [e('dim', 'pulse', 1, 0.2, { kick: true, width: 0.3 }), e('dim', 'sine', 1 / 8, 0.15, { spread: 1, by: 'x' })] },
  { roles: SHOWL, level: [0.45, 0.95], colour: 'base', tint: 0.6, effects: [e('dim', 'tri', 1 / 4, 0.6, { spread: 1, by: 'x', wings: true })] },
  { roles: DECO, level: [0.75, 1.05], colour: 'authored', effects: [e('dim', 'random', 1 / 2, 0.25)] },
  { roles: SIGN, level: [0.95, 1.1], colour: 'authored', effects: [e('dim', 'pulse', 0.25, 0.12, { width: 0.4 })] });
L('room_build',
  // (Room and Calm never flash faster than 3 a second, limit or not: the build rises in brightness, not in 8ths)
  { roles: ACC, level: [0.45, 1.15], colour: 'authored', effects: [e('dim', 'pulse', 1, 0.24, { width: 0.3 })] },
  { roles: SHOWL, level: [0.4, 1.0], colour: 'authored', effects: [e('dim', 'sine', 1 / 2, 0.5, { spread: 1, by: 'index' })] },
  { roles: DECO, level: [0.7, 1.1], colour: 'authored', effects: [e('dim', 'random', 1, 0.3)] },
  { roles: SIGN, level: [0.95, 1.15], colour: 'authored', effects: [e('dim', 'pulse', 1, 0.12)] });
L('room_drop',
  { roles: ACC, level: [0.7, 1.2], colour: 'roomTint', tint: 0.75, effects: [e('dim', 'pulse', 1, 0.35, { kick: true, width: 0.3, flash: true })], dropHit: 0.6 },
  // (Room: a show-light group sweeps smoothly — staggered pulses would make the group as a whole flicker 4 times a beat)
  { roles: SHOWL, level: [0.6, 1.15], colour: 'split', tint: 0.7, effects: [e('dim', 'sine', 1 / 2, 0.6, { spread: 1, by: 'x' }), e('pan', 'tri', 1 / 8, 0.5, { spread: 1, by: 'x', wings: true })], dropHit: 0.8 },
  { roles: DECO, level: [0.85, 1.2], colour: 'authored', effects: [e('dim', 'random', 2, 0.3)] },
  { roles: SIGN, level: [1, 1.2], colour: 'authored', effects: [e('dim', 'pulse', 1, 0.18, { kick: true })], dropHit: 0.3 });
L('room_break',
  { roles: ACC, level: [0.5, 0.85], colour: 'authored', effects: [e('dim', 'sine', 1 / 16, 0.25, { spread: 1, by: 'x' })] },
  { roles: SHOWL, level: [0.3, 0.55], colour: 'authored', effects: [e('dim', 'sine', 1 / 16, 0.3, { spread: 1, by: 'index' })] },
  { roles: DECO, level: [0.65, 0.9], colour: 'authored', effects: [e('dim', 'random', 1 / 4, 0.25)] },
  { roles: SIGN, level: [0.9, 1], colour: 'authored', effects: [] });

const S = (id: string, name: string, mood: Mood, palettes: string[], sec: Partial<Record<DirSection, string[]>>, dropPalettes?: string[]) =>
  registerShow({ id, name, mood, palettes, dropPalettes, rotateBars: 16, sections: { idle: ['idle'], intro: sec.intro ?? sec.breakdown ?? [], groove: sec.groove ?? [], build: sec.build ?? sec.groove ?? [], drop: sec.drop ?? sec.groove ?? [], breakdown: sec.breakdown ?? [] } });
S('calm', 'Calm', 'calm', ['amber_rose', 'blue_hour', 'lavender', 'lagoon', 'golden'], { intro: ['calm_break'], groove: ['calm_flow'], build: ['calm_flow'], drop: ['calm_lift'], breakdown: ['calm_break'] });
S('club', 'Club', 'club', ['magenta_cyan', 'violet_mint', 'orange_azure', 'gold_purple', 'aqua_pink', 'coral_blue'], { intro: ['club_break'], groove: ['club_groove', 'club_wave'], build: ['club_build'], drop: ['club_drop'], breakdown: ['club_break'] }, ['magenta_cyan', 'aqua_pink', 'orange_azure']);
S('rave', 'Rave', 'rave', ['acid', 'uv_green', 'ice_fire', 'pink_white'], { intro: ['rave_break'], groove: ['rave_groove'], build: ['rave_build'], drop: ['rave_drop'], breakdown: ['rave_break'] });
S('room', 'Match the room', 'room', ['magenta_cyan'], { intro: ['room_break'], groove: ['room_groove', 'room_glow'], build: ['room_build'], drop: ['room_drop'], breakdown: ['room_break'] });

// the fixture kinds the engine knows (other rigs add theirs with registerFixtureKind)
for (const [k, role, attrs] of [
  ['emissive', 'accent', ['dim', 'mix', 'white']], ['point', 'accent', ['dim', 'mix', 'white']], ['spot', 'show', ['dim', 'mix', 'white', 'pan', 'tilt']],
  ['beam', 'show', ['dim', 'mix', 'white', 'pan', 'tilt', 'zoom']], ['wash', 'show', ['dim', 'mix', 'white', 'pan', 'tilt', 'zoom']], ['par', 'show', ['dim', 'mix', 'white']],
  ['strobe', 'show', ['dim', 'white']], ['blinder', 'show', ['dim', 'white']], ['laser', 'show', ['dim', 'mix', 'pan', 'tilt']], ['pixelbar', 'show', ['dim', 'mix', 'white']], ['ledwall', 'accent', ['dim', 'mix']],
] as [string, LightRole, Effect['attr'][]][]) registerFixtureKind(k, { role, attrs });

sealed = true;   // everything registered above is built in

// ---------------------------------------------------------------- the musical moment from a page's beat clock
/** What the director reads from a page's beat clock (src/scene/beatClock.ts BeatClock; tools/beat/rhythm_eval.ts). */
export interface ClockLike {
  bpm: number; section: string; env: { e: number; k?: number; s?: number; lo?: number }; kickPresence: number; kickAt: number; dropAt: number; phraseId: number; phraseBeat: number; dropSeq: number;
  posAt(t: number): number; barAt(t: number): number; barPosAt(t: number): number; showTime(t: number): number;
  locked?: boolean; hatAt?: number;
  /** the groove on the clock's grid (newer studios / music clocks; shared/groove.ts) */
  grooveNow?(t: number): { feel: import('./groove.ts').Feel; conf: number; hits: GrooveHit[]; half: boolean } | null;
}
/** The director's memory between frames (section changes, the drop's section start). */
export interface FrameState { sec: DirSection; changeAt: number; dropSecAt: number; prevSec?: DirSection; slowK?: number; slowT?: number; onS?: number; onT?: number; hatS?: number; hatT?: number }
/**
 * Fill `fr` for the moment `now` from the clock (once per rendered frame). `live` = how much the music drives the
 * lights (0 = idle), `safe` = the flash limit applies; `extra` = a scripted drop and the Track library's pre-built
 * show frame. Returns true when the section changed on this frame.
 */
export function frameFromClock(fr: MusicFrame, st: FrameState, C: ClockLike, now: number, live: number, safe: boolean, extra: { momentDropAt?: number; pre?: { build: number; blackout: boolean; groove?: { feel: import('./groove.ts').Feel; conf: number; hits: GrooveHit[]; half: boolean } | null } | null } = {}): boolean {
  let beat = C.posAt(now); if (!Number.isFinite(beat)) beat = C.showTime(now) / 500;
  const bpm = C.bpm || 120;
  const bar = Number.isFinite(C.posAt(now)) ? C.barAt(now) : Math.floor(beat / 4);
  fr.now = now; fr.beat = beat; fr.bar = bar; fr.barPos = Number.isFinite(C.barPosAt(now)) ? C.barPosAt(now) : ((beat % 4) + 4) % 4;
  fr.phraseId = Number.isFinite(C.phraseId) ? C.phraseId : Math.floor(bar / 8) + C.dropSeq;
  fr.phraseBeat = Number.isFinite(C.phraseBeat) ? C.phraseBeat : ((bar % 8) + 8) % 8 * 4 + Math.floor(fr.barPos);
  const sec = live > 0.001 ? dirSection(C.section === 'listening' ? 'groove' : C.section) : 'idle';
  const changed = sec !== st.sec;
  if (changed) { st.prevSec = st.sec; st.sec = sec; st.changeAt = now; }
  fr.section = sec; fr.intensity = C.env.e; fr.bpm = bpm; fr.safe = safe;
  fr.kick = Number.isFinite(C.kickPresence) ? C.kickPresence : now - C.kickAt < 120000 / bpm ? 1 : 0;
  // the drop's hit starts when the section turns to 'drop' (the drop event can arrive a few frames later: the same drop)
  if (sec === 'drop' && st.changeAt === now) st.dropSecAt = now;
  const dEv = Math.max(C.dropAt, extra.momentDropAt ?? -Infinity), dRef = dEv > st.dropSecAt + 400 ? dEv : Math.max(dEv, st.dropSecAt);
  fr.kickAge = now - C.kickAt; fr.dropAge = now - dRef > -100 ? Math.max(0, now - dRef) : now - dRef;   // (an event stamped a hair ahead of this frame)
  fr.sectionBeats = (now - st.changeAt) / (60000 / bpm);
  fr.buildK = sec === 'build' ? Math.min(1, (now - st.changeAt) / (60000 / bpm * 32)) : 0;
  // the DJ's analysed track (Track library, src/scene/trackShowRx.ts): the build ramps toward the KNOWN drop (held on
  // loops), and the last beat before the drop goes dark
  const pre = extra.pre;
  if (pre) { if (sec === 'build') fr.buildK = Math.max(fr.buildK, pre.build); if (pre.blackout) fr.intensity = 0; }
  // the rhythm: the grid's every beat, the learned groove, or free (rhythm lane, shared/groove.ts)
  // (the live groove — learned from the drums the stream hears, on the clock's own grid — wins whenever it is clear;
  // the analysed track's groove fills in only while the live one is still learning or unsure: measured, the offline
  // groove placed hits worse than the live one on rock / bumps tracks)
  const lg = C.grooveNow ? C.grooveNow(now) : undefined;
  const g = lg && lg.conf >= 0.4 && lg.feel !== 'free' ? lg : pre?.groove && pre.groove.conf >= 0.6 ? pre.groove : lg ?? pre?.groove;
  const locked = Number.isFinite(C.posAt(now)) && C.locked !== false;
  fr.rhythm = C.grooveNow || pre?.groove ? rhythmMode(g ?? null, locked) : 'grid';
  fr.plan = fr.rhythm === 'groove' && g ? planFor(g.hits, bpm, safe) : undefined;
  fr.half = !!g?.half && fr.rhythm === 'groove';
  // (the slow time base moves towards its target at one bar per bar: a flip of feel never jumps the movers)
  { const target = fr.half || fr.rhythm === 'free' ? 1 : 0, dtb = Number.isFinite(st.slowT) ? Math.max(0, now - (st.slowT as number)) / (240000 / bpm) : 1;
    st.slowT = now; st.slowK = st.slowK === undefined ? target : st.slowK + Math.sign(target - st.slowK) * Math.min(Math.abs(target - st.slowK), dtb);
    fr.slowK = st.slowK; }
  // ('free' follows the onsets SMOOTHLY - ~150 ms rise, ~400 ms fall: no clear pattern means no hits, and a raw kick
  //  envelope at 200 BPM would flash 3.3 times a second even in Room / Calm)
  { const raw = Math.max(0, Math.min(1, Math.max(C.env.k ?? 0, (C.env.s ?? 0) * 0.85, (C.env.lo ?? 0) * 0.5)));
    const dt = Number.isFinite(st.onT) ? Math.max(0, Math.min(0.2, (now - (st.onT as number)) / 1000)) : 1, s0 = st.onS ?? raw;
    st.onT = now; st.onS = s0 + (raw - s0) * (1 - Math.exp(-dt / (raw > s0 ? 0.15 : 0.4))); fr.onset = st.onS; }
  // the show pack's onset-scaled effects (`onset: 'snare' | 'hat'`): the snare from the pre-cued groove, hats from the
  // detected hat events (they only scale depth: the positions stay on the grid); none = grid only, as before
  // (the plan's kick, held ~0.5 s: a kick-scaled layer stays lit between the drums, in time with them)
  if (fr.plan) { planEnvelopes(fr.plan, fr.barPos, bpm, PENV); fr.snare = PENV.snare; fr.kickCue = Math.pow(PENV.kick, 0.16 / 0.5); }
  else { fr.snare = undefined; fr.kickCue = undefined; }
  const ha = C.hatAt !== undefined ? now - C.hatAt : Infinity;
  // (the hats are DETECTED, a moment late, and the groove has no hat slots: their envelope only shades a hat layer's depth
  //  smoothly - ~100 ms rise, ~500 ms fall - never a flicker at the hat rate, even in Room / Calm with the limit off)
  if (ha >= 0 && ha < 240000 / bpm) {
    const raw = Math.exp(-ha / 90), dt = Number.isFinite(st.hatT) ? Math.max(0, Math.min(0.2, (now - (st.hatT as number)) / 1000)) : 1, s0 = st.hatS ?? raw;
    st.hatT = now; st.hatS = s0 + (raw - s0) * (1 - Math.exp(-dt / (raw > s0 ? 0.1 : 0.5))); fr.hat = st.hatS;
  } else { fr.hat = undefined; st.hatS = undefined; st.hatT = undefined; }
  return changed;
}

const PENV = { kick: 0, snare: 0 };

/** Map any section name (the beat packets' SECTIONS, a DJ protocol's phrase kinds) to the director's sections. */
export function dirSection(s: string | undefined): DirSection {
  switch (s) {
    case 'intro': return 'intro';
    case 'buildup': case 'build': case 'up': return 'build';
    case 'drop': case 'chorus': return 'drop';
    case 'breakdown': case 'down': case 'bridge': case 'outro': return 'breakdown';
    case 'groove': case 'verse': return 'groove';
    default: return 'idle';
  }
}

/** A remote-control request (Stream Deck / scripts / bus `scene {reactiveLights}`) → the SceneLightsState patch. */
export function reactiveLightsPatch(cur: { reactive: boolean; mood?: Mood; safe?: boolean }, rl: Record<string, unknown>): { reactive?: boolean; mood?: Mood; safe?: boolean } {
  const p: { reactive?: boolean; mood?: Mood; safe?: boolean } = {};
  if (typeof rl.on === 'boolean') p.reactive = rl.on; else if (rl.on === 'toggle') p.reactive = !cur.reactive;
  if (isMood(rl.mood)) p.mood = rl.mood;
  else if (rl.mood === 'next') { const ids = MOODS.map((m) => m.id); p.mood = ids[(ids.indexOf(cur.mood ?? 'room') + 1) % ids.length]; }
  if (typeof rl.safe === 'boolean') p.safe = rl.safe;
  return p;
}
