// beta.16 avatar hooks (docs/b16/LANES.md): two tiny registries so the throw lane (head flinch), the items lane (stickers
// that follow the avatar) and the VTS API lane (tint, model move) can act on the avatar without each editing
// AvatarRuntime.ts / app.ts. Two call sites exist, each added ONCE by its owner lane: `runAvatarLoaded(rt)` in
// src/app.ts right after `this.runtime = rt` (rules lane, the app.ts editor) and `runAvatarLate(rt, dt)` at the end of
// AvatarRuntime.update (throw lane). With nothing registered both are a Set size check: idle = zero cost.
import type { AvatarRuntime } from './AvatarRuntime.ts';

type LoadedHook = (rt: AvatarRuntime) => void;
type LateHook = (rt: AvatarRuntime, dt: number) => void;
const loaded = new Set<LoadedHook>();
const late = new Set<LateHook>();
const beforeDispose = new Set<LoadedHook>();

/** Called after an avatar (re)loaded and became the runtime. Returns the unsubscribe. */
export function onAvatarLoaded(fn: LoadedHook): () => void { loaded.add(fn); return () => { loaded.delete(fn); }; }
/** Called every frame after the pose is solved, before the frame is drawn: ADDITIVE offsets only (a flinch rides on top of tracking). Returns the unsubscribe. */
export function onAvatarLate(fn: LateHook): () => void { late.add(fn); return () => { late.delete(fn); }; }

/** Called by App.build() right BEFORE the avatar it replaces is disposed: take everything that hangs under its model off it (the
 *  items lane's holders: a dispose walks every mesh under the model, textures of a sticker model included). Returns the unsubscribe. */
export function onAvatarBeforeDispose(fn: LoadedHook): () => void { beforeDispose.add(fn); return () => { beforeDispose.delete(fn); }; }

export function runAvatarBeforeDispose(rt: AvatarRuntime) {
  if (!beforeDispose.size) return;
  for (const fn of beforeDispose) { try { fn(rt); } catch (e) { console.warn('[b16] avatar before-dispose hook', e); } }
}
export function runAvatarLoaded(rt: AvatarRuntime) {
  if (!loaded.size) return;
  for (const fn of loaded) { try { fn(rt); } catch (e) { console.warn('[b16] avatar loaded hook', e); } }
}
export function runAvatarLate(rt: AvatarRuntime, dt: number) {
  if (!late.size) return;
  for (const fn of late) { try { fn(rt, dt); } catch (e) { console.warn('[b16] avatar late hook', e); } }
}
