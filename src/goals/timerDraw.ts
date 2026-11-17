// Paints the in-room timer display's picture (beta.14; the state comes from shared/timerDisplay.ts timerFace): a dark glass
// panel centred on the surface with the big H:MM:SS digits, a corner caption + badges (paused / test / happy hour / hype /
// sleep) on top and the small line or the "+10:00" pop underneath. Three looks: 'digits' (clean glowing numerals), 'neon'
// (tube outlines) and 'lcd' (seven segments with the unlit ones ghosted). Fonts / colours / pills are goalsDraw.ts's.
// Never animates by itself: it is called when the picture changes (about once a second); the pop is eased by the caller's
// steps (no strobe: nothing here pulses, the "last minutes" warm colour is a steady colour).
import { TIMER_FIT_MAX, TIMER_FIT_MIN, TIMER_GLASS_DEFAULT, TIMER_GLASS_MAX, TIMER_GLASS_MIN, type TimerFace, type TimerStyle } from '../../shared/timerDisplay.ts';
import { alpha, FONT, MONO, rr } from './goalsDraw.ts';

export interface TimerPaint {
  style: TimerStyle;
  /** the digits' colour ('#rrggbb') */
  color: string;
  /** the "time!" / happy hour gold */
  hero: string;
  ink: string;
  /** the panel + digits scale about the surface centre (TIMER_FIT_MIN..1, default 1: see panelRect) */
  fit?: number;
  /** the panel's opacity (TIMER_GLASS_MIN..1, default TIMER_GLASS_DEFAULT) */
  glass?: number;
}
export const DEFAULT_TIMER_PAINT: TimerPaint = { style: 'digits', color: '#35e3ff', hero: '#ffd166', ink: '#eef6ff' };

const BADGE: Record<string, string> = { paused: '#9aa4b8', ended: '', test: '#ff4d4d', happy: '', hype: '#ff5fa2', sleep: '#8fa8ff' };
const POP_GREEN = '#7dff8a', POP_RED = '#ff6b6b', WARM = '#ff7aa8', PAUSED = '#c9cfdd';
/** a=1 b=2 c=4 d=8 e=16 f=32 g=64 (top, top right, bottom right, bottom, bottom left, top left, middle) */
const SEG: Record<string, number> = { '0': 63, '1': 6, '2': 91, '3': 79, '4': 102, '5': 109, '6': 125, '7': 7, '8': 127, '9': 111 };
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

/**
 * The panel rect for a canvas: a strip across a squarish surface (a dome, a medallion), nearly the whole of a wide screen.
 * `fit` (a display's own setting, TIMER_FIT_MIN..1) shrinks it about the canvas centre: the rows and the digits are laid out inside it,
 * so they shrink with it. A halo quad wider than the glowing thing behind it uses < 1 so the clock sits inside that thing.
 */
