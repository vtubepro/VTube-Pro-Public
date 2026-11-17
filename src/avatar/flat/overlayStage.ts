// Draws a 2.5D overlay (shared/overlayStage.ts) around a 2D avatar shown "flat over the stream" (overlay.ts): the
// back layers go under the avatar's element in the overlay host, the front layers over it. Plain DOM (img / muted
// looping video / colour panels) moved with CSS transforms, so the compositor does the work and nothing is redrawn
// for the parallax; engine-drawn effects (fireflies, motes, embers, rain, snow, bubbles, fog, light rays) are small
// 2D canvases redrawn at 30 fps. Per frame: the performer's head (yaw / pitch / position) + a slow drift move a
// virtual viewer, every layer shifts by its depth (shared parallaxFactor: near layers a lot, far ones a little the
// other way, the performer's plane not at all) and plays its own life (sway, bob, flicker, pulse). DOM writes only
// when a value changed. Videos are always muted (an overlay never makes sound).
import {
  PARALLAX_PX, PARALLAX_Y, isOverlayVideo, layerBox, parallaxFactor, sanitizeOverlay, viewerOffset,
  type OverlayConfig, type OverlayFx, type OverlayLayer,
} from '../../../shared/overlayStage.ts';
import type { TrackingFrame } from '../../../shared/types.ts';

/** Where an overlay's files are served (VTube Pro's server). */
export const overlayUrl = (id: string, rel?: string) => `/api/overlays/${encodeURIComponent(id)}${rel === undefined ? '' : `/file/${rel.split('/').map(encodeURIComponent).join('/')}`}`;

const configs = new Map<string, Promise<OverlayConfig | null>>();
/** The overlay's config (cached per page; `fresh` reloads it, e.g. after the studio changed it). */
export function loadOverlayConfig(id: string, fresh = false): Promise<OverlayConfig | null> {
  if (fresh) configs.delete(id);
  let p = configs.get(id);
  if (!p) {
    p = fetch(overlayUrl(id), { cache: 'no-cache' }).then(async (r) => (r.ok ? sanitizeOverlay(await r.json()) : null)).catch(() => null);
    configs.set(id, p);
    void p.then((c) => { if (!c) configs.delete(id); });
  }
  return p;
}

const BLEND_CSS: Record<string, string> = { screen: 'screen', multiply: 'multiply', add: 'plus-lighter', overlay: 'overlay', 'soft-light': 'soft-light' };

interface LayerEl {
  l: OverlayLayer;
  el: HTMLDivElement;
  fx?: FxCanvas;
  video?: HTMLVideoElement;
  phase: number;
  box?: ReturnType<typeof layerBox>;
  key: string;
  factor: number;
  /** The layer's own rotation (OBS items) as CSS, about its centre whatever the transform origin is; '' = none. */
  turn: string;
}

/** Stages let go of in the last moments, by id: an avatar rebuild (a slider in the studio, OBS following a profile
 *  save) takes the same stage back instead of reloading every picture (no flicker). */
const pool = new Map<string, { stage: OverlayStage; timer: ReturnType<typeof setTimeout> }>();

/** A 2.5D overlay around one avatar element. Attach to a host, then call sync() every frame. */
export class OverlayStage {
  /** The stage for `id`: one released moments ago, or a new one. Give it back with release(). */
  static acquire(id: string): OverlayStage {
    const p = pool.get(id);
    if (p) { clearTimeout(p.timer); pool.delete(id); return p.stage; }
    return new OverlayStage(id);
  }
  /** Done with it: kept for a moment for the next acquire(id), then disposed. */
  release() {
    if (this.disposed) return;
    const old = pool.get(this.id);
    if (old && old.stage !== this) { clearTimeout(old.timer); old.stage.dispose(); }
    this.back.remove(); this.front.remove();
    pool.set(this.id, { stage: this, timer: setTimeout(() => { if (pool.get(this.id)?.stage === this) pool.delete(this.id); this.dispose(); }, 3000) });
  }
  config: OverlayConfig | null = null;
  readonly back: HTMLDivElement;
  readonly front: HTMLDivElement;
  private layers: LayerEl[] = [];
  private cam: [number, number] = [0, 0];
  private hostKey = '';
  private t = 0;
  private last = 0;
  private disposed = false;
  /** Filter for the performer's element (the overlay's light wash), '' = none. */
  avatarFilter = '';
  constructor(readonly id: string, onReady?: (c: OverlayConfig | null) => void) {
    const mk = (z: number | null, cls: string) => { const d = document.createElement('div'); d.className = cls; d.style.cssText = `position:absolute;inset:0;pointer-events:none;overflow:hidden;${z === null ? '' : `z-index:${z}`}`; return d; };
    this.back = mk(4, 'vtp-ov-back');
    // no z-index on the front box (no stacking context of its own): each front layer carries z-index 6 instead, so its
    // blend (Screen / Add / Multiply from OBS or a PSD) mixes with the performer and the back layers, as in OBS; the box
    // still clips them and keeps their order
    this.front = mk(null, 'vtp-ov-front');
    void loadOverlayConfig(id).then((c) => {
      if (this.disposed) return;
      this.config = c;
      if (c) this.build(c);
      else console.warn(`[overlay] "${id}" could not be loaded`);
      onReady?.(c);
    });
  }

