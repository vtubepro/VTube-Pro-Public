// Local-only guard for the VTube Pro server (127.0.0.1:5191). Mounted first in server/index.ts (HTTP) and in the
// upgrade handler of server/bus.ts (every WebSocket path).
//
// Why: the server binds to loopback, but any website open in the user's browser can still reach it.
//  * DNS rebinding: evil.example re-resolves to 127.0.0.1, so its page can call http://evil.example:5191/api/... as a
//    SAME-origin request and read the answers (e.g. POST /api/blender/run = arbitrary Python). The browser still sends
//    `Host: evil.example:5191`, so every request whose Host is not a loopback name is refused (421).
//  * Cross-site "simple" POSTs (form posts / no-cors fetch with text/plain bodies) need no CORS preflight. State-changing
//    requests (anything but GET / HEAD / OPTIONS) therefore must carry no Origin (curl, Stream Deck, Streamer.bot, OBS,
//    tools/*) or a loopback Origin (the studio on :5190, the OBS / Chat Hub pages on :5191). `Origin: null` and
//    `Sec-Fetch-Site: cross-site` without a loopback Origin are refused too (403).
//  * WebSocket upgrades: same Host rule; a browser Origin must be loopback, except the paths in WS_ANY_ORIGIN
//    (/ws/vtt: the Foundry / Owlbear / Roll20 bridges run on those sites by design and are gated by the pairing code).
//
// Extra names for power users (comma separated, e.g. a reverse proxy or a hosts-file alias):
//   VTP_ALLOWED_HOSTS=myrig.lan,studio.local        extra Host names (port optional, any port accepted)
//   VTP_ALLOWED_ORIGINS=https://tools.example.com  extra browser origins allowed to POST / open sockets
//   VTP_BUS_ANY_ORIGIN=1                            (existing bus escape hatch) any Origin may open WebSockets
//
// No website is ever allowed to use this server: there is no origin allowlist and no CORS answer, so a page from
// another site can neither read an answer nor change anything.
// The server itself only listens on 127.0.0.1 (server/paths.ts HOST is fixed); the one way in from the home network is the
// optional Stream PC mode (server/streamPc.ts), which decides those requests itself, before this guard.
// LAN tracking sources (VTube Studio phone app, iFacialMocap, VMC, the VTS plugin API) use their own ports/servers.
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { NextFunction, Request, Response } from 'express';
import { streamPcOf } from './streamPcMark.ts';
import { streamPcUpgrade } from './streamPc.ts';

const LOOPBACK_NAME = /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)*\.localhost|127(\.\d{1,3}){3}|\[::1\]|\[::ffff:127(\.\d{1,3}){3}\])$/i;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** WebSocket paths any web page may open (the VTT bridges run on the tabletop sites by design and are gated by their pairing code). */
export const WS_ANY_ORIGIN = new Set(['/ws/vtt']);

const list = (v: string | undefined) => String(v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/** Split "name:port" / "[v6]:port" → name (lower case). */
function hostName(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) { const end = h.indexOf(']'); return end > 0 ? h.slice(0, end + 1) : h; }
  const i = h.lastIndexOf(':');
  return i >= 0 && /^\d{1,5}$/.test(h.slice(i + 1)) ? h.slice(0, i) : h;
}

/** The studio's dev server (Vite, proxies /api and /ws here). */
export const DEV_STUDIO_PORT = '5190';
const portOf = (u: URL) => u.port || (u.protocol === 'https:' ? '443' : '80');

/** A loopback Origin that is this server's own page (same port, any loopback name) or the dev studio. */
export function sameAppPort(origin: string, host: string | undefined): boolean {
  let o: URL;
  try { o = new URL(origin); } catch { return false; }
  const op = portOf(o);
  if (op === DEV_STUDIO_PORT) return true;
  const h = String(host ?? '').trim();
  const m = /:(\d{1,5})$/.exec(h.startsWith('[') ? h.slice(h.indexOf(']') + 1) : h);
  return op === (m ? m[1] : '80');
}

export function hostOk(host: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (host === undefined || host === '') return true; // HTTP/1.0 tools; browsers always send Host
  const name = hostName(host);
  return LOOPBACK_NAME.test(name) || list(env.VTP_ALLOWED_HOSTS).some((a) => hostName(a) === name);
}

