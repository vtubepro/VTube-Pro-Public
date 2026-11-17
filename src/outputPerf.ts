// OBS output performance: frame timing stats, an adaptive render scale, and the ?diag=1 overlay.
//
// Adaptive scale: OBS drives the page at the Browser Source's FPS; when the GPU can't keep up the page's frames
// come late / get skipped. The render scale only helps when the GPU is the bottleneck: fewer pixels cut GPU time,
// never the page's JS or draw submission. Every 2 s window (scaleVerdict below): overloaded = the GPU needing >90 %
// of the target frame (1000 / ?fps, default 60, GPU timer query) while the page runs below 90 % of that fps, or >15 %
// of frames late against the window's own vsync-like baseline (25th percentile) while the GPU takes a real share of
// the frame (>60 %) — or, in a browser without a GPU timer, late frames alone. The GPU only counts as the bottleneck
// when it needs clearly longer than the page took to SUBMIT the frame: on a busy CPU the timer query spans the
// submission (the GPU sits idle between commands), so a CPU-bound frame reads as "GPU time" too. A CPU-bound frame
// keeps its resolution. Two overloaded windows in a row → the render scale drops one step (×0.85, down to 0.6);
// after 10 s of clean windows it steps back up (never above a level that just failed, for a minute).
// ?dpr=<x> pins the scale, ?adaptive=0 turns it off.
// Avatar detail (src/avatar/lod/detailGovernor.ts): opts.firstResponder is asked first at the end of each window, under
// the same guard. 'took' (it drew an own avatar lighter): the bad count resets and the scale does not step. 'hold'
// (another lever acted < 4 s ago while Avatar detail is active): the window counts as usual, but the scale does not
// step on it. false: exactly as before.
import type { Stage } from './stage/Stage.ts';
import type { FrameSync } from './outputSync.ts';

const WINDOW_MS = 2000;
const MIN_SCALE = 0.6;
const STEP = 0.85;

/** One 2 s window's render-scale verdict (pure; tools/room_render_unit.ts). `gpu90` NaN = no GPU timer in this browser.
 *  `late` = share of late frames, `cpu90` = p90 page JS per frame (ms), `base` = vsync-like interval (ms), `fps` = frames
 *  per second this window, `targetFps` = the page's cap, `sub90` = p90 JS time spent submitting the timed render (ms;
 *  NaN = unknown). */
export function scaleVerdict(w: { late: number; cpu90: number; base: number; gpu90: number; fps: number; targetFps: number; sub90?: number }) {
  const target = 1000 / w.targetFps;
  const timer = Number.isFinite(w.gpu90);
  // the GPU is the bottleneck only when it needs clearly longer than the page took to hand it the frame
  const gpuOver = timer && !(Number.isFinite(w.sub90) && w.gpu90 <= (w.sub90 as number) * 1.2 + 0.5);
  const gpuBound = gpuOver && w.gpu90 > target * 0.9 && w.fps < w.targetFps * 0.9;
  // late frames only count against the resolution when the GPU takes a real share of the frame (or can't be measured)
  const overloaded = gpuBound || (w.late > 0.15 && (!timer || (gpuOver && w.gpu90 > target * 0.6)));
  // GPU timer: headroom at this scale (the page's JS is not the resolution's business); with late (CPU-bound) frames, a
  // step up must also stay under the overload line afterwards (one step = ×1/0.85² the pixels). No timer: as before.
  const clean = timer
    ? (w.late < 0.03 && w.gpu90 < target * 0.6) || w.gpu90 / (STEP * STEP) < target * 0.6
    : w.late < 0.03 && w.cpu90 < w.base * 0.5;
  return { gpuBound, overloaded, clean };
}

export interface PerfSnapshot {
  fps: number; frameMs: number; gpuMs: number; gpuP90: number; frameP95: number;
  /** p90 JS time of submitting the GPU-timed render (ms): a GPU time close to it = the timer measured the CPU. */
  submitP90: number; intervalP50: number; intervalP95: number; late: number;
  /** The longest gap between two frames of the window (ms). */
  intervalMax: number;
  busMs: number; busMax: number; busMin: number; framesPerSec: number; coalescedPerSec: number; dropped: number; substepsPerRender: number;
  scale: number; width: number; height: number; ratio: number; tier: string;
}

/** Avatar detail's answer for one window (opts.firstResponder). */
export type FirstResponse = 'took' | 'hold' | false;

const pct = (a: number[], p: number) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

