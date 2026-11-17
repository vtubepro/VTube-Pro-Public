// TV performers over the party: WebRTC video between the studios (star topology, like everything in the party).
//
//   guest (TV) ──'up' PeerConnection (its own feed + 'lvl' voice level)──► host
//   host ──'down' PeerConnection (every OTHER TV feed, forwarded + everyone's levels)──► each guest
//
// Separate media PeerConnections, NOT tracks on the party link: the party link is never renegotiated (it may even be an
// invite-code link with no signalling path after the codes). Their SDP / ICE travel over the party's reliable 'ctl'
// channel as {t:'tvsig'} messages (shared/tv.ts), only between peers that both announced the 'tv1' capability. The
// 'up' link is always offered by the guest, the 'down' link always by the host (one offerer per link: no glare), and
// the host renegotiates 'down' when TVs come or go (transceiver mid → owner map in each offer).
//
// Bandwidth: the guest sends at its preset (shared/tv.ts TV_PRESETS: 350 / 700 / 1500 kbit/s); the host forwards each
// feed at ≤ 450 kbit/s and ≤ 360 px high (the browser encoder downscales: scaleResolutionDownBy), so a host with 7 TV
// guests uploads ≤ 7 × 6 × 0.45 ≈ 19 Mbit/s worst case (typically 1–3 TVs: ≤ 3 Mbit/s). WebRTC's congestion control
// lowers bitrate / resolution further on bad links. Consent: a TV feed goes only where the owner's avatar rule would let
// their avatar go (mayForward = the party's mayRelay); "host only" never leaves the host.
//
// Custody: video frames live in these connections and <video> elements only — never recorded, never written to disk.
import { TV_FORWARD_TIERS, forwardTier, decodeLevels, encodeLevels, sanitizeTvSig, tvPreset, type TvSig } from '../../../shared/tv.ts';

/** What the party gives the TV link (src/party.ts implements it). */
export interface TvPort {
  readonly role: 'none' | 'host' | 'guest';
  readonly myId: string;
  /** ctl message to a guest (host: member id) or to the host (guest: any id). false = no open link / peer lacks 'tv1'. */
  sendTv(to: string, m: TvSig): boolean;
  rtcConfig(): RTCConfiguration;
  /** Host: may `owner`'s feed (owner = a guest id or my id) be shown to member `to`? (the avatar consent rule) */
  mayForward(owner: string, to: string): boolean;
  /** Host: ids of guests whose party link is open and speak 'tv1'. Guest: [host id] when the host speaks 'tv1'. */
  tvPeers(): string[];
}

export interface TvFeed {
  owner: string;
  stream: MediaStream;
  track: MediaStreamTrack;
  /** Voice level 0..1 and when it last arrived. */
  level: number; levelAt: number;
  /** 'up' = received from that guest directly (host), 'down' = forwarded by the host (guest), 'own' = mine. */
  via: 'up' | 'down' | 'own';
}

export interface TvLinkStats {
  /** Outgoing: my feed to the host (guest) / sum of forwards (host). */
  up: { kbps: number; fps: number; width: number; height: number; limited: string; rtt: number } | null;
  forwards: { to: string; owner: string; kbps: number; height: number; fps: number }[];
  /** Incoming per feed owner. */
  feeds: Record<string, { kbps: number; fps: number; width: number; height: number; lost: number; jitterMs: number; dropped: number }>;
}

interface Pc {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  iceQ: RTCIceCandidateInit[];
  remote: boolean;
  /** down (host side): transceiver per forwarded owner. */
  trs: Map<string, RTCRtpTransceiver>;
  /** down (guest side): mid → owner of the last offer. */
  map: Record<string, string>;
  busy: boolean; dirty: boolean;
  tries: number; retryT: number;
  born: number;
  /** Called when the link is given up (failed / stuck disconnected). */
  onFail?: () => void;
  /** Host down links: forward tuning applied per owner (tier height : source height). */
  tuned?: Map<string, string>;
}

const LEVEL_MS = 66;
/** Retry delays: 1, 2, 4, 8, 16, 30 s. */
const backoff = (n: number) => Math.min(30_000, 1000 * 2 ** Math.max(0, Math.min(5, n - 1)));
/** A media link 'disconnected' this long is treated as failed (ICE usually recovers within a few seconds). */
const DISCONNECT_MS = 5000;

