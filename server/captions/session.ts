// A live-caption session: 16 kHz mono audio goes in (from the voice front end, with its per-10-ms "performer is
// speaking" gate flag), committed words and finished cues come out. The recogniser (faster-whisper in a sidecar, or a
// mock in tests) is re-run on a growing window of audio; server/captions/agreement.ts decides which words are final.
//
// Everything runs on the AUDIO clock (samples fed / 16 000), never the wall clock, so a test can drive a whole minute of
// speech in milliseconds and measure the lag exactly (tools/captions_unit.ts). In production a timer calls step()
// every ~100 ms; step() does nothing unless a run is due and none is in flight.
//
// What it decides (and why):
//   * nothing is recognised without speech: a window needs `minSpeechSec` of gate-open audio, and a word the
//     recogniser puts where the gate was shut (Whisper's "Thank you." in silence) is dropped;
//   * a run starts at most every `stepSec` of audio, and only when there is audio the last run didn't see;
//   * the speaker pausing for `endSilenceSec` ends the utterance: one last run if it hasn't seen everything, then the
//     tail is final (finish) and the audio buffer is emptied;
//   * the window is trimmed at the end of a committed sentence (once it holds more than `sentenceTrimSec`) or, failing
//     that, at the last committed word when it is longer than `maxWindowSec`, so every run costs about the same;
//   * the last ~200 characters of committed text are the recogniser's prompt (names, spelling, casing carry over).
import { CueBuilder, endsSentence, joinWords, type CapCue, type CapWord, type CueRules } from '../../shared/captions.ts';
import { LocalAgreement } from './agreement.ts';

export const SR = 16000;
/** The voice front end's gate flag granularity (10 ms). */
export const CHUNK = 160;

export interface RecogniseRequest {
  /** 16 kHz mono float32, the whole current window. */
  audio: Float32Array;
  /** Audio-clock time (s) of audio[0]. */
  startSec: number;
  /** Recently committed text (context for names / casing). */
  prompt: string;
  lang: string;
}
export interface RecogniseResult {
  /** Word times RELATIVE to the window start (seconds), as the sidecar reports them. */
  words: CapWord[];
  /** How long the run took (ms), measured by the recogniser. */
  ms: number;
}
export interface Recogniser { transcribe(r: RecogniseRequest): Promise<RecogniseResult> }

export interface SessionOpts {
  /** Least audio between two runs. The pace adapts: 1.3 x the last run's time (a slow CPU runs less often, never behind). */
  stepSec: number;
  minStepSec: number;
  minSpeechSec: number;
  maxWindowSec: number;
  sentenceTrimSec: number;
  endSilenceSec: number;
  /** The last run of an utterance must have heard this much audio AFTER the last speech: a model is unsure of a final
   *  word until it has heard what follows (even if that is silence). */
  tailSec: number;
  maxHoldSec: number;
  promptChars: number;
  lang: string;
  /** A word needs this share of its time (plus a 150 ms margin) on gate-open audio to be kept. */
  speechShare: number;
  /** A run slower than this (ms, smoothed) makes the policy switch to its slow-machine settings (see `slow`). */
  slowMs: number;
  /** Slow machine: commit a word after one run when the recogniser's confidence is at least this and it has heard `earlySettleSec` after it. */
  earlyP: number;
  earlySettleSec: number;
  cue?: Partial<CueRules>;
}
export const DEFAULT_SESSION: SessionOpts = {
  stepSec: 0.4, minStepSec: 0.3, minSpeechSec: 0.2, maxWindowSec: 14, sentenceTrimSec: 6, endSilenceSec: 0.7, tailSec: 0.55, maxHoldSec: 1.1, promptChars: 200, lang: 'en', speechShare: 0.3, slowMs: 350, earlyP: 0.85, earlySettleSec: 0.4,
};

export interface SessionSink {
  /** Newly final words. `at` = the audio-clock time they became final (run start + run time): at - word.t1 is the lag. */
  commit?(words: CapWord[], at: number): void;
  /** The uncommitted tail of the newest run ('' = nothing). */
  tentative?(text: string): void;
  cue?(cue: CapCue): void;
  /** The utterance ended (pause): the caption can clear after its idle time. */
  endpoint?(at: number): void;
  error?(e: unknown): void;
}

export interface SessionStats { runs: number; words: number; lagMs: number[]; runMs: number[]; dropped: number }

export class CaptionSession {
  readonly agreement: LocalAgreement;
  readonly cues: CueBuilder;
  readonly stats: SessionStats = { runs: 0, words: 0, lagMs: [], runMs: [], dropped: 0 };
  private o: SessionOpts;
  private buf: Float32Array;
  private flags: Uint8Array;            // one per CHUNK samples of buf
  private startSample = 0;              // absolute sample index of buf[0]
  private samples = 0;                  // absolute samples fed
  private lastSpeechAt = -1;            // audio-clock end of the newest gate-open chunk
  private decodedTo = 0;                // audio-clock end of the window the last run saw
  private lastRunAt = -1e9;
  private pace: number;                 // current least audio between runs
  private avgMs = 0;                    // smoothed run time (ms)
  private busy = false;
  private done = false;
  private carry = new Float32Array(0);  // samples fed past the last whole chunk

