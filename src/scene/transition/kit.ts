// Transition style contract + small Canvas2D helpers (src/scene/transition/*).
//
// A style is ONE draw function over a full-frame 2D canvas (device pixels: 1920×1080, 2560×1440 … — everything is
// sized in `u` = one 1080p pixel, so it is crisp at any output size). Contract, per phase:
//   'in'   p 0 → 1  covering. At p = 1 the frame MUST be fully opaque (the old room is torn down right after).
//   'hold' covered  fully opaque, every frame (loading, the destination's card, the loading indicator).
//   'out'  p 0 → 1  revealing. p = 0 fully opaque; p = 1 nothing left (the page clears the canvas anyway).
// Anything not drawn stays transparent (OBS shows what is under the browser source), so partial covers during in /
// out are fine — only 'hold' has to be airtight. The page clears the canvas before every draw.

export type CurtainPhase = 'in' | 'hold' | 'out';

export interface CurtainCard {
  /** Destination room name ('' = Classic, the avatars-only layout). */
  title: string;
  /** Small line above the title ("Next scene" …; styles may use their own). */
  kicker: string;
  /** Destination preview image (scene preview.png / thumb.png), null while loading / none. */
  thumb: HTMLImageElement | null;
  /** Why this style plays (optional): 'in' = the destination room's scene.json curtain.in, 'out' = the room being left
   *  (its curtain.out — e.g. "UNDOCKING…"), null / missing = the host's own pick. */
  side?: 'in' | 'out' | null;
}

export interface CurtainFrame {
  ctx: CanvasRenderingContext2D;
  /** Canvas size in device pixels, and the 1080p unit. */
  w: number; h: number; u: number;
  phase: CurtainPhase;
  /** 0..1 progress through 'in' / 'out' (0 in 'hold'). */
  p: number;
  /** Seconds since the transition started / since the frame was fully covered (0 before). */
  t: number; th: number;
  /** Displayed loading progress 0..1 (smoothed; 1 = the room is ready). */
  load: number;
  ready: boolean;
  /** Seconds since the room became ready (0 while not ready). */
  readyT: number;
  card: CurtainCard;
  /** Per-transition random seed (the same on every page: from the host's change counter). */
  seed: number;
}

export interface CurtainStyleDef {
  id: string;
  name: string;
  /** 'vtp' = VTube Pro brand (ships with the engine), 'own' / 'guest' = a themed set of someone's own. */
  theme: 'vtp' | 'own' | 'guest';
  blurb: string;
  /** Cover-in / reveal durations as multiples of SceneCurtainState.dur. */
  inMul: number;
  outMul: number;
  draw(f: CurtainFrame): void;
}

// ---------------------------------------------------------------- math
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const easeOut = (t: number) => 1 - (1 - clamp01(t)) ** 3;
export const easeIn = (t: number) => clamp01(t) ** 3;
export const easeOutBack = (t: number, k = 1.7) => { const x = clamp01(t) - 1; return 1 + (k + 1) * x ** 3 + k * x ** 2; };
/** Part of a 0..1 timeline: 0 before a, 1 after b. */
export const seg = (p: number, a: number, b: number) => clamp01((p - a) / (b - a));
export function rng(seed: number) {
  let a = (seed >>> 0) || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------- drawing
export const SANS = `Inter, 'Segoe UI', system-ui, -apple-system, sans-serif`;
export const SCRIPT = `'Segoe Script', 'Brush Script MT', 'Lucida Handwriting', cursive`;
export const BLOCK = `Impact, 'Arial Black', 'Segoe UI Black', sans-serif`;

export function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const q = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + q, y); ctx.arcTo(x + w, y, x + w, y + h, q); ctx.arcTo(x + w, y + h, x, y + h, q);
  ctx.arcTo(x, y + h, x, y, q); ctx.arcTo(x, y, x + w, y, q); ctx.closePath();
}

/** Set a font, shrinking it until `text` fits in maxW. Returns the size used. */
export function fitFont(ctx: CanvasRenderingContext2D, text: string, weight: string, size: number, family: string, maxW: number, min = size * 0.45) {
  let s = size;
  for (;;) {
    ctx.font = `${weight} ${s}px ${family}`;
    if (ctx.measureText(text).width <= maxW || s <= min) return s;
    s = Math.max(min, s * 0.92);
  }
}