export class TvLinks {
  /** Feeds by owner id: received ones (+ my own as 'own'). */
  readonly feeds = new Map<string, TvFeed>();
  /** My own feed + level getter (set by TvStudio when I appear as a TV). `audio` (guestlink): a browser guest's voice,
   *  sent to the host over the same link when they are not in Discord voice. */
  private own: { stream: MediaStream; kbps: number; fps: number; level: () => number; vts: boolean; audio: MediaStreamTrack | null; hear: boolean } | null = null;
  /** guestlink — host: voices of browser guests (not in Discord voice), by guest id; played on this PC's OBS pages. */
  readonly voices = new Map<string, { stream: MediaStream; track: MediaStreamTrack }>();
  /** guestlink — host: browser guests whose link can carry my voice to them (they talk over the link, or at least listen:
   *  a guest whose mic is denied / missing still hears me). TvStudio starts talk-back for these too. */
  readonly listeners = new Set<string>();
  /** guestlink — host: my voice back to those guests (null = none); guest: the host's voice I receive. */
  private returnAudio: MediaStreamTrack | null = null;
  /** greenroom — host: my backstage voice (null = the talk-back track) and, per guest, which of my voices they get:
   *  'main' (talk-back, on air), 'back' (backstage talk with me only), 'none' (waiting: they hear nothing of the show). */
  private backAudio: MediaStreamTrack | null = null;
  returnFor: ((g: string) => 'main' | 'back' | 'none') | null = null;
  hostAudio: MediaStream | null = null;
  /** Guest: 'up' (my feed → host) and 'down' (others → me). */
  private up: Pc | null = null;
  private down: Pc | null = null;
  /** Host: per guest id. */
  private ups = new Map<string, Pc>();
  private downs = new Map<string, Pc>();
  private timer = 0;
  private statsT = 0;
  private last = new Map<string, { bytes: number; t: number; frames: number }>();
  stats: TvLinkStats = { up: null, forwards: [], feeds: {} };
  onChange: () => void = () => {};
  log: (s: string) => void = () => {};
  /** moderation — host (shared/moderation.ts): a hidden guest's "Camera off" card replaces their picture in every forward
   *  to other guests (replaceTrack: instant, no renegotiation); a muted guest's voice level reads 0 everywhere. */
  mod: { cover(owner: string): { stream: MediaStream; track: MediaStreamTrack } | null; quiet(owner: string): boolean } | null = null;
  /** Audio mixer — host (src/audio/mixer/audioMixer.ts): a guest's level as the director should see it (0 while the host's
   *  noise gate for them is shut; never affected by "Mute for me"). */
  levelGate: ((owner: string, level: number) => number) | null = null;

  constructor(private port: TvPort) {
    this.timer = window.setInterval(() => this.tick(), LEVEL_MS);
  }

  // ---------------------------------------------------------------- my own feed
  /** Appear as a TV with this stream (null = stop). `kbps` / `fps`: the sender preset. */
  setOwn(o: { stream: MediaStream; preset: string; level: () => number; vts: boolean; audio?: MediaStreamTrack | null; hear?: boolean } | null) {
    const p = o ? tvPreset(o.preset) : null;
    const was = this.own?.stream.getVideoTracks()[0] ?? null;
    const wasAudio = this.own?.audio ?? null, wasHear = this.own?.hear ?? false;
    this.own = o && p ? { stream: o.stream, kbps: p.kbps, fps: p.fps, level: o.level, vts: o.vts, audio: o.audio ?? null, hear: !!o.hear || !!o.audio } : null;
    const tr = this.own?.stream.getVideoTracks()[0] ?? null;
    if (tr) this.feeds.set(this.port.myId, { owner: this.port.myId, stream: this.own!.stream, track: tr, level: 0, levelAt: 0, via: 'own' });
    else this.feeds.delete(this.port.myId);
    if (this.port.role === 'guest') {
      if (!tr) { this.closeUp(true); }
      else if (this.up && ((this.own!.audio ?? null) !== wasAudio || this.own!.hear !== wasHear)) { this.closeUp(false); this.ensureUp(); }   // voice on / off: re-offer
      else if (this.up && was && tr !== was) { void this.replaceUp(tr); }
      else this.ensureUp();
    }
    if (this.port.role === 'host') for (const g of this.port.tvPeers()) this.syncDown(g);
    this.onChange();
  }
  get sending(): boolean { return !!this.own; }
  /** Peers that speak 'tv1' (guest: [host] when the host can show TVs). */
  peers(): string[] { return this.port.tvPeers(); }

