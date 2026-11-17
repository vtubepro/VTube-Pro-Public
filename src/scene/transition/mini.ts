// Room-change transition mini preview (Canvas2D only): the Scene tab's style cards and the Live panel's Transitions
// tab (Preview) play a style on a small canvas with it — never on OBS.
import type { CurtainFrame, CurtainStyleDef } from './kit.ts';
import { cancelStill, drawStill } from '../stillCache.ts';

/** Synthetic timeline for the mini previews (s): in, hold, out, a transparent gap. */
const LOOP = { in: 0.8, hold: 2.2, out: 0.9, gap: 0.5 };

export function drawCurtainMini(ctx: CanvasRenderingContext2D, w: number, h: number, st: CurtainStyleDef, time: number | null, title: string, thumb: HTMLImageElement | null) {
  // (stills come from a cache: style + size + title + whether the room picture is in — src/scene/stillCache.ts)
  if (time === null) { drawStill(ctx, w, h, st, `${title}|${thumb ? `${thumb.src}|${thumb.complete && thumb.naturalWidth > 0}` : ''}`, (g) => frame(g, w, h, st, null, title, thumb)); return; }
  if (typeof HTMLCanvasElement !== 'undefined' && ctx.canvas instanceof HTMLCanvasElement) cancelStill(ctx.canvas);
  frame(ctx, w, h, st, time, title, thumb);
}
function frame(ctx: CanvasRenderingContext2D, w: number, h: number, st: CurtainStyleDef, time: number | null, title: string, thumb: HTMLImageElement | null) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.shadowBlur = 0;
  ctx.clearRect(0, 0, w, h);
  const inD = LOOP.in * st.inMul, outD = LOOP.out * st.outMul, L = inD + LOOP.hold + outD + LOOP.gap;
  let phase: CurtainFrame['phase'] = 'hold', p = 0, th = 1.4, t = 2;
  if (time !== null) {
    const x = time % L;
    t = x;
    if (x < inD) { phase = 'in'; p = x / inD; th = 0; }
    else if (x < inD + LOOP.hold) { phase = 'hold'; th = x - inD; }
    else if (x < inD + LOOP.hold + outD) { phase = 'out'; p = (x - inD - LOOP.hold) / outD; th = 10; }
    else return;
  }
  const load = phase === 'hold' ? Math.min(1, th / (LOOP.hold * 0.7)) : phase === 'out' ? 1 : 0.1;
  const ready = load >= 1;
  try {
    ctx.save();
    st.draw({ ctx, w, h, u: Math.min(w / 1920, h / 1080), phase, p, t, th, load, ready, readyT: ready ? th - LOOP.hold * 0.7 : 0,
      card: { title, kicker: '', thumb }, seed: 12345 });
    ctx.restore();
  } catch (e) { ctx.restore(); console.warn('transition preview', st.id, e); }
}
