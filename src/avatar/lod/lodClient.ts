// Avatar detail: the page's lod worker (src/avatar/lod/lodWorker.ts), created on the first job only (a page whose
// avatars are all normal never starts it). Jobs run one at a time, one geometry per job, in the order asked; a job
// whose owner went away (avatar switched / disposed) before it started is dropped, and a late result for a dead owner
// is ignored. The job's buffers are transferred (they are copies made by src/avatar/lod/extract.ts).
// The worker is TERMINATED as soon as its queue drains and made again for the next job: meshoptimizer's WebAssembly
// memory grows to the largest job (about 100 MB for a 550k-triangle body) and never shrinks, and the levels are only
// made at load, so a worker kept alive would hold that memory for the page's whole life (every OBS source, the studio
// view and the Scene-tab preview each have their own). A new worker costs a module load + a WASM compile (tens of ms,
// off the main thread) per avatar that gets levels.
import type { RawLevelJob } from '../../../shared/lod/levels.ts';
import type { LodRequest, LodResponse } from './lodWorker.ts';

export type LodResult = Extract<LodResponse, { ok: true }>;

/** What LodClient needs from a worker (a real module Worker on pages; a stand-in in tools/lod_switch_unit.ts). */
export interface LodWorkerLike {
  onmessage: ((e: MessageEvent<LodResponse>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  postMessage(msg: LodRequest, transfer: Transferable[]): void;
  terminate(): void;
}

interface Pending { id: number; job: RawLevelJob; alive: () => boolean; resolve: (r: LodResult | null) => void; reject: (e: Error) => void }

const pageWorker = (): LodWorkerLike => new Worker(new URL('./lodWorker.ts', import.meta.url), { type: 'module', name: 'vtp-lod' }) as unknown as LodWorkerLike;

export class LodClient {
  private worker: LodWorkerLike | null = null;
  private queue: Pending[] = [];
  private running: Pending | null = null;
  private seq = 0;
  /** Jobs posted to the worker so far (the no-op gate checks this stays 0 for normal models). */
  jobsStarted = 0;
  /** Worker busy time so far (ms). */
  busyMs = 0;
  /** Workers created / terminated so far (each drained queue ends its worker). */
  workersStarted = 0;
  workersStopped = 0;

  constructor(private make: () => LodWorkerLike = pageWorker) {}

  /** Is a worker alive right now (only while jobs are queued or running)? */
  get alive() { return this.worker !== null; }

  /** Levels for one geometry, or null when the owner went away first. */
  run(job: RawLevelJob, alive: () => boolean): Promise<LodResult | null> {
    return new Promise((resolve, reject) => { this.queue.push({ id: ++this.seq, job, alive, resolve, reject }); this.pump(); });
  }

  private ensure(): LodWorkerLike {
    if (this.worker) return this.worker;
    const w = this.make();
    w.onmessage = (e: MessageEvent<LodResponse>) => { if (this.worker === w) this.done(e.data); };
    w.onerror = (e) => {
      if (this.worker !== w) return;
      const p = this.running; this.running = null;
      p?.reject(new Error(`lod worker: ${e.message || 'failed'}`));
      this.stop();
      this.pump();
    };
    this.worker = w;
    this.workersStarted++;
    return w;
  }

  private stop() {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    this.workersStopped++;
  }

  private pump() {
    if (this.running) return;
    while (this.queue.length) {
      const p = this.queue.shift()!;
      if (!p.alive()) { p.resolve(null); continue; }
      this.running = p;
      this.jobsStarted++;
      const j = p.job;
      const t: Transferable[] = [j.pos.buffer, j.index.buffer];
      for (const a of [j.nrm, j.moved, j.sphere, j.region]) if (a && !t.includes(a.buffer)) t.push(a.buffer);
      const msg: LodRequest = { id: p.id, job: j };
      try { this.ensure().postMessage(msg, t as Transferable[]); }
      catch (e) { this.running = null; p.reject(e as Error); continue; }
      return;
    }
    // drained: nothing queued, nothing running -> free the worker (and its WASM memory) until the next job
    this.stop();
  }

  private done(r: LodResponse) {
    const p = this.running;
    if (!p || p.id !== r.id) return;
    this.running = null;
    if (r.ok) { this.busyMs += r.ms; p.resolve(p.alive() ? r : null); }
    else p.reject(new Error(r.error));
    this.pump();
  }
}

export const lodClient = new LodClient();
