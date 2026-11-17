// TV feeds → this PC's OBS pages. The OBS Browser Source is a separate browser (OBS's CEF) from the studio, so the
// studio streams every TV feed it has (its own when it appears as a TV + everything the party delivered) to each OBS
// page over a LOCAL WebRTC link — the same pattern as the react screen share (src/scene/screenShare.ts):
//
//  * signalling + voice levels = the local bus ({type:'tvfeed'}; the bus only accepts loopback pages)
//  * no STUN / TURN (iceServers: []): host candidates on this machine only; nothing leaves the PC
//  * ONE peer connection per page carrying every feed (one transceiver each, mid → feed id in each offer); the studio is
//    always the offerer and renegotiates when feeds come or go
//  * high bitrate, no downscale (it's loopback), minimal receive jitter buffer
//  * RAM only: frames exist in the two browsers' WebRTC stacks and <video> elements — never recorded, never on disk
import type { BusMessage } from '../../../shared/types.ts';
import { keepPeer, markBorn } from '../peerKeep.ts';
import { TV_LOCAL } from '../../../shared/tv.ts';

type TvMsg = Extract<BusMessage, { type: 'tvfeed' }>;
type Send = (m: TvMsg) => void;
type Listen = (h: (m: BusMessage) => void) => () => void;
const rid = () => Math.random().toString(36).slice(2, 10);

function preferH264(tr: RTCRtpTransceiver) {
  try {
    const caps = RTCRtpSender.getCapabilities?.('video')?.codecs ?? [];
    const rank = (mime: string) => (/h264/i.test(mime) ? 0 : /vp8/i.test(mime) ? 1 : /vp9/i.test(mime) ? 2 : 9);
    const sorted = [...caps].sort((a, b) => rank(a.mimeType) - rank(b.mimeType));
    if (sorted.length) tr.setCodecPreferences(sorted);
  } catch { /* browser picks */ }
}

/** A guest's picture (video) + voice level for this PC's OBS pages. Never a voice: guests are heard only in the studio. */
export interface LocalFeed { id: string; stream: MediaStream; track: MediaStreamTrack; level: number }

/** Studio side. `feeds()` = every feed to publish right now (id = party member id). */
export class TvLocalSender {
  readonly id = `tvs-${rid()}`;
  private peers = new Map<string, { pc: RTCPeerConnection; trs: Map<string, RTCRtpTransceiver>; busy: boolean; dirty: boolean; at: number; stats: Record<string, unknown> | null }>();
  private timer = 0; private lvlT = 0;
  constructor(private send: Send, listen: Listen, private feeds: () => LocalFeed[]) {
    listen((m) => { if (m.type === 'tvfeed') this.onMsg(m); });
    this.timer = window.setInterval(() => this.tick(), 1000);
    this.lvlT = window.setInterval(() => this.levels(), 66);
  }
  get pages(): { id: string; state: string; stats: Record<string, unknown> | null }[] { return [...this.peers].map(([id, p]) => ({ id, state: p.pc.connectionState, stats: p.stats })); }

  /** Feeds changed: re-plan every page's connection (and wake pages that loaded before we had anything). */
  sync() {
    const list = this.feeds();
    if (list.length) this.send({ type: 'tvfeed', k: 'avail', from: this.id });
    for (const [page, p] of this.peers) this.plan(page, p, list);
  }

