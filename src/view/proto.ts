// What the guest viewer reads from the relay socket, as pure functions (no DOM): the relay's messages, the ICE server list, the
// stats the viewer reports. Tested in tools/guestfeed_view_unit.ts. Spec: docs/GUEST_BROWSER_SOURCE.md section 3.
import { routeOf, sideBandOf, type GsRoute, type GsSideState } from '../../shared/guestFeed.ts';

export interface GsIceServer { urls: string | string[]; username?: string; credential?: string }
const URL_RX = /^(stun|stuns|turn|turns):[^\s]{1,280}$/i;
const str = (v: unknown, n: number): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= n ? v : undefined);

/** The relay's `ready.ice` → at most 6 servers with valid stun:/turn: addresses. Anything else is dropped. */
export function cleanIce(raw: unknown): GsIceServer[] {
  const out: GsIceServer[] = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    if (out.length >= 6) break;
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    const urls = (Array.isArray(o.urls) ? o.urls : [o.urls]).filter((u): u is string => typeof u === 'string' && URL_RX.test(u)).slice(0, 4);
    if (!urls.length) continue;
    const e: GsIceServer = { urls: urls.length === 1 ? urls[0] : urls };
    const un = str(o.username, 400), cr = str(o.credential, 400);
    if (un !== undefined) e.username = un;
    if (cr !== undefined) e.credential = cr;
    out.push(e);
  }
  return out;
}

export type RelayMsg =
  | { k: 'ready'; ice: GsIceServer[]; peer: boolean }
  | { k: 'peer'; here: boolean }
  | { k: 'bye' }
  | { k: 'busy' }
  | { k: 'side'; s: GsSideState }
  | { k: 'answer'; sdp: string }
  | { k: 'cand'; cand: Record<string, unknown> | null };

/** One relay text frame → a message, or null for anything we do not use. The side-band is checked BEFORE a candidate is ever handed to the
 *  peer connection. */
export function parseRelayMsg(raw: unknown): RelayMsg | null {
  if (typeof raw !== 'string' || raw.length > 20_000) return null;
  let m: unknown;
  try { m = JSON.parse(raw); } catch { return null; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  if (o.t === 'ready') return { k: 'ready', ice: cleanIce(o.ice), peer: o.peer === true };
  if (o.t === 'peer') return typeof o.here === 'boolean' ? { k: 'peer', here: o.here } : null;
  if (o.t === 'bye') return { k: 'bye' };
  if (o.t === 'busy') return { k: 'busy' };
  if (o.t !== 'signal' || !o.data || typeof o.data !== 'object') return null;
  const d = o.data as Record<string, unknown>;
  const sdp = d.sdp && typeof d.sdp === 'object' ? d.sdp as Record<string, unknown> : null;
  if (sdp && sdp.type === 'answer' && typeof sdp.sdp === 'string' && sdp.sdp.length > 0) return { k: 'answer', sdp: sdp.sdp };
  if ('candidate' in d) {
    const side = sideBandOf(d.candidate);
    if (side) return { k: 'side', s: side.s };
    const c = d.candidate;
    if (c === null) return { k: 'cand', cand: null };
    if (c && typeof c === 'object' && !Array.isArray(c) && typeof (c as Record<string, unknown>).candidate === 'string' && ((c as Record<string, string>).candidate).length <= 1000) return { k: 'cand', cand: c as Record<string, unknown> };
  }
  return null;
}

/** The viewer's stats from an RTCStatsReport-like object (anything with forEach): what it decodes, drops and which way it is routed.
 *  `route` is read from the SENDER's candidate in the selected pair: relay = the gaming PC's address stays hidden. */
export interface GsStatsSummary { fps: number; w: number; h: number; codec: string; dec: string; lost: number; dropped: number; decoded: number; rttMs: number; route: GsRoute }
export function summarizeStats(report: { forEach(cb: (v: unknown) => void): void } | null | undefined): GsStatsSummary {
  const all = new Map<string, Record<string, unknown>>();
  report?.forEach((v) => { if (v && typeof v === 'object' && typeof (v as Record<string, unknown>).id === 'string') all.set((v as { id: string }).id, v as Record<string, unknown>); });
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  let inb: Record<string, unknown> | undefined, transport: Record<string, unknown> | undefined;
  for (const s of all.values()) {
    if (s.type === 'inbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) inb = s;
    else if (s.type === 'transport') transport = s;
  }
  let pair: Record<string, unknown> | undefined = transport && typeof transport.selectedCandidatePairId === 'string' ? all.get(transport.selectedCandidatePairId) : undefined;
  if (!pair) for (const s of all.values()) if (s.type === 'candidate-pair' && (s.selected === true || (s.nominated === true && s.state === 'succeeded'))) pair = s;
  const remote = pair && typeof pair.remoteCandidateId === 'string' ? all.get(pair.remoteCandidateId) : undefined;
  const codec = inb && typeof inb.codecId === 'string' ? all.get(inb.codecId) : undefined;
  const mime = codec && typeof codec.mimeType === 'string' ? codec.mimeType.replace(/^video\//i, '') : '';
  return {
    fps: Math.round(n(inb?.framesPerSecond)), w: n(inb?.frameWidth), h: n(inb?.frameHeight), codec: mime,
    dec: typeof inb?.decoderImplementation === 'string' ? inb.decoderImplementation : '', lost: n(inb?.packetsLost), dropped: n(inb?.framesDropped), decoded: n(inb?.framesDecoded),
    rttMs: Math.round(n(pair?.currentRoundTripTime) * 1000), route: routeOf(remote?.candidateType),
  };
}

/** The viewer drops more than 30 percent of the frames it gets for 5 seconds: ask the sender for one tier down (at most once per 10 s). */
export class GsSlowDetector {
  private prevAt = -1; private prevDecoded = 0; private prevDropped = 0; private badSince = -1; private lastFire = -1e12;
  constructor(public ratio = 0.3, public forMs = 5000, public cooldownMs = 10_000, public minFrames = 10) {}
  reset() { this.prevAt = -1; this.badSince = -1; }
  /** totals so far (decoded frames, dropped frames) at `now` ms; true = send {t:'slow'} */
  feed(now: number, decoded: number, dropped: number): boolean {
    const had = this.prevAt >= 0, at0 = this.prevAt, dd = decoded - this.prevDecoded, dr = dropped - this.prevDropped;
    this.prevAt = now; this.prevDecoded = decoded; this.prevDropped = dropped;
    if (!had || dd < 0 || dr < 0) { this.badSince = -1; return false; }       // first sample, or a new peer connection (counters restarted)
    const total = dd + dr;
    if (total < this.minFrames) return false;                                // nothing to judge (hidden source, no frames)
    if (dr / total <= this.ratio) { this.badSince = -1; return false; }
    if (this.badSince < 0) this.badSince = at0;
    if (now - this.badSince >= this.forMs && now - this.lastFire >= this.cooldownMs) { this.lastFire = now; this.badSince = now; return true; }
    return false;
  }
}
