// Every size limit of the 2D-avatar import (Live2D / Inochi2D / .vtp2 / pictures) and of what a rigged 2D model may
// decode at once, in ONE place. High-quality models (8K / 16K textures, several pages, big zips) must be accepted:
// when a limit is raised, raise it here (the readers, the upload route, the studio's repack and the converter all read
// these), and when memory is the concern, change what is DECODED (rig2dDecodeBudget), not what is accepted.
// Uses: shared/flatImport.ts FLAT_LIMITS, shared/rig2d/format.ts RIG2D_LIMITS (texture fields), server/routes/avatars.ts
// (body limit), shared/flatUnzip.ts (via FLAT_LIMITS), src/ui/flatUploadPrep.ts, shared/rig2d/live2d/convert.ts,
// src/avatar/flat/rig2d/textureTier.ts.

export const IMPORT_LIMITS = {
  /** one upload request (the route's body limit; the studio repacks a bigger zip without art sources first). High-quality
   *  deliveries (8K / 16K pages, 100 MB – 1 GB zips) are accepted: HQ decision #10 (the hiq lane) */
  uploadBytes: 1100 << 20,
  /** all kept files of an upload together, unpacked (zip-in-zip included) */
  unpackedBytes: 1100 << 20,
  /** files of an upload (pictures / a model folder); the zip reader allows twice this many entries */
  files: 600,
  /** one picture / texture / .moc3, unpacked */
  entryBytes: 512 << 20,
  /** the model's own JSON (model3.json); side JSON files are the converter's (up to sideJsonBytes) */
  jsonBytes: 8 << 20,
  sideJsonBytes: 64 << 20,
  /** a texture's side in pixels and its encoded size (the .vtp2 format's limits; > 8192 needs a beta.12+ reader). GPU pages
   *  stay ≤ 4096: the texture tiers cut bigger pictures into pages (shared/rig2d/gpu/layout.ts) */
  textureSide: 16384,
  textureBytes: 512 << 20,
  /** texture pages of one model */
  textures: 256,
} as const;

/** Bytes of decoded RGBA texture memory one rigged 2D model may hold at once on this device (all its pages together,
 *  before mip-maps). A model whose textures are bigger still loads: its pages are decoded one at a time and scaled
 *  down to fit (src/avatar/flat/rig2d/textureTier.ts pickTextureTier: the one decision point). The device-tier / GPU-compression work replaces this function.
 *  (Test pages may set globalThis.__vtpRig2dDecodeBudget: tools/live2d_soak_e2e.mts.) */
export function rig2dDecodeBudget(): number {
  const o = (globalThis as { __vtpRig2dDecodeBudget?: unknown }).__vtpRig2dDecodeBudget;
  return typeof o === 'number' && o > 0 ? o : 768 << 20;   // e.g. three 8192² pages, or twelve 4096² pages, at full size
}

/** The scale (≤ 1) at which pages of these sizes fit the decode budget, uniform for every page. */
export function rig2dDecodeScale(pages: readonly { width: number; height: number }[], budget = rig2dDecodeBudget()): number {
  const bytes = pages.reduce((a, p) => a + p.width * p.height * 4, 0);
  return bytes > budget ? Math.sqrt(budget / bytes) : 1;
}

/** The most one file of an upload may unpack to, by kind: a zip inside the upload (the model's own zip in a shop's
 *  delivery) may use the whole unpacked budget, everything else (pictures, textures, .moc3, JSON) the per-file cap. */
export function importEntryCap(name: string): number {
  return /\.zip$/i.test(name) ? IMPORT_LIMITS.unpackedBytes : IMPORT_LIMITS.entryBytes;
}
