// What the browser tier builder (tierBuildWeb.ts) may hold, without the helper: the browser doesn't say how much memory
// is free, so the budget comes from navigator.deviceMemory (rounded GB, Chromium only) and is small when it's missing
// (Safari, Firefox, most phones). Pictures are streamed and shrunk while reading (RowShrinker), so tier pictures cost
// little; the one exception is an interlaced (Adam7) PNG, which is read whole at full size whatever tier it becomes:
// its unpacked data and the rebuilt picture (shared/rig2d/gpu/png.ts), the same charge as the helper's plan
// (server/gpuBudget.ts). When one doesn't fit, nothing is built and the model keeps drawing from its original pictures.
// Pure: tools/hiq_safety_unit.ts.
import { pngInfo } from '../../../../shared/rig2d/gpu/png.ts';

const MB = 1 << 20;
/** Budget with no deviceMemory (Safari, Firefox, iPhone): an 8192 px interlaced picture still fits, a 16384 one doesn't. */
export const WEB_BUDGET_UNKNOWN = 512 * MB;
/** Never more than this in one worker, however much memory the device reports. */
export const WEB_BUDGET_MAX = 1536 * MB;

/** Bytes a tier build may hold for one picture on a device with `deviceMemoryGB` (undefined: unknown). */
export function webBudget(deviceMemoryGB?: number): number {
  if (!deviceMemoryGB || !Number.isFinite(deviceMemoryGB) || deviceMemoryGB <= 0) return WEB_BUDGET_UNKNOWN;
  return Math.max(256 * MB, Math.min(WEB_BUDGET_MAX, deviceMemoryGB * 1024 * MB / 4));
}

/** What reading one texture costs at most in the browser builder (non-interlaced pictures stream: counted as 0 here). */
export function webPictureCost(t: { width: number; height: number; interlaced?: boolean }): number {
  return t.interlaced ? t.width * t.height * 4 * 2 : 0;
}

/** What reading one texture's file will cost depends on the file itself, not on what the model document says about it:
 *  a PNG's own header gives its size and whether it is interlaced. A PNG whose header can't be read is no risk here:
 *  the decoder reads the same header first and stops there (tierBuildWeb.ts decodeAt), before anything is allocated.
 *  JPEG / WebP go through the browser's decoder, resized while decoding. */
export function webPictureFacts(doc: { width: number; height: number }, bytes: Uint8Array | undefined): { width: number; height: number; interlaced: boolean } {
  if (bytes && bytes[0] === 0x89 && bytes[1] === 0x50) {
    try { const h = pngInfo(bytes); return { width: h.w, height: h.h, interlaced: h.interlace === 1 }; } catch { /* stops in the decoder */ }
  }
  return { width: doc.width, height: doc.height, interlaced: false };
}

/** The plain sentence when the browser can't make the lighter versions (no build; the original pictures are used). */
export const WEB_REFUSE = 'This model has a very large interlaced PNG picture, too big to make lighter versions of in the browser; the model keeps working from its original pictures. Save the picture as a normal (non-interlaced) PNG, or link VTube Pro.';

/** null when every texture fits the budget, else the sentence to show (and nothing is built). */
export function webRefusal(textures: readonly { width: number; height: number; interlaced?: boolean }[], deviceMemoryGB?: number): string | null {
  const budget = webBudget(deviceMemoryGB);
  return textures.some((t) => webPictureCost(t) > budget) ? WEB_REFUSE : null;
}
