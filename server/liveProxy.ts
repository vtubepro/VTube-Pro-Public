// Pure helpers of the live-stream proxy (server/routes/videos.ts GET /api/videos/proxy), kept apart for unit tests.
import net from 'node:net';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

/** Hosts the proxy refuses: loopback, private, link-local, CGNAT, multicast, *.local / *.localhost / *.lan names. */
export function blockedHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!h || h === 'localhost' || /\.(localhost|local|lan|internal|home|arpa)$/.test(h) || !h.includes('.') && !net.isIP(h)) return true;
  if (net.isIP(h)) return privateAddress(h);
  return false;
}

/** True for any address that is not public unicast internet: loopback, RFC1918, link-local, CGNAT (100.64/10), "this
 *  network", benchmarking, documentation ranges, multicast/reserved; IPv6 loopback/unspecified, ULA fc00::/7,
 *  link-local fe80::/10, site-local, multicast; IPv4 embedded in IPv6 (mapped ::ffff:, compatible, NAT64 64:ff9b::,
 *  6to4 2002::) is checked as the IPv4 it carries, Teredo is refused. Unparseable input counts as private. */
export function privateAddress(ip: string): boolean {
  const a0 = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase();
  const v = net.isIP(a0);
  if (v === 4) {
    const [a, b, c] = a0.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))
      || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
  }
  if (v !== 6) return true;
  const w = expand6(a0);
  if (!w) return true;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (w.slice(0, 7).every((x) => x === 0) && (w[7] === 0 || w[7] === 1)) return true;                  // :: and ::1
  if (w.slice(0, 5).every((x) => x === 0) && (w[5] === 0xffff || w[5] === 0)) return privateAddress(v4(w[6], w[7])); // ::ffff:a.b.c.d / ::a.b.c.d
  if (w[0] === 0x64 && w[1] === 0xff9b) return privateAddress(v4(w[6], w[7]));                          // NAT64
  if (w[0] === 0x2002) return privateAddress(v4(w[1], w[2]));                                           // 6to4
  if (w[0] === 0x2001 && (w[1] === 0 || w[1] === 0xdb8)) return true;                                   // Teredo, documentation
  return (w[0] & 0xfe00) === 0xfc00 || (w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xffc0) === 0xfec0 || (w[0] & 0xff00) === 0xff00;
}

/** "a:b::c" (optionally ending in a dotted IPv4) -> 8 16-bit words, or null. */
function expand6(s: string): number[] | null {
  let t = s;
  const m = /(\d+\.\d+\.\d+\.\d+)$/.exec(t);
  if (m) {
    const p = m[1].split('.').map(Number);
    t = t.slice(0, -m[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = t.split('::');
  if (halves.length > 2) return null;
  const part = (x: string) => (x ? x.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)) : []);
  const hi = part(halves[0]), lo = halves.length === 2 ? part(halves[1]) : [];
  const fill = 8 - hi.length - lo.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const w = [...hi, ...Array<number>(fill).fill(0), ...lo];
  return w.some((x) => !Number.isFinite(x)) ? null : w;
}

type LookupAddr = { address: string; family: number };
export type Resolver = (host: string, cb: (err: Error | null, addrs: LookupAddr[]) => void) => void;
const sysResolve: Resolver = (host, cb) => dns.lookup(host, { all: true, verbatim: true }, (e, a) => cb(e, a ?? []));

export class BlockedAddressError extends Error {
  constructor(host: string, ip: string) { super(`${host} is a local/private address (${ip})`); this.name = 'BlockedAddressError'; }
}

/** A net/http `lookup` that resolves the name ONCE and refuses the connection if ANY resolved address is private. The
 *  socket connects only to the checked addresses, so a DNS-rebinding name cannot swap in 127.0.0.1 afterwards. */
export function guardedLookup(resolve: Resolver = sysResolve, isBlocked: (ip: string, host: string) => boolean = privateAddress) {
  return (host: string, opts: { all?: boolean } | number, cb: (...a: unknown[]) => void): void => {
    const all = typeof opts === 'object' && !!opts?.all;
    resolve(host, (err, addrs) => {
      if (err) { cb(err); return; }
      if (!addrs.length) { cb(Object.assign(new Error(`${host} did not resolve`), { code: 'ENOTFOUND' })); return; }
      const bad = addrs.find((a) => isBlocked(a.address, host));
      if (bad) { cb(new BlockedAddressError(host, bad.address)); return; }
      if (all) cb(null, addrs); else cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

export interface ProxyFetchOpts {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  maxRedirects?: number;
  /** Test hooks: the resolver and the address policy (defaults: system DNS + privateAddress). */
  resolve?: Resolver;
  isBlocked?: (ip: string, host: string) => boolean;
}

/** GET an http(s) URL for the proxy. Every hop (the first URL and each redirect) is checked by name (blockedHost) and by
 *  every address its name resolves to, at connect time. Redirects are followed manually (max 5, http(s) only). Returns a
 *  web Response plus the final URL; throws BlockedAddressError for local targets. */
export async function proxyFetch(url: URL, o: ProxyFetchOpts = {}): Promise<{ res: Response; url: URL }> {
  const isBlocked = o.isBlocked ?? privateAddress;
  const lookup = guardedLookup(o.resolve, isBlocked);
  let cur = url;
  for (let hop = 0; ; hop++) {
    if (!/^https?:$/.test(cur.protocol)) throw new BlockedAddressError(cur.href, cur.protocol);
    const host = cur.hostname.replace(/^\[|\]$/g, '');
    if (blockedHost(cur.hostname) || (net.isIP(host) && isBlocked(host, host))) throw new BlockedAddressError(cur.hostname, host);
    const msg = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const mod = cur.protocol === 'https:' ? https : http;
      const req = mod.request(cur, { method: 'GET', headers: o.headers, lookup: lookup as never, signal: o.signal, agent: false }, resolve);
      req.on('error', reject);
      req.end();
    });
    const st = msg.statusCode ?? 502;
    const loc = msg.headers.location;
    if (st >= 300 && st < 400 && st !== 304 && loc) {
      msg.resume();
      if (hop >= (o.maxRedirects ?? 5)) throw new Error('Too many redirects');
      cur = new URL(loc, cur);
      continue;
    }
    const h = new Headers();
    for (const [k, v] of Object.entries(msg.headers)) if (v != null) for (const x of Array.isArray(v) ? v : [v]) h.append(k, String(x));
    const nullBody = st === 204 || st === 304 || st < 200 || st > 599;
    if (nullBody) msg.resume();
    const body = nullBody ? null : (Readable.toWeb(msg) as unknown as ReadableStream);
    return { res: new Response(body, { status: st < 200 || st > 599 ? 502 : st, headers: h }), url: cur };
  }
}

/** Rewrite every URI in an HLS playlist to an absolute proxied one. */
export function rewritePlaylist(text: string, base: string, prox: (u: string) => string): string {
  const abs = (u: string) => { try { return prox(new URL(u, base).toString()); } catch { return u; } };
  return text.split(/\r?\n/).map((l) => {
    const t = l.trim();
    if (!t) return l;
    if (t.startsWith('#')) return l.replace(/URI="([^"]+)"/g, (_m, u: string) => `URI="${abs(u)}"`);
    return abs(t);
  }).join('\n');
}
