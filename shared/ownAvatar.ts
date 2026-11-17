// Which avatars and costumes "come with VTube Pro" (locked: no Delete) and which are the user's own. The helper decides it
// from what the release ships (server/userAvatars.ts) and sends `shipped` on every avatar; a profile's or a costume's own
// "source" is only a hint, because an AI app, a creator script or a copied shipped profile can leave "builtin" on the
// user's own work. Used by the helper (server/library.ts, server/costumes.ts) and the studio (src/ui/wardrobe.ts).
import type { CostumeDef } from './types.ts';

/** A costume is locked ("builtin": it can't be deleted) only when its avatar is shipped by VTube Pro. `shipped` is what the
 *  helper says about the avatar; an older version says nothing (undefined) and then the costume's own source decides, as before. */
export const costumeLocked = (avatar: { shipped?: boolean }, c: Pick<CostumeDef, 'source'>): boolean => c.source === 'builtin' && avatar.shipped !== false;

/** The costumes of a user's own avatar: one marked 'builtin' (a creator script wrote that) is the user's own as well. */
export function ownCostumes<T extends Pick<CostumeDef, 'source'>>(list: readonly T[] | undefined): T[] {
  return (list ?? []).map((c) => (c.source === 'builtin' ? ({ ...c, source: 'import' } as T) : c));
}
