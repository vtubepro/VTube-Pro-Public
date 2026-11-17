// Texture pages of a 2D model at one resolution tier (HQ decision #10): every GPU page is at most PAGE px (4096: every
// WebGL 2 device takes it, while 24 % of Android phones stop at 4096). A texture that fits (at this tier) is one page,
// as it is. A bigger one (8192 / 16384 at the full tier) is repacked into pages WITHOUT ever cutting a mesh:
//   1. each mesh's UV box (in tier px) is a region; regions closer than the gutter merge into clusters while a cluster
//      still fits a page;
//   2. a cluster is copied whole with GUTTER px of its real surroundings (bilinear and the first mip levels then read
//      exactly what they read in the original picture) and its meshes' UVs move with it (one exact affine map per mesh:
//      same scale, whole-pixel offset aligned to ALIGN px so mip / block grids coincide);
//   3. a single mesh whose own picture is bigger than a page at this tier is stored smaller (PageRect.s, area-averaged)
//      to fill one page: no picture is drawn taller than 4096 px, so it still gives about one texel per output pixel.
//      Every mesh is therefore drawn exactly as uncut (one page, one affine map, the same triangles in the same draw);
//   4. a repacked page holds mip levels 0..TAIL; coarser levels come from the tail texture (tier k + TAIL, whole).
// Textures with sprite sheets, lighting maps, or used by attachments / particles stay whole (scaled further down if a
// page can't hold them). Pure + deterministic (Node builder and browser runtime agree): tools/hiq_layout_unit.ts.
import type { Rig2DDoc } from '../format.ts';
import { f32, viewArray } from '../container.ts';

export const PAGE = 4096;
export const GUTTER = 32;
export const ALIGN = 16;
/** A repacked page holds mip levels 0..TAIL only (exact: ALIGN = 2^TAIL keeps every copied region on the original's mip grid);
 *  coarser levels are read from the TAIL texture: the same texture at tier k + TAIL, one whole page (renderer.ts), so a
 *  strongly squashed mesh (a closed mouth or eye) samples exactly what it samples in the uncut picture. */
export const TAIL = 4;
/** Bumped when the layout rules change (part of the cache key). */
export const LAYOUT_VERSION = 10;   // 10: whole pages padded to 4 × 4 blocks; 2: regions merge only while they fit a page; 3: pieces carry their mesh's clamp box; 4: exact grid-corner vertices; 5: cut lines moved per cluster; 6: no clipping: whole triangles + a per-fragment core test; 7 (unreleased): crossing triangles from one tile; 8 (unreleased): no mesh is ever cut (an oversized one is stored scaled to one page); 9: such a page never rounds past 4096

/** A copy from the source texture's tier picture (sx, sy in tier px; may reach outside it: clamped) into a page: w × h
 *  page px at (dx, dy). `s` (< 1): a region too big for a page, stored smaller: the source is w / s × h / s tier px from
 *  (sx, sy), area-averaged down (shared/rig2d/gpu/image.ts resampleArea); absent = an exact copy. */
export interface PageRect { sx: number; sy: number; w: number; h: number; dx: number; dy: number; s?: number }
export interface Page {
  /** the doc texture it comes from */
  source: number;
  w: number; h: number;
  /** tier px per source px: 2^-k, or smaller for a whole texture that had to shrink to fit */
  scale: number;
  /** null = the whole tier picture (scaled to w × h) */
  rects: PageRect[] | null;
}
/** How one mesh draws: all of it on one page, its UVs mapped (u' = u·su + ou, v' = v·sv + ov); `s`: its region is
 *  stored smaller than this tier (PageRect.s) */
export type MeshMap = { page: number; uv: [number, number, number, number]; s?: number };
export interface TierLayout { version: number; tier: number; scale: number; pages: Page[]; meshes: MeshMap[] }

/** The tier picture's size (k halvings, each rounding up: shared/rig2d/gpu/image.ts half()). */
export const tierSize = (n: number, k: number) => { for (let i = 0; i < k; i++) n = Math.max(1, (n + 1) >> 1); return n; };

/** Textures that must stay one page (sprite sheets, lighting maps, attachments / particles). */
export function wholeTextures(doc: Rig2DDoc): Set<number> {
  const s = new Set<number>();
  doc.textures.forEach((t, i) => { if (t.sheet || t.normal || t.emission || t.rim) s.add(i); });
  for (const a of (doc as { attachments?: { texture: number }[] }).attachments ?? []) s.add(a.texture);
  for (const p of (doc as { particles?: { texture: number }[] }).particles ?? []) s.add(p.texture);
  return s;
}

