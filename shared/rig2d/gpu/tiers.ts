// Build a 2D model's texture tier cache (shared/rig2d/gpu/cache.ts): for every tier, the page layout and every page as
// KTX2 (UASTC + zstd, premultiplied, own box mip chain). Environment-free: the helper's child process
// (server/gpuTiersChild.ts: Node PNG decode, encoding on worker threads) and a browser worker (web / phone imports
// without the helper) supply decode / encode / write. One source texture is decoded at a time; its tier pictures are
// halvings of it (exact premultiplied area averages); small tiers are queued first, so phones get theirs soonest.
import type { Rig2DDoc } from '../format.ts';
import { blit, half, mipChain, resampleArea, type Img } from './image.ts';
import { TAIL, type Page } from './layout.ts';
import { layoutTier, type TierLayout } from './layout.ts';
import { PIPELINE, layoutFile, pageFile, tiersFor, type CacheManifest, type CacheTier } from './cache.ts';

export interface BuildIO {
  /** The texture's pixels, PREMULTIPLIED RGBA8, at tier `k0` (k0 halvings: a phone decodes straight to its small
   *  size, e.g. with shared/rig2d/gpu/image.ts RowShrinker). */
  decode(file: string, bytes: Uint8Array, k0: number): Promise<Img>;
  /** A page's mip chain (premultiplied RGBA8, level 0 first, GPU level sizes) → its KTX2 file. */
  encode(mips: Img[], at: { k: number; page: number }): Promise<Uint8Array>;
  /** Store a cache file (path relative to the key folder). */
  write(rel: string, bytes: Uint8Array): Promise<void>;
  /** How many pages may wait for / be in encoding at once (memory bound). */
  inflight?: number;
  progress?(done: number, total: number): void;
  /** Stop early (the model was deleted / the helper is shutting down): throws 'stopped'. */
  stopped?(): boolean;
  /** tiers left out of this build (not enough free memory: server/gpuBudget.ts) and the sentence that says so */
  notes?: { skipped: number[]; note: string };
}

const json = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

