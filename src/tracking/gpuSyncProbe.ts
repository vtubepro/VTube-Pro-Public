// How long one round trip through this browser's graphics queue takes right now (beta.13.5 P0; research/tracking_gpu_rca/
// RCA.md §4 P0 item 3). A tiny worker with its own 1×1 WebGL2 canvas clears it and reads the pixel back once a second:
// the readback waits for everything the browser queued on the graphics card before it — the same wait MediaPipe's
// processor path pays once per face run (its one blocking readPixels: tools/mp_gl_probe.mjs). Next to a game that holds
// the card it reads tens to hundreds of ms; on an idle card ~0.1-1 ms. Diagnostics + the stall notice only (no decision
// depends on it alone). Cost: one pixel a second. Runs while tracking runs (src/app.ts starts / stops it).
const WORKER = `
let gl = null;
try { gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'default' }); } catch (e) { gl = null; }
const px = new Uint8Array(4);
setInterval(() => {
  if (!gl || gl.isContextLost()) { postMessage({ ms: -1 }); return; }
  const t = performance.now();
  gl.clearColor(Math.random(), 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  postMessage({ ms: performance.now() - t });
}, 1000);
`;

export class GpuSyncProbe {
  private w: Worker | null = null;
  private hist: { t: number; ms: number }[] = [];
  /** EMA of the round trip (ms) and the largest of the last 5 s; -1 = not measured (no WebGL in a worker here, or not
   *  past the start-up yet). */
  ms = -1;
  max5 = -1;
  /** Round trips seen since start: the first two include the context's start-up (shader / driver work), not a queue
   *  wait — dropped (review round 2: stored as the average, they read as a game for seconds after the camera started). */
  private seen = 0;

  start() {
    if (this.w || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return;
    try {
      const url = URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' }));
      const w = new Worker(url, { name: 'vtp-gpu-sync' });
      URL.revokeObjectURL(url);
      w.onmessage = (e: MessageEvent<{ ms: number }>) => this.take(e.data.ms);
      w.onerror = () => this.stop();
      this.w = w;
    } catch { this.w = null; }
  }

  stop() { this.w?.terminate(); this.w = null; this.hist = []; this.ms = -1; this.max5 = -1; this.seen = 0; }

  get running() { return !!this.w; }

  private take(ms: number) {
    if (!(ms >= 0)) { this.ms = -1; return; }
    if (++this.seen <= 2) return;
    const now = performance.now();
    this.ms = this.ms < 0 ? ms : this.ms + (ms - this.ms) * 0.3;
    this.hist.push({ t: now, ms });
    while (this.hist.length && this.hist[0].t < now - 5000) this.hist.shift();
    this.max5 = Math.max(...this.hist.map((h) => h.ms));
  }
}

/** The studio's one probe (src/stage/gfx/healthBeacon.ts starts / stops it with tracking). */
export const gpuSync = new GpuSyncProbe();