  private build(c: OverlayConfig) {
    this.avatarFilter = c.light && c.light.strength > 0.01 ? lightFilter(c.light.color, c.light.strength) : '';
    let n = 0;
    for (const l of c.layers) {
      if (l.hidden) continue;
      const el = document.createElement('div');
      el.style.cssText = `position:absolute;left:0;top:0;width:0;height:0;will-change:transform;${l.side === 'front' ? 'z-index:6;' : ''}${l.opacity !== undefined && l.opacity < 1 ? `opacity:${l.opacity};` : ''}${l.blend ? `mix-blend-mode:${BLEND_CSS[l.blend] ?? 'normal'};` : ''}`;
      el.dataset.layer = l.id;
      const L: LayerEl = { l, el, phase: hash(l.id) * Math.PI * 2, key: '', factor: l.pin || l.fx ? 0 : parallaxFactor(l.depth), turn: '' };
      const fit = 'display:block;width:100%;height:100%;object-fit:fill;user-select:none;-webkit-user-drag:none;' + (l.flip ? 'transform:scaleX(-1);' : '');
      if (l.file && isOverlayVideo(l.file)) {
        const v = document.createElement('video');
        v.muted = true; v.defaultMuted = true; v.volume = 0; v.loop = true; v.autoplay = true; v.playsInline = true;
        v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.preload = 'auto';
        v.style.cssText = fit;
        v.src = overlayUrl(this.id, l.file);
        v.addEventListener('volumechange', () => { if (!v.muted) v.muted = true; });
        void v.play().catch(() => { /* autoplay of a muted video: allowed; retried on the next sync */ });
        el.append(v);
        L.video = v;
      } else if (l.file) {
        const img = document.createElement('img');
        img.decoding = 'async'; img.alt = ''; img.draggable = false;
        img.style.cssText = fit;
        img.src = overlayUrl(this.id, l.file);
        img.onerror = () => console.warn(`[overlay] ${l.file}: not found`);
        el.append(img);
      } else if (l.color) {
        el.style.background = l.color;
      } else if (l.fx) {
        L.fx = new FxCanvas(l.fx);
        el.append(L.fx.canvas);
      }
      (l.side === 'front' ? this.front : this.back).append(el);
      this.layers.push(L);
      n++;
    }
    this.hostKey = '';
    if (!n) console.warn(`[overlay] "${this.id}" has no visible layers`);
  }

  /** Put the stage around `avatarEl` in `host` (back under it, front over it). */
  attach(host: HTMLElement) {
    if (this.back.parentElement !== host) host.append(this.back);
    if (this.front.parentElement !== host) host.append(this.front);
  }

