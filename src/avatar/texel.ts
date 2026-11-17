// Read ONE texel of an image without painting the whole image into a canvas first (a 4K albedo drawn into a
// full-size canvas, then one getImageData, costs an upload + a flush for a single pixel).

/** The texel (x, y) an (u, v) lands on: repeat-wrapped, flipY-aware, same rounding as the old full-canvas code. */
export function texelAt(u: number, v: number, flipY: boolean, W: number, H: number): { x: number; y: number } {
  const uu = ((u % 1) + 1) % 1, vv = ((v % 1) + 1) % 1;
  const yy = flipY ? 1 - vv : vv;
  return { x: Math.floor(uu * (W - 1)), y: Math.floor(yy * (H - 1)) };
}

export interface CanvasLike { width: number; height: number; getContext(id: '2d', opts?: unknown): { drawImage(...a: unknown[]): void; getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> } } | null }

/** RGBA of one texel: a 1x1 canvas, the source rectangle (x, y, 1, 1) drawn 1:1 into it (no resampling). */
export function readTexel(img: unknown, x: number, y: number, makeCanvas: () => CanvasLike = () => document.createElement('canvas') as unknown as CanvasLike): ArrayLike<number> {
  const cv = makeCanvas();
  cv.width = 1; cv.height = 1;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2D context');
  ctx.drawImage(img, x, y, 1, 1, 0, 0, 1, 1);
  return ctx.getImageData(0, 0, 1, 1).data;
}