interface Box { x0: number; y0: number; x1: number; y1: number }
const area = (b: Box) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const floorA = (x: number) => Math.floor(x / ALIGN) * ALIGN, ceilA = (x: number) => Math.ceil(x / ALIGN) * ALIGN;

/** The layout of tier `k` (scale 2^-k) with pages of at most `page` px. */
export function layoutTier(doc: Rig2DDoc, buffers: readonly Uint8Array[], k: number, page = PAGE): TierLayout {
  const scale = 2 ** -k;
  const whole = wholeTextures(doc);
  const pages: Page[] = [];
  const meshes: MeshMap[] = new Array(doc.meshes.length);
  const byTex = new Map<number, number[]>();
  doc.meshes.forEach((m, i) => { const l = byTex.get(m.texture) ?? []; l.push(i); byTex.set(m.texture, l); });
  doc.textures.forEach((tx, ti) => {
    const Tw = tierSize(tx.width, k), Th = tierSize(tx.height, k);
    const list = byTex.get(ti) ?? [];
    if ((Tw <= page && Th <= page) || whole.has(ti)) {
      // one page: the tier picture itself (or, forced whole and too big, shrunk further to fit)
      let w = Tw, h = Th, s = scale;
      while (w > page || h > page) { w = Math.max(1, (w + 1) >> 1); h = Math.max(1, (h + 1) >> 1); s /= 2; }
      // (the page is padded to whole 4 × 4 blocks: WebGL refuses a BC7 / ASTC texture whose base level isn't a multiple of
      //  4, which a maker-made atlas (any size) or its halvings usually aren't; the padding repeats the edge pixels)
      const w4 = Math.ceil(w / 4) * 4, h4 = Math.ceil(h / 4) * 4;
      const pi = pages.push({ source: ti, w: w4, h: h4, scale: s, rects: null }) - 1;
      // (u' = u · width·s / w4: exact even when halving rounded the picture's size up or the page was padded)
      for (const mi of list) meshes[mi] = { page: pi, uv: [tx.width * s / w4, tx.height * s / h4, 0, 0] };
      return;
    }
    // ---- regions: each mesh's UV box in tier px (v down), merged into clusters
    const uvOf = list.map((mi) => f32(buffers, doc.meshes[mi].uvs));
    const boxes: (Box & { meshes: number[] })[] = list.map((mi, j) => {
      const uv = uvOf[j];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let q = 0; q < uv.length; q += 2) { const x = uv[q] * tx.width * scale, y = uv[q + 1] * tx.height * scale; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (!Number.isFinite(x0)) x0 = y0 = x1 = y1 = 0;
      return { x0: Math.max(0, Math.min(Tw, x0)), y0: Math.max(0, Math.min(Th, y0)), x1: Math.max(0, Math.min(Tw, x1)), y1: Math.max(0, Math.min(Th, y1)), meshes: [mi] };
    });
    // merge regions whose gutters touch into clusters, but only while a cluster still fits one page: regions are moved
    // WHOLE (decision #10); a single region bigger than a page is stored smaller on one page (below), never cut
    const grow = (b: Box): Box => ({ x0: b.x0 - GUTTER, y0: b.y0 - GUTTER, x1: b.x1 + GUTTER, y1: b.y1 + GUTTER });
    const fitsPage = (b: Box) => b.x1 - b.x0 <= page - 2 * GUTTER - 2 * ALIGN && b.y1 - b.y0 <= page - 2 * GUTTER - 2 * ALIGN;
    let cl = boxes.slice().sort((p, q) => area(q) - area(p));
    for (let changed = true; changed;) {
      changed = false;
      const next: typeof cl = [];
      for (const r of cl) {
        const host = next.find((c) => overlaps(grow(c), grow(r)) && fitsPage({ x0: Math.min(c.x0, r.x0), y0: Math.min(c.y0, r.y0), x1: Math.max(c.x1, r.x1), y1: Math.max(c.y1, r.y1) }));
        if (host) { host.x0 = Math.min(host.x0, r.x0); host.y0 = Math.min(host.y0, r.y0); host.x1 = Math.max(host.x1, r.x1); host.y1 = Math.max(host.y1, r.y1); host.meshes.push(...r.meshes); changed = true; }
        else next.push({ ...r, meshes: [...r.meshes] });
      }
      cl = next;
    }
    // (deterministic order: by the first mesh)
    cl.sort((p, q) => Math.min(...p.meshes) - Math.min(...q.meshes));
    // each cluster → one rect: the cluster + GUTTER px of its real surroundings, 16 px-aligned. A cluster bigger than a
    // page (one mesh whose own picture is bigger than a page at this tier) is NOT cut: it is stored smaller, scaled to
    // fit one page (PageRect.s). No picture is drawn taller than 4096 px (source.ts outputCap), so a region of up to
    // REGION_MAX px still gives every output pixel about one texel; meshes are then always drawn exactly as uncut: one
    // page, one affine UV map, the same triangles in the same draw (drawing a mesh across pages showed one stray MSAA
    // sample per frame on Direct3D 11 where two overlapping meshes' page boundaries met: tools/hiq_e2e.mts --seam-only)
    interface Rect { sx: number; sy: number; w: number; h: number; s: number }
    const REGION_MAX = page - 2 * GUTTER;
    const rects: Rect[] = [];
    const clusterRect: number[] = [];
    for (const c of cl) {
      const cx0 = floorA(c.x0), cy0 = floorA(c.y0), cx1 = Math.max(cx0 + ALIGN, ceilA(c.x1)), cy1 = Math.max(cy0 + ALIGN, ceilA(c.y1));
      const cw = cx1 - cx0, ch = cy1 - cy0;
      if (cw <= REGION_MAX && ch <= REGION_MAX) {
        clusterRect.push(rects.push({ sx: cx0 - GUTTER, sy: cy0 - GUTTER, w: cw + 2 * GUTTER, h: ch + 2 * GUTTER, s: 1 }) - 1);
        continue;
      }
      // scaled: REGION_MAX px on its longer side (+ GUTTER page px of real surroundings, read at the same scale)
      const sc = REGION_MAX / Math.max(cw, ch);
      // (− 1e-6: cw · sc is REGION_MAX up to rounding, and one px more would round the page up past PAGE)
      const w = ceilA(Math.ceil(cw * sc - 1e-6) + 2 * GUTTER), h = ceilA(Math.ceil(ch * sc - 1e-6) + 2 * GUTTER);
      clusterRect.push(rects.push({ sx: cx0 - GUTTER / sc, sy: cy0 - GUTTER / sc, w, h, s: sc }) - 1);
    }
    // ---- pack rects into pages (shelves, tallest first; positions multiples of ALIGN)
    const order = rects.map((_, i) => i).sort((a, b) => rects[b].h - rects[a].h || rects[b].w - rects[a].w || a - b);
    const placed: { page: number; dx: number; dy: number }[] = new Array(rects.length);
    const open: { pi: number; shelves: { y: number; h: number; x: number }[]; used: number }[] = [];
    for (const ri of order) {
      const r = rects[ri];
      let done = false;
      for (const pg of open) {
        for (const sh of pg.shelves) if (r.h <= sh.h && sh.x + r.w <= page) { placed[ri] = { page: pg.pi, dx: sh.x, dy: sh.y }; sh.x += r.w; done = true; break; }
        if (done) break;
        if (pg.used + r.h <= page && r.w <= page) { pg.shelves.push({ y: pg.used, h: r.h, x: r.w }); placed[ri] = { page: pg.pi, dx: 0, dy: pg.used }; pg.used += r.h; done = true; break; }
      }
      if (!done) {
        const pi = pages.push({ source: ti, w: 0, h: 0, scale, rects: [] }) - 1;
        open.push({ pi, shelves: [{ y: 0, h: r.h, x: r.w }], used: r.h });
        placed[ri] = { page: pi, dx: 0, dy: 0 };
      }
    }
    rects.forEach((r, ri) => {
      const p = pages[placed[ri].page];
      p.rects!.push({ sx: r.sx, sy: r.sy, w: r.w, h: r.h, dx: placed[ri].dx, dy: placed[ri].dy, ...(r.s !== 1 ? { s: r.s } : {}) });
      p.w = Math.max(p.w, placed[ri].dx + r.w); p.h = Math.max(p.h, placed[ri].dy + r.h);
    });
    // (page sizes: multiples of ALIGN, so of the 4 × 4 compressed blocks; before any UV is mapped onto them)
    for (const p of pages) if (p.source === ti && p.rects) { p.w = ceilA(p.w); p.h = ceilA(p.h); }
    // ---- meshes: one affine UV map each (page x = dx + (X − sx) · s, X = u · the tier picture's width)
    const sxT = tx.width * scale, syT = tx.height * scale;
    cl.forEach((c, ci) => {
      const ri = clusterRect[ci], pl = placed[ri], p = pages[pl.page], r = rects[ri];
      for (const mi of c.meshes) meshes[mi] = { page: pl.page, uv: [sxT * r.s / p.w, syT * r.s / p.h, (pl.dx - r.sx * r.s) / p.w, (pl.dy - r.sy * r.s) / p.h], ...(r.s !== 1 ? { s: r.s } : {}) };
    });
  });
  for (let i = 0; i < meshes.length; i++) meshes[i] ??= { page: 0, uv: [1, 1, 0, 0] };
  return { version: LAYOUT_VERSION, tier: k, scale, pages, meshes };
}

