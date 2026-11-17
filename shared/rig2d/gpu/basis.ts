// Basis Universal (Apache-2.0, v2.50, public/vendor/basis/: THIRD_PARTY_NOTICES.md) behind two calls, for the texture
// tiers (HQ decision #10): encode a page and its mip levels to KTX2 UASTC LDR 4×4 + Zstandard, and transcode a page to
// the format this GPU takes (ASTC 4×4 / BC7 / ETC2 RGBA / BC3 / RGBA8). The same code runs in the helper (Node, on a
// child process's worker threads: server/gpuTiers.ts) and in a browser worker (public/vendor/basis/pro2d_tex_worker.js
// loads the module; src/avatar/flat/rig2d/gpuTextures.ts). Callers pass the loaded Emscripten module in.
//
// The encoder's WASM build refuses more than 12 Mi source pixels per call (BASISU_ENCODER_MAX_SOURCE_IMAGE_PIXELS_
// HIGHER_LIMIT in its basis_wrappers.cpp, a 32-bit WASM memory guard): a 4096 × 4096 page level is encoded as
// horizontal strips (block rows are independent in UASTC) and the strips' zstd frames are joined into one level.
import { joinLevel, readKtx2, writeKtx2, type Ktx2, type Ktx2Level } from './ktx2.ts';
import type { Img } from './image.ts';
import { PAGE } from './layout.ts';

/** The pinned encoder build and settings: part of every cache key (shared/rig2d/gpu/cache.ts). */
export const BASIS_VERSION = '2.50';
export const UASTC_SETTINGS = { level: 2, rdo: 0, zstd: true } as const;
/** Source pixels per encode call (the WASM guard: 12 Mi). */
export const ENCODE_GUARD = 12 * 1024 * 1024;

/** The few members of the Emscripten module we use (encoder build: all of them; transcoder build: no BasisEncoder). */
export interface BasisModule {
  initializeBasis(): void;
  BasisEncoder?: new () => {
    setSliceSourceImage(i: number, img: Uint8Array, w: number, h: number, type: number): boolean;
    setFormatMode(f: number): void; setPackUASTCFlags(f: number): void; setRDOUASTC(b: boolean): void;
    setCreateKTX2File(b: boolean): void; setKTX2UASTCSupercompression(b: boolean): void; setMipGen(b: boolean): void;
    setPerceptual(b: boolean): void; setCheckForAlpha(b: boolean): void; setForceAlpha(b: boolean): void;
    setKTX2AndBasisSRGBTransferFunc(b: boolean): void; setDebug(b: boolean): void;
    encode(out: Uint8Array): number; delete(): void;
  };
  KTX2File: new (b: Uint8Array) => {
    isValid(): boolean; startTranscoding(): boolean; getLevels(): number; getWidth(): number; getHeight(): number;
    getImageTranscodedSizeInBytes(level: number, layer: number, face: number, fmt: number): number;
    transcodeImageWithFlags(dst: Uint8Array, level: number, layer: number, face: number, fmt: number, flags: number, c0: number, c1: number): number;
    close(): void; delete(): void;
  };
  ldr_image_type: { cRGBA32: { value: number } };
  basis_tex_format: { cUASTC_LDR_4x4: { value: number } };
  transcoder_texture_format: Record<string, { value: number }>;
  basisu_decode_flags: Record<string, { value: number }>;
}

/** GPU targets, best first (decided per page from the live WebGL context: src/avatar/flat/rig2d/gpuTextures.ts). */
export type GpuTarget = 'astc' | 'bc7' | 'etc2' | 'bc3' | 'rgba';
export const TARGET_TF: Record<GpuTarget, string> = { astc: 'cTFASTC_4x4_RGBA', bc7: 'cTFBC7_RGBA', etc2: 'cTFETC2_RGBA', bc3: 'cTFBC3_RGBA', rgba: 'cTFRGBA32' };
/** The WebGL internal formats (UNORM, not sRGB: the renderer blends the art's own gamma values, renderer.ts). */
export const TARGET_GL: Record<GpuTarget, number> = {
  astc: 0x93b0,   // COMPRESSED_RGBA_ASTC_4x4_KHR
  bc7: 0x8e8c,    // COMPRESSED_RGBA_BPTC_UNORM_EXT
  etc2: 0x9278,   // COMPRESSED_RGBA8_ETC2_EAC
  bc3: 0x83f3,    // COMPRESSED_RGBA_S3TC_DXT5_EXT
  rgba: 0x8058,   // RGBA8 (uncompressed: texImage2D)
};
/** Bytes per pixel on the GPU (VRAM accounting). */
export const TARGET_BPP: Record<GpuTarget, number> = { astc: 1, bc7: 1, etc2: 1, bc3: 1, rgba: 4 };

