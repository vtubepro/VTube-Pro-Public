// Connector ⇄ hub contract (an earlier overlay's onChat / onFinance callbacks + status + moderation removals).
import type { ChatPart, LivePlatform, StreamEventKind } from '../../shared/chat.ts';
import type { RawFinance } from './finance.ts';

export interface RawChat {
  platform: LivePlatform;
  username: string;
  message: string;
  color?: string | null;
  ts: number;
  badges?: string[];
  parts?: ChatPart[];
  system?: boolean;
  /** Platform message id (dedupe + moderation removals). */
  id?: string;
  /** The sender's stable platform user id (YouTube channel id, Twitch user-id, TikTok uniqueId, Kick user id) when known. */
  uid?: string;
  /** A stream event (follow / host / share …) shown as a system line. */
  ev?: StreamEventKind;
}

/** purge: `target` = the login / display name ('*' = everyone); `uid` = their platform user id when known. */
export interface RawRemove { kind: 'delete' | 'purge'; platform: LivePlatform; target: string; uid?: string }

export type ConnectorState = 'connecting' | 'live' | 'waiting' | 'error';

export interface ConnectorHooks {
  onChat(c: RawChat): void;
  onFinance(f: RawFinance): void;
  onRemove(r: RawRemove): void;
  onStatus(state: ConnectorState, detail: string): void;
  /** The channel's platform user id, when the connector learns it (Twitch ROOMSTATE room-id: emote sets by id). */
  onRoom?(id: string): void;
  log(...a: unknown[]): void;
}

export interface Connector { start(): Promise<void> | void; stop(): void }
