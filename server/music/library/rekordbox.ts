// rekordbox, read-only, two ways that need no key and no decryption (master.db is encrypted: we never touch it):
//  1. the collection the DJ exports once (File → Export Collection in xml format): every track's full path, length,
//     beat grid (TEMPO, several for dynamic grids) and cues (POSITION_MARK) — official format (rekordbox XML format list);
//  2. rekordbox's own analysis files on this PC (…\Pioneer\rekordbox\share\PIONEER\USBANLZ, or a USB stick's
//     PIONEER\USBANLZ): the phrase analysis (PSSI), the 3-band waveform and the grid, tied to the track by the file name
//     stored inside each file (PPTH; rekordbox 7 keeps only "?/<file name>" there). Duplicate names are told apart by
//     length / first beat from the XML, else the newest analysis wins.
import fs from 'node:fs';
import path from 'node:path';
import { baseName, bytesToB64, gridFromBeats, phrasesFrom, type GridAnchor, type TrackCue, type TrackGrid } from '../../../shared/trackAnalysis.ts';
import type { PhraseKind } from '../../../shared/musicClock.ts';
import { parseAnlz, type Anlz } from './anlz.ts';
import { wavePrintFromDetail } from '../../../shared/waveLock.ts';
import { attrNum, walkXml } from './xml.ts';
import type { ImportedTrack, ImportResult } from './types.ts';
import { isSampleEntry, MIN_TRACK_S, STREAM_LABEL, streamFromLocation, streamFromPpth, streamKey, type StreamService } from './streaming.ts';