  constructor(private rec: Recogniser, private sink: SessionSink = {}, opts: Partial<SessionOpts> = {}) {
    this.o = { ...DEFAULT_SESSION, ...opts };
    this.agreement = new LocalAgreement(this.o.maxHoldSec);
    this.pace = this.o.stepSec;
    this.cues = new CueBuilder({ gapSec: 0.9, maxSec: 6, maxChars: 84, sentenceMin: 14, minShowSec: 0.7, ...this.o.cue });
    const cap = Math.ceil((this.o.maxWindowSec + 30) * SR);
    this.buf = new Float32Array(cap);
    this.flags = new Uint8Array(Math.ceil(cap / CHUNK));
  }

  /** Audio-clock seconds fed so far. */
  get now() { return this.samples / SR; }
  get running() { return this.busy; }
  /** The recogniser is slow on this machine (smoothed run time over `slowMs`). Then the policy trades a little accuracy
   *  for lag, because a run that takes 0.6 s makes the normal "two runs must agree" rule cost 1.5 s on its own:
   *   - runs go back to back (pace 0.9 x run time instead of 1.3 x),
   *   - a word the model is >= `earlyP` sure of is committed after ONE run once `earlySettleSec` of audio follows it,
   *   - the window is cut after every commit (just the uncommitted audio is re-run), so a run costs less. */
  get slow() { return this.avgMs > this.o.slowMs; }
  get text() { return joinWords(this.agreement.words); }

  /** Append audio. `gate` has one byte per 160 samples (1 = the performer is speaking); omitted = all speech. A partial
   *  chunk at the end is carried to the next call (its gate flag is the next call's first). */
  feed(pcm: Float32Array, gate?: Uint8Array) {
    if (this.done || !pcm.length) return;
    let x = pcm, g = gate;
    if (this.carry.length) {
      x = new Float32Array(this.carry.length + pcm.length); x.set(this.carry); x.set(pcm, this.carry.length);
      if (gate) { g = new Uint8Array(gate.length + 1); g[0] = gate[0] ?? 0; g.set(gate, 1); }
    }
    const whole = Math.floor(x.length / CHUNK) * CHUNK;
    this.carry = x.slice(whole);
    if (!whole) return;
    x = x.subarray(0, whole);
    let used = this.samples - this.startSample;
    if (used + whole > this.buf.length) {            // never in practice (windows are trimmed): drop the oldest
      this.trimToSample(this.samples + whole - Math.floor(this.buf.length * 0.7));
      used = this.samples - this.startSample;
    }
    this.buf.set(x, used);
    const c0 = used / CHUNK;
    for (let k = 0; k < whole / CHUNK; k++) {
      const v = g ? (g[k] ? 1 : 0) : 1;
      this.flags[c0 + k] = v;
      if (v) this.lastSpeechAt = (this.samples + (k + 1) * CHUNK) / SR;
    }
    this.samples += whole;
  }

  /** Run one recogniser pass if one is due. Resolves true when a run happened. Never throws (errors go to the sink). */
  async step(): Promise<boolean> {
    if (this.busy || this.done) return false;
    const now = this.now;
    const speech = this.speechSec();
    if (speech === 0) { this.trimToSample(Math.max(this.startSample, this.samples - Math.round(0.5 * SR))); return false; }
    if (speech < this.o.minSpeechSec && now - this.lastSpeechAt < this.o.endSilenceSec) return false;
    const sinceSpeech = now - this.lastSpeechAt;
    const sawAll = this.decodedTo >= this.lastSpeechAt + this.o.tailSec - 0.02;
    try {
      if (sinceSpeech >= this.o.endSilenceSec) {
        // the speaker paused: finish the utterance
        if (!sawAll && speech >= this.o.minSpeechSec) { await this.run(); return true; }
        this.endUtterance(now);
        return false;
      }
      if (now - this.lastRunAt < this.pace || this.decodedTo >= now - 0.05) return false;
      await this.run();
      return true;
    } catch (e) { this.busy = false; this.sink.error?.(e); return false; }
  }

  /** Stop: the final run if there is unseen speech, then everything pending is final and the last cue is flushed. */
  async end(): Promise<void> {
    if (this.done) return;
    while (this.busy) await new Promise((r) => setTimeout(r, 5));
    try {
      if (this.speechSec() >= this.o.minSpeechSec && this.decodedTo < Math.min(this.now, this.lastSpeechAt + this.o.tailSec) - 0.02) await this.run();
    } catch (e) { this.sink.error?.(e); }
    this.endUtterance(this.now);
    this.done = true;
  }

