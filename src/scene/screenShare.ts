// React screen share: the host studio captures a window (getDisplayMedia) and streams it to this PC's OBS output
// pages over a LOCAL WebRTC link, so the window can be drawn INSIDE the 3D scene on the real screen mesh (perfect
// perspective at any angle, occlusion by performers, power-on fx, camera moves) instead of an OBS passthrough hole.
//
//  * signalling = the local bus ({type:'screen'} messages; the bus server only listens on 127.0.0.1)
//  * no STUN/TURN (iceServers: []): host candidates on this machine only; nothing leaves the PC
//  * one peer connection per OBS page; high bitrate (30 Mbit/s), up to 60 fps, source resolution kept,
//    H.264 preferred (hardware encode/decode on most GPUs) then VP9; minimal receive jitter buffer
//  * audio is never captured — the window's sound stays in the performer's own OBS audio routing
//
//  * demand-driven: a page that is not drawing the window (Talk mode, the preview paused) says {k:'want', on:false}; after a
//    short hold the sender sets encodings[0].active=false on THAT link (no renegotiation, the window pick and the link stay,
//    the receiver keeps its last picture) and turns it on again the moment a page wants it. No message = wanted (older
//    pages and the stream PC's pages never send one, so they keep the full stream exactly as before).
//  * the Scene-tab preview's own link is a small box: capped at ~3 Mbit/s, 20 fps, 1280 px wide (SEND_PREVIEW)
//
// Receivers say 'hello' on load (and whenever they hear 'avail'); the sender offers; 'bye' = the picked window closed /
// sharing stopped (pages show a NO SIGNAL card). Receivers report stats every second (studio shows fps / latency).
import type { BusMessage } from '../../shared/types.ts';
import { keepPeer, markBorn } from '../net/peerKeep.ts';
import type { ScreenRxStats } from '../../shared/screenShare.ts';

type ScreenMsg = Extract<BusMessage, { type: 'screen' }>;
type Send = (m: ScreenMsg) => void;
type Listen = (h: (m: BusMessage) => void) => () => void;

const rid = () => Math.random().toString(36).slice(2, 10);

/** Browsers label display-capture tracks with ids ("window:1234:0") — name the kind of surface instead. */
function friendlyLabel(tr: MediaStreamTrack | undefined): string {
  if (!tr) return '';
  const kind = (tr.getSettings?.() as MediaTrackSettings & { displaySurface?: string })?.displaySurface;
  if (/\s/.test(tr.label) && tr.label.length < 80) return tr.label;       // a real title
  return kind === 'monitor' ? 'your screen' : kind === 'browser' ? 'a browser tab' : kind === 'window' ? 'a window' : 'a source';
}
const MAX_BITRATE = 30_000_000;
/** The Scene-tab preview's link (previewBridge.ts): a box a few hundred px wide drawn at 20 fps, so it gets a small stream. */
export const SEND_PREVIEW = { bitrate: 3_000_000, fps: 20, maxWidth: 1280 };
/** A page must stay "not drawing the window" this long before its encoder is paused (coming back is instant). */
export const WANT_OFF_MS = 3000;
/** A receiver says its current want again this often while it has a link (bus messages are fire-and-forget: Bus.send drops
 *  them while the socket is down, and one lost "yes" would leave the sender's encoder paused for good). */
export const WANT_REPEAT_MS = 2500;

/** Pure: the encoding one link gets. OBS pages keep the full stream (look unchanged); the preview gets the small one. */
export function sendEncoding(preview: boolean, srcWidth: number) {
  if (!preview) return { maxBitrate: MAX_BITRATE, maxFramerate: 60, scaleResolutionDownBy: 1, priority: 'high', networkPriority: 'high' };
  const scale = srcWidth > SEND_PREVIEW.maxWidth ? +(srcWidth / SEND_PREVIEW.maxWidth).toFixed(3) : 1;
  return { maxBitrate: SEND_PREVIEW.bitrate, maxFramerate: SEND_PREVIEW.fps, scaleResolutionDownBy: scale, priority: 'medium', networkPriority: 'medium' };
}

/** Pure: hysteresis for a yes/no. Yes is immediate; no counts only after `holdMs` of continuous no (so a short gap, like a
 *  camera cut or the screen sliding away, never pauses a stream that is about to be wanted again). Starts at yes. */
