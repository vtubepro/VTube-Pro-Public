// Minimal ambient types for the Cloudflare Workers runtime (so `tsc` works without @cloudflare/workers-types).
// If you install @cloudflare/workers-types, delete this file and add it to tsconfig "types".
interface DurableObjectId { toString(): string }
interface DurableObjectStub { fetch(req: Request): Promise<Response> }
interface DurableObjectNamespace { idFromName(name: string): DurableObjectId; get(id: DurableObjectId): DurableObjectStub }
interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  /** Keys in order (the webhook inbox, inbox.ts). */
  list<T = unknown>(o?: { prefix?: string; limit?: number; start?: string }): Promise<Map<string, T>>;
  deleteAll(): Promise<void>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}
// WebSocket Hibernation API (relay/HIBERNATION.md)
interface DurableObjectState {
  id: DurableObjectId;
  storage: DurableObjectStorage;
  acceptWebSocket(ws: CfWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): CfWebSocket[];
  setWebSocketAutoResponse(pair?: WebSocketRequestResponsePair): void;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}
interface CfWebSocket {
  accept(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
  addEventListener(type: 'close' | 'error', fn: () => void): void;
  readonly readyState?: number;
  /** hibernation: per-socket state kept with the socket while the object is out of memory (structured clone, <= 2 KB) */
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}
declare class WebSocketPair { 0: CfWebSocket; 1: CfWebSocket }
declare class WebSocketRequestResponsePair { constructor(request: string, response: string) }
interface ResponseInit { webSocket?: CfWebSocket }
