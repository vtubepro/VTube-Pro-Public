// SRT + VTT sidecar files for a caption session (<data>/cache/captions/captions-YYYYMMDD-HHMMSS.srt / .vtt): one cue is
// appended the moment it is final (committed words never change, so a finished cue never changes), so the file is
// complete up to the last sentence even if the helper is closed mid-stream. Times are seconds since the pair was
// started (start of the session, or "Mark a recording start": rebase()), which is what a recording started at the same
// moment needs; `offsetSec` shifts both files if the recording began earlier / later.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { VTT_HEADER, srtCue, vttCue, type CapCue } from '../../shared/captions.ts';

export const FILE_NAME = /^captions-\d{8}-\d{6}(?:-\d+)?\.(srt|vtt)$/;
const KEEP_PAIRS = 40;

export interface CaptionFile { name: string; bytes: number; modified: number }

export class CaptionFiles {
  private base = 0;          // session-clock seconds of this pair's time zero
  private n = 0;             // cues in this pair
  private stem = '';
  private q: Promise<void> = Promise.resolve();
  offsetSec = 0;

  constructor(public dir: string) {}

  get current(): { srt: string; vtt: string } | null { return this.stem ? { srt: `${this.stem}.srt`, vtt: `${this.stem}.vtt` } : null; }

  /** Start a new pair; its time zero is `clockSec` on the session clock. */
  start(clockSec: number, when = new Date()) {
    fs.mkdirSync(this.dir, { recursive: true });
    const p = (x: number, d = 2) => String(x).padStart(d, '0');
    const first = `captions-${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())}-${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}`;
    let stem = first;
    for (let k = 2; fs.existsSync(path.join(this.dir, `${stem}.srt`)); k++) stem = `${first}-${k}`;
    this.stem = stem; this.base = clockSec; this.n = 0;
    fs.writeFileSync(path.join(this.dir, `${stem}.srt`), '');      // (sync, once per pair: the next start() must see the name taken)
    fs.writeFileSync(path.join(this.dir, `${stem}.vtt`), VTT_HEADER);
    this.prune();
  }

  /** Time zero moves to `clockSec` (the user pressed "recording started"): a new pair, so the old one stays valid. */
  rebase(clockSec: number) { this.start(clockSec); }

  add(cue: CapCue) {
    if (!this.stem) return;
    const t0 = cue.t0 - this.base;
    if (cue.t1 - this.base <= 0) return;                        // ended before this pair's zero
    const c: CapCue = { i: ++this.n, t0: Math.max(0, t0), t1: cue.t1 - this.base, text: cue.text };
    this.write(`${this.stem}.srt`, srtCue(c, this.offsetSec));
    this.write(`${this.stem}.vtt`, vttCue(c, this.offsetSec));
  }

  /** Resolves when everything queued is on disk (tests, shutdown). */
  flush() { return this.q; }

  private write(name: string, text: string) {
    const f = path.join(this.dir, name);
    this.q = this.q.then(() => fsp.appendFile(f, text)).catch(() => { /* best effort: a full disk must not stop the caption */ });
  }

  list(): CaptionFile[] {
    try {
      return fs.readdirSync(this.dir).filter((f) => FILE_NAME.test(f)).map((name) => { const s = fs.statSync(path.join(this.dir, name)); return { name, bytes: s.size, modified: s.mtimeMs }; }).sort((a, b) => b.modified - a.modified || b.name.localeCompare(a.name));
    } catch { return []; }
  }

  /** Absolute path of a listed file (null for anything else: no traversal). */
  resolve(name: string): string | null {
    if (!FILE_NAME.test(name)) return null;
    const f = path.join(this.dir, name);
    return fs.existsSync(f) ? f : null;
  }

  private prune() {
    const files = this.list();
    const stems = [...new Set(files.map((f) => f.name.replace(/\.(srt|vtt)$/, '')))];
    for (const s of stems.slice(KEEP_PAIRS)) for (const ext of ['srt', 'vtt']) { try { fs.rmSync(path.join(this.dir, `${s}.${ext}`), { force: true }); } catch { /* */ } }
  }
}
