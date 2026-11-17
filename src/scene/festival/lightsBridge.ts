// The festival stage ⇄ the room light show's director (shared/lightDirector.ts, the reactive-lights lane): the
// festival's catalogue is registered there (fixture kinds for the special effects, every palette, every look compiled
// into the director's layer / waveform form, every show), and while a festival room is on air the director's default
// 'room' show follows the festival's current look and palette - so the room's own LIGHT_* fixtures (accent strips,
// the DJ key lights, signs) move with the same show. The festival keeps its own engine for what the director's looks
// can't express (absolute aiming: converge on the DJ, crowd sweeps, sky pillars, ballyhoo throws; laser modes; LED wall
// content; the special-effects schedule; the phrase-lookahead countdown; prisms).
// Loaded through import.meta.glob: before that lane is merged the module simply isn't there and this is a no-op.
import type { Catalogue, Look, Palette, Section } from '../../../shared/festivalLooks.ts';
import { accentById, motionById } from '../../../shared/festivalLooks.ts';
import { compileProgram } from '../../../shared/showPack/compile.ts';
import { hash3, hashStr } from '../../../shared/festival.ts';
import { PACK_SHARE } from '../../../shared/festivalDirector.ts';

// ---- the director's API (a structural subset of shared/lightDirector.ts)
type Wave = 'sine' | 'tri' | 'saw' | 'ramp' | 'square' | 'pulse' | 'random' | 'hold';
type SpreadBy = 'x' | 'y' | 'z' | 'ang' | 'r' | 'index' | 'random';
type Attr = 'dim' | 'mix' | 'white' | 'pan' | 'tilt' | 'zoom';
export interface DEffect { attr: Attr; wave: Wave; rate: number; spread?: number; by?: SpreadBy; wings?: boolean; depth: number; width?: number; kick?: boolean; flash?: boolean }
export interface DLayer { roles?: string[]; kinds?: string[]; groups?: string[]; level: [number, number]; colour: 'authored' | 'base' | 'contrast' | 'accent' | 'split' | 'alt' | 'sweep' | 'roomTint'; tint?: number; effects: DEffect[]; dropHit?: number }
export interface DLook { id: string; layers: DLayer[] }
type DSection = 'idle' | 'intro' | 'groove' | 'build' | 'drop' | 'breakdown';
export interface DShow { id: string; name: string; mood: 'room' | 'calm' | 'club' | 'rave'; palettes: string[]; sections: Record<DSection, string[]>; rotateBars: number; dropPalettes?: string[]; pick?: (fr: { section: DSection; phraseId: number }) => string | null }
export interface DirectorApi {
  // (registries are sealed: our ids are namespaced 'fest:<id>'; replacing a built-in - the 'room' show - needs override)
  registerPalette(p: { id: string; mood: string; colours: [string, string, string?] }, o?: { override?: boolean }): void;
  registerLook(l: DLook, o?: { override?: boolean }): void;
  registerShow(s: DShow, o?: { override?: boolean }): void;
  registerFixtureKind(kind: string, def: { role: string; attrs: Attr[] }, o?: { override?: boolean }): void;
  showById(id: string): DShow | null;
}

let api: DirectorApi | null | undefined;
/** tests: use this director module (the build finds it through import.meta.glob) */
export function setDirectorApi(m: DirectorApi | null) { api = m; }
/** the director module when it is part of this build, else null */
export function directorApi(): DirectorApi | null {
  if (api !== undefined) return api;
  try {
    // (a literal import.meta.glob: Vite resolves it at build time; an empty object when the file isn't in the tree)
    const mods = import.meta.glob('../../../shared/lightDirector.ts', { eager: true }) as Record<string, unknown>;
    const m = Object.values(mods)[0] as Partial<DirectorApi> | undefined;
    api = m && typeof m.registerLook === 'function' && typeof m.registerShow === 'function' ? m as DirectorApi : null;
  } catch { api = null; }
  return api;
}

