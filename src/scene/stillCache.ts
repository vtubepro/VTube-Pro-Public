// Still frames of the studio's style cards (room-change transitions, screen hiders): the Show / Chat panels and Live
// Control draw every style's still on every build. A still only depends on its style, its canvas size and its inputs
// (title / text / room picture), so it is drawn ONCE and then copied (one drawImage, ~0.05 ms).
//
// The first draw of each still is heavy Canvas2D work (gradients, shadows, text fitting): ~100 ms of the main thread and,
// on the graphics card, ~0.4 s of 2D rasterising in one burst when a panel with ~40 cards opened for the first time —
// the face tracker's GPU model waited behind it (measured: a 450 ms tracking gap on the first Chat visit). So a still
// that is not cached yet is drawn LATER, one at a time in idle time (a few ms per slice), on a processor-backed canvas
// (willReadFrequently: no GPU rasterising), and copied in when ready. Cards show their checkerboard meanwhile.
type Ctx = CanvasRenderingContext2D;

const MAX = 96;                       // ~32 MB at most (384 x 216 cards), dropped all at once past it
let cache = new WeakMap<object, Map<string, HTMLCanvasElement>>();
let count = 0;

function copy(ctx: Ctx, src: HTMLCanvasElement, w: number, h: number) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.shadowBlur = 0; ctx.filter = 'none';
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0);
}

// ---- the idle queue: one pending still per target canvas (a newer request replaces an older one)
const jobs = new Map<HTMLCanvasElement, () => void>();
let scheduled = false;
const idle: (fn: (d?: { timeRemaining(): number }) => void) => void = typeof requestIdleCallback === 'function'
  ? (fn) => { requestIdleCallback(fn as IdleRequestCallback, { timeout: 250 }); }
  : (fn) => { setTimeout(fn, 16); };
function schedule() { if (!scheduled && jobs.size) { scheduled = true; idle(run); } }
function run() {
  scheduled = false;
  const t0 = performance.now();
  // (a few ms per slice: the tracker's results and the studio's frames go in between)
  for (const [cv, job] of jobs) {
    jobs.delete(cv);
    try { if (cv.isConnected) job(); } catch { /* a bad style: skipped */ }
    if (performance.now() - t0 > 6) break;
  }
  schedule();
}

/** Draw a still through the cache. `style` = the style object (a new definition, e.g. your own styles arriving from the
 *  helper, never reuses an old still), `key` = everything else the still depends on. `draw(g)` paints the full w x h
 *  frame into g. Not cached yet: drawn in idle time (see above) and copied in then. */
export function drawStill(ctx: Ctx, w: number, h: number, style: object, key: string, draw: (g: Ctx) => void) {
  // (only plain full-canvas draws can be cached)
  if (typeof document === 'undefined' || ctx.canvas.width !== w || ctx.canvas.height !== h || !(ctx.canvas instanceof HTMLCanvasElement)) { draw(ctx); return; }
  const k = `${w}x${h}|${key}`;
  const hit = cache.get(style)?.get(k);
  const target = ctx.canvas;
  if (hit) { jobs.delete(target); copy(ctx, hit, w, h); return; }
  jobs.set(target, () => {
    let c = cache.get(style)?.get(k);
    if (!c) {
      c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true });   // (processor-backed: no GPU rasterising)
      if (!g) { draw(ctx); return; }
      draw(g);
      if (count >= MAX) { cache = new WeakMap(); count = 0; }
      let m = cache.get(style);
      if (!m) { m = new Map(); cache.set(style, m); }
      m.set(k, c); count++;
    }
    copy(ctx, c, w, h);
  });
  schedule();
}

/** Drop a pending still for this canvas (it is about to animate, or is drawn another way now). */
export function cancelStill(cv: HTMLCanvasElement) { jobs.delete(cv); }