  // ---------------------------------------------------------------- party events (src/party.ts calls these)
  /** A party link is ready (host: a guest's hello was processed; guest: the host's welcome arrived). */
  peerUp(id: string) {
    if (this.port.role === 'host') this.syncDown(id);
    else if (this.port.role === 'guest') { this.ensureUp(); this.needDown(); }
  }
  /** A party link / member is gone (endLink / dropRemote / leave). */
  peerDown(id: string) {
    if (this.port.role === 'host' || this.port.role === 'none') {
      this.closeHost(id);
      if (this.feeds.get(id)?.via === 'up') { this.feeds.delete(id); for (const g of this.port.tvPeers()) if (g !== id) this.syncDown(g); }
    }
    if (this.port.role === 'guest' || this.port.role === 'none') { this.closeUp(false); this.closeDown(); for (const [k, f] of this.feeds) if (f.via === 'down') this.feeds.delete(k); }
    this.onChange();
  }
  /** Membership / consent changed (someone joined, left, switched their sharing rule): re-plan the forwards. */
  membersChanged() {
    if (this.port.role !== 'host') return;
    for (const g of this.port.tvPeers()) this.syncDown(g);
  }
  /** Leave the party: close everything (my own source keeps running — the setup preview uses it). */
  reset() {
    this.closeUp(false); this.closeDown();
    for (const id of [...this.ups.keys(), ...this.downs.keys()]) this.closeHost(id);
    for (const [k, f] of this.feeds) if (f.via !== 'own') this.feeds.delete(k);
    this.voices.clear(); this.listeners.clear(); this.hostAudio = null; this.mixes.clear();
    this.onChange();
  }

  /** A {t:'tvsig'} ctl message from `from` (host: a guest id; guest: the host). */
  onSig(from: string, raw: unknown) {
    const m = sanitizeTvSig(raw);
    if (!m) return;
    const host = this.port.role === 'host';
    if (host && m.pc === 'up') return void this.hostUpSig(from, m);
    if (host && m.pc === 'down') return void this.hostDownSig(from, m);
    if (!host && m.pc === 'up') return void this.guestUpSig(m);
    if (!host && m.pc === 'down') return void this.guestDownSig(m);
  }

  dispose() { clearInterval(this.timer); this.reset(); }

  // ---------------------------------------------------------------- common plumbing
  private newPc(role: string, send: (m: TvSig) => void, kind: 'up' | 'down'): Pc {
    const pc = new RTCPeerConnection(this.port.rtcConfig());
    const x: Pc = { pc, dc: null, iceQ: [], remote: false, trs: new Map(), map: {}, busy: false, dirty: false, tries: 0, retryT: 0, born: performance.now() };
    pc.onicecandidate = (e) => send({ t: 'tvsig', pc: kind, k: 'ice', cand: e.candidate ? e.candidate.toJSON() : null });
    let discT = 0;
    pc.addEventListener('connectionstatechange', () => {
      this.log(`${role} ${kind}: ${pc.connectionState}`);
      clearTimeout(discT);
      // 'disconnected' that doesn't recover quickly: fail it, so the owner of this link rebuilds it (reconnection)
      if (pc.connectionState === 'disconnected') discT = window.setTimeout(() => { if (pc.connectionState === 'disconnected') { this.log(`${role} ${kind}: still disconnected — restarting`); x.onFail?.(); } }, DISCONNECT_MS);
      this.onChange();
    });
    return x;
  }
  private async addIce(x: Pc, cand: unknown) {
    const c = (cand ?? undefined) as RTCIceCandidateInit | undefined;
    if (!x.remote) { if (c) x.iceQ.push(c); return; }
    await x.pc.addIceCandidate(c).catch(() => {});
  }
  private async flushIce(x: Pc) { x.remote = true; for (const c of x.iceQ.splice(0)) await x.pc.addIceCandidate(c).catch(() => {}); }
  private closePc(x: Pc | null | undefined) { if (!x) return; clearTimeout(x.retryT); try { x.pc.close(); } catch { /* */ } }
  private levelDc(x: Pc, dc: RTCDataChannel, from: string | null) {
    x.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (e) => {
      if (!(e.data instanceof ArrayBuffer) || e.data.byteLength > 400) return;
      const now = performance.now();
      for (const [id, lv] of decodeLevels(new Uint8Array(e.data))) {
        // from a guest's up link: only its own level counts (no spoofing others)
        if (from !== null && id !== from) continue;
        const f = this.feeds.get(id);
        if (f && f.via !== 'own') { f.level = this.mod?.quiet(id) ? 0 : this.levelGate ? this.levelGate(id, lv) : lv; f.levelAt = now; }
      }
    };
  }

