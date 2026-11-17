// Capture-cover mini preview (no three.js): the Scene tab's style cards and the Live panel's Privacy tab
// ("What viewers see") draw a style on a small canvas with it.
import type { CoverPhase, CoverStyleDef } from './kit.ts';
import { cancelStill, drawStill } from '../stillCache.ts';

/** Mini preview for the studio's style cards: one frame of a style on a small canvas (time null = a still). */
export function drawCoverMini(ctx: CanvasRenderingContext2D, w: number, h: number, st: CoverStyleDef, time: number | null, text: string) {
  // (stills come from a cache: they only depend on the style, the size and the text — src/scene/stillCache.ts)
  if (time === null) { drawStill(ctx, w, h, st, text, (g) => frame(g, w, h, st, null, text)); return; }
  if (typeof HTMLCanvasElement !== 'undefined' && ctx.canvas instanceof HTMLCanvasElement) cancelStill(ctx.canvas);
  frame(ctx, w, h, st, time, text);
}
function frame(ctx: CanvasRenderingContext2D, w: number, h: number, st: CoverStyleDef, time: number | null, text: string) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.shadowBlur = 0;
  ctx.clearRect(0, 0, w, h);
  const HOLD = 7;
  const L = st.inDur + HOLD + st.outDur + 0.4;
  let phase: CoverPhase = 'hold', p = 0, t = 3.2, th = 3.2;
  if (time !== null) {
    const x = time % L;
    t = x;
    if (x < st.inDur) { phase = 'in'; p = x / st.inDur; th = 0; }
    else if (x < st.inDur + HOLD) { phase = 'hold'; th = x - st.inDur; }
    else if (x < st.inDur + HOLD + st.outDur) { phase = 'out'; p = (x - st.inDur - HOLD) / st.outDur; th = HOLD; }
    else return;
  }
  const u = Math.min(w / 1920, h / 1080);
  try { ctx.save(); st.draw({ ctx, w, h, u, ox: (w - 1920 * u) / 2, oy: (h - 1080 * u) / 2, phase, p, t, th, text, seed: 777 }); ctx.restore(); }
  catch (e) { ctx.restore(); console.warn('capcover preview', st.id, e); }
}