  private onMsg(m: TvMsg) {
    if (m.to && m.to !== this.id) return;
    if (m.k === 'hello') { if ((this.feeds().length || this.peers.has(m.from)) && !keepPeer(this.peers.get(m.from)?.pc)) this.open(m.from); } // (src/net/peerKeep.ts)
    else if (m.k === 'answer' && m.sdp) {
      const p = this.peers.get(m.from);
      if (!p) return;
      void p.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).then(() => { p.busy = false; if (p.dirty) void this.offer(m.from, p); }).catch(() => this.close(m.from));
    } else if (m.k === 'ice') { const p = this.peers.get(m.from); if (p && m.cand) void p.pc.addIceCandidate(m.cand).catch(() => {}); }
    else if (m.k === 'stats') { const p = this.peers.get(m.from); if (p) { p.stats = m.stats ?? null; p.at = performance.now(); } }
    else if (m.k === 'bye') this.close(m.from);
  }

  private open(page: string) {
    this.close(page);
    const pc = new RTCPeerConnection({ iceServers: [] });
    markBorn(pc);
    const p = { pc, trs: new Map<string, RTCRtpTransceiver>(), busy: false, dirty: false, at: performance.now(), stats: null };
    this.peers.set(page, p);
    pc.onicecandidate = (e) => this.send({ type: 'tvfeed', k: 'ice', from: this.id, to: page, cand: e.candidate ? e.candidate.toJSON() : null });
    pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.close(page); });
    this.plan(page, p, this.feeds(), true);
  }

  private plan(page: string, p: NonNullable<ReturnType<typeof this.peers.get>>, list: LocalFeed[], force = false) {
    // video per feed id
    const want = new Map<string, { track: MediaStreamTrack; stream: MediaStream }>();
    // (audio never goes to an OBS page: guest voices play only in the studio — owner rule; a stray audio feed is dropped)
    for (const f of list) if (f.track.kind === 'video') want.set(f.id, f);
    let changed = force;
    for (const [id, tr] of p.trs) {
      const f = want.get(id);
      if (!f) { try { tr.stop(); } catch { /* */ } p.trs.delete(id); changed = true; }
      else if (tr.sender.track !== f.track) void tr.sender.replaceTrack(f.track).catch(() => {});
    }
    for (const [id, f] of want) {
      if (p.trs.has(id)) continue;
      const tr = p.pc.addTransceiver(f.track, { direction: 'sendonly', streams: [f.stream] });
      if (f.track.kind === 'video') preferH264(tr);
      p.trs.set(id, tr);
      changed = true;
    }
    if (changed) { p.dirty = true; void this.offer(page, p); }
  }

  private async offer(page: string, p: NonNullable<ReturnType<typeof this.peers.get>>) {
    if (p.busy || p.pc.signalingState !== 'stable') { p.dirty = true; return; }
    p.busy = true; p.dirty = false;
    try {
      for (const tr of p.trs.values()) {
        if (tr.sender.track?.kind !== 'video') continue;
        const prm = tr.sender.getParameters();
        if (!prm.encodings?.length) prm.encodings = [{}];
        prm.encodings[0] = { ...prm.encodings[0], maxBitrate: TV_LOCAL.kbps * 1000, maxFramerate: TV_LOCAL.fps, scaleResolutionDownBy: 1 };
        await tr.sender.setParameters(prm).catch(() => {});
      }
      await p.pc.setLocalDescription(await p.pc.createOffer());
      const map: Record<string, string> = {};
      for (const [id, tr] of p.trs) if (tr.mid) map[tr.mid] = id;
      this.send({ type: 'tvfeed', k: 'offer', from: this.id, to: page, sdp: p.pc.localDescription!.sdp, map });
    } catch (e) { console.warn('tv local offer', e); p.busy = false; }
    setTimeout(() => { if (p.busy && p.pc.signalingState !== 'stable') { p.busy = false; this.close(page); } }, 8000);
  }

  private close(page: string) {
    const p = this.peers.get(page);
    if (!p) return;
    this.peers.delete(page);
    try { p.pc.close(); } catch { /* */ }
  }

  private tick() {
    if (this.feeds().length) this.send({ type: 'tvfeed', k: 'avail', from: this.id });
    for (const [id, p] of this.peers) if (!p.stats && performance.now() - p.at > 10_000 && p.pc.connectionState !== 'connected') this.close(id);
  }
  private levels() {
    const list = this.feeds();
    if (!list.length) return;
    const lv: Record<string, number> = {};
    for (const f of list) if (f.track.kind === 'video') lv[f.id] = Math.round(f.level * 100) / 100;
    this.send({ type: 'tvfeed', k: 'lvl', from: this.id, lv });
  }

  dispose() { clearInterval(this.timer); clearInterval(this.lvlT); for (const id of [...this.peers.keys()]) this.close(id); this.send({ type: 'tvfeed', k: 'bye', from: this.id }); }
}

/** OBS page side: receives every TV feed from this PC's studio. */
export class TvLocalReceiver {
  readonly id = `tvr-${rid()}`;
  private pc: RTCPeerConnection | null = null;
  private sender = '';
  private helloTo = ''; private helloAt = -1e9;
  private map: Record<string, string> = {};
  readonly streams = new Map<string, { stream: MediaStream; track: MediaStreamTrack }>();
  readonly levels = new Map<string, { v: number; at: number }>();
  /** Guest voices are refused here (owner: guests only through the studio): always empty. Kept for diagnostics / tests. */
  readonly voices = new Map<string, { stream: MediaStream; track: MediaStreamTrack }>();
  /** Offers / tracks refused because they carried audio (an older studio). */
  refused = 0;
  private timer = 0;
  private last = new Map<string, { b: number; t: number }>();
  onChange: () => void = () => {};

  constructor(private send: Send, listen: Listen) {
    listen((m) => { if (m.type === 'tvfeed') void this.onMsg(m); });
    this.hello();
    this.timer = window.setInterval(() => void this.tick(), 2000);
  }
  private hello() { this.send({ type: 'tvfeed', k: 'hello', from: this.id }); }