  // ---------------------------------------------------------------- guest: my feed → host ('up', I offer)
  private ensureUp() {
    if (this.port.role !== 'guest' || !this.own || this.up) return;
    const host = this.port.tvPeers()[0];
    if (!host) return;                                  // host doesn't speak tv1 (panel says so)
    const own = this.own;
    const send = (m: TvSig) => this.port.sendTv(host, m);
    const x = this.newPc('guest', send, 'up');
    this.up = x;
    const tr = x.pc.addTransceiver(own.stream.getVideoTracks()[0], { direction: 'sendonly', streams: [own.stream] });
    // guestlink: my voice to the host + theirs back; no mic (denied / none) but listening: a receive-only voice line
    if (own.audio) x.pc.addTransceiver(own.audio, { direction: 'sendrecv', streams: [new MediaStream([own.audio])] });
    else if (own.hear) x.pc.addTransceiver('audio', { direction: 'recvonly' });
    if (own.audio || own.hear) x.pc.ontrack = (e) => { if (e.track.kind === 'audio' && x === this.up) { this.hostAudio = new MediaStream([e.track]); this.onChange(); } };
    this.levelDc(x, x.pc.createDataChannel('lvl', { ordered: false, maxRetransmits: 0 }), null);
    x.onFail = () => this.retryUp(x);
    x.pc.addEventListener('connectionstatechange', () => {
      const s = x.pc.connectionState;
      if (x !== this.up) return;
      if (s === 'failed' || s === 'closed') this.retryUp(x);
      if (s === 'connected') { x.tries = 0; void this.tuneSender(tr.sender, own.kbps, own.fps, 1, own.vts); }
    });
    void (async () => {
      try {
        await this.tuneSender(tr.sender, own.kbps, own.fps, 1, own.vts);
        await x.pc.setLocalDescription(await x.pc.createOffer());
        if (!send({ t: 'tvsig', pc: 'up', k: 'offer', sdp: x.pc.localDescription!.sdp })) this.retryUp(x);
      } catch (e) { this.log(`up offer failed: ${(e as Error).message}`); this.retryUp(x); }
    })();
  }
  private retryUp(x: Pc) {
    if (x !== this.up) return;
    const n = x.tries + 1;
    this.closePc(x); this.up = null;
    this.log(`up link lost — retrying in ${backoff(n) / 1000} s`);
    setTimeout(() => { if (!this.up && this.own && this.port.role === 'guest') { this.ensureUp(); if (this.up) (this.up as Pc).tries = n; } }, backoff(n));
    this.onChange();
  }
  private async replaceUp(track: MediaStreamTrack) {
    const tr = this.up?.pc.getTransceivers().find((t) => t.sender.track?.kind === 'video' || t.mid !== null);
    if (!tr) { this.closeUp(false); this.ensureUp(); return; }
    await tr.sender.replaceTrack(track).catch(() => { this.closeUp(false); this.ensureUp(); });
  }
  private closeUp(sayBye: boolean) {
    if (!this.up) return;
    this.hostAudio = null;
    if (sayBye) for (const h of this.port.tvPeers()) this.port.sendTv(h, { t: 'tvsig', pc: 'up', k: 'bye' });
    this.closePc(this.up); this.up = null;
  }
  private async guestUpSig(m: TvSig) {
    const x = this.up;
    if (!x) return;
    if (m.k === 'answer') { await x.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch((e) => this.log(`up answer: ${(e as Error).message}`)); await this.flushIce(x); }
    else if (m.k === 'ice') await this.addIce(x, m.cand);
    else if (m.k === 'bye') this.retryUp(x);
  }

  // ---------------------------------------------------------------- guest: others' feeds ← host ('down', host offers)
  private needDown() {
    if (this.port.role !== 'guest' || this.down) return;
    const host = this.port.tvPeers()[0];
    if (host) this.port.sendTv(host, { t: 'tvsig', pc: 'down', k: 'need' });
  }
  private closeDown() { this.closePc(this.down); this.down = null; }
  private async guestDownSig(m: TvSig) {
    const host = this.port.tvPeers()[0];
    if (!host) return;
    if (m.k === 'offer') {
      let x = this.down;
      if (!x || x.pc.connectionState === 'failed' || x.pc.connectionState === 'closed') {
        this.closeDown();
        x = this.newPc('guest', (mm) => this.port.sendTv(host, mm), 'down');
        this.down = x;
        const xx = x;
        x.pc.ondatachannel = (e) => { if (e.channel.label === 'lvl') this.levelDc(xx, e.channel, null); };
        x.pc.ontrack = (e) => {
          const owner = xx.map[e.transceiver.mid ?? ''];
          if (!owner || owner === this.port.myId) return;
          const stream = e.streams[0] ?? new MediaStream([e.track]);
          try { (e.receiver as RTCRtpReceiver & { jitterBufferTarget?: number }).jitterBufferTarget = 80; } catch { /* */ }
          this.feeds.set(owner, { owner, stream, track: e.track, level: 0, levelAt: 0, via: 'down' });
          e.track.addEventListener('ended', () => { if (this.feeds.get(owner)?.track === e.track) { this.feeds.delete(owner); this.onChange(); } });
          this.onChange();
        };
        const fail = () => {
          if (xx !== this.down) return;
          this.closeDown();
          for (const [k, f] of this.feeds) if (f.via === 'down') this.feeds.delete(k);
          this.onChange();
          setTimeout(() => this.needDown(), backoff(++xx.tries));
        };
        x.onFail = fail;
        x.pc.addEventListener('connectionstatechange', () => { if (xx.pc.connectionState === 'failed' || xx.pc.connectionState === 'closed') fail(); });
      }
      x.map = m.map ?? {};
      // owners no longer offered: gone
      const keep = new Set(Object.values(x.map));
      for (const [k, f] of this.feeds) if (f.via === 'down' && !keep.has(k)) this.feeds.delete(k);
      try {
        await x.pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
        await this.flushIce(x);
        await x.pc.setLocalDescription(await x.pc.createAnswer());
        this.port.sendTv(host, { t: 'tvsig', pc: 'down', k: 'answer', sdp: x.pc.localDescription!.sdp });
        // tracks already known under a moved mid: re-map
        for (const t of x.pc.getTransceivers()) {
          const owner = x.map[t.mid ?? ''];
          if (owner && owner !== this.port.myId && t.receiver.track && t.currentDirection !== 'inactive' && !this.feeds.has(owner)) {
            this.feeds.set(owner, { owner, stream: new MediaStream([t.receiver.track]), track: t.receiver.track, level: 0, levelAt: 0, via: 'down' });
          }
        }
      } catch (e) { this.log(`down offer: ${(e as Error).message}`); }
      this.onChange();
    } else if (m.k === 'ice' && this.down) await this.addIce(this.down, m.cand);
    else if (m.k === 'bye') { this.closeDown(); for (const [k, f] of this.feeds) if (f.via === 'down') this.feeds.delete(k); this.onChange(); }
  }

