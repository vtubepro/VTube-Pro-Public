// Camera-frame GPU sidecars (docs/GPU_TRACKING.md): NVIDIA Maxine AR face expressions and RTMW whole-body pose.
//
// The studio keeps the webcam (the sidecars never open it): at `fps` it JPEG-encodes a downscaled copy of the frame
// MediaPipe is working on and sends it to each enabled sidecar over localhost (tools/gpu/vision_sidecar.py). Results
// come back stamped with the frame's capture time and are folded into the MediaPipe result BEFORE the solvers run,
// so everything downstream (natural capture, stabiliser, expressions, body IK) is unchanged:
//   maxine  → the 52 ARKit blendshape scores (blended by `mix`); MediaPipe keeps the landmarks / head pose / lips.
//            Maxine's values are first mapped into MediaPipe's own range per channel (running 10th / 95th percentiles
//            of both on the same frames): the face calibration, natural capture and expression model were all learned
//            on MediaPipe's numbers (e.g. resting blink 0.27 vs Maxine 0.03), so raw Maxine values read as eyes
//            wide open / lips never resting. Until ~5 s of paired frames exist, only 30 % of Maxine is used.
//   rtmw    → 2D arm + hand landmark positions where RTMW is confident (MediaPipe keeps depth / visibility).
// A result older than `maxAge` ms vs the MediaPipe frame is ignored (then it's MediaPipe alone, as before).
import { ARKIT } from '../core/arkit.ts';
import type { RawTracking } from './Tracker.ts';

export const GPU_VISION_KEY = 'vtp.gpuVision';
export interface GpuVisionSettings {
  maxine: { on: boolean; mix: number };
  rtmw: { on: boolean };
  /** frames per second sent to the sidecars (30 or 60) */
  fps: number;
  /** width of the frames sent (height follows the camera's aspect) */
  width: number;
}
export const DEFAULT_GPU_VISION: GpuVisionSettings = { maxine: { on: false, mix: 0.8 }, rtmw: { on: false }, fps: 30, width: 640 };
export function loadGpuVision(): GpuVisionSettings {
  try {
    const s = globalThis.localStorage?.getItem(GPU_VISION_KEY);
    if (s) { const o = JSON.parse(s); return { ...DEFAULT_GPU_VISION, ...o, maxine: { ...DEFAULT_GPU_VISION.maxine, ...o.maxine }, rtmw: { ...DEFAULT_GPU_VISION.rtmw, ...o.rtmw } }; }
  } catch { /* storage off */ }
  return structuredClone(DEFAULT_GPU_VISION);
}

type Feature = 'maxine' | 'rtmw';
const PORT: Record<Feature, number> = { maxine: 5199, rtmw: 5198 };
interface Link { ws: WebSocket | null; ready: boolean; error: string; provider: string; names: string[]; ms: number; retry: ReturnType<typeof setTimeout> | null; recv: number; fps: number; fpsN: number; fpsT: number; ensureT: number; lastAt: number }

/**
 * Per-channel range alignment Maxine (or the face model) -> MediaPipe from paired samples. The 10th / 95th percentiles of both
 * sources are tracked per channel with a fixed-bin histogram (BINS bins over 0..1, values clamped) whose counts decay
 * exponentially (an effective window of N samples, uniform until it fills): a push is O(1) per channel and the 2-s refit scans
 * BINS counters per channel, ~0.05 ms for 41 channels. (It used to keep a ring of N samples per channel and sort them all on the
 * studio's tick: ~1 ms per channel, a dropped frame on the live render thread.) Percentiles are read to within one bin (1/BINS).
 */