export class WantHold {
  private on = true;
  private noSince: number | null = null;
  constructor(private holdMs = WANT_OFF_MS) {}
  update(raw: boolean, now: number): boolean {
    if (raw) { this.noSince = null; this.on = true; }
    else { this.noSince ??= now; if (now - this.noSince >= this.holdMs) this.on = false; }
    return this.on;
  }
  get value() { return this.on; }
}

function preferCodecs(tr: RTCRtpTransceiver) {
  try {
    const caps = RTCRtpSender.getCapabilities?.('video')?.codecs ?? [];
    const rank = (mime: string) => (/h264/i.test(mime) ? 0 : /vp9/i.test(mime) ? 1 : /av1/i.test(mime) ? 2 : /vp8/i.test(mime) ? 3 : 9);
    const sorted = [...caps].sort((a, b) => rank(a.mimeType) - rank(b.mimeType));
    if (sorted.length) tr.setCodecPreferences(sorted);
  } catch { /* browser picks */ }
}

export interface ShareStatus {
  sharing: boolean;
  label: string;
  width: number;
  height: number;
  /** Sender side: encoder + measured fps / bitrate, why quality is limited (if it is). */
  encoder: string;
  encodeMs: number;
  sentFps: number;
  limited: string;
  /** Per OBS page. */
  receivers: { id: string; stats: ScreenRxStats | null; state: string }[];
  /** Estimated capture → on-screen delay in OBS (ms) — use it to line OBS audio up. */
  delayMs: number | null;
  /** Every connected link is paused (no page draws the window right now): the numbers above are the last measured. */
  idle?: boolean;
}

type SendPeer = {
  pc: RTCPeerConnection; stats: ScreenRxStats | null; at: number;
  sender: RTCRtpSender | null;
  /** What the page said last (default yes) and what the encoder is set to now. */
  want: boolean; active: boolean; busy: boolean;
};

export class ScreenShareSender {
  readonly id = `st-${rid()}`;
  stream: MediaStream | null = null;
  label = '';
  private peers = new Map<string, SendPeer>();
  private timer = 0;
  private last = { bytes: 0, frames: 0, encodeTime: 0, t: 0 };
  private lastPc: RTCPeerConnection | null = null;
  /** Sender-wide gate (the preview's link: nobody can see it) with the same hold as a page's want. */
  private visRaw = true;
  private visHold: WantHold;
  status: ShareStatus = { sharing: false, label: '', width: 0, height: 0, encoder: '', encodeMs: 0, sentFps: 0, limited: '', receivers: [], delayMs: null };
  onStatus: (s: ShareStatus) => void = () => {};

  constructor(private send: Send, listen: Listen, private enabled: () => boolean, private opts: { preview?: boolean; holdMs?: number } = {}) {
    this.visHold = new WantHold(opts.holdMs);
    listen((m) => { if (m.type === 'screen') this.onMsg(m); });
    this.timer = window.setInterval(() => void this.tick(), 1000);
  }

  /** Share this stream (null = stop). The track is marked for sharp text; each OBS page gets its own connection. */
  setStream(stream: MediaStream | null, label = '') {
    const known = [...this.peers.keys()];
    for (const id of known) this.close(id, true);
    this.stream = stream;
    const tr = stream?.getVideoTracks()[0];
    this.label = label || friendlyLabel(tr);
    const set = tr?.getSettings?.();
    this.status.width = set?.width ?? 0; this.status.height = set?.height ?? 0; this.status.sentFps = Math.round(set?.frameRate ?? 0);
    if (tr) { try { tr.contentHint = 'detail'; } catch { /* */ } }
    if (stream && this.enabled()) {
      for (const id of known) void this.offer(id);
      this.send({ type: 'screen', k: 'avail', from: this.id, label: this.label });
    } else if (!stream) this.send({ type: 'screen', k: 'bye', from: this.id });
    this.emit();
  }