  // ---------------------------------------------------------------- host: a guest's feed ('up', guest offers)
  private async hostUpSig(g: string, m: TvSig) {
    if (m.k === 'offer') {
      this.closePc(this.ups.get(g));
      const x = this.newPc('host', (mm) => this.port.sendTv(g, mm), 'up');
      this.ups.set(g, x);
      x.pc.ondatachannel = (e) => { if (e.channel.label === 'lvl') this.levelDc(x, e.channel, g); };
      x.pc.ontrack = (e) => {
        if (e.track.kind === 'audio') {
          // guestlink: a browser guest's voice (they are not in Discord voice) → this PC's OBS pages
          this.voices.set(g, { stream: new MediaStream([e.track]), track: e.track });
          e.track.addEventListener('ended', () => { if (this.voices.get(g)?.track === e.track) { this.voices.delete(g); this.onChange(); } });
          this.log(`voice from ${g}`);
          this.onChange();
          return;
        }
        const stream = e.streams[0] ?? new MediaStream([e.track]);
        try { (e.receiver as RTCRtpReceiver & { jitterBufferTarget?: number }).jitterBufferTarget = 60; } catch { /* */ }
        this.feeds.set(g, { owner: g, stream, track: e.track, level: 0, levelAt: 0, via: 'up' });
        e.track.addEventListener('ended', () => { if (this.feeds.get(g)?.track === e.track) { this.feeds.delete(g); this.membersChanged(); this.onChange(); } });
        this.log(`feed from ${g}`);
        this.membersChanged();
        this.onChange();
      };
      const fail = () => {
        if (this.ups.get(g) !== x) return;
        this.ups.delete(g); this.closePc(x); this.voices.delete(g); this.listeners.delete(g);
        if (this.feeds.get(g)?.via === 'up') { this.feeds.delete(g); this.membersChanged(); }
        this.port.sendTv(g, { t: 'tvsig', pc: 'up', k: 'bye' });      // → the guest re-offers right away
        this.onChange();
      };
      x.onFail = fail;
      x.pc.addEventListener('connectionstatechange', () => { if (x.pc.connectionState === 'failed' || x.pc.connectionState === 'closed') fail(); });
      try {
        await x.pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
        await this.flushIce(x);
        // guestlink: a voice transceiver answers sendrecv — my voice goes back on it (now or when I turn it on)
        let ear = false;
        for (const t of x.pc.getTransceivers()) if (t.receiver.track?.kind === 'audio') { ear = true; t.direction = 'sendrecv'; const r = this.trackFor(g); if (r) await t.sender.replaceTrack(r).catch(() => {}); }
        if (ear !== this.listeners.has(g)) { if (ear) this.listeners.add(g); else this.listeners.delete(g); this.onChange(); }
        await x.pc.setLocalDescription(await x.pc.createAnswer());
        this.port.sendTv(g, { t: 'tvsig', pc: 'up', k: 'answer', sdp: x.pc.localDescription!.sdp });
      } catch (e) { this.log(`up answer for ${g}: ${(e as Error).message}`); }
    } else if (m.k === 'ice') { const x = this.ups.get(g); if (x) await this.addIce(x, m.cand); }
    else if (m.k === 'bye') {
      this.closePc(this.ups.get(g)); this.ups.delete(g);
      if (this.listeners.delete(g)) this.onChange();
      if (this.feeds.get(g)?.via === 'up') { this.feeds.delete(g); this.membersChanged(); }
      this.onChange();
    }
  }

