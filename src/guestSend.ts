// Guest browser source, the SENDER (spec: docs/GUEST_BROWSER_SOURCE.md sections 4, 5.2, 7, 8, 9): this runs in the page the
// helper starts in a headless, muted system browser (output.html?gsSend=1&gst=<token>, server/guestFeed.ts). It shows only the
// avatar (src/output.ts forces Classic, solo, bust, low graphics, 30 fps, no room, no react feed), and sends the finished
// picture, packed with its transparency (src/guestSendPack.ts), to the other streamer's OBS Browser Source over WebRTC.
//   * signalling: the existing phone link on the relay (this page is its `studio` socket, every OBS page a `phone` socket
//     with the peer id key + instance); the viewer OFFERS (recvonly video + the `gs` data channel), this page ANSWERS;
//   * nothing is drawn unless a viewer is connected and visible (`page.run`); the performance governor (src/guestSendGov.ts)
//     steps the picture down when the card is busy, so the game and the face tracking come first;
//   * the link lock (first OBS wins, others knock, Allow / Block), the two-viewer cap and the side-band status
//     (shared/guestFeed.ts viewerDecision, makeSide) are decided here; the helper only shows the question and answers it;
//   * with TURN available both ends use iceTransportPolicy 'relay' (icePolicy), so neither learns the other's address;
//   * silent: no audio track is ever added or accepted, this page creates no AudioContext.
// The pure rules below (policy, SDP reading, codec ranking, reports) run under Node: tools/guestfeed_send_unit.ts.
import {
  GS_CHANNEL, GS_HANDSHAKE_MS, GS_MAX_VIEWERS, GS_BLOCK_MS, GS_KNOCK_MS, GS_NONCE_ATTR, GS_NONCE_RX, GS_PRIV_RX, GS_PUB_RX, GS_REPORT_EVERY_MS, GS_RETRY_MS, GS_STATS_EVERY_MS,
  PHONE_LINK_ID_RX, allowKey, asQuality, cleanRelay, clampDelay, encodeMsg, gsBusVerify, gsSignAnswer, gsSocketUrl, gsTier, icePolicy, makeSide, newKnockId, parseViewerPeer,
  pickReplaced, privacyOf, routeOf, sanitizeBusMsg, sanitizeName, sanitizeToSender, sdpAttr, sdpWithoutAttr, sideBandOf, viewerDecision, viewerLabel,
  GS_KEY_RX, type GsAct, type GsBusMsg, type GsReport, type GsRoute, type GsSenderConfig, type GsSideState, type GsTier, type GsToViewer, type GsViewerInfo, type GsViewerRef,
} from '../shared/guestFeed.ts';
import { GsGovGlue, ratesOf, readStats, type GsStatsRead } from './guestSendGov.ts';
import { createPacker, type GsPacker, type GsSnapshot } from './guestSendPack.ts';

// ================================================================ pure rules (no DOM; unit tested)

