// Our own analysis of the tracks that lack it ("Learning your tracks: 12 / 140"): background, one track at a time,
// low priority, resumable (the queue is simply every track still marked `needs`), and NEVER while live — it waits while
// OBS streams / records, while the studio is tracking a camera, or while OBS is open and VTube Pro can't tell (the same
// signals as the release rules: server/to3d/live.ts + the obs64 process). Decoding: WAV / AIFF in the worker, the user's
// ffmpeg (killed when it stalls), or the studio page (browser decoders) for the rest. Every job has a deadline: past it
// the worker thread is terminated and the track marked failed. Decoding and DSP never run on the helper's main thread
// (no worker = no learning, said plainly). Only audio files inside the music folders the user allowed are read
// (store.ts readable). Results merge into the library (the DJ app's grid always wins).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { TrackAnalysis } from '../../../shared/trackAnalysis.ts';
import { decodeWithFfmpeg, findFfmpeg, MAX_ANALYSIS_SECONDS, NeedsDecoder, PCM_FILE } from './decode.ts';
import { modelPath, modelState } from './beatThis.ts';
import type { TrackLibrary } from './store.ts';
import { NEEDS_DECODER, type WorkIn } from './analyzeWorker.ts';

/** The analysis thread couldn't start (a broken install): learning is off, nothing is marked failed. */
export class WorkerUnavailable extends Error {}

export interface AnalyzerState {
  state: 'idle' | 'running' | 'waiting' | 'off';
  /** One plain sentence (why it waits, what it does). */
  says: string;
  done: number; total: number; current: string;
  /** Tracks only the studio page can decode (no ffmpeg on this PC). */
  pageJobs: number;
  ffmpeg: boolean;
  /** "I'm not live, learn now" is on until then (epoch ms; null = off). */
  learnNow?: number | null;
  /** How long one track takes to learn here (ms, a running average; 0 = not measured yet): the panel's "about N min left". */
  avgMs?: number;
}
export interface AnalyzerOptions {
  /** Is the user live right now? (why = a plain reason) */
  liveCheck?: () => Promise<{ live: boolean; why: string | null }>;
  dataDir: string;
  ffmpegPath?: string;
  /** Analyse every track (true) or only those without phrases (default). */
  all?: boolean;
  log?(s: string): void;
  /** One track's deadline, decoding included (ms; default 10 minutes): past it the worker is terminated. */
  jobMs?: number;
  /** How long a new worker may take to start (ms; default 60 s). */
  startMs?: number;
  /** (tests) the worker file */
  workerEntry?: string | URL;
  /** (tests) ffmpeg stall / hard limits */
  ffmpegIdleMs?: number;
  /** Is OBS streaming or recording? true / false, null = unknown (not connected through VTube Pro). Default: server/obs.ts
   *  (read-only status calls, only when OBS is connected through VTube Pro: it never dials OBS otherwise). */
  obsOnAir?: () => Promise<boolean | null>;
}
/** "I'm not live, learn now": at most this long (the studio going live ends it sooner). */
export const LEARN_NOW_MS = 2 * 3600_000;
/** OBS on air (streaming / recording): true / false, null = unknown. Never dials OBS: null when it isn't connected. */
export async function defaultObsOnAir(): Promise<boolean | null> {
  try { const { obs } = await import('../../obs.ts'); return await obs.outputActive(); } catch { return null; }
}

/** The analysis worker's file: a bundled analyze_worker.mjs next to a compiled server if there is one, else this folder's
 *  analyzeWorker.ts (tsx). */
export function analyzeWorkerEntry(here = fileURLToPath(import.meta.url), exists: (p: string) => boolean = fs.existsSync): string | URL {
  if (/\.mjs$/.test(here)) { const p = path.join(path.dirname(here), 'analyze_worker.mjs'); if (exists(p)) return p; }
  return new URL('./analyzeWorker.ts', import.meta.url);
}

/**
 * A cached, single-flight "is OBS running?" probe that FAILS CLOSED: an error or a timeout of the process query counts as
 * "running" (learning waits), never as "not running". One query at a time however many callers ask.
 */