// ---- compiling a festival look into the director's form
const e = (attr: Attr, wave: Wave, rate: number, depth: number, o: Partial<DEffect> = {}): DEffect => ({ attr, wave, rate, depth, ...o });
function rhythmEffects(r: string): DEffect[] {
  switch (r) {
    case 'hold': return [];
    case 'kick': return [e('dim', 'pulse', 1, 0.8, { kick: true, width: 0.3 })];
    case 'offbeat': return [e('dim', 'pulse', 2, 0.6, { width: 0.25 })];
    case 'gallop': return [e('dim', 'pulse', 4, 0.7, { width: 0.3, flash: true })];
    case 'chase': return [e('dim', 'pulse', 1 / 4, 0.95, { spread: 1, by: 'x', width: 0.25 })];
    case 'pingpong': return [e('dim', 'tri', 1 / 8, 0.9, { spread: 1, by: 'x' })];
    case 'sparkle': return [e('dim', 'random', 4, 0.6)];
    case 'stack': return [e('dim', 'ramp', 1 / 4, 0.9, { spread: -1, by: 'x' })];
    case 'alternate': return [e('dim', 'square', 1 / 2, 0.8, { spread: 0.5, by: 'index', width: 0.5 })];
    case 'snare': return [e('dim', 'pulse', 1 / 2, 0.8, { width: 0.3 })];
    case 'halftime': return [e('dim', 'pulse', 1 / 4, 0.85, { width: 0.35 })];
    case 'sixteenth': return [e('dim', 'pulse', 4, 0.9, { spread: 1, by: 'x', width: 0.2, flash: true })];
    case 'breathe': return [e('dim', 'sine', 1 / 8, 0.6)];
    case 'riser': return [e('dim', 'pulse', 2, 0.7, { width: 0.3, flash: true })];
    case 'wave': return [e('dim', 'sine', 1 / 4, 0.7, { spread: 1, by: 'x' })];
    case 'heartbeat': return [e('dim', 'pulse', 1 / 2, 0.8, { width: 0.2 })];
    case 'triplet': return [e('dim', 'pulse', 3, 0.8, { width: 0.3, flash: true })];
    case 'downbeat': return [e('dim', 'pulse', 1 / 4, 0.8, { width: 0.5 })];
    case 'swing': return [e('dim', 'pulse', 2, 0.4, { width: 0.35 })];
    case 'strobe': return [e('dim', 'square', 4, 0.95, { width: 0.22, flash: true }), e('white', 'square', 4, 0.8, { width: 0.22, flash: true })];
  }
  return [];
}
function motionEffects(m: string, rate: number, amp: number): DEffect[] {
  const r = 1 / Math.max(1, rate);
  switch (m) {
    case 'still': return [];
    case 'sweep': return [e('pan', 'sine', r, 0.8 * amp)];
    case 'fan': return [e('pan', 'sine', r, 0.8 * amp, { spread: 1, by: 'x', wings: true })];
    case 'ballyhoo': return [e('pan', 'random', 1 / 2, amp, { by: 'index' }), e('tilt', 'random', 1 / 2, 0.6 * amp, { by: 'random' })];
    case 'circle': case 'bloom': case 'helix': case 'spiral': return [e('pan', 'sine', r, 0.6 * amp, { spread: m === 'helix' ? 1 : 0, by: 'index' }), e('tilt', 'tri', r, 0.5 * amp, { spread: 0.25 })];
    case 'fig8': return [e('pan', 'sine', r, 0.6 * amp), e('tilt', 'sine', 2 * r, 0.4 * amp)];
    case 'tiltwave': case 'pendulum': case 'ripple': return [e('tilt', 'sine', r, 0.7 * amp, { spread: 1, by: m === 'ripple' ? 'r' : 'x' })];
    case 'crossfire': case 'xcross': return [e('pan', 'tri', r, 0.8 * amp, { spread: 0.5, by: 'index' })];
    case 'audience': return [e('pan', 'sine', r, 0.6 * amp, { spread: 0.5, by: 'x' }), e('tilt', 'sine', 2 * r, 0.3 * amp)];
    case 'wave': return [e('pan', 'sine', r, 0.7 * amp, { spread: 1, by: 'x' })];
    case 'snap': case 'shake': case 'fanpump': return [e('pan', 'random', 1, 0.7 * amp, { by: 'index' })];
    case 'searchlight': case 'arc': case 'sky': case 'vee': case 'converge': case 'lift': return [e('tilt', 'sine', r, 0.4 * amp, { spread: 0.5, by: 'x', wings: true })];
  }
  return [];
}
const colourOf = (spread: string): DLayer['colour'] => (spread === 'unison' ? 'base' : spread === 'oddeven' || spread === 'blocks2' || spread === 'blocks4' ? 'alt' : spread === 'leftright' || spread === 'wings' ? 'split' : 'sweep');

/** a festival look → a director look ('fest:<id>'): show fixtures move + pulse like the festival rig, the room's
 *  accents follow the colours with a lighter touch, deco twinkles, signs stay calm */
