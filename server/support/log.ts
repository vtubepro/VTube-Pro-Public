// The support event log (beta.13): append-only, one JSON line per record, one file per month in saves/support/
// (the performer's own data, never sent anywhere, git-ignored). Goals, stretch goals and the subathon timer sum over it,
// so their state can always be recomputed (and an event undone) from this file.
//
//   {"t":"ev","ev":SupportEvent}                 an accepted event (as broadcast)
//   {"t":"mod","id":"...","m":"ok"|"hidden","at":ms}   a moderation decision on its message
//   {"t":"void","id":"...","why":"refund"|"removed","at":ms}   a refund / the streamer removed it (goals drop it)
//
// Crash-safe: every record is ONE write of a complete line, then fdatasync, before the event is broadcast. A torn last
// line (power cut mid-write) is skipped on read and the file is healed on the next append. Dedupe ("have we seen this
// id?") is the log itself: ids of the last 30 days are loaded at start (this month + last month's file).
import fs from 'node:fs';
import path from 'node:path';
import type { SupportEvent } from '../../shared/support.ts';

export type LogRecord =
  | { t: 'ev'; ev: SupportEvent }
  | { t: 'mod'; id: string; m: 'ok' | 'hidden'; at: number }
  | { t: 'void'; id: string; why: string; at: number };

export interface LoggedEvent extends SupportEvent {
  /** Refunded / removed: goals must not count it (kept so the studio can show it struck through). */
  voided?: string;
}

export const DEDUPE_DAYS = 30;
const DAY = 24 * 3600 * 1000;
const month = (ms: number) => new Date(ms).toISOString().slice(0, 7);

export class SupportLog {
  /** id → receivedAt (ms) for the dedupe window. */
  private seen = new Map<string, number>();
  /** The last events (folded: moderation + voids applied), newest last, for the studio feed. */
  private recent: LoggedEvent[] = [];
  private healed = new Set<string>();
  /** Ids with a void record (refund / removed) in the loaded window: one void per id. */
  private voids = new Set<string>();
  constructor(readonly dir: string, private now: () => number = Date.now, private keepRecent = 300) {
    fs.mkdirSync(dir, { recursive: true });
    const t = this.now();
    for (const f of monthsBetween(t - (DEDUPE_DAYS + 1) * DAY, t).map((m) => this.fileOf(m))) for (const rec of readLines(f)) this.fold(rec, t);
  }

  /** Is this event in the log (any month on disk)? The 30-day window is in memory; older months are scanned. */
  exists(id: string): boolean {
    if (this.seen.has(id) || this.recent.some((e) => e.id === id)) return true;
    let files: string[] = [];
    try { files = fs.readdirSync(this.dir).filter((f) => /^events-\d{4}-\d{2}\.jsonl$/.test(f)); } catch { return false; }
    return files.some((f) => readLines(path.join(this.dir, f)).some((r) => r.t === 'ev' && r.ev.id === id));
  }
  isVoided(id: string): boolean {
    if (this.voids.has(id)) return true;
    let files: string[] = [];
    try { files = fs.readdirSync(this.dir).filter((f) => /^events-\d{4}-\d{2}\.jsonl$/.test(f)); } catch { return false; }
    return files.some((f) => readLines(path.join(this.dir, f)).some((r) => r.t === 'void' && r.id === id));
  }

  fileOf(m: string) { return path.join(this.dir, `events-${m}.jsonl`); }

  has(id: string): boolean {
    const at = this.seen.get(id);
    if (at === undefined) return false;
    if (this.now() - at > DEDUPE_DAYS * DAY) { this.seen.delete(id); return false; }
    return true;
  }

