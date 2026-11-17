// Mixxx: mixxxdb.sqlite (%LOCALAPPDATA%\Mixxx on Windows, ~/.mixxx on Linux, ~/Library/Containers/org.mixxx.mixxx/… on
// macOS), opened READ-ONLY. Per track: the file (track_locations), length, BPM and the beat grid BLOB, tagged by
// `beats_version`: "BeatGrid-2.0" (bpm + first beat) or "BeatMap-1.0" (every beat). Both are protocol-buffer messages;
// Mixxx is GPL, so nothing of its code or .proto files is used: the two or three fields are decoded here by hand from the
// generic protobuf wire format. Cues come from the `cues` table (sample positions). Unverified on real data: whether
// `frame_position` counts stereo frames (assumed) — noted in docs/DJ_SYNC.md.
import fs from 'node:fs';
import { baseName, constantGrid, gridFromBeats, type TrackCue, type TrackGrid } from '../../../shared/trackAnalysis.ts';
import { openSqliteReadOnly } from './engine.ts';
import type { ImportedTrack, ImportResult } from './types.ts';

// ---------------------------------------------------------------------------------------------------- protobuf wire
type PbField = { n: number; wt: number; v: number | Buffer };
export function readPb(b: Buffer): PbField[] {
  const out: PbField[] = [];
  let o = 0;
  const varint = () => { let r = 0, s = 0, byte: number; do { if (o >= b.length) throw new Error('truncated'); byte = b[o++]; r += (byte & 0x7f) * 2 ** s; s += 7; } while (byte & 0x80 && s < 64); return r; };
  while (o < b.length) {
    const key = varint(), n = Math.floor(key / 8), wt = key & 7;
    if (wt === 0) out.push({ n, wt, v: varint() });
    else if (wt === 1) { if (o + 8 > b.length) break; out.push({ n, wt, v: b.readDoubleLE(o) }); o += 8; }
    else if (wt === 2) { const len = varint(); if (o + len > b.length) break; out.push({ n, wt, v: b.subarray(o, o + len) }); o += len; }
    else if (wt === 5) { if (o + 4 > b.length) break; out.push({ n, wt, v: b.readFloatLE(o) }); o += 4; }
    else break;
  }
  return out;
}
const int32 = (v: number) => (v > 0x7fffffff ? v - 2 ** 64 : v);
/** BeatGrid-2.0: { bpm: { bpm: double } = 1, first_beat: { frame_position: int32 = 1 } = 2 }. */
export function parseMixxxBeatGrid(b: Buffer, sampleRate: number): TrackGrid | null {
  const f = readPb(b);
  const bpmMsg = f.find((x) => x.n === 1 && Buffer.isBuffer(x.v));
  const beatMsg = f.find((x) => x.n === 2 && Buffer.isBuffer(x.v));
  const bpm = bpmMsg ? readPb(bpmMsg.v as Buffer).find((x) => x.n === 1 && x.wt === 1)?.v as number | undefined : undefined;
  const frame = beatMsg ? readPb(beatMsg.v as Buffer).find((x) => x.n === 1 && x.wt === 0)?.v as number | undefined : 0;
  if (!(bpm && bpm > 0) || !(sampleRate > 0)) return null;
  return constantGrid(+(int32(frame ?? 0) / sampleRate * 1000).toFixed(3), bpm, 'mixxx');
}
/** BeatMap-1.0: { repeated beat: { frame_position: int32 = 1, enabled: bool = 2 } = 1 }. */
export function parseMixxxBeatMap(b: Buffer, sampleRate: number): TrackGrid | null {
  const beats = readPb(b).filter((x) => x.n === 1 && Buffer.isBuffer(x.v)).map((x) => {
    const g = readPb(x.v as Buffer);
    const fp = g.find((y) => y.n === 1 && y.wt === 0)?.v as number | undefined;
    const en = g.find((y) => y.n === 2 && y.wt === 0)?.v;
    return fp === undefined || en === 0 ? null : { ms: int32(fp) / sampleRate * 1000 };
  }).filter((x): x is { ms: number } => !!x);
  return sampleRate > 0 ? gridFromBeats(beats, 'mixxx') : null;
}
// (tests) protobuf writers
const vint = (v: number) => { const o: number[] = []; let x = v < 0 ? v + 2 ** 64 : v; do { let b = x % 128; x = Math.floor(x / 128); if (x) b |= 0x80; o.push(b); } while (x); return Buffer.from(o); };
const fld = (n: number, wt: number, payload: Buffer) => Buffer.concat([vint(n * 8 + wt), payload]);
const lenD = (n: number, p: Buffer) => fld(n, 2, Buffer.concat([vint(p.length), p]));
const dbl = (v: number) => { const b = Buffer.alloc(8); b.writeDoubleLE(v); return b; };
export function buildMixxxBeatGrid(bpm: number, frame: number): Buffer { return Buffer.concat([lenD(1, fld(1, 1, dbl(bpm))), lenD(2, fld(1, 0, vint(frame)))]); }
export function buildMixxxBeatMap(frames: number[]): Buffer { return Buffer.concat(frames.map((f) => lenD(1, Buffer.concat([fld(1, 0, vint(f)), fld(2, 0, vint(1))])))); }

