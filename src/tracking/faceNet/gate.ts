// "My face model": the budget gate on the face worker's net. It judges the net's OWN added cost (crop reads + crops + forward, the
// `net.ms` the worker reports) against the frame period of the current tracking rate, not the face model's total time (a graphics-card
// face at ~20 ms would have kept the net off for good, and a fixed line flaps near the threshold). Hysteresis: pause after `pauseAfter`
// slow frames in a row; while paused the net still runs on 1 frame in `probeEvery` so its cost stays measured, and it resumes after
// `resumeAfter` good probes in a row. Pure; the Tracker feeds it.
export interface GateOpts { /** pause when the net takes more than this share of the frame period */ maxShare?: number; /** a good frame/probe takes less than this share */ resumeShare?: number; pauseAfter?: number; resumeAfter?: number; probeEvery?: number }
export class NetGate {
  paused = false;
  private slow = 0; private good = 0; private since = 0;
  private maxShare: number; private resumeShare: number; private pauseAfter: number; private resumeAfter: number; private probeEvery: number;
  constructor(o: GateOpts = {}) {
    this.maxShare = o.maxShare ?? 0.2; this.resumeShare = o.resumeShare ?? 0.12;
    this.pauseAfter = o.pauseAfter ?? 12; this.resumeAfter = o.resumeAfter ?? 6; this.probeEvery = o.probeEvery ?? 15;
  }
  /** Would the next face frame carry the net? (no side effects) */
  peek() { return !this.paused || this.since + 1 >= this.probeEvery; }
  /** The next face frame is being sent: should it carry the net? (counts the probe spacing while paused) */
  take() { if (!this.paused) return true; if (++this.since >= this.probeEvery) { this.since = 0; return true; } return false; }
  /** A face result that ran the net: its cost and the frame period (ms) at the current tracking rate. */
  observe(netMs: number, periodMs: number) {
    const share = netMs / Math.max(1, periodMs);
    if (!this.paused) {
      if (share > this.maxShare) { if (++this.slow >= this.pauseAfter) { this.paused = true; this.slow = 0; this.good = 0; this.since = 0; } } else this.slow = 0;
    } else if (share < this.resumeShare) { if (++this.good >= this.resumeAfter) { this.paused = false; this.good = 0; this.slow = 0; } } else this.good = 0;
  }
  reset() { this.paused = false; this.slow = this.good = this.since = 0; }
}
