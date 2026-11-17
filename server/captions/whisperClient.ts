// The server's side of tools/voice/whisper_sidecar.py: one websocket on 127.0.0.1, one request in flight at a time (the
// caption session never starts a run while another is going). A Recogniser for server/captions/session.ts.
import WebSocket from 'ws';
import type { RecogniseRequest, RecogniseResult, Recogniser } from './session.ts';

export interface WhisperInfo { model: string; device: string; compute: string; fallback: string; version: string }
export type ClientState = 'connecting' | 'ready' | 'down';

export class WhisperClient implements Recogniser {
  private ws: WebSocket | null = null;
  private id = 0;
  private pending = new Map<number, { resolve: (r: RecogniseResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private retry: NodeJS.Timeout | null = null;
  private closed = false;
  state: ClientState = 'down';
  info: WhisperInfo | null = null;
  lastError = '';

  constructor(private url: string, private onState: (s: ClientState, detail: string) => void = () => {}, private timeoutMs = 20000) {}

  /** Connect (and keep reconnecting every 2 s until close()). */
  connect() {
    this.closed = false;
    this.open();
  }

  private set(s: ClientState, detail = '') { this.state = s; try { this.onState(s, detail); } catch { /* listener */ } }

  private open() {
    if (this.closed || this.ws) return;
    this.set('connecting');
    let ws: WebSocket;
    try { ws = new WebSocket(this.url, { handshakeTimeout: 4000, maxPayload: 1 << 24 }); } catch (e) { this.lastError = String((e as Error).message); this.later(); return; }
    this.ws = ws;
    ws.on('message', (d, isBinary) => {
      if (isBinary) return;
      let m: { type?: string; id?: number; words?: unknown; ms?: number; error?: string } & Partial<WhisperInfo>;
      try { m = JSON.parse(String(d)); } catch { return; }
      if (m.type === 'ready') {
        // (only our sidecar says "ready" with a model: whatever else listens on that port gets no audio)
        if (typeof m.model !== 'string') { this.lastError = 'something else answers on the caption port'; ws.close(); return; }
        this.info = { model: m.model, device: String(m.device ?? ''), compute: String(m.compute ?? ''), fallback: String(m.fallback ?? ''), version: String(m.version ?? '') };
        this.lastError = '';
        this.set('ready', `${m.model} on ${m.device}`);
      } else if ((m.type === 'result' || m.type === 'error') && typeof m.id === 'number') {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id); clearTimeout(p.timer);
        if (m.type === 'error') p.reject(new Error(String(m.error ?? 'recogniser error')));
        else {
          const words = Array.isArray(m.words) ? (m.words as { w?: unknown; t0?: unknown; t1?: unknown; p?: unknown }[]).filter((w) => typeof w.w === 'string' && Number.isFinite(w.t0) && Number.isFinite(w.t1)).map((w) => ({ w: String(w.w), t0: Number(w.t0), t1: Number(w.t1), ...(typeof w.p === 'number' && w.p >= 0 && w.p <= 1 ? { p: w.p } : {}) })) : [];
          p.resolve({ words, ms: Number(m.ms) || 0 });
        }
      }
    });
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      this.info = null;
      for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('the caption engine closed')); this.pending.delete(id); }
      if (!this.closed) { this.set('down', this.lastError); this.later(); }
    });
    ws.on('error', (e) => { this.lastError = String((e as Error).message ?? e); });
  }

  private later() {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => { this.retry = null; this.open(); }, 2000);
  }

  transcribe(r: RecogniseRequest): Promise<RecogniseResult> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.state !== 'ready') return Promise.reject(new Error('the caption engine is not ready'));
    const id = ++this.id;
    const head = Buffer.from(JSON.stringify({ id, lang: r.lang, prompt: r.prompt }));
    const len = Buffer.alloc(4); len.writeUInt32LE(head.length);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('the caption engine took too long')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(Buffer.concat([len, head, Buffer.from(r.audio.buffer, r.audio.byteOffset, r.audio.byteLength)]), { binary: true }, (err) => {
        if (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
      });
    });
  }

  close() {
    this.closed = true;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    try { this.ws?.close(); } catch { /* */ }
    this.ws = null;
    this.set('down');
  }
}
