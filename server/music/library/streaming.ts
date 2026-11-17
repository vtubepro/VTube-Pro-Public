// Streaming tracks (Beatport, Beatsource, Spotify, TIDAL, SoundCloud played through rekordbox): there is no music file,
// only the service's track id. rekordbox still analyses them (grid, phrases, waveform, cues) and keeps that analysis in
// its USBANLZ folder under the id ("?/beatport:tracks:7207735", "?/spotify:track:<base62>"), and its exported XML names
// them by a catalog Location ("file://localhost//v4/catalog/tracks/7207735/"). This file recognises those identities so
// the XML entry (title, artist, grid, cues) and the analysis files (phrases, waveform) join under ONE key, and so a
// streaming track is never treated as a file: never "unsafe", never "waiting for a file", never read from disk.
// VTube Pro never fetches, decodes or decrypts stream audio and never calls any streaming service: it only reads what
// rekordbox already wrote on this PC, and (learn-while-playing, server/music/trackSync.ts) the music input it hears.
// Also: the sampler one-shots rekordbox lists in its collection (not tracks), and title / artist matching for decks
// and tools that report only a name (CDJ metadata, StageLinQ, rkbx_link, /vtp/title).
// Pure: tools/djtrack_unit.ts (section "streaming").

export const STREAM_SERVICES = ['beatport', 'beatsource', 'spotify', 'tidal', 'soundcloud'] as const;
export type StreamService = (typeof STREAM_SERVICES)[number];
export const STREAM_LABEL: Record<StreamService, string> = { beatport: 'Beatport', beatsource: 'Beatsource', spotify: 'Spotify', tidal: 'TIDAL', soundcloud: 'SoundCloud' };
export interface StreamRef { svc: StreamService; id: string }
/** The library key of a streaming track ("beatport:7207735"): both the XML entry and the analysis files map to it. */
export const streamKey = (r: StreamRef) => `${r.svc}:${r.id}`;
/** A valid id for the service (digits for the catalog services, base62 for Spotify). */
const ID_OK: Record<StreamService, RegExp> = { beatport: /^\d{1,12}$/, beatsource: /^\d{1,12}$/, tidal: /^\d{1,12}$/, soundcloud: /^\d{1,14}$/, spotify: /^[A-Za-z0-9]{10,40}$/ };
const svcOf = (s: string): StreamService | null => ((STREAM_SERVICES as readonly string[]).includes(s.toLowerCase()) ? s.toLowerCase() as StreamService : null);
function ref(svc: StreamService | null, id: string | undefined): StreamRef | null { return svc && id && ID_OK[svc].test(id) ? { svc, id } : null; }

/**
 * Forms seen or expected, data-driven (add a row when rekordbox writes a new one):
 *  - rekordbox 7 XML, Beatport streaming: Location "file://localhost//v4/catalog/tracks/<id>/" (Beatport's catalog API path;
 *    Beatsource uses the same API shape, so a bare catalog path is Beatport unless the analysis files say Beatsource);
 *  - "<service>:tracks:<id>" / "<service>:track:<id>" (rekordbox's analysis files; any XML Location that carries one);
 *  - the services' web links (a collection exported by other tools).
 */
