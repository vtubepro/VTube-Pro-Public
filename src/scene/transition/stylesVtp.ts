// VTube Pro brand transitions (ship with the engine): "VTube Pro Light" and "VTube Pro Dark", in the studio UI's
// colours (src/ui/theme.ts tokens: green #7bd88f / #23904a, blue #6cc7f5 / #1678b8, dark #0e1015, light #eef0f4).
import { SANS, clamp01, easeInOut, easeOut, fitFont, rr, seg, thumbCard, vtpMark, type CurtainFrame, type CurtainStyleDef } from './kit.ts';

interface Pal {
  dark: boolean;
  bg0: string; bg1: string; dot: string; text: string; dim: string; accent: string; accent2: string; track: string;
  blobA: string; blobB: string; shadow: string; empty: string;
}
const LIGHT: Pal = { dark: false, bg0: '#ffffff', bg1: '#e9ecf2', dot: 'rgba(20,24,33,0.07)', text: '#141821', dim: '#525c6e', accent: '#23904a', accent2: '#1678b8', track: '#dfe3ea',
  blobA: 'rgba(35,144,74,0.13)', blobB: 'rgba(22,120,184,0.12)', shadow: 'rgba(20,30,50,0.22)', empty: '#e3e7ee' };
const DARK: Pal = { dark: true, bg0: '#12151c', bg1: '#0b0d12', dot: 'rgba(255,255,255,0.045)', text: '#eef1f6', dim: '#a3abba', accent: '#7bd88f', accent2: '#6cc7f5', track: '#262b37',
  blobA: 'rgba(123,216,143,0.14)', blobB: 'rgba(108,199,245,0.13)', shadow: 'rgba(0,0,0,0.6)', empty: '#1b1f28' };

/** Full-frame background (airtight) + drifting brand blobs + a dot grid. */
function background(f: CurtainFrame, P: Pal) {
  const { ctx, w, h, u, t } = f;
  const g = ctx.createLinearGradient(0, 0, w * 0.6, h * 1.2);
  g.addColorStop(0, P.bg0); g.addColorStop(1, P.bg1);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (const [c, x, y, r, sp] of [[P.blobA, 0.16, 0.2, 0.55, 0.13], [P.blobB, 0.86, 0.85, 0.6, 0.11], [P.blobA, 0.9, 0.12, 0.3, 0.17]] as [string, number, number, number, number][]) {
    const cx = w * (x + Math.sin(t * sp * 2 + x * 9) * 0.04), cy = h * (y + Math.cos(t * sp * 2 + y * 7) * 0.05), rad = h * r;
    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    rg.addColorStop(0, c); rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
  }
  ctx.fillStyle = P.dot;
  const step = 32 * u, r = 1.6 * u;
  for (let y = step / 2; y < h; y += step) for (let x = step / 2; x < w; x += step) { ctx.fillRect(x - r, y - r, r * 2, r * 2); }
}

function wrapTitle(ctx: CanvasRenderingContext2D, text: string, size: number, maxW: number): { lines: string[]; size: number } {
  ctx.font = `800 ${size}px ${SANS}`;
  if (ctx.measureText(text).width <= maxW) return { lines: [text], size };
  const words = text.split(/\s+/);
  for (let s = size * 0.86; s >= size * 0.5; s *= 0.94) {
    ctx.font = `800 ${s}px ${SANS}`;
    let best: string[] | null = null;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
      if (ctx.measureText(a).width <= maxW && ctx.measureText(b).width <= maxW) { best = [a, b]; break; }
    }
    if (best) return { lines: best, size: s };
  }
  return { lines: [text], size: fitFont(ctx, text, '800', size * 0.7, SANS, maxW) };
}

