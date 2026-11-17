// Engine DJ (Denon / Numark / Rane: Engine DJ desktop and Engine OS players' USB sticks): the library is plain SQLite,
// `Engine Library/Database2/m.db`. Opened READ-ONLY (Denon's guidance for third-party tools: read-only, never edit the
// schema); while Engine DJ has it open we read a temporary copy. Per track: path, length, BPM and the analysis blobs —
// beatData (the grid: sample rate, then default + adjusted grids of {sample offset, beat index, beats to next}),
// quickCues (8 hot cues + the main cue) and overviewWaveFormData (1024 × low / mid / high). Blobs are Qt qCompress'd
// (u32 big-endian length + zlib). Layout from the Mixxx wiki "Engine Library Format" (format notes) and checked against
// libdjinterop's published schema SQL at test time; the field endianness is detected, not assumed.
// Engine shows no phrase analysis in its database: those tracks get our own analysis.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { baseName, bytesToB64, type GridAnchor, type TrackCue, type TrackGrid } from '../../../shared/trackAnalysis.ts';
import type { ImportedTrack, ImportResult } from './types.ts';

/** Qt qUncompress: u32 BE uncompressed length + a zlib stream. */
export function qUncompress(b: Uint8Array | null | undefined): Buffer | null {
  if (!b || b.length < 5) return null;
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  const n = buf.readUInt32BE(0);
  if (n > 64 << 20) return null;
  try { const out = zlib.inflateSync(buf.subarray(4)); return out.length === n || n === 0 ? out : out.subarray(0, n); } catch { return null; }
}
export function qCompress(b: Buffer): Buffer { const h = Buffer.alloc(4); h.writeUInt32BE(b.length, 0); return Buffer.concat([h, zlib.deflateSync(b)]); }

export interface EngineMarker { offset: number; beat: number; toNext: number }
export interface EngineBeatData { sampleRate: number; samples: number; set: boolean; def: EngineMarker[]; adj: EngineMarker[] }
/** beatData → grids. Header numbers big-endian, marker fields little-endian (as libdjinterop writes them); if the
 *  sample rate doesn't make sense one way, the other byte order is tried. */
export function parseBeatData(b: Buffer): EngineBeatData | null {
  for (const markersLE of [true, false]) {
    try {
      let o = 0;
      const sampleRate = b.readDoubleBE(o); o += 8;
      const samples = b.readDoubleBE(o); o += 8;
      if (!(sampleRate >= 8000 && sampleRate <= 192000)) return null;
      const set = b[o] !== 0; o += 1;
      const grid = (): EngineMarker[] => {
        const n = Number(b.readBigInt64BE(o)); o += 8;
        if (n < 0 || n > 4096) throw new Error('bad count');
        const out: EngineMarker[] = [];
        for (let i = 0; i < n; i++) {
          const offset = markersLE ? b.readDoubleLE(o) : b.readDoubleBE(o);
          const beat = Number(markersLE ? b.readBigInt64LE(o + 8) : b.readBigInt64BE(o + 8));
          const toNext = markersLE ? b.readInt32LE(o + 16) : b.readInt32BE(o + 16);
          o += 24;
          out.push({ offset, beat, toNext });
        }
        return out;
      };
      const def = grid(), adj = grid();
      const sane = (m: EngineMarker[]) => m.every((x) => Number.isFinite(x.offset) && Math.abs(x.offset) < samples * 2 + sampleRate * 60 && Math.abs(x.beat) < 1e6);
      if (!sane(def) || !sane(adj)) continue;
      return { sampleRate, samples, set, def, adj };
    } catch { /* try the other byte order */ }
  }
  return null;
}
export function engineGrid(bd: EngineBeatData): TrackGrid | null {
  const m = (bd.adj.length >= 2 ? bd.adj : bd.def).slice().sort((a, b) => a.beat - b.beat);
  if (m.length < 2) return null;
  const anchors: GridAnchor[] = [];
  for (let i = 0; i < m.length - 1; i++) {
    const db = m[i + 1].beat - m[i].beat, ds = (m[i + 1].offset - m[i].offset) / bd.sampleRate;
    if (!(db > 0) || !(ds > 0)) continue;
    const bpm = db / ds * 60;
    const p = anchors[anchors.length - 1];
    if (p && Math.abs(p.bpm - bpm) < 0.005) continue;
    anchors.push({ ms: +(m[i].offset / bd.sampleRate * 1000).toFixed(3), beat: m[i].beat, bpm: +bpm.toFixed(4) });
  }
  if (!anchors.length) return null;
  // Engine counts bars from beat 0 (its "first downbeat"); our beat 0 stays its beat 0
  return { anchors, downbeat: 0, src: 'engine' };
}
/** quickCues → hot cues (+ the main cue as a memory point). */
export function parseQuickCues(b: Buffer, sampleRate: number): TrackCue[] {
  const out: TrackCue[] = [];
  try {
    let o = 0;
    const n = Number(b.readBigInt64BE(o)); o += 8;
    for (let i = 0; i < n && i < 16; i++) {
      const len = b[o]; o += 1;
      const name = b.toString('utf8', o, o + len); o += len;
      const pos = b.readDoubleBE(o); o += 8;
      const [, r, g, bl] = [b[o], b[o + 1], b[o + 2], b[o + 3]]; o += 4;
      if (pos >= 0 && sampleRate > 0) out.push({ ms: Math.round(pos / sampleRate * 1000), kind: 'hot', n: i, color: `#${[r, g, bl].map((v) => v.toString(16).padStart(2, '0')).join('')}`, ...(name ? { name: name.slice(0, 80) } : {}) });
    }
    const main = b.readDoubleBE(o);
    if (main >= 0 && sampleRate > 0) out.push({ ms: Math.round(main / sampleRate * 1000), kind: 'cue' });
  } catch { /* truncated: keep what was read */ }
  return out;
}
/** overviewWaveFormData → [low, mid, high] columns. */
export function parseOverview(b: Buffer): { cols: number; data: Uint8Array } | null {
  try {
    const n = Number(b.readBigUInt64BE(0));
    if (!(n > 0 && n <= 8192) || 24 + n * 3 > b.length) return null;
    return { cols: n, data: new Uint8Array(b.subarray(24, 24 + n * 3)) };
  } catch { return null; }
}

