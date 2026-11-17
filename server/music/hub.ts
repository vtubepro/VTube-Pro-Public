// DJ sync hub (the helper side of the music clock): owns the adapters, the arbiter, the config, and publishes the clock.
//
//   adapters (link / prolink / stagelinq / os2l / osc / midi / artnet / traktor) ─► MusicArbiter ◄─ bus 'beat' (the
//   studio's audio analysis, tapped passively) ─► bus {type:'musicclock'} ~30 Hz + {type:'musicdmx'} on change
//
// Config: <data>/config/music.json. Off until the user presses "Turn on DJ sync" once (then every listen-only adapter
// starts and the best source wins by itself). Tests / private helpers: VTP_MUSIC_OVERRIDES='{"…"}' (not saved),
// VTP_MUSIC_BIND=127.0.0.1 (loopback only: nothing reaches the LAN), VTP_MUSIC_FILE=<path>.
import fs from 'node:fs';
import path from 'node:path';
import type { WebSocketServer, RawData } from 'ws';
import { CLOCK_SOURCES, MusicArbiter, TapTempo, type ClockSource, type ControllerEvent, type MusicClock, type SourceSample } from '../../shared/musicClock.ts';
import { dmxToB64 } from '../../shared/dmxIn.ts';
import { CONFIG_DIR } from '../paths.ts';
import { epochNow, localIPv4s, type Adapter, type AdapterCtx, type AdapterId, type AdapterStatus } from './net.ts';
import { LinkAdapter } from './link.ts';
import { ProlinkAdapter } from './prolink.ts';
import { StagelinqAdapter } from './stagelinq.ts';
import { Os2lAdapter } from './os2l.ts';
import { OscAdapter } from './oscIn.ts';
import { MidiAdapter, type MidiMsg } from './midi.ts';
import { ArtnetAdapter } from './artnet.ts';
import { TraktorAdapter } from './traktor.ts';
import { TrackSync } from './trackSync.ts';
import { DeckRigHub } from './deckRig.ts';
import { DATA_DIR } from '../paths.ts';

export interface MusicConfig {
  /** Master switch (off until the user turns DJ sync on once). */
  enabled: boolean;
  adapters: Record<AdapterId, boolean>;
  /** Opt-in: say hello on the Pro DJ Link network as a virtual player (track names + drop countdown). */
  prolinkTrackInfo: boolean;
  os2lPort: number;
  oscPort: number;
  /** VirtualDJ's OSC port (its `oscPort` setting; 0 = off): the track library subscribes to each deck's file + position. */
  vdjOscPort: number;
  traktorPort: number;
  /** Advertise the OS2L server over mDNS (VirtualDJ finds it by itself). */
  mdns: boolean;
  artnet: boolean;
  sacn: boolean;
  dmxUniverses: number[];
  /** Opt-in: answer Art-Net polls (strict Art-Net 4 desks only send to nodes that answer). */
  artnetPollReply: boolean;
  /** Measure the latency from the music input's kicks (default on) + a manual nudge (ms). */
  autoLatency: boolean;
  manualMs: number;
  /** Carabiner (Ableton Link bridge) program the user downloaded, for the "Start Carabiner" button. */
  carabinerPath: string;
  /** Where the OSC and OS2L listeners accept DJ apps: '' = this PC only (default), 'all' = every network card, or one
   *  card's IPv4 address (the DJ network). */
  appsListen: string;
  /** Phrase / drop countdown from the tempo owner only ('') or also from this one source (e.g. 'osc'). */
  phraseFrom: ClockSource | '';
  /** MIDI inputs the user picked (by name): the studio opens only these, only while DJ sync is on. */
  midiPorts: string[];
  /** Tests / special setups (not in the UI). */
  ports?: { carabiner?: number; prolinkBase?: number; stagelinq?: number; artnet?: number; sacn?: number; dbserver?: number; obc?: number };
}