let quiet = false;
/** Module options that keep the encoder's progress printing off stdout (the helper's child speaks JSON there). */
export const BASIS_MODULE_OPTS = { print: () => { /* encoder progress lines */ }, printErr: (s: string) => { if (!quiet) console.warn(`[basis] ${s}`); } };
export function basisQuiet(q: boolean) { quiet = q; }

/** One picture (premultiplied RGBA8) → one KTX2 level (UASTC + zstd), in strips under the WASM guard. */
export function encodeLevel(M: BasisModule, img: Img, level = UASTC_SETTINGS.level): { level: Ktx2Level; file: Ktx2 } {
  const rowsPerStrip = Math.max(4, Math.floor(ENCODE_GUARD / img.w / 4) * 4);
  const parts: Ktx2Level[] = [];
  let file: Ktx2 | null = null;
  for (let y = 0; y < img.h; y += rowsPerStrip) {
    const h = Math.min(rowsPerStrip, img.h - y);
    const px = img.data.subarray(y * img.w * 4, (y + h) * img.w * 4);
    const k = encodeOne(M, px, img.w, h, level);
    if (k.levels.length !== 1) throw new Error('texture encoder: unexpected level count');
    parts.push(k.levels[0]);
    if (!file) file = k;
  }
  return { level: parts.length === 1 ? parts[0] : joinLevel(parts), file: file! };
}

function encodeOne(M: BasisModule, px: Uint8Array, w: number, h: number, level: number): Ktx2 {
  if (!M.BasisEncoder) throw new Error('this Basis build has no encoder');
  const e = new M.BasisEncoder();
  try {
    // (a copy: the module may keep a view of the array while encoding, and px is a view into a bigger picture)
    e.setSliceSourceImage(0, px.slice(), w, h, M.ldr_image_type.cRGBA32.value);
    e.setFormatMode(M.basis_tex_format.cUASTC_LDR_4x4.value);
    e.setPackUASTCFlags(level);
    e.setRDOUASTC(UASTC_SETTINGS.rdo > 0);
    e.setCreateKTX2File(true);
    e.setKTX2UASTCSupercompression(UASTC_SETTINGS.zstd);
    e.setMipGen(false);
    e.setPerceptual(true);
    e.setCheckForAlpha(false); e.setForceAlpha(true);
    e.setKTX2AndBasisSRGBTransferFunc(true);
    e.setDebug(false);
    const out = new Uint8Array(w * h + 1024 * 1024);
    const n = e.encode(out);
    if (!n) throw new Error(`texture encoder failed on a ${w} × ${h} picture`);
    return readKtx2(out.slice(0, n));
  } finally { e.delete(); }
}

/** A page's mip chain (premultiplied RGBA8, level 0 first) → one KTX2 (UASTC + zstd, premultiplied flag set). */
export function encodePage(M: BasisModule, mips: Img[], level = UASTC_SETTINGS.level): Uint8Array {
  const levels: Ktx2Level[] = [];
  let tpl: Ktx2 | null = null;
  for (const m of mips) {
    const r = encodeLevel(M, m, level);
    levels.push(r.level);
    tpl ??= r.file;
  }
  return writeKtx2({ ...tpl!, width: mips[0].w, height: mips[0].h, levels }, { premultiplied: true });
}

/** A page's encode split into independent jobs (strips of ≤ `stripPx` pixels, whole block rows) so several threads
 *  share even a single big page; assemblePage() joins their results. Identical to one whole-level encode: UASTC
 *  blocks are encoded on their own (no RDO). */