type Row = Record<string, unknown>;
interface Db { prepare(sql: string): { all(...a: unknown[]): Row[] }; close(): void }
async function openRo(file: string): Promise<{ db: Db; tmp: string | null }> {
  let mod: { DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => Db };
  try { mod = await import('node:sqlite') as unknown as typeof mod; }
  catch { throw new Error('Reading Engine DJ / Mixxx libraries is not possible with this version of Node.js (it has no node:sqlite).'); }
  try { const db = new mod.DatabaseSync(file, { readOnly: true }); db.prepare('SELECT 1').all(); return { db, tmp: null }; }
  catch {
    // the app has it locked: read a temporary copy (deleted right after)
    const tmp = path.join(os.tmpdir(), `vtp-djlib-${process.pid}-${Date.now()}.db`);
    fs.copyFileSync(file, tmp);
    return { db: new mod.DatabaseSync(tmp, { readOnly: true }), tmp };
  }
}
export { openRo as openSqliteReadOnly };

/** An Engine Library folder (or its m.db) → tracks. */
export async function importEngine(where: string): Promise<ImportResult> {
  let file = where;
  try { if (fs.statSync(where).isDirectory()) { const c = [path.join(where, 'Database2', 'm.db'), path.join(where, 'Engine Library', 'Database2', 'm.db'), path.join(where, 'm.db')].find((p) => fs.existsSync(p)); if (c) file = c; } } catch { /* not there */ }
  if (!fs.existsSync(file)) return { tracks: [], says: 'No Engine DJ library there (looking for Engine Library\\Database2\\m.db).', warnings: [] };
  const libDir = path.dirname(path.dirname(file));
  const { db, tmp } = await openRo(file);
  const tracks: ImportedTrack[] = [];
  const warnings: string[] = [];
  try {
    const cols = new Set(db.prepare('PRAGMA table_info(Track)').all().map((r) => String(r.name)));
    if (!cols.size) return { tracks, says: 'That Engine DJ database has no tracks table (a very old Engine version?).', warnings };
    const blob = cols.has('beatData');
    const has = (c: string) => (cols.has(c) ? c : `NULL AS ${c}`);
    const sql = blob
      ? `SELECT id, ${has('path')}, ${has('filename')}, ${has('title')}, ${has('artist')}, ${has('length')}, ${has('bpmAnalyzed')}, trackData, beatData, quickCues, overviewWaveFormData FROM Track`
      : `SELECT t.id, t.path, t.filename, t.title, t.artist, t.length, t.bpmAnalyzed, p.trackData, p.beatData, p.quickCues, p.overviewWaveFormData FROM Track t LEFT JOIN PerformanceData p ON p.trackId = t.id`;
    let rows: Row[];
    try { rows = db.prepare(sql).all(); } catch (e) { return { tracks, says: `Couldn’t read that Engine DJ database (${(e as Error).message}).`, warnings }; }
    for (const r of rows) {
      const rel = typeof r.path === 'string' ? r.path : '';
      // Engine keeps paths relative to its library folder ("../../Music/a.mp3" is normal); the result must be an audio
      // file path, and is only ever read inside a music folder the user allowed (store.ts)
      const full = rel && !rel.includes('\0') ? path.resolve(libDir, rel) : '';
      const t: ImportedTrack = { src: 'engine', base: baseName(rel || String(r.filename ?? '')), part: { srcs: ['engine'] }, ref: String(r.id) };
      if (!t.base) continue;
      if (full) t.path = full;
      if (typeof r.title === 'string' && r.title) t.title = r.title.slice(0, 200);
      if (typeof r.artist === 'string' && r.artist) t.artist = r.artist.slice(0, 200);
      if (typeof r.length === 'number' && r.length > 0) t.durMs = r.length * 1000;
      if (typeof r.bpmAnalyzed === 'number' && r.bpmAnalyzed > 0) t.bpm = r.bpmAnalyzed;
      const bd = qUncompress(r.beatData as Uint8Array);
      const beat = bd ? parseBeatData(bd) : null;
      if (beat) { const g = engineGrid(beat); if (g) { t.part.grid = g; t.part.bpm = g.anchors[0].bpm; } if (!t.durMs && beat.samples > 0) t.durMs = beat.samples / beat.sampleRate * 1000; }
      else if (bd && warnings.length < 3) warnings.push(`${t.base}: its beat grid wasn’t readable.`);
      const qc = qUncompress(r.quickCues as Uint8Array);
      if (qc && beat) { const c = parseQuickCues(qc, beat.sampleRate); if (c.length) t.part.cues = c; }
      const ov = qUncompress(r.overviewWaveFormData as Uint8Array);
      const o = ov ? parseOverview(ov) : null;
      if (o) t.part.bands = { cols: o.cols, b64: bytesToB64(o.data), src: 'engine' };
      tracks.push(t);
    }
  } finally {
    try { db.close(); } catch { /* closed */ }
    if (tmp) try { fs.unlinkSync(tmp); } catch { /* temp */ }
  }
  const n = tracks.length, g = tracks.filter((t) => t.part.grid).length;
  return { tracks, says: `${n} track${n === 1 ? '' : 's'} from Engine DJ (${g} with a beat grid).`, warnings };
}