  // ---------------------------------------------------------------- host: everyone else's feeds → a guest ('down', I offer)
  private async hostDownSig(g: string, m: TvSig) {
    const x = this.downs.get(g);
    if (m.k === 'need') { if (x && x.pc.connectionState === 'connected') { x.dirty = true; void this.renegotiate(g, x); } else { this.closeHost(g, false); this.syncDown(g); } return; }
    if (!x) return;
    if (m.k === 'answer') {
      await x.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch((e) => this.log(`down answer from ${g}: ${(e as Error).message}`));
      await this.flushIce(x);
      x.busy = false;
      if (x.dirty) void this.renegotiate(g, x);
    } else if (m.k === 'ice') await this.addIce(x, m.cand);
  }

  /** Host: bring guest `g`'s down link in line with the feeds it may see (add / remove / replace forwards). */
  syncDown(g: string) {
    if (this.port.role !== 'host' || !this.port.tvPeers().includes(g)) return;
    const want = new Map<string, TvFeed>();
    for (const f of this.feeds.values()) {
      if (f.owner === g || f.track.readyState !== 'live' || !this.port.mayForward(f.owner, g)) continue;
      // moderation: a hidden guest's forward carries the "Camera off" card instead of their picture
      const c = this.mod?.cover(f.owner);
      want.set(f.owner, c ? { ...f, stream: c.stream, track: c.track } : f);
    }
    let x = this.downs.get(g);
    if (!x && !want.size) return;
    if (!x) {
      x = this.newPc('host', (mm) => this.port.sendTv(g, mm), 'down');
      this.downs.set(g, x);
      const xx = x;
      this.levelDc(x, x.pc.createDataChannel('lvl', { ordered: false, maxRetransmits: 0 }), '\u0000');   // host never accepts levels here
      xx.onFail = () => {
        if (this.downs.get(g) !== xx) return;
        this.closePc(xx); this.downs.delete(g);
        const n = xx.tries + 1;
        setTimeout(() => { if (!this.downs.has(g)) { this.syncDown(g); const y = this.downs.get(g); if (y) y.tries = n; } }, backoff(n));
      };
      x.pc.addEventListener('connectionstatechange', () => {
        if (this.downs.get(g) !== xx) return;
        const s = xx.pc.connectionState;
        if (s === 'connected') { xx.tries = 0; void this.tuneForwards(xx); }
        if (s === 'failed') xx.onFail?.();
      });
    }
    let changed = false;
    for (const [owner, tr] of x.trs) {
      const f = want.get(owner);
      if (!f) { try { tr.stop(); } catch { /* */ } x.trs.delete(owner); changed = true; }
      else if (tr.sender.track !== f.track) void tr.sender.replaceTrack(f.track).catch(() => {});
    }
    for (const [owner, f] of want) {
      if (x.trs.has(owner)) continue;
      const tr = x.pc.addTransceiver(f.track, { direction: 'sendonly', streams: [f.stream] });
      x.trs.set(owner, tr);
      changed = true;
    }
    if (changed || !x.pc.localDescription) { x.dirty = true; void this.renegotiate(g, x); }
  }

  private async renegotiate(g: string, x: Pc) {
    if (x.busy) return;
    if (x.pc.signalingState !== 'stable') { x.dirty = true; return; }
    x.busy = true; x.dirty = false;
    try {
      await x.pc.setLocalDescription(await x.pc.createOffer());
      const map: Record<string, string> = {};
      for (const [owner, tr] of x.trs) if (tr.mid) map[tr.mid] = owner;
      if (!this.port.sendTv(g, { t: 'tvsig', pc: 'down', k: 'offer', sdp: x.pc.localDescription!.sdp, map })) x.busy = false;
      void this.tuneForwards(x);
    } catch (e) { x.busy = false; this.log(`down offer to ${g}: ${(e as Error).message}`); }
    // no answer within 10 s (lost message / old app): allow a new round
    setTimeout(() => { if (x.busy && x.pc.signalingState !== 'stable') { x.busy = false; x.dirty = true; } }, 10_000);
  }

