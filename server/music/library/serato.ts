// Serato DJ Pro / Lite keep their analysis INSIDE the music files' tags: ID3 GEOB frames in MP3 / AIFF ("Serato
// BeatGrid", "Serato Markers2", "Serato Overview"), base64 Vorbis comments in FLAC. Formats as documented by
// Holzhaus/serato-tags (MIT; its published sample tags are used by the tests at test time). Which files: Serato's
// library list `_Serato_\database V2` (records of tagged fields; "pfil" = the file path), or a music folder the user
// picks. READ-ONLY: tags are read, never written. MP4 / M4A atoms are not read yet (those tracks get our own analysis).
import fs from 'node:fs';
import path from 'node:path';
import { baseName, bytesToB64, type GridAnchor, type TrackCue, type TrackGrid } from '../../../shared/trackAnalysis.ts';
import type { ImportedTrack, ImportResult } from './types.ts';

// ---------------------------------------------------------------------------------------------------- tag payloads
/** "Serato BeatGrid": 2-byte header, u32 marker count, markers (f32 position s + u32 beats to the next one; the last:
 *  f32 position + f32 BPM), 1 footer byte. */
export function parseSeratoBeatGrid(b: Buffer): TrackGrid | null {
  if (b.length < 6) return null;
  const n = b.readUInt32BE(2);
  if (!(n >= 1 && n <= 4096) || b.length < 6 + n * 8) return null;
  const m: { pos: number; next?: number; bpm?: number }[] = [];
  for (let i = 0; i < n; i++) {
    const o = 6 + i * 8, pos = b.readFloatBE(o);
    if (i === n - 1) m.push({ pos, bpm: b.readFloatBE(o + 4) }); else m.push({ pos, next: b.readUInt32BE(o + 4) });
  }
  const anchors: GridAnchor[] = [];
  let beat = 0;
  for (let i = 0; i < m.length; i++) {
    const x = m[i];
    const bpm = x.bpm ?? (x.next && m[i + 1] && m[i + 1].pos > x.pos ? x.next / (m[i + 1].pos - x.pos) * 60 : 0);
    if (!(bpm > 20 && bpm < 400)) return null;
    anchors.push({ ms: +(x.pos * 1000).toFixed(3), beat, bpm: +bpm.toFixed(4) });
    beat += x.next ?? 0;
  }
  return { anchors, downbeat: 0, src: 'serato' };
}
/** "Serato Markers2": header 01 01 + base64 (line breaks every 72 chars, sometimes one char short) → entries
 *  {type\0, u32 length, data}: CUE (index, position ms, colour, name), LOOP (index, start / end ms, name), …. */
export function parseSeratoMarkers2(raw: Buffer): TrackCue[] {
  if (raw.length < 3) return [];
  let b64 = raw.subarray(2).toString('latin1').replace(/[^A-Za-z0-9+/]/g, '');
  if (b64.length % 4 === 1) b64 += 'A';
  while (b64.length % 4) b64 += '=';
  const d = Buffer.from(b64, 'base64');
  const out: TrackCue[] = [];
  let o = 2;
  while (o < d.length) {
    const z = d.indexOf(0, o);
    if (z < 0 || z === o) break;
    const type = d.toString('latin1', o, z);
    if (z + 5 > d.length) break;
    const len = d.readUInt32BE(z + 1);
    const e = d.subarray(z + 5, z + 5 + len);
    o = z + 5 + len;
    if (type === 'CUE' && e.length >= 13) {
      const nz = e.indexOf(0, 12);
      out.push({ ms: e.readUInt32BE(2), kind: 'hot', n: e[1], color: `#${[e[7], e[8], e[9]].map((v) => v.toString(16).padStart(2, '0')).join('')}`, ...(nz > 12 ? { name: e.toString('utf8', 12, nz).slice(0, 80) } : {}) });
    } else if (type === 'LOOP' && e.length >= 21) {
      const nz = e.indexOf(0, 20);
      out.push({ ms: e.readUInt32BE(2), end: e.readUInt32BE(6), kind: 'loop', n: e[1], ...(nz > 20 ? { name: e.toString('utf8', 20, nz).slice(0, 80) } : {}) });
    }
  }
  return out.sort((a, b) => a.ms - b.ms);
}
/** "Serato Overview": 01 05, then 16-byte blocks (frequency bins) → one column each (the loudest bin), as 3 equal bands. */
export function parseSeratoOverview(b: Buffer): { cols: number; data: Uint8Array } | null {
  if (b.length < 2 + 16) return null;
  const n = Math.floor((b.length - 2) / 16), d = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) { let m = 0; for (let k = 0; k < 16; k++) m = Math.max(m, b[2 + i * 16 + k]); const v = Math.min(255, m * 8); d[i * 3] = v; d[i * 3 + 1] = v; d[i * 3 + 2] = v; }
  return { cols: n, data: d };
}

