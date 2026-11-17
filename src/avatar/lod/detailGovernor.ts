// Avatar detail, Auto under pressure (OBS pages only; one per page; pure logic, tools/lod_unit.ts). OutputPerf asks it
// FIRST at the end of each 2 s window (before its render-scale step, under the same vsync guard):
//   bad   = fps < 90 % of the target AND (late > 8 % OR GPU p90 > 85 % of the frame budget)   (as autoLower.ts),
//           or a window OutputPerf itself counts as overloaded (so the render scale never reacts first)
//   clean = late < 3 % AND GPU p90 < 45 % of the budget (late < 2 % when the browser has no GPU timer)
//   2 bad windows in a row -> the pressure goes up to the FIRST higher pressure (<= 2) that really makes the page's own
//   avatars draw lighter by a real share (`helps`: its allowed error, 0.5 -> 1 -> 2 px, picks coarser kept levels at
//   their cameras that take at least DETAIL_LEVER_MIN_SHARE = 25 % off the avatar triangles the page draws; output.ts
//   pressureHelps) and the window is HANDLED: OutputPerf resets its bad count and skips its step. When no higher
//   pressure would (levels merged by the keep rule, a close-up, pressure already 2, a step too small to matter) nothing
//   changes here and the render scale reacts exactly as before: such a pressure never holds the render scale back.
//   CLEAN_STEP clean windows in a row -> pressure - 1. A pressure level that was left is barred for 180 s (no ping-pong).
import { detailThreshold, type AvatarDetailChoice } from '../../../shared/avatarDetail.ts';

export interface DetailWindow { fps: number; late: number; gpuP90: number; targetFps: number }

const MAX_PRESSURE = 2;
const BAR_MS = 180_000;
/** Clean 2 s windows per step down: 2 -> 0 takes >= 60 s of clean frames (the spec's 30 windows made >= 120 s, over its
 *  own 90 s recovery gate). Still 3x as patient as the render scale's step back up (10 s). */
export const CLEAN_STEP = 15;

export class DetailGovernor {
  pressure = 0;
  reason = '';
  /** When the pressure last changed (performance.now ms). */
  changedAt = -1e9;
  private bad = 0;
  private good = 0;
  private barredUntil = new Map<number, number>();

  /** One OutputPerf window. `helps(p)`: would pressure `p` make an own avatar on this page draw a lighter level than it
   *  does now? (null = no own avatar has levels: never acts, the windows still count.) `canAct` false = another lever
   *  acted less than 4 s ago: the window still counts (bad / clean streaks), but the pressure does not change. Returns
   *  true when this window was handled here (the pressure went up: the render scale must not step on it). */
  onWindow(w: DetailWindow, helps: ((p: number) => boolean) | null, now: number, canAct = true, overloaded = false): boolean {
    // a page that isn't being driven (hidden / throttled) says nothing
    if (!(w.fps > 3)) return false;
    const budget = 1000 / Math.max(10, w.targetFps);
    const timer = Number.isFinite(w.gpuP90);
    const bad = overloaded || (w.fps < w.targetFps * 0.9 && (w.late > 0.08 || (timer && w.gpuP90 > budget * 0.85)));
    const clean = timer ? w.late < 0.03 && w.gpuP90 < budget * 0.45 : w.late < 0.02;
    if (bad) {
      this.good = 0;
      if (++this.bad >= 2 && helps && canAct) {
        // the first higher pressure that draws something lighter (never past a barred one)
        for (let p = this.pressure + 1; p <= MAX_PRESSURE; p++) {
          if (now < (this.barredUntil.get(p) ?? 0)) break;
          if (helps(p)) { this.set(p, `fps ${w.fps.toFixed(0)} < ${w.targetFps}`, now); return true; }
        }
      }
      return false;
    }
    this.bad = 0;
    this.good = clean ? this.good + 1 : 0;
    if (this.good >= CLEAN_STEP && this.pressure > 0 && canAct) {
      this.barredUntil.set(this.pressure, now + BAR_MS);
      this.set(this.pressure - 1, 'headroom again', now);
    }
    return false;
  }

  /** Allowed on-screen error (px) for a choice at the current pressure (only Auto feels the pressure). */
  threshold(choice: AvatarDetailChoice): number { return detailThreshold(choice, choice === 'auto' ? this.pressure : 0); }

  reset() { this.pressure = 0; this.reason = ''; this.bad = 0; this.good = 0; this.barredUntil.clear(); }

  private set(p: number, why: string, now: number) { this.pressure = p; this.reason = why; this.bad = 0; this.good = 0; this.changedAt = now; }

  info() { return { pressure: this.pressure, reason: this.reason }; }
}