  /** Per frame: follow the host size, move the virtual viewer from the head, place and animate the layers. */
  sync(host: HTMLElement, frame?: TrackingFrame) {
    if (this.disposed) return;
    this.attach(host);
    const c = this.config;
    if (!c) return;
    const now = performance.now() / 1000;
    const dt = this.last ? Math.min(0.1, Math.max(0, now - this.last)) : 0;
    this.last = now;
    this.t += dt;
    const hw = host.clientWidth || innerWidth, hh = host.clientHeight || innerHeight;
    const hk = `${hw}x${hh}`;
    if (hk !== this.hostKey) {
      this.hostKey = hk;
      for (const L of this.layers) {
        L.box = layerBox(c, L.l, hw, hh);
        const b = L.box, s = L.el.style;
        s.left = `${b.left}px`; s.top = `${b.top}px`; s.width = `${b.width}px`; s.height = `${b.height}px`;
        const org = L.l.sway ? (L.l.pivot === 'top' ? '50% 0%' : '50% 100%') : b.origin;
        s.transformOrigin = org;
        // the importer placed a turned layer for a turn about its centre (shared planOverlayFromObs): keep it there
        // when the origin is an overscan edge or the sway pivot
        const o = org.split(' ').map((v) => parseFloat(v) / 100), dx = (0.5 - o[0]) * b.width, dy = (0.5 - o[1]) * b.height;
        L.turn = !L.l.rot ? '' : dx || dy ? ` translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px) rotate(${L.l.rot}deg) translate(${(-dx).toFixed(1)}px,${(-dy).toFixed(1)}px)` : ` rotate(${L.l.rot}deg)`;
        L.fx?.resize(b.width, b.height);
        L.key = '';
      }
    }
    // the virtual viewer: the head (tracked frames only) + drift, smoothed (about 0.25 s)
    const tracked = frame?.tracked !== false;
    const want = viewerOffset(tracked ? frame?.head : undefined, tracked ? frame?.headPos : undefined, c.drift, this.t);
    const k = 1 - Math.exp(-dt * 4);
    this.cam[0] += (want[0] - this.cam[0]) * k;
    this.cam[1] += (want[1] - this.cam[1]) * k;
    const px = PARALLAX_PX * hw * c.parallax;
    for (const L of this.layers) {
      const l = L.l, b = L.box;
      if (!b) continue;
      const tt = this.t + L.phase;
      const x = -this.cam[0] * px * L.factor, y = -this.cam[1] * px * PARALLAX_Y * L.factor;
      let t = `translate3d(${x.toFixed(1)}px,${(y + (l.bob ? Math.sin(tt * 0.55) * l.bob * 0.012 * b.height + Math.sin(tt * 1.3) * l.bob * 0.004 * b.height : 0)).toFixed(1)}px,0)`;
      if (b.over > 1.0001) t += ` scale(${b.over.toFixed(4)})`;
      t += L.turn;
      if (l.sway) t += ` rotate(${((Math.sin(tt * 0.8) * 0.7 + Math.sin(tt * 1.9) * 0.3) * l.sway * 1.6).toFixed(3)}deg)`;
      let op = l.opacity ?? 1;
      if (l.flicker) op *= 1 - l.flicker * 0.32 * flick(tt);
      if (l.pulse) op *= 1 - l.pulse * 0.35 * (0.5 + 0.5 * Math.sin(tt * 1.1));
      const key = `${t}|${op.toFixed(3)}`;
      if (key !== L.key) { L.key = key; L.el.style.transform = t; if (l.flicker || l.pulse) L.el.style.opacity = op.toFixed(3); }
      L.fx?.update(dt, this.cam, px);
      if (L.video && L.video.paused && !L.video.ended && L.video.readyState >= 2 && (Math.floor(this.t * 2) & 7) === 0) void L.video.play().catch(() => {});
    }
  }

  dispose() {
    this.disposed = true;
    for (const L of this.layers) {
      if (L.video) { L.video.pause(); L.video.removeAttribute('src'); L.video.load(); }
      for (const img of L.el.querySelectorAll('img')) img.removeAttribute('src');
      L.fx?.dispose();
    }
    this.layers = [];
    this.back.remove(); this.front.remove();
  }
}

/** A stable 0..1 from a string (layer phases). */
function hash(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return ((h >>> 0) % 10007) / 10007; }
/** Candle-like flicker 0..1. */
function flick(t: number): number { const v = Math.sin(t * 7.3) * 0.5 + Math.sin(t * 13.1 + 1.7) * 0.3 + Math.sin(t * 2.3) * 0.2; return Math.max(0, Math.min(1, 0.5 + 0.5 * v)); }

/** A CSS filter that sits the performer in the scene's light: as bright as the light colour (a night scene dims them a
 *  little) and a little less saturated the stronger it is. Never a hue shift: CSS can only rotate EVERY colour, which
 *  would turn a green character blue. */
export function lightFilter(hex: string, strength: number): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const s = Math.max(0, Math.min(1, strength));
  return `brightness(${(1 - s * 0.6 * (1 - lum)).toFixed(3)}) saturate(${(1 - s * 0.3).toFixed(3)})`;
}

// ---------------------------------------------------------------- engine-drawn effects
interface P { x: number; y: number; vx: number; vy: number; s: number; ph: number; z: number }
const FX_COUNT: Record<OverlayFx['kind'], [number, number]> = { fireflies: [6, 46], motes: [10, 90], embers: [8, 70], rain: [60, 420], snow: [30, 260], fog: [3, 7], rays: [2, 6], bubbles: [6, 40] };