/** Total page pixels of a layout (VRAM math: × bytes per pixel × 4/3 for mips). */
export const layoutPixels = (l: TierLayout) => l.pages.reduce((s, p) => s + p.w * p.h, 0);

/** A page of a merged draw layout: page i of tier k, or (k = −1) texture t drawn from its original picture. */
export type PageRef = { k: number; i: number; t: number };

/** One draw layout from per-texture tier choices (shared/rig2d/gpu/pick.ts pickTiers; −1 = the original picture):
 *  pages of each chosen tier that hold that texture, meshes mapped onto them. */
export interface MergedLayout {
  pages: PageRef[]; meshes: MeshMap[]; texPage: number[]; pageSource: number[];
  /** per page: its tail page (repacked pages: the same texture at tier k + TAIL, whole) or −1 */
  pageTail: number[];
  /** per page with a tail: the texture's UV → tail page UV scale (u · su, v · sv) */
  tailScale: [number, number][];
  /** per page: the texture's UV → page UV scale of a whole tier page (the tier picture on a page padded to 4 × 4
   *  blocks: < 1, the same scale its meshes' MeshMap.uv has), else [1, 1]. What a texture UV meets a page by, besides
   *  the meshes: sprite-sheet cell offsets, lighting maps, meshes added at load (attachments / particles) */
  pageUv: [number, number][];
}