export interface StripJob { level: number; y: number; w: number; h: number; px: Uint8Array }
export function planPage(mips: Img[], stripPx = 1 << 20): StripJob[] {
  const jobs: StripJob[] = [];
  mips.forEach((m, level) => {
    const rows = Math.max(4, Math.floor(Math.min(stripPx, ENCODE_GUARD) / m.w / 4) * 4);
    for (let y = 0; y < m.h; y += rows) { const h = Math.min(rows, m.h - y); jobs.push({ level, y, w: m.w, h, px: m.data.subarray(y * m.w * 4, (y + h) * m.w * 4) }); }
  });
  return jobs;
}
/** One strip → its KTX2 bytes (one level). */
export function encodeStrip(M: BasisModule, px: Uint8Array, w: number, h: number, level = UASTC_SETTINGS.level): Uint8Array {
  return writeKtx2(encodeOne(M, px, w, h, level));
}
/** Join the strips' KTX2 files (any order) into the page's KTX2. */
export function assemblePage(mips: Img[], jobs: StripJob[], results: Uint8Array[]): Uint8Array {
  const per = mips.map(() => [] as { y: number; l: Ktx2Level }[]);
  let tpl: Ktx2 | null = null;
  jobs.forEach((j, i) => { const k = readKtx2(results[i]); tpl ??= k; per[j.level].push({ y: j.y, l: k.levels[0] }); });
  const levels = per.map((p) => joinLevel(p.sort((a, b) => a.y - b.y).map((x) => x.l)));
  return writeKtx2({ ...tpl!, width: mips[0].w, height: mips[0].h, levels }, { premultiplied: true });
}

/** Why a page's reported size can't be right (null = fine): pages are at most PAGE px on a side with at most their full
 *  mip chain, and no level holds more bytes than the page's level 0 in `target` (4 × 4 blocks of 16 bytes, or RGBA8).
 *  The transcoder's sizes come from the file: a damaged or crafted cache file must not make us allocate gigabytes. */
export function checkTranscodedSize(w: number, h: number, levels: number, bytes: number, target: GpuTarget): string | null {
  if (!(w >= 1 && h >= 1 && w <= PAGE && h <= PAGE)) return 'a compressed texture page has an impossible size';
  if (!(levels >= 1 && levels <= Math.floor(Math.log2(Math.max(w, h))) + 1)) return 'a compressed texture page has an impossible number of levels';
  const most = target === 'rgba' ? w * h * 4 : Math.ceil(w / 4) * Math.ceil(h / 4) * 16;
  if (!(bytes >= 0 && bytes <= most)) return 'a compressed texture page is damaged';
  return null;
}

/** A KTX2 page → every level in `target` (level 0 first). Throws a plain Error when the file can't be read. */
export function transcodePage(M: BasisModule, ktx2: Uint8Array, target: GpuTarget): { width: number; height: number; levels: Uint8Array[] } {
  const f = new M.KTX2File(ktx2);
  try {
    if (!f.isValid() || !f.startTranscoding()) throw new Error('a compressed texture page is damaged');
    const fmt = M.transcoder_texture_format[TARGET_TF[target]].value;
    const hq = target === 'etc2' || target === 'bc3' ? M.basisu_decode_flags.cDecodeFlagsHighQuality.value : 0;
    const levels: Uint8Array[] = [];
    const W = f.getWidth(), H = f.getHeight(), L = f.getLevels();
    const bad = checkTranscodedSize(W, H, L, 0, target);
    if (bad) throw new Error(bad);
    for (let i = 0; i < L; i++) {
      const n = f.getImageTranscodedSizeInBytes(i, 0, 0, fmt);
      const why = checkTranscodedSize(W, H, L, n, target);
      if (why) throw new Error(why);
      const dst = new Uint8Array(n);
      if (!f.transcodeImageWithFlags(dst, i, 0, 0, fmt, hq, -1, -1)) throw new Error('a compressed texture page could not be converted for this graphics chip');
      levels.push(dst);
    }
    return { width: f.getWidth(), height: f.getHeight(), levels };
  } finally { f.close(); f.delete(); }
}
