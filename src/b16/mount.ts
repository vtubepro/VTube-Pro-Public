// beta.16 feature lanes (docs/b16/LANES.md): ONE loader so no lane has to edit src/app.ts, src/output.ts or main.ts.
// The host pages call mountB16() once after they are up (a single line, owned by the rules lane). Each lane has an entry
// file that exports `mount(ctx)`; this file lists them, lazily, so a lane that is not used costs nothing and a lane that
// throws never stops the studio or the OBS page. A mount only subscribes and registers (bus commands, rule actions, panels):
// no timers, no per-frame work until the feature is actually used (idle = zero cost).
import type { App } from '../app.ts';
import type { Bus } from '../bus.ts';

export interface B16Ctx {
  /** 'studio' = the performer's studio page (owns SceneState and stamps); 'output' = an OBS Browser Source / preview page (plays the stamps). */
  role: 'studio' | 'output';
  bus: Bus;
  /** The studio's App (role 'studio' only). */
  app?: App;
}
/** May return a function that undoes the mount (HMR / tests). */
export type B16Mount = (ctx: B16Ctx) => void | (() => void) | Promise<void | (() => void)>;

/** Lane name -> its entry module. Nobody edits this list: every entry file below is created in the contract commit. */
export const B16_LANES: Record<string, () => Promise<{ mount: B16Mount }>> = {
  rules: () => import('../rules/mount.ts'),
  throw: () => import('../scene/throw/mount.ts'),
  items: () => import('../avatar/items/mount.ts'),
  bindings: () => import('../input/mount.ts'),
  emoterain: () => import('../scene/emoteRain/mount.ts'),
  recemote: () => import('../avatar/recordEmote/mount.ts'),
  soundfx: () => import('../audio/soundfxMount.ts'),
  cohost: () => import('../scene/cohost/mount.ts'),
};

/** Debug switch: localStorage `vtp.b16.off` = "*" or a comma list of lane names that must not mount. */
function offLanes(): Set<string> {
  try { return new Set((localStorage.getItem('vtp.b16.off') ?? '').split(',').map((s) => s.trim()).filter(Boolean)); } catch { return new Set(); }
}

const undo: (() => void)[] = [];
let mounted = false;
// Resolves when mountB16 has finished every lane (mounted, failed or switched off). A lane that must not act before the others listen
// (the rules lane puts saved reverts back: a sticker's put-back needs the items lane) waits on it from a timer, never inside mount().
let allMounted: Promise<void> = new Promise<void>(() => {});
let markMounted: () => void = () => {};
const freshMounted = () => { allMounted = new Promise<void>((r) => { markMounted = r; }); };
freshMounted();
export const whenB16Mounted = (): Promise<void> => allMounted;
const idle = (fn: () => void) => {
  const ric = (globalThis as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  if (ric) ric(fn, { timeout: 3000 }); else setTimeout(fn, 1500);
};

/** Mount every lane once, one after the other, each in an idle moment. Returns when all are done (failures are logged, never thrown). */
export async function mountB16(ctx: B16Ctx): Promise<void> {
  if (mounted) return;
  mounted = true;
  const off = offLanes();
  for (const [name, load] of Object.entries(B16_LANES)) {
    if (off.has('*') || off.has(name)) continue;
    await new Promise<void>((done) => idle(done));
    try { const m = await load(); const u = await m.mount(ctx); if (typeof u === 'function') undo.push(u); }
    catch (e) { console.warn(`[b16] lane "${name}" did not start`, e); }
  }
  markMounted();
}
/** HMR / tests: undo every mount. */
export function unmountB16() {
  for (const u of undo.splice(0).reverse()) { try { u(); } catch { /* best effort */ } }
  mounted = false;
  freshMounted();
}