  /** Append one record durably (throws when the disk refuses: the caller then does NOT broadcast the event). */
  append(rec: LogRecord) {
    const at = rec.t === 'ev' ? Date.parse(rec.ev.receivedAt) || this.now() : rec.at;
    const file = this.fileOf(month(at));
    this.heal(file);
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeSync(fd, JSON.stringify(rec) + '\n');
      try { fs.fdatasyncSync(fd); } catch { /* some filesystems */ }
    } finally { fs.closeSync(fd); }
    this.fold(rec, this.now());
  }

  /** A file whose last line was torn by a crash gets a newline first, so the next record starts clean. */
  private heal(file: string) {
    if (this.healed.has(file)) return;
    this.healed.add(file);
    try {
      const st = fs.statSync(file);
      if (!st.size) return;
      const fd = fs.openSync(file, 'r+');
      try {
        const b = Buffer.alloc(1);
        fs.readSync(fd, b, 0, 1, st.size - 1);
        if (b[0] !== 0x0a) fs.writeSync(fd, '\n', st.size);
      } finally { fs.closeSync(fd); }
    } catch { /* new file */ }
  }

  private fold(rec: LogRecord, now: number) {
    if (rec.t === 'ev') {
      const at = Date.parse(rec.ev.receivedAt) || now;
      if (now - at <= DEDUPE_DAYS * DAY) this.seen.set(rec.ev.id, at);
      const i = this.recent.findIndex((e) => e.id === rec.ev.id);
      if (i >= 0) this.recent[i] = { ...rec.ev }; else this.recent.push({ ...rec.ev });
      if (this.recent.length > this.keepRecent) this.recent.splice(0, this.recent.length - this.keepRecent);
    } else if (rec.t === 'mod') {
      const e = this.recent.find((x) => x.id === rec.id);
      if (e?.message) e.message = { ...e.message, moderated: rec.m };
    } else if (rec.t === 'void') {
      this.voids.add(rec.id);
      const e = this.recent.find((x) => x.id === rec.id);
      if (e) e.voided = rec.why;
    }
  }

  latest(n = 100): LoggedEvent[] { return this.recent.slice(-n).map((e) => ({ ...e })); }
  get(id: string): LoggedEvent | null { const e = this.recent.find((x) => x.id === id); return e ? { ...e } : null; }

  /** Every event since `sinceMs` (all months on disk), moderation + voids applied: what goals sum over. */
  all(sinceMs = 0): LoggedEvent[] {
    let files: string[] = [];
    try { files = fs.readdirSync(this.dir).filter((f) => /^events-\d{4}-\d{2}\.jsonl$/.test(f)).sort(); } catch { return []; }
    const keep = month(sinceMs || 0);
    const byId = new Map<string, LoggedEvent>();
    for (const f of files) {
      if (sinceMs && f.slice(7, 14) < keep) continue;
      for (const rec of readLines(path.join(this.dir, f))) {
        if (rec.t === 'ev') { if (!byId.has(rec.ev.id)) byId.set(rec.ev.id, { ...rec.ev }); }
        else if (rec.t === 'mod') { const e = byId.get(rec.id); if (e?.message) e.message = { ...e.message, moderated: rec.m }; }
        else if (rec.t === 'void') { const e = byId.get(rec.id); if (e) e.voided = rec.why; }
      }
    }
    return [...byId.values()].filter((e) => !sinceMs || (Date.parse(e.receivedAt) || 0) >= sinceMs).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }

  /** The newest `occurredAt` of a source (offline catch-up starts from there, minus a margin). */
  lastOf(source: string): string {
    let best = '';
    for (const e of this.recent) if (e.source === source && !e.test && e.occurredAt > best) best = e.occurredAt;
    return best;
  }
}

/** Every month ("YYYY-MM") from `fromMs` to `toMs` inclusive (the dedupe window can span three files). */
export function monthsBetween(fromMs: number, toMs: number): string[] {
  const out: string[] = [];
  const d = new Date(fromMs); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
  while (d.getTime() <= toMs) { out.push(d.toISOString().slice(0, 7)); d.setUTCMonth(d.getUTCMonth() + 1); }
  return out;
}

/** Parse a log file, skipping a torn / foreign line instead of failing. */
export function readLines(file: string): LogRecord[] {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out: LogRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as LogRecord;
      if (r && (r.t === 'ev' ? r.ev && typeof r.ev.id === 'string' : (r.t === 'mod' || r.t === 'void') && typeof r.id === 'string')) out.push(r);
    } catch { /* torn line */ }
  }
  return out;
}