export class RangeMap {
  static N = 1800;
  static BINS = 512;
  private count = 0; private n = 0; private at = 0;
  private hx: Float64Array[] = []; private hp: Float64Array[] = [];
  /** weight of the next sample (grows by 1 / (1 - 1/N) per sample once the window is full = every older count decays) and the total weight */
  private w = 1; private tot = 0;
  private map: { a: number; b: number }[] = [];
  private bin(v: number) { const B = RangeMap.BINS, i = Math.floor((Number.isFinite(v) ? v : 0) * B); return i < 0 ? 0 : i >= B ? B - 1 : i; }
  push(mx: number[], mp: number[]) {
    const B = RangeMap.BINS;
    if (!this.hx.length) { for (let i = 0; i < mx.length; i++) { this.hx.push(new Float64Array(B)); this.hp.push(new Float64Array(B)); } }
    const w = this.w;
    for (let i = 0; i < mx.length && i < this.hx.length; i++) { this.hx[i][this.bin(mx[i])] += w; this.hp[i][this.bin(mp[i])] += w; }
    this.tot += w; this.count++; this.n = Math.min(RangeMap.N, this.count);
    if (this.count >= RangeMap.N) {
      this.w *= 1 / (1 - 1 / RangeMap.N);
      if (this.w > 1e12) { const s = 1 / this.w; for (const h of this.hx) for (let j = 0; j < B; j++) h[j] *= s; for (const h of this.hp) for (let j = 0; j < B; j++) h[j] *= s; this.tot *= s; this.w = 1; }
    }
    const now = performance.now();
    if (this.n >= 150 && now - this.at > 2000) { this.at = now; this.refit(); }
  }
  get ready() { return this.map.length > 0; }
  get samples() { return this.n; }
  /** the p-quantile pair (lo, hi) of a histogram, interpolated inside the bin */
  private quant(h: Float64Array, plo: number, phi: number): [number, number] {
    const B = RangeMap.BINS, tlo = plo * this.tot, thi = phi * this.tot;
    let c = 0, lo = -1, hi = -1;
    for (let j = 0; j < B; j++) {
      const c1 = c + h[j];
      if (lo < 0 && c1 >= tlo && h[j] > 0) lo = (j + (tlo - c) / h[j]) / B;
      if (c1 >= thi && h[j] > 0) { hi = (j + (thi - c) / h[j]) / B; break; }
      c = c1;
    }
    return [lo < 0 ? 0 : lo, hi < 0 ? 1 : hi];
  }
  private refit() {
    this.map = this.hx.map((hx, i) => {
      const [xl, xh] = this.quant(hx, 0.1, 0.95), [pl, ph] = this.quant(this.hp[i], 0.1, 0.95);
      // a channel neither source moves on: identity (no invented motion)
      if (xh - xl < 0.03 || ph - pl < 0.03) return { a: 1, b: 0 };
      const a = Math.min(4, Math.max(0.25, (ph - pl) / (xh - xl)));
      return { a, b: pl - a * xl };
    });
  }
  apply(i: number, v: number) { const m = this.map[i]; return m ? Math.min(1, Math.max(0, m.a * v + m.b)) : v; }
}
const ARKIT_IX = new Map<string, number>(ARKIT.map((n, i) => [n, i]));
interface FaceRes { t: number; w: number[]; conf: number }
interface BodyRes { t: number; kp: number[][] }

// COCO-WholeBody body index → MediaPipe Pose index (arms + hips; face / legs stay MediaPipe's)
const BODY_MAP: [number, number][] = [[5, 11], [6, 12], [7, 13], [8, 14], [9, 15], [10, 16], [11, 23], [12, 24]];

export class GpuVision {
  settings: GpuVisionSettings = loadGpuVision();
  /** observer sandboxes never connect (a sidecar serves one studio) */
  blocked = false;
  /** Hands / Body switches: RTMW only refines the body and hands, so it gets no frames while both are off. */
  bodyWanted = true;
  maxAge = 120;
  private links: Record<Feature, Link> = { maxine: this.mk(), rtmw: this.mk() };
  private canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  private busy = false;
  private lastSend = 0;
  face: FaceRes | null = null;
  private pairedFace: FaceRes | null = null;
  body: BodyRes | null = null;
  dbg = { faceUsed: false, bodyUsed: false, encodeMs: 0, sent: 0, faceAge: 0, bodyAge: 0, bodyPts: 0 };
  private mk(): Link { return { ws: null, ready: false, error: '', provider: '', names: [], ms: 0, retry: null, recv: 0, fps: 0, fpsN: 0, fpsT: 0, ensureT: 0, lastAt: 0 }; }
  private range = new RangeMap();
  /** The face model's 'maxine' teacher (faceNet/faceModel.ts): while `trackMapped` is on (a teach session), the newest Maxine result as
   *  mapped into MediaPipe's range (52, ARKIT order; NaN = Maxine has no value for that channel) and the capture time it describes. */
  trackMapped = false;
  readonly mapped = new Float32Array(52).fill(NaN);
  mappedT = 0;
  /** diagnostics for state.json / the status line */
  summary() {
    const one = (f: Feature) => { const l = this.links[f]; return { on: this.settings[f].on, ready: l.ready, fps: Math.round(l.fps), ms: +l.ms.toFixed(1), used: f === 'maxine' ? this.dbg.faceUsed : this.dbg.bodyUsed, ageMs: Math.round(f === 'maxine' ? this.dbg.faceAge : this.dbg.bodyAge), error: l.error || undefined }; };
    return { maxine: { ...one('maxine'), weight: this.dbg.faceUsed ? +(this.range.ready ? this.settings.maxine.mix : 0.3 * this.settings.maxine.mix).toFixed(2) : 0, rangeSamples: this.range.samples },
      rtmw: { ...one('rtmw'), pointsReplaced: this.dbg.bodyPts }, sendFps: this.settings.fps, encodeMs: +this.dbg.encodeMs.toFixed(1) };
  }

