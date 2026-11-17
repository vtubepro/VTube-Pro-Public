// VTube Pro Live, W5: the avatar page measures itself and tells the helper over the existing bus (docs/BROADCAST_PROTOCOL.md
// section 5). One Stamp per rendered frame: which pose that frame drew, when its render ended, how long it took, and how
// many frames so far reused the previous pose ("55 fps but the same pose"). The helper (server/broadcast/stamps.ts) turns
// them into pose age p50 / p95, a duplicate-frame ratio and frozen intervals.
//
// Cost rules:
//   - OFF unless somebody looks. The page stamps only when (a) its URL says ?stamps=1 (tests), (b) it is the engine's own
//     page (?engine=1, kind 'engine'), or (c) the helper sent {type:'command', command:'stamps', args:{on:true}}, which it
//     does while a broadcast health view subscribes (server/broadcast/stamps.ts lease). Preview and test pages never stamp.
//   - When off, a frame costs one boolean test. When on, a frame costs a few array writes: no object, array or closure is
//     created per frame (typed ring, pooled Stamp objects that are reused for every batch), so the garbage collector never
//     sees it. The only allocation left is the JSON text the bus makes when it sends a batch (15 to 20 times a second).
//   - Pose time is the page's performance.now() when the pose arrived (Slot.lastFrameAt); pose age = render end - that.
//     It does not include the studio-to-page transport (a few ms on one PC), which src/outputSync.ts keeps to itself.
import type { BusMessage } from '../shared/types.ts';
import type { Stamp } from '../shared/broadcastTypes.ts';
import { outputHelloFields } from '../shared/obsPages.ts';

/** Stamps per message (the contract says 1 to 4). */
export const STAMP_BATCH = 4;
/** A batch waits at most this long for company (so a page at 30 fps still reports 20+ times a second). */
export const STAMP_FLUSH_MS = 50;
/** At most one stamp per this many ms (a 144 Hz page stamps about 66 of its frames a second). */
export const STAMP_MIN_GAP_MS = 15;

/** Where a flushed batch goes. The array and its Stamp objects are REUSED: read or serialise them during the call. */
export type StampSink = (batch: Stamp[]) => void;

/** The part of the output page's slot the tap reads (src/output.ts `Slot`). */
export interface StampSource {
  lastFrameAt: number;
  sync: { stats: { received: number } };
  frame: { mouth?: { open?: number } };
}

/** The part of src/bus.ts `Bus` the page-level wrapper uses. */
export interface StampBus {
  readonly id: string;
  send(m: BusMessage): void;
  on(h: (m: BusMessage) => void): unknown;
  onLink(fn: (up: boolean) => void): unknown;
}

/** The measuring core: no DOM, no bus, injectable clock; unit-tested in tools/stamps_unit.ts. */
export class StampTap {
  on = false;
  private seq = 0;
  private dup = 0;
  private lastCount = -1;
  private lastPushAt = -Infinity;
  private firstPendingAt = 0;
  private n = 0;
  /** seq, poseQpc, renderQpc, renderMs, mouthOpen, dup for up to STAMP_BATCH pending stamps. */
  private readonly ring = new Float64Array(STAMP_BATCH * 6);
  private readonly pool: Stamp[] = [];
  private readonly batch: Stamp[] = [];

  constructor(private sink: StampSink, private clock: () => number = () => performance.now()) {
    for (let i = 0; i < STAMP_BATCH; i++) this.pool.push({ seq: 0, poseQpc: 0, renderQpc: 0, renderMs: 0, mouthOpen: 0, dup: 0 });
  }

  setOn(on: boolean) {
    if (on === this.on) return;
    this.on = on;
    this.n = 0; this.lastCount = -1; this.lastPushAt = -Infinity;
  }

  /** Called after a frame was drawn. `start` = performance.now() when the frame began, `poseAt` = when its pose arrived
   *  (0 = none yet), `poseCount` = poses received so far, `mouth` = mouth opening 0..1. */
  frame(start: number, poseAt: number, poseCount: number, mouth: number) {
    if (!this.on) return;
    if (!(poseAt > 0)) return;   // no pose has ever arrived: nothing to measure
    const end = this.clock();
    this.seq++;
    if (poseCount === this.lastCount) this.dup++;
    this.lastCount = poseCount;
    if (end - this.lastPushAt < STAMP_MIN_GAP_MS) return;
    this.lastPushAt = end;
    const o = this.n * 6, r = this.ring;
    r[o] = this.seq; r[o + 1] = poseAt; r[o + 2] = end; r[o + 3] = end - start; r[o + 4] = mouth; r[o + 5] = this.dup;
    if (this.n === 0) this.firstPendingAt = end;
    this.n++;
    if (this.n >= STAMP_BATCH || end - this.firstPendingAt >= STAMP_FLUSH_MS) this.flush();
  }

  /** Send what is pending (also used when a page goes quiet). Reuses the pooled objects. */
  flush() {
    const n = this.n;
    if (!n) return;
    this.n = 0;
    const r = this.ring, b = this.batch;
    for (let i = 0; i < n; i++) {
      const s = this.pool[i], o = i * 6;
      s.seq = r[o]; s.poseQpc = r[o + 1]; s.renderQpc = r[o + 2]; s.renderMs = r[o + 3]; s.mouthOpen = r[o + 4]; s.dup = r[o + 5];
      b[i] = s;
    }
    b.length = n;
    this.sink(b);
  }
}

/** Page-level wrapper: the ONE hook in src/output.ts calls `outputStamps.frame(bus, q, now, self)` after each drawn frame. */
class OutputStamps {
  private tap: StampTap | null = null;
  private forced = false;
  private eligible = false;

  /** First call: find out what kind of page this is and listen for the helper's on / off. */
  private bind(bus: StampBus, q: URLSearchParams) {
    const kind = outputHelloFields(q, window as unknown as Parameters<typeof outputHelloFields>[1]).page;
    this.eligible = kind === 'obs' || kind === 'browser' || kind === 'engine';
    this.forced = this.eligible && (q.get('stamps') === '1' || kind === 'engine');
    const tap = new StampTap((batch) => bus.send({ type: 'broadcast', k: 'stamps', from: bus.id, s: batch }));
    this.tap = tap;
    tap.setOn(this.forced);
    if (this.eligible) {
      bus.on((m) => { if (m.type === 'command' && m.command === 'stamps') { const a = m.args as { on?: unknown } | undefined; tap.setOn(this.forced || a?.on === true); } });
      bus.onLink((up) => { if (!up) tap.setOn(this.forced); });   // a new helper has to ask again
    }
    // (test hook)
    {
      (window as unknown as { vtpStamps?: unknown }).vtpStamps = {
        tap, forced: this.forced, eligible: this.eligible,
        /** Time `n` frames through a private tap (no bus): microseconds per frame, for the 0.1 ms budget. */
        bench: (n = 20000) => {
          let sent = 0;
          const t = new StampTap(() => { sent++; });
          t.setOn(true);
          const t0 = performance.now();
          for (let i = 0; i < n; i++) { const s = performance.now(); t.frame(s, s - 5, i, 0.3); }
          return { usPerFrame: ((performance.now() - t0) / n) * 1000, sent };
        },
      };
    }
  }

  frame(bus: StampBus, q: URLSearchParams, start: number, src: StampSource) {
    if (this.tap === null) this.bind(bus, q);
    const t = this.tap!;
    if (!t.on) return;
    t.frame(start, src.lastFrameAt, src.sync.stats.received, src.frame.mouth?.open ?? 0);
  }
}
export const outputStamps = new OutputStamps();
