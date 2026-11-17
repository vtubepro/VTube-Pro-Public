// GPU lip sync link (runs inside the voice VAD worker): streams the worklet's 16 kHz mic signal to the local
// Audio2Face-3D sidecar (tools/gpu/a2f_sidecar.py, ws://127.0.0.1:5197/a2f) and posts back its ARKit frames stamped
// with the epoch time (ms) of the instant each describes — the same clock as the neural viseme frames.
// Never throws into the audio path: a missing / dead sidecar just means no frames (the rule engine + neural
// visemes carry on), with a reconnect every few seconds while it is switched on. docs/GPU_TRACKING.md

export interface A2fLinkCfg { on: boolean; url?: string; futureMs?: number; fps?: number }
export type A2fPost = (m: unknown, tr?: Transferable[]) => void;

const epoch = () => performance.timeOrigin + performance.now();

export class A2fLink {
  private ws: WebSocket | null = null;
  private cfg: A2fLinkCfg = { on: false };
  private samples = 0;          // samples sent in this stream (the sidecar's clock)
  private base = 0;             // epoch ms of stream sample 0 (latest estimate)
  private retry: ReturnType<typeof setTimeout> | null = null;
  private ready = false;
  private names: string[] = [];
  private post: A2fPost;
  constructor(post: A2fPost) { this.post = post; }

  configure(c: A2fLinkCfg) {
    const was = this.cfg;
    this.cfg = { ...was, ...c };
    if (!this.cfg.on) { this.close('off'); return; }
    if (!this.ws || was.url !== this.cfg.url) { this.close(''); this.open(); return; }
    if (this.ready && (was.futureMs !== this.cfg.futureMs || was.fps !== this.cfg.fps)) this.hello();
  }

  private hello() {
    this.samples = 0;
    try { this.ws?.send(JSON.stringify({ type: 'hello', futureMs: this.cfg.futureMs ?? 60, fps: this.cfg.fps ?? 60 })); } catch { /* closed */ }
  }

  private open() {
    if (!this.cfg.on || this.ws) return;
    const url = this.cfg.url || 'ws://127.0.0.1:5197/a2f';
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch (e) { this.status(false, String((e as Error)?.message ?? e)); this.later(); return; }
    this.ws = ws;
    ws.onopen = () => { this.hello(); };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let d: { type: string; s?: number[]; w?: number[][]; ms?: number; provider?: string; names?: string[]; futureMs?: number; msPerSec?: number };
      try { d = JSON.parse(e.data); } catch { return; }
      if (d.type === 'ready') { this.ready = true; this.names = d.names ?? this.names; this.post({ type: 'a2fReady', provider: d.provider, futureMs: d.futureMs, names: this.names }); }
      else if (d.type === 'f' && d.s && d.w) {
        const frames = d.s.map((s, i) => ({ t: this.base + (s / 16000) * 1000, w: Float32Array.from(d.w![i], (x) => x / 1000) }));
        this.post({ type: 'a2f', frames, ms: d.ms ?? 0 });
      } else if (d.type === 'stat') this.post({ type: 'a2fStat', msPerSec: d.msPerSec ?? 0 });
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null; this.ready = false;
      this.status(false, ev.code === 4000 ? 'another studio page took the GPU lip sync (retrying in 15 s)' : 'GPU lip sync sidecar not running (retrying)');
      // never give up while switched on: after a page reload the OLD page's worker can connect last and kick the new
      // one (4000) — then that old page dies and nobody would reconnect (2026-09-27: lip sync silently gone)
      this.later(ev.code === 4000 ? 15000 : 3000);
    };
  }

  private later(ms = 3000) {
    if (this.retry || !this.cfg.on) return;
    this.retry = setTimeout(() => { this.retry = null; this.open(); }, ms);
  }

  private status(ok: boolean, error: string) { this.post({ type: 'a2fError', ok, error }); }

  private close(why: string) {
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    const ws = this.ws; this.ws = null; this.ready = false;
    if (ws) { try { ws.close(); } catch { /* ignore */ } }
    if (why) this.status(false, '');
  }

  /** One 10 ms chunk of the worklet's 16 kHz stream (called for every chunk, in order). */
  push(x: Float32Array) {
    if (!this.ready || !this.ws || this.ws.readyState !== 1) return;
    this.samples += x.length;
    // the newest sample arrived now: sample 0 of this stream was (samples / 16 kHz) earlier
    this.base = epoch() - (this.samples / 16000) * 1000;
    try { this.ws.send(x.slice().buffer); } catch { /* closed: onclose reconnects */ }
  }
}