/** Image "object-fit: cover" into a (clipped) box. */
export function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number) {
  const iw = img.naturalWidth || 16, ih = img.naturalHeight || 9;
  const s = Math.max(w / iw, h / ih), dw = iw * s, dh = ih * s;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

/** The destination's preview in a rounded frame (a soft placeholder while the image loads / for Classic). */
export function thumbCard(ctx: CanvasRenderingContext2D, img: HTMLImageElement | null, x: number, y: number, w: number, h: number, r: number, empty: string | CanvasGradient) {
  ctx.save();
  rr(ctx, x, y, w, h, r);
  ctx.clip();
  ctx.fillStyle = empty;
  ctx.fillRect(x, y, w, h);
  if (img && img.complete && img.naturalWidth) drawCover(ctx, img, x, y, w, h);
  ctx.restore();
}

/** Text with a glow (neon tubes / soft light): a few blurred passes, then the core. */
export function glowText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, glow: string, core: string, blur: number, on = 1) {
  ctx.save();
  const a0 = ctx.globalAlpha;  // (the caller's fade)
  if (on > 0.02) {
    ctx.shadowColor = glow;
    ctx.fillStyle = glow;
    ctx.globalAlpha = a0 * 0.55 * on; ctx.shadowBlur = blur * 2.2; ctx.fillText(text, x, y);
    ctx.globalAlpha = a0 * 0.85 * on; ctx.shadowBlur = blur; ctx.fillText(text, x, y);
  }
  ctx.shadowBlur = 0; ctx.globalAlpha = a0;
  ctx.fillStyle = core;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/** The VTube Pro mark: the studio's frog in a green → blue rounded tile (the top-bar logo), drawn as vectors. */
export function vtpMark(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, dark: boolean) {
  ctx.save();
  const g = ctx.createLinearGradient(x, y, x + s, y + s);
  g.addColorStop(0, dark ? '#7bd88f' : '#23904a'); g.addColorStop(1, dark ? '#6cc7f5' : '#1678b8');
  rr(ctx, x, y, s, s, s * 0.3); ctx.fillStyle = g; ctx.fill();
  // frog face
  const cx = x + s / 2, cy = y + s * 0.6;
  ctx.fillStyle = dark ? '#0e1015' : '#ffffff';
  ctx.beginPath(); ctx.ellipse(cx, cy, s * 0.33, s * 0.22, 0, 0, Math.PI * 2); ctx.fill();
  for (const sx of [-1, 1]) { ctx.beginPath(); ctx.arc(cx + sx * s * 0.17, cy - s * 0.2, s * 0.11, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = dark ? '#7bd88f' : '#23904a';
  for (const sx of [-1, 1]) { ctx.beginPath(); ctx.arc(cx + sx * s * 0.17, cy - s * 0.2, s * 0.05, 0, Math.PI * 2); ctx.fill(); }
  ctx.strokeStyle = dark ? '#7bd88f' : '#23904a'; ctx.lineWidth = s * 0.045; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(cx, cy - s * 0.02, s * 0.15, 0.2 * Math.PI, 0.8 * Math.PI); ctx.stroke();
  ctx.restore();
}

/** Bubbles: deterministic per seed, rising with a wobble; `k` fades them. */
export function bubbles(ctx: CanvasRenderingContext2D, w: number, h: number, u: number, t: number, seed: number, n: number, color: string, k = 1, rMin = 4, rMax = 22) {
  const r = rng(seed);
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color;
  for (let i = 0; i < n; i++) {
    const x0 = r() * w, sp = (60 + r() * 140) * u, rad = (rMin + r() * (rMax - rMin)) * u, ph = r() * 10, off = r();
    const y = h + rad - (((t * sp) / (h + rad * 2) + off) % 1) * (h + rad * 3);
    const x = x0 + Math.sin(t * 2 + ph) * 10 * u;
    ctx.globalAlpha = 0.5 * k;
    ctx.lineWidth = Math.max(1, rad * 0.14);
    ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 0.35 * k;
    ctx.beginPath(); ctx.arc(x - rad * 0.35, y - rad * 0.35, rad * 0.22, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