export function makeObsProbe(query: (done: (failed: boolean, out: string, code: number) => void) => void, ttlMs = 10000): () => Promise<boolean> {
  let seen = { at: -Infinity, running: true };
  let inflight: Promise<boolean> | null = null;
  return () => {
    if (Date.now() - seen.at < ttlMs) return Promise.resolve(seen.running);
    inflight ??= new Promise<boolean>((res) => {
      query((failed, out, code) => {
        const running = failed ? true : process.platform === 'win32' ? /obs64\.exe/i.test(out) : code === 0;
        seen = { at: Date.now(), running };
        inflight = null;
        res(running);
      });
    });
    return inflight;
  };
}
const obsRunning = makeObsProbe((done) => {
  const win = process.platform === 'win32';
  execFile(win ? 'tasklist' : 'pgrep', win ? ['/FI', 'IMAGENAME eq obs64.exe', '/NH'] : ['-x', 'obs'], { encoding: 'utf8', windowsHide: true, timeout: 4000 }, (err, stdout) => {
    const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0;
    // (pgrep exits 1 when nothing matches: an answer, not a failure; anything else that errs — a timeout — fails closed)
    done(!!err && !(!win && code === 1), String(stdout ?? ''), code);
  });
});
/** The default live check: OBS streaming / recording or the studio tracking (server/to3d/live.ts), or OBS open while
 *  its state is unknown (never connected through VTube Pro). */
export async function defaultLiveCheck(): Promise<{ live: boolean; why: string | null }> {
  try {
    const { liveNow } = await import('../../to3d/live.ts');
    const r = await liveNow();
    if (r.live) return { live: true, why: r.why };
    if (r.facts.obsOutput === null && await obsRunning()) return { live: true, why: 'OBS is open (VTube Pro can’t tell whether you’re live)' };
    return { live: false, why: null };
  } catch { const o = await obsRunning().catch(() => true); return { live: o, why: o ? 'OBS is open' : null }; }
}

export class TrackAnalyzer {
  private st: AnalyzerState = { state: 'idle', says: '', done: 0, total: 0, current: '', pageJobs: 0, ffmpeg: false };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private on = false;
  private worker: Worker | null = null;
  private workerReady: Promise<Worker> | null = null;
  private workerBroken = false;
  /** Tracks waiting for the studio page's decoder. */
  readonly pageQueue = new Set<string>();
  /** When each page job was handed to a studio page. */
  private pageGiven = new Map<string, number>();
  /** Where the last analysis ran (the panel / tests: always 'worker'; nothing runs on the main thread). */
  thread: 'worker' | '' = '';
  /** Workers terminated because a job passed its deadline (tests / diagnostics). */
  terminated = 0;
  private jid = 0;
  /** "I'm not live, learn now": learning may run while the camera is tracking or OBS is open (a preview), never while
   *  OBS streams or records. Until `until`, or until OBS goes on air. `unknownOk` = the user confirmed although OBS's
   *  state can't be read. */
  learnNow: { until: number; unknownOk: boolean } | null = null;
  all: boolean;
  readonly jobMs: number;
  constructor(private lib: TrackLibrary, private o: AnalyzerOptions) { this.all = !!o.all; this.jobMs = o.jobMs ?? 10 * 60000; }

