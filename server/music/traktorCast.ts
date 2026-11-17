// Traktor's "now playing", the way Traktor shares it: its Broadcasting feature sends the mix to an Icecast server and
// puts the on-air track's title and artist into that stream (Ogg Vorbis comments, a new set at every track change).
// With "Track names from Traktor" on, VTube Pro acts as that server on THIS PC only (127.0.0.1, a port the user types
// into Traktor), reads the title / artist out of the stream and drops everything else as it arrives: no audio is kept,
// stored, decoded, played or forwarded, and nothing is sent anywhere. Off until the user turns it on.
// Pure stream parser (OggMeta) + the local listener: tools/djtrack_unit.ts (section "traktorcast").
import net from 'node:net';

/** Ogg pages in, Vorbis comment titles out. Only a comment packet is ever reassembled (≤ 64 KB); audio pages are
 *  skipped as they arrive. */
export class OggMeta {
  private buf: Buffer = Buffer.alloc(0);
  /** Per logical stream: the comment packet being put together (null = skipping a non-comment packet). */
  private pkt = new Map<number, Buffer[] | null>();
  bytes = 0;
  push(chunk: Buffer): { title?: string; artist?: string }[] {
    this.bytes += chunk.length;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: { title?: string; artist?: string }[] = [];
    for (;;) {
      const s = this.buf.indexOf('OggS');
      if (s < 0) { this.buf = this.buf.subarray(Math.max(0, this.buf.length - 3)); break; }
      if (s > 0) this.buf = this.buf.subarray(s);
      if (this.buf.length < 27) break;
      const flags = this.buf[5], serial = this.buf.readUInt32LE(14), n = this.buf[26];
      if (this.buf.length < 27 + n) break;
      const seg = this.buf.subarray(27, 27 + n);
      let body = 0; for (const x of seg) body += x;
      if (this.buf.length < 27 + n + body) { if (this.buf.length > 70000) this.buf = this.buf.subarray(4); break; }   // (a page is ≤ 65 KB)
      let o = 27 + n;
      let cur = (flags & 1) ? this.pkt.get(serial) ?? null : undefined;   // continued packet from the last page?
      for (let i = 0; i < n; i++) {
        const len = seg[i], piece = this.buf.subarray(o, o + len); o += len;
        if (cur === undefined) cur = piece.length >= 7 && piece[0] === 3 && piece.toString('latin1', 1, 7) === 'vorbis' ? [] : null;
        if (cur) { cur.push(Buffer.from(piece)); if (cur.reduce((a, b) => a + b.length, 0) > 65536) cur = null; }
        if (len < 255) { if (cur) { const m = vorbisComment(Buffer.concat(cur)); if (m) out.push(m); } cur = undefined; }
      }
      this.pkt.set(serial, cur === undefined ? null : cur);
      if (this.pkt.size > 16) this.pkt.delete(this.pkt.keys().next().value!);
      this.buf = this.buf.subarray(o);
    }
    return out;
  }
}
/** A Vorbis comment packet → title / artist (null = not one, or nothing useful in it). */
export function vorbisComment(p: Buffer): { title?: string; artist?: string } | null {
  if (p.length < 15 || p[0] !== 3 || p.toString('latin1', 1, 7) !== 'vorbis') return null;
  let o = 7;
  const vl = p.readUInt32LE(o); o += 4 + vl;
  if (o + 4 > p.length) return null;
  const n = Math.min(p.readUInt32LE(o), 256); o += 4;
  const r: { title?: string; artist?: string } = {};
  for (let i = 0; i < n && o + 4 <= p.length; i++) {
    const l = p.readUInt32LE(o); o += 4;
    if (o + l > p.length) break;
    const kv = p.toString('utf8', o, o + Math.min(l, 2000)); o += l;
    const eq = kv.indexOf('='); if (eq < 0) continue;
    const k = kv.slice(0, eq).toUpperCase(), v = kv.slice(eq + 1).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
    if (k === 'TITLE' && v) r.title = v; else if (k === 'ARTIST' && v) r.artist = v;
  }
  return r.title || r.artist ? r : null;
}