  private async onMsg(m: TvMsg) {
    if (m.k === 'lvl' && m.lv && typeof m.lv === 'object') {
      const now = performance.now();
      for (const [id, v] of Object.entries(m.lv).slice(0, 12)) if (typeof v === 'number' && Number.isFinite(v)) this.levels.set(id, { v: Math.min(1, Math.max(0, v)), at: now });
      return;
    }
    if (m.to && m.to !== this.id) return;
    // a studio announces feeds: (re)connect when I have no link, it failed / closed, or it's a DIFFERENT studio than the one
    // I'm linked to (the studio tab reloaded: its old connection never reports 'failed' here, so I'd ignore the new one
    // forever and the guests' cameras never reach this OBS page)
    if (m.k === 'avail' && (!this.pc || this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed' || (!!m.from && m.from !== this.sender))) {
      // (one hello per studio every 4 s: its offer is on the way — a second hello would restart the handshake mid-flight)
      const now = performance.now();
      if (m.from !== this.helloTo || now - this.helloAt > 4000) { this.helloTo = m.from ?? ''; this.helloAt = now; this.hello(); }
    }
    else if (m.k === 'bye' && (!this.sender || m.from === this.sender)) this.drop();
    else if (m.k === 'ice' && m.from === this.sender && m.cand) void this.pc?.addIceCandidate(m.cand).catch(() => {});
    else if (m.k === 'offer' && m.sdp) {
      // an offer that carries audio (an older studio sending guest voices) is refused before any negotiation: this page
      // never receives a voice (owner rule). The studio gives up on it; pictures come again from an up-to-date studio.
      if (/^m=audio /m.test(m.sdp)) { this.refused++; console.warn('tv local: refused an offer with audio (guest voices play only in the studio)'); return; }
      if (this.sender !== m.from || !this.pc) {
        this.drop(false);
        this.sender = m.from;
        const pc = (this.pc = new RTCPeerConnection({ iceServers: [] }));
        pc.onicecandidate = (e) => this.send({ type: 'tvfeed', k: 'ice', from: this.id, to: m.from, cand: e.candidate ? e.candidate.toJSON() : null });
        pc.ontrack = (e) => {
          try { (e.receiver as RTCRtpReceiver & { jitterBufferTarget?: number }).jitterBufferTarget = 0; } catch { /* */ }
          const id = this.map[e.transceiver.mid ?? ''];
          if (!id) return;
          if (e.track.kind !== 'video') { this.refused++; try { e.track.stop(); } catch { /* */ } return; }   // (never a voice here)
          this.streams.set(id, { stream: new MediaStream([e.track]), track: e.track });
          e.track.addEventListener('ended', () => { if (this.streams.get(id)?.track === e.track) { this.streams.delete(id); this.onChange(); } });
          this.onChange();
        };
        pc.addEventListener('connectionstatechange', () => {
          if (pc !== this.pc) return;
          if (pc.connectionState === 'failed' || pc.connectionState === 'closed') { this.drop(); setTimeout(() => this.hello(), 1000); }
        });
      }
      const pc = this.pc!;
      this.map = m.map ?? {};
      const keep = new Set(Object.values(this.map));
      for (const id of [...this.streams.keys()]) if (!keep.has(id)) this.streams.delete(id);
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        this.send({ type: 'tvfeed', k: 'answer', from: this.id, to: m.from, sdp: pc.localDescription!.sdp });
        // renegotiation can move a known track to a new id (a mid re-used): refresh from the transceivers
        for (const t of pc.getTransceivers()) {
          const id = this.map[t.mid ?? ''];
          if (id && t.receiver.track?.kind === 'video' && t.currentDirection !== 'inactive' && t.currentDirection !== 'stopped' && this.streams.get(id)?.track !== t.receiver.track) {
            this.streams.set(id, { stream: new MediaStream([t.receiver.track]), track: t.receiver.track });
          }
        }
      } catch (e) { console.warn('tv local answer', e); this.drop(); }
      this.onChange();
    }
  }

  level(id: string): number { const l = this.levels.get(id); return l && performance.now() - l.at < 800 ? l.v : 0; }

  private drop(notify = true) {
    try { this.pc?.close(); } catch { /* */ }
    this.pc = null; this.sender = ''; this.map = {};
    const had = this.streams.size > 0;
    this.streams.clear();
    if (notify && had) this.onChange();
  }

  private async tick() {
    const pc = this.pc;
    if (!pc || pc.connectionState !== 'connected') return;
    try {
      const rep = await pc.getStats();
      const out: Record<string, unknown> = {};
      rep.forEach((r) => {
        if (r.type !== 'inbound-rtp' || r.kind !== 'video') return;
        const id = this.map[String(r.mid ?? '')];
        if (!id) return;
        const t = performance.now(), l = this.last.get(id);
        this.last.set(id, { b: r.bytesReceived ?? 0, t });
        out[id] = { fps: Math.round(r.framesPerSecond ?? 0), w: r.frameWidth ?? 0, h: r.frameHeight ?? 0, kbps: l ? Math.round((((r.bytesReceived ?? 0) - l.b) * 8) / (t - l.t)) : 0, decoder: r.decoderImplementation ?? '' };
      });
      if (this.sender) this.send({ type: 'tvfeed', k: 'stats', from: this.id, to: this.sender, stats: out });
    } catch { /* */ }
  }

  dispose() { clearInterval(this.timer); this.send({ type: 'tvfeed', k: 'bye', from: this.id, to: this.sender || undefined }); this.drop(false); }
}
