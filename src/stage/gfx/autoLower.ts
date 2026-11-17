// "Lower quality automatically" (SceneGfxState.autoLower, ON unless the user turned it off). Unlike Auto it never
// climbs above the preset the user picked. It steps DOWN one preset after two OutputPerf windows (~4 s) of:
//   - frames:   under 90 % of the target fps with frames running late (or the GPU over 85 % of the frame), or
//   - CPU:      the page's own main-thread work per frame (p95) over 80 % of the frame budget with frames starting to
//               slip (the High / Ultra post chain is mostly CPU-side draw submission: a slower CPU than the GPU suggests
//               is the common mid-range case, docs/PERFORMANCE.md §6), or
//   - tracking: the studio's face tracking slowed (its inference well over its own baseline, or under 24 results a
//               second) while this page renders above Medium (the tracker shares the GPU and the CPU with it).
// It goes back UP one step after 60 s of clear headroom on all three (GPU p90 under 45 % of the budget — or no lateness
// without a GPU timer —, CPU p95 under 50 %, tracking healthy), never above the chosen preset. A level it had to leave
// is not retried for 3 minutes. Pure logic: Graphics applies the level it returns; `reason` is one plain sentence.
// A DRIVEN page (shown, nothing loading: `driven` true) is never ignored for being slow: under 3 fps it is starved (a
// game hogging the graphics card) and two such windows drop straight to Low; under 30 % of the target fps it is slow
// whether or not its frames are uneven. A window without `driven` (hidden / throttled / loading) under 3 fps still says
// nothing. The wall-clock starvation guard (starve.ts) usually acts first; starve() is its way in.
import type { GfxLevel } from '../../../shared/graphics.ts';

const ORDER: GfxLevel[] = ['performance', 'balanced', 'high', 'ultra'];

export interface LowerWindow {
  gpuP90: number; fps: number; late: number; targetFps: number;
  /** The page's main-thread ms per frame (p95; NaN / missing = unknown). */
  cpuP95?: number;
  /** The studio's face tracking is struggling (null / missing = no data, not tracking). */
  trackingBad?: boolean | null;
  /** The page is being shown and nothing is loading (src/output.ts): a slow window is real (missing = unknown). */
  driven?: boolean;
}

export class AutoLower {
  /** The preset the user chose (the ceiling). */
  chosen: GfxLevel = 'balanced';
  level: GfxLevel = 'balanced';
  reason = '';
  /** What made the last step down: 'fps' | 'cpu' | 'tracking' | 'starved' ('' = none yet). */
  cause: '' | 'fps' | 'cpu' | 'tracking' | 'starved' = '';
  private bad = 0;
  private good = 0;
  private barredUntil = new Map<GfxLevel, number>();
  private lastChange = 0;

  reset(chosen: GfxLevel) { this.chosen = chosen; this.level = chosen; this.reason = ''; this.cause = ''; this.bad = 0; this.good = 0; this.barredUntil.clear(); }

  onWindow(w: LowerWindow, targetFps: number, now = performance.now()): GfxLevel {
    const i = ORDER.indexOf(this.level);
    const budget = 1000 / Math.max(10, targetFps);
    // a page that is shown and not loading, under 3 fps: starved (a game hogging the graphics card), never ignored
    const starved = w.driven === true && !(w.fps > 3);
    // a browser page that isn't being driven (hidden / throttled / loading) says nothing: fps far below anything plausible
    if (!(w.fps > 3) && !starved) return this.level;
    const cpu = Number.isFinite(w.cpuP95) ? (w.cpuP95 as number) : NaN;
    // (the GPU against the frame the page actually gets: an OBS source capped below the target is not "slow"; a driven
    //  page under 30 % of the target is slow even with even frames — an OBS source is never capped that low)
    const slow = starved || (w.driven === true && w.fps < Math.max(3, targetFps * 0.3))
      || (w.fps < targetFps * 0.9 && (w.late > 0.08 || (Number.isFinite(w.gpuP90) && w.gpuP90 > Math.max(budget, 1000 / Math.max(1, w.fps)) * 0.85)));
    // (frames must actually slip: an OBS source capped at 30 fps runs steady with more CPU per frame, and that is fine)
    const cpuHot = Number.isFinite(cpu) && cpu > budget * 0.8 && w.late > 0.05;
    const trackHot = w.trackingBad === true && i >= 2;          // only High / Ultra cost the tracker real GPU time
    if (slow || cpuHot || trackHot) {
      this.good = 0;
      if (++this.bad >= 2 && i > 0 && now - this.lastChange > 3000) {
        if (starved) { this.starve(now); return this.level; }
        this.barredUntil.set(this.level, now + 180000);
        this.cause = trackHot && !slow && !cpuHot ? 'tracking' : cpuHot && !slow ? 'cpu' : 'fps';
        this.set(ORDER[i - 1], this.cause === 'tracking' ? 'your face tracking was slowing down' : this.cause === 'cpu' ? 'your computer’s processor was running out of time for each frame' : `the stream was dropping frames (${w.fps.toFixed(0)} of ${targetFps} a second)`, now);
      }
      return this.level;
    }
    this.bad = 0;
    if (this.level === this.chosen) return this.level;
    const gpuClear = Number.isFinite(w.gpuP90) ? w.gpuP90 < budget * 0.45 && w.late < 0.03 : w.late < 0.02;
    const clear = gpuClear && (!Number.isFinite(cpu) || cpu < budget * 0.5) && w.trackingBad !== true;
    this.good = clear ? this.good + 1 : 0;
    const next = ORDER[i + 1];
    if (this.good >= 30 && now > (this.barredUntil.get(next) ?? 0)) { this.set(next, 'headroom again', now); this.cause = ''; }
    return this.level;
  }

  /** Starved (starve.ts, or two starved windows): straight to Low, every level above barred for 3 minutes, so the way
   *  back up is the usual one step per minute of headroom. */
  starve(now = performance.now()) {
    const i = ORDER.indexOf(this.level);
    if (i <= 0) { this.cause = 'starved'; return; }
    for (let k = 1; k <= ORDER.indexOf(this.chosen); k++) this.barredUntil.set(ORDER[k], now + 180000);
    this.cause = 'starved';
    this.set(ORDER[0], 'OBS was only getting a picture every few seconds (the graphics card is busy with something else, usually a game)', now);
  }

  private set(l: GfxLevel, why: string, now: number) { this.level = l; this.reason = why; this.good = 0; this.bad = 0; this.lastChange = now; }

  info() { return { chosen: this.chosen, level: this.level, lowered: this.level !== this.chosen, reason: this.reason, cause: this.cause }; }
}
