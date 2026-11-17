// Serato DJ's live history: while you play, Serato writes the session's history to
// <Music>\_Serato_\History\Sessions\<n>.session (one file per session, updated as tracks load and play). VTube Pro READS
// the newest one (never writes it) to know which track is on which deck, then follows it on the track's grid / phrases
// (the position comes from listening or the controller: the history says WHICH track, not where).
// Watched only when the user imported their Serato library (it is their own library, like re-reading rekordbox's XML).
//
// Format (Serato's chunk format, documented by the community — SSL Scrobbler's notes, the MIT "What's Now Playing"
// project's field list; written from those facts, no code copied): chunks of a 4-letter tag + a 4-byte big-endian
// length; "vrsn" (a UTF-16 version string), then one "oent" per history row holding one "adat" whose fields are
// (4-byte BE field id, 4-byte BE length, data): 1 row, 2 full path, 6 title, 7 artist, 28 start time, 29 end time
// (Unix seconds), 31 deck, 45 play time, 50 played (1 byte), 53 updated at. Strings are UTF-16 big-endian.
// Pure parser + a small watcher: tools/djtrack_unit.ts (section "serato").
import fs from 'node:fs';
import path from 'node:path';

export interface SeratoRow { row?: number; path?: string; title?: string; artist?: string; start?: number; end?: number; deck?: number; played?: boolean; updated?: number }
const MAX_FILE = 16 << 20;
const u16 = (b: Buffer) => { let s = ''; for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b.readUInt16BE(i)); return s.replace(/\0+$/, ''); };
const uint = (b: Buffer) => (b.length >= 8 ? Number(b.readBigUInt64BE(0)) : b.length >= 4 ? b.readUInt32BE(0) : b.length === 2 ? b.readUInt16BE(0) : b.length === 1 ? b[0] : NaN);

/** One session file → its history rows (oldest first, as Serato wrote them). Unknown chunks / fields are skipped. */
export function parseSeratoSession(b: Buffer): SeratoRow[] {
  const rows: SeratoRow[] = [];
  if (b.length > MAX_FILE) return rows;
  const chunks = (buf: Buffer, each: (tag: string, body: Buffer) => void) => {
    for (let i = 0; i + 8 <= buf.length;) {
      const tag = buf.toString('latin1', i, i + 4), len = buf.readUInt32BE(i + 4);
      if (i + 8 + len > buf.length) break;
      each(tag, buf.subarray(i + 8, i + 8 + len));
      i += 8 + len;
    }
  };
  chunks(b, (tag, body) => {
    if (tag !== 'oent') return;
    chunks(body, (t2, adat) => {
      if (t2 !== 'adat') return;
      const r: SeratoRow = {};
      for (let i = 0; i + 8 <= adat.length;) {
        const id = adat.readUInt32BE(i), len = adat.readUInt32BE(i + 4);
        if (i + 8 + len > adat.length) break;
        const v = adat.subarray(i + 8, i + 8 + len);
        switch (id) {
          case 1: r.row = uint(v); break;
          case 2: r.path = u16(v).slice(0, 1000); break;
          case 6: r.title = u16(v).slice(0, 200); break;
          case 7: r.artist = u16(v).slice(0, 200); break;
          case 28: r.start = uint(v); break;
          case 29: r.end = uint(v); break;
          case 31: r.deck = uint(v); break;
          case 50: r.played = v.length > 0 && v[0] !== 0; break;
          case 53: r.updated = uint(v); break;
        }
        i += 8 + len;
      }
      if (r.path || r.title) rows.push(r);
    });
  });
  return rows;
}
/** What is on each deck now: per deck, the newest row (by start, else row number) that hasn't ended. */
export function seratoDecks(rows: SeratoRow[]): { deck: number; row: SeratoRow }[] {
  const by = new Map<number, SeratoRow>();
  for (const r of rows) {
    if (!r.deck || r.deck < 1 || r.deck > 8) continue;
    const cur = by.get(r.deck);
    const newer = !cur || (r.start ?? 0) > (cur.start ?? 0) || ((r.start ?? 0) === (cur.start ?? 0) && (r.row ?? 0) >= (cur.row ?? 0));
    if (newer) by.set(r.deck, r);
  }
  return [...by].filter(([, r]) => !r.end).map(([deck, row]) => ({ deck, row })).sort((a, b) => (b.row.start ?? 0) - (a.row.start ?? 0));
}
/** The newest session file under a _Serato_ folder (null = none). */
export function newestSession(seratoDir: string): string | null {
  const d = path.join(seratoDir, 'History', 'Sessions');
  let best: { f: string; m: number } | null = null;
  try { for (const f of fs.readdirSync(d)) { if (!/\.session$/i.test(f)) continue; const m = fs.statSync(path.join(d, f)).mtimeMs; if (!best || m > best.m) best = { f: path.join(d, f), m }; } } catch { return null; }
  return best?.f ?? null;
}
/** Re-reads the newest session file when it changes (size / mtime): what each deck holds. */
export class SeratoHistoryWatcher {
  private seen = '';
  decks: { deck: number; row: SeratoRow }[] = [];
  constructor(readonly seratoDir: string) {}
  /** true = something changed. */
  poll(): boolean {
    const f = newestSession(this.seratoDir);
    if (!f) return false;
    let st: fs.Stats; try { st = fs.statSync(f); } catch { return false; }
    const key = `${f}|${st.size}|${st.mtimeMs}`;
    if (key === this.seen || st.size > MAX_FILE) return false;
    this.seen = key;
    let rows: SeratoRow[] = [];
    try { rows = parseSeratoSession(fs.readFileSync(f)); } catch { return false; }
    const next = seratoDecks(rows);
    const changed = JSON.stringify(next) !== JSON.stringify(this.decks);
    this.decks = next;
    return changed;
  }
}

// ---------------------------------------------------------------------------------------------------- tests: writer
/** A synthetic session file (tests only). */
export function buildSeratoSession(rows: SeratoRow[]): Buffer {
  const chunk = (tag: string, body: Buffer) => { const h = Buffer.alloc(8); h.write(tag, 0, 'latin1'); h.writeUInt32BE(body.length, 4); return Buffer.concat([h, body]); };
  const field = (id: number, v: Buffer) => { const h = Buffer.alloc(8); h.writeUInt32BE(id, 0); h.writeUInt32BE(v.length, 4); return Buffer.concat([h, v]); };
  const s16 = (s: string) => { const b = Buffer.alloc((s.length + 1) * 2); for (let i = 0; i < s.length; i++) b.writeUInt16BE(s.charCodeAt(i), i * 2); return b; };
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };
  const parts = [chunk('vrsn', s16('1.0/Serato Scratch LIVE Review'))];
  for (const r of rows) {
    const f: Buffer[] = [];
    if (r.row !== undefined) f.push(field(1, u32(r.row)));
    if (r.path) f.push(field(2, s16(r.path)));
    if (r.title) f.push(field(6, s16(r.title)));
    if (r.artist) f.push(field(7, s16(r.artist)));
    if (r.start !== undefined) f.push(field(28, u32(r.start)));
    if (r.end !== undefined) f.push(field(29, u32(r.end)));
    if (r.deck !== undefined) f.push(field(31, u32(r.deck)));
    if (r.played !== undefined) f.push(field(50, Buffer.from([r.played ? 1 : 0])));
    parts.push(chunk('oent', chunk('adat', Buffer.concat(f))));
  }
  return Buffer.concat(parts);
}