// ---------------------------------------------------------------- SDP (what the viewer's offer says)
export interface GsSdpSection { kind: string; port: number; direction: 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive'; /** lower-case mime types, e.g. video/h264 */ codecs: string[] }
export function parseSdp(sdp: string): GsSdpSection[] {
  const out: GsSdpSection[] = [];
  let cur: GsSdpSection | null = null;
  for (const line of String(sdp).split(/\r?\n/)) {
    const m = /^m=(\w+)\s+(\d+)/.exec(line);
    if (m) { cur = { kind: m[1], port: Number(m[2]), direction: 'sendrecv', codecs: [] }; out.push(cur); continue; }
    if (!cur) continue;
    const d = /^a=(sendrecv|sendonly|recvonly|inactive)\s*$/.exec(line);
    if (d) { cur.direction = d[1] as GsSdpSection['direction']; continue; }
    const r = /^a=rtpmap:\d+\s+([A-Za-z0-9._-]+)\/\d+/.exec(line);
    if (r) cur.codecs.push(`${cur.kind}/${r[1].toLowerCase()}`);
  }
  return out;
}
export interface GsOfferInfo { video: number; audio: number; videoRecvonly: boolean; codecs: string[] }
export function offerInfo(sdp: string): GsOfferInfo {
  const s = parseSdp(sdp), v = s.filter((x) => x.kind === 'video' && x.port !== 0);
  return { video: v.length, audio: s.filter((x) => x.kind === 'audio').length, videoRecvonly: v.length > 0 && v.every((x) => x.direction === 'recvonly'), codecs: [...new Set(v.flatMap((x) => x.codecs))] };
}

// ---------------------------------------------------------------- codecs and the encoder
/** H.264 (packetization-mode 1) > VP8 > VP9 > AV1. H.264 is first (hardware encode); without it VP8 beats VP9 because its software
 *  encode costs far less CPU on a gaming PC (this differs on purpose from src/streamPcSend.ts). Anything else last. */
export const codecRank = (c: { mimeType: string; sdpFmtpLine?: string }): number =>
  /h264/i.test(c.mimeType) ? (/packetization-mode=1/.test(c.sdpFmtpLine ?? '') ? 0 : 1) : /vp8/i.test(c.mimeType) ? 2 : /vp9/i.test(c.mimeType) ? 3 : /av1/i.test(c.mimeType) ? 4 : 9;
/** The sender's codecs in our order; those the viewer's offer does not carry go to the end (rtx and friends stay). */
export function rankCodecs<T extends { mimeType: string; sdpFmtpLine?: string }>(caps: readonly T[], offered: readonly string[] = []): T[] {
  const has = (c: T) => offered.length === 0 || offered.includes(c.mimeType.toLowerCase());
  return [...caps].map((c, i) => ({ c, i })).sort((a, b) => (Number(!has(a.c)) - Number(!has(b.c))) || (codecRank(a.c) - codecRank(b.c)) || (a.i - b.i)).map((x) => x.c);
}
/** The encoder's caps for a tier. `scaleResolutionDownBy: 1` = the packed frame leaves at the size the tier made it (the side-by-side pack needs
 *  every pixel: a frame the encoder shrank is blown up again by the viewer and its alpha edges blur, AC14 / AC19 / AC11). */
export const encoderParams = (t: Pick<GsTier, 'kbps' | 'fps'>) => ({ maxBitrate: t.kbps * 1000, maxFramerate: t.fps, scaleResolutionDownBy: 1 });
/** What the encoder gives up first when it is short of CPU or bandwidth: frames per second, never resolution. (It used to be
 *  'maintain-framerate' + contentHint 'motion', which is the opposite: the browser then cut the frame to 75 percent, 1452x405 instead of
 *  1936x540, 2892x810 instead of 3856x1080. The tier's own fps floor and the governor, src/guestSendGov.ts, are what step the picture down.) */
export const ENCODER_DEGRADATION = 'maintain-resolution';

// ---------------------------------------------------------------- ICE: nothing but relay candidates when the policy is 'relay'
export function candidateType(candidate: unknown): string {
  const s = typeof candidate === 'string' ? candidate : candidate && typeof candidate === 'object' && typeof (candidate as { candidate?: unknown }).candidate === 'string' ? (candidate as { candidate: string }).candidate : '';
  return /\styp\s+(host|srflx|prflx|relay)\b/.exec(s)?.[1] ?? '';
}
/** May this local candidate go through signalling? (With policy 'relay' the browser makes only relay ones; this is the belt and braces.) */
export const candidateAllowed = (policy: 'relay' | 'all', candidate: unknown): boolean => policy === 'all' || candidateType(candidate) === 'relay';

// ---------------------------------------------------------------- the link lock, knocks and blocks (section 7)
export interface GsKnock { kid: string; key: string; label: string; at: number; peers: Set<string> }
export type GsAdmit =
  | { act: 'accept'; lockChanged: boolean }
  | { act: 'replace'; victim: GsViewerRef | null; lockChanged: boolean }
  | { act: 'knock'; fresh: boolean; kid: string }
  | { act: 'knockWait' | 'blocked' | 'full' };
export interface GsAnswer { allow: boolean; key: string; peers: string[] }
export class GsLinkPolicy {
  lock: string[];
  readonly blocked = new Map<string, number>();
  knock: GsKnock | null = null;
  constructor(lock: readonly string[] = [], private newKid: () => string = () => newKnockId()) { this.lock = lock.filter((k) => GS_KEY_RX.test(k)).slice(0, GS_MAX_VIEWERS); }
  private keysOf = (vs: readonly GsViewerRef[]) => vs.map((v) => v.key);
  /** Judge an offer from `peer`. `viewers` = every page that holds a place now (connecting or connected). Updates the lock and the open question. */
  admit(peer: string, viewers: readonly GsViewerRef[], now: number): GsAdmit {
    const p = parseViewerPeer(peer);
    for (const [k, until] of this.blocked) if (until <= now) this.blocked.delete(k);
    const d = viewerDecision({ peer, lock: this.lock, viewers, blocked: this.blocked, knocking: this.knock?.key ?? null, now });
    if (!p) return { act: 'blocked' };
    const lockIt = () => { if (!d.lock) return false; this.lock = allowKey(this.lock, p.key, this.keysOf(viewers)); return true; };
    switch (d.act as GsAct) {
      case 'accept': return { act: 'accept', lockChanged: lockIt() };
      case 'replace': { const victim = pickReplaced(viewers.filter((v) => v.peer !== peer), p.key); return { act: 'replace', victim, lockChanged: lockIt() }; }
      case 'knock': {
        if (this.knock) { this.knock.peers.add(peer); return { act: 'knock', fresh: false, kid: this.knock.kid }; }
        this.knock = { kid: this.newKid(), key: p.key, label: viewerLabel(true, p.key), at: now, peers: new Set([peer]) };
        return { act: 'knock', fresh: true, kid: this.knock.kid };
      }
      case 'knockWait': return { act: 'knockWait' };
      case 'blocked': return { act: 'blocked' };
      default: return { act: 'full' };
    }
  }
  /** Allow / Block for the open question (null = no such question: stale click). Block refuses the key for GS_BLOCK_MS. */
  answer(kid: string, allow: boolean, connectedKeys: readonly string[], now: number): GsAnswer | null {
    const k = this.knock;
    if (!k || k.kid !== kid) return null;
    this.knock = null;
    if (allow) { this.lock = allowKey(this.lock, k.key, connectedKeys); this.blocked.delete(k.key); } else this.blocked.set(k.key, now + GS_BLOCK_MS);
    return { allow, key: k.key, peers: [...k.peers] };
  }
  /** No answer in GS_KNOCK_MS counts as Block. */
  expire(now: number, connectedKeys: readonly string[]): GsAnswer | null {
    const k = this.knock;
    return k && now - k.at >= GS_KNOCK_MS ? this.answer(k.kid, false, connectedKeys, now) : null;
  }
  /** A page that waited for the answer went away. The question stays (another page of that OBS may come back). */
  forget(peer: string) { this.knock?.peers.delete(peer); }
  /** New link / turned off: no lock, no blocks, no question. */
  clear() { this.lock = []; this.blocked.clear(); this.knock = null; }
  knockInfo(): { kid: string; label: string } | null { return this.knock ? { kid: this.knock.kid, label: this.knock.label } : null; }
}

// ---------------------------------------------------------------- state and report
export interface GsViewerLive { peer: string; key: string; since: number; open: boolean; visible: boolean; obs: boolean; fps: number; kbps: number; codec: string; route: GsRoute; rttMs: number | null }
/** A viewer that sent nothing (stats come every GS_STATS_EVERY_MS) for 3 x that is gone, whatever its connection state says. */
export const GS_SILENT_DROP_MS = 3 * GS_STATS_EVERY_MS;
/** Zero draws unless at least one connected viewer is visible. */
export const gateRun = (vs: readonly Pick<GsViewerLive, 'open' | 'visible'>[]): boolean => vs.some((v) => v.open && v.visible);
export function senderState(o: { err: GsReport['err']; ready: boolean; packer: boolean; viewers: readonly Pick<GsViewerLive, 'open' | 'visible'>[] }): GsReport['state'] {
  const connected = o.viewers.filter((v) => v.open);
  if (o.err && !connected.length) return 'error';
  if (connected.length) return connected.some((v) => v.visible) ? 'live' : 'paused';
  if (!o.packer) return 'boot';
  return o.ready ? 'idle' : 'signalling';
}
export const viewerInfos = (vs: readonly GsViewerLive[]): GsViewerInfo[] =>
  vs.filter((v) => v.open).slice(0, GS_MAX_VIEWERS).map((v) => ({ id: v.peer, label: viewerLabel(v.obs, v.key), since: v.since, fps: v.fps, kbps: v.kbps, codec: v.codec, route: v.route, rttMs: v.rttMs, visible: v.visible }));
export function buildReport(o: { gen: number; err: GsReport['err']; ready: boolean; packer: boolean; tier: GsTier['name']; ice: unknown; lock: readonly string[]; knock: { kid: string; label: string } | null; viewers: readonly GsViewerLive[]; renderMs: number; packMs: number }): GsReport {
  return {
    gen: o.gen, state: senderState(o), err: o.err, tier: o.tier, privacy: o.ready ? privacyOf(o.ice) : 'unknown',
    lock: [...o.lock], knock: o.knock, viewers: viewerInfos(o.viewers), renderMs: o.renderMs, packMs: o.packMs,
  };
}

/** GET /api/guestfeed/sender -> a config, or null on anything that is not one (the id and relay are checked like the viewer checks them). */
export function sanitizeSenderConfig(raw: unknown): GsSenderConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const relay = cleanRelay(o.relay), id = typeof o.id === 'string' ? o.id : '';
  if (!relay || !PHONE_LINK_ID_RX.test(id)) return null;
  return {
    gen: typeof o.gen === 'number' && Number.isFinite(o.gen) ? Math.max(0, Math.min(1e9, Math.round(o.gen))) : 0, relay, id, q: asQuality(o.q), delayMs: clampDelay(o.delayMs), name: sanitizeName(o.name),
    lock: (Array.isArray(o.lock) ? o.lock : []).filter((k): k is string => typeof k === 'string' && GS_KEY_RX.test(k)).slice(0, GS_MAX_VIEWERS),
    // the link's signing key pair (server/guestFeed.ts): without it this page answers nobody
    ...(typeof o.pk === 'string' && GS_PUB_RX.test(o.pk) && typeof o.sk === 'string' && GS_PRIV_RX.test(o.sk) ? { pk: o.pk, sk: o.sk } : {}),
  };
}
/** The `gst` token in the page address: 32 hex characters (made by the helper at browser start). */
export const GST_RX = /^[a-f0-9]{32}$/;

