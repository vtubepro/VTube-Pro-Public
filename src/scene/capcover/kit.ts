// Capture-cover style contract (src/scene/capcover/*). Like the room-change transition kit (src/scene/transition/kit.ts,
// whose Canvas2D helpers the styles reuse) but the canvas is the CAPTURE AREA only (any aspect: 16:9, 21:9, 32:9, 4:3 …)
// and 'hold' loops for as long as the host keeps the cover up.
//   'in'   p 0 → 1  covering. At p = 1 the canvas MUST be fully opaque.
//   'hold' fully opaque every frame; t / th keep counting (loop your idle animation on them).
//   'out'  p 0 → 1  revealing. p = 0 fully opaque; p = 1 nothing left.
// Sizes are in `u` = one pixel of a 1920×1080 design box centred in the canvas (u = min(w/1920, h/1080)); fill the
// whole canvas with your background (wider / taller canvases show more of it).
export type CoverPhase = 'in' | 'hold' | 'out';

export interface CoverFrame {
  ctx: CanvasRenderingContext2D;
  w: number; h: number; u: number;
  /** Design box origin in canvas px (centred 1920×1080 u). */
  ox: number; oy: number;
  phase: CoverPhase;
  p: number;
  /** Seconds since the cover started / since it was fully covering. */
  t: number; th: number;
  /** The host's line ('' = the style's own `line`). */
  text: string;
  seed: number;
}

export interface CoverStyleDef {
  id: string;
  name: string;
  /** 'vtp' = ships with the engine, 'own' = a set of someone's own. */
  theme: 'vtp' | 'own';
  blurb: string;
  /** Default card line when the host typed none. */
  line: string;
  /** Seconds. */
  inDur: number;
  outDur: number;
  draw(f: CoverFrame): void;
}

/** Design-box coordinates → canvas px. */
export const X = (f: CoverFrame, v: number) => f.ox + v * f.u;
export const Y = (f: CoverFrame, v: number) => f.oy + v * f.u;
/** Loop time: 0..1 through a `period`-second cycle. */
export const cyc = (t: number, period: number) => ((t % period) + period) % period / period;
/** Draw `body` clipped to `mask` unless the phase says the frame must be airtight (in p = 1, hold, out p = 0). */
export function masked(f: CoverFrame, mask: (ctx: CanvasRenderingContext2D) => void, body: () => void) {
  const full = f.phase === 'hold' || (f.phase === 'in' && f.p >= 1) || (f.phase === 'out' && f.p <= 0);
  if (full) { body(); return; }
  f.ctx.save();
  f.ctx.beginPath();
  mask(f.ctx);
  f.ctx.clip();
  body();
  f.ctx.restore();
}
/** Coverage 0..1 of the current phase (1 = fully covering). */
export const coverK = (f: CoverFrame) => (f.phase === 'hold' ? 1 : f.phase === 'in' ? f.p : 1 - f.p);