  /** guestlink — host: send my voice (a mic track) back to every browser guest that sends theirs (null = stop). */
  setReturnAudio(track: MediaStreamTrack | null) {
    this.returnAudio = track;
    this.refreshReturn();
    this.onReturn?.();
  }
  /** greenroom — host: my backstage voice track (null = use the talk-back track). */
  setBackAudio(track: MediaStreamTrack | null) { this.backAudio = track; this.refreshReturn(); this.onReturn?.(); }
  /** partyvoice — host: my talk-back / backstage tracks (the app guests' mix-minus uses them too). */
  get hostTracks(): { main: MediaStreamTrack | null; back: MediaStreamTrack | null } { return { main: this.returnAudio, back: this.backAudio }; }
  /** partyvoice — host: my voices changed (src/net/voice/partyVoice.ts re-plans the mixes). */
  onReturn: (() => void) | null = null;
  /** partyvoice — host: link guests that get a MIX-MINUS instead of my plain voice (someone besides me is on the call:
   *  app guests / other link guests). Missing = the usual return below. */
  private mixes = new Map<string, MediaStreamTrack | null>();
  setMixes(m: Map<string, MediaStreamTrack | null>) {
    const same = m.size === this.mixes.size && [...m].every(([k, v]) => this.mixes.has(k) && this.mixes.get(k) === v);
    if (same) return;
    this.mixes = new Map(m);
    this.refreshReturn();
  }
  /** The voice guest `g` gets from me right now. */
  private trackFor(g: string): MediaStreamTrack | null {
    if (this.mixes.has(g)) return this.mixes.get(g) ?? null;
    const w = this.returnFor?.(g) ?? 'main';
    return w === 'main' ? this.returnAudio : w === 'back' ? this.backAudio ?? this.returnAudio : null;
  }
  /** Re-apply who hears which of my voices (talk-back switched, a guest waiting / brought on / backstage talk). */
  refreshReturn() {
    for (const [g, x] of this.ups) for (const t of x.pc.getTransceivers()) {
      if (t.receiver.track?.kind !== 'audio' || t.direction !== 'sendrecv') continue;
      const want = this.trackFor(g);
      if (t.sender.track !== want) void t.sender.replaceTrack(want).catch(() => {});
    }
  }

  private closeHost(g: string, bye = true) {
    if (this.voices.delete(g) || this.listeners.delete(g)) { this.listeners.delete(g); this.onChange(); }
    const d = this.downs.get(g), u = this.ups.get(g);
    if (d && bye) this.port.sendTv(g, { t: 'tvsig', pc: 'down', k: 'bye' });
    this.closePc(d); this.closePc(u);
    this.downs.delete(g); this.ups.delete(g);
  }

