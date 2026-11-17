// OS2L server: VirtualDJ (and rkbx_os2l, and any OS2L sender) connects to US and sends a JSON message on every beat:
//   {"evt":"beat","change":false,"pos":42,"bpm":128.0,"strength":0.9}   (pos % 4 == 0 on bar starts, pos % 16 phrases)
// Spec: https://os2l.org. Messages arrive back to back (no separator) — parsed by brace depth, strings respected.
// We advertise `_os2l._tcp` over mDNS (server/music/mdns.ts) so VirtualDJ finds us with no setup; without Bonjour the
// user can set VirtualDJ's os2lDirectIp to 127.0.0.1:<port>. LISTEN-ONLY: we never send feedback.
import net from 'node:net';
import os from 'node:os';
import { GridTracker, type ControllerEvent, type SourceSample } from '../../shared/musicClock.ts';
import { MdnsAdvertiser } from './mdns.ts';
import { plainNetError, Rate, type Adapter, type AdapterCtx, type AdapterStatus } from './net.ts';

/** Splits a byte stream into top-level JSON objects (tolerates newlines / spaces between them). Incremental: each byte is
 *  scanned once; an object (or junk) longer than `max` resets the stream and `overflowed` is set (the caller drops the peer). */
export class JsonObjectStream {
  private buf = '';
  private pos = 0;
  private depth = 0;
  private start = -1;
  private inStr = false;
  private esc = false;
  overflowed = false;
  constructor(private max = 64 * 1024) {}
  push(chunk: string): unknown[] {
    this.buf += chunk;
    const out: unknown[] = [];
    let cut = 0;
    for (; this.pos < this.buf.length; this.pos++) {
      const c = this.buf[this.pos];
      if (this.inStr) { if (this.esc) this.esc = false; else if (c === '\\') this.esc = true; else if (c === '"') this.inStr = false; continue; }
      if (c === '"') { if (this.depth > 0) this.inStr = true; continue; }
      if (c === '{') { if (this.depth === 0) this.start = this.pos; this.depth++; }
      else if (c === '}' && this.depth > 0) {
        this.depth--;
        if (this.depth === 0 && this.start >= 0) {
          try { out.push(JSON.parse(this.buf.slice(this.start, this.pos + 1))); } catch { /* skip a broken object */ }
          cut = this.pos + 1; this.start = -1;
        }
      } else if (this.depth === 0) cut = this.pos + 1;   // whitespace / junk between objects
    }
    // keep only the unfinished object
    if (cut > 0) { this.buf = this.buf.slice(cut); this.pos -= cut; if (this.start >= 0) this.start -= cut; }
    if (this.buf.length > this.max) { this.overflowed = true; this.buf = ''; this.pos = 0; this.depth = 0; this.start = -1; this.inStr = false; this.esc = false; }
    return out;
  }
}

export interface Os2lBeat { pos: number; bpm: number; change: boolean; strength?: number }
export function parseOs2l(o: unknown): { beat?: Os2lBeat; btn?: { name: string; page: string; on: boolean }; cmd?: { id: number; param: number } } {
  if (!o || typeof o !== 'object') return {};
  const x = o as Record<string, unknown>;
  if (x.evt === 'beat' && typeof x.pos === 'number' && Number.isFinite(x.pos) && typeof x.bpm === 'number' && x.bpm > 0 && x.bpm < 1000)
    return { beat: { pos: Math.round(x.pos), bpm: x.bpm, change: x.change === true, ...(typeof x.strength === 'number' ? { strength: x.strength } : {}) } };
  if (x.evt === 'btn' && typeof x.name === 'string') return { btn: { name: x.name.slice(0, 60), page: typeof x.page === 'string' ? x.page.slice(0, 60) : '', on: x.state === 'on' } };
  if (x.evt === 'cmd' && typeof x.id === 'number') return { cmd: { id: x.id, param: typeof x.param === 'number' ? x.param : 0 } };
  return {};
}

export interface Os2lConfig { port: number; bind?: string; mdns: boolean }
const MAX_BYTES_PER_S = 32 * 1024, MAX_MSGS_PER_S = 60;

export class Os2lAdapter implements Adapter {
  readonly id = 'os2l' as const;
  private server: net.Server | null = null;
  private mdns: MdnsAdvertiser | null = null;
  private clients = new Map<net.Socket, string>();
  private grid = new GridTracker(4000);
  private lastPos = NaN;
  private lastBeatAt = -Infinity;
  private bpm = 0;
  private state: AdapterStatus['state'] = 'off';
  private says = '';
  private rate = new Rate();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Peers cut off for flooding. */
  dropped = 0;
  constructor(private ctx: AdapterCtx, private cfg: Os2lConfig) {}

