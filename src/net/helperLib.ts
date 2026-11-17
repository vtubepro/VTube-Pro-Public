// Which avatar the studio opens with. Pure functions plus the localStorage keys they read (src/app.ts writes LAST_KEY when
// the user picks an avatar, src/main.ts reads it at start-up).

/** The avatar on screen last time (the user's own pick). */
export const LAST_KEY = 'vtp.lastAvatar';

/**
 * The avatar to start with: the user's saved pick, if the list has it (undefined = no pick; the caller falls back to the
 * default avatar, src/main.ts).
 */
export function bootAvatarId(list: readonly { id: string }[], o: { last: string | null }): string | undefined {
  return (o.last && list.find((a) => a.id === o.last)?.id) || undefined;
}
/**
 * What start-up opens (src/main.ts): the user's pick, else the default avatar (robot), else the first one. `remember` is true only
 * for the user's own pick: a fallback is shown for now and is NOT saved over the pick. The list can be short for a day (a folder
 * the re-index has not repaired yet), and saving the starter then made the next visit open the starter too, even after the
 * avatars were back.
 */
export function bootAvatarPlan(list: readonly { id: string }[], o: { last: string | null }): { id: string | undefined; remember: boolean } {
  const pick = bootAvatarId(list, o);
  return { id: pick || list.find((a) => a.id === 'robot')?.id || list[0]?.id, remember: !!pick };
}