// ---------------------------------------------------------------------------------------------------- reading files
const syncsafe = (b: Buffer, o: number) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
/** The GEOB frames of an ID3v2.3 / 2.4 tag (description → data). */
export function id3Geobs(tag: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (tag.length < 10 || tag.toString('latin1', 0, 3) !== 'ID3') return out;
  const ver = tag[3], size = syncsafe(tag, 6);
  let o = 10;
  if (tag[5] & 0x40) o += ver === 4 ? syncsafe(tag, 10) : tag.readUInt32BE(10) + 4;   // extended header
  const end = Math.min(tag.length, 10 + size);
  while (o + 10 <= end) {
    const id = tag.toString('latin1', o, o + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const fsz = ver === 4 ? syncsafe(tag, o + 4) : tag.readUInt32BE(o + 4);
    if (fsz <= 0 || o + 10 + fsz > end) break;
    if (id === 'GEOB') {
      const f = tag.subarray(o + 10, o + 10 + fsz);
      const enc = f[0];
      const term = (from: number, wide: boolean) => { if (!wide) { const z = f.indexOf(0, from); return z < 0 ? -1 : z; } for (let i = from; i + 1 < f.length; i += 2) if (f[i] === 0 && f[i + 1] === 0) return i; return -1; };
      const wide = enc === 1 || enc === 2;
      const m = term(1, false); if (m < 0) { o += 10 + fsz; continue; }
      const fn = term(m + 1, wide); if (fn < 0) { o += 10 + fsz; continue; }
      const dStart = fn + (wide ? 2 : 1);
      const de = term(dStart, wide); if (de < 0) { o += 10 + fsz; continue; }
      const desc = wide ? f.subarray(dStart, de).toString('utf16le').replace(/^﻿/, '') : f.toString('latin1', dStart, de);
      out.set(desc, Buffer.from(f.subarray(de + (wide ? 2 : 1))));
    }
    o += 10 + fsz;
  }
  return out;
}
/** FLAC Vorbis comments SERATO_* (base64 of "application/octet-stream\0\0<name>\0<payload>"). */
export function flacSerato(head: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (head.toString('latin1', 0, 4) !== 'fLaC') return out;
  let o = 4;
  for (;;) {
    if (o + 4 > head.length) break;
    const last = head[o] & 0x80, type = head[o] & 0x7f, len = head.readUIntBE(o + 1, 3);
    const body = head.subarray(o + 4, o + 4 + len);
    if (type === 4 && body.length === len) {
      let p = 0; const vlen = body.readUInt32LE(p); p += 4 + vlen; const n = body.readUInt32LE(p); p += 4;
      for (let i = 0; i < n && p + 4 <= body.length; i++) {
        const l = body.readUInt32LE(p); const s = body.toString('utf8', p + 4, p + 4 + l); p += 4 + l;
        const m = /^SERATO_([A-Z0-9_]+)=(.*)$/s.exec(s);
        if (!m) continue;
        const d = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
        // skip the MIME type, an empty file name and the description
        const a = d.indexOf(0), b = d.indexOf(0, a + 1), c = d.indexOf(0, b + 1);
        if (a < 0 || b < 0 || c < 0) continue;
        out.set(d.toString('latin1', b + 1, c), d.subarray(c + 1));
      }
    }
    o += 4 + len;
    if (last) break;
  }
  return out;
}
/** The first `max` bytes of a file (tags live at the front). */
function head(file: string, max = 1 << 20): Buffer {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(max); const n = fs.readSync(fd, b, 0, max, 0); return b.subarray(0, n); } finally { fs.closeSync(fd); }
}
/** One music file → its Serato analysis (null = no Serato tags). */
export function seratoFromFile(file: string): ImportedTrack | null {
  let h: Buffer;
  try { h = head(file); } catch { return null; }
  let tags = new Map<string, Buffer>();
  if (h.toString('latin1', 0, 3) === 'ID3') {
    const size = syncsafe(h, 6) + 10;
    tags = id3Geobs(size > h.length ? head(file, Math.min(size, 16 << 20)) : h);
  } else if (h.toString('latin1', 0, 4) === 'fLaC') tags = flacSerato(h);
  else if (h.toString('latin1', 0, 4) === 'FORM') {
    // AIFF: the ID3 chunk
    for (let o = 12; o + 8 <= h.length;) { const id = h.toString('latin1', o, o + 4), len = h.readUInt32BE(o + 4); if (id === 'ID3 ' || id === 'id3 ') { tags = id3Geobs(h.subarray(o + 8, o + 8 + len)); break; } o += 8 + len + (len & 1); }
  }
  const bg = tags.get('Serato BeatGrid') ?? tags.get('BEATGRID'), m2 = tags.get('Serato Markers2') ?? tags.get('MARKERS_V2'), ov = tags.get('Serato Overview') ?? tags.get('OVERVIEW');
  if (!bg && !m2 && !ov) return null;
  const t: ImportedTrack = { src: 'serato', path: file, base: baseName(file), part: { srcs: ['serato'] } };
  const g = bg ? parseSeratoBeatGrid(bg) : null;
  if (g) { t.part.grid = g; t.part.bpm = g.anchors[g.anchors.length - 1].bpm; }
  const c = m2 ? parseSeratoMarkers2(m2) : [];
  if (c.length) t.part.cues = c;
  const o = ov ? parseSeratoOverview(ov) : null;
  if (o) t.part.bands = { cols: o.cols, b64: bytesToB64(o.data), src: 'serato' };
  return t;
}

