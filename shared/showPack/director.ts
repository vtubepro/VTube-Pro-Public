// Show pack → the room light director (shared/lightDirector.ts): every program is a director look ('pack:<id>', and
// 'pack:<id>s' = its Safe-flashes variant; compiled when first played), the pack's palettes are registered, and the
// built-in Club, Rave and Calm shows get a PICK hook: per 8-bar phrase and section the pack chooses a program that fits
// the section, the music's tempo (genre) and the mood - deterministic, so every page (OBS, the studio preview, party
// guests) plays the same look. Every few phrases the show's own looks still play.
// Called once by the room light engine (src/scene/lightShow.ts). The club rig (src/scene/club/packRig.ts) follows the
// same pick (packPick(): it stands down on the show's own-look phrases).
import { lookById, registerLook, registerPalette, registerShow, showById, type DirSection, type DirectorShow, type MusicFrame } from '../lightDirector.ts';
import { PALETTES } from '../festivalLooks.ts';
import { hash3, hashStr } from '../festival.ts';
import { compileProgram } from './compile.ts';
import { generatePack } from './generate.ts';
import type { Program } from './program.ts';
import type { PackSection } from './rhythm.ts';

const SEC: Record<DirSection, PackSection[]> = { idle: [], intro: ['intro'], groove: ['groove'], build: ['build'], drop: ['drop'], breakdown: ['breakdown', 'outro'] };
/** the tempo's genre (as the festival engine's genreForBpm) */
export function genreOfBpm(bpm: number): string {
  if (!(bpm > 0)) return 'house';
  if (bpm < 100) return 'chill'; if (bpm < 124) return 'house'; if (bpm < 132) return 'bigroom'; if (bpm < 143) return 'trance'; if (bpm < 166) return 'hardstyle'; return 'hardcore';
}
export const packLookId = (p: Program, safe: boolean) => `pack:${p.id}${safe ? 's' : ''}`;

let programs: Program[] = [];
const byId = new Map<string, Program>();
export const programById = (id: string) => byId.get(id) ?? null;
export function packPrograms(): Program[] { if (!programs.length) { programs = generatePack(PALETTES).list; for (const p of programs) byId.set(p.id, p); } return programs; }

/** which programs a mood plays */
const MOOD_POOL: Record<'club' | 'rave' | 'calm' | 'room', (p: Program) => boolean> = {
  club: (p) => p.cls !== 'chill' || p.family === 'slow' || p.family === 'signature',
  rave: (p) => p.cls === 'peak' || (p.cls === 'mid' && p.energy >= 0.55) || p.family === 'build' || p.family === 'slow',
  calm: (p) => !p.flashy && p.strobe === 'none' && (p.cls === 'chill' || (p.cls === 'mid' && p.energy < 0.55)),
  room: (p) => !p.flashy && p.cls !== 'peak',
};
interface PickRec { id: string; program: Program }
const last = new Map<string, PickRec | null>();
/** the pack program a mood plays now (the last pick of its show's hook on this page; null = the show's own look) */
export function packNow(mood: string): Program | null { return last.get(mood)?.program ?? null; }
/** the hook's last pick for a mood: a program, null = this phrase plays the show's own look, undefined = the hook hasn't
 *  run on this page (the director isn't playing that mood) */
export function packPick(mood: string): Program | null | undefined { return last.has(mood) ? last.get(mood)?.program ?? null : undefined; }
/** how often a mood's show plays its own looks instead of a pack program (every n-th phrase) */
export const OWN_EVERY: Record<string, number> = { club: 4, rave: 4, calm: 3 };

/**
 * The pick for a mood at a musical moment: per (phrase, section, genre) a program that fits - deterministic. `every` =
 * every n-th phrase plays the show's own looks (0 = never). Pure apart from the small memo.
 */
export function pickProgram(mood: keyof typeof MOOD_POOL, fr: Pick2, every = 4): Program | null {
  if (fr.section === 'idle') return null;
  const genre = genreOfBpm(fr.bpm);
  const salt = hashStr(`${mood}|${genre}|${fr.section}`);
  if (every > 0 && Math.floor(hash3(fr.phraseId, salt, 11) * every) === 0) return null;
  const pool = candidates(mood, fr.section, genre);
  if (!pool.length) return null;
  return pool[Math.floor(hash3(fr.phraseId, salt, 23) * pool.length) % pool.length];
}
type Pick2 = Pick<MusicFrame, 'section' | 'bpm' | 'phraseId'>;
const candCache = new Map<string, Program[]>();
function candidates(mood: keyof typeof MOOD_POOL, sec: DirSection, genre: string): Program[] {
  const key = `${mood}|${sec}|${genre}`;
  let c = candCache.get(key);
  if (!c) {
    const secs = SEC[sec];
    const inMood = packPrograms().filter((p) => MOOD_POOL[mood](p) && p.sections.some((s) => secs.includes(s)) && (sec !== 'drop' || mood === 'calm' || mood === 'room' || p.cls === 'peak'));
    const fit = inMood.filter((p) => p.genres.includes(genre));
    c = fit.length >= 12 ? fit : inMood;
    candCache.set(key, c);
  }
  return c;
}

/** the director look of a program (compiled + registered the first time it is asked for: page start stays light) */
export function ensurePackLook(p: Program, safe: boolean): string {
  const id = packLookId(p, safe);
  if (!lookById(id)) registerLook(compileProgram(p, id, safe));
  return id;
}

let done = false;
/** register the pack with the director (idempotent): its palettes and the Club / Rave / Calm pick hooks. Programs are
 *  generated on the first pick and each look is compiled when it is first played (ensurePackLook). */
export function registerShowPack(): boolean {
  if (done) return true;
  done = true;
  for (const p of PALETTES) registerPalette({ id: `pack:${p.id}`, mood: p.tags.includes('chill') || p.tags.includes('pastel') ? 'calm' : /hard|fire|acid|uv/.test(p.tags.join(' ')) ? 'rave' : 'club', colours: [p.colors[0], p.colors[1] ?? p.colors[0], p.colors[2]] });
  // the built-in moods get the pack (their own looks keep playing every few phrases) + more palettes
  const extraPals: Record<string, string[]> = { club: ['cyberpunk', 'synthwave', 'mint_pink', 'amber_teal', 'plasma', 'deep_ocean'], rave: ['toxic_rave', 'hellfire', 'ultraviolet', 'acid_violet', 'storm', 'solar'], calm: ['aurora', 'dusk', 'lagoon', 'pastel'] };
  for (const mood of ['club', 'rave', 'calm'] as const) {
    const base = showById(mood);
    if (!base) continue;
    const show: DirectorShow = { ...base, palettes: [...base.palettes, ...extraPals[mood].filter((id) => PALETTES.some((p) => p.id === id)).map((id) => `pack:${id}`)],
      pick: (fr) => {
        const p = pickProgram(mood, fr, OWN_EVERY[mood]);
        if (fr.section !== 'idle') last.set(mood, p ? { id: p.id, program: p } : null);   // (the idle blend frame never counts)
        return p ? ensurePackLook(p, !!fr.safe) : null;
      } };
    registerShow(show, { override: true });
  }
  return true;
}
