// Room-change transition layer for the OBS output page and the studio's Scene-tab preview (docs/SCENES.md →
// "Room-change transitions"). A full-frame 2D canvas over the 3D canvas:
//
//   cover(target, seq)  plays the style's cover-in and resolves once a FULLY OPAQUE frame has been presented — only
//                       then does the page tear the old room down (the audience never sees black / half a room).
//   loadDone(ok)        the new room is attached; the readiness pipeline starts: every asset load quiet (three.js
//                       loaders + asset fetches, src/scene/transition/assetWatch.ts) and no avatar still loading →
//                       textures uploaded + shaders compiled (renderer.compileAsync) → warm frames (≥ 8 rendered, the
//                       last intervals steady) → assets quiet again (engines load on their first update) → READY.
//   reveal              when ready + the minimum hold time, and — hold mode — once the host confirmed this change
//                       (SceneCurtainState.confirm ≥ the seq being covered). Safety caps: 25 s to get ready after the
//                       load, 3 min waiting for a confirm. The load itself has no cap while it is still moving (the room
//                       model's bytes or other assets arriving): it gives up - and aborts the download - only after 60 s
//                       without any progress.
//   failed              the room did not load (an error, or the load stalled): the cover STAYS with a plain line saying
//                       so - it never lifts onto an empty frame (an OBS source shows a transparent page as black). The
//                       host picking the same room again retries it (SceneCurtainState.retry); a load that still
//                       completes for this cover clears the failure and reveals the room.
//
// Timing is driven by requestAnimationFrame; a 100 ms timer keeps the phases moving when rAF is stalled (a hidden OBS
// source), so a room change never waits on a page nobody is looking at.
import * as THREE from 'three';
import { DEFAULT_CURTAIN, type CurtainStatus, type SceneCurtainState } from '../../../shared/curtain.ts';
import { abortRoomLoad, assetsPending, assetsQuietFor, installAssetWatch, roomProgress } from './assetWatch.ts';
import { resolveCurtainStyle, curtainStyle, curtainSide } from './styles.ts';
import type { CurtainCard, CurtainFrame, CurtainStyleDef } from './kit.ts';

export interface CurtainTarget { id: string | null; name: string; thumb: string | null }
type Phase = 'idle' | 'in' | 'hold' | 'out';

const READY_CAP = 25_000, LOAD_CAP = 60_000, CONFIRM_CAP = 180_000;
/** The stall rule: a load gives up only when it has been going a minute AND nothing arrived for a minute (neither the
 *  room model's bytes nor any other asset) - a slow but moving 125 MB download is never cut off. */
export const loadStalled = (sinceLoadMs: number, roomQuietMs: number, assetQuietMs: number) =>
  sinceLoadMs > LOAD_CAP && Math.min(roomQuietMs, assetQuietMs) > LOAD_CAP;
/** The plain line over a held cover: a big room's download, or that it did not load (null = none). */
export function coverNote(name: string, failed: boolean, loaded: boolean, bytes: { loaded: number; total: number }): string | null {
  const n = name || 'The room';
  if (failed) return `${n} didn't load. Pick it again, or another room.`;
  if (bytes.total > 20e6 && !loaded) return `Loading ${n}: ${Math.round(bytes.loaded / 1e6)} of ${Math.round(bytes.total / 1e6)} MB`;
  return null;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface CurtainOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: () => THREE.Camera;
  /** Something the page still waits for outside the loaders (an avatar mid-load …). */
  busy?: () => boolean;
  /** The page's render rate cap (steady-frame threshold). */
  targetFps?: number;
  /** Page id for the status reports. */
  page?: string;
}

