// Live captions: the pieces both the server (recognition policy, SRT / VTT sidecars) and the OBS overlay page share.
// Pure TypeScript, no I/O, no clocks (every function takes the time it needs), so tools/captions_unit.ts can run the
// whole thing on a mock recogniser with a virtual clock.
//
// Times are SECONDS on the session's audio clock (sample count / 16 000, 0 = the first sample fed). A "word" is what
// the recogniser reports (text + start + end); a "cue" is a few words shown together (one SRT / VTT entry).

/** `p` = the recogniser's own confidence in the word (0..1), when it reports one (faster-whisper does): used only to commit
 *  a word one run early on a slow machine. */
export interface CapWord { w: string; t0: number; t1: number; p?: number }
export interface CapCue { i: number; t0: number; t1: number; text: string }

/** What the overlay page receives on /ws/captions (JSON text frames). */
export type CaptionMsg =
  /** `text` = the words said in the last few seconds only (never older ones: a new overlay must not re-show a sentence from minutes
   *  ago); `ageMs` = how long ago the newest of them was committed (the overlay times its idle clear from that). */
  | { type: 'hello'; seq: number; on: boolean; text: string; tentative: boolean; ageMs?: number }
  /** `words` = newly COMMITTED words (final: never rewritten); `tentative` = the uncommitted tail of the newest
   *  hypothesis (may change; the overlay shows it only when the user switched "show unconfirmed words" on). */
  | { type: 'cap'; seq: number; words: CapWord[]; tentative: string }
  | { type: 'clear'; seq: number }
  | { type: 'state'; seq: number; on: boolean; state: string; detail: string };

// ---------------------------------------------------------------- word hygiene
const PUNCT_EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
/** The comparison key of a word: lower case, edge punctuation off ("Hello," and "hello" agree). */
export const wordKey = (w: string) => w.toLowerCase().replace(PUNCT_EDGE, '');
/** A word that closes a sentence. */
export const endsSentence = (w: string) => /[.!?…]["')\]]?$/.test(w.trim());

/** Join words into text: Whisper words carry their own leading space, ours do not. */
export const joinWords = (ws: readonly { w: string }[]) => ws.map((x) => x.w.trim()).filter(Boolean).join(' ');

// ---------------------------------------------------------------- SRT / VTT
const pad = (n: number, d: number) => String(Math.floor(n)).padStart(d, '0');
function parts(sec: number) {
  const ms = Math.max(0, Math.round(sec * 1000));
  return { h: Math.floor(ms / 3600000), m: Math.floor(ms / 60000) % 60, s: Math.floor(ms / 1000) % 60, ms: ms % 1000 };
}
export function srtTime(sec: number) { const p = parts(sec); return `${pad(p.h, 2)}:${pad(p.m, 2)}:${pad(p.s, 2)},${pad(p.ms, 3)}`; }
export function vttTime(sec: number) { const p = parts(sec); return `${pad(p.h, 2)}:${pad(p.m, 2)}:${pad(p.s, 2)}.${pad(p.ms, 3)}`; }
/** Caption text goes into a file players parse: no blank lines, no "-->", no markup. */
export const cueText = (t: string) => t.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/-->/g, '->').replace(/[<>&]/g, (c) => (c === '<' ? '‹' : c === '>' ? '›' : '＆')).replace(/\s+/g, ' ').trim();

export function srtCue(c: CapCue, offsetSec = 0): string { return `${c.i}\n${srtTime(c.t0 + offsetSec)} --> ${srtTime(c.t1 + offsetSec)}\n${cueText(c.text)}\n\n`; }
export function vttCue(c: CapCue, offsetSec = 0): string { return `${vttTime(c.t0 + offsetSec)} --> ${vttTime(c.t1 + offsetSec)}\n${cueText(c.text)}\n\n`; }
export const VTT_HEADER = 'WEBVTT\n\n';
export const cuesToSrt = (cues: readonly CapCue[], offsetSec = 0) => cues.map((c) => srtCue(c, offsetSec)).join('');
export const cuesToVtt = (cues: readonly CapCue[], offsetSec = 0) => VTT_HEADER + cues.map((c) => vttCue(c, offsetSec)).join('');