export const MUSIC_DEFAULTS: MusicConfig = {
  enabled: false,
  adapters: { link: true, prolink: true, stagelinq: true, os2l: true, osc: true, midi: true, artnet: true, traktor: false },
  prolinkTrackInfo: false,
  os2lPort: 1503, oscPort: 4460, vdjOscPort: 0, traktorPort: 8080,
  mdns: true, artnet: true, sacn: true, dmxUniverses: [1, 2, 3, 4], artnetPollReply: false,
  autoLatency: true, manualMs: 0, carabinerPath: '', appsListen: '', phraseFrom: '', midiPorts: [],
};
const IDS: AdapterId[] = ['link', 'prolink', 'stagelinq', 'os2l', 'osc', 'midi', 'artnet', 'traktor'];

const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const port = (v: unknown, d: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 1024 && v <= 65535 && v !== 5190 && v !== 5191 ? v : d);
/** Merge a (partial, untrusted) patch into a config. */
export function sanitizeMusicConfig(p: unknown, base: MusicConfig = MUSIC_DEFAULTS): MusicConfig {
  const x = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const a = (x.adapters && typeof x.adapters === 'object' ? x.adapters : {}) as Record<string, unknown>;
  const out: MusicConfig = {
    enabled: bool(x.enabled, base.enabled),
    adapters: Object.fromEntries(IDS.map((k) => [k, bool(a[k], base.adapters[k])])) as Record<AdapterId, boolean>,
    prolinkTrackInfo: bool(x.prolinkTrackInfo, base.prolinkTrackInfo),
    os2lPort: port(x.os2lPort, base.os2lPort), oscPort: port(x.oscPort, base.oscPort), traktorPort: port(x.traktorPort, base.traktorPort),
    vdjOscPort: x.vdjOscPort === 0 ? 0 : port(x.vdjOscPort, base.vdjOscPort ?? 0),
    mdns: bool(x.mdns, base.mdns), artnet: bool(x.artnet, base.artnet), sacn: bool(x.sacn, base.sacn),
    dmxUniverses: Array.isArray(x.dmxUniverses) ? [...new Set(x.dmxUniverses.filter((u): u is number => typeof u === 'number' && Number.isInteger(u) && u >= 1 && u <= 63999))].slice(0, 16) : base.dmxUniverses,
    artnetPollReply: bool(x.artnetPollReply, base.artnetPollReply),
    autoLatency: bool(x.autoLatency, base.autoLatency),
    manualMs: typeof x.manualMs === 'number' && Number.isFinite(x.manualMs) ? Math.max(-500, Math.min(500, Math.round(x.manualMs))) : base.manualMs,
    carabinerPath: typeof x.carabinerPath === 'string' ? x.carabinerPath.slice(0, 500) : base.carabinerPath,
    appsListen: x.appsListen === '' || x.appsListen === 'all' || (typeof x.appsListen === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(x.appsListen) && x.appsListen !== '0.0.0.0') ? x.appsListen as string : base.appsListen,
    phraseFrom: x.phraseFrom === '' || (CLOCK_SOURCES as readonly unknown[]).includes(x.phraseFrom) ? x.phraseFrom as ClockSource | '' : base.phraseFrom,
    midiPorts: Array.isArray(x.midiPorts) ? [...new Set(x.midiPorts.filter((m): m is string => typeof m === 'string' && m.length > 0).map((m) => m.slice(0, 80)))].slice(0, 8) : base.midiPorts,
  };
  const ports = x.ports && typeof x.ports === 'object' ? x.ports as Record<string, unknown> : base.ports;
  if (ports) {
    const o: NonNullable<MusicConfig['ports']> = {};
    for (const k of ['carabiner', 'prolinkBase', 'stagelinq', 'artnet', 'sacn', 'dbserver', 'obc'] as const) { const v = (ports as Record<string, unknown>)[k]; if (typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 65536 && v !== 5190 && v !== 5191 && v !== 4455) o[k] = v; }
    out.ports = o;
  }
  return out;
}

