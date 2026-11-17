// Settings-only changes of a Pro2D avatar, applied IN PLACE (no model reload: a reload is visible on stream).
// A profile save reaches every page as a 'profile' broadcast, and pages used to rebuild the avatar for it. When the
// only difference is in the Pro2D runtime options below (and the thumbnail), the running rig takes them as they are
// (Rig2DSource.applyOpts → Animator.applyOpts): the same instance, the same GPU objects, no missing frame.
// Used by the OBS page (src/output.ts, one hook) and the studio's 2D panel (src/ui/rig2dPanel.ts).
import type { AvatarProfile } from '../../../../shared/types.ts';

/** profile.flat.opts keys a running Pro2D rig applies live. Anything else (a new model file, display mode, framing,
 *  `dynamics` …) still reloads. */
export const RIG2D_LIVE_OPTS = ['params', 'layers', 'paramTriggers', 'exprKeys', 'lipGain', 'headGain', 'physics', 'idleMotion', 'bindings', 'tune'] as const;

interface LiveRuntime { profile: AvatarProfile; flat: { source: { kind: string; applyOpts?: (o: unknown) => void } } | null }

const strip = (p: AvatarProfile): string => {
  const c = structuredClone(p) as AvatarProfile & { thumbnail?: unknown };
  delete c.thumbnail;
  const o = c.flat?.opts as Record<string, unknown> | undefined;
  if (o) for (const k of RIG2D_LIVE_OPTS) delete o[k];
  return JSON.stringify(c);
};

/** Only live options (or the thumbnail) differ between the running profile and the saved one. */
export function liveOnlyChange(cur: AvatarProfile, next: AvatarProfile): boolean {
  if (cur.id !== next.id || cur.flat?.kind !== 'rig2d' || next.flat?.kind !== 'rig2d') return false;
  try { return strip(cur) === strip(next); } catch { return false; }
}

/** Only the newest of overlapping requests may land (the OBS page's profile fetches: an older save's fetch that
 *  arrives after a newer one is dropped). begin() → a ticket; latest(ticket) → still the newest? */
export function latestGate() { let n = 0; return { begin: () => ++n, latest: (t: number) => t === n }; }

/** Apply a saved profile to the running avatar in place when that is enough; false = it needs a reload. */
export function applyFlatProfileInPlace(rt: LiveRuntime | null | undefined, next: AvatarProfile): boolean {
  const src = rt?.flat?.source;
  if (!rt || !src || src.kind !== 'rig2d' || typeof src.applyOpts !== 'function' || !liveOnlyChange(rt.profile, next)) return false;
  try { src.applyOpts(next.flat!.opts ?? {}); } catch (e) { console.warn('[rig2d] live options', e); return false; }
  // (the running profile now says what is shown; `profile` itself is the runtime's own object)
  rt.profile.flat!.opts = structuredClone(next.flat!.opts ?? {});
  const t = (next as { thumbnail?: string }).thumbnail;
  if (t !== undefined) (rt.profile as { thumbnail?: string }).thumbnail = t;
  return true;
}
