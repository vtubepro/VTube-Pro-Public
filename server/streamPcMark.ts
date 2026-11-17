// Which requests / sockets came from a PAIRED stream PC (server/streamPc.ts marks them after its gate passed them).
// A separate tiny module so the guards (localGuard, bus, party vault, route utils) can ask without import cycles.
import type { IncomingMessage } from 'node:http';

export interface StreamPcMark { id: string; ip: string }
const marks = new WeakMap<IncomingMessage, StreamPcMark>();
/** Called only by server/streamPc.ts once the LAN gate accepted the request with a valid token. */
export function markStreamPc(req: IncomingMessage, m: StreamPcMark) { marks.set(req, m); }
/** The paired stream PC a request came from (undefined for this PC's own pages, tools and everything else). */
export function streamPcOf(req: IncomingMessage | undefined | null): StreamPcMark | undefined { return req ? marks.get(req) : undefined; }
