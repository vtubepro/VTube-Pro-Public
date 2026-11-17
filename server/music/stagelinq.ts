// StageLinQ adapter: Denon DJ / Engine OS hardware on the DJ's network (SC6000 / SC5000, Prime 4 / 2 / Go, SC Live,
// X1800 / X1850 mixers). Gets per-deck beat position + BPM (BeatInfo), and title, artist, play state, master deck,
// channel faders and the crossfader (StateMap) — the way SoundSwitch / Resolume / lighting apps read them.
// LISTEN-ONLY and polite: we first only LISTEN for the players' discovery packets (UDP 51337); only once a device has
// said hello do we say hello back, unicast to that device (never a broadcast), then read its StateMap and BeatInfo
// services. We only ever send: hello / goodbye, the service request, keep-alive references and subscriptions.
import crypto from 'node:crypto';
import type dgram from 'node:dgram';
import net from 'node:net';
import { GridTracker, type DeckState, type SourceSample } from '../../shared/musicClock.ts';
import { plainNetError, Rate, udpBind, type Adapter, type AdapterCtx, type AdapterStatus } from './net.ts';
import {
  ACTION_EXIT, ACTION_HOWDY, BEATINFO_START, DISCOVERY_PORT, buildDiscovery, buildReference, buildServiceAnnounce, buildServicesRequest,
  buildStateSubscribe, newToken, parseBeatInfo, parseDiscovery, parseStateValue, readFrames, readMainMessages, statePaths,
} from './stagelinqProto.ts';

export interface StagelinqConfig {
  discoveryPort?: number; bind?: string; maxDevices?: number;
  /** Tests: how TCP connections are made (default: a plain connect with a 4 s timeout). */
  dial?: (host: string, port: number) => Promise<net.Socket>;
}

interface Deck { n: number; title: string; artist: string; path?: string; playing: boolean; master: boolean; fader: number; bpm: number; grid: GridTracker; lastBeat: number; beatAt: number; startedAt: number }
interface Dev {
  ip: string; port: number; name: string; software: string;
  token: Buffer; seen: number;
  main: net.Socket | null; services: Map<string, number>;
  conns: net.Socket[];
  decks: Map<number, Deck>;
  xfade?: number;
  state: 'hello' | 'connecting' | 'connected' | 'failed';
  error?: string;
  refTimer: ReturnType<typeof setInterval> | null;
  lastData: number;
  connectedAt: number;
  retryAt: number;
  backoff: number;
  /** Connect-attempt generation: bumped by every new attempt and every failure / close, so a stale attempt that
   *  finishes late (its awaits resolve after a drop) throws away what it got and never touches the device. */
  gen: number;
}

const SOFTWARE = 'VTube Pro', VERSION = '1.0', SOURCE = 'vtubepro';
/** No StageLinQ message we read is anywhere near this: a peer that sends more is cut off (memory stays bounded). */
const MAX_BUF = 1 << 20;
/** How long the player gets to list both its StateMap and BeatInfo services. */
const SERVICES_MS = 5000;
const MIN_BACKOFF = 3000, MAX_BACKOFF = 30000, HEALTHY_MS = 60000;

export class StagelinqAdapter implements Adapter {
  readonly id = 'stagelinq' as const;
  private sock: dgram.Socket | null = null;
  private token = newToken(crypto.randomBytes);
  private devs = new Map<string, Dev>();
  private state: AdapterStatus['state'] = 'off';
  private says = '';
  private rate = new Rate();
  private timer: ReturnType<typeof setInterval> | null = null;
  private owner = '';
  constructor(private ctx: AdapterCtx, private cfg: StagelinqConfig = {}) {}

  private get port() { return this.cfg.discoveryPort ?? DISCOVERY_PORT; }