export function originOk(origin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  let u: URL;
  try { u = new URL(origin); } catch { return false; }
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    if (u.origin.toLowerCase() === origin.toLowerCase().replace(/\/$/, '') && LOOPBACK_NAME.test(u.hostname.toLowerCase())) return true;
  }
  return list(env.VTP_ALLOWED_ORIGINS).includes(origin.toLowerCase().replace(/\/$/, ''));
}

/** No Origin (curl, tools, same-origin GETs) or a loopback page = this PC. Everything else is "the web" (a page from a site).
 *  The routes that keep a secret to this PC (stream keys, the OBS password, support keys, chat links) use it. */
export function isWebOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return false;
  if (origin === 'null') return true;
  try { return !LOOPBACK_NAME.test(new URL(origin).hostname.toLowerCase()); } catch { return true; }
}

export type Verdict = { ok: true } | { ok: false; status: 403 | 421; reason: string };

/** The whole policy, as a pure function of method / path / headers. */
export function checkRequest(method: string, path: string, headers: IncomingHttpHeaders, upgrade = false, env: NodeJS.ProcessEnv = process.env): Verdict {
  const host = headers.host;
  if (!hostOk(host, env)) return { ok: false, status: 421, reason: `Host "${host}" is not this PC (VTube Pro only answers to 127.0.0.1 / localhost)` };
  if (upgrade && (WS_ANY_ORIGIN.has(path) || env.VTP_BUS_ANY_ORIGIN === '1')) return { ok: true };
  const origin = typeof headers.origin === 'string' ? headers.origin : undefined;
  if (!upgrade && SAFE_METHODS.has(method.toUpperCase())) return { ok: true };
  if (origin !== undefined) {
    if (origin === 'null' || !originOk(origin, env)) return { ok: false, status: 403, reason: `Origin "${origin}" may not ${upgrade ? 'open sockets on' : 'change'} VTube Pro` };
    // security 2026-10: a loopback page on ANOTHER port (ComfyUI :8188, a dev server, any local web UI or a script injected
    // into one) gets no CORS answers, so all it could ever send are blind "simple" POSTs and sockets: refuse them. Ours are
    // the same port under any loopback name (the room preview: localhost ↔ 127.0.0.1) and the dev studio on :5190.
    if (!sameAppPort(origin, host) && !list(env.VTP_ALLOWED_ORIGINS).includes(origin.toLowerCase().replace(/\/$/, ''))) {
      return { ok: false, status: 403, reason: `Origin "${origin}" is another program on this PC; it may not ${upgrade ? 'open sockets on' : 'change'} VTube Pro` };
    }
    return { ok: true }; // our own loopback page: fine even when Sec-Fetch-Site says cross-site (localhost:5190 → 127.0.0.1:5191)
  }
  if (headers['sec-fetch-site'] === 'cross-site') return { ok: false, status: 403, reason: 'Cross-site request refused' };
  return { ok: true }; // no Origin: curl, Stream Deck, Streamer.bot, OBS, MCP, tools
}

const logged = new Set<string>();
function note(v: Extract<Verdict, { ok: false }>, what: string) {
  const key = `${v.status} ${v.reason}`;
  if (logged.has(key) || logged.size > 50) return;
  logged.add(key);
  console.warn(`[vtube-pro] blocked ${what}: ${v.reason}`);
}

/** Express middleware: mount before every route. */
export function localGuard() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (streamPcOf(req)) { next(); return; } // a paired stream PC: server/streamPc.ts gate() already decided (its own allow-list)
    const v = checkRequest(req.method, (req.url ?? '').split('?')[0], req.headers, false, process.env);
    if (v.ok) { next(); return; }
    note(v, `${req.method} ${(req.url ?? '').split('?')[0]}`);
    res.status(v.status).json({ error: v.reason });
  };
}

/** WebSocket upgrade gate: true = go ahead; false = a 403/421 was written and the socket closed. */
export function guardUpgrade(req: IncomingMessage, socket: Duplex): boolean {
  const lan = streamPcUpgrade(req, socket); if (lan !== null) return lan; // home-network sockets: Stream PC mode decides (server/streamPc.ts)
  const v = checkRequest(req.method ?? 'GET', (req.url ?? '').split('?')[0], req.headers, true, process.env);
  if (v.ok) return true;
  note(v, `WebSocket ${(req.url ?? '').split('?')[0]}`);
  const text = v.status === 421 ? 'Misdirected Request' : 'Forbidden';
  try { socket.end(`HTTP/1.1 ${v.status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* already gone */ }
  setTimeout(() => socket.destroy(), 1000).unref();
  return false;
}
