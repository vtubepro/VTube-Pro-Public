// The guest viewer's link to the gaming PC: relay socket (the existing phone-link route, role=phone), the WebRTC peer connection
// (the viewer OFFERS, recvonly video + the 'gs' data channel; relay-only ICE whenever the relay has TURN), the small messages,
// stats, retries. All decisions come from GsViewFlow (flow.ts, pure); this file only does what it says. No helper /api calls.
// Spec: docs/GUEST_BROWSER_SOURCE.md sections 3, 6, 8.
import {
  GS_CHANNEL, GS_NONCE_ATTR, GS_STATS_EVERY_MS, encodeMsg, gsSocketUrl, gsVerifyAnswer, icePolicy, newGsNonce, sanitizeToViewer, sdpWithAttr, viewerPeerId,
  type GsLink, type GsToViewer, type GsViewerState,
} from '../../shared/guestFeed.ts';
import { GS_KEEPALIVE_MS, GS_STABLE_MS, GsViewFlow, type FlowAct, type FlowTimer } from './flow.ts';
import { GsSlowDetector, parseRelayMsg, summarizeStats, type GsIceServer, type RelayMsg } from './proto.ts';

export type GsCfg = Extract<GsToViewer, { t: 'cfg' }>;
export interface LinkHooks {
  onPhase(phase: GsViewerState): void;
  onTrack(track: MediaStreamTrack): void;
  /** the peer connection is gone: stop painting from its video (the last picture stays) */
  onNoTrack(): void;
  onCfg(cfg: GsCfg): void;
  /** blocked / full / off: the picture goes now */
  onTerminal(): void;
  /** decoded frames shown so far (render.frames) */
  frames(): number;
  log?(what: string): void;
}

export class GsViewLink {
  readonly flow = new GsViewFlow();
  readonly peer: string;
  pc: RTCPeerConnection | null = null;
  ice: GsIceServer[] = [];
  policy: 'relay' | 'all' = 'all';
  cfg: GsCfg | null = null;
  lastStats: ReturnType<typeof summarizeStats> | null = null;
  private sock: WebSocket | null = null;
  private dc: RTCDataChannel | null = null;
  private timers = new Map<FlowTimer, number>();
  private keepT = 0; private stableT = 0; private statsT = 0;
  private cands: unknown[] = [];
  /** the nonce this viewer put into the offer it is waiting on (the sender must sign it) and the offer text exactly as it was sent */
  private nonce = '';
  private wireOffer = '';
  private chain: Promise<void> = Promise.resolve();
  private gen = 0;
  private vis = true;
  private dead = false;
  /** the phase the page was last told about */
  private told: GsViewerState = 'connecting';
  private slow = new GsSlowDetector();
  private lastFrames = 0; private lastAt = 0;

  /** `key`: the viewer's identity ON THIS LINK (shared/guestFeed.ts derivePeerKey), never the key kept in the page's storage. */
  constructor(readonly link: GsLink, key: string, inst: string, private hooks: LinkHooks, private obs = false) {
    this.peer = viewerPeerId(key, inst);
  }

  start() { this.run(this.flow.begin()); }
  get phase() { return this.flow.phase; }
  get channelOpen() { return this.dc?.readyState === 'open'; }