  async start() {
    this.state = 'starting';
    try { this.sock = await udpBind(this.port, this.cfg.bind ?? '0.0.0.0'); }
    catch (e) { this.state = 'error'; this.says = plainNetError(e, 'the StageLinQ port (another Engine DJ app on this PC?)', this.port); return; }
    this.sock.on('message', (m, r) => this.onDiscovery(m, r.address));
    this.state = 'listening';
    this.says = 'Listening for Denon / Engine DJ players.';
    this.timer = setInterval(() => this.housekeep(), 1000);
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const d of this.devs.values()) { this.hello(d, ACTION_EXIT); this.closeDev(d); }
    this.devs.clear();
    await new Promise((r) => setTimeout(r, 30));
    try { this.sock?.close(); } catch { /* closed */ }
    this.sock = null;
    this.ctx.drop('stagelinq');
    this.state = 'off';
  }

  private onDiscovery(m: Buffer, ip: string) {
    const d = parseDiscovery(m);
    if (!d || d.token.equals(this.token) || d.source === SOURCE) return;
    const key = `${ip}:${d.port}`;
    if (d.action === ACTION_EXIT) { const x = this.devs.get(key); if (x) { this.closeDev(x); this.devs.delete(key); } return; }
    if (d.action !== ACTION_HOWDY || !d.port) return;   // (other listeners — SoundSwitch, Resolume — announce port 0)
    let dev = this.devs.get(key);
    if (!dev) {
      if (this.devs.size >= (this.cfg.maxDevices ?? 4)) return;
      dev = { ip, port: d.port, name: d.source, software: d.software, token: d.token, seen: this.ctx.now(), main: null, services: new Map(), conns: [], decks: new Map(), state: 'hello', refTimer: null, lastData: 0, connectedAt: 0, retryAt: 0, backoff: MIN_BACKOFF, gen: 0 };
      this.devs.set(key, dev);
      this.hello(dev, ACTION_HOWDY);
      void this.connect(dev);
    }
    dev.seen = this.ctx.now();
  }

  /** Our hello / goodbye, UNICAST to one device that announced itself (never broadcast). */
  private hello(d: Dev, action: string) {
    try { this.sock?.send(buildDiscovery({ token: this.token, source: SOURCE, action, software: SOFTWARE, version: VERSION, port: 0 }), this.port, d.ip); } catch { /* down */ }
  }

  private async connect(d: Dev) {
    const g = ++d.gen;
    const live = () => this.alive(d) && d.gen === g;   // this attempt is still the current one
    d.state = 'connecting';
    try {
      const main = await this.dial(d.ip, d.port);
      if (!live()) { main.destroy(); return; }   // (cancelled while dialling: the device went away / failed / redialled)
      d.main = main;
      let buf = Buffer.alloc(0);
      let asked = false;
      const both = () => d.services.has('StateMap') && d.services.has('BeatInfo');
      const gotServices = new Promise<void>((resolve, reject) => {
        let done = false;
        // the service list: announcements may come before AND after references (id 1 repeats: it is not an end marker)
        const finish = () => { if (done) return; done = true; clearTimeout(t); main.off('data', onData); main.pause(); buf = Buffer.alloc(0); resolve(); };
        const fail = (e: Error) => { if (done) return; done = true; clearTimeout(t); main.off('data', onData); main.destroy(); reject(e); };
        // no full list in time: take what is there (a mixer has no BeatInfo: that is its whole list), nothing → fail
        const t = setTimeout(() => (d.services.has('StateMap') || d.services.has('BeatInfo') ? finish() : fail(new Error('the player didn’t offer its beat / deck services'))), SERVICES_MS);
        const onData = (chunk: Buffer) => {
          if (!live()) { fail(new Error('cancelled')); return; }
          buf = Buffer.concat([buf, chunk]);
          if (buf.length > MAX_BUF) { fail(new Error('the player sent too much')); return; }
          let msgs: ReturnType<typeof readMainMessages>;
          try { msgs = readMainMessages(buf); } catch (e) { fail(e as Error); return; }
          buf = buf.subarray(msgs[1]);
          for (const msg of msgs[0]) {
            if (msg.id === 2 && !asked) { asked = true; main.write(buildServicesRequest(this.token)); }
            else if (msg.id === 0) { if (d.services.size < 32) d.services.set(msg.service.slice(0, 64), msg.port); }
          }
          if (both()) finish();
        };
        main.on('data', onData);
        main.on('error', (e) => fail(e));
        main.on('close', () => fail(new Error('the player closed the connection')));
      });
      main.write(buildServicesRequest(this.token)); asked = true;
      await gotServices;
      if (!live()) { main.destroy(); return; }
      // after the handshake the main socket isn't read at all (paused): we only write keep-alive references to it
      d.refTimer = setInterval(() => { try { main.write(buildReference(this.token, d.token, 0n)); } catch { /* closing */ } }, 250);
      main.on('close', () => { if (d.gen === g && d.main === main) this.failDev(d, 'The player disconnected.'); });
      const sm = d.services.get('StateMap'), bi = d.services.get('BeatInfo');
      if (sm && !(await this.stateMap(d, sm, g))) return;
      if (bi && !(await this.beatInfo(d, bi, g))) return;
      if (!live()) return;
      d.state = 'connected'; d.connectedAt = this.ctx.now();   // (the backoff resets only after HEALTHY_MS of data: housekeep)
    } catch (e) {
      if (live()) this.failDev(d, plainNetError(e, `the player at ${d.ip}`));   // (a cancelled attempt fails silently)
    }
  }
  private dial(host: string, port: number) { return this.cfg.dial ? this.cfg.dial(host, port) : tcp(host, port); }
  /** Still the device we know (not timed out / stopped while a connect was pending). */
  private alive(d: Dev) { for (const x of this.devs.values()) if (x === d) return true; return false; }
  /** Every failure: close everything, try again after the backoff (3 s → 30 s; reset after a healthy session). */
  private failDev(d: Dev, why: string) {
    d.state = 'failed'; d.error = why;
    this.closeDev(d);   // (bumps the generation: an attempt still in flight is cancelled)
    d.retryAt = this.ctx.now() + d.backoff; d.backoff = Math.min(MAX_BACKOFF, d.backoff * 2);
  }

  /** false = this attempt was cancelled meanwhile (the socket is destroyed, nothing attached). */
  private async stateMap(d: Dev, port: number, g: number): Promise<boolean> {
    const s = await this.dial(d.ip, port);
    if (!this.alive(d) || d.gen !== g) { s.destroy(); return false; }
    d.conns.push(s);
    s.write(buildServiceAnnounce(this.token, 'StateMap', s.localPort ?? 0));
    for (const p of statePaths(4)) s.write(buildStateSubscribe(p, 0));
    let buf = Buffer.alloc(0);
    s.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      let fr: [Buffer[], number];
      try { if (buf.length > MAX_BUF) throw new Error('too much'); fr = readFrames(buf, 64 * 1024); } catch { s.destroy(); buf = Buffer.alloc(0); return; }
      buf = buf.subarray(fr[1]);
      for (const p of fr[0]) { const v = parseStateValue(p); if (v) this.onState(d, v.path, v.value); }
    });
    s.on('error', () => {});
    // the service sockets are read, so they see a drop (the paused main socket doesn't): a failure, retried after the backoff
    s.on('close', () => { if (d.gen === g && d.conns.includes(s)) this.failDev(d, 'The player disconnected.'); });
    return true;
  }
  private async beatInfo(d: Dev, port: number, g: number): Promise<boolean> {
    const s = await this.dial(d.ip, port);
    if (!this.alive(d) || d.gen !== g) { s.destroy(); return false; }
    d.conns.push(s);
    s.write(buildServiceAnnounce(this.token, 'BeatInfo', s.localPort ?? 0));
    s.write(BEATINFO_START);
    let buf = Buffer.alloc(0);
    s.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      let fr: [Buffer[], number];
      try { if (buf.length > MAX_BUF) throw new Error('too much'); fr = readFrames(buf, 64 * 1024); } catch { s.destroy(); buf = Buffer.alloc(0); return; }
      buf = buf.subarray(fr[1]);
      for (const p of fr[0]) { const b = parseBeatInfo(p); if (b) this.onBeats(d, b.decks); }
    });
    s.on('error', () => {});
    // the service sockets are read, so they see a drop (the paused main socket doesn't): a failure, retried after the backoff
    s.on('close', () => { if (d.gen === g && d.conns.includes(s)) this.failDev(d, 'The player disconnected.'); });
    return true;
  }

  private deck(d: Dev, n: number): Deck {
    let k = d.decks.get(n);
    if (!k) { k = { n, title: '', artist: '', playing: false, master: false, fader: 1, bpm: 0, grid: new GridTracker(3000), lastBeat: NaN, beatAt: -Infinity, startedAt: 0 }; d.decks.set(n, k); }
    return k;
  }
  private onState(d: Dev, path: string, v: number | boolean | string | null) {
    this.rate.hit();
    d.lastData = this.ctx.now();
    if (path === '/Mixer/CrossfaderPosition' && typeof v === 'number') { d.xfade = Math.max(-1, Math.min(1, v * 2 - 1)); return; }
    let m = /^\/Engine\/Deck(\d)\/(.+)$/.exec(path);
    if (m) {
      const k = this.deck(d, Number(m[1]));
      switch (m[2]) {
        case 'Track/SongName': k.title = typeof v === 'string' ? v : ''; break;
        case 'Track/ArtistName': k.artist = typeof v === 'string' ? v : ''; break;
        case 'Track/TrackNetworkPath': k.path = typeof v === 'string' && v ? v.slice(0, 600) : undefined; break;   // (the track library finds the track by it)
        case 'PlayState': case 'Play': if (typeof v === 'boolean') { if (v && !k.playing) k.startedAt = this.ctx.now(); k.playing = v; } break;
        case 'DeckIsMaster': if (typeof v === 'boolean') k.master = v; break;
        case 'CurrentBPM': if (typeof v === 'number' && v > 0) k.bpm = v; break;
      }
      return;
    }
    m = /^\/Mixer\/CH(\d)faderPosition$/.exec(path);
    if (m && typeof v === 'number') this.deck(d, Number(m[1])).fader = Math.max(0, Math.min(1, v));
  }
  private onBeats(d: Dev, decks: { beat: number; bpm: number }[]) {
    const now = this.ctx.now();
    this.rate.hit(); d.lastData = now;
    decks.forEach((b, i) => {
      if (!(b.bpm > 0) || !Number.isFinite(b.beat)) return;
      const k = this.deck(d, i + 1);
      if (Number.isFinite(k.lastBeat) && b.beat !== k.lastBeat) k.beatAt = now;
      k.lastBeat = b.beat; k.bpm = b.bpm;
      k.grid.observe(now, b.beat, b.bpm);
      // the deck's beat on the track's own grid (Engine's beatData): the track library follows it exactly
      if (k.path || k.title) this.ctx.position?.({ src: 'stagelinq', deck: k.n, at: now, beat: b.beat, playing: this.deckPlaying(k, now), exact: true, ident: { ...(k.path ? { path: k.path } : {}), ...(k.title ? { title: k.title } : {}), ...(k.artist ? { artist: k.artist } : {}) } });
    });
    this.emit(now);
  }

  private deckPlaying(k: Deck, now: number) { return k.playing || now - k.beatAt < 600; }
  private emit(now: number) {
    let best: { d: Dev; k: Deck } | null = null, score = -1;
    for (const d of this.devs.values()) for (const k of d.decks.values()) {
      if (!k.grid.ready) continue;
      const pl = this.deckPlaying(k, now);
      const s = (pl ? 4 : 0) + (k.master ? 2 : 0) + k.fader + (`${d.ip}:${k.n}` === this.owner ? 0.5 : 0);
      if (s > score) { score = s; best = { d, k }; }
    }
    if (!best) return;
    const { d, k } = best;
    this.owner = `${d.ip}:${k.n}`;
    const g = k.grid;
    const all = [...this.devs.values()].flatMap((x) => [...x.decks.values()]);
    const decks: DeckState[] = all.sort((a, b) => a.n - b.n).slice(0, 6).map((x) => ({
      n: x.n, playing: this.deckPlaying(x, now), onAir: this.deckPlaying(x, now) && x.fader > 0.05, master: x.master, fader: +x.fader.toFixed(3),
      ...(x.bpm ? { bpm: +x.bpm.toFixed(2) } : {}), ...(x.title ? { title: x.title } : {}), ...(x.artist ? { artist: x.artist } : {}),
    }));
    const s: SourceSample = {
      src: 'stagelinq', key: 'stagelinq', name: `${d.name || 'Engine DJ player'} · deck ${k.n}`,
      at: g.at, bpm: g.bpm, beat: g.beat, bar: ((Math.floor(g.beat) % 4) + 4) % 4, playing: this.deckPlaying(k, now), q: 1,
      decks, onAir: k.n,
      ...(k.title || k.artist ? { track: { deck: k.n, ...(k.title ? { title: k.title } : {}), ...(k.artist ? { artist: k.artist } : {}) } } : {}),
      ...(d.xfade !== undefined ? { xfade: d.xfade } : {}),
    };
    this.ctx.sample(s);
  }

  private closeDev(d: Dev) {
    d.gen++;
    if (d.refTimer) clearInterval(d.refTimer);
    d.refTimer = null;
    for (const c of d.conns) try { c.destroy(); } catch { /* gone */ }
    d.conns = [];
    try { d.main?.destroy(); } catch { /* gone */ }
    d.main = null;
  }
  private housekeep() {
    const now = this.ctx.now();
    for (const [key, d] of this.devs) {
      if (now - d.seen > 8000) { this.closeDev(d); this.devs.delete(key); continue; }
      this.hello(d, ACTION_HOWDY);   // (unicast keep-alive hello, once a second, only to devices that are there)
      // a silent session (seen on some firmware): no data for 15 s since connecting / since the last data → a failure
      // (retried after the backoff). A StateMap-only device (a mixer: no BeatInfo) is complete as long as data flows.
      if (d.state === 'connected' && now - Math.max(d.lastData, d.connectedAt) > 15000) this.failDev(d, 'The player stopped sending.');
      // healthy for a while (data flowing for HEALTHY_MS): the next failure starts from the short backoff again
      else if (d.state === 'connected' && now - d.connectedAt > HEALTHY_MS && now - d.lastData < 5000) d.backoff = MIN_BACKOFF;
      if (d.state === 'failed' && now >= d.retryAt) { d.services.clear(); d.lastData = 0; d.state = 'connecting'; void this.connect(d); }
    }
    if (this.devs.size) this.emit(now);
  }

  status(): AdapterStatus {
    const devs = [...this.devs.values()];
    const found = devs.map((d) => `${d.name || 'Engine DJ device'} (${d.software || 'StageLinQ'})`);
    let says = this.says;
    if (this.state === 'listening' || this.state === 'connected') {
      const ok = devs.filter((d) => d.state === 'connected');
      this.state = ok.length ? 'connected' : 'listening';
      const bad = devs.find((d) => d.state === 'failed');
      says = ok.length ? `Reading ${ok.length} Engine DJ device${ok.length > 1 ? 's' : ''}.` : bad ? bad.error ?? 'Couldn’t read the player.' : devs.length ? 'Found a player — connecting…' : 'Listening for Denon / Engine DJ players (nothing found yet).';
    }
    return { id: 'stagelinq', label: 'Denon / Engine DJ (StageLinQ)', state: this.state, says, found, rate: this.rate.get() };
  }
}

function tcp(host: string, port: number): Promise<net.Socket> {
  return new Promise((res, rej) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); rej(Object.assign(new Error('no answer'), { code: 'ETIMEDOUT' })); }, 4000);
    s.once('connect', () => { clearTimeout(t); s.setNoDelay(true); res(s); });
    s.once('error', (e) => { clearTimeout(t); rej(e); });
  });
}