/** "file://localhost/C:/Music/a%20b.mp3" → "C:/Music/a b.mp3" (macOS: "/Users/…"). */
export function locationToPath(loc: string): string {
  let s = loc.replace(/^file:\/\/localhost\//i, '').replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, '');
  try { s = decodeURIComponent(s); } catch { /* keep */ }
  if (!/^[A-Za-z]:/.test(s) && !s.startsWith('/')) s = '/' + s;
  return s;
}

/** rekordbox.xml → tracks (grid + cues + path; streaming tracks by their service id). Sampler sounds are left out. */
export function parseRekordboxXml(src: string): ImportResult {
  const tracks: ImportedTrack[] = [];
  let cur: { t: ImportedTrack; tempos: { s: number; bpm: number; bib: number }[]; cues: TrackCue[]; sample: boolean } | null = null;
  let inCollection = false, sawRoot = false, samples = 0;
  const finish = () => {
    if (!cur) return;
    const { t, tempos, cues } = cur;
    if (cur.sample) { samples++; cur = null; return; }
    const grid = gridFromTempos(tempos);
    if (grid) { t.part.grid = grid; t.part.bpm = grid.anchors[0].bpm; }
    if (cues.length) t.part.cues = cues.sort((a, b) => a.ms - b.ms);
    tracks.push(t); cur = null;
  };
  walkXml(src, (tag, p) => {
    if (tag.name === 'DJ_PLAYLISTS') sawRoot = true;
    if (tag.name === 'COLLECTION') { inCollection = true; return; }
    if (!inCollection) return;
    if (tag.name === 'TRACK' && p[p.length - 1] === 'COLLECTION') {
      finish();
      const a = tag.attrs;
      // a streaming track (Beatport, …: "file://localhost//v4/catalog/tracks/<id>/") has no file: keyed by its id
      const stream = streamFromLocation(a.Location);
      const loc = a.Location && !stream ? locationToPath(a.Location) : '';
      const durS = attrNum(a, 'TotalTime');
      const t: ImportedTrack = { src: 'rekordbox', base: stream ? streamKey(stream) : baseName(loc || a.Name || ''), part: { srcs: ['rekordbox'] }, ...(a.TrackID ? { ref: a.TrackID } : {}) };
      if (stream) t.stream = stream;
      if (loc) t.path = loc;
      if (a.Name) t.title = a.Name.slice(0, 200); if (a.Artist) t.artist = a.Artist.slice(0, 200);
      if (a.Mix) t.mix = a.Mix.slice(0, 200);
      if (Number.isFinite(durS)) t.durMs = durS * 1000;
      const bpm = attrNum(a, 'AverageBpm'); if (bpm > 0) t.bpm = bpm;
      cur = { t, tempos: [], cues: [], sample: isSampleEntry({ path: loc, ...(a.TotalTime !== undefined ? { durS } : {}), stream: !!stream }) };
      if (tag.empty) finish();
      return;
    }
    if (!cur) return;
    if (tag.name === 'TEMPO') {
      const s = attrNum(tag.attrs, 'Inizio'), bpm = attrNum(tag.attrs, 'Bpm'), bib = attrNum(tag.attrs, 'Battito');
      if (Number.isFinite(s) && bpm > 0) cur.tempos.push({ s, bpm, bib: bib >= 1 && bib <= 4 ? bib : 1 });
    } else if (tag.name === 'POSITION_MARK') {
      const a = tag.attrs, type = attrNum(a, 'Type'), start = attrNum(a, 'Start'), end = attrNum(a, 'End'), num = attrNum(a, 'Num');
      if (!Number.isFinite(start)) return;
      const kind: TrackCue['kind'] = type === 4 ? 'loop' : type === 1 ? 'fadein' : type === 2 ? 'fadeout' : type === 3 ? 'load' : num >= 0 ? 'hot' : 'memory';
      const c: TrackCue = { ms: Math.round(start * 1000), kind };
      if (Number.isFinite(end) && end > start) c.end = Math.round(end * 1000);
      if (num >= 0) c.n = num;
      const r = attrNum(a, 'Red'), g = attrNum(a, 'Green'), b = attrNum(a, 'Blue');
      if ([r, g, b].every((v) => v >= 0 && v <= 255)) c.color = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      if (a.Name) c.name = a.Name.slice(0, 80);
      cur.cues.push(c);
    }
  }, (name) => { if (name === 'TRACK') finish(); if (name === 'COLLECTION') { finish(); inCollection = false; } });
  finish();
  const n = tracks.length, withGrid = tracks.filter((t) => t.part.grid).length;
  return { tracks, samples, says: !sawRoot ? 'That file isn’t a rekordbox collection export.' : `${n} track${n === 1 ? '' : 's'} from rekordbox (${withGrid} with a beat grid${streamSays(tracks)})${samples ? ` · ${samples} sampler sound${samples === 1 ? '' : 's'} skipped` : ''}.`, warnings: [] };
}
/** ", 64 Beatport + 27 Spotify streaming" (nothing without streaming tracks). */
export function streamSays(tracks: { stream?: { svc: StreamService } }[]): string {
  const by = new Map<StreamService, number>();
  for (const t of tracks) if (t.stream) by.set(t.stream.svc, (by.get(t.stream.svc) ?? 0) + 1);
  return by.size ? `, ${[...by].map(([k, v]) => `${v} ${STREAM_LABEL[k]}`).join(' + ')} streaming` : '';
}
/** TEMPO entries (s, BPM, beat in bar) → a grid (beat 0 = the first entry). */
export function gridFromTempos(tempos: { s: number; bpm: number; bib: number }[]): TrackGrid | null {
  const t = [...tempos].sort((a, b) => a.s - b.s);
  if (!t.length) return null;
  const anchors: GridAnchor[] = [{ ms: t[0].s * 1000, beat: 0, bpm: t[0].bpm }];
  for (let i = 1; i < t.length; i++) {
    const p = anchors[anchors.length - 1];
    const beat = p.beat + Math.round((t[i].s * 1000 - p.ms) * p.bpm / 60000);
    if (beat <= p.beat) continue;
    if (Math.abs(t[i].bpm - p.bpm) < 0.001 && Math.abs(p.ms + (beat - p.beat) * 60000 / p.bpm - t[i].s * 1000) < 2) continue;
    anchors.push({ ms: +(t[i].s * 1000).toFixed(2), beat, bpm: t[i].bpm });
  }
  return { anchors: anchors.map((a) => ({ ...a, ms: +a.ms.toFixed(2) })), downbeat: ((1 - t[0].bib) % 4 + 4) % 4, src: 'rekordbox' };
}

// ---------------------------------------------------------------------------------------------------- analysis files
export interface AnlzSet { dat?: string; ext?: string; ex2?: string; mtime: number; base: string; path: string }
/** Find every ANLZ file set under a USBANLZ folder (or any folder): DAT / EXT / 2EX siblings by stem. */
export function scanAnlzFolder(root: string, maxSets = 50000): AnlzSet[] {
  const sets = new Map<string, AnlzSet>();
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || sets.size >= maxSets) return;
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      const m = /^(ANLZ\d{4})\.(DAT|EXT|2EX)$/i.exec(e.name);
      if (!m) continue;
      const stem = path.join(dir, m[1]);
      let s = sets.get(stem);
      if (!s) { s = { mtime: 0, base: '', path: '' }; sets.set(stem, s); }
      const ext = m[2].toUpperCase();
      if (ext === 'DAT') s.dat = p; else if (ext === 'EXT') s.ext = p; else s.ex2 = p;
      try { s.mtime = Math.max(s.mtime, fs.statSync(p).mtimeMs); } catch { /* gone */ }
    }
  };
  walk(root, 0);
  // the audio file name, from whichever file of the set has a PPTH
  for (const s of sets.values()) {
    for (const f of [s.dat, s.ext, s.ex2]) {
      if (!f) continue;
      // (a streaming track's analysis is keyed by its service id: "?/spotify:track:<id>" keeps the id's case)
      try { const a = parseAnlzHead(f); if (a) { const st = streamFromPpth(a); s.path = a; s.base = st ? streamKey(st) : baseName(a); break; } } catch { /* unreadable */ }
    }
  }
  return [...sets.values()].filter((s) => s.base);
}
/** Just the PPTH path of an ANLZ file (reads the first 4 KB). */
function parseAnlzHead(file: string): string | null {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(4096);
    const n = fs.readSync(fd, b, 0, 4096, 0);
    const a = parseAnlz(b.subarray(0, n).length >= 28 ? fixLen(b.subarray(0, n)) : b.subarray(0, n));
    return a?.path ?? null;
  } finally { fs.closeSync(fd); }
}
/** A truncated head: pretend the file ends here (the tag walk stops at the first tag that doesn't fit). */
function fixLen(b: Buffer): Buffer { const c = Buffer.from(b); if (c.length >= 12) c.writeUInt32BE(c.length, 8); return c; }