/** `_Serato_\database V2` → the file paths it lists ("pfil", UTF-16BE, relative to the drive's root). */
export function seratoDatabaseFiles(db: Buffer, driveRoot: string): string[] {
  const out: string[] = [];
  const walk = (b: Buffer) => {
    let o = 0;
    while (o + 8 <= b.length) {
      const id = b.toString('latin1', o, o + 4), len = b.readUInt32BE(o + 4);
      const v = b.subarray(o + 8, o + 8 + len);
      if (id === 'otrk') walk(v);
      else if (id === 'pfil') {
        let s = ''; for (let i = 0; i + 1 < v.length; i += 2) s += String.fromCharCode(v.readUInt16BE(i));
        // relative to the drive the database is on: a drive letter / UNC path or a ".." step would leave it (dropped)
        const rel = s.replace(/^[\\/]+/, '');
        if (rel && !/^[A-Za-z]:/.test(rel) && !/^[\\/]{2}/.test(s) && !rel.split(/[\\/]+/).includes('..') && !rel.includes('\0')) out.push(path.join(driveRoot, rel));
      }
      o += 8 + len;
    }
  };
  walk(db);
  return out;
}

const AUDIO = /\.(mp3|aiff?|flac)$/i;
/** A `_Serato_` folder (its database V2 lists the files), or a music folder (every MP3 / AIFF / FLAC inside). */
export function importSerato(where: string, o: { maxFiles?: number; deadlineMs?: number } = {}): ImportResult {
  const max = o.maxFiles ?? 20000, until = Date.now() + (o.deadlineMs ?? 120000);
  let files: string[] = [];
  const st = (() => { try { return fs.statSync(where); } catch { return null; } })();
  if (!st) return { tracks: [], says: 'That folder isn’t there.', warnings: [] };
  const dbFile = st.isFile() ? where : [path.join(where, 'database V2'), path.join(where, '_Serato_', 'database V2')].find((p) => fs.existsSync(p));
  if (dbFile && fs.existsSync(dbFile)) {
    const root = path.parse(path.resolve(dbFile)).root;
    files = seratoDatabaseFiles(fs.readFileSync(dbFile), root).filter((f) => AUDIO.test(f));
  } else {
    const walk = (d: string, depth: number) => {
      if (depth > 8 || files.length >= max) return;
      let ents: fs.Dirent[]; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory() && !e.name.startsWith('.')) walk(p, depth + 1); else if (AUDIO.test(e.name)) files.push(p); }
    };
    walk(where, 0);
  }
  const tracks: ImportedTrack[] = [];
  let missing = 0;
  for (const f of files.slice(0, max)) {
    if (Date.now() > until) break;
    if (!fs.existsSync(f)) { missing++; continue; }
    const t = seratoFromFile(f);
    if (t) tracks.push(t);
  }
  const g = tracks.filter((t) => t.part.grid).length;
  return { tracks, says: !files.length ? 'No music files with Serato analysis found there.' : `${tracks.length} track${tracks.length === 1 ? '' : 's'} with Serato analysis (${g} with a beat grid)${missing ? `; ${missing} listed file${missing === 1 ? '' : 's'} not on this PC` : ''}.`, warnings: [] };
}