export interface MusicView {
  config: MusicConfig;
  adapters: AdapterStatus[];
  sources: ReturnType<MusicArbiter['status']>;
  clock: MusicClock | null;
  /** The bus is getting the studio's audio analysis. */
  audio: boolean;
  tap: boolean;
  loopbackOnly: boolean;
  /** This PC's network cards, for "DJ apps on another computer" (name + IPv4). */
  ifaces: { name: string; address: string }[];
}

export interface MusicHubOptions { broadcast(msg: unknown): void; file?: string; log?(s: string): void; dataDir?: string }

export class MusicHub {
  config: MusicConfig;
  readonly arbiter: MusicArbiter;
  private adapters = new Map<AdapterId, Adapter>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private last: MusicClock | null = null;
  private lastAudioAt = 0;
  private tapper = new TapTempo();
  private tapAt = 0;
  private dmxQ = new Map<number, { d: Uint8Array; src: string }>();
  private dmxSent = new Map<number, number>();
  private file: string;
  private overrides: unknown = null;
  private bind: string | undefined;
  private busy = Promise.resolve();
  readonly ctx: AdapterCtx;
  /** Track library → pre-built light shows (Scene tab → DJ sync → Track library). */
  readonly tracks: TrackSync;
  /** DJ decks: the controller's physical controls → the virtual decks + the performer's hands (server/music/deckRig.ts). */
  readonly deck: DeckRigHub;

  constructor(private o: MusicHubOptions) {
    this.file = o.file ?? process.env.VTP_MUSIC_FILE ?? path.join(CONFIG_DIR, 'music.json');
    try { this.overrides = process.env.VTP_MUSIC_OVERRIDES ? JSON.parse(process.env.VTP_MUSIC_OVERRIDES) : null; } catch { this.overrides = null; }
    this.bind = process.env.VTP_MUSIC_BIND || undefined;
    this.config = this.load();
    this.arbiter = new MusicArbiter({ manualMs: this.config.manualMs, autoLatency: this.config.autoLatency, phraseFrom: this.config.phraseFrom });
    this.ctx = {
      now: epochNow,
      sample: (s: SourceSample) => this.arbiter.sample(s, epochNow()),
      drop: (k: string) => this.arbiter.drop(k),
      controller: (evs: ControllerEvent[], src?: ClockSource) => this.arbiter.controller(evs, src),
      dmx: (u: number, d: Uint8Array, src: string) => { this.dmxQ.set(u, { d, src }); },
      log: (s: string) => (this.o.log ?? console.log)(s),
      position: (r) => this.tracks.position(r),
      cdjTrack: (meta, tags) => this.tracks.cdjTrack(meta, tags),
      deckMidi: (port, msgs) => this.tracks.deckMidi(port, msgs),
    };
    this.deck = new DeckRigHub({ broadcast: (m) => this.o.broadcast(m), configFile: path.join(path.dirname(this.file), 'djdeck.json'), diagDir: path.join(o.dataDir ?? DATA_DIR, 'cache', 'diag'), now: epochNow, log: this.ctx.log });
    this.tracks = new TrackSync({ dataDir: o.dataDir ?? DATA_DIR, broadcast: (m) => this.o.broadcast(m), log: this.ctx.log, now: epochNow });
  }