export function panelRect(W: number, H: number, fit = 1): { x: number; y: number; w: number; h: number } {
  const sa = W / H, pa = clamp(sa, 2.3, 3.9), squarish = sa < 1.6;
  const k = clamp(Number.isFinite(fit) ? fit : 1, TIMER_FIT_MIN, TIMER_FIT_MAX);
  const w = Math.min(W * (squarish ? 0.7 : 0.97), H * (squarish ? 0.9 : 0.94) * pa) * k, h = w / pa;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

/** The rows inside the panel: caption + badges on top, the digit zone in the middle, the small line / the pop underneath (centre lines for text anchored on 'middle'). */
export function timerRows(W: number, H: number, fit = 1) {
  const { x: px, y: py, w: pw, h: ph } = panelRect(W, H, fit);
  const pad = ph * 0.07, rowT = ph * 0.15, rowB = ph * 0.16;
  const zoneY = py + pad + rowT, zoneH = ph - pad * 2 - rowT - rowB;
  return { px, py, pw, ph, pad, rowT, rowB, ix: px + pad, iw: pw - pad * 2, topY: py + pad + rowT / 2, botY: py + ph - pad - rowB / 2, zoneY, zoneH, cy: zoneY + zoneH / 2 };
}

/** The digit cells for `main` ("47:59:12"): fixed cells (the seconds never make the layout jiggle), a colon is half a cell. `frame` = the cells reserved (at least 7). */
export function digitCells(W: number, H: number, main: string, lcd: boolean, fit = 1) {
  const { iw, zoneH } = timerRows(W, H, fit);
  const nd = main.split('').filter((c) => c !== ':').length, nc = main.length - nd;
  const units = nd + 0.5 * nc;
  const frame = Math.max(7, units);
  const digH = zoneH * 0.94;
  const digW = Math.min(iw / frame, digH * (lcd ? 0.58 : 0.83));
  return { units, frame, digH, digW, totalW: units * digW };
}

/**
 * What a picture covers of a surface `sizeM` metres across (drawn on a W × H canvas): the glass panel and the digit run, in metres
 * (width, height). The numbers a room author checks against the thing the clock sits in (a dome's width), and what the tests pin.
 */
export function timerFootprint(sizeM: readonly [number, number], W: number, H: number, main: string, lcd: boolean, fit = 1) {
  const r = panelRect(W, H, fit), c = digitCells(W, H, main, lcd, fit);
  const mx = sizeM[0] / W, my = sizeM[1] / H;
  return { panel: [r.w * mx, r.h * my] as [number, number], digits: [c.totalW * mx, c.digH * my] as [number, number] };
}

/** One seven-segment digit in the box (x, y, w, h): lit segments glow in `col`, unlit ones are a ghost. */
function sevenSeg(g: CanvasRenderingContext2D, ch: string, x: number, y: number, w: number, h: number, col: string, glow: number) {
  const mask = ch === ' ' ? 0 : SEG[ch] ?? 0;
  const t = w * 0.17, gap = t * 0.16, half = t / 2;
  const L = x + half, R = x + w - half, T = y + half, B = y + h - half, M = y + h / 2;
  const horiz = (cy: number): [number, number][] => [[L + gap + half, cy], [L + gap + t, cy - half], [R - gap - t, cy - half], [R - gap - half, cy], [R - gap - t, cy + half], [L + gap + t, cy + half]];
  const vert = (cx: number, y0: number, y1: number): [number, number][] => [[cx, y0 + gap + half], [cx + half, y0 + gap + t], [cx + half, y1 - gap - t], [cx, y1 - gap - half], [cx - half, y1 - gap - t], [cx - half, y0 + gap + t]];
  const segs: [number, [number, number][]][] = [
    [1, horiz(T)], [2, vert(R, T, M)], [4, vert(R, M, B)], [8, horiz(B)], [16, vert(L, M, B)], [32, vert(L, T, M)], [64, horiz(M)],
  ];
  for (const lit of [false, true]) {
    g.save();
    if (lit) { g.shadowColor = alpha(col, 0.9); g.shadowBlur = glow; }
    g.fillStyle = lit ? col : alpha(col, 0.09);
    for (const [bit, pts] of segs) {
      if (!!(mask & bit) !== lit) continue;
      g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.closePath(); g.fill();
    }
    g.restore();
  }
}

/** Paint `f` on the whole canvas (W × H). Transparent outside the panel: the room's own surface shows around it. */
export function drawTimerFace(g: CanvasRenderingContext2D, W: number, H: number, f: TimerFace, p: TimerPaint) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, W, H);
  g.save();
  const { px, py, pw, ph, rowT, rowB, topY, botY, cy, ix, iw } = timerRows(W, H, p.fit ?? 1);
  const col = f.state === 'ended' ? p.hero : f.state === 'paused' ? PAUSED : f.urgent ? WARM : p.color;
  const lcd = p.style === 'lcd';
  // ---- the glass
  const r = ph * 0.1;
  rr(g, px, py, pw, ph, r);
  // the glass: TIMER_GLASS_DEFAULT opacity unless the display asks for more of the surface to show through (the LCD look scales its own alphas with it)
  const ga = clamp(p.glass ?? TIMER_GLASS_DEFAULT, TIMER_GLASS_MIN, TIMER_GLASS_MAX), gk = ga / TIMER_GLASS_DEFAULT;
  const bg = g.createLinearGradient(px, py, px, py + ph);
  bg.addColorStop(0, lcd ? alpha(p.color, Math.min(1, 0.2 * gk)) : `rgba(6,10,14,${ga})`); bg.addColorStop(1, lcd ? alpha(p.color, Math.min(1, 0.12 * gk)) : `rgba(2,5,8,${ga})`);
  g.fillStyle = bg; g.fill();
  if (lcd) { rr(g, px, py, pw, ph, r); g.fillStyle = `rgba(2,6,6,${Math.min(1, 0.82 * gk)})`; g.fill(); }
  g.shadowColor = alpha(p.color, 0.55); g.shadowBlur = ph * 0.07;
  rr(g, px, py, pw, ph, r); g.lineWidth = Math.max(2, ph * 0.02); g.strokeStyle = alpha(p.color, 0.85); g.stroke();
  g.shadowBlur = 0;
  // ---- rows: caption + badges / digits / the small line or the pop
  g.textBaseline = 'middle';
  // badges (right) and the caption (left)
  let cx = ix + iw;
  const chipPx = Math.round(rowT * 0.6), chipH = rowT * 0.86;
  g.font = `900 ${chipPx}px ${FONT}`; g.textAlign = 'left';
  let capW = 0;
  if (f.label) { g.font = `800 ${Math.round(rowT * 0.62)}px ${FONT}`; capW = Math.min(iw * 0.4, g.measureText(f.label).width); }
  g.font = `900 ${chipPx}px ${FONT}`;
  for (const b of f.badges) {
    const tw = g.measureText(b.text).width, cw = tw + chipH * 0.9;
    if (cx - cw < ix + capW + (capW ? chipH * 0.6 : 0)) break;
    rr(g, cx - cw, topY - chipH / 2, cw, chipH, chipH / 2);
    g.fillStyle = b.kind === 'ended' || b.kind === 'happy' ? p.hero : BADGE[b.kind] || p.hero; g.fill();
    g.fillStyle = '#0a0716'; g.textAlign = 'left'; g.fillText(b.text, cx - cw + chipH * 0.45, topY + 1);
    cx -= cw + chipH * 0.35;
  }
  if (f.label) {
    g.font = `800 ${Math.round(rowT * 0.62)}px ${FONT}`; g.textAlign = 'left'; g.fillStyle = alpha(p.ink, 0.82);
    let s = f.label; while (s.length > 1 && g.measureText(s).width > capW) s = s.slice(0, -1);
    g.fillText(s, ix, topY + 1);
  }
  // ---- the digits: fixed cells (the seconds never make the layout jiggle), a colon is half a cell
  const chars = f.main.split('');
  const { units, frame, digH, digW } = digitCells(W, H, f.main, lcd, p.fit ?? 1);
  const em = digW / 0.6;        // (a digit is ≈ 0.6 em wide in the heavy numeral fonts)
  const totalW = units * digW;
  // text styles centre the string; the LCD keeps the cells fixed (right-aligned, an unlit ghost 8 in an unused hour digit)
  let x = lcd ? px + pw / 2 + (frame * digW) / 2 - totalW : px + pw / 2 - totalW / 2;
  const glow = digH * 0.3;
  g.textAlign = 'center';
  if (lcd) {
    let gx = px + pw / 2 - (frame * digW) / 2;
    for (let i = 0; i < Math.round(frame - units); i++) { sevenSeg(g, ' ', gx, cy - digH / 2, digW * 0.88, digH, col, 0); gx += digW; }
    if (f.state === 'paused') g.globalAlpha = 0.82;
    for (const c of chars) {
      if (c === ':') {
        const dw = digW * 0.5, dot = digW * 0.085;
        g.save(); g.shadowColor = alpha(col, 0.9); g.shadowBlur = glow; g.fillStyle = col;
        for (const dy of [-0.2, 0.2]) { g.beginPath(); g.rect(x + dw / 2 - dot, cy + dy * digH - dot, dot * 2, dot * 2); g.fill(); }
        g.restore();
        x += dw;
      } else { sevenSeg(g, c, x, cy - digH / 2, digW * 0.88, digH, col, glow); x += digW; }
    }
    g.globalAlpha = 1;
  } else {
    g.font = `900 ${Math.round(em)}px ${MONO}`;
    // The numerals sit on an ALPHABETIC baseline: the rows around them anchor on 'middle' (the text's own centre, which for these heavy faces
    // is a font-dependent 0.06-0.41 em off the digits' ink centre), so a 'middle' anchor shifted by a fixed fraction of an em lands the clock
    // on the next row. The ink box of a '0' in this very font is measured and centred on the digit zone; 0.36 em (a numeral's cap height / 2)
    // is the fallback for a canvas without ink metrics. Everything after the digits gets 'middle' back.
    const rowBase = g.textBaseline;
    g.textBaseline = 'alphabetic';
    const ink = g.measureText('0'), up = ink.actualBoundingBoxAscent, down = ink.actualBoundingBoxDescent;
    const baseY = cy + (up > 0 && Number.isFinite(down) ? clamp((up - down) / 2, em * 0.25, em * 0.45) : em * 0.36);
    if (f.state === 'paused') g.globalAlpha = 0.85;
    for (const c of chars) {
      const w = c === ':' ? digW * 0.5 : digW, mx = x + w / 2;
      if (p.style === 'neon') {
        g.lineJoin = 'round';
        g.save(); g.shadowColor = alpha(col, 0.95); g.shadowBlur = glow * 1.1; g.lineWidth = em * 0.06; g.strokeStyle = col; g.strokeText(c, mx, baseY); g.restore();
        g.lineWidth = em * 0.016; g.strokeStyle = alpha('#ffffff', 0.85); g.strokeText(c, mx, baseY);
        g.fillStyle = alpha(col, 0.16); g.fillText(c, mx, baseY);
      } else {
        g.lineJoin = 'round'; g.lineWidth = em * 0.07; g.strokeStyle = 'rgba(0,0,0,.7)'; g.strokeText(c, mx, baseY);
        g.save(); g.shadowColor = alpha(col, 0.8); g.shadowBlur = glow * 0.8; g.fillStyle = col; g.fillText(c, mx, baseY); g.restore();
        g.fillStyle = col; g.fillText(c, mx, baseY);
      }
      x += w;
    }
    g.globalAlpha = 1;
    g.textBaseline = rowBase;
  }
  // ---- the small line, or the "+10:00 name" pop easing over it
  const pk = f.pop?.k ?? 0;
  g.textAlign = 'center';
  const smallPx = Math.round(rowB * 0.62);
  if (f.sub && pk < 1) {
    g.font = `800 ${smallPx}px ${FONT}`; g.fillStyle = alpha(p.ink, 0.88 * (1 - pk));
    let s = f.sub; while (s.length > 1 && g.measureText(s).width > iw) s = s.slice(0, -1);
    g.fillText(s, px + pw / 2, botY + 1);
  }
  if (f.pop && pk > 0) {
    let bigPx = Math.round(rowB * 0.86), popPx = smallPx;
    g.save(); g.globalAlpha = pk;
    g.font = `900 ${bigPx}px ${FONT}`;
    const w1 = g.measureText(f.pop.text).width;
    g.font = `700 ${popPx}px ${FONT}`;
    let who = f.pop.who ? `  ${f.pop.who}` : '';
    while (who.length > 3 && w1 + g.measureText(who).width > iw) who = who.slice(0, -1);
    let w2 = g.measureText(who).width;
    // a narrow panel: the whole pop shrinks to fit rather than running off its edges
    const sc = Math.min(1, iw / Math.max(1, w1 + w2));
    bigPx = Math.max(6, Math.round(bigPx * sc)); popPx = Math.max(6, Math.round(popPx * sc));
    g.font = `900 ${bigPx}px ${FONT}`;
    const m1 = g.measureText(f.pop.text).width;
    g.font = `700 ${popPx}px ${FONT}`;
    w2 = g.measureText(who).width;
    const lx = px + pw / 2 - (m1 + w2) / 2, ly = botY + (1 - pk) * rowB * 0.5 + 1;
    g.textAlign = 'left';
    g.font = `900 ${bigPx}px ${FONT}`; g.lineJoin = 'round'; g.lineWidth = bigPx * 0.12; g.strokeStyle = 'rgba(0,0,0,.8)';
    g.strokeText(f.pop.text, lx, ly); g.fillStyle = f.pop.add ? POP_GREEN : POP_RED; g.fillText(f.pop.text, lx, ly);
    if (who) { g.font = `700 ${popPx}px ${FONT}`; g.fillStyle = alpha(p.ink, 0.92); g.fillText(who, lx + m1, ly); }
    g.restore();
  }
  g.restore();
}