// ================================================================ the page

/** What src/output.ts shares with this module (it checks `run` in its render loop and calls `frame` after each drawn frame). */
export interface GsPage {
  /** true while at least one connected viewer is visible: the render loop draws only then */
  run: boolean;
  /** frame-rate cap of the tier (the render loop takes the lower of this and its own cap) */
  fps: number;
  /** called by the render loop right after a drawn frame (ms the frame took): packs it and sends it */
  frame: ((renderMs: number) => void) | null;
  /** wake the render loop now (it looks only ten times a second while nothing is drawn) */
  kick: () => void;
}
export interface GsEnv {
  page: GsPage;
  /** the stage's canvas (its CSS size is set to the tier's picture size) */
  canvas: HTMLCanvasElement;
  /** the local bus (helper -> this page and the studio's health beacon) */
  on(h: (m: Record<string, unknown>) => void): void;
  /** the page address (tests pass their own) */
  search?: string;
}
export interface GsSendHandle { frames(): number; stats(): Record<string, unknown>; tier(): string; snapshot(o?: { b64?: boolean }): unknown }

interface SV extends GsViewerLive {
  inst: string;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  born: number; lastHeard: number; discAt: number;
  remoteSet: boolean; early: RTCIceCandidateInit[];
  tx: RTCRtpTransceiver | null;
  prev: GsStatsRead | null; prevAt: number;
  limit: string; encodeMs: number;
  /** what the encoder reports (getStats outbound-rtp): the frame size it really sends, its implementation, the codec */
  encW: number; encH: number; impl: string;
  /** the offer this connection answers, our answer to it and the candidates sent so far: a repeat of the same offer is answered from these */
  offerSdp: string; answerSdp: string; sentCands: RTCIceCandidateInit[];
}
interface Held { sdp: string; cands: RTCIceCandidateInit[]; at: number }

