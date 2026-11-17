// The guest viewer's picture bookkeeping as pure logic (no GL, no DOM): the hold-last-frame gate and the frame store (lip-sync
// delay queue + the frame on screen). render.ts plugs textures into it. Tested in tools/guestfeed_view_unit.ts.
import { GS_HOLD_LAST_MS, GsDelayQueue, clampDelay } from '../../shared/guestFeed.ts';

/** Frames newer than this count as a live picture; older than that (up to GS_HOLD_LAST_MS) the last picture is just held. */
export const GS_FRESH_MS = 1500;
export type PictureState = 'none' | 'held' | 'fresh';

/**
 * Tracks when the last frame arrived. While the source is hidden (the sender sends nothing then) the clock stands still, so a hidden
 * source never "loses" its picture; coming back starts a new 8 seconds. After GS_HOLD_LAST_MS without frames the picture is gone
 * ('none') and `lost` stays true until the next frame (or `forget`).
 */
export class GsHold {
  private last = -1; private since = 0; private hiddenAt = -1; private had = false;
  lost = false;
  frame(now: number) { this.last = now; this.had = true; this.lost = false; }
  setVisible(on: boolean, now: number) {
    if (on) { if (this.hiddenAt >= 0) { this.hiddenAt = -1; this.since = now; } }
    else if (this.hiddenAt < 0) this.hiddenAt = now;
  }
  /** terminal states (blocked / off): the picture goes at once */
  forget() { this.last = -1; this.had = false; this.lost = false; }
  get hasPicture() { return this.had; }
  state(now: number): PictureState {
    if (!this.had) return 'none';
    const t = this.hiddenAt >= 0 ? this.hiddenAt : now;
    const age = t - Math.max(this.last, this.since);
    if (age < GS_FRESH_MS) return 'fresh';
    if (age < GS_HOLD_LAST_MS) return 'held';
    this.lost = true; this.had = false;
    return 'none';
  }
}

/**
 * The frame on screen plus the frames waiting for their turn. T is a texture (or anything you must free). Every frame handed to `add`
 * ends up shown, queued or in `release`: nothing leaks. `true` from add / tick / configure = the shown frame changed: draw it.
 */
export class GsFrameStore<T> {
  shown: T | null = null;
  delay = 0;
  private q: GsDelayQueue<T>;
  constructor(private release: (t: T) => void, cap = 2) { this.q = new GsDelayQueue<T>(cap); }
  get queued() { return this.q.size; }
  get cap() { return this.q.cap; }
  /** a new delay (ms) and the queue capacity for it. Going to 0 shows the newest queued frame at once. */
  configure(delayMs: number, cap: number): boolean {
    this.delay = clampDelay(delayMs);
    this.q.cap = Math.max(2, cap);
    if (this.delay > 0) return false;
    const all = this.q.clear();
    if (!all.length) return false;
    for (const t of all.slice(0, -1)) this.release(t);
    this.show(all[all.length - 1]);
    return true;
  }
  add(now: number, t: T): boolean {
    if (this.delay <= 0) { this.show(t); return true; }
    for (const d of this.q.push(now, t)) this.release(d);
    return false;
  }
  /** `slack` (ms) is taken off the delay: frames arrive every 33 ms, so "the newest one at least D old" is on average half an interval older than D; the caller passes about that much to centre the lag on D */
  tick(now: number, slack = 0): boolean {
    if (this.delay <= 0 || !this.q.size) return false;
    const r = this.q.pick(now, Math.max(0, this.delay - Math.max(0, slack)));
    for (const f of r.free) this.release(f);
    if (!r.show) return false;
    this.show(r.show);
    return true;
  }
  /** a size change: queued frames are the wrong size now (the shown one stays until a new one replaces it) */
  emptyQueue() { for (const t of this.q.clear()) this.release(t); }
  /** drop everything, the shown frame too */
  reset() { this.emptyQueue(); if (this.shown !== null) { this.release(this.shown); this.shown = null; } }
  private show(t: T) { if (this.shown !== null && this.shown !== t) this.release(this.shown); this.shown = t; }
}