  /** false = nobody can see this sender's picture (the studio preview is paused / scrolled away / hidden): its links pause
   *  after the hold; true resumes them at once. */
  setVisible(v: boolean) { this.visRaw = v; this.pollVisible(); }
  private pollVisible() {
    const was = this.visHold.value;
    if (this.visHold.update(this.visRaw, performance.now()) !== was) this.reconcile();
  }
  /** Bring every link's encoder in line with (page wants) AND (visible). Retried every tick if a call fails. */
  private reconcile() { for (const p of this.peers.values()) void this.applyActive(p); }
  private async applyActive(p: SendPeer) {
    const on = p.want && this.visHold.value;
    if (!p.sender || p.busy || p.active === on) return;
    p.busy = true;
    let done = false;
    try {
      // (encodings[0].active needs no renegotiation; switching it on makes the encoder send a key frame)
      const prm = p.sender.getParameters();
      if (prm.encodings?.length) { prm.encodings[0].active = on; await p.sender.setParameters(prm); p.active = on; done = true; }
    } catch { /* not negotiated yet, or raced with another change: the next tick tries again */ }
    p.busy = false;
    if (done && p.active !== (p.want && this.visHold.value)) void this.applyActive(p);   // (it changed again meanwhile)
  }

  private onMsg(m: ScreenMsg) {
    if (m.to && m.to !== this.id) return;
    if (m.k === 'hello') { if (this.stream && this.enabled() && !keepPeer(this.peers.get(m.from)?.pc)) void this.offer(m.from); } // (a repeated hello never restarts a live link: src/net/peerKeep.ts)
    else if (m.k === 'answer' && m.sdp) void this.peers.get(m.from)?.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch(() => this.close(m.from));
    else if (m.k === 'ice') { const p = this.peers.get(m.from); if (p && m.cand) void p.pc.addIceCandidate(m.cand).catch(() => {}); }
    else if (m.k === 'want') { const p = this.peers.get(m.from); if (p) { p.want = m.on !== false; void this.applyActive(p); } }
    else if (m.k === 'stats' && m.stats) { const p = this.peers.get(m.from); if (p) { p.stats = m.stats; p.at = performance.now(); } }
    else if (m.k === 'bye') this.close(m.from);
  }

  private async offer(to: string) {
    const stream = this.stream, track = stream?.getVideoTracks()[0];
    if (!stream || !track) return;
    this.close(to);   // (a fresh offer always starts as wanted: the page says "no" again right after its answer / on its next repeat)
    const pc = new RTCPeerConnection({ iceServers: [] });
    markBorn(pc);
    const tr = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
    this.peers.set(to, { pc, stats: null, at: performance.now(), sender: tr.sender, want: true, active: true, busy: false });
    preferCodecs(tr);
    pc.onicecandidate = (e) => this.send({ type: 'screen', k: 'ice', from: this.id, to, cand: e.candidate ? e.candidate.toJSON() : null });
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.close(to); this.emit(); };
    try {
      const p = tr.sender.getParameters();
      const preview = !!this.opts.preview;
      p.encodings = [{ ...(p.encodings?.[0] ?? {}), ...sendEncoding(preview, track.getSettings?.().width ?? this.status.width) } as RTCRtpEncodingParameters];
      (p as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = preview ? 'maintain-framerate' : 'maintain-resolution';
      await tr.sender.setParameters(p).catch(() => {});
      const off = await pc.createOffer();
      await pc.setLocalDescription(off);
      this.send({ type: 'screen', k: 'offer', from: this.id, to, sdp: pc.localDescription!.sdp, label: this.label });
    } catch (e) { console.warn('screen share offer', e); this.close(to); }
  }