const now = () => performance.now();
const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };

class GuestSender implements GsSendHandle {
  private cfg: GsSenderConfig | null = null;
  private token: string;
  private stamp: boolean;
  private ws: WebSocket | null = null;
  private ready = false; private ice: unknown[] = []; private err: GsReport['err'] = '';
  private retry = 0; private retryTimer = 0;
  private packer: GsPacker | null = null;
  private glue = new GsGovGlue(720);
  private policy = new GsLinkPolicy();
  private viewers = new Map<string, SV>();
  private held = new Map<string, Held>();
  private dead = false;
  private gen = 0;
  private offers: GsOfferInfo[] = [];
  private lastReportAt = 0;

  constructor(private env: GsEnv) {
    const qs = new URLSearchParams(env.search ?? location.search);
    this.token = qs.get('gst') ?? '';
    this.stamp = qs.get('gsStamp') === '1';
    this.packer = createPacker(gsTier(720, 'full'));
    if (!this.packer) this.err = 'gl';
    env.page.frame = (renderMs) => this.frame(renderMs);
    env.on((m) => { try { this.onBus(m); } catch (e) { console.warn('[guest-send] bus', e); } });
    setInterval(() => this.tick(), 250);
    setInterval(() => void this.statsAndReport(), GS_REPORT_EVERY_MS);
    window.addEventListener('pagehide', () => { for (const v of this.viewers.values()) this.byeTo(v.peer); });
    void this.boot();
  }

  // ---------------------------------------------------------------- helper (config + reports)
  private headers(extra: Record<string, string> = {}) { return { 'x-vtp-gs': this.token, ...extra }; }
  private async fetchConfig(): Promise<GsSenderConfig | null> {
    try {
      const ac = new AbortController(), t = setTimeout(() => ac.abort(), 8000);
      // (this page only runs in VTube Pro's own headless browser, started by VTube Pro)
      const r = await fetch('/api/guestfeed/sender', { headers: this.headers(), cache: 'no-store', signal: ac.signal }).finally(() => clearTimeout(t));
      return r.ok ? sanitizeSenderConfig(await r.json()) : null;
    } catch { return null; }
  }
  private async boot() {
    if (!GST_RX.test(this.token)) { this.err = 'server'; return; }
    for (let i = 0; !this.dead; i++) {
      const c = await this.fetchConfig();
      if (c) { this.applyConfig(c); return; }
      this.err = 'server';
      await new Promise((r) => setTimeout(r, GS_RETRY_MS[Math.min(i, GS_RETRY_MS.length - 1)]));
    }
  }
  /** The helper changed something (bus {type:'gs',k:'cfg'}): read it again. A turned-off link stays dead. */
  private async refetch() {
    const c = await this.fetchConfig();
    if (c) this.applyConfig(c);
  }
  private applyConfig(c: GsSenderConfig) {
    const prev = this.cfg;
    this.gen = c.gen;
    if (prev && (prev.id !== c.id || prev.relay !== c.relay)) {
      // a replaced link: the old one's viewers are told it is gone first
      this.notifyOff();
      this.policy = new GsLinkPolicy(c.lock);
    } else if (!prev) this.policy = new GsLinkPolicy(c.lock);
    this.cfg = c;
    this.err = this.err === 'server' ? '' : this.err;
    if (prev?.q !== c.q) this.glue.setQuality(c.q);
    this.applyTier();
    if (prev && prev.id === c.id && prev.relay === c.relay && (prev.delayMs !== c.delayMs || prev.name !== c.name || prev.q !== c.q)) this.sendCfgAll();
    if (this.dead || !prev || prev.id !== c.id || prev.relay !== c.relay) { this.dead = false; this.openSocket(); }
  }
  private async statsAndReport() {
    const t = now();
    await Promise.all([...this.viewers.values()].filter((v) => v.open).map((v) => this.readViewerStats(v, t)));
    const enc = [...this.viewers.values()].filter((v) => v.open);
    if (enc.length) this.glue.onEncoder({ encodeMs: Math.max(...enc.map((v) => v.encodeMs)), limit: enc.some((v) => v.limit === 'cpu') ? 'cpu' : '' }, t);
    this.report();
  }
  private report() {
    if (!this.cfg || !GST_RX.test(this.token)) return;   // (nothing to report before VTube Pro has given this page its link)
    const t = now();
    if (t - this.lastReportAt < 220) return;
    this.lastReportAt = t;
    const body = buildReport({ gen: this.gen, err: this.err, ready: this.ready, packer: !!this.packer, tier: this.glue.tier.name, ice: this.ice, lock: this.policy.lock, knock: this.policy.knockInfo(), viewers: [...this.viewers.values()], renderMs: this.glue.renderMs, packMs: this.packer?.packMs ?? 0 });
    void fetch('/api/guestfeed/report', { method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify(body), cache: 'no-store' }).catch(() => {});
  }