  state(): AnalyzerState & { thread: string } { return { ...this.st, pageJobs: this.pageQueue.size, thread: this.thread, learnNow: this.learnNow && this.learnNow.until > Date.now() ? this.learnNow.until : null }; }
  /**
   * The user's "I'm not live, learn now" (on) or "stop" (off). Refused while OBS streams / records; when OBS's state
   * can't be read it needs the user's confirm (`confirm`). Lasts LEARN_NOW_MS or until OBS goes on air.
   */
  async setLearnNow(on: boolean, confirm = false): Promise<{ ok: boolean; says: string; needsConfirm?: boolean; until?: number }> {
    if (!on) { this.learnNow = null; this.kick(); return { ok: true, says: 'OK: learning waits again while the studio or OBS is busy.' }; }
    const onAir = await (this.o.obsOnAir ?? defaultObsOnAir)().catch(() => null);
    if (onAir === true) { this.learnNow = null; return { ok: false, says: 'OBS is streaming or recording right now, so learning waits until you stop.' }; }
    if (onAir === null && !confirm) return { ok: false, needsConfirm: true, says: 'VTube Pro can’t see whether OBS is streaming or recording. Learn now only if you’re not live.' };
    this.learnNow = { until: Date.now() + LEARN_NOW_MS, unknownOk: onAir === null };
    if (!this.on) this.start();
    this.kick();
    return { ok: true, until: this.learnNow.until, says: 'Learning your tracks now (slowly, so the studio stays smooth). It stops by itself when OBS starts streaming or recording, or in 2 hours.' };
  }
  /** Live or not, with the user's "learn now" applied: it overrides the camera / OBS-open waits, never OBS on air. */
  private async liveState(): Promise<{ live: boolean; why: string | null; override?: boolean }> {
    const base = await (this.o.liveCheck ?? defaultLiveCheck)().catch(() => ({ live: true, why: 'can’t tell whether you’re live' }));
    const L = this.learnNow;
    if (!base.live || !L) return base;
    if (Date.now() > L.until) { this.learnNow = null; return base; }
    const onAir = await (this.o.obsOnAir ?? defaultObsOnAir)().catch(() => null);
    if (onAir === true) { this.learnNow = null; return { live: true, why: 'OBS is streaming or recording' }; }
    // (OBS's state was known off air when the user pressed it, and now it can't be read: the override ends — the panel
    // offers the button again, which asks for a confirm while the state is unknown)
    if (onAir === null && !L.unknownOk) { this.learnNow = null; return base; }
    return { live: false, why: null, override: true };
  }
  private queue(): string[] {
    return [...this.lib.entries.values()].filter((e) => (e.needs || (this.all && !e.st.analysed)) && !e.err && e.path && this.lib.inRoots(e.path) && !this.pageQueue.has(e.id)).map((e) => e.id);
  }
  start() { if (this.workerBroken) { this.unavailable(); return; } this.on = true; this.schedule(1000); }
  stop() { this.on = false; if (this.timer) clearTimeout(this.timer); this.timer = null; this.st.state = 'off'; this.killWorker(); }
  kick() { if (this.on && !this.busy) this.schedule(50); }
  private schedule(ms: number) { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => void this.step(), ms); this.timer.unref?.(); }
  private killWorker() { const w = this.worker; this.worker = null; this.workerReady = null; if (w) void w.terminate(); }

  /** One step at a time: `busy` is set before anything is awaited (a kick meanwhile can't start a second step). */
  private async step() {
    if (!this.on || this.busy) return;
    this.busy = true;
    let next = 500;
    try { next = await this.stepBody(); }
    finally {
      this.busy = false;
      if (this.workerBroken) this.unavailable(); else if (this.on) this.schedule(next);
    }
  }
  /** → ms until the next step. */
  private async stepBody(): Promise<number> {
    const q = this.queue();
    const ff = await findFfmpeg(this.o.ffmpegPath ?? '');   // (async + cached: never blocks VTube Pro)
    this.st.ffmpeg = !!ff;
    this.st.total = this.st.done + q.length;
    if (!q.length) {
      const out = this.lib.outsideRoots();
      this.st.state = 'idle'; this.st.current = '';
      this.st.says = this.pageQueue.size ? `${this.pageQueue.size} track${this.pageQueue.size === 1 ? '' : 's'} wait for the studio to decode them.`
        : out ? `${out} track${out === 1 ? '' : 's'} wait until you allow their music folder.` : 'Every track is ready.';
      return 15000;
    }
    const live = await this.liveState();
    if (live.live) { this.st.state = 'waiting'; this.st.says = `Waiting: ${live.why ?? 'you’re live'}. Track learning runs when you’re not live.`; return 30000; }
    const id = q[0], e = this.lib.entries.get(id)!;
    this.st.state = 'running'; this.st.current = e.title ? `${e.title}${e.artist ? ` — ${e.artist}` : ''}` : e.base;
    this.st.says = `Learning your tracks: ${this.st.done + 1} / ${this.st.total}`;
    let h: { fd: number; real: string } | null = null;
    const jobT0 = Date.now();
    try {
      // the file is opened here and the HANDLE checked (store.ts openReadable); the worker reads that handle
      h = this.lib.openReadable(e);
      if (!h) { this.lib.markFailed(id, e.path && fs.existsSync(e.path) ? 'It isn’t inside a music folder you allowed.' : 'The music file isn’t on this PC.'); return 500; }
      const real = h.real;
      const deadline = Date.now() + this.jobMs;
      const a = this.lib.analysis(id);
      const base = { id, sr: 22050, grid: a?.grid ?? null, model: modelState(this.o.dataDir) === 'ready' ? modelPath(this.o.dataDir) : null, maxSeconds: MAX_ANALYSIS_SECONDS };
      let own: TrackAnalysis | null = null;
      if (PCM_FILE.test(real)) {
        try { own = await this.analyse({ ...base, fd: h.fd }, deadline - Date.now()); }
        catch (err) { if ((err as Error).message !== NEEDS_DECODER) throw err; }   // (an unusual WAV / AIFF: ffmpeg or the page)
      }
      if (!own) {
        if (!ff) throw new NeedsDecoder(real);
        const pcm = await decodeWithFfmpeg(ff, real, { hardMs: Math.max(1000, deadline - Date.now()), ...(this.o.ffmpegIdleMs ? { idleMs: this.o.ffmpegIdleMs } : {}) });
        // (ffmpeg opens the path itself: the checked handle must still be the file there afterwards)
        if (!this.lib.sameFile(h.fd, real)) throw new Error('the file changed while it was read');
        own = await this.analyse({ ...base, pcm }, deadline - Date.now());
      }
      if (this.lib.putOwn(id, own)) { this.st.done++; const dt = Date.now() - jobT0; this.st.avgMs = this.st.avgMs ? Math.round(this.st.avgMs * 0.7 + dt * 0.3) : dt; }
      // ("learn now" while the studio previews: a pause between tracks keeps the preview smooth)
      if (live.override) return 5000;
    } catch (err) {
      if (err instanceof NeedsDecoder) this.pageQueue.add(id);
      else if (err instanceof WorkerUnavailable) { this.workerBroken = true; this.o.log?.(`[music] the analysis thread is unavailable: ${(err as Error).message}`); }
      else { this.lib.markFailed(id, `Couldn’t analyse it: ${(err as Error).message}`); this.o.log?.(`[music] analysis of ${e.base} failed: ${(err as Error).message}`); }
    } finally {
      if (h) { try { fs.closeSync(h.fd); } catch { /* closed */ } }
      this.st.state = 'idle'; this.st.current = '';
      this.lib.save();
    }
    return 500;
  }
  /** No analysis thread: say so and stop (decoding / DSP never fall back onto the helper's main thread). */
  private unavailable() {
    this.on = false; this.st.state = 'off'; this.st.current = '';
    this.st.says = 'Track learning can’t start on this PC (its background thread didn’t load). Update or reinstall VTube Pro; your DJ app’s analysis still works.';
  }
  /** A worker that said it's ready (one, reused between tracks). */
  private ensureWorker(): Promise<Worker> {
    if (this.workerReady) return this.workerReady;
    const p = new Promise<Worker>((resolve, reject) => {
      let w: Worker;
      try { w = new Worker(this.o.workerEntry ?? analyzeWorkerEntry()); } catch (e) { reject(new WorkerUnavailable((e as Error).message)); return; }
      this.worker = w;
      const cleanup = () => { clearTimeout(t); w.off('message', onMsg); w.off('error', onErr); w.off('exit', onExit); };
      const t = setTimeout(() => { cleanup(); void w.terminate(); reject(new WorkerUnavailable('it didn’t start')); }, this.o.startMs ?? 60000);
      const onMsg = (m: { ready?: boolean }) => { if (m?.ready) { cleanup(); resolve(w); } };
      const onErr = (e: Error) => { cleanup(); void w.terminate(); reject(new WorkerUnavailable(e.message)); };
      const onExit = () => { cleanup(); reject(new WorkerUnavailable('it stopped while starting')); };
      w.on('message', onMsg); w.once('error', onErr); w.once('exit', onExit);
    });
    this.workerReady = p;
    p.catch(() => { if (this.workerReady === p) { this.workerReady = null; this.worker = null; } });
    return p;
  }
  /** One job in the worker thread with a deadline: past it (or when the thread dies) the worker is terminated. */
  async analyse(m: WorkIn, timeoutMs = this.jobMs): Promise<TrackAnalysis> {
    const w = await this.ensureWorker();
    this.thread = 'worker';
    return new Promise<TrackAnalysis>((resolve, reject) => {
      const cleanup = () => { clearTimeout(t); w.off('message', onMsg); w.off('error', onErr); w.off('exit', onExit); };
      const t = setTimeout(() => { cleanup(); this.terminated++; this.killWorker(); reject(new Error('it took too long, so it was stopped')); }, Math.max(1, timeoutMs));
      // (every job has its own id; a message for another job is never taken as this one's result)
      const jid = ++this.jid;
      const onMsg = (r: { ok?: boolean; a?: TrackAnalysis; error?: string; ready?: boolean; jid?: number }) => { if (r?.ready || r?.jid !== jid) return; cleanup(); if (r.ok && r.a) resolve(r.a); else reject(new Error(r.error ?? 'analysis failed')); };
      const onErr = (e: Error) => { cleanup(); this.killWorker(); reject(e); };
      const onExit = (code: number) => { cleanup(); if (this.worker === w) { this.worker = null; this.workerReady = null; } reject(new Error(`the analysis thread stopped (${code})`)); };
      w.on('message', onMsg); w.once('error', onErr); w.once('exit', onExit);
      // (the PCM is handed over, not copied: this thread doesn't need it any more)
      w.postMessage({ ...m, jid }, m.pcm ? [m.pcm.buffer as ArrayBuffer] : []);
    });
  }
  /** The studio page decoded + analysed a track itself (no ffmpeg here). */
  pageResult(id: string, a: TrackAnalysis): boolean {
    if (!this.pageQueue.has(id)) return false;
    this.pageQueue.delete(id); this.pageGiven.delete(id);
    const r = this.lib.putOwn(id, { ...a, id });
    if (r) this.st.done++;
    return !!r;
  }
  /** The studio page gave up on a track (its deadline passed, the browser couldn't decode it). */
  pageFailed(id: string, why: string): boolean {
    if (!this.pageQueue.has(id)) return false;
    this.pageQueue.delete(id); this.pageGiven.delete(id);
    this.lib.markFailed(id, `Couldn’t analyse it in the studio: ${String(why).slice(0, 120)}`);
    this.lib.save();
    return true;
  }
  /** The next track the studio page should decode (null = none / live). A job handed out and not answered within the
   *  deadline is marked failed (the page that had it closed or hung). */
  async nextPageJob(): Promise<{ id: string; name: string } | null> {
    const live = await this.liveState();
    if (live.live) return null;
    const now = Date.now();
    for (const id of [...this.pageQueue]) {
      const given = this.pageGiven.get(id) ?? 0;
      if (given && now - given > this.jobMs) { this.pageFailed(id, 'it took too long'); continue; }
      const e = this.lib.entries.get(id), real = this.lib.readable(e);
      if (!e || !real) { this.pageQueue.delete(id); this.pageGiven.delete(id); continue; }
      let size = 0; try { size = fs.statSync(real).size; } catch { size = 0; }
      if (size > PAGE_MAX_BYTES) { this.pageFailed(id, 'the file is too big for the browser to read'); continue; }
      if (given) continue;   // (a page is decoding it now)
      this.pageGiven.set(id, now);
      return { id, name: e.base };
    }
    return null;
  }
  /** The file the studio page may fetch for a job it was handed, opened and checked (null = none; the caller closes). */
  openPageFile(id: string): { fd: number; real: string } | null { return this.pageQueue.has(id) && this.pageGiven.has(id) ? this.lib.openReadable(this.lib.entries.get(id)) : null; }
}
/** The biggest file handed to the studio page (a browser decodes the whole file in memory). */
export const PAGE_MAX_BYTES = 300 << 20;