export class Curtain {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  state: SceneCurtainState = { ...DEFAULT_CURTAIN };
  phase: Phase = 'idle';
  private style: CurtainStyleDef | null = null;
  private t0 = 0;
  private phaseAt = 0;
  private coveredAt = 0;
  private fullFrames = 0;
  private card: CurtainCard = { title: '', kicker: '', thumb: null };
  private target: CurtainTarget = { id: null, name: '', thumb: null };
  private seed = 1;
  /** The host change being covered (-1: a page load / a local test — no confirm needed). */
  private coverSeq = -1;
  private covered: Promise<void> | null = null;
  private resolveCovered: (() => void) | null = null;
  private loaded = false;
  private loadedAt = 0;
  private ready = false;
  private readyAt = 0;
  /** the room did not load: hold the cover with a line saying so (until the next change) */
  private failed = false;
  /** when the current load started (a held cover can take several loads) */
  private loadT0 = 0;
  private readyGen = 0;
  private warm = 0;
  private shown = 0;
  private frames = 0;
  private intervals: number[] = [];
  private lastFrame = 0;
  private lastDraw = 0;
  private lastTick = 0;
  private raf = 0;
  private timer = 0;
  private drawErr = false;
  private testing = false;
  private images = new Map<string, HTMLImageElement>();
  status: CurtainStatus;
  onStatus: ((s: CurtainStatus) => void) | null = null;
  /** Debug: how long each readiness stage of the last load took (ms). */
  timing: string[] = [];

  constructor(private opts: CurtainOptions) {
    installAssetWatch();
    const c = document.createElement('canvas');
    c.className = 'vtp-curtain';
    c.setAttribute('aria-hidden', 'true');
    c.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:50;display:none;background:transparent';
    document.body.append(c);
    this.canvas = c;
    this.ctx = c.getContext('2d', { alpha: true })!;
    this.status = { page: opts.page ?? '', phase: 'idle', seq: -1, room: null, style: '' };
  }

  get active() { return this.phase !== 'idle'; }
  /** Fully covered + warm: the page may skip drawing the 3D scene (nobody can see it). */
  get opaqueIdle() { return this.phase === 'hold' && this.ready; }

  setState(st: SceneCurtainState | undefined) {
    this.state = st ? { ...DEFAULT_CURTAIN, ...st } : { ...DEFAULT_CURTAIN };
  }

  /** Should a change prevId → nextId be covered? (`boot`: the page's first room.) */
  wants(prevId: string | null, nextId: string | null, boot = false): boolean {
    if (prevId === nextId) return false;
    if (boot && !this.state.boot) return false;
    return resolveCurtainStyle(this.state, this.state.seq) !== null;
  }

  /** Cover the frame (animated, or at once for a page load). Resolves when a fully opaque frame is on screen. */
  cover(target: CurtainTarget, seq: number, instant = false): Promise<void> {
    this.setTarget(target);
    // a room's own transition (scene.json curtain.in / .out): which side it came from (e.g. "UNDOCKING…" on the way out)
    this.card.side = this.testSide !== undefined ? this.testSide : seq >= 0 ? curtainSide(this.state, seq) : null;
    this.coverSeq = seq;
    // a new load under this cover
    this.loaded = false; this.ready = false; this.readyGen++; this.warm = 0; this.failed = false; this.loadT0 = performance.now();
    if (this.phase === 'hold') { this.shown = Math.min(this.shown, 0.15); this.report('loading'); return Promise.resolve(); }
    if (this.phase === 'in' && this.covered) return this.covered;
    const now = performance.now();
    let startP = 0;
    if (this.phase === 'out') {
      // covering again mid-reveal: continue from about as much cover as is showing
      startP = 1 - this.progress(now);
    } else {
      this.style = resolveCurtainStyle(this.state, seq < 0 ? this.state.seq : seq) ?? curtainStyle('vtp-dark');
      this.seed = ((seq + 7) * 2654435761) >>> 0 ^ this.style.id.length * 977;
      this.t0 = now; this.shown = 0;
      this.drawErr = false;
    }
    this.covered = new Promise<void>((r) => { this.resolveCovered = r; });
    this.fullFrames = 0;
    if (instant) { this.enter('hold', now); this.coveredAt = now; this.finishCover(); }
    else { this.enter('in', now - startP * this.inMs()); }
    this.start();
    this.report('covering');
    return this.covered;
  }

  /** The new room is attached (ok) or failed (the page shows Classic): start the readiness pipeline. */
  loadDone(ok: boolean) {
    if (!this.active) return;
    // (a load that completes after the cover gave up on it - this cover's own request: the failure clears, the room
    // warms up and is revealed; a late failure changes nothing)
    if (this.loaded && !(ok && this.failed)) return;
    this.failed = false;
    this.loaded = true; this.loadedAt = performance.now();
    this.report('warming', { loadMs: Math.round(this.loadedAt - this.t0) });
    if (!ok) { this.fail('failed'); return; }
    void this.runReady(++this.readyGen);
  }

