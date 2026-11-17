// Which profile saves need the avatar rebuilt. Every save broadcasts a 'profile' change and the studio / OBS pages used
// to reload the whole model for each one, including saves that only touched bookkeeping: the library thumbnail taken
// after a first load, a costume's wardrobe thumbnail rendered in the background, the server's model stats. Those
// fields never change what is on screen, so a save that differs only in them is taken in place (adoptBuildFree).
import type { AvatarProfile } from './types.ts';

/** JSON with sorted keys (a profile read back from disk can list its keys in another order than the one in memory). */
function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined || typeof x === 'function' ? 'null' : stableJson(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined && typeof o[k] !== 'function').sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
}

/** The profile without the fields that never change the built avatar. */
function buildPart(p: AvatarProfile): unknown {
  const { thumbnail: _t, modelStats: _m, createdAt: _c, ...rest } = p;
  return { ...rest, costumes: (p.costumes ?? []).map(({ thumbnail: _ct, ...c }) => c) };
}

/** True when `next` builds the same avatar as `shown` (they differ at most in thumbnails, model stats, created date). */
export function sameAvatarBuild(shown: AvatarProfile, next: AvatarProfile): boolean {
  return shown.id === next.id && stableJson(buildPart(shown)) === stableJson(buildPart(next));
}

/** Take the build-free fields of `next` into the profile on show (in place: the runtime keeps the same object). */
export function adoptBuildFree(shown: AvatarProfile, next: AvatarProfile): void {
  if (next.thumbnail === undefined) delete shown.thumbnail; else shown.thumbnail = next.thumbnail;
  if (next.modelStats === undefined) delete shown.modelStats; else shown.modelStats = next.modelStats;
  shown.createdAt = next.createdAt;
  for (const c of shown.costumes ?? []) {
    const n = next.costumes?.find((x) => x.id === c.id);
    if (n?.thumbnail === undefined) delete c.thumbnail; else c.thumbnail = n.thumbnail;
  }
}

/** A 'profile' save of `savedId` reached a page that shows `shownId` and may be loading `loadingId`: reload the saved
 *  avatar? Never while ANOTHER avatar is loading: a switch is under way, and reloading the outgoing avatar (a thumbnail
 *  saved for it a moment later) would become the newest load and undo the switch on stream. */
export function reloadForSave(savedId: string, shownId: string | null | undefined, loadingId: string | null | undefined): boolean {
  return loadingId ? loadingId === savedId : shownId === savedId;
}
