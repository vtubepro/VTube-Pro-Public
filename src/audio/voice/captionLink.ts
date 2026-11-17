// Live captions link (runs inside the voice VAD worker): streams the worklet's 16 kHz mic signal, with its per-10-ms "the
// performer is speaking" gate flag, to the local caption service over ws://<helper>/ws/captions-in. The signal is the one
// the studio already analyses (no second microphone capture). Never throws into the audio path: when the helper or the
// caption engine is not there, frames are simply dropped and it retries every few seconds while switched on.
// Frame (binary, ~100 ms): [u8 n][n gate bytes][n x 160 int16 LE]; server/captions/manager.ts parseAudioFrame().
// docs/LIVE_CAPTIONS.md

export interface CaptionLinkCfg { on: boolean; url?: string }
export type CaptionPost = (m: unknown) => void;

const CHUNK = 160;      // samples per worklet chunk (10 ms at 16 kHz)
const PER_FRAME = 10;   // chunks per websocket message

export class CaptionLink {
  private ws: WebSocket | null = null;
  private cfg: CaptionLinkCfg = { on: false };
  private retry: ReturnType<typeof setTimeout> | null = null;
  private ready = false;
  private gate = new Uint8Array(PER_FRAME);
  private pcm = new Int16Array(PER_FRAME * CHUNK);
  private n = 0;
  private sent = 0;
  private post: CaptionPost;
  constructor(post: CaptionPost) { this.post = post; }

  configure(c: CaptionLinkCfg) {
    const was = this.cfg;
    this.cfg = { ...was, ...c };
    if (!this.cfg.on) { this.close(); this.status(false, ''); return; }
    if (!this.ws || was.url !== this.cfg.url) { this.close(); this.open(); }
  }

  private open() {
    if (!this.cfg.on || this.ws) return;
    const url = this.cfg.url;
    if (!url) { this.status(false, 'no caption service address'); return; }
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch (e) { this.status(false, String((e as Error)?.message ?? e)); this.later(); return; }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      try { const m = JSON.parse(e.data) as { type?: string }; if (m.type === 'ready') { this.ready = true; this.n = 0; this.status(true, ''); } } catch { /* not ours */ }
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null; this.ready = false; this.n = 0;
      // 4001: captions are off on the helper (the switch there is the truth); 4002: another studio page already sends the
      // audio (the first live page owns it: this one waits and only takes over when that one goes quiet); 4000: the owner
      // went quiet and another page took over
      const other = ev.code === 4000 || ev.code === 4002;
      this.status(false, ev.code === 4001 ? 'captions are off in VTube Pro' : other ? 'another studio page is sending the captions' : 'caption service not reachable (retrying)');
      this.later(ev.code === 4002 ? 20000 : ev.code === 4000 ? 15000 : 4000);
    };
  }

  private later(ms = 4000) {
    if (this.retry || !this.cfg.on) return;
    this.retry = setTimeout(() => { this.retry = null; this.open(); }, ms);
  }

  private status(ok: boolean, error: string) { this.post({ type: 'capStatus', ok, error }); }

  private close() {
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    const ws = this.ws; this.ws = null; this.ready = false; this.n = 0;
    if (ws) { try { ws.close(); } catch { /* ignore */ } }
  }

  /** One 10 ms chunk of the worklet's 16 kHz stream, with its gate flag (1 = speaking). Called for every chunk, in order. */
  push(x: Float32Array, g?: number) {
    if (!this.ready || !this.ws || this.ws.readyState !== 1) return;
    const base = this.n * CHUNK;
    const len = Math.min(CHUNK, x.length);
    for (let i = 0; i < len; i++) { const v = x[i] * 32768; this.pcm[base + i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v; }
    for (let i = len; i < CHUNK; i++) this.pcm[base + i] = 0;
    this.gate[this.n] = g === 0 ? 0 : 1;
    if (++this.n < PER_FRAME) return;
    this.n = 0;
    // a stalled socket must not grow memory or delay the audio thread's other work: skip the frame instead
    if (this.ws.bufferedAmount > 1 << 20) return;
    const out = new Uint8Array(1 + PER_FRAME + PER_FRAME * CHUNK * 2);
    out[0] = PER_FRAME;
    out.set(this.gate, 1);
    out.set(new Uint8Array(this.pcm.buffer, this.pcm.byteOffset, this.pcm.byteLength), 1 + PER_FRAME);
    try { this.ws.send(out.buffer); this.sent++; } catch { /* closed: onclose reconnects */ }
  }
}
