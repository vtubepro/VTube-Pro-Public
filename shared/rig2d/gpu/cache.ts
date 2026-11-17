// The texture tier cache of a 2D model (HQ decision #10): a rebuildable folder BESIDE the model, never inside the .vtp2
// (which keeps the original art, format version 1). Helper: library/<id>/gpu/<key>/ (server/gpuTiers.ts); web / phone
// without the helper: OPFS / IndexedDB (eviction tolerated: rebuilt when missing).
//   <key>/manifest.json           what is there (tiers, pages, sizes, status)
//   <key>/t<k>.layout.json        the page layout of tier k (shared/rig2d/gpu/layout.ts)
//   <key>/t<k>/p<i>.ktx2          page i of tier k (UASTC LDR 4×4 + zstd, premultiplied, own mip chain)
// The key changes whenever anything the pages depend on changes: the textures' content, the meshes' UVs / triangles
// (the layout), the layout rules, the alpha / colour convention, the mip filter, the codec version and its settings.
import type { Rig2DDoc } from '../format.ts';
import { viewArray } from '../container.ts';
import { pictureFingerprint } from './png.ts';
import { ALIGN, GUTTER, LAYOUT_VERSION, PAGE, TAIL, type TierLayout } from './layout.ts';
import { BASIS_VERSION, UASTC_SETTINGS } from './basis.ts';

export const CACHE_VERSION = 5;   // 2: mip levels with floor sizes; 3: cut pages take their mips from the whole picture; 4: cut pages hold levels 0..TAIL + tail tiers; 5: no mesh cut, oversized regions stored scaled
/** Everything about how pages are made (besides the model itself). */
export const PIPELINE = {
  cache: CACHE_VERSION, layout: LAYOUT_VERSION, page: PAGE, gutter: GUTTER, align: ALIGN,
  alpha: 'premultiplied', colour: 'art-gamma (renderer blends sRGB values as stored)', mips: 'box-2x2-premultiplied',
  codec: 'uastc-ldr-4x4', basis: BASIS_VERSION, tail: TAIL, ...UASTC_SETTINGS,
} as const;

export interface CachePage { file: string; w: number; h: number; bytes: number; /** the doc texture it holds */ source: number }
export interface CacheTier { k: number; scale: number; layout: string; pages: CachePage[]; done: boolean }
export interface CacheManifest {
  key: string; pipeline: typeof PIPELINE;
  status: 'building' | 'done' | 'failed';
  /** plain sentence when failed */
  error?: string;
  tiers: CacheTier[];
  /** seconds spent encoding, per tier (diagnostics) */
  seconds?: Record<string, number>;
  at: string;
  /** tiers left out for lack of free memory (server/gpuBudget.ts), and the plain sentence the studio shows */
  skipped?: number[];
  note?: string;
}

/** 64-bit FNV-1a-like hash (two 32-bit lanes) of strings / bytes, hex. */
export class Hash {
  private a = 0x811c9dc5; private b = 0x9e3779b9;
  bytes(u: Uint8Array) {
    let a = this.a, b = this.b;
    for (let i = 0; i < u.length; i++) { a = Math.imul(a ^ u[i], 0x01000193); b = Math.imul(b ^ u[i] ^ (a >>> 15), 0x5bd1e995); }
    this.a = a; this.b = b; return this;
  }
  str(s: string) { return this.bytes(new TextEncoder().encode(s)); }
  hex() { return (this.a >>> 0).toString(16).padStart(8, '0') + (this.b >>> 0).toString(16).padStart(8, '0'); }
}

/** The cache key of a model's texture tiers (cheap: PNG chunk CRCs, not the pixels). */
export function cacheKey(doc: Rig2DDoc, buffers: readonly Uint8Array[], files: ReadonlyMap<string, Uint8Array>): string {
  const h = new Hash().str(JSON.stringify(PIPELINE));
  for (const t of doc.textures) {
    const b = files.get(t.file);
    h.str(`|${t.file}|${t.width}x${t.height}|${t.sheet ? 'sheet' : ''}${t.normal ?? ''}${t.emission ?? ''}${t.rim ?? ''}|${b ? pictureFingerprint(b) : 'missing'}`);
  }
  for (const m of doc.meshes) {
    const uv = viewArray(buffers, m.uvs), ix = viewArray(buffers, m.indices);
    h.str(`|${m.texture}|`).bytes(new Uint8Array(uv.buffer, uv.byteOffset, uv.byteLength)).bytes(new Uint8Array(ix.buffer, ix.byteOffset, ix.byteLength));
  }
  h.str(`|att${JSON.stringify((doc as { attachments?: unknown }).attachments ?? null)}|fx${JSON.stringify(((doc as { particles?: { texture: number }[] }).particles ?? []).map((p) => p.texture))}`);
  return h.hex();
}

export const layoutFile = (k: number) => `t${k}.layout.json`;
export const pageFile = (k: number, i: number) => `t${k}/p${i}.ktx2`;

/** Tiers to make: k = 0 (full) down to the tier whose biggest texture side is ≤ 1024. */
export function tiersFor(doc: Rig2DDoc): number[] {
  const side = Math.max(1, ...doc.textures.map((t) => Math.max(t.width, t.height)));
  const out: number[] = [];
  for (let k = 0; ; k++) { out.push(k); if (Math.ceil(side / 2 ** k) <= 1024 || k >= 6) break; }
  // a tier whose texture is bigger than a page (repacked) needs its tail tier k + TAIL (shared/rig2d/gpu/layout.ts TAIL)
  for (const k of [...out]) if (Math.ceil(side / 2 ** k) > PAGE && !out.includes(k + TAIL)) out.push(k + TAIL);
  return out.sort((a, b) => a - b);
}

/** Bytes of GPU memory a tier takes (pages × bytes per pixel × 4/3 for the mip chain). */
export const tierVram = (pages: readonly { w: number; h: number }[], bpp: number) => Math.ceil(pages.reduce((s, p) => s + p.w * p.h, 0) * bpp * 4 / 3);

export type { TierLayout };