export class OutputPerf {
  private intervals: number[] = [];
  private cpu: number[] = [];
  private lastAt = 0;
  private winStart = 0;
  private bad = 0;
  private good = 0;
  private ceiling = 1;
  private ceilingAt = 0;
  private upAt = -1e9;
  private el: HTMLDivElement | null = null;
  private prevStats = { received: 0, coalesced: 0, substeps: 0, renders: 0 };
  snapshot: PerfSnapshot | null = null;
  /** When the render scale last changed (performance.now ms): output.ts keeps its levers 4 s apart. */
  lastScaleChangeAt = -1e9;
  /** A starved page (src/stage/gfx/starve.ts): the render scale pinned at this (null = the adaptive scale as usual). */
  private pinned: number | null = null;
  /** Pin the render scale (starved page) or release it (null: back to full, the adaptive scale takes over again). */
  pin(scale: number | null) {
    if (scale === this.pinned) return;
    this.pinned = scale;
    if (this.opts.fixedScale !== null) return;            // (?dpr= pins it for good)
    this.setScale(scale ?? 1);
    this.bad = 0; this.good = 0;
  }
  get pinnedScale() { return this.pinned; }
  // GPU timer (EXT_disjoint_timer_query_webgl2): a few queries in flight, read back frames later
  private gl: WebGL2RenderingContext | null = null;
  private tq: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  private qFree: WebGLQuery[] = [];
  private qBusy: WebGLQuery[] = [];
  private qOpen: WebGLQuery | null = null;
  private gpu: number[] = [];
  /** JS time between gpuBegin and gpuEnd (the submission of the timed render), per frame. */
  private sub: number[] = [];
  private subAt = 0;

  constructor(private stage: Stage, private sync: () => FrameSync | null, private opts: { diag: boolean; adaptive: boolean; fixedScale: number | null; targetFps: number; scene?: () => string;
    /** Avatar detail: asked first. 'took' = it drew an avatar lighter (bad count reset, no scale step); 'hold' = the
     *  window counts but the scale does not step on it (lever hold-off); false = as before. `overloaded` = this page's
     *  own verdict on the window (the render scale would count it as bad). */
    firstResponder?: (snap: PerfSnapshot, now: number, overloaded: boolean) => FirstResponse;
    /** Avatar detail line for the ?diag=1 overlay (null = none). */
    avatarLine?: () => string | null }) {
    if (opts.fixedScale !== null) { stage.renderScale = opts.fixedScale; stage.resize(); }
    try {
      const gl = stage.renderer.getContext() as WebGL2RenderingContext;
      const ext = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
      if (ext) { this.gl = gl; this.tq = ext as never; for (let i = 0; i < 4; i++) { const q = gl.createQuery(); if (q) this.qFree.push(q); } }
    } catch { this.gl = null; }
    if (opts.diag) {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;left:8px;top:8px;z-index:10;padding:6px 9px;background:rgba(0,0,0,.72);color:#9ef;'
        + 'font:12px/1.45 ui-monospace,Consolas,monospace;white-space:pre;border-radius:6px;pointer-events:none';
      document.body.appendChild(el);
      this.el = el;
    }
  }