  /** The switch was called off before the old room went (the host picked the old room again): reveal it. */
  cancel() {
    if (!this.active) return;
    const now = performance.now();
    this.readyGen++;
    this.loaded = true; this.ready = true; this.readyAt = now; this.coverSeq = -1;
    if (this.phase === 'in') { const p = this.progress(now); this.enter('out', now - (1 - p) * this.outMs()); this.finishCover(); }
    this.why = 'cancelled';
  }

  /** The page rendered a 3D frame (steady-frame detection). */
  frame(now: number) {
    if (this.lastFrame) { this.intervals.push(now - this.lastFrame); if (this.intervals.length > 8) this.intervals.shift(); }
    this.lastFrame = now;
    this.frames++;
  }

  /** Preview-only test: cover → a pretend 1.4 s load → reveal, with a style (default: the current one); `side` plays it as
   *  a room's own arrival ('in') / departure ('out') card. */
  test(target: CurtainTarget, style?: string, side?: 'in' | 'out' | null) {
    if (this.active) return;
    const keep = this.state;
    if (style) this.state = { ...keep, style: style === 'cut' ? 'vtp-dark' : style };
    this.testing = true;
    this.testSide = side ?? null;
    const covered = this.cover(target, -1);  // (the style is picked synchronously)
    this.testSide = undefined;
    this.state = keep;
    void covered.then(() => { setTimeout(() => this.loadDone(true), 1400); });
  }

  // ---------------------------------------------------------------- internals
  private why = '';
  private testSide: 'in' | 'out' | null | undefined = undefined;
  private inMs() { return Math.max(150, this.state.dur * (this.style?.inMul ?? 1) * 1000); }
  private outMs() { return Math.max(150, this.state.dur * (this.style?.outMul ?? 1.15) * 1000); }
  private progress(now: number) { return Math.min(1, Math.max(0, (now - this.phaseAt) / (this.phase === 'in' ? this.inMs() : this.outMs()))); }
  private enter(p: Phase, at: number) { this.phase = p; this.phaseAt = at; }
  private finishCover() { const r = this.resolveCovered; this.resolveCovered = null; this.covered = null; r?.(); }

  private setTarget(t: CurtainTarget) {
    this.target = t;
    this.card = { title: t.id ? t.name : '', kicker: '', thumb: null };
    if (!t.id) return;
    const key = t.id;
    let img = this.images.get(key);
    if (!img) {
      img = new Image();
      img.decoding = 'async';
      const fall = t.thumb;
      img.onerror = () => { if (fall && img!.src.indexOf(fall) < 0) img!.src = fall; };
      img.src = `/api/scenes/${encodeURIComponent(key)}/file/preview.png`;
      this.images.set(key, img);
    }
    this.card.thumb = img;
  }

  /** The room did not load: keep covering, say so on the cover (a reveal would show an empty, transparent frame). */
  private fail(why: string) {
    this.failed = true; this.why = why;
    this.report('failed', { loadMs: Math.round(performance.now() - this.t0), why });
  }
  /** the room did not load: the cover is held with a line saying so */
  get failedNow() { return this.failed; }

  private markReady(why: string) {
    if (this.ready) return;
    this.ready = true; this.readyAt = performance.now();
    this.why = why;
    this.report('ready', { readyMs: Math.round(this.readyAt - this.t0) });
  }