  // ---------------------------------------------------------------- relay socket
  private openSocket() {
    const c = this.cfg;
    if (!c || this.dead) return;
    clearTimeout(this.retryTimer);
    try { this.ws?.close(); } catch { /* closed */ }
    let ws: WebSocket;
    try { ws = new WebSocket(gsSocketUrl(c.relay, c.id, 'sender')); } catch { this.err = 'server'; this.scheduleReopen(); return; }
    this.ws = ws;
    let gotReady = false, busy = false;
    ws.onmessage = (e) => {
      if (this.ws !== ws || typeof e.data !== 'string' || e.data.length > 40_000) return;
      let m: Record<string, unknown>;
      try { m = JSON.parse(e.data) as Record<string, unknown>; } catch { return; }
      if (m.t === 'ready') { gotReady = true; this.retry = 0; this.ready = true; this.err = this.err === 'gl' ? 'gl' : ''; this.ice = (Array.isArray(m.ice) ? m.ice : []).filter((s) => s && typeof s === 'object').slice(0, 8); this.report(); }
      else if (m.t === 'busy') busy = true;
      else try { this.onRelay(m); } catch (err) { console.warn('[guest-send] relay message', err); }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null; this.ready = false;
      if (this.dead) return;
      if (busy) this.err = 'busy'; else if (!gotReady && this.err !== 'gl') this.err = 'server';
      this.scheduleReopen();
    };
    ws.onerror = () => { /* onclose follows */ };
  }
  private scheduleReopen() {
    const d = GS_RETRY_MS[Math.min(this.retry++, GS_RETRY_MS.length - 1)];
    clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.openSocket(), d);
  }
  private wsSend(m: Record<string, unknown>) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); }
  private signal(to: string, data: Record<string, unknown>) { this.wsSend({ t: 'signal', to, data }); }
  private side(to: string, s: GsSideState) { this.signal(to, makeSide(s)); }
  private byeTo(to: string) { this.wsSend({ t: 'bye', to }); }

  private onRelay(m: Record<string, unknown>) {
    const peer = typeof m.from === 'string' ? m.from : '';
    if (m.t === 'peer') {
      // (a connected page that closed its relay socket is fine: it talks over the data channel now)
      if (m.here === false && peer) { const v = this.viewers.get(peer); if (v && !v.open) this.drop(peer, false); this.held.delete(peer); this.policy.forget(peer); }
      return;
    }
    if (m.t === 'bye') { if (peer) { this.drop(peer, false); this.held.delete(peer); this.policy.forget(peer); } return; }
    if (m.t !== 'signal' || !m.data || typeof m.data !== 'object') return;
    const d = m.data as { sdp?: { type?: unknown; sdp?: unknown }; candidate?: unknown };
    if (d.sdp && d.sdp.type === 'offer' && typeof d.sdp.sdp === 'string') { void this.onOffer(peer, d.sdp.sdp); return; }
    if ('candidate' in d && !sideBandOf(d.candidate) && d.candidate && typeof d.candidate === 'object') this.onCandidate(peer, d.candidate as RTCIceCandidateInit);
  }

  // ---------------------------------------------------------------- offers and the lock
  private refs(): GsViewerRef[] { return [...this.viewers.values()].map((v) => ({ peer: v.peer, key: v.key, at: v.lastHeard })); }
  private connectedKeys() { return [...this.viewers.values()].filter((v) => v.open).map((v) => v.key); }
  private async onOffer(peer: string, sdp: string) {
    if (this.dead || sdp.length > 16_000) return;
    const parsed = parseViewerPeer(peer);
    if (!parsed) { this.side(peer, 'blocked'); this.byeTo(peer); return; }   // (not a viewer page of ours)
    if (!this.packer || !this.cfg || !this.ready) { this.side(peer, 'wait'); return; }
    // Every answer is signed (shared/guestFeed.ts gsSignAnswer), and the signature needs the link's key and the viewer's nonce: an offer without one
    // (an older viewer page) or a config without a key gets no answer at all, never an unsigned one.
    const nonce = sdpAttr(sdp, GS_NONCE_ATTR);
    if (!this.cfg.pk || !this.cfg.sk || !nonce || !GS_NONCE_RX.test(nonce)) { this.side(peer, 'wait'); return; }
    // The viewer sends the SAME offer again while it waits (500 ms, 1 s, then every 2 s). That is not a new connection: keep the one
    // we have and say the answer again (rebuilding it would kill a connection the viewer is just about to use).
    const same = this.viewers.get(peer);
    if (same && same.offerSdp === sdp) { this.repeatAnswer(same); return; }
    const t = now();
    const adm = this.policy.admit(peer, this.refs(), t);
    switch (adm.act) {
      case 'blocked': this.side(peer, 'blocked'); this.byeTo(peer); return;
      case 'full': this.side(peer, 'full'); this.byeTo(peer); return;
      case 'knockWait': this.side(peer, 'ask'); return;
      case 'knock': {
        const h = this.held.get(peer);
        this.held.set(peer, { sdp, cands: h?.cands ?? [], at: t });
        this.side(peer, 'ask');
        if (adm.fresh) this.lastReportAt = 0;
        this.report();
        return;
      }
      case 'replace':
        if (adm.victim) { this.byeTo(adm.victim.peer); this.drop(adm.victim.peer, false); }
        break;
      default: break;
    }
    if ('lockChanged' in adm && adm.lockChanged) { this.lastReportAt = 0; this.report(); }
    await this.accept(peer, parsed, sdp, this.held.get(peer)?.cands ?? []);
    this.held.delete(peer);
  }
  /** The same offer again: send the stored answer and the candidates gathered so far (nothing yet = the first answer is still being made and goes out by itself). */
  private repeatAnswer(v: SV) {
    if (!v.answerSdp) return;
    this.signal(v.peer, { sdp: { type: 'answer', sdp: v.answerSdp } });
    for (const c of v.sentCands) this.signal(v.peer, { candidate: c });
  }
  private onCandidate(peer: string, c: RTCIceCandidateInit) {
    const v = this.viewers.get(peer);
    if (v) { if (v.remoteSet) void v.pc.addIceCandidate(c).catch(() => {}); else if (v.early.length < 64) v.early.push(c); return; }
    const h = this.held.get(peer);
    if (h && h.cands.length < 64) h.cands.push(c);
  }
  /** The user pressed Allow / Block (bus {type:'gs',k:'decide'}), or nobody answered in time. */
  private resolveKnock(a: GsAnswer) {
    for (const peer of a.peers) {
      const h = this.held.get(peer);
      // Allow: the offer that was kept is judged again (its key holds the lock now, so it is accepted); no offer kept = the page asks again by itself
      if (a.allow) { if (h) void this.onOffer(peer, h.sdp); }
      else { this.held.delete(peer); this.side(peer, 'blocked'); this.byeTo(peer); }
    }
    this.lastReportAt = 0; this.report();
  }

  // ---------------------------------------------------------------- one viewer
  private async accept(peer: string, p: { key: string; inst: string }, sdp: string, early: RTCIceCandidateInit[]) {
    const packer = this.packer!;
    const info = offerInfo(sdp);
    this.offers.push(info); if (this.offers.length > 8) this.offers.shift();
    if (!info.video) { this.byeTo(peer); return; }
    this.drop(peer, false);                       // (a fresh offer from the same page: its old connection goes)
    const policy = icePolicy(this.ice);
    let pc: RTCPeerConnection;
    try { pc = new RTCPeerConnection({ iceServers: this.ice as RTCIceServer[], iceTransportPolicy: policy }); } catch { this.side(peer, 'wait'); return; }
    const t = now();
    const v: SV = { peer, key: p.key, inst: p.inst, pc, dc: null, born: t, lastHeard: t, discAt: 0, since: Date.now(), open: false, visible: false, obs: false, fps: 0, kbps: 0, codec: '', route: 'unknown', rttMs: null, remoteSet: false, early: [...early], tx: null, prev: null, prevAt: 0, limit: '', encodeMs: 0, encW: 0, encH: 0, impl: '', offerSdp: sdp, answerSdp: '', sentCands: [] };
    this.viewers.set(peer, v);
    pc.onicecandidate = (e) => {
      if (!e.candidate || !candidateAllowed(policy, e.candidate)) return;
      const cj = e.candidate.toJSON();
      if (v.sentCands.length < 32) v.sentCands.push(cj);
      if (v.answerSdp) this.signal(peer, { candidate: cj });   // (before the signed answer is out, the viewer would drop it: they follow the answer)
    };
    pc.ondatachannel = (e) => this.onChannel(v, e.channel);
    pc.onconnectionstatechange = () => {
      if (this.viewers.get(peer) !== v) return;
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed') this.drop(peer, false);
      else if (s === 'disconnected') v.discAt = v.discAt || now(); else v.discAt = 0;
    };
    const stale = () => this.viewers.get(peer) !== v;
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: sdpWithoutAttr(sdp, GS_NONCE_ATTR) });
      if (stale()) return;
      let video: RTCRtpTransceiver | null = null;
      for (const tr of pc.getTransceivers()) {
        // (silent, and one picture: every audio line and any second video line is refused)
        if (tr.receiver.track.kind === 'video' && !video) video = tr;
        else { try { tr.stop(); } catch { tr.direction = 'inactive'; } }
      }
      if (!video) throw new Error('no video line');
      v.tx = video;
      video.direction = 'sendonly';
      await video.sender.replaceTrack(packer.track);
      try { video.sender.setStreams(packer.stream); } catch { /* optional */ }
      try { video.setCodecPreferences(rankCodecs(RTCRtpSender.getCapabilities('video')?.codecs ?? [], info.codecs)); } catch { /* the browser picks */ }
      v.remoteSet = true;
      for (const c of v.early.splice(0)) void pc.addIceCandidate(c).catch(() => {});
      const answer = await pc.createAnswer();
      if (stale()) return;
      await pc.setLocalDescription(answer);
      if (stale()) return;
      const c = this.cfg;
      const signed = c?.pk && c.sk ? await gsSignAnswer({ pk: c.pk, sk: c.sk }, { id: c.id, peer, offerSdp: sdp, answerSdp: pc.localDescription!.sdp }) : null;
      if (stale()) return;
      if (!signed) throw new Error('the answer could not be signed');
      v.answerSdp = signed;
      this.signal(peer, { sdp: { type: 'answer', sdp: v.answerSdp } });
      for (const cj of v.sentCands) this.signal(peer, { candidate: cj });
      await this.applyEncoder(v);
    } catch (e) {
      console.warn('[guest-send] handshake', e);
      if (!stale()) { this.drop(peer, false); this.side(peer, 'wait'); }
    }
  }
  private async applyEncoder(v: SV) {
    const s = v.tx?.sender;
    if (!s) return;
    try {
      const p = s.getParameters();
      if (!p.encodings?.length) p.encodings = [{}];
      Object.assign(p.encodings[0], encoderParams(this.glue.tier));
      (p as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = ENCODER_DEGRADATION;
      await s.setParameters(p);
    } catch { /* the defaults */ }
  }
  private onChannel(v: SV, ch: RTCDataChannel) {
    if (ch.label !== GS_CHANNEL || v.dc || this.viewers.get(v.peer) !== v) { try { ch.close(); } catch { /* closed */ } return; }
    v.dc = ch;
    const opened = () => { v.open = true; v.since = Date.now(); v.lastHeard = now(); this.sendCfg(v); this.recompute(); this.lastReportAt = 0; this.report(); };
    ch.onopen = opened;
    ch.onmessage = (e) => { try { this.onViewerMsg(v, e.data); } catch (err) { console.warn('[guest-send] viewer message', err); } };
    ch.onclose = () => { if (v.dc === ch && this.viewers.get(v.peer) === v) this.drop(v.peer, false); };
    if (ch.readyState === 'open') opened();
  }
  private onViewerMsg(v: SV, data: unknown) {
    if (typeof data !== 'string') return;
    const m = sanitizeToSender(data);
    if (!m) return;
    v.lastHeard = now();
    if (m.t === 'vis') { v.visible = m.on; this.recompute(); this.report(); }
    else if (m.t === 'stats') { v.obs = m.obs; if (m.fps) v.fps = m.fps; }
    else if (m.t === 'slow') this.glue.onSlow(now());
    else if (m.t === 'bye') this.drop(v.peer, false);
  }
  private send(v: SV, m: GsToViewer) { try { if (v.dc?.readyState === 'open') v.dc.send(encodeMsg(m)); } catch { /* closing */ } }
  private cfgMsg(): GsToViewer {
    const c = this.cfg!, t = this.glue.tier, plan = this.packer!.plan;
    return { t: 'cfg', d: c.delayMs, q: c.q, w: plan.cw, h: plan.fh, fps: t.fps, n: c.name, tier: t.name };
  }
  private sendCfg(v: SV) { if (this.cfg && this.packer) this.send(v, this.cfgMsg()); }
  private sendCfgAll() { for (const v of this.viewers.values()) if (v.open) this.sendCfg(v); }
  private drop(peer: string, bye: boolean) {
    const v = this.viewers.get(peer);
    if (!v) return;
    this.viewers.delete(peer);
    if (bye) this.byeTo(peer);
    try { v.dc?.close(); } catch { /* closed */ }
    try { v.pc.close(); } catch { /* closed */ }
    this.recompute();
  }
  /** `page.run`: at least one connected viewer is visible. A viewer that just became visible wakes the render loop at once. */
  private recompute() {
    const run = gateRun([...this.viewers.values()]);
    if (run !== this.env.page.run) { this.env.page.run = run; if (run) this.env.page.kick(); }
  }

  // ---------------------------------------------------------------- tier, frames, timers
  private applyTier() {
    const t = this.glue.tier;
    this.env.page.fps = t.fps;
    const cv = this.env.canvas.style;
    cv.position = 'fixed'; cv.left = '0'; cv.top = '0'; cv.width = `${t.w}px`; cv.height = `${t.h}px`;
    this.packer?.setTier(t);
    for (const v of this.viewers.values()) void this.applyEncoder(v);
    this.sendCfgAll();
  }
  private frame(renderMs: number) {
    const p = this.packer;
    if (!p || !this.env.page.run) return;
    const t0 = now();
    p.draw(this.env.canvas, this.stamp);
    const t1 = now();
    this.glue.onRender(renderMs, t1 - t0, t1);
  }
  private tick() {
    const t = now();
    const r = this.glue.step(t);
    if (r.changed) this.applyTier();
    const a = this.policy.expire(t, this.connectedKeys());
    if (a) this.resolveKnock(a);
    for (const v of [...this.viewers.values()]) {
      const silent = t - v.lastHeard;
      if ((!v.open && t - v.born > GS_HANDSHAKE_MS) || (v.discAt && t - v.discAt > 5000) || (v.open && silent > GS_SILENT_DROP_MS)) this.drop(v.peer, false);
    }
    for (const [peer, h] of this.held) if (t - h.at > GS_KNOCK_MS + 5000) this.held.delete(peer);
  }
  private async readViewerStats(v: SV, t: number) {
    try {
      const rep = await Promise.race([v.pc.getStats(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('stats')), 800))]);
      const s = readStats(rep as unknown as Parameters<typeof readStats>[0]);
      const r = ratesOf(v.prev, s, t - v.prevAt);
      v.prev = s; v.prevAt = t;
      v.kbps = r.kbps; v.encodeMs = r.encodeMs; v.limit = s.limit; v.encW = s.width; v.encH = s.height; v.impl = s.encoder;
      if (s.codec) v.codec = s.codec;
      if (s.localType) v.route = routeOf(s.localType);
      v.rttMs = s.rttMs;
      if (!v.fps) v.fps = Math.round(s.fps);
    } catch { /* closing */ }
  }

  // ---------------------------------------------------------------- bus: helper messages + the studio's health beacon
  private onBus(m: Record<string, unknown>) {
    if (m.type === 'health') { this.glue.onHealth(m.h, now()); return; }
    if (m.type !== 'gs') return;
    const g = sanitizeBusMsg(m);
    if (!g) return;
    // The bus hands every client's message to every other client, so a {type:'gs'} control message is only obeyed when the helper
    // signed it with this page's own token (server/guestFeed.ts send()). An unsigned or wrongly signed one is dropped.
    void gsBusVerify(this.token, g).then((good) => { if (good) this.control(g); }, () => {});
  }
  private control(g: GsBusMsg) {
    try {
      if (g.k === 'decide') { const a = this.policy.answer(g.kid, g.allow, this.connectedKeys(), now()); if (a) this.resolveKnock(a); }
      else if (g.k === 'cfg') void this.refetch();
      else if (g.k === 'off') this.turnOff();
    } catch (e) { console.warn('[guest-send] bus', e); }
  }
  /** Tell every viewer (data channel + side-band) that this link is gone, then drop them. */
  private notifyOff() {
    for (const v of this.viewers.values()) { this.send(v, { t: 'off' }); this.side(v.peer, 'off'); this.byeTo(v.peer); }
    for (const peer of this.held.keys()) { this.side(peer, 'off'); this.byeTo(peer); }
    for (const peer of [...this.viewers.keys()]) this.drop(peer, false);
    this.held.clear();
    this.policy.clear();
  }
  private turnOff() {
    this.dead = true;
    this.notifyOff();
    this.env.page.run = false;
    const ws = this.ws;
    setTimeout(() => { try { ws?.close(); } catch { /* closed */ } }, 150);
    this.report();
  }

  // ---------------------------------------------------------------- test hooks (window.__gsSend)
  frames() { return this.packer?.draws ?? 0; }
  tier() { return this.glue.tier.name; }
  snapshot(o?: { b64?: boolean }) {
    const s: GsSnapshot | null = this.packer?.snapshot(this.env.canvas) ?? null;
    return s && o?.b64 ? { w: s.w, h: s.h, b64: b64(s.data) } : s;
  }
  stats() {
    const vs = [...this.viewers.values()];
    return {
      state: senderState({ err: this.err, ready: this.ready, packer: !!this.packer, viewers: vs }), err: this.err, gen: this.gen, tier: this.glue.tier.name, fps: this.glue.tier.fps,
      policy: icePolicy(this.ice), ready: this.ready, run: this.env.page.run, renderMs: this.glue.renderMs, packMs: this.packer?.packMs ?? 0, frames: this.frames(),
      lock: [...this.policy.lock], knock: this.policy.knockInfo(), offers: [...this.offers], pack: this.packer?.plan ?? null, dead: this.dead,
      viewers: vs.map((v) => ({ peer: v.peer, open: v.open, visible: v.visible, kbps: v.kbps, fps: v.fps, codec: v.codec, route: v.route, rttMs: v.rttMs, conn: v.pc.connectionState, enc: [v.encW, v.encH], impl: v.impl, limit: v.limit })),
    };
  }
}

/** Start the sender on this page (src/output.ts calls it for ?gsSend=1). */
export function startGuestSend(env: GsEnv): GsSendHandle {
  const s = new GuestSender(env);
  (window as unknown as { __gsSend?: unknown }).__gsSend = { frames: () => s.frames(), stats: () => s.stats(), tier: () => s.tier(), snapshot: (o?: { b64?: boolean }) => s.snapshot(o) };
  return s;
}
