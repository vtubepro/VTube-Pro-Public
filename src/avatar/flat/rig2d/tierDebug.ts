// Tests only (tools/hiq_e2e.mts seam check, via globalThis.__vtpHiqForce.seam): texture pages made in the page from the
// ORIGINAL pictures, uncompressed, with our own mip chains, either repacked by the tier layout ('cut') or whole
// ('uncut'). Both have the very same texels and mip levels (except meshes stored scaled, which the check leaves out), so
// any difference between the two renders is the repacking itself and nothing else. Never loaded by a normal page.
import type { Rig2DDoc } from '../../../../shared/rig2d/format.ts';
import { decodePng } from '../../../../shared/rig2d/gpu/png.ts';
import { half, mipChain, premultiply, type Img } from '../../../../shared/rig2d/gpu/image.ts';
import { TAIL, mergeTiers, type TierLayout } from '../../../../shared/rig2d/gpu/layout.ts';
import { pageMips } from '../../../../shared/rig2d/gpu/tiers.ts';
import type { TexturePage } from './textureTier.ts';

const RGBA8 = 0x8058;
const levelsOf = (mips: Img[]): TexturePage => ({ kind: 'compressed', format: RGBA8, width: mips[0].w, height: mips[0].h, levels: mips.map((m) => m.data) });

export function seamPages(doc: Rig2DDoc, files: Map<string, Uint8Array>, choice: number[], layouts: ReadonlyMap<number, TierLayout>, mode: 'cut' | 'uncut') {
  const merged = mergeTiers(doc, mode === 'cut' ? choice : choice.map(() => -1), layouts);
  const pages: TexturePage[] = new Array(merged.pages.length);
  doc.textures.forEach((tx, t) => {
    const k = Math.max(0, choice[t] ?? 0);
    let img: Img = decodePng(files.get(tx.file)!);
    premultiply(img.data);
    for (let i = 0; i < k; i++) img = half(img);
    const chain = mipChain(img);
    merged.pages.forEach((ref, pi) => {
      if (ref.t !== t) return;
      const p = ref.k >= 0 ? layouts.get(ref.k)!.pages[ref.i] : null;
      // a tail page (tier k + TAIL of this texture): the chain from level TAIL on (the same picture, coarser)
      if (ref.k > k && p && !p.rects) { pages[pi] = levelsOf(chain.slice(ref.k - k)); return; }
      if (!p || !p.rects) { let pg = img; while (p && (pg.w > p.w || pg.h > p.h)) pg = half(pg); pages[pi] = levelsOf(pg === img ? chain : mipChain(pg)); }
      else pages[pi] = levelsOf(pageMips(p, chain).slice(0, TAIL + 1));
    });
  });
  // (uncut: a tier picture smaller than the original keeps the original's UVs: the texture is the same picture)
  return { pages, layout: { meshes: merged.meshes, texPage: merged.texPage, pageSource: merged.pageSource, pageTail: merged.pageTail, tailScale: merged.tailScale } };
}
