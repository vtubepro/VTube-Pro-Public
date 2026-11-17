// Where a 2D avatar's pixels are: the box of everything opaque on a picture, read from its alpha. Framing sizes and
// places the card from it (never from the picture's canvas: padded art, a Live2D model's empty margins). Scans are
// sized so a one-pixel mark still shows (any alpha above 0 after the downscale counts), and run at load / in idle
// time, never per frame.
import { alphaRect, type ContentRect } from '../../../shared/flatFraming.ts';

let scratch: HTMLCanvasElement | null = null;
/** The opaque box of `img` drawn at (dx, dy, dw, dh) on a W x H picture, fractions of that picture (y from the bottom);
 *  null when nothing on it is opaque at all. `maxSide`: the scan's resolution (the longer side, px). */
export function drawnRect(img: CanvasImageSource, W: number, H: number, dx = 0, dy = 0, dw = W, dh = H, maxSide = 512): ContentRect | null {
  const k = Math.min(1, maxSide / Math.max(W, H));
  const w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
  scratch ??= document.createElement('canvas');
  const c = scratch;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.clearRect(0, 0, w, h);
  g.imageSmoothingEnabled = true;
  g.drawImage(img, dx * k, dy * k, dw * k, dh * k);
  return alphaRect(g.getImageData(0, 0, w, h).data, w, h, 0, 4, 3);
}
/** Frees the scan canvas (the last 2D avatar went away). */
export function dropScratch() { if (scratch) { scratch.width = scratch.height = 0; scratch = null; } }
