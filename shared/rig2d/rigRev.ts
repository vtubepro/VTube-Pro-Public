// flat.opts.rigRev ("Edit rig", shared/rig2d/rigEdit.ts): the count of rig saves / undos of a 2D avatar. Every page
// reloads the model when it goes up. It only ever goes UP: a profile save that carries an older number (a studio tab, a
// phone or a debounced save that read the profile before the rig was saved) keeps the stored one, so the bump can't be
// lost or undone by a write that raced it. No imports: the server's profile save and the browser both use it.

/** The rig revision a profile says (0 = never edited). */
export function rigRevOf(p: unknown): number {
  const v = (p as { flat?: { opts?: { rigRev?: unknown } } } | null | undefined)?.flat?.opts?.rigRev;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** `next` with flat.opts.rigRev never below `prev`'s (mutates and returns `next`). */
export function keepRigRev<T>(prev: unknown, next: T): T {
  const keep = rigRevOf(prev);
  const f = (next as { flat?: { opts?: Record<string, unknown> } } | null)?.flat;
  if (keep > rigRevOf(next) && f) f.opts = { ...(f.opts ?? {}), rigRev: keep };
  return next;
}
