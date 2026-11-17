// Pro DJ Link adapter: Pioneer / AlphaTheta CDJ-XDJ players + DJM mixers (and rekordbox in EXPORT mode) on the DJ's
// network. Two modes:
//  - LISTEN (default, sends nothing): keep-alives (who is there), beat packets (tempo, beat, bar), the mixer's
//    channels-on-air, CDJ-3000 position. Tempo + phase + bar + which deck is live — enough for a locked show.
//  - TRACK INFO (opt-in "Get track names and drop countdown"): we also say hello as a virtual player (#7+, never a real
//    player number, unicast keep-alives only to the devices we heard, never "first on the network"), so the players send
//    us their status (track id, master, on-air, beat number) and we read the title / artist and rekordbox's PHRASE
//    analysis from the player's database server — so the show can count down to the drop.
// Never sent, by construction: beat, status, sync, master hand-off, fader start, on-air or load packets (prolinkPackets.ts
// can't even build them). rekordbox PERFORMANCE mode does not speak Pro DJ Link at all: those DJs use Ableton Link.
import type dgram from 'node:dgram';
import { GridTracker, sectionOf, type DeckState, type PhraseInfo, type PhraseKind, type SourceSample } from '../../shared/musicClock.ts';
import { DbClient, type TrackMeta } from './prolinkDb.ts';
import { anlzFromTags } from './library/anlz.ts';
import type { TrackIdent } from '../../shared/trackFollow.ts';
import { ifaceFor, plainNetError, Rate, udpBind, type Adapter, type AdapterCtx, type AdapterStatus } from './net.ts';
import {
  MIXER_ID, PORT_ANNOUNCE, PORT_BEAT, PORT_STATUS, PT, VIRTUAL_ID, buildKeepAlive, packetType, parseAbsPos, parseBeat, parseCdjStatus,
  parseKeepAlive, parseMixerStatus, parseOnAir, parsePssi, type CdjStatus, type KeepAlive, type Pssi,
} from './prolinkPackets.ts';

export interface ProlinkConfig {
  /** Opt-in: announce a virtual player to get status, track names and phrases. */
  trackInfo: boolean;
  /** Tests / special setups: other ports or one card (default 50000-50002 on every card). */
  ports?: { announce: number; beat: number; status: number };
  bind?: string;
  /** dbserver lookup port (tests). */
  dbPort?: number;
}

interface Player {
  device: number; name: string; ip: string;
  grid: GridTracker;
  lastInt: number;
  lastBeatAt: number;
  bib: number;
  bpm: number;
  startedAt: number;
  status: CdjStatus | null;
  statusAt: number;
  deltas: number[];
  trackKey: string;
  meta: TrackMeta | null;
  pssi: Pssi | null;
  abs: { playheadMs: number; lenSec: number; at: number } | null;
}

const KEEPALIVE_MS = 1500;
/** Track-info mode listens this long before its first hello (so it never takes a number someone already has). */
const LISTEN_MS = 2000;

export class ProlinkAdapter implements Adapter {
  readonly id = 'prolink' as const;
  private socks: dgram.Socket[] = [];
  private devices = new Map<string, KeepAlive & { seen: number }>();
  private players = new Map<number, Player>();
  private onAir: boolean[] | null = null;
  private onAirAt = 0;
  private owner = 0;
  private state: AdapterStatus['state'] = 'off';
  private says = '';
  private rate = new Rate();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Our virtual player number (track-info mode): 0 until we have listened for LISTEN_MS. */
  private ourId = 0;
  private startedAt = 0;
  private fullLogAt = -Infinity;
  private fetching = new Set<string>();
  private metaCache = new Map<string, { meta: TrackMeta | null; pssi: Pssi | null }>();
  private announceSock: dgram.Socket | null = null;
  private triedAt = new Map<string, number>();
  constructor(private ctx: AdapterCtx, private cfg: ProlinkConfig) {}