// ---------------------------------------------------------------- cues
export interface CueRules {
  /** Close the cue when the pause before the next word is longer than this (s). */
  gapSec: number;
  /** …or when it would run longer than this (s). */
  maxSec: number;
  /** …or when it would hold more characters than this (broadcast captions: 2 lines of ~32-42). */
  maxChars: number;
  /** A sentence end closes the cue once it holds at least this many characters. */
  sentenceMin: number;
  /** Shortest a cue is shown (s), so a one-word cue is still readable in a player. */
  minShowSec: number;
}
export const DEFAULT_CUE_RULES: CueRules = { gapSec: 0.9, maxSec: 6, maxChars: 84, sentenceMin: 14, minShowSec: 0.7 };

/** Groups committed words into cues, in order. Feed words with push(); finished cues come back from push() and
 *  flush(). Committed words never change, so a closed cue never changes either. */
export class CueBuilder {
  private cur: CapWord[] = [];
  private n = 0;
  constructor(private rules: CueRules = DEFAULT_CUE_RULES, private firstIndex = 1) { this.n = firstIndex - 1; }

  push(words: readonly CapWord[]): CapCue[] {
    const out: CapCue[] = [];
    for (const w of words) {
      if (this.cur.length) {
        const last = this.cur[this.cur.length - 1];
        const text = joinWords(this.cur);
        if (w.t0 - last.t1 > this.rules.gapSec || w.t1 - this.cur[0].t0 > this.rules.maxSec || text.length + 1 + w.w.trim().length > this.rules.maxChars) out.push(this.close());
      }
      this.cur.push(w);
      if (endsSentence(w.w) && joinWords(this.cur).length >= this.rules.sentenceMin) out.push(this.close());
    }
    return out;
  }

  /** The words of the cue that is still open. */
  get open(): readonly CapWord[] { return this.cur; }

  flush(): CapCue[] { return this.cur.length ? [this.close()] : []; }

  private close(): CapCue {
    const ws = this.cur; this.cur = [];
    const t0 = ws[0].t0;
    const t1 = Math.max(ws[ws.length - 1].t1, t0 + this.rules.minShowSec);
    return { i: ++this.n, t0, t1, text: joinWords(ws) };
  }
}

// ---------------------------------------------------------------- the overlay's text model
export interface ViewOpts { maxChars: number; maxLines: number; idleMs: number; showTentative: boolean }
export const DEFAULT_VIEW: ViewOpts = { maxChars: 38, maxLines: 2, idleMs: 4500, showTentative: false };

/** What the overlay page shows: the last `maxLines` lines of COMMITTED text (word-wrapped), an optional dim tentative
 *  tail, cleared after `idleMs` without news. Lines are built incrementally and a finished line is never re-flowed, so
 *  a word already on screen never moves or changes: committed words are only appended, older lines only scroll up.
 *  That is the "no flicker" promise of the committed text. */
export class CaptionView {
  private done: string[] = [];
  private cur = '';
  private tent = '';
  private lastAt = 0;
  constructor(public opts: ViewOpts = DEFAULT_VIEW) {}

  push(words: readonly { w: string }[], nowMs: number) {
    for (const x of words) {
      const w = x.w.trim();
      if (!w) continue;
      if (this.cur && this.cur.length + 1 + w.length > this.opts.maxChars) { this.done.push(this.cur); this.cur = w; } else this.cur = this.cur ? `${this.cur} ${w}` : w;
    }
    if (this.done.length > 8) this.done.splice(0, this.done.length - 8);
    this.lastAt = nowMs;
  }
  setTentative(text: string, nowMs: number) { this.tent = text; if (text) this.lastAt = nowMs; }
  clear() { this.done = []; this.cur = ''; this.tent = ''; }

  /** The wrapped committed lines (the last `maxLines`), the tentative tail (or ''), and whether anything shows. */
  render(nowMs: number): { lines: string[]; tentative: string; visible: boolean } {
    if (nowMs - this.lastAt > this.opts.idleMs) { this.clear(); return { lines: [], tentative: '', visible: false }; }
    const all = this.cur ? [...this.done, this.cur] : [...this.done];
    const shown = all.slice(-this.opts.maxLines);
    const tentative = this.opts.showTentative ? this.tent : '';
    return { lines: shown, tentative, visible: shown.length > 0 || !!tentative };
  }
}
