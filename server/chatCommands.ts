// The chat command router (server/chat/hub.ts → routeChatLine for every chat line, before it is shown).
//
//   taps      see EVERY chat line, commands included (the chat audience counts !vote / !ask senders as active chatters);
//   commands  a registry: `addChatCommand(name, fn)` → unsubscribe. Several handlers may share a name (several lanes /
//             features); they run in registration order and the first that returns true CONSUMES the line (it never
//             reaches the chat display or the pages); false lets the next one run. Nothing is ever replaced silently.
//             `addAnyChatCommand(fn)` handlers see every `!command` after the named ones (renamable commands: !ask).
//             The poll (!vote / numbers / option words: server/poll.ts) always goes first.
//   removals  chat moderation (a deleted message, a purged / banned user) for modules that hold chatter state.
//   badges    extra chat badges a feature gives a chatter in this channel (`addChatBadge`).
// Handlers must never throw into the hub (each call is guarded) and must be cheap: the hub runs them inline.
import type { ChatEvent, LivePlatform } from '../shared/chat.ts';
import { pollOnChat } from './poll.ts';

export type ChatLine = Pick<ChatEvent, 'id' | 'platform' | 'user' | 'uid' | 'text' | 'badges' | 'kind' | 'color' | 'ts' | 'parts' | 'vip' | 'test'>;
/** A command handler: `arg` = the text after the command. true = consumed. */
export type CommandHandler = (e: ChatLine, arg: string) => boolean;
export type AnyCommandHandler = (e: ChatLine, name: string, arg: string) => boolean;
/** `uid` = the purged account's platform user id when the connector knows it (a ban then hits only that account). */
export type ChatRemoval = { kind: 'delete' | 'purge'; platform: LivePlatform; target: string; uid?: string };

const taps: ((e: ChatLine) => void)[] = [];
const commands = new Map<string, CommandHandler[]>();
const anyCommands: AnyCommandHandler[] = [];
const removals: ((r: ChatRemoval) => void)[] = [];
const badgers: ((platform: string, user: string) => string[])[] = [];

const off = <T>(list: T[], fn: T) => () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };

export function addChatTap(fn: (e: ChatLine) => void): () => void { taps.push(fn); return off(taps, fn); }
/** `name` without "!" (letters / digits, case-insensitive). Returns the unsubscribe. */
export function addChatCommand(name: string, fn: CommandHandler): () => void {
  const k = name.replace(/^!+/, '').toLowerCase();
  if (!/^[a-z0-9]{1,16}$/.test(k)) throw new Error(`bad chat command name "${name}"`);
  const list = commands.get(k) ?? [];
  list.push(fn);
  commands.set(k, list);
  return () => { off(list, fn)(); if (!list.length && commands.get(k) === list) commands.delete(k); };
}
/** A handler for every `!command` (after the named handlers): for commands whose name is a setting. */
export function addAnyChatCommand(fn: AnyCommandHandler): () => void { anyCommands.push(fn); return off(anyCommands, fn); }
export function addChatRemoval(fn: (r: ChatRemoval) => void): () => void { removals.push(fn); return off(removals, fn); }
/** Extra badges for a chatter's lines (a short lower-case word each; at most 2 are added). */
export function addChatBadge(fn: (platform: string, user: string) => string[]): () => void { badgers.push(fn); return off(badgers, fn); }
/** The extra badges of a chat line's sender (server/chat/hub.ts). Never throws. */
export function chatBadges(platform: string, user: string): string[] {
  const out: string[] = [];
  for (const f of [...badgers]) { try { for (const b of f(platform, user)) if (/^[a-z0-9_-]{1,20}$/.test(b) && !out.includes(b)) out.push(b); } catch (err) { console.warn('[chat] badge', err); } }
  return out.slice(0, 2);
}
/** The names with a handler (debug / tests). */
export const chatCommandNames = () => [...commands.keys()];

/** The `!name` and its argument of a line, or null. */
export function commandOf(text: string): { name: string; arg: string } | null {
  const m = /^\s*!([a-z0-9]{1,16})(?:\s+([\s\S]*))?$/i.exec(text ?? '');
  return m ? { name: m[1].toLowerCase(), arg: (m[2] ?? '').trim() } : null;
}

const guard = <A extends unknown[]>(what: string, fn: (...a: A) => boolean, ...a: A) => { try { return fn(...a) === true; } catch (err) { console.warn(`[chat] ${what}`, err); return false; } };

/** A chat line from the hub: true = consumed (keep it off the chat display). */
export function routeChatLine(e: ChatLine): boolean {
  if (e.kind !== 'chat') return false;
  for (const t of [...taps]) { try { t(e); } catch (err) { console.warn('[chat] command tap', err); } }
  if (pollOnChat(e)) return true;   // a poll vote (server/poll.ts)
  const c = commandOf(e.text);
  if (!c) return false;
  for (const fn of [...(commands.get(c.name) ?? [])]) if (guard(`!${c.name}`, fn, e, c.arg)) return true;
  for (const fn of [...anyCommands]) if (guard(`!${c.name}`, fn, e, c.name, c.arg)) return true;
  return false;
}

/** A moderation removal from a connector (server/chat/hub.ts onRemove). */
export function routeChatRemove(r: ChatRemoval) {
  for (const f of [...removals]) { try { f(r); } catch (err) { console.warn('[chat] removal', err); } }
}
