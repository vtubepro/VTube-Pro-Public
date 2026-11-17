/// <reference lib="webworker" />
// Diagnostics image encoder (Stage.ts ShotEncoder): the studio hands over small ImageBitmaps (the GPU already scaled
// them: a 960 px copy of the frame it just drew, a 640 px camera frame) and this worker draws them, adds the landmark
// dots for camera.jpg and encodes a JPEG, so the main thread never reads back or encodes a full-size canvas.
// Keep this file ASCII-only.

interface ShotJob {
  id: number;
  /** Warm-up only (no bitmap): pays the first-use cost of the 2D canvas + JPEG encoder off the critical path. */
  warm?: boolean;
  bitmap?: ImageBitmap;
  quality?: number;
  /** Normalized [x, y] pairs: face landmarks (2 px green dots) and visible pose landmarks (6 px pink dots). */
  face?: Float32Array;
  pose?: Float32Array;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let cv: OffscreenCanvas | null = null;
let g: OffscreenCanvasRenderingContext2D | null = null;

function canvas(w: number, h: number): OffscreenCanvasRenderingContext2D {
  if (!cv || !g || cv.width !== w || cv.height !== h) {
    cv = new OffscreenCanvas(w, h);
    g = cv.getContext('2d', { alpha: false });
    if (!g) throw new Error('no 2D context');
  }
  return g;
}

function dots(c: OffscreenCanvasRenderingContext2D, pts: Float32Array | undefined, w: number, h: number, size: number, color: string) {
  if (!pts?.length) return;
  c.fillStyle = color;
  const r = size / 2;
  for (let i = 0; i + 1 < pts.length; i += 2) c.fillRect(pts[i] * w - r, pts[i + 1] * h - r, size, size);
}

/** OffscreenCanvas with a 2D context and convertToBlob in this worker (Safari before 16.4 has no OffscreenCanvas 2D). */
const supported = (() => {
  try {
    if (typeof OffscreenCanvas !== 'function') return false;
    const t = new OffscreenCanvas(1, 1);
    return !!t.getContext('2d') && typeof t.convertToBlob === 'function';
  } catch { return false; }
})();

/** Give the job back to the studio untouched (it encodes on the main thread from then on): the bitmap and the dots. */
function handBack(job: ShotJob, why: { unsupported?: boolean; error?: string }) {
  const { id, bitmap, quality = 0.8, face, pose } = job;
  const transfer: Transferable[] = [];
  if (bitmap) transfer.push(bitmap);
  if (face) transfer.push(face.buffer);
  if (pose) transfer.push(pose.buffer);
  ctx.postMessage({ id, bitmap, face, pose, quality, ...why }, transfer);
}

ctx.onmessage = async (e: MessageEvent<ShotJob>) => {
  const { id, bitmap, warm, quality = 0.8, face, pose } = e.data;
  if (!supported) { handBack(e.data, { unsupported: true }); return; }
  try {
    if (warm || !bitmap) {
      const c = canvas(8, 8);
      c.fillRect(0, 0, 8, 8);
      await cv!.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
      ctx.postMessage({ id, blob: null });
      return;
    }
    const w = bitmap.width, h = bitmap.height;
    const c = canvas(w, h);
    c.drawImage(bitmap, 0, 0);
    bitmap.close();
    dots(c, face, w, h, 2, '#39ff14');
    dots(c, pose, w, h, 6, '#ff3fa4');
    const blob = await cv!.convertToBlob({ type: 'image/jpeg', quality });
    ctx.postMessage({ id, blob });
  } catch (err) {
    const error = String((err as Error)?.message ?? err);
    // not drawn yet (a closed bitmap has width 0): hand it back, the studio encodes it itself
    try { if (bitmap && bitmap.width) { handBack(e.data, { error }); return; } } catch { /* fall through */ }
    try { bitmap?.close(); } catch { /* already closed */ }
    ctx.postMessage({ id, blob: null, error });
  }
};
