// WebSocket pub/sub bus at /ws. Every message a client sends is relayed verbatim to all OTHER clients.
// Tracking frames arrive at ~60Hz, so the relay never parses JSON: it forwards the raw payload.
import crypto from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { BusMessage } from '../shared/types.ts';
import { guardUpgrade } from './localGuard.ts';
import { streamPcOf } from './streamPcMark.ts';
import { streamPc } from './streamPc.ts';
import { parseOutputHello, summarizeOutputs, type OutputPage, type OutputsSummary } from '../shared/obsPages.ts';
import { SOUND_PING_MS, SoundArbiter } from '../shared/audioLeader.ts';
import { stampAggregator } from './broadcast/stamps.ts';

let wss: WebSocketServer | null = null;
/** Bus sockets of paired stream PCs (server/streamPc.ts): their signalling gets this PC's LAN address instead of mDNS names. */
const lanSockets = new WeakMap<WebSocket, string>(); // socket -> its connection id (VTube Pro's WebRTC id prefix for it)
/** Output pages on the bus (their latest hello), for GET /api/obs/outputs. */
const outputs = new Map<WebSocket, OutputPage>();
/** Which studio plays the show's sounds: exactly one of the studios on this bus (shared/audioLeader.ts). The studio on
 *  this PC (a loopback Origin) beats any other studio; re-granted when that socket closes. */
const sounds = new SoundArbiter<WebSocket>(
  (ws, m) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); },
  (why) => console.log(`[bus] show sounds: ${why}`),
);
const SOUND_PREFIX = Buffer.from('{"type":"sound');
// VTube Pro Live page stamps (src/outputStamps.ts): output page -> the helper's aggregator, 15 to 20 messages a second.
// Never relayed (they are the helper's own business, like the sound hellos). Only the prefix of a raw frame is looked at.
const STAMPS_PREFIX = Buffer.from('{"type":"broadcast","k":"stamps"');
const STAMPS_MAX_BYTES = 4096;
/** Ids the aggregator knows an output page by: one per socket, made here (a page cannot claim another page's id). */
const stampIds = new WeakMap<WebSocket, string>();
let stampSeq = 0;
/** When each output page last delivered stamps (helper clock), to re-ask the ones that did not hear the "start" yet. */
const stampSeen = new WeakMap<WebSocket, number>();
const STAMP_KINDS = new Set(['obs', 'browser', 'engine']);

// Drop frames for clients whose socket is badly backed up (e.g. a stalled OBS page) instead of buffering forever.
const MAX_BUFFERED = 4 * 1024 * 1024;
/** A socket this far behind (but still answering pings: a suspended tab with a full TCP window) is cut; pages reconnect
 *  and re-sync by themselves. */
const CUT_BUFFERED = 8 * MAX_BUFFERED;
/** Largest single bus message (ws defaults to 100 MiB). The biggest real ones are TTRPG map images sent as data URLs. */
const BUS_MAX_PAYLOAD = 32 * 1024 * 1024;

// Only pages on THIS machine may join the bus (it carries party members' vault keys + everyone's tracking): a
// website open in any browser must not be able to connect to ws://127.0.0.1:5191/ws. Non-browser clients (MCP,
// tools) send no Origin. Escape hatch: VTP_BUS_ANY_ORIGIN=1.
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const originOk = (origin: string | undefined) => !origin || process.env.VTP_BUS_ANY_ORIGIN === '1' || LOOPBACK_ORIGIN.test(origin);

/** Other WebSocket endpoints on this server (e.g. /ws/screen, server/screenFeed.ts). A WebSocketServer bound with
 *  { server, path } answers every other upgrade path with 400, so all upgrades are routed here by path instead. */
const upgrades = new Map<string, (req: IncomingMessage, socket: Duplex, head: Buffer) => void>();
export function onUpgrade(path: string, handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void) { upgrades.set(path, handler); }
export { originOk as busOriginOk };
/** A socket / request from a page on this PC, a tool without Origin, or a paired stream PC. */
export const busRequestOk = (req: IncomingMessage) => originOk(req.headers.origin) || !!streamPcOf(req); // + a paired stream PC (server/streamPc.ts)

