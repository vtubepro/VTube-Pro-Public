// How much decoded texture memory ONE rigged 2D model may use on this device (all its pages and lighting maps together,
// RGBA bytes before mip-maps), and the scale that fits a model into it. Pure (tools/mobile2d_unit.ts). The hiq lane's
// tiers (src/avatar/flat/rig2d/textureTier.ts) call it to pick a tier; the default hook decodes scaled by it.
//   desktop                      768 MB (l2dsoak's budget: shared/rig2d/limits.ts rig2dDecodeBudget), 256 MB in low detail
//   phone, by navigator.deviceMemory (Android; iPhones don't say): <= 3 GB 48 MB · 4-5 GB 64 MB · >= 6 GB 96 MB ·
//          unknown (iPhone) 64 MB (= one 4096² page, or four 2048² pages, at full size)
//   phone in low detail (after "Reload in low detail" / a start-up crash): half of that, at least 24 MB
// Never bigger than the chip's MAX_TEXTURE_SIZE on a side.
import { rig2dDecodeBudget } from '../../../../shared/rig2d/limits.ts';
import type { TextureDevice } from './textureTier.ts';

const MB = 1 << 20;

/** Bytes of decoded texture memory one rigged 2D model may hold on `device`. */
export function decodeBudgetFor(device: Pick<TextureDevice, 'deviceClass' | 'lowDetail' | 'memoryGB'>, desktop = rig2dDecodeBudget()): number {
  if (device.deviceClass !== 'phone') return device.lowDetail ? Math.min(desktop, 256 * MB) : desktop;
  const gb = device.memoryGB;
  const base = gb === undefined ? 64 * MB : gb <= 3 ? 48 * MB : gb < 6 ? 64 * MB : 96 * MB;
  return device.lowDetail ? Math.max(24 * MB, base / 2) : base;
}

/** The one scale (<= 1) every page of a model is decoded at on `device`: within its decode budget and never bigger
 *  than the chip allows. `pages` = every texture and lighting map at its stored size. */
export function decodeScaleFor(pages: readonly { width: number; height: number }[], device: Pick<TextureDevice, 'deviceClass' | 'lowDetail' | 'memoryGB' | 'maxTexture'>): number {
  const budget = decodeBudgetFor(device);
  const bytes = pages.reduce((a, p) => a + p.width * p.height * 4, 0);
  const longest = Math.max(1, ...pages.map((p) => Math.max(p.width, p.height)));
  return Math.min(1, bytes > budget ? Math.sqrt(budget / bytes) : 1, (device.maxTexture || 4096) / longest);
}
