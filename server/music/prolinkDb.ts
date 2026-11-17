// Pro DJ Link dbserver client (TCP): asks a player for the loaded track's title / artist / key and its rekordbox phrase
// analysis (PSSI). Read-only queries, the same ones rekordbox-aware lighting / video tools make; used only in the opt-in
// "track names + drop countdown" mode (server/music/prolink.ts). Message format: server/music/prolinkPackets.ts.
import net from 'node:net';
import { DB, ITEM, dmst, encodeMessage, fourcc, n4, readMessage, type DbMessage } from './prolinkPackets.ts';

export interface TrackMeta { title?: string; artist?: string; key?: string; bpm?: number; durationSec?: number }

const TIMEOUT = 4000;
/** Bounded reads: a menu or a PSSI tag is a few KB; anything past 2 MB is a broken or hostile peer. */
const MAX_BUF = 2 << 20;

/** A tiny framed reader over a socket. */
class Conn {
  private buf = Buffer.alloc(0);
  private waiters: (() => void)[] = [];
  private err: Error | null = null;
  constructor(public sock: net.Socket) {
    sock.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      if (this.buf.length > MAX_BUF) { this.err = new Error('the player sent too much'); this.buf = Buffer.alloc(0); sock.destroy(); }
      this.wake();
    });
    sock.on('error', (e) => { this.err = e; this.wake(); });
    sock.on('close', () => { this.err ??= new Error('closed'); this.wake(); });
  }
  private wake() { const w = this.waiters; this.waiters = []; for (const f of w) f(); }
  private wait(ms: number) {
    return new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('the player didn’t answer')), ms);
      this.waiters.push(() => { clearTimeout(t); res(); });
    });
  }
  async bytes(n: number, ms = TIMEOUT): Promise<Buffer> {
    const until = Date.now() + ms;
    while (this.buf.length < n) { if (this.err) throw this.err; await this.wait(Math.max(1, until - Date.now())); }
    const out = this.buf.subarray(0, n); this.buf = this.buf.subarray(n); return Buffer.from(out);
  }
  async message(ms = TIMEOUT): Promise<DbMessage> {
    const until = Date.now() + ms;
    for (;;) {
      let r: ReturnType<typeof readMessage>;
      try { r = readMessage(this.buf); } catch (e) { this.buf = Buffer.alloc(0); this.sock.destroy(); throw e; }
      if (r) { this.buf = this.buf.subarray(r[1]); return r[0]; }
      if (this.err) throw this.err;
      await this.wait(Math.max(1, until - Date.now()));
    }
  }
  write(b: Buffer) { this.sock.write(b); }
  close() { try { this.sock.destroy(); } catch { /* gone */ } }
}

function connect(host: string, port: number): Promise<net.Socket> {
  return new Promise((res, rej) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); rej(new Error('no answer')); }, TIMEOUT);
    s.once('connect', () => { clearTimeout(t); s.setNoDelay(true); res(s); });
    s.once('error', (e) => { clearTimeout(t); rej(e); });
  });
}

export class DbClient {
  private c: Conn | null = null;
  private tx = 1;
  /** `device`: the player number we speak as inside queries (players only answer 1–6 / a present player). */
  constructor(private host: string, private device: number, private lookupPort = 12523) {}

  async open() {
    // 1) where is the dbserver? ("RemoteDBServer" on 12523 → a 2-byte port)
    const q = new Conn(await connect(this.host, this.lookupPort));
    const hello = Buffer.alloc(19);
    hello.writeUInt32BE(15, 0); hello.write('RemoteDBServer', 4, 'latin1');
    q.write(hello);
    const port = (await q.bytes(2)).readUInt16BE(0);
    q.close();
    // 2) greet + 3) set up a session as our device number
    const c = new Conn(await connect(this.host, port));
    this.c = c;
    c.write(Buffer.from([0x11, 0, 0, 0, 1]));
    await c.bytes(5);
    c.write(encodeMessage({ tx: 0xfffffffe, type: DB.setup, args: [n4(this.device)] }));
    const r = await c.message();
    if (r.type !== DB.menuAvail) throw new Error('the player refused the query');
  }
  close() {
    try { this.c?.write(encodeMessage({ tx: 0xfffffffe, type: 0x0100, args: [] })); } catch { /* gone */ }
    this.c?.close(); this.c = null;
  }

  private async ask(type: number, args: DbMessage['args']): Promise<DbMessage> {
    if (!this.c) throw new Error('not connected');
    const tx = this.tx++;
    this.c.write(encodeMessage({ tx, type, args }));
    for (;;) { const m = await this.c.message(); if (m.tx === tx) return m; }
  }

  /** Title / artist / key / tempo / length of a rekordbox track in a slot (3 USB, 2 SD, 4 the rekordbox collection). */
  async metadata(slot: number, rekordboxId: number): Promise<TrackMeta> {
    const avail = await this.ask(DB.metadata, [dmst(this.device, slot, 1), n4(rekordboxId)]);
    const count = avail.args[1]?.t === 'n4' ? avail.args[1].v : 0;
    if (avail.type !== DB.menuAvail || !count || count === 0xffffffff) return {};
    const c = this.c!;
    const tx = this.tx++;
    c.write(encodeMessage({ tx, type: DB.render, args: [dmst(this.device, slot, 1), n4(0), n4(count), n4(0), n4(count), n4(0)] }));
    const out: TrackMeta = {};
    for (let guard = 0; guard < count + 4; guard++) {
      const m = await c.message();
      if (m.tx !== tx) continue;
      if (m.type === DB.menuFooter || m.type === DB.error) break;
      if (m.type !== DB.menuItem) continue;
      const kind = m.args[6]?.t === 'n4' ? m.args[6].v & 0xff : -1;
      const label = m.args[3]?.t === 'str' ? m.args[3].v : '';
      const main = m.args[1]?.t === 'n4' ? m.args[1].v : 0;
      if (kind === ITEM.title) out.title = label;
      else if (kind === ITEM.artist) out.artist = label;
      else if (kind === ITEM.key) out.key = label;
      else if (kind === ITEM.tempo) out.bpm = main / 100;
      else if (kind === ITEM.duration) out.durationSec = main;
    }
    return out;
  }

  /** The track's phrase analysis tag (PSSI from the .EXT analysis file), raw (parse with parsePssi). null = none. */
  async pssi(slot: number, trackType: number, rekordboxId: number): Promise<Buffer | null> { return this.anlzTag(slot, trackType, rekordboxId, 'PSSI', 'EXT'); }
  /** Any tag of the track's analysis files (PQTZ grid from .DAT, PWV6 3-band waveform from .2EX, PSSI …), raw from its
   *  four-letter id on. null = the player has none. (Track library: server/music/trackSync.ts) */
  async anlzTag(slot: number, trackType: number, rekordboxId: number, tag: string, ext: 'DAT' | 'EXT' | '2EX'): Promise<Buffer | null> {
    const extId = ((ext.charCodeAt(2) << 16) | (ext.charCodeAt(1) << 8) | ext.charCodeAt(0)) >>> 0;
    const r = await this.ask(DB.anlzTag, [dmst(this.device, slot, trackType), n4(rekordboxId), n4(fourcc(tag)), n4(extId)]);
    if (r.type !== DB.anlzReply) return null;
    const blob = r.args[3];
    if (!blob || blob.t !== 'blob' || blob.v.length < 4 + 12) return null;
    const t = blob.v.subarray(4);   // (the first 4 bytes are a length)
    return t.toString('latin1', 0, 4) === tag ? Buffer.from(t) : null;
  }
}
