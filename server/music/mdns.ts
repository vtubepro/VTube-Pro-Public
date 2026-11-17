// A tiny mDNS / DNS-SD responder (RFC 6762 / 6763) that advertises ONE service, so VirtualDJ finds our OS2L server by
// itself (no Bonjour install). It only answers questions for its own service type and announces itself twice at start
// and says goodbye at stop — standard, harmless multicast on 224.0.0.251:5353. Pure packet code is exported for tests.
import dgram from 'node:dgram';
import os from 'node:os';

export interface ServiceAd { instance: string; type: string; port: number; host: string; ips: string[]; ttl?: number }

function name(n: string): Buffer {
  const parts = n.replace(/\.$/, '').split('.').filter(Boolean);
  const out: Buffer[] = [];
  for (const p of parts) { const b = Buffer.from(p, 'utf8').subarray(0, 63); out.push(Buffer.from([b.length]), b); }
  out.push(Buffer.from([0]));
  return Buffer.concat(out);
}
function rr(n: string, type: number, cls: number, ttl: number, data: Buffer): Buffer {
  const h = Buffer.alloc(10);
  h.writeUInt16BE(type, 0); h.writeUInt16BE(cls, 2); h.writeUInt32BE(ttl, 4); h.writeUInt16BE(data.length, 8);
  return Buffer.concat([name(n), h, data]);
}
const fqdn = (ad: ServiceAd) => `${ad.instance}.${ad.type}.local`;
/** The answer packet: PTR (shared) + SRV, TXT, A (unique, cache-flush). ttl 0 = goodbye. */
export function buildAnswer(ad: ServiceAd, ttl?: number): Buffer {
  const t = ttl ?? ad.ttl ?? 4500, ht = ttl ?? Math.min(120, ad.ttl ?? 120);
  const host = `${ad.host}.local`;
  const srv = Buffer.alloc(6); srv.writeUInt16BE(0, 0); srv.writeUInt16BE(0, 2); srv.writeUInt16BE(ad.port, 4);
  const records = [
    rr(`${ad.type}.local`, 12, 0x0001, t, name(fqdn(ad))),
    rr(fqdn(ad), 33, 0x8001, ht, Buffer.concat([srv, name(host)])),
    rr(fqdn(ad), 16, 0x8001, t, Buffer.from([0])),
    ...ad.ips.map((ip) => rr(host, 1, 0x8001, ht, Buffer.from(ip.split('.').map(Number)))),
  ];
  const head = Buffer.alloc(12);
  head.writeUInt16BE(0x8400, 2); head.writeUInt16BE(records.length, 6);
  return Buffer.concat([head, ...records]);
}

/** Read a (possibly compressed) DNS name at off → [name, next offset]. */
export function readName(b: Buffer, off: number, depth = 0): [string, number] {
  const labels: string[] = [];
  let o = off, end = -1;
  for (let guard = 0; guard < 128; guard++) {
    if (o >= b.length) throw new Error('name past end');
    const len = b[o];
    if (len === 0) { o++; break; }
    if ((len & 0xc0) === 0xc0) {
      if (o + 1 >= b.length || depth > 8) throw new Error('bad pointer');
      const ptr = ((len & 0x3f) << 8) | b[o + 1];
      if (end < 0) end = o + 2;
      const [rest] = readName(b, ptr, depth + 1);
      if (rest) labels.push(rest);
      o = end; return [labels.join('.'), end];
    }
    labels.push(b.toString('utf8', o + 1, o + 1 + len));
    o += 1 + len;
  }
  return [labels.join('.'), end >= 0 ? end : o];
}
/** Questions of a query packet: [{ name, type, unicast }] (empty for responses / junk). */
export function parseQuestions(b: Buffer): { name: string; type: number; unicast: boolean }[] {
  if (b.length < 12 || (b.readUInt16BE(2) & 0x8000)) return [];
  const qd = b.readUInt16BE(4);
  const out: { name: string; type: number; unicast: boolean }[] = [];
  let o = 12;
  for (let i = 0; i < qd && i < 32; i++) {
    const [n, next] = readName(b, o);
    if (next + 4 > b.length) break;
    out.push({ name: n.toLowerCase(), type: b.readUInt16BE(next), unicast: (b.readUInt16BE(next + 2) & 0x8000) !== 0 });
    o = next + 4;
  }
  return out;
}

const GROUP = '224.0.0.251', PORT = 5353;

/** Advertise one service until stop(). Errors (port busy, no network) just leave it quiet. */
export class MdnsAdvertiser {
  private sock: dgram.Socket | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  ok = false;
  constructor(private ad: ServiceAd) {}
  static host() { return (os.hostname() || 'vtubepro').replace(/[^A-Za-z0-9-]/g, '-').slice(0, 40) || 'vtubepro'; }
  async start() {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock = s;
    s.on('error', () => { this.ok = false; });
    await new Promise<void>((res) => { s.once('error', () => res()); s.bind(PORT, '0.0.0.0', () => res()); });
    try { s.addMembership(GROUP); s.setMulticastTTL(255); this.ok = true; } catch { this.ok = false; return; }
    const want = `${this.ad.type}.local`.toLowerCase(), self = fqdn(this.ad).toLowerCase();
    s.on('message', (m, r) => {
      let qs: ReturnType<typeof parseQuestions>;
      try { qs = parseQuestions(m); } catch { return; }
      if (!qs.some((q) => (q.name === want && (q.type === 12 || q.type === 255)) || (q.name === self && (q.type === 33 || q.type === 16 || q.type === 255)) || (q.name === '_services._dns-sd._udp.local' && q.type === 12))) return;
      const pkt = buildAnswer(this.ad);
      // a legacy (non-5353) or QU querier gets a unicast answer; everyone else the group, after a short random wait
      if (r.port !== PORT || qs.some((q) => q.unicast)) s.send(pkt, r.port, r.address);
      else this.timers.push(setTimeout(() => s.send(pkt, PORT, GROUP), 20 + Math.random() * 100));
    });
    const announce = () => { try { s.send(buildAnswer(this.ad), PORT, GROUP); } catch { /* down */ } };
    announce();
    this.timers.push(setTimeout(announce, 1000));
  }
  async stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    const s = this.sock; this.sock = null;
    if (!s) return;
    if (this.ok) await new Promise<void>((res) => { try { s.send(buildAnswer(this.ad, 0), PORT, GROUP, () => res()); } catch { res(); } setTimeout(res, 200); });
    try { s.close(); } catch { /* closed */ }
  }
}