/** One ANLZ set → an imported track (grid, phrases, cues, waveform). */
export function anlzSetToTrack(s: AnlzSet, o: { phrases?: boolean } = {}): ImportedTrack | null {
  const parts: Anlz[] = [];
  for (const f of [s.dat, s.ext, s.ex2]) { if (!f) continue; try { const a = parseAnlz(fs.readFileSync(f), o); if (a) parts.push(a); } catch { /* unreadable */ } }
  if (!parts.length) return null;
  return anlzToTrack(parts, s.path);
}
export function anlzToTrack(parts: Anlz[], ppth: string): ImportedTrack {
  const stream = streamFromPpth(ppth);
  const t: ImportedTrack = { src: 'rekordbox', base: stream ? streamKey(stream) : baseName(ppth), part: { srcs: ['rekordbox'] } };
  if (stream) t.stream = stream;
  else if (ppth && !ppth.startsWith('?')) t.path = ppth;
  const beats = parts.find((p) => p.beats?.length)?.beats;
  if (beats) {
    const g = gridFromBeats(beats.map((b) => ({ ms: b.ms, bib: b.bib, bpm: b.bpm })), 'rekordbox');
    if (g) { t.part.grid = g; t.part.bpm = g.anchors[0].bpm; }
  }
  const pssi = parts.find((p) => p.pssi?.phrases.length)?.pssi;
  if (pssi) {
    // PSSI counts beats from 1 (the grid's first beat); ours from 0
    t.part.phrases = phrasesFrom(pssi.phrases.map((p) => ({ beat: p.beat - 1, kind: p.label as PhraseKind, mood: pssi.mood })), pssi.endBeat - 1, 'rekordbox');
  }
  const cues: TrackCue[] = [];
  for (const p of parts) for (const c of p.cues) {
    const kind: TrackCue['kind'] = c.kind === 'loop' ? 'loop' : c.memory ? 'memory' : 'hot';
    if (cues.some((d) => Math.abs(d.ms - c.ms) < 2 && d.kind === kind)) continue;
    cues.push({ ms: c.ms, kind, ...(c.endMs !== undefined ? { end: c.endMs } : {}), ...(!c.memory ? { n: c.hot - 1 } : {}), ...(c.color ? { color: c.color } : {}), ...(c.name ? { name: c.name } : {}) });
  }
  if (cues.length) t.part.cues = cues.sort((a, b) => a.ms - b.ms);
  const bands = parts.find((p) => p.bands)?.bands;
  if (bands) t.part.bands = { cols: bands.cols, b64: bytesToB64(bands.data), src: 'rekordbox' };
  // the track's length: the 3-band detail runs 150 columns a second (else the last beat)
  const det = parts.find((p) => p.detail)?.detail;
  if (det) t.durMs = Math.round(det.cols / det.perSec * 1000);
  // a streaming track (no file to learn from): keep the detail waveform's band onsets to find the place in it the first
  // time it plays (shared/waveLock.ts); ~40 KB for a five-minute track
  if (det && stream) { const w = wavePrintFromDetail(det); if (w) t.part.wave = { ...w, src: 'rekordbox' }; }   // (without it the length stays unknown: the last beat isn't the end)
  return t;
}