const PATTERNS: { re: RegExp; svc?: StreamService; g: number; s?: number }[] = [
  { re: /(?:^|[/:])(beatport|beatsource|spotify|tidal|soundcloud):tracks?:([A-Za-z0-9]+)\/?$/i, s: 1, g: 2 },
  { re: /^(?:file:\/\/localhost)?\/*v4\/catalog\/tracks\/(\d+)\/?$/i, svc: 'beatport', g: 1 },
  { re: /^https?:\/\/(?:www\.)?(beatport|beatsource)\.com\/track\/[^/?#]+\/(\d+)/i, s: 1, g: 2 },
  { re: /^https?:\/\/(?:listen\.|www\.)?tidal\.com\/(?:browse\/)?track\/(\d+)/i, svc: 'tidal', g: 1 },
  { re: /^https?:\/\/open\.spotify\.com\/track\/([A-Za-z0-9]+)/i, svc: 'spotify', g: 1 },
  { re: /^https?:\/\/api\.soundcloud\.com\/tracks\/(\d+)/i, svc: 'soundcloud', g: 1 },
];
function match(s: string): StreamRef | null {
  for (const p of PATTERNS) {
    const m = p.re.exec(s);
    if (m) { const r = ref(p.svc ?? svcOf(m[p.s!]), m[p.g]); if (r) return r; }
  }
  return null;
}
/** The streaming identity in a rekordbox XML Location (null = a file, or nothing we know). */
export function streamFromLocation(loc: string | undefined): StreamRef | null {
  if (!loc || loc.length > 300) return null;
  let s = loc.trim();
  try { if (/%[0-9a-f]{2}/i.test(s)) s = decodeURIComponent(s); } catch { /* keep */ }
  if (/^https?:/i.test(s)) return match(s);
  return match(s.replace(/^file:\/\/localhost\//i, '').replace(/^file:\/\//i, ''));
}
/** The streaming identity in an analysis file's PPTH ("?/beatport:tracks:7207735", "?/spotify:track:…"). */
export function streamFromPpth(p: string | undefined): StreamRef | null {
  if (!p || p.length > 300) return null;
  return match(p.trim().replace(/^\?\//, ''));
}
/** A library base name that IS a streaming key ("beatport:7207735"; also the raw analysis form, from older imports). */
export function streamFromBase(base: string | undefined): StreamRef | null {
  if (!base) return null;
  const m = /^([a-z]+):(?:tracks?:)?([A-Za-z0-9]+)$/i.exec(base);
  return m ? ref(svcOf(m[1]), m[2]) : null;
}

// ---------------------------------------------------------------------------------------------------- sampler sounds
/** Shorter than this (seconds) is a sound, not a track: rekordbox's sampler presets, one-shots, FX. */
export const MIN_TRACK_S = 30;
/** rekordbox's sampler folder (…\Music\rekordbox\Sampler\…): its presets are listed in the collection, they aren't tracks. */
export const isSamplerPath = (p: string | undefined) => !!p && /[\\/]rekordbox[\\/]Sampler[\\/]/i.test(p);
/** A collection entry that is a sampler sound, not a track: in the sampler folder, or a FILE shorter than 30 s
 *  (a stated length of 0 counts: rekordbox writes 0 for its tiny FX). Unknown length = a track. */
export function isSampleEntry(o: { path?: string; durS?: number; stream?: boolean }): boolean {
  if (isSamplerPath(o.path)) return true;
  if (o.stream) return false;
  return o.durS !== undefined && Number.isFinite(o.durS) && o.durS >= 0 && o.durS < MIN_TRACK_S;
}

// ---------------------------------------------------------------------------------------------------- names
const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[‘’ʼ`´]/g, "'").replace(/ø/g, 'o').replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/đ/g, 'd').replace(/ł/g, 'l');
const words = (s: string) => s.replace(/&/g, ' and ').replace(/'/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
/** Mix words: "(Original Mix)", "[Extended Mix]", "- Radio Edit" say which version, not which song. */
const MIX_TAIL = /\s*[([]\s*([^)\]]*?)\s*[)\]]\s*$|\s+-\s+([^-]*(?:mix|edit|version|remix|rework|dub|vip|bootleg|remaster(?:ed)?(?: \d{4})?|instrumental|acapella|live)[^-]*)$/i;
const FEAT = /\s*[([]?\s*\b(?:feat|ft|featuring|with)\b\.?\s+[^)\]]*[)\]]?/gi;
/** "Sick Bass (Original Mix) [feat. X]" → { title: "sick bass", mix: "original mix" }. */
export function splitTitle(raw: string | undefined): { title: string; mix: string } {
  let s = fold(raw ?? '').trim(), mix = '';
  for (let i = 0; i < 3; i++) {
    const m = MIX_TAIL.exec(s);
    if (!m || m.index === 0) break;
    const tail = (m[1] ?? m[2] ?? '').trim();
    if (/^(?:feat|ft|featuring|with)\b/.test(tail)) { s = s.slice(0, m.index); continue; }
    if (!mix) mix = tail;
    s = s.slice(0, m.index);
  }
  s = s.replace(FEAT, ' ');
  return { title: words(s), mix: words(mix) };
}
/** The part of a mix name that says WHICH version: "Luca Agnelli Extended Remix" → "luca agnelli remix"; "Original Mix",
 *  "Extended Mix", "Radio Edit" → "" (the same recording for the show). */
export const mixCore = (m: string) => words(fold(m)).replace(/\b(?:original|extended|radio|club|album|single|main|edit|mix|version|remaster(?:ed)?|\d{4})\b/g, ' ').replace(/\s+/g, ' ').trim();
/** Artists as a set of normalised names ("A, B & C feat. D" → a, b, c, d). */
export function artistSet(raw: string | undefined): Set<string> {
  return new Set(fold(raw ?? '').split(/\s*(?:,|;|&|\/|\bx\b|\band\b|\bvs\.?|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b)\s*/).map(words).filter(Boolean));
}
/** The library's title key: the song without its mix / feat. tail. */
export const titleKey = (title: string | undefined) => splitTitle(title).title;

/**
 * How well a reported name fits a library entry (0 = no; higher = better). The title (without mix / feat.) must be the
 * same; the artists must share someone when both sides name any; a named remix must agree when both sides name one
 * (an "Extended Mix" equals the "Original Mix": the same recording for the show).
 */
export function nameScore(rep: { title?: string; artist?: string; mix?: string }, e: { title?: string; artist?: string; mix?: string }): number {
  if (!rep.title || !e.title) return 0;
  const a = splitTitle(rep.title), b = splitTitle(e.title);
  if (!a.title || a.title !== b.title) return 0;
  let s = 10;
  const ra = artistSet(rep.artist), ea = artistSet(e.artist);
  if (ra.size && ea.size) {
    let shared = 0; for (const x of ra) if (ea.has(x)) shared++;
    if (!shared) return 0;
    s += shared === ra.size && shared === ea.size ? 5 : 3;
  }
  const am = mixCore(rep.mix || a.mix), bm = mixCore(e.mix || b.mix);
  if (am !== bm) {
    if (am && bm) return 0;   // two different remixes
    s -= 3;                   // one side names a remix, the other doesn't say
  } else s += am ? 4 : 2;
  return s;
}
