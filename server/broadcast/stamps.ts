// VTube Pro Live, W5: the helper side of the avatar page's telemetry stamps (docs/BROADCAST_PROTOCOL.md section 5).
//
// The avatar page (src/outputStamps.ts) tells the helper, 20+ times a second, which pose each rendered frame drew. This
// module folds those stamps into StampStats (shared/broadcastTypes.ts): stamps per second, pose age p50 / p95, the share
// of frames that reused the previous pose, the longest "same pose" run and how many such runs lasted longer than
// FROZEN_INTERVAL_MS. W2 reads `stats()` once a second for the health machine; W6 shows it.
//
// Two rules the plan sets for the cost:
//   - ingest/stats do no I/O and the windows are fixed-size typed rings (no growth, no per-stamp allocation);
//   - the page only stamps while somebody looks: `stats()` takes a short LEASE ("a health view subscribes"). While the
//     lease is on, `wanted()` is true and `onWanted` listeners (server/bus.ts) tell the output pages to start stamping;
//     when nobody has asked for WANT_LEASE_MS they are told to stop. `peek()` reads without taking the lease.
//
// Clocks: pose age and run lengths use the PAGE clock inside each stamp (renderQpc - poseQpc), never a mix with the
// helper's clock. The helper's clock (`now`, ms) only places stamps in the window and measures silence.
//
// Imports only shared/broadcastTypes.ts (no bus import: server/bus.ts imports this file).
import { FROZEN_INTERVAL_MS, type Stamp, type StampAggregatorApi, type StampStats } from '../../shared/broadcastTypes.ts';

/** Pose age percentiles, dup ratio and the longest run cover the last this many ms. */
export const STATS_WINDOW_MS = 5000;
/** `hz` counts the stamps of the last this many ms. */
export const HZ_WINDOW_MS = 2000;
/** A page with no stamp for this long is not counted in `pages` (the health machine's "Avatar paused" is 3 s). */
export const PAGE_SILENT_MS = 3000;
/** A page with no stamp for this long is forgotten (a silent freeze that long counts as one frozen interval). */
export const PAGE_FORGET_MS = 60_000;
/** After the last `stats()` call, pages keep stamping for this long. */
export const WANT_LEASE_MS = 10_000;
/** Most stamps taken from one message (the page sends 1 to 4). */
export const MAX_STAMPS_PER_MESSAGE = 8;
/** A pose older than this at render time is clamped (a page that sat in a background tab). */
const MAX_AGE_MS = 60_000;
/** Ring capacity in stamps over all pages: 60 per second x 5 s x several pages fits. */
const RING_CAP = 4096;
/** Longest-run buckets: one per second, a few more than the window needs. */
const BUCKETS = 8;
const BUCKET_MS = 1000;

interface PageState {
  lastSeq: number;
  lastDup: number;
  /** The pose the current run is about (page clock). */
  poseQpc: number;
  /** Page clock of the first render that drew this pose, and of the newest render seen. */
  runStartRender: number;
  lastRender: number;
  /** Helper clock of the newest stamp. */
  lastAt: number;
}

export interface StampAggregator extends StampAggregatorApi {
  /** Same numbers as `stats()` without taking the lease (the pages' stamping stays as it was). */
  peek(now?: number): StampStats;
  /** True while a health view has asked for stats lately (see WANT_LEASE_MS). */
  wanted(now?: number): boolean;
  /** Called when `wanted()` flips (from `stats()` or `sweep()`). Returns the unsubscribe. */
  onWanted(fn: (on: boolean) => void): () => void;
  /** Housekeeping, about every 2 s: forget silent pages, let an expired lease end. */
  sweep(now?: number): void;
  /** Forget everything (tests, a new session). */
  reset(): void;
}