  private load(): MusicConfig {
    let saved: unknown = null;
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    const c = sanitizeMusicConfig(saved);
    return this.overrides ? sanitizeMusicConfig(this.overrides, c) : c;
  }
  private save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const { ports: _p, ...rest } = this.config;
      fs.writeFileSync(this.file, JSON.stringify(rest, null, 2));
    } catch (e) { this.ctx.log(`[music] couldn’t save ${this.file}: ${(e as Error).message}`); }
  }

  async init() { this.tracks.start(this.arbiter); if (this.config.enabled) await this.apply(); this.startTicking(); }

  /** Change settings (from the panel) → restart what changed. */
  async update(patch: unknown) {
    const before = JSON.stringify(this.config);
    this.config = sanitizeMusicConfig(patch, this.config);
    this.arbiter.manualMs = this.config.manualMs;
    this.arbiter.autoLatency = this.config.autoLatency;
    this.arbiter.phraseFrom = this.config.phraseFrom;
    if (JSON.stringify(this.config) !== before) { this.save(); await this.apply(before); }
  }

  /** Start / stop / restart adapters to match the config (serialised). */
  private apply(before?: string): Promise<void> {
    const run = async () => {
      const prev = before ? JSON.parse(before) as MusicConfig : null;
      for (const id of IDS) {
        const want = this.config.enabled && this.config.adapters[id];
        const cur = this.adapters.get(id);
        const changed = !prev || this.adapterKey(id, prev) !== this.adapterKey(id, this.config);
        if (cur && (!want || changed)) { await cur.stop().catch(() => {}); this.adapters.delete(id); }
        if (want && !this.adapters.get(id)) {
          const a = this.make(id);
          this.adapters.set(id, a);
          await a.start().catch((e) => this.ctx.log(`[music] ${id} didn’t start: ${(e as Error).message}`));
        }
      }
    };
    this.busy = this.busy.then(run, run);
    return this.busy;
  }
  private adapterKey(id: AdapterId, c: MusicConfig) {
    switch (id) {
      case 'prolink': return `${c.prolinkTrackInfo}`;
      case 'os2l': return `${c.os2lPort}:${c.mdns}:${c.appsListen}`;
      case 'osc': return `${c.oscPort}:${c.appsListen}:${c.vdjOscPort}`;
      case 'traktor': return `${c.traktorPort}`;
      case 'artnet': return `${c.artnet}:${c.sacn}:${c.dmxUniverses.join(',')}:${c.artnetPollReply}`;
      default: return '';
    }
  }
  private make(id: AdapterId): Adapter {
    const c = this.config, P = c.ports ?? {}, bind = this.bind;
    // DJ apps (OSC / OS2L): this PC only unless the user picked a network (anyone on it could send a fake drop)
    const appsBind = bind ?? (c.appsListen === 'all' ? '0.0.0.0' : c.appsListen || '127.0.0.1');
    switch (id) {
      case 'link': return new LinkAdapter(this.ctx, { port: P.carabiner });
      case 'prolink': return new ProlinkAdapter(this.ctx, { trackInfo: c.prolinkTrackInfo, bind, dbPort: P.dbserver, ...(P.prolinkBase ? { ports: { announce: P.prolinkBase, beat: P.prolinkBase + 1, status: P.prolinkBase + 2 } } : {}) });
      case 'stagelinq': return new StagelinqAdapter(this.ctx, { discoveryPort: P.stagelinq, bind });
      case 'os2l': return new Os2lAdapter(this.ctx, { port: c.os2lPort, bind: appsBind, mdns: c.mdns && !bind });
      case 'osc': return new OscAdapter(this.ctx, { port: c.oscPort, bind: appsBind, obcPort: P.obc, vdjPort: c.vdjOscPort });
      case 'midi': return new MidiAdapter(this.ctx, { native: true, raw: (port, msgs) => this.deck.feed(port, msgs) });
      case 'artnet': return new ArtnetAdapter(this.ctx, { artnet: c.artnet, sacn: c.sacn, universes: c.dmxUniverses, pollReply: c.artnetPollReply && !bind, bind, artnetPort: P.artnet, sacnPort: P.sacn });
      case 'traktor': return new TraktorAdapter(this.ctx, { port: c.traktorPort });
    }
  }

  private startTicking() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 33);
    this.timer.unref?.();
  }
  /** One clock step: publish the clock (when a DJ source is live) and any changed DMX universes. */
  tick(now = epochNow()) {
    const midi = this.adapters.get('midi') as MidiAdapter | undefined;
    midi?.tick(now);
    this.deck.tick(now);
    const msg = this.arbiter.tick(now);
    this.last = msg?.c ?? null;
    if (msg) this.o.broadcast(msg);
    for (const [u, q] of this.dmxQ) {
      if (now - (this.dmxSent.get(u) ?? 0) < 33) continue;
      this.dmxQ.delete(u); this.dmxSent.set(u, now);
      this.o.broadcast({ type: 'musicdmx', u, d: dmxToB64(q.d), src: q.src.slice(0, 80) });
    }
  }

  /** Passive bus tap: the studio's beat packets (its audio analysis) feed the arbiter. Never sends on the bus. */
  attachBus(wss: WebSocketServer) {
    wss.on('connection', (ws) => ws.on('message', (data: RawData, isBinary: boolean) => { if (!isBinary) try { this.busTap(data); } catch { /* never break the bus */ } }));
  }
  private static PREFIX = Buffer.from('{"type":"beat"');
  /** One bus message (only the studio's beat packets are looked at; everything else is skipped by its first bytes). */
  busTap(data: RawData | string) {
    const buf = typeof data === 'string' ? Buffer.from(data) : Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    if (buf.length > 4096 || buf.length < MusicHub.PREFIX.length || !buf.subarray(0, MusicHub.PREFIX.length).equals(MusicHub.PREFIX)) return;
    const m = JSON.parse(buf.toString('utf8')) as { b?: unknown };
    this.lastAudioAt = epochNow();
    this.arbiter.audio(m.b, this.lastAudioAt);
  }

  /** Web MIDI forwarded by the studio page. */
  midi(port: string, msgs: MidiMsg[], busy?: string[]) {
    const m = this.adapters.get('midi') as MidiAdapter | undefined;
    m?.fromStudio(port, msgs, busy);
  }

  // ---------------------------------------------------------------- manual fallbacks
  /** Tap tempo (epoch ms of the tap, from the studio page on this PC). */
  tapTempo(t: number): { bpm: number | null; taps: number } {
    const r = this.tapper.tap(t);
    this.tapAt = t;
    if (r) this.arbiter.sample({ src: 'tap', key: 'tap', name: 'Tap tempo', at: r.at, bpm: r.bpm, beat: r.beat, bar: r.bar, playing: true, playKnown: false, q: 1 }, epochNow());
    return { bpm: r?.bpm ?? null, taps: this.tapper.beatsInRun };
  }
  clearTap() { this.arbiter.drop('tap'); this.tapAt = 0; }
  /** "This is beat 1": the user presses on a downbeat. */
  downbeat(t: number) { this.arbiter.downbeat(t); }

  view(): MusicView {
    const now = epochNow();
    const adapters = IDS.map((id) => this.adapters.get(id)?.status() ?? { id, label: LABELS[id], state: 'off' as const, says: this.config.enabled ? (this.config.adapters[id] ? 'Starting…' : 'Turned off.') : 'DJ sync is off.', found: [] });
    return { config: this.config, adapters, sources: this.arbiter.status(now), clock: this.last, audio: now - this.lastAudioAt < 3000, tap: now - this.tapAt < 600000 && this.tapAt > 0, loopbackOnly: !!this.bind, ifaces: localIPv4s().map((f) => ({ name: f.name, address: f.address })) };
  }

  async stop() {
    this.tracks.stop(this.arbiter);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const a of this.adapters.values()) await a.stop().catch(() => {});
    this.adapters.clear();
  }
}

const LABELS: Record<AdapterId, string> = {
  link: 'Ableton Link (via Carabiner)', prolink: 'Pioneer CDJ / XDJ (Pro DJ Link)', stagelinq: 'Denon / Engine DJ (StageLinQ)', os2l: 'VirtualDJ (OS2L)',
  osc: 'OSC', midi: 'DJ controller / MIDI', artnet: 'DMX light show in (Art-Net / sACN)', traktor: 'Traktor deck data (community mod)',
};
