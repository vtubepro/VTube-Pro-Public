// Fetch one product / gift picture for the support image proxy (/api/support/img/…), safely:
//   * https only, no credentials in the address, public host names only (server/support/routes.ts hostOk);
//   * the address the socket ACTUALLY connects to is checked (a custom DNS lookup on the connection itself, so a name
//     that resolves to 127.0.0.1 / 10.x / 192.168.x / 169.254.x / ::1 / fc00::/7 … is refused, and a DNS answer can't
//     change between the check and the connect);
//   * redirects are followed by hand, at most 3, and every hop gets the same checks;
//   * the body is streamed with a hard cap, and only real image types are kept.
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import type { IncomingMessage } from 'node:http';

export const IMG_MAX_BYTES = 4 << 20;
const TYPES = /^image\/(png|jpeg|webp|gif|avif)\b/i;

/** Addresses a picture may never come from: this PC, the home network, link-local, CGNAT, multicast, reserved. */
export function privateIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (m) return privateIp(m[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x) || x.startsWith('64:ff9b:') || x.startsWith('2001:db8:');
  }
  return true;
}

/** dns.lookup that refuses private answers (used by the socket itself). */
const safeLookup: net.LookupFunction = (host, opts, cb) => {
  dns.lookup(host, { ...(typeof opts === 'object' ? opts : {}), all: true }, (err, list) => {
    if (err) { cb(err, '', 4); return; }
    const addrs = (Array.isArray(list) ? list : [list]) as dns.LookupAddress[];
    const bad = addrs.find((x) => privateIp(x.address));
    if (bad || !addrs.length) { cb(Object.assign(new Error('refused: that picture is on a private address'), { code: 'EPRIVATE' }), '', 4); return; }
    if ((opts as dns.LookupOptions)?.all) (cb as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, addrs);
    else cb(null, addrs[0].address, addrs[0].family);
  });
};

function get(url: URL): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { lookup: safeLookup, headers: { 'User-Agent': 'vtube-pro/1.0', Accept: 'image/*' }, timeout: 12000 }, resolve);
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

export class ImageFetchError extends Error { constructor(public status: number, msg: string) { super(msg); } }

/** The picture at `start` (after ≤ 3 checked redirects), or an ImageFetchError. `hostOk` = the name rule. */
export async function fetchImage(start: URL, hostOk: (h: string) => boolean): Promise<{ type: string; body: Buffer }> {
  let url = start;
  for (let hop = 0; hop <= 3; hop++) {
    if (url.protocol !== 'https:' || url.username || url.password || !hostOk(url.hostname)) throw new ImageFetchError(403, 'Image host not allowed');
    let res: IncomingMessage;
    try { res = await get(url); } catch (e) { throw new ImageFetchError((e as { code?: string }).code === 'EPRIVATE' ? 403 : 502, (e as Error).message); }
    const st = res.statusCode ?? 0;
    if (st >= 300 && st < 400 && res.headers.location) {
      res.resume();
      try { url = new URL(res.headers.location, url); } catch { throw new ImageFetchError(502, 'bad redirect'); }
      continue;
    }
    const type = String(res.headers['content-type'] ?? '');
    if (st !== 200 || !TYPES.test(type)) { res.resume(); throw new ImageFetchError(404, `image ${st}`); }
    if (Number(res.headers['content-length'] ?? 0) > IMG_MAX_BYTES) { res.destroy(); throw new ImageFetchError(413, 'image too big'); }
    const parts: Buffer[] = [];
    let n = 0;
    for await (const chunk of res) {
      n += (chunk as Buffer).length;
      if (n > IMG_MAX_BYTES) { res.destroy(); throw new ImageFetchError(413, 'image too big'); }
      parts.push(chunk as Buffer);
    }
    return { type: type.split(';')[0].trim(), body: Buffer.concat(parts) };
  }
  throw new ImageFetchError(502, 'too many redirects');
}
