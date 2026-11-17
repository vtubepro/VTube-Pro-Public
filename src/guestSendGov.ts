// Guest browser source, sender page: the glue that feeds the pure performance governor (shared/guestFeed.ts GsGovernor)
// with what this page can see: the studio's health beacon ({type:'health'}, face-tracking health), its own render + pack
// time, the encoder's own report (RTCPeerConnection.getStats) and a viewer's `slow` message. The governor decides the tier
// (full > light > low > hold); this file only turns raw readings into its inputs, so it has no DOM and runs under Node
// (tools/guestfeed_send_unit.ts). The page applies the tier (src/guestSend.ts). Spec: docs/GUEST_BROWSER_SOURCE.md, section 9.
import { GS_GOV, GsGovernor, type GsHealth, type GsQuality, type GsTier, type GsWhy } from '../shared/guestFeed.ts';

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The studio's health beacon (shared/graphics.ts TrackingHealth, untrusted bus data) -> the governor's reading, stamped `now`
 *  (this page's performance.now clock: the governor ignores a beacon older than GS_GOV.healthStaleMs). */
export function healthOf(h: unknown, now: number): GsHealth | null {
  if (!h || typeof h !== 'object') return null;
  const o = h as Record<string, unknown>;
  const out: GsHealth = { at: now };
  if (typeof o.stall === 'boolean') out.stall = o.stall;
  if (fin(o.inflightMs)) out.inflightMs = Math.max(0, Math.min(60_000, o.inflightMs));
  if (fin(o.gpuSyncMs)) out.gpuSyncMs = Math.max(-1, Math.min(60_000, o.gpuSyncMs));
  if (typeof o.tracking === 'boolean') out.tracking = o.tracking;
  if (fin(o.starve)) out.starve = Math.max(0, Math.min(1, o.starve));
  return out;
}

/** What one `getStats()` of a sender connection says about the encoder and the selected route. */
export interface GsStatsRead {
  bytes: number; frames: number; encodeSec: number; fps: number; width: number; height: number;
  codec: string; encoder: string; limit: string; rttMs: number | null; localType: string;
}
type StatLike = Record<string, unknown>;
/** Walk a getStats() report (a Map-like of plain stat objects; also fed plain objects in tests). Never throws. */
export function readStats(report: { forEach(cb: (x: StatLike) => void): void; get?(id: string): StatLike | undefined }): GsStatsRead {
  const r: GsStatsRead = { bytes: 0, frames: 0, encodeSec: 0, fps: 0, width: 0, height: 0, codec: '', encoder: '', limit: '', rttMs: null, localType: '' };
  const all: StatLike[] = [];
  try { report.forEach((x) => { if (x && typeof x === 'object') all.push(x); }); } catch { return r; }
  const byId = new Map<string, StatLike>();
  for (const x of all) if (typeof x.id === 'string') byId.set(x.id, x);
  const get = (id: unknown): StatLike | undefined => (typeof id === 'string' ? byId.get(id) ?? report.get?.(id) : undefined);
  let pair: StatLike | undefined;
  for (const x of all) {
    if (x.type === 'outbound-rtp' && x.kind === 'video') {
      if (fin(x.bytesSent)) r.bytes = x.bytesSent;
      if (fin(x.framesEncoded)) r.frames = x.framesEncoded;
      if (fin(x.totalEncodeTime)) r.encodeSec = x.totalEncodeTime;
      if (fin(x.framesPerSecond)) r.fps = x.framesPerSecond;
      if (fin(x.frameWidth)) r.width = x.frameWidth;
      if (fin(x.frameHeight)) r.height = x.frameHeight;
      if (typeof x.encoderImplementation === 'string') r.encoder = x.encoderImplementation.slice(0, 60);
      if (typeof x.qualityLimitationReason === 'string') r.limit = x.qualityLimitationReason;
      const c = get(x.codecId);
      if (c && typeof c.mimeType === 'string') r.codec = c.mimeType.slice(0, 40);
    } else if (x.type === 'transport' && typeof x.selectedCandidatePairId === 'string') pair = get(x.selectedCandidatePairId) ?? pair;
  }
  // (no transport entry: the nominated succeeded pair)
  if (!pair) pair = all.find((x) => x.type === 'candidate-pair' && x.state === 'succeeded' && (x.nominated === true || x.selected === true));
  if (pair) {
    if (fin(pair.currentRoundTripTime)) r.rttMs = Math.round(pair.currentRoundTripTime * 1000);
    const l = get(pair.localCandidateId);
    if (l && typeof l.candidateType === 'string') r.localType = l.candidateType;
  }
  return r;
}

/** The rates between two reads of one connection (`dtMs` apart). */
export function ratesOf(prev: Pick<GsStatsRead, 'bytes' | 'frames' | 'encodeSec'> | null, cur: Pick<GsStatsRead, 'bytes' | 'frames' | 'encodeSec'>, dtMs: number): { kbps: number; encodeMs: number } {
  if (!prev || !(dtMs > 0)) return { kbps: 0, encodeMs: 0 };
  const db = cur.bytes - prev.bytes, df = cur.frames - prev.frames, de = cur.encodeSec - prev.encodeSec;
  return { kbps: db > 0 ? Math.round((db * 8) / dtMs) : 0, encodeMs: df > 0 && de > 0 ? (de / df) * 1000 : 0 };
}

/**
 * The governor plus the readings that feed it. Every method takes `now` (ms, one clock); nothing here reads the time itself.
 *   onHealth   the studio's beacon (about once a second)
 *   onRender   one drawn + packed frame (ms)
 *   onEncoder  the encoder's own load (ms per frame, and whether it says it is CPU limited)
 *   onSlow     a viewer cannot decode fast enough
 *   step       every ~250 ms, also while nothing is drawn (the tier must already be right when the first viewer shows up)
 */
export class GsGovGlue {
  readonly gov: GsGovernor;
  health: GsHealth | null = null;
  /** smoothed render and pack time of drawn frames (ms) */
  renderMs = 0; packMs = 0;
  private lastFrameAt = -1e12;
  private encMs = 0; private encAt = -1e12; private cpuLimited = 0;
  private slowUntil = -1e12;
  constructor(q: GsQuality) { this.gov = new GsGovernor(q); }
  get tier(): GsTier { return this.gov.tier; }
  setQuality(q: GsQuality) { if (this.gov.q !== q) { this.gov.q = q; this.gov.reset(); this.renderMs = this.packMs = 0; } }
  onHealth(h: unknown, now: number) { const r = healthOf(h, now); if (r) this.health = r; }
  onRender(renderMs: number, packMs: number, now: number) {
    const a = 0.1;
    this.renderMs = this.lastFrameAt < 0 || now - this.lastFrameAt > 3000 ? renderMs : this.renderMs * (1 - a) + renderMs * a;
    this.packMs = this.packMs * (1 - a) + packMs * a;
    this.lastFrameAt = now;
  }
  onEncoder(s: { encodeMs: number; limit: string }, now: number) {
    this.encMs = Math.max(0, s.encodeMs); this.encAt = now;
    // (the browser's own "I am CPU limited" must hold for two reports in a row: one is noise)
    this.cpuLimited = s.limit === 'cpu' ? this.cpuLimited + 1 : 0;
  }
  /** A viewer's `slow`: counts as bad evidence a little longer than the governor waits, so exactly one step comes of it. */
  onSlow(now: number) { this.slowUntil = now + GS_GOV.enterMs + 600; }
  /** Our own load as the governor sees it: render + pack of the last drawn frames, or the encoder's time per frame. */
  loadMs(now: number): number {
    const drawing = now - this.lastFrameAt < 2000;
    const mine = drawing ? this.renderMs + this.packMs : 0;
    const enc = now - this.encAt < 4000 ? (this.cpuLimited >= 2 ? Math.max(this.encMs, (1000 / this.tier.fps) * (GS_GOV.renderBudgetX + 0.5)) : this.encMs) : 0;
    return Math.max(mine, enc);
  }
  step(now: number): { tier: GsTier; changed: boolean; why: GsWhy } {
    return this.gov.step({ now, health: this.health, renderMs: this.loadMs(now), viewerSlow: now < this.slowUntil });
  }
}