/** One draw layout from per-texture tier choices (shared/rig2d/gpu/pick.ts pickTiers; −1 = the original picture):
 *  pages of each chosen tier that hold that texture, meshes mapped onto them; repacked pages get their tail page (tier
 *  k + TAIL, whole) when `layouts` has it. */
export function mergeTiers(doc: Rig2DDoc, choice: number[], layouts: ReadonlyMap<number, TierLayout>): MergedLayout {
  const pages: PageRef[] = [], texPage: number[] = [], at = new Map<string, number>();
  const pageTail: number[] = [], tailScale: [number, number][] = [];
  doc.textures.forEach((tx, t) => {
    const k = choice[t] ?? -1, l = k >= 0 ? layouts.get(k) : undefined;
    if (!l) { texPage[t] = pages.push({ k: -1, i: -1, t }) - 1; return; }
    const mine: number[] = [];
    l.pages.forEach((p, i) => { if (p.source === t) { const n = pages.push({ k, i, t }) - 1; at.set(`${k}:${i}`, n); texPage[t] ??= n; if (p.rects) mine.push(n); } });
    texPage[t] ??= pages.push({ k: -1, i: -1, t }) - 1;
    // repacked pages: the tail (tier k + TAIL must be one whole page of this texture)
    const tl = layouts.get(k + TAIL), ti = tl ? tl.pages.findIndex((p) => p.source === t && !p.rects) : -1;
    if (mine.length && tl && ti >= 0 && tl.pages.filter((p) => p.source === t).length === 1) {
      const tp = tl.pages[ti], n = pages.push({ k: k + TAIL, i: ti, t }) - 1;
      for (const c of mine) { pageTail[c] = n; tailScale[c] = [tx.width * tp.scale / tp.w, tx.height * tp.scale / tp.h]; }
    }
  });
  for (let i = 0; i < pages.length; i++) pageTail[i] ??= -1;
  const meshes: MeshMap[] = doc.meshes.map((m, mi) => {
    const k = choice[m.texture] ?? -1, l = k >= 0 ? layouts.get(k) : undefined, mm = l?.meshes[mi];
    if (!l || !mm) return { page: texPage[m.texture] ?? 0, uv: [1, 1, 0, 0] };
    return { page: at.get(`${k}:${mm.page}`) ?? texPage[m.texture], uv: mm.uv };
  });
  const pageUv = pages.map((r): [number, number] => {
    const p = r.k >= 0 ? layouts.get(r.k)?.pages[r.i] : undefined, tx = doc.textures[r.t];
    return p && !p.rects ? [tx.width * p.scale / p.w, tx.height * p.scale / p.h] : [1, 1];
  });
  return { pages, meshes, texPage, pageSource: pages.map((p) => p.t), pageTail, tailScale, pageUv };
}