// ---------------------------------------------------------------------------------------------------- tests: writers
export function buildBeatData(sampleRate: number, samples: number, markers: EngineMarker[]): Buffer {
  const enc = (m: EngineMarker[]) => { const h = Buffer.alloc(8); h.writeBigInt64BE(BigInt(m.length)); return Buffer.concat([h, ...m.map((x) => { const e = Buffer.alloc(24); e.writeDoubleLE(x.offset, 0); e.writeBigInt64LE(BigInt(x.beat), 8); e.writeInt32LE(x.toNext, 16); return e; })]); };
  const h = Buffer.alloc(17); h.writeDoubleBE(sampleRate, 0); h.writeDoubleBE(samples, 8); h[16] = 1;
  return Buffer.concat([h, enc(markers), enc(markers)]);
}
export function buildQuickCues(sampleRate: number, cues: { name: string; ms: number; rgb: [number, number, number] }[], mainMs: number): Buffer {
  const parts: Buffer[] = [];
  const h = Buffer.alloc(8); h.writeBigInt64BE(8n); parts.push(h);
  for (let i = 0; i < 8; i++) {
    const c = cues[i];
    const name = Buffer.from(c?.name ?? '', 'utf8');
    const e = Buffer.alloc(1 + name.length + 8 + 4);
    e[0] = name.length; name.copy(e, 1); e.writeDoubleBE(c ? c.ms / 1000 * sampleRate : -1, 1 + name.length);
    if (c) { e[1 + name.length + 8] = 255; e[1 + name.length + 9] = c.rgb[0]; e[1 + name.length + 10] = c.rgb[1]; e[1 + name.length + 11] = c.rgb[2]; }
    parts.push(e);
  }
  const t = Buffer.alloc(17); t.writeDoubleBE(mainMs / 1000 * sampleRate, 0); t[8] = 1; t.writeDoubleBE(mainMs / 1000 * sampleRate, 9); parts.push(t);
  return Buffer.concat(parts);
}
export function buildOverview(cols: Uint8Array): Buffer {
  const n = cols.length / 3, h = Buffer.alloc(24); h.writeBigUInt64BE(BigInt(n), 0); h.writeBigUInt64BE(BigInt(n), 8); h.writeDoubleBE(1024, 16);
  return Buffer.concat([h, Buffer.from(cols), Buffer.from([255, 255, 255])]);
}