  /** Around stage.render(): GPU time of the frame (when the browser exposes a timer query). */
  gpuBegin() {
    const gl = this.gl;
    if (!gl || !this.tq) return;
    // collect finished queries (oldest first)
    while (this.qBusy.length) {
      const q = this.qBusy[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.qBusy.shift();
      const disjoint = gl.getParameter(this.tq.GPU_DISJOINT_EXT);
      if (!disjoint) this.gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      this.qFree.push(q);
    }
    const q = this.qFree.pop();
    if (!q) return;
    gl.beginQuery(this.tq.TIME_ELAPSED_EXT, q);
    this.qOpen = q;
    this.subAt = performance.now();
  }
  gpuEnd() {
    if (!this.gl || !this.tq || !this.qOpen) return;
    this.gl.endQuery(this.tq.TIME_ELAPSED_EXT);
    this.sub.push(performance.now() - this.subAt);
    this.qBusy.push(this.qOpen);
    this.qOpen = null;
  }

  /** After each rendered frame: its start time and the JS time it took (ms). */
  frame(now: number, cpuMs: number) {
    if (this.lastAt) this.intervals.push(now - this.lastAt);
    this.lastAt = now;
    this.cpu.push(cpuMs);
    if (!this.winStart) this.winStart = now;
    if (now - this.winStart >= WINDOW_MS) this.endWindow(now);
  }

  private endWindow(now: number) {
    const span = (now - this.winStart) / 1000;
    this.winStart = now;
    const iv = this.intervals, cpu = this.cpu, gpu = this.gpu, sub = this.sub;
    this.intervals = []; this.cpu = []; this.gpu = []; this.sub = [];
    const gpu90 = pct(gpu, 0.9);
    const base = pct(iv, 0.25);
    const late = iv.length ? iv.filter((x) => x > base * 1.6).length / iv.length : 0;
    const cpu90 = pct(cpu, 0.9);
    const st = this.sync()?.stats;
    const lat = this.sync()?.takeLatency();
    const d = st ? { received: st.received - this.prevStats.received, coalesced: st.coalesced - this.prevStats.coalesced, substeps: st.substeps - this.prevStats.substeps, renders: st.renders - this.prevStats.renders } : null;
    if (st) this.prevStats = { received: st.received, coalesced: st.coalesced, substeps: st.substeps, renders: st.renders };
    const buf = { w: this.stage.renderer.domElement.width, h: this.stage.renderer.domElement.height };
    this.snapshot = {
      gpuMs: gpu.length ? gpu.reduce((a, b) => a + b, 0) / gpu.length : NaN, gpuP90: gpu90, submitP90: pct(sub, 0.9),
      fps: iv.length / span, frameMs: cpu.reduce((a, b) => a + b, 0) / Math.max(1, cpu.length), frameP95: pct(cpu, 0.95),
      intervalP50: pct(iv, 0.5), intervalP95: pct(iv, 0.95), late, intervalMax: iv.length ? Math.max(...iv) : NaN,
      busMs: lat?.mean ?? NaN, busMax: lat?.max ?? NaN, busMin: lat?.min ?? NaN,
      framesPerSec: d ? d.received / span : 0, coalescedPerSec: d ? d.coalesced / span : 0, dropped: st?.dropped ?? 0,
      substepsPerRender: d && d.renders ? d.substeps / d.renders : 0,
      scale: this.stage.renderScale, width: buf.w, height: buf.h, ratio: this.stage.renderer.getPixelRatio(), tier: this.stage.tier,
    };
    // adaptive render scale (only while vsync-driven: a hidden / throttled page says nothing about the GPU)
    const vsync = this.opts.adaptive && this.opts.fixedScale === null && this.pinned === null && base > 0 && base < 70 && iv.length >= 10;
    // one verdict for this window (scaleVerdict): Avatar detail's first responder and the scale step see the same one
    const { overloaded, clean } = scaleVerdict({ late, cpu90, base, gpu90, fps: iv.length / span, targetFps: this.opts.targetFps, sub90: pct(sub, 0.9) });
    const fr: FirstResponse = vsync && this.opts.firstResponder ? this.opts.firstResponder(this.snapshot, now, overloaded) : false;
    if (fr === 'took') {
      this.bad = 0;   // avatar detail drew an avatar lighter on this window: no scale step
    } else if (vsync) {
      if (now - this.ceilingAt > 60000) this.ceiling = 1;
      this.bad = overloaded ? this.bad + 1 : 0;
      this.good = clean ? this.good + 1 : 0;
      const s = this.stage.renderScale;
      if (fr === 'hold') {
        // another lever acted < 4 s ago: the window counted, the step waits for the next window
      } else if (this.bad >= 2 && s > MIN_SCALE) {
        // a level that failed within 10 s of stepping up becomes the ceiling for a minute (no oscillation)
        if (now - this.upAt < 10000) { this.ceiling = s * STEP * 1.001; this.ceilingAt = now; }
        this.setScale(Math.max(MIN_SCALE, s * STEP));
        this.bad = 0;
      } else if (this.good >= 5 && s < Math.min(1, this.ceiling) - 1e-3) {
        this.setScale(Math.min(1, this.ceiling, s / STEP));
        this.upAt = now; this.good = 0;
      }
    }
    if (this.el) this.draw();
  }

  private setScale(s: number) { this.stage.renderScale = s; this.stage.resize(); this.lastScaleChangeAt = performance.now(); }

  private draw() {
    const p = this.snapshot!;
    const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '–');
    this.el!.textContent =
      `fps ${f(p.fps)}   frame ${f(p.frameMs, 2)} ms (p95 ${f(p.frameP95, 2)})   gpu ${f(p.gpuMs, 2)} ms (p90 ${f(p.gpuP90, 2)})   interval p50 ${f(p.intervalP50)} / p95 ${f(p.intervalP95)} ms   late ${f(p.late * 100, 0)}%\n`
      + `bus ${f(p.busMs, 2)} ms (min ${f(p.busMin, 2)}, max ${f(p.busMax, 1)})   frames ${f(p.framesPerSec, 0)}/s   coalesced ${f(p.coalescedPerSec, 0)}/s   dropped ${p.dropped}   substeps ${f(p.substepsPerRender, 2)}/render\n`
      + `render ${p.width}×${p.height}  pixel ratio ${f(p.ratio, 2)}  scale ${f(p.scale, 2)}${this.opts.fixedScale !== null ? ' (fixed)' : this.opts.adaptive ? ' (auto)' : ''}  tier ${p.tier}  dpr ${f(window.devicePixelRatio || 1, 2)}`
      + (this.opts.scene ? `\nscene ${this.opts.scene()}` : '')
      + ((): string => { const l = this.opts.avatarLine?.(); return l ? `\n${l}` : ''; })();
  }
}