  /** the OBS source is shown / hidden (obsSourceVisibleChanged, document.visibilityState) */
  setVisible(on: boolean) {
    if (on === this.vis) return;
    this.vis = on;
    this.sendDc({ t: 'vis', on });
  }
  /** pagehide: tell the sender, give the relay its place back, never reconnect */
  leave() {
    this.dead = true;
    try { this.sendDc({ t: 'bye' }); } catch { /* */ }
    this.sendRelay({ t: 'bye' });
    this.teardown();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // ---------------------------------------------------------------- doing what the flow says
  private run(acts: FlowAct[]) {
    for (const a of acts) {
      switch (a.k) {
        case 'socket': this.openSocket(); break;
        case 'closeSocket': this.closeSocket(); break;
        case 'closePc': this.closePc(); break;
        case 'offer': void this.makeOffer(a.fresh); break;
        case 'timer': this.setTimer(a.id, a.ms); break;
        case 'clear': this.clearTimer(a.id); break;
      }
    }
    this.sync();
  }
  private sync() {
    const now = this.flow.phase, before = this.told;
    if (now !== before) {
      this.told = now;
      this.hooks.log?.(`${before} -> ${now}`);
      if (this.flow.terminal) this.hooks.onTerminal();
      this.hooks.onPhase(now);
    }
  }
  private setTimer(id: FlowTimer, ms: number) {
    this.clearTimer(id);
    if (this.dead) return;
    this.timers.set(id, window.setTimeout(() => { this.timers.delete(id); this.run(this.flow.onTimer(id)); }, ms));
  }
  private clearTimer(id: FlowTimer) { const t = this.timers.get(id); if (t !== undefined) { clearTimeout(t); this.timers.delete(id); } }

  // ---------------------------------------------------------------- relay socket
  private openSocket() {
    if (this.dead || (this.sock && this.sock.readyState <= 1)) return;
    let s: WebSocket;
    try { s = new WebSocket(gsSocketUrl(this.link.relay, this.link.id, 'viewer', this.peer)); }
    catch { this.run(this.flow.onSocketGone()); return; }
    this.sock = s;
    s.onopen = () => {
      clearInterval(this.keepT); clearTimeout(this.stableT);
      // the relay drops a viewer socket that sends nothing for 2 minutes: a null candidate is passed on and harmless
      this.keepT = window.setInterval(() => this.sendRelay({ t: 'signal', data: { candidate: null } }), GS_KEEPALIVE_MS);
      this.stableT = window.setTimeout(() => this.run(this.flow.onStable()), GS_STABLE_MS);
    };
    s.onmessage = (e) => { if (this.sock === s) this.onRelay(parseRelayMsg(e.data)); };
    s.onclose = (e) => {
      if (this.sock !== s) return;
      this.sock = null;
      clearInterval(this.keepT); clearTimeout(this.stableT);
      if (!this.dead) this.run(this.flow.onSocketGone(e.code));
    };
    s.onerror = () => { /* onclose follows */ };
  }
  private closeSocket() {
    const s = this.sock;
    this.sock = null;
    clearInterval(this.keepT); clearTimeout(this.stableT);
    try { s?.close(); } catch { /* */ }
  }
  private sendRelay(m: unknown) { if (this.sock?.readyState === 1) this.sock.send(JSON.stringify(m)); }

  private onRelay(m: RelayMsg | null) {
    if (!m) return;
    switch (m.k) {
      case 'ready':
        this.ice = m.ice; this.policy = icePolicy(m.ice);
        this.run(this.flow.onReady(m.peer));
        break;
      case 'peer': this.run(this.flow.onPeer(m.here)); break;
      case 'bye': this.run(this.flow.onBye()); break;
      case 'busy': break;
      case 'side': this.run(this.flow.onSide(m.s)); break;
      case 'answer': this.later(async (p) => {
        if (p.signalingState !== 'have-local-offer') return;
        // Only an answer signed by THIS link's key for THIS offer is believed (shared/guestFeed.ts gsVerifyAnswer): the relay lets anyone
        // who holds the link id sit in the sender's place. An unsigned or foreign answer is dropped before the connection sees it.
        const pub = this.link.pub, nonce = this.nonce;
        const sdp = pub && nonce ? await gsVerifyAnswer(pub, { id: this.link.id, peer: this.peer, nonce, answerSdp: m.sdp }) : null;
        if (this.pc !== p) return;
        if (!sdp) { this.hooks.log?.('answer refused: not signed by this link'); return; }
        await p.setRemoteDescription({ type: 'answer', sdp });
        this.run(this.flow.onAnswer());
      }); break;
      case 'cand': this.later(async (p) => { if (p.remoteDescription) await p.addIceCandidate((m.cand ?? undefined) as RTCIceCandidateInit | undefined); }); break;
    }
  }
  /** signalling work on the CURRENT peer connection, one step at a time; a stale or failing step is ignored */
  private later(fn: (p: RTCPeerConnection) => Promise<void>) {
    const gen = this.gen;
    this.chain = this.chain.then(async () => { const p = this.pc; if (p && gen === this.gen) await fn(p); }).catch(() => { /* a stale answer or candidate */ });
  }

  // ---------------------------------------------------------------- peer connection
  private closePc() {
    this.gen++;
    clearInterval(this.statsT);
    const p = this.pc, d = this.dc;
    this.pc = null; this.dc = null; this.cands = []; this.nonce = ''; this.wireOffer = '';
    if (p) this.hooks.onNoTrack();
    try { if (d) { d.onopen = d.onclose = d.onmessage = null; d.close(); } } catch { /* */ }
    try { if (p) { p.onicecandidate = p.onconnectionstatechange = p.ontrack = null; p.close(); } } catch { /* */ }
  }
  private teardown() { this.closePc(); this.closeSocket(); }

  private async makeOffer(fresh: boolean) {
    if (this.dead) return;
    if (!fresh) {
      // the same offer again (nobody answered yet): the sender may have missed it, or is waiting for its owner
      const p = this.pc;
      if (!p || p.signalingState !== 'have-local-offer' || !p.localDescription) return;
      this.sendRelay({ t: 'signal', data: { sdp: { type: 'offer', sdp: this.wireOffer || p.localDescription.sdp } } });
      for (const c of this.cands) this.sendRelay({ t: 'signal', data: { candidate: c } });
      return;
    }
    this.closePc();
    const gen = this.gen;
    let p: RTCPeerConnection;
    try {
      p = new RTCPeerConnection({ iceServers: this.ice as RTCIceServer[], iceTransportPolicy: this.policy });
    } catch { this.run(this.flow.onPcState('failed')); return; }
    this.pc = p;
    // recvonly video and the 'gs' channel: nothing else (no audio line, ever). The codecs in the offer are the ones this browser decodes.
    p.addTransceiver('video', { direction: 'recvonly' });
    const dc = p.createDataChannel(GS_CHANNEL, { ordered: true });
    this.dc = dc;
    p.ontrack = (ev) => { if (this.pc === p && ev.track.kind === 'video') this.hooks.onTrack(ev.track); };
    p.onicecandidate = (ev) => {
      if (this.pc !== p) return;
      const c = ev.candidate ? ev.candidate.toJSON() : null;
      this.cands.push(c);
      this.sendRelay({ t: 'signal', data: { candidate: c } });
    };
    p.onconnectionstatechange = () => { if (this.pc === p) this.run(this.flow.onPcState(p.connectionState)); };
    dc.onopen = () => {
      if (this.dc !== dc) return;
      this.sendDc({ t: 'vis', on: this.vis });
      this.lastFrames = this.hooks.frames(); this.lastAt = performance.now(); this.slow.reset();
      clearInterval(this.statsT);
      this.statsT = window.setInterval(() => void this.reportStats(p), GS_STATS_EVERY_MS);
      this.run(this.flow.onChannelOpen());
    };
    dc.onclose = () => { if (this.dc === dc && !this.dead) this.run(this.flow.onPcState('disconnected')); };
    dc.onmessage = (e) => {
      const m = sanitizeToViewer(e.data);
      if (!m) return;
      if (m.t === 'off') { this.run(this.flow.onOffMsg()); return; }
      this.cfg = m;
      this.hooks.onCfg(m);
    };
    try {
      await p.setLocalDescription(await p.createOffer());
      if (this.pc !== p || gen !== this.gen) return;
      // the nonce rides in the offer text (the relay passes nothing else of an offer); the local description itself stays as the browser made it
      this.nonce = newGsNonce();
      this.wireOffer = sdpWithAttr(p.localDescription!.sdp, GS_NONCE_ATTR, this.nonce);
      this.sendRelay({ t: 'signal', data: { sdp: { type: 'offer', sdp: this.wireOffer } } });
    } catch { if (this.pc === p) this.run(this.flow.onPcState('failed')); }
  }

  private sendDc(m: Parameters<typeof encodeMsg>[0]) { if (this.dc?.readyState === 'open') this.dc.send(encodeMsg(m)); }

  private async reportStats(p: RTCPeerConnection) {
    if (this.pc !== p || this.dc?.readyState !== 'open') return;
    let s: ReturnType<typeof summarizeStats>;
    try { s = summarizeStats(await p.getStats()); } catch { return; }
    if (this.pc !== p) return;
    this.lastStats = s;
    const now = performance.now(), fr = this.hooks.frames(), dt = Math.max(1, now - this.lastAt);
    const shownFps = Math.round(((fr - this.lastFrames) * 1000) / dt);
    this.lastFrames = fr; this.lastAt = now;
    this.sendDc({ t: 'stats', fps: shownFps || s.fps, w: s.w, h: s.h, codec: s.codec, dec: s.dec, lost: s.lost, dropped: s.dropped, rttMs: s.rttMs, obs: this.obs, route: s.route });
    if (this.slow.feed(now, s.decoded, s.dropped)) this.sendDc({ t: 'slow' });
  }
}
