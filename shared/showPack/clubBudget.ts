// The club's show-pack rig budget per graphics tier (src/scene/club/packRig.ts) and the room boost (scene.json
// club.rig.boost 1..2: a room built for a faster GPU - RTX 3080 / 4070 Ti class - draws up to twice the tier's moving
// heads + laser origins and 1.5x the bar beams / rays; the festival stages' `boost`, the same idea).
export type QualityTierLike = 'low' | 'medium' | 'high' | 'ultra';
export interface PackRigBudget { heads: number; bars: number; barHeads: number; lasers: number; rays: number; ceiling: number }
/** what one tier draws: moving heads, beam bars x heads per bar, laser origins x rays, ceiling LEDs across */
export const CLUB_PACK_BUDGET: Record<QualityTierLike, PackRigBudget> = {
  low: { heads: 0, bars: 0, barHeads: 0, lasers: 0, rays: 0, ceiling: 0 },
  medium: { heads: 8, bars: 0, barHeads: 0, lasers: 4, rays: 10, ceiling: 28 },
  high: { heads: 12, bars: 2, barHeads: 8, lasers: 6, rays: 16, ceiling: 44 },
  ultra: { heads: 20, bars: 4, barHeads: 10, lasers: 10, rays: 24, ceiling: 64 },
};
/** the tier's budget scaled by a room boost (1..2) */
export function clubPackBudget(tier: QualityTierLike, boost = 1): PackRigBudget {
  const b = CLUB_PACK_BUDGET[tier] ?? CLUB_PACK_BUDGET.medium, k = Math.max(1, Math.min(2, Number.isFinite(boost) ? boost : 1));
  return { heads: Math.round(b.heads * k), bars: Math.round(b.bars * Math.min(1.5, k)), barHeads: b.barHeads, lasers: Math.round(b.lasers * k), rays: Math.round(b.rays * Math.min(1.5, k)), ceiling: Math.round(b.ceiling * Math.sqrt(k)) };
}
