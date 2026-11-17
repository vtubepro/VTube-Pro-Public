// The rules behind "Delete an avatar" (Me → an avatar's ⋯ → Delete…, src/ui/avatarDelete.ts), with no DOM, so they are
// tested in node. The server stays the authority: DELETE /api/avatars/:id refuses
// builtins (403) and moves the folder to library/.trash; POST /api/avatars/:id/restore brings it back (server/library.ts).
import type { AvatarProfile } from '../../shared/types.ts';

/** What the user must type, exactly (case-sensitive; spaces around it are ignored). */
export const CONFIRM_WORD = 'CONFIRM';
export const confirmMatches = (typed: string): boolean => typed.trim() === CONFIRM_WORD;

type Who = Pick<AvatarProfile, 'source'> & { id?: string; shipped?: boolean };
/** The avatars that come with VTube Pro (and the test ones): never deletable. The server says which (`shipped`); the
 *  user's own avatar can carry source 'builtin' too (made by an AI app or a creator script), so `source` alone decides nothing. */
export const isProtectedAvatar = (p: Who): boolean => p.source === 'builtin-test' || p.shipped === true;

/** What is using an avatar right now on this PC. */
export interface InUse {
  /** the avatar on screen in this studio (= what OBS shows) */
  activeId: string | null;
  /** the chat buddy (Room → chat): a library avatar that walks in with the chat, while it is on */
  buddyId?: string | null;
}
export type DeleteVerdict =
  | { ok: true }
  | { ok: false; why: 'builtin' | 'active' | 'buddy' | 'observer'; text: string };

export function deleteVerdict(p: Pick<AvatarProfile, 'id' | 'name' | 'source'> & { shipped?: boolean }, use: InUse, observer = false): DeleteVerdict {
  if (isProtectedAvatar(p)) return { ok: false, why: 'builtin', text: `${p.name} comes with VTube Pro, so it can't be deleted.` };
  if (observer) return { ok: false, why: 'observer', text: 'This is a read-only observer tab. Delete avatars in your studio.' };
  if (use.activeId && use.activeId === p.id) return { ok: false, why: 'active', text: `${p.name} is the avatar you're using. Switch to another avatar first.` };
  if (use.buddyId && use.buddyId === p.id) return { ok: false, why: 'buddy', text: `${p.name} is your chat buddy. Switch to another avatar first (Room → Chat → Who brings the chat).` };
  return { ok: true };
}

/** The trash copy's folder name from DELETE's movedTo (`library/.trash/<id>-<time>`, either slash). '' = none (the
 *  browser-only studio erases for good). */
export function trashNameOf(movedTo: unknown): string {
  if (typeof movedTo !== 'string' || !movedTo) return '';
  const parts = movedTo.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** A plain sentence for a failed DELETE. status 0 = the request never got an answer. */
export function deleteErrorText(status: number, name: string, serverText = ''): string {
  if (status === 0) return `Couldn't reach VTube Pro, so ${name} was not deleted. Check that VTube Pro is running, then try again.`;
  if (status === 403) return /linked/i.test(serverText) ? `${name} comes from a linked VTube Pro folder, so it can't be deleted here.`
    : /read-only|starter/i.test(serverText) ? `${name} is a starter avatar, so it can't be deleted.`
      : `${name} comes with VTube Pro, so it can't be deleted.`;
  if (status === 404) return `${name} was already deleted (maybe in another window). Your list is up to date now.`;
  // 423 (Locked): the avatar is in VTube Pro's program folder and it can't be moved (a file in it is open). It will
  // not clear by itself, so don't say "try again in a moment" (that is 409, a save in the way)
  if (status === 423) return `${name} is in a folder VTube Pro can't change right now. Close any other program that is using it, then try again.`;
  if (status === 409) return `${name} is busy being saved. Try again in a moment.`;
  return `Couldn't delete ${name}${serverText ? `: ${serverText}` : '.'}`;
}

export type RestoreOutcome = 'ok' | 'gone' | 'taken' | 'builtin' | 'offline' | 'error';
/** What a POST /api/avatars/:id/restore answer means. */
export function restoreOutcome(status: number, _body: unknown): RestoreOutcome {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 0) return 'offline';
  if (status === 404) return 'gone';
  if (status === 409) return 'taken';
  if (status === 403) return 'builtin';
  return 'error';
}

/** A plain sentence for a restore that didn't happen (null for 'ok'). */
export function restoreText(o: RestoreOutcome, name: string, trashName = ''): string | null {
  const where = trashName ? ` (library/.trash/${trashName})` : '';
  switch (o) {
    case 'ok': return null;
    case 'gone': return `${name} isn't in the trash folder any more, so it can't come back.`;
    case 'taken': return `${name} is already back in your avatars.`;
    case 'builtin': return `${name} comes with VTube Pro, so it was never deleted.`;
    case 'offline': return `Couldn't reach VTube Pro. Start it, then try Undo again from Recently deleted.`;
    default: return `Couldn't bring ${name} back. It is still in the trash folder${where}.`;
  }
}

// ---------------------------------------------------------------- recently deleted (this tab's session)
export interface DeletedEntry { id: string; name: string; trash: string; at: number }
/** Newest first, one entry per trash copy, at most `max`. */
export function addDeleted(list: readonly DeletedEntry[], e: DeletedEntry, max = 12): DeletedEntry[] {
  return [e, ...list.filter((x) => !(x.id === e.id && x.trash === e.trash))].slice(0, max);
}
export function sanitizeDeleted(v: unknown): DeletedEntry[] {
  if (!Array.isArray(v)) return [];
  const out: DeletedEntry[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object') continue;
    const { id, name, trash, at } = x as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,80}$/i.test(id) || typeof trash !== 'string' || trash.length > 200) continue;
    out.push({ id, name: typeof name === 'string' ? name.slice(0, 120) : id, trash, at: typeof at === 'number' ? at : 0 });
    if (out.length >= 12) break;
  }
  return out;
}