  save() { try { globalThis.localStorage?.setItem(GPU_VISION_KEY, JSON.stringify(this.settings)); } catch { /* storage off */ } }
  set(patch: Partial<GpuVisionSettings>) {
    this.settings = { ...this.settings, ...patch };
    this.save();
    for (const f of ['maxine', 'rtmw'] as Feature[]) {
      const on = this.settings[f].on;
      if (!this.blocked) void fetch(`/api/gpu/${f}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on, why: 'studio setting' }) }).catch(() => {});
      if (!on) this.close(f);
    }
  }
  status(f: Feature) { const l = this.links[f]; return { on: this.settings[f].on, ready: l.ready, error: l.error, provider: l.provider, ms: l.ms, used: f === 'maxine' ? this.dbg.faceUsed : this.dbg.bodyUsed }; }

  private close(f: Feature) {
    const l = this.links[f];
    if (l.retry) { clearTimeout(l.retry); l.retry = null; }
    const ws = l.ws; l.ws = null; l.ready = false;
    if (ws) { try { ws.close(); } catch { /* ignore */ } }
    if (f === 'maxine') this.face = null; else this.body = null;
  }
  private open(f: Feature) {
    const l = this.links[f];
    if (l.ws || l.retry || this.blocked) return;
    let ws: WebSocket;
    try { ws = new WebSocket(`ws://127.0.0.1:${PORT[f]}/${f}`); } catch (e) { l.error = String(e); return; }
    ws.binaryType = 'arraybuffer';
    l.ws = ws;
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let d: { type: string; t?: number; ms?: number; face?: { w: number[]; conf: number } | null; kp?: number[][]; provider?: string; names?: string[]; error?: string };
      try { d = JSON.parse(e.data); } catch { return; }
      if (d.type === 'ready') { l.ready = true; l.error = ''; l.provider = d.provider ?? ''; l.names = d.names ?? []; }
      else if (d.type === 'error') l.error = d.error ?? 'error';
      else if (d.type === 'r' && typeof d.t === 'number') {
        l.ms = d.ms ?? 0; l.recv++; l.fpsN++; l.lastAt = performance.now();
        if (f === 'maxine') this.face = d.face ? { t: d.t, w: d.face.w, conf: d.face.conf } : null;
        else if (d.kp) this.body = { t: d.t, kp: d.kp };
      }
    };
    ws.onclose = (ev) => {
      if (l.ws !== ws) return;
      l.ws = null; l.ready = false;
      l.error = ev.code === 4000 ? 'another studio page took this sidecar (retrying)' : `${f} sidecar not running (retrying)`;
      // never give up while on (a stale page's socket can kick the live one with 4000, then die)
      if (this.settings[f].on) l.retry = setTimeout(() => { l.retry = null; this.open(f); }, ev.code === 4000 ? 15000 : 3000);
    };
  }

  /** Per tracking tick: send the current camera frame (capture time in ms, performance clock) when due. */
  tick(video: HTMLVideoElement, captureMs: number, now: number) {
    const on = (['maxine', 'rtmw'] as Feature[]).filter((f) => this.settings[f].on && (f !== 'rtmw' || this.bodyWanted));
    if (this.blocked || !on.length) return;
    for (const f of on) {
      const l = this.links[f];
      if (!l.ws) this.open(f);
      if (now - l.fpsT > 2000) { l.fps = l.fpsT ? (l.fpsN * 1000) / (now - l.fpsT) : 0; l.fpsN = 0; l.fpsT = now; }
      // watchdog: no results for 8 s -> ask the server to (re)start it (idempotent; covers a server restart / crash)
      if (now - l.lastAt > 8000 && now - l.ensureT > 8000) {
        l.ensureT = now;
        void fetch(`/api/gpu/${f}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true, why: 'studio watchdog' }) }).catch(() => {});
      }
    }
    const live = on.filter((f) => this.links[f].ready && this.links[f].ws?.readyState === 1);
    if (!live.length || this.busy || now - this.lastSend < 1000 / Math.max(5, this.settings.fps) - 2 || !video.videoWidth) return;
    this.lastSend = now; this.busy = true;
    const W = Math.min(this.settings.width, video.videoWidth), H = Math.round((W * video.videoHeight) / video.videoWidth);
    const t0 = performance.now();
    void (async () => {
      try {
        if (!this.canvas || this.canvas.width !== W || this.canvas.height !== H) {
          this.canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
        }
        const c = this.canvas;
        (c.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D).drawImage(video, 0, 0, W, H);
        const blob = 'convertToBlob' in c ? await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 }) : await new Promise<Blob>((r) => (c as HTMLCanvasElement).toBlob((b) => r(b!), 'image/jpeg', 0.85));
        const jpg = new Uint8Array(await blob.arrayBuffer());
        const msg = new Uint8Array(8 + jpg.length);
        new DataView(msg.buffer).setFloat64(0, captureMs, true);
        msg.set(jpg, 8);
        for (const f of live) { const ws = this.links[f].ws; if (ws && ws.readyState === 1 && ws.bufferedAmount < 2e6) ws.send(msg); }
        this.dbg.encodeMs = performance.now() - t0; this.dbg.sent++;
      } catch { /* a frame lost is fine */ } finally { this.busy = false; }
    })();
  }

  /** Fold the newest sidecar results into this MediaPipe result (in place; call before the solvers). */
  apply(raw: RawTracking) {
    this.dbg.faceUsed = false; this.dbg.bodyUsed = false;
    if (this.blocked) return;
    const cap = raw.capture ?? raw.t * 1000;
    const fr = this.face, cats = raw.face?.faceBlendshapes?.[0]?.categories;
    if (fr) this.dbg.faceAge = Math.abs(cap - fr.t);
    if (this.settings.maxine.on && fr && cats && Math.abs(cap - fr.t) <= this.maxAge && fr.conf > 0.2) {
      const names = this.links.maxine.names;
      const val = new Map<string, number>();
      names.forEach((n, i) => { const k = n === 'cheekPuffLeft' || n === 'cheekPuffRight' ? 'cheekPuff' : n; val.set(k, Math.max(val.get(k) ?? 0, fr.w[i] ?? 0)); });
      const idx = cats.map((c) => (val.has(c.categoryName) ? c.categoryName : null));
      const used = idx.filter((k): k is string => !!k);
      // learn the per-channel range mapping from this pair (each Maxine result paired once, with MediaPipe's own score)
      if (fr !== this.pairedFace) { this.pairedFace = fr; this.range.push(used.map((k) => val.get(k)!), cats.filter((_, i) => idx[i]).map((c) => c.score)); }
      const m = Math.min(1, Math.max(0, this.settings.maxine.mix)) * (this.range.ready ? 1 : 0.3);
      let j = 0;
      for (let i = 0; i < cats.length; i++) { const k = idx[i]; if (!k) continue; const v = this.range.apply(j++, val.get(k)!); cats[i].score = cats[i].score * (1 - m) + v * m; if (this.trackMapped) { const a = ARKIT_IX.get(k); if (a !== undefined) this.mapped[a] = v; } }
      if (this.trackMapped) this.mappedT = fr.t;
      this.dbg.faceUsed = true;
    }
    const b = this.body;
    if (b) this.dbg.bodyAge = Math.abs(cap - b.t);
    this.dbg.bodyPts = 0;
    if (this.settings.rtmw.on && b && Math.abs(cap - b.t) <= this.maxAge) {
      const pl = raw.pose?.landmarks?.[0];
      if (pl) for (const [c, p] of BODY_MAP) { const k = b.kp[c]; if (k && k[2] > 0.5 && pl[p]) { pl[p].x = k[0]; pl[p].y = k[1]; this.dbg.bodyPts++; } }
      // hands: refine the 2D landmarks of each hand MediaPipe found with the nearest confident RTMW hand
      const hl = raw.hands?.landmarks;
      if (hl) for (const hand of hl) {
        let best = -1, bd = 0.08;
        for (const base of [91, 112]) {
          const w = b.kp[base]; if (!w || w[2] < 0.5) continue;
          const d = Math.hypot(w[0] - hand[0].x, w[1] - hand[0].y);
          if (d < bd) { bd = d; best = base; }
        }
        if (best >= 0) for (let i = 0; i < 21 && i < hand.length; i++) { const k = b.kp[best + i]; if (k[2] > 0.5) { hand[i].x = k[0]; hand[i].y = k[1]; this.dbg.bodyPts++; } }
      }
      this.dbg.bodyUsed = this.dbg.bodyPts > 0;
    }
  }
}
