// "Auto" graphics quality: climbs from Balanced only while the GPU has headroom AND the live face tracking is healthy;
// steps down at once when the studio's face inference slows (the tracker shares the GPU — earlier, Ultra post took
// inference from ~10 ms to ~90 ms) or frames run late. A level that hurt tracking is barred for 5 minutes.
//   inputs: the page's GPU time per frame (timer query, OutputPerf windows) + frame lateness, and the studio's
//   TrackingHealth beacons (bus {type:'health'}, ~1 Hz).
//   ceiling: High (default) or Ultra ("Auto may use Ultra").
import type { GfxLevel, TrackingHealth } from '../../../shared/graphics.ts';
import { STALL } from '../../tracking/stallGuard.ts';   // (pure constants: the tracker's own in-flight limits)

const ORDER: GfxLevel[] = ['performance', 'balanced', 'high', 'ultra'];

/** A tracker stall (stall mode, or the face run stuck in flight) counts as trouble for this long, then stops pinning the
 *  page low (stall mode can last a whole game session). Levels it knocked out are barred for the same time. */
export const STALL_TROUBLE_MS = 30000;

export interface AutoWindow { gpuP90: number; fps: number; late: number; targetFps: number }

export class AutoGovernor {
  level: GfxLevel = 'balanced';
  ceiling: GfxLevel = 'high';
  /** Why the last change happened (UI / debug). */
  reason = 'start';
  private good = 0;
  private bad = 0;
  private barred = new Map<GfxLevel, number>();
  private health: TrackingHealth | null = null;
  private healthAt = 0;
  /** Face inference baseline (ms): a slow-moving minimum seen at the lowest levels. */
  private base = 0;
  private samples: number[] = [];
  private probation = 0;
  private lastChange = 0;
  /** Stall trouble: stall mode began (rising edge) → trouble until then; the face run stuck in flight for 2 beacons in a row. */
  private stallUntil = 0;
  private stuckBeats = 0;
  private wasStall = false;

  onHealth(h: TrackingHealth, now = performance.now()) {
    this.health = h; this.healthAt = now;
    // A total tracker stall freezes inferMs / trackFps at their last good values (they only update when a result
    // arrives), so read the stall itself: stall mode starting, or the frame in flight over the tracker's own limit.
    const stall = h.tracking && h.stall === true;
    if (stall && !this.wasStall) this.stallUntil = now + STALL_TROUBLE_MS;
    this.wasStall = stall;
    const limit = Math.max(STALL.inFlightMinMs, STALL.inFlightX * this.base);
    this.stuckBeats = h.tracking && (h.inflightMs ?? 0) > limit ? this.stuckBeats + 1 : 0;
    if (!h.tracking || !(h.inferMs > 0)) return;
    this.samples.push(h.inferMs);
    if (this.samples.length > 30) this.samples.shift();
    // baseline: learnt while at Balanced or below (what tracking costs without our extras), else only ever lowered
    const sorted = [...this.samples].sort((a, b) => a - b);
    const p25 = sorted[Math.floor(sorted.length * 0.25)];
    if (ORDER.indexOf(this.level) <= 1 || !this.base) this.base = this.base ? this.base * 0.9 + p25 * 0.1 : p25;
    else this.base = Math.min(this.base, p25 * 1.02);
  }

  /** Tracking in trouble right now (null = no data / not tracking). */
  trackingBad(now = performance.now()): boolean | null {
    const h = this.health;
    if (!h || now - this.healthAt > 6000 || !h.tracking) return null;
    return !!this.stallCause(now) || this.slowResults(h);
  }

  /** The old reading: the last face results are slow or too few (frozen when results stop, so it cannot see a stall). */
  private slowResults(h: TrackingHealth): boolean {
    const lim = Math.max(this.base * 1.3, this.base + 4, 14);
    // (relative to the camera once the beacon says its rate — a 30 fps webcam's 20-30 results a second were "bad" at a
    //  flat 24 —, never stricter than the old 24: research/tracking_gpu_rca/RCA.md side fix)
    return h.inferMs > lim || h.trackFps < (h.camFps && h.camFps > 0 ? Math.min(24, 0.7 * h.camFps) : 24);
  }

  /** Why the tracker is stalled right now ('' = not): stall mode (first 30 s) or a face run stuck in flight (>= 2 beacons). */
  private stallCause(now: number): string {
    if (this.stuckBeats >= 2) return `face run stuck (${Math.round(this.health?.inflightMs ?? 0)} ms in flight)`;
    if (now < this.stallUntil) return 'face tracking stalled';
    return '';
  }

  /** One OutputPerf window (~2 s). Returns the level to use. */
  onWindow(w: AutoWindow, now = performance.now()): GfxLevel {
    const budget = 1000 / Math.max(10, w.targetFps);
    const i = ORDER.indexOf(this.level);
    const tb = this.trackingBad(now);
    // (a stall alone is barred 30 s; slow results as well keep the old 5 minutes)
    const stallWhy = tb && this.health && !this.slowResults(this.health) ? this.stallCause(now) : '';
    const gpuHot = Number.isFinite(w.gpuP90) && w.gpuP90 > budget * 0.7;
    const late = w.late > 0.12 && w.fps < w.targetFps * 0.85;
    if (tb || gpuHot || late) {
      this.bad++; this.good = 0;
      // tracking trouble: step down right away and bar this level; GPU / lateness: after two windows
      if (i > 0 && (tb || this.bad >= 2)) {
        this.barred.set(this.level, now + (stallWhy ? STALL_TROUBLE_MS : tb ? 300000 : 120000));
        this.set(ORDER[i - 1], stallWhy ? stallWhy : tb ? `face tracking slowed (${this.health?.inferMs.toFixed(1)} ms)` : gpuHot ? `GPU busy (${w.gpuP90.toFixed(1)} ms/frame)` : 'frames running late', now);
      }
      return this.level;
    }
    this.bad = 0;
    // climb: GPU clearly idle, tracking fine (or not running), probation after a change
    const next = ORDER[i + 1];
    const headroom = !Number.isFinite(w.gpuP90) ? w.late < 0.02 : w.gpuP90 < budget * (next === 'ultra' ? 0.25 : 0.38);
    if (headroom && !w.late) this.good++; else this.good = 0;
    const need = next === 'ultra' ? 10 : 6;          // windows (~12–20 s of clean frames)
    if (next && ORDER.indexOf(next) <= ORDER.indexOf(this.ceiling) && this.good >= need && now > (this.barred.get(next) ?? 0) && now - this.lastChange > 15000) {
      this.set(next, 'GPU headroom + tracking healthy', now);
      this.probation = now + 12000;
    }
    return this.level;
  }

  /** A starved page (starve.ts): continue from the lightest level once the frames are back, the levels above barred for
   *  2 minutes (then the usual climb on headroom). */
  starve(now = performance.now()) {
    for (const l of ORDER.slice(1)) this.barred.set(l, now + 120000);
    this.set('performance', 'OBS was only getting a picture every few seconds', now);
  }

  private set(l: GfxLevel, why: string, now: number) {
    this.level = l; this.reason = why; this.good = 0; this.bad = 0; this.lastChange = now;
  }

  info() {
    return { level: this.level, ceiling: this.ceiling, reason: this.reason, inferBase: +this.base.toFixed(1), infer: this.health?.inferMs ?? null, trackFps: this.health?.trackFps ?? null, barred: [...this.barred.entries()].filter(([, t]) => t > performance.now()).map(([l]) => l) };
  }
}
