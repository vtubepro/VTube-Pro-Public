// The texture tier builder for a page WITHOUT VTube Pro's server (the browser-only mobile pack): runs inside the texture worker
// (gpuTexWorker.ts), single-threaded (no cross-origin isolation needed), one page at a time. Only tiers whose pictures
// are ≤ 4096 px are made here (what phones and a 1080p picture use); a texture bigger than that is read row by row and
// area-shrunk while reading (shared/rig2d/gpu/image.ts RowShrinker), so a phone never holds an 8192 / 16384 picture.
// Each finished file goes back to the page, which stores it beside the model through the browser store chain
// (src/avatar/flat/rig2d/tierStore.ts). The cache is a convenience: evicted, it is made again.
import { readVtp2, browserInflateRaw } from '../../../../shared/rig2d/container.ts';
import { buildTiers } from '../../../../shared/rig2d/gpu/tiers.ts';
import { cacheKey, tiersFor } from '../../../../shared/rig2d/gpu/cache.ts';
import { pngInfo, readPngRows } from '../../../../shared/rig2d/gpu/png.ts';
import { RowShrinker, mipChain, premultiply, type Img } from '../../../../shared/rig2d/gpu/image.ts';
import { assemblePage, encodeStrip, planPage, type BasisModule } from '../../../../shared/rig2d/gpu/basis.ts';
import { webPictureFacts, webRefusal } from './webBudget.ts';

/** The biggest tier side made in the browser. */
export const WEB_TIER_MAX = 4096;

/** Decode at tier k0 → premultiplied RGBA8. PNG: streamed rows; JPEG / WebP: the browser's decoder, resized. */
async function decodeAt(file: string, bytes: Uint8Array, k0: number): Promise<Img> {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    const { w, h } = pngInfo(bytes);
    const sh = new RowShrinker(w, h, k0);
    readPngRows(bytes, (y, row) => sh.push(y, row));
    return sh.out;
  }
  const type = /\.webp$/i.test(file) ? 'image/webp' : 'image/jpeg';
  const probe = await createImageBitmap(new Blob([bytes.slice()], { type }));
  const w = Math.max(1, Math.ceil(probe.width / 2 ** k0)), h = Math.max(1, Math.ceil(probe.height / 2 ** k0));
  probe.close();
  const bm = await createImageBitmap(new Blob([bytes.slice()], { type }), { resizeWidth: w, resizeHeight: h, resizeQuality: 'high', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const c = new OffscreenCanvas(w, h), g = c.getContext('2d')!;
  g.drawImage(bm, 0, 0); bm.close();
  const data = new Uint8Array(g.getImageData(0, 0, w, h).data.buffer);
  return { w, h, data: premultiply(data) };
}

/** Build the ≤ 4096 tiers of `model` (the .vtp2 bytes) for avatar `id` into OPFS. Resolves the key and tier list. */
export async function buildTiersWeb(M: BasisModule, model: Uint8Array, wantKey: string, progress: (done: number, of: number) => void,
  write: (rel: string, bytes: Uint8Array) => Promise<void>): Promise<{ key: string; tiers: number[] }> {
  const r = await readVtp2(model, browserInflateRaw);
  if (!r.ok) throw new Error(r.error);
  const { doc, buffers, files } = r.pkg;
  const key = cacheKey(doc, buffers, files);
  if (wantKey && key !== wantKey) throw new Error('the model changed while its textures were being prepared');
  // an interlaced (Adam7) PNG is read whole at full size: when that doesn't fit this device, build nothing (webBudget.ts)
  const texs = doc.textures.map((t) => webPictureFacts(t, files.get(t.file)));
  const refuse = webRefusal(texs, typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { deviceMemory?: number }).deviceMemory);
  if (refuse) throw new Error(refuse);
  // (sized from the files too: the decoder shrinks each file's own size, whatever the document says)
  const side = Math.max(1, ...texs.map((t) => Math.max(t.width, t.height)));
  const ks = tiersFor(doc).filter((k) => Math.ceil(side / 2 ** k) <= WEB_TIER_MAX);
  // (a document that says its pictures are far smaller than they are: no tier fits, so nothing is built; the model
  // keeps drawing from its original pictures)
  if (!ks.length) throw new Error('this model\'s pictures are bigger than the model says, so lighter versions aren\'t made in the browser');
  await buildTiers(doc, buffers, files, key, {
    decode: (file, b, k0) => decodeAt(file, b, k0),
    encode: async (mips) => { const jobs = planPage(mips); return assemblePage(mips, jobs, jobs.map((j) => encodeStrip(M, j.px, j.w, j.h))); },
    write,
    inflight: 1,
    progress,
  }, ks);
  return { key, tiers: ks };
}