  private close(id: string, keepBye = false) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    try { p.pc.close(); } catch { /* */ }
    if (!keepBye) this.emit();
  }

  private async tick() {
    if (!this.stream) { if (this.status.sharing) this.emit(); return; }
    // receivers that loaded before we started are woken up by 'avail'
    if (this.enabled()) this.send({ type: 'screen', k: 'avail', from: this.id, label: this.label });
    for (const [id, p] of this.peers) if (!p.stats && performance.now() - p.at > 8000 && p.pc.connectionState !== 'connected') this.close(id);
    this.pollVisible(); this.reconcile();
    // sender stats (first connected link that is sending; with every link paused the last numbers stay)
    const pc = [...this.peers.values()].find((x) => x.pc.connectionState === 'connected' && x.active)?.pc;
    if (pc) {
      if (pc !== this.lastPc) { this.lastPc = pc; this.last = { bytes: 0, frames: 0, encodeTime: 0, t: 0 }; }   // (counters are per link)
      try {
        const rep = await pc.getStats();
        rep.forEach((r) => {
          if (r.type !== 'outbound-rtp' || r.kind !== 'video') return;
          const t = performance.now();
          const frames = r.framesEncoded ?? 0, et = r.totalEncodeTime ?? 0;
          if (this.last.t && frames > this.last.frames) {
            this.status.sentFps = Math.round(((frames - this.last.frames) * 1000) / (t - this.last.t));
            this.status.encodeMs = +(((et - this.last.encodeTime) * 1000) / (frames - this.last.frames)).toFixed(1);
          }
          this.last = { bytes: r.bytesSent ?? 0, frames, encodeTime: et, t };
          this.status.encoder = `${r.encoderImplementation ?? '?'}${r.powerEfficientEncoder ? ' (hardware)' : ''}`;
          this.status.limited = r.qualityLimitationReason && r.qualityLimitationReason !== 'none' ? r.qualityLimitationReason : '';
          this.status.width = r.frameWidth ?? this.status.width; this.status.height = r.frameHeight ?? this.status.height;
        });
      } catch { /* */ }
    }
    this.emit();
  }

  private emit() {
    const recv = [...this.peers.entries()].map(([id, p]) => ({ id, stats: p.stats, state: p.pc.connectionState }));
    const live = recv.map((r) => r.stats).filter((s): s is ScreenRxStats => !!s);
    // capture (≈1 frame) + encode + jitter buffer + decode + the OBS render frame (≈1 frame at 60 fps)
    const fr = 1000 / Math.max(15, this.status.sentFps || 60);
    const delay = live.length ? Math.round(fr + this.status.encodeMs + Math.max(...live.map((s) => s.jitterMs + s.decodeMs)) + 1000 / 60) : null;
    const conn = [...this.peers.values()].filter((p) => p.pc.connectionState === 'connected');
    this.status = { ...this.status, sharing: !!this.stream, label: this.label, receivers: recv, delayMs: delay, idle: conn.length > 0 && conn.every((p) => !p.active) };
    this.onStatus(this.status);
  }

  dispose() { clearInterval(this.timer); for (const id of [...this.peers.keys()]) this.close(id); }
}

/** OBS output page side: receives the host studio's shared window. */
export class ScreenShareReceiver {
  readonly id = `rx-${rid()}`;
  private pc: RTCPeerConnection | null = null;
  private sender = '';
  stream: MediaStream | null = null;
  label = '';
  private timer = 0;
  private last = { bytes: 0, t: 0, jit: 0, emitted: 0, dec: 0, decoded: 0 };
  stats: ScreenRxStats | null = null;
  onStream: (s: MediaStream | null) => void = () => {};
  /** Does this page draw the window right now? (set by the OBS page; default yes = the stream always runs, as before) */
  private wantFn: () => boolean = () => true;
  private wantHold: WantHold;
  private sentWant = true;
  private wantTimer = 0;
  private wantAt = 0;   // when want was last put on the bus

  constructor(private send: Send, listen: Listen, holdMs = WANT_OFF_MS) {
    this.wantHold = new WantHold(holdMs);
    listen((m) => { if (m.type === 'screen') void this.onMsg(m); });
    this.hello();
    this.timer = window.setInterval(() => void this.tick(), 1000);
    this.wantTimer = window.setInterval(() => this.pollWant(), 250);
  }

  /** The page says when it draws the window (not in Talk, not while its preview is parked). The sender pauses this page's
   *  encoder after WANT_OFF_MS of "no" and resumes it at once on "yes"; the last picture stays on the screen meanwhile. */
  setWantSource(fn: () => boolean) { this.wantFn = fn; }
  private pollWant() {
    let raw = true;
    try { raw = this.wantFn(); } catch { /* keep asking for the stream */ }
    const v = this.wantHold.update(raw, performance.now());
    if (v !== this.sentWant) { this.sentWant = v; this.sendWant(); }
  }
  private sendWant() { if (this.sender) { this.wantAt = performance.now(); this.send({ type: 'screen', k: 'want', from: this.id, to: this.sender, on: this.sentWant }); } }
  /** Say the current want again now (src/output.ts calls it when the bus reconnects: what was sent while it was down is lost). */
  resendWant() { this.sendWant(); }

  private hello() { this.send({ type: 'screen', k: 'hello', from: this.id }); }

