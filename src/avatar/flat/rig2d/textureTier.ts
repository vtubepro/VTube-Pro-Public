// THE hook where a loaded 2D model's texture pages are chosen and prepared for this device (HQ decision #10). Owner:
// high-quality models (8K, 16K, multi-page atlases) are accepted and compressed, never refused.
// Called once per load by src/avatar/flat/rig2d/source.ts loadRig2D, before anything is uploaded (and again by a
// re-pick when the picture grows: hysteresis in shared/rig2d/gpu/pick.ts). The renderer
// (src/avatar/flat/rig2d/renderer.ts) uploads both page kinds; every mesh is drawn from one page.
//   1. The model's tier cache (shared/rig2d/gpu/cache.ts, made by the helper in the background: server/gpuTiers.ts) is
//      found by its key. Missing → the helper is asked to make it, and this load uses the original pictures.
//   2. Per texture, the tier the picture's on-screen size needs (≥ 1 texel per output pixel), within MAX_TEXTURE_SIZE
//      and the device's texture budget (shared/rig2d/gpu/pick.ts).
//   3. Its pages (KTX2 UASTC + zstd) are transcoded in a worker to ASTC 4×4 / BC7 / ETC2 RGBA (whichever this GPU
//      takes, probed on the live context: src/mobile/device.ts), else RGBA8.
//   4. "Keep full quality" (profile flat.opts.fullQuality: true, or texture indices such as the face's) draws those
//      textures from the original pictures, uncompressed.
// The original-picture path (no cache yet, or full quality) decodes each picture scaled to what the screen needs, the
// device's MAX_TEXTURE_SIZE and its decode budget (textureBudget.ts decodeScaleFor): a model always loads, never black.
import type { Rig2DDoc } from '../../../../shared/rig2d/format.ts';
import { decodeScaleFor } from './textureBudget.ts';
import { RigEval } from '../../../../shared/rig2d/evaluate.ts';
import { cacheKey, type CacheManifest } from '../../../../shared/rig2d/gpu/cache.ts';
import { TAIL, mergeTiers, type TierLayout } from '../../../../shared/rig2d/gpu/layout.ts';
import { bestTarget, pickTiers, textureBudget, texelDensity, TARGET } from '../../../../shared/rig2d/gpu/pick.ts';
import { TARGET_BPP, TARGET_GL, type GpuTarget } from '../../../../shared/rig2d/gpu/basis.ts';
import type { DrawLayout } from './renderer.ts';
import { transcodeKtx2 } from './gpuTextures.ts';

/** What the page knows about the device (src/mobile/device.ts textureDevice()). */
export interface TextureDevice {
  /** WebGL MAX_TEXTURE_SIZE of this page's graphics chip */
  maxTexture: number;
  /** GPU compressed formats this page can upload (WebGL 2 extensions) */
  compressed: { astc: boolean; bc7: boolean; etc2: boolean };
  /** the browser draws 3D in software (SwiftShader / llvmpipe): pixels are expensive */
  software: boolean;
  /** the picture this model is drawn at, px (its height on this page) */
  outputPx: number;
  /** a phone / small touch tablet, or anything else */
  deviceClass: 'phone' | 'desktop';
  /** the user chose "Reload in low detail" after a graphics-memory crash (src/mobile/lowDetail.ts) */
  lowDetail: boolean;
  /** navigator.deviceMemory (GB) when the browser tells it */
  memoryGB?: number;
}

/** One texture page ready to upload. `compressed`: transcoded GPU blocks (e.g. from KTX2), `format` = the WebGL
 *  internal-format enum (COMPRESSED_RGBA_ASTC_4x4_KHR …), `levels[0]` = full size, then each mip level (all levels
 *  given: the renderer does not generate mips for them). Colours premultiplied, like the RGBA8 pages. */
export type TexturePage =
  | { kind: 'image'; image: ImageBitmap }
  | { kind: 'compressed'; format: number; width: number; height: number; levels: Uint8Array[] };

/** Where the pages came from (the studio's 2D panel, diagnostics, tests). */
export interface TierInfo {
  /** 'compressed': every texture from the tier cache; 'mixed': some from the original pictures (full quality / no
   *  fitting tier); 'original': no cache (yet) */
  status: 'compressed' | 'mixed' | 'original';
  /** the cache is being made (or was just requested) */
  building: boolean;
  key: string;
  target: GpuTarget;
  /** per texture: the tier used (0 = full size, 1 = half …), −1 = the original picture */
  tiers: number[];
  /** texture memory of the pages, bytes (with mip chains) */
  vram: number;
  /** per texture: texels per output pixel of what is drawn */
  texelsPerPx: number[];
  ms: number;
  /** the cache's plain sentence (its sharpest tier left out for lack of memory: server/gpuBudget.ts) */
  note?: string;
}