type Row = Record<string, unknown>;
export async function importMixxx(file: string): Promise<ImportResult> {
  if (!fs.existsSync(file)) return { tracks: [], says: 'No Mixxx library there (looking for mixxxdb.sqlite).', warnings: [] };
  const { db, tmp } = await openSqliteReadOnly(file);
  const tracks: ImportedTrack[] = [];
  try {
    let rows: Row[];
    try {
      rows = db.prepare(`SELECT l.id, l.title, l.artist, l.duration, l.bpm, l.beats, l.beats_version, l.samplerate, t.location FROM library l LEFT JOIN track_locations t ON t.id = l.location`).all();
    } catch (e) { return { tracks, says: `Couldn’t read that Mixxx library (${(e as Error).message}).`, warnings: [] }; }
    let cues: Row[] = [];
    try { cues = db.prepare('SELECT track_id, type, position, length, hotcue, label FROM cues').all(); } catch { /* older schema */ }
    for (const r of rows) {
      const loc = typeof r.location === 'string' ? r.location : '';
      if (!loc) continue;
      const sr = typeof r.samplerate === 'number' && r.samplerate > 0 ? r.samplerate : 44100;
      const t: ImportedTrack = { src: 'mixxx', path: loc, base: baseName(loc), part: { srcs: ['mixxx'] }, ref: String(r.id) };
      if (typeof r.title === 'string' && r.title) t.title = r.title.slice(0, 200);
      if (typeof r.artist === 'string' && r.artist) t.artist = r.artist.slice(0, 200);
      if (typeof r.duration === 'number' && r.duration > 0) t.durMs = r.duration * 1000;
      if (typeof r.bpm === 'number' && r.bpm > 0) t.bpm = r.bpm;
      const blob = r.beats instanceof Uint8Array ? Buffer.from(r.beats) : null;
      const ver = String(r.beats_version ?? '');
      if (blob) {
        const g = /^BeatGrid/i.test(ver) ? parseMixxxBeatGrid(blob, sr) : /^BeatMap/i.test(ver) ? parseMixxxBeatMap(blob, sr) : null;
        if (g) { t.part.grid = g; t.part.bpm = g.anchors[0].bpm; }
      }
      const mine: TrackCue[] = [];
      for (const c of cues) {
        if (c.track_id !== r.id || typeof c.position !== 'number' || c.position < 0) continue;
        // (positions are interleaved stereo samples)
        const ms = Math.round(c.position / 2 / sr * 1000), hot = typeof c.hotcue === 'number' ? c.hotcue : -1;
        const cue: TrackCue = { ms, kind: c.type === 4 ? 'loop' : hot >= 0 ? 'hot' : 'cue' };
        if (hot >= 0) cue.n = hot;
        if (typeof c.length === 'number' && c.length > 0) cue.end = Math.round((c.position + c.length) / 2 / sr * 1000);
        if (typeof c.label === 'string' && c.label) cue.name = c.label.slice(0, 80);
        mine.push(cue);
      }
      if (mine.length) t.part.cues = mine.sort((a, b) => a.ms - b.ms);
      tracks.push(t);
    }
  } finally {
    try { db.close(); } catch { /* closed */ }
    if (tmp) try { fs.unlinkSync(tmp); } catch { /* temp */ }
  }
  const g = tracks.filter((t) => t.part.grid).length;
  return { tracks, says: `${tracks.length} track${tracks.length === 1 ? '' : 's'} from Mixxx (${g} with a beat grid).`, warnings: [] };
}