  /** Sender limits: bitrate / fps / resolution scale. VTube Studio pictures keep their resolution (line art). */
  private async tuneSender(s: RTCRtpSender, kbps: number, fps: number, scale: number, detail: boolean) {
    try {
      const p = s.getParameters();
      if (!p.encodings?.length) p.encodings = [{}];
      p.encodings[0] = { ...p.encodings[0], maxBitrate: kbps * 1000, maxFramerate: fps, scaleResolutionDownBy: Math.max(1, scale) };
      (p as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = detail ? 'maintain-resolution' : 'balanced';
      await s.setParameters(p);
    } catch { /* not negotiated yet: retried on connect */ }
  }
  /** Host forwards: quality tier by how many feeds this guest gets (+1 while the host's encoders are CPU-limited):
   *  ≤ 450 kbit/s · ≤ 360 px · 24 fps down to 130 kbit/s · 180 px · 12 fps (the encoder downscales from the source). */
  private cpuLimited = false;
  private async tuneForwards(x: Pc) {
    const tier = TV_FORWARD_TIERS[forwardTier(x.trs.size, this.cpuLimited)];
    for (const [owner, tr] of x.trs) {
      const f = this.feeds.get(owner);
      // (what this sender really carries: the "Camera off" card of a hidden guest is its own size)
      const st = tr.sender.track && tr.sender.track !== f?.track ? tr.sender.track.getSettings().height ?? 0 : 0;
      const h = st || Math.max(f?.track.getSettings().height ?? 0, this.stats.feeds[owner]?.height ?? 0) || 480;
      const key = `${tier.maxHeight}:${h}`;
      if (x.tuned?.get(owner) === key) continue;
      (x.tuned ??= new Map()).set(owner, key);
      await this.tuneSender(tr.sender, tier.kbps, tier.fps, h / tier.maxHeight, false);
    }
  }

  // ---------------------------------------------------------------- levels + stats (every 66 ms / 2 s)
  private tick() {
    const now = performance.now();
    const mine = this.own ? this.own.level() : 0;
    const own = this.feeds.get(this.port.myId);
    if (own) { own.level = mine; own.levelAt = now; }
    if (this.port.role === 'guest' && this.own && this.up?.dc?.readyState === 'open') this.up.dc.send(encodeLevels([[this.port.myId, mine]]) as Uint8Array<ArrayBuffer>);
    if (this.port.role === 'host') {
      for (const [g, x] of this.downs) {
        if (x.dc?.readyState !== 'open') continue;
        const lv: [string, number][] = [];
        for (const f of this.feeds.values()) if (f.owner !== g && x.trs.has(f.owner)) lv.push([f.owner, now - f.levelAt < 1000 ? f.level : 0]);
        if (lv.length) x.dc.send(encodeLevels(lv) as Uint8Array<ArrayBuffer>);
      }
    }
    // stale levels fade (a feed whose level stream stopped isn't "speaking" forever)
    for (const f of this.feeds.values()) if (f.via !== 'own' && now - f.levelAt > 1000) f.level *= 0.8;
    if (now - this.statsT > 2000) { this.statsT = now; void this.pollStats(); }
  }

  private async pollStats() {
    const out: TvLinkStats = { up: null, forwards: [], feeds: {} };
    const rate = (key: string, bytes: number, frames: number) => {
      const t = performance.now(), l = this.last.get(key);
      this.last.set(key, { bytes, t, frames });
      if (!l || t <= l.t) return { kbps: 0, fps: 0 };
      return { kbps: Math.round(((bytes - l.bytes) * 8) / (t - l.t)), fps: Math.round(((frames - l.frames) * 1000) / (t - l.t)) };
    };
    const inbound = async (x: Pc, ownerOf: (mid: string) => string | undefined) => {
      const rep = await x.pc.getStats().catch(() => null);
      rep?.forEach((r) => {
        if (r.type !== 'inbound-rtp' || r.kind !== 'video') return;
        const owner = ownerOf(String(r.mid ?? ''));
        if (!owner) return;
        const { kbps, fps } = rate(`in:${owner}`, r.bytesReceived ?? 0, r.framesDecoded ?? 0);
        out.feeds[owner] = { kbps, fps, width: r.frameWidth ?? 0, height: r.frameHeight ?? 0, lost: r.packetsLost ?? 0, jitterMs: Math.round((r.jitter ?? 0) * 1000), dropped: r.framesDropped ?? 0 };
      });
    };
    try {
      if (this.port.role === 'guest') {
        if (this.up) {
          const rep = await this.up.pc.getStats().catch(() => null);
          let rtt = 0;
          rep?.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime) rtt = Math.round(r.currentRoundTripTime * 1000); });
          rep?.forEach((r) => {
            if (r.type !== 'outbound-rtp' || r.kind !== 'video') return;
            const { kbps, fps } = rate('up', r.bytesSent ?? 0, r.framesEncoded ?? 0);
            out.up = { kbps, fps, width: r.frameWidth ?? 0, height: r.frameHeight ?? 0, limited: r.qualityLimitationReason && r.qualityLimitationReason !== 'none' ? r.qualityLimitationReason : '', rtt };
          });
        }
        if (this.down) { const x = this.down; await inbound(x, (mid) => x.map[mid]); }
      } else if (this.port.role === 'host') {
        for (const [g, x] of this.ups) await inbound(x, () => g);
        let cpu = 0, n = 0;
        for (const [g, x] of this.downs) {
          const rep = await x.pc.getStats().catch(() => null);
          rep?.forEach((r) => {
            if (r.type !== 'outbound-rtp' || r.kind !== 'video') return;
            n++; if (r.qualityLimitationReason === 'cpu') cpu++;
            const owner = [...x.trs.entries()].find(([, t]) => t.mid === r.mid)?.[0];
            if (!owner) return;
            const { kbps, fps } = rate(`fw:${g}:${owner}`, r.bytesSent ?? 0, r.framesEncoded ?? 0);
            out.forwards.push({ to: g, owner, kbps, height: r.frameHeight ?? 0, fps });
          });
        }
        // a third of the forwards CPU-limited → one tier down (and back up once they aren't)
        const lim = n > 0 && cpu / n > 0.33;
        if (lim !== this.cpuLimited) { this.cpuLimited = lim; this.log(`forwards ${lim ? 'CPU-limited: lower tier' : 'back to normal tier'}`); }
        this.stats = out;
        for (const x of this.downs.values()) void this.tuneForwards(x);
      }
    } catch { /* closed meanwhile */ }
    this.stats = out;
  }

  /** For the diagnostics dump / panel: link states (no SDP, no addresses). */
  debug() {
    const st = (x: Pc | null | undefined) => (x ? `${x.pc.connectionState}${x.busy ? ' (negotiating)' : ''}` : '—');
    return {
      role: this.port.role, sending: !!this.own,
      up: st(this.up), down: st(this.down),
      hostUps: Object.fromEntries([...this.ups].map(([g, x]) => [g, st(x)])),
      hostDowns: Object.fromEntries([...this.downs].map(([g, x]) => [g, `${st(x)} · ${x.trs.size} feeds`])),
      feeds: [...this.feeds.values()].map((f) => ({ owner: f.owner, via: f.via, live: f.track.readyState === 'live', level: Math.round(f.level * 100) / 100 })),
      stats: this.stats,
    };
  }
}
