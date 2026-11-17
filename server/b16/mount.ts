// beta.16 feature lanes (docs/b16/LANES.md), helper side: ONE loader so no lane has to edit server/index.ts. index.ts calls
// mountB16Server(app) once (a single line, owned by the rules lane). Each lane has an entry file that exports
// `mount(ctx)`; a lane that throws is logged and skipped, never stops the helper. A mount registers routes, bus listeners and
// rule actions only: no timers until the feature is used.
import type { Express } from 'express';

export interface B16ServerCtx { app: Express }
export type B16ServerMount = (ctx: B16ServerCtx) => void | Promise<void>;

export const B16_SERVER_LANES: Record<string, () => Promise<{ mount: B16ServerMount }>> = {
  rules: () => import('../rules.ts'),
  throw: () => import('../routes/throwables.ts'),
  items: () => import('../routes/items.ts'),
  bindings: () => import('../hotkeys/mount.ts'),
  recemote: () => import('../routes/userEmotes.ts'),
  soundfx: () => import('../routes/soundboard.ts'),
  cohost: () => import('../cohost/mount.ts'),
};

export async function mountB16Server(app: Express): Promise<void> {
  for (const [name, load] of Object.entries(B16_SERVER_LANES)) {
    try { const m = await load(); await m.mount({ app }); }
    catch (e) { console.warn(`[b16] lane "${name}" did not start`, e); }
  }
}