  private async runReady(gen: number) {
    const start = performance.now();
    const alive = () => gen === this.readyGen && this.active;
    const over = () => performance.now() - start > READY_CAP;
    const busy = () => { try { return !!this.opts.busy?.(); } catch { return false; } };
    const slow = Math.max(50, (1000 / Math.max(5, this.opts.targetFps ?? 60)) * 2.2);
    const tm: string[] = [];
    const mark = (what: string, since: number) => tm.push(`${what} ${Math.round(performance.now() - since)}`);
    this.timing = tm;
    for (let round = 0; round < 4 && alive() && !over(); round++) {
      // 1. every load quiet, nothing waiting
      let t = performance.now();
      while (alive() && !over() && (assetsPending() > 0 || assetsQuietFor() < 350 || busy())) await sleep(50);
      if (!alive()) return;
      mark(`r${round} quiet`, t);
      this.warm = Math.max(this.warm, 0.35);
      // 2. textures to the GPU + shaders compiled (behind the cover, not in the first visible frames)
      t = performance.now();
      this.uploadTextures();
      mark('upload', t);
      t = performance.now();
      try { await Promise.race([this.opts.renderer.compileAsync(this.opts.scene, this.opts.camera()), sleep(6000)]); } catch { /* optional */ }
      if (!alive()) return;
      mark('compile', t);
      this.warm = Math.max(this.warm, 0.7);
      // 3. warm frames: ≥ 8 rendered since, the last 4 intervals steady (or 2.5 s)
      const f0 = this.frames, t0 = performance.now();
      while (alive() && !over()) {
        const steady = this.intervals.length >= 4 && this.intervals.slice(-4).every((x) => x < slow);
        if ((this.frames - f0 >= 8 && steady) || performance.now() - t0 > 2500) break;
        await sleep(40);
      }
      if (!alive()) return;
      mark(`frames(${this.frames - f0}, last ${this.intervals.slice(-4).map((x) => Math.round(x)).join('/')})`, t0);
      this.warm = Math.max(this.warm, 0.95);
      // 4. engines start loading on their first updates: anything new since? → another round
      if (assetsPending() === 0 && assetsQuietFor() > 250 && !busy()) break;
    }
    if (alive()) this.markReady(over() ? 'timeout' : 'ready');
  }