  async start() {
    this.state = 'starting';
    const P = this.cfg.ports ?? { announce: PORT_ANNOUNCE, beat: PORT_BEAT, status: PORT_STATUS };
    const bind = this.cfg.bind ?? '0.0.0.0';
    try {
      const a = await udpBind(P.announce, bind);
      a.on('message', (m, r) => this.onAnnounce(m, r.address));
      this.announceSock = a;
      const b = await udpBind(P.beat, bind);
      b.on('message', (m) => this.onBeatPort(m));
      this.socks.push(a, b);
      if (this.cfg.trackInfo) {
        const s = await udpBind(P.status, bind);
        s.on('message', (m) => this.onStatus(m));
        this.socks.push(s);
      }
    } catch (e) {
      await this.stop();
      this.state = 'error';
      this.says = plainNetError(e, 'the Pro DJ Link ports (rekordbox in export mode on this PC?)', P.announce);
      return;
    }
    this.state = 'listening';
    this.says = 'Listening for CDJ / XDJ players on your network.';
    this.startedAt = this.ctx.now(); this.ourId = 0;
    this.timer = setInterval(() => this.housekeep(), 250);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const s of this.socks) try { s.close(); } catch { /* closed */ }
    this.socks = []; this.announceSock = null;
    this.players.clear(); this.devices.clear();
    this.ctx.drop('prolink');
    this.state = 'off';
  }

  // ---------------------------------------------------------------- packets
  private onAnnounce(m: Buffer, from: string) {
    const k = parseKeepAlive(m);
    if (!k) return;
    // the address inside must be the sender's own (a keep-alive naming another machine is ignored: nobody steers our queries)
    if (k.ip && k.ip !== '0.0.0.0' && k.ip !== from) return;
    const ip = from;
    if (this.ourId && k.device === this.ourId && this.isOurs(ip)) return;            // our own hello
    this.devices.set(`${ip}#${k.device}`, { ...k, ip, seen: this.ctx.now() });
    // someone else uses our virtual number: take the next free one (15 → 7)
    if (this.cfg.trackInfo && this.ourId && k.device === this.ourId) this.ourId = this.freeVirtualId(k.device);
    const p = this.players.get(k.device);
    if (p) { p.name = k.name; p.ip = ip; }
  }
  /** Numbers heard in the last 10 s. */
  private usedIds(): Set<number> { const now = this.ctx.now(); return new Set([...this.devices.values()].filter((d) => now - d.seen < 10000).map((d) => d.device)); }
  /** Our virtual player number: the highest free one in 7…15 (0 = none free: we stay silent). */
  private freeVirtualId(avoid = 0): number {
    const used = this.usedIds();
    for (let n = 15; n >= VIRTUAL_ID; n--) if (!used.has(n) && n !== avoid) return n;
    return 0;
  }
  /** A hello from this PC with our number = our own (loopback tests: the bound address). */
  private isOurs(ip: string) { if (this.cfg.bind && this.cfg.bind !== '0.0.0.0') return ip === this.cfg.bind; const f = ifaceFor(ip); return !!f && f.address === ip; }

  private player(device: number, name: string): Player {
    let p = this.players.get(device);
    if (!p) {
      const dev = [...this.devices.values()].find((d) => d.device === device);
      p = { device, name, ip: dev?.ip ?? '', grid: new GridTracker(4000), lastInt: 0, lastBeatAt: -Infinity, bib: 1, bpm: 0, startedAt: 0, status: null, statusAt: 0, deltas: [], trackKey: '', meta: null, pssi: null, abs: null };
      this.players.set(device, p);
    }
    return p;
  }

  private onBeatPort(m: Buffer) {
    const now = this.ctx.now();
    const t = packetType(m);
    if (t === PT.beat) {
      const b = parseBeat(m);
      if (!b || b.device < 1 || b.device > 6 || !(b.bpm > 0)) return;   // (the mixer's own beats follow the master; ignored)
      this.rate.hit();
      const p = this.player(b.device, b.name);
      const period = 60000 / b.bpm;
      const wasPlaying = now - p.lastBeatAt < period * 2 + 300;
      if (!wasPlaying) p.startedAt = now;
      let pos = p.grid.ready && wasPlaying ? Math.max(p.lastInt + 1, Math.round(p.grid.posAt(now))) : p.lastInt + 1;
      if (pos - p.lastInt > 8) pos = p.lastInt + 1;
      p.grid.observe(now, pos, b.bpm);
      p.lastInt = pos; p.lastBeatAt = now; p.bib = b.beatInBar; p.bpm = b.bpm;
      this.emit(now);
    } else if (t === PT.onAir) {
      const o = parseOnAir(m);
      if (o) { this.onAir = o.onAir; this.onAirAt = now; }
    } else if (t === PT.absPos) {
      const a = parseAbsPos(m);
      if (a && a.device >= 1 && a.device <= 6) {
        const p = this.player(a.device, `Player ${a.device}`); p.abs = { playheadMs: a.playheadMs, lenSec: a.lenSec, at: now };
        // the CDJ-3000 playhead (every 30 ms, also while paused / looping): the track library follows it exactly
        this.ctx.position?.({ src: 'prolink', deck: a.device, at: now, ms: a.playheadMs, rate: 1 + a.pitch / 100, playing: this.playing(p, now), exact: true, ident: this.ident(p, a.lenSec) });
      }
    }
  }

  private onStatus(m: Buffer) {
    const now = this.ctx.now();
    const s = parseCdjStatus(m);
    if (s && s.device >= 1 && s.device <= 6) {
      this.rate.hit();
      const p = this.player(s.device, s.name);
      p.status = s; p.statusAt = now;
      if (s.beat !== null && p.grid.ready) {
        p.deltas.push(s.beat - Math.floor(p.grid.posAt(now)));
        if (p.deltas.length > 7) p.deltas.shift();
      }
      const key = s.trackType === 1 && s.rekordboxId ? `${s.srcPlayer}:${s.slot}:${s.rekordboxId}` : '';
      if (key !== p.trackKey) { p.trackKey = key; p.meta = null; p.pssi = null; p.deltas = []; if (key) void this.fetchTrack(p, s); }
      // (a status can arrive before the holding player's hello, or a query can fail: ask again, at most every 5 s)
      else if (key && !p.meta && !this.fetching.has(key) && !this.metaCache.has(key) && now - (this.triedAt.get(key) ?? 0) > 5000) void this.fetchTrack(p, s);
      return;
    }
    void parseMixerStatus(m);   // (mixer master / BPM: not needed — beats come from the players)
  }

  /** Track names + phrases from the player that holds the media (cached per track). */
  private async fetchTrack(p: Player, s: CdjStatus) {
    const key = p.trackKey;
    const cached = this.metaCache.get(key);
    if (cached) { p.meta = cached.meta; p.pssi = cached.pssi; return; }
    if (this.fetching.has(key)) return;
    this.triedAt.set(key, this.ctx.now()); if (this.triedAt.size > 200) this.triedAt.delete(this.triedAt.keys().next().value!);
    const src = [...this.devices.values()].find((d) => d.device === s.srcPlayer);
    if (!src) return;
    // the number we speak as inside queries: one in 1…6 (players ignore others) that NO device on the network uses —
    // never a real player's identity. All six taken → no query.
    const used = this.usedIds();
    let as = 0;
    for (let n = 6; n >= 1; n--) if (!used.has(n)) { as = n; break; }
    if (!as) { const now = this.ctx.now(); if (now - this.fullLogAt > 60000) { this.fullLogAt = now; this.ctx.log('[music] Pro DJ Link: players 1-6 are all on the network: no free number to ask for track info'); } return; }
    this.fetching.add(key);
    const db = new DbClient(src.ip, as, this.cfg.dbPort);
    let meta: TrackMeta | null = null, pssi: Pssi | null = null;
    try {
      await db.open();
      meta = await db.metadata(s.slot, s.rekordboxId).catch(() => null);
      const raw = await db.pssi(s.slot, s.trackType, s.rekordboxId).catch(() => null);
      pssi = raw ? parsePssi(raw) : null;
      // the track library: the player's grid (+ the phrases, + the 3-band waveform) make a pre-built show possible even
      // for a track that was never imported on this PC
      if (this.ctx.cdjTrack && meta?.title) {
        const grid = await db.anlzTag(s.slot, s.trackType, s.rekordboxId, 'PQTZ', 'DAT').catch(() => null);
        const wave = await db.anlzTag(s.slot, s.trackType, s.rekordboxId, 'PWV6', '2EX').catch(() => null);
        const parsed = anlzFromTags([grid, raw, wave].filter((b): b is Buffer => !!b));
        if (parsed?.beats?.length) try { this.ctx.cdjTrack(meta, [parsed]); } catch { /* never break the adapter */ }
      }
    } catch (e) {
      this.ctx.log(`[music] Pro DJ Link: no track info from player ${s.srcPlayer} (${(e as Error).message})`);
    } finally { db.close(); this.fetching.delete(key); }
    if (meta) this.metaCache.set(key, { meta, pssi });   // (a failed query is asked again later, at most every 5 s)
    if (this.metaCache.size > 200) this.metaCache.delete(this.metaCache.keys().next().value!);
    for (const q of this.players.values()) if (q.trackKey === key) { q.meta = meta; q.pssi = pssi; }
  }

  // ---------------------------------------------------------------- the live deck + its sample
  private playing(p: Player, now: number) {
    if (p.status && now - p.statusAt < 1200) return p.status.playing;
    return p.bpm > 0 && now - p.lastBeatAt < (60000 / p.bpm) * 2 + 300;
  }
  private isOnAir(p: Player, now: number) {
    if (p.status && now - p.statusAt < 1200) return p.status.onAir;
    return !!(this.onAir && now - this.onAirAt < 3000 && this.onAir[p.device - 1]);
  }
  private chooseOwner(now: number): Player | null {
    const all = [...this.players.values()];
    const playing = all.filter((p) => this.playing(p, now));
    const master = playing.find((p) => p.status?.master && now - p.statusAt < 1200);
    if (master) return master;
    const air = this.onAir && now - this.onAirAt < 3000 ? playing.filter((p) => this.isOnAir(p, now)) : playing;
    const pool = air.length ? air : playing;
    const cur = pool.find((p) => p.device === this.owner);
    if (cur) return cur;
    if (pool.length) return pool.sort((a, b) => a.startedAt - b.startedAt)[0];
    return this.players.get(this.owner) ?? null;
  }

  /** What the track library needs to find a deck's track (title / artist / length; track-info mode). */
  private ident(p: Player, lenSec?: number): TrackIdent {
    const d = p.meta?.durationSec ?? lenSec;
    return { ...(p.meta?.title ? { title: p.meta.title } : {}), ...(p.meta?.artist ? { artist: p.meta.artist } : {}), ...(d ? { durMs: d * 1000 } : {}) };
  }
  /** Track beat (1-based) at the grid's anchor, from the status packets' beat numbers. */
  private trackBeat(p: Player): number | null {
    if (p.deltas.length < 2) return null;
    const counts = new Map<number, number>();
    for (const d of p.deltas) counts.set(d, (counts.get(d) ?? 0) + 1);
    const delta = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return p.grid.beat + delta;
  }

  private phrase(p: Player): PhraseInfo | undefined {
    if (!p.pssi || !p.pssi.phrases.length) return undefined;
    const tb = this.trackBeat(p);
    if (tb === null) return undefined;
    const ph = p.pssi.phrases;
    let i = -1;
    for (let k = 0; k < ph.length; k++) if (ph[k].beat <= tb) i = k;
    if (i < 0) return undefined;
    const cur = ph[i], next = ph[i + 1];
    const end = next ? next.beat : p.pssi.endBeat;
    const kind = cur.label as PhraseKind, nk = next?.label as PhraseKind | undefined;
    const info: PhraseInfo = { kind, sec: sectionOf(kind), mood: p.pssi.mood, pos: Math.max(0, tb - cur.beat), len: Math.max(0, end - cur.beat), known: true };
    if (nk) { info.next = nk; info.nextSec = sectionOf(nk); }
    for (let k = i + 1; k < ph.length; k++) if (sectionOf(ph[k].label as PhraseKind) === 'drop') { info.dropIn = Math.max(0, ph[k].beat - tb); break; }
    return info;
  }

  private emit(now: number) {
    const o = this.chooseOwner(now);
    if (!o || !o.grid.ready) return;
    this.owner = o.device;
    const g = o.grid;
    const barAtFloor = (((o.bib - 1) + (Math.floor(g.beat) - o.lastInt)) % 4 + 4) % 4;
    const decks: DeckState[] = [...this.players.values()].sort((a, b) => a.device - b.device).map((p) => ({
      n: p.device, playing: this.playing(p, now), onAir: this.isOnAir(p, now), master: !!p.status?.master,
      ...(p.bpm ? { bpm: +p.bpm.toFixed(2) } : {}), ...(p.meta?.title ? { title: p.meta.title } : {}), ...(p.meta?.artist ? { artist: p.meta.artist } : {}),
    }));
    const dev = [...this.devices.values()].find((d) => d.device === o.device);
    const s: SourceSample = {
      src: 'prolink', key: 'prolink', name: `${dev?.name || o.name || 'CDJ'} #${o.device}`,
      at: g.at, bpm: g.bpm, beat: g.beat, bar: barAtFloor, playing: this.playing(o, now), q: 1,
      decks, onAir: o.device,
    };
    const ph = this.phrase(o);
    if (ph) s.phrase = ph;
    if (o.meta || o.abs) s.track = { deck: o.device, ...(o.meta?.title ? { title: o.meta.title } : {}), ...(o.meta?.artist ? { artist: o.meta.artist } : {}), ...(o.meta?.key ? { key: o.meta.key } : {}),
      ...(o.abs ? { posMs: o.abs.playheadMs, lenMs: o.abs.lenSec * 1000 } : o.meta?.durationSec ? { lenMs: o.meta.durationSec * 1000 } : {}) };
    this.ctx.sample(s);
    // players without the CDJ-3000 playhead: the status packets' beat number on the beat packets' phase (exact too)
    if (this.ctx.position) for (const p of this.players.values()) {
      if (p.abs && now - p.abs.at < 1000) continue;
      const tb = this.trackBeat(p);
      if (tb === null || !p.grid.ready) continue;
      this.ctx.position({ src: 'prolink', deck: p.device, at: p.grid.at, beat: tb - 1, rate: p.status?.pitch !== undefined ? 1 + p.status.pitch / 100 : undefined, playing: this.playing(p, now), exact: true, ident: this.ident(p) });
    }
  }

  private lastKeepAlive = 0;
  private housekeep() {
    const now = this.ctx.now();
    for (const [k, d] of this.devices) if (now - d.seen > 10000) this.devices.delete(k);
    for (const [k, p] of this.players) if (now - Math.max(p.lastBeatAt, p.statusAt, p.abs?.at ?? 0) > 60000) this.players.delete(k);
    // a stopped deck: still tell the arbiter (it stops counting on "stopped")
    if (this.players.size) this.emit(now);
    if (this.cfg.trackInfo) {
      // listen first (who is on the network?), then say hello with the highest free number
      if (!this.ourId && now - this.startedAt >= LISTEN_MS) this.ourId = this.freeVirtualId();
      if (this.ourId && now - this.lastKeepAlive >= KEEPALIVE_MS) { this.lastKeepAlive = now; this.keepAlive(); }
    }
  }

  /** Opt-in only: our hello as a virtual player, unicast to each device we heard (never a broadcast). */
  private keepAlive() {
    const sock = this.announceSock;
    if (!sock) return;
    const targets = [...this.devices.values()].filter((d) => d.device !== this.ourId);
    if (!targets.length) return;
    const port = this.cfg.ports?.announce ?? PORT_ANNOUNCE;
    for (const d of targets) {
      const f = this.cfg.bind && this.cfg.bind !== '0.0.0.0' ? { address: this.cfg.bind, mac: '00:00:00:00:00:00' } : ifaceFor(d.ip);
      if (!f) continue;
      const pkt = buildKeepAlive({ name: 'VTube Pro', device: this.ourId, mac: f.mac.split(':').map((x) => parseInt(x, 16) || 0), ip: f.address.split('.').map(Number), peers: this.devices.size + 1 });
      sock.send(pkt, port, d.ip);
    }
  }

  status(): AdapterStatus {
    const now = this.ctx.now();
    const found = [...this.devices.values()].sort((a, b) => a.device - b.device).map((d) => (d.kind === 'mixer' ? d.name || 'DJM mixer' : `${d.name || 'Player'} #${d.device}`));
    const playing = [...this.players.values()].filter((p) => this.playing(p, now));
    let says = this.says;
    if (this.state === 'listening' || this.state === 'connected') {
      this.state = found.length ? 'connected' : 'listening';
      says = !found.length ? 'Listening for CDJ / XDJ players on your network (nothing found yet).'
        : playing.length ? `Following player ${this.owner} (${playing.length} playing).` : 'Players found — waiting for a track to play.';
      if (this.cfg.trackInfo && found.length) {
        const own = this.players.get(this.owner);
        says += own?.pssi ? ' Drop countdown on.' : own?.status ? ' Reading track info…' : ' Asking the players for track info…';
      }
    }
    return { id: 'prolink', label: 'Pioneer CDJ / XDJ (Pro DJ Link)', state: this.state, says, found, rate: this.rate.get(), extra: { trackInfo: this.cfg.trackInfo, virtualId: this.cfg.trackInfo ? this.ourId || null : null, mixer: !!this.onAir || [...this.devices.values()].some((d) => d.device === MIXER_ID) } };
  }
}
