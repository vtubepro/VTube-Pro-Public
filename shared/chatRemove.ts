// Chat moderation removals, one rule for every holder of chat lines (the hub's ring, the OBS chat feed, the studio relay,
// the Chat Hub window): does this 'delete' / 'purge' ChatEvent remove that line?
//   delete  the line with that id — also a support card whose id has the connector's prefixes ("youtube:superchat:<id>",
//           "kick:kicks:<id>") while the delete names the bare item ("youtube:<id>", "kick:<id>"), on the same platform;
//   purge   (a ban / timeout) the person's chat lines (support lines stay: totals + goals read them): by their platform
//           user id when both sides have one (two accounts with the same display name are not the same person), else by
//           the login / display name; target '*' = everyone on that platform.
import type { ChatEvent } from './chat.ts';

/** An id without its connector / kind prefixes: "youtube:superchat:Ab1" → "Ab1", "kick:kicks:55" → "55". TikTok's kind
 *  letters stay ("tt:g:5" → "g:5"): a chat line, a gift and a sub never share one core. */
export function chatIdCore(id: string): string {
  return String(id ?? '').replace(/^(?:(?:youtube|kick|twitch|tw|rumble|tiktok|tt|test|superchat|supersticker|jewels|kicks|milestone|member|giftmember|sc|tip|don):)+/i, '');
}

export function removedBy(rm: Pick<ChatEvent, 'kind' | 'platform' | 'target' | 'uid'>, x: Pick<ChatEvent, 'id' | 'kind' | 'platform' | 'user' | 'uid'>): boolean {
  const target = rm.target ?? '';
  if (rm.kind === 'delete') return x.id === target || (x.platform === rm.platform && !!target && chatIdCore(x.id) === chatIdCore(target));
  if (rm.kind !== 'purge' || x.kind === 'finance' || x.platform !== rm.platform) return false;
  if (target === '*') return true;
  if (rm.uid && x.uid) return x.uid === rm.uid;
  return x.user.toLowerCase() === target.toLowerCase();
}