  private uploadTextures() {
    const r = this.opts.renderer, seen = new Set<THREE.Texture>();
    try {
      this.opts.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (!m) return;
        for (const mat of Array.isArray(m) ? m : [m]) {
          for (const v of Object.values(mat as unknown as Record<string, unknown>)) {
            if (v instanceof THREE.Texture && !seen.has(v) && !(v instanceof THREE.VideoTexture)) { seen.add(v); try { r.initTexture(v); } catch { /* skip */ } }
          }
        }
      });
    } catch { /* optional */ }
  }

  private start() {
    this.canvas.style.display = '';
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
    if (!this.timer) this.timer = window.setInterval(() => {
      // rAF stalled (hidden source): keep the timeline moving without drawing
      if (performance.now() - this.lastTick > 300) this.step(performance.now(), false);
    }, 100);
  }

  private stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.timer) clearInterval(this.timer);
    this.timer = 0;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.canvas.style.display = 'none';
  }

  private tick = () => {
    this.raf = 0;
    if (this.phase === 'idle') return;
    this.raf = requestAnimationFrame(this.tick);
    this.lastTick = performance.now();
    this.step(this.lastTick, true);
  };

  private step(now: number, draw: boolean) {
    if (this.phase === 'in') {
      if (this.progress(now) >= 1) {
        // two frames at full cover have been drawn (presented) → covered; stalled rAF: the timer decides
        if (!draw || ++this.fullFrames >= 3) { this.enter('hold', now); this.coveredAt = now; this.finishCover(); }
      }
    } else if (this.phase === 'hold') {
      const confirmed = !this.state.hold || this.coverSeq < 0 || this.testing || this.state.confirm >= this.coverSeq;
      // (no cap while the room is still arriving: only a load without any progress for a minute - its download is aborted)
      if (!this.loaded && !this.failed && loadStalled(now - this.loadT0, roomProgress(now).quietMs, assetsQuietFor())) { this.loaded = true; this.loadedAt = now; abortRoomLoad(); this.fail('stalled'); }
      if (this.ready && now - this.coveredAt >= this.state.minHold * 1000 && now - this.readyAt >= 250) {
        if (confirmed) this.startOut(now, this.why === 'ready' && this.state.hold && this.coverSeq >= 0 ? 'confirmed' : this.why);
        else if (now - this.readyAt > CONFIRM_CAP) this.startOut(now, 'timeout');
      }
    } else if (this.phase === 'out') {
      if (this.progress(now) >= 1) {
        this.phase = 'idle';
        this.testing = false;
        this.stop();
        this.report('idle', { totalMs: Math.round(now - this.t0), why: this.why });
        return;
      }
    }
    if (!draw) return;
    // displayed loading progress: creeps while the GLB loads, then follows the warm-up stages
    const rp = roomProgress(now), bytes = rp.total > 0 ? Math.min(1, rp.loaded / rp.total) : -1;
    const target = this.ready ? 1 : this.loaded ? 0.5 + 0.45 * this.warm : bytes >= 0 ? 0.05 + 0.45 * bytes : 0.08 + 0.4 * (1 - Math.exp(-(now - this.t0) / 1800));
    const dt = Math.min(0.1, (now - (this.lastDraw || now)) / 1000);
    this.shown += (target - this.shown) * Math.min(1, dt * (this.ready ? 7 : 3));
    this.lastDraw = now;
    this.draw(now);
  }

  private startOut(now: number, why: string) {
    this.why = why;
    this.enter('out', now);
    this.report('revealing');
  }

  private draw(now: number) {
    const c = this.canvas, dpr = Math.min(3, window.devicePixelRatio || 1);
    const W = Math.max(2, Math.round((c.clientWidth || innerWidth) * dpr)), H = Math.max(2, Math.round((c.clientHeight || innerHeight) * dpr));
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.shadowBlur = 0;
    ctx.clearRect(0, 0, W, H);
    if (!this.style) return;
    const phase = this.phase === 'idle' ? 'out' : this.phase;
    const f: CurtainFrame = {
      ctx, w: W, h: H, u: Math.min(W / 1920, H / 1080), phase, p: phase === 'hold' ? 0 : this.progress(now),
      t: (now - this.t0) / 1000, th: this.phase === 'hold' ? (now - this.coveredAt) / 1000 : phase === 'out' ? 10 : 0,
      load: Math.min(1, Math.max(0, this.shown)), ready: this.ready, readyT: this.ready ? (now - this.readyAt) / 1000 : 0,
      card: this.card, seed: this.seed,
    };
    try {
      ctx.save();
      this.style.draw(f);
      ctx.restore();
      if (this.phase === 'hold') this.drawNote(f);
    } catch (e) {
      ctx.restore();
      if (!this.drawErr) { console.warn('curtain: style failed, plain cover', this.style.id, e); this.drawErr = true; }
      // never leave a hole mid-transition: plain dark cover during hold
      if (phase === 'hold' || (phase === 'in' && f.p >= 1)) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#0e1015'; ctx.fillRect(0, 0, W, H); }
    }
  }

  /** A plain line over any style while held: how much of a big room has arrived, or that it did not load. */
  /** the line shown over the held cover now (null = none) */
  noteText(now = performance.now()) { return this.phase === 'hold' ? coverNote(this.target.name, this.failed, this.loaded, roomProgress(now)) : null; }
  private drawNote(f: CurtainFrame) {
    const text = this.noteText();
    if (!text) return;
    const ctx = f.ctx, u = f.u;
    ctx.save();
    ctx.font = `600 ${Math.round(26 * u)}px Inter, system-ui, sans-serif`;
    const w = ctx.measureText(text).width + 40 * u, x = (f.w - w) / 2, y = f.h - 110 * u, hh = 52 * u;
    ctx.fillStyle = this.failed ? '#3a0d0dee' : '#0b0f16dd'; ctx.beginPath(); ctx.roundRect(x, y, w, hh, 12 * u); ctx.fill();
    ctx.fillStyle = '#f2f5fa'; ctx.textBaseline = 'middle'; ctx.fillText(text, x + 20 * u, y + hh / 2);
    ctx.restore();
  }

  private report(phase: CurtainStatus['phase'], extra: Partial<CurtainStatus> = {}) {
    this.status = { ...this.status, ...extra, page: this.opts.page ?? '', phase, seq: this.coverSeq, room: this.target.id, style: this.style?.id ?? '' };
    if (phase === 'covering') { delete this.status.loadMs; delete this.status.readyMs; delete this.status.totalMs; delete this.status.why; }
    try { this.onStatus?.(this.status); } catch { /* listener */ }
  }
}
