// OpenSeeFace on the studio page: owns the face worker (osfWorker.ts), feeds it camera pictures and hands each result to the
// studio as an ExternalTracking packet (App pushes it into its ExternalFaceSource, source 'openseeface'). Nothing is downloaded
// here: the models are the ones the helper holds after the user's "Get the light face tracker" click (server/tracking/
// openSeeFace.ts); without them start() answers 'needs-install' and does nothing else.
import type { ExternalTracking } from '../../../shared/types.ts';
import { cpuFaceInit, grabCpuFrame } from '../cpuFace/index.ts';

export type OsfState = 'off' | 'needs-install' | 'starting' | 'running' | 'error';
export interface OsfStatus { state: OsfState; text: string; hz: number; ms: number; frames: number }
export interface OsfServerView { installed: boolean; variant: string | null; files: { file: string; bytes: number; note: string; state: string }[]; bytes: number; licence: string; busy: { got: number; total: number } | null }

const READY_TIMEOUT_MS = 60_000;
/** A frame sent to the worker and not answered for this long is given up (see pump). */
const OSF_BUSY_MS = 5000;

export class OsfController {
  status: OsfStatus = { state: 'off', text: 'Off', hz: 0, ms: 0, frames: 0 };
  /** what the helper said last (null = not asked yet / the helper is not there) */
  server: OsfServerView | null = null;
  private worker: Worker | null = null;
  private busy = false;
  /** When the frame in flight was sent (ms): a frame never answered must not hold `busy` for good. */
  private busySince = 0;
  private stopPump: (() => void) | null = null;
  private times: number[] = [];
  private errors = 0;
  private sendId = 0;
  private onData: ((d: ExternalTracking) => void) | null = null;

  /** Turns a server path into a URL a Worker can fetch. */
  private readonly getUrl = (path: string) => `${location.origin}${path}`;

  get running() { return this.status.state === 'running'; }
  get installed(): boolean | null { return this.server ? this.server.installed : null; }

  private set(state: OsfState, text: string) { this.status = { ...this.status, state, text }; }

  /** Ask the server whether the models are there. */
  async refresh(): Promise<OsfServerView | null> {
    try {
      const r = await fetch('/api/openseeface', { cache: 'no-store' });
      this.server = r.ok ? (await r.json()) as OsfServerView : null;
    } catch { this.server = null; }
    return this.server;
  }