/** One effect layer: a 2D canvas (device pixel ratio 1, at most the layer's size), redrawn at 30 fps. */
class FxCanvas {
  readonly canvas = document.createElement('canvas');
  private g: CanvasRenderingContext2D | null;
  private ps: P[] = [];
  private w = 1; private h = 1;
  private acc = 0; private t = 0;
  private sprite: HTMLCanvasElement | null = null;
  private rnd: () => number;
  constructor(private fx: OverlayFx) {
    this.canvas.style.cssText = 'display:block;width:100%;height:100%';
    this.g = this.canvas.getContext('2d');
    let s = ((fx.seed ?? 7) * 2654435761) >>> 0 || 1;
    this.rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    if (fx.kind === 'fireflies' || fx.kind === 'motes' || fx.kind === 'embers') this.sprite = glowSprite(fx.color, fx.kind === 'fireflies' ? 0.9 : 0.6);
  }
  resize(w: number, h: number) {
    // fog and rays are soft: drawn at half size and scaled up by CSS
    const q = this.fx.kind === 'fog' || this.fx.kind === 'rays' ? 0.5 : 1;
    this.w = Math.max(1, Math.round(Math.min(w, 2560) * q)); this.h = Math.max(1, Math.round(Math.min(h, 1440) * q));
    this.canvas.width = this.w; this.canvas.height = this.h;
    const [lo, hi] = FX_COUNT[this.fx.kind];
    const n = Math.round(lo + (hi - lo) * this.fx.amount);
    this.ps = Array.from({ length: n }, () => this.spawn(true));
    this.acc = 1;
  }
  private spawn(anywhere: boolean): P {
    const r = this.rnd, W = this.w, H = this.h, k = this.fx.kind, sz = this.fx.size ?? 1;
    const base = Math.min(W, H);
    const p: P = { x: r() * W, y: anywhere ? r() * H : 0, vx: 0, vy: 0, s: 1, ph: r() * 100, z: 0.4 + r() * 0.6 };
    if (k === 'rain') { p.y = anywhere ? r() * H : -r() * H * 0.2; p.s = (0.6 + r() * 0.8) * sz; }
    else if (k === 'snow') { p.y = anywhere ? r() * H : -10; p.s = (1 + r() * 2.5) * sz * base / 1080; }
    else if (k === 'embers') { p.y = anywhere ? r() * H : H + 10; p.s = (2 + r() * 3) * sz * base / 1080; }
    else if (k === 'bubbles') { p.y = anywhere ? r() * H : H + 20; p.s = (4 + r() * 10) * sz * base / 1080; }
    else if (k === 'fog') { p.s = (0.35 + r() * 0.4) * W * sz; p.y = H * (0.45 + r() * 0.5); p.vx = (r() < 0.5 ? -1 : 1) * (6 + r() * 10); }
    else if (k === 'rays') { p.x = W * (0.1 + r() * 0.8); p.s = (0.04 + r() * 0.08) * W * sz; }
    else p.s = (k === 'fireflies' ? 5 + r() * 6 : 2 + r() * 3) * sz * base / 1080;
    return p;
  }
  update(dt: number, _cam: [number, number], _px: number) {
    if (!this.g) return;
    this.acc += dt; this.t += dt;
    if (this.acc < 1 / 30) return;
    const step = Math.min(0.1, this.acc); this.acc = 0;
    const g = this.g, W = this.w, H = this.h, k = this.fx.kind, sp = this.fx.speed ?? 1, r = this.rnd, t = this.t;
    g.clearRect(0, 0, W, H);
    const scale = Math.min(W, H) / 1080;
    if (k === 'fireflies' || k === 'motes' || k === 'embers') {
      g.globalCompositeOperation = 'lighter';
      for (const p of this.ps) {
        // wander: a smooth random heading per particle
        const a = Math.sin(t * 0.31 + p.ph) * 2.1 + Math.sin(t * 0.13 + p.ph * 1.7) * 1.4;
        const v = (k === 'fireflies' ? 22 : k === 'embers' ? 14 : 9) * scale * sp;
        p.x += Math.cos(a) * v * step * p.z;
        p.y += (Math.sin(a) * v * 0.6 + (k === 'embers' ? -38 * scale * sp : k === 'motes' ? 2 * scale : 0)) * step * p.z;
        if (k === 'embers' && p.y < -20) Object.assign(p, this.spawn(false));
        if (p.x < -30) p.x = W + 20; else if (p.x > W + 30) p.x = -20;
        if (p.y < -30) p.y = H + 20; else if (p.y > H + 30) p.y = -20;
        const blink = k === 'fireflies' ? Math.pow(Math.max(0, Math.sin(t * (0.7 + p.z * 0.6) + p.ph)), 3) : k === 'embers' ? 0.6 + 0.4 * Math.sin(t * 9 + p.ph) : 0.35 + 0.35 * Math.sin(t * 0.9 + p.ph);
        if (blink < 0.02) continue;
        g.globalAlpha = Math.min(1, blink * p.z);
        const d = p.s * 6;
        if (this.sprite) g.drawImage(this.sprite, p.x - d / 2, p.y - d / 2, d, d);
      }
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    } else if (k === 'rain') {
      g.strokeStyle = this.fx.color; g.lineCap = 'round';
      const len = 26 * scale, slant = 0.18;
      g.beginPath();
      for (const p of this.ps) {
        p.y += (900 + 500 * p.z) * scale * sp * step; p.x += (900 + 500 * p.z) * scale * sp * step * slant;
        if (p.y > H + len) { p.y = -len - r() * 40; p.x = r() * (W + H * slant) - H * slant; }
        g.moveTo(p.x, p.y); g.lineTo(p.x - len * slant * p.s, p.y - len * p.s);
      }
      g.globalAlpha = 0.35 + 0.3 * this.fx.amount; g.lineWidth = Math.max(1, 1.4 * scale); g.stroke(); g.globalAlpha = 1;
    } else if (k === 'snow' || k === 'bubbles') {
      g.fillStyle = this.fx.color; g.strokeStyle = this.fx.color;
      for (const p of this.ps) {
        if (k === 'snow') { p.y += (40 + 50 * p.z) * scale * sp * step; p.x += Math.sin(t * 0.8 + p.ph) * 18 * scale * step; if (p.y > H + 10) Object.assign(p, this.spawn(false)); }
        else { p.y -= (30 + 40 * p.z) * scale * sp * step; p.x += Math.sin(t * 1.4 + p.ph) * 14 * scale * step; if (p.y < -30) Object.assign(p, this.spawn(false)); }
        g.globalAlpha = k === 'snow' ? 0.5 + 0.5 * p.z : 0.55;
        g.beginPath(); g.arc(p.x, p.y, p.s, 0, Math.PI * 2);
        if (k === 'snow') g.fill(); else { g.lineWidth = Math.max(1, p.s * 0.14); g.stroke(); g.globalAlpha = 0.5; g.beginPath(); g.arc(p.x - p.s * 0.35, p.y - p.s * 0.35, p.s * 0.22, 0, Math.PI * 2); g.fill(); }
      }
      g.globalAlpha = 1;
    } else if (k === 'fog') {
      for (const p of this.ps) {
        p.x += p.vx * sp * step * scale * 2;
        if (p.x - p.s > W) p.x = -p.s; else if (p.x + p.s < 0) p.x = W + p.s;
        const gr = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.s);
        const a = (0.18 + 0.3 * this.fx.amount) * (0.75 + 0.25 * Math.sin(t * 0.2 + p.ph));
        gr.addColorStop(0, rgba(this.fx.color, a)); gr.addColorStop(1, rgba(this.fx.color, 0));
        g.fillStyle = gr;
        g.save(); g.translate(p.x, p.y); g.scale(1, 0.38); g.translate(-p.x, -p.y);
        g.fillRect(p.x - p.s, p.y - p.s, p.s * 2, p.s * 2); g.restore();
      }
    } else if (k === 'rays') {
      g.globalCompositeOperation = 'lighter';
      for (const p of this.ps) {
        const a = (0.08 + 0.22 * this.fx.amount) * (0.55 + 0.45 * Math.sin(t * 0.25 * sp + p.ph));
        const top = p.x + Math.sin(t * 0.05 + p.ph) * W * 0.02, w = p.s;
        const gr = g.createLinearGradient(0, 0, 0, H);
        gr.addColorStop(0, rgba(this.fx.color, a)); gr.addColorStop(0.85, rgba(this.fx.color, 0));
        g.fillStyle = gr;
        g.beginPath(); g.moveTo(top - w * 0.5, 0); g.lineTo(top + w * 0.5, 0); g.lineTo(top + w * 2.2 + H * 0.35, H); g.lineTo(top - w * 0.2 + H * 0.35, H); g.closePath(); g.fill();
      }
      g.globalCompositeOperation = 'source-over';
    }
  }
  dispose() { this.ps = []; this.canvas.width = this.canvas.height = 0; if (this.sprite) this.sprite.width = this.sprite.height = 0; }
}
function rgba(hex: string, a: number) { return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${Math.max(0, Math.min(1, a)).toFixed(3)})`; }
/** A soft glow dot (drawn once, stamped per particle). */
function glowSprite(hex: string, core: number): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, `rgba(255,255,240,${core})`); gr.addColorStop(0.12, rgba(hex, 0.95)); gr.addColorStop(0.4, rgba(hex, 0.28)); gr.addColorStop(1, rgba(hex, 0));
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  }
  return c;
}