export function compileLook(look: Look): DLook {
  if (look.pack) return compileProgram(look.pack, fid(look.id));   // a show-pack look: the pack's own compile
  const mo = motionById(look.motion);
  const acc = accentById(look.accent);
  const peak = look.cls === 'peak', chill = look.cls === 'chill';
  const lv: [number, number] = chill ? [0.25, 0.7] : peak ? [0.45, 1.15] : [0.35, 0.95];
  const show: DLayer = { roles: ['show'], level: lv, colour: colourOf(look.spread), effects: [...rhythmEffects(look.beamRhythm === 'hold' ? look.rhythm : look.beamRhythm), ...(mo ? motionEffects(mo.id, mo.rate, mo.amp) : [])], ...(peak ? { dropHit: 1 } : {}) };
  if (acc && acc.strobe >= 0.5) show.effects.push(e('white', 'pulse', acc.strobe >= 0.9 ? 2 : 1, 0.6, { width: 0.2, flash: true }));
  const accent: DLayer = { roles: ['accent'], level: chill ? [0.4, 0.8] : [0.5, 1.05], colour: chill ? 'base' : 'sweep', tint: 0.85, effects: rhythmEffects(look.rhythm).map((x) => ({ ...x, depth: x.depth * 0.5 })), ...(peak ? { dropHit: 0.7 } : {}) };
  return { id: fid(look.id), layers: [show, accent,
    { roles: ['deco'], level: [0.7, 1.05], colour: 'authored', effects: [e('dim', 'random', chill ? 1 / 2 : 2, 0.3)] },
    { roles: ['sign'], level: [0.95, 1.1], colour: 'authored', effects: chill ? [] : [e('dim', 'pulse', 1 / 4, 0.15, { width: 0.4 })] }] };
}
const DSEC: Record<Section, DSection> = { intro: 'intro', groove: 'groove', build: 'build', drop: 'drop', breakdown: 'breakdown', outro: 'breakdown' };
const moodOf = (genre: string): DShow['mood'] => (genre === 'chill' ? 'calm' : /hard|raw|dub|dnb/.test(genre) ? 'rave' : 'club');
/** the director's ids: lower-case letters, digits, _ (≤ 32) in our own namespace */
export const fid = (id: string) => `fest:${id.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32)}`;
const palId = fid;
const palEntry = (p: Palette, mood: string) => ({ id: palId(p.id), mood, colours: [p.colors[0], p.colors[1] ?? p.colors[0], p.colors[2]] as [string, string, string?] });

const done = new WeakSet<Catalogue>();
/** register the whole catalogue (idempotent per catalogue) */
export function registerCatalogue(cat: Catalogue): boolean {
  const A = directorApi();
  if (!A) return false;
  if (done.has(cat)) return true;
  done.add(cat);
  for (const k of ['co2', 'flame', 'confetti', 'gerb', 'comet', 'firework']) A.registerFixtureKind(fid(k), { role: 'show', attrs: ['dim'] });
  for (const p of cat.palettes.values()) A.registerPalette(palEntry(p, /hard|fire|acid|uv/.test(p.tags.join(' ')) ? 'rave' : 'club'));
  for (const l of cat.looks) A.registerLook(compileLook(l));
  for (const s of cat.shows) {
    const sections = { idle: ['idle'] } as Record<DSection, string[]>;
    for (const [k, ids] of Object.entries(s.sections) as [Section, string[]][]) { const d = DSEC[k]; sections[d] = [...(sections[d] ?? []), ...ids.map(fid)]; }
    // the show's pack pool: its own share of phrases (the festival's PACK_SHARE), the show's own looks on the others
    const pk = {} as Partial<Record<DSection, string[]>>;
    for (const [k, ids] of Object.entries(s.pack ?? {}) as [Section, string[]][]) { const d = DSEC[k]; pk[d] = [...(pk[d] ?? []), ...ids.map(fid)]; }
    const salt = hashStr(`fest:${s.id}`);
    const pick = Object.keys(pk).length ? (fr: { section: DSection; phraseId: number }) => {
      const ids = pk[fr.section];
      return ids?.length && hash3(fr.phraseId, salt, 29) < PACK_SHARE ? ids[Math.floor(hash3(fr.phraseId, salt, 31) * ids.length) % ids.length] : null;
    } : undefined;
    A.registerShow({ id: fid(s.id), name: s.name, mood: moodOf(s.genre), palettes: s.palettes.map(palId), sections, rotateBars: s.rotate * 2, ...(pick ? { pick } : {}) });
  }
  return true;
}

/** While a festival room is on air: the director's 'room' show plays the festival's current look + palette (restored by restoreRoomShow). */
let saved: DShow | null = null;
let liveKey = '';
export function followFestival(look: Look, palette: Palette | undefined): void {
  const A = directorApi();
  if (!A || !palette) return;
  const key = `${look.id}|${palette.id}`;
  if (key === liveKey) return;
  liveKey = key;
  if (!saved) saved = A.showById('room');
  const now = 'fest:now';
  A.registerPalette({ ...palEntry(palette, 'club'), id: now });
  A.registerLook({ ...compileLook(look), id: now });
  A.registerShow({ id: 'room', name: 'Match the room (festival)', mood: 'club', palettes: [now], rotateBars: 16,
    sections: { idle: saved?.sections.idle ?? ['idle'], intro: [now], groove: [now], build: [now], drop: [now], breakdown: [now] } }, { override: true });
}
export function restoreRoomShow(): void {
  const A = directorApi();
  if (A && saved) A.registerShow(saved, { override: true });
  saved = null; liveKey = '';
}
