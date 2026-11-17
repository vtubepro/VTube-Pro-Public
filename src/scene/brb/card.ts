// The Be Right Back card (shared/brb.ts): Canvas2D only, any size (OBS page full frame, the Live program monitor, the
// Privacy tab's previews). VTube Pro branding (T\portal\BRAND.md): the V mark (lime → sky gradient), Archivo-style bold
// display type, ink #06080a / fg #eef3ef in Dark, a near-white page with ink text in Light. Three looping styles.
import { brbText, type SceneBrbState } from '../../../shared/brb.ts';

const LIME = '#7bd88f', SKY = '#6cc7f5', LIME_HI = '#a6f5b4';
const THEMES = {
  dark: { bg0: '#0b0f12', bg1: '#06080a', fg: '#eef3ef', dim: '#9aa6a0', glowA: 'rgba(123,216,143,0.16)', glowB: 'rgba(108,199,245,0.12)' },
  light: { bg0: '#ffffff', bg1: '#eef2ef', fg: '#06080a', dim: '#4a544f', glowA: 'rgba(35,144,74,0.12)', glowB: 'rgba(108,199,245,0.16)' },
} as const;
const FONT = '"Archivo", "Geist", ui-sans-serif, system-ui, "Segoe UI", sans-serif';
/** BRAND.md mark path (viewBox 8 16 84 72) as points. */
const MARK: [number, number][] = [[12, 20], [30, 20], [46.6, 48], [46.6, 61], [60.5, 50.5], [54.3, 41.3], [67, 20], [88, 20], [50, 84]];

function mark(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number) {
  const k = size / 84, ox = cx - 50 * k, oy = cy - 52 * k;
  const g = ctx.createLinearGradient(ox + 22 * k, oy + 66 * k, ox + 80 * k, oy + 34 * k);
  g.addColorStop(0, '#8be39b'); g.addColorStop(0.3, LIME); g.addColorStop(0.7, SKY); g.addColorStop(1, '#7fd2ff');
  ctx.beginPath();
  MARK.forEach(([x, y], i) => (i ? ctx.lineTo(ox + x * k, oy + y * k) : ctx.moveTo(ox + x * k, oy + y * k)));
  ctx.closePath();
  ctx.fillStyle = g;
  ctx.fill();
}

/** A loaded picture / video frame behind the words (your own BRB screen; null = the theme's background). */
export interface BrbMedia { el: CanvasImageSource; w: number; h: number }
/** Your own BRB screen as a drawable (ready = has a frame). Images and videos only; videos are always muted. */
export function brbMediaOf(el: HTMLImageElement | HTMLVideoElement | null | undefined): BrbMedia | null {
  if (!el) return null;
  if (el instanceof HTMLImageElement) return el.complete && el.naturalWidth > 0 ? { el, w: el.naturalWidth, h: el.naturalHeight } : null;
  return el.readyState >= 2 && el.videoWidth > 0 ? { el, w: el.videoWidth, h: el.videoHeight } : null;
}

/** One frame of the card at `t` seconds (it loops by itself). */
export function drawBrbCard(ctx: CanvasRenderingContext2D, w: number, h: number, b: SceneBrbState, t: number, media: BrbMedia | null = null) {
  const th = THEMES[b.theme === 'light' ? 'light' : 'dark'];
  const u = Math.min(w / 1920, h / 1080);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.shadowBlur = 0;
  // page + two slow brand glows
  if (media) {
    // your own picture / video, filling the frame (cropped, never stretched), with a soft theme veil so the words read
    const k = Math.max(w / media.w, h / media.h), mw = media.w * k, mh = media.h * k;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(media.el, (w - mw) / 2, (h - mh) / 2, mw, mh);
    const v = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.6);
    v.addColorStop(0, b.theme === 'light' ? 'rgba(255,255,255,0.62)' : 'rgba(6,8,10,0.62)'); v.addColorStop(1, b.theme === 'light' ? 'rgba(255,255,255,0.25)' : 'rgba(6,8,10,0.3)');
    ctx.fillStyle = v; ctx.fillRect(0, 0, w, h);
  } else {
    const bg = ctx.createLinearGradient(0, 0, 0, h); bg.addColorStop(0, th.bg0); bg.addColorStop(1, th.bg1);
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    const glow = (x: number, y: number, r: number, c: string) => { const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, c); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); };
    glow(w * (0.3 + 0.05 * Math.sin(t * 0.4)), h * 0.35, 700 * u, th.glowA);
    glow(w * (0.72 + 0.05 * Math.cos(t * 0.33)), h * 0.68, 760 * u, th.glowB);
  }
  const cx = w / 2, cy = h / 2;
  const text = brbText(b);
  let fs = 150 * u;
  ctx.font = `800 ${fs}px ${FONT}`;
  const mw = ctx.measureText(text).width;
  if (mw > w * 0.84) { fs *= (w * 0.84) / mw; ctx.font = `800 ${fs}px ${FONT}`; }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const ty = cy + 30 * u;
  // the mark above the words
  const breath = 0.5 + 0.5 * Math.sin(t * 1.6);
  mark(ctx, cx, cy - 150 * u, (b.style === 'breathe' ? 92 + 6 * breath : 92) * u);
  if (b.style === 'sweep') {
    const span = w * 0.9, x = ((t * 0.35) % 1.6 - 0.3) * span + (w - span) / 2;
    const g = ctx.createLinearGradient(x - 260 * u, 0, x + 260 * u, 0);
    g.addColorStop(0, th.fg); g.addColorStop(0.42, b.theme === 'light' ? '#23904a' : LIME_HI); g.addColorStop(0.58, SKY); g.addColorStop(1, th.fg);
    ctx.fillStyle = g;
    ctx.fillText(text, cx, ty);
  } else if (b.style === 'dots') {
    ctx.fillStyle = th.fg;
    ctx.fillText(text, cx, ty);
    for (let i = 0; i < 3; i++) {
      const ph = t * 4.2 - i * 0.55, hop = Math.max(0, Math.sin(ph)) * 26 * u;
      ctx.beginPath();
      ctx.arc(cx + (i - 1) * 46 * u, ty + fs * 0.62 + 30 * u - hop, 12 * u, 0, Math.PI * 2);
      ctx.fillStyle = i === 1 ? SKY : LIME;
      ctx.fill();
    }
  } else {
    // breathe: the words glow in and out
    ctx.shadowColor = b.theme === 'light' ? 'rgba(35,144,74,0.35)' : 'rgba(123,216,143,0.55)';
    ctx.shadowBlur = (18 + 26 * breath) * u;
    ctx.globalAlpha = 0.82 + 0.18 * breath;
    ctx.fillStyle = th.fg;
    ctx.fillText(text, cx, ty);
    ctx.shadowBlur = 0; ctx.globalAlpha = 1;
  }
  // a hairline + the word mark, small, at the bottom
  ctx.fillStyle = th.dim;
  ctx.font = `600 ${28 * u}px ${FONT}`;
  ctx.fillText('VTube Pro', cx, h - 80 * u);
  ctx.restore();
}