export function createStampAggregator(): StampAggregator {
  const pages = new Map<string, PageState>();
  const ringAt = new Float64Array(RING_CAP);
  const ringAge = new Float64Array(RING_CAP);
  const ringDup = new Uint16Array(RING_CAP);
  const ringSeq = new Uint16Array(RING_CAP);
  const scratch = new Float64Array(RING_CAP);
  const bucketId = new Float64Array(BUCKETS).fill(-1);
  const bucketMax = new Float64Array(BUCKETS);
  let head = 0, count = 0;
  let firstAt = -1, lastAt = -1;
  let closedFrozen = 0;
  let leaseUntil = -Infinity;
  let wasWanted = false;
  const listeners = new Set<(on: boolean) => void>();

  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

  function noteRun(now: number, len: number) {
    const id = Math.floor(now / BUCKET_MS), i = ((id % BUCKETS) + BUCKETS) % BUCKETS;
    if (bucketId[i] !== id) { bucketId[i] = id; bucketMax[i] = 0; }
    if (len > bucketMax[i]) bucketMax[i] = len;
  }

  /** How long this page's current "same pose" run has lasted: what its stamps showed + the time since the last one. */
  function ongoing(p: PageState, now: number) { return Math.max(0, p.lastRender - p.runStartRender) + Math.max(0, now - p.lastAt); }

  function fire(on: boolean) { for (const f of listeners) { try { f(on); } catch { /* a listener never breaks the stats */ } } }
  function checkWanted(now: number) {
    const w = now < leaseUntil;
    if (w !== wasWanted) { wasWanted = w; fire(w); }
  }

  function ingestOne(from: string, s: Stamp, now: number) {
    if (!s || !finite(s.seq) || !finite(s.poseQpc) || !finite(s.renderQpc) || !finite(s.dup)) return;
    let p = pages.get(from);
    let seqD = 1, dupD = 0;
    if (!p) {
      p = { lastSeq: s.seq, lastDup: s.dup, poseQpc: s.poseQpc, runStartRender: s.renderQpc, lastRender: s.renderQpc, lastAt: now };
      pages.set(from, p);
    } else {
      seqD = s.seq - p.lastSeq;
      if (seqD <= 0 || seqD > 1000) { seqD = 1; p.lastDup = s.dup; p.poseQpc = s.poseQpc; p.runStartRender = s.renderQpc; }   // a page that restarted its counters: new baseline
      dupD = Math.max(0, Math.min(seqD, s.dup - p.lastDup));
      if (s.poseQpc !== p.poseQpc) {
        // a new pose reached the screen: the run of the old one lasted until now
        const len = s.renderQpc - p.runStartRender;
        if (len > 0) {
          noteRun(now, len);
          if (len > FROZEN_INTERVAL_MS) closedFrozen++;
        }
        p.poseQpc = s.poseQpc;
        p.runStartRender = s.renderQpc;
      }
      p.lastSeq = s.seq; p.lastDup = s.dup; p.lastRender = s.renderQpc; p.lastAt = now;
    }
    const age = Math.max(0, Math.min(MAX_AGE_MS, s.renderQpc - s.poseQpc));
    ringAt[head] = now; ringAge[head] = age; ringDup[head] = dupD; ringSeq[head] = seqD;
    head = (head + 1) % RING_CAP; if (count < RING_CAP) count++;
    if (firstAt < 0) firstAt = now;
    lastAt = now;
    noteRun(now, ongoing(p, now));
  }

  function compute(now: number): StampStats {
    let n = 0, nHz = 0, sumDup = 0, sumSeq = 0;
    for (let k = 0; k < count; k++) {
      const i = (head - 1 - k + RING_CAP) % RING_CAP;
      const at = ringAt[i];
      if (at < now - STATS_WINDOW_MS) continue;
      if (at > now + 1000) continue;   // (a clock that stepped back: not part of this window)
      scratch[n++] = ringAge[i]; sumDup += ringDup[i]; sumSeq += ringSeq[i];
      if (at >= now - HZ_WINDOW_MS) nHz++;
    }
    let p50: number | null = null, p95: number | null = null;
    if (n > 0) {
      const a = scratch.subarray(0, n); a.sort();
      p50 = a[Math.min(n - 1, Math.max(0, Math.ceil(0.5 * n) - 1))];
      p95 = a[Math.min(n - 1, Math.max(0, Math.ceil(0.95 * n) - 1))];
    }
    let frozenMs = 0, frozenOpen = 0, active = 0;
    for (let i = 0; i < BUCKETS; i++) if (bucketId[i] >= Math.floor((now - STATS_WINDOW_MS) / BUCKET_MS) && bucketId[i] <= Math.floor(now / BUCKET_MS) && bucketMax[i] > frozenMs) frozenMs = bucketMax[i];
    for (const p of pages.values()) {
      const on = ongoing(p, now);
      if (on > frozenMs) frozenMs = on;
      if (on > FROZEN_INTERVAL_MS) frozenOpen++;
      if (now - p.lastAt <= PAGE_SILENT_MS) active++;
    }
    const span = firstAt < 0 ? HZ_WINDOW_MS : Math.min(HZ_WINDOW_MS, Math.max(250, now - firstAt));
    return {
      at: now,
      hz: Math.round((nHz / (span / 1000)) * 10) / 10,
      poseAgeP50Ms: p50 === null ? null : Math.round(p50 * 10) / 10,
      poseAgeP95Ms: p95 === null ? null : Math.round(p95 * 10) / 10,
      dupRatio: sumSeq > 0 ? Math.min(1, sumDup / sumSeq) : null,
      frozenMs: Math.round(frozenMs),
      frozenIntervals: closedFrozen + frozenOpen,
      msSinceLastStamp: lastAt < 0 ? null : Math.max(0, Math.round(now - lastAt)),
      pages: active,
    };
  }

  return {
    ingest(from, stamps, now = Date.now()) {
      if (typeof from !== 'string' || !Array.isArray(stamps)) return;
      const n = Math.min(stamps.length, MAX_STAMPS_PER_MESSAGE);
      for (let i = 0; i < n; i++) ingestOne(from.slice(0, 40), stamps[i], now);
    },
    stats(now = Date.now()) { leaseUntil = now + WANT_LEASE_MS; checkWanted(now); return compute(now); },
    peek(now = Date.now()) { return compute(now); },
    drop(from) { pages.delete(from); },
    wanted(now = Date.now()) { return now < leaseUntil; },
    onWanted(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    sweep(now = Date.now()) {
      for (const [id, p] of pages) {
        if (now - p.lastAt > PAGE_FORGET_MS) { if (ongoing(p, now) > FROZEN_INTERVAL_MS) closedFrozen++; pages.delete(id); }
      }
      checkWanted(now);
    },
    reset() {
      pages.clear(); head = 0; count = 0; firstAt = -1; lastAt = -1; closedFrozen = 0; leaseUntil = -Infinity;
      bucketId.fill(-1); bucketMax.fill(0);
      checkWanted(Date.now());
    },
  };
}

/** The helper's one aggregator (server/bus.ts feeds it, server/routes/broadcast.ts reads it). */
export const stampAggregator: StampAggregator = createStampAggregator();
