// The 17 visemes the lip-sync engine speaks (src/tracking/visemes.ts re-exports them); here in shared/ so the helper, which ships
// only server/ + shared/, can use them (shared/lipBus.ts).
export const VISEMES = ['sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'L', 'W', 'aa', 'E', 'I', 'O', 'U'] as const;
export type Viseme = (typeof VISEMES)[number];