export interface CastStatus { on: boolean; port: number; connected: boolean; title?: string; artist?: string; at: number; says: string }
/** The local "Icecast" Traktor broadcasts to (127.0.0.1 only; one connection at a time). */
export class TraktorCast {
  private srv: net.Server | null = null;
  private sock: net.Socket | null = null;
  st: CastStatus = { on: false, port: 0, connected: false, at: 0, says: '' };
  constructor(private onMeta: (m: { title?: string; artist?: string }) => void, private now: () => number = Date.now) {}
  start(port: number): Promise<void> {
    this.stop();
    this.st = { on: true, port, connected: false, at: 0, says: `Waiting for Traktor on 127.0.0.1:${port} (press Broadcasting in Traktor).` };
    return new Promise((res) => {
      const srv = net.createServer((s) => this.conn(s));
      srv.maxConnections = 2;
      srv.once('error', (e: NodeJS.ErrnoException) => { this.st.says = e.code === 'EADDRINUSE' ? `Port ${port} is used by another program: pick another port here and in Traktor.` : 'Couldn’t start the Traktor receiver.'; this.st.on = false; this.srv = null; res(); });
      srv.listen(port, '127.0.0.1', () => res());
      this.srv = srv;
    });
  }
  stop() {
    try { this.sock?.destroy(); } catch { /* gone */ }
    try { this.srv?.close(); } catch { /* closed */ }
    this.sock = null; this.srv = null;
    this.st = { ...this.st, on: false, connected: false, says: '' };
  }
  private conn(s: net.Socket) {
    if (this.sock) { s.destroy(); return; }   // (one broadcaster at a time)
    this.sock = s;
    s.setTimeout(60000, () => s.destroy());
    let head: Buffer | null = Buffer.alloc(0);
    const ogg = new OggMeta();
    s.on('data', (d: Buffer) => {
      if (head) {
        head = Buffer.concat([head, d]);
        const e = head.indexOf('\r\n\r\n');
        if (e < 0) { if (head.length > 8192) s.destroy(); return; }
        const req = head.toString('latin1', 0, e), rest = head.subarray(e + 4);
        head = null;
        const line = req.split('\r\n')[0] ?? '';
        const m = /^(SOURCE|PUT|GET)\s+(\S+)/.exec(line);
        if (!m) { s.end('HTTP/1.0 400 Bad Request\r\n\r\n'); return; }
        if (m[1] === 'GET') {
          // SHOUTcast-style metadata update (some broadcasters): /admin/metadata?mode=updinfo&song=Artist - Title
          try { const u = new URL(m[2], 'http://x'); const song = u.searchParams.get('song'); if (song) { const [a, ...t] = song.split(' - '); this.meta(t.length ? { artist: a, title: t.join(' - ') } : { title: song }); } } catch { /* bad url */ }
          s.end('HTTP/1.0 200 OK\r\nContent-Type: text/xml\r\n\r\n<?xml version="1.0"?><iceresponse><message>Metadata update successful</message><return>1</return></iceresponse>');
          return;
        }
        s.write('HTTP/1.0 200 OK\r\nServer: Icecast 2.4.4\r\n\r\n');
        this.st.connected = true; this.st.says = 'Traktor is connected.';
        d = rest;
      }
      for (const meta of ogg.push(d)) this.meta(meta);
    });
    const end = () => { if (this.sock === s) { this.sock = null; this.st.connected = false; if (this.st.on) this.st.says = `Waiting for Traktor on 127.0.0.1:${this.st.port}.`; } };
    s.on('close', end); s.on('error', end);
  }
  private meta(m: { title?: string; artist?: string }) {
    this.st.title = m.title; this.st.artist = m.artist; this.st.at = this.now();
    try { this.onMeta(m); } catch { /* never break the receiver */ }
  }
}