  // ------------------------------------------------------------------------------------------------ internals
  private async run() {
    this.busy = true;
    const start = this.startSample, end = this.samples;
    const covered = end / SR;
    this.lastRunAt = covered;
    const audio = this.buf.slice(0, end - start);
    const flags = this.flags.slice(0, Math.ceil((end - start) / CHUNK));
    const t0 = start / SR;
    const prompt = this.text.slice(-this.o.promptChars);
    let res: RecogniseResult;
    try { res = await this.rec.transcribe({ audio, startSec: t0, prompt, lang: this.o.lang }); } finally { this.busy = false; }
    this.decodedTo = covered;
    this.stats.runs++;
    this.stats.runMs.push(res.ms);
    this.avgMs = this.avgMs ? 0.5 * this.avgMs + 0.5 * res.ms : res.ms;
    // a run that takes 0.8 s cannot show a settled word before ~1.3 s: the lag bound must not fire before the word could settle
    this.agreement.maxHoldSec = Math.max(this.o.maxHoldSec, this.slow ? 0.5 + 1.6 * this.avgMs / 1000 : 0);
    this.pace = Math.min(1.5, Math.max(this.o.minStepSec, (this.slow ? 0.9 : 1.3) * res.ms / 1000));
    const at = covered + res.ms / 1000;
    const words = res.words.map((w) => ({ w: w.w, t0: w.t0 + t0, t1: w.t1 + t0, ...(w.p !== undefined ? { p: w.p } : {}) })).filter((w) => this.onSpeech(w, flags, t0));
    this.stats.dropped += res.words.length - words.length;
    const r = this.agreement.insert(words, at, { windowStart: t0, early: this.slow ? { minP: this.o.earlyP, settleSec: this.o.earlySettleSec, coveredEnd: covered } : undefined });
    this.emit(r.committed, at);
    this.sink.tentative?.(joinWords(r.tentative));
    this.afterCommit(r.committed, covered, r.unconfirmed);
  }

  private onSpeech(w: CapWord, flags: Uint8Array, t0: number) {
    const a = Math.max(0, Math.floor((w.t0 - 0.15 - t0) * SR / CHUNK)), b = Math.min(flags.length - 1, Math.ceil((w.t1 + 0.15 - t0) * SR / CHUNK));
    if (b < a) return false;
    let on = 0;
    for (let c = a; c <= b; c++) on += flags[c];
    const need = Math.max(1, Math.ceil(((w.t1 - w.t0) * SR / CHUNK) * this.o.speechShare));
    return on >= need;
  }

  private emit(words: CapWord[], at: number) {
    if (!words.length) return;
    this.stats.words += words.length;
    for (const w of words) { this.stats.lagMs.push(Math.max(0, (at - w.t1) * 1000)); }
    this.sink.commit?.(words, at);
    for (const c of this.cues.push(words)) this.sink.cue?.(c);
  }

  private afterCommit(committed: CapWord[], covered: number, unconfirmed = false) {
    const window = covered - this.startSample / SR;
    const lastEnd = this.agreement.lastCommittedEnd;
    let cut = 0;
    const slow = this.slow;
    if (window > (slow ? 2.5 : this.o.sentenceTrimSec)) {
      for (let i = committed.length - 1; i >= 0; i--) if (endsSentence(committed[i].w)) { cut = committed[i].t1; break; }
    }
    if (!cut && slow && committed.length && window > 2) cut = lastEnd;           // slow machine: keep the window to the uncommitted audio
    // a word that became final without a second run agreeing: the next run starts right behind it, so if the model hears
    // that word again ("there" for "their") it lands AT the window start, where the agreement drops it (agreement.ts fresh())
    if (unconfirmed) cut = Math.max(cut, lastEnd);
    if (!cut && window > (slow ? Math.min(7, this.o.maxWindowSec) : this.o.maxWindowSec)) cut = lastEnd;
    // 0.1 s before the committed end: a recogniser's word times are good to ~50 ms, and the next word must not be clipped
    if (cut > this.startSample / SR) this.trimToSample(Math.floor((cut - 0.1) * SR));
  }

  private endUtterance(now: number) {
    const rest = this.agreement.finish();
    this.emit(rest, now);
    for (const c of this.cues.flush()) this.sink.cue?.(c);
    this.sink.tentative?.('');
    this.sink.endpoint?.(now);
    this.trimToSample(this.samples);
    this.decodedTo = now;
  }

  private speechSec() {
    const n = Math.ceil((this.samples - this.startSample) / CHUNK);
    let on = 0;
    for (let c = 0; c < n; c++) on += this.flags[c];
    return (on * CHUNK) / SR;
  }

  /** Move the window start forward to an absolute sample index (never backwards). */
  private trimToSample(abs: number) {
    const cut = Math.min(Math.max(abs, this.startSample), this.samples) - this.startSample;
    const whole = Math.floor(cut / CHUNK) * CHUNK;        // keep chunk alignment with the flags
    if (whole <= 0) return;
    const used = this.samples - this.startSample;
    this.buf.copyWithin(0, whole, used);
    const fUsed = Math.ceil(used / CHUNK);
    this.flags.copyWithin(0, whole / CHUNK, fUsed);
    this.startSample += whole;
  }
}
