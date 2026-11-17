// Voyage support banners: where one may sit in the frame (pure; voyageScene draws it). SPEC 5.6: support effects never
// over a face, the React screen (or its passthrough hole), the interview monitor, Gaming tiles; the banner takes the first
// free slot in the top band and keeps it while it stays free.

/** A banner slot: centre x, centre y (y up) and width, fractions of the frame (the banner is 4:1). */
export interface BannerSlot { x: number; y: number; w: number }
/** A keep-out rect, fractions of the frame, y up. */
export interface BannerKeep { x0: number; x1: number; y0: number; y1: number }

/** Top band: centre first, then the two corners, then narrower corners (beside a wide React screen), then a slim strip
 *  along the top edge (above a React screen that fills the middle of the frame). */
export const BANNER_SLOTS: readonly BannerSlot[] = [{ x: 0.5, y: 0.87, w: 0.5 }, { x: 0.2, y: 0.895, w: 0.34 }, { x: 0.8, y: 0.895, w: 0.34 }, { x: 0.125, y: 0.905, w: 0.21 }, { x: 0.875, y: 0.905, w: 0.21 }, { x: 0.5, y: 0.952, w: 0.19 }];

/** The slot's rect (fractions, y up) for a frame aspect. */
export function bannerRect(s: BannerSlot, aspect: number, pad = 0): BannerKeep {
  const hw = s.w / 2 + pad, hh = (s.w * aspect) / 8 + pad;
  return { x0: s.x - hw, x1: s.x + hw, y0: s.y - hh, y1: s.y + hh };
}
const meets = (a: BannerKeep, b: BannerKeep) => a.x1 > b.x0 && a.x0 < b.x1 && a.y1 > b.y0 && a.y0 < b.y1;

/** The slot index to use (`prev` kept while it stays free), or -1 when every slot touches a keep-out. */
export function bannerSlot(keep: readonly BannerKeep[], aspect: number, prev = 0): number {
  const free = (i: number) => { const r = bannerRect(BANNER_SLOTS[i], aspect, 0.012); return !keep.some((k) => meets(r, k)); };
  if (prev >= 0 && prev < BANNER_SLOTS.length && free(prev)) return prev;
  for (let i = 0; i < BANNER_SLOTS.length; i++) if (free(i)) return i;
  return -1;
}