  async start() {
    this.state = 'starting';
    const srv = net.createServer((sock) => this.client(sock));
    try {
      await new Promise<void>((res, rej) => { srv.once('error', rej); srv.listen(this.cfg.port, this.cfg.bind ?? '127.0.0.1', () => { srv.off('error', rej); res(); }); });
    } catch (e) {
      this.state = 'error'; this.says = plainNetError(e, 'the OS2L port', this.cfg.port);
      return;
    }
    srv.on('error', () => { /* keep going */ });
    this.server = srv;
    this.state = 'listening';
    this.says = `Waiting for VirtualDJ (OS2L, port ${this.cfg.port}).`;
    if (this.cfg.mdns) {
      this.mdns = new MdnsAdvertiser({ instance: 'VTube Pro', type: '_os2l._tcp', port: this.cfg.port, host: MdnsAdvertiser.host(), ips: !this.cfg.bind || this.cfg.bind === '0.0.0.0' ? localIps() : [this.cfg.bind] });   // (this PC only → 127.0.0.1)
      void this.mdns.start().catch(() => {});
    }
    this.timer = setInterval(() => this.tickStale(), 500);
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.mdns?.stop().catch(() => {});
    this.mdns = null;
    for (const s of this.clients.keys()) s.destroy();
    this.clients.clear();
    await new Promise<void>((res) => { if (!this.server) return res(); this.server.close(() => res()); });
    this.server = null;
    this.ctx.drop('os2l');
    this.state = 'off';
  }

  private client(sock: net.Socket) {
    if (this.clients.size >= 8) { sock.destroy(); return; }
    const who = sock.remoteAddress === '127.0.0.1' || sock.remoteAddress === '::1' || sock.remoteAddress === '::ffff:127.0.0.1' ? 'this PC' : (sock.remoteAddress ?? '?').replace(/^::ffff:/, '');
    this.clients.set(sock, who);
    const js = new JsonObjectStream();
    sock.setEncoding('utf8');
    // rate limit: OS2L is one small message per beat (+ the odd button); a peer far past that is cut off
    let winAt = 0, bytes = 0, msgs = 0;
    sock.on('data', (d: string) => {
      const now = Date.now();
      if (now - winAt > 1000) { winAt = now; bytes = 0; msgs = 0; }
      bytes += d.length;
      const objs = js.push(d);
      msgs += objs.length;
      if (js.overflowed || bytes > MAX_BYTES_PER_S || msgs > MAX_MSGS_PER_S) { this.dropped++; sock.destroy(); return; }
      for (const o of objs) this.message(o);
    });
    const bye = () => { this.clients.delete(sock); };
    sock.on('error', bye); sock.on('close', bye);
  }

  private message(o: unknown) {
    const m = parseOs2l(o);
    const now = this.ctx.now();
    if (m.beat) {
      this.rate.hit();
      const b = m.beat;
      this.grid.observe(now, b.pos, b.bpm);
      this.lastPos = b.pos; this.lastBeatAt = now; this.bpm = b.bpm;
      this.emit(now);
    } else if (m.btn || m.cmd) {
      const ev: ControllerEvent = m.btn ? { t: now, kind: 'button', deck: 0, v: m.btn.on ? 1 : 0 } : { t: now, kind: 'button', deck: 0, i: Math.max(0, Math.min(63, m.cmd!.id)), v: m.cmd!.param / 100 };
      this.ctx.controller([ev], 'os2l');
    }
  }

  private playing(now: number) { return this.bpm > 0 && now - this.lastBeatAt < (60000 / this.bpm) * 2 + 400; }
  private emit(now: number) {
    if (!this.grid.ready) return;
    const g = this.grid;
    const fl = Math.floor(g.beat);
    this.ctx.sample({
      src: 'os2l', key: 'os2l', name: `VirtualDJ (OS2L${this.clients.size ? `, ${[...new Set(this.clients.values())].join(', ')}` : ''})`,
      at: g.at, bpm: g.bpm, beat: g.beat, bar: ((fl % 4) + 4) % 4, playing: this.playing(now), q: 1,
    } satisfies SourceSample);
  }
  private tickStale() { const now = this.ctx.now(); if (this.grid.ready && !this.playing(now) && now - this.lastBeatAt < 60000) this.emit(now); }

  status(): AdapterStatus {
    const now = this.ctx.now();
    const apps = [...new Set(this.clients.values())];
    let says = this.says;
    if (this.state === 'listening' || this.state === 'connected') {
      this.state = apps.length ? 'connected' : 'listening';
      says = !apps.length ? `Waiting for VirtualDJ (OS2L, port ${this.cfg.port}).` : this.playing(now) ? `VirtualDJ connected · ${this.bpm.toFixed(1)} BPM.` : 'VirtualDJ connected — play a track.';
    }
    return { id: 'os2l', label: 'VirtualDJ (OS2L)', state: this.state, says, found: apps.map((a) => `OS2L app on ${a}`), rate: this.rate.get(), extra: { port: this.cfg.port, mdns: !!this.mdns?.ok, lastPos: Number.isFinite(this.lastPos) ? this.lastPos : null } };
  }
}

function localIps(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out.length ? out.slice(0, 4) : ['127.0.0.1'];
}