/**
 * Index a USBANLZ folder by file name and pick, for every name, the analysis that belongs to the XML's track: same
 * length (± 1.5 s) and the same first beat (± 30 ms) when the XML is known; else the newest analysis.
 */
export function importAnlzFolder(root: string, xml: ImportedTrack[] = [], o: { phrases?: boolean } = {}): ImportResult {
  const sets = scanAnlzFolder(root);
  const byBase = new Map<string, AnlzSet[]>();
  for (const s of sets) { const l = byBase.get(s.base) ?? []; l.push(s); byBase.set(s.base, l); }
  const tracks: ImportedTrack[] = [];
  const warnings: string[] = [];
  let samples = 0;
  for (const [base, list] of byBase) {
    const loaded = list.sort((a, b) => b.mtime - a.mtime).map((s) => anlzSetToTrack(s, o)).filter((t): t is ImportedTrack => !!t);
    if (!loaded.length) continue;
    // a sampler sound / one-shot (shorter than 30 s) isn't a track (a streaming track is always one)
    if (!loaded[0].stream && loaded.every((t) => t.durMs !== undefined && t.durMs < MIN_TRACK_S * 1000)) { samples++; continue; }
    const xs = xml.filter((x) => x.base === base);
    if (xs.length && loaded.length > 1) {
      // several analyses share this name: match each XML track to its own
      for (const x of xs) {
        const firstBeat = x.part.grid?.anchors[0].ms;
        const m = loaded.find((t) => (x.durMs === undefined || t.durMs === undefined || Math.abs(t.durMs - x.durMs) < 1500)
          && (firstBeat === undefined || !t.part.grid || Math.abs(t.part.grid.anchors[0].ms - firstBeat) < 30)) ?? loaded[0];
        tracks.push({ ...m, ...(x.path ? { path: x.path } : {}), ...(x.durMs ? { durMs: x.durMs } : {}) });
      }
    } else tracks.push(loaded[0]);
  }
  const n = tracks.length, withPhrases = tracks.filter((t) => t.part.phrases?.length).length;
  const sk = samples ? ` · ${samples} sampler sound${samples === 1 ? '' : 's'} skipped` : '';
  return {
    tracks, warnings, samples,
    says: !sets.length ? 'No rekordbox analysis files in that folder.' : o.phrases === false ? `${n} analysed track${n === 1 ? '' : 's'}${streamSays(tracks).replace(/^, /, ' (') + (streamSays(tracks) ? ')' : '')} (grids + waveforms; reading rekordbox’s phrases is turned off)${sk}.` : `${n} analysed track${n === 1 ? '' : 's'} (${withPhrases} with phrase analysis${withPhrases < n ? ' — turn on phrase analysis in rekordbox for the rest' : ''}${streamSays(tracks).replace(/^, /, '; ')})${sk}.`,
  };
}