/** Build the tiers `ks` (default: all, shared/rig2d/gpu/cache.ts tiersFor). Resolves the final manifest. */
export async function buildTiers(doc: Rig2DDoc, buffers: readonly Uint8Array[], files: ReadonlyMap<string, Uint8Array>, key: string, io: BuildIO,
  ks: number[] = tiersFor(doc)): Promise<CacheManifest> {
  const t0 = Date.now();
  ks = [...new Set(ks)].sort((a, b) => b - a);   // smallest tier first
  const layouts = new Map<number, TierLayout>(ks.map((k) => [k, layoutTier(doc, buffers, k)]));
  for (const [k, l] of layouts) await io.write(layoutFile(k), json(l));
  const tiers: CacheTier[] = ks.map((k) => {
    const l = layouts.get(k)!;
    return { k, scale: l.scale, layout: layoutFile(k), pages: l.pages.map((p, i) => ({ file: pageFile(k, i), w: p.w, h: p.h, bytes: 0, source: p.source })), done: false };
  });
  const man: CacheManifest = { key, pipeline: PIPELINE, status: 'building', tiers, seconds: {}, at: new Date().toISOString(), ...(io.notes ? { skipped: io.notes.skipped, note: io.notes.note } : {}) };
  let writing = Promise.resolve();
  const saveManifest = () => (writing = writing.then(() => io.write('manifest.json', json(man))));
  await saveManifest();
  const left = new Map<number, number>(tiers.map((t) => [t.k, t.pages.length]));
  const total = tiers.reduce((s, t) => s + t.pages.length, 0);
  let done = 0;
  const inflight = new Set<Promise<void>>();
  const limit = Math.max(1, io.inflight ?? 4);
  const tierStart = new Map<number, number>();
  const finishTier = (k: number) => {
    const t = tiers.find((x) => x.k === k)!;
    t.done = true;
    man.seconds![`t${k}`] = Math.round((Date.now() - (tierStart.get(k) ?? t0)) / 100) / 10;
    return saveManifest();
  };
  for (const k of ks) if (!left.get(k)) await finishTier(k);
  const k0 = Math.min(...ks), kMax = Math.max(...ks);
  for (let ti = 0; ti < doc.textures.length; ti++) {
    const pagesOf = ks.map((k) => ({ k, pages: layouts.get(k)!.pages.map((p, i) => ({ p, i })).filter((x) => x.p.source === ti) }));
    if (!pagesOf.some((x) => x.pages.length)) continue;
    const tx = doc.textures[ti], bytes = files.get(tx.file);
    if (!bytes) throw new Error(`${tx.file} is missing`);
    if (io.stopped?.()) throw new Error('stopped');
    // the tier pictures k0..kMax of this texture (premultiplied)
    const imgs = new Map<number, Img>();
    let img = await io.decode(tx.file, bytes, k0);
    for (let k = k0; k <= kMax; k++) { if (k > k0) img = half(img); imgs.set(k, img); }
    for (const { k, pages } of pagesOf) {
      tierStart.set(k, tierStart.get(k) ?? Date.now());
      const src = imgs.get(k)!;
      // pages repacked from this picture take every mip level from the WHOLE picture's mip chain (the copy of each
      // region at each level, its surroundings included), so a page's deep levels match the original's at every gutter
      let chain: Img[] | null = null;
      for (const { p, i } of pages) {
        let mips: Img[];
        if (!p.rects) {
          let pg = src; while (pg.w > p.w || pg.h > p.h) pg = half(pg);
          // (padded to the page's whole 4 × 4 blocks: layout.ts; blit repeats the edge pixels into the padding)
          if (pg.w !== p.w || pg.h !== p.h) { const pad: Img = { w: p.w, h: p.h, data: new Uint8Array(p.w * p.h * 4) }; blit(pg, 0, 0, p.w, p.h, pad, 0, 0); pg = pad; }
          mips = mipChain(pg);
        }
        else { chain ??= mipChain(src); mips = pageMips(p, chain).slice(0, TAIL + 1); }
        while (inflight.size >= limit) await Promise.race(inflight);
        if (io.stopped?.()) throw new Error('stopped');
        const job: Promise<void> = io.encode(mips, { k, page: i }).then(async (ktx) => {
          tiers.find((x) => x.k === k)!.pages[i].bytes = ktx.length;   // (before writing: a writer may take the buffer)
          await io.write(pageFile(k, i), ktx);
          done++; io.progress?.(done, total);
          const n = left.get(k)! - 1; left.set(k, n);
          if (!n) await finishTier(k);
        }).finally(() => inflight.delete(job));
        inflight.add(job);
      }
      imgs.delete(k);   // (this tier's picture is no longer needed by this texture)
    }
  }
  await Promise.all(inflight);
  man.status = 'done';
  man.seconds!.total = Math.round((Date.now() - t0) / 100) / 10;
  await saveManifest();
  await writing;
  return man;
}

/** A repacked page's mip levels: level L copies each region from level L of the whole picture's chain (offsets divided by
 *  2^L: exact while the 16 px alignment divides, ≤ half a texel off below that). */
export function pageMips(p: Page, chain: Img[]): Img[] {
  const out: Img[] = [];
  for (let L = 0; ; L++) {
    const w = Math.max(1, p.w >> L), h = Math.max(1, p.h >> L), lv: Img = { w, h, data: new Uint8Array(w * h * 4) }, src = chain[Math.min(L, chain.length - 1)], f = 2 ** L;
    for (const r of p.rects!) {
      const dx = Math.floor(r.dx / f), dy = Math.floor(r.dy / f);
      const rw = Math.min(w - dx, Math.ceil((r.dx + r.w) / f) - dx), rh = Math.min(h - dy, Math.ceil((r.dy + r.h) / f) - dy);
      // (a region stored smaller: this level's source, area-averaged at the same scale)
      if (r.s) resampleArea(src, r.sx / f, r.sy / f, r.s, rw, rh, lv, dx, dy);
      else blit(src, Math.floor(r.sx / f), Math.floor(r.sy / f), rw, rh, lv, dx, dy);
    }
    out.push(lv);
    if (w === 1 && h === 1) return out;
  }
}