  /** The user's click: the helper downloads and checks the models (5 MB). Resolves when it is done or failed. */
  async install(onProgress?: (got: number, total: number) => void): Promise<{ ok: boolean; says: string }> {
    const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    if (ua && !ua.isActive) return { ok: false, says: 'Press the button again.' };
    let r: Response;
    try { r = await fetch('/api/openseeface/install', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vtp-user-action': '1' }, body: '{}' }); }
    catch (e) { return { ok: false, says: `VTube Pro did not answer (${(e as Error).message}).` }; }
    const first = await r.json().catch(() => ({ ok: false, says: `VTube Pro answered ${r.status}.` })) as { ok: boolean; says: string; dryRun?: boolean };
    if (!first.ok || first.dryRun) return first;
    for (let i = 0; i < 600; i++) {                      // up to ~5 min
      await new Promise((res) => setTimeout(res, 500));
      const v = await this.refresh();
      if (v?.busy) onProgress?.(v.busy.got, v.busy.total);
      if (v && !v.busy) return v.installed ? { ok: true, says: 'The light face tracker is ready.' } : { ok: false, says: 'The download did not finish. Check your internet and try again.' };
    }
    return { ok: false, says: 'The download is taking very long. Try again later.' };
  }

  /** Start following the face in `video`. false = not started (see status.text). */
  async start(video: HTMLVideoElement, onData: (d: ExternalTracking) => void): Promise<boolean> {
    if (this.worker) return this.running;
    this.onData = onData; this.errors = 0; this.times = [];
    this.set('starting', 'Starting the light face tracker…');
    const v = await this.refresh();
    if (!v) { this.set('error', 'VTube Pro is not running, so the light face tracker cannot start.'); return false; }
    if (!v.installed) { this.set('needs-install', 'The light face tracker is not installed yet.'); return false; }
    const det = v.files.find((f) => /detection/.test(f.file)), lm = v.files.find((f) => /lm_model/.test(f.file));
    if (!det || !lm) { this.set('error', 'The light face tracker’s files are incomplete. Install it again.'); return false; }
    const detUrl = this.getUrl(`/api/openseeface/model/${encodeURIComponent(det.file)}`), lmUrl = this.getUrl(`/api/openseeface/model/${encodeURIComponent(lm.file)}`);
    let w: Worker;
    try { w = new Worker(new URL('./osfWorker.ts', import.meta.url), { type: 'module', name: 'vtp-osf' }); }
    catch (e) { this.set('error', `This browser could not start the light face tracker (${(e as Error).message}).`); return false; }
    this.worker = w;
    const ready = new Promise<boolean>((resolve) => {
      const to = setTimeout(() => { this.set('error', 'The light face tracker took too long to start.'); resolve(false); }, READY_TIMEOUT_MS);
      w.onmessage = (e: MessageEvent) => {
        const m = e.data as { type: string; message?: string; fatal?: boolean; id?: number; d?: ExternalTracking; ms?: number };
        if (m.type === 'ready') { clearTimeout(to); resolve(true); }
        else if (m.type === 'error' && m.fatal) { clearTimeout(to); this.set('error', `The light face tracker could not start: ${m.message ?? 'unknown error'}`); resolve(false); }
        else if (m.type === 'result') this.onResult(m as { d: ExternalTracking; ms: number });
        else if (m.type === 'error') { this.busy = false; if (++this.errors >= 8) this.set('error', `The light face tracker keeps failing: ${m.message ?? ''}`); }
      };
      w.onerror = (e) => { clearTimeout(to); this.set('error', `The light face tracker crashed: ${e.message || 'worker error'}`); resolve(false); };
    });
    w.postMessage({ type: 'init', models: { detector: detUrl, landmarks: lmUrl }, ortBase: cpuFaceInit().ortBase });
    if (!(await ready)) { this.stop(false); return false; }
    this.set('running', 'Following your face with the light face tracker.');
    this.pump(video);
    return true;
  }

  private onResult(m: { d: ExternalTracking; ms: number }) {
    this.busy = false;
    this.errors = 0;
    const now = performance.now();
    this.times.push(now);
    while (this.times.length && now - this.times[0] > 1500) this.times.shift();
    this.status = { ...this.status, frames: this.status.frames + 1, ms: this.status.ms * 0.8 + m.ms * 0.2, hz: this.times.length / 1.5 };
    this.onData?.(m.d);
  }

  /** One picture per new camera frame, never more than one in flight. */
  private pump(video: HTMLVideoElement) {
    let live = true;
    const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number; cancelVideoFrameCallback?: (id: number) => void };
    let rvfc = 0, timer = 0;
    const send = () => {
      // (watchdog: a frame whose reply never comes — a picture that never arrived, a worker that never answered — is given up
      //  after OSF_BUSY_MS, so tracking resumes instead of staying frozen with `busy` stuck on)
      if (this.busy && performance.now() - this.busySince > OSF_BUSY_MS) this.busy = false;
      if (!live || !this.worker || this.busy || video.readyState < 2 || !video.videoWidth) return;
      this.busy = true; this.busySince = performance.now();
      void grabCpuFrame(video, performance.now()).then((f) => {
        if (!live || !this.worker) { try { f.close(); } catch { /* closed */ } this.busy = false; return; }
        this.worker.postMessage({ type: 'frame', bitmap: f, id: ++this.sendId }, [f as unknown as Transferable]);
      }).catch(() => { this.busy = false; });
    };
    if (v.requestVideoFrameCallback) { const loop = () => { send(); if (live) rvfc = v.requestVideoFrameCallback!(loop); }; rvfc = v.requestVideoFrameCallback(loop); }
    else timer = window.setInterval(send, 33);
    // (a hidden page pauses requestVideoFrameCallback: poll as well, at a lower rate)
    const poll = window.setInterval(send, 100);
    this.stopPump = () => { live = false; if (rvfc && v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(rvfc); if (timer) clearInterval(timer); clearInterval(poll); };
  }

  stop(clearText = true) {
    this.stopPump?.(); this.stopPump = null;
    const w = this.worker; this.worker = null; this.busy = false; this.onData = null;
    if (w) { try { w.postMessage({ type: 'close' }); } catch { /* gone */ } setTimeout(() => w.terminate(), 300); }
    if (clearText && this.status.state !== 'error' && this.status.state !== 'needs-install') this.status = { state: 'off', text: 'Off', hz: 0, ms: 0, frames: 0 };
  }
}