/** The doc to draw and one page per draw-layout page (`layout` absent = one page per doc texture, meshes as they are). */
export interface TextureTier { doc: Rig2DDoc; pages: TexturePage[]; layout?: DrawLayout; info?: TierInfo }

/** Where the tier cache is read (the avatar's own folder over HTTP / OPFS, or a party bundle in RAM). */
export interface TierCache {
  read(rel: string): Promise<Uint8Array | null>;
  /** ask for the cache to be made (own avatars with a helper); absent = can't */
  request?(key: string): void;
}
export interface TierOptions {
  buffers: readonly Uint8Array[];
  cache?: TierCache | null;
  /** "Keep full quality": every texture, or these texture indices, from the original pictures */
  fullQuality?: boolean | number[];
  /** the previous choice (re-pick with hysteresis) */
  prev?: number[];
}

const mime = (f: string) => (/\.webp$/i.test(f) ? 'image/webp' : /\.jpe?g$/i.test(f) ? 'image/jpeg' : 'image/png');
const dec = new TextDecoder();

/** Choose + prepare the texture pages for this device. `files` = the .vtp2's files (archive path → bytes). */
export async function pickTextureTier(doc: Rig2DDoc, files: Map<string, Uint8Array>, device: TextureDevice, o?: TierOptions): Promise<TextureTier> {
  const t0 = performance.now();
  // (tests only: globalThis.__vtpHiqForce = { tiers?: per-texture tier or −1, target?: 'rgba' … } — tools/hiq_e2e.mts)
  const force = (globalThis as { __vtpHiqForce?: { tiers?: number[]; target?: GpuTarget; seam?: 'cut' | 'uncut' } }).__vtpHiqForce;
  const target = force?.target ?? bestTarget(device.compressed, device.software);
  const budget = textureBudget(device);
  const nTex = doc.textures.length;
  // demand: texels per model unit of each texture, and output px per model unit
  let density: number[] = new Array(nTex).fill(0), pxPerUnit = 1;
  if (o?.buffers) {
    try {
      const ev = new RigEval(doc, o.buffers);
      ev.update();
      density = texelDensity(doc, o.buffers, ev.out.positions);
      const b = ev.bounds(), hU = Math.max(1e-6, (b[3] - b[1]) * 1.06);
      pxPerUnit = device.outputPx / hU;
    } catch { /* unknown demand: full size */ }
  }
  const full = (t: number) => o?.fullQuality === true || (Array.isArray(o?.fullQuality) && o!.fullQuality.includes(t)) || force?.tiers?.[t] === -1;
  // the tier cache
  let key = '', man: CacheManifest | null = null, building = false;
  const layouts = new Map<number, TierLayout>();
  if (o?.cache && o.buffers) {
    try {
      key = cacheKey(doc, o.buffers, files);
      const m = await o.cache.read(`gpu/${key}/manifest.json`);
      man = m ? JSON.parse(dec.decode(m)) as CacheManifest : null;
      if (!man || man.status !== 'done') { building = man?.status !== 'failed'; if (!man) o.cache.request?.(key); }
    } catch { man = null; }
  }
  const ready = man ? man.tiers.filter((t) => t.done) : [];
  let choice: number[] = new Array(nTex).fill(-1);
  if (ready.length) {
    choice = pickTiers(ready.map((t) => ({ k: t.k, pages: t.pages.map((p) => ({ source: p.source, w: p.w, h: p.h })) })), density, pxPerUnit,
      { maxTexture: device.maxTexture, target, budget }, o?.prev);
    if (force?.tiers) choice = choice.map((c, t) => { const f = force.tiers![t] ?? c; return f < 0 || ready.some((x) => x.k === f) ? f : c; });
    for (let t = 0; t < nTex; t++) if (full(t)) choice[t] = -1;
    for (const k of new Set(choice.filter((k) => k >= 0))) {
      const lf = await o!.cache!.read(`gpu/${key}/${man!.tiers.find((t) => t.k === k)!.layout}`);
      if (!lf) { choice = choice.map((c) => (c === k ? -1 : c)); continue; }
      layouts.set(k, JSON.parse(dec.decode(lf)) as TierLayout);
      // a tier with repacked pages reads its coarse mip levels from tier k + TAIL (renderer.ts art()): load that layout too
      const lk = layouts.get(k)!, tk = k + TAIL, tt = ready.find((t) => t.k === tk);
      if (lk.pages.some((p) => p.rects) && tt && !layouts.has(tk)) {
        const tf = await o!.cache!.read(`gpu/${key}/${tt.layout}`);
        if (tf) layouts.set(tk, JSON.parse(dec.decode(tf)) as TierLayout);
      }
    }
  }
  if (force?.seam && layouts.size) {
    // (tests only: the seam check's uncompressed repacked / original pages, tierDebug.ts)
    const { seamPages } = await import('./tierDebug.ts');
    const r = seamPages(doc, files, choice, layouts, force.seam);
    return { doc, pages: r.pages, layout: r.layout, info: { status: 'compressed', building: false, key, target: 'rgba', tiers: choice, vram: 0, texelsPerPx: [], ms: performance.now() - t0 } };
  }
  const merged = mergeTiers(doc, choice, layouts);
  const pages: TexturePage[] = [];
  let vram = 0;
  const texelsPerPx = density.map((d, t) => (choice[t] >= 0 ? d * 2 ** -choice[t] : d) / pxPerUnit);
  try {
    // the original pictures this load needs (no tier for them): decoded scaled to the screen's need, the device's
    // texture size and the decode budget
    const originals = new Set(merged.pages.filter((p) => p.k < 0).map((p) => p.t));
    const k0 = decodeScaleFor(doc.textures.filter((_, t) => originals.has(t)), device);
    for (const ref of merged.pages) {
      if (ref.k < 0) {
        const tx = doc.textures[ref.t], b = files.get(tx.file);
        if (!b) throw new Error(`${tx.file} is missing`);
        // screen need: keep ≥ 2× TARGET texels per output px (one tier of margin), unless "full quality"
        // (only for pictures over 4096 px: a usual model keeps drawing exactly as it did before tiers existed)
        const need = !full(ref.t) && density[ref.t] > 0 && Math.max(tx.width, tx.height) > 4096 ? Math.min(1, 2 * TARGET * pxPerUnit / density[ref.t]) : 1;
        const s = Math.min(k0, need, device.maxTexture / Math.max(tx.width, tx.height));
        const w = Math.max(1, Math.round(tx.width * s)), h = Math.max(1, Math.round(tx.height * s));
        const image = await createImageBitmap(new Blob([b.slice()], { type: mime(tx.file) }), { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none',
          ...(s < 1 ? { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' as const } : {}) });
        pages.push({ kind: 'image', image });
        vram += image.width * image.height * 4 * 4 / 3;
        texelsPerPx[ref.t] = density[ref.t] * (image.width / tx.width) / pxPerUnit;
        continue;
      }
      const tier = man!.tiers.find((t) => t.k === ref.k)!, pf = tier.pages[ref.i];
      const ktx = await o!.cache!.read(`gpu/${key}/${pf.file}`);
      if (!ktx) throw new Error('a compressed texture page is missing');
      const r = await transcodeKtx2(ktx, target, device.deviceClass === 'phone' ? 1 : 2);
      vram += r.levels.reduce((s, l) => s + l.length, 0);
      // (no compressed format here: RGBA8 levels, still the tier's size and its own mip chain)
      pages.push({ kind: 'compressed', format: TARGET_GL[target], width: r.width, height: r.height, levels: r.levels });
    }
  } catch (e) {
    for (const p of pages) if (p.kind === 'image') p.image.close();
    // a broken / missing cache page never stops the model: the original pictures, as before tiers existed
    if (merged.pages.some((p) => p.k >= 0)) {
      console.warn(`[rig2d] compressed textures unusable (${(e as Error).message}); drawing the original pictures`);
      return pickTextureTier(doc, files, device, { ...o!, cache: null });
    }
    throw e;
  }
  const status: TierInfo['status'] = merged.pages.every((p) => p.k >= 0) ? 'compressed' : merged.pages.some((p) => p.k >= 0) ? 'mixed' : 'original';
  void TARGET_BPP;
  return {
    doc, pages,
    layout: { meshes: merged.meshes, texPage: merged.texPage, pageSource: merged.pageSource, pageTail: merged.pageTail, tailScale: merged.tailScale, pageUv: merged.pageUv },
    info: { status, building, key, target, tiers: choice, vram: Math.round(vram), texelsPerPx, ms: performance.now() - t0, ...(man?.note ? { note: man.note } : {}) },
  };
}
