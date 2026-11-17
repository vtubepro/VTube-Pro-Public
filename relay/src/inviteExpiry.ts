// invite-experience: how long a no-sign-in guest link (/g/<token>) stays open. Owner: "make sure that invite links can
// expire please, or give a host the option to change how long its open for up to an hour".
// Every link expires: the host picks 10 min / 30 min / 1 hour (default 30). The relay enforces it (app.ts guestlink):
// the signed token's own expiry AND the room's record of the link both end at that moment, independent of the room's
// lifetime, so a link pasted anywhere stops working on time.
// Pure and dependency-free: the relay, the local server (server/routes/discord.ts) and the studio all use it.

export const INVITE_CHOICES = [10, 30, 60] as const;
export const INVITE_DEFAULT_MINUTES = 30;
export const INVITE_MAX_MINUTES = 60;
export const INVITE_MIN_MINUTES = 5;
export const INVITE_TOO_LONG = 'Invite links can stay open for up to 1 hour';

/** The link lifetime a mint request asks for.
 *  - `minutes` (current studios): a whole number 5-60, anything else is REJECTED (`error`);
 *  - `hours` only (older studios / older local servers, which always sent 12): clamped into 5-60 min, so they keep
 *    working but can never get more than an hour;
 *  - neither: the default (30 min). */
export function inviteMinutes(b: { minutes?: unknown; hours?: unknown } | null | undefined): { minutes: number } | { error: string } {
  const o = b ?? {};
  if (o.minutes !== undefined && o.minutes !== null) {
    const m = Number(o.minutes);
    if (!Number.isInteger(m) || m < INVITE_MIN_MINUTES) return { error: `Invite links stay open for ${INVITE_MIN_MINUTES} to ${INVITE_MAX_MINUTES} minutes` };
    if (m > INVITE_MAX_MINUTES) return { error: INVITE_TOO_LONG };
    return { minutes: m };
  }
  if (o.hours !== undefined && o.hours !== null && Number.isFinite(Number(o.hours)) && Number(o.hours) > 0) {
    return { minutes: Math.max(INVITE_MIN_MINUTES, Math.min(INVITE_MAX_MINUTES, Math.round(Number(o.hours) * 60))) };
  }
  return { minutes: INVITE_DEFAULT_MINUTES };
}

/** "10 min" / "30 min" / "1 hour" (the host's choice, in the Invite sheet). */
export const choiceLabel = (m: number) => (m >= 60 && m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} min`);

/** The live countdown chip: "Expires in 24 min" · "Expires in 45 s" · "Expired". Rounds minutes UP (never promises
 *  less time than the guest really has, never shows "0 min"). */
export function expiresInText(expiresAt: number, now = Date.now()): string {
  const s = Math.ceil((expiresAt - now) / 1000);
  if (!(s > 0)) return 'Expired';
  if (s < 60) return `Expires in ${s} s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `Expires in ${m} min`;
  return m === 60 ? 'Expires in 1 hour' : `Expires in ${Math.floor(m / 60)} h ${m % 60} min`;
}
/** Chip colour: ok, soon (< 5 min left), gone. */
export const expiryTone = (expiresAt: number, now = Date.now()): 'ok' | 'soon' | 'gone' => (expiresAt <= now ? 'gone' : expiresAt - now < 5 * 60_000 ? 'soon' : 'ok');