  private async onMsg(m: ScreenMsg) {
    if (m.to && m.to !== this.id) return;
    if (m.k === 'avail' && !this.pc) this.hello();
    else if (m.k === 'bye' && (!this.sender || m.from === this.sender)) this.drop();
    else if (m.k === 'ice' && m.from === this.sender && m.cand) void this.pc?.addIceCandidate(m.cand).catch(() => {});
    else if (m.k === 'offer' && m.sdp) {
      this.drop(false);
      this.sender = m.from;
      this.label = m.label ?? '';
      const pc = (this.pc = new RTCPeerConnection({ iceServers: [] }));
      pc.onicecandidate = (e) => this.send({ type: 'screen', k: 'ice', from: this.id, to: m.from, cand: e.candidate ? e.candidate.toJSON() : null });
      pc.ontrack = (e) => {
        // smallest possible jitter buffer: it's a LAN of one machine
        try { (e.receiver as RTCRtpReceiver & { jitterBufferTarget?: number; playoutDelayHint?: number }).jitterBufferTarget = 0; } catch { /* */ }
        try { (e.receiver as RTCRtpReceiver & { playoutDelayHint?: number }).playoutDelayHint = 0; } catch { /* */ }
        this.stream = e.streams[0] ?? new MediaStream([e.track]);
        e.track.addEventListener('ended', () => this.drop());
        this.onStream(this.stream);
      };
      pc.onconnectionstatechange = () => {
        if (pc !== this.pc) return;
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') { this.drop(); setTimeout(() => this.hello(), 1000); }
      };
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        this.send({ type: 'screen', k: 'answer', from: this.id, to: m.from, sdp: pc.localDescription!.sdp });
        this.sendWant();                               // (a new link starts on at the sender: always tell it what this page wants now)
      } catch (e) { console.warn('screen share answer', e); this.drop(); }
    }
  }

  private drop(notify = true) {
    const had = !!this.stream;
    try { this.pc?.close(); } catch { /* */ }
    this.pc = null; this.stream = null; this.sender = ''; this.stats = null;
    if (notify && had) this.onStream(null);
  }

  private async tick() {
    const pc = this.pc;
    // said again every second while paused (a sender that restarted starts at "wanted") and every WANT_REPEAT_MS while wanted
    // (a "yes" that Bus.send dropped must not leave the sender's encoder paused for good)
    if (this.sender && (!this.sentWant || performance.now() - this.wantAt >= WANT_REPEAT_MS)) this.sendWant();
    if (!pc || pc.connectionState !== 'connected') return;
    try {
      const rep = await pc.getStats();
      let codec = '';
      const codecs = new Map<string, string>();
      rep.forEach((r) => { if (r.type === 'codec') codecs.set(r.id, r.mimeType); });
      rep.forEach((r) => {
        if (r.type !== 'inbound-rtp' || r.kind !== 'video') return;
        const t = performance.now(), L = this.last;
        const jit = r.jitterBufferDelay ?? 0, emitted = r.jitterBufferEmittedCount ?? 0, dec = r.totalDecodeTime ?? 0, decoded = r.framesDecoded ?? 0;
        codec = codecs.get(r.codecId) ?? '';
        this.stats = {
          fps: Math.round(r.framesPerSecond ?? 0), width: r.frameWidth ?? 0, height: r.frameHeight ?? 0,
          kbps: L.t ? Math.round((((r.bytesReceived ?? 0) - L.bytes) * 8) / (t - L.t)) : 0,
          jitterMs: emitted > L.emitted ? +(((jit - L.jit) * 1000) / (emitted - L.emitted)).toFixed(1) : this.stats?.jitterMs ?? 0,
          decodeMs: decoded > L.decoded ? +(((dec - L.dec) * 1000) / (decoded - L.decoded)).toFixed(1) : this.stats?.decodeMs ?? 0,
          framesDropped: r.framesDropped ?? 0, decoder: r.decoderImplementation ?? '', hw: !!r.powerEfficientDecoder, codec,
        };
        this.last = { bytes: r.bytesReceived ?? 0, t, jit, emitted, dec, decoded };
      });
      if (this.stats && this.sender) this.send({ type: 'screen', k: 'stats', from: this.id, to: this.sender, stats: this.stats });
    } catch { /* */ }
  }

  dispose() { clearInterval(this.timer); clearInterval(this.wantTimer); this.send({ type: 'screen', k: 'bye', from: this.id, to: this.sender || undefined }); this.drop(false); }
}