export function attachBus(server: Server) {
  wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: BUS_MAX_PAYLOAD, verifyClient: (info: { origin?: string; req: IncomingMessage }) => originOk(info.origin) || !!streamPcOf(info.req) });
  server.on('upgrade', (req, socket, head) => {
    // Node drops its own 'error' listener on an upgraded socket and ws adds one only inside handleUpgrade: a peer that
    // resets while it is refused (or before a handler takes it) would otherwise throw an uncaught EPIPE / ECONNRESET
    socket.on('error', () => socket.destroy());
    if (!guardUpgrade(req, socket)) return; // loopback Host + loopback Origin (except /ws/vtt), server/localGuard.ts
    const p = (req.url ?? '').split('?')[0];
    if (p === '/ws') wss!.handleUpgrade(req, socket, head, (ws) => wss!.emit('connection', ws, req));
    else { const h = upgrades.get(p); if (h) h(req, socket, head); else socket.destroy(); }
  });
  wss.on('connection', (ws, req: IncomingMessage) => {
    // a studio on this PC: a loopback page (decided by the connection, never by the message)
    const local = LOOPBACK_ORIGIN.test(String(req.headers.origin ?? ''));
    // a paired stream PC's page (server/streamPc.ts): receives like an output page; what it sends is allow-listed first
    const lan = streamPcOf(req);
    const conn = lan ? crypto.randomBytes(4).toString('hex') : '';
    if (lan) { lanSockets.set(ws, conn); streamPc().busOpen(lan.id, conn); ws.on('close', () => { lanSockets.delete(ws); for (const bye of streamPc().busClose(lan.id, conn)) broadcast(bye as unknown as BusMessage); }); } // (its links close with it)
    ws.on('message', (raw, isBinary) => {
      let data = raw;
      if (lan) { const ok = isBinary ? null : streamPc().busIn(String(raw), lan.ip, conn, lan.id); if (ok === null) return; data = Buffer.from(ok); }
      // output pages announce themselves (kind / inside OBS / size): "OBS is connected" in the studio (shared/obsPages.ts).
      // Only short text frames are looked at, so the ~60 Hz tracking relay stays parse-free.
      if (!isBinary && Buffer.isBuffer(data) && data.length <= 600 && data[0] === 0x7b && data[2] === 0x74) {
        // the show's sounds: studios holding their window lock announce themselves; the helper answers with the grant.
        // These are the helper's own business: never relayed (so no page can fake a grant).
        if (data.subarray(0, SOUND_PREFIX.length).equals(SOUND_PREFIX)) { soundMsg(ws, data, local); return; }
        const page = parseOutputHello(data.toString('utf8'));
        if (page) {
          const old = outputs.get(ws); outputs.set(ws, old ? { ...page, since: old.since } : page);
          if (!lan && stampAggregator.wanted()) stampsCommand(true, ws);   // (a page that joins while a health view is open starts stamping at once)
        }
      }
      if (!isBinary && Buffer.isBuffer(data) && data.length > STAMPS_PREFIX.length && data.subarray(0, STAMPS_PREFIX.length).equals(STAMPS_PREFIX)) { stampsMsg(ws, data); return; }
      for (const client of wss!.clients) {
        if (client !== ws && client.readyState === WebSocket.OPEN && client.bufferedAmount < MAX_BUFFERED) {
          const lc = lanSockets.get(client);
          const out = lc === undefined ? data : streamPc().busOut(data as Buffer, lc);
          if (out !== null) client.send(out, { binary: isBinary });
        }
      }
    });
    ws.on('error', () => ws.terminate());
    ws.on('close', () => { outputs.delete(ws); sounds.closed(ws); const sid = stampIds.get(ws); if (sid) stampAggregator.drop(sid); });
    ws.on('pong', () => sounds.pong(ws));
  });
  // Heartbeat so dead sockets (sleeping laptops, closed OBS sources) get reaped.
  const alive = new WeakMap<WebSocket, boolean>();
  wss.on('connection', (ws) => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
  });
  const timer = setInterval(() => {
    for (const ws of wss!.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, 30_000);
  // the studios that announced themselves for the show's sounds are pinged more often: one missed answer (a crashed tab
  // whose socket never closed) and the next studio gets the sounds within a few seconds, not a minute
  const soundTimer = setInterval(() => {
    for (const ws of sounds.sweep()) ws.terminate();
    for (const ws of sounds.studioSockets()) if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, SOUND_PING_MS);
  // page stamps: output pages stamp only while a health view reads the stats (server/broadcast/stamps.ts lease); the helper
  // tells them when that starts and stops, and re-asks the ones that stay silent (a page binds its listener on its first frame)
  const unwatch = stampAggregator.onWanted((on) => stampsCommand(on));
  const stampTimer = setInterval(() => {
    stampAggregator.sweep();
    if (!stampAggregator.wanted()) return;
    const now = Date.now();
    for (const ws of outputs.keys()) if (!lanSockets.has(ws) && now - (stampSeen.get(ws) ?? 0) > 2500) stampsCommand(true, ws);
  }, 2000);
  stampTimer.unref();
  wss.on('close', () => { clearInterval(timer); clearInterval(soundTimer); clearInterval(stampTimer); unwatch(); });
  return wss;
}

/** Tell output pages (all of them, or `only`) to start or stop stamping: {type:'command', command:'stamps', args:{on}}.
 *  Studios and paired stream PCs never get it. */
function stampsCommand(on: boolean, only?: WebSocket) {
  const data = JSON.stringify({ type: 'command', command: 'stamps', args: { on } });
  for (const ws of only ? [only] : outputs.keys()) {
    const kind = outputs.get(ws)?.kind;
    if (ws.readyState === WebSocket.OPEN && kind && STAMP_KINDS.has(kind) && !lanSockets.has(ws)) ws.send(data);
  }
}

/** One stamps message from an output page: handed to the aggregator, never relayed. Pages that did not say hello as a
 *  real output (previews, tests, studios) are ignored; the page id comes from the socket, not from the message. */
function stampsMsg(ws: WebSocket, data: Buffer) {
  if (data.length > STAMPS_MAX_BYTES) return;
  const kind = outputs.get(ws)?.kind;
  if (!kind || !STAMP_KINDS.has(kind)) return;
  let m: { type?: unknown; k?: unknown; s?: unknown };
  try { m = JSON.parse(data.toString('utf8')); } catch { return; }
  if (m.type !== 'broadcast' || m.k !== 'stamps' || !Array.isArray(m.s)) return;
  let id = stampIds.get(ws);
  if (!id) { id = `p${++stampSeq}`; stampIds.set(ws, id); }
  stampSeen.set(ws, Date.now());
  stampAggregator.ingest(id, m.s);
}

function soundMsg(ws: WebSocket, data: Buffer, local: boolean) {
  let m: unknown;
  try { m = JSON.parse(data.toString('utf8')); } catch { return; }
  sounds.message(ws, m, local);   // (grants go only to the studios that announced themselves: shared/audioLeader.ts)
}

/** Helper-side listeners of every server broadcast (server/goals.ts reads the support lane's {type:'support', ev} here). */
export const broadcastTaps = new Set<(msg: BusMessage) => void>();
/** Server-originated message to every connected client. */
export function broadcast(msg: BusMessage) {
  for (const t of broadcastTaps) { try { t(msg); } catch (e) { console.warn('[bus] tap', e); } }
  if (!wss) return;
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    // the same backpressure as the relay: skip a backed-up page (60 Hz ext tracking, 30 Hz music clock), cut a dead one
    if (client.bufferedAmount >= MAX_BUFFERED) { if (client.bufferedAmount >= CUT_BUFFERED) client.terminate(); continue; }
    const lc = lanSockets.get(client);
    const out = lc === undefined ? data : streamPc().busOut(data, lc);
    if (out !== null) client.send(out);
  }
}

/** Bus clients that count as studios / pages of a person: every socket except the guest browser source's headless sender
 *  (output.html?gsSend=1, shared/obsPages.ts `gs`), which the helper itself runs. Without this the sender held "a studio is
 *  open" up for as long as the guest link was on: no self-applied update, and the AI approval waited for a studio. */
export function busClientCount() {
  if (!wss) return 0;
  let n = 0;
  for (const ws of wss.clients) if (!outputs.get(ws)?.gs) n++;
  return n;
}

/** Output pages attached right now: how many show VTube Pro, how many of them inside OBS, at what size. */
export function outputPages(): OutputsSummary {
  for (const ws of outputs.keys()) if (ws.readyState !== WebSocket.OPEN) outputs.delete(ws);
  return summarizeOutputs(outputs.values());
}