/** The held card: destination preview, "Next scene" + name, the loading bar, the mark. `a` = content alpha, `dx` = slide. */
function content(f: CurtainFrame, P: Pal, a: number, dx: number) {
  if (a <= 0.001) return;
  const { ctx, u, th, card, load, ready, t } = f;
  const X = (v: number) => v * u + dx, Y = (v: number) => v * u;
  const W = f.w / u, H = f.h / u;
  const ox = (W - 1920) / 2, oy = (H - 1080) / 2; // centre a 1920×1080 layout on any aspect
  ctx.save();
  ctx.globalAlpha = a;
  // preview
  const ti = easeOut(th / 0.55);
  const tx = ox + 150 - (1 - ti) * 40, ty = oy + 262, tw = 880, tht = 495;
  ctx.save();
  ctx.globalAlpha = a * clamp01(th / 0.4);
  ctx.shadowColor = P.shadow; ctx.shadowBlur = 60 * u; ctx.shadowOffsetY = 20 * u;
  rr(ctx, X(tx), Y(ty), tw * u, tht * u, 26 * u); ctx.fillStyle = P.empty; ctx.fill();
  ctx.restore();
  ctx.globalAlpha = a * clamp01(th / 0.4);
  const eg = ctx.createLinearGradient(X(tx), Y(ty), X(tx + tw), Y(ty + tht));
  eg.addColorStop(0, P.empty); eg.addColorStop(1, P.dark ? '#262c3a' : '#d5dae3');
  thumbCard(ctx, card.thumb, X(tx), Y(ty), tw * u, tht * u, 26 * u, eg);
  if (!card.thumb || !card.thumb.complete || !card.thumb.naturalWidth) vtpMark(ctx, X(tx + tw / 2 - 60), Y(ty + tht / 2 - 60), 120 * u, P.dark);
  // gradient rim
  const rim = ctx.createLinearGradient(X(tx), Y(ty), X(tx + tw), Y(ty + tht));
  rim.addColorStop(0, P.accent); rim.addColorStop(1, P.accent2);
  ctx.lineWidth = (P.dark ? 3 : 2.5) * u; ctx.strokeStyle = rim;
  if (P.dark) { ctx.shadowColor = P.accent2; ctx.shadowBlur = 24 * u; }
  rr(ctx, X(tx), Y(ty), tw * u, tht * u, 26 * u); ctx.stroke();
  ctx.shadowBlur = 0;
  // text column
  const cx = ox + 1110, ci = easeOut((th - 0.12) / 0.5);
  ctx.globalAlpha = a * clamp01((th - 0.1) / 0.35);
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  ctx.font = `700 ${26 * u}px ${SANS}`;
  if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = `${5 * u}px`;
  ctx.fillStyle = P.accent;
  ctx.fillText(card.title ? 'NEXT SCENE' : 'SWITCHING SCENES', X(cx + (1 - ci) * 30), Y(oy + 420));
  if ('letterSpacing' in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = '0px';
  const title = card.title || 'One moment…';
  const { lines, size } = wrapTitle(ctx, title, 86 * u, 660 * u);
  ctx.fillStyle = P.text;
  ctx.font = `800 ${size}px ${SANS}`;
  let y = oy + 420 + 26 + size / u * 0.98;
  for (const l of lines) { ctx.fillText(l, X(cx + (1 - ci) * 50), Y(y)); y += size / u * 1.08; }
  // loading bar
  const by = y - size / u * 1.08 + 58, bw = 560;
  rr(ctx, X(cx), Y(by), bw * u, 8 * u, 4 * u); ctx.fillStyle = P.track; ctx.fill();
  const fillW = Math.max(12, bw * load);
  const bg = ctx.createLinearGradient(X(cx), 0, X(cx + bw), 0);
  bg.addColorStop(0, P.accent); bg.addColorStop(1, P.accent2);
  ctx.save();
  if (P.dark) { ctx.shadowColor = P.accent; ctx.shadowBlur = 16 * u; }
  rr(ctx, X(cx), Y(by), fillW * u, 8 * u, 4 * u); ctx.fillStyle = bg; ctx.fill();
  ctx.restore();
  // shimmer on the bar while loading
  if (!ready) {
    const sx = cx + ((t * 0.9) % 1.4 - 0.2) * fillW;
    ctx.save(); rr(ctx, X(cx), Y(by), fillW * u, 8 * u, 4 * u); ctx.clip();
    const sg = ctx.createLinearGradient(X(sx - 60), 0, X(sx + 60), 0);
    sg.addColorStop(0, 'rgba(255,255,255,0)'); sg.addColorStop(0.5, 'rgba(255,255,255,0.55)'); sg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sg; ctx.fillRect(X(sx - 60), Y(by), 120 * u, 8 * u); ctx.restore();
  }
  ctx.font = `500 ${24 * u}px ${SANS}`;
  ctx.fillStyle = P.dim;
  const dots = ready ? '' : '.'.repeat(1 + (Math.floor(t * 2.5) % 3));
  ctx.fillText(ready ? 'Here we go' : `Setting the stage${dots}`, X(cx), Y(by + 50));
  // brand mark
  ctx.globalAlpha = a * clamp01((th - 0.2) / 0.4);
  vtpMark(ctx, X(ox + 150), Y(oy + 890), 58 * u, P.dark);
  ctx.font = `700 ${32 * u}px ${SANS}`;
  ctx.fillStyle = P.text;
  ctx.fillText('VTube', X(ox + 226), Y(oy + 931));
  const vw = ctx.measureText('VTube ').width;
  ctx.fillStyle = P.accent;
  ctx.fillText('Pro', X(ox + 226) + vw, Y(oy + 931));
  ctx.restore();
}

// ---------------------------------------------------------------- Light: a slanted panel sweep (blue, green, panel)
function sweepPoly(ctx: CanvasRenderingContext2D, w: number, h: number, edge: number, slant: number, keepRight: boolean) {
  // the edge line: x = edge + slant at the top, x = edge at the bottom ("/" lean)
  const big = w + slant * 2 + 10;
  ctx.beginPath();
  if (keepRight) { ctx.moveTo(edge + slant, -2); ctx.lineTo(big, -2); ctx.lineTo(big, h + 2); ctx.lineTo(edge, h + 2); }
  else { ctx.moveTo(-slant - 10, -2); ctx.lineTo(edge + slant, -2); ctx.lineTo(edge, h + 2); ctx.lineTo(-slant - 10, h + 2); }
  ctx.closePath();
}

function drawLight(f: CurtainFrame) {
  const { ctx, w, h, u, phase, p } = f;
  const slant = h * 0.24;
  const span = w + slant * 2;
  if (phase === 'hold') { background(f, LIGHT); content(f, LIGHT, 1, 0); return; }
  if (phase === 'in') {
    // blue sliver first, then green, then the panel; each sweeps right → left and keeps the right side covered
    const layers: [string, number, number][] = [[LIGHT.accent2, 0, 0.72], [LIGHT.accent, 0.1, 0.86], ['panel', 0.2, 1]];
    for (const [c, a, b] of layers) {
      const k = easeInOut(seg(p, a, b));
      const edge = w + 8 - k * (span + 8);
      ctx.save();
      sweepPoly(ctx, w, h, edge, slant, true);
      if (c === 'panel') { ctx.clip(); background(f, LIGHT); } else { ctx.fillStyle = c; ctx.fill(); }
      ctx.restore();
    }
    return;
  }
  // out: the panel keeps sweeping left, the green and blue edges trail it
  const layers: [string, number, number][] = [[LIGHT.accent2, 0.2, 1], [LIGHT.accent, 0.1, 0.9], ['panel', 0, 0.8]];
  for (const [c, a, b] of layers) {
    const k = easeInOut(seg(p, a, b));
    const edge = w + 8 - k * (span + 8);
    ctx.save();
    sweepPoly(ctx, w, h, edge, slant, false);
    if (c === 'panel') { ctx.clip(); background(f, LIGHT); content(f, LIGHT, 1 - seg(p, 0, 0.35), -k * span * 0.15); } else { ctx.fillStyle = c; ctx.fill(); }
    ctx.restore();
  }
  void u;
}

// ---------------------------------------------------------------- Dark: staggered blinds with glowing leading edges
const ROWS = 6;
function drawDark(f: CurtainFrame) {
  const { ctx, w, h, u, phase, p } = f;
  if (phase === 'hold') { background(f, DARK); content(f, DARK, 1, 0); return; }
  for (let i = 0; i < ROWS; i++) {
    const y0 = Math.floor((i * h) / ROWS) - 1, y1 = Math.ceil(((i + 1) * h) / ROWS) + 1;
    const fromRight = i % 2 === 0;
    const a = (phase === 'in' ? i : ROWS - 1 - i) * 0.055, k = easeInOut(seg(p, a, a + 1 - (ROWS - 1) * 0.055));
    // in: covered part grows from one side; out: it keeps travelling the same way and leaves
    let x0: number, x1: number, lead: number;
    if (phase === 'in') { if (fromRight) { x0 = w - k * w; x1 = w + 2; lead = x0; } else { x0 = -2; x1 = k * w; lead = x1; } }
    else { if (fromRight) { x0 = -2; x1 = w - k * w; lead = x1; } else { x0 = k * w; x1 = w + 2; lead = x0; } }
    if (x1 - x0 <= 0.5) continue;
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip();
    background(f, DARK);
    if (phase === 'out') content(f, DARK, 1 - seg(p, 0, 0.3), 0);
    ctx.restore();
    // glowing edge
    const edgeK = phase === 'in' ? 1 - k : k;
    if (edgeK > 0.001 && edgeK < 0.999) {
      ctx.save();
      ctx.fillStyle = i % 2 ? DARK.accent : DARK.accent2;
      ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 22 * u;
      ctx.fillRect(lead - 2 * u, y0 + 1, 4 * u, y1 - y0 - 2);
      ctx.restore();
    }
  }
}

export const VTP_STYLES: CurtainStyleDef[] = [
  { id: 'vtp-light', name: 'VTube Pro Light', theme: 'vtp', blurb: 'Clean white panel sweep with the green / blue brand edges', inMul: 1, outMul: 1.15, draw: drawLight },
  { id: 'vtp-dark', name: 'VTube Pro Dark', theme: 'vtp', blurb: 'Dark blinds with glowing brand-colour edges', inMul: 1, outMul: 1.15, draw: drawDark },
];
